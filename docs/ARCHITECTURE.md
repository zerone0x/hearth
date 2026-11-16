# Architecture

Hearth has a brain and hands (decision 0009). The **hub** (`apps/hub`, one
process) runs the API, the web UI, login, the session manager and one pi
runner per session; it holds the database, the model key and every
authorization decision. Each session's **box** is a Docker container
(`apps/box-agent`) that executes the runner's tools in `/workspace`, runs the
desktop (Xvnc and Chromium) and dials the hub over the hub-box protocol
(`packages/protocol`). The box holds no model credentials and has no inbound
ports. A host firewall keeps boxes off the host, the LAN and cloud metadata.

The PRD (`docs/PRD.md`, §8) has the full picture; `docs/DECISIONS.md` has why
each part is the way it is; `docs/install.md` runs it.

## Invariants and tests

Each promise the code makes, and the tests that fail when it breaks. The
`check` gate runs everything but the Docker suites, which run in the
`box-provider` job (`*.docker.test.ts`); `deploy/e2e/prototype.ts` runs in
`compose-e2e`. A drift check (`scripts/docs-drift.test.ts`) fails
`bun run check` when a file below no longer exists or a test name below is no longer declared
exactly as `test("<name>"` or `it("<name>"`.

| Promise | Decisions | Guarded by |
| --- | --- | --- |
| Ack on apply: the hub acks a box frame only once it is stored, a redelivered frame is stored once, and box-agent keeps a frame until it is acked | 0005, 0008 | `apps/hub/src/box/connection.test.ts` "killing the hub mid-stream loses and duplicates nothing"<br>`apps/hub/src/store/event-store.test.ts` "re-applying a delivery returns the original seq and writes nothing"<br>`apps/box-agent/src/outbox.test.ts` "stamps increasing delivery ids of its boot and keeps frames until acked" |
| Events and audit are append-only in the database | 0006 | `apps/hub/src/store/event-store.test.ts` "UPDATE and DELETE on event fail in the database"<br>`apps/hub/src/store/audit-sink.test.ts` "UPDATE on audit fails in the database"; "DELETE on audit fails in the database"<br>`apps/hub/src/store/append-only.test.ts` "fails on a connection from openDatabase" |
| Authorize first, audit before acting, fail closed when the audit write fails | 0003, 0006, 0022 | `packages/core/src/authorize.test.ts` "fails closed when the audit write fails"<br>`apps/hub/src/store/audit-sink.test.ts` "does not act when the audit write fails"<br>`apps/hub/src/authz.test.ts` "fail closed: when the audit log is unavailable, the frame is not stored or acked"; "a denied echo answers 403 authz.denied and sends no rpc to the box"<br>`apps/hub/src/principal.test.ts` "session routes: create, list, get, archive"; "desktop: the upgrade request authorizes desktop.view as the signed-in principal" |
| An unknown id and another workspace's id get the same answer (#85, #90) | 0022 | `apps/hub/src/session-existence.test.ts` "every session route answers the same"<br>`apps/hub/src/authz.test.ts` "an echo to a box in another workspace answers 409 and sends no rpc to the box" |
| The API refuses a foreign Host, a cross-site Origin and non-JSON bodies | 0010 | `apps/hub/src/server.test.ts` "the auditor's probes are refused over a real socket" |
| No hub-local paths in the protocol: file paths are workspace-relative | 0002, 0011 | `packages/protocol/src/codec.test.ts` "file streams take workspace-relative paths"; "absolute, drive, parent and empty paths are rejected" |
| The box holds no model credentials: tools run without the hub's environment, and the model key is nowhere in a compose box | 0009, 0015 | `apps/hub/src/runner/runner.test.ts` "all seven tools go to the box with their call id, under a lease, without the hub env"<br>`deploy/e2e/prototype.ts` (the `compose-e2e` job fails when the model key is in the box's environment; a script check, not a named test, so the drift check does not follow it) |
| Box-agent's secrets are closed to the commands it runs | 0018 | `apps/box-agent/src/boot.test.ts` "reads the token file, deletes it and scrubs both variables"; "throws when PR_SET_DUMPABLE returns -1"<br>`apps/hub/src/box/proc-secrets.docker.test.ts` "a command reads neither the join token nor box-agent's environ or memory" |
| Secrets are redacted before a long value is cut, so no prefix of one is kept | 0021 | `apps/hub/src/obs/obs.test.ts` "a secret straddling the cut is redacted before the cut, so no prefix of it is kept"<br>`apps/hub/src/obs/hub-obs.test.ts` "the API and the CLI redact a registered key before the 16 KiB cut" |
| The web UI is served with a strict CSP | 0017 | `apps/hub/src/web/static.test.ts` "index.html is served without a login, with the CSP and no-sniff" |
| Boxes start only behind the egress firewall, and only a root-owned marker counts | 0012, 0023, 0024 | `apps/hub/src/server.test.ts` "without the firewall marker startBox is refused as the box's, before anything starts"<br>`apps/hub/src/box/egress.test.ts` "a marker owned by another uid is refused"; "a symlink is refused even when it points at a trusted marker"; "a hard link to a trusted file is refused" |
| pi packages are pinned to one exact version everywhere | 0001, 0020 | `scripts/pins.test.ts` "rejects ranges"; "rejects pi packages pinned to different versions"; "rejects a lockfile that resolves pi to another version" |
| The box desktop renders a supervised Chromium | 0026 | `deploy/e2e/desktop-pixels.test.ts` "a black desktop fails: the empty desktop the issue reported"<br>`apps/hub/src/box/docker/provider.docker.test.ts` "the desktop's Chromium: CDP on loopback, uid 1000, a clean environment, restarted when it exits" |
