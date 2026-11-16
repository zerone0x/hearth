# Research: the vault (model keys, site logins, API tokens)

> Issue #108 · 2026-11-16 · docs only, no code in the main tree. Owner: @zerone0x

## Sources and how to read the citations

A citation `path:line` without a repo name is a line in Hearth's `main` at
`87e21dc` (read on 2026-11-16). `DECISIONS 00NN` is an entry in
`docs/DECISIONS.md`; its heading line is given where it helps.

Outside sources, all public, read on 2026-11-16:

| Source | Version or commit | License | State on 2026-11-16 |
|---|---|---|---|
| `openbao/openbao` (GitHub API, release tarball, `CHANGELOG.md`) | release `v2.7.2` (2026-10-26, binary commit `9e0a0d3c`), `main` at `92de51f7` (2026-11-12) | MPL-2.0 | active: last push 2026-11-12, 373 contributors (GitHub contributors API, non-anonymous), two maintained lines (2.7.x and 2.6.x) patched on the same day |
| OpenBao docs, static seal (`openbao.org/docs/configuration/seal/static/`) | "Version 2.7.x" | | |
| Bun WebCrypto (`crypto.subtle`) | Bun 1.4.4 (Hearth's pin) | MIT (Bun) | built in, no dependency |
| `libsodium-wrappers` (npm) | `0.8.4`, 550 kB unpacked | ISC | last publish 2026-04-19 |
| `otpauth` (npm, TOTP) | `9.6.0` | MIT | last publish 2026-11-02 |
| `@bitwarden/cli` (npm; source `bitwarden/clients`) | `2026.10.1`, 19.3 MB unpacked | GPL-3.0 (repo `LICENSE.txt`; one directory under the Bitwarden License) | active |
| Bitwarden CLI help page (`bitwarden.com/help/cli/`) | | | |
| `@1password/sdk` (npm) | `0.5.0`, README | MIT (SDK; the 1Password service is proprietary and paid) | active |
| `@playwright/mcp` (npm tarball README) | `0.0.85` | Apache-2.0 | active |
| `playwright-core` (npm, `types/types.d.ts`) | `1.65.1` (Hearth's pin in `apps/web/package.json` and `deploy/e2e/package.json`) | Apache-2.0 | active |
| `node-vault` (npm) | `0.13.0` | MIT | last publish 2026-10-11 |

**Read only from documentation, not verified by running:** the Bitwarden CLI
(`bw get`, `bw serve`), the 1Password SDK and CLI, and Vaultwarden. I did not
install or run any of them.

**Verified by running** (on this machine, Linux x64, Bun 1.4.4, OpenBao 2.7.2
from the release tarball, checksum checked against `checksums.txt`):

- Bun's WebCrypto: a 256-bit AES-GCM data key wrapped with AES-KW, unwrapped,
  used to encrypt and decrypt with associated data (AAD); a wrong AAD is
  rejected.
- OpenBao in dev mode, driven from Bun with plain `fetch` (no client library):
  a KV v2 write and read, a transit encrypt and decrypt, and a transit
  `datakey/wrapped` unwrap. See "OpenBao: the probe".
- OpenBao in server mode with raft storage and the **static seal**: after
  `bao operator init`, a restart comes back unsealed with no operator action.

**Clean room.** Nothing is copied into Hearth. The probe scripts are throwaway
code written for this note; they are not committed.

## Summary

- **Store secrets in the hub's SQLite, encrypted, behind the existing E7
  `SecretStore`.** A new `vault:` scheme resolves a named entry
  (`vault:github#password`). The crypto is WebCrypto AES-256-GCM, built into Bun:
  no new dependency, no hand-rolled primitives. Each row is bound to its id,
  name and version through AAD.
- **The master key is a 32-byte key file**, a compose secret next to today's
  `model_key` (`deploy/secrets/vault_key`). The install step generates it
  automatically (random bytes, mode 0600); the owner never types, pastes or
  edits it, and backs it up apart from the volume. The hub reads it through the
  SecretStore (`HEARTH_VAULT_KEY_REF=file:/run/secrets/vault_key`). It wraps one
  data key; the database alone, or a backup of the volume, decrypts nothing.
  No owner password in the key path: triggers and Telegram (M3, M4) must run
  while nobody is logged in.
- **OpenBao (owner's suggestion) is the right enterprise backend, not the M2
  default.** It is MPL-2.0, active, and fits E7 cleanly. Plain HTTP from Bun is
  enough (probe below). For one owner on one VPS it adds a second process
  (about 95 to 120 MB RSS, a 173 MB binary). It also adds an unseal key and a
  hub token, both still in files on the same host, so it moves the trust
  problem without removing it. Design the vault so OpenBao plugs in later as a
  key provider (transit) or an entry backend (KV v2). Do not ship it in M2.
- **Do not read from Bitwarden/Vaultwarden or 1Password by default.** Both need
  a long-lived unlock credential in the hub. Bitwarden's `bw serve` is an
  unauthenticated local HTTP API over the whole vault, and the hub runs on the
  host network (DECISIONS 0020). Offer them later as optional read-only
  resolvers (`bw:`, `op:`) if the owner asks.
- **The model names a reference, not a value.** The hub resolves it at the
  tool RPC boundary and sends the value only in the one RPC that uses it. It
  redacts the value (and its encodings, #70) from every later text result,
  event, log and trajectory of the session. Site logins are filled by the
  `browser_fill` tool of #107 (PR #112), only into password, username or
  one-time-code fields, and only on the origins the entry is bound to. String
  redaction cannot reach a screenshot, so box-agent masks every element it
  filled with a secret in every later screenshot of that tab. A value the site
  echoes elsewhere on the page can still reach the model as pixels; that
  residual is named in the threat model. Model keys and hub-side tokens never
  enter a box. A site password must enter the box, because the browser lives
  there.
- **A settings page replaces the `.env` model lines and `deploy/secrets/model_key`.**
  The page has a model card and a secrets table. You can add, rotate and delete
  secrets, see fingerprints and their uses, but never read a value back. The
  hub imports today's key file on first start, so an upgrade needs no manual
  step.

## What Hearth has today

**E7 SecretStore.** `packages/core/src/secrets.ts:184-188` defines
`SecretResolver` (one scheme, `resolve(body, ref)`). `ResolvingSecretStore`
(`secrets.ts:324-443`) adds a 30 s cache, `invalidate` after a rotation and a
`preflight`. The default store has only `env:` and `file:`
(`secrets.ts:446-452`). `SecretValue` hides the value behind `reveal()` and prints
a fingerprint (`secrets.ts:146-171`). The fingerprint is the first 12 hex digits
of an **unkeyed** SHA-256 (`secrets.ts:136-139`). That is fine for a random API key, but
for a stored password it lets anyone holding the fingerprint confirm a dictionary
guess. The vault needs a keyed fingerprint (see Data model). PRD §7 lists
`vault:` / KMS resolvers as the extension (`docs/PRD.md:198`). The PRD data
model already has `secret(id, workspace_id, name, ciphertext, created_at)`
(`docs/PRD.md:384`).

**Model key and model choice.** `runnerConfigFromEnv` reads
`HEARTH_MODEL_PROVIDER`, `HEARTH_MODEL`, `HEARTH_MODEL_KEY_REF` and
`HEARTH_MODELS_FILE` from the environment (`apps/hub/src/main.ts:55-84`). The
compose file pins the key reference to `file:/run/secrets/model_key`
(`deploy/compose.yaml:89`). That is a compose secret from
`deploy/secrets/model_key` (`deploy/compose.yaml:96-97`, `105-107`), written by
the install steps (`docs/install.md:95-96`, `107`). Model and provider are lines
in `deploy/.env` (`deploy/hearth.env.example:4-8`), as decided in DECISIONS 0020
(`docs/DECISIONS.md:1666-1668`). The runner resolves the key once per runtime
and hands it to pi in memory (`apps/hub/src/runner/runners.ts:296-300`,
DECISIONS 0015 at `docs/DECISIONS.md:1228-1234`). Changing the model or key
today means editing files and restarting the hub.

**Redaction.**
- Runner side (0015): `redactSecrets` replaces each known value, raw and
  JSON-escaped (`apps/hub/src/runner/runner.ts:104-114`), over the runner's set
  of SecretStore values (`runners.ts:146-148`).
- Sink side (0021): the hub registry `registerSecret` / `redactHub`
  (`apps/hub/src/obs/redaction.ts:18-25`) is filled at startup by
  `registerKnownSecrets` (`redaction.ts:33-51`, called from `main.ts:114-121`,
  `140-141`). On top of known values, `redactLine` catches credential shapes:
  bearer tokens, `sk-` keys and `password=` pairs
  (`packages/core/src/log.ts:36-56`).
- Both catch exact strings only. #70 proposes placeholder substitution: replace
  known values (with base64 and hex forms) by stable placeholders in tool
  results and user messages, and restore them in tool-call arguments just
  before the RPC leaves the hub.

**Login and setup (0014).** One owner password, hashed with argon2id at OWASP's
first parameter set (`apps/hub/src/auth/password.ts:21`, `docs/DECISIONS.md:1094`,
`1120`). On first run a one-time setup token is logged
(`docs/DECISIONS.md:1106-1118`). The tables are `owner_password` and
`login_session`, migration 5 (`apps/hub/src/store/migrations.ts:197-214`).

**Audit (E10).** There is an append-only `audit` table (`migrations.ts:98-115`),
and the PRD says the audit record is written before the action
(`docs/PRD.md:402`).

**The box.** Boxes hold no model credentials and no long-lived secrets
(`docs/PRD.md:400`). Box-agent is non-dumpable, and its own secrets are closed to
the commands it runs (DECISIONS 0018, `docs/DECISIONS.md:1465`). Chromium runs in
the box with CDP on loopback, and CDP has no authentication: any command in the
box can drive the browser (DECISIONS 0026, `docs/DECISIONS.md:2124`, `2204`).
Box egress is filtered toward the host and the LAN, but the internet stays open
(0012, 0023). Tools go to the box over the tool RPC (`ToolRpcClient`,
`apps/hub/src/box/tool-rpc.ts:140`). Today's routed tools are file and shell
tools only (`apps/hub/src/runner/tools.ts:41`).

## Questions from the issue, answered

### 1. Encryption at rest

**Algorithm.** AES-256-GCM through WebCrypto (`crypto.subtle`), built into Bun.
Each encryption uses a fresh random 96-bit IV. At a single owner's scale (far
fewer than 2^32 encryptions per key, NIST SP 800-38D's limit for random IVs) the
nonce-reuse risk of GCM is negligible. A rotation re-encrypts under a new IV
anyway. libsodium's XChaCha20-Poly1305 (`libsodium-wrappers`, ISC) removes even
that concern with 192-bit nonces. It is the alternative if we ever want it, at
the cost of a 550 kB WASM dependency. Both are maintained; neither is hand-rolled.
Choose WebCrypto: no new dependency.

**Envelope and subkeys.**
- The 32-byte key file is the **master key** `M`. It is never used directly.
  Three subkeys are derived from it with HKDF-SHA256 (WebCrypto `deriveKey` /
  `deriveBits`), one per purpose, so no key serves two purposes:
  - `KEK` = HKDF(M, info `"hearth-vault/v1 kek"`), an AES-KW key that wraps the
    data key;
  - `CK` = HKDF(M, info `"hearth-vault/v1 kek-check"`), an HMAC key for
    `kek_check`;
  - `FK` = HKDF(M, info `"hearth-vault/v1 fingerprint"`), an HMAC key for the
    keyed fingerprints.
- One random 256-bit **data key** (DEK) encrypts every entry. It is stored only
  wrapped (AES-KW, RFC 3394) by `KEK`.
- `kek_check` = HMAC-SHA256(CK, `"hearth-vault/v1 kek-check"`). It lets the hub
  tell "wrong key file" from "corrupt database" at startup without trying an
  unwrap.
- **Rotating the DEK** re-encrypts every entry under a new DEK in one
  transaction (cheap at this scale). Fingerprints do not change, because `FK`
  comes from `M`, not from the DEK.
- **Rotating the master key** rewraps one row and recomputes `kek_check` and
  every fingerprint, in one transaction (procedure below).

**Where the master key lives (options).**

| Option | Unattended restart | Survives a DB leak | Survives a host compromise | Fit |
|---|---|---|---|---|
| Key file (compose secret, `file:` ref) | yes | yes, if the backup excludes it | no | **chosen**: same shape as `model_key` today |
| Env var (`env:` ref) | yes | yes | no; also in `/proc/<pid>/environ` and `docker inspect` | allowed for dev and tests |
| Derived from the owner password (argon2id) | **no**: the vault is locked after every restart until the owner logs in, so triggers and Telegram cannot use secrets; a forgotten password loses the vault | yes | no, while unlocked | rejected as default; possible later as an extra wrap |
| OS keyring | n/a: the hub is a container with no keyring daemon | | | rejected |
| OpenBao transit (KEK in OpenBao) | yes with the static seal; that seal key is again a file | yes | no, on one host | enterprise option (below) |

None of these survives a live hub compromise: the hub must hold the DEK to use
secrets. The key file is the simplest option that keeps a stolen database or
backup useless.

**Generating the key: automatic, never edited by the owner.** PRD §13 says
that from M2 "no credential is kept in `.env` or a file the owner edits". The
vault key is how that holds: every credential the owner types (model keys,
logins, tokens) goes into the vault through the Settings page, and the one file
left is a random key that the owner never types, pastes or edits.
- `docs/install.md` gains a tagged step, run by the install and by every
  upgrade, before `install:up`:

  ```sh install:vault-key
  [ -e secrets/vault_key ] || (umask 077 && head -c 32 /dev/urandom > secrets/vault_key)
  ```

  It creates the file with mode 0600 on the first run and never overwrites an
  existing one, because overwriting the key loses the vault. Running it twice is
  safe.
- The hub does not generate it. The compose secret is a read-only mount, and the
  only place the hub can write is the data volume; a key stored next to the
  database protects nothing.
- The owner's only duty is to back the file up **apart** from the volume
  (install.md's backup section says so). If it is missing anyway, the hub still
  starts, with the vault disabled (next paragraph).

**A missing or wrong key file: the hub starts with the vault disabled.** This
is the one behaviour for every case, including an old compose file that has no
`vault_key` secret at all:
- The hub starts. Login, sessions and every `env:` / `file:` ref keep working,
  so today's `model_key` file and `HEARTH_MODEL*` env config run as before.
- Every `vault:` resolve fails with `vault.disabled` and a reason:
  `key-missing` (no key ref, or the file is absent), `key-mismatch` (the file's
  `kek_check` does not match; the page shows the first 12 hex digits of the
  expected and the found `kek_check`) or `key-invalid` (not 32 bytes).
- The Settings page shows a destructive Alert with that reason and the fix
  ("add deploy/secrets/vault_key", "restore the key file that matches this
  database"). Adding and rotating secrets is disabled until it is fixed.
- If the model key ref is already a `vault:` ref, model calls fail with the
  same reason, and the session view says so.
- On `key-mismatch` the hub never creates a new `vault_key` row and never
  rewrites anything, so restoring the right file recovers the vault.
- A first start with a valid key file and no `vault_key` row creates the DEK.

**Rotating the master key (key file).**
1. The owner writes the new key next to the old one:
   `(umask 077 && head -c 32 /dev/urandom > secrets/vault_key.next)`, mounted as
   a second compose secret with `HEARTH_VAULT_KEY_NEXT_REF=file:/run/secrets/vault_key_next`.
2. On the next start (or `POST /v1/vault/rotate-key` from Settings, after the
   owner password) the hub checks `kek_check` against the current key, unwraps
   the DEK, then in **one transaction** rewraps it under the new `KEK`, writes
   the new `kek_check`, recomputes every fingerprint with the new `FK` (it holds
   the DEK, so it can decrypt each entry), sets `rotated_at`, and audits
   `vault.key.rotate` with the old and new key fingerprints.
3. **Cutover:** the owner moves `vault_key.next` over `vault_key`, drops the
   `next` ref and restarts. The hub logs `vault key rotation complete`.
4. **Crash safety:** at start the hub tries the current key first and then the
   next key. If only the next key matches, the rewrap already committed, and the
   hub runs on the next key with a warning to finish the cutover. If neither
   matches, the vault is disabled (`key-mismatch`). Each step can be run twice.
5. Backups taken before the rotation need the **old** key. Keep the old key
   with those backups until they expire, then destroy it.
- Audit rows keep the fingerprint of the time they were written. After a master
  key rotation, the `vault.key.rotate` row is the link between old and new
  fingerprints.

**Backup and restore.**
- A backup is the volume plus the key file, **kept apart**.
- To restore, put both back. With the volume alone every entry is lost, and the
  UI says so (vault disabled, `key-missing` or `key-mismatch`, with the key's
  fingerprint).
- `bun run --filter @hearth/hub vault export` can write an encrypted export
  (entries re-encrypted under a passphrase-derived key: argon2id plus
  AES-GCM, both from maintained code) for moving between hosts. That is a
  follow-up, not M2.

### 2. Kinds of secret

One table and one ref syntax. The value is JSON inside the ciphertext, so a
kind can add fields without a migration.

| Kind | Encrypted fields | Plain metadata | Used by | Enters a box |
|---|---|---|---|---|
| `model-key` | `value` | `provider` | the runner (hub) | never |
| `login` | `username`, `password`, `totp_seed?` | `origins[]` (exact origins the login may be filled on), `allow_any_field` (default false), `label` | `browser_fill` | the fields filled, for one RPC |
| `token` | `value` | `label`, `use: hub \| box-env`, `hosts[]?` | hub-side tools; box commands only when `use: box-env` | only when `box-env` |

- **References:** `vault:<name>` (the default field: `value`, or `password` for
  a login), and `vault:<name>#<field>` for `username`, `password` and `totp`.
  `#totp` is computed in the hub from the seed with `otpauth` (MIT); the seed
  never leaves the hub, and the six-digit code is valid for 30 s.
- **Names:** `[a-z0-9][a-z0-9._-]{0,63}`. They are not secret and appear in
  events and audit records. A name that fails this pattern is shown only by
  fingerprint, like `displayRef` does today (`secrets.ts:82-96`).

### 3. Use without exposure

**The rule: the model handles names, the hub handles values.** A tool argument
whose value is `vault:<name>[#field]`, in a parameter declared as a secret
parameter, is resolved by the hub just before the tool RPC leaves it. The
resolution point is the one #70 proposes for placeholders, inside the routed
tool's `execute` before `ToolRpcClient.call`. The event log, the trajectory
and the UI keep the reference, never the value.

**Site login (with #107, PR #112).** The tool is #112's `browser_fill`, a
`browser.*` RPC method in protocol 1.3. It takes only a secret; plain text goes
through `browser_type`.

```ts
browser_fill({
  ref: "e42",                      // element ref from the latest snapshot (#112)
  element: "Password field",       // short description for approvals and the live desktop
  secret: "vault:github#password", // a vault ref; a literal value is refused
  submit?: boolean,
  expect?: { ... },                // #112's post-condition
})
// result: #112's { ok, outcome, url, title, verified } + fresh snapshot;
// the value is never echoed, the snapshot shows the field as [secret]
```

The hub side does this, in order:
1. Parse the ref. Look up the entry. Check its scope (global, or this session)
   and its kind (`login`).
2. **Origin check in the hub.** Take the page URL that the box reported for
   that tab in its latest result (the snapshot that produced `ref`). If its
   origin is not in the entry's `origins`, refuse with `browser.origin-mismatch`
   and send nothing. The value never leaves the hub for a page that is already
   on the wrong origin.
3. Write the audit record `secret.use` (action, entry id, session, tool call
   id, the reported origin). No record, no use (PRD §10).
4. Resolve the field and send `{ ref, value, expectOrigins: entry.origins,
   allowAnyField: entry.allow_any_field, field }` in the one tool RPC.

Box-agent then fills it, all on the same page object:
1. It resolves `ref` to one element handle and reads that element's owner
   frame (`elementHandle.ownerFrame()`).
2. **Origin check in the box, immediately before the fill.** The owner frame's
   URL must have an origin in `expectOrigins`. If not, it refuses with
   `browser.origin-mismatch` and fills nothing. This is the anti-phishing check
   that password managers do, and the main defense against a prompt injection
   that says "type your bank password here".
3. **Field check.** The element must fit the field, unless `allowAnyField`:
   - `#password`: an `<input type="password">`, or an input whose
     `autocomplete` is `current-password` or `new-password`;
   - `#username`: an `<input>` of type `text` or `email` whose `autocomplete`
     is `username` or `email`, or that is the text input of the same `<form>` as
     a password input;
   - `#totp`: an input with `autocomplete="one-time-code"`, or a text or number
     input of at most 10 characters (`maxlength`) in a form with no password
     input. The code expires in 30 s, so this rule is looser.
   Anything else (a search box, a comment field, a `contenteditable`, a page
   that echoes the input) is refused with `browser.field-mismatch`. The owner
   sets `allow_any_field` per entry for a site with odd markup; the UI warns
   that the value may then be shown on the page.
4. It fills through that same handle (`elementHandle.fill`, or CDP
   `Input.insertText` if #112 picks a lower layer). If the page navigated
   between the check and the fill, the handle is detached and the fill fails.
5. It records the element in the tab's **filled set** (a Playwright
   `Locator` for the element, plus the value, kept in box-agent's memory only
   for the redaction and masking below). It returns no field content.

The two checks narrow the race between "the page is on the right origin" and
"the value is typed" to the time between step 2 and step 4 in the box. They do
not close it: a same-document change (a script that swaps the form's action or
moves focus) in that window is not detected. And the origin check trusts the
origin, not the content: script injected into a bound origin (XSS) or user
content hosted on it (a profile page, an uploaded HTML file on the same
origin) passes both checks. Both are residuals in the threat model.

**What reaches the model afterwards.** The value is in the box and on the
page, so every later observation of that tab is filtered, for the rest of the
session (not only until navigation; #112 uses the same rule):
- **Text.** Box-agent replaces every secret value it filled on that tab with
  `[secret]` in all later snapshot, find and error texts of the session
  (#112, "Credentials"). The resolved value also joins the runner's per-session
  redaction set (`runners.ts:146-148`) and the hub registry (`redaction.ts:18`),
  and placeholders with encodings once #70 lands. That covers text results,
  events, logs and trajectories.
- **Screenshots.** Hub redaction rewrites strings only, and a screenshot reaches
  the model as an image part (#112, "Screenshots"). A password field shows dots,
  but a username field, a token pasted into a text input, a show-password
  toggle that flips the input to `type="text"`, or a site that echoes the input
  shows the value in pixels. So box-agent passes the tab's filled set to every
  screenshot as Playwright's `mask` option:
  `page.screenshot({ mask: filledLocators, maskColor: "#000" })`. `mask` is
  public API in `playwright-core` 1.65.1: `mask?: Array<Locator>` on
  `PageScreenshotOptions` (`types/types.d.ts:26851`, `26906`) and on
  `LocatorScreenshotOptions` (`types/types.d.ts:26152`), used by
  `page.screenshot` (`types/types.d.ts:4591`). Each masked element is covered by
  an opaque box over its whole bounding box, even when the input type changes.
  If #112 drives screenshots through raw CDP instead, box-agent paints the same
  boxes from the elements' bounding boxes before capture.
- **What the mask cannot cover.** It covers the filled elements only. A site
  that echoes the value somewhere else (a "signed in as <username>" header, a
  preview of a pasted token, an error that repeats the input), and the value in
  page text after a navigation (where the filled element no longer exists), can
  still reach the model as pixels. Text redaction catches those in snapshots,
  not in images. These are residuals, named in the threat model and in the
  DECISIONS "Known gaps". The eval task (#112, B1) checks the login page's
  screenshot for the value.

Rules that keep it narrow:
- Plain `browser_type` / `text` params refuse any string that starts with
  `vault:`, so a reference is never typed as literal text.
- A secret parameter refuses a literal value.
- `#totp` is fillable but `#totp_seed` is not a field.
- Only `login` entries can be used in `browser_fill`; `model-key` entries are
  usable by the runner only.
- Playwright MCP has a similar `secrets` option that only rewrites matching text
  in tool responses. Its README calls it "a convenience and not a security
  feature" (`@playwright/mcp@0.0.85`, README, `secrets` config). Hearth's
  version differs: the model passes a reference instead of a value, the
  fill is origin- and field-bound, and screenshots are masked. It still does not
  stop a page from echoing the value.

**API tokens for tools.**
- Hub-side tools (a future `http_request` run from the hub, webhooks, Telegram)
  take a `vault:` ref in their config and resolve it in the hub. The value never
  goes to the box.
- Box commands that need a token (`gh`, `git push` over HTTPS) get it only if
  the entry is `use: box-env`. Then the bash tool can take
  `env: { GH_TOKEN: "vault:gh" }`, which the hub resolves into the exec RPC for
  that one command, never into the box's environment at large (0018). The
  command can print it, so the result goes through the same redaction. This is
  opt-in per entry and called out in the UI as "this secret will be visible to
  commands in the box".

**Should values enter the box?** Model keys and hub-side tokens: never, the PRD
rule (`docs/PRD.md:400`) stands. Site passwords and `box-env` tokens: only
inside the one RPC that uses them, because the consumer (Chromium, a CLI) is in
the box. Once a password is in a page's input field, anything that can drive
CDP in the box can read it (0026). That is the residual risk; see Threat model.

### 4. UI

See "API and UI sketch". In short: a Settings page with a Model card, a Secrets
table (add, rotate, delete, fingerprints, scope, last use) and a per-secret use
log from the audit table.

### 5. Integration option: store ourselves, or read from a manager?

| | Self-stored (SQLite + WebCrypto) | OpenBao | Vaultwarden / Bitwarden CLI | 1Password (CLI or SDK) |
|---|---|---|---|---|
| License | ours (Bun: MIT) | MPL-2.0 | CLI GPL-3.0; Vaultwarden AGPL-3.0 (not verified) | SDK MIT; service proprietary, paid |
| Extra process | none | one container | `bw` CLI or `bw serve`, plus the Vaultwarden server if self-hosted | none (SDK) or `op` binary |
| Unattended credential in the hub | vault key file | static-seal key file + hub token / AppRole secret | `BW_SESSION` key or master password, which unlocks the **whole** personal vault | service account token (`OP_SERVICE_ACCOUNT_TOKEN`), scoped to chosen vaults |
| Fit with E7 | `vault:` resolver over a local table | `vault:` resolver over KV v2, or a key provider over transit | `bw:` resolver shelling out to `bw get`, or HTTP to `bw serve` | `op:` resolver via the SDK (`op://vault/item/field`) |
| Write from Hearth's UI | yes | yes | yes, through the CLI, but it edits the owner's personal vault | yes with a write-scoped token |
| Site-login metadata (origins, TOTP) | ours | ours, in the KV value | Bitwarden has URIs and TOTP natively | 1Password has URLs and OTP natively |
| Audit of uses | E10 | OpenBao audit device + E10 | E10 only (Bitwarden's event log is an org feature) | E10 + 1Password's activity log |
| Failure mode | key file lost = vault lost | sealed / token expired = no secrets | vault locked or session expired = no secrets | token revoked = no secrets |
| Footprint on a small VPS | 0 | ~95–120 MB RSS, 173 MB binary | Node CLI (19 MB package) | small |

The main argument against Bitwarden and 1Password as the default is the
bootstrap credential. To read one site login unattended, the hub needs
`BW_SESSION` (the session key for the owner's **entire** personal vault) or a
1Password service account token. That turns a hub compromise into a compromise
of every password the owner has, not only those given to Hearth. `bw serve` makes
it worse: it is an HTTP API over the unlocked vault that by default only binds
localhost and blocks requests with an `Origin` header (Bitwarden CLI help, "serve").
The hub runs on the host network (0020), so "localhost" there is the host's
loopback, reachable by every host process.

A dedicated Bitwarden organization or collection, or a 1Password vault with a
service account scoped to it, narrows this. It is a fine opt-in for an owner who
already lives in one of them. **Recommendation:** self-stored by default. Add `bw:`
and `op:` resolvers only on request, read-only, and document that the owner
should scope them to a Hearth-only collection or vault.

### 6. Threat model

Assets:
- model keys, which cost money;
- site logins, which give account takeover;
- tokens, which reach the owner's repos and APIs;
- the vault key.

Adversaries: someone with the database or a backup; someone in the box; a
prompt injection steering the model; someone in the hub.

| Threat | What they get | Mitigation | Residual |
|---|---|---|---|
| **DB leak** (stolen volume, backup, `hearth.db` copied) | ciphertexts, entry names, kinds, origins, timestamps, keyed fingerprints, audit rows | AES-GCM under a DEK wrapped by a KEK that is not in the volume; AAD binds each ciphertext to its row, scope and policy (origins); fingerprints are keyed, so no offline dictionary check | metadata: which sites the owner gave Hearth. Acceptable. |
| **Key file leak alone** | nothing | the key file holds no secret data | |
| **DB and key file together** (whole-host backup, host root) | everything | keep backups apart (install.md); there is no further layer | accepted for a single-owner install |
| **Box compromise** (malicious package, agent ran something bad) | values filled in this box while it runs: a site password in a page field, a `box-env` token during its command | no model keys or hub tokens in the box; fills are per RPC, origin-bound (checked in the hub before the value is sent) and field-bound; box-agent is non-dumpable (0018); scope secrets per session | anything on the CDP-reachable page (0026) or in a command's environment can be read and sent out, because internet egress is open (0023). This is the price of a browser in the box. |
| **Prompt injection** that tries to exfiltrate | it can name refs and use them on bound origins; it does not get values as tool arguments | the model passes refs, not values; text results redacted for the whole session (box-agent `[secret]` plus #70 with encodings); filled elements masked in every later screenshot of the tab; `browser_fill` refuses foreign origins (hub and box) and non-credential fields; `vault:` is refused in plain-text params; per-secret `use: auto \| approve` once approvals land (M3); audit of every use | (1) a site that echoes the value elsewhere on the page, or shows it in page text after a navigation, puts it in a screenshot as pixels, which no string redaction reaches; (2) the model can run JS or a bash command over CDP to read a filled field and encode it beyond what the redactor knows; #112 has no free `evaluate` tool, but `bash` in the box remains; (3) script or user content on a bound origin (XSS, an uploaded page) passes the origin check; (4) a same-document change between the box's check and the fill is not detected. Not airtight; named in DECISIONS. |
| **Hub compromise** (RCE in the hub, malicious pi extension, Docker socket) | everything: the hub holds the DEK and can call any resolver; the hub is root-equivalent via the Docker socket (`deploy/compose.yaml:17-22`) | keep the hub small; extensions allowlisted (0015) | total. Nothing in this design, OpenBao included, changes that while the hub is the one that uses secrets. |
| **Logs, events, trajectories** | values that slipped through | sink redaction (0021) of every resolved vault value, registered at use and at startup for values already used | low-entropy values (a 6-character password) also redact innocent text; encodings until #70 |
| **DB write without the key** (an attacker or a bug that can write `hearth.db` but not read the key file) | can try to widen a login's `origins` or move a session-scoped entry to global | origins, `use`, `hosts`, `allow_any_field` and `scope_session_id` are in the AAD (Data model), so an edited row fails to decrypt and the use fails with `vault.entry-corrupt` | can delete rows or roll a row back to an older copy of itself with its old version; audit rows record the version used |
| **XSS or a stolen login cookie in the UI** | write access to the vault, no read access | the API has **no read-back endpoint**; CSP (0017); `SameSite=Strict` cookie (0014); rotate and delete are audited | an attacker with the cookie can swap a login's password or origins. Require the owner password again for `origins` changes. |

## Recommendation

1. **M2: self-stored vault in SQLite**, WebCrypto AES-256-GCM, envelope DEK/KEK,
   KEK from a key file through the SecretStore, `vault:` resolver, audit of
   every use.
2. **Settings UI for model and secrets**, replacing `.env` model lines and
   `deploy/secrets/model_key`, with an automatic import on upgrade.
3. **`browser_fill` with `vault:` refs** (#112's tool), origin-bound in the hub
   and again in the box, field-bound, resolved in the hub per RPC, redacted
   from text for the whole session and masked in screenshots.
4. **Extensible, not built:** a `VaultKeyProvider` interface (wrap/unwrap the DEK:
   file now, OpenBao transit later) and a `VaultEntryBackend` interface (SQLite
   now, OpenBao KV v2 later). `bw:` / `op:` resolvers only on request.
5. **Not M2:** OpenBao, password-derived keys, export/import, a reveal endpoint
   (never).

## OpenBao, head to head (owner's suggestion)

**License and maintenance.**
- MPL-2.0. A Linux Foundation project and the open-source fork of HashiCorp
  Vault.
- Active: last push 2026-11-12, 373 contributors (GitHub contributors API,
  `repos/openbao/openbao/contributors`, non-anonymous, read 2026-11-16), about
  9k stars, 376 open issues.
- Releases `v2.7.2` and `v2.6.5` both came out on 2026-10-26, and 2.7.x ships
  monthly.
- It moves fast and drops things. 2.7.0 moved every cloud KMS seal and
  `pkcs11` out of the binary into external plugins (`CHANGELOG.md`, GH-3337),
  so pin it and read the changelog on every upgrade.

**Fit with E7.** Yes, cleanly. E7 already says `vault:` / KMS resolvers are the
enterprise extension (`docs/PRD.md:198`), and a `SecretResolver` is one scheme
and one `resolve(body)` (`secrets.ts:184-188`). In this design `vault:<name>` is
the **owner-facing** reference to a vault entry, whatever stores it. OpenBao
plugs in behind it, not as a second syntax:
- **Entry backend = KV v2.** `vault:github#password` reads
  `secret/data/hearth/github` and picks `password`. KV v2 versions give
  rotation history for free.
- **Key provider = transit.** The DEK is wrapped by transit (`datakey/wrapped`
  once, then `decrypt` at startup), and the entries stay in SQLite. The vault
  key file goes away, but the OpenBao token replaces it.
- A raw `bao:<mount>/<path>#field` resolver, for an operator who already keeps
  other secrets in OpenBao, is a third, independent option.

**KV v2 vs transit-only.**

| | Transit-only (entries in SQLite) | KV v2 (entries in OpenBao) |
|---|---|---|
| What OpenBao holds | one key; never sees plaintext entries | every entry |
| Hearth data model | unchanged | `secret` rows become pointers |
| Offline theft of `hearth.db` + a host backup | useless without a live OpenBao (if OpenBao is on another host) | useless without OpenBao |
| Live hub compromise | can call `decrypt` (same as today) | can read every entry its policy allows (same) |
| OpenBao down | hub cannot unwrap the DEK at start; cached in memory afterwards | every resolve fails (30 s cache only) |
| Enterprise value | key custody, rotation, audit of unwraps | the above plus central secrets shared with other systems, per-path policies |

For Hearth's first enterprise step, **transit-only** is the smaller change:
storage, UI and redaction stay identical, and only `VaultKeyProvider` gets a
second implementation. KV v2 is for a deployment that wants OpenBao to be the
system of record.

**Operating it in a single-owner compose install.**
- **One more service:** `openbao` with raft storage on its own volume, listener
  on the hub's loopback (the hub is host-network, 0020) or a private
  network, TLS off only on loopback.
- **Seal.** Without a cloud KMS the options are:
  - Shamir: an operator types unseal keys after **every** restart, which is
    wrong for a VPS that reboots for kernel updates.
  - The built-in **static seal**: a 32-byte AES-256-GCM key "provided ... as a
    file (using the `file://` syntax)" (OpenBao docs, static seal). The docs
    warn it is "only recommended when an existing source of trust ... already
    exists", meaning another secrets manager to chain to. On our single host
    that source of trust is a file, exactly like the vault key file.
  - Transit auto-unseal from a second OpenBao: two servers for one owner.
  - A KMS plugin, which needs a cloud KMS.
- **Probe result:** with the static seal and raft, `bao operator init` returned
  recovery keys and a root token. After a restart the server was `Sealed false`
  with no action. So reboot works, but the unseal key file sits on the same disk
  as the data.
- **Bootstrap on first run:** `operator init` (or the 2.x declarative
  self-initialization, `CHANGELOG.md` GH-2463 and others) has to enable
  transit/KV, write a policy, create an AppRole and hand its `role_id` and
  `secret_id` to the hub. That is a one-shot compose service like
  `box-firewall`, and the root token must be revoked after it.

**Cost on a small VPS.** Measured: 95 MB RSS idle in dev mode, 93 to 121 MB RSS
in server mode with raft after init. The data directory is under 1 MB for a
handful of entries. The Linux binary is 173 MB (71 MB tarball). The hub itself
is one Bun process, so OpenBao would roughly double Hearth's resident control
plane.

**Auth from the hub (the bootstrap problem).**
- AppRole (`role_id` plus a `secret_id` in a compose secret file) or a periodic
  token in a file.
- Either way the hub's credential is a file next to the hub, read through the
  SecretStore (`file:`), so it is protected exactly like `vault_key`. AppRole
  adds `secret_id` TTLs and CIDR binding, which help only if OpenBao runs on
  another machine.
- On one host, OpenBao moves the root of trust from "vault key file" to
  "unseal key file + AppRole secret file". It does not remove it.

**Audit.**
- OpenBao's file audit device logs every request with HMAC'd fields: it records
  that the hub read `hearth/github`. It cannot record which session, tool call
  or origin the read served. E10 can, and E10 rows are in the same database as
  the session they explain.
- Keep E10 as the owner-facing record. OpenBao's log is a second, tamper-evident
  record for an enterprise operator.

**Backup and restore.**
- `bao operator raft snapshot save` (needs a token) plus the unseal key plus
  the recovery keys from `init`.
- Three artifacts with three ways to lose them, against "volume + key file" for
  the self-stored vault.
- Restore needs the same unseal key or a recovery-key rekey.

**Client.** Plain HTTP is enough. The API is a few JSON endpoints with an
`X-Vault-Token` header; the probe used `fetch` only. `node-vault` (MIT,
`0.13.0`, last publish 2026-10-11) exists, but it targets HashiCorp Vault's API,
which is not guaranteed to track OpenBao. There is no official OpenBao JS
client on npm (`@openbao/client` and `openbao` return 404). A 60-line typed
`fetch` wrapper is less risk than a dependency.

**Does M2 need it?** No. For one owner on one VPS it adds a process, ~100 MB,
three backup artifacts, an init one-shot and a changelog to track. Every secret
it guards still traces back to a file on the same host. Its real gains are
off-host key custody, a separate audit trail, central policies and sharing
secrets with other systems, and those are enterprise needs. **Make it optional:**
SQLite with the key file is the default. OpenBao comes in through
`VaultKeyProvider` (transit) first and `VaultEntryBackend` (KV v2) second,
selected by config. In both cases refs stay `vault:<name>`, and the UI does not
change.

### OpenBao: the probe

Dev server (`bao server -dev`, root token `devroot`, loopback) and a Bun
script using only `fetch`:

```ts
async function bao(method: string, path: string, body?: unknown) {
  const r = await fetch(`${addr}/v1/${path}`, {
    method,
    headers: { "X-Vault-Token": token, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status}`);
  return r.json();
}
await bao("POST", "secret/data/hearth/github", { data: { username: "octo", password: "pw-123456" } });
await bao("GET", "secret/data/hearth/github");                       // KV v2 read
await bao("POST", "transit/encrypt/hearth", { plaintext: b64(dek) }); // then transit/decrypt
await bao("POST", "transit/datakey/wrapped/hearth", { bits: 256 });  // envelope DEK
```

Output (Bun 1.4.4, OpenBao 2.7.2):

```
kv v2 write version 1 read back ok: true
transit ciphertext prefix vault:v1: decrypt ok: true
transit datakey/wrapped unwrap ok: true
```

Server mode, `seal "static" { current_key = "file://.../unseal.key" }`, raft
storage: `Initialized false, Sealed true` → `bao operator init` →
`Initialized true, Sealed false`; kill and restart → `Sealed false` with no
operator step. RSS 93 MB after init, 121 MB after restart; raft data 128 kB.

## Data model

Migration N (next free number when it lands):

```sql
CREATE TABLE vault_key (
  id INTEGER PRIMARY KEY CHECK (id = 1),     -- one data key per hub
  wrapped_dek BLOB NOT NULL,                 -- AES-KW(KEK, DEK)
  kek_check TEXT NOT NULL,                   -- HMAC-SHA256(CK, "hearth-vault/v1 kek-check"), hex
  provider TEXT NOT NULL,                    -- 'file' | later 'openbao-transit'
  created_at INTEGER NOT NULL,
  rotated_at INTEGER
) STRICT;

CREATE TABLE secret (
  id TEXT PRIMARY KEY,                       -- sec_<ulid>
  workspace_id TEXT NOT NULL REFERENCES workspace (id),
  name TEXT NOT NULL,                        -- vault:<name>
  kind TEXT NOT NULL CHECK (kind IN ('model-key', 'login', 'token')),
  scope_session_id TEXT,                     -- null = global; in the AAD
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),  -- canonical JSON: origins[], allow_any_field | use, hosts[]; in the AAD
  meta_json TEXT NOT NULL CHECK (json_valid(meta_json)),      -- label, provider; display only, not authenticated
  iv BLOB NOT NULL,                          -- 12 bytes
  ciphertext BLOB NOT NULL,                  -- AES-256-GCM(DEK, iv, json fields, aad)
  version INTEGER NOT NULL,                  -- bumped on rotate; part of the AAD
  fingerprint TEXT NOT NULL,                 -- 'hmac:' + 12 hex of HMAC(FK, primary field)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  UNIQUE (workspace_id, name)
) STRICT;
```

- **AAD** = `hearth-vault/v1|<id>|<workspace_id>|<name>|<kind>|<version>|<scope_session_id or "">|<SHA-256 hex of policy_json>`.
  A ciphertext copied to another row, name or older version fails to decrypt.
  So does a row whose bound origins, `use`, `hosts`, `allow_any_field` or
  session scope was changed by a database write: binding a login to a new
  origin needs the DEK. The resolver decrypts before every use, so it always
  checks the policy it enforces; a failure is `vault.entry-corrupt` and is
  audited. `policy_json` is written in a canonical form (sorted keys, origins
  sorted and lower-cased) so the hash is stable.
- **Changing the policy** (`PATCH` with new origins or scope) re-encrypts the
  entry with a new IV and `version + 1` in the same transaction. The owner
  password is required for an `origins` change (Threat model).
- **Fingerprint key** `FK` = HKDF-SHA256(M, info `"hearth-vault/v1 fingerprint"`),
  derived from the master key, not the DEK, so a DEK rotation keeps every
  fingerprint (see "Envelope and subkeys"). It is keyed, so a leaked fingerprint
  cannot be checked against a dictionary. The display format matches
  `SecretValue.fingerprint` (12 hex) with a different prefix.
- **Delete** removes the row; the audit record keeps id, name and fingerprint.
  There is no soft delete, so no undeleted ciphertext is kept.
- **Uses** go to the existing `audit` table:
  - `action = 'secret.use'`, `resource_type = 'secret'`, `resource_id = id`;
  - `detail_json = {name, field, tool, tool_call_id, session_id, origin, fingerprint}`;
  - plus `secret.create`, `secret.rotate`, `secret.update`, `secret.delete` and
    `settings.model.update`.
- **Settings:** `setting(key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL)`.
  `key = 'model'`: `{provider, model, keyRef: "vault:<name>", modelsFile?}`.

Code layout:
- `packages/core/src/vault.ts`: crypto and the `VaultKeyProvider` /
  `VaultEntryBackend` interfaces, with no SQLite access (boundary rule).
- `apps/hub/src/store/vault-store.ts`: SQLite.
- `VaultSecretResolver` (`scheme = "vault"`), registered next to `env:` and
  `file:` in `createDefaultSecretStore`'s hub counterpart. Its cache
  `invalidate`s on rotate.

## API and UI sketch

**API.** All routes go behind the session guard (0014) and `authorize` (E10).
JSON bodies only (0010).

```
GET    /v1/secrets                    -> [{id, name, kind, scope, policy, meta, fingerprint, version,
                                            createdAt, updatedAt, lastUsedAt}]   // never a value
POST   /v1/secrets                    {name, kind, scope?, policy, meta, fields}  -> 201 {id, fingerprint}
PUT    /v1/secrets/:id/value          {fields}                            -> {fingerprint, version}  // rotate
PATCH  /v1/secrets/:id                {name?, scope?, policy?, meta?}  // name/scope/policy re-encrypt (version+1); origins need {password}
POST   /v1/vault/rotate-key           {password}  -> {kekCheck}   // only with HEARTH_VAULT_KEY_NEXT_REF set
GET    /v1/vault/status               -> {state: "enabled"|"disabled", reason?, kekCheck?}
DELETE /v1/secrets/:id                                                    -> 204
GET    /v1/secrets/:id/uses?before=   -> [{at, tool, sessionId, origin, fingerprint}]  // from audit
GET    /v1/settings/model             -> {provider, model, keyRef, source: "settings"|"env", providers:[...]}
PUT    /v1/settings/model             {provider, model, keyRef}   // 409 when source = "env"
POST   /v1/settings/model/test        {provider, model, keyRef}   -> {ok, latencyMs} | {ok:false, error}
```

- There is no endpoint that returns a value. A forgotten site password is
  recovered at the site, not from Hearth.
- `fields` is write-only. The response echoes the fingerprint so the owner can
  check what was stored.
- `PUT /v1/settings/model` rebuilds the runner's `ModelRuntime` for the next
  turn (today it is built once: `runners.ts:286-307`). A turn already running
  keeps its key.

**UI.** React + Tailwind + shadcn/ui, no other UI library. `apps/web` already
has `card`, `dialog`, `input`, `label`, `badge`, `button`; add `table`,
`select`, `alert-dialog`, `tabs`, `sheet` with the shadcn CLI (DECISIONS 0019).

```
/settings
┌ Tabs: [Model] [Secrets] ────────────────────────────────────────────────┐
│ Model (Card)                                                            │
│  Provider [Select: anthropic ▾]   Model [Select/Input: claude-… ▾]      │
│  Key      [Select: vault:anthropic-key  hmac:3f9a…  ▾] [+ New key]      │
│  [Test connection]  ✓ 412 ms                          [Save]            │
│  (Alert, when env wins) "Set by deploy/.env. Remove HEARTH_MODEL* to    │
│   manage it here."                                                      │
│                                                                         │
│ Secrets (Table)                                     [+ Add secret]      │
│  Name            Kind      Scope      Fingerprint    Last used   ⋯      │
│  github          login     global     hmac:91c2…     2 h ago     ⋯      │
│                  github.com                                             │
│  gh-token        token     session…   hmac:0b7e…     never       ⋯      │
│  ⋯ menu: Rotate (Dialog) · Edit (Dialog) · Uses (Sheet) · Delete        │
│          (AlertDialog: "Sessions using vault:github will fail.")        │
└─────────────────────────────────────────────────────────────────────────┘
```

- **Add / Rotate dialog:** kind (Select), name (Input), fields as
  `type="password"` Inputs with `autoComplete="off"` (a TOTP seed takes the
  `otpauth://` URI or the base32 seed), origins as chips for logins, and a
  scope Select (global, or one session). It shows the new fingerprint after
  save and clears the form state on close.
- **Uses sheet:** a list of the audit rows (time, session link, tool, origin).
- **`box-env` tokens** carry a warning Badge: "visible to commands in the box".

## Migration from today's install

1. **Compose and install.md.**
   - Add `vault_key` as a compose secret (`./secrets/vault_key`) and
     `HEARTH_VAULT_KEY_REF: file:/run/secrets/vault_key`.
   - The install and upgrade steps of `docs/install.md` run the automatic,
     idempotent `install:vault-key` step (see "Generating the key").
     `install:purge` also removes `secrets/vault_key` (`docs/install.md:237`).
2. **First start with a vault** and no `setting.model` row: if
   `HEARTH_MODEL_KEY_REF` resolves, the hub imports it. It creates entry
   `model-key-<provider>` (kind `model-key`) and writes
   `setting.model = {provider, model, keyRef: "vault:model-key-<provider>",
   modelsFile}` from the current env. It audits `settings.model.import`, logs
   one line with the fingerprint, and shows a dismissible Alert in Settings.
3. **Precedence during the transition:** if `HEARTH_MODEL` is set in the
   environment, env wins and the UI shows the model card read-only ("set by
   deploy/.env"). That keeps every existing install and test that sets env
   working. The owner unlocks the UI by emptying `HEARTH_MODEL*` in `.env`.
4. **One release later,** `compose.yaml` drops the `model_key` secret and the
   hard-coded `HEARTH_MODEL_KEY_REF`, `hearth.env.example` drops the model lines,
   and the hub warns if they are still set. `env:` and `file:` refs keep working
   for anyone who wants them (the settings UI accepts any ref).
5. **No vault key file at all on an old compose file:** the same rule as any
   missing key ("A missing or wrong key file"): the hub starts with the vault
   disabled, runs as today (env model config, `file:` model key), and the
   Settings page shows "vault disabled: add deploy/secrets/vault_key". No data
   is lost, nothing is generated into the volume, and the import of step 2
   waits until a key file is present.

## Proposed DECISIONS text

> ## 00NN: The vault: encrypted secrets in SQLite behind `vault:` refs, model settings in the UI
>
> - Date: (at merge)
> - Status: proposed
> - Issue: #108
>
> ### Context
>
> The model key is a compose secret file and the model a `.env` line (0020). Site
> logins and tool tokens have no home. E7 resolves only `env:` and `file:`.
>
> ### Decision
>
> - **Store.** Secrets are rows of a `secret` table. Each row is encrypted with
>   AES-256-GCM (WebCrypto in Bun, fresh 96-bit IV, AAD = id, workspace, name,
>   kind, version, session scope and a hash of the policy: bound origins, `use`,
>   `hosts`, `allow_any_field`) under one data key. The data key is stored only
>   wrapped with AES-KW. No other crypto, no hand-written primitives.
> - **Vault key.** 32 random bytes in `deploy/secrets/vault_key`, generated
>   automatically by the install and upgrade step (mode 0600, never overwritten,
>   never typed or edited by the owner, backed up apart from the volume), a compose
>   secret read through the SecretStore (`HEARTH_VAULT_KEY_REF`). HKDF-SHA256
>   derives three subkeys from it: the wrapping key, the `kek_check` key and the
>   fingerprint key. It is never generated into the data volume. If it is
>   missing, invalid or does not match, the hub still starts with the vault
>   disabled, `env:` / `file:` refs keep working, and Settings shows the reason.
>   Rotation supplies `vault_key.next` beside it, rewraps in one transaction,
>   then cuts over. Backup is the volume plus the key file, kept apart. Losing
>   the key loses the vault.
> - **Refs.** `vault:<name>[#field]` through a `VaultSecretResolver` (E7). Kinds
>   are `model-key`, `login` (username, password, TOTP seed, bound origins) and
>   `token` (`use: hub | box-env`). `#totp` is computed in the hub; the seed never
>   leaves it.
> - **No read-back.** The API and UI write, rotate, delete and list
>   fingerprints (keyed HMAC); they never return a value.
> - **Use without exposure.** Tools take a ref in parameters declared as secret.
>   The hub audits the use (E10, before the use), resolves the ref at the tool
>   RPC boundary and puts the value only in that RPC. It redacts the value
>   from results, events, logs and trajectories (0015, 0021, #70).
>   `browser_fill` (#112) fills a `login` only when the page origin the box
>   reported (checked in the hub) and the element's frame origin (checked in
>   the box just before the fill) are in the entry's origins, and only into a
>   password, username or one-time-code field unless the entry allows any
>   field. Box-agent replaces filled values with `[secret]` in text for the rest
>   of the session and masks filled elements in every later screenshot of the
>   tab (Playwright `screenshot({ mask })`). Model keys and `use: hub` tokens
>   never enter a box.
> - **Model settings** move to a `setting` row edited in the UI. `HEARTH_MODEL*`
>   in the environment wins while set (read-only card), and on first start the
>   current key file is imported.
> - **Extension points.** `VaultKeyProvider` (file now; OpenBao transit later)
>   and `VaultEntryBackend` (SQLite now; OpenBao KV v2 later). Bitwarden and
>   1Password are possible later as optional read-only `bw:` / `op:` resolvers.
>
> ### Consequences
>
> - A stolen database or volume backup reveals names, kinds and origins, not
>   values.
> - A hub compromise reveals everything, as before. A box compromise reveals
>   only the values filled into that box during the session.
> - **Known gaps:**
>   - a command in the box can read a filled field over CDP (0026) and send it
>     out over open egress;
>   - screenshots are masked only over the filled elements: a site that echoes
>     the value elsewhere, or shows it in page text after a navigation, puts it
>     in a screenshot the model sees;
>   - script or user content on a bound origin (XSS, an uploaded page) passes
>     the origin check;
>   - a same-document change between the box's origin check and the fill is not
>     detected;
>   - redaction misses encodings it does not know;
>   - short values over-redact.
>
>   Approvals (M3) can gate `browser_fill` per secret.

## Proposed follow-up issues

1. **core+hub: vault store.** Migration (`vault_key`, `secret`, `setting`),
   WebCrypto envelope, keyed fingerprints, `VaultSecretResolver`, the
   `VaultKeyProvider` / `VaultEntryBackend` interfaces with file and SQLite
   implementations, startup key check, vault-disabled state, master key
   rotation with `vault_key.next`. Tests:
   - a wrong AAD, wrong key and swapped rows fail;
   - a row whose `policy_json` or `scope_session_id` was edited in SQL fails;
   - a missing or wrong key file starts the hub with the vault disabled;
   - a crash between rewrap and cutover recovers on either key;
   - no value appears in any error or log;
   - rotate invalidates the cache.
2. **hub: secrets API and audit.** The routes above, `secret.*` audit actions
   written before the action, `authorize` on each, and no read-back (a test that
   greps every response for the stored value).
3. **hub: model settings and runtime reload.** The `setting.model` row, env
   precedence, `POST /v1/settings/model/test`, and a rebuild of the runner's
   `ModelRuntime` on change. The first-start import of `HEARTH_MODEL_KEY_REF`.
4. **web: Settings page.** Model card and Secrets table with
   Dialog/AlertDialog/Sheet, using shadcn components only. dom tests for
   write-only fields and the env-locked state.
5. **deploy: vault key and migration.** Compose secret, `install.md` upgrade
   and purge steps, the backup section ("volume and key apart"), and the
   later removal of `model_key` (a second, smaller issue one release later).
6. **security(hub): redact vault values** at use and at startup for values
   already used, including in pi's context and trajectories. Fold the encoding
   work into #70.
7. **box+hub: `browser_fill` with `vault:` refs** (blocked on #107's tool
   surface). Covers secret params, origin check in box-agent, refusal of
   `vault:` in plain text params, the hub and box origin checks, the field
   check, session-wide `[secret]` text redaction, screenshot masking, and an
   eval task with a local login page that also checks a screenshot after a
   show-password toggle.
8. **hub: TOTP for logins** with `otpauth` (MIT), `#totp` field.
9. **hub: `box-env` tokens** for one exec RPC (opt-in per entry, UI warning).
10. **Later / enterprise:** an OpenBao transit `VaultKeyProvider` (then a KV v2
    backend) with an AppRole credential through the SecretStore. Optional `bw:`
    and `op:` read-only resolvers. An encrypted export/import. A per-secret
    `use: approve` once approvals (M3) exist.
