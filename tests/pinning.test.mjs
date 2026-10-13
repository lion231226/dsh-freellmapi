/**
 * Pinned-model (strict mode) and credential-aware catalog tests.
 *
 * ## What this file exists to catch
 *
 * The plugin used to *silently substitute*: asking for `llama-3.3-70b-versatile`
 * with no `GROQ_API_KEY` answered from `kilo/cohere/north-mini-code:free` and
 * reported `finish: stop` — a success the user could not tell apart from the model
 * they asked for. A made-up model id behaved the same way.
 *
 * The mock pool in this file therefore checks the thing the old tests did not:
 * **whether the request should have been sent at all**. Every assertion about a
 * refusal is paired with `requests.length === 0` across the whole pool, because
 * "it returned an error" is not evidence that nothing was quietly dispatched.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { SETUP_MODEL_PREFIX, setupHint, setupModelId } from '../lib/catalog.js'
import { keyEntryPoints, providerDeclarations } from '../lib/providers.js'
import { clearRecentRoutes, getRecentRoutes } from '../lib/routes.js'
import { assertValidChunkSequence, collect } from './helpers/harness.mjs'
import { mountPlugin } from './helpers/context.mjs'
import { model, offlinePool, startMockPool } from './helpers/pool.mjs'

/** A provider declaration that needs a credential nobody has set. */
const needsKeyProvider = (id, baseURL, models, apiKeyEnv = `${id.toUpperCase()}_API_KEY`) => ({
  id,
  displayName: `${id[0].toUpperCase()}${id.slice(1)}`,
  baseURL,
  apiKeyEnv,
  apiKey: '',
  keyless: false,
  models,
})

const ask = (model, extra = {}) => ({
  provider: 'freellmapi',
  model,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  ...extra,
})

const totalRequests = (pool) => [...pool.endpoints.values()].reduce((sum, mock) => sum + mock.requests.length, 0)

/** Two providers: one that needs a key, one keyless that must never stand in. */
async function twoProviderPool() {
  return startMockPool([
    {
      id: 'keylessmock',
      answer: 'KEYLESS-ANSWER',
      models: [model({ id: 'cheap-model', capability: 3, speed: 4 })],
      keyless: true,
    },
    {
      id: 'keyedmock',
      answer: 'KEYED-ANSWER',
      models: [model({ id: 'premium-model', capability: 5, speed: 5 })],
      keyless: false,
    },
  ])
}

/** Turn the keyed mock into one that requires a credential nobody set. */
function withoutKey(pool) {
  return { ...pool.config, keyedmock: { ...pool.config.keyedmock, apiKey: '', apiKeyEnv: 'PINNING_TEST_UNSET_KEY' } }
}

// ---------------------------------------------------------------------------
// ★ the core proof: a pinned model that cannot be served is refused, not replaced
// ---------------------------------------------------------------------------

test('★ a pinned model whose provider has no credential is refused, and nothing is dispatched', async () => {
  const pool = await twoProviderPool()
  try {
    clearRecentRoutes()
    const mounted = mountPlugin({ config: { mode: 'direct', providers: withoutKey(pool) } })
    const result = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('keyedmock/premium-model'))))

    assert.equal(result.finish.kind, 'error')
    assert.equal(result.finish.failure.code, 'MISSING_CREDENTIAL')
    // ★ The decisive assertion: the request was refused, not quietly re-aimed at
    // the keyless provider that would have answered happily.
    assert.equal(totalRequests(pool), 0, 'no upstream request may be sent for an unservable pin')
    assert.equal(pool.requests('keylessmock').length, 0, 'the keyless provider must not silently stand in')
    assert.equal(result.blocks.length, 0, 'nothing may be streamed for a refused pin')
  } finally {
    await pool.close()
  }
})

test('★ a pinned model whose provider has no credential explains exactly what to set', async () => {
  const pool = await twoProviderPool()
  try {
    const mounted = mountPlugin({ config: { mode: 'direct', providers: withoutKey(pool) } })
    const result = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('keyedmock/premium-model'))))
    const message = result.finish.failure.message
    assert.match(message, /PINNING_TEST_UNSET_KEY/, 'the message must name the exact environment variable')
    assert.match(message, /premium-model/)
    assert.match(message, /DSH settings page/)
    assert.match(message, /"auto"/)
  } finally {
    await pool.close()
  }
})

test('★ a bare model id is a pin too — it does not fall through to the tier router', async () => {
  const pool = await twoProviderPool()
  try {
    const mounted = mountPlugin({ config: { mode: 'direct', providers: withoutKey(pool) } })
    // No slash: this is what the picker used to show as "Llama 3.3 70B · Groq".
    const result = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('premium-model'))))
    assert.equal(result.finish.kind, 'error')
    assert.equal(result.finish.failure.code, 'MISSING_CREDENTIAL')
    assert.equal(totalRequests(pool), 0)
  } finally {
    await pool.close()
  }
})

test('★ a model id that exists nowhere is refused with guidance, and nothing is dispatched', async () => {
  const pool = await twoProviderPool()
  try {
    clearRecentRoutes()
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
    const result = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('totally-made-up-model-xyz'))))

    assert.equal(result.finish.kind, 'error')
    assert.equal(result.finish.failure.code, 'UNKNOWN_MODEL')
    assert.match(result.finish.failure.message, /totally-made-up-model-xyz/)
    assert.match(result.finish.failure.message, /"auto"/)
    assert.equal(totalRequests(pool), 0, '★ an unknown id must never be answered by another model')
    assert.equal(getRecentRoutes().at(-1).provider, undefined, 'no provider may be recorded as having served it')
  } finally {
    await pool.close()
  }
})

test('an unknown id suggests the closest pool model', async () => {
  const pool = await twoProviderPool()
  try {
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
    const result = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('keyword/premium-models'))))
    assert.equal(result.finish.failure.code, 'UNKNOWN_MODEL')
    assert.match(result.finish.failure.message, /Closest matches: .*premium-model/)
  } finally {
    await pool.close()
  }
})

test('pinning a model whose provider is disabled explains how to enable it', async () => {
  const pool = await twoProviderPool()
  try {
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
    const result = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('mistral/codestral-latest'))))
    assert.equal(result.finish.failure.code, 'UNKNOWN_MODEL')
    assert.match(result.finish.failure.message, /Provider "mistral" is disabled by default/)
    assert.match(result.finish.failure.message, /config\.providers\.mistral/)
    assert.equal(totalRequests(pool), 0)
  } finally {
    await pool.close()
  }
})

test('a pinned model that is cooling down is reported, not rerouted', async () => {
  const pool = await twoProviderPool()
  try {
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
    // Serve it once so it is usable, then park it.
    const first = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('keyedmock/premium-model'))))
    assert.equal(first.finish.kind, 'stop')
    mounted.adapter.health.recordFailure('keyedmock', 'premium-model', { status: 429 })

    const before = totalRequests(pool)
    const result = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('keyedmock/premium-model'))))
    assert.equal(result.finish.kind, 'error')
    assert.equal(result.finish.failure.code, 'MODEL_UNAVAILABLE')
    assert.match(result.finish.failure.message, /cooling down/)
    assert.match(result.finish.failure.message, /"auto"/)
    assert.equal(totalRequests(pool), before, 'a cooling pin must not be answered by another provider')
  } finally {
    await pool.close()
  }
})

test('a pinned model never fails over to a different model id', async () => {
  const pool = await startMockPool([
    { id: 'a', answer: 'A', models: [model({ id: 'wanted', capability: 5, speed: 5, toolCalling: true })] },
    { id: 'b', answer: 'B', models: [model({ id: 'other', capability: 5, speed: 5, toolCalling: true })] },
  ])
  try {
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
    // `wanted` cannot serve a request that declares tools (declared false here).
    const mountedNoTools = mountPlugin({
      config: {
        mode: 'direct',
        providers: { ...pool.config, a: { ...pool.config.a, models: [{ ...model({ id: 'wanted', capability: 5, speed: 5 }), toolCalling: false }] } },
      },
    })
    void mounted
    const result = assertValidChunkSequence(await collect(mountedNoTools.adapter.stream(ask('a/wanted', {
      tools: [{ name: 't', description: '', parameters: { type: 'object' } }],
    }))))
    assert.equal(result.finish.kind, 'error')
    assert.equal(pool.requests('b').length, 0, 'the other model id must not be substituted')
  } finally {
    await pool.close()
  }
})

// ---------------------------------------------------------------------------
// regressions: auto keeps behaving like auto
// ---------------------------------------------------------------------------

test('auto still routes and fails over freely', async () => {
  const pool = await startMockPool([
    { id: 'fastmock', answer: 'FAST', models: [model({ id: 'fast-weak', capability: 2, speed: 5 })] },
    { id: 'strongmock', answer: 'STRONG', models: [model({ id: 'strong-slow', capability: 5, speed: 2 })] },
  ])
  try {
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
    const result = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('auto', {
      messages: [{ role: 'user', content: [{ type: 'text', text: '列出这个目录下的文件' }] }],
    }))))
    assert.equal(result.finish.kind, 'stop')
    assert.equal(pool.requests('fastmock').length, 1)
  } finally {
    await pool.close()
  }
})

test('auto:simple and auto:complex still force a lane', async () => {
  const pool = await startMockPool([
    { id: 'fastmock', answer: 'FAST', models: [model({ id: 'fast-weak', capability: 2, speed: 5 })] },
    { id: 'strongmock', answer: 'STRONG', models: [model({ id: 'strong-slow', capability: 5, speed: 2 })] },
  ])
  try {
    const mounted = mountPlugin({ config: { mode: 'direct', providers: pool.config } })
    const simple = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('auto:simple'))))
    assert.equal(simple.blocks.map((block) => block.text).join(''), 'FAST')
    const complex = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('auto:complex'))))
    assert.equal(complex.blocks.map((block) => block.text).join(''), 'STRONG')
  } finally {
    await pool.close()
  }
})

// ---------------------------------------------------------------------------
// the catalog: one guidance line per uncredentialed provider
// ---------------------------------------------------------------------------

test('★ a provider with no credential contributes exactly one setup line and no dead models', async () => {
  const pool = await startMockPool([
    { id: 'keylessmock', answer: 'K', models: [model({ id: 'cheap-model' })], keyless: true },
    {
      id: 'keyedmock',
      answer: 'X',
      models: [model({ id: 'premium-model' }), model({ id: 'second-model' }), model({ id: 'third-model' })],
      keyless: false,
    },
  ])
  try {
    const mounted = mountPlugin({ config: { mode: 'direct', providers: withoutKey(pool) } })
    const models = await mounted.adapter.listModels('freellmapi')
    const ids = models.map((entry) => entry.id)

    assert.equal(ids[0], 'auto', 'auto must stay first')
    const setup = models.filter((entry) => entry.id.startsWith(SETUP_MODEL_PREFIX))
    assert.equal(setup.length, 1, `expected exactly one setup line, got ${JSON.stringify(ids)}`)
    assert.equal(setup[0].id, setupModelId('keyedmock'))
    assert.match(setup[0].name, /PINNING_TEST_UNSET_KEY/)
    assert.equal(models.filter((entry) => entry.id.startsWith('keyedmock/')).length, 0, 'no dead model rows may be listed')
    assert.ok(ids.includes('keylessmock/cheap-model'), 'the keyless provider keeps its models')

    // The runtime's catalog validator still accepts the result.
    const seen = new Set()
    for (const entry of models) {
      assert.equal(entry.provider, 'freellmapi')
      assert.ok(typeof entry.name === 'string' && entry.name.length > 0)
      assert.equal(seen.has(entry.id), false, `duplicate id ${entry.id}`)
      seen.add(entry.id)
    }
  } finally {
    await pool.close()
  }
})

test('the setup line names the environment variable and where to get a key', () => {
  assert.equal(
    setupHint({ displayName: 'Groq', apiKeyEnv: 'GROQ_API_KEY', keyURL: 'https://console.groq.com/keys' }),
    'Groq ▸ needs GROQ_API_KEY (free key: console.groq.com/keys)',
  )
  // No application URL is not an excuse to omit the guidance.
  assert.equal(
    setupHint({ displayName: 'Cerebras', apiKeyEnv: 'CEREBRAS_API_KEY', keyURL: null }),
    'Cerebras ▸ needs CEREBRAS_API_KEY (free key: configure it in DSH settings)',
  )
  assert.match(setupHint({}), /needs the API key/)
})

test('setup lines come after the models that actually work', async () => {
  const pool = await startMockPool([
    { id: 'keylessmock', answer: 'K', models: [model({ id: 'cheap-model' })], keyless: true },
    { id: 'keyedmock', answer: 'X', models: [model({ id: 'premium-model' })], keyless: false },
  ])
  try {
    const mounted = mountPlugin({ config: { mode: 'direct', providers: withoutKey(pool) } })
    const ids = (await mounted.adapter.listModels('freellmapi')).map((entry) => entry.id)
    assert.ok(
      ids.indexOf('keylessmock/cheap-model') < ids.indexOf(setupModelId('keyedmock')),
      `reachable models must come first: ${JSON.stringify(ids)}`,
    )
  } finally {
    await pool.close()
  }
})

test('★ configuring the credential swaps the setup line for the real models', async () => {
  const pool = await startMockPool([
    { id: 'keyedmock', answer: 'X', models: [model({ id: 'premium-model' }), model({ id: 'second-model' })] },
  ])
  const providers = withoutKey(pool)
  try {
    const withoutCredentials = mountPlugin({ config: { mode: 'direct', providers } })
    const before = (await withoutCredentials.adapter.listModels('freellmapi')).map((entry) => entry.id)
    assert.deepEqual(before, ['auto', 'auto:simple', 'auto:medium', 'auto:complex', setupModelId('keyedmock')])

    // The credentials service now answers for that reference.
    const withCredentials = mountPlugin({
      config: { mode: 'direct', providers },
      services: {
        credentials: {
          resolve: (ref) => (ref === 'PINNING_TEST_UNSET_KEY' ? Promise.resolve({ value: 'test-key-not-real' }) : Promise.resolve(undefined)),
        },
      },
    })
    const after = (await withCredentials.adapter.listModels('freellmapi')).map((entry) => entry.id)
    assert.deepEqual(after, ['auto', 'auto:simple', 'auto:medium', 'auto:complex', 'keyedmock/premium-model', 'keyedmock/second-model'])
    assert.equal(after.some((id) => id.startsWith(SETUP_MODEL_PREFIX)), false, 'the setup line must disappear')
  } finally {
    await pool.close()
  }
})

test('a disabled provider contributes nothing at all, not even a setup line', async () => {
  const mounted = mountPlugin({ config: { mode: 'direct', providers: offlinePool([]) } })
  const ids = (await mounted.adapter.listModels('freellmapi')).map((entry) => entry.id)
  assert.deepEqual(ids, ['auto', 'auto:simple', 'auto:medium', 'auto:complex'])
})

test('the zero-credential default pool advertises only reachable models plus guidance', async () => {
  // The shipped pool, with nothing configured except an unhelpful credential seam.
  const mounted = mountPlugin({
    config: { mode: 'direct' },
    services: { credentials: { resolve: () => Promise.resolve(undefined) } },
  })
  const models = await mounted.adapter.listModels('freellmapi')
  const ids = models.map((entry) => entry.id)
  const setup = ids.filter((id) => id.startsWith(SETUP_MODEL_PREFIX))
  const concrete = ids.filter((id) => id.includes('/') && !id.startsWith(SETUP_MODEL_PREFIX))

  // Every concrete row belongs to a keyless provider, so every advertised model is
  // reachable right now.
  for (const id of concrete) {
    const provider = id.slice(0, id.indexOf('/'))
    assert.ok(['kilo', 'llm7', 'ovh'].includes(provider), `${id} is advertised but needs a key`)
  }
  // The three default-enabled keyed providers each contribute one guidance line.
  assert.deepEqual(setup.sort(), ['setup:cerebras', 'setup:groq', 'setup:openrouter'])
  assert.ok(ids.includes('setup:groq'))
  assert.match(models.find((entry) => entry.id === 'setup:groq').name, /GROQ_API_KEY/)
})

// ---------------------------------------------------------------------------
// selecting a guidance row must answer with that guidance
// ---------------------------------------------------------------------------

test('★ selecting a setup row answers with the guidance itself, and dispatches nothing', async () => {
  const pool = await twoProviderPool()
  try {
    clearRecentRoutes()
    const mounted = mountPlugin({ config: { mode: 'direct', providers: withoutKey(pool) } })
    const listed = await mounted.adapter.listModels('freellmapi')
    const row = listed.find((entry) => entry.id === setupModelId('keyedmock'))
    assert.ok(row, 'the fixture must produce a setup row')

    const before = totalRequests(pool)
    const result = assertValidChunkSequence(await collect(mounted.adapter.stream(ask(row.id))))

    assert.equal(result.finish.kind, 'error')
    assert.equal(result.finish.failure.code, 'SETUP_REQUIRED')
    const message = result.finish.failure.message
    // The label the user clicked and the answer they get come from one constructor.
    assert.ok(message.startsWith(row.name), `the answer must open with the label: ${message}`)
    assert.match(message, /PINNING_TEST_UNSET_KEY/, 'the message must name the exact environment variable')
    assert.match(message, /DSH settings page/)
    // ★ The regression: this used to be answered as a mistyped model id.
    assert.equal(
      /no provider in the pool serves/.test(message),
      false,
      'a guidance row must never be described as an unknown model',
    )
    assert.equal(totalRequests(pool), before, 'a guidance row must not dispatch anything')
    assert.equal(result.blocks.length, 0)
  } finally {
    await pool.close()
  }
})

test('★ every shipped setup row answers with its own guidance', async () => {
  const mounted = mountPlugin({
    config: { mode: 'direct' },
    services: { credentials: { resolve: () => Promise.resolve(undefined) } },
  })
  const rows = (await mounted.adapter.listModels('freellmapi')).filter((entry) => entry.id.startsWith(SETUP_MODEL_PREFIX))
  assert.deepEqual(rows.map((entry) => entry.id).sort(), ['setup:cerebras', 'setup:groq', 'setup:openrouter'])

  for (const row of rows) {
    const result = assertValidChunkSequence(await collect(mounted.adapter.stream(ask(row.id))))
    assert.equal(result.finish.failure.code, 'SETUP_REQUIRED', `${row.id} must report SETUP_REQUIRED`)
    const message = result.finish.failure.message
    assert.ok(message.startsWith(row.name), `${row.id} answer must open with its label`)
    assert.match(message, /needs [A-Z0-9_]+_API_KEY/, `${row.id} must name the env var`)
    // The hint carries the *host*, not the full URL: "console.groq.com/keys".
    assert.match(message, /\(free key: [^)]+\)/, `${row.id} must say where to get a key`)
    assert.equal(/no provider in the pool serves/.test(message), false, `${row.id} must not be an unknown-model error`)
  }
  // The one that was broken: the label promised a console address, so the answer must too.
  const cerebras = rows.find((row) => row.id === 'setup:cerebras')
  const answer = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('setup:cerebras'))))
  assert.ok(answer.finish.failure.message.startsWith(cerebras.name))
  assert.match(answer.finish.failure.message, /cloud\.cerebras\.ai/)
})

test('★ resolveModel and listModels agree on the name of a guidance row', async () => {
  const mounted = mountPlugin({
    config: { mode: 'direct' },
    services: { credentials: { resolve: () => Promise.resolve(undefined) } },
  })
  const listed = await mounted.adapter.listModels('freellmapi')
  for (const row of listed.filter((entry) => entry.id.startsWith(SETUP_MODEL_PREFIX))) {
    const resolved = await mounted.adapter.resolveModel('freellmapi', row.id)
    assert.equal(resolved.name, row.name, `${row.id}: one entity, one name`)
    assert.equal(resolved.id, row.id)
    assert.deepEqual(resolved.inputModalities, ['text'])
  }
  // The path a row takes through prepareCall must agree too.
  const prepared = await mounted.adapter.prepareCall('freellmapi', setupModelId('groq'))
  assert.equal(prepared.model.name, listed.find((entry) => entry.id === 'setup:groq').name)
})

test('★ a setup row takes a different branch from a genuinely mistyped model id', async () => {
  const mounted = mountPlugin({
    config: { mode: 'direct' },
    services: { credentials: { resolve: () => Promise.resolve(undefined) } },
  })
  const setup = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('setup:groq'))))
  const typo = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('totally-made-up-model-xyz'))))
  const almostSetup = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('setup:nosuchprovider'))))

  assert.equal(setup.finish.failure.code, 'SETUP_REQUIRED')
  assert.equal(typo.finish.failure.code, 'UNKNOWN_MODEL', 'fixing setup must not swallow the unknown-model branch')
  assert.notEqual(setup.finish.failure.code, typo.finish.failure.code)
  // A `setup:` id naming a provider that does not exist is still just unknown.
  assert.equal(almostSetup.finish.failure.code, 'UNKNOWN_MODEL')
  assert.match(almostSetup.finish.failure.message, /no provider in the pool serves/)
  // And the two messages must not be interchangeable.
  assert.equal(setup.finish.failure.message.includes('no provider in the pool serves'), false)
  assert.equal(typo.finish.failure.message.includes('needs'), false)
})

test('a setup row is refused before any credential is resolved', async () => {
  // The row exists precisely because the credential is missing; resolving it (or
  // worse, dispatching with it) would defeat the point.
  const pool = await twoProviderPool()
  try {
    let resolved = 0
    const mounted = mountPlugin({
      config: { mode: 'direct', providers: withoutKey(pool) },
      services: {
        credentials: {
          resolve: () => {
            resolved += 1
            return Promise.resolve(undefined)
          },
        },
      },
    })
    await collect(mounted.adapter.stream(ask(setupModelId('keyedmock'))))
    assert.equal(resolved, 0, 'answering a guidance row must not touch the credential seam')
    assert.equal(totalRequests(pool), 0)
  } finally {
    await pool.close()
  }
})

// ---------------------------------------------------------------------------
// the key-application URL has exactly one source
// ---------------------------------------------------------------------------

test('★ every enabled provider that needs a key publishes a key-application URL', () => {
  // A provider the user is told to configure must never produce an address-less
  // hint. Keyless providers are exempt: they are always usable, so they never
  // emit a setup line at all, and inventing a key page for them would be noise.
  for (const declaration of providerDeclarations({})) {
    if (declaration.enabled !== true) continue
    if (declaration.keyless === true) continue
    assert.ok(
      typeof declaration.keyURL === 'string' && declaration.keyURL.length > 0,
      `provider "${declaration.id}" is enabled and needs a key, but declares no keyURL`,
    )
    assert.match(declaration.keyURL, /^https:\/\//, `${declaration.id} keyURL must be a real https URL`)
  }
})

test('★ the shipped Cerebras guidance carries its console URL', async () => {
  const mounted = mountPlugin({
    config: { mode: 'direct' },
    services: { credentials: { resolve: () => Promise.resolve(undefined) } },
  })
  const models = await mounted.adapter.listModels('freellmapi')
  const cerebras = models.find((entry) => entry.id === setupModelId('cerebras'))
  assert.ok(cerebras, 'cerebras must produce a setup line with no credential')
  assert.match(cerebras.name, /CEREBRAS_API_KEY/)
  assert.match(cerebras.name, /cloud\.cerebras\.ai/)
  assert.match(cerebras.description, /cloud\.cerebras\.ai/)
  assert.equal(cerebras.name.includes('null'), false)
})

test('★ the setup hint never leaks "null" or an empty address', () => {
  for (const declaration of providerDeclarations({})) {
    const hint = setupHint(declaration)
    assert.equal(hint.includes('null'), false, `${declaration.id}: ${hint}`)
    assert.equal(hint.includes('undefined'), false, `${declaration.id}: ${hint}`)
    assert.match(hint, /needs \S+/, `${declaration.id}: ${hint}`)
  }
})

test('★ dispatch.js carries no hardcoded key-entry-point table of its own', async () => {
  // The drift that started this task: `dispatch.js` knew
  // `Cerebras https://cloud.cerebras.ai/` while `providers.js` had `null`, so the
  // picker told users to "configure it in DSH settings" for a provider whose
  // console address the other table already had. One source means no URLs here.
  const source = await readFile(new URL('../lib/dispatch.js', import.meta.url), 'utf8')
  const urls = source.match(/https?:\/\/[^\s'"`]+/g) ?? []
  assert.deepEqual(urls, [], `lib/dispatch.js must not hardcode key URLs (found ${JSON.stringify(urls)})`)
})

test('★ the NO_CANDIDATES diagnosis quotes the same URLs the picker shows', async () => {
  const mounted = mountPlugin({ config: { mode: 'direct', providers: offlinePool([]) } })
  const result = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('auto'))))
  assert.equal(result.finish.kind, 'error')
  assert.equal(result.finish.failure.code, 'NO_CANDIDATES')
  const message = result.finish.failure.message

  const entryPoints = keyEntryPoints({})
  assert.ok(entryPoints.length > 0, 'the default pool must publish entry points')
  for (const entry of entryPoints.slice(0, 5)) {
    assert.ok(message.includes(entry.keyURL), `the diagnosis must quote ${entry.keyURL} (${entry.id})`)
  }
  // The specific regression: cerebras used to be listed here and nowhere else.
  assert.ok(entryPoints.some((entry) => entry.id === 'cerebras'), 'cerebras must be an entry point')
  assert.ok(message.includes('cloud.cerebras.ai'))
})

test('an enabled provider with an overridden keyURL is quoted, not the built-in one', async () => {
  const mounted = mountPlugin({
    config: {
      mode: 'direct',
      providers: { ...offlinePool([]), groq: { enabled: true, keyURL: 'https://example.invalid/keys' } },
    },
  })
  const result = assertValidChunkSequence(await collect(mounted.adapter.stream(ask('auto'))))
  assert.equal(result.finish.failure.code, 'NO_CANDIDATES')
  assert.ok(result.finish.failure.message.includes('https://example.invalid/keys'))
})
