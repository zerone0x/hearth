/**
 * Per-session Bifrost virtual keys and their spend (PRD §6.4, §11.3,
 * decision 0047).
 *
 * - **One key per session**, made on the session's first runner build (its
 *   first model call), with an explicit one-model allowlist, the session
 *   budget and a rate limit. The hub stores only the key's id
 *   (`session_virtual_key`); the value is rotated on every runner build, kept
 *   in the runner's memory and added to the redaction registry, so it never
 *   reaches the event log, a trajectory, a log line or a box.
 * - **Model switch** is a `PUT` of the allowlist at the next runner build;
 *   **archive** deactivates the key; **remove** deletes it (the request log
 *   stays in Bifrost). Create, rotate, update, deactivate and delete are each
 *   audited before they happen (`bifrost.vk.*`), with the key id, never the value.
 * - **Spend and tokens** come from Bifrost's request log
 *   (`GET /api/logs/stats?virtual_key_ids=`). Bifrost writes the log in
 *   batches of about 5 s, so a call that just ended shows a few seconds later.
 * - **Budget**: one default for every session (`session_budget` setting),
 *   applied to a session's key at its next runner build and to every active
 *   key when it is saved.
 * - A model whose provider Bifrost does not serve (a `models.json` endpoint)
 *   is not routed: its runner uses the direct path (decision 0038) and the
 *   spend view says `direct`.
 */

import {
  type AuditRecord,
  type AuditSink,
  type Authorizer,
  DEFAULT_WORKSPACE_ID,
  type EpochMs,
  HearthError,
  type JsonValue,
  type Principal,
  type SessionId,
  SYSTEM_PRINCIPAL,
  withAudit,
} from "@hearth/core";
import { registerSecret } from "../obs/redaction";
import { bodyOf, type RequestBody } from "../request-body";
import type { SqliteSettingStore, SqliteVirtualKeyStore, VirtualKeyRow } from "../store";
import type { BifrostClient, VirtualKeyStats } from "./client";
import { BIFROST_PROVIDERS, type BifrostState } from "./service";

/** The setting key of the default session budget. */
export const SESSION_BUDGET_KEY = "session_budget";
/** The session budget on a new install, in US dollars. */
export const DEFAULT_SESSION_BUDGET_USD = 5;
/** About how long Bifrost takes to write a call into its request log. */
export const SPEND_FLUSH_SECONDS = 10;

/** Where a session's model calls go, as the runner needs it. */
export interface GatewayRoute {
  /** Bifrost's OpenAI-compatible base URL, e.g. `http://172.29.249.2:8080/v1`. */
  readonly baseUrl: string;
  /** The session's virtual key value: memory only. */
  readonly apiKey: string;
  /** The model as Bifrost routes it: `<bifrost provider>/<model>`. */
  readonly modelId: string;
}

/** What the session page shows. */
export interface SessionSpendView {
  readonly sessionId: SessionId;
  /** `bifrost`: the session has a virtual key; `direct`: no gateway; `none`: no model call yet. */
  readonly gateway: "bifrost" | "direct" | "none";
  readonly bifrostState: BifrostState | null;
  readonly budgetUsd: number;
  /** Null while Bifrost cannot be asked (or the session has no key). */
  readonly spend: VirtualKeyStats | null;
  readonly active: boolean | null;
  readonly flushSeconds: number;
}

export interface SessionBudgetView {
  readonly budgetUsd: number;
  readonly source: "default" | "settings";
  readonly updatedAt: EpochMs | null;
  readonly bifrostState: BifrostState | null;
  /** Every session's spend together, from Bifrost's log; null without Bifrost. */
  readonly total: VirtualKeyStats | null;
  readonly flushSeconds: number;
}

/** The parts of `BifrostService` the keys use. */
export interface BifrostGateway {
  readonly url: string;
  readonly status: { readonly state: BifrostState; readonly detail: string };
  /** The admin client, while Bifrost is `ok`. */
  readonly client: BifrostClient | undefined;
}

export interface SessionVirtualKeysOptions {
  readonly bifrost: BifrostGateway | undefined;
  readonly store: SqliteVirtualKeyStore;
  readonly settings: SqliteSettingStore;
  readonly authorizer: Authorizer;
  readonly audit: AuditSink;
  /** Whether the session exists: an unknown one is `session.not-found`. */
  readonly sessionExists: (sessionId: SessionId) => boolean;
  readonly log?: (line: string) => void;
  readonly now?: () => EpochMs;
}

function fail(code: string, message: string, owner: "user" | "hub" = "user"): HearthError {
  return new HearthError(message, {
    owner,
    disposition: owner === "user" ? "give-up" : "retry",
    code,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `{budgetUsd}`: a positive amount of US dollars, at most 100 000. */
function parseBudget(input: unknown): number {
  if (!isRecord(input)) throw fail("request.invalid", "expected {budgetUsd: number}");
  for (const key of Object.keys(input)) {
    if (key !== "budgetUsd") throw fail("request.invalid", `unknown field ${JSON.stringify(key)}`);
  }
  const { budgetUsd } = input;
  if (
    typeof budgetUsd !== "number" ||
    !Number.isFinite(budgetUsd) ||
    budgetUsd <= 0 ||
    budgetUsd > 100_000
  ) {
    throw fail("request.invalid", "budgetUsd must be a number above 0 and at most 100000");
  }
  return Math.round(budgetUsd * 100) / 100 || 0.01;
}

export class SessionVirtualKeys {
  readonly #o: SessionVirtualKeysOptions;
  readonly #ws = DEFAULT_WORKSPACE_ID;
  readonly #now: () => EpochMs;
  /** One key operation at a time per session. */
  readonly #locks = new Map<SessionId, Promise<unknown>>();
  readonly #directLogged = new Set<string>();

  constructor(options: SessionVirtualKeysOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
  }

  /** Whether model traffic goes through Bifrost at all (`HEARTH_BIFROST_URL` set). */
  get configured(): boolean {
    return this.#o.bifrost !== undefined;
  }

  /** The default session budget in force. */
  budget(): { budgetUsd: number; source: "default" | "settings"; updatedAt: EpochMs | null } {
    const row = this.#o.settings.get(this.#ws, SESSION_BUDGET_KEY);
    if (row !== undefined) {
      try {
        const value: unknown = JSON.parse(row.valueJson);
        const usd = isRecord(value) ? value["budgetUsd"] : undefined;
        if (typeof usd === "number" && Number.isFinite(usd) && usd > 0) {
          return { budgetUsd: usd, source: "settings", updatedAt: row.updatedAt };
        }
      } catch {
        // A hand-edited row: the default applies.
      }
    }
    return { budgetUsd: DEFAULT_SESSION_BUDGET_USD, source: "default", updatedAt: null };
  }

  /**
   * The route of a runner build for `sessionId`: create the session's key on
   * its first build, else `PUT` a changed allowlist or budget, then rotate.
   * Undefined when Bifrost is not configured or does not serve `provider`
   * (direct path). Refuses (`runner.gateway-unavailable`) while Bifrost is
   * configured but not `ok`: a call around it would skip the budget.
   */
  async route(
    sessionId: SessionId,
    choice: { provider: string; model: string },
  ): Promise<GatewayRoute | undefined> {
    const bifrost = this.#o.bifrost;
    if (bifrost === undefined) return undefined;
    const provider = BIFROST_PROVIDERS[choice.provider];
    if (provider === undefined) {
      if (!this.#directLogged.has(choice.provider)) {
        this.#directLogged.add(choice.provider);
        this.#log(
          `bifrost: provider ${choice.provider} is not served by Bifrost; its model calls go direct, without a session budget`,
        );
      }
      return undefined;
    }
    const client = bifrost.client;
    if (client === undefined) {
      throw fail(
        "runner.gateway-unavailable",
        `the model gateway (Bifrost) is not available (${bifrost.status.state}); model calls wait for it`,
        "hub",
      );
    }
    return this.#serial(sessionId, async () => {
      const budgetUsd = this.budget().budgetUsd;
      const row = this.#o.store.get(this.#ws, sessionId);
      let value: string;
      if (row === undefined) {
        const detail = {
          session_id: sessionId,
          provider,
          model: choice.model,
          budget_usd: budgetUsd,
        };
        const issued = await withAudit(
          this.#o.audit,
          this.#record(SYSTEM_PRINCIPAL, "bifrost.vk.create", sessionId, detail),
          () =>
            client.createVirtualKey({
              name: `session-${sessionId}`,
              provider,
              models: [choice.model],
              budgetUsd,
            }),
        );
        registerSecret(issued.value);
        const at = this.#now();
        this.#o.store.put(this.#ws, {
          sessionId,
          vkId: issued.id,
          provider,
          model: choice.model,
          budgetUsd,
          active: true,
          createdAt: at,
          updatedAt: at,
        });
        this.#log(`bifrost: virtual key ${issued.id} created for session ${sessionId}`);
        value = issued.value;
      } else {
        if (
          row.provider !== provider ||
          row.model !== choice.model ||
          row.budgetUsd !== budgetUsd ||
          !row.active
        ) {
          await this.#update(client, row, { provider, model: choice.model, budgetUsd });
        }
        const issued = await withAudit(
          this.#o.audit,
          this.#record(SYSTEM_PRINCIPAL, "bifrost.vk.rotate", sessionId, {
            session_id: sessionId,
            vk_id: row.vkId,
          }),
          () => client.rotateVirtualKey(row.vkId),
        );
        registerSecret(issued.value);
        value = issued.value;
      }
      return {
        baseUrl: `${new URL(bifrost.url).origin}/v1`,
        apiKey: value,
        modelId: `${provider}/${choice.model}`,
      };
    });
  }

  /** Archive: deactivate the session's key; every later call with it is refused. */
  async deactivate(sessionId: SessionId): Promise<void> {
    await this.#serial(sessionId, async () => {
      const row = this.#o.store.get(this.#ws, sessionId);
      if (row === undefined || !row.active) return;
      const client = this.#requireClient();
      await withAudit(
        this.#o.audit,
        this.#record(SYSTEM_PRINCIPAL, "bifrost.vk.deactivate", sessionId, {
          session_id: sessionId,
          vk_id: row.vkId,
        }),
        () => client.setVirtualKeyActive(row.vkId, false),
      );
      this.#o.store.put(this.#ws, { ...row, active: false, updatedAt: this.#now() });
      this.#log(`bifrost: virtual key ${row.vkId} of session ${sessionId} deactivated`);
    });
  }

  /** Session delete: delete the key in Bifrost (its request log stays) and the row. */
  async remove(sessionId: SessionId): Promise<void> {
    await this.#serial(sessionId, async () => {
      const row = this.#o.store.get(this.#ws, sessionId);
      if (row === undefined) return;
      const client = this.#requireClient();
      await withAudit(
        this.#o.audit,
        this.#record(SYSTEM_PRINCIPAL, "bifrost.vk.delete", sessionId, {
          session_id: sessionId,
          vk_id: row.vkId,
        }),
        () => client.deleteVirtualKey(row.vkId),
      );
      this.#o.store.remove(this.#ws, sessionId);
      this.#log(`bifrost: virtual key ${row.vkId} of session ${sessionId} deleted`);
    });
  }

  /** The session's spend and tokens from Bifrost's request log (`session.read`). */
  async spend(principal: Principal, sessionId: SessionId): Promise<SessionSpendView> {
    await this.#authorize(principal, "session.read", { type: "session", id: sessionId });
    if (!this.#o.sessionExists(sessionId)) {
      throw fail("session.not-found", `session ${sessionId} not found`);
    }
    const row = this.#o.store.get(this.#ws, sessionId);
    const bifrost = this.#o.bifrost;
    const base = {
      sessionId,
      bifrostState: bifrost?.status.state ?? null,
      budgetUsd: row?.budgetUsd ?? this.budget().budgetUsd,
      flushSeconds: SPEND_FLUSH_SECONDS,
    };
    if (bifrost === undefined) {
      return { ...base, gateway: "direct", spend: null, active: null };
    }
    if (row === undefined) return { ...base, gateway: "none", spend: null, active: null };
    return {
      ...base,
      gateway: "bifrost",
      spend: await this.#stats(row.vkId),
      active: row.active,
    };
  }

  async getBudget(principal: Principal): Promise<SessionBudgetView> {
    await this.#authorize(principal, "settings.read", { type: "setting", id: SESSION_BUDGET_KEY });
    return this.#budgetView();
  }

  /** Save the default session budget `{budgetUsd}`; every active key gets it now. */
  async putBudget(
    principal: Principal,
    body: unknown | RequestBody<unknown>,
  ): Promise<SessionBudgetView> {
    await this.#authorize(principal, "settings.session_budget.update", {
      type: "setting",
      id: SESSION_BUDGET_KEY,
    });
    // Read only now, after `authorize` (#32).
    const budgetUsd = parseBudget(await bodyOf(body));
    const previous = this.budget();
    await withAudit(
      this.#o.audit,
      this.#record(principal, "settings.session_budget.update", null, {
        budget_usd: budgetUsd,
        previous: previous.budgetUsd,
        previous_source: previous.source,
      }),
      () =>
        this.#o.settings.put(
          this.#ws,
          SESSION_BUDGET_KEY,
          JSON.stringify({ budgetUsd }),
          this.#now(),
        ),
    );
    this.#log(`bifrost: session budget set to $${budgetUsd} (was $${previous.budgetUsd})`);
    // Applied to the active keys now; a key Bifrost cannot take it for gets it
    // at its session's next runner build.
    const client = this.#o.bifrost?.client;
    if (client !== undefined) {
      for (const row of this.#o.store.list(this.#ws)) {
        if (!row.active || row.budgetUsd === budgetUsd) continue;
        await this.#serial(row.sessionId, async () => {
          const current = this.#o.store.get(this.#ws, row.sessionId);
          if (current === undefined || !current.active) return;
          await this.#update(client, current, {
            provider: current.provider,
            model: current.model,
            budgetUsd,
          }).catch((error: unknown) =>
            this.#log(
              `bifrost: could not apply the budget to session ${row.sessionId}: ${String(error)}`,
            ),
          );
        });
      }
    }
    return this.#budgetView();
  }

  async #budgetView(): Promise<SessionBudgetView> {
    const bifrost = this.#o.bifrost;
    return {
      ...this.budget(),
      bifrostState: bifrost?.status.state ?? null,
      total: bifrost === undefined ? null : await this.#stats(undefined),
      flushSeconds: SPEND_FLUSH_SECONDS,
    };
  }

  async #stats(vkId: string | undefined): Promise<VirtualKeyStats | null> {
    const client = this.#o.bifrost?.client;
    if (client === undefined) return null;
    try {
      return await client.stats(vkId);
    } catch (error) {
      this.#log(`bifrost: could not read the spend: ${String(error)}`);
      return null;
    }
  }

  async #update(
    client: BifrostClient,
    row: VirtualKeyRow,
    next: { provider: string; model: string; budgetUsd: number },
  ): Promise<void> {
    await withAudit(
      this.#o.audit,
      this.#record(SYSTEM_PRINCIPAL, "bifrost.vk.update", row.sessionId, {
        session_id: row.sessionId,
        vk_id: row.vkId,
        provider: next.provider,
        model: next.model,
        budget_usd: next.budgetUsd,
        previous_model: `${row.provider}/${row.model}`,
        previous_budget_usd: row.budgetUsd,
      }),
      async () => {
        await client.updateVirtualKey(row.vkId, {
          provider: next.provider,
          models: [next.model],
          budgetUsd: next.budgetUsd,
        });
        // A key deactivated by an archive is not reactivated here: an archived
        // session never builds a runner (`runner.failed`).
      },
    );
    this.#o.store.put(this.#ws, { ...row, ...next, updatedAt: this.#now() });
  }

  #requireClient(): BifrostClient {
    const client = this.#o.bifrost?.client;
    if (client === undefined) {
      throw fail(
        "runner.gateway-unavailable",
        `the model gateway (Bifrost) is not available (${this.#o.bifrost?.status.state ?? "not configured"})`,
        "hub",
      );
    }
    return client;
  }

  #serial<T>(sessionId: SessionId, work: () => Promise<T>): Promise<T> {
    const before = this.#locks.get(sessionId) ?? Promise.resolve();
    const next = before.then(work, work);
    const settled = next.catch(() => undefined);
    this.#locks.set(sessionId, settled);
    void settled.then(() => {
      if (this.#locks.get(sessionId) === settled) this.#locks.delete(sessionId);
    });
    return next;
  }

  #record(
    principal: Principal,
    action: string,
    sessionId: SessionId | null,
    detail: JsonValue,
  ): AuditRecord {
    return {
      workspaceId: principal.workspaceId,
      principalId: principal.id,
      principalKind: principal.kind,
      action,
      resource:
        sessionId === null
          ? { workspaceId: this.#ws, type: "setting", id: SESSION_BUDGET_KEY }
          : { workspaceId: this.#ws, type: "session", id: sessionId },
      at: this.#now(),
      detail,
    };
  }

  async #authorize(
    principal: Principal,
    action: `${string}.${string}`,
    resource: { type: string; id: string },
  ): Promise<void> {
    const decision = await this.#o.authorizer.authorize(principal, action, {
      workspaceId: this.#ws,
      ...resource,
    });
    if (!decision.allowed) throw fail("authz.denied", `${action} denied: ${decision.reason}`);
  }

  #log(line: string): void {
    (this.#o.log ?? console.error)(line);
  }
}
