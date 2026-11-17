/**
 * The access gate (decisions 0043, 0045, 0048; PRD §6.5): one `tool_call`
 * handler, registered first under the reserved name `hearth-access`, loaded
 * in both access modes.
 *
 * - **Mode.** Read once per call (`resolve`), never cached; recorded on the
 *   call's trajectory record.
 * - **Verdict.** `bash` goes through the parser and the command rules
 *   (`classifyBash`, decision 0044), which test the raw deny-list first. A
 *   call that uses a marked secret (`bash` with a `vault:` env, decision
 *   0041; `browser_fill`, decision 0039) is at least `ask`. Other tools are
 *   `allow` here; the path deny-list stays in `hearth-tools`.
 * - **`deny`** blocks in both modes, with no card.
 * - **`ask`** in `yolo` runs at once. A command the parser cannot read is
 *   `ask` too, so in `yolo` only the raw deny-list (tested first) can stop it
 *   (decision 0043). In `ask` it waits for the owner (`approve`, the hub's
 *   approval record); every end but "approved" blocks the call with a reason
 *   the model reads. Without an approval channel it is blocked.
 * - **Fail-closed.** Anything this handler throws (the mode cannot be read,
 *   the request cannot be recorded) blocks the call: pi blocks a call whose
 *   `tool_call` handler throws.
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ApprovalOutcome } from "../approvals/service";
import type { AccessMode } from "../settings/access-mode";
import { type BashVerdict, type CommandRule, classifyBash } from "./bash-policy";
import type { CompiledDenyRule } from "./policy";

/** The reserved extension name (`RESERVED_EXTENSION_NAMES`). */
export const ACCESS_EXTENSION = "hearth-access";

/** What the model reads when `ask` mode has nobody to ask. */
export const NO_APPROVAL_CHANNEL =
  "Blocked: this call needs the owner's approval and the hub has no way to ask. Not run.";

/** What the gate asks the owner about. */
export interface GateRequest {
  readonly toolCallId: string;
  readonly tool: string;
  readonly summary: string;
  readonly rule: string;
  readonly reason: string;
  readonly mode: AccessMode;
}

export interface AccessExtensionOptions {
  /** The mode in force for the session now (`AccessModes.resolve`). */
  readonly resolve: () => AccessMode;
  /** The mode the call was preflighted under, for its trajectory record. */
  readonly onMode?: (toolCallId: string, mode: AccessMode) => void;
  /** Command rules for `bash` (decision 0044), compiled. Unset: none. */
  readonly commandRules?: readonly CommandRule[];
  /** The raw deny-list: tested against a `bash` command before parsing (0043's fallback). */
  readonly denyList?: readonly CompiledDenyRule[];
  /** The verdict on every `bash` call, before it runs or is blocked. */
  readonly onBashVerdict?: (toolCallId: string, verdict: BashVerdict) => void;
  /** Called when the gate blocks a call without asking (a `deny`, or nobody to ask). */
  readonly onDenied?: (toolName: string, toolCallId: string, reason: string) => void;
  /**
   * Waits for the owner (`Approvals.request`). Unset: an `ask` in `ask` mode
   * is blocked (`NO_APPROVAL_CHANNEL`).
   */
  readonly approve?: (
    request: GateRequest,
    signal: AbortSignal | undefined,
  ) => Promise<ApprovalOutcome>;
  /** How an approval ended, for the trajectory. */
  readonly onApproval?: (toolCallId: string, rule: string, outcome: ApprovalOutcome) => void;
}

/** The gate's view of one call: what decided and what the card says. */
export interface GateVerdict {
  readonly action: "allow" | "ask" | "deny";
  readonly rule: string;
  readonly reason: string;
  readonly summary: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The `vault:` references a call uses (decisions 0039, 0041), as written. */
function markedSecrets(toolName: string, input: unknown): string[] {
  if (!isRecord(input)) return [];
  if (toolName === "bash" && isRecord(input["env"])) {
    return Object.entries(input["env"])
      .filter(([, ref]) => typeof ref === "string" && ref.startsWith("vault:"))
      .map(([name, ref]) => `${name}=${String(ref)}`);
  }
  if (toolName === "browser_fill" && typeof input["secret"] === "string") {
    return [input["secret"]];
  }
  return [];
}

/** Classify one call. */
export function gateVerdict(
  toolName: string,
  input: unknown,
  commandRules: readonly CommandRule[],
  denyList: readonly CompiledDenyRule[],
  onBashVerdict?: (verdict: BashVerdict) => void,
): GateVerdict {
  let verdict: GateVerdict = { action: "allow", rule: "none", reason: "", summary: "" };
  const command = isRecord(input) ? input["command"] : undefined;
  if (toolName === "bash" && typeof command === "string") {
    const bash = classifyBash(command, commandRules, denyList);
    onBashVerdict?.(bash);
    verdict = {
      action: bash.action,
      rule: bash.rule,
      reason: bash.reason,
      // From the parsed command, never from model text (card spoofing, research doc).
      summary: bash.command ?? command,
    };
    if (verdict.action === "deny") return verdict;
  }
  const secrets = markedSecrets(toolName, input);
  if (secrets.length > 0 && verdict.action === "allow") {
    verdict = {
      action: "ask",
      rule: "marked-secret",
      reason: `uses a marked secret: ${secrets.join(", ")}`,
      summary:
        toolName === "bash" && typeof command === "string"
          ? command
          : `${toolName} with ${secrets.join(", ")}`,
    };
  }
  return verdict;
}

export function accessExtension(options: AccessExtensionOptions): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event, ctx) => {
      // Read per call, never cached: a change applies to the next call.
      const mode = options.resolve();
      options.onMode?.(event.toolCallId, mode);
      const verdict = gateVerdict(
        event.toolName,
        event.input,
        options.commandRules ?? [],
        options.denyList ?? [],
        (bash) => options.onBashVerdict?.(event.toolCallId, bash),
      );
      if (verdict.action === "deny") {
        // Both modes (0043): a deny rule, or the raw deny-list on any command.
        options.onDenied?.(event.toolName, event.toolCallId, verdict.reason);
        return { block: true, reason: verdict.reason };
      }
      if (verdict.action === "allow" || mode === "yolo") return undefined;
      if (options.approve === undefined) {
        options.onDenied?.(event.toolName, event.toolCallId, NO_APPROVAL_CHANNEL);
        return { block: true, reason: NO_APPROVAL_CHANNEL };
      }
      const outcome = await options.approve(
        {
          toolCallId: event.toolCallId,
          tool: event.toolName,
          summary: verdict.summary,
          rule: verdict.rule,
          reason: verdict.reason,
          mode,
        },
        ctx.signal,
      );
      options.onApproval?.(event.toolCallId, verdict.rule, outcome);
      if (outcome.approved) return undefined;
      return { block: true, reason: outcome.reason };
    });
  };
}
