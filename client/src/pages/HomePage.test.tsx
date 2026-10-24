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
  it('explains the citizen journey and offers a clear reporting path', () => {
    renderHome();

    expect(screen.getByRole('heading', { name: /see a problem\?/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /everyday problems deserve/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /from first report to latest update/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /questions citizens often have/i })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Report a problem' })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: 'Report a problem' })[0]).toHaveAttribute('href', '/citizen/complaints/new');
    expect(screen.getByRole('link', { name: 'See how it works' })).toHaveAttribute('href', '#how-it-works');
    expect(screen.getByText('What can I report?')).toBeInTheDocument();
    expect(screen.getByText('Roads and sidewalks')).toBeInTheDocument();
  });

  it('rejects complaint IDs containing whitespace without navigating', () => {
    renderHome();

    fireEvent.change(screen.getByRole('textbox', { name: 'Complaint ID' }), { target: { value: 'CF 2026 00141' } });
    fireEvent.click(screen.getByRole('button', { name: 'Track complaint' }));

    expect(screen.getByText('Enter a valid complaint ID.')).toBeInTheDocument();
    expect(screen.getByTestId('current-location')).toHaveTextContent('/');
  });

  it('encodes the complaint ID as one route segment before navigating', () => {
    renderHome();

    fireEvent.change(screen.getByRole('textbox', { name: 'Complaint ID' }), {
      target: { value: 'CF-2026-00141?view=history#latest' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Track complaint' }));

    expect(screen.getByTestId('current-location')).toHaveTextContent(
      '/citizen/complaints/CF-2026-00141%3FVIEW%3DHISTORY%23LATEST',
    );
  });
});
