/**
 * Runtime bridge between this plugin and the DSH host packages.
 *
 * ## Why this module exists
 *
 * The DSH runtime resolves `@deepseek-ai/dsh-llm` from the installed harness
 * (app.asar) because the package is deliberately *not* a dependency of plugins
 * (`docs/SPEC.md` §2): declaring it would make the profile's package manager
 * materialise a second copy, which breaks class identity across the two module
 * instances (`instanceof LlmError` fails, error codes silently degrade to
 * `UNKNOWN`) and can prevent the profile from starting.
 *
 * At the same time this package must stay importable in a bare checkout — the
 * acceptance test is literally `node -e "import('./lib/index.js')"` from a
 * directory that has no `node_modules` at all. A static
 * `import { LlmAdapter } from '@deepseek-ai/dsh-llm'` would make that import
 * throw `ERR_MODULE_NOT_FOUND`.
 *
 * The resolution is a **top-level `await import()` with a complete local
 * shim fallback**: inside a real DSH process the genuine runtime module is
 * used (same instance the `llm` service uses), and everywhere else the shims
 * below reproduce the exact documented behaviour of the pieces we consume.
 * `ctx.llm.registerAdapter()` performs duck-typing only (it calls
 * `adapter.providerInfo()` / `adapter.providerRetryPolicy()`, never
 * `instanceof LlmAdapter`), so the fallback base class is not a runtime risk.
 *
 * @module dsh-freellmapi/runtime
 */

/** Package specifier of the DSH LLM runtime. */
export const DSH_LLM_PACKAGE = '@deepseek-ai/dsh-llm'

/** Banner used by the fallback User-Agent when the harness version is unknown. */
const FALLBACK_UA = 'deepseek-harness/unknown (+https://github.com/deepseek-ai/deepseek-harness)'

/** @type {Record<string, unknown> | null} */
let runtime = null
try {
  const loaded = await import(DSH_LLM_PACKAGE)
  if (loaded !== null && typeof loaded === 'object') runtime = loaded
} catch {
  runtime = null
}

/**
 * Whether the genuine `@deepseek-ai/dsh-llm` runtime was resolved.
 * `false` means every binding below is a local shim (bare checkout, tests,
 * embedded use). Exposed for diagnostics and tests.
 */
export const llmRuntimeAvailable = runtime !== null

/** Human-readable note describing which runtime this module bound to. */
export const llmRuntimeSource = runtime === null
  ? `${DSH_LLM_PACKAGE} not resolvable — using local shims`
  : `${DSH_LLM_PACKAGE} resolved from the DSH runtime`

/**
 * Fallback `LlmAdapter`. Mirrors the base-class default implementations of
 * `LLM:lib/index.js:1670-1740` method for method so behaviour is identical
 * whether or not the real base class was available. Every method this plugin
 * relies on is overridden by the concrete adapter anyway; `stream()` is the
 * only abstract member and is never called on the base.
 */
class ShimLlmAdapter {
  /** @param {string} provider @returns {{id: string, name: string}} */
  providerInfo(provider) {
    return { id: provider, name: provider }
  }

  /** @param {string} _provider @returns {undefined} */
  providerRetryPolicy(_provider) {
    return undefined
  }

  /** @param {string} _provider @param {string} _model @returns {undefined} */
  imageRequestPricing(_provider, _model) {
    return undefined
  }

  /** @param {string} _provider @returns {Promise<readonly unknown[]>} */
  listModels(_provider) {
    return Promise.resolve([])
  }

  /** @param {string} provider @param {string} model @returns {Promise<object>} */
  resolveModel(provider, model, _signal) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  /** @param {string} provider @param {string} model @param {AbortSignal} [signal] */
  prepareCall(provider, model, signal) {
    return Promise.resolve(this.resolveModel(provider, model, signal)).then((model_) => ({
      model: model_,
      stream: (options) => this.stream(options),
    }))
  }

  /** @param {object} _options @returns {AsyncIterable<unknown>} */
  stream(_options) {
    throw new Error('LlmAdapter.stream() is abstract')
  }
}

/**
 * Fallback `LlmError`: same constructor contract and same `failure` payload
 * shape as `LLM:lib/index.js:1615-1640`, including its argument validation.
 */
class ShimLlmError extends Error {
  /**
   * @param {string} message non-empty human-readable failure summary
   * @param {string} code non-empty stable provider-neutral machine code
   * @param {{status?: number, providerRetryAfterMs?: number, requestId?: string, offloadImages?: number, cause?: unknown}} [options]
   */
  constructor(message, code, options) {
    if (typeof message !== 'string' || message.length === 0) {
      throw new Error('LlmError message must be a non-empty string')
    }
    if (typeof code !== 'string' || code.length === 0) {
      throw new Error('LlmError code must be a non-empty string')
    }
    if (options?.status !== undefined
      && (!Number.isInteger(options.status) || options.status < 100 || options.status > 599)) {
      throw new Error('LlmError status must be an integer from 100 through 599')
    }
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
    this.name = 'LlmError'
    this.failure = Object.freeze({
      message,
      code,
      ...options?.status === undefined ? {} : { status: options.status },
      ...options?.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: options.providerRetryAfterMs },
      ...options?.requestId === undefined ? {} : { requestId: options.requestId },
      ...options?.offloadImages === undefined ? {} : { offloadImages: options.offloadImages },
    })
  }
}

/** Structured code for a credential that was supplied but cannot be used. */
export const INVALID_CREDENTIAL_CODE = runtime?.INVALID_CREDENTIAL_CODE ?? 'INVALID_CREDENTIAL'
/** Structured code for a response that completed with zero content blocks. */
export const EMPTY_RESPONSE_CODE = runtime?.EMPTY_RESPONSE_CODE ?? 'EMPTY_RESPONSE'
/** Structured code for an exhausted account quota or balance. */
export const QUOTA_EXCEEDED_CODE = runtime?.QUOTA_EXCEEDED_CODE ?? 'QUOTA'
/** Structured code for a rejected context window. */
export const CONTEXT_WINDOW_EXCEEDED_CODE = runtime?.CONTEXT_WINDOW_EXCEEDED_CODE ?? 'CONTEXT_WINDOW_EXCEEDED'

/** The `LlmAdapter` base class to extend: the runtime one, or the shim. */
export const LlmAdapter = runtime?.LlmAdapter ?? ShimLlmAdapter

/** The `LlmError` class to throw: the runtime one, or the shim. */
export const LlmError = runtime?.LlmError ?? ShimLlmError

/** Whether a value is an `LlmError` of *this* module instance's class identity. */
export function isLlmError(value) {
  return value instanceof LlmError
}

/**
 * Provider-request attribution headers (`LLM:lib/index.js:1664-1669` requires
 * every outbound provider request to carry them). Falls back to the documented
 * `product/version (+url)` shape when the runtime module is unavailable.
 * @returns {Record<string, string>}
 */
export function attributionHeaders() {
  if (typeof runtime?.attributionHeaders === 'function') {
    try {
      return runtime.attributionHeaders()
    } catch {
      // fall through to the local implementation
    }
  }
  return { 'user-agent': FALLBACK_UA }
}

/** Local mirror of the runtime's context-overflow classifier (fallback only). */
function shimIsContextWindowExceededError(detail) {
  return /\bcontext[\s_-](?:length|window)[\s_-]?(?:exceed(?:ed|s)?|overflow(?:ed)?|limit)\b/i.test(detail)
    || /\b(?:maximum|max)(?:\s+(?:allowed|supported))?\s+context\s+(?:length|window)\b/i.test(detail)
    || /\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?too\s+(?:large|long)\s+for\b/i.test(detail)
}

/** Local mirror of the runtime's quota classifier (fallback only). */
function shimIsQuotaExceededError(detail) {
  return /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i.test(detail)
    || /\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i.test(detail)
    || /\bexceed(?:ed|s)?[\s_-]+(?:(?:your|the)[\s_-]+)?(?:current[\s_-]+)?quota\b/i.test(detail)
    || /\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b/i.test(detail)
    || /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i.test(detail)
}

/**
 * Classify provider error text as a context-window overflow.
 * @param {string} detail provider code/type/message text joined into one string
 * @returns {boolean}
 */
export function isContextWindowExceededError(detail) {
  if (typeof runtime?.isContextWindowExceededError === 'function') {
    try {
      return runtime.isContextWindowExceededError(detail)
    } catch {
      // fall through
    }
  }
  return shimIsContextWindowExceededError(detail)
}

/**
 * Classify provider error text as an exhausted quota/balance.
 * @param {string} detail provider code/type/message text joined into one string
 * @returns {boolean}
 */
export function isQuotaExceededError(detail) {
  if (typeof runtime?.isQuotaExceededError === 'function') {
    try {
      return runtime.isQuotaExceededError(detail)
    } catch {
      // fall through
    }
  }
  return shimIsQuotaExceededError(detail)
}

/** Characters an HTTP header value carries verbatim (mirrors `LLM:lib/types/api-key.js:14`). */
const LEGAL_API_KEY = /^[\x21-\x7E]+$/

/** Local mirror of `normalizeApiKey` (fallback only). */
function shimNormalizeApiKey(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'empty' }
  const value = raw.trim()
  if (value.length === 0) return { ok: false, reason: 'empty' }
  if (!LEGAL_API_KEY.test(value)) return { ok: false, reason: 'illegalCharacters' }
  return { ok: true, value }
}

/**
 * Accept one supplied credential or refuse it as unusable, never echoing the
 * secret. Uses the runtime's `assertUsableApiKey` when available so the code
 * (`INVALID_CREDENTIAL`) and wording match the rest of DSH.
 * @param {string} raw the credential exactly as supplied
 * @param {string} pkg refusing package name, prefixed to the diagnostic
 * @param {string} ref the credential reference the value resolved through
 * @returns {string} the trimmed, usable key
 * @throws {LlmError} with code `INVALID_CREDENTIAL`
 */
export function assertUsableApiKey(raw, pkg, ref) {
  if (typeof runtime?.assertUsableApiKey === 'function') {
    return runtime.assertUsableApiKey(raw, pkg, ref)
  }
  const checked = shimNormalizeApiKey(raw)
  if (checked.ok) return checked.value
  throw new LlmError(
    checked.reason === 'empty'
      ? `${pkg}: the API key resolved from ${ref} is blank; set ${ref} to the raw key (the web Models page writes it) or export it in the launching environment`
      : `${pkg}: the API key resolved from ${ref} contains characters no HTTP header can carry; set ${ref} to the raw key alone (the web Models page writes it)`,
    INVALID_CREDENTIAL_CODE,
  )
}
