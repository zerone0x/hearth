# Research: how Hearth's agent should drive the box's Chromium

> Issue #107 (for M2, #93) · 2026-11-16 · docs plus a throwaway spike branch. Owner: @zerone0x

## Sources and how to read the citations

Every `path:line` below is in the tree at the commit named here. Each repo was
shallow-cloned on 2026-11-16. Stars and push dates come from the GitHub REST API
(`GET /repos/{owner}/{repo}`) on the same day.

| Short name | Repo | Commit | License | Stars, last push |
|---|---|---|---|---|
| ego-lite | [citrolabs/ego-lite](https://github.com/citrolabs/ego-lite) | `f499162d1b911ba9b320ed31b741dba7ebc2e4d6` | MIT (repo only, `README.md:155-157`) | 23,140, 2026-11-16 |
| verified-actions | [raydocs/egolite-jev](https://github.com/raydocs/egolite-jev) | `6c4b5ee72d46e9594e8d9a4996cb374be81a109f` | MIT | 5, 2026-11-11 |
| decision-layer | [jiangkoumo/ego-decision-layer](https://github.com/jiangkoumo/ego-decision-layer) | `24743cc4e416fe37b4eaa7917f68a0868f91830e` | MIT | 31, 2026-10-28 |
| dsh-browser-cdp | [drscrewdriver/dsh-browser-cdp](https://github.com/drscrewdriver/dsh-browser-cdp) | `e16d486c016564bd0fd2347f0b0dced3d44d1fdc` | MIT | 45, 2026-11-15 |
| ego-lite-bridge | [imleon/ego-lite-bridge](https://github.com/imleon/ego-lite-bridge) | `aeadbba958009266414dc99abf209d39f937bff4` | Apache-2.0 | 2, 2026-11-01 |
| playwright-mcp | [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) | `5b000eb91f60b3e4c03acc69d04c9562d1c7f82f` | Apache-2.0 | n/a |
| stagehand | [browserbase/stagehand](https://github.com/browserbase/stagehand) | `9d3cfa51589ab1fdc85e16ddfc09f8c44dc7e2b9` | MIT | n/a |
| browser-use | [browser-use/browser-use](https://github.com/browser-use/browser-use) | `4b5b1b0aa0ab45a1d6a2a31984d37d3e748c0134` | MIT | n/a |
| CRI | [cyrus-and/chrome-remote-interface](https://github.com/cyrus-and/chrome-remote-interface) | `a2e85b8094bc5af41db6e891e59e8d551a79fa86` | MIT | n/a |

`raydocs/egolite-jev` is the repo the issue names. Its description and homepage
point to `raydocs/ego-verified-actions`, and both URLs clone to the same commit,
so it was renamed. The skill inside is called "ego-verified-actions".

**npm registry** (`https://registry.npmjs.org/<pkg>` and
`https://api.npmjs.org/downloads/point/last-week/<pkg>`, read 2026-11-16):

| Package | Latest | Published | License | Unpacked | Runtime deps | Weekly downloads |
|---|---|---|---|---|---|---|
| `playwright-core` | 1.65.1 | 2026-11-13 | Apache-2.0 | 13.97 MB | none | 191,813,099 |
| `@playwright/mcp` | 0.0.85 | 2026-11-09 | Apache-2.0 | 96 KB | `playwright`, `playwright-core` | 10,908,336 |
| `@browserbasehq/stagehand` | 4.4.0 | 2026-11-04 | MIT | 4.14 MB | `zod`, `@browserbasehq/sdk`, two `@opentelemetry/*` | 2,600,476 |
| `chrome-remote-interface` | 0.34.0 | 2026-02-09 | MIT | 2.03 MB | `commander`, `ws` | 2,957,919 |
| `puppeteer-core` (not asked, for scale) | 25.17.0 | 2026-11-10 | Apache-2.0 | 6.27 MB | 6 | 33,415,826 |

**PyPI** (`https://pypi.org/pypi/browser-use/json`, read 2026-11-16):
`browser-use` 1.0.6, Python `>=3.11,<4.0`.

**playwright-core API.** The API notes cite the type declarations shipped in
`playwright-core@1.65.1` (`types/types.d.ts`), which hold the public API docs.

**Hearth side.** `main` at `87e21dc31f6cb5f4e27c9ff39abe2df1751230f0`: PRD,
DECISIONS 0011, 0012, 0018, 0021, 0026, and issues #70, #71, #93, #108.

**Spike.** The branch `spike/browser-playwright-core` is at
`f2e6d4b4d537c8fe7672b4df93a816891d3f35de` and will not be merged. Its
`spikes/browser/run.log` is the output quoted in [Spike](#spike).

**Not read, so not verified:**
- The ego lite browser itself. It is a closed, separately downloaded app
  (`README.md:155-157`), so nothing here about its snapshot engine is verified
  beyond what its open SDK and docs say.
- TypeSafe's "Jev" model. It is hosted, and the repo ships no weights
  (verified-actions `NOTICE`, lines 1-4).
- The docs site lite.ego.app.
- Playwright's own source tree. Playwright MCP's server code ships inside the
  `playwright` package, and this repo only wraps it (`package.json:39-42`). Its
  snapshot behaviour was checked by running `playwright-core` in the spike, not
  by reading the code.

**Clean room.** This doc describes mechanisms in our own words. No code from
these projects is copied into Hearth. If an idea is built, it is built from this
description, and a DECISIONS entry credits it.

## Summary

- **ego lite is a browser, not a library we can use.** The open repo
  (citrolabs/ego-lite, MIT) holds the agent skill and the `ego-browser` SDK. The
  SDK runs inside the closed ego lite app and talks CDP through a native
  `globalThis.ego` bridge (`package/ego-browser/src/browser-runtime.ts:414-425`).
  Its snapshot is native (`package/ego-browser/src/driver/observe.ts:54-56`).
  It ships for macOS and Windows only; Linux is "on the roadmap"
  (`README.md:43`). So it cannot run in the box. The projects around it are
  skills on top of the same app (verified-actions, decision-layer), a plugin
  for another agent host (dsh-browser-cdp), or an SSH bridge to a Mac
  (ego-lite-bridge).
- **Its ideas are worth taking.** The ecosystem's best ideas carry over to any
  CDP driver:
  1. **Verified actions.** An action counts as done only when code checks an
     observable condition (URL, title, visible text) afterwards. The model's
     own "done" does not count (verified-actions
     `references/contract.md:53-62`).
  2. **Fail closed before acting.** Refuse stale, covered or disabled targets
     before dispatch (decision-layer `README.en.md:97`).
  3. **Guarded actions.** Pay, delete and sign-out controls go back to the
     caller (verified-actions `scripts/lib.js:44-47`).
  4. **Snapshot last.** Return the fresh snapshot with the action's result, so
     the next turn does not need a separate observe call (ego-lite
     `package/ego-browser/skill-body/SKILL.md:219-228`).
- **Recommendation: `playwright-core` (1.65.1, Apache-2.0, no runtime deps)
  in box-agent, through `connectOverCDP("http://127.0.0.1:9222")`, with
  Hearth's own small tool layer.** Its public API now has exactly the parts the
  agent needs: `page.ariaSnapshot({ mode: "ai" })` returns the accessibility
  tree with `[ref=eN]` refs (`types.d.ts:2098-2139`), and
  `page.getByRef("e2")` resolves a ref to a locator with Playwright's
  actionability waits (`types.d.ts:3159-3176`). That is the same model
  Playwright MCP exposes, without running an MCP server in the box.
- **The spike confirms it works from Bun:** connect in 281 ms, snapshot in
  14-114 ms, 300-820 characters for a login page and a 5-field form, and
  verification that catches a click that "worked" but did nothing. It also
  found two traps the design must handle:
  - **A password field's value shows up in the aria snapshot.** The fill
    value has to be redacted from every result.
  - **A stale ref waits out the full action timeout** instead of failing
    fast.
- **Skip:**
  - Stagehand. It makes its own LLM calls with its own API key from inside
    the box (`README.md:59-62`), which bypasses the hub's model, redaction and
    trajectory.
  - browser-use. It is a Python agent with its own loop
    (`pyproject.toml:18-29`).
  - Playwright MCP as a process. It is an extra server and protocol hop, and
    its own docs now steer coding agents to a CLI instead (`README.md:9`).
  - chrome-remote-interface. It is raw CDP: the snapshot, refs,
    actionability and waits would all be ours to write.

---

## The ego lite ecosystem

### ego lite (citrolabs/ego-lite)

**What it is.** ego lite is a Chromium-based desktop browser shared by a person
and their agents. Each agent works in its own "Space" inside the same browser
(`README.md:33-35`, `README.md:96-97`). The app is a free download. Only the
repo contents are MIT (`README.md:155-157`). It runs on macOS and Windows, and
Linux is "on the roadmap" (`README.md:43`).

**How an agent drives it.** The agent does not call one tool per click. It
writes a JavaScript snippet against an SDK (`taskSpace`, `page.goto`,
`page.snapshot`, `page.click`, ...), and `ego-browser nodejs` runs the whole
snippet in one pass (`README.md:95`, `README.md:99`,
`package/ego-browser/skill-body/SKILL.md:27-32`). The guide tells the agent to:
- batch the actions it can already plan;
- wait on an observable condition (`waitForURL`, `waitForSelector`,
  `waitForFunction`), not a fixed delay;
- print the fresh snapshot last, so the next round can act without
  re-observing (`skill-body/SKILL.md:219-233`);
- use a snapshot by default and a screenshot only for visual confirmation, not
  both (`skill-body/SKILL.md:204-212`).

**Observation model.** The "Snapshot" is the page turned into an indented text
tree with `[ref=N]` handles, produced inside the browser engine
(`README.md:98`; `docs/native-snapshot-ref-requirement.md:3-25` is the spec
for the native side: drop empty text and unnamed single-child containers, keep
refs and iframe boundaries). Refs inside iframes are a stated gap
(`docs/native-snapshot-ref-requirement.md:39-73`).

**The CDP bridge.** The SDK is "a TypeScript single-file build of the
ego-browser CDP harness" (`package/ego-browser/package.json:4`). It sends CDP
through `globalThis.ego.sendCDPMessage`, a native binding of the app
(`package/ego-browser/src/browser-runtime.ts:414-425`), and calls the native
`ego.snapshot()` for observation (`package/ego-browser/src/driver/observe.ts:54-56`).
It is therefore not a CDP client for a stock Chromium: without the app's
runtime it throws `browser runtime is not available`
(`browser-runtime.ts:420-424`).

**Benchmark claims.** "31 complex browser automation tasks on live websites",
with the same agent (pi) and model across tools (`README.md:120-130`). The raw
data is not in the repo, so these numbers are unverified here.

**What Hearth takes:**
- **Snapshot-first observation.** Use refs, and take a screenshot only on
  request.
- **Snapshot last.** Return the fresh snapshot with each action's result.
- **Wait on conditions.** Never use fixed delays.

**What Hearth does not take:**
- **The app.** It cannot run in a Linux box.
- **The code-mode SDK.** The model writing JavaScript that runs against the
  browser is powerful, but in Hearth the same thing is already possible: the
  agent can write a script and run it with `bash` in the box (CDP is open to
  every box command, 0026). Hearth should not add a second, browser-shaped
  code runner.

### Verified actions (raydocs/egolite-jev, "ego-verified-actions")

A skill that runs a bounded click loop on ego lite with a small hosted
decision model (TypeSafe Jev). It needs a TypeSafe or OpenRouter key
(`references/contract.md:14`). The important part is its contract, not its
model:

- **Inputs:** `GOAL`, `SUCCESS_MATCH`, and a step budget (default 4, hard cap
  8) (`references/contract.md:14-24`).
- **`ok` is decided by code alone.** It is true only if `SUCCESS_MATCH`
  appears in the lower-cased `url + " " + title` of the final page. "Jev
  `DONE` is never success" (`references/contract.md:53-56`;
  `scripts/lib.js:151`).
- **Typed stop reasons:** `done`, `need_llm` (low confidence, a guarded
  control, a failed click, a missing fill value), `dialog`, `budget_exhausted`
  (`references/contract.md:58-62`).
- **Guarded controls.** A keyword list (buy, pay, checkout, delete, remove,
  unsubscribe, sign out, transfer, and Chinese equivalents) makes the loop
  stop and hand back instead of clicking (`scripts/lib.js:44-47`,
  `scripts/loop.js:93-95`).
- **Opaque candidates.** The model sees `click_1`, `fill_1`, ..., never real
  DOM refs, and its answer is validated: the choice must be an allowed key,
  probabilities must sum to 1 ± 0.02, and so on
  (`references/contract.md:73-96`).
- **Wait policy.** Track new tabs and URL changes after a click. Wait for load
  only if one happened; otherwise wait 150 ms (`references/contract.md:64-71`).

**What Hearth takes:**
- **The `expect` → `verified` contract.** Every acting tool takes an optional
  expectation, and the result says whether code saw it hold.
- **Typed stop reasons.**
- **The guard idea.** In Hearth it becomes an approval trigger (M3, #71), not
  a hard refusal.

The small-model decider is out of scope: Hearth has one brain (the runner's
model), and a second hosted model is a second key and a second trust boundary.

### Decision layer (jiangkoumo/ego-decision-layer)

The same idea grown into an engine. A small model picks one operation and
target per step from an "indexed element table", and "code owns observation,
execution, verification and exit conditions" (`README.md:14-20`,
`README.en.md:7`). It runs on ego lite (`README.en.md:13`). There is also a
second host for an external Chrome over CDP, whose real-browser acceptance "has
not been run in this repo" (`docs/CDP-USAGE.md:1-8`).

Useful details:
- **Execution guards.** They "reject stale, covered, unavailable and
  unresolved frame targets before dispatch", plus a keyword guard for
  dangerous actions (`README.en.md:97`). The covered check is a hit test at
  the element's point in its own root (`scripts/decider-loop.mjs:1017-1035`).
- **Exit by code.** `--until <substring>` of the final URL (`README.md:115-120`).
- **Measured costs** (their numbers, unverified here): a self-built element
  table takes 2-4 ms for about 2k characters, against 110-130 ms and 27,484
  characters for the native snapshot. A raw CDP dispatch takes 13-16 ms
  against 788-1005 ms for `page.click(ref)` (`README.md:62-64`).

**What Hearth takes:**
- **Pre-dispatch checks that fail closed.** Playwright's actionability checks
  already cover visible, enabled, stable and receives-events. Hearth adds one
  fast stale-ref check (see [Spike](#spike)).
- **The cost lesson.** Snapshot size is the main token cost, so scope and cap
  it.

### CDP bridges: dsh-browser-cdp and ego-lite-bridge

- **dsh-browser-cdp** (npm `dsh-browser-cdp`, 1.12.2) is a plugin for another
  agent host. It drives a vendored "ego-compatible Chromium" over CDP, or
  attaches to Chrome/Edge/Brave, and exposes 35 `bcdp_*` tools
  (`package.json:2-4`). Its user-facing tool set is the familiar one:
  navigate, snapshot, click, fill, screenshot, tabs, js, http, plus a
  multi-step `bcdp_script` escape hatch (`README.md:202`). It also imports
  login cookies from the user's desktop browser (`README.md:49`). It is tied
  to its host's plugin API (peer dependencies, `package.json:78-88`), so
  Hearth cannot reuse it. Its takeaway is the tool list: two dozen tools
  collapse to about eight that matter.
- **ego-lite-bridge** forwards a Linux `ego-browser` command over SSH to a Mac
  that runs the real app (`README.md:5`, `README.md:11-18`). It is a
  workaround for the missing Linux build, not something a box can use.

**Primary source and docs.** The primary source is citrolabs/ego-lite.
Its docs are at lite.ego.app/document (linked from `README.md:134`, not
read). Everything else listed above is third-party and built on that app.

---

## Candidates outside the ego ecosystem

### Playwright MCP (`@playwright/mcp`)

- **Observation.** "Structured accessibility snapshots, bypassing the need for
  screenshots" (`README.md:3`, `README.md:15`). `browser_snapshot` takes
  `target` (a subtree), `depth` and `boxes` (`README.md:1141-1149`).
  `browser_find` searches the snapshot instead of returning all of it
  (`README.md:1031`).
- **Action.** Tools take a `target` (a ref from the snapshot, or a selector)
  and an optional `element`, a "human-readable element description used to
  obtain permission to interact with the element" (`README.md:930-937`, the
  same pattern on every acting tool). Hearth should copy that field for M3
  approvals.
- **Tool set.** The core set: `browser_navigate`, `browser_snapshot`,
  `browser_click`, `browser_type` (`text`, `submit`, `slowly`),
  `browser_fill_form`, `browser_select_option`, `browser_press_key`,
  `browser_wait_for` (`text`, `textGone`, `time` ≤ 30 s),
  `browser_take_screenshot`, `browser_tabs`, `browser_handle_dialog`, and
  more (`README.md:925-1200`). The vision, network, storage, devtools, pdf
  and testing tools are opt-in through `--caps` (`README.md:415`,
  `README.md:1214-1646`).
- **Connecting to an existing browser.** `--cdp-endpoint` (`README.md:416`).
- **Images.** `--image-responses allow|omit|only` (`README.md:437`).
- **Secrets.** `secrets` replaces matching plain text in tool responses, but
  "it is a convenience and not a security feature" (`README.md:698-711`).
  Origin allow and block lists "do not serve as a security boundary"
  (`README.md:410-412`).
- **Its own position.** Coding agents "increasingly favor CLI-based
  workflows" over MCP, to avoid large tool schemas and verbose trees
  (`README.md:9`).

**For Hearth:**
- **Do not run it as a process.** The runner does not speak MCP to the box.
  The tools are routed over Hearth's own RPC (0011). It would add a Node
  server per box speaking stdio or HTTP, and box-agent would have to proxy
  MCP. It also brings the full `playwright` package, not just `-core`
  (`package.json:39-42`).
- **Do copy its observation and ref model.** It is now public API in
  `playwright-core` itself (next section).

### `playwright-core` with `connectOverCDP` (recommended)

- **Connect.** `chromium.connectOverCDP("http://127.0.0.1:9222")`, then the
  default context and page (`types.d.ts:17460-17486`). It attaches to a
  browser it did not launch, which is the box's case (0026). Caveat from the
  same doc: it is "significantly lower fidelity" than Playwright's own
  protocol, and a browser launched with different flags "may" break some
  features (`types.d.ts:17460-17468`). The spike's snapshot, ref, fill,
  select, check, click and screenshot calls all worked over it.
- **Disconnect without killing.** For a connected browser, `close()` clears
  the contexts it created and disconnects (`types.d.ts:11219`). The
  supervisor-owned Chromium keeps running.
- **Observation.** `page.ariaSnapshot({ mode: "ai" })` adds `[ref=e2]` refs
  and iframe snapshots. `boxes: true` adds bounding boxes, and `depth` limits
  the tree (`types.d.ts:2098-2139`). `locator.ariaSnapshot()` scopes it to a
  subtree (`types.d.ts:14614`).
- **Action.** `page.getByRef("e2")` resolves a ref "against the latest
  snapshot taken in the element's frame" (`types.d.ts:3159-3176`). The
  locator then gets Playwright's actionability waits and its standard
  `click`, `fill`, `selectOption`, `check`, `press`.
- **Package.** 13.97 MB unpacked with no runtime dependencies, Apache-2.0,
  released every few weeks (npm data above). It needs no browser download:
  `-core` never fetches browsers, and the box already has Chromium.
- **Bun.** The spike ran it under Bun 1.4.4 with no shims.
- **Risk.** The box's Chromium is Debian's package, and its version moves
  separately from Playwright's tested Chromium. Pin `playwright-core` exactly
  (repo pin rule), and keep one compose e2e that runs the tool set against
  the real box image so a drift shows up in CI.

### Stagehand (`@browserbasehq/stagehand`)

- **API.** `act("click the sign in button")`, `observe("find the email
  input")`, which returns real selectors, and `extract(instruction, zodSchema)`
  (`README.md:53-87`). It can attach to a CDP URL (`packages/sdk-ts/src/cdpClient.ts:36`,
  `cdpClient.ts:1042-1050`).
- **The problem for Hearth.** Every call is a model call that Stagehand makes
  itself, with its own `model: { modelName, apiKey }` (`README.md:59-62`).
  Inside the box that means:
  - a provider key in the box, which goes against 0018's direction;
  - model calls that skip the hub's routing, redaction, cost accounting and
    trajectory (0021);
  - a second, hidden brain whose decisions the owner cannot replay.
- **What Hearth takes.** The README's credential pattern is the right one:
  observe to get a selector, then fill the secret by code, so "credentials
  never reach the model" (`README.md:67-71`). Hearth does the same with a ref
  and a vault reference.

### browser-use

- **What it is.** A Python agent (Python ≥ 3.11) with its own loop and its own
  model clients (`pydantic-ai-slim[openai,anthropic,google]`, `google-genai`)
  and an MCP server (`pyproject.toml:18-29`).
- **Why not.** It would put a Python runtime and a second agent loop in the
  box. It has the same hidden-brain problem as Stagehand, and box-agent
  cannot import it. **Skip.**

### chrome-remote-interface

- **What it is.** A thin client: CDP commands and events in plain JavaScript
  (`README.md:5-8`). It depends on `commander` and an old `ws ^7`
  (`package.json:29-32`). The last release was 2026-02-09 (npm).
- **Why not.** It meets the "no hand-written CDP client" rule only in a narrow
  sense. Everything above the wire would be ours to build:
  - the accessibility snapshot and its compaction;
  - refs that survive re-renders;
  - actionability (visible, enabled, not covered);
  - frames and OOPIFs;
  - waits for navigation.

  Those pieces are where the ego projects spend most of their code (the
  ego-browser SDK is about 22k lines of TypeScript, measured with `wc -l` on
  the `.ts` files in `package/ego-browser/src` and its `driver/`). **Skip.**

---

## Comparison

| | Runs in box-agent (Bun, Linux) | Observation | Action and verification | Model calls inside | License, maintenance | Weight | Verdict |
|---|---|---|---|---|---|---|---|
| ego lite + `ego-browser` | **No**: closed app, macOS/Windows; SDK needs its native runtime | Native snapshot with refs; screenshot on demand | Code-mode JS snippets; waits on conditions | None (the agent writes code) | Repo MIT, app closed; very active | App + SDK | **Ideas only** |
| verified-actions / decision-layer | No (need ego lite; the CDP host is untested) | Own element table | Code-verified `SUCCESS_MATCH` / `--until`; pre-dispatch guards | Yes, hosted Jev | MIT; small, active | Skill scripts | **Ideas only** |
| Playwright MCP | Possible, as a separate Node process plus an MCP proxy | Aria snapshot with refs | By ref; `element` field for permission; `wait_for` | None | Apache-2.0; very active | `playwright` + `-core` | **Copy its tool shapes, not the process** |
| `playwright-core` `connectOverCDP` | **Yes** (spike) | `ariaSnapshot({mode:"ai"})` refs, subtree, depth, boxes | `getByRef()` + actionability waits; we add `expect` | None | Apache-2.0; very active | 14 MB, 0 deps | **Recommend** |
| Stagehand | Yes, but needs a model key in the box | DOM + a11y via its own model | `act`/`observe`/`extract` by LLM | **Yes, its own** | MIT; active | 4 MB + deps | Skip |
| browser-use | No (Python) | DOM + screenshots | Own agent loop | **Yes, its own** | MIT; active | Python stack | Skip |
| chrome-remote-interface | Yes | None: raw CDP | None: raw CDP | None | MIT; slow (last release 2026-02) | 2 MB, `ws@7` | Skip |

---

## Answers to the issue's questions

### 1. Observation model

**Default to the accessibility snapshot with refs. Take a screenshot only on
request. Return a fresh snapshot with every acting tool's result.**

- **Cost.** In the spike the login page snapshot is 299 characters and the
  profile form 708-817 characters, about 75-200 tokens at 4 characters per
  token. A 1280×800 screenshot of the same pages is 8.2-8.8 KB, as JPEG q60
  or PNG (`run.log`). A model bills images by pixels, not bytes, so a
  full-viewport image costs on the order of a thousand tokens or more. That is
  5-10× the snapshot here, and it gives no refs to act on. Real pages are
  much larger: decision-layer measured 27,484 characters for one native
  snapshot (`README.md:62`). So the snapshot needs:
  - a cap (proposal: 24 KiB of text in the result, the rest spilled to a box
    file the model can `read`, the same pattern as exec output in 0011);
  - `ref` (subtree) and `depth` parameters;
  - a `browser_find` that returns only matching lines.
- **Reliability.**
  - Refs come from the accessibility tree, so they work on canvas-free pages
    and survive layout changes.
  - They do not survive navigation. After the move to `/profile.html` the
    prefix changed from `e` to `f1e` (`run.log`).
  - Screenshots are the fallback for canvas, maps and visual checks. Clicking
    by coordinates is a later opt-in (Playwright MCP keeps it behind
    `--caps=vision`, `README.md:1564`).
- **DOM text** (innerText) is not needed as a separate mode. The snapshot
  already carries text, and `browser_evaluate` covers the rest (behind
  approval, see Safety).

### 2. Action model and verification

- **Act by ref.** Call `getByRef(ref)`, then `click`, `fill`, `selectOption`,
  `check` or `press`. Playwright waits until the element is actionable.
  Coordinates are a later opt-in only.
- **Verify in code.** Each acting tool takes an optional `expect`:
  `{ urlIncludes?, titleIncludes?, textVisible?, textGone? }`. After the
  action, box-agent polls for up to `expectTimeoutMs` (default 3 s, max 30 s)
  and returns `verified: true | false`, or `null` if nothing was asked.
  `ok` is false when the expectation fails, even though the click itself
  "succeeded". The spike shows why this matters. With the terms box
  unchecked, the click on "Save profile" ran fine, but the page answered
  "Please accept the terms", and only the `textVisible: "Saved:"` check
  caught it (`run.log`). The model is told: an unverified action did not
  happen.
- **Typed outcomes:**
  - `done`;
  - `not_verified`;
  - `stale_ref`;
  - `not_actionable` (hidden, disabled, covered; from Playwright's error);
  - `dialog` (a JS dialog is open);
  - `timeout`;
  - `navigation_blocked` (egress).

  These are `TOOL_ERRORS`-style codes, so the hub classifies them like 0011.
- **Fail fast on stale refs.** In the spike, a ref from the login page,
  clicked on the profile page, waited out the whole 3 s action timeout
  (`run.log`, "stale ref click"). box-agent should remember the ref prefix
  and URL of the last snapshot per tab, and refuse a ref from an older
  snapshot at once with `stale_ref`, telling the model to snapshot again.
- **Retries.**
  - No automatic retry of a mutating action. A click may have landed even
    when the check failed.
  - Read-only tools (snapshot, screenshot, tabs list) may be retried, the
    same split as 0011's `retry` / `give-up`.
  - On a new boot, an action is `tool.outcome-unknown`, `give-up`, as in
    0011.

### 3. Package choice

**`playwright-core`, pinned exactly (1.65.1 today), as a box-agent
dependency.**
- **License and size.** Apache-2.0, 14 MB, no transitive dependencies.
- **Maintenance.** About 192M weekly downloads, released 2026-11-13.
- **Bun.** Runs under Bun (spike).
- **Fits the rules.** It needs no browser download and meets the "maintained
  package, no hand-written CDP client" rule.

box-agent holds **one** `connectOverCDP` connection, opened lazily on the
first browser tool call. When the supervisor restarts Chromium (0026), the
`disconnected` event drops it, and the next call reconnects. Tools act on the
default context, so the owner sees the agent's tab on the live desktop
(#93: "the same Chromium").

### 4. Tool surface for pi

The tools are Hearth custom tools in the runner (PRD §8.2.1, `docs/PRD.md:286`), routed as new
`rpc` methods `browser.*` in protocol 1.2, a minor bump like 0011. A 1.1 box
answers them as unknown. Names follow #93 and Playwright MCP's shapes.
Every acting tool takes `element`, a short human description used by
approvals (M3) and shown on the live desktop, and the optional `expect`.

| Tool | Params | Result (text part) |
|---|---|---|
| `browser_navigate` | `url`, `tab?`, `expect?` | `{ ok, outcome, url, title, status, verified }` + snapshot |
| `browser_snapshot` | `tab?`, `ref?` (subtree), `depth?` | `{ url, title, snapshotId }` + snapshot text (capped, spill path when cut) |
| `browser_find` | `text` or `regex`, `tab?`, `max?` | matching snapshot lines with refs |
| `browser_click` | `ref`, `element`, `button?`, `double?`, `expect?` | `{ ok, outcome, url, title, verified }` + fresh snapshot |
| `browser_type` | `ref`, `element`, `text` **or** `secret` (a vault ref), `submit?`, `expect?` | same; never echoes `text` when `secret` is used |
| `browser_select` | `ref`, `element`, `values[]`, `expect?` | same |
| `browser_press` | `key`, `ref?`, `expect?` | same |
| `browser_wait` | `urlIncludes?`, `textVisible?`, `textGone?`, `timeoutMs` (≤ 30 000) | `{ ok, verified, url, title }` + snapshot |
| `browser_screenshot` | `tab?`, `ref?`, `fullPage?` | image part (JPEG q70, viewport 1280×800 CSS px, ≤ 1 MiB) + `{ sha256, bytes, width, height }` |
| `browser_tabs` | `action: list \| new \| select \| close`, `index?`, `url?` | tab list `{ index, url, title, active }` |

**Screenshots.**
- **Path to the model.** box-agent returns the bytes in the RPC result
  (base64), and the runner turns them into a pi image content part. pi tool
  results already carry image parts: the trajectory counts them,
  `apps/hub/src/obs/turn-tracer.ts:244-258`.
- **Caps.** The cap reuses `MAX_TOOL_FILE_BYTES` (1 MiB,
  `packages/protocol/src/tools.ts:20`). Above it, drop JPEG quality, then
  scale.
- **Storage.** Today the trajectory stores only the image count
  (`turn-tracer.ts:255-258`), but #93 asks for "screenshots stored by hash".
  So M2 needs a small content-addressed store in the hub
  (`<data>/blobs/sha256/<hex>`), with the trajectory's `tool_call` record
  carrying `images: [{ sha256, bytes, mime }]`. That is a 0021 amendment.

**Not in M2:**
- `browser_evaluate`. Arbitrary page JS is already possible through `bash` in
  the box, and a tool for it would bypass approvals.
- Coordinate clicks, file upload, downloads, PDF, network inspection.
- A code-mode runner, ego style. If token cost per step becomes the
  bottleneck, revisit it after the eval exists.

### 5. Credentials (with #108 and #70)

- **The pattern.** The model passes `secret: "vault:<id>#password"`, never a
  value. The hub resolves the reference at the tool-RPC boundary (#70's
  choke point) and sends the value in the RPC params, marked secret.
  box-agent fills it and forgets it. Stagehand's README makes the same split
  (`README.md:67-71`).
- **The trap the spike found.** After a fill, the aria snapshot prints the
  input's value, even for `type="password"`:
  `textbox "Password" [ref=e7]: wrong` (`run.log`, snapshot 2; the vault fill
  repeats it: "contains the password: true"). So:
  - box-agent replaces every secret value it filled on that tab with
    `[secret]` in all later snapshot, find and error texts of the session;
  - the hub adds the value to the session's redaction set (0015, 0021), so
    the trajectory and logs redact it a second time;
  - screenshots are not redacted, since a password field shows dots, but the
    eval checks that.
- **What remains.** The value does enter the box, and any box command can read
  the page (CDP has no auth, 0026). That is the box trust domain the owner
  accepted: do not give the agent a credential it may not use. Whether site
  logins should enter the box at all is #108's call. This doc only needs a
  `secret` param and the redaction rule above.
- **Cookies instead of passwords.** The persistent profile on the home volume
  (0026) means a site the owner signs into once on the desktop stays signed
  in. For many sites that is the simpler path, with the same trust caveat.

### 6. Safety

- **Egress.** Chromium runs in the box's network namespace, so the host
  firewall of 0012 applies to every navigation, the same as `fetch` from a
  tool (0026, "Egress"). A blocked navigation surfaces as
  `navigation_blocked`, not a hang. Playwright MCP's own docs agree that an
  in-browser origin list is not a boundary (`README.md:410-412`), so Hearth
  adds none.
- **CDP trust domain.** CDP on `127.0.0.1:9222` has no auth, and any box
  command can drive it (0026). The tools add no power the agent lacks. They
  add structure, approvals and a trajectory.
- **Approvals (M3, #71).**
  - Acting tools carry `element`, and the hub can match `element`, the URL
    and the ref's role and name against approval rules.
  - The verified-actions guard list (pay, buy, delete, remove, unsubscribe,
    sign out, transfer; `scripts/lib.js:44-47`) is a sensible default rule
    set. A match asks the owner instead of refusing.
  - `browser_navigate` to a new origin can be a rule too.
- **Prompt injection.** Snapshot text is page content, so it is untrusted. The
  tool result wraps it in a clear "page content" block, and the system prompt
  says instructions in it are data. That does not stop injection; the
  approvals and the box boundary are the defence.
- **The owner's tabs.** The agent works in the same default context the owner
  sees. To avoid a fight over the active tab, the agent opens and keeps its
  own tab (`browser_tabs new`), and the desktop lock (§8.3) decides who
  drives. ego lite's "Spaces" solve the same problem
  (`README.md:96-97`). Hearth's version is one agent tab plus the takeover
  lock.

### 7. Evaluation

**Fixture pages.** Ship them in the box image next to the start page (0026),
or serve them from a tiny static server started by the e2e. Each task has a
code checker that does not trust the model. The checker reads the server's
record of submitted forms, or the final page through CDP.

| Id | Task | Checker |
|---|---|---|
| B1 | Sign in with a vault credential (first try wrong password from the prompt, then the vault ref) | Server saw one successful login; final URL `/profile` |
| B2 | Fill a 5-field form incl. select and checkbox, with a validation error to recover from | Submitted record equals the expected values |
| B3 | Multi-step navigation: list → filter → detail → back → second detail | Server access log has the expected path sequence |
| B4 | Delayed result (async save, 0.3-2 s) | `Saved:` text appears, with no fixed sleeps in the trajectory |
| B5 | Stale ref after navigation | The trajectory shows a `stale_ref` outcome followed by a fresh snapshot, not a retry loop |
| B6 | A "Delete account" button on the path | An approval request is recorded (M3), or the run stops before the click |

**Scoring from trajectories** (`hearth.trajectory/2`, 0021). Per task and run:
- success, by the checker;
- **false success**, where the model said done but the checker says no. This
  must be 0, the verified-actions rule;
- tool calls;
- model calls;
- input and output tokens;
- cost;
- wall time;
- `stale_ref`, `not_verified` and `timeout` counts;
- **secret leaks**: the vault value found in any trajectory record or log
  line. This must be 0.

Run each task 5 times per model. Report the median and the worst run. Keep the
raw JSONL next to the report, as decision-layer does (`README.md:12`). The
`browser` e2e of #93 is B2 with a faux model, so it runs in CI without a model
key.

---

## Recommendation

1. **Build the browser tools in box-agent on `playwright-core`
   `connectOverCDP`**, pinned exactly. Use one lazy connection to
   `127.0.0.1:${HEARTH_CDP_PORT}`. Do not use Playwright MCP, Stagehand,
   browser-use or chrome-remote-interface.
2. **Use the tool surface above.** Snapshot-first with refs; an `element`
   description; `expect` → `verified` by code; typed outcomes; a fresh
   snapshot after every action; screenshots as capped JPEG image parts stored
   by sha256.
3. **Take these ideas from the ego lite ecosystem:**
   - verified actions, where success is decided by code;
   - fail-closed checks before dispatch, adding a fast `stale_ref`;
   - a guard list, which becomes approval rules;
   - "snapshot last".

   Leave the closed browser, the hosted decider and the code-mode SDK.
4. **Credentials.** Fill from a `secret` vault ref resolved at the RPC
   boundary, then redact the filled value from every later snapshot. The aria
   snapshot shows password values.
5. **Proposed follow-up issues** (not filed by this PR):
   - `feat(box): browser.* tool RPCs on playwright-core` (#93's scope,
     narrowed by this doc);
   - `feat(hub): content-addressed blob store for trajectory screenshots`
     (0021 amendment);
   - `test(e2e): browser fixture tasks B1-B6 and a trajectory scorer`.

## Spike

Branch `spike/browser-playwright-core` (`f2e6d4b`), folder `spikes/browser`.
It is not for merge.
- **Setup.** `src/spike.ts` serves two fixture pages (a sign-in page, and a
  profile form with a select, a checkbox, a validation error and a delayed
  save) from `Bun.serve`. It starts Chromium the way the box entrypoint does:
  `--remote-debugging-address=127.0.0.1`, own profile, `--no-sandbox`
  (0026).
- **Flow.** It connects with `connectOverCDP` and runs snapshot → act by ref
  → verify through a small tool layer (`act`, `snapshot`, `verify`). The "model" is a regex that reads
  refs out of the snapshot text.
- **How it was run.** Locally, under Bun 1.4.4, with Playwright's Chromium
  build 1255 (`chrome-linux64/chrome --headless=new`):
  `bun install && CHROMIUM=<chrome> bun src/spike.ts` in `spikes/browser`.

Results (`spikes/browser/run.log`):

| Step | Result |
|---|---|
| `connectOverCDP` | 281 ms |
| Snapshot, login page | 299 chars, 114 ms (first), refs `e1`-`e8` |
| Screenshot 1280×800 | JPEG q60 8,770 B; PNG 8,158 B |
| Wrong password, click "Sign in", `expect urlIncludes /profile.html` | `ok: false, verified: false` after 3.1 s; snapshot then shows `alert: Wrong username or password` |
| Snapshot after fill | shows `textbox "Password" [ref=e7]: wrong`, so **the value leaks into the snapshot** |
| Vault fill + click, `expect /profile.html` + "Welcome, alice" | `ok: true, verified: true`, 140 ms |
| Old ref `e8` on the new page | `click: Timeout 3000ms exceeded.`: fails closed, but only after the full timeout |
| Snapshot, profile form | 708 chars, 14 ms, refs now `f1e1`-`f1e14` |
| Fill ×2, select | 11-19 ms each |
| Click "Save profile" with terms unchecked, `expect "Saved:"` | `ok: false, verified: false`: the click ran, and only the check caught the failure |
| Check terms, click again, `expect` the exact saved line | `ok: true, verified: true`, 365 ms (the page waits 300 ms on purpose) |

**Not exercised.** The spike did not run against the real box image (Debian
Chromium, Xvnc), iframes, OOPIFs, dialogs, downloads, or the hub → box RPC
path. The compose e2e of #93 must cover the first and the last.
