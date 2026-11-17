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

## 0010: The hub API refuses foreign Host, cross-site Origin and non-JSON bodies

- Date: 2026-11-15
- Status: accepted
- Issue: #33

### Decision

Binding to loopback (PRD §10) does not keep browsers out. Any page the owner
opens can send a "simple" cross-origin POST (`text/plain`) to
`http://127.0.0.1:8787` (CSRF), and a DNS-rebinding page can also read the
answers. So a middleware in `createApp` (`apps/hub/src/app.ts`) checks every
request except `GET /healthz`, in this order, before any handler or
`authorize` runs:

- **Host.** The host name of `Host` (port ignored, case-insensitive) must be
  `localhost`, `127.0.0.1`, `[::1]`, the address the hub binds (`HEARTH_HOST`)
  or the host of `HEARTH_PUBLIC_ORIGIN`. Anything else, or a malformed `Host`,
  gets `421 request.foreign-host`. This is what stops DNS rebinding: the
  rebound page's requests carry the attacker's host name.
  `X-Forwarded-*` and `Forwarded` headers are not trusted: only `Host`
  counts. A DNS-rebinding page is same-origin to the browser, so it can set
  them freely.
- **Origin.** If `Origin` is present it must equal the request's own origin
  (scheme + `Host` as the hub sees them) or `HEARTH_PUBLIC_ORIGIN` exactly;
  `null`, another port on localhost and every other site get
  `403 request.cross-origin`. Without `Origin`, `Sec-Fetch-Site: cross-site`
  or `same-site` gets the same 403; `same-origin`, `none` (typed URL) and no
  header (curl, scripts) pass.
- **Content type.** `POST`, `PUT` and `PATCH` must send
  `Content-Type: application/json` (parameters such as `charset` allowed),
  otherwise `415 request.unsupported-media-type`. JSON is not a CORS-simple
  type, so a cross-site page cannot send such a request without a preflight,
  and the hub answers no preflight with CORS headers. A future route that
  takes another body type (an upload) needs a new decision to be exempted.

`HEARTH_PUBLIC_ORIGIN` is the public origin of a reverse proxy in front of the
hub, e.g. `https://hearth.example`. `parsePublicOrigin` normalizes it the way
browsers send `Origin` and rejects paths, queries, fragments, credentials and
non-http(s) schemes, so a typo fails at startup. It works whether the proxy
keeps the public `Host` or rewrites it to the loopback address. Unset means
loopback only.

Out of scope: `/healthz` takes no input and returns no workspace data
(decision 0001), and the box socket (`/v1/box/socket`) is routed in
`server.ts` before the app and authenticates in its `hello` (decision 0008);
its listener is #27.

### Consequences

- Non-browser clients on the host (curl, scripts) keep working as long as they
  send `Content-Type: application/json`.
- The hub sends no CORS headers. A UI served from an origin other than the
  hub's own or `HEARTH_PUBLIC_ORIGIN` cannot call the API; allowing one needs
  a new decision.
- This is not authentication. Login still has to come before the API is
  exposed beyond the owner's machine.

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
  `TERM`, `PWD`, and `DISPLAY` in the image, plus the per-run `HEARTH_EXEC`
  marker below), never box-agent's own, which holds the join token.
- **Paths are confined to `/workspace`.** This narrows PRD §8.2.1, which let an
  absolute path name anything in the box; the issue asked for confinement, and
  `bash` remains the way to reach the rest of the box. Relative paths resolve
  against `/workspace`; an absolute path must be inside it; any `..` segment is
  refused; the existing part of the path is resolved with `realpath` and must
  stay inside, and a dangling symlink is refused. glob does not follow
  symlinks while it walks, refuses `..` patterns and patterns whose literal
  leading segments (`etclink/` in `etclink/pass*`) resolve outside, and drops
  every match whose `realpath` is outside. **`~` means `/workspace`.** The box
  does not expand it: pi expands it to the hub's home, so the runner (#43)
  rewrites `~` to `/workspace` in `tool_call`, and a hub-home path that slips
  through is refused as outside the workspace. `/workspace` rather than the box
  user's home (`/home/hearth`, the spike's choice), because every tool path
  must be inside `/workspace`, so a rewrite to the home would always be refused.
- **Regular files only, each file method on a budget.** `readFile`,
  `imageMimeType` and `writeFile` open without blocking and refuse a FIFO,
  socket or device with `tool.not-regular-file` (owner `user`, `give-up`), so a
  FIFO cannot hang a call. Every file method also has its own box-side budget,
  `FILE_TIMEOUT_MS` (25 s, the hub's 30 s deadline less the grace), and ends on
  `tool.cancel`: the call is answered with `tool.deadline` and its slot is freed
  even if the I/O itself stays stuck in the kernel.
- **The spill file never follows a symlink.** `/workspace/.hearth` and its
  `exec/` are created if missing and must be plain directories by `lstat`, and
  the file is opened with `O_NOFOLLOW`. If a segment is a symlink the output is
  not spilled (`fullOutputPath: null`); the tail still comes back.
- **Limits:** file reads and writes 1 MiB (larger files get `tool.too-large`;
  the `file` byte stream is the later path for them), output 256 KiB, 10,000
  list entries, 16 concurrent calls per box (`tool.busy`, retryable).
- **Process groups and the run marker.** Each command leads its own process
  group, and its environment carries `HEARTH_EXEC=<random uuid>`, which every
  child inherits. A timeout or a cancel sends `SIGKILL` to the group, then
  kills every process whose `/proc/<pid>/environ` carries the marker, in a few
  rounds to catch forks; that catches a child that left the group (`setsid`, a
  daemonizing double fork, `nohup` in a new session). The threat is a runaway
  process in the box, not an escape from it: a process that deliberately
  re-executes with an environment without the marker can survive the call, and
  lives until the box stops (the box is the sandbox). A subreaper or a per-call
  cgroup was not chosen: the image runs box-agent unprivileged under tini, with
  no writable cgroup, and a subreaper would also have to reap and attribute
  orphans of concurrent calls. After the shell exits the call ends within
  200 ms even if a background child holds the pipe; such a child is left
  running (a server the agent started), it is only killed on timeout or cancel.
- **Errors are classified by code** (`TOOL_ERRORS`): the model's bad request
  (`path-escape`, `not-found`, `too-large`, …) is owner `user`, `give-up`;
  `busy` is `box`, `retry`; an unexpected executor fault is `box`,
  `retry-cold`. The hub client raises them as `HearthError`s, and its pi-shaped
  `bash.exec` throws exactly `aborted` and `timeout:<seconds>`, the strings pi
  turns into "Command aborted" and "Command timed out".

### Consequences

- The runner (#43) adapts `ToolRpcClient.operations(boxId, toolCallId)` per
  call, rewrites `~` to `/workspace`, and replaces pi's truncation hint with
  the box path, or relies on the marker the box already puts in the output.
- Files over 1 MiB cannot be read through `read` until the `file` stream path
  lands; the model gets a clear error and can use `bash` (`head`, `sed`).
- `/workspace/.hearth/` holds spill files; cleaning them up is the session
  manager's call (they are small and per command).
- Commands run as box-agent's uid, so they can read its initial environment
  in `/proc/<box-agent pid>/environ` (the spent one-time join token, the hub
  URL, the box id). That is a follow-up (a separate uid, or a re-exec without
  those variables), not part of this decision.
- The path check is check-then-use; code already running in the box could race
  it. It guards against hostile paths from the model, not against `bash`.

## 0012: Box listeners on box-network gateways, and a host firewall for box egress

- Date: 2026-11-15
- Status: accepted
- Issues: #27, #20

### Decision

- **Two kinds of listener.** The public listener serves the UI/API only and
  binds `HEARTH_HOST` (default `127.0.0.1`, PRD §10); the Host/Origin/JSON
  guard of 0010 applies to it and nowhere else. It no longer upgrades
  `/v1/box/socket`: that path is a 404 there. **Box listeners** serve only the
  box socket (every other path is 404) and each binds **one box network's
  gateway address** on `HEARTH_BOX_PORT` (default 8788). The gateway is the
  host's own address on the box's bridge, so a box listener is reachable from
  that box network and from the host, and from nowhere else. `listenForBoxes`
  refuses `0.0.0.0`, `::` and the empty host, so the hub never binds every
  interface for boxes. This supersedes the "hub on `0.0.0.0`" part of 0008.
- **`DockerBoxProvider` is wired into startup.** `main.ts` builds it from
  `HEARTH_BOX_PROVIDER` (`docker`, the default, or `none`) and
  `dockerBoxConfigFromEnv`. `hub.startBox(principal, spec)` authorizes
  `box.start`, runs `provider.create` (network and volumes), asks the provider
  for the box's hub address (`hubAddress`: the IPv4 gateway of the box's
  network), opens or reuses the box listener there, and boots the box with a
  join token and that listener's URL. After a restart,
  `listenForRunningBoxes` reopens the listeners of the boxes still running.
  A box whose listener fails is logged and reported, and the others still get
  theirs; while the provider cannot list boxes (Docker daemon down) it retries
  with backoff (1 s doubling to 30 s) until it can or the hub stops.
  Listeners stay open until the hub stops: one idle socket per box is cheap,
  and reuse keeps a restarting box's address stable.
- **Box networks are recognisable and IPv4 only.** Each box network's Linux
  bridge is named `hbx` + 12 hex digits of the SHA-256 of the network name
  (`com.docker.network.bridge.name`; 15 characters, the kernel's limit), the
  network has `EnableIPv6: false`, and every box runs with
  `net.ipv6.conf.{all,default}.disable_ipv6=1`. With no IPv6 in the box, ULA
  and link-local IPv6 addresses are out of reach without IPv6 rules.
- **Egress is restricted by a host firewall, `scripts/box-firewall.sh`.** The
  owner runs `sudo scripts/box-firewall.sh apply` once per boot, after Docker
  starts (the systemd unit in `docs/demo.md`, `After=docker.service`). It is
  idempotent and matches the interface wildcard `hbx+`, so boxes created later
  are covered without per-box changes:
  - `INPUT` (anything addressed to the host itself, whichever of its
    addresses): from `hbx+`, only TCP `HEARTH_BOX_PORT` to the address of the
    box's own bridge (`addrtype --dst-type LOCAL --limit-iface-in`), plus
    replies; the rest is rejected. A box reaches its own box listener, but not
    the host's other services, not the public API and not another box's
    listener.
  - `DOCKER-USER` (forwarded traffic, evaluated before Docker's own rules).
    The script makes sure `FORWARD` jumps to `DOCKER-USER`: Docker in iptables
    mode adds that jump itself, but with its nftables firewall backend or
    `"iptables": false` nothing would, and the chain would never be reached.
    `FORWARD` in the iptables `filter` table is a base chain of its own, so
    its rejects apply whatever Docker's own tables accept. From `hbx+`:
    from `hbx+`, everything to `0/8`, `10/8`, `100.64/10`, `127/8`,
    `169.254/16` (the cloud metadata IP), `172.16/12`, `192.0.0/24`, the
    documentation and benchmarking nets, `192.168/16`, multicast and `240/4`
    is rejected (TCP reset, otherwise ICMP admin-prohibited, so tools fail
    fast). `HEARTH_BOX_EGRESS_ALLOW` lets listed IPv4 CIDRs through, for
    example a LAN DNS resolver that Docker's embedded DNS forwards to.
  - IPv6 from `hbx+` is dropped in `INPUT` and `FORWARD` when `ip6tables`
    exists.
- **Apply is validated first and atomic.** Before any rule changes, the script
  checks the port and every `HEARTH_BOX_EGRESS_ALLOW` entry (dotted-quad IPv4,
  prefix 1-32; a `/0` such as `0.0.0.0/0` and any IPv6 entry such as `::/0` are
  refused) and exits 2 on the first bad one. It then writes the whole IPv4 rule
  set, chains and jumps, as one `iptables-restore --noflush` transaction:
  declaring `HEARTH-BOX-IN` and `HEARTH-BOX-FWD` empties and refills them in the
  same commit, and `DOCKER-USER` is declared only when it does not exist, so
  its other rules are kept. A failed apply therefore leaves the previous rules
  exactly as they were, never a half-built chain. It reads back the `INPUT`,
  `DOCKER-USER` and `FORWARD` jumps and fails rather than print "applied" when
  one is missing.
- **The hub refuses to start boxes without the firewall.** The script writes a
  marker, `/run/hearth/box-egress.applied` (`HEARTH_BOX_EGRESS_MARKER`), after
  every rule is in place; it removes the marker before it changes rules and on
  `remove`. `/run` is tmpfs, so the marker disappears on reboot together with
  the rules. The hub checks the marker on every `startBox`: without it
  `startBox` fails with `box.egress-unfiltered` (owner `box`, `give-up`; the
  message says to run the script), before `create`.
  `HEARTH_BOX_EGRESS=unrestricted` is the owner's explicit opt-out (boxes then
  have the egress of 0007). A hub with a provider logs `WARNING: box egress unfiltered|unrestricted`
  at startup, and `/healthz` reports `boxEgress: "filtered" | "unrestricted" |
  "unfiltered"` for the UI. The hub only reads a file; it still needs no
  network privileges. The marker cannot see rules flushed by hand or by a
  firewalld reload; the systemd unit in `docs/demo.md` re-applies on a
  firewalld reload (`ReloadPropagatedFrom=firewalld.service`).
- **LAN-only DNS is detected.** After `apply` the script reads the resolvers
  Docker's embedded DNS forwards to (systemd-resolved's upstream file when the
  host uses the stub, else `/etc/resolv.conf`; `HEARTH_RESOLV_CONF` overrides)
  and, for each one the rules block and the allow list does not cover, prints
  a warning and the exact `HEARTH_BOX_EGRESS_ALLOW="..."` line to apply with.
  It is a warning, not a failure: whether such a resolver breaks box DNS
  depends on where Docker's embedded DNS sends the query from. From the box's
  network namespace the rules reject it; from the host's own namespace it never
  crosses them. The CI runner shows the second case: its resolver is
  `10.0.0.2`, the script warns, and boxes still resolve `github.com` under
  the firewall. The warning says how to check (`getent hosts` in a box).
- **Why a host firewall rather than the alternatives.**
  - *An egress proxy container on an internal network* needs no host rules,
    but only proxy-aware HTTP(S) gets out: `git` over SSH, package managers
    with their own transports and raw TCP break, and it is one more container
    to run, supervise and keep patched. An internal network also still leaves
    the bridge's gateway address on the host reachable, so host services bound
    to all interfaces stay exposed without host rules anyway.
  - *A userspace network (slirp4netns, pasta)* belongs to rootless Docker or
    Podman; the Docker Engine API has no per-container switch for it.
  - *One internal network shared by the hub and all boxes* puts boxes on one L2
    segment: ICC off would also cut the hub off, ICC on lets boxes reach each
    other (0007).
  - *Rules managed by the hub itself* would need `CAP_NET_ADMIN` in the host's
    network namespace for the long-running, network-facing process. A one-shot
    root script keeps that privilege out of the hub.
  - A personal self-hosted install already runs Docker as root and gives the
    hub the Docker socket, which is root-equivalent. A root one-shot at boot is
    no new trust, and `iptables` (nft-backed on current distributions) is on
    every Docker host.
- **Where the hub runs.** The hub must own the gateway addresses it binds, so
  it runs on the host or, under compose, with `network_mode: host` (the compose
  file of PRD §11.1 item 1 follows this). Its public listener still binds
  loopback; a reverse proxy publishes it (0010).
- **Tests.** Unit tests cover the listener split over real sockets (the public
  listener answers 404 on the box socket path and refuses the upgrade; a box
  listener answers only the socket path, whatever the Host and Origin; no box
  listener binds an unspecified address), `startBox`'s order with a stub
  provider, the egress gate (no marker: refused, nothing created, warning
  logged, `/healthz` says `unfiltered`; marker: starts, read again on each
  start; `unrestricted`: starts and is logged), `listenForRunningBoxes` on a
  fresh hub (only running boxes, per-box isolation, retry and stop) and
  `boxProviderFromEnv`. `firewall.test.ts` runs the script against real
  iptables in a throwaway network namespace (`unshare -rn`, or `unshare -n` as
  root in CI with `HEARTH_FIREWALL_TESTS=1`): idempotence, the three jumps,
  bad allow entries change nothing, a transaction the kernel refuses leaves
  the previous rules intact and no marker, existing `DOCKER-USER` rules are
  kept, the DNS allow line, and `remove`. In CI, the `box-provider` job runs `echo.docker.test.ts` with the
  hub on production defaults (API on loopback, box listener on the gateway,
  port 8788) twice. First without the firewall: the box's probes must reach a
  host service bound to all interfaces (by the host's IP and by the gateway)
  and a LAN host (a web server in a network namespace on `192.168.77.2`),
  which proves the probes detect a missing rule. Then after
  `box-firewall.sh apply`: the same probes, and `169.254.169.254`, must fail,
  while the box listener and `https://github.com` stay reachable. In both runs
  the public API is unreachable from the box. The provider suite then runs
  under the firewall.

### Consequences

- A fresh install, and every reboot, starts boxes only after
  `box-firewall.sh apply` (or the explicit `HEARTH_BOX_EGRESS=unrestricted`).
  The marker says the script completed since boot, not that the rules are
  still there; checking the live rules needs the privileges this decision
  keeps out of the hub. A startup self-check (a throwaway box probing the
  host) is a possible follow-up.
- Box networks created before this change have no `hbx` bridge name and are
  not covered; `destroy` and a fresh `create` fix them. No install depends on
  them: a loopback hub could not run boxes before this change.
- A home install whose only DNS resolver is on the LAN may need that resolver
  in `HEARTH_BOX_EGRESS_ALLOW` (the script prints the line), or a public
  resolver configured for Docker, when its Docker forwards box DNS from the
  box's network.
- Another provider (PRD §7 E4) implements `hubAddress` its own way; the hub
  only needs an address it can bind and the box can reach.

## 0013: Session manager: state machine, lazy box start, hibernate as stop, box exit supervision

- Date: 2026-11-15
- Status: accepted
- Issues: #42, #28

### Decision

- **The session manager lives in `apps/hub/src/session`** (`SessionManager`),
  with its rows in `store/sessions.ts` (the store stays the only SQLite code,
  0006). `startHub` builds it and exposes it as `hub.sessions`; it is the only
  code that starts, stops or relaunches session boxes, through `hub.startBox`
  (0012) and the provider.
- **States** are those of PRD §5, persisted in `session.state`:
  `creating → idle` (created, no box), `idle → running` (a tool call on a
  connected box), `idle | hibernated → waking → running` (lazy start or wake),
  `running → idle` (no tool call in flight), `idle → hibernated` (box stopped),
  `running | idle → waking` (box relaunch), `waking → idle` (relaunched with no
  call waiting), `waking → hibernated` (the box could not be started, or the
  hub restarted mid-wake), `running | creating → idle` (hub restart), any
  state but `archived` → `failed` / `archived`, and `failed → archived` only.
  Anything else is `session.illegal-transition`. A failed session refuses tool
  calls (`session.unavailable`) until it is archived; retrying a failed session
  is a later decision.
- **Every transition** is checked against that table, then authorized with
  `session.<verb>` named by the target state (`session.create`, `.run`,
  `.idle`, `.hibernate`, `.wake`, `.fail`, `.archive`; the authorizer audits
  it), then written to the event log as `session.state {from, to, reason}`, and
  only then written to the row. Hub-initiated transitions (idle timer,
  supervision, restart recovery) use `SYSTEM_PRINCIPAL`.
- **Lazy start: `ensureBox(sessionId, principal?)`** is the one entry point
  that starts a box. The runner (#43) calls it before each routed tool call; it
  returns a lease (`{ boxId, release() }`) once the box is connected, waiting
  under the named deadline `connectDeadlineMs` (default 120 s). Creating a
  session starts nothing. `withBox` wraps ensure/release.
- **Hibernate means `BoxProvider.stop`** (the volume stays) after `idleMs`
  (default 15 minutes, `HEARTH_IDLE_MINUTES`) with no lease held; a lease taken
  meanwhile cancels it. `session.hibernate` / `hibernate.done` frames are not
  used: the runner's state is in the hub, so there is nothing to quiesce in the
  box (this settles the question 0009 left open).
- **Running grace.** A session stays `running` for `runningGraceMs`
  (`DEFAULT_RUNNING_GRACE_MS`, 3 s) after its last lease is released; each
  release restarts it. The back-to-back tool calls of one turn so write one
  `running` and one `idle`, not an `idle → running` pair (two audit rows, two
  `session.state` events) per call. The grace counts toward `idleMs`: the
  hibernate still comes `idleMs` after the last call ended.
- **One lifecycle step at a time per session**: wakes, hibernates, relaunches,
  state changes after a lease and archive run in a per-session queue, so a
  wake waits for a hibernate in flight and runs on the next box (PRD §6.3).
- **Every boot is cold and gets a fresh join token**: a wake stops whatever
  runtime is left, then `startBox`, because `BoxProvider.start` leaves a running
  box alone and would not apply the new token.
- **In-flight orchestration is persisted** (migration 4, `session_operation`:
  kind `wake` or `hibernate`, status `running`, `done`, `failed` or
  `interrupted`), logged before it acts. At start the manager marks every
  `running` operation `interrupted` and appends `session.operation {kind,
  outcome: "interrupted"}`; a `waking` session goes to `hibernated` and a
  `running` or `creating` one to `idle`, each with reason "the hub restarted".
  Nothing is resumed silently: the next tool call wakes it again, visibly
  (PRD §8.1 principle 7).
- **No orphan box after a restart** (PRD §5: hibernated means the box is
  stopped). Before that, recovery stops the box of every session that is not
  `idle`/`running` and that was `waking`, had an operation in flight, or whose
  box row still says `running` (a hibernate whose stop never reached the
  provider). A stopped box's row becomes `stopped`, and the stop outcome
  (`stop: "stopped" | "not-found"`) goes into the `interrupted` event and the
  operation's detail; a box stopped with no operation in flight gets
  `session.operation {kind: "recover"}`. A stop that fails is not swallowed:
  `stop: "failed"` with its code and message in the event, a log line, and the
  box row stays `running`, so the next wake stops it before it starts a new one.
- **Box exit supervision (#28).** `BoxInfo` gains `exitCode` (present when the
  state is `exited`; Docker's `State.ExitCode`). Exits are found by inspecting
  the box (`BoxProvider.attach`): every `exitPollMs` (1 s) while a box boots,
  shortly after any box connection closes, and on a sweep every
  `superviseIntervalMs` (5 s) over sessions with a running box. Classification:
  - `2` → `box.config`, give-up: `box.failed`, session `failed`.
  - `3` → `box.credential-lost`, relaunch with a fresh join token, at most
    `maxCredentialRelaunches` (3) times.
  - anything else → `box.crashed`, retry-cold, at most `maxCrashRetries` (3).
  - a box that never connects within `connectDeadlineMs` →
    `box.connect-deadline`, counted with crashes.
  Each relaunch appends `box.restarted {cause, code, exitCode, attempt,
  maxAttempts}`; when the bound is used up or the cause gives up, `box.failed`
  is appended and the session goes to `failed`. Both counters reset after a
  hibernate, or when the box that exited had stayed connected for `stableMs`
  (60 s), so stuck is counted, not timed (PRD §8.1 principle 4). A box that
  exits while its session is idle is relaunched too. A start the provider
  refuses (for example `box.egress-unfiltered`) appends `box.failed {cause:
  "start"}` and returns the session to `hibernated`, since the owner can fix it.
- **API** (`session/routes.ts`, mounted by `server.ts` on the app after its
  request guard, so 0010 applies): `POST /v1/sessions` (`title`, `model`,
  `repoUrl`, all optional strings), `GET /v1/sessions`, `GET /v1/sessions/:id`,
  `POST /v1/sessions/:id/archive`. The caller is `LOCAL_PRINCIPAL` until login
  (#44); list and get authorize `session.list` / `session.read`.

### Consequences

- The runner (#43) only calls `ensureBox` and releases the lease; it never
  starts or stops a box. A tool RPC that fails because its box exited is the
  runner's to report (PRD §6.3); the relaunch is the manager's.
- A box that exits while idle costs a relaunch; making that lazy (stop and go
  `hibernated` instead) is a small change if box churn matters.
- The `box` table now tracks session boxes (`running`, `stopped`, `exited`).
- Docker events would find exits faster than polling; polling needs no long
  lived stream and works for any `BoxProvider`.

## 0014: Minimal local login: owner password, server-side sessions, session guard

- Date: 2026-11-15
- Status: accepted
- Issue: #44

### Decision

PRD §10 and §11.1 item 6 put every route except `GET /healthz` behind a local
login from the M1 prototype on. The login lives in `apps/hub/src/auth/`; its
storage is `SqliteLoginStore` in `apps/hub/src/store/` (boundary rule).

- **One owner password, set once.** While no password is stored the hub mints
  a one-time setup token (`hst_` + 256 random bits, in memory only) and logs
  `first run: set the owner password with setup token ...` at start.
  `POST /v1/auth/setup {setupToken, password}` sets the password and signs in;
  after that it answers `409 auth.already-set-up` and the token is gone. The
  store writes the password with an atomic insert-if-absent (`INSERT ... ON
  CONFLICT DO NOTHING`), so of two setups racing with the token, exactly one
  stores its password and signs in; the other gets the 409. The
  token keeps a fresh install that is already behind a public reverse proxy
  from being claimed by whoever reaches it first: only someone who can read the
  hub's output can set the password. A token in the log is a secret in the
  log, which PRD §10 otherwise avoids; it is accepted because it is useless
  once the password is set. Changing or resetting the password is a
  follow-up.
- **argon2id with named parameters.** `Bun.password` with `ARGON2ID_PARAMS`
  (19 MiB, 2 passes, parallelism 1: the OWASP Password Storage Cheat Sheet's
  first argon2id configuration), stored as the PHC string, so raising the
  parameters later still verifies old hashes. Passwords are 12 to 1024
  UTF-16 units of their NFC form; the upper bound caps the KDF input. A
  longer password is refused before the KDF runs, at setup (`400`) and at
  login (`401`).
- **Unicode NFC, and the order of the length checks.** Setup and login
  (1) refuse input over `PASSWORD_RAW_MAX_LENGTH` (4 × 1024 units) as it
  arrives, so the normalization work is bounded; (2) normalize to NFC
  (`normalizePassword`); (3) apply the 1024 cap to the NFC form, which is what
  the KDF gets. The same password can arrive composed ("é", U+00E9) or
  decomposed ("e" + U+0301) depending on the keyboard and OS; both must sign
  in, so the cap counts the NFC form (700 "é" typed in NFD are 1400 units and
  still log in). NFC can also grow a string (U+FB2C is three units in NFC);
  checking the cap after NFC keeps the KDF input at 1024 units or less. NFC,
  not NFKC: it changes no character the owner typed into a different one, so
  a password with "ﬁ" (U+FB01) or fullwidth letters is hashed as typed and
  the ASCII "fi" form does not log in.
- **Server-side sessions.** Migration 5 adds `owner_password` and
  `login_session` (`session` is the agent session of PRD §5). A session id is
  `hls_` + 256 random bits; only its SHA-256 is stored, so the database never
  holds a usable cookie and the lookup by hash leaks nothing about the id.
  Sessions last `SESSION_TTL_MS` (7 days) from login, not extended by use;
  an expired session is refused and its row deleted, and expired rows are swept
  whenever a session is issued.
- **Session fixation.** Login and setup always mint a new id. If the request
  carried a session cookie, that session is deleted, whether it was valid or
  not, so a planted or older id never becomes or stays a signed-in session.
- **Cookie.** `hearth_session=<id>; Path=/; Max-Age=<TTL>; HttpOnly;
  SameSite=Strict`, plus `Secure` when the request URL is `https:` or
  `HEARTH_PUBLIC_ORIGIN` is `https:` (a TLS proxy that talks plain HTTP to the
  hub). No `Domain`, so the cookie is host-only.
- **Logout.** `POST /v1/auth/logout` deletes the session row and clears the
  cookie (`Max-Age=0`). Replaying the old cookie value afterwards gets 401.
- **Rate limit.** `LOGIN_RATE_LIMIT`: 10 failed login or setup attempts per
  sliding 15 minutes, for the one account, not per client (behind a proxy every
  client has the proxy's address, and `X-Forwarded-For` is not trusted, 0010).
  An attempt counts from the moment it starts, so a parallel burst cannot get
  more guesses to the KDF than the limit; past the limit the hub answers
  `429 auth.rate-limited` with `Retry-After`, before the KDF runs, even for the
  right password. A success clears the count. The cost: someone who can reach
  the login can keep the owner out by guessing, and the owner then waits out
  the window. The limit is in memory, so a hub restart resets it.
- **Timing.** The password comparison is argon2's own (`Bun.password.verify`);
  every admitted attempt within the length caps runs it, whatever the input. The setup token is
  compared with `secretsEqual`: SHA-256 of both sides, then `timingSafeEqual`
  on the 32-byte digests, so neither content nor length shows in the time.
- **Session guard.** A middleware in `createApp` runs after the request guard
  of 0010 and lets through only `OPEN_ROUTES`: `GET /healthz`,
  `GET /v1/auth/status` (whether to show the setup or the login form),
  `POST /v1/auth/setup` and `POST /v1/auth/login`. Every other request,
  including paths no handler serves, gets `401 auth.required` without a live
  session, so new routes (the session API of #42) are covered without listing
  them. The guard puts the session's principal on the request; handlers pass
  it to `authorize` (the echo endpoint no longer uses `LOCAL_PRINCIPAL`
  directly). In v1 a password login always yields the local owner principal.
  The auth routes do not call `authorize`: before login there is no principal,
  and they return no workspace data; this extends the exception of 0001 to
  them. Because the 0010 guard runs first, a cross-origin page can neither
  log in, set the password, log out nor run a command, and logout needs the
  JSON content type like every other POST.
- **The box listener is unchanged.** It never reaches the app (0012); boxes
  authenticate with their join token and per-box credential (0008), not with
  the login. The public listener stays on loopback by default.
- **Passkeys** (optional in PRD §10) are not part of this; `auth/service.ts`
  carries a TODO pointing at §10.

### Consequences

- A fresh hub serves nothing but `/healthz` and the auth routes until the
  owner sets a password with the logged token. Scripts sign in first and send
  the cookie (README); in-process callers and tests use
  `hub.auth.issueSession(principal)`.
- Login attempts are not written to the audit log yet; that needs an audit
  record shape for unauthenticated events and is a follow-up.
- Only one principal exists. A multi-user edition (PRD §7 E2) adds principals
  to `owner_password` / `login_session` without changing the guard.

## 0015: Hub-side pi runner: routed tools, event log, AGENTS.md cache, codemode, extension allowlist, legacy turn commands

- Date: 2026-11-15
- Status: accepted
- Issue: #43 (and its comments from the #38 verification, the #40 spike and #56)

### Decision

- **One runner per session, in the hub** (`apps/hub/src/runner/`, docs/runner.md).
  `createAgentSession` with `SettingsManager.inMemory`, an empty `agentDir` the
  runner owns, and a `DefaultResourceLoader` with all discovery off
  (`noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`,
  `noContextFiles`). The `hearth-tools` extension registers `read`, `write`,
  `edit`, `bash`, `ls`, `find` and `grep` under their built-in names. Each call
  takes a `SessionManager.ensureBox` lease (lazy start, in-flight accounting),
  builds `ToolRpcClient.operations(boxId, toolCallId)`, and releases the lease
  when the call ends. `grep` replaces `execute()`; `bash` drops pi's `env`.
- **`tool_call`** rewrites `~` to `/workspace` (0011) and applies the config
  deny-list (`{tool, pattern?, reason?}`; `tool` may be `*`; a rule without a
  pattern blocks every call of its tool; the pattern is tested against the bash
  command or the path, and a path also in its normalized form, resolved against
  `/workspace` with `//` and `..` collapsed). A blocked call never reaches the
  box. The deny-list is **best-effort, not a boundary**: shell spellings
  (`rm -fr`, `$X -rf`, `base64 -d | sh`) and write content get past a regex.
  The box is the boundary; stopping those is the job of the M3 approvals.
  **`tool_result`**
  rewrites every path under the hub's temp dir (pi's bash truncation hint,
  codemode's spilled output and saved images) to a note that it is a hub file.
  The box keeps its own full exec output (0011), so the model loses nothing.
- **Model key: the `direct` gateway of PRD §6.4.** The key is resolved from the
  `SecretStore` (`HEARTH_MODEL_KEY_REF`) and applied in memory with
  `ModelRuntime.setRuntimeApiKey`; pi gets no auth file and no hub env. The
  provider and model are config (`HEARTH_MODEL_PROVIDER`, `HEARTH_MODEL`).
  The key, and any other SecretStore value the runner uses, is redacted
  (`[redacted]`) from provider error text and every other event payload,
  failure message and log line before it is stored or logged.
- **Events.** Every pi session event is appended as `pi.<type>` (without the
  `partial`, `messages` and `toolResults` fields, which repeat other events),
  plus `message.user`, `runner.usage`, `runner.interrupted`, `runner.failed`,
  `runner.header` once and `runner.entry` per pi session entry. After a hub
  restart the runner is rebuilt with
  `SessionManager.inMemory(cwd, undefined, [header, ...entries])`.
- **Box crash mid-tool.** The tool RPC fails the call with
  `tool.outcome-unknown` ("its outcome is unknown and it was not re-run"); pi
  turns it into a tool error the model sees, and the turn goes on. The next
  call's `ensureBox` gets the relaunched box. Nothing re-runs the call.
- **Hub restart mid-tool.** A rebuilt runner gives every tool call on the
  branch that has no result an error result saying its outcome is unknown and
  it was not re-run, persists it as `runner.entry`, and records
  `runner.outcome-unknown`. The model does not get pi-ai's synthetic
  "No result provided", which reads as if the call never ran.
- **Crash isolation.** A turn runs in the background behind a catch. An
  exception from `prompt`, from the event subscriber, or a failed event append
  marks that runner `failed`, aborts its turn and appends `runner.failed`.
  The hub then moves the session to `failed` with `SessionManager.fail`,
  through the state machine (authorized as `session.fail`, audited, and
  recorded as a `session.state` event), and stops its box; the volume stays.
  Other sessions and the hub go on. A failed session refuses messages
  (`runner.failed`, 409), also after a hub restart.
- **AGENTS.md under lazy start: a hub-side cache.** The hub never starts a box
  just to read context files. On the first box lease of each turn (the box is
  up for a tool call anyway) the runner reads `/workspace/AGENTS.md` through
  the tool RPC, inside that call's lease (its try/finally), so the lease is
  released whatever happens. A failed read keeps the last copy; a failed
  `runner.context` append fails the call and the runner, like any failed
  append. A changed copy is stored as `runner.context` and used from the
  next turn on (`session.reload()`) and after a restart. The first turn of a
  new session runs without it. Starting the box on session create was not
  chosen: it breaks lazy start (PRD §6.2) for every chat that never touches
  files. Skills can follow the same path (`skillsOverride`).
- **Codemode** is a per-session option, set before the first message
  (`POST /v1/sessions/:id/runner {"codemode": true}`), off by default. QuickJS
  runs in the hub and its `tools.*` calls go through `hearth-tools`, so to the
  box. Its `models` global is off, so scripts cannot spend the key on other
  models. Its hub temp paths are rewritten as above.
- **Extensions (#56).** Only extensions bundled with the hub as pinned
  factories and listed in `extensionAllowlist` with the same version load. The
  allowlist is empty by default. `hearth-tools` and `codemode` are reserved.
- **Legacy box `turn.start` / `turn.end`: deprecated, not removed.** Under 0009
  the box runs no turns: box-agent answers `turn.start` as failed and the hub
  never sends one, so the #38 risk (a re-sent `turn.start` after a refused
  `turn.end` running a turn twice) cannot arise. Removing the frames from v1
  would break a 1.x peer that still decodes them, which is a major bump; a
  deprecation changes no wire shape, so no minor bump either. They go at the
  next major.
- **API**, all behind the login guard (0014), each authorizing the signed-in
  principal first: `POST /v1/sessions/:id/messages {"text"}` (202; the turn
  runs in the background; 409 `runner.busy` while one runs),
  `POST /v1/sessions/:id/interrupt`, `GET /v1/sessions/:id/events?after=&limit=`
  (cursor resume), `GET|POST /v1/sessions/:id/runner`. Actions:
  `session.message`, `session.interrupt`, `session.events`,
  `session.configure`, `session.read`.

### Consequences

- pi's file mutation queue is process-wide (#40): writes to the same path in
  two sessions serialize. Accepted for M1.
- One message at a time per session; steering and follow-up queues come later.
- An exception thrown from a pi timer outside any runner callback is not
  attributable to a session and still reaches the process.

## 0016: Desktop stream: box-agent VNC relay, browser WebSocket, view-only RFB filter

- Date: 2026-11-15
- Status: accepted
- Issue: #45

### Decision

- **Box side (`apps/box-agent/src/vnc.ts`).** On a hub `stream.open` of kind
  `vnc` with an even id (0002), box-agent connects to Xvnc on
  `127.0.0.1:HEARTH_VNC_PORT` (5901, no password, 0004) and relays RFB both
  ways over `stream.data`, at most 64 KiB per frame, seqs from 0. It refuses
  odd or duplicate ids, `file` streams and a ninth open stream with
  `stream.close` `error`. Xvnc closing gives `done`, a connect failure `error`,
  an out-of-order seq `error`. A hub `stream.close` or a lost hub connection
  drops the desktop socket without a frame: desktop bytes are never redelivered.
- **Backpressure, box side.** While the hub socket has more than 1 MiB queued
  (`bufferedAmount`), the relay stops reading Xvnc (TCP pushes back on Xvnc)
  and resumes below 256 KiB. Bytes for Xvnc it has not taken are capped at
  256 KiB; past that the stream is closed with `error`.
- **Hub endpoint: `GET /v1/sessions/:id/desktop`, a WebSocket upgrade on the
  public listener.** It is an app route, so the request guard (0010: Host,
  Origin) and the session guard (0014: login) run on the upgrade request; a
  cross-origin or unauthenticated upgrade gets 403 or 401 before the handler.
  The handler authorizes the signed-in principal with `desktop.view` on the
  session, reads the session (`session.read`), calls `ensureBox` and releases
  the lease at once, then upgrades. Watching does not keep a box awake: the
  session still hibernates on schedule and its viewers are closed then.
  A plain GET gets 426. At most 4 viewers per session.
- **View-only (M1).** The desktop lock that decides who may type is M2
  (PRD §8.3), so the hub parses the browser's RFB and forwards only:
  - the handshake: protocol version `003.008` or `003.007` (3.3 is refused:
    its server-chosen security would desynchronize the parser), security type
    None only, and `ClientInit` rewritten to shared, so a viewer never
    disconnects the desktop's other clients;
  - `SetPixelFormat`, `FramebufferUpdateRequest`, and `SetEncodings` without
    the pseudo-encodings ContinuousUpdates (-313), Fence (-312) and QEMU
    extended key events (-258): the first two would make the server push
    unrequested updates or expect answers, which breaks the pull-based flow
    control below; the third is input.
  Dropped, whole: `KeyEvent`, `PointerEvent`, `ClientCutText` (its text is
  skipped as it arrives, up to 1 MiB), `SetDesktopSize`,
  `EnableContinuousUpdates`, `ClientFence`, QEMU key events. Anything else
  (an unknown type, `SetEncodings` with more than 256 entries, a text frame)
  closes the viewer with 1008: without a length the next message boundary is
  unknown, and passing bytes on could let input through.
- **Backpressure, hub side.** RFB is pull-based: the server sends an update
  only for a `FramebufferUpdateRequest`. While the browser socket has more
  than 1 MiB queued, the hub holds the viewer's filtered messages back, so the
  box stops sending updates; a viewer whose queue would pass 16 MiB anyway is
  closed (4408) and its box stream cancelled. Held browser bytes are capped at
  64 KiB (1008 past it). So per viewer the hub holds at most about 16 MiB.
- **Closing.** The viewer is closed with 4410 when the box connection ends
  (box exit, hibernate, archive, a superseding reconnect) or the box closes the
  stream; with 4401 when its login is no longer valid, checked on every
  browser message and every 5 s (the box stream gets `stream.close`
  `revoked`); with 1001 on hub shutdown. `BoxConnections` gains `sendStream`
  and two listener hooks, `stream` and `disconnected`; a `stream.data` nobody
  holds is answered with `stream.close` `cancelled`.

### Consequences

- No new frame types or protocol version: flow control rides on RFB's own
  request/response, and the box side on TCP.
- M2 (takeover) replaces the drop list with a check of the desktop lock; the
  filter already finds every input message boundary.
- The web UI's noVNC must speak RFB 3.7/3.8 with security None, which is what
  noVNC does against Xvnc `-SecurityTypes None`.

## 0017: Web UI: same-origin static assets, open asset paths, CSP, polled event log

- Date: 2026-11-15
- Status: accepted
- Issue: #46

### Decision

- **UI stack (owner decision).** `apps/web` uses React and Tailwind. Lit
  and other web-components UI libraries are not used; changing the stack
  needs a new decision.
- **Maintained components (owner decision).** The UI uses maintained
  packages wherever one fits (assistant-ui for chat, shadcn/ui primitives)
  instead of components built from scratch. The chat view, tool cards and
  pages in this change are hand-written; #77 replaces them with those
  packages after this change merges (done: 0019).
- **`apps/web`: React 19 + Vite 8 + Tailwind 4**, dependencies pinned
  exactly. It has its own `tsconfig.json` (DOM lib, `jsx: react-jsx`,
  `vite/client` types); the root `typecheck` runs both projects, and the root
  project excludes `apps/web/src`. TypeScript 7 type-checks it (spike notes);
  Vite transpiles without `tsc`. noVNC 1.7.0's root export gets a small
  `declare module` shim over `@types/novnc__novnc` 1.6.0.
- **Served by the hub, same origin.** `bun run build:web` writes
  `apps/web/dist`; `startHub({ webRoot })` serves it on the public listener
  (`HEARTH_WEB_DIR`, else `apps/web/dist` when built, else no UI). Same
  origin is what makes the request guard (0010) and the `SameSite=Strict`,
  `HttpOnly` login cookie (0014) work with no CORS. The UI routes in the URL
  hash (`#/s/<id>`), so the hub serves one HTML file and needs no fallback.
- **Open asset paths.** With a web root configured, the session guard (0014)
  lets `GET`/`HEAD` outside `/v1/` through without a login: the login page is
  one of those assets, and they hold nothing secret. The request guard still
  runs first (a foreign `Host` gets 421), every `/v1/` path, known or not,
  still needs a login (401), and other methods on asset paths still get 401.
  A path that would leave the web root (`..`, encoded or not, a backslash, a
  symlink out) gets 404. `OPEN_ROUTES` is unchanged.
- **CSP on the HTML.** `index.html` is sent with
  `Content-Security-Policy: default-src 'self'; script-src 'self';
  style-src 'self'; img-src 'self' data: blob:; connect-src 'self';
  font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self';
  frame-ancestors 'none'` (`WEB_CSP`), plus `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer` and `Cache-Control: no-cache`. Every asset
  gets `X-Content-Type-Options: nosniff`; hashed `/assets/*` get a year of
  immutable cache. The build emits no inline script or style element
  (`assetsInlineLimit: 0`, no module-preload polyfill), so the policy needs
  no `'unsafe-inline'`. The e2e fails on any CSP violation: a
  `securitypolicyviolation` listener installed before page scripts (Playwright
  `addInitScript`) reports each one, including those the page code catches
  (`try { new Function("") } catch {}` logs nothing to the console), and a
  console listener stays as a second net. A unit
  test parses the served header and checks each directive against this list
  written out by hand (not against `WEB_CSP`), and refuses `'unsafe-*'`, `*`
  and bare schemes in any directive.
  `connect-src 'self'` covers the same-origin desktop WebSocket.
- **The client holds no secrets.** The cookie is `HttpOnly`; the setup token
  is typed by the owner and sent once. Every API call sends
  `Content-Type: application/json` (a body-less POST sends `{}`) and
  `credentials: same-origin`.
- **Chat = the event log, polled.** The session view reads
  `GET /v1/sessions/:id/events?after=<cursor>` page by page and folds
  `message.user`, `pi.*` and `runner.*` events into the chat (`chat.ts`, a
  pure reducer that ignores events at or before its cursor). It polls from the
  last cursor every 0.7 s while a turn runs and every 3 s otherwise. A reload
  rebuilds the chat from the log and continues from its end, which is what
  "closing and reopening the page continues the session" needs. A push
  stream (SSE or WebSocket) can replace the poll later without changing the
  reducer.
- **Tool cards.** One collapsible `<details>` per `pi.tool_execution_*` call:
  the tool, its command (bash) or path/pattern, the output (capped at 64 KiB
  per card), and a status: running, done, error, outcome unknown (an error
  result carrying `tool.outcome-unknown`, PRD §6.3) or interrupted (still
  running when the turn ended).
- **Desktop panel.** View-only noVNC on `GET /v1/sessions/:id/desktop`
  (0016). The page opens the WebSocket itself and hands it to noVNC, so it
  sees the close code: 4410 shows "Box asleep — send a message or click Wake
  to reconnect", and Wake reconnects (which starts the box). The panel
  connects only on a click, because opening the desktop starts the box.
  Watching does not hold the box awake (orchestrator decision on #45); a
  bounded "keep awake while viewing" lease is not part of this.
- **e2e.** `apps/web/e2e/run.ts` drives Chromium (Playwright) against
  `startHub` with the faux model, box-agent as a local process
  (`LocalBoxProvider`, tests only) and a minimal RFB 3.8 server standing in
  for Xvnc. CI runs it in the `web-e2e` job.

### Consequences

- The hub serves whatever is in the web root to anyone who can reach the
  listener; it must only ever contain the built UI.
- Polling costs one small request per 0.7–3 s per open session view.
- No PWA, service worker or push yet (M3).
- Known limitation: opening the UI from a link on another site gets 403.
  The browser sends that navigation with `Sec-Fetch-Site: cross-site` (or
  `same-site` from a sibling subdomain) and no `Origin`, and the request
  guard (0010) refuses it before the asset handler runs, even for `GET /`. Typing the URL, a bookmark or a same-origin link
  (`Sec-Fetch-Site: none` or `same-origin`) works. This is left as it is:
  relaxing 0010 for navigations is a separate decision.

## 0018: Box-agent's secrets are closed to the commands it runs

- Date: 2026-11-15
- Status: accepted
- Issue: #57

### Context

Every process in a box runs as uid 1000: box-agent, Xvnc, Openbox and every
tool command. A same-uid process can read another's `/proc/<pid>/environ`,
`maps` and (with `ptrace_scope` 0) `mem`, and attach to it with `ptrace`. The
hub hands the join token to the box in the container's environment (decision
0008), so before this change a command could read it from tini's, Xvnc's,
Openbox's or box-agent's environ, and could read the per-box credential out
of box-agent's memory.

### Decision

- **The join token leaves the environment before any other process starts.**
  The image's entrypoint now runs as PID 1 (the image's `ENTRYPOINT` is the
  script, no longer tini). When `HEARTH_JOIN_TOKEN` is set it writes the token
  to `/run/hearth/join-token` (directory `0700`, file `0600`, uid 1000) with a
  shell builtin, exports `HEARTH_JOIN_TOKEN_FILE`, and re-execs itself under
  tini with `env -u HEARTH_JOIN_TOKEN`. tini (with `-s` when it is not PID 1)
  then starts Xvnc, Openbox and box-agent with environments that never held
  the token. `docker run --rm hearth-box` with no token still re-execs under
  tini, so PID 1 is always tini once the box runs.
- **box-agent reads the file and deletes it** (`takeJoinToken` in
  `apps/box-agent/src/boot.ts`) before it dials, so the file is gone before
  the first tool call, and removes `HEARTH_JOIN_TOKEN` and
  `HEARTH_JOIN_TOKEN_FILE` from `process.env`. Outside the image (tests, the
  hub's demo) the token may still come from `HEARTH_JOIN_TOKEN`.
- **box-agent is non-dumpable.** Its first act is `prctl(PR_SET_DUMPABLE, 0)`
  through `bun:ffi` (libc), checked with `PR_GET_DUMPABLE`. The kernel then
  makes its `/proc/<pid>/` files root's and refuses same-uid `ptrace`, so
  without `CAP_SYS_PTRACE` (no box process has it: `CapDrop ALL`) a command can
  read neither its environment, memory map nor memory, whatever `ptrace_scope`
  says. If the call fails on Linux box-agent exits 2 instead of running
  unprotected. `execve` resets the flag, so the commands box-agent starts are
  dumpable and the executor's run-marker sweep (decision 0011) still reads
  their environ.
- **No separate uid for tool commands, for now.** Switching uid needs
  `CAP_SETUID`/`CAP_SETGID`, which `CapDrop ALL` removes, and
  `no-new-privileges` disables setuid helpers (`sudo`, a setuid wrapper), so it
  cannot work under the sandbox of decision 0007 as it stands. Making it work
  means adding those two capabilities back to box-agent (as ambient
  capabilities passed to `setpriv`), and moving ownership of the existing
  `/workspace` and `/home/hearth` volumes, which box-agent also writes
  (`tool.write`), to a shared group or to the tool uid. That widens the
  privileges of the one process that holds the credential, to protect against
  the reads that non-dumpable already blocks.
- **Proof.** `apps/box-agent/src/boot.test.ts` runs the real `main.ts` as a
  same-uid child and checks its `environ`, `maps` and `mem` are refused and the
  token file is gone, with a plain Bun process as the readable control.
  `apps/hub/src/box/proc-secrets.docker.test.ts` (CI `box-provider` job) runs a
  `/proc` scan as a tool command in a real box: no process's environ or
  cmdline holds the token, the file is gone, box-agent's environ and maps are
  refused, `mem` and `ptrace` fail, and Xvnc's environ is readable as the
  control.

### Consequences

- What a command can still see: `HEARTH_HUB_URL`, `HEARTH_BOX_ID` and the
  other provider variables in tini's, Xvnc's and Openbox's environ. They are
  not secrets: the box id and hub URL alone do not authenticate.
- Same uid still means a command can signal box-agent (kill it, which ends
  the box's connection; the session manager sees the exit, decision 0013) and
  can read or change anything box-agent writes to disk. box-agent writes no
  credential to disk.
- The token stays visible on the host (`docker inspect`), which is trusted;
  it is single-use and expires after five minutes (decision 0008), so the file
  and environment steps above narrow its window inside the box rather than
  being the only guard.
- An image built before this change still has tini as `ENTRYPOINT`; the hub
  has no way to tell, so a box on an old image keeps the old exposure until
  the image is rebuilt.
- A separate uid for commands stays open; revisit it if a box ever holds a
  secret on disk or in a process other than box-agent.

## 0019: Web UI on maintained packages: assistant-ui chat, shadcn/ui primitives, TanStack Query

- Date: 2026-11-15
- Status: accepted
- Issue: #77 (follows 0017; design input `docs/research/chat-ui.md`, #67)

### Context

0017 shipped a hand-written UI (`chat.ts`, `components.tsx`) and recorded the
owner rule: React + Tailwind only (no Lit), and maintained packages wherever
one fits instead of components built from scratch. This entry replaces the
hand-written parts. Everything else in 0017 (same origin, CSP, cursor-polled
event log, view-only noVNC desktop, the e2e) stays.

### Decision

- **Chat: `@assistant-ui/react` 0.15.36 + `@assistant-ui/react-pi` 0.0.33.**
  react-pi's browser entry has a pure reducer (`reducePiThreadState`) over
  pi's AgentSession events and a projection (`projectPiThreadMessages`) into
  assistant-ui messages. The runner records those same events as
  `pi.<type>` with a monotonic `seq`, so `apps/web/src/hearthPi.ts` only
  strips the prefix and keeps the seq. It adds what pi has no notion of:
  `message.user` shows as a pending user message until pi's own user
  `message_start` arrives (cleared by `agent_end` and `runner.failed`);
  `runner.failed` and `runner.interrupted` become system messages placed
  where they happened; the 64 KiB tool-output cap; Hearth's tool states
  (done, error, outcome unknown, interrupted). The app owns the state and
  hands it to `useExternalStoreRuntime`; no AI SDK, no pi runtime in the
  browser, no `usePiRuntime` (its thread-list runtime adds ~220 kB and a
  transport Hearth does not use). react-pi's optional peer
  `@earendil-works/pi-coding-agent` is satisfied by the 1.5.2 pin.
- **Thread, messages and composer: assistant-ui's registry `thread`**
  (`https://r.assistant-ui.com/thread.json`, added with the shadcn CLI
  together with its registry dependencies: markdown text, tool fallback,
  tool group, tooltip button, attachments and others). `src/Thread.tsx`
  only plugs Hearth's pieces into the component's slots: `ToolFallback` (the
  tool card), `AssistantMessage` (Hearth's notices for system messages, the
  registry's assistant message otherwise), `Welcome` (the empty state) and
  `ToolGroup` (flat, so every tool card keeps its accessible name on screen
  instead of inside a collapsed "N tool calls" group). Copy, export and
  markdown come with it; the edit and refresh buttons render disabled
  because the runtime has no `onEdit`/`onReload` (Hearth's log is
  append-only).
- **Five local edits in `thread.aui.tsx`** (listed in
  `apps/web/README.md`): the composer input, send
  and stop buttons carry Hearth's stable names (`Message`, `Send`,
  `Interrupt`) instead of the registry's `Message input`, `Send message`,
  `Stop generating`; `AssistantMessage` is exported so the slot can fall
  back to it; the attach button shows only when the runtime takes
  attachments (Hearth's does not). Unit tests pin the names and the hidden
  attach button, so re-running the CLI without the edits fails `bun run
  check`.
- **Tool cards: assistant-ui's tool-call UI.** `ToolFallback` (and its
  collapsible) from the same registry, composed with Hearth's status badge
  and the call's target (bash command, else path or pattern). A user
  interrupt during a tool call shows that card as an error, because pi ends
  the call with an error result; the `Interrupted.` notice follows it. This
  matches main before this change.
- **A failed send keeps the text.** assistant-ui clears the composer before
  `onNew` runs; when the hub refuses the send, `sendFromComposer` puts the
  text back with the composer runtime's `setText` (unless something new was
  typed meanwhile) and the page shows the error as an alert.
- **Primitives: shadcn/ui** (Radix + Tailwind 4, new-york style, stone base
  colour): button, input, textarea, label, badge, alert, card, item
  (the session list), plus what the registry thread pulls in, added with
  the shadcn CLI (`components.json`). shadcn ships source by design, so
  `src/components/ui/` and `src/components/assistant-ui/` are registry
  source kept as the CLI wrote it, apart from the edits above (biome skips
  both, and `src/hooks/`). The CLI rewrites `cn` imports to a package called
  `cn`; they point back at `@/lib/utils`. Theme tokens are CSS
  variables in `src/index.css`. No toast package: sonner injects a
  `<style>` element, which `style-src 'self'` forbids; errors show as
  `Alert`s.
- **Data fetching: `@tanstack/react-query` 5.107.1** for auth status,
  sessions, the session, and the event-log poll (`refetchInterval` 0.7 s
  while a turn runs, 3 s otherwise; `readNewEvents` reads every page after
  the cursor and folds it in). Mutations for setup, login, logout, create,
  archive, send and interrupt. A 401 from any query or mutation sets the
  auth query to signed-out, which shows the login form. 4xx is not retried.
- **CSP unchanged.** All of the above pass 0017's policy: Radix sets CSS
  variables through `style` props (CSSOM, allowed by `style-src 'self'`),
  `tw-shimmer` (a dependency of the tool UI) is CSS only, and nothing injects
  `<style>` or evaluates code. zod (an assistant-ui dependency) is put in
  jitless mode before anything else loads (`src/zod-jitless.ts`), so its
  `new Function` probe never runs. The e2e stays fail-closed on any
  `securitypolicyviolation` and passed with none.
- **Every new dependency pinned exactly**, as 0017 requires.
- **DOM tests: happy-dom + Testing Library** (dev only) drive the app
  against a fake hub (`src/web.dom.tsx`): failed send, 401 from a query and
  from a mutation, the session list, the outcome-unknown warning. They run
  in their own process (`bun run test:dom`, part of `bun run test` and
  `check`), because modules loaded under the DOM would leak into the
  server-rendered tests through bun's shared module cache.
- **Stable accessible names** (the compose exit e2e, #47, drives these with
  `getByRole`/`getByLabel`; changing one is a breaking change). The list is
  in `apps/web/README.md`.

### Consequences

- The JS bundle grows from 422.9 kB (130.0 kB gzip) to about 1,258 kB
  (378 kB gzip), mostly assistant-ui, its markdown renderer and Radix.
  Splitting noVNC or the chat into lazy chunks can come later.
- assistant-ui is pre-1.0 and changes often; exact pins plus the e2e catch
  breakage on upgrade. Registry source is updated by re-running the CLI.
- Assistant messages render as markdown (the registry thread's
  `MarkdownText`). M3 approvals (react-pi maps pi extension UI requests to
  tool approvals) are available but not part of this change.

## 0020: Docker Compose install: host-network hub, a privileged firewall one-shot, a models file, the faux model server

- Date: 2026-11-15
- Status: accepted
- Issue: #47

### Decision

- **`deploy/compose.yaml`, three services.** `box-image` builds the box image
  (`hearth-box:local`, `PI_VERSION` from the pi pin) and exits at once: it is
  never a running service, and the hub starts boxes from that tag with
  `HEARTH_BOX_PULL=never`. `box-firewall` is a one-shot that applies the box
  egress firewall. `hub` depends on both completing successfully, so a fresh
  `docker compose up` builds everything, firewalls the host and then starts the
  hub. Settings come from `deploy/.env` (`hearth.env.example`), the model key
  from the file `deploy/secrets/model_key` (a compose secret at
  `/run/secrets/model_key`, `HEARTH_MODEL_KEY_REF=file:/run/secrets/model_key`),
  read through the SecretStore. Data is the named volume `hearth-data` at
  `/data`.
- **The hub image** (`deploy/hub.Dockerfile`) builds the web UI in a first
  stage and ships only `apps/web/dist`, the hub, `packages/*` sources and
  production dependencies on `oven/bun:1.4.4-slim`, with a `/healthz` health
  check (`docker compose up --wait`). Build contexts are the repo root; the
  per-Dockerfile ignore files keep `deploy/secrets` (and the box image's own
  ignore file now does too) out of every build context.
- **The hub runs on the host's network** (`network_mode: host`), as 0012
  requires: it binds each box network's gateway address. Its UI/API listener
  still binds `127.0.0.1:8787`, which is now the host's loopback; the owner
  publishes it with a TLS reverse proxy or an SSH tunnel. No port is published
  and no compose network is created.
- **The hub mounts the Docker socket and runs as root in its container.** The
  socket is root on the host, so a non-root user in the socket's group is no
  smaller boundary, and it would need the host's group id and a key file
  readable by that user, both host-specific. The risk is stated in
  `compose.yaml` and `docs/install.md`: whoever controls the hub controls the
  daemon. The login (0014), the request guard (0010) and loopback binding are
  what stand in front of it.
- **Firewall: a privileged init step, not a host prerequisite.** 0012 needs
  root on the host's network namespace once per boot. Of the two ways to get
  that under compose, the install uses a one-shot container,
  `box-firewall` (`deploy/firewall.Dockerfile`: Debian slim, `iptables`,
  `scripts/box-firewall.sh` unchanged), with `network_mode: host`,
  `cap_drop: ALL` plus `NET_ADMIN` and `NET_RAW`, and the host's `/run/hearth`
  mounted for the marker. Reasons:
  - The owner already gives this compose project the Docker socket, which is
    more than `NET_ADMIN`; a documented `sudo scripts/box-firewall.sh apply`
    adds a manual step and a host dependency (`iptables` binaries matching the
    kernel's backend) without lowering the trust needed.
  - Compose orders it: the hub starts only after the rules and the marker are
    in place, so the first `up` never has a window with unfiltered boxes.
  - The privilege stays out of the long-running hub (0012's reason for a
    one-shot), and the one-shot holds no state.
  The host's iptables backend matters: the rules must sit in the backend
  Docker uses. `deploy/firewall-entrypoint.sh` picks the backend whose
  ruleset has Docker's chains (nft when neither or both do), overridable with
  `HEARTH_IPTABLES=nft|legacy`. After a reboot Docker restarts the hub but not
  the one-shot; the marker is then missing and the hub refuses to start boxes
  (`box.egress-unfiltered`), visibly, until `docker compose up` runs again.
  `docs/install.md` gives a systemd unit that runs it at boot and re-applies
  on a firewalld reload. A host prerequisite stays possible: the script is the
  same file, and an owner can run it on the host and remove the one-shot.
- **`HEARTH_MODELS_FILE`: a pi `models.json` for the runner.** `ModelRuntime`
  is created with it as `modelsPath` (it was always `null`), so an owner can
  use a provider pi does not ship, such as an OpenAI-compatible endpoint.
  The value must be an absolute path to an existing file (startup error
  otherwise); compose mounts `deploy/config/` read-only at `/etc/hearth`. The
  key still comes only from `HEARTH_MODEL_KEY_REF` through the SecretStore and
  is redacted as before (0015). A models file can carry its own `apiKey` and
  `headers` (pi resolves `$VAR` and `!command` there); it is the owner's own
  config, mounted read-only, and the docs do not use those fields.
- **The e2e drives the hub with the faux model server, not pi-ai's faux
  provider.** pi-ai's faux provider lives in the process that registers it;
  the compose hub is another process in another container, and a test-only
  provider switch in the production hub was not wanted. `deploy/e2e/faux-model.ts`
  is a scripted OpenAI-compatible chat completions endpoint (streaming, text
  and tool calls) with an HTTP control API (`/faux/script`,
  `/faux/requests`). The install points the hub at it through
  `HEARTH_MODELS_FILE`, so the e2e also proves that the key from the secret
  file reaches the provider as the bearer token, and never the box.
- **CI runs `docs/install.md` verbatim.** Each block the CI runs is fenced
  as ` ```sh install:<step>`; `scripts/doc-block.sh` extracts one by name
  (one match exactly) and `scripts/run-doc-block.sh` runs it in `deploy/`
  under `bash -euo pipefail`, failing when the block is missing, duplicated
  or empty (so a renamed tag cannot turn a step into an empty, passing script). Only the
  `git clone`, the interactive `read` of the key and systemd are untagged. The
  one step CI does in its own words is the `.env` edit the page asks for,
  done with the models-file option the page documents.
- **The exit e2e** (`deploy/e2e/prototype.ts`, Playwright) drives the UI by
  role, label and accessible name only, so the component rewrite of #77 that
  keeps those names keeps the test. It walks PRD §11.1: `/healthz` with
  `boxEgress: filtered`; setup with the logged token, sign out, sign in;
  create a session; a turn whose `write` and `bash` calls show as done with
  their output, the file read back from the box container's `/workspace` with
  `docker exec`, and the key absent from the box's environment; the desktop
  opened to the real 1280x800 framebuffer; the page closed and reopened from
  the session list, the chat rebuilt and a second turn answered; refusals
  (no login: 401; another `Origin` with a valid cookie: 403; `text/plain`:
  415; a real page on another origin of the same site, which does send the
  `SameSite=Strict` cookie, posting both no-cors and CORS requests), after
  which the session list, the session's events and the model's request count
  are unchanged. Then the job runs the upgrade block (`up --build` again) and
  checks the password, the session and its chat survived and a turn runs, and
  the uninstall and purge blocks, checking that the rules, the marker, the
  boxes, their networks, the volumes and the images are gone.

### Consequences

- The first `docker compose up` builds the box image locally (several
  minutes). Published images are a later step (v1.0 one-command install).
- `PI_VERSION` in `compose.yaml` must move with the pi pin; the box image
  build fails if it does not match the installed pi, so the CI job catches a
  drift.
- The e2e needs Docker, so it runs only in CI (`compose-e2e`), like the other
  Docker suites.

## 0021: Observability: trajectories, structured logs, trace context on tool RPCs, optional OTLP export

- Date: 2026-11-15
- Status: accepted
- Issue: #80

### Decision

- **The trajectory is a projection of the event log**, not a second store.
  The runner records three new event types, all with the event's `turnId` set:
  `runner.turn.start` (turn id, trace id, root span id, pi and hub versions,
  wall and monotonic time), `runner.step` (one per model call or tool call)
  and `runner.turn.end` (outcome `done`, `interrupted` or `failed`, duration,
  counts, tokens, cost). `message.user` now also carries the turn id, and is
  redacted like every other payload. `buildTrajectory` (apps/hub/src/obs)
  turns a session's events into schema **`hearth.trajectory/2`** at read
  time, so the log stays the only source of truth and old sessions get the
  current projection.
- **Schema `hearth.trajectory/2`**, JSON Lines. First a `session` header,
  last a `summary`; in between, in event order, `user_input` (prompt or
  interrupt; approvals when M3 adds them), `turn_start`, `model_call`,
  `tool_call`, `turn_end`, `box` (session state, wake, hibernate, box failure
  and restart), `outcome_unknown`, `runner_failed` and `label`. Every record
  carries `session_id`, `seq`, `at`, `turn_id`, `step_id`, `tool_call_id`,
  `box_id`, `trace_id`, `span_id`, `pi_version` and `hub_version` (null when
  they do not apply). A `model_call` adds provider, model, api, its
  `request`, its `output`, tokens (input, output, cache read and write), cost,
  `latency_ms`, `ttft_ms` (time to the first streamed event), stop reason and
  error class. A `user_input` prompt is `prompt: {text, truncated, bytes,
  sha256}`. A `tool_call` adds name,
  args, the result (text capped at 16 KiB with its byte count and sha256),
  `outcome` (`ok`, `error`, `aborted`, `timeout`, `denied`,
  `outcome-unknown`), exit code, `box_wait_ms` (box start or wake latency as
  the call saw it), duration, and each RPC it made (method, rpc id, span id,
  duration, error code). Durations come from the monotonic clock, and a box
  lease's wait is timed on the same clock as the tool call. A breaking change
  bumps the schema; added fields do not.
- **`/2`: enough to replay and debug a turn** (review of #82). `/1` had ids,
  timings and tokens but not what the model was asked or what it answered.
  - `request`, from pi's state at its `context` event (just before each
    call) and the provider payload at `before_provider_request`: `provider`,
    `model`, `api`, `thinking_level`, `max_tokens` and `temperature` (from
    the payload, whatever the API calls them; null when pi did not set them,
    the provider default), `reasoning` (the payload's `thinking`,
    `reasoning` or `reasoning_effort`), `model_max_tokens` and
    `context_window` (the model's definition), `tools` (names) and
    `tools_sha256` (of the declarations sent: name, description,
    parameters), `system_prompt: {bytes, sha256, text?}` and
    `message_count` (the messages in the context, system messages
    excluded). The system prompt's `text` (`{text, truncated, bytes,
    sha256}`, redacted and capped like every kept text) is on the first
    model call a runner makes and on each call whose prompt changed; later
    calls carry only `bytes` and `sha256` (of the unredacted prompt), which
    name the earlier text. The prompt is built from the AGENTS.md files and
    the working directory, so a build alone cannot rebuild it. Tool schemas
    are hashed, not stored: they are the hub's and pi's code, and the hash
    tells a replay whether it has the same ones. The messages are the
    trajectory's own records (`user_input`, the `output` of each
    `model_call`, each `tool_call`'s `result`).
  - A `context` record for each `runner.context` event: the AGENTS.md
    files the runner read from the box, `[{path, content}]`, each content
    redacted (the hub's sink redactor; the event stores it as read) and
    capped with its size and hash.
  - `output`: `text` and `thinking` (each `{text, truncated, bytes, sha256}`
    or null), `redacted_thinking_blocks` when the provider sent opaque ones,
    and `tool_calls: [{id, name, args}]` for every call the model asked for.
  - **Caps count bytes.** Every kept text (prompt, output text and thinking,
    tool results, tool-call arguments over the cap) is redacted first, then
    capped at 16 KiB of UTF-8 (`Buffer.byteLength`), cut back to a
    code-point boundary so a CJK character or an emoji is never split; the
    record keeps the byte count and the sha256 of the whole redacted text.
    Redacting before the cut means a secret that straddles the cut is never
    half kept. Arguments that fit are kept as JSON, with every string
    redacted, object keys included (a model can put a secret in a key);
    over the cap they become `{text, truncated, bytes, sha256}` of their
    redacted JSON.
  - Events written before `/2` project with `request: null` and
    `output: null`.
- **No third-party trajectory format.** The standard part is the OpenTelemetry
  export below (GenAI semantic conventions). For the JSONL we use our own
  documented schema rather than an agent-trajectory interchange format, since
  none is both maintained and a fit for hub/box steps; an importer or
  converter can sit on top of the projection later.
- **Outcome labels** are placeholders until Retro (PRD §6.8):
  `POST /v1/sessions/:id/labels {turn_id?, task_type?, outcome?, verdict?}`
  (`outcome` one of `success`, `partial`, `fail`, `abandoned`) appends a
  `trajectory.label` event. Without `turn_id` it labels the session; with
  one, it must name a turn of this session (a `runner.turn.start` in its
  log), else 400. The latest value per field wins, on the turn's `turn_end`
  and in the summary.
- **API and CLI.** `GET /v1/sessions/:id/trajectory` returns
  `application/x-ndjson` behind the login guard, authorized as
  `session.trajectory`; labels are `session.label`. A web "copy" or download
  button is #77's to add. `bun apps/hub/src/trajectory-cli.ts [--db PATH]
  <session-id>` dumps it from the database; it resolves
  `HEARTH_MODEL_KEY_REF` first, like the hub, so its output is redacted the
  same way.
- **Trace context on tool RPCs: protocol 1.2.** An `rpc` frame may carry a
  W3C `traceparent` (version 00). It is optional, so a 1.1 peer drops it, and
  a malformed one is dropped by the decoder rather than failing the call. The
  hub sets it to the span of that RPC; box-agent logs one JSON line per tool
  call with `trace_id`, `parent_span_id`, the rpc id and the pi tool call id.
- **Spans, always on; export, off by default.** The hub always runs an
  OpenTelemetry `TracerProvider` (`@opentelemetry/sdk-trace` 3.x), so ids are
  real W3C ids even with no backend. Span tree per turn: `invoke_agent hearth`
  → `chat <model>` per model call and `execute_tool <name>` per tool call →
  `rpc <method>` per tool RPC (GenAI semantic conventions, from
  `@opentelemetry/semantic-conventions/incubating`). Spans and metrics leave
  the hub only when the standard `OTEL_EXPORTER_OTLP_ENDPOINT` (or the
  per-signal variables) is set, over OTLP/HTTP JSON
  (`@opentelemetry/exporter-trace-otlp-http`, `-metrics-otlp-http`);
  `OTEL_SDK_DISABLED=true` turns it off. Spans carry no message text, tool
  arguments or tool output: the GenAI content attributes are opt-in and
  Hearth does not opt in.
- **Metrics** (OpenTelemetry instruments, and the same numbers in the
  trajectory `summary`): `gen_ai.client.token.usage`,
  `gen_ai.client.operation.duration`, `hearth.model.cost`, `hearth.turns`,
  `hearth.tool.calls`, `hearth.tool.failures` by `error.type`, and
  `hearth.box.wait.duration`.
- **Structured logs, redacted at the sink.** `Logger` in `@hearth/core`
  writes one JSON object per line (`ts`, `level`, `component`, `msg`, ids) to
  stderr; `HEARTH_LOG_LEVEL` sets the level. Just before a line is written,
  the whole serialized line goes through the redactor: every secret the hub
  resolved for its own use (registered in `obs/redaction.ts`), raw and
  JSON-escaped, plus credential shapes (`Bearer …`, `sk-…`, `token=`,
  `password=`, `api_key=`). The trajectory API, the CLI and span attributes
  and status messages go through the same redactor; this is on top of the
  runner's own redaction of what it stores (0015). The hub registers its
  secrets **at startup** (it resolves `HEARTH_MODEL_KEY_REF` before it
  serves), not on the first turn: after a restart, a key that a build before
  this change stored raw in `message.user` is still redacted by the API, the
  CLI and the logs.
- **Hub log lines get a level, a component and ids.** Hub components log
  through a plain `(line) => void`; `obs/hub-log.ts` maps each line to a JSON
  log line without changing its text (the compose install greps the
  setup-token line, 0020): `warn` for `WARNING:` lines (box egress not
  filtered, 0012) and for refusals a peer can cause (a rejected credential,
  an ignored frame); `error` for hub and Docker failures (`could not`,
  `failed`, `cannot`, `error`); `info` otherwise. The component comes from
  the line's subject (`session`, `box`, `tool-rpc`, `runner`, `auth`,
  `desktop`, else `hub`), and `session_id`, `box_id` and `turn_id` from the
  ids the line names.
- **Hub version.** `hub_version` is `HEARTH_VERSION` when the build sets it
  (the hub image's `HEARTH_VERSION` build argument, compose passes it
  through), else `apps/hub/package.json`'s version plus the git commit of the
  checkout (`0.0.0+g<sha>`), else the package version: two builds can be told
  apart in a trajectory. `GET /healthz` also reports it, without login (the
  0010 exemption). It names only a commit of this public repository and
  whether the tree was dirty, never a path or host name.
- **Shutdown never hangs on a collector.** `Telemetry.shutdown()` flushes
  both providers, never rejects, and gives up after 5 s; the hub logs a
  warning when the last export did not finish and exits 0.
- **Bun.** The packages run on Bun 1.4.4 unchanged: `TracerProvider`,
  `BatchSpanProcessor`, `MeterProvider`, `PeriodicExportingMetricReader` and
  both OTLP/HTTP exporters were checked against an in-process `Bun.serve`
  collector, which the tests also use. The 3.x SDK takes a processor's
  exporter as `{ exporter }`, and `sdk-trace-base` is now `sdk-trace`.
- **Observability never fails a turn.** A throwing tracer hook is logged and
  ignored; a failed `runner.turn.end` append is logged, not turned into a
  session failure.

### Consequences

- Retention: the event log is append-only (0006), so a retention period for
  trajectories needs a migration that drops the delete triggers and a new
  decision. Deferred to #83. Until then trajectories live as long as the
  session's events, and leave the hub only through the API, the CLI or a
  configured OTLP exporter.
- Replay from the trajectory alone: the user inputs, the system prompt's
  text (once per version), the AGENTS.md context, each call's settings and
  the model's output and tool results are in it. Tool declarations are
  hashed, so an exact replay also needs the same hub and pi build
  (`hub_version`, `pi_version`), which `tools_sha256` confirms. Texts over
  16 KiB (and any secret) are kept as a head with the size and hash of the
  whole, so such a call can be checked but not rebuilt byte for byte; a
  secret is never stored, by design.
- The trajectory route and the CLI pass `redactHub` to the projection, so
  the `runner.context` content, stored as read, is redacted before its cut
  as well as after.
- box-agent has no exporter of its own (it has no network but the hub); its
  side of a call is in its logs, joined by the trace id. Box-side spans can
  later travel to the hub on the connection.
- Sessions recorded before this change have no `runner.turn.*` or
  `runner.step` events; their trajectory has the user inputs, box records and
  summary only.
- The session manager's `box.restarted`, `box.failed` and wake
  `session.operation` events now carry `boxId`, so the trajectory's box
  records name the box.

## 0022: The guard's principal reaches every authorize; a box echo and the desktop are authorized against the resource's workspace

- Date: 2026-11-15
- Status: accepted
- Issues: #61, #50

### Context

Decision 0014 put a login guard in front of every API route and said that the
principal of the login session is what handlers pass to `authorize`. The
session routes (#42) predate it and still passed `LOCAL_PRINCIPAL`. In v1 every
login yields the owner, so the two are the same principal today, and the
mistake was invisible; with more principals the audit log would record the
owner for every session action.

Separately, `box.echo` built its resource from the caller's workspace, not the
box's. `authorize` never saw a cross-workspace echo, allowed it and audited it
as allowed; the hub then refused it with its own check (409
`box.not-connected`). The outcome was right, but the policy and the audit log
were not (PRD §7 E3, E10).

The desktop bridge had the same flaw: it authorized `desktop.view` against the
caller's workspace, not the session's.

### Decision

- **Every handler behind the login guard takes the principal from the guard**
  (`c.get("principal")`): session routes, runner routes, the desktop upgrade
  (which keeps it in the viewer ticket, so later re-checks compare against the
  principal that was authorized), and the box echo. Nothing behind the guard
  names `LOCAL_PRINCIPAL`; the manager's audit rows carry the same principal.
- **`box.echo` is authorized against the box's workspace**: the workspace of
  the box's join binding once it said hello, else the caller's (such a box
  is not visible; see below). A cross-workspace echo is
  denied and audited as denied by `authorize` itself.
- **`desktop.view` is authorized against the session's workspace** (the
  session manager's scope, as the runner does), not the caller's.
- **A box the caller cannot see answers 409 `box.not-connected`, whatever the
  policy decided.** A box is visible when it is connected and its binding is
  the caller's workspace. An unknown id, a box that has not said hello and a
  box of another workspace all get the same status and body, under any
  policy, so the answer never reveals that a box with that id exists in
  another workspace. `authorize` still runs first and its audit row still
  says what it saw (allowed=0 with its reason for another workspace's box).
  Only a denial for a visible box answers 403 `authz.denied`.
- **Visibility is checked after `authorize`**, so a box that connected or left
  meanwhile is judged as it is now, and a policy that wrongly allows a
  cross-workspace echo still sends nothing to the box.

### Consequences

- A test (`apps/hub/src/principal.test.ts`) drives each route family through
  the real hub with a guard that returns a principal other than the owner, and
  checks that this principal reaches `authorize` and every audit row.
  Another of its tests signs in a principal of another workspace and checks
  that `desktop.view` is denied against the session's workspace.
- `apps/hub/src/authz.test.ts` compares an echo to an unknown id with one to
  another workspace's box, under an allow-all policy and one that denies
  `box.echo`: same status, same body, and the audit rows of both.
- Routes added behind the guard later follow the same rule; the test is the
  place to add their family.

## 0023: Box egress hardening: strict allow list, marker trust, firewalld reloads

- Date: 2026-11-15
- Status: accepted
- Issue: #58

Follow-ups to 0012 and 0020 from the verification of #52.

### Decision

- **The allow list is parsed the way iptables reads it, or refused.** An
  octet with a leading zero (`010.0.0.1`) is refused: the script read it as
  decimal 10, iptables (`inet_aton`) reads it as octal 8 and installed
  `8.0.0.1/32` while the marker recorded `010.0.0.1`. Refusing is chosen over
  normalising because the owner's intent is ambiguous. A newline in
  `HEARTH_BOX_EGRESS_ALLOW` is refused too: `read` took only the first line and
  dropped the rest without a word. Both are refused before any rule or the
  marker changes.
- **The hub trusts the marker only if only root could have written it.**
  `markerEgressCheck` (`apps/hub/src/box/egress.ts`) counts the firewall as
  applied when the marker is a regular file (not a symlink) owned by uid 0
  and not writable by group or others, and every directory on its real path
  (after `realpath`, so `/var/run -> /run` works) is owned by root and is
  not writable by group or others unless it is sticky (`/tmp`). So nobody but
  root can create, replace or rename the marker or a directory above it.
  Otherwise the status is `unfiltered`, with the reason in its detail line.
  - *Bare metal*, hub as an unprivileged user: a `HEARTH_BOX_EGRESS_MARKER`
    that points at a hub-writable path cannot be forged by the hub; the
    script's default `/run/hearth` (root, 0755) and its marker (root, 0644)
    pass.
  - *Compose*, hub as root in its container (0020): the one-shot writes the
    marker as root into the host's `/run/hearth`, which the hub mounts
    read-only, so the same check passes. No file mode holds off a root hub;
    there the check only proves the marker is root's, and the hub is trusted
    by construction (it holds the Docker socket).
  - The check reads owner and mode bits, not ACLs, and assumes uid 0 is
    root in the hub's view (no user-namespace remapping of the bind mount).
- **firewalld reloads re-apply the rules.** `ReloadPropagatedFrom=` in the
  documented units fired only on `systemctl reload firewalld`, never on
  `firewall-cmd --reload` (D-Bus, not systemd) nor on a restart. The units
  in `docs/demo.md` (bare metal) and `docs/install.md` (compose) now use
  `PartOf=firewalld.service`, which re-runs them on a firewalld restart, and
  a second unit runs `scripts/firewalld-reload-watch.sh`, which waits for
  firewalld's `org.fedoraproject.FirewallD1.Reloaded` signal (`dbus-monitor`)
  and runs `systemctl reload` of the firewall unit each time. When the
  monitor ends, the watcher exits 1 and systemd restarts it.
- **No timer re-probe from a throwaway box (for now).** The marker still
  cannot see rules flushed by hand. A re-probe would mean the hub starting a
  box container and network on a timer (image pull, Docker work and a
  network per probe, and a probe that must tell "rule missing" from "host
  port closed"), outside the egress module. The reload watcher and
  `PartOf=` cover the flushes that happen without the owner's intent; a
  manual flush stays documented as the owner's responsibility.

### Consequences

- An allow list that worked by accident with leading zeros or several lines
  now fails `apply`, with the reason, and the previous rules stay.
- A marker the hub user can write, or one in a hub-writable directory, now
  reports `unfiltered` and boxes do not start. Tests pass their own uid as
  the owner (`markerEgressCheck(marker, { owner })`).
- Hosts with firewalld need `dbus-monitor` for the watcher (Debian's
  `dbus-bin`).

## 0024: Egress marker: one hard link, one resolved path

Status: accepted. Qualifies 0023.

0023 says nobody but root can create or replace the marker. That holds for
the default `/run/hearth` and for any directory only root can write. It does
not hold in a sticky directory such as `/tmp` on a host with
`fs.protected_hardlinks=0` (the kernel default; systemd sets 1): a user can
`ln /etc/hostname /tmp/box-egress.applied`, and the result is root-owned,
mode 0644. So the marker must also have exactly one hard link
(`box-firewall.sh` writes it with mktemp and mv, so a real marker always
has one). The check resolves the marker's directory once and uses that
resolved path for both the file `lstat` and the directory walk. The
supported place for the marker stays a root-only directory.

## 0025: Web: an error boundary around the lazy session page

Status: accepted. Extends 0017's web dependencies.

The session page is a lazy chunk (#84). Its file name is a content hash, so
a hub upgrade removes the old file while a tab that has not opened a
session yet still asks for it. The import then fails, and without an error
boundary React unmounts the whole tree: a blank page with no way out.

- **`react-error-boundary` 6.1.6**, pinned exactly. It is maintained, MIT,
  about 3 KB (1.2 KB gzip), imports only React, and renders no styles and
  evaluates no code, so 0017's CSP holds (the web e2e stays fail-closed on
  any violation and passes). The owner's rule is maintained packages over
  hand-rolled components, so not a hand-written class component.
- **The fallback keeps the app shell**: the header, Sign out, and a
  shadcn `Alert` ("The session page did not load.") with Reload and a
  Sessions link. React.lazy keeps a failed import, so Reload reloads the
  page, which also fetches the new `index.html`.
- **The web e2e 404s the chunk** on direct navigation and in-app, checks the
  alert, Reload, Sessions and Sign out, then lets the chunk load and checks
  that Reload opens the session.
- **The "…" menu (Export as Markdown) stays and is non-modal.** It runs in
  the browser. Radix's modal dropdown injects a scroll-lock `<style>`
  element, which `style-src 'self'` blocks, so the registry thread passes
  `modal={false}` (a marked local edit, listed in `apps/web/README.md`).
  Only Refresh (regenerate) is gated on the runtime's reload capability.

## 0026: The box desktop runs a supervised Chromium; the box is its sandbox

- Date: 2026-11-15
- Status: accepted
- Issue: #92
- Supersedes the "image does not start Chromium" part of 0004.

### Context

The box image installed Chromium (PRD §6.2), but the entrypoint started only
Xvnc and Openbox, so the desktop pane showed a black Openbox root with a
cursor. The compose e2e checked only that a 1280x800 canvas existed, so it
passed on that black screen.

### Decision

- **The entrypoint starts Chromium on the desktop** once Openbox manages
  windows (it waits up to 5 s for `_NET_SUPPORTING_WM_CHECK`), maximised,
  with CDP on `127.0.0.1:${HEARTH_CDP_PORT}` (9222, `--remote-debugging-address=127.0.0.1`,
  never published: the image has no `EXPOSE` and the provider publishes
  nothing, 0007). Its profile is `/home/hearth/.config/hearth-chromium`, on
  the home volume, so it survives hibernate. It opens
  `/usr/share/hearth/start.html`, a static page naming the session (from the
  URL fragment) and `/workspace`. `xsetroot` paints the root window slate
  (`#3b4a5c`), so a desktop without a browser is visibly not a dead one.
- **A shell supervisor restarts it.** When Chromium exits for any reason (the
  user or the agent closed it, a crash) the supervisor logs the exit code to
  `/tmp/chromium.log` and starts it again after 1 s, doubling to 30 s while
  it keeps exiting within 30 s of its start. It removes the profile's
  `Singleton*` lock files before each start: the profile outlives the
  container, and a lock naming the previous container's hostname would make
  Chromium refuse to start. Only the supervisor starts Chromium on that
  profile, so removing them does not break a live browser.
- **Clean environment (0018).** The supervisor runs after the re-exec under
  tini, so the join token is already out of the environment, and it starts
  Chromium with `env -i` and a fixed list: `HOME`, `USER`, `LOGNAME`,
  `SHELL`, `PATH`, `LANG`, `DISPLAY`. Nothing from the provider's boot env
  (`HEARTH_HUB_URL`, `HEARTH_BOX_ID`, `HEARTH_JOIN_TOKEN_FILE`, ...) reaches
  the browser, its renderers, or a page. Debian's `/usr/bin/chromium`
  wrapper adds its own (`CHROMIUM_FLAGS`, `CHROME_*`, Debian's public
  `GOOGLE_*` API keys, `PWD`); none come from the box.
- **Sandbox: `--no-sandbox`, because the box is the sandbox.** This applies
  the reasoning of 0007, now checked against the real box: with all
  capabilities dropped, `no-new-privileges` and Docker's default seccomp
  profile, Chromium has neither a setuid helper (blocked by
  `no-new-privileges`, and not shipped by Debian) nor unprivileged user
  namespaces (denied by the seccomp profile, and by AppArmor on Ubuntu 23.10
  and later hosts), so with its sandbox on it refuses to start. The
  `box-provider` CI job asserts exactly that: `chromium --headless` without
  `--no-sandbox` fails in a provider-started box. The entrypoint passes
  `--no-sandbox` only when the box's environment has
  `HEARTH_CHROMIUM_SANDBOX=off`, which `DockerBoxProvider` always sets; a
  future runtime (gVisor, a VM provider) that leaves the variable unset gets
  Chromium's sandbox. Inside one box a renderer escape reaches only what the
  agent's own commands already reach: the session's files and short-lived
  credentials, never box-agent's environment or memory (0018).
- **Egress.** Chromium runs in the box's network namespace, so the host
  firewall of 0012 applies to it unchanged. The echo e2e loads the CI LAN
  host in Chromium over CDP: reached with the firewall off, blocked with it
  on, the same as `fetch` from a tool command.
- **Image layers (0004).** `x11-xserver-utils` (for `xsetroot`) joins the
  desktop layer; the start page is copied next to the entrypoint in the top
  layer, so editing it rebuilds neither the desktop nor pi.
- **Proof.** `provider.docker.test.ts`: CDP `/json/version` answers inside
  the box, every CDP listener is on loopback, the browser process runs as
  uid 1000 with exactly the variables above (plus the wrapper's), no
  Chromium process holds the join token, and after a `kill` a new browser process answers CDP.
  `proc-secrets.docker.test.ts` sees Chromium among the box's processes with
  the same clean environment. The compose e2e samples the desktop canvas and
  fails when one colour covers more than 95% of it or the start page's
  accent colour is missing (`deploy/e2e/desktop-pixels.ts`), so the black
  desktop of #92 fails it.

### Consequences

- The `--no-sandbox` infobar shows in the desktop browser; it is accurate.
- Chromium costs memory in every running box (about 200-300 MB idle with one
  tab), inside the box's memory limit.
- Browser tools for the agent (navigate, click, screenshot over CDP) are a
  separate issue; they can use this browser through its CDP port.
- CDP has no authentication: any command the agent runs in the box can drive
  this browser on `127.0.0.1:9222` and read its pages, cookies and storage,
  including anything the owner signs into on the desktop. The box is one trust
  domain (the agent already has its shell); do not sign into accounts on a box
  desktop that the agent should not use.
- The browser is not shut down cleanly: tini (without `-g`) forwards SIGTERM
  to box-agent only, and the supervisor and Chromium are killed with the
  container on stop or hibernate. The profile under `/home/hearth` survives,
  but Chromium may report that it did not shut down correctly on the next
  start.
- Desktop supervision beyond Chromium (Xvnc or Openbox dying) is still #15.

## 0027: Runner restart: a finished but unpersisted tool call is marked outcome-unknown

Status: accepted. Clarifies 0015 ("Hub restart mid-tool"); behavior unchanged.

When one assistant message holds two tool calls and the hub restarts after the
first call finished but before its result was stored as `runner.entry`, the
rebuilt runner treats that call like any call with no stored result: it gets
the `RESTART_OUTCOME_UNKNOWN` error result, even though the event log may
already hold its `pi.tool_execution_end`.

- **Kept as is, not recovered from the log.** The safe direction: the model is
  told to check the box before it repeats the call, and nothing re-runs it.
  Recovering would trust a second record (`pi.tool_execution_end` has no
  `runner.entry`, so the result's message shape and ordering would have to be
  rebuilt by hand) for a rare window, with a wrong-result risk that outweighs
  one extra check by the model.
- The rule is therefore simple: a call has a result only when its result entry
  is persisted.
- Two records then differ on purpose. The trajectory (0021) keeps the call's
  real outcome, from the `runner.step` (`kind: "tool_call"`) that the turn
  tracer stored at `tool_execution_end`; the rebuilt model context gets the
  outcome-unknown result. The trajectory shows what happened in the box; the
  model context shows only what the runner can vouch for.
- The rebuild also records `runner.outcome-unknown` for this call, as 0015
  says, with the call's id in `toolCallIds` (one event per rebuild that found
  orphans), so the trajectory shows an `outcome_unknown` entry next to the
  real step.

Test follow-ups from #75 (JSON-escaped secret redaction and the failed
`runner.context` call result) are in `runner.test.ts`.

## 0028: Heartbeat on the hub-box connection: protocol ping/pong, separate clocks, counted misses

- Date: 2026-11-15
- Status: accepted
- Issue: #31

### Context

Nothing checked that the hub-box WebSocket was alive. `ping`/`pong` were in
protocol 1.0 for liveness (0002), and both ends answered a `ping`, but nobody
sent one. A path that goes silent without a FIN or RST (a NAT timeout, a
frozen or paused box, a host that sleeps, a lost route) left the box-agent
"connected" forever with its outbox filling, and the hub until Bun's implicit
120 s idle timeout (PRD §8.1 principles 1 and 4).

### Decision

- **Protocol frames, not WebSocket control frames.** Each end sends the
  protocol's own `ping` and treats **any** frame from the peer as proof of
  life. Bun's server can send WebSocket pings (`sendPings`, `idleTimeout`),
  but the box dials with the standard `WebSocket` client, which can neither
  send a ping nor see a pong, so the box could not run its own check.
  `ping`/`pong` have been in the protocol since 1.0, so there is **no version
  bump**: a peer that answers `ping` already interoperates, and a peer that
  never pings is still watched by the other end.
- **Separate clocks.** The hub runs one heartbeat per open connection and
  the box-agent runs its own, each on its own timer (`HeartbeatClock`,
  injected; `setInterval` outside tests). Neither depends on the other's
  pings: a one-way silence is caught by the side that hears nothing.
- **Failures are counted, not timed.** `Heartbeat` (`packages/protocol`, no
  I/O) beats every `HEARTBEAT_INTERVAL_MS` (5 s). A beat that heard no frame
  since the previous beat is a miss; any frame resets the count. After
  `HEARTBEAT_MAX_MISSES` (3) misses in a row the connection is dead: between
  15 s and 20 s (`heartbeatBoundMs`) after the last frame. The hub counts a
  frame as heard when it arrives, before it is queued behind an apply, so a
  slow store never makes a live box look dead. The count starts after the
  handshake; the handshake has its own deadlines (`HELLO_DEADLINE_MS`,
  `HANDSHAKE_DEADLINE_MS`).
- **Failure owner on the hub.** `BoxConnections` declares the connection
  dead: it logs `box <id> connection dead: …` (level `warn`), calls the new
  listener method `dead` before `disconnected`, fails the connection's own
  calls (`echo`) with `box.connection-dead` (retry), and terminates the socket
  (no closing handshake a dead path would never answer; close code 4005,
  `heartbeatTimeout`, where a close is sent). It appends a
  `box.connection-dead` event (`boxId`, `bootId`, `detectedBy: "hub"`,
  `misses`, `intervalMs`, `closeCode`) to the box's session log, which the
  trajectory shows as a `box` record (0021).
- **Tool RPCs fail at once.** Unlike a plain close (0011: a same-boot
  reconnect re-sends), a dead connection says nothing about when, or whether,
  the box comes back. `ToolRpcClient` fails every call it sent on that
  connection (same box, same boot) with `tool.outcome-unknown` and never
  re-sends it: a mutating call gives up (it may have run), a read-only one is
  `retry` (`classifyToolError`). Calls on other boxes or boots are untouched.
- **The session manager is told** as for any disconnect (0013): the socket
  is terminated, so Bun runs the box socket's close handler at once (it
  calls `boxClosed`) instead of after a closing handshake a dead path never
  answers.
- **The box reconnects.** On the box side a dead connection is dropped and
  retried through the usual backoff (`reconnectDelay`); the outbox
  redelivers after the next handshake (0008). Calls still running in the box
  keep running; the hub has already failed them.

### Proof

- `heartbeat.test.ts` (protocol): miss counting, reset on a frame,
  consecutive misses only, once-only `dead`, stop and restart.
- `apps/hub/src/box/heartbeat.test.ts`: on an injected clock, a silent box
  stays connected through 2 beats and is dead on the 3rd; `dead` before
  `disconnected`; the socket dropped without a close frame (1006) and the
  session manager told at once; an ordinary close stops the beats; an `echo` in flight fails with
  `box.connection-dead` and `retry`; the event and its trajectory record; a
  box that pongs, or sends any frame, stays connected; frames queued behind
  a store whose append blocks keep the box alive for twice the bound.
- `heartbeat-long-call.test.ts`: a real hub and box-agent, both clocks
  injected, through a tool call that sends no frame for 10 beats (50 s of
  injected time): neither end declares the connection dead.
- `tool-rpc.test.ts`: dead fails calls of that box and boot only, with the
  dispositions above, and nothing is re-sent on reconnect.
- `apps/box-agent/src/connection.test.ts`: a hub that goes silent after
  `welcome` is dead on the 3rd beat, the agent closes the old socket and
  redials; a hub that pongs, or sends any other frame, keeps it connected.
- `heartbeat.docker.test.ts` (CI, box-provider job): `docker pause` on a real
  box with the hub at 1 s × 3; the hub declares it dead within
  `heartbeatBoundMs` plus 1.5 s of slack, records it and fails an `echo` in
  flight; after `docker unpause` the same boot reconnects and answers.

### Consequences

- Each connection carries a `ping`/`pong` pair every 5 s in each direction
  while idle: a few hundred bytes a minute.
- A box frozen for longer than the bound (a debugger, a host suspend) loses
  its connection and its in-flight tool calls; it reconnects when it thaws.
- The numbers are constants with options for tests, not owner settings. A
  remote or cross-host box (E5) may need its own values; that is a change of
  these defaults, not of the scheme.
- The `box.connection-dead` event carries no turn or trace id.
  `BoxConnections` does not know which runner turn is using the box (the
  turn runs in the hub and reaches the box only through tool RPCs), so the
  trajectory gives the record the trace id of the session's last turn, as
  for the other box events. The turn itself records the failed tool calls
  (`tool.outcome-unknown`) under its own trace id. Passing the active turn
  down to `BoxConnections` is left for when a turn-scoped box record is
  needed.

## 0029: Request bodies are read after `authorize`; unencodable params and hub-side handshake failures are classified

- Date: 2026-11-16
- Status: accepted
- Issue: #32

### Context

Three hub paths gave an unclassified answer (PRD §8.1 principles 2 and 6).
Echo params the protocol cannot carry (JSON deeper than `MAX_JSON_DEPTH`)
made `encodeFrame` throw a `RangeError` inside `BoxConnections.rpc`: a plain
500, and a pending entry and its timer left until the deadline. The tool RPC
client had the same path and threw synchronously. A credential store or
policy that threw during `hello` (`SQLITE_BUSY`, a disk error) sent nothing;
the box waited and the hub later closed with 4004 "no hello". And every route
with a body (echo, `POST /v1/sessions`, messages, runner options, labels)
parsed it before `authorize`, so a body that is not JSON got 400 with no audit
row, against "every API handler calls `authorize` first" (AGENTS.md).

### Decision

- **Bodies are read after `authorize`.** A route hands its service a
  `RequestBody` (`apps/hub/src/request-body.ts`), which the service reads
  after `authorize` and after its visibility or existence check. A body that
  is not JSON is audited like any other request and answers `400
  request.invalid` (`request.invalid-json` on echo) only to a caller who may
  act. A caller who may not gets the same answer as with a valid body: the
  same-answer rule of 0022 and #94 holds for the body too.
- **Unencodable rpc params are the caller's error.** `rpc` and `sendRpc`
  encode the frame before anything is registered or sent; an `EncodeError`
  becomes `rpc.invalid-params` (owner `user`, `give-up`), which the echo route
  answers with 400. The tool RPC client turns it into `tool.bad-params` and
  rejects, never throws. Nothing stays pending.
- **A hub-side failure during `hello` is `reject` `internal`.** Any throw from
  the credential store or the authorizer during the handshake sends `reject`
  `internal` (which box-agent retries) and closes with 4001, never silence.

### Consequences

- A refused caller that sends a bad body now gets 401/403/404/409 instead of
  400; the order of checks no longer depends on the body.
- New error code `rpc.invalid-params` on the echo endpoint.

## 0030: Stage plan v0.4: milestones by user-visible features; a vault in M2

- Date: 2026-11-16
- Status: accepted
- Issue: #106

### Context

M1 Prototype shipped. The v0.3 stage plan (decision 0009) listed later
milestones as engineering work ("Hardening & desktop": hibernate polish,
resource limits, image slimming #15, test debt #25 and #26), which does not say
what the owner can do after a stage. The owner also wants a place to manage
credentials: today the model key is a file (`deploy/secrets/model_key`) and the
model is chosen in `.env`.

### Decision

- **PRD v0.4, §11 re-planned** into M2 Browser & vault, M3 Anywhere,
  M4 Connections & automation, M5 Retro & router, and v1.0. Each stage lists
  what you can do after it in user terms and closes on testable exit criteria
  tied to a scenario (S2 to S5). M1 is marked done with what shipped (§11.1),
  and §11 opens with how to use Hearth today.
- **The old M2 is split by what it serves.** Desktop takeover with the lock,
  live shell output and desktop process supervision (#15 item 1) go to M2,
  because driving and watching a browser needs them. Base image pinning and
  slimming (#15 items 2 to 4), hibernate polish to the §6.3 acceptance and
  global resource limits go to v1.0, next to backup / restore and the
  10-minute install. The test debt (#25, #26) is already closed.
- **A vault (PRD §6.10, goal G9) in M2.** It stores model keys, site logins and
  API tokens encrypted at rest, shows only fingerprints, audits every use
  first, and lets the agent use a credential without the model seeing it. The
  model key and model choice move into the settings UI; `env:` / `file:`
  references stay as a fallback. Research #108 settles the master key, cipher,
  TOTP and whether values enter the box; the PRD marks those spots
  TODO(#108). Browser automation details are left to research #107,
  marked TODO(#107).
- **Placeholder substitution (#70) moves from M3 to M2**, because the vault's
  "the model never sees a value" needs it.
- **The model router moves from P2 to P1 (M5).** It suggests a model per task
  type from past outcomes and spend; the owner accepts a suggestion before it
  becomes a default, so nothing switches models silently.
- **Default model `claude-sonnet-5-5`.** `deploy/hearth.env.example`,
  `docs/install.md` and `docs/runner.md` used `claude-sonnet-4-5`. The newest
  Sonnet in pi 1.5.2's registry is `claude-sonnet-5-5`
  (`@earendil-works/pi-ai` 1.5.2, `dist/providers/data/anthropic.json`, key
  `chat:claude-sonnet-5-5`, "Claude Sonnet 5.5"; the other Sonnet ids there
  are `claude-sonnet-4-5`, `claude-sonnet-4-5-20250929`, `claude-sonnet-4-6`
  and `claude-sonnet-5`).

### Consequences

- M2 is larger than the old M2: browser tools (#93), takeover, the vault and
  #70. The vault and browser designs wait for #107 and #108.
- The slim image and the hibernate acceptance now gate v1.0, not M2, so the
  §6.3 numbers are not measured before v1.0.
- Code comments that name a milestone (approvals in M3, the desktop lock in
  M2) stay correct.

## 0031: The vault: encrypted secrets in SQLite behind `vault:` refs, a generated key file, no read-back

- Date: 2026-11-16
- Status: accepted
- Issue: #114 (design: research #108, `docs/research/vault.md`)

### Context

The model key is a compose secret file and the model a `.env` line (0020). Site
logins and tool tokens have no home, and E7 resolves only `env:` and `file:`.
PRD §6.10 asks for a vault that encrypts at rest with maintained crypto, never
returns a value, audits every use first and redacts every value; §13 says that
from M2 no credential is kept in a file the owner edits. Research #108 settled
the design; this entry records what M2's vault core implements and where it
deviates.

### Decision

- **Store.** Migration 6 adds `vault_key` (one row: the data key wrapped with
  AES-KW, `kek_check`, provider, timestamps) and `secret` (one AES-256-GCM
  ciphertext per entry, fresh 96-bit IV, version, keyed fingerprint, metadata).
  The AAD is `hearth-vault/v1|id|workspace|name|kind|version|scope|SHA-256(policy_json)`;
  `policy_json` is canonical (sorted keys; origins and hosts lower-cased,
  sorted, unique), so an edit of any bound column, a row swap or a rollback to
  an older version fails with `vault.entry-corrupt`. Crypto is WebCrypto only
  (`packages/core/src/vault.ts`): AES-GCM, AES-KW, HKDF-SHA256, HMAC-SHA256.
- **Key.** 32 random bytes, generated by the `install:vault-key` step of
  `docs/install.md` (mode 0600, never overwritten, also run by every upgrade,
  removed by purge) and read through the SecretStore (`HEARTH_VAULT_KEY_REF`).
  HKDF derives three subkeys: the AES-KW key, the `kek_check` key and the
  fingerprint key. Fingerprints are `hmac:` plus 12 hex digits of an HMAC under
  the fingerprint key, so they stay the same across a data-key rotation and a
  leaked fingerprint cannot be checked against a dictionary.
- **Missing, invalid or wrong key: the hub starts with the vault disabled.**
  Reasons `key-missing`, `key-invalid`, `key-mismatch` (with the expected and
  found `kek_check` prefixes) and `store-corrupt` (a matching key whose wrapped
  data key does not unwrap). `env:` / `file:` refs keep working; a `vault:`
  resolve fails with `vault.disabled`; adding or rotating answers 409. On a
  mismatch nothing is written, so restoring the right file recovers the vault.
  The hub logs `vault: enabled` or `vault: disabled (<reason>)` (component
  `vault`, the latter at warn).
- **A key file others can read is used, with a warning.** At every start the
  hub stats a `file:` key and logs (warn) `vault: the key file <path> is
  readable by others (mode …); run chmod 600 on it` when group or other bits
  are set. It does not refuse: that would lock the owner out of a working vault
  over a mode, and some Docker hosts report every bind-mounted file as 0777.
  `install:vault-key` writes it 0600 (`umask 077`).
- **Rotation.** `HEARTH_VAULT_KEY_NEXT_REF`. At open, if the current key matches
  and a valid next key is present, the data key is rewrapped under the next key
  and `kek_check` and every fingerprint are rewritten in one transaction,
  audited `vault.key.rotate` with both `kek_check` prefixes. If only the next
  key matches, that rewrap already committed and the hub runs on it with a
  warning to finish the cutover (`mv vault_key.next vault_key`). A crash in the
  middle rolls back. `HubVault.rotateDataKey` re-encrypts every entry under a
  new data key in one transaction (`vault.data-key.rotate`).
- **Refs and uses.** `vault:<name>[#field]` through `VaultSecretResolver` (E7).
  Through the hub's SecretStore only global `model-key` and `use: hub` `token`
  entries resolve; `HubVault.use(ref, {sessionId, tool, toolCallId, origin, kinds})`
  is the hook for session tools (`browser_fill`, #118), and it also allows
  entries scoped to that session. A login is handed out only when the page
  origin the box reported (scheme, host and port of an `http(s)` URL, as
  `URL.origin` prints it) is one of its policy's origins; no origin, another
  one or a non-`http(s)` URL is `vault.origin-mismatch`. `use` returns the
  value with the entry's name, kind, field and policy (origins and
  `allow_any_field`, or a token's `use` and hosts), read from the row whose AAD
  just verified, so #118 enforces them without a second, unauthenticated read.
  Each use decrypts first (so the scope and
  policy it checks are authentic), then writes `secret.use` (name, field,
  fingerprint, version, consumer, session, tool, tool call, origin); if that
  record cannot be written the value is not returned (`vault.audit-failed`).
  Refusals are recorded as `secret.use-refused` with their code.
- **No read-back.** `GET /v1/vault/status`, `GET /v1/secrets`,
  `POST /v1/secrets`, `PUT /v1/secrets/:id/value`, `DELETE /v1/secrets/:id`,
  `GET /v1/secrets/:id/uses`. Each authorizes first and reads its body after.
  A denied caller never has its body parsed: a foreign principal gets the same
  403 for a valid, an invalid and an unparseable body.
  `fields` is write-only; answers carry fingerprints and metadata. Create,
  rotate and delete write a `secret.*` record with the detail (name, kind,
  fingerprints, version, never a value) before they act.
- **Redaction.** Every value joins the hub's registry (0021) when it is saved,
  when it is used, and at open for every stored entry; the runner's redactor
  (0015) now also applies the registry, so events, logs, trajectories (the API
  and the CLI) and span attributes drop it. Values are replaced as spans, not
  one after another (`redactValues`): every occurrence of every value, raw and
  JSON-escaped, is found in the original text and each run of overlapping
  matches becomes one `[redacted]`. Replacing in registration order left the
  tail of a password that contains its login's username, or of a model key
  that starts with a token's value.
- **The trajectory CLI fails closed.** It opens the vault read-only (never
  creating the data key or rotating) with `HEARTH_VAULT_KEY_REF` and
  `HEARTH_VAULT_KEY_NEXT_REF`, so it also works after a rotation committed and
  before the cutover. If the database has a vault that does not open, it
  refuses to dump (exit 1) because the vault's values could not be redacted;
  `--unredacted-ok` dumps anyway with a warning. A database with no vault needs
  no key.
- **Extension points.** `VaultKeyProvider` (the key file now; OpenBao transit
  later) and `VaultEntryBackend` (SQLite now; OpenBao KV v2 later) in
  `packages/core`.

### Deviations from the research

- **The key file holds base64, not raw bytes.** The `file:` resolver returns
  text (UTF-8, one trailing newline dropped), which would mangle random bytes,
  and an `env:` key for development cannot hold raw bytes either. The step is
  `head -c 32 /dev/urandom | base64`; anything but the base64 of exactly 32
  bytes is `key-invalid`.
- **`deploy/secrets` is mounted read-only at `/run/hearth-secrets`, not as a
  compose secret.** A compose secret whose file is missing stops
  `docker compose up`, so an optional `vault_key.next` would need a compose edit
  for every rotation, and a lost key would stop the hub instead of disabling the
  vault. The directory mount gives both: `HEARTH_VAULT_KEY_NEXT_REF` is always
  set, and a missing `vault_key.next` means "no rotation".
- **`vault:` values are not cached.** The research kept the 30 s SecretStore
  cache with an invalidate on rotate. A cached value would skip both the
  decrypt (the AAD check of the policy in force) and the `secret.use` record.
  `SecretResolver.cacheable = false` makes the store call the vault on every
  resolve; a decrypt is microseconds.
- **Scope is enforced through the hub's SecretStore too:** it has no session,
  so a session-scoped entry never resolves there.
- **Not in this change** (follow-ups): `PATCH /v1/secrets/:id` (name, scope or
  policy changes; the owner password for an origin change), the
  `POST /v1/vault/rotate-key` route (rotation runs at start), the `setting`
  table, model settings and the first-start import of `HEARTH_MODEL_KEY_REF`,
  the Settings page (#115), `browser_fill` (#118), TOTP and `box-env` tokens in
  exec RPCs. The compose file keeps `model_key` until the import lands.

### Consequences

- A stolen database or volume backup reveals names, kinds, origins and keyed
  fingerprints, not values. A backup is the volume plus `secrets/vault_key`,
  kept apart; losing the key loses the vault.
- A hub compromise reveals everything, as before.
- Every `vault:` resolve costs one decrypt and one audit row; the runner
  resolves its model key once per runtime, so this is not on a hot path.
- **Rotating or deleting a `vault:` model key takes effect when the model
  runtime restarts**, because the runner resolved the key once: today that is a
  hub restart; #115 adds a reload with the model settings. Until then the old
  key stays in use (and in the redaction set) for new turns.
- The key derivation is pinned by known-answer vectors (`kek_check`, a
  fingerprint and a wrapped data key for a fixed master key, computed outside
  the code): a change of an HKDF info string, the salt or the wrap would make
  every existing vault unreadable and fails the tests first.
- **Known gaps:** redaction misses encodings it does not know (#70); short
  values over-redact; usernames are redacted like passwords; a row can still be
  deleted, or rolled back together with its version, by someone who can write
  the database (the audit rows record the version used).

## 0032: Browser tools: `browser.*` tool RPCs (protocol 1.3) on playwright-core in box-agent

- Date: 2026-11-16
- Status: accepted
- Issue: #116 (narrows #93); design: `docs/research/browser.md` (#107)

### Context

M2 (PRD §6.2, §11.2) gives the agent the box's Chromium (decision 0026) as a
tool. Research #107 settled the observation model (an accessibility snapshot
with refs, screenshots on request), verified actions, the package
(`playwright-core` with `connectOverCDP`) and the tool shapes. Its spike also
found two traps: a ref from an older page waited out Playwright's whole action
timeout, and a covered or disabled target did the same.

### Decision

- **Protocol 1.3: `browser.*` methods are tool methods.** `browser.navigate`,
  `back`, `forward`, `snapshot`, `find`, `click`, `type`, `select`, `press`, `wait`, `screenshot`
  and `tabs` (`packages/protocol/src/browser.ts`) join `ToolParams` and
  `ToolResults`, so they reuse the tool RPC of 0011 unchanged: `rpc` frames,
  once-per-boot ids, per-call deadlines (`browserBudgetMs` plus the grace),
  trace context (0021) and error classification. Acting methods and `tabs`
  are mutating (never re-sent to a new boot, `give-up` when the outcome is
  unknown); observing ones are `retry`. New codes: `browser.unavailable`
  (box), `browser.no-tab`, `browser.bad-url`, `browser.stale-ref`,
  `browser.failed` (user). `browser.unavailable` also covers Chromium going
  away during a call (killed or restarted: the page's browser is
  disconnected when the call fails); the next call reconnects. A minor bump: a 1.2 box connects as before and
  answers a browser method `unknown-method`; the hub's tool turns that into
  "this box has no browser tools". A box-agent built without browser tools
  answers the same way.
- **box-agent: `playwright-core` 1.65.1, pinned exactly.** One lazy
  `connectOverCDP("http://127.0.0.1:${HEARTH_CDP_PORT}")` connection, dialled
  for up to `BROWSER_CONNECT_TIMEOUT_MS` while the port is closed (box start,
  supervisor restart). Its `disconnected` event drops it and the next call
  reconnects; `close()` only disconnects, the supervisor owns Chromium. No
  hand-written CDP. The browser code sits behind a CDP-free `BrowserDriver`
  interface (`apps/box-agent/src/browser/driver.ts`), so the rules below are
  unit-tested on a fake page model.
- **Snapshot generations, refs that name their snapshot.** Every snapshot
  (whole page, subtree, or the one behind `browser.find`) gets a new
  generation, unique in the process, and its refs are rewritten from
  Playwright's `e5` / `f1e5` to `s<generation>e5`. A tab keeps only its latest
  generation and its main-frame navigation count at that time. A ref whose
  generation is not some open tab's latest, or whose tab navigated since, is
  refused at once with the outcome `stale_ref`, before Playwright sees it.
  Encoding the generation in the ref, not only remembering the last ref set,
  is needed because Playwright reuses ref strings across snapshots: `e5` of an
  older snapshot can name a different element in the newer one.
- **Fail closed before acting.** Before dispatch the target is inspected: gone
  is `stale_ref`; hidden, disabled, not editable (`type`) or covered at its
  centre by another element (`click`, a hit test in the element's own root)
  is `not_actionable`. Nothing is dispatched, so these return in milliseconds
  instead of after the 10 s action timeout.
- **Verified actions, typed outcomes, snapshot last.** Acting calls take an
  optional `expect` (`urlIncludes`, `titleIncludes`, `textVisible`,
  `textGone`), polled every 100 ms for `expectTimeoutMs` (default 3 s, at most
  30 s). The result is `{ ok, outcome, message, verified, tab, url, title,
  dialogs, snapshot }` with `outcome` one of `done`, `not_verified`,
  `stale_ref`, `not_actionable`, `timeout`, `navigation_failed`; `ok` is
  false when `expect` did not hold. Every acting result carries the tab's
  fresh snapshot, so refs from before the action are stale afterwards.
  Changes from the research table: `navigation_blocked` is named
  `navigation_failed`, since the box cannot tell its firewall from other
  network errors; JavaScript dialogs are dismissed (an `alert` accepted) and
  listed in `dialogs` instead of being an outcome.
- **Snapshot cap.** Snapshot text in a result is at most
  `MAX_SNAPSHOT_TEXT_BYTES` (24 KiB), cut at a line end with a marker; the
  whole snapshot (up to 4 MiB) is written to
  `/workspace/.hearth/browser/s<generation>.txt` for `read`. The box writes
  that file on its own, so it goes through `openPlainFile` like the exec
  spill (0011): a symlinked `.hearth` or `browser` directory is refused, the
  file is opened `O_NOFOLLOW | O_NONBLOCK` (a FIFO there fails at once
  instead of blocking the serial call queue) and created 0600. A refused
  spill returns the cut snapshot with no path. `browser.find` returns only
  matching lines (default 20, at most 200); an invalid `regex` is
  `tool.bad-params`.
- **Back and forward.** `browser.back` and `browser.forward` move one entry
  in the tab's history. They are navigations: mutating, navigate's budget,
  every ref of the tab stale afterwards, the new page's snapshot in the
  result, `expect` checked. With no such entry the outcome is
  `navigation_failed` and nothing happens.
- **One call at a time per box.** Browser calls run in arrival order; a call
  whose budget ran out while queued never starts. The runner registers the
  tools as `sequential`.
- **Navigation scope.** `browser.navigate` and `tabs new` open `http`,
  `https` and `about:blank` only (`browser.bad-url` otherwise). This is not a
  boundary: any box command can drive CDP (0026); egress is the host firewall
  (0012).
- **Hub runner: `browser_*` pi custom tools** (`apps/hub/src/runner/browser-tools.ts`),
  registered by the `hearth-tools` extension and active in every session.
  Each call takes a box lease and calls `browser.*` through the tool RPC.
  Text results are a JSON header line and the snapshot inside a
  `<page-content>` block marked as untrusted page content. A page cannot
  leave the block: every `<page-content` or `</page-content` in page text
  (snapshot lines, find lines, and the title, URL and dialog text in the
  header), in any case and spacing, has its `<` written `&lt;`. An acting result
  that is not ok fails the tool call with the same text, so the trajectory
  counts `stale_ref` and `not_verified`. `browser_screenshot` returns the JPEG
  (quality 70, then 50, then 30; a full page falls back to the viewport; at
  most 1 MiB) as a pi image content part, with its sha256, size and
  dimensions in the text part; the trajectory step records the image count
  (0021). Storing the bytes by hash is #117.

### Consequences

- Not in this change: `browser_fill` with vault refs and redaction of filled
  values (#118), the screenshot mask (#118), the eval tasks B1-B6 (#119),
  approvals on `element` (M3), coordinate clicks, `browser_evaluate`.
- Until #117 the screenshot is kept only inside the `pi.tool_execution_end`
  event of the call, as base64, and only while that event fits
  `MAX_RUNNER_EVENT_BYTES` (1 MiB). A JPEG over about 768 KiB makes the
  event larger, and the event is then stored truncated (its first 4 KiB and
  its size): the image is not kept.
- The agent works in the same browser the owner sees. The desktop lock
  (0033) does not gate the browser tools yet; wiring `assertUnlocked` into
  them is #126.
- `playwright-core` follows Playwright's tested Chromium, while the box runs
  Debian's. The Docker e2e (`browser.docker.test.ts`, `box-provider` job)
  runs the tools against the real image, so a drift shows up in CI.

### Proof

- `packages/protocol/src/browser.test.ts`: methods, params and results, ref
  parsing, budgets, classification, and a 1.2 peer being compatible.
- `apps/box-agent/src/browser/tools.test.ts` (fake page model): generations,
  stale refs refused before dispatch (older snapshot, after an action, after
  a navigation, closed tab, foreign shape), the five pre-dispatch refusals,
  verification, the snapshot cap at exactly the limit and one byte over,
  find, screenshots, tabs, back and forward, error codes and call ordering.
  The spill uses the real writer on a temp root: a 0600 file in a new
  `.hearth/browser`, the 4 MiB cap, and no spill (nothing written outside,
  no hang) through a symlinked `.hearth`, `.hearth/browser` or file, or a
  FIFO at the path.
- `apps/box-agent/src/browser/playwright.test.ts`: the same tools on
  `playwright-core` against a real headless Chromium over CDP (CI `web-e2e`
  job): type, select and click verified, disabled and covered targets refused
  fast, a stale ref after navigation and after the page navigates by itself,
  dialogs settled and reported, back and forward, a refused connection as
  `navigation_failed`, an element screenshot, Chromium killed mid-call as
  `browser.unavailable`, and a reconnect after the browser restarts; without a browser, `browser.unavailable` after the dial
  timeout.
- `apps/hub/src/box/tool-rpc.test.ts`: a real hub and box-agent; a 1.2
  box-agent answers `unknown-method`, a 1.3 one answers snapshot, click and a
  stale ref.
- `apps/hub/src/runner/browser-tools.test.ts` and
  `browser-tools.chromium.test.ts` (real Chromium): one `<page-content>`
  block per result even when the page writes `</page-content> SYSTEM: ...`;
  the dialogs header; find wrapping; every tool `sequential`.
- `apps/hub/src/runner/runner.test.ts`: the faux model reads a ref off a
  snapshot and clicks it; image results; failed outcomes as tool errors; the
  older-box message.
- `apps/hub/src/runner/browser.docker.test.ts` (CI `box-provider` job): the
  real box image, a fixture page served inside the box, type, select and a
  verified click by ref, a screenshot, and the submitted values in the box
  server's log.

## 0033: Desktop takeover: a hub-side lock lease per session gates the RFB input filter

- Date: 2026-11-16
- Status: accepted
- Issue: #120
- Builds on 0016 (the view-only filter); PRD §8.3, §11.2.

### Context

M1 showed the box desktop view-only: the hub's RFB filter dropped every key
and pointer message (0016). M2 lets the owner take the desktop over (PRD
§11.2): the desktop view accepts their mouse and keyboard while they hold the
desktop lock, and the agent's desktop and browser input tools answer "user is
in control" until they release it. PRD §8.3 leaves open where the lock lives,
how long a lease lasts and what releases it.

### Decision

- **The lock is hub state, one per session, in memory** (`apps/hub/src/desktop/lock.ts`).
  A holder is `{ kind, principalId }`; kinds are `person`, `agent` and
  `automation` (PRD §8.3), and only `person` acquires it today. First come,
  first served: a lock someone else holds is refused with `desktop.locked`
  (409). A hub restart drops every lock, which is the safe side: input stops.
- **A lease of 60 s (`DESKTOP_LOCK_TTL_MS`), renewed by interacting.** Each key
  or pointer message the relay passes for the holder renews it; taking a lock
  one already holds renews it too. A lease nobody renews is treated as free
  the moment it lapses (every check compares the clock, so it never counts as
  held past `expiresAt`), and a timer records the expiry. The box is not told
  about the lock: the hub filters input before the box sees it, so there is
  no box-side grant to expire early (§8.3's "the box stops trusting its grant"
  applies once a box-side grant exists).
- **The filter asks the lock per message.** `RfbInputFilter` (renamed from
  `ViewOnlyFilter`) takes an `allowInput` gate; the bridge passes
  `locks.allowsInput(sessionId, viewer principal)`. At each complete
  `KeyEvent` and `PointerEvent` the gate decides; anything else of 0016's drop
  list (`ClientCutText`, `SetDesktopSize`, QEMU key events, continuous
  updates, fences) stays dropped whoever holds the lock. A release or lapse
  stops input at the next message. Every viewer of the holder's principal
  passes input; viewers of other principals stay view-only.
- **What releases it:** `POST /v1/sessions/:id/desktop/lock/release`; the
  holder's last open viewer of the session closing (the tab closed, the box
  went to sleep, the login was revoked), checked when any viewer closes; and
  the lease lapsing.
- **API**, behind the login and request guards like every route:
  `GET /v1/sessions/:id/desktop/lock` (`desktop.view`),
  `POST /v1/sessions/:id/desktop/lock` (take over, `desktop.control`) and
  `POST /v1/sessions/:id/desktop/lock/release` (`desktop.control`). Each
  answers `{ ok, lock: { held, mine, holder, expiresAt } }`. Each authorizes
  against the session's workspace (0022) before it reads anything, so an
  unknown id and another workspace's id get the same answer (#85, #90, #94);
  the request body is never read. An archived or failed session cannot be
  taken over (409 `session.unavailable`).
- **Recorded before it acts.** `authorize` writes the audit row of each API
  call. Every lock change is also a `desktop.lock` event in the session's log
  (`action`: `acquired`, `released`, `viewer-left`, `expired`; the holder),
  appended before the lock changes; an acquire whose event cannot be written
  grants nothing (PRD §10). Implicit releases (viewer left, expiry) are not
  API calls and are not authorized; their event records them.
- **The agent's check.** `hub.desktopLocks.isDesktopLocked(sessionId)` and
  `assertUnlocked(sessionId)` (throws `desktop.locked`, message
  `user is in control`) are the API the runner's desktop and browser tools
  call before they act (docs/runner.md). No such tool exists on main yet;
  #116 (or a follow-up) wires the refusal into the `browser_*` tools.
- **Web UI.** Over the open desktop the panel shows a control bar with a
  badge, a line of status and a **Take over** or **Release** button (shadcn
  `Button`, `Badge`). noVNC stays `viewOnly` unless the lock is the user's;
  the bar re-reads the lock every 3 s, so a lapsed lease turns the view back
  to view-only. The bar sits outside the `Desktop` region, which keeps its
  stable names (`Open desktop`, `Wake`, `Reconnect`).

### Consequences

- A person who leaves the desktop untouched for 60 s loses control and must
  click Take over again; the agent's tools are blocked for at most that long
  after a tab is abandoned without closing.
- Keys or buttons held down when the lock ends are not released on the box: the
  filter drops the matching key-up. Clicking Release with the mouse does not hit
  this.
- Clipboard paste into the box (`ClientCutText`) stays dropped; it is a
  follow-up if needed.
- The agent cannot hold the lock yet (no queue, no paused turn clocks, PRD
  §8.3); that comes with the browser tools.
- Proof: unit tests of the gate (`rfb.test.ts`), the lease and its timer
  (`lock.test.ts`), the bridge on the real call path (`bridge.test.ts`), the
  routes' same answers (`session-existence.test.ts`, `principal.test.ts`), the
  panel in a DOM (`web.dom.tsx`); web-e2e types through noVNC into the fake
  desktop only while holding the lock; compose-e2e types a URL into the box
  Chromium's address bar through noVNC, checks the page over CDP and on the
  canvas, then after Release a hand-written RFB client's key events no longer
  reach the browser.

## 0034: The public listener caps request bodies at 1 MiB, checked before every guard

- Date: 2026-11-16
- Status: accepted
- Issue: #105

### Context

Request bodies are read only after `authorize` (0029), but a signed-in caller
could still send a huge JSON body and have it parsed into memory. Bun's own
`maxRequestBodySize` answers an oversized `Content-Length` with a bare 413
before `fetch` runs, with no JSON envelope.

### Decision

- The public listener refuses a body whose `Content-Length` is over
  `maxBodyBytes` (default `DEFAULT_MAX_BODY_BYTES`, 1 MiB; a prompt plus labels
  is a few KiB) with 413 and the JSON error envelope, code
  `request.body-too-large`. Bun answers most malformed `Content-Length` values
  with its own bare 400 before the hub runs; repeated equal headers reach the
  hub joined by a comma and get the same JSON 413. Every 411/413 carries
  `connection: close`, so Bun closes the socket instead of draining the
  declared body.
- A request with `Transfer-Encoding` (a body of unknown length) gets 411,
  `request.length-required`. Browsers send a length for the UI's JSON bodies.
- The check reads headers only and runs first in the public `fetch`, before the
  request guard (0010), the session guard (0014) and `authorize`. An
  unauthenticated oversized request therefore gets 413, as a signed-in one
  does, and the answer reveals nothing the caller did not send. It applies to
  every public path, `/healthz` included.
- Bun's `maxRequestBodySize` on the public listener is raised to its maximum
  so Bun does not answer first. The box listener and the desktop WebSocket are
  not touched; the limit is an option, not an environment variable.

### Alternatives rejected

- Bun's `maxRequestBodySize` alone: the answer is not the JSON envelope.
- Counting streamed chunks: more code for a case no client of the hub needs.

### Consequences

A client that streams a body without a length is refused with 411.

## 0035: Browser tools refuse at once while the owner holds the desktop lock

- Date: 2026-11-16
- Status: accepted
- Issue: #126
- Wires 0033 (the lock) into 0032 (the browser tools); PRD §8.3, §11.2.

### Context

0033 gave the hub a desktop lock and a check for the agent's tools
(`assertUnlocked`), and 0032 gave the agent `browser_*` tools on the box's
Chromium. Neither wired one into the other, so the agent could still click and
type in the browser the owner had taken over. PRD §11.2 says the agent's
browser and desktop input tools answer "user is in control" while the owner
holds the lock. The choice left open: refuse at once, or wait for the lock
with a short bound.

### Decision

- **Every `browser_*` tool checks the lock first**, before it takes a box
  lease: a refused call neither starts nor wakes the box and sends nothing to
  it. The runners get the hub's `DesktopLocks` (`SessionRunnersOptions.desktopLocks`,
  set by `startHub`) and each session's `RunnerBox.assertDesktopUnlocked`
  calls `assertUnlocked(sessionId)`.
- **All twelve tools refuse, the read-only ones too** (`browser_snapshot`,
  `browser_find`, `browser_screenshot`, `browser_tabs` list). One rule is
  easier for the model to follow than a list, a snapshot or tab switch drives
  the same page the owner is using, and the owner's page while they work on
  it is theirs. This narrows the "read-only tools may keep working" note of
  docs/runner.md.
- **Refuse at once, no wait.** The tool call fails with
  `DESKTOP_LOCKED_MESSAGE`: `desktop.locked: user is in control.` and that
  nothing was sent, wait and try again later, or ask the user. The model can
  retry, tell the owner or do other work; a hidden wait would hold the turn
  (and its box lease) for up to the 60 s lease while the owner may be gone
  for longer, and PRD §8.3's paused turn clocks for an agent waiting on the
  lock do not exist yet.
- **The trajectory records the refusal.** The tool call's `runner.step` has
  `outcome: "desktop-locked"` (a new value next to 0021's `ok`, `error`,
  `aborted`, `timeout`, `denied`, `outcome-unknown`; added values do not bump
  the schema), `refused_code: "desktop.locked"` and no RPCs, and the
  summary counts it under `tool_failures_by_class["desktop-locked"]`. A
  refusal at the first check has no box (`box_id: null`); one at the second
  check (after the wake, see Consequences) records the woken box's `box_id`
  and `box_wait_ms`.
- Any other error of the check is not a refusal: it is rethrown as is.

### Alternatives rejected

- Wait for the release with a bound of a few seconds: a person who took over
  rarely gives the desktop back that fast, so it mostly adds latency before
  the same refusal, while holding a lease.
- Refuse only the acting tools: see above; it can be revisited when the agent
  can hold the lock itself (PRD §8.3 queue).

### Consequences

- While the owner holds the desktop the agent cannot even look at the page;
  it has to ask or wait.
- The check runs twice: before the box lease, and again after `ensureBox` and
  `prepare`, just before the RPC (#133). A cold box wake can take seconds, and
  an owner who takes over meanwhile is refused the same way (same message, same
  trajectory step, lease released). The remaining window is the RPC itself: a
  call already sent when the owner takes over still reaches the page.
- Proof: unit tests of the check in every tool (`browser-tools.test.ts`), the
  real `startHub` wiring and trajectory step (`browser-lock.test.ts`), and a
  compose-e2e step: Take over, an agent `browser_tabs` call is refused with
  `desktop.locked`, Release, the same call works in the box's Chromium.

## 0036: Live shell output: `tool.exec` names a stream (protocol 1.4), the hub stores redacted `tool.output` events

- Date: 2026-11-16
- Status: accepted
- Issue: #121

### Context

A `bash` call showed nothing until it ended (0011: exec answers once). PRD
§8.2.1 left live output for a protocol minor bump after the prototype.

### Decision

- **Existing stream frames, one new param (protocol 1.4).** The hub adds
  `outputStream` to `tool.exec`; the box sends the merged stdout and stderr as
  `stream.data` on that id while the command runs, then `stream.close`
  (`done`), both before the `rpc.result`. No new frame type and no
  `stream.open` (the `rpc` opens it). A 1.3 box drops the param and answers
  once. A new `stream.open` kind was not chosen: it changes the codec for no
  gain, and the call already names everything the stream needs.
- **Stream ids.** Live output ids are even (the hub picks them, 0002) with the
  top bit set (2^31 and up); the desktop bridge's ids now wrap below 2^31, so
  the two never meet on one box. The decoder refuses any other id.
- **The result stays the answer.** The stream is lossy (fire-and-forget,
  dropped under backpressure, capped). pi's `onData` still gets the result
  once, so the tool result, the trajectory and the spill file (0011) are
  unchanged. The web drops a call's live output when its result arrives.
- **Box side.** `LiveOutputSender` coalesces reads (one frame per 100 ms, or
  at once at 16 KiB), caps a command at 64 KiB, and drops waiting bytes
  when the hub socket's backlog is over 256 KiB, so a slow hub never makes
  box-agent buffer. A hub `stream.close` stops the stream; the command runs
  on.
- **Hub side.** `ToolRpcClient` routes the stream's frames (that box, that id,
  while the call runs) to a callback, synchronously, in frame order.
  `LiveToolOutput` (`apps/hub/src/runner/live-output.ts`) turns the bytes into
  `tool.output` events, `{toolCallId, seq, text, truncated?}` with the turn
  id:
  - **Redacted with the runner's redactor**, the one tool results and every
    stored payload go through. A secret can arrive split over chunks, so
    text is emitted only up to a line break, or, for a line over 4 KiB, up to
    1 KiB before its end. That cut then moves back past any tail that could
    be the start of a secret: a proper prefix of one, raw or JSON-escaped,
    whatever its length and whatever line breaks it holds (`secretStart` in
    `runner.ts`, from the same secret list as the redactor; the values never
    leave it). Last, a cut is taken only where redacting the part alone gives
    the same text as redacting it with what follows (secrets that overlap).
    The held-back tail waits for more output and is dropped when the call
    ends or hits the cap.
  - **The box is told to stop.** Once the hub takes no more of a call's
    output (its cap, or a failed append), it sends `stream.close` for that
    stream, and the box stops streaming the command; the call goes on.
  - **Capped** at 64 KiB per call, then one event with `truncated: true`.
  - **Rate limited, with backpressure:** at most one append per 250 ms per
    call and never two at once. Output that arrives while an append waits on
    the store joins the next event, so a slow store makes events fewer and
    larger; the box connection's frame handling never waits on the store.
    A failed append stops that call's live output and is logged; the call
    and the runner go on.
- **Web.** `hearthPi.ts` keeps live output per running call (the last 64 KiB)
  and drops it at `tool_execution_end` or `agent_end`; a chunk for a call
  that has ended is ignored. The tool card shows it in a `role="log"` block
  named `Live output of <tool>` outside its collapsed details, while the call
  runs. The trigger keeps its name (`Tool call bash: running`, then
  `done`). Plain React and Tailwind; no inline styles or scripts, so the CSP
  (0017) is unchanged.

### Consequences

- No part of a registered secret is shown while it is still arriving, at
  any length and across line breaks. The cost: output that stops at what
  could be a secret's start (a long line whose last characters are `sk-` when
  a key starts so, or a line that is a registered PEM's first line) waits for
  what follows, or shows only in the result. Text that is not a
  registered secret (one the command makes up) is not redacted here, as in
  the result.
- Output with no line break for less than 4 KiB (a prompt, a progress bar
  without `\r`) shows only when the call ends.
- The trajectory ignores `tool.output`: the tool call's result is its record.
- Each running call adds at most four events a second to the session log.

## 0037: Content-addressed blob store for images; trajectories reference screenshots by hash (amends 0021)

- Date: 2026-11-16
- Status: accepted
- Issue: #117 (follows 0032's "Storing the bytes by hash is #117")

### Context

`browser_screenshot` (0032) returns a JPEG of up to 1 MiB to the model as a pi
image part. The runner recorded every pi event with that part inside, as
base64: in `pi.tool_execution_end`, in the tool result message's
`pi.message_start` and `pi.message_end`, and in the `runner.entry` a rebuild
reads back. Each copy counted against `MAX_RUNNER_EVENT_BYTES` (1 MiB), so a
screenshot over about 768 KiB made those events truncated and the image was
lost, while a smaller one was stored four times and replayed to every client
reading the event log (0006 already said bulk bytes need a separate store).
The trajectory (0021) recorded only `images: 1`.

### Decision

- **A hub `BlobStore`, in the hub's SQLite database** (`@hearth/core`
  `BlobStore`, `apps/hub/src/store/blob-store.ts`, migration
  `content-addressed blobs and their sessions`). Table `blob` holds each
  distinct content once, keyed by the lowercase hex SHA-256 of its bytes (a
  `CHECK` refuses any other key), with its size and media type; table
  `session_blob` records which sessions put it, keyed by
  `(workspace_id, session_id, sha256)`. Both refuse `UPDATE` by trigger.
  - **Why SQLite and not files under the data volume:** the bytes then share
    the database's durability (`synchronous = FULL`, 0006), its backup (one
    file on the one volume), its transactions (the blob and its session link
    commit together) and the boundary rule that only `apps/hub/src/store`
    touches storage. There is no file path built from input, so no traversal,
    no temp-file-and-rename, no orphan files after a crash, and the session
    scope is one join. The cost is database size: screenshots are at most
    1 MiB, which SQLite stores well as BLOBs. If the volume of blobs ever
    outgrows that, the `BlobStore` interface lets a file or object-store
    implementation replace this one.
- **Write once, idempotently, with a cap.** `put` hashes the bytes itself
  and inserts with `ON CONFLICT DO NOTHING`, so the same bytes, from any
  number of events or sessions, are one row. Blobs over `MAX_BLOB_BYTES`
  (4 MiB, the event payload cap of 0006) are refused (`blob.too-large`); the
  runner does not try to store them (below).
- **The media type is sniffed from the bytes** (JPEG, PNG, GIF, WebP magic
  numbers, else `application/octet-stream`), never taken from the tool's
  claim, so a blob can never be served as HTML or script.
- **Events keep a reference, not the bytes.** When the runner records an
  event, each image part in a `content` array (a message's or a tool
  result's) becomes `{type: "image", mimeType, blob: {sha256, size, mime}}`,
  plus `omitted: "too-large"` over the cap. The bytes are put in the store
  in the event chain, before the event that names them is appended, so an
  event never refers to a blob that is not stored; a failed put fails the
  runner like a failed append (0015). Only `content` arrays are rewritten: an
  image-shaped object in tool arguments is kept as the model sent it.
- **The model still gets the image.** Only what is recorded changes; pi's
  in-memory session keeps the base64. A runner rebuilt from the event log
  after a hub restart (0015) reads each referenced image back from the store
  and puts it back in the session in pi's own shape, so the model sees the
  same messages; an image that is not in the store (over the cap, or a hub
  without a store) comes back as a text part naming its hash and why, never
  as an image part without data.
- **Trajectory, amending 0021.** A `tool_call` record's `result` keeps
  `images` (the count) and adds `image_blobs: [{sha256, size, mime,
  omitted?}]`, one per image, in order. An added field: the schema stays
  `hearth.trajectory/2`. No base64 is in a trajectory record.
- **API.** `GET /v1/sessions/:id/blobs/:sha256`, behind the login guard like
  every `/v1` route, authorizes `session.blob` against the session's
  workspace before it reads anything (0022), then checks the session exists
  (`session.not-found`, as every session route). Then the blob is looked up
  only through that session's `session_blob` rows: a malformed hash, a
  traversal attempt, an unknown hash and another session's hash all get the
  same 404 `blob.not-found` (the same-answer rule of #85, #90, #94). The
  answer has the sniffed `content-type`, `x-content-type-options: nosniff`,
  `content-security-policy: default-src 'none'; sandbox`,
  `cache-control: private, no-store` and `content-disposition: inline` for
  an image, `attachment` otherwise, named `<sha256>.<ext>`.
- **CLI.** `bun apps/hub/src/trajectory-cli.ts [--db PATH] --export-blobs DIR
  <session-id>` also writes each blob of the session to `DIR` as
  `<sha256>.<ext>` (0600, the directory 0700 when created), the names the
  trajectory's `image_blobs` give. Names come from the store's validated
  hashes, never from event text. The blobs are written after the dump, so a dump
  the vault refuses (0031) writes none.

### Consequences

- **Retention follows the session.** A blob is kept while a session refers
  to it; no blob or link is deleted yet. Deleting a session's data with a
  retention policy is #83's; it will drop that session's `session_blob` rows
  and then any `blob` no session refers to, under a new decision.
- **Blobs are not text-redacted.** The redaction of 0015 and 0021 works on
  text; a screenshot can show a secret on the page. Screenshots are to be
  masked at capture, in the box, before they leave it (#118, vault follow-up);
  until then a blob holds what the page showed, like the model's own view.
- 0032's consequence that a screenshot over about 768 KiB is lost from the
  event log no longer holds: the events now carry only the reference.
- Events recorded before this change keep their base64 (the log is
  append-only, 0006); their trajectory has `images` without `image_blobs`.
- The compose install's faux model declares image input
  (`"input": ["text", "image"]`), so pi sends it the screenshot and the e2e
  can check the model got the bytes the blob API serves.
- Proof: `store/blob-store.test.ts` (write, read, dedup, list, another
  session or workspace, malformed hashes, the cap at exactly the limit and
  one byte over, immutability, sniffing); `obs/blobs.test.ts` (the replacer,
  the cap and `content`-only rewriting, the rebuild helper, the route's
  headers, the same answer for unknown, other-session, malformed and
  traversing hashes, `session.blob` authorized first and audited, 401
  without login, the CLI export); `runner/runner.test.ts` (the model gets
  the image while no event holds its base64, dedup across two calls, each
  blob stored before the first event naming it, a failed put fails the
  runner, a rebuilt runner gets the image back, a missing blob becomes
  text, `image_blobs` in the step and the trajectory);
  `session-existence.test.ts` and `principal.test.ts` (the blob route
  under the same-answer and principal rules); the compose e2e
  (`deploy/e2e/prototype.ts` step 5f: a real screenshot reaches the faux
  model, the trajectory and event log name it and hold no base64, the blob
  API serves its bytes, and again after the upgrade).

## 0038: Model settings on the Settings page: a `vault:` key, env wins, switched per turn

- Date: 2026-11-17
- Status: accepted
- Issue: #115 (design: research #108, `docs/research/vault.md`; vault core 0031)

### Context

The model, its provider and the key reference are `HEARTH_MODEL*` lines in
`deploy/.env` and a key file (0020). PRD §6.10 (P0, M2) moves them to the web
UI, with the key in the vault (0031); the research settled the API, the
precedence and the first-start import. This entry records what M2 implements
and where it deviates.

### Decision

- **Storage.** Migration 8 adds `setting(workspace_id, key, value_json,
  updated_at)`; `model` holds `{provider, model, keyRef}`. Migration 8 follows
  the blob store's 7 (0037).
- **API.** `GET /v1/settings/model` answers `{source, provider, model, keyRef,
  keyFingerprint, updatedAt}`; `PUT /v1/settings/model {provider, model,
  keyRef}`. Both authorize first (`settings.read`, `settings.model.update`) and
  the PUT reads its body after. No route returns a value.
- **Env wins.** While `HEARTH_MODEL` is set, `source` is `env`, the page is
  read-only and a PUT answers 409 `settings.env-locked`. Existing installs and
  tests run as before; the owner unlocks the page by emptying the lines.
- **A saved key is `vault:<name>` of a global `model-key` entry, or none**
  (a local endpoint). `env:` and `file:` references are refused on the PUT
  (deviation: the research let the page take any reference). A browser
  session that could save `file:/any/path` as the model key would send that
  file to the provider's endpoint; `env:` / `file:` keep working through
  `HEARTH_MODEL_KEY_REF` for headless installs. A model pi does not know
  (built-in or `HEARTH_MODELS_FILE`) is `settings.unknown-model` (400).
- **Audited, logged, applied.** A save writes `settings.model.update` (new
  provider, model, key reference and fingerprint; the previous choice) before
  it is stored, logs `settings: model set to …` with the fingerprint, and calls
  `SessionRunners.setModel`. If the audit write fails nothing is stored or
  applied. Adding, rotating and deleting a secret now also log one line
  (`vault: secret <name> added|rotated|deleted`, with fingerprints) next to the
  `secret.*` audit rows 0031 already writes.
- **Runtime switch.** `setModel` drops the cached `ModelRuntime`; the next
  runtime resolves the new key (one audited `secret.use`). A session's runner
  made under an older choice is rebuilt from the event log on its next message
  if it is idle; a running turn keeps the model and key it started with. Old
  keys stay in the redaction set. Rotating or deleting the `vault:` entry the
  model uses does the same (`HubVault` `onValueChange`), so 0031's "takes
  effect when the model runtime restarts" now means the next turn, not a hub
  restart.
- **Always a runner.** The hub now builds its runners without `HEARTH_MODEL`;
  until a model is saved, a message fails with `runner.no-model` (409) instead
  of the message routes being absent. A message sent while the settings load
  at start waits for them.
- **First-start import.** Once the vault is enabled, with no saved `model`
  setting and an env choice whose key is an `env:` or `file:` reference, the
  hub copies the key into the vault as `model-key-<provider>` (meta label
  `imported from <ref>`), saves `{provider, model, keyRef:
  "vault:model-key-<provider>"}` (`settings.model.import`, system principal,
  with the fingerprint) and logs one line. Env still wins until it is emptied.
  A taken name, a disabled vault or an unresolvable key skips the import with a
  log line; it is retried at the next start.
- **UI.** `#/settings` (its own lazy chunk), linked from the header: a vault
  Alert when it is off, the model card (provider and model inputs, key select
  of global model keys with their fingerprints) and the secrets table (name,
  origins, kind, scope, fingerprint and version, last use; Rotate in a Dialog,
  Delete behind a confirm Dialog in the `alertdialog` role; Add in a Dialog).
  Value fields are `type="password"` with `autoComplete="off"`; they are
  cleared after a save and dropped when the dialog closes. shadcn `table` and
  `native-select` were added with the shadcn CLI (0019).
- **CSP unchanged (0017, 0019).** Radix's scroll lock injects a `<style>`,
  which `style-src 'self'` blocks: the dialogs are non-modal
  (`modal={false}`; the Delete confirm is a Dialog, since Radix's AlertDialog
  is always modal, and ignores clicks outside it), and the selects are native
  `<select>`s (shadcn `native-select`; Radix Select always locks scrolling).
  The web e2e opens every dialog and select on `#/settings` (add a model key,
  save the model with it, rotate it, delete a secret) and fails on any
  violation.
- **No key value read back.** `GET /v1/settings/model` shows the key
  reference as `displayRef` does, so a value pasted into
  `HEARTH_MODEL_KEY_REF` (or a token-shaped `env:` name) appears only as a
  fingerprint.

### Not in this change (follow-ups)

- A model Select fed by pi's catalog and a "Test connection" button
  (`POST /v1/settings/model/test`).
- The uses Sheet (`GET /v1/secrets/:id/uses` exists), editing name, scope or
  origins (`PATCH /v1/secrets/:id`), session-scoped entries and token hosts in
  the add dialog, and `POST /v1/vault/rotate-key`.
- Dropping the `model_key` compose secret and `HEARTH_MODEL_KEY_REF` from
  `compose.yaml` (research "Migration", step 4), so a fresh install needs no
  key file at all.

### Consequences

- An upgrade needs no manual step: the key is imported and the page shows the
  env's choice read-only until the owner empties the `.env` lines.
- The settings live in the database: a database restore restores them, and a
  lost vault key leaves a saved `vault:` key unresolvable (`vault.disabled`)
  until the key file is restored.
- A rebuilt runner reads its session's event log again; that happens once per
  session after each model change, not per turn.

## 0039: `browser_fill` with vault refs: origin bound twice, value scrubbed, filled fields masked (protocol 1.5)

- Date: 2026-11-17
- Status: accepted
- Issue: #118

### Context

The browser tools (0032) type only text the model gives. Signing in needs a
password the model must never see. The vault (0031) already has the hook:
`HubVault.use` hands out a login only on an origin its policy names, audits
the use first and registers the value for redaction. The browser research
(`docs/research/browser.md` §5) found the aria snapshot prints a password
field's value, and left screenshots unmasked.

### Decision

- **Tool.** `browser_fill({ref, element, secret, submit?, expect?})`. `secret`
  is a `vault:<name>#field` reference; anything else is refused without being
  echoed, before a lease.
- **Two RPCs (protocol 1.5).** `browser.field` returns the field's kind and the
  origin of the frame that owns it, from the URL the browser committed for
  that frame (not page script). The hub passes that origin to `HubVault.use`
  (kinds: `login`, scoped to the session), so a page on another origin, or a
  login field in a foreign iframe, is refused before the value is decrypted
  or sent. Only then does `browser.fill` carry the value, the policy's
  origins and the accepted field kinds; the box checks origin and kind again
  on the owner frame just before it fills.
- **Field kinds.** `password` (`input type=password`), `username`
  (`autocomplete=username` or `email`, `input type=email`), `one-time-code`
  (`autocomplete=one-time-code`), `other`, `none`. `#password` goes only into
  a password field and `#username` only into a username field
  (`browser.field-mismatch` otherwise), unless the entry sets
  `allow_any_field`, which allows any text field but never a non-field.
- **Never echoed.** The box keeps every filled value for the life of the
  process and replaces it (`[redacted]`) in every later result string, error
  and spilled snapshot. The hub adds it to the session's set before it sends
  it, scrubs the fill result and error, and scrubs the text of every later
  tool result of the session, whatever the tool, before the model reads it.
  The vault's registration (0031) covers events, logs and the trajectory.
  Every scrub (box, hub, vault, model key, live output) is the shared
  `redactValues`/`secretStart` of `@hearth/core`, which matches each value in
  these text forms only: raw, JSON-escaped, and URL-encoded
  (`encodeURIComponent`, form-urlencoded with `+` for a space as a GET form
  submit writes it, and `encodeURI`), with `%XX` hex in either case. A GET
  form that carries the value into the URL is therefore scrubbed in the fill
  result, `browser.tabs` and snapshots.
- **Masks.** The box marks the element before the fill: a
  `data-hearth-mask` attribute with a fresh token, and an element handle it
  keeps. Every screenshot masks each element with the attribute in every
  frame (a page restored from the back-forward cache included), and first
  checks each kept handle. A handle whose document is gone (navigation, a
  closed frame) is dropped. An element that left a loaded document, or lost
  its token, refuses the screenshot with `browser.mask-missing`.
- **Errors.** `browser.origin-mismatch`, `browser.field-mismatch`,
  `browser.mask-missing`: owner `user`, `give-up`. A 1.4 box answers the new
  methods `unknown-method`; the tool says the box is too old.

### Consequences

- Known limit of "never echoed": string scrubbing finds only the forms
  above. A page that transforms the value (base64, a hash, another encoding
  or charset, a substring) and shows it gets it to the model unscrubbed, and
  a page that draws the value outside the filled field (a "hello
  <username>" heading, a canvas) shows it in screenshot pixels, since only
  the filled elements are masked. Neither is caught; a page under the owner's
  allowed origins is trusted not to do this.
- The value enters the box's Chromium and nothing else the model reads. Any
  box command can still read it over CDP (0026: CDP has no auth): the box is
  the trust domain the owner accepted, as the research says.
- A single-page app that drops the filled form without navigating refuses
  screenshots of that tab until it navigates. Fail closed, by design.
- The audit records a hand-out to the tool even when the hub then refuses
  the field kind (`allow_any_field` is read from the authenticated row only).
- Screenshots go to the blob store (0037) after capture; masking happens at
  capture, so stored screenshots are masked.

## 0040: Browser eval B1-B6: a fixture site in the box, scripted faux runs, a scorer that reads only the trajectory

- Date: 2026-11-17
- Status: accepted
- Issue: #119

### Context

The browser research (`docs/research/browser.md` §7) names six fixture tasks
and a score per run, and PRD §11.2 makes S2 an exit criterion: sign in with a
vault login, fill a form, check the result on the server side, and find the
password in no event, trajectory line, log line or model request. It leaves
open where the fixture site runs, how a checker sees the server's record, and
how the eval runs in CI without a model key.

### Decision

- **Fixture site.** `apps/hub/src/eval/fixtures/browser-fixtures.py`, Python's
  standard library only (the box image has `python3`), served on the box's
  own `127.0.0.1`, so the box firewall (0012) needs no exception. It gets only
  the sha256 of the login, so neither the script nor the command that starts
  it holds a value. Every page ends with the server's own record of the task
  ("Server record: successful logins 1, ..."), so the server's view reaches
  the trajectory through the page text the box returns.
- **Tasks.** One session, one turn per task, each prompt starting with its
  id (`B1: ...`), after a setup turn that writes and starts the site. B1 also
  carries the show-password check: after `browser_fill`, a click turns the
  field to plain text, and an element screenshot of the field must have the
  same sha256 as one of a black box of the same size at a whole-pixel
  position (the mask of 0039). B6 has no approval to wait for before M3, so
  passing means stopping before the click.
- **Scorer.** `apps/hub/src/eval/browser-score.ts` reads the JSONL that
  `trajectory-cli.ts` dumps and decides each task from tool results only:
  `ok`/`verified`/`outcome` headers, URLs, page text, screenshot hashes, and
  which snapshot line a ref came from. The model's last words count only to
  report a false success. It reports per task success, false success, tool
  and model calls, tokens, cost, wall time, and the `stale_ref`,
  `not_verified` and `timeout` counts.
- **Leaks.** The scorer searches the dump, the exported blobs (names and
  bytes) and any logs given for each vault value in the redactor's forms
  (raw, JSON-escaped, URL-encoded) plus base64, base64url and hex. The e2e
  dumps without the vault key (`--unredacted-ok`), so the dump is what the
  database holds, and adds the hub's log, every stored event and every model
  request. One hit fails the run.
- **Runs.** `browser-eval.e2e.test.ts` scripts the tool calls with pi-ai's
  faux model, reading refs off the latest snapshot as a model would. CI runs
  it in `box-provider` on the real image under the firewall
  (`HEARTH_DOCKER_TESTS=1`) and in `web-e2e` with box-agent as a local
  process on Playwright's headless shell (`HEARTH_CHROMIUM`); the JSONL,
  blobs and report of the Docker run are kept as an artifact.

### Consequences

- The first Docker run failed B3: the box's Chromium restored the filtered
  list from the back-forward cache on Back, which fires no load event, so
  `browser_back` timed out after 30 s, and the restored page's refs no longer
  resolved (`Invalid frame in aria-ref selector`). The box entrypoint now
  starts Chromium with `--disable-back-forward-cache`, as Playwright does
  for the browsers it launches, so Back loads the page again. The fixture
  pages are `no-store` too, which was not enough on its own.
- The scorer does not depend on the script: a real model's run of the same
  prompts scores the same way. That mode (5 runs per model, median and worst,
  as §7 asks) is not built yet; the setup turn is scripted today.
- The trajectory redacts `"secret": "vault:..."` as a credential shape, so
  the scorer tells which field a fill went to from the ref's snapshot line,
  not from the reference.
- The hub's credential-shape redaction can cut a JSON escape in half when it
  runs over a dumped JSONL line (a `token = sha(f"...` in tool arguments
  broke the line), so the fixture script avoids such text. The fix of the
  redaction is #144.

## 0041: `bash` env with `box-env` vault tokens: one command, refused before decrypt, scrubbed (protocol 1.6)

- Date: 2026-11-17
- Status: accepted
- Issue: #130

### Context

CLI tools in the box (`gh`, `npm`, `aws`) read a token from the environment.
The vault (0031) already has the policy field for it, `use: hub | box-env`,
and the research (`docs/research/vault.md`, "API tokens for tools") says a
`box-env` token may enter the box only inside the one exec RPC that uses it,
with its output redacted. Until now `tool.exec` had no `env` at all (PRD
§8.2.1: the hub's environment never reaches the box), and only the hub's own
SecretStore read tokens, refusing `box-env` ones.

### Decision

- **Opt-in per entry, by the owner.** A `token` entry is usable by box
  commands only with `use: box-env`, set when it is added
  (`POST /v1/secrets`) or rotated (`PUT /v1/secrets/:id/value {fields,
  use?}`, token only; the new policy is bound into the new ciphertext's AAD
  and named in the `secret.rotate` audit row). Default stays `hub`. The
  Settings page has a "Usable by box commands" switch on both forms, shown
  only for a token, with the badge "visible to commands in the box" (also in
  the table). shadcn's Switch on `radix-ui`; no portal, no scroll lock, so CSP
  stays as 0038 left it.
- **Tool.** `bash` takes an optional `env: { NAME: "vault:<name>" }` (at most 8).
  Each name must match `^[A-Z][A-Z0-9_]*$` and not be a name the shell, the
  linker, an interpreter or the box uses (`PATH`, `HOME`, `IFS`, `ENV`,
  `NODE_OPTIONS`, …) or start with `LD_`, `DYLD_`, `BASH_`, `LC_`, `GIT_`,
  `XDG_`, `HEARTH_` (`execEnvNameProblem`, shared by hub and box). A value
  must be a `vault:` reference; anything else is refused without being echoed.
  These checks run before a box lease.
- **Order in the hub.** Lease, then the box's protocol version (a 1.5 box
  drops unknown fields, so it would run the command without the variable:
  refused, nothing asked of the vault), then `HubVault.use` per variable with
  the variable name. The vault refuses anything but a `box-env` token that is
  global or scoped to this session, first on the stored columns, before it
  decrypts (`secret.use-refused`, no `secret.use`), then again on the
  authenticated row after the AAD verified. A token through a tool without a
  variable is refused as well, and a `box-env` token is still never the hub's.
  The use is audited (`secret.use` with `env`, `tool: bash`, the call id)
  before the value is returned and registered for sink redaction (0021).
- **Value path.** The value is registered for redaction before it is sent,
  then travels in that one `tool.exec` only (`env`, protocol 1.6). The hub
  checks the version again with no await before the send, so an older box
  never receives it. Box-agent adds the variables under its own (box
  variables win), writes no spill file for that call, and replaces each value
  in the result. It never logs params. The variables live in the child's
  environment only; the next command does not have them.
- **Scrubbing.** Before pi sees the output (so its result, its update events
  and its hub temp file), the hub replaces each value in the raw, JSON-escaped
  and URL-encoded forms (`redactValues`, 0039; the URL forms include Python's
  `urllib.parse.quote` and `quote_plus`). Every later tool result of the
  session is scrubbed too, whatever the tool: the runner's `tool_result` hook
  replaces every secret the hub has registered (`knownSecrets`, 0021; the
  vault registers each stored value when it opens, and each value it adds,
  rotates or hands out), not a per-runner set. So the scrub holds after the
  runner is rebuilt (a model switch, 0038, or a hub restart), for
  `browser_fill` values (0039) too. Live output goes through the runner's
  redactor, which holds back a tail that could start a secret, so a value
  split across chunks is never half shown (0036). Events, trajectory and
  logs redact it through the sink registry.

### Consequences

- The command, and anything it starts, sees the value and can write it to a
  file, send it out (egress is open, 0023) or transform it beyond what the
  redactor knows (base64, hex, a split or reversed string, any other
  encoding). The model can then read the transformed form. This is the
  residual the research names for `box-env`; the badge says so, and every use
  is audited.
- A file the command wrote with the raw value is scrubbed when a later tool
  result shows it, in this runner or a rebuilt one, but stays in the box. A
  child the command started in the background (`cmd &`, `setsid`) keeps the
  value in its environment for as long as it runs; reading it
  (`/proc/<pid>/environ`) is scrubbed the same way.
- A value is scrubbed only while the hub knows it: a deleted token, or the
  old value of a rotated one, leaves the registry at the next hub start, so a
  file written with it earlier is shown raw after that restart.
- A call with secrets has no `fullOutputPath`: the model sees only the
  output tail (256 KiB).
- A token's `hosts` is not enforced for `box-env` uses; the box's egress is
  not per command.
- The box-agent's own check that a box variable cannot be overridden is
  defense in depth: the decoder already refuses those names.

## 0042: M3 without phone channels; access mode `yolo` or `ask`

- Date: 2026-11-17
- Status: accepted
- Issue: #148

### Context

PRD v0.4 put "Anywhere" in M3: PWA, Web Push and Telegram next to approvals.
The owner (@zerone0x) wants M3 to ship the part that changes what the agent may
do, and to leave the phone work for later. Number 0041 is reserved for the
in-flight #130 PR.

### Decision

- **PRD v0.5.** M3 is "Models & access": several models with budgets (§6.4) and
  an **access mode** (§6.5). `yolo` runs every tool without asking; `ask` stops
  risky actions (deny-list after bash parsing, #69) and waits for approve or
  deny in the web UI; a timeout denies. A global default in Settings, a
  per-session override, the mode shown on the session and recorded on every tool
  call in the trajectory, every change audited. A new install defaults to `ask`.
- **S3 becomes web-only** (`git push` in `ask` creates an approval, approving
  in the web runs it, a second one left alone is denied at its timeout; the
  same call in `yolo` runs at once with the mode recorded). The spend and
  budget criterion is unchanged.
- **PWA, Web Push and Telegram move to a new M6 Anywhere**, between M5 and
  v1.0, with their own scenario S6 and exit criteria. Approval cards are
  web-only until then; the lifecycle stays channel-neutral (#71).
- **`ask` is built on pi.** pi 1.5.2 has no approval system (its docs/security.md
  says it does not ask before every tool call), but its extension API has a
  blocking `tool_call` event (`return { block: true, reason }`, docs/extensions.md)
  and ships examples `permission-gate.ts`, `timed-confirm.ts`,
  `confirm-destructive.ts` and `protected-paths.ts`. `ask` is a hub-side
  extension on `tool_call` that blocks until the owner decides in the web UI;
  `yolo` does not load it; it goes through the extension allowlist (#56).
- M3 starts with a short research doc on open-source pieces to reuse (bash
  parsing for #69, Bifrost budget and spend API).
- P1 per-secret approval (§6.10) now reads: a marked secret asks first when the
  session is in `ask` mode.

### Alternatives rejected

- **Fold the phone work into v1.0.** v1.0 is install, backup and cost work with
  a timed install test; a channel feature with its own e2e would blur it.
- **Keep approvals always on.** Some owners run unattended work in a box they
  trust; `yolo` is today's behaviour, so it stays available.
- **Default `yolo`.** A fresh install should not run `git push` or `rm -rf`
  unasked; the owner opts out.

### Consequences

- Docs only. Code comments that say "approvals are M3" stay true; comments
  about Telegram or PWA in M3 do not exist.
- Telegram pairing and the poller lease (§9) apply from M6; the vault key
  needs no owner password because triggers run in M4 and Telegram in M6.

## 0043: The access gate is a built-in loaded in both modes

- Date: 2026-11-17
- Status: accepted
- Issue: #152
- Supersedes: two points of 0042 ("`yolo` does not load it"; "it goes through
  the extension allowlist (#56)")

### Context

Decision 0042 (PRD v0.5 §6.5) made `ask` a hub-side pi extension on
`tool_call` that `yolo` does not load, and sent it through the extension
allowlist (#56). The M3 research for #152
(`docs/research/m3-models-access.md`) found both points at odds with the rest
of §6.5. The mode must be recorded on every tool call, in both modes, and a
gate that is not loaded records nothing. The config deny-list blocks in every
session today (decision 0015, `apps/hub/src/runner/tools.ts:342-351`), so a
`yolo` without the gate would drop deny rules that already apply. And #56's
allowlist is for extensions the owner adds; it is empty by default, so a gate
behind it would be off on a new install, which must start in `ask`.

### Decision

- **Loaded in both modes.** The access gate is one `tool_call` handler that
  runs in `ask` and in `yolo`. In `yolo` it skips the `ask` rules: those calls
  run at once. `deny` rules still block in both modes, as the config deny-list
  does today. The mode in force is recorded on every tool call from this one
  place.
- **Unparseable commands in `yolo`.** In `ask`, a `bash` command the parser
  cannot read (a parse error, a non-literal command name, nesting over the
  limit) asks. In `yolo` that ask would be skipped, so `deny` rules could not
  match it. Instead the gate falls back to today's raw-pattern deny-list
  (`apps/hub/src/runner/policy.ts`) for that command: a raw match blocks, no
  match runs.
- **Fail-closed.** An exception in the gate blocks the call in both modes (pi:
  an exception in a `tool_call` handler blocks it, `docs/extensions.md:3253`).
  This is intended: a broken gate stops tools rather than letting them through
  unchecked, and the block reason names the error.
- **A built-in, not an allowlisted extension.** The gate ships in the repo as
  part of the hub and is registered by the runner under a reserved name, next
  to `hearth-tools`, `codemode` and `hearth-trace`
  (`apps/hub/src/runner/extensions.ts`). The extension allowlist (#56) does not
  apply to it. It is first-party code, reviewed and tested like the rest of the
  hub; #56 governs extensions the owner adds, which Hearth does not review, and
  the reserved name keeps an allowlisted extension from shadowing the gate.
- The rest of 0042 stands: `ask` is built on pi's `tool_call` event, a new
  install defaults to `ask`, approval cards are web-only until M6.

### Alternatives rejected

- **Literal 0042: `yolo` does not load the gate.** The mode would then be
  recorded somewhere else for `yolo` calls, and deny rules would need a second
  handler, or vanish in `yolo`.
- **Skip unparseable commands in `yolo`.** A command spelled to defeat the
  parser would then escape deny rules that match it today as raw text.
- **Fail open on a gate exception in `yolo`.** `yolo` still has deny rules; a
  bug should not turn them off silently.
- **Put the gate behind #56.** It would be off on a new install, and the owner
  would have to allowlist a part of Hearth to get the default mode.

### Consequences

- PRD v0.5.1: §6.5 says the gate runs in both modes, is built in, and falls
  back to the raw deny-list in `yolo`.
- The access-mode issues from the research doc carry the tests: deny blocks in
  `yolo`, an unparseable denied command is blocked in `yolo` by the raw
  fallback, a gate exception blocks in both modes, and an allowlisted extension
  cannot take the gate's reserved name.

## 0044: Bash commands are parsed before the command rules (`unbash`), and only `deny` is enforced until the approval gate

- Date: 2026-11-17
- Status: accepted
- Issue: #69 (research: `docs/research/m3-models-access.md`, question 2, #153)

### Context

The deny-list (0015) is a regular expression over the raw `bash` string, so
`rm -fr`, `X=rm; $X -rf`, `bash -c "r""m -rf"` and `echo $(git push)` all get
past a rule. PRD §6.5 makes the risky set in `ask` mode "the deny-list after
bash parsing". The idea of parsing a command into simple commands before
matching rules comes from stakpak/agent (#64, `docs/research/stakpak.md` F1);
no code was copied. Decision 0043 (the access gate, loaded in both modes)
says that in `yolo` a command the parser cannot read is still checked against
the raw-pattern deny-list, and that an exception in the gate blocks the call.

### Decision

- **Parser: `unbash` 6.0.4** (ISC, pure TypeScript, no dependencies, no
  install script), pinned exactly in `apps/hub`. It is behind one adapter,
  `apps/hub/src/runner/bash-parse.ts` (`parseBash(source)`: simple commands as
  word lists, `null` for a word that is not a literal, plus every parse error),
  so `tree-sitter-bash` can replace it and the same tests prove the swap.
  The tree is walked with `forEachChild` only: a substitution's nested script
  (`$(...)`, backticks, `<(...)`, `>(...)`) is a lazy field that a walk over
  the object's own fields misses (a test pins this). Every nested script's
  own `errors` count. A command records the earlier stages of every pipeline
  it is in as index ranges into the command list, and the commands that feed
  its stdin (`< <(curl x)`, `<<< "$(curl x)"`), in one walk: the first cut
  copied the upstream list per stage, and a 64 KiB `sh|sh|...` took 31.7 s
  in the hub's synchronous `tool_call` handler (#160 review). Input over
  64 KiB is not parsed, and one classification has a work budget
  (`MAX_POLICY_STEPS`, 1,000,000 steps: a character parsed, a nested
  script's characters parsed again when its lazy field is read, a node
  walked, a word checked); past it the verdict is `ask` (`unclear:budget`),
  and the raw deny-list has already been applied. The worst 64 KiB shapes
  known take under 0.3 s. An exception
  from the parser or the walk is a parse error, so the command is one the
  parser cannot read (0043); any other exception in `classifyBash` reaches
  pi's `tool_call` handler and blocks the call (fail-closed, 0043).
- **A small Hearth policy layer** (`bash-policy.ts`, `classifyBash`) strips the
  wrappers `sudo`, `doas`, `env` (and its `VAR=x`), `timeout`, `nice`,
  `ionice`, `nohup`, `time`, `stdbuf`, `builtin`, `command`, `exec`, `xargs`,
  `setsid`, `chroot` (and its root), `flock` (and its lock file), `taskset`
  (and its mask), `strace`, `unbuffer` and `busybox` (the applet is the next
  word) with their options. Wrapper options are read the way getopt reads
  them: short clusters (`env -iS'...'` is `-i` then `-S`), long options with
  `=value` or the next word, an unambiguous prefix of a long option
  (`sudo --us root`); a long option the table does not know asks. It
  re-parses the string of `bash|sh|zsh|dash|ksh -c`, `su -c`, `script -c`,
  `flock -c`, the words of `eval` and `watch`, and the command of
  `sudo -s`/`-i` (run by a shell), up to 3 levels; and gives `ask` when it
  cannot see what runs: a parse error, a command name that is not a literal,
  `alias`, `git -c alias.*=...`, `source`/`.`, a shell (or `su`, `chroot`,
  `sudo -s` with no command) reading a script, a pipe, a stdin redirect, a
  here-doc or here-string, or `xargs`' words; `env -S`/`--split-string`,
  `sudo -e`, `parallel`, `runuser`, deeper nesting, or the work budget.
- **`xargs`.** Words from stdin are added to the command, so a rule's
  `subcommand`, `flags` or `args` test that the written words do not meet is
  `ask` under `xargs` (`echo push | xargs git`); with `-I`/`--replace` any
  word can be replaced, so a different subcommand is `ask` too.
- **Rules key on the command, not the string**: `{ name, command[],
  subcommand?, optionsWithValue?, flags?, args?, pipedFrom?, action:
  ask|deny, reason? }`. A one-letter flag matches inside a cluster (`-r` in
  `-fr`); a long flag matches `--flag=value` and every GNU prefix of it
  (`rm --rec --for`, `git reset --har`), ambiguous ones too, which errs
  strict. `pipedFrom` matches an earlier stage of any enclosing pipeline,
  compound stages included (`(curl x) | sh`), and a command that feeds the
  shell's stdin (`sh -s < <(curl x)`). A non-literal argument that could decide the match makes the rule
  `ask`. The most restrictive result over all simple commands wins, deny >
  ask > allow; that order is credited to `@pi-kit/permissions`.
- **Seed rules**, `runner.config.commandRules` (unset: the seed; `[]`: none):
  `rm` with `-r` and `-f`, `git push`, `git reset --hard`, `curl`/`wget` piped
  into a shell, `dd`, `mkfs*`, `chmod -R 777 /`. All `ask`, so a new install
  blocks nothing it did not block before; an owner sets `deny` for a hard block.
- **The raw-pattern deny-list stays.** For `bash` it is tested against the raw
  command first, as before, which is 0043's fallback when parsing fails, and then
  against each parsed command (before and after unwrapping) as words joined
  by one space, so `bash -c "r""m -rf x"` meets `^rm\s+-rf`.
- **Only `deny` is enforced today.** The verdict (`allow` | `ask` | `deny`,
  the rule, the reason, the command it saw) goes on the call's trajectory
  step as `bash_policy`. `ask` runs as before until the approval gate and the
  access mode exist (follow-up issues of #153); they read the same verdict.
  That is already 0043's `yolo`: deny rules block, `ask` runs, an unreadable
  command meets the raw deny-list. Command rules also match the commands a
  partly parsed tree does show, so a parse error elsewhere does not hide a
  readable `git push`.

### Alternatives rejected

- **`tree-sitter-bash`.** Equally correct on the hostile set, but wasm plus an
  npm package with a native install script, and an async init.
- **`sh-syntax`.** The most mature grammar, but a 4 MB Go-wasm blob in the hub,
  and it overflowed its stack on the deep sample.
- **`shell-quote` or a tokenizer.** Missed 10 of the 36 hostile samples.
- **A third-party permission package.** None can be driven from the hub (#153).
- **Treat a parse error as `deny`.** There is no approval UI to recover with;
  a typo in a command would fail a turn. It is `ask`, and the raw deny-list
  still applies.

### Consequences

- Not a boundary; the box is (0015). Known gaps, each `allow` unless said:
  interpreters (`python -c`, `node -e`, `perl -e`, `awk 'BEGIN{system(...)}'`);
  `find -exec`/`-execdir`/`-ok`; `trap '<string>'`; environment variables
  that run code (`PROMPT_COMMAND`, `BASH_ENV`, `ENV`: prefix assignments are
  dropped); git aliases set in the box's config, and other git config that
  runs a command (`-c core.sshCommand=...`, `core.pager`, `include.path`,
  `GIT_CONFIG_*`); a script written and then run; `exec < file` followed by a
  shell (only a command's own redirects and its compound's are seen);
  wrappers not in the table (`nsenter`, `unshare`, `systemd-run`, `firejail`,
  `ltrace`, `ssh host cmd`, ...); `download-to-shell` sees the name an
  upstream stage runs after unwrapping, not inside its `-c` string
  (`bash -c 'curl x' | sh` is `ask` as a shell reading a pipe, not the rule);
  network calls that do what a rule forbids (`curl` to a forge API). The
  wrapper table errs strict where the real tool differs: `sudo -s` joins its
  words without sudo's escaping, `timeout`/`taskset` options after the
  positional are still read as options, and `ionice -p PID cmd` is read as
  a command.
- A rule's `optionsWithValue` must list options that take a value, or their
  value is read as the subcommand (`git -C dir push`); the seed git rules
  list git's.
- `tool_call` trajectory records of `bash` gain `bash_policy`, an added field
  under schema `/2`.

## 0045: Access mode setting: a global default, a per-session override, one resolver per tool call

- Date: 2026-11-17
- Status: accepted
- Issue: #154 (design: `docs/research/m3-models-access.md`, question 3 and
  proposed issue 2; PRD v0.5.1 §6.5; decisions 0042, 0043)

### Context

PRD §6.5 gives every session an access mode, `yolo` or `ask`, with a global
default in Settings, a per-session override shown on the session, an audit row
for each change, and the mode recorded on every tool call. Decision 0043 makes
the access gate a built-in loaded in both modes. This entry covers the setting
and the recording; the gate itself (what `ask` stops, the approval cards) is
#155.

### Decision

- **Global default.** Stored as the `access_mode` setting (`{mode}`) in the
  `setting` table next to `model` (0038). `GET /v1/settings/access-mode`
  answers `{mode, source, updatedAt}`; `PUT {mode: "yolo" | "ask"}` saves it.
- **Unset means `ask`, also on an existing install.** A new install starts in
  `ask` (0042). An install from before this change has no saved value either;
  it reads as `ask` too, the safer choice, rather than keeping today's
  unasked behaviour as `yolo`. Until the gate lands (#155) the two modes run
  tools the same way, so the upgrade changes nothing an owner can see except
  the recorded mode. A stored value the hub cannot read is also `ask`.
- **Per-session override.** Migration 9 adds `session.access_mode`
  (`yolo`, `ask`, or NULL to follow the global default, enforced by a CHECK).
  `GET /v1/sessions/:id/access-mode` answers `{sessionId, override, global,
  mode}`; `PUT {mode: "yolo" | "ask" | null}` sets or clears it. Archived
  sessions keep their value; it is not used.
- **Guards as the other settings routes.** The request guard (Host, Origin,
  JSON content type; 0010) and the login guard (0014) run first. The service
  authorizes before it reads the body (`settings.access_mode.update`,
  `session.access_mode.update`, `settings.read`, `session.read`; #32); a
  session route looks the session up only after `authorize`, so a refused
  caller cannot tell an unknown id from another workspace's (#90).
- **Audited, then logged, then stored.** A change writes its audit row
  (`settings.access_mode.update` or `session.access_mode.update`, with the new
  and previous mode) first; if that fails nothing else happens. Then a
  `session.access_mode` event `{mode, previous, override, global, changed:
  "global" | "session", by}` goes to every session whose mode it may change:
  the one session for an override, or every non-archived session that follows
  the global default for a global change. Then the row is written, and one log
  line says what changed.
- **One resolver, read per tool call.** `AccessModes.resolve(sessionId)`
  (`apps/hub/src/settings/access-mode.ts`) returns `override ?? global`. The
  runner calls it from a `tool_call` handler in a new built-in extension,
  `hearth-access` (`apps/hub/src/runner/access.ts`), registered first and
  reserved in `RESERVED_EXTENSION_NAMES`. Nothing is cached, so a change
  applies to the next tool call, also in the middle of a turn. #155 grows this
  extension into the gate of 0043 and calls the same resolver. An exception in
  the resolver blocks the call (pi's `tool_call` rule), fail-closed as 0043
  says for the gate.
- **Trajectory.** Each `tool_call` step records `access_mode`, the mode it
  was preflighted under, also when the deny-list then blocks it (the access
  handler runs before `hearth-tools`). It is an added field, so the schema
  stays `hearth.trajectory/2` (0021: added fields do not bump it; precedent
  0037). Calls recorded before this change project with `access_mode: null`.
- **UI.** An "Access mode" card on `#/settings` (native select and a Save
  button, TanStack Query) and an "Access" select in the session header:
  "Default (<global>)", "Ask", "Yolo", saved on change. Both are shadcn
  `native-select`, so the CSP stays as 0038 left it; the web e2e uses both and
  fails on any violation. The card says plainly that approval prompts are not
  in this version yet.

### Alternatives rejected

- **Existing installs default to `yolo`** to keep today's behaviour by name.
  The behaviour is the same until #155 either way, and when the gate lands an
  owner who never chose should get the safer mode; `yolo` is one click away.
- **Write the global default at first start** (`insertIfAbsent`). An unset
  value already reads as `ask`; a row would only hide whether the owner chose.
- **The override in the `setting` table** under a per-session key. The
  session row is where the session's other choices live; a column keeps the
  read per tool call one primary-key lookup and goes away with the session.
- **The event only on the changed session for a global change.** The
  sessions that follow the default are the ones whose mode changed; their logs
  should say so, as the research asks ("global or per session").

### Consequences

- Migration 9 is taken. Parallel PRs that also add a migration (#69, #156)
  renumber theirs on merge.
- #155 needs no new setting or plumbing: it reads `resolve` in
  `hearth-access` and adds its `approval.*` fields next to `access_mode`.

## 0046: Bifrost as a compose service: vault secrets through a tmpfs handoff, keys pushed from the vault, model traffic in #157

- Date: 2026-11-17
- Status: accepted
- Issue: #156 (design: research #152, `docs/research/m3-models-access.md`,
  question 4 and the threat notes)

### Context

PRD §6.4 makes Bifrost the default model gateway: provider keys behind it,
one virtual key per session with a budget and a model allowlist. The research
for #152 verified Bifrost v2.5.1's admin and governance API from Bun and
proposed four rules: pinned by digest, internal network only, provider keys
pushed from the vault (0031 keeps the vault as the source), and Bifrost's
admin password and `encryption_key` as vault entries, so that a copy of
Bifrost's volume alone does not give the keys. The hub runs on the host's
network (0020), so it cannot join a compose network, and Bifrost reads its
secrets at start, before the hub could call its API.

### Decision

- **Service.** `maximhq/bifrost@sha256:5ec9873a…d3c8`, the multi-arch index
  digest of `v2.5.1` from the registry API (Apache-2.0). On its own bridge,
  `hearth-bifrost`, subnet `172.29.249.0/29`, fixed address `172.29.249.2`
  (`HEARTH_BIFROST_SUBNET`, `HEARTH_BIFROST_ADDR`), no published port. The
  hub, on the host's network, reaches it at `HEARTH_BIFROST_URL`. Not
  `internal: true`: Bifrost needs the providers and its price list.
- **Config.** `deploy/bifrost/config.json`: admin auth on (user `hearth`,
  password `env.BIFROST_ADMIN_PASSWORD`), `enforce_auth_on_inference`,
  `allow_direct_keys: false`, `disable_content_logging`, SQLite config and log
  stores on the `bifrost-data` volume, which neither a box nor the hub mounts,
  and the MCP catalog sync off.
- **Secrets.** Two vault entries, `bifrost-admin-password` and
  `bifrost-encryption-key` (`token`, `use: hub`, 32 random bytes in
  base64url), created by the hub with the system principal on the first start
  with the vault open, and audited like any entry. At every start the hub
  writes them, mode 0440, into `bifrost-handoff`, a tmpfs volume (memory
  only) it shares with Bifrost; `deploy/bifrost/start.sh` waits for them,
  exports them and runs Bifrost's own entrypoint. Bifrost encrypts the
  provider keys in its store with that key; the binary test checks the key is
  not in `config.db` in plain text.
- **The two entries are the hub's.** `HubVault` takes a list of system
  entries; for one that is a global `token` with `use: hub`, the secrets API
  refuses rotate, a `use` change and delete (409 `secret.system-managed`), and
  only the system principal may create an entry under those names. The
  Settings page shows "Managed by the hub" instead of Rotate and Delete
  (`system: true` in the list). The hub hands over an existing entry only when
  it is such a token: anything else under those names (made before the names
  were reserved) is never given to Bifrost, the state is `secrets-unusable`,
  and the owner may delete it so the hub makes its own.
- **Keys are pushed, never typed.** Every global `model-key` entry whose
  `meta.provider` maps to a Bifrost provider (`anthropic`, `google`→`gemini`,
  `groq`, `mistral`, `openai`, `openrouter`) is pushed through
  `POST/PUT /api/providers/{p}/keys` with `models: ["*"]` (an empty list
  supports no model). A key Bifrost has under one of those providers that the
  vault does not is deleted. Pushed when Bifrost turns healthy and after an
  entry is added, rotated or deleted (a new `HubVault` `onEntryAdded` hook
  next to `onValueChange`). Other providers (a `models.json` endpoint) are
  skipped with a log line. Keys never pass through a box or the compose file.
- **Health.** The hub checks `GET /health` and one authorized admin call every
  30 s. `/healthz` has `bifrost`: `ok`, `starting` or `unavailable`, and
  `bifrostState`, the state behind it (`ok`, `starting`, `unreachable`,
  `unauthorized`, `vault-disabled`, `secrets-unusable`, `box-reachable`); the
  reason is in the log, one `bifrost:` line per change (component `bifrost`;
  `unauthorized` and `box-reachable` at error, the others at warn).
- **The install does not depend on Bifrost.** No model call uses it yet, so
  the hub has no `depends_on` on it and its own health never includes it:
  `docker compose up -d --wait hub` succeeds when Bifrost cannot start (no
  access to `getbifrost.ai`, the vault disabled or its key mismatched, an
  allow list that covers it). install.md starts Bifrost with a separate
  `docker compose up -d bifrost`, without `--wait`, and the systemd unit
  ignores that step's failure. The hub logs why and `/healthz` says
  `"bifrost":"unavailable"`. The compose e2e still requires `"bifrost":"ok"`.
  #157, which sends model calls through Bifrost, decides whether the hub then
  depends on it.
- **No box reaches it.** The box firewall already rejects every private range
  from a box. `scripts/box-firewall.sh` now also takes `HEARTH_BIFROST_ADDR`
  and refuses (before any rule changes) an address outside those ranges or an
  allow entry that covers it; `box-firewall.sh check` validates without
  root. At start the hub reads the marker's `allow=` list and stays
  `box-reachable`, without creating or handing over any secret, if an entry
  covers Bifrost's address.
- **Model traffic switches in #157, not here.** This PR changes no model call:
  the runner still uses the env or Settings model and its key directly
  (0038). #157 adds per-session virtual keys (create, rotate per runner build,
  allowlist `PUT`, deactivate, delete) and points the runner's pi at Bifrost
  with them; switching before a session has its own virtual key would need a
  shared one, which §6.4 rules out.
- **Tests.** The hub's side against a fake admin API (`bifrost.test.ts`) and
  against the real v2.5.1 binary (`bifrost.binary.test.ts`, gated by
  `HEARTH_BIFROST_BIN`; CI downloads it with `scripts/fetch-bifrost.sh`,
  pinned SHA-256, and never commits it). The binary test checks that a model
  call with no key or an unknown one is 401 and reaches no provider, which is
  what `enforce_auth_on_inference` holds. The compose-e2e runs install.md's
  `install:bifrost` block and checks the network, the digest, the volumes and
  that a container on an `hbx` bridge under the firewall cannot reach Bifrost
  while the host can.

### Alternatives rejected

- **Publish Bifrost on the host's loopback.** Any process on the host could
  then reach its inference API; a dedicated bridge needs no published port.
- **Secrets in `deploy/secrets` files or the compose file.** They would sit on
  disk next to Bifrost's store, against 0031 and the research's threat note.
- **Let the hub start Bifrost through the Docker API with the secrets in its
  environment.** It would not be a compose service the install and `--wait`
  manage, and `docker inspect` shows a container's environment.
- **Configure Bifrost's auth through its API after start.** Bifrost would run
  with an open admin API until the hub got to it.
- **Switch model calls to Bifrost here with one shared virtual key.** Larger
  PR, and a shared key gives no per-session budget.

### Consequences

- A new install needs outbound HTTPS to `getbifrost.ai` on Bifrost's first
  start: v2.5.1 exits when the price list cannot be downloaded and none is
  stored (probed with an unreachable `pricing_url`). `install.md` says so and
  names `pricing_url` for a mirror.
- A changed `encryption_key` over an existing store breaks Bifrost (probed
  against v2.5.1 in review): `GET /api/providers` answers 500, a provider
  cannot be added again (409), and the governance plugin fails, so inference
  auth is off (a call with no key gets 400 `no_key`, not 401). That is why the
  API refuses to change the two entries. A rotation flow is future work; until
  then the way out of an unreadable store is to remove the `bifrost-data`
  volume (install.md, "Bifrost's store"), after which the hub pushes the
  provider keys again.
- Bifrost shows a stored key masked (`sk-f****-123`), verified against the
  binary; the research listed this as not verified.
- Docker's own rules also separate box networks from Bifrost's: it drops a
  packet for a container's address that does not come in on the container's
  bridge in the raw table (`-A PREROUTING -d 172.29.249.2/32 ! -i
  hearth-bifrost -j DROP`, seen in CI), before the filter table, so a box probe
  of Bifrost's own address times out and never reaches the firewall's
  `tcp-reset`. The compose e2e therefore also probes an unused address in
  Bifrost's subnet, which only the firewall can answer: it must be refused by
  the `tcp-reset` rule, whose counter must move.
