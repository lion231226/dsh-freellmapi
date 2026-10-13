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
import { assertSupportedOptions, buildChatRequest, collectImageParts } from './wire.js'
import { classifyFrame } from './frames.js'
import { decodeSseBody } from './sse.js'
import { ChunkTranslator } from './translate.js'
import {
  MODEL_UNAVAILABLE_CODE,
  describeHttpFailure,
  describeTransportFailure,
  retryAfterMs,
} from './errors.js'

/** HTTP statuses that mean "try another provider", matching the gateway's own exhaustion set. */
const RETRYABLE_STATUSES = Object.freeze([404, 408, 409, 410, 422, 429])

/** Failure code used when every candidate was tried and all of them failed. */
export const ALL_CANDIDATES_FAILED_CODE = 'ALL_CANDIDATES_FAILED'

/** Failure code used when the pool produced no candidate at all. */
export const NO_CANDIDATES_CODE = 'NO_CANDIDATES'

/** Failure code used if a stream fails after output had already been emitted. */
export const STREAM_INTERRUPTED_CODE = 'STREAM_INTERRUPTED'

/** A few key-application entry points quoted in the "nothing is configured" diagnosis. */
const KEY_ENTRY_POINTS = Object.freeze([
  'Groq https://console.groq.com/keys',
  'Cerebras https://cloud.cerebras.ai/',
  'OpenRouter https://openrouter.ai/keys',
  'Mistral https://console.mistral.ai/api-keys',
  'LLM7 https://token.llm7.io/',
])

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
    return { message: error instanceof Error ? error.message : `dsh-freellmapi: ${String(record.message)}`, code: record.code }
  }
  return {
    message: `dsh-freellmapi: ${error instanceof Error ? error.message : String(error)}`,
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
function noCandidatesFailure(plan, exclusions) {
  const reasons = []
  if (plan?.needsVision === true) reasons.push('the request contains an image but no available model declares vision support')
  if (plan?.needsTools === true) reasons.push('the request declares tools but no available model declares tool calling')
  if (exclusions.length > 0) reasons.push(`every candidate was excluded: ${exclusions.slice(0, 4).join('; ')}`)
  reasons.push('no provider is configured or reachable for this request')
  return {
    code: NO_CANDIDATES_CODE,
    message: `dsh-freellmapi: ${reasons.join('. ')}. `
      + 'The keyless providers (Kilo, LLM7, OVH) work with no key at all; '
      + `to add a keyed provider set one of: ${KEY_ENTRY_POINTS.join(', ')}.`,
  }
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
      yield terminalError(noCandidatesFailure(plan, Array.isArray(plan?.exclusions) ? plan.exclusions : []))
      return
    }

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

      const attempt = { provider: String(target.provider ?? ''), model: String(target.model ?? '') }
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
        health?.recordFailure?.(attempt.provider, attempt.model, {
          status: attemptError.status,
          retryAfterMs: attemptError.retryAfterMs,
          // The retry policy is the authority on "whose fault is this". A
          // *retryable* failure is exactly the kind that justifies parking, which
          // is what makes a `400 model_unavailable` park the pair like a
          // `404 model_not_found` does, instead of leaving it uncooled.
          cooldown: attemptError.retryable,
        })
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
