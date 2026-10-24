import { Router } from 'express';
import { disabledGeocoder, type Geocoder } from '../services/geocode.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { z } from 'zod';
import type { AuthService } from '../auth/authService.js';
import { requireAuth } from '../middleware/auth.js';
import { input, validate } from '../middleware/validate.js';
import { CATEGORIES, PLACE_KINDS } from '../models/enums.js';
import { Place, Ward } from '../models/index.js';
import type { AnalyticsService, HotspotQuery, MapQuery } from '../services/analytics.js';
import { sendSuccess } from '../utils/respond.js';
import { objectId } from '../validation/common.js';

const DAY = 86_400_000;
const PERIODS = { '7d': 7, '30d': 30, '90d': 90, '365d': 365, '730d': 730 } as const;
/** Recurring hotspots compare monsoons across years, so analytics allow longer ranges than dashboards. */
export const MAX_ANALYTICS_DAYS = 1100;
const isoDate = z.iso.datetime({ offset: true }).transform((s) => new Date(s));

const rangeFields = {
  period: z.enum(Object.keys(PERIODS) as [keyof typeof PERIODS, ...(keyof typeof PERIODS)[]]).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  departmentId: objectId.optional(),
};

type RangeFields = { period?: keyof typeof PERIODS; from?: Date; to?: Date; departmentId?: string };

/** Shared range rules: `period` or `from`/`to`; default `defaultDays`; at most MAX_ANALYTICS_DAYS. */
function withRange<T extends z.ZodRawShape>(extra: T, defaultDays: number) {
  return z
    .strictObject({ ...rangeFields, ...extra })
    .refine((raw) => {
      const q = raw as RangeFields;
      return !(q.period && (q.from || q.to));
    }, { message: 'Use either period or from/to.', path: ['period'] })
    .transform((raw, ctx) => {
      const q = raw as RangeFields & Record<string, unknown>;
      const to = q.to ?? new Date();
      const days = q.period ? PERIODS[q.period] : defaultDays;
      const from = q.from ?? new Date(to.getTime() - days * DAY);
      if (from >= to) ctx.addIssue({ code: 'custom', message: 'from must be before to.', path: ['from'] });
      if (to.getTime() - from.getTime() > MAX_ANALYTICS_DAYS * DAY) ctx.addIssue({ code: 'custom', message: `The range can be at most ${MAX_ANALYTICS_DAYS} days.`, path: ['from'] });
      return { ...q, from, to };
    });
}

const bbox = z
  .string()
  .max(100)
  .transform((s) => s.split(',').map(Number))
  .pipe(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90), z.number().min(-180).max(180), z.number().min(-90).max(90)]))
  .refine((b) => b[0] < b[2] && b[1] < b[3], 'bbox must be minLng,minLat,maxLng,maxLat');

const mapQuery = withRange(
  {
    category: z.enum(CATEGORIES).optional(),
    open: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
    bbox: bbox.optional(),
    limit: z.coerce.number().int().min(1).max(2000).default(1000),
  },
  90,
);
const hotspotQuery = withRange(
  {
    category: z.enum(CATEGORIES).optional(),
    cellMeters: z.coerce.number().int().min(100).max(1000).default(250),
    minReports: z.coerce.number().int().min(2).max(50).default(3),
  },
  730,
);
const plainRange = withRange({}, 30);
const placesQuery = z.strictObject({ kind: z.enum(PLACE_KINDS).optional(), bbox: bbox.optional() });

type Range = { from: Date; to: Date; departmentId?: string };

/** /api/v1/analytics/* (staff and admins). */
export function analyticsRouter(deps: { authService: AuthService; analyticsService: AnalyticsService }): Router {
  const router = Router();
  const svc = deps.analyticsService;
  router.use(requireAuth(deps.authService), (_req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    next();
  });
  router.get('/map', validate({ query: mapQuery }), async (req, res) => {
    sendSuccess(res, await svc.map(req.auth!, input<MapQuery>(req, 'query')));
  });
  router.get('/hotspots', validate({ query: hotspotQuery }), async (req, res) => {
    sendSuccess(res, await svc.hotspots(req.auth!, input<HotspotQuery>(req, 'query')));
  });
  router.get('/wards', validate({ query: plainRange }), async (req, res) => {
    const q = input<Range>(req, 'query');
    sendSuccess(res, await svc.wards(req.auth!, q, q.departmentId));
  });
  router.get('/sla', validate({ query: plainRange }), async (req, res) => {
    const q = input<Range>(req, 'query');
    sendSuccess(res, await svc.sla(req.auth!, q, q.departmentId));
  });
  router.get('/overview', validate({ query: plainRange }), async (req, res) => {
    const q = input<Range>(req, 'query');
    sendSuccess(res, await svc.overview(req.auth!, q, q.departmentId));
  });
  return router;
}

/** /api/v1/geo/*: reference map data (ward boundaries, mapped places) for any signed-in user. No personal data. */
const reverseQuery = z.strictObject({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
});

export function geoRouter(deps: { authService: AuthService; geocoder?: Geocoder }): Router {
  const geocoder = deps.geocoder ?? disabledGeocoder;
  const router = Router();
  router.use(requireAuth(deps.authService), (_req, res, next) => {
    res.setHeader('Cache-Control', 'private, max-age=300');
    next();
  });
  router.get('/wards', async (_req, res) => {
    const wards = await Ward.find({ isActive: true }).sort({ code: 1 }).select('code name population boundary').lean();
    sendSuccess(res, wards.map((w) => ({ id: String(w._id), code: w.code, name: w.name, population: w.population ?? null, boundary: w.boundary })));
  });
  /** A point in words: street address (OpenStreetMap), ward and nearest mapped place. */
  router.get('/reverse', createRateLimiter({ windowMs: 60_000, limit: 30, keyPart: (req) => req.auth?.userId }), validate({ query: reverseQuery }), async (req, res) => {
    const q = input<z.infer<typeof reverseQuery>>(req, 'query');
    sendSuccess(res, await geocoder.describe(q.lat, q.lng));
  });
  router.get('/places', validate({ query: placesQuery }), async (req, res) => {
    const q = input<z.infer<typeof placesQuery>>(req, 'query');
    const filter: Record<string, unknown> = {};
    if (q.kind) filter.kind = q.kind;
    if (q.bbox) filter.geometry = { $geoIntersects: { $geometry: { type: 'Polygon', coordinates: [[[q.bbox[0], q.bbox[1]], [q.bbox[2], q.bbox[1]], [q.bbox[2], q.bbox[3]], [q.bbox[0], q.bbox[3]], [q.bbox[0], q.bbox[1]]]] } } };
    const places = await Place.find(filter).limit(1000).select('name kind geometry ward').lean();
    sendSuccess(res, places.map((p) => ({ id: String(p._id), name: p.name, kind: p.kind, geometry: p.geometry, wardId: p.ward ? String(p.ward) : null })));
  });
  return router;
}
