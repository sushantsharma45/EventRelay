import crypto from 'node:crypto';
import type { RequestHandler } from 'express';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../utils/async-handler.js';

declare global {
  namespace Express {
    interface Request {
      apiKeyEnvironmentId?: string;
      apiKeyId?: string;
    }
  }
}

export const authenticateApiKey: RequestHandler = asyncHandler(async (req, res, next) => {
  const match = req.header('authorization')?.match(/^Bearer\s+(er_live_[A-Za-z0-9_-]+)$/);
  const secret = match?.[1];
  if (!secret) {
    res.status(401).json({
      error: {
        code: 'INVALID_API_KEY',
        message: 'A valid API key is required.'
      }
    });
    return;
  }

  const hash = crypto.createHash('sha256').update(secret).digest('hex');
  const result = await pool.query<{ id: string; environment_id: string }>(
    `UPDATE api_keys
     SET last_used_at = now()
     WHERE secret_hash = $1 AND revoked_at IS NULL
     RETURNING id, environment_id`,
    [hash],
  );
  
  const key = result.rows[0];
  if (!key) {
    res.status(401).json({
      error: {
        code: 'INVALID_API_KEY',
        message: 'A valid API key is required.'
      }
    });
    return;
  }

  req.apiKeyId = key.id;
  req.apiKeyEnvironmentId = key.environment_id;
  next();
});
