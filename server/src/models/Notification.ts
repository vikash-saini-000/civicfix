import { Schema, model, type InferSchemaType } from 'mongoose';
import { DELIVERY_STATUSES, NOTIFICATION_CHANNELS, NOTIFICATION_TYPES } from './enums.js';

const notificationSchema = new Schema(
  {
    recipient: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    channel: { type: String, enum: NOTIFICATION_CHANNELS, required: true, default: 'IN_APP' },

    // Related resources (at least one is expected for every current type).
    complaint: { type: Schema.Types.ObjectId, ref: 'Complaint' },
    workOrder: { type: Schema.Types.ObjectId, ref: 'WorkOrder' },
    dispute: { type: Schema.Types.ObjectId, ref: 'Dispute' },

    // Safe, recipient-appropriate text only. No internal notes or staff personal data.
    title: { type: String, required: true, trim: true, maxlength: 150 },
    message: { type: String, required: true, trim: true, maxlength: 1000 },

    // Prevents duplicate notifications when an event is retried, e.g. "complaint:<id>:status:ASSIGNED".
    dedupeKey: { type: String, trim: true, maxlength: 200 },

    deliveryStatus: { type: String, enum: DELIVERY_STATUSES, required: true, default: 'PENDING' },
    attempts: { type: Number, required: true, min: 0, default: 0 },
    lastAttemptAt: { type: Date },
    lastError: { type: String, trim: true, maxlength: 500 },
    deliveredAt: { type: Date },
    readAt: { type: Date },
  },
  { timestamps: true },
);

notificationSchema.pre('validate', function () {
  if (!this.complaint && !this.workOrder && !this.dispute) {
    this.invalidate('complaint', 'a notification must reference a complaint, work order or dispute');
  }
});

notificationSchema.index({ recipient: 1, readAt: 1, createdAt: -1 });
notificationSchema.index({ dedupeKey: 1 }, { unique: true, sparse: true });
notificationSchema.index({ deliveryStatus: 1, lastAttemptAt: 1 }); // retry worker

export type NotificationFields = InferSchemaType<typeof notificationSchema>;
export const Notification = model('Notification', notificationSchema);
