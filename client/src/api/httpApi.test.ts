import { afterEach, describe, expect, it, vi } from 'vitest';
import { tagCapture } from '../lib/captureStamp';
import type { ApiError } from './errors';
import { HttpCivicFixApi } from './httpApi';

// Shapes follow docs/api (server/src): envelope { success, data, meta }, errors { error: { code, message } }.
const complaint = {
  id: '6adc84f1c2a3b4d5e6f70812',
  publicId: 'CF-2026-00001',
  title: 'Pothole near the bus stop',
  description: 'A deep pothole is making the road unsafe.',
  location: { lat: 13.0108, lng: 74.7943 },
  landmark: null,
  selectedCategory: 'roads',
  confirmedCategory: 'roads',
  department: { id: 'd1', name: 'Roads and Public Works' },
  priority: 'P1',
  status: 'UNDER_REVIEW',
  statusHistory: [
    { status: 'REPORTED', at: '2026-10-24T10:00:00.000Z', note: null },
    { status: 'UNDER_REVIEW', at: '2026-10-24T10:05:00.000Z', note: 'Sent for review.' },
  ],
  rejectionReason: null,
  followUp: null,
  duplicateOf: null,
  linkedReportCount: 0,
  allowedActions: [],
  createdAt: '2026-10-24T10:00:00.000Z',
  updatedAt: '2026-10-24T10:05:00.000Z',
};

const backendUser = {
  id: 'u1',
  name: 'Asha Rao',
  email: 'asha@example.test',
  platformRole: 'CITIZEN',
  roles: ['CITIZEN', 'DEPARTMENT_MANAGER'],
  memberships: [{ departmentId: 'd1', role: 'MANAGER' }],
  createdAt: '2026-10-24T09:41:00.000Z',
};

const session = { user: backendUser, accessToken: 'token-1', tokenType: 'Bearer', expiresIn: 900 };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const ok = (data: unknown, meta?: unknown) => json({ success: true, data, ...(meta ? { meta } : {}) });
const fail = (status: number, code: string, message = 'Nope') => json({ success: false, error: { code, message, details: [] }, requestId: 'r1' }, status);
const departments = () => ok([{ id: 'd1', name: 'Roads and Public Works', categories: ['roads'], isActive: true, description: null }], {
  pagination: { page: 1, limit: 100, total: 1, totalPages: 1, hasNextPage: false },
});

function headerOf(call: unknown[], name: string): string | null {
  return ((call[1] as RequestInit).headers as Headers).get(name);
}

afterEach(() => vi.unstubAllGlobals());

describe('HttpCivicFixApi', () => {
  it('signs in, maps the backend user and keeps the token in memory for later calls', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok(session))
      .mockResolvedValueOnce(departments())
      .mockResolvedValueOnce(ok([complaint], { pagination: { page: 1, limit: 100, total: 1, totalPages: 1, hasNextPage: false } }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new HttpCivicFixApi({ baseUrl: 'https://api.example.test', timeoutMs: 1000 });

    const result = await api.login({ email: 'asha@example.test', password: 'secret-pass' });
    expect(result.user).toEqual({
      id: 'u1',
      email: 'asha@example.test',
      displayName: 'Asha Rao',
      role: 'department_manager',
      departmentMemberships: [{ departmentId: 'd1', role: 'manager', departmentName: 'Roads and Public Works' }],
    });
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.example.test/api/v1/auth/login');
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(localStorage.length).toBe(0);

    await api.listMyComplaints();
    expect(fetchMock.mock.calls[2]![0]).toBe('https://api.example.test/api/v1/complaints?scope=mine&sort=-updatedAt&page=1&limit=100');
    expect(headerOf(fetchMock.mock.calls[2]!, 'Authorization')).toBe('Bearer token-1');
  });

  it('parses the backend complaint view without leaking staff fields to citizens', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ complaint })));
    const api = new HttpCivicFixApi({ baseUrl: '', timeoutMs: 1000 });

    const result = await api.getComplaint('CF-2026-00001');
    expect(result).toMatchObject({ publicId: 'CF-2026-00001', status: 'UNDER_REVIEW' });
    expect(result?.history).toEqual([
      { status: 'REPORTED', at: '2026-10-24T10:00:00.000Z' },
      { status: 'UNDER_REVIEW', at: '2026-10-24T10:05:00.000Z', note: 'Sent for review.' },
    ]);
    expect(result).not.toHaveProperty('department');
    expect(result).not.toHaveProperty('priority');
  });

  it('restores the session from the refresh cookie on start-up, with the CSRF header', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(ok(session)).mockResolvedValueOnce(departments());
    vi.stubGlobal('fetch', fetchMock);
    const api = new HttpCivicFixApi({ baseUrl: '', timeoutMs: 1000 });

    await expect(api.getCurrentUser()).resolves.toMatchObject({ id: 'u1', role: 'department_manager' });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/v1/auth/refresh');
    expect(headerOf(fetchMock.mock.calls[0]!, 'X-Requested-With')).toBe('civicfix');
  });

  it('treats a rejected refresh as signed out', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fail(401, 'UNAUTHENTICATED')));
    const api = new HttpCivicFixApi({ baseUrl: '', timeoutMs: 1000 });
    await expect(api.getCurrentUser()).resolves.toBeNull();
  });

  it('runs only one refresh when several calls start at once', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(fail(401, 'UNAUTHENTICATED')));
    vi.stubGlobal('fetch', fetchMock);
    const api = new HttpCivicFixApi({ baseUrl: '', timeoutMs: 1000 });

    await Promise.all([api.getCurrentUser(), api.getCurrentUser(), api.getCurrentUser()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes an expired access token once and retries the request', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok(session)) // login
      .mockResolvedValueOnce(departments())
      .mockResolvedValueOnce(fail(401, 'UNAUTHENTICATED')) // token expired
      .mockResolvedValueOnce(ok({ ...session, accessToken: 'token-2' })) // refresh
      .mockResolvedValueOnce(ok({ complaint })); // retry
    vi.stubGlobal('fetch', fetchMock);
    const api = new HttpCivicFixApi({ baseUrl: '', timeoutMs: 1000 });
    await api.login({ email: 'asha@example.test', password: 'secret-pass' });

    await expect(api.getComplaint('CF-2026-00001')).resolves.toMatchObject({ publicId: 'CF-2026-00001' });
    expect(fetchMock.mock.calls[3]![0]).toBe('/api/v1/auth/refresh');
    expect(headerOf(fetchMock.mock.calls[4]!, 'Authorization')).toBe('Bearer token-2');
  });

  it('reads the error code and message from the backend error envelope', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fail(403, 'FORBIDDEN', 'Not allowed')));
    const api = new HttpCivicFixApi({ baseUrl: '', timeoutMs: 1000 });

    await expect(api.listMyComplaints()).rejects.toMatchObject<Partial<ApiError>>({ status: 403, code: 'FORBIDDEN', message: 'Not allowed' });
  });

  it('rejects malformed complaint records instead of returning a false empty result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok([{ publicId: 'CF-2026-00001' }])));
    const api = new HttpCivicFixApi({ baseUrl: '', timeoutMs: 1000 });

    await expect(api.listMyComplaints()).rejects.toMatchObject({ status: 502, code: 'INVALID_RESPONSE' });
  });

  it('checks each photo, creates the complaint, then uploads each photo as raw evidence', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok({ allowed: true, message: null }))
      .mockResolvedValueOnce(json({ success: true, data: { complaint: { ...complaint, publicId: 'CF-2026-00420' } } }, 201))
      .mockResolvedValueOnce(json({ success: true, data: { evidence: { id: 'e1' } } }, 201));
    vi.stubGlobal('fetch', fetchMock);
    const api = new HttpCivicFixApi({ baseUrl: '', timeoutMs: 1000 });
    const photo = new File(['photo'], 'issue.png', { type: 'image/png' });

    const created = await api.submitComplaint({
      title: 'Pothole',
      description: 'A deep pothole near the bus stop.',
      location: { lat: 13.0108, lng: 74.7943 },
      selectedCategory: 'roads',
      photos: [photo],
    });
    expect(created).toMatchObject({ publicId: 'CF-2026-00420', photoCount: 1 });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/v1/evidence/check');
    expect((fetchMock.mock.calls[0]![1] as RequestInit).body).toBe(photo);
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ title: 'Pothole', description: 'A deep pothole near the bus stop.', location: { lat: 13.0108, lng: 74.7943 }, selectedCategory: 'roads' }),
    });
    expect(fetchMock.mock.calls[2]![0]).toBe('/api/v1/complaints/CF-2026-00420/evidence?purpose=COMPLAINT_REPORT');
    expect(headerOf(fetchMock.mock.calls[2]!, 'Content-Type')).toBe('image/png');
    expect((fetchMock.mock.calls[2]![1] as RequestInit).body).toBe(photo);
  });

  it('sends the in-app camera stamp with a captured file', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => json({ success: true, data: { evidence: { id: 'e1' } } }, 201));
    vi.stubGlobal('fetch', fetchMock);
    const api = new HttpCivicFixApi({ baseUrl: '', timeoutMs: 1000 });
    const photo = new File(['jpeg'], 'photo.jpg', { type: 'image/jpeg' });
    tagCapture(photo, { token: 'tok', capturedAt: '2026-10-25T10:00:00.000Z', lat: 13.0077, lng: 74.7947, accuracy: 6.2 });

    await api.uploadEvidence('CF-2026-00001', photo, 'RESOLUTION');
    const call = fetchMock.mock.calls[0]!;
    expect(headerOf(call, 'X-Capture-Token')).toBe('tok');
    expect(headerOf(call, 'X-Captured-At')).toBe('2026-10-25T10:00:00.000Z');
    expect(headerOf(call, 'X-Capture-Lat')).toBe('13.0077');
    expect(headerOf(call, 'X-Capture-Accuracy')).toBe('6');

    await api.uploadEvidence('CF-2026-00001', new File(['jpeg'], 'gallery.jpg', { type: 'image/jpeg' }), 'RESOLUTION');
    expect(headerOf(fetchMock.mock.calls[1]!, 'X-Capture-Token')).toBeNull();
  });

  it('does not create the complaint when a photo looks AI-generated or edited', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(ok({ allowed: false, message: 'This file looks AI-generated or edited, so it was not accepted.' }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new HttpCivicFixApi({ baseUrl: '', timeoutMs: 1000 });

    await expect(api.submitComplaint({
      title: 'Pothole',
      description: 'A deep pothole near the bus stop.',
      location: { lat: 13.0108, lng: 74.7943 },
      selectedCategory: 'roads',
      photos: [new File(['x'], 'fake.jpg', { type: 'image/jpeg' })],
    })).rejects.toMatchObject({ status: 422, code: 'MEDIA_REJECTED', message: expect.stringContaining('"fake.jpg"') });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the complaint when a photo upload fails and reports how many failed', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(ok({ allowed: true, message: null }))
      .mockResolvedValueOnce(json({ success: true, data: { complaint } }, 201))
      .mockResolvedValueOnce(fail(503, 'SERVICE_UNAVAILABLE')));
    const api = new HttpCivicFixApi({ baseUrl: '', timeoutMs: 1000 });

    const created = await api.submitComplaint({
      title: 'Pothole',
      description: 'A deep pothole near the bus stop.',
      location: { lat: 13.0108, lng: 74.7943 },
      selectedCategory: null,
      photos: [new File(['x'], 'a.jpg', { type: 'image/jpeg' })],
    });
    expect(created).toMatchObject({ publicId: 'CF-2026-00001', photoCount: 0, photoUploadFailures: 1 });
  });

  it('lists department complaints with the department scope and keeps staff fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok([{ ...complaint, reporter: { alias: 'Reporter #abc123' } }]));
    vi.stubGlobal('fetch', fetchMock);
    const api = new HttpCivicFixApi({ baseUrl: '', timeoutMs: 1000 });

    const items = await api.listDepartmentComplaints({ departmentId: 'd1', membershipRole: 'member' });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/v1/complaints?scope=department&departmentId=d1&sort=-updatedAt&page=1&limit=100');
    expect(items[0]).toMatchObject({ departmentName: 'Roads and Public Works', departmentId: 'd1', priority: 'P1', reporterAlias: 'Reporter #abc123' });
  });

  it('follows pagination until the last page', async () => {
    const page = (n: number, hasNextPage: boolean) => ok([{ ...complaint, publicId: `CF-2026-0000${n}` }], { pagination: { page: n, limit: 100, total: 2, totalPages: 2, hasNextPage } });
    const fetchMock = vi.fn().mockResolvedValueOnce(page(1, true)).mockResolvedValueOnce(page(2, false));
    vi.stubGlobal('fetch', fetchMock);
    const api = new HttpCivicFixApi({ baseUrl: '', timeoutMs: 1000 });

    const items = await api.listPlatformComplaints();
    expect(items.map((c) => c.publicId)).toEqual(['CF-2026-00001', 'CF-2026-00002']);
    expect(fetchMock.mock.calls[1]![0]).toContain('page=2');
  });

  it('posts work-order actions with only the allowed body fields', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(ok({ workOrder: { publicId: 'WO-2026-00001' } })));
    vi.stubGlobal('fetch', fetchMock);
    const api = new HttpCivicFixApi({ baseUrl: '', timeoutMs: 1000 });

    await api.workOrderAction('WO-2026-00001', { action: 'block', reason: 'No asphalt', nextAction: 'Order more' });
    await api.workOrderAction('WO-2026-00001', { action: 'accept' });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/v1/work-orders/WO-2026-00001/block');
    expect((fetchMock.mock.calls[0]![1] as RequestInit).body).toBe(JSON.stringify({ reason: 'No asphalt', nextAction: 'Order more' }));
    expect((fetchMock.mock.calls[1]![1] as RequestInit).body).toBe('{}');
  });

  it('logs out with the CSRF header and forgets the token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok(session))
      .mockResolvedValueOnce(departments())
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(fail(401, 'UNAUTHENTICATED'));
    vi.stubGlobal('fetch', fetchMock);
    const api = new HttpCivicFixApi({ baseUrl: '', timeoutMs: 1000 });
    await api.login({ email: 'asha@example.test', password: 'secret-pass' });

    await api.logout();
    expect(fetchMock.mock.calls[2]![0]).toBe('/api/v1/auth/logout');
    expect(headerOf(fetchMock.mock.calls[2]!, 'X-Requested-With')).toBe('civicfix');
    expect(headerOf(fetchMock.mock.calls[2]!, 'Authorization')).toBe('Bearer token-1');
    // No token in memory now, so the next session check goes through refresh (and is refused).
    await expect(api.getCurrentUser()).resolves.toBeNull();
    expect(fetchMock.mock.calls[3]![0]).toBe('/api/v1/auth/refresh');
  });
});
