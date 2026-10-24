import { Schema, model, type InferSchemaType } from 'mongoose';
import { CATEGORIES } from './enums.js';

const departmentSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
    description: { type: String, trim: true, maxlength: 1000 },
    // Category-to-department mapping. A category may map to more than one department
    // (cross-department cases go to manager review), so this is not unique across departments.
    categories: {
      type: [{ type: String, enum: CATEGORIES }],
      required: true,
      validate: {
        validator: (c: string[]) => c.length > 0 && new Set(c).size === c.length,
        message: 'categories must be a non-empty list without repeats',
      },
    },
    isActive: { type: Boolean, required: true, default: true },
  },
  { timestamps: true },
);

// Case-insensitive unique name.
departmentSchema.index({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });
departmentSchema.index({ categories: 1, isActive: 1 });

export type DepartmentFields = InferSchemaType<typeof departmentSchema>;
export const Department = model('Department', departmentSchema);
