/**
 * Upstream failure classification and diagnosis.
 *
 * Two jobs:
 * 1. turn an HTTP status plus an error body into one of DSH's stable
 *    provider-neutral failure codes (`docs/SPEC.md` §5.5) — routing on the code
 *    is what makes retry/backoff/UI behave correctly;
 * 2. turn the FreeLLMAPI-specific conditions documented in
 *    `research/freellmapi-protocol.md` §7 into a sentence a user can act on.
 *
 * The classifier prefers the runtime's own `isQuotaExceededError` /
 * `isContextWindowExceededError` when they are available, so a fix in DSH
 * propagates instead of drifting.
 *
 * @module dsh-freellmapi/errors
 */

import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  QUOTA_EXCEEDED_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
} from './runtime.js'

/** Build the free-text detail string the shared classifiers expect. */
function detailText(payload, bodyText) {
  const parts = []
  if (typeof bodyText === 'string' && bodyText.length > 0) parts.push(bodyText)
  if (typeof payload === 'object' && payload !== null) {
    const error = /** @type {Record<string, unknown>} */ (payload).error
    if (typeof error === 'object' && error !== null) {
      const record = /** @type {Record<string, unknown>} */ (error)
      for (const key of ['type', 'code', 'message']) {
        if (typeof record[key] === 'string') parts.push(String(record[key]))
      }
    } else if (typeof error === 'string') {
      parts.push(error)
    }
    for (const key of ['code', 'type', 'message', 'detail']) {
      if (typeof /** @type {Record<string, unknown>} */ (payload)[key] === 'string') {
        parts.push(String(/** @type {Record<string, unknown>} */ (payload)[key]))
      }
    }
  }
  return parts.join(' ')
}

/** Best-effort upstream message from an error body. */
function upstreamMessage(payload) {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = /** @type {Record<string, unknown>} */ (payload)
  const error = record.error
  if (typeof error === 'object' && error !== null) {
    const message = /** @type {Record<string, unknown>} */ (error).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  if (typeof error === 'string' && error.length > 0) return error
  if (typeof record.message === 'string' && record.message.length > 0) return record.message
  return undefined
}

/** Upstream machine code from an error body (`quota_exceeded`, `no_vision_model`, …). */
function upstreamCode(payload) {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = /** @type {Record<string, unknown>} */ (payload)
  const error = record.error
  if (typeof error === 'object' && error !== null) {
    const code = /** @type {Record<string, unknown>} */ (error).code
    if (typeof code === 'string' && code.length > 0) return code
  }
  if (typeof record.code === 'string' && record.code.length > 0) return record.code
  return undefined
}

/**
 * Parse a `Retry-After` header into milliseconds.
 *
 * The gateway only guarantees this header for a monthly-budget exhaustion and
 * one embedding-specific case, so `undefined` is the normal outcome.
 *
 * @param {{get(name: string): string | null} | null | undefined} headers
 * @returns {number | undefined} a positive delay in milliseconds
 */
export function retryAfterMs(headers) {
  if (headers === undefined || headers === null || typeof headers.get !== 'function') return undefined
  const raw = headers.get('retry-after')
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  if (value.length === 0) return undefined
  if (/^\d+$/.test(value)) {
    const seconds = Number.parseInt(value, 10)
    return seconds > 0 ? seconds * 1000 : undefined
  }
  const date = Date.parse(value)
  if (Number.isNaN(date)) return undefined
  const delta = date - Date.now()
  return delta > 0 ? delta : undefined
}

/**
 * Map an HTTP status (+ body) onto a DSH failure code.
 * @param {number} status
 * @param {string} detail joined error text
 * @returns {string}
 */
export function classifyStatus(status, detail) {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return isQuotaExceededError(detail) ? QUOTA_EXCEEDED_CODE : 'RATE_LIMIT'
  if (status === 413) return CONTEXT_WINDOW_EXCEEDED_CODE
  if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
  if (status === 408 || status === 504) return 'TIMEOUT'
  if (status === 422) return 'UNSUPPORTED_CONTENT'
  if (status === 400 || status === 404 || status === 409) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return 'TRANSPORT'
}

/**
 * Build the user-facing failure for a non-2xx upstream response.
 *
 * @param {object} input
 * @param {number} input.status upstream HTTP status
 * @param {unknown} input.payload parsed error body, when it was JSON
 * @param {string} [input.bodyText] raw body text, used when parsing failed
 * @param {string} input.model the model string DSH asked for
 * @param {string} input.baseURL the configured endpoint root
 * @param {boolean} input.sentApiKey whether an `Authorization` header was sent
 * @param {{get(name: string): string | null} | null | undefined} [input.headers]
 * @returns {{message: string, code: string, status: number, providerRetryAfterMs?: number}}
 */
export function describeHttpFailure(input) {
  const detail = detailText(input.payload, input.bodyText)
  const code = classifyStatus(input.status, detail)
  const upstream = upstreamMessage(input.payload) ?? (input.bodyText ?? '').trim().slice(0, 400)
  const upstreamCodeValue = upstreamCode(input.payload)
  const parts = []

  switch (code) {
    case 'AUTH':
      parts.push(input.sentApiKey
        ? `the gateway rejected the credential (HTTP ${input.status})`
        : `no credential was configured, so the request was sent without an Authorization header (HTTP ${input.status})`)
      parts.push('set the credential reference named by `apiKeyEnv` (default FREELLMAPI_API_KEY) to the gateway\'s unified `freellmapi-…` key')
      break
    case QUOTA_EXCEEDED_CODE:
      parts.push('the gateway reports an exhausted quota or budget for every candidate key of this model')
      parts.push('this is a gateway-level condition: wait out the window, add another upstream key in the freellmapi dashboard, or switch strategy')
      break
    case 'RATE_LIMIT':
      parts.push('every candidate key for this model is currently rate-limited')
      parts.push('retry later or switch to a spread-out strategy such as `auto:reliable` or `auto:fast`')
      break
    case CONTEXT_WINDOW_EXCEEDED_CODE:
      parts.push('the request exceeds the context window of the model the router selected')
      parts.push('compact the session or lower the attached history, then retry')
      break
    case 'UNSUPPORTED_CONTENT':
      if (upstreamCodeValue === 'no_vision_model' || detail.includes('no_vision_model')) {
        parts.push('the active fallback chain contains no vision-capable model, so a request with images cannot be routed')
        parts.push('add a vision model to the chain or resend without the image')
      } else {
        parts.push('the gateway rejected the request content')
      }
      break
    case 'INVALID_REQUEST': {
      if (/auto:/i.test(detail) || /profile/i.test(detail)) {
        parts.push(`the gateway rejected model "${input.model}": it is not a known model id and not a routing profile that exists on this gateway`)
        parts.push('named profiles are `auto:<profile-name>` with the profile name lower-cased; check the name in the freellmapi dashboard, or use `auto` for the active fallback chain')
      } else if (input.status === 404) {
        parts.push(`the gateway returned 404 for ${input.baseURL}/chat/completions`)
        parts.push('check that `baseURL` is the OpenAI-compatible root and normally ends in `/v1`')
      } else if (input.status === 409) {
        parts.push('the gateway reported an idempotency conflict for this request')
      } else {
        parts.push('the gateway rejected the request')
      }
      break
    }
    case 'TIMEOUT':
      parts.push('the upstream provider or the gateway timed out')
      break
    case 'SERVER':
      parts.push(input.status === 502 || input.status === 503
        ? 'every candidate provider in the fallback chain failed, so the gateway could not serve the request'
        : 'the gateway or an upstream provider failed')
      break
    default:
      parts.push(`the request failed at the transport layer (HTTP ${input.status})`)
      break
  }

  const retryAfter = code === 'RATE_LIMIT' || code === QUOTA_EXCEEDED_CODE ? retryAfterMs(input.headers) : undefined
  const message = [
    `dsh-freellmapi: ${parts.join('; ')}`,
    `[model=${input.model} status=${input.status}${upstreamCodeValue === undefined ? '' : ` upstream=${upstreamCodeValue}`}]`,
    upstream === undefined || upstream.length === 0 ? '' : `upstream said: ${upstream}`,
  ].filter((part) => part.length > 0).join(' — ')

  return {
    message,
    code,
    status: input.status,
    ...retryAfter === undefined ? {} : { providerRetryAfterMs: retryAfter },
  }
}

/**
 * Describe a transport failure (`fetch` rejected: DNS, refused connection,
 * TLS, abort, timeout).
 *
 * @param {unknown} error the thrown value
 * @param {{baseURL: string, model: string, timedOut?: boolean}} input
 * @returns {{message: string, code: string}}
 */
export function describeTransportFailure(error, input) {
  const cause = error instanceof Error ? error.message : String(error)
  const chain = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : ''
  if (input.timedOut === true) {
    return {
      message: `dsh-freellmapi: the request to ${input.baseURL} exceeded the configured timeout — raise \`timeoutMs\` or check the gateway [model=${input.model}] — ${cause}${chain}`,
      code: 'TIMEOUT',
    }
  }
  return {
    message: `dsh-freellmapi: cannot reach the FreeLLMAPI gateway at ${input.baseURL} — confirm the gateway is running (default http://localhost:3001/v1), that \`baseURL\` ends in \`/v1\`, and that nothing blocks the connection [model=${input.model}] — ${cause}${chain}`,
    code: 'TRANSPORT',
  }
}
