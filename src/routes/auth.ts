import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { env } from '../config/env.js';
import { authenticate } from '../middleware/authenticate.js';
import { asyncHandler } from '../utils/async-handler.js';

export const authRouter = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many authentication attempts. Try again later.',
    },
  },
});

const registrationPassword = z
  .string()
  .min(12)
  .max(72)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 72);
const loginPassword = z
  .string()
  .min(1)
  .max(72)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 72);

const registerSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(254),
  password: registrationPassword,
});

const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: loginPassword,
});

function issueToken(user: { id: string; email: string }) {
  return jwt.sign({ email: user.email }, env.JWT_SECRET, {
    algorithm: 'HS256',
    subject: user.id,
    issuer: 'eventrelay',
    audience: 'eventrelay-api',
    expiresIn: '8h',
  });
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'workspace';
}

authRouter.post(
  '/register',
  authLimiter,
  asyncHandler(async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message ?? 'Check the submitted fields.',
        },
      });
      return;
    }

    const email = parsed.data.email.toLowerCase();
    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      const user = (await client.query(
        `INSERT INTO users (name, email, password_hash)
         VALUES ($1, $2, $3)
         RETURNING id, name, email, created_at`,
        [parsed.data.name, email, passwordHash],
      )).rows[0];
      const organization = (await client.query(
        `INSERT INTO organizations (name, slug)
         VALUES ($1, $2)
         RETURNING id, name, slug, created_at`,
        [
          parsed.data.name + String.fromCharCode(39) + 's workspace',
          slugify(parsed.data.name) + '-' + user.id.slice(0, 8),
        ],
      )).rows[0];

      await client.query(
        `INSERT INTO memberships (organization_id, user_id, role)
         VALUES ($1, $2, $3)`,
        [organization.id, user.id, 'owner'],
      );
      await client.query(
        `INSERT INTO audit_log (organization_id, actor_id, action, resource_type, resource_id, details)
         VALUES ($1, $2, 'account.registered', 'organization', $1, '{}'::jsonb)`,
        [organization.id, user.id],
      );
      await client.query('COMMIT');

      res.status(201).json({
        token: issueToken(user),
        user: { id: user.id, name: user.name, email: user.email },
        organization: {
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          role: 'owner',
        },
      });
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error as { code?: string }).code === '23505') {
        res.status(409).json({
          error: {
            code: 'EMAIL_IN_USE',
            message: 'An account with this email already exists.',
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

authRouter.post(
  '/login',
  authLimiter,
  asyncHandler(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Enter a valid email and password.',
        },
      });
      return;
    }

    const result = await pool.query<{
      id: string;
      name: string;
      email: string;
      password_hash: string;
    }>(
      `SELECT id, name, email, password_hash
       FROM users
       WHERE email = $1`,
      [parsed.data.email.toLowerCase()],
    );
    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(parsed.data.password, user.password_hash))) {
      res.status(401).json({
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Email or password is incorrect.',
        },
      });
      return;
    }

    const organizations = await pool.query(
      `SELECT o.id, o.name, o.slug, m.role
       FROM organizations o
       JOIN memberships m ON m.organization_id = o.id
       WHERE m.user_id = $1
       ORDER BY o.created_at`,
      [user.id],
    );

    res.status(200).json({
      token: issueToken(user),
      user: { id: user.id, name: user.name, email: user.email },
      organizations: organizations.rows,
    });
  }),
);

authRouter.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT id, name, email, created_at
       FROM users
       WHERE id = $1`,
      [req.authUser?.id],
    );

    if (!result.rowCount) {
      res.status(401).json({
        error: {
          code: 'ACCOUNT_NOT_FOUND',
          message: 'This account is no longer available.',
        },
      });
      return;
    }

    res.json({ user: result.rows[0] });
  }),
);