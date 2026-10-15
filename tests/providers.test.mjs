/**
 * Provider pool tests: catalog integrity, user overrides, credential resolution
 * order and the silent "no key" rule.
 *
 * Offline: `resolveProviderKey` is always given an explicit `env` object, so no
 * ambient environment variable can leak into a result.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BUILTIN_PROVIDER_IDS,
  BUILTIN_PROVIDERS,
  CONSERVATIVE_CAPS,
  DEFAULT_ENABLED_PROVIDERS,
  KEYLESS_PROVIDER_IDS,
  isProviderUsable,
  listProviderModels,
  normalizeModel,
  providerById,
  resolveProviderKey,
  splitPoolModelId,
} from '../lib/providers.js'
import { offlinePool, mockProvider, model } from './helpers/pool.mjs'

const NO_ENV = {}

test('the pool is frozen and self-consistent', () => {
  assert.equal(Object.isFrozen(BUILTIN_PROVIDERS), true)
  assert.ok(BUILTIN_PROVIDERS.length >= 10, 'the pool should cover many providers')
  const ids = new Set()
  for (const provider of BUILTIN_PROVIDERS) {
    assert.equal(Object.isFrozen(provider), true, `${provider.id} must be frozen`)
    assert.equal(Object.isFrozen(provider.models), true)
    assert.ok(typeof provider.id === 'string' && provider.id.length > 0)
    assert.ok(typeof provider.displayName === 'string' && provider.displayName.length > 0)
    assert.ok(/^https:\/\//.test(provider.baseURL), `${provider.id} needs an https baseURL`)
    // apiKeyEnv is *our* convention, so every provider must declare one for the
    // user to override.
    assert.ok(typeof provider.apiKeyEnv === 'string' && provider.apiKeyEnv.length > 0, `${provider.id} needs an apiKeyEnv`)
    assert.equal(ids.has(provider.id), false, `duplicate provider ${provider.id}`)
    ids.add(provider.id)
    assert.ok(provider.models.length > 0, `${provider.id} has no models`)
    for (const entry of provider.models) {
      assert.ok(typeof entry.id === 'string' && entry.id.length > 0)
      assert.ok(typeof entry.name === 'string' && entry.name.length > 0)
      for (const key of ['capability', 'speed', 'contextWindow', 'maxTokens', 'vision', 'toolCalling']) {
        assert.ok(key in entry.caps, `${provider.id}/${entry.id} is missing caps.${key}`)
      }
      assert.ok(entry.caps.capability >= 1 && entry.caps.capability <= 5)
      assert.ok(entry.caps.speed >= 1 && entry.caps.speed <= 5)
      assert.ok(entry.caps.contextWindow > 0)
    }
  }
  assert.deepEqual([...BUILTIN_PROVIDER_IDS], BUILTIN_PROVIDERS.map((provider) => provider.id))
})

test('the default enabled set is exactly the five recommended providers', () => {
  const enabled = BUILTIN_PROVIDERS.filter((provider) => provider.enabled === true).map((provider) => provider.id)
  assert.deepEqual([...enabled].sort(), [...DEFAULT_ENABLED_PROVIDERS].sort())
  assert.deepEqual([...DEFAULT_ENABLED_PROVIDERS].sort(), ['cerebras', 'groq', 'kilo', 'llm7', 'openrouter'])
  assert.equal(enabled.length, 5, 'the pool must not enable everything by default')
})

test('at least two keyless providers are enabled, so install-and-run works with zero configuration', () => {
  const keylessEnabled = BUILTIN_PROVIDERS
    .filter((provider) => provider.keyless === true && provider.enabled === true)
    .map((provider) => provider.id)
  assert.ok(keylessEnabled.length >= 2, `expected >= 2 keyless default providers, got ${keylessEnabled.join(', ')}`)
  for (const id of KEYLESS_PROVIDER_IDS) {
    assert.equal(providerById(id)?.keyless, true, `${id} should be keyless`)
  }
})

test('the lead live-probe corrections are applied to the pool', () => {
  const kilo = providerById('kilo')
  const llm7 = providerById('llm7')
  const ids = (provider) => provider.models.map((entry) => entry.id)
  // Three ids the live probe proved dead must be gone.
  assert.equal(ids(kilo).includes('poolside/laguna-m.1:free'), false)
  assert.equal(ids(llm7).includes('gpt-oss-20b'), false)
  assert.equal(ids(llm7).includes('GLM-4.6V-Flash'), false)
  // And their verified replacements must be present.
  assert.ok(ids(kilo).includes('poolside/laguna-s-2.1:free'))
  assert.ok(ids(kilo).includes('nvidia/nemotron-3-ultra-550b-a55b:free'))
  assert.ok(ids(llm7).includes('DeepSeek-V4-Flash-0731'))
})

test('no model claims vision without probe or code evidence', () => {
  // A wrong `vision: true` sends images to a text-only model, which the user
  // cannot work around — so the flag is only set where T7 had code-level or
  // live-probe evidence, and never on the removed llm7 entry.
  //
  // The `openrouter` vision row is gone as of the free-model audit
  // (2026-10-15): `nvidia/nemotron-nano-12b-v2-vl:free` has no serving endpoint
  // and the zero-guess replacement had no evidenced capability/speed rating, so
  // the slot was dropped rather than filled with an invented number. Vision
  // coverage in the default-on pool therefore rests on cerebras — already true
  // before this change, and asserted below.
  const vision = []
  for (const provider of BUILTIN_PROVIDERS) {
    for (const entry of provider.models) {
      if (entry.caps.vision === true) vision.push(`${provider.id}/${entry.id}`)
    }
  }
  assert.deepEqual(vision.sort(), [
    'cerebras/llama-4-maverick-17b-128e-instruct',
    'github/openai/gpt-4.1',
    'github/openai/gpt-5',
    'zhipu/glm-4.6v-flash',
  ])
  // The default-on pool still has at least one vision option.
  const visionEnabled = vision.filter((id) => !id.startsWith('github/') && !id.startsWith('zhipu/'))
  assert.ok(visionEnabled.length >= 1)
})

test('the speculative providers are present but disabled', () => {
  for (const id of ['zhipu', 'volcengine', 'longcat']) {
    const provider = providerById(id)
    assert.ok(provider !== undefined, `${id} should stay in the catalog`)
    assert.equal(provider.enabled, false, `${id} must be off by default`)
    assert.equal(provider.confidence, 'speculative')
  }
})

// ---------------------------------------------------------------------------
// v0.7 additions — one guarding test per new provider (AC5)
// ---------------------------------------------------------------------------

/**
 * The six providers added in v0.7 (`docs/EXPANSION-v0.7.md` §5). They ship
 * `enabled: false` on purpose — catalog first, real-key verification later — so
 * nothing else in the suite walks their rows on purpose: the pool-wide
 * assertions above only reach them because they happen to iterate every
 * provider, and a *disabled* provider is one config edit away from serving
 * traffic. These tests make that edit safe.
 */
const V07_PROVIDER_IDS = ['modelscope', 'xfyun', 'siliconflow', 'sambanova', 'huggingface', 'routeway']

test('the six v0.7 providers are in the catalog, off by default, with unique apiKeyEnv names', () => {
  // Uniqueness is a property of the whole set, so it is collected across the
  // pool first: two providers sharing an env name means one credential silently
  // authenticates as the other, and `resolveProviderKey` would hand the wrong
  // key to whichever provider asks first — with no error anywhere.
  const ownersOf = new Map()
  for (const provider of BUILTIN_PROVIDERS) {
    const owners = ownersOf.get(provider.apiKeyEnv) ?? []
    owners.push(provider.id)
    ownersOf.set(provider.apiKeyEnv, owners)
  }
  for (const id of V07_PROVIDER_IDS) {
    const provider = providerById(id)
    assert.ok(provider !== undefined, `${id} is a v0.7 provider and must be in the catalog`)
    assert.equal(provider.enabled, false, `${id} must stay off until a real key verifies it`)
    assert.deepEqual(
      ownersOf.get(provider.apiKeyEnv),
      [id],
      `${id} apiKeyEnv ${provider.apiKeyEnv} must be declared by ${id} alone`,
    )
  }
})

for (const id of V07_PROVIDER_IDS) {
  test(`v0.7 provider ${id} ships an https endpoint with a healthy model catalog`, () => {
    const provider = providerById(id)
    assert.ok(provider !== undefined, `${id} must be in the catalog`)
    assert.match(provider.baseURL, /^https:\/\//, `${id} needs an https baseURL, got ${provider.baseURL}`)
    assert.ok(Array.isArray(provider.models) && provider.models.length > 0, `${id} must declare at least one model`)
    for (const entry of provider.models) {
      const contextWindow = entry.caps.contextWindow
      // `> 0` is also asserted pool-wide; the strict *integer* half is asserted
      // only here, and it is the half that matters: the context gate compares
      // this number to size a session, so a fractional or string value would
      // compare wrongly, exclude the wrong candidate and never throw.
      assert.ok(
        Number.isInteger(contextWindow) && contextWindow > 0,
        `${id}/${entry.id} needs a positive integer contextWindow, got ${JSON.stringify(contextWindow)}`,
      )
    }
  })
}

test('listProviderModels flattens the enabled pool into provider/model pairs', () => {
  const pairs = listProviderModels({})
  assert.ok(pairs.length >= 15)
  for (const pair of pairs) {
    assert.ok(typeof pair.provider === 'string' && pair.provider.length > 0)
    assert.ok(typeof pair.model === 'string' && pair.model.length > 0)
    assert.ok(typeof pair.baseURL === 'string' && pair.baseURL.length > 0)
    assert.ok(typeof pair.apiKeyEnv === 'string' && pair.apiKeyEnv.length > 0)
    assert.equal(typeof pair.keyless, 'boolean')
    assert.equal(typeof pair.caps.capability, 'number')
  }
  const providers = new Set(pairs.map((pair) => pair.provider))
  for (const disabled of ['github', 'mistral', 'zhipu', 'volcengine', 'longcat', 'nvidia', 'ovh']) {
    assert.equal(providers.has(disabled), false, `${disabled} is disabled and must not be listed`)
  }
})

test('a model id may contain slashes and still splits on the first one', () => {
  assert.deepEqual(splitPoolModelId('groq/openai/gpt-oss-120b'), { provider: 'groq', model: 'openai/gpt-oss-120b' })
  assert.deepEqual(splitPoolModelId('llm7/DeepSeek-V4-Flash-0731'), { provider: 'llm7', model: 'DeepSeek-V4-Flash-0731' })
  assert.equal(splitPoolModelId('auto'), undefined)
  assert.equal(splitPoolModelId('/x'), undefined)
  assert.equal(splitPoolModelId('x/'), undefined)
  assert.equal(splitPoolModelId(''), undefined)
})

test('user overrides can disable a provider, retarget it and replace its models', () => {
  const config = {
    providers: {
      groq: { enabled: false },
      cerebras: { apiKeyEnv: 'MY_CEREBRAS_KEY', baseURL: 'https://example.invalid/v1' },
      openrouter: { models: [{ id: 'only-this', capability: 4, speed: 4 }] },
    },
  }
  const pairs = listProviderModels(config)
  assert.equal(pairs.some((pair) => pair.provider === 'groq'), false)
  const cerebras = pairs.find((pair) => pair.provider === 'cerebras')
  assert.equal(cerebras.apiKeyEnv, 'MY_CEREBRAS_KEY')
  assert.equal(cerebras.baseURL, 'https://example.invalid/v1')
  const openrouter = pairs.filter((pair) => pair.provider === 'openrouter')
  assert.deepEqual(openrouter.map((pair) => pair.model), ['only-this'])
})

test('a user can add their own OpenAI-compatible endpoint', () => {
  const config = {
    providers: {
      mine: {
        displayName: 'My Endpoint',
        baseURL: 'https://mine.invalid/v1',
        apiKeyEnv: 'MINE_API_KEY',
        models: [{ id: 'home-model', name: 'Home Model', capability: 5, speed: 2, contextWindow: 65_536 }],
      },
    },
  }
  const pairs = listProviderModels(config)
  const mine = pairs.find((pair) => pair.provider === 'mine')
  assert.ok(mine !== undefined)
  assert.equal(mine.baseURL, 'https://mine.invalid/v1')
  assert.equal(mine.apiKeyEnv, 'MINE_API_KEY')
  assert.equal(mine.modelName, 'Home Model')
  assert.equal(mine.caps.capability, 5)
  // Unspecified capabilities fall back to the conservative defaults.
  assert.equal(mine.caps.maxTokens, CONSERVATIVE_CAPS.maxTokens)
  assert.equal(mine.caps.vision, false)
  assert.equal(mine.caps.toolCalling, false)
})

test('a user-declared provider is dropped when it has no usable endpoint or models', () => {
  assert.equal(listProviderModels({ providers: { broken: { apiKeyEnv: 'X' } } }).some((pair) => pair.provider === 'broken'), false)
  assert.equal(listProviderModels({ providers: { broken: { baseURL: 'https://x.invalid/v1', models: [] } } }).some((pair) => pair.provider === 'broken'), false)
})

test('malformed overrides degrade to the built-in pool instead of throwing', () => {
  const baseline = listProviderModels({})
  for (const providers of [null, 5, 'x', [], { groq: 7 }, { groq: null }, { '': {} }, { groq: { models: 'nope' } }]) {
    let pairs
    assert.doesNotThrow(() => {
      pairs = listProviderModels({ providers })
    })
    assert.ok(Array.isArray(pairs))
  }
  assert.deepEqual(listProviderModels({ providers: { groq: 7 } }), baseline)
})

test('normalizeModel keeps only usable declarations and defaults the rest', () => {
  assert.equal(normalizeModel(null), null)
  assert.equal(normalizeModel({}), null)
  assert.equal(normalizeModel({ id: '  ' }), null)
  const normalised = normalizeModel({ id: 'm', capability: 99, speed: -1, contextWindow: 0 })
  assert.equal(normalised.id, 'm')
  assert.equal(normalised.name, 'm')
  assert.equal(normalised.caps.capability, CONSERVATIVE_CAPS.capability)
  assert.equal(normalised.caps.speed, CONSERVATIVE_CAPS.speed)
  assert.equal(normalised.caps.contextWindow, CONSERVATIVE_CAPS.contextWindow)
})

// ---------------------------------------------------------------------------
// credential resolution
// ---------------------------------------------------------------------------

test('a keyless provider is usable with no key at all', () => {
  assert.equal(isProviderUsable({ keyless: true }, undefined), true)
  assert.equal(isProviderUsable({ keyless: true }, ''), true)
  assert.equal(isProviderUsable({ keyless: false }, undefined), false)
  assert.equal(isProviderUsable({ keyless: false }, '   '), false)
  assert.equal(isProviderUsable({ keyless: false }, 'k'), true)
  assert.equal(isProviderUsable(undefined, 'k'), true)
})

test('the credentials service is consulted first', async () => {
  const asked = []
  const key = await resolveProviderKey(
    { id: 'groq', apiKeyEnv: 'GROQ_API_KEY', apiKey: 'from-config' },
    {
      credentials: {
        resolve(ref) {
          asked.push(ref)
          return Promise.resolve({ value: 'from-credentials', source: 'store' })
        },
      },
      env: { GROQ_API_KEY: 'from-env' },
    },
  )
  assert.deepEqual(asked, ['GROQ_API_KEY'])
  assert.equal(key, 'from-credentials')
})

test('an explicit config key is used when the credentials service has nothing', async () => {
  const key = await resolveProviderKey(
    { id: 'groq', apiKeyEnv: 'GROQ_API_KEY', apiKey: 'from-config' },
    { credentials: { resolve: () => Promise.resolve(undefined) }, env: { GROQ_API_KEY: 'from-env' } },
  )
  assert.equal(key, 'from-config')
})

test('a blank credential from the service falls through to the next layer', async () => {
  const key = await resolveProviderKey(
    { id: 'groq', apiKeyEnv: 'GROQ_API_KEY', apiKey: '' },
    { credentials: { resolve: () => Promise.resolve({ value: '   ' }) }, env: { GROQ_API_KEY: 'from-env' } },
  )
  assert.equal(key, 'from-env')
})

test('the environment variable named by apiKeyEnv is used next', async () => {
  const key = await resolveProviderKey(
    { id: 'mine', apiKeyEnv: 'MY_OWN_NAME' },
    { env: { MY_OWN_NAME: 'env-key', MINE_API_KEY: 'convention-key' } },
  )
  assert.equal(key, 'env-key')
})

test('the generic <PROVIDER>_API_KEY convention is the last resort', async () => {
  const key = await resolveProviderKey(
    { id: 'my-provider', apiKeyEnv: 'SOMETHING_ELSE' },
    { env: { MY_PROVIDER_API_KEY: 'convention-key' } },
  )
  assert.equal(key, 'convention-key')
})

test('a failing credentials service does not mask the environment', async () => {
  const key = await resolveProviderKey(
    { id: 'groq', apiKeyEnv: 'GROQ_API_KEY' },
    {
      credentials: { resolve: () => { throw new Error('seam exploded') } },
      env: { GROQ_API_KEY: 'env-key' },
    },
  )
  assert.equal(key, 'env-key')
})

test('an unconfigured provider resolves to undefined without throwing', async () => {
  assert.equal(await resolveProviderKey({ id: 'groq', apiKeyEnv: 'GROQ_API_KEY' }, { env: NO_ENV }), undefined)
  assert.equal(await resolveProviderKey(undefined, { env: NO_ENV }), undefined)
  assert.equal(await resolveProviderKey({ id: 'groq' }, { env: NO_ENV }), undefined)
  assert.equal(await resolveProviderKey({ id: 'groq', apiKeyEnv: 'X' }, {}), undefined)
})

test('a synchronous credentials function is supported too', async () => {
  const key = await resolveProviderKey(
    { id: 'groq', apiKeyEnv: 'GROQ_API_KEY' },
    { credentials: (ref) => (ref === 'GROQ_API_KEY' ? 'sync-key' : undefined), env: NO_ENV },
  )
  assert.equal(key, 'sync-key')
})

test('keys are trimmed and never cached across calls', async () => {
  let value = '  first  '
  const provider = { id: 'groq', apiKeyEnv: 'GROQ_API_KEY' }
  const deps = { credentials: { resolve: () => Promise.resolve({ value }) }, env: NO_ENV }
  assert.equal(await resolveProviderKey(provider, deps), 'first')
  value = 'second'
  assert.equal(await resolveProviderKey(provider, deps), 'second')
})

test('the offline pool helper disables every built-in provider', () => {
  const providers = offlinePool([mockProvider('mock', 'http://127.0.0.1:1/v1', [model({ id: 'm1' })])])
  const pairs = listProviderModels({ providers })
  assert.deepEqual(pairs.map((pair) => `${pair.provider}/${pair.model}`), ['mock/m1'])
})
