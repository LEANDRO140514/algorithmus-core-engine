/**
 * Composition root: wiring, Express, listen. Sin lógica de negocio.
 *
 * Env críticas: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, REDIS_URL,
 * OPENAI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX_HOST.
 * PORT opcional (default 3000).
 */
import express, {
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { createClient } from "@supabase/supabase-js";
import { EmbeddingService } from "../core/embedding/EmbeddingService";
import { FSMEngine } from "../core/fsm/FSMEngine";
import { IdentityManager } from "../core/identity/IdentityManager";
import { LLMGateway } from "../core/llm/LLMGateway";
import { Orchestrator } from "../core/orchestrator/Orchestrator";
import { PineconeRAGAdapter } from "../core/rag/PineconeRAGAdapter";
import { RAGService } from "../core/rag/RAGService";
import {
  baseLogger,
  configureWhatsAppHandler,
  handleWhatsAppWebhook,
} from "../infra/handlers/whatsappHandler";
import { getRedis } from "../infra/redis/client";

const log = baseLogger.child({ module: "server" });

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    log.error({ event: "env_missing", name }, "missing required env");
    process.exit(1);
  }
  return value;
}

function asyncHandler(
  fn: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    void fn(req, res).catch(next);
  };
}

async function main(): Promise<void> {
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const supabaseServiceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  requireEnv("REDIS_URL");
  requireEnv("OPENAI_API_KEY");
  requireEnv("PINECONE_API_KEY");
  requireEnv("PINECONE_INDEX_HOST");

  const portRaw = process.env.PORT?.trim() || "3000";
  const PORT = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(PORT) || PORT <= 0) {
    log.error({ event: "env_invalid", name: "PORT", portRaw }, "invalid PORT");
    process.exit(1);
  }

  // --- Infra ---
  await getRedis();

  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
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
  const llmGateway = new LLMGateway({ logger: log });
  const identityManager = new IdentityManager({
    supabase: () => supabase,
    getRedis,
    logger: log,
  });
  const orchestrator = new Orchestrator({
    logger: log,
    supabase: () => supabase,
    fsmEngine,
    llmGateway,
    ragService: rag,
  });

  // --- Express ---
  const app = express();
  app.use(express.json());

  // --- Handlers (antes de rutas que usan el closure) ---
  configureWhatsAppHandler({ identityManager, orchestrator });

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  app.post("/webhooks/whatsapp", asyncHandler(handleWhatsAppWebhook));

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
