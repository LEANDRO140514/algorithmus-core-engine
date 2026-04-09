import express, { type Request, type RequestHandler, type Response } from "express";
import { handleWhatsAppWebhook } from "../infra/handlers/whatsappHandler";

const app = express();

app.use(express.json());

function asyncHandler(
  fn: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    void fn(req, res).catch(next);
  };
}

app.post("/webhooks/whatsapp", asyncHandler(handleWhatsAppWebhook));

export default app;
