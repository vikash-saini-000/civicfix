import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { PlatformAnalyticsApi, PlatformComplaint } from '../api/types';
import { AdminDashboardPage } from './AdminDashboardPage';

function makeComplaint(overrides: Partial<PlatformComplaint> = {}): PlatformComplaint {
  return {
    publicId: 'CF-2026-00001',
    title: 'Pothole near the bus stop',
    description: 'A deep pothole is affecting traffic.',
    location: { lat: 13, lng: 74 },
    selectedCategory: 'roads',
    confirmedCategory: 'roads',
    status: 'IN_PROGRESS',
    createdAt: '2026-10-24T01:00:00.000Z',
    updatedAt: '2026-10-24T02:00:00.000Z',
    history: [{ status: 'IN_PROGRESS', at: '2026-10-24T02:00:00.000Z' }],
    departmentName: 'Roads and Public Works',
    priority: 'P2',
    ...overrides,
  };
}

function renderPage(analyticsApi: PlatformAnalyticsApi) {
  return render(
    <MemoryRouter>
      <AdminDashboardPage analyticsApi={analyticsApi} now={new Date('2026-10-24T12:00:00.000Z')} />
    </MemoryRouter>,
  );
}

describe('AdminDashboardPage', () => {
  it('renders real values, accessible tables, and supported date filters', async () => {
    const analyticsApi = { listPlatformComplaints: vi.fn().mockResolvedValue([
      makeComplaint(),
      makeComplaint({ publicId: 'CF-2026-00002', status: 'CLOSED', createdAt: '2026-10-01T01:00:00.000Z', departmentName: 'Waste' }),
    ]) };
    renderPage(analyticsApi);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Summary metrics' })).toBeInTheDocument());
    expect(screen.getByLabelText('Total reports: 2')).toBeInTheDocument();
    expect(screen.getByLabelText('Unresolved reports: 1')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Category' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Department' })).toBeInTheDocument();
    expect(screen.getByText('Roads and Public Works')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: 'Date range' }), { target: { value: '7' } });
    expect(screen.getByLabelText('Total reports: 1')).toBeInTheDocument();
    expect(screen.getByText(/Showing 1 of 2 unique reports/)).toBeInTheDocument();
  });

  it('shows a clear invalid custom range without calculating misleading metrics', async () => {
    const analyticsApi = { listPlatformComplaints: vi.fn().mockResolvedValue([makeComplaint()]) };
    renderPage(analyticsApi);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Summary metrics' })).toBeInTheDocument());
    fireEvent.change(screen.getByRole('combobox', { name: 'Date range' }), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-10-25' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-10-24' } });

    expect(screen.getAllByText('The start date must be on or before the end date.')).toHaveLength(2);
    expect(screen.queryByRole('heading', { name: 'Summary metrics' })).not.toBeInTheDocument();
  });

  it('does not fabricate data when the backend analytics capability is unavailable', async () => {
    const analyticsApi = { listPlatformComplaints: vi.fn().mockRejectedValue(new Error('missing contract')) };
    renderPage(analyticsApi);

    await waitFor(() => expect(screen.getByText('We could not load platform analytics')).toBeInTheDocument());
    expect(screen.queryByText(/Total reports/i)).not.toBeInTheDocument();
  });
});
