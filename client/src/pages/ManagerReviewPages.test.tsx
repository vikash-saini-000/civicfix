import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { AuthApi } from '../api/authTypes';
import { AuthProvider } from '../auth/AuthContext';
import { ManagerReviewDetailPage, ManagerReviewPage } from './ManagerReviewPage';

const manager: AuthApi = {
  getCurrentUser: vi.fn().mockResolvedValue({
    id: 'm1',
    email: 'manager@example.test',
    displayName: 'Manager',
    role: 'department_manager',
    departmentMemberships: [{ departmentId: 'roads', departmentName: 'Roads', role: 'manager' }],
  }),
  login: vi.fn(),
  logout: vi.fn(),
};

function renderWithAuth(path: string, element: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider authApi={manager}>
        <Routes>
          <Route path="/manager/review" element={element} />
          <Route path="/manager/review/:complaintId" element={element} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('manager review without a backend', () => {
  it('does not fabricate a review queue or AI output', async () => {
    renderWithAuth('/manager/review', <ManagerReviewPage />);

    expect(screen.getByRole('heading', { name: 'Complaint review' })).toBeInTheDocument();
    expect(await screen.findByText(/needs the CivicFix backend/)).toBeInTheDocument();
    expect(screen.queryByText(/certainty/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create work order|reject complaint/i })).not.toBeInTheDocument();
  });

  it('does not fabricate analysis for a complaint review detail', async () => {
    renderWithAuth('/manager/review/CF-2026-00141', <ManagerReviewDetailPage />);

    expect(await screen.findByRole('heading', { name: /unavailable|not found/i })).toBeInTheDocument();
    expect(screen.queryByText(/AI analysis/)).not.toBeInTheDocument();
  });
});
