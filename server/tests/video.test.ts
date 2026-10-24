// Video evidence: ffprobe/ffmpeg helpers, the video authenticity check, and the privacy copy.
// Pure helpers always run; the rest makes real clips with ffmpeg and is skipped where ffmpeg isn't installed.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AiProvider, ImageAssessment, VideoAssessmentInput } from '../src/ai/types.js';
import { detectVideoTools, parseIso6709, parseProbe, redactionFilter, sampleTimes } from '../src/media/video.js';
import { analyzeMedia, sniffMediaType } from '../src/services/analysis/mediaAuthenticity.js';

const run = promisify(execFile);
const tools = await detectVideoTools({ ffmpegPath: process.env.FFMPEG_PATH ?? 'ffmpeg', ffprobePath: process.env.FFPROBE_PATH ?? 'ffprobe' });

const ctx = { complaintTitle: 'Garbage pile', complaintDescription: 'Garbage dumped next to the market.' };
const clean: ImageAssessment = { visualInconsistency: 'NONE_OBSERVED', inconsistencyNotes: '', relevance: 'APPEARS_RELATED', relevanceNotes: 'Shows a street.' };

function fakeProvider(answer: ImageAssessment, opts: { video?: boolean } = {}) {
  const seen: { video: VideoAssessmentInput[]; images: number } = { video: [], images: 0 };
  const meta = { provider: 'fake', model: 'fake-1', promptVersion: 'v1', latencyMs: 1 };
  const provider: AiProvider = {
    name: 'fake',
    model: 'fake-1',
    enabled: true,
    classifyComplaint: async () => {
      throw new Error('unused');
    },
    assessImage: async () => {
      seen.images++;
      return { output: answer, meta };
    },
    ...(opts.video !== false && {
      assessVideo: async (input: VideoAssessmentInput) => {
        seen.video.push(input);
        return { output: answer, meta };
      },
    }),
  };
  return { provider, seen };
}

describe('video helpers', () => {
  it('reads ISO 6709 locations written by phones', () => {
    expect(parseIso6709('+13.0072+074.7956+012.000/')).toEqual({ lat: 13.0072, lng: 74.7956 });
    expect(parseIso6709('-33.8688+151.2093/')).toEqual({ lat: -33.8688, lng: 151.2093 });
    expect(parseIso6709('+00.0000+000.0000/')).toBeUndefined();
    expect(parseIso6709('+95.0+010.0/')).toBeUndefined();
    expect(parseIso6709(undefined)).toBeUndefined();
  });

  it('parses ffprobe output: display size after rotation, tags, capture time and GPS', () => {
    const probe = parseProbe(
      JSON.stringify({
        format: { duration: '12.5', tags: { creation_time: '2026-10-24T10:00:00.000000Z', 'com.apple.quicktime.location.ISO6709': '+13.0072+074.7956/', 'com.apple.quicktime.make': 'Apple' } },
        streams: [
          { codec_type: 'video', codec_name: 'hevc', width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] },
          { codec_type: 'audio', codec_name: 'aac' },
        ],
      }),
    );
    expect(probe).toMatchObject({ durationSec: 12.5, width: 1080, height: 1920, videoCodec: 'hevc', hasAudio: true, location: { lat: 13.0072, lng: 74.7956 } });
    expect(probe.capturedAt?.toISOString()).toBe('2026-10-24T10:00:00.000Z');
    expect(probe.tags['com.apple.quicktime.make']).toBe('Apple');
  });

  it('ignores unset camera clocks and rejects files without a video track', () => {
    const base = { codec_type: 'video', width: 640, height: 360 };
    expect(parseProbe(JSON.stringify({ format: { duration: '3', tags: { creation_time: '1970-01-01T00:00:00Z' } }, streams: [base] })).capturedAt).toBeUndefined();
    expect(() => parseProbe(JSON.stringify({ format: { duration: '3' }, streams: [{ codec_type: 'audio' }] }))).toThrow(/no video track/);
    expect(() => parseProbe('not json')).toThrow();
  });

  it('spreads sample times evenly inside the clip', () => {
    expect(sampleTimes(8, 4)).toEqual([1, 3, 5, 7]);
    expect(sampleTimes(10, 1)).toEqual([5]);
  });

  it('builds a pixelation filter only for usable boxes, each limited to its time window', () => {
    expect(redactionFilter([], 640, 360)).toBeNull();
    const f = redactionFilter([{ x: 0.1, y: 0.1, width: 0.2, height: 0.2, startSec: 1, endSec: 3 }], 640, 360)!;
    expect(f).toContain('[0:v]split=2[base][c0]');
    expect(f).toContain("enable='between(t,1.000,3.000)'");
    expect(f).toMatch(/\[vout\]$/);
    expect(redactionFilter([{ x: 0.5, y: 0.5, width: 0, height: 0, startSec: 0, endSec: 1 }], 640, 360)).toBeNull();
  });
});

// Generating and encoding clips is slow on busy CI machines.
describe.skipIf(!tools.enabled)('video processing with ffmpeg', { timeout: 120_000 }, () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'civicfix-video-test-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  let n = 0;
  async function clip(opts: { seconds?: number; format?: 'mp4' | 'mov'; metadata?: Record<string, string> } = {}) {
    const out = join(dir, `clip-${n++}.${opts.format ?? 'mp4'}`);
    const meta = Object.entries(opts.metadata ?? {}).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
    await run(process.env.FFMPEG_PATH ?? 'ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=320x240:rate=15:duration=${opts.seconds ?? 4}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${opts.seconds ?? 4}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', ...meta, '-y', out,
    ]);
    return readFile(out);
  }

  it('recognises MP4 and MOV files from their bytes', async () => {
    expect(sniffMediaType(await clip())).toBe('video/mp4');
    expect(sniffMediaType(await clip({ format: 'mov' }))).toBe('video/quicktime');
  });

  it('reads length, size, capture time and GPS from a phone-style clip', async () => {
    const probe = await tools.probe(await clip({ seconds: 3, metadata: { creation_time: '2026-10-24T10:00:00Z', location: '+13.0072+074.7956/' } }));
    expect(probe.durationSec).toBeCloseTo(3, 0);
    expect(probe).toMatchObject({ width: 320, height: 240, videoCodec: 'h264', hasAudio: true, location: { lat: 13.0072, lng: 74.7956 } });
    expect(probe.capturedAt?.toISOString()).toBe('2026-10-24T10:00:00.000Z');
  });

  it('pulls frames as JPEGs, spread across the clip', async () => {
    const frames = await tools.frames(await clip({ seconds: 4 }), { count: 4, maxWidth: 160 });
    expect(frames.map((f) => f.atSec)).toEqual([0.5, 1.5, 2.5, 3.5]);
    for (const f of frames) expect(sniffMediaType(f.jpeg)).toBe('image/jpeg');
  });

  it('makes a privacy copy: MP4, same length, no GPS or capture time, regions pixelated', async () => {
    const original = await clip({ seconds: 3, format: 'mov', metadata: { creation_time: '2026-10-24T10:00:00Z', location: '+13.0072+074.7956/' } });
    const copy = await tools.redact(original, [{ x: 0.1, y: 0.1, width: 0.3, height: 0.3, startSec: 0, endSec: 10 }]);
    expect(sniffMediaType(copy)).toBe('video/mp4');
    const probe = await tools.probe(copy);
    expect(probe.durationSec).toBeCloseTo(3, 0);
    expect(probe.location).toBeUndefined();
    expect(probe.capturedAt).toBeUndefined();
    expect(copy.toString('latin1')).not.toMatch(/13\.0072/);
    // The pixelated corner differs from the original frame; the far corner stays the same.
    const [a] = await tools.frames(original, { atSec: [1], maxWidth: 320 });
    const [b] = await tools.frames(copy, { atSec: [1], maxWidth: 320 });
    expect(a!.jpeg.equals(b!.jpeg)).toBe(false);
  });

  it('refuses unreadable videos', async () => {
    const junk = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(2000, 7)]);
    await expect(tools.probe(junk)).rejects.toMatchObject({ kind: 'UNREADABLE' });
    await expect(analyzeMedia(junk, 'video/mp4', ctx, fakeProvider(clean).provider, tools)).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
  });

  it('checks a video from frames across the whole clip in one model call', async () => {
    const { provider, seen } = fakeProvider(clean);
    const result = await analyzeMedia(await clip({ seconds: 4 }), 'video/mp4', ctx, provider, tools);
    expect(result).toMatchObject({ outcome: 'NO_SUSPICIOUS_SIGNALS_DETECTED', visualModelRun: true, video: { framesChecked: 4 } });
    expect(seen.video).toHaveLength(1);
    expect(seen.video[0]!.frames.map((f) => f.atSec)).toEqual([0.5, 1.5, 2.5, 3.5]);
    expect(seen.video[0]!.durationSec).toBeCloseTo(4, 0);
  });

  it('flags generated-looking videos, and falls back to the middle frame for image-only providers', async () => {
    const strong: ImageAssessment = { ...clean, visualInconsistency: 'STRONG', inconsistencyNotes: 'Objects morph between frames.' };
    expect((await analyzeMedia(await clip(), 'video/mp4', ctx, fakeProvider(strong).provider, tools)).outcome).toBe('POTENTIAL_MANIPULATION');
    const imageOnly = fakeProvider(clean, { video: false });
    const r = await analyzeMedia(await clip(), 'video/mp4', ctx, imageOnly.provider, tools);
    expect(r).toMatchObject({ visualModelRun: true, video: { framesChecked: 1 } });
    expect(imageOnly.seen.images).toBe(1);
  });

  it('flags videos whose metadata names an AI video generator or an editing app', async () => {
    const sora = await analyzeMedia(await clip({ metadata: { comment: 'Generated with OpenAI Sora' } }), 'video/mp4', ctx, fakeProvider(clean).provider, tools);
    expect(sora.outcome).toBe('POTENTIAL_SYNTHETIC_MEDIA');
    const edited = await analyzeMedia(await clip({ metadata: { comment: 'Exported by CapCut' } }), 'video/mp4', ctx, fakeProvider({ ...clean, visualInconsistency: 'SOME' }).provider, tools);
    expect(edited.outcome).toBe('POTENTIAL_MANIPULATION');
    // "sora" only counts as a whole word.
    const word = await analyzeMedia(await clip({ metadata: { comment: 'Filmed near Sorabji Road' } }), 'video/mp4', ctx, fakeProvider(clean).provider, tools);
    expect(word.outcome).toBe('NO_SUSPICIOUS_SIGNALS_DETECTED');
  });

  it('accepts a .mov declared as MP4 and the reverse (same container family)', async () => {
    const mov = await clip({ format: 'mov' });
    expect((await analyzeMedia(mov, 'video/mp4', ctx, fakeProvider(clean).provider, tools)).mediaType).toBe('video/quicktime');
    await expect(analyzeMedia(mov, 'image/jpeg', ctx, fakeProvider(clean).provider, tools)).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
  });
});
