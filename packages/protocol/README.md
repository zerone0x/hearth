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
`invalid-field` (with the field's `path`) or `invalid-binary`. Unknown fields
are dropped, so a newer minor version can add optional fields.

## Frames

Direction: **B→H** box to hub, **H→B** hub to box, **both** either side.

| Frame | Direction | Delivery | Purpose |
|---|---|---|---|
| `hello` | B→H | fire-and-forget | First frame: protocol version, box id, boot id, credential |
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

## Versioning

`hello` carries `{ major, minor }`. Peers with the same major can talk; a minor
bump only adds optional fields or frame types. `checkHelloVersion(hello)`
returns `null` when the versions are compatible, or the `reject` frame to send,
whose message names both versions.

## Streams

Stream ids are unsigned 32-bit integers. The hub opens even ids and the box
opens odd ids, so the two sides never collide. `seq` starts at 0 for each
stream. A `file` stream names a path relative to the box workspace; the decoder
rejects absolute paths, drive letters and `..` segments.
