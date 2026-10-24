import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * A city ward: an administrative area with a GeoJSON polygon boundary. Complaints get their ward from
 * their location; departments can be limited to some wards (coverage), and analytics group by ward.
 */
const polygonSchema = new Schema(
  {
    type: { type: String, enum: ['Polygon'], required: true, default: 'Polygon' },
    // [[[lng, lat], ...]] — one closed outer ring (first point == last point), no holes.
    coordinates: {
      type: [[[Number]]],
      required: true,
      validate: {
        validator: (rings: number[][][]) => {
          if (rings.length !== 1) return false;
          const ring = rings[0]!;
          if (ring.length < 4) return false;
          const [first, last] = [ring[0]!, ring[ring.length - 1]!];
          const valid = ring.every((p) => p.length === 2 && p[0]! >= -180 && p[0]! <= 180 && p[1]! >= -90 && p[1]! <= 90);
          return valid && first[0] === last[0] && first[1] === last[1];
        },
        message: 'boundary must be one closed ring of [longitude, latitude] points',
      },
    },
  },
  { _id: false },
);

const wardSchema = new Schema(
  {
    code: { type: String, required: true, trim: true, uppercase: true, match: /^[A-Z0-9-]{1,20}$/ },
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
    boundary: { type: polygonSchema, required: true },
    population: { type: Number, min: 0 },
    isActive: { type: Boolean, required: true, default: true },
  },
  { timestamps: true },
);

wardSchema.index({ code: 1 }, { unique: true });
wardSchema.index({ boundary: '2dsphere' });

export type WardFields = InferSchemaType<typeof wardSchema>;
export const Ward = model('Ward', wardSchema);
