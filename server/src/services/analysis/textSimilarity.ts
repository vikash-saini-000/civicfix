// Deterministic text similarity for duplicate suggestions. No external service.
// Cosine similarity over term-frequency vectors of normalized words (Unicode-aware, so Hindi and
// Kannada text tokenizes too). A rough signal only: it never proves two reports are the same issue.

const STOPWORDS = new Set(
  'a an and are as at be been but by for from has have here i in is it its me my near of on or our please so that the there this to too very was we were with you your'.split(' '),
);

export function tokenize(text: string): string[] {
  return (
    text
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}\p{M}\p{N}]+/gu)
      ?.filter((w) => w.length > 1 && !STOPWORDS.has(w))
      // Light English plural folding: "potholes" ~ "pothole".
      .map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)) ?? []
  );
}

function vector(tokens: string[], weight = 1, into = new Map<string, number>()) {
  for (const t of tokens) into.set(t, (into.get(t) ?? 0) + weight);
  return into;
}

/** Title words count double: titles are short and usually name the problem. */
export function complaintVector(c: { title: string; description: string }): Map<string, number> {
  return vector(tokenize(c.description), 1, vector(tokenize(c.title), 2));
}

export function cosine(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  for (const [k, v] of a) dot += v * (b.get(k) ?? 0);
  const norm = (m: Map<string, number>) => Math.sqrt([...m.values()].reduce((s, v) => s + v * v, 0));
  return Math.min(1, dot / (norm(a) * norm(b)));
}
