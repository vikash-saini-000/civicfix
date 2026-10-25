// Phase 4: authentication and authorization against an in-memory MongoDB.
import { Writable } from 'node:stream';
import { Router } from 'express';
import { SignJWT } from 'jose';
import mongoose from 'mongoose';
import { testMongo } from './mongo.js';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp, type AppDeps } from '../src/app.js';
import { createAuthService } from '../src/auth/authService.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { requireAuth, requireDepartmentRole, requireRole } from '../src/middleware/auth.js';
import { input, validate } from '../src/middleware/validate.js';
import { AuditLog, AuthSession, Department, DepartmentMembership, User } from '../src/models/index.js';
import { authRouter, DEFAULT_AUTH_RATE_LIMITS, type AuthRateLimits } from '../src/routes/auth.js';
import { createLogger } from '../src/utils/logger.js';
import { sendSuccess } from '../src/utils/respond.js';
import { objectId } from '../src/validation/common.js';
import { testAuthConfig } from './helpers.js';

const ORIGIN = 'http://localhost:5173';
const silent = createLogger({ logLevel: 'silent', nodeEnv: 'test' });
const PASSWORD = 'correct horse battery';

let mongo: Awaited<ReturnType<typeof testMongo>>;
beforeAll(async () => {
  mongo = await testMongo();
  await mongoose.connect(mongo.getUri(), { dbName: 'civicfix-auth-test' });
  await Promise.all([User.syncIndexes(), AuthSession.syncIndexes(), DepartmentMembership.syncIndexes(), Department.syncIndexes()]);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  await Promise.all([User.deleteMany({}), AuthSession.deleteMany({}), DepartmentMembership.deleteMany({}), Department.deleteMany({})]);
});

const generous: AuthRateLimits = {
  register: { windowMs: 60_000, limit: 1000 },
  loginPerIp: { windowMs: 60_000, limit: 1000 },
  loginPerIpAndEmail: { windowMs: 60_000, limit: 1000 },
  refresh: { windowMs: 60_000, limit: 1000 },
};

function makeApp(overrides: Partial<AppDeps> = {}) {
  return createApp({
    config: { nodeEnv: 'test', corsOrigins: [ORIGIN], jsonBodyLimit: '100kb', auth: testAuthConfig },
    logger: silent,
    isDatabaseConnected: () => true,
    checkDatabase: async () => true,
    isShuttingDown: () => false,
    authRateLimits: generous,
    ...overrides,
  });
}

const app = makeApp();
const json = (path: string) => request(app).post(path).set('Content-Type', 'application/json');
const register = (body: object) => json('/api/v1/auth/register').send(JSON.stringify(body));
const login = (email: string, password = PASSWORD) => json('/api/v1/auth/login').send(JSON.stringify({ email, password }));
const me = (token: string) => request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);

function refreshCookie(res: request.Response): string {
  const raw = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('civicfix_refresh='));
  if (!raw) throw new Error('no refresh cookie');
  return raw.split(';')[0]!;
}
const refresh = (cookie: string, headers: Record<string, string> = { 'X-Requested-With': 'civicfix' }) =>
  request(app).post('/api/v1/auth/refresh').set('Cookie', cookie).set(headers);
const logout = (cookie: string, token?: string) => {
  const r = request(app).post('/api/v1/auth/logout').set('Cookie', cookie).set('X-Requested-With', 'civicfix');
  return token ? r.set('Authorization', `Bearer ${token}`) : r;
};

async function registerCitizen(email = 'asha@example.com') {
  const res = await register({ name: 'Asha', email, password: PASSWORD });
  expect(res.status).toBe(201);
  return { res, token: res.body.data.accessToken as string, cookie: refreshCookie(res) };
}

const SENSITIVE = /passwordHash|\$argon2|refreshTokenHash|rotatedTokenHashes|civicfix_refresh=[^;]{10}/;

describe('registration', () => {
  it('creates a citizen, returns a session, and never exposes secrets', async () => {
    const { res, token } = await registerCitizen('  Asha@Example.COM ');
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      user: { name: 'Asha', email: 'asha@example.com', platformRole: 'CITIZEN', roles: ['CITIZEN'], memberships: [] },
      tokenType: 'Bearer',
      expiresIn: 900,
    });
    expect(Object.keys(res.body.data.user).sort()).toEqual(['createdAt', 'email', 'id', 'memberships', 'name', 'platformRole', 'roles']);
    expect(JSON.stringify(res.body)).not.toMatch(SENSITIVE);
    expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
    expect(res.headers['cache-control']).toBe('no-store');
    expect((await me(token)).status).toBe(200);
  });

  it('sets a hardened refresh cookie', async () => {
    const { res } = await registerCitizen();
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('civicfix_refresh='))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).not.toMatch(/Domain=/i);
    expect(cookie).toMatch(/Expires=/);
  });

  it('stores an Argon2id hash that verifies, and only a hash of the refresh token', async () => {
    const { cookie } = await registerCitizen();
    const user = await User.findOne({ email: 'asha@example.com' }).select('+passwordHash').orFail();
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(user.passwordHash, PASSWORD)).toBe(true);
    expect(await verifyPassword(user.passwordHash, 'wrong password')).toBe(false);
    const session = await AuthSession.findOne({ user: user._id }).orFail();
    expect(session.refreshTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(cookie).not.toContain(session.refreshTokenHash);
  });

  it('rejects invalid input with field details', async () => {
    const res = await register({ name: '', email: 'not-an-email', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { field: string }) => d.field).sort()).toEqual(['body.email', 'body.name', 'body.password']);
    expect((await register({ name: 'A', email: 'a@b.co', password: 'x'.repeat(129) })).status).toBe(400);
  });

  it('rejects attempts to set privileged fields and creates nothing', async () => {
    for (const extra of [{ platformRole: 'PLATFORM_ADMIN' }, { accountStatus: 'ACTIVE' }, { role: 'DEPARTMENT_MANAGER' }, { department: '0123456789abcdef01234567' }]) {
      const res = await register({ name: 'Eve', email: 'eve@example.com', password: PASSWORD, ...extra });
      expect(res.status).toBe(400);
      expect(res.body.error.details[0].issue).toBe('unrecognized_key');
    }
    expect(await User.countDocuments()).toBe(0);
  });

  it('returns 409 for an existing email in any case', async () => {
    await registerCitizen();
    const res = await register({ name: 'Other', email: 'ASHA@example.com', password: PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual([{ field: 'body.email', issue: 'duplicate', message: 'This email is already registered.' }]);
  });

  it('keeps exactly one account under concurrent registrations', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => register({ name: 'Race', email: 'race@example.com', password: PASSWORD })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    expect(await User.countDocuments({ email: 'race@example.com' })).toBe(1);
  });

  it('does not trim or alter passwords', async () => {
    await register({ name: 'Spaces', email: 'sp@example.com', password: '  spaced out pass  ' });
    expect((await login('sp@example.com', 'spaced out pass')).status).toBe(401);
    expect((await login('sp@example.com', '  spaced out pass  ')).status).toBe(200);
  });
});

describe('login', () => {
  it('signs in with the right password', async () => {
    await registerCitizen();
    const res = await login('ASHA@example.com');
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe('asha@example.com');
    expect((await me(res.body.data.accessToken)).status).toBe(200);
  });

  it('gives the same answer for a wrong password and an unknown account', async () => {
    await registerCitizen();
    const wrong = await login('asha@example.com', 'not the password');
    const unknown = await login('nobody@example.com', 'not the password');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error).toEqual({ code: 'INVALID_CREDENTIALS', message: 'The email or password is incorrect.', details: [] });
    expect(unknown.body.error).toEqual(wrong.body.error);
    expect(wrong.headers['set-cookie']).toBeUndefined();
  });

  it('rejects suspended accounts with the same generic error, and cuts off their live tokens', async () => {
    const { token } = await registerCitizen();
    await User.updateOne({ email: 'asha@example.com' }, { accountStatus: 'SUSPENDED' });
    const res = await login('asha@example.com');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    expect((await me(token)).status).toBe(401);
  });

  it('rate-limits repeated attempts per IP and email without blocking other accounts', async () => {
    const limited = makeApp({ authRateLimits: { ...DEFAULT_AUTH_RATE_LIMITS, loginPerIpAndEmail: { windowMs: 60_000, limit: 3 } } });
    const attempt = (email: string) =>
      request(limited).post('/api/v1/auth/login').set('Content-Type', 'application/json').send(JSON.stringify({ email, password: 'guess-guess' }));
    for (let i = 0; i < 3; i++) expect((await attempt('victim@example.com')).status).toBe(401);
    const blocked = await attempt('Victim@Example.com');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect((await attempt('someone-else@example.com')).status).toBe(401);
  });

  it('never logs passwords or tokens', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _e, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const logged = makeApp({ logger: createLogger({ logLevel: 'trace', nodeEnv: 'test' }, sink) });
    const reg = await request(logged)
      .post('/api/v1/auth/register')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ name: 'Log', email: 'log@example.com', password: PASSWORD }));
    await request(logged).post('/api/v1/auth/login').set('Content-Type', 'application/json').send(JSON.stringify({ email: 'log@example.com', password: 'wrong-wrong' }));
    await request(logged).get('/api/v1/auth/me').set('Authorization', `Bearer ${reg.body.data.accessToken}`);
    const all = lines.join('\n');
    expect(lines.length).toBeGreaterThan(0);
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain('wrong-wrong');
    expect(all).not.toContain(reg.body.data.accessToken);
    expect(all).not.toContain('log@example.com');
  });
});

describe('access tokens', () => {
  it('rejects missing, malformed, tampered, foreign-key, expired and alg=none tokens', async () => {
    const { token } = await registerCitizen();
    const missing = await request(app).get('/api/v1/auth/me');
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe('UNAUTHENTICATED');
    expect(missing.headers['www-authenticate']).toBe('Bearer');

    const [h, p, s] = token.split('.');
    const claims = JSON.parse(Buffer.from(p!, 'base64url').toString());
    const forged = (payload: object, key = testAuthConfig.jwtSecret, exp = '15m') =>
      new SignJWT(payload as Record<string, unknown>)
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(claims.sub)
        .setIssuer(claims.iss)
        .setAudience(claims.aud)
        .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
        .setExpirationTime(exp)
        .sign(new TextEncoder().encode(key));

    const bad = [
      'garbage',
      `${h}.${Buffer.from(JSON.stringify({ ...claims, sub: '0123456789abcdef01234567' })).toString('base64url')}.${s}`, // tampered
      await forged({ sid: claims.sid, typ: 'access' }, 'another-secret-key-of-sufficient-length!'), // wrong key
      await forged({ sid: claims.sid, typ: 'access' }, testAuthConfig.jwtSecret, Math.floor(Date.now() / 1000) - 60 as never), // expired
      await forged({ sid: claims.sid, typ: 'refresh' }), // wrong type
      `${Buffer.from('{"alg":"none"}').toString('base64url')}.${p}.`, // unsigned
    ];
    for (const t of bad) {
      const res = await me(t);
      expect(res.status, t.slice(0, 20)).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
    expect((await request(app).get('/api/v1/auth/me').set('Authorization', `Basic ${token}`)).status).toBe(401);
  });

  it('/me returns only safe fields', async () => {
    const { token } = await registerCitizen();
    const res = await me(token);
    expect(res.body.data.user).toMatchObject({ email: 'asha@example.com', roles: ['CITIZEN'] });
    expect(JSON.stringify(res.body)).not.toMatch(SENSITIVE);
    expect(JSON.stringify(res.body)).not.toMatch(/sessionId|sid/);
  });
});

describe('refresh and logout', () => {
  it('requires the CSRF header and a trusted origin', async () => {
    const { cookie } = await registerCitizen();
    expect((await refresh(cookie, {})).status).toBe(403);
    const evil = await refresh(cookie, { 'X-Requested-With': 'civicfix', Origin: 'https://evil.example' });
    expect(evil.status).toBe(403);
    expect(evil.body.error.code).toBe('FORBIDDEN');
    expect((await refresh(cookie, { 'X-Requested-With': 'civicfix', Origin: ORIGIN })).status).toBe(200);
  });

  it('rotates the refresh token and issues a new access token', async () => {
    const { cookie } = await registerCitizen();
    const res = await refresh(cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    const next = refreshCookie(res);
    expect(next).not.toBe(cookie);
    expect((await me(res.body.data.accessToken)).status).toBe(200);
    expect((await refresh(next)).status).toBe(200);
  });

  it('treats reuse of a rotated refresh token as theft and revokes the session', async () => {
    const { cookie, token } = await registerCitizen();
    const rotated = await refresh(cookie);
    const replay = await refresh(cookie);
    expect(replay.status).toBe(401);
    expect(replay.headers['set-cookie']?.[0]).toMatch(/civicfix_refresh=;/);
    // Everything from that session is now dead.
    expect((await refresh(refreshCookie(rotated))).status).toBe(401);
    expect((await me(rotated.body.data.accessToken)).status).toBe(401);
    expect((await me(token)).status).toBe(401);
    expect(await AuthSession.findOne({ revokedReason: 'REFRESH_TOKEN_REUSE' })).toBeTruthy();
  });

  it('rejects refresh without a cookie or with an unknown one', async () => {
    expect((await request(app).post('/api/v1/auth/refresh').set('X-Requested-With', 'civicfix')).status).toBe(401);
    expect((await refresh('civicfix_refresh=' + 'A'.repeat(43))).status).toBe(401);
  });

  it('logout revokes the session immediately and clears the cookie', async () => {
    const { cookie, token } = await registerCitizen();
    const res = await logout(cookie, token);
    expect(res.status).toBe(204);
    expect(([] as string[]).concat(res.headers['set-cookie'] ?? [])[0]).toMatch(/civicfix_refresh=;.*Expires=Thu, 01 Jan 1970/);
    expect((await me(token)).status).toBe(401);
    expect((await refresh(cookie)).status).toBe(401);
  });

  it('logout works with only the cookie, is idempotent, and needs the CSRF header', async () => {
    const { cookie, token } = await registerCitizen();
    expect((await request(app).post('/api/v1/auth/logout').set('Cookie', cookie)).status).toBe(403);
    expect((await logout(cookie)).status).toBe(204);
    expect((await me(token)).status).toBe(401);
    expect((await logout(cookie)).status).toBe(204);
    expect((await request(app).post('/api/v1/auth/logout').set('X-Requested-With', 'civicfix')).status).toBe(204);
  });

  it('logging out one device leaves the others signed in', async () => {
    const a = await registerCitizen();
    const b = await login('asha@example.com');
    await logout(a.cookie, a.token);
    expect((await me(a.token)).status).toBe(401);
    expect((await me(b.body.data.accessToken)).status).toBe(200);
  });

  it('writes audit entries without secrets', async () => {
    const { cookie, token } = await registerCitizen();
    await login('asha@example.com', 'bad password!');
    await logout(cookie, token);
    // AuditLog is append-only, so filter to this test's user instead of clearing it.
    const user = await User.findOne({ email: 'asha@example.com' }).orFail();
    const entries = await AuditLog.find({ targetId: user._id }).sort({ createdAt: 1 }).lean();
    expect(entries.map((a) => a.action)).toEqual(['user.registered', 'auth.login_failed', 'auth.logout']);
    expect(entries[1]).toMatchObject({ outcome: 'DENIED', reason: 'wrong password', actorType: 'USER' });
    expect(JSON.stringify(entries)).not.toMatch(/argon2|bad password|[0-9a-f]{64}|eyJ/);
  });
});

describe('authorization guards', () => {
  const authService = createAuthService(testAuthConfig, silent);
  const guarded = Router();
  guarded.use('/auth', authRouter({ authService, authConfig: testAuthConfig, corsOrigins: [ORIGIN], rateLimits: generous }));
  guarded.get('/admin-only', requireAuth(authService), requireRole('PLATFORM_ADMIN'), (_req, res) => sendSuccess(res, { ok: true }));
  guarded.get('/staff', requireAuth(authService), requireRole('DEPARTMENT_MEMBER', 'DEPARTMENT_MANAGER'), (_req, res) => sendSuccess(res, { ok: true }));
  guarded.get(
    '/departments/:departmentId/queue',
    requireAuth(authService),
    validate({ params: z.strictObject({ departmentId: objectId }) }),
    requireDepartmentRole((req) => input<{ departmentId: string }>(req, 'params').departmentId, ['MANAGER']),
    (_req, res) => sendSuccess(res, { ok: true }),
  );
  // Tries to "promote" via request data; the guard must ignore it.
  guarded.post('/admin-only', requireAuth(authService), requireRole('PLATFORM_ADMIN'), (_req, res) => sendSuccess(res, { ok: true }));
  const gApp = makeApp({ api: guarded });

  const gLogin = async (email: string) => {
    const res = await request(gApp).post('/api/v1/auth/login').set('Content-Type', 'application/json').send(JSON.stringify({ email, password: PASSWORD }));
    expect(res.status).toBe(200);
    return res.body.data.accessToken as string;
  };
  const get = (path: string, token?: string) => {
    const r = request(gApp).get(path);
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  };
  const makeUser = async (email: string, platformRole: 'CITIZEN' | 'PLATFORM_ADMIN' = 'CITIZEN') =>
    User.create({ name: email, email, platformRole, passwordHash: await hashPassword(PASSWORD) });

  it('requires authentication before checking roles', async () => {
    const res = await get('/api/v1/admin-only');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('allows a platform admin and forbids a citizen', async () => {
    await makeUser('admin@example.com', 'PLATFORM_ADMIN');
    await makeUser('citizen@example.com');
    expect((await get('/api/v1/admin-only', await gLogin('admin@example.com'))).status).toBe(200);
    const denied = await get('/api/v1/admin-only', await gLogin('citizen@example.com'));
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ success: false, error: { code: 'FORBIDDEN', details: [] } });
  });

  it('ignores role claims in body, query and headers', async () => {
    await makeUser('citizen@example.com');
    const token = await gLogin('citizen@example.com');
    const res = await request(gApp)
      .post('/api/v1/admin-only?role=PLATFORM_ADMIN')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Role', 'PLATFORM_ADMIN')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ platformRole: 'PLATFORM_ADMIN', roles: ['PLATFORM_ADMIN'] }));
    expect(res.status).toBe(403);
  });

  it('sees role changes on the next request (roles are not baked into tokens)', async () => {
    const user = await makeUser('promoted@example.com');
    const token = await gLogin('promoted@example.com');
    expect((await get('/api/v1/admin-only', token)).status).toBe(403);
    await User.updateOne({ _id: user._id }, { platformRole: 'PLATFORM_ADMIN' });
    expect((await get('/api/v1/admin-only', token)).status).toBe(200);
  });

  it('scopes department roles to the department, active memberships and active departments', async () => {
    const roads = await Department.create({ name: 'Roads', categories: ['roads'] });
    const water = await Department.create({ name: 'Water', categories: ['water'] });
    const closed = await Department.create({ name: 'Closed', categories: ['other'], isActive: false });
    const mgr = await makeUser('mgr@example.com');
    await DepartmentMembership.create({ user: mgr._id, department: roads._id, role: 'MANAGER' });
    await DepartmentMembership.create({ user: mgr._id, department: water._id, role: 'MEMBER' });
    await DepartmentMembership.create({ user: mgr._id, department: closed._id, role: 'MANAGER' });
    const token = await gLogin('mgr@example.com');

    expect((await get(`/api/v1/departments/${roads._id}/queue`, token)).status).toBe(200);
    expect((await get(`/api/v1/departments/${water._id}/queue`, token)).status).toBe(403); // member, not manager
    expect((await get(`/api/v1/departments/${closed._id}/queue`, token)).status).toBe(403); // inactive department
    expect((await get(`/api/v1/departments/${new mongoose.Types.ObjectId()}/queue`, token)).status).toBe(403);
    expect((await get('/api/v1/staff', token)).status).toBe(200);

    await DepartmentMembership.updateOne({ user: mgr._id, department: roads._id }, { status: 'INACTIVE' });
    expect((await get(`/api/v1/departments/${roads._id}/queue`, token)).status).toBe(403);
  });

  it('does not let platform admins into department routes unless allowed explicitly', async () => {
    const roads = await Department.create({ name: 'Roads', categories: ['roads'] });
    await makeUser('admin@example.com', 'PLATFORM_ADMIN');
    expect((await get(`/api/v1/departments/${roads._id}/queue`, await gLogin('admin@example.com'))).status).toBe(403);
    expect((await get('/api/v1/staff', await gLogin('admin@example.com'))).status).toBe(403);
  });

  it('fails closed on unknown or empty role lists and unknown stored roles', async () => {
    expect(() => requireRole('SUPERUSER' as never)).toThrow(/unknown/);
    expect(() => requireRole()).toThrow();
    expect(() => requireDepartmentRole(() => 'x', [])).toThrow();
    const odd = await makeUser('odd@example.com');
    await User.collection.updateOne({ _id: odd._id }, { $set: { platformRole: 'ROOT' } });
    const res = await request(gApp).post('/api/v1/auth/login').set('Content-Type', 'application/json').send(JSON.stringify({ email: 'odd@example.com', password: PASSWORD }));
    expect(res.body.data.user.roles).toEqual([]);
    expect((await get('/api/v1/admin-only', res.body.data.accessToken)).status).toBe(403);
  });
});

describe('CORS for credentialed requests', () => {
  it('allows the trusted origin with credentials and the CSRF header', async () => {
    const res = await request(app)
      .options('/api/v1/auth/refresh')
      .set('Origin', ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'x-requested-with,content-type,authorization');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('gives untrusted origins no CORS grant', async () => {
    const res = await request(app).options('/api/v1/auth/refresh').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
    // Without Access-Control-Allow-Origin the browser blocks the response, whatever other CORS headers say.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('Turnstile on register and login', () => {
  const verifier = { enabled: true, verify: async (token: string, _ip: string | undefined, action: string) => token === `ok-${action}` };
  const guarded = makeApp({ captcha: verifier });
  const post = (path: string, body: object, token?: string) => {
    const r = request(guarded).post(path).set('Content-Type', 'application/json');
    return (token ? r.set('X-Turnstile-Token', token) : r).send(JSON.stringify(body));
  };

  it('refuses register and login without a valid token for that action', async () => {
    const body = { name: 'Asha', email: 'asha@example.com', password: PASSWORD };
    expect((await post('/api/v1/auth/register', body)).body.error.code).toBe('CAPTCHA_REQUIRED');
    expect((await post('/api/v1/auth/register', body, 'ok-login')).status).toBe(403);
    expect(await User.countDocuments()).toBe(0);
    expect((await post('/api/v1/auth/register', body, 'ok-register')).status).toBe(201);
    expect((await post('/api/v1/auth/login', { email: body.email, password: PASSWORD })).status).toBe(403);
    expect((await post('/api/v1/auth/login', { email: body.email, password: PASSWORD }, 'ok-login')).status).toBe(200);
  });

  it('validates the body before spending the token', async () => {
    const res = await post('/api/v1/auth/register', { email: 'not-an-email' });
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
