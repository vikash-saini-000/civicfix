import { Schema } from 'mongoose';

/** GeoJSON point, stored as [longitude, latitude] so 2dsphere indexes work. */
export const geoPointSchema = new Schema(
  {
    type: { type: String, enum: ['Point'], required: true, default: 'Point' },
    coordinates: {
      type: [Number],
      required: true,
      validate: {
        validator: (c: number[]) =>
          c.length === 2 &&
          c.every(Number.isFinite) &&
          c[0]! >= -180 &&
          c[0]! <= 180 &&
          c[1]! >= -90 &&
          c[1]! <= 90,
        message: 'coordinates must be [longitude, latitude] within valid ranges',
      },
    },
  },
  { _id: false },
);

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Field names that must never appear in audit change summaries. */
export const SENSITIVE_FIELD_PATTERN = /pass(word)?|token|secret|api[-_]?key|authorization|cookie|hash/i;
