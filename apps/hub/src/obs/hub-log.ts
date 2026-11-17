/**
 * The hub's plain log lines as structured logs (decision 0021, PRD §8.5).
 *
 * Hub components log through a `(line: string) => void` callback. This turns
 * each line into a JSON log line with the right level, the component that
 * wrote it and the ids it names, without changing the text: `msg` is the line
 * as written (the compose install greps the setup-token line, decision 0020).
 *
 * - level: `warn` for a `WARNING:` line (box egress not filtered, 0012) and
 *   for refusals a peer can cause (a rejected credential, an ignored frame);
 *   `error` for a failure of the hub or Docker (`could not`, `failed`,
 *   `cannot`, `error`); `info` otherwise.
 * - component: from the line's subject (`session`, `box`, `tool-rpc`,
 *   `runner`, `auth`, `desktop`), else `hub`.
 * - ids: `session_id` (`se_…`), `box_id` (`bx_…`) and `turn_id` (`turn_…`)
 *   when the line names them.
 */

import type { Logger, LogLevel } from "@hearth/core";

const ERROR_WORDS = /\b(could not|cannot|failed|failure|error)\b/i;
const WARN_WORDS =
  /\b(rejected|ignored|unknown id|is not from boot|no hello|interrupted by a hub restart|skipped|connection dead)\b/i;

const COMPONENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^tool rpc\b/, "tool-rpc"],
  [/^runner\b|: tracer: |could not record the turn end/, "runner"],
  [/^first run\b|setup token/, "auth"],
  [/^desktop\b|\bvnc\b/i, "desktop"],
  [/^session /, "session"],
  [/^vault: /, "vault"],
  [/^bifrost: /, "bifrost"],
  [/^(WARNING: )?box\b|running boxes|listen again for box/, "box"],
];

/** The level a hub line is logged at. */
export function lineLevel(line: string): LogLevel {
  if (/^WARNING\b/.test(line)) return "warn";
  // The vault (decision 0031): disabled, mid-rotation, an unused next key or a shared key file.
  if (/^vault: (disabled|running on|key rotated|the next key|the key file)/.test(line)) {
    return "warn";
  }
  // Bifrost (decision 0046): reachable from boxes, refusing the vault's password or a
  // vault entry it must not use is an error; down or waiting for the vault is a warning.
  if (/^bifrost: (box-reachable|unauthorized|secrets-unusable)\b/.test(line)) return "error";
  if (/^bifrost: (unreachable|vault-disabled|vault:)/.test(line)) return "warn";
  if (ERROR_WORDS.test(line)) return "error";
  if (WARN_WORDS.test(line)) return "warn";
  return "info";
}

/** The component and the ids a hub line names. */
export function lineFields(line: string): Record<string, string> {
  const fields: Record<string, string> = {
    component: COMPONENTS.find(([re]) => re.test(line))?.[1] ?? "hub",
  };
  const session = /\b(se_[A-Za-z0-9_-]+)/.exec(line)?.[1];
  const box = /\b(bx_[A-Za-z0-9_-]+)/.exec(line)?.[1];
  const turn = /\b(turn_[A-Za-z0-9_-]+)/.exec(line)?.[1];
  if (session !== undefined) fields["session_id"] = session;
  if (box !== undefined) fields["box_id"] = box;
  if (turn !== undefined) fields["turn_id"] = turn;
  return fields;
}

/** A `(line) => void` for the hub's components that writes structured lines to `logger`. */
export function hubLines(logger: Logger): (line: string) => void {
  return (line) => logger.write(lineLevel(line), line, lineFields(line));
}
