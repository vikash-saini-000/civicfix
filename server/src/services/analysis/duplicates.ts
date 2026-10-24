import { Types } from 'mongoose';
import { embeddingText, vectorCosine, type EmbeddingProvider } from '../../ai/embeddings.js';
import { AIAnalysis, Complaint } from '../../models/index.js';
import { complaintVector, cosine } from './textSimilarity.js';

export interface DuplicateSettings {
  radiusMeters: number;
  windowDays: number;
  /** Max nearby complaints examined per run (bounds the query). */
  maxCandidates: number;
  /** Max suggestions stored. */
  maxSuggestions: number;
  /** Lexical (word-overlap) threshold, used when embeddings are off or missing. */
  minSimilarity: number;
  /** Semantic (embedding cosine) threshold. */
  minSemanticSimilarity: number;
}

export const DEFAULT_DUPLICATE_SETTINGS: DuplicateSettings = {
  radiusMeters: 150,
  windowDays: 14,
  maxCandidates: 20,
  maxSuggestions: 5,
  minSimilarity: 0.25,
  minSemanticSimilarity: 0.7,
};

export const DUPLICATE_METHOD = { provider: 'civicfix-rules', modelName: 'geo-text-cosine-v1' } as const;
export const semanticMethod = (model: string) => ({ provider: 'civicfix-rules', modelName: `geo-semantic-v2/${model}`.slice(0, 100) });

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
 * Embedding vectors for these complaints, computing and storing any that are missing or stale.
 * Text = category + latest successful AI summary (English), or the raw text before triage. Summaries
 * are preferred because raw multilingual text embeds poorly across languages.
 */
export async function ensureEmbeddings(ids: Types.ObjectId[], provider: EmbeddingProvider): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (!provider.enabled || ids.length === 0) return out;
  const docs = await Complaint.find({ _id: { $in: ids } }).select('+textEmbedding title description selectedCategory confirmedCategory').lean();
  const triages = await AIAnalysis.aggregate<{ _id: Types.ObjectId; summary?: string; category?: string }>([
    { $match: { complaint: { $in: ids }, analysisType: 'TRIAGE', status: 'SUCCEEDED' } },
    { $sort: { analysisVersion: -1 } },
    { $group: { _id: '$complaint', summary: { $first: '$summary' }, category: { $first: '$suggestedCategory' } } },
  ]);
  const triageOf = new Map(triages.map((t) => [String(t._id), t]));
  const todo: { id: Types.ObjectId; text: string; source: 'SUMMARY' | 'RAW_TEXT' }[] = [];
  for (const d of docs) {
    const t = triageOf.get(String(d._id));
    const source = t?.summary ? 'SUMMARY' : 'RAW_TEXT';
    const e = d.textEmbedding as { model?: string; source?: string; vector?: number[] } | undefined;
    if (e?.vector?.length && e.model === provider.model && (e.source === 'SUMMARY' || source === 'RAW_TEXT')) {
      out.set(String(d._id), e.vector);
      continue;
    }
    const category = d.confirmedCategory ?? t?.category ?? d.selectedCategory ?? null;
    todo.push({ id: d._id, text: embeddingText({ summary: t?.summary, category, title: d.title, description: d.description }), source });
  }
  for (let i = 0; i < todo.length; i += 64) {
    const batch = todo.slice(i, i + 64);
    const vectors = await provider.embed(batch.map((b) => b.text));
    await Promise.all(
      batch.map((b, j) => {
        out.set(String(b.id), vectors[j]!);
        return Complaint.updateOne({ _id: b.id }, { $set: { textEmbedding: { model: provider.model, source: b.source, vector: vectors[j] } } });
      }),
    );
  }
  return out;
}

/**
 * Stage 1 (database, bounded): other complaints within radiusMeters and ±windowDays, excluding
 * itself, rejected ones and reports already linked as duplicates, nearest first, at most maxCandidates.
 * Stage 2 (on ≤ maxCandidates docs): drop clearly different categories, then score meaning (embedding
 * cosine, when available for both) or wording (term cosine). Results are suggestions for a human;
 * nothing is merged or hidden.
 */
export async function findDuplicateCandidates(target: Target, settings: DuplicateSettings = DEFAULT_DUPLICATE_SETTINGS, embeddings?: EmbeddingProvider): Promise<DuplicateSuggestion[]> {
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
          duplicateOf: null,
          createdAt: { $gte: new Date(target.createdAt.getTime() - windowMs), $lte: new Date(target.createdAt.getTime() + windowMs) },
        },
      },
    },
    { $limit: settings.maxCandidates },
    { $project: { title: 1, description: 1, createdAt: 1, selectedCategory: 1, confirmedCategory: 1, distance: 1 } },
  ]);

  const category = (c: { confirmedCategory?: string | null; selectedCategory?: string | null }) => c.confirmedCategory ?? c.selectedCategory ?? null;
  const targetCategory = category(target);
  const kept = nearby.filter((c) => {
    if (c._id.equals(target._id)) return false; // never match itself
    const other = category(c);
    return !(targetCategory && other && targetCategory !== other);
  });

  const vectors = embeddings?.enabled && kept.length > 0 ? await ensureEmbeddings([target._id, ...kept.map((c) => c._id)], embeddings) : new Map<string, number[]>();
  const targetVec = vectors.get(String(target._id));
  const targetTerms = complaintVector(target);

  const scored: DuplicateSuggestion[] = [];
  for (const c of kept) {
    const otherVec = vectors.get(String(c._id));
    const semantic = targetVec && otherVec;
    const raw = semantic ? vectorCosine(targetVec, otherVec) : cosine(targetTerms, complaintVector(c));
    const similarity = Math.max(0, Math.round(raw * 1000) / 1000);
    if (similarity < (semantic ? settings.minSemanticSimilarity : settings.minSimilarity)) continue;
    const days = Math.round(Math.abs(c.createdAt.getTime() - target.createdAt.getTime()) / 86_400_000);
    scored.push({
      complaint: c._id,
      similarity,
      distanceMeters: Math.round(c.distance),
      reason: `About ${Math.round(c.distance)} m away, filed ${days === 0 ? 'the same day' : `${days} day${days === 1 ? '' : 's'} apart`}, ${semantic ? 'describes the same kind of problem' : 'similar wording'}.`,
    });
  }
  return scored.sort((a, b) => b.similarity - a.similarity).slice(0, settings.maxSuggestions);
}
