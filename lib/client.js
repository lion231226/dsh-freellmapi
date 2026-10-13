/**
 * dsh-freellmapi — browser half.
 *
 * Adds an "add your API key" area to this plugin's own provider card in
 * **Settings → Models**. For every pool provider that is enabled but has no
 * credential, the card shows the key-application link first and an API-key field
 * with a Save button underneath; saving writes through the Host's credential seam,
 * which re-resolves once per model request and never caches — so a saved key
 * reaches the very next request with no restart.
 *
 * ## Contract sources (all read, none guessed)
 *
 * - Seat: `settings.models.provider-card`, `kind: 'keyed'`, `scope: 'root'`,
 *   dispatched with `entryKey = ProviderDirectoryEntry.settingsNs`
 *   (`@deepseek-ai/dsh-client-ui-settings-models/lib/types/client/slot-contract.d.ts`).
 *   Owner props: `{ provider, configured, keyConfigured }`.
 * - Credential write: `ctx.remote.credentials.set(ref, value)` and
 *   `.describe(refs)` — the `@Remote` namespace of `CredentialsController`
 *   (`docs/subsystems/credentials.md` §Cordis API), consumed exactly as the
 *   shipped page does it (`…/dsh-client-ui-settings-models/lib/client.js:2784`).
 * - Registration shape: `{ name, key, locale }` + `ctx.slots.inject(owner, () =>
 *   ctx.slots.register(...))` inside `ctx.effect` (`docs/subsystems/slots.md`).
 * - Styling: only `--dsw-*` theme tokens, values mirrored from the shipped
 *   `ui-primitives` stylesheets; no colour literals outside artwork.
 *
 * ## Format
 *
 * The lazy-CJS factory the client module system serves from `exports["./client"]`
 * (see `docs/subsystems/client-modules.md` §The scan). No build step, no npm
 * dependencies: the only modules requested are the shell-seeded `react` and
 * `react/jsx-runtime`, which the browser module table already provides.
 *
 * ## Failure posture
 *
 * A throwing component blanks its whole slot entry, so every mount step is
 * guarded, every prop read is optional, and the component contains no `throw` and
 * no unsupported hook usage. When anything is missing it renders nothing — never
 * an exception.
 */

/* @generated:client-setup:start — regenerated from lib/providers.js; a test asserts equality */
/** Pool providers this card can offer a key field for, keyed by provider id. */
const PROVIDER_SETUP = Object.freeze({
  groq: Object.freeze({ displayName: 'Groq', apiKeyEnv: 'GROQ_API_KEY', keyURL: 'https://console.groq.com/keys', keyless: false }),
  cerebras: Object.freeze({ displayName: 'Cerebras', apiKeyEnv: 'CEREBRAS_API_KEY', keyURL: 'https://cloud.cerebras.ai/', keyless: false }),
  openrouter: Object.freeze({ displayName: 'OpenRouter', apiKeyEnv: 'OPENROUTER_API_KEY', keyURL: 'https://openrouter.ai/keys', keyless: false }),
  llm7: Object.freeze({ displayName: 'LLM7', apiKeyEnv: 'LLM7_API_KEY', keyURL: 'https://token.llm7.io/', keyless: true }),
  kilo: Object.freeze({ displayName: 'Kilo Gateway', apiKeyEnv: 'KILO_API_KEY', keyURL: null, keyless: true })
})
/* @generated:client-setup:end */

;(function mountClientHalf() {
  const definition = {
    id: 'dsh-freellmapi',
    factory: (require) => {
      const module = { exports: {} }
      const exports = module.exports
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

      const react = require('react')
      const jsxRuntime = require('react/jsx-runtime')
      const jsx = jsxRuntime.jsx
      const jsxs = jsxRuntime.jsxs

      /** Dictionary namespace owned by this plugin; also the keyed slot entry key. */
      const NS = 'freellmapi'
      /** The provider-card extension seat (keyed by `settingsNs`). */
      const SLOT = 'settings.models.provider-card'

      const en = {
        needsKey: 'Needs an API key',
        getKey: 'Get a free key',
        keyLabel: 'API key',
        placeholder: 'Paste the key',
        show: 'Show',
        hide: 'Hide',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved — the next request uses it, no restart needed',
        empty: 'Enter the key first',
        loadFailed: 'Could not read credential state',
        ready: 'Ready to use',
        noKeyNeeded: 'Works without a key',
        configured: 'Configured',
        envHint: 'Stored as {env}'
      }
      const zh = {
        needsKey: '需要 API key',
        getKey: '申请免费 key',
        keyLabel: 'API key',
        placeholder: '粘贴 key',
        show: '显示',
        hide: '隐藏',
        save: '保存',
        saving: '保存中…',
        saved: '已保存 — 下次请求即生效，无需重启',
        empty: '请先填入 key',
        loadFailed: '读取凭据状态失败',
        ready: '可直接使用',
        noKeyNeeded: '无需 key',
        configured: '已配置',
        envHint: '保存为 {env}'
      }
      /** Dictionaries by BCP 47 tag, registered through `ctx.locale.register`. */
      const DICTS = { en, zh }

      // ------------------------------------------------------------- styling

      /**
       * Styles are inline objects built from `--dsw-*` tokens only, so the card
       * inherits light/dark, density, and future token renames without a
       * stylesheet of its own (and without writing anything outside the tree).
       */
      const S = {
        wrap: { display: 'flex', flexDirection: 'column', gap: '10px', paddingTop: '12px' },
        row: {
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          padding: '12px',
          borderRadius: 'var(--dsw-radius-lg)',
          border: '0.5px solid var(--dsw-alias-border-l3)',
          background: 'var(--dsw-alias-bg-layer-3)'
        },
        head: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
        name: { fontSize: '13px', fontWeight: '500', lineHeight: '1.5', color: 'var(--dsw-alias-label-primary)' },
        badge: { fontSize: '12px', lineHeight: '1.5', color: 'var(--dsw-alias-label-tertiary)' },
        link: { fontSize: '12px', lineHeight: '1.5', color: 'var(--dsw-alias-state-business-primary)' },
        env: { fontSize: '12px', lineHeight: '1.5', color: 'var(--dsw-alias-label-tertiary)' },
        field: { display: 'flex', alignItems: 'center', gap: '8px' },
        input: {
          flex: '1 1 auto',
          minWidth: '0',
          height: '34px',
          padding: '0 12px',
          border: '0.5px solid var(--dsw-alias-border-l4)',
          borderRadius: 'var(--dsw-radius-md)',
          background: 'var(--dsw-alias-bg-layer-2)',
          font: 'inherit',
          fontSize: '13px',
          lineHeight: '1.5',
          color: 'var(--dsw-alias-label-primary)'
        },
        button: {
          flex: 'none',
          height: '28px',
          padding: '0 10px',
          border: 'none',
          borderRadius: 'var(--dsw-radius-sm)',
          cursor: 'pointer',
          font: 'inherit',
          fontSize: '12px',
          lineHeight: '18px',
          background: 'var(--dsw-alias-button-primary-fill)',
          color: 'var(--dsw-alias-label-primary-foreground)'
        },
        toggle: {
          flex: 'none',
          height: '28px',
          padding: '0 10px',
          border: '0.5px solid var(--dsw-alias-border-l3)',
          borderRadius: 'var(--dsw-radius-sm)',
          background: 'transparent',
          cursor: 'pointer',
          font: 'inherit',
          fontSize: '12px',
          lineHeight: '18px',
          color: 'var(--dsw-alias-label-secondary)'
        },
        ok: { fontSize: '12px', lineHeight: '1.5', color: 'var(--dsw-alias-state-success-primary)' },
        error: { fontSize: '12px', lineHeight: '1.5', color: 'var(--dsw-alias-state-error-primary)' },
        summary: { display: 'flex', flexWrap: 'wrap', gap: '6px 14px' }
      }

      // ------------------------------------------------------------- helpers

      /**
       * The entry's translate seat, with an English fallback.
       *
       * The `locale` registration option is only declared once the dictionary
       * face is actually installed, so this must work both ways; a missing face
       * degrades to the English literals above instead of failing the render.
       */
      function translator(props) {
        const t = props === null || props === undefined ? undefined : props.t
        return (key, fallbackText) => {
          if (typeof t !== 'function') return fallbackText
          try {
            const text = t(key)
            return typeof text === 'string' && text.length > 0 && text !== key ? text : fallbackText
          } catch {
            return fallbackText
          }
        }
      }

      /** `apiKeyEnv` names for every pool provider this card can configure. */
      function credentialRefs() {
        const refs = []
        for (const id of Object.keys(PROVIDER_SETUP)) {
          const entry = PROVIDER_SETUP[id]
          if (entry.keyless !== true && typeof entry.apiKeyEnv === 'string' && entry.apiKeyEnv.length > 0) refs.push(entry.apiKeyEnv)
        }
        return refs
      }

      /**
       * Whether this card belongs to our route. The slot dispatches every card
       * whose `settingsNs` matches the registered key, but the owner share still
       * arrives with the row, so it is checked rather than assumed.
       */
      function isOurCard(props) {
        const row = props === null || props === undefined ? undefined : props.provider
        if (row === null || row === undefined || typeof row !== 'object') return false
        if (row.provider === NS) return true
        return row.settingsNs === NS
      }

      // ----------------------------------------------------------- component

      /**
       * The card extension: one key field per enabled provider that needs one.
       *
       * @param props - owner share `{ provider, configured, keyConfigured }`, the
       *   injected `{ describeCredentials, saveCredential }` face, and the
       *   synthesized `t` seat when the locale face is installed.
       */
      function ProviderKeySetup(props) {
        const tr = translator(props)
        const face = props === null || props === undefined ? undefined : props.face
        const [state, setState] = react.useState({ phase: 'loading', configured: {}, failed: false })
        const [drafts, setDrafts] = react.useState({})
        const [revealed, setRevealed] = react.useState({})
        const [saving, setSaving] = react.useState({})
        const [feedback, setFeedback] = react.useState({})

        const describe = face === null || face === undefined ? undefined : face.describeCredentials
        const save = face === null || face === undefined ? undefined : face.saveCredential

        react.useEffect(() => {
          if (typeof describe !== 'function') {
            setState({ phase: 'ready', configured: {}, failed: true })
            return undefined
          }
          let cancelled = false
          describe(credentialRefs())
            .then((result) => {
              if (cancelled) return
              if (result !== null && result !== undefined && result.ok === true) {
                const configured = {}
                for (const ref of Object.keys(result.value ?? {})) {
                  configured[ref] = result.value[ref] !== null && result.value[ref] !== undefined && result.value[ref].configured === true
                }
                setState({ phase: 'ready', configured, failed: false })
              } else {
                setState({ phase: 'ready', configured: {}, failed: true })
              }
            })
            .catch(() => {
              if (!cancelled) setState({ phase: 'ready', configured: {}, failed: true })
            })
          return () => {
            cancelled = true
          }
        }, [describe])

        if (!isOurCard(props)) return null

        const ids = Object.keys(PROVIDER_SETUP)
        const needsKey = ids.filter((id) => PROVIDER_SETUP[id].keyless !== true)
        const ready = ids.filter((id) => PROVIDER_SETUP[id].keyless === true || state.configured[PROVIDER_SETUP[id].apiKeyEnv] === true)

        /** Persist one draft, then re-read so the row settles on the Host's answer. */
        const submit = (entry) => (event) => {
          if (event !== null && event !== undefined && typeof event.preventDefault === 'function') event.preventDefault()
          const value = typeof drafts[entry.apiKeyEnv] === 'string' ? drafts[entry.apiKeyEnv] : ''
          if (value.trim().length === 0) {
            setFeedback((current) => ({ ...current, [entry.apiKeyEnv]: { kind: 'error', text: tr('empty', en.empty) } }))
            return
          }
          if (typeof save !== 'function') {
            setFeedback((current) => ({ ...current, [entry.apiKeyEnv]: { kind: 'error', text: tr('loadFailed', en.loadFailed) } }))
            return
          }
          setSaving((current) => ({ ...current, [entry.apiKeyEnv]: true }))
          save(entry.apiKeyEnv, value)
            .then((result) => {
              const ok = result !== null && result !== undefined && result.ok === true
              setSaving((current) => ({ ...current, [entry.apiKeyEnv]: false }))
              setFeedback((current) => ({
                ...current,
                [entry.apiKeyEnv]: ok
                  ? { kind: 'ok', text: tr('saved', en.saved) }
                  : { kind: 'error', text: messageOf(result, tr('loadFailed', en.loadFailed)) }
              }))
              if (!ok) return
              setDrafts((current) => ({ ...current, [entry.apiKeyEnv]: '' }))
              if (typeof describe === 'function') {
                describe([entry.apiKeyEnv])
                  .then((again) => {
                    if (again !== null && again !== undefined && again.ok === true) {
                      setState((current) => ({ ...current, configured: { ...current.configured, [entry.apiKeyEnv]: true } }))
                    }
                  })
                  .catch(() => {})
              }
            })
            .catch((error) => {
              setSaving((current) => ({ ...current, [entry.apiKeyEnv]: false }))
              setFeedback((current) => ({
                ...current,
                [entry.apiKeyEnv]: { kind: 'error', text: errorText(error, tr('loadFailed', en.loadFailed)) }
              }))
            })
        }

        return jsxs('div', {
          style: S.wrap,
          children: [
            state.failed
              ? jsx('p', { style: S.error, children: tr('loadFailed', en.loadFailed) })
              : null,
            ...needsKey.map((id) => renderRow(id, PROVIDER_SETUP[id], {
              tr, drafts, revealed, saving, feedback, setDrafts, setRevealed, submit,
            })),
            ready.length === 0
              ? null
              : jsx('div', {
                style: S.summary,
                children: ready.map((id) => {
                  const entry = PROVIDER_SETUP[id]
                  const label = `${entry.displayName} — ${entry.keyless === true ? tr('noKeyNeeded', en.noKeyNeeded) : tr('configured', en.configured)}`
                  return jsx('span', { style: S.badge, children: label }, id)
                })
              })
          ]
        })
      }

      /** The Host's refusal message when the Remote call failed, else a fallback. */
      function messageOf(result, fallbackText) {
        const error = result === null || result === undefined ? undefined : result.error
        const message = error === null || error === undefined ? undefined : error.message
        return typeof message === 'string' && message.length > 0 ? message : fallbackText
      }

      function errorText(error, fallbackText) {
        if (error === null || error === undefined) return fallbackText
        const message = error.message
        return typeof message === 'string' && message.length > 0 ? message : fallbackText
      }

      /**
       * One provider's line: application link, environment-variable name, key
       * field with a show/hide toggle, and Save.
       */
      function renderRow(id, entry, ctxBits) {
        const { tr, drafts, revealed, saving, feedback, setDrafts, setRevealed, submit } = ctxBits
        const ref = entry.apiKeyEnv
        const draft = typeof drafts[ref] === 'string' ? drafts[ref] : ''
        const note = feedback[ref]
        const host = hostOf(entry.keyURL)

        return jsxs('div', {
          style: S.row,
          children: [
            jsxs('div', {
              style: S.head,
              children: [
                jsx('span', { style: S.name, children: entry.displayName }),
                jsx('span', { style: S.badge, children: tr('needsKey', en.needsKey) }),
                host === null
                  ? jsx('span', { style: S.env, children: tr('getKey', en.getKey) })
                  : jsx('a', {
                    style: S.link,
                    href: entry.keyURL,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    children: `${tr('getKey', en.getKey)} ↗ ${host}`
                  })
              ]
            }),
            jsx('span', {
              style: S.env,
              children: tr('envHint', en.envHint).replace('{env}', ref)
            }),
            jsxs('div', {
              style: S.field,
              children: [
                jsx('input', {
                  style: S.input,
                  type: revealed[ref] === true ? 'text' : 'password',
                  value: draft,
                  autoComplete: 'off',
                  spellCheck: false,
                  'aria-label': `${entry.displayName} ${tr('keyLabel', en.keyLabel)}`,
                  placeholder: tr('placeholder', en.placeholder),
                  onChange: (event) => {
                    const value = event !== null && event !== undefined && event.target !== null && event.target !== undefined
                      ? event.target.value
                      : ''
                    setDrafts((current) => ({ ...current, [ref]: typeof value === 'string' ? value : '' }))
                  }
                }),
                jsx('button', {
                  type: 'button',
                  style: S.toggle,
                  onClick: () => setRevealed((current) => ({ ...current, [ref]: current[ref] !== true })),
                  children: revealed[ref] === true ? tr('hide', en.hide) : tr('show', en.show)
                }),
                jsx('button', {
                  type: 'button',
                  style: S.button,
                  disabled: saving[ref] === true,
                  onClick: submit(entry),
                  children: saving[ref] === true ? tr('saving', en.saving) : tr('save', en.save)
                })
              ]
            }),
            note === undefined || note === null
              ? null
              : jsx('p', { style: note.kind === 'ok' ? S.ok : S.error, children: note.text })
          ]
        }, id)
      }

      /** The host part of an application URL, or null when there is nothing to link to. */
      function hostOf(keyURL) {
        if (typeof keyURL !== 'string' || keyURL.length === 0) return null
        const stripped = keyURL.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
        return stripped.length > 0 ? stripped : null
      }

      // -------------------------------------------------------------- plugin

      /**
       * Client services this half consumes. Static array, as the manifest rule
       * requires. `remote.credentials` is the namespace that carries
       * `describe`/`set` for the credential seam; without it the card would have
       * nothing to write to, so the plugin stays inactive rather than rendering
       * a field that cannot save.
       */
      const inject = ['slots', 'locale', 'remote', 'remote.credentials']

      /** Run one mount step; a failure is logged, never thrown. */
      function guard(label, run) {
        try {
          return run()
        } catch (error) {
          console.warn(`[${NS}] ${label} failed:`, error)
          return undefined
        }
      }

      /** Build the credential face the component receives, from the plugin context. */
      function credentialFace(ctx) {
        const call = (method, args) => {
          const remote = ctx === null || ctx === undefined ? undefined : ctx.remote
          const namespace = remote === null || remote === undefined ? undefined : remote.credentials
          const fn = namespace === null || namespace === undefined ? undefined : namespace[method]
          if (typeof fn !== 'function') {
            return Promise.resolve({ ok: false, error: { message: `remote.credentials.${method} is unavailable` } })
          }
          return Promise.resolve(fn.apply(namespace, args))
        }
        return {
          describeCredentials: (refs) => call('describe', [refs]),
          saveCredential: (ref, value) => call('set', [ref, value])
        }
      }

      function apply(ctx) {
        if (ctx === null || ctx === undefined) return

        // The dictionary face must exist before the registration can declare it:
        // declaring `locale` without an installed namespace fails the render
        // loudly, and a throwing component blanks the whole slot entry.
        let localeReady = false
        guard('dictionaries', () => {
          if (ctx.locale === null || ctx.locale === undefined || typeof ctx.locale.register !== 'function') return
          ctx.effect(() => ctx.locale.register(NS, DICTS), `${NS}: dictionaries`)
          localeReady = true
        })

        guard('provider card', () => {
          const slots = ctx.slots
          if (slots === null || slots === undefined) return
          if (typeof slots.inject !== 'function' || typeof slots.register !== 'function') return
          const face = credentialFace(ctx)
          ctx.effect(
            () =>
              slots.inject(SLOT, () =>
                slots.register(
                  {
                    name: SLOT,
                    // Keyed cardinality: the cell that matches this card's settingsNs.
                    key: NS,
                    ...localeReady ? { locale: NS } : {},
                    // The registrant's business face: the component never receives
                    // `ctx`, so the Remote call is bound here and handed over.
                    inject: () => ({ face })
                  },
                  ProviderKeySetup
                )
              ),
            `${NS}: provider card`
          )
        })
      }

      exports.apply = apply
      exports.inject = inject
      /** Pure surfaces for `node:test`; nothing here needs a browser. */
      exports.__internals = { NS, SLOT, DICTS, PROVIDER_SETUP, credentialRefs, isOurCard, translator, hostOf, ProviderKeySetup, credentialFace, apply, inject }

      return module.exports
    }
  }

  // The shell's module loader registers the factory; in Node (tests, tooling) the
  // definition is simply parked so the module can be exercised without a browser.
  if (typeof window !== 'undefined' && window !== null && window.__ModuleLoader__ !== undefined && typeof window.__ModuleLoader__.load === 'function') {
    window.__ModuleLoader__.load(definition)
  }
  if (typeof globalThis !== 'undefined') globalThis.__DSH_FREELLMAPI_CLIENT__ = definition
})()
