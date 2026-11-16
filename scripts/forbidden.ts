// Forbidden-terms check. Only SHA-256 hashes of lowercased terms are stored, so the
// terms themselves never appear in the repo or in any report.

export type Hit = { path: string; line: number; hash: string };

const hashCache = new Map<string, string>();

export function sha256(token: string): string {
  let h = hashCache.get(token);
  if (h === undefined) {
    h = new Bun.CryptoHasher("sha256").update(token).digest("hex");
    hashCache.set(token, h);
  }
  return h;
}

const RUN = /[A-Za-z0-9]+/g;
// camelCase and digit boundaries: "HTTPServer2" -> HTTP, Server, 2
const PART = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g;

/** Lowercase candidate tokens of one line: whole alphanumeric runs plus their split parts. */
export function tokens(line: string): string[] {
  const out: string[] = [];
  for (const run of line.match(RUN) ?? []) {
    out.push(run.toLowerCase());
    for (const part of run.match(PART) ?? []) out.push(part.toLowerCase());
  }
  return out;
}

export function scanText(path: string, text: string, forbidden: ReadonlySet<string>): Hit[] {
  const hits: Hit[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const seen = new Set<string>();
    for (const token of tokens(line)) {
      const hash = sha256(token);
      if (forbidden.has(hash) && !seen.has(hash)) {
        seen.add(hash);
        hits.push({ path, line: i + 1, hash });
      }
    }
  }
  return hits;
}

export function formatHit(hit: Hit): string {
  return `forbidden: ${hit.path}:${hit.line} contains a forbidden term (sha256 ${hit.hash.slice(0, 8)})`;
}
