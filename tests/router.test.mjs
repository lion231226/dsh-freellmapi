/**
 * Router tests.
 *
 * `router.js` is the decision the whole direct mode hangs on, so these tests are
 * about the *rules*: the tier's capability/speed balance, the hard gates, health
 * effects, determinism and the fact that the module can run with nothing but its
 * argument (no clock, no environment, no I/O).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_COOLDOWN_LADDER, HealthTracker } from '../lib/health.js'
import { TIER_WEIGHTS, explainExclusions, rankCandidates } from '../lib/router.js'

const caps = (overrides = {}) => ({
  capability: 3, speed: 3, contextWindow: 131_072, maxTokens: 8_192, vision: false, toolCalling: true, ...overrides,
})

const candidate = (provider, model, capOverrides = {}, health = {}) => ({
  provider, model, caps: caps(capOverrides), health: { failures: 0, cooldownUntil: 0, latencyEwma: null, successes: 0, invalid: false, ...health },
})

const FAST_WEAK = candidate('fast', 'weak', { capability: 2, speed: 5 })
const STRONG_SLOW = candidate('strong', 'slow', { capability: 5, speed: 2 })

const rank = (input) => rankCandidates({ candidates: [FAST_WEAK, STRONG_SLOW], now: 0, ...input })
const ids = (ranked) => ranked.map((entry) => `${entry.provider}/${entry.model}`)

test('the exported tier weights match the documented promise', () => {
  assert.deepEqual({ ...TIER_WEIGHTS.simple }, { capability: 0.25, speed: 0.75 })
  assert.deepEqual({ ...TIER_WEIGHTS.medium }, { capability: 0.5, speed: 0.5 })
  assert.deepEqual({ ...TIER_WEIGHTS.complex }, { capability: 0.8, speed: 0.2 })
  assert.equal(Object.isFrozen(TIER_WEIGHTS), true)
})

test('simple requests go to the fast model and complex requests to the strong one', () => {
  assert.deepEqual(ids(rank({ tier: 'simple' })), ['fast/weak', 'strong/slow'])
  assert.deepEqual(ids(rank({ tier: 'complex' })), ['strong/slow', 'fast/weak'])
})

test('complex prefers capability enough to beat a large speed deficit', () => {
  const ranked = rank({ tier: 'complex' })
  assert.ok(ranked[0].score > ranked[1].score)
  assert.ok(ranked[0].reasons.some((reason) => reason.includes('complex tier weights')))
  assert.ok(ranked[0].reasons.some((reason) => reason.includes('capability 5/5')))
})

test('the medium tier is a genuine tie between the two extremes', () => {
  const ranked = rank({ tier: 'medium' })
  assert.equal(ranked[0].score, ranked[1].score)
  // A deterministic tie-break still yields a stable order.
  assert.deepEqual(ids(rank({ tier: 'medium' })), ['fast/weak', 'strong/slow'])
})

test('weights can be overridden per tier or flat', () => {
  assert.deepEqual(ids(rank({ tier: 'simple', weights: { capability: 1, speed: 0 } })), ['strong/slow', 'fast/weak'])
  assert.deepEqual(ids(rank({ tier: 'complex', weights: { simple: { capability: 0, speed: 1 } } })), ['strong/slow', 'fast/weak'])
  // A nonsense override is ignored rather than fatal.
  assert.deepEqual(ids(rank({ tier: 'simple', weights: { capability: 'x', speed: -1 } })), ['fast/weak', 'strong/slow'])
  assert.deepEqual(ids(rank({ tier: 'simple', weights: { capability: 0, speed: 0 } })), ['fast/weak', 'strong/slow'])
})

test('an unknown tier falls back to medium', () => {
  assert.deepEqual(rank({ tier: 'nonsense' }), rank({ tier: 'medium' }))
  assert.deepEqual(rank({}), rank({ tier: 'medium' }))
})

// ---------------------------------------------------------------------------
// hard gates
// ---------------------------------------------------------------------------

test('needsVision excludes every model that does not declare vision', () => {
  const input = {
    tier: 'medium',
    now: 0,
    needsVision: true,
    candidates: [FAST_WEAK, candidate('see', 'things', { vision: true })],
  }
  assert.deepEqual(ids(rankCandidates(input)), ['see/things'])
  assert.deepEqual(explainExclusions(input), [{
    provider: 'fast', model: 'weak', reason: 'the request carries an image but this model declares vision=false',
  }])
})

test('needsTools excludes every model that does not declare tool calling', () => {
  const input = {
    tier: 'medium',
    now: 0,
    needsTools: true,
    candidates: [candidate('a', 'plain', { toolCalling: false }), candidate('b', 'tools', { toolCalling: true })],
  }
  assert.deepEqual(ids(rankCandidates(input)), ['b/tools'])
  assert.match(explainExclusions(input)[0].reason, /declares toolCalling=false/)
})

test('a context window smaller than the estimated input is excluded', () => {
  const input = {
    tier: 'medium',
    now: 0,
    tokens: 12_000,
    candidates: [candidate('small', 'ctx', { contextWindow: 8_000 }), candidate('big', 'ctx', { contextWindow: 131_072 })],
  }
  assert.deepEqual(ids(rankCandidates(input)), ['big/ctx'])
  assert.match(explainExclusions(input)[0].reason, /12000 tokens, plus a 1x safety margin, exceed the 8000-token context window/)
})

test('★ the context gate keeps a safety margin, because the estimate undercounts', () => {
  // A real 297,538-token session was estimated at roughly 268k, slipped past a
  // 262,144-token gate and came back as an upstream HTTP 400. The gate must be
  // conservative: a candidate has to hold the estimate *plus* the margin.
  const fits = candidate('fits', 'ctx', { contextWindow: 131_072 })
  const tight = candidate('tight', 'ctx', { contextWindow: 8_000 })

  const withMargin = { tier: 'medium', now: 0, tokens: 8_000, safetyFactor: 1.15, candidates: [tight, fits] }
  assert.deepEqual(ids(rankCandidates(withMargin)), ['fits/ctx'], 'a window the estimate only just fits must be skipped')
  assert.match(explainExclusions(withMargin)[0].reason, /plus a 1\.15x safety margin/)

  // The margin is a knob, not a hardcoded number: lowering it to 1 restores the
  // exact-fit behaviour on purpose.
  const noMargin = { ...withMargin, safetyFactor: 1 }
  assert.deepEqual(ids(rankCandidates(noMargin)).sort(), ['fits/ctx', 'tight/ctx'])

  // Below 1 is not a valid margin and is clamped up, so it can never make the gate
  // *less* conservative than the estimate itself.
  const bogus = { ...withMargin, safetyFactor: 0.1 }
  assert.deepEqual(ids(rankCandidates(bogus)).sort(), ['fits/ctx', 'tight/ctx'])
})

test('the margin is exactly at the boundary, not past it', () => {
  // 8000 * 1.15 = 9200: a 9200-token window is enough, an 8000-token one is not.
  const at = { tier: 'medium', now: 0, tokens: 8_000, safetyFactor: 1.15, candidates: [candidate('a', 'ctx', { contextWindow: 9_200 })] }
  assert.deepEqual(ids(rankCandidates(at)), ['a/ctx'])
  const below = { ...at, candidates: [candidate('a', 'ctx', { contextWindow: 9_199 })] }
  assert.deepEqual(ids(rankCandidates(below)), [])
})

test('a cooling-down candidate is excluded and explained', () => {
  const input = {
    tier: 'medium',
    now: 1_000,
    candidates: [
      candidate('cold', 'm', {}, { cooldownUntil: 121_000, failures: 1 }),
      candidate('warm', 'm'),
    ],
  }
  assert.deepEqual(ids(rankCandidates(input)), ['warm/m'])
  assert.match(explainExclusions(input)[0].reason, /cooling down for another 120s/)
})

test('an expired cooldown no longer excludes', () => {
  const input = { tier: 'medium', now: 200_000, candidates: [candidate('a', 'm', {}, { cooldownUntil: 121_000 })] }
  assert.deepEqual(ids(rankCandidates(input)), ['a/m'])
})

test('omitting `now` skips the cooldown gate but keeps the failure penalty', () => {
  // The router never reads a clock, so a caller that forgets `now` gets a
  // penalty instead of a wrong exclusion.
  const input = {
    tier: 'medium',
    candidates: [candidate('flaky', 'm', {}, { cooldownUntil: 999_999, failures: 4 }), candidate('steady', 'm')],
  }
  assert.deepEqual(ids(rankCandidates(input)), ['steady/m', 'flaky/m'])
})

test('an invalid credential is named as the cooldown cause', () => {
  const input = { tier: 'medium', now: 0, candidates: [candidate('a', 'm', {}, { cooldownUntil: 1_000, invalid: true })] }
  assert.match(explainExclusions(input)[0].reason, /a rejected credential/)
})

// ---------------------------------------------------------------------------
// soft health effects
// ---------------------------------------------------------------------------

test('recent failures lower the score without excluding', () => {
  const clean = rankCandidates({ tier: 'medium', now: 0, candidates: [candidate('a', 'm')] })[0]
  const flaky = rankCandidates({ tier: 'medium', now: 0, candidates: [candidate('a', 'm', {}, { failures: 3 })] })[0]
  assert.ok(flaky.score < clean.score)
  assert.ok(flaky.reasons.some((reason) => reason.includes('3 recent failure(s)')))
})

test('failure penalties never drop a candidate below the health floor', () => {
  const many = rankCandidates({ tier: 'medium', now: 0, candidates: [candidate('a', 'm', {}, { failures: 1_000 })] })[0]
  const none = rankCandidates({ tier: 'medium', now: 0, candidates: [candidate('a', 'm')] })[0]
  assert.ok(many.score >= none.score * 0.4 - 1e-9)
})

test('a lower measured latency raises the score and is explained', () => {
  const input = {
    tier: 'medium',
    now: 0,
    candidates: [candidate('quick', 'm', {}, { latencyEwma: 500 }), candidate('slow', 'm', {}, { latencyEwma: 5_000 })],
  }
  const ranked = rankCandidates(input)
  assert.deepEqual(ids(ranked), ['quick/m', 'slow/m'])
  assert.ok(ranked[1].reasons.some((reason) => reason.includes('0.1x of the fastest')))
  assert.ok(ranked[0].reasons.some((reason) => reason.includes('fastest measured')))
})

test('latency is judged relatively, so a uniformly slow pool is not penalised', () => {
  const uniform = rankCandidates({
    tier: 'medium', now: 0,
    candidates: [candidate('a', 'm', {}, { latencyEwma: 40_000 }), candidate('b', 'm', {}, { latencyEwma: 40_000 })],
  })
  const unmeasured = rankCandidates({ tier: 'medium', now: 0, candidates: [candidate('a', 'm'), candidate('b', 'm')] })
  assert.equal(uniform[0].score, unmeasured[0].score)
})

test('a huge latency gap cannot flip the tier decision', () => {
  const ranked = rankCandidates({
    tier: 'complex', now: 0,
    candidates: [FAST_WEAK, candidate('strong', 'slow', { capability: 5, speed: 2 }, { latencyEwma: 100_000 })],
  })
  assert.deepEqual(ids(ranked), ['strong/slow', 'fast/weak'], 'capability still wins for complex')
  // And the same holds for a forced simple lane: latency is a tie-breaker, not a
  // tier override.
  const simple = rankCandidates({
    tier: 'simple', now: 0,
    candidates: [candidate('fast', 'weak', { capability: 2, speed: 5 }, { latencyEwma: 100_000 }), STRONG_SLOW],
  })
  assert.deepEqual(ids(simple), ['fast/weak', 'strong/slow'])
})

test('latency decides between otherwise equal candidates', () => {
  const ranked = rankCandidates({
    tier: 'medium', now: 0,
    candidates: [
      candidate('a', 'm', { capability: 4, speed: 4 }, { latencyEwma: 2_000 }),
      candidate('b', 'm', { capability: 4, speed: 4 }, { latencyEwma: 1_000 }),
    ],
  })
  assert.deepEqual(ids(ranked), ['b/m', 'a/m'])
})

test('recorded successes are surfaced in the reasons', () => {
  const ranked = rankCandidates({ tier: 'medium', now: 0, candidates: [candidate('a', 'm', {}, { successes: 4 })] })
  assert.ok(ranked[0].reasons.some((reason) => reason.includes('4 recorded success(es)')))
})

// ---------------------------------------------------------------------------
// preferred order, determinism, robustness
// ---------------------------------------------------------------------------

test('preferredOrder gives a listed provider a bounded bonus', () => {
  const input = {
    tier: 'medium',
    now: 0,
    candidates: [candidate('a', 'm'), candidate('b', 'm')],
    preferredOrder: ['b'],
  }
  assert.deepEqual(ids(rankCandidates(input)), ['b/m', 'a/m'])
  assert.ok(rankCandidates(input)[0].reasons.some((reason) => reason.includes('preferred order #1')))
})

test('preferredOrder cannot promote a strictly worse candidate', () => {
  const input = {
    tier: 'complex',
    now: 0,
    candidates: [FAST_WEAK, STRONG_SLOW],
    preferredOrder: ['fast'],
  }
  assert.deepEqual(ids(rankCandidates(input)), ['strong/slow', 'fast/weak'])
})

test('ranking is deterministic and independent of input order', () => {
  const forward = rankCandidates({ tier: 'medium', now: 0, candidates: [FAST_WEAK, STRONG_SLOW] })
  const backward = rankCandidates({ tier: 'medium', now: 0, candidates: [STRONG_SLOW, FAST_WEAK] })
  assert.deepEqual(forward, backward)
  for (let round = 0; round < 20; round += 1) {
    assert.deepEqual(rankCandidates({ tier: 'simple', now: 1, candidates: [FAST_WEAK, STRONG_SLOW] }), rankCandidates({ tier: 'simple', now: 1, candidates: [FAST_WEAK, STRONG_SLOW] }))
  }
})

test('ranking does not mutate its input', () => {
  const input = { tier: 'simple', now: 0, candidates: [FAST_WEAK, STRONG_SLOW], preferredOrder: ['fast'] }
  const before = JSON.stringify(input)
  rankCandidates(input)
  assert.equal(JSON.stringify(input), before)
})

test('the same provider appearing twice is broken by model id', () => {
  const ranked = rankCandidates({
    tier: 'medium', now: 0,
    candidates: [candidate('a', 'z'), candidate('a', 'a')],
  })
  assert.deepEqual(ids(ranked), ['a/a', 'a/z'])
})

test('degenerate input yields an empty ranking instead of throwing', () => {
  for (const input of [undefined, null, 5, 'x', [], {}, { candidates: null }, { candidates: 'x' }, { candidates: [null, 1, 'x'] }]) {
    let ranked
    assert.doesNotThrow(() => {
      ranked = rankCandidates(input)
    })
    assert.ok(Array.isArray(ranked))
    assert.equal(ranked.length, 0)
  }
})

test('a candidate without a provider or model is skipped', () => {
  const ranked = rankCandidates({ tier: 'medium', now: 0, candidates: [{ provider: '', model: 'm' }, { provider: 'p', model: '' }, null] })
  assert.deepEqual(ranked, [])
})

// ---------------------------------------------------------------------------
// latency semantics: "never measured" is not a perfect score (M-2)
// ---------------------------------------------------------------------------

/** The exact configuration the verifier used to fail the release gate. */
const M2_INPUT = {
  tier: 'simple',
  now: 0,
  tokens: 0,
  candidates: [
    candidate('fastweak', 'fq', { capability: 2, speed: 5 }, { latencyEwma: 60_000 }),
    candidate('balanced', 'bq', { capability: 4, speed: 4 }),
    candidate('strongslow', 'sq', { capability: 5, speed: 2 }, { latencyEwma: 1_000 }),
  ],
}

test('★ the fast model keeps the fast lane even after recording a very slow first token', () => {
  // Before the fix: `balanced` (never measured) took a perfect factor of 1 and won
  // with 0.7500 against fastweak's clamped 0.6906 — so `auto:simple` stopped
  // choosing the fast model. "Never observed" must not outrank "observed slow".
  const ranked = rankCandidates(M2_INPUT)
  assert.deepEqual(ids(ranked), ['fastweak/fq', 'balanced/bq', 'strongslow/sq'])
  const byId = new Map(ids(ranked).map((id, position) => [id, ranked[position]]))
  assert.ok(byId.get('fastweak/fq').score > byId.get('balanced/bq').score)
  assert.match(byId.get('balanced/bq').reasons.join(' | '), /latency never measured \(neutral factor 0\.85\)/)
  assert.match(byId.get('fastweak/fq').reasons.join(' | '), /0\.017x of the fastest/)
})

test('★ a measured-and-fast candidate beats a never-measured one with identical capabilities', () => {
  const identical = (health) => ({
    provider: 'p', model: 'm', caps: caps({ capability: 4, speed: 4 }),
    health: { failures: 0, effectiveFailures: 0, cooldownUntil: 0, latencyEwma: null, successes: 0, invalid: false, ...health },
  })
  const ranked = rankCandidates({
    tier: 'simple',
    now: 0,
    candidates: [
      { ...identical({ latencyEwma: 80_000 }), provider: 'slow', model: 'm' },
      { ...identical({}), provider: 'unknown', model: 'm' },
      { ...identical({ latencyEwma: 800 }), provider: 'fast', model: 'm' },
    ],
  })
  assert.equal(ranked[0].provider, 'fast', 'measured-fast must win')
  assert.ok(ranked[0].score > ranked[1].score, 'measured-fast must beat never-measured')
  const others = ranked.slice(1)
  assert.deepEqual(others.map((entry) => entry.provider).sort(), ['slow', 'unknown'])
  assert.equal(others[0].score, others[1].score, 'never-measured sits at the slowest measured factor')
  assert.match(others.find((entry) => entry.provider === 'unknown').reasons.join(' | '), /latency never measured/)
  assert.match(others.find((entry) => entry.provider === 'slow').reasons.join(' | '), /0\.01x of the fastest/)
})

test('latency does not participate at all when nothing has been measured', () => {
  const ranked = rankCandidates({
    tier: 'medium',
    now: 0,
    candidates: [candidate('a', 'm', { capability: 4, speed: 4 }), candidate('b', 'm', { capability: 4, speed: 4 })],
  })
  assert.equal(ranked[0].score, ranked[1].score)
  assert.match(ranked[0].reasons.join(' | '), /neutral factor 1/)
})

test('★ latency differences below the noise floor are ignored entirely', () => {
  // Two localhost mocks at 4 ms and 26 ms differ by 6x and mean nothing; ranking on
  // that would demote whichever candidate happened to answer first. Below the floor
  // the signal is dropped, so a never-measured peer keeps the same score.
  const ranked = rankCandidates({
    tier: 'medium',
    now: 0,
    candidates: [
      candidate('a', 'm', { capability: 4, speed: 4 }, { latencyEwma: 4 }),
      candidate('b', 'm', { capability: 4, speed: 4 }, { latencyEwma: 26 }),
      candidate('c', 'm', { capability: 4, speed: 4 }),
    ],
  })
  assert.equal(new Set(ranked.map((entry) => entry.score)).size, 1, 'no candidate may be ranked on noise')
  assert.match(ranked.find((entry) => entry.provider === 'b').reasons.join(' | '), /below the 100ms noise floor/)
})

test('latency differentiates again as soon as the spread is material', () => {
  const ranked = rankCandidates({
    tier: 'medium',
    now: 0,
    candidates: [
      candidate('a', 'm', { capability: 4, speed: 4 }, { latencyEwma: 4 }),
      candidate('b', 'm', { capability: 4, speed: 4 }, { latencyEwma: 5_000 }),
    ],
  })
  assert.ok(ranked[0].score > ranked[1].score)
  assert.equal(ranked[0].provider, 'a')
  assert.match(ranked[1].reasons.join(' | '), /0\.001x of the fastest/)
})

test('the neutral factor follows the slowest measurement, not a constant', () => {
  const ranked = rankCandidates({
    tier: 'simple',
    now: 0,
    candidates: [
      candidate('a', 'm', {}, { latencyEwma: 1_000 }),
      candidate('b', 'm', {}, { latencyEwma: 50_000 }),
      candidate('c', 'm', {}),
    ],
  })
  // b is measured at 50x a's latency, so b's factor is the floor (0.85) and the
  // unmeasured c inherits exactly that.
  const neutral = ranked.find((entry) => entry.provider === 'c')
  assert.match(neutral.reasons.join(' | '), /neutral factor 0\.85/)
  assert.equal(neutral.score, ranked.find((entry) => entry.provider === 'b').score)
})

test('decayed failures are what the score uses', () => {
  const fresh = rankCandidates({ tier: 'medium', now: 0, candidates: [candidate('a', 'm', {}, { failures: 2, effectiveFailures: 2 })] })[0]
  const decayed = rankCandidates({ tier: 'medium', now: 0, candidates: [candidate('a', 'm', {}, { failures: 2, effectiveFailures: 0.1 })] })[0]
  assert.ok(decayed.score > fresh.score)
  assert.match(decayed.reasons.join(' | '), /2 recent failure\(s\), decayed to 0\.1/)
})

test('a raw failure count without a decayed value still penalises (backwards compatible)', () => {
  const ranked = rankCandidates({ tier: 'medium', now: 0, candidates: [candidate('a', 'm', {}, { failures: 3 })] })
  assert.ok(ranked[0].score < 0.5)
  assert.match(ranked[0].reasons.join(' | '), /3 recent failure\(s\)/)
})

test('★ M-1: one 429 must not starve a candidate forever — it wins again once the cooldown expires', () => {
  let clock = 1_000_000
  const health = new HealthTracker({ now: () => clock })
  health.recordFailure('fastweak', 'fq', { status: 429 })

  const candidates = () => [
    { provider: 'fastweak', model: 'fq', caps: caps({ capability: 2, speed: 5 }), health: health.snapshot('fastweak', 'fq') },
    { provider: 'balanced', model: 'bq', caps: caps({ capability: 4, speed: 4 }), health: health.snapshot('balanced', 'bq') },
  ]
  const rank = () => rankCandidates({ tier: 'simple', now: clock, candidates: candidates() })

  // While the cooldown is active the pair is not a candidate at all.
  assert.equal(health.isAvailable('fastweak', 'fq'), false)
  assert.deepEqual(ids(rank()), ['balanced/bq'])

  // One millisecond past the first ladder step it must be selectable *and*
  // selected. `isAvailable()` alone would not prove that: the failure penalty
  // used to keep it behind `balanced` forever.
  clock += DEFAULT_COOLDOWN_LADDER[0] + 1
  assert.equal(health.isAvailable('fastweak', 'fq'), true)
  assert.equal(rank()[0].provider, 'fastweak', 'a decayed failure must let the preferred candidate back in front')

  // Ten hours later the residual penalty is gone entirely.
  clock += 10 * 3600_000
  const restored = rank()[0]
  assert.equal(restored.provider, 'fastweak')
  assert.ok(Math.abs(restored.score - 0.8125) < 0.001, `residual penalty still applied: ${restored.score}`)

  // And a success clears it outright.
  health.recordSuccess('fastweak', 'fq', 200)
  assert.equal(health.snapshot('fastweak', 'fq').effectiveFailures, 0)
})

// ---------------------------------------------------------------------------
// malformed capability metadata (L-3)
// ---------------------------------------------------------------------------

test('★ a malformed caps object is handled conservatively, never thrown on and never silently dropped', () => {
  const cases = [
    ['caps null', { provider: 'a', model: 'm', caps: null }],
    ['caps undefined', { provider: 'a', model: 'm' }],
    ['caps empty object', { provider: 'a', model: 'm', caps: {} }],
    ['caps scalar', { provider: 'a', model: 'm', caps: 5 }],
    ['caps array', { provider: 'a', model: 'm', caps: [] }],
    ['caps with junk fields', { provider: 'a', model: 'm', caps: { capability: 'x', speed: null, contextWindow: 'big' } }],
  ]
  for (const [label, candidateValue] of cases) {
    let ranked
    assert.doesNotThrow(() => {
      ranked = rankCandidates({ tier: 'medium', now: 0, tokens: 0, candidates: [candidateValue] })
    }, `${label} threw`)
    assert.equal(ranked.length, 1, `${label} silently dropped the candidate`)
    assert.equal(ranked[0].score, 0.5, `${label} should score as mid-range`)
    assert.match(ranked[0].reasons.join(' | '), /no context window declared/)
  }
})

test('a candidate with no declared context window is kept and explained, not silently dropped', () => {
  const input = { tier: 'medium', now: 0, tokens: 500, candidates: [{ provider: 'a', model: 'm', caps: { capability: 3, speed: 3 } }] }
  const ranked = rankCandidates(input)
  assert.deepEqual(ids(ranked), ['a/m'], 'a missing contextWindow must not silently remove the candidate')
  assert.match(ranked[0].reasons.join(' | '), /no context window declared/)
  // It only disappears when the conservative assumption genuinely cannot hold.
  const tooBig = rankCandidates({ ...input, tokens: 40_000 })
  assert.deepEqual(ids(tooBig), [])
  assert.match(explainExclusions({ ...input, tokens: 40_000 })[0].reason, /conservative default is assumed/)
})

test('a declared context window is used as-is and is not flagged as assumed', () => {
  const input = { tier: 'medium', now: 0, tokens: 500, candidates: [candidate('a', 'm', { contextWindow: 65_536 })] }
  const ranked = rankCandidates(input)
  assert.deepEqual(ids(ranked), ['a/m'])
  assert.equal(ranked[0].reasons.some((reason) => reason.includes('conservative default is assumed')), false)
})

test('missing capability/speed values are treated as mid-range, not as zero', () => {
  const ranked = rankCandidates({ tier: 'medium', now: 0, candidates: [{ provider: 'p', model: 'm', caps: {} }] })
  assert.equal(ranked.length, 1)
  assert.equal(ranked[0].score, 0.5)
})

test('reasons end with the numeric score, so a log line is self-explanatory', () => {
  const ranked = rank({ tier: 'simple' })
  for (const entry of ranked) {
    assert.match(entry.reasons.at(-1), /^score \d+(\.\d+)?$/)
  }
})

test('the router module imports nothing that could perform I/O', async () => {
  // Static proof of the purity requirement: `router.js` must not import any
  // module, which rules out fs/net/child_process by construction. A read-only
  // look at the local source file is not I/O against the outside world.
  const { readFile } = await import('node:fs/promises')
  let source
  try {
    source = await readFile(new URL('../lib/router.js', import.meta.url), 'utf8')
  } catch {
    return // bundled or relocated: nothing to assert
  }
  const imports = [...source.matchAll(/^\s*import\s.+$/gm)].map((match) => match[0].trim())
  assert.deepEqual(imports, [], `router.js must stay dependency-free, found: ${imports.join(' | ')}`)
  for (const forbidden of ['node:fs', 'node:http', 'node:net', 'child_process', 'Date.now', 'Math.random', 'process.env']) {
    assert.equal(source.includes(forbidden), false, `router.js must not reference ${forbidden}`)
  }
})
