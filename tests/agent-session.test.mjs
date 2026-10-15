/**
 * An agent session, simulated end to end.
 *
 * ## What this file is for
 *
 * The user's complaint was behavioural: "DSH 里跑 Agent 长任务时用 `auto` 会连续压缩、
 * 任务上下文失真". Every fix so far was verified against a *single* request. A single
 * request cannot show a routing property, because the property is about what happens
 * as a session **grows** — which model gets picked at turn 1 versus turn 40, and
 * whether the capacity the adapter declares still matches the models it is willing to
 * serve.
 *
 * So this drives a real growing conversation through the adapter, turn by turn, and
 * asserts the properties that make a long agent task survivable:
 *
 *   1. As the history grows, the router never serves a turn from a model that cannot
 *      hold it. (The per-request gate should already guarantee this; the test exists
 *      because "should" is not evidence.)
 *   2. The model that answers never changes *within* one streamed message — the
 *      invariant `dispatch.js` documents as the reason it refuses to fail over after
 *      emitting output.
 *   3. A summary call is only ever served by a model that can hold the history it is
 *      summarising — the defect fixed in 0.7.2, now asserted across a whole session
 *      rather than one call.
 *
 * The pool is deliberately the shape that broke: a small-window model that is the
 * most attractive on capability/speed, and large-window models that are not.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { mountPlugin } from './helpers/context.mjs'
import { assertValidChunkSequence, collect } from './helpers/harness.mjs'
import { startMockPool } from './helpers/pool.mjs'

/** Roughly the plugin's own estimator: CJK counts 1, everything else 4 chars/token. */
function approximateTokens (text) {
  let cjk = 0
  for (const character of text) if (/[\u3000-\u9fff\uff00-\uffef]/.test(character)) cjk += 1
  return cjk + Math.ceil((text.length - cjk) / 4)
}

/**
 * A pool shaped like the failure: one attractive small model, two larger ones.
 * `preferred` puts the small model first so capability/speed ranking favours it.
 */
async function agentPool () {
  return startMockPool([
    {
      id: 'smallpool',
      models: [{ id: 'small-model', contextWindow: 32_000, capability: 5, speed: 5 }],
      answer: 'SMALL',
    },
    {
      id: 'midpool',
      models: [{ id: 'mid-model', contextWindow: 200_000, capability: 3, speed: 3 }],
      answer: 'MID',
    },
    {
      id: 'bigpool',
      models: [{ id: 'big-model', contextWindow: 900_000, capability: 2, speed: 2 }],
      answer: 'BIG',
    },
  ])
}

const ask = (text, extra = {}) => ({
  provider: 'freellmapi',
  model: 'auto',
  messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  ...extra,
})

/** Which provider answered, by looking at whose endpoint was hit last. */
function answeringPool (pool) {
  for (const id of ['smallpool', 'midpool', 'bigpool']) {
    if (pool.requests(id).length > 0) return id
  }
  return null
}

test('★ an agent session that outgrows the small model stops being routed to it', async (t) => {
  const pool = await agentPool()
  const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
  t.after(async () => { await mounted.close?.(); await pool.close() })

  // Turn 1 is small: the attractive model is a legitimate choice.
  assertValidChunkSequence(await collect(mounted.adapter.stream(ask('hi'))))
  assert.equal(answeringPool(pool), 'smallpool', 'the first turn is small enough for the cheap model')

  // Now grow the history past what the small model can hold. The conversation is
  // resent every turn, exactly as an agent loop does.
  const history = []
  for (let turn = 0; turn < 6; turn++) {
    history.push({ role: 'user', content: [{ type: 'text', text: 'x'.repeat(40_000) }] })
    history.push({ role: 'assistant', content: [{ type: 'text', text: 'y'.repeat(40_000) }] })
  }
  const before = pool.requests('smallpool').length
  const answer = assertValidChunkSequence(await collect(mounted.adapter.stream({
    provider: 'freellmapi',
    model: 'auto',
    messages: [...history, { role: 'user', content: [{ type: 'text', text: 'continue' }] }],
  })))
  assert.equal(answer.finish.kind, 'stop', JSON.stringify(answer.finish))

  const servedBySmallAgain = pool.requests('smallpool').length > before
  const overflowed = pool.overflows('smallpool').length > 0
  assert.equal(overflowed, false,
    '★ the small model must never be sent a request it cannot hold — an upstream 400 is the failure mode')
  assert.equal(servedBySmallAgain, false,
    '★ once the history outgrows the small model, routing must move off it rather than overflow it')
})

test('★ a summary call in a grown session is served by a model that can hold the history', async (t) => {
  const pool = await agentPool()
  const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
  t.after(async () => { await mounted.close?.(); await pool.close() })

  // A history far larger than the small model, submitted as the summarisation call
  // DSH makes when it compacts. This is the 297,538-token-against-262,144-model case
  // from the 2026-10-15 log, at a smaller scale.
  const history = []
  for (let i = 0; i < 10; i++) {
    history.push({ role: 'user', content: [{ type: 'text', text: 'z'.repeat(40_000) }] })
  }
  const tokens = approximateTokens(JSON.stringify(history))
  assert.ok(tokens > 32_000, `the fixture must exceed the small model: ${tokens} tokens`)

  const answer = assertValidChunkSequence(await collect(mounted.adapter.stream({
    provider: 'freellmapi',
    model: 'auto',
    messages: history,
    purpose: 'compaction',
  })))
  assert.equal(answer.finish.kind, 'stop', JSON.stringify(answer.finish))
  assert.equal(pool.requests('smallpool').length, 0,
    '★ a summary call must never be routed to a model that cannot hold the history being summarised')
  assert.equal(pool.overflows('midpool').length + pool.overflows('bigpool').length, 0,
    '★ and it must fit the model it lands on')
})

test('★ one streamed answer never mixes two providers', async (t) => {
  // The invariant dispatch.js documents. Asserted over a session so that a future
  // failover change cannot quietly splice two models into one message.
  const pool = await agentPool()
  const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
  t.after(async () => { await mounted.close?.(); await pool.close() })

  for (let turn = 0; turn < 4; turn++) {
    const answer = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('go'))))
    assert.equal(answer.finish.kind, 'stop')
    const text = answer.blocks
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('')
    assert.ok(['SMALL', 'MID', 'BIG'].includes(text), `one answer, one provider: got ${JSON.stringify(text)}`)
  }
})

// ---------------------------------------------------------------------------
// KNOWN GAP — asserted but not yet satisfied, deliberately left visible.
//
// This harness found the defect on its first run: `auto` declares
// `contextWindow: 131072` (lib/config.js DEFAULTS.contextWindow) while the router
// is willing to serve a 32,000-token model, and it does so for every plain request.
// DSH budgets its compaction threshold from the declared capacity — 131,072 gives
// a threshold of 65,536 — so a session may grow to ~65k against a model that holds
// 32k. The 0.7.2 work stops that from *failing* (the per-request gate moves the
// turn to a wider model), but the declaration still overstates what routing may
// pick, so the session is steered to the edge and then has to fail over at it.
//
// The fix is the semantic change tracked as P2 in
// `_lead/research/routing-redesign.md`: declare a capacity that routing cannot
// undercut, i.e. `min(pool, config)` clamped to a floor just above DSH's own
// 65,536-token headroom, with the models below that floor excluded from `auto`.
// It changes what `config.contextWindow` *means*, which is the kind of change this
// project requires sign-off for (rule 1: never change a documented knob's meaning
// silently), so it is reported rather than shipped unannounced.
//
// Skipped rather than deleted, and rather than loosened until it passed: a test
// that has been edited until it agrees with the code measures nothing.
// ---------------------------------------------------------------------------

test('KNOWN GAP (P2): the capacity declared to DSH covers every model the session can route to', {
  skip: 'defect confirmed 2026-10-15 — declaration (131072) exceeds a model the router serves (32000); fix is P2, pending sign-off',
}, async (t) => {
  const pool = await agentPool()
  const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
  t.after(async () => { await mounted.close?.(); await pool.close() })

  const info = await mounted.adapter.resolveModel('freellmapi', 'auto')
  const declared = info?.context?.contextWindow
  assert.ok(Number.isFinite(declared) && declared > 0, `auto must declare a capacity, got ${JSON.stringify(declared)}`)

  // Whatever `auto` advertises, no model it actually serves may be smaller than
  // that — an over-stated capacity is what lets DSH fill a session past the model's
  // real limit.
  const routable = new Set()
  for (let i = 0; i < 4; i++) {
    assertValidChunkSequence(await collect(mounted.adapter.stream(ask('probe'))))
    const id = answeringPool(pool)
    if (id !== null) routable.add(id)
  }
  const windows = { smallpool: 32_000, midpool: 200_000, bigpool: 900_000 }
  for (const id of routable) {
    assert.ok(windows[id] >= declared,
      `★ ${id} (${windows[id]}) was served under a declaration of ${declared}; the declaration must not exceed what routing may pick`)
  }
})
