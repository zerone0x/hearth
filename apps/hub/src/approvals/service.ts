/**
 * Approvals (#155, #71; decision 0048; PRD §6.5): the hub-side record a tool
 * call held by the access gate waits on. Channel-neutral: nothing here knows
 * about the web; a decision names the channel it came from.
 *
 * Lifecycle, each step an event in the session's log and an audit row,
 * written before it takes effect (§10):
 *
 * ```
 * approval.requested ─┬─ approval.approved     the owner approved: the call runs
 *                     ├─ approval.denied       the owner denied
 *                     ├─ approval.expired      no decision before `expiresAt`
 *                     ├─ approval.cancelled    stopped, or a new owner message
 *                     └─ approval.interrupted  the hub restarted while it waited
 * ```
 *
 * - **One end.** A pending approval ends once: the in-memory waiter is
 *   claimed synchronously, and the row moves with a conditional UPDATE.
 * - **Fail-closed.** Every end but `approved` blocks the call. If an end
 *   other than the owner's cannot be recorded, the call is still denied.
 * - **The owner's decision** authorizes first (`session.approve` on the
 *   session), then reads the body, then looks the id up in that session
 *   only: an unknown id and another session's id get the same 404. A repeat
 *   of the decision already taken answers as the first did (idempotent);
 *   any other decision on a closed approval is a 409. Its audit row is
 *   written before the event and the row change; if the audit fails, nothing
 *   changes and the approval stays pending.
 * - **Restart.** `recover()` runs at hub start: every row still pending
 *   becomes `interrupted` with an event, so the call's card and its tool
 *   result say "denied: the hub restarted before a decision; not run".
 */

import { randomUUID } from "node:crypto";
import {
  type AuditRecord,
  type AuditSink,
  type Authorizer,
  DEFAULT_WORKSPACE_ID,
  type EpochMs,
  type EventStore,
  HearthError,
  type JsonValue,
  type Principal,
  type SessionId,
  SYSTEM_PRINCIPAL,
  type WorkspaceScope,
  withAudit,
} from "@hearth/core";
import { bodyOf, type RequestBody } from "../request-body";
import { hasHiddenEscape } from "../runner/hidden-chars";
import type { ApprovalRow, ApprovalStatus, SqliteApprovalStore } from "../store/approval-store";

/** How long the owner has to decide (PRD §6.5: a timeout denies). */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60_000;

/** The tool result of a call the gate held when the hub restarted. */
export const APPROVAL_INTERRUPTED =
  "Denied: the hub restarted before the owner decided; the command was not run. Ask again if it is still needed.";

export type ApprovalEnd = Exclude<ApprovalStatus, "pending">;

/** Why a pending approval was cancelled. */
export type CancelWhy = "new message" | "stopped";

export interface ApprovalRequest {
  readonly sessionId: SessionId;
  readonly toolCallId: string;
  readonly tool: string;
  /**
   * The part that decided (the matched sub-command), from the parsed command.
   * Redacted by the caller (the access gate), as `command` and `reason`:
   * they are stored and shown as given.
   */
  readonly summary: string;
  /** The whole command, shown under `summary` ("" for a tool without one). */
  readonly command: string;
  /** The rule that asked (`git-push`, `unclear:name`, ...). */
  readonly rule: string;
  /** The rule's reason, shown on the card. */
  readonly reason: string;
  readonly mode: "yolo" | "ask";
  /** The shown text held hidden characters, escaped by the gate as `⟨U+XXXX⟩` (#165). */
  readonly hiddenChars?: boolean;
  readonly turnId?: string;
}

/** How a request ended, for the gate and the trajectory. */
export interface ApprovalOutcome {
  readonly approvalId: string;
  readonly status: ApprovalEnd;
  readonly approved: boolean;
  /** What the model reads when the call is blocked. */
  readonly reason: string;
  /** `<kind>:<id>` of the principal that decided; null when nobody did. */
  readonly decidedBy: string | null;
  readonly waitedMs: number;
}

/** An approval as the API shows it. */
export interface ApprovalView {
  readonly id: string;
  readonly sessionId: SessionId;
  readonly toolCallId: string;
  readonly tool: string;
  readonly summary: string;
  readonly command: string;
  readonly rule: string;
  readonly mode: "yolo" | "ask";
  /** The card text holds escaped hidden characters (`⟨U+XXXX⟩`; #165), read from the stored text. */
  readonly hidden_chars: boolean;
  readonly status: ApprovalStatus;
  readonly requestedAt: EpochMs;
  readonly expiresAt: EpochMs;
  readonly decidedAt: EpochMs | null;
  readonly decidedBy: string | null;
}

export interface ApprovalsOptions {
  readonly store: SqliteApprovalStore;
  readonly events: EventStore;
  readonly audit: AuditSink;
  readonly authorizer: Authorizer;
  readonly timeoutMs?: number;
  readonly now?: () => EpochMs;
  readonly newId?: () => string;
  readonly log?: (line: string) => void;
}

interface Waiter {
  readonly row: ApprovalRow;
  readonly turnId: string | undefined;
  readonly resolve: (outcome: ApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Set once an end is being recorded; the first claim wins. */
  closing: Promise<ApprovalOutcome> | undefined;
}

function fail(code: string, message: string): HearthError {
  return new HearthError(message, { owner: "user", disposition: "give-up", code });
}

function minutes(ms: number): string {
  const m = ms / 60_000;
  return m >= 1 && Number.isInteger(m) ? `${m} min` : `${Math.round(ms / 1000)} s`;
}

function viewOf(row: ApprovalRow): ApprovalView {
  return {
    id: row.id,
    sessionId: row.sessionId,
    toolCallId: row.toolCallId,
    tool: row.tool,
    summary: row.summary,
    command: row.command,
    rule: row.rule,
    mode: row.mode,
    hidden_chars: hasHiddenEscape(row.summary) || hasHiddenEscape(row.command),
    status: row.status,
    requestedAt: row.requestedAt,
    expiresAt: row.expiresAt,
    decidedAt: row.decidedAt,
    decidedBy: row.decidedBy,
  };
}

/** Read through a call, so TypeScript does not keep an earlier check's narrowing across awaits. */
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** `{decision: "approve" | "deny"}` and nothing else. */
function parseDecision(input: unknown): "approve" | "deny" {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw fail("request.invalid", 'expected {decision: "approve" | "deny"}');
  }
  for (const key of Object.keys(input)) {
    if (key !== "decision") throw fail("request.invalid", `unknown field ${JSON.stringify(key)}`);
  }
  const { decision } = input as { decision?: unknown };
  if (decision !== "approve" && decision !== "deny") {
    throw fail("request.invalid", 'decision must be "approve" or "deny"');
  }
  return decision;
}

export class Approvals {
  readonly #o: ApprovalsOptions;
  readonly #scope: WorkspaceScope = { workspaceId: DEFAULT_WORKSPACE_ID };
  readonly #now: () => EpochMs;
  readonly #timeoutMs: number;
  readonly #waiting = new Map<string, Waiter>();

  constructor(options: ApprovalsOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  }

  get timeoutMs(): number {
    return this.#timeoutMs;
  }

  /**
   * Record a pending approval and wait for its end. Rejects only when the
   * request itself cannot be recorded (the gate then blocks the call). An
   * aborted `signal` (a stop) cancels it.
   */
  async request(req: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalOutcome> {
    const requestedAt = this.#now();
    const row: ApprovalRow = {
      id: this.#o.newId?.() ?? `ap_${randomUUID()}`,
      sessionId: req.sessionId,
      toolCallId: req.toolCallId,
      tool: req.tool,
      summary: req.summary,
      command: req.command,
      rule: req.rule,
      mode: req.mode,
      status: "pending",
      requestedAt,
      expiresAt: requestedAt + this.#timeoutMs,
      decidedAt: null,
      decidedBy: null,
      reason: null,
    };
    if (signal?.aborted === true) {
      return this.#outcome(row, "cancelled", null, "Cancelled: the turn was stopped. Not run.");
    }
    const record = this.#record(SYSTEM_PRINCIPAL, "approval.request", row, {
      tool: row.tool,
      rule: row.rule,
      mode: row.mode,
      expires_at: row.expiresAt,
    });
    await withAudit(this.#o.audit, record, async () => {
      await this.#event(row.sessionId, "approval.requested", req.turnId, {
        approvalId: row.id,
        toolCallId: row.toolCallId,
        tool: row.tool,
        summary: row.summary,
        command: row.command,
        rule: row.rule,
        reason: req.reason,
        mode: row.mode,
        hidden_chars: req.hiddenChars === true,
        requestedAt: row.requestedAt,
        expiresAt: row.expiresAt,
      });
      this.#o.store.insert(this.#scope, row);
    });
    const { promise, resolve } = Promise.withResolvers<ApprovalOutcome>();
    const waiter: Waiter = {
      row,
      turnId: req.turnId,
      resolve,
      timer: undefined,
      closing: undefined,
    };
    this.#waiting.set(row.id, waiter);
    waiter.timer = setTimeout(() => void this.#expire(waiter), this.#timeoutMs);
    const onAbort = () =>
      void this.#close(waiter, "cancelled", null, "Cancelled: the turn was stopped. Not run.", {
        why: "stopped",
      });
    // A stop that landed while the request was being recorded (the awaits
    // above) has already fired: cancel now, so the stop does not wait for the
    // timeout and the card is never approvable. No await between this check
    // and the listener, so no abort falls between them.
    if (aborted(signal)) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await promise;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** The owner's decision on approval `approvalId` of `sessionId`. */
  async decide(
    principal: Principal,
    sessionId: SessionId,
    approvalId: string,
    body: unknown | RequestBody<unknown>,
    channel = "web",
  ): Promise<ApprovalView> {
    const decision = await this.#o.authorizer.authorize(principal, "session.approve", {
      workspaceId: this.#scope.workspaceId,
      type: "session",
      id: sessionId,
    });
    if (!decision.allowed) {
      throw fail("authz.denied", `session.approve denied: ${decision.reason}`);
    }
    // Only a person decides: a box or a service principal never does (#71).
    if (principal.kind !== "user") {
      this.#log(`approvals: ${principal.kind}:${principal.id} tried to decide ${approvalId}`);
      throw fail("authz.denied", "session.approve denied: only the owner decides");
    }
    // Read only now, after `authorize` (#32).
    const choice = parseDecision(await bodyOf(body));
    const wanted: ApprovalEnd = choice === "approve" ? "approved" : "denied";
    const by = `${principal.kind}:${principal.id}`;
    const waiter = this.#waiting.get(approvalId);
    if (waiter !== undefined && waiter.row.sessionId === sessionId) {
      if (waiter.closing === undefined) {
        const reason =
          wanted === "approved" ? "Approved by the owner." : "Denied by the owner. Not run.";
        await this.#close(waiter, wanted, by, reason, { channel }, principal);
      } else {
        await waiter.closing.catch(() => undefined);
      }
    }
    const row = this.#o.store.get(this.#scope, sessionId, approvalId);
    // Unknown, or another session's: the same answer (#90).
    if (row === undefined) throw fail("approval.not-found", `no approval ${approvalId}`);
    if (row.status === wanted) return viewOf(row);
    throw fail("approval.closed", `approval ${approvalId} is ${row.status}`);
  }

  /** Cancel every pending approval of `sessionId` (a new owner message, a stop). */
  async cancel(sessionId: SessionId, why: CancelWhy): Promise<number> {
    const reason =
      why === "new message"
        ? "Cancelled: the owner sent a new message. Not run."
        : "Cancelled: the turn was stopped. Not run.";
    const mine = [...this.#waiting.values()].filter(
      (w) => w.row.sessionId === sessionId && w.closing === undefined,
    );
    await Promise.all(mine.map((w) => this.#close(w, "cancelled", null, reason, { why })));
    return mine.length;
  }

  /** Whether `sessionId` has an approval waiting now. */
  hasPending(sessionId: SessionId): boolean {
    for (const w of this.#waiting.values()) {
      if (w.row.sessionId === sessionId && w.closing === undefined) return true;
    }
    return false;
  }

  /** Every pending approval, for the session list's marker. */
  async list(principal: Principal): Promise<ApprovalView[]> {
    const decision = await this.#o.authorizer.authorize(principal, "session.list", {
      workspaceId: this.#scope.workspaceId,
      type: "workspace",
      id: this.#scope.workspaceId,
    });
    if (!decision.allowed) throw fail("authz.denied", `session.list denied: ${decision.reason}`);
    return this.#o.store.pending(this.#scope).map(viewOf);
  }

  /**
   * Hub start: every approval still pending belongs to a hub that is gone.
   * Each becomes `interrupted`, with an event, so its call reads "denied,
   * not run" (PRD §8.1 principle 7). Returns how many.
   */
  async recover(): Promise<number> {
    let count = 0;
    for (const row of this.#o.store.pending(this.#scope)) {
      if (this.#waiting.has(row.id)) continue;
      const at = this.#now();
      try {
        const record = this.#record(SYSTEM_PRINCIPAL, "approval.interrupt", row, {
          reason: "hub restart",
        });
        await withAudit(this.#o.audit, record, async () => {
          await this.#event(row.sessionId, "approval.interrupted", undefined, {
            approvalId: row.id,
            toolCallId: row.toolCallId,
            at,
            reason: APPROVAL_INTERRUPTED,
          });
        });
      } catch (error) {
        this.#log(`approvals: could not record the interruption of ${row.id}: ${String(error)}`);
      }
      // Whatever was recorded: it can never be approved now.
      if (
        this.#o.store.finish(this.#scope, row.id, {
          status: "interrupted",
          at,
          by: null,
          reason: APPROVAL_INTERRUPTED,
        })
      ) {
        count++;
      }
    }
    if (count > 0) this.#log(`approvals: ${count} pending approval(s) interrupted by a restart`);
    return count;
  }

  /** Stop the timers (hub stop). Pending calls are denied; the rows stay pending for `recover`. */
  close(): void {
    for (const w of this.#waiting.values()) {
      if (w.timer !== undefined) clearTimeout(w.timer);
      w.resolve(this.#outcome(w.row, "interrupted", null, APPROVAL_INTERRUPTED));
    }
    this.#waiting.clear();
  }

  #expire(waiter: Waiter): Promise<ApprovalOutcome> | undefined {
    if (waiter.closing !== undefined) return waiter.closing;
    return this.#close(
      waiter,
      "expired",
      null,
      `Denied: no decision within ${minutes(this.#timeoutMs)}. Not run.`,
      {},
    );
  }

  /**
   * Record `status` and release the call. The first claim wins; later ones
   * get its outcome. With `owner` set (an owner's decision) the audit row
   * must be written first, and a failure leaves the approval pending and
   * rejects; any other end denies the call even if it cannot be recorded.
   */
  #close(
    waiter: Waiter,
    status: ApprovalEnd,
    by: string | null,
    reason: string,
    extra: Record<string, JsonValue>,
    owner?: Principal,
  ): Promise<ApprovalOutcome> {
    if (waiter.closing !== undefined) return waiter.closing;
    const row = waiter.row;
    const work = (async () => {
      const at = this.#now();
      const outcome = this.#outcome(row, status, by, reason, at);
      const record = this.#record(
        owner ?? SYSTEM_PRINCIPAL,
        `approval.${status === "approved" ? "approve" : status === "denied" ? "deny" : status === "expired" ? "expire" : status === "cancelled" ? "cancel" : "interrupt"}`,
        row,
        { status, ...extra, waited_ms: outcome.waitedMs },
      );
      const apply = async () => {
        await this.#event(row.sessionId, `approval.${status}`, waiter.turnId, {
          approvalId: row.id,
          toolCallId: row.toolCallId,
          ...(by === null ? {} : { by }),
          ...extra,
          at,
          waitedMs: outcome.waitedMs,
        });
        this.#o.store.finish(this.#scope, row.id, { status, at, by, reason });
      };
      if (owner !== undefined) {
        // The owner's decision: audited and logged before it applies, or not at all.
        await withAudit(this.#o.audit, record, apply);
      } else {
        try {
          await withAudit(this.#o.audit, record, apply);
        } catch (error) {
          this.#log(`approvals: could not record ${status} of ${row.id}: ${String(error)}`);
          this.#o.store.finish(this.#scope, row.id, { status, at, by, reason });
        }
      }
      return outcome;
    })();
    waiter.closing = work;
    work.then(
      (outcome) => {
        if (waiter.timer !== undefined) clearTimeout(waiter.timer);
        this.#waiting.delete(row.id);
        waiter.resolve(outcome);
      },
      () => {
        // The owner's decision was not recorded: still pending. Past its time it expires now.
        waiter.closing = undefined;
        if (this.#now() >= row.expiresAt) void this.#expire(waiter);
      },
    );
    return work;
  }

  #outcome(
    row: ApprovalRow,
    status: ApprovalEnd,
    by: string | null,
    reason: string,
    at: EpochMs = this.#now(),
  ): ApprovalOutcome {
    return {
      approvalId: row.id,
      status,
      approved: status === "approved",
      reason,
      decidedBy: by,
      waitedMs: Math.max(0, at - row.requestedAt),
    };
  }

  async #event(
    sessionId: SessionId,
    type: string,
    turnId: string | undefined,
    payload: Record<string, JsonValue>,
  ): Promise<void> {
    await this.#o.events.append(this.#scope, sessionId, {
      type,
      ...(turnId === undefined ? {} : { turnId }),
      payload,
    });
  }

  #record(principal: Principal, action: string, row: ApprovalRow, detail: JsonValue): AuditRecord {
    return {
      workspaceId: principal.workspaceId,
      principalId: principal.id,
      principalKind: principal.kind,
      action,
      resource: { workspaceId: this.#scope.workspaceId, type: "approval", id: row.id },
      at: this.#now(),
      detail: {
        session_id: row.sessionId,
        tool_call_id: row.toolCallId,
        ...(detail as Record<string, JsonValue>),
      },
    };
  }

  #log(line: string): void {
    (this.#o.log ?? console.error)(line);
  }
}
