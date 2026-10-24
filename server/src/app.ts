import cors from 'cors';
import express, { Router, type Express } from 'express';
import helmet from 'helmet';
import type { Config } from './config/env.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { requestContext, requestLogger } from './middleware/requestContext.js';
import { healthRouter, type HealthDeps } from './routes/health.js';
import { AppError } from './utils/errors.js';
import type { Logger } from './utils/logger.js';

export interface AppDeps extends HealthDeps {
  config: Pick<Config, 'nodeEnv' | 'corsOrigins' | 'jsonBodyLimit'>;
  logger: Logger;
  /** Synchronous check used to refuse API traffic while MongoDB is down. */
  isDatabaseConnected: () => boolean;
}

/** Builds the Express app. Does not listen or connect to anything. */
export function createApp(deps: AppDeps): Express {
  const { config, logger } = deps;
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', false); // change only when deployed behind a known proxy

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

  // 4. Infrastructure endpoints (outside the versioned API).
  app.use('/health', healthRouter(deps));

  // 5. Versioned API. No product routes yet; they are added from Phase 3 on.
  const api = Router();
  api.use((_req, _res, next) => {
    if (!deps.isDatabaseConnected() || deps.isShuttingDown()) {
      return next(new AppError(503, 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable. Try again shortly.'));
    }
    next();
  });
  app.use('/api/v1', api);

  // 6. Not found, then the central error handler (must be last).
  app.use(notFound);
  app.use(errorHandler({ exposeDetails: config.nodeEnv === 'development' }));

  return app;
}
