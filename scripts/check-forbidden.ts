import { join } from "node:path";
import {
  type Forbidden,
  formatHit,
  type Hit,
  mask,
  parseConfig,
  scanPath,
  scanText,
} from "./forbidden";

// Scans the git repository this script sits in (its parent directory).
const root = join(import.meta.dir, "..");
const configPath = join(import.meta.dir, "forbidden-terms.json");

let forbidden: Forbidden;
try {
  forbidden = parseConfig(await Bun.file(configPath).json());
} catch (err) {
  console.error(`forbidden: bad config scripts/forbidden-terms.json: ${(err as Error).message}`);
  process.exit(1);
}
if (forbidden.size === 0) {
  console.warn("forbidden: warning: scripts/forbidden-terms.json lists no terms; nothing checked");
}

const ls = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root });
if (ls.exitCode !== 0) {
  console.error("forbidden: git ls-files failed");
  process.exit(1);
}
const paths = ls.stdout.toString().split("\0").filter(Boolean);

const hits: Hit[] = [];
await Promise.all(
  paths.map(async (path) => {
    hits.push(...scanPath(path, forbidden));
    if (path === "bun.lock" || path.endsWith("/bun.lock")) return;
    const file = Bun.file(join(root, path));
    if (!(await file.exists())) return; // deleted in the working tree
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.subarray(0, 8000).includes(0)) return; // binary
    hits.push(...scanText(mask(path, forbidden), new TextDecoder().decode(bytes), forbidden));
  }),
);

hits.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
if (hits.length > 0) {
  for (const hit of hits) console.error(formatHit(hit));
  process.exit(1);
}
