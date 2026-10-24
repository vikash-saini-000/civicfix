// Phase 10: notifications from business events, and the admin audit-log API.
import { Writable } from 'node:stream';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiProviderError, type AiProvider, type ClassificationOutput } from '../src/ai/types.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import { createEventBus, type EventBus } from '../src/events/bus.js';
import { AIAnalysis, AuditLog, AuthSession, Complaint, Counter, Department, DepartmentMembership, Dispute, Evidence, Notification, User, WorkOrder } from '../src/models/index.js';
import { createAnalysisService, type AnalysisService } from '../src/services/analysis/index.js';
import { createMemoryStorage } from '../src/storage/index.js';
import { createLogger, type Logger } from '../src/utils/logger.js';
import { jpegWithExif, testAuthConfig } from './helpers.js';
import { testMongo } from './mongo.js';

const silent = createLogger({ logLevel: 'silent', nodeEnv: 'test' });
const PASSWORD = 'phase ten password';
const many = { windowMs: 60_000, limit: 10_000 };
const out = (o: Partial<ClassificationOutput> = {}): ClassificationOutput => ({ category: 'roads', departmentRef: 'D1', priority: 'P2', certainty: 'HIGH', summary: 'Pothole.', rationale: 'Road.', missingInformation: [], reviewRecommended: false, reviewReasons: [], confidence: 0.92, publicSafetyHazard: false, spamLikely: false, followUpQuestions: [], ...o });
const provider = (o: ClassificationOutput): AiProvider => ({
  name: 'fake',
  model: 'fake-1',
  enabled: true,
  async classifyComplaint() {
    return { output: o, meta: { provider: 'fake', model: 'fake-1', promptVersion: 'v1', latencyMs: 1 } };
  },
  async assessImage() {
    return { output: { visualInconsistency: 'NONE_OBSERVED', inconsistencyNotes: '', relevance: 'APPEARS_RELATED', relevanceNotes: '' }, meta: { provider: 'fake', model: 'fake-1', promptVersion: 'v1', latencyMs: 1 } };
  },
  async compareResolution() {
    return { output: { sameLocation: 'YES', issueAppearsFixed: 'YES', matchesCategory: 'YES', notes: 'Pothole filled; same kerb and pole.' }, meta: { provider: 'fake', model: 'fake-1', promptVersion: 'v1', latencyMs: 1 } };
  },
});
const jpeg = () => jpegWithExif({ lat: 13.0, lng: 74.79 }); // GPS at the reported spot

const MODELS = [User, Department, DepartmentMembership, AuthSession, Complaint, Counter, Evidence, AIAnalysis, WorkOrder, Dispute, Notification] as unknown as (typeof User)[];
beforeAll(async () => {
  const mongo = await testMongo();
  await mongoose.connect(mongo.getUri(), { dbName: 'civicfix-phase10-test' });
  await Promise.all(MODELS.map((m) => m.syncIndexes()));
});
afterAll(async () => {
  await mongoose.disconnect();
});

let analysis: AnalysisService;
let app: ReturnType<typeof createApp>;
let events: EventBus;
function build(o: ClassificationOutput = out(), logger: Logger = silent) {
  events = createEventBus(logger);
  const storage = createMemoryStorage();
  analysis = createAnalysisService({ provider: provider(o), logger, maxAttempts: 1, autoRun: false, storage });
  app = createApp({
    config: { nodeEnv: 'test', corsOrigins: [], jsonBodyLimit: '100kb', auth: testAuthConfig },
    logger,
    isDatabaseConnected: () => true,
    checkDatabase: async () => true,
    isShuttingDown: () => false,
    authRateLimits: { register: many, loginPerIp: many, loginPerIpAndEmail: many, refresh: many },
    complaintCreateLimit: many,
    uploadLimit: many,
    analysis,
    storage,
    events,
  });
}
const settle = async () => {
  for (let i = 0; i < 20; i++) {
    await analysis.runner.drain();
    if (!(await AIAnalysis.exists({ status: { $in: ['PENDING', 'RUNNING'] } }))) return;
  }
};

type Actor = { id: string; token: string };
let admin: Actor, alice: Actor, bob: Actor, mgr: Actor, w1: Actor, waterMgr: Actor;
let roads: string;
const hash = await hashPassword(PASSWORD);
async function actor(email: string, platformRole: 'CITIZEN' | 'PLATFORM_ADMIN' = 'CITIZEN'): Promise<Actor> {
  const u = await User.create({ name: email.split('@')[0], email, platformRole, passwordHash: hash });
  const res = await request(app).post('/api/v1/auth/login').set('Content-Type', 'application/json').send(JSON.stringify({ email, password: PASSWORD }));
  return { id: String(u._id), token: res.body.data.accessToken };
}
async function seed() {
  await Promise.all(MODELS.map((m) => m.deleteMany({})));
  roads = String((await Department.create({ name: 'A Roads', categories: ['roads'] }))._id);
  const water = String((await Department.create({ name: 'B Water', categories: ['water'] }))._id);
  admin = await actor('admin@t.local', 'PLATFORM_ADMIN');
  alice = await actor('alice@t.local');
  bob = await actor('bob@t.local');
  mgr = await actor('mgr@t.local');
  w1 = await actor('w1@t.local');
  waterMgr = await actor('wmgr@t.local');
  await DepartmentMembership.create([
    { user: mgr.id, department: roads, role: 'MANAGER' },
    { user: w1.id, department: roads, role: 'MEMBER' },
    { user: waterMgr.id, department: water, role: 'MANAGER' },
  ]);
}
const call = (method: 'get' | 'post' | 'delete' | 'patch', path: string, who?: Actor, body?: unknown) => {
  let r = request(app)[method](`/api/v1${path}`);
  if (who) r = r.set('Authorization', `Bearer ${who.token}`);
  if (body !== undefined) r = r.set('Content-Type', 'application/json').send(JSON.stringify(body));
  return r;
};
const report = { title: 'Deep pothole near the bus stop', description: 'Large pothole on the service road near the stop.', location: { lat: 13.0, lng: 74.79 }, selectedCategory: 'roads' };
const typesFor = async (who: Actor) => (await Notification.find({ recipient: who.id }).sort({ createdAt: 1, _id: 1 }).lean()).map((n) => n.type);

async function fullFlow() {
  const c = (await call('post', '/complaints', alice, report)).body.data.complaint;
  await settle();
  const wo = (await WorkOrder.findOne({ complaint: c.id }).lean())!.publicId!;
  await call('post', `/work-orders/${wo}/accept`, w1, {});
  await call('post', `/work-orders/${wo}/start`, w1, {});
  await call('post', `/work-orders/${wo}/notes`, w1, { text: 'SECRETNOTE internal crew detail' });
  const ev = (await request(app).post(`/api/v1/complaints/${c.publicId}/evidence?purpose=RESOLUTION`).set('Authorization', `Bearer ${w1.token}`).set('Content-Type', 'image/jpeg').send(jpeg())).body.data.evidence.id;
  await settle();
  await call('post', `/work-orders/${wo}/resolution`, w1, { completionNotes: 'Filled the pothole completely.', evidenceIds: [ev] });
  await call('post', `/work-orders/${wo}/verification`, mgr, { decision: 'APPROVE', reason: 'Looks good.' });
  const d = (await call('post', `/complaints/${c.publicId}/disputes`, alice, { reason: 'It cracked again after the rain.' })).body.data.dispute;
  await call('post', `/disputes/${d.id}/decision`, mgr, { decision: 'DISMISS', reason: 'Inspection shows the repair holds.' });
  return { c, wo, d };
}

// ---- recipients -----------------------------------------------------------------------------------
describe('notification recipients', () => {
  beforeEach(async () => {
    build();
    await seed();
  });

  it('each participant hears about what concerns them, and nobody else does', async () => {
    await fullFlow();
    expect(await typesFor(alice)).toEqual([
      'COMPLAINT_RECEIVED',
      'COMPLAINT_STATUS_CHANGED', // under review
      'COMPLAINT_STATUS_CHANGED', // assigned
      'COMPLAINT_STATUS_CHANGED', // accepted
      'COMPLAINT_STATUS_CHANGED', // in progress
      'COMPLAINT_STATUS_CHANGED', // fix submitted
      'COMPLAINT_STATUS_CHANGED', // resolved
      'DISPUTE_DECIDED',
    ]);
    expect(await typesFor(w1)).toEqual(['WORK_ORDER_ASSIGNED', 'WORK_ORDER_UPDATED']);
    expect(await typesFor(mgr)).toEqual(['VERIFICATION_NEEDED', 'DISPUTE_SUBMITTED']);
    expect(await typesFor(bob)).toEqual([]);
    expect(await typesFor(waterMgr)).toEqual([]);
  });

  it('never carries internal notes or another person’s details to the citizen', async () => {
    await fullFlow();
    const citizen = JSON.stringify(await Notification.find({ recipient: alice.id }).lean());
    expect(citizen).not.toMatch(/SECRETNOTE|w1@t\.local|mgr@t\.local|Inspection shows/);
    expect(JSON.stringify(await Notification.find().lean())).not.toContain('SECRETNOTE');
  });

  it('routing reviews go to admins, then to the department’s managers', async () => {
    build(out({ certainty: 'LOW' }));
    await seed();
    const c = (await call('post', '/complaints', alice, report)).body.data.complaint;
    await settle();
    // The AI suggested Roads, so Roads managers get the routing decision (not every admin).
    expect(await typesFor(mgr)).toEqual(['MANAGER_REVIEW_REQUIRED']);
    expect(await typesFor(admin)).toEqual([]);
    await call('post', `/complaints/${c.publicId}/classify`, admin, { departmentId: roads, category: 'roads' });
    expect(await typesFor(mgr)).toEqual(['MANAGER_REVIEW_REQUIRED', 'MANAGER_REVIEW_REQUIRED']);
    expect(await typesFor(waterMgr)).toEqual([]);
  });

  it('routing reviews with no usable department suggestion go to admins', async () => {
    build(out({ certainty: 'LOW', departmentRef: null }));
    await seed();
    await call('post', '/complaints', alice, report);
    await settle();
    expect(await typesFor(admin)).toEqual(['MANAGER_REVIEW_REQUIRED']);
    expect(await typesFor(mgr)).toEqual([]);
  });

  it('skips inactive accounts and failed or unauthorized actions', async () => {
    await User.updateOne({ _id: w1.id }, { accountStatus: 'SUSPENDED' });
    const c = (await call('post', '/complaints', alice, report)).body.data.complaint;
    await settle();
    expect(await typesFor(w1)).toEqual([]);
    const before = await Notification.countDocuments();
    const wo = (await WorkOrder.findOne({ complaint: c.id }).lean())!.publicId!;
    expect((await call('post', `/work-orders/${wo}/accept`, bob, {})).status).toBe(404);
    expect((await call('post', `/work-orders/${wo}/start`, mgr, {})).status).toBe(403);
    expect(await Notification.countDocuments()).toBe(before);
  });

  it('deduplicates repeated events and isolates handler failures', async () => {
    const c = (await call('post', '/complaints', alice, report)).body.data.complaint;
    await events.emit('complaint.created', { complaintId: c.id }, `${c.id}:created`);
    await events.emit('complaint.created', { complaintId: c.id }, `${c.id}:created`);
    expect((await typesFor(alice)).filter((t) => t === 'COMPLAINT_RECEIVED')).toHaveLength(1);

    events.on('complaint.created', () => {
      throw new Error('notification provider down');
    });
    const res = await call('post', '/complaints', alice, report);
    expect(res.status).toBe(201);
    expect(await Complaint.countDocuments()).toBe(2);
  });
});

// ---- notification API ------------------------------------------------------------------------------------
describe('notification API', () => {
  beforeEach(async () => {
    build();
    await seed();
  });

  it('lists, counts and marks only the caller’s own notifications', async () => {
    await call('post', '/complaints', alice, report);
    await settle();
    const list = await call('get', '/notifications', alice);
    expect(list.status).toBe(200);
    expect(list.body.data[0]).toEqual(expect.objectContaining({ type: expect.any(String), title: expect.any(String), complaintPublicId: expect.stringMatching(/^CF-/), readAt: null }));
    expect(Object.keys(list.body.data[0]).sort()).toEqual(['complaintPublicId', 'createdAt', 'disputeId', 'id', 'message', 'readAt', 'title', 'type', 'workOrderPublicId']);
    const total = list.body.meta.pagination.total;
    expect((await call('get', '/notifications/unread-count', alice)).body.data.count).toBe(total);
    expect((await call('get', '/notifications', bob)).body.data).toEqual([]);

    const first = list.body.data[0].id;
    expect((await call('post', `/notifications/${first}/read`, bob, {})).status).toBe(404);
    expect((await call('post', `/notifications/${first}/read`, alice, {})).status).toBe(200);
    expect((await call('post', `/notifications/${first}/read`, alice, {})).status).toBe(200); // idempotent
    expect((await call('get', '/notifications/unread-count', alice)).body.data.count).toBe(total - 1);
    expect((await call('get', '/notifications?unread=true', alice)).body.data.every((n: { id: string }) => n.id !== first)).toBe(true);
    expect((await call('post', '/notifications/read-all', alice, {})).body.data.updated).toBe(total - 1);
    expect((await call('get', '/notifications/unread-count', alice)).body.data.count).toBe(0);
  });

  it('requires auth and validates input', async () => {
    expect((await call('get', '/notifications')).status).toBe(401);
    expect((await call('get', '/notifications?limit=500', alice)).status).toBe(400);
    expect((await call('get', '/notifications?recipient=' + bob.id, alice)).status).toBe(400);
    expect((await call('post', '/notifications/not-an-id/read', alice, {})).status).toBe(400);
  });
});

// ---- audit log ---------------------------------------------------------------------------------------------
describe('audit logs', () => {
  beforeEach(async () => {
    build();
    await seed();
  });

  it('is readable only by platform admins, with filters', async () => {
    const { wo } = await fullFlow();
    expect((await call('get', '/audit-logs')).status).toBe(401);
    for (const who of [alice, w1, mgr]) expect((await call('get', '/audit-logs', who)).status).toBe(403);
    const all = await call('get', '/audit-logs?limit=100', admin);
    expect(all.status).toBe(200);
    expect(all.body.meta.pagination.total).toBeGreaterThan(10);
    const woId = String((await WorkOrder.findOne({ publicId: wo }).lean())!._id);
    const woEvents = await call('get', `/audit-logs?action=work_order.&targetId=${woId}&limit=100`, admin);
    expect(woEvents.body.data.map((a: { action: string }) => a.action).sort()).toEqual(
      ['work_order.accept', 'work_order.approve', 'work_order.note_added', 'work_order.start', 'work_order.submit_resolution'].sort(),
    );
    const byMgr = await call('get', `/audit-logs?actorId=${mgr.id}`, admin);
    expect(byMgr.body.data.every((a: { actorId: string }) => a.actorId === mgr.id)).toBe(true);
    const one = all.body.data[0];
    expect((await call('get', `/audit-logs/${one.id}`, admin)).body.data.auditLog.id).toBe(one.id);
    expect((await call('get', '/audit-logs?from=2030-01-01T00:00:00Z&to=2029-01-01T00:00:00Z', admin)).status).toBe(400);
    expect(JSON.stringify(all.body)).not.toMatch(/argon2|passwordHash|refreshTokenHash|eyJ/);
  });

  it('cannot be written, edited or deleted through the API', async () => {
    await call('post', '/complaints', alice, report);
    const n = await AuditLog.countDocuments();
    const id = String((await AuditLog.findOne().lean())!._id);
    for (const [m, path] of [['post', '/audit-logs'], ['delete', `/audit-logs/${id}`], ['patch', `/audit-logs/${id}`]] as const) {
      const res = await call(m, path, admin, { action: 'x.y' });
      expect(res.status).toBe(404);
    }
    expect(await AuditLog.countDocuments()).toBe(n);
  });

  it('takes the actor from the session, strips control characters, and survives audit failures', async () => {
    build(out({ certainty: 'LOW' }));
    await seed();
    const c = (await call('post', '/complaints', alice, report)).body.data.complaint;
    expect((await call('post', `/complaints/${c.publicId}/reject`, admin, { reason: 'Duplicate', actorId: bob.id })).status).toBe(400);
    await call('post', `/complaints/${c.publicId}/reject`, admin, { reason: 'Duplicate report\n[fake] admin=root\u0007' });
    const entry = await AuditLog.findOne({ action: 'complaint.rejected', targetId: c.id }).lean();
    expect(String(entry!.actor)).toBe(admin.id);
    expect(entry!.reason).toBe('Duplicate report [fake] admin=root');

    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _e, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    build(out(), createLogger({ logLevel: 'error', nodeEnv: 'test' }, sink));
    const spy = vi.spyOn(AuditLog, 'create').mockRejectedValueOnce(new Error('audit store down'));
    const res = await call('post', '/complaints', alice, report);
    spy.mockRestore();
    expect(res.status).toBe(201);
    expect(lines.join('')).toContain('audit write failed');
  });
});

// Silence unhandled reference to AiProviderError import when unused in some runs.
void AiProviderError;
