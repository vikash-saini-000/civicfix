// Central environment configuration. Validates once at startup and never echoes secret values.

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  nodeEnv: NodeEnv;
  host: string;
  port: number;
  mongodbUri: string;
  /** Exact origins allowed by CORS, e.g. http://localhost:5173. */
  corsOrigins: string[];
  /** Max JSON body size, in a form express.json() accepts, e.g. "100kb". */
  jsonBodyLimit: string;
  logLevel: LogLevel;
  shutdownTimeoutMs: number;
  dbServerSelectionTimeoutMs: number;
}

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid environment configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

/** Parses and validates configuration. Throws ConfigError listing every problem (names only, never values). */
export function loadConfig(env: Env = process.env): Config {
  const issues: string[] = [];
  const read = (name: string) => {
    const v = env[name]?.trim();
    return v === '' ? undefined : v;
  };

  const nodeEnv = (read('NODE_ENV') ?? 'development') as NodeEnv;
  if (!NODE_ENVS.includes(nodeEnv)) issues.push(`NODE_ENV must be one of ${NODE_ENVS.join(', ')}`);
  const isProd = nodeEnv === 'production';

  const int = (name: string, fallback: number, min: number, max: number) => {
    const raw = read(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || n < min || n > max) {
      issues.push(`${name} must be a whole number from ${min} to ${max}`);
      return fallback;
    }
    return n;
  };

  const port = int('PORT', 4000, 1, 65535);
  const shutdownTimeoutMs = int('SHUTDOWN_TIMEOUT_MS', 10_000, 1_000, 120_000);
  const dbServerSelectionTimeoutMs = int('DB_SERVER_SELECTION_TIMEOUT_MS', 10_000, 500, 120_000);
  const host = read('HOST') ?? '0.0.0.0';

  const mongodbUri = read('MONGODB_URI') ?? '';
  if (!mongodbUri) issues.push('MONGODB_URI is required');
  else if (!/^mongodb(\+srv)?:\/\/[^/\s]+/.test(mongodbUri)) {
    issues.push('MONGODB_URI must start with mongodb:// or mongodb+srv:// and include a host');
  }

  const corsOrigins: string[] = [];
  for (const origin of (read('CORS_ORIGINS') ?? '').split(',').map((o) => o.trim()).filter(Boolean)) {
    if (origin === '*') {
      issues.push('CORS_ORIGINS must list exact origins; "*" is not allowed');
      continue;
    }
    try {
      const u = new URL(origin);
      if (!['http:', 'https:'].includes(u.protocol) || u.origin !== origin) throw new Error();
      if (isProd && u.protocol !== 'https:') issues.push('CORS_ORIGINS must use https in production');
      corsOrigins.push(origin);
    } catch {
      issues.push('CORS_ORIGINS must be a comma-separated list of origins like https://example.org (no paths or trailing slash)');
    }
  }
  if (isProd && corsOrigins.length === 0) issues.push('CORS_ORIGINS is required in production');

  const jsonBodyLimit = (read('JSON_BODY_LIMIT') ?? '100kb').toLowerCase();
  const limitMatch = /^(\d+)(b|kb|mb)$/.exec(jsonBodyLimit);
  const limitBytes = limitMatch ? Number(limitMatch[1]) * { b: 1, kb: 1024, mb: 1024 ** 2 }[limitMatch[2] as 'b' | 'kb' | 'mb'] : 0;
  if (!limitMatch || limitBytes < 1024 || limitBytes > 1024 ** 2) {
    issues.push('JSON_BODY_LIMIT must be a size like 100kb, between 1kb and 1mb');
  }

  const logLevel = (read('LOG_LEVEL') ?? (nodeEnv === 'test' ? 'silent' : 'info')) as LogLevel;
  if (!LOG_LEVELS.includes(logLevel)) issues.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);

  if (issues.length > 0) throw new ConfigError(issues);

  return { nodeEnv, host, port, mongodbUri, corsOrigins, jsonBodyLimit, logLevel, shutdownTimeoutMs, dbServerSelectionTimeoutMs };
}

/** Removes credentials and query options from a MongoDB URI so it is safe to log. */
export function redactMongoUri(uri: string): string {
  return uri.replace(/^(mongodb(?:\+srv)?:\/\/)(?:[^@/]*@)?([^/?]*).*$/, '$1***@$2');
}

/** Scrubs anything that looks like a connection string or credentials from free text (e.g. driver errors). */
export function redactSecrets(text: string): string {
  return text.replace(/mongodb(\+srv)?:\/\/\S+/g, 'mongodb://[redacted]');
}
