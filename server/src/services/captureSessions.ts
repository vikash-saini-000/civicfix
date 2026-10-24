// In-app camera sessions. When the app opens the camera it asks for a short-lived token, signed by the
// server and bound to the user. Every photo/video taken in that session is uploaded with the token and
// the time + GPS read on the device at the moment of capture. The server checks the signature, the
// user, and that the capture time falls inside the session window.
//
// This raises the bar (normal users can only use the live camera; old gallery photos can't be claimed
// as "taken now"), but it is not proof: a determined person can still script the API. The AI
// authenticity check runs on every file regardless.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from '../utils/errors.js';

export interface CaptureSession {
  token: string;
  expiresAt: Date;
}

/** What the client sends with a captured file (from X-Capture-* headers). */
export interface CaptureStampInput {
  token?: string;
  capturedAt?: string;
  lat?: string;
  lng?: string;
  accuracy?: string;
}

/** A verified camera stamp, stored on the evidence. */
export interface CaptureStamp {
  capturedAt: Date;
  location?: { lat: number; lng: number };
  accuracyM?: number;
}

/** Allowed clock difference between the phone and the server. */
const CLOCK_SKEW_MS = 2 * 60_000;
/** GPS fixes worse than this are kept as "no location" (too vague for the 50 m check). */
const MAX_ACCURACY_M = 500;

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function createCaptureSessions(opts: { secret: string; ttlSeconds: number; now?: () => number }) {
  // A separate key from the JWT signing key, derived from the same secret.
  const key = createHmac('sha256', opts.secret).update('civicfix:capture-session:v1').digest();
  const now = opts.now ?? Date.now;
  const sign = (payload: string) => createHmac('sha256', key).update(payload).digest();

  return {
    ttlSeconds: opts.ttlSeconds,

    start(userId: string): CaptureSession {
      const iat = now();
      const exp = iat + opts.ttlSeconds * 1000;
      const payload = b64(JSON.stringify({ u: userId, n: randomBytes(9).toString('base64url'), iat, exp }));
      return { token: `${payload}.${b64(sign(payload))}`, expiresAt: new Date(exp) };
    },

    /**
     * Checks a stamp for `userId`. Returns null when no token was sent (a plain file upload); throws
     * CAPTURE_REQUIRED when a token was sent but is invalid, expired, someone else's, or the time is off.
     */
    verify(userId: string, input: CaptureStampInput): CaptureStamp | null {
      if (!input.token) return null;
      const invalid = (why: string) => new AppError('CAPTURE_REQUIRED', `The camera stamp is not valid (${why}). Take the photo or video again in the app.`);
      const [payload, sig] = input.token.split('.');
      if (!payload || !sig) throw invalid('malformed');
      const expected = sign(payload);
      const given = Buffer.from(sig, 'base64url');
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalid('signature');
      let data: { u?: string; iat?: number; exp?: number };
      try {
        data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      } catch {
        throw invalid('malformed');
      }
      if (data.u !== userId) throw invalid('another account');
      if (typeof data.iat !== 'number' || typeof data.exp !== 'number') throw invalid('malformed');

      const capturedAt = new Date(input.capturedAt ?? '');
      if (Number.isNaN(capturedAt.getTime())) throw invalid('missing capture time');
      const t = capturedAt.getTime();
      // Taken after the camera opened, before the session ended, and not in the future.
      if (t < data.iat - CLOCK_SKEW_MS || t > data.exp || t > now() + CLOCK_SKEW_MS) throw invalid('captured outside the camera session');

      const stamp: CaptureStamp = { capturedAt };
      const lat = Number(input.lat);
      const lng = Number(input.lng);
      const accuracy = input.accuracy === undefined || input.accuracy === '' ? undefined : Number(input.accuracy);
      const hasPoint = input.lat !== undefined && input.lng !== undefined && input.lat !== '' && input.lng !== '';
      if (hasPoint) {
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw invalid('bad location');
        if (accuracy === undefined || (Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= MAX_ACCURACY_M)) {
          stamp.location = { lat, lng };
          if (accuracy !== undefined) stamp.accuracyM = Math.round(accuracy);
        }
      }
      return stamp;
    },
  };
}
export type CaptureSessions = ReturnType<typeof createCaptureSessions>;
