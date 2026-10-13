/**
 * Translation of classified upstream frames into the DSH `StreamChunk` stream.
 *
 * This is the correctness-critical part of the adapter, so it is a pure state
 * machine (`ChunkTranslator`) rather than inline code inside the generator: the
 * whole protocol — block-index allocation, `block-start`/`block-end` pairing,
 * tool-call fragment semantics, usage-before-finish ordering, terminal frames —
 * is unit-testable with plain objects.
 *
 * Protocol rules implemented here (`docs/SPEC.md` §5):
 * - `index` is a *stream-local* block ordinal allocated in first-appearance
 *   order and strictly increasing; the provider's own `tool_calls[].index` is a
 *   separate namespace mapped onto it;
 * - every block is `block-start` → deltas → exactly one `block-end` carrying the
 *   complete block;
 * - `tool-call-delta` always carries an `id`, carries `name` only on the first
 *   fragment that learns it, and `argumentsDelta` is a raw JSON *string slice*;
 * - `block-end.block` is the byte-exact materialization of the fragments this
 *   stream emitted. The adapter never repairs a truncated argument payload into
 *   a legal-but-wrong `{}`: a tool silently running with empty arguments is worse
 *   than a failed stream, so the malformed payload is closed verbatim and the
 *   stream terminates with an `INVALID_REQUEST` failure. The one normalisation is
 *   a call that carried *no* argument fragment at all — the canonical `{}` is
 *   then emitted as a real fragment, so the invariant still holds;
 * - `usage` precedes `finish`, and nothing follows `finish`.
 *
 * Upstream behaviours absorbed here (`research/freellmapi-protocol.md` §5):
 * - the gateway buffers tool calls, repairs them against the request schema and
 *   emits **one complete chunk** with `finish_reason: 'tool_calls'` — the same
 *   code path also handles genuinely interleaved fragments;
 * - the captured `usage` frame is re-emitted *after* the finish chunk, so the
 *   translator holds the terminal frame back until the stream really ends;
 * - `_fusion` additive frames carry no `choices` and are ignored upstream of
 *   this module.
 *
 * @module dsh-freellmapi/translate
 */

import { FRAME_KIND } from './frames.js'
import { EMPTY_RESPONSE_CODE } from './runtime.js'

/** Finish code used when the upstream applied a content filter. */
export const CONTENT_FILTER_CODE = 'CONTENT_FILTER'
/** Finish code used when tool-call arguments were not legal JSON. */
export const MALFORMED_ARGUMENTS_CODE = 'INVALID_REQUEST'

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {unknown} value @returns {number | undefined} */
function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * Map an OpenAI-style `usage` object onto DSH's `TokenUsage`.
 *
 * Cache accounting differs per vendor, so every documented spelling is read
 * (`prompt_tokens_details.cached_tokens`, `prompt_cache_hit_tokens`,
 * top-level `cached_tokens`) instead of assuming `input = prompt_tokens`.
 *
 * @param {unknown} raw the upstream usage object
 * @returns {Record<string, number> | undefined} a `TokenUsage`, or undefined when unusable
 */
export function mapUsage(raw) {
  if (!isRecord(raw)) return undefined
  const input = finiteNumber(raw.prompt_tokens) ?? finiteNumber(raw.input_tokens)
  const output = finiteNumber(raw.completion_tokens) ?? finiteNumber(raw.output_tokens)
  if (input === undefined && output === undefined) return undefined
  const promptDetails = isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : undefined
  const completionDetails = isRecord(raw.completion_tokens_details) ? raw.completion_tokens_details : undefined
  const cacheRead = finiteNumber(promptDetails?.cached_tokens)
    ?? finiteNumber(raw.prompt_cache_hit_tokens)
    ?? finiteNumber(raw.cached_tokens)
  const cacheWrite = finiteNumber(promptDetails?.cache_write_tokens)
    ?? finiteNumber(raw.cache_creation_input_tokens)
  const reasoning = finiteNumber(completionDetails?.reasoning_tokens) ?? finiteNumber(raw.reasoning_tokens)
  const total = finiteNumber(raw.total_tokens)
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    ...total === undefined ? {} : { totalTokens: total },
    ...cacheRead === undefined ? {} : { cacheReadTokens: cacheRead },
    ...cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite },
    ...reasoning === undefined ? {} : { reasoningTokens: reasoning },
  }
}

/**
 * Cumulative counters describing how a stream was translated. Useful for
 * diagnostics and for asserting tolerance in tests.
 * @typedef {object} TranslatorStats
 * @property {number} blocks number of blocks opened
 * @property {number} malformedFrames frames that were not valid JSON
 * @property {number} ignoredFrames well-formed frames with nothing to consume
 * @property {number} invalidToolArguments tool calls whose arguments were not legal JSON
 * @property {boolean} finished whether the terminal frame was emitted
 */

/**
 * Stateful frame → `StreamChunk` translator for exactly one upstream response.
 */
export class ChunkTranslator {
  /** @type {number} next stream-local block index to allocate */
  #nextIndex = 0
  /** @type {{kind: 'text' | 'reasoning', index: number, text: string} | null} */
  #open = null
  /** @type {Map<number, {index: number, id: string, name: string, nameSent: boolean, args: string, valid: boolean}>} */
  #tools = new Map()
  /** @type {string[]} */
  #finishReasons = []
  /** @type {Record<string, number> | undefined} */
  #usage = undefined
  /** @type {{message: string, code: string, status?: number} | null} */
  #error = null
  #blocks = 0
  #malformedFrames = 0
  #ignoredFrames = 0
  #invalidToolArguments = 0
  #finished = false
  #aborted = false

  /** @returns {boolean} whether the terminal frame has been produced */
  get finished() {
    return this.#finished
  }

  /** @returns {TranslatorStats} */
  get stats() {
    return {
      blocks: this.#blocks,
      malformedFrames: this.#malformedFrames,
      ignoredFrames: this.#ignoredFrames,
      invalidToolArguments: this.#invalidToolArguments,
      finished: this.#finished,
    }
  }

  /**
   * Consume one classified frame.
   * @param {{kind: string} & Record<string, any>} frame output of `classifyFrame`
   * @returns {import('./types.js').StreamChunkOut[]} chunks produced, in order
   */
  push(frame) {
    if (this.#finished || !isRecord(frame)) return []
    switch (frame.kind) {
      case FRAME_KIND.MALFORMED:
        this.#malformedFrames += 1
        return []
      case FRAME_KIND.IGNORED:
        this.#ignoredFrames += 1
        return []
      case FRAME_KIND.USAGE:
        this.#captureUsage(frame.usage)
        return []
      case FRAME_KIND.ERROR:
        this.#error = {
          message: typeof frame.message === 'string' ? frame.message : 'the gateway reported a stream error',
          code: typeof frame.code === 'string' && frame.code.length > 0 ? frame.code : 'SERVER',
        }
        return this.#terminate()
      case FRAME_KIND.DONE:
        return this.#terminate()
      case FRAME_KIND.CHUNK:
        return this.#consumeChunk(frame)
      default:
        this.#ignoredFrames += 1
        return []
    }
  }

  /**
   * Terminate the stream from the adapter's side: normal end of body, a
   * transport failure, or caller cancellation. Idempotent.
   *
   * @param {{kind?: 'aborted' | 'error', failure?: {message: string, code: string, status?: number}}} [verdict]
   * @returns {import('./types.js').StreamChunkOut[]} the remaining chunks
   */
  finish(verdict = {}) {
    if (verdict.failure !== undefined) {
      this.#error = verdict.failure
      this.#aborted = verdict.kind === 'aborted'
    }
    return this.#terminate()
  }

  /** @param {unknown} usage */
  #captureUsage(usage) {
    const mapped = mapUsage(usage)
    if (mapped !== undefined) this.#usage = mapped
  }

  /**
   * @param {{choices: readonly unknown[], usage?: unknown} & Record<string, any>} frame
   * @returns {import('./types.js').StreamChunkOut[]}
   */
  #consumeChunk(frame) {
    const out = []
    if (frame.usage !== undefined) this.#captureUsage(frame.usage)
    // Only one choice is consumed: `n > 1` is not supported by the gateway, and
    // consuming several would interleave unrelated blocks under one index space.
    const choice = frame.choices[0]
    if (isRecord(choice)) {
      const delta = isRecord(choice.delta) ? choice.delta : undefined
      if (delta !== undefined) {
        const content = textOfDelta(delta.content)
        if (content !== undefined && content.length > 0) out.push(...this.#pushText('text', content))
        const reasoning = textOfDelta(delta.reasoning_content)
          ?? textOfDelta(delta.reasoning)
          ?? textOfDelta(delta.reasoning_text)
        if (reasoning !== undefined && reasoning.length > 0) out.push(...this.#pushText('reasoning', reasoning))
        if (Array.isArray(delta.tool_calls)) {
          for (const call of delta.tool_calls) out.push(...this.#pushToolCall(call))
        }
      }
      const reason = typeof choice.finish_reason === 'string' ? choice.finish_reason : undefined
      if (reason !== undefined && reason.length > 0 && !this.#finishReasons.includes(reason)) {
        this.#finishReasons.push(reason)
      }
    }
    return out
  }

  /**
   * @param {'text' | 'reasoning'} kind
   * @param {string} text
   * @returns {import('./types.js').StreamChunkOut[]}
   */
  #pushText(kind, text) {
    const deltaType = kind === 'text' ? 'text-delta' : 'reasoning-delta'
    if (this.#open !== null && this.#open.kind === kind) {
      this.#open.text += text
      return [{ type: deltaType, index: this.#open.index, text }]
    }
    const out = this.#closeOpen()
    const index = this.#nextIndex
    this.#nextIndex += 1
    this.#blocks += 1
    this.#open = { kind, index, text }
    out.push({ type: 'block-start', index, blockType: kind })
    out.push({ type: deltaType, index, text })
    return out
  }

  /**
   * @param {unknown} call one entry of `delta.tool_calls`
   * @returns {import('./types.js').StreamChunkOut[]}
   */
  #pushToolCall(call) {
    if (!isRecord(call)) return []
    const wireIndex = Number.isInteger(call.index) && call.index >= 0 ? call.index : 0
    const out = []
    let entry = this.#tools.get(wireIndex)
    if (entry === undefined) {
      entry = {
        index: this.#nextIndex,
        id: '',
        name: '',
        nameSent: false,
        args: '',
        valid: true,
      }
      this.#nextIndex += 1
      this.#blocks += 1
      this.#tools.set(wireIndex, entry)
      out.push({ type: 'block-start', index: entry.index, blockType: 'tool-call' })
    }
    const fn = isRecord(call.function) ? call.function : undefined
    const upstreamId = typeof call.id === 'string' && call.id.length > 0 ? call.id : undefined
    if (upstreamId !== undefined) entry.id = upstreamId
    // `id` is non-optional on `tool-call-delta`, so a provider that never sends
    // one gets a deterministic stream-local id instead of an empty string. The
    // same value then lands in the assembled `tool-call` block, which is what the
    // later `tool_call_id` on the tool result has to match.
    if (entry.id.length === 0) entry.id = `call_${wireIndex}`

    let name
    if (typeof fn?.name === 'string' && fn.name.length > 0) {
      entry.name = fn.name
      if (!entry.nameSent) {
        entry.nameSent = true
        name = fn.name
      }
    }
    const argumentsDelta = typeof fn?.arguments === 'string' ? fn.arguments : ''
    if (name === undefined && argumentsDelta.length === 0 && upstreamId === undefined) return out

    out.push({
      type: 'tool-call-delta',
      index: entry.index,
      id: entry.id,
      ...name === undefined ? {} : { name },
      argumentsDelta,
    })
    entry.args += argumentsDelta
    return out
  }

  /** @returns {import('./types.js').StreamChunkOut[]} */
  #closeOpen() {
    if (this.#open === null) return []
    const { kind, index, text } = this.#open
    this.#open = null
    return [{
      type: 'block-end',
      index,
      block: kind === 'text' ? { type: 'text', text } : { type: 'reasoning', text },
    }]
  }

  /** @returns {import('./types.js').StreamChunkOut[]} */
  #closeTools() {
    if (this.#tools.size === 0) return []
    const entries = [...this.#tools.values()].sort((left, right) => left.index - right.index)
    this.#tools = new Map()
    const out = []
    for (const entry of entries) {
      if (entry.args.length === 0) {
        // The upstream declared a call but contributed no argument content at
        // all (`arguments` absent, `null` or `''`). Emit the canonical empty
        // object as a *streamed* fragment: `docs/SPEC.md` §5.4 wants `'{}'` for an
        // empty argument list, and emitting it as a real fragment keeps the
        // closed block byte-identical to what this stream produced instead of the
        // adapter rewriting the block behind the stream's back.
        const argumentsDelta = '{}'
        entry.args = argumentsDelta
        out.push({
          type: 'tool-call-delta',
          index: entry.index,
          id: entry.id,
          argumentsDelta,
        })
      }
      try {
        JSON.parse(entry.args)
      } catch {
        // `block-end.block.arguments` is deliberately left byte-identical to the
        // fragments this stream emitted: rewriting a truncated payload into `{}`
        // would let a tool run silently with empty arguments, which is worse than
        // failing. The block is closed as-is and the stream is terminated as an
        // error below, so the malformed payload never reaches a tool executor.
        entry.valid = false
        this.#invalidToolArguments += 1
      }
      out.push({
        type: 'block-end',
        index: entry.index,
        block: { type: 'tool-call', id: entry.id, name: entry.name, arguments: entry.args },
      })
    }
    return out
  }

  /**
   * Resolve the terminal reason from every finish signal seen.
   * @returns {{kind: string, failure?: Record<string, unknown>}}
   */
  #resolveReason() {
    if (this.#error !== null) {
      const failure = { ...this.#error }
      return this.#aborted ? { kind: 'aborted', failure } : { kind: 'error', failure }
    }
    const reasons = this.#finishReasons
    if (reasons.includes('content_filter')) {
      return {
        kind: 'error',
        failure: {
          message: 'dsh-freellmapi: the upstream provider stopped the response with a content filter',
          code: CONTENT_FILTER_CODE,
        },
      }
    }
    if (reasons.some((reason) => reason === 'tool_calls' || reason === 'function_call')) {
      if (this.#invalidToolArguments > 0) {
        return {
          kind: 'error',
          failure: {
            message: 'dsh-freellmapi: the upstream tool call returned arguments that are not legal JSON',
            code: MALFORMED_ARGUMENTS_CODE,
          },
        }
      }
      return { kind: 'tool-calls' }
    }
    if (reasons.includes('length')) return { kind: 'max-tokens' }
    if (this.#blocks === 0) {
      return {
        kind: 'error',
        failure: {
          message: 'dsh-freellmapi: the gateway completed the response without any content',
          code: EMPTY_RESPONSE_CODE,
        },
      }
    }
    return { kind: 'stop' }
  }

  /** @returns {import('./types.js').StreamChunkOut[]} */
  #terminate() {
    if (this.#finished) return []
    this.#finished = true
    const out = [...this.#closeOpen(), ...this.#closeTools()]
    const reason = this.#resolveReason()
    if (this.#usage !== undefined) out.push({ type: 'usage', usage: this.#usage })
    out.push({ type: 'finish', reason })
    return out
  }
}

/**
 * Extract the text of a delta field, tolerating the array form some gateways
 * use for `content`.
 * @param {unknown} value
 * @returns {string | undefined}
 */
function textOfDelta(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts = []
    for (const part of value) {
      if (isRecord(part) && typeof part.text === 'string') parts.push(part.text)
    }
    return parts.length === 0 ? undefined : parts.join('')
  }
  return undefined
}
