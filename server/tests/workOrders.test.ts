// Phase 8: hybrid assignment and work orders.
import mongoose from 'mongoose';
import { testMongo } from './mongo.js';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AiProviderError, disabledProvider, type AiProvider, type ClassificationOutput } from '../src/ai/types.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import { AIAnalysis, AuditLog, AuthSession, Complaint, Counter, Department, DepartmentMembership, Evidence, User, WorkOrder } from '../src/models/index.js';
import { createAnalysisService, type AnalysisService } from '../src/services/analysis/index.js';
import { DEFAULT_ASSIGNMENT_POLICY, type AssignmentPolicy } from '../src/services/workOrders.js';
import { createLogger } from '../src/utils/logger.js';
import { testAuthConfig } from './helpers.js';

const silent = createLogger({ logLevel: 'silent', nodeEnv: 'test' });
const PASSWORD = 'phase eight password';
const many = { windowMs: 60_000, limit: 10_000 };
const YEAR = new Date().getUTCFullYear();

const good = (o: Partial<ClassificationOutput> = {}): ClassificationOutput => ({
  category: 'roads',
  departmentRef: 'D1',
  priority: 'P2',
  certainty: 'HIGH',
  summary: 'Pothole on the service road.',
  rationale: 'Road damage.',
  missingInformation: [],
  reviewRecommended: false,
  reviewReasons: [],
  confidence: 0.92,
  publicSafetyHazard: false,
  spamLikely: false,
  followUpQuestions: [],
  ...o,
});
function provider(out: ClassificationOutput | AiProviderError): AiProvider {
  return {
    name: 'fake',
    model: 'fake-1',
    enabled: true,
    async classifyComplaint() {
      if (out instanceof AiProviderError) throw out;
      return { output: out, meta: { provider: 'fake', model: 'fake-1', promptVersion: 'v1', latencyMs: 1 } };
    },
    async assessImage() {
      throw new AiProviderError('NOT_CONFIGURED', 'x');
    },
  };
}

const MODELS = [User, Department, DepartmentMembership, AuthSession, Complaint, Counter, Evidence, AIAnalysis, WorkOrder] as unknown as (typeof User)[];
let mongo: Awaited<ReturnType<typeof testMongo>>;
beforeAll(async () => {
  mongo = await testMongo();
  await mongoose.connect(mongo.getUri(), { dbName: 'civicfix-phase8-test' });
  await Promise.all(MODELS.map((m) => m.syncIndexes()));
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

let analysis: AnalysisService;
let app: ReturnType<typeof createApp>;
function build(p: AiProvider = provider(good()), policy: AssignmentPolicy = DEFAULT_ASSIGNMENT_POLICY) {
  analysis = createAnalysisService({ provider: p, logger: silent, maxAttempts: 1, autoRun: false, retryBaseMs: 1 });
  app = createApp({
    config: { nodeEnv: 'test', corsOrigins: [], jsonBodyLimit: '100kb', auth: testAuthConfig },
    logger: silent,
    isDatabaseConnected: () => true,
    checkDatabase: async () => true,
    isShuttingDown: () => false,
    authRateLimits: { register: many, loginPerIp: many, loginPerIpAndEmail: many, refresh: many },
    complaintCreateLimit: many,
    analysisRerunLimit: many,
    analysis,
    assignmentPolicy: policy,
  });
}
const settle = async () => {
  for (let i = 0; i < 20; i++) {
    await analysis.runner.drain();
    if (!(await AIAnalysis.exists({ status: { $in: ['PENDING', 'RUNNING'] } }))) return;
  }
};

type Actor = { id: string; token: string };
let admin: Actor, alice: Actor, bob: Actor, roadsMgr: Actor, w1: Actor, w2: Actor, waterMgr: Actor, waterW: Actor;
let roads: string, water: string;
const hash = await hashPassword(PASSWORD);
async function actor(email: string, platformRole: 'CITIZEN' | 'PLATFORM_ADMIN' = 'CITIZEN'): Promise<Actor> {
  const u = await User.create({ name: email.split('@')[0], email, platformRole, passwordHash: hash });
  const res = await request(app).post('/api/v1/auth/login').set('Content-Type', 'application/json').send(JSON.stringify({ email, password: PASSWORD }));
  return { id: String(u._id), token: res.body.data.accessToken };
}
async function seed(withRoadsMembers = true) {
  await Promise.all(MODELS.map((m) => m.deleteMany({})));
  roads = String((await Department.create({ name: 'A Roads', categories: ['roads', 'drainage'] }))._id);
  water = String((await Department.create({ name: 'B Water', categories: ['water'] }))._id);
  admin = await actor('admin@t.local', 'PLATFORM_ADMIN');
  alice = await actor('alice@t.local');
  bob = await actor('bob@t.local');
  roadsMgr = await actor('rmgr@t.local');
  w1 = await actor('w1@t.local');
  w2 = await actor('w2@t.local');
  waterMgr = await actor('wmgr@t.local');
  waterW = await actor('waterw@t.local');
  await DepartmentMembership.create({ user: roadsMgr.id, department: roads, role: 'MANAGER' });
  if (withRoadsMembers) {
    await DepartmentMembership.create({ user: w1.id, department: roads, role: 'MEMBER' });
    await DepartmentMembership.create({ user: w2.id, department: roads, role: 'MEMBER' });
  }
  await DepartmentMembership.create({ user: waterMgr.id, department: water, role: 'MANAGER' });
  await DepartmentMembership.create({ user: waterW.id, department: water, role: 'MEMBER' });
}

const call = (method: 'get' | 'post', path: string, who?: Actor, body?: unknown) => {
  let r = request(app)[method](`/api/v1${path}`);
  if (who) r = r.set('Authorization', `Bearer ${who.token}`);
  if (body !== undefined) r = r.set('Content-Type', 'application/json').send(JSON.stringify(body));
  return r;
};
const report = {
  title: 'Deep pothole near the bus stop',
  description: 'Large pothole on the service road, two-wheelers swerve to avoid it.',
  location: { lat: 13.0072, lng: 74.7956 },
  selectedCategory: 'roads',
};
let spread = 0;
async function file(overrides: object = {}) {
  // Spread complaints ~1 km apart so they aren't duplicate candidates of each other.
  const location = { lat: 13.0 + spread++ * 0.01, lng: 74.79 };
  const res = await call('post', '/complaints', alice, { ...report, location, ...overrides });
  expect(res.status).toBe(201);
  return res.body.data.complaint as { publicId: string; id: string };
}
const complaintOf = (id: string) => Complaint.findById(id).lean();
const woOf = (complaintId: string) => WorkOrder.findOne({ complaint: complaintId }).sort({ createdAt: -1 }).lean();

// ---- automatic assignment ------------------------------------------------------------------------
describe('automatic assignment', () => {
  beforeEach(async () => {
    build();
    await seed();
  });

  it('routes a clear, unique case and picks the least-loaded member', async () => {
    const c = await file();
    await settle();
    const stored = await complaintOf(c.id);
    expect(stored).toMatchObject({ status: 'ASSIGNED', confirmedCategory: 'roads', priority: 'P2' });
    expect(String(stored!.department)).toBe(roads);
    expect(stored!.statusHistory.map((h) => h.status)).toEqual(['REPORTED', 'UNDER_REVIEW', 'ASSIGNED']);
    const wo = await woOf(c.id);
    expect(wo).toMatchObject({ publicId: `WO-${YEAR}-00001`, status: 'ASSIGNED', assignmentSource: 'AUTO', priority: 'P2' });
    expect(String(wo!.assignee)).toBe(w1.id); // tie on load: longest-standing membership
    expect(wo!.dueAt!.getTime() - wo!.createdAt!.getTime()).toBeCloseTo(72 * 3_600_000, -4);
    expect(await AuditLog.exists({ action: 'assignment.decided', targetId: c.id, actorType: 'SYSTEM' })).toBeTruthy();

    // Second complaint goes to the other member (w1 now has one open work order).
    const d = await file();
    await settle();
    expect(String((await woOf(d.id))!.assignee)).toBe(w2.id);
  });

  it.each([
    ['low certainty', good({ certainty: 'MEDIUM' }), {}, 'LOW_CONFIDENCE'],
    ['urgent', good({ priority: 'P1' }), {}, 'HIGH_URGENCY'],
    ['citizen category disagrees', good(), { selectedCategory: 'garbage' }, 'CATEGORY_CONFLICT'],
    ['model asked for review', good({ reviewRecommended: true, reviewReasons: ['MULTI_DEPARTMENT'] }), {}, 'MULTI_DEPARTMENT'],
    ['unknown department', good({ departmentRef: null }), {}, 'UNCLEAR_DEPARTMENT'],
  ] as const)('sends %s to human review', async (_label, out, overrides, reason) => {
    build(provider(out));
    const c = await file(overrides);
    await settle();
    const stored = await complaintOf(c.id);
    expect(stored!.status).toBe('UNDER_REVIEW');
    expect(stored!.department).toBeUndefined();
    expect(stored!.routingReview!.reasons).toContain(reason);
    expect(await WorkOrder.countDocuments({ complaint: c.id })).toBe(0);
    expect(await AuditLog.exists({ action: 'assignment.review_required', targetId: c.id })).toBeTruthy();
  });

  it('never routes when the AI failed or is disabled', async () => {
    for (const p of [provider(new AiProviderError('UNAVAILABLE', 'x')), disabledProvider]) {
      build(p);
      const c = await file();
      await settle();
      const stored = await complaintOf(c.id);
      expect(stored!.status).toBe('REPORTED');
      expect(stored!.routingReview!.reasons).toContain('AI_UNAVAILABLE');
      expect(await WorkOrder.countDocuments({ complaint: c.id })).toBe(0);
    }
  });

  it('holds back possible duplicates and ambiguous category mappings', async () => {
    await call('post', '/complaints', alice, { ...report, location: { lat: 12.5, lng: 74.5 } });
    const dup = await call('post', '/complaints', bob, { ...report, location: { lat: 12.5001, lng: 74.5 } });
    await settle();
    expect((await complaintOf(dup.body.data.complaint.id))!.routingReview!.reasons).toContain('AMBIGUOUS_DUPLICATE');

    await Department.create({ name: 'C Highways', categories: ['roads'] });
    const c = await file();
    await settle();
    expect((await complaintOf(c.id))!.routingReview!.reasons).toContain('MULTI_DEPARTMENT');
  });

  it('respects the master switch', async () => {
    build(provider(good()), { ...DEFAULT_ASSIGNMENT_POLICY, autoAssignEnabled: false });
    const c = await file();
    await settle();
    expect((await complaintOf(c.id))!.routingReview!.reasons).toEqual(['POLICY_REQUIRES_APPROVAL']);
  });

  it('routes to the department but asks the manager when nobody is eligible', async () => {
    build();
    await seed(false);
    const c = await file();
    await settle();
    const wo = await woOf(c.id);
    expect(wo).toMatchObject({ status: 'PENDING_ASSIGNMENT' });
    expect(wo!.assignee).toBeUndefined();
    expect(wo!.managerReview!.reasons).toEqual(['NO_ELIGIBLE_MEMBER']);
    expect((await complaintOf(c.id))!.status).toBe('ASSIGNED');
  });

  it('skips members at the workload cap', async () => {
    build(provider(good()), { ...DEFAULT_ASSIGNMENT_POLICY, maxOpenWorkOrdersPerMember: 1 });
    const a = await file();
    const b = await file();
    const c = await file();
    await settle();
    const assignees = await Promise.all([a, b, c].map(async (x) => String((await woOf(x.id))!.assignee ?? 'none')));
    expect(assignees.sort()).toEqual([w1.id, w2.id, 'none'].sort());
  });

  it('is idempotent: re-running analysis never creates a second work order', async () => {
    const c = await file();
    await settle();
    await call('post', `/complaints/${c.publicId}/analysis`, admin, {});
    await settle();
    expect(await WorkOrder.countDocuments({ complaint: c.id })).toBe(1);
  });
});

// ---- manual assignment and review queue ---------------------------------------------------------------
describe('manual assignment', () => {
  beforeEach(async () => {
    build(provider(good({ certainty: 'LOW' }))); // everything needs review
    await seed();
  });
  const body = (o: object = {}) => ({ departmentId: roads, priority: 'P3', reason: 'Checked the report.', ...o });

  it('lists the queue per scope', async () => {
    const c = await file();
    await settle();
    const q = await call('get', '/assignments/queue', admin);
    expect(q.body.data).toEqual([expect.objectContaining({ publicId: c.publicId, reviewReasons: expect.arrayContaining(['LOW_CONFIDENCE']), department: null, suggestedDepartment: { id: roads, name: 'A Roads' } })]);
    // Not routed yet, but the AI suggested Roads: its managers get the decision; other managers don't.
    expect((await call('get', '/assignments/queue', roadsMgr)).body.data.map((x: { publicId: string }) => x.publicId)).toEqual([c.publicId]);
    expect((await call('get', '/assignments/queue', waterMgr)).body.data).toEqual([]);
    expect((await call('get', '/assignments/queue', alice)).status).toBe(403);
    expect((await call('get', '/assignments/queue', w1)).status).toBe(403);
    await call('post', `/complaints/${c.publicId}/classify`, admin, { departmentId: roads, category: 'roads' });
    expect((await call('get', '/assignments/queue', roadsMgr)).body.data.map((x: { publicId: string }) => x.publicId)).toEqual([c.publicId]);
    expect((await call('get', '/assignments/queue', waterMgr)).body.data).toEqual([]);
  });

  it('admin can route anywhere valid; the actor and source come from the server', async () => {
    const c = await file();
    await settle();
    expect((await call('post', `/complaints/${c.publicId}/assign`, admin, body({ source: 'AUTO' }))).status).toBe(400);
    expect((await call('post', `/complaints/${c.publicId}/assign`, admin, body({ assignedBy: w1.id }))).status).toBe(400);
    const res = await call('post', `/complaints/${c.publicId}/assign`, admin, body({ assigneeId: w2.id }));
    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/api/v1/work-orders/${res.body.data.workOrder.publicId}`);
    expect(res.body.data.workOrder).toMatchObject({ status: 'ASSIGNED', assignmentSource: 'ADMIN_OVERRIDE', assignee: { id: w2.id }, department: { id: roads } });
    const entry = await AuditLog.findOne({ action: 'assignment.decided', targetId: c.id }).lean();
    expect(entry).toMatchObject({ actorType: 'USER' });
    expect(String(entry!.actor)).toBe(admin.id);
  });

  it('managers decide only for complaints routed to their own department', async () => {
    const c = await file();
    await settle();
    // The AI suggested Roads, so Roads managers can already see it; others can't.
    expect((await call('post', `/complaints/${c.publicId}/assign`, waterMgr, body({ departmentId: water }))).status).toBe(404);
    expect((await call('post', `/complaints/${c.publicId}/assign`, roadsMgr, body({ departmentId: water, category: 'water' }))).status).toBe(403);
    await call('post', `/complaints/${c.publicId}/classify`, admin, { departmentId: roads, category: 'roads' });
    expect((await call('post', `/complaints/${c.publicId}/assign`, roadsMgr, body({ departmentId: water, category: 'water' }))).status).toBe(403);
    expect((await call('post', `/complaints/${c.publicId}/assign`, waterMgr, body({ departmentId: water }))).status).toBe(404);
    expect((await call('post', `/complaints/${c.publicId}/assign`, w1, body())).status).toBe(403);
    expect(await WorkOrder.countDocuments()).toBe(0);
    const res = await call('post', `/complaints/${c.publicId}/assign`, roadsMgr, body({ assigneeId: w1.id }));
    expect(res.status).toBe(201);
    expect(res.body.data.workOrder.assignmentSource).toBe('MANAGER');
  });

  it('validates department, category and assignee', async () => {
    const c = await file();
    await settle();
    expect((await call('post', `/complaints/${c.publicId}/assign`, admin, body({ departmentId: water }))).body.error.details[0].field).toBe('body.departmentId');
    expect((await call('post', `/complaints/${c.publicId}/assign`, admin, body({ assigneeId: waterW.id }))).body.error.details[0].field).toBe('body.assigneeId');
    await Department.updateOne({ _id: roads }, { isActive: false });
    expect((await call('post', `/complaints/${c.publicId}/assign`, admin, body())).status).toBe(400);
    expect(await WorkOrder.countDocuments()).toBe(0);
  });

  it('only one of concurrent decisions wins; no second work order', async () => {
    const c = await file();
    await settle();
    const [a, b] = await Promise.all([
      call('post', `/complaints/${c.publicId}/assign`, admin, body({ assigneeId: w1.id })),
      call('post', `/complaints/${c.publicId}/assign`, admin, body({ assigneeId: w2.id })),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await WorkOrder.countDocuments({ complaint: c.id })).toBe(1);
    expect((await call('post', `/complaints/${c.publicId}/assign`, admin, body())).status).toBe(409);
  });
});

// ---- lifecycle -----------------------------------------------------------------------------------------------
describe('work-order lifecycle', () => {
  let wo: string;
  let cid: string;
  beforeEach(async () => {
    build();
    await seed();
    const c = await file();
    await settle();
    cid = c.id;
    wo = (await woOf(c.id))!.publicId!;
  });
  const act = (action: string, who: Actor, b: object = {}) => call('post', `/work-orders/${wo}/${action}`, who, b);
  const status = async () => [(await WorkOrder.findOne({ publicId: wo }).lean())!.status, (await complaintOf(cid))!.status];

  it('runs accept → start → block → resume, mirroring the complaint', async () => {
    expect((await act('start', w1)).status).toBe(409); // must accept first
    expect((await act('accept', w1)).status).toBe(200);
    expect(await status()).toEqual(['ACCEPTED', 'ACCEPTED']);
    expect((await act('accept', w1)).status).toBe(409);
    expect((await act('start', w1)).status).toBe(200);
    expect(await status()).toEqual(['IN_PROGRESS', 'IN_PROGRESS']);
    expect((await act('block', w1, { reason: 'Waiting for asphalt' })).status).toBe(400); // next action required
    const blocked = await act('block', w1, { reason: 'Waiting for asphalt', nextAction: 'Resume when delivered' });
    expect(blocked.body.data.workOrder.blocked).toMatchObject({ reason: 'Waiting for asphalt', nextAction: 'Resume when delivered' });
    expect(await status()).toEqual(['BLOCKED', 'BLOCKED']);
    expect((await act('start', w1)).body.data.workOrder.blocked).toBeNull();
    expect(await status()).toEqual(['IN_PROGRESS', 'IN_PROGRESS']);
    const detail = (await call('get', `/work-orders/${wo}`, w1)).body.data.workOrder;
    expect(detail.history.map((h: { action: string }) => h.action)).toEqual(['created', 'assign_staff', 'accept', 'start', 'block', 'start']);
    expect(detail.allowedActions).toEqual(expect.arrayContaining(['block', 'submit_resolution']));
    // Work in progress is never "resolved" by these actions.
    expect((await complaintOf(cid))!.status).not.toBe('RESOLVED');
  });

  it('only the assignee acts on the work; others are refused or see nothing', async () => {
    expect((await act('accept', w2)).status).toBe(403); // same department, not assignee
    expect((await act('accept', roadsMgr)).status).toBe(403);
    expect((await act('accept', waterW)).status).toBe(404);
    expect((await call('get', `/work-orders/${wo}`, alice)).status).toBe(404); // citizens never see work orders
    expect((await call('get', `/work-orders/${wo}`, waterMgr)).status).toBe(404);
    expect(await status()).toEqual(['ASSIGNED', 'ASSIGNED']);
  });

  it('a revoked member loses assignee rights immediately', async () => {
    await DepartmentMembership.updateOne({ user: w1.id, department: roads }, { status: 'INACTIVE' });
    expect((await act('accept', w1)).status).toBe(404);
    expect(await status()).toEqual(['ASSIGNED', 'ASSIGNED']);
  });

  it('decline sends it back to the manager, who reassigns', async () => {
    expect((await act('decline', w1, { reason: 'On leave this week' })).status).toBe(200);
    const d = (await call('get', `/work-orders/${wo}`, roadsMgr)).body.data.workOrder;
    expect(d).toMatchObject({ status: 'PENDING_ASSIGNMENT', assignee: null, reviewRequired: ['ASSIGNEE_DECLINED'] });
    expect((await act('assign', w2, { assigneeId: w2.id })).status).toBe(403); // members can't assign
    expect((await act('assign', roadsMgr, { assigneeId: waterW.id })).status).toBe(400); // not in department
    const res = await act('assign', roadsMgr, { assigneeId: w2.id, reason: 'Covering for w1' });
    expect(res.body.data.workOrder).toMatchObject({ status: 'ASSIGNED', assignee: { id: w2.id }, reviewRequired: [] });
  });

  it('cancel keeps history and sends the complaint back to triage', async () => {
    expect((await act('cancel', w1, { reason: 'Not ours' })).status).toBe(403);
    expect((await act('cancel', roadsMgr, { reason: 'Private road, not municipal' })).status).toBe(200);
    expect(await status()).toEqual(['CANCELLED', 'UNDER_REVIEW']);
    const stored = await complaintOf(cid);
    expect(stored!.department).toBeUndefined();
    expect((await call('get', '/assignments/queue', admin)).body.data.map((x: { publicId: string }) => x.publicId)).toContain(stored!.publicId);
    // A new decision creates a new work order; the cancelled one stays.
    expect((await call('post', `/complaints/${stored!.publicId}/assign`, admin, { departmentId: roads, priority: 'P3', reason: 'Re-routed after review' })).status).toBe(201);
    expect(await WorkOrder.countDocuments({ complaint: cid })).toBe(2);
    expect(await WorkOrder.countDocuments({ complaint: cid, activeFor: { $exists: true } })).toBe(1);
  });

  it('transfer is admin-only and resets assignment in the new department', async () => {
    await Department.updateOne({ _id: water }, { categories: ['water', 'roads'] });
    expect((await act('transfer', roadsMgr, { departmentId: water, reason: 'Wrong team' })).status).toBe(403);
    const res = await act('transfer', admin, { departmentId: water, reason: 'Water team owns this stretch' });
    expect(res.body.data.workOrder).toMatchObject({ status: 'PENDING_ASSIGNMENT', assignee: null, department: { id: water } });
    expect(String((await complaintOf(cid))!.department)).toBe(water);
    expect((await call('get', `/work-orders/${wo}`, roadsMgr)).status).toBe(404);
    expect((await call('get', `/work-orders/${wo}`, waterMgr)).status).toBe(200);
  });

  it('notes are internal and lists are scoped', async () => {
    await act('notes', w1, { text: 'Site visit booked for Monday.' });
    const d = (await call('get', `/work-orders/${wo}`, roadsMgr)).body.data.workOrder;
    expect(d.notes).toEqual([expect.objectContaining({ text: 'Site visit booked for Monday.', author: { id: w1.id, name: 'w1' } })]);
    expect(JSON.stringify(d)).not.toMatch(/alice|@t\.local|passwordHash/);
    expect((await call('get', '/work-orders', w1)).body.data.map((x: { publicId: string }) => x.publicId)).toEqual([wo]);
    expect((await call('get', '/work-orders', w2)).body.data).toEqual([]);
    expect((await call('get', '/work-orders?scope=department', w2)).body.meta.pagination.total).toBe(1);
    expect((await call('get', '/work-orders?scope=department', waterW)).body.meta.pagination.total).toBe(0);
    expect((await call('get', '/work-orders?scope=department', alice)).status).toBe(403);
    expect((await call('get', '/work-orders?scope=all', roadsMgr)).status).toBe(403);
    expect((await call('get', '/work-orders?scope=all', admin)).body.meta.pagination.total).toBe(1);
    expect((await call('get', '/work-orders?status=BOGUS', w1)).status).toBe(400);
  });
});
