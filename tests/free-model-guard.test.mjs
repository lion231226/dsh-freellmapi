/**
 * The free-model guard — what makes the word "free" in this pool mean something.
 *
 * ## The incident these tests exist for
 *
 * `lib/providers.js` shipped four `openrouter` ids ending in `:free` and the model
 * picker called them free. On 2026-10-15 an anonymous price check found **all
 * four unservable**: three still had a catalogue record with `endpoints: []`, one
 * answered HTTP 404. The suffix was a naming convention doing a price claim's job.
 * (`_lead/research/free-model-audit.md`.)
 *
 * ## What is asserted instead
 *
 * A free row must carry a `verified` evidence record, and that record must agree
 * with a committed fixture — the byte-exact anonymous response it came from:
 *
 *   - `tests/fixtures/openrouter-models-2026-10-15.json` (462 entries, 774 095 B)
 *   - `tests/fixtures/kilo-models-2026-10-15.json` (394 entries, 490 164 B)
 *   - `tests/fixtures/openrouter-endpoints-2026-10-15.json` (per-model bodies,
 *     so `endpoints` and the endpoint prices are checkable offline)
 *
 * The criterion lives in `lib/free.js` and is never re-implemented here; the
 * thresholds are asserted so they cannot be relaxed to make a red test green.
 *
 * ## Not every free claim is price-checkable, and pretending otherwise is worse
 *
 * `routeway` also ships four `:free` ids, but its catalogue publishes **no
 * pricing field at all** (only id, context length and availability), so there is
 * nothing to verify against. Manufacturing a `verified` record for it would be
 * inventing evidence — the exact failure this module exists to prevent. Such a
 * claim is therefore allowed only when it is **named here with its reason** and
 * ships **disabled**. The set of free-claiming providers is pinned, so a new one
 * cannot arrive unexamined, and a row that cannot be checked may not claim
 * evidence it does not have.
 *
 * ## Two test styles, deliberately
 *
 * The pool assertions are **time-dependent on purpose**: evidence older than
 * `FREE_VERIFIED_BLOCK_DAYS` turns them red, which is the point — a stale claim is
 * a defect, and the fix is to re-measure, not to widen the window. The
 * state-machine assertions pass an explicit `now`, so the ageing logic itself is
 * deterministic.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  FREE_VERIFIED_BLOCK_DAYS,
  FREE_VERIFIED_STALE_DAYS,
  freeVerificationState,
  isFreePriced,
  isFreeVerified,
  isVerifiedRecord,
  isZeroPrice,
  verifiedAgeDays,
} from '../lib/free.js'
import { BUILTIN_PROVIDERS, listProviderModels, normalizeModel, providerById } from '../lib/providers.js'
import { buildDirectCatalog } from '../lib/catalog.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(HERE, 'fixtures')
const readFixture = (name) => readFileSync(path.join(FIXTURES, name), 'utf8')
const sha256 = (text) => createHash('sha256').update(text).digest('hex')

const index = JSON.parse(readFixture('free-verification-index.json'))
const openrouterCatalog = JSON.parse(readFixture(index.fixtures.openrouter.file))
const kiloCatalog = JSON.parse(readFixture(index.fixtures.kilo.file))
const endpointsFixture = JSON.parse(readFixture(index.fixtures.openrouterEndpoints.file))

/** The four ids the audit proved unservable on 2026-10-15. */
const DEAD_IDS = [
  'deepseek/deepseek-v3.1:free',
  'moonshotai/kimi-k2.6:free',
  'qwen/qwen3-coder:free',
  'nvidia/nemotron-nano-12b-v2-vl:free',
]

/** Providers whose free rows carry committed, re-checkable price evidence. */
const PRICE_VERIFIABLE_PROVIDERS = new Set(['openrouter', 'kilo'])

/**
 * Free-claiming providers whose claim **cannot** be price-checked, with the
 * reason. Shipping a `:free` id is only tolerable here while the provider is
 * disabled by default; anything else would put an unverifiable claim in front of
 * a user.
 */
const UNVERIFIABLE_FREE_CLAIMANTS = new Map([
  ['routeway', 'the Routeway catalogue publishes no pricing field (id, context_length and available only), so "free" rests on the upstream naming convention and cannot be price-checked. It ships `enabled: false` for this reason.'],
])

/**
 * Every pool row that *claims* freeness. The claim can be either the id suffix or
 * the word in the display name; both must be backed by evidence, because a user
 * reads the name, not the id.
 */
const freeClaimingRows = () => {
  const rows = []
  for (const provider of BUILTIN_PROVIDERS) {
    for (const entry of provider.models) {
      if (entry.id.endsWith(':free') || /free/i.test(entry.name)) rows.push({ provider, entry })
    }
  }
  return rows
}

/** Free rows whose provider publishes prices, i.e. the rows that must be proven. */
const provenFreeRows = () => freeClaimingRows().filter(({ provider }) => PRICE_VERIFIABLE_PROVIDERS.has(provider.id))

/** Free rows that cannot be proven, i.e. the rows that must be declared instead. */
const declaredFreeRows = () => freeClaimingRows().filter(({ provider }) => !PRICE_VERIFIABLE_PROVIDERS.has(provider.id))

/** Ids a catalogue publishes at zero price, optionally requiring its own free flag. */
const zeroPricedIds = (catalog, { requireProviderFlag = false } = {}) => new Set(
  (catalog.data ?? [])
    .filter((entry) => isFreePriced(entry?.pricing))
    .filter((entry) => requireProviderFlag !== true || entry?.isFree === true)
    .map((entry) => entry.id),
)

/** A minimal well-formed record, for the predicate tests. */
const record = (overrides = {}) => ({
  at: '2026-10-15T19:25:01+08:00',
  method: 'anonymous GET https://openrouter.ai/api/v1/models',
  pricing: { prompt: '0', completion: '0' },
  endpoints: 1,
  endpointPricingZero: true,
  bodySha256: 'a'.repeat(64),
  ...overrides,
})

// ---------------------------------------------------------------------------
// the fixtures are the bytes the pool cites
// ---------------------------------------------------------------------------

test('the free-pricing fixtures are the exact bytes the pool cites', () => {
  for (const [name, fixture] of Object.entries(index.fixtures)) {
    assert.equal(
      sha256(readFixture(fixture.file)),
      fixture.sha256,
      `${name}: tests/fixtures/${fixture.file} is not the response the evidence was taken from`,
    )
  }
  const known = new Set(Object.values(index.fixtures).map((fixture) => fixture.sha256))
  for (const { provider, entry } of provenFreeRows()) {
    assert.ok(
      known.has(entry.verified?.bodySha256),
      `${provider.id}/${entry.id} cites a body hash no committed fixture matches — the claim cannot be re-checked`,
    )
  }
})

// ---------------------------------------------------------------------------
// a claim is backed by a live zero price
// ---------------------------------------------------------------------------

test('every pool row that claims to be free is zero-priced in its committed fixture', () => {
  const free = {
    openrouter: zeroPricedIds(openrouterCatalog),
    kilo: zeroPricedIds(kiloCatalog, { requireProviderFlag: true }),
  }
  const rows = provenFreeRows()
  assert.ok(rows.length >= 8, `expected the price-verifiable free rows to be walked, found ${rows.length}`)
  for (const { provider, entry } of rows) {
    assert.ok(
      free[provider.id].has(entry.id),
      `${provider.id}/${entry.id} claims to be free but is not a zero-priced entry of its live catalogue fixture`,
    )
  }
})

test('the naming convention is never the criterion', () => {
  // A paid row that happens to end in `:free` must be rejected...
  assert.equal(isFreePriced({ prompt: '0.00000025', completion: '0.00000095' }), false)
  assert.equal(isFreeVerified(record({ pricing: { prompt: '0', completion: '0.00000341' } })), false)
  // ...and the four ids the audit proved dead must not be readable as free from
  // any live catalogue again, however tempting the suffix looks.
  const openrouterFree = zeroPricedIds(openrouterCatalog)
  for (const id of DEAD_IDS) {
    assert.equal(
      openrouterFree.has(id),
      false,
      `${id} is back in the live zero-price set — re-verify it (endpoints, then price) before shipping it`,
    )
  }
})

// ---------------------------------------------------------------------------
// the evidence record itself
// ---------------------------------------------------------------------------

test('a free claim carries a well-formed record with its criterion and fetch time', () => {
  for (const { provider, entry } of provenFreeRows()) {
    assert.equal(
      isVerifiedRecord(entry.verified),
      true,
      `${provider.id}/${entry.id} claims to be free without a well-formed \`verified\` record`,
    )
    assert.equal(entry.verified.pricing.prompt, '0', `${provider.id}/${entry.id} must carry the observed price fields`)
    assert.equal(entry.verified.pricing.completion, '0', `${provider.id}/${entry.id} must carry the observed price fields`)
    assert.equal(entry.verified.endpointPricingZero, true, `${provider.id}/${entry.id} must record the endpoint price check`)
    assert.match(entry.verified.method, /anonymous/i, `${provider.id}/${entry.id} must record that the probe sent no credential`)
  }
})

test('free evidence has not expired, and the thresholds cannot be widened', () => {
  // Pinned on purpose: relaxing either number is how a guard gets "fixed"
  // without the underlying claim being re-verified.
  assert.equal(FREE_VERIFIED_STALE_DAYS, 60)
  assert.equal(FREE_VERIFIED_BLOCK_DAYS, 90)
  for (const { provider, entry } of provenFreeRows()) {
    const state = freeVerificationState(entry.verified)
    assert.notEqual(state, 'missing', `${provider.id}/${entry.id} has no evidence`)
    assert.notEqual(state, 'malformed', `${provider.id}/${entry.id} has malformed evidence`)
    assert.notEqual(
      state,
      'expired',
      `${provider.id}/${entry.id}: free evidence is ${verifiedAgeDays(entry.verified)} days old (limit ${FREE_VERIFIED_BLOCK_DAYS}).`
      + ' Re-measure the catalogue and refresh `verified` — do not widen the window.',
    )
  }
})

test('the ageing state machine is deterministic', () => {
  const taken = Date.parse('2026-10-15T19:25:01+08:00')
  const at = (days) => taken + days * 86_400_000
  assert.equal(verifiedAgeDays(record(), taken), 0)
  assert.equal(freeVerificationState(record(), at(0)), 'ok')
  assert.equal(freeVerificationState(record(), at(FREE_VERIFIED_STALE_DAYS)), 'ok')
  assert.equal(freeVerificationState(record(), at(FREE_VERIFIED_STALE_DAYS + 1)), 'stale')
  assert.equal(freeVerificationState(record(), at(FREE_VERIFIED_BLOCK_DAYS)), 'stale')
  assert.equal(freeVerificationState(record(), at(FREE_VERIFIED_BLOCK_DAYS + 1)), 'expired')
  assert.equal(freeVerificationState(undefined, taken), 'missing')
  assert.equal(freeVerificationState({ at: 'not a date' }, taken), 'malformed')
})

// ---------------------------------------------------------------------------
// endpoints: a zero price nobody serves is not free
// ---------------------------------------------------------------------------

test('the recorded endpoint counts match the committed endpoint responses', () => {
  const rows = providerById('openrouter').models
  assert.ok(rows.length > 0)
  for (const entry of rows) {
    const observed = endpointsFixture.ids[entry.id]
    assert.ok(observed !== undefined, `${entry.id} has no committed /endpoints response`)
    assert.equal(observed.status, 200, `${entry.id}: the endpoint probe did not answer 200`)
    assert.equal(entry.verified.endpoints, observed.endpointCount, `${entry.id}: recorded endpoint count differs from the response`)
    assert.ok(observed.endpointCount >= 1, `${entry.id}: zero serving endpoints — a zero price there buys nothing`)
    // Recompute "all endpoint prices are zero" from the committed body instead of
    // trusting the boolean the pool ships.
    const body = JSON.parse(observed.body)
    const endpoints = Array.isArray(body?.data?.endpoints) ? body.data.endpoints : []
    const allZero = endpoints.length > 0 && endpoints.every((endpoint) => isZeroPrice(endpoint?.pricing))
    assert.equal(allZero, entry.verified.endpointPricingZero, `${entry.id}: endpoint price claim does not match the committed body`)
  }
})

// ---------------------------------------------------------------------------
// claims that cannot be checked must be declared, not fabricated
// ---------------------------------------------------------------------------

test('a free claim that cannot be price-checked is declared, unproven and disabled', () => {
  const claimants = [...new Set(freeClaimingRows().map(({ provider }) => provider.id))].sort()
  // Pinned: a provider that starts shipping `:free` ids must be either verified
  // (with fixtures) or named in UNVERIFIABLE_FREE_CLAIMANTS with a reason.
  assert.deepEqual(claimants, ['kilo', 'openrouter', 'routeway'])
  for (const { provider, entry } of declaredFreeRows()) {
    assert.ok(
      UNVERIFIABLE_FREE_CLAIMANTS.has(provider.id),
      `${provider.id}/${entry.id} claims to be free without price evidence and without a declared reason`,
    )
    assert.equal(
      entry.verified,
      undefined,
      `${provider.id}/${entry.id} must not carry a \`verified\` record: there is no measurement behind it`,
    )
    assert.equal(
      provider.enabled,
      false,
      `${provider.id} ships an unverifiable free claim and must stay disabled until a real credential confirms it`,
    )
  }
  // The declaration carries a reason a reader can act on, not just a name.
  for (const [, reason] of UNVERIFIABLE_FREE_CLAIMANTS) assert.ok(reason.length > 80)
})

// ---------------------------------------------------------------------------
// transport: the evidence must survive the pool → picker path
// ---------------------------------------------------------------------------

test('a user declaration cannot certify itself', () => {
  const declared = normalizeModel({ id: 'mine:free', name: 'Mine (free)', verified: record() })
  assert.equal(declared.verified, undefined, 'normalizeModel must not accept self-declared free evidence')
})

test('pool evidence survives to the picker, and the pool is frozen around it', () => {
  for (const entry of providerById('openrouter').models) {
    assert.equal(Object.isFrozen(entry.verified), true, `${entry.id}: evidence must be frozen with the pool`)
  }
  const pairs = listProviderModels({})
  const carriers = pairs.filter((pair) => pair.verified !== undefined)
  assert.ok(carriers.length >= 8, `expected evidence to reach the pair list, got ${carriers.length}`)
  for (const pair of carriers) {
    assert.match(pair.verified.bodySha256, /^[0-9a-f]{64}$/)
    assert.equal(isVerifiedRecord(pair.verified), true)
  }
  const first = pairs.find((pair) => pair.provider === 'openrouter')
  assert.equal(first.verified.bodySha256, index.fixtures.openrouter.sha256)
})

test('the alias escape hatch is explicit, never implied', () => {
  assert.equal(isFreeVerified(record({ endpoints: 0 })), false, 'zero endpoints must not read as free')
  assert.equal(isFreeVerified(record({ endpoints: 0, alias: true })), true, 'a declared alias may have no endpoint list')
})

test('isFreePriced accepts only the literal zero the catalogues publish', () => {
  for (const bad of [null, undefined, '0', {}, { prompt: '0' }, { completion: '0' }, { prompt: '', completion: '' }]) {
    assert.equal(isFreePriced(bad), false, `${JSON.stringify(bad)} must not count as free`)
  }
  assert.equal(isFreePriced({ prompt: '0', completion: '0' }), true)
  // Numbers are NOT silently accepted: a catalogue switching to numeric prices
  // must turn this red so a human re-reads the method, rather than passing on a
  // coincidence. (`isZeroPrice`, the strong form, tolerates both.)
  assert.equal(isFreePriced({ prompt: 0, completion: 0 }), false)
  assert.equal(isZeroPrice({ prompt: '0', completion: '0', discount: 0 }), true)
  assert.equal(isZeroPrice({ prompt: '0', completion: '0', image: '0.001' }), false, 'a charged image field is not free')
  assert.equal(isZeroPrice({}), false)
})

// ---------------------------------------------------------------------------
// what the user actually reads (project rule 3)
// ---------------------------------------------------------------------------

test('the picker row states the criterion and the date, and an unverified row claims nothing', () => {
  const catalog = buildDirectCatalog({ provider: 'freellmapi', vision: true }, listProviderModels({}))
  const freeRow = catalog.find((row) => row.id === 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free')
  assert.ok(freeRow !== undefined, 'the openrouter free rows must be in the catalog')
  assert.match(freeRow.description, /free: pricing\.prompt === "0" && pricing\.completion === "0" && endpoints >= 1/)
  assert.match(freeRow.description, /verified 2026-10-15/)
  assert.match(freeRow.description, /anonymous price check/)
  // A row with no evidence may not print a free note at all.
  const plainRow = catalog.find((row) => row.id.startsWith('groq/'))
  assert.ok(plainRow !== undefined)
  assert.doesNotMatch(plainRow.description, /free:/, 'a row without evidence must not claim freeness')
})
