// In-app camera stamps. A photo/video taken with <CameraCapture> carries the server's camera-session
// token plus the time and GPS read on the device at the moment of capture. The stamp is kept next to the
// File (not inside it) and sent as X-Capture-* headers when the file is checked or uploaded.
// No imports: the API client uses this module, so it must not import the API back.

export interface CaptureStamp {
  token: string;
  /** ISO time on the device when the shutter was pressed (or recording started). */
  capturedAt: string;
  lat?: number;
  lng?: number;
  /** GPS accuracy in metres. */
  accuracy?: number;
}

const stamps = new WeakMap<Blob, CaptureStamp>();

export function tagCapture(file: Blob, stamp: CaptureStamp) {
  stamps.set(file, stamp);
}

export function captureOf(file: Blob): CaptureStamp | undefined {
  return stamps.get(file);
}

/** Headers for an upload/check request; empty for files that were not taken with the in-app camera. */
export function captureHeaders(file: Blob): Record<string, string> {
  const s = stamps.get(file);
  if (!s) return {};
  return {
    'X-Capture-Token': s.token,
    'X-Captured-At': s.capturedAt,
    ...(s.lat !== undefined && s.lng !== undefined ? { 'X-Capture-Lat': String(s.lat), 'X-Capture-Lng': String(s.lng) } : {}),
    ...(s.accuracy !== undefined ? { 'X-Capture-Accuracy': String(Math.round(s.accuracy)) } : {}),
  };
}
