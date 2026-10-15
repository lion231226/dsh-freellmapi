# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.6.3] - 2026-10-15

**A wrong claim, a gate that would have caught it, and the rules this project runs on.**

### Fixed

- **The 0.6.1 reachability table was wrong, and its method was the reason.** It claimed `groq` and
  `cerebras` were region-blocked "and a key changes nothing". The probe sent **no `Authorization` header**,
  so it read *"this edge rejects anonymous requests"* as *"this region is blocked"*. Measured again on
  2026-10-15 with the header present:

  | Provider | no credential | bogus-but-well-formed key |
  |---|---|---|
  | `groq` | 403 | **401 → reachable** |
  | `cerebras` | 403 | **401 → reachable** |
  | `ovh` (keyless) | 200 | **403 → sending a key breaks a keyless provider** |

  A `403` means one of three different things depending on what was sent — anonymous rejected, credential
  rejected, or region rejected — and reporting one without the other is how the bad table got written. Both
  READMEs now document the **method** per provider class rather than a verdict, and record that all twelve
  pool providers measured reachable once probed correctly.

### Added

- **`tools/gate.mjs` — one command, one verdict.** An eight-gate self-check (`npm run gate` offline,
  `npm run gate:online` adds the network gates). Gates are numbered so a failure can be cited as `G4`:

  | Gate | Checks |
  |---|---|
  | G1 | no `dependencies`; schemastery in peer **and** dev; `NOTICE` ships with the upstream licence; patch row name matches the package |
  | G2 | `Config` is a **live** schemastery schema (static import, no fallback path, `toJSON`, `type === 'object'`, ≥1 volatile field) |
  | G3 | the provider directory entry uses `settingsPath: []` and `settingsNs === provider` |
  | G4 | browser-half red lines: only `react`, no harness require, no DOM writes, no colour literals, static `inject` naming the slot owner |
  | G5 | the test suite |
  | G6 | the generated client table is current |
  | G7 | pool reachability, **method-aware**: keyless providers probed anonymously, key-required ones with a bogus key, `403` reported as ambiguous |
  | G8 | upstream drift against `tashfeenahmed/freellmapi`'s `Platform` union (`missing` is a backlog, `extra` is a defect) |

  G7/G8 are **informational**, not blocking: a provider being unreachable from one network is not a defect in
  the plugin, and making it fatal would make the gate fail on a train.

- **`PROJECT-RULES.md` — the operating manual.** A PDCA loop with gates between the phases; three mechanisms
  that let the loop run without a human (`tools/gate.mjs` for self-check, router telemetry for
  self-optimisation, a scheduled `--online` run for self-iteration); and **eight hard rules each tied to a
  concrete failure**, plus a lesson ledger mapping every red light to the guard that now catches it.

  The rules that cost the most to learn: never degrade silently; read the shipped artifact before concluding
  what the platform supports; a probe's method is part of the claim; upstream attribution is a licence
  obligation; distinguish "needs a restart" from "live"; and *"registered but invisible"* is this project's
  signature failure shape, with a fixed top-down diagnostic order.

- **`docs/EXPANSION-v0.7.md` — the task brief for pool expansion**, with seven mechanically checkable
  acceptance criteria, the corrected candidate list (probed by the right method), and risks stated as
  unknowns rather than guesses.
- **`docs/NEW-SESSION.md` — a paste-ready bootstrap** so the next session starts from the rules instead of
  rediscovering them.

## [0.6.2] - 2026-10-14

**Attribution fix. This package is a derived work of [freellmapi](https://github.com/tashfeenahmed/freellmapi)
and the repository did not say so.**

### Fixed

- **The upstream copyright notice was missing, which the upstream licence requires.** freellmapi is MIT
  (Copyright © 2026 Tashfeen Ahmed), and the MIT terms state that the copyright notice *and* the permission
  notice must be included in all copies or substantial portions of the software. This package ports
  freellmapi's routing design and transcribes its provider catalogue, so it qualifies — yet `LICENSE`
  carried only this package's own copyright, there was no `NOTICE`, and nothing in the manifest recorded
  the derivation.

  Added a `NOTICE` file containing the derivation statement and the upstream MIT text **verbatim**, listed
  it in `package.json#files` so it ships, and pointed `LICENSE` at it.

- **The README framed freellmapi as merely "the external gateway `gateway` mode can forward to"**, which
  reads as though this plugin were independent of it. Both READMEs now open a dedicated **Upstream and
  credits** section stating the derivation, naming what was ported (the provider catalogue in
  `lib/providers.js` with its per-entry `source:`/`note:` citations, the failover ladder in `lib/health.js`,
  and the routing model itself) and what was not (no upstream file is vendored — upstream is TypeScript,
  this package is plain JavaScript — and the DSH integration is this package's own).

- Corrected the stale "314 tests" figure in both READMEs' file trees, which had been wrong since 0.3.x.

### Note on scope

Upstream describes itself as "personal experimentation only". That is their statement about their project;
it is quoted here rather than restated or reinterpreted, and neither README should be read as granting or
restricting anything beyond the MIT licence.

## [0.6.1] - 2026-10-14

**Two of the default-enabled providers are hard-blocked from some networks, and the key rows do not cover
providers you enable yourself.** Both are now documented from measurement rather than assumption.

### Documented

- **Regional reachability, measured.** An unauthenticated `GET {baseURL}/models` against all twelve
  providers from a mainland-China connection: `groq` and `cerebras` answer **403 — the API, not just the
  console** — so a key cannot help until traffic leaves through a different route; `openrouter` answers 200
  in ~0.5 s (5/5 probes); `kilo`, `llm7`, `ovh`, `nvidia` and `github` answer 200; `mistral`, `zhipu`,
  `volcengine` and `longcat` answer 401, which is the healthy answer from a provider that wants a key.

  The 403 carries **no Cloudflare headers**, which is what distinguishes an operator-level IP/region
  rejection from a WAF challenge — and it is why the console page and the API fail together. The README now
  carries the table plus the two-line config that turns a permanently-blocked provider off, since it would
  otherwise spend an attempt on every request.

- **The key rows follow the pool's default-enabled set.** `lib/client.js` carries a generated copy of the
  provider table, and `tests/regenerate-client-setup.mjs` filters it to `enabled === true` at build time — so
  enabling a provider through `providers.<id>.enabled` does **not** produce a key row for it. The README says
  so, and points at `apiKeyEnv` plus the credentials service for that case. Fixing it properly means letting
  the browser half read the effective enabled set from the host; that is left as a known gap rather than
  guessed at.

### Added

- `keyURL` for `zhipu`, `volcengine` and `longcat` — all three were `null`, so enabling any of them produced
  a key row with no link. Each URL was verified reachable (HTTP 200) before being added.

## [0.6.0] - 2026-10-14

**The key form is back, and this time there is a row for it to attach to.** Reverts the removal in 0.5.0,
which was decided on a premise that turned out to be false.

### Fixed

- **`settings.models.provider-card` is the *only* seat a third-party plugin has on the Models page, so
  removing the browser half removed the only way to enter a key there.** 0.5.0 dropped `lib/client.js` on
  the reasoning that "the platform already renders a configurable provider's editor from the schema". That
  holds for DSH's own two provider families and for nothing else: the page picks an editor's fields from
  `layoutOf(ns)`, hard-coded to `llm-deepseek` and `llm-pi-ai`, and returns `"unknown"` for every other
  namespace — which renders the "edit it in `cordis.patch.yml`" hint and **disables Save**
  (`dsh-client-ui-settings-models/lib/client.js:1493-1497`, `:1813-1816`, `:1828`). The own-settings-page
  fallback is real but weaker: it cannot express per-upstream keys, and it lives three clicks away from the
  page where a user looks for a model key.

  The browser half is restored from v0.4.1. Its registration is keyed `key: 'freellmapi'`, which the page
  matches against `row.entry.settingsNs` — and that row only began to exist once 0.5.0 gave the plugin a
  settings namespace and 0.5.1 pointed its directory entry at the namespace root. So 0.4.0 and 0.4.1 were
  not wasted work; they were correct code waiting on a deeper bug, and both are live again.

  The slot renders in the ordinary row card as well as in the first-run setup card
  (`dsh-client-ui-settings-models/lib/client.js:2215-2219` and `:2150-2154`), so the per-upstream key rows
  appear inside this plugin's own card whether or not anything is configured yet.

### Changed

- Restored the `./client` export, the `dsh.client` manifest block (with its `inject` ordering edges) and
  the client test suite. Suite: 411 tests.

## [0.5.1] - 2026-10-14

**The provider now shows up in the Models page.** 0.5.0 fixed why it could not; this release points its
directory entry at the right place so it is actually listed.

### Fixed

- **The configurable-provider entry declared `settingsPath: ['providers', 'freellmapi']`, which names
  something that does not exist.** `config.providers` is keyed by **upstream** provider (`groq`,
  `cerebras`, `kilo`, ...), never by the route this plugin registers, so `schema.getPath(value, path)` was
  always undefined. The Models page treats an empty path as "the namespace itself" and any other path as a
  sub-object it must be able to resolve, so the row counted as **not configured**: it was hidden from the
  card list and offered only through "add model provider" — where pressing Save would have written a junk
  `providers.freellmapi` entry into the upstream override map. The path is now `[]`.

  That also keeps `removable` false, which is correct: it requires a non-empty path, and a route the plugin
  owns is not the user's to delete.

### Documented

- **The Models page cannot render an editable form for a third-party provider, and no `settingsPath` can
  change that.** Its editor picks its fields from `layoutOf(ns)`, which is hard-coded to `llm-deepseek` and
  `llm-pi-ai` and returns `"unknown"` for every other namespace; an unknown layout renders only "other
  fields live in cordis.patch.yml" and **disables Save**
  (`dsh-client-ui-settings-models/lib/client.js:1493-1497`, `:1813-1816`, `:1828`). The provider row is
  therefore correct and visible, but read-only there — and the hint it shows is the honest one.

  This plugin's editable surface is its **own settings page** (Settings → Plugins → dsh-freellmapi), which
  is generated from the schema and exists precisely because 0.5.0 made `Config` a real schemastery schema.
  Two tests now pin the directory entry to the namespace root and assert that the namespace and the route
  id cannot drift apart.

## [0.5.0] - 2026-10-14

**The provider was invisible in the Models page while still routing traffic.** 0.4.1 chased the wrong
cause; this release fixes the real one and deletes the feature that was never needed.

### Fixed

- **`Config` silently degraded from a schemastery schema to a plain object**, which cost this plugin its
  settings namespace entirely. The schema used to be built by a *guarded* dynamic
  `import('@deepseek-ai/schemastery')` that fell back to a plain Standard Schema object on any failure.
  A profile install `link:`s this package into the profile, and Node resolves bare specifiers from a
  module's **realpath** — so the import ran against this package's own directory, never the profile's,
  got `ERR_MODULE_NOT_FOUND`, and quietly took the fallback.

  The consequence was not local and not visible. `dsh-settings` skips any entry whose `Config` lacks
  `toJSON()` (`dsh-settings/lib/index.js:538-541`), so the plugin got **no settings namespace**. The
  Models page builds its rows from `joinProviderDirectory(listProviders(), listConfigurableProviders())`
  and resolves a row's namespace by `settingsNs`; with no namespace the row is neither `configured`
  (so it is not drawn as a card) nor `addable` (so it is not offered under "add model provider"). The
  provider landed in a **dead zone — absent from the UI, working on the wire**, which is the worst
  failure shape available because everything appears to be fine.

  `Config` is now a static-import schemastery schema with no fallback at all, per
  `guide/plugin-dev-guide.md` §3.6 (*a plain object is not an acceptable `Config`; an unusable schema
  must fail loud*). `@deepseek-ai/schemastery` is declared in **`peerDependencies` and
  `devDependencies`** as `family-toolchain.md` R5 requires — the opportunistic import was a deliberate
  deviation from that rule and it is what broke.
- **The schema test could not have caught it.** It returned early when `configSchemaKind` was not
  `schemastery` — so it passed for the entire life of the bug. It now asserts, and additionally ties the
  schema to the consumer contract: `providers` must be declared, because the Models page reads a row's
  credential reference as `namespace.value[settingsPath].apiKeyEnv` and this plugin declares
  `settingsPath: ['providers', 'freellmapi']`.

### Removed

- **The browser half (`lib/client.js`), the `dsh.client` manifest block and the `./client` export.**
  0.4.0/0.4.1 assumed `settings.models.provider-card` was a seat for introducing a new provider card. It
  is not: it is an add-on *inside a row DSH already knows about*, and the card list renders only rows
  whose namespace resolved. The platform already has this UI — a configurable provider row gets the
  built-in editor and the credential indicator from the schema alone. With the schema fixed, the
  provider appears under "add model provider" and DSH's own editor stores the key through the credentials
  service, so ~25 KB of client code and its whole risk surface (bundle format, activation ordering, slot
  contracts) are gone.

### Added

- `@deepseek-ai/schemastery` in `devDependencies`, and `pnpm install` in this package for local
  development, so a `link:`-ed install resolves the schema builder from the package's own tree.

## [0.4.1] - 2026-10-14

**The settings card shipped in 0.4.0 never appeared.** No error, no log, no card — the client half was
loading and calling `slots.inject()` on a slot that did not exist yet.

### Fixed

- **`dsh.client.inject` was empty, so the browser half could activate before the slot it registers into.**
  `docs/subsystems/slots.md` states the rule plainly: *a child slot exists only when its named parent entry
  is mounted*. `settings.models.provider-card` sits under `settings.section` → `sidebar.settings`, so a half
  with no ordering edge can reach `slots.inject()` before the settings package has mounted that subtree —
  and registering into a slot that does not exist is a **silent no-op**. The official settings-card cookbook
  declares this edge (`"inject": ["@deepseek-ai/dsh-client-ui-settings"]`) and every working settings-card
  plugin carries it; this one declared `platform` alone. The manifest now orders activation after
  `@deepseek-ai/dsh-client-ui-settings` (the slot owner), `@deepseek-ai/dsh-client-locale` (the dictionary
  face) and `@deepseek-ai/dsh-client-connection` (the Remote credential face).
- **The test suite could not have caught it.** `client.test.mjs` asserted the *plugin's* cordis `inject`
  was a static array, but never the *manifest's* `dsh.client.inject` — the field that actually decides
  activation order. A new test reads `package.json`, rejects the documented function-form trap
  (`cordis` would declare zero dependencies and `apply()` would throw on the first service it touches),
  and maps each service the half reaches for to the package that provides it, so the two inject
  declarations can no longer drift apart. Verified by reverse injection: removing the manifest edge fails
  the test.

### Added

- The `settings.models.footer` and `settings.models.provider-card` slot names, plus the parent-mount rule,
  are now cited in `lib/client.js` next to the registration so the constraint is visible where it applies.

## [0.4.0] - 2026-10-14

**Provider keys can be pasted in place instead of exported into the shell.**

### Added

- **A browser half and a settings card.** Each provider without usable credentials gets a
  `settings.models.provider-card` entry showing where to get a key (with a link), which environment
  variable name the key is stored under, and a password field with an explicit save. Values are written
  through `ctx.remote.credentials.set()`, so they land in DSH's credential service — the first source the
  host-side key resolution consults, and one it reads without caching, so **a saved key takes effect
  without a restart**.
- Localized card text (`en`, `zh`) registered through `ctx.locale.register`, and a package icon.

### Changed

- Provider setup rows are guidance, not models: they never appear as selectable models and cannot be
  accidentally pinned.

## [0.3.1] - 2026-10-14

**A wrong context window was doing damage in both directions** — this release follows a real session that
sent 297 538 tokens to a model whose actual limit is 262 144.

### Fixed

- **Wrong `contextWindow` for all four `kilo` models**, measured against kilo's own `GET /api/gateway/models`.
  The single bad number set caused two opposite failures: `nemotron-3-super-120b-a12b:free` was overstated
  at 1 000 000 (so the router picked it for a 297k-token request and upstream answered `400`) while
  `nemotron-3-ultra-550b-a55b:free` was understated at 131 072 (so the model that *could* have served the
  request was filtered out by the context gate before it was ever tried). `poolside/laguna-s-2.1:free` and
  `cohere/north-mini-code:free` were corrected as well.
- **A context-window overflow now fails over instead of ending the request.** Upstream's `400
  "maximum context length"` was terminal; it is now a per-candidate condition that moves to a candidate with
  a **larger** context window (a smaller one cannot succeed, so the loop only moves in that direction). The
  refused candidate is neither cooled down nor counted as a failure, because it is healthy — the same model
  serves a shorter request fine. The hard invariant is untouched: once any chunk has reached DSH there is
  still no failover, and the stream ends with `STREAM_INTERRUPTED`.
- **A crash in the "nothing fits" path.** `contextOverflowFailure` was called with its arguments in the
  wrong order (`(plan, attempts, minimumContextWindow)` instead of `(plan, refusedUpTo, attempts)`), which
  threw `attempts.map is not a function` — but only on the path where a request had already been refused
  once *and* no wider candidate remained. The message now also reports the estimated request size and the
  widest model in the pool.
- **Per-provider `extraBody` / `extraHeaders` declarations now reach the wire**, closing the limitation
  recorded under 0.2.0. They were being dropped while the provider declaration was rebuilt, so
  `nvidia`'s required `parallel_tool_calls: false` never made it into a request body.

### Added

- **`routing.contextSafetyFactor`** (default `1.15`): the context gate now requires
  `contextWindow >= estimated tokens × this factor`. The token estimate is a heuristic and undercounts — a
  real 297 538-token session was estimated below 262 144 and slipped through the gate — so one model of
  headroom is cheaper than an upstream `400`. Values below `1` are rejected and the default applies.

## [0.3.0] - 2026-10-13

**A pinned model is now honoured or refused — never quietly replaced.**

### Changed

- **⚠️ Behaviour change: requesting a concrete model id is now a strict pin.** In v0.2.0 a pinned model
  could be *silently substituted*: with no credential configured, picking `Llama 3.3 70B · Groq` was
  answered by a different provider's model and reported as a successful turn, and a completely invented id
  (`totally-made-up-model-xyz`) was answered as well. The user could not tell. From v0.3.0, `auto` and
  `auto:simple|medium|complex` still select freely inside the pool, but any other id (the composite
  `provider/model` or a bare model id) is served **only** by that model — a pin that cannot be served fails
  with an explicit error and **zero upstream requests**.
- **The model list now shows only what can answer.** A provider that is enabled but has no usable
  credential contributes **one `setup:<provider>` guidance entry** instead of its unreachable model rows,
  and servable models are sorted ahead of the guidance. In the zero-credential default install the picker
  went from 21 advertised entries (15 of them unreachable, and sitting at the top) to 13 — 4 virtual
  routes, 6 keyless models, 3 guidance entries.

### Fixed

- **Silent substitution of pinned models** (the "answers with somebody else and calls it a success" defect
  above). The root cause was that a model id without a `/` was treated as a failed filter and fell back to
  free selection inside the pool.
- Listing models that could never be served: `listModels()` did not resolve credentials, so every enabled
  provider looked usable.

### Added

- **`setup:<provider>` guidance entries** whose names carry the exact environment variable and where to
  get a free key, e.g.
  `Groq ▸ needs GROQ_API_KEY (free key: console.groq.com/keys)`. They are signposts, not models: selecting
  one issues no request, and after the credential is set the provider's real models appear and the entry
  disappears.
- **`UNKNOWN_MODEL` and `MODEL_UNAVAILABLE` failure codes** with actionable messages: the closest model ids
  plus a "enable that provider" hint, or the per-candidate exclusion reasons (cooldown, vision, tools,
  context window) plus a "use `auto`, or retry after the cooldown" hint. `MISSING_CREDENTIAL` for a pinned
  model now names the exact variable, the free-key page, the DSH settings page, and `auto` as the
  alternative.
- Pins resolve against both spellings: the composite `provider/model` from the picker and the bare model
  id used by `GET /v1/models` and provider documentation.

## [0.2.0] - 2026-10-13

**The plugin became self-contained.** v0.1.0 forwarded everything to an external freellmapi gateway;
v0.2.0 ships its own free-provider pool and its own routing engine, so installing the plugin is the
whole setup. `gateway` mode is still there, unchanged, behind a config field.

### Added

- **`direct` mode — built-in routing, no external process.** `lib/providers.js`, `lib/router.js`,
  `lib/health.js` and `lib/dispatch.js`: a per-request complexity classifier, capability/speed ranking
  with hard gates, health tracking, and failover across providers.
- **Built-in free-provider pool: 12 providers / 30 models** — Groq, Cerebras, OpenRouter, GitHub
  Models, Mistral, Z.ai (Zhipu), Volcengine Ark, LongCat, LLM7, Kilo, NVIDIA NIM and OVH AI Endpoints,
  each model carrying capability (1–5), speed (1–5), context window, `vision` and `toolCalling`.
  Five providers are enabled by default.
- **Zero-config start.** Kilo and LLM7 answer with **no credential at all** — verified by real requests
  sent without any `Authorization` header. A fresh install has a non-empty candidate pool before
  anything is configured.
- **Per-request complexity routing.** A pure, deterministic classifier scores seven signals (estimated
  tokens, tool schemas, complexity vocabulary, reasoning burden, fenced code, conversation depth, image
  input) with a noisy-OR combination, a simple-task penalty, and a hard `medium` floor for images; the
  resulting `simple` / `medium` / `complex` tier sets the capability-vs-speed weights (0.25/0.75,
  0.50/0.50, 0.80/0.20).
- **Tier overrides in the model picker:** `auto:simple`, `auto:medium`, `auto:complex` force a lane
  while still recording the classifier's score, and pinning a `provider/model` id pins that candidate.
- **Automatic failover with one hard invariant: it only happens before the first chunk reaches DSH.**
  `429`, `5xx`, timeouts, `404 model_not_found` and `400 model_unavailable` park the failed pair and move to
  the next-ranked candidate; `401`/`403` and other `400`s do not. A mid-stream failure ends the stream
  instead of splicing two models into one answer.
- **Health tracking and cooldowns.** The **first retryable failure already parks** a candidate (2 minutes),
  and each further consecutive failure escalates one step up the `2 m → 10 m → 1 h → 24 h` ladder; a
  provider's `Retry-After` wins over the ladder; a rejected credential parks that provider for 24 h.
  Failures also lower a candidate's score (`1 / (1 + 0.15 · effectiveFailures)`, floor 0.4), and that
  penalty decays with a **60-second half-life** so a single 429 can never starve a candidate permanently.
- **Latency participates only as real evidence.** The factor is `fastest / latency` clamped to `[0.85, 1]`
  against the fastest candidate of the same request; **an unmeasured candidate no longer scores a perfect
  1.0** (it is treated as "no faster than the slowest factor measured in this request"), and a
  **100 ms noise floor** discards the whole signal when the measured spread is smaller than that, so
  warm-up jitter cannot change the selection.
- **Per-provider configuration** through `config.providers`: `enabled`, `displayName`, `baseURL`,
  `apiKeyEnv`, `apiKey`, `keyless` and `models` (which replaces a provider's model list wholesale, so a
  drifted catalog can be corrected without a release). Providers that are not in the built-in pool can
  be added the same way.
- **Routing-engine knobs** through `config.routing`: `maxAttempts` (6), `budgetMs` (45 000),
  `thresholds`, `weights` and `preferredOrder`.
- **Direct-mode routing log line** (`logRouting`, default on):
  `dsh-freellmapi: tier=complex -> provider/model (capability=5, speed=3, 2 candidates tried)`.
- **Bounded attempt budget** and new in-band failure codes: `NO_CANDIDATES`,
  `ALL_CANDIDATES_FAILED`, `STREAM_INTERRUPTED`, `MODEL_UNAVAILABLE` (the deliberate exception to
  "400 is not retryable", because aggregators rotate their catalogs).

### Changed

- **`mode` now defaults to `direct`, and that is a behaviour change.** An install that used to forward
  every request to `http://localhost:3001` now routes across the built-in pool instead. Set
  `mode: gateway` (plus `baseURL` and a `freellmapi-…` key) to get the v0.1.0 behaviour back.
- The model picker in `direct` mode lists `auto`, the three tier overrides and every enabled
  `provider/model`, instead of the gateway's virtual routes and discovered catalog.
- `resolveModel()` in `direct` mode takes the context window, output cap and modalities of the pinned
  pool entry, so DSH's compaction budget matches the model that will actually answer.
- A missing provider credential is now a **silent, supported state** rather than an error path:
  unconfigured providers are dropped from the candidate pool without warnings.

### Fixed

- `model_unavailable` (HTTP 400) is recognised as a per-`(provider, model)` condition and triggers
  failover, instead of being classified as a permanently bad request. Other `400`s keep their
  non-retryable classification.
- The latency penalty can no longer flip a tier decision: its floor was raised from 0.5 to 0.85 after a
  forced `auto:simple` request was observed changing to a strong-but-slow model.
- Catalog corrections from the live keyless probe: removed `kilo`'s non-existent
  `poolside/laguna-m.1:free` (404) and two `llm7` ids that answered `400 model_unavailable` (one of
  which was also mislabelled `vision: true`); added `llm7`'s verified `DeepSeek-V4-Flash-0731` and
  three free `kilo` models.

### Known limitations

- No end-to-end run against real keyed providers; rate-limit numbers are the upstream 2026-04 baseline.
- The complexity classifier is a heuristic and demonstrably misjudges (see the README's worked
  counter-examples); pin a tier or a model when you know better.
- `zhipu`'s `baseURL` is the riskiest entry in the pool, and `volcengine` / `longcat` model ids are
  inferred; all three ship disabled with `confidence: 'speculative'`.
- Free catalogs drift (`model_unavailable` is normal weather, not a bug).
- `nvidia` declares `parallel_tool_calls: false` but the declaration never reaches the wire; NVIDIA is
  disabled by default.
- Health state is not persisted across restarts, and a failed-over answer comes from a different model
  than the top-ranked one.
- Still open from the v0.1.0 verification round: `maxTokens` above `Number.MAX_SAFE_INTEGER`,
  plain-string `user` content, `includeFusion: false` being undone by the gateway's own `fusion` entry
  (gateway mode), and duplicate ids from `discover()`.

## [0.1.0] - 2026-10-13

First public release.

### Added

- DSH LLM adapter for a self-hosted [freellmapi](https://github.com/tashfeenahmed/freellmapi)
  gateway, registered as the provider route `freellmapi` (displayed as **FreeLLMAPI (Auto)**).
- Auto-routing models in the DSH model picker: bare `auto` (current fallback chain) first, then
  the global strategies `auto:smart`, `auto:fast`, `auto:cheap`, `auto:reliable` and
  `auto:balanced`, plus `fusion` and any named fallback chain (`auto:<profile>`) discovered from
  the gateway. The model string is forwarded verbatim, and unlisted ids are still answered —
  the catalog is a convenience, not a whitelist.
- Live model discovery from the running router (`GET /v1/models`), with a configurable timeout
  and cache window (`discoveryTimeoutMs`, `discoveryCacheMs`). Discovery failures keep the last
  cached catalog and leave the virtual routes selectable instead of emptying the picker.
- Streaming chat completions over `POST /v1/chat/completions` (SSE): incremental SSE decoding
  across chunk boundaries, tool calls, `delta.reasoning_content`, captured usage frames, and the
  gateway's additive `_fusion` frames.
- Image input support (`vision`): referenced attachments are inlined as `data:` URLs, and an
  attachment that cannot be read degrades to a text placeholder instead of failing the request.
- Upstream routing observability: `X-Routed-Via` (the provider/model that actually served the
  request), plus `X-Fallback-Attempts` / `X-Fallback-Trail` when a fallback happened, reported
  through the DSH log under the `logRoutedVia` switch. The last 50 observations are also kept in
  a process-wide ring buffer (`getRecentRoutes()`).
- Gateway-aware error translation, reported **in-band** as a terminal error chunk rather than a
  thrown exception: `AUTH`, `RATE_LIMIT`, `QUOTA`, `CONTEXT_WINDOW_EXCEEDED`,
  `UNSUPPORTED_CONTENT`, `UNSUPPORTED_OPTION`, `INVALID_REQUEST`, `SERVER`, `TRANSPORT`, `TIMEOUT`,
  `ABORTED`, `MISSING_CREDENTIAL`, `INVALID_CREDENTIAL`, `EMPTY_RESPONSE`, `CONTENT_FILTER` and
  `UNKNOWN`. Unknown `auto:<profile>` (`400`) and exhausted quota (`429`, including `Retry-After`
  parsed into DSH's retry-after field) get messages that say what to do next. An in-band error
  frame from the gateway keeps its own `error.code` verbatim (falling back to `SERVER` only when
  the frame carries none), so codes the gateway invents are reported as-is rather than normalised
  into a retryable one.
- Configuration through the DSH settings page and the profile patch file: `baseURL`, `apiKeyEnv`,
  `apiKey`, `maxTokensField`, `logRoutedVia`, `includeFusion`, `exposeDiscoveredModels`, `vision`,
  `contextWindow`, `maxTokens`, `timeoutMs`, `discoveryTimeoutMs`, `discoveryCacheMs`, `headers`,
  `taskType` (`X-FreeLLM-Task-Type`) and `cacheMode` (`X-FreeLLM-Cache`). The key is resolved per
  request through the DSH credentials service, with an inline value and the environment as
  fallbacks; no configuration value can prevent the plugin from loading.
- Zero runtime dependencies: no `dependencies` at all, and the DSH LLM runtime is resolved with a
  guarded dynamic import that falls back to local shims outside DSH, so the plugin never
  materialises a second copy of `@deepseek-ai/*`. The only declared peer is the optional
  `@deepseek-ai/cordis`.

### Known limitations

Registered from the independent verification round; none of these blocks a release, and none is
fixed in 0.1.0.

- `maxTokens` above `Number.MAX_SAFE_INTEGER` is accepted by the config but rejected by DSH: the
  runtime requires a safe integer for `defaultMaxTokens`, so `resolveModel()` returns metadata DSH
  refuses with `INVALID_MODEL_MAX_TOKENS` instead of clamping the value.
- A `role: "user"` message whose `content` is a plain string is sent with empty content. DSH always
  supplies `ContentBlock[]`, so DSH itself cannot produce that shape, but `lib/wire.js` tolerates
  strings in its own `textOf` helper — an internal inconsistency rather than a reachable path.
- `includeFusion: false` removes `fusion` from the static catalog, but the gateway's own
  `GET /v1/models` response lists it and model discovery merges it back. `exposeDiscoveredModels:
  false` is required as well to hide it completely.
- `discover()` can return duplicate model ids when the gateway lists an id twice. DSH's own
  `discoverModels` step de-duplicates by endpoint order, so the GUI is unaffected.

### Notes

- This is an unofficial community plugin. It is not affiliated with, endorsed by or
  supported by the freellmapi project or by DeepSeek.
- freellmapi's official `setup-dsh` integration already covers the plain "use the gateway
  from DSH" case without any plugin; see the README for an honest comparison.
- **The official route and this plugin cannot be enabled at the same time:** both own the DSH
  provider route name `freellmapi`. Installing this plugin while a `setup-dsh` route exists makes
  the plugin refuse to load with a message naming the conflict; remove one of the two.
- MIT licensed.

[Unreleased]: https://github.com/lion231226/dsh-freellmapi/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/lion231226/dsh-freellmapi/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/lion231226/dsh-freellmapi/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/lion231226/dsh-freellmapi/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/lion231226/dsh-freellmapi/releases/tag/v0.1.0
