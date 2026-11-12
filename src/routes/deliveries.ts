import { Router } from 'express';
import { pool } from '../db/pool.js';
import { authenticate } from '../middleware/authenticate.js';
import { loadOrganization, requireOrganizationRole } from '../middleware/organization-access.js';
import { asyncHandler } from '../utils/async-handler.js';

export const deliveriesRouter = Router({ mergeParams: true });
deliveriesRouter.use(authenticate, loadOrganization);

const adminRoles = requireOrganizationRole('owner', 'admin', 'developer');

deliveriesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const state = typeof req.query.state === 'string' ? req.query.state : null;
    const allowedStates = ['pending', 'processing', 'retrying', 'succeeded', 'failed', 'dead_lettered'];
    if (state && !allowedStates.includes(state)) {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Unknown delivery state.' },
      });
      return;
    }

    const result = await pool.query(
      `SELECT d.id, d.event_id, d.endpoint_id, d.state, d.attempt_count,
         d.next_attempt_at, d.last_status, d.last_error, d.dead_lettered_at,
         d.created_at, d.updated_at, ev.event_type, ep.url AS endpoint_url
       FROM deliveries d
       JOIN events ev ON ev.id = d.event_id
       JOIN environments env ON env.id = ev.environment_id
       JOIN projects p ON p.id = env.project_id
       JOIN endpoints ep ON ep.id = d.endpoint_id
       WHERE p.organization_id = $1 AND ($2::text IS NULL OR d.state::text = $2)
       ORDER BY d.updated_at DESC, d.id
       LIMIT $3 OFFSET $4`,
      [req.organizationId, state, limit, offset],
    );
    res.json({ data: result.rows, pagination: { limit, offset } });
  }),
);

deliveriesRouter.get(
  '/:deliveryId/attempts',
  asyncHandler(async (req, res) => {
    const delivery = await pool.query(
      `SELECT d.id
       FROM deliveries d
       JOIN events ev ON ev.id = d.event_id
       JOIN environments env ON env.id = ev.environment_id
       JOIN projects p ON p.id = env.project_id
       WHERE p.organization_id = $1 AND d.id = $2`,
      [req.organizationId, req.params.deliveryId],
    );
    if (!delivery.rowCount) {
      res.status(404).json({
        error: { code: 'DELIVERY_NOT_FOUND', message: 'Delivery not found.' },
      });
      return;
    }

    const attempts = await pool.query(
      `SELECT id, attempt_number, request_id, response_status, response_body,
         error, duration_ms, started_at, completed_at
       FROM delivery_attempts
       WHERE delivery_id = $1
       ORDER BY attempt_number`,
      [req.params.deliveryId],
    );
    res.json({ data: attempts.rows });
  }),
);

deliveriesRouter.post(
  '/:deliveryId/replay',
  adminRoles,
  asyncHandler(async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const original = await client.query<{
        id: string;
        event_id: string;
        endpoint_id: string;
        state: string;
      }>(
        `SELECT d.id, d.event_id, d.endpoint_id, d.state
         FROM deliveries d
         JOIN events ev ON ev.id = d.event_id
         JOIN environments env ON env.id = ev.environment_id
         JOIN projects p ON p.id = env.project_id
         WHERE p.organization_id = $1 AND d.id = $2
         FOR UPDATE OF d`,
        [req.organizationId, req.params.deliveryId],
      );
      const delivery = original.rows[0];
      if (!delivery) {
        await client.query('ROLLBACK');
        res.status(404).json({
          error: { code: 'DELIVERY_NOT_FOUND', message: 'Delivery not found.' },
        });
        return;
      }
      if (!['failed', 'dead_lettered'].includes(delivery.state)) {
        await client.query('ROLLBACK');
        res.status(409).json({
          error: {
            code: 'DELIVERY_NOT_REPLAYABLE',
            message: 'Only failed or dead-lettered deliveries can be replayed.',
          },
        });
        return;
      }

      const replay = await client.query<{ id: string }>(
        `INSERT INTO deliveries (event_id, endpoint_id, replay_of)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [delivery.event_id, delivery.endpoint_id, delivery.id],
      );
      const replayDeliveryId = replay.rows[0]?.id;
      if (!replayDeliveryId) throw new Error('Replay delivery could not be created.');
      await client.query(
        `INSERT INTO outbox_messages (topic, payload)
         VALUES ('delivery.replay', $1::jsonb)`,
        [JSON.stringify({ deliveryId: replayDeliveryId, eventId: delivery.event_id })],
      );
      await client.query('COMMIT');
      res.status(202).json({ deliveryId: replayDeliveryId, state: 'pending' });
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error as { code?: string }).code === '23505') {
        res.status(409).json({
          error: {
            code: 'REPLAY_ALREADY_EXISTS',
            message: 'This delivery has already been replayed.',
          },
        });
        return;
      }
      throw error;
    } finally {
      client.release();
    }
  }),
);