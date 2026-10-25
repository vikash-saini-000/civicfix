// Cloudflare Turnstile check for abuse-prone public actions (register, login, new complaint).
// The browser widget only produces a token; this middleware is what actually enforces it, by asking
// Cloudflare's Siteverify API whether the token is valid, unused and issued for our site.
import type { RequestHandler } from 'express';
import { AppError } from '../utils/errors.js';
import type { Logger } from '../utils/logger.js';

/** Request header the client puts the Turnstile token in (request bodies are strict schemas). */
export const CAPTCHA_HEADER = 'x-turnstile-token';

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export interface CaptchaVerifier {
  readonly enabled: boolean;
  /** Resolves true only when Cloudflare confirms the token. Never throws for a bad token. */
  verify(token: string, remoteIp: string | undefined, action: string): Promise<boolean>;
}

export const disabledCaptcha: CaptchaVerifier = {
  enabled: false,
  async verify() {
    return true;
  },
};

export interface TurnstileOptions {
  secretKey: string;
  /** Hostnames the token must have been issued on (e.g. civicfix.pages.dev). Empty = any. */
  allowedHostnames: string[];
  logger: Logger;
  timeoutMs?: number;
  /** For tests. */
  fetch?: typeof fetch;
}

interface SiteverifyResponse {
  success?: boolean;
  hostname?: string;
  action?: string;
  'error-codes'?: string[];
}

export function createTurnstileVerifier(opts: TurnstileOptions): CaptchaVerifier {
  const doFetch = opts.fetch ?? fetch;
  return {
    enabled: true,
    async verify(token, remoteIp, action) {
      // Cloudflare tokens are at most 2048 characters.
      if (!token || token.length > 2048) return false;
      const form = new URLSearchParams({ secret: opts.secretKey, response: token });
      if (remoteIp) form.set('remoteip', remoteIp);
      let body: SiteverifyResponse;
      try {
        const res = await doFetch(SITEVERIFY_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(opts.timeoutMs ?? 8_000) });
        body = (await res.json()) as SiteverifyResponse;
      } catch (err) {
        // Fail closed: if we can't confirm the token, the action is refused (the user can retry).
        opts.logger.warn({ err: err instanceof Error ? err.name : 'unknown' }, 'turnstile siteverify unreachable');
        throw new AppError('SERVICE_UNAVAILABLE', 'The human check could not be confirmed right now. Try again shortly.');
      }
      if (body.success !== true) {
        opts.logger.info({ errorCodes: body['error-codes'], action }, 'turnstile token rejected');
        return false;
      }
      if (opts.allowedHostnames.length > 0 && !opts.allowedHostnames.includes(body.hostname ?? '')) {
        opts.logger.warn({ hostname: body.hostname, action }, 'turnstile token issued for another hostname');
        return false;
      }
      // Our widgets always declare an action, so a token for "login" (or with no action at all) can't unlock "register".
      if (body.action !== action) {
        opts.logger.warn({ tokenAction: body.action, action }, 'turnstile token issued for another action');
        return false;
      }
      return true;
    },
  };
}

/** Rejects the request unless it carries a valid Turnstile token. No-op when the verifier is disabled. */
export function requireCaptcha(verifier: CaptchaVerifier, action: string): RequestHandler {
  return (req, _res, next) => {
    if (!verifier.enabled) return next();
    const token = req.get(CAPTCHA_HEADER)?.trim() ?? '';
    if (!token) return next(new AppError('CAPTCHA_REQUIRED', 'Complete the human check and try again.'));
    verifier.verify(token, req.ip, action).then(
      (ok) => next(ok ? undefined : new AppError('CAPTCHA_REQUIRED', 'The human check failed or expired. Complete it again and retry.')),
      next,
    );
  };
}
