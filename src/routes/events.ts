import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { authenticateApiKey } from '../middleware/authenticate-api-key.js';
import { asyncHandler } from '../utils/async-handler.js';

export const eventsRouter = Router();

const eventSchema = z.object({
  eventType: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/),
  payload: z.record(z.unknown()),
  metadata: z.record(z.unknown()).default({}),
}).strict();

eventsRouter.post(
  '/',
  authenticateApiKey,
  asyncHandler(async (req, res) => {
    const parsed = eventSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Provide a valid eventType and object payload.',
        },
      });
      return;
    }

    const idempotencyKey = req.header('idempotency-key');
    if (!idempotencyKey || idempotencyKey.length > 255 || idempotencyKey.trim() !== idempotencyKey) {
      res.status(400).json({
        error: {
          code: 'IDEMPOTENCY_KEY_REQUIRED',
          message: 'Provide an Idempotency-Key header up to 255 characters.',
        },
      });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query<{
        id: string;
        event_type: string;
        payload: Record<string, unknown>;
        metadata: Record<string, unknown>;
        created_at: Date;
        same_request?: boolean;
      }>(
        `INSERT INTO events (environment_id, event_type, payload, metadata, idempotency_key)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
         ON CONFLICT (environment_id, idempotency_key) DO NOTHING
         RETURNING id, event_type, payload, metadata, created_at`,
        [
          req.apiKeyEnvironmentId,
          parsed.data.eventType,
          JSON.stringify(parsed.data.payload),
          JSON.stringify(parsed.data.metadata),
          idempotencyKey,
        ],
      );

      if (inserted.rowCount) {
        const event = inserted.rows[0];
        if (!event) {
          throw new Error('Inserted event could not be read.');
        }
        await client.query(
          `INSERT INTO outbox_messages (topic, event_id, payload)
           VALUES ($1, $2, $3::jsonb)`,
          [
            'event.accepted',
            event.id,
            JSON.stringify({
              eventId: event.id,
              environmentId: req.apiKeyEnvironmentId,
              eventType: event.event_type,
            }),
          ],
        );
        await client.query('COMMIT');
        res.status(202).json({
          event: {
            id: event.id,
            type: event.event_type,
            createdAt: event.created_at
          }
        });
        return;
      }

      const existing = await client.query<{
        id: string;
        event_type: string;
        payload: Record<string, unknown>;
        metadata: Record<string, unknown>;
        created_at: Date;
        same_request?: boolean;
      }>(
        `SELECT id, event_type, payload, metadata, created_at,
           (event_type = $3 AND payload = $4::jsonb AND metadata = $5::jsonb) AS same_request
         FROM events
         WHERE environment_id = $1 AND idempotency_key = $2`,
        [req.apiKeyEnvironmentId, idempotencyKey, parsed.data.eventType, JSON.stringify(parsed.data.payload), JSON.stringify(parsed.data.metadata)],
      );
      const event = existing.rows[0];
      if (!event) {
        throw new Error('Idempotent event could not be read after conflict.');
      }

      if (!event.same_request) {
        await client.query('ROLLBACK');
        res.status(409).json({
          error: {
            code: 'IDEMPOTENCY_CONFLICT',
            message: 'This Idempotency-Key was already used with different event content.',
          },
        });
        return;
      }

      await client.query('COMMIT');
      res.status(200).json({
        event: {
          id: event.id,
          type: event.event_type,
          createdAt: event.created_at
        },
        duplicate: true,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }),
);
