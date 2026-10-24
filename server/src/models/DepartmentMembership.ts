import { Schema, model, type InferSchemaType } from 'mongoose';
import { MEMBERSHIP_ROLES, MEMBERSHIP_STATUSES } from './enums.js';

const membershipSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    department: { type: Schema.Types.ObjectId, ref: 'Department', required: true },
    role: { type: String, enum: MEMBERSHIP_ROLES, required: true, default: 'MEMBER' },
    // Deactivate instead of deleting so past assignments and audit history stay valid.
    status: { type: String, enum: MEMBERSHIP_STATUSES, required: true, default: 'ACTIVE' },
    // Staff roster: off-duty members keep their membership but get no new automatic assignments.
    onDuty: { type: Boolean, required: true, default: true },
  },
  { timestamps: true },
);

// One membership per user per department. A user may belong to several departments.
membershipSchema.index({ user: 1, department: 1 }, { unique: true });
membershipSchema.index({ department: 1, role: 1, status: 1 });

export type DepartmentMembershipFields = InferSchemaType<typeof membershipSchema>;
export const DepartmentMembership = model('DepartmentMembership', membershipSchema);
