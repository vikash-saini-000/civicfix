import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AuthApi, AuthUser, Role } from '../api/authTypes';
import { ApiError } from '../api/errors';
import { AuthProvider, useAuth } from './AuthContext';

function makeUser(role: Role = 'citizen'): AuthUser {
  return { id: `user-${role}`, email: `${role}@example.test`, displayName: `Test ${role}`, role };
}

function makeAuthApi(overrides: Partial<AuthApi> = {}): AuthApi {
  return {
    getCurrentUser: vi.fn().mockResolvedValue(null),
    login: vi.fn().mockResolvedValue({ user: makeUser() }),
    logout: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function AuthProbe() {
  const { state, actionError, login, logout } = useAuth();
  return (
    <div>
      <span data-testid="status">{state.status}</span>
      <span data-testid="user">{state.user?.displayName ?? 'none'}</span>
      <span data-testid="error">{state.error ?? actionError ?? 'none'}</span>
      <button type="button" onClick={() => void login({ email: 'test@example.test', password: 'password' })}>login</button>
      <button type="button" onClick={() => void logout()}>logout</button>
    </div>
  );
}

describe('AuthProvider', () => {
  it('keeps the app in loading state while the initial session check is pending', () => {
    const getCurrentUser = vi.fn(() => new Promise<AuthUser | null>(() => undefined));
    render(
      <AuthProvider authApi={makeAuthApi({ getCurrentUser })}>
        <AuthProbe />
      </AuthProvider>,
    );

    expect(screen.getByTestId('status')).toHaveTextContent('loading');
    expect(getCurrentUser).toHaveBeenCalledTimes(1);
  });

  it('restores a validated session', async () => {
    render(
      <AuthProvider authApi={makeAuthApi({ getCurrentUser: vi.fn().mockResolvedValue(makeUser('department_manager')) })}>
        <AuthProbe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(screen.getByTestId('user')).toHaveTextContent('Test department_manager');
  });

  it('represents an ordinary missing session as unauthenticated', async () => {
    render(
      <AuthProvider authApi={makeAuthApi()}>
        <AuthProbe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));
  });

  it('keeps session-check failures distinct from logged-out state', async () => {
    render(
      <AuthProvider authApi={makeAuthApi({ getCurrentUser: vi.fn().mockRejectedValue(new ApiError('offline', 0, 'NETWORK_ERROR')) })}>
        <AuthProbe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
    expect(screen.getByTestId('error')).toHaveTextContent('could not verify your session');
  });

  it('updates state on login and clears it after logout', async () => {
    const authApi = makeAuthApi({
      login: vi.fn().mockResolvedValue({ user: makeUser('platform_admin') }),
    });
    render(
      <AuthProvider authApi={authApi}>
        <AuthProbe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));
    fireEvent.click(screen.getByRole('button', { name: 'login' }));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(screen.getByTestId('user')).toHaveTextContent('Test platform_admin');

    fireEvent.click(screen.getByRole('button', { name: 'logout' }));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));
    expect(authApi.logout).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the backend returns an unknown role', async () => {
    const invalidUser = { ...makeUser(), role: 'superuser' } as unknown as AuthUser;
    render(
      <AuthProvider authApi={makeAuthApi({ getCurrentUser: vi.fn().mockResolvedValue(invalidUser) })}>
        <AuthProbe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
    expect(screen.getByTestId('user')).toHaveTextContent('none');
  });
});
