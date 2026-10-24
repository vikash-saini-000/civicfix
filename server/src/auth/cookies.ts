import type { CookieOptions, Request, Response } from 'express';
import type { AuthConfig } from '../config/env.js';

export const REFRESH_COOKIE = 'civicfix_refresh';
// Sent only to auth endpoints, never to the rest of the API.
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

const baseOptions = (config: Pick<AuthConfig, 'cookieSecure' | 'cookieSameSite'>): CookieOptions => ({
  httpOnly: true,
  secure: config.cookieSecure,
  sameSite: config.cookieSameSite,
  path: REFRESH_COOKIE_PATH,
  // No domain: host-only cookie for the API's own host.
});

export function setRefreshCookie(res: Response, config: AuthConfig, token: string, expiresAt: Date) {
  res.cookie(REFRESH_COOKIE, token, { ...baseOptions(config), expires: expiresAt });
}

export function clearRefreshCookie(res: Response, config: AuthConfig) {
  res.clearCookie(REFRESH_COOKIE, baseOptions(config));
}

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,100}$/;

/** Reads the refresh cookie without a cookie-parser dependency. Returns undefined if absent or malformed. */
export function readRefreshCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === REFRESH_COOKIE) {
      const value = part.slice(eq + 1).trim();
      return TOKEN_SHAPE.test(value) ? value : undefined;
    }
  }
  return undefined;
}
