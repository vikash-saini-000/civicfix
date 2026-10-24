import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import type { Config } from '../config/env.js';

export type { Logger };

/** Paths removed from every log line, wherever they appear. */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',
  '*.mongodbUri',
  '*.apiKey',
  '*.jwtSecret',
];

/** Structured JSON logger. One per process; pass it down instead of importing a global. */
export function createLogger(config: Pick<Config, 'logLevel' | 'nodeEnv'>, destination?: DestinationStream): Logger {
  const options: LoggerOptions = {
    level: config.logLevel,
    base: { service: 'civicfix-server', env: config.nodeEnv },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  };
  return destination ? pino(options, destination) : pino(options);
}
