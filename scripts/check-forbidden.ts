import { join } from "node:path";
import { formatHit, type Hit, scanText } from "./forbidden";

const root = join(import.meta.dir, "..");
const config = (await Bun.file(join(import.meta.dir, "forbidden-terms.json")).json()) as {
  sha256: string[];
};
const forbidden = new Set(config.sha256.map((h) => h.toLowerCase()));

const ls = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root });
if (ls.exitCode !== 0) {
  console.error("forbidden: git ls-files failed");
  process.exit(1);
}
const paths = ls.stdout.toString().split("\0").filter(Boolean);

const hits: Hit[] = [];
await Promise.all(
  paths.map(async (path) => {
    if (path === "bun.lock" || path.endsWith("/bun.lock")) return;
    const file = Bun.file(join(root, path));
    if (!(await file.exists())) return; // deleted in the working tree
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.subarray(0, 8000).includes(0)) return; // binary
    hits.push(...scanText(path, new TextDecoder().decode(bytes), forbidden));
  }),
);

hits.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
if (hits.length > 0) {
  for (const hit of hits) console.error(formatHit(hit));
  process.exit(1);
}
