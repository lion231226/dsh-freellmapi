/**
 * The only module in this plugin that performs provider I/O for direct mode.
 *
 * ## The one hard invariant
 *
 * **Failover may only happen before a single chunk has reached DSH.**
 *
 * Once any chunk has been yielded — even a bare `block-start` — two providers'
 * output would be spliced into one assistant message if we switched: the client
 * would see text from model A followed by text from model B as if one model wrote
 * it. So:
 *
 * - {@link dispatchOnce} **throws** for every failure that happens before the
 *   first chunk (transport, timeout, non-2xx), which is the only signal the
 *   failover loop is allowed to act on;
 * - {@link dispatchOnce} **never throws** after the first chunk: a mid-stream
 *   failure is translated into a terminal `finish {kind:'error'}` chunk and the
 *   generator returns;
 * - {@link dispatchWithFailover} re-checks the same condition independently
 *   (`emittedHere`) before continuing to the next candidate, so a future change
 *   to the inner function cannot silently reintroduce the splice.
 *
 * @module dsh-freellmapi/dispatch
 */

import { attributionHeaders } from './runtime.js'
import { assertSupportedOptions, buildChatRequest, collectImageParts, suppressedReasoningEffort } from './wire.js'
import { classifyFrame } from './frames.js'
import { decodeSseBody } from './sse.js'
import { ChunkTranslator } from './translate.js'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  MODEL_UNAVAILABLE_CODE,
  describeHttpFailure,
  describeTransportFailure,
  describeUnknown,
  retryAfterMs,
} from './errors.js'
import { keyEntryPoints } from './providers.js'

/** HTTP statuses that mean "try another provider", matching the gateway's own exhaustion set. */
const RETRYABLE_STATUSES = Object.freeze([404, 408, 409, 410, 422, 429])

/** Package name used in diagnostics. */
const PACKAGE = 'dsh-freellmapi'

/** Failure code used when every candidate was tried and all of them failed. */
export const ALL_CANDIDATES_FAILED_CODE = 'ALL_CANDIDATES_FAILED'

/** Failure code used when the pool produced no candidate at all. */
export const NO_CANDIDATES_CODE = 'NO_CANDIDATES'

/** Failure code used if a stream fails after output had already been emitted. */
export const STREAM_INTERRUPTED_CODE = 'STREAM_INTERRUPTED'

/** @param {unknown} value @returns {Record<string, any> | null} */
function asObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : null
}

/** @param {unknown} value @param {number} fallback */
function positiveInteger(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number.NaN
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

/** @param {unknown} value @param {number} fallback */
function nonNegative(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number.NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

/**
 * A failed attempt, carrying enough structure for the failover loop to decide.
 */
export class AttemptError extends Error {
  /**
   * @param {string} message
   * @param {{provider: string, model: string, code: string, status?: number,
   *   retryAfterMs?: number, retryable?: boolean, aborted?: boolean}} info
   */
  constructor(message, info) {
    super(message)
    this.name = 'AttemptError'
    this.provider = info.provider
    this.model = info.model
    this.code = info.code
    this.status = info.status
    this.retryAfterMs = info.retryAfterMs
    /** Whether another candidate may be tried for this request. */
    this.retryable = info.retryable === true
    this.aborted = info.aborted === true
  }
}

/**
 * Whether a failed attempt justifies trying the next candidate.
 *
 * The rule is about *whose problem it is*: a rate limit, a timeout, a server
 * error, a per-model outage or a wrong model id belongs to one provider and the
 * next one may well succeed; a malformed request or a rejected credential does
 * not, and retrying it would only multiply the latency of a certain failure.
 *
 * `model_unavailable` is the deliberate exception to "400 means bad request":
 * aggregators rotate their catalog continuously, so the same model id can answer
 * 200 today and `400 model_unavailable` tomorrow — the Lead's live probe caught
 * exactly that on `llm7`. `404` is retryable for the same reason (it usually means
 * "this provider does not serve that id"), which also matches freellmapi's own
 * exhaustion set (`429/502/413/404/503`).
 *
 * @param {number | undefined} status
 * @param {string | undefined} code
 * @returns {boolean}
 */
export function isRetryableStatus(status, code) {
  if (status === 401 || status === 403) return false
  if (code === 'AUTH' || code === 'INVALID_CREDENTIAL') return false
  // The deliberate exception to "400 means a malformed request".
  if (code === MODEL_UNAVAILABLE_CODE) return true
  // A context overflow is also a *per-candidate* condition rather than a bad
  // request: it means this model cannot hold the prompt, and a wider one in the
  // pool may. The loop additionally requires the next candidate to be strictly
  // wider (`minimumContextWindow`), so this cannot turn into "retry everywhere".
  if (code === CONTEXT_WINDOW_EXCEEDED_CODE) return true
  if (status === 400) return false
  if (status !== undefined && RETRYABLE_STATUSES.includes(status)) return true
  return status !== undefined && status >= 500
}

/** Combine the caller's signal with the configured request timeout. */
function requestSignal(signal, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { signal, timedOut: () => false, dispose: () => {} }
  }
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  if (typeof timer.unref === 'function') timer.unref()
  const combined = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
  return { signal: combined, timedOut: () => timedOut, dispose: () => clearTimeout(timer) }
}

/** Turn any thrown value into an in-band failure without leaking a stack trace. */
function failureOf(error) {
  const record = asObject(error)
  const failure = asObject(record?.failure)
  if (typeof failure?.message === 'string' && typeof failure.code === 'string') return failure
  if (typeof record?.code === 'string' && record.code.length > 0) {
    return { message: error instanceof Error ? error.message : describeUnknown(record.message, 'failure with no message'), code: record.code }
  }
  return {
    message: `dsh-freellmapi: ${error instanceof Error ? error.message : describeUnknown(error, 'unknown failure')}`,
    code: 'UNKNOWN',
  }
}

/** Read and classify one non-2xx response. */
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
    provider: input.provider,
    sentApiKey: input.sentApiKey,
    headers: response.headers,
  })
  const retryAfter = retryAfterMs(response.headers)
  return retryAfter === undefined ? failure : { ...failure, providerRetryAfterMs: retryAfter }
}

/**
 * Perform **exactly one** attempt against one target.
 *
 * @param {Record<string, any>} options the DSH `GenerateOptions`
 * @param {{provider: string, model: string, caps?: Record<string, any>, apiKey?: string,
 *   baseURL: string, extraBody?: Record<string, any>, extraHeaders?: Record<string, string>}} target
 * @param {{config?: Record<string, any>, fetchImpl?: typeof fetch,
 *   readImage?: (ref: Record<string, unknown>) => Promise<string | undefined>,
 *   signal?: AbortSignal}} [deps]
 * @returns {AsyncGenerator<Record<string, any>>} DSH stream chunks
 * @throws {AttemptError} only before the first chunk was produced
 */
export async function* dispatchOnce(options, target, deps = {}) {
  const config = asObject(deps.config) ?? {}
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const baseURL = String(target?.baseURL ?? '').replace(/\/+$/, '')
  const provider = String(target?.provider ?? '')
  const model = String(target?.model ?? '')
  const signal = deps.signal
  const timing = requestSignal(signal, config.timeoutMs)
  const translator = new ChunkTranslator()
  let emitted = false

  try {
    const imageParts = await collectImageParts(options, deps.readImage ?? (async () => undefined))
    const body = buildChatRequest(options, config, { imageParts })
    // A control DSH set that we will not forward must leave a trace, or it is a
    // silent degradation. This is the observable half of `suppressedReasoningEffort`.
    const droppedEffort = suppressedReasoningEffort(options, config)
    if (droppedEffort !== undefined) {
      deps.onSuppressedControl?.({
        control: 'reasoningEffort',
        value: droppedEffort,
        reason: 'the pool has no verified support for `reasoning_effort`; set config.forwardReasoningEffort to send it anyway',
      })
    }
    // ★ `options.model` is the **DSH routing id** the picker advertised (`auto`,
    // `auto:simple`, …) or the composite catalog id (`provider/model`). Neither is
    // a model any provider serves: the first would be a 404 everywhere, the second
    // a 404 wherever the id contains a slash. `target.model` is the id the selected
    // provider actually answers for, so it is what goes on the wire.
    //
    // This assignment must stay *before* the `extraBody` merge: a provider
    // declaration is still allowed to rewrite `model` (some gateways need an alias),
    // and putting the merge second preserves that.
    body.model = model
    if (asObject(target?.extraBody) !== null) Object.assign(body, target.extraBody)

    const headers = {
      // Mandatory harness attribution, first expansion so nothing can drop it.
      ...attributionHeaders(),
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...typeof target?.apiKey === 'string' && target.apiKey.length > 0
        ? { authorization: `Bearer ${target.apiKey}` }
        : {},
      ...asObject(config.headers) ?? {},
      ...asObject(target?.extraHeaders) ?? {},
    }

    let response
    try {
      response = await fetchImpl(`${baseURL}/chat/completions`, {
        method: 'POST',
        redirect: 'error',
        signal: timing.signal,
        headers,
        body: JSON.stringify(body),
      })
    } catch (error) {
      if (signal?.aborted === true) {
        throw new AttemptError('dsh-freellmapi: the caller aborted the request', {
          provider, model, code: 'ABORTED', aborted: true, retryable: false,
        })
      }
      const failure = describeTransportFailure(error, { baseURL, model, timedOut: timing.timedOut() })
      throw new AttemptError(failure.message, {
        provider, model, code: failure.code, retryable: true,
      })
    }

    if (!response.ok) {
      const failure = await httpFailure(response, {
        model, baseURL, provider, sentApiKey: typeof target?.apiKey === 'string' && target.apiKey.length > 0,
      })
      throw new AttemptError(failure.message, {
        provider,
        model,
        code: failure.code,
        status: response.status,
        retryAfterMs: failure.providerRetryAfterMs,
        retryable: isRetryableStatus(response.status, failure.code),
      })
    }
    if (response.body === null || response.body === undefined) {
      throw new AttemptError(
        `dsh-freellmapi: provider "${provider}" returned ${response.status} with an empty body; a streaming response was expected [model=${model}]`,
        { provider, model, code: 'EMPTY_RESPONSE', status: response.status, retryable: true },
      )
    }

    // Past this point a chunk may reach DSH, so every failure below stays in band.
    for await (const event of decodeSseBody(response.body)) {
      if (signal?.aborted === true) {
        for (const chunk of translator.finish({
          kind: 'aborted',
          failure: { message: 'dsh-freellmapi: the caller aborted the request', code: 'ABORTED' },
        })) {
          emitted = true
          yield chunk
        }
        return
      }
      for (const chunk of translator.push(classifyFrame(event.data))) {
        emitted = true
        yield chunk
      }
    }
    for (const chunk of translator.finish()) {
      emitted = true
      yield chunk
    }
  } catch (error) {
    if (error instanceof AttemptError) throw error
    if (!emitted) {
      const failure = failureOf(error)
      throw new AttemptError(failure.message, {
        provider, model, code: failure.code, retryable: true,
      })
    }
    // Already streamed: terminate in band. Never rethrow — the caller must not
    // interpret this as permission to try another provider.
    for (const chunk of translator.finish({ kind: 'error', failure: failureOf(error) })) yield chunk
  } finally {
    timing.dispose()
  }
}

/** Build the terminal error chunk. */
function terminalError(failure) {
  return { type: 'finish', reason: { kind: 'error', failure } }
}

/** The diagnosis when the pool produced nothing to try. */
function noCandidatesFailure(plan, exclusions, config) {
  // If the pool is empty because the request is bigger than everything in it, the
  // generic "configure a provider" advice is useless: no provider would help.
  const tokens = Number.isFinite(plan?.tokens) ? Math.trunc(plan.tokens) : 0
  const poolMax = Number.isFinite(plan?.poolMaxContextWindow) ? Math.trunc(plan.poolMaxContextWindow) : 0
  if (tokens > 0 && poolMax > 0 && tokens > poolMax) {
    return contextOverflowFailure(plan, 0, [])
  }
  const reasons = []
  if (plan?.needsVision === true) {
    reasons.push('the request contains an image but no available model declares vision support')
    // Enumerate every vision-capable candidate in the pool so the user can see
    // which models declare vision and why each could not serve this request.
    const visionCandidates = (Array.isArray(plan?.ranked) ? plan.ranked : []).filter(
      (c) => (c.caps ?? {}).vision === true
    )
    if (visionCandidates.length > 0) {
      reasons.push('vision-capable candidates: ' + visionCandidates.map((c) => {
        const hasKey = typeof c.apiKey === 'string' && c.apiKey.length > 0
        return `${c.provider}/${c.model} — ${hasKey ? 'key present, all attempts failed' : 'key missing (' + (c.apiKeyEnv ?? 'apiKeyEnv') + ')'}`
      }).join('; '))
    } else {
      reasons.push('no vision-capable model is in the pool')
    }
  } else if (plan?.needsTools === true) {
    reasons.push('the request declares tools but no available model declares tool calling')
  }
  if (exclusions.length > 0) reasons.push(`every candidate was excluded: ${exclusions.slice(0, 4).join('; ')}`)
  reasons.push('no provider is configured or reachable for this request')
  // The entry points come from the provider pool itself — the same `keyURL` the
  // model picker shows. A second hardcoded copy here is how `cerebras` ended up
  // with a URL in one table and `null` in the other.
  //
  // Quote what the *user's* pool offers; if they have disabled every provider (the
  // most common way to reach this diagnosis) fall back to the shipped defaults so
  // the message still says where to start.
  const configured = keyEntryPoints(config)
  const entryPoints = (configured.length > 0 ? configured : keyEntryPoints(undefined))
    .slice(0, 5)
    .map((entry) => `${entry.displayName} ${entry.keyURL}`)
  const tail = entryPoints.length > 0
    ? `to add a keyed provider set one of: ${entryPoints.join(', ')}.`
    : 'to add a keyed provider, set its API key environment variable.'
  return {
    code: NO_CANDIDATES_CODE,
    message: `dsh-freellmapi: ${reasons.join('. ')}. `
      + `The keyless providers (Kilo, LLM7, OVH) work with no key at all; ${tail}`,
  }
}

/**
 * The diagnosis when every candidate was either too small or refused the request
 * for being too large.
 *
 * The user needs two numbers to act: how big their request is, and how big the
 * biggest model they could reach is. Everything else is generic advice.
 *
 * @param {Record<string, any>} plan
 * @param {{provider: string, model: string, code?: string}[]} attempts
 * @param {number} refusedUpTo the widest window that already refused the request
 */
function contextOverflowFailure(plan, refusedUpTo, attempts) {
  const tokens = Number.isFinite(plan?.tokens) ? Math.trunc(plan.tokens) : undefined
  const poolMax = Number.isFinite(plan?.poolMaxContextWindow) ? Math.trunc(plan.poolMaxContextWindow) : undefined
  const poolModel = typeof plan?.poolMaxContextModel === 'string' ? plan.poolMaxContextModel : undefined
  const widest = Math.max(refusedUpTo ?? 0, ...attempts.map((entry) => Number(entry.contextWindow) || 0))
  const trail = attempts
    .filter((entry) => entry.code !== undefined)
    .map((entry) => `${entry.provider}/${entry.model} → ${entry.code}`)
    .slice(0, 4)
    .join('; ')

  const parts = [`${PACKAGE}: this request does not fit any model the router can use`]
  if (tokens !== undefined) parts.push(`it is about ${tokens} estimated input tokens`)
  if (widest > 0) parts.push(`the widest model that refused it declares ${widest} tokens`)
  if (poolMax !== undefined && poolMax > 0) {
    parts.push(`the largest context window in the pool is ${poolMax}${poolModel === undefined ? '' : ` (${poolModel})`}`)
  }
  parts.push('compact the session or lower the attached history, then retry')
  const message = `${parts.join('; ')}.`
  return {
    code: CONTEXT_WINDOW_EXCEEDED_CODE,
    message: trail.length === 0 ? message : `${message} — [${trail}]`,
  }
}

/** A target's declared context window, or 0 when it declares none. */
function contextWindowOf(target) {
  const value = target?.caps?.contextWindow
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** The diagnosis when every attempted candidate failed. */
function exhaustedFailure(plan, attempts, why) {
  const trail = attempts.map((attempt) => `${attempt.provider}/${attempt.model} → ${attempt.code ?? 'failed'}`)
  return {
    code: ALL_CANDIDATES_FAILED_CODE,
    message: `dsh-freellmapi: all ${attempts.length} candidate(s) failed for tier=${plan?.tier ?? 'unknown'} after ${why}`
      + `${trail.length === 0 ? '' : ` — ${trail.join('; ')}`}`,
  }
}

/**
 * Route one request across the ranked candidates, failing over until one of them
 * starts streaming.
 *
 * Never throws: every outcome is a terminal `finish` chunk.
 *
 * @param {Record<string, any>} options the DSH `GenerateOptions`
 * @param {{tier?: string, score?: number, needsVision?: boolean, needsTools?: boolean,
 *   ranked?: readonly Record<string, any>[], exclusions?: readonly string[],
 *   complexityReasons?: readonly string[]}} plan
 * @param {{config?: Record<string, any>, fetchImpl?: typeof fetch,
 *   readImage?: (ref: Record<string, unknown>) => Promise<string | undefined>,
 *   signal?: AbortSignal, health?: import('./health.js').HealthTracker,
 *   now?: () => number, onRoute?: (record: Record<string, any>) => void}} [deps]
 * @returns {AsyncGenerator<Record<string, any>>} DSH stream chunks
 */
export async function* dispatchWithFailover(options, plan, deps = {}) {
  const config = asObject(deps.config) ?? {}
  const routing = asObject(config.routing) ?? {}
  const maxAttempts = positiveInteger(routing.maxAttempts, 6)
  const budgetMs = nonNegative(routing.budgetMs, 45_000)
  const health = deps.health
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const targets = Array.isArray(plan?.ranked) ? plan.ranked : []
  const startedAt = now()
  /** @type {{provider: string, model: string, code?: string}[]} */
  const attempts = []
  /** @type {Record<string, any> | undefined} */
  let selected

  try {
    // A request control this adapter cannot honour is reported once, before any
    // provider is contacted, and never retried.
    try {
      assertSupportedOptions(options)
    } catch (error) {
      yield terminalError(failureOf(error))
      return
    }

    if (targets.length === 0) {
      yield terminalError(noCandidatesFailure(plan, Array.isArray(plan?.exclusions) ? plan.exclusions : [], deps?.config))
      return
    }

    // Failing over after a context overflow is only meaningful towards a *wider*
    // model: retrying the same request against a model with a smaller window
    // cannot succeed. This records the widest window that has already refused the
    // request so the loop can skip everything at or below it.
    let minimumContextWindow = 0

    for (const target of targets) {
      if (attempts.length >= maxAttempts) {
        yield terminalError(exhaustedFailure(plan, attempts, `the attempt limit of ${maxAttempts}`))
        return
      }
      if (budgetMs > 0 && now() - startedAt >= budgetMs) {
        yield terminalError(exhaustedFailure(plan, attempts, `the ${budgetMs}ms time budget`))
        return
      }
      if (deps.signal?.aborted === true) {
        yield terminalError({ message: 'dsh-freellmapi: the caller aborted the request', code: 'ABORTED' })
        return
      }
      if (minimumContextWindow > 0 && contextWindowOf(target) <= minimumContextWindow) continue

      const attempt = {
        provider: String(target.provider ?? ''),
        model: String(target.model ?? ''),
        contextWindow: contextWindowOf(target),
      }
      attempts.push(attempt)
      const attemptStartedAt = now()
      let emittedHere = false
      let sawFinish = false

      try {
        for await (const chunk of dispatchOnce(options, target, deps)) {
          if (!emittedHere) {
            emittedHere = true
            selected = { ...target, reasons: target.reasons }
            health?.recordSuccess?.(attempt.provider, attempt.model, now() - attemptStartedAt)
          }
          yield chunk
          if (chunk?.type === 'finish') {
            sawFinish = true
            if (chunk.reason?.kind === 'error') {
              // The provider answered and then broke. Its output is already out,
              // so this is a data point for the next request, not a failover.
              health?.recordFailure?.(attempt.provider, attempt.model, { cooldown: false })
              attempt.code = chunk.reason?.failure?.code
            }
            return
          }
        }
        if (!sawFinish) {
          yield terminalError({
            code: 'EMPTY_RESPONSE',
            message: `dsh-freellmapi: provider "${attempt.provider}" ended the stream without a terminal chunk [model=${attempt.model}]`,
          })
          return
        }
      } catch (error) {
        const attemptError = error instanceof AttemptError
          ? error
          : new AttemptError(failureOf(error).message, {
            provider: attempt.provider, model: attempt.model, code: failureOf(error).code, retryable: true,
          })
        attempt.code = attemptError.code
        if (attemptError.aborted || deps.signal?.aborted === true) {
          yield terminalError({ message: 'dsh-freellmapi: the caller aborted the request', code: 'ABORTED' })
          return
        }
        if (attemptError.code === CONTEXT_WINDOW_EXCEEDED_CODE) {
          // The provider is healthy and the request is well-formed — it simply does
          // not fit. Parking this pair for minutes would be wrong: the same model
          // answers a shorter request perfectly well. The useful memory is the
          // window it just told us about, so the loop only tries wider models from
          // here on.
          minimumContextWindow = Math.max(minimumContextWindow, contextWindowOf(target))
        } else {
          health?.recordFailure?.(attempt.provider, attempt.model, {
            status: attemptError.status,
            retryAfterMs: attemptError.retryAfterMs,
            // The retry policy is the authority on "whose fault is this". A
            // *retryable* failure is exactly the kind that justifies parking, which
            // is what makes a `400 model_unavailable` park the pair like a
            // `404 model_not_found` does, instead of leaving it uncooled.
            cooldown: attemptError.retryable,
          })
        }
        if (emittedHere) {
          // ★ The invariant. Output already reached DSH; switching providers here
          // would splice two models into one message.
          yield terminalError({
            code: STREAM_INTERRUPTED_CODE,
            message: 'dsh-freellmapi: the upstream stream failed after output had already been sent, '
              + 'so no failover was attempted (doing so would mix two providers into one response)',
          })
          return
        }
        if (!attemptError.retryable) {
          yield terminalError({
            code: attemptError.code ?? 'INVALID_REQUEST',
            message: attemptError.message,
            ...attemptError.status === undefined ? {} : { status: attemptError.status },
          })
          return
        }
      }
    }

    // Nothing left to try. If the request was refused for being too large, say so
    // in terms of the request and the pool, not in terms of providers.
    if (attempts.some((entry) => entry.code === CONTEXT_WINDOW_EXCEEDED_CODE)) {
      yield terminalError(contextOverflowFailure(plan, minimumContextWindow, attempts))
      return
    }
    yield terminalError(exhaustedFailure(plan, attempts, 'exhausting every candidate'))
  } finally {
    deps.onRoute?.({
      mode: 'direct',
      tier: plan?.tier,
      score: plan?.score,
      requestedModel: options?.model,
      provider: selected?.provider ?? attempts.at(-1)?.provider,
      model: selected?.model ?? attempts.at(-1)?.model,
      capability: selected?.caps?.capability,
      speed: selected?.caps?.speed,
      candidateCount: attempts.length,
      attempts: attempts.map((attempt) => ({ ...attempt })),
      reasons: [...plan?.complexityReasons ?? [], ...selected?.reasons ?? []],
    })
  }
}
