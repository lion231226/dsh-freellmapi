# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

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

[Unreleased]: https://github.com/lion231226/dsh-freellmapi/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/lion231226/dsh-freellmapi/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/lion231226/dsh-freellmapi/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/lion231226/dsh-freellmapi/releases/tag/v0.1.0
