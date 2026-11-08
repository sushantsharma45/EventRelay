import type { RequestHandler } from 'express';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { env } from '../config/env.js';
import { asyncHandler } from '../utils/async-handler.js';

export const authenticate: RequestHandler = asyncHandler(async (req, res, next) => {
  const match = req.header('authorization')?.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1];
  if (!token) {
    res.status(401).json({
      error: {
        code: 'UNAUTHENTICATED',
        message: 'Sign in to continue.' }
    });
    return;
  }

  try {
    const payload = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'eventrelay',
      audience: 'eventrelay-api',
    }) as JwtPayload;
    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
      res.status(401).json({
        error: {
          code: 'INVALID_TOKEN',
          message: 'Sign in again.'
        }
      });
      return;
    }
    req.authUser = { id: payload.sub, email: payload.email };
    next();
  } catch {
    res.status(401).json({
      error: {
        code: 'INVALID_TOKEN',
        message: 'Sign in again.'
      }
    });
  }
});
