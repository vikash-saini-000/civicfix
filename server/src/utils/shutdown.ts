import type { Server } from 'node:http';
import { safeError } from '../config/database.js';
import type { Logger } from './logger.js';

export interface ShutdownOptions {
  server: Server;
  logger: Logger;
  timeoutMs: number;
  /** Cleanup after HTTP has stopped, e.g. closing the database. */
  onClose: () => Promise<void>;
}

/**
 * Returns an idempotent shutdown function. It stops accepting connections, lets in-flight
 * requests finish (up to timeoutMs, then forces sockets closed), runs onClose, and resolves
 * with the exit code. Calling it again returns the same promise.
 */
export function createShutdown(opts: ShutdownOptions) {
  let shuttingDown = false;
  let done: Promise<number> | null = null;

  const shutdown = (reason: string): Promise<number> => {
    if (done) return done;
    shuttingDown = true;
    opts.logger.info({ reason }, 'shutting down');

    done = (async () => {
      let exitCode = 0;
      const closed = new Promise<void>((resolve) => opts.server.close(() => resolve()));
      opts.server.closeIdleConnections();

      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), opts.timeoutMs);
        timer.unref();
      });
      if ((await Promise.race([closed, timedOut])) === 'timeout') {
        opts.logger.warn({ timeoutMs: opts.timeoutMs }, 'in-flight requests did not finish in time; closing connections');
        opts.server.closeAllConnections();
        exitCode = 1;
        await closed;
      }
      clearTimeout(timer);

      try {
        await opts.onClose();
      } catch (err) {
        opts.logger.error({ err: safeError(err) }, 'error during shutdown cleanup');
        exitCode = 1;
      }
      opts.logger.info({ exitCode }, 'shutdown complete');
      return exitCode;
    })();
    return done;
  };

  return { shutdown, isShuttingDown: () => shuttingDown };
}
