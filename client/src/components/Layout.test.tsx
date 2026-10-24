import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { AuthApi } from '../api/authTypes';
import { AuthProvider } from '../auth/AuthContext';
import { Layout } from './Layout';

function makeAuthApi(): AuthApi {
  return {
    getCurrentUser: vi.fn().mockResolvedValue({
      id: 'citizen-1',
      email: 'citizen@example.test',
      displayName: 'Test Citizen',
      role: 'citizen',
    }),
    login: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
  };
}

describe('Layout accessibility behavior', () => {
  it('moves focus into the mobile menu and restores it on Escape', async () => {
    render(
      <MemoryRouter>
        <AuthProvider authApi={makeAuthApi()}>
          <Layout />
        </AuthProvider>
      </MemoryRouter>,
    );

    const menuButton = await waitFor(() => screen.getByRole('button', { name: 'Open navigation menu' }));
    fireEvent.click(menuButton);

    const mobileNavigation = screen.getByRole('navigation', { name: 'Mobile navigation' });
    const mobileDashboard = within(mobileNavigation).getByRole('link', { name: 'Dashboard' });
    expect(menuButton).toHaveAttribute('aria-expanded', 'true');
    expect(document.activeElement).toBe(mobileDashboard);

    fireEvent.keyDown(mobileNavigation, { key: 'Escape' });
    expect(menuButton).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(menuButton);
  });
});
