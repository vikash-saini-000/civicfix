import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AuthProvider } from '../auth/AuthContext';
import { AppRoutes } from './router';

function renderRoutes(initialEntries: string[]) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('application routes', () => {
  it('renders the login placeholder', async () => {
    renderRoutes(['/login']);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Log in' })).toBeInTheDocument());
    expect(document.title).toBe('Log in · CivicFix');
  });

  it('renders a useful not-found screen', () => {
    renderRoutes(['/not-a-real-route']);

    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /civicfix home page/i })).toHaveAttribute('href', '/');
  });
});
