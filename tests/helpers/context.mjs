/**
 * A minimal stand-in for the cordis context the plugin is mounted into.
 *
 * It reproduces the parts of the host contract the plugin actually calls —
 * `ctx.llm`'s registration trio (with the same validation rules the runtime
 * applies), `ctx.get(service)`, `ctx.on(event)`, `ctx.fiber.entry.options.id`
 * and `ctx.logger` — so `apply()` can be exercised end to end without a DSH
 * process. It intentionally rejects what the runtime rejects, so a test that
 * passes here is not passing because the fake was lenient.
 */

import { apply } from '../../lib/index.js'

/**
 * Mount the plugin against a fake context.
 *
 * @param {object} [options]
 * @param {unknown} [options.config] the config value handed to `apply`
 * @param {Record<string, any>} [options.services] optional services (`credentials`, `attachments`, …)
 * @param {string} [options.entryId] the loader entry id, which is the settings namespace
 * @param {boolean} [options.failAdapterRegistration] make `registerAdapter` throw `DUPLICATE_ADAPTER`
 * @returns {{
 *   adapter: any,
 *   directoryEntries: any[],
 *   discovery: ((request: any, signal?: AbortSignal) => Promise<any[]>) | undefined,
 *   settingsNs: string | undefined,
 *   logger: {info: string[], warn: string[], error: string[]},
 *   events: Map<string, Function[]>,
 *   emits(event: string, ...args: any[]): void,
 *   contexts: any[],
 * }}
 */
export function mountPlugin(options = {}) {
  const logger = { info: [], warn: [], error: [] }
  const events = new Map()
  const directoryEntries = []
  const adapters = []
  let discovery
  let settingsNs

  const ctx = {
    logger: {
      info: (...args) => logger.info.push(args.map(String).join(' ')),
      warn: (...args) => logger.warn.push(args.map(String).join(' ')),
      error: (...args) => logger.error.push(args.map(String).join(' ')),
    },
    fiber: { entry: { options: { id: options.entryId ?? 'freellmapi' } } },
    get: (name) => options.services?.[name],
    on: (event, handler) => {
      const list = events.get(event) ?? []
      list.push(handler)
      events.set(event, list)
    },
    llm: {
      registerAdapter(providers, adapter) {
        if (options.failAdapterRegistration === true) {
          throw Object.assign(new Error('an adapter for provider "freellmapi" is already registered'), { code: 'DUPLICATE_ADAPTER' })
        }
        if (!Array.isArray(providers) || providers.length === 0) {
          throw Object.assign(new Error('an adapter must register at least one provider'), { code: 'INVALID_ADAPTER' })
        }
        for (const provider of providers) {
          if (typeof provider !== 'string' || provider.length === 0) {
            throw Object.assign(new Error('adapter provider names must be non-empty'), { code: 'INVALID_ADAPTER' })
          }
          const info = adapter.providerInfo(provider)
          if (typeof info?.id !== 'string' || info.id !== provider || typeof info.name !== 'string' || info.name.length === 0) {
            throw Object.assign(new Error(`adapter metadata for provider "${provider}" must preserve its id and have a non-empty name`), { code: 'INVALID_ADAPTER' })
          }
        }
        adapters.push({ providers: [...providers], adapter })
        const handle = () => {}
        handle.replace = (next) => {
          for (const provider of next) {
            const info = adapter.providerInfo(provider)
            if (info?.id !== provider) throw Object.assign(new Error('bad replace'), { code: 'INVALID_ADAPTER' })
          }
        }
        return handle
      },
      registerConfigurableProviders(entries) {
        if (!Array.isArray(entries) || entries.length === 0) {
          throw Object.assign(new Error('a configurable-provider registration must declare at least one provider'), { code: 'INVALID_DIRECTORY' })
        }
        for (const entry of entries) {
          if (entry.provider.length === 0 || entry.displayName.length === 0 || entry.settingsNs.length === 0) {
            throw Object.assign(new Error('configurable providers need a non-empty provider, displayName, and settingsNs'), { code: 'INVALID_DIRECTORY' })
          }
          if (entry.settingsPath.some((segment) => segment.length === 0)) {
            throw Object.assign(new Error(`configurable provider "${entry.provider}" has an empty settingsPath segment`), { code: 'INVALID_DIRECTORY' })
          }
        }
        directoryEntries.length = 0
        directoryEntries.push(...entries)
        const handle = () => {}
        handle.replace = (next) => {
          directoryEntries.length = 0
          directoryEntries.push(...next)
        }
        return handle
      },
      registerModelDiscovery(namespace, discover) {
        if (typeof namespace !== 'string' || namespace.length === 0) {
          throw Object.assign(new Error('a model discovery registration needs a non-empty settings namespace'), { code: 'INVALID_DISCOVERY' })
        }
        if (discovery !== undefined) {
          throw Object.assign(new Error('a model discovery is already registered for this namespace'), { code: 'DUPLICATE_DISCOVERY' })
        }
        settingsNs = namespace
        discovery = discover
        return () => {
          discovery = undefined
        }
      },
    },
  }

  apply(ctx, options.config)

  return {
    adapter: adapters[0]?.adapter,
    adapterCount: adapters.length,
    directoryEntries,
    discovery,
    settingsNs,
    logger,
    events,
    emits(event, ...args) {
      for (const handler of events.get(event) ?? []) handler(...args)
    },
  }
}

/**
 * Build a mutable configuration container whose fields look exactly like the
 * schemastery `Volatile` references Cordis hands to `apply()` for `.volatile()`
 * fields, plus a setter so a test can simulate a live settings edit.
 *
 * @param {Record<string, unknown>} initial
 * @returns {{container: Record<string, {get(): unknown}>, set(key: string, value: unknown): void, get(key: string): unknown}}
 */
export function liveConfig(initial) {
  const current = { ...initial }
  const container = {}
  for (const key of Object.keys(initial)) {
    container[key] = Object.freeze({ get: () => current[key] })
  }
  return {
    container,
    set(key, value) {
      current[key] = value
    },
    get(key) {
      return current[key]
    },
  }
}
