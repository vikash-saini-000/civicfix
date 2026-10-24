import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PriorityBadge, StatusTag } from './Tag';

describe('defensive tag rendering', () => {
  it('renders prototype property values as unknown status and priority values', () => {
    render(
      <>
        <StatusTag status="__proto__" />
        <PriorityBadge priority="__proto__" />
      </>,
    );

    expect(screen.getByText('Status update')).toBeInTheDocument();
    expect(screen.getByText('Priority update')).toBeInTheDocument();
    expect(screen.getByText('Priority update')).not.toHaveClass('[object', 'Object]');
  });
});
