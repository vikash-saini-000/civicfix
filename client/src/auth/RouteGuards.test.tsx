import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { AuthApi, AuthUser, Role } from '../api/authTypes';
import { AuthProvider } from './AuthContext';
import { AppRoutes } from '../app/router';

function makeUser(role: Role): AuthUser {
  return { id: `${role}-1`, email: `${role}@example.test`, displayName: `Test ${role}`, role };
}

function makeAuthApi(user: AuthUser | null): AuthApi {
  return {
    getCurrentUser: vi.fn().mockResolvedValue(user),
    login: vi.fn().mockResolvedValue({ user: user ?? makeUser('citizen') }),
    logout: vi.fn().mockResolvedValue(undefined),
  };
}

function renderAt(path: string, authApi: AuthApi) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider authApi={authApi}>
        <AppRoutes />
        <CurrentLocation />
      </AuthProvider>
    </MemoryRouter>,
  );
}

function CurrentLocation() {
  const location = useLocation();
  return <output data-testid="current-location">{location.pathname}{location.search}</output>;
}

describe('protected route behavior', () => {
  it('redirects an unauthenticated user to login with the internal destination', async () => {
    renderAt('/manager/review?filter=open', makeAuthApi(null));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Log in' })).toBeInTheDocument());
    expect(screen.getByTestId('current-location')).toHaveTextContent('/login?next=%2Fmanager%2Freview%3Ffilter%3Dopen');
  });

  it('protects the citizen complaint submission route with the existing guard', async () => {
    renderAt('/citizen/complaints/new', makeAuthApi(null));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Log in' })).toBeInTheDocument());
    expect(screen.getByTestId('current-location')).toHaveTextContent('/login?next=%2Fcitizen%2Fcomplaints%2Fnew');
  });

  it('protects the citizen tracking routes with the existing guard', async () => {
    renderAt('/citizen/complaints/CF-2026-00141', makeAuthApi(null));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Log in' })).toBeInTheDocument());
    expect(screen.getByTestId('current-location')).toHaveTextContent('/login?next=%2Fcitizen%2Fcomplaints%2FCF-2026-00141');
  });

  it('protects the canonical citizen dashboard route with the existing guard', async () => {
    renderAt('/citizen/dashboard', makeAuthApi(null));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Log in' })).toBeInTheDocument());
    expect(screen.getByTestId('current-location')).toHaveTextContent('/login?next=%2Fcitizen%2Fdashboard');
  });

  it('allows a validated citizen to open the citizen dashboard', async () => {
    renderAt('/citizen', makeAuthApi(makeUser('citizen')));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Citizen dashboard' })).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'My complaints' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Department workspace' })).not.toBeInTheDocument();
  });

  it('allows a validated citizen to open the canonical complaints list', async () => {
    renderAt('/citizen/complaints', makeAuthApi(makeUser('citizen')));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'My complaints' })).toBeInTheDocument());
    expect(screen.getAllByRole('link', { name: 'Report an issue' })).toHaveLength(2);
  });

  it('redirects an already authenticated user away from login to the role default', async () => {
    renderAt('/login', makeAuthApi({
      ...makeUser('department_manager'),
      departmentMemberships: [{ departmentId: 'roads', departmentName: 'Roads and Public Works', role: 'manager' }],
    }));

    // Managers land on their department overview.
    await waitFor(() => expect(screen.getByTestId('current-location')).toHaveTextContent(/^\/manager$/));
    expect(await screen.findByRole('heading', { name: 'Department overview' })).toBeInTheDocument();
  });

  it('shows a forbidden state when a citizen opens a manager route', async () => {
    renderAt('/manager', makeAuthApi(makeUser('citizen')));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Access not available' })).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'Department manager workspace' })).not.toBeInTheDocument();
  });

  it('does not allow a department member to open citizen tracking pages', async () => {
    renderAt('/citizen/complaints', makeAuthApi(makeUser('department_member')));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Access not available' })).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'My complaints' })).not.toBeInTheDocument();
  });

  it('does not allow a platform administrator to open the citizen dashboard', async () => {
    renderAt('/citizen/dashboard', makeAuthApi(makeUser('platform_admin')));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Access not available' })).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'Citizen dashboard' })).not.toBeInTheDocument();
  });

  it('renders department navigation only for a department member', async () => {
    renderAt('/department', makeAuthApi({
      ...makeUser('department_member'),
      departmentMemberships: [{ departmentId: 'roads', departmentName: 'Roads and Public Works', role: 'member' }],
    }));

    await waitFor(() => expect(screen.getByRole('heading', { name: /workspace$/i })).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Department complaints' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Platform overview' })).not.toBeInTheDocument();
  });

  it('fails safely when a department member has no department membership', async () => {
    renderAt('/department', makeAuthApi(makeUser('department_member')));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Department access is not configured' })).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: 'Department complaints' })).toBeInTheDocument();
  });

  it('allows a department manager with a membership to open the read-only department workspace', async () => {
    renderAt('/department', makeAuthApi({
      ...makeUser('department_manager'),
      departmentMemberships: [{ departmentId: 'roads', departmentName: 'Roads and Public Works', role: 'manager' }],
    }));

    await waitFor(() => expect(screen.getByRole('heading', { name: /workspace$/i })).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Complaints' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Overview' })).toBeInTheDocument();
  });

  it('allows an authenticated user to open the notifications contract state', async () => {
    renderAt('/notifications', makeAuthApi(makeUser('citizen')));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Notifications' })).toBeInTheDocument());
    expect(screen.queryByText(/unread count:|unread notifications/i)).not.toBeInTheDocument();
  });

  it('protects notifications from unauthenticated visitors', async () => {
    renderAt('/notifications', makeAuthApi(null));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Log in' })).toBeInTheDocument());
    expect(screen.getByTestId('current-location')).toHaveTextContent('/login?next=%2Fnotifications');
  });

  it('allows only a department manager to open the manager review route', async () => {
    renderAt('/manager/review', makeAuthApi({
      ...makeUser('department_manager'),
      departmentMemberships: [{ departmentId: 'roads', departmentName: 'Roads and Public Works', role: 'manager' }],
    }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Complaint review' })).toBeInTheDocument());
    // The mock adapter has no review queue; the page says the backend is needed instead of inventing data.
    expect(await screen.findByText(/needs the CivicFix backend/)).toBeInTheDocument();
  });

  it('allows only a platform administrator to open the protected platform overview', async () => {
    renderAt('/admin', makeAuthApi(makeUser('platform_admin')));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Summary metrics' })).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Summary metrics' })).toBeInTheDocument();
    expect(screen.getByLabelText('Total reports: 3')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Department workspace' })).not.toBeInTheDocument();
  });

  it('denies a department manager access to the platform overview', async () => {
    renderAt('/admin', makeAuthApi({
      ...makeUser('department_manager'),
      departmentMemberships: [{ departmentId: 'roads', departmentName: 'Roads and Public Works', role: 'manager' }],
    }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Access not available' })).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'Platform overview' })).not.toBeInTheDocument();
  });

  it('denies a department member access to manager review actions', async () => {
    renderAt('/manager/review', makeAuthApi({
      ...makeUser('department_member'),
      departmentMemberships: [{ departmentId: 'roads', departmentName: 'Roads and Public Works', role: 'member' }],
    }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Access not available' })).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'Manager review' })).not.toBeInTheDocument();
  });

  it('does not allow a citizen to open department-only pages', async () => {
    renderAt('/department/complaints', makeAuthApi(makeUser('citizen')));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Access not available' })).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: /complaints$/i })).not.toBeInTheDocument();
  });

  it('signs out through the authenticated shell', async () => {
    const authApi = makeAuthApi(makeUser('citizen'));
    renderAt('/citizen', authApi);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Log in' })).toBeInTheDocument());
    expect(authApi.logout).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a user has an unknown role', async () => {
    const invalidUser = { ...makeUser('citizen'), role: 'unknown_role' } as unknown as AuthUser;
    renderAt('/citizen', makeAuthApi(invalidUser));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'We could not verify your session' })).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'Citizen dashboard' })).not.toBeInTheDocument();
  });
});
