import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TextInput } from './Field';

describe('form field accessibility', () => {
  it('associates required and invalid state with the control', () => {
    render(<TextInput label="Email address" required error="Enter a valid email address." />);

    const input = screen.getByRole('textbox', { name: /email address/i });
    expect(input).toBeRequired();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Enter a valid email address.');
    expect(screen.getByText('Required')).toBeInTheDocument();
  });
});
