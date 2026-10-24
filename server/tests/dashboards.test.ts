// Phase 11: dashboards. Data is seeded directly so counts are exact.
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import { AIAnalysis, AuthSession, Complaint, Department, DepartmentMembership, Dispute, Notification, User, WorkOrder } from '../src/models/index.js';
import { createLogger } from '../src/utils/logger.js';
import type { ComplaintStatus, WorkOrderStatus } from '../src/models/enums.js';
import { testAuthConfig } from './helpers.js';
import { testMongo } from './mongo.js';

const many = { windowMs: 60_000, limit: 10_000 };
const app = createApp({
  config: { nodeEnv: 'test', corsOrigins: [], jsonBodyLimit: '100kb', auth: testAuthConfig },
  logger: createLogger({ logLevel: 'silent', nodeEnv: 'test' }),
  isDatabaseConnected: () => true,
  checkDatabase: async () => true,
  isShuttingDown: () => false,
  authRateLimits: { register: many, loginPerIp: many, loginPerIpAndEmail: many, refresh: many },
});
const MODELS = [User, Department, DepartmentMembership, AuthSession, Complaint, WorkOrder, Dispute, Notification, AIAnalysis] as unknown as (typeof User)[];
beforeAll(async () => {
  const mongo = await testMongo();
  await mongoose.connect(mongo.getUri(), { dbName: 'civicfix-phase11-test' });
  await Promise.all(MODELS.map((m) => m.syncIndexes()));
});
afterAll(async () => {
  await mongoose.disconnect();
});

type Actor = { id: string; token: string };
let admin: Actor, alice: Actor, bob: Actor, mgr: Actor, w1: Actor, w2: Actor, waterMgr: Actor;
let roads: mongoose.Types.ObjectId, water: mongoose.Types.ObjectId;
const PASSWORD = 'phase eleven password';
const hash = await hashPassword(PASSWORD);
async function actor(email: string, platformRole: 'CITIZEN' | 'PLATFORM_ADMIN' = 'CITIZEN'): Promise<Actor> {
  const u = await User.create({ name: email.split('@')[0], email, platformRole, passwordHash: hash });
  const res = await request(app).post('/api/v1/auth/login').set('Content-Type', 'application/json').send(JSON.stringify({ email, password: PASSWORD }));
  return { id: String(u._id), token: res.body.data.accessToken };
}
const HOUR = 3_600_000;
const ago = (h: number) => new Date(Date.now() - h * HOUR);
let seq = 0;
async function complaint(citizen: Actor, status: ComplaintStatus, dept: mongoose.Types.ObjectId | null, extra: Record<string, unknown> = {}) {
  const c = await Complaint.create({
    publicId: `CF-2026-${String(++seq).padStart(5, '0')}`,
    citizen: citizen.id,
    title: `Complaint number ${seq}`,
    description: 'A civic problem that needs fixing.',
    location: { type: 'Point', coordinates: [74.79, 13.0] },
    selectedCategory: dept && dept.equals(water) ? 'water' : 'roads',
    status,
    department: dept ?? undefined,
    rejectionReason: status === 'REJECTED' ? 'Not municipal' : undefined,
    ...extra,
  });
  if (extra.createdAt) await Complaint.collection.updateOne({ _id: c._id }, { $set: { createdAt: extra.createdAt } });
  return c;
}
async function workOrder(c: { _id: mongoose.Types.ObjectId }, dept: mongoose.Types.ObjectId, status: WorkOrderStatus, assignee: Actor | null, extra: Record<string, unknown> = {}) {
  const open = !['COMPLETED', 'CANCELLED'].includes(status);
  return WorkOrder.create({ publicId: `WO-2026-${String(++seq).padStart(5, '0')}`, complaint: c._id, activeFor: open ? c._id : undefined, department: dept, priority: 'P3', status, assignee: assignee?.id, dueAt: new Date(Date.now() + 48 * HOUR), blockedReason: status === 'BLOCKED' ? 'Waiting' : undefined, blockedNextAction: status === 'BLOCKED' ? 'Resume' : undefined, ...extra });
}

beforeEach(async () => {
  await Promise.all(MODELS.map((m) => m.deleteMany({})));
  roads = (await Department.create({ name: 'A Roads', categories: ['roads'] }))._id;
  water = (await Department.create({ name: 'B Water', categories: ['water'] }))._id;
  admin = await actor('admin@t.local', 'PLATFORM_ADMIN');
  alice = await actor('alice@t.local');
  bob = await actor('bob@t.local');
  mgr = await actor('mgr@t.local');
  w1 = await actor('w1@t.local');
  w2 = await actor('w2@t.local');
  waterMgr = await actor('wmgr@t.local');
  await DepartmentMembership.create([
    { user: mgr.id, department: roads, role: 'MANAGER' },
    { user: w1.id, department: roads, role: 'MEMBER' },
    { user: w2.id, department: roads, role: 'MEMBER' },
    { user: waterMgr.id, department: water, role: 'MANAGER' },
  ]);

  // alice: 1 reported (unrouted), 1 in progress (roads, w1), 1 resolved 10h after creation, 1 rejected
  await complaint(alice, 'REPORTED', null);
  const a2 = await complaint(alice, 'IN_PROGRESS', roads);
  await workOrder(a2, roads, 'IN_PROGRESS', w1);
  const a3 = await complaint(alice, 'RESOLVED', roads, { createdAt: ago(20), resolvedAt: ago(10) });
  const wo3 = await workOrder(a3, roads, 'COMPLETED', w1);
  await Dispute.create({ complaint: a3._id, workOrder: wo3._id, submittedBy: alice.id, reason: 'Still broken after the repair.', priorResolution: { resolvedAt: ago(10) }, activeFor: a3._id });
  await complaint(alice, 'REJECTED', null);
  // bob: roads blocked (w2, overdue), roads awaiting verification (w1), water assigned
  const b1 = await complaint(bob, 'BLOCKED', roads);
  await workOrder(b1, roads, 'BLOCKED', w2, { dueAt: ago(5) });
  const b2 = await complaint(bob, 'RESOLUTION_SUBMITTED', roads);
  await workOrder(b2, roads, 'RESOLUTION_SUBMITTED', w1, { assignmentSource: 'AUTO' });
  const b3 = await complaint(bob, 'ASSIGNED', water);
  await workOrder(b3, water, 'PENDING_ASSIGNMENT', null);
  // An old complaint, outside a 30-day window.
  await complaint(bob, 'CLOSED', roads, { createdAt: ago(24 * 60), resolvedAt: ago(24 * 50) });

  await Notification.create([
    { recipient: alice.id, type: 'COMPLAINT_RECEIVED', title: 't', message: 'm', complaint: a2._id },
    { recipient: alice.id, type: 'COMPLAINT_RECEIVED', title: 't', message: 'm', complaint: a2._id, readAt: new Date() },
  ]);
  await AIAnalysis.create({ complaint: a2._id, analysisType: 'TRIAGE', status: 'SUCCEEDED', provider: 'fake', modelName: 'm' });
});

const get = (path: string, who?: Actor) => {
  const r = request(app).get(`/api/v1/dashboard${path}`);
  return who ? r.set('Authorization', `Bearer ${who.token}`) : r;
};

describe('citizen dashboard', () => {
  it('counts only the caller’s complaints', async () => {
    const res = await get('/citizen', alice);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const d = res.body.data;
    expect(d.complaints).toMatchObject({ total: 4, active: 2, resolved: 1, rejected: 1, createdInRange: 4 });
    expect(Object.keys(d.complaints.byStatus)).toHaveLength(11);
    expect(d.complaints.byStatus).toMatchObject({ REPORTED: 1, IN_PROGRESS: 1, RESOLVED: 1, REJECTED: 1, BLOCKED: 0 });
    expect(d.recent).toHaveLength(4);
    expect(d.openDisputes).toBe(1);
    expect(d.unreadNotifications).toBe(1);
    const bobView = (await get('/citizen', bob)).body.data;
    expect(bobView.complaints.total).toBe(4);
    expect(bobView.openDisputes).toBe(0);
    expect(JSON.stringify(bobView.recent)).not.toMatch(new RegExp(d.recent.map((r: { publicId: string }) => r.publicId).join('|')));
  });

  it('applies the time range to "created in range" only', async () => {
    const d = (await get('/citizen?period=7d', bob)).body.data;
    expect(d.complaints).toMatchObject({ total: 4, createdInRange: 3 });
  });

  it('returns zeros for a user with no data', async () => {
    const d = (await get('/citizen', mgr)).body.data;
    expect(d.complaints).toMatchObject({ total: 0, active: 0, resolved: 0, createdInRange: 0 });
    expect(d.recent).toEqual([]);
  });
});

describe('department member dashboard', () => {
  it('shows department counts and the caller’s own workload', async () => {
    const d = (await get('/department', w1)).body.data;
    expect(d.department).toEqual({ id: String(roads), name: 'A Roads' });
    expect(d.complaintsByStatus).toMatchObject({ IN_PROGRESS: 1, RESOLVED: 1, BLOCKED: 1, RESOLUTION_SUBMITTED: 1, CLOSED: 1, ASSIGNED: 0 });
    expect(d.myWork).toMatchObject({ open: 2, inProgress: 1, awaitingVerification: 1, blocked: 0, overdue: 0 });
    expect(d.departmentOpenWorkOrders).toBe(3);
    const w2d = (await get('/department', w2)).body.data;
    expect(w2d.myWork).toMatchObject({ open: 1, blocked: 1, overdue: 1 });
  });

  it('is limited to the caller’s departments', async () => {
    expect((await get('/department', alice)).status).toBe(403);
    expect((await get(`/department?departmentId=${water}`, w1)).status).toBe(403);
    expect((await get('/department')).status).toBe(401);
  });
});

describe('manager dashboard', () => {
  it('summarizes the department, workload and resolution time', async () => {
    const d = (await get('/department/manager?period=30d', mgr)).body.data;
    expect(d.workOrders).toMatchObject({ open: 3, unassigned: 0, blocked: 1, overdue: 1, pendingVerification: 1 });
    expect(d.complaints.byCategory).toEqual({ roads: 5 });
    expect(d.complaints.createdInRange).toBe(4);
    expect(d.openDisputes).toBe(1);
    expect(d.resolution).toEqual({ resolvedInRange: 1, averageHoursToResolve: 10 });
    expect(d.workload).toEqual([
      { member: { id: w1.id, name: 'w1' }, role: 'MEMBER', openWorkOrders: 2, overdue: 0 },
      { member: { id: w2.id, name: 'w2' }, role: 'MEMBER', openWorkOrders: 1, overdue: 1 },
      { member: { id: mgr.id, name: 'mgr' }, role: 'MANAGER', openWorkOrders: 0, overdue: 0 },
    ]);
    expect(JSON.stringify(d)).not.toMatch(/@t\.local|alice|bob/);
  });

  it('requires a managerial membership in that department (admins may pick one)', async () => {
    expect((await get('/department/manager', w1)).status).toBe(403);
    expect((await get(`/department/manager?departmentId=${roads}`, waterMgr)).status).toBe(403);
    expect((await get('/department/manager', admin)).status).toBe(400);
    const w = (await get(`/department/manager?departmentId=${water}`, admin)).body.data;
    expect(w.workOrders).toMatchObject({ unassigned: 1, open: 1 });
  });
});

describe('admin dashboard', () => {
  it('shows platform-wide metrics', async () => {
    const d = (await get('/admin', admin)).body.data;
    expect(d.complaints.createdInRange).toBe(7);
    expect(d.complaints.awaitingRouting).toBe(1);
    expect(d.complaints.byStatus).toMatchObject({ REPORTED: 1, REJECTED: 1, CLOSED: 1 });
    expect(d.complaints.intakeByDay.reduce((s: number, x: { count: number }) => s + x.count, 0)).toBe(7);
    expect(d.workOrders).toMatchObject({ open: 4, overdue: 1, pendingVerification: 1 });
    expect(d.workOrders.bySource).toEqual({ AUTO: 1 });
    expect(d.departments).toEqual([
      { id: String(roads), name: 'A Roads', isActive: true, openWorkOrders: 3, overdue: 1 },
      { id: String(water), name: 'B Water', isActive: true, openWorkOrders: 1, overdue: 0 },
    ]);
    expect(d.disputes.open).toBe(1);
    expect(d.ai).toMatchObject({ classificationsInRange: { SUCCEEDED: 1, FAILED: 0 }, autoAssignedInRange: 1 });
  });

  it('is for platform admins only', async () => {
    for (const who of [alice, w1, mgr]) expect((await get('/admin', who)).status).toBe(403);
  });
});

describe('time range validation', () => {
  it.each([
    ['from=2026-10-10T00:00:00Z&to=2026-10-01T00:00:00Z', 'inverted'],
    ['from=2024-01-01T00:00:00Z&to=2026-01-01T00:00:00Z', 'over a year'],
    ['period=7d&from=2026-10-01T00:00:00Z', 'period and from'],
    ['from=yesterday', 'bad date'],
    ['period=1y', 'unknown period'],
    ['userId=6adc84e0c2a3b4d5e6f70801', 'unknown parameter'],
  ])('rejects %s (%s)', async (qs) => {
    const res = await get(`/admin?${qs}`, admin);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('echoes the effective UTC range', async () => {
    const d = (await get('/admin?from=2026-10-01T00:00:00Z&to=2026-10-08T00:00:00Z', admin)).body.data;
    expect(d.range).toEqual({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z' });
  });
});
