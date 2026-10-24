// In-app camera sessions and the strict upload gate (pure logic, no database).
import { describe, expect, it } from 'vitest';
import { gateAllows } from '../src/services/analysis/index.js';
import { createCaptureSessions } from '../src/services/captureSessions.js';

const SECRET = 'test-secret-that-is-long-enough-for-hmac-signing';

describe('camera sessions', () => {
  let clock = Date.parse('2026-10-25T10:00:00Z');
  const sessions = createCaptureSessions({ secret: SECRET, ttlSeconds: 600, now: () => clock });
  const at = (offsetSec: number) => new Date(Date.parse('2026-10-25T10:00:00Z') + offsetSec * 1000).toISOString();

  it('accepts a capture inside the session, with time, GPS and accuracy', () => {
    clock = Date.parse('2026-10-25T10:00:00Z');
    const { token, expiresAt } = sessions.start('user-1');
    expect(expiresAt.toISOString()).toBe('2026-10-25T10:10:00.000Z');
    clock += 30_000;
    const stamp = sessions.verify('user-1', { token, capturedAt: at(25), lat: '13.00773', lng: '74.79474', accuracy: '12.4' });
    expect(stamp).toEqual({ capturedAt: new Date(at(25)), location: { lat: 13.00773, lng: 74.79474 }, accuracyM: 12 });
  });

  it('returns null without a token (a plain file upload)', () => {
    expect(sessions.verify('user-1', {})).toBeNull();
  });

  it('refuses tokens that are tampered with, belong to someone else, or are malformed', () => {
    clock = Date.parse('2026-10-25T10:00:00Z');
    const { token } = sessions.start('user-1');
    const [payload, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ u: 'user-2', iat: clock, exp: clock + 600_000 })).toString('base64url');
    expect(() => sessions.verify('user-2', { token, capturedAt: at(1) })).toThrow(/another account/);
    expect(() => sessions.verify('user-2', { token: `${forged}.${sig}`, capturedAt: at(1) })).toThrow(/signature/);
    expect(() => sessions.verify('user-1', { token: `${payload}.AAAA`, capturedAt: at(1) })).toThrow(/signature/);
    expect(() => sessions.verify('user-1', { token: 'nonsense', capturedAt: at(1) })).toThrow(/malformed/);
    // A token from a server with another secret is not accepted.
    const other = createCaptureSessions({ secret: 'a-completely-different-secret-value-123', ttlSeconds: 600, now: () => clock });
    expect(() => sessions.verify('user-1', { token: other.start('user-1').token, capturedAt: at(1) })).toThrow(/signature/);
  });

  it('refuses captures from before the camera opened, after the session, or in the future', () => {
    clock = Date.parse('2026-10-25T10:00:00Z');
    const { token } = sessions.start('user-1');
    clock += 60_000;
    expect(() => sessions.verify('user-1', { token, capturedAt: at(-3600) })).toThrow(/outside the camera session/); // an old gallery photo
    expect(() => sessions.verify('user-1', { token, capturedAt: at(3600) })).toThrow(/outside the camera session/);
    expect(() => sessions.verify('user-1', { token })).toThrow(/missing capture time/);
    clock += 20 * 60_000; // session over
    expect(() => sessions.verify('user-1', { token, capturedAt: at(1200) })).toThrow(/outside the camera session/);
    // Within the session and the allowed phone-clock difference: fine.
    clock = Date.parse('2026-10-25T10:01:00Z');
    expect(sessions.verify('user-1', { token, capturedAt: at(-60) })).toMatchObject({ capturedAt: new Date(at(-60)) });
  });

  it('drops vague GPS fixes and refuses impossible coordinates', () => {
    clock = Date.parse('2026-10-25T10:00:00Z');
    const { token } = sessions.start('user-1');
    expect(sessions.verify('user-1', { token, capturedAt: at(5), lat: '13', lng: '74.8', accuracy: '2500' })).toEqual({ capturedAt: new Date(at(5)) });
    expect(sessions.verify('user-1', { token, capturedAt: at(5) })).toEqual({ capturedAt: new Date(at(5)) });
    expect(() => sessions.verify('user-1', { token, capturedAt: at(5), lat: '123', lng: '74.8' })).toThrow(/bad location/);
  });
});

describe('upload gate', () => {
  const sig = (finding: string) => ({ source: 'VISUAL_MODEL' as const, finding, detail: '' });
  const result = (outcome: string, findings: string[] = []) => ({ outcome: outcome as never, signals: findings.map(sig) });

  it('block refuses flagged outcomes only; strict also refuses "some signs" and editor tags; flag allows all', () => {
    const some = result('INCONCLUSIVE', ['visual_inconsistency_some']);
    const edited = result('INCONCLUSIVE', ['editor_tag']);
    const clean = result('NO_SUSPICIOUS_SIGNALS_DETECTED');
    const unchecked = result('INCONCLUSIVE');
    const fake = result('POTENTIAL_SYNTHETIC_MEDIA', ['generator_tag']);

    expect([some, edited, clean, unchecked, fake].map((r) => gateAllows('block', r))).toEqual([true, true, true, true, false]);
    expect([some, edited, clean, unchecked, fake].map((r) => gateAllows('strict', r))).toEqual([false, false, true, true, false]);
    expect([some, edited, clean, unchecked, fake].map((r) => gateAllows('flag', r))).toEqual([true, true, true, true, true]);
  });
});
