import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AuthResult, AuthService } from '../auth/authService.js';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from '../auth/cookies.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../auth/password.js';
import type { AuthConfig } from '../config/env.js';
import { requireAuth, requireCsrfHeader } from '../middleware/auth.js';
import { createRateLimiter, type RateLimitOptions } from '../middleware/rateLimit.js';
import { input, validate } from '../middleware/validate.js';
import { AppError } from '../utils/errors.js';
import { sendCreated, sendNoContent, sendSuccess } from '../utils/respond.js';
import { text } from '../validation/common.js';

const email = z.string().trim().toLowerCase().pipe(z.email('Must be a valid email address.').max(254));
// Passwords are never trimmed or otherwise transformed.
const password = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

const registerBody = z.strictObject({ name: text(1, 100), email, password });
const loginBody = z.strictObject({ email, password: z.string().min(1).max(PASSWORD_MAX_LENGTH) });
type RegisterBody = z.infer<typeof registerBody>;
type LoginBody = z.infer<typeof loginBody>;

export interface AuthRateLimits {
  register: RateLimitOptions;
  loginPerIp: RateLimitOptions;
  loginPerIpAndEmail: RateLimitOptions;
  refresh: RateLimitOptions;
}

const MINUTE = 60_000;
export const DEFAULT_AUTH_RATE_LIMITS: AuthRateLimits = {
  register: { windowMs: 60 * MINUTE, limit: 10 },
  loginPerIp: { windowMs: 15 * MINUTE, limit: 50 },
  // Keyed by IP + email, so an attacker can't lock a victim out from elsewhere.
  loginPerIpAndEmail: { windowMs: 15 * MINUTE, limit: 10 },
  refresh: { windowMs: 15 * MINUTE, limit: 60 },
};

export interface AuthRouterDeps {
  authService: AuthService;
  authConfig: AuthConfig;
  corsOrigins: string[];
  rateLimits?: AuthRateLimits;
}

const meta = (req: Request) => ({ requestId: req.id, userAgent: req.get('user-agent') });

/** /api/v1/auth: register, login, refresh, logout, me. */
export function authRouter({ authService, authConfig, corsOrigins, rateLimits = DEFAULT_AUTH_RATE_LIMITS }: AuthRouterDeps): Router {
  const router = Router();
  const csrf = requireCsrfHeader(corsOrigins);
  const emailKey = (req: Request) => (typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 254) : undefined);

  const respondWithSession = (res: Parameters<typeof sendSuccess>[0], result: AuthResult, status: 200 | 201) => {
    setRefreshCookie(res, authConfig, result.refreshToken, result.refreshExpiresAt);
    res.setHeader('Cache-Control', 'no-store');
    const data = { user: result.user, ...result.tokens };
    if (status === 201) sendCreated(res, data);
    else sendSuccess(res, data);
  };

  router.post('/register', createRateLimiter(rateLimits.register), validate({ body: registerBody }), async (req, res) => {
    respondWithSession(res, await authService.register(input<RegisterBody>(req, 'body'), meta(req)), 201);
  });

  router.post(
    '/login',
    createRateLimiter(rateLimits.loginPerIp),
    createRateLimiter({ ...rateLimits.loginPerIpAndEmail, keyPart: emailKey }),
    validate({ body: loginBody }),
    async (req, res) => {
      respondWithSession(res, await authService.login(input<LoginBody>(req, 'body'), meta(req)), 200);
    },
  );

  router.post('/refresh', createRateLimiter(rateLimits.refresh), csrf, async (req, res) => {
    const token = readRefreshCookie(req);
    if (!token) throw new AppError('UNAUTHENTICATED', 'Your session has expired. Sign in again.');
    try {
      respondWithSession(res, await authService.refresh(token, meta(req)), 200);
    } catch (err) {
      clearRefreshCookie(res, authConfig);
      throw err;
    }
  });

  // Works with the refresh cookie alone, so users can sign out even after the access token expired.
  router.post('/logout', csrf, async (req, res) => {
    let principal: { sessionId: string; userId: string } | undefined;
    const header = req.get('authorization');
    if (header?.startsWith('Bearer ')) {
      const p = await authService.authenticate(header.slice(7));
      if (p) principal = { sessionId: p.sessionId, userId: p.userId };
    }
    await authService.logout({ refreshToken: readRefreshCookie(req), ...principal }, meta(req));
    clearRefreshCookie(res, authConfig);
    sendNoContent(res);
  });

  router.get('/me', requireAuth(authService), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, { user: await authService.currentUser(req.auth!) });
  });

  return router;
}
