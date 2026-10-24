import { useEffect, useRef } from 'react';

/**
 * Refresh a visible page when the user returns to it. This is a deliberately
 * conservative fallback for APIs without push events: it does not poll while
 * the tab is hidden and coalesces focus/visibility events that arrive together.
 */
export function useRefreshOnActivity(refresh: () => void, options: { enabled?: boolean; minIntervalMs?: number } = {}) {
  const { enabled = true, minIntervalMs = 1000 } = options;
  const lastRefreshAt = useRef(0);

  useEffect(() => {
    if (!enabled) return;

    const refreshIfVisible = () => {
      if (document.visibilityState === 'hidden') return;
      const now = Date.now();
      if (now - lastRefreshAt.current < minIntervalMs) return;
      lastRefreshAt.current = now;
      refresh();
    };

    window.addEventListener('focus', refreshIfVisible);
    document.addEventListener('visibilitychange', refreshIfVisible);
    return () => {
      window.removeEventListener('focus', refreshIfVisible);
      document.removeEventListener('visibilitychange', refreshIfVisible);
    };
  }, [enabled, minIntervalMs, refresh]);
}
