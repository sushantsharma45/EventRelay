import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { authenticate } from '../middleware/authenticate.js';
import { loadOrganization, requireOrganizationRole, } from '../middleware/organization-access.js';
import { asyncHandler } from '../utils/async-handler.js';

export const organizationsRouter = Router();

const roleSchema = z.enum(['admin', 'developer', 'viewer']);
const organizationSchema = z.object({
  name: z.string().trim().min(2).max(100),
});
const memberSchema = z.object({
  email: z.string().trim().email().max(254),
  role: roleSchema,
});
const memberRoleSchema = z.object({
  role: roleSchema,
});

organizationsRouter.use(authenticate);

organizationsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT o.id, o.name, o.slug, m.role
       FROM organizations o
       JOIN memberships m ON m.organization_id = o.id
       WHERE m.user_id = $1
       ORDER BY o.created_at`,
      [req.authUser?.id],
    );

    res.json({ data: result.rows });
  }),
);

organizationsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = organizationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message ?? 'Enter a valid organization name.',
        },
      });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const slug = parsed.data.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40) + '-' + crypto.randomUUID().slice(0, 8);
      const organization = (await client.query(
        `INSERT INTO organizations (name, slug)
         VALUES ($1, $2)
         RETURNING id, name, slug, created_at`,
        [parsed.data.name, slug],
      )).rows[0];

      await client.query(
        `INSERT INTO memberships (organization_id, user_id, role)
         VALUES ($1, $2, $3)`,
        [organization.id, req.authUser?.id, 'owner'],
      );
      await client.query('COMMIT');

      res.status(201).json({
        organization: { ...organization, role: 'owner' },
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }),
);

organizationsRouter.post(
  '/:organizationId/members',
  loadOrganization,
  requireOrganizationRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const parsed = memberSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Enter a valid email and member role.',
        },
      });
      return;
    }

    if (req.organizationRole === 'admin' && parsed.data.role === 'admin') {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'Only owners can grant admin access.',
        },
      });
      return;
    }

    const user = await pool.query<{
      id: string;
      name: string;
      email: string;
    }>(
      `SELECT id, name, email
       FROM users
       WHERE email = $1`,
      [parsed.data.email.toLowerCase()],
    );
    const newMember = user.rows[0];

    if (!newMember) {
      res.status(404).json({
        error: {
          code: 'USER_NOT_FOUND',
          message: 'Create an account before adding this member.',
        },
      });
      return;
    }

    const membership = await pool.query(
      `INSERT INTO memberships (organization_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING role`,
      [req.organizationId, newMember.id, parsed.data.role],
    );

    if (!membership.rowCount) {
      res.status(409).json({
        error: {
          code: 'MEMBER_EXISTS',
          message: 'This user is already a member.',
        },
      });
      return;
    }

    res.status(201).json({
      member: { ...newMember, role: membership.rows[0].role },
    });
  }),
);

organizationsRouter.get(
  '/:organizationId/members',
  loadOrganization,
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT u.id, u.name, u.email, m.role, m.created_at AS joined_at
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.organization_id = $1
       ORDER BY m.created_at`,
      [req.organizationId],
    );

    res.json({ data: result.rows });
  }),
);

organizationsRouter.patch(
  '/:organizationId/members/:userId',
  loadOrganization,
  requireOrganizationRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const parsed = memberRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Role must be admin, developer, or viewer.',
        },
      });
      return;
    }

    if (req.organizationRole === 'admin' && parsed.data.role === 'admin') {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'Only owners can grant admin access.',
        },
      });
      return;
    }

    const target = await pool.query<{ role: string }>(
      `SELECT role
       FROM memberships
       WHERE organization_id = $1 AND user_id = $2`,
      [req.organizationId, req.params.userId],
    );
    const targetMember = target.rows[0];

    if (!targetMember || targetMember.role === 'owner') {
      res.status(404).json({
        error: {
          code: 'MEMBER_NOT_FOUND',
          message: 'Member not found.',
        },
      });
      return;
    }

    if (req.organizationRole === 'admin' && targetMember.role === 'admin') {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'Admins cannot modify other admins.',
        },
      });
      return;
    }

    const updated = await pool.query(
      `UPDATE memberships
       SET role = $3
       WHERE organization_id = $1 AND user_id = $2
       RETURNING user_id, role`,
      [req.organizationId, req.params.userId, parsed.data.role],
    );

    res.json({ member: updated.rows[0] });
  }),
);

organizationsRouter.delete(
  '/:organizationId/members/:userId',
  loadOrganization,
  requireOrganizationRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const target = await pool.query<{ role: string }>(
      `SELECT role
       FROM memberships
       WHERE organization_id = $1 AND user_id = $2`,
      [req.organizationId, req.params.userId],
    );
    const targetMember = target.rows[0];

    if (!targetMember || targetMember.role === 'owner') {
      res.status(404).json({
        error: {
          code: 'MEMBER_NOT_FOUND',
          message: 'Member not found.',
        },
      });
      return;
    }

    if (req.organizationRole === 'admin' && targetMember.role === 'admin') {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'Admins cannot remove other admins.',
        },
      });
      return;
    }

    await pool.query(
      `DELETE FROM memberships
       WHERE organization_id = $1 AND user_id = $2`,
      [req.organizationId, req.params.userId],
    );

    res.status(204).end();
  }),
);