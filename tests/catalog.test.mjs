/**
 * Catalog, discovery and routing-observability tests.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { AUTO_MODEL, ModelDiscovery, buildCatalog, builtinRoutes, parseModelsPayload } from '../lib/catalog.js'
import {
  ROUTE_HISTORY_LIMIT,
  clearRecentRoutes,
  formatRouteLine,
  getRecentRoutes,
  normalizeHeaderValue,
  readRoutingHeaders,
  recordRoute,
  reportRoute,
} from '../lib/routes.js'
import { startMockServer } from './helpers/harness.mjs'

test('auto is advertised first, followed by the five strategies', () => {
  const catalog = buildCatalog({ provider: 'freellmapi' })
  assert.equal(catalog[0].id, AUTO_MODEL)
  assert.deepEqual(catalog.slice(1, 6).map((entry) => entry.id), [
    'auto:smart', 'auto:fast', 'auto:cheap', 'auto:reliable', 'auto:balanced',
  ])
  assert.equal(catalog[6].id, 'fusion')
  for (const entry of catalog) {
    assert.equal(entry.provider, 'freellmapi')
    assert.ok(entry.name.length > 0)
    assert.ok(entry.inputModalities.includes('text'))
  }
})

test('fusion can be switched off', () => {
  const catalog = buildCatalog({ provider: 'freellmapi', includeFusion: false })
  assert.equal(catalog.some((entry) => entry.id === 'fusion'), false)
})

test('vision:false advertises text-only modalities', () => {
  const catalog = buildCatalog({ provider: 'freellmapi', vision: false })
  assert.deepEqual(catalog[0].inputModalities, ['text'])
})

test('discovered models are appended and duplicates are removed', () => {
  const catalog = buildCatalog({ provider: 'freellmapi' }, [
    { id: 'auto', name: 'should be dropped' },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
    { id: 'llama-3.3-70b' },
    { id: '' },
  ])
  const ids = catalog.map((entry) => entry.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(ids.at(-2), 'gemini-2.5-flash')
  assert.equal(ids.at(-1), 'llama-3.3-70b')
  assert.equal(catalog.find((entry) => entry.id === 'llama-3.3-70b').name, 'llama-3.3-70b')
})

test('parseModelsPayload reads the OpenAI list shape and the added context fields', () => {
  const models = parseModelsPayload({
    object: 'list',
    data: [
      { id: 'auto', object: 'model', name: 'Auto (router picks the best available model)', context_window: 128000 },
      { id: 'fusion', object: 'model', context_length: 64000 },
      { id: 'gemini-2.5-flash', object: 'model', created: 1, owned_by: 'google' },
      { id: 42 },
      null,
    ],
  })
  assert.deepEqual(models, [
    { id: 'auto', name: 'Auto (router picks the best available model)', contextWindow: 128000 },
    { id: 'fusion', contextWindow: 64000 },
    { id: 'gemini-2.5-flash' },
  ])
})

test('parseModelsPayload tolerates junk', () => {
  assert.deepEqual(parseModelsPayload(null), [])
  assert.deepEqual(parseModelsPayload({ data: 'nope' }), [])
})

test('ModelDiscovery caches a successful listing', async () => {
  let hits = 0
  const server = await startMockServer((request, response) => {
    hits += 1
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ object: 'list', data: [{ id: 'm1' }, { id: 'm2' }] }))
  })
  try {
    const discovery = new ModelDiscovery({ cacheMs: 60_000, timeoutMs: 2_000 })
    const first = await discovery.list({ baseURL: server.baseURL })
    const second = await discovery.list({ baseURL: server.baseURL })
    assert.deepEqual(first.map((model) => model.id), ['m1', 'm2'])
    assert.equal(second.length, 2)
    assert.equal(hits, 1, 'a fresh cache entry must not re-request')
    assert.equal(discovery.find('m1').id, 'm1')
  } finally {
    await server.close()
  }
})

test('ModelDiscovery never throws when the gateway is down', async () => {
  const discovery = new ModelDiscovery({ cacheMs: 0, timeoutMs: 500 })
  const models = await discovery.list({ baseURL: 'http://127.0.0.1:1/v1' })
  assert.deepEqual(models, [])
  assert.notEqual(discovery.error, '')
})

test('ModelDiscovery reports a non-2xx status without throwing', async () => {
  const server = await startMockServer((request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'Missing or invalid API key' } }))
  })
  try {
    const discovery = new ModelDiscovery({ cacheMs: 0, timeoutMs: 2_000 })
    assert.deepEqual(await discovery.list({ baseURL: server.baseURL }), [])
    assert.equal(discovery.error, 'HTTP 401')
  } finally {
    await server.close()
  }
})

test('readRoutingHeaders prefers X-Routed-Via and decodes percent-escapes', () => {
  const response = {
    headers: {
      get(name) {
        if (name === 'x-routed-via') return 'groq/llama-3.3-70b'
        if (name === 'x-fallback-attempts') return '2'
        if (name === 'x-fallback-trail') return 'groq/x key1=rate_limited'
        return null
      },
    },
  }
  assert.deepEqual(readRoutingHeaders(response), {
    routedVia: 'groq/llama-3.3-70b',
    fallbackAttempts: 2,
    fallbackTrail: 'groq/x key1=rate_limited',
  })
  assert.equal(normalizeHeaderValue('google%2Fgemini-2.5-flash'), 'google/gemini-2.5-flash')
  assert.equal(normalizeHeaderValue('%E4%B8%AD%E6%96%87'), '中文')
  assert.equal(normalizeHeaderValue('%zz'), '%zz')
  assert.equal(normalizeHeaderValue(null), 'unknown')
  assert.equal(normalizeHeaderValue('   '), 'unknown')
})

test('a response without X-Routed-Via records unknown instead of failing', () => {
  assert.deepEqual(readRoutingHeaders({ headers: { get: () => null } }), { routedVia: 'unknown' })
  assert.deepEqual(readRoutingHeaders({}), { routedVia: 'unknown' })
  assert.deepEqual(readRoutingHeaders(undefined), { routedVia: 'unknown' })
})

test('reportRoute logs the documented line and records it', () => {
  clearRecentRoutes()
  const lines = []
  const record = reportRoute(
    { logger: { info: (line) => lines.push(line) }, enabled: true, now: () => 1_700_000_000_000 },
    { routedVia: 'groq/llama-3.3-70b', requestedModel: 'auto', requestedProvider: 'freellmapi', status: 200 },
  )
  assert.equal(record.at, 1_700_000_000_000)
  assert.deepEqual(lines, ['dsh-freellmapi: routed via groq/llama-3.3-70b (model=auto)'])
  assert.equal(getRecentRoutes().length, 1)
})

test('reportRoute appends the fallback trail when the router fell back', () => {
  clearRecentRoutes()
  const lines = []
  reportRoute(
    { logger: { info: (line) => lines.push(line) }, enabled: true },
    { routedVia: 'google/gemini-2.5-flash', requestedModel: 'auto:fast', fallbackAttempts: 2, fallbackTrail: 'groq/x key1=rate_limited' },
  )
  assert.equal(
    lines[0],
    'dsh-freellmapi: routed via google/gemini-2.5-flash (model=auto:fast) fallback-attempts=2 trail=groq/x key1=rate_limited',
  )
})

test('reportRoute records without logging when the switch is off', () => {
  clearRecentRoutes()
  const lines = []
  reportRoute(
    { logger: { info: (line) => lines.push(line) }, enabled: false },
    { routedVia: 'groq/x', requestedModel: 'auto' },
  )
  assert.deepEqual(lines, [])
  assert.equal(getRecentRoutes().length, 1)
})

test('reportRoute survives a missing or throwing logger', () => {
  clearRecentRoutes()
  assert.doesNotThrow(() => reportRoute({}, { routedVia: 'a/b', requestedModel: 'auto' }))
  assert.doesNotThrow(() => reportRoute(
    { logger: { info() { throw new Error('logger exploded') } }, enabled: true },
    { routedVia: 'a/b', requestedModel: 'auto' },
  ))
  assert.equal(getRecentRoutes().length, 2)
})

test('the ring buffer keeps only the most recent entries, oldest first', () => {
  clearRecentRoutes()
  for (let index = 0; index < ROUTE_HISTORY_LIMIT + 10; index += 1) {
    recordRoute({ at: index, routedVia: `p/m${index}`, requestedModel: 'auto' })
  }
  const history = getRecentRoutes()
  assert.equal(history.length, ROUTE_HISTORY_LIMIT)
  assert.equal(history[0].routedVia, 'p/m10')
  assert.equal(history.at(-1).routedVia, `p/m${ROUTE_HISTORY_LIMIT + 9}`)
  // The exported copy must not be the live buffer.
  history.length = 0
  assert.equal(getRecentRoutes().length, ROUTE_HISTORY_LIMIT)
  clearRecentRoutes()
  assert.deepEqual(getRecentRoutes(), [])
})

test('formatRouteLine omits absent optional detail', () => {
  assert.equal(
    formatRouteLine({ at: 0, routedVia: 'x/y', requestedModel: 'auto' }),
    'dsh-freellmapi: routed via x/y (model=auto)',
  )
})

test('builtinRoutes always yields at least the bare auto route', () => {
  assert.equal(builtinRoutes()[0].id, 'auto')
})
