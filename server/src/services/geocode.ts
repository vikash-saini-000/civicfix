// Turns a map point into words for people: a street address (OpenStreetMap Nominatim reverse geocoding)
// plus CivicFix's own reference data (ward, nearest mapped place). Best effort: if the address service is
// off, slow or failing, the ward and nearby place are still returned.
//
// Nominatim's public server allows at most 1 request per second and needs an identifying User-Agent
// (https://operations.osmfoundation.org/policies/nominatim/). Requests are cached, spaced 1 s apart and
// made by the server, so citizens' browsers never contact OpenStreetMap directly.
import { nearbyPlaces, resolveWard } from './location.js';
import type { Logger } from '../utils/logger.js';

export interface GeocoderConfig {
  /** `nominatim` (default) or `disabled`. */
  provider: 'nominatim' | 'disabled';
  /** Base URL of a Nominatim server (public or self-hosted). */
  url: string;
  /** Identifies this app to the Nominatim operator, as their usage policy requires. */
  userAgent: string;
  timeoutMs?: number;
}

export interface LocationDescription {
  /** One line for display, e.g. "Mega mess left road, Surathkal, Mangaluru taluk 575014". Null if unknown. */
  address: string | null;
  ward: { code: string; name: string } | null;
  nearestPlace: { name: string; kind: string; distanceMeters: number } | null;
  /** Where `address` came from. */
  source: 'openstreetmap' | 'none';
}

type NominatimAddress = Record<string, string | undefined>;

/** Builds a short address line from Nominatim's parts, most specific first, without state/country. Exported for tests. */
export function formatAddress(name: string | undefined, a: NominatimAddress): string | null {
  const parts: string[] = [];
  const add = (v: string | undefined) => {
    const t = v?.trim();
    if (t && !parts.some((p) => p.toLowerCase() === t.toLowerCase())) parts.push(t);
  };
  add(name);
  add(a.house_number && a.road ? `${a.house_number} ${a.road}` : a.road);
  add(a.neighbourhood ?? a.quarter ?? a.suburb ?? a.residential);
  add(a.village ?? a.town ?? a.city ?? a.hamlet ?? a.municipality);
  add(a.city_district && a.city_district !== (a.town ?? a.city) ? a.city_district : a.county);
  if (parts.length === 0) return null;
  const line = parts.join(', ');
  return (a.postcode ? `${line} ${a.postcode}` : line).slice(0, 300);
}

/** ~11 m grid: nearby taps reuse the same lookup. */
const cacheKey = (lat: number, lng: number) => `${lat.toFixed(4)},${lng.toFixed(4)}`;
const CACHE_MAX = 2000;
const MIN_INTERVAL_MS = 1100;

export function createGeocoder(config: GeocoderConfig, logger?: Logger) {
  const cache = new Map<string, string | null>();
  let nextSlot = 0;

  /** Waits for this request's turn so calls stay at most one per second. */
  async function turn() {
    const now = Date.now();
    const at = Math.max(now, nextSlot);
    nextSlot = at + MIN_INTERVAL_MS;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }

  async function streetAddress(lat: number, lng: number): Promise<string | null> {
    if (config.provider === 'disabled') return null;
    const key = cacheKey(lat, lng);
    if (cache.has(key)) return cache.get(key)!;
    await turn();
    const url = new URL('/reverse', config.url);
    url.search = new URLSearchParams({ format: 'jsonv2', lat: String(lat), lon: String(lng), zoom: '18', addressdetails: '1', 'accept-language': 'en' }).toString();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': config.userAgent, Accept: 'application/json' }, signal: AbortSignal.timeout(config.timeoutMs ?? 5000) });
      if (!res.ok) {
        logger?.warn({ status: res.status }, 'address lookup failed');
        return null; // not cached: may work next time
      }
      const body = (await res.json()) as { name?: string; address?: NominatimAddress; error?: string };
      const address = body.error ? null : formatAddress(body.name, body.address ?? {});
      cache.set(key, address);
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
      return address;
    } catch (err) {
      logger?.warn({ err: (err as Error).name }, 'address lookup unavailable');
      return null;
    }
  }

  return {
    enabled: config.provider !== 'disabled',
    /** Address + ward + nearest mapped place for a point. Never throws for lookup failures. */
    async describe(lat: number, lng: number): Promise<LocationDescription> {
      const point = { type: 'Point' as const, coordinates: [lng, lat] };
      const [address, ward, places] = await Promise.all([streetAddress(lat, lng), resolveWard(point).catch(() => null), nearbyPlaces(point, 500, 1).catch(() => [])]);
      const place = places[0];
      return {
        address,
        ward: ward ? { code: ward.code, name: ward.name } : null,
        nearestPlace: place ? { name: place.name, kind: place.kind, distanceMeters: place.distanceMeters } : null,
        source: address ? 'openstreetmap' : 'none',
      };
    },
    /** Street address only (used to label new complaints). */
    streetAddress,
  };
}
export type Geocoder = ReturnType<typeof createGeocoder>;

export const disabledGeocoder: Geocoder = createGeocoder({ provider: 'disabled', url: 'https://nominatim.openstreetmap.org', userAgent: 'CivicFix' });
