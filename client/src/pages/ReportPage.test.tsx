import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { Complaint } from '../lib/domain';
import type { ComplaintApi } from '../api/types';
import { ApiError } from '../api/errors';
import { ReportPage } from './ReportPage';

vi.mock('../components/LocationPicker', () => ({
  LocationPicker: ({ onChange, error }: { onChange: (point: { lat: number; lng: number }) => void; error?: string }) => (
    <div>
      <button type="button" onClick={() => onChange({ lat: 13.0108, lng: 74.7943 })}>Set test location</button>
      {error && <p>{error}</p>}
    </div>
  ),
}));

vi.mock('../components/PhotoInput', () => ({
  MAX_PHOTO_BYTES: 10 * 1024 * 1024,
  MAX_PHOTOS: 3,
  PhotoInput: ({
    files,
    onChange,
    onError,
    error,
    disabled,
    disabledReason,
  }: {
    files: File[];
    onChange: (files: File[]) => void;
    onError?: (message: string | undefined) => void;
    error?: string;
    disabled?: boolean;
    disabledReason?: string;
  }) => (
    <div>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange([new File(['photo'], 'issue.png', { type: 'image/png' })])}
      >
        Add test photo
      </button>
      <button type="button" onClick={() => onError?.('Upload failed')}>Trigger photo error</button>
      <span>{files.length} photos</span>
      {disabledReason && <p>{disabledReason}</p>}
      {error && <p>{error}</p>}
    </div>
  ),
}));

function makeComplaintApi(overrides: Partial<ComplaintApi> = {}): ComplaintApi {
  return {
    capabilities: { photoAttachments: true },
    listMyComplaints: vi.fn().mockResolvedValue([]),
    getComplaint: vi.fn().mockResolvedValue(null),
    submitComplaint: vi.fn().mockResolvedValue({
      publicId: 'CF-2026-00420',
      title: 'Pothole',
      description: 'A deep pothole near the bus stop.',
      location: { lat: 13.0108, lng: 74.7943 },
      selectedCategory: 'roads',
      confirmedCategory: null,
      status: 'REPORTED',
      photoCount: 0,
      createdAt: '2026-10-24T12:00:00.000Z',
      updatedAt: '2026-10-24T12:00:00.000Z',
      history: [{ status: 'REPORTED', at: '2026-10-24T12:00:00.000Z' }],
    }),
    ...overrides,
  };
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function renderReport(complaintApi: ComplaintApi) {
  return render(
    <MemoryRouter initialEntries={['/citizen/complaints/new']}>
      <ReportPage complaintApi={complaintApi} />
      <LocationProbe />
    </MemoryRouter>,
  );
}

function fillMinimumForm() {
  fireEvent.change(screen.getByLabelText('What is the problem?'), { target: { value: '  Deep pothole  ' } });
  fireEvent.change(screen.getByLabelText('Describe the issue'), { target: { value: ' A deep pothole near the bus stop. ' } });
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'roads' } });
  fireEvent.click(screen.getByRole('button', { name: 'Set test location' }));
}

describe('ReportPage', () => {
  it('renders supported fields and category options', () => {
    renderReport(makeComplaintApi());

    expect(screen.getByRole('heading', { name: 'Report a Civic Issue' })).toBeInTheDocument();
    expect(screen.getByLabelText('What is the problem?')).toBeInTheDocument();
    expect(screen.getByLabelText('Describe the issue')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Roads and potholes' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Garbage and sanitation' })).toBeInTheDocument();
  });

  it('validates required fields before entering review', () => {
    const api = makeComplaintApi();
    renderReport(api);

    fireEvent.click(screen.getByRole('button', { name: 'Review complaint' }));

    expect(screen.getAllByText('Give the problem a short title of at least 5 characters.')).toHaveLength(2);
    expect(screen.getAllByText('Describe the problem in at least 10 characters.')).toHaveLength(2);
    expect(screen.getAllByText('Place a valid pin on the map so the team can find the issue.')).toHaveLength(2);
    expect(api.submitComplaint).not.toHaveBeenCalled();
  });

  it('reviews and submits a valid complaint using trimmed typed values', async () => {
    const api = makeComplaintApi();
    renderReport(api);
    fillMinimumForm();
    fireEvent.click(screen.getByRole('button', { name: 'Review complaint' }));

    expect(screen.getByRole('heading', { name: 'Check your report before sending' })).toBeInTheDocument();
    expect(api.submitComplaint).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Submit complaint' }));

    await waitFor(() => expect(api.submitComplaint).toHaveBeenCalledTimes(1));
    expect(api.submitComplaint).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Deep pothole',
      description: 'A deep pothole near the bus stop.',
      selectedCategory: 'roads',
      location: { lat: 13.0108, lng: 74.7943 },
      photos: [],
    }));
     await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/citizen/complaints/CF-2026-00420'));
  });

  it('prevents duplicate complaint submissions while the request is pending', async () => {
    let resolveSubmit!: (value: Complaint) => void;
    const submitComplaint = vi.fn<ComplaintApi['submitComplaint']>(() => new Promise<Complaint>((resolve) => { resolveSubmit = resolve; }));
    const api = makeComplaintApi({ submitComplaint });
    renderReport(api);
    fillMinimumForm();
    fireEvent.click(screen.getByRole('button', { name: 'Review complaint' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit complaint' }));
    fireEvent.submit(document.querySelector('form')!);

    expect(submitComplaint).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
    resolveSubmit({ publicId: 'CF-2026-00420' } as Complaint);
     await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/citizen/complaints/CF-2026-00420'));
  });

  it('preserves the form after a recoverable API failure and avoids false success', async () => {
    const api = makeComplaintApi({ submitComplaint: vi.fn().mockRejectedValue(new ApiError('server detail', 503)) });
    renderReport(api);
    fillMinimumForm();
    fireEvent.click(screen.getByRole('button', { name: 'Review complaint' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit complaint' }));

    await waitFor(() => expect(screen.getByText('The civic service is temporarily unavailable. Your details are still here; try again shortly.')).toBeInTheDocument());
    expect(screen.queryByText('Complaint submitted')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit details' }));
    expect(screen.getByLabelText('What is the problem?')).toHaveValue('  Deep pothole  ');
  });

  it('does not enable photo selection when the adapter has no upload contract', () => {
    renderReport(makeComplaintApi({ capabilities: { photoAttachments: false } }));

    expect(screen.getByRole('button', { name: 'Add test photo' })).toBeDisabled();
    expect(screen.getByText(/Photo uploads are pending the backend media contract/)).toBeInTheDocument();
  });
});
