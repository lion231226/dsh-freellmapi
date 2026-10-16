/**
 * dsh-freellmapi — a FreeLLMAPI (Auto) provider route for DeepSeek Harness.
 *
 * Install the package as a DSH plugin bundle and one provider route appears in
 * the model picker:
 *
 * ```text
 * provider  freellmapi            "FreeLLMAPI (Auto)"
 * models    auto                  ← the gateway picks the best available model
 *           auto:smart            ← intelligence first
 *           auto:fast             ← throughput / time-to-first-byte first
 *           auto:cheap            ← budget leaning
 *           auto:reliable         ← recent success rate first
 *           auto:balanced         ← the default mix
 *           fusion                ← panel of models + judge synthesis
 *           auto:<profile>        ← any named fallback chain (free-form, not a whitelist)
 *           <catalog ids from GET /v1/models>
 * ```
 *
 * A request is forwarded to `POST {baseURL}/chat/completions` with `stream: true`
 * and the model string **verbatim**, so the gateway's own routing, failover and
 * prompt compression stay in charge; the upstream SSE is translated back into
 * DSH `StreamChunk`s.
 *
 * ## Design constraints this file honours
 *
 * - **Zero runtime dependencies.** `dependencies` is absent, and the only
 *   declared peer is the optional `@deepseek-ai/cordis`. `@deepseek-ai/dsh-llm`
 *   is resolved opportunistically at runtime (see `./runtime.js`) — declaring it
 *   would make the profile materialise a second copy and break module identity.
 * - **No configuration value can prevent the plugin from loading.**
 *   `./config.js` validates totally and degrades to defaults.
 * - **`stream()` never throws.** Every failure — HTTP, transport, mid-stream
 *   gateway error, cancellation — becomes a terminal `finish` chunk. The only
 *   thrown errors are the registration-time contract violations the runtime
 *   expects (`INVALID_ADAPTER`, `DUPLICATE_ADAPTER`, `MISSING_CREDENTIAL` inside
 *   the stream is reported in-band instead).
 * - **Every upstream request carries `...attributionHeaders()`** and uses
 *   `redirect: 'error'`, so the harness identity reaches the gateway and a
 *   redirect cannot leak the credential to a third host.
 *
 * @module dsh-freellmapi
 */

import { readFile } from 'node:fs/promises'

import {
  LlmAdapter,
  LlmError,
  attributionHeaders,
  assertUsableApiKey,
} from './runtime.js'
import {
  Config as PluginConfig,
  NS,
  PROVIDER_ID,
  PROVIDER_NAME,
  DEFAULT_BASE_URL,
  configSchemaKind,
  normalizeConfig,
} from './config.js'
import { AUTO_MODEL, buildCatalog, buildDirectCatalog, builtinRoutes, DIRECT_ROUTES, FORCED_TIER_MODELS, ModelDiscovery, SETUP_MODEL_PREFIX, setupModelEntry } from './catalog.js'
import { ChunkTranslator } from './translate.js'
import { classifyFrame } from './frames.js'
import { decodeSseBody } from './sse.js'
import { describeHttpFailure, describeTransportFailure, describeUnknown, retryAfterMs } from './errors.js'
import { assertSupportedOptions, buildChatRequest, collectImageParts, contentHasImage } from './wire.js'
import { formatDirectRouteLine, formatRouteLine, reportRoute, getRecentRoutes, readRoutingHeaders, recordRoute } from './routes.js'
import { scoreComplexity } from './complexity.js'
import { HealthTracker } from './health.js'
import { isProviderUsable, listProviderModels, providerDeclarations, resolveProviderKey, splitPoolModelId, BUILTIN_PROVIDER_IDS } from './providers.js'
import { explainExclusions, rankCandidates } from './router.js'
import { dispatchWithFailover } from './dispatch.js'

/** Package name used in diagnostics. */
const PACKAGE = 'dsh-freellmapi'

/**
 * Failure code for selecting a `setup:<provider>` guidance row. See
 * `setupRequiredFailure()` for why this is not `MISSING_CREDENTIAL`.
 */
const SETUP_REQUIRED_CODE = 'SETUP_REQUIRED'

/**
 * The lowest capacity `auto` will ever declare to DSH.
 *
 * DSH's compaction threshold is `min(W × 0.8, W − 65,536)`. Just above 65,536 the
 * second term collapses toward 1, so declaring only slightly more than the
 * headroom would make DSH compact on essentially every step. 131,072 keeps the
 * threshold at 65,536 — the value DSH was already using — while leaving room for
 * the pool's mid-size models. Models below this are excluded from `auto` rather
 * than lowering the declaration.
 */
const COMPACTION_CAPACITY_FLOOR = 131_072

/** Largest attachment the adapter will inline as a `data:` URL. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** Display names for the gateway's virtual routes, resolved once. */
const BUILTIN_NAMES = new Map(builtinRoutes({ includeFusion: true }).map((route) => [route.id, route.name]))

/** Display names for the direct-mode virtual routes, resolved once. */
const DIRECT_NAMES = new Map(DIRECT_ROUTES.map((route) => [route.id, route.name]))

/**
 * The failure for selecting a `setup:<provider>` guidance row.
 *
 * The message **is** the picker entry: it is built by the same
 * `setupModelEntry()` the model list uses, so the row the user clicked and the
 * answer they get cannot drift apart. Returns `undefined` when the id names a
 * provider that is not in the pool at all — that really is an unknown model.
 *
 * The code is `SETUP_REQUIRED` rather than `MISSING_CREDENTIAL`: this is a
 * different user action. `MISSING_CREDENTIAL` means "you asked for a real model
 * that this machine cannot serve"; this means "you clicked the row that exists to
 * tell you to add a key". Keeping them apart also preserves `UNKNOWN_MODEL` for
 * genuinely mistyped ids — all three are distinct conditions with distinct fixes.
 *
 * @param {string} runtimeProvider
 * @param {ReturnType<typeof normalizeConfig>} config
 * @param {string} model
 * @returns {{message: string, code: string} | undefined}
 */
function setupRequiredFailure(runtimeProvider, config, model) {
  const providerId = model.slice(SETUP_MODEL_PREFIX.length)
  if (providerId.length === 0) return undefined
  const declaration = providerDeclarations(config).find((entry) => entry.id === providerId)
  if (declaration === undefined) return undefined
  return { code: SETUP_REQUIRED_CODE, message: setupModelEntry(runtimeProvider, providerId, declaration).description }
}

/**
 * Build a terminal `finish` chunk.
 * @param {{message: string, code: string, status?: number}} failure
 * @param {'error' | 'aborted'} [kind]
 * @returns {Record<string, any>}
 */
function terminalFailure(failure, kind = 'error') {
  return { type: 'finish', reason: { kind, failure } }
}

/** The host part of a key-application URL, for a compact hint. */
function keyHostOf(keyURL) {
  if (typeof keyURL !== 'string' || keyURL.length === 0) return null
  const stripped = keyURL.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  return stripped.length > 0 ? stripped : null
}

/**
 * Score how close one pool model id is to what the user asked for.
 *
 * Deterministic and deliberately simple: shared substrings first, then a shared
 * prefix. The point is only to turn "nothing matched" into "did you mean …?".
 */
function similarity(query, candidate) {
  const a = query.toLowerCase()
  const b = candidate.toLowerCase()
  if (a === b) return 1000
  let score = 0
  if (b.includes(a) || a.includes(b)) score += 200
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1
  score += prefix * 4
  for (let size = 4; size <= Math.min(12, a.length); size += 1) {
    for (let start = 0; start + size <= a.length; start += 1) {
      if (b.includes(a.slice(start, start + size))) score += size
    }
  }
  return score
}

/**
 * The diagnosis for a pinned model id that no provider in the pool serves.
 *
 * @param {string} pin
 * @param {readonly Record<string, any>[]} pool
 * @returns {{message: string, code: string}}
 */
function unknownModelFailure(pin, pool) {
  const ids = [...new Set(pool.map((entry) => entry.model))]
  const suggestions = ids
    .map((id) => ({ id, score: similarity(pin, id) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => (right.score - left.score) || (left.id < right.id ? -1 : 1))
    .slice(0, 3)
    .map((entry) => entry.id)
  const parts = [`${PACKAGE}: no provider in the pool serves the model id "${pin}"`]
  if (suggestions.length > 0) parts.push(`Closest matches: ${suggestions.join(', ')}`)
  const prefix = pin.includes('/') ? pin.slice(0, pin.indexOf('/')) : ''
  if (prefix.length > 0 && BUILTIN_PROVIDER_IDS.includes(prefix) && !pool.some((entry) => entry.provider === prefix)) {
    parts.push(`Provider "${prefix}" is disabled by default — enable it under \`config.providers.${prefix}\` to use its models`)
  }
  parts.push('Select "auto" to let the plugin pick a model that is actually available')
  return { code: 'UNKNOWN_MODEL', message: `${parts.join('. ')}.` }
}

/**
 * Whether any message in a request carries an image block.
 * @param {unknown} messages
 * @returns {boolean}
 */
function messagesHaveImage(messages) {
  if (!Array.isArray(messages)) return false
  return messages.some((message) => contentHasImage(message?.content))
}

/** Stable cordis plugin name (also the loader entry id in `cordis.patch.yml`). */
export const name = NS

/** The `llm` service is a hard dependency; `settings`/`credentials` are optional. */
export const inject = ['llm']

/** The plugin config schema: a schemastery schema when the host has one. */
export const Config = PluginConfig

export { configSchemaKind, getRecentRoutes, formatRouteLine, formatDirectRouteLine }

/**
 * Read one environment variable, case-insensitively on Windows.
 * @param {string} key
 * @returns {string | undefined}
 */
function readProcessEnv(key) {
  if (key.length === 0) return undefined
  const direct = process.env[key]
  if (typeof direct === 'string') return direct
  if (process.platform !== 'win32') return undefined
  const upper = key.toUpperCase()
  for (const [name, value] of Object.entries(process.env)) {
    if (name.toUpperCase() === upper && typeof value === 'string') return value
  }
  return undefined
}

/**
 * The plugin's adapter: one provider route, one upstream endpoint.
 */
class FreellmapiAdapter extends LlmAdapter {
  #ctx
  #provider
  #readConfig
  #discovery
  #fetchImpl
  #health

  /**
   * @param {object} options
   * @param {any} options.ctx the cordis context, used only for optional services
   * @param {string} options.provider the route id this adapter serves
   * @param {() => ReturnType<typeof normalizeConfig>} options.readConfig
   * @param {typeof fetch} [options.fetchImpl] injection point for tests
   * @param {HealthTracker} [options.health] injection point for tests
   */
  constructor(options) {
    super()
    this.#ctx = options.ctx
    this.#provider = options.provider
    this.#readConfig = options.readConfig
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.#health = options.health ?? new HealthTracker()
    this.#discovery = new ModelDiscovery({
      cacheMs: options.readConfig().discoveryCacheMs,
      timeoutMs: options.readConfig().discoveryTimeoutMs,
      fetchImpl: this.#fetchImpl,
    })
  }

  /** The direct-mode health tracker (exposed for diagnostics and tests). */
  get health() {
    return this.#health
  }

  /**
   * Provider metadata for the model picker. `id` must equal the registered
   * route or registration fails with `INVALID_ADAPTER`.
   * @param {string} provider
   * @returns {{id: string, name: string}}
   */
  providerInfo(provider) {
    return { id: provider, name: PROVIDER_NAME }
  }

  /**
   * Deliberately `undefined`: FreeLLMAPI already performs its own 429 cooldown
   * and cross-provider failover, so stacking DSH retries on top would multiply
   * latency for a condition the gateway is better placed to fix. Returning
   * `undefined` selects the runtime default (normal mode, 5 retries,
   * 500 ms → 10 s backoff). The runtime does **not** validate non-undefined
   * return values, so anything else would have to be a `resolveRetryPolicy()`
   * product.
   * @param {string} _provider
   * @returns {undefined}
   */
  providerRetryPolicy(_provider) {
    return undefined
  }

  /**
   * The model picker's catalog.
   *
   * **direct mode** (default): `auto` first, then the three `auto:<tier>` overrides,
   * then every enabled `provider/model` in the pool.
   * **gateway mode**: the gateway's virtual routes first, then whatever
   * `GET /v1/models` reports.
   *
   * Never throws either way: a discovery or pool failure still leaves the static
   * routes selectable.
   * @param {string} provider
   * @returns {Promise<ReturnType<typeof buildCatalog>>}
   */
  async listModels(provider) {
    const config = this.#readConfig()
    if (config.mode === 'direct') {
      try {
        const pool = listProviderModels(config)
        // Resolve credentials here too, not only at dispatch: a provider the user
        // has not configured contributes one "needs KEY" hint instead of its
        // models. Listing dead rows ahead of the working ones is what made the
        // picker look broken — 15 of 21 entries were unreachable in the default
        // zero-credential install.
        const keys = await this.#resolveProviderKeys(config, pool)
        /** @type {Map<string, boolean>} */
        const usable = new Map()
        for (const [providerId, resolved] of keys) usable.set(providerId, resolved.usable === true)
        return buildDirectCatalog({ provider, vision: config.vision }, pool, { usable })
      } catch {
        return buildDirectCatalog({ provider, vision: config.vision }, [])
      }
    }
    let discovered = []
    if (config.exposeDiscoveredModels) {
      try {
        const apiKey = await this.#resolveApiKey(config)
        discovered = await this.#discoveryFor(config).list({
          baseURL: this.#resolveBaseURL(config),
          ...apiKey === undefined ? {} : { apiKey },
        })
      } catch {
        discovered = []
      }
    }
    return buildCatalog(
      { provider, includeFusion: config.includeFusion, vision: config.vision },
      discovered,
    )
  }

  /**
   * Exact metadata for one model id. Unlisted ids are answered rather than
   * rejected: the gateway accepts any catalog id and answers unknown `auto:`
   * profiles with a hard 400, and the direct pool can serve a model the picker
   * has not listed.
   *
   * @param {string} provider
   * @param {string} model
   * @param {AbortSignal} [_signal]
   * @returns {Promise<Record<string, unknown>>}
   */
  resolveModel(provider, model, _signal) {
    return Promise.resolve(this.#modelInfo(this.#readConfig(), provider, model))
  }

  /**
   * Bind one generation to a configuration snapshot, so a settings change
   * between preparation and dispatch cannot combine one generation's endpoint
   * with another's capabilities.
   * @param {string} provider
   * @param {string} model
   * @param {AbortSignal} [_signal]
   */
  prepareCall(provider, model, _signal) {
    const snapshot = this.#readConfig()
    return Promise.resolve({
      model: this.#modelInfo(snapshot, provider, model),
      stream: (options) => this.#streamWithSnapshot(options, snapshot),
    })
  }

  /**
   * The one abstract member. Reads the live configuration, then delegates.
   * @param {Record<string, any>} options
   * @returns {AsyncIterable<any>}
   */
  stream(options) {
    return this.#streamWithSnapshot(options, this.#readConfig())
  }

  /**
   * Discovery offer for `ctx.llm.registerModelDiscovery()`.
   * @param {{provider?: string, baseURL?: string, apiKey?: string}} request
   * @param {AbortSignal} [signal]
   * @returns {Promise<Record<string, unknown>[]>}
   */
  async discover(request, signal) {
    const config = this.#readConfig()
    const baseURL = typeof request?.baseURL === 'string' && request.baseURL.length > 0
      ? request.baseURL.replace(/\/+$/, '')
      : this.#resolveBaseURL(config)
    let apiKey
    if (typeof request?.apiKey === 'string' && request.apiKey.length > 0) {
      apiKey = request.apiKey
    } else {
      try {
        apiKey = await this.#resolveApiKey(config)
      } catch {
        apiKey = undefined
      }
    }
    const models = await this.#discoveryFor(config).list({
      baseURL,
      ...apiKey === undefined ? {} : { apiKey },
      ...signal === undefined ? {} : { signal },
      force: true,
    })
    const modalities = config.vision === false ? ['text'] : ['text', 'image']
    return models.map((model) => ({
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      inputModalities: modalities,
    }))
  }

  // ---------------------------------------------------------------- internals

  /**
   * Model metadata for `resolveModel()`. In direct mode an explicit
   * `provider/model` pick takes its context window and modalities from the pool
   * entry, so DSH's compaction budget matches the model that will actually
   * answer; `auto` and the tier overrides use the configured defaults.
   *
   * @param {ReturnType<typeof normalizeConfig>} config
   * @param {string} provider
   * @param {string} model
   * @returns {Record<string, unknown>}
   */
  #modelInfo(config, provider, model) {
    if (config.mode === 'direct') {
      // A guidance row must answer to the same name the picker shows it under.
      if (model.startsWith(SETUP_MODEL_PREFIX)) {
        const providerId = model.slice(SETUP_MODEL_PREFIX.length)
        const declaration = providerDeclarations(config).find((entry) => entry.id === providerId)
        if (declaration !== undefined) {
          const defaultMaxTokens = config.maxTokens > 0 ? config.maxTokens : undefined
          return {
            provider,
            id: model,
            name: setupModelEntry(provider, providerId, declaration).name,
            inputModalities: ['text'],
            context: { contextWindow: config.contextWindow },
            ...defaultMaxTokens === undefined ? {} : { defaultMaxTokens },
          }
        }
      }
      const picked = splitPoolModelId(model)
      let entry
      if (picked !== undefined) {
        entry = listProviderModels(config).find(
          (candidate) => candidate.provider === picked.provider && candidate.model === picked.model,
        )
      }
      const directName = DIRECT_NAMES.get(model)
      const caps = entry?.caps
      // ★ This is the branch `auto` actually takes: it is not a `provider/model`
      // pair, so it has no caps, and the declaration used to fall straight through
      // to `config.contextWindow` — a single number covering a pool whose windows
      // span an order of magnitude. Measured 2026-10-15: declared 131,072 while a
      // 32,000-token model served every plain request, so DSH (which budgets its
      // compaction threshold from this declaration) let a session grow past the
      // model's real limit.
      //
      // A pinned `provider/model` (`picked !== undefined`) keeps its own caps when it
      // has them: the capacity contract exists to constrain `auto`'s own choices, not
      // the user's explicit one.
      const contextWindow = caps?.contextWindow
        ?? (picked === undefined ? declaredCapacityFor(config) : config.contextWindow)
      const defaultMaxTokens = config.maxTokens > 0 ? config.maxTokens : caps?.maxTokens
      return {
        provider,
        id: model,
        name: directName ?? (entry === undefined ? model : `${entry.modelName} · ${entry.displayName}`),
        inputModalities: caps?.vision === true && config.vision !== false ? ['text', 'image'] : ['text'],
        context: { contextWindow },
        // ★ Thinking effort, declared only where it can be KEPT.
        //
        // Two conditions, and both are load-bearing:
        //
        //  1. `forwardReasoningEffort` must be on. Declaring while the adapter is
        //     configured to withhold the field would be a promise it does not keep:
        //     DSH would accept the effort, then the adapter would drop it. Gating
        //     both on one flag makes declaration and forwarding impossible to
        //     disagree.
        //  2. The declaration is per CONCRETE model (`entry.reasoning`, measured —
        //     only groq's three rows carry it today). It is deliberately NOT made on
        //     `auto`: a pool-wide intersection is not the vocabulary of whichever
        //     model the router ends up choosing, so an `auto` declaration would be
        //     true of no single model.
        //
        // `defaultEffort` is omitted on purpose. Setting it would make DSH inject an
        // effort into every request that did not ask for one — including requests
        // routed to a model that would ignore it.
        ...config.forwardReasoningEffort === true && Array.isArray(entry?.reasoning) && entry.reasoning.length > 0
          ? { reasoning: { efforts: entry.reasoning.map((id) => ({ id, name: id })) } }
          : {},
        ...defaultMaxTokens === undefined || defaultMaxTokens <= 0 ? {} : { defaultMaxTokens },
      }
    }
    const discovered = this.#discovery.find(model)
    // ★ `auto` is ONE model name standing for a whole pool whose windows differ by
    // more than an order of magnitude. DSH budgets its compaction threshold from the
    // capacity declared here (threshold = min(W*0.8, W - headroom), headroom 65,536),
    // so a declaration wider than what routing may actually pick lets a session grow
    // past the model's real limit — measured 2026-10-15: declared 131,072 while a
    // 32,000-token model served every plain request.
    //
    // `config.contextWindow` therefore means the **upper bound** the operator is
    // willing to budget, and the declaration is `min(pool, config)` — never wider
    // than what can be served. It is *not* lowered below `COMPACTION_CAPACITY_FLOOR`:
    // just above DSH's 65,536 headroom the threshold collapses to
    // `min(W*0.8, W - 65536)` ≈ 1, which would compact on every single step. Below
    // the floor the models are excluded from `auto` instead (see the routing block).
    const contextWindow = discovered?.contextWindow ?? declaredCapacityFor(config)
    const defaultMaxTokens = config.maxTokens > 0 ? config.maxTokens : discovered?.maxTokens
    return {
      provider,
      id: model,
      name: BUILTIN_NAMES.get(model) ?? model,
      inputModalities: config.vision === false ? ['text'] : ['text', 'image'],
      context: { contextWindow },
      ...defaultMaxTokens === undefined || defaultMaxTokens <= 0 ? {} : { defaultMaxTokens },
    }
  }

  /**
   * Refresh the discovery cache policy from the live configuration before use,
   * so a settings edit changes the cache window without re-registering.
   * @param {ReturnType<typeof normalizeConfig>} config
   * @returns {ModelDiscovery}
   */
  #discoveryFor(config) {
    this.#discovery.cacheMs = config.discoveryCacheMs
    this.#discovery.timeoutMs = config.discoveryTimeoutMs
    return this.#discovery
  }

  /**
   * `FREELLMAPI_BASE_URL` is honoured only while `baseURL` still holds its
   * built-in default, so an explicit setting always wins.
   * @param {ReturnType<typeof normalizeConfig>} config
   * @returns {string}
   */
  #resolveBaseURL(config) {
    if (config.baseURL !== DEFAULT_BASE_URL) return config.baseURL
    const fromEnv = readProcessEnv('FREELLMAPI_BASE_URL')?.trim().replace(/\/+$/, '')
    if (fromEnv !== undefined && fromEnv.length > 0 && /^https?:\/\/[^\s]+$/i.test(fromEnv)) return fromEnv
    return config.baseURL
  }

  /**
   * Resolve the credential for one request.
   *
   * Order: the credentials service (which is itself layered over process env →
   * managed storage → `$DSH_HOME/.env`), then an inline value from the plugin's
   * own settings, then the environment. Resolution happens **per request** — a
   * rotated key takes effect on the next call without a restart.
   *
   * @param {ReturnType<typeof normalizeConfig>} config
   * @returns {Promise<string | undefined>} a validated key, or undefined
   */
  async #resolveApiKey(config) {
    const ref = config.apiKeyEnv
    const credentials = this.#service('credentials')
    if (credentials !== undefined && typeof credentials.resolve === 'function' && ref.length > 0) {
      try {
        const hit = await credentials.resolve(ref)
        const value = typeof hit?.value === 'string' ? hit.value : undefined
        if (value !== undefined && value.trim().length > 0) return assertUsableApiKey(value, PACKAGE, ref)
      } catch (error) {
        if (error instanceof Error && /** @type {any} */ (error).code === 'INVALID_CREDENTIAL') throw error
        // A failing credential seam must not mask the environment fallback.
      }
    }
    if (config.apiKey.length > 0) return assertUsableApiKey(config.apiKey, PACKAGE, 'apiKey')
    for (const key of ref.length > 0 ? [ref, 'FREELLMAPI_API_KEY'] : ['FREELLMAPI_API_KEY']) {
      const value = readProcessEnv(key)
      if (value !== undefined && value.trim().length > 0) return assertUsableApiKey(value, PACKAGE, key)
    }
    return undefined
  }

  /** @param {string} name @returns {any} */
  #service(name) {
    try {
      return typeof this.#ctx?.get === 'function' ? this.#ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Read one image attachment as a `data:` URL.
   *
   * The attachments service exposes a host path (`attachments.imageHostPath`),
   * which is the only documented way to reach the bytes from an adapter. Any
   * failure returns `undefined`, and the caller degrades that one image to a
   * text placeholder — an unreadable attachment must never fail the request.
   *
   * @param {Record<string, unknown>} ref
   * @returns {Promise<string | undefined>}
   */
  async #readImage(ref) {
    const attachments = this.#service('attachments')
    if (attachments === undefined || typeof attachments.imageHostPath !== 'function') return undefined
    let hostPath
    try {
      hostPath = attachments.imageHostPath(ref)
    } catch {
      return undefined
    }
    if (typeof hostPath !== 'string' || hostPath.length === 0) return undefined
    try {
      const bytes = await readFile(hostPath)
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return undefined
      const mediaType = typeof ref.mediaType === 'string' && ref.mediaType.length > 0 ? ref.mediaType : 'image/png'
      return `data:${mediaType};base64,${bytes.toString('base64')}`
    } catch {
      return undefined
    }
  }

  /** @returns {{info: Function} | undefined} the cordis logger, defensively */
  #logger() {
    const logger = this.#ctx?.logger
    if (logger === undefined || logger === null) return undefined
    if (typeof logger.info === 'function') return { info: logger.info.bind(logger) }
    return undefined
  }

  /**
   * Record and, when enabled, log the upstream route that served the response.
   * @param {Response} response
   * @param {ReturnType<typeof normalizeConfig>} config
   * @param {Record<string, any>} options
   */
  #reportRoute(response, config, options) {
    const routing = readRoutingHeaders(response)
    const record = recordRoute({
      at: Date.now(),
      routedVia: routing.routedVia,
      requestedModel: String(options?.model ?? ''),
      requestedProvider: String(options?.provider ?? this.#provider),
      ...routing.fallbackAttempts === undefined ? {} : { fallbackAttempts: routing.fallbackAttempts },
      ...routing.fallbackTrail === undefined ? {} : { fallbackTrail: routing.fallbackTrail },
      status: response.status,
    })
    if (!config.logRoutedVia) return
    try {
      this.#logger()?.info(formatRouteLine(record))
    } catch {
      // Observability must never be able to fail a request.
    }
  }

  /**
   * Combine the caller's signal with the configured timeout.
   * @param {AbortSignal | undefined} signal
   * @param {number} timeoutMs
   * @returns {{signal: AbortSignal | undefined, timedOut: () => boolean, dispose: () => void}}
   */
  #requestSignal(signal, timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return { signal, timedOut: () => false, dispose: () => {} }
    }
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    // A pending timer must not keep the host process alive.
    if (typeof timer.unref === 'function') timer.unref()
    const combined = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
    return {
      signal: combined,
      timedOut: () => timedOut,
      dispose: () => clearTimeout(timer),
    }
  }

  /**
   * The generator every dispatch path funnels through: pick the engine by mode.
   * @param {Record<string, any>} options
   * @param {ReturnType<typeof normalizeConfig>} config
   * @returns {AsyncGenerator<any>}
   */
  async *#streamWithSnapshot(options, config) {
    if (config.mode === 'direct') {
      yield* this.#streamDirect(options, config)
      return
    }
    yield* this.#streamGateway(options, config)
  }

  /**
   * Direct mode: classify the request, rank the built-in pool, and fail over
   * until one provider starts streaming.
   *
   * `dispatchWithFailover` owns the retry loop and the "never fail over after the
   * first chunk" invariant; this method only builds the plan. It never throws.
   *
   * @param {Record<string, any>} options
   * @param {ReturnType<typeof normalizeConfig>} config
   * @returns {AsyncGenerator<any>}
   */
  async *#streamDirect(options, config) {
    try {
      const model = String(options?.model ?? '')
      const signal = options?.signal
      if (signal?.aborted === true) {
        yield terminalFailure({ message: `${PACKAGE}: the caller aborted the request`, code: 'ABORTED' }, 'aborted')
        return
      }
      assertSupportedOptions(options)

      const decision = scoreComplexity(options, {
        thresholds: config.routing.thresholds,
        weights: config.routing.weights,
      })
      const forcedTier = FORCED_TIER_MODELS[model]
      const tier = forcedTier ?? decision.tier
      const needsVision = messagesHaveImage(options?.messages)
      const needsTools = Array.isArray(options?.tools) && options.tools.length > 0
      // ★ Set before any branch reads it: a context-summarisation call is not a
      // normal step, and every early return below has to know that. See the routing
      // block further down for what changes and why.
      const isCompaction = options?.purpose === 'compaction'
      const now = Date.now()

      const pool = listProviderModels(config)
      // ★ A `setup:` entry is a row we chose to advertise, not a model the user
      // mistyped. Answering it with "no provider serves that model id" tells the
      // user nothing about the key they came here to add, and suggesting `auto`
      // tells them to give up the provider they were trying to configure.
      //
      // A summary call is the one exception: DSH builds it from whatever route is
      // active, so when the user is mid-configuration the summary inherits a
      // guidance row it can never run on. Refusing it produces a compaction failure
      // with nothing to do with context size — two of those are in the 2026-10-15
      // log — so a summary routes across the pool instead of answering the row.
      const setupFailure = model.startsWith(SETUP_MODEL_PREFIX) && !isCompaction
        ? setupRequiredFailure(this.#provider, config, model)
        : undefined
      if (setupFailure !== undefined) {
        yield terminalFailure(setupFailure)
        this.#reportDirectRoute({
          tier,
          score: decision.score,
          requestedModel: model,
          candidateCount: 0,
          reasons: [setupFailure.message],
        }, config, options)
        return
      }
      // ★ A concrete model id is a *pin*, not a hint. `auto` and `auto:<tier>` ask
      // the plugin to choose; anything else asks for one specific model, and
      // answering with a different one is worse than failing — the user cannot
      // tell. Pinned requests therefore never fall back to another candidate.
      const pin = model === AUTO_MODEL || forcedTier !== undefined ? undefined : model
      // ★ A context-summarisation call is not a normal step, and routing it like one
      // is what made compaction fail forever. DSH asks a model to summarise the span
      // it is about to drop, so this call carries the whole history being compressed
      // (measured 2026-10-15: ~297,538 tokens against a 262,144-token model, then
      // `CONTEXT_WINDOW_EXCEEDED`, then the same compaction again). Two things follow:
      //
      //   1. The *pinned* route is a bad witness for it. A `setup:` row is a
      //      guidance row, not a model; answering the summary call with
      //      SETUP_REQUIRED ("select auto") produces a compaction failure that has
      //      nothing to do with context size — two such failures are in the log.
      //      A summary call therefore routes across the pool like `auto` does, and
      //      is never pinned.
      //   2. It needs an absolute capacity floor: a model that cannot hold a large
      //      context at all cannot write this summary, whatever the estimate says.
      const pinUnpinned = isCompaction ? undefined : pin
      let entries = pool
      if (pinUnpinned !== undefined) {
        const resolved = this.#pinnedEntries(pool, pinUnpinned)
        if (resolved.failure !== undefined) {
          yield terminalFailure(resolved.failure)
          this.#reportDirectRoute({
            tier,
            score: decision.score,
            requestedModel: model,
            candidateCount: 0,
            reasons: [resolved.failure.message],
          }, config, options)
          return
        }
        entries = resolved.entries
      }

      const keys = await this.#resolveProviderKeys(config, entries)
      const candidates = this.#directCandidates(entries, keys)

      if (pinUnpinned !== undefined && candidates.length === 0) {
        yield terminalFailure(this.#pinnedUnavailableFailure(pinUnpinned, entries, keys))
        this.#reportDirectRoute({
          tier,
          score: decision.score,
          requestedModel: model,
          candidateCount: 0,
          reasons: [`model "${pinUnpinned}" is pinned but no provider serving it is usable`],
        }, config, options)
        return
      }

      const declaredCapacity = declaredCapacityFor(config)
      const rankingInput = {
        tier,
        tokens: decision.tokens,
        safetyFactor: config.routing.contextSafetyFactor,
        // ★ Two floors, whichever binds harder. A model below the capacity we
        // declared to DSH cannot be served under `auto`: DSH budgets from that
        // declaration, so routing to something smaller is how a session gets
        // steered to the edge and then has to fail over at it. A summary call adds
        // its own, larger floor on top (see `compactionMinContextWindow`).
        minContextWindow: Math.max(
          // A pin is an explicit choice: the capacity contract exists to constrain
          // `auto`'s own choices, and must not override the user's. The relative
          // `tokens * safetyFactor` gate still applies to it.
          pinUnpinned === undefined ? declaredCapacity : 0,
          isCompaction ? config.routing.compactionMinContextWindow : 0,
        ),
        minContextWindowReason: isCompaction
          ? 'it carries a context to be summarised'
          : 'this is the capacity `auto` declares to DSH, so nothing smaller may answer it',
        needsVision,
        needsTools,
        now,
        candidates,
        weights: config.routing.weights,
        preferredOrder: config.routing.preferredOrder,
      }
      const ranked = rankCandidates(rankingInput)
      const exclusions = explainExclusions(rankingInput).map(
        (entry) => `${entry.provider}/${entry.model}: ${entry.reason}`,
      )

      if (pinUnpinned !== undefined && ranked.length === 0) {
        // Every candidate for this exact model was gated out (cooling, vision,
        // tools, context). Still no substitution.
        yield terminalFailure({
          code: 'MODEL_UNAVAILABLE',
          message: `${PACKAGE}: model "${pinUnpinned}" is in the pool but cannot serve this request right now`
            + `${exclusions.length === 0 ? '' : ` — ${exclusions.join('; ')}`}. `
            + 'Select "auto" to let the plugin pick another model, or retry after the cooldown.',
        })
        this.#reportDirectRoute({
          tier,
          score: decision.score,
          requestedModel: model,
          candidateCount: 0,
          reasons: exclusions,
        }, config, options)
        return
      }

      const byKey = new Map(candidates.map((candidate) => [`${candidate.provider}/${candidate.model}`, candidate]))
      const targets = ranked.map((entry) => {
        const candidate = byKey.get(`${entry.provider}/${entry.model}`)
        return {
          provider: entry.provider,
          model: entry.model,
          caps: candidate?.caps ?? {},
          apiKey: candidate?.apiKey,
          baseURL: candidate?.baseURL ?? '',
          extraBody: candidate?.extraBody,
          extraHeaders: candidate?.extraHeaders,
          reasons: entry.reasons,
        }
      })

      // The pool's ceiling, so a "nothing is big enough" diagnosis can tell the
      // user how big their request is against how big anything they can reach is.
      let poolMaxContextWindow = 0
      let poolMaxContextModel
      for (const entry of candidates) {
        const window = Number(entry.caps?.contextWindow)
        if (!Number.isFinite(window) || window <= poolMaxContextWindow) continue
        poolMaxContextWindow = window
        poolMaxContextModel = `${entry.provider}/${entry.model}`
      }

      const plan = {
        tier,
        score: decision.score,
        tokens: decision.tokens,
        poolMaxContextWindow,
        ...poolMaxContextModel === undefined ? {} : { poolMaxContextModel },
        needsVision,
        needsTools,
        ranked: targets,
        exclusions,
        complexityReasons: [
          `tier=${tier} score=${decision.score.toFixed(3)}${forcedTier === undefined ? '' : ' (forced by the selected model id)'}`
            + `${pin === undefined ? '' : ' (pinned to a concrete model id)'}`,
          ...decision.reasons,
        ],
      }

      yield* dispatchWithFailover(options, plan, {
        config,
        signal,
        health: this.#health,
        fetchImpl: this.#fetchImpl,
        readImage: (ref) => this.#readImage(ref),
        now: () => Date.now(),
        onRoute: (record) => this.#reportDirectRoute(record, config, options),
        onSuppressedControl: (detail) => {
          if (config.logRouting !== true) return
          this.#logger()?.info?.(
            `${PACKAGE}: not forwarding ${detail.control}=${detail.value} — ${detail.reason}`,
          )
        },
      })
    } catch (error) {
      const failure = failureOf(error)
      yield terminalFailure(failure, failure.code === 'ABORTED' ? 'aborted' : 'error')
    }
  }

  /**
   * Resolve one credential per **provider** (never per model) for the given pool
   * entries. Resolution happens on every call, so a key added in the settings page
   * takes effect on the next request (and on the next `listModels`).
   *
   * @param {ReturnType<typeof normalizeConfig>} config
   * @param {ReturnType<typeof listProviderModels>} entries
   * @returns {Promise<Map<string, {key: string | undefined, usable: boolean, entry: Record<string, any>}>>}
   */
  async #resolveProviderKeys(config, entries) {
    const credentials = this.#service('credentials')
    /** @type {Map<string, {key: string | undefined, usable: boolean, entry: Record<string, any>}>} */
    const resolved = new Map()
    for (const entry of entries) {
      if (resolved.has(entry.provider)) continue
      let key
      try {
        key = await resolveProviderKey(
          { id: entry.provider, apiKeyEnv: entry.apiKeyEnv, keyless: entry.keyless },
          { credentials, env: process.env, settings: config },
        )
      } catch {
        key = undefined
      }
      resolved.set(entry.provider, {
        key,
        usable: isProviderUsable({ keyless: entry.keyless }, key),
        entry,
      })
    }
    return resolved
  }

  /**
   * Enumerate the usable pool: silently drop every provider the user has not
   * configured. A missing key is a configuration state, not an error — keyless
   * providers keep the plugin working with nothing configured at all.
   *
   * @param {ReturnType<typeof listProviderModels>} entries
   * @param {Map<string, {key: string | undefined, usable: boolean}>} keys
   * @returns {Record<string, any>[]}
   */
  #directCandidates(entries, keys) {
    const out = []
    for (const entry of entries) {
      const resolved = keys.get(entry.provider)
      if (resolved === undefined || resolved.usable !== true) continue
      out.push({
        provider: entry.provider,
        model: entry.model,
        caps: entry.caps,
        apiKey: resolved.key,
        baseURL: entry.baseURL,
        extraBody: entry.extraBody,
        extraHeaders: entry.extraHeaders,
        health: this.#health.snapshot(entry.provider, entry.model),
      })
    }
    return out
  }

  /**
   * Resolve a pinned model id against the pool.
   *
   * Two spellings are accepted, both of which mean "exactly this model":
   * `provider/model` (the composite id the picker advertises) and the bare model
   * id on its own (which is what `GET /v1/models` and most documentation use).
   * A bare id may match several providers that serve the same model — that is
   * still the same model, so failing over between them is honest.
   *
   * @param {ReturnType<typeof listProviderModels>} pool
   * @param {string} pin
   * @returns {{entries: Record<string, any>[]} | {failure: {message: string, code: string}}}
   */
  #pinnedEntries(pool, pin) {
    const pair = splitPoolModelId(pin)
    let matches = []
    if (pair !== undefined) {
      matches = pool.filter((entry) => entry.provider === pair.provider && entry.model === pair.model)
    }
    if (matches.length === 0) matches = pool.filter((entry) => entry.model === pin)
    if (matches.length > 0) return { entries: matches }
    return { failure: unknownModelFailure(pin, pool) }
  }

  /**
   * The diagnosis for a pinned model that exists in the pool but cannot be served:
   * no credential, or every provider serving it is gated out.
   *
   * @param {string} pin
   * @param {ReturnType<typeof listProviderModels>} entries
   * @param {Map<string, {key: string | undefined, usable: boolean, entry: Record<string, any>}>} keys
   * @returns {{message: string, code: string}}
   */
  #pinnedUnavailableFailure(pin, entries, keys) {
    const seen = new Set()
    const blocked = []
    for (const entry of entries) {
      if (seen.has(entry.provider)) continue
      seen.add(entry.provider)
      const resolved = keys.get(entry.provider)
      if (resolved === undefined || resolved.usable === false) {
        const host = keyHostOf(entry.keyURL)
        blocked.push(`"${entry.displayName}" needs ${entry.apiKeyEnv}`
          + `${host === null ? '' : ` (free key: ${host})`}`)
      }
    }
    if (blocked.length > 0) {
      return {
        code: 'MISSING_CREDENTIAL',
        message: `${PACKAGE}: you selected "${pin}", but ${blocked.join('; ')}. `
          + 'Set that environment variable (or paste the key in the DSH settings page) and reload — '
          + 'or select "auto" to let the plugin use the providers that need no key at all.',
      }
    }
    return {
      code: 'MISSING_CREDENTIAL',
      message: `${PACKAGE}: no usable provider serves "${pin}" in the current pool. `
        + 'Select "auto" to let the plugin choose a model, or check `config.providers` for this provider.',
    }
  }

  /**
   * Record the direct-mode routing decision in the ring buffer and the log.
   * @param {Record<string, any>} record
   * @param {ReturnType<typeof normalizeConfig>} config
   * @param {Record<string, any>} options
   */
  #reportDirectRoute(record, config, options) {
    try {
      reportRoute({ logger: this.#logger(), enabled: config.logRouting }, {
        at: Date.now(),
        mode: 'direct',
        routedVia: record.provider === undefined ? 'unknown' : `${record.provider}/${record.model}`,
        requestedModel: String(options?.model ?? ''),
        requestedProvider: String(options?.provider ?? this.#provider),
        ...record.tier === undefined ? {} : { tier: record.tier },
        ...record.score === undefined ? {} : { score: record.score },
        ...record.provider === undefined ? {} : { provider: record.provider },
        ...record.model === undefined ? {} : { model: record.model },
        ...record.capability === undefined ? {} : { capability: record.capability },
        ...record.speed === undefined ? {} : { speed: record.speed },
        ...record.candidateCount === undefined ? {} : { candidateCount: record.candidateCount },
        ...record.attempts === undefined ? {} : { attempts: record.attempts },
        ...record.reasons === undefined ? {} : { reasons: record.reasons },
      })
    } catch {
      // Observability must never be able to fail a request.
    }
  }

  /**
   * Gateway mode: forward the request to an external FreeLLMAPI gateway.
   * @param {Record<string, any>} options
   * @param {ReturnType<typeof normalizeConfig>} config
   * @returns {AsyncGenerator<any>}
   */
  async *#streamGateway(options, config) {
    const translator = new ChunkTranslator()
    const model = String(options?.model ?? '')
    const signal = options?.signal
    const abortFailure = () => ({
      message: `${PACKAGE}: the caller aborted the request`,
      code: 'ABORTED',
    })
    if (signal?.aborted === true) {
      yield* translator.finish({ kind: 'aborted', failure: abortFailure() })
      return
    }

    let timing = { signal, timedOut: () => false, dispose: () => {} }
    try {
      assertSupportedOptions(options)

      const baseURL = this.#resolveBaseURL(config)
      let apiKey
      try {
        apiKey = await this.#resolveApiKey(config)
      } catch (error) {
        yield* translator.finish({ kind: 'error', failure: failureOf(error) })
        return
      }
      if (apiKey === undefined) {
        yield* translator.finish({
          kind: 'error',
          failure: {
            message: `${PACKAGE}: no credential for the FreeLLMAPI gateway. Set the reference named by \`apiKeyEnv\` `
              + `(currently "${config.apiKeyEnv}") to the gateway's unified \`freellmapi-…\` key — through the Models page `
              + `(the credentials service), $DSH_HOME/.env, or the launching environment. An empty value counts as unset.`,
            code: 'MISSING_CREDENTIAL',
          },
        })
        return
      }

      const imageParts = messagesHaveImage(options?.messages)
        ? await collectImageParts(options, (ref) => this.#readImage(ref))
        : new Map()
      const body = buildChatRequest(options, config, { imageParts })
      const headers = {
        // Mandatory harness attribution: first expansion, and `headers` below can
        // never override it (config rejects a user-agent override).
        ...attributionHeaders(),
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: `Bearer ${apiKey}`,
        ...config.taskType.length === 0 ? {} : { 'x-freellm-task-type': config.taskType },
        ...config.cacheMode.length === 0 ? {} : { 'x-free-llm-cache': config.cacheMode },
        ...config.headers,
      }

      timing = this.#requestSignal(signal, config.timeoutMs)
      let response
      try {
        response = await this.#fetchImpl(`${baseURL}/chat/completions`, {
          method: 'POST',
          redirect: 'error',
          signal: timing.signal,
          headers,
          body: JSON.stringify(body),
        })
      } catch (error) {
        if (signal?.aborted === true) {
          yield* translator.finish({ kind: 'aborted', failure: abortFailure() })
          return
        }
        yield* translator.finish({
          kind: 'error',
          failure: describeTransportFailure(error, { baseURL, model, timedOut: timing.timedOut() }),
        })
        return
      }

      this.#reportRoute(response, config, options)

      if (!response.ok) {
        yield* translator.finish({ kind: 'error', failure: await httpFailure(response, { model, baseURL }) })
        return
      }
      if (response.body === null || response.body === undefined) {
        yield* translator.finish({
          kind: 'error',
          failure: {
            message: `${PACKAGE}: the gateway returned ${response.status} with an empty body; a streaming response was expected [model=${model}]`,
            code: 'EMPTY_RESPONSE',
            status: response.status,
          },
        })
        return
      }

      for await (const event of decodeSseBody(response.body)) {
        if (signal?.aborted === true) {
          yield* translator.finish({ kind: 'aborted', failure: abortFailure() })
          return
        }
        for (const chunk of translator.push(classifyFrame(event.data))) yield chunk
      }

      for (const chunk of translator.finish()) yield chunk
    } catch (error) {
      if (signal?.aborted === true) {
        yield* translator.finish({ kind: 'aborted', failure: abortFailure() })
        return
      }
      const failure = timing.timedOut()
        ? { message: `${PACKAGE}: the request exceeded the configured timeout of ${config.timeoutMs}ms [model=${model}]`, code: 'TIMEOUT' }
        : failureOf(error)
      yield* translator.finish({ kind: failure.code === 'ABORTED' ? 'aborted' : 'error', failure })
    } finally {
      timing.dispose()
    }
  }
}

/**
 * The capacity `auto` declares to DSH: `min(pool, config)`, floored.
 *
 * Why the floor: DSH's compaction threshold is `min(W × 0.8, W − 65,536)`. Just
 * above 65,536 that second term collapses toward 1, so a declaration of, say,
 * 70,000 would make DSH compact on essentially every step — a worse failure than
 * the one being fixed. Keeping `W` at or above 131,072 keeps the threshold at
 * 65,536, which is the value DSH was already using.
 *
 * Why `min` at all: a declaration wider than the models routing may pick is a
 * promise the router breaks. `config.contextWindow` is therefore an **upper
 * bound** — the operator says "budget no more than this" — and the pool says
 * "and no more than I can serve". The models below the result are excluded from
 * `auto`, with a reason naming this contract, rather than silently served.
 *
 * Note the approximation: the pool here is the *enabled* set, not the
 * credential-resolved one, because this runs inside synchronous model metadata.
 * A provider that is enabled but lacks a key cannot serve anything, so the
 * declared value can be conservative — which is the safe direction.
 *
 * @param {ReturnType<typeof normalizeConfig>} config
 * @returns {number}
 */
function declaredCapacityFor(config) {
  const ceiling = Number.isFinite(config.contextWindow) && config.contextWindow > 0
    ? config.contextWindow
    : COMPACTION_CAPACITY_FLOOR
  let smallest = Number.POSITIVE_INFINITY
  let largest = 0
  try {
    for (const entry of listProviderModels(config)) {
      const window = Number(entry?.caps?.contextWindow)
      if (!Number.isFinite(window) || window <= 0) continue
      if (window < smallest) smallest = window
      if (window > largest) largest = window
    }
  } catch {
    // A malformed pool must not break model metadata; fall back to the ceiling.
    return ceiling
  }
  if (!Number.isFinite(smallest)) return ceiling
  // A pool that cannot reach the floor has no model the floor would exclude, so
  // imposing it would empty `auto` and help nobody. In that case declare what the
  // pool can serve: such a pool is already below DSH's 65,536-token headroom, so
  // proactive compaction is disabled for it either way and the declaration at least
  // stops overstating it.
  if (largest < COMPACTION_CAPACITY_FLOOR) return Math.min(smallest, ceiling)
  return Math.max(COMPACTION_CAPACITY_FLOOR, Math.min(smallest, ceiling))
}

/**
 * Build the in-band failure for a thrown value without leaking a stack trace.
 * @param {unknown} error
 * @returns {{message: string, code: string, status?: number}}
 */
function failureOf(error) {
  if (error !== null && typeof error === 'object') {
    const record = /** @type {Record<string, unknown>} */ (error)
    const code = typeof record.code === 'string' && record.code.length > 0 ? record.code : undefined
    if (record.failure !== undefined && typeof record.failure === 'object' && record.failure !== null) {
      const failure = /** @type {Record<string, unknown>} */ (record.failure)
      if (typeof failure.message === 'string' && failure.message.length > 0 && failure.code !== undefined) {
        return /** @type {{message: string, code: string}} */ (failure)
      }
    }
    // `error.message` is only a string by convention. When it is not, say what the
    // value actually was instead of `[object Object]`.
    const message = describeUnknown(
      error instanceof Error ? error.message : record.message,
      `${error instanceof Error ? error.constructor?.name ?? 'Error' : 'failure'} with no message`,
    )
    return { message: `${PACKAGE}: ${message}`, code: code ?? 'UNKNOWN' }
  }
  return { message: `${PACKAGE}: ${describeUnknown(error, 'unknown failure')}`, code: 'UNKNOWN' }
}

/**
 * Read and classify an error response body.
 * @param {Response} response
 * @param {{model: string, baseURL: string}} input
 * @returns {Promise<{message: string, code: string, status: number, providerRetryAfterMs?: number}>}
 */
async function httpFailure(response, input) {
  let bodyText = ''
  try {
    bodyText = await response.text()
  } catch {
    bodyText = ''
  }
  let payload
  try {
    payload = JSON.parse(bodyText)
  } catch {
    payload = undefined
  }
  const failure = describeHttpFailure({
    status: response.status,
    payload,
    bodyText,
    model: input.model,
    baseURL: input.baseURL,
    sentApiKey: true,
    headers: response.headers,
  })
  const retryAfter = retryAfterMs(response.headers)
  return retryAfter === undefined ? failure : { ...failure, providerRetryAfterMs: retryAfter }
}

/**
 * Mount the plugin: one provider route, its directory entry, and model discovery.
 *
 * Registration itself stays minimal and constant — the route set never changes,
 * so there is nothing to reconcile beyond re-reading the (volatile) config on
 * the next request. The `loader/volatile-update` handler exists anyway, because
 * a settings edit is *supposed* to be observable, and it must not be able to
 * throw into the loader.
 *
 * @param {any} ctx the cordis context, with the `llm` service injected
 * @param {unknown} config the resolved plugin configuration (volatile fields are `{get()}` refs)
 * @returns {void}
 */
export function apply(ctx, config) {
  const llm = ctx?.llm
  if (llm === undefined || typeof llm.registerAdapter !== 'function') {
    ctx?.logger?.error?.(`${PACKAGE}: the llm service is unavailable; the plugin is inert`)
    return
  }

  const readConfig = () => normalizeConfig(config)
  const settingsNs = ctx?.fiber?.entry?.options?.id ?? NS
  const adapter = new FreellmapiAdapter({ ctx, provider: PROVIDER_ID, readConfig })

  /** @type {{provider: string, displayName: string, settingsNs: string, settingsPath: string[], declared: boolean}[]} */
  const entries = [{
    provider: PROVIDER_ID,
    displayName: PROVIDER_NAME,
    settingsNs,
    /*
     * The empty path is load-bearing, not a placeholder.
     *
     * This plugin owns exactly ONE provider route, so that route's configuration
     * IS this plugin's whole settings namespace — there is no sub-object to point
     * at. An earlier revision declared `['providers', PROVIDER_ID]`, which was
     * wrong twice over:
     *
     * 1. `config.providers` is keyed by UPSTREAM provider (`groq`, `cerebras`,
     *    `kilo`, ...), never by the route this plugin registers. There is no
     *    `providers.freellmapi` key, so `schema.getPath(namespace.value, path)`
     *    was always undefined.
     * 2. That made `dsh-client-ui-settings-models` compute `configured: false`,
     *    which hides the row from the card list and offers it only through "add
     *    model provider" — where saving would have written a junk
     *    `providers.freellmapi` entry into the upstream override map.
     *
     * With an empty path the row counts as `configured` as soon as its namespace
     * exists (the Models page treats an empty path as "the namespace itself"), so
     * the provider is listed as an ordinary card. `removable` stays false, which
     * is correct: it requires a non-empty path, and a route the plugin owns is
     * not the user's to delete.
     *
     * Note for anyone tempted to tune this into a key form: the Models page
     * renders a provider's editable fields from `layoutOf(ns)`, hard-coded to
     * `llm-deepseek` and `llm-pi-ai` and `"unknown"` for everything else. An
     * unknown layout shows "edit it in cordis.patch.yml" and disables Save, so no
     * `settingsPath` on this plugin can produce a key form there. This plugin's
     * editable surface is its own settings page (Settings -> Plugins ->
     * dsh-freellmapi), which is generated from the schema and exists precisely
     * because `Config` is a real schemastery schema.
     */
    settingsPath: [],
    declared: true,
  }]

  let directory
  let registration
  const ensureRegistrations = () => {
    if (directory === undefined) directory = llm.registerConfigurableProviders(entries)
    else directory.replace(entries)
    if (registration === undefined) registration = llm.registerAdapter([PROVIDER_ID], adapter)
    else registration.replace([PROVIDER_ID])
  }

  try {
    ensureRegistrations()
  } catch (error) {
    const code = typeof /** @type {any} */ (error)?.code === 'string' && /** @type {any} */ (error).code.length > 0
      ? /** @type {any} */ (error).code
      : 'INVALID_ADAPTER'
    const conflict = code === 'DUPLICATE_ADAPTER'
      ? ` — provider route "${PROVIDER_ID}" is already owned by another adapter. The FreeLLMAPI documentation's `
        + '`npx freellmapi setup-dsh` writes an `llm-pi-ai.providers.freellmapi` route; remove that route (or this plugin) '
        + 'so exactly one adapter owns the name.'
      : ''
    throw new LlmError(`${PACKAGE}: cannot register provider route "${PROVIDER_ID}"${conflict}`, code, { cause: error })
  }

  // Model discovery is optional: losing it must not remove the provider route.
  try {
    llm.registerModelDiscovery(settingsNs, (request, signal) => adapter.discover(request, signal))
  } catch (error) {
    ctx?.logger?.warn?.(`${PACKAGE}: model discovery is unavailable (${String(error?.message ?? error)})`)
  }

  // A settings edit must be observable, but a missing event surface (an embedded
  // or test context) is not a reason to fail mounting.
  ctx.on?.('loader/volatile-update', () => {
    try {
      ensureRegistrations()
    } catch (error) {
      ctx?.logger?.error?.(`${PACKAGE}: configuration conflicts with an existing provider route`)
      ctx?.logger?.error?.(error)
    }
  })
}
