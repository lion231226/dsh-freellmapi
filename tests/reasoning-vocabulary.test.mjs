/**
 * The measured reasoning-effort vocabulary must reach the place that can use it.
 *
 * ## Why this file exists
 *
 * `reasoning` is a **measured** capability: on 2026-10-15 a real credential showed
 * Groq validating `reasoning_effort` against an explicit allowlist, and showed the
 * vocabulary differing **per model** (`qwen/qwen3.8-27b` accepts `none`; both
 * gpt-oss models reject it). A measured capability that is silently dropped between
 * the pool and its consumer is invisible — this repository has paid for that twice,
 * with `verified` and with the `contextWindow` cross-family references.
 *
 * So the property asserted here is not "the field exists in providers.js" but "the
 * field survives the transform that feeds the picker and the adapter". A test that
 * read the source declaration would pass even with the drop in place.
 *
 * ## What is deliberately NOT asserted
 *
 * That any model DECLARES this to DSH. Declaring is gated on `forwardReasoningEffort`
 * (see the design notes), and asserting a declaration here would pin behaviour that
 * has not been decided. The vocabulary is data; the declaration is a separate call.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { listProviderModels, providerById, providerDeclarations } from '../lib/providers.js'

/** The vocabulary a real credential measured for each row on 2026-10-15. */
const MEASURED = Object.freeze({
  'openai/gpt-oss-120b': ['low', 'medium', 'high'],
  'qwen/qwen3.8-27b': ['low', 'medium', 'high', 'none'],
  'openai/gpt-oss-20b': ['low', 'medium', 'high'],
})

test('★ a measured reasoning vocabulary survives into everything that reads the pool', () => {
  const declarations = providerDeclarations({}).find((entry) => entry.id === 'groq')
  const listed = new Map(listProviderModels({}).filter((row) => row.provider === 'groq').map((row) => [row.model, row]))

  for (const [id, expected] of Object.entries(MEASURED)) {
    const declared = declarations.models.find((model) => model.id === id)
    assert.ok(declared !== undefined, `${id} should be in the groq declaration`)
    assert.deepEqual(declared.reasoning, expected, `${id}: the declaration lost its vocabulary`)

    // The load-bearing half: the same field on the row the picker and the adapter
    // actually consume. Without this, a measured capability is dropped in silence.
    const row = listed.get(id)
    assert.ok(row !== undefined, `${id} should reach listProviderModels`)
    assert.deepEqual(row.reasoning, expected,
      `${id}: listProviderModels dropped the measured vocabulary — the exact silent-drop shape this guards`)
  }
})

test('★ a model with no measured vocabulary claims none', () => {
  // An absent field is the honest "not measured". Nothing may inherit a claim from
  // its provider or its family: the vocabulary is per model, which is precisely what
  // the measurement showed.
  for (const row of listProviderModels({})) {
    if (row.provider === 'groq' && Object.hasOwn(MEASURED, row.model)) continue
    assert.equal(row.reasoning, undefined,
      `${row.provider}/${row.model} claims a reasoning vocabulary that was never measured`)
  }
})

test('★ the drop-condition rejects the shapes that make it past upstream validation', () => {
  // SCOPE, learned by reverse injection: this assertion is NOT load-bearing, and the
  // first version of this file overstated it. An injection that removed the
  // `every(...)` predicate left the guard green — because `providerDeclarations()`
  // never hands `listProviderModels` a malformed value in the first place. The
  // predicate is defence in depth, not the thing preventing malformed claims.
  //
  // So this test asserts only what is true: for the malformed shapes, the resulting
  // row carries no vocabulary claim. Whether the drop happens in the predicate or
  // upstream of it is deliberately not pinned — asserting a location would pin
  // implementation detail, and the first version's real error was claiming a
  // property (the predicate is load-bearing) that the evidence did not support.
  const malformed = [[], [''], [1, 2], 'low', { low: true }]
  for (const value of malformed) {
    const rows = listProviderModels({
      providers: {
        'malformed-fixture': {
          enabled: true,
          baseURL: 'https://example.invalid/v1',
          apiKeyEnv: 'MALFORMED_FIXTURE_KEY',
          displayName: 'Malformed fixture',
          keyless: false,
          models: [{
            id: 'm1',
            name: 'M1',
            caps: { capability: 3, speed: 3, contextWindow: 8192, maxTokens: 1024, vision: false, toolCalling: false },
            reasoning: value,
          }],
        },
      },
    }).filter((row) => row.provider === 'malformed-fixture')

    // Verified non-vacuous: the fixture really does produce a row (a config the
    // transform ignores would make this whole test pass while testing nothing).
    assert.equal(rows.length, 1, `fixture with reasoning=${JSON.stringify(value)} should produce exactly one row`)
    assert.equal(rows[0].reasoning, undefined,
      `reasoning=${JSON.stringify(value)} must not become a capability claim, got ${JSON.stringify(rows[0].reasoning)}`)
  }
})
