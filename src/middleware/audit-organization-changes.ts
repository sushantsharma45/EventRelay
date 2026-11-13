import type { RequestHandler } from 'express';
import { pool } from '../db/pool.js';
import { logger } from '../logger.js';

const writeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const auditOrganizationChanges: RequestHandler = (req, res, next) => {
  if (!writeMethods.has(req.method) || !req.organizationId || !req.authUser?.id) {
    next();
    return;
  }

  const actorId = req.authUser.id;
  const requestId = res.locals.requestId as string | undefined;
  res.once('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    const resourceId = req.params.deliveryId
      ?? req.params.endpointId
      ?? req.params.keyId
      ?? req.params.environmentId
      ?? req.params.projectId
      ?? req.params.userId
      ?? null;
    const route = req.route?.path ?? req.path;
    const routePath = req.baseUrl + route;
    const resourceType = req.params.deliveryId ? 'delivery'
      : req.params.endpointId ? 'endpoint'
      : req.params.keyId ? 'api_key'
      : req.params.environmentId ? 'environment'
      : req.params.projectId ? 'project'
      : req.params.userId ? 'membership'
      : routePath.includes('/endpoints') ? 'endpoint'
      : routePath.includes('/api-keys') ? 'api_key'
      : routePath.includes('/environments') ? 'environment'
      : routePath.includes('/projects') ? 'project'
      : routePath.includes('/members') ? 'membership'
      : routePath.includes('/deliveries') ? 'delivery'
      : 'organization';

    void pool.query(
      `INSERT INTO audit_log
         (organization_id, actor_id, action, resource_type, resource_id, details)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        req.organizationId,
        actorId,
        req.method.toLowerCase() + ':' + resourceType,
        resourceType,
        resourceId,
        JSON.stringify({ route, statusCode: res.statusCode, requestId }),
      ],
    ).catch((error) => {
      logger.error({ err: error, requestId }, 'Audit record could not be saved');
    });
  });

  next();
};