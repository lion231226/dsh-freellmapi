/**
 * Upstream route observability.
 *
 * FreeLLMAPI answers every request with `X-Routed-Via: <platform>/<model>` —
 * the only header that names the provider and model that actually served the
 * call (the serving hop cannot appear in `X-Fallback-Trail`, because the headers
 * are flushed before the body is generated). Surfacing it is this plugin's main
 * addition over the generic OpenAI-compatible path, which never sees upstream
 * response headers.
 *
 * The module keeps a small process-wide ring buffer of the most recent routes so
 * tests and future UI can read them, and renders the one log line the README
 * documents. It is intentionally dependency-free: no service is registered and
 * no tool is added.
 *
 * @module dsh-freellmapi/routes
 */

import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** How many recent routing records the ring buffer keeps. */
export const ROUTE_HISTORY_LIMIT = 50

/** Value recorded when the gateway did not identify the serving route. */
export const UNKNOWN_ROUTE = 'unknown'

/**
 * One routing observation.
 * @typedef {object} RouteRecord
 * @property {number} at epoch milliseconds when the response headers were read
 * @property {string} routedVia `<platform>/<model>`, or `unknown` (gateway mode)
 * @property {string} requestedModel the model string DSH asked for (`auto`, `auto:fast`, …)
 * @property {string} [requestedProvider] the DSH provider route the request was dispatched on
 * @property {number} [fallbackAttempts] value of `X-Fallback-Attempts` when present
 * @property {string} [fallbackTrail] value of `X-Fallback-Trail` when present
 * @property {number} [status] upstream HTTP status
 * @property {'direct' | 'gateway'} [mode] which engine served the request
 * @property {string} [tier] complexity tier the classifier chose (direct mode)
 * @property {number} [score] classifier score (direct mode)
 * @property {string} [provider] provider that actually served the request (direct mode)
 * @property {string} [model] model that actually served the request (direct mode)
 * @property {number} [capability] capability rating of the chosen model (1–5)
 * @property {number} [speed] speed rating of the chosen model (1–5)
 * @property {number} [candidateCount] candidates that were attempted
 * @property {{provider: string, model: string, code?: string}[]} [attempts] every attempt and how it ended
 * @property {string[]} [reasons] classification and ranking reasons
 */

/** @type {RouteRecord[]} */
const history = []

/**
 * Normalise one header value.
 *
 * Non-ASCII model ids arrive percent-encoded, so a header that looks encoded is
 * decoded once; malformed escapes are kept verbatim rather than throwing.
 *
 * @param {string | null | undefined} raw
 * @returns {string}
 */
export function normalizeHeaderValue(raw) {
  if (typeof raw !== 'string') return UNKNOWN_ROUTE
  const value = raw.trim()
  if (value.length === 0) return UNKNOWN_ROUTE
  if (!value.includes('%')) return value
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Read the routing headers off a response.
 * @param {{headers?: {get(name: string): string | null} | null}} response
 * @returns {{routedVia: string, fallbackAttempts?: number, fallbackTrail?: string}}
 */
export function readRoutingHeaders(response) {
  const headers = response?.headers
  if (headers === undefined || headers === null || typeof headers.get !== 'function') {
    return { routedVia: UNKNOWN_ROUTE }
  }
  const routedVia = normalizeHeaderValue(headers.get('x-routed-via'))
  const attemptsRaw = headers.get('x-fallback-attempts')
  const attempts = typeof attemptsRaw === 'string' ? Number.parseInt(attemptsRaw.trim(), 10) : Number.NaN
  const trail = headers.get('x-fallback-trail')
  return {
    routedVia,
    ...Number.isFinite(attempts) ? { fallbackAttempts: attempts } : {},
    ...typeof trail === 'string' && trail.trim().length > 0 ? { fallbackTrail: trail.trim() } : {},
  }
}

/**
 * Record one observation in the ring buffer.
 * @param {RouteRecord} record
 * @returns {RouteRecord} the frozen stored record
 */
export function recordRoute(record) {
  const stored = Object.freeze({ ...record })
  history.push(stored)
  if (history.length > ROUTE_HISTORY_LIMIT) history.splice(0, history.length - ROUTE_HISTORY_LIMIT)
  return stored
}

/**
 * The most recent routing records, oldest first.
 * @returns {RouteRecord[]} a shallow copy, safe for callers to mutate
 */
export function getRecentRoutes() {
  return history.slice()
}

/** Drop every recorded route (used by tests). */
export function clearRecentRoutes() {
  history.length = 0
}

/**
 * Render the human-readable routing line for **gateway** mode.
 * @param {RouteRecord} record
 * @returns {string}
 */
export function formatRouteLine(record) {
  const detail = [
    record.fallbackAttempts === undefined ? '' : `fallback-attempts=${record.fallbackAttempts}`,
    record.fallbackTrail === undefined ? '' : `trail=${record.fallbackTrail}`,
  ].filter((part) => part.length > 0).join(' ')
  const suffix = detail.length === 0 ? '' : ` ${detail}`
  return `dsh-freellmapi: routed via ${record.routedVia} (model=${record.requestedModel})${suffix}`
}

/**
 * Render the human-readable routing line for **direct** mode.
 *
 * ```text
 * dsh-freellmapi: tier=complex -> groq/llama-3.3-70b (capability=4, speed=5, 3 candidates tried)
 * dsh-freellmapi: tier=simple -> no candidate (0 candidates tried)
 * ```
 *
 * @param {RouteRecord} record
 * @returns {string}
 */
export function formatDirectRouteLine(record) {
  const target = typeof record.provider === 'string' && record.provider.length > 0
    && typeof record.model === 'string' && record.model.length > 0
    ? `${record.provider}/${record.model}`
    : 'no candidate'
  const detail = [
    record.capability === undefined ? '' : `capability=${record.capability}`,
    record.speed === undefined ? '' : `speed=${record.speed}`,
    `${record.candidateCount ?? 0} candidates tried`,
  ].filter((part) => part.length > 0).join(', ')
  return `dsh-freellmapi: tier=${record.tier ?? 'unknown'} -> ${target} (${detail})`
}

/**
 * Record the route and, when enabled, log it.
 *
 * Logging is defensive twice over: the `logger` service may be absent (headless
 * composition, tests) and a logger that throws must never be able to break a
 * stream. Both are swallowed.
 *
 * The formatter is chosen by `observation.mode`, so gateway records keep the
 * exact line shape they have always produced.
 *
 * @param {{logger?: {info?: Function, warn?: Function} | null, enabled?: boolean, now?: () => number}} context
 * @param {Omit<RouteRecord, 'at'> & {at?: number}} observation
 * @returns {RouteRecord} the stored record
 */
export function reportRoute(context, observation) {
  const record = recordRoute({
    at: observation.at ?? context.now?.() ?? Date.now(),
    routedVia: observation.routedVia,
    requestedModel: observation.requestedModel,
    ...observation.requestedProvider === undefined ? {} : { requestedProvider: observation.requestedProvider },
    ...observation.fallbackAttempts === undefined ? {} : { fallbackAttempts: observation.fallbackAttempts },
    ...observation.fallbackTrail === undefined ? {} : { fallbackTrail: observation.fallbackTrail },
    ...observation.status === undefined ? {} : { status: observation.status },
    ...observation.mode === undefined ? {} : { mode: observation.mode },
    ...observation.tier === undefined ? {} : { tier: observation.tier },
    ...observation.score === undefined ? {} : { score: observation.score },
    ...observation.provider === undefined ? {} : { provider: observation.provider },
    ...observation.model === undefined ? {} : { model: observation.model },
    ...observation.capability === undefined ? {} : { capability: observation.capability },
    ...observation.speed === undefined ? {} : { speed: observation.speed },
    ...observation.candidateCount === undefined ? {} : { candidateCount: observation.candidateCount },
    ...observation.attempts === undefined ? {} : { attempts: observation.attempts.map((attempt) => ({ ...attempt })) },
    ...observation.reasons === undefined ? {} : { reasons: [...observation.reasons] },
  })
  if (context.enabled === false) return record
  try {
    context.logger?.info?.(record.mode === 'direct' ? formatDirectRouteLine(record) : formatRouteLine(record))
    appendPersistentRoute(record)
  } catch {
    // observability must never be able to fail a request
  }
  return record
}

const PERSIST_DIR = join(homedir(), '.dsh', 'storages', 'dsh-freellmapi')
const writers = new Map()

function appendPersistentRoute (record) {
  const day = new Date(record.at ?? Date.now()).toISOString().slice(0, 10)
  const file = join(PERSIST_DIR, `routes-${day}.log`)
  let writer = writers.get(file)
  if (!writer) {
    try { mkdirSync(PERSIST_DIR, { recursive: true }) } catch { /* best effort */ }
    try { writer = createWriteStream(file, { flags: 'a', encoding: 'utf8' }) } catch { return }
    writers.set(file, writer)
  }
  try {
    const line = record.mode === 'direct' ? formatDirectRouteLine(record) : formatRouteLine(record)
    writer.write(line + '\n')
  } catch {
    // best effort: swallow so observability never fails a request
  }
}
