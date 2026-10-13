/**
 * Classification of decoded SSE payloads into the small set of shapes a
 * FreeLLMAPI (OpenAI-compatible) stream actually contains.
 *
 * Keeping this pure means the tolerant parsing rules below are testable without
 * a socket, and the translator that consumes them only has to handle five
 * frame kinds instead of every JSON shape an upstream might invent.
 *
 * Documented upstream behaviours this module has to absorb
 * (`research/freellmapi-protocol.md` §5):
 * - `data: [DONE]` terminates the stream;
 * - the gateway re-emits a captured `usage` frame *after* its finish chunk, and
 *   that frame may carry `choices: []` or no `choices` key at all;
 * - `fusion` responses interleave additive `_fusion` frames that have no
 *   `choices` and no `usage` — they are metadata, not content;
 * - a mid-stream failure after the response headers were flushed arrives as a
 *   `stream_error` frame followed by `[DONE]`, and there is no failover.
 *
 * @module dsh-freellmapi/frames
 */

/** Frame kinds produced by {@link classifyFrame}. */
export const FRAME_KIND = Object.freeze({
  /** `data: [DONE]` — the upstream stream ended normally. */
  DONE: 'done',
  /** A `chat.completion.chunk` carrying `choices` (and possibly `usage`). */
  CHUNK: 'chunk',
  /** A bare usage frame (`usage` present, no `choices` to consume). */
  USAGE: 'usage',
  /** An in-band error frame (`error`, or a `stream_error` marker). */
  ERROR: 'error',
  /** Payload was not valid JSON — tolerated and skipped. */
  MALFORMED: 'malformed',
  /** A well-formed frame with nothing this adapter consumes. */
  IGNORED: 'ignored',
})

/** @param {unknown} value @returns {string | undefined} */
function asNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** @param {unknown} value @returns {Record<string, unknown> | undefined} */
function asObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : undefined
}

/**
 * Whether a parsed frame announces a failure rather than content.
 * @param {Record<string, unknown>} value
 * @returns {boolean}
 */
function looksLikeError(value) {
  if (value.error !== undefined && value.error !== null) return true
  if (value.type === 'stream_error') return true
  if (value.code === 'stream_error') return true
  if (value.object === 'error') return true
  return false
}

/**
 * Normalise the many error shapes an OpenAI-compatible gateway may use into a
 * message plus an optional upstream code.
 * @param {Record<string, unknown>} value the whole frame
 * @returns {{message: string, code?: string, type?: string}}
 */
function extractError(value) {
  const nested = asObject(value.error)
  const message = asNonEmptyString(nested?.message)
    ?? asNonEmptyString(value.message)
    ?? asNonEmptyString(typeof value.error === 'string' ? value.error : undefined)
    ?? asNonEmptyString(nested?.error)
    ?? asNonEmptyString(value.detail)
    ?? 'the gateway reported a stream error'
  const code = asNonEmptyString(nested?.code)
    ?? asNonEmptyString(value.code)
    ?? asNonEmptyString(nested?.type)
    ?? asNonEmptyString(value.type)
  const type = asNonEmptyString(nested?.type) ?? asNonEmptyString(value.type)
  return {
    message,
    ...code === undefined ? {} : { code },
    ...type === undefined ? {} : { type },
  }
}

/**
 * Classify one decoded SSE payload.
 * @param {string} data the `data:` payload exactly as received
 * @returns {{kind: string} & Record<string, unknown>} a discriminated frame
 */
export function classifyFrame(data) {
  if (typeof data !== 'string') {
    return { kind: FRAME_KIND.MALFORMED, raw: data, reason: 'payload was not a string' }
  }
  if (data.trim() === '[DONE]') return { kind: FRAME_KIND.DONE }

  let parsed
  try {
    parsed = JSON.parse(data)
  } catch (error) {
    // Heartbeats, provider keep-alives and truncated frames land here. A
    // malformed frame is never fatal: the next well-formed frame still works.
    return {
      kind: FRAME_KIND.MALFORMED,
      raw: data,
      reason: error instanceof Error ? error.message : String(error),
    }
  }

  const value = asObject(parsed)
  if (value === undefined) {
    return { kind: FRAME_KIND.IGNORED, raw: parsed, reason: 'JSON payload was not an object' }
  }

  if (looksLikeError(value)) {
    return { kind: FRAME_KIND.ERROR, raw: value, ...extractError(value) }
  }

  const choices = Array.isArray(value.choices) ? value.choices : undefined
  const usage = asObject(value.usage)
  const id = asNonEmptyString(value.id)
  const model = asNonEmptyString(value.model)

  if (choices !== undefined && choices.length > 0) {
    return {
      kind: FRAME_KIND.CHUNK,
      raw: value,
      choices,
      ...usage === undefined ? {} : { usage },
      ...id === undefined ? {} : { id },
      ...model === undefined ? {} : { model },
    }
  }

  if (usage !== undefined) {
    return { kind: FRAME_KIND.USAGE, raw: value, usage }
  }

  // `_fusion` additive frames, empty-choice keep-alives, and role-only frames.
  return { kind: FRAME_KIND.IGNORED, raw: value, reason: 'no choices and no usage' }
}
