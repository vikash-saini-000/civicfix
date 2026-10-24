// Phase 6: complaint creation, scoped listing and retrieval, triage actions.
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server-core';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type AppDeps } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import { AuditLog, AuthSession, Complaint, Counter, Department, DepartmentMembership, User } from '../src/models/index.js';
import { canTransition, COMPLAINT_TRANSITIONS, transitionFor } from '../src/policies/complaintLifecycle.js';
import { createLogger } from '../src/utils/logger.js';
import { testAuthConfig } from './helpers.js';

const PASSWORD = 'phase six password';
const many = { windowMs: 60_000, limit: 10_000 };
const makeApp = (overrides: Partial<AppDeps> = {}) =>
  createApp({
    config: { nodeEnv: 'test', corsOrigins: ['http://localhost:5173'], jsonBodyLimit: '100kb', auth: testAuthConfig },
    logger: createLogger({ logLevel: 'silent', nodeEnv: 'test' }),
    isDatabaseConnected: () => true,
    checkDatabase: async () => true,
    isShuttingDown: () => false,
    authRateLimits: { register: many, loginPerIp: many, loginPerIpAndEmail: many, refresh: many },
    complaintCreateLimit: many,
    ...overrides,
  });
const app = makeApp();

const MODELS = [User, Department, DepartmentMembership, AuthSession, Complaint, Counter] as unknown as (typeof User)[];
let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { dbName: 'civicfix-phase6-test' });
  await Promise.all(MODELS.map((m) => m.syncIndexes()));
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

type Actor = { id: string; token: string };
let admin: Actor, alice: Actor, bob: Actor, roadsMember: Actor, roadsManager: Actor, waterManager: Actor, revoked: Actor;
let roads: string, water: string, closedDept: string;

const hash = await hashPassword(PASSWORD);
async function actor(email: string, platformRole: 'CITIZEN' | 'PLATFORM_ADMIN' = 'CITIZEN'): Promise<Actor> {
  const u = await User.create({ name: email.split('@')[0], email, platformRole, passwordHash: hash });
  const res = await request(app).post('/api/v1/auth/login').set('Content-Type', 'application/json').send(JSON.stringify({ email, password: PASSWORD }));
  return { id: String(u._id), token: res.body.data.accessToken };
}

beforeEach(async () => {
  await Promise.all(MODELS.map((m) => m.deleteMany({})));
  roads = String((await Department.create({ name: 'Roads Test', categories: ['roads', 'drainage'] }))._id);
  water = String((await Department.create({ name: 'Water Test', categories: ['water'] }))._id);
  closedDept = String((await Department.create({ name: 'Closed Test', categories: ['roads'], isActive: false }))._id);
  admin = await actor('admin@t.local', 'PLATFORM_ADMIN');
  alice = await actor('alice@t.local');
  bob = await actor('bob@t.local');
  roadsMember = await actor('rmember@t.local');
  roadsManager = await actor('rmanager@t.local');
  waterManager = await actor('wmanager@t.local');
  revoked = await actor('revoked@t.local');
  await DepartmentMembership.create([
    { user: roadsMember.id, department: roads, role: 'MEMBER' },
    { user: roadsManager.id, department: roads, role: 'MANAGER' },
    { user: waterManager.id, department: water, role: 'MANAGER' },
    { user: revoked.id, department: roads, role: 'MANAGER', status: 'INACTIVE' },
  ]);
});

const call = (method: 'get' | 'post' | 'patch' | 'delete', path: string, who?: Actor, body?: unknown, server = app) => {
  let r = request(server)[method](`/api/v1${path}`);
  if (who) r = r.set('Authorization', `Bearer ${who.token}`);
  if (body !== undefined) r = r.set('Content-Type', 'application/json').send(JSON.stringify(body));
  return r;
};

const valid = {
  title: 'Deep pothole near the bus stop',
  description: 'Large pothole on the service road, two-wheelers swerve into traffic.',
  location: { lat: 13.0072, lng: 74.7956 },
  landmark: 'Surathkal bus stop',
  selectedCategory: 'roads',
};
async function file(who: Actor, overrides: object = {}) {
  const res = await call('post', '/complaints', who, { ...valid, ...overrides });
  expect(res.status).toBe(201);
  return res.body.data.complaint as { publicId: string; id: string };
}
const classify = (publicId: string, departmentId = roads, extra: object = {}) =>
  call('post', `/complaints/${publicId}/classify`, admin, { departmentId, category: 'roads', priority: 'P2', ...extra });
const YEAR = new Date().getUTCFullYear();

// ---- creation ------------------------------------------------------------------
describe('create complaint', () => {
  it('requires authentication', async () => {
    expect((await call('post', '/complaints', undefined, valid)).status).toBe(401);
    expect(await Complaint.countDocuments()).toBe(0);
  });

  it('creates a REPORTED complaint owned by the caller', async () => {
    const res = await call('post', '/complaints', alice, valid);
    expect(res.status).toBe(201);
    const c = res.body.data.complaint;
    expect(c).toMatchObject({
      publicId: `CF-${YEAR}-00001`,
      title: valid.title,
      location: valid.location,
      landmark: 'Surathkal bus stop',
      selectedCategory: 'roads',
      confirmedCategory: null,
      department: null,
      priority: null,
      status: 'REPORTED',
      rejectionReason: null,
      allowedActions: [],
    });
    expect(c.statusHistory).toEqual([{ status: 'REPORTED', at: expect.any(String), note: null }]);
    expect(c.reporter).toBeUndefined(); // the reporter doesn't need their own identity echoed
    expect(res.headers.location).toBe(`/api/v1/complaints/CF-${YEAR}-00001`);
    const stored = await Complaint.findOne({ publicId: c.publicId }).lean();
    expect(String(stored!.citizen)).toBe(alice.id);
    expect(stored!.location.coordinates).toEqual([74.7956, 13.0072]); // GeoJSON [lng, lat]
    expect(await AuditLog.exists({ action: 'complaint.created', targetId: c.id, actor: alice.id })).toBeTruthy();
  });

  it('rejects server-controlled fields and writes nothing', async () => {
    for (const extra of [
      { status: 'RESOLVED' },
      { priority: 'P1' },
      { department: roads },
      { departmentId: roads },
      { confirmedCategory: 'roads' },
      { citizen: bob.id },
      { reporter: { id: bob.id } },
      { publicId: 'CF-2026-99999' },
      { duplicateOf: { complaint: roads } },
    ]) {
      const res = await call('post', '/complaints', alice, { ...valid, ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect(res.body.error.details[0].issue).toBe('unrecognized_key');
    }
    expect(await Complaint.countDocuments()).toBe(0);
    expect(await Counter.countDocuments()).toBe(0); // no ID consumed by rejected requests
  });

  it('validates the payload', async () => {
    const cases: [object, string][] = [
      [{ title: 'Hole' }, 'body.title'],
      [{ description: 'short' }, 'body.description'],
      [{ location: { lat: 91, lng: 74 } }, 'body.location.lat'],
      [{ location: { lat: 13, lng: '74' } }, 'body.location.lng'],
      [{ location: { lat: 13, lng: 74, alt: 2 } }, 'body.location.alt'],
      [{ location: undefined }, 'body.location'],
      [{ selectedCategory: 'bridges' }, 'body.selectedCategory'],
    ];
    for (const [patch, field] of cases) {
      const res = await call('post', '/complaints', alice, { ...valid, ...patch });
      expect(res.status).toBe(400);
      expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain(field);
    }
    expect((await call('post', '/complaints', alice, { ...valid, selectedCategory: null })).status).toBe(201);
  });

  it('issues unique sequential public IDs under concurrency', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => call('post', '/complaints', alice, valid)));
    const ids = results.map((r) => r.body.data.complaint.publicId).sort();
    expect(new Set(ids).size).toBe(10);
    expect(ids[0]).toBe(`CF-${YEAR}-00001`);
    expect(ids[9]).toBe(`CF-${YEAR}-00010`);
  });

  it('rate-limits creation per user', async () => {
    const limited = makeApp({ complaintCreateLimit: { windowMs: 60_000, limit: 2 } });
    expect((await call('post', '/complaints', alice, valid, limited)).status).toBe(201);
    expect((await call('post', '/complaints', alice, valid, limited)).status).toBe(201);
    expect((await call('post', '/complaints', alice, valid, limited)).status).toBe(429);
    expect((await call('post', '/complaints', bob, valid, limited)).status).toBe(201);
  });
});

// ---- visibility -----------------------------------------------------------------
describe('listing and retrieval', () => {
  it('citizens see only their own complaints, and counts do not leak others', async () => {
    await file(alice);
    await file(alice);
    const bobs = await file(bob);
    const res = await call('get', '/complaints', alice);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.every((c: { publicId: string }) => c.publicId !== bobs.publicId)).toBe(true);
    expect(res.body.meta.pagination.total).toBe(2);
  });

  it('another citizen gets the same 404 as for a nonexistent complaint', async () => {
    const c = await file(alice);
    const other = await call('get', `/complaints/${c.publicId}`, bob);
    const missing = await call('get', `/complaints/CF-${YEAR}-99999`, bob);
    expect(other.status).toBe(404);
    expect(other.body.error).toEqual(missing.body.error);
  });

  it('unclassified complaints are hidden from department staff but visible to admins', async () => {
    const c = await file(alice);
    expect((await call('get', `/complaints/${c.publicId}`, roadsManager)).status).toBe(404);
    expect((await call('get', '/complaints?scope=department', roadsManager)).body.data).toHaveLength(0);
    expect((await call('get', `/complaints/${c.publicId}`, admin)).status).toBe(200);
    expect((await call('get', '/complaints?scope=all&unassigned=true', admin)).body.data).toHaveLength(1);
  });

  it('department staff see complaints routed to their department, with reporter name only', async () => {
    const c = await file(alice);
    await classify(c.publicId);
    for (const who of [roadsMember, roadsManager]) {
      const res = await call('get', `/complaints/${c.publicId}`, who);
      expect(res.status).toBe(200);
      expect(res.body.data.complaint.reporter).toEqual({ id: alice.id, name: 'alice' });
      expect(JSON.stringify(res.body)).not.toMatch(/alice@t\.local|passwordHash|citizen"/);
      expect((await call('get', '/complaints?scope=department', who)).body.data.map((x: { publicId: string }) => x.publicId)).toEqual([c.publicId]);
    }
  });

  it('managers cannot reach another department, by detail, list or filter', async () => {
    const c = await file(alice);
    await classify(c.publicId);
    expect((await call('get', `/complaints/${c.publicId}`, waterManager)).status).toBe(404);
    expect((await call('get', '/complaints?scope=department', waterManager)).body.meta.pagination.total).toBe(0);
    expect((await call('get', `/complaints?scope=department&departmentId=${roads}`, waterManager)).status).toBe(403);
    // scope=mine with a departmentId filter only narrows their own complaints.
    expect((await call('get', `/complaints?departmentId=${roads}`, waterManager)).body.data).toHaveLength(0);
  });

  it('revoked memberships grant nothing', async () => {
    const c = await file(alice);
    await classify(c.publicId);
    expect((await call('get', `/complaints/${c.publicId}`, revoked)).status).toBe(404);
    expect((await call('get', '/complaints?scope=department', revoked)).status).toBe(403);
  });

  it('restricts scope=department, scope=all and unassigned', async () => {
    expect((await call('get', '/complaints?scope=department', alice)).status).toBe(403);
    expect((await call('get', '/complaints?scope=all', roadsManager)).status).toBe(403);
    expect((await call('get', '/complaints?unassigned=true', roadsManager)).status).toBe(403);
    expect((await call('get', '/complaints')).status).toBe(401);
  });

  it('admins see everything with scope=all', async () => {
    await file(alice);
    await file(bob);
    const res = await call('get', '/complaints?scope=all', admin);
    expect(res.body.meta.pagination.total).toBe(2);
    expect(res.body.data[0].reporter).toBeDefined();
  });

  it('supports filters, sorting and pagination', async () => {
    const a = await file(alice, { selectedCategory: 'water' });
    const b = await file(alice);
    await file(alice, { selectedCategory: 'garbage' });
    await classify(b.publicId);
    const q = (qs: string) => call('get', `/complaints?${qs}`, alice);

    expect((await q('status=UNDER_REVIEW')).body.data.map((c: { publicId: string }) => c.publicId)).toEqual([b.publicId]);
    expect((await q('status=REPORTED,UNDER_REVIEW')).body.meta.pagination.total).toBe(3);
    expect((await q('category=water')).body.data.map((c: { publicId: string }) => c.publicId)).toEqual([a.publicId]);
    expect((await q('category=roads')).body.data.map((c: { publicId: string }) => c.publicId)).toEqual([b.publicId]);
    expect((await q('priority=P2')).body.data).toHaveLength(1);
    expect((await q('sort=createdAt&limit=1')).body.data[0].publicId).toBe(a.publicId);
    expect((await q('limit=2&page=2')).body.meta.pagination).toMatchObject({ page: 2, total: 3, totalPages: 2, hasNextPage: false });
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect((await q(`createdFrom=${encodeURIComponent(future)}`)).body.data).toHaveLength(0);
    expect((await q(`createdTo=${encodeURIComponent(future)}`)).body.data).toHaveLength(3);
  });

  it('rejects invalid filters and identifiers', async () => {
    for (const qs of ['status=DONE', 'status=', 'scope=everything', 'sort=title', 'createdFrom=yesterday', 'departmentId=xyz', 'limit=500', 'mine=true']) {
      expect((await call('get', `/complaints?${qs}`, alice)).status, qs).toBe(400);
    }
    const later = new Date().toISOString();
    const earlier = new Date(Date.now() - 1000).toISOString();
    expect((await call('get', `/complaints?createdFrom=${later}&createdTo=${earlier}`, alice)).status).toBe(400);
    expect((await call('get', '/complaints/12345', alice)).status).toBe(400);
  });

  it('accepts lower-case public IDs', async () => {
    const c = await file(alice);
    expect((await call('get', `/complaints/${c.publicId.toLowerCase()}`, alice)).body.data.complaint.publicId).toBe(c.publicId);
  });
});

// ---- lifecycle -------------------------------------------------------------------
describe('triage actions', () => {
  it('only admins classify; others are refused without changes', async () => {
    const c = await file(alice);
    for (const who of [alice, roadsManager]) {
      const res = await call('post', `/complaints/${c.publicId}/classify`, who, { departmentId: roads, category: 'roads' });
      expect([403, 404]).toContain(res.status);
    }
    expect(await Complaint.findOne({ publicId: c.publicId }).lean()).toMatchObject({ status: 'REPORTED' });
    expect(await AuditLog.countDocuments({ action: 'complaint.classified', targetId: c.id })).toBe(0); // audit log is append-only
  });

  it('admin classification routes the complaint and records it', async () => {
    const c = await file(alice);
    const res = await classify(c.publicId);
    expect(res.status).toBe(200);
    expect(res.body.data.complaint).toMatchObject({
      status: 'UNDER_REVIEW',
      confirmedCategory: 'roads',
      priority: 'P2',
      department: { id: roads, name: 'Roads Test' },
      allowedActions: ['classify', 'reject'],
    });
    expect(res.body.data.complaint.statusHistory.at(-1)).toMatchObject({ status: 'UNDER_REVIEW', note: 'Sent to Roads Test for review.' });
    const entry = await AuditLog.findOne({ action: 'complaint.classified', targetId: c.id }).lean();
    expect(entry?.changes.map((ch) => ch.field)).toEqual(['department', 'confirmedCategory', 'priority', 'status']);
    // The citizen sees the update.
    expect((await call('get', `/complaints/${c.publicId}`, alice)).body.data.complaint.status).toBe('UNDER_REVIEW');
    // Re-classification during review moves it between departments.
    await call('post', `/complaints/${c.publicId}/classify`, admin, { departmentId: water, category: 'water' });
    expect((await call('get', `/complaints/${c.publicId}`, roadsManager)).status).toBe(404);
    expect((await call('get', `/complaints/${c.publicId}`, waterManager)).status).toBe(200);
  });

  it('refuses departments that are inactive or do not handle the category', async () => {
    const c = await file(alice);
    expect((await classify(c.publicId, water)).body.error.details[0].field).toBe('body.departmentId');
    expect((await classify(c.publicId, closedDept)).status).toBe(400);
    expect((await classify(c.publicId, String(new mongoose.Types.ObjectId()))).status).toBe(400);
    expect((await classify(c.publicId, roads, { priority: 'P0' })).status).toBe(400);
    expect((await Complaint.findOne({ publicId: c.publicId }).lean())!.status).toBe('REPORTED');
  });

  it('managers of the complaint’s department and admins can reject; others cannot', async () => {
    const c = await file(alice);
    await classify(c.publicId);
    const body = { reason: 'Private property, not a municipal road.' };
    expect((await call('post', `/complaints/${c.publicId}/reject`, alice, body)).status).toBe(403);
    expect((await call('post', `/complaints/${c.publicId}/reject`, roadsMember, body)).status).toBe(403);
    expect((await call('post', `/complaints/${c.publicId}/reject`, waterManager, body)).status).toBe(404);
    expect((await Complaint.findOne({ publicId: c.publicId }).lean())!.status).toBe('UNDER_REVIEW');

    const res = await call('post', `/complaints/${c.publicId}/reject`, roadsManager, body);
    expect(res.status).toBe(200);
    expect(res.body.data.complaint).toMatchObject({ status: 'REJECTED', rejectionReason: body.reason, allowedActions: [] });
    expect((await call('get', `/complaints/${c.publicId}`, alice)).body.data.complaint.statusHistory.at(-1)).toMatchObject({
      status: 'REJECTED',
      note: body.reason,
    });
    expect(await AuditLog.exists({ action: 'complaint.rejected', actor: roadsManager.id, reason: body.reason })).toBeTruthy();
  });

  it('enforces the lifecycle: no actions after rejection, and a reason is required', async () => {
    const c = await file(alice);
    expect((await call('post', `/complaints/${c.publicId}/reject`, admin, {})).status).toBe(400);
    expect((await call('post', `/complaints/${c.publicId}/reject`, admin, { reason: 'Duplicate of a fixed issue.' })).status).toBe(200);
    expect((await call('post', `/complaints/${c.publicId}/reject`, admin, { reason: 'Again, again.' })).status).toBe(409);
    expect((await classify(c.publicId)).status).toBe(409);
  });

  it('only one of two concurrent conflicting actions wins', async () => {
    const c = await file(alice);
    const [r1, r2] = await Promise.all([
      call('post', `/complaints/${c.publicId}/reject`, admin, { reason: 'First rejection reason.' }),
      call('post', `/complaints/${c.publicId}/reject`, admin, { reason: 'Second rejection reason.' }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const stored = await Complaint.findOne({ publicId: c.publicId }).lean();
    expect(stored!.statusHistory.filter((h) => h.status === 'REJECTED')).toHaveLength(1);
  });

  it('exposes no generic update or self-service status changes', async () => {
    const c = await file(alice);
    expect((await call('patch', `/complaints/${c.publicId}`, alice, { status: 'RESOLVED' })).status).toBe(404);
    for (const action of ['resolve', 'close', 'assign', 'accept']) {
      expect((await call('post', `/complaints/${c.publicId}/${action}`, admin, {})).status).toBe(404);
    }
    expect((await Complaint.findOne({ publicId: c.publicId }).lean())!.status).toBe('REPORTED');
  });
});

describe('lifecycle policy', () => {
  it('defines later-phase transitions but keeps them unreachable', () => {
    expect(COMPLAINT_TRANSITIONS.length).toBeGreaterThan(10);
    expect(() => transitionFor('assign')).toThrow(/phase 8/);
    expect(() => transitionFor('close')).toThrow(/phase 9/);
    expect(canTransition('close', 'RESOLVED')).toBe(false);
    expect(canTransition('reject', 'IN_PROGRESS')).toBe(false);
    expect(canTransition('classify', 'REPORTED')).toBe(true);
  });
});
