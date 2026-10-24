// Rule-based spam signals, computed when a complaint is submitted. The result is a flag for humans
// (review reason SPAM_SUSPECTED): nothing is rejected or hidden automatically, and the citizen sees no
// difference. The triage model adds its own judgement (spamLikely) separately.
import { Types } from 'mongoose';
import { Complaint } from '../models/index.js';
import { complaintVector, cosine } from './analysis/textSimilarity.js';

export interface SpamPolicy {
  version: string;
  /** Score at or above which the complaint is flagged for a human. */
  flagAt: number;
  /** Complaints by the same citizen within one hour that count as a burst. */
  burstPerHour: number;
  /**
   * Lexical similarity to one of the citizen's own recent complaints, filed within repeatMeters of this
   * one, that counts as a repeat. (The same wording at different places is a reused template, not spam.)
   */
  repeatSimilarity: number;
  repeatMeters: number;
  repeatWindowDays: number;
}

export const DEFAULT_SPAM_POLICY: SpamPolicy = { version: 'spam-v1', flagAt: 0.6, burstPerHour: 5, repeatSimilarity: 0.9, repeatMeters: 500, repeatWindowDays: 7 };

/** Great-circle distance in metres between [lng, lat] points. */
function metersBetween(a: number[], b: number[]): number {
  const rad = Math.PI / 180;
  const dLat = (b[1]! - a[1]!) * rad;
  const dLng = (b[0]! - a[0]!) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1]! * rad) * Math.cos(b[1]! * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

const WEIGHTS: Record<string, number> = {
  contains_link: 0.45,
  contains_phone_number: 0.3,
  promotional_language: 0.45,
  repeated_text: 0.6,
  submission_burst: 0.4,
  gibberish: 0.6,
  excessive_caps_or_symbols: 0.2,
};

const LINK = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|in|net|org|xyz|top|biz|info|io|co)\b/i;
// 10-digit Indian mobile numbers (optionally +91), or any 10+ digit run.
const PHONE = /(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b|\b\d{10,}\b/;
const PROMO = /\b(?:buy now|discount|offer|cashback|earn (?:money|rs)|work from home|loan|lottery|crypto|bitcoin|casino|betting|whatsapp me|call now|free gift|click here|subscribe|follow me|dm me)\b/i;

/** Long runs of one character, keyboard mashing, or text with almost no vowels (Latin script only). */
function looksLikeGibberish(text: string): boolean {
  if (/(.)\1{6,}/.test(text)) return true;
  if (/\b(?:asdf|qwer|zxcv|hjkl|jkjk|lol{3,})\w*/i.test(text)) return true;
  const latin = text.replace(/[^a-z]/gi, '');
  if (latin.length >= 20 && latin.length / Math.max(1, text.replace(/\s/g, '').length) > 0.8) {
    const vowels = (latin.match(/[aeiou]/gi) ?? []).length / latin.length;
    if (vowels < 0.18) return true;
  }
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length >= 8 && new Set(words).size / words.length < 0.3) return true;
  return false;
}

export interface SpamCheck {
  score: number;
  signals: string[];
  flagged: boolean;
}

/** Signals from the text alone (no database). */
export function textSignals(title: string, description: string): string[] {
  const text = `${title}\n${description}`;
  const out: string[] = [];
  if (LINK.test(text)) out.push('contains_link');
  if (PHONE.test(text)) out.push('contains_phone_number');
  if (PROMO.test(text)) out.push('promotional_language');
  if (looksLikeGibberish(text)) out.push('gibberish');
  const letters = text.replace(/[^a-z]/gi, '');
  const symbols = text.replace(/[\p{L}\p{N}\s.,'"()-]/gu, '');
  if ((letters.length >= 20 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.7) || symbols.length / Math.max(1, text.length) > 0.25) out.push('excessive_caps_or_symbols');
  return out;
}

export function scoreSignals(signals: string[], policy: SpamPolicy = DEFAULT_SPAM_POLICY): SpamCheck {
  // Combine as independent evidence: 1 - Π(1 - w).
  const score = Math.round((1 - signals.reduce((p, s) => p * (1 - (WEIGHTS[s] ?? 0.2)), 1)) * 100) / 100;
  return { score, signals, flagged: score >= policy.flagAt };
}

/** Text signals plus the citizen's own recent activity. */
export async function checkSpam(
  citizen: Types.ObjectId | string,
  input: { title: string; description: string; location?: { coordinates: number[] } },
  policy: SpamPolicy = DEFAULT_SPAM_POLICY,
): Promise<SpamCheck> {
  const signals = textSignals(input.title, input.description);
  const now = Date.now();
  const [lastHour, recent] = await Promise.all([
    Complaint.countDocuments({ citizen, createdAt: { $gte: new Date(now - 3_600_000) } }),
    Complaint.find({ citizen, createdAt: { $gte: new Date(now - policy.repeatWindowDays * 86_400_000) } })
      .sort({ createdAt: -1 })
      .limit(20)
      .select('title description location')
      .lean(),
  ]);
  if (lastHour >= policy.burstPerHour) signals.push('submission_burst');
  const vec = complaintVector(input);
  const near = (r: { location?: { coordinates: number[] } | null }) =>
    !input.location || !r.location || metersBetween(input.location.coordinates, r.location.coordinates) <= policy.repeatMeters;
  if (recent.some((r) => near(r) && cosine(vec, complaintVector(r)) >= policy.repeatSimilarity)) signals.push('repeated_text');
  return scoreSignals(signals, policy);
}
