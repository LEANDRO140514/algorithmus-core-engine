/** HELP text for new metrics (documentation / Grafana). */
export const METRIC_HELP = {
  bullmq_queue_jobs:
    "BullMQ job counts by coarse state from Queue.getJobCounts (global per queue, not per tenant).",
} as const;

/** New metrics — source of truth for names introduced in observability phases. */
export const MetricName = {
  bullmq_queue_jobs: "bullmq_queue_jobs",
} as const;

export type NewMetricName = (typeof MetricName)[keyof typeof MetricName];

/**
 * Labels for bullmq_queue_jobs.
 * No tenant_id: getJobCounts() is not tenant-partitioned.
 */
export type BullmqQueueJobsLabels = {
  queue: string;
  state: "waiting" | "active" | "delayed" | "paused";
};
