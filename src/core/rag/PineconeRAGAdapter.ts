import pino, { type Logger } from "pino";
import { getPineconeIndex } from "../../infra/pinecone/client";
import type { RAGDocument, RAGQueryInput } from "./RAGService";

const DEFAULT_TOP_K = 5;
const MIN_TOP_K = 1;
const MAX_TOP_K = 10;
const QUERY_PREVIEW_MAX = 100;
const DEFAULT_PINECONE_QUERY_TIMEOUT_MS = 15_000;

function readEmbeddingDimensionFromEnv(): number | undefined {
  const raw = process.env.PINECONE_EMBEDDING_DIMENSION;
  if (typeof raw !== "string" || !raw.trim()) {
    return undefined;
  }
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n <= 0) {
    return undefined;
  }
  return n;
}

function readPineconeQueryTimeoutMs(): number {
  const raw = process.env.PINECONE_QUERY_TIMEOUT_MS;
  if (typeof raw === "string" && raw.trim()) {
    const n = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(n) && n > 0) {
      return n;
    }
  }
  return DEFAULT_PINECONE_QUERY_TIMEOUT_MS;
}

/**
 * El SDK actual no acepta `AbortSignal` en `query`; el controller marca la cancelación lógica
 * y el `Promise.race` evita bloqueos hasta que exista integración nativa.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => {
      controller.abort();
      reject(new Error("pinecone query timeout"));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(id);
        resolve(v);
      },
      (e) => {
        clearTimeout(id);
        reject(e);
      },
    );
  });
}

const defaultLog = pino({
  level: process.env.LOG_LEVEL ?? "info",
  name: "algorithmus-pinecone-rag",
});

type PineconeQueryMatch = {
  id?: string;
  score?: number;
  metadata?: Record<string, unknown>;
};

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export class PineconeRAGAdapter {
  private readonly rootLog: Logger;

  constructor(logger?: Logger) {
    this.rootLog = logger ?? defaultLog;
  }

  async query(input: RAGQueryInput): Promise<RAGDocument[]> {
    const log = this.rootLog.child({
      module: "PineconeRAGAdapter",
      tenant_id: input.tenantId,
    });

    try {
      this.validate(input);
      const tenantId = input.tenantId.trim();
      const queryText = input.query.trim();
      const topK = input.topK ?? DEFAULT_TOP_K;

      log.info(
        {
          step: "pinecone_query_start",
          topK,
          queryLength: queryText.length,
          query_preview: queryText.slice(0, QUERY_PREVIEW_MAX),
        },
        "pinecone query start",
      );

      const vector = await this.embedQuery(queryText);
      this.assertValidQueryVector(vector);

      const index = getPineconeIndex();
      const timeoutMs = readPineconeQueryTimeoutMs();

      const response = await withTimeout(
        index.namespace(tenantId).query({
          vector,
          topK,
          includeMetadata: true,
        }),
        timeoutMs,
      );

      const documents = this.normalizeMatches(response.matches);

      if (documents.length === 0) {
        log.info(
          { step: "pinecone_query_empty", topK },
          "pinecone query empty",
        );
      } else {
        log.info(
          {
            step: "pinecone_query_ok",
            topK,
            count: documents.length,
          },
          "pinecone query ok",
        );
      }

      return documents;
    } catch (err) {
      log.error(
        {
          step: "pinecone_query_error",
          error: err instanceof Error ? err.message : String(err),
        },
        "pinecone query error",
      );
      throw err;
    }
  }

  /**
   * Punto de extensión: sustituir por cliente de embeddings (OpenAI, local, etc.).
   * Hoy no implementado a propósito.
   */
  private async embedQuery(_query: string): Promise<number[]> {
    throw new Error("embedQuery not implemented");
  }

  /**
   * Tras embeddings reales: dimensión debe coincidir con el índice Pinecone.
   * Configurar `PINECONE_EMBEDDING_DIMENSION` (entero > 0).
   */
  private assertValidQueryVector(vector: number[]): void {
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error("invalid embedding vector");
    }
    const expected = readEmbeddingDimensionFromEnv();
    if (expected === undefined) {
      throw new Error(
        "PineconeRAGAdapter: set PINECONE_EMBEDDING_DIMENSION to match the Pinecone index",
      );
    }
    if (vector.length !== expected) {
      throw new Error("invalid embedding dimension");
    }
  }

  private validate(input: RAGQueryInput): void {
    if (typeof input.tenantId !== "string" || !input.tenantId.trim()) {
      throw new Error("PineconeRAGAdapter: tenantId es obligatorio");
    }
    if (typeof input.query !== "string" || !input.query.trim()) {
      throw new Error("PineconeRAGAdapter: query es obligatoria");
    }
    if (input.topK !== undefined) {
      if (
        !Number.isInteger(input.topK) ||
        input.topK < MIN_TOP_K ||
        input.topK > MAX_TOP_K
      ) {
        throw new Error(
          `PineconeRAGAdapter: topK debe ser entero entre ${MIN_TOP_K} y ${MAX_TOP_K}`,
        );
      }
    }
  }

  private normalizeMatches(
    matches: unknown,
  ): RAGDocument[] {
    if (!Array.isArray(matches)) {
      return [];
    }

    const ordered = [...matches] as PineconeQueryMatch[];
    ordered.sort((a, b) => {
      const sa =
        typeof a.score === "number" && Number.isFinite(a.score)
          ? a.score
          : Number.NEGATIVE_INFINITY;
      const sb =
        typeof b.score === "number" && Number.isFinite(b.score)
          ? b.score
          : Number.NEGATIVE_INFINITY;
      return sb - sa;
    });

    const out: RAGDocument[] = [];

    for (const item of ordered) {
      const doc = this.mapMatch(item);
      if (doc) {
        out.push(doc);
      }
    }

    return out;
  }

  private mapMatch(raw: unknown): RAGDocument | null {
    if (!raw || typeof raw !== "object") {
      return null;
    }

    const m = raw as PineconeQueryMatch;
    const id = m.id;
    if (!isNonEmptyString(id)) {
      return null;
    }

    const meta = m.metadata;
    const contentRaw = meta?.content;
    if (!isNonEmptyString(contentRaw)) {
      return null;
    }

    const content = contentRaw.trim();
    const score =
      typeof m.score === "number" && Number.isFinite(m.score) ? m.score : 0;

    return {
      id: id.trim(),
      content,
      score,
      ...(meta ? { metadata: meta } : {}),
    };
  }
}
