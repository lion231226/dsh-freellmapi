/**
 * Configuration resilience tests.
 *
 * The contract under test is negative: *no* configuration value — however
 * malformed — may throw, and `Config` must speak Cordis' Standard Schema call
 * shape (`Config['~standard'].validate(value)` → `{value}`).
 *
 * It must also be a *live schemastery schema*, not a plain object: `dsh-settings`
 * skips an entry without `toJSON()`, and an entry with no settings namespace
 * leaves this plugin's provider invisible in the Models page while it keeps
 * routing. The schema assertions below are the regression guard for that.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { Config, DEFAULTS, configSchemaKind, normalizeConfig } from '../lib/config.js'

test('the exported Config speaks the Standard Schema protocol Cordis calls', () => {
  // cordis does `runtime.Config['~standard'].validate(config)` and throws if the
  // result is a promise or carries `issues`.
  const standard = Config['~standard']
  assert.equal(typeof standard.validate, 'function')
  const result = standard.validate({ baseURL: 'http://localhost:3001/v1' })
  assert.equal(typeof result.then, 'undefined', 'validation must be synchronous')
  assert.equal(result.issues, undefined)
  // Validated fields arrive as schemastery `Volatile` references (every field is
  // `.volatile()`), so `normalizeConfig` is what turns them into plain values.
  assert.equal(normalizeConfig(result.value).baseURL, 'http://localhost:3001/v1')
})

test('no configuration value can make the schema report an issue', () => {
  // Any reported issue becomes a `ValidationError` inside cordis and fails the
  // plugin's fiber, so this is the load-safety contract.
  const samples = [
    undefined, null, 7, 'x', [], true,
    { baseURL: 7 }, { logRoutedVia: 'yes' }, { headers: 5 }, { contextWindow: 'abc' },
    { maxTokensField: 'nope' }, { maxTokens: -3 }, { timeoutMs: {} }, { apiKey: [] },
    { baseURL: 'not a url' }, { discoveryCacheMs: 'soon' }, { taskType: 5 }, { cacheMode: null },
  ]
  for (const sample of samples) {
    const result = Config['~standard'].validate(sample)
    assert.equal(result.issues, undefined, `sample ${JSON.stringify(sample)} produced issues`)
    const config = normalizeConfig(result.value)
    assert.equal(typeof config.baseURL, 'string')
    assert.ok(config.baseURL.startsWith('http'))
    assert.equal(typeof config.logRoutedVia, 'boolean')
  }
})

test('configSchemaKind is always schemastery', () => {
  // It used to report which branch a guarded dynamic import took. That branch no
  // longer exists; keeping the field lets a stale profile surface the difference.
  assert.equal(configSchemaKind, 'schemastery')
})

test('the exported Config is a schemastery schema the settings service will mount', () => {
  // The regression guard for a bug that hid for hours: the schema was built by a
  // guarded dynamic `import()`, and when that import failed — a `link:`-ed
  // install resolves bare specifiers from its realpath, not the profile — it
  // silently degraded to a plain object.
  //
  // The degradation is not local. `dsh-settings` skips an entry without
  // `toJSON()` (`dsh-settings/lib/index.js:538-541`), so the entry gets no
  // namespace; the Models page then cannot resolve one for this plugin's
  // provider, which makes the provider invisible in the UI while it keeps routing
  // traffic. Nothing logs and nothing throws.
  //
  // The earlier revision of this test returned early when the kind was not
  // `schemastery`, so it passed throughout the entire bug. Assert, never skip.
  assert.equal(typeof Config.toJSON, 'function', 'settings.schema(entry) requires "toJSON" in schema')

  // `volatileForm(schema)` reads the *live* schema: it needs `type === 'object'`
  // and at least one child whose `meta.volatile` is true, or it returns undefined
  // and the entry is skipped anyway.
  assert.equal(Config.type, 'object')
  const fields = Object.entries(Config.dict ?? {})
  assert.ok(fields.length > 0, 'the generated form needs at least one volatile field')
  for (const [key, field] of fields) {
    assert.equal(field.meta.volatile, true, `field "${key}" must be volatile so an edit re-resolves in place`)
    assert.equal(typeof field.meta.description, 'string', `field "${key}" must carry a description for the form`)
  }

  // The Models page resolves a provider row's credential reference as
  // `namespace.value[settingsPath].apiKeyEnv` (`apiKeyEnvOf` in
  // dsh-client-ui-settings-models), and this plugin declares
  // `settingsPath: ['providers', 'freellmapi']`. Without `providers` in the
  // schema the row can never become configurable.
  assert.ok(
    fields.some(([key]) => key === 'providers'),
    'the schema must declare `providers`: the Models page resolves apiKeyEnv under it'
  )
})

test('an absent configuration yields the documented defaults', () => {
  const config = normalizeConfig(undefined)
  assert.equal(config.baseURL, 'http://localhost:3001/v1')
  assert.equal(config.apiKeyEnv, 'FREELLMAPI_API_KEY')
  assert.equal(config.apiKey, '')
  assert.equal(config.maxTokensField, 'max_tokens')
  assert.equal(config.logRoutedVia, DEFAULTS.logRoutedVia)
  assert.equal(config.includeFusion, true)
  assert.equal(config.exposeDiscoveredModels, true)
  assert.equal(config.vision, true)
  assert.equal(config.contextWindow, 131_072)
  assert.equal(config.maxTokens, 0)
  assert.equal(config.timeoutMs, 600_000)
  assert.deepEqual(config.headers, {})
})

test('every malformed field falls back to its default instead of throwing', () => {
  const config = normalizeConfig({
    baseURL: 12,
    apiKeyEnv: null,
    apiKey: { get: 'nope' },
    maxTokensField: 'max_output_tokens',
    logRoutedVia: 'maybe',
    includeFusion: [],
    exposeDiscoveredModels: 3,
    vision: 'off',
    contextWindow: -5,
    maxTokens: 'abc',
    timeoutMs: Number.NaN,
    discoveryTimeoutMs: 0,
    discoveryCacheMs: -1,
    headers: 'not-an-object',
    taskType: 'nonsense',
    cacheMode: 'sometimes',
  })
  assert.equal(config.baseURL, DEFAULTS.baseURL)
  assert.equal(config.apiKeyEnv, DEFAULTS.apiKeyEnv)
  assert.equal(config.apiKey, '')
  assert.equal(config.maxTokensField, 'max_tokens')
  assert.equal(config.logRoutedVia, true)
  assert.equal(config.includeFusion, true)
  assert.equal(config.exposeDiscoveredModels, true)
  assert.equal(config.vision, true)
  assert.equal(config.contextWindow, DEFAULTS.contextWindow)
  assert.equal(config.maxTokens, 0)
  assert.equal(config.timeoutMs, DEFAULTS.timeoutMs)
  assert.equal(config.discoveryTimeoutMs, DEFAULTS.discoveryTimeoutMs)
  assert.equal(config.discoveryCacheMs, DEFAULTS.discoveryCacheMs)
  assert.deepEqual(config.headers, {})
  assert.equal(config.taskType, '')
  assert.equal(config.cacheMode, '')
})

test('a hostile value never throws', () => {
  const hostile = {
    get baseURL() {
      throw new Error('boom')
    },
  }
  assert.doesNotThrow(() => normalizeConfig(hostile))
  assert.doesNotThrow(() => normalizeConfig('string'))
  assert.doesNotThrow(() => normalizeConfig(42))
  assert.doesNotThrow(() => normalizeConfig([]))
  assert.doesNotThrow(() => normalizeConfig({ baseURL: 'not a url' }))
  assert.equal(normalizeConfig({ baseURL: 'not a url' }).baseURL, DEFAULTS.baseURL)
})

test('volatile references are read through get()', () => {
  const config = normalizeConfig({
    baseURL: { get: () => 'http://127.0.0.1:9999/v1' },
    logRoutedVia: { get: () => false },
    headers: { get: () => ({ 'x-extra': 'yes' }) },
  })
  assert.equal(config.baseURL, 'http://127.0.0.1:9999/v1')
  assert.equal(config.logRoutedVia, false)
  assert.deepEqual(config.headers, { 'x-extra': 'yes' })
})

test('a throwing volatile getter degrades to the default', () => {
  const config = normalizeConfig({
    baseURL: { get: () => { throw new Error('gone') } },
  })
  assert.equal(config.baseURL, DEFAULTS.baseURL)
})

test('trailing slashes are trimmed and reserved headers are rejected', () => {
  const config = normalizeConfig({
    baseURL: 'http://localhost:3001/v1///',
    headers: {
      'X-Extra': 'yes',
      'User-Agent': 'spoofed/1.0',
      authorization: 'Bearer stolen',
      'content-type': 'text/plain',
      'bad header': 'x',
      'x-numeric': 5,
    },
  })
  assert.equal(config.baseURL, 'http://localhost:3001/v1')
  assert.deepEqual(config.headers, { 'x-extra': 'yes' })
})

test('string booleans and numbers are coerced', () => {
  const config = normalizeConfig({ logRoutedVia: 'false', contextWindow: '32000', maxTokens: '512', timeoutMs: '0' })
  assert.equal(config.logRoutedVia, false)
  assert.equal(config.contextWindow, 32_000)
  assert.equal(config.maxTokens, 512)
  assert.equal(config.timeoutMs, 0)
})

test('taskType and cacheMode accept only the documented values', () => {
  assert.equal(normalizeConfig({ taskType: 'CODE' }).taskType, 'code')
  assert.equal(normalizeConfig({ cacheMode: 'On' }).cacheMode, 'on')
  assert.equal(normalizeConfig({ taskType: 'other' }).taskType, '')
  assert.equal(normalizeConfig({ cacheMode: 'other' }).cacheMode, '')
})
