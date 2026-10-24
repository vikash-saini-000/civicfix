import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_PHOTO_BYTES, PhotoInput } from './PhotoInput';

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

afterEach(() => {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

describe('PhotoInput', () => {
  it('accepts image files and rejects unsupported files or oversized images', () => {
    URL.createObjectURL = vi.fn(() => 'blob:test');
    URL.revokeObjectURL = vi.fn();
    const onChange = vi.fn();
    const onError = vi.fn();
    render(<PhotoInput files={[]} onChange={onChange} onError={onError} />);
    const input = document.querySelector('input[type="file"]')!;

    fireEvent.change(input, { target: { files: [new File(['image'], 'issue.png', { type: 'image/png' })] } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenLastCalledWith(undefined);

    fireEvent.change(input, { target: { files: [new File(['text'], 'notes.txt', { type: 'text/plain' })] } });
    expect(onError).toHaveBeenLastCalledWith('Choose a JPEG, PNG or WebP photo, or an MP4 or MOV video.');

    const oversized = new File([new Uint8Array(MAX_PHOTO_BYTES + 1)], 'large.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [oversized] } });
    expect(onError).toHaveBeenLastCalledWith('Each photo must be 10 MB or smaller.');
  });

  it('accepts MP4 and MOV videos up to 50 MB and previews them as video', () => {
    URL.createObjectURL = vi.fn(() => 'blob:test');
    URL.revokeObjectURL = vi.fn();
    const onChange = vi.fn();
    const onError = vi.fn();
    const { rerender } = render(<PhotoInput files={[]} onChange={onChange} onError={onError} />);
    const input = document.querySelector('input[type="file"]')!;
    expect(input.getAttribute('accept')).toContain('video/quicktime');

    const mov = new File(['video'], 'clip.mov', { type: 'video/quicktime' });
    fireEvent.change(input, { target: { files: [mov] } });
    expect(onChange).toHaveBeenLastCalledWith([mov]);
    expect(onError).toHaveBeenLastCalledWith(undefined);

    const huge = new File([new Uint8Array(50 * 1024 * 1024 + 1)], 'long.mp4', { type: 'video/mp4' });
    fireEvent.change(input, { target: { files: [huge] } });
    expect(onError).toHaveBeenLastCalledWith('Each video must be 50 MB or smaller.');

    fireEvent.change(input, { target: { files: [new File(['webm'], 'clip.webm', { type: 'video/webm' })] } });
    expect(onError).toHaveBeenLastCalledWith('Choose a JPEG, PNG or WebP photo, or an MP4 or MOV video.');

    rerender(<PhotoInput files={[mov]} onChange={onChange} onError={onError} />);
    expect(screen.getByLabelText('Video 1: clip.mov').tagName).toBe('VIDEO');
  });

  it('removes an attachment with an accessible control and revokes previews', () => {
    URL.createObjectURL = vi.fn(() => 'blob:test');
    const revokeObjectURL = vi.fn();
    URL.revokeObjectURL = revokeObjectURL;
    const onChange = vi.fn();
    const file = new File(['image'], 'issue.png', { type: 'image/png' });
    render(<PhotoInput files={[file]} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove photo 1' }));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
