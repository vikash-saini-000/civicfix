import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { AuthApi, AuthUser, Role } from '../api/authTypes';
import { ApiError } from '../api/errors';
import type { DepartmentApi, StaffComplaint } from '../api/types';
import { AuthProvider } from '../auth/AuthContext';
import { DepartmentComplaintDetailPage } from './DepartmentComplaintDetailPage';
import { DepartmentComplaintsPage } from './DepartmentComplaintsPage';
import { DepartmentWorkspacePage } from './DepartmentWorkspacePage';

vi.mock('react-leaflet', () => ({
  CircleMarker: () => null,
  MapContainer: ({ children }: { children: ReactNode }) => <div data-testid="map">{children}</div>,
  TileLayer: () => null,
}));

function makeUser(role: Role = 'department_member', memberships = [{ departmentId: 'roads', departmentName: 'Roads and Public Works', role: 'member' as const }]): AuthUser {
  return { id: `${role}-1`, email: `${role}@example.test`, displayName: `Test ${role}`, role, departmentMemberships: memberships };
}

function makeAuthApi(user: AuthUser | null): AuthApi {
  return {
    getCurrentUser: vi.fn().mockResolvedValue(user),
    login: vi.fn().mockResolvedValue({ user: user ?? makeUser() }),
    logout: vi.fn().mockResolvedValue(undefined),
  };
}

function makeComplaint(overrides: Partial<StaffComplaint> = {}): StaffComplaint {
  return {
    publicId: 'CF-2026-00141',
    title: 'Deep pothole near the bus stop',
    description: 'A deep pothole makes the road unsafe for two-wheelers.',
    location: { lat: 13.0072, lng: 74.7956 },
    landmark: 'Surathkal bus stop',
    selectedCategory: 'roads',
    confirmedCategory: 'roads',
    status: 'IN_PROGRESS',
    priority: 'P2',
    departmentName: 'Roads and Public Works',
    photoCount: 2,
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-24T10:00:00.000Z',
    history: [{ status: 'IN_PROGRESS', at: '2026-10-24T10:00:00.000Z', note: 'Crew is on site.' }],
    ...overrides,
  };
}

function makeDepartmentApi(overrides: Partial<DepartmentApi> = {}): DepartmentApi {
  return {
    listDepartmentComplaints: vi.fn().mockResolvedValue([makeComplaint()]),
    getDepartmentComplaint: vi.fn().mockResolvedValue(makeComplaint()),
    ...overrides,
  };
}

function renderPage(ui: ReactNode, path = '/department') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider authApi={makeAuthApi(makeUser())}>{ui}</AuthProvider>
    </MemoryRouter>,
  );
}

describe('department workspace pages', () => {
  it('shows department-scoped counts and recent complaints without exposing private fields', async () => {
    const complaint = makeComplaint({ publicId: 'CF-2026-00001' });
    const api = makeDepartmentApi({ listDepartmentComplaints: vi.fn().mockResolvedValue([complaint, makeComplaint({ publicId: 'CF-2026-00002', status: 'REPORTED', priority: 'P3' })]) });
    renderPage(<DepartmentWorkspacePage departmentApi={api} />);

    await waitFor(() => expect(screen.getByLabelText('Visible complaints: 2')).toBeInTheDocument());
    expect(screen.getByLabelText('Visible complaints: 2')).toBeInTheDocument();
    expect(screen.getByLabelText('In progress: 1')).toBeInTheDocument();
    expect(screen.getAllByText('Deep pothole near the bus stop').length).toBeGreaterThan(0);
    expect(screen.queryByText('citizen@example.test')).not.toBeInTheDocument();
  });

  it('filters the authorized department list by supported fields and resets filters', async () => {
    const api = makeDepartmentApi({
      listDepartmentComplaints: vi.fn().mockResolvedValue([
        makeComplaint({ publicId: 'CF-2026-00001', title: 'Pothole at market', priority: 'P2' }),
        makeComplaint({ publicId: 'CF-2026-00002', title: 'Streetlight near school', status: 'REPORTED', priority: 'P3', selectedCategory: 'streetlight', confirmedCategory: 'streetlight' }),
      ]),
    });
    renderPage(<DepartmentComplaintsPage departmentApi={api} />, '/department/complaints');

    await waitFor(() => expect(screen.getByText('Pothole at market')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: 'P3' } });
    expect(screen.getByText('Streetlight near school')).toBeInTheDocument();
    expect(screen.queryByText('Pothole at market')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(screen.getByText('Pothole at market')).toBeInTheDocument();
  });

  it('keeps failures distinct from an empty department response and retries', async () => {
    const listDepartmentComplaints = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([]);
    renderPage(<DepartmentComplaintsPage departmentApi={makeDepartmentApi({ listDepartmentComplaints })} />, '/department/complaints');

    await waitFor(() => expect(screen.getByText('We could not load department complaints')).toBeInTheDocument());
    expect(screen.queryByText('No visible department complaints')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText('No visible department complaints')).toBeInTheDocument());
    expect(listDepartmentComplaints).toHaveBeenCalledTimes(2);
  });

  it('renders staff detail fields and handles unknown future values safely', async () => {
    const complaint = makeComplaint({ status: 'FUTURE_STATUS', priority: 'P5', history: [{ status: 'FUTURE_STATUS', at: '2026-10-24T10:00:00.000Z' }] });
    renderPage(
      <Routes>
        <Route path="/department/complaints/:complaintId" element={<DepartmentComplaintDetailPage departmentApi={makeDepartmentApi({ getDepartmentComplaint: vi.fn().mockResolvedValue(complaint) })} />} />
      </Routes>,
      '/department/complaints/CF-2026-00141',
    );

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Deep pothole near the bus stop' })).toBeInTheDocument());
    expect(screen.getAllByText('Status update').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Priority update').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Roads and Public Works').length).toBeGreaterThan(0);
    expect(screen.getByText('Reported location')).toBeInTheDocument();
  });

  it('handles forbidden staff detail responses without exposing backend details', async () => {
    renderPage(
      <Routes>
        <Route path="/department/complaints/:complaintId" element={<DepartmentComplaintDetailPage departmentApi={makeDepartmentApi({ getDepartmentComplaint: vi.fn().mockRejectedValue(new ApiError('private stack trace', 403, 'FORBIDDEN')) })} />} />
      </Routes>,
      '/department/complaints/CF-2026-00141',
    );

    await waitFor(() => expect(screen.getByText('You cannot view this complaint')).toBeInTheDocument());
    expect(screen.queryByText('private stack trace')).not.toBeInTheDocument();
  });

  it('cannot select a department that is not in the authenticated memberships', async () => {
    const user = makeUser('department_member', [{ departmentId: 'roads', departmentName: 'Roads and Public Works', role: 'member' }]);
    render(
      <MemoryRouter initialEntries={['/department?department=private-department']}>
        <AuthProvider authApi={makeAuthApi(user)}>
          <DepartmentWorkspacePage departmentApi={makeDepartmentApi()} />
        </AuthProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText(/The requested department is not one of your authenticated memberships/)).toBeInTheDocument());
    expect(screen.queryByText('Deep pothole near the bus stop')).not.toBeInTheDocument();
  });
});
