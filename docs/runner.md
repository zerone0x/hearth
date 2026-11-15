# The hub's pi runner (decision 0015)

One pi session per hub session runs in the hub; its file and shell tools run
in the session's box through the tool RPC (0009, 0011). Tests use pi-ai's faux
provider and need no model key.

## Run it with a real model key

The key never goes to pi through the environment: the hub resolves
`HEARTH_MODEL_KEY_REF` through its `SecretStore` (`env:NAME` reads `NAME`) and
hands the value to pi in memory (`ModelRuntime.setRuntimeApiKey`). Without
`HEARTH_MODEL` the runner is off and the message routes are not served.

```sh
bun install
docker build -t hearth-box:dev apps/box-agent   # or the image you use (decision 0004)
export ANTHROPIC_API_KEY=sk-ant-...             # your key
HEARTH_BOX_IMAGE=hearth-box:dev \
HEARTH_BOX_EGRESS=unrestricted \
HEARTH_MODEL_PROVIDER=anthropic \
HEARTH_MODEL=claude-sonnet-4-5 \
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

## Tests

```sh
bun test apps/hub/src/runner
```
