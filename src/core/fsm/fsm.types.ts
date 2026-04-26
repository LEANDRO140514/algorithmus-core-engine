export type FSMState =
  | "INIT"
  | "QUALIFYING"
  | "SUPPORT_RAG"
  | "BOOKING"
  | "HUMAN_HANDOVER";

export type FSMAction =
  | "classify_intent"
  | "extract_slots"
  | "query_rag"
  | "book_appointment"
  | "handover_human"
  | "reply";

export type ExtractedData = {
  intent?: "venta" | "soporte";
  qualifyingComplete?: boolean;
  lowRagConfidence?: boolean;
  ragConfidence?: number;
  ragAttempts?: number;
  bookingAvailabilityMissing?: boolean;
  bookingConfirmed?: boolean;
};

export type FSMContext = {
  leadId: string;
  tenantId: string;
  currentState: FSMState;
  message: string;
  traceId?: string;
  extractedData?: ExtractedData;
};

export type FSMResult = {
  nextState: FSMState;
  action: FSMAction;
};

export type FSMTransitionReasonCode =
  | "transition_allowed"
  | "transition_blocked"
  | "invalid_state"
  | "missing_context";

export interface FSMTransitionResult {
  readonly allowed: boolean;
  readonly fromState: FSMState;
  readonly toState: FSMState;
  readonly action?: FSMAction;
  readonly reasonCodes?: readonly FSMTransitionReasonCode[];
}
