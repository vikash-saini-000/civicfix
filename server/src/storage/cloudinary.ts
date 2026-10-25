// Cloudinary storage for evidence files.
//
// Privacy: every file is uploaded with type "authenticated", so Cloudinary never serves it publicly.
// The API reads files back with signed download URLs, and browsers only get short-lived signed links
// after the API's own access check.
//
// Direct uploads: Vercel functions accept at most 4.5 MB per request, so browsers upload files straight
// to Cloudinary into a "staging" folder using a signature from the API. The API then downloads the
// staged file, runs the usual checks (type, size, camera stamp, AI/edit screening) and stores it
// under its final key. Staged files are deleted after use; the daily maintenance job removes leftovers.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { v2 as sdk } from 'cloudinary';
import { AppError } from '../utils/errors.js';
import { assertSafeKey, type ObjectStorage } from './index.js';

export interface CloudinaryOptions {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  /** Top-level folder, e.g. "civicfix" or "civicfix-staging". */
  folder: string;
  /** Signs direct-upload tokens (the API's JWT secret is fine; a separate key is derived from it). */
  tokenSecret: string;
  timeoutMs?: number;
  /** For tests. */
  fetch?: typeof fetch;
  /** For tests: replaces the SDK upload/destroy/list calls. */
  client?: CloudinaryClient;
}

/** The few SDK calls used, so tests can replace them. */
export interface CloudinaryClient {
  upload(bytes: Uint8Array, options: Record<string, unknown>): Promise<{ existing?: boolean; public_id: string }>;
  destroy(publicId: string, options: Record<string, unknown>): Promise<{ result: string }>;
  list(options: Record<string, unknown>): Promise<{ resources: { public_id: string; created_at: string }[]; next_cursor?: string }>;
  deleteMany(publicIds: string[], options: Record<string, unknown>): Promise<unknown>;
}

export type ResourceType = 'image' | 'video';

const FORMATS: Record<ResourceType, Record<string, string>> = {
  image: { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' },
  // WebM (browser recordings) is converted to MP4 by the API before it is stored for good.
  video: { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' },
};

/** How long a browser may take between getting an upload signature and attaching the file. */
const UPLOAD_TOKEN_TTL_MS = 2 * 60 * 60_000;

export interface DirectUploadTicket {
  /** POST multipart/form-data here with `file` plus every entry of `fields`. */
  uploadUrl: string;
  fields: Record<string, string>;
  /** Send back with the Cloudinary response's `format` to use the staged file. */
  token: string;
  expiresAt: string;
}

export interface StagedFile {
  bytes: Buffer;
  declaredType: string;
  publicId: string;
  resourceType: ResourceType;
}

export interface DirectUploads {
  sign(userId: string, kind: ResourceType): DirectUploadTicket;
  /** Downloads a staged upload after checking the token belongs to this user. */
  fetchStaged(userId: string, token: string, format: string): Promise<StagedFile>;
  discardStaged(file: Pick<StagedFile, 'publicId' | 'resourceType'>): Promise<void>;
  /** Deletes staged files older than `olderThanMs`. Returns how many were removed. */
  cleanupStaging(olderThanMs: number): Promise<number>;
}

const sdkClient = (auth: Record<string, string>): CloudinaryClient => ({
  upload: (bytes, options) =>
    new Promise((resolve, reject) => {
      const stream = sdk.uploader.upload_stream({ ...auth, ...options }, (err, result) => (err || !result ? reject(err ?? new Error('empty upload result')) : resolve(result as never)));
      Readable.from(Buffer.from(bytes)).pipe(stream);
    }),
  destroy: (publicId, options) => sdk.uploader.destroy(publicId, { ...auth, ...options }) as Promise<{ result: string }>,
  list: (options) => sdk.api.resources({ ...auth, ...options }) as Promise<never>,
  deleteMany: (publicIds, options) => sdk.api.delete_resources(publicIds, { ...auth, ...options }),
});

export function createCloudinaryStorage(opts: CloudinaryOptions): ObjectStorage & { directUploads: DirectUploads } {
  const auth = { cloud_name: opts.cloudName, api_key: opts.apiKey, api_secret: opts.apiSecret };
  const client = opts.client ?? sdkClient(auth);
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const tokenKey = createHmac('sha256', opts.tokenSecret).update('civicfix:cloudinary-upload:v1').digest();
  const stagingPrefix = `${opts.folder}/staging/`;

  /** "evidence/c/abc.shared.jpg" -> public_id "<folder>/evidence/c/abc_shared", format "jpg". */
  function locate(key: string): { publicId: string; format: string; resourceType: ResourceType } {
    assertSafeKey(key);
    const dot = key.lastIndexOf('.');
    const format = dot > 0 ? key.slice(dot + 1) : '';
    const resourceType = (Object.keys(FORMATS) as ResourceType[]).find((t) => format in FORMATS[t] && format !== 'webm');
    if (!resourceType) throw new Error(`Unsupported storage key extension: ${format || '(none)'}`);
    return { publicId: `${opts.folder}/${key.slice(0, dot).replace(/\./g, '_')}`, format, resourceType };
  }

  /** Signed, expiring URL for the original file (Cloudinary download API). */
  function downloadUrl(publicId: string, format: string, resourceType: ResourceType, ttlSeconds: number) {
    return sdk.utils.private_download_url(publicId, format, {
      ...auth,
      resource_type: resourceType,
      type: 'authenticated',
      expires_at: Math.floor(Date.now() / 1000) + ttlSeconds,
    });
  }

  async function download(publicId: string, format: string, resourceType: ResourceType): Promise<Buffer> {
    let res: Response;
    try {
      res = await doFetch(downloadUrl(publicId, format, resourceType, 300), { signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new AppError('SERVICE_UNAVAILABLE', 'File storage could not be reached. Try again shortly.');
    }
    if (res.status === 404) {
      await res.body?.cancel();
      throw new AppError('NOT_FOUND', 'The file is no longer available.');
    }
    if (!res.ok) {
      await res.body?.cancel();
      // Never include the URL (it carries a signature) or the response body.
      throw new Error(`Cloudinary download failed with HTTP ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  const b64 = (buf: Buffer) => buf.toString('base64url');
  const signToken = (payload: object) => {
    const body = b64(Buffer.from(JSON.stringify(payload)));
    return `${body}.${b64(createHmac('sha256', tokenKey).update(body).digest())}`;
  };
  function readToken(token: string): { pid: string; rt: ResourceType; uid: string; exp: number } | null {
    const [body, sig] = token.split('.');
    if (!body || !sig || token.length > 1000) return null;
    const expected = createHmac('sha256', tokenKey).update(body).digest();
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
  }

  const directUploads: DirectUploads = {
    sign(userId, kind) {
      const publicId = `${stagingPrefix}${randomUUID()}`;
      const params: Record<string, string | number> = {
        public_id: publicId,
        timestamp: Math.floor(Date.now() / 1000),
        type: 'authenticated',
        overwrite: 'false',
        allowed_formats: Object.keys(FORMATS[kind]).join(','),
      };
      const signature = sdk.utils.api_sign_request(params, opts.apiSecret);
      const exp = Date.now() + UPLOAD_TOKEN_TTL_MS;
      return {
        uploadUrl: `https://api.cloudinary.com/v1_1/${opts.cloudName}/${kind}/upload`,
        fields: { ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), api_key: opts.apiKey, signature },
        token: signToken({ pid: publicId, rt: kind, uid: userId, exp }),
        expiresAt: new Date(exp).toISOString(),
      };
    },

    async fetchStaged(userId, token, format) {
      const t = readToken(token);
      // Same message for every failure, so tokens can't be probed.
      if (!t || t.uid !== userId || t.exp < Date.now() || !t.pid.startsWith(stagingPrefix) || !(t.rt in FORMATS)) {
        throw new AppError('VALIDATION_ERROR', 'The upload reference is invalid or has expired. Upload the file again.');
      }
      const declaredType = FORMATS[t.rt][format];
      if (!declaredType) throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Upload a JPEG, PNG, WebP, MP4, MOV or WebM file.');
      const bytes = await download(t.pid, format, t.rt);
      return { bytes, declaredType, publicId: t.pid, resourceType: t.rt };
    },

    async discardStaged({ publicId, resourceType }) {
      if (!publicId.startsWith(stagingPrefix)) return;
      await client.destroy(publicId, { resource_type: resourceType, type: 'authenticated', invalidate: true });
    },

    async cleanupStaging(olderThanMs) {
      const cutoff = Date.now() - olderThanMs;
      let removed = 0;
      for (const resourceType of ['image', 'video'] as const) {
        let cursor: string | undefined;
        do {
          const page = await client.list({ resource_type: resourceType, type: 'authenticated', prefix: stagingPrefix, max_results: 500, ...(cursor ? { next_cursor: cursor } : {}) });
          const old = page.resources.filter((r) => Date.parse(r.created_at) < cutoff).map((r) => r.public_id);
          // The Admin API deletes at most 100 per call.
          for (let i = 0; i < old.length; i += 100) {
            await client.deleteMany(old.slice(i, i + 100), { resource_type: resourceType, type: 'authenticated' });
          }
          removed += old.length;
          cursor = page.next_cursor;
        } while (cursor);
      }
      return removed;
    },
  };

  return {
    name: 'cloudinary',
    enabled: true,
    async put(key, bytes) {
      const { publicId, resourceType } = locate(key);
      let result;
      try {
        result = await client.upload(bytes, { public_id: publicId, resource_type: resourceType, type: 'authenticated', overwrite: false, unique_filename: false, use_filename: false });
      } catch (err) {
        // SDK errors carry only a message and HTTP code; never the secret.
        const code = (err as { http_code?: number })?.http_code;
        throw new Error(`Cloudinary upload failed${code ? ` with HTTP ${code}` : ''}`);
      }
      // overwrite:false returns the existing asset instead of failing; treat that like local storage does.
      if (result.existing) throw new Error('Storage object already exists');
    },
    async get(key) {
      const { publicId, format, resourceType } = locate(key);
      return download(publicId, format, resourceType);
    },
    async delete(key) {
      const { publicId, resourceType } = locate(key);
      await client.destroy(publicId, { resource_type: resourceType, type: 'authenticated', invalidate: true });
    },
    signedUrl(key, ttlSeconds) {
      const { publicId, format, resourceType } = locate(key);
      return downloadUrl(publicId, format, resourceType, ttlSeconds);
    },
    directUploads,
  };
}
