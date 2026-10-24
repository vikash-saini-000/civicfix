import type { Complaint, ComplaintStatus, Priority } from '../lib/domain';
import type { DepartmentContext } from '../auth/department';
import type { ComplaintApi, DepartmentApi, PlatformAnalyticsApi, PlatformComplaint, StaffComplaint } from './types';
import { ApiError } from './errors';

const STORAGE_KEY = 'civicfix.mock.complaints.v1';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface MockApiOptions {
  now?: () => Date;
  storage?: StorageLike;
  latencyMs?: number;
  reviewDelayMs?: number;
}

interface StoredComplaint extends Complaint {
  department?: string;
  priority: Priority | null;
}

export function createMockApi(options: MockApiOptions = {}): ComplaintApi & DepartmentApi & PlatformAnalyticsApi {
  const now = options.now ?? (() => new Date());
  const storage = options.storage ?? getBrowserStorage();
  const latencyMs = options.latencyMs ?? 250;
  const reviewDelayMs = options.reviewDelayMs ?? 4000;
  let complaints = load(storage, now);

  function save() {
    if (!storage) return;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(complaints));
    } catch {
      // Mock data then lasts only for this page load when storage is unavailable.
    }
  }

  function scheduleReview(publicId: string) {
    setTimeout(() => {
      const complaint = complaints.find((item) => item.publicId === publicId);
      if (!complaint || complaint.status !== 'REPORTED') return;
      const status: ComplaintStatus = 'UNDER_REVIEW';
      const at = now().toISOString();
      complaint.status = status;
      complaint.updatedAt = at;
      complaint.history ??= [];
      complaint.history.push({ status, at });
      save();
    }, reviewDelayMs);
  }

  function nextId(): string {
    const max = complaints.reduce((highest, complaint) => Math.max(highest, Number(complaint.publicId.split('-')[2]) || 0), 0);
    return `CF-${now().getUTCFullYear()}-${String(max + 1).padStart(5, '0')}`;
  }

  return {
    capabilities: { photoAttachments: true, operations: false },
    async listMyComplaints(signal) {
      await delay(latencyMs, signal);
      return complaints.map(toCitizenComplaint).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    async getComplaint(publicId, signal) {
      await delay(latencyMs, signal);
      const complaint = complaints.find((item) => item.publicId === publicId.toUpperCase());
      return complaint ? toCitizenComplaint(complaint) : null;
    },

    async submitComplaint(input, signal) {
      await delay(Math.max(latencyMs, 400), signal);
      const timestamp = now().toISOString();
      const complaint: StoredComplaint = {
        publicId: nextId(),
        title: input.title.trim(),
        description: input.description.trim(),
        location: input.location,
        landmark: input.landmark?.trim() || undefined,
        selectedCategory: input.selectedCategory,
        confirmedCategory: null,
        priority: null,
        status: 'REPORTED',
        photoCount: input.photos.length,
        createdAt: timestamp,
        updatedAt: timestamp,
        history: [{ status: 'REPORTED', at: timestamp }],
      };
      complaints = [complaint, ...complaints];
      save();
      scheduleReview(complaint.publicId);
      return toCitizenComplaint(complaint);
    },

    async listDepartmentComplaints(context: DepartmentContext, signal) {
      await delay(latencyMs, signal);
      const departmentName = context.departmentName?.trim();
      if (!departmentName) throw new ApiError('The mock department context has no trusted department name.', 403, 'DEPARTMENT_CONTEXT_REQUIRED');
      return complaints
        .filter((complaint) => complaint.department?.trim() === departmentName)
        .map(toStaffComplaint)
        .filter((complaint): complaint is StaffComplaint => complaint !== null)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    async getDepartmentComplaint(context: DepartmentContext, publicId, signal) {
      await delay(latencyMs, signal);
      const departmentName = context.departmentName?.trim();
      if (!departmentName) throw new ApiError('The mock department context has no trusted department name.', 403, 'DEPARTMENT_CONTEXT_REQUIRED');
      const complaint = complaints.find(
        (item) => item.publicId === publicId.toUpperCase() && item.department?.trim() === departmentName,
      );
      return complaint ? toStaffComplaint(complaint) : null;
    },
    async listPlatformComplaints(signal) {
      await delay(latencyMs, signal);
      return complaints.map(toPlatformComplaint).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
  };
}

function load(storage: StorageLike | undefined, now: () => Date): StoredComplaint[] {
  if (storage) {
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw) as StoredComplaint[];
    } catch {
      // Storage or a previous mock payload may be unavailable; use the seed data.
    }
  }
  return structuredClone(createSeed(now));
}

function getBrowserStorage(): StorageLike | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('The request was cancelled.', 'AbortError'));
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('The request was cancelled.', 'AbortError'));
      },
      { once: true },
    );
  });
}

function createSeed(now: () => Date): StoredComplaint[] {
  const hoursAgo = (hours: number) => new Date(now().getTime() - hours * 3_600_000).toISOString();
  // Simulated data near NITK Surathkal. Not real complaints.
  return [
    {
      publicId: 'CF-2026-00141',
      title: 'Deep pothole near the bus stop',
      description:
        'Large pothole on NH-66 service road, about 50 m from Surathkal bus stop. Two-wheelers swerve into traffic to avoid it.',
      location: { lat: 13.0072, lng: 74.7956 },
      landmark: 'Surathkal bus stop',
      selectedCategory: 'roads',
      confirmedCategory: 'roads',
      department: 'Roads and Public Works',
      priority: 'P2',
      status: 'IN_PROGRESS',
      photoCount: 2,
      createdAt: hoursAgo(70),
      updatedAt: hoursAgo(5),
      history: [
        { status: 'REPORTED', at: hoursAgo(70) },
        { status: 'UNDER_REVIEW', at: hoursAgo(69.8) },
         { status: 'ASSIGNED', at: hoursAgo(66), note: 'Your complaint has been assigned to a civic team.' },
        { status: 'ACCEPTED', at: hoursAgo(40) },
        { status: 'IN_PROGRESS', at: hoursAgo(5), note: 'Crew on site. Expected to finish today.' },
      ],
    },
    {
      publicId: 'CF-2026-00118',
      title: 'Streetlight not working for a week',
      description: 'The streetlight outside the temple gate has been off for seven nights. The lane is very dark.',
      location: { lat: 13.0151, lng: 74.7921 },
      landmark: 'Temple gate, Lighthouse Hill Road',
      selectedCategory: 'streetlight',
      confirmedCategory: 'streetlight',
      department: 'Electrical Maintenance',
      priority: 'P3',
      status: 'VERIFICATION_REQUIRED',
      photoCount: 1,
      createdAt: hoursAgo(190),
      updatedAt: hoursAgo(20),
      history: [
        { status: 'REPORTED', at: hoursAgo(190) },
        { status: 'UNDER_REVIEW', at: hoursAgo(189.9) },
        { status: 'ASSIGNED', at: hoursAgo(170) },
        { status: 'ACCEPTED', at: hoursAgo(150) },
        { status: 'IN_PROGRESS', at: hoursAgo(60) },
        { status: 'RESOLUTION_SUBMITTED', at: hoursAgo(26) },
        {
          status: 'VERIFICATION_REQUIRED',
          at: hoursAgo(20),
          note: 'The after photo was taken in daylight, so we cannot confirm the light works. A manager will check.',
        },
      ],
    },
    {
      publicId: 'CF-2026-00097',
      title: 'Garbage pile next to the market',
      description: 'Uncollected garbage piling up behind the fish market for several days. Strong smell.',
      location: { lat: 13.0109, lng: 74.7988 },
      selectedCategory: 'garbage',
      confirmedCategory: 'garbage',
      department: 'Solid Waste Management',
      priority: 'P3',
      status: 'CLOSED',
      photoCount: 1,
      createdAt: hoursAgo(400),
      updatedAt: hoursAgo(300),
      history: [
        { status: 'REPORTED', at: hoursAgo(400) },
        { status: 'UNDER_REVIEW', at: hoursAgo(399.9) },
        { status: 'ASSIGNED', at: hoursAgo(395) },
        { status: 'ACCEPTED', at: hoursAgo(390) },
        { status: 'IN_PROGRESS', at: hoursAgo(380) },
        { status: 'RESOLUTION_SUBMITTED', at: hoursAgo(370) },
        { status: 'RESOLVED', at: hoursAgo(360), note: 'Before and after photos match the location. Area cleared.' },
        { status: 'CLOSED', at: hoursAgo(300) },
      ],
    },
  ];
}

function toCitizenComplaint(complaint: StoredComplaint): Complaint {
  const { department: _department, priority: _priority, ...citizenComplaint } = complaint;
  return structuredClone(citizenComplaint);
}

function toStaffComplaint(complaint: StoredComplaint): StaffComplaint | null {
  if (!complaint.department?.trim()) return null;
  return {
    ...toCitizenComplaint(complaint),
    departmentName: complaint.department.trim(),
    priority: complaint.priority ?? null,
  };
}

function toPlatformComplaint(complaint: StoredComplaint): PlatformComplaint {
  return {
    ...toCitizenComplaint(complaint),
    departmentName: complaint.department?.trim() || null,
    priority: complaint.priority ?? null,
  };
}
