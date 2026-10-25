// Vercel + Cloudinary deployment pieces: config, the Cloudinary adapter (fake SDK and fetch, no live
// calls), direct-upload tokens, the staged-upload routes, signed links and the maintenance endpoint.
import mongoose from 'mongoose';
import request from 'supertest';
import { v2 as sdk } from 'cloudinary';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import { ConfigError, loadConfig } from '../src/config/env.js';
import { AIAnalysis, AuditLog, AuthSession, Complaint, Counter, Evidence, User } from '../src/models/index.js';
import { createAnalysisService } from '../src/services/analysis/index.js';
import { createCloudinaryStorage, type CloudinaryClient, type DirectUploads, type StagedFile } from '../src/storage/cloudinary.js';
import { createMemoryStorage, type ObjectStorage } from '../src/storage/index.js';
import { createLogger } from '../src/utils/logger.js';
import { AppError } from '../src/utils/errors.js';
import { disabledProvider } from '../src/ai/types.js';
import { testAuthConfig } from './helpers.js';
import { testMongo } from './mongo.js';

const silent = createLogger({ logLevel: 'silent', nodeEnv: 'test' });
const base = { MONGODB_URI: 'mongodb://127.0.0.1:27017/civicfix', JWT_SECRET: 'k9f2c1a7e5b8d4f60a3c2e1b7d9f0a4c6x' };
const CRON = 'Zq8vN3xK7pL2mR9tW4yB6cF1hJ5dG0sAq8vN3x';

function issuesFor(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
    return [];
  } catch (err) {
    if (err instanceof ConfigError) return err.issues;
    throw err;
  }
}

describe('config', () => {
  it('reads CLOUDINARY_URL or the separate variables', () => {
    const fromUrl = loadConfig({ ...base, STORAGE_PROVIDER: 'cloudinary', CLOUDINARY_URL: 'cloudinary://123456789012345:AbCdEfGhIjKlMnOp@my-cloud' });
    expect(fromUrl.storage.cloudinary).toEqual({ cloudName: 'my-cloud', apiKey: '123456789012345', apiSecret: 'AbCdEfGhIjKlMnOp', folder: 'civicfix' });
    const separate = loadConfig({ ...base, STORAGE_PROVIDER: 'cloudinary', CLOUDINARY_CLOUD_NAME: 'c1', CLOUDINARY_API_KEY: '1234567', CLOUDINARY_API_SECRET: 'secretvalue123', CLOUDINARY_FOLDER: 'civicfix-staging' });
    expect(separate.storage.cloudinary?.folder).toBe('civicfix-staging');
  });

  it('lists missing Cloudinary settings and rejects a malformed URL', () => {
    expect(issuesFor({ ...base, STORAGE_PROVIDER: 'cloudinary' })).toHaveLength(3);
    expect(issuesFor({ ...base, STORAGE_PROVIDER: 'cloudinary', CLOUDINARY_URL: 'https://res.cloudinary.com/x' }).join('\n')).toMatch(/CLOUDINARY_URL must look like/);
    expect(issuesFor({ ...base, STORAGE_PROVIDER: 'cloudinary', CLOUDINARY_URL: 'cloudinary://1234567:secretvalue123@c', CLOUDINARY_FOLDER: '../x' })).toHaveLength(1);
  });

  it('validates CRON_SECRET', () => {
    expect(loadConfig({ ...base, CRON_SECRET: CRON }).cronSecret).toBe(CRON);
    expect(issuesFor({ ...base, CRON_SECRET: 'short' })).toEqual(['CRON_SECRET must be at least 32 random characters']);
  });
});

describe('Cloudinary storage', () => {
  const auth = { cloudName: 'demo-cloud', apiKey: '1234567', apiSecret: 'test-secret-value', folder: 'civicfix', tokenSecret: testAuthConfig.jwtSecret };

  function fake(opts: { existing?: boolean; download?: (url: URL) => Response; staged?: { public_id: string; created_at: string }[] } = {}) {
    const calls: { op: string; args: unknown[] }[] = [];
    const client: CloudinaryClient = {
      async upload(bytes, options) {
        calls.push({ op: 'upload', args: [Buffer.from(bytes), options] });
        return { public_id: String(options.public_id), existing: opts.existing };
      },
      async destroy(publicId, options) {
        calls.push({ op: 'destroy', args: [publicId, options] });
        return { result: 'ok' };
      },
      async list(options) {
        calls.push({ op: 'list', args: [options] });
        return { resources: options.resource_type === 'image' ? (opts.staged ?? []) : [] };
      },
      async deleteMany(ids, options) {
        calls.push({ op: 'deleteMany', args: [ids, options] });
      },
    };
    const fetched: URL[] = [];
    const fetchFn = (async (u: string) => {
      const url = new URL(u);
      fetched.push(url);
      return opts.download ? opts.download(url) : new Response(new Uint8Array([7, 7]), { status: 200 });
    }) as unknown as typeof fetch;
    return { storage: createCloudinaryStorage({ ...auth, client, fetch: fetchFn }), calls, fetched };
  }

  it('stores files as authenticated (private) assets under the folder, never overwriting', async () => {
    const { storage, calls } = fake();
    await storage.put('evidence/c1/e1-u1.jpg', new Uint8Array([1, 2]), 'image/jpeg');
    await storage.put('evidence/c1/e1-u1.shared.mp4', new Uint8Array([3]), 'video/mp4');
    expect(calls[0]!.args[1]).toMatchObject({ public_id: 'civicfix/evidence/c1/e1-u1', resource_type: 'image', type: 'authenticated', overwrite: false });
    expect(calls[1]!.args[1]).toMatchObject({ public_id: 'civicfix/evidence/c1/e1-u1_shared', resource_type: 'video', type: 'authenticated' });
    const existing = fake({ existing: true });
    await expect(existing.storage.put('evidence/c1/x.jpg', new Uint8Array([1]), 'image/jpeg')).rejects.toThrow('already exists');
  });

  it('reads files back through a signed, expiring download URL and maps 404', async () => {
    const { storage, fetched } = fake();
    expect([...(await storage.get('evidence/c1/e1-u1.png'))]).toEqual([7, 7]);
    const url = fetched[0]!;
    expect(url.origin + url.pathname).toBe('https://api.cloudinary.com/v1_1/demo-cloud/image/download');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ public_id: 'civicfix/evidence/c1/e1-u1', format: 'png', type: 'authenticated', api_key: '1234567' });
    expect(Number(url.searchParams.get('expires_at'))).toBeGreaterThan(Date.now() / 1000);
    expect(url.searchParams.get('signature')).toMatch(/^[a-f0-9]{40}$/);
    expect(url.search).not.toContain('test-secret-value');
    const gone = fake({ download: () => new Response('', { status: 404 }) });
    await expect(gone.storage.get('evidence/c1/e1.jpg')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const broken = fake({ download: () => new Response('details', { status: 500 }) });
    await expect(broken.storage.get('evidence/c1/e1.jpg')).rejects.toThrow(/^Cloudinary download failed with HTTP 500$/);
  });

  it('deletes, signs links, and rejects unsafe or unknown keys', async () => {
    const { storage, calls } = fake();
    await storage.delete('evidence/c1/e1.mov');
    expect(calls[0]).toMatchObject({ op: 'destroy', args: ['civicfix/evidence/c1/e1', { resource_type: 'video', type: 'authenticated', invalidate: true }] });
    expect(storage.signedUrl!('evidence/c1/e1.jpg', 900)).toMatch(/^https:\/\/api\.cloudinary\.com\/v1_1\/demo-cloud\/image\/download\?/);
    await expect(storage.get('../etc/passwd.jpg')).rejects.toThrow('Unsafe storage key');
    await expect(storage.get('evidence/c1/e1.exe')).rejects.toThrow('Unsupported storage key extension');
  });

  describe('direct uploads', () => {
    it('signs a staging upload with the documented Cloudinary signature', () => {
      const { storage } = fake();
      const t = storage.directUploads.sign('user-1', 'video');
      expect(t.uploadUrl).toBe('https://api.cloudinary.com/v1_1/demo-cloud/video/upload');
      expect(t.fields).toMatchObject({ type: 'authenticated', overwrite: 'false', allowed_formats: 'mp4,mov,webm', api_key: '1234567' });
      expect(t.fields.public_id).toMatch(/^civicfix\/staging\/[0-9a-f-]{36}$/);
      const { api_key: _k, signature, ...signed } = t.fields;
      expect(signature).toBe(sdk.utils.api_sign_request(signed, 'test-secret-value'));
      expect(JSON.stringify(t)).not.toContain('test-secret-value');
    });

    it("fetches a staged file only for the user it was signed for, with an allowed format", async () => {
      const { storage, fetched } = fake();
      const du = storage.directUploads;
      const t = du.sign('user-1', 'image');
      const staged = await du.fetchStaged('user-1', t.token, 'jpg');
      expect(staged).toMatchObject({ declaredType: 'image/jpeg', publicId: t.fields.public_id, resourceType: 'image' });
      expect(fetched[0]!.searchParams.get('public_id')).toBe(t.fields.public_id);
      await expect(du.fetchStaged('user-2', t.token, 'jpg')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      await expect(du.fetchStaged('user-1', t.token, 'mp4')).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
      const [body, sig] = t.token.split('.');
      const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), pid: 'civicfix/evidence/c1/someone-else' })).toString('base64url');
      await expect(du.fetchStaged('user-1', `${forged}.${sig}`, 'jpg')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      await expect(du.fetchStaged('user-1', 'garbage-token-value', 'jpg')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('only discards staging files and cleans up old ones in batches', async () => {
      const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
      const fresh = new Date().toISOString();
      const staged = [...Array.from({ length: 150 }, (_, i) => ({ public_id: `civicfix/staging/old-${i}`, created_at: old })), { public_id: 'civicfix/staging/new', created_at: fresh }];
      const { storage, calls } = fake({ staged });
      await storage.directUploads.discardStaged({ publicId: 'civicfix/evidence/c1/keep', resourceType: 'image' });
      expect(calls).toHaveLength(0);
      expect(await storage.directUploads.cleanupStaging(86_400_000)).toBe(150);
      const deletes = calls.filter((c) => c.op === 'deleteMany');
      expect(deletes.map((d) => (d.args[0] as string[]).length)).toEqual([100, 50]);
      expect(calls.find((c) => c.op === 'list')!.args[0]).toMatchObject({ prefix: 'civicfix/staging/', type: 'authenticated' });
    });
  });
});

// ------------------------------------------------------------------------------------- routes

// AuditLog is append-only, so it is never cleared; assertions filter by target.
const MODELS = [User, AuthSession, Complaint, Counter, Evidence, AIAnalysis] as unknown as (typeof User)[];
const many = { windowMs: 60_000, limit: 10_000 };
const PASSWORD = 'correct horse battery';
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from(`JFIF${Math.random()}`), Buffer.alloc(300, 0x22)]);

let mongo: Awaited<ReturnType<typeof testMongo>>;
beforeAll(async () => {
  mongo = await testMongo();
  await mongoose.connect(mongo.getUri(), { dbName: 'civicfix-deployment-test' });
  await Promise.all(MODELS.map((m) => m.syncIndexes()));
});
afterAll(async () => {
  await mongoose.disconnect();
});

/** In-memory stand-in for Cloudinary staging: tokens map to bytes. */
function fakeDirectUploads() {
  const files = new Map<string, { bytes: Buffer; uid: string }>();
  const discarded: string[] = [];
  const du: DirectUploads = {
    sign(userId, kind) {
      const token = `tok-${files.size + 1}-${kind}-${Math.random()}`;
      files.set(token, { bytes: Buffer.alloc(0), uid: userId });
      return { uploadUrl: 'https://api.cloudinary.com/v1_1/demo/image/upload', fields: { public_id: `civicfix/staging/${token}` }, token, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
    },
    async fetchStaged(userId, token, format) {
      const f = files.get(token);
      if (!f || f.uid !== userId) throw new AppError('VALIDATION_ERROR', 'The upload reference is invalid or has expired. Upload the file again.');
      return { bytes: f.bytes, declaredType: format === 'jpg' ? 'image/jpeg' : 'video/mp4', publicId: `civicfix/staging/${token}`, resourceType: 'image' } as StagedFile;
    },
    async discardStaged(file) {
      discarded.push(file.publicId);
    },
    async cleanupStaging() {
      return 0;
    },
  };
  /** Simulates the browser's upload to Cloudinary. */
  const browserUpload = (token: string, bytes: Buffer) => {
    files.get(token)!.bytes = bytes;
  };
  return { du, browserUpload, discarded };
}

let app: ReturnType<typeof createApp>;
let staging: ReturnType<typeof fakeDirectUploads>;
let maintenanceRuns = 0;
function build(storage: ObjectStorage = createMemoryStorage()) {
  staging = fakeDirectUploads();
  const analysis = createAnalysisService({ provider: disabledProvider, logger: silent, maxAttempts: 1, autoRun: false, storage });
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
    directUploads: staging.du,
    maintenance: {
      secret: CRON,
      run: async () => {
        maintenanceRuns++;
        return { slaBreaches: 0 };
      },
    },
  });
}

type Actor = { id: string; token: string };
async function actor(email: string): Promise<Actor> {
  const u = await User.create({ name: email.split('@')[0], email, platformRole: 'CITIZEN', passwordHash: await hashPassword(PASSWORD) });
  const res = await request(app).post('/api/v1/auth/login').set('Content-Type', 'application/json').send(JSON.stringify({ email, password: PASSWORD }));
  return { id: String(u._id), token: res.body.data.accessToken };
}
const call = (method: 'get' | 'post', path: string, who?: Actor, body?: unknown) => {
  let r = request(app)[method](`/api/v1${path}`);
  if (who) r = r.set('Authorization', `Bearer ${who.token}`);
  if (body !== undefined) r = r.set('Content-Type', 'application/json').send(JSON.stringify(body));
  return r;
};

describe('direct-upload routes', () => {
  let alice: Actor, bob: Actor, complaintId: string;
  beforeEach(async () => {
    build();
    await Promise.all(MODELS.map((m) => m.deleteMany({})));
    alice = await actor('alice@t.local');
    bob = await actor('bob@t.local');
    const c = await call('post', '/complaints', alice, { title: 'Deep pothole near the bus stop', description: 'Large pothole on the service road near the stop.', location: { lat: 13.0, lng: 74.79 }, selectedCategory: 'roads' });
    complaintId = c.body.data.complaint.publicId;
  });

  it('advertises direct upload in the capture policy', async () => {
    expect((await call('get', '/evidence/capture-policy', alice)).body.data.directUpload).toBe(true);
  });

  it('signs, then attaches a staged file after the usual checks, and removes the staged copy', async () => {
    const ticket = (await call('post', '/evidence/uploads', alice, { kind: 'image' })).body.data;
    expect(ticket.token).toBeTruthy();
    staging.browserUpload(ticket.token, jpeg());
    const res = await call('post', `/complaints/${complaintId}/evidence/from-upload`, alice, { token: ticket.token, format: 'jpg', purpose: 'COMPLAINT_REPORT' });
    expect(res.status).toBe(201);
    expect(res.body.data.evidence.contentType).toBe('image/jpeg');
    expect(await Evidence.countDocuments()).toBe(1);
    expect(staging.discarded).toEqual([`civicfix/staging/${ticket.token}`]);
  });

  it('refuses a file whose bytes are not what the format claims, and discards it', async () => {
    const ticket = (await call('post', '/evidence/uploads', alice, { kind: 'image' })).body.data;
    staging.browserUpload(ticket.token, Buffer.from('not an image at all, just text'));
    const res = await call('post', `/complaints/${complaintId}/evidence/from-upload`, alice, { token: ticket.token, format: 'jpg', purpose: 'COMPLAINT_REPORT' });
    expect(res.status).toBe(415);
    expect(await Evidence.countDocuments()).toBe(0);
    expect(staging.discarded).toHaveLength(1);
  });

  it("won't attach another user's staged file", async () => {
    const ticket = (await call('post', '/evidence/uploads', alice, { kind: 'image' })).body.data;
    staging.browserUpload(ticket.token, jpeg());
    const res = await call('post', `/complaints/${complaintId}/evidence/from-upload`, bob, { token: ticket.token, format: 'jpg', purpose: 'COMPLAINT_REPORT' });
    expect(res.status).toBe(400);
    expect(await Evidence.countDocuments()).toBe(0);
  });

  it('pre-checks a staged file without storing it', async () => {
    const ticket = (await call('post', '/evidence/uploads', alice, { kind: 'image' })).body.data;
    staging.browserUpload(ticket.token, jpeg());
    const res = await call('post', '/evidence/check-upload', alice, { token: ticket.token, format: 'jpg' });
    expect(res.status).toBe(200);
    expect(res.body.data.allowed).toBe(true);
    expect(staging.discarded).toEqual([]); // kept for the upload that follows
    expect(await Evidence.countDocuments()).toBe(0);
  });

  it('validates request bodies', async () => {
    expect((await call('post', '/evidence/uploads', alice, { kind: 'pdf' })).status).toBe(400);
    expect((await call('post', '/evidence/check-upload', alice, { token: 'x', format: 'jpg' })).status).toBe(400);
    expect((await call('post', '/evidence/uploads', undefined, { kind: 'image' })).status).toBe(401);
  });

  it('returns link: null when the storage cannot sign links', async () => {
    const ticket = (await call('post', '/evidence/uploads', alice, { kind: 'image' })).body.data;
    staging.browserUpload(ticket.token, jpeg());
    const ev = (await call('post', `/complaints/${complaintId}/evidence/from-upload`, alice, { token: ticket.token, format: 'jpg', purpose: 'COMPLAINT_REPORT' })).body.data.evidence;
    const res = await call('get', `/evidence/${ev.id}/link`, alice);
    expect(res.status).toBe(200);
    expect(res.body.data.link).toBeNull();
  });

  it('returns a signed link after the same access check, and refuses strangers', async () => {
    const mem = createMemoryStorage();
    build({ ...mem, signedUrl: (key: string, ttl: number) => `https://files.example/${key}?ttl=${ttl}` });
    alice = await actor('alice2@t.local');
    bob = await actor('bob2@t.local');
    const c = await call('post', '/complaints', alice, { title: 'Broken streetlight on main road', description: 'The light has been off for a week now.', location: { lat: 13.0, lng: 74.79 }, selectedCategory: 'roads' });
    const ticket = (await call('post', '/evidence/uploads', alice, { kind: 'image' })).body.data;
    staging.browserUpload(ticket.token, jpeg());
    const ev = (await call('post', `/complaints/${c.body.data.complaint.publicId}/evidence/from-upload`, alice, { token: ticket.token, format: 'jpg', purpose: 'COMPLAINT_REPORT' })).body.data.evidence;
    const mine = await call('get', `/evidence/${ev.id}/link`, alice);
    expect(mine.body.data.link.url).toMatch(/^https:\/\/files\.example\/evidence\/.+\.jpg\?ttl=900$/);
    expect(mine.headers['cache-control']).toBe('private, no-store');
    expect((await call('get', `/evidence/${ev.id}/link`, bob)).status).toBe(404);
    expect(await AuditLog.countDocuments({ action: 'evidence.downloaded', targetId: ev.id })).toBe(1);
  });
});

describe('maintenance endpoint', () => {
  beforeEach(() => build());

  it('requires the cron bearer secret', async () => {
    maintenanceRuns = 0;
    expect((await request(app).get('/api/v1/internal/maintenance')).status).toBe(401);
    expect((await request(app).get('/api/v1/internal/maintenance').set('Authorization', 'Bearer wrong')).status).toBe(401);
    expect(maintenanceRuns).toBe(0);
    const ok = await request(app).get('/api/v1/internal/maintenance').set('Authorization', `Bearer ${CRON}`);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({ slaBreaches: 0 });
    expect(maintenanceRuns).toBe(1);
  });
});

describe('runUntilQuiet', () => {
  it('processes queued jobs, shares one loop, and respects the deadline', async () => {
    await Promise.all(MODELS.map((m) => m.deleteMany({})));
    const analysis = createAnalysisService({ provider: disabledProvider, logger: silent, maxAttempts: 1, autoRun: false, storage: createMemoryStorage() });
    const c = await Complaint.create({ publicId: 'CF-2026-00999', citizen: new mongoose.Types.ObjectId(), title: 'Deep pothole near the bus stop', description: 'Large pothole on the service road.', location: { type: 'Point', coordinates: [74.79, 13] } });
    await analysis.runner.enqueue(c._id, ['DUPLICATE_CANDIDATES'], 'COMPLAINT_CREATED');
    // A deadline already inside the safety margin does nothing.
    await analysis.runner.runUntilQuiet(Date.now() + 1_000);
    expect(await AIAnalysis.countDocuments({ status: 'PENDING' })).toBe(1);
    const a = analysis.runner.runUntilQuiet(Date.now() + 60_000);
    const b = analysis.runner.runUntilQuiet(Date.now() + 60_000);
    expect(a).toBe(b);
    await a;
    expect(await AIAnalysis.countDocuments({ status: { $in: ['PENDING', 'RUNNING'] } })).toBe(0);
  });
});
