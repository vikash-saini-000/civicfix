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
    expect(onError).toHaveBeenLastCalledWith('Choose JPEG, PNG or WebP images only.');

    const oversized = new File([new Uint8Array(MAX_PHOTO_BYTES + 1)], 'large.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [oversized] } });
    expect(onError).toHaveBeenLastCalledWith('Each image must be 10 MB or smaller.');
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
