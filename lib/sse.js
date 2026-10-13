/**
 * Incremental Server-Sent Events decoder.
 *
 * The decoder is a pure, synchronous state machine: feed it arbitrary text
 * fragments (which is what a `fetch()` body reader yields — fragments split at
 * TCP boundaries, not at line boundaries) and it returns the SSE events that
 * became complete. Nothing here knows about chat completions, which keeps the
 * byte-level edge cases (CRLF, half lines, heartbeats, multi-line `data:`,
 * a final line with no trailing newline) unit-testable without a socket.
 *
 * SSE framing implemented here (`WHATWG HTML` §9.2.6 event stream format):
 * - lines end with `\n`, `\r\n` or `\r`;
 * - a line starting with `:` is a comment (the gateway's keep-alive pings);
 * - `field: value` strips exactly one leading space from the value;
 * - `data` fields accumulate, joined by `\n`;
 * - a blank line dispatches the accumulated event;
 * - `event` names the event; `id`/`retry` are consumed and exposed but not used.
 *
 * @module dsh-freellmapi/sse
 */

/** The sentinel OpenAI-compatible servers send as the last `data:` payload. */
export const SSE_DONE = '[DONE]'

/**
 * One decoded SSE event.
 * @typedef {object} SseEvent
 * @property {string} data   the joined `data:` payload ('' when the event had none)
 * @property {string} event  the `event:` name ('' when the event had none)
 * @property {string} id     the last `id:` value ('' when absent)
 * @property {number} [retry] the reconnection delay when the server sent one
 */

/**
 * Incremental SSE decoder.
 *
 * Usage:
 * ```js
 * const decoder = new SseDecoder()
 * for await (const text of body) {
 *   for (const event of decoder.push(text)) handle(event)
 * }
 * for (const event of decoder.end()) handle(event)
 * ```
 */
export class SseDecoder {
  /** @type {string} text received but not yet terminated by a line break */
  #buffer = ''
  /** @type {string[]} accumulated `data:` lines of the event under construction */
  #data = []
  /** @type {string} */
  #event = ''
  /** @type {string} */
  #id = ''
  /** @type {number | undefined} */
  #retry = undefined

  /**
   * Feed one text fragment.
   * @param {string} chunk decoded text; may split lines or events anywhere
   * @returns {SseEvent[]} every event that completed within this fragment
   */
  push(chunk) {
    if (typeof chunk !== 'string') throw new TypeError('SseDecoder.push expects a string')
    if (chunk.length === 0) return []
    this.#buffer += chunk
    const events = []
    // Scan for LF and strip a preceding CR, so both LF and CRLF terminate a line.
    // A stream that used *only* bare CR terminators is not produced by any
    // OpenAI-compatible gateway and is deliberately not supported.
    const text = this.#buffer
    let cursor = 0
    while (true) {
      const newline = text.indexOf('\n', cursor)
      if (newline === -1) break
      let line = text.slice(cursor, newline)
      cursor = newline + 1
      if (line.endsWith('\r')) line = line.slice(0, -1)
      const event = this.#consumeLine(line)
      if (event !== undefined) events.push(event)
    }
    this.#buffer = text.slice(cursor)
    return events
  }

  /**
   * Finish the stream: process a trailing line that never got its line break
   * and dispatch an event that was never terminated by a blank line.
   * @returns {SseEvent[]} the remaining events
   */
  end() {
    const events = []
    const tail = this.#buffer
    this.#buffer = ''
    if (tail.length > 0) {
      const line = tail.endsWith('\r') ? tail.slice(0, -1) : tail
      const event = this.#consumeLine(line)
      if (event !== undefined) events.push(event)
    }
    const flushed = this.#dispatch()
    if (flushed !== undefined) events.push(flushed)
    return events
  }

  /**
   * Apply one complete line to the event under construction.
   * @param {string} line a line without its terminator
   * @returns {SseEvent | undefined} an event when this line completed one
   */
  #consumeLine(line) {
    if (line.length === 0) return this.#dispatch()
    if (line.startsWith(':')) return undefined // comment / keep-alive
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    switch (field) {
      case 'data':
        this.#data.push(value)
        return undefined
      case 'event':
        this.#event = value
        return undefined
      case 'id':
        if (!value.includes('\u0000')) this.#id = value
        return undefined
      case 'retry': {
        const parsed = Number.parseInt(value, 10)
        if (Number.isFinite(parsed)) this.#retry = parsed
        return undefined
      }
      default:
        return undefined // unknown fields are ignored per the SSE spec
    }
  }

  /**
   * Dispatch the accumulated event, if any.
   * @returns {SseEvent | undefined}
   */
  #dispatch() {
    if (this.#data.length === 0 && this.#event === '' && this.#id === '') return undefined
    const event = {
      data: this.#data.join('\n'),
      event: this.#event,
      id: this.#id,
      ...this.#retry === undefined ? {} : { retry: this.#retry },
    }
    this.#data = []
    this.#event = ''
    return event
  }

  /** Reset the decoder to its initial state. */
  reset() {
    this.#buffer = ''
    this.#data = []
    this.#event = ''
    this.#id = ''
    this.#retry = undefined
  }
}

/**
 * Decode an async iterable of text fragments into SSE events.
 * @param {AsyncIterable<string> | Iterable<string>} source text fragments
 * @returns {AsyncGenerator<SseEvent>} every complete event, in order
 */
export async function* decodeSse(source) {
  const decoder = new SseDecoder()
  for await (const fragment of source) {
    for (const event of decoder.push(fragment)) yield event
  }
  for (const event of decoder.end()) yield event
}

/**
 * Incrementally decode a `fetch()` `Response.body` (a web `ReadableStream` of
 * `Uint8Array`) into SSE events, reassembling UTF-8 code points that are split
 * across chunk boundaries.
 * @param {ReadableStream<Uint8Array> | null | undefined} body
 * @returns {AsyncGenerator<SseEvent>} every complete event, in order
 */
export async function* decodeSseBody(body) {
  if (body === null || body === undefined) return
  const decoder = new TextDecoder('utf-8')
  const sse = new SseDecoder()
  const reader = body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      for (const event of sse.push(decoder.decode(value, { stream: true }))) yield event
    }
    for (const event of sse.push(decoder.decode())) yield event
    for (const event of sse.end()) yield event
  } finally {
    // Releasing the lock lets an aborted fetch settle instead of pinning the body.
    try {
      reader.releaseLock()
    } catch {
      // the reader may already be detached by an abort
    }
  }
}
