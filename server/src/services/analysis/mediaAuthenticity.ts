// Media authenticity signals. Answers only "are there signs this file may be synthetic or edited?".
// Videos: ffprobe tags are scanned for generator/editor names and frames sampled across the clip go
// to the visual model in one call (or the middle frame to the image check if the provider has no video check).
// It does not decide whether the complaint is true, and NO_SUSPICIOUS_SIGNALS_DETECTED is not proof
// that a file is genuine. Nothing here changes a complaint or evidence record's status.
import { AiProviderError, type AiProvider, type ImageAssessment, type AiCallMeta } from '../../ai/types.js';
import { disabledVideoTools, VideoProcessingError, type VideoProbe, type VideoTools } from '../../media/video.js';
import type { AuthenticityOutcome } from '../../models/enums.js';
import { MAX_IMAGE_BYTES, MAX_VIDEO_BYTES } from '../../models/Evidence.js';
import { AppError } from '../../utils/errors.js';

export type SupportedMediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'video/mp4' | 'video/quicktime';

export const isVideoType = (t: string | null | undefined) => t === 'video/mp4' || t === 'video/quicktime';
/** Declared and detected type agree. MP4 and QuickTime (.mov) share a container, so either label fits either. */
export const typesMatch = (sniffed: string, declared: string) => sniffed === declared || (isVideoType(sniffed) && isVideoType(declared));

/** Largest image sent to the visual model (provider limit); bigger images get metadata checks only. */
export const MAX_VISUAL_MODEL_BYTES = 5 * 1024 * 1024;
/** How much of a file the metadata scan reads from the start (and, for longer files, from the end: MP4 metadata is often written last). */
const METADATA_SCAN_BYTES = 512 * 1024;

/** Detects the real type from magic bytes. Returns null for anything unsupported. */
export function sniffMediaType(bytes: Uint8Array): SupportedMediaType | null {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return 'image/png';
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 12 && ascii(4, 8) === 'ftyp') return ascii(8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  return null;
}

export interface Signal {
  source: 'FILE_FORMAT' | 'PROVENANCE' | 'METADATA' | 'VISUAL_MODEL';
  finding: string;
  detail: string;
}

// Generator names that tools write into metadata. Presence is a hint, not proof (tags can be added or stripped).
const GENERATOR_MARKERS = [
  'midjourney', 'dall-e', 'dall·e', 'stable diffusion', 'stablediffusion', 'adobe firefly', 'imagen', 'novelai', 'leonardo.ai',
  // video generators
  'sora', 'runwayml', 'runway gen', 'pika labs', 'pika.art', 'kling', 'luma dream machine', 'lumalabs', 'google veo', 'hailuo', 'minimax video', 'synthesia', 'heygen', 'invideo ai', 'stable video diffusion',
];
const EDITOR_MARKERS = [
  'adobe photoshop', 'gimp', 'snapseed', 'lightroom', 'picsart', 'canva', 'affinity photo', 'pixelmator',
  // video editors
  'capcut', 'inshot', 'adobe premiere', 'after effects', 'davinci resolve', 'final cut', 'imovie', 'kinemaster', 'filmora', 'vn video editor', 'powerdirector', 'vita video',
];
/** Short names that only count as whole words (so "sora" doesn't match inside another word). */
const WORD_ONLY = new Set(['sora', 'kling', 'hailuo', 'imagen']);
const findMarker = (text: string, markers: string[]) =>
  markers.find((m) => (WORD_ONLY.has(m) ? new RegExp(`(^|[^a-z])${m}([^a-z]|$)`).test(text) : text.includes(m)));
// IPTC digital source types for algorithmic media.
const IPTC_SYNTHETIC = ['trainedalgorithmicmedia', 'compositesynthetic', 'algorithmicmedia', 'compositewithtrainedalgorithmicmedia'];

/** Provenance + metadata signals from the raw bytes. Never reads the network. */
export function inspectMetadata(bytes: Uint8Array, extraText = ''): { provenance: 'NOT_PRESENT' | 'PRESENT_UNVERIFIED'; signals: Signal[] } {
  const head = Buffer.from(bytes.subarray(0, METADATA_SCAN_BYTES)).toString('latin1');
  const tail = bytes.length > METADATA_SCAN_BYTES ? Buffer.from(bytes.subarray(Math.max(METADATA_SCAN_BYTES, bytes.length - METADATA_SCAN_BYTES))).toString('latin1') : '';
  const text = `${head}\n${tail}\n${extraText}`.toLowerCase();
  const signals: Signal[] = [];

  // C2PA manifests are stored in JUMBF boxes labelled "c2pa". We detect presence only: verifying the
  // signature chain needs a C2PA library, which isn't integrated, so we never report "verified".
  const hasC2pa = text.includes('c2pa') && (text.includes('jumb') || text.includes('jumd'));
  if (hasC2pa) {
    signals.push({ source: 'PROVENANCE', finding: 'c2pa_manifest_present', detail: 'Content credentials are present but were not cryptographically verified.' });
  }
  const iptc = IPTC_SYNTHETIC.find((m) => text.includes(m));
  if (iptc) {
    signals.push({ source: 'METADATA', finding: 'declared_ai_generated', detail: `Metadata declares the digital source type "${iptc}".` });
  }
  const generator = findMarker(text, GENERATOR_MARKERS);
  if (generator) signals.push({ source: 'METADATA', finding: 'generator_tag', detail: `Metadata mentions "${generator}".` });
  const editor = findMarker(text, EDITOR_MARKERS);
  if (editor) signals.push({ source: 'METADATA', finding: 'editor_tag', detail: `Metadata mentions editing software "${editor}". Editing is common and not suspicious by itself.` });

  return { provenance: hasC2pa ? 'PRESENT_UNVERIFIED' : 'NOT_PRESENT', signals };
}

export interface AuthenticityResult {
  mediaType: SupportedMediaType;
  outcome: AuthenticityOutcome;
  provenance: 'NOT_PRESENT' | 'PRESENT_UNVERIFIED';
  signals: Signal[];
  visualModelRun: boolean;
  explanation: string;
  reviewRecommended: boolean;
  relevance?: { assessment: ImageAssessment['relevance']; explanation: string };
  modelMeta?: AiCallMeta;
  visualErrorCode?: string;
  /** Videos only: what was read from the file (when ffmpeg is available). */
  video?: { durationSec: number; framesChecked: number; probe: VideoProbe };
}

/** Frames sampled across a video for the authenticity check (one model call). */
export const VIDEO_CHECK_FRAMES = 4;

/**
 * Combines signals cautiously:
 *   declared AI / generator tag                         -> POTENTIAL_SYNTHETIC_MEDIA
 *   strong visual inconsistency                         -> POTENTIAL_MANIPULATION
 *   editor tag + some visual inconsistency              -> POTENTIAL_MANIPULATION
 *   visual model ran, saw nothing, no metadata signals  -> NO_SUSPICIOUS_SIGNALS_DETECTED
 *   anything else (incl. visual model not run/failed)   -> INCONCLUSIVE
 * Missing provenance or metadata is never treated as suspicious.
 */
export function combineSignals(signals: Signal[], visual: ImageAssessment | null): Pick<AuthenticityResult, 'outcome' | 'explanation' | 'reviewRecommended'> {
  const has = (finding: string) => signals.some((s) => s.finding === finding);
  if (has('declared_ai_generated') || has('generator_tag')) {
    return { outcome: 'POTENTIAL_SYNTHETIC_MEDIA', reviewRecommended: true, explanation: 'File metadata indicates the image may have been produced by an AI generator. A reviewer should check it.' };
  }
  if (visual?.visualInconsistency === 'STRONG') {
    return { outcome: 'POTENTIAL_MANIPULATION', reviewRecommended: true, explanation: 'The visual check noted strong signs of alteration or generation. This is not proof; a reviewer should check it.' };
  }
  if (has('editor_tag') && visual?.visualInconsistency === 'SOME') {
    return { outcome: 'POTENTIAL_MANIPULATION', reviewRecommended: true, explanation: 'The file was saved by editing software and the visual check noted some inconsistencies.' };
  }
  if (visual?.visualInconsistency === 'NONE_OBSERVED' && signals.length === 0) {
    return { outcome: 'NO_SUSPICIOUS_SIGNALS_DETECTED', reviewRecommended: false, explanation: 'No suspicious signals were found. This does not prove the image is genuine.' };
  }
  return {
    outcome: 'INCONCLUSIVE',
    reviewRecommended: false,
    explanation: visual ? 'Signals were mixed or weak; no conclusion can be drawn.' : 'Only file metadata could be checked; no conclusion can be drawn.',
  };
}

/** Fields stored on the AIAnalysis record for a finished authenticity check. */
export function mediaRecordFields(result: AuthenticityResult) {
  return {
    provider: result.modelMeta?.provider ?? 'civicfix-rules',
    modelName: result.modelMeta?.model ?? 'metadata-v1',
    promptVersion: result.modelMeta?.promptVersion,
    latencyMs: result.modelMeta?.latencyMs,
    usage: { inputTokens: result.modelMeta?.inputTokens, outputTokens: result.modelMeta?.outputTokens },
    errorCode: result.visualErrorCode ?? null,
    authenticity: {
      outcome: result.outcome,
      provenance: result.provenance,
      signals: result.signals,
      visualModelRun: result.visualModelRun,
      explanation: result.explanation,
      reviewRecommended: result.reviewRecommended,
    },
    relevance: result.relevance,
    reviewRecommended: result.reviewRecommended,
  };
}

/**
 * Analyses one media file. `declaredType` is what the uploader claimed; the real type is sniffed
 * from the bytes and must match. Throws a 400-style AppError for unsupported, unreadable or oversized files.
 * Videos need `video` tools (ffmpeg); without them only file metadata is checked.
 */
export async function analyzeMedia(
  bytes: Uint8Array,
  declaredType: string,
  context: { complaintTitle: string; complaintDescription: string },
  provider: AiProvider,
  video: VideoTools = disabledVideoTools,
): Promise<AuthenticityResult> {
  const mediaType = sniffMediaType(bytes);
  if (!mediaType) throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'The file is not a supported image or video.');
  if (!typesMatch(mediaType, declaredType)) throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'The file content does not match its declared type.');
  const max = isVideoType(mediaType) ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (bytes.length > max) throw new AppError('PAYLOAD_TOO_LARGE', 'The file is larger than the allowed size.');

  if (isVideoType(mediaType)) return analyzeVideo(bytes, mediaType, context, provider, video);

  const { provenance, signals } = inspectMetadata(bytes);

  let visual: ImageAssessment | null = null;
  let modelMeta: AiCallMeta | undefined;
  let visualErrorCode: string | undefined;
  if (bytes.length > MAX_VISUAL_MODEL_BYTES) {
    visualErrorCode = 'TOO_LARGE_FOR_VISUAL_MODEL';
  } else if (provider.enabled) {
    try {
      const res = await provider.assessImage({ mediaType: mediaType as 'image/jpeg' | 'image/png' | 'image/webp', base64: Buffer.from(bytes).toString('base64'), ...context });
      visual = res.output;
      modelMeta = res.meta;
      addVisualSignal(signals, visual);
    } catch (err) {
      // A failed detector says nothing about the file either way.
      visualErrorCode = err instanceof AiProviderError ? err.kind : 'VISUAL_MODEL_ERROR';
    }
  } else {
    visualErrorCode = 'NOT_CONFIGURED';
  }

  return {
    mediaType,
    provenance,
    signals,
    visualModelRun: visual !== null,
    ...combineSignals(signals, visual),
    relevance: visual ? { assessment: visual.relevance, explanation: visual.relevanceNotes.slice(0, 400) } : undefined,
    modelMeta,
    visualErrorCode,
  };
}

function addVisualSignal(signals: Signal[], visual: ImageAssessment) {
  if (visual.visualInconsistency === 'NONE_OBSERVED') return;
  signals.push({
    source: 'VISUAL_MODEL',
    finding: visual.visualInconsistency === 'STRONG' ? 'visual_inconsistency_strong' : 'visual_inconsistency_some',
    detail: visual.inconsistencyNotes.slice(0, 300),
  });
}

async function analyzeVideo(
  bytes: Uint8Array,
  mediaType: SupportedMediaType,
  context: { complaintTitle: string; complaintDescription: string },
  provider: AiProvider,
  tools: VideoTools,
): Promise<AuthenticityResult> {
  if (!tools.enabled) {
    const { provenance, signals } = inspectMetadata(bytes);
    return { mediaType, provenance, signals, visualModelRun: false, ...combineSignals(signals, null), visualErrorCode: 'VIDEO_TOOLS_UNAVAILABLE' };
  }
  let probe: VideoProbe;
  try {
    probe = await tools.probe(bytes);
  } catch (err) {
    if (err instanceof VideoProcessingError && err.kind === 'UNREADABLE') {
      throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'The video could not be read. Upload an MP4 or MOV recorded by a phone or camera.');
    }
    throw err;
  }
  // Container/stream tags (encoder, handler, software, make/model) can name the tool that made the file.
  const tagText = Object.entries(probe.tags)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const { provenance, signals } = inspectMetadata(bytes, tagText);

  let visual: ImageAssessment | null = null;
  let modelMeta: AiCallMeta | undefined;
  let visualErrorCode: string | undefined;
  let framesChecked = 0;
  if (!provider.enabled) {
    visualErrorCode = 'NOT_CONFIGURED';
  } else {
    try {
      const frames = await tools.frames(bytes, { count: VIDEO_CHECK_FRAMES, maxWidth: 1024 });
      const images = frames.map((f) => ({ mediaType: 'image/jpeg' as const, base64: f.jpeg.toString('base64') }));
      const res = provider.assessVideo
        ? await provider.assessVideo({ frames: images.map((img, i) => ({ ...img, atSec: frames[i]!.atSec })), durationSec: probe.durationSec, ...context })
        : await provider.assessImage({ ...images[Math.floor(images.length / 2)]!, ...context });
      framesChecked = provider.assessVideo ? images.length : 1;
      visual = res.output;
      modelMeta = res.meta;
      addVisualSignal(signals, visual);
    } catch (err) {
      visualErrorCode = err instanceof AiProviderError ? err.kind : err instanceof VideoProcessingError ? `VIDEO_${err.kind}` : 'VISUAL_MODEL_ERROR';
    }
  }

  return {
    mediaType,
    provenance,
    signals,
    visualModelRun: visual !== null,
    ...combineSignals(signals, visual),
    relevance: visual ? { assessment: visual.relevance, explanation: visual.relevanceNotes.slice(0, 400) } : undefined,
    modelMeta,
    visualErrorCode,
    video: { durationSec: probe.durationSec, framesChecked, probe },
  };
}
