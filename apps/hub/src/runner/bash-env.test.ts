import { describe, expect, test } from "bun:test";
import { parseEnvRefs } from "./bash-env";

describe("parseEnvRefs (decision 0041)", () => {
  test("no env is no variables; names and references come back in order", () => {
    expect(parseEnvRefs(undefined)).toEqual([]);
    expect(parseEnvRefs({ GH_TOKEN: "vault:github", NPM_TOKEN: "vault:npm#value" })).toEqual([
      { name: "GH_TOKEN", ref: "vault:github" },
      { name: "NPM_TOKEN", ref: "vault:npm#value" },
    ]);
  });

  test("at most eight variables", () => {
    const env = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`TOKEN_${i}`, "vault:github"]));
    expect(parseEnvRefs(env(8))).toHaveLength(8);
    expect(() => parseEnvRefs(env(9))).toThrow("bash.env-invalid");
  });

  test("an env that is not an object is refused, before any name is read", () => {
    for (const env of [null, [], "GH_TOKEN=vault:github", 7]) {
      expect(() => parseEnvRefs(env)).toThrow("bash.env-invalid");
    }
  });

  test("a value that is not a reference is refused without being echoed", () => {
    for (const value of ["ghp_literal42", 42, "vault:", "vault:a b", "VAULT:github"]) {
      let message = "";
      try {
        parseEnvRefs({ GH_TOKEN: value });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("secret.malformed-ref");
      expect(message).not.toContain("ghp_literal42");
    }
  });
});
