/**
 * Plugin configuration.
 *
 * ## Shape of the exported `Config`
 *
 * Cordis resolves a plugin's config through `runtime.Config['~standard'].validate(config)`
 * (`cordis/lib/index.js:956-962`) — a *Standard Schema* object. But the settings
 * service additionally requires the schema to expose `toJSON()` before it will
 * build a form for the entry (`dsh-settings/lib/index.js:538-541`), and a plugin
 * with no form gets **no settings namespace at all**.
 *
 * That last consequence is why this module exports a **real schemastery schema
 * and nothing else**. An earlier revision treated a plain Standard Schema object
 * as a graceful fallback ("the plugin still loads, it just has no settings
 * page"), reached through a guarded dynamic `import()`. That reading was wrong
 * in two ways that cost a long debugging session:
 *
 * 1. `guide/plugin-dev-guide.md` §3.6 is explicit — **a plain object is not an
 *    acceptable `Config`, and an unusable schema must fail loud, never be
 *    silently swallowed**.
 * 2. The degradation is not local. With no settings namespace,
 *    `ctx.llm.registerConfigurableProviders()` still registers this plugin's
 *    provider, but the Models page cannot resolve a namespace for it: the row is
 *    neither rendered as a card (`configured` is false) nor offered under "add
 *    model provider" (its namespace is missing), so the provider becomes
 *    **invisible in the UI while still routing traffic** — the worst failure
 *    shape available, because everything appears to work.
 *
 * The old fallback was reached in practice because a profile install links this
 * package into the profile, and Node resolves bare specifiers from a module's
 * **realpath**: a `link:`-ed plugin resolved `@deepseek-ai/schemastery` against
 * its own directory, not the profile's, got `ERR_MODULE_NOT_FOUND`, and quietly
 * downgraded. A static import plus a declared peer dependency removes both the
 * silent path and the resolution hazard (see `peerDependencies` in
 * `package.json`; run `pnpm install` in this package for local development).
 *
 * Every field is `.volatile()`, so a settings edit re-resolves the value in place
 * instead of rebuilding the fiber, and {@link readConfig} always sees the current
 * value. Reads go through {@link normalizeConfig}, which is total: **no
 * configuration value, however malformed, can make `apply` throw**.
 *
 * @module dsh-freellmapi/config
 */

import Schema from '@deepseek-ai/schemastery'

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
  /**
   * Safety margin applied to the estimated input size before comparing it with a
   * model's context window: a candidate must satisfy
   * `window >= estimate * contextSafetyFactor`.
   *
   * The estimate is a heuristic (≈1 token per CJK character, ≈4 characters per
   * token elsewhere) and it **undercounts**. A real 297,538-token session was
   * estimated at roughly 268k, which slipped past a 262,144-token gate and came
   * back as an upstream HTTP 400. Being one model too conservative costs a little
   * routing quality; being one model too optimistic costs the whole request.
   */
  contextSafetyFactor: 1.15,
  /**
   * The context-window floor applied to a **context-summarisation** call.
   *
   * DSH compresses a session by asking a model to summarise the span it is about
   * to drop, so that call carries the *whole history being compressed* as its
   * input. It is therefore large by construction, and it is the one request whose
   * size the router cannot afford to underestimate: if the summary call does not
   * fit, the compaction fails, the pressure does not fall, and DSH retries the
   * same impossible compaction.
   *
   * Measured 2026-10-15 (durable session log): a compaction call was routed to a
   * 262,144-token model with about 297,538 tokens of input and came back
   * `maximum context length is 262144 tokens. However, you requested about
   * 297538 tokens`. The failure repeats rather than degrading — the session never
   * gets smaller.
   *
   * The relative `tokens * contextSafetyFactor` gate cannot prevent this, because
   * the estimate undercounts and, more importantly, a summary call must fit
   * *after* the compaction it is performing. This floor is absolute on purpose:
   * it says "a model must be able to hold a large context at all", which is a
   * property of the model, not of this request's estimate. Set to `0` to disable.
   */
  compactionMinContextWindow: 262_144,
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
    contextSafetyFactor: numberField(
      readField(record.contextSafetyFactor),
      ROUTING_DEFAULTS.contextSafetyFactor,
      { min: 1 },
    ),
    compactionMinContextWindow: Math.trunc(numberField(
      readField(record.compactionMinContextWindow),
      ROUTING_DEFAULTS.compactionMinContextWindow,
      { min: 0 },
    )),
    thresholds,
    weights,
    preferredOrder,
  }
}

/**
 * The plugin's config schema — the value exported as `Config`.
 *
 * Every field is `.volatile()` (a settings edit re-resolves the value in place
 * instead of rebuilding the fiber) and `.loose()` (an invalid value falls back to
 * the field default instead of producing a validation issue), and the enclosing
 * object is `.loose()` too so even a non-object config cannot raise an issue.
 * Cordis throws `ValidationError` on any reported issue, so this is what makes
 * "no configuration value can prevent the plugin from loading" true rather than
 * aspirational. `meta.volatile` / `meta.description` / `meta.default` survive
 * `.loose()`, so the generated settings form is unaffected.
 *
 * There is deliberately **no fallback**. A schema the host cannot render must
 * fail loudly here rather than degrade into a plain object, because the
 * degradation is invisible downstream: `dsh-settings` skips entries without
 * `toJSON()`, the entry gets no namespace, and the Models page then shows the
 * provider nowhere while it keeps routing traffic.
 */
export const Config = Schema.object({
  baseURL: Schema.string().default(DEFAULT_BASE_URL).description('OpenAI-compatible API root of the FreeLLMAPI gateway (normally ends in /v1). The plugin appends /chat/completions and /models.').volatile().loose(),
  apiKeyEnv: Schema.string().default(DEFAULT_API_KEY_REF).description('Credential reference name (an environment variable name or credentials-store key) — NOT the key itself.').volatile().loose(),
  apiKey: Schema.string().default('').role('secret').description('Optional inline credential. Prefer apiKeyEnv: a value here is stored in the profile patch.').volatile().loose(),
  mode: Schema.string().default(DEFAULT_MODE).description('"direct" (default): the plugin routes across its own free-provider pool. "gateway": forward to an external FreeLLMAPI gateway at baseURL.').volatile().loose(),
  providers: Schema.dict(Schema.any()).default({}).description('Per-provider overrides for the built-in pool: { groq: { enabled: true, apiKeyEnv: MY_KEY, baseURL, models: [...] } }. Advanced field; edit it in the profile patch.').volatile().loose(),
  routing: Schema.any().default({}).description('Routing engine knobs: { maxAttempts, budgetMs, contextSafetyFactor, compactionMinContextWindow, thresholds, weights, preferredOrder }. Advanced field; edit it in the profile patch.').volatile().loose(),
  logRouting: Schema.boolean().default(true).description('Log the routing decision (tier, chosen provider/model, candidates tried) for every direct-mode request.').volatile().loose(),
  maxTokensField: Schema.union([Schema.const('max_tokens'), Schema.const('max_completion_tokens')]).default('max_tokens').description('Wire field carrying the token cap. The gateway reads max_tokens ?? max_completion_tokens.').volatile().loose(),
  logRoutedVia: Schema.boolean().default(true).description('Log the upstream X-Routed-Via (and fallback trail) of every request, so you can see which provider answered.').volatile().loose(),
  includeFusion: Schema.boolean().default(true).description('Advertise the gateway\'s `fusion` route (panel of models + judge) in the model picker.').volatile().loose(),
  exposeDiscoveredModels: Schema.boolean().default(true).description('Merge GET /v1/models results into the model picker alongside the virtual auto:* routes.').volatile().loose(),
  vision: Schema.boolean().default(true).description('Declare image input support so DSH sends attachments instead of replacing them with text.').volatile().loose(),
  contextWindow: Schema.number().default(DEFAULTS.contextWindow).description('Context window assumed for routes the gateway does not describe (used for compaction budgets).').volatile().loose(),
  maxTokens: Schema.number().default(0).description('Default output cap declared to DSH. 0 = declare none, so the gateway and upstream decide.').volatile().loose(),
  timeoutMs: Schema.number().default(DEFAULTS.timeoutMs).description('Per-request timeout in milliseconds. 0 disables the timeout.').volatile().loose(),
  discoveryTimeoutMs: Schema.number().default(DEFAULTS.discoveryTimeoutMs).description('Timeout for the GET /v1/models discovery request.').volatile().loose(),
  discoveryCacheMs: Schema.number().default(DEFAULTS.discoveryCacheMs).description('How long a successful model-discovery result stays fresh.').volatile().loose(),
  headers: Schema.dict(Schema.string()).default({}).description('Extra request headers. user-agent, authorization, content-type and accept cannot be overridden.').volatile().loose(),
  taskType: Schema.string().default('').description('Optional X-FreeLLM-Task-Type hint (auto | code | chat). Empty disables the header.').volatile().loose(),
  cacheMode: Schema.string().default('').description('Optional X-FreeLLM-Cache switch (on | off). Empty disables the header.').volatile().loose(),
}).loose()

/**
 * Always `'schemastery'`. Kept because it used to report which branch the
 * guarded import took, and that distinction no longer exists.
 * @type {'schemastery'}
 */
export const configSchemaKind = 'schemastery'

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
