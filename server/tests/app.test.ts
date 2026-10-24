// HTTP behaviour of the app with fake dependencies. No database or listening server.
import { Writable } from 'node:stream';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp, type AppDeps } from '../src/app.js';
import { errorHandler } from '../src/middleware/errors.js';
import { requestContext } from '../src/middleware/requestContext.js';
import { createLogger } from '../src/utils/logger.js';

const silent = createLogger({ logLevel: 'silent', nodeEnv: 'test' });

function makeApp(overrides: Partial<AppDeps> = {}) {
  return createApp({
    config: { nodeEnv: 'test', corsOrigins: ['http://localhost:5173'], jsonBodyLimit: '1kb' },
    logger: silent,
    isDatabaseConnected: () => true,
    checkDatabase: async () => true,
    isShuttingDown: () => false,
    ...overrides,
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('health', () => {
  it('reports liveness without touching the database', async () => {
    let checks = 0;
    const res = await request(makeApp({ checkDatabase: async () => (checks++, true) })).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(checks).toBe(0);
  });

  it('is ready when the database is up', async () => {
    const res = await request(makeApp()).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready', checks: { database: 'up' } });
  });

  it('is not ready when the database is down', async () => {
    const res = await request(makeApp({ checkDatabase: async () => false })).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'not_ready', checks: { database: 'down' } });
  });

  it('is not ready while shutting down', async () => {
    const res = await request(makeApp({ isShuttingDown: () => true })).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
  });
});

describe('routing and errors', () => {
  it('returns a consistent 404 for unknown routes', async () => {
    const res = await request(makeApp()).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'No route for GET /nope.', requestId: res.headers['x-request-id'] } });
  });

  it('returns 404 under /api/v1 when the database is up (no product routes yet)', async () => {
    expect((await request(makeApp()).get('/api/v1/complaints')).status).toBe(404);
  });

  it('refuses API traffic with 503 while the database is down', async () => {
    const res = await request(makeApp({ isDatabaseConnected: () => false })).get('/api/v1/complaints');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.headers['retry-after']).toBe('5');
  });

  it('rejects malformed JSON with 400', async () => {
    const res = await request(makeApp()).post('/api/v1/anything').set('Content-Type', 'application/json').send('{"a":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('rejects bodies over the limit with 413', async () => {
    const res = await request(makeApp())
      .post('/api/v1/anything')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ text: 'x'.repeat(2048) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('request IDs', () => {
  it('generates an ID when none is sent', async () => {
    const res = await request(makeApp()).get('/health/live');
    expect(res.headers['x-request-id']).toMatch(UUID);
  });

  it('keeps a valid incoming ID', async () => {
    const res = await request(makeApp()).get('/nope').set('X-Request-Id', 'client-req-12345');
    expect(res.headers['x-request-id']).toBe('client-req-12345');
    expect(res.body.error.requestId).toBe('client-req-12345');
  });

  it('replaces an unsafe incoming ID', async () => {
    const res = await request(makeApp()).get('/health/live').set('X-Request-Id', 'bad id <script>');
    expect(res.headers['x-request-id']).toMatch(UUID);
  });
});

describe('security headers and CORS', () => {
  it('sets helmet headers and hides the framework', async () => {
    const res = await request(makeApp()).get('/health/live');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('allows only configured origins', async () => {
    const ok = await request(makeApp()).get('/health/live').set('Origin', 'http://localhost:5173');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const other = await request(makeApp()).get('/health/live').set('Origin', 'https://evil.example');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('errorHandler', () => {
  function appThatThrows(err: unknown, exposeDetails: boolean) {
    const app = express();
    app.use(requestContext(silent));
    app.get('/boom', () => {
      throw err;
    });
    app.use(errorHandler({ exposeDetails }));
    return app;
  }

  it('hides internal details of unexpected errors', async () => {
    const res = await request(appThatThrows(new Error('db password is hunter2'), false)).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(res.text).not.toContain('at '); // no stack trace
  });

  it('maps database connectivity errors to 503', async () => {
    const err = Object.assign(new Error('Server selection timed out'), { name: 'MongooseServerSelectionError' });
    const res = await request(appThatThrows(err, false)).get('/boom');
    expect(res.status).toBe(503);
  });

  it('handles async errors (Express 5) and non-Error throws', async () => {
    const app = express();
    app.use(requestContext(silent));
    app.get('/async', async () => {
      await Promise.resolve();
      throw 'plain string';
    });
    app.use(errorHandler({ exposeDetails: false }));
    const res = await request(app).get('/async');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });
});

describe('logging', () => {
  it('writes structured JSON with the request ID and redacts sensitive fields', async () => {
    const lines: Record<string, unknown>[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(JSON.parse(String(chunk)));
        cb();
      },
    });
    const logger = createLogger({ logLevel: 'info', nodeEnv: 'test' }, sink);
    await request(makeApp({ logger })).get('/health/live').set('X-Request-Id', 'trace-abc-123');

    const entry = lines.find((l) => l.msg === 'request completed');
    expect(entry).toMatchObject({ level: 'info', requestId: 'trace-abc-123', status: 200, path: '/health/live', env: 'test' });
    expect(typeof entry?.time).toBe('string');

    logger.info({ body: { password: 'hunter2', token: 'abc' } }, 'test');
    expect(JSON.stringify(lines.at(-1))).not.toMatch(/hunter2|"abc"/);
  });
});
