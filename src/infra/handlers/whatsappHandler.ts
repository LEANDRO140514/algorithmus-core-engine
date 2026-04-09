import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import pino, { type Logger } from "pino";
import type { FSMState } from "../../core/fsm/FSMEngine";
import type { IdentityManager } from "../../core/identity/IdentityManager";
import type { Orchestrator } from "../../core/orchestrator/Orchestrator";

export const baseLogger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  name: "algorithmus-api",
});

export type WhatsAppHandlerServices = {
  identityManager: IdentityManager;
  orchestrator: Orchestrator;
};

let handlerServices: WhatsAppHandlerServices | null = null;

/** Debe llamarse antes de aceptar tráfico (p. ej. al arrancar el servidor). */
export function configureWhatsAppHandler(services: WhatsAppHandlerServices): void {
  handlerServices = services;
}

type YCloudWhatsAppBody = {
  from?: string;
  text?: { body?: string };
};

function readWebhookBody(req: Request): YCloudWhatsAppBody {
  const b: unknown = req.body;
  if (b !== null && typeof b === "object") {
    return b as YCloudWhatsAppBody;
  }
  return {};
}

function readTenantIdHeader(req: Request): string | undefined {
  const raw = req.headers["x-tenant-id"];
  if (Array.isArray(raw)) {
    return typeof raw[0] === "string" ? raw[0].trim() : undefined;
  }
  return typeof raw === "string" ? raw.trim() : undefined;
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

async function sendWhatsAppMessage(
  to: string,
  text: string,
  log: Logger,
): Promise<void> {
  log.info(
    {
      step: "whatsapp_send_mock",
      to,
      preview: text.slice(0, 50),
      length: text.length,
    },
    "whatsapp send mock",
  );
}

export async function handleWhatsAppWebhook(
  req: Request,
  res: Response,
): Promise<void> {
  const body = readWebhookBody(req);
  const phone = body.from;
  const message = body.text?.body;
  const tenantId = readTenantIdHeader(req);

  if (
    typeof phone !== "string" ||
    !phone.trim() ||
    typeof message !== "string" ||
    !message.trim() ||
    typeof tenantId !== "string" ||
    !tenantId.trim()
  ) {
    res.status(400).send("invalid request");
    return;
  }

  const traceId = randomUUID();

  const log = baseLogger.child({
    module: "WhatsAppHandler",
    trace_id: traceId,
    tenant_id: tenantId,
  });

  log.info(
    {
      step: "whatsapp_incoming",
      phone,
      messageLength: message.length,
    },
    "whatsapp incoming",
  );

  const services = handlerServices;
  if (!services) {
    log.error({ step: "whatsapp_handler_misconfigured" }, "handler sin servicios");
    res.status(503).send("service unavailable");
    return;
  }

  try {
    const lead = await services.identityManager.resolveLead(
      phone.trim(),
      tenantId.trim(),
      traceId,
    );

    const result = await services.orchestrator.process({
      tenantId: tenantId.trim(),
      leadId: lead.id,
      message: message.trim(),
      currentState: coerceFsmState(lead.fsm_state),
      traceId,
    });

    await sendWhatsAppMessage(phone.trim(), result.messageToSend, log);

    res.status(200).send("ok");
  } catch (err) {
    log.error(
      {
        step: "whatsapp_handler_error",
        error: err instanceof Error ? err.message : String(err),
      },
      "whatsapp handler error",
    );
    res.status(500).send("internal error");
  }
}
