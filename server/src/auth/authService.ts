import { Types } from 'mongoose';
import type { AuthConfig } from '../config/env.js';
import { AuditLog, AuthSession, Department, DepartmentMembership, User } from '../models/index.js';
import type { SessionRevokeReason } from '../models/AuthSession.js';
import { AppError } from '../utils/errors.js';
import type { Logger } from '../utils/logger.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './password.js';
import { deriveRoles, type MembershipSummary, type Principal } from './roles.js';
import { createTokenService, generateRefreshToken, hashToken, type IssuedAccessToken } from './tokens.js';

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  platformRole: string;
  roles: string[];
  memberships: MembershipSummary[];
  createdAt: string;
}

export interface AuthResult {
  user: PublicUser;
  tokens: IssuedAccessToken;
  refreshToken: string;
  refreshExpiresAt: Date;
}

interface RequestMeta {
  requestId: string;
  userAgent?: string;
}

const invalidCredentials = () => new AppError('INVALID_CREDENTIALS', 'The email or password is incorrect.');
const invalidSession = () => new AppError('UNAUTHENTICATED', 'Your session has expired. Sign in again.');

/** All authentication state changes. Routes stay thin; everything here is testable without HTTP. */
export function createAuthService(config: AuthConfig, logger: Logger) {
  const tokens = createTokenService(config);

  async function audit(action: string, userId: Types.ObjectId | string, meta: RequestMeta, outcome: 'SUCCESS' | 'DENIED', reason?: string) {
    await AuditLog.create({
      actorType: 'USER',
      actor: userId,
      action,
      targetType: 'User',
      targetId: userId,
      outcome,
      reason,
      correlationId: meta.requestId,
    });
  }

  async function loadMemberships(userId: Types.ObjectId | string): Promise<MembershipSummary[]> {
    const memberships = await DepartmentMembership.find({ user: userId, status: 'ACTIVE' }).select('department role').lean();
    if (memberships.length === 0) return [];
    const active = await Department.find({ _id: { $in: memberships.map((m) => m.department) }, isActive: true }).select('_id').lean();
    const activeIds = new Set(active.map((d) => String(d._id)));
    return memberships
      .filter((m) => activeIds.has(String(m.department)))
      .map((m) => ({ departmentId: String(m.department), role: m.role }));
  }

  function toPublicUser(
    user: { _id: Types.ObjectId; name: string; email: string; platformRole: string; createdAt?: Date },
    memberships: MembershipSummary[],
  ): PublicUser {
    return {
      id: String(user._id),
      name: user.name,
      email: user.email,
      platformRole: user.platformRole,
      roles: [...deriveRoles(user.platformRole, memberships)],
      memberships,
      createdAt: (user.createdAt ?? new Date()).toISOString(),
    };
  }

  async function startSession(user: Parameters<typeof toPublicUser>[0], meta: RequestMeta): Promise<AuthResult> {
    const refreshToken = generateRefreshToken();
    const now = new Date();
    const refreshExpiresAt = new Date(now.getTime() + config.refreshTokenTtlDays * 86_400_000);
    const session = await AuthSession.create({
      user: user._id,
      refreshTokenHash: hashToken(refreshToken),
      expiresAt: refreshExpiresAt,
      lastUsedAt: now,
      userAgent: meta.userAgent?.slice(0, 200),
    });
    const issued = await tokens.issue({ userId: String(user._id), sessionId: String(session._id) });
    return { user: toPublicUser(user, await loadMemberships(user._id)), tokens: issued, refreshToken, refreshExpiresAt };
  }

  async function revokeSession(sessionId: Types.ObjectId | string, reason: SessionRevokeReason) {
    await AuthSession.updateOne({ _id: sessionId, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date(), revokedReason: reason } });
  }

  return {
    /** Public sign-up. Always creates an ACTIVE CITIZEN; privileged fields can't reach here (strict schema). */
    async register(input: { name: string; email: string; password: string }, meta: RequestMeta): Promise<AuthResult> {
      const emailTaken = () =>
        new AppError('CONFLICT', 'An account with this email already exists.', [
          { field: 'body.email', issue: 'duplicate', message: 'This email is already registered.' },
        ]);
      if (await User.exists({ email: input.email })) throw emailTaken();

      let user;
      try {
        user = await User.create({
          name: input.name,
          email: input.email,
          passwordHash: await hashPassword(input.password),
          platformRole: 'CITIZEN',
          accountStatus: 'ACTIVE',
        });
      } catch (err) {
        // Concurrent registration with the same email: the unique index decides.
        if ((err as { code?: number }).code === 11000) throw emailTaken();
        throw err;
      }
      await audit('user.registered', user._id, meta, 'SUCCESS');
      return startSession(user, meta);
    },

    async login(input: { email: string; password: string }, meta: RequestMeta): Promise<AuthResult> {
      const user = await User.findOne({ email: input.email }).select('+passwordHash');
      if (!user) {
        await verifyAgainstDummy(input.password);
        logger.warn({ requestId: meta.requestId }, 'login failed: unknown account');
        throw invalidCredentials();
      }
      const ok = await verifyPassword(user.passwordHash, input.password);
      if (!ok || user.accountStatus !== 'ACTIVE') {
        await audit('auth.login_failed', user._id, meta, 'DENIED', ok ? 'account not active' : 'wrong password');
        throw invalidCredentials();
      }
      await audit('auth.login_succeeded', user._id, meta, 'SUCCESS');
      return startSession(user, meta);
    },

    /** Rotates the refresh token. Reuse of an old token revokes the whole session. */
    async refresh(refreshToken: string, meta: RequestMeta): Promise<AuthResult> {
      const oldHash = hashToken(refreshToken);
      const now = new Date();
      const session = await AuthSession.findOne({ refreshTokenHash: oldHash });

      if (!session) {
        const replayed = await AuthSession.findOne({ rotatedTokenHashes: oldHash, revokedAt: { $exists: false } });
        if (replayed) {
          await revokeSession(replayed._id, 'REFRESH_TOKEN_REUSE');
          await audit('auth.refresh_token_reused', replayed.user, meta, 'DENIED', 'session revoked');
          logger.warn({ requestId: meta.requestId, userId: String(replayed.user) }, 'refresh token reuse detected; session revoked');
        }
        throw invalidSession();
      }
      if (session.revokedAt || session.expiresAt <= now) throw invalidSession();

      const user = await User.findById(session.user);
      if (!user || user.accountStatus !== 'ACTIVE') {
        await revokeSession(session._id, 'ACCOUNT_DISABLED');
        throw invalidSession();
      }

      const nextToken = generateRefreshToken();
      // Conditional update: if another request already rotated this token, this one loses.
      const rotated = await AuthSession.findOneAndUpdate(
        { _id: session._id, refreshTokenHash: oldHash, revokedAt: { $exists: false } },
        {
          $set: { refreshTokenHash: hashToken(nextToken), lastUsedAt: now },
          $push: { rotatedTokenHashes: { $each: [oldHash], $slice: -20 } },
        },
      );
      if (!rotated) throw invalidSession();

      const issued = await tokens.issue({ userId: String(user._id), sessionId: String(session._id) });
      return { user: toPublicUser(user, await loadMemberships(user._id)), tokens: issued, refreshToken: nextToken, refreshExpiresAt: session.expiresAt };
    },

    /** Revokes the session named by the refresh token and/or the access token. Idempotent. */
    async logout(opts: { refreshToken?: string; sessionId?: string; userId?: string }, meta: RequestMeta): Promise<void> {
      const filters: object[] = [];
      if (opts.refreshToken) filters.push({ refreshTokenHash: hashToken(opts.refreshToken) });
      if (opts.sessionId) filters.push({ _id: opts.sessionId, user: opts.userId });
      if (filters.length === 0) return;
      const session = await AuthSession.findOne({ $or: filters, revokedAt: { $exists: false } });
      if (!session) return;
      await revokeSession(session._id, 'LOGOUT');
      await audit('auth.logout', session.user, meta, 'SUCCESS');
    },

    /** Resolves a bearer token to a Principal, checking the session and account on every call. */
    async authenticate(accessToken: string): Promise<Principal | null> {
      const claims = await tokens.verify(accessToken);
      if (!claims) return null;
      const session = await AuthSession.exists({
        _id: claims.sessionId,
        user: claims.userId,
        revokedAt: { $exists: false },
        expiresAt: { $gt: new Date() },
      });
      if (!session) return null;
      const user = await User.findById(claims.userId).lean();
      if (!user || user.accountStatus !== 'ACTIVE') return null;
      const memberships = await loadMemberships(user._id);
      return {
        userId: String(user._id),
        sessionId: claims.sessionId,
        name: user.name,
        email: user.email,
        platformRole: user.platformRole,
        memberships,
        roles: deriveRoles(user.platformRole, memberships),
      };
    },

    async currentUser(principal: Principal): Promise<PublicUser> {
      const user = await User.findById(principal.userId).lean();
      if (!user) throw invalidSession();
      return toPublicUser(user, principal.memberships);
    },
  };
}
export type AuthService = ReturnType<typeof createAuthService>;
