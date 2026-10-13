/**
 * Context-window handling: the shipped data, the safety margin, and what happens
 * when a request is too big for the model the router picked.
 *
 * ## The failure this file exists for
 *
 * A real 297,538-token session was routed to `kilo/nvidia/nemotron-3-super-120b-a12b:free`
 * because the pool claimed that model had a 1,000,000-token window. Upstream
 * answered HTTP 400 ("maximum context length is 262144 tokens"), and that was the
 * end of the request — even though the pool also contained a model that really
 * does hold 1,000,000 tokens, mislabelled as 131,072 and therefore *excluded*
 * before dispatch. One wrong number caused both "picked the wrong model" and
 * "skipped the right one".
 *
 * Two blind spots made it invisible to the suite, and both are closed here:
 * the mock never enforced a context limit, and nothing asserted which candidate a
 * large request actually reaches.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeConfig, ROUTING_DEFAULTS } from '../lib/config.js'
import { BUILTIN_PROVIDERS, isProviderUsable } from '../lib/providers.js'
import { assertValidChunkSequence, collect } from './helpers/harness.mjs'
import { mountPlugin } from './helpers/context.mjs'
import { model, startMockPool } from './helpers/pool.mjs'

const ask = (model, text, extra = {}) => ({
  provider: 'freellmapi',
  model,
  messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  ...extra,
})

/** ASCII filler that the plugin's estimator (and the mock's) counts at 4 chars/token. */
const filler = (tokens) => 'x'.repeat(tokens * 4)

const totalRequests = (pool) => [...pool.endpoints.values()].reduce((sum, mock) => sum + mock.requests.length, 0)

// ---------------------------------------------------------------------------
// ★ the shipped numbers
// ---------------------------------------------------------------------------

test('★ the kilo context windows match what the upstream endpoint reports', () => {
  // Measured 2026-10-13 from `GET https://api.kilo.ai/api/gateway/models`.
  const expected = {
    'nvidia/nemotron-3-super-120b-a12b:free': 262_144,
    'nvidia/nemotron-3-ultra-550b-a55b:free': 1_000_000,
    'poolside/laguna-s-2.1:free': 262_144,
    'cohere/north-mini-code:free': 256_000,
  }
  const kilo = BUILTIN_PROVIDERS.find((provider) => provider.id === 'kilo')
  assert.ok(kilo, 'the kilo provider must exist')
  for (const [id, contextWindow] of Object.entries(expected)) {
    const entry = kilo.models.find((candidate) => candidate.id === id)
    assert.ok(entry, `${id} must be in the pool`)
    assert.equal(entry.caps.contextWindow, contextWindow, `${id} contextWindow`)
    assert.match(entry.source, /measured 2026-10-13/, `${id} must record where the number came from`)
  }
})

test('★ the pool contains a model that can hold the session size that failed', () => {
  // The user's real session. Before the fix the widest *reachable* window in the
  // pool was believed to be 1,000,000 but the real ones were 262,144 / 256,000, so
  // nothing could hold it. After the fix the honest maximum is 1,000,000.
  const enabled = BUILTIN_PROVIDERS.filter((provider) => provider.enabled === true)
  let widest = 0
  let widestId
  for (const provider of enabled) {
    for (const entry of provider.models) {
      if (entry.caps.contextWindow > widest) {
        widest = entry.caps.contextWindow
        widestId = `${provider.id}/${entry.id}`
      }
    }
  }
  assert.ok(widest >= 297_538, `the pool must be able to hold a 297,538-token session, widest is ${widest} (${widestId})`)
})

test('the safety margin default is shipped and configurable', () => {
  assert.equal(ROUTING_DEFAULTS.contextSafetyFactor, 1.15)
  assert.equal(normalizeConfig({}).routing.contextSafetyFactor, 1.15)
  assert.equal(normalizeConfig({ routing: { contextSafetyFactor: 1 } }).routing.contextSafetyFactor, 1)
  // A margin below 1 would make the gate less conservative than the estimate.
  assert.equal(normalizeConfig({ routing: { contextSafetyFactor: 0.5 } }).routing.contextSafetyFactor, 1.15)
  assert.equal(normalizeConfig({ routing: { contextSafetyFactor: 'wide' } }).routing.contextSafetyFactor, 1.15)
})

// ---------------------------------------------------------------------------
// ★ the reproduction: a ~300k-token request must reach the model that can hold it
// ---------------------------------------------------------------------------

/** A pool whose windows straddle the user's session size, exactly like the real one. */
async function straddlingPool() {
  return startMockPool([
    // The model that *looked* biggest and used to be chosen: it cannot hold 300k.
    { id: 'narrow', answer: 'NARROW', models: [model({ id: 'narrow-model', capability: 5, speed: 4, contextWindow: 262_144 })] },
    // The model that can hold it, which used to be excluded by a wrong label.
    { id: 'wide', answer: 'WIDE', models: [model({ id: 'wide-model', capability: 3, speed: 3, contextWindow: 1_000_000 })] },
  ])
}

test('★ a ~300k-token request is routed to the model that can hold it', async () => {
  const pool = await straddlingPool()
  try {
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
    const result = assertValidChunkSequence(await collect(mounted.adapter.stream(
      ask('auto', `summarise this:\n${filler(300_000)}`),
    )))

    assert.equal(result.finish.kind, 'stop', 'the request must be answered, not failed')
    assert.equal(result.blocks.map((block) => block.text).join(''), 'WIDE')
    // ★ The selection assertion: the 262,144-token model must not even be asked.
    assert.equal(pool.requests('narrow').length, 0, 'a model that cannot hold the request must not be dispatched to')
    assert.equal(pool.overflows('narrow').length, 0, 'and no overflow may have been provoked to find that out')
    assert.equal(pool.requests('wide').length, 1)
  } finally {
    await pool.close()
  }
})

test('★ the real-world pair: 262,144 is refused for 300k and 1,000,000 serves it', async () => {
  // Mirrors the shipped kilo numbers, so this is the user's incident replayed.
  const pool = await startMockPool([
    { id: 'super', answer: 'SUPER', models: [model({ id: 'super-120b', capability: 5, speed: 3, contextWindow: 262_144 })] },
    { id: 'ultra', answer: 'ULTRA', models: [model({ id: 'ultra-550b', capability: 5, speed: 3, contextWindow: 1_000_000 })] },
  ])
  try {
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
    const result = assertValidChunkSequence(await collect(mounted.adapter.stream(
      ask('auto', filler(297_538)),
    )))
    assert.equal(result.finish.kind, 'stop')
    assert.equal(result.blocks.map((block) => block.text).join(''), 'ULTRA')
    assert.equal(pool.requests('super').length, 0)
  } finally {
    await pool.close()
  }
})

// ---------------------------------------------------------------------------
// ★ when the first choice says "too long anyway"
// ---------------------------------------------------------------------------

test('★ an upstream context overflow moves to a strictly wider model, never a narrower one', async () => {
  // `liar` advertises more than it enforces, so the gate lets it through and the
  // endpoint itself answers 400. Only `roomy` (strictly wider) may be tried next;
  // `tighter` must not be.
  const pool = await startMockPool([
    { id: 'liar', answer: 'LIAR', models: [model({ id: 'liar-model', capability: 5, speed: 5, contextWindow: 300_000 })] },
    { id: 'tighter', answer: 'TIGHTER', models: [model({ id: 'tighter-model', capability: 5, speed: 5, contextWindow: 200_000 })] },
    { id: 'roomy', answer: 'ROOMY', models: [model({ id: 'roomy-model', capability: 3, speed: 3, contextWindow: 400_000 })] },
  ])
  try {
    // Make `liar` enforce less than it advertises (a drifting catalogue).
    const liar = pool.endpoints.get('liar')
    liar.setContextWindow('liar-model', 100_000)
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
    const result = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('auto', filler(250_000)))))

    assert.equal(result.finish.kind, 'stop', `expected a successful failover, got ${JSON.stringify(result.finish)}`)
    assert.equal(result.blocks.map((block) => block.text).join(''), 'ROOMY')
    assert.equal(liar.overflows.length, 1, 'the overflow must have been provoked on the lying endpoint')
    assert.equal(pool.requests('tighter').length, 0, 'a narrower model must never be tried after an overflow')
    assert.equal(pool.requests('roomy').length, 1)
  } finally {
    await pool.close()
  }
})

test('★ an overflow does not park the provider', async () => {
  const pool = await startMockPool([
    { id: 'liar', answer: 'LIAR', models: [model({ id: 'liar-model', capability: 5, speed: 5, contextWindow: 300_000 })] },
    { id: 'roomy', answer: 'ROOMY', models: [model({ id: 'roomy-model', capability: 3, speed: 3, contextWindow: 400_000 })] },
  ])
  try {
    pool.endpoints.get('liar').setContextWindow?.('liar-model', 100_000)
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
    await collect(mounted.adapter.stream(ask('auto', filler(250_000))))
    const snapshot = mounted.adapter.health.snapshot('liar', 'liar-model')
    assert.equal(snapshot.cooldownUntil, 0, 'being too small is not a fault: nothing may be parked')
    assert.equal(snapshot.failures, 0, 'and it must not count as a failure either')
    assert.equal(mounted.adapter.health.isAvailable('liar', 'liar-model'), true)
  } finally {
    await pool.close()
  }
})

test('★ a failed attempt followed by no wider model reports the observed ceiling', async () => {
  // The path the reproduction script caught: one candidate actually answered 400,
  // then every remaining candidate was narrower, so the loop ended without a
  // second attempt. The diagnosis must be a context error — not a crash, and not
  // the generic "every candidate failed".
  const pool = await startMockPool([
    { id: 'liar', answer: 'LIAR', models: [model({ id: 'liar-model', capability: 5, speed: 5, contextWindow: 400_000 })] },
    { id: 'smaller', answer: 'SMALLER', models: [model({ id: 'smaller-model', capability: 4, speed: 4, contextWindow: 300_000 })] },
  ])
  try {
    pool.endpoints.get('liar').setContextWindow('liar-model', 100_000)
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
    const result = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('auto', filler(250_000)))))

    assert.equal(result.finish.kind, 'error')
    assert.equal(result.finish.failure.code, 'CONTEXT_WINDOW_EXCEEDED')
    const message = result.finish.failure.message
    assert.match(message, /250\d{3}/, `must state the estimate: ${message}`)
    assert.match(message, /400000|400,000/, `must state the ceiling that refused it: ${message}`)
    assert.match(message, /400000|400,000/, 'and the pool maximum')
    assert.equal(pool.requests('smaller').length, 0, 'a narrower model must not be tried')
  } finally {
    await pool.close()
  }
})

test('★ every candidate too small: the error names the estimate and the pool maximum', async () => {
  const pool = await startMockPool([
    { id: 'small', answer: 'S', models: [model({ id: 'small-model', capability: 5, speed: 5, contextWindow: 100_000 })] },
    { id: 'medium', answer: 'M', models: [model({ id: 'medium-model', capability: 4, speed: 4, contextWindow: 200_000 })] },
  ])
  try {
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
    const result = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('auto', filler(400_000)))))

    assert.equal(result.finish.kind, 'error')
    assert.equal(result.finish.failure.code, 'CONTEXT_WINDOW_EXCEEDED')
    const message = result.finish.failure.message
    assert.match(message, /4\d{5} estimated input tokens|400\d{3} estimated input tokens/, `must state the estimate: ${message}`)
    assert.match(message, /200000|200,000/, `must state the pool maximum: ${message}`)
    assert.match(message, /medium\/medium-model/, 'must name the widest model it could reach')
    assert.equal(totalRequests(pool), 0, 'nothing may be dispatched when nothing fits')
    assert.equal(result.blocks.length, 0)
  } finally {
    await pool.close()
  }
})

// ---------------------------------------------------------------------------
// ★ the hard invariant still wins
// ---------------------------------------------------------------------------

test('★ a context overflow after output has been emitted does not fail over', async () => {
  const pool = await startMockPool([
    {
      id: 'early',
      models: [model({ id: 'early-model', capability: 5, speed: 5, contextWindow: 1_000_000 })],
      respond: ({ response }) => {
        // Emit one content frame, then an in-band "too long" frame — the boundary
        // case that must not splice two providers into one answer.
        //
        // Both frames are written back to back on purpose: SSE frame order is
        // enforced by the byte stream, so the plugin is guaranteed to yield the
        // text delta (setting `emittedHere`) before it sees the error frame. A
        // timer here would add nothing but a race.
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'partial ' }, finish_reason: null }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ error: { message: "This endpoint's maximum context length is 1024 tokens.", code: 'context_length_exceeded' } })}\n\n`)
        response.end()
        return true
      },
    },
    { id: 'backup', answer: 'BACKUP', models: [model({ id: 'backup-model', capability: 3, speed: 3, contextWindow: 2_000_000 })] },
  ])
  try {
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
    const result = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('auto', filler(10_000)))))

    assert.equal(result.finish.kind, 'error')
    assert.equal(pool.requests('backup').length, 0, '★ the hard invariant: no failover once output was emitted')
    assert.equal(result.blocks.map((block) => block.text).join('').includes('BACKUP'), false)
  } finally {
    await pool.close()
  }
})

// ---------------------------------------------------------------------------
// regressions
// ---------------------------------------------------------------------------

test('a pinned model that is too small is still refused, not swapped', async () => {
  const pool = await straddlingPool()
  try {
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
    const result = assertValidChunkSequence(await collect(mounted.adapter.stream(
      ask('narrow/narrow-model', filler(300_000)),
    )))
    assert.equal(result.finish.kind, 'error')
    assert.equal(result.finish.failure.code, 'MODEL_UNAVAILABLE')
    assert.equal(totalRequests(pool), 0, 'a pinned model must never be replaced by a wider one')
  } finally {
    await pool.close()
  }
})

test('auto still routes small requests normally, margin and all', async () => {
  const pool = await startMockPool([
    { id: 'fastmock', answer: 'FAST', models: [model({ id: 'fast-weak', capability: 2, speed: 5 })] },
    { id: 'strongmock', answer: 'STRONG', models: [model({ id: 'strong-slow', capability: 5, speed: 2 })] },
  ])
  try {
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
    const result = assertValidChunkSequence(await collect(mounted.adapter.stream(
      ask('auto', '列出这个目录下的文件'),
    )))
    assert.equal(result.finish.kind, 'stop')
    assert.equal(pool.requests('fastmock').length, 1)
  } finally {
    await pool.close()
  }
})

test('the mock really does enforce the window it advertises', async () => {
  // A meta-assertion: without this the whole file could pass against a mock that
  // ignores request size, which is how the original defect escaped.
  const pool = await startMockPool([
    { id: 'tiny', answer: 'TINY', models: [model({ id: 'tiny-model', contextWindow: 1_000 })] },
  ])
  try {
    const mounted = mountPlugin({
      config: { mode: 'direct', providers: { ...pool.config, tiny: { ...pool.config.tiny, models: [{ ...pool.config.tiny.models[0], contextWindow: 10_000_000 }] } } },
    })
    // The pool advertises a huge window, so the gate lets it through; the endpoint
    // still enforces the 1,000 tokens it was constructed with.
    const result = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('auto', filler(5_000)))))
    assert.equal(result.finish.kind, 'error')
    assert.equal(pool.overflows('tiny').length, 1, 'the mock must have refused the oversized request itself')
    assert.equal(pool.requests('tiny')[0].body.model, 'tiny-model')
  } finally {
    await pool.close()
  }
})

test('a provider marked usable is the one the pool can actually reach', () => {
  // Guards the fixture: `isProviderUsable` must agree with how the mocks are built.
  assert.equal(isProviderUsable({ keyless: true }, undefined), true)
  assert.equal(isProviderUsable({ keyless: false }, undefined), false)
  assert.equal(isProviderUsable({ keyless: false }, 'test-key-not-real'), true)
})
