import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, redactMongoUri, redactSecrets } from '../src/config/env.js';

const JWT = 'k9f2c1a7e5b8d4f60a3c2e1b7d9f0a4c6x';
const base = { MONGODB_URI: 'mongodb://127.0.0.1:27017/civicfix', JWT_SECRET: JWT };

function issuesFor(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
    return [];
  } catch (err) {
    if (err instanceof ConfigError) return err.issues;
    throw err;
  }
}

describe('loadConfig', () => {
  it('applies safe defaults', () => {
    expect(loadConfig(base)).toEqual({
      nodeEnv: 'development',
      host: '0.0.0.0',
      port: 4000,
      mongodbUri: base.MONGODB_URI,
      corsOrigins: [],
      jsonBodyLimit: '100kb',
      logLevel: 'info',
      shutdownTimeoutMs: 10_000,
      dbServerSelectionTimeoutMs: 10_000,
      trustProxyHops: 0,
      auth: { jwtSecret: JWT, accessTokenTtlSeconds: 900, refreshTokenTtlDays: 7, cookieSecure: false, cookieSameSite: 'lax' },
      ai: { provider: 'disabled', apiKey: undefined, model: 'claude-opus-5-5', timeoutMs: 30_000, maxAttempts: 3 },
    });
  });

  it('reads and normalizes explicit values', () => {
    const c = loadConfig({
      ...base,
      NODE_ENV: 'test',
      PORT: '5000',
      CORS_ORIGINS: 'http://localhost:5173, http://127.0.0.1:5173',
      JSON_BODY_LIMIT: '200KB',
    });
    expect(c.port).toBe(5000);
    expect(c.corsOrigins).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
    expect(c.jsonBodyLimit).toBe('200kb');
    expect(c.logLevel).toBe('silent'); // quiet by default in tests
  });

  it('requires a MongoDB URI', () => {
    expect(issuesFor({ JWT_SECRET: JWT })).toEqual(['MONGODB_URI is required']);
    expect(issuesFor({ JWT_SECRET: JWT, MONGODB_URI: 'postgres://x' })).toHaveLength(1);
  });

  it('reports every invalid value at once', () => {
    const issues = issuesFor({ ...base, NODE_ENV: 'staging', PORT: '99999', JSON_BODY_LIMIT: '50mb', LOG_LEVEL: 'loud' });
    expect(issues).toHaveLength(4);
  });

  it('rejects wildcard, malformed and path-bearing CORS origins', () => {
    expect(issuesFor({ ...base, CORS_ORIGINS: '*' })).toHaveLength(1);
    expect(issuesFor({ ...base, CORS_ORIGINS: 'localhost:5173' })).toHaveLength(1);
    expect(issuesFor({ ...base, CORS_ORIGINS: 'http://localhost:5173/' })).toHaveLength(1);
  });

  it('is stricter in production', () => {
    expect(issuesFor({ ...base, NODE_ENV: 'production' })).toEqual(['CORS_ORIGINS is required in production']);
    expect(issuesFor({ ...base, NODE_ENV: 'production', CORS_ORIGINS: 'http://civicfix.example' })).toEqual([
      'CORS_ORIGINS must use https in production',
    ]);
    expect(issuesFor({ ...base, NODE_ENV: 'production', CORS_ORIGINS: 'https://civicfix.example' })).toEqual([]);
  });

  it('never includes secret values in error messages', () => {
    try {
      loadConfig({ MONGODB_URI: 'not-a-uri-with-s3cret', PORT: 'abc', JWT_SECRET: 'short-s3cret' });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('s3cret');
    }
  });
});

describe('auth config', () => {
  it('requires a strong JWT secret', () => {
    expect(issuesFor({ MONGODB_URI: base.MONGODB_URI })).toEqual(['JWT_SECRET is required']);
    expect(issuesFor({ ...base, JWT_SECRET: 'too-short' })).toEqual(['JWT_SECRET must be at least 32 characters']);
    expect(issuesFor({ ...base, JWT_SECRET: 'change-me-change-me-change-me-change-me' })).toHaveLength(1);
    expect(issuesFor({ ...base, JWT_SECRET: 'a'.repeat(40) })).toHaveLength(1);
  });

  it('forces secure cookies in production and validates SameSite', () => {
    const prod = { ...base, NODE_ENV: 'production', CORS_ORIGINS: 'https://civicfix.example' };
    expect(loadConfig(prod).auth.cookieSecure).toBe(true);
    expect(issuesFor({ ...prod, COOKIE_SECURE: 'false' })).toEqual(['COOKIE_SECURE cannot be false in production']);
    expect(issuesFor({ ...base, COOKIE_SAMESITE: 'none' })).toEqual(['COOKIE_SAMESITE=none requires COOKIE_SECURE=true']);
    expect(issuesFor({ ...base, COOKIE_SAMESITE: 'loose' })).toHaveLength(1);
    expect(issuesFor({ ...base, ACCESS_TOKEN_TTL_SECONDS: '10' })).toHaveLength(1);
  });
});

describe('ai config', () => {
  it('is disabled by default and needs a key when enabled', () => {
    expect(loadConfig(base).ai.provider).toBe('disabled');
    expect(issuesFor({ ...base, AI_PROVIDER: 'anthropic' })).toEqual(['ANTHROPIC_API_KEY is required when AI_PROVIDER=anthropic']);
    expect(loadConfig({ ...base, AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-test' }).ai).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5' });
    expect(issuesFor({ ...base, AI_PROVIDER: 'openai' })).toHaveLength(1);
    expect(issuesFor({ ...base, AI_MAX_ATTEMPTS: '9' })).toHaveLength(1);
  });
});

describe('redaction helpers', () => {
  it('removes credentials and options from MongoDB URIs', () => {
    expect(redactMongoUri('mongodb+srv://admin:p4ss@cluster0.example.net/civicfix?retryWrites=true')).toBe(
      'mongodb+srv://***@cluster0.example.net',
    );
    expect(redactSecrets('failed for mongodb://admin:p4ss@host:27017/db')).not.toContain('p4ss');
  });
});
