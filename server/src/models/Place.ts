import { Schema, model, type InferSchemaType } from 'mongoose';
import { PLACE_KINDS } from './enums.js';

/**
 * A mapped place used as location context: schools, hospitals, main roads, markets, bus stops.
 * Points for buildings and stops; LineStrings for roads. Read-only reference data (seeded or imported).
 */
const geometrySchema = new Schema(
  {
    type: { type: String, enum: ['Point', 'LineString'], required: true },
    coordinates: {
      type: Schema.Types.Mixed,
      required: true,
      validate: {
        validator(this: { type?: string }, c: unknown) {
          const pt = (p: unknown) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n)) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
          if (this.type === 'Point') return pt(c);
          return Array.isArray(c) && c.length >= 2 && c.length <= 500 && c.every(pt);
        },
        message: 'coordinates must be a [lng, lat] point, or 2–500 points for a line',
      },
    },
  },
  { _id: false },
);

const placeSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
    kind: { type: String, enum: PLACE_KINDS, required: true },
    geometry: { type: geometrySchema, required: true },
    ward: { type: Schema.Types.ObjectId, ref: 'Ward' },
  },
  { timestamps: true },
);

placeSchema.index({ geometry: '2dsphere' });
placeSchema.index({ kind: 1 });

export type PlaceFields = InferSchemaType<typeof placeSchema>;
export const Place = model('Place', placeSchema);
