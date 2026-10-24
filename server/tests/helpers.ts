import { Error as MongooseError, Types, type Document } from 'mongoose';

export const oid = () => new Types.ObjectId();

/** Paths that failed validation, sorted. Empty when the document is valid. */
export async function invalidPaths(doc: Document): Promise<string[]> {
  try {
    await doc.validate();
    return [];
  } catch (err) {
    if (err instanceof MongooseError.ValidationError) return Object.keys(err.errors).sort();
    throw err;
  }
}

export const point = (lng = 74.7956, lat = 13.0072) => ({ type: 'Point' as const, coordinates: [lng, lat] });

export const validComplaint = () => ({
  publicId: 'CF-2026-00141',
  citizen: oid(),
  title: 'Deep pothole near the bus stop',
  description: 'Large pothole on the service road near the bus stop.',
  location: point(),
});
