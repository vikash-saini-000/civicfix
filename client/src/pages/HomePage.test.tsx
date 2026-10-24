import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';
import { HomePage } from './HomePage';

function CurrentLocation() {
  const location = useLocation();
  return <output data-testid="current-location">{location.pathname}{location.search}{location.hash}</output>;
}

function renderHome() {
  return render(
    <MemoryRouter>
      <HomePage />
      <CurrentLocation />
    </MemoryRouter>,
  );
}

describe('public home tracking form', () => {
  it('rejects complaint IDs containing whitespace without navigating', () => {
    renderHome();

    fireEvent.change(screen.getByRole('textbox', { name: 'Complaint ID' }), { target: { value: 'CF 2026 00141' } });
    fireEvent.click(screen.getByRole('button', { name: 'Track' }));

    expect(screen.getByText('Enter a valid complaint ID.')).toBeInTheDocument();
    expect(screen.getByTestId('current-location')).toHaveTextContent('/');
  });

  it('encodes the complaint ID as one route segment before navigating', () => {
    renderHome();

    fireEvent.change(screen.getByRole('textbox', { name: 'Complaint ID' }), {
      target: { value: 'CF-2026-00141?view=history#latest' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Track' }));

    expect(screen.getByTestId('current-location')).toHaveTextContent(
      '/citizen/complaints/CF-2026-00141%3FVIEW%3DHISTORY%23LATEST',
    );
  });
});
