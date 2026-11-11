import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { pool } from '../db/pool.js';
import { logger } from '../logger.js';
import { processEvent } from './delivery-handler.js';

interface DispatchEventJob {
  eventId: string;
}

const queueName = 'eventrelay-deliveries';
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue<DispatchEventJob>(queueName, { connection });

async function publishOutboxBatch() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const messages = await client.query<{ id: string; event_id: string }>(
      `SELECT id, event_id
       FROM outbox_messages
       WHERE published_at IS NULL AND topic = 'event.accepted' AND event_id IS NOT NULL
       ORDER BY created_at, id
       LIMIT 25
       FOR UPDATE SKIP LOCKED`,
    );

    for (const message of messages.rows) {
      await queue.add(
        'dispatch-event',
        { eventId: message.event_id },
        {
          jobId: 'outbox-' + message.id,
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: { age: 86400, count: 10000 },
          removeOnFail: false,
        },
      );
      await client.query(
        'UPDATE outbox_messages SET published_at = now(), attempts = attempts + 1 WHERE id = $1',
        [message.id],
      );
    }

    await client.query('COMMIT');
    return messages.rowCount ?? 0;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const worker = new Worker<DispatchEventJob>(
  queueName,
  async (job: Job<DispatchEventJob>) => processEvent(job.data.eventId),
  { connection, concurrency: 10 },
);

worker.on('completed', (job) => {
  logger.info({ jobId: job.id }, 'Delivery job completed');
});
worker.on('failed', (job, error) => {
  logger.error({ jobId: job?.id, err: error }, 'Delivery job failed');
});

let publishing = false;
const pollTimer = setInterval(async () => {
  if (publishing) return;
  publishing = true;
  try {
    const count = await publishOutboxBatch();
    if (count > 0) logger.info({ count }, 'Outbox messages queued');
  } catch (error) {
    logger.error({ err: error }, 'Outbox polling failed');
  } finally {
    publishing = false;
  }
}, 1000);

logger.info({ queue: queueName }, 'EventRelay delivery worker started');

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(pollTimer);
  logger.info({ signal }, 'Delivery worker shutdown started');
  await worker.close();
  await queue.close();
  await connection.quit();
  await pool.end();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));