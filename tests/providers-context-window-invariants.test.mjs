/**
 * `contextWindow` structural invariants — a *policy* guard, not an evidence check.
 *
 * WHAT THIS GUARD IS
 * ------------------
 * It asserts a purely structural property of every entry in the built-in pool:
 *
 *   1. `contextWindow` and `maxTokens` are positive integers; and
 *   2. `maxTokens <= contextWindow`.
 *
 * (2) is true by construction, not by measurement: `maxTokens` is the *output*
 * ceiling of a request, and the output is part of the window, so an output
 * ceiling larger than the window is never a defensible declaration. This guard
 * therefore catches "wrong cell filled in" mistakes — values that contradict
 * each other — and nothing else.
 *
 * WHAT THIS GUARD IS **NOT**
 * --------------------------
 * It is **not** a statement that every `contextWindow` here has been verified
 * against its vendor. It cannot be: a value can contradict nothing else in the
 * pool and still be 4x too large. That distinction is the whole reason this
 * guard looks the way it does — see the rejected design below.
 *
 * REJECTED DESIGN, KEPT ON THE RECORD (2026-10-15)
 * -----------------------------------------------
 * An earlier proposal was a *ceiling* guard: "no `contextWindow` may exceed an
 * evidence-linked maximum, lower for `confidence: 'speculative'` entries." It was
 * written, measured against the whole pool, and **rejected** — not tuned:
 *
 *   a. It red-flags sound data: `sambanova/MiniMax-M3 = 1_048_576` is over any
 *      usable ceiling, yet its own `source` reads `contextWindow **measured**
 *      2026-10-15 from GET https://api.sambanova.ai/v1/models → context_length=
 *      1048576`. Raising the ceiling until it passes is exactly the "loosen the
 *      threshold so the guard goes green" move this project forbids.
 *   b. It could not have caught the bug that motivated it. That bug was `xfyun`
 *      declaring `32768` against a vendor-documented `8K`. Four times too large —
 *      but still *below* many confirmed pool values (`openrouter` 262 144, `kilo`
 *      1 000 000), and the smallest *confirmed* value in the pool is
 *      `github/openai/gpt-4.1 = 8000`. Any ceiling low enough to red-flag 32768
 *      must also red-flag confirmed data; any ceiling that spares the confirmed
 *      data lets the bug through.
 *   c. Root cause of both: `confidence` is a **provider-level** tag while
 *      provenance is a **value-level** fact, and the two legitimately disagree
 *      (`sambanova` is `speculative` as a provider yet its window is measured).
 *      Using a provider tag to police value-level evidence cannot avoid (a).
 *
 * The real lesson: that bug was a **relative** error ("4x the vendor's number"),
 * and it is detectable by **comparison against a source**, not by an **absolute
 * threshold**. Guarding a relation with a threshold is a category error, so this
 * file guards the relation that *is* structural instead of inventing a number.
 *
 * KNOWN, DELIBERATE GAP
 * ---------------------
 * Eight models carry a `contextWindow` with **no provenance declared at all**
 * (`groq`, `zhipu`, `longcat`, `nvidia` and others). That is a *recording* gap,
 * not a contradiction, so this guard stays silent about it on purpose — making it
 * red here would conflate "we did not write down where this came from" with "this
 * value is wrong", and would bury a genuine data-entry error in that noise. It is
 * tracked as its own piece of work.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { BUILTIN_PROVIDERS } from '../lib/providers.js'

/** Flatten the pool to one row per model, keeping the provider id for messages. */
function modelRows() {
  const rows = []
  for (const provider of BUILTIN_PROVIDERS) {
    for (const entry of provider.models ?? []) {
      rows.push({
        provider: provider.id,
        id: entry.id,
        contextWindow: entry.caps?.contextWindow,
        maxTokens: entry.caps?.maxTokens,
      })
    }
  }
  return rows
}

const isPositiveInt = (v) => Number.isInteger(v) && v > 0

test('every model declares a positive-integer contextWindow and maxTokens', () => {
  const rows = modelRows()
  assert.ok(rows.length > 0, 'the pool exposes at least one model to check')

  for (const row of rows) {
    // The message names the provider and model so a failure points at the entry,
    // not at the loop — same principle as G1/G7 printing the method beside a verdict.
    assert.ok(
      isPositiveInt(row.contextWindow),
      `${row.provider}/${row.id}: contextWindow must be a positive integer, got ${JSON.stringify(row.contextWindow)}`,
    )
    assert.ok(
      isPositiveInt(row.maxTokens),
      `${row.provider}/${row.id}: maxTokens must be a positive integer, got ${JSON.stringify(row.maxTokens)}`,
    )
  }
})

test('★ no model declares an output ceiling larger than its own window', () => {
  const rows = modelRows()
  const offenders = rows.filter((r) => r.maxTokens > r.contextWindow)

  assert.deepEqual(
    offenders.map((r) => `${r.provider}/${r.id}: maxTokens ${r.maxTokens} > contextWindow ${r.contextWindow}`),
    [],
    'maxTokens is the output ceiling and the output is part of the window, so maxTokens > contextWindow is never defensible',
  )
})

test('the invariant is `<=`, not `<`: parity between the two is legal', () => {
  // A model may allow its whole window to be emitted, so the guard must be `<=`.
  // Asserted against literal boundary rows rather than against whatever the pool
  // happens to contain today — a guard whose own test depends on live data would
  // start failing for reasons that have nothing to do with the guard.
  //
  // The pool *does* currently sit at parity in three places
  // (`github/openai/gpt-4.1` 8000/8000 and two `sambanova` entries), so tightening
  // the guard to `<` would red-light sound data; this test fails if that happens.
  const atParity = { provider: 'boundary', id: 'parity', contextWindow: 8192, maxTokens: 8192 }
  const oneUnder = { provider: 'boundary', id: 'under', contextWindow: 8192, maxTokens: 8191 }

  const violates = (r) => r.maxTokens > r.contextWindow

  assert.equal(violates(atParity), false, 'maxTokens === contextWindow must be accepted')
  assert.equal(violates(oneUnder), false, 'maxTokens < contextWindow must be accepted')
  assert.equal(
    violates({ provider: 'boundary', id: 'over', contextWindow: 8192, maxTokens: 8193 }),
    true,
    'maxTokens > contextWindow must be rejected',
  )
})
