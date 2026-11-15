import { describe, expect, test } from "bun:test";
import boxAgentPackage from "../package.json" with { type: "json" };
import { describeBoxAgent } from "./agent";

describe("describeBoxAgent", () => {
  test("reports the protocol version", () => {
    expect(describeBoxAgent().protocol).toBe("1.0");
  });

  test("reports the installed pi version, which matches the pin", () => {
    expect(describeBoxAgent().pi).toBe(
      boxAgentPackage.dependencies["@earendil-works/pi-coding-agent"],
    );
  });

  test("the stub entry point runs and exits cleanly", async () => {
    const proc = Bun.spawn([process.execPath, `${import.meta.dir}/main.ts`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), 10_000);
    const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    clearTimeout(timer);
    expect(code).toBe(0);
    expect(out).toContain("hearth box-agent (protocol 1.0, pi ");
  });
});
