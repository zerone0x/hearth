/**
 * Re-applying the box firewall after a firewalld reload (decision 0023):
 * `scripts/firewalld-reload-watch.sh` against a fake D-Bus monitor, and the
 * systemd units the docs give for it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../../..");
const WATCH = join(ROOT, "scripts/firewalld-reload-watch.sh");

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hearth-fw-watch-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SIGNAL = "signal time=1731600000.000001 sender=:1.7 -> destination=(null destination)";
const RELOADED = `${SIGNAL} serial=41 path=/org/fedoraproject/FirewallD1; interface=org.fedoraproject.FirewallD1; member=Reloaded`;

/** Runs the watch with a monitor that prints `lines`, and `command` as the command. */
function watch(lines: string[], command: string[]) {
  const monitor = join(dir, "monitor");
  writeFileSync(join(dir, "monitor.out"), `${lines.join("\n")}\n`);
  writeFileSync(monitor, `#!/bin/sh\ncat "${join(dir, "monitor.out")}"\n`);
  chmodSync(monitor, 0o755);
  const run = Bun.spawnSync(["bash", WATCH, ...command], {
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HEARTH_DBUS_MONITOR: monitor },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

const runs = () => {
  const log = join(dir, "runs");
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
};

describe("firewalld-reload-watch.sh", () => {
  test("runs the command once per Reloaded signal and for nothing else", () => {
    const r = watch(
      [
        `${SIGNAL} serial=2 path=/org/freedesktop/DBus; interface=org.freedesktop.DBus; member=NameAcquired`,
        '   string ":1.99"',
        RELOADED,
        `${SIGNAL} serial=42 path=/org/fedoraproject/FirewallD1; interface=org.fedoraproject.FirewallD1.zone; member=ZoneUpdated`,
        `${SIGNAL} serial=43 path=/org/fedoraproject/FirewallD1; interface=org.fedoraproject.FirewallD1; member=PanicModeEnabled`,
        '   string "interface=org.fedoraproject.FirewallD1; member=Reloaded"',
        RELOADED,
      ],
      ["bash", "-c", `echo "$1" >>"${join(dir, "runs")}"`, "_", "apply"],
    );
    expect(runs()).toEqual(["apply", "apply"]);
    expect(r.stdout.split("\n").filter((l) => l.startsWith("firewalld reloaded"))).toHaveLength(2);
    // The monitor ended: exit 1 so systemd's Restart= starts the watch again.
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("the D-Bus monitor ended");
  });

  test("a failed command is logged and the watch goes on", () => {
    const r = watch(
      [RELOADED, RELOADED],
      ["bash", "-c", `echo x >>"${join(dir, "runs")}"; exit 3`],
    );
    expect(runs()).toEqual(["x", "x"]);
    expect(r.stderr).toContain("failed with exit 3");
    expect(r.code).toBe(1);
  });

  test("without a command it refuses to start", () => {
    expect(watch([RELOADED], []).code).toBe(64);
  });
});

/** The ```ini blocks of a doc, by the unit file path on their first line. */
function units(doc: string): Map<string, string> {
  const text = readFileSync(join(ROOT, doc), "utf8");
  const out = new Map<string, string>();
  for (const m of text.matchAll(/```ini\n# (\S+)\n([\s\S]*?)```/g)) out.set(m[1] ?? "", m[2] ?? "");
  return out;
}

const directives = (unit: string, key: string) =>
  unit
    .split("\n")
    .filter((l) => l.startsWith(`${key}=`))
    .map((l) => l.slice(key.length + 1));

describe.each([
  ["docs/demo.md", "hearth-box-firewall.service"],
  ["docs/install.md", "hearth.service"],
])("the systemd units in %s", (doc, main) => {
  const all = units(doc);
  const unit = all.get(`/etc/systemd/system/${main}`) ?? "";
  const watcher = all.get("/etc/systemd/system/hearth-firewalld-watch.service") ?? "";

  test("re-apply on a firewalld restart, not through ReloadPropagatedFrom", () => {
    expect(unit).not.toBe("");
    // ReloadPropagatedFrom= fires only on `systemctl reload firewalld`, never
    // on `firewall-cmd --reload` or a restart.
    expect(unit).not.toContain("ReloadPropagatedFrom");
    expect(directives(unit, "PartOf")).toEqual(["firewalld.service"]);
    expect(directives(unit, "ExecReload").join(" ")).toContain("box-firewall");
    expect(directives(unit, "ExecStart").join(" ")).toContain("apply");
  });

  test("a watcher reloads the unit on every firewall-cmd --reload", () => {
    expect(directives(watcher, "ExecStart")).toEqual([
      `/opt/hearth/scripts/firewalld-reload-watch.sh /usr/bin/systemctl reload ${main}`,
    ]);
    expect(directives(watcher, "Restart")).toEqual(["always"]);
    expect(directives(watcher, "After")[0]).toContain(main);
  });
});
