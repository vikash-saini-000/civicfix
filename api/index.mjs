// Vercel function: every /api/* and /health/* request is rewritten here (see /vercel.json).
// The handler is the compiled backend (server/src/vercel.ts -> server/dist/vercel.js, built by the
// project's build command). Express sees the original URL, so routes work unchanged.
export { default } from '../server/dist/vercel.js';
