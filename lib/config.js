/**
 * Plugin configuration.
 *
 * ## Shape of the exported `Config`
 *
 * Cordis resolves a plugin's config through `runtime.Config['~standard'].validate(config)`
 * (`cordis/lib/index.js:956-962`) — a *Standard Schema* object, not necessarily a
 * schemastery instance. The settings service additionally requires the schema to
 * expose `toJSON()` before it will build a form for the entry
 * (`dsh-settings/lib/index.js:538-541`): without it the entry is simply skipped,
 * which is a supported, silent degradation.
 *
 * So this module exports, in order of preference:
 *
 * 1. a real **schemastery** schema, built from a *dynamic* import of
 *    `@deepseek-ai/schemastery` when the host resolves it (it is materialised in
 *    DSH profiles), which gives the plugin a working auto-generated settings page
 *    and per-field defaults/descriptions;
 * 2. otherwise a **plain Standard Schema object** — still valid for Cordis (the
 *    plugin loads and runs), just without a generated form.
 *
 * `@deepseek-ai/schemastery` is deliberately **not** declared as a dependency or
 * a peer dependency: declaring it would let the profile's package manager
 * materialise its own copy. The import is opportunistic and fully guarded — a
 * failure at any point (import, schema construction, missing API) falls back to
 * (2), and the plugin always imports.
 *
 * Every field is `.volatile()`, so a settings edit re-resolves the value in place
 * instead of rebuilding the fiber, and {@link readConfig} always sees the current
 * value. Reads go through {@link normalizeConfig}, which is total: **no
 * configuration value, however malformed, can make `apply` throw**.
 *
 * @module dsh-freellmapi/config
 */

/** Stable plugin namespace and the provider route id. */
export const NS = 'freellmapi'
/** The single provider route this plugin owns. */
export const PROVIDER_ID = 'freellmapi'
/** Display name shown in the model picker. */
export const PROVIDER_NAME = 'FreeLLMAPI (Auto)'
/** Default OpenAI-compatible root of a local FreeLLMAPI gateway. */
export const DEFAULT_BASE_URL = 'http://localhost:3001/v1'
/** Default credential reference name (never the key itself). */
export const DEFAULT_API_KEY_REF = 'FREELLMAPI_API_KEY'

/** Settings key under which the direct pool is configured. */
export const DEFAULT_MODE = 'direct'

/** Routing-engine defaults for direct mode. */
export const ROUTING_DEFAULTS = Object.freeze({
  maxAttempts: 6,
  budgetMs: 45_000,
})

/** Defaults for every field, also used by {@link normalizeConfig}. */
export const DEFAULTS = Object.freeze({
  baseURL: DEFAULT_BASE_URL,
  apiKeyEnv: DEFAULT_API_KEY_REF,
  apiKey: '',
  mode: DEFAULT_MODE,
  maxTokensField: 'max_tokens',
  logRoutedVia: true,
  logRouting: true,
  includeFusion: true,
  exposeDiscoveredModels: true,
  vision: true,
  contextWindow: 131_072,
  maxTokens: 0,
  timeoutMs: 600_000,
  discoveryTimeoutMs: 5_000,
  discoveryCacheMs: 60_000,
  headers: Object.freeze({}),
  taskType: '',
  cacheMode: '',
  providers: Object.freeze({}),
  routing: ROUTING_DEFAULTS,
})

/**
 * Read one config field, which may be a schemastery `Volatile` reference
 * (`{get()}`), a plain value, or absent. Never throws.
 * @param {unknown} raw
 * @returns {unknown}
 */
function readField(raw) {
  if (raw === null || raw === undefined) return undefined
  if (typeof raw === 'function') return undefined
  if (typeof raw === 'object') {
    const getter = /** @type {{get?: unknown}} */ (raw).get
    if (typeof getter === 'function') {
      try {
        return /** @type {{get(): unknown}} */ (raw).get()
      } catch {
        return undefined
      }
    }
  }
  return raw
}

/** @param {unknown} value @param {string} fallback */
function stringField(value, fallback) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return fallback
}

/** @param {unknown} value @param {boolean} fallback */
function booleanField(value, fallback) {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 'yes' || value === '1' || value === 1) return true
  if (value === 'false' || value === 'no' || value === '0' || value === 0) return false
  return fallback
}

/** @param {unknown} value @param {number} fallback @param {{min?: number}} [bounds] */
function numberField(value, fallback, bounds = {}) {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  if (bounds.min !== undefined && parsed < bounds.min) return fallback
  return parsed
}

/** Header names this plugin owns and never lets config override. */
const RESERVED_HEADERS = new Set(['user-agent', 'authorization', 'content-type', 'accept'])

/**
 * Keep only string-valued headers with HTTP-safe names, minus the reserved ones.
 * @param {unknown} value
 * @returns {Record<string, string>}
 */
function headersField(value) {
  const source = readField(value)
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return {}
  const out = {}
  for (const [key, entry] of Object.entries(/** @type {Record<string, unknown>} */ (source))) {
    const name = key.trim().toLowerCase()
    if (name.length === 0 || RESERVED_HEADERS.has(name)) continue
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) continue
    if (typeof entry !== 'string') continue
    out[name] = entry
  }
  return out
}

/**
 * Coerce any configuration value into a complete, valid configuration object.
 *
 * Total by construction: every field falls back to {@link DEFAULTS}, the base URL
 * always ends without a trailing slash, and an unusable base URL degrades to the
 * default rather than failing later inside `fetch`.
 *
 * @param {unknown} raw the value Cordis passed to `apply`, or a plain object
 * @returns {{
 *   baseURL: string, apiKeyEnv: string, apiKey: string,
 *   mode: 'direct' | 'gateway',
 *   maxTokensField: 'max_tokens' | 'max_completion_tokens',
 *   logRoutedVia: boolean, logRouting: boolean, includeFusion: boolean, exposeDiscoveredModels: boolean,
 *   vision: boolean, contextWindow: number, maxTokens: number,
 *   timeoutMs: number, discoveryTimeoutMs: number, discoveryCacheMs: number,
 *   headers: Record<string, string>, taskType: string, cacheMode: string,
 *   providers: Record<string, Record<string, unknown>>,
 *   routing: {maxAttempts: number, budgetMs: number, thresholds: Record<string, number>,
 *     weights: Record<string, unknown>, preferredOrder: string[]},
 * }}
 */
export function normalizeConfig(raw) {
  let source = {}
  try {
    if (typeof raw === 'object' && raw !== null) source = /** @type {Record<string, unknown>} */ (raw)
  } catch {
    source = {}
  }
  // A hostile accessor (a throwing getter on a hand-built config object) must
  // degrade to the default, not escape into `apply`.
  const read = (key) => {
    try {
      return readField(source[key])
    } catch {
      return undefined
    }
  }

  const rawBaseURL = stringField(read('baseURL'), DEFAULTS.baseURL).trim()
  const trimmedBaseURL = rawBaseURL.replace(/\/+$/, '')
  const baseURL = /^https?:\/\/[^\s]+$/i.test(trimmedBaseURL) ? trimmedBaseURL : DEFAULTS.baseURL

  const maxTokensField = stringField(read('maxTokensField'), DEFAULTS.maxTokensField) === 'max_completion_tokens'
    ? 'max_completion_tokens'
    : 'max_tokens'

  const taskType = stringField(read('taskType'), '').trim().toLowerCase()
  const cacheMode = stringField(read('cacheMode'), '').trim().toLowerCase()
  const mode = stringField(read('mode'), DEFAULTS.mode).trim().toLowerCase() === 'gateway' ? 'gateway' : 'direct'

  return {
    baseURL,
    apiKeyEnv: stringField(read('apiKeyEnv'), DEFAULTS.apiKeyEnv).trim(),
    apiKey: stringField(read('apiKey'), DEFAULTS.apiKey).trim(),
    mode,
    maxTokensField,
    logRoutedVia: booleanField(read('logRoutedVia'), DEFAULTS.logRoutedVia),
    logRouting: booleanField(read('logRouting'), DEFAULTS.logRouting),
    includeFusion: booleanField(read('includeFusion'), DEFAULTS.includeFusion),
    exposeDiscoveredModels: booleanField(read('exposeDiscoveredModels'), DEFAULTS.exposeDiscoveredModels),
    vision: booleanField(read('vision'), DEFAULTS.vision),
    contextWindow: Math.trunc(numberField(read('contextWindow'), DEFAULTS.contextWindow, { min: 1 })),
    maxTokens: Math.trunc(numberField(read('maxTokens'), DEFAULTS.maxTokens, { min: 0 })),
    timeoutMs: Math.trunc(numberField(read('timeoutMs'), DEFAULTS.timeoutMs, { min: 0 })),
    discoveryTimeoutMs: Math.trunc(numberField(read('discoveryTimeoutMs'), DEFAULTS.discoveryTimeoutMs, { min: 1 })),
    discoveryCacheMs: Math.trunc(numberField(read('discoveryCacheMs'), DEFAULTS.discoveryCacheMs, { min: 0 })),
    headers: headersField(read('headers')),
    taskType: ['auto', 'code', 'chat'].includes(taskType) ? taskType : '',
    cacheMode: ['on', 'off'].includes(cacheMode) ? cacheMode : '',
    providers: providersField(read('providers')),
    routing: routingField(read('routing')),
  }
}

/**
 * Keep only object-valued provider overrides, with their `models` list left
 * untouched for `providers.js` to normalise. A malformed entry is dropped rather
 * than repaired, because a half-understood provider is worse than an absent one.
 * @param {unknown} value
 * @returns {Record<string, Record<string, unknown>>}
 */
function providersField(value) {
  const source = readField(value)
  /** @type {Record<string, Record<string, unknown>>} */
  const out = {}
  const record = typeof source === 'object' && source !== null && !Array.isArray(source) ? source : null
  if (record !== null) {
    for (const [key, entry] of Object.entries(/** @type {Record<string, unknown>} */ (record))) {
      if (key.trim().length === 0) continue
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
      out[key.trim()] = { .../** @type {Record<string, unknown>} */ (entry) }
      delete out[key.trim()].get
    }
    return out
  }
  if (Array.isArray(source)) {
    for (const entry of source) {
      if (typeof entry !== 'object' || entry === null) continue
      const id = /** @type {Record<string, unknown>} */ (entry).id
      if (typeof id !== 'string' || id.trim().length === 0) continue
      const copy = { .../** @type {Record<string, unknown>} */ (entry) }
      delete copy.get
      out[id.trim()] = copy
    }
  }
  return out
}

/**
 * Normalise the routing engine's knobs. Every value is bounded so a hostile or
 * mistaken setting can only make routing conservative, never unbounded.
 * @param {unknown} value
 * @returns {{maxAttempts: number, budgetMs: number, thresholds: Record<string, number>,
 *   weights: Record<string, unknown>, preferredOrder: string[]}}
 */
function routingField(value) {
  const source = readField(value)
  const record = typeof source === 'object' && source !== null && !Array.isArray(source)
    ? /** @type {Record<string, unknown>} */ (source)
    : {}
  const thresholdsRaw = readField(record.thresholds)
  const thresholds = {}
  if (typeof thresholdsRaw === 'object' && thresholdsRaw !== null && !Array.isArray(thresholdsRaw)) {
    for (const key of ['medium', 'complex']) {
      const entry = readField(/** @type {Record<string, unknown>} */ (thresholdsRaw)[key])
      if (typeof entry === 'number' && Number.isFinite(entry) && entry > 0 && entry < 1) thresholds[key] = entry
    }
  }
  const weightsRaw = readField(record.weights)
  const weights = typeof weightsRaw === 'object' && weightsRaw !== null && !Array.isArray(weightsRaw)
    ? { .../** @type {Record<string, unknown>} */ (weightsRaw) }
    : {}
  const orderRaw = readField(record.preferredOrder)
  const preferredOrder = Array.isArray(orderRaw)
    ? orderRaw.filter((entry) => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim())
    : []
  return {
    maxAttempts: Math.trunc(numberField(readField(record.maxAttempts), ROUTING_DEFAULTS.maxAttempts, { min: 1 })),
    budgetMs: Math.trunc(numberField(readField(record.budgetMs), ROUTING_DEFAULTS.budgetMs, { min: 0 })),
    thresholds,
    weights,
    preferredOrder,
  }
}

/**
 * The value exported as `Config`. Either a schemastery schema (settings page
 * included) or a plain Standard Schema object (loads fine, no generated form).
 * @type {object}
 */
function buildConfigSchema() {
  return { '~standard': { version: 1, vendor: NS, validate: (value) => ({ value: normalizeConfig(value) }) } }
}

/**
 * The plain Standard Schema fallback, always available.
 * @type {object}
 */
const FALLBACK_CONFIG = Object.freeze(buildConfigSchema())

/**
 * Build the richest schema this host can support, falling back at every step.
 * @returns {object}
 */
async function chooseConfigSchema() {
  let z
  try {
    const loaded = await import('@deepseek-ai/schemastery')
    z = loaded?.default ?? loaded
    if (typeof z?.object !== 'function' || typeof z?.string !== 'function') return FALLBACK_CONFIG
  } catch {
    return FALLBACK_CONFIG
  }
  try {
    // Every field is `.volatile()` (a settings edit re-resolves in place instead
    // of rebuilding the fiber) and `.loose()` (an invalid value falls back to the
    // field default instead of producing a validation issue), and the enclosing
    // object is `.loose()` too so even a non-object config cannot raise an issue.
    // Cordis throws `ValidationError` on any reported issue, so this is what makes
    // "no configuration value can prevent the plugin from loading" true rather
    // than aspirational. `meta.volatile` / `meta.description` / `meta.default`
    // survive `.loose()`, so the generated settings form is unaffected.
    const schema = z.object({
      baseURL: z.string().default(DEFAULT_BASE_URL).description('OpenAI-compatible API root of the FreeLLMAPI gateway (normally ends in /v1). The plugin appends /chat/completions and /models.').volatile().loose(),
      apiKeyEnv: z.string().default(DEFAULT_API_KEY_REF).description('Credential reference name (an environment variable name or credentials-store key) — NOT the key itself.').volatile().loose(),
      apiKey: z.string().default('').role('secret').description('Optional inline credential. Prefer apiKeyEnv: a value here is stored in the profile patch.').volatile().loose(),
      mode: z.string().default(DEFAULT_MODE).description('"direct" (default): the plugin routes across its own free-provider pool. "gateway": forward to an external FreeLLMAPI gateway at baseURL.').volatile().loose(),
      providers: z.dict(z.any()).default({}).description('Per-provider overrides for the built-in pool: { groq: { enabled: true, apiKeyEnv: MY_KEY, baseURL, models: [...] } }. Advanced field; edit it in the profile patch.').volatile().loose(),
      routing: z.any().default({}).description('Routing engine knobs: { maxAttempts, budgetMs, thresholds, weights, preferredOrder, logRouting }. Advanced field; edit it in the profile patch.').volatile().loose(),
      logRouting: z.boolean().default(true).description('Log the routing decision (tier, chosen provider/model, candidates tried) for every direct-mode request.').volatile().loose(),
      maxTokensField: z.union([z.const('max_tokens'), z.const('max_completion_tokens')]).default('max_tokens').description('Wire field carrying the token cap. The gateway reads max_tokens ?? max_completion_tokens.').volatile().loose(),
      logRoutedVia: z.boolean().default(true).description('Log the upstream X-Routed-Via (and fallback trail) of every request, so you can see which provider answered.').volatile().loose(),
      includeFusion: z.boolean().default(true).description('Advertise the gateway\'s `fusion` route (panel of models + judge) in the model picker.').volatile().loose(),
      exposeDiscoveredModels: z.boolean().default(true).description('Merge GET /v1/models results into the model picker alongside the virtual auto:* routes.').volatile().loose(),
      vision: z.boolean().default(true).description('Declare image input support so DSH sends attachments instead of replacing them with text.').volatile().loose(),
      contextWindow: z.number().default(DEFAULTS.contextWindow).description('Context window assumed for routes the gateway does not describe (used for compaction budgets).').volatile().loose(),
      maxTokens: z.number().default(0).description('Default output cap declared to DSH. 0 = declare none, so the gateway and upstream decide.').volatile().loose(),
      timeoutMs: z.number().default(DEFAULTS.timeoutMs).description('Per-request timeout in milliseconds. 0 disables the timeout.').volatile().loose(),
      discoveryTimeoutMs: z.number().default(DEFAULTS.discoveryTimeoutMs).description('Timeout for the GET /v1/models discovery request.').volatile().loose(),
      discoveryCacheMs: z.number().default(DEFAULTS.discoveryCacheMs).description('How long a successful model-discovery result stays fresh.').volatile().loose(),
      headers: z.dict(z.string()).default({}).description('Extra request headers. user-agent, authorization, content-type and accept cannot be overridden.').volatile().loose(),
      taskType: z.string().default('').description('Optional X-FreeLLM-Task-Type hint (auto | code | chat). Empty disables the header.').volatile().loose(),
      cacheMode: z.string().default('').description('Optional X-FreeLLM-Cache switch (on | off). Empty disables the header.').volatile().loose(),
    }).loose()
    if (typeof schema?.toJSON !== 'function' || typeof schema?.['~standard']?.validate !== 'function') {
      return FALLBACK_CONFIG
    }
    return schema
  } catch {
    return FALLBACK_CONFIG
  }
}

/** The schema instance this module exports, chosen exactly once. */
const CHOSEN_CONFIG = await chooseConfigSchema()

/**
 * Whether the exported `Config` is a schemastery schema (settings page present)
 * or the plain fallback. Exposed for diagnostics.
 */
export const configSchemaKind = typeof CHOSEN_CONFIG.toJSON === 'function' ? 'schemastery' : 'plain'

/** The plugin config schema exported by `lib/index.js`. */
export const Config = CHOSEN_CONFIG

/**
 * Read the current configuration, normalised. Call this on every request: the
 * volatile references resolve to the live settings value, so a settings edit
 * takes effect on the next call without re-registering anything.
 *
 * @param {unknown} container the value Cordis passed to `apply`
 * @returns {ReturnType<typeof normalizeConfig>}
 */
export function readConfig(container) {
  return normalizeConfig(container)
}
