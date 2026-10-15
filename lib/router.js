/**
 * Candidate ranking for the direct routing engine.
 *
 * ## Purity
 *
 * This module has **no imports and no ambient inputs**: no clock, no environment,
 * no randomness, no I/O. Everything it needs — the tier, the estimated tokens,
 * the capability gates, the health snapshots and even "now" — arrives in its
 * argument. The same input therefore always yields byte-identical output, which
 * is what makes routing reproducible and testable offline.
 *
 * ## Scoring
 *
 * ```
 * base   = wCapability · capabilityNorm + wSpeed · speedNorm
 * score  = base · failureFactor · latencyFactor + preferredBonus
 * ```
 *
 * The tier decides the weights, and that is the user-facing promise:
 *
 * | tier | capability | speed | meaning |
 * |---|---|---|---|
 * | `simple` | 0.25 | 0.75 | prefer the fastest model that can do it |
 * | `medium` | 0.50 | 0.50 | balanced |
 * | `complex` | 0.80 | 0.20 | prefer the strongest model, latency be damned |
 *
 * Capability and speed are normalised from the catalog's 1–5 scale with
 * `(value - 1) / 4`, so 5 → 1.0 and 2 → 0.25.
 *
 * Health enters multiplicatively so a penalised candidate can never leapfrog a
 * strictly better one that is equally healthy. Latency is judged **relative to
 * the fastest available candidate**, because absolute time-to-first-byte varies by
 * two orders of magnitude across free providers (GLM ≈ 41 s, NVIDIA minutes) and
 * any absolute threshold would either exclude everything or nothing.
 *
 * @module dsh-freellmapi/router
 */

/** Per-tier capability/speed weights. Exported so callers can log or override them. */
export const TIER_WEIGHTS = Object.freeze({
  simple: Object.freeze({ capability: 0.25, speed: 0.75 }),
  medium: Object.freeze({ capability: 0.5, speed: 0.5 }),
  complex: Object.freeze({ capability: 0.8, speed: 0.2 }),
})

/** Multiplier applied per consecutive recorded failure. */
const FAILURE_PENALTY_PER_HIT = 0.15

/** A candidate is never penalised below this fraction of its base score for health. */
const MIN_HEALTH_FACTOR = 0.4

/** A candidate is never penalised below this fraction of its base score for latency. */
const MIN_LATENCY_FACTOR = 0.85

/**
 * Below this observed spread (milliseconds) the latency signal is treated as noise
 * and dropped entirely. See the note in `evaluate()`.
 */
const LATENCY_NOISE_FLOOR_MS = 100

/** Maximum bonus awarded to a provider listed in `preferredOrder`. */
const PREFERRED_BONUS = 0.05

/**
 * Defaults for a candidate whose `caps` are missing or malformed.
 *
 * A local copy of `lib/providers.js::CONSERVATIVE_CAPS` rather than an import:
 * this module must stay **import-free** so that it cannot acquire an I/O
 * dependency by accident (a test asserts the absence of any import statement).
 * The values are the same conservative ones the pool uses, so an under-declared
 * model is merely ranked lower and never offered a request it cannot serve.
 */
const CONSERVATIVE_CAPS = Object.freeze({
  capability: 3,
  speed: 3,
  contextWindow: 32_768,
})

/** @param {unknown} value @returns {Record<string, any> | null} */
function asObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : null
}

/** @param {unknown} value @returns {number | undefined} */
function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Clamp into `[min, max]`. */
function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value
}

/** Map the catalog's 1–5 scale onto `[0, 1]`. */
function normaliseRating(value) {
  const rating = finiteNumber(value)
  if (rating === undefined) return 0.5
  return clamp((clamp(rating, 1, 5) - 1) / 4, 0, 1)
}

/**
 * Resolve the capability/speed weights for one tier.
 * @param {string} tier
 * @param {unknown} weights `{capability, speed}` or `{simple: {...}, medium: {...}, complex: {...}}`
 * @returns {{capability: number, speed: number}}
 */
function resolveWeights(tier, weights) {
  const base = TIER_WEIGHTS[tier] ?? TIER_WEIGHTS.medium
  const record = asObject(weights)
  if (record === null) return base
  const scoped = asObject(record[tier]) ?? record
  const capability = finiteNumber(scoped.capability)
  const speed = finiteNumber(scoped.speed)
  const resolved = {
    capability: capability === undefined || capability < 0 ? base.capability : capability,
    speed: speed === undefined || speed < 0 ? base.speed : speed,
  }
  if (resolved.capability + resolved.speed === 0) return base
  return resolved
}

/** Round to three decimals, so `reasons` stay stable and readable. */
function ratio(value) {
  return Math.round(value * 1000) / 1000
}

/**
 * Evaluate every candidate exactly once, splitting it into a ranked list and the
 * candidates a hard gate removed.
 *
 * @param {Record<string, any>} input
 * @returns {{ranked: Record<string, any>[], excluded: {provider: string, model: string, reason: string}[]}}
 */
function evaluate(input) {
  const source = asObject(input) ?? {}
  const requestedTier = typeof source.tier === 'string' && source.tier.length > 0 ? source.tier : 'medium'
  // Normalising up front keeps the reasons honest: an unknown tier is routed as
  // `medium`, so it must also be *described* as medium.
  const tier = Object.hasOwn(TIER_WEIGHTS, requestedTier) ? requestedTier : 'medium'
  const tokens = finiteNumber(source.tokens) ?? 0
  // The token count is a heuristic and it undercounts; see `contextSafetyFactor`
  // in `lib/config.js`. A candidate must hold the estimate *plus* the margin.
  const requestedSafety = finiteNumber(source.safetyFactor)
  const safetyFactor = requestedSafety === undefined || requestedSafety < 1 ? 1 : requestedSafety
  const needsVision = source.needsVision === true
  const needsTools = source.needsTools === true
  // An absolute floor beside the relative `tokens * safetyFactor` gate. A caller
  // that *knows* a request is inherently large — DSH's context-summarisation call
  // carries the whole history it is about to compress — must not have that
  // request routed to a model that provably cannot hold it, no matter how small
  // the estimate happens to come out. See `compactionMinContextWindow`.
  const requestedFloor = finiteNumber(source.minContextWindow)
  const minContextWindow = requestedFloor === undefined || requestedFloor <= 0 ? 0 : requestedFloor
  const now = finiteNumber(source.now)
  const weights = resolveWeights(tier, source.weights)
  const preferredOrder = Array.isArray(source.preferredOrder)
    ? source.preferredOrder.filter((entry) => typeof entry === 'string' && entry.length > 0)
    : []
  const preferredIndex = (provider) => {
    const index = preferredOrder.indexOf(provider)
    return index === -1 ? -1 : index
  }

  const candidates = Array.isArray(source.candidates) ? source.candidates : []
  /** @type {Record<string, any>[]} */
  const usable = []
  /** @type {{provider: string, model: string, reason: string}[]} */
  const excluded = []

  for (const candidate of candidates) {
    const record = asObject(candidate)
    if (record === null) continue
    const provider = typeof record.provider === 'string' ? record.provider : ''
    const model = typeof record.model === 'string' ? record.model : ''
    if (provider.length === 0 || model.length === 0) continue
    // `caps` is the only place a malformed candidate could hurt: a `null`, a
    // scalar or an object missing `contextWindow` must degrade to conservative
    // defaults, never throw and never be *silently* dropped. A candidate that
    // genuinely cannot serve the request is excluded with a reason that says why.
    const declared = asObject(record.caps)
    const caps = {
      capability: finiteNumber(declared?.capability) ?? CONSERVATIVE_CAPS.capability,
      speed: finiteNumber(declared?.speed) ?? CONSERVATIVE_CAPS.speed,
      contextWindow: finiteNumber(declared?.contextWindow) ?? CONSERVATIVE_CAPS.contextWindow,
      vision: declared?.vision === true,
      toolCalling: declared?.toolCalling === true,
    }
    const contextWindowAssumed = finiteNumber(declared?.contextWindow) === undefined
    const health = asObject(record.health) ?? {}

    if (needsVision && caps.vision !== true) {
      excluded.push({ provider, model, reason: 'the request carries an image but this model declares vision=false' })
      continue
    }
    if (needsTools && caps.toolCalling !== true) {
      excluded.push({ provider, model, reason: 'the request declares tools but this model declares toolCalling=false' })
      continue
    }
    const requiredContextWindow = Math.max(tokens * safetyFactor, minContextWindow)
    if (requiredContextWindow > caps.contextWindow) {
      excluded.push({
        provider,
        model,
        reason: minContextWindow > tokens * safetyFactor
          // Naming the floor separately matters: "this model is too small for a
          // summary call" is a different, actionable fact from "this model is too
          // small for your request".
          ? `the ${caps.contextWindow}-token context window is below the ${minContextWindow}-token floor this request requires (it carries a context to be summarised)`
          : `estimated ${tokens} tokens, plus a ${safetyFactor}x safety margin, exceed the ${caps.contextWindow}-token context window`
            + `${contextWindowAssumed ? ' (the provider declares none, so a conservative default is assumed)' : ''}`,
      })
      continue
    }
    if (now !== undefined) {
      const cooldownUntil = finiteNumber(health.cooldownUntil) ?? 0
      if (cooldownUntil > now) {
        const seconds = Math.max(1, Math.round((cooldownUntil - now) / 1000))
        const cause = health.invalid === true ? 'a rejected credential' : `${health.failures ?? 0} failure(s)`
        excluded.push({ provider, model, reason: `cooling down for another ${seconds}s after ${cause}` })
        continue
      }
    }
    // Only the normalized fields go through; spreading `record` last used to
    // overwrite them with the raw values (a `caps: null` candidate reached the
    // scorer as `null`).
    usable.push({ provider, model, caps, health, contextWindowAssumed })
  }

  // Latency is only meaningful relative to the other candidates in this request,
  // and only when the observed spread is bigger than measurement noise.
  let fastest = Number.POSITIVE_INFINITY
  let slowestMeasured = 0
  for (const candidate of usable) {
    const latency = finiteNumber(candidate.health?.latencyEwma)
    if (latency === undefined || latency <= 0) continue
    if (latency < fastest) fastest = latency
    if (latency > slowestMeasured) slowestMeasured = latency
  }
  // Two localhost mocks measured at 4 ms and 26 ms differ by a factor of six and
  // by nothing at all: the ratio of two sub-100 ms samples is warm-up, not
  // throughput. Ranking on that would be ranking on noise — and it silently
  // demotes whichever candidate happened to answer first. Below the floor the
  // whole signal is dropped, so every candidate scores as unmeasured.
  const latencyIsInformative = Number.isFinite(fastest) && (slowestMeasured - fastest) >= LATENCY_NOISE_FLOOR_MS

  /**
   * The latency factor for a candidate with **no usable measurement**.
   *
   * It must not be 1: a perfect score for "we know nothing" means a candidate
   * with real evidence of being slow loses to one that has never been observed,
   * which is exactly backwards. The neutral value is the **slowest factor we
   * actually measured for this request** — "without evidence, assume you are no
   * faster than the slowest thing we have seen". When nothing has been measured
   * (or nothing measurable) there is no evidence to rank against, so every
   * candidate gets 1 and latency simply does not participate.
   */
  const measuredFactors = []
  if (latencyIsInformative) {
    for (const candidate of usable) {
      const latency = finiteNumber(candidate.health?.latencyEwma)
      if (latency === undefined || latency <= 0) continue
      measuredFactors.push(clamp(fastest / latency, MIN_LATENCY_FACTOR, 1))
    }
  }
  const neutralLatencyFactor = measuredFactors.length === 0 ? 1 : Math.min(...measuredFactors)

  const ranked = usable.map((candidate) => {
    const caps = candidate.caps
    const health = candidate.health ?? {}
    const capabilityNorm = normaliseRating(caps.capability)
    const speedNorm = normaliseRating(caps.speed)
    const base = weights.capability * capabilityNorm + weights.speed * speedNorm

    const failures = finiteNumber(health.effectiveFailures) ?? finiteNumber(health.failures) ?? 0
    const failureFactor = clamp(1 / (1 + FAILURE_PENALTY_PER_HIT * failures), MIN_HEALTH_FACTOR, 1)

    const latency = finiteNumber(health.latencyEwma)
    const measured = latencyIsInformative && latency !== undefined && latency > 0
    const latencyFactor = measured ? clamp(fastest / latency, MIN_LATENCY_FACTOR, 1) : neutralLatencyFactor

    const orderIndex = preferredIndex(candidate.provider)
    const preferredBonus = orderIndex === -1
      ? 0
      : PREFERRED_BONUS * (1 - orderIndex / Math.max(1, preferredOrder.length))

    const score = base * failureFactor * latencyFactor + preferredBonus

    const reasons = [
      `${tier} tier weights: capability ${weights.capability} / speed ${weights.speed}`,
      `capability ${caps.capability ?? '?'}/5`,
      `speed ${caps.speed ?? '?'}/5`,
    ]
    if (measured && latency !== undefined) {
      reasons.push(latency <= fastest
        ? `latency ${Math.round(latency)}ms (fastest measured)`
        : `latency ${Math.round(latency)}ms (${ratio(fastest / latency)}x of the fastest)`)
    } else if (latency !== undefined && latency > 0) {
      reasons.push(`latency ${Math.round(latency)}ms (spread below the ${LATENCY_NOISE_FLOOR_MS}ms noise floor, so latency is ignored)`)
    } else {
      reasons.push(`latency never measured (neutral factor ${ratio(neutralLatencyFactor)})`)
    }
    if (failures > 0) {
      const raw = finiteNumber(health.failures) ?? 0
      reasons.push(raw > failures
        ? `${raw} recent failure(s), decayed to ${ratio(failures)}`
        : `${raw} recent failure(s)`)
    }
    if ((finiteNumber(health.successes) ?? 0) > 0) reasons.push(`${health.successes} recorded success(es)`)
    if (candidate.contextWindowAssumed === true) reasons.push('no context window declared; a conservative default is assumed')
    if (orderIndex !== -1) reasons.push(`preferred order #${orderIndex + 1}`)
    reasons.push(`score ${ratio(score)}`)

    return { provider: candidate.provider, model: candidate.model, score, reasons }
  })

  ranked.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    const leftOrder = preferredIndex(left.provider)
    const rightOrder = preferredIndex(right.provider)
    const leftRank = leftOrder === -1 ? Number.POSITIVE_INFINITY : leftOrder
    const rightRank = rightOrder === -1 ? Number.POSITIVE_INFINITY : rightOrder
    if (leftRank !== rightRank) return leftRank - rightRank
    if (left.provider !== right.provider) return left.provider < right.provider ? -1 : 1
    return left.model < right.model ? -1 : left.model > right.model ? 1 : 0
  })

  return { ranked, excluded }
}

/**
 * Rank the candidate models for one request, best first.
 *
 * Candidates removed by a hard gate (vision, tool calling, context window,
 * active cooldown) are **not** included; use {@link explainExclusions} to report
 * why they were dropped.
 *
 * @param {{
 *   tier?: string,
 *   tokens?: number,
 *   needsVision?: boolean,
 *   needsTools?: boolean,
 *   now?: number,
 *   candidates?: readonly Record<string, any>[],
 *   weights?: unknown,
 *   preferredOrder?: readonly string[],
 * }} input
 * @returns {{provider: string, model: string, score: number, reasons: string[]}[]} best first
 */
export function rankCandidates(input) {
  return evaluate(input).ranked
}

/**
 * Why candidates were removed from the ranking, in input order.
 * @param {Parameters<typeof rankCandidates>[0]} input
 * @returns {{provider: string, model: string, reason: string}[]}
 */
export function explainExclusions(input) {
  return evaluate(input).excluded
}
