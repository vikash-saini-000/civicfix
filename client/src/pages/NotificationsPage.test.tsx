import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { AuthApi, AuthUser, Role } from '../api/authTypes';
import type { ComplaintApi } from '../api/types';
import type { Complaint } from '../lib/domain';
import { AuthProvider } from '../auth/AuthContext';
import { NotificationsPage } from './NotificationsPage';

function makeUser(role: Role = 'citizen'): AuthUser {
  return { id: `${role}-1`, email: `${role}@example.test`, displayName: `Test ${role}`, role };
}

function makeComplaint(overrides: Partial<Complaint> = {}): Complaint {
  return {
    publicId: 'CF-2026-00001',
    title: 'Deep pothole near the bus stop',
    description: 'A deep pothole is affecting traffic.',
    location: { lat: 13, lng: 74 },
    selectedCategory: 'roads',
    confirmedCategory: 'roads',
    status: 'IN_PROGRESS',
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-24T00:00:00.000Z',
    history: [
      { status: 'REPORTED', at: '2026-10-20T00:00:00.000Z' },
      { status: 'IN_PROGRESS', at: '2026-10-24T00:00:00.000Z', note: 'Crew is on site.' },
    ],
    ...overrides,
  };
}

function makeComplaintApi(overrides: Partial<ComplaintApi> = {}): ComplaintApi {
  return {
    capabilities: { photoAttachments: false },
    listMyComplaints: vi.fn().mockResolvedValue([makeComplaint()]),
    getComplaint: vi.fn().mockResolvedValue(makeComplaint()),
    submitComplaint: vi.fn(),
    ...overrides,
  };
}

function renderPage(complaintApi: ComplaintApi, user: AuthUser = makeUser()) {
  const authApi: AuthApi = {
    getCurrentUser: vi.fn().mockResolvedValue(user),
    login: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
  };
  return render(
    <MemoryRouter initialEntries={['/notifications']}>
      <AuthProvider authApi={authApi}>
        <NotificationsPage complaintApi={complaintApi} />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('NotificationsPage', () => {
  it('shows supported citizen activity without inventing unread notification state', async () => {
    const complaintApi = makeComplaintApi({
      listMyComplaints: vi.fn().mockResolvedValue([
        makeComplaint(),
        makeComplaint({ publicId: 'cf-2026-00001' }),
      ]),
    });
    const { container } = renderPage(complaintApi);

    await waitFor(() => expect(screen.getByText('Persistent notifications are not configured')).toBeInTheDocument());
    expect(screen.getByText('Crew is on site.')).toBeInTheDocument();
    const complaintLinks = screen.getAllByRole('link', { name: 'Deep pothole near the bus stop' });
    expect(complaintLinks).toHaveLength(2);
    expect(complaintLinks[0]).toHaveAttribute('href', '/citizen/complaints/CF-2026-00001');
    expect(screen.queryByText(/^Unread notifications?/i)).not.toBeInTheDocument();
    expect(screen.getAllByText('In progress')).toHaveLength(1);
    expect(screen.getByText('Showing 2 recent public updates.')).toBeInTheDocument();
    for (const control of container.querySelectorAll('a, button, input, select, textarea')) {
      expect(control).toHaveAccessibleName();
    }
  });

  it('refreshes supported activity when the window becomes active', async () => {
    const listMyComplaints = vi.fn().mockResolvedValue([makeComplaint()]);
    renderPage(makeComplaintApi({ listMyComplaints }));

    await waitFor(() => expect(screen.getByText('Showing 2 recent public updates.')).toBeInTheDocument());
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(listMyComplaints).toHaveBeenCalledTimes(2));
  });

  it('distinguishes an empty public history from a failed request and supports retry', async () => {
    const listMyComplaints = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([makeComplaint({ history: [] })]);
    renderPage(makeComplaintApi({ listMyComplaints }));

    await waitFor(() => expect(screen.getByText('We could not load recent activity')).toBeInTheDocument());
    expect(screen.queryByText('No public activity yet')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText('No public activity yet')).toBeInTheDocument());
    expect(listMyComplaints).toHaveBeenCalledTimes(2);
  });

  it('does not use the citizen complaint endpoint for staff notifications', async () => {
    const complaintApi = makeComplaintApi();
    renderPage(complaintApi, makeUser('department_member'));

    await waitFor(() => expect(screen.getByText('Notifications are not available for this account yet')).toBeInTheDocument());
    expect(complaintApi.listMyComplaints).not.toHaveBeenCalled();
  });
});
