import * as prometheus from '@prometheus-io/client';

export const registry = new prometheus.Registry();
registry.setDefaultLabels({ service: 'eventrelay' });
prometheus.collectDefaultMetrics({ register: registry });

export const httpRequestsTotal = new prometheus.Counter({
  name: 'eventrelay_http_requests_total',
  help: 'Completed API requests grouped by method, route template and status code.',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [registry],
});

export const httpRequestDurationSeconds = new prometheus.Histogram({
  name: 'eventrelay_http_request_duration_seconds',
  help: 'API request duration in seconds grouped by method and route template.',
  labelNames: ['method', 'route'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const workerJobsTotal = new prometheus.Counter({
  name: 'eventrelay_worker_jobs_total',
  help: 'Worker job processing outcomes grouped by job name and result.',
  labelNames: ['name', 'result'] as const,
  registers: [registry],
});

export const workerActiveJobs = new prometheus.Gauge({
  name: 'eventrelay_worker_active_jobs',
  help: 'Number of delivery jobs currently being processed.',
  registers: [registry],
});

export const workerOutboxPublishedTotal = new prometheus.Counter({
  name: 'eventrelay_worker_outbox_published_total',
  help: 'Number of durable outbox messages submitted to BullMQ.',
  registers: [registry],
});

export const workerRetryQueuedTotal = new prometheus.Counter({
  name: 'eventrelay_worker_retries_queued_total',
  help: 'Number of due retry deliveries queued by the worker.',
  registers: [registry],
});

export const workerRecoveryTotal = new prometheus.Counter({
  name: 'eventrelay_worker_deliveries_recovered_total',
  help: 'Number of processing deliveries recovered after a worker interruption.',
  registers: [registry],
});

export const workerSchedulerErrorsTotal = new prometheus.Counter({
  name: 'eventrelay_worker_scheduler_errors_total',
  help: 'Number of errors while publishing outbox messages or scheduling retries.',
  registers: [registry],
});

export const workerDeliveryAttemptsTotal = new prometheus.Counter({
  name: 'eventrelay_worker_delivery_attempts_total',
  help: 'Webhook delivery attempts grouped by their durable final state.',
  labelNames: ['state'] as const,
  registers: [registry],
});

export const workerDeliveryDurationSeconds = new prometheus.Histogram({
  name: 'eventrelay_worker_delivery_duration_seconds',
  help: 'Time spent on webhook delivery attempts grouped by their durable final state.',
  labelNames: ['state'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});
