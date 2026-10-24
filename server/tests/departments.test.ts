// Phase 5: user profiles, departments and department memberships.
import mongoose from 'mongoose';
import { testMongo } from './mongo.js';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import { AuditLog, AuthSession, Department, DepartmentMembership, User, WorkOrder } from '../src/models/index.js';
import { createLogger } from '../src/utils/logger.js';
import { testAuthConfig } from './helpers.js';

const PASSWORD = 'phase five password';
const many = { windowMs: 60_000, limit: 10_000 };
const app = createApp({
  config: { nodeEnv: 'test', corsOrigins: ['http://localhost:5173'], jsonBodyLimit: '100kb', auth: testAuthConfig },
  logger: createLogger({ logLevel: 'silent', nodeEnv: 'test' }),
  isDatabaseConnected: () => true,
  checkDatabase: async () => true,
  isShuttingDown: () => false,
  authRateLimits: { register: many, loginPerIp: many, loginPerIpAndEmail: many, refresh: many },
});

let mongo: Awaited<ReturnType<typeof testMongo>>;
beforeAll(async () => {
  mongo = await testMongo();
  await mongoose.connect(mongo.getUri(), { dbName: 'civicfix-phase5-test' });
  await Promise.all([User, Department, DepartmentMembership, AuthSession, WorkOrder].map((m) => (m as typeof User).syncIndexes()));
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

// ---- fixtures -------------------------------------------------------------
type Actor = { id: string; token: string; email: string };
let admin: Actor, roadsManager: Actor, roadsMember: Actor, waterManager: Actor, citizen: Actor, newcomer: Actor;
let roads: string, water: string;
let roadsMemberMembership: string, roadsManagerMembership: string, waterManagerMembership: string;

const hash = await hashPassword(PASSWORD);
async function makeActor(email: string, platformRole: 'CITIZEN' | 'PLATFORM_ADMIN' = 'CITIZEN'): Promise<Actor> {
  const user = await User.create({ name: email.split('@')[0], email, platformRole, passwordHash: hash });
  const res = await request(app).post('/api/v1/auth/login').set('Content-Type', 'application/json').send(JSON.stringify({ email, password: PASSWORD }));
  expect(res.status).toBe(200);
  return { id: String(user._id), token: res.body.data.accessToken, email };
}

beforeEach(async () => {
  await Promise.all([User, Department, DepartmentMembership, AuthSession, WorkOrder].map((m) => (m as typeof User).deleteMany({})));
  roads = String((await Department.create({ name: 'Roads Test Dept', categories: ['roads'] }))._id);
  water = String((await Department.create({ name: 'Water Test Dept', categories: ['water'] }))._id);
  admin = await makeActor('admin@test.local', 'PLATFORM_ADMIN');
  citizen = await makeActor('citizen@test.local');
  newcomer = await makeActor('newcomer@test.local');
  roadsManager = await makeActor('roads.manager@test.local');
  roadsMember = await makeActor('roads.member@test.local');
  waterManager = await makeActor('water.manager@test.local');
  roadsManagerMembership = String((await DepartmentMembership.create({ user: roadsManager.id, department: roads, role: 'MANAGER' }))._id);
  roadsMemberMembership = String((await DepartmentMembership.create({ user: roadsMember.id, department: roads, role: 'MEMBER' }))._id);
  waterManagerMembership = String((await DepartmentMembership.create({ user: waterManager.id, department: water, role: 'MANAGER' }))._id);
});

const call = (method: 'get' | 'post' | 'patch' | 'delete', path: string, actor?: Actor, body?: unknown) => {
  let r = request(app)[method](`/api/v1${path}`);
  if (actor) r = r.set('Authorization', `Bearer ${actor.token}`);
  if (body !== undefined) r = r.set('Content-Type', 'application/json').send(JSON.stringify(body));
  return r;
};
const auditCount = () => AuditLog.countDocuments();
const SENSITIVE = /passwordHash|\$argon2|refreshTokenHash|sessionId/;

// ---- users ----------------------------------------------------------------
describe('user profile', () => {
  it('requires authentication', async () => {
    expect((await call('get', '/users/me')).status).toBe(401);
    expect((await call('patch', '/users/me', undefined, { name: 'X' })).status).toBe(401);
  });

  it('returns the current user without sensitive fields', async () => {
    const res = await call('get', '/users/me', roadsManager);
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({
      email: 'roads.manager@test.local',
      roles: ['CITIZEN', 'DEPARTMENT_MANAGER'],
      memberships: [{ departmentId: roads, role: 'MANAGER' }],
    });
    expect(JSON.stringify(res.body)).not.toMatch(SENSITIVE);
  });

  it('updates the name and audits it', async () => {
    const res = await call('patch', '/users/me', citizen, { name: '  Asha Rao ' });
    expect(res.status).toBe(200);
    expect(res.body.data.user.name).toBe('Asha Rao');
    expect((await User.findById(citizen.id))!.name).toBe('Asha Rao');
    const entry = await AuditLog.findOne({ action: 'user.profile_updated', targetId: citizen.id }).lean();
    expect(entry?.changes).toEqual([{ field: 'name', before: 'citizen', after: 'Asha Rao' }]);
  });

  it('rejects privileged or unsupported fields and changes nothing', async () => {
    for (const body of [
      { platformRole: 'PLATFORM_ADMIN' },
      { accountStatus: 'ACTIVE' },
      { email: 'new@test.local' },
      { roles: ['PLATFORM_ADMIN'] },
      { memberships: [{ departmentId: roads, role: 'MANAGER' }] },
      { name: 'Ok', platformRole: 'PLATFORM_ADMIN' },
    ]) {
      const res = await call('patch', '/users/me', citizen, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    const user = await User.findById(citizen.id).lean();
    expect(user).toMatchObject({ name: 'citizen', email: 'citizen@test.local', platformRole: 'CITIZEN' });
    expect(await DepartmentMembership.countDocuments({ user: citizen.id })).toBe(0);
  });

  it('rejects empty updates and invalid names', async () => {
    expect((await call('patch', '/users/me', citizen, {})).status).toBe(400);
    expect((await call('patch', '/users/me', citizen, { name: '   ' })).body.error.details[0].field).toBe('body.name');
  });
});

// ---- departments ----------------------------------------------------------
describe('departments', () => {
  const body = { name: 'Streetlights Test Dept', description: 'Test fixture', categories: ['streetlight'] };

  it('lets only platform admins create, and audits creation', async () => {
    expect((await call('post', '/departments', undefined, body)).status).toBe(401);
    for (const actor of [citizen, roadsManager, roadsMember]) {
      const res = await call('post', '/departments', actor, body);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
    expect(await Department.countDocuments({ name: body.name })).toBe(0);

    const res = await call('post', '/departments', admin, body);
    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/api/v1/departments/${res.body.data.department.id}`);
    expect(res.body.data.department).toMatchObject({ name: body.name, categories: ['streetlight'], isActive: true, description: 'Test fixture' });
    expect(await AuditLog.exists({ action: 'department.created', targetId: res.body.data.department.id, actor: admin.id })).toBeTruthy();
  });

  it('validates input, rejects internal fields and duplicate names', async () => {
    expect((await call('post', '/departments', admin, { ...body, categories: [] })).status).toBe(400);
    expect((await call('post', '/departments', admin, { ...body, categories: ['bridges'] })).status).toBe(400);
    expect((await call('post', '/departments', admin, { ...body, isActive: false })).body.error.details[0]).toMatchObject({
      field: 'body.isActive',
      issue: 'unrecognized_key',
    });
    const dup = await call('post', '/departments', admin, { ...body, name: 'ROADS test dept' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.details[0].field).toBe('body.name');
  });

  it('lists active departments with pagination for any signed-in user', async () => {
    await Department.create({ name: 'Closed Test Dept', categories: ['other'], isActive: false });
    const res = await call('get', '/departments?limit=1', citizen);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('Roads Test Dept');
    expect(res.body.meta.pagination).toEqual({ page: 1, limit: 1, total: 2, totalPages: 2, hasNextPage: true });
    expect((await call('get', '/departments?category=water', citizen)).body.data.map((d: { name: string }) => d.name)).toEqual(['Water Test Dept']);
    expect((await call('get', '/departments?limit=101', citizen)).status).toBe(400);
    expect((await call('get', '/departments')).status).toBe(401);
  });

  it('shows inactive departments only to platform admins', async () => {
    const closed = String((await Department.create({ name: 'Closed Test Dept', categories: ['other'], isActive: false }))._id);
    expect((await call('get', '/departments?includeInactive=true', citizen)).status).toBe(403);
    expect((await call('get', '/departments?includeInactive=true', admin)).body.meta.pagination.total).toBe(3);
    expect((await call('get', `/departments/${closed}`, citizen)).status).toBe(404);
    expect((await call('get', `/departments/${closed}`, admin)).status).toBe(200);
  });

  it('handles invalid and unknown IDs consistently', async () => {
    expect((await call('get', '/departments/not-an-id', citizen)).body.error.details[0].field).toBe('params.departmentId');
    expect((await call('get', `/departments/${new mongoose.Types.ObjectId()}`, citizen)).status).toBe(404);
    expect((await call('patch', `/departments/${new mongoose.Types.ObjectId()}`, admin, { name: 'Nope dept' })).status).toBe(404);
  });

  it('lets only admins update, records a diff, and ignores no-op updates', async () => {
    expect((await call('patch', `/departments/${roads}`, roadsManager, { name: 'Hijacked' })).status).toBe(403);
    const res = await call('patch', `/departments/${roads}`, admin, { name: 'Roads and Footpaths', categories: ['roads', 'drainage'] });
    expect(res.status).toBe(200);
    expect(res.body.data.department).toMatchObject({ name: 'Roads and Footpaths', categories: ['roads', 'drainage'] });
    const entry = await AuditLog.findOne({ action: 'department.updated', targetId: roads }).lean();
    expect(entry?.changes.map((c) => c.field)).toEqual(['name', 'categories']);
    const before = await auditCount();
    await call('patch', `/departments/${roads}`, admin, { name: 'Roads and Footpaths' });
    expect(await auditCount()).toBe(before);
  });

  it('deactivation keeps memberships but removes their authority immediately', async () => {
    expect((await call('get', `/departments/${roads}/members`, roadsManager)).status).toBe(200);
    expect((await call('post', `/departments/${roads}/deactivate`, roadsManager, {})).status).toBe(403);

    const res = await call('post', `/departments/${roads}/deactivate`, admin, { reason: 'Merged into public works' });
    expect(res.status).toBe(200);
    expect(res.body.data.department.isActive).toBe(false);
    expect(await DepartmentMembership.countDocuments({ department: roads, status: 'ACTIVE' })).toBe(2); // history kept
    expect((await call('get', `/departments/${roads}/members`, roadsManager)).status).toBe(403); // same token, no authority
    expect((await call('get', '/users/me', roadsManager)).body.data.user.roles).toEqual(['CITIZEN']);
    expect((await call('post', `/departments/${roads}/members`, admin, { email: newcomer.email })).status).toBe(409);
    expect(await AuditLog.exists({ action: 'department.deactivated', targetId: roads, reason: 'Merged into public works' })).toBeTruthy();

    await call('post', `/departments/${roads}/reactivate`, admin, {});
    expect((await call('get', `/departments/${roads}/members`, roadsManager)).status).toBe(200);
  });

  it('refuses to deactivate a department with open work orders', async () => {
    await WorkOrder.create({ complaint: new mongoose.Types.ObjectId(), department: roads, priority: 'P2' });
    const res = await call('post', `/departments/${roads}/deactivate`, admin, {});
    expect(res.status).toBe(409);
    expect((await Department.findById(roads))!.isActive).toBe(true);
    await WorkOrder.updateMany({ department: roads }, { status: 'CANCELLED' });
    expect((await call('post', `/departments/${roads}/deactivate`, admin, {})).status).toBe(200);
  });
});

// ---- memberships ----------------------------------------------------------
describe('membership listing', () => {
  it('is limited to admins and managers of that department', async () => {
    const res = await call('get', `/departments/${roads}/members`, roadsManager);
    expect(res.status).toBe(200);
    expect(res.body.data.map((m: { user: { email: string } }) => m.user.email).sort()).toEqual(['roads.manager@test.local', 'roads.member@test.local']);
    expect(Object.keys(res.body.data[0]).sort()).toEqual(['createdAt', 'departmentId', 'id', 'role', 'status', 'updatedAt', 'user']);
    expect(JSON.stringify(res.body)).not.toMatch(SENSITIVE);
    expect((await call('get', `/departments/${roads}/members`, admin)).status).toBe(200);
    for (const actor of [roadsMember, waterManager, citizen]) {
      expect((await call('get', `/departments/${roads}/members`, actor)).status).toBe(403);
    }
  });

  it('filters by status and role, and paginates', async () => {
    await DepartmentMembership.updateOne({ _id: roadsMemberMembership }, { status: 'INACTIVE' });
    expect((await call('get', `/departments/${roads}/members`, admin)).body.data).toHaveLength(1);
    expect((await call('get', `/departments/${roads}/members?status=ALL`, admin)).body.data).toHaveLength(2);
    expect((await call('get', `/departments/${roads}/members?status=ALL&role=MEMBER`, admin)).body.data[0].status).toBe('INACTIVE');
    expect((await call('get', `/departments/${roads}/members?limit=1&status=ALL`, admin)).body.meta.pagination).toMatchObject({ total: 2, totalPages: 2 });
    expect((await call('get', `/departments/${roads}/members?status=REVOKED`, admin)).status).toBe(400);
  });
});

describe('adding members', () => {
  it('lets a manager add a MEMBER to their own department by email', async () => {
    const res = await call('post', `/departments/${roads}/members`, roadsManager, { email: 'NEWCOMER@test.local' });
    expect(res.status).toBe(201);
    expect(res.body.data.membership).toMatchObject({ departmentId: roads, role: 'MEMBER', status: 'ACTIVE', user: { id: newcomer.id } });
    expect(await AuditLog.exists({ action: 'membership.created', actor: roadsManager.id })).toBeTruthy();
    // Takes effect for the new member on their next request.
    expect((await call('get', '/users/me', newcomer)).body.data.user.roles).toEqual(['CITIZEN', 'DEPARTMENT_MEMBER']);
  });

  it('lets an admin appoint a manager by user ID', async () => {
    const res = await call('post', `/departments/${water}/members`, admin, { userId: newcomer.id, role: 'MANAGER' });
    expect(res.status).toBe(201);
    expect(res.body.data.membership.role).toBe('MANAGER');
  });

  it('stops managers appointing managers, granting admin, or acting on other departments, without writing anything', async () => {
    const memberships = await DepartmentMembership.countDocuments();
    const audits = await auditCount();
    expect((await call('post', `/departments/${roads}/members`, roadsManager, { email: newcomer.email, role: 'MANAGER' })).status).toBe(403);
    expect((await call('post', `/departments/${roads}/members`, roadsManager, { email: newcomer.email, role: 'PLATFORM_ADMIN' })).status).toBe(400);
    expect((await call('post', `/departments/${water}/members`, roadsManager, { email: newcomer.email })).status).toBe(403);
    expect((await call('post', `/departments/${roads}/members`, roadsMember, { email: newcomer.email })).status).toBe(403);
    expect((await call('post', `/departments/${roads}/members`, citizen, { userId: citizen.id })).status).toBe(403);
    expect((await call('post', `/departments/${roads}/members`, newcomer, { userId: newcomer.id })).status).toBe(403);
    expect(await DepartmentMembership.countDocuments()).toBe(memberships);
    expect(await auditCount()).toBe(audits);
    expect((await User.findById(newcomer.id).lean())!.platformRole).toBe('CITIZEN');
  });

  it('handles unknown users, suspended users, unknown departments and bad bodies', async () => {
    expect((await call('post', `/departments/${roads}/members`, roadsManager, { email: 'ghost@test.local' })).status).toBe(404);
    await User.updateOne({ _id: newcomer.id }, { accountStatus: 'SUSPENDED' });
    expect((await call('post', `/departments/${roads}/members`, roadsManager, { userId: newcomer.id })).status).toBe(404);
    expect((await call('post', `/departments/${new mongoose.Types.ObjectId()}/members`, admin, { userId: citizen.id })).status).toBe(404);
    expect((await call('post', `/departments/${roads}/members`, admin, {})).body.error.details[0].field).toBe('body.userId');
    expect((await call('post', `/departments/${roads}/members`, admin, { userId: citizen.id, email: citizen.email })).status).toBe(400);
  });

  it('rejects duplicates, including concurrent ones', async () => {
    expect((await call('post', `/departments/${roads}/members`, roadsManager, { userId: roadsMember.id })).status).toBe(409);
    const results = await Promise.all(Array.from({ length: 5 }, () => call('post', `/departments/${roads}/members`, admin, { userId: citizen.id })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);
    expect(await DepartmentMembership.countDocuments({ user: citizen.id, department: roads })).toBe(1);
  });

  it('allows the same user in several departments', async () => {
    expect((await call('post', `/departments/${water}/members`, waterManager, { userId: roadsMember.id })).status).toBe(201);
    const roles = (await call('get', '/users/me', roadsMember)).body.data.user.memberships;
    expect(roles).toHaveLength(2);
  });
});

describe('changing roles', () => {
  it('is admin-only and audited', async () => {
    expect((await call('patch', `/departments/${roads}/members/${roadsMemberMembership}`, roadsManager, { role: 'MANAGER' })).status).toBe(403);
    // Self-promotion attempts.
    expect((await call('patch', `/departments/${roads}/members/${roadsMemberMembership}`, roadsMember, { role: 'MANAGER' })).status).toBe(403);
    expect((await call('patch', `/departments/${roads}/members/${roadsManagerMembership}`, roadsManager, { role: 'MANAGER' })).status).toBe(403);
    expect((await DepartmentMembership.findById(roadsMemberMembership))!.role).toBe('MEMBER');

    const res = await call('patch', `/departments/${roads}/members/${roadsMemberMembership}`, admin, { role: 'MANAGER' });
    expect(res.status).toBe(200);
    expect(res.body.data.membership.role).toBe('MANAGER');
    const entry = await AuditLog.findOne({ action: 'membership.role_changed', targetId: roadsMemberMembership }).lean();
    expect(entry?.changes).toEqual([{ field: 'role', before: 'MEMBER', after: 'MANAGER' }]);
  });

  it('rejects unknown roles and memberships from another department in the URL', async () => {
    expect((await call('patch', `/departments/${roads}/members/${roadsMemberMembership}`, admin, { role: 'PLATFORM_ADMIN' })).status).toBe(400);
    expect((await call('patch', `/departments/${roads}/members/${waterManagerMembership}`, admin, { role: 'MEMBER' })).status).toBe(404);
    expect((await DepartmentMembership.findById(waterManagerMembership))!.role).toBe('MANAGER');
  });

  it('refuses to change the role of a revoked membership', async () => {
    await DepartmentMembership.updateOne({ _id: roadsMemberMembership }, { status: 'INACTIVE' });
    expect((await call('patch', `/departments/${roads}/members/${roadsMemberMembership}`, admin, { role: 'MANAGER' })).status).toBe(409);
  });
});

describe('revoking and reactivating', () => {
  it('lets a manager revoke a member; the record is kept and access ends immediately', async () => {
    const res = await call('delete', `/departments/${roads}/members/${roadsMemberMembership}`, roadsManager, { reason: 'Transferred' });
    expect(res.status).toBe(200);
    expect(res.body.data.membership.status).toBe('INACTIVE');
    expect(await DepartmentMembership.exists({ _id: roadsMemberMembership })).toBeTruthy();
    expect((await call('get', '/users/me', roadsMember)).body.data.user.roles).toEqual(['CITIZEN']);
    expect(await AuditLog.exists({ action: 'membership.revoked', targetId: roadsMemberMembership, reason: 'Transferred' })).toBeTruthy();
    // Idempotent: a second revoke changes nothing and writes no audit entry.
    const audits = await auditCount();
    expect((await call('delete', `/departments/${roads}/members/${roadsMemberMembership}`, roadsManager)).status).toBe(200);
    expect(await auditCount()).toBe(audits);
  });

  it('does not let managers revoke themselves, other managers, or other departments', async () => {
    await DepartmentMembership.create({ user: newcomer.id, department: roads, role: 'MANAGER' });
    const otherManager = String((await DepartmentMembership.findOne({ user: newcomer.id }))!._id);
    expect((await call('delete', `/departments/${roads}/members/${roadsManagerMembership}`, roadsManager)).status).toBe(403);
    expect((await call('delete', `/departments/${roads}/members/${otherManager}`, roadsManager)).status).toBe(403);
    expect((await call('delete', `/departments/${water}/members/${waterManagerMembership}`, roadsManager)).status).toBe(403);
    // Another department's membership through this department's URL is not found.
    expect((await call('delete', `/departments/${roads}/members/${waterManagerMembership}`, admin)).status).toBe(404);
    expect(await DepartmentMembership.countDocuments({ status: 'ACTIVE' })).toBe(4);
  });

  it('an admin revoking a manager removes their authority on the same token', async () => {
    expect((await call('get', `/departments/${roads}/members`, roadsManager)).status).toBe(200);
    expect((await call('delete', `/departments/${roads}/members/${roadsManagerMembership}`, admin)).status).toBe(200);
    expect((await call('get', `/departments/${roads}/members`, roadsManager)).status).toBe(403);
    expect((await call('post', `/departments/${roads}/members`, roadsManager, { email: newcomer.email })).status).toBe(403);
  });

  it('adding a revoked member again reactivates the same record', async () => {
    await call('delete', `/departments/${roads}/members/${roadsMemberMembership}`, roadsManager);
    const res = await call('post', `/departments/${roads}/members`, roadsManager, { userId: roadsMember.id });
    expect(res.status).toBe(200);
    expect(res.body.data.membership).toMatchObject({ id: roadsMemberMembership, status: 'ACTIVE', role: 'MEMBER' });
    expect(await DepartmentMembership.countDocuments({ user: roadsMember.id, department: roads })).toBe(1);
    expect(await AuditLog.exists({ action: 'membership.reactivated', targetId: roadsMemberMembership })).toBeTruthy();
  });

  it('a manager cannot reactivate a revoked manager in their own department as manager', async () => {
    const former = String((await DepartmentMembership.create({ user: newcomer.id, department: roads, role: 'MANAGER', status: 'INACTIVE' }))._id);
    expect((await call('post', `/departments/${roads}/members`, roadsManager, { userId: newcomer.id, role: 'MANAGER' })).status).toBe(403);
    expect((await DepartmentMembership.findById(former))!.status).toBe('INACTIVE');
    // As a plain member is fine, and the role is downgraded on reactivation.
    const res = await call('post', `/departments/${roads}/members`, roadsManager, { userId: newcomer.id });
    expect(res.body.data.membership).toMatchObject({ id: former, role: 'MEMBER', status: 'ACTIVE' });
  });
});
