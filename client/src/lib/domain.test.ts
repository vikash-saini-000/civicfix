import { describe, expect, it } from 'vitest';
import { isValidGeoPoint } from './domain';

describe('GeoPoint validation', () => {
  it('accepts coordinates in the valid geographic ranges', () => {
    expect(isValidGeoPoint({ lat: 13.0108, lng: 74.7943 })).toBe(true);
    expect(isValidGeoPoint({ lat: -90, lng: 180 })).toBe(true);
  });

  it('rejects missing, non-finite, and out-of-range coordinates', () => {
    expect(isValidGeoPoint(null)).toBe(false);
    expect(isValidGeoPoint({ lat: Number.NaN, lng: 74 })).toBe(false);
    expect(isValidGeoPoint({ lat: 91, lng: 74 })).toBe(false);
    expect(isValidGeoPoint({ lat: 13, lng: 181 })).toBe(false);
  });
});
