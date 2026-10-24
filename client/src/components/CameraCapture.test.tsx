import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { captureHeaders, captureOf } from '../lib/captureStamp';
import { CameraCapture } from './CameraCapture';

const stopTrack = vi.fn();
const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
let positionCallback: PositionCallback | null = null;

function installDevice(opts: { camera?: boolean; denied?: boolean } = {}) {
  const getUserMedia = vi.fn(async () => {
    if (opts.denied) throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    return stream;
  });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: opts.camera === false ? undefined : { getUserMedia } });
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: {
      watchPosition: (ok: PositionCallback) => {
        positionCallback = ok;
        return 1;
      },
      clearWatch: vi.fn(),
    },
  });
  return getUserMedia;
}

beforeEach(() => {
  vi.spyOn(api, 'startCaptureSession').mockResolvedValue({ token: 'session-token', expiresAt: '2026-10-25T11:00:00Z', captureMode: 'camera', maxVideoSeconds: 60 });
  // jsdom has no media playback or canvas encoding.
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 640 });
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 480 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb: BlobCallback) {
    cb(new Blob(['jpeg-bytes'], { type: 'image/jpeg' }));
  });
});
afterEach(() => {
  positionCallback = null;
  stopTrack.mockReset();
});

describe('CameraCapture', () => {
  it('takes a photo from the live camera and stamps it with the session, time and GPS', async () => {
    const getUserMedia = installDevice();
    const onCapture = vi.fn();
    render(<CameraCapture maxVideoSeconds={60} onCapture={onCapture} onClose={vi.fn()} />);

    const shutter = await screen.findByRole('button', { name: 'Take photo' });
    expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ video: expect.objectContaining({ facingMode: { ideal: 'environment' } }) }));
    act(() => positionCallback?.({ coords: { latitude: 13.00773, longitude: 74.79474, accuracy: 7.6 } } as GeolocationPosition));
    expect(screen.getByText('Location on (±8 m)')).toBeInTheDocument();

    const before = Date.now();
    fireEvent.click(shutter);
    await waitFor(() => expect(onCapture).toHaveBeenCalledTimes(1));
    const file = onCapture.mock.calls[0]![0] as File;
    expect(file.type).toBe('image/jpeg');
    const stamp = captureOf(file)!;
    expect(stamp).toMatchObject({ token: 'session-token', lat: 13.00773, lng: 74.79474, accuracy: 7.6 });
    expect(Date.parse(stamp.capturedAt)).toBeGreaterThanOrEqual(before - 5);
    expect(captureHeaders(file)).toMatchObject({ 'X-Capture-Token': 'session-token', 'X-Capture-Lat': '13.00773', 'X-Capture-Lng': '74.79474', 'X-Capture-Accuracy': '8' });
    expect(stopTrack).toHaveBeenCalled(); // camera released
  });

  it('explains a blocked camera instead of falling back to the gallery', async () => {
    installDevice({ denied: true });
    render(<CameraCapture maxVideoSeconds={60} onCapture={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText(/Camera access was blocked/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Take photo' })).not.toBeInTheDocument();
  });

  it('without in-page camera support, uses the phone camera and only accepts a file taken just now', async () => {
    installDevice({ camera: false });
    const onCapture = vi.fn();
    render(<CameraCapture maxVideoSeconds={60} onCapture={onCapture} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: 'Open the phone camera' });
    const input = screen.getByLabelText('Open the phone camera', { selector: 'input' });
    expect(input).toHaveAttribute('capture', 'environment');

    const old = new File(['x'], 'old.jpg', { type: 'image/jpeg', lastModified: Date.now() - 86_400_000 });
    fireEvent.change(input, { target: { files: [old] } });
    expect(await screen.findByText(/was not just taken/)).toBeInTheDocument();
    expect(onCapture).not.toHaveBeenCalled();

    const fresh = new File(['x'], 'new.jpg', { type: 'image/jpeg', lastModified: Date.now() - 2_000 });
    fireEvent.change(input, { target: { files: [fresh] } });
    expect(onCapture).toHaveBeenCalledWith(fresh);
    expect(captureOf(fresh)?.token).toBe('session-token');
  });

  it('cancels without capturing', async () => {
    installDevice();
    const onClose = vi.fn();
    render(<CameraCapture maxVideoSeconds={60} onCapture={vi.fn()} onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });
});
