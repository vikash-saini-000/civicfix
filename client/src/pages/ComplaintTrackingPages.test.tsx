import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/errors';
import type { ComplaintApi } from '../api/types';
import type { Complaint } from '../lib/domain';
import { ComplaintDetailPage } from './ComplaintDetailPage';
import { ComplaintsPage } from './ComplaintsPage';
import { DashboardPage } from './DashboardPage';

vi.mock('react-leaflet', () => ({
  CircleMarker: () => null,
  MapContainer: ({ children }: { children: ReactNode }) => <div data-testid="map">{children}</div>,
  TileLayer: () => null,
}));

function makeComplaint(overrides: Partial<Complaint> = {}): Complaint {
  const base: Complaint = {
    publicId: 'CF-2026-00141',
    title: 'Deep pothole near the bus stop',
    description: 'A deep pothole makes the road unsafe for two-wheelers.',
    location: { lat: 13.0072, lng: 74.7956 },
    landmark: 'Surathkal bus stop',
    selectedCategory: 'roads',
    confirmedCategory: 'roads',
    status: 'IN_PROGRESS',
    photoCount: 2,
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-24T10:00:00.000Z',
    history: [
      { status: 'REPORTED', at: '2026-10-20T10:00:00.000Z' },
      { status: 'IN_PROGRESS', at: '2026-10-24T10:00:00.000Z', note: 'A public update from the team.' },
    ],
  };
  return { ...base, ...overrides };
}

function makeApi(overrides: Partial<ComplaintApi> = {}): ComplaintApi {
  return {
    capabilities: { photoAttachments: false },
    listMyComplaints: vi.fn().mockResolvedValue([makeComplaint()]),
    getComplaint: vi.fn().mockResolvedValue(makeComplaint()),
    submitComplaint: vi.fn(),
    ...overrides,
  };
}

function renderDetail(complaintApi: ComplaintApi, id = 'CF-2026-00141') {
  return render(
    <MemoryRouter initialEntries={[`/citizen/complaints/${id}`]}>
      <Routes>
        <Route path="/citizen/complaints/:complaintId" element={<ComplaintDetailPage complaintApi={complaintApi} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DashboardPage', () => {
  it('derives supported status counts from the authorized complaint list', async () => {
    const complaintApi = makeApi({
      listMyComplaints: vi.fn().mockResolvedValue([
        makeComplaint({ publicId: 'CF-2026-00001', status: 'REPORTED' }),
        makeComplaint({ publicId: 'CF-2026-00002', status: 'UNDER_REVIEW' }),
        makeComplaint({ publicId: 'CF-2026-00003', status: 'CLOSED' }),
      ]),
    });
    render(<MemoryRouter><DashboardPage complaintApi={complaintApi} /></MemoryRouter>);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Citizen dashboard' })).toBeInTheDocument());
    expect(screen.getByLabelText('Total complaints: 3')).toBeInTheDocument();
    expect(screen.getByLabelText('Reported: 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Under review: 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Closed: 1')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Report an issue' })).toHaveAttribute('href', '/citizen/complaints/new');
  });

  it('shows a successful empty state and not a fabricated summary', async () => {
    render(<MemoryRouter><DashboardPage complaintApi={makeApi({ listMyComplaints: vi.fn().mockResolvedValue([]) })} /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText('No complaints yet')).toBeInTheDocument());
    expect(screen.getByText('Total complaints')).toBeInTheDocument();
    expect(screen.getByLabelText('Total complaints: 0')).toBeInTheDocument();
    expect(screen.queryByText('Recent complaints')).not.toBeInTheDocument();
  });

  it('keeps failures distinct from an empty response and supports retry', async () => {
    const listMyComplaints = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([makeComplaint()]);
    render(<MemoryRouter><DashboardPage complaintApi={makeApi({ listMyComplaints })} /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText('We could not load your dashboard')).toBeInTheDocument());
    expect(screen.queryByText('No complaints yet')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText('Recent complaints')).toBeInTheDocument());
    expect(listMyComplaints).toHaveBeenCalledTimes(2);
  });
});

describe('ComplaintsPage', () => {
  it('renders supported fields and filters the authorized list on the client', async () => {
    const complaintApi = makeApi({
      listMyComplaints: vi.fn().mockResolvedValue([
        makeComplaint({ publicId: 'CF-2026-00001', title: 'Streetlight is out', selectedCategory: 'streetlight', confirmedCategory: 'streetlight' }),
        makeComplaint({ publicId: 'CF-2026-00002', title: 'Pothole at market', status: 'REPORTED' }),
      ]),
    });
    render(<MemoryRouter><ComplaintsPage complaintApi={complaintApi} /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText('Streetlight is out')).toBeInTheDocument());
    expect(screen.getByText('CF-2026-00002')).toBeInTheDocument();
    expect(screen.getAllByText('Surathkal bus stop')).toHaveLength(2);

    fireEvent.change(screen.getByLabelText('Search complaints'), { target: { value: 'streetlight' } });
    expect(screen.getByText('Streetlight is out')).toBeInTheDocument();
    expect(screen.queryByText('Pothole at market')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(screen.getByText('Pothole at market')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'REPORTED' } });
    expect(screen.getByText('Pothole at market')).toBeInTheDocument();
    expect(screen.queryByText('Streetlight is out')).not.toBeInTheDocument();
  });

  it('shows a filter-specific empty state without confusing it with no complaints', async () => {
    render(<MemoryRouter><ComplaintsPage complaintApi={makeApi()} /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText('Deep pothole near the bus stop')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Search complaints'), { target: { value: 'does-not-exist' } });
    expect(screen.getByText('No complaints match these filters')).toBeInTheDocument();
    expect(screen.queryByText('No complaints yet')).not.toBeInTheDocument();
  });
});

describe('ComplaintDetailPage', () => {
  it('renders the returned complaint and only the public tracking fields', async () => {
    renderDetail(makeApi());

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Deep pothole near the bus stop' })).toBeInTheDocument());
    expect(screen.getByText('A public update from the team.')).toBeInTheDocument();
    expect(screen.getByText('Reported location')).toBeInTheDocument();
    expect(screen.queryByText('Internal department')).not.toBeInTheDocument();
    expect(screen.queryByText('P2 High')).not.toBeInTheDocument();
  });

  it('does not fabricate a timeline when the response has no public history', async () => {
    renderDetail(makeApi({ getComplaint: vi.fn().mockResolvedValue(makeComplaint({ history: [] })) }));

    await waitFor(() => expect(screen.getByText('No public status history is available yet.')).toBeInTheDocument());
    expect(screen.getByText('Work has started on site.')).toBeInTheDocument();
    expect(screen.queryByText('Assigned')).not.toBeInTheDocument();
  });

  it('handles unknown future statuses without crashing', async () => {
    renderDetail(makeApi({ getComplaint: vi.fn().mockResolvedValue(makeComplaint({ status: 'FUTURE_STATUS', history: [{ status: 'FUTURE_STATUS', at: '2026-10-24T10:00:00.000Z' }] })) }));

    await waitFor(() => expect(screen.getAllByText('Status update').length).toBeGreaterThan(0));
    expect(screen.getAllByText(/not described in this version/).length).toBeGreaterThan(0);
  });

  it('handles an inaccessible identifier without showing backend details', async () => {
    renderDetail(makeApi({ getComplaint: vi.fn().mockRejectedValue(new ApiError('private stack trace', 403, 'FORBIDDEN')) }));

    await waitFor(() => expect(screen.getByText('You cannot view this complaint')).toBeInTheDocument());
    expect(screen.queryByText('private stack trace')).not.toBeInTheDocument();
  });

  it('handles a missing complaint without treating it as a successful record', async () => {
    renderDetail(makeApi({ getComplaint: vi.fn().mockResolvedValue(null) }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Complaint not found' })).toBeInTheDocument());
    expect(screen.getByText(/There is no complaint available/)).toBeInTheDocument();
  });

  it('handles malformed complaint identifiers before making a request', async () => {
    const complaintApi = makeApi();
    renderDetail(complaintApi, 'bad id');

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Complaint not found' })).toBeInTheDocument());
    expect(complaintApi.getComplaint).not.toHaveBeenCalled();
    expect(screen.getByText(/The complaint identifier is not valid/)).toBeInTheDocument();
  });

  it('retries a failed detail request without exposing the server error', async () => {
    const getComplaint = vi.fn().mockRejectedValueOnce(new Error('database stack trace')).mockResolvedValueOnce(makeComplaint());
    renderDetail(makeApi({ getComplaint }));

    await waitFor(() => expect(screen.getByText('We could not load this complaint')).toBeInTheDocument());
    expect(screen.queryByText('database stack trace')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Deep pothole near the bus stop' })).toBeInTheDocument());
    expect(getComplaint).toHaveBeenCalledTimes(2);
  });

  it('does not show stale data after navigating to a different complaint', async () => {
    let resolveFirst!: (complaint: Complaint) => void;
    const first = new Promise<Complaint>((resolve) => { resolveFirst = resolve; });
    const getComplaint = vi.fn((id: string) => id === 'CF-2026-00001' ? first : Promise.resolve(makeComplaint({ publicId: id, title: 'Second complaint' })));

    function NavigateToSecond() {
      const navigate = useNavigate();
      return <button type="button" onClick={() => navigate('/citizen/complaints/CF-2026-00002')}>Go to second complaint</button>;
    }

    render(
      <MemoryRouter initialEntries={['/citizen/complaints/CF-2026-00001']}>
        <NavigateToSecond />
        <Routes>
          <Route path="/citizen/complaints/:complaintId" element={<ComplaintDetailPage complaintApi={makeApi({ getComplaint })} />} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Go to second complaint' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Second complaint' })).toBeInTheDocument());
    resolveFirst(makeComplaint({ publicId: 'CF-2026-00001', title: 'Stale first complaint' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Stale first complaint' })).not.toBeInTheDocument());
  });

  it('does not fabricate citizen resolution or dispute details', async () => {
    renderDetail(makeApi({ getComplaint: vi.fn().mockResolvedValue(makeComplaint({ status: 'RESOLVED', history: [{ status: 'RESOLVED', at: '2026-10-24T10:00:00.000Z' }] })) }));

    await waitFor(() => expect(screen.getByText('Public resolution and dispute details are unavailable')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /dispute/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/before and after/i)).not.toBeInTheDocument();
  });
});
