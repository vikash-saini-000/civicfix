import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import type { AuthApi, Role } from '../api/authTypes';
import type { ComplaintAnalysis } from '../api/operationsTypes';
import { AuthProvider } from '../auth/AuthContext';
import { AnalysisPanel } from './Workflow';

const authAs = (role: Role): AuthApi => ({
  getCurrentUser: vi.fn().mockResolvedValue({ id: 'u1', email: 'u@example.test', displayName: 'User', role }),
  login: vi.fn(),
  logout: vi.fn(),
});

const failed = (errorCode: string) =>
  ({
    aiEnabled: true,
    classification: { status: 'FAILED', errorCode },
    duplicates: { status: 'SUCCEEDED', candidates: [] },
    media: [],
  }) as unknown as ComplaintAnalysis;

function renderPanel(role: Role) {
  return render(
    <AuthProvider authApi={authAs(role)}>
      <AnalysisPanel publicId="CF-2026-00095" />
    </AuthProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('AI analysis panel', () => {
  it('says plainly when AI credits are exhausted, and lets an admin re-run the AI', async () => {
    const getAnalysis = vi.spyOn(api, 'getAnalysis').mockResolvedValue(failed('CREDITS_EXHAUSTED'));
    const rerun = vi.spyOn(api, 'rerunAnalysis').mockResolvedValue();
    renderPanel('platform_admin');

    expect(await screen.findByText(/AI credits exhausted/)).toBeInTheDocument();
    expect(screen.getByText(/Top up the AI credits/)).toBeInTheDocument();
    expect(screen.queryByText(/BAD_REQUEST|CREDITS_EXHAUSTED/)).not.toBeInTheDocument();

    const button = await screen.findByRole('button', { name: 'Re-run AI' });
    fireEvent.click(button);
    await waitFor(() => expect(rerun).toHaveBeenCalledWith('CF-2026-00095'));
    await waitFor(() => expect(getAnalysis).toHaveBeenCalledTimes(2)); // reloads after queueing
  });

  it('hides the re-run button from non-admins', async () => {
    vi.spyOn(api, 'getAnalysis').mockResolvedValue(failed('TIMEOUT'));
    renderPanel('department_manager');

    expect(await screen.findByText(/the AI service took too long/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Re-run AI' })).not.toBeInTheDocument();
  });

  it('shows a re-run error to the admin', async () => {
    vi.spyOn(api, 'getAnalysis').mockResolvedValue(failed('CREDITS_EXHAUSTED'));
    vi.spyOn(api, 'rerunAnalysis').mockRejectedValue(Object.assign(new Error('Only platform administrators can re-run analysis.'), {}));
    renderPanel('platform_admin');

    fireEvent.click(await screen.findByRole('button', { name: 'Re-run AI' }));
    expect(await screen.findByText(/could not be completed/)).toBeInTheDocument();
  });
});
