/**
 * Guards for routing telemetry.
 *
 * ## The properties that matter, and why each needs its own assertion
 *
 *  1. **Off by default writes nothing.** The whole feature is opt-in; a guard that
 *     only tested the enabled path would pass with the switch ignored.
 *  2. **"No telemetry" is distinguishable from "telemetry says zero".** A pipeline
 *     that conflated them would report an untouched pool as a healthy one, which is
 *     worse than reporting nothing.
 *  3. **Recording cannot fail a request.** `lib/index.js` already states this rule for
 *     its own reporting; telemetry inherits it, and it is asserted by making the
 *     writer throw.
 *  4. **Aggregates, not text.** The summary must carry counts, never a reason string
 *     or a model reply — asserted structurally, because a future edit adding one
 *     field is exactly how that rule would be lost.
 *
 * Every test injects a fake `fs`, so no test touches the disk and none depends on a
 * writable directory.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyRoute,
  classifyRoute,
  createTelemetry,
  deriveAdvice,
  emptySummary,
  readTelemetry,
} from '../lib/telemetry.js'

/** A fake fs that records writes and can be made to fail on demand. */
function fakeFs ({ fail = false } = {}) {
  const writes = []
  return {
    writes,
    promises: {
      async mkdir () {},
      async writeFile (path, text) {
        if (fail) throw new Error('EACCES: injected write failure')
        writes.push({ path, text })
      },
    },
    async readFile () {
      if (fail) throw new Error('ENOENT')
      return writes.length === 0 ? '' : writes[writes.length - 1].text
    },
  }
}

test('★ telemetry is off by default: nothing is recorded and nothing is written', async () => {
  const fs = fakeFs()
  const telemetry = createTelemetry({ enabled: false, file: '/tmp/x/telemetry.json', fsLoader: async () => fs })
  assert.equal(telemetry.enabled, false, 'disabled telemetry must report itself disabled')
  assert.equal(telemetry.record({ tier: 'simple', provider: 'kilo' }), false, 'record must be a no-op when off')
  assert.equal(telemetry.summary.requests, 0, 'a disabled accumulator must not change')
  assert.equal(await telemetry.flush(true), false, 'flush must not write when off')
  assert.equal(fs.writes.length, 0, `off by default must write nothing, wrote ${fs.writes.length}`)
})

test('★ a missing file reads as null, not as an empty summary', async () => {
  // The distinction the pipeline depends on: "nobody opted in" versus "the pool was
  // idle". Returning `emptySummary()` here would silently equate them.
  const missing = await readTelemetry(fakeFs({ fail: true }), '/tmp/nope/telemetry.json')
  assert.equal(missing, null, 'an unreadable file must yield null')

  // And a real zero-count summary must survive as a summary.
  const fs = fakeFs()
  await fs.promises.writeFile('/tmp/x/telemetry.json', JSON.stringify(emptySummary()))
  const zero = await readTelemetry(fs, '/tmp/x/telemetry.json')
  assert.notEqual(zero, null, 'a written summary with requests=0 is still telemetry')
  assert.equal(zero.requests, 0)
})

test('★ recording never propagates a failure from the writer', async () => {
  const telemetry = createTelemetry({
    enabled: true,
    file: '/tmp/x/telemetry.json',
    fsLoader: async () => fakeFs({ fail: true }),
  })
  // Recording itself must succeed — the write is what fails, later and separately.
  assert.equal(telemetry.record({ tier: 'complex', provider: 'groq', candidateCount: 3 }), true)
  assert.equal(await telemetry.flush(true), false, 'a failing write reports false')
  assert.equal(telemetry.stats.writeFailures, 1)
  assert.match(String(telemetry.stats.lastError), /EACCES/, 'the failure is retained for diagnosis')
})

test('★ the summary carries counts, never text', async () => {
  // A structural assertion on purpose: the rule "aggregates only" is enforced by the
  // SHAPE, and a future edit that adds a `lastReason` string should fail here rather
  // than quietly start persisting conversation content.
  const telemetry = createTelemetry({ enabled: true, file: '/tmp/x/t.json', fsLoader: async () => fakeFs() })
  telemetry.record({
    tier: 'complex',
    provider: 'groq',
    candidateCount: 4,
    attempts: [{ provider: 'a', model: 'm' }, { provider: 'groq', model: 'g' }],
    // A reason string is present on the real record — it must NOT reach the summary.
    reasons: ['groq/gpt-oss: the user asked about their bank statement'],
  })
  // `updatedAt` is a timestamp, not text, so it is allowed — but it has to be LISTED.
  // The first version of this allow-list omitted it and the guard failed, which is the
  // assertion doing its job: the set of persisted fields should be something a person
  // deliberately enumerates, not whatever the object happens to carry.
  const allowed = new Set(['version', 'requests', 'failures', 'attemptsTotal', 'attemptsMax', 'byTier', 'byProvider', 'updatedAt'])
  for (const key of Object.keys(telemetry.summary)) {
    assert.ok(allowed.has(key), `summary grew an unexpected field "${key}" — aggregates only, never text`)
  }
  assert.equal(JSON.stringify(telemetry.summary).includes('bank statement'), false,
    'no text from a reason may be persisted')
})

test('classification and folding produce the numbers §2 asks for', () => {
  const summary = emptySummary()
  applyRoute(summary, classifyRoute({ tier: 'simple', provider: 'kilo', candidateCount: 2, attempts: [{}] }))
  applyRoute(summary, classifyRoute({ tier: 'complex', provider: 'groq', candidateCount: 5, attempts: [{}, {}, {}] }))
  applyRoute(summary, classifyRoute({ tier: 'complex' })) // no provider ⇒ a routing failure

  assert.equal(summary.requests, 3)
  assert.equal(summary.failures, 1, 'a record without a provider is a failure')
  assert.equal(summary.attemptsMax, 3)
  assert.deepEqual(summary.byTier, { simple: 1, complex: 2 })
  assert.equal(summary.byProvider.kilo.wins, 1)
  assert.equal(summary.byProvider.groq.attempts, 3)
})

test('an unexpected tier value cannot explode the accumulator', () => {
  // `tierKey` buckets anything non-alphabetic. Without it a hostile or buggy value
  // becomes a new map key on every request.
  const summary = emptySummary()
  applyRoute(summary, classifyRoute({ tier: '../../etc/passwd', provider: 'x' }))
  assert.deepEqual(Object.keys(summary.byTier), ['unknown'])
})

test('advice is derived only from what the summary supports', () => {
  const idle = deriveAdvice(emptySummary())
  assert.equal(idle[0].kind, 'no-data', 'an untouched summary must say so rather than imply health')

  const summary = emptySummary()
  for (let i = 0; i < 4; i++) applyRoute(summary, classifyRoute({ tier: 'complex', provider: 'groq', attempts: [{}, {}, {}] }))
  const findings = deriveAdvice(summary, { enabledProviders: ['groq', 'cerebras'] })
  const kinds = findings.map((f) => f.kind)
  assert.ok(kinds.includes('never-wins'), 'an enabled provider with zero wins must be reported')
  assert.deepEqual(findings.find((f) => f.kind === 'never-wins').providers, ['cerebras'])
  assert.ok(kinds.includes('attempts-rising'), '3 attempts per request is above the stated threshold')
  assert.equal(kinds.includes('tier-mix'), true)
})

test('the write throttle holds unless forced', async () => {
  const fs = fakeFs()
  let clock = 1_000_000
  const telemetry = createTelemetry({
    enabled: true,
    file: '/tmp/x/t.json',
    fsLoader: async () => fs,
    flushIntervalMs: 30_000,
    now: () => clock,
  })
  telemetry.record({ tier: 'simple', provider: 'kilo' })
  assert.equal(await telemetry.flush(), true, 'the first flush proceeds')
  telemetry.record({ tier: 'simple', provider: 'kilo' })
  assert.equal(await telemetry.flush(), false, 'a flush inside the interval is skipped')
  clock += 30_001
  assert.equal(await telemetry.flush(), true, 'once the interval passes the write proceeds')
  assert.equal(fs.writes.length, 2)
})
