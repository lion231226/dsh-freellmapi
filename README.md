# dsh-freellmapi

**Use [freellmapi](https://github.com/tashfeenahmed/freellmapi)'s Auto routing from inside
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**

`dsh-freellmapi` is a DSH LLM adapter plugin. It registers your local freellmapi gateway as
the DSH provider route `freellmapi`, exposes the router's `auto` / `auto:<strategy>` models in
the DSH model picker, reports which upstream provider actually answered each request, and
keeps the model list in sync with the running router.

```text
DSH  ──▶  provider "freellmapi"  ──▶  POST http://localhost:3001/v1/chat/completions
                                        { "model": "auto", "stream": true }
                                      ──▶  freellmapi router  ──▶  ~34 providers
```

> ### Unofficial plugin — please read
>
> This is a community project. It is **not** affiliated with, endorsed by, sponsored by or
> supported by the freellmapi project, nor by DeepSeek. It is not an official freellmapi
> client and not an official DSH plugin. "freellmapi" and "DeepSeek Harness" belong to their
> respective owners. Licensed under the [MIT License](LICENSE).

> ### Do you actually need this plugin?
>
> **If all you want is Auto mode, you probably do not.**
> freellmapi ships an official, zero-plugin DSH integration:
>
> ```bash
> npx freellmapi setup-dsh --url http://localhost:3001 --api-key <unified-key>
> ```
>
> It writes the gateway into `$DSH_HOME/settings.yaml` as a `llm-pi-ai` route, drops the key
> into `$DSH_HOME/.env` (mode `0600`), and sets the default model — no plugin involved.
> Because it builds its model list from the live `GET /v1/models` response, the official path
> **already lets you pick `auto`, `fusion` and `auto:<profile>` in the DSH model picker.** This
> plugin is an *optional alternative / enhancement*, not a requirement. Read
> [Relationship to the official `setup-dsh`](#relationship-to-the-official-setup-dsh) and
> decide for yourself.
>
> **One hard constraint:** both paths register the same DSH provider route name
> (`freellmapi`), so they cannot both be enabled. If you already ran `setup-dsh`, remove its
> `freellmapi` route first — or don't install this plugin.

---

## Table of contents

- [What this plugin adds](#what-this-plugin-adds)
- [Relationship to the official `setup-dsh`](#relationship-to-the-official-setup-dsh)
- [Requirements](#requirements)
- [Install](#install)
- [Configuration](#configuration)
- [Using Auto mode](#using-auto-mode)
- [Architecture](#architecture)
- [Troubleshooting](#troubleshooting)
- [Uninstall](#uninstall)
- [Compatibility](#compatibility)
- [Development](#development)
- [Limitations and unverified claims](#limitations-and-unverified-claims)
- [How the claims in this README were verified](#how-the-claims-in-this-readme-were-verified)
- [License](#license)

## What this plugin adds

Four things, and nothing more. All four are about *observability and ergonomics*, not about
being able to reach the gateway at all — the official configuration path already does that.

| # | Increment | Why it matters |
|---|---|---|
| 1 | **`X-Routed-Via` is visible.** Every freellmapi response carries `X-Routed-Via: <platform>/<model>` — the one header that tells you which upstream provider and model actually served the request. This plugin reads it and reports it in the DSH log (behind a config switch). The generic `openai-completions` path in DSH's pi-ai adapter does not surface upstream response headers, so on that path "who answered?" stays invisible. **This is a design-based judgement about the adapter, not a measured claim about pi-ai internals.** | With Auto mode, the router picks for you; knowing the pick is the whole point. |
| 2 | **Gateway-specific errors become actionable messages.** An unknown `auto:<profile>` name is an upstream `400`; exhausted quota / rate limits are an upstream `429` (with `Retry-After` and `error.code: "quota_exceeded"` when it is a *monthly budget* exhaustion). The plugin translates these into messages that say what to do next, instead of a raw `HTTP 429` shell. | You find out "add a key / wait until the next UTC month / fix the profile name" instead of guessing. |
| 3 | **It does not touch your global DSH configuration.** `baseURL`, the credential reference and every other knob live in the plugin's own config; nothing is written to `$DSH_HOME/settings.yaml` or `$DSH_HOME/.env`. | Your gateway settings stay where you can inspect them, and a later `setup-dsh` cannot silently rewrite this plugin's endpoint. The trade-off is real though — see the next section: both paths claim the same DSH route name, so **only one of them can be active**. |
| 4 | **The model list is refreshed at runtime.** Models come from the running router's `GET /v1/models`; when you connect a new provider in the freellmapi dashboard, it appears in DSH without re-running a CLI. | No stale snapshot to re-generate after every gateway change. |

What it deliberately does **not** do: it does not talk to upstream providers directly, does
not replace the router, does not manage your freellmapi keys, and does not make Auto mode
possible (the gateway and the official integration already do that).

## Relationship to the official `setup-dsh`

freellmapi documents a first-class DSH integration that requires **no plugin at all**:

```bash
# 1. Make sure the gateway is running (see Requirements), then:
npx freellmapi setup-dsh --url http://localhost:3001 --api-key <unified-key>

# 2. Start DSH as usual:
npx @deepseek-ai/dsh web
```

What that command writes into `$DSH_HOME` (default `~/.dsh`):

```yaml
# $DSH_HOME/settings.yaml
llm-pi-ai:
  providers:
    freellmapi:
      displayName: FreeLLMAPI
      apiKeyEnv: FREELLMAPI_API_KEY      # the key itself lives in $DSH_HOME/.env (0600)
      api: openai-completions            # reuses the pi-ai adapter DSH already ships
      baseURL: http://localhost:3001/v1
      models:                            # taken from the live GET /v1/models catalog
        - { id: auto, name: Auto (router picks the best available model), contextWindow: … }
        - { id: auto:smart, name: …, contextWindow: … }
        # … plus every concrete catalog model
agent-default-model:
  provider: freellmapi
  model: auto
```

```dotenv
# $DSH_HOME/.env   (mode 0600)
FREELLMAPI_API_KEY=freellmapi-…
```

Three consequences worth stating plainly:

1. **Auto mode works on the official path.** `GET /v1/models` explicitly lists `auto`,
   `fusion` and one `auto:<profile>` row per named fallback chain, so `setup-dsh` writes them
   into `models:` and DSH's picker offers them. Selecting `auto` does not require this plugin.
2. **The official path is the safer default.** It is maintained upstream, it is one command,
   and it uses a DSH-shipped adapter instead of third-party code.
3. **The two paths are mutually exclusive.** The official route is
   `llm-pi-ai.providers.freellmapi`, whose DSH provider name is `freellmapi`; this plugin also
   registers the provider route `freellmapi`. Provider route names are unique inside a DSH
   process, so the adapter that registers second is rejected. If you already ran `setup-dsh`,
   remove its `freellmapi` route before installing this plugin — or keep the official route and
   skip this plugin. You will not be left guessing if you get it wrong: the plugin refuses to
   load with a message that names exactly this conflict.

So when is this plugin worth installing?

| | Official `setup-dsh` | This plugin |
|---|---|---|
| Auto / `auto:<strategy>` / `auto:<profile>` selectable in DSH | ✅ yes | ✅ yes |
| Model list source | `GET /v1/models` at setup time | `GET /v1/models` at runtime, refreshable |
| Who served the request (`X-Routed-Via`) | ❌ not surfaced | ✅ reported in the DSH log (config switch) |
| freellmapi-specific `400` / `429` messaging | generic adapter error | ✅ translated |
| Gateway error / fallback trail visibility | ❌ | ✅ logged when present |
| Writes to `$DSH_HOME/settings.yaml` / `.env` | ✅ yes (structurally merged, with a timestamped backup) | ❌ no — config stays in the plugin |
| Can be enabled at the same time as the other | ❌ | ❌ — both own the DSH provider route `freellmapi`; pick exactly one |
| Extra code in your profile | none | one third-party bundle |
| Upstream maintenance | freellmapi project | this repository |

**Honest conclusion: this plugin is an optional alternative/enhancement to the official path,
not a required piece.** If you want the smallest, most upstream-supported setup, use
`setup-dsh`. If you specifically want routed-via visibility and gateway-aware error messages,
this plugin adds exactly that.

## Requirements

| Requirement | Detail |
|---|---|
| **A running freellmapi gateway** | Reachable at `http://localhost:3001` by default. Both the OpenAI-compatible base URL `http://localhost:3001/v1` and the dashboard live on that port. |
| **A unified API key** | Shaped like `freellmapi-…`, created in the gateway dashboard's **Keys** page. This is a single gateway key — it is *not* your upstream provider keys. |
| **DeepSeek Harness** | Runtime `0.2.0-rc.2` is what this plugin was written against (see [Compatibility](#compatibility)). |
| **Node.js** | `>= 22` (the same range the DSH runtime and the reference DSH plugins declare). |

### Starting the gateway

The upstream repository is the authority here; the two supported shapes are:

```bash
# Recommended by upstream: clone the repository, then bring up the bundled compose file.
git clone https://github.com/tashfeenahmed/freellmapi.git
cd freellmapi
docker compose up -d
# image: ghcr.io/tashfeenahmed/freellmapi:latest (multi-arch: amd64 + arm64)

# Or run the server directly from a checkout (server + dashboard share :3001):
npm run build && node server/dist/index.js
```

There is also a desktop build under `desktop/` in the upstream repository, and a native
`agent-clients` documentation page describing this integration.

### Checking the gateway before you install anything

```bash
curl -s http://localhost:3001/v1/models \
  -H "Authorization: Bearer freellmapi-<unified-key>" | head -c 400
```

You should get an OpenAI-shaped `{"object":"list","data":[…]}` body whose first entries include
`auto` and `fusion`. If that curl fails, stop here — the plugin cannot fix a gateway that is
not answering.

Useful variant — list only what can serve right now:

```bash
curl -s "http://localhost:3001/v1/models?available=true" \
  -H "Authorization: Bearer freellmapi-<unified-key>"
```

## Install

There are three supported ways in. Pick one — do **not** combine methods A/B with method C's
patch row, for the reason explained at the end of this section.

### Method A — DSH plugin manager (GUI)

1. Open the DSH web GUI.
2. Go to the **Plugins** manager in the sidebar (the plugin inventory page).
3. Use its **install / add** action and paste one of these specs:
   - `dsh-freellmapi` — the registry spec, once the package is published to npm.
   - `github:lion231226/dsh-freellmapi` — straight from GitHub, works without npm publishing.
   - `github:lion231226/dsh-freellmapi#v0.1.0` — pinned to a tag or commit.
4. Confirm. The manager runs the profile's package manager for you, registers the package as a
   profile bundle, and (if DSH asks) restart the app.

The manager accepts registry names, absolute local paths, git addresses and tarball URLs, and
it **refuses any spec whose manifest declares no `dsh.bundle`** — this package declares one, so
it installs as a real profile bundle rather than as a dead dependency.

### Method B — the `dsh plugin` CLI

```bash
# GitHub spec
dsh plugin --profile desktop add github:lion231226/dsh-freellmapi

# npm spec, once published
dsh plugin --profile desktop add dsh-freellmapi

# install everything the profile already declares (after editing package.json by hand)
dsh plugin --profile desktop install
```

`add` and `install` are the CLI forms the DSH runtime itself prints in its error messages
(`run 'dsh plugin --profile <name> install' if its dependency is not installed`,
`create it with 'dsh plugin --profile <name> add <package>'`). Replace `desktop` with your
profile name; it is the directory name under `$DSH_HOME/profiles/`.

> ⚠️ **Not verified end-to-end in this repository.** The subcommand names come from DSH's own
> runtime text, not from a run against a real profile. Confirm the exact surface with your DSH
> version before scripting it, and prefer Method A if you are unsure.

A hand-written package-manager call is *not* a substitute for `dsh plugin add`: running
`pnpm add` (or `npm install`) in the profile directory installs the package but does not
register it as a profile bundle, so DSH will load it as a plain dependency and nothing appears
in the model list. If you insist on doing it by hand, complete Method C as well.

### Method C — manual placement

Useful for air-gapped machines, for a local checkout you are hacking on, or when you want to
see exactly what changed.

1. Put the built package at:

   ```text
   $DSH_HOME/profiles/<profile>/node_modules/dsh-freellmapi/
   ```

   (A local checkout can be linked instead of copied — the reference DSH plugins use
   `"file:node_modules/<pkg>"` for exactly this.)

2. Register it in `$DSH_HOME/profiles/<profile>/package.json` — **both** places matter:

   ```jsonc
   {
     "dependencies": {
       "dsh-freellmapi": "file:node_modules/dsh-freellmapi"
     },
     "dsh": {
       "profile": {
         "bundles": [
           "@deepseek-ai/dsh-base",
           "@deepseek-ai/dsh-web-app",
           "dsh-freellmapi"            // ← without this line the package is never loaded
         ]
       }
     }
   }
   ```

3. Materialise the dependency, then restart DSH:

   ```bash
   dsh plugin --profile desktop install
   ```

Why both: `dsh.profile.bundles` is what the runtime walks when it composes the loader tree,
while `dependencies` is what makes the package resolvable at all. A package that is installed
but missing from `bundles` is silently ignored; a package that is listed but not installed
makes startup complain that the bundle cannot be resolved.

**The package's own patch file** (shipped inside the plugin, not written by you) is a
top-level YAML array and is the reason a correctly installed bundle needs no manual patch row:

```yaml
# node_modules/dsh-freellmapi/cordis.patch.yml
- insert:
    - id: freellmapi            # loader entry id == settings namespace id
      name: 'dsh-freellmapi'    # must resolve from the profile
```

> ⚠️ **Only if you installed the package *without* registering it as a bundle** — i.e. you
> skipped step 2's `bundles` line — you must insert the loader row yourself in
> `$DSH_HOME/profiles/<profile>/cordis.patch.yml`:
>
> ```yaml
> - insert:
>     - id: freellmapi
>       name: 'dsh-freellmapi'
> ```
>
> **Never do both.** A bundle registration plus a hand-written row with the same `id` gives the
> composed tree two entries with one id, and DSH refuses to start that profile with a
> `duplicate loader entry id "freellmapi"` error. This is a real, previously observed failure
> mode in DSH profiles, and it is why the GUI path is the recommended one.

### Verify the install

1. The Plugins manager lists `dsh-freellmapi` and it is enabled.
2. **Settings → Models** shows a **FreeLLMAPI (Auto)** provider route (the plugin registers it as
   a configurable provider, so it is visible even before you fill in the key).
3. The model picker offers `auto` and at least one `auto:<strategy>` entry.
4. A first chat turn with model `auto` returns text rather than `MISSING_CREDENTIAL`.

If step 2 or 3 fails, see [Troubleshooting](#troubleshooting).

## Configuration

The plugin's config schema is also its settings page, so every field below is editable in the
GUI (**Settings → Plugins → dsh-freellmapi**) and overridable in the profile patch file. All
fields are live: a settings edit takes effect on the next request, with no restart and no
re-registration.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `baseURL` | string | `http://localhost:3001/v1` | OpenAI-compatible root of the gateway. The plugin appends `/chat/completions` and `/models`; trailing slashes are trimmed. A value that is not an `http(s)://` URL degrades to the default instead of breaking later inside `fetch`. |
| `apiKeyEnv` | string | `FREELLMAPI_API_KEY` | *Reference name* for the credential — an environment variable name or a credentials-store key. **Not** the key itself. |
| `apiKey` | string (secret) | `''` | Optional inline credential. Leave empty and prefer `apiKeyEnv`: a value here is stored in the profile patch, in plain text. |
| `maxTokensField` | `max_tokens` \| `max_completion_tokens` | `max_tokens` | Which wire field carries the output cap. `max_tokens` is the canonical field (the one freellmapi documents); the gateway also accepts `max_completion_tokens` and prefers `max_tokens` when both are present, so switch to the second only if a specific model demands it. |
| `logRoutedVia` | boolean | `true` | Log the upstream `X-Routed-Via`, plus `X-Fallback-Attempts` / `X-Fallback-Trail` when present, for every request. |
| `includeFusion` | boolean | `true` | Advertise the gateway's `fusion` route (panel of models + judge) in the model picker. |
| `exposeDiscoveredModels` | boolean | `true` | Merge `GET /v1/models` results into the picker next to the virtual `auto:*` routes. |
| `vision` | boolean | `true` | Declare image-input support, so DSH sends attachments as images instead of replacing them with text. Set `false` for a text-only chain. |
| `contextWindow` | number | `131072` | Context window assumed for routes the gateway does not describe (used for compaction budgets). |
| `maxTokens` | number | `0` | Default output cap declared to DSH. `0` declares none, leaving the decision to the gateway and the upstream model. |
| `timeoutMs` | number | `600000` | Per-request timeout in milliseconds; `0` disables it. On expiry the request ends with a `TIMEOUT` failure. |
| `discoveryTimeoutMs` | number | `5000` | Timeout for the `GET /v1/models` discovery request. |
| `discoveryCacheMs` | number | `60000` | How long a successful discovery result stays fresh. |
| `headers` | map | `{}` | Extra request headers. `user-agent`, `authorization`, `content-type` and `accept` are reserved and cannot be overridden. |
| `taskType` | `''` \| `auto` \| `code` \| `chat` | `''` | Optional `X-FreeLLM-Task-Type` hint that biases the router (`code` trades speed against intelligence). Empty sends no header. `fastest`/`reliable` chains ignore it upstream. |
| `cacheMode` | `''` \| `on` \| `off` | `''` | Optional `X-FreeLLM-Cache` switch for the gateway's exact-match response cache. Empty sends no header. |

> The settings form is generated when the host resolves `@deepseek-ai/schemastery` (it normally
> does in a DSH profile). If it does not, the plugin still loads and runs with exactly these
> defaults — you just get no generated form, and you configure it through the profile patch
> instead. No configuration value, however malformed, can stop the plugin from loading.

### Three ways to provide `baseURL` and the key

**1. DSH settings page (recommended).** Open **Settings → Models** (or the plugin's own card
under **Settings → Plugins**) and set:

- `baseURL` → `http://localhost:3001/v1` (or your remote gateway's URL)
- the key → paste the `freellmapi-…` value into the route's credential field. DSH stores it
  through the credentials service under the name configured in `apiKeyEnv`, and the plugin
  re-resolves it on **every** request, so a rotated key takes effect without a restart.

**2. Environment variable.** `FREELLMAPI_API_KEY` is the default reference name, so this works
without touching the config at all:

```bash
# PowerShell (current session)
$env:FREELLMAPI_API_KEY = "freellmapi-…"

# bash / zsh
export FREELLMAPI_API_KEY="freellmapi-…"

# $DSH_HOME/.env — DSH loads this as its user environment layer, so no export is needed.
# Keep the file private (the official setup-dsh writes it with mode 0600).
FREELLMAPI_API_KEY=freellmapi-…
```

If you change `apiKeyEnv`, the plugin looks up that name instead — and still falls back to
`FREELLMAPI_API_KEY` afterwards. The endpoint has its own escape hatch:

```bash
FREELLMAPI_BASE_URL=http://192.168.1.20:3001/v1
```

`FREELLMAPI_BASE_URL` is honoured **only while `baseURL` still holds its built-in default**, so
an explicit setting always wins over the environment.

The key itself is resolved, per request, in this order:

1. the DSH **credentials service** under the name in `apiKeyEnv` (that service is itself layered
   over the process environment, its managed store, and `$DSH_HOME/.env`);
2. the plugin's inline **`apiKey`** setting, if you set one;
3. the **process environment**: `apiKeyEnv`, then `FREELLMAPI_API_KEY`.

An **empty value counts as "not configured"** at every step, exactly like an unset variable, and
the plugin then reports `MISSING_CREDENTIAL` with the reference name it looked for. Because the
lookup happens on every request, a rotated key takes effect on the next call without a restart.

**3. Profile patch file.** Override the plugin's config without touching the global settings
document, in `$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: freellmapi                 # the loader entry id inserted by the bundle's patch
  config:
    baseURL: http://localhost:3001/v1
    apiKeyEnv: FREELLMAPI_API_KEY
    logRoutedVia: true
```

This is the profile patch layer, which is applied *after* every bundle layer, so it wins over
the bundle's own defaults while leaving `$DSH_HOME/settings.yaml` untouched.

> Never put the key itself in `cordis.patch.yml`, in `settings.yaml`, or in a committed file.
> Only the *reference name* (`apiKeyEnv`) belongs in configuration.

## Using Auto mode

1. Open the model picker in the DSH GUI.
2. Choose the provider **FreeLLMAPI (Auto)** (route id `freellmapi`).
3. Choose a model:

| Model id | What the gateway does |
|---|---|
| `auto` | Uses the **currently active fallback chain** as-is. It does not re-rank the global pool. |
| `auto:smart` | Intelligence-first ordering (weights ≈ reliability 0.35 / speed 0.10 / intelligence 0.55). |
| `auto:fast` | Measured speed first — throughput plus time-to-first-byte (≈ 0.35 / 0.55 / 0.10). |
| `auto:cheap` | Budget-leaning. Upstream documents it as the same recipe as `balanced` (the pool is free anyway). |
| `auto:reliable` | Recent success rate first (≈ 0.70 / 0.15 / 0.15). |
| `auto:balanced` | The default mix — reliability first, speed and intelligence split the rest (≈ 0.50 / 0.25 / 0.25). |
| `auto:<profile>` | A **named fallback chain** you created in the freellmapi dashboard. The name is lower-cased in the model id. |
| `fusion` | The gateway's fan-out mode (a panel of models answers, a judge synthesises). Appears if the running router lists it. |

Notes that save time later:

- **The model string reaches the gateway verbatim.** The adapter forwards `auto`, `auto:smart`,
  `auto:<your-profile>`, `fusion` or any concrete catalog id unchanged and always asks for
  `stream: true` — it never rewrites, normalises or omits the model. What the picker shows is a
  convenience, not a whitelist: unlisted ids are still answered.
- **The picker is `auto` first, then the rest.** It always advertises the six virtual routes
  (bare `auto` at the top, then the five documented strategies) plus `fusion` while
  `includeFusion` is on, then everything `GET /v1/models` reports.
- **The whole model string is case-insensitive**, and the gateway also accepts common synonyms
  (`auto:fastest`, `auto:speed`, `auto:smartest`, `auto:cheapest`, `auto:budget`). Treat the
  table above as documented aliases, not as a closed enum — this plugin does not reject
  strategy names it does not know.
- **An unknown `auto:<profile>` is a hard `400`** from the gateway. freellmapi never silently
  falls back to `auto` in that case, and neither does this plugin. The failure message says so
  explicitly, so check the chain name in the dashboard.
- **Failures come back in-band, not as a crash.** A transport error, `401`, `429`, `5xx`, a
  mid-stream `stream_error` frame, an unusable `GenerateOptions.stop`, a timeout or a cancellation
  all end the stream with a terminal `finish` chunk whose `reason.kind` is `error` or `aborted`,
  carrying a stable DSH code: `AUTH`, `RATE_LIMIT`, `QUOTA`, `CONTEXT_WINDOW_EXCEEDED`,
  `UNSUPPORTED_CONTENT`, `UNSUPPORTED_OPTION`, `INVALID_REQUEST`, `SERVER`, `TRANSPORT`, `TIMEOUT`,
  `ABORTED`, `MISSING_CREDENTIAL`, `INVALID_CREDENTIAL`, `EMPTY_RESPONSE`, `CONTENT_FILTER` or
  `UNKNOWN`. A successful turn ends with `stop`, `tool-calls` or `max-tokens` instead. For
  `429`/`quota_exceeded` the plugin also parses `Retry-After` into DSH's retry-after field when the
  gateway sends one.
- **Some codes are deliberately not normalised.** An in-band error frame from the gateway carries
  its own `error.code`, and that string becomes the failure code **verbatim** — it falls back to
  `SERVER` only when the frame carries no code at all. A `stream_error` frame therefore surfaces as
  `failure.code === "stream_error"`, not as a generic `SERVER`. Codes the gateway invents are not in
  DSH's default retryable set (`EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`),
  so such a failure does **not** trigger a DSH retry. That is intentional: the plugin reports what
  the gateway actually said instead of laundering it into a retryable code, which keeps retry
  policy on the gateway's side.
- **Images**: when `vision` is on, the plugin declares image input, reads the referenced
  attachments and inlines them as `data:` URLs (up to 20 MB each). An attachment it cannot read
  degrades to a text placeholder rather than failing the request. Upstream, an image request is
  only routed to a vision-capable model; if the active chain has none, the gateway returns `422`
  with `code: "no_vision_model"` and the plugin says which of the two you are looking at.

### How to confirm which provider actually answered

Every freellmapi response carries `X-Routed-Via: <platform>/<model>`. The plugin reads it and
writes it to the DSH log line for the request (with `logRoutedVia` on, which is the default).
The lines look like this:

```text
dsh-freellmapi: routed via groq/llama-3.3-70b (model=auto)
dsh-freellmapi: routed via google/gemini-2.5-flash (model=auto:fast) fallback-attempts=2 trail=groq/… key1=rate_limited; …
```

Three details that matter when you are debugging:

- `X-Routed-Via` is the **only** reliable "who served this" signal. The hop currently serving
  the request cannot appear in `X-Fallback-Trail`, because the headers are flushed before the
  body is generated.
- `X-Fallback-Attempts` / `X-Fallback-Trail` appear only when the router actually fell back
  across providers; their absence means "first try worked".
- Non-ASCII model ids arrive percent-encoded in the header and are decoded before logging.

The plugin also keeps the last 50 routing observations in a process-wide ring buffer, exported
as `getRecentRoutes()` for tests and future UI. It is not a DSH tool or service, so use the log
line in normal operation.

You can see the same thing without DSH at all:

```bash
curl -si http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer freellmapi-<unified-key>" \
  -H "content-type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"hi"}]}' \
  | grep -i '^x-routed-via'
```

## Architecture

```text
┌──────────────────────────── DeepSeek Harness (host process) ─────────────────────────────┐
│                                                                                          │
│   agent loop / chat turn                                                                 │
│        │                                                                                 │
│        ▼                                                                                 │
│  llm service (ctx.llm)  ── route selected by GenerateOptions.provider ──▶ freellmapi     │
│       │                                                                                  │
│       ▼                                                                                  │
│  LlmAdapter (this plugin, provider = "freellmapi")                                       │
│    • providerInfo()  →  { id: "freellmapi", name: "FreeLLMAPI (Auto)" }                  │
│    • listModels()    →  GET  {baseURL}/models            (live catalog)                  │
│    • resolveModel()  →  auto / auto:smart / auto:<profile> / fusion / <catalog ids>      │
│    • stream()        →  POST {baseURL}/chat/completions  (SSE, model passed verbatim)    │
│    • reads back      ←  X-Routed-Via, X-Fallback-Attempts / -Trail                       │
│    • config + key    ←  settings page · credentials service · environment                │
│                                                                                          │
└───────────────┬──────────────────────────────────────────────────────────────────────────┘
                │  Authorization: Bearer freellmapi-…
                │  user-agent: deepseek-harness/<version> (+…)   ← attribution header
                ▼
   ┌────── freellmapi gateway / router ───────────────────────────────────────────────┐
   │  http://localhost:3001/v1                                                        │
   │  • one unified key (freellmapi-…) in front of every upstream provider            │
   │  • bandit-scored routing: reliability / speed / intelligence weights             │
   │  • key health, cooldowns, monthly budgets, per-request cache & compression       │
   │  • cross-provider failover, then the SSE pump: tool-call reassembly,             │
   │    usage frames, keep-alive frames, error mapping                                │
   └───────┬───────────────┬───────────────┬───────────────┬───────────────┬──────────┘
           ▼               ▼               ▼               ▼               ▼
       provider A      provider B      provider C      provider D      …  (~34 providers)
          the winner of each request is reported as  X-Routed-Via: <platform>/<model>
```

Notes on the seams:

- The plugin is a plain host-side DSH plugin: it registers one provider route with
  `ctx.llm.registerAdapter`, publishes the route in the configurable-provider directory for the
  settings UI, and registers a model-discovery hook for the "add a model" flow.
- **Every** outbound HTTP request (chat completions *and* model discovery) carries DSH's
  attribution `user-agent` header and uses `redirect: 'error'`, so credentials can never follow
  a redirect to a third-party host.
- The plugin has **zero runtime dependencies** and never imports a DSH package at module scope:
  it resolves `@deepseek-ai/dsh-llm` with a guarded dynamic import and degrades to local shims
  when the runtime is absent, while the only declared peer (`@deepseek-ai/cordis`, optional) is
  never imported directly. The effect is the one that matters — the plugin always binds to the
  runtime copy DSH itself loaded. See the red line in [Troubleshooting](#troubleshooting).
- **Retries are left to the gateway and to DSH's own default.** The adapter returns no custom
  retry policy, because freellmapi already performs 429 cooldowns and cross-provider failover;
  stacking retries on top would multiply latency for a condition the router is better placed to
  fix. Requests carry a configurable timeout (`timeoutMs`) that is combined with the caller's
  abort signal.

## Troubleshooting

### 1. `ECONNREFUSED` / "cannot connect" on port 3001

The plugin reports this as a `TRANSPORT` failure naming the exact URL it tried:

```text
dsh-freellmapi: cannot reach the FreeLLMAPI gateway at http://localhost:3001/v1 — confirm the gateway is running (default http://localhost:3001/v1), that `baseURL` ends in `/v1`, and that nothing blocks the connection [model=auto] — fetch failed: connect ECONNREFUSED 127.0.0.1:3001
```

- Is the gateway actually up? `curl -s http://localhost:3001/v1/models -H "Authorization: Bearer freellmapi-<key>"`.
- Check `baseURL`. It must point at the OpenAI-compatible root, i.e. it normally ends in `/v1`.
  A plain `http://localhost:3001` produces `404`s instead, and the plugin calls that out
  separately ("check that `baseURL` is the OpenAI-compatible root and normally ends in `/v1`").
- Docker: confirm the port is published (`-p 3001:3001` / the compose port mapping) and that the
  container is healthy — the server and the dashboard share port `3001`.
- Remote gateway? Use its hostname and make sure nothing (firewall, reverse proxy) strips the
  `Authorization` header. The plugin never falls back to a different host silently.
- Windows + Docker Desktop / WSL: try `http://127.0.0.1:3001/v1` if `localhost` resolves to the
  wrong stack.
- Slow gateway rather than a dead one? Raise `timeoutMs` (default 10 minutes); the plugin
  reports a request that outlives it as `TIMEOUT`, not as a hang.

### 2. `401` — "Missing or invalid API key"

- The gateway expects `Authorization: Bearer freellmapi-…`. A provider key from one of the
  34 upstreams will not work; you need the **unified key** from the freellmapi dashboard.
- **An empty value counts as unconfigured.** An exported-but-empty `FREELLMAPI_API_KEY`
  behaves exactly like an unset one, and the plugin reports `MISSING_CREDENTIAL` before making
  a request. Check for empty strings, not just missing variables.
- Confirm which reference name the plugin is looking for (`apiKeyEnv`, default
  `FREELLMAPI_API_KEY`) and that the variable/credential exists *under that exact name*.
- Revoked or rotated key? Re-paste it in the settings page — the plugin re-reads credentials on
  every request, so no restart is needed.

### 3. `429` — quota or rate limit exhausted

This is a gateway-level condition: **every** candidate key for the chosen model is currently
rate-limited or out of budget. The response body carries
`{"error":{"message":…,"type":"invalid_request_error"}}`, and for a monthly-budget exhaustion
the gateway adds `error.code: "quota_exceeded"` plus a `Retry-After` header pointing at the
first day of the next UTC month.

- The plugin translates this into a message that names the condition and, when present, the
  retry time — read it before retrying blindly.
- **Do not assume `Retry-After` is always there.** Only the monthly-budget case (and one
  embedding-specific case) is guaranteed to carry it; ordinary chat rate-limit exhaustion is
  not.
- Fixes that actually help: wait out the window, add another upstream key in the freellmapi
  dashboard, lower concurrency, or switch to a strategy that spreads load (`auto:reliable`
  prefers recent successes; `auto:fast` prefers throughput).
- Note the free-vs-premium catalog difference: a free installation sees a catalog snapshot that
  can be up to ~30 days old, so its notion of "which models are available" may lag reality.
  Connection, endpoints, auth and streaming are identical in both tiers.

### 4. The model list is short, or the concrete models are missing

Note what "empty" can mean here: the six `auto`/`auto:*` virtual routes are advertised whether or
not discovery succeeds (and, unless you turn `includeFusion` off, so is `fusion`), so a discovery
failure can never leave the picker blank — you just lose the concrete catalog models.

- Test the discovery endpoint directly:
  `curl -s "http://localhost:3001/v1/models" -H "Authorization: Bearer freellmapi-<key>"`.
  If this is empty, the problem is the gateway, not DSH.
- Is `exposeDiscoveredModels` still `true`? Setting it to `false` deliberately hides every
  discovered model and leaves only the virtual routes.
- If discovery needs a key the plugin does not have, it keeps whatever it cached and records the
  error instead of emptying the picker (and a transient gateway restart does not clear the list
  for the rest of the session). Check for a `MISSING_CREDENTIAL` first, which surfaces before any
  request is made.
- The gateway's catalog sync pulls a signed catalog from `https://api.freellmapi.co` (every 12
  hours, first run ~10 s after start). A machine with no outbound internet keeps the previous
  catalog; a **fresh** install with no internet can legitimately have no concrete models. The
  virtual routes are still listed even then.
- Use `?available=true` (aliases `?connected=true`, `?ready=true`) or
  `?execution_status=ready|needsKey|exhausted` to see the difference between "exists in the
  catalog" and "can serve right now". This is usually why the picker looks thin: the catalog is
  there, but every key is missing or cooling down.
- Remember that a free install sees a catalog snapshot that can be up to ~30 days old, so its
  model list legitimately lags what the upstream providers currently offer.

### 5. The plugin never appears in the model list

Work down this list:

- **Is it registered as a bundle?** Open `$DSH_HOME/profiles/<profile>/package.json` and check
  that `dsh.profile.bundles` contains `dsh-freellmapi`. Installed-but-not-listed is the most
  common cause; DSH loads it as a plain dependency and nothing shows up.
- **Is the patch actually applied?** A patch row that matches nothing is only a warning, so a
  typo produces "silently nothing happened". Check the loader entry id and the package name.
- **Duplicate entry id?** If both the bundle's patch and your profile patch insert
  `id: freellmapi`, the profile fails to start with `duplicate loader entry id`. Remove your
  hand-written row (see [Install](#install)).
- **Does the route lose a naming conflict?** Provider route names are unique per process, and
  this is the trap most people hit: **the official `setup-dsh` route uses the same name.** It
  writes `llm-pi-ai.providers.freellmapi`, whose DSH provider name is `freellmapi`, so if you
  set that up earlier, this plugin's registration is rejected and the plugin refuses to load
  with a message naming the conflict:

  ```text
  dsh-freellmapi: cannot register provider route "freellmapi" — provider route "freellmapi" is
  already owned by another adapter. The FreeLLMAPI documentation's `npx freellmapi setup-dsh`
  writes an `llm-pi-ai.providers.freellmapi` route; remove that route (or this plugin) so exactly
  one adapter owns the name.
  ```

  Remove one of the two routes; they cannot coexist.
- **Is the `llm` service missing?** Without it the plugin stays inert and logs
  `the llm service is unavailable; the plugin is inert` — that means the host composition is
  wrong, not the plugin.
- **Restart after a manual install.** Bundle composition happens at startup for manually edited
  profiles.
- Still stuck? Check the DSH log for the plugin's own error lines; registration failures are
  reported rather than swallowed. (Model discovery is the one soft failure: if its registration
  is refused, the provider route still works and you get a warning instead.)

### 6. The whole profile misbehaves or will not start (dependency-shadowing red line)

This is the one failure mode that can take DSH down, so it is worth understanding.

**`@deepseek-ai/dsh-*` must never appear in this plugin's `dependencies`.** This package ships
**zero** runtime dependencies, and it does not even import the DSH LLM runtime statically: it
resolves `@deepseek-ai/dsh-llm` through a guarded dynamic import at load time and falls back to
small local shims when there is none (a bare checkout, a unit test), so the same file loads
inside a DSH profile and outside it. The only declared peer is the optional
`@deepseek-ai/cordis`. Why all of this matters:

- **How DSH actually supplies the runtime**: `$DSH_HOME/profiles/node_modules/<package>` is a farm
  of filesystem **junctions** into the install cache that `npx` created
  (`…\npm-cache\_npx\<hash>\node_modules\…`). `@deepseek-ai/dsh-llm@0.2.0-rc.2` therefore
  resolves by walking *up* from the plugin's own directory — and inherits whatever identity that
  cache copy has.
- DSH loads its own runtime packages from the application bundle. A plugin that declares, say,
  `@deepseek-ai/dsh-llm` as an ordinary dependency makes the package manager hoist a **second
  copy** into `profiles/<profile>/node_modules/@deepseek-ai/`.
- The profile's `node_modules` wins module resolution, so the plugin would bind to that copy
  while the rest of DSH keeps using the runtime copy. Class identity then breaks: `instanceof`
  checks fail **across copies**, error codes silently degrade, and services the plugin expects
  are missing.
- The versions make this worse: npm's `@deepseek-ai/dsh-llm` only exists in the `0.0.1-rc.x` –
  `0.1.x` range, far below the `0.2.0-rc.2` runtime this plugin targets. So the shadowing copy is
  also an *incompatible* copy.

That second copy is not hypothetical: because the plugin and the DSH process can end up holding
**different module instances**, this plugin is deliberately written to be *identity-agnostic* —
it never relies on a cross-copy `instanceof`, `stream()` never throws, and every failure becomes
in-band `finish` data with a plain `{message, code, status}` object instead of an exception
crossing the adapter boundary. Declaring the runtime as a dependency would throw all of that away
for nothing.

**Health check** — two directories tell the whole story:

```powershell
# 1. The runtime supply: junctions into the npx cache (~249 packages). This is normal.
Get-ChildItem "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai" |
  Where-Object { $_.Name -eq 'dsh-llm' } | Select-Object Name, LinkType, Target
#   Name    LinkType Target
#   dsh-llm Junction C:\Users\…\npm-cache\_npx\<hash>\node_modules\@deepseek-ai\dsh-llm

# 2. The profile's own scope: healthy means ONLY cosmokit and schemastery.
Get-ChildItem "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@deepseek-ai"
```

Anything else in the second listing — above all `dsh-llm`, `cordis`, or any `dsh-*` adapter — is a
leaked dependency that shadows the runtime.

**Fix**: find which package pulled it in (`pnpm why @deepseek-ai/dsh-llm` inside the profile),
remove the offending dependency, reinstall, and restart DSH.

> Accuracy note: the directory listing above is measured on a real profile. The precise end
> state of a shadowed install can vary with the DSH build — cross-copy failures, missing
> services, and in the worst case a profile that refuses to start are all on the table, so
> never treat "it booted" as proof that the dependency is harmless.

### 7. `400` on a named strategy or profile

- `auto:<name>` where `<name>` is not a chain in your dashboard → upstream `400`, by design.
  List the real names from `GET /v1/models` (they appear as `auto:<lowercased-name>`) and use
  exactly that.
- A `400` can also mean a malformed request body or an unsupported `response_format` for the
  selected model. Capabilities are **per model**, not per gateway: a model that accepts `tools`
  may still ignore `response_format`, and vice versa.
- `409` is not a strategy problem: it means an `Idempotency-Key` was reused with a *different*
  body. Generate a new key instead of retrying the same one.

## Uninstall

**GUI (recommended).** Plugins manager → `dsh-freellmapi` → remove. The manager runs the
package-manager removal and updates `dsh.profile.bundles` for you.

**Manual.**

1. Remove `dsh-freellmapi` from `dsh.profile.bundles` and from `dependencies` in
   `$DSH_HOME/profiles/<profile>/package.json`.
2. Delete `$DSH_HOME/profiles/<profile>/node_modules/dsh-freellmapi`.
3. Delete your `- id: freellmapi` override block from the profile's `cordis.patch.yml`, if you
   added one.
4. Re-run `dsh plugin --profile desktop install` and restart DSH.

> ⚠️ A `dsh plugin --profile desktop remove dsh-freellmapi` form is a plausible mirror of `add`,
> but it is **not** confirmed by DSH's own runtime text — prefer the GUI or the manual steps.

Removing the plugin frees the DSH route name `freellmapi`, so the official `setup-dsh` route
becomes installable again if you want it back — but note that uninstalling the plugin does **not**
restore a route you removed earlier. Remove the key from the credentials store or from
`$DSH_HOME/.env` separately if you no longer need it.

## Compatibility

| Component | Supported | Notes |
|---|---|---|
| DeepSeek Harness runtime | `0.2.0-rc.2` (written and verified against it) | Other `0.2.0-rc.x` builds are likely fine; the plugin uses only stable LLM seam APIs (`registerAdapter` / `registerConfigurableProviders` / `registerModelDiscovery`). |
| Node.js | `>= 22` | Matches the range declared by the reference DSH plugins. |
| freellmapi gateway | `v0.13.x` (latest at the time of writing: `v0.13.7`) | Protocol surface used: `POST /v1/chat/completions` (SSE), `GET /v1/models`, `X-Routed-Via` & fallback headers, `429 quota_exceeded`. |
| freellmapi tiers | free and premium | Identical endpoints, auth and streaming; only catalog freshness and the available model set differ. |
| `dsh-freellmapi` | `0.1.0` | Zero runtime dependencies. The DSH LLM runtime is resolved at load time (local shims as fallback); the only declared peer is the optional `@deepseek-ai/cordis`. |

> Version-numbering note: the upstream gateway's releases are `v0.13.x`, while the npm CLI
> package `freellmapi` (which provides `setup-dsh`) is versioned independently (e.g. `0.8.1`).
> Do not treat the two numbers as the same series.

## Development

```bash
npm test          # offline test suite — no gateway, no network, no API key required
```

The suite is deliberately hermetic: it must pass on a clean GitHub runner, so it never contacts
a real freellmapi service. CI runs the same command on `ubuntu-latest` with Node 22
(`.github/workflows/ci.yml`) and injects an unreachable `FREELLMAPI_BASE_URL` plus an empty
`FREELLMAPI_API_KEY`, so an accidental live call fails loudly instead of silently passing.

Repository layout:

```text
dsh-freellmapi/
├── package.json              # dsh.bundle.patch + peerDependencies (never dependencies)
├── cordis.patch.yml          # the loader row this bundle inserts
├── lib/                      # the shipped plugin code
├── tests/                    # offline tests
├── IMPLEMENTATION.md         # implementation notes and design decisions
├── .github/workflows/ci.yml  # Node 22, offline
├── README.md                 # English (this file)
├── README.zh-CN.md           # 中文
├── CHANGELOG.md              # Keep a Changelog
└── LICENSE                   # MIT
```

## Limitations and unverified claims

Stated plainly, so you know what you are relying on:

1. **No end-to-end run against a real freellmapi gateway.** Every test in this repository runs
   against an in-process mock gateway, deliberately, so that CI stays offline. The wire details
   come from freellmapi's own documentation and server source, but the first contact with a real
   gateway may still reveal framing details this plugin has not seen.
2. **The mid-stream `stream_error` frame has documentation-level evidence only.** Its exact JSON
   shape is not pinned down upstream, so the parser recognises the four plausible forms
   (`type: "stream_error"`, `code: "stream_error"`, `object: "error"`, and a nested `error: {…}`)
   and treats any error-shaped frame as a terminal failure.
3. **The image path is not verified against a real attachments service.** Reading attachment bytes
   goes through `attachments.imageHostPath()`, the only documented way for an adapter to reach
   them. If that service's shape differs in your build, each affected image degrades to a text
   placeholder — the request still succeeds, but the model never sees the picture.
4. **`sessionId` and `purpose` from `GenerateOptions` are not mapped.** Chat Completions has no
   standard field for either; they are currently dropped rather than smuggled into a custom header.
5. **`fusion` metadata frames are recognised and skipped, not rendered.** The additive `_fusion`
   frames cannot break a stream or leak into the answer, but this host-only plugin does not turn
   them into a progress display.
6. **No output cap is declared by default** (`maxTokens: 0`), so DSH materialises none and the
   gateway/upstream model decides. If an upstream default truncates a long answer, set `maxTokens`.
7. **A `maxTokens` above `Number.MAX_SAFE_INTEGER` is accepted by the config but rejected by DSH.**
   The field is validated only as a non-negative number, while the runtime requires a *safe*
   integer for `defaultMaxTokens`; an absurd value such as `1e21` therefore makes `resolveModel()`
   return metadata DSH refuses with `INVALID_MODEL_MAX_TOKENS`, instead of clamping it silently.
8. **A `role: "user"` message whose `content` is a plain string is sent empty.** DSH's contract
   always supplies `ContentBlock[]`, so DSH itself cannot produce that shape; but `lib/wire.js`
   accepts a string in its own `textOf` helper, so the module is internally inconsistent, and a
   hand-built message of that shape would reach the gateway with an empty `content` rather than
   being rejected loudly.
9. **`includeFusion: false` can be undone by the gateway itself.** The static catalog drops
   `fusion`, but the gateway's own `GET /v1/models` response lists it, and discovery merges it back
   in. Turn `exposeDiscoveredModels` off as well if you really want it gone.
10. **Model discovery can return duplicate ids.** `discover()` passes the gateway's list through
    unchanged. DSH de-duplicates by endpoint order in its own `discoverModels` step, so duplicates
    are harmless to the GUI — but a caller reading the raw discovery offer can see them.

## How the claims in this README were verified

So you can tell measured facts from design judgements:

- **Measured / sourced from upstream**: the gateway commands and endpoints, `setup-dsh`'s file
  writes, the `auto:*` strategy table and weights, `X-Routed-Via` and the fallback headers, the
  `400` / `401` / `409` / `422` / `429` / `502` semantics, the free-vs-premium catalog
  difference, and the `~34 providers` figure all come from freellmapi's own documentation and
  source (`docs/en/api/01-rest-api.md`, `docs/en/architecture/*`, `cli/src/tools.ts`,
  `server/src/routes/proxy.ts`).
- **Measured / DSH side**: the profile → bundle → loader composition model, the patch formats,
  the `dsh.bundle.patch` requirement, the settings/credentials/volatile semantics, the
  `listModels` requirement for GUI selection, and the shadowing health check are taken from the
  DSH `0.2.0-rc.2` runtime sources. The plugin-manager behaviour (specs accepted, refusal of
  manifests without `dsh.bundle`) is read from `@deepseek-ai/dsh-plugin-manager`.
- **Measured / this plugin**: every configuration field, default and probe in
  [Configuration](#configuration) is read from `lib/config.js`; the log line format, the
  `X-Routed-Via`/fallback handling and the ring buffer from `lib/routes.js`; the failure codes
  and the `Retry-After` parsing from `lib/errors.js`; the request mapping and the in-band failure
  behaviour from `lib/wire.js` and `lib/index.js`. If a field is renamed in a future release,
  that is a breaking change and will be listed in [CHANGELOG.md](CHANGELOG.md).
- **Design judgement, not measurement**: that DSH's generic pi-ai `openai-completions` path does
  not surface upstream response headers to the log — this is inferred from how that adapter is
  built, and it is the entire reason increment #1 exists. Treat it as a claim to test on your
  own machine.
- **Unverified commands** are marked inline with ⚠️, together with the evidence they came from.

## License

[MIT](LICENSE) © 2026 lion231226

This project is not affiliated with, endorsed by or supported by the freellmapi project or by
DeepSeek. "freellmapi" is a project of its respective authors; "DeepSeek Harness" and
`@deepseek-ai/*` are the property of DeepSeek. Use at your own risk — an Auto-routed request
consumes quota on whichever upstream provider the router selects.
