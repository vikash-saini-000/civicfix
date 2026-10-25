// Vercel function for the API project (Root Directory: server). Every request is rewritten here
// (see server/vercel.json); Express still sees the original URL, so routes work unchanged.
// The handler is the compiled backend: src/vercel.ts -> dist/vercel.js (built by `npm run build`).
export { default } from '../dist/vercel.js';
