import crypto from 'node:crypto';
import { resolve } from 'node:path';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import { logger } from './logger.js';
import { errorHandler } from './middleware/error-handler.js';
import { apiRateLimiter } from './middleware/api-rate-limit.js';
import { authRouter } from './routes/auth.js';
import { healthRouter } from './routes/health.js';
import { organizationsRouter } from './routes/organizations.js';
import { resourceRouter } from './routes/resources.js';
import { eventsRouter } from './routes/events.js';
import { deliveriesRouter } from './routes/deliveries.js';
import { httpRequestDurationSeconds, httpRequestsTotal } from './observability/metrics.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN }));
  app.use((req, res, next) => {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    res.locals.requestId = requestId;
    res.setHeader('x-request-id', requestId);
    res.on('finish', () => {
      const route = req.route
        ? req.baseUrl + req.route.path
        : 'unmatched';
      const statusCode = String(res.statusCode);
      const durationSeconds = (Date.now() - startedAt) / 1000;
      httpRequestsTotal.inc({ method: req.method, route, status_code: statusCode });
      httpRequestDurationSeconds.observe({ method: req.method, route }, durationSeconds);
      logger.info({
        requestId,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: Math.round(durationSeconds * 1000),
      }, 'request completed');
    });
    next();
  });

  app.use('/v1', apiRateLimiter);
  app.use(express.json({ limit: '256kb', strict: true }));

  app.use('/health', healthRouter);
  app.use('/v1/auth', authRouter);
  app.use('/v1/events', eventsRouter);
  app.use('/v1/organizations/:organizationId/deliveries', deliveriesRouter);
  app.use('/v1/organizations', organizationsRouter);
  app.use('/v1/organizations/:organizationId/projects', resourceRouter);

  app.use(express.static(resolve(process.cwd(), 'dist', 'web'), { index: 'index.html' }));

  app.use((_req, res) =>
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found.'
      }
    }),
  );
  app.use(errorHandler);
  return app;
}
