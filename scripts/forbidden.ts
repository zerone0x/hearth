// Forbidden-terms check. Only SHA-256 hashes of lowercased terms (and their lengths) are
// stored, so the terms themselves never appear in the repo or in any report.
//
// Matching: each line is cut into chunks of letters and digits, where a chunk may span
// "-", "_" and "." ("zor-blax", "pkg.zor_blax"). The separators are removed, the chunk is
// lowercased, and every window of each configured length is hashed. A term is therefore
// caught inside a longer word ("xzorblaxes", "ZorblaxDesktop") and across those
// separators. Not caught: a term split by a space or other punctuation, a term spelled
// with non-ASCII look-alikes, and an encoded term (base64, escapes).

export type Hit = { path: string; line: number; hash: string };

/** Forbidden hashes grouped by the length of the term they hash. */
export type Forbidden = ReadonlyMap<number, ReadonlySet<string>>;

export type TermEntry = { sha256: string; length: number };

const hashCache = new Map<string, string>();

export function sha256(token: string): string {
  let h = hashCache.get(token);
  if (h === undefined) {
    h = new Bun.CryptoHasher("sha256").update(token).digest("hex");
    hashCache.set(token, h);
  }
  return h;
}

/** Build the lookup from config entries. Throws on a malformed config. */
export function parseConfig(config: unknown): Forbidden {
  const terms = (config as { terms?: unknown } | null)?.terms;
  if (!Array.isArray(terms)) throw new Error('config must be { "terms": [...] }');
  const out = new Map<number, Set<string>>();
  for (const [i, entry] of terms.entries()) {
    const { sha256: hash, length } = (entry ?? {}) as Partial<TermEntry>;
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/i.test(hash)) {
      throw new Error(`terms[${i}].sha256 must be 64 hex characters`);
    }
    if (typeof length !== "number" || !Number.isInteger(length) || length < 1) {
      throw new Error(`terms[${i}].length must be a positive integer`);
    }
    let set = out.get(length);
    if (set === undefined) {
      set = new Set();
      out.set(length, set);
    }
    set.add(hash.toLowerCase());
  }
  return out;
}

/** Build the lookup straight from terms (tests only). */
export function forbiddenOf(...terms: string[]): Forbidden {
  return parseConfig({ terms: terms.map((t) => ({ sha256: sha256(t), length: t.length })) });
}

// Letters and digits, joined across runs of "-", "_" and ".".
const CHUNK = /[A-Za-z0-9]+(?:[-_.]+[A-Za-z0-9]+)*/g;
const SEP = /[-_.]/;

/** One occurrence of a forbidden term: its hash and its [start, end) in the original line. */
export type Match = { hash: string; start: number; end: number };

/** Every forbidden window in one line, with positions in the original text. */
export function matches(line: string, forbidden: Forbidden): Match[] {
  const out: Match[] = [];
  for (const m of line.matchAll(CHUNK)) {
    // The chunk lowercased with separators removed, and where each kept char came from.
    let text = "";
    const at: number[] = [];
    for (let i = 0; i < m[0].length; i++) {
      const ch = m[0][i] as string;
      if (SEP.test(ch)) continue;
      text += ch.toLowerCase();
      at.push(m.index + i);
    }
    for (const [length, hashes] of forbidden) {
      for (let s = 0; s + length <= text.length; s++) {
        const hash = sha256(text.slice(s, s + length));
        if (hashes.has(hash)) {
          out.push({ hash, start: at[s] as number, end: (at[s + length - 1] as number) + 1 });
        }
      }
    }
  }
  return out;
}

/** Distinct forbidden hashes found in one line, in order of first appearance. */
export function scanLine(line: string, forbidden: Forbidden): string[] {
  return [...new Set(matches(line, forbidden).map((m) => m.hash))];
}

/** The text with every character of every forbidden term replaced by "*". */
export function mask(text: string, forbidden: Forbidden): string {
  const chars = text.split(""); // UTF-16 units, matching the indices from matches()
  for (const { start, end } of matches(text, forbidden)) chars.fill("*", start, end);
  return chars.join("");
}

/**
 * Every distinct forbidden term on every line is reported (one hit per term per line).
 * `path` is only a label; pass it through `mask` first if it may hold a term.
 */
export function scanText(path: string, text: string, forbidden: Forbidden): Hit[] {
  const hits: Hit[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const hash of scanLine(lines[i] as string, forbidden)) {
      hits.push({ path, line: i + 1, hash });
    }
  }
  return hits;
}

/** Hits in a tracked file's path itself, reported with line 0 and the term masked. */
export function scanPath(path: string, forbidden: Forbidden): Hit[] {
  const shown = mask(path, forbidden);
  return scanLine(path, forbidden).map((hash) => ({ path: shown, line: 0, hash }));
}

export function formatHit(hit: Hit): string {
  const where = hit.line === 0 ? `${hit.path} (file path)` : `${hit.path}:${hit.line}`;
  return `forbidden: ${where} contains a forbidden term (sha256 ${hit.hash.slice(0, 8)})`;
}
