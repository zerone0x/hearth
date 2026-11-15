/**
 * The hub's secret registry for sink-side redaction (decision 0021). Every
 * secret value the hub resolves for its own use (the model key) is registered
 * here, and every log line, trajectory export and span attribute is passed
 * through `redactHub` before it leaves the process, on top of the runner's own
 * redaction of what it stores (decision 0015).
 */

import { redactLine } from "@hearth/core";

const known = new Set<string>();

/** Remember a secret value so every sink redacts it. */
export function registerSecret(value: string): void {
  if (value.length > 0) known.add(value);
}

/** `text` with every registered secret and every credential shape redacted. */
export function redactHub(text: string): string {
  return redactLine(text, known);
}
