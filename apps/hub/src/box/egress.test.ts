/**
 * Marker trust (decision 0023): the hub counts the box firewall as applied
 * only when the marker could not have been written by anyone but its owner
 * (root in production). These tests make the test user the owner, since they
 * cannot create root-owned files.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  type Stats,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boxEgressFromEnv, markerEgressCheck, untrustedMarker } from "./egress";

const me = process.getuid?.() ?? 0;

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hearth-egress-"));
  chmodSync(dir, 0o755);
});
afterEach(() => {
  chmodSync(dir, 0o755);
  rmSync(dir, { recursive: true, force: true });
});

/** A marker as `box-firewall.sh apply` writes it: 0644 in a 0755 directory. */
function writeMarker(at: string = join(dir, "run", "box-egress.applied")): string {
  mkdirSync(join(at, ".."), { recursive: true, mode: 0o755 });
  chmodSync(join(at, ".."), 0o755);
  writeFileSync(at, "applied\n");
  chmodSync(at, 0o644);
  return at;
}

describe("marker trust", () => {
  test("a marker only its owner can write counts as applied", () => {
    const marker = writeMarker();
    expect(untrustedMarker(marker, me)).toBeUndefined();
    expect(markerEgressCheck(marker, { owner: me })()).toEqual({
      state: "filtered",
      detail: `box firewall applied (${marker})`,
    });
  });

  test("a missing marker is unfiltered and says how to apply", () => {
    const status = markerEgressCheck(join(dir, "none"), { owner: me })();
    expect(status.state).toBe("unfiltered");
    expect(status.detail).toContain("is missing");
    expect(status.detail).toContain("box-firewall.sh apply");
  });

  test.skipIf(me === 0)("by default the marker must be root's", () => {
    const marker = writeMarker();
    expect(untrustedMarker(marker)).toBe(`it is owned by uid ${me}, not 0`);
    const status = markerEgressCheck(marker)();
    expect(status.state).toBe("unfiltered");
    expect(status.detail).toContain(`box firewall marker ${marker} not trusted`);
    expect(boxEgressFromEnv({ HEARTH_BOX_EGRESS_MARKER: marker })().state).toBe("unfiltered");
  });

  test("a marker owned by another uid is refused", () => {
    const marker = writeMarker();
    expect(untrustedMarker(marker, me + 1)).toBe(`it is owned by uid ${me}, not ${me + 1}`);
  });

  test("a group- or world-writable marker is refused", () => {
    const marker = writeMarker();
    for (const mode of [0o664, 0o646]) {
      chmodSync(marker, mode);
      expect(untrustedMarker(marker, me)).toBe("it is writable by group or others");
    }
  });

  test("a symlink is refused even when it points at a trusted marker", () => {
    const marker = writeMarker();
    const link = join(dir, "run", "link.applied");
    symlinkSync(marker, link);
    expect(untrustedMarker(link, me)).toBe("it is not a regular file");
  });

  test("a directory anyone can write is refused unless it is sticky", () => {
    const marker = writeMarker();
    const run = join(dir, "run");
    chmodSync(run, 0o777);
    expect(untrustedMarker(marker, me)).toBe(`${run} is writable by group or others`);
    chmodSync(run, 0o1777);
    expect(untrustedMarker(marker, me)).toBeUndefined();
    chmodSync(run, 0o775);
    expect(untrustedMarker(marker, me)).toBe(`${run} is writable by group or others`);
  });

  test("every directory above the marker is checked, not only its own", () => {
    const marker = writeMarker(join(dir, "a", "b", "box-egress.applied"));
    chmodSync(dir, 0o777);
    expect(untrustedMarker(marker, me)).toBe(`${dir} is writable by group or others`);
  });

  test("the directories are checked on the real path, so /var/run -> /run works", () => {
    const marker = writeMarker();
    symlinkSync(join(dir, "run"), join(dir, "var-run"));
    expect(untrustedMarker(join(dir, "var-run", "box-egress.applied"), me)).toBeUndefined();
    chmodSync(join(dir, "run"), 0o777);
    expect(untrustedMarker(join(dir, "var-run", "box-egress.applied"), me)).toBe(
      `${join(dir, "run")} is writable by group or others`,
    );
  });

  test("a directory owned by neither root nor the owner is refused", () => {
    const marker = writeMarker();
    const run = join(dir, "run");
    const stranger = me + 7;
    const lstat = (path: string): Stats => {
      const st = lstatSync(path);
      if (path !== run) return st;
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: stranger });
    };
    expect(untrustedMarker(marker, me, lstat)).toBe(`${run} is owned by uid ${stranger}`);
    // Root-owned directories (/, /run) are fine for any owner.
    const rootDirs = (path: string): Stats => {
      const st = lstatSync(path);
      if (path === marker) return st;
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: 0 });
    };
    expect(untrustedMarker(marker, me, rootDirs)).toBeUndefined();
  });
});
