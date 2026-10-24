// Video processing with ffmpeg / ffprobe (external binaries, found on PATH or set with FFMPEG_PATH /
// FFPROBE_PATH). Used to read a video's details, pull still frames for the AI checks, and make the
// privacy copy. Every call works on a private temp folder that is removed afterwards, runs with a
// timeout, and never goes through a shell.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface VideoProbe {
  durationSec: number;
  /** Display size: width/height after the rotation phones record in metadata. */
  width: number;
  height: number;
  videoCodec: string | null;
  hasAudio: boolean;
  /** Container and stream tags, keys lower-cased (e.g. encoder, creation_time, com.apple.quicktime.make). */
  tags: Record<string, string>;
  capturedAt?: Date;
  location?: { lat: number; lng: number };
}

export interface VideoFrame {
  atSec: number;
  jpeg: Buffer;
}

/** A box (relative 0-1, like image redaction) hidden from `startSec` to `endSec`. */
export interface TimedRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  startSec: number;
  endSec: number;
}

export interface VideoTools {
  readonly enabled: boolean;
  /** e.g. "ffmpeg 8.0.1"; null when disabled. */
  readonly version: string | null;
  probe(bytes: Uint8Array): Promise<VideoProbe>;
  /** `count` frames spread evenly over the video (or at the given times), as JPEGs at most `maxWidth` wide. */
  frames(bytes: Uint8Array, opts: { count?: number; atSec?: number[]; maxWidth?: number }): Promise<VideoFrame[]>;
  /** Shareable MP4: all metadata removed, the given regions pixelated. */
  redact(bytes: Uint8Array, regions: TimedRegion[]): Promise<Buffer>;
  /** Re-encodes any readable video (e.g. a browser's WebM recording) as H.264/AAC MP4. */
  toMp4(bytes: Uint8Array): Promise<Buffer>;
}

export class VideoProcessingError extends Error {
  constructor(
    readonly kind: 'UNAVAILABLE' | 'UNREADABLE' | 'TIMEOUT' | 'FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'VideoProcessingError';
  }
}

const unavailable = async (): Promise<never> => {
  throw new VideoProcessingError('UNAVAILABLE', 'Video processing (ffmpeg) is not available.');
};
export const disabledVideoTools: VideoTools = { enabled: false, version: null, probe: unavailable, frames: unavailable, redact: unavailable, toMp4: unavailable };

export interface VideoToolsConfig {
  ffmpegPath: string;
  ffprobePath: string;
  /** Per ffmpeg/ffprobe run. */
  timeoutMs?: number;
}

/** Pixelation block size relative to the region, as for images. */
const BLOCKS = 10;
/** Extra margin around each box: bigger than for photos because people move between sampled frames. */
const MARGIN = 0.3;
/** Most pixelated regions in one video, to keep the filter graph and encode time bounded. */
export const MAX_VIDEO_REGIONS = 60;

function run(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const e = err as NodeJS.ErrnoException & { killed?: boolean };
      if (e.code === 'ENOENT') return reject(new VideoProcessingError('UNAVAILABLE', `${bin} was not found.`));
      if (e.killed) return reject(new VideoProcessingError('TIMEOUT', 'Video processing took too long.'));
      reject(new VideoProcessingError('UNREADABLE', String(stderr || e.message).slice(0, 300)));
    });
  });
}

async function withTempFile<T>(bytes: Uint8Array, fn: (dir: string, input: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'civicfix-video-'));
  try {
    const input = join(dir, 'input');
    await writeFile(input, bytes);
    return await fn(dir, input);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** ISO 6709 as written by phones, e.g. "+13.0072+074.7956+012.000/". */
export function parseIso6709(value: string | undefined): { lat: number; lng: number } | undefined {
  const m = value?.match(/^([+-]\d{1,2}(?:\.\d+)?)([+-]\d{1,3}(?:\.\d+)?)/);
  if (!m) return undefined;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return undefined;
  return { lat, lng };
}

/** Reads ffprobe's JSON into a VideoProbe. Exported for tests. */
export function parseProbe(json: string): VideoProbe {
  let data: any;
  try {
    data = JSON.parse(json);
  } catch {
    throw new VideoProcessingError('UNREADABLE', 'ffprobe returned invalid output.');
  }
  const streams: any[] = Array.isArray(data?.streams) ? data.streams : [];
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  if (!video) throw new VideoProcessingError('UNREADABLE', 'The file has no video track.');
  const tags: Record<string, string> = {};
  for (const src of [data?.format?.tags, video.tags, ...streams.map((s) => s.tags)]) {
    for (const [k, v] of Object.entries(src ?? {})) if (typeof v === 'string' && !(k.toLowerCase() in tags)) tags[k.toLowerCase()] = v;
  }
  const rotationSide = (video.side_data_list ?? []).find((d: any) => typeof d.rotation === 'number')?.rotation;
  const rotation = Math.abs(Number(rotationSide ?? video.tags?.rotate ?? 0)) % 180;
  let width = Number(video.width) || 0;
  let height = Number(video.height) || 0;
  if (rotation === 90) [width, height] = [height, width];
  const durationSec = Number(data?.format?.duration ?? video.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0 || width <= 0 || height <= 0) throw new VideoProcessingError('UNREADABLE', 'The video has no readable frames.');
  const created = tags['com.apple.quicktime.creationdate'] ?? tags['creation_time'];
  const capturedAt = created ? new Date(created) : undefined;
  return {
    durationSec,
    width,
    height,
    videoCodec: typeof video.codec_name === 'string' ? video.codec_name : null,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
    tags,
    // 1970/1904 epochs are what cameras write when the clock was never set.
    capturedAt: capturedAt && !Number.isNaN(capturedAt.getTime()) && capturedAt.getUTCFullYear() > 2000 ? capturedAt : undefined,
    location: parseIso6709(tags['com.apple.quicktime.location.iso6709'] ?? tags['location'] ?? tags['location-eng']),
  };
}

/** Evenly spread sample times, away from the very first and last frame. */
export function sampleTimes(durationSec: number, count: number): number[] {
  const n = Math.max(1, Math.floor(count));
  return Array.from({ length: n }, (_, i) => Math.round(((i + 0.5) / n) * durationSec * 1000) / 1000);
}

/** ffmpeg filter graph that pixelates each region during its time window. Exported for tests. */
export function redactionFilter(regions: TimedRegion[], width: number, height: number): string | null {
  const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
  const parts: string[] = [];
  const boxes: { x: number; y: number; w: number; h: number; s: number; e: number }[] = [];
  for (const r of regions.slice(0, MAX_VIDEO_REGIONS)) {
    const mx = r.width * MARGIN;
    const my = r.height * MARGIN;
    const left = Math.max(0, Math.floor((r.x - mx) * width));
    const top = Math.max(0, Math.floor((r.y - my) * height));
    const right = Math.min(width, Math.ceil((r.x + r.width + mx) * width));
    const bottom = Math.min(height, Math.ceil((r.y + r.height + my) * height));
    const w = even(right - left);
    const h = even(bottom - top);
    if (right - left < 2 || bottom - top < 2 || left + w > width || top + h > height) continue;
    boxes.push({ x: left, y: top, w, h, s: Math.max(0, r.startSec), e: Math.max(r.startSec, r.endSec) });
  }
  if (boxes.length === 0) return null;
  parts.push(`[0:v]split=${boxes.length + 1}[base]${boxes.map((_, i) => `[c${i}]`).join('')}`);
  boxes.forEach((b, i) => {
    const small = Math.max(1, Math.round(Math.min(b.w, b.h) / BLOCKS));
    parts.push(`[c${i}]crop=${b.w}:${b.h}:${b.x}:${b.y},scale=${Math.max(1, Math.round(b.w / small))}:${Math.max(1, Math.round(b.h / small))}:flags=neighbor,scale=${b.w}:${b.h}:flags=neighbor[p${i}]`);
  });
  let prev = 'base';
  boxes.forEach((b, i) => {
    const out = i === boxes.length - 1 ? 'vout' : `v${i}`;
    parts.push(`[${prev}][p${i}]overlay=${b.x}:${b.y}:enable='between(t,${b.s.toFixed(3)},${b.e.toFixed(3)})'[${out}]`);
    prev = out;
  });
  return parts.join(';');
}

export function createFfmpegVideoTools(config: VideoToolsConfig, version: string | null = null): VideoTools {
  const timeoutMs = config.timeoutMs ?? 90_000;

  async function probeFile(input: string): Promise<VideoProbe> {
    const out = await run(config.ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input], timeoutMs);
    return parseProbe(out);
  }

  return {
    enabled: true,
    version,
    probe: (bytes) => withTempFile(bytes, (_dir, input) => probeFile(input)),

    frames: (bytes, opts) =>
      withTempFile(bytes, async (dir, input) => {
        const info = await probeFile(input);
        const maxWidth = Math.max(64, Math.floor(opts.maxWidth ?? 1024));
        const times = (opts.atSec ?? sampleTimes(info.durationSec, opts.count ?? 4)).map((t) => Math.min(Math.max(0, t), Math.max(0, info.durationSec - 0.05)));
        const frames: VideoFrame[] = [];
        for (const [i, t] of times.entries()) {
          const out = join(dir, `frame-${i}.jpg`);
          // Input seeking (-ss before -i) is fast and frame-accurate in current ffmpeg. Rotation is applied automatically.
          await run(config.ffmpegPath, ['-v', 'error', '-nostdin', '-ss', t.toFixed(3), '-i', input, '-frames:v', '1', '-vf', `scale='min(${maxWidth},iw)':-2`, '-q:v', '3', '-f', 'image2', '-y', out], timeoutMs);
          const jpeg = await readFile(out).catch(() => null);
          if (jpeg && jpeg.length > 0) frames.push({ atSec: t, jpeg });
        }
        if (frames.length === 0) throw new VideoProcessingError('UNREADABLE', 'No frames could be read from the video.');
        return frames;
      }),

    redact: (bytes, regions) =>
      withTempFile(bytes, async (dir, input) => {
        const info = await probeFile(input);
        const out = join(dir, 'shared.mp4');
        const filter = redactionFilter(regions, info.width, info.height);
        const video = filter ? ['-filter_complex', filter, '-map', '[vout]'] : ['-map', '0:v:0'];
        await run(
          config.ffmpegPath,
          [
            '-v', 'error', '-nostdin', '-i', input,
            ...video,
            '-map', '0:a:0?',
            // No metadata, chapters, or encoder tags in the copy (GPS, device, time all live there).
            '-map_metadata', '-1', '-map_chapters', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact',
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '96k',
            '-movflags', '+faststart',
            '-y', out,
          ],
          timeoutMs * 2,
        );
        return readFile(out);
      }),

    toMp4: (bytes) =>
      withTempFile(bytes, async (dir, input) => {
        const out = join(dir, 'converted.mp4');
        await run(
          config.ffmpegPath,
          ['-v', 'error', '-nostdin', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', out],
          timeoutMs * 2,
        );
        return readFile(out);
      }),
  };
}

/** True for a WebM/Matroska file (EBML header), as recorded by Chrome/Firefox MediaRecorder. */
export function isWebm(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
}

/** Uses ffmpeg/ffprobe if both run; otherwise video processing is off and videos get metadata-only checks. */
export async function detectVideoTools(config: VideoToolsConfig): Promise<VideoTools> {
  try {
    const [ffmpeg] = await Promise.all([run(config.ffmpegPath, ['-hide_banner', '-version'], 10_000), run(config.ffprobePath, ['-hide_banner', '-version'], 10_000)]);
    const version = ffmpeg.match(/ffmpeg version (\S+)/)?.[1] ?? 'unknown';
    return createFfmpegVideoTools(config, `ffmpeg ${version}`);
  } catch {
    return disabledVideoTools;
  }
}
