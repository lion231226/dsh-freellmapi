# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

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

[Unreleased]: https://github.com/lion231226/dsh-freellmapi/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lion231226/dsh-freellmapi/releases/tag/v0.1.0
