import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, redactMongoUri, redactSecrets } from '../src/config/env.js';

const base = { MONGODB_URI: 'mongodb://127.0.0.1:27017/civicfix' };

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
    expect(issuesFor({})).toEqual(['MONGODB_URI is required']);
    expect(issuesFor({ MONGODB_URI: 'postgres://x' })).toHaveLength(1);
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
      loadConfig({ MONGODB_URI: 'not-a-uri-with-s3cret', PORT: 'abc' });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('s3cret');
    }
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
