# @hearth/protocol

The hub-box wire protocol, version **1.4** (PRD §8.1–8.2). Pure types and
encode/decode functions: no sockets, no I/O, and no hub-local paths or addresses.

```ts
import { decodeFrame, encodeFrame } from "@hearth/protocol";

const result = decodeFrame(message); // never throws
if (!result.ok) console.warn(result.error.code, result.error.message);
```

## Wire format

One WebSocket per box, opened by the box. Two kinds of message share it:

- **Text messages** hold one JSON object with a `type`. Every frame except
  `stream.data` is sent this way.
- **Binary messages** are `stream.data`: byte 0 is the tag `0x01`, bytes 1–4 the
  stream id, bytes 5–8 the sequence number (both unsigned 32-bit, big-endian),
  then the payload. Bytes are never base64-encoded.

`decodeFrame` returns `{ ok: true, frame }` or `{ ok: false, error }`, where
`error.code` is one of `invalid-json`, `not-a-frame`, `unknown-type`,
`invalid-field` (with the field's `path`), `invalid-binary` or
`version-mismatch` (see [Versioning](#versioning)). An `unknown-type` error
echoes at most `MAX_ECHOED_TYPE_LENGTH` (64) characters of the received type.

Unknown fields are dropped, so a newer minor version can add optional fields.
A field that belongs to another variant of the same frame is rejected, not
dropped: `path` or `mode` on a `vnc` stream, `failure` on a non-failed outcome,
`hubVersion` or `boxVersion` on a reject that is not `version-mismatch`, and
`result` and `error` together in an `rpc.result`.

`encodeFrame` never produces a message the decoder rejects. A frame that fails
validation (say a `ping` with a negative nonce), or that JSON cannot carry
faithfully (`NaN`, a `Uint8Array` inside a payload), throws `EncodeError`, a
`RangeError`. That is a caller bug, not bad input. A property test checks that
every frame that encodes decodes back to an equal frame.

Opaque JSON payloads (`turn.event` `event`, `rpc` params and results) nest at
most `MAX_JSON_DEPTH` (64) arrays and objects, counting the outermost one.

## Failures

A `failed` outcome carries a `Failure`: an `owner` (`FailureOwner`: `box`,
`model-provider`, `gateway`, `hub`, `user`), a `disposition`
(`FailureDisposition`) and a `message`. This package owns that vocabulary;
other packages import the types from `@hearth/protocol`.

| Disposition | Meaning |
|---|---|
| `retry` | Retrying the same work may succeed, on the same box |
| `retry-cold` | Retry only on a fresh box started by a cold boot; this box or its state is suspect |
| `give-up` | Retrying will not help; surface the failure |

## Frames

Direction: **B→H** box to hub, **H→B** hub to box, **both** either side.

| Frame | Direction | Delivery | Purpose |
|---|---|---|---|
| `hello` | B→H | fire-and-forget | First frame: protocol version, box id, boot id, credential, box state |
| `welcome` | H→B | fire-and-forget | Handshake accepted; may carry the per-box credential |
| `reject` | H→B | fire-and-forget | Handshake refused, with a reason; names both versions on `version-mismatch` |
| `session.assign` | H→B | fire-and-forget | Run (or resume) a session in this box |
| `turn.start` | H→B | fire-and-forget | **Deprecated (0015).** Start a turn with the user's input |
| `turn.event` | B→H | at-least-once | One event of a running turn, ordered by `seq` |
| `turn.end` | B→H | at-least-once | **Deprecated (0015).** The turn ended: `completed`, `failed` (with a classified failure) or `cancelled` |
| `session.hibernate` | H→B | fire-and-forget | Hibernate a session |
| `hibernate.done` | B→H | at-least-once | Answer to `session.hibernate`: `hibernated`, `busy` or `failed` |
| `usage.report` | B→H | at-least-once | Token usage of one model call |
| `rpc` | both | fire-and-forget | Request; the caller times it out with its own deadline. Tool methods: [Tool RPC](#tool-rpc-11) |
| `rpc.result` | both | fire-and-forget | Answer to the `rpc` with the same `id`: a result or an error |
| `delivery.ack` | H→B | fire-and-forget | A delivery was applied (written), not just received |
| `desktop.lock` | H→B | fire-and-forget | Current desktop lock holder and lease (PRD §8.3) |
| `ping` / `pong` | both | fire-and-forget | Liveness: each end pings on its own heartbeat and treats any frame as alive ([Heartbeat](#heartbeat)) |
| `stream.open` | both | fire-and-forget | Open a byte stream of kind `vnc` or `file` |
| `stream.data` | both | fire-and-forget | Stream bytes, ordered by `seq` within the stream |
| `stream.close` | both | fire-and-forget | End a stream: `done`, `cancelled`, `error` or `revoked` |

**Deprecated: `turn.start` and `turn.end`** (docs/DECISIONS.md, 0015). Turns
run in the hub's pi runner (0009), not in the box. The hub never sends
`turn.start`; box-agent answers one with a failed `turn.end`, so a turn still
never runs twice. Both frames stay in the codec for wire compatibility and go
at the next major `PROTOCOL_VERSION`. New code must not send them.

`FRAME_SPECS` in `src/frames.ts` holds the same table in code.

## Delivery

- **At-least-once** frames carry `bootId` and `deliveryId`. `deliveryId` is a
  positive integer, strictly increasing within one boot of the box. The box
  buffers each such frame until the hub sends `delivery.ack` with the same pair,
  and redelivers what is unacked after a reconnect. The hub acks only after the
  frame is applied, and applying the same (`bootId`, `deliveryId`) twice is a
  no-op (PRD §8.1, principle 5).
- A lost `delivery.ack` is harmless: the box redelivers, the hub skips the
  apply and acks again.
- **Fire-and-forget** frames are sent once and lost if the connection drops.
  Recovery comes from the layer above: the box retries the handshake, the hub's
  session state machine re-drives commands after a reconnect, an `rpc` caller
  hits its deadline, and a broken stream is reopened.

## Commands are idempotent

`session.assign`, `turn.start` and `session.hibernate` are the hub → box
commands. They are fire-and-forget, and after a reconnect the hub re-sends any
command whose effect it has not seen. So the box may receive a command twice and
must apply it at most once. `isDuplicateCommand(history, command)` is the rule,
and the box ignores a command it returns `true` for:

- `turn.start` whose `turnId` the box already knows in this boot (running or
  ended). A turn never runs twice. Its `turn.event` and `turn.end` frames are
  at-least-once, so the hub gets the outcome anyway.
- `session.hibernate` whose `requestId` the box already knows in this boot. Its
  one `hibernate.done` is at-least-once.
- `session.assign` whose `requestId` the box already knows in this boot. The
  hub gives every assignment it decides on a new `requestId` (a resume after
  hibernation is a new assignment), so a replayed assign is ignored even after
  the session was hibernated and cannot wake it again.

A re-sent command always carries its original `turnId` or `requestId`; the
hub never mints a new one for a re-send.

## Reconnect

Every `hello` carries the box's `state`:

| Field | Meaning |
|---|---|
| `sessionId` | The session assigned to the box, or `null` |
| `turnId` | The turn running in that session, or `null` (requires `sessionId`) |
| `lastDeliveryId` | The highest `deliveryId` sent in this boot, or 0 when none |

The state is part of `hello`, so it is fire-and-forget like the rest of the
handshake: it is a snapshot that is sent again on every connect, and the hub has
it before it sends anything. On reconnect the hub:

1. Compares `bootId` with the boot it knew. A new boot means the box lost its
   memory: a turn the hub thought was running on the old boot is ended visibly
   as failed (owner `box`) and is never re-sent, since part of its work may
   already have happened (PRD §8.1, principles 1 and 7).
2. On the same boot, applies the redelivered at-least-once frames until it has
   applied `lastDeliveryId`. It then knows everything the box has reported.
3. Re-sends what the box still lacks: `session.assign` when `state.sessionId`
   is not the session it assigned, `turn.start` for a turn with no `turn.end`
   that is not `state.turnId`, `session.hibernate` for a request with no
   `hibernate.done`. Each re-send keeps its original `turnId` or `requestId`,
   so the box ignores one it already applied, in any order: a replayed assign
   that arrives after the session was hibernated does not wake it.

## Tool RPC (1.1)

The hub-side pi runner sends tool calls to the box as ordinary `rpc` frames,
answered by `rpc.result` (PRD §8.2.1, decisions 0009 and 0011). Types, guards
and limits are in `src/tools.ts`: `decodeToolParams`, `decodeToolResult`,
`toolDeadlineMs`, `classifyToolError`.

| Method | pi operation | Params (besides `callId`) | Result |
|---|---|---|---|
| `tool.readFile` | `ReadOperations.readFile`, `EditOperations.readFile` | `path` | `data` (base64), `size` |
| `tool.access` | `ReadOperations.access` (`write: false`), `EditOperations.access` (`write: true`) | `path`, `write` | `{}` |
| `tool.imageMimeType` | `ReadOperations.detectImageMimeType` | `path` | `mimeType` or `null` |
| `tool.writeFile` | `WriteOperations.writeFile`, `EditOperations.writeFile` | `path`, `content` (UTF-8) | `bytes` |
| `tool.mkdir` | `WriteOperations.mkdir` (recursive) | `path` | `{}` |
| `tool.exists` | `LsOperations.exists`, `FindOperations.exists` | `path` | `exists` |
| `tool.stat` | `LsOperations.stat`, `GrepOperations.isDirectory` | `path` | `isDirectory`, `isFile`, `size` |
| `tool.readdir` | `LsOperations.readdir` | `path` | `entries`, `omitted` |
| `tool.glob` | `FindOperations.glob` | `pattern`, `cwd`, `ignore`, `limit` | `paths` (relative to `cwd`), `limitReached` |
| `tool.grep` | the grep tool's `execute()`, run as `rg` in the box | `pattern`, `path`, `glob?`, `ignoreCase`, `literal`, `context`, `limit` | `output`, `matches`, `limitReached`, `truncatedBytes` |
| `tool.exec` | `BashOperations.exec` | `command`, `cwd`, `timeoutMs`, `outputStream?` (1.4, [live output](#live-exec-output-14)) | `outcome` (`exited`, `timed-out`, `cancelled`), `exitCode`, `output`, `truncatedBytes`, `fullOutputPath` |
| `tool.cancel` | pi's abort signal | `target` (the `rpc` id) | `found` |

Rules:

- **`callId`** is pi's tool call id, for logs and audit. The **`rpc` id is the
  idempotency key**: the box runs an id at most once per boot. A re-send of a
  running id is answered when it ends, of a finished id with the same answer,
  and of an id whose answer was evicted with `tool.result-expired`. The hub
  mints ids as `tool_<uuid>`.
- **No environment crosses.** `tool.exec` has no `env` field (the decoder drops
  one). The box runs commands with its own minimal environment.
- **Paths are box paths inside `/workspace`.** Relative ones resolve against
  it. The box refuses absolute paths outside it, any `..` segment, and paths
  that leave it through a symlink (`tool.path-escape`). A glob pattern whose
  literal leading segments leave it is refused too, and matches that resolve
  outside it are dropped. The box does not expand `~`; the runner rewrites
  `~` to `/workspace` before the call.
- **Regular files only.** `tool.readFile`, `tool.imageMimeType` and
  `tool.writeFile` refuse a FIFO, socket or device with
  `tool.not-regular-file`, without blocking on it.
- **Limits:** files up to `MAX_TOOL_FILE_BYTES` (1 MiB) per read or write;
  output up to `MAX_TOOL_OUTPUT_BYTES` (256 KiB), keeping the tail behind a
  `truncationMarker`; a truncated command's whole output (up to 16 MiB) is
  written in the box under `/workspace/.hearth/exec/` and named by
  `fullOutputPath`; lists up to 10,000 entries; `MAX_CONCURRENT_TOOL_CALLS`
  (16) per box, past which a call gets `tool.busy`. A command runs for
  `timeoutMs` (at most 1 h) and is then killed with its whole process group,
  as on `tool.cancel`, and with every process that still carries the run's
  `HEARTH_EXEC` marker in its environment (a `setsid` child); searches stop
  after `SEARCH_TIMEOUT_MS` (30 s) and every file method after
  `FILE_TIMEOUT_MS` (25 s), with `tool.deadline`.
- **Deadline.** The hub times every call with `toolDeadlineMs(method, params)`:
  the box's own budget for the call plus `TOOL_DEADLINE_GRACE_MS` (5 s). A
  call past it fails with `tool.deadline`; a command is cancelled.
- **Reconnect mid-call.** A dropped connection does not end a call. If the box
  comes back with the **same `bootId`**, the hub re-sends the call with the
  same id and gets its one answer. If it comes back with a **new `bootId`**,
  the call's outcome is unknown: it fails with `tool.outcome-unknown` and is
  never re-sent. Mutating methods (`tool.writeFile`, `tool.mkdir`,
  `tool.exec`) are then `give-up`; read-only ones are `retry`.

Error codes and their classification (`TOOL_ERRORS`):

| Code | Owner | Disposition |
|---|---|---|
| `tool.bad-params` | `hub` | `give-up` |
| `tool.path-escape`, `tool.not-found`, `tool.permission`, `tool.not-a-directory`, `tool.is-a-directory`, `tool.not-regular-file`, `tool.too-large` | `user` | `give-up` |
| `tool.busy` | `box` | `retry` |
| `tool.io`, `tool.result-expired` | `box` | `give-up` |
| `tool.internal` | `box` | `retry-cold` |
| `tool.deadline`, `tool.outcome-unknown` | `box` | `give-up` when mutating, `retry` when read-only |

## Trace context (1.2)

An `rpc` frame may carry `traceparent`, a W3C Trace Context version-00 header
(`00-<32 hex trace id>-<16 hex span id>-<2 hex flags>`, `src/trace.ts`). The hub
sets it on every tool call to the span of that call, so the box's log lines for
it carry the same trace id (decision 0021). It is optional: a 1.1 peer drops
it, and the decoder drops a malformed one instead of refusing the call, since
tracing never fails a tool call.

## Live exec output (1.4)

Decision 0036. A `tool.exec` may name `outputStream`, an even stream id with
the top bit set (`isLiveOutputStreamId`: `LIVE_OUTPUT_STREAM_BASE` = 2^31 and
up; the desktop bridge's ids stay below). The box then sends the command's
output, stdout and stderr merged in arrival order, as `stream.data` frames on
that id while it runs, and one `stream.close` (`done`) before the
`rpc.result`. No `stream.open` is sent: the `rpc` opens it. No frame type is
new.

- **A preview, not the answer.** The frames are fire-and-forget and lossy;
  the `rpc.result` still carries the output as before.
- **Coalesced and capped.** The box sends at most one frame per
  `LIVE_OUTPUT_INTERVAL_MS` (100 ms), or one early once
  `LIVE_OUTPUT_CHUNK_BYTES` (16 KiB) wait, and at most `MAX_LIVE_OUTPUT_BYTES`
  (64 KiB) per command.
- **Backpressure.** When its hub socket is backed up the box drops waiting
  bytes instead of queuing them. A hub `stream.close` on the id stops the
  stream; the command runs on. The hub sends one (`cancelled`) once it takes
  no more of the command's output (its cap, or a failed store).
- **Compatibility.** A 1.3 box drops the unknown param and answers once. A
  1.3 hub never sends it.

## Browser RPC (1.3)

The `browser.*` methods (`src/browser.ts`, decision 0032) drive the box's
Chromium over CDP on loopback (decision 0026). They are tool methods: same
`rpc` frames, `callId`, once-per-boot ids, deadlines and error classification
as above. A 1.2 box answers them `unknown-method`; the hub tells the model the
box does not have browser tools.

| Method | Params | Result |
|---|---|---|
| `browser.navigate` | `url` (http, https, `about:blank`), `tab?`, `expect?`, `expectTimeoutMs?` | action result + `status` |
| `browser.back`, `browser.forward` | `tab?`, `expect?`, `expectTimeoutMs?` | action result + `status`; `navigation_failed` with no such history entry |
| `browser.snapshot` | `tab?`, `ref?` (subtree), `depth?` | `tab`, `url`, `title`, `snapshot` |
| `browser.find` | `text` or `regex`, `tab?`, `max?` | `snapshotId`, `lines`, `matches`, `limitReached` |
| `browser.click` | `ref`, `element`, `button?`, `double?`, `expect?`, `expectTimeoutMs?` | action result |
| `browser.type` | `ref`, `element`, `text`, `submit?`, `expect?`, `expectTimeoutMs?` | action result |
| `browser.select` | `ref`, `element`, `values`, `expect?`, `expectTimeoutMs?` | action result |
| `browser.press` | `key`, `ref?` and `element?` or `tab?`, `expect?`, `expectTimeoutMs?` | action result |
| `browser.wait` | `urlIncludes?`, `titleIncludes?`, `textVisible?`, `textGone?` (one at least), `tab?`, `timeoutMs` | action result |
| `browser.screenshot` | `tab?`, `ref?`, `fullPage?` | `data` (JPEG, base64, ≤ 1 MiB), `mimeType`, `bytes`, `sha256`, `width`, `height` |
| `browser.tabs` | `action` (`list`, `new`, `select`, `close`), `index?`, `url?` | `tabs` (`index`, `url`, `title`, `active`), `active` |

- **Refs.** A snapshot's refs are `s<generation>` plus Playwright's ref
  (`s7e12`, `s7f1e3` in a frame). Each snapshot of a tab gets a new
  generation; a ref that is not of a tab's latest snapshot, or whose tab
  navigated since, is refused at once.
- **Action result.** `ok`, `outcome` (`done`, `not_verified`, `stale_ref`,
  `not_actionable`, `timeout`, `navigation_failed`), `message`, `verified`
  (`expect` held, did not, or `null` when none was given), `tab`, `url`,
  `title`, `dialogs` the box dismissed, and the fresh `snapshot` ("snapshot
  last"). `ok` is false when `expect` did not hold.
- **Snapshot cap.** `snapshot.text` holds at most `MAX_SNAPSHOT_TEXT_BYTES`
  (24 KiB), cut at a line end with a marker; the whole snapshot is in the
  box at `fullSnapshotPath` (under `.hearth/browser/`).
- **Budget.** `browserBudgetMs(method, params)`: connect, the action or
  navigation, `expectTimeoutMs` or `timeoutMs`, and the closing snapshot.
  The hub adds the grace. Acting methods and `browser.tabs` are mutating.

| Code | Owner | Disposition |
|---|---|---|
| `browser.unavailable` (no CDP answer, or Chromium gone during the call) | `box` | `give-up` when mutating, `retry` when read-only |
| `browser.no-tab`, `browser.bad-url`, `browser.stale-ref` (screenshot or subtree), `browser.failed` | `user` | `give-up` |

## Versioning

`hello` carries `{ major, minor }`. Peers with the same major can talk; a minor
bump only adds optional fields or frame types.

**Frozen across all major versions:** the `type` and `version` fields of
`hello` (`version` is `{ major, minor }`, two unsigned integers), and the whole
`reject` frame. Every future major keeps them, so any two versions can always
tell each other why they cannot talk.

The decoder reads a `hello`'s `type` and `version` before any other field. When
the major differs from its own, it stops and returns `version-mismatch` with
`peerVersion`, whatever shape the rest of the hello has. The hub turns a failed
first frame into the `reject` to send with `rejectHello(error)`:
`version-mismatch` naming both versions, or `malformed-hello` otherwise.
`checkHelloVersion(hello)` does the same check on a decoded hello.

## Streams

Stream ids are unsigned 32-bit integers. The hub opens even ids and the box
opens odd ids, so the two sides never collide. `seq` starts at 0 for each
stream. A `file` stream names a path relative to the box workspace; the decoder
rejects absolute paths, drive letters, `..` segments, and control or bidi
characters (U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069), which could
make a path display as a different one.

## Heartbeat

Each end runs its own `Heartbeat` (`src/heartbeat.ts`, decision 0028) once
the handshake is done: every `HEARTBEAT_INTERVAL_MS` (5 s) it checks whether
any frame came from the peer since the previous beat, and sends a `ping`. A
beat that heard nothing is a miss; any frame resets the count. After
`HEARTBEAT_MAX_MISSES` (3) misses in a row the connection is dead, between
`3 × 5 s` and `heartbeatBoundMs()` (20 s) after the last frame. The hub then
drops the connection (close code 4005 where one is sent) and fails its calls;
the box drops it and reconnects with backoff. A peer must answer `ping` with
`pong`; it does not have to ping on its own.
