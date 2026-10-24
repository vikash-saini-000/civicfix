import { Error as MongooseError, Types, type Document } from 'mongoose';
import type { AuthConfig } from '../src/config/env.js';

/** Test-only signing key. Not used anywhere else. */
export const testAuthConfig: AuthConfig = {
  jwtSecret: 'tst-k3y-9f2c1a7e5b8d4f60a3c2e1b7d9f0a4c6',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlDays: 7,
  cookieSecure: false,
  cookieSameSite: 'lax',
};

export const oid = () => new Types.ObjectId();

/**
 * A minimal JPEG whose APP1 EXIF block carries GPS and/or capture time, like a phone photo.
 * `littleEndian` toggles the TIFF byte order ("II" vs "MM"); a random tail keeps each file unique.
 */
export function jpegWithExif(opts: { lat?: number; lng?: number; takenAt?: string; offset?: string; littleEndian?: boolean } = {}): Buffer {
  const le = opts.littleEndian ?? true;
  const w16 = (b: Buffer, o: number, v: number) => (le ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o));
  const w32 = (b: Buffer, o: number, v: number) => (le ? b.writeUInt32LE(v, o) : b.writeUInt32BE(v, o));
  type E = { tag: number; type: number; count: number; data: Buffer };
  const ascii = (tag: number, s: string): E => ({ tag, type: 2, count: s.length + 1, data: Buffer.from(`${s}\0`, 'latin1') });
  const dms = (tag: number, deg: number): E => {
    const a = Math.abs(deg);
    const d = Math.floor(a);
    const m = Math.floor((a - d) * 60);
    const s = Math.round(((a - d) * 60 - m) * 60 * 10000);
    const data = Buffer.alloc(24);
    [d, 1, m, 1, s, 10000].forEach((v, i) => w32(data, i * 4, v));
    return { tag, type: 5, count: 3, data };
  };
  const ptr = (tag: number): E => ({ tag, type: 4, count: 1, data: Buffer.alloc(4) });

  const exif: E[] = [];
  if (opts.takenAt) exif.push(ascii(0x9003, opts.takenAt));
  if (opts.offset) exif.push(ascii(0x9011, opts.offset));
  const gps: E[] = [];
  if (opts.lat !== undefined && opts.lng !== undefined) {
    gps.push(ascii(1, opts.lat >= 0 ? 'N' : 'S'), dms(2, opts.lat), ascii(3, opts.lng >= 0 ? 'E' : 'W'), dms(4, opts.lng));
  }
  const ifd0: E[] = [];
  if (exif.length) ifd0.push(ptr(0x8769));
  if (gps.length) ifd0.push(ptr(0x8825));

  // Layout: header(8) | IFD0 | EXIF IFD | GPS IFD, each followed by its out-of-line values.
  const size = (list: E[]) => 2 + list.length * 12 + 4 + list.reduce((n, e) => n + (e.data.length > 4 ? e.data.length : 0), 0);
  const off0 = 8;
  const offExif = off0 + size(ifd0);
  const offGps = offExif + size(exif);
  const tiff = Buffer.alloc(offGps + size(gps));
  tiff.write(le ? 'II' : 'MM', 0, 'latin1');
  w16(tiff, 2, 42);
  w32(tiff, 4, off0);
  const writeIfd = (at: number, list: E[]) => {
    w16(tiff, at, list.length);
    let extra = at + 2 + list.length * 12 + 4;
    list.forEach((e, i) => {
      const p = at + 2 + i * 12;
      w16(tiff, p, e.tag);
      w16(tiff, p + 2, e.type);
      w32(tiff, p + 4, e.count);
      if (e.tag === 0x8769) w32(tiff, p + 8, offExif);
      else if (e.tag === 0x8825) w32(tiff, p + 8, offGps);
      else if (e.data.length <= 4) e.data.copy(tiff, p + 8);
      else {
        w32(tiff, p + 8, extra);
        e.data.copy(tiff, extra);
        extra += e.data.length;
      }
    });
  };
  writeIfd(off0, ifd0);
  if (exif.length) writeIfd(offExif, exif);
  if (gps.length) writeIfd(offGps, gps);

  const app1Body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(app1Body.length + 2, 2);
  // A real (decodable) 16x16 JPEG follows, with a random comment segment so each file is unique.
  const comment = Buffer.from(`civicfix-test-${Math.random()}`, 'latin1');
  const com = Buffer.alloc(4);
  com.writeUInt16BE(0xfffe, 0);
  com.writeUInt16BE(comment.length + 2, 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, app1Body, com, comment, TINY_JPEG.subarray(2)]);
}

/** A valid 16x16 grey JPEG (made with sharp), used as the image data of test photos. */
export const TINY_JPEG = Buffer.from(
  '/9j/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAQABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAH/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCYAo//2Q==',
  'base64',
);

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

/** Adds a phone-style EXIF block (GPS and/or capture time) to a real JPEG, right after its SOI marker. */
export function addExif(jpeg: Buffer, opts: { lat?: number; lng?: number; takenAt?: string; offset?: string }): Buffer {
  if (opts.lat === undefined && !opts.takenAt) return jpeg;
  const source = jpegWithExif(opts);
  const app1 = source.subarray(2, 4 + source.readUInt16BE(4));
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

/** "YYYY:MM:DD HH:MM:SS" (local time) and "+HH:MM" for EXIF, from a Date. */
export function exifTime(d: Date): { takenAt: string; offset: string } {
  const p = (n: number) => String(n).padStart(2, '0');
  const tz = -d.getTimezoneOffset();
  return {
    takenAt: `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
    offset: `${tz >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(tz) / 60))}:${p(Math.abs(tz) % 60)}`,
  };
}
