// Location context for triage and explainable prioritisation. Deterministic and read-only:
// ward lookup, nearby mapped places (schools, hospitals, main roads...), and nearby open reports.
import { Types } from 'mongoose';
import type { Category, PlaceKind, Priority, PriorityFactor } from '../models/enums.js';
import { PRIORITIES, SENSITIVE_PLACE_KINDS } from '../models/enums.js';
import { Complaint, Place, Ward } from '../models/index.js';

/** Statuses of a report that is still open (used for "open reports nearby"). */
const OPEN_STATUSES = ['REPORTED', 'UNDER_REVIEW', 'ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'BLOCKED', 'RESOLUTION_SUBMITTED', 'VERIFICATION_REQUIRED'];

export interface PriorityPolicy {
  version: string;
  /** Places this close count as "near" for NEAR_SENSITIVE_PLACE (schools, hospitals). */
  sensitivePlaceMeters: number;
  /** A main road this close counts as ON_MAIN_ROAD, for categories that affect traffic. */
  mainRoadMeters: number;
  /** Categories where being on a main road matters. */
  mainRoadCategories: readonly Category[];
  /** Same-category open reports within this radius (plus linked duplicates) for MANY_REPORTS. */
  nearbyReportsMeters: number;
  nearbyReportsDays: number;
  manyReportsThreshold: number;
  /** Earliest linked report older than this → LONG_STANDING. */
  longStandingDays: number;
  /** At most this many one-level raises in total. */
  maxRaise: number;
  /** Rules never raise above this (P1 always comes from facts and a human). */
  ceiling: Priority;
}

export const DEFAULT_PRIORITY_POLICY: PriorityPolicy = {
  version: 'priority-v1',
  sensitivePlaceMeters: 100,
  mainRoadMeters: 30,
  mainRoadCategories: ['roads', 'drainage', 'streetlight', 'water'],
  nearbyReportsMeters: 200,
  nearbyReportsDays: 30,
  manyReportsThreshold: 3,
  longStandingDays: 30,
  maxRaise: 2,
  ceiling: 'P2',
};

export interface NearbyPlace {
  name: string;
  kind: PlaceKind;
  distanceMeters: number;
}

export interface LocationContext {
  ward: { id: Types.ObjectId; code: string; name: string } | null;
  nearbyPlaces: NearbyPlace[];
  /** Other open reports nearby (any category) in the last nearbyReportsDays. */
  openReportsNearby: number;
  /** Open reports nearby with the same category (used for MANY_REPORTS). */
  sameCategoryNearby: number;
  /** Duplicates already linked to this complaint. */
  linkedReports: number;
  /** Age of the oldest report about this issue (this complaint or a linked duplicate), in days. */
  issueAgeDays: number;
}

type Point = { type?: 'Point'; coordinates: number[] };

/** The ward whose boundary contains the point, if any. */
export async function resolveWard(location: Point) {
  return Ward.findOne({ isActive: true, boundary: { $geoIntersects: { $geometry: { type: 'Point', coordinates: location.coordinates } } } })
    .select('code name')
    .lean();
}

/** Mapped places within `meters`, nearest first. Lines (roads) measure to the nearest point on the line. */
export async function nearbyPlaces(location: Point, meters = 300, limit = 8): Promise<NearbyPlace[]> {
  const rows = await Place.aggregate<{ name: string; kind: PlaceKind; d: number }>([
    { $geoNear: { near: { type: 'Point', coordinates: [location.coordinates[0]!, location.coordinates[1]!] }, distanceField: 'd', maxDistance: meters, spherical: true, key: 'geometry' } },
    { $limit: limit },
    { $project: { name: 1, kind: 1, d: 1 } },
  ]);
  return rows.map((r) => ({ name: r.name, kind: r.kind, distanceMeters: Math.round(r.d) }));
}

export async function locationContext(
  c: { _id: Types.ObjectId; location: Point; createdAt: Date; ward?: Types.ObjectId | null; linkedReportCount?: number | null; confirmedCategory?: string | null; selectedCategory?: string | null },
  category: string | null,
  policy: PriorityPolicy = DEFAULT_PRIORITY_POLICY,
): Promise<LocationContext> {
  const since = new Date(c.createdAt.getTime() - policy.nearbyReportsDays * 86_400_000);
  const [ward, places, nearby, oldestLinked] = await Promise.all([
    c.ward ? Ward.findById(c.ward).select('code name').lean() : resolveWard(c.location),
    nearbyPlaces(c.location),
    Complaint.aggregate<{ category: string | null }>([
      {
        $geoNear: {
          near: { type: 'Point', coordinates: [c.location.coordinates[0]!, c.location.coordinates[1]!] },
          distanceField: 'd',
          maxDistance: policy.nearbyReportsMeters,
          spherical: true,
          query: { _id: { $ne: c._id }, status: { $in: OPEN_STATUSES }, createdAt: { $gte: since }, duplicateOf: null },
        },
      },
      { $limit: 50 },
      { $project: { category: { $ifNull: ['$confirmedCategory', '$selectedCategory'] } } },
    ]),
    Complaint.findOne({ 'duplicateOf.complaint': c._id }).sort({ createdAt: 1 }).select('createdAt').lean(),
  ]);
  const oldest = Math.min(c.createdAt.getTime(), oldestLinked?.createdAt.getTime() ?? Infinity);
  return {
    ward: ward ? { id: ward._id, code: ward.code, name: ward.name } : null,
    nearbyPlaces: places,
    openReportsNearby: nearby.length,
    sameCategoryNearby: category ? nearby.filter((n) => n.category === category).length : 0,
    linkedReports: c.linkedReportCount ?? 0,
    issueAgeDays: Math.floor((Date.now() - oldest) / 86_400_000),
  };
}

export interface PriorityDecision {
  priority: Priority;
  factors: { factor: PriorityFactor; detail: string; raisedTo: Priority }[];
}

/**
 * Explainable priority: starts from the model's suggestion and raises it one level per factor that
 * applies, at most `maxRaise` levels and never above `ceiling`. Never lowers it. Every raise is listed.
 */
export function adjustPriority(modelPriority: Priority, category: string, ctx: LocationContext, policy: PriorityPolicy = DEFAULT_PRIORITY_POLICY): PriorityDecision {
  const applicable: { factor: PriorityFactor; detail: string }[] = [];
  const sensitive = ctx.nearbyPlaces.find((p) => SENSITIVE_PLACE_KINDS.includes(p.kind) && p.kind !== 'MAIN_ROAD' && p.distanceMeters <= policy.sensitivePlaceMeters);
  if (sensitive) applicable.push({ factor: 'NEAR_SENSITIVE_PLACE', detail: `${sensitive.distanceMeters} m from ${sensitive.name} (${sensitive.kind.toLowerCase()})` });
  const road = ctx.nearbyPlaces.find((p) => p.kind === 'MAIN_ROAD' && p.distanceMeters <= policy.mainRoadMeters);
  if (road && (policy.mainRoadCategories as readonly string[]).includes(category)) applicable.push({ factor: 'ON_MAIN_ROAD', detail: `on or beside ${road.name}` });
  const reports = ctx.linkedReports + ctx.sameCategoryNearby;
  if (reports + 1 >= policy.manyReportsThreshold) applicable.push({ factor: 'MANY_REPORTS', detail: `${reports + 1} reports of this kind nearby or linked` });
  if (ctx.issueAgeDays >= policy.longStandingDays) applicable.push({ factor: 'LONG_STANDING', detail: `first reported ${ctx.issueAgeDays} days ago` });

  let index = PRIORITIES.indexOf(modelPriority);
  const ceilingIndex = PRIORITIES.indexOf(policy.ceiling);
  const factors: PriorityDecision['factors'] = [];
  let raises = 0;
  for (const f of applicable) {
    if (raises < policy.maxRaise && index > ceilingIndex) {
      index--;
      raises++;
    }
    factors.push({ ...f, raisedTo: PRIORITIES[index]! });
  }
  return { priority: PRIORITIES[index]!, factors };
}

/** Facts for the model prompt (no personal data). */
export function contextForPrompt(ctx: LocationContext) {
  return {
    ward: ctx.ward?.name ?? null,
    nearby_places: ctx.nearbyPlaces.slice(0, 6).map((p) => ({ name: p.name, kind: p.kind.toLowerCase(), distance_m: p.distanceMeters })),
    open_reports_within_200m_last_30_days: ctx.openReportsNearby,
    linked_duplicate_reports: ctx.linkedReports,
  };
}
