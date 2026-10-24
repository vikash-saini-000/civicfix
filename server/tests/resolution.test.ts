// Phase 9: evidence, resolution verification, disputes, closing and feedback.
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AiProviderError, type AiProvider, type ClassificationOutput, type ImageAssessment, type ResolutionComparison, type ResolutionComparisonInput } from '../src/ai/types.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import { AIAnalysis, AuditLog, AuthSession, Complaint, Counter, Department, DepartmentMembership, Dispute, Evidence, Feedback, User, WorkOrder } from '../src/models/index.js';
import { createAnalysisService, type AnalysisService } from '../src/services/analysis/index.js';
import { DEFAULT_VERIFICATION_POLICY, type VerificationPolicy } from '../src/services/resolution.js';
import { assertSafeKey, createMemoryStorage, disabledStorage, type ObjectStorage } from '../src/storage/index.js';
import { createLogger } from '../src/utils/logger.js';
import { jpegWithExif, testAuthConfig } from './helpers.js';
import { readCaptureMetadata } from '../src/services/analysis/exif.js';
import { testMongo } from './mongo.js';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { detectVideoTools, type VideoTools } from '../src/media/video.js';
import type { PrivacyRegions } from '../src/ai/types.js';

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
  confidence: 0.92,
  publicSafetyHazard: false,
  spamLikely: false,
  followUpQuestions: [],
};
const fixed: ResolutionComparison = { sameLocation: 'YES', issueAppearsFixed: 'YES', matchesCategory: 'YES', notes: 'Pothole filled; same kerb and pole.' };
type ComparisonScript = ResolutionComparison | AiProviderError | ((input: ResolutionComparisonInput) => ResolutionComparison);
let imageCalls = 0;
let comparisonInputs: ResolutionComparisonInput[] = [];
let privacyCalls = 0;
function provider(image: ImageAssessment | AiProviderError = clean, comparison: ComparisonScript = fixed, privacy?: PrivacyRegions): AiProvider {
  return {
    ...(privacy && {
      async detectPrivacyRegions() {
        privacyCalls++;
        return { output: privacy, meta: { provider: 'fake', model: 'fake-1', promptVersion: 'v1', latencyMs: 1 } };
      },
      async assessVideo() {
        imageCalls++;
        if (image instanceof AiProviderError) throw image;
        return { output: image, meta: { provider: 'fake', model: 'fake-1', promptVersion: 'v1', latencyMs: 1 } };
      },
    }),
    async compareResolution(input) {
      comparisonInputs.push(input);
      if (comparison instanceof AiProviderError) throw comparison;
      const output = typeof comparison === 'function' ? comparison(input) : comparison;
      return { output, meta: { provider: 'fake', model: 'fake-1', promptVersion: 'v1', latencyMs: 1 } };
    },
    name: 'fake',
    model: 'fake-1',
    enabled: true,
    async classifyComplaint() {
      return { output: good, meta: { provider: 'fake', model: 'fake-1', promptVersion: 'v1', latencyMs: 1 } };
    },
    async assessImage() {
      imageCalls++;
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
function build(
  opts: {
    image?: ImageAssessment | AiProviderError;
    comparison?: ComparisonScript;
    policy?: Partial<VerificationPolicy>;
    storage?: ObjectStorage;
    mediaGate?: 'block' | 'flag';
    video?: VideoTools;
    maxVideoSeconds?: number;
    privacy?: PrivacyRegions;
  } = {},
) {
  storage = opts.storage ?? createMemoryStorage();
  imageCalls = 0;
  privacyCalls = 0;
  comparisonInputs = [];
  analysis = createAnalysisService({ provider: provider(opts.image, opts.comparison, opts.privacy), logger: silent, maxAttempts: 1, autoRun: false, storage, mediaUploadGate: opts.mediaGate, video: opts.video });
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
    video: opts.video,
    maxVideoSeconds: opts.maxVideoSeconds,
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

/** Where the latest inProgress() complaint was reported; resolution photos are taken here by default. */
let site = { lat: 13.0, lng: 74.79 };
/** Complaint filed by alice, auto-assigned to w1, accepted and started. */
async function inProgress() {
  site = { lat: 13.0, lng: 74.79 + Math.round(Math.random() * 1e5) / 1e5 };
  const res = await call('post', '/complaints', alice, { title: 'Deep pothole near the bus stop', description: 'Large pothole on the service road near the stop.', location: site, selectedCategory: 'roads' });
  const c = res.body.data.complaint as { publicId: string; id: string };
  await settle();
  const doc = (await WorkOrder.findOne({ complaint: c.id }).lean())!;
  const wo = doc.publicId!;
  worker = String(doc.assignee) === w2.id ? w2 : w1;
  expect((await call('post', `/work-orders/${wo}/accept`, worker, {})).status).toBe(200);
  expect((await call('post', `/work-orders/${wo}/start`, worker, {})).status).toBe(200);
  return { c, wo };
}
async function submitWithEvidence(publicId: string, wo: string, analyse = true, photo: Buffer = jpegWithExif(site)) {
  const ev = await upload(publicId, worker, 'RESOLUTION', photo);
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

  it('refuses AI-generated or edited files before storing anything, for citizens and workers', async () => {
    const { c, wo } = await inProgress();
    build({ image: { ...clean, visualInconsistency: 'STRONG', inconsistencyNotes: 'Flat illustration, not a photo.' } });
    for (const [who, purpose] of [[alice, 'ADDITIONAL'], [worker, 'RESOLUTION']] as const) {
      const res = await upload(c.publicId, who, purpose, jpegWithExif(site));
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('MEDIA_REJECTED');
      expect(res.body.error.message).not.toMatch(/illustration/i); // staff-only detail stays internal
    }
    expect(await Evidence.countDocuments()).toBe(0);
    expect(await AuditLog.countDocuments({ action: 'evidence.rejected' })).toBe(2);
    // Without accepted evidence the worker can't submit the resolution.
    expect((await WorkOrder.findOne({ publicId: wo }).lean())!.status).toBe('IN_PROGRESS');
  });

  it('refuses files whose metadata declares an AI generator, even if they look clean', async () => {
    const { c } = await inProgress();
    const res = await upload(c.publicId, alice, 'ADDITIONAL', jpeg('http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia'));
    expect(res.status).toBe(422);
    expect(await Evidence.countDocuments()).toBe(0);
  });

  it('stores the upload-time check as the authenticity result, without a second model call', async () => {
    const { c } = await inProgress();
    const before = imageCalls;
    const res = await upload(c.publicId, alice, 'ADDITIONAL');
    expect(res.status).toBe(201);
    expect(await AIAnalysis.findOne({ analysisType: 'MEDIA_AUTHENTICITY', evidence: res.body.data.evidence.id }).lean()).toMatchObject({ status: 'SUCCEEDED', authenticity: { outcome: 'NO_SUSPICIOUS_SIGNALS_DETECTED' } });
    await settle();
    expect(imageCalls - before).toBe(1);
  });

  it('pre-checks a photo before the complaint exists, and reuses that result on upload', async () => {
    const check = (bytes: Buffer) => request(app).post('/api/v1/evidence/check').set('Authorization', `Bearer ${alice.token}`).set('Content-Type', 'image/jpeg').send(bytes);
    const photo = jpeg();
    expect((await check(photo)).body.data).toEqual({ allowed: true, message: null });
    const { c } = await inProgress();
    const before = imageCalls;
    expect((await upload(c.publicId, alice, 'ADDITIONAL', photo)).status).toBe(201);
    expect(imageCalls).toBe(before);
    expect((await request(app).post('/api/v1/evidence/check').set('Content-Type', 'image/jpeg').send(photo)).status).toBe(401);

    build({ image: { ...clean, visualInconsistency: 'STRONG', inconsistencyNotes: 'Generated.' } });
    const res = await check(jpeg());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ allowed: false, message: expect.stringMatching(/AI-generated or edited/) });
    expect(await Evidence.countDocuments()).toBe(1);
  });

  it('with the gate set to flag, flagged files are stored and marked for review', async () => {
    build({ image: { ...clean, visualInconsistency: 'STRONG', inconsistencyNotes: 'Cloned area.' }, mediaGate: 'flag' });
    const { c } = await inProgress();
    expect((await upload(c.publicId, alice, 'ADDITIONAL')).status).toBe(201);
    expect((await call('get', `/complaints/${c.publicId}/evidence`, mgr)).body.data[0].authenticity).toBe('POTENTIAL_MANIPULATION');
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
    const bytes = jpegWithExif({ lat: 13.0072, lng: 74.7956, takenAt: '2026:10:24 09:00:00' });
    const id = (await upload(c.publicId, alice, 'ADDITIONAL', bytes)).body.data.evidence.id;
    const get = (who: Actor, variant = '') =>
      call('get', `/evidence/${id}/content${variant}`, who).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    // Until the privacy copy exists, only the uploader gets the file.
    expect((await get(mgr)).status).toBe(409);
    const own = await get(alice);
    expect(own.status).toBe(200);
    expect(own.headers['x-evidence-variant']).toBe('ORIGINAL');
    expect(Buffer.compare(own.body as Buffer, bytes)).toBe(0);
    await settle();
    const ok = await get(mgr);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('image/jpeg');
    expect(ok.headers['cache-control']).toBe('private, no-store');
    expect(ok.headers['x-evidence-variant']).toBe('SHARED');
    // The shared copy is a re-encoded image without metadata: no GPS or capture time left in it.
    expect(Buffer.compare(ok.body as Buffer, bytes)).not.toBe(0);
    expect(readCaptureMetadata(ok.body as Buffer)).toEqual({});
    expect((await get(mgr, '?variant=original')).status).toBe(403);
    const original = await get(admin, '?variant=original');
    expect(original.headers['x-evidence-variant']).toBe('ORIGINAL');
    expect(Buffer.compare(original.body as Buffer, bytes)).toBe(0);
    expect(await AuditLog.exists({ action: 'evidence.original_downloaded', targetId: id, actor: admin.id })).toBeTruthy();
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
// ---- video evidence (real ffmpeg; skipped where it isn't installed) ----------------------------------------
const videoTools = await detectVideoTools({ ffmpegPath: process.env.FFMPEG_PATH ?? 'ffmpeg', ffprobePath: process.env.FFPROBE_PATH ?? 'ffprobe' });
describe.skipIf(!videoTools.enabled)('video evidence', { timeout: 120_000 }, () => {
  let dir: string;
  let n = 0;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'civicfix-video-evidence-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    build({ video: videoTools, maxVideoSeconds: 10, privacy: { regions: [{ kind: 'FACE', x: 0.1, y: 0.1, width: 0.2, height: 0.3 }] } });
    await seed();
  });

  /** A phone-style clip recorded at the complaint site. */
  async function clip(opts: { seconds?: number; format?: 'mp4' | 'mov'; at?: { lat: number; lng: number } } = {}) {
    const out = join(dir, `clip-${n++}.${opts.format ?? 'mp4'}`);
    const at = opts.at ?? site;
    const iso = `${at.lat >= 0 ? '+' : ''}${at.lat.toFixed(4)}${at.lng >= 0 ? '+' : ''}${at.lng.toFixed(4)}/`;
    await promisify(execFile)(process.env.FFMPEG_PATH ?? 'ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=320x240:rate=15:duration=${opts.seconds ?? 3}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-metadata', `creation_time=${new Date().toISOString()}`, '-metadata', `location=${iso}`, '-y', out,
    ]);
    return readFile(out);
  }

  it('accepts a phone video: stores length, capture time and GPS, checks it once, and shares a blurred MP4 copy', async () => {
    const { c } = await inProgress();
    const mov = await clip({ format: 'mov' });
    const res = await upload(c.publicId, alice, 'ADDITIONAL', mov, 'video/quicktime');
    expect(res.status).toBe(201);
    const e = res.body.data.evidence;
    expect(e).toMatchObject({ mediaType: 'VIDEO', contentType: 'video/quicktime', durationSec: 3 });
    const doc = (await Evidence.findById(e.id).lean())!;
    expect(doc.capturedAt).toBeInstanceOf(Date);
    expect(doc.captureLocation!.coordinates[0]).toBeCloseTo(site.lng, 3);
    expect(doc.captureLocation!.coordinates[1]).toBeCloseTo(site.lat, 3);
    expect(imageCalls).toBe(1); // one video check at upload, reused for the stored result

    await settle();
    const after = (await Evidence.findById(e.id).lean())!;
    expect(after.redaction).toMatchObject({ state: 'DONE', contentType: 'video/mp4', faces: 1 });
    expect(after.redaction!.storageKey).toMatch(/\.shared\.mp4$/);
    expect(privacyCalls).toBe(2); // ~every 2 s, at least 2 samples
    expect(imageCalls).toBe(1);

    const shared = await request(app).get(`/api/v1/evidence/${e.id}/content`).set('Authorization', `Bearer ${mgr.token}`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (d: Buffer) => chunks.push(d));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(shared.status).toBe(200);
    expect(shared.headers['content-type']).toBe('video/mp4');
    const probe = await videoTools.probe(shared.body as Buffer);
    expect(probe.location).toBeUndefined();
    expect(probe.capturedAt).toBeUndefined();
    expect((await call('get', `/complaints/${c.publicId}/evidence`, mgr)).body.data[0].authenticity).toBe('NO_SUSPICIOUS_SIGNALS_DETECTED');
  });

  it('refuses videos that are too long, unreadable, or look AI-generated, storing nothing', async () => {
    const { c } = await inProgress();
    const long = await upload(c.publicId, alice, 'ADDITIONAL', await clip({ seconds: 12 }), 'video/mp4');
    expect(long.status).toBe(413);
    expect(long.body.error.message).toMatch(/10 seconds/);
    const junk = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(4000, 7)]);
    expect((await upload(c.publicId, alice, 'ADDITIONAL', junk, 'video/mp4')).status).toBe(415);

    build({ video: videoTools, image: { ...clean, visualInconsistency: 'STRONG', inconsistencyNotes: 'Objects morph.' }, privacy: { regions: [] } });
    const fake = await upload(c.publicId, alice, 'ADDITIONAL', await clip(), 'video/mp4');
    expect(fake.status).toBe(422);
    expect(fake.body.error.code).toBe('MEDIA_REJECTED');
    expect(await Evidence.countDocuments()).toBe(0);
  });

  it('a worker can resolve with a video; the before/after comparison uses video frames', async () => {
    const { c, wo } = await inProgress();
    expect((await upload(c.publicId, alice, 'ADDITIONAL', await clip(), 'video/mp4')).status).toBe(201);
    const ev = await upload(c.publicId, worker, 'RESOLUTION', await clip(), 'video/mp4');
    expect(ev.status).toBe(201);
    await settle();
    expect(comparisonInputs).toHaveLength(1);
    expect(comparisonInputs[0]!.after.mediaType).toBe('image/jpeg');
    expect(comparisonInputs[0]!.before).toHaveLength(1);
    const res = await call('post', `/work-orders/${wo}/resolution`, worker, { completionNotes: 'Cleared the garbage and washed the area.', evidenceIds: [ev.body.data.evidence.id] });
    expect(res.status).toBe(200);
    expect(res.body.data.assessment, JSON.stringify(res.body.data.assessment)).toMatchObject({ outcome: 'SUFFICIENT' });
  });

  it('pre-checks a video before the complaint exists', async () => {
    const res = await request(app).post('/api/v1/evidence/check').set('Authorization', `Bearer ${alice.token}`).set('Content-Type', 'video/mp4').send(await clip());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ allowed: true, message: null });
  });
});

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

  it('uncertain evidence goes to verification-required, even with auto-approval on (gate set to flag)', async () => {
    build({ image: { ...clean, visualInconsistency: 'STRONG', inconsistencyNotes: 'Cloned patch.' }, policy: { autoApprove: true }, mediaGate: 'flag' });
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
    const ev = (await upload(c.publicId, w1, 'RESOLUTION', jpegWithExif(site))).body.data.evidence.id;
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

// ---- verifier: GPS, capture time, before/after comparison -------------------------------------------
describe('verifier checks (GPS, capture time, before/after comparison)', () => {
  beforeEach(async () => {
    build();
    await seed();
  });
  const exifTime = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ').replace(/-/g, ':');

  it('a photo with GPS at the spot, taken after assignment, showing the fix, is SUFFICIENT', async () => {
    const { c, wo } = await inProgress();
    const res = await submitWithEvidence(c.publicId, wo, true, jpegWithExif({ ...site, takenAt: exifTime(new Date()), offset: '+00:00' }));
    expect(res.body.data.assessment.outcome).toBe('SUFFICIENT');
  });

  it('flags a photo taken far from the reported place, with the distance', async () => {
    const { c, wo } = await inProgress();
    const res = await submitWithEvidence(c.publicId, wo, true, jpegWithExif({ lat: site.lat + 0.001, lng: site.lng }));
    expect(res.body.data.assessment).toMatchObject({ outcome: 'UNCERTAIN', reasons: [expect.stringMatching(/about 111 m from the reported location \(limit 50 m\)/)] });
    expect(await statuses(c.id, wo)).toEqual(['VERIFICATION_REQUIRED', 'VERIFICATION_REQUIRED']);
  });

  it('a photo without GPS cannot confirm the location', async () => {
    const { c, wo } = await inProgress();
    const res = await submitWithEvidence(c.publicId, wo, true, jpeg());
    expect(res.body.data.assessment).toMatchObject({ outcome: 'UNCERTAIN', reasons: ['The location of a resolution photo could not be confirmed (no GPS data in the file).'] });
  });

  it('flags a photo whose capture time is well before the assignment', async () => {
    const { c, wo } = await inProgress();
    const res = await submitWithEvidence(c.publicId, wo, true, jpegWithExif({ ...site, takenAt: '2024:01:01 10:00:00' }));
    expect(res.body.data.assessment).toMatchObject({ outcome: 'UNCERTAIN', reasons: ['A resolution photo appears to have been taken before the work was assigned.'] });
  });

  it('before/after doubts make it UNCERTAIN, and auto-approval never overrides them', async () => {
    const cases: [ResolutionComparison | AiProviderError, string][] = [
      [{ ...fixed, issueAppearsFixed: 'NO' }, 'The before/after comparison suggests the problem is still visible.'],
      [{ ...fixed, issueAppearsFixed: 'UNCLEAR' }, 'The before/after comparison could not confirm the fix.'],
      [{ ...fixed, sameLocation: 'NO' }, 'The after photo may not show the same place as the report.'],
      [{ ...fixed, matchesCategory: 'NO' }, 'The work shown does not seem to match the reported problem.'],
      [new AiProviderError('UNAVAILABLE', 'down'), 'The before/after photo comparison could not be run for every file.'],
    ];
    for (const [comparison, reason] of cases) {
      build({ comparison, policy: { autoApprove: true } });
      await seed();
      const { c, wo } = await inProgress();
      const res = await submitWithEvidence(c.publicId, wo);
      expect(res.body.data.assessment).toMatchObject({ outcome: 'UNCERTAIN', reasons: [reason] });
      expect(await statuses(c.id, wo)).toEqual(['VERIFICATION_REQUIRED', 'VERIFICATION_REQUIRED']);
    }
  });

  it("compares against the citizen's own photos and records the result for staff only", async () => {
    let seen: ResolutionComparisonInput | undefined;
    build({ comparison: (input) => ((seen = input), fixed) });
    await seed();
    const { c, wo } = await inProgress();
    expect((await upload(c.publicId, alice, 'ADDITIONAL', jpegWithExif(site))).status).toBe(201);
    await settle();
    await submitWithEvidence(c.publicId, wo);
    expect(seen).toMatchObject({ category: 'roads', complaintTitle: 'Deep pothole near the bus stop', after: { mediaType: 'image/jpeg' } });
    expect(seen!.before).toHaveLength(1);

    const media = (await call('get', `/complaints/${c.publicId}/analysis`, mgr)).body.data.analysis.media;
    const resolutionEntry = media.find((m: { purpose: string }) => m.purpose === 'RESOLUTION');
    expect(resolutionEntry.comparison).toEqual({ status: 'DONE', sameLocation: 'YES', issueAppearsFixed: 'YES', matchesCategory: 'YES', notes: fixed.notes, beforePhotos: 1 });
    expect(media.find((m: { purpose: string }) => m.purpose === 'ADDITIONAL').comparison).toBeUndefined(); // citizen photos aren't compared
    expect((await call('get', `/complaints/${c.publicId}/analysis`, alice)).status).toBe(403);
  });

  it('keeps a comparison request under the gateway size limit by sending fewer before photos', async () => {
    let seen: ResolutionComparisonInput | undefined;
    build({ comparison: (input) => ((seen = input), fixed) });
    await seed();
    const { c, wo } = await inProgress();
    const big = () => Buffer.concat([jpegWithExif(site), Buffer.alloc(4 * 1024 * 1024, 0x33)]); // ~4 MB each
    for (let i = 0; i < 2; i++) expect((await upload(c.publicId, alice, 'ADDITIONAL', big())).status).toBe(201);
    await settle();
    await submitWithEvidence(c.publicId, wo);
    expect(seen!.before).toHaveLength(1); // 4 MB + small after-photo fits; a second 4 MB photo would not
  });

  it('stores photo GPS for checks but never shows it in evidence listings', async () => {
    const { c } = await inProgress();
    const res = await upload(c.publicId, alice, 'ADDITIONAL', jpegWithExif({ lat: 13.123456, lng: 74.654321, takenAt: '2026:10:20 09:15:00', offset: '+05:30' }));
    const stored = await Evidence.findById(res.body.data.evidence.id).lean();
    expect(stored!.captureLocation!.coordinates[1]).toBeCloseTo(13.123456, 5);
    expect(stored!.capturedAt!.toISOString()).toBe('2026-10-20T03:45:00.000Z');
    for (const who of [alice, mgr]) {
      const listing = JSON.stringify((await call('get', `/complaints/${c.publicId}/evidence`, who)).body);
      expect(listing).not.toMatch(/13\.1234|74\.6543|captureLocation|capturedAt/);
    }
  });

  it('videos and oversized photos are recorded as not comparable (so verification stays with a human)', async () => {
    const { c, wo } = await inProgress();
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(400, 7)]);
    const ev = await upload(c.publicId, worker, 'RESOLUTION', mp4, 'video/mp4');
    expect(ev.status).toBe(201);
    await settle();
    expect(await AIAnalysis.findOne({ evidence: ev.body.data.evidence.id, analysisType: 'RESOLUTION_COMPARISON' }).lean()).toMatchObject({ status: 'FAILED', errorCode: 'NOT_COMPARABLE' });
    const res = await call('post', `/work-orders/${wo}/resolution`, worker, { completionNotes: 'Video of the filled pothole.', evidenceIds: [ev.body.data.evidence.id] });
    expect(res.body.data.assessment.outcome).toBe('UNCERTAIN');
  });
});
