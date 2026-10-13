/**
 * Health tracker tests: cooldown ladder, `Retry-After` precedence, latency EWMA,
 * serialization and the injectable clock. No I/O anywhere.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_COOLDOWN_LADDER, DEFAULT_FAILURE_HALF_LIFE_MS, HealthTracker, INVALID_CREDENTIAL_COOLDOWN_MS } from '../lib/health.js'

/** A controllable clock. */
function clock(start = 1_000_000) {
  let value = start
  return {
    now: () => value,
    advance(ms) { value += ms; return value },
  }
}

test('a pristine route is available with a zeroed snapshot', () => {
  const tracker = new HealthTracker({ now: clock().now })
  const snapshot = tracker.snapshot('groq', 'm')
  assert.deepEqual(snapshot, {
    failures: 0, effectiveFailures: 0, successes: 0, cooldownUntil: 0,
    lastFailureAt: 0, latencyEwma: null, invalid: false,
  })
  assert.equal(tracker.isAvailable('groq', 'm'), true)
  assert.equal(tracker.size, 0, 'reading a snapshot must not create state')
})

test('a success is recorded and resets the failure streak', () => {
  const time = clock()
  const tracker = new HealthTracker({ now: time.now })
  tracker.recordFailure('groq', 'm', { status: 500 })
  assert.equal(tracker.snapshot('groq', 'm').failures, 1)
  tracker.recordSuccess('groq', 'm', 250)
  const snapshot = tracker.snapshot('groq', 'm')
  assert.equal(snapshot.failures, 0)
  assert.equal(snapshot.successes, 1)
  assert.equal(snapshot.cooldownUntil, 0)
  assert.equal(snapshot.latencyEwma, 250)
  assert.equal(tracker.isAvailable('groq', 'm'), true)
})

test('the cooldown ladder escalates 2m → 10m → 1h → 24h and then repeats the last step', () => {
  const time = clock()
  const tracker = new HealthTracker({ now: time.now })
  const expected = DEFAULT_COOLDOWN_LADDER
  for (const [index, step] of expected.entries()) {
    const at = time.now()
    const snapshot = tracker.recordFailure('groq', 'm', { status: 429 })
    assert.equal(snapshot.cooldownUntil, at + step, `failure #${index + 1} should park for ${step}ms`)
  }
  const at = time.now()
  const snapshot = tracker.recordFailure('groq', 'm', { status: 429 })
  assert.equal(snapshot.cooldownUntil, at + expected.at(-1), 'the ladder saturates at 24h')
})

test('a route is unavailable while its cooldown is active and available afterwards', () => {
  const time = clock()
  const tracker = new HealthTracker({ now: time.now })
  tracker.recordFailure('groq', 'm', { status: 429 })
  assert.equal(tracker.isAvailable('groq', 'm'), false)
  time.advance(DEFAULT_COOLDOWN_LADDER[0] - 1)
  assert.equal(tracker.isAvailable('groq', 'm'), false)
  time.advance(1)
  assert.equal(tracker.isAvailable('groq', 'm'), true)
})

test('Retry-After wins over the ladder when the provider supplies one', () => {
  const time = clock()
  const tracker = new HealthTracker({ now: time.now })
  const at = time.now()
  const snapshot = tracker.recordFailure('groq', 'm', { status: 429, retryAfterMs: 5_000 })
  assert.equal(snapshot.cooldownUntil, at + 5_000)
})

test('a rejected credential parks the provider for a day and flags it invalid', () => {
  const time = clock()
  const tracker = new HealthTracker({ now: time.now })
  const at = time.now()
  const snapshot = tracker.recordFailure('groq', 'm', { status: 401 })
  assert.equal(snapshot.invalid, true)
  assert.equal(snapshot.cooldownUntil, at + INVALID_CREDENTIAL_COOLDOWN_MS)
})

test('a plain request error does not park the route', () => {
  const time = clock()
  const tracker = new HealthTracker({ now: time.now })
  const snapshot = tracker.recordFailure('groq', 'm', { status: 400 })
  assert.equal(snapshot.cooldownUntil, 0)
  assert.equal(snapshot.failures, 1)
  assert.equal(tracker.isAvailable('groq', 'm'), true)
})

test('cooldown can be suppressed explicitly for mid-stream failures', () => {
  const time = clock()
  const tracker = new HealthTracker({ now: time.now })
  const snapshot = tracker.recordFailure('groq', 'm', { cooldown: false })
  assert.equal(snapshot.cooldownUntil, 0)
  assert.equal(snapshot.failures, 1)
})

test('transport failures (no status) park the route', () => {
  const time = clock()
  const tracker = new HealthTracker({ now: time.now })
  assert.ok(tracker.recordFailure('groq', 'm', {}).cooldownUntil > 0)
})

test('latency is smoothed with an EWMA and defaults to the first sample', () => {
  const time = clock()
  const tracker = new HealthTracker({ now: time.now, latencyAlpha: 0.5 })
  tracker.recordSuccess('groq', 'm', 100)
  assert.equal(tracker.snapshot('groq', 'm').latencyEwma, 100)
  tracker.recordSuccess('groq', 'm', 300)
  assert.equal(tracker.snapshot('groq', 'm').latencyEwma, 200)
  // A missing sample leaves the estimate untouched.
  tracker.recordSuccess('groq', 'm')
  assert.equal(tracker.snapshot('groq', 'm').latencyEwma, 200)
})

test('routes are tracked per (provider, model)', () => {
  const time = clock()
  const tracker = new HealthTracker({ now: time.now })
  tracker.recordFailure('groq', 'a', { status: 429 })
  assert.equal(tracker.isAvailable('groq', 'a'), false)
  assert.equal(tracker.isAvailable('groq', 'b'), true)
  assert.equal(tracker.isAvailable('other', 'a'), true)
})

test('an injected ladder replaces the default', () => {
  const time = clock()
  const tracker = new HealthTracker({ now: time.now, cooldownLadder: [10, 20] })
  assert.equal(tracker.recordFailure('p', 'm', { status: 500 }).cooldownUntil, time.now() + 10)
  assert.equal(tracker.recordFailure('p', 'm', { status: 500 }).cooldownUntil, time.now() + 20)
  assert.equal(tracker.recordFailure('p', 'm', { status: 500 }).cooldownUntil, time.now() + 20)
})

test('an unusable ladder falls back to the default', () => {
  const tracker = new HealthTracker({ cooldownLadder: [] })
  assert.deepEqual([...tracker.cooldownLadder], [...DEFAULT_COOLDOWN_LADDER])
  assert.deepEqual([...new HealthTracker({ cooldownLadder: ['x', -1] }).cooldownLadder], [...DEFAULT_COOLDOWN_LADDER])
})

test('the default clock is the real one', () => {
  const tracker = new HealthTracker()
  assert.equal(typeof tracker.now(), 'number')
  assert.ok(tracker.now() > 1_600_000_000_000)
})

test('toJSON/fromJSON round-trips the full state', () => {
  const time = clock()
  const original = new HealthTracker({ now: time.now })
  original.recordSuccess('groq', 'm', 120)
  original.recordFailure('llm7', 'x', { status: 429, retryAfterMs: 9_000 })
  const data = JSON.parse(JSON.stringify(original.toJSON()))
  const restored = HealthTracker.fromJSON(data, { now: time.now })
  assert.equal(restored.size, original.size)
  assert.deepEqual(restored.snapshot('groq', 'm'), original.snapshot('groq', 'm'))
  assert.deepEqual(restored.snapshot('llm7', 'x'), original.snapshot('llm7', 'x'))
  assert.equal(restored.isAvailable('llm7', 'x'), original.isAvailable('llm7', 'x'))
})

test('fromJSON tolerates garbage without throwing', () => {
  for (const data of [null, undefined, 5, 'x', [], {}, { entries: null }, { entries: { bad: 1 } }, { entries: { 'a\u0000b': { failures: 'x' } } }]) {
    let tracker
    assert.doesNotThrow(() => {
      tracker = HealthTracker.fromJSON(data, { now: () => 0 })
    })
    assert.ok(tracker instanceof HealthTracker)
  }
  const tracker = HealthTracker.fromJSON(
    { entries: { 'a\u0000b': { failures: 3, cooldownUntil: 10, latencyEwma: 5, successes: 1, invalid: true, lastFailureAt: 4 } } },
    { now: () => 4 },
  )
  assert.deepEqual(tracker.snapshot('a', 'b'), {
    failures: 3, effectiveFailures: 3, successes: 1, cooldownUntil: 10,
    latencyEwma: 5, invalid: true, lastFailureAt: 4,
  })
})

// ---------------------------------------------------------------------------
// failure decay (M-1)
// ---------------------------------------------------------------------------

test('a failure decays with a half-life so a penalised route is not starved forever', () => {
  const time = clock()
  const tracker = new HealthTracker({ now: time.now, failureHalfLifeMs: 60_000 })
  tracker.recordFailure('groq', 'm', { status: 429 })
  assert.equal(tracker.snapshot('groq', 'm').effectiveFailures, 1)
  time.advance(60_000)
  assert.equal(tracker.snapshot('groq', 'm').effectiveFailures, 0.5)
  time.advance(60_000)
  assert.equal(tracker.snapshot('groq', 'm').effectiveFailures, 0.25)
  time.advance(60_000 * 8)
  assert.ok(tracker.snapshot('groq', 'm').effectiveFailures < 0.01)
})

test('the raw failure count never decays — only its weight does', () => {
  const time = clock()
  const tracker = new HealthTracker({ now: time.now })
  tracker.recordFailure('groq', 'm', { status: 429 })
  tracker.recordFailure('groq', 'm', { status: 429 })
  time.advance(10 * 3600_000)
  const snapshot = tracker.snapshot('groq', 'm')
  assert.equal(snapshot.failures, 2, 'the honest count is retained for diagnostics')
  assert.ok(snapshot.effectiveFailures < 0.01)
})

test('a success clears both the raw count and the decayed weight', () => {
  const time = clock()
  const tracker = new HealthTracker({ now: time.now })
  tracker.recordFailure('groq', 'm', { status: 429 })
  tracker.recordSuccess('groq', 'm', 100)
  const snapshot = tracker.snapshot('groq', 'm')
  assert.equal(snapshot.failures, 0)
  assert.equal(snapshot.effectiveFailures, 0)
  assert.equal(snapshot.lastFailureAt, 0)
})

test('the decay half-life is configurable and falls back when unusable', () => {
  assert.equal(new HealthTracker({ failureHalfLifeMs: 1_000 }).failureHalfLifeMs, 1_000)
  assert.equal(new HealthTracker({ failureHalfLifeMs: 0 }).failureHalfLifeMs, DEFAULT_FAILURE_HALF_LIFE_MS)
  assert.equal(new HealthTracker({ failureHalfLifeMs: -5 }).failureHalfLifeMs, DEFAULT_FAILURE_HALF_LIFE_MS)
  assert.equal(new HealthTracker({ failureHalfLifeMs: 'soon' }).failureHalfLifeMs, DEFAULT_FAILURE_HALF_LIFE_MS)
  assert.equal(new HealthTracker().failureHalfLifeMs, DEFAULT_FAILURE_HALF_LIFE_MS)
})

// ---------------------------------------------------------------------------
// cooldown rule (L-2)
// ---------------------------------------------------------------------------

test('an explicit cooldown flag overrides the default status list', () => {
  const time = clock()
  const tracker = new HealthTracker({ now: time.now })
  // A 400 is not in the default list, but the retry policy can declare it worth
  // parking — that is how `model_unavailable` cools like a 404.
  assert.equal(tracker.recordFailure('a', 'm', { status: 400, cooldown: true }).cooldownUntil, time.now() + 120_000)
  // And a status that would normally park can be suppressed.
  assert.equal(tracker.recordFailure('b', 'm', { status: 500, cooldown: false }).cooldownUntil, 0)
})

test('a rejected credential always parks, whatever the explicit flag says', () => {
  const time = clock()
  const tracker = new HealthTracker({ now: time.now })
  const snapshot = tracker.recordFailure('a', 'm', { status: 401, cooldown: false })
  assert.equal(snapshot.invalid, true)
  assert.equal(snapshot.cooldownUntil, time.now() + INVALID_CREDENTIAL_COOLDOWN_MS)
})

test('the default status list still parks 429/5xx/404/transport without an explicit flag', () => {
  const time = clock()
  const tracker = new HealthTracker({ now: time.now })
  for (const [index, status] of [429, 500, 503, 404, 408, 409, 410, 422].entries()) {
    assert.ok(tracker.recordFailure(`p${index}`, 'm', { status }).cooldownUntil > 0, `status ${status} should park`)
  }
  assert.ok(tracker.recordFailure('transport', 'm', {}).cooldownUntil > 0)
  assert.equal(tracker.recordFailure('plain400', 'm', { status: 400 }).cooldownUntil, 0)
})

test('keys containing the separator are still validated', () => {
  assert.equal(HealthTracker.keyOf('a', 'b'), 'a\u0000b')
  assert.equal(HealthTracker.keyOf(undefined, undefined), '\u0000')
})

test('reset drops every route', () => {
  const tracker = new HealthTracker({ now: () => 0 })
  tracker.recordFailure('a', 'b', { status: 500 })
  tracker.reset()
  assert.equal(tracker.size, 0)
  assert.equal(tracker.isAvailable('a', 'b'), true)
})
