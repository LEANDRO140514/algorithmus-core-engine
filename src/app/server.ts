/**
 * Composition root: wiring, Express, listen. Sin lógica de negocio.
 *
 * Env críticas: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, REDIS_URL,
 * OPENAI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX_HOST,
 * YCLOUD_API_KEY, YCLOUD_WHATSAPP_FROM.
 * Opcionales: YCLOUD_BASE_URL (default https://api.ycloud.com/v2), YCLOUD_REQUEST_TIMEOUT_MS,
 * YCLOUD_WEBHOOK_SECRET, YCLOUD_WEBHOOK_REJECT_UNVERIFIED_IN_PRODUCTION,
 * YCLOUD_INBOUND_IDEMPOTENCY_TTL_SEC.
 * Opcional: SENTRY_DSN, SENTRY_ENV, SENTRY_BASE_RATE, SENTRY_WEBHOOK_RATE.
 * Opcional: METRICS_ENABLED=true (Prometheus en GET /metrics).
 * PORT opcional (default 3000).
 */
import express, {
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { createClient } from "@supabase/supabase-js";
import {
  initSentry,
  setupExpressErrorHandler,
} from "../infra/observability/sentry";
import { EmbeddingService } from "../core/embedding/EmbeddingService";
import { FSMEngine } from "../core/fsm/FSMEngine";
import { IdentityManager } from "../core/identity/IdentityManager";
import { LLMGateway } from "../core/llm/LLMGateway";
import type { Metrics } from "../core/observability/Metrics";
import { NoopMetrics } from "../core/observability/Metrics";
import { Orchestrator } from "../core/orchestrator/Orchestrator";
import { PineconeRAGAdapter } from "../core/rag/PineconeRAGAdapter";
import { RAGService } from "../core/rag/RAGService";
import {
  baseLogger,
  configureWhatsAppHandler,
  handleWhatsAppWebhook,
} from "../infra/handlers/whatsappHandler";
import { YCloudClient } from "../infra/providers/ycloud/ycloudClient";
import { YCloudInboundIdempotency } from "../infra/providers/ycloud/ycloudIdempotency";
import { YCloudSender } from "../infra/providers/ycloud/ycloudSender";
import { YCloudWebhookVerifier } from "../infra/providers/ycloud/ycloudWebhookVerifier";
import { PrometheusMetrics } from "../infra/observability/metrics/PrometheusMetrics";
import { getRedis } from "../infra/redis/client";
import { registerMetricsRoute } from "./metrics/registerMetricsRoute";
import { registerHttpRoutes } from "./routes";

const log = baseLogger.child({ module: "server" });

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    log.error({ event: "env_missing", name }, "missing required env");
    process.exit(1);
  }
  return value;
}

function readEnvOptional(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  return raw && raw.length > 0 ? raw : fallback;
}

function readPositiveInt(name: string, defaultValue: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return defaultValue;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : defaultValue;
}

function asyncHandler(
  fn: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    void fn(req, res).catch(next);
  };
}

async function main(): Promise<void> {
  initSentry();

  const supabaseUrl = requireEnv("SUPABASE_URL");
  const supabaseServiceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  requireEnv("REDIS_URL");
  requireEnv("OPENAI_API_KEY");
  requireEnv("PINECONE_API_KEY");
  requireEnv("PINECONE_INDEX_HOST");

  const ycloudApiKey = requireEnv("YCLOUD_API_KEY");
  const ycloudFrom = requireEnv("YCLOUD_WHATSAPP_FROM");

  const ycloudBaseUrl = readEnvOptional(
    "YCLOUD_BASE_URL",
    "https://api.ycloud.com/v2",
  );
  const ycloudTimeoutMs = readPositiveInt("YCLOUD_REQUEST_TIMEOUT_MS", 5000);
  const idempotencyTtlSec = readPositiveInt(
    "YCLOUD_INBOUND_IDEMPOTENCY_TTL_SEC",
    300,
  );

  const ycloudWebhookSecret = process.env.YCLOUD_WEBHOOK_SECRET?.trim() || "";
  const rejectUnverified =
    process.env.YCLOUD_WEBHOOK_REJECT_UNVERIFIED_IN_PRODUCTION?.trim() ===
    "true";

  const portRaw = process.env.PORT?.trim() || "3000";
  const PORT = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(PORT) || PORT <= 0) {
    log.error({ event: "env_invalid", name: "PORT", portRaw }, "invalid PORT");
    process.exit(1);
  }

  const metrics: Metrics =
    process.env.METRICS_ENABLED === "true"
      ? new PrometheusMetrics()
      : new NoopMetrics();

  // --- Infra ---
  await getRedis();

  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const ycloudClient = new YCloudClient({
    logger: log,
    apiKey: ycloudApiKey,
    baseUrl: ycloudBaseUrl,
    timeoutMs: ycloudTimeoutMs,
  });

  const ycloudSender = new YCloudSender({
    client: ycloudClient,
    logger: log,
    defaultFrom: ycloudFrom,
  });

  const ycloudVerifier = new YCloudWebhookVerifier({
    logger: log,
    webhookSecret: ycloudWebhookSecret || undefined,
    rejectUnverifiedInProduction: rejectUnverified,
  });

  const ycloudIdempotency = new YCloudInboundIdempotency({
    getRedis,
    logger: log,
    ttlSec: idempotencyTtlSec,
  });

  // --- AI ---
  const embeddingService = new EmbeddingService(log);
  const pineconeRag = new PineconeRAGAdapter(embeddingService, log);
  const rag = new RAGService({
    logger: log,
    adapter: pineconeRag,
  });

  // --- Core ---
  const fsmEngine = new FSMEngine();
  const llmGateway = new LLMGateway({ logger: log, metrics });
  const identityManager = new IdentityManager({
    supabase: () => supabase,
    getRedis,
    logger: log,
  });
  const orchestrator = new Orchestrator({
    logger: log,
    metrics,
    supabase: () => supabase,
    fsmEngine,
    llmGateway,
    ragService: rag,
  });

  // --- Handlers ---
  configureWhatsAppHandler({
    identityManager,
    orchestrator,
    webhookVerifier: ycloudVerifier,
    idempotency: ycloudIdempotency,
    sender: ycloudSender,
  });

  // --- Express ---
  const app = express();
  app.use(express.json());

  registerHttpRoutes(app, {
    health: (_req, res) => {
      res.json({ ok: true });
    },
    whatsappWebhook: asyncHandler((req, res) =>
      handleWhatsAppWebhook(req, res, metrics),
    ),
  });

  if (metrics instanceof PrometheusMetrics) {
    registerMetricsRoute(app, metrics);
  }

  setupExpressErrorHandler(app);

  // --- Listen ---
  app.listen(PORT, () => {
    log.info({ event: "server_start", port: PORT }, "server start");
  });
}

void main().catch((err: unknown) => {
  log.error(
    {
      event: "server_fatal",
      error: err instanceof Error ? err.message : String(err),
    },
    "server bootstrap failed",
  );
  process.exit(1);
});
