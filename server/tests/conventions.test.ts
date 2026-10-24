// Phase 3 API conventions: validation, response envelope, error mapping, pagination, rate limiting.
// Uses a sample router mounted through the real app stack. These routes are test-only.
import { Writable } from 'node:stream';
import { Router } from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp, type AppDeps } from '../src/app.js';
import { createRateLimiter } from '../src/middleware/rateLimit.js';
import { input, validate } from '../src/middleware/validate.js';
import { User } from '../src/models/index.js';
import { AppError, notFoundError } from '../src/utils/errors.js';
import { createLogger } from '../src/utils/logger.js';
import { sendCreated, sendNoContent, sendSuccess } from '../src/utils/respond.js';
import { complaintPublicId, idParams, objectId, text } from '../src/validation/common.js';
import { MAX_LIMIT, paginationMeta, paginationQuery, sortQuery, toSkipLimit, type PaginationQuery } from '../src/validation/pagination.js';
import { testAuthConfig } from './helpers.js';

const silent = createLogger({ logLevel: 'silent', nodeEnv: 'test' });

// A representative body schema: strict, so unknown and privileged fields are rejected.
const createNoteBody = z.strictObject({
  title: text(5, 120),
  category: z.enum(['roads', 'garbage']).optional(),
  departmentId: objectId.optional(),
});

const listQuery = paginationQuery.extend({ sort: sortQuery(['createdAt', 'priority'], '-createdAt') });

function sampleRoutes() {
  const r = Router();
  r.post('/notes', validate({ body: createNoteBody }), (req, res) => {
    sendCreated(res, { note: input(req, 'body') }, '/api/v1/notes/1');
  });
  r.get('/notes', validate({ query: listQuery }), (req, res) => {
    const q = input<PaginationQuery & { sort: Record<string, number> }>(req, 'query');
    sendSuccess(res, { skipLimit: toSkipLimit(q), sort: q.sort }, { meta: { pagination: paginationMeta(q, 45) } });
  });
  r.get('/notes/:id', validate({ params: idParams }), () => {
    throw notFoundError('Note');
  });
  r.delete('/notes/:id', validate({ params: idParams }), (_req, res) => sendNoContent(res));
  r.get('/complaints/:publicId', validate({ params: z.strictObject({ publicId: complaintPublicId }) }), (req, res) => {
    sendSuccess(res, input(req, 'params'));
  });
  r.get('/boom', () => {
    throw new Error('connection string mongodb://admin:hunter2@db.internal:27017 failed');
  });
  r.get('/async-boom', async () => {
    await Promise.resolve();
    throw new TypeError('cannot read secretField of undefined');
  });
  r.get('/conflict', () => {
    throw Object.assign(new Error('E11000 duplicate key error collection: users index: email_1 dup key: { email: "a@b.co" }'), {
      code: 11000,
      keyPattern: { email: 1 },
      keyValue: { email: 'a@b.co' },
    });
  });
  r.get('/mongoose-invalid', async () => {
    await new User({ name: 'A', email: 'bad', passwordHash: 'x' }).validate();
  });
  r.get('/cast', () => {
    throw new mongoose.Error.CastError('ObjectId', 'xyz', '_id');
  });
  r.get('/limited', createRateLimiter({ windowMs: 60_000, limit: 2 }), (_req, res) => sendSuccess(res, { ok: true }));
  r.get('/forbidden', () => {
    throw new AppError('FORBIDDEN', 'You cannot do that.');
  });
  return r;
}

function makeApp(overrides: Partial<AppDeps> = {}) {
  return createApp({
    config: { nodeEnv: 'production', corsOrigins: ['https://civicfix.example'], jsonBodyLimit: '1kb', auth: testAuthConfig },
    logger: silent,
    isDatabaseConnected: () => true,
    checkDatabase: async () => true,
    isShuttingDown: () => false,
    api: sampleRoutes(),
    ...overrides,
  });
}

const app = makeApp();
const post = (body: unknown) => request(app).post('/api/v1/notes').set('Content-Type', 'application/json').send(JSON.stringify(body));

describe('success envelope', () => {
  it('wraps data, sets 201 and Location for creates', async () => {
    const res = await post({ title: '  Broken bench ', category: 'roads' });
    expect(res.status).toBe(201);
    expect(res.headers.location).toBe('/api/v1/notes/1');
    expect(res.body).toEqual({ success: true, data: { note: { title: 'Broken bench', category: 'roads' } } });
  });

  it('includes meta only when given, and 204 has no body', async () => {
    const list = await request(app).get('/api/v1/notes');
    expect(list.body.meta.pagination).toEqual({ page: 1, limit: 20, total: 45, totalPages: 3, hasNextPage: true });
    const del = await request(app).delete('/api/v1/notes/0123456789abcdef01234567');
    expect(del.status).toBe(204);
    expect(del.text).toBe('');
  });
});

describe('request validation', () => {
  it('returns field-level details for invalid bodies', async () => {
    const res = await post({ title: 'abc', category: 'bridges' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toBe('The request contains invalid fields.');
    expect(res.body.error.details.map((d: { field: string }) => d.field)).toEqual(['body.title', 'body.category']);
    expect(res.body.error.details[0]).toMatchObject({ issue: 'too_small' });
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });

  it('rejects unknown and privileged fields instead of dropping them', async () => {
    const res = await post({ title: 'Broken bench', role: 'PLATFORM_ADMIN', citizen: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([
      { field: 'body.role', issue: 'unrecognized_key', message: 'This field is not allowed.' },
      { field: 'body.citizen', issue: 'unrecognized_key', message: 'This field is not allowed.' },
    ]);
  });

  it('rejects a missing body, arrays and wrong types', async () => {
    expect((await request(app).post('/api/v1/notes')).body.error.details[0].field).toBe('body.title');
    expect((await post([{ title: 'Broken bench' }])).status).toBe(400);
    expect((await post({ title: 12345 })).body.error.details[0].issue).toBe('invalid_type');
  });

  it('rejects malformed IDs in route params', async () => {
    const res = await request(app).get('/api/v1/notes/not-an-id');
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe('params.id');
  });

  it('normalizes complaint public IDs', async () => {
    expect((await request(app).get('/api/v1/complaints/cf-2026-00141')).body.data).toEqual({ publicId: 'CF-2026-00141' });
    expect((await request(app).get('/api/v1/complaints/141')).status).toBe(400);
  });

  it('passes valid IDs through to the handler', async () => {
    const res = await request(app).get('/api/v1/notes/0123456789abcdef01234567');
    expect(res.status).toBe(404);
    expect(res.body.error).toEqual({ code: 'NOT_FOUND', message: 'Note was not found.', details: [] });
  });
});

describe('content types', () => {
  it('rejects non-JSON bodies with 415', async () => {
    const res = await request(app).post('/api/v1/notes').set('Content-Type', 'text/plain').send('title=hello');
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects form-encoded bodies with 415', async () => {
    const res = await request(app).post('/api/v1/notes').type('form').send({ title: 'Broken bench' });
    expect(res.status).toBe(415);
  });

  it('accepts JSON with a charset parameter', async () => {
    const res = await request(app)
      .post('/api/v1/notes')
      .set('Content-Type', 'application/json; charset=utf-8')
      .send(JSON.stringify({ title: 'Broken bench' }));
    expect(res.status).toBe(201);
  });
});

describe('pagination', () => {
  const list = (qs: string) => request(app).get(`/api/v1/notes?${qs}`);

  it('applies defaults and computes skip/limit and sort', async () => {
    const res = await list('page=3&limit=10&sort=priority');
    expect(res.body.data).toEqual({ skipLimit: { skip: 20, limit: 10 }, sort: { priority: 1 } });
    expect(res.body.meta.pagination).toMatchObject({ page: 3, limit: 10, totalPages: 5, hasNextPage: true });
    expect((await list('')).body.data.sort).toEqual({ createdAt: -1 });
  });

  it('enforces the maximum page size', async () => {
    expect((await list(`limit=${MAX_LIMIT}`)).status).toBe(200);
    const res = await list(`limit=${MAX_LIMIT + 1}`);
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe('query.limit');
  });

  it.each(['page=0', 'page=-1', 'page=1.5', 'page=abc', 'page=1e3', 'page=+2', 'limit=0', 'page=99999999999999999999', 'page=1&page=2'])(
    'rejects %s',
    async (qs) => {
      const res = await list(qs);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    },
  );

  it('rejects unknown query parameters and sort fields', async () => {
    expect((await list('pageSize=10')).body.error.details[0]).toMatchObject({ field: 'query.pageSize', issue: 'unrecognized_key' });
    expect((await list('sort=passwordHash')).status).toBe(400);
    expect((await list('sort=createdAt;drop')).status).toBe(400);
  });
});

describe('error mapping and safety', () => {
  it('hides internal error details and stack traces in production', async () => {
    for (const path of ['/api/v1/boom', '/api/v1/async-boom']) {
      const res = await request(app).get(path);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Try again later.', details: [] },
        requestId: res.headers['x-request-id'],
      });
      expect(res.text).not.toMatch(/hunter2|db\.internal|secretField|at /);
    }
  });

  it('maps duplicate keys to 409 without echoing the value', async () => {
    const res = await request(app).get('/api/v1/conflict');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body.error.details).toEqual([{ field: 'email', issue: 'duplicate', message: 'This value is already in use.' }]);
    expect(res.text).not.toContain('a@b.co');
  });

  it('maps Mongoose validation and cast errors to 400', async () => {
    const v = await request(app).get('/api/v1/mongoose-invalid');
    expect(v.status).toBe(400);
    expect(v.body.error.details[0].field).toBe('email');
    const c = await request(app).get('/api/v1/cast');
    expect(c.status).toBe(400);
    expect(c.body.error.details[0]).toMatchObject({ field: '_id', issue: 'invalid_type' });
  });

  it('passes known application errors through with their status', async () => {
    const res = await request(app).get('/api/v1/forbidden');
    expect(res.status).toBe(403);
    expect(res.body.error).toEqual({ code: 'FORBIDDEN', message: 'You cannot do that.', details: [] });
  });

  it('keeps health endpoints in their probe format', async () => {
    expect((await request(app).get('/health/live')).body).toEqual({ status: 'ok' });
    expect((await request(app).get('/health/ready')).body).toEqual({ status: 'ready', checks: { database: 'up' } });
  });
});

describe('rate limiting helper', () => {
  it('returns the standard 429 error after the limit', async () => {
    const limited = makeApp();
    expect((await request(limited).get('/api/v1/limited')).status).toBe(200);
    expect((await request(limited).get('/api/v1/limited')).status).toBe(200);
    const res = await request(limited).get('/api/v1/limited');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(res.headers.ratelimit).toBeDefined();
  });
});

describe('logging', () => {
  it('logs 4xx once with its error code, and 5xx with a server-side stack', async () => {
    const lines: Record<string, any>[] = [];
    const sink = new Writable({
      write(chunk, _e, cb) {
        lines.push(JSON.parse(String(chunk)));
        cb();
      },
    });
    const logged = makeApp({ logger: createLogger({ logLevel: 'info', nodeEnv: 'test' }, sink) });

    await request(logged).post('/api/v1/notes').set('Content-Type', 'application/json').send('{"title":"x"}');
    const fourxx = lines.filter((l) => l.requestId === lines.at(-1)!.requestId);
    expect(fourxx).toHaveLength(1);
    expect(fourxx[0]).toMatchObject({ level: 'warn', status: 400, errorCode: 'VALIDATION_ERROR' });
    expect(JSON.stringify(fourxx)).not.toContain('"title"'); // body never logged

    lines.length = 0;
    await request(logged).get('/api/v1/boom');
    const unexpected = lines.find((l) => l.msg === 'unexpected error');
    expect(unexpected?.err.stack).toContain('Error');
    expect(JSON.stringify(lines)).not.toContain('hunter2'); // connection string redacted
  });
});
