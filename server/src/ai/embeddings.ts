// Text embeddings for semantic duplicate search. OpenAI-compatible /v1/embeddings API (used through the
// AiCredits.in gateway). Business logic depends only on the EmbeddingProvider interface.
//
// What gets embedded: the AI triage summary (one neutral English sentence) prefixed with the category,
// not the citizen's raw text. Measured on this gateway, raw Hindi/Kannada vs English reports of the same
// pothole scored 0.12–0.56 cosine while unrelated English reports scored 0.30–0.36; English summaries of
// the same issue scored 0.74–0.87 against 0.62 for a different pothole 2 km away.
import { AiProviderError } from './types.js';

export interface EmbeddingProvider {
  readonly enabled: boolean;
  readonly model: string;
  /** One vector per input, same order. */
  embed(texts: string[]): Promise<number[][]>;
}

export const disabledEmbeddings: EmbeddingProvider = {
  enabled: false,
  model: 'none',
  async embed() {
    throw new AiProviderError('NOT_CONFIGURED', 'Embeddings are not configured.');
  },
};

const MAX_INPUTS = 64;
const MAX_CHARS = 2_000;

export function createOpenAiCompatibleEmbeddings(cfg: { baseURL: string; apiKey: string; model: string; timeoutMs: number }, fetchImpl: typeof fetch = fetch): EmbeddingProvider {
  const url = `${cfg.baseURL.replace(/\/$/, '')}/v1/embeddings`;
  return {
    enabled: true,
    model: cfg.model,
    async embed(texts) {
      if (texts.length === 0) return [];
      if (texts.length > MAX_INPUTS) throw new Error(`At most ${MAX_INPUTS} texts per embedding call`);
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: cfg.model, input: texts.map((t) => t.slice(0, MAX_CHARS)) }),
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });
      } catch (err) {
        if ((err as Error).name === 'TimeoutError') throw new AiProviderError('TIMEOUT', 'The embedding provider timed out.');
        throw new AiProviderError('UNAVAILABLE', 'Could not reach the embedding provider.');
      }
      if (res.status === 401 || res.status === 403) throw new AiProviderError('AUTH_FAILED', 'The embedding provider rejected the credentials.');
      if (res.status === 429) throw new AiProviderError('RATE_LIMITED', 'The embedding provider rate-limited the request.');
      if (res.status >= 500 || res.status === 408) throw new AiProviderError('UNAVAILABLE', `The embedding provider returned ${res.status}.`);
      if (!res.ok) throw new AiProviderError('BAD_REQUEST', `The embedding provider returned ${res.status}.`);
      const body = (await res.json().catch(() => null)) as { data?: { index?: number; embedding?: unknown }[] } | null;
      const rows = body?.data;
      if (!Array.isArray(rows) || rows.length !== texts.length) throw new AiProviderError('INVALID_OUTPUT', 'The embedding response had the wrong shape.');
      const out: number[][] = new Array(texts.length);
      rows.forEach((r, i) => {
        const v = r.embedding;
        if (!Array.isArray(v) || v.length < 8 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) throw new AiProviderError('INVALID_OUTPUT', 'The embedding response had an invalid vector.');
        out[typeof r.index === 'number' ? r.index : i] = v as number[];
      });
      if (out.some((v) => !v)) throw new AiProviderError('INVALID_OUTPUT', 'The embedding response was missing vectors.');
      return out;
    },
  };
}

/** Cosine similarity of two vectors; 0 if either is empty or they differ in length. */
export function vectorCosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** The text embedded for a complaint: category + the AI's English summary, or the raw title/description before triage. */
export function embeddingText(c: { summary?: string | null; category?: string | null; title: string; description: string }): string {
  const body = c.summary?.trim() || `${c.title}. ${c.description}`;
  return `${c.category ?? 'unknown'}: ${body}`;
}
