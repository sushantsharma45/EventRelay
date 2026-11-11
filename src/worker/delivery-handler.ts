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
    `SELECT d.id, d.event_id, ev.event_type, ev.payload, ev.metadata, ev.created_at,
       ep.url, ep.signing_secret_enc
     FROM deliveries d
     JOIN events ev ON ev.id = d.event_id
     JOIN endpoints ep ON ep.id = d.endpoint_id
     WHERE d.event_id = $1 AND d.state IN ('pending', 'failed')
     ORDER BY d.created_at, d.id`,
    [eventId],
  );
  return result.rows;
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

async function recordDeliveryResult(
  delivery: DeliveryTarget,
  attemptNumber: number,
  startedAt: Date,
  statusCode: number | null,
  responseBody: string | null,
  errorMessage: string | null,
) {
  const durationMs = Date.now() - startedAt.getTime();
  const state = statusCode !== null && statusCode >= 200 && statusCode < 300 ? 'succeeded' : 'failed';
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
       SET state = $2, last_status = $3, last_error = $4, duration_ms = $5, updated_at = now()
       WHERE id = $1`,
      [delivery.id, state, statusCode, errorMessage, durationMs],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function deliverOne(delivery: DeliveryTarget) {
  const startedAt = new Date();
  const started = await pool.query<{ attempt_count: number }>(
    `UPDATE deliveries
     SET state = 'processing', attempt_count = attempt_count + 1, updated_at = now()
     WHERE id = $1 AND state IN ('pending', 'failed')
     RETURNING attempt_count`,
    [delivery.id],
  );
  if (!started.rowCount) return null;

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
    started.rows[0]?.attempt_count ?? 1,
    startedAt,
    statusCode,
    responseBody,
    errorMessage,
  );

  if (statusCode === null || statusCode < 200 || statusCode >= 300) {
    return errorMessage ?? 'Webhook endpoint returned HTTP ' + statusCode + '.';
  }
  return null;
}

export async function processEvent(eventId: string) {
  const deliveries = await loadDeliveries(eventId);
  const errors: string[] = [];
  for (const delivery of deliveries) {
    const error = await deliverOne(delivery);
    if (error) errors.push(delivery.id + ': ' + error);
  }
  if (errors.length) throw new Error(errors.join('; '));
  logger.info({ eventId, deliveryCount: deliveries.length }, 'Event delivery job completed');
}