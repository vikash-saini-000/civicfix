import express, { Router } from 'express';
import { z } from 'zod';
import type { AuthService } from '../auth/authService.js';
import { requireAuth } from '../middleware/auth.js';
import { createRateLimiter, type RateLimitOptions } from '../middleware/rateLimit.js';
import { input, validate } from '../middleware/validate.js';
import { ALLOWED_CONTENT_TYPES, DISPUTE_CATEGORIES, DISPUTE_STATUSES, EVIDENCE_PURPOSES } from '../models/enums.js';
import { MAX_VIDEO_BYTES } from '../models/Evidence.js';
import type { EvidenceService } from '../services/evidence.js';
import type { CaptureStampInput } from '../services/captureSessions.js';
import type { ResolutionService } from '../services/resolution.js';
import { sendCreated, sendSuccess } from '../utils/respond.js';
import { AppError } from '../utils/errors.js';
import { complaintPublicId, objectId, text } from '../validation/common.js';
import { paginationQuery } from '../validation/pagination.js';
import type { DirectUploads, StagedFile } from '../storage/cloudinary.js';

const complaintParams = z.strictObject({ publicId: complaintPublicId });
const idParams = z.strictObject({ id: objectId });
const workOrderParams = z.strictObject({ id: z.string().trim().regex(/^(WO-\d{4}-\d{5,}|[0-9a-fA-F]{24})$/i, 'Must be a work-order ID like WO-2026-00001.') });

const uploadQuery = z.strictObject({
  purpose: z.enum(EVIDENCE_PURPOSES),
  caption: text(1, 300).optional(),
  disputeId: objectId.optional(),
});

export const DEFAULT_UPLOAD_LIMIT: RateLimitOptions = { windowMs: 60 * 60_000, limit: 60 };

/** Raw upload types. WebM (browser recordings) is accepted on the wire and converted to MP4 before storage. */
const UPLOAD_TYPES = [...ALLOWED_CONTENT_TYPES, 'video/webm'];

/** In-app camera stamp sent with a captured file. */
function captureHeaders(req: express.Request): CaptureStampInput | undefined {
  const token = req.get('x-capture-token');
  if (!token) return undefined;
  return { token: token.slice(0, 2000), capturedAt: req.get('x-captured-at'), lat: req.get('x-capture-lat'), lng: req.get('x-capture-lng'), accuracy: req.get('x-capture-accuracy') };
}

/**
 * Upload route. Takes the raw file as the request body (Content-Type: image/jpeg | image/png |
 * image/webp | video/mp4), so it is mounted before the JSON-only check. Size is capped while
 * reading; type and size are re-checked from the bytes in the service.
 */
export function evidenceUploadRouter(deps: { authService: AuthService; evidenceService: EvidenceService; uploadLimit?: RateLimitOptions; directUploads?: boolean }): Router {
  const router = Router();
  router.post(
    '/complaints/:publicId/evidence',
    requireAuth(deps.authService),
    createRateLimiter({ ...(deps.uploadLimit ?? DEFAULT_UPLOAD_LIMIT), keyPart: (req) => req.auth?.userId }),
    express.raw({ type: UPLOAD_TYPES, limit: MAX_VIDEO_BYTES }),
    validate({ params: complaintParams, query: uploadQuery }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Send the file as the request body with Content-Type image/jpeg, image/png, image/webp or video/mp4.');
      }
      const { publicId } = input<{ publicId: string }>(req, 'params');
      const q = input<z.infer<typeof uploadQuery>>(req, 'query');
      const evidence = await deps.evidenceService.upload(
        req.auth!,
        publicId,
        { purpose: q.purpose, caption: q.caption, disputeId: q.disputeId, bytes: req.body, declaredType: (req.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase(), capture: captureHeaders(req) },
        req.id,
      );
      sendCreated(res, { evidence }, evidence.contentUrl);
    },
  );
  // Check a photo/video before the complaint is created (report form). Nothing is stored.
  router.post(
    '/evidence/check',
    requireAuth(deps.authService),
    createRateLimiter({ ...(deps.uploadLimit ?? DEFAULT_UPLOAD_LIMIT), keyPart: (req) => `check:${req.auth?.userId}` }),
    express.raw({ type: UPLOAD_TYPES, limit: MAX_VIDEO_BYTES }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Send the file as the request body with Content-Type image/jpeg, image/png, image/webp or video/mp4.');
      }
      const declaredType = (req.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      sendSuccess(res, await deps.evidenceService.precheck(req.auth!, req.body, declaredType, req.id, captureHeaders(req)));
    },
  );
  // Capture rules for the app (camera only or gallery allowed, longest video).
  router.get('/evidence/capture-policy', requireAuth(deps.authService), (_req, res) => {
    // directUpload: the app must upload files straight to storage (POST /evidence/uploads) instead of to this API.
    sendSuccess(res, { ...deps.evidenceService.capturePolicy(), directUpload: deps.directUploads === true });
  });
  // Opens an in-app camera session. No body.
  router.post(
    '/evidence/capture-sessions',
    requireAuth(deps.authService),
    createRateLimiter({ ...(deps.uploadLimit ?? DEFAULT_UPLOAD_LIMIT), keyPart: (req) => `camera:${req.auth?.userId}` }),
    (req, res) => {
      sendCreated(res, deps.evidenceService.startCaptureSession(req.auth!), '/api/v1/evidence/capture-policy');
    },
  );
  return router;
}

const resolutionBody = z.strictObject({
  completionNotes: text(10, 2000),
  evidenceIds: z.array(objectId).min(1).max(10),
});
const verificationBody = z.strictObject({ decision: z.enum(['APPROVE', 'REJECT', 'REQUEST_EVIDENCE']), reason: text(3, 1000) });
const disputeBody = z.strictObject({ reason: text(10, 2000), category: z.enum(DISPUTE_CATEGORIES).optional() });
const disputeDecisionBody = z.strictObject({ decision: z.enum(['UPHOLD', 'DISMISS']), reason: text(5, 2000) });
const feedbackBody = z.strictObject({
  rating: z.number().int().min(1).max(5),
  comment: text(1, 1000).optional(),
});
const csv = <T extends readonly [string, ...string[]]>(v: T) => z.string().max(200).transform((s) => s.split(',')).pipe(z.array(z.enum(v)).min(1));
const disputeList = paginationQuery.extend({ scope: z.enum(['mine', 'department', 'all']).default('mine'), status: csv(DISPUTE_STATUSES).optional() });
const empty = z.strictObject({});
const downloadQuery = z.strictObject({ variant: z.enum(['auto', 'shared', 'original']).default('auto') });
const signUploadBody = z.strictObject({ kind: z.enum(['image', 'video']) });
// A file the browser already uploaded to staging storage: the token from POST /evidence/uploads plus
// the format the storage reported (e.g. "jpg").
const stagedRef = { token: z.string().min(10).max(1000), format: z.string().trim().toLowerCase().regex(/^[a-z0-9]{2,5}$/, 'Must be a file format like jpg.') };
const checkUploadBody = z.strictObject(stagedRef);
const attachUploadBody = z.strictObject({ ...stagedRef, purpose: z.enum(EVIDENCE_PURPOSES), caption: text(1, 300).optional(), disputeId: objectId.optional() });

/** A staged file is kept only when the failure was temporary (5xx), so the citizen can retry without re-uploading. */
async function discardUnlessTransient(du: DirectUploads, staged: StagedFile, err?: unknown) {
  if (err instanceof AppError && err.status >= 500) return;
  if (err && !(err instanceof AppError)) return;
  await du.discardStaged(staged).catch(() => undefined);
}

/** Evidence reads, resolution, verification, disputes, closing and feedback (JSON bodies). */
export function resolutionRouter(deps: {
  authService: AuthService;
  evidenceService: EvidenceService;
  resolutionService: ResolutionService;
  /** Browser-to-storage uploads (Cloudinary). Off = files are uploaded to the API itself. */
  directUploads?: DirectUploads;
  uploadLimit?: RateLimitOptions;
}): Router {
  const router = Router();
  const auth = requireAuth(deps.authService);
  const ev = deps.evidenceService;
  const rs = deps.resolutionService;
  type CP = z.infer<typeof complaintParams>;
  type IP = z.infer<typeof idParams>;

  router.get('/complaints/:publicId/evidence', auth, validate({ params: complaintParams }), async (req, res) => {
    sendSuccess(res, await ev.list(req.auth!, input<CP>(req, 'params').publicId));
  });

  if (deps.directUploads) {
    const du = deps.directUploads;
    const limit = (prefix: string) => createRateLimiter({ ...(deps.uploadLimit ?? DEFAULT_UPLOAD_LIMIT), keyPart: (req) => `${prefix}:${req.auth?.userId}` });

    // Signature for one browser upload into staging storage. The file only counts once attached below.
    router.post('/evidence/uploads', auth, limit('sign'), validate({ body: signUploadBody }), (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      sendCreated(res, du.sign(req.auth!.userId, input<z.infer<typeof signUploadBody>>(req, 'body').kind), '/api/v1/evidence/check-upload');
    });

    // Same as POST /evidence/check, for a staged file. A refused file is deleted from staging.
    router.post('/evidence/check-upload', auth, limit('check'), validate({ body: checkUploadBody }), async (req, res) => {
      const b = input<z.infer<typeof checkUploadBody>>(req, 'body');
      const staged = await du.fetchStaged(req.auth!.userId, b.token, b.format);
      let result;
      try {
        result = await ev.precheck(req.auth!, staged.bytes, staged.declaredType, req.id, captureHeaders(req));
      } catch (err) {
        await discardUnlessTransient(du, staged, err);
        throw err;
      }
      if (!result.allowed) await du.discardStaged(staged).catch(() => undefined);
      sendSuccess(res, result);
    });

    // Same as POST /complaints/:publicId/evidence, for a staged file: every check runs again on the bytes.
    router.post('/complaints/:publicId/evidence/from-upload', auth, limit('upload'), validate({ params: complaintParams, body: attachUploadBody }), async (req, res) => {
      const b = input<z.infer<typeof attachUploadBody>>(req, 'body');
      const staged = await du.fetchStaged(req.auth!.userId, b.token, b.format);
      let evidence;
      try {
        evidence = await ev.upload(
          req.auth!,
          input<CP>(req, 'params').publicId,
          { purpose: b.purpose, caption: b.caption, disputeId: b.disputeId, bytes: staged.bytes, declaredType: staged.declaredType, capture: captureHeaders(req) },
          req.id,
        );
      } catch (err) {
        await discardUnlessTransient(du, staged, err);
        throw err;
      }
      // Stored under its own key now; the staged copy is no longer needed.
      await du.discardStaged(staged).catch(() => undefined);
      sendCreated(res, { evidence }, evidence.contentUrl);
    });
  }

  // Short-lived signed link to the file (same access rules and audit as /content). link = null when the
  // storage can't sign links; use /content then.
  router.get('/evidence/:id/link', auth, validate({ params: idParams, query: downloadQuery }), async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    sendSuccess(res, { link: await ev.link(req.auth!, input<IP>(req, 'params').id, req.id, input<z.infer<typeof downloadQuery>>(req, 'query').variant) });
  });

  router.get('/evidence/:id/content', auth, validate({ params: idParams, query: downloadQuery }), async (req, res) => {
    const file = await ev.download(req.auth!, input<IP>(req, 'params').id, req.id, input<z.infer<typeof downloadQuery>>(req, 'query').variant);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Evidence-Variant', file.variant);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.type(file.contentType).send(file.bytes);
  });

  router.post('/work-orders/:id/resolution', auth, validate({ params: workOrderParams, body: resolutionBody }), async (req, res) => {
    sendSuccess(res, await rs.submitResolution(req.auth!, input<{ id: string }>(req, 'params').id, input<z.infer<typeof resolutionBody>>(req, 'body'), req.id));
  });

  router.post('/work-orders/:id/verification', auth, validate({ params: workOrderParams, body: verificationBody }), async (req, res) => {
    sendSuccess(res, { workOrder: await rs.decide(req.auth!, input<{ id: string }>(req, 'params').id, input<z.infer<typeof verificationBody>>(req, 'body'), req.id) });
  });

  router.post('/complaints/:publicId/disputes', auth, validate({ params: complaintParams, body: disputeBody }), async (req, res) => {
    const dispute = await rs.createDispute(req.auth!, input<CP>(req, 'params').publicId, input<z.infer<typeof disputeBody>>(req, 'body'), req.id);
    sendCreated(res, { dispute }, `/api/v1/disputes/${dispute.id}`);
  });

  router.get('/disputes', auth, validate({ query: disputeList }), async (req, res) => {
    const { items, pagination } = await rs.listDisputes(req.auth!, input(req, 'query'));
    sendSuccess(res, items, { meta: { pagination } });
  });
  router.get('/disputes/:id', auth, validate({ params: idParams }), async (req, res) => {
    sendSuccess(res, { dispute: await rs.getDispute(req.auth!, input<IP>(req, 'params').id) });
  });
  router.post('/disputes/:id/review', auth, validate({ params: idParams, body: empty }), async (req, res) => {
    sendSuccess(res, { dispute: await rs.startDisputeReview(req.auth!, input<IP>(req, 'params').id, req.id) });
  });
  router.post('/disputes/:id/decision', auth, validate({ params: idParams, body: disputeDecisionBody }), async (req, res) => {
    sendSuccess(res, { dispute: await rs.decideDispute(req.auth!, input<IP>(req, 'params').id, input<z.infer<typeof disputeDecisionBody>>(req, 'body'), req.id) });
  });
  router.post('/disputes/:id/withdraw', auth, validate({ params: idParams, body: empty }), async (req, res) => {
    sendSuccess(res, { dispute: await rs.withdrawDispute(req.auth!, input<IP>(req, 'params').id, req.id) });
  });

  router.post('/complaints/:publicId/close', auth, validate({ params: complaintParams, body: empty }), async (req, res) => {
    sendSuccess(res, { complaint: await rs.close(req.auth!, input<CP>(req, 'params').publicId, req.id) });
  });
  router.post('/complaints/:publicId/feedback', auth, validate({ params: complaintParams, body: feedbackBody }), async (req, res) => {
    sendCreated(res, { feedback: await rs.feedback(req.auth!, input<CP>(req, 'params').publicId, input<z.infer<typeof feedbackBody>>(req, 'body'), req.id) });
  });

  return router;
}
