import pino, { type Logger } from "pino";

export type RAGQueryInput = {
  tenantId: string;
  query: string;
  topK?: number;
};

export type RAGDocument = {
  id: string;
  content: string;
  score: number;
  metadata?: Record<string, unknown>;
};

export type RAGQueryResult = {
  documents: RAGDocument[];
  usedTopK: number;
};

const DEFAULT_TOP_K = 5;
const MIN_TOP_K = 1;
const MAX_TOP_K = 10;
const MAX_QUERY_LENGTH = 1000;

const defaultLog = pino({
  level: process.env.LOG_LEVEL ?? "info",
  name: "algorithmus-rag",
});

export class RAGService {
  private readonly rootLog: Logger;

  constructor(logger?: Logger) {
    this.rootLog = logger ?? defaultLog;
  }

  async query(input: RAGQueryInput): Promise<RAGQueryResult> {
    const log = this.rootLog.child({
      module: "RAGService",
      tenant_id: input.tenantId,
    });

    try {
      this.validate(input);
      const usedTopK = input.topK ?? DEFAULT_TOP_K;
      const normalizedQuery = this.normalizeQuery(input.query);

      if (normalizedQuery.length > MAX_QUERY_LENGTH) {
        throw new Error("query too long");
      }

      log.info(
        {
          step: "rag_query_start",
          usedTopK,
          queryLength: normalizedQuery.length,
          query_preview: normalizedQuery.slice(0, 100),
        },
        "rag query start",
      );

      // TODO: embed query before search (vector del texto normalizado para el proveedor).

      const documents = await this.searchVectorStore(
        input.tenantId.trim(),
        normalizedQuery,
        usedTopK,
      );

      if (documents.length === 0) {
        log.info(
          { step: "rag_query_empty", usedTopK },
          "rag query empty",
        );
      } else {
        log.info(
          {
            step: "rag_query_ok",
            usedTopK,
            count: documents.length,
          },
          "rag query ok",
        );
      }

      return { documents, usedTopK };
    } catch (err) {
      log.error(
        {
          step: "rag_query_error",
          error: err instanceof Error ? err.message : err,
        },
        "rag query error",
      );
      throw err;
    }
  }

  /** Trim, colapsa espacios internos y minúsculas (útil antes de embeddings). */
  private normalizeQuery(raw: string): string {
    return raw.trim().replace(/\s+/g, " ").toLowerCase();
  }

  private validate(input: RAGQueryInput): void {
    if (typeof input.tenantId !== "string" || !input.tenantId.trim()) {
      throw new Error("RAGService: tenantId es obligatorio y no puede estar vacío");
    }
    if (typeof input.query !== "string" || !input.query.trim()) {
      throw new Error("RAGService: query es obligatoria y no puede estar vacía");
    }
    if (input.topK !== undefined) {
      if (
        !Number.isInteger(input.topK) ||
        input.topK < MIN_TOP_K ||
        input.topK > MAX_TOP_K
      ) {
        throw new Error(
          `RAGService: topK debe ser un entero entre ${MIN_TOP_K} y ${MAX_TOP_K}`,
        );
      }
    }
  }

  /**
   * Retrieval desacoplado del proveedor vectorial (Pinecone, pgvector, etc.).
   * Stub: devuelve lista vacía hasta integrar el backend real.
   */
  private async searchVectorStore(
    _tenantId: string,
    _query: string,
    _topK: number,
  ): Promise<RAGDocument[]> {
    return [];
  }
}
