import pino, { type Logger } from "pino";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Metrics } from "../observability/Metrics";
import { NoopMetrics } from "../observability/Metrics";
import type { ExtractedData, FSMContext, FSMResult } from "../fsm/FSMEngine";
import { FSMEngine } from "../fsm/FSMEngine";
import type { LLMInput, LLMResponse } from "../llm/LLMGateway";
import { LLMGateway } from "../llm/LLMGateway";
import type { RAGQueryResult } from "../rag/RAGService";
import { RAGService } from "../rag/RAGService";
import { createSupabaseServerClient } from "../supabase_client";

const RAG_CONTEXT_MAX_CHARS = 2000;
const RAG_DOCUMENT_MAX_CHARS = 500;

/** Default topK RAG; override opcional `ORCHESTRATOR_RAG_TOP_K` (1–50). */
const DEFAULT_RAG_TOP_K = 5;
const envRagTopK = process.env.ORCHESTRATOR_RAG_TOP_K?.trim();
const parsedTopK = envRagTopK
  ? Number.parseInt(envRagTopK, 10)
  : Number.NaN;
const RAG_TOP_K =
  Number.isFinite(parsedTopK) &&
  parsedTopK > 0 &&
  parsedTopK <= 50
    ? parsedTopK
    : DEFAULT_RAG_TOP_K;

const defaultLog = pino({
  level: process.env.LOG_LEVEL ?? "info",
  name: "algorithmus-orchestrator",
});

/**
 * Resultado de persistencia FSM en DB.
 * - `outcome: "skipped_unchanged"`: no hubo `UPDATE` (estado siguiente igual al actual).
 * - `outcome: "written"`: fila `leads` actualizada.
 */
export type FsmPersistResult =
  | { ok: true; outcome: "skipped_unchanged" | "written" }
  | { ok: false; error: string };

/**
 * Diagnóstico RAG acotado (sin strings libres salvo `detail` en error de retrieval).
 */
export type OrchestratorRagDiagnostic =
  | { readonly type: "no_documents" }
  | { readonly type: "retrieval_failed"; readonly detail: string };

/**
 * Shape cerrado de observabilidad interna (no exponer al usuario).
 */
export type OrchestratorInternalDiagnostics = Readonly<{
  persistError?: string;
  llmFailureReason?: string;
  ragFailure?: OrchestratorRagDiagnostic;
}>;

export type OrchestratorProcessResult = {
  /** Primera evaluación FSM (acción a ejecutar). */
  initial: FSMResult;
  /** Tras inyectar datos del LLM, segunda evaluación; igual que `initial` si no hubo llamada LLM. */
  final: FSMResult;
  llmResponse?: LLMResponse;
  /** Texto listo para enviar al usuario (siempre definido). */
  messageToSend: string;
  /**
   * `true`: persistencia OK **o** no fue necesaria escribir (estado sin cambio).
   * `false`: falló el `UPDATE` en DB.
   */
  fsmPersisted?: boolean;
  /**
   * Presente cuando `fsmPersisted === true`: `unchanged` = sin `UPDATE` (mismo estado);
   * `written` = fila actualizada. Ausente si falló la persistencia (`fsmPersisted === false`).
   */
  fsmPersistenceOutcome?: "unchanged" | "written";
  /** Observabilidad; no exponer al usuario final. */
  internalDiagnostics?: OrchestratorInternalDiagnostics;
};

export type OrchestratorDeps = {
  logger?: Logger;
  metrics?: Metrics;
  supabase: () => SupabaseClient;
  fsmEngine: FSMEngine;
  llmGateway: LLMGateway;
  ragService: RAGService;
};

type LegacyOrchestratorObjectDeps = {
  fsm: FSMEngine;
  llm: LLMGateway;
  rag: RAGService;
  logger?: Logger;
};

function isCanonicalOrchestratorDeps(x: unknown): x is OrchestratorDeps {
  if (x === null || typeof x !== "object") {
    return false;
  }
  const o = x as Record<string, unknown>;
  return (
    "fsmEngine" in o &&
    "llmGateway" in o &&
    "ragService" in o &&
    "supabase" in o &&
    typeof o.supabase === "function" &&
    o.fsmEngine != null &&
    o.llmGateway != null &&
    o.ragService != null
  );
}

function internalDiagnosticsNonEmpty(
  d: OrchestratorInternalDiagnostics,
): boolean {
  if (d.persistError !== undefined && d.persistError !== "") {
    return true;
  }
  if (d.llmFailureReason !== undefined && d.llmFailureReason !== "") {
    return true;
  }
  if (d.ragFailure !== undefined) {
    return true;
  }
  return false;
}

function isLegacyOrchestratorObjectDeps(
  x: unknown,
): x is LegacyOrchestratorObjectDeps {
  if (x === null || typeof x !== "object") {
    return false;
  }
  const o = x as Record<string, unknown>;
  return (
    "fsm" in o &&
    "llm" in o &&
    "rag" in o &&
    !("fsmEngine" in o) &&
    o.fsm != null &&
    o.llm != null &&
    o.rag != null
  );
}

/**
 * Orquesta FSM + LLM: la FSM define la acción; este módulo solo invoca al gateway y re-evalúa.
 */
export class Orchestrator {
  private readonly fsm: FSMEngine;
  private readonly llm: LLMGateway;
  private readonly rag: RAGService;
  private readonly log: Logger;
  private readonly supabase: () => SupabaseClient;
  private readonly metrics: Metrics;

  constructor(deps: OrchestratorDeps);
  constructor(
    fsm: FSMEngine,
    llm: LLMGateway,
    rag: RAGService,
    logger?: Logger,
  );
  constructor(
    arg1: FSMEngine | OrchestratorDeps | LegacyOrchestratorObjectDeps,
    arg2?: LLMGateway,
    arg3?: RAGService,
    arg4?: Logger,
  ) {
    if (isCanonicalOrchestratorDeps(arg1)) {
      this.fsm = arg1.fsmEngine;
      this.llm = arg1.llmGateway;
      this.rag = arg1.ragService;
      this.log = arg1.logger ?? defaultLog;
      this.supabase = arg1.supabase;
      this.metrics = arg1.metrics ?? new NoopMetrics();
    } else if (isLegacyOrchestratorObjectDeps(arg1)) {
      this.fsm = arg1.fsm;
      this.llm = arg1.llm;
      this.rag = arg1.rag;
      this.log = arg1.logger ?? defaultLog;
      this.supabase = createSupabaseServerClient;
      this.metrics = new NoopMetrics();
      this.log.warn(
        {
          event: "deprecated_constructor_usage",
          service: "Orchestrator",
          mode: "legacy",
          variant: "object_fsm_llm_rag",
        },
        "usar OrchestratorDeps con supabase, fsmEngine, llmGateway, ragService",
      );
    } else {
      this.fsm = arg1 as FSMEngine;
      this.llm = arg2 as LLMGateway;
      this.rag = arg3 as RAGService;
      this.log = arg4 ?? defaultLog;
      this.supabase = createSupabaseServerClient;
      this.metrics = new NoopMetrics();
      this.log.warn(
        {
          event: "deprecated_constructor_usage",
          service: "Orchestrator",
          mode: "legacy",
          variant: "positional",
        },
        "usar OrchestratorDeps con supabase, fsmEngine, llmGateway, ragService",
      );
    }
  }

  async process(context: FSMContext): Promise<OrchestratorProcessResult> {
    const log = this.log.child({
      module: "Orchestrator",
      trace_id: context.traceId,
      tenant_id: context.tenantId,
      lead_id: context.leadId,
    });

    const initial = this.fsm.evaluate(context);

    log.info(
      {
        step: "fsm_initial",
        currentState: context.currentState,
        action: initial.action,
      },
      "fsm initial",
    );

    switch (initial.action) {
      case "classify_intent": {
        const gen = await this.invokeLlm("classify_intent", context, log);
        if (!gen.ok) {
          const final = initial;
          return this.finalizeWithPersist(context, final, log, {
            initial,
            final,
            messageToSend: "Hubo un problema, intenta nuevamente.",
            internalDiagnostics: {
              llmFailureReason: gen.errorDetail,
            },
          });
        }
        const { llmResponse } = gen;
        const extractedData = this.mergeClassify(context, llmResponse);
        const final = this.fsm.evaluate({
          ...context,
          currentState: initial.nextState,
          extractedData,
        });
        log.info(
          { step: "fsm_final", nextState: final.nextState },
          "fsm final",
        );
        const messageToSend =
          llmResponse.text ?? "Procesando tu solicitud...";
        return this.finalizeWithPersist(context, final, log, {
          initial,
          final,
          llmResponse,
          messageToSend,
        });
      }

      case "extract_slots": {
        const gen = await this.invokeLlm("extract_slots", context, log);
        if (!gen.ok) {
          const final = initial;
          return this.finalizeWithPersist(context, final, log, {
            initial,
            final,
            messageToSend: "Hubo un problema, intenta nuevamente.",
            internalDiagnostics: {
              llmFailureReason: gen.errorDetail,
            },
          });
        }
        const { llmResponse } = gen;
        const extractedData = this.mergeExtractSlots(context, llmResponse);
        const final = this.fsm.evaluate({
          ...context,
          currentState: initial.nextState,
          extractedData,
        });
        log.info(
          { step: "fsm_final", nextState: final.nextState },
          "fsm final",
        );
        const messageToSend =
          llmResponse.text ?? "Procesando tu solicitud...";
        return this.finalizeWithPersist(context, final, log, {
          initial,
          final,
          llmResponse,
          messageToSend,
        });
      }

      case "query_rag": {
        let ragResult: RAGQueryResult;
        let ragQueryErrorDetail: string | undefined;
        try {
          ragResult = await this.rag.query({
            tenantId: context.tenantId,
            query: context.message,
            topK: RAG_TOP_K,
          });
        } catch (ragErr) {
          const detail =
            ragErr instanceof Error ? ragErr.message : String(ragErr);
          ragQueryErrorDetail = detail;
          log.error(
            {
              step: "rag_error",
              error: detail,
              rag_top_k: RAG_TOP_K,
            },
            "rag retrieval error",
          );
          ragResult = { documents: [], usedTopK: RAG_TOP_K };
        }

        if (ragResult.documents.length === 0) {
          log.warn({ step: "rag_no_docs" }, "rag sin documentos");
          log.info(
            {
              step: "rag_context_built",
              docCount: 0,
              contextLength: 0,
            },
            "rag context built",
          );
          const final = initial;
          return this.finalizeWithPersist(context, final, log, {
            initial,
            final,
            messageToSend:
              "No encontré información relevante, ¿puedes dar más detalles?",
            internalDiagnostics: {
              ragFailure: ragQueryErrorDetail
                ? { type: "retrieval_failed", detail: ragQueryErrorDetail }
                : { type: "no_documents" },
            },
          });
        }

        const docsOrdered = [...ragResult.documents].sort(
          (a, b) => b.score - a.score,
        );

        const contextText = docsOrdered
          .map((doc, i) => {
            const body = doc.content
              .replace(/```[\s\S]*?```/g, "")
              .trim()
              .slice(0, RAG_DOCUMENT_MAX_CHARS);
            return `Documento ${i + 1}:\n${body}`;
          })
          .join("\n\n");
        const safeContextText = contextText.slice(0, RAG_CONTEXT_MAX_CHARS);

        log.info(
          {
            step: "rag_context_built",
            docCount: ragResult.documents.length,
            contextLength: safeContextText.length,
          },
          "rag context built",
        );

        const ragPrompt = `
Responde únicamente usando el contexto proporcionado debajo.
Si la información no es suficiente para responder con certeza, responde exactamente: "No tengo suficiente información para responder con certeza."
No inventes información ni uses conocimiento que no aparezca en el contexto.

Contexto:
${safeContextText}

Pregunta del usuario:
${context.message}
`.trim();

        const gen = await this.invokeLlm("rag_answer", context, log, {
          input: ragPrompt,
        });
        if (!gen.ok) {
          const final = initial;
          return this.finalizeWithPersist(context, final, log, {
            initial,
            final,
            messageToSend: "Hubo un problema, intenta nuevamente.",
            internalDiagnostics: {
              llmFailureReason: gen.errorDetail,
            },
          });
        }
        const { llmResponse } = gen;
        const newData: ExtractedData = {
          ragAttempts: (context.extractedData?.ragAttempts ?? 0) + 1,
          ragConfidence: llmResponse?.confidence,
        };
        const extractedData = {
          ...context.extractedData,
          ...newData,
        };
        const final = this.fsm.evaluate({
          ...context,
          currentState: initial.nextState,
          extractedData,
        });
        log.info(
          { step: "fsm_final", nextState: final.nextState },
          "fsm final",
        );
        const messageToSend =
          llmResponse.text ?? "Procesando tu solicitud...";
        return this.finalizeWithPersist(context, final, log, {
          initial,
          final,
          llmResponse,
          messageToSend,
        });
      }

      case "reply": {
        const gen = await this.invokeLlm("generate_reply", context, log);
        if (!gen.ok) {
          const final = initial;
          return this.finalizeWithPersist(context, final, log, {
            initial,
            final,
            messageToSend: "Hubo un problema, intenta nuevamente.",
            internalDiagnostics: {
              llmFailureReason: gen.errorDetail,
            },
          });
        }
        const { llmResponse } = gen;
        const extractedData = {
          ...context.extractedData,
        };
        const final = this.fsm.evaluate({
          ...context,
          currentState: initial.nextState,
          extractedData,
        });
        log.info(
          { step: "fsm_final", nextState: final.nextState },
          "fsm final",
        );
        const messageToSend =
          llmResponse.text ?? "Procesando tu solicitud...";
        return this.finalizeWithPersist(context, final, log, {
          initial,
          final,
          llmResponse,
          messageToSend,
        });
      }

      case "book_appointment":
      case "handover_human":
      default: {
        const final = initial;
        log.info(
          { step: "fsm_final", nextState: final.nextState },
          "fsm final",
        );
        return this.finalizeWithPersist(context, final, log, {
          initial,
          final,
          messageToSend: "Procesando tu solicitud...",
        });
      }
    }
  }

  private async finalizeWithPersist(
    context: FSMContext,
    final: FSMResult,
    log: Logger,
    partial: {
      initial: FSMResult;
      final: FSMResult;
      messageToSend: string;
      llmResponse?: LLMResponse;
      internalDiagnostics?: OrchestratorInternalDiagnostics;
    },
  ): Promise<OrchestratorProcessResult> {
    this.metrics.incrementCounter("fsm_transitions_total", 1, {
      from_state: context.currentState,
      to_state: final.nextState,
    });

    const persist = await this.persistFsmState(context, final, log);

    if (!persist.ok) {
      this.metrics.incrementCounter("fsm_persistence_failures_total");
    } else if (persist.outcome === "written") {
      this.metrics.incrementCounter("fsm_persistence_writes_total");
    } else {
      this.metrics.incrementCounter("fsm_persistence_unchanged_total");
    }

    const merged: OrchestratorInternalDiagnostics = {
      ...partial.internalDiagnostics,
      ...(persist.ok ? {} : { persistError: persist.error }),
    };

    const hasDiag = internalDiagnosticsNonEmpty(merged);

    const fsmPersistenceOutcome: OrchestratorProcessResult["fsmPersistenceOutcome"] =
      persist.ok
        ? persist.outcome === "skipped_unchanged"
          ? "unchanged"
          : "written"
        : undefined;

    return {
      initial: partial.initial,
      final: partial.final,
      messageToSend: partial.messageToSend,
      ...(partial.llmResponse !== undefined
        ? { llmResponse: partial.llmResponse }
        : {}),
      fsmPersisted: persist.ok,
      ...(fsmPersistenceOutcome !== undefined
        ? { fsmPersistenceOutcome }
        : {}),
      ...(hasDiag ? { internalDiagnostics: merged } : {}),
    };
  }

  private async persistFsmState(
    context: FSMContext,
    final: FSMResult,
    log: Logger,
  ): Promise<FsmPersistResult> {
    if (context.currentState === final.nextState) {
      return { ok: true, outcome: "skipped_unchanged" };
    }

    try {
      log.info(
        {
          step: "fsm_persist_attempt",
          leadId: context.leadId,
          from: context.currentState,
          to: final.nextState,
        },
        "fsm persist attempt",
      );

      const supabase = this.supabase();
      const { error } = await supabase
        .from("leads")
        .update({
          fsm_state: final.nextState,
          updated_at: new Date().toISOString(),
        })
        .eq("id", context.leadId)
        .eq("tenant_id", context.tenantId);

      if (error) {
        throw error;
      }

      log.info(
        {
          step: "fsm_persist",
          leadId: context.leadId,
          nextState: final.nextState,
        },
        "fsm persist",
      );
      return { ok: true, outcome: "written" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        {
          step: "fsm_persist_error",
          error: msg,
          leadId: context.leadId,
          tenant_id: context.tenantId,
        },
        "fsm persist error",
      );
      return { ok: false, error: msg };
    }
  }

  private async invokeLlm(
    task: LLMInput["task"],
    context: FSMContext,
    log: Logger,
    options?: { input?: string },
  ): Promise<
    | { ok: true; llmResponse: LLMResponse }
    | { ok: false; errorDetail: string }
  > {
    const input = options?.input ?? context.message;
    log.info(
      {
        step: "llm_call",
        task,
        inputLength: input.length,
      },
      "llm call",
    );
    try {
      const llmResponse = await this.llm.generate({
        task,
        input,
        traceId: context.traceId,
        tenantId: context.tenantId,
      });
      log.info(
        {
          step: "llm_response",
          provider: llmResponse?.provider,
          latency_ms: llmResponse?.latency_ms,
        },
        "llm response",
      );
      return { ok: true, llmResponse };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log.error(
        {
          step: "llm_error",
          task,
          error: detail,
          tenant_id: context.tenantId,
          lead_id: context.leadId,
          trace_id: context.traceId,
        },
        "llm error",
      );
      return { ok: false, errorDetail: detail };
    }
  }

  private mergeClassify(
    context: FSMContext,
    llmResponse: LLMResponse,
  ): ExtractedData {
    const intent =
      llmResponse?.data?.intent === "venta" ||
      llmResponse?.data?.intent === "soporte"
        ? llmResponse.data.intent
        : undefined;
    const newData: ExtractedData =
      intent !== undefined ? { intent } : {};
    return {
      ...context.extractedData,
      ...newData,
    };
  }

  private mergeExtractSlots(
    context: FSMContext,
    llm: LLMResponse,
  ): ExtractedData {
    const newData = (llm.data ?? {}) as ExtractedData;
    return {
      ...context.extractedData,
      ...newData,
    };
  }
}
