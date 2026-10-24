import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { resetCapturePolicyCache } from '../lib/capture';
import { MAX_PHOTO_BYTES, PhotoInput } from './PhotoInput';

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  resetCapturePolicyCache();
  URL.createObjectURL = vi.fn(() => 'blob:test');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

/** In "any" mode (the mock API's policy) the file picker appears once the policy has loaded. */
async function fileInput() {
  await screen.findByRole('button', { name: 'Choose files' });
  return document.querySelector('input[type="file"]')!;
}

describe('PhotoInput', () => {
  it('accepts image files and rejects unsupported files or oversized images', async () => {
    const onChange = vi.fn();
    const onError = vi.fn();
    render(<PhotoInput files={[]} onChange={onChange} onError={onError} />);
    const input = await fileInput();

    fireEvent.change(input, { target: { files: [new File(['image'], 'issue.png', { type: 'image/png' })] } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenLastCalledWith(undefined);

    fireEvent.change(input, { target: { files: [new File(['text'], 'notes.txt', { type: 'text/plain' })] } });
    expect(onError).toHaveBeenLastCalledWith('Choose a JPEG, PNG or WebP photo, or an MP4 or MOV video.');

    const oversized = new File([new Uint8Array(MAX_PHOTO_BYTES + 1)], 'large.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [oversized] } });
    expect(onError).toHaveBeenLastCalledWith('Each photo must be 10 MB or smaller.');
  });

  it('accepts MP4 and MOV videos up to 50 MB and previews them as video', async () => {
    const onChange = vi.fn();
    const onError = vi.fn();
    const { rerender } = render(<PhotoInput files={[]} onChange={onChange} onError={onError} />);
    const input = await fileInput();
    expect(input.getAttribute('accept')).toContain('video/quicktime');

    const mov = new File(['video'], 'clip.mov', { type: 'video/quicktime' });
    fireEvent.change(input, { target: { files: [mov] } });
    expect(onChange).toHaveBeenLastCalledWith([mov]);
    expect(onError).toHaveBeenLastCalledWith(undefined);

    const huge = new File([new Uint8Array(50 * 1024 * 1024 + 1)], 'long.mp4', { type: 'video/mp4' });
    fireEvent.change(input, { target: { files: [huge] } });
    expect(onError).toHaveBeenLastCalledWith('Each video must be 50 MB or smaller.');

    // A WebM file from the gallery is refused (only in-app recordings may be WebM).
    fireEvent.change(input, { target: { files: [new File(['webm'], 'clip.webm', { type: 'video/webm' })] } });
    expect(onError).toHaveBeenLastCalledWith('Choose a JPEG, PNG or WebP photo, or an MP4 or MOV video.');

    rerender(<PhotoInput files={[mov]} onChange={onChange} onError={onError} />);
    expect(screen.getByLabelText('Video 1: clip.mov').tagName).toBe('VIDEO');
  });

  it('offers only the camera when the server requires in-app capture', async () => {
    vi.spyOn(api, 'getCapturePolicy').mockResolvedValue({ captureMode: 'camera', maxVideoSeconds: 45, cameraSessions: true });
    render(<PhotoInput files={[]} onChange={vi.fn()} />);

    expect(await screen.findByText(/Take them now with your camera/)).toBeInTheDocument();
    expect(screen.getByText(/videos up to 45 seconds/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Take a photo or video' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Choose files' })).not.toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it('removes an attachment with an accessible control and revokes previews', () => {
    const onChange = vi.fn();
    const file = new File(['image'], 'issue.png', { type: 'image/png' });
    render(<PhotoInput files={[file]} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove photo 1' }));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
