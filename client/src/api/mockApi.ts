import type { Complaint, ComplaintStatus } from '../lib/domain';
import type { CivicFixApi } from './types';

const STORAGE_KEY = 'civicfix.mock.complaints.v1';
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

// Simulated data near NITK Surathkal. Not real complaints.
const SEED: Complaint[] = [
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
      { status: 'ASSIGNED', at: hoursAgo(66), note: 'Assigned to Roads and Public Works, Ward 4 team.' },
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

function load(): Complaint[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Complaint[];
  } catch {
    // storage unavailable: fall back to seed data
  }
  return structuredClone(SEED);
}

let complaints: Complaint[] = load();

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(complaints));
  } catch {
    // ignore: mock data then lasts only for this page load
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function nextId(): string {
  const max = complaints.reduce((m, c) => Math.max(m, Number(c.publicId.split('-')[2]) || 0), 0);
  return `CF-2026-${String(max + 1).padStart(5, '0')}`;
}

/** Simulates the backend moving a new complaint into review shortly after submission. */
function scheduleReview(publicId: string) {
  setTimeout(() => {
    const c = complaints.find((x) => x.publicId === publicId);
    if (!c || c.status !== 'REPORTED') return;
    const status: ComplaintStatus = 'UNDER_REVIEW';
    const at = new Date().toISOString();
    c.status = status;
    c.updatedAt = at;
    c.history.push({ status, at });
    save();
  }, 4000);
}

export const mockApi: CivicFixApi = {
  async listMyComplaints() {
    await delay(250);
    return structuredClone(complaints).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },

  async getComplaint(publicId) {
    await delay(200);
    const c = complaints.find((x) => x.publicId === publicId.toUpperCase());
    return c ? structuredClone(c) : null;
  },

  async submitComplaint(input) {
    await delay(700);
    const now = new Date().toISOString();
    const complaint: Complaint = {
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
      createdAt: now,
      updatedAt: now,
      history: [{ status: 'REPORTED', at: now }],
    };
    complaints = [complaint, ...complaints];
    save();
    scheduleReview(complaint.publicId);
    return structuredClone(complaint);
  },
};
