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

test('★ an agent session never routes to a model below the capacity `auto` declares', async (t) => {
  const pool = await agentPool()
  const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
  t.after(async () => { await mounted.close?.(); await pool.close() })

  const declared = (await mounted.adapter.resolveModel('freellmapi', 'auto'))?.context?.contextWindow
  assert.ok(Number.isFinite(declared) && declared > 0, `auto must declare a capacity, got ${JSON.stringify(declared)}`)

  // Even the smallest request must be served by a model that can hold the capacity
  // we taught DSH to budget — otherwise the declaration is a promise routing breaks.
  assertValidChunkSequence(await collect(mounted.adapter.stream(ask('hi'))))
  const windows = { smallpool: 32_000, midpool: 200_000, bigpool: 900_000 }
  const first = answeringPool(pool)
  assert.notEqual(first, null, 'a model must have answered')
  assert.ok(windows[first] >= declared,
    `★ ${first} (${windows[first]}) answered under a declaration of ${declared}`)

  // And it must hold as the history grows, too: no turn may land on a model below
  // the declared capacity, and none may be overflowed.
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

  assert.equal(pool.requests('smallpool').length > before, false,
    '★ nothing below the declared capacity may be served under `auto`')
  assert.equal(pool.overflows('smallpool').length, 0,
    '★ and the excluded model must never receive a request it cannot hold')
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
// The contract that made compaction behave badly, now enforced.
//
// `auto` is ONE model name standing for a pool whose windows differ by more than
// an order of magnitude, and DSH budgets its compaction threshold from the capacity
// declared for it. On 2026-10-15 this harness found the declaration at 131,072
// while a 32,000-token model served every plain request — so a session could grow
// to ~65k against a model holding 32k, and then fail over at the edge.
//
// The declaration is now `min(pool, config)` floored at 131,072 (a lower floor
// would collapse DSH's threshold to ~1 and compact on every step), and models
// below it are excluded from `auto` with a reason naming the contract. The test
// below is the acceptance criterion that drove the change, so it is no longer
// skipped.
// ---------------------------------------------------------------------------

test('★ a pool that cannot reach the floor declares what it can serve, not the configured ceiling', async (t) => {
  // The distinguishing case. With a pool that reaches the floor (the harness above)
  // both the correct rule and the naive `config.contextWindow` happen to return
  // 131,072, so that fixture cannot tell them apart. A pool of only-small models
  // separates them: the naive rule would declare 131,072 for models that hold
  // 32,000 — the original defect — while the correct rule declares what the pool
  // can serve.
  const pool = await startMockPool([
    { id: 'smallpool', models: [{ id: 'small-a', contextWindow: 32_000 }, { id: 'small-b', contextWindow: 48_000 }] },
  ])
  const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
  t.after(async () => { await mounted.close?.(); await pool.close() })

  const declared = (await mounted.adapter.resolveModel('freellmapi', 'auto'))?.context?.contextWindow
  assert.ok(Number.isFinite(declared) && declared > 0, `auto must declare a capacity, got ${JSON.stringify(declared)}`)
  assert.ok(declared <= 48_000,
    `★ the declaration must not exceed the widest model this pool can serve, got ${declared}`)
  // And the pool still works: a small-only pool must not be emptied by the rule.
  const answer = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('hi'))))
  assert.equal(answer.finish.kind, 'stop',
    `a pool below the floor must remain usable: ${JSON.stringify(answer.finish)}`)
})

test('★ the capacity declared to DSH covers every model the session can route to', async (t) => {
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
