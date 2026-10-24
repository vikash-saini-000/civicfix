import { Types } from 'mongoose';
import { Complaint } from '../../models/index.js';
import { complaintVector, cosine } from './textSimilarity.js';

export interface DuplicateSettings {
  radiusMeters: number;
  windowDays: number;
  /** Max nearby complaints examined per run (bounds the query). */
  maxCandidates: number;
  /** Max suggestions stored. */
  maxSuggestions: number;
  minSimilarity: number;
}

export const DEFAULT_DUPLICATE_SETTINGS: DuplicateSettings = {
  radiusMeters: 150,
  windowDays: 14,
  maxCandidates: 20,
  maxSuggestions: 5,
  minSimilarity: 0.25,
};

export const DUPLICATE_METHOD = { provider: 'civicfix-rules', modelName: 'geo-text-cosine-v1' } as const;

export interface DuplicateSuggestion {
  complaint: Types.ObjectId;
  similarity: number;
  distanceMeters: number;
  reason: string;
}

type Target = {
  _id: Types.ObjectId;
  title: string;
  description: string;
  location: { coordinates: number[] };
  createdAt: Date;
  selectedCategory?: string | null;
  confirmedCategory?: string | null;
};

/**
 * Stage 1 (database, bounded): other complaints within radiusMeters and ±windowDays, excluding
 * itself and rejected ones, nearest first, at most maxCandidates.
 * Stage 2 (in memory, on ≤ maxCandidates docs): drop clearly different categories, score wording,
 * keep those above minSimilarity. Results are suggestions for a human; nothing is merged or hidden.
 */
export async function findDuplicateCandidates(target: Target, settings: DuplicateSettings = DEFAULT_DUPLICATE_SETTINGS): Promise<DuplicateSuggestion[]> {
  const windowMs = settings.windowDays * 86_400_000;
  const nearby = await Complaint.aggregate<Target & { distance: number }>([
    {
      $geoNear: {
        near: { type: 'Point', coordinates: [target.location.coordinates[0]!, target.location.coordinates[1]!] },
        distanceField: 'distance',
        maxDistance: settings.radiusMeters,
        spherical: true,
        query: {
          _id: { $ne: target._id },
          status: { $ne: 'REJECTED' },
          createdAt: { $gte: new Date(target.createdAt.getTime() - windowMs), $lte: new Date(target.createdAt.getTime() + windowMs) },
        },
      },
    },
    { $limit: settings.maxCandidates },
    { $project: { title: 1, description: 1, createdAt: 1, selectedCategory: 1, confirmedCategory: 1, distance: 1 } },
  ]);

  const category = (c: { confirmedCategory?: string | null; selectedCategory?: string | null }) => c.confirmedCategory ?? c.selectedCategory ?? null;
  const targetCategory = category(target);
  const targetVec = complaintVector(target);

  const scored: DuplicateSuggestion[] = [];
  for (const c of nearby) {
    if (c._id.equals(target._id)) continue; // never match itself
    const otherCategory = category(c);
    if (targetCategory && otherCategory && targetCategory !== otherCategory) continue;
    const similarity = Math.round(cosine(targetVec, complaintVector(c)) * 1000) / 1000;
    if (similarity < settings.minSimilarity) continue;
    const days = Math.round(Math.abs(c.createdAt.getTime() - target.createdAt.getTime()) / 86_400_000);
    scored.push({
      complaint: c._id,
      similarity,
      distanceMeters: Math.round(c.distance),
      reason: `About ${Math.round(c.distance)} m away, filed ${days === 0 ? 'the same day' : `${days} day${days === 1 ? '' : 's'} apart`}, similar wording.`,
    });
  }
  return scored.sort((a, b) => b.similarity - a.similarity).slice(0, settings.maxSuggestions);
}
