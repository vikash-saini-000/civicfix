import { createHash, randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import type { Principal } from '../auth/roles.js';
import type { EvidencePurpose } from '../models/enums.js';
import { AIAnalysis, Complaint, Dispute, Evidence, WorkOrder } from '../models/index.js';
import { DEFAULT_MAX_VIDEO_SECONDS, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES } from '../models/Evidence.js';
import { disabledVideoTools, VideoProcessingError, type VideoProbe, type VideoTools } from '../media/video.js';
import type { ObjectStorage } from '../storage/index.js';
import { AppError, notFoundError, validationError } from '../utils/errors.js';
import { readCaptureMetadata } from './analysis/exif.js';
import type { ScreenResult } from './analysis/index.js';
import { isVideoType, sniffMediaType, typesMatch, type AuthenticityResult } from './analysis/mediaAuthenticity.js';
import { auditUserAction } from './audit.js';
import { relationTo, type ComplaintService } from './complaints.js';
import { rolesOn } from './workOrders.js';

export const MAX_EVIDENCE_PER_COMPLAINT = 30;
const EXTENSIONS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/quicktime': 'mov' };

/** Which copy of a file to download. `auto` = the original for its uploader, the privacy copy for everyone else. */
export type DownloadVariant = 'auto' | 'shared' | 'original';

export interface UploadInput {
  purpose: EvidencePurpose;
  bytes: Buffer;
  declaredType: string;
  caption?: string;
  disputeId?: string;
}

export interface EvidenceServiceDeps {
  storage: ObjectStorage;
  complaints: ComplaintService;
  /** Queues the privacy copy, the authenticity check and, for RESOLUTION files, the before/after comparison. */
  queueAnalysis?: (complaintId: Types.ObjectId, evidenceId: Types.ObjectId, requestedBy: string, purpose: EvidencePurpose, mediaType: 'IMAGE' | 'VIDEO', screened?: AuthenticityResult) => Promise<unknown>;
  /** Authenticity check before a file is stored. Files it doesn't allow are refused (MEDIA_REJECTED). */
  screenUpload?: (bytes: Buffer, mediaType: string, context: { complaintTitle: string; complaintDescription: string }) => Promise<ScreenResult>;
  onQueueError?: (err: unknown) => void;
  /** ffmpeg tools: read video length, recording time and GPS at upload. Disabled = videos are stored unchecked. */
  video?: VideoTools;
  /** Longest accepted video, in seconds. */
  maxVideoSeconds?: number;
}

type EvidenceDoc = Record<string, any> & { _id: Types.ObjectId; complaint: Types.ObjectId; purpose: EvidencePurpose };

/** Shown to the uploader. Deliberately general: the detailed signals are for staff only. */
export const MEDIA_REJECTED_MESSAGE =
  'This file looks AI-generated or edited, so it was not accepted. Please upload an original photo or video taken with your camera at the location.';

function checkFile(bytes: Buffer, declaredType: string) {
  // Trust only the bytes: real type from magic bytes, must match the declared Content-Type.
  const sniffed = sniffMediaType(bytes);
  if (!sniffed || !typesMatch(sniffed, declaredType)) throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Upload a JPEG, PNG, WebP, MP4 or MOV file whose content matches its type.');
  const max = isVideoType(sniffed) ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (bytes.length === 0 || bytes.length > max) throw new AppError('PAYLOAD_TOO_LARGE', `Files must be at most ${max / 1024 / 1024} MB.`);
  return sniffed;
}

export function createEvidenceService(deps: EvidenceServiceDeps) {
  const { storage } = deps;
  const video = deps.video ?? disabledVideoTools;
  const maxVideoSeconds = deps.maxVideoSeconds ?? DEFAULT_MAX_VIDEO_SECONDS;

  /** Videos must be readable and short enough. Returns their details, or undefined without ffmpeg. */
  async function checkVideo(bytes: Buffer, mediaType: string): Promise<VideoProbe | undefined> {
    if (!isVideoType(mediaType) || !video.enabled) return undefined;
    let probe: VideoProbe;
    try {
      probe = await video.probe(bytes);
    } catch (err) {
      if (err instanceof VideoProcessingError && err.kind === 'UNREADABLE') {
        throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'The video could not be read. Upload an MP4 or MOV recorded by a phone or camera.');
      }
      throw new AppError('SERVICE_UNAVAILABLE', 'Videos cannot be checked right now. Please try again shortly or upload a photo.');
    }
    if (probe.durationSec > maxVideoSeconds + 0.5) {
      throw new AppError('PAYLOAD_TOO_LARGE', `Videos must be at most ${maxVideoSeconds} seconds long.`);
    }
    return probe;
  }

  /** Who may add which kind of evidence, and when. Returns the related work order / dispute IDs to store. */
  async function authorizeUpload(p: Principal, complaint: { _id: Types.ObjectId; citizen: Types.ObjectId; status: string }, relation: string, input: UploadInput) {
    const reporter = relation === 'reporter' || String(complaint.citizen) === p.userId;
    switch (input.purpose) {
      case 'COMPLAINT_REPORT':
        if (!reporter) throw new AppError('FORBIDDEN', 'Only the person who reported this can add report photos.');
        if (!['REPORTED', 'UNDER_REVIEW'].includes(complaint.status)) throw new AppError('CONFLICT', 'Report photos can only be added before the complaint is assigned. Use ADDITIONAL instead.');
        return {};
      case 'ADDITIONAL':
        if (!reporter) throw new AppError('FORBIDDEN', 'Only the person who reported this can add photos.');
        if (['CLOSED', 'REJECTED'].includes(complaint.status)) throw new AppError('CONFLICT', 'This complaint is closed.');
        return {};
      case 'WORK_PROGRESS':
      case 'RESOLUTION': {
        const wo = await WorkOrder.findOne({ activeFor: complaint._id }).lean();
        if (!wo || !rolesOn(p, wo).has('ASSIGNEE')) throw new AppError('FORBIDDEN', 'Only the assigned team member can add work evidence.');
        const allowed = input.purpose === 'RESOLUTION' ? ['IN_PROGRESS', 'VERIFICATION_REQUIRED'] : ['ACCEPTED', 'IN_PROGRESS', 'BLOCKED'];
        if (!allowed.includes(wo.status)) throw new AppError('CONFLICT', `Work evidence can't be added while the work order is ${wo.status}.`);
        return { workOrder: wo._id };
      }
      case 'DISPUTE': {
        if (!reporter) throw new AppError('FORBIDDEN', 'Only the person who reported this can add dispute evidence.');
        if (!input.disputeId) throw validationError([{ field: 'query.disputeId', issue: 'required', message: 'disputeId is required for dispute evidence.' }]);
        const dispute = await Dispute.findOne({ _id: input.disputeId, complaint: complaint._id, submittedBy: p.userId, status: { $in: ['OPEN', 'UNDER_REVIEW'] } }).lean();
        if (!dispute) throw notFoundError('An open dispute');
        return { dispute: dispute._id, workOrder: dispute.workOrder };
      }
    }
  }

  function privacyView(r: { state: string; faces?: number; licensePlates?: number } | undefined) {
    if (!r) return { state: 'NOT_SUPPORTED', facesBlurred: 0, licensePlatesBlurred: 0 };
    return { state: r.state, facesBlurred: r.faces ?? 0, licensePlatesBlurred: r.licensePlates ?? 0 };
  }

  function toView(e: EvidenceDoc, viewerIsStaff: boolean, authenticity?: string) {
    return {
      id: String(e._id),
      purpose: e.purpose,
      mediaType: e.mediaType,
      contentType: e.contentType,
      sizeBytes: e.sizeBytes,
      sha256: e.sha256 ?? null,
      durationSec: e.durationSec ?? null,
      caption: e.notes ?? null,
      // Staff never get the reporter's account ID (reporter identity is hidden from departments).
      uploadedBy: { id: viewerIsStaff && e._reporter === true ? null : String(e.uploadedBy), isReporter: e._reporter === true },
      workOrderId: e.workOrder ? String(e.workOrder) : null,
      disputeId: e.dispute ? String(e.dispute) : null,
      createdAt: (e.createdAt as Date).toISOString(),
      // Download goes through an authorized endpoint; storage keys and paths are never exposed.
      contentUrl: `/api/v1/evidence/${e._id}/content`,
      // PENDING while faces/plates are being blurred; other viewers can download once it is ready.
      privacy: privacyView(e.redaction),
      ...(viewerIsStaff && { authenticity: authenticity ?? 'NOT_ANALYZED' }),
    };
  }

  async function latestAuthenticity(ids: Types.ObjectId[]) {
    const rows = await AIAnalysis.find({ evidence: { $in: ids }, analysisType: 'MEDIA_AUTHENTICITY' }).sort({ analysisVersion: -1 }).select('evidence status authenticity').lean();
    const out = new Map<string, string>();
    for (const r of rows) {
      const k = String(r.evidence);
      if (out.has(k)) continue;
      out.set(k, r.status === 'PENDING' || r.status === 'RUNNING' ? 'ANALYSIS_PENDING' : (r.authenticity?.outcome ?? 'ANALYSIS_FAILED'));
    }
    return out;
  }

  return {
    async upload(p: Principal, publicId: string, input: UploadInput, requestId: string) {
      const { complaintId, relation } = await deps.complaints.access(p, publicId);
      const complaint = await Complaint.findById(complaintId).select('citizen status title description').lean();
      if (!complaint) throw notFoundError('The complaint');
      const links = await authorizeUpload(p, complaint, relation, input);

      const sniffed = checkFile(input.bytes, input.declaredType);
      if ((await Evidence.countDocuments({ complaint: complaintId })) >= MAX_EVIDENCE_PER_COMPLAINT) {
        throw new AppError('CONFLICT', `A complaint can have at most ${MAX_EVIDENCE_PER_COMPLAINT} files.`);
      }
      const probe = await checkVideo(input.bytes, sniffed);
      const isVideo = isVideoType(sniffed);

      // AI-generated or edited files are refused before anything is stored.
      let screened: AuthenticityResult | undefined;
      if (deps.screenUpload) {
        const s = await deps.screenUpload(input.bytes, sniffed, { complaintTitle: complaint.title ?? '', complaintDescription: complaint.description ?? '' });
        if (!s.allowed) {
          await auditUserAction({
            actor: p,
            action: 'evidence.rejected',
            targetType: 'Complaint',
            targetId: complaintId,
            requestId,
            changes: [{ field: 'purpose', after: input.purpose }, { field: 'authenticity', after: s.result.outcome }],
          });
          throw new AppError('MEDIA_REJECTED', MEDIA_REJECTED_MESSAGE);
        }
        screened = s.result;
      }

      // Capture time and GPS from the file itself (JPEG EXIF, phone video tags). Hints for verification, never proof.
      const capture = sniffed === 'image/jpeg' ? readCaptureMetadata(input.bytes) : probe ? { capturedAt: probe.capturedAt, location: probe.location } : {};

      const id = new Types.ObjectId();
      const key = `evidence/${String(complaintId)}/${String(id)}-${randomUUID()}.${EXTENSIONS[sniffed]}`;
      await storage.put(key, input.bytes, sniffed);
      let doc;
      try {
        doc = await Evidence.create({
          _id: id,
          purpose: input.purpose,
          complaint: complaintId,
          workOrder: links.workOrder,
          dispute: links.dispute,
          uploadedBy: p.userId,
          mediaType: isVideo ? 'VIDEO' : 'IMAGE',
          contentType: sniffed,
          sizeBytes: input.bytes.length,
          storageProvider: storage.name,
          storageKey: key,
          sha256: createHash('sha256').update(input.bytes).digest('hex'),
          notes: input.caption,
          capturedAt: capture.capturedAt,
          captureLocation: capture.location ? { type: 'Point', coordinates: [capture.location.lng, capture.location.lat] } : undefined,
          durationSec: probe ? Math.round(probe.durationSec * 10) / 10 : undefined,
          // Shareable copy without metadata, with faces and number plates blurred (videos need ffmpeg).
          redaction: { state: isVideo && !video.enabled ? 'NOT_SUPPORTED' : 'PENDING', updatedAt: new Date() },
        });
      } catch (err) {
        await storage.delete(key).catch(() => undefined); // don't leave an orphan file
        throw err;
      }
      await auditUserAction({ actor: p, action: 'evidence.uploaded', targetType: 'Evidence', targetId: doc._id, requestId, changes: [{ field: 'purpose', after: input.purpose }, { field: 'sizeBytes', after: input.bytes.length }] });
      if (deps.queueAnalysis) await deps.queueAnalysis(complaintId, doc._id, p.userId, input.purpose, isVideo ? 'VIDEO' : 'IMAGE', screened).catch((err) => deps.onQueueError?.(err));
      const lean = { ...(doc.toObject() as EvidenceDoc), _reporter: relation === 'reporter' };
      return toView(lean, relation !== 'reporter', screened?.outcome ?? 'ANALYSIS_PENDING');
    },

    /**
     * Checks a file before the complaint exists (report form), so a citizen learns about a rejected
     * photo before submitting. Stores nothing; the real upload repeats the check (cached, no extra AI call).
     */
    async precheck(p: Principal, bytes: Buffer, declaredType: string, requestId: string) {
      const sniffed = checkFile(bytes, declaredType);
      await checkVideo(bytes, sniffed);
      if (!deps.screenUpload) return { allowed: true, message: null };
      const s = await deps.screenUpload(bytes, sniffed, { complaintTitle: '', complaintDescription: '' });
      if (!s.allowed) {
        await auditUserAction({ actor: p, action: 'evidence.rejected', targetType: 'User', targetId: p.userId, requestId, changes: [{ field: 'authenticity', after: s.result.outcome }] });
      }
      return { allowed: s.allowed, message: s.allowed ? null : MEDIA_REJECTED_MESSAGE };
    },

    /** Metadata for a complaint's evidence. Reporter, staff of its department and admins only. */
    async list(p: Principal, publicId: string) {
      const { complaintId, relation } = await deps.complaints.access(p, publicId);
      const complaint = await Complaint.findById(complaintId).select('citizen').lean();
      const docs = (await Evidence.find({ complaint: complaintId }).sort({ createdAt: 1 }).limit(MAX_EVIDENCE_PER_COMPLAINT).lean()) as unknown as EvidenceDoc[];
      const staff = relation !== 'reporter';
      const auth = staff ? await latestAuthenticity(docs.map((d) => d._id)) : new Map<string, string>();
      return docs.map((d) => toView({ ...d, _reporter: String(d.uploadedBy) === String(complaint?.citizen) }, staff, auth.get(String(d._id))));
    },

    /**
     * File bytes after the same access check as the complaint. Every download is audited.
     * Privacy: images are served as the shareable copy (no metadata; faces and number plates blurred).
     * The original goes only to its uploader, or to a platform admin who asks for it explicitly.
     * Videos (no copy is made) and files uploaded before this feature are served as stored.
     */
    async download(p: Principal, evidenceId: string, requestId: string, variant: DownloadVariant = 'auto') {
      const ev = await Evidence.findById(evidenceId).lean();
      if (!ev) throw notFoundError('The file');
      const complaint = await Complaint.findById(ev.complaint).select('citizen department routingReview').lean();
      if (!complaint || !relationTo(p, complaint)) throw notFoundError('The file');
      const uploader = String(ev.uploadedBy) === p.userId;
      const admin = p.roles.has('PLATFORM_ADMIN');
      if (variant === 'original' && !uploader && !admin) throw new AppError('FORBIDDEN', 'Only the uploader or a platform administrator can download the original file.');

      const r = ev.redaction;
      const hasCopy = r && (r.state === 'DONE' || r.state === 'METADATA_ONLY') && r.storageKey;
      const wantOriginal = variant === 'original' || (variant === 'auto' && uploader) || !r || r.state === 'NOT_SUPPORTED';
      let key = ev.storageKey;
      let served: 'ORIGINAL' | 'SHARED' = 'ORIGINAL';
      if (!wantOriginal) {
        if (hasCopy) {
          key = r.storageKey!;
          served = 'SHARED';
        } else if (r.state === 'PENDING') throw new AppError('CONFLICT', 'This file is still being prepared for sharing (faces and number plates are blurred first). Try again in a few seconds.');
        else throw new AppError('CONFLICT', 'This file could not be prepared for sharing.');
      }
      const bytes = await storage.get(key);
      await auditUserAction({
        actor: p,
        action: served === 'ORIGINAL' && !uploader ? 'evidence.original_downloaded' : 'evidence.downloaded',
        targetType: 'Evidence',
        targetId: ev._id,
        requestId,
        changes: [{ field: 'variant', after: served }],
      });
      // A video's shareable copy is re-encoded as MP4, so its type can differ from the original's.
      const contentType = served === 'SHARED' ? (r?.contentType ?? ev.contentType) : ev.contentType;
      return { bytes, contentType, variant: served, filename: `${String(ev._id)}${served === 'SHARED' ? '-shared' : ''}.${EXTENSIONS[contentType] ?? 'bin'}` };
    },
  };
}
export type EvidenceService = ReturnType<typeof createEvidenceService>;
