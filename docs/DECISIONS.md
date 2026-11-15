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
