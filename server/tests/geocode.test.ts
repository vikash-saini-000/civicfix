// Street addresses for map points (OpenStreetMap Nominatim), without calling the internet.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGeocoder, formatAddress } from '../src/services/geocode.js';

const config = { provider: 'nominatim' as const, url: 'https://nominatim.example.test', userAgent: 'CivicFix-test/1.0' };

// Real response shape for 13.00773, 74.79474 (Surathkal).
const surathkal = {
  name: 'Mega Mess',
  address: { amenity: 'Mega Mess', road: 'Mega mess left road', town: 'Surathkal', county: 'Mangaluru taluk', state_district: 'Dakshina Kannada', state: 'Karnataka', postcode: '575014', country: 'India' },
};
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('formatAddress', () => {
  it('builds a short line from the most specific parts, without state or country', () => {
    expect(formatAddress(surathkal.name, surathkal.address)).toBe('Mega Mess, Mega mess left road, Surathkal, Mangaluru taluk 575014');
  });

  it('adds house numbers, skips repeats and empty parts', () => {
    expect(formatAddress(undefined, { house_number: '12', road: 'MG Road', suburb: 'Hampankatta', city: 'Mangaluru', city_district: 'Mangaluru' })).toBe('12 MG Road, Hampankatta, Mangaluru');
    expect(formatAddress('NH 66', { road: 'NH 66', town: 'Surathkal' })).toBe('NH 66, Surathkal');
    expect(formatAddress(undefined, {})).toBeNull();
  });
});

describe('geocoder', () => {
  it('looks up an address with an identifying User-Agent and caches nearby points', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ok(surathkal));
    vi.stubGlobal('fetch', fetchMock);
    const geo = createGeocoder(config);

    expect(await geo.streetAddress(13.00773, 74.79474)).toBe('Mega Mess, Mega mess left road, Surathkal, Mangaluru taluk 575014');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('https://nominatim.example.test/reverse?format=jsonv2&lat=13.00773&lon=74.79474');
    expect((init as RequestInit).headers).toMatchObject({ 'User-Agent': 'CivicFix-test/1.0' });
    // A few metres away: same ~11 m cell, no second request.
    expect(await geo.streetAddress(13.00775, 74.79471)).toBe('Mega Mess, Mega mess left road, Surathkal, Mangaluru taluk 575014');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null on failure and tries again next time', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementation(async () => ok(surathkal));
    vi.stubGlobal('fetch', fetchMock);
    const geo = createGeocoder(config);
    expect(await geo.streetAddress(12.9, 74.8)).toBeNull();
    expect(await geo.streetAddress(12.9, 74.8)).toContain('Surathkal');
  });

  it('treats "no address here" (e.g. at sea) as no address', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => ok({ error: 'Unable to geocode' })));
    expect(await createGeocoder(config).streetAddress(12.5, 73.5)).toBeNull();
  });

  it('keeps to one request per second (Nominatim usage policy)', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ok(surathkal));
    vi.stubGlobal('fetch', fetchMock);
    const geo = createGeocoder(config);
    const started = Date.now();
    await Promise.all([geo.streetAddress(13.1, 74.7), geo.streetAddress(13.2, 74.7)]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('makes no requests when disabled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const geo = createGeocoder({ ...config, provider: 'disabled' });
    expect(geo.enabled).toBe(false);
    expect(await geo.streetAddress(13, 74.8)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
