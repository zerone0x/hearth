/**
 * `scripts/box-firewall.sh` against real iptables in a throwaway network
 * namespace (`unshare -n`; `-rn` when not root), so nothing on the host
 * changes (decision 0012). Skipped where the namespace or iptables is not
 * available; HEARTH_FIREWALL_TESTS=1 (CI) makes that a failure instead.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "../../../../scripts/box-firewall.sh");
const required = process.env["HEARTH_FIREWALL_TESTS"] === "1";
const unshare = process.getuid?.() === 0 ? ["unshare", "-n"] : ["unshare", "-rn"];
const PATH = `/usr/sbin:/sbin:${process.env["PATH"] ?? "/usr/bin:/bin"}`;

function probe(): boolean {
  try {
    const run = Bun.spawnSync([...unshare, "bash", "-c", "iptables -w -S && iptables-restore -h"], {
      env: { PATH },
      stdout: "ignore",
      stderr: "ignore",
    });
    return run.exitCode === 0;
  } catch {
    return false;
  }
}

const available = probe();
if (required && !available) {
  throw new Error("HEARTH_FIREWALL_TESTS=1 but `unshare -n` with iptables is not available");
}

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hearth-firewall-"));
  writeFileSync(join(dir, "resolv.conf"), "nameserver 1.1.1.1\n");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Runs `body` in a fresh network namespace with `fw` (the script), `$M` (the
 * test directory) and `save` (the filter table without comments and counters).
 */
function inNetns(body: string, env: Record<string, string> = {}) {
  const prelude = [
    "set -u",
    `fw=${JSON.stringify(SCRIPT)}`,
    'save() { iptables-save -t filter | grep -v "^#" | sed "s/\\[[0-9]*:[0-9]*\\]//"; }',
  ].join("\n");
  const run = Bun.spawnSync([...unshare, "bash", "-c", `${prelude}\n${body}`], {
    env: {
      PATH,
      M: dir,
      HEARTH_BOX_EGRESS_MARKER: join(dir, "run", "box-egress.applied"),
      HEARTH_RESOLV_CONF: join(dir, "resolv.conf"),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: run.exitCode,
    stdout: run.stdout.toString(),
    stderr: run.stderr.toString(),
  };
}

const marker = () => join(dir, "run", "box-egress.applied");
const read = (name: string) => readFileSync(join(dir, name), "utf8");

describe.skipIf(!available)("box-firewall.sh in a network namespace", () => {
  test("apply installs the rules, the jumps once, then the marker; a second apply changes nothing", () => {
    const r = inNetns(`
      bash "$fw" apply >"$M/out1" 2>&1 || exit 10
      save >"$M/first"
      bash "$fw" apply >"$M/out2" 2>&1 || exit 11
      save >"$M/second"
    `);
    expect(r).toMatchObject({ code: 0 });
    const rules = read("first");
    expect(read("second")).toBe(rules);
    const count = (line: string) => rules.split("\n").filter((l) => l === line).length;
    expect(count("-A INPUT -i hbx+ -j HEARTH-BOX-IN")).toBe(1);
    expect(count("-A DOCKER-USER -i hbx+ -j HEARTH-BOX-FWD")).toBe(1);
    // No Docker in the namespace: the script adds FORWARD -> DOCKER-USER itself.
    expect(count("-A FORWARD -j DOCKER-USER")).toBe(1);
    for (const cidr of ["10.0.0.0/8", "100.64.0.0/10", "169.254.0.0/16", "192.168.0.0/16"]) {
      expect(
        count(`-A HEARTH-BOX-FWD -d ${cidr} -j REJECT --reject-with icmp-admin-prohibited`),
      ).toBe(1);
    }
    expect(read("out1")).toContain("box firewall applied");
    expect(readFileSync(marker(), "utf8")).toStartWith("applied ");
  });

  test("a bad allow entry is refused before any rule or the marker changes", () => {
    const bad = [
      "192.168.1.1/32,not-a-cidr",
      "0.0.0.0/0",
      "::/0",
      "10.0.0.0/33",
      "300.1.1.1",
      "1.2.3.4/x",
      // iptables reads a leading-zero octet as octal: 010.0.0.1 would be 8.0.0.1.
      "010.0.0.1/32",
      "192.168.1.01",
    ];
    const r = inNetns(`
      HEARTH_BOX_EGRESS_ALLOW=192.168.50.0/24 bash "$fw" apply >/dev/null 2>&1 || exit 10
      save >"$M/before"
      for entry in ${bad.map((b) => JSON.stringify(b)).join(" ")}; do
        HEARTH_BOX_EGRESS_ALLOW="$entry" bash "$fw" apply 2>>"$M/errors"
        code=$?
        save >"$M/after"
        same=same; cmp -s "$M/before" "$M/after" || same=changed
        marker=kept; [ -e "$HEARTH_BOX_EGRESS_MARKER" ] || marker=gone
        echo "$entry $code $same $marker"
      done
    `);
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual(bad.map((b) => `${b} 2 same kept`));
    const before = read("before");
    expect(before).toContain("-A HEARTH-BOX-FWD -d 192.168.50.0/24 -j RETURN");
    expect(before).toContain(
      "-A HEARTH-BOX-FWD -d 10.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited",
    );
    const errors = read("errors");
    expect(errors).toContain("'not-a-cidr' is not an IPv4 address or CIDR");
    expect(errors).toContain("refusing '0.0.0.0/0'");
    expect(errors).toContain("IPv4 only");
    expect(errors).toContain("'010.0.0.1/32' is not an IPv4 address or CIDR");
    expect(errors).toContain("no leading zeros");
  });

  test("an allow list that covers Bifrost's address is refused before any rule or the marker changes (0046)", () => {
    const r = inNetns(
      `
      bash "$fw" apply >/dev/null 2>&1 || exit 10
      save >"$M/before"
      for entry in 172.29.249.2 172.29.249.0/29 172.16.0.0/12; do
        HEARTH_BOX_EGRESS_ALLOW="$entry" bash "$fw" apply 2>>"$M/errors"
        code=$?
        save >"$M/after"
        same=same; cmp -s "$M/before" "$M/after" || same=changed
        marker=kept; [ -e "$HEARTH_BOX_EGRESS_MARKER" ] || marker=gone
        echo "$entry $code $same $marker"
      done
    `,
      { HEARTH_BIFROST_ADDR: "172.29.249.2" },
    );
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual([
      "172.29.249.2 2 same kept",
      "172.29.249.0/29 2 same kept",
      "172.16.0.0/12 2 same kept",
    ]);
    expect(read("errors")).toContain("covers Bifrost's address 172.29.249.2");
    // The applied rules reject Bifrost's address from a box.
    expect(read("before")).toContain("-A HEARTH-BOX-FWD -d 172.16.0.0/12 -p tcp -j REJECT");
  });

  test("a newline in the allow list is refused, not a silent end of the list", () => {
    const r = inNetns(
      `
      bash "$fw" apply >/dev/null 2>&1 || exit 10
      save >"$M/before"
      HEARTH_BOX_EGRESS_ALLOW="$LIST" bash "$fw" apply 2>"$M/err"
      echo "code=$?"
      save >"$M/after"
      [ -e "$HEARTH_BOX_EGRESS_MARKER" ] && echo marker=kept || echo marker=gone
    `,
      { LIST: "192.168.1.1/32\n192.168.2.0/24" },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("code=2");
    expect(r.stdout).toContain("marker=kept");
    expect(read("err")).toContain("got a newline");
    expect(read("after")).toBe(read("before"));
    expect(read("after")).not.toContain("192.168.1.1");
  });

  test("the address iptables installs is the one in the allow list", () => {
    const r = inNetns(`bash "$fw" apply >/dev/null 2>&1 || exit 10; save >"$M/rules"`, {
      HEARTH_BOX_EGRESS_ALLOW: "10.0.0.1/32, 192.168.0.0/16",
    });
    expect(r.code).toBe(0);
    expect(read("rules")).toContain("-A HEARTH-BOX-FWD -d 10.0.0.1/32 -j RETURN");
    expect(readFileSync(marker(), "utf8")).toContain("allow=10.0.0.1/32,192.168.0.0/16");
  });

  test("a rule set the kernel refuses mid-transaction leaves the previous rules intact and no marker", () => {
    // A wrapper that appends an invalid rule just before COMMIT, so the
    // failure happens inside iptables-restore after the other rules parsed.
    const r = inNetns(`
      bash "$fw" apply >/dev/null 2>&1 || exit 10
      save >"$M/before"
      mkdir -p "$M/bin"
      real="$(command -v iptables-restore)"
      printf '#!/bin/sh\\nsed "s/^COMMIT$/-A HEARTH-BOX-FWD -j NO-SUCH-CHAIN\\\\nCOMMIT/" | "%s" "$@"\\n' "$real" >"$M/bin/iptables-restore"
      chmod +x "$M/bin/iptables-restore"
      PATH="$M/bin:$PATH" HEARTH_BOX_EGRESS_ALLOW=192.168.1.1 bash "$fw" apply 2>"$M/err"
      echo "code=$?"
      save >"$M/after"
      [ -e "$HEARTH_BOX_EGRESS_MARKER" ] && echo marker=kept || echo marker=gone
    `);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("code=2");
    expect(r.stdout).toContain("marker=gone");
    expect(read("err")).toContain("the previous rules are unchanged");
    expect(read("after")).toBe(read("before"));
    expect(read("after")).not.toContain("192.168.1.1");
  });

  test("rules already in DOCKER-USER and FORWARD are kept", () => {
    const r = inNetns(`
      iptables -N DOCKER-USER
      iptables -A DOCKER-USER -s 203.0.113.9 -j DROP
      iptables -A FORWARD -j DOCKER-USER
      bash "$fw" apply >/dev/null 2>&1 || exit 10
      save >"$M/rules"
    `);
    expect(r.code).toBe(0);
    const rules = read("rules").split("\n");
    expect(rules).toContain("-A DOCKER-USER -s 203.0.113.9/32 -j DROP");
    expect(rules.filter((l) => l === "-A FORWARD -j DOCKER-USER")).toHaveLength(1);
  });

  test("a LAN-only resolver gets the exact allow line to add", () => {
    writeFileSync(
      join(dir, "resolv.conf"),
      "# generated\nnameserver 127.0.0.53\nnameserver 192.168.1.1\nnameserver 8.8.8.8\n",
    );
    const blocked = inNetns(`bash "$fw" apply`, { HEARTH_BOX_EGRESS_ALLOW: "10.9.9.9" });
    expect(blocked.code).toBe(0);
    expect(blocked.stderr).toContain("WARNING: the host resolves names through 192.168.1.1/32");
    expect(blocked.stderr).toContain(
      '  HEARTH_BOX_EGRESS_ALLOW="10.9.9.9/32,192.168.1.1/32" scripts/box-firewall.sh apply',
    );
    const allowed = inNetns(`bash "$fw" apply`, { HEARTH_BOX_EGRESS_ALLOW: "192.168.1.0/24" });
    expect(allowed.code).toBe(0);
    expect(allowed.stderr).not.toContain("WARNING");
  });

  test("remove takes the marker out first, then the rules", () => {
    const r = inNetns(`
      bash "$fw" apply >/dev/null 2>&1 || exit 10
      bash "$fw" remove >/dev/null 2>&1 || exit 11
      save >"$M/rules"
    `);
    expect(r.code).toBe(0);
    expect(existsSync(marker())).toBe(false);
    expect(read("rules")).not.toContain("HEARTH-BOX");
  });
});
