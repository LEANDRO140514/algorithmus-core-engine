import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import pino from "pino";
import type { Metrics } from "../../core/observability/Metrics";
import type { FSMState } from "../../core/fsm/FSMEngine";
import type { IdentityManager } from "../../core/identity/IdentityManager";
import type { Orchestrator } from "../../core/orchestrator/Orchestrator";
import type { YCloudInboundIdempotency } from "../providers/ycloud/ycloudIdempotency";
import type { YCloudSender } from "../providers/ycloud/ycloudSender";
import type { YCloudWebhookVerifier } from "../providers/ycloud/ycloudWebhookVerifier";
import { parseYCloudInboundWhatsAppText } from "../providers/ycloud/ycloudWebhookParser";
import {
  captureHandlerException,
  captureInfraMessage,
  setSentryRequestContext,
} from "../observability/sentry";

export const baseLogger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  name: "algorithmus-api",
});

const WEBHOOK_ROUTE = "/webhooks/whatsapp";
const WHATSAPP_CHANNEL = "whatsapp";

export type WhatsAppHandlerServices = {
  identityManager: IdentityManager;
  orchestrator: Orchestrator;
  webhookVerifier: YCloudWebhookVerifier;
  idempotency: YCloudInboundIdempotency;
  sender: YCloudSender;
};

let handlerServices: WhatsAppHandlerServices | null = null;

/** Debe llamarse antes de aceptar tráfico (p. ej. al arrancar el servidor). */
export function configureWhatsAppHandler(
  services: WhatsAppHandlerServices,
): void {
  handlerServices = services;
}

function baseLabels(tenant_id: string, reason: string) {
  return {
    tenant_id,
    route: WEBHOOK_ROUTE,
    reason,
    channel: WHATSAPP_CHANNEL,
  };
}

function recordWhatsAppHttpMetrics(
  metrics: Metrics,
  startNs: bigint,
  tenant_id: string,
  reason: string,
): void {
  const seconds = Number(process.hrtime.bigint() - startNs) / 1e9;
  const labels = baseLabels(tenant_id, reason);
  metrics.observeHistogram("http_request_duration_seconds", seconds, labels);
  metrics.incrementCounter("whatsapp_requests_total", 1, labels);
}

function readTenantIdHeader(req: Request): string | undefined {
  const raw = req.headers["x-tenant-id"];
  if (Array.isArray(raw)) {
    return typeof raw[0] === "string" ? raw[0].trim() : undefined;
  }
  return typeof raw === "string" ? raw.trim() : undefined;
}

function previewBody(raw: unknown): string {
  try {
    const s = JSON.stringify(raw);
    return s.length > 400 ? `${s.slice(0, 400)}…` : s;
  } catch {
    return "[unserializable]";
  }
}

const FSM_STATES: readonly FSMState[] = [
  "INIT",
  "QUALIFYING",
  "SUPPORT_RAG",
  "BOOKING",
  "HUMAN_HANDOVER",
];

function coerceFsmState(raw: string): FSMState {
  return FSM_STATES.includes(raw as FSMState) ? (raw as FSMState) : "INIT";
}

/**
 * Procesamiento síncrono en el request: YCloud/LLM/RAG pueden superar el timeout del proveedor.
 * Evolución recomendada: responder 200 tras encolar job y procesar en worker.
 */
export async function handleWhatsAppWebhook(
  req: Request,
  res: Response,
  metrics: Metrics,
): Promise<void> {
  const startNs = process.hrtime.bigint();
  const traceId = randomUUID();
  const receivedAt = new Date().toISOString();
  const tenantId = readTenantIdHeader(req);

  const log = baseLogger.child({
    module: "WhatsAppHandler",
    trace_id: traceId,
    tenant_id: tenantId ?? "unknown",
  });

  log.info(
    {
      event: "whatsapp_webhook_received",
      body_preview: previewBody(req.body),
    },
    "whatsapp webhook received",
  );

  if (typeof tenantId !== "string" || !tenantId.trim()) {
    recordWhatsAppHttpMetrics(metrics, startNs, "unknown", "missing_tenant");
    res.status(400).send("missing x-tenant-id");
    return;
  }

  const services = handlerServices;
  if (!services) {
    log.error(
      { event: "whatsapp_handler_misconfigured" },
      "handler sin servicios",
    );
    recordWhatsAppHttpMetrics(metrics, startNs, "unknown", "misconfigured");
    res.status(503).send("service unavailable");
    return;
  }

  const verify = services.webhookVerifier.verify(req);
  if (!verify.ok) {
    log.warn(
      {
        event: "whatsapp_webhook_verification_failed",
        reason: verify.reason,
      },
      "webhook verification failed",
    );
    recordWhatsAppHttpMetrics(
      metrics,
      startNs,
      tenantId.trim(),
      "unauthorized",
    );
    res.status(401).send("unauthorized");
    return;
  }

  const inbound = parseYCloudInboundWhatsAppText(req.body, {
    tenantId: tenantId.trim(),
    receivedAt,
  });

  if (!inbound) {
    log.info(
      { event: "whatsapp_webhook_ignored", reason: "not_inbound_text" },
      "webhook ignored",
    );
    metrics.incrementCounter(
      "whatsapp_events_ignored_total",
      1,
      baseLabels(tenantId.trim(), "ignored_not_inbound"),
    );
    recordWhatsAppHttpMetrics(
      metrics,
      startNs,
      tenantId.trim(),
      "ignored_not_inbound",
    );
    res.status(200).send("ignored");
    return;
  }

  log.info(
    {
      event: "whatsapp_inbound_normalized",
      message_id: inbound.messageId,
      from_preview: inbound.externalUserId.slice(0, 8),
      text_preview: inbound.text.slice(0, 80),
    },
    "inbound normalized",
  );

  log.info(
    {
      event: "whatsapp_inbound_accepted",
      message_id: inbound.messageId,
      from_preview: inbound.externalUserId.slice(0, 8),
    },
    "inbound accepted before idempotency",
  );

  metrics.incrementCounter(
    "whatsapp_messages_inbound_total",
    1,
    baseLabels(inbound.tenantId, "inbound"),
  );

  const dedup = await services.idempotency.tryAcquire(
    inbound.tenantId,
    inbound.messageId,
    traceId,
  );

  if (dedup === "duplicate") {
    log.info(
      {
        event: "whatsapp_duplicate_ignored",
        message_id: inbound.messageId,
      },
      "duplicate webhook ignored",
    );
    metrics.incrementCounter(
      "whatsapp_duplicates_total",
      1,
      baseLabels(inbound.tenantId, "duplicate"),
    );
    recordWhatsAppHttpMetrics(metrics, startNs, inbound.tenantId, "duplicate");
    res.status(200).send("duplicate");
    return;
  }

  setSentryRequestContext({
    trace_id: traceId,
    tenant_id: inbound.tenantId,
  });

  const runLog = log.child({
    tenant_id: inbound.tenantId,
    message_id: inbound.messageId,
  });

  let leadIdForScope: string | undefined;

  try {
    const lead = await services.identityManager.resolveLead(
      inbound.externalUserId,
      inbound.tenantId,
      traceId,
    );

    leadIdForScope = lead.id;

    setSentryRequestContext({
      trace_id: traceId,
      tenant_id: inbound.tenantId,
      lead_id: lead.id,
    });

    const result = await services.orchestrator.process({
      tenantId: inbound.tenantId,
      leadId: lead.id,
      message: inbound.text,
      currentState: coerceFsmState(lead.fsm_state),
      traceId,
    });

    if (result.fsmPersisted === false) {
      captureInfraMessage("FSM state persist failed after orchestrator", {
        tags: {
          module: "whatsapp_handler",
          step: "orchestrator_fsm_persist",
        },
        extra: {
          trace_id: traceId,
          tenant_id: inbound.tenantId,
          lead_id: lead.id,
          persist_error:
            result.internalDiagnostics?.persistError ?? "unknown",
        },
        level: "error",
      });
    }

    runLog.info(
      {
        event: "whatsapp_orchestrator_completed",
        message_preview: result.messageToSend.slice(0, 80),
      },
      "orchestrator completed",
    );

    await services.sender.sendText({
      channel: "whatsapp",
      to: inbound.externalUserId,
      text: result.messageToSend,
      tenantId: inbound.tenantId,
      traceId,
    });

    metrics.incrementCounter(
      "whatsapp_outbound_messages_total",
      1,
      baseLabels(inbound.tenantId, "sent"),
    );
    recordWhatsAppHttpMetrics(metrics, startNs, inbound.tenantId, "ok");
    res.status(200).send("ok");
  } catch (err) {
    runLog.error(
      {
        event: "whatsapp_handler_error",
        error: err instanceof Error ? err.message : String(err),
      },
      "whatsapp handler error",
    );
    metrics.incrementCounter(
      "whatsapp_handler_errors_total",
      1,
      baseLabels(inbound.tenantId, "error"),
    );
    captureHandlerException(
      err,
      { module: "whatsapp_handler", step: "webhook_pipeline" },
      {
        trace_id: traceId,
        tenant_id: inbound.tenantId,
        lead_id: leadIdForScope,
      },
    );
    recordWhatsAppHttpMetrics(metrics, startNs, inbound.tenantId, "error");
    res.status(500).send("internal error");
  }
}
