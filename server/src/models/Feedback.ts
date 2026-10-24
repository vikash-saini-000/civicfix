import { Schema, model, type InferSchemaType } from 'mongoose';
import { FEEDBACK_MODERATION_STATES } from './enums.js';

/** Citizen rating of a handled complaint. Separate from Dispute, which is a formal review. */
const feedbackSchema = new Schema(
  {
    complaint: { type: Schema.Types.ObjectId, ref: 'Complaint', required: true, immutable: true },
    citizen: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
      validate: { validator: Number.isInteger, message: 'rating must be a whole number' },
    },
    comment: { type: String, trim: true, maxlength: 1000 },
    moderationState: { type: String, enum: FEEDBACK_MODERATION_STATES, required: true, default: 'VISIBLE' },
  },
  { timestamps: true },
);

// One feedback entry per citizen per complaint.
feedbackSchema.index({ complaint: 1, citizen: 1 }, { unique: true });

export type FeedbackFields = InferSchemaType<typeof feedbackSchema>;
export const Feedback = model('Feedback', feedbackSchema);
