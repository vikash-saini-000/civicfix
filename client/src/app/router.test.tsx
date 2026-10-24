import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { AuthApi } from '../api/authTypes';
import { AuthProvider } from '../auth/AuthContext';
import { AppRoutes } from './router';

function renderRoutes(initialEntries: string[]) {
  const authApi: AuthApi = {
    getCurrentUser: async () => null,
    login: async () => { throw new Error('not used'); },
    logout: async () => undefined,
  };
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <AuthProvider authApi={authApi}>
        <AppRoutes />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('application routes', () => {
  it('renders the login placeholder', async () => {
    renderRoutes(['/login']);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Log in' })).toBeInTheDocument());
    // The title is set in an effect after the heading renders, so wait for it too.
    await waitFor(() => expect(document.title).toBe('Log in · CivicFix'));
  });

  it('renders a useful not-found screen', () => {
    renderRoutes(['/not-a-real-route']);

    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /civicfix home page/i })).toHaveAttribute('href', '/');
  });
});
