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

/** How many recent routing records the ring buffer keeps. */
export const ROUTE_HISTORY_LIMIT = 50

/** Value recorded when the gateway did not identify the serving route. */
export const UNKNOWN_ROUTE = 'unknown'

/**
 * One routing observation.
 * @typedef {object} RouteRecord
 * @property {number} at epoch milliseconds when the response headers were read
 * @property {string} routedVia `<platform>/<model>`, or `unknown`
 * @property {string} requestedModel the model string DSH asked for (`auto`, `auto:fast`, …)
 * @property {string} [requestedProvider] the DSH provider route the request was dispatched on
 * @property {number} [fallbackAttempts] value of `X-Fallback-Attempts` when present
 * @property {string} [fallbackTrail] value of `X-Fallback-Trail` when present
 * @property {number} [status] upstream HTTP status
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
 * Render the human-readable routing line.
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
 * Record the route and, when enabled, log it.
 *
 * Logging is defensive twice over: the `logger` service may be absent (headless
 * composition, tests) and a logger that throws must never be able to break a
 * stream. Both are swallowed.
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
  })
  if (context.enabled === false) return record
  try {
    context.logger?.info?.(formatRouteLine(record))
  } catch {
    // observability must never be able to fail a request
  }
  return record
}
