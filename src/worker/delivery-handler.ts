import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import { logger } from '../logger.js';
import { decryptSecret } from '../utils/resource-secrets.js';
import { validateDeliveryUrl } from '../utils/webhook-url.js';

interface DeliveryTarget {
  id: string;
  event_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: Date;
  url: string;
  signing_secret_enc: string;
}

const maxAttempts = 8;
const retryBaseSeconds = 2;
const retryMaxSeconds = 60 * 60;

async function loadDeliveries(eventId: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO deliveries (event_id, endpoint_id)
       SELECT ev.id, ep.id
       FROM events ev
       JOIN endpoints ep ON ep.environment_id = ev.environment_id AND ep.active = true
       JOIN subscriptions sub ON sub.endpoint_id = ep.id AND sub.event_type = ev.event_type
       WHERE ev.id = $1
       ON CONFLICT (event_id, endpoint_id) WHERE replay_of IS NULL DO NOTHING`,
      [eventId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const result = await pool.query<DeliveryTarget>(
    `SELECT d.id, d.event_id, ev.event_type, ev.payload, ev.metadata, ev.created_at, ep.url, ep.signing_secret_enc
     FROM deliveries d
     JOIN events ev ON ev.id = d.event_id
     JOIN endpoints ep ON ep.id = d.endpoint_id
     WHERE d.event_id = $1 AND d.state IN ('pending', 'retrying', 'failed') AND d.next_attempt_at <= now()
     ORDER BY d.created_at, d.id`,
    [eventId],
  );
  return result.rows;
}

async function loadDelivery(deliveryId: string) {
  const result = await pool.query<DeliveryTarget>(
    `SELECT d.id, d.event_id, ev.event_type, ev.payload, ev.metadata, ev.created_at, ep.url, ep.signing_secret_enc
     FROM deliveries d
     JOIN events ev ON ev.id = d.event_id
     JOIN endpoints ep ON ep.id = d.endpoint_id
     WHERE d.id = $1`,
    [deliveryId],
  );
  return result.rows[0];
}

async function readResponseBody(response: Response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = '';
  try {
    while (body.length < 16000) {
      const { done, value } = await reader.read();
      if (done) break;
      body += decoder.decode(value, { stream: true }).slice(0, 16000 - body.length);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return body;
}

function isRetryable(statusCode: number | null) {
  return statusCode === null || statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

async function recordDeliveryResult(
  delivery: DeliveryTarget,
  attemptNumber: number,
  startedAt: Date,
  statusCode: number | null,
  responseBody: string | null,
  errorMessage: string | null,
) {
  const durationMs = Date.now() - startedAt.getTime();
  const succeeded = statusCode !== null && statusCode >= 200 && statusCode < 300;
  const deadLettered = !succeeded && (!isRetryable(statusCode) || attemptNumber >= maxAttempts);
  const state = succeeded ? 'succeeded' : deadLettered ? 'dead_lettered' : 'retrying';
  const retrySeconds = Math.min(retryBaseSeconds * (2 ** Math.max(attemptNumber - 1, 0)), retryMaxSeconds);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO delivery_attempts
         (delivery_id, attempt_number, response_status, response_body, error, duration_ms, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [delivery.id, attemptNumber, statusCode, responseBody, errorMessage, durationMs, startedAt],
    );
    await client.query(
      `UPDATE deliveries
       SET state = $2::delivery_state,
         last_status = $3,
         last_error = $4,
         duration_ms = $5,
         next_attempt_at = CASE WHEN $2 = 'retrying' THEN now() + ($6 * interval '1 second') ELSE next_attempt_at END,
         dead_lettered_at = CASE WHEN $2 = 'dead_lettered' THEN now() ELSE NULL END,
         updated_at = now()
       WHERE id = $1`,
      [delivery.id, state, statusCode, errorMessage, durationMs, retrySeconds],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  if (deadLettered) {
    logger.warn({ deliveryId: delivery.id, attemptNumber, statusCode }, 'Delivery moved to dead letter state');
  }
}

async function deliverOne(delivery: DeliveryTarget) {
  const startedAt = new Date();
  const started = await pool.query<{ attempt_count: number }>(
    `UPDATE deliveries
     SET state = 'processing', attempt_count = attempt_count + 1, updated_at = now()
     WHERE id = $1 AND state IN ('pending', 'retrying', 'failed') AND next_attempt_at <= now()
     RETURNING attempt_count`,
    [delivery.id],
  );

  const attemptNumber = started.rows[0]?.attempt_count;
  if (!attemptNumber) return;

  let statusCode: number | null = null;
  let responseBody: string | null = null;
  let errorMessage: string | null = null;

  try {
    const url = await validateDeliveryUrl(delivery.url);
    const body = JSON.stringify({
      id: delivery.event_id,
      type: delivery.event_type,
      payload: delivery.payload,
      metadata: delivery.metadata,
      createdAt: delivery.created_at,
    });

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signingSecret = decryptSecret(delivery.signing_secret_enc);

    const signature = crypto
      .createHmac('sha256', signingSecret)
      .update(timestamp + '.' + body)
      .digest('hex');

    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'EventRelay/1.0',
        'x-eventrelay-event-id': delivery.event_id,
        'x-eventrelay-event-type': delivery.event_type,
        'x-eventrelay-timestamp': timestamp,
        'x-eventrelay-signature': 't=' + timestamp + ',v1=' + signature,
      },
      body,
      signal: AbortSignal.timeout(10000),
    });
    
    statusCode = response.status;
    responseBody = await readResponseBody(response);
    if (!response.ok) {
      errorMessage = 'Webhook endpoint returned HTTP ' + response.status + '.';
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : 'Webhook delivery failed.';
  }

  await recordDeliveryResult(
    delivery,
    attemptNumber,
    startedAt,
    statusCode,
    responseBody,
    errorMessage,
  );
}

export async function processEvent(eventId: string) {
  const deliveries = await loadDeliveries(eventId);
  for (const delivery of deliveries) {
    await deliverOne(delivery);
  }
  logger.info({ eventId, deliveryCount: deliveries.length }, 'Event delivery job completed');
}

export async function processDelivery(deliveryId: string) {
  const delivery = await loadDelivery(deliveryId);
  if (!delivery) return;
  await deliverOne(delivery);
}