// Real client IP for requests forwarded by the frontend's Vercel proxy (client/api/proxy.js).
//
// The frontend and API are separate Vercel projects. The API sees the proxy's address as the client,
// so every visitor would share one IP and the per-IP rate limits (login, register) would apply to
// everyone at once. The proxy sends the visitor's IP in a header together with a shared secret; only
// when the secret matches is that header trusted. Requests without it keep Express's normal req.ip
// (from TRUST_PROXY), so calling the API directly can't spoof an address.
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { RequestHandler } from 'express';

export const PROXY_SECRET_HEADER = 'x-civicfix-proxy-secret';
export const PROXY_CLIENT_IP_HEADER = 'x-civicfix-client-ip';

const digest = (value: string) => createHash('sha256').update(value).digest();

export function proxyClientIp(secret: string): RequestHandler {
  const expected = digest(secret);
  return (req, _res, next) => {
    const sent = req.get(PROXY_SECRET_HEADER);
    // Fixed-length digests, so the comparison takes the same time whatever was sent.
    if (sent && timingSafeEqual(digest(sent), expected)) {
      const ip = req.get(PROXY_CLIENT_IP_HEADER)?.trim();
      // Own property shadows Express's req.ip getter for this request only.
      if (ip && isIP(ip)) Object.defineProperty(req, 'ip', { value: ip, configurable: true, enumerable: true });
    }
    next();
  };
}
