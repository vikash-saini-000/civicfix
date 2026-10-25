import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // Page tests use the in-memory mock adapter; the HTTP adapter has its own unit tests.
    // Fixed values so a developer's .env (e.g. a real Turnstile site key) can't change test behaviour.
    env: { VITE_CIVICFIX_API_MODE: 'mock', VITE_CIVICFIX_AUTH_MODE: 'mock', VITE_TURNSTILE_SITE_KEY: '' },
    restoreMocks: true,
    clearMocks: true,
  },
});
