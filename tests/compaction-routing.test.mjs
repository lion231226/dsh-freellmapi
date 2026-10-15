/**
 * A **context-summarisation** call must not be routed like a normal step.
 *
 * ## Why this file exists
 *
 * DSH compresses a long session by asking a model to summarise the span it is
 * about to drop, so that call carries the *whole history being compressed* as its
 * input. Two things were measured on 2026-10-15 from a durable session log, and
 * both of them made compaction fail in a loop:
 *
 *   1. The call was routed to a 262,144-token model with about 297,538 tokens of
 *      input and came back `maximum context length is 262144 tokens. However, you
 *      requested about 297538 tokens`. The compaction could therefore **never**
 *      succeed, and the session never got smaller.
 *   2. Two other compaction attempts failed with `SETUP_REQUIRED` for the model
 *      id `setup:groq` — a *guidance row*, which is not a model at all. The
 *      session's active route happened to be that row, and the summary call was
 *      pinned to it.
 *
 * Both are tested here against the two properties that fix them: a summary call
 * is **never pinned**, and it is subject to an absolute **capacity floor**.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { assertValidChunkSequence, collect } from './helpers/harness.mjs'
import { mountPlugin } from './helpers/context.mjs'
import { startMockPool } from './helpers/pool.mjs'

/** A window comfortably above the default compaction floor. */
const BIG = 400_000
/** A window comfortably below it, but still large enough for an ordinary request. */
const SMALL = 64_000

const ask = (text, extra = {}) => ({
  provider: 'freellmapi',
  model: 'auto',
  messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  ...extra,
})

/** Mount a direct-mode plugin over one mock endpoint, optionally re-keyed. */
async function mountWith (models, { override = {}, credentials } = {}) {
  const pool = await startMockPool([{ id: 'mockpool', models }])
  const mounted = mountPlugin({
    config: {
      mode: 'direct',
      providers: { ...pool.config, ...override },
    },
    services: credentials === undefined ? undefined : { credentials },
  })
  const routedModels = () => pool.requests('mockpool').map((entry) => entry.body?.model)
  return { pool, mounted, routedModels }
}

test('★ a compaction call pinned to a guidance row routes across the pool instead of failing', async (t) => {
  // `setup:groq` exists because groq is enabled while no credential resolves for
  // it: the user is being told to paste a key. That row is answerable for a
  // *normal* step (SETUP_REQUIRED, so the user learns what to do), but it can
  // never serve a summary.
  const { pool, mounted, routedModels } = await mountWith(
    [{ id: 'big-model', contextWindow: BIG }],
    { override: { groq: { enabled: true } }, credentials: { resolve: () => Promise.resolve(undefined) } },
  )
  t.after(async () => { await mounted.close?.(); await pool.close() })

  // The regression: pinned to the guidance row, as the log shows.
  const compact = assertValidChunkSequence(await collect(mounted.adapter.stream(
    ask('summarise the conversation so far', { model: 'setup:groq', purpose: 'compaction' }),
  )))
  assert.equal(compact.finish.kind, 'stop', `a summary call must be served, not refused: ${JSON.stringify(compact.finish)}`)
  assert.deepEqual(routedModels(), ['big-model'], 'the summary went to the real pool model')

  // The same pinned row on a *normal* step must still explain itself — the fix
  // must not swallow the guidance branch.
  const normal = assertValidChunkSequence(await collect(mounted.adapter.stream(
    ask('hello', { model: 'setup:groq' }),
  )))
  assert.equal(normal.finish.kind, 'error', 'a normal step keeps the guidance answer')
  assert.equal(normal.finish.failure?.code, 'SETUP_REQUIRED')
})

test('★ a compaction call is not routed to a model below the capacity floor', async (t) => {
  const { pool, mounted, routedModels } = await mountWith([
    { id: 'small-model', contextWindow: SMALL },
    { id: 'big-model', contextWindow: BIG },
  ])
  t.after(async () => { await mounted.close?.(); await pool.close() })

  const compact = assertValidChunkSequence(await collect(mounted.adapter.stream(
    ask('summarise the conversation so far', { purpose: 'compaction' }),
  )))
  assert.equal(compact.finish.kind, 'stop', JSON.stringify(compact.finish))
  assert.deepEqual(routedModels(), ['big-model'],
    'the summary must skip the model that cannot hold a large context')

  // The floor belongs to the summary path only: with the SAME pool, a normal step
  // must not be narrowed by it. Asserting *which* model an ordinary step prefers
  // would be asserting an unrelated ranking preference, so this asserts only that
  // the ordinary path still has candidates at all.
  const normal = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('hello'))))
  assert.equal(normal.finish.kind, 'stop', `the floor emptied the ordinary path: ${JSON.stringify(normal.finish)}`)
})

test('★ the floor is a compaction-only gate — a normal step is never emptied by it', async (t) => {
  // Only a small model exists. An ordinary request must still be served; the
  // floor must not make the pool unusable outside the compaction path.
  const { pool, mounted } = await mountWith([{ id: 'small-model', contextWindow: SMALL }])
  t.after(async () => { await mounted.close?.(); await pool.close() })

  const normal = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('hello'))))
  assert.equal(normal.finish.kind, 'stop', 'a normal step is served by the small model')
})

test('★ with no candidate above the floor, a compaction fails loudly and says why', async (t) => {
  const { pool, mounted } = await mountWith([{ id: 'small-model', contextWindow: SMALL }])
  t.after(async () => { await mounted.close?.(); await pool.close() })

  const compact = assertValidChunkSequence(await collect(mounted.adapter.stream(
    ask('summarise the conversation so far', { purpose: 'compaction' }),
  )))
  // A loud, attributable failure is the requirement: silence is what produced an
  // unbounded retry loop. The message must name the floor so the user can act.
  const failure = compact.finish.failure ?? compact.finish.reason?.failure
  assert.ok(failure !== undefined, 'a summarisation that cannot be served must fail, not hang')
  assert.match(String(failure.message), /context window|floor/i,
    `the failure must be about capacity, got: ${failure.message}`)
})

