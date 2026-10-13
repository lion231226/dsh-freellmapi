/**
 * The FreeLLMAPI model catalog: the static virtual routes plus live discovery.
 *
 * `model` is passed to the gateway verbatim, and the gateway resolves it in this
 * order (`research/freellmapi-protocol.md` §4.1):
 * concrete catalog id → bare `auto` → global strategy alias (`auto:smart`, …) →
 * named profile (`auto:<profile-name>`, unknown names are a hard `400`).
 *
 * Consequently the advertised catalog is *open*: it lists the guaranteed virtual
 * routes first so the GUI always has something selectable, then everything
 * `GET /v1/models` reports. Nothing here acts as a whitelist — `resolveModel()`
 * answers for any id, listed or not.
 *
 * @module dsh-freellmapi/catalog
 */

import { attributionHeaders } from './runtime.js'

/**
 * A model entry as advertised by `listModels()`.
 * @typedef {object} CatalogModel
 * @property {string} provider
 * @property {string} id
 * @property {string} name
 * @property {string} [description]
 * @property {readonly ('text' | 'image')[]} [inputModalities]
 */

/**
 * A model entry as discovered from the gateway, with the extra metadata the
 * runtime's catalog validator drops but `resolveModel()` can still use.
 * @typedef {object} DiscoveredModel
 * @property {string} id
 * @property {string} [name]
 * @property {number} [contextWindow]
 * @property {number} [maxTokens]
 */

/**
 * The virtual routes every FreeLLMAPI gateway answers, in the order the model
 * picker should show them: bare `auto` first, then the five documented global
 * strategies.
 */
export const BUILTIN_ROUTES = Object.freeze([
  Object.freeze({ id: 'auto', name: 'Auto (router picks the best available model)', description: 'Uses the gateway\'s currently active fallback chain as-is.' }),
  Object.freeze({ id: 'auto:smart', name: 'Auto · Smartest', description: 'Intelligence-first ordering (reliability 0.35 / speed 0.10 / intelligence 0.55).' }),
  Object.freeze({ id: 'auto:fast', name: 'Auto · Fastest', description: 'Throughput and time-to-first-byte first (0.35 / 0.55 / 0.10).' }),
  Object.freeze({ id: 'auto:cheap', name: 'Auto · Cheapest', description: 'Budget-leaning; upstream documents the same recipe as balanced.' }),
  Object.freeze({ id: 'auto:reliable', name: 'Auto · Most reliable', description: 'Recent success rate first (0.70 / 0.15 / 0.15).' }),
  Object.freeze({ id: 'auto:balanced', name: 'Auto · Balanced', description: 'Default mix: reliability first, speed and intelligence split the rest.' }),
])

/** The `fusion` fan-out route (panel answers, judge synthesises). */
export const FUSION_ROUTE = Object.freeze({
  id: 'fusion',
  name: 'Fusion (panel + judge)',
  description: 'Fans the prompt out to a panel of models and has a judge model synthesise the answer.',
})

/** The id that means "let the gateway route". */
export const AUTO_MODEL = 'auto'

/**
 * The static part of the catalog.
 * @param {{includeFusion?: boolean}} [options]
 * @returns {{id: string, name: string, description?: string}[]}
 */
export function builtinRoutes(options = {}) {
  const routes = [...BUILTIN_ROUTES]
  if (options.includeFusion !== false) routes.push({ ...FUSION_ROUTE })
  return routes
}

/**
 * Merge the static virtual routes with discovered models, keeping the static
 * order first and dropping duplicate ids (the runtime rejects a catalog with a
 * repeated id as `INVALID_CATALOG`).
 *
 * @param {{provider: string, includeFusion?: boolean, vision?: boolean}} options
 * @param {readonly DiscoveredModel[]} [discovered]
 * @returns {CatalogModel[]}
 */
export function buildCatalog(options, discovered = []) {
  const modalities = options.vision === false ? ['text'] : ['text', 'image']
  const seen = new Set()
  const out = []
  for (const route of builtinRoutes(options)) {
    if (seen.has(route.id)) continue
    seen.add(route.id)
    out.push({
      provider: options.provider,
      id: route.id,
      name: route.name,
      description: route.description,
      inputModalities: modalities,
    })
  }
  for (const model of discovered) {
    if (typeof model?.id !== 'string' || model.id.length === 0 || seen.has(model.id)) continue
    seen.add(model.id)
    out.push({
      provider: options.provider,
      id: model.id,
      name: typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id,
      inputModalities: modalities,
    })
  }
  return out
}

/**
 * Parse a `GET /v1/models` payload.
 *
 * The gateway answers with the OpenAI `{object:'list', data:[…]}` shape and adds
 * `context_window` / `context_length` / `max_tokens` to the virtual routes.
 *
 * @param {unknown} payload
 * @returns {DiscoveredModel[]} entries with a non-empty id, in endpoint order
 */
export function parseModelsPayload(payload) {
  if (typeof payload !== 'object' || payload === null) return []
  const data = /** @type {Record<string, unknown>} */ (payload).data
  if (!Array.isArray(data)) return []
  const out = []
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = /** @type {Record<string, unknown>} */ (entry)
    const id = record.id
    if (typeof id !== 'string' || id.length === 0) continue
    const name = typeof record.name === 'string' && record.name.length > 0 ? record.name : undefined
    const contextWindow = positiveInteger(record.context_window)
      ?? positiveInteger(record.context_length)
      ?? positiveInteger(record.contextWindow)
    const maxTokens = positiveInteger(record.max_tokens) ?? positiveInteger(record.maxTokens)
    out.push({
      id,
      ...name === undefined ? {} : { name },
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
    })
  }
  return out
}

/** @param {unknown} value @returns {number | undefined} */
function positiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * Time-bounded, key-scoped cache over `GET /v1/models`.
 *
 * Failures are never thrown to the caller: a gateway that is down, slow or
 * unauthenticated must leave the model picker usable with the static routes
 * instead of failing it.
 */
export class ModelDiscovery {
  #models = []
  #fetchedAt = 0
  #key = ''
  #error = ''
  #inflight = null

  /**
   * @param {object} options
   * @param {number} options.cacheMs how long a successful result stays fresh
   * @param {number} options.timeoutMs per-request timeout
   * @param {typeof fetch} [options.fetchImpl] injection point for tests
   * @param {() => number} [options.now]
   */
  constructor(options) {
    this.cacheMs = Number.isFinite(options.cacheMs) && options.cacheMs >= 0 ? options.cacheMs : 60_000
    this.timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 5_000
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.now = options.now ?? (() => Date.now())
  }

  /** The models from the last successful fetch (possibly empty). */
  get models() {
    return this.#models
  }

  /** The last discovery error, or `''`. */
  get error() {
    return this.#error
  }

  /** Whether a fetch has completed at least once. */
  get primed() {
    return this.#fetchedAt > 0
  }

  /** Cached metadata for one model id, when discovery saw it. */
  find(id) {
    return this.#models.find((model) => model.id === id)
  }

  /**
   * Resolve the catalog, reusing a fresh cache entry.
   * @param {{baseURL: string, apiKey?: string, signal?: AbortSignal, force?: boolean}} request
   * @returns {Promise<DiscoveredModel[]>}
   */
  async list(request) {
    const key = `${request.baseURL}\u0000${request.apiKey === undefined ? '' : 'key'}`
    const fresh = this.#key === key && this.now() - this.#fetchedAt < this.cacheMs
    if (!request.force && fresh && this.#error === '') return this.#models
    if (this.#inflight !== null && !request.force) return this.#inflight
    const pending = this.#fetchNow(request, key).finally(() => {
      this.#inflight = null
    })
    this.#inflight = pending
    return pending
  }

  /**
   * @param {{baseURL: string, apiKey?: string, signal?: AbortSignal}} request
   * @param {string} key
   * @returns {Promise<DiscoveredModel[]>}
   */
  async #fetchNow(request, key) {
    const base = String(request.baseURL).replace(/\/+$/, '')
    const url = `${base}/models`
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const signal = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout])
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        signal,
        headers: {
          ...attributionHeaders(),
          accept: 'application/json',
          ...request.apiKey === undefined || request.apiKey.length === 0
            ? {}
            : { authorization: `Bearer ${request.apiKey}` },
        },
      })
      if (!response.ok) {
        this.#key = key
        this.#fetchedAt = this.now()
        this.#error = `HTTP ${response.status}`
        this.#models = []
        return this.#models
      }
      const payload = await response.json()
      this.#models = parseModelsPayload(payload)
      this.#key = key
      this.#fetchedAt = this.now()
      this.#error = ''
      return this.#models
    } catch (error) {
      // Keep whatever was cached: a transient gateway restart must not empty the
      // model picker for the rest of the session.
      this.#key = key
      this.#fetchedAt = this.now()
      this.#error = error instanceof Error ? error.message : String(error)
      return this.#models
    }
  }
}
