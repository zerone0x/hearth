import { join } from "node:path";
import { Glob } from "bun";
import { checkFilePins, checkPins, type Manifest, type PinnedFile } from "./pins";

const root = join(import.meta.dir, "..");

const manifests: Manifest[] = [];
for (const pattern of [
  "package.json",
  "apps/*/package.json",
  "packages/*/package.json",
  "spikes/*/package.json",
]) {
  for await (const path of new Glob(pattern).scan({ cwd: root })) {
    manifests.push({ path, json: await Bun.file(join(root, path)).json() });
  }
}

const lockfile = Bun.file(join(root, "bun.lock"));
const report = checkPins(manifests, (await lockfile.exists()) ? await lockfile.text() : undefined);

// Compose files and Dockerfiles that can hard-code a pi version (decision 0020).
const files: PinnedFile[] = [];
for (const pattern of [
  "deploy/*.yaml",
  "deploy/*Dockerfile",
  "apps/*/Dockerfile",
  "**/Dockerfile",
]) {
  for await (const path of new Glob(pattern).scan({ cwd: root })) {
    if (path.includes("node_modules/") || files.some((f) => f.path === path)) continue;
    files.push({ path, text: await Bun.file(join(root, path)).text() });
  }
}
const errors = [...report.errors, ...checkFilePins(files, report.version, ["deploy/compose.yaml"])];

if (errors.length > 0) {
  for (const error of errors) console.error(`pins: ${error}`);
  process.exit(1);
}
console.log(
  `pins: ok (pi ${report.version ?? "not used"}, ${manifests.length} manifests, ${files.length} build files)`,
);
