// Phase 9: evidence, resolution verification, disputes, closing and feedback.
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AiProviderError, type AiProvider, type ClassificationOutput, type ImageAssessment } from '../src/ai/types.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import { AIAnalysis, AuditLog, AuthSession, Complaint, Counter, Department, DepartmentMembership, Dispute, Evidence, Feedback, User, WorkOrder } from '../src/models/index.js';
import { createAnalysisService, type AnalysisService } from '../src/services/analysis/index.js';
import { DEFAULT_VERIFICATION_POLICY, type VerificationPolicy } from '../src/services/resolution.js';
import { assertSafeKey, createMemoryStorage, disabledStorage, type ObjectStorage } from '../src/storage/index.js';
import { createLogger } from '../src/utils/logger.js';
import { testAuthConfig } from './helpers.js';
import { testMongo } from './mongo.js';

const silent = createLogger({ logLevel: 'silent', nodeEnv: 'test' });
const PASSWORD = 'phase nine password';
const many = { windowMs: 60_000, limit: 10_000 };
const clean: ImageAssessment = { visualInconsistency: 'NONE_OBSERVED', inconsistencyNotes: '', relevance: 'APPEARS_RELATED', relevanceNotes: 'Shows the road.' };
const good: ClassificationOutput = {
  category: 'roads',
  departmentRef: 'D1',
  priority: 'P2',
  certainty: 'HIGH',
  summary: 'Pothole.',
  rationale: 'Road damage.',
  missingInformation: [],
  reviewRecommended: false,
  reviewReasons: [],
};
function provider(image: ImageAssessment | AiProviderError = clean): AiProvider {
  return {
    name: 'fake',
    model: 'fake-1',
    enabled: true,
    async classifyComplaint() {
      return { output: good, meta: { provider: 'fake', model: 'fake-1', promptVersion: 'v1', latencyMs: 1 } };
    },
    async assessImage() {
      if (image instanceof AiProviderError) throw image;
      return { output: image, meta: { provider: 'fake', model: 'fake-1', promptVersion: 'v1', latencyMs: 1 } };
    },
  };
}
const jpeg = (tag = '') => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from(`JFIF${tag}${Math.random()}`), Buffer.alloc(300, 0x22)]);

const MODELS = [User, Department, DepartmentMembership, AuthSession, Complaint, Counter, Evidence, AIAnalysis, WorkOrder, Dispute, Feedback] as unknown as (typeof User)[];
let mongo: Awaited<ReturnType<typeof testMongo>>;
beforeAll(async () => {
  mongo = await testMongo();
  await mongoose.connect(mongo.getUri(), { dbName: 'civicfix-phase9-test' });
  await Promise.all(MODELS.map((m) => m.syncIndexes()));
});
afterAll(async () => {
  await mongoose.disconnect();
});

let analysis: AnalysisService;
let app: ReturnType<typeof createApp>;
let storage: ObjectStorage;
function build(opts: { image?: ImageAssessment | AiProviderError; policy?: Partial<VerificationPolicy>; storage?: ObjectStorage } = {}) {
  storage = opts.storage ?? createMemoryStorage();
  analysis = createAnalysisService({ provider: provider(opts.image), logger: silent, maxAttempts: 1, autoRun: false, storage });
  app = createApp({
    config: { nodeEnv: 'test', corsOrigins: [], jsonBodyLimit: '100kb', auth: testAuthConfig },
    logger: silent,
    isDatabaseConnected: () => true,
    checkDatabase: async () => true,
    isShuttingDown: () => false,
    authRateLimits: { register: many, loginPerIp: many, loginPerIpAndEmail: many, refresh: many },
    complaintCreateLimit: many,
    uploadLimit: many,
    analysis,
    storage,
    verificationPolicy: { ...DEFAULT_VERIFICATION_POLICY, ...opts.policy },
  });
}
const settle = async () => {
  for (let i = 0; i < 20; i++) {
    await analysis.runner.drain();
    if (!(await AIAnalysis.exists({ status: { $in: ['PENDING', 'RUNNING'] } }))) return;
  }
};

type Actor = { id: string; token: string };
let admin: Actor, alice: Actor, bob: Actor, mgr: Actor, w1: Actor, w2: Actor, otherMgr: Actor;
let roads: string;
/** Whoever the current work order was assigned to (w1 or w2). */
let worker: Actor;
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
  w2 = await actor('w2@t.local');
  otherMgr = await actor('other@t.local');
  await DepartmentMembership.create([
    { user: mgr.id, department: roads, role: 'MANAGER' },
    { user: w1.id, department: roads, role: 'MEMBER' },
    { user: w2.id, department: roads, role: 'MEMBER' },
    { user: otherMgr.id, department: water, role: 'MANAGER' },
  ]);
}

const call = (method: 'get' | 'post', path: string, who?: Actor, body?: unknown) => {
  let r = request(app)[method](`/api/v1${path}`);
  if (who) r = r.set('Authorization', `Bearer ${who.token}`);
  if (body !== undefined) r = r.set('Content-Type', 'application/json').send(JSON.stringify(body));
  return r;
};
const upload = (publicId: string, who: Actor, purpose: string, bytes: Buffer = jpeg(), type = 'image/jpeg', extra = '') =>
  request(app).post(`/api/v1/complaints/${publicId}/evidence?purpose=${purpose}${extra}`).set('Authorization', `Bearer ${who.token}`).set('Content-Type', type).send(bytes);

/** Complaint filed by alice, auto-assigned to w1, accepted and started. */
async function inProgress() {
  const res = await call('post', '/complaints', alice, { title: 'Deep pothole near the bus stop', description: 'Large pothole on the service road near the stop.', location: { lat: 13.0, lng: 74.79 + Math.random() }, selectedCategory: 'roads' });
  const c = res.body.data.complaint as { publicId: string; id: string };
  await settle();
  const doc = (await WorkOrder.findOne({ complaint: c.id }).lean())!;
  const wo = doc.publicId!;
  worker = String(doc.assignee) === w2.id ? w2 : w1;
  expect((await call('post', `/work-orders/${wo}/accept`, worker, {})).status).toBe(200);
  expect((await call('post', `/work-orders/${wo}/start`, worker, {})).status).toBe(200);
  return { c, wo };
}
async function submitWithEvidence(publicId: string, wo: string, analyse = true) {
  const ev = await upload(publicId, worker, 'RESOLUTION');
  expect(ev.status).toBe(201);
  if (analyse) await settle();
  return call('post', `/work-orders/${wo}/resolution`, worker, { completionNotes: 'Filled and compacted the pothole with asphalt.', evidenceIds: [ev.body.data.evidence.id] });
}
async function resolved() {
  const { c, wo } = await inProgress();
  await submitWithEvidence(c.publicId, wo);
  expect((await call('post', `/work-orders/${wo}/verification`, mgr, { decision: 'APPROVE', reason: 'Photos match the location.' })).status).toBe(200);
  return { c, wo };
}
const statuses = async (cid: string, wo: string) => [(await WorkOrder.findOne({ publicId: wo }).lean())!.status, (await Complaint.findById(cid).lean())!.status];

// ---- evidence -------------------------------------------------------------------------------------------
describe('evidence', () => {
  beforeEach(async () => {
    build();
    await seed();
  });

  it('accepts a citizen photo, hides storage details, and queues an authenticity check', async () => {
    const { c } = await inProgress();
    const res = await upload(c.publicId, alice, 'ADDITIONAL', jpeg(), 'image/jpeg', '&caption=Still%20there');
    expect(res.status).toBe(201);
    const e = res.body.data.evidence;
    expect(e).toMatchObject({ purpose: 'ADDITIONAL', mediaType: 'IMAGE', contentType: 'image/jpeg', caption: 'Still there', contentUrl: `/api/v1/evidence/${e.id}/content` });
    expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(e.authenticity).toBeUndefined(); // citizens don't see internal checks
    expect(JSON.stringify(res.body)).not.toMatch(/storageKey|evidence\/[0-9a-f]{24}\/[0-9a-f]{24}-/);
    await settle();
    const staffView = (await call('get', `/complaints/${c.publicId}/evidence`, mgr)).body.data;
    expect(staffView[0].authenticity).toBe('NO_SUSPICIOUS_SIGNALS_DETECTED');
    expect(await AuditLog.exists({ action: 'evidence.uploaded', targetId: e.id })).toBeTruthy();
  });

  it('validates the real content, type and size', async () => {
    const { c } = await inProgress();
    expect((await upload(c.publicId, alice, 'ADDITIONAL', Buffer.from('hello'), 'text/plain')).status).toBe(415);
    expect((await upload(c.publicId, alice, 'ADDITIONAL', jpeg(), 'image/png')).status).toBe(415);
    expect((await upload(c.publicId, alice, 'ADDITIONAL', Buffer.from('<?php system($_GET[1]); ?>'), 'image/jpeg')).status).toBe(415);
    expect((await upload(c.publicId, alice, 'ADDITIONAL', Buffer.concat([jpeg(), Buffer.alloc(11 * 1024 * 1024)]))).status).toBe(413);
    expect((await upload(c.publicId, alice, 'SELFIE')).status).toBe(400);
    expect(await Evidence.countDocuments()).toBe(0);
  });

  it('enforces who may add which evidence', async () => {
    const { c } = await inProgress();
    expect((await upload(c.publicId, bob, 'ADDITIONAL')).status).toBe(404);
    expect((await upload(c.publicId, otherMgr, 'ADDITIONAL')).status).toBe(404);
    expect((await upload(c.publicId, alice, 'RESOLUTION')).status).toBe(403);
    expect((await upload(c.publicId, w2, 'RESOLUTION')).status).toBe(403); // not the assignee
    expect((await upload(c.publicId, w1, 'COMPLAINT_REPORT')).status).toBe(403);
    expect((await upload(c.publicId, alice, 'COMPLAINT_REPORT')).status).toBe(409); // already assigned
    expect((await upload(c.publicId, alice, 'DISPUTE')).status).toBe(400); // needs disputeId
    expect((await upload(c.publicId, w1, 'WORK_PROGRESS')).status).toBe(201);
    expect(await Evidence.countDocuments()).toBe(1);
  });

  it('downloads only for people who can see the complaint, and audits it', async () => {
    const { c } = await inProgress();
    const bytes = jpeg('download');
    const id = (await upload(c.publicId, alice, 'ADDITIONAL', bytes)).body.data.evidence.id;
    const ok = await call('get', `/evidence/${id}/content`, mgr).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('image/jpeg');
    expect(ok.headers['cache-control']).toBe('private, no-store');
    expect(Buffer.compare(ok.body as Buffer, bytes)).toBe(0);
    expect((await call('get', `/evidence/${id}/content`, bob)).status).toBe(404);
    expect((await call('get', `/evidence/${id}/content`, otherMgr)).status).toBe(404);
    expect((await call('get', `/evidence/${new mongoose.Types.ObjectId()}/content`, alice)).status).toBe(404);
    expect((await call('get', `/complaints/${c.publicId}/evidence`, bob)).status).toBe(404);
    expect(await AuditLog.exists({ action: 'evidence.downloaded', targetId: id, actor: mgr.id })).toBeTruthy();
  });

  it('answers 503 honestly when storage is not configured', async () => {
    build({ storage: disabledStorage });
    await seed();
    const res = await call('post', '/complaints', alice, { title: 'Deep pothole near the bus stop', description: 'Large pothole on the service road near the stop.', location: { lat: 13, lng: 74.8 } });
    const up = await upload(res.body.data.complaint.publicId, alice, 'COMPLAINT_REPORT');
    expect(up.status).toBe(503);
    expect(up.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(await Evidence.countDocuments()).toBe(0);
  });

  it('only accepts safe, server-generated storage keys', () => {
    for (const bad of ['../etc/passwd', '/abs/key', 'evidence/../../x', 'Evidence/A.jpg', 'a\\b']) expect(() => assertSafeKey(bad)).toThrow();
    expect(() => assertSafeKey('evidence/abc/def-123.jpg')).not.toThrow();
  });
});

// ---- resolution and verification -------------------------------------------------------------------------
describe('resolution and verification', () => {
  beforeEach(async () => {
    build();
    await seed();
  });

  it('a clean submission waits for a human: submitted is not resolved', async () => {
    const { c, wo } = await inProgress();
    const res = await submitWithEvidence(c.publicId, wo);
    expect(res.status).toBe(200);
    expect(res.body.data.assessment.outcome).toBe('SUFFICIENT');
    expect(await statuses(c.id, wo)).toEqual(['RESOLUTION_SUBMITTED', 'RESOLUTION_SUBMITTED']);
    expect(await AIAnalysis.exists({ analysisType: 'RESOLUTION_VERIFICATION', 'verification.outcome': 'SUFFICIENT' })).toBeTruthy();
  });

  it('uncertain evidence goes to verification-required, even with auto-approval on', async () => {
    build({ image: { ...clean, visualInconsistency: 'STRONG', inconsistencyNotes: 'Cloned patch.' }, policy: { autoApprove: true } });
    await seed();
    const { c, wo } = await inProgress();
    const res = await submitWithEvidence(c.publicId, wo);
    expect(res.body.data.assessment).toMatchObject({ outcome: 'UNCERTAIN', reasons: expect.arrayContaining(['A photo shows possible signs of editing or generation.']) });
    expect(await statuses(c.id, wo)).toEqual(['VERIFICATION_REQUIRED', 'VERIFICATION_REQUIRED']);
  });

  it('unchecked evidence is uncertain too', async () => {
    const { c, wo } = await inProgress();
    const res = await submitWithEvidence(c.publicId, wo, false);
    expect(res.body.data.assessment.outcome).toBe('UNCERTAIN');
  });

  it('auto-approval (when enabled by policy) only applies to fully clean submissions', async () => {
    build({ policy: { autoApprove: true } });
    await seed();
    const { c, wo } = await inProgress();
    await submitWithEvidence(c.publicId, wo);
    expect(await statuses(c.id, wo)).toEqual(['COMPLETED', 'RESOLVED']);
    expect((await WorkOrder.findOne({ publicId: wo }).lean())!.verificationDecision).toMatchObject({ decision: 'APPROVED', source: 'SYSTEM_POLICY' });
  });

  it('checks who submits and what is attached', async () => {
    const { c, wo } = await inProgress();
    const ev = (await upload(c.publicId, w1, 'RESOLUTION')).body.data.evidence.id;
    const other = (await upload(c.publicId, alice, 'ADDITIONAL')).body.data.evidence.id;
    const body = (ids: string[]) => ({ completionNotes: 'Filled and compacted the pothole.', evidenceIds: ids });
    expect((await call('post', `/work-orders/${wo}/resolution`, w2, body([ev]))).status).toBe(403);
    expect((await call('post', `/work-orders/${wo}/resolution`, mgr, body([ev]))).status).toBe(403);
    expect((await call('post', `/work-orders/${wo}/resolution`, w1, body([other]))).body.error.details[0].field).toBe('body.evidenceIds');
    expect((await call('post', `/work-orders/${wo}/resolution`, w1, body([]))).status).toBe(400);
    expect((await call('post', `/work-orders/${wo}/resolution`, w1, { evidenceIds: [ev] })).status).toBe(400);
    expect(await statuses(c.id, wo)).toEqual(['IN_PROGRESS', 'IN_PROGRESS']);
  });

  it('rejects submission in the wrong state and handles concurrent submits', async () => {
    const { c, wo } = await inProgress();
    const ev = (await upload(c.publicId, w1, 'RESOLUTION')).body.data.evidence.id;
    await settle();
    const body = { completionNotes: 'Filled and compacted the pothole.', evidenceIds: [ev] };
    const [a, b] = await Promise.all([call('post', `/work-orders/${wo}/resolution`, w1, body), call('post', `/work-orders/${wo}/resolution`, w1, body)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await call('post', `/work-orders/${wo}/resolution`, w1, body)).status).toBe(409);
  });

  it('verifier decisions: approve resolves, reject sends back, request-evidence allows resubmission', async () => {
    const { c, wo } = await inProgress();
    await submitWithEvidence(c.publicId, wo);
    const decide = (who: Actor, decision: string) => call('post', `/work-orders/${wo}/verification`, who, { decision, reason: 'Reviewed the photos.' });
    expect((await decide(w1, 'APPROVE')).status).toBe(403); // assignee can't verify own work
    expect((await decide(w2, 'APPROVE')).status).toBe(403);
    expect((await decide(otherMgr, 'APPROVE')).status).toBe(404);
    expect((await decide(mgr, 'MAYBE')).status).toBe(400);

    expect((await decide(mgr, 'REQUEST_EVIDENCE')).status).toBe(200);
    expect(await statuses(c.id, wo)).toEqual(['VERIFICATION_REQUIRED', 'VERIFICATION_REQUIRED']);
    expect((await decide(mgr, 'REQUEST_EVIDENCE')).status).toBe(409);
    expect((await submitWithEvidence(c.publicId, wo)).status).toBe(200); // resubmit with more evidence
    expect((await decide(mgr, 'REJECT')).status).toBe(200);
    expect(await statuses(c.id, wo)).toEqual(['IN_PROGRESS', 'IN_PROGRESS']);
    await submitWithEvidence(c.publicId, wo);
    const ok = await decide(admin, 'APPROVE');
    expect(ok.body.data.workOrder).toMatchObject({ status: 'COMPLETED', verificationDecision: { decision: 'APPROVED', source: 'VERIFIER' } });
    expect(await statuses(c.id, wo)).toEqual(['COMPLETED', 'RESOLVED']);
    expect((await Complaint.findById(c.id).lean())!.resolvedAt).toBeInstanceOf(Date);
    expect((await decide(mgr, 'APPROVE')).status).toBe(409);
    expect(await AuditLog.exists({ action: 'work_order.approve', actor: admin.id })).toBeTruthy();
  });
});

// ---- disputes, closing, feedback ------------------------------------------------------------------------------
describe('disputes, closing and feedback', () => {
  beforeEach(async () => {
    build();
    await seed();
  });
  const dispute = (publicId: string, who: Actor) => call('post', `/complaints/${publicId}/disputes`, who, { reason: 'The pothole opened up again after the rain.', category: 'NOT_FIXED' });

  it('only the reporter disputes a resolved complaint, once at a time', async () => {
    const { c: early } = await inProgress();
    expect((await dispute(early.publicId, alice)).status).toBe(409); // not resolved yet
    const { c } = await resolved();
    expect((await dispute(c.publicId, bob)).status).toBe(404);
    expect((await dispute(c.publicId, mgr)).status).toBe(403);
    const [a, b] = await Promise.all([dispute(c.publicId, alice), dispute(c.publicId, alice)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const d = (a.status === 201 ? a : b).body.data.dispute;
    expect(d).toMatchObject({ status: 'OPEN', category: 'NOT_FIXED', priorResolution: { completionNotes: 'Filled and compacted the pothole with asphalt.' } });
    expect(await Dispute.countDocuments({ complaint: c.id })).toBe(1);
    expect(await AuditLog.exists({ action: 'dispute.created', targetId: d.id })).toBeTruthy();
  });

  it('an open dispute blocks closing; upholding reopens the work', async () => {
    const { c, wo } = await resolved();
    const d = (await dispute(c.publicId, alice)).body.data.dispute;
    expect((await call('post', `/complaints/${c.publicId}/close`, alice, {})).status).toBe(409);
    expect((await call('post', `/disputes/${d.id}/decision`, w1, { decision: 'UPHOLD', reason: 'Agreed, still broken.' })).status).toBe(403);
    expect((await call('post', `/disputes/${d.id}/decision`, otherMgr, { decision: 'UPHOLD', reason: 'Agreed, still broken.' })).status).toBe(404);
    expect((await call('post', `/disputes/${d.id}/review`, mgr, {})).body.data.dispute.status).toBe('UNDER_REVIEW');
    const decided = await call('post', `/disputes/${d.id}/decision`, mgr, { decision: 'UPHOLD', reason: 'Site check shows it reopened.' });
    expect(decided.body.data.dispute).toMatchObject({ status: 'UPHELD', decision: { reason: 'Site check shows it reopened.' } });
    expect(await statuses(c.id, wo)).toEqual(['IN_PROGRESS', 'IN_PROGRESS']);
    expect((await WorkOrder.findOne({ publicId: wo }).lean())!.reopenedCount).toBe(1);
    expect((await call('post', `/disputes/${d.id}/decision`, mgr, { decision: 'DISMISS', reason: 'Changed my mind.' })).status).toBe(409);
    // History is preserved: the original resolution evidence stays on the dispute.
    expect((await Dispute.findById(d.id).lean())!.priorResolution.evidence).toHaveLength(1);
  });

  it('dismissing keeps the resolution; then the reporter can close and leave feedback once', async () => {
    const { c } = await resolved();
    const d = (await dispute(c.publicId, alice)).body.data.dispute;
    await call('post', `/disputes/${d.id}/decision`, admin, { decision: 'DISMISS', reason: 'Photos show a complete repair.' });
    expect((await Complaint.findById(c.id).lean())!.status).toBe('RESOLVED');
    expect((await call('post', `/complaints/${c.publicId}/close`, mgr, {})).status).toBe(409); // staff wait for the dispute window
    expect((await call('post', `/complaints/${c.publicId}/close`, bob, {})).status).toBe(404);
    const closed = await call('post', `/complaints/${c.publicId}/close`, alice, {});
    expect(closed.body.data.complaint.status).toBe('CLOSED');
    expect((await dispute(c.publicId, alice)).status).toBe(409);
    expect((await call('post', `/complaints/${c.publicId}/feedback`, alice, { rating: 4, comment: 'Quick fix.' })).status).toBe(201);
    expect((await call('post', `/complaints/${c.publicId}/feedback`, alice, { rating: 5 })).status).toBe(409);
    expect((await call('post', `/complaints/${c.publicId}/feedback`, alice, { rating: 6 })).status).toBe(400);
  });

  it('staff may close after the dispute window; feedback needs a resolution', async () => {
    const { c } = await inProgress();
    expect((await call('post', `/complaints/${c.publicId}/feedback`, alice, { rating: 3 })).status).toBe(409);
    const r = await resolved();
    await Complaint.updateOne({ _id: r.c.id }, { resolvedAt: new Date(Date.now() - 15 * 86_400_000) });
    expect((await dispute(r.c.publicId, alice)).status).toBe(409); // window passed
    expect((await call('post', `/complaints/${r.c.publicId}/close`, mgr, {})).status).toBe(200);
  });

  it('withdraw, listing and visibility', async () => {
    const { c } = await resolved();
    const d = (await dispute(c.publicId, alice)).body.data.dispute;
    expect((await call('get', `/disputes/${d.id}`, bob)).status).toBe(404);
    expect((await call('get', '/disputes', alice)).body.data.map((x: { id: string }) => x.id)).toEqual([d.id]);
    expect((await call('get', '/disputes?scope=department', mgr)).body.meta.pagination.total).toBe(1);
    expect((await call('get', '/disputes?scope=department', otherMgr)).body.meta.pagination.total).toBe(0);
    expect((await call('get', '/disputes?scope=all', mgr)).status).toBe(403);
    expect((await call('post', `/disputes/${d.id}/withdraw`, mgr, {})).status).toBe(403);
    expect((await call('post', `/disputes/${d.id}/withdraw`, alice, {})).body.data.dispute.status).toBe('WITHDRAWN');
    expect((await call('post', `/disputes/${d.id}/withdraw`, alice, {})).status).toBe(409);
    // Dispute evidence attaches to an open dispute only.
    const again = (await dispute(c.publicId, alice)).body.data.dispute;
    expect((await upload(c.publicId, alice, 'DISPUTE', jpeg(), 'image/jpeg', `&disputeId=${again.id}`)).status).toBe(201);
    expect((await upload(c.publicId, alice, 'DISPUTE', jpeg(), 'image/jpeg', `&disputeId=${d.id}`)).status).toBe(404);
  });
});
