import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { pool } from '../db/pool.js';
import { logger } from '../logger.js';
import { processDelivery, processEvent } from './delivery-handler.js';
import {
  workerActiveJobs,
  workerJobsTotal,
  workerOutboxPublishedTotal,
  workerRecoveryTotal,
  workerRetryQueuedTotal,
  workerSchedulerErrorsTotal,
} from '../observability/metrics.js';
import { createMetricsServer } from '../observability/metrics-server.js';

interface DeliveryJob {
  eventId?: string;
  deliveryId?: string;
}

const queueName = 'eventrelay-deliveries';
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue<DeliveryJob>(queueName, { connection });
const commonJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: { age: 86400, count: 10000 },
  removeOnFail: false,
};

async function publishOutboxBatch() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const messages = await client.query<{
      id: string;
      event_id: string | null;
      topic: string;
      payload: { deliveryId?: string };
    }>(
      `SELECT id, event_id, topic, payload
       FROM outbox_messages
       WHERE published_at IS NULL
         AND topic IN ('event.accepted', 'delivery.replay')
       ORDER BY created_at, id
       LIMIT 25
       FOR UPDATE SKIP LOCKED`,
    );

    for (const message of messages.rows) {
      if (message.topic === 'event.accepted' && message.event_id) {
        await queue.add(
          'dispatch-event',
          { eventId: message.event_id },
          { ...commonJobOptions, jobId: 'outbox-' + message.id },
        );
      } else if (message.topic === 'delivery.replay' && message.payload.deliveryId) {
        await queue.add(
          'dispatch-delivery',
          { deliveryId: message.payload.deliveryId },
          { ...commonJobOptions, jobId: 'outbox-' + message.id },
        );
      } else {
        logger.error({ outboxId: message.id, topic: message.topic }, 'Unsupported outbox message was skipped');
        await client.query('UPDATE outbox_messages SET published_at = now() WHERE id = $1', [message.id]);
        continue;
      }
      await client.query(
        'UPDATE outbox_messages SET published_at = now(), attempts = attempts + 1 WHERE id = $1',
        [message.id],
      );
    }

    await client.query('COMMIT');
    const publishedCount = messages.rowCount ?? 0;
    workerOutboxPublishedTotal.inc(publishedCount);
    return publishedCount;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function queueDueRetries() {
  const result = await pool.query<{ id: string; attempt_count: number }>(
    `SELECT id, attempt_count
     FROM deliveries
     WHERE state = 'retrying' AND next_attempt_at <= now()
     ORDER BY next_attempt_at, id
     LIMIT 100`,
  );

  for (const delivery of result.rows) {
    const jobId = 'delivery-' + delivery.id + '-' + (delivery.attempt_count + 1);
    const existing = await queue.getJob(jobId);
    if (existing && await existing.getState() === 'failed') {
      await existing.remove();
    }
    await queue.add(
      'dispatch-delivery',
      { deliveryId: delivery.id },
      { ...commonJobOptions, jobId },
    );
  }
  const queuedCount = result.rowCount ?? 0;
  workerRetryQueuedTotal.inc(queuedCount);
  return queuedCount;
}

async function recoverStuckDeliveries() {
  const recovered = await pool.query<{ id: string }>(
    `UPDATE deliveries
     SET state = CASE WHEN attempt_count >= 8 THEN 'dead_lettered'::delivery_state ELSE 'retrying'::delivery_state END,
     next_attempt_at = now(),
     dead_lettered_at = CASE WHEN attempt_count >= 8 THEN now() ELSE NULL END,
     last_error = 'Worker stopped before recording the delivery result.',
     updated_at = now()
     WHERE state = 'processing' AND updated_at < now() - interval '2 minutes'
     RETURNING id`,
  );

  if (recovered.rowCount) {
    workerRecoveryTotal.inc(recovered.rowCount);
    logger.warn({ count: recovered.rowCount }, 'Stuck deliveries recovered');
  }
}

workerActiveJobs.set(0);

const worker = new Worker<DeliveryJob>(
  queueName,
  async (job: Job<DeliveryJob>) => {
    if (job.data.eventId) return processEvent(job.data.eventId);
    if (job.data.deliveryId) return processDelivery(job.data.deliveryId);
    throw new Error('Delivery job did not include an event or delivery ID.');
  },
  { connection, concurrency: 10 },
);

worker.on('active', () => {
  workerActiveJobs.inc();
});
worker.on('completed', (job) => {
  workerActiveJobs.dec();
  workerJobsTotal.inc({ name: job.name, result: 'completed' });
  logger.info({ jobId: job.id }, 'Delivery job completed');
});
worker.on('failed', (job, error) => {
  workerActiveJobs.dec();
  workerJobsTotal.inc({ name: job?.name ?? 'unknown', result: 'failed' });
  logger.error({ jobId: job?.id, err: error }, 'Delivery job failed');
});

let polling = false;
let recoveryRunAt = 0;
const pollTimer = setInterval(async () => {
  if (polling) return;
  polling = true;
  try {
    const outboxCount = await publishOutboxBatch();
    const retryCount = await queueDueRetries();
    if (outboxCount || retryCount) {
      logger.info({ outboxCount, retryCount }, 'Delivery jobs queued');
    }
    if (Date.now() - recoveryRunAt >= 30000) {
      await recoverStuckDeliveries();
      recoveryRunAt = Date.now();
    }
  } catch (error) {
    workerSchedulerErrorsTotal.inc();
    logger.error({ err: error }, 'Delivery scheduling failed');
  } finally {
    polling = false;
  }
}, 1000);

const metricsServer = createMetricsServer();
metricsServer.listen(env.WORKER_METRICS_PORT, env.METRICS_HOST, () =>
  logger.info({ host: env.METRICS_HOST, port: env.WORKER_METRICS_PORT }, 'Worker metrics listener started'),
);

logger.info({ queue: queueName }, 'EventRelay delivery worker started');

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(pollTimer);
  logger.info({ signal }, 'Delivery worker shutdown started');
  await new Promise<void>((resolve, reject) =>
    metricsServer.close((error) => (error ? reject(error) : resolve())),
  );
  await worker.close();
  await queue.close();
  await connection.quit();
  await pool.end();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));