import { join } from "node:path";
import { Glob } from "bun";
import { checkPins, type Manifest } from "./pins";

const root = join(import.meta.dir, "..");

const manifests: Manifest[] = [];
for (const pattern of ["package.json", "apps/*/package.json", "packages/*/package.json", "spikes/*/package.json"]) {
  for await (const path of new Glob(pattern).scan({ cwd: root })) {
    manifests.push({ path, json: await Bun.file(join(root, path)).json() });
  }
}

const lockfile = Bun.file(join(root, "bun.lock"));
const report = checkPins(manifests, (await lockfile.exists()) ? await lockfile.text() : undefined);

if (report.errors.length > 0) {
  for (const error of report.errors) console.error(`pins: ${error}`);
  process.exit(1);
}
console.log(`pins: ok (pi ${report.version ?? "not used"}, ${manifests.length} manifests)`);
