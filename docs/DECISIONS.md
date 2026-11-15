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
  the browser, its renderers, or a page.
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
  uid 1000 with exactly the variables above, no Chromium process holds the
  join token, and after a `kill` a new browser process answers CDP.
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
- Desktop supervision beyond Chromium (Xvnc or Openbox dying) is still #15.
