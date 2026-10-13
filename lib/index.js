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
import { buildCatalog, builtinRoutes, ModelDiscovery } from './catalog.js'
import { ChunkTranslator } from './translate.js'
import { classifyFrame } from './frames.js'
import { decodeSseBody } from './sse.js'
import { describeHttpFailure, describeTransportFailure, retryAfterMs } from './errors.js'
import { assertSupportedOptions, buildChatRequest, collectImageParts, contentHasImage } from './wire.js'
import { formatRouteLine, getRecentRoutes, readRoutingHeaders, recordRoute } from './routes.js'

/** Package name used in diagnostics. */
const PACKAGE = 'dsh-freellmapi'

/** Largest attachment the adapter will inline as a `data:` URL. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** Display names for the virtual routes, resolved once. */
const BUILTIN_NAMES = new Map(builtinRoutes({ includeFusion: true }).map((route) => [route.id, route.name]))

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

export { configSchemaKind, getRecentRoutes, formatRouteLine }

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

  /**
   * @param {object} options
   * @param {any} options.ctx the cordis context, used only for optional services
   * @param {string} options.provider the route id this adapter serves
   * @param {() => ReturnType<typeof normalizeConfig>} options.readConfig
   * @param {typeof fetch} [options.fetchImpl] injection point for tests
   */
  constructor(options) {
    super()
    this.#ctx = options.ctx
    this.#provider = options.provider
    this.#readConfig = options.readConfig
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.#discovery = new ModelDiscovery({
      cacheMs: options.readConfig().discoveryCacheMs,
      timeoutMs: options.readConfig().discoveryTimeoutMs,
      fetchImpl: this.#fetchImpl,
    })
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
   * The model picker's catalog: virtual routes first (bare `auto` at the top),
   * then whatever `GET /v1/models` reports.
   *
   * Never throws: discovery failure leaves the static routes selectable.
   * @param {string} provider
   * @returns {Promise<ReturnType<typeof buildCatalog>>}
   */
  async listModels(provider) {
    const config = this.#readConfig()
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
   * profiles with a hard 400, which the stream translates into advice.
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
   * @param {ReturnType<typeof normalizeConfig>} config
   * @param {string} provider
   * @param {string} model
   * @returns {Record<string, unknown>}
   */
  #modelInfo(config, provider, model) {
    const discovered = this.#discovery.find(model)
    const contextWindow = discovered?.contextWindow ?? config.contextWindow
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
   * The generator every dispatch path funnels through.
   * @param {Record<string, any>} options
   * @param {ReturnType<typeof normalizeConfig>} config
   * @returns {AsyncGenerator<any>}
   */
  async *#streamWithSnapshot(options, config) {
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
      if (typeof failure.message === 'string' && failure.code !== undefined) {
        return /** @type {{message: string, code: string}} */ (failure)
      }
    }
    const message = error instanceof Error ? error.message : String(record.message ?? 'unknown failure')
    return { message: `${PACKAGE}: ${message}`, code: code ?? 'UNKNOWN' }
  }
  return { message: `${PACKAGE}: ${String(error)}`, code: 'UNKNOWN' }
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
    settingsPath: ['providers', PROVIDER_ID],
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
