import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // Page tests use the in-memory mock adapter; the HTTP adapter has its own unit tests.
    env: { VITE_CIVICFIX_API_MODE: 'mock', VITE_CIVICFIX_AUTH_MODE: 'mock' },
    restoreMocks: true,
    clearMocks: true,
  },
});
