import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import type { LocationDescription } from '../api/operationsTypes';
import type { GeoPoint } from '../lib/domain';
import { LocationPicker } from './LocationPicker';

// Leaflet needs a real layout engine; the map itself isn't under test here.
vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: { children: React.ReactNode }) => <div data-testid="map">{children}</div>,
  TileLayer: () => null,
  CircleMarker: () => null,
  useMap: () => ({ getBounds: () => ({ contains: () => true }), setView: vi.fn() }),
  useMapEvents: () => null,
}));

const surathkal: LocationDescription = {
  address: 'Mega Mess, Mega mess left road, Surathkal, Mangaluru taluk 575014',
  ward: { code: 'W03', name: 'Surathkal' },
  nearestPlace: { name: 'Surathkal Bus Stand', kind: 'BUS_STOP', distanceMeters: 40 },
  source: 'openstreetmap',
};

function giveLocation(accuracy: number) {
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: {
      getCurrentPosition: (ok: PositionCallback) => ok({ coords: { latitude: 13.00773, longitude: 74.79474, accuracy } } as GeolocationPosition),
    },
  });
}

function Harness({ onDescribed }: { onDescribed?: (d: LocationDescription | null) => void }) {
  const [value, setValue] = useState<GeoPoint | null>(null);
  return <LocationPicker value={value} onChange={setValue} onDescribed={onDescribed} />;
}

afterEach(() => vi.restoreAllMocks());

describe('LocationPicker: current location in words', () => {
  it('shows the street address, nearby landmark, ward and GPS accuracy after "Use my current location"', async () => {
    giveLocation(12);
    const describe = vi.spyOn(api, 'describeLocation').mockResolvedValue(surathkal);
    const onDescribed = vi.fn();
    render(<Harness onDescribed={onDescribed} />);

    fireEvent.click(screen.getByRole('button', { name: 'Use my current location' }));
    expect(screen.getByText('Finding the address…')).toBeInTheDocument();
    expect(await screen.findByText(surathkal.address!)).toBeInTheDocument();
    expect(screen.getByText('Near Surathkal Bus Stand (bus stop), 40 m away · Ward W03 · Surathkal')).toBeInTheDocument();
    expect(screen.getByText(/accurate to about ±12 m/)).toBeInTheDocument();
    expect(describe).toHaveBeenCalledWith(13.00773, 74.79474, expect.anything());
    expect(onDescribed).toHaveBeenLastCalledWith(surathkal);
    expect(screen.getByText(/13\.00773, 74\.79474/)).toBeInTheDocument(); // coordinates still shown
  });

  it('warns when the device only knows the location roughly', async () => {
    giveLocation(850);
    vi.spyOn(api, 'describeLocation').mockResolvedValue(surathkal);
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Use my current location' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('about ±850 m');
  });

  it('asks for a landmark when no address is known or the lookup fails', async () => {
    giveLocation(10);
    vi.spyOn(api, 'describeLocation').mockResolvedValueOnce({ address: null, ward: null, nearestPlace: null, source: 'none' });
    const { unmount } = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Use my current location' }));
    expect(await screen.findByText(/No street address was found for this point/)).toBeInTheDocument();
    unmount();

    vi.spyOn(api, 'describeLocation').mockRejectedValueOnce(new Error('offline'));
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Use my current location' }));
    expect(await screen.findByText(/could not be looked up right now/)).toBeInTheDocument();
  });
});
