import type { ErrorRequestHandler } from 'express';
import { logger } from '../logger.js';

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  logger.error({
    err: error,
    requestId: res.locals.requestId
  }, 'Unhandled request error');

  if (res.headersSent) return;
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'The request could not be completed.' }
  });
};
