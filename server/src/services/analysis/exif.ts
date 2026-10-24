// Minimal, bounds-checked EXIF reader for JPEG: capture time and GPS position only.
// The values come from the uploader's file, so they are hints for consistency checks, never proof.
// Phones and browsers often strip GPS, so "no location" is common and must be handled as unknown.

export interface CaptureMetadata {
  capturedAt?: Date;
  location?: { lat: number; lng: number };
}

const SCAN_LIMIT = 512 * 1024;
const MAX_ENTRIES = 256;

const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_OFFSET_TIME_ORIGINAL = 0x9011;
const GPS_LAT_REF = 1;
const GPS_LAT = 2;
const GPS_LNG_REF = 3;
const GPS_LNG = 4;

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

interface Entry {
  type: number;
  count: number;
  /** Absolute offset of the value bytes inside the buffer. */
  at: number;
}

/** Reads capture time and GPS from a JPEG's EXIF block. Returns {} for anything missing or malformed. */
export function readCaptureMetadata(bytes: Uint8Array): CaptureMetadata {
  try {
    const tiff = findTiff(bytes.subarray(0, Math.min(bytes.length, SCAN_LIMIT)));
    return tiff ? parseTiff(tiff) : {};
  } catch {
    return {}; // malformed metadata is simply ignored
  }
}

/** Locates the TIFF block inside the JPEG APP1 "Exif" segment. */
function findTiff(b: Uint8Array): Uint8Array | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / start of scan: no more metadata
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    if (len < 2 || i + 2 + len > b.length) return null;
    if (marker === 0xe1 && len >= 8 && String.fromCharCode(...b.subarray(i + 4, i + 10)) === 'Exif\0\0') {
      return b.subarray(i + 10, i + 2 + len);
    }
    i += 2 + len;
  }
  return null;
}

function parseTiff(t: Uint8Array): CaptureMetadata {
  if (t.length < 8) return {};
  const order = String.fromCharCode(t[0]!, t[1]!);
  if (order !== 'II' && order !== 'MM') return {};
  const le = order === 'II';
  const view = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const u16 = (o: number) => view.getUint16(o, le);
  const u32 = (o: number) => view.getUint32(o, le);
  if (u16(2) !== 42) return {};

  const readIfd = (offset: number): Map<number, Entry> => {
    const out = new Map<number, Entry>();
    if (offset < 8 || offset + 2 > t.length) return out;
    const n = Math.min(u16(offset), MAX_ENTRIES);
    for (let k = 0; k < n; k++) {
      const e = offset + 2 + k * 12;
      if (e + 12 > t.length) break;
      const type = u16(e + 2);
      const count = u32(e + 4);
      const size = (TYPE_SIZE[type] ?? 0) * count;
      if (size === 0) continue;
      const at = size <= 4 ? e + 8 : u32(e + 8);
      if (at + size > t.length) continue; // points outside the block: ignore
      out.set(u16(e), { type, count, at });
    }
    return out;
  };
  const ascii = (e?: Entry) => (e && e.type === 2 ? String.fromCharCode(...t.subarray(e.at, e.at + e.count)).replace(/\0+$/, '') : undefined);
  const pointer = (e?: Entry) => (e && e.type === 4 && e.count === 1 ? u32(e.at) : undefined);
  const rationals = (e?: Entry) => {
    if (!e || e.type !== 5 || e.count < 3) return undefined;
    const out: number[] = [];
    for (let k = 0; k < 3; k++) {
      const den = u32(e.at + k * 8 + 4);
      if (den === 0) return undefined;
      out.push(u32(e.at + k * 8) / den);
    }
    return out;
  };

  const ifd0 = readIfd(u32(4));
  const result: CaptureMetadata = {};

  const exifPtr = pointer(ifd0.get(TAG_EXIF_IFD));
  if (exifPtr !== undefined) {
    const exif = readIfd(exifPtr);
    const when = parseExifDate(ascii(exif.get(TAG_DATETIME_ORIGINAL)), ascii(exif.get(TAG_OFFSET_TIME_ORIGINAL)));
    if (when) result.capturedAt = when;
  }

  const gpsPtr = pointer(ifd0.get(TAG_GPS_IFD));
  if (gpsPtr !== undefined) {
    const gps = readIfd(gpsPtr);
    const lat = toDegrees(rationals(gps.get(GPS_LAT)), ascii(gps.get(GPS_LAT_REF)), 'N', 'S', 90);
    const lng = toDegrees(rationals(gps.get(GPS_LNG)), ascii(gps.get(GPS_LNG_REF)), 'E', 'W', 180);
    // 0,0 is what many devices write when they had no fix.
    if (lat !== undefined && lng !== undefined && !(lat === 0 && lng === 0)) result.location = { lat, lng };
  }
  return result;
}

function toDegrees(dms: number[] | undefined, ref: string | undefined, pos: string, neg: string, max: number): number | undefined {
  if (!dms || (ref !== pos && ref !== neg)) return undefined;
  const [d, m, s] = dms as [number, number, number];
  if (m >= 60 || s >= 60) return undefined;
  const value = (d + m / 60 + s / 3600) * (ref === neg ? -1 : 1);
  return Number.isFinite(value) && Math.abs(value) <= max ? Math.round(value * 1e7) / 1e7 : undefined;
}

/**
 * "YYYY:MM:DD HH:MM:SS" plus an optional "+05:30" offset. Without an offset the camera's time zone is
 * unknown, so the value is read as UTC and callers must allow for up to ±14 hours.
 */
function parseExifDate(value: string | undefined, offset: string | undefined): Date | undefined {
  const m = value && /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m.map(Number) as number[];
  let ms = Date.UTC(y!, mo! - 1, d!, h!, mi!, s!);
  const check = new Date(ms);
  if (check.getUTCMonth() !== mo! - 1 || check.getUTCDate() !== d! || h! > 23 || mi! > 59 || s! > 59) return undefined;
  const off = offset && /^([+-])(\d{2}):(\d{2})$/.exec(offset.trim());
  if (off) ms -= (off[1] === '-' ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3])) * 60_000;
  const when = new Date(ms);
  // Reject impossible values: before digital cameras were common, or more than a day in the future.
  if (when.getUTCFullYear() < 2000 || when.getTime() > Date.now() + 86_400_000) return undefined;
  return when;
}

/** Great-circle distance in metres. */
export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}
