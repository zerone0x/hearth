# The hub's pi runner (decision 0015)

One pi session per hub session runs in the hub; its file and shell tools run
in the session's box through the tool RPC (0009, 0011). Tests use pi-ai's faux
provider and need no model key.

## Run it with a real model key

The key never goes to pi through the environment: the hub resolves
`HEARTH_MODEL_KEY_REF` through its `SecretStore` (`env:NAME` reads `NAME`) and
hands the value to pi in memory (`ModelRuntime.setRuntimeApiKey`). Without
`HEARTH_MODEL` the runner is off and the message routes are not served. A
provider error that echoes the key is stored and logged with the key replaced
by `[redacted]`.

```sh
bun install
docker build -t hearth-box:dev apps/box-agent   # or the image you use (decision 0004)
export ANTHROPIC_API_KEY=sk-ant-...             # your key
HEARTH_BOX_IMAGE=hearth-box:dev \
HEARTH_BOX_EGRESS=unrestricted \
HEARTH_MODEL_PROVIDER=anthropic \
HEARTH_MODEL=claude-sonnet-5-5 \
HEARTH_MODEL_KEY_REF=env:ANTHROPIC_API_KEY \
bun apps/hub/src/main.ts
```

Any provider and model id pi 1.5.2 knows works (`openai` / `gpt-...`, and so
on). Then, from another shell (log in first, decision 0014):

```sh
HUB=http://127.0.0.1:8787
J='-H content-type:application/json'
curl -s -c jar $J -X POST $HUB/v1/auth/login -d '{"password":"<owner password>"}'
SID=$(curl -s -b jar $J -X POST $HUB/v1/sessions -d '{"title":"try"}' | jq -r .session.id)
# optional, before the first message: pi's codemode tool (off by default)
curl -s -b jar $J -X POST $HUB/v1/sessions/$SID/runner -d '{"codemode":true}'
curl -s -b jar $J -X POST $HUB/v1/sessions/$SID/messages -d '{"text":"create hello.txt and cat it"}'
curl -s -b jar "$HUB/v1/sessions/$SID/events?after=0&limit=200" | jq '.events[].type'
# resume: pass the returned .cursor as after=
curl -s -b jar $J -X POST $HUB/v1/sessions/$SID/interrupt -d '{}'
curl -s -b jar $HUB/v1/sessions/$SID/runner
```

## Config

| Setting | Meaning |
|---|---|
| `HEARTH_MODEL_PROVIDER`, `HEARTH_MODEL` | pi provider and model id |
| `HEARTH_MODEL_KEY_REF` | SecretStore reference of the provider key |
| `runner.config.denyList` (`startHub`) | `[{tool, pattern?, reason?}]`: a call whose bash command or path matches never leaves the hub |
| `runner.config.extensionAllowlist` | `[{name, version}]` of bundled extensions allowed to load; empty by default |

### The deny-list is best-effort, not a boundary

`tool` is a tool name or `*` for any tool. A rule without `pattern` blocks
every call of its tool. A `pattern` is tested against the bash command, the
path, or the input as JSON for other tools. A path is also tested in its
normalized form, resolved against `/workspace` with `//`, `.` and `..`
collapsed, so `/workspace/../etc/passwd`, `//etc/passwd` and
`../../etc/passwd` all match `^/etc/`.

A regex over a shell command cannot stop a determined model. These get past
an `rm\s+-rf` rule and are known: `rm -fr`, `rm -r -f`, `X=rm; $X -rf`,
`bash -c "r""m -rf"`, `base64 -d | sh`. Write content is not tested, only the
path. The box is the boundary; approvals with a human in the loop are M3.

## Browser tools (decision 0032)

Every session also has the `browser_*` tools: `browser_navigate`,
`browser_back`, `browser_forward`, `browser_snapshot`, `browser_find`,
`browser_click`, `browser_type`, `browser_select`, `browser_press`,
`browser_wait`, `browser_screenshot` and `browser_tabs`. They drive the box
desktop's Chromium over CDP, so the owner watches them on the live desktop. Results carry an accessibility snapshot
whose refs (`s3e12`) are valid until the next snapshot or action; an acting
call with `expect` is checked by the box, and one that is not `done` fails
the tool call. Screenshots reach the model as image results. A box image
older than protocol 1.3 answers that it has no browser tools. While the owner
holds the desktop lock they refuse at once with `desktop.locked` (below,
decision 0035).

## Desktop lock: agent desktop and browser tools (decision 0033)

While the owner holds a session's desktop lock (the Take over button), the
agent's desktop and browser input tools must not act. The hub exposes the
check as `hub.desktopLocks` (`apps/hub/src/desktop/lock.ts`):

| Call | Answer |
|---|---|
| `isDesktopLocked(sessionId)` | `true` while someone holds the lock (a lapsed lease counts as free) |
| `assertUnlocked(sessionId)` | throws `HearthError` code `desktop.locked`, message `user is in control` (owner `user`, disposition `retry`) while it is held |
| `holder(sessionId)` | `{ kind, principalId }` or `undefined` |

Every `browser_*` tool, the read-only ones included, calls `assertUnlocked`
through `RunnerBox.assertDesktopUnlocked` before it takes a box lease, so a
refused call neither wakes the box nor sends it anything (decision 0035). It
does not wait: the tool call fails at once with `DESKTOP_LOCKED_MESSAGE`
(`desktop.locked: user is in control.`, then wait and try again, or ask the
user), and the model decides what to do. The trajectory step of the call has
`outcome: "desktop-locked"` and `refused_code: "desktop.locked"`. Releasing
the lock, closing the tab and a lapsed lease all free it at once; the next
call succeeds. `startHub` hands its `DesktopLocks` to the runners; runners
made without one (tests) are never locked.

## Tests

```sh
bun test apps/hub/src/runner
```
