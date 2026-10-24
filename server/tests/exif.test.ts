// JPEG EXIF reader: capture time and GPS only, and never throws on bad input.
import { describe, expect, it } from 'vitest';
import { distanceMeters, readCaptureMetadata } from '../src/services/analysis/exif.js';
import { jpegWithExif } from './helpers.js';

describe('readCaptureMetadata', () => {
  it('reads GPS and capture time in both byte orders', () => {
    for (const littleEndian of [true, false]) {
      const meta = readCaptureMetadata(jpegWithExif({ lat: 13.0072, lng: 74.7956, takenAt: '2026:10:20 09:15:00', offset: '+05:30', littleEndian }));
      expect(meta.location!.lat).toBeCloseTo(13.0072, 5);
      expect(meta.location!.lng).toBeCloseTo(74.7956, 5);
      expect(meta.capturedAt!.toISOString()).toBe('2026-10-20T03:45:00.000Z'); // offset applied
    }
  });

  it('handles southern and western hemispheres', () => {
    const meta = readCaptureMetadata(jpegWithExif({ lat: -33.8688, lng: -70.6693 }));
    expect(meta.location!.lat).toBeCloseTo(-33.8688, 5);
    expect(meta.location!.lng).toBeCloseTo(-70.6693, 5);
    expect(meta.capturedAt).toBeUndefined();
  });

  it('reads a time without offset as UTC (callers allow for the unknown time zone)', () => {
    expect(readCaptureMetadata(jpegWithExif({ takenAt: '2026:10:20 09:15:00' })).capturedAt!.toISOString()).toBe('2026-10-20T09:15:00.000Z');
  });

  it('treats missing, placeholder and impossible values as unknown', () => {
    const plain = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF'), Buffer.alloc(300, 0x22)]);
    expect(readCaptureMetadata(plain)).toEqual({});
    expect(readCaptureMetadata(Buffer.from('not an image'))).toEqual({});
    expect(readCaptureMetadata(jpegWithExif({ lat: 0, lng: 0 })).location).toBeUndefined(); // "no fix" placeholder
    expect(readCaptureMetadata(jpegWithExif({ takenAt: '2026:02:30 10:00:00' })).capturedAt).toBeUndefined();
    expect(readCaptureMetadata(jpegWithExif({ takenAt: '1999:12:31 10:00:00' })).capturedAt).toBeUndefined();
    expect(readCaptureMetadata(jpegWithExif({ takenAt: '2099:01:01 10:00:00' })).capturedAt).toBeUndefined();
    expect(readCaptureMetadata(jpegWithExif({ takenAt: 'yesterday' })).capturedAt).toBeUndefined();
  });

  it('never throws on truncated or corrupted metadata', () => {
    const good = jpegWithExif({ lat: 13, lng: 74.8, takenAt: '2026:10:20 09:15:00' });
    for (let cut = 0; cut < 160; cut += 3) expect(() => readCaptureMetadata(good.subarray(0, cut))).not.toThrow();
    for (let i = 0; i < 200; i++) {
      const bad = Buffer.from(good);
      bad[12 + Math.floor(Math.random() * 120)] = Math.floor(Math.random() * 256);
      expect(() => readCaptureMetadata(bad)).not.toThrow();
    }
  });
});

describe('distanceMeters', () => {
  it('is roughly right at city scale', () => {
    expect(distanceMeters({ lat: 13.0, lng: 74.79 }, { lat: 13.0, lng: 74.79 })).toBe(0);
    expect(distanceMeters({ lat: 13.0, lng: 74.79 }, { lat: 13.001, lng: 74.79 })).toBeCloseTo(111, 0);
  });
});
