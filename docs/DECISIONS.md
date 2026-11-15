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
  `dev.hearth.pi.version`. User labels never override these.
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
  `not-found`. An object with a box's name that lacks this instance's labels is
  never adopted, changed or removed (`box.name-conflict`).
- **Failure owners.** A missing or refusing socket and daemon timeouts are
  `hub`/`retry`; permission denied on the socket is `hub`/`give-up`; unexpected
  daemon answers about its own objects are `hub`. A missing image (or a failed
  pull) is `box`/`give-up`; the runtime refusing to create or start the container
  is `box`/`retry-cold`, and the failed container is removed first. A missing
  image is pulled once unless `HEARTH_BOX_PULL=never`.
- **`adopt`** lists containers and volumes with `dev.hearth.managed=true` and this
  instance's label, so a hub restart finds hibernated boxes too, and two hubs (or
  a test run) on one daemon never adopt each other's boxes.
- **Chromium runs with `--no-sandbox`; the container is the sandbox.** The
  provider sets `HEARTH_CHROMIUM_SANDBOX=off` in the box's environment, for
  box-agent to read when it launches Chromium. Every box runs with all
  capabilities dropped, `no-new-privileges`, Docker's default seccomp and
  AppArmor profiles, as uid 1000, with no published ports. Reasoning:
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
