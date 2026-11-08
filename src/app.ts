import crypto from 'node:crypto';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import { logger } from './logger.js';
import { errorHandler } from './middleware/error-handler.js';
import { healthRouter } from './routes/health.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN }));
  app.use(express.json({ limit: '256kb', strict: true }));
  app.use((req, res, next) => {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    res.locals.requestId = requestId;
    res.setHeader('x-request-id', requestId);
    res.on('finish', () => logger.info({
      requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
    }, 'request completed'));
    next();
  });
  app.use('/health', healthRouter);
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
