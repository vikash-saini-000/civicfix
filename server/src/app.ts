import cors from 'cors';
import express, { Router, type Express } from 'express';
import helmet from 'helmet';
import type { Config } from './config/env.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { requestContext, requestLogger } from './middleware/requestContext.js';
import { requireJson } from './middleware/requireJson.js';
import { disabledProvider } from './ai/types.js';
import { createAuthService } from './auth/authService.js';
import { safeError } from './config/database.js';
import { createAnalysisService, type AnalysisService } from './services/analysis/index.js';
import { apiRouter } from './routes/api.js';
import type { AuthRateLimits } from './routes/auth.js';
import type { RateLimitOptions } from './middleware/rateLimit.js';
import { healthRouter, type HealthDeps } from './routes/health.js';
import { AppError } from './utils/errors.js';
import type { Logger } from './utils/logger.js';

export interface AppDeps extends HealthDeps {
  config: Pick<Config, 'nodeEnv' | 'corsOrigins' | 'jsonBodyLimit' | 'auth'> & Partial<Pick<Config, 'trustProxyHops'>>;
  logger: Logger;
  /** Synchronous check used to refuse API traffic while MongoDB is down. */
  isDatabaseConnected: () => boolean;
  /** Routes mounted under /api/v1. Defaults to the real API router; tests may pass their own. */
  api?: Router;
  /** Override auth rate limits (tests). */
  authRateLimits?: AuthRateLimits;
  /** Override the per-user complaint creation limit (tests). */
  complaintCreateLimit?: RateLimitOptions;
  analysisRerunLimit?: RateLimitOptions;
  /**
   * AI analysis. server.ts passes a running one; when omitted, jobs are only queued (AI disabled,
   * nothing runs in the background) so tests stay deterministic.
   */
  analysis?: AnalysisService;
}

/**
 * Builds the Express app. Does not listen or connect to anything.
 *
 * Request lifecycle:
 *   request ID → request log → security headers → CORS → JSON body (size limit)
 *   → /health/*                                   (infrastructure, no DB guard)
 *   → /api/v1: DB guard → JSON content-type → feature routes
 *   → 404 → central error handler
 */
export function createApp(deps: AppDeps): Express {
  const { config, logger } = deps;
  const app = express();

  app.disable('x-powered-by');
  // Number of trusted proxy hops; 0 means req.ip is the socket address.
  app.set('trust proxy', config.trustProxyHops ?? 0);

  // 1. Request ID and logging first, so every later log line and error carries the ID.
  app.use(requestContext(logger));
  app.use(requestLogger);

  // 2. Security headers and CORS (explicit origins only; requests without Origin are not CORS).
  app.use(helmet());
  app.use(
    cors({
      origin: config.corsOrigins,
      credentials: true,
      exposedHeaders: ['X-Request-Id'],
      maxAge: 600,
    }),
  );

  // 3. Body parsing with a size limit. Malformed JSON is handled by errorHandler.
  app.use(express.json({ limit: config.jsonBodyLimit }));

  // 4. Infrastructure endpoints (outside the versioned API, keep their own small format).
  app.use('/health', healthRouter(deps));

  // 5. Versioned API.
  const api = Router();
  api.use((_req, _res, next) => {
    if (!deps.isDatabaseConnected() || deps.isShuttingDown()) {
      return next(new AppError('SERVICE_UNAVAILABLE', 'The service is temporarily unavailable. Try again shortly.'));
    }
    next();
  });
  api.use(requireJson);
  api.use(
    deps.api ??
      apiRouter({
        authService: createAuthService(config.auth, logger),
        authConfig: config.auth,
        corsOrigins: config.corsOrigins,
        rateLimits: deps.authRateLimits,
        complaintCreateLimit: deps.complaintCreateLimit,
        analysisRerunLimit: deps.analysisRerunLimit,
        analysisService: deps.analysis ?? createAnalysisService({ provider: disabledProvider, logger, maxAttempts: 1, autoRun: false }),
        onHookError: (err) => logger.error({ err: safeError(err) }, 'complaint hook failed'),
      }),
  );
  app.use('/api/v1', api);

  // 6. Not found, then the central error handler (must be last).
  app.use(notFound);
  app.use(errorHandler({ exposeDetails: config.nodeEnv === 'development' }));

  return app;
}
