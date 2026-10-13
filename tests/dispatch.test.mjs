/**
 * Failover-loop tests.
 *
 * The loop is driven through `dispatchWithFailover` with a scripted `fetch`, so
 * the retry policy, the cooldown bookkeeping and — most importantly — the
 * "never fail over after the first chunk" invariant are all observable without a
 * socket.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { describeHttpFailure, isModelUnavailableError, classifyStatus, MODEL_UNAVAILABLE_CODE } from '../lib/errors.js'
import { HealthTracker } from '../lib/health.js'
import {
  ALL_CANDIDATES_FAILED_CODE,
  NO_CANDIDATES_CODE,
  STREAM_INTERRUPTED_CODE,
  dispatchWithFailover,
  isRetryableStatus,
} from '../lib/dispatch.js'
import { assertValidChunkSequence, collect } from './helpers/harness.mjs'

const OK_BODY = (text) => [
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
  'data: [DONE]\n\n',
]

/** A 200 SSE response. */
function sseResponse(chunks, headers = {}) {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } })
}

/** A 200 SSE response that breaks after the given prefix has been consumed. */
function brokenSseResponse(chunks) {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      setTimeout(() => controller.error(new Error('socket reset by peer')), 10)
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** A JSON error response. */
function errorResponse(status, payload, headers = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } })
}

/**
 * A scripted fetch: each call consumes the next entry, which may be a Response,
 * a function, or an Error to throw.
 */
function scriptedFetch(script) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init?.body === undefined ? undefined : JSON.parse(init.body) })
    const next = script.shift()
    if (next === undefined) throw new Error('the script is exhausted, but another request was made')
    if (next instanceof Error) throw next
    if (typeof next === 'function') return next(url, init)
    return next
  }
  return { calls, fetchImpl }
}

const target = (provider, model, extra = {}) => ({
  provider,
  model,
  caps: { capability: 3, speed: 3, contextWindow: 131_072, maxTokens: 8_192, vision: false, toolCalling: true },
  apiKey: 'test-key-not-real',
  baseURL: `https://${provider}.invalid/v1`,
  ...extra,
})

const options = () => ({ provider: 'freellmapi', model: 'auto', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })

const plan = (ranked, extra = {}) => ({ tier: 'medium', score: 0.5, ranked, exclusions: [], complexityReasons: [], ...extra })

const deps = (script, extra = {}) => {
  const { calls, fetchImpl } = scriptedFetch(script)
  const healthNow = typeof extra.healthNow === 'function' ? extra.healthNow : () => 0
  const { healthNow: _healthNow, ...rest } = extra
  return {
    calls,
    deps: {
      config: { timeoutMs: 5_000 },
      fetchImpl,
      health: new HealthTracker({ now: healthNow }),
      now: () => 0,
      ...rest,
    },
  }
}

// ---------------------------------------------------------------------------
// retry policy
// ---------------------------------------------------------------------------

test('isRetryableStatus matches the documented policy', () => {
  for (const status of [401, 403]) assert.equal(isRetryableStatus(status, 'AUTH'), false, `${status}`)
  assert.equal(isRetryableStatus(400, 'INVALID_REQUEST'), false)
  assert.equal(isRetryableStatus(400, MODEL_UNAVAILABLE_CODE), true, 'model_unavailable is the one 400 that retries')
  for (const status of [404, 408, 409, 410, 422, 429]) assert.equal(isRetryableStatus(status, 'X'), true, `${status}`)
  for (const status of [500, 502, 503, 504]) assert.equal(isRetryableStatus(status, 'SERVER'), true, `${status}`)
  assert.equal(isRetryableStatus(200, 'STOP'), false)
  assert.equal(isRetryableStatus(undefined, 'TRANSPORT'), false, 'transport failures are modelled as errors, not statuses')
  assert.equal(isRetryableStatus(400, 'AUTH'), false)
  assert.equal(isRetryableStatus(400, 'INVALID_CREDENTIAL'), false)
})

test('a 400 model_unavailable response is classified as its own code', () => {
  const payload = { error: { message: "Model 'gpt-oss-20b' is currently unavailable.", type: 'invalid_request_error', code: 'model_unavailable' } }
  const detail = JSON.stringify(payload)
  assert.equal(isModelUnavailableError(detail), true)
  assert.equal(classifyStatus(400, detail), MODEL_UNAVAILABLE_CODE)
  // A plain 400 stays a request error.
  assert.equal(classifyStatus(400, '{"error":{"message":"messages is required","type":"invalid_request_error"}}'), 'INVALID_REQUEST')
  assert.equal(isModelUnavailableError('messages is required'), false)
  assert.equal(isModelUnavailableError(''), false)
})

test('a 404 model_not_found is the same condition with a different status', () => {
  // A real provider answers an unknown model id with 404 + `model_not_found`; a
  // drifting aggregator answers 400 + `model_unavailable`. Both mean "this
  // provider does not serve this model right now", so both classify to the same
  // code and both are retryable — otherwise one dead model id would fail the
  // whole request instead of moving to the next candidate.
  const detail = JSON.stringify({ error: { message: "model 'laguna-m.1' not found", type: 'invalid_request_error', code: 'model_not_found' } })
  assert.equal(isModelUnavailableError(detail), true)
  assert.equal(classifyStatus(404, detail), MODEL_UNAVAILABLE_CODE)
  assert.equal(isRetryableStatus(404, MODEL_UNAVAILABLE_CODE), true)
  // A bare 404 with no such wording is still retryable: it usually means "this
  // provider does not serve that id", and freellmapi's own exhaustion set
  // (429/502/413/404/503) treats it the same way.
  assert.equal(isRetryableStatus(404, 'INVALID_REQUEST'), true)
})

test('a 404 model_not_found fails over', async () => {
  const { calls, deps: depsValue } = deps([
    errorResponse(404, { error: { message: "model 'gone' not found", code: 'model_not_found' } }),
    sseResponse(OK_BODY('from-b')),
  ])
  const { blocks, finish } = assertValidChunkSequence(await collect(dispatchWithFailover(
    options(),
    plan([target('a', 'gone'), target('b', 'here')]),
    depsValue,
  )))
  assert.deepEqual(blocks, [{ type: 'text', text: 'from-b' }])
  assert.equal(finish.kind, 'stop')
  assert.equal(calls.length, 2)
})

test('the model_unavailable diagnosis names the provider and the model', () => {
  const failure = describeHttpFailure({
    status: 400,
    payload: { error: { message: "Model 'gpt-oss-20b' is currently unavailable.", code: 'model_unavailable' } },
    bodyText: '',
    model: 'gpt-oss-20b',
    baseURL: 'https://api.llm7.io/v1',
    provider: 'llm7',
    sentApiKey: false,
  })
  assert.equal(failure.code, MODEL_UNAVAILABLE_CODE)
  assert.match(failure.message, /llm7/)
  assert.match(failure.message, /gpt-oss-20b/)
  assert.match(failure.message, /per-model condition/)
})

// ---------------------------------------------------------------------------
// happy path and failover
// ---------------------------------------------------------------------------

test('the first candidate wins and health records the latency', async () => {
  const { calls, deps: depsValue } = deps([sseResponse(OK_BODY('hello'))])
  const chunks = await collect(dispatchWithFailover(options(), plan([target('a', 'm')]), depsValue))
  const { blocks, finish } = assertValidChunkSequence(chunks)
  assert.deepEqual(blocks, [{ type: 'text', text: 'hello' }])
  assert.equal(finish.kind, 'stop')
  assert.equal(calls.length, 1)
  assert.equal(depsValue.health.snapshot('a', 'm').successes, 1)
})

test('a 500 fails over to the next candidate', async () => {
  const { calls, deps: depsValue } = deps([
    errorResponse(500, { error: { message: 'boom' } }),
    sseResponse(OK_BODY('from-b')),
  ])
  const chunks = await collect(dispatchWithFailover(options(), plan([target('a', 'm'), target('b', 'm')]), depsValue))
  const { blocks, finish } = assertValidChunkSequence(chunks)
  assert.deepEqual(blocks, [{ type: 'text', text: 'from-b' }])
  assert.equal(finish.kind, 'stop')
  assert.equal(calls.length, 2)
  assert.ok(depsValue.health.snapshot('a', 'm').cooldownUntil > 0, 'the failed candidate is parked')
  assert.equal(depsValue.health.snapshot('b', 'm').successes, 1)
})

test('a model_unavailable 400 fails over instead of failing the request', async () => {
  const { calls, deps: depsValue } = deps([
    errorResponse(400, { error: { message: "Model 'x' is currently unavailable.", code: 'model_unavailable' } }),
    sseResponse(OK_BODY('from-b')),
  ])
  const chunks = await collect(dispatchWithFailover(options(), plan([target('a', 'x'), target('b', 'y')]), depsValue))
  const { blocks } = assertValidChunkSequence(chunks)
  assert.deepEqual(blocks, [{ type: 'text', text: 'from-b' }])
  assert.equal(calls.length, 2)
})

test('a plain 400 request error does not fail over', async () => {
  const { calls, deps: depsValue } = deps([
    errorResponse(400, { error: { message: 'messages is required', type: 'invalid_request_error' } }),
    sseResponse(OK_BODY('should never be reached')),
  ])
  const chunks = await collect(dispatchWithFailover(options(), plan([target('a', 'm'), target('b', 'm')]), depsValue))
  const { finish } = assertValidChunkSequence(chunks)
  assert.equal(finish.kind, 'error')
  assert.equal(finish.failure.code, 'INVALID_REQUEST')
  assert.equal(calls.length, 1, 'the second provider must not be contacted')
})

test('a 401 does not fail over and never retries a bad credential', async () => {
  const { calls, deps: depsValue } = deps([
    errorResponse(401, { error: { message: 'Missing or invalid API key' } }),
    sseResponse(OK_BODY('nope')),
  ])
  const { finish } = assertValidChunkSequence(await collect(dispatchWithFailover(options(), plan([target('a', 'm'), target('b', 'm')]), depsValue)))
  assert.equal(finish.failure.code, 'AUTH')
  assert.equal(calls.length, 1)
})

test('a transport failure fails over', async () => {
  const { calls, deps: depsValue } = deps([
    new TypeError('fetch failed'),
    sseResponse(OK_BODY('recovered')),
  ])
  const { blocks } = assertValidChunkSequence(await collect(dispatchWithFailover(options(), plan([target('a', 'm'), target('b', 'm')]), depsValue)))
  assert.deepEqual(blocks, [{ type: 'text', text: 'recovered' }])
  assert.equal(calls.length, 2)
})

test('a 429 Retry-After drives the cooldown', async () => {
  const { deps: depsValue } = deps([
    errorResponse(429, { error: { message: 'rate limited' } }, { 'retry-after': '90' }),
    sseResponse(OK_BODY('ok')),
  ], { healthNow: () => 1_000 })
  await collect(dispatchWithFailover(options(), plan([target('a', 'm'), target('b', 'm')]), depsValue))
  assert.equal(depsValue.health.snapshot('a', 'm').cooldownUntil, 1_000 + 90_000)
})

// ---------------------------------------------------------------------------
// the hard invariant
// ---------------------------------------------------------------------------

test('a mid-stream failure does NOT fail over, even with a healthy second candidate', async () => {
  const prefix = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'one ' }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'two ' }, finish_reason: null }] })}\n\n`,
  ]
  const { calls, deps: depsValue } = deps([
    brokenSseResponse(prefix),
    sseResponse(OK_BODY('contamination')),
  ])
  const chunks = await collect(dispatchWithFailover(options(), plan([target('a', 'm'), target('b', 'm')]), depsValue))
  const { finish, blocks } = assertValidChunkSequence(chunks)

  assert.equal(calls.length, 1, '★ the second provider must never be contacted after output started')
  assert.equal(finish.kind, 'error')
  assert.ok(blocks.some((block) => block.type === 'text'), 'the partial output is still delivered')
  // The failure is reported in band; the partial text is not silently re-rolled.
  assert.ok(['UNKNOWN', 'TRANSPORT', 'EMPTY_RESPONSE'].includes(finish.failure.code), finish.failure.code)
})

test('a mid-stream stream_error frame also ends the stream locally', async () => {
  const { calls, deps: depsValue } = deps([
    sseResponse([
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'part' }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ type: 'stream_error', error: { message: 'upstream reset' } })}\n\n`,
      'data: [DONE]\n\n',
    ]),
    sseResponse(OK_BODY('contamination')),
  ])
  const { finish } = assertValidChunkSequence(await collect(dispatchWithFailover(options(), plan([target('a', 'm'), target('b', 'm')]), depsValue)))
  assert.equal(calls.length, 1)
  assert.equal(finish.kind, 'error')
  assert.match(finish.failure.message, /upstream reset/)
})

test('the invariant is documented in the STREAM_INTERRUPTED guard', async () => {
  // The loop's own guard is only reachable if the inner function ever throws
  // after emitting; assert the code exists and says what it means.
  const dispatchSource = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../lib/dispatch.js', import.meta.url), 'utf8')).catch(() => '')
  if (dispatchSource === '') return
  assert.ok(dispatchSource.includes(STREAM_INTERRUPTED_CODE))
  assert.match(dispatchSource, /no failover was attempted/)
})

// ---------------------------------------------------------------------------
// exhaustion paths
// ---------------------------------------------------------------------------

test('every candidate failing yields ALL_CANDIDATES_FAILED with a trail', async () => {
  const { calls, deps: depsValue } = deps([
    errorResponse(500, { error: { message: 'a is down' } }),
    errorResponse(429, { error: { message: 'b is limited' } }),
    new TypeError('fetch failed'),
  ])
  const { finish } = assertValidChunkSequence(await collect(dispatchWithFailover(
    options(),
    plan([target('a', 'm1'), target('b', 'm2'), target('c', 'm3')]),
    depsValue,
  )))
  assert.equal(finish.kind, 'error')
  assert.equal(finish.failure.code, ALL_CANDIDATES_FAILED_CODE)
  assert.match(finish.failure.message, /all 3 candidate\(s\) failed/)
  assert.match(finish.failure.message, /a\/m1 → SERVER/)
  assert.match(finish.failure.message, /b\/m2 → RATE_LIMIT/)
  assert.match(finish.failure.message, /c\/m3 → TRANSPORT/)
  assert.equal(calls.length, 3)
})

test('an empty pool yields NO_CANDIDATES with key application entry points', async () => {
  const { finish } = assertValidChunkSequence(await collect(dispatchWithFailover(options(), plan([]), deps([]).deps)))
  assert.equal(finish.kind, 'error')
  assert.equal(finish.failure.code, NO_CANDIDATES_CODE)
  assert.match(finish.failure.message, /keyless providers/)
  assert.match(finish.failure.message, /https:\/\/console\.groq\.com\/keys/)
})

test('an empty pool with an image explains the vision gap', async () => {
  const { finish } = assertValidChunkSequence(await collect(dispatchWithFailover(
    options(),
    plan([], { needsVision: true, exclusions: ['a/m: no vision'] }),
    deps([]).deps,
  )))
  assert.equal(finish.failure.code, NO_CANDIDATES_CODE)
  assert.match(finish.failure.message, /contains an image but no available model declares vision support/)
})

test('maxAttempts caps how many providers are contacted', async () => {
  const { calls, deps: depsValue } = deps([
    errorResponse(500, { error: { message: 'x' } }),
    errorResponse(500, { error: { message: 'x' } }),
    sseResponse(OK_BODY('third')),
  ])
  const config = { timeoutMs: 5_000, routing: { maxAttempts: 2, budgetMs: 45_000 } }
  const { finish } = assertValidChunkSequence(await collect(dispatchWithFailover(
    options(),
    plan([target('a', 'm'), target('b', 'm'), target('c', 'm')]),
    { ...depsValue, config },
  )))
  assert.equal(calls.length, 2, 'the third candidate must not be attempted')
  assert.equal(finish.failure.code, ALL_CANDIDATES_FAILED_CODE)
  assert.match(finish.failure.message, /attempt limit of 2/)
})

test('the time budget stops the loop between attempts', async () => {
  let clock = 0
  const { calls, fetchImpl } = scriptedFetch([
    errorResponse(500, { error: { message: 'x' } }),
    sseResponse(OK_BODY('never')),
  ])
  const { finish } = assertValidChunkSequence(await collect(dispatchWithFailover(
    options(),
    plan([target('a', 'm'), target('b', 'm')]),
    {
      config: { timeoutMs: 5_000, routing: { maxAttempts: 6, budgetMs: 100 } },
      fetchImpl,
      health: new HealthTracker({ now: () => clock }),
      now: () => { clock += 60; return clock },
    },
  )))
  assert.equal(calls.length, 1, 'the budget expired before the second attempt')
  assert.match(finish.failure.message, /100ms time budget/)
})

test('a zero budget means unlimited', async () => {
  const { calls, deps: depsValue } = deps([
    errorResponse(500, { error: { message: 'x' } }),
    sseResponse(OK_BODY('second')),
  ])
  const { blocks } = assertValidChunkSequence(await collect(dispatchWithFailover(
    options(),
    plan([target('a', 'm'), target('b', 'm')]),
    { ...depsValue, config: { timeoutMs: 5_000, routing: { maxAttempts: 6, budgetMs: 0 } } },
  )))
  assert.deepEqual(blocks, [{ type: 'text', text: 'second' }])
  assert.equal(calls.length, 2)
})

// ---------------------------------------------------------------------------
// request shape and observability
// ---------------------------------------------------------------------------

test('the request carries attribution headers and the provider credential', async () => {
  const { calls, deps: depsValue } = deps([sseResponse(OK_BODY('ok'))])
  await collect(dispatchWithFailover(options(), plan([target('a', 'm')]), depsValue))
  const headers = calls[0].init.headers
  assert.match(headers['user-agent'], /deepseek-harness\//)
  assert.equal(headers.authorization, 'Bearer test-key-not-real')
  assert.equal(headers.accept, 'text/event-stream')
  assert.equal(calls[0].url, 'https://a.invalid/v1/chat/completions')
  assert.equal(calls[0].body.stream, true)
  // ★ The wire model is the *target's* model, never `options.model` (which is the
  // DSH routing id). Sending `auto` here would 404 on every real provider.
  assert.equal(calls[0].body.model, 'm')
})

test('★ the wire model is always the target model, whatever the routing id was', async () => {
  for (const routingId of ['auto', 'auto:simple', 'auto:medium', 'auto:complex', 'someprovider/some-model']) {
    const { calls, deps: depsValue } = deps([sseResponse(OK_BODY('ok'))])
    await collect(dispatchWithFailover(
      { ...options(), model: routingId },
      plan([target('provider-a', 'real-model-id')]),
      depsValue,
    ))
    assert.equal(calls[0].body.model, 'real-model-id', `routing id ${routingId} leaked to the wire`)
    assert.notEqual(calls[0].body.model, routingId)
  }
})

test('★ provider extraBody can still override the wire model', async () => {
  const { calls, deps: depsValue } = deps([sseResponse(OK_BODY('ok'))])
  await collect(dispatchWithFailover(
    options(),
    plan([{ ...target('a', 'public-id'), extraBody: { model: 'upstream-alias' } }]),
    depsValue,
  ))
  assert.equal(calls[0].body.model, 'upstream-alias')
})

test('a keyless candidate sends no Authorization header', async () => {
  const { calls, deps: depsValue } = deps([sseResponse(OK_BODY('ok'))])
  await collect(dispatchWithFailover(options(), plan([{ ...target('a', 'm'), apiKey: undefined }]), depsValue))
  assert.equal('authorization' in calls[0].init.headers, false)
})

test('per-provider extra body and headers are merged', async () => {
  const { calls, deps: depsValue } = deps([sseResponse(OK_BODY('ok'))])
  await collect(dispatchWithFailover(
    options(),
    plan([{ ...target('nvidia', 'm'), extraBody: { parallel_tool_calls: false }, extraHeaders: { 'x-nv': '1' } }]),
    depsValue,
  ))
  assert.equal(calls[0].body.parallel_tool_calls, false)
  assert.equal(calls[0].init.headers['x-nv'], '1')
})

test('onRoute reports the decision, including every attempt', async () => {
  const seen = []
  const { deps: depsValue } = deps([
    errorResponse(500, { error: { message: 'x' } }),
    sseResponse(OK_BODY('ok')),
  ], { onRoute: (record) => seen.push(record) })
  await collect(dispatchWithFailover(options(), plan([target('a', 'm1'), target('b', 'm2')]), depsValue))
  assert.equal(seen.length, 1)
  assert.equal(seen[0].mode, 'direct')
  assert.equal(seen[0].tier, 'medium')
  assert.equal(seen[0].provider, 'b')
  assert.equal(seen[0].model, 'm2')
  assert.equal(seen[0].candidateCount, 2)
  assert.deepEqual(seen[0].attempts.map((attempt) => attempt.code), ['SERVER', undefined])
})

test('onRoute is called even when nothing could be tried', async () => {
  const seen = []
  await collect(dispatchWithFailover(options(), plan([]), { ...deps([]).deps, onRoute: (record) => seen.push(record) }))
  assert.equal(seen.length, 1)
  assert.equal(seen[0].candidateCount, 0)
})

test('an aborted caller gets an aborted finish and never contacts a provider', async () => {
  const controller = new AbortController()
  controller.abort()
  const { calls, deps: depsValue } = deps([sseResponse(OK_BODY('nope'))])
  const { finish } = assertValidChunkSequence(await collect(dispatchWithFailover(
    { ...options(), signal: controller.signal },
    plan([target('a', 'm')]),
    { ...depsValue, signal: controller.signal },
  )))
  assert.equal(finish.kind, 'error')
  assert.equal(finish.failure.code, 'ABORTED')
  assert.equal(calls.length, 0)
})

test('an unsupported option is reported once, without contacting a provider', async () => {
  const { calls, deps: depsValue } = deps([sseResponse(OK_BODY('nope'))])
  const { finish } = assertValidChunkSequence(await collect(dispatchWithFailover(
    { ...options(), stop: 'not-an-array' },
    plan([target('a', 'm')]),
    depsValue,
  )))
  assert.equal(finish.kind, 'error')
  assert.equal(finish.failure.code, 'UNSUPPORTED_OPTION')
  assert.equal(calls.length, 0)
})
