/**
 * Test helper: build a fully **offline** provider pool.
 *
 * Every built-in provider is disabled and replaced with mock endpoints on
 * `127.0.0.1`, so a direct-mode test can never reach a real free provider even by
 * accident.
 *
 * ## The mocks validate the model name
 *
 * `startProviderMock` behaves like a **real** provider: it answers only for the
 * model ids its endpoint declares and returns `404 model_not_found` for anything
 * else. An earlier version of this helper answered every request, which let a
 * release-blocking defect hide in plain sight — direct mode sent the DSH routing
 * id (`auto`, `auto:simple`, `provider/model`) as the wire model, and every
 * mock happily replied 200. The ids a mock accepts are now taken from the same
 * declaration the pool advertises, so the two cannot drift.
 */

import { BUILTIN_PROVIDER_IDS } from '../../lib/providers.js'
import { chunk, startMockServer, writeSse } from './harness.mjs'

/**
 * Build a `config.providers` override map that disables the real pool and
 * declares only the given mock providers.
 *
 * @param {readonly {id: string}[]} providers
 * @param {{keepBuiltins?: boolean}} [options]
 * @returns {Record<string, Record<string, unknown>>}
 */
export function offlinePool(providers, options = {}) {
  /** @type {Record<string, Record<string, unknown>>} */
  const map = {}
  if (options.keepBuiltins !== true) {
    for (const id of BUILTIN_PROVIDER_IDS) map[id] = { enabled: false }
  }
  for (const provider of providers) {
    const { id, ...rest } = provider
    map[id] = { enabled: true, ...rest }
  }
  return map
}

/**
 * One mock provider declaration.
 *
 * @param {string} id
 * @param {string} baseURL the mock server's base URL
 * @param {{id: string, capability?: number, speed?: number, contextWindow?: number,
 *   maxTokens?: number, vision?: boolean, toolCalling?: boolean}[]} models
 * @returns {Record<string, unknown>}
 */
export function mockProvider(id, baseURL, models) {
  return {
    id,
    displayName: id,
    baseURL,
    apiKeyEnv: `${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`,
    apiKey: 'test-key-not-real',
    keyless: false,
    models,
  }
}

/**
 * A model entry with conservative defaults for the fields a test does not care
 * about.
 * @param {Record<string, unknown> & {id: string}} model
 */
export function model(model) {
  return {
    capability: 3,
    speed: 3,
    contextWindow: 131_072,
    maxTokens: 8_192,
    vision: false,
    toolCalling: true,
    ...model,
  }
}

/**
 * One mock endpoint that validates the wire model like a real provider.
 *
 * Any request whose `body.model` is not in `ids` is answered with
 * `404 {"error":{"code":"model_not_found"}}` — exactly what Groq, Cerebras and
 * friends do — and recorded in `badModels`.
 *
 * @param {object} options
 * @param {readonly string[]} options.ids the model ids this endpoint really serves
 * @param {string} [options.answer] text returned by the default SSE responder
 * @param {(context: {request: any, response: import('node:http').ServerResponse, body: any, hits: number}) => boolean | void} [options.respond]
 *   custom responder; return `true` when it has fully handled the response
 * @param {boolean} [options.end] whether the default responder ends the response
 * @returns {Promise<{baseURL: string, requests: any[], badModels: any[], hits: number, close(): Promise<void>}>}
 */
export async function startProviderMock(options) {
  const ids = new Set(options.ids)
  const requests = []
  const badModels = []
  const state = { hits: 0 }
  const server = await startMockServer((request, response) => {
    state.hits += 1
    let body
    try {
      body = request.body.length > 0 ? JSON.parse(request.body) : {}
    } catch {
      body = {}
    }
    requests.push({ url: request.url, headers: request.headers, body })

    if (!ids.has(body.model)) {
      badModels.push(body.model)
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        error: { message: `model '${body.model}' not found`, type: 'invalid_request_error', code: 'model_not_found' },
      }))
      return
    }
    if (typeof options.respond === 'function') {
      if (options.respond({ request, response, body, hits: state.hits }) === true) return
    }
    writeSse(response, [
      chunk(options.answer ?? 'ok'),
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      '[DONE]',
    ], { end: options.end !== false })
  })
  return {
    baseURL: server.baseURL,
    requests,
    badModels,
    get hits() {
      return state.hits
    },
    close: server.close,
  }
}

/**
 * Build several model-validating endpoints **and** the matching
 * `config.providers` override map in one step.
 *
 * Because the ids a mock accepts come from the same `models` array the pool
 * advertises, a test cannot accidentally assert against a model name the
 * endpoint would reject.
 *
 * @param {readonly {id: string, models: readonly Record<string, unknown>[], answer?: string,
 *   respond?: Function}[]} specs
 * @param {{keepBuiltins?: boolean}} [options]
 * @returns {Promise<{config: Record<string, Record<string, unknown>>, endpoints: Map<string, any>, requests(id: string): any[], badModels(id: string): any[], close(): Promise<void>}>}
 */
export async function startMockPool(specs, options = {}) {
  /** @type {Map<string, any>} */
  const endpoints = new Map()
  /** @type {Record<string, Record<string, unknown>>} */
  const config = {}
  if (options.keepBuiltins !== true) {
    for (const id of BUILTIN_PROVIDER_IDS) config[id] = { enabled: false }
  }
  for (const spec of specs) {
    const models = spec.models.map((entry) => model(entry))
    const mock = await startProviderMock({
      ids: models.map((entry) => entry.id),
      answer: spec.answer,
      respond: spec.respond,
      end: spec.end,
    })
    endpoints.set(spec.id, mock)
    config[spec.id] = { ...mockProvider(spec.id, mock.baseURL, models), keyless: spec.keyless ?? false, enabled: true }
  }
  return {
    config,
    endpoints,
    requests(id) {
      return endpoints.get(id)?.requests ?? []
    },
    badModels(id) {
      return endpoints.get(id)?.badModels ?? []
    },
    async close() {
      for (const mock of endpoints.values()) await mock.close()
    },
  }
}
