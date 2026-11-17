import { describe, expect, test } from "bun:test";
import boxAgentPackage from "../package.json" with { type: "json" };
import { describeBoxAgent } from "./agent";

describe("describeBoxAgent", () => {
  test("reports the protocol version", () => {
    expect(describeBoxAgent().protocol).toBe("1.6");
  });

  test("reports the installed pi version, which matches the pin", () => {
    expect(describeBoxAgent().pi).toBe(
      boxAgentPackage.dependencies["@earendil-works/pi-coding-agent"],
    );
  });

  test("the entry point without a boot environment exits with a clear message", async () => {
    const proc = Bun.spawn([process.execPath, `${import.meta.dir}/main.ts`], {
      env: { PATH: process.env["PATH"] ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), 10_000);
    const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    clearTimeout(timer);
    expect(code).toBe(2);
    expect(err).toContain("hearth box-agent (protocol 1.6, pi ");
    expect(err).toContain("HEARTH_HUB_URL and HEARTH_BOX_ID must be set");
  });
});
