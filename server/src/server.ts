// Process entry point: load config, connect to MongoDB, then start HTTP. Exits non-zero on startup failure.
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase, isDatabaseConnected, pingDatabase, safeError } from './config/database.js';
import { ConfigError, loadConfig } from './config/env.js';
// Registers every model on the default connection (indexes are built on connect when autoIndex is on).
import './models/index.js';
import { createLogger } from './utils/logger.js';
import { createShutdown } from './utils/shutdown.js';

async function main() {
  // Local development convenience. Real environment variables take precedence over .env.
  if (existsSync('.env')) process.loadEnvFile('.env');

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // Issue list names variables only, never their values.
    console.error(err instanceof ConfigError ? err.message : 'Failed to load configuration');
    process.exit(1);
  }

  const logger = createLogger(config);

  // The API needs MongoDB for everything, so we don't listen until it is reachable.
  try {
    await connectDatabase({
      uri: config.mongodbUri,
      serverSelectionTimeoutMs: config.dbServerSelectionTimeoutMs,
      autoIndex: config.nodeEnv !== 'production',
      logger,
    });
  } catch (err) {
    logger.fatal({ err: safeError(err) }, 'startup failed: database unavailable');
    process.exit(1);
  }

  let isShuttingDown = () => false;
  const app = createApp({
    config,
    logger,
    isDatabaseConnected,
    checkDatabase: () => pingDatabase(),
    isShuttingDown: () => isShuttingDown(),
  });
  const server = createServer(app);
  // Close kept-alive sockets a little before typical proxy timeouts.
  server.keepAliveTimeout = 5_000;
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;

  const lifecycle = createShutdown({ server, logger, timeoutMs: config.shutdownTimeoutMs, onClose: disconnectDatabase });
  isShuttingDown = lifecycle.isShuttingDown;

  const stop = (reason: string) => lifecycle.shutdown(reason).then((code) => process.exit(code));
  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: safeError(reason) }, 'unhandled promise rejection');
    void stop('unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: safeError(err) }, 'uncaught exception');
    void stop('uncaughtException');
  });

  server.on('error', (err) => {
    logger.fatal({ err: safeError(err) }, 'HTTP server error');
    void stop('serverError');
  });
  server.listen(config.port, config.host, () => {
    logger.info({ port: config.port }, 'server listening');
  });
}

void main();
