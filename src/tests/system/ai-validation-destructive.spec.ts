import { afterEach, describe, expect, it, jest } from "@jest/globals";
import type { FSMContext, FSMTransitionResult } from "../../core/fsm/fsm.types";
import {
  FSMEngine,
  getAllowedActionsForState,
} from "../../core/fsm/FSMEngine";
import { FSMTransitionChecker } from "../../core/fsm/FSMTransitionChecker";
import type { LLMResponse } from "../../core/llm/LLMGateway";
import { LLMGateway } from "../../core/llm/LLMGateway";
import type { RAGDocument } from "../../core/rag/RAGService";
import { RAGService } from "../../core/rag/RAGService";
import { Orchestrator } from "../../core/orchestrator/Orchestrator";
import type {
  AIValidationTask,
  AIValidator,
  DecisionMatrix,
  ValidationContext,
  ValidationResult,
} from "../../core/validation/AIValidationLayer";
import { BasicAIValidator } from "../../core/validation/AIValidatorImpl";
import { BasicDecisionMatrix } from "../../core/validation/DecisionMatrixImpl";
import { BasicHardGate } from "../../core/validation/HardGateImpl";
import { NoopValidationMetricsPort } from "../../core/validation/NoopMetricsPort";

/**
 * Tests destructivos a nivel sistema del AI Validation Layer.
 *
 * Reglas del juego:
 *   - Se ejecuta el `Orchestrator` real con `BasicHardGate` real.
 *   - Solo se mockean fronteras externas (LLM, RAG, Supabase) y, en escenarios
 *     de "ataque", se inyecta un `validator` y/o `decisionMatrix` y/o
 *     `transitionChecker` que intentan FORZAR una emisión IA inválida.
 *   - El HardGate y el enforcement del Orchestrator deben ganar siempre.
 *
 * Mensaje de fallback hardcodeado en `Orchestrator.ts`. NO se importa: si el
 * literal cambia en producción sin actualizar este test, los tests deben
 * fallar para detectar el drift.
 */
const SAFE_FALLBACK_MESSAGE = "Hubo un problema, intenta nuevamente.";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function buildFSMContext(overrides: Partial<FSMContext> = {}): FSMContext {
  return {
    leadId: "lead-test",
    tenantId: "tenant-test",
    currentState: "INIT",
    message: "hola",
    traceId: "trace-test",
    extractedData: {},
    ...overrides,
  };
}

/**
 * Stub mínimo de Supabase compatible con el query builder usado por el
 * Orchestrator (`supabase.from(...).update(...).eq(...).eq(...)` awaited).
 *
 * Devuelve siempre `{ error: null }` y registra cuántas veces se hizo `update`.
 */
function makeSupabaseStub(): { client: () => unknown; updateCalls: () => number } {
  let updateCount = 0;
  const chain: Record<string, unknown> = {};
  const thenable = {
    then: (onFulfilled: (value: { error: null }) => unknown) =>
      Promise.resolve({ error: null }).then(onFulfilled),
  };
  chain.from = () => chain;
  chain.update = () => {
    updateCount += 1;
    return chain;
  };
  chain.eq = () => Object.assign(chain, thenable);
  return {
    client: () => chain,
    updateCalls: () => updateCount,
  };
}

class StubTransitionChecker extends FSMTransitionChecker {
  private readonly stubResult: FSMTransitionResult;

  constructor(stubResult: FSMTransitionResult) {
    super(new FSMEngine());
    this.stubResult = stubResult;
  }

  check(): FSMTransitionResult {
    return this.stubResult;
  }
}

type BuildOpts = {
  llmResponse?: LLMResponse;
  ragDocuments?: RAGDocument[];
  validator?: AIValidator;
  decisionMatrix?: DecisionMatrix;
  transitionChecker?: FSMTransitionChecker;
};

function buildOrchestrator(opts: BuildOpts = {}): {
  orchestrator: Orchestrator;
  supabaseUpdateCalls: () => number;
} {
  const fsmEngine = new FSMEngine();
  const llm = new LLMGateway();
  const rag = new RAGService({});

  if (opts.llmResponse !== undefined) {
    jest
      .spyOn(llm, "generate")
      .mockResolvedValue(opts.llmResponse);
  }
  if (opts.ragDocuments !== undefined) {
    const docs = opts.ragDocuments;
    jest
      .spyOn(rag, "query")
      .mockResolvedValue({ documents: docs, usedTopK: docs.length || 5 });
  }

  const supabaseStub = makeSupabaseStub();

  const orchestrator = new Orchestrator({
    supabase: supabaseStub.client as () => never,
    fsmEngine,
    llmGateway: llm,
    ragService: rag,
    validator: opts.validator ?? new BasicAIValidator(),
    decisionMatrix: opts.decisionMatrix ?? new BasicDecisionMatrix(),
    hardGate: new BasicHardGate(),
    fsmTransitionChecker:
      opts.transitionChecker ?? new FSMTransitionChecker(fsmEngine),
    validationMetrics: new NoopValidationMetricsPort(),
  });

  return {
    orchestrator,
    supabaseUpdateCalls: supabaseStub.updateCalls,
  };
}

const SAFE_VALIDATOR: AIValidator = {
  validate: async () => ({
    flags: {
      isSafe: true,
      isGrounded: true,
      isComplete: true,
      isWithinFSM: true,
    },
    scores: { confidence: 0.99 },
    reasonCodes: [],
  }),
};

const ACCEPT_DECISION: DecisionMatrix = {
  decide: () => ({
    action: "accept",
    reasonCodes: ["validation_safe"],
  }),
};

// -----------------------------------------------------------------------------
// Suite
// -----------------------------------------------------------------------------

describe("AI Validation Layer — destructive system tests", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Scenario 1
  // ---------------------------------------------------------------------------
  it("scenario 1: empty AI response → SAFE_FALLBACK_MESSAGE (no AI text emitted)", async () => {
    const { orchestrator, supabaseUpdateCalls } = buildOrchestrator({
      llmResponse: {
        text: "",
        provider: "ollama",
        latency_ms: 1,
      },
    });

    const result = await orchestrator.process(buildFSMContext());

    expect(result.messageToSend).toBe(SAFE_FALLBACK_MESSAGE);
    expect(result.messageToSend).not.toBe("");
    // No FSM transition cuando se bloquea -> no hay UPDATE en DB.
    expect(supabaseUpdateCalls()).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Scenario 2
  // ---------------------------------------------------------------------------
  it("scenario 2: unsafe response w/ decision=accept (bypass attempt) → HardGate blocks", async () => {
    const aiPayload = "I_AM_UNSAFE_PAYLOAD";

    const unsafeValidator: AIValidator = {
      validate: async () => ({
        flags: {
          isSafe: false,
          isGrounded: true,
          isComplete: true,
          isWithinFSM: true,
        },
        scores: { confidence: 0.99 },
        reasonCodes: ["unsafe_content"],
      }),
    };

    const { orchestrator } = buildOrchestrator({
      llmResponse: { text: aiPayload, provider: "ollama", latency_ms: 1 },
      validator: unsafeValidator,
      decisionMatrix: ACCEPT_DECISION,
    });

    const result = await orchestrator.process(buildFSMContext());

    expect(result.messageToSend).toBe(SAFE_FALLBACK_MESSAGE);
    expect(result.messageToSend).not.toBe(aiPayload);
    expect(result.internalDiagnostics?.hardGateBlocked).toBe(true);
    expect(result.internalDiagnostics?.hardGateReason).toBe("blocked_unsafe");
  });

  // ---------------------------------------------------------------------------
  // Scenario 3
  // ---------------------------------------------------------------------------
  it("scenario 3: FSM transition denied w/ decision=accept → HardGate blocks", async () => {
    const aiPayload = "PAYLOAD_WITH_INVALID_TRANSITION";

    const blockedTransition = new StubTransitionChecker({
      allowed: false,
      fromState: "INIT",
      toState: "INIT",
      reasonCodes: ["transition_blocked"],
    });

    const { orchestrator } = buildOrchestrator({
      llmResponse: { text: aiPayload, provider: "ollama", latency_ms: 1 },
      validator: SAFE_VALIDATOR,
      decisionMatrix: ACCEPT_DECISION,
      transitionChecker: blockedTransition,
    });

    const result = await orchestrator.process(buildFSMContext());

    expect(result.messageToSend).not.toBe(aiPayload);
    expect(result.messageToSend).toBe(SAFE_FALLBACK_MESSAGE);
    expect(result.internalDiagnostics?.hardGateBlocked).toBe(true);
    expect(result.internalDiagnostics?.hardGateReason).toBe(
      "blocked_fsm_transition",
    );
  });

  // ---------------------------------------------------------------------------
  // Scenario 4
  // ---------------------------------------------------------------------------
  it("scenario 4: no grounding → DecisionMatrix returns 'fallback' → SAFE_FALLBACK_MESSAGE", async () => {
    // Real validator + real DecisionMatrix.
    // Path "reply" no agrega `groundingReferences` -> isGrounded=false -> fallback.
    const aiPayload = "answer with no grounding";

    const { orchestrator } = buildOrchestrator({
      llmResponse: {
        text: aiPayload,
        provider: "ollama",
        latency_ms: 1,
        confidence: 0.99,
      },
    });

    const result = await orchestrator.process(buildFSMContext());

    expect(result.messageToSend).toBe(SAFE_FALLBACK_MESSAGE);
    expect(result.messageToSend).not.toBe(aiPayload);
    expect(result.internalDiagnostics?.decisionAction).toBe("fallback");
  });

  // ---------------------------------------------------------------------------
  // Scenario 5
  // ---------------------------------------------------------------------------
  it("scenario 5: low confidence (RAG path) → DecisionMatrix returns 'retry' → no AI text emitted", async () => {
    // Path RAG con documentos para que isGrounded=true (sino caería en fallback
    // por scenario 4 antes de evaluar confidence). Así forzamos confidence < 0.5.
    const aiPayload = "answer with low confidence";

    const { orchestrator } = buildOrchestrator({
      llmResponse: {
        text: aiPayload,
        provider: "ollama",
        latency_ms: 1,
        confidence: 0.3,
      },
      ragDocuments: [
        { id: "doc-1", content: "context blob", score: 0.91 },
        { id: "doc-2", content: "other context", score: 0.85 },
      ],
    });

    const result = await orchestrator.process(
      buildFSMContext({
        extractedData: { intent: "soporte" },
      }),
    );

    expect(result.messageToSend).not.toBe(aiPayload);
    expect(result.messageToSend).toBe(SAFE_FALLBACK_MESSAGE);
    expect(result.internalDiagnostics?.decisionAction).toBe("retry");
  });

  // ---------------------------------------------------------------------------
  // Scenario 6 (CRÍTICO)
  // ---------------------------------------------------------------------------
  it("scenario 6: combined attack (isSafe=false, isGrounded=false, isWithinFSM=false, decision=accept) → HardGate wins", async () => {
    const aiPayload = "EVIL_PAYLOAD_THAT_MUST_NEVER_LEAK";

    const evilValidator: AIValidator = {
      validate: async () => ({
        flags: {
          isSafe: false,
          isGrounded: false,
          isComplete: true,
          isWithinFSM: false,
        },
        scores: { confidence: 0.99 },
        reasonCodes: [
          "unsafe_content",
          "ungrounded_output",
          "outside_fsm",
        ],
      }),
    };

    const { orchestrator } = buildOrchestrator({
      llmResponse: { text: aiPayload, provider: "ollama", latency_ms: 1 },
      validator: evilValidator,
      decisionMatrix: ACCEPT_DECISION,
    });

    const result = await orchestrator.process(buildFSMContext());

    expect(result.messageToSend).toBe(SAFE_FALLBACK_MESSAGE);
    expect(result.messageToSend).not.toBe(aiPayload);
    expect(result.internalDiagnostics?.hardGateBlocked).toBe(true);
    // El HardGate evalúa en orden: isSafe primero, así que la primera razón
    // que dispara el bloqueo es `blocked_unsafe`.
    expect(result.internalDiagnostics?.hardGateReason).toBe("blocked_unsafe");
  });

  // ---------------------------------------------------------------------------
  // Scenario 7 — Invariante global
  // ---------------------------------------------------------------------------
  it("scenario 7: invariant — AI text NEVER leaks when isSafe/isWithinFSM/transition.allowed are false (any combination)", async () => {
    const aiPayload = "INVARIANT_PAYLOAD";
    type Combination = {
      isSafe: boolean;
      isWithinFSM: boolean;
      transitionAllowed: boolean;
    };

    const combinations: Combination[] = [];
    for (const isSafe of [false, true]) {
      for (const isWithinFSM of [false, true]) {
        for (const transitionAllowed of [false, true]) {
          if (!isSafe || !isWithinFSM || !transitionAllowed) {
            combinations.push({ isSafe, isWithinFSM, transitionAllowed });
          }
        }
      }
    }
    // 2^3 - 1 = 7 combinaciones donde al menos una condición es false.
    expect(combinations).toHaveLength(7);

    for (const combo of combinations) {
      const stubValidator: AIValidator = {
        validate: async () => ({
          flags: {
            isSafe: combo.isSafe,
            isGrounded: true,
            isComplete: true,
            isWithinFSM: combo.isWithinFSM,
          },
          scores: { confidence: 0.99 },
          reasonCodes: [],
        }),
      };

      const stubChecker = new StubTransitionChecker({
        allowed: combo.transitionAllowed,
        fromState: "INIT",
        toState: "INIT",
        reasonCodes: combo.transitionAllowed
          ? ["transition_allowed"]
          : ["transition_blocked"],
      });

      const { orchestrator } = buildOrchestrator({
        llmResponse: { text: aiPayload, provider: "ollama", latency_ms: 1 },
        validator: stubValidator,
        decisionMatrix: ACCEPT_DECISION,
        transitionChecker: stubChecker,
      });

      const result = await orchestrator.process(buildFSMContext());

      expect(result.messageToSend).not.toBe(aiPayload);
      expect(result.messageToSend).toBe(SAFE_FALLBACK_MESSAGE);
      expect(result.internalDiagnostics?.hardGateBlocked).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // Scenario 8 — unit-level: BasicAIValidator deriva isWithinFSM de
  // (allowedActions, expectedAction) sin tocar FSMEngine.
  // ---------------------------------------------------------------------------
  it("scenario 8: BasicAIValidator → isWithinFSM is true iff expectedAction ∈ allowedActions", async () => {
    const validator = new BasicAIValidator();

    const baseContext: Omit<ValidationContext, "expectedAction" | "fsmContext"> = {
      tenantId: "tenant-test",
      leadId: "lead-test",
      traceId: "trace-test",
      task: "rag_answer",
      userMessage: "hola",
      aiOutput: { text: "respuesta", confidence: 0.9 },
      groundingReferences: [{ id: "doc-1", source: "rag" }],
    };

    // (a) expectedAction ∈ allowedActions(SUPPORT_RAG) → isWithinFSM=true
    const ok = await validator.validate({
      ...baseContext,
      expectedAction: "rag_answer",
      fsmContext: {
        leadId: "lead-test",
        tenantId: "tenant-test",
        currentState: "SUPPORT_RAG",
        message: "hola",
        allowedActions: getAllowedActionsForState("SUPPORT_RAG"),
      },
    });
    expect(ok.flags.isWithinFSM).toBe(true);
    expect(ok.reasonCodes).not.toContain("outside_fsm");

    // (b) expectedAction ∉ allowedActions(BOOKING) → isWithinFSM=false
    const drift = await validator.validate({
      ...baseContext,
      expectedAction: "rag_answer",
      fsmContext: {
        leadId: "lead-test",
        tenantId: "tenant-test",
        currentState: "BOOKING",
        message: "hola",
        allowedActions: getAllowedActionsForState("BOOKING"),
      },
    });
    expect(drift.flags.isWithinFSM).toBe(false);
    expect(drift.reasonCodes).toContain("outside_fsm");

    // (c) allowedActions ausente → conjunto vacío → isWithinFSM=false
    const missing = await validator.validate({
      ...baseContext,
      expectedAction: "rag_answer",
      fsmContext: {
        leadId: "lead-test",
        tenantId: "tenant-test",
        currentState: "SUPPORT_RAG",
        message: "hola",
      },
    });
    expect(missing.flags.isWithinFSM).toBe(false);
    expect(missing.reasonCodes).toContain("outside_fsm");
  });

  // ---------------------------------------------------------------------------
  // Scenario 9 — end-to-end: ataque "intent drift". La IA propone una acción
  // que el FSM NO permite en el estado actual. Pipeline completo (validator real
  // + DecisionMatrix real + HardGate real) debe terminar en SAFE_FALLBACK_MESSAGE.
  //
  // Setup: estado QUALIFYING (allowedActions = [extract_slots, generate_reply]).
  // El orquestador ejecuta extract_slots, pero un wrapper malicioso reescribe
  // expectedAction → "rag_answer" antes de que el validator evalúe. El validator
  // detecta la divergencia → isWithinFSM=false → DecisionMatrix=handover →
  // HardGate=blocked_outside_fsm → fallback.
  // ---------------------------------------------------------------------------
  it("scenario 9: intent drift (expectedAction ∉ allowedActions) → handover → SAFE_FALLBACK_MESSAGE", async () => {
    class ExpectedActionOverrideValidator implements AIValidator {
      constructor(
        private readonly inner: AIValidator,
        private readonly forced: AIValidationTask,
      ) {}
      async validate(ctx: ValidationContext): Promise<ValidationResult> {
        return this.inner.validate({ ...ctx, expectedAction: this.forced });
      }
    }

    const aiPayload = "DRIFTED_PAYLOAD_THAT_MUST_NOT_LEAK";

    const driftValidator = new ExpectedActionOverrideValidator(
      new BasicAIValidator(),
      "rag_answer",
    );

    const { orchestrator, supabaseUpdateCalls } = buildOrchestrator({
      llmResponse: {
        text: aiPayload,
        provider: "ollama",
        latency_ms: 1,
        confidence: 0.99,
      },
      validator: driftValidator,
    });

    const result = await orchestrator.process(
      buildFSMContext({
        currentState: "QUALIFYING",
        extractedData: {},
      }),
    );

    expect(result.messageToSend).not.toBe(aiPayload);
    expect(result.messageToSend).toBe(SAFE_FALLBACK_MESSAGE);
    expect(result.internalDiagnostics?.decisionAction).toBe("handover");
    expect(result.internalDiagnostics?.hardGateBlocked).toBe(true);
    expect(result.internalDiagnostics?.hardGateReason).toBe(
      "blocked_outside_fsm",
    );
    expect(supabaseUpdateCalls()).toBe(0);
  });
});
