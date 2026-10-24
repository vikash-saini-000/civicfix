// Phase 12: route-level security checks across the whole API surface.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/utils/logger.js';
import { testAuthConfig } from './helpers.js';

const app = createApp({
  config: { nodeEnv: 'production', corsOrigins: ['https://civicfix.example'], jsonBodyLimit: '100kb', auth: { ...testAuthConfig, cookieSecure: true } },
  logger: createLogger({ logLevel: 'silent', nodeEnv: 'test' }),
  isDatabaseConnected: () => true,
  checkDatabase: async () => true,
  isShuttingDown: () => false,
});

const ID = '6adc84e0c2a3b4d5e6f70801';
const CF = 'CF-2026-00001';
const WO = 'WO-2026-00001';

/** Every protected endpoint. Keep in sync with docs/api; each must refuse a request without a token. */
const PROTECTED: [string, string][] = [
  ['get', '/auth/me'],
  ['get', '/users/me'],
  ['patch', '/users/me'],
  ['get', '/departments'],
  ['post', '/departments'],
  ['get', `/departments/${ID}`],
  ['patch', `/departments/${ID}`],
  ['post', `/departments/${ID}/deactivate`],
  ['post', `/departments/${ID}/reactivate`],
  ['get', `/departments/${ID}/members`],
  ['post', `/departments/${ID}/members`],
  ['patch', `/departments/${ID}/members/${ID}`],
  ['delete', `/departments/${ID}/members/${ID}`],
  ['post', '/complaints'],
  ['get', '/complaints'],
  ['get', `/complaints/${CF}`],
  ['post', `/complaints/${CF}/classify`],
  ['post', `/complaints/${CF}/reject`],
  ['post', `/complaints/${CF}/assign`],
  ['get', `/complaints/${CF}/analysis`],
  ['post', `/complaints/${CF}/analysis`],
  ['post', `/complaints/${CF}/evidence?purpose=ADDITIONAL`],
  ['get', `/complaints/${CF}/evidence`],
  ['post', `/complaints/${CF}/disputes`],
  ['post', `/complaints/${CF}/close`],
  ['post', `/complaints/${CF}/feedback`],
  ['get', `/evidence/${ID}/content`],
  ['get', '/work-orders'],
  ['get', `/work-orders/${WO}`],
  ...['assign', 'decline', 'accept', 'start', 'block', 'notes', 'transfer', 'cancel', 'resolution', 'verification'].map((a) => ['post', `/work-orders/${WO}/${a}`] as [string, string]),
  ['get', '/assignments/queue'],
  ['get', '/disputes'],
  ['get', `/disputes/${ID}`],
  ['post', `/disputes/${ID}/review`],
  ['post', `/disputes/${ID}/decision`],
  ['post', `/disputes/${ID}/withdraw`],
  ['get', '/notifications'],
  ['get', '/notifications/unread-count'],
  ['post', '/notifications/read-all'],
  ['post', `/notifications/${ID}/read`],
  ['get', '/audit-logs'],
  ['get', `/audit-logs/${ID}`],
  ['get', '/dashboard/citizen'],
  ['get', '/dashboard/department'],
  ['get', '/dashboard/department/manager'],
  ['get', '/dashboard/admin'],
];

describe('authentication coverage', () => {
  it.each(PROTECTED)('%s %s requires a valid token', async (method, path) => {
    const call = (r: request.Test) => (method === 'get' ? r : r.set('Content-Type', 'application/json').send('{}'));
    const res = await call((request(app) as unknown as Record<string, (p: string) => request.Test>)[method]!(`/api/v1${path}`));
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false, error: { code: 'UNAUTHENTICATED' } });
    const forged = await call((request(app) as unknown as Record<string, (p: string) => request.Test>)[method]!(`/api/v1${path}`).set('Authorization', 'Bearer aaa.bbb.ccc'));
    expect(forged.status).toBe(401);
  });

  it('keeps public endpoints public and nothing else', async () => {
    expect((await request(app).get('/health/live')).status).toBe(200);
    expect((await request(app).post('/api/v1/auth/login').set('Content-Type', 'application/json').send('{}')).status).toBe(400);
    expect((await request(app).post('/api/v1/auth/register').set('Content-Type', 'application/json').send('{}')).status).toBe(400);
  });
});

describe('production-mode hardening', () => {
  it('sends security headers and never leaks internals', async () => {
    const res = await request(app).get('/api/v1/nope');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['content-security-policy']).toBeDefined();
    const bad = await request(app).post('/api/v1/complaints').set('Content-Type', 'application/json').send('{"x":');
    expect(bad.status).toBe(400);
    expect(bad.text).not.toMatch(/at \w+ \(|node_modules|SyntaxError/);
  });

  it('only grants CORS to the configured origin', async () => {
    const good = await request(app).options('/api/v1/complaints').set('Origin', 'https://civicfix.example').set('Access-Control-Request-Method', 'POST');
    expect(good.headers['access-control-allow-origin']).toBe('https://civicfix.example');
    const evil = await request(app).options('/api/v1/complaints').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects non-JSON bodies on JSON endpoints and oversized bodies', async () => {
    expect((await request(app).post('/api/v1/auth/login').set('Content-Type', 'text/plain').send('email=x')).status).toBe(415);
    expect((await request(app).post('/api/v1/auth/login').set('Content-Type', 'application/json').send(JSON.stringify({ email: 'x'.repeat(200_000) }))).status).toBe(413);
  });
});
