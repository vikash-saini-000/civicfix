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
    renderAt('/login', makeAuthApi(makeUser('department_manager')));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Department manager workspace' })).toBeInTheDocument());
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
    renderAt('/department', makeAuthApi(makeUser('department_member')));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Department member workspace' })).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Department complaints' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Platform overview' })).not.toBeInTheDocument();
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
