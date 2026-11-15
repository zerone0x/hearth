/**
 * The faux model server (decision 0020): a scripted stand-in for an
 * OpenAI-compatible chat completions endpoint, so a hub running in its own
 * container can be driven through a real turn without model credits.
 *
 * pi-ai's in-process faux provider cannot reach a hub in another process, so
 * the compose e2e points the hub at this server through a pi `models.json`
 * (`HEARTH_MODELS_FILE`) and scripts it over HTTP instead:
 *
 * - `POST /v1/chat/completions` (streaming only): answers with the next
 *   scripted reply, or a plain text reply when the script is empty.
 * - `POST /faux/script` `[{"text": "..."} | {"toolCalls": [{id, name, arguments}]}]`:
 *   replaces the script.
 * - `GET /faux/requests`: every completion request seen so far, as
 *   `{authorization, model, lastRole}`, so a test can check which key the hub sent.
 * - `GET /faux/blank`: an empty page, on another origin than the hub.
 *
 *   bun deploy/e2e/faux-model.ts [port]      # binds 127.0.0.1, default port 18080
 */

export type FauxReply =
  | { readonly text: string }
  | {
      readonly toolCalls: ReadonlyArray<{
        readonly id: string;
        readonly name: string;
        readonly arguments: Record<string, unknown>;
      }>;
    };

export interface FauxRequest {
  readonly authorization: string | null;
  readonly model: string;
  readonly lastRole: string;
}

export interface FauxModelServer {
  readonly url: string;
  readonly port: number;
  script(replies: readonly FauxReply[]): void;
  readonly requests: readonly FauxRequest[];
  stop(): void;
}

/** The text of a reply when the script has run out. */
export const FAUX_DEFAULT_TEXT = "faux model: no scripted reply left";

function chunk(model: string, delta: Record<string, unknown>, finish: string | null): string {
  const body = {
    id: "chatcmpl-faux",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  return `data: ${JSON.stringify(body)}\n\n`;
}

function stream(model: string, reply: FauxReply): string {
  let out = chunk(model, { role: "assistant", content: "" }, null);
  if ("text" in reply) {
    out += chunk(model, { content: reply.text }, null);
    out += chunk(model, {}, "stop");
  } else {
    reply.toolCalls.forEach((call, index) => {
      out += chunk(
        model,
        {
          tool_calls: [
            {
              index,
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            },
          ],
        },
        null,
      );
    });
    out += chunk(model, {}, "tool_calls");
  }
  const usage = {
    id: "chatcmpl-faux",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  return `${out}data: ${JSON.stringify(usage)}\n\ndata: [DONE]\n\n`;
}

function isReply(value: unknown): value is FauxReply {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v["text"] === "string") return true;
  return (
    Array.isArray(v["toolCalls"]) &&
    v["toolCalls"].every(
      (c: unknown) =>
        typeof c === "object" &&
        c !== null &&
        typeof (c as Record<string, unknown>)["id"] === "string" &&
        typeof (c as Record<string, unknown>)["name"] === "string" &&
        typeof (c as Record<string, unknown>)["arguments"] === "object",
    )
  );
}

/** Starts the server on `127.0.0.1:port` (0: a free port). */
export function startFauxModel(port = 0): FauxModelServer {
  let script: FauxReply[] = [];
  const requests: FauxRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/faux/script") {
        const body: unknown = await req.json().catch(() => undefined);
        if (!Array.isArray(body) || !body.every(isReply)) {
          return Response.json({ error: "expected an array of replies" }, { status: 400 });
        }
        script = [...body];
        return Response.json({ ok: true, queued: script.length });
      }
      if (req.method === "GET" && url.pathname === "/faux/blank") {
        // A page on another origin than the hub, for the cross-origin check.
        return new Response("<!doctype html><title>another origin</title><p>another origin</p>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (req.method === "GET" && url.pathname === "/faux/requests") {
        return Response.json(requests);
      }
      if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
        const body = (await req.json().catch(() => ({}))) as {
          model?: unknown;
          stream?: unknown;
          messages?: Array<{ role?: unknown }>;
        };
        const model = typeof body.model === "string" ? body.model : "faux";
        requests.push({
          authorization: req.headers.get("authorization"),
          model,
          lastRole: String(body.messages?.at(-1)?.role ?? ""),
        });
        if (body.stream !== true) {
          return Response.json({ error: "the faux model only streams" }, { status: 400 });
        }
        const reply = script.shift() ?? { text: FAUX_DEFAULT_TEXT };
        return new Response(stream(model, reply), {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const actual = server.port ?? port;
  return {
    url: `http://127.0.0.1:${actual}`,
    port: actual,
    script(replies) {
      script = [...replies];
    },
    requests,
    stop: () => void server.stop(true),
  };
}

if (import.meta.main) {
  const port = Number(process.argv[2] ?? "18080");
  const server = startFauxModel(port);
  console.log(`faux model listening on ${server.url}`);
}
