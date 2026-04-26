import type {
  AIValidator,
  ValidationContext,
  ValidationFlags,
  ValidationReasonCode,
  ValidationResult,
  ValidationScores,
} from "./AIValidationLayer";

const DEFAULT_CONFIDENCE = 0.5;

/**
 * Validador esqueleto: SOLO evalúa, NO decide.
 *
 * Reglas mínimas:
 *   - isSafe       = true (placeholder; SafetyPort real aún no instalado)
 *   - isComplete   = texto presente y no vacío tras trim
 *   - isGrounded   = referencias presentes (length > 0)
 *   - isWithinFSM  = true (placeholder; ver TODO abajo)
 *   - confidence   = aiOutput.confidence ?? 0.5
 */
export class BasicAIValidator implements AIValidator {
  async validate(context: ValidationContext): Promise<ValidationResult> {
    const reasonCodes: ValidationReasonCode[] = [];

    const isSafe = true;
    const isComplete =
      !!context.aiOutput.text && context.aiOutput.text.trim().length > 0;
    const isGrounded =
      Array.isArray(context.groundingReferences) &&
      context.groundingReferences.length > 0;
    const isWithinFSM = true; // TODO: derive from FSM state + allowed actions

    if (!isComplete) {
      reasonCodes.push("incomplete_output");
    }
    if (!isGrounded) {
      reasonCodes.push("ungrounded_output");
    }

    const flags: ValidationFlags = {
      isSafe,
      isGrounded,
      isComplete,
      isWithinFSM,
    };

    const scores: ValidationScores = {
      confidence: context.aiOutput.confidence ?? DEFAULT_CONFIDENCE,
    };

    return {
      flags,
      scores,
      reasonCodes,
      metadata: {
        validatorName: "BasicAIValidator",
        validatorVersion: "0.1.0-skeleton",
        evaluatedAtIso: new Date().toISOString(),
      },
    };
  }
}
