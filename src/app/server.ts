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
  requireEnv("SUPABASE_URL");
  requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  requireEnv("REDIS_URL");
  requireEnv("OPENAI_API_KEY");
  requireEnv("PINECONE_API_KEY");
  requireEnv("PINECONE_INDEX_HOST");

  if (!process.env.PINECONE_DIMENSION?.trim()) {
    process.env.PINECONE_DIMENSION = "1536";
  }
  if (!process.env.PINECONE_QUERY_TIMEOUT_MS?.trim()) {
    process.env.PINECONE_QUERY_TIMEOUT_MS = "5000";
  }

  const portRaw = process.env.PORT?.trim() || "3000";
  const PORT = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(PORT) || PORT <= 0) {
    log.error({ event: "env_invalid", name: "PORT", portRaw }, "invalid PORT");
    process.exit(1);
  }

  process.env.PRIMA_DONNA_SUPABASE_URL = process.env.SUPABASE_URL!.trim();
  process.env.PRIMA_DONNA_SUPABASE_SERVICE_ROLE_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY!.trim();

  await getRedis();

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );

  const embeddingService = new EmbeddingService(log);
  const pineconeRag = new PineconeRAGAdapter(embeddingService, log);
  const rag = new RAGService(log, {
    vectorSearch: (input) => pineconeRag.query(input),
  });

  const fsm = new FSMEngine();
  const llm = new LLMGateway(log);
  const identityManager = new IdentityManager({
    supabase: () => supabase,
    baseLogger: log,
  });
  const orchestrator = new Orchestrator(fsm, llm, rag, log);

  configureWhatsAppHandler({ identityManager, orchestrator });

  const app = express();
  app.use(express.json());
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  app.post("/webhooks/whatsapp", asyncHandler(handleWhatsAppWebhook));

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
