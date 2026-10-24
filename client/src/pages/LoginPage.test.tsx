import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { AuthApi, AuthUser } from '../api/authTypes';
import { ApiError } from '../api/errors';
import { AuthProvider } from '../auth/AuthContext';
import { LoginPage } from './PlaceholderPages';

function makeUser(): AuthUser {
  return { id: 'citizen-1', email: 'citizen@example.test', displayName: 'Citizen User', role: 'citizen' };
}

function makeAuthApi(overrides: Partial<AuthApi> = {}): AuthApi {
  return {
    getCurrentUser: vi.fn().mockResolvedValue(null),
    login: vi.fn().mockResolvedValue({ user: makeUser() }),
    logout: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}

function renderLogin(authApi: AuthApi, next = '/citizen') {
  return render(
    <MemoryRouter initialEntries={[`/login?next=${encodeURIComponent(next)}`]}>
      <AuthProvider authApi={authApi}>
        <Routes>
          <Route path="*" element={<><LoginPage /><LocationProbe /></>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('LoginPage', () => {
  it('shows actionable validation and does not submit invalid credentials', () => {
    const login = vi.fn();
    renderLogin(makeAuthApi({ login }));

    fireEvent.submit(document.querySelector('form')!);

    expect(screen.getAllByText('Enter a valid email address.')).toHaveLength(2);
    expect(screen.getAllByText('Enter your password.')).toHaveLength(2);
    expect(login).not.toHaveBeenCalled();
  });

  it('prevents duplicate submissions while login is pending', async () => {
    let resolveLogin!: (value: { user: AuthUser }) => void;
    const login = vi.fn(() => new Promise<{ user: AuthUser }>((resolve) => { resolveLogin = resolve; }));
    renderLogin(makeAuthApi({ login }));

    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'citizen@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'demo-password' } });
    fireEvent.submit(document.querySelector('form')!);
    fireEvent.submit(document.querySelector('form')!);

    expect(login).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled();
    resolveLogin({ user: makeUser() });
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/citizen'));
  });

  it('shows a safe authentication error and preserves the entered email', async () => {
    renderLogin(makeAuthApi({ login: vi.fn().mockRejectedValue(new ApiError('internal auth detail', 401)) }));

    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'citizen@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong-password' } });
    fireEvent.submit(document.querySelector('form')!);

    await waitFor(() => expect(screen.getByText('The email or password is incorrect.')).toBeInTheDocument());
    expect(screen.getByLabelText('Email address')).toHaveValue('citizen@example.test');
    expect(screen.queryByText('internal auth detail')).not.toBeInTheDocument();
  });

  it('rejects an external next destination and uses the validated role default', async () => {
    const authApi = makeAuthApi();
    renderLogin(authApi, 'https://example.com/steal-session');

    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'citizen@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'demo-password' } });
    fireEvent.submit(document.querySelector('form')!);

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/citizen/dashboard'));
    expect(screen.getByTestId('location')).not.toHaveTextContent('example.com');
  });

  it('provides an accessible show and hide password control', () => {
    renderLogin(makeAuthApi());
    const password = screen.getByLabelText('Password');
    const toggle = screen.getByRole('button', { name: 'Show password' });

    expect(password).toHaveAttribute('type', 'password');
    fireEvent.click(toggle);
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute('aria-pressed', 'true');
  });
});
