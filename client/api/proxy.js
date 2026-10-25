// Vercel function for the frontend project: forwards /api/* to the separate API project.
//
// Why: the two projects live on different *.vercel.app sites. Going through this proxy keeps the app
// and API on one origin, so the HttpOnly refresh cookie stays first-party (Safari and other browsers
// block third-party cookies) and no CORS is needed.
//
// Project settings > Environment Variables:
//   API_ORIGIN           https://<api-project>.vercel.app   (no path, no trailing slash)
//   PROXY_SHARED_SECRET  same random value as on the API; lets the API trust the visitor IP we pass on
//
// Bodies are small JSON: photos and videos go straight to Cloudinary, never through here.

const SECRET_HEADER = 'x-civicfix-proxy-secret';
const CLIENT_IP_HEADER = 'x-civicfix-client-ip';

/** Request headers never forwarded: hop-by-hop, platform-set, and anything a browser could forge. */
const DROP_REQUEST = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'content-length', 'forwarded', 'x-real-ip', SECRET_HEADER, CLIENT_IP_HEADER]);
/** Response headers re-computed by the platform (fetch already decoded the body). */
const DROP_RESPONSE = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length', 'set-cookie']);
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function parseOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.origin === value ? url.origin : null;
  } catch {
    return null;
  }
}

function sendError(res, status, code, message) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ success: false, error: { code, message, details: [] } }));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  const apiOrigin = parseOrigin((process.env.API_ORIGIN || '').trim().replace(/\/+$/, ''));
  if (!apiOrigin) return sendError(res, 503, 'SERVICE_UNAVAILABLE', 'The API is not configured for this site (API_ORIGIN).');

  // req.url is the original path, e.g. /api/v1/auth/login?x=1 (the rewrite keeps it).
  const incoming = new URL(req.url, 'http://placeholder');
  if (!incoming.pathname.startsWith('/api/')) return sendError(res, 404, 'NOT_FOUND', 'Not found.');
  const target = new URL(incoming.pathname + incoming.search, apiOrigin);

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (DROP_REQUEST.has(lower) || lower.startsWith('x-vercel-') || lower.startsWith('x-forwarded-') || value === undefined) continue;
    headers.set(lower, Array.isArray(value) ? value.join(', ') : value);
  }
  // Vercel's edge sets these from the real connection, so they can't be forged by the browser.
  const clientIp = (req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || '').trim();
  if (process.env.PROXY_SHARED_SECRET) {
    headers.set(SECRET_HEADER, process.env.PROXY_SHARED_SECRET);
    if (clientIp) headers.set(CLIENT_IP_HEADER, clientIp);
  }

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = await readBody(req);
    if (body === null) return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'The request is too large.');
  }

  let upstream;
  try {
    upstream = await fetch(target, { method: req.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(290_000) });
  } catch {
    return sendError(res, 502, 'SERVICE_UNAVAILABLE', 'The CivicFix service could not be reached. Try again shortly.');
  }

  res.statusCode = upstream.status;
  upstream.headers.forEach((value, name) => {
    if (!DROP_RESPONSE.has(name)) res.setHeader(name, value);
  });
  // Cookies have no Domain attribute, so the browser scopes them to this site.
  const cookies = upstream.headers.getSetCookie();
  if (cookies.length) res.setHeader('Set-Cookie', cookies);
  res.end(Buffer.from(await upstream.arrayBuffer()));
}
