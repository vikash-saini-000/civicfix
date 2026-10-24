import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { ManagerReviewDetailPage, ManagerReviewPage } from './ManagerReviewPage';

describe('manager review blockers', () => {
  it('does not fabricate a review queue or AI output', () => {
    render(
      <MemoryRouter>
        <ManagerReviewPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'Manager review' })).toBeInTheDocument();
    expect(screen.getByText('Manager review queue is not available yet')).toBeInTheDocument();
    expect(screen.queryByText(/confidence/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve|reject|confirm/i })).not.toBeInTheDocument();
  });

  it('does not fabricate analysis for a complaint review detail', () => {
    window.history.pushState({}, '', '/manager/review/CF-2026-00141');
    render(
      <MemoryRouter initialEntries={['/manager/review/CF-2026-00141']}>
        <ManagerReviewDetailPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'Manager review detail' })).toBeInTheDocument();
    expect(screen.getByText(/AI analysis and human review is not available yet/)).toBeInTheDocument();
    expect(screen.queryByText('CF-2026-00141')).not.toBeInTheDocument();
  });
});
