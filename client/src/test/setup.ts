import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// Lazy route modules and the 26-file jsdom suite can exceed Testing Library's
// 1s default while workers are scheduled in parallel. Keep async assertions
// bounded, but allow the real route-loading flow to settle.
configure({ asyncUtilTimeout: 8000 });

afterEach(() => {
  cleanup();
});
