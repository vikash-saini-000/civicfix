import cors from 'cors';
import type { Geocoder } from './services/geocode.js';
import type { VideoTools } from './media/video.js';
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
import { createEventBus, type EventBus } from './events/bus.js';
import type { AssignmentPolicy } from './services/workOrders.js';
import { buildApi } from './routes/api.js';
import { setAuditLogger } from './services/audit.js';
import type { VerificationPolicy } from './services/resolution.js';
import type { ObjectStorage } from './storage/index.js';
import type { DirectUploads } from './storage/cloudinary.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { AuthRateLimits } from './routes/auth.js';
import type { RateLimitOptions } from './middleware/rateLimit.js';
import type { CaptchaVerifier } from './middleware/captcha.js';
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
  /** Domain event bus (notifications subscribe to it). Created if omitted. */
  events?: EventBus;
  assignmentPolicy?: AssignmentPolicy;
  verificationPolicy?: VerificationPolicy;
  /** Evidence file storage. Defaults to disabled (uploads answer 503). */
  storage?: ObjectStorage;
  /** ffmpeg tools for video uploads. Defaults to disabled (videos stored with metadata-only checks). */
  video?: VideoTools;
  maxVideoSeconds?: number;
  /** In-app camera policy (EVIDENCE_CAPTURE). Defaults to gallery files allowed. */
  capture?: { mode: 'camera' | 'any'; sessionTtlSeconds: number };
  /** Street addresses for map points (GEOCODER). Default: disabled. */
  geocoder?: Geocoder;
  uploadLimit?: RateLimitOptions;
  /** Turnstile check on register, login and new complaints. Default: disabled. */
  captcha?: CaptchaVerifier;
  /** Browser-to-Cloudinary uploads (Vercel's 4.5 MB request limit). Default: off, files go through the API. */
  directUploads?: DirectUploads;
  /** GET /api/v1/internal/maintenance, called by Vercel Cron with "Authorization: Bearer <secret>". */
  maintenance?: { secret: string; run: (deadline: number) => Promise<Record<string, unknown>> };
}

/**
 * Builds the Express app. Does not listen or connect to anything.
 *
 * Request lifecycle:
 *   request ID → request log → security headers → CORS → JSON body (size limit)
 *   → /health/*                                   (infrastructure, no DB guard)
 *   → /api/v1: DB guard → evidence upload (raw file body) → JSON content-type → feature routes
 *   → 404 → central error handler
 */
export function createApp(deps: AppDeps): Express {
  const { config, logger } = deps;
  const app = express();
  const events = deps.events ?? createEventBus(logger);
  setAuditLogger(logger);

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
  const routers = deps.api
    ? { router: deps.api, uploads: null }
    : buildApi({
        authService: createAuthService(config.auth, logger),
        authConfig: config.auth,
        corsOrigins: config.corsOrigins,
        rateLimits: deps.authRateLimits,
        complaintCreateLimit: deps.complaintCreateLimit,
        analysisRerunLimit: deps.analysisRerunLimit,
        analysisService: deps.analysis ?? createAnalysisService({ provider: disabledProvider, logger, maxAttempts: 1, autoRun: false }),
        onHookError: (err) => logger.error({ err: safeError(err) }, 'complaint hook failed'),
        events,
        logger,
        assignmentPolicy: deps.assignmentPolicy,
        verificationPolicy: deps.verificationPolicy,
        storage: deps.storage,
        video: deps.video,
        maxVideoSeconds: deps.maxVideoSeconds,
        capture: deps.capture,
        geocoder: deps.geocoder,
        uploadLimit: deps.uploadLimit,
        captcha: deps.captcha,
        directUploads: deps.directUploads,
      });
  if (deps.maintenance) {
    const { secret, run } = deps.maintenance;
    const expected = createHash('sha256').update(`Bearer ${secret}`).digest();
    api.get('/internal/maintenance', async (req, res) => {
      const given = createHash('sha256').update(req.get('authorization') ?? '').digest();
      if (!timingSafeEqual(given, expected)) throw new AppError('UNAUTHENTICATED', 'Missing or invalid maintenance credentials.');
      // Stay well inside the function's time limit (vercel.json maxDuration: 300 s).
      const result = await run(Date.now() + 240_000);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ success: true, data: result });
    });
  }
  if (routers.uploads) api.use(routers.uploads);
  api.use(requireJson);
  api.use(routers.router);
  app.use('/api/v1', api);

  // 6. Not found, then the central error handler (must be last).
  app.use(notFound);
  app.use(errorHandler({ exposeDetails: config.nodeEnv === 'development' }));

  return app;
}
