/**
 * End-to-end adapter tests against a local mock gateway (port 0, no network, no
 * API key ever leaves the process).
 *
 * Each test mounts the plugin through `apply()` against a fake cordis context,
 * takes the adapter the registration handed back, and drives `stream()`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { getRecentRoutes, clearRecentRoutes } from '../lib/routes.js'
import { assertValidChunkSequence, chunk, collect, reasoningChunk, startMockServer, writeSse } from './helpers/harness.mjs'
import { liveConfig, mountPlugin } from './helpers/context.mjs'

const TEST_KEY = 'freellmapi-test-key-not-a-real-credential'

/** Mount the plugin with a config pointing at a mock gateway. */
function mount(baseURL, config = {}, services = {}) {
  return mountPlugin({
    config: { mode: 'gateway', baseURL, apiKey: TEST_KEY, ...config },
    services,
  })
}

/** A minimal valid request for the given model. */
function request(model, extra = {}) {
  return {
    provider: 'freellmapi',
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    ...extra,
  }
}

test('registration mounts one route, one directory entry and one discovery offer', () => {
  const mounted = mountPlugin({ config: { mode: 'gateway', apiKey: TEST_KEY } })
  assert.equal(mounted.adapterCount, 1)
  assert.deepEqual(mounted.directoryEntries, [{
    provider: 'freellmapi',
    displayName: 'FreeLLMAPI (Auto)',
    settingsNs: 'freellmapi',
    // The empty path is the whole namespace, because this plugin owns exactly one
    // route. A non-empty path would have to name a real sub-object: the Models
    // page computes `configured` from `schema.getPath(value, settingsPath)`, so a
    // path that does not resolve hides the row from the card list and routes it
    // through "add model provider" instead — where saving writes the path.
    // `config.providers` is keyed by UPSTREAM provider, so there is deliberately
    // no `providers.freellmapi` to point at.
    settingsPath: [],
    declared: true,
  }])
  assert.equal(mounted.settingsNs, 'freellmapi')
  assert.equal(typeof mounted.discovery, 'function')
})

test('the directory entry points at the namespace root, never at the upstream map', () => {
  const mounted = mountPlugin({ config: { mode: 'gateway', apiKey: TEST_KEY } })
  const entry = mounted.directoryEntries[0]
  // A path under `providers` would name an upstream, and `freellmapi` is not one.
  assert.equal(entry.settingsPath.includes('providers'), false)
  assert.deepEqual(entry.settingsPath, [])
  // The namespace is the loader entry id, which is also the settings namespace the
  // schema fix in 0.5.0 made resolvable. The two must not drift apart.
  assert.equal(entry.settingsNs, entry.provider)
})

test('provider metadata preserves the route id', () => {
  const { adapter } = mountPlugin({ config: { mode: 'gateway', apiKey: TEST_KEY } })
  assert.deepEqual(adapter.providerInfo('freellmapi'), { id: 'freellmapi', name: 'FreeLLMAPI (Auto)' })
})

test('providerRetryPolicy returns undefined so the runtime default applies', () => {
  const { adapter } = mountPlugin({ config: { mode: 'gateway', apiKey: TEST_KEY } })
  assert.equal(adapter.providerRetryPolicy('freellmapi'), undefined)
})

test('a route conflict is reported with actionable advice', () => {
  assert.throws(
    () => mountPlugin({ config: { mode: 'gateway', apiKey: TEST_KEY }, failAdapterRegistration: true }),
    (error) => {
      assert.equal(error.code, 'DUPLICATE_ADAPTER')
      assert.match(error.message, /setup-dsh/)
      return true
    },
  )
})

test('listModels advertises auto first and merges discovery', async () => {
  const server = await startMockServer((request_, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ object: 'list', data: [{ id: 'auto' }, { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' }] }))
  })
  try {
    const { adapter } = mount(server.baseURL)
    const models = await adapter.listModels('freellmapi')
    assert.equal(models[0].id, 'auto')
    assert.deepEqual(models.slice(1, 6).map((model) => model.id), ['auto:smart', 'auto:fast', 'auto:cheap', 'auto:reliable', 'auto:balanced'])
    assert.equal(models[6].id, 'fusion')
    assert.equal(models.at(-1).id, 'gemini-2.5-flash')
    assert.equal(new Set(models.map((model) => model.id)).size, models.length)
    // Every entry must satisfy the runtime's catalog validator.
    for (const model of models) {
      assert.equal(model.provider, 'freellmapi')
      assert.ok(typeof model.id === 'string' && model.id.length > 0)
      assert.ok(typeof model.name === 'string' && model.name.length > 0)
    }
  } finally {
    await server.close()
  }
})

test('listModels still returns the virtual routes when discovery fails', async () => {
  const { adapter } = mount('http://127.0.0.1:1/v1')
  const models = await adapter.listModels('freellmapi')
  assert.equal(models.length, 7)
  assert.equal(models[0].id, 'auto')
})

test('listModels omits discovered models when the switch is off', async () => {
  const server = await startMockServer((request_, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ object: 'list', data: [{ id: 'should-not-appear' }] }))
  })
  try {
    const { adapter } = mount(server.baseURL, { exposeDiscoveredModels: false })
    const models = await adapter.listModels('freellmapi')
    assert.equal(models.some((model) => model.id === 'should-not-appear'), false)
  } finally {
    await server.close()
  }
})

test('resolveModel returns matching identity for listed and unlisted ids', async () => {
  const { adapter } = mountPlugin({ config: { mode: 'gateway', apiKey: TEST_KEY } })
  for (const model of ['auto', 'auto:fast', 'auto:my-own-profile', 'gemini-2.5-flash']) {
    const info = await adapter.resolveModel('freellmapi', model)
    assert.equal(info.provider, 'freellmapi')
    assert.equal(info.id, model)
    assert.ok(typeof info.name === 'string' && info.name.length > 0)
    assert.ok(Number.isInteger(info.context.contextWindow) && info.context.contextWindow > 0)
  }
  assert.equal((await adapter.resolveModel('freellmapi', 'auto')).name, 'Auto (router picks the best available model)')
})

test('stream translates a text SSE response into a legal chunk sequence', async () => {
  const server = await startMockServer((request_, response) => {
    writeSse(response, [chunk('Hello'), chunk(', '), chunk('world.'),
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } },
      '[DONE]'])
  })
  try {
    const { adapter } = mount(server.baseURL)
    const chunks = await collect(adapter.stream(request('auto')))
    const { blocks, usage, finish } = assertValidChunkSequence(chunks)
    assert.deepEqual(blocks, [{ type: 'text', text: 'Hello, world.' }])
    assert.deepEqual(usage, { inputTokens: 12, outputTokens: 7, totalTokens: 19 })
    assert.deepEqual(finish, { kind: 'stop' })
  } finally {
    await server.close()
  }
})

test('stream sends the model string verbatim (the Auto promise)', async () => {
  for (const model of ['auto', 'auto:fast', 'auto:smart', 'auto:my-own-profile', 'fusion', 'gemini-2.5-flash']) {
    const server = await startMockServer((request_, response) => {
      writeSse(response, [chunk('ok'), { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, '[DONE]'])
    })
    try {
      const { adapter } = mount(server.baseURL)
      await collect(adapter.stream(request(model)))
      const body = JSON.parse(server.requests[0].body)
      assert.equal(body.model, model, `model ${model} must reach the gateway unchanged`)
      assert.equal(body.stream, true)
      assert.equal(server.requests[0].url, '/v1/chat/completions')
      assert.equal(server.requests[0].method, 'POST')
    } finally {
      await server.close()
    }
  }
})

test('stream carries attribution headers, authorization, accept and the extra knobs', async () => {
  const server = await startMockServer((request_, response) => {
    writeSse(response, [chunk('ok'), { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, '[DONE]'])
  })
  try {
    const { adapter } = mount(server.baseURL, { taskType: 'code', cacheMode: 'off', headers: { 'x-custom': 'yes' } })
    await collect(adapter.stream(request('auto')))
    const headers = server.requests[0].headers
    assert.match(headers['user-agent'], /deepseek-harness\//)
    assert.match(headers.authorization, new RegExp(`^Bearer ${TEST_KEY}$`))
    assert.equal(headers.accept, 'text/event-stream')
    assert.equal(headers['content-type'], 'application/json')
    assert.equal(headers['x-freellm-task-type'], 'code')
    assert.equal(headers['x-free-llm-cache'], 'off')
    assert.equal(headers['x-custom'], 'yes')
  } finally {
    await server.close()
  }
})

test('stream maps tools, system prompt and sampling fields onto the wire', async () => {
  const server = await startMockServer((request_, response) => {
    writeSse(response, [chunk('ok'), { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, '[DONE]'])
  })
  try {
    const { adapter } = mount(server.baseURL, { maxTokensField: 'max_completion_tokens' })
    await collect(adapter.stream(request('auto', {
      system: 'be terse',
      temperature: 0.1,
      maxTokens: 64,
      stop: ['STOP'],
      tools: [{ name: 'lookup', description: 'look things up', parameters: { type: 'object', properties: {} } }],
    })))
    const body = JSON.parse(server.requests[0].body)
    assert.equal(body.messages[0].role, 'system')
    assert.equal(body.messages[0].content, 'be terse')
    assert.equal(body.temperature, 0.1)
    assert.equal(body.max_completion_tokens, 64)
    assert.equal(body.max_tokens, undefined)
    assert.deepEqual(body.stop, ['STOP'])
    assert.equal(body.tools[0].function.name, 'lookup')
  } finally {
    await server.close()
  }
})

test('stream survives TCP-level fragmentation and heartbeat comments', async () => {
  const payloads = [
    'data: {"choices":[{"index":0,"delta":{"content":"Hel',
    'lo"},"finish_reason":null}]}\n\n',
    ': ping\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
  ]
  const server = await startMockServer((request_, response) => {
    writeSse(response, payloads.map((raw) => ({ raw })))
  })
  try {
    const { adapter } = mount(server.baseURL)
    const { blocks } = assertValidChunkSequence(await collect(adapter.stream(request('auto'))))
    assert.deepEqual(blocks, [{ type: 'text', text: 'Hello world' }])
  } finally {
    await server.close()
  }
})

test('stream tolerates malformed JSON and _fusion additive frames', async () => {
  const server = await startMockServer((request_, response) => {
    writeSse(response, [
      { raw: ': keep-alive\n\n' },
      { _fusion: { stage: 'panel', panel: ['a', 'b'] } },
      chunk('answer'),
      { raw: 'data: {"choices": [\n\n' },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      '[DONE]',
    ])
  })
  try {
    const { adapter } = mount(server.baseURL)
    const { blocks, finish } = assertValidChunkSequence(await collect(adapter.stream(request('fusion'))))
    assert.deepEqual(blocks, [{ type: 'text', text: 'answer' }])
    assert.deepEqual(finish, { kind: 'stop' })
  } finally {
    await server.close()
  }
})

test('stream handles reasoning, merged tool calls and a usage tail packet', async () => {
  const server = await startMockServer((request_, response) => {
    writeSse(response, [
      reasoningChunk('weighing options'),
      chunk('calling a tool'),
      {
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, id: 'call_42', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Beijing"}' } }] },
          finish_reason: 'tool_calls',
        }],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 9, total_tokens: 29, prompt_tokens_details: { cached_tokens: 4 } } },
      '[DONE]',
    ])
  })
  try {
    const { adapter } = mount(server.baseURL)
    const chunks = await collect(adapter.stream(request('auto')))
    const { blocks, usage, finish } = assertValidChunkSequence(chunks)
    assert.deepEqual(blocks, [
      { type: 'reasoning', text: 'weighing options' },
      { type: 'text', text: 'calling a tool' },
      { type: 'tool-call', id: 'call_42', name: 'get_weather', arguments: '{"city":"Beijing"}' },
    ])
    assert.equal(finish.kind, 'tool-calls')
    assert.deepEqual(usage, { inputTokens: 20, outputTokens: 9, totalTokens: 29, cacheReadTokens: 4 })
  } finally {
    await server.close()
  }
})

test('a mid-stream stream_error frame becomes a finish error, not a throw', async () => {
  const server = await startMockServer((request_, response) => {
    writeSse(response, [
      chunk('partial'),
      { type: 'stream_error', error: { message: 'upstream provider reset the connection', type: 'api_error' } },
      '[DONE]',
    ])
  })
  try {
    const { adapter } = mount(server.baseURL)
    const { blocks, finish } = assertValidChunkSequence(await collect(adapter.stream(request('auto'))))
    assert.deepEqual(blocks, [{ type: 'text', text: 'partial' }])
    assert.equal(finish.kind, 'error')
    assert.match(finish.failure.message, /reset the connection/)
  } finally {
    await server.close()
  }
})

for (const [status, expectedCode] of [[401, 'AUTH'], [429, 'RATE_LIMIT'], [500, 'SERVER'], [413, 'CONTEXT_WINDOW_EXCEEDED']]) {
  test(`HTTP ${status} becomes a finish error with code ${expectedCode}`, async () => {
    const server = await startMockServer((request_, response) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'gateway said no', type: 'invalid_request_error' } }))
    })
    try {
      const { adapter } = mount(server.baseURL)
      const chunks = await collect(adapter.stream(request('auto')))
      const { finish } = assertValidChunkSequence(chunks)
      assert.equal(finish.kind, 'error')
      assert.equal(finish.failure.code, expectedCode)
      assert.equal(finish.failure.status, status)
      assert.match(finish.failure.message, /gateway said no/)
    } finally {
      await server.close()
    }
  })
}

test('a 429 quota_exceeded response maps to QUOTA and surfaces Retry-After', async () => {
  const server = await startMockServer((request_, response) => {
    response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '120' })
    response.end(JSON.stringify({ error: { message: 'monthly quota exceeded', code: 'quota_exceeded', type: 'invalid_request_error' } }))
  })
  try {
    const { adapter } = mount(server.baseURL)
    const { finish } = assertValidChunkSequence(await collect(adapter.stream(request('auto'))))
    assert.equal(finish.failure.code, 'QUOTA')
    assert.equal(finish.failure.providerRetryAfterMs, 120_000)
  } finally {
    await server.close()
  }
})

test('an unknown auto:<profile> 400 is translated into actionable advice', async () => {
  const server = await startMockServer((request_, response) => {
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'unknown routing profile "nope" in model auto:nope', type: 'invalid_request_error' } }))
  })
  try {
    const { adapter } = mount(server.baseURL)
    const { finish } = assertValidChunkSequence(await collect(adapter.stream(request('auto:nope'))))
    assert.equal(finish.kind, 'error')
    assert.equal(finish.failure.code, 'INVALID_REQUEST')
    assert.match(finish.failure.message, /auto:nope/)
    assert.match(finish.failure.message, /profile/i)
  } finally {
    await server.close()
  }
})

test('a 422 no_vision_model response explains the vision gap', async () => {
  const server = await startMockServer((request_, response) => {
    response.writeHead(422, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'no vision model in chain', code: 'no_vision_model' } }))
  })
  try {
    const { adapter } = mount(server.baseURL)
    const { finish } = assertValidChunkSequence(await collect(adapter.stream(request('auto'))))
    assert.equal(finish.failure.code, 'UNSUPPORTED_CONTENT')
    assert.match(finish.failure.message, /vision/i)
  } finally {
    await server.close()
  }
})

test('a refused connection becomes a TRANSPORT finish error', async () => {
  const { adapter } = mount('http://127.0.0.1:1/v1')
  const chunks = await collect(adapter.stream(request('auto')))
  const { finish } = assertValidChunkSequence(chunks)
  assert.equal(finish.kind, 'error')
  assert.equal(finish.failure.code, 'TRANSPORT')
  assert.match(finish.failure.message, /cannot reach the FreeLLMAPI gateway/)
})

test('a stalled gateway hits the configured timeout', async () => {
  const server = await startMockServer(() => {
    // deliberately never respond
  })
  try {
    const { adapter } = mount(server.baseURL, { timeoutMs: 150 })
    const { finish } = assertValidChunkSequence(await collect(adapter.stream(request('auto'))))
    assert.equal(finish.kind, 'error')
    assert.equal(finish.failure.code, 'TIMEOUT')
  } finally {
    await server.close()
  }
})

test('an aborted request finishes as aborted', async () => {
  const server = await startMockServer((request_, response) => {
    writeSse(response, [chunk('partial')], { end: false })
    // leave the stream open so the caller has to abort it
  })
  try {
    const { adapter } = mount(server.baseURL)
    const controller = new AbortController()
    const chunks = []
    for await (const item of adapter.stream(request('auto', { signal: controller.signal }))) {
      chunks.push(item)
      if (item.type === 'text-delta') controller.abort()
    }
    const { finish } = assertValidChunkSequence(chunks)
    assert.equal(finish.kind, 'aborted')
    assert.equal(finish.failure.code, 'ABORTED')
  } finally {
    await server.close()
  }
})

test('an already-aborted signal never reaches the network', async () => {
  const server = await startMockServer((request_, response) => {
    writeSse(response, [chunk('nope'), '[DONE]'])
  })
  try {
    const { adapter } = mount(server.baseURL)
    const controller = new AbortController()
    controller.abort()
    const { finish } = assertValidChunkSequence(await collect(adapter.stream(request('auto', { signal: controller.signal }))))
    assert.equal(finish.kind, 'aborted')
    assert.equal(server.requests.length, 0)
  } finally {
    await server.close()
  }
})

test('a missing credential is reported without any network traffic', async () => {
  const server = await startMockServer((request_, response) => {
    writeSse(response, [chunk('nope'), '[DONE]'])
  })
  const previous = process.env.FREELLMAPI_API_KEY
  delete process.env.FREELLMAPI_API_KEY
  try {
    const { adapter } = mount(server.baseURL, { apiKey: '', apiKeyEnv: 'FREELLMAPI_ABSENT_KEY' })
    const { finish } = assertValidChunkSequence(await collect(adapter.stream(request('auto'))))
    assert.equal(finish.kind, 'error')
    assert.equal(finish.failure.code, 'MISSING_CREDENTIAL')
    assert.equal(server.requests.length, 0)
  } finally {
    if (previous !== undefined) process.env.FREELLMAPI_API_KEY = previous
    await server.close()
  }
})

test('the credential falls back to the environment when nothing else is configured', async () => {
  const server = await startMockServer((request_, response) => {
    writeSse(response, [chunk('ok'), { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, '[DONE]'])
  })
  const previous = process.env.FREELLMAPI_API_KEY
  process.env.FREELLMAPI_API_KEY = 'env-key-value'
  try {
    const { adapter } = mount(server.baseURL, { apiKey: '', apiKeyEnv: 'FREELLMAPI_API_KEY' })
    await collect(adapter.stream(request('auto')))
    assert.equal(server.requests[0].headers.authorization, 'Bearer env-key-value')
  } finally {
    if (previous === undefined) delete process.env.FREELLMAPI_API_KEY
    else process.env.FREELLMAPI_API_KEY = previous
    await server.close()
  }
})

test('the credentials service wins over the inline and environment values', async () => {
  const server = await startMockServer((request_, response) => {
    writeSse(response, [chunk('ok'), { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, '[DONE]'])
  })
  const resolved = []
  try {
    const { adapter } = mount(server.baseURL, {}, {
      credentials: {
        resolve(ref) {
          resolved.push(ref)
          return Promise.resolve({ value: 'from-credentials-service', source: 'store' })
        },
      },
    })
    await collect(adapter.stream(request('auto')))
    assert.deepEqual(resolved, ['FREELLMAPI_API_KEY'])
    assert.equal(server.requests[0].headers.authorization, 'Bearer from-credentials-service')
  } finally {
    await server.close()
  }
})

test('a blank credential from the credentials service is treated as unset', async () => {
  const server = await startMockServer((request_, response) => {
    writeSse(response, [chunk('ok'), '[DONE]'])
  })
  try {
    const { adapter } = mount(server.baseURL, { apiKey: 'inline-fallback' }, {
      credentials: { resolve: () => Promise.resolve({ value: '   ', source: 'env' }) },
    })
    await collect(adapter.stream(request('auto')))
    assert.equal(server.requests[0].headers.authorization, 'Bearer inline-fallback')
  } finally {
    await server.close()
  }
})

test('an unusable credential is refused as INVALID_CREDENTIAL, not sent', async () => {
  const server = await startMockServer((request_, response) => {
    writeSse(response, [chunk('ok'), '[DONE]'])
  })
  try {
    // A key outside printable ASCII cannot reach any provider: `fetch` refuses
    // to build the header at all, so it must be refused locally with a
    // diagnosis instead of surfacing as an opaque 401.
    const { adapter } = mountPlugin({
      config: { mode: 'gateway', baseURL: server.baseURL, apiKey: 'freellmapi-\u4e2d\u6587-key' },
    })
    const { finish } = assertValidChunkSequence(await collect(adapter.stream(request('auto'))))
    assert.equal(finish.kind, 'error')
    assert.equal(finish.failure.code, 'INVALID_CREDENTIAL')
    assert.equal(server.requests.length, 0)
  } finally {
    await server.close()
  }
})

test('X-Routed-Via is logged, and recorded in the ring buffer', async () => {
  clearRecentRoutes()
  const server = await startMockServer((request_, response) => {
    writeSse(response, [chunk('ok'), { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, '[DONE]'], {
      headers: { 'x-routed-via': 'groq/llama-3.3-70b', 'x-fallback-attempts': '2', 'x-fallback-trail': 'google/x key1=timeout' },
    })
  })
  try {
    const mounted = mount(server.baseURL)
    await collect(mounted.adapter.stream(request('auto')))
    assert.equal(mounted.logger.info.length, 1)
    assert.match(mounted.logger.info[0], /dsh-freellmapi: routed via groq\/llama-3\.3-70b \(model=auto\)/)
    assert.match(mounted.logger.info[0], /fallback-attempts=2/)
    assert.match(mounted.logger.info[0], /trail=google\/x key1=timeout/)

    const history = getRecentRoutes()
    assert.equal(history.length, 1)
    assert.equal(history[0].routedVia, 'groq/llama-3.3-70b')
    assert.equal(history[0].requestedModel, 'auto')
    assert.equal(history[0].requestedProvider, 'freellmapi')
    assert.equal(history[0].status, 200)
  } finally {
    await server.close()
  }
})

test('a response without X-Routed-Via logs unknown and does not fail', async () => {
  clearRecentRoutes()
  const server = await startMockServer((request_, response) => {
    writeSse(response, [chunk('ok'), { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, '[DONE]'])
  })
  try {
    const mounted = mount(server.baseURL)
    const { finish } = assertValidChunkSequence(await collect(mounted.adapter.stream(request('auto'))))
    assert.equal(finish.kind, 'stop')
    assert.match(mounted.logger.info[0], /routed via unknown \(model=auto\)/)
    assert.equal(getRecentRoutes()[0].routedVia, 'unknown')
  } finally {
    await server.close()
  }
})

test('logRoutedVia:false records the route but logs nothing', async () => {
  clearRecentRoutes()
  const server = await startMockServer((request_, response) => {
    writeSse(response, [chunk('ok'), { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, '[DONE]'], {
      headers: { 'x-routed-via': 'google/gemini-2.5-flash' },
    })
  })
  try {
    const mounted = mount(server.baseURL, { logRoutedVia: false })
    await collect(mounted.adapter.stream(request('auto')))
    assert.deepEqual(mounted.logger.info, [])
    assert.equal(getRecentRoutes()[0].routedVia, 'google/gemini-2.5-flash')
  } finally {
    await server.close()
  }
})

test('routing is reported even for a failed response', async () => {
  clearRecentRoutes()
  const server = await startMockServer((request_, response) => {
    response.writeHead(502, { 'content-type': 'application/json', 'x-routed-via': 'groq/llama-3.3-70b' })
    response.end(JSON.stringify({ error: { message: 'all providers failed' } }))
  })
  try {
    const mounted = mount(server.baseURL)
    const { finish } = assertValidChunkSequence(await collect(mounted.adapter.stream(request('auto'))))
    assert.equal(finish.failure.code, 'SERVER')
    assert.equal(getRecentRoutes()[0].routedVia, 'groq/llama-3.3-70b')
  } finally {
    await server.close()
  }
})

test('live settings edits take effect without re-registering', async () => {
  clearRecentRoutes()
  const first = await startMockServer((request_, response) => {
    writeSse(response, [chunk('one'), { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, '[DONE]'])
  })
  const second = await startMockServer((request_, response) => {
    writeSse(response, [chunk('two'), { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, '[DONE]'])
  })
  try {
    const live = liveConfig({ mode: 'gateway', baseURL: first.baseURL, apiKey: TEST_KEY, logRoutedVia: true })
    const mounted = mountPlugin({ config: live.container })
    const before = assertValidChunkSequence(await collect(mounted.adapter.stream(request('auto'))))
    assert.deepEqual(before.blocks, [{ type: 'text', text: 'one' }])

    live.set('baseURL', second.baseURL)
    const after = assertValidChunkSequence(await collect(mounted.adapter.stream(request('auto'))))
    assert.deepEqual(after.blocks, [{ type: 'text', text: 'two' }])
    assert.equal(first.requests.length, 1)
  } finally {
    await first.close()
    await second.close()
  }
})

test('prepareCall pins a configuration snapshot for the whole generation', async () => {
  const first = await startMockServer((request_, response) => {
    writeSse(response, [chunk('snapshot-1'), { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, '[DONE]'])
  })
  const second = await startMockServer((request_, response) => {
    writeSse(response, [chunk('snapshot-2'), { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, '[DONE]'])
  })
  try {
    const live = liveConfig({ mode: 'gateway', baseURL: first.baseURL, apiKey: TEST_KEY })
    const mounted = mountPlugin({ config: live.container })
    const prepared = await mounted.adapter.prepareCall('freellmapi', 'auto')
    assert.equal(prepared.model.id, 'auto')
    live.set('baseURL', second.baseURL)
    const { blocks } = assertValidChunkSequence(await collect(prepared.stream(request('auto'))))
    assert.deepEqual(blocks, [{ type: 'text', text: 'snapshot-1' }])
    assert.equal(second.requests.length, 0)
  } finally {
    await first.close()
    await second.close()
  }
})

test('the discovery offer returns runtime-shaped entries', async () => {
  const server = await startMockServer((request_, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      object: 'list',
      data: [{ id: 'auto', name: 'Auto', context_window: 128000 }, { id: 'gemini-2.5-flash' }, { id: '' }],
    }))
  })
  try {
    const mounted = mount(server.baseURL)
    const models = await mounted.discovery({ baseURL: server.baseURL }, undefined)
    assert.deepEqual(models.map((model) => model.id), ['auto', 'gemini-2.5-flash'])
    assert.equal(models[0].contextWindow, 128000)
    assert.deepEqual(models[0].inputModalities, ['text', 'image'])
    assert.match(server.requests[0].headers['user-agent'], /deepseek-harness\//)
    assert.match(server.requests[0].headers.authorization, /^Bearer /)
  } finally {
    await server.close()
  }
})

test('an unexpected upstream failure never escapes as a throw', async () => {
  const server = await startMockServer((request_, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    // Close the socket in the middle of a frame: the body read rejects.
    response.write('data: {"choices":[{"index":0,"delta":{"content":"x"')
    response.socket?.destroy()
  })
  try {
    const { adapter } = mount(server.baseURL)
    const chunks = await collect(adapter.stream(request('auto')))
    const { finish } = assertValidChunkSequence(chunks)
    assert.ok(finish.kind === 'error' || finish.kind === 'stop')
  } finally {
    await server.close()
  }
})

test('a caller abort during the response body is honoured', async () => {
  const server = await startMockServer((request_, response) => {
    writeSse(response, [chunk('a')], { end: false })
    const timer = setInterval(() => {
      try {
        response.write(`data: ${JSON.stringify(chunk('b'))}\n\n`)
      } catch {
        clearInterval(timer)
      }
    }, 10)
    response.on('close', () => clearInterval(timer))
  })
  try {
    const { adapter } = mount(server.baseURL)
    const controller = new AbortController()
    // Abort on an observed event — the first chunk has reached the caller — rather
    // than on a wall-clock guess about when the body would be streaming.
    const chunks = await collect(adapter.stream(request('auto', { signal: controller.signal })), (entry) => {
      if (entry.type === 'text-delta') controller.abort()
    })
    const { finish } = assertValidChunkSequence(chunks)
    assert.equal(finish.kind, 'aborted')
  } finally {
    await server.close()
  }
})
