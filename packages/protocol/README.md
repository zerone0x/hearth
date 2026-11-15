# @hearth/protocol

The hub-box wire protocol, version **1.0** (PRD §8.1–8.2). Pure types and
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
| `turn.start` | H→B | fire-and-forget | Start a turn with the user's input |
| `turn.event` | B→H | at-least-once | One event of a running turn, ordered by `seq` |
| `turn.end` | B→H | at-least-once | The turn ended: `completed`, `failed` (with a classified failure) or `cancelled` |
| `session.hibernate` | H→B | fire-and-forget | Hibernate a session |
| `hibernate.done` | B→H | at-least-once | Answer to `session.hibernate`: `hibernated`, `busy` or `failed` |
| `usage.report` | B→H | at-least-once | Token usage of one model call |
| `rpc` | both | fire-and-forget | Request; the caller times it out with its own deadline |
| `rpc.result` | both | fire-and-forget | Answer to the `rpc` with the same `id`: a result or an error |
| `delivery.ack` | H→B | fire-and-forget | A delivery was applied (written), not just received |
| `desktop.lock` | H→B | fire-and-forget | Current desktop lock holder and lease (PRD §8.3) |
| `ping` / `pong` | both | fire-and-forget | Liveness |
| `stream.open` | both | fire-and-forget | Open a byte stream of kind `vnc` or `file` |
| `stream.data` | both | fire-and-forget | Stream bytes, ordered by `seq` within the stream |
| `stream.close` | both | fire-and-forget | End a stream: `done`, `cancelled`, `error` or `revoked` |

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
