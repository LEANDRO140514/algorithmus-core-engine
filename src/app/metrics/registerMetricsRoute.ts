import type { Express, RequestHandler } from "express";
import type { PrometheusMetrics } from "../../infra/observability/metrics/PrometheusMetrics";

export function registerMetricsRoute(
  app: Express,
  prometheus: PrometheusMetrics,
): void {
  const handler: RequestHandler = async (_req, res, next) => {
    try {
      res.setHeader("Content-Type", prometheus.contentType);
      res.end(await prometheus.metrics());
    } catch (err) {
      next(err);
    }
  };
  app.get("/metrics", handler);
}
