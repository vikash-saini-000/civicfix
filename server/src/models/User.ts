import { Schema, model, type InferSchemaType } from 'mongoose';
import { EMAIL_PATTERN } from './common.js';
import { ACCOUNT_STATUSES, PLATFORM_ROLES } from './enums.js';

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 100 },
    // Normalized login identifier.
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
      match: [EMAIL_PATTERN, 'email is not valid'],
    },
    // Hash only, never plaintext. Hidden from queries unless selected explicitly.
    passwordHash: { type: String, required: true, select: false },
    // Defaults to CITIZEN. Registration code must never set this from client input.
    platformRole: { type: String, enum: PLATFORM_ROLES, required: true, default: 'CITIZEN' },
    accountStatus: { type: String, enum: ACCOUNT_STATUSES, required: true, default: 'ACTIVE' },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret: Record<string, unknown>) {
        delete ret.passwordHash;
        return ret;
      },
    },
  },
);

userSchema.index({ email: 1 }, { unique: true });

export type UserFields = InferSchemaType<typeof userSchema>;
export const User = model('User', userSchema);
