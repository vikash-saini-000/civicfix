// Vercel function entry point for the API project (see server/vercel.json and server/api/index.mjs). The same Express app as server.ts,
// adapted to serverless:
//  - MongoDB connects once per function instance and is reused by later requests.
//  - Nothing runs between requests, so after each response the queued AI/privacy jobs keep running
//    (waitUntil) until the queue is quiet or the time limit nears. A daily cron sweeps the rest.
//  - ffmpeg/ffprobe come from npm packages, since Vercel images don't ship them.
import { finished } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { waitUntil } from '@vercel/functions';
import { connectDatabase, safeError } from './config/database.js';
import { ConfigError, loadConfig } from './config/env.js';
import { buildRuntime, type Runtime } from './runtime.js';
import { createLogger } from './utils/logger.js';

/** Keep in line with maxDuration in vercel.json (300 s), leaving room for the response itself. */
const BACKGROUND_BUDGET_MS = 250_000;

function useBundledFfmpeg() {
  if (process.env.FFMPEG_PATH && process.env.FFPROBE_PATH) return;
  const require = createRequire(import.meta.url);
  try {
    process.env.FFMPEG_PATH ??= (require('@ffmpeg-installer/ffmpeg') as { path: string }).path;
    process.env.FFPROBE_PATH ??= (require('@ffprobe-installer/ffprobe') as { path: string }).path;
  } catch {
    // Not installed for this platform: videos get metadata-only checks (logged at startup).
  }
}

let runtime: Promise<Runtime> | null = null;

async function init(): Promise<Runtime> {
  useBundledFfmpeg();
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // Names of the bad variables only, never their values.
    console.error(err instanceof ConfigError ? err.message : 'Failed to load configuration');
    throw new Error('Invalid configuration');
  }
  const logger = createLogger(config);
  try {
    await connectDatabase({ uri: config.mongodbUri, serverSelectionTimeoutMs: config.dbServerSelectionTimeoutMs, autoIndex: false, logger });
  } catch (err) {
    logger.fatal({ err: safeError(err) }, 'startup failed: database unavailable');
    throw new Error('Database unavailable');
  }
  return buildRuntime(config, logger, { isShuttingDown: () => false });
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const started = Date.now();
  let rt: Runtime;
  try {
    runtime ??= init();
    rt = await runtime;
  } catch {
    runtime = null; // try again on the next request
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'The service is temporarily unavailable. Try again shortly.', details: [] } }));
    return;
  }
  // After the response is sent, finish any queued work while this instance is still alive.
  waitUntil(
    finished(res)
      .catch(() => undefined)
      .then(() => rt.analysis.runner.runUntilQuiet(started + BACKGROUND_BUDGET_MS)),
  );
  rt.app(req as never, res as never);
}
