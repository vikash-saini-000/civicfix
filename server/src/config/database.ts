import mongoose from 'mongoose';
import type { Logger } from '../utils/logger.js';
import { redactSecrets } from './env.js';

// Owns the single Mongoose connection used by all models. No business logic here.

export interface DatabaseOptions {
  uri: string;
  serverSelectionTimeoutMs: number;
  /** Build indexes automatically on startup. Off in production; use `npm run db:sync-indexes` there. */
  autoIndex: boolean;
  logger: Logger;
}

let connecting: Promise<typeof mongoose> | null = null;
let listenersAttached = false;

function attachListeners(logger: Logger) {
  if (listenersAttached) return;
  listenersAttached = true;
  const conn = mongoose.connection;
  conn.on('connected', () => logger.info({ db: conn.name }, 'database connected'));
  conn.on('reconnected', () => logger.info('database reconnected'));
  conn.on('disconnected', () => logger.warn('database disconnected'));
  conn.on('error', (err: Error) => logger.error({ err: safeError(err) }, 'database error'));
}

/** Connects once. Concurrent or repeated calls share the same attempt. Rejects if MongoDB cannot be reached in time. */
export function connectDatabase(opts: DatabaseOptions): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) return Promise.resolve(mongoose);
  if (connecting) return connecting;

  attachListeners(opts.logger);
  connecting = mongoose
    .connect(opts.uri, {
      serverSelectionTimeoutMS: opts.serverSelectionTimeoutMs,
      autoIndex: opts.autoIndex,
      // Fail fast instead of queueing queries while disconnected; the API returns 503 instead.
      bufferCommands: false,
      appName: 'civicfix-server',
    })
    .catch((err: unknown) => {
      throw new DatabaseConnectionError(err);
    })
    .finally(() => {
      connecting = null;
    });
  return connecting;
}

export function isDatabaseConnected(): boolean {
  return mongoose.connection.readyState === 1;
}

/** True only if connected and the server answers a ping within the timeout. */
export async function pingDatabase(timeoutMs = 1000): Promise<boolean> {
  const db = mongoose.connection.db;
  if (!isDatabaseConnected() || !db) return false;
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('ping timeout')), timeoutMs);
    });
    await Promise.race([db.admin().ping(), timeout]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function disconnectDatabase(): Promise<void> {
  if (connecting) await connecting.catch(() => undefined);
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
}

/** Startup failure to reach MongoDB. Message is sanitized. */
export class DatabaseConnectionError extends Error {
  constructor(cause: unknown) {
    super(`Could not connect to MongoDB: ${safeError(cause).message}`);
    this.name = 'DatabaseConnectionError';
  }
}

/** Error summary that is safe to log: secrets are scrubbed from the message and, if requested, the stack. */
export function safeError(err: unknown, opts: { stack?: boolean } = {}): { name: string; message: string; stack?: string } {
  const e = err instanceof Error ? err : new Error(String(err));
  const out: { name: string; message: string; stack?: string } = { name: e.name, message: redactSecrets(e.message) };
  if (opts.stack && e.stack) out.stack = redactSecrets(e.stack);
  return out;
}
