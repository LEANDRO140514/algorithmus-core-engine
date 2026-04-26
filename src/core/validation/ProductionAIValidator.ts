import pino, { type Logger } from "pino";
import type { Metrics } from "../observability/Metrics";
import type {
  AIValidator,
  SafetyPort,
  SafetyPortInput,
  SafetyPortOutput,
  ValidationContext,
  ValidationFlags,
  ValidationMetadata,
  ValidationReasonCode,
  ValidationResult,
} from "./AIValidationLayer";
import { BasicAIValidator } from "./AIValidatorImpl";

const DEFAULT_SAFETY_TIMEOUT_MS = 5000;
const SAFETY_VALIDATIONS = "safety_validation_outcomes_total";

const defaultLog = pino({
  level: process.env.LOG_LEVEL ?? "info",
  name: "production-ai-validator",
});

export type ProductionAIValidatorDeps = {
  readonly safetyPort: SafetyPort;
  readonly base?: AIValidator;
  readonly logger?: Logger;
  readonly metrics?: Metrics;
  readonly safetyTimeoutMs?: number;
};

type SafetyEvaluation =
  | { readonly kind: "ok"; readonly output: SafetyPortOutput }
  | { readonly kind: "error"; readonly detail: string; readonly timedOut: boolean };

function dedupReasonCodes(
  codes: readonly ValidationReasonCode[],
): readonly ValidationReasonCode[] {
  const seen = new Set<ValidationReasonCode>();
  const out: ValidationReasonCode[] = [];
  for (const c of codes) {
    if (!seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label}_timeout_${ms}ms`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

function tenantLabel(ctx: ValidationContext): string {
  const t = ctx.tenantId?.trim();
  return t && t.length > 0 ? t : "unknown";
}

/**
 * Validator de produccion. Compone `BasicAIValidator` (flags base) con un
 * `SafetyPort` inyectado para resolver `isSafe`.
 *
 * Garantia (fail-closed):
 *   - SafetyPort retorna isSafe=true       -> flags.isSafe = true.
 *   - SafetyPort retorna isSafe=false      -> flags.isSafe = false + reasonCode `unsafe_content`.
 *   - SafetyPort lanza, timeout o error    -> flags.isSafe = false + reasonCode `port_unavailable`.
 *
 * El resto de flags (`isComplete`, `isGrounded`, `isWithinFSM`) y el
 * `confidence` provienen del `BasicAIValidator` y se preservan tal cual.
 *
 * NO importa adapters concretos. Solo conoce la interfaz `SafetyPort`.
 */
export class ProductionAIValidator implements AIValidator {
  private readonly safetyPort: SafetyPort;
  private readonly base: AIValidator;
  private readonly log: Logger;
  private readonly metrics?: Metrics;
  private readonly safetyTimeoutMs: number;

  constructor(deps: ProductionAIValidatorDeps) {
    this.safetyPort = deps.safetyPort;
    this.base = deps.base ?? new BasicAIValidator();
    this.log =
      deps.logger ?? defaultLog.child({ module: "ProductionAIValidator" });
    this.metrics = deps.metrics;
    this.safetyTimeoutMs = deps.safetyTimeoutMs ?? DEFAULT_SAFETY_TIMEOUT_MS;
  }

  async validate(context: ValidationContext): Promise<ValidationResult> {
    const baseResult = await this.base.validate(context);
    const safety = await this.evaluateSafetyResilient(context);

    const tenant = tenantLabel(context);

    let isSafe: boolean;
    let extraReasonCodes: readonly ValidationReasonCode[];
    let safetyLabels: readonly string[] | undefined;

    if (safety.kind === "ok") {
      const out = safety.output;
      isSafe = out.isSafe === true;
      safetyLabels = out.labels;
      if (!isSafe) {
        extraReasonCodes = [
          ...out.reasonCodes,
          ...(out.reasonCodes.includes("unsafe_content")
            ? []
            : (["unsafe_content"] as const)),
        ];
        this.metrics?.incrementCounter(SAFETY_VALIDATIONS, 1, {
          outcome: "unsafe",
          tenant_id: tenant,
        });
        this.log.info(
          {
            step: "safety_validation",
            outcome: "unsafe",
            tenant_id: tenant,
            trace_id: context.traceId,
            labels: out.labels,
          },
          "safety validation unsafe",
        );
      } else {
        extraReasonCodes = out.reasonCodes;
        this.metrics?.incrementCounter(SAFETY_VALIDATIONS, 1, {
          outcome: "safe",
          tenant_id: tenant,
        });
      }
    } else {
      isSafe = false;
      extraReasonCodes = ["port_unavailable"];
      safetyLabels = undefined;
      this.metrics?.incrementCounter(SAFETY_VALIDATIONS, 1, {
        outcome: "error",
        tenant_id: tenant,
        timed_out: safety.timedOut ? "true" : "false",
      });
      this.log.warn(
        {
          step: "safety_validation",
          outcome: "error",
          timed_out: safety.timedOut,
          detail: safety.detail,
          tenant_id: tenant,
          trace_id: context.traceId,
        },
        "safety validation failed; fail-closed",
      );
    }

    const mergedFlags: ValidationFlags = {
      isSafe,
      isGrounded: baseResult.flags.isGrounded,
      isComplete: baseResult.flags.isComplete,
      isWithinFSM: baseResult.flags.isWithinFSM,
    };

    const mergedReasonCodes = dedupReasonCodes([
      ...baseResult.reasonCodes,
      ...extraReasonCodes,
    ]);

    const mergedMetadata: ValidationMetadata = {
      ...baseResult.metadata,
      validatorName: "ProductionAIValidator",
      validatorVersion: "1.0.0",
      evaluatedAtIso: new Date().toISOString(),
      ...(safetyLabels !== undefined && safetyLabels.length > 0
        ? { safetyLabels }
        : {}),
    };

    return {
      flags: mergedFlags,
      scores: baseResult.scores,
      reasonCodes: mergedReasonCodes,
      metadata: mergedMetadata,
    };
  }

  private async evaluateSafetyResilient(
    context: ValidationContext,
  ): Promise<SafetyEvaluation> {
    const safetyInput: SafetyPortInput = {
      tenantId: context.tenantId,
      traceId: context.traceId,
      userMessage: context.userMessage,
      aiOutputText: context.aiOutput.text,
    };

    try {
      const output = await withTimeout(
        Promise.resolve().then(() => this.safetyPort.evaluate(safetyInput)),
        this.safetyTimeoutMs,
        "safety_port",
      );
      return { kind: "ok", output };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const timedOut = /_timeout_\d+ms$/.test(message);
      return { kind: "error", detail: message, timedOut };
    }
  }
}
