import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { LocationPicker } from './LocationPicker';

vi.mock('react-leaflet', () => ({
  CircleMarker: () => null,
  MapContainer: ({ children }: { children: ReactNode }) => <div aria-label="test map">{children}</div>,
  TileLayer: () => null,
  useMap: () => ({ getBounds: () => ({ contains: () => true }), setView: vi.fn() }),
  useMapEvents: () => null,
}));

describe('LocationPicker', () => {
  it('does not request location until the user activates the control and reports denial', async () => {
    const getCurrentPosition = vi.fn((_success: PositionCallback, error?: PositionErrorCallback) => {
      error?.({ code: 1, message: 'denied', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
    });
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition } });
    const onChange = vi.fn();
    render(<LocationPicker value={null} onChange={onChange} />);

    expect(getCurrentPosition).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Use my current location' }));

    await waitFor(() => expect(screen.getByText('We could not get your location. Tap the map to place the pin instead.')).toBeInTheDocument());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('provides a keyboard-friendly coordinate alternative to map selection', () => {
    const onChange = vi.fn();
    render(<LocationPicker value={null} onChange={onChange} required />);

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Latitude' }), { target: { value: '13.0108' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Longitude' }), { target: { value: '74.7943' } });

    expect(onChange).toHaveBeenCalledWith({ lat: 13.0108, lng: 74.7943 });
    expect(screen.getByText('(required)')).toBeInTheDocument();
  });

  it('clears a previously selected point when coordinates become invalid', () => {
    const onChange = vi.fn();
    render(<LocationPicker value={{ lat: 13.0108, lng: 74.7943 }} onChange={onChange} required />);

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Latitude' }), { target: { value: 'not-a-coordinate' } });

    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(screen.getByText('Enter a valid latitude and longitude.')).toBeInTheDocument();
  });
});
