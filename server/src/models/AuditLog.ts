import { Schema, model, type InferSchemaType } from 'mongoose';
import { SENSITIVE_FIELD_PATTERN } from './common.js';
import { ACTOR_TYPES, AUDIT_OUTCOMES, RESOURCE_TYPES } from './enums.js';

/** One changed field. Values should be short, non-sensitive summaries, not whole documents. */
const changeSchema = new Schema(
  {
    field: {
      type: String,
      required: true,
      maxlength: 100,
      validate: {
        validator: (f: string) => !SENSITIVE_FIELD_PATTERN.test(f),
        message: 'sensitive fields must not be recorded in audit changes',
      },
    },
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },
  },
  { _id: false },
);

const auditLogSchema = new Schema(
  {
    actorType: { type: String, enum: ACTOR_TYPES, required: true },
    actor: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required(this: { actorType?: string }) {
        return this.actorType === 'USER';
      },
    },
    // Dot-separated verb, e.g. "complaint.created", "work_order.assigned".
    action: { type: String, required: true, maxlength: 100, match: /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/ },
    targetType: { type: String, enum: RESOURCE_TYPES, required: true },
    targetId: { type: Schema.Types.ObjectId, required: true },
    outcome: { type: String, enum: AUDIT_OUTCOMES, required: true },
    reason: { type: String, trim: true, maxlength: 1000 },
    correlationId: { type: String, trim: true, maxlength: 100 },
    changes: {
      type: [changeSchema],
      default: [],
      validate: { validator: (c: unknown[]) => c.length <= 50, message: 'too many changes in one audit entry' },
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Append-only: block every update and delete path through Mongoose.
const blocked = () => {
  throw new Error('AuditLog is append-only');
};
for (const op of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'replaceOne',
  'findOneAndReplace',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
] as const) {
  auditLogSchema.pre(op, blocked);
}
auditLogSchema.pre('save', function () {
  if (!this.isNew) blocked();
});

// Untrusted text (e.g. a user's reason) must not be able to forge log lines: strip control characters.
auditLogSchema.pre('validate', function () {
  if (typeof this.reason === 'string') this.reason = this.reason.replace(/[\u0000-\u001f\u007f]+/g, ' ');
});

auditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
auditLogSchema.index({ actor: 1, createdAt: -1 }, { sparse: true });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ correlationId: 1 }, { sparse: true });
auditLogSchema.index({ createdAt: -1, _id: -1 }); // admin listing, newest first

export type AuditLogFields = InferSchemaType<typeof auditLogSchema>;
export const AuditLog = model('AuditLog', auditLogSchema);
