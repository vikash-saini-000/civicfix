import type { Request, RequestHandler } from 'express';
import type { AuthService } from '../auth/authService.js';
import { ROLES, type Principal, type Role } from '../auth/roles.js';
import type { MembershipRole } from '../models/enums.js';
import { AppError } from '../utils/errors.js';

declare global {
  namespace Express {
    interface Request {
      /** Set only by requireAuth. Never derived from request body, query or custom headers. */
      auth?: Principal;
    }
  }
}

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;
const MAX_HEADER_LENGTH = 2048;

function unauthenticated(res: Parameters<RequestHandler>[1], message: string, invalidToken: boolean) {
  res.setHeader('WWW-Authenticate', invalidToken ? 'Bearer error="invalid_token"' : 'Bearer');
  return new AppError('UNAUTHENTICATED', message);
}

/** Requires a valid `Authorization: Bearer <access token>` with a live session and active account. */
export function requireAuth(auth: Pick<AuthService, 'authenticate'>): RequestHandler {
  return async (req, res, next) => {
    const header = req.get('authorization');
    if (!header) return next(unauthenticated(res, 'Sign in to continue.', false));
    const match = header.length <= MAX_HEADER_LENGTH ? BEARER.exec(header) : null;
    const principal = match ? await auth.authenticate(match[1]!) : null;
    if (!principal) return next(unauthenticated(res, 'Your session is invalid or has expired. Sign in again.', true));
    req.auth = principal;
    req.log = req.log.child({ userId: principal.userId });
    next();
  };
}

function assertKnownRoles(roles: readonly string[]) {
  if (roles.length === 0 || roles.some((r) => !(ROLES as readonly string[]).includes(r))) {
    // Fail at startup, not at request time: a typo must never silently allow or deny everything.
    throw new Error(`requireRole: unknown or empty role list: ${roles.join(', ')}`);
  }
}

const forbidden = () => new AppError('FORBIDDEN', 'You do not have permission to do this.');

/** Allows the request only if the user holds at least one of the listed roles. Deny by default. */
export function requireRole(...allowed: Role[]): RequestHandler {
  assertKnownRoles(allowed);
  return (req, _res, next) => {
    if (!req.auth) return next(new AppError('UNAUTHENTICATED', 'Sign in to continue.'));
    if (!allowed.some((role) => req.auth!.roles.has(role))) return next(forbidden());
    next();
  };
}

/**
 * Department-scoped check: the user must have an active membership with one of `roles` in the
 * department identified by `getDepartmentId(req)` (taken from validated, server-trusted input).
 * Platform admins are not let through unless `allowPlatformAdmin` is set explicitly.
 */
export function requireDepartmentRole(
  getDepartmentId: (req: Request) => string | undefined,
  roles: MembershipRole[],
  opts: { allowPlatformAdmin?: boolean } = {},
): RequestHandler {
  if (roles.length === 0) throw new Error('requireDepartmentRole: empty role list');
  return (req, _res, next) => {
    const principal = req.auth;
    if (!principal) return next(new AppError('UNAUTHENTICATED', 'Sign in to continue.'));
    if (opts.allowPlatformAdmin && principal.roles.has('PLATFORM_ADMIN')) return next();
    const departmentId = getDepartmentId(req);
    const ok = !!departmentId && principal.memberships.some((m) => m.departmentId === departmentId && roles.includes(m.role));
    next(ok ? undefined : forbidden());
  };
}

/**
 * CSRF defence for endpoints authenticated by cookie (refresh, logout): browsers can't send a custom
 * header cross-site without a CORS preflight, which only configured origins pass.
 */
export function requireCsrfHeader(allowedOrigins: string[]): RequestHandler {
  return (req, _res, next) => {
    const origin = req.get('origin');
    if (origin && !allowedOrigins.includes(origin)) return next(new AppError('FORBIDDEN', 'Request origin is not allowed.'));
    if (req.get('x-requested-with') !== 'civicfix') {
      return next(new AppError('FORBIDDEN', 'Missing required header X-Requested-With: civicfix.'));
    }
    next();
  };
}
