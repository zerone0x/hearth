/**
 * Trajectory API (decision 0021), behind the login guard like every `/v1`
 * route; each handler authorizes the signed-in principal first.
 *
 * - `GET /v1/sessions/:id/trajectory`: the session's trajectory as JSON Lines
 *   (`application/x-ndjson`, `hearth.trajectory/2`). `session.trajectory`.
 * - `POST /v1/sessions/:id/labels {turn_id?, task_type?, outcome?, verdict?}`:
 *   an outcome label for the session (no `turn_id`) or for one of its turns
 *   (`turn_id` must be a turn of this session, else 400), appended to the
 *   event log as `trajectory.label`. `session.label`.
 */

import {
  type Authorizer,
  DEFAULT_WORKSPACE_ID,
  type EventStore,
  HearthError,
  type Principal,
  type SessionId,
  type StoredEvent,
  type WorkspaceScope,
} from "@hearth/core";
import type { Context, Hono } from "hono";
import type { HubEnv } from "../auth";
import { redactHub } from "./redaction";
import { buildTrajectory, LABEL_OUTCOMES, type TrajectoryRecord, toJsonl } from "./trajectory";

export interface TrajectoriesOptions {
  readonly authorizer: Authorizer;
  readonly events: EventStore;
  /** Throws `session.not-found` for an unknown session. */
  readonly sessions: { get(principal: Principal, sessionId: SessionId): Promise<unknown> };
  readonly versions: { readonly pi: string; readonly hub: string };
}

const MAX_LABEL_CHARS = 200;

/** Every event of a session, oldest first. */
export async function readAllEvents(
  events: EventStore,
  scope: WorkspaceScope,
  sessionId: SessionId,
): Promise<StoredEvent[]> {
  const all: StoredEvent[] = [];
  let cursor = 0;
  for (;;) {
    const page = await events.read(scope, sessionId, cursor, 1000);
    all.push(...page.events);
    cursor = page.cursor;
    if (!page.hasMore) return all;
  }
}

function invalid(message: string): HearthError {
  return new HearthError(message, {
    owner: "user",
    disposition: "give-up",
    code: "request.invalid",
  });
}

export class Trajectories {
  readonly #o: TrajectoriesOptions;
  readonly #scope: WorkspaceScope = { workspaceId: DEFAULT_WORKSPACE_ID };

  constructor(options: TrajectoriesOptions) {
    this.#o = options;
  }

  async trajectory(principal: Principal, sessionId: SessionId): Promise<TrajectoryRecord[]> {
    await this.#authorize(principal, "session.trajectory", sessionId);
    const events = await readAllEvents(this.#o.events, this.#scope, sessionId);
    return buildTrajectory(events, { sessionId, versions: this.#o.versions, redact: redactHub });
  }

  async label(principal: Principal, sessionId: SessionId, input: unknown): Promise<void> {
    await this.#authorize(principal, "session.label", sessionId);
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw invalid("expected a JSON object");
    }
    const label: Record<string, string> = {};
    for (const [key, value] of Object.entries(input)) {
      if (!["turn_id", "task_type", "outcome", "verdict"].includes(key)) {
        throw invalid(`unknown field ${JSON.stringify(key)}`);
      }
      if (typeof value !== "string" || value.length === 0 || value.length > MAX_LABEL_CHARS) {
        throw invalid(`${key} must be a string of 1 to ${MAX_LABEL_CHARS} characters`);
      }
      label[key] = value;
    }
    if (
      label["outcome"] !== undefined &&
      !(LABEL_OUTCOMES as readonly string[]).includes(label["outcome"])
    ) {
      throw invalid(`outcome must be one of ${LABEL_OUTCOMES.join(", ")}`);
    }
    if (Object.keys(label).filter((k) => k !== "turn_id").length === 0) {
      throw invalid("set at least one of task_type, outcome, verdict");
    }
    const turnId = label["turn_id"];
    if (turnId !== undefined) {
      // A turn label must name a turn of this session; omit turn_id for the session.
      const events = await readAllEvents(this.#o.events, this.#scope, sessionId);
      const turns = new Set(
        events.filter((e) => e.type === "runner.turn.start").map((e) => e.turnId),
      );
      if (!turns.has(turnId)) {
        throw invalid(`turn_id ${JSON.stringify(turnId)} is not a turn of this session`);
      }
    }
    await this.#o.events.append(this.#scope, sessionId, {
      type: "trajectory.label",
      ...(label["turn_id"] === undefined ? {} : { turnId: label["turn_id"] }),
      payload: label,
    });
  }

  async #authorize(principal: Principal, action: `${string}.${string}`, sessionId: SessionId) {
    const decision = await this.#o.authorizer.authorize(principal, action, {
      workspaceId: this.#scope.workspaceId,
      type: "session",
      id: sessionId,
    });
    if (!decision.allowed) {
      throw new HearthError(`${action} denied: ${decision.reason}`, {
        owner: "user",
        disposition: "give-up",
        code: "authz.denied",
      });
    }
    await this.#o.sessions.get(principal, sessionId);
  }
}

function failure(c: Context<HubEnv>, error: unknown): Response {
  if (!(error instanceof HearthError)) throw error;
  const status =
    error.code === "authz.denied"
      ? 403
      : error.code === "session.not-found"
        ? 404
        : error.code === "request.invalid"
          ? 400
          : 500;
  return c.json(
    {
      ok: false,
      error: {
        code: error.code,
        owner: error.owner,
        disposition: error.disposition,
        message: error.message,
      },
    },
    status,
  );
}

export function mountTrajectoryRoutes(app: Hono<HubEnv>, trajectories: Trajectories): void {
  app.get("/v1/sessions/:id/trajectory", async (c) => {
    try {
      const records = await trajectories.trajectory(c.get("principal"), c.req.param("id"));
      return c.body(redactHub(toJsonl(records)), 200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "content-disposition": `attachment; filename="trajectory-${c.req.param("id").replace(/[^A-Za-z0-9_-]/g, "_")}.jsonl"`,
      });
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post("/v1/sessions/:id/labels", async (c) => {
    try {
      let input: unknown;
      try {
        input = await c.req.json();
      } catch {
        throw invalid("the body is not JSON");
      }
      await trajectories.label(c.get("principal"), c.req.param("id"), input);
      return c.json({ ok: true }, 200);
    } catch (error) {
      return failure(c, error);
    }
  });
}
