/**
 * Per-`(provider, model)` health tracking for the direct routing engine.
 *
 * ## Contract
 *
 * Stateful, **no I/O**, and the clock is injectable (`opts.now`). Persistence is
 * deliberately the caller's job: `toJSON()`/`fromJSON()` round-trip the state, so
 * a host that wants it to survive restarts can write it anywhere without this
 * module ever touching a file.
 *
 * ## Why cooldowns rather than counters
 *
 * Free pools are shared and 429 is the normal weather, not an outage
 * (`research/free-provider-catalog.md` §14.4.3). A failing provider therefore has
 * to be *parked* for a while instead of merely ranked lower, or every request
 * pays the same timeout again. The ladder matches freellmapi's own escalation
 * (2 m → 10 m → 1 h → 24 h), and a `Retry-After` from the provider always wins
 * because it is the only party that knows when the budget resets.
 *
 * @module dsh-freellmapi/health
 */

/** Default cooldown ladder in milliseconds: 2 m → 10 m → 1 h → 24 h. */
export const DEFAULT_COOLDOWN_LADDER = Object.freeze([120_000, 600_000, 3_600_000, 86_400_000])

/** How long an `invalid` credential keeps a provider out of the pool. */
export const INVALID_CREDENTIAL_COOLDOWN_MS = 86_400_000

/** Weight of the newest latency sample in the EWMA. */
const DEFAULT_LATENCY_ALPHA = 0.3

/**
 * Half-life of a recorded failure, in milliseconds.
 *
 * Without decay a single 429 is a **permanent** sentence: the penalised candidate
 * falls behind a peer that has never been measured, so it is never selected
 * again, so it never gets the success that would clear the penalty. Measured
 * behaviour before this was added: one 429 on the fast model and it stayed
 * unchosen at +61 s, at +10 h, forever.
 *
 * The half-life is deliberately much shorter than the cooldown ladder (2 m → 10 m
 * → 1 h → 24 h): the *cooldown* is the real penalty, and this factor only breaks
 * ties among candidates that are already allowed to run. After the 2-minute
 * cooldown expires, a one-failure penalty is down to 0.25 of a failure — small
 * enough that the candidate is genuinely back in the race.
 */
export const DEFAULT_FAILURE_HALF_LIFE_MS = 60_000

/** Key separator that cannot appear in a provider id or a model id. */
const SEPARATOR = '\u0000'

/** @param {unknown} value @returns {number | undefined} */
function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * One tracked route's state.
 * @typedef {object} HealthSnapshot
 * @property {number} failures consecutive recorded failures (raw count)
 * @property {number} effectiveFailures `failures` after time decay — what ranking uses
 * @property {number} successes total recorded successes
 * @property {number} cooldownUntil epoch ms until which the route is parked (0 = available)
 * @property {number} lastFailureAt epoch ms of the most recent failure (0 = never)
 * @property {number | null} latencyEwma smoothed latency in ms, or null when never measured
 * @property {boolean} invalid set when the provider rejected the credential (401/403)
 */

/**
 * Tracks cooldowns, failure counts and smoothed latency for routing decisions.
 */
export class HealthTracker {
  /** @type {Map<string, {failures: number, successes: number, cooldownUntil: number, latencyEwma: number | null, invalid: boolean, lastFailureAt: number}>} */
  #entries = new Map()

  /**
   * @param {object} [opts]
   * @param {() => number} [opts.now] injectable clock (defaults to `Date.now`)
   * @param {readonly number[]} [opts.cooldownLadder] ascending cooldown steps
   * @param {number} [opts.latencyAlpha] EWMA weight for the newest sample
   * @param {number} [opts.failureHalfLifeMs] half-life of a recorded failure
   */
  constructor(opts = {}) {
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now()
    const ladder = Array.isArray(opts.cooldownLadder)
      ? opts.cooldownLadder.filter((value) => typeof value === 'number' && Number.isFinite(value) && value > 0)
      : []
    this.cooldownLadder = Object.freeze(ladder.length > 0 ? [...ladder] : [...DEFAULT_COOLDOWN_LADDER])
    const alpha = finiteNonNegative(opts.latencyAlpha)
    this.latencyAlpha = alpha === undefined || alpha > 1 ? DEFAULT_LATENCY_ALPHA : alpha
    const halfLife = finiteNonNegative(opts.failureHalfLifeMs)
    this.failureHalfLifeMs = halfLife === undefined || halfLife <= 0 ? DEFAULT_FAILURE_HALF_LIFE_MS : halfLife
  }

  /** @param {unknown} provider @param {unknown} model @returns {string} */
  static keyOf(provider, model) {
    return `${String(provider ?? '')}${SEPARATOR}${String(model ?? '')}`
  }

  /** @param {unknown} provider @param {unknown} model @returns {string} */
  #key(provider, model) {
    return HealthTracker.keyOf(provider, model)
  }

  /**
   * The state for one route. Unknown routes report a pristine entry rather than
   * throwing, so a caller never has to pre-register anything.
   * @param {string} provider
   * @param {string} model
   * @returns {HealthSnapshot}
   */
  snapshot(provider, model) {
    const entry = this.#entries.get(this.#key(provider, model))
    if (entry === undefined) {
      return {
        failures: 0, effectiveFailures: 0, successes: 0, cooldownUntil: 0,
        lastFailureAt: 0, latencyEwma: null, invalid: false,
      }
    }
    return {
      ...entry,
      effectiveFailures: this.#effectiveFailures(entry),
    }
  }

  /**
   * A failure's weight after time decay. See {@link DEFAULT_FAILURE_HALF_LIFE_MS}.
   * @param {{failures: number, lastFailureAt: number}} entry
   * @returns {number}
   */
  #effectiveFailures(entry) {
    if (entry.failures <= 0) return 0
    if (entry.lastFailureAt <= 0) return entry.failures
    const elapsed = this.now() - entry.lastFailureAt
    if (!Number.isFinite(elapsed) || elapsed <= 0) return entry.failures
    return entry.failures * 0.5 ** (elapsed / this.failureHalfLifeMs)
  }

  /**
   * Whether a route may be attempted right now.
   * @param {string} provider
   * @param {string} model
   * @returns {boolean}
   */
  isAvailable(provider, model) {
    const entry = this.#entries.get(this.#key(provider, model))
    if (entry === undefined) return true
    return this.now() >= entry.cooldownUntil
  }

  /**
   * Record a successful attempt: the route is un-parked and the failure streak
   * resets, because "it worked" is the strongest possible evidence.
   * @param {string} provider
   * @param {string} model
   * @param {number} [latencyMs] time to first chunk
   * @returns {HealthSnapshot}
   */
  recordSuccess(provider, model, latencyMs) {
    const key = this.#key(provider, model)
    const previous = this.#entries.get(key) ?? {
      failures: 0, successes: 0, cooldownUntil: 0, latencyEwma: null, invalid: false, lastFailureAt: 0,
    }
    const sample = finiteNonNegative(latencyMs)
    const latencyEwma = sample === undefined
      ? previous.latencyEwma
      : previous.latencyEwma === null
        ? sample
        : this.latencyAlpha * sample + (1 - this.latencyAlpha) * previous.latencyEwma
    const entry = {
      failures: 0,
      successes: previous.successes + 1,
      cooldownUntil: 0,
      latencyEwma,
      invalid: false,
      lastFailureAt: 0,
    }
    this.#entries.set(key, entry)
    return this.snapshot(provider, model)
  }

  /**
   * Record a failed attempt and park the route when the failure justifies it.
   *
   * Cooldown rule, in priority order:
   * 1. a rejected credential (401/403) **always** parks (24 h) — the fix is to
   *    correct the key, not to retry;
   * 2. an explicit `cooldown: true|false` wins — the retry policy module is the
   *    authority on whether a failure is the *provider's* fault, and it passes
   *    `cooldown: error.retryable`. That is what makes a `400 model_unavailable`
   *    park exactly like a `404 model_not_found`: same semantics, different status;
   * 3. otherwise the default status list applies.
   *
   * @param {string} provider
   * @param {string} model
   * @param {{status?: number, retryAfterMs?: number, cooldown?: boolean}} [info]
   * @returns {HealthSnapshot}
   */
  recordFailure(provider, model, info = {}) {
    const key = this.#key(provider, model)
    const previous = this.#entries.get(key) ?? {
      failures: 0, successes: 0, cooldownUntil: 0, latencyEwma: null, invalid: false, lastFailureAt: 0,
    }
    const failures = previous.failures + 1
    const status = finiteNonNegative(info.status)
    const invalid = previous.invalid || status === 401 || status === 403
    const explicit = typeof info.cooldown === 'boolean' ? info.cooldown : undefined
    // The policy decision. The credential rule is OR-ed in *after* the `&&` rather
    // than folded into it, because suppressing policy must never leave a rejected
    // key in rotation — `cooldown: false` is only ever meant to say "this failure
    // is not the provider's fault", not "ignore a 401".
    const shouldCool = info.cooldown !== false && (
      invalid || (explicit ?? (
        status === undefined // transport failure / timeout
        || status === 408 || status === 409 || status === 410 || status === 422 || status === 404
        || status === 429 || status >= 500
      ))
    )
    const cools = shouldCool || invalid
    let cooldownUntil = previous.cooldownUntil
    if (cools) {
      const retryAfter = finiteNonNegative(info.retryAfterMs)
      const ladderStep = this.cooldownLadder[Math.min(failures - 1, this.cooldownLadder.length - 1)]
      const duration = invalid
        ? Math.max(retryAfter ?? 0, INVALID_CREDENTIAL_COOLDOWN_MS)
        : retryAfter !== undefined && retryAfter > 0
          ? retryAfter
          : ladderStep
      cooldownUntil = this.now() + duration
    }
    const entry = {
      failures,
      successes: previous.successes,
      cooldownUntil,
      latencyEwma: previous.latencyEwma,
      invalid,
      lastFailureAt: this.now(),
    }
    this.#entries.set(key, entry)
    return this.snapshot(provider, model)
  }

  /**
   * Record that a provider's credential was rejected, so the whole provider is
   * parked without pretending the model is at fault.
   * @param {string} provider
   * @param {string} model
   * @param {{status?: number}} [info]
   * @returns {HealthSnapshot}
   */
  recordInvalidCredential(provider, model, info = {}) {
    return this.recordFailure(provider, model, { ...info, status: info.status ?? 401, cooldown: true })
  }

  /** Every tracked route, keyed by `provider\u0000model`. */
  get size() {
    return this.#entries.size
  }

  /**
   * Serialize the tracker.
   * @returns {{version: number, entries: Record<string, HealthSnapshot>}}
   */
  toJSON() {
    /** @type {Record<string, Record<string, unknown>>} */
    const entries = {}
    for (const [key, entry] of [...this.#entries.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      entries[key] = { ...entry }
    }
    return { version: 1, failureHalfLifeMs: this.failureHalfLifeMs, entries }
  }

  /**
   * Restore a tracker from {@link toJSON} output. Anything unusable is dropped
   * rather than thrown on: a corrupt cache must not take the plugin down.
   * @param {unknown} data
   * @param {object} [opts] same options as the constructor
   * @returns {HealthTracker}
   */
  static fromJSON(data, opts = {}) {
    const tracker = new HealthTracker(opts)
    const record = typeof data === 'object' && data !== null ? /** @type {any} */ (data) : {}
    const entries = typeof record.entries === 'object' && record.entries !== null ? record.entries : {}
    for (const [key, value] of Object.entries(entries)) {
      if (typeof key !== 'string' || !key.includes(SEPARATOR)) continue
      if (typeof value !== 'object' || value === null) continue
      const entry = /** @type {any} */ (value)
      tracker.#entries.set(key, {
        failures: finiteNonNegative(entry.failures) ?? 0,
        successes: finiteNonNegative(entry.successes) ?? 0,
        cooldownUntil: finiteNonNegative(entry.cooldownUntil) ?? 0,
        latencyEwma: finiteNonNegative(entry.latencyEwma) ?? null,
        invalid: entry.invalid === true,
        lastFailureAt: finiteNonNegative(entry.lastFailureAt) ?? 0,
      })
    }
    return tracker
  }

  /** Drop all tracked state. */
  reset() {
    this.#entries.clear()
  }
}
