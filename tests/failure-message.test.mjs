/**
 * A failure message must never be `[object Object]`.
 *
 * ## Why this file exists
 *
 * A `compaction/end` record in the 2026-10-15 session log reads, in full:
 *
 *     "error": "dsh-freellmapi: [object Object]"
 *
 * It comes from a turn that was compacting in a loop — that is, the one moment
 * where a reader most needs to know *why* the summary failed, the failure
 * explained nothing at all. The path was `failureOf()` accepting `error.message`
 * without checking that it is a string, and `String(object)` then yielding the
 * literal `[object Object]`.
 *
 * These tests pin the property, not the implementation: whatever shape an upstream
 * or an internal error takes, the message the user sees must carry some content.
 * A message that says `[object Object]`, or nothing, is the defect — not the
 * particular branch that produced it.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { describeTransportFailure, describeUnknown } from '../lib/errors.js'
import { assertValidChunkSequence, collect } from './helpers/harness.mjs'
import { mountPlugin } from './helpers/context.mjs'
import { startMockPool } from './helpers/pool.mjs'

const USELESS = /\[object Object\]/

// ---------------------------------------------------------------- the helper
//
// `describeUnknown` is where the property is actually enforced, so it is pinned
// directly. An end-to-end test cannot reach every branch: a nested
// `error.message` object is *lifted* to a string by `upstreamMessage()` before
// any of this runs, which is why an earlier version of this file passed even with
// the defect reinstated.

test('★ describeUnknown never renders an object as the literal [object Object]', () => {
  const cases = [
    [{ message: 'real message' }, 'real message'],
    [{ code: 'QUOTA', detail: 'from detail' }, 'QUOTA'],
    [{ nested: { deep: true } }, 'JSON'],
    [new Error('plain'), 'plain'],
  ]
  for (const [input, expected] of cases) {
    const out = describeUnknown(input, 'FALLBACK')
    assert.doesNotMatch(out, USELESS, `describeUnknown(${JSON.stringify(input)}) yielded ${out}`)
    if (expected === 'JSON') assert.match(out, /\{/, `an opaque object should be dumped: ${out}`)
    else assert.equal(out, expected)
  }
  // Values with nothing to say must produce the caller's fallback, never a literal.
  for (const empty of [null, undefined, '', '   ', {}, []]) {
    const out = describeUnknown(empty, 'FALLBACK')
    assert.doesNotMatch(out, USELESS)
    assert.ok(out.length > 0, 'a fallback must be returned, not an empty string')
  }
})

test('★ describeUnknown survives a value that cannot be serialised', () => {
  const circular = {}
  circular.self = circular
  // `JSON.stringify` throws here; the helper must fall back rather than propagate.
  const out = describeUnknown(circular, 'FALLBACK')
  assert.equal(out, 'FALLBACK')
  assert.doesNotMatch(out, USELESS)
})

test('★ describeTransportFailure describes a non-string error.message', () => {
  // `error.message` is only a string by convention. An error crossing a library
  // boundary can carry anything, and this path used to hand it straight to
  // `String()`.
  const broken = new Error('placeholder')
  Object.defineProperty(broken, 'message', { value: { code: 'ETIMEDOUT', host: 'api.example' }, enumerable: true })
  const failure = describeTransportFailure(broken, { baseURL: 'https://api.example/v1', model: 'auto' })
  assert.ok(failure.message.length > 0, 'a transport failure must carry a message')
  assert.doesNotMatch(failure.message, USELESS, `useless transport message: ${failure.message}`)

  // A cause with a non-string message must not leak one either.
  const withBadCause = new Error('outer')
  withBadCause.cause = broken
  const chained = describeTransportFailure(withBadCause, { baseURL: 'https://api.example/v1', model: 'auto' })
  assert.doesNotMatch(chained.message, USELESS, `useless chained message: ${chained.message}`)
})

// ---------------------------------------------------------------- end to end

const ask = (text, extra = {}) => ({
  provider: 'freellmapi',
  model: 'auto',
  messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  ...extra,
})

/** The message of whatever terminal failure a stream produced, if any. */
async function failureMessageOf (adapter, options) {
  const result = assertValidChunkSequence(await collect(adapter.stream(options)))
  assert.equal(result.finish.kind, 'error', `expected a failure, got ${JSON.stringify(result.finish)}`)
  return result.finish.failure?.message ?? ''
}

test('★ an error body whose message is not a string still yields a useful failure', async (t) => {
  // A provider that answers 400 with a body shaped like a real one but where the
  // human-readable fields are objects. `String()` on any of them is `[object
  // Object]`, which is exactly the outcome this test forbids.
  const pool = await startMockPool([{
    id: 'mockpool',
    models: [{ id: 'mock-model', contextWindow: 400_000 }],
    respond: ({ response }) => {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        error: { message: { code: 'weird', hint: 'nested object where a string belongs' }, type: 'invalid_request_error' },
      }))
      return true
    },
  }])
  const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
  t.after(async () => { await mounted.close?.(); await pool.close() })

  const message = await failureMessageOf(mounted.adapter, ask('hello'))
  assert.ok(message.length > 0, 'a failure must carry a message')
  assert.doesNotMatch(message, USELESS, `the failure message is useless: ${JSON.stringify(message)}`)
})

test('★ an unreachable provider yields a described failure, not an empty or object one', async (t) => {
  // A transport failure is the other boundary: nothing upstream to parse, so the
  // message has to be built from the thrown value alone.
  const pool = await startMockPool([{ id: 'mockpool', models: [{ id: 'mock-model', contextWindow: 400_000 }] }])
  const mounted = mountPlugin({
    config: {
      mode: 'direct',
      providers: {
        ...pool.config,
        // Port 0 is not connectable; the fetch rejects rather than answering.
        mockpool: { ...pool.config.mockpool, baseURL: 'http://127.0.0.1:1/v1' },
      },
    },
  })
  t.after(async () => { await mounted.close?.(); await pool.close() })

  const message = await failureMessageOf(mounted.adapter, ask('hello'))
  assert.ok(message.length > 0, 'a transport failure must carry a message')
  assert.doesNotMatch(message, USELESS, `the failure message is useless: ${JSON.stringify(message)}`)
})

test('★ an aborted request reports the abort rather than a stringified object', async (t) => {
  const pool = await startMockPool([{ id: 'mockpool', models: [{ id: 'mock-model', contextWindow: 400_000 }] }])
  const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
  t.after(async () => { await mounted.close?.(); await pool.close() })

  const controller = new AbortController()
  controller.abort()
  const result = assertValidChunkSequence(await collect(mounted.adapter.stream(
    ask('hello', { signal: controller.signal }),
  )))
  const failure = result.finish.failure ?? {}
  assert.ok(String(failure.message ?? '').length > 0, 'an abort must say so')
  assert.doesNotMatch(String(failure.message), USELESS)
})
