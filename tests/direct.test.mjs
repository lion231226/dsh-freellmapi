/**
 * Direct-mode end-to-end tests against local mock providers (`127.0.0.1`, port 0).
 *
 * The centrepiece is the product promise: **the same `auto` model routes a simple
 * request to the fast model and a complex request to the strong one**, with no
 * external process involved.
 *
 * Every mock here validates the wire model like a real provider
 * (`tests/helpers/pool.mjs::startProviderMock`): it answers only for the ids its
 * endpoint declares and returns `404 model_not_found` otherwise. That is
 * deliberate — an earlier version of these mocks answered anything, which let a
 * release-blocking defect hide: direct mode sent the DSH *routing* id
 * (`auto`, `auto:simple`, `provider/model`) as the wire `model`, and every mock
 * replied 200. A mock that accepts any model name cannot catch that class of bug.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { clearRecentRoutes, getRecentRoutes } from '../lib/routes.js'
import { assertValidChunkSequence, chunk, collect, writeSse } from './helpers/harness.mjs'
import { mountPlugin } from './helpers/context.mjs'
import { mockProvider, model, offlinePool, startMockPool, startProviderMock } from './helpers/pool.mjs'

const ask = (text, extra = {}) => ({
  provider: 'freellmapi',
  model: 'auto',
  messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  ...extra,
})

const SIMPLE_PROMPT = '列出这个目录下的文件'
const COMPLEX_PROMPT = '重构这个模块并给出架构权衡与失败模式分析'
const toolSchemas = (count) => Array.from({ length: count }, (_, index) => ({
  name: `tool_${index}`, description: '', parameters: { type: 'object', properties: {} },
}))

const served = (result) => result.blocks.map((block) => block.text).join('')

/** A responder that fails every request with one status. */
const failWith = (status, payload = { error: { message: 'upstream is unhappy' } }, headers = {}) => ({ response }) => {
  response.writeHead(status, { 'content-type': 'application/json', ...headers })
  response.end(JSON.stringify(payload))
  return true
}

/** The two-polarity pool used by most tests: fast+weak and strong+slow. */
const polarityPool = () => startMockPool([
  { id: 'fastmock', answer: 'FAST-AND-WEAK', models: [{ id: 'fast-weak', capability: 2, speed: 5 }] },
  { id: 'strongmock', answer: 'STRONG-AND-SLOW', models: [{ id: 'strong-slow', capability: 5, speed: 2 }] },
])

// ---------------------------------------------------------------------------
// the core promise
// ---------------------------------------------------------------------------

test('core promise: one `auto` model routes simple to the fast model and complex to the strong model', async () => {
  const pool = await polarityPool()
  try {
    clearRecentRoutes()
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })

    // --- a simple request -------------------------------------------------
    const simple = assertValidChunkSequence(await collect(mounted.adapter.stream(ask(SIMPLE_PROMPT))))
    assert.equal(served(simple), 'FAST-AND-WEAK')
    assert.equal(pool.requests('fastmock').length, 1, 'the fast provider should have served the simple request')
    assert.equal(pool.requests('strongmock').length, 0, 'the strong provider must not be touched for a simple request')
    assert.equal(simple.finish.kind, 'stop')
    assert.deepEqual(pool.badModels('fastmock'), [], '★ the upstream must have received a model id it serves')

    const simpleRecord = getRecentRoutes().at(-1)
    assert.equal(simpleRecord.mode, 'direct')
    assert.equal(simpleRecord.tier, 'simple')
    assert.equal(simpleRecord.provider, 'fastmock')
    assert.equal(simpleRecord.model, 'fast-weak')
    assert.equal(simpleRecord.capability, 2)
    assert.equal(simpleRecord.speed, 5)

    // --- a complex request ------------------------------------------------
    const complex = assertValidChunkSequence(await collect(mounted.adapter.stream(ask(COMPLEX_PROMPT, { tools: toolSchemas(12) }))))
    assert.equal(served(complex), 'STRONG-AND-SLOW')
    assert.equal(pool.requests('fastmock').length, 1, 'the fast provider must not serve the complex request')
    assert.equal(pool.requests('strongmock').length, 1, 'the strong provider should have served the complex request')
    assert.deepEqual(pool.badModels('strongmock'), [])

    const complexRecord = getRecentRoutes().at(-1)
    assert.equal(complexRecord.tier, 'complex')
    assert.equal(complexRecord.provider, 'strongmock')
    assert.equal(complexRecord.model, 'strong-slow')
    assert.equal(complexRecord.capability, 5)
    assert.equal(complexRecord.speed, 2)

    // --- the log explains both decisions ----------------------------------
    const lines = mounted.logger.info.filter((line) => line.includes('tier='))
    assert.equal(lines.length, 2, `expected two routing lines, got ${JSON.stringify(mounted.logger.info)}`)
    assert.equal(lines[0], 'dsh-freellmapi: tier=simple -> fastmock/fast-weak (capability=2, speed=5, 1 candidates tried)')
    assert.equal(lines[1], 'dsh-freellmapi: tier=complex -> strongmock/strong-slow (capability=5, speed=2, 1 candidates tried)')

    // --- and the recorded reasons say why ---------------------------------
    assert.ok(complexRecord.reasons.some((reason) => reason.startsWith('tier=complex score=')))
    assert.ok(complexRecord.reasons.some((reason) => reason.includes('12 tool schemas')))
    assert.ok(complexRecord.reasons.some((reason) => reason.includes('complexity keywords')))
    assert.ok(complexRecord.reasons.some((reason) => reason.includes('complex tier weights')))
    assert.ok(complexRecord.reasons.some((reason) => reason.includes('capability 5/5')))
  } finally {
    await pool.close()
  }
})

test('the tier overrides force a lane regardless of the classifier', async () => {
  const pool = await polarityPool()
  try {
    clearRecentRoutes()
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })

    // A complex-looking prompt forced into the simple lane.
    const forced = assertValidChunkSequence(await collect(mounted.adapter.stream(ask(COMPLEX_PROMPT, { model: 'auto:simple' }))))
    assert.equal(served(forced), 'FAST-AND-WEAK')
    assert.equal(getRecentRoutes().at(-1).tier, 'simple')

    // A trivial prompt forced into the complex lane.
    const forcedStrong = assertValidChunkSequence(await collect(mounted.adapter.stream(ask(SIMPLE_PROMPT, { model: 'auto:complex' }))))
    assert.equal(served(forcedStrong), 'STRONG-AND-SLOW')
    assert.equal(getRecentRoutes().at(-1).tier, 'complex')
    assert.ok(getRecentRoutes().at(-1).reasons.some((reason) => reason.includes('forced by the selected model id')))
    assert.deepEqual(pool.badModels('fastmock'), [])
    assert.deepEqual(pool.badModels('strongmock'), [])
  } finally {
    await pool.close()
  }
})

test('auto:medium balances capability and speed', async () => {
  const pool = await startMockPool([
    { id: 'midmock', answer: 'MID', models: [{ id: 'mid', capability: 4, speed: 3 }] },
  ])
  try {
    clearRecentRoutes()
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
    await collect(mounted.adapter.stream(ask('hello there', { model: 'auto:medium' })))
    assert.equal(getRecentRoutes().at(-1).tier, 'medium')
    assert.deepEqual(pool.badModels('midmock'), [])
  } finally {
    await pool.close()
  }
})

// ---------------------------------------------------------------------------
// ★ the wire model is the provider's model, never the DSH routing id
// ---------------------------------------------------------------------------

test('★ every picker id is translated to the real upstream model id', async () => {
  const pool = await startMockPool([
    { id: 'fastmock', answer: 'FAST', models: [{ id: 'fast-weak', capability: 2, speed: 5 }] },
    { id: 'strongmock', answer: 'STRONG', models: [{ id: 'strong-slow', capability: 5, speed: 2 }] },
  ])
  try {
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
    const catalog = await mounted.adapter.listModels('freellmapi')
    const ids = catalog.map((entry) => entry.id)
    // The catalog advertises both virtual routes and composite pool ids.
    assert.ok(ids.includes('auto'))
    assert.ok(ids.includes('auto:simple'))
    assert.ok(ids.includes('fastmock/fast-weak'))

    const realIds = new Set(['fast-weak', 'strong-slow'])
    for (const pickerId of ids) {
      for (const mock of pool.endpoints.values()) mock.requests.length = 0
      const result = assertValidChunkSequence(await collect(mounted.adapter.stream(ask(SIMPLE_PROMPT, { model: pickerId }))))
      assert.equal(result.finish.kind, 'stop', `picker id ${pickerId} should have been served`)

      const seen = [...pool.endpoints.values()].flatMap((mock) => mock.requests.map((request) => request.body.model))
      assert.ok(seen.length > 0, `picker id ${pickerId} produced no upstream request`)
      for (const wireModel of seen) {
        assert.notEqual(wireModel, pickerId, `★ the DSH routing id "${pickerId}" leaked to the provider`)
        assert.ok(realIds.has(wireModel), `★ upstream received "${wireModel}", which no mock endpoint serves`)
      }
    }

    // Nothing was rejected with a 404 model_not_found.
    for (const id of pool.endpoints.keys()) assert.deepEqual(pool.badModels(id), [])
  } finally {
    await pool.close()
  }
})

test('★ an `auto` request sends the selected model id, not "auto"', async () => {
  const pool = await polarityPool()
  try {
    clearRecentRoutes()
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
    const result = assertValidChunkSequence(await collect(mounted.adapter.stream(ask(SIMPLE_PROMPT))))
    assert.equal(result.finish.kind, 'stop')
    const request = pool.requests('fastmock').at(-1)
    assert.equal(request.body.model, 'fast-weak')
    assert.notEqual(request.body.model, 'auto')
    assert.equal(getRecentRoutes().at(-1).model, 'fast-weak')
  } finally {
    await pool.close()
  }
})

test('★ an explicitly picked `provider/model` sends only the model half', async () => {
  const pool = await startMockPool([
    { id: 'fastmock', answer: 'FAST', models: [{ id: 'fast-weak', capability: 2, speed: 5 }] },
    { id: 'strongmock', answer: 'STRONG', models: [{ id: 'strong-slow', capability: 5, speed: 2 }] },
  ])
  try {
    clearRecentRoutes()
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
    // Pick the strong model explicitly on a prompt that would otherwise be simple.
    const result = assertValidChunkSequence(await collect(mounted.adapter.stream(ask(SIMPLE_PROMPT, { model: 'strongmock/strong-slow' }))))
    assert.equal(served(result), 'STRONG')
    assert.equal(pool.requests('strongmock').at(-1).body.model, 'strong-slow')
    assert.equal(pool.requests('fastmock').length, 0)
    assert.deepEqual(pool.badModels('strongmock'), [])
  } finally {
    await pool.close()
  }
})

test('★ a model id containing a slash survives the translation intact', async () => {
  // Real catalog ids like `openai/gpt-oss-120b` contain slashes, so the wire value
  // must be everything after the *first* slash, not a re-joined or truncated id.
  const pool = await startMockPool([
    { id: 'slashy', answer: 'SLASHY', models: [{ id: 'openai/gpt-oss-120b', capability: 4, speed: 5 }] },
  ])
  try {
    clearRecentRoutes()
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
    const result = assertValidChunkSequence(await collect(mounted.adapter.stream(ask(SIMPLE_PROMPT, { model: 'slashy/openai/gpt-oss-120b' }))))
    assert.equal(served(result), 'SLASHY')
    assert.equal(pool.requests('slashy').at(-1).body.model, 'openai/gpt-oss-120b')
    assert.deepEqual(pool.badModels('slashy'), [])
  } finally {
    await pool.close()
  }
})

test('provider extraBody may still override the wire model', async () => {
  const aliased = await startProviderMock({ ids: ['upstream-id'], answer: 'ALIASED-UPSTREAM' })
  try {
    // The endpoint serves `upstream-id`; the pool advertises `public-id` and the
    // provider declaration rewrites the wire model through extraBody.
    const mounted = mountPlugin({
      config: {
        mode: 'direct',
        providers: {
          ...offlinePool([]),
          alias: {
            enabled: true,
            baseURL: aliased.baseURL,
            apiKey: 'test-key-not-real',
            extraBody: { model: 'upstream-id' },
            models: [{ id: 'public-id', capability: 4, speed: 4 }],
          },
        },
      },
    })
    const result = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('hello'))))
    assert.equal(served(result), 'ALIASED-UPSTREAM')
    assert.equal(aliased.requests.at(-1).body.model, 'upstream-id')
  } finally {
    await aliased.close()
  }
})

// ---------------------------------------------------------------------------
// ★ provider-declared wire tweaks must actually reach the wire
// ---------------------------------------------------------------------------

test('★ a built-in extraBody reaches the request body, not just the catalog', async () => {
  // NVIDIA refuses parallel tool calls, so its built-in declaration carries
  // `parallel_tool_calls: false`. An earlier `applyOverride()` rebuilt the
  // declaration field by field and dropped this, so the requirement never left
  // the process — a silent failure that no object-equality assertion would catch.
  const mock = await startProviderMock({
    ids: ['meta/llama-3.3-70b-instruct', 'qwen/qwen3-coder-480b-a35b-instruct'],
    answer: 'NVIDIA-STYLE',
  })
  try {
    const mounted = mountPlugin({
      config: {
        mode: 'direct',
        providers: {
          ...offlinePool([]),
          nvidia: { enabled: true, baseURL: mock.baseURL, apiKey: 'test-key-not-real' },
        },
      },
    })
    const result = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('hello'))))
    assert.equal(served(result), 'NVIDIA-STYLE')
    // The proof is the request that actually left the process.
    assert.equal(mock.requests.at(-1).body.parallel_tool_calls, false)
    assert.deepEqual(mock.badModels, [])
  } finally {
    await mock.close()
  }
})

test('★ a user extraBody shallow-merges with the built-in one', async () => {
  const mock = await startProviderMock({
    ids: ['meta/llama-3.3-70b-instruct', 'qwen/qwen3-coder-480b-a35b-instruct'],
    answer: 'MERGED',
  })
  try {
    const mounted = mountPlugin({
      config: {
        mode: 'direct',
        providers: {
          ...offlinePool([]),
          nvidia: { enabled: true, baseURL: mock.baseURL, apiKey: 'test-key-not-real', extraBody: { top_p: 0.25 } },
        },
      },
    })
    await collect(mounted.adapter.stream(ask('hello')))
    const body = mock.requests.at(-1).body
    assert.equal(body.parallel_tool_calls, false, 'the built-in requirement must survive a user override')
    assert.equal(body.top_p, 0.25, 'the user value must be added')
  } finally {
    await mock.close()
  }
})

test('★ declared extraHeaders reach the wire too', async () => {
  const mock = await startProviderMock({ ids: ['hdr-model'], answer: 'HEADERS' })
  try {
    const mounted = mountPlugin({
      config: {
        mode: 'direct',
        providers: {
          ...offlinePool([]),
          hdrs: {
            enabled: true,
            baseURL: mock.baseURL,
            apiKey: 'test-key-not-real',
            extraHeaders: { 'x-provider-hint': 'yes' },
            models: [{ id: 'hdr-model', capability: 3, speed: 3 }],
          },
        },
      },
    })
    await collect(mounted.adapter.stream(ask('hello')))
    assert.equal(mock.requests.at(-1).headers['x-provider-hint'], 'yes')
    assert.match(mock.requests.at(-1).headers['user-agent'], /deepseek-harness\//)
  } finally {
    await mock.close()
  }
})

test('★ a mock that validates the model name catches a wrong wire model as a 404', async () => {
  // Meta-proof of the harness itself: the mock really does reject an unknown model
  // id, so the assertions above cannot pass by accident.
  const pool = await startMockPool([
    { id: 'strict', answer: 'STRICT', models: [{ id: 'real-id', capability: 3, speed: 3 }] },
  ])
  try {
    const response = await fetch(`${pool.endpoints.get('strict').baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'auto', messages: [] }),
    })
    assert.equal(response.status, 404)
    const payload = await response.json()
    assert.equal(payload.error.code, 'model_not_found')
    assert.deepEqual(pool.badModels('strict'), ['auto'])
  } finally {
    await pool.close()
  }
})

// ---------------------------------------------------------------------------
// failover
// ---------------------------------------------------------------------------

test('a failing provider fails over to the next one and parks the failure', async () => {
  const pool = await startMockPool([
    { id: 'brokenmock', respond: failWith(500), models: [{ id: 'broken', capability: 5, speed: 5 }] },
    { id: 'goodmock', answer: 'RECOVERED', models: [{ id: 'good', capability: 3, speed: 3 }] },
  ])
  try {
    clearRecentRoutes()
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
    const result = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('hello'))))
    assert.equal(served(result), 'RECOVERED')
    assert.equal(result.finish.kind, 'stop')
    assert.equal(pool.requests('brokenmock').length, 1)
    assert.equal(pool.requests('goodmock').length, 1)
    assert.equal(pool.requests('goodmock').at(-1).body.model, 'good')

    const record = getRecentRoutes().at(-1)
    assert.equal(record.candidateCount, 2)
    assert.deepEqual(record.attempts.map((attempt) => attempt.code), ['SERVER', undefined])
    assert.equal(record.provider, 'goodmock')
    assert.ok(mounted.adapter.health.snapshot('brokenmock', 'broken').cooldownUntil > 0)
  } finally {
    await pool.close()
  }
})

test('a cooled-down provider is skipped on the next request', async () => {
  const pool = await startMockPool([
    {
      id: 'limitedmock',
      respond: failWith(429, { error: { message: 'rate limited' } }, { 'retry-after': '600' }),
      models: [{ id: 'limited', capability: 5, speed: 5 }],
    },
    { id: 'goodmock', answer: 'GOOD', models: [{ id: 'good', capability: 3, speed: 3 }] },
  ])
  try {
    clearRecentRoutes()
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
    await collect(mounted.adapter.stream(ask('first')))
    assert.equal(pool.requests('limitedmock').length, 1, 'the first request must try the preferred provider')
    await collect(mounted.adapter.stream(ask('second')))
    assert.equal(pool.requests('limitedmock').length, 1, 'the second request must skip the cooling provider')
    assert.equal(pool.requests('goodmock').length, 2)
  } finally {
    await pool.close()
  }
})

test('a model_unavailable 400 fails over to the next provider', async () => {
  const pool = await startMockPool([
    {
      id: 'drifting',
      respond: failWith(400, { error: { message: "Model 'drifty' is currently unavailable.", type: 'invalid_request_error', code: 'model_unavailable' } }),
      models: [{ id: 'drifty', capability: 5, speed: 5 }],
    },
    { id: 'goodmock', answer: 'STILL-HERE', models: [{ id: 'good', capability: 3, speed: 3 }] },
  ])
  try {
    clearRecentRoutes()
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
    const result = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('hello'))))
    assert.equal(served(result), 'STILL-HERE')
    assert.equal(pool.requests('drifting').length, 1)
    assert.deepEqual(getRecentRoutes().at(-1).attempts.map((attempt) => attempt.code), ['MODEL_UNAVAILABLE', undefined])
  } finally {
    await pool.close()
  }
})

test('★ a 404 model_not_found also fails over — same condition, different status', async () => {
  // A real provider answers an unknown model id with 404 + `model_not_found`; a
  // drifting aggregator answers 400 + `model_unavailable`. Both mean "this
  // provider does not serve this model right now", so both must cool the pair
  // down and move on rather than fail the whole request.
  const pool = await startMockPool([
    {
      id: 'vanished',
      respond: failWith(404, { error: { message: "model 'gone' not found", type: 'invalid_request_error', code: 'model_not_found' } }),
      models: [{ id: 'gone', capability: 5, speed: 5 }],
    },
    { id: 'goodmock', answer: 'NEXT-ONE', models: [{ id: 'good', capability: 3, speed: 3 }] },
  ])
  try {
    clearRecentRoutes()
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
    const result = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('hello'))))
    assert.equal(served(result), 'NEXT-ONE', 'a 404 model_not_found must not fail the whole request')
    assert.equal(result.finish.kind, 'stop')
    assert.equal(pool.requests('vanished').length, 1)
    assert.equal(pool.requests('goodmock').length, 1)
    assert.deepEqual(getRecentRoutes().at(-1).attempts.map((attempt) => attempt.code), ['MODEL_UNAVAILABLE', undefined])
    // The pair is parked, so the next request does not pay the 404 again.
    await collect(mounted.adapter.stream(ask('again')))
    assert.equal(pool.requests('vanished').length, 1)
  } finally {
    await pool.close()
  }
})

test('★ a 400 model_unavailable parks the pair just like a 404 does', async () => {
  // `errors.js` documents that this condition "parks this model", and the pair is
  // the same thing whichever status carries it: a 400 `model_unavailable` from a
  // drifting aggregator, or a 404 `model_not_found` from a strict provider. Both
  // must cool the pair down, not just the 404 spelling.
  const pool = await startMockPool([
    {
      id: 'drifting',
      respond: failWith(400, { error: { message: "Model 'drifty' is currently unavailable.", type: 'invalid_request_error', code: 'model_unavailable' } }),
      models: [{ id: 'drifty', capability: 5, speed: 5 }],
    },
    { id: 'goodmock', answer: 'GOOD', models: [{ id: 'good', capability: 3, speed: 3 }] },
  ])
  try {
    clearRecentRoutes()
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
    await collect(mounted.adapter.stream(ask('first')))
    assert.equal(pool.requests('drifting').length, 1)
    const snapshot = mounted.adapter.health.snapshot('drifting', 'drifty')
    assert.equal(snapshot.failures, 1)
    assert.ok(snapshot.cooldownUntil > 0, '400 model_unavailable must park the pair')

    await collect(mounted.adapter.stream(ask('second')))
    assert.equal(pool.requests('drifting').length, 1, 'the parked pair must be skipped on the next request')
    assert.equal(pool.requests('goodmock').length, 2)
  } finally {
    await pool.close()
  }
})

test('★ a plain 400 request error does not park the pair', async () => {
  const pool = await startMockPool([
    {
      id: 'strict',
      respond: failWith(400, { error: { message: 'messages is required', type: 'invalid_request_error' } }),
      models: [{ id: 'strict-model', capability: 3, speed: 3 }],
    },
  ])
  try {
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
    const result = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('hello'))))
    assert.equal(result.finish.kind, 'error')
    assert.equal(result.finish.failure.code, 'INVALID_REQUEST')
    assert.equal(mounted.adapter.health.snapshot('strict', 'strict-model').cooldownUntil, 0)
    assert.equal(pool.requests('strict').length, 1, 'a bad request must not be retried against another provider')
  } finally {
    await pool.close()
  }
})

test('★ a mid-stream failure does not park the provider', async () => {
  const pool = await startMockPool([
    {
      id: 'flakymock',
      models: [{ id: 'flaky', capability: 5, speed: 5 }],
      respond: ({ response }) => {
        writeSse(response, [chunk('one '), chunk('two ')], { end: false })
        setTimeout(() => response.socket?.destroy(), 25)
        return true
      },
    },
  ])
  try {
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
    await collect(mounted.adapter.stream(ask('hello')))
    const snapshot = mounted.adapter.health.snapshot('flakymock', 'flaky')
    assert.equal(snapshot.failures, 1, 'one interrupted stream is a weak signal and only counts')
    assert.equal(snapshot.cooldownUntil, 0, 'but it must not park the provider')
    assert.equal(mounted.adapter.health.isAvailable('flakymock', 'flaky'), true)
  } finally {
    await pool.close()
  }
})

test('every candidate failing yields a readable ALL_CANDIDATES_FAILED finish', async () => {
  const pool = await startMockPool([
    { id: 'a', respond: failWith(500), models: [{ id: 'a1', capability: 5, speed: 5 }] },
    { id: 'b', respond: failWith(503), models: [{ id: 'b1', capability: 4, speed: 4 }] },
  ])
  try {
    clearRecentRoutes()
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
    const result = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('hello'))))
    assert.equal(result.finish.kind, 'error')
    assert.equal(result.finish.failure.code, 'ALL_CANDIDATES_FAILED')
    assert.match(result.finish.failure.message, /all 2 candidate\(s\) failed/)
    assert.match(result.finish.failure.message, /a\/a1 → SERVER/)
    assert.match(result.finish.failure.message, /b\/b1 → SERVER/)
  } finally {
    await pool.close()
  }
})

// ---------------------------------------------------------------------------
// the hard invariant, end to end
// ---------------------------------------------------------------------------

test('★ a provider that breaks mid-stream is never replaced by another one', async () => {
  const pool = await startMockPool([
    {
      id: 'flakymock',
      models: [{ id: 'flaky', capability: 5, speed: 5 }],
      respond: ({ response }) => {
        writeSse(response, [chunk('one '), chunk('two ')], { end: false })
        // Deliver the two frames, then drop the connection.
        setTimeout(() => response.socket?.destroy(), 25)
        return true
      },
    },
    { id: 'standbymock', answer: 'CONTAMINATION', models: [{ id: 'standby', capability: 3, speed: 3 }] },
  ])
  try {
    clearRecentRoutes()
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
    const result = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('hello'))))

    assert.equal(pool.requests('flakymock').length, 1)
    assert.equal(pool.requests('standbymock').length, 0, '★ the standby provider must not receive a second request')
    assert.equal(result.finish.kind, 'error')
    assert.equal(served(result), 'one two ', 'the partial output is delivered as-is, never re-rolled')
    assert.match(result.finish.failure.message, /one two |socket|terminated|fetch failed|other side|ECONNRESET/i)
  } finally {
    await pool.close()
  }
})

// ---------------------------------------------------------------------------
// capability gates, end to end
// ---------------------------------------------------------------------------

const imageMessage = () => ({
  role: 'user',
  content: [
    { type: 'text', text: 'what is in this picture?' },
    { type: 'image', attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 10, width: 4, height: 4 } },
  ],
})

test('an image request only reaches a vision-capable model', async () => {
  const pool = await startMockPool([
    // Better on every other axis, so only the vision gate can explain the choice.
    { id: 'blindmock', answer: 'BLIND', models: [{ id: 'blind', capability: 5, speed: 5, vision: false }] },
    { id: 'seeingmock', answer: 'SEEING', models: [{ id: 'seeing', capability: 2, speed: 2, vision: true }] },
  ])
  try {
    clearRecentRoutes()
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
    const result = assertValidChunkSequence(await collect(mounted.adapter.stream({
      provider: 'freellmapi', model: 'auto', messages: [imageMessage()],
    })))
    assert.equal(served(result), 'SEEING')
    assert.equal(pool.requests('blindmock').length, 0)
    assert.equal(pool.requests('seeingmock').length, 1)
    assert.equal(pool.requests('seeingmock').at(-1).body.model, 'seeing')
  } finally {
    await pool.close()
  }
})

test('an image with no vision model in the pool explains the gap instead of guessing', async () => {
  const pool = await startMockPool([
    { id: 'blindmock', answer: 'BLIND', models: [{ id: 'blind', capability: 5, speed: 5, vision: false }] },
  ])
  try {
    clearRecentRoutes()
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
    const result = assertValidChunkSequence(await collect(mounted.adapter.stream({
      provider: 'freellmapi', model: 'auto', messages: [imageMessage()],
    })))
    assert.equal(result.finish.kind, 'error')
    assert.equal(result.finish.failure.code, 'NO_CANDIDATES')
    assert.match(result.finish.failure.message, /vision support/)
    assert.equal(pool.requests('blindmock').length, 0, 'no request may be sent to a model that cannot see')
  } finally {
    await pool.close()
  }
})

test('a request with tools skips models that declare no tool calling', async () => {
  const pool = await startMockPool([
    { id: 'notoolsmock', answer: 'NO-TOOLS', models: [{ id: 'notools', capability: 5, speed: 5, toolCalling: false }] },
    { id: 'toolsmock', answer: 'WITH-TOOLS', models: [{ id: 'tools', capability: 2, speed: 2, toolCalling: true }] },
  ])
  try {
    clearRecentRoutes()
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
    const result = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('use a tool', { tools: toolSchemas(1) }))))
    assert.equal(served(result), 'WITH-TOOLS')
    assert.equal(pool.requests('notoolsmock').length, 0)
  } finally {
    await pool.close()
  }
})

test('a request larger than a model context window skips that model', async () => {
  const pool = await startMockPool([
    { id: 'smallmock', answer: 'SMALL-CTX', models: [{ id: 'small', capability: 5, speed: 5, contextWindow: 2_000 }] },
    { id: 'bigmock', answer: 'BIG-CTX', models: [{ id: 'big', capability: 2, speed: 2, contextWindow: 131_072 }] },
  ])
  try {
    clearRecentRoutes()
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
    const result = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('x'.repeat(20_000)))))
    assert.equal(served(result), 'BIG-CTX')
    assert.equal(pool.requests('smallmock').length, 0)
    assert.ok(getRecentRoutes().at(-1).reasons.length > 0)
  } finally {
    await pool.close()
  }
})

test('an empty pool explains where to get a key', async () => {
  const mounted = mountPlugin({ config: { mode: 'direct', providers: offlinePool([]) } })
  const result = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('hello'))))
  assert.equal(result.finish.kind, 'error')
  assert.equal(result.finish.failure.code, 'NO_CANDIDATES')
  assert.match(result.finish.failure.message, /keyless providers/)
})

// ---------------------------------------------------------------------------
// catalog contract in direct mode
// ---------------------------------------------------------------------------

test('listModels in direct mode advertises auto first, then the tier overrides, then the pool', async () => {
  const pool = await startMockPool([
    {
      id: 'mocka',
      answer: 'A',
      models: [
        { id: 'alpha', capability: 5, speed: 2, vision: true },
        { id: 'beta', capability: 2, speed: 5 },
      ],
    },
  ])
  try {
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
    const models = await mounted.adapter.listModels('freellmapi')

    assert.equal(models[0].id, 'auto')
    assert.deepEqual(models.slice(1, 4).map((entry) => entry.id), ['auto:simple', 'auto:medium', 'auto:complex'])
    assert.deepEqual(models.slice(4).map((entry) => entry.id), ['mocka/alpha', 'mocka/beta'])

    // Everything the runtime's catalog validator checks.
    const seen = new Set()
    for (const entry of models) {
      assert.equal(entry.provider, 'freellmapi')
      assert.ok(typeof entry.id === 'string' && entry.id.length > 0)
      assert.ok(typeof entry.name === 'string' && entry.name.length > 0)
      assert.equal(seen.has(entry.id), false, `duplicate id ${entry.id}`)
      seen.add(entry.id)
    }
    // Vision is advertised per model, not globally.
    assert.deepEqual(models.find((entry) => entry.id === 'mocka/alpha').inputModalities, ['text', 'image'])
    assert.deepEqual(models.find((entry) => entry.id === 'mocka/beta').inputModalities, ['text'])
    assert.match(models.find((entry) => entry.id === 'mocka/alpha').description, /capability 5\/5/)
  } finally {
    await pool.close()
  }
})

test('listModels shows nothing but the virtual routes when the whole pool is disabled', async () => {
  const mounted = mountPlugin({ config: { mode: 'direct', providers: offlinePool([]) } })
  const models = await mounted.adapter.listModels('freellmapi')
  assert.deepEqual(models.map((entry) => entry.id), ['auto', 'auto:simple', 'auto:medium', 'auto:complex'])
})

test('resolveModel uses the pool capability of an explicitly named model', async () => {
  const pool = offlinePool([
    mockProvider('mocka', 'https://a.invalid/v1', [model({ id: 'alpha', capability: 5, speed: 2, contextWindow: 65_536, maxTokens: 4_096, vision: true })]),
  ])
  const mounted = mountPlugin({ config: { mode: 'direct', providers: pool } })
  const info = await mounted.adapter.resolveModel('freellmapi', 'mocka/alpha')
  assert.equal(info.provider, 'freellmapi')
  assert.equal(info.id, 'mocka/alpha')
  assert.equal(info.context.contextWindow, 65_536)
  assert.equal(info.defaultMaxTokens, 4_096)
  assert.deepEqual([...info.inputModalities], ['text', 'image'])
  const auto = await mounted.adapter.resolveModel('freellmapi', 'auto')
  assert.equal(auto.id, 'auto')
  assert.match(auto.name, /complexity-routed/)
})

// ---------------------------------------------------------------------------
// configuration and defaults
// ---------------------------------------------------------------------------

test('direct mode is the default, and gateway mode is still selectable', async () => {
  const mounted = mountPlugin({ config: {} })
  // No `mode` means direct: the virtual routes are the tier overrides.
  const ids = (await mounted.adapter.listModels('freellmapi')).map((entry) => entry.id)
  assert.equal(ids[0], 'auto')
  assert.ok(ids.includes('auto:simple'))
  assert.equal(ids.includes('auto:smart'), false)

  const gateway = mountPlugin({ config: { mode: 'gateway' } })
  const gatewayIds = (await gateway.adapter.listModels('freellmapi')).map((entry) => entry.id)
  assert.ok(gatewayIds.includes('auto:smart'), 'gateway mode keeps the upstream strategy routes')
  assert.equal(gatewayIds.includes('auto:simple'), false)
})

test('a malformed providers block never throws and never leaves the offline pool', async () => {
  // Primitive garbage replaces the whole block, so the built-in pool comes back;
  // only `listModels` is exercised there, because a stream would reach the real
  // keyless providers. The object-shaped cases keep the built-ins disabled.
  for (const providers of [5, 'x', [], null]) {
    let mounted
    assert.doesNotThrow(() => {
      mounted = mountPlugin({ config: { mode: 'direct', providers } })
    })
    const ids = (await mounted.adapter.listModels('freellmapi')).map((entry) => entry.id)
    assert.deepEqual(ids.slice(0, 4), ['auto', 'auto:simple', 'auto:medium', 'auto:complex'])
  }

  for (const providers of [{ ...offlinePool([]), mocka: 7 }, { ...offlinePool([]), mocka: { models: 'nope' } }, { ...offlinePool([]), mocka: { baseURL: 'https://x.invalid/v1' } }]) {
    let mounted
    assert.doesNotThrow(() => {
      mounted = mountPlugin({ config: { mode: 'direct', providers } })
    })
    const result = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('hello'))))
    assert.equal(result.finish.kind, 'error')
  }
})

test('a user-declared provider override can point a built-in provider at a mock', async () => {
  const mock = await startProviderMock({ ids: ['relocated'], answer: 'OVERRIDDEN' })
  try {
    clearRecentRoutes()
    const mounted = mountPlugin({
      config: {
        mode: 'direct',
        providers: {
          // Disable everything, then re-enable exactly one built-in id on a mock URL.
          ...offlinePool([]),
          groq: {
            enabled: true,
            baseURL: mock.baseURL,
            apiKey: 'test-key-not-real',
            models: [{ id: 'relocated', capability: 4, speed: 4 }],
          },
        },
      },
    })
    const result = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('hello'))))
    assert.equal(served(result), 'OVERRIDDEN')
    assert.equal(mock.requests.at(-1).body.model, 'relocated')
    assert.deepEqual(mock.badModels, [])
    assert.equal(getRecentRoutes().at(-1).provider, 'groq')
    assert.equal(getRecentRoutes().at(-1).model, 'relocated')
  } finally {
    await mock.close()
  }
})

test('logRouting:false records the decision without logging it', async () => {
  const pool = await startMockPool([
    { id: 'quietmock', answer: 'QUIET', models: [{ id: 'quiet', capability: 3, speed: 3 }] },
  ])
  try {
    clearRecentRoutes()
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config, logRouting: false } })
    await collect(mounted.adapter.stream(ask('hello')))
    assert.deepEqual(mounted.logger.info, [])
    assert.equal(getRecentRoutes().at(-1).provider, 'quietmock')
  } finally {
    await pool.close()
  }
})

test('the routing record is readable through the exported getRecentRoutes()', async () => {
  const pool = await startMockPool([
    { id: 'recordmock', answer: 'RECORDED', models: [{ id: 'recorded', capability: 4, speed: 3 }] },
  ])
  try {
    clearRecentRoutes()
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
    await collect(mounted.adapter.stream(ask('hello')))
    const routes = getRecentRoutes()
    assert.equal(routes.length, 1)
    assert.equal(routes[0].mode, 'direct')
    assert.equal(routes[0].requestedModel, 'auto')
    assert.equal(routes[0].requestedProvider, 'freellmapi')
    assert.equal(routes[0].tier, 'simple')
    assert.equal(typeof routes[0].score, 'number')
    assert.equal(routes[0].candidateCount, 1)
    assert.ok(Array.isArray(routes[0].reasons))
  } finally {
    await pool.close()
  }
})
