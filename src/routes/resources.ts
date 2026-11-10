import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { authenticate } from '../middleware/authenticate.js';
import { loadOrganization, requireOrganizationRole } from '../middleware/organization-access.js';
import { asyncHandler } from '../utils/async-handler.js';
import { encryptSecret, generateApiKey } from '../utils/resource-secrets.js';

export const resourceRouter = Router({ mergeParams: true });

const writeRoles = requireOrganizationRole('owner', 'admin', 'developer');
const nameSchema = z.object({ name: z.string().trim().min(1).max(100) });
const environmentSchema = z.object({ name: z.string().trim().min(1).max(40) });

const endpointSchema = z.object({
  url: z.string().url().max(2048),
  description: z.string().trim().max(500).default(''),
  eventTypes: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/)).min(1).max(100)
    .refine((values) => new Set(values).size === values.length),
});

const slugify = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'resource';

resourceRouter.use(authenticate, loadOrganization);

resourceRouter.get('/', asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT id, name, slug, created_at FROM projects WHERE organization_id = $1 ORDER BY created_at DESC',
    [req.organizationId],
  );
  res.json({ data: result.rows });
}));

resourceRouter.post('/', writeRoles, asyncHandler(async (req, res) => {
  const parsed = nameSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: {
      code: 'VALIDATION_ERROR',
      message: 'Enter a project name.'
    } });
    return;
  }

  const result = await pool.query(
    'INSERT INTO projects (organization_id, name, slug) VALUES ($1, $2, $3) RETURNING id, name, slug, created_at',
    [req.organizationId, parsed.data.name, slugify(parsed.data.name) + '-' + crypto.randomUUID().slice(0, 8)],
  );
  
  res.status(201).json({ project: result.rows[0] });
}));

resourceRouter.patch('/:projectId', writeRoles, asyncHandler(async (req, res) => {
  const parsed = nameSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: {
      code: 'VALIDATION_ERROR',
      message: 'Enter a project name.'
    } });
    return;
  }
  
  const result = await pool.query(
    'UPDATE projects SET name = $3, slug = $4 WHERE organization_id = $1 AND id = $2 RETURNING id, name, slug, created_at',
    [req.organizationId, req.params.projectId, parsed.data.name, slugify(parsed.data.name) + '-' + crypto.randomUUID().slice(0, 8)],
  );

  if (!result.rowCount) {
    res.status(404).json({ error: {
      code: 'PROJECT_NOT_FOUND',
      message: 'Project not found.'
    } });
    return;
  }

  res.json({ project: result.rows[0] });
}));

resourceRouter.delete('/:projectId', writeRoles, asyncHandler(async (req, res) => {
  const result = await pool.query('DELETE FROM projects WHERE organization_id = $1 AND id = $2', [req.organizationId, req.params.projectId]);
  if (!result.rowCount) {
    res.status(404).json({ error: {
      code: 'PROJECT_NOT_FOUND',
      message: 'Project not found.'
    } });
    return;
  }
  res.status(204).end();
}));

resourceRouter.get('/:projectId/environments', asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT e.id, e.name, e.slug, e.created_at
     FROM environments e JOIN projects p ON p.id = e.project_id
     WHERE p.organization_id = $1 AND p.id = $2 ORDER BY e.created_at`,
    [req.organizationId, req.params.projectId],
  );

  const project = await pool.query('SELECT 1 FROM projects WHERE organization_id = $1 AND id = $2', [req.organizationId, req.params.projectId]);
  
  if (!project.rowCount) {
    res.status(404).json({ error: {
      code: 'PROJECT_NOT_FOUND',
      message: 'Project not found.'
    } });
    return;
  }

  res.json({ data: result.rows });
}));

resourceRouter.post('/:projectId/environments', writeRoles, asyncHandler(async (req, res) => {
  const parsed = environmentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: {
      code: 'VALIDATION_ERROR',
      message: 'Enter an environment name.'
    } });
    return;
  }

  const result = await pool.query(
    `INSERT INTO environments (project_id, name, slug)
     SELECT p.id, $3, $4 FROM projects p WHERE p.organization_id = $1 AND p.id = $2
     RETURNING id, name, slug, created_at`,
    [req.organizationId, req.params.projectId, parsed.data.name, slugify(parsed.data.name)],
  );

  if (!result.rowCount) {
    res.status(404).json({ error: {
      code: 'PROJECT_NOT_FOUND',
      message: 'Project not found.'
    } });
    return;
  }

  res.status(201).json({ environment: result.rows[0] });
}));

resourceRouter.get('/:projectId/environments/:environmentId/api-keys', asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT k.id, k.label, k.prefix, k.last_used_at, k.revoked_at, k.created_at
     FROM api_keys k JOIN environments e ON e.id = k.environment_id
     JOIN projects p ON p.id = e.project_id
     WHERE p.organization_id = $1 AND p.id = $2 AND e.id = $3 ORDER BY k.created_at DESC`,
    [req.organizationId, req.params.projectId, req.params.environmentId],
  );
  res.json({ data: result.rows });
}));

resourceRouter.post('/:projectId/environments/:environmentId/api-keys', writeRoles, asyncHandler(async (req, res) => {
  const parsed = z.object({ label: z.string().trim().min(1).max(100) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: {
      code: 'VALIDATION_ERROR',
      message: 'Enter an API key label.'
    } });
    return;
  }

  const key = generateApiKey();
  const result = await pool.query(
    `INSERT INTO api_keys (environment_id, label, prefix, secret_hash)
     SELECT e.id, $4, $5, $6 FROM environments e JOIN projects p ON p.id = e.project_id
     WHERE p.organization_id = $1 AND p.id = $2 AND e.id = $3
     RETURNING id, label, prefix, created_at`,
    [req.organizationId, req.params.projectId, req.params.environmentId, parsed.data.label, key.prefix, key.hash],
  );

  if (!result.rowCount) {
    res.status(404).json({ error: {
      code: 'ENVIRONMENT_NOT_FOUND',
      message: 'Environment not found.'
    } });
    return;
  }

  res.status(201).json({ apiKey: { ...result.rows[0], secret: key.secret } });
}));

resourceRouter.delete('/:projectId/environments/:environmentId/api-keys/:keyId', writeRoles, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `UPDATE api_keys k SET revoked_at = now()
     FROM environments e, projects p
     WHERE k.environment_id = e.id AND e.project_id = p.id AND p.organization_id = $1
       AND p.id = $2 AND e.id = $3 AND k.id = $4 AND k.revoked_at IS NULL
     RETURNING k.id`,
    [req.organizationId, req.params.projectId, req.params.environmentId, req.params.keyId],
  );

  if (!result.rowCount) {
    res.status(404).json({ error: {
      code: 'API_KEY_NOT_FOUND',
      message: 'Active API key not found.'
    } });
    return;
  }

  res.status(204).end();
}));

resourceRouter.get('/:projectId/environments/:environmentId/endpoints', asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT d.id, d.url, d.description, d.active, d.created_at, d.updated_at,
       COALESCE(array_agg(s.event_type) FILTER (WHERE s.event_type IS NOT NULL), '{}') AS event_types
     FROM endpoints d JOIN environments e ON e.id = d.environment_id
     JOIN projects p ON p.id = e.project_id LEFT JOIN subscriptions s ON s.endpoint_id = d.id
     WHERE p.organization_id = $1 AND p.id = $2 AND e.id = $3
     GROUP BY d.id ORDER BY d.created_at DESC`,
    [req.organizationId, req.params.projectId, req.params.environmentId],
  );
  res.json({ data: result.rows });
}));

resourceRouter.post('/:projectId/environments/:environmentId/endpoints', writeRoles, asyncHandler(async (req, res) => {
  const parsed = endpointSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: {
      code: 'VALIDATION_ERROR',
      message: 'Provide a valid URL and at least one event type.'
    } });
    return;
  }

  const url = new URL(parsed.data.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    res.status(400).json({ error: {
      code: 'VALIDATION_ERROR',
      message: 'Endpoint URL must use HTTP or HTTPS without embedded credentials.'
    } });
    return;
  }

  const signingSecret = 'whsec_' + crypto.randomBytes(32).toString('base64url');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const endpoint = await client.query(
      `INSERT INTO endpoints (environment_id, url, description, signing_secret_enc)
       SELECT e.id, $4, $5, $6 FROM environments e JOIN projects p ON p.id = e.project_id
       WHERE p.organization_id = $1 AND p.id = $2 AND e.id = $3
       RETURNING id, url, description, active, created_at, updated_at`,
      [req.organizationId, req.params.projectId, req.params.environmentId, parsed.data.url, parsed.data.description, encryptSecret(signingSecret)],
    );

    if (!endpoint.rowCount) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: {
        code: 'ENVIRONMENT_NOT_FOUND',
        message: 'Environment not found.'
      } });
      return;
    }

    for (const eventType of parsed.data.eventTypes) {
      await client.query('INSERT INTO subscriptions (endpoint_id, event_type) VALUES ($1, $2)', [endpoint.rows[0].id, eventType]);
    }
    
    await client.query('COMMIT');
    res.status(201).json({ endpoint: { ...endpoint.rows[0], eventTypes: parsed.data.eventTypes, signingSecret } });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

resourceRouter.patch('/:projectId/environments/:environmentId/endpoints/:endpointId', writeRoles, asyncHandler(async (req, res) => {
  const parsed = z.object({ active: z.boolean().optional(), description: z.string().trim().max(500).optional() }).refine((value) => Object.keys(value).length > 0).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: {
      code: 'VALIDATION_ERROR',
      message: 'Provide active or description to update.'
    } });
    return;
  }

  const result = await pool.query(
    `UPDATE endpoints d SET active = COALESCE($5, d.active), description = COALESCE($6, d.description), updated_at = now()
     FROM environments e, projects p
     WHERE d.environment_id = e.id AND e.project_id = p.id AND p.organization_id = $1
       AND p.id = $2 AND e.id = $3 AND d.id = $4
     RETURNING d.id, d.url, d.description, d.active, d.created_at, d.updated_at`,
    [req.organizationId, req.params.projectId, req.params.environmentId, req.params.endpointId, parsed.data.active ?? null, parsed.data.description ?? null],
  );

  if (!result.rowCount) {
    res.status(404).json({ error: {
      code: 'ENDPOINT_NOT_FOUND',
      message: 'Endpoint not found.'
    } });
    return;
  }

  res.json({ endpoint: result.rows[0] });
}));

resourceRouter.delete('/:projectId/environments/:environmentId/endpoints/:endpointId', writeRoles, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `DELETE FROM endpoints d USING environments e, projects p
     WHERE d.environment_id = e.id AND e.project_id = p.id AND p.organization_id = $1
       AND p.id = $2 AND e.id = $3 AND d.id = $4`,
    [req.organizationId, req.params.projectId, req.params.environmentId, req.params.endpointId],
  );

  if (!result.rowCount) {
    res.status(404).json({ error: {
      code: 'ENDPOINT_NOT_FOUND',
      message: 'Endpoint not found.'
    } });
    return;
  }

  res.status(204).end();
}));

resourceRouter.put('/:projectId/environments/:environmentId/endpoints/:endpointId/subscriptions', writeRoles, asyncHandler(async (req, res) => {
  const parsed = z.object({ eventTypes: endpointSchema.shape.eventTypes }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: {
      code: 'VALIDATION_ERROR',
      message: 'Provide between 1 and 100 valid event types.'
    } });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const endpoint = await client.query(
      `SELECT d.id FROM endpoints d JOIN environments e ON e.id = d.environment_id
       JOIN projects p ON p.id = e.project_id
       WHERE p.organization_id = $1 AND p.id = $2 AND e.id = $3 AND d.id = $4`,
      [req.organizationId, req.params.projectId, req.params.environmentId, req.params.endpointId],
    );

    if (!endpoint.rowCount) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: {
        code: 'ENDPOINT_NOT_FOUND',
        message: 'Endpoint not found.'
      } });
      return;
    }

    await client.query('DELETE FROM subscriptions WHERE endpoint_id = $1', [req.params.endpointId]);

    await client.query(
      'INSERT INTO subscriptions (endpoint_id, event_type) SELECT $1, unnest($2::text[])',
      [req.params.endpointId, parsed.data.eventTypes],
    );

    await client.query('COMMIT');

    res.json({ eventTypes: parsed.data.eventTypes });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));