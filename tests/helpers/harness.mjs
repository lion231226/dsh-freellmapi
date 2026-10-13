/**
 * Shared test helpers: a dependency-free mock gateway and an independent
 * `StreamChunk` sequence validator.
 *
 * The validator is a deliberate re-implementation of the protocol rules (not an
 * import of the plugin's own translator), so a bug in the translator cannot make
 * the test agree with it.
 */

import { createServer } from 'node:http'

/**
 * Start an HTTP server on an ephemeral port that records every request.
 * @param {(request: {method: string, url: string, headers: Record<string, any>, body: string}, response: import('node:http').ServerResponse) => void} handler
 * @returns {Promise<{baseURL: string, origin: string, requests: any[], close(): Promise<void>}>}
 */
export async function startMockServer(handler) {
  const requests = []
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const record = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      requests.push(record)
      try {
        handler(record, response)
      } catch (error) {
        try {
          response.statusCode = 500
          response.end(String(error))
        } catch {
          // the response may already be closed
        }
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    origin: `http://127.0.0.1:${port}`,
    requests,
    async close() {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/**
 * Write an SSE response.
 * Entries may be objects (JSON-encoded and prefixed with `data: `), plain
 * strings (sent verbatim), or `{raw: '…'}` for exact bytes. `{chunked: […]}`
 * lets a test split one payload across several TCP writes.
 *
 * @param {import('node:http').ServerResponse} response
 * @param {any[]} entries
 * @param {{status?: number, headers?: Record<string, string>, end?: boolean}} [options]
 */
export function writeSse(response, entries, options = {}) {
  response.writeHead(options.status ?? 200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    ...options.headers ?? {},
  })
  for (const entry of entries) {
    if (typeof entry === 'string') {
      response.write(`data: ${entry}\n\n`)
    } else if (entry !== null && typeof entry === 'object' && typeof entry.raw === 'string') {
      response.write(entry.raw)
    } else if (entry !== null && typeof entry === 'object' && Array.isArray(entry.chunked)) {
      for (const part of entry.chunked) response.write(part)
    } else {
      response.write(`data: ${JSON.stringify(entry)}\n\n`)
    }
  }
  if (options.end !== false) response.end()
}

/** Build one `chat.completion.chunk` with a content delta. */
export function chunk(content, extra = {}) {
  return { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'upstream-model', choices: [{ index: 0, delta: { content }, finish_reason: null }], ...extra }
}

/** Build one `chat.completion.chunk` with a reasoning delta. */
export function reasoningChunk(text) {
  return { id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }] }
}

/** Collect an async iterable into an array. */
export async function collect(iterable) {
  const out = []
  for await (const item of iterable) out.push(item)
  return out
}

const DELTA_TYPES = new Set(['text-delta', 'reasoning-delta', 'tool-call-delta'])
const INDEX_TYPES = new Set(['block-start', 'block-end', ...DELTA_TYPES])

/**
 * Assert that a chunk list satisfies the DSH stream protocol, and return the
 * reconstructed blocks so callers can assert on content.
 *
 * Enforced rules (`docs/SPEC.md` §5):
 * 1. `index` is a non-negative safe integer (never `-0`) and block indices are
 *    allocated in strictly increasing first-appearance order;
 * 2. every `block-start` is closed by exactly one `block-end` for the same index
 *    whose `block.type` matches the announced `blockType`;
 * 3. reconstructed text/reasoning/tool arguments equal the closed block content;
 * 4. `tool-call-delta` always carries a string `id`, `name` only ever appears as
 *    a non-empty string, and `argumentsDelta` is a string;
 * 5. `usage` precedes `finish`; there is exactly one `finish`, and it is last;
 * 6. `finish.reason.kind` is one of the five legal kinds, and `aborted`/`error`
 *    carry a `failure` with non-empty `message` and `code`.
 *
 * @param {any[]} chunks
 * @returns {{blocks: any[], usage: any, finish: any, invalidToolArguments: string[]}} the reconstructed
 *   blocks, the usage object, the finish reason, and the names of any tool calls whose streamed
 *   arguments were not parseable as JSON (permitted only alongside an error finish).
 */
export function assertValidChunkSequence(chunks) {
  const open = new Map()
  const order = []
  const closed = new Map()
  const invalidToolArguments = []
  let usage
  let finish
  let seenFinish = false
  let lastIndex = -1

  for (const [position, item] of chunks.entries()) {
    if (item === null || typeof item !== 'object') throw new Error(`chunk #${position} is not an object`)
    if (seenFinish) throw new Error(`chunk #${position} (${item.type}) follows the terminal finish`)
    const label = `chunk #${position} (${item.type})`

    if (INDEX_TYPES.has(item.type)) {
      const index = item.index
      if (!Number.isSafeInteger(index) || index < 0 || Object.is(index, -0)) {
        throw new Error(`${label}: index must be a non-negative safe integer, got ${String(index)}`)
      }
    }

    switch (item.type) {
      case 'block-start': {
        if (typeof item.blockType !== 'string' || item.blockType.length === 0) {
          throw new Error(`${label}: blockType must be a non-empty string`)
        }
        if (open.has(item.index) || closed.has(item.index)) {
          throw new Error(`${label}: index ${item.index} is already in use`)
        }
        if (item.index <= lastIndex) throw new Error(`${label}: index ${item.index} is not increasing (last ${lastIndex})`)
        lastIndex = item.index
        open.set(item.index, { blockType: item.blockType, text: '', args: '', id: undefined, name: undefined })
        order.push(item.index)
        break
      }
      case 'text-delta':
      case 'reasoning-delta': {
        if (typeof item.text !== 'string') throw new Error(`${label}: text must be a string`)
        const state = open.get(item.index)
        if (state === undefined) throw new Error(`${label}: no open block at index ${item.index}`)
        const expected = item.type === 'text-delta' ? 'text' : 'reasoning'
        if (state.blockType !== expected) throw new Error(`${label}: block ${item.index} is a ${state.blockType} block`)
        state.text += item.text
        break
      }
      case 'tool-call-delta': {
        if (typeof item.id !== 'string') throw new Error(`${label}: id must be a string`)
        if (Object.hasOwn(item, 'name') && (typeof item.name !== 'string' || item.name.length === 0)) {
          throw new Error(`${label}: name must be a non-empty string when present`)
        }
        if (typeof item.argumentsDelta !== 'string') throw new Error(`${label}: argumentsDelta must be a string`)
        const state = open.get(item.index)
        if (state === undefined) throw new Error(`${label}: no open block at index ${item.index}`)
        if (state.blockType !== 'tool-call') throw new Error(`${label}: block ${item.index} is a ${state.blockType} block`)
        if (state.id !== undefined && state.id !== item.id) {
          throw new Error(`${label}: tool-call id changed from ${state.id} to ${item.id}`)
        }
        state.id = item.id
        if (item.name !== undefined) state.name = item.name
        state.args += item.argumentsDelta
        break
      }
      case 'block-end': {
        const state = open.get(item.index)
        if (state === undefined) throw new Error(`${label}: no open block at index ${item.index}`)
        if (item.block === null || typeof item.block !== 'object') throw new Error(`${label}: block must be an object`)
        if (item.block.type !== state.blockType) {
          throw new Error(`${label}: block.type ${item.block.type} does not match blockType ${state.blockType}`)
        }
        if (state.blockType === 'text' || state.blockType === 'reasoning') {
          if (item.block.text !== state.text) {
            throw new Error(`${label}: block text ${JSON.stringify(item.block.text)} != streamed ${JSON.stringify(state.text)}`)
          }
        }
        if (state.blockType === 'tool-call') {
          // Hard invariant: the closed block must be the byte-exact materialization
          // of what this stream emitted. An adapter may not rewrite it.
          if (item.block.arguments !== state.args) {
            throw new Error(`${label}: block arguments ${JSON.stringify(item.block.arguments)} != streamed ${JSON.stringify(state.args)}`)
          }
          try {
            JSON.parse(item.block.arguments)
          } catch {
            // Permitted only when the streamed fragments themselves were unparseable
            // (a truncated upstream payload); the adapter must then fail the stream.
            invalidToolArguments.push(item.block.name)
          }
          if (typeof item.block.name !== 'string') throw new Error(`${label}: tool-call block needs a string name`)
          if (state.name !== undefined && item.block.name !== state.name) {
            throw new Error(`${label}: block name ${item.block.name} != announced ${state.name}`)
          }
        }
        open.delete(item.index)
        closed.set(item.index, item.block)
        break
      }
      case 'usage': {
        if (item.usage === null || typeof item.usage !== 'object') throw new Error(`${label}: usage must be an object`)
        if (typeof item.usage.inputTokens !== 'number' || typeof item.usage.outputTokens !== 'number') {
          throw new Error(`${label}: usage.inputTokens/outputTokens must be numbers`)
        }
        usage = item.usage
        break
      }
      case 'finish': {
        const kind = item.reason?.kind
        if (!['stop', 'tool-calls', 'max-tokens', 'aborted', 'error'].includes(kind)) {
          throw new Error(`${label}: illegal finish kind ${String(kind)}`)
        }
        if (kind === 'aborted' || kind === 'error') {
          if (typeof item.reason.failure?.message !== 'string' || item.reason.failure.message.length === 0) {
            throw new Error(`${label}: ${kind} finish needs a failure message`)
          }
          if (typeof item.reason.failure?.code !== 'string' || item.reason.failure.code.length === 0) {
            throw new Error(`${label}: ${kind} finish needs a failure code`)
          }
        }
        finish = item.reason
        seenFinish = true
        break
      }
      default:
        throw new Error(`${label}: unknown chunk type`)
    }
  }

  if (finish === undefined) throw new Error('the stream never produced a terminal finish chunk')
  if (open.size > 0) throw new Error(`blocks left open: ${[...open.keys()].join(', ')}`)
  return { blocks: order.map((index) => closed.get(index)), usage, finish, invalidToolArguments }
}
