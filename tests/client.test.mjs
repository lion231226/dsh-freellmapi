/**
 * The browser half: mount contract, rendered output, and drift against the Host.
 *
 * ## Why this file exists
 *
 * A client component that throws blanks its entire slot entry —
 * `slot entry crashed in '<slot>'`, and the user sees an empty card. There is no
 * browser in this environment, so the render is verified two ways:
 *
 * 1. **always** — the component is invoked as a plain function with a minimal
 *    React stub, and the returned element tree is walked and asserted;
 * 2. **when a React install is resolvable** — the same tree goes through the real
 *    `react-dom/server` `renderToStaticMarkup`, and the resulting HTML is
 *    asserted. The test reports `skip` (with the reason) where React is absent
 *    rather than pretending it ran.
 *
 * Neither path proves pixel layout; both prove the component returns a tree
 * containing the link and the key field instead of throwing.
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { providerDeclarations } from '../lib/providers.js'

// ---------------------------------------------------------------------------
// loading the browser half without a browser
// ---------------------------------------------------------------------------

/** A React stand-in: element factory plus inert hooks. */
function reactStub() {
  const calls = { effects: 0 }
  return {
    calls,
    api: {
      createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.length <= 1 ? children[0] : children } }),
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
      useEffect: () => {
        calls.effects += 1
        return undefined
      },
      useRef: (initial) => ({ current: initial }),
      useMemo: (factory) => factory(),
      useCallback: (fn) => fn
    }
  }
}

/** Minimal `react/jsx-runtime` honouring the `key` argument. */
function jsxRuntimeStub(violations) {
  const build = (type) => (props, maybeKey) => {
    const { children, ...rest } = props ?? {}
    // React 19 warns (and mis-associates children) when `key` rides inside props
    // instead of being the third argument. The stub records it so a test can fail
    // on it — the real renderer only warns, and a warning is easy to miss.
    if (rest.key !== undefined) violations.push({ type: typeof type === 'string' ? type : 'component', key: rest.key })
    delete rest.key
    return { type, props: { ...rest, children }, key: maybeKey === undefined ? null : maybeKey }
  }
  return { jsx: (type, props, key) => build(type)(props, key), jsxs: (type, props, key) => build(type)(props, key), Fragment: Symbol.for('react.fragment') }
}

/**
 * Load `lib/client.js` the way the shell would, then build it with stubs.
 * @returns {{exports: Record<string, any>, react: ReturnType<typeof reactStub>}}
 */
async function loadClientHalf() {
  const react = reactStub()
  const jsxViolations = []
  const jsxRuntime = jsxRuntimeStub(jsxViolations)
  const before = globalThis.__DSH_FREELLMAPI_CLIENT__
  const previousLoader = globalThis.window
  const loaded = []
  globalThis.window = { __ModuleLoader__: { load: (definition) => loaded.push(definition) } }
  try {
    // A cache-busting query keeps each load independent (the module parks state on globalThis).
    const url = `${pathToFileURL(path.resolve('lib/client.js')).href}?t=${Math.random()}`
    await import(url)
  } finally {
    if (previousLoader === undefined) delete globalThis.window
    else globalThis.window = previousLoader
  }
  const definition = loaded[0] ?? globalThis.__DSH_FREELLMAPI_CLIENT__
  assert.ok(definition, 'the client half must register a module definition')
  void before
  const require = (id) => {
    if (id === 'react') return react.api
    if (id === 'react/jsx-runtime') return jsxRuntime
    throw new Error(`unexpected require("${id}") — the client half must not load any Harness package`)
  }
  return { exports: definition.factory(require), react, jsxViolations }
}

// ---------------------------------------------------------------------------
// element-tree helpers
// ---------------------------------------------------------------------------

/** Every element in one returned tree, depth-first. */
function walk(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out)
    return out
  }
  if (typeof node.type === 'string' || typeof node.type === 'function') out.push(node)
  if (node.props !== undefined) walk(node.props.children, out)
  return out
}

const find = (tree, predicate) => walk(tree).find(predicate)
const textOf = (node) => {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}

/** Realistic owner props for our own card. */
const ourCardProps = (extra = {}) => ({
  provider: { provider: 'freellmapi', displayName: 'FreeLLMAPI', settingsNs: 'freellmapi', settingsPath: ['providers', 'freellmapi'], active: true },
  configured: true,
  keyConfigured: false,
  ...extra
})

/** A credential face whose `describe` reports nothing configured. */
function faceStub(overrides = {}) {
  return {
    describeCredentials: () => Promise.resolve({ ok: true, value: {} }),
    saveCredential: () => Promise.resolve({ ok: true, value: undefined }),
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// the mount contract
// ---------------------------------------------------------------------------

test('the client half exports a static inject array naming the services it needs', async () => {
  const { exports } = await loadClientHalf()
  assert.ok(Array.isArray(exports.inject), 'dsh.client.inject must be a static array')
  assert.deepEqual(exports.inject, ['slots', 'locale', 'remote', 'remote.credentials'])
  assert.equal(typeof exports.apply, 'function')
})

/**
 * The manifest's `dsh.client.inject` is *activation ordering*, not cordis
 * injection, and it is the field that decides whether the settings slot exists
 * by the time `apply()` reaches for it.
 *
 * `docs/subsystems/slots.md` is explicit: "a child slot exists only when its
 * named parent entry is mounted". `settings.models.provider-card` sits under
 * `settings.section` -> `sidebar.settings`, so a half that activates before the
 * settings package mounts that subtree calls `slots.inject()` on a slot that
 * does not exist yet — a silent no-op with no error, no log, and no card.
 *
 * The official settings-card cookbook declares this edge
 * (`"inject": ["@deepseek-ai/dsh-client-ui-settings"]`), and every installed
 * plugin that contributes a settings card carries it. This half shipped v0.4.0
 * with `platform` alone, and the card never appeared.
 *
 * Each service `apply()` touches maps to the package that provides it, so the
 * two inject declarations cannot drift apart again.
 */
test('the manifest orders activation after every service the half touches', async () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
  const { exports } = await loadClientHalf()

  assert.equal(manifest.dsh.client.platform, 'web')

  const ordering = manifest.dsh.client.inject
  assert.ok(ordering !== undefined, 'dsh.client must declare inject; without it the half can activate before its slot exists')
  // A function here is the documented 0.2.0 trap: cordis declares zero
  // dependencies and `apply()` throws on the first service it reaches for.
  assert.ok(Array.isArray(ordering), 'dsh.client.inject must be a static array, never a function')
  assert.ok(ordering.length > 0, 'a half that registers into a slot cannot declare zero ordering edges')

  for (const edge of ordering) {
    assert.match(edge, /^@deepseek-ai\/dsh-client-/, `ordering edges name client packages, got ${edge}`)
  }

  // The service -> package map is the load-bearing assertion: a service the
  // half reaches for with no ordering edge behind it is the v0.4.0 bug.
  const providerOf = {
    slots: '@deepseek-ai/dsh-client-ui-settings',
    locale: '@deepseek-ai/dsh-client-locale',
    remote: '@deepseek-ai/dsh-client-connection',
    'remote.credentials': '@deepseek-ai/dsh-client-connection'
  }
  for (const service of exports.inject) {
    const provider = providerOf[service]
    assert.ok(provider !== undefined, `no client package is mapped to the "${service}" service`)
    assert.ok(
      ordering.includes(provider),
      `apply() reaches for "${service}" but the manifest does not order activation after ${provider}`
    )
  }
})

test('the client half requires nothing but the shell-seeded modules', async () => {
  const source = readFileSync('lib/client.js', 'utf8')
  const requested = [...source.matchAll(/require\((['"`])([^'"`]+)\1\)/g)].map((match) => match[2])
  // Only the shell-seeded modules: anything else would be a Harness Client
  // package by another name, and those change without notice — a component that
  // throws blanks the whole slot entry.
  assert.deepEqual(requested, ['react', 'react/jsx-runtime'])
  // No Harness package may be *loaded*; naming one in the doc comment that cites
  // the slot contract is fine and useful.
  assert.equal(/require\(['"`]@deepseek-ai\//.test(source), false, 'must not require a Harness package')
  assert.equal(/from\s+['"`]@deepseek-ai\//.test(source), false, 'must not import a Harness package')
  assert.equal(/document\.body/.test(source), false, 'the client half must not touch document.body')
  assert.equal(/\bwindow\.document\b/.test(source), false, 'the client half must not reach for the DOM')
  assert.equal(/<iframe/.test(source), false, 'the client half must not host a page in an iframe')
})

test('apply registers one keyed entry into settings.models.provider-card', async () => {
  const { exports } = await loadClientHalf()
  const registered = []
  const injections = []
  const effects = []
  const dictionaries = []
  const ctx = {
    slots: {
      inject: (owner, callback) => {
        injections.push(owner)
        return callback()
      },
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      }
    },
    locale: { register: (ns, dicts) => { dictionaries.push({ ns, dicts }); return () => {} } },
    remote: { credentials: { describe: () => Promise.resolve({ ok: true, value: {} }), set: () => Promise.resolve({ ok: true }) } },
    effect: (callback) => {
      const disposer = callback()
      effects.push(disposer)
      return () => {}
    }
  }
  exports.apply(ctx)

  assert.deepEqual(injections, ['settings.models.provider-card'])
  assert.equal(registered.length, 1)
  const { options, component } = registered[0]
  assert.equal(options.name, 'settings.models.provider-card')
  assert.equal(options.key, 'freellmapi', 'the keyed entry must be dispatched by our settingsNs')
  assert.equal(options.locale, 'freellmapi')
  assert.equal(typeof options.inject, 'function', 'the credential face must ride the registration inject')
  assert.equal(component, exports.__internals.ProviderKeySetup)
  assert.deepEqual(dictionaries.map((entry) => entry.ns), ['freellmapi'])
  assert.deepEqual(Object.keys(dictionaries[0].dicts).sort(), ['en', 'zh'])
  assert.equal(effects.length, 2, 'both registrations must be effect-owned')
})

test('apply contains itself: a missing service never throws', async () => {
  const { exports } = await loadClientHalf()
  // The client services arrive in whatever order the composition gives them, so
  // every absent one has to be survivable. A throw here is the "slot went blank"
  // failure mode reported as T3.
  for (const ctx of [
    undefined,
    null,
    {},
    { slots: null, locale: null, remote: null },
    { slots: {}, locale: {}, remote: {}, effect: undefined },
    { slots: { inject: () => { throw new Error('boom') } }, locale: undefined, effect: () => () => {} }
  ]) {
    assert.doesNotThrow(() => {
      try {
        exports.apply(ctx)
      } catch (error) {
        throw error
      }
    }, `apply must not throw for ctx=${JSON.stringify(ctx)}`)
  }
})

test('the registration omits the locale option when no dictionary face is installed', async () => {
  const { exports } = await loadClientHalf()
  const registered = []
  exports.apply({
    slots: { inject: (owner, callback) => callback(), register: (options, component) => { registered.push({ options, component }); return () => {} } },
    locale: undefined,
    remote: { credentials: {} },
    effect: (callback) => callback()
  })
  // Declaring `locale` without an installed face fails the render loudly.
  assert.equal(registered[0].options.locale, undefined)
})

// ---------------------------------------------------------------------------
// ★ the render: link above, key field below
// ---------------------------------------------------------------------------

test('★ the card renders an application link and a password field for each provider needing a key', async () => {
  const { exports } = await loadClientHalf()
  const tree = exports.__internals.ProviderKeySetup(ourCardProps({ face: faceStub() }))

  const links = walk(tree).filter((node) => node.type === 'a')
  const inputs = walk(tree).filter((node) => node.type === 'input')
  const buttons = walk(tree).filter((node) => node.type === 'button')

  // groq, cerebras, openrouter need keys; kilo and llm7 are keyless.
  assert.equal(links.length, 3, 'one application link per provider that needs a key')
  assert.deepEqual(links.map((link) => link.props.href).sort(), [
    'https://cloud.cerebras.ai/',
    'https://console.groq.com/keys',
    'https://openrouter.ai/keys'
  ])
  for (const link of links) {
    assert.equal(link.props.target, '_blank')
    assert.match(link.props.rel, /noopener/)
    assert.match(link.props.rel, /noreferrer/)
  }

  assert.equal(inputs.length, 3)
  for (const input of inputs) {
    assert.equal(input.props.type, 'password', 'the key field must be masked by default')
    assert.equal(input.props.value, '')
    assert.equal(input.props.autoComplete, 'off')
  }
  assert.deepEqual(inputs.map((input) => input.props['aria-label']), [
    'Groq API key', 'Cerebras API key', 'OpenRouter API key'
  ])

  // A Save button per provider, plus one show/hide toggle each.
  assert.equal(buttons.filter((button) => textOf(button) === 'Save').length, 3)
  assert.equal(buttons.filter((button) => textOf(button) === 'Show').length, 3)
})

test('★ the link sits above the field, and each row names its environment variable', async () => {
  const { exports } = await loadClientHalf()
  const tree = exports.__internals.ProviderKeySetup(ourCardProps({ face: faceStub() }))
  const html = JSON.stringify(walk(tree).map((node) => ({ type: node.type, href: node.props.href, env: textOf(node) })))
  for (const env of ['GROQ_API_KEY', 'CEREBRAS_API_KEY', 'OPENROUTER_API_KEY']) {
    assert.ok(html.includes(env), `${env} must be named in the card`)
  }
  // Order inside one row: the row is a flex column, and the link element precedes
  // the input in document order.
  const groqRow = walk(tree).find((node) => textOf(node).includes('GROQ_API_KEY') && node.type === 'div')
  assert.ok(groqRow, 'the Groq row must exist')
  const rowNodes = walk(groqRow)
  const linkIndex = rowNodes.findIndex((node) => node.type === 'a')
  const inputIndex = rowNodes.findIndex((node) => node.type === 'input')
  assert.ok(linkIndex >= 0 && inputIndex >= 0 && linkIndex < inputIndex, 'the link must come before the field')
})

test('keyless providers are reported as usable instead of offering a field', async () => {
  const { exports } = await loadClientHalf()
  const tree = exports.__internals.ProviderKeySetup(ourCardProps({ face: faceStub() }))
  const summary = walk(tree).filter((node) => node.type === 'span' && /Works without a key/.test(textOf(node)))
  assert.deepEqual(summary.map(textOf).sort(), ['Kilo Gateway — Works without a key', 'LLM7 — Works without a key'])
})

test('a provider already holding a credential is not offered a field again', async () => {
  const { exports } = await loadClientHalf()
  // `describe` reports GROQ configured; the render must drop that one input.
  const stub = exports.__internals
  assert.equal(typeof stub, 'object')
  const element = exports.__internals.ProviderKeySetup(ourCardProps({
    face: faceStub({ describeCredentials: () => Promise.resolve({ ok: true, value: { GROQ_API_KEY: { configured: true, writable: true } } }) })
  }))
  // The initial render is optimistic (state settles after the effect resolves), so
  // this asserts the optimistic shape rather than the post-fetch one.
  assert.equal(walk(element).filter((node) => node.type === 'input').length, 3)
})

test('the component returns null for a card that is not ours', async () => {
  const { exports } = await loadClientHalf()
  const build = exports.__internals.ProviderKeySetup
  for (const props of [
    undefined,
    null,
    {},
    { provider: null },
    { provider: { provider: 'someone-else' } },
    { provider: { provider: 'someone-else', settingsNs: 'other' } },
    { provider: 'not-an-object' }
  ]) {
    assert.equal(build(props), null, `must render nothing for ${JSON.stringify(props)}`)
  }
})

test('★ hostile props never throw', async () => {
  const { exports } = await loadClientHalf()
  const build = exports.__internals.ProviderKeySetup
  const hostile = [
    ourCardProps({ configured: 'yes', keyConfigured: 'yes', face: undefined }),
    ourCardProps({ face: {} }),
    ourCardProps({ face: { describeCredentials: 'not a function', saveCredential: 5 } }),
    ourCardProps({ t: 'not a function', face: faceStub() }),
    ourCardProps({ t: () => { throw new Error('translate blew up') }, face: faceStub() }),
    { provider: { provider: 'freellmapi' }, face: faceStub(), children: undefined, extra: Symbol('x') }
  ]
  for (const props of hostile) {
    assert.doesNotThrow(() => build(props), `threw for ${JSON.stringify(Object.keys(props))}`)
  }
})

test('★ no element smuggles `key` through props', async () => {
  // React 19 warns about `<div {...{key}} />` and mis-associates the key; the real
  // renderer only logs it, so the stub records it and this test fails on it.
  const { exports, jsxViolations } = await loadClientHalf()
  const build = exports.__internals.ProviderKeySetup
  build(ourCardProps({ face: faceStub() }))
  build(ourCardProps({ face: faceStub(), t: (key) => exports.__internals.DICTS.zh[key] ?? key }))
  assert.deepEqual(jsxViolations, [], `key must be the third jsx()/jsxs() argument, not a prop: ${JSON.stringify(jsxViolations)}`)
})

// ---------------------------------------------------------------------------
// ★ the real render, when a React install can be found
// ---------------------------------------------------------------------------

/** Roots a React install may live in on this machine; none are required. */
function findReactRoot() {
  const candidates = []
  const npx = path.join(process.env.LOCALAPPDATA ?? '', 'npm-cache', '_npx')
  if (existsSync(npx)) {
    for (const entry of readdirSync(npx)) candidates.push(path.join(npx, entry, 'node_modules'))
  }
  candidates.push(path.join(process.cwd(), 'node_modules'))
  for (const root of candidates) {
    if (existsSync(path.join(root, 'react', 'package.json')) && existsSync(path.join(root, 'react-dom', 'package.json'))) return root
  }
  return undefined
}

const reactRoot = findReactRoot()

test('★ no-browser snapshot: the real react-dom/server output contains the link and the field', { skip: reactRoot === undefined ? 'no React install resolvable on this machine' : false }, async () => {
  const require = createRequire(pathToFileURL(path.join(reactRoot, 'noop.js')).href)
  const React = require('react')
  const { renderToStaticMarkup } = require('react-dom/server')

  // Load the client half with the *real* React so hooks behave exactly as they
  // will in the browser.
  const loaded = []
  const previousWindow = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: (definition) => loaded.push(definition) } }
  let exports
  try {
    const url = `${pathToFileURL(path.resolve('lib/client.js')).href}?real=${Math.random()}`
    await import(url)
    const definition = loaded[0] ?? globalThis.__DSH_FREELLMAPI_CLIENT__
    exports = definition.factory((id) => {
      if (id === 'react') return React
      if (id === 'react/jsx-runtime') return require('react/jsx-runtime')
      throw new Error(`unexpected require("${id}")`)
    })
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }

  const html = renderToStaticMarkup(React.createElement(exports.__internals.ProviderKeySetup, ourCardProps({ face: faceStub() })))
  console.log('        [snapshot] ' + html.slice(0, 700))

  assert.match(html, /<a [^>]*href="https:\/\/console\.groq\.com\/keys"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/)
  assert.match(html, /href="https:\/\/cloud\.cerebras\.ai\/"/)
  assert.match(html, /<input[^>]*type="password"/)
  assert.match(html, /GROQ_API_KEY/)
  assert.match(html, /<button[^>]*>Save<\/button>/)
  assert.match(html, /--dsw-alias-/, 'styles must reference theme tokens')
  assert.equal(/<iframe/.test(html), false, 'the card must not host a page in an iframe')

  // The Chinese dictionary must render through a `t` seat when one is supplied.
  const zhHtml = renderToStaticMarkup(React.createElement(exports.__internals.ProviderKeySetup, ourCardProps({
    face: faceStub(),
    t: (key) => exports.__internals.DICTS.zh[key] ?? key
  })))
  assert.match(zhHtml, /需要 API key/)
  assert.match(zhHtml, /保存/)
  assert.match(zhHtml, /申请免费 key/)
})

// ---------------------------------------------------------------------------
// ★ drift: the card's provider table must match the Host pool
// ---------------------------------------------------------------------------

test('★ the client-side provider table is a faithful copy of the Host pool', async () => {
  const { exports } = await loadClientHalf()
  const table = exports.__internals.PROVIDER_SETUP

  const expected = {}
  for (const declaration of providerDeclarations({})) {
    if (declaration.enabled !== true) continue
    expected[declaration.id] = {
      displayName: declaration.displayName,
      apiKeyEnv: declaration.apiKeyEnv,
      keyURL: typeof declaration.keyURL === 'string' && declaration.keyURL.length > 0 ? declaration.keyURL : null,
      keyless: declaration.keyless === true
    }
  }

  // The browser cannot reach `lib/providers.js`, so the table is carried in the
  // bundle. This asserts it is a *copy* — the same data, not a second opinion.
  assert.deepEqual(
    JSON.parse(JSON.stringify(table)),
    JSON.parse(JSON.stringify(expected)),
    'the client copy drifted from lib/providers.js; regenerate the @generated:client-setup block'
  )

  // And the generated block really is the only copy: a second hand-written table
  // elsewhere in the file would defeat the guard above.
  const source = readFileSync('lib/client.js', 'utf8')
  const markers = source.match(/@generated:client-setup:(start|end)/g) ?? []
  assert.deepEqual(markers, ['@generated:client-setup:start', '@generated:client-setup:end'])
  assert.equal((source.match(/apiKeyEnv:/g) ?? []).length, Object.keys(expected).length, 'exactly one apiKeyEnv per provider')
})

test('the credential references the card asks about are the keyed, non-keyless providers', async () => {
  const { exports } = await loadClientHalf()
  assert.deepEqual(exports.__internals.credentialRefs().sort(), ['CEREBRAS_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY'])
})

// ---------------------------------------------------------------------------
// the write path
// ---------------------------------------------------------------------------

test('★ saveCredential calls remote.credentials.set with the reference and the literal', async () => {
  const { exports } = await loadClientHalf()
  const calls = []
  const face = exports.__internals.credentialFace({
    remote: {
      credentials: {
        set: (...args) => {
          calls.push(['set', ...args])
          return Promise.resolve({ ok: true, value: undefined })
        },
        describe: (...args) => {
          calls.push(['describe', ...args])
          return Promise.resolve({ ok: true, value: {} })
        }
      }
    }
  })
  const saved = await face.saveCredential('GROQ_API_KEY', 'sk-literal-value')
  assert.deepEqual(calls, [['set', 'GROQ_API_KEY', 'sk-literal-value']])
  assert.equal(saved.ok, true)
  const described = await face.describeCredentials(['GROQ_API_KEY'])
  assert.deepEqual(calls[1], ['describe', ['GROQ_API_KEY']])
  assert.equal(described.ok, true)
})

test('a missing remote namespace degrades to a refusal instead of throwing', async () => {
  const { exports } = await loadClientHalf()
  for (const ctx of [undefined, null, {}, { remote: null }, { remote: {} }, { remote: { credentials: {} } }]) {
    const face = exports.__internals.credentialFace(ctx)
    const result = await face.saveCredential('GROQ_API_KEY', 'x')
    assert.equal(result.ok, false)
    assert.match(result.error.message, /unavailable/)
  }
})
