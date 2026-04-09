import pino, { type Logger } from "pino";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExtractedData, FSMContext, FSMResult } from "../fsm/FSMEngine";
import { FSMEngine } from "../fsm/FSMEngine";
import type { LLMInput, LLMResponse } from "../llm/LLMGateway";
import { LLMGateway } from "../llm/LLMGateway";
import type { RAGQueryResult } from "../rag/RAGService";
import { RAGService } from "../rag/RAGService";
import { createSupabaseServerClient } from "../supabase_client";

const RAG_CONTEXT_MAX_CHARS = 2000;
const RAG_DOCUMENT_MAX_CHARS = 500;

const defaultLog = pino({
  level: process.env.LOG_LEVEL ?? "info",
  name: "algorithmus-orchestrator",
});

export type OrchestratorProcessResult = {
  /** Primera evaluación FSM (acción a ejecutar). */
  initial: FSMResult;
  /** Tras inyectar datos del LLM, segunda evaluación; igual que `initial` si no hubo llamada LLM. */
  final: FSMResult;
  llmResponse?: LLMResponse;
  /** Texto listo para enviar al usuario (siempre definido). */
  messageToSend: string;
};

export type OrchestratorDeps = {
  logger?: Logger;
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
    } else if (isLegacyOrchestratorObjectDeps(arg1)) {
      this.fsm = arg1.fsm;
      this.llm = arg1.llm;
      this.rag = arg1.rag;
      this.log = arg1.logger ?? defaultLog;
      this.supabase = createSupabaseServerClient;
      this.log.warn(
        {
          event: "deprecated_constructor_usage",
          service: "Orchestrator",
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
      this.log.warn(
        {
          event: "deprecated_constructor_usage",
          service: "Orchestrator",
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
        const gen = await this.invokeLlm(
          "classify_intent",
          context,
          log,
        );
        if (!gen.ok) {
          const final = initial;
          await this.persistFsmState(context, final, log);
          return {
            initial,
            final,
            messageToSend: "Hubo un problema, intenta nuevamente.",
          };
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
        await this.persistFsmState(context, final, log);
        const messageToSend =
          llmResponse.text ?? "Procesando tu solicitud...";
        return { initial, final, llmResponse, messageToSend };
      }

      case "extract_slots": {
        const gen = await this.invokeLlm("extract_slots", context, log);
        if (!gen.ok) {
          const final = initial;
          await this.persistFsmState(context, final, log);
          return {
            initial,
            final,
            messageToSend: "Hubo un problema, intenta nuevamente.",
          };
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
        await this.persistFsmState(context, final, log);
        const messageToSend =
          llmResponse.text ?? "Procesando tu solicitud...";
        return { initial, final, llmResponse, messageToSend };
      }

      case "query_rag": {
        let ragResult: RAGQueryResult;
        try {
          ragResult = await this.rag.query({
            tenantId: context.tenantId,
            query: context.message,
            topK: 5,
          });
        } catch (ragErr) {
          log.error(
            {
              step: "rag_error",
              error:
                ragErr instanceof Error ? ragErr.message : String(ragErr),
            },
            "rag retrieval error",
          );
          ragResult = { documents: [], usedTopK: 5 };
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
          await this.persistFsmState(context, final, log);
          return {
            initial,
            final,
            messageToSend:
              "No encontré información relevante, ¿puedes dar más detalles?",
          };
        }

        // Mayor score primero (relevante cuando el vector store devuelve ranking real).
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
Usa el siguiente contexto para responder:

${safeContextText}

Pregunta del usuario:
${context.message}
`.trim();

        const gen = await this.invokeLlm("rag_answer", context, log, {
          input: ragPrompt,
        });
        if (!gen.ok) {
          const final = initial;
          await this.persistFsmState(context, final, log);
          return {
            initial,
            final,
            messageToSend: "Hubo un problema, intenta nuevamente.",
          };
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
        await this.persistFsmState(context, final, log);
        const messageToSend =
          llmResponse.text ?? "Procesando tu solicitud...";
        return {
          initial,
          final,
          llmResponse,
          messageToSend,
        };
      }

      case "reply": {
        const gen = await this.invokeLlm("generate_reply", context, log);
        if (!gen.ok) {
          const final = initial;
          await this.persistFsmState(context, final, log);
          return {
            initial,
            final,
            messageToSend: "Hubo un problema, intenta nuevamente.",
          };
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
        await this.persistFsmState(context, final, log);
        const messageToSend =
          llmResponse.text ?? "Procesando tu solicitud...";
        return {
          initial,
          final,
          llmResponse,
          messageToSend,
        };
      }

      case "book_appointment":
      case "handover_human":
      default: {
        const final = initial;
        log.info(
          { step: "fsm_final", nextState: final.nextState },
          "fsm final",
        );
        await this.persistFsmState(context, final, log);
        return {
          initial,
          final,
          messageToSend: "Procesando tu solicitud...",
        };
      }
    }
  }

  private async persistFsmState(
    context: FSMContext,
    final: FSMResult,
    log: Logger,
  ): Promise<void> {
    if (context.currentState === final.nextState) {
      return;
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
    } catch (err) {
      log.error(
        {
          step: "fsm_persist_error",
          error: err instanceof Error ? err.message : err,
        },
        "fsm persist error",
      );
    }
  }

  private async invokeLlm(
    task: LLMInput["task"],
    context: FSMContext,
    log: Logger,
    options?: { input?: string },
  ): Promise<
    | { ok: true; llmResponse: LLMResponse }
    | { ok: false }
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
      log.error(
        {
          step: "llm_error",
          error: err instanceof Error ? err.message : err,
        },
        "llm error",
      );
      return { ok: false };
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
