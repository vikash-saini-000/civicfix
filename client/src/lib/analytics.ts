import { CATEGORIES, type Complaint, type ComplaintStatus } from './domain';
import type { PlatformComplaint } from '../api/types';

/**
 * Terminal statuses used only for the clearly labelled scoped insights below.
 * These values come from the current complaint status contract; this is not an
 * SLA or an official platform performance definition.
 */
const TERMINAL_STATUSES = new Set<ComplaintStatus>(['RESOLVED', 'CLOSED', 'REJECTED']);
const RESOLUTION_STATUSES = new Set<ComplaintStatus>(['RESOLVED', 'CLOSED']);

export interface CategoryCount {
  id: string;
  label: string;
  count: number;
}

export interface ResolutionDuration {
  averageHours: number | null;
  sampleSize: number;
  medianHours: number | null;
}

export type DateRangePreset = 'all' | '7' | '30' | '90' | 'custom';
export type TrendBucket = 'day' | 'week' | 'month';

export interface DateRange {
  from: string | null;
  to: string | null;
}

export interface TrendPoint {
  key: string;
  label: string;
  count: number;
}

export interface DepartmentWorkload {
  name: string;
  total: number;
  unresolved: number;
  resolvedOrClosed: number;
}

export interface PlatformAnalytics extends ComplaintAnalytics {
  departmentWorkload: DepartmentWorkload[];
  trend: TrendPoint[];
  trendBucket: TrendBucket;
  invalidCreatedAtCount: number;
}

export interface ComplaintAnalytics {
  /** The unique authorized records used for every calculation. */
  items: Complaint[];
  total: number;
  statusCounts: Record<string, number>;
  categoryCounts: CategoryCount[];
  activeOrPendingCount: number;
  resolvedOrClosedCount: number;
  resolutionDuration: ResolutionDuration;
}

/**
 * Remove duplicate records by the stable public complaint identifier.
 * The first authorized record wins so a repeated response cannot inflate a
 * dashboard total or category count. IDs are normalized for comparison only;
 * the original record is preserved for rendering.
 */
export function uniqueComplaints<T extends Complaint>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.publicId.trim().toUpperCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Calculate insights from a complete, already-authorized complaint response.
 * Callers must not pass a single paginated page and present the result as a
 * platform-wide total.
 */
export function buildComplaintAnalytics(items: Complaint[]): ComplaintAnalytics {
  const uniqueItems = uniqueComplaints(items);
  const statusCounts: Record<string, number> = {};
  const categoryMap = new Map<string, CategoryCount>();

  for (const item of uniqueItems) {
    statusCounts[item.status] = (statusCounts[item.status] ?? 0) + 1;
    const categoryId = item.confirmedCategory ?? item.selectedCategory ?? 'uncategorized';
    const categoryLabel = categoryId === 'uncategorized'
      ? 'Not categorized'
      : CATEGORIES.find((category) => category.id === categoryId)?.label ?? 'Category unavailable';
    const current = categoryMap.get(categoryId);
    categoryMap.set(categoryId, {
      id: categoryId,
      label: categoryLabel,
      count: (current?.count ?? 0) + 1,
    });
  }

  const categoryOrder = new Map<string, number>(CATEGORIES.map((category, index) => [category.id, index]));
  const categoryCounts = [...categoryMap.values()].sort(
    (a, b) => b.count - a.count || (categoryOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (categoryOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER) || a.label.localeCompare(b.label),
  );
  const resolutionDurations = uniqueItems
    .map((item) => resolutionDurationHours(item))
    .filter((hours): hours is number => hours !== null);
  const averageHours = resolutionDurations.length
    ? resolutionDurations.reduce((sum, hours) => sum + hours, 0) / resolutionDurations.length
    : null;
  const sortedDurations = [...resolutionDurations].sort((a, b) => a - b);
  const medianHours = sortedDurations.length
    ? sortedDurations.length % 2 === 1
      ? sortedDurations[Math.floor(sortedDurations.length / 2)]
      : (sortedDurations[sortedDurations.length / 2 - 1] + sortedDurations[sortedDurations.length / 2]) / 2
    : null;

  return {
    items: uniqueItems,
    total: uniqueItems.length,
    statusCounts,
    categoryCounts,
    activeOrPendingCount: uniqueItems.filter((item) => !TERMINAL_STATUSES.has(item.status)).length,
    resolvedOrClosedCount: uniqueItems.filter((item) => RESOLUTION_STATUSES.has(item.status)).length,
    resolutionDuration: {
      averageHours,
      sampleSize: resolutionDurations.length,
      medianHours,
    },
  };
}

export function resolutionDurationHours(item: Complaint): number | null {
  const createdAt = Date.parse(item.createdAt);
  if (Number.isNaN(createdAt)) return null;
  const history = Array.isArray(item.history) ? item.history : [];
  const resolutionEvent = history
    .filter((event) => RESOLUTION_STATUSES.has(event.status))
    .map((event) => Date.parse(event.at))
    .filter((timestamp) => !Number.isNaN(timestamp) && timestamp >= createdAt)
    .sort((a, b) => a - b)[0];
  if (resolutionEvent === undefined) return null;
  return (resolutionEvent - createdAt) / 3_600_000;
}

export function formatHours(hours: number): string {
  if (hours < 24) return `${hours.toFixed(1)} hours`;
  return `${(hours / 24).toFixed(1)} days`;
}

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function dateInputValue(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function dateRangeForPreset(preset: Exclude<DateRangePreset, 'custom'>, now: Date): DateRange {
  if (preset === 'all') return { from: null, to: null };
  const days = Number(preset);
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { from: dateInputValue(start), to: dateInputValue(end) };
}

export function validateDateRange(range: DateRange): string | null {
  if (!range.from || !range.to) return 'Choose both a start date and an end date.';
  const from = parseDateInput(range.from);
  const to = parseDateInput(range.to);
  if (!from || !to) return 'Enter valid calendar dates.';
  if (from.getTime() > to.getTime()) return 'The start date must be on or before the end date.';
  return null;
}

export function filterComplaintsByDate<T extends Complaint>(items: T[], range: DateRange): T[] {
  const from = range.from ? parseDateInput(range.from) : null;
  const to = range.to ? parseDateInput(range.to) : null;
  if ((range.from && !from) || (range.to && !to) || (from && to && from.getTime() > to.getTime())) return [];
  const toExclusive = to ? new Date(to.getTime() + 86_400_000) : null;
  return items.filter((item) => {
    const createdAt = Date.parse(item.createdAt);
    if (Number.isNaN(createdAt)) return false;
    if (from && createdAt < from.getTime()) return false;
    if (toExclusive && createdAt >= toExclusive.getTime()) return false;
    return true;
  });
}

export function chooseTrendBucket(range: DateRange, items: Complaint[]): TrendBucket {
  const from = range.from ? parseDateInput(range.from) : null;
  const to = range.to ? parseDateInput(range.to) : null;
  if (from && to) {
    const days = Math.floor((to.getTime() - from.getTime()) / 86_400_000) + 1;
    if (days <= 31) return 'day';
    if (days <= 120) return 'week';
    return 'month';
  }
  const timestamps = items.map((item) => Date.parse(item.createdAt)).filter((value) => !Number.isNaN(value));
  if (timestamps.length < 2) return 'day';
  const days = Math.ceil((Math.max(...timestamps) - Math.min(...timestamps)) / 86_400_000);
  if (days <= 31) return 'day';
  if (days <= 120) return 'week';
  return 'month';
}

export function buildTrend(items: Complaint[], range: DateRange, bucket: TrendBucket): TrendPoint[] {
  const filtered = filterComplaintsByDate(items, range);
  const timestamps = filtered.map((item) => Date.parse(item.createdAt)).filter((value) => !Number.isNaN(value));
  if (timestamps.length === 0) return [];

  const requestedStart = range.from ? parseDateInput(range.from) : null;
  const requestedEnd = range.to ? parseDateInput(range.to) : null;
  const start = requestedStart ?? startOfBucket(new Date(Math.min(...timestamps)), bucket);
  const end = requestedEnd ?? startOfBucket(new Date(Math.max(...timestamps)), bucket);
  const counts = new Map<string, number>();
  for (const item of filtered) {
    const timestamp = Date.parse(item.createdAt);
    if (!Number.isNaN(timestamp)) {
      const key = bucketKey(new Date(timestamp), bucket);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const points: TrendPoint[] = [];
  for (let cursor = startOfBucket(start, bucket); cursor.getTime() <= end.getTime(); cursor = nextBucket(cursor, bucket)) {
    const key = bucketKey(cursor, bucket);
    points.push({ key, label: bucketLabel(cursor, bucket), count: counts.get(key) ?? 0 });
  }
  return points;
}

export function buildPlatformAnalytics(items: PlatformComplaint[], range: DateRange): PlatformAnalytics {
  // Filter before deduplication so a repeated record outside the reporting
  // period cannot hide a newer duplicate inside it.
  const uniqueItems = uniqueComplaints(items);
  const filtered = uniqueComplaints(filterComplaintsByDate(items, range));
  const base = buildComplaintAnalytics(filtered);
  const departmentMap = new Map<string, DepartmentWorkload>();
  for (const item of filtered) {
    const name = item.departmentName?.trim() || 'Unassigned';
    const current = departmentMap.get(name) ?? { name, total: 0, unresolved: 0, resolvedOrClosed: 0 };
    current.total += 1;
    if (isTerminalStatus(item.status)) current.resolvedOrClosed += 1;
    else current.unresolved += 1;
    departmentMap.set(name, current);
  }
  const trendBucket = chooseTrendBucket(range, filtered);
  return {
    ...base,
    departmentWorkload: [...departmentMap.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)),
    trendBucket,
    trend: buildTrend(filtered, range, trendBucket),
    invalidCreatedAtCount: uniqueItems.filter((item) => Number.isNaN(Date.parse(item.createdAt))).length,
  };
}

function parseDateInput(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

function startOfBucket(date: Date, bucket: TrendBucket): Date {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  if (bucket === 'month') return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  if (bucket === 'week') {
    const day = start.getUTCDay();
    start.setUTCDate(start.getUTCDate() - (day === 0 ? 6 : day - 1));
  }
  return start;
}

function nextBucket(date: Date, bucket: TrendBucket): Date {
  const next = new Date(date);
  if (bucket === 'month') next.setUTCMonth(next.getUTCMonth() + 1);
  else if (bucket === 'week') next.setUTCDate(next.getUTCDate() + 7);
  else next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

function bucketKey(date: Date, bucket: TrendBucket): string {
  const start = startOfBucket(date, bucket);
  return dateInputValue(start);
}

function bucketLabel(date: Date, bucket: TrendBucket): string {
  const start = startOfBucket(date, bucket);
  if (bucket === 'month') return new Intl.DateTimeFormat('en', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(start);
  if (bucket === 'week') return `Week of ${new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(start)}`;
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(start);
}
