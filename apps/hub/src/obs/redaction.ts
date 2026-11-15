/**
 * The hub's secret registry for sink-side redaction (decision 0021). Every
 * secret value the hub resolves for its own use (the model key) is registered
 * here, and every log line, trajectory export and span attribute is passed
 * through `redactHub` before it leaves the process, on top of the runner's own
 * redaction of what it stores (decision 0015).
 *
 * The hub registers its secrets at startup (`registerKnownSecrets`), not on
 * first use: after a restart the API, the trajectory CLI and the logs redact a
 * value an older build stored raw before any turn has resolved the key.
 */

import { redactLine, type SecretStore } from "@hearth/core";

const known = new Set<string>();

/** Remember a secret value so every sink redacts it. */
export function registerSecret(value: string): void {
  if (value.length > 0) known.add(value);
}

/** `text` with every registered secret and every credential shape redacted. */
export function redactHub(text: string): string {
  return redactLine(text, known);
}

/**
 * Resolve each SecretStore reference (the model key, `HEARTH_MODEL_KEY_REF`)
 * and register its value. A reference that does not resolve is reported to
 * `warn` and skipped: redaction of the rest still applies. Returns how many
 * were registered.
 */
export async function registerKnownSecrets(
  secrets: SecretStore,
  refs: readonly string[],
  warn: (message: string) => void = () => {},
): Promise<number> {
  let registered = 0;
  for (const ref of refs) {
    try {
      const value = (await secrets.resolve(ref)).reveal();
      registerSecret(value);
      registered++;
    } catch (error) {
      warn(
        `could not resolve ${ref} for redaction: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return registered;
}
