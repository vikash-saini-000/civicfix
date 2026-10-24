import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { AuthApi } from '../api/authTypes';
import { ApiError } from '../api/errors';
import { AuthProvider } from '../auth/AuthContext';
import { RegisterPage } from './RegisterPage';

const citizen = { id: 'u1', email: 'asha@example.com', displayName: 'Asha Rao', role: 'citizen' as const };

function makeAuthApi(register: AuthApi['register']): AuthApi {
  return {
    getCurrentUser: vi.fn().mockResolvedValue(null),
    login: vi.fn(),
    logout: vi.fn(),
    register,
  };
}

function Destination() {
  const location = useLocation();
  return (
    <output data-testid="destination">
      {location.pathname}|{(location.state as { welcome?: boolean } | null)?.welcome ? 'welcome' : ''}
    </output>
  );
}

function renderRegister(authApi: AuthApi, path = '/register') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider authApi={authApi}>
        <Routes>
          <Route path="/register" element={<RegisterPage />} />
          <Route path="*" element={<Destination />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

function fill({ name = 'Asha Rao', email = '  Asha@Example.com ', password = 'blue river tea cup', confirm, consent = true }: { name?: string; email?: string; password?: string; confirm?: string; consent?: boolean } = {}) {
  confirm ??= password;
  fireEvent.change(screen.getByLabelText('Full name'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: confirm } });
  if (consent) fireEvent.click(screen.getByRole('checkbox'));
}

describe('RegisterPage', () => {
  it('creates a citizen account with only the backend fields and lands on the dashboard with a welcome', async () => {
    const register = vi.fn().mockResolvedValue({ user: citizen });
    renderRegister(makeAuthApi(register));

    await screen.findByRole('heading', { name: 'Create your account' });
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => expect(screen.getByTestId('destination')).toHaveTextContent('/citizen/dashboard|welcome'));
    expect(register).toHaveBeenCalledWith({ name: 'Asha Rao', email: 'asha@example.com', password: 'blue river tea cup' });
  });

  it('shows a focusable summary and does not call the server when the form is invalid', async () => {
    const register = vi.fn();
    renderRegister(makeAuthApi(register));

    await screen.findByRole('heading', { name: 'Create your account' });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText('Fix 4 things to continue')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Email address: Enter your email address/ })).toBeInTheDocument();
    expect(register).not.toHaveBeenCalled();
  });

  it('shows live password strength and a match confirmation', async () => {
    renderRegister(makeAuthApi(vi.fn()));
    await screen.findByRole('heading', { name: 'Create your account' });

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'abc' } });
    expect(screen.getByText('Strength: Too short.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse battery staple' } });
    expect(screen.getByText(/Strength: (Good|Strong)\./)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'correct horse battery staple' } });
    expect(screen.getByText('Passwords match.')).toBeInTheDocument();
  });

  it('explains a taken email and offers to log in with it', async () => {
    const register = vi.fn().mockRejectedValue(
      new ApiError('An account with this email already exists.', 409, 'CONFLICT', [{ field: 'body.email', issue: 'duplicate' }]),
    );
    renderRegister(makeAuthApi(register), '/register?next=%2Fcitizen%2Fcomplaints%2Fnew');

    await screen.findByRole('heading', { name: 'Create your account' });
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findAllByText('An account with this email already exists.')).not.toHaveLength(0);
    expect(screen.getByRole('link', { name: 'Log in instead' })).toHaveAttribute(
      'href',
      '/login?next=%2Fcitizen%2Fcomplaints%2Fnew&email=asha%40example.com',
    );
  });

  it('puts server validation messages on the matching field', async () => {
    const register = vi.fn().mockRejectedValue(
      new ApiError('The request contains invalid fields.', 400, 'VALIDATION_ERROR', [{ field: 'body.email', issue: 'invalid_format', message: 'Must be a valid email address.' }]),
    );
    renderRegister(makeAuthApi(register));

    await screen.findByRole('heading', { name: 'Create your account' });
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('button', { name: 'Email address: Must be a valid email address.' })).toBeInTheDocument();
  });

  it('keeps the details and explains rate limiting', async () => {
    const register = vi.fn().mockRejectedValue(new ApiError('Too many requests.', 429, 'RATE_LIMITED'));
    renderRegister(makeAuthApi(register));

    await screen.findByRole('heading', { name: 'Create your account' });
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText(/Too many accounts were created/)).toBeInTheDocument();
    expect(screen.getByLabelText('Full name')).toHaveValue('Asha Rao');
  });

  it('returns to a requested citizen page after sign-up', async () => {
    renderRegister(makeAuthApi(vi.fn().mockResolvedValue({ user: citizen })), '/register?next=%2Fcitizen%2Fcomplaints%2Fnew');

    await screen.findByRole('heading', { name: 'Create your account' });
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => expect(screen.getByTestId('destination')).toHaveTextContent('/citizen/complaints/new|welcome'));
  });
});
