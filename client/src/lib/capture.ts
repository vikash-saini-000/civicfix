// Capture policy hook. Stamp helpers live in ./captureStamp (re-exported here for convenience).
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { CapturePolicy } from '../api/operationsTypes';

export { captureHeaders, captureOf, tagCapture, type CaptureStamp } from './captureStamp';

const FALLBACK_POLICY: CapturePolicy = { captureMode: 'any', maxVideoSeconds: 60, cameraSessions: false };
let policyRequest: Promise<CapturePolicy> | null = null;

/** The server's capture rules, fetched once per page load. Falls back to "gallery allowed" if unavailable. */
export function useCapturePolicy(): CapturePolicy | null {
  const [policy, setPolicy] = useState<CapturePolicy | null>(null);
  useEffect(() => {
    let active = true;
    policyRequest ??= api.getCapturePolicy().catch(() => {
      policyRequest = null; // try again next time
      return FALLBACK_POLICY;
    });
    void policyRequest.then((p) => active && setPolicy(p));
    return () => {
      active = false;
    };
  }, []);
  return policy;
}

/** Test helper: forget the cached policy. */
export function resetCapturePolicyCache() {
  policyRequest = null;
}
