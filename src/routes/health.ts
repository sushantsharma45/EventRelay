import { Router } from 'express';
import { pool } from '../db/pool.js';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'eventrelay-api' });
});

healthRouter.get('/ready', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ready', database: 'ok' });
  } catch {
    res.status(503).json({ status: 'not_ready', database: 'unavailable' });
  }
});
