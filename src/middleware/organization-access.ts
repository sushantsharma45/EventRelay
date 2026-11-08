import type { RequestHandler } from 'express';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../utils/async-handler.js';

export const loadOrganization: RequestHandler = asyncHandler(async (req, res, next) => {
  const organizationId = req.params.organizationId;

  if (!organizationId || Array.isArray(organizationId)) {
    res.status(404).json({
      error: {
        code: 'ORGANIZATION_NOT_FOUND',
        message: 'Organization not found.'
      }
    });
    return;
  }

  const membership = await pool.query<{ role: string }>(
    'SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2',
    [organizationId, req.authUser?.id],
  );

  if (!membership.rowCount) {
    res.status(404).json({
      error: {
        code: 'ORGANIZATION_NOT_FOUND',
        message: 'Organization not found.'
      }
    });
    return;
  }

  req.organizationId = organizationId;
  const role = membership.rows[0]?.role;

  if (!role) {
    res.status(404).json({
      error: {
        code: 'ORGANIZATION_NOT_FOUND',
        message: 'Organization not found.'
      }
    });
    return;
  }

  req.organizationRole = role;
  next();
});

export function requireOrganizationRole(...roles: string[]): RequestHandler {
  return (req, res, next) => {
    if (!roles.includes(req.organizationRole ?? '')) {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'Your organization role cannot perform this action.'
        }
      });
      return;
    }
    next();
  };
}
