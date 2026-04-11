import { createClient } from "@supabase/supabase-js";
import type { Logger } from "pino";
import { EmbeddingService } from "../core/embedding/EmbeddingService";
import { FSMEngine } from "../core/fsm/FSMEngine";
import { IdentityManager } from "../core/identity/IdentityManager";
import { LLMGateway } from "../core/llm/LLMGateway";
import type { Metrics } from "../core/observability/Metrics";
import { NoopMetrics } from "../core/observability/Metrics";
import { Orchestrator } from "../core/orchestrator/Orchestrator";
import { PineconeRAGAdapter } from "../core/rag/PineconeRAGAdapter";
import { RAGService } from "../core/rag/RAGService";
import { YCloudClient } from "../infra/providers/ycloud/ycloudClient";
import { YCloudInboundIdempotency } from "../infra/providers/ycloud/ycloudIdempotency";
import { YCloudSender } from "../infra/providers/ycloud/ycloudSender";
import { YCloudWebhookVerifier } from "../infra/providers/ycloud/ycloudWebhookVerifier";
import { BullmqQueueDepthExporter } from "../infra/observability/bullmqQueueDepthExporter";
import { PrometheusMetrics } from "../infra/observability/metrics/PrometheusMetrics";
import { getRedis } from "../infra/redis/client";
import {
  createBullMqConnection,
  createWhatsAppInboundJobProducer,
  createWhatsAppInboundQueue,
  type WhatsAppInboundJobProducer,
} from "../infra/queue/queueClient";
import { WHATSAPP_INBOUND_QUEUE } from "../infra/queue/jobTypes";
import { getRedisUrl } from "../config/redisUrl";
import { requireEnv, readEnvOptional, readPositiveInt } from "./envHelpers";

/** Default 15000. Set to `0` to disable queue depth polling. */
function readQueueDepthIntervalMs(defaultMs: number): number {
  const raw = process.env.METRICS_QUEUE_DEPTH_INTERVAL_MS?.trim();
  if (raw === undefined || raw === "") {
    return defaultMs;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    return defaultMs;
  }
  return n;
}

export type AppContext = {
  orchestrator: Orchestrator;
  sender: YCloudSender;
  metrics: Metrics;
  identityManager: IdentityManager;
  webhookVerifier: YCloudWebhookVerifier;
  idempotency: YCloudInboundIdempotency;
  /**
   * Solo el proceso HTTP encola jobs. El worker no lo usa.
   */
  inboundJobProducer: WhatsAppInboundJobProducer | undefined;
  closeQueueResources: () => Promise<void>;
};

/**
 * Ensambla dependencias compartidas (core + infra). No abre puerto HTTP ni worker.
 *
 * `withInboundQueue`: instancia BullMQ Queue + producer (proceso API únicamente).
 */
export async function createAppContext(
  log: Logger,
  options: { withInboundQueue: boolean },
): Promise<AppContext> {
  await getRedis();

  const supabaseUrl = requireEnv(log, "SUPABASE_URL");
  const supabaseServiceRoleKey = requireEnv(log, "SUPABASE_SERVICE_ROLE_KEY");
  const redisUrl = getRedisUrl();
  requireEnv(log, "OPENAI_API_KEY");
  requireEnv(log, "PINECONE_API_KEY");
  requireEnv(log, "PINECONE_INDEX_HOST");

  const ycloudApiKey = requireEnv(log, "YCLOUD_API_KEY");
  const ycloudFrom = requireEnv(log, "YCLOUD_WHATSAPP_FROM");

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

  const metrics: Metrics =
    process.env.METRICS_ENABLED === "false"
      ? new NoopMetrics()
      : new PrometheusMetrics();

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

  const embeddingService = new EmbeddingService(log);
  const pineconeRag = new PineconeRAGAdapter(embeddingService, log);
  const rag = new RAGService({
    logger: log,
    adapter: pineconeRag,
  });

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

  let inboundJobProducer: WhatsAppInboundJobProducer | undefined;
  let queueCloser: () => Promise<void> = async () => {};

  if (options.withInboundQueue) {
    const bullConn = createBullMqConnection(redisUrl);
    const queue = createWhatsAppInboundQueue(bullConn);
    inboundJobProducer = createWhatsAppInboundJobProducer(queue);

    let depthExporter: BullmqQueueDepthExporter | undefined;
    const queueDepthIntervalMs = readQueueDepthIntervalMs(15_000);
    if (queueDepthIntervalMs > 0 && metrics instanceof PrometheusMetrics) {
      depthExporter = new BullmqQueueDepthExporter({
        queue,
        metrics,
        log,
        queueLabel: WHATSAPP_INBOUND_QUEUE,
        intervalMs: queueDepthIntervalMs,
      });
      depthExporter.start();
    }

    queueCloser = async () => {
      await depthExporter?.stop();
      await queue.close();
      await bullConn.quit();
    };
  }

  return {
    orchestrator,
    sender: ycloudSender,
    metrics,
    identityManager,
    webhookVerifier: ycloudVerifier,
    idempotency: ycloudIdempotency,
    inboundJobProducer,
    closeQueueResources: queueCloser,
  };
}
