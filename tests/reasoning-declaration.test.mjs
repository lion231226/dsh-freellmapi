/**
 * The reasoning declaration: declared only where it can be kept.
 *
 * ## What is being guarded, and why it needs a test at all
 *
 * A `reasoning` declaration tells DSH which thinking-effort values this route
 * accepts. Two ways to get it wrong, and this file pins both:
 *
 *  1. **Declaring while the adapter withholds the field.** `forwardReasoningEffort`
 *     governs whether `reasoning_effort` is actually sent upstream. If the
 *     declaration were independent of that flag, DSH would accept an effort and the
 *     adapter would then drop it — a promise kept by nobody, and the silent
 *     degradation this plugin exists to avoid. Gating both on one flag makes
 *     declaration and forwarding impossible to disagree.
 *
 *  2. **Declaring on `auto`.** `auto` is one name for a pool whose members were
 *     measured to differ (`qwen/qwen3.8-27b` accepts `none`; both gpt-oss models
 *     reject it). A pool-wide intersection is the vocabulary of *no* member, so a
 *     declaration there would be true of nothing — and would silently apply to
 *     whichever model the router picked.
 *
 * The measurement behind the values lives in `lib/providers.js` with its probe
 * cited per row; this file asserts the plumbing, not the vocabulary.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { mountPlugin } from './helpers/context.mjs'

/** A model whose vocabulary a real credential measured on 2026-10-15. */
const MEASURED_MODEL = 'groq/qwen/qwen3.8-27b'
const MEASURED_EFFORTS = ['low', 'medium', 'high', 'none']
/** Two routes that must never carry a declaration. */
const UNMEASURED_MODEL = 'cerebras/llama3.1-8b'
const AUTO = 'auto'

async function reasoningOf (config, model) {
  const mounted = mountPlugin({ config: { mode: 'direct', ...config } })
  try {
    return (await mounted.adapter.resolveModel('freellmapi', model))?.reasoning
  } finally {
    await mounted.close?.()
  }
}

test('★ with forwarding off, nothing is declared anywhere', async () => {
  // The default. A declaration here would be a claim the adapter does not honour,
  // so the whole feature must be invisible until it is switched on.
  assert.equal(await reasoningOf({}, MEASURED_MODEL), undefined,
    'a measured model must not declare effort while the adapter withholds the field')
  assert.equal(await reasoningOf({}, AUTO), undefined, 'auto must never declare effort')
  assert.equal(await reasoningOf({}, UNMEASURED_MODEL), undefined, 'an unmeasured model must not declare effort')

  // And explicitly false must behave the same as absent — a config default that
  // drifted would otherwise flip this silently.
  assert.equal(await reasoningOf({ forwardReasoningEffort: false }, MEASURED_MODEL), undefined,
    'forwardReasoningEffort:false must declare nothing, exactly like the default')
})

test('★ with forwarding on, only the measured CONCRETE model declares', async () => {
  const declared = await reasoningOf({ forwardReasoningEffort: true }, MEASURED_MODEL)
  assert.deepEqual(declared?.efforts, MEASURED_EFFORTS.map((id) => ({ id, name: id })),
    'the measured vocabulary should be declared verbatim, one entry per accepted value')
  for (const entry of declared?.efforts ?? []) {
    assert.ok(typeof entry.name === 'string' && entry.name.length > 0,
      `each declared effort must carry a non-empty name, got ${JSON.stringify(entry)}`)
  }

  // The two negatives that matter. `auto` because a pool intersection is nobody's
  // vocabulary; an unmeasured model because the absence of a measurement is not a
  // licence to guess.
  assert.equal(await reasoningOf({ forwardReasoningEffort: true }, AUTO), undefined,
    'auto must never declare effort — its members were measured to differ')
  assert.equal(await reasoningOf({ forwardReasoningEffort: true }, UNMEASURED_MODEL), undefined,
    'a model with no measured vocabulary must not declare one')
})

test('★ no defaultEffort is ever declared', async () => {
  // Setting `defaultEffort` makes DSH fill the effort in for requests that did not
  // ask for one — including requests routed to a model that would ignore it. The
  // declaration must therefore carry `efforts` and nothing else.
  const declared = await reasoningOf({ forwardReasoningEffort: true }, MEASURED_MODEL)
  assert.ok(declared !== undefined, 'the measured concrete model should declare')
  assert.equal(declared.defaultEffort, undefined,
    'defaultEffort must be omitted: it would inject an effort into every request')
  assert.deepEqual(Object.keys(declared), ['efforts'],
    `the declaration should carry only efforts, got ${JSON.stringify(Object.keys(declared))}`)
})
