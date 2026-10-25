import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

// Cloudflare Turnstile human check. Shown only when VITE_TURNSTILE_SITE_KEY is set; the backend
// verifies the token (CAPTCHA_PROVIDER=turnstile), so the widget on its own protects nothing.

export const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim() || '';
export const CAPTCHA_ENABLED = TURNSTILE_SITE_KEY !== '';

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface TurnstileApi {
  render(element: HTMLElement, options: Record<string, unknown>): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<TurnstileApi> | null = null;
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptPromise ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile did not load')));
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error('Turnstile did not load'));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export interface TurnstileHandle {
  /** Get a fresh token. Tokens are single-use, so call this after every submit attempt. */
  reset(): void;
}

interface TurnstileProps {
  /** Must match the action the backend expects: register, login or complaint. */
  action: 'register' | 'login' | 'complaint';
  /** Receives the token, or null when it expires or the check fails. */
  onToken(token: string | null): void;
}

export const Turnstile = forwardRef<TurnstileHandle, TurnstileProps>(function Turnstile({ action, onToken }, ref) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;
  const [loadFailed, setLoadFailed] = useState(false);

  useImperativeHandle(ref, () => ({
    reset() {
      onTokenRef.current(null);
      if (widgetId.current && window.turnstile) window.turnstile.reset(widgetId.current);
    },
  }));

  useEffect(() => {
    if (!CAPTCHA_ENABLED) return;
    let cancelled = false;
    loadTurnstile().then(
      (turnstile) => {
        if (cancelled || !container.current) return;
        widgetId.current = turnstile.render(container.current, {
          sitekey: TURNSTILE_SITE_KEY,
          action,
          theme: 'auto',
          size: 'flexible',
          callback: (token: string) => onTokenRef.current(token),
          'expired-callback': () => onTokenRef.current(null),
          'error-callback': () => onTokenRef.current(null),
        });
      },
      () => !cancelled && setLoadFailed(true),
    );
    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [action]);

  if (!CAPTCHA_ENABLED) return null;
  return (
    <div>
      <div ref={container} />
      {loadFailed && (
        <p role="alert" className="text-[0.875rem] text-error">
          The human check could not load. Check your connection or disable content blockers, then reload the page.
        </p>
      )}
    </div>
  );
});
