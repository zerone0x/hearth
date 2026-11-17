/**
 * `bash`'s `env` (decision 0041): vault tokens for one command.
 *
 * The model names a variable and a `vault:<name>` reference, never a value.
 * Every name and reference is checked here, before a lease and before the
 * vault is asked; a refusal never echoes what was given. The vault hands out
 * only a `token` entry with `use: box-env`, global or of this session, and
 * audits the use before it returns the value (`HubVault.use`).
 */

import { parseVaultRefBody } from "@hearth/core";
import { execEnvNameProblem, MAX_EXEC_ENV_VARS } from "@hearth/protocol";
import { Type } from "typebox";

/** The `env` parameter the bash tool adds to pi's schema. */
export const BASH_ENV_PARAMETER = Type.Optional(
  Type.Record(Type.String(), Type.String(), {
    description:
      'Vault tokens for this one command, as environment variables: { "GH_TOKEN": "vault:github" }. ' +
      "Values must be vault references; only tokens the owner made usable by box commands work. " +
      "The command sees the value; you never do: it is replaced by [redacted] in the output.",
  }),
);

/** Added to pi's bash description. */
export const BASH_ENV_HINT =
  'To give a command a token from the vault, pass env: { "GH_TOKEN": "vault:github" }; never put a secret in the command.';

/** One variable to resolve: its name and the reference to resolve into it. */
export interface EnvRef {
  readonly name: string;
  readonly ref: string;
}

/** A refusal as the model reads it: a code, then why. Nothing was run. */
export function envRefusal(code: string, message: string): Error {
  return new Error(`${code}: ${message}. Nothing was run.`);
}

/**
 * The checked `env` of one call, in the order given. Throws `envRefusal` for a
 * bad name, too many variables, or a value that is not a `vault:` reference.
 */
export function parseEnvRefs(env: unknown): EnvRef[] {
  if (env === undefined) return [];
  if (env === null || typeof env !== "object" || Array.isArray(env)) {
    throw envRefusal("bash.env-invalid", "env must be an object of NAME: vault:<name>");
  }
  const entries = Object.entries(env as Record<string, unknown>);
  if (entries.length > MAX_EXEC_ENV_VARS) {
    throw envRefusal("bash.env-invalid", `env holds at most ${MAX_EXEC_ENV_VARS} variables`);
  }
  return entries.map(([name, ref]) => {
    const problem = execEnvNameProblem(name);
    if (problem !== undefined) {
      throw envRefusal(
        "bash.env-name",
        `the variable name ${JSON.stringify(name.slice(0, 64))} ${problem}`,
      );
    }
    // Only a reference is accepted; whatever else was given is not echoed.
    if (
      typeof ref !== "string" ||
      !ref.startsWith("vault:") ||
      parseVaultRefBody(ref.slice("vault:".length)) === undefined
    ) {
      throw envRefusal(
        "secret.malformed-ref",
        `${name} must be a vault reference such as vault:github, never a value`,
      );
    }
    return { name, ref };
  });
}
