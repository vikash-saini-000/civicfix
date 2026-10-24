import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { AuthConfig } from '../config/env.js';

const ISSUER = 'civicfix-api';
const AUDIENCE = 'civicfix-client';
const OBJECT_ID = /^[0-9a-f]{24}$/;

export interface AccessTokenClaims {
  userId: string;
  sessionId: string;
}

export interface IssuedAccessToken {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  expiresAt: string;
}

/** Signs and verifies short-lived access tokens. Claims hold IDs only; roles are loaded per request. */
export function createTokenService(config: Pick<AuthConfig, 'jwtSecret' | 'accessTokenTtlSeconds'>) {
  const key = new TextEncoder().encode(config.jwtSecret);

  return {
    async issue({ userId, sessionId }: AccessTokenClaims): Promise<IssuedAccessToken> {
      const now = Math.floor(Date.now() / 1000);
      const exp = now + config.accessTokenTtlSeconds;
      const accessToken = await new SignJWT({ sid: sessionId, typ: 'access' })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(userId)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt(now)
        .setExpirationTime(exp)
        .sign(key);
      return { accessToken, tokenType: 'Bearer', expiresIn: config.accessTokenTtlSeconds, expiresAt: new Date(exp * 1000).toISOString() };
    },

    /** Returns the claims, or null for any invalid, expired, or tampered token. */
    async verify(token: string): Promise<AccessTokenClaims | null> {
      try {
        const { payload } = await jwtVerify(token, key, {
          algorithms: ['HS256'],
          issuer: ISSUER,
          audience: AUDIENCE,
          requiredClaims: ['sub', 'sid', 'exp', 'iat'],
          clockTolerance: 5,
        });
        if (payload.typ !== 'access' || typeof payload.sid !== 'string') return null;
        if (!OBJECT_ID.test(payload.sub ?? '') || !OBJECT_ID.test(payload.sid)) return null;
        return { userId: payload.sub!, sessionId: payload.sid };
      } catch {
        return null;
      }
    },
  };
}
export type TokenService = ReturnType<typeof createTokenService>;

/** 256-bit random refresh token, URL-safe. */
export const generateRefreshToken = () => randomBytes(32).toString('base64url');

/** Refresh tokens are high-entropy, so a plain SHA-256 is enough for storage. */
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
