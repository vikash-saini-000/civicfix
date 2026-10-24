import { Schema, model, type InferSchemaType } from 'mongoose';
import { geoPointSchema } from './common.js';
import { ALLOWED_CONTENT_TYPES, EVIDENCE_PURPOSES, EVIDENCE_VERIFICATION_STATES, MEDIA_TYPES, REDACTION_STATES } from './enums.js';

/**
 * Shareable copy of an image: metadata (EXIF GPS etc.) stripped, faces and number plates blurred.
 * The original stays for verification; downloads serve this copy to everyone but the uploader and admins.
 */
const redactionSchema = new Schema(
  {
    state: { type: String, enum: REDACTION_STATES, required: true },
    storageKey: { type: String, trim: true, maxlength: 500 },
    contentType: { type: String, enum: ALLOWED_CONTENT_TYPES },
    faces: { type: Number, min: 0, default: 0 },
    licensePlates: { type: Number, min: 0, default: 0 },
    updatedAt: { type: Date, required: true },
  },
  { _id: false },
);

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

type EvidenceThis = { purpose?: string; mediaType?: string; contentType?: string };

/**
 * Metadata for one uploaded file. The binary lives in object storage; only its key is stored.
 * Used for complaint photos, resolution evidence and dispute evidence alike.
 */
const evidenceSchema = new Schema(
  {
    purpose: { type: String, enum: EVIDENCE_PURPOSES, required: true, immutable: true },
    complaint: { type: Schema.Types.ObjectId, ref: 'Complaint', required: true, immutable: true },
    workOrder: {
      type: Schema.Types.ObjectId,
      ref: 'WorkOrder',
      immutable: true,
      required(this: EvidenceThis) {
        return this.purpose === 'RESOLUTION';
      },
    },
    dispute: {
      type: Schema.Types.ObjectId,
      ref: 'Dispute',
      immutable: true,
      required(this: EvidenceThis) {
        return this.purpose === 'DISPUTE';
      },
    },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },

    mediaType: { type: String, enum: MEDIA_TYPES, required: true },
    contentType: {
      type: String,
      enum: ALLOWED_CONTENT_TYPES,
      required: true,
      validate: {
        validator(this: EvidenceThis, v: string) {
          return this.mediaType === 'VIDEO' ? v.startsWith('video/') : v.startsWith('image/');
        },
        message: 'contentType does not match mediaType',
      },
    },
    sizeBytes: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator(this: EvidenceThis, v: number) {
          return v <= (this.mediaType === 'VIDEO' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES);
        },
        message: 'file is larger than the allowed size',
      },
    },
    storageProvider: { type: String, required: true, trim: true, maxlength: 50 },
    storageKey: { type: String, required: true, trim: true, maxlength: 500, immutable: true },
    sha256: { type: String, lowercase: true, match: /^[0-9a-f]{64}$/ },
    originalFilename: { type: String, trim: true, maxlength: 255 },

    // From file metadata when available. Used for GPS and time consistency checks; not trusted on its own.
    capturedAt: { type: Date },
    captureLocation: { type: geoPointSchema },

    notes: { type: String, trim: true, maxlength: 1000 },
    verificationState: { type: String, enum: EVIDENCE_VERIFICATION_STATES, required: true, default: 'PENDING' },
    redaction: { type: redactionSchema },
  },
  { timestamps: true },
);

evidenceSchema.index({ storageKey: 1 }, { unique: true });
evidenceSchema.index({ complaint: 1, purpose: 1, createdAt: 1 });
evidenceSchema.index({ workOrder: 1, createdAt: 1 }, { sparse: true });
evidenceSchema.index({ dispute: 1 }, { sparse: true });
evidenceSchema.index({ sha256: 1 }, { sparse: true }); // spot reused photos

export type EvidenceFields = InferSchemaType<typeof evidenceSchema>;
export const Evidence = model('Evidence', evidenceSchema);
