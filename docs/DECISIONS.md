# Decision log

Numbered, append-only. Each entry records a choice that the PRD leaves open or a
change in scope. To reverse a decision, add a new entry that supersedes it.

## 0001: Stack and repo scaffold

- Date: 2026-11-15
- Status: accepted
- Issue: #1

### Decision

- **Runtime and package manager: Bun 1.4.4** (`packageManager` in the root
  `package.json`), with Bun workspaces `apps/*` and `packages/*`:
  `apps/hub`, `apps/box-agent`, `packages/protocol`, `packages/core`. Package
  names are scoped `@hearth/*`. The lockfile `bun.lock` is committed, and
  `bunfig.toml` saves exact versions.
- **No build step between workspaces.** Each workspace exports `./src/index.ts`
  and Bun runs TypeScript directly. Bundling or compiling to a single binary is
  left to the deploy work.
- **TypeScript 7.0.2, typecheck only** (`tsc -p tsconfig.json`, `noEmit`). One
  shared `tsconfig.base.json` with `strict` plus `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`,
  `noImplicitOverride` and `verbatimModuleSyntax`. The root `tsconfig.json`
  typechecks every workspace and `scripts/` in one pass; each workspace also has
  a `tsconfig.json` for editors.
- **Biome 2.6.7 for lint, import order and formatting.** One fast tool instead of
  ESLint plus Prettier, with no plugin tree to keep in sync. The `recommended`
  preset is on, with one change: `complexity/useLiteralKeys` is off because it
  conflicts with `noPropertyAccessFromIndexSignature` (which requires
  `process.env["NAME"]`). Markdown is excluded, so docs keep their hand
  formatting.
- **Tests: `bun test`**, with `*.test.ts` files next to the code. No other runner.
- **HTTP: Hono 4.13.18** on `Bun.serve`, as in the PRD's stack table.
- **One gate: `bun run check`**, which runs typecheck, lint, format check,
  `bun run pins` and `bun test`. CI runs the same command, so a local pass and a
  CI pass mean the same thing.
- **pi pin check.** `scripts/check-pins.ts` fails when any manifest uses
  `@mariozechner/*`, when an `@earendil-works/pi-*` dependency is not an exact
  version, when they disagree, or when `bun.lock` resolves any
  `@earendil-works/pi-*` package (including transitive ones) to a different
  version. `apps/box-agent` depends on the three pi packages at 1.5.2 from the
  start, so the pin is enforced before any pi code is written.
- **Renovate** (`renovate.json`) groups the `@earendil-works/pi-*` packages into
  one PR, so they always move together (PRD §8.4).
- **The hub listens on `127.0.0.1:8787` by default** (PRD §10), overridable with
  `HEARTH_HOST` and `HEARTH_PORT`. These are listening settings, not secrets.
- **`GET /healthz` does not call `authorize`.** It is a liveness probe for the
  reverse proxy and container runtime, takes no input and returns no workspace
  data. Every other handler calls `authorize` first (PRD §7).
- **Docker-dependent tests** run only when `HEARTH_DOCKER_TESTS=1` is set, so
  `bun run check` passes on machines without Docker.

### Consequences

- Moving to another formatter or test runner would need a new decision entry.
- TypeScript 7 is the native compiler. If a tool the project adopts later only
  supports the TypeScript 5 API, that tool runs separately; the typecheck gate
  stays on `tsc` 7.

## 0002: Hub-box protocol v1 wire format and validation

- Date: 2026-11-15
- Status: accepted
- Issue: #2

### Decision

- **Validation: hand-written guards, no schema library.** `packages/protocol`
  has no runtime dependencies. A small `Fields` reader checks each field and
  fails with the field's path; `decodeFrame` catches that at its boundary and
  returns a typed `DecodeError`, so callers never see a throw. A schema library
  (zod, valibot, TypeBox) would add a dependency to both the hub and the box
  image for about twenty small frames; the guards are short and the round-trip
  and rejection tests cover every frame type.
- **Decoders build fresh objects from known fields only.** Unknown fields are
  dropped, which lets a newer minor version add optional fields. Opaque JSON
  payloads (`turn.event.event`, `rpc` params and results) are checked to be
  JSON, depth-limited, and copied so a `__proto__` key stays plain data.
- **JSON text for typed frames, binary for `stream.data`.** VNC traffic is the
  bulk of the bytes, so stream data goes as a binary WebSocket message with a
  9-byte header (tag, stream id, sequence) instead of base64 in JSON.
- **At-least-once frames are exactly `turn.event`, `turn.end`,
  `hibernate.done` and `usage.report`**, all box to hub. Hub-to-box commands are
  fire-and-forget on the wire: the hub owns the session state machine and
  re-drives commands after a reconnect. `rpc` is fire-and-forget; the caller
  owns a named deadline.
- **Fixed outcome sets.** `turn.end` is `completed`, `failed` or `cancelled`;
  `hibernate.done` is `hibernated`, `busy` or `failed`. A `failed` outcome must
  carry a failure classified by owner (`box`, `model-provider`, `gateway`,
  `hub`, `user`) and retryability (PRD §8.1, principles 2 and 6).
- **Desktop lock leases are durations (`leaseMs`), not timestamps**, so the box
  never compares its clock with the hub's. An `epoch` orders lock updates.
- **Stream ids: the hub opens even ids, the box opens odd ids.** File streams
  name a path relative to the box workspace, and the decoder rejects absolute
  paths, drive letters and `..` segments (PRD §8.2, no hub-local paths).

### Consequences

- Adding a frame type means a decoder, a `FRAME_SPECS` row, a README row and a
  test sample; the test file's mapped sample type fails to compile until the
  sample exists.
- Moving to a schema library later would need a new decision entry.

## 0003: Extension-point contracts in packages/core

- Date: 2026-11-15
- Status: accepted
- Issue: #3

### Decision

- **One module per extension point** in `packages/core/src` (`tenancy`, `identity`,
  `authorize`, `box`, `events`, `secrets`, `gateway`, `channel`, `audit`), all
  re-exported from `@hearth/core`. Ids are plain string aliases (no branding),
  so they cross SQLite, the wire protocol and logs without conversion.
- **Failure classification.** `HearthError` carries an `owner`
  (`box`, `model-provider`, `gateway`, `hub`, `user`), a `disposition`
  (`retry`, `retry-cold`, `give-up`) and a stable `code` (PRD §8.1 principle 2).
  Implementations of every extension point reject with it. `@hearth/protocol`
  owns the vocabulary, so a failure means the same thing in core and on the wire:
  core imports and re-exports `FailureOwner` from it. Until the protocol exports
  the disposition union (#14), core defines `FailureDisposition` as the identical
  union; a follow-up turns it into a re-export.
- **Every store call takes a `WorkspaceScope`** as its first argument (E1). v1
  has one fixed workspace, `ws_default`, and one local principal, `pr_local`.
- **`authorize` fails closed on audit.** `AllowAllAuthorizer` allows anything
  inside the principal's own workspace and writes every decision to the
  `AuditSink` before returning it. If the audit write fails, the answer is a
  denial (`audit unavailable`), never an allow (PRD §10). A resource in another
  workspace is denied by every implementation.
- **`withAudit(sink, record, action)` lives in core**, since it only needs the
  `AuditSink` interface. The hub's SQLite sink (#4) plugs into it.
- **`EventStore`**: `append(scope, sessionId, event)` returns `{ seq, duplicate }`
  and is idempotent on `(bootId, deliveryId)` for box-originated events;
  `read(scope, sessionId, afterSeq, limit)` returns a page with a `cursor` and
  `hasMore`; `seq` starts at 1, and `0` means "from the start".
- **`BoxProvider` verbs.** `create` provisions durable parts only (volume,
  network). `start(spec, boot)` builds a fresh runtime from the spec, since the
  container is disposable, and passes the per-boot environment (hub URL, one-time
  join token). `stop` is hibernate: remove the runtime, keep the volume.
  `destroy` removes everything. `attach(boxId)` re-attaches to one box by
  inspecting it (the box dials the hub, so attach opens no channel); `adopt()`
  lists every managed box at hub startup. `stop`, `destroy` and `snapshot` return
  explicit outcomes (`not-found`, `already-stopped`, `not-supported`) instead of
  throwing (PRD §8.1 principle 6). Failures are `box`- or `hub`-owned.
- **Secrets.** References are `scheme:body`; v1 resolvers are `env:NAME` (from an
  injected environment, default `process.env`) and `file:/abs/path` (absolute
  only, one trailing newline dropped). Values are cached for 30 s
  (`SECRET_CACHE_TTL_MS`); concurrent lookups of one reference share one read;
  failures are not cached; `preflight` bypasses the cache. A resolved secret is a
  `SecretValue` whose string, JSON and inspect forms show only its fingerprint,
  `sha256:` plus 12 hex characters. A reference that does not parse, names an
  unknown scheme, or has a body its scheme rejects (`env:` not followed by a
  name matching `^[A-Za-z_][A-Za-z0-9_]*$`, `file:` not followed by an absolute
  path free of control characters) may be a pasted raw secret, so errors and
  `preflight` show only its fingerprint. A value that is empty after trimming is
  `secret.empty`. `invalidate` also detaches reads in flight, so a lookup after
  it never returns a value read before it.
- **`ModelGateway`** issues one credential per session (idempotent), replaces its
  model allowlist (an empty list allows no model), revokes it, and reports usage
  from the gateway's own log.

### Consequences

- Implementations (#4 SQLite store and audit sink, #6 Docker provider, #7
  connection) code against these signatures. Changing one needs a new entry.
- Business code can hold a `SecretValue` without risking a leak through logging;
  only `reveal()` at the point of use exposes the value.

## 0004: Box image layout and runtime

- Date: 2026-11-15
- Status: accepted
- Issue: #5

### Decision

- **The box image lives in `apps/box-agent/Dockerfile`** and builds from the repo
  root (`docker build -f apps/box-agent/Dockerfile .`), because it installs the
  workspace from the root `bun.lock`. `apps/box-agent/Dockerfile.dockerignore`
  keeps the context to manifests and sources.
- **Base: `debian:trixie-slim`** with TigerVNC (`Xvnc`), Openbox, Debian's
  `chromium`, git, python3 and `tini` as PID 1.
- **pi runs on Bun, not Node.** `@earendil-works/pi-coding-agent` 1.5.2 needs
  Node >= 22.19, newer than Debian trixie's `nodejs`. Bun 1.4.4 (copied from
  `oven/bun:1.4.4-slim`, the version the repo pins) already runs box-agent and
  runs the pi CLI too; `/usr/local/bin/pi` is a wrapper around it. No separate
  Node is installed.
- **The pi version comes from `apps/box-agent/package.json`.** The build takes it
  as the `PI_VERSION` argument, fails if the installed pi reports a different
  version, and records it in the `dev.hearth.pi.version` label (PRD §8.4).
- **Layer order:** OS packages and user, then the desktop (Xvnc, Openbox,
  Chromium), then Bun, then the dependencies (including pi) from the manifests
  and lockfile only, then the box-agent sources. A box-agent change rebuilds only
  the top layer; a pi bump rebuilds the dependency layer and above, never the
  desktop layers (PRD §6.3).
- **Desktop on loopback, no VNC password.** `Xvnc :1 -localhost -rfbport 5901
  -nolisten tcp -SecurityTypes None`. Only processes in the box can reach it, and
  box-agent relays it to the hub over its authenticated connection (PRD §8.2).
  The image has no `EXPOSE`.
- **The image runs as `hearth` (uid 1000)**, with `/workspace` as the working
  directory. The entrypoint starts Xvnc and Openbox and then `exec`s box-agent,
  or the command it was given.
- **The image does not start Chromium.** box-agent will launch it when the
  browser tools land; Chromium's CDP binds to loopback by default, which the smoke
  test checks. Running Chromium with its sandbox in a container (seccomp profile
  or user namespaces) is left to the `BoxProvider` work; the smoke test uses
  `--no-sandbox`.
- **`scripts/box-smoke.sh` is the image test**, run by the `box-image` CI job
  together with hadolint and shellcheck. It is not part of `bun run check`, which
  must pass without Docker.

## 0005: Protocol v1 follow-ups: frozen handshake, idempotent commands, box state, failure vocabulary

- Date: 2026-11-15
- Status: accepted
- Issue: #14 (follow-ups from the verification of #2's protocol, PR #12)

v1.0 has no released peer yet, so these change v1.0 in place instead of
bumping the minor.

### Decision

- **Frozen across all major versions: `hello`'s `type` and `version`
  (`{ major, minor }`, unsigned integers), and the whole `reject` frame.** The
  decoder reads a hello's version before any other field and returns a
  `version-mismatch` decode error carrying `peerVersion` when the major differs.
  So a v2 hello of any other shape gets a clear `version-mismatch` reject, not
  `malformed-hello`. `rejectHello(error)` builds the reject the hub sends.
- **Hub → box commands stay fire-and-forget and are applied idempotently.** The
  hub re-sends any command whose effect it has not seen after a reconnect. The
  box ignores a `turn.start` whose `turnId` it knows in this boot (a turn never
  runs twice), and a `session.hibernate` or `session.assign` whose `requestId`
  it knows. `session.assign` gets a required `requestId` for this (orchestrator
  decision): deduping on "this session is assigned now" would let a replayed
  assign wake a session that was hibernated after it. The hub mints a new
  `requestId` for every assignment it decides on, including a resume, and
  re-sends keep the original one. `isDuplicateCommand` in
  `packages/protocol` is the single definition. Commands were not made
  at-least-once: the hub owns the session state machine and must decide again
  after a reconnect anyway (a command may no longer apply), and a box-to-hub ack
  path for commands would duplicate what the box's at-least-once answers
  (`turn.end`, `hibernate.done`) already tell the hub.
- **The box reports its state in `hello`**: `state.sessionId`, `state.turnId`
  (the running turn) and `state.lastDeliveryId` (highest delivery id sent in
  this boot, 0 for none). It is **fire-and-forget**, as part of the handshake,
  deliberately: the state is a snapshot that is only valid when it is taken.
  At-least-once redelivery would replay a stale snapshot after newer facts, and
  every connect already sends a fresh one. Putting it in `hello` rather than a
  separate frame means the hub has it before it can send any command, with no
  ordering race. The hub re-sends only after it has applied redelivered frames
  up to `lastDeliveryId`. On a new `bootId`, a turn that was running on the old
  boot is ended visibly as failed and is never re-sent (PRD §8.1, principles 1
  and 7).
- **`packages/protocol` owns the failure vocabulary** (orchestrator decision).
  `Failure.retryable: boolean` is replaced by
  `disposition: FailureDisposition`, one of `retry` (the same work may succeed
  on the same box), `retry-cold` (retry only on a fresh box via a cold boot)
  and `give-up`. `FailureDisposition` is exported next to `FailureOwner`, whose
  values are unchanged (`box`, `model-provider`, `gateway`, `hub`, `user`).
  `packages/core` imports both from `@hearth/protocol` and re-exports them
  from `failure.ts` instead of redefining them.
- **Variant fields are rejected consistently.** A field that belongs to another
  variant of the same frame is an `invalid-field` error (`path` or `mode` on a
  `vnc` stream, versions on a non-version-mismatch reject); a field no variant
  knows is dropped.
- **`encodeFrame` validates text frames with the decoder** and throws
  `EncodeError` (a `RangeError`) instead of writing a frame the peer would
  reject, including values JSON would silently change (`NaN`, typed arrays in
  a payload). A seeded property test checks that whatever encodes decodes back
  to an equal frame.
- **Smaller limits.** Opaque JSON nests at most `MAX_JSON_DEPTH` (64) arrays and
  objects, counting the outermost one (65 was accepted before). File-stream
  paths reject C1 controls and Unicode bidi controls. `unknown-type` errors echo
  at most 64 characters of the received type.

### Consequences

- A future major may change anything except the frozen fields; changing those
  would make version errors unreadable for older peers and needs a new
  decision entry.
- The box-agent (#7) keeps, per boot, the set of turn ids and of assign and
  hibernate request ids it has seen. They are small per session; bounding them is the
  box-agent's call.
- Code outside `packages/protocol` that classifies failures uses
  `FailureDisposition`; a boolean `retryable` must not come back.

## 0006: Hub SQLite store, event log and audit log

- Date: 2026-11-15
- Status: accepted
- Issue: #4

### Decision

- **Hub persistence lives in `apps/hub/src/store`**, not in a new workspace: the
  hub owns all state (AGENTS.md, layout) and is the only user of SQLite. The
  store is the only code that imports `bun:sqlite`; the rest of the hub uses the
  `EventStore` and `AuditSink` interfaces from `@hearth/core`.
- **Connection settings** (`openDatabase`): `journal_mode = WAL`,
  `synchronous = FULL`, `foreign_keys = ON`, `recursive_triggers = ON` and
  `busy_timeout = BUSY_TIMEOUT_MS` (5 s). `FULL` rather than WAL's usual
  `NORMAL`, because "ack on apply" and "audit before act" both need a commit to
  be on disk when it returns. `recursive_triggers` makes SQLite fire DELETE
  triggers for the rows a `REPLACE` removes (see append-only below).
- **Migrations** are a numbered, forward-only list in `migrations.ts`, recorded
  in `schema_migration`. Each runs in its own `BEGIN IMMEDIATE` transaction
  together with its record, so it applies fully or not at all, and two hubs
  starting at once never apply one twice (a test races four processes on a
  fresh file). The runner runs at every open and is
  re-runnable. A database at a newer version than the code knows is refused
  (`store.schema-too-new`). Shipped migrations are never edited.
- **M0 schema** (migration 1): `workspace` (seeded with `ws_default`),
  `session`, `box`, `event`, `audit`, with the columns of PRD §9. Every table
  except `workspace` (whose `id` is the workspace) has `workspace_id`. `event`
  has no foreign key to `session`, so the event log does not depend on the
  session manager's write order.
- **The `event` primary key is `(workspace_id, session_id, seq)`**, a widening
  of PRD §9's `(session_id, seq)`, so a session id can never collide across
  workspaces (E1). Box deliveries are unique on
  `(workspace_id, boot_id, delivery_id)` through a partial unique index.
- **`seq` assignment**: `max(seq) + 1` for the session inside a
  `BEGIN IMMEDIATE` transaction, which takes the write lock before the read, so
  concurrent appends from any connection or process stay gap-free.
- **Idempotent apply**: a delivery already stored for the same session returns
  its original `seq` with `duplicate: true`. The same delivery key on a
  different session is a box bug, not a redelivery: the append rejects with a
  `box`-owned `event.delivery-conflict`, so the hub never acks an event it did
  not store.
- **Append-only in the database** (PRD §10), on `audit` and `event`, with every
  guard aborting with `<table> is append-only`:
  - `BEFORE UPDATE` and `BEFORE DELETE` triggers (migration 1). These also catch
    an upsert's `DO UPDATE`.
  - `REPLACE` / `INSERT OR REPLACE` resolve a key conflict by deleting the old
    row, and SQLite skips DELETE triggers for that unless `recursive_triggers`
    is on. Defence in depth, each half enough alone: `openDatabase` turns the
    pragma on, and migration 2 adds `BEFORE INSERT` triggers that abort when
    the new row's key is already taken (`event`: the primary key or the
    delivery key; `audit`: an explicit `id`), so a connection opened without
    the pragma cannot overwrite a row either. Migration 2 is a new migration
    rather than an edit of 1, by the migration rule above.
- **`audit` stores the record flat**: principal, action, the resource's
  workspace, type and id, the decision (`allowed`, `policy`, `reason`, all null
  for an admin action audited directly) and `detail_json`. `SqliteAuditSink`
  plugs into `withAudit` and `AllowAllAuthorizer` from core unchanged.
- **Reads** return at most `MAX_READ_LIMIT` (1000) events per page, whatever the
  caller asks for; `hasMore` comes from fetching one extra row in the same
  statement. A negative or fractional cursor, or a limit below 1, rejects with
  `event.invalid`.
- **Payloads must be JSON**: a payload `JSON.stringify` cannot serialize
  (BigInt, a cycle, a throwing `toJSON`) or would silently drop (a function or
  symbol anywhere in it) rejects with `event.invalid`, never a raw `TypeError`.
  Its JSON may be at most `MAX_EVENT_PAYLOAD_BYTES` (4 MiB, UTF-8 bytes); a
  bigger one rejects with `event.invalid`. Events are replayed to every
  reconnecting client, so bulk data does not belong in them.

### Consequences

- Schema changes are new migrations; editing migration 1 after it ships would
  leave existing databases behind.
- Removing event or audit rows (for example a retention policy) needs a
  migration that drops the triggers, and a new decision entry.
- Producers that need to attach more than 4 MiB (files, screenshots) need a
  separate store for the bytes and a reference in the event.

## 0007: Docker BoxProvider and the box's sandbox

- Date: 2026-11-15
- Status: accepted
- Issue: #6

### Decision

- **Engine API over the unix socket, no CLI and no SDK.** `apps/hub/src/box/docker`
  holds a small client (`fetch` with Bun's `unix` option) for the endpoints the
  provider needs, speaking API version 1.44 (Docker Engine 25 and later). The
  socket path, default limits and deadlines come from config
  (`dockerBoxConfigFromEnv`: `HEARTH_DOCKER_SOCKET`, `HEARTH_BOX_CPUS`,
  `HEARTH_BOX_MEMORY_BYTES`, `HEARTH_BOX_PIDS`, `HEARTH_BOX_DISK_BYTES`,
  `HEARTH_BOX_PULL`, `HEARTH_BOX_INSTANCE`). Each call has a named deadline;
  `stop` waits the box's grace plus one ordinary call.
- **Objects per box**, all named `<instance>-box-<boxId>` (the instance defaults
  to `hearth`) and labeled `dev.hearth.managed`, `dev.hearth.instance`,
  `dev.hearth.box.id`, `dev.hearth.workspace.id`, `dev.hearth.session.id` and
  `dev.hearth.image`; the container also carries the image's
  `dev.hearth.pi.version`, and the volumes `dev.hearth.created-at` and
  `dev.hearth.volume.role`. The `dev.hearth.` prefix is the provider's: user
  labels (`BoxSpec.labels`) under it are dropped before any object is labeled, so
  they can neither override these nor add their own. Dropped rather than rejected,
  because `BoxInfo.labels` carries the provider's labels and a caller that passes
  them back in a spec must not fail.
  - A bridge network of its own: egress allowed (not `Internal`), inter-container
    traffic off, no published or exposed ports. Boxes on different networks cannot
    reach each other; the CI integration test checks this.
  - **Two named volumes**: `<name>` for `/workspace` and `<name>-home` for
    `/home/hearth`. Two volumes rather than one with sub-paths, because Docker
    copies the image's directory (with its `hearth` ownership) into an empty named
    volume only when the volume itself is the mount; a sub-path mount would start
    out owned by root. `BoxInfo.volumeRef` is the workspace volume; `destroy`
    removes both.
  - The container, built fresh by every `start`, with `NanoCpus`, `Memory` (swap
    equal to memory, so no swap), `PidsLimit` and a 256 MB `/dev/shm` for Chromium.
    `diskBytes` maps to `StorageOpt.size`, which only some storage drivers support
    (overlay2 on xfs with `pquota`), so it is unset by default. The local volume
    driver does not limit volume size; a host that needs that uses filesystem
    quotas.
- **Idempotency.** Calls for one box id are serialized in the provider. `create`
  of an existing box returns it unchanged; `start` of a running box leaves it
  alone; an exited or half-created container is removed and replaced; `stop`
  answers `already-stopped` or `not-found`; `destroy` of a missing box answers
  `not-found`. An object with a box's name that lacks this instance's and this
  box's labels is never adopted, started, stopped, mounted, attached to or removed
  (`box.name-conflict`). That includes a network that appears between the
  provider's inspect and its create: a `409` from `networks/create` is inspected
  again and checked before the network is used.
- **Failure owners.** A missing or refusing socket and daemon timeouts are
  `hub`/`retry`; permission denied on the socket is `hub`/`give-up`; unexpected
  daemon answers about its own objects are `hub`. A missing image (or a failed
  pull) is `box`/`give-up`; the runtime refusing to create or start the container
  is `box`/`retry-cold`, and the failed container is removed first. A missing
  image is pulled once unless `HEARTH_BOX_PULL=never`. `containers/create`
  answers `404` for a missing image and a missing network alike, so the provider
  inspects both: the image is `box`/`give-up` (`box.image-missing`); the box's own
  network, gone since `create` built it, is `box`/`retry-cold`
  (`box.network-missing`), because the hub is fine and a cold `start` builds the
  network again; neither is `box`/`retry-cold` (`box.create-failed`).
- **`adopt`** lists containers and volumes with `dev.hearth.managed=true` and this
  instance's label, so a hub restart finds hibernated boxes too, and two hubs (or
  a test run) on one daemon never adopt each other's boxes.
- **Chromium runs with `--no-sandbox`; the container is the sandbox.** The
  provider sets `HEARTH_CHROMIUM_SANDBOX=off` in the box's environment, for
  box-agent to read when it launches Chromium. Every box runs with all
  capabilities dropped, `no-new-privileges`, Docker's default seccomp and
  AppArmor profiles, as `1000:1000` (set on the container, so it does not depend
  on the image's `USER`), with no published ports. Reasoning:
  - Chromium's sandbox needs either a setuid helper (blocked by
    `no-new-privileges`, and not shipped by Debian) or unprivileged user
    namespaces, which Docker's default seccomp profile denies. Enabling it means a
    custom seccomp profile that allows `clone`/`unshare` with namespace flags and,
    on hosts that restrict unprivileged user namespaces through AppArmor (Ubuntu
    23.10 and later), an unconfined or custom AppArmor profile too.
  - That trade points the wrong way for Hearth. The boundaries that matter most
    are box to host and box to box. User namespaces are a recurring source of
    kernel privilege escalations, and allowing them would expose that kernel
    surface to every process in every box, including the commands the agent runs,
    which are as untrusted as a web page.
  - Inside one box, Chromium's sandbox would only separate a compromised renderer
    from the rest of that box. The agent already runs arbitrary commands there,
    and the box holds no long-lived secrets (PRD §10): only the session's
    short-lived, revocable credentials and the session's own files.
  - When a stronger runtime arrives (gVisor or a VM provider, PRD §7 E4), user
    namespaces inside the box become cheap, and a new decision can revisit this.
- **Tests.** Unit tests run the provider against an in-memory fake Engine API on
  a unix socket in a temporary directory (`fake-engine.ts`). The
  `HEARTH_DOCKER_TESTS=1` suite runs in the `box-provider` CI job against the box
  image built there, with `CMD ["sleep", "infinity"]` layered on so the box stays
  up until box-agent connects to a hub (#7).

### Consequences

- The hub's session manager wires the provider in; this change does not start it.
- Process snapshots stay `not-supported` until a provider implements them (P2).
- Supervising the desktop processes inside the box is #15.

## 0008: Hub-box connection: join tokens, ack on apply, box-agent outbox

- Date: 2026-11-15
- Status: accepted
- Issue: #7

### Decision

- **One WebSocket endpoint, `/v1/box/socket`.** The upgrade itself carries no
  credential; the first frame must be `hello`, within `HELLO_DEADLINE_MS`
  (10 s). The hub checks the version first (`rejectHello` / `checkHelloVersion`,
  so another major gets `version-mismatch` naming both versions), then
  authenticates the credential, then calls `authorize(box principal,
  "box.connect", box)` before it registers the connection or sends `welcome`.
  Authentication has to come before `authorize`, since it is what yields the
  principal. Every refused handshake gets a `reject` and close code 4001.
- **Join tokens and credentials.** `hjt_` + 256 random bits (join token) and
  `hbc_` + 256 random bits (per-box credential); the prefix tells the hub which
  one a `hello` carries. Only SHA-256 hashes are stored (migration 3:
  `box_join_token`, `box_credential`); with 256-bit random secrets a plain hash
  is enough, no salt or KDF. A token is bound to one box and one session,
  expires after `JOIN_TOKEN_TTL_MS` (5 minutes: a container start and one
  dial), and is redeemed once, atomically, in a `BEGIN IMMEDIATE` transaction
  that also replaces the box's credential, so a new boot revokes the previous
  boot's credential. The credential is sent once, in `welcome`. Rejections tell
  the box only `bad-credential`; the reason (`unknown`, `used`, `expired`,
  `wrong-box`) goes to the hub log.
- **The credential lives in box-agent memory only.** A box-agent restart is a
  new boot and needs a new join token from `BoxProvider.start` (the per-boot
  env). If the `welcome` carrying the credential is lost, the box's next
  `hello` repeats the spent token and is refused: box-agent exits with code 3
  and the hub's reason, and the hub decides what happens to the box (PRD §8: a
  box dropping off means the hub decides). Box-agent also stops on
  `version-mismatch`, `unknown-box` and `malformed-hello`, which retrying cannot
  fix; it retries on `internal`, a closed socket and a handshake timeout.
- **Ack on apply.** For each at-least-once frame, in arrival order per
  connection: `authorize(box principal, "event.append", session)`, check that
  the frame's session is the one the box's token was bound to and that its
  `bootId` is the connection's, `EventStore.append` with the delivery key, then
  `delivery.ack`. The stored event is the frame without `bootId`/`deliveryId`,
  with the frame type as the event type. A frame that fails any step is not
  acked; the hub logs it and closes the socket (4003), so the box redelivers
  after reconnecting and the failure stays visible instead of being dropped.
- **Box-agent outbox.** Bounded by `MAX_OUTBOX_FRAMES` (1024). A full outbox
  refuses the new frame with a `box`-owned `outbox.full` error (no id is used
  up), never a silent drop. After every `welcome` the agent resends everything
  unacked in `deliveryId` order with the original `bootId` and `deliveryId`.
- **Reconnect backoff with "equal jitter".** Attempt `n` waits half of
  `min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2^n)` plus a random share of the
  other half (250 ms base, 10 s cap); a successful handshake resets `n`. Never
  zero, so a box cannot spin on a dead hub.
- **Until pi lands (M1), box-agent answers commands explicitly**: `turn.start`
  ends the turn with `turn.end` `failed` (owner `box`, `give-up`) and
  `session.hibernate` answers `hibernate.done` `failed`, both deduplicated with
  `isDuplicateCommand`. `rpc` `echo` returns its params; any other method gets
  `unknown-method`.
- **Echo endpoint: `POST /v1/boxes/:boxId/echo`**, body = the JSON params.
  There is no login before M1, so the caller is `LOCAL_PRINCIPAL`; the hub
  listens on loopback by default. It calls `authorize(principal, "box.echo",
  box)` first and has a named deadline, `ECHO_DEADLINE_MS` (5 s). It answers
  `409 box.not-connected`, `504 rpc.deadline` or `502 rpc.error` with the
  classified failure.
- **Hub startup** opens the database (`HEARTH_DATA_DIR`, default `data`, file
  `hearth.db`), then wires `SqliteAuditSink`, `AllowAllAuthorizer`,
  `SqliteEventStore` and `SqliteBoxCredentialStore` into the connection handler.
  `launchBox` authorizes `box.start`, issues a join token and calls
  `BoxProvider.start` with `HEARTH_HUB_URL` (the box socket URL as the box sees
  it), `HEARTH_BOX_ID` and `HEARTH_JOIN_TOKEN`. Box-agent reads the token
  through the `SecretStore` (`env:HEARTH_JOIN_TOKEN`), not `process.env`.
- **How a Docker box reaches the hub.** Each box has its own bridge network
  (decision 0007), and the host is that network's gateway. The Docker e2e
  (`apps/hub/src/box/echo.docker.test.ts`, run by the CI `box-provider` job
  against `hearth-box:ci` with its real default command) has the hub listen on
  `0.0.0.0` and passes `ws://<gateway IP of the box's network>:<port>/v1/box/socket`,
  read from the network after `provider.create`. No `host-gateway` alias or
  provider change is needed. The production hub address (hub in compose,
  PRD §8) is chosen in the deploy work; the provider passes whatever URL it is given.
- **Without a boot environment, the box image's default command exits 2**,
  naming the missing `HEARTH_HUB_URL` / `HEARTH_BOX_ID`; `scripts/box-smoke.sh`
  checks that instead of a clean exit.

### Consequences

- Session state on reconnect (re-sending commands from `hello.state`, ending a
  turn of an old boot visibly) is the session manager's job; this change stores
  and acks what boxes send and answers `echo`.
- Auditing every applied frame costs one extra durable write per event. If that
  becomes the bottleneck, a later decision can authorize per connection and
  frame type instead.

## 0009: Brain/hands split: pi runs in the hub, the box executes tools

- Date: 2026-11-15
- Status: accepted
- Issue: #29
- Supersedes: parts of 0004 and 0008, listed below. Those entries stay as
  written (the log is append-only).

### Context

Owner direction (2026-11-15): settle the foundation before the M1 prototype.
Through v0.2 the PRD put the pi agent loop inside the box (box-agent on the pi
SDK) and gave each box a per-session model credential (PRD v0.2 §6.4).

### Decision

- **Brain in the hub, hands in the box.** The pi agent loop runs hub-side, in one
  runner per session: an `AgentSession` from the pi SDK (`createAgentSession`).
  The box is the session's tool executor: shell and files in `/workspace`, the
  Chrome/CDP desktop, and VNC.
- **pi's file and shell tools are routed to the box over the existing protocol's
  `rpc`.** The runner loads one Hearth inline extension (through
  `DefaultResourceLoader`'s `extensionFactories`) that registers `read`, `write`,
  `edit`, `bash`, `ls`, `find` and `grep` under their built-in names, which
  replaces the built-ins (pi `docs/extensions.md`, "Overriding Built-in Tools").
  Their backends are pi's documented operations interfaces (`ReadOperations`,
  `WriteOperations`, `EditOperations`, `BashOperations`, `LsOperations`,
  `FindOperations`; "Remote Execution"), implemented as hub → box `rpc` calls.
  `grep` overrides `execute()` instead, since `GrepOperations` only covers the
  directory check. This is the pattern of pi's Gondolin example and of
  "route selected tools into an isolated environment" in pi
  `docs/containerization.md`, with the hub↔box connection in place of a VM.
- **No new frame types.** Tool calls are `rpc` methods; their names and params
  are added to `packages/protocol` (a minor version bump) when the tool RPC is
  built. Each carries pi's tool call id and runs at most once per box boot. A
  mutating call (write, edit, bash) whose box restarted or whose connection
  dropped is never re-sent; the model gets a tool error saying the outcome is
  unknown.
- **The box holds no model credentials at all.** The model credential (an API
  key from the SecretStore for the prototype, later the per-session Bifrost
  virtual key) stays hub-side and is passed to pi in memory. This supersedes PRD
  v0.2 §6.4's "the hub injects the virtual key into the box".
- **The box starts lazily**, when a tool call (or the desktop view) first needs
  it.
- **Hibernate means "stop the box".** The runner's state is the event log: the
  runner writes pi's finalized session entries as events and rebuilds its
  session from them with `SessionManager.inMemory(cwd, options, entries)`.
- **Only Hearth's own extension loads in the runner.** pi warns that with
  tool-only isolation, extension tools that do not delegate run on the host, so
  third-party extensions are not loaded, and the runner never forwards its
  environment to commands in the box.

Superseded parts of earlier entries:

- **0004**, "pi runs on Bun, not Node": still true, but the place moves. pi on Bun
  is now a hub concern; the M1 prototype starts with a spike proving the SDK path
  the runner uses. The box image no longer needs pi; it keeps it until the image
  is slimmed (#15), and from then the `dev.hearth.pi.version` label and the
  `PI_VERSION` build check go with it. "Upgrading pi does not invalidate
  snapshots" holds trivially once pi is out of the image.
- **0008**, "Until pi lands (M1), box-agent answers commands explicitly": pi does
  not land in the box. box-agent keeps answering `turn.start` as failed, and the
  hub does not send it; turns, turn events and usage are written by the runner
  in the hub. `turn.start`, `turn.event`, `turn.end` and `usage.report` stay in
  protocol v1 unchanged, unused by the split; removing them would be a major
  bump and needs its own entry. Whether `session.hibernate` / `hibernate.done`
  stay as a "quiesce before stop" exchange is the session manager's call.

Prior art: Anthropic's self-hosted Managed Agents
(<https://platform.claude.com/docs/en/managed-agents/self-hosted>), where the
brain and the hands are split, credentials stay out of the sandbox, and a
sandbox starts only when a tool needs it; and pi's containerization guide.

### Consequences

- A box crash no longer loses the turn: the runner survives, the call in flight
  ends visibly, and the next tool call goes to a fresh box on the same volume.
  This replaces PRD v0.2 §6.3's "re-ask the turn from the start". A hub restart
  still interrupts the turn in flight, which is surfaced (PRD §8.1, principle 7).
- Costs: one extra hub↔box round trip per tool call, and the hub now runs pi, so
  pi-on-Bun compatibility and pi's memory use are hub concerns. All runners share
  the hub process for now (PRD §12, question 10).
- pi's local discovery (context files such as `AGENTS.md`, skills) sees the hub's
  file system, not the box's workspace; the runner needs a custom
  `ResourceLoader` or does without them in the prototype (PRD §12, question 9).
- Live shell output while a command runs needs a box → hub channel and is a
  protocol minor bump after the prototype; until then a command answers once.
- Approvals gate tool calls hub-side, through pi's `tool_call` event, before they
  are dispatched; a denied call never reaches the box.
- `apps/hub` depends on the pi packages, and the pin check covers it like any
  workspace. `apps/box-agent` drops them when nothing in it uses pi.
- The M1 prototype (PRD §11.1) builds on this: box listener and compose install
  (#27, with #20), session manager and box supervision (#28), the pi-on-Bun
  spike, the hub-side runner with tool RPC, a minimal web UI, a model API key
  through the SecretStore, and a minimal local login with Host, Origin and
  Content-Type checks on the API (#33), since a web page can now make pi run
  commands.

## 0011: Tool execution RPC (protocol 1.1) and the box-agent executor

- Date: 2026-11-15
- Status: accepted
- Issue: #41 (and its comment from the #38 verification)

### Decision

- **Protocol 1.1 adds tool methods, no frame types.** Twelve `rpc` methods in
  `packages/protocol/src/tools.ts`: `tool.readFile`, `tool.access`,
  `tool.imageMimeType`, `tool.writeFile`, `tool.mkdir`, `tool.exists`,
  `tool.stat`, `tool.readdir`, `tool.glob`, `tool.grep`, `tool.exec` and
  `tool.cancel`. They map one to one onto pi's `ReadOperations`,
  `WriteOperations`, `EditOperations`, `BashOperations`, `LsOperations`,
  `FindOperations` and `GrepOperations.isDirectory` (pi 1.5.2), so the runner
  (#43) passes them to `create*ToolDefinition` unchanged. `tool.grep` is the
  whole search, run as `rg` in the box (pi's grep always runs a local `rg`).
  A minor bump: a 1.0 peer answers the methods as unknown.
- **The idempotency key is the `rpc` id, not pi's tool call id.** One pi tool
  call makes several operations (edit: access, read, write), so each call
  carries pi's id as `callId` for logs and audit, and the box runs each `rpc`
  id at most once per boot. The hub mints ids as `tool_<uuid>`, so a hub
  restart never reuses one. The box keeps finished answers (8 MiB) to answer a
  re-send, and remembers evicted ids so a re-send gets `tool.result-expired`
  instead of a second run.
- **Hub-side deadline per call** (`toolDeadlineMs`): the box's own budget for
  the call plus a 5 s grace. For `tool.exec` that is the command timeout pi
  passes in (default 10 min, max 1 h); search methods have 30 s; file methods
  30 s. No global timeout (PRD §8.1, principles 3, 4 and 8). A command whose
  deadline passes is cancelled.
- **Reconnects.** A dropped connection does not fail a call. On the **same
  boot** the hub re-sends the call with the same id and gets the box's one
  answer. On a **new boot** the call fails with `tool.outcome-unknown` and is
  never re-sent; a mutating call (`writeFile`, `mkdir`, `exec`) is `give-up`,
  a read-only one is `retry`, since running it again changes nothing.
- **Exec answers once; output is capped and spilled into the box.** The tail
  (256 KiB) comes back in the result, behind a `[hearth: N bytes of earlier
  output omitted; full output in the box at …]` marker, and the whole output
  (up to 16 MiB) is written to `/workspace/.hearth/exec/<call>.log`, a box path
  the model can `read`. This answers the spike's (#40) finding that pi points
  at a hub temp file when it truncates. A chunked live stream was not chosen:
  pi accepts one `onData` call, and live output needs a box → hub channel
  (decision 0009, a later minor bump).
- **No hub environment crosses.** `tool.exec` has no `env` field and the decoder
  drops one. Commands get a box-defined environment (`PATH`, `HOME`, `LANG`,
  `TERM`, `PWD`, and `DISPLAY` in the image), never box-agent's own, which holds
  the join token.
- **Paths are confined to `/workspace`.** This narrows PRD §8.2.1, which let an
  absolute path name anything in the box; the issue asked for confinement, and
  `bash` remains the way to reach the rest of the box. Relative paths resolve
  against `/workspace`; an absolute path must be inside it; any `..` segment is
  refused; the existing part of the path is resolved with `realpath` and must
  stay inside, and a dangling symlink is refused. glob does not follow
  symlinks and refuses `..` patterns. `~` is not expanded by the box: pi
  expands it to the hub's home, so the runner rewrites it in `tool_call`
  (as the spike does), and a hub-home path that slips through is refused as
  outside the workspace.
- **Limits:** file reads and writes 1 MiB (larger files get `tool.too-large`;
  the `file` byte stream is the later path for them), output 256 KiB, 10,000
  list entries, 16 concurrent calls per box (`tool.busy`, retryable).
- **Process groups.** Each command leads its own process group; a timeout or a
  cancel sends `SIGKILL` to the group. After the shell exits the call ends
  within 200 ms even if a background child holds the pipe; such a child is left
  running (a server the agent started), it is only killed on timeout or cancel.
- **Errors are classified by code** (`TOOL_ERRORS`): the model's bad request
  (`path-escape`, `not-found`, `too-large`, …) is owner `user`, `give-up`;
  `busy` is `box`, `retry`; an unexpected executor fault is `box`,
  `retry-cold`. The hub client raises them as `HearthError`s, and its pi-shaped
  `bash.exec` throws exactly `aborted` and `timeout:<seconds>`, the strings pi
  turns into "Command aborted" and "Command timed out".

### Consequences

- The runner (#43) adapts `ToolRpcClient.operations(boxId, toolCallId)` per
  call, rewrites `~`, and replaces pi's truncation hint with the box path, or
  relies on the marker the box already puts in the output.
- Files over 1 MiB cannot be read through `read` until the `file` stream path
  lands; the model gets a clear error and can use `bash` (`head`, `sed`).
- `/workspace/.hearth/` holds spill files; cleaning them up is the session
  manager's call (they are small and per command).
- The path check is check-then-use; code already running in the box could race
  it. It guards against hostile paths from the model, not against `bash`.
