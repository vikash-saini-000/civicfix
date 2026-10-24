import { Router } from 'express';

export interface HealthDeps {
  /** Cheap-enough readiness probe for MongoDB (connection state + ping). */
  checkDatabase: () => Promise<boolean>;
  isShuttingDown: () => boolean;
}

/**
 * GET /health/live  -> 200 { "status": "ok" }  (no dependency checks)
 * GET /health/ready -> 200 { "status": "ready", "checks": { "database": "up" } }
 *                   -> 503 { "status": "not_ready", "checks": { "database": "down" | "up" } }
 */
export function healthRouter(deps: HealthDeps): Router {
  const router = Router();

  router.get('/live', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ status: 'ok' });
  });

  router.get('/ready', async (_req, res) => {
    const database = (await deps.checkDatabase()) ? 'up' : 'down';
    const ready = database === 'up' && !deps.isShuttingDown();
    res
      .status(ready ? 200 : 503)
      .set('Cache-Control', 'no-store')
      .json({ status: ready ? 'ready' : 'not_ready', checks: { database } });
  });

  return router;
}
