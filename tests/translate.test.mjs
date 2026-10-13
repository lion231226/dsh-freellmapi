/**
 * `ChunkTranslator` tests: the frame → `StreamChunk` state machine.
 *
 * The helper’s parser is an independent implementation of the DSH stream rules,
 * so these assertions are about the protocol, not about the translator agreeing
 * with itself.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyFrame } from '../lib/frames.js'
import { ChunkTranslator, mapUsage } from '../lib/translate.js'
import { assertValidChunkSequence } from './helpers/harness.mjs'

/** Feed raw SSE payload strings through classification and translation. */
function run(payloads, verdict) {
  const translator = new ChunkTranslator()
  const chunks = []
  for (const payload of payloads) chunks.push(...translator.push(classifyFrame(payload)))
  if (verdict !== undefined) chunks.push(...translator.finish(verdict))
  else chunks.push(...translator.finish())
  return { chunks, translator }
}

const text = (content) => JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })
const stop = () => JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })

test('a plain text stream assembles one text block', () => {
  const { chunks } = run([text('Hello'), text(', '), text('world.'), stop(), '[DONE]'])
  const { blocks, finish } = assertValidChunkSequence(chunks)
  assert.deepEqual(blocks, [{ type: 'text', text: 'Hello, world.' }])
  assert.deepEqual(finish, { kind: 'stop' })
})

test('reasoning deltas open a reasoning block and switching kind closes it', () => {
  const reasoning = JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'think' }, finish_reason: null }] })
  const { chunks } = run([reasoning, text('answer'), stop(), '[DONE]'])
  const { blocks, finish } = assertValidChunkSequence(chunks)
  assert.deepEqual(blocks, [
    { type: 'reasoning', text: 'think' },
    { type: 'text', text: 'answer' },
  ])
  assert.equal(finish.kind, 'stop')
})

test('reasoning and reasoning_content spellings both work', () => {
  const first = JSON.stringify({ choices: [{ index: 0, delta: { reasoning: 'a' }, finish_reason: null }] })
  const second = JSON.stringify({ choices: [{ index: 0, delta: { reasoning_text: 'b' }, finish_reason: null }] })
  const { chunks } = run([first, second, stop(), '[DONE]'])
  const { blocks } = assertValidChunkSequence(chunks)
  assert.deepEqual(blocks, [{ type: 'reasoning', text: 'ab' }])
})

test('fragmented tool calls: id on every delta, name only on the first', () => {
  const { chunks } = run([
    JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Beijing"}' } }] }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    '[DONE]',
  ])
  const { blocks, finish } = assertValidChunkSequence(chunks)
  assert.deepEqual(blocks, [{ type: 'tool-call', id: 'call_1', name: 'get_weather', arguments: '{"city":"Beijing"}' }])
  assert.deepEqual(finish, { kind: 'tool-calls' })

  const deltas = chunks.filter((chunk_) => chunk_.type === 'tool-call-delta')
  assert.equal(deltas.length, 3)
  for (const delta of deltas) assert.equal(delta.id, 'call_1')
  assert.equal(deltas[0].name, 'get_weather')
  assert.equal(deltas[1].name, undefined)
  assert.equal(deltas[2].name, undefined)
  assert.equal(deltas[1].argumentsDelta, '{"city":')
})

test('the gateway’s merged single tool-call chunk also works', () => {
  // freellmapi buffers tool calls, repairs them against the request schema and
  // emits one complete chunk with finish_reason tool_calls.
  const { chunks } = run([
    text('let me check'),
    JSON.stringify({
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, id: 'call_9', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] },
        finish_reason: 'tool_calls',
      }],
    }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 } }),
    '[DONE]',
  ])
  const { blocks, usage, finish } = assertValidChunkSequence(chunks)
  assert.deepEqual(blocks, [
    { type: 'text', text: 'let me check' },
    { type: 'tool-call', id: 'call_9', name: 'lookup', arguments: '{"q":"x"}' },
  ])
  // A later `stop` must not override an announced tool call.
  assert.deepEqual(finish, { kind: 'tool-calls' })
  assert.deepEqual(usage, { inputTokens: 11, outputTokens: 5, totalTokens: 16 })
})

test('two parallel tool calls get distinct, increasing block indices', () => {
  const { chunks } = run([
    JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'one', arguments: '{}' } }] }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'two', arguments: '{}' } }] }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    '[DONE]',
  ])
  const { blocks } = assertValidChunkSequence(chunks)
  assert.deepEqual(blocks.map((block) => block.name), ['one', 'two'])
})

test('a tool call with no upstream id gets a deterministic id', () => {
  const { chunks } = run([
    JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'anon', arguments: '{}' } }] }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    '[DONE]',
  ])
  const { blocks } = assertValidChunkSequence(chunks)
  assert.equal(blocks[0].id, 'call_0')
  assert.equal(blocks[0].name, 'anon')
})

test('empty tool arguments close with {}', () => {
  const { chunks } = run([
    JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'noargs', arguments: '' } }] }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    '[DONE]',
  ])
  const { blocks, finish, invalidToolArguments } = assertValidChunkSequence(chunks)
  assert.equal(blocks[0].arguments, '{}')
  assert.deepEqual(invalidToolArguments, [])
  assert.deepEqual(finish, { kind: 'tool-calls' })
  // The `{}` must be *streamed* (so fragments and the closed block agree),
  // never injected into block-end behind the stream's back.
  const streamed = chunks.filter((chunk_) => chunk_.type === 'tool-call-delta').map((chunk_) => chunk_.argumentsDelta).join('')
  assert.equal(streamed, '{}')
})

test('a tool call with no arguments field at all still closes with {}', () => {
  const { chunks } = run([
    JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'noargs' } }] }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    '[DONE]',
  ])
  const { blocks, finish } = assertValidChunkSequence(chunks)
  assert.equal(blocks[0].arguments, '{}')
  assert.deepEqual(finish, { kind: 'tool-calls' })
})

test('truncated tool arguments stay byte-identical to the stream, then fail the stream', () => {
  const { chunks } = run([
    JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'broken', arguments: '{"a":' } }] }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    '[DONE]',
  ])
  const { blocks, finish, invalidToolArguments } = assertValidChunkSequence(chunks)
  // Never rewritten into a legal-but-wrong `{}`: a tool must not silently run
  // with empty arguments. The stream fails instead, so the block is never used.
  assert.equal(blocks[0].arguments, '{"a":')
  assert.deepEqual(invalidToolArguments, ['broken'])
  assert.equal(finish.kind, 'error')
  assert.equal(finish.failure.code, 'INVALID_REQUEST')
})

test('length maps to max-tokens and keeps the block', () => {
  const { chunks } = run([text('truncated'), JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }), '[DONE]'])
  const { blocks, finish } = assertValidChunkSequence(chunks)
  assert.deepEqual(blocks, [{ type: 'text', text: 'truncated' }])
  assert.deepEqual(finish, { kind: 'max-tokens' })
})

test('content_filter maps to an error finish', () => {
  const { chunks } = run([text('partial'), JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }] }), '[DONE]'])
  const { finish } = assertValidChunkSequence(chunks)
  assert.equal(finish.kind, 'error')
  assert.equal(finish.failure.code, 'CONTENT_FILTER')
})

test('a stream that ends without any finish signal still terminates', () => {
  const { chunks } = run([text('hi')])
  const { finish } = assertValidChunkSequence(chunks)
  assert.deepEqual(finish, { kind: 'stop' })
})

test('a completely empty stream is reported as EMPTY_RESPONSE', () => {
  const { chunks } = run([JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }), '[DONE]'])
  const { finish } = assertValidChunkSequence(chunks)
  assert.equal(finish.kind, 'error')
  assert.equal(finish.failure.code, 'EMPTY_RESPONSE')
})

test('a stream_error frame becomes a finish error, not a throw', () => {
  const { chunks } = run([
    text('partial answer'),
    JSON.stringify({ type: 'stream_error', error: { message: 'upstream provider reset the connection', type: 'api_error' } }),
    '[DONE]',
  ])
  const { blocks, finish } = assertValidChunkSequence(chunks)
  assert.deepEqual(blocks, [{ type: 'text', text: 'partial answer' }])
  assert.equal(finish.kind, 'error')
  assert.equal(finish.failure.message, 'upstream provider reset the connection')
})

test('usage arriving after the finish chunk is still emitted before finish', () => {
  const { chunks } = run([
    text('x'),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    JSON.stringify({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }),
    '[DONE]',
  ])
  const { finish, usage } = assertValidChunkSequence(chunks)
  assert.equal(finish.kind, 'stop')
  assert.deepEqual(usage, { inputTokens: 2, outputTokens: 3, totalTokens: 5 })
  const usagePosition = chunks.findIndex((chunk_) => chunk_.type === 'usage')
  const finishPosition = chunks.findIndex((chunk_) => chunk_.type === 'finish')
  assert.ok(usagePosition < finishPosition)
})

test('malformed and ignored frames are skipped without breaking the stream', () => {
  const { chunks, translator } = run([
    text('a'),
    '{"choices": [',
    JSON.stringify({ _fusion: { stage: 'panel' } }),
    text('b'),
    stop(),
    '[DONE]',
  ])
  const { blocks } = assertValidChunkSequence(chunks)
  assert.deepEqual(blocks, [{ type: 'text', text: 'ab' }])
  assert.equal(translator.stats.malformedFrames, 1)
  assert.equal(translator.stats.ignoredFrames, 1)
})

test('frames after the terminal chunk are dropped', () => {
  const translator = new ChunkTranslator()
  const first = translator.push(classifyFrame('[DONE]'))
  assert.equal(first.at(-1).type, 'finish')
  assert.deepEqual(translator.push(classifyFrame(text('late'))), [])
  assert.deepEqual(translator.finish(), [])
})

test('abort terminates with an aborted finish carrying ABORTED', () => {
  const { chunks } = run([text('half')], { kind: 'aborted', failure: { message: 'caller aborted', code: 'ABORTED' } })
  const { blocks, finish } = assertValidChunkSequence(chunks)
  assert.deepEqual(blocks, [{ type: 'text', text: 'half' }])
  assert.equal(finish.kind, 'aborted')
  assert.equal(finish.failure.code, 'ABORTED')
})

test('an error verdict terminates the stream in band', () => {
  const { chunks } = run([], { kind: 'error', failure: { message: 'gateway unreachable', code: 'TRANSPORT' } })
  const { finish } = assertValidChunkSequence(chunks)
  assert.equal(finish.kind, 'error')
  assert.equal(finish.failure.code, 'TRANSPORT')
})

test('a text delta after a closed text block opens a fresh block', () => {
  const { chunks } = run([text('a'), reasoningAfter(), text('b'), stop(), '[DONE]'])
  const { blocks } = assertValidChunkSequence(chunks)
  assert.deepEqual(blocks.map((block) => block.type), ['text', 'reasoning', 'text'])
  assert.equal(blocks[2].text, 'b')
})

function reasoningAfter() {
  return JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'r' }, finish_reason: null }] })
}

test('mapUsage reads the documented cache and reasoning spellings', () => {
  assert.deepEqual(
    mapUsage({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_tokens_details: { cached_tokens: 6 }, completion_tokens_details: { reasoning_tokens: 2 } }),
    { inputTokens: 10, outputTokens: 4, totalTokens: 14, cacheReadTokens: 6, reasoningTokens: 2 },
  )
  assert.deepEqual(
    mapUsage({ prompt_cache_hit_tokens: 3, prompt_tokens: 9, completion_tokens: 1 }),
    { inputTokens: 9, outputTokens: 1, cacheReadTokens: 3 },
  )
  assert.equal(mapUsage({}), undefined)
  assert.equal(mapUsage(null), undefined)
})

test('usage numbers that are negative or infinite are ignored', () => {
  assert.deepEqual(mapUsage({ prompt_tokens: -1, completion_tokens: 2 }), { inputTokens: 0, outputTokens: 2 })
  assert.equal(mapUsage({ prompt_tokens: Number.POSITIVE_INFINITY }), undefined)
})
