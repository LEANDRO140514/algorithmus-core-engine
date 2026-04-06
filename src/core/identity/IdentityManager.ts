import pino, { type Logger } from "pino";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "../supabase_client";
import { getRedis } from "../../infra/redis/client";
import type { GHLIntegration } from "./GHLIntegration";
import { GHLIntegrationStub } from "./GHLIntegration";

/** Fila `leads` alineada con `src/infra/postgres/schema.sql` y PRD §3.2. */
export type CoreLead = {
  id: string;
  tenant_id: string;
  phone_number: string;
  first_name: string | null;
  email: string | null;
  tags: Record<string, unknown>;
  fsm_state: string;
  ai_confidence_score: number;
  last_interaction: string | null;
  created_at: string;
  updated_at: string;
};

export class LeadLockContentionError extends Error {
  readonly code = "LEAD_LOCK_CONTENTION";
  constructor(message = "No se pudo adquirir lock de lead tras reintentos") {
    super(message);
    this.name = "LeadLockContentionError";
  }
}

const LOCK_TTL_SEC = 5;
const LOCK_MAX_ATTEMPTS = 3;
const LOCK_BACKOFF_MS = [50, 150, 350];

/** Libera el lock solo si el valor coincide con el token (compare-and-del atómico). */
const RELEASE_LOCK_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

function normalizePhoneE164(phone: string): string {
  const cleaned = phone.replace(/[^\d+]/g, "");

  if (!cleaned.startsWith("+")) {
    throw new Error("phone must be in E.164 format");
  }

  const digits = cleaned.slice(1);

  if (!/^\d+$/.test(digits)) {
    throw new Error("phone contains invalid characters");
  }

  if (digits.length < 8) {
    throw new Error("phone too short");
  }

  return `+${digits}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Backoff base con jitter (hasta ~30% adicional) para desincronizar reintentos. */
function backoffMsWithJitter(baseMs: number): number {
  const jitterCap = Math.floor(baseMs * 0.3);
  const jitter = jitterCap > 0 ? Math.floor(Math.random() * (jitterCap + 1)) : 0;
  return baseMs + jitter;
}

function lockKeyForResolve(
  existingId: string | null,
  tenantId: string,
  normalizedPhone: string,
): string {
  if (existingId) return `lock:lead:${existingId}`;
  return `lock:lead:resolve:${tenantId}:${normalizedPhone}`;
}

export type IdentityManagerDeps = {
  supabase?: () => SupabaseClient;
  ghl?: GHLIntegration;
  baseLogger?: Logger;
};

/**
 * Resolución de identidad multitenant (PRD §3, §4).
 * Supabase = SSOT; GHL = fallback; Redis SET NX EX = lock por lead / resolución.
 */
export class IdentityManager {
  private readonly getSupabase: () => SupabaseClient;
  private readonly ghl: GHLIntegration;
  private readonly baseLogger: Logger;

  constructor(deps: IdentityManagerDeps = {}) {
    this.getSupabase = deps.supabase ?? createSupabaseServerClient;
    this.ghl = deps.ghl ?? new GHLIntegrationStub();
    this.baseLogger =
      deps.baseLogger ??
      pino({
        level: process.env.LOG_LEVEL ?? "info",
        name: "algorithmus-core",
      });
  }

  /**
   * Resuelve o crea el lead por (tenant_id, phone_number) con upsert seguro
   * y lock Redis (PRD §4.1: máx. 3 reintentos con backoff).
   */
  async resolveLead(
    phone: string,
    tenantId: string,
    traceId: string,
  ): Promise<CoreLead> {
    const log = this.baseLogger.child({
      trace_id: traceId,
      module: "IdentityManager",
    });

    if (!phone.trim()) {
      log.warn({ step: "validate_phone" }, "teléfono vacío");
      throw new Error("phone requerido");
    }

    let normalizedPhone: string;
    try {
      normalizedPhone = normalizePhoneE164(phone);
    } catch (e) {
      log.warn({ step: "validate_phone", err: String(e) }, "teléfono inválido");
      throw e;
    }

    log.info(
      { step: "phone_normalized", normalizedPhone },
      "teléfono normalizado",
    );

    log.info({ step: "peek_lookup", tenantId }, "consulta inicial leads");

    const supabase = this.getSupabase();
    let peek: CoreLead | null = await this.fetchLead(
      supabase,
      tenantId,
      normalizedPhone,
    );

    const lockKey = lockKeyForResolve(
      peek?.id ?? null,
      tenantId,
      normalizedPhone,
    );
    const token = traceId;

    log.info({ step: "lock_acquire_start", lockKey }, "adquiriendo lock Redis");
    const redis = await getRedis();
    const locked = await this.acquireLockWithRetry(lockKey, token, log, redis);
    if (!locked) {
      log.warn({ step: "lock_failed", lockKey }, "contención de lock");
      throw new LeadLockContentionError();
    }

    try {
      log.info({ step: "locked_lookup" }, "re-consulta bajo lock");
      let row = await this.fetchLead(supabase, tenantId, normalizedPhone);

      if (row) {
        log.info({ step: "lead_cache_hit", leadId: row.id }, "lead existente");
        return row;
      }

      log.info({ step: "ghl_fallback" }, "lead ausente; stub GHL");
      const profile = await this.ghl.fetchLeadByPhone(
        normalizedPhone,
        tenantId,
        traceId,
      );

      const now = new Date().toISOString();

      const payload: Record<string, unknown> = {
        tenant_id: tenantId,
        phone_number: normalizedPhone,
        updated_at: now,
      };
      if (profile.firstName != null && profile.firstName !== "") {
        payload.first_name = profile.firstName;
      }
      if (profile.email != null && profile.email !== "") {
        payload.email = profile.email;
      }

      log.info({ step: "upsert_atomic" }, "upsert ON CONFLICT (tenant_id, phone_number)");

      const { data: upserted, error: upsertErr } = await supabase
        .from("leads")
        .upsert(payload, { onConflict: "tenant_id,phone_number" })
        .select()
        .single();

      if (!upsertErr && upserted) {
        log.info({ step: "upsert_ok", leadId: upserted.id }, "lead persistido");
        return upserted as CoreLead;
      }

      log.error(
        { step: "upsert_failed", err: upsertErr?.message },
        "fallo upsert",
      );
      throw new Error(upsertErr?.message ?? "upsert leads falló");
    } finally {
      try {
        const released = await redis.eval(RELEASE_LOCK_LUA, {
          keys: [lockKey],
          arguments: [token],
        });

        log.info(
          { step: "lock_released", released: released === 1 },
          "resultado liberación lock",
        );
      } catch (e) {
        log.warn({ step: "lock_release_skip", err: String(e) }, "no se liberó lock");
      }
    }
  }

  private async fetchLead(
    client: SupabaseClient,
    tenantId: string,
    phone: string,
  ): Promise<CoreLead | null> {
    const { data, error } = await client
      .from("leads")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("phone_number", phone)
      .maybeSingle();

    if (error) throw new Error(`lookup leads: ${error.message}`);
    if (!data) return null;
    return data as CoreLead;
  }

  /**
   * SET key NX EX — valor = trace_id para liberación segura opcional.
   */
  private async acquireLockWithRetry(
    key: string,
    value: string,
    log: Logger,
    redis: Awaited<ReturnType<typeof getRedis>>,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
      const ok = await redis.set(key, value, {
        NX: true,
        EX: LOCK_TTL_SEC,
      });
      if (ok === "OK") {
        log.info(
          { step: "lock_acquired", attempt: attempt + 1, key },
          "lock Redis OK",
        );
        return true;
      }
      log.info(
        { step: "lock_busy", attempt: attempt + 1, key },
        "lock ocupado; backoff",
      );
      if (attempt < LOCK_MAX_ATTEMPTS - 1) {
        await sleep(backoffMsWithJitter(LOCK_BACKOFF_MS[attempt] ?? 200));
      }
    }
    return false;
  }
}
