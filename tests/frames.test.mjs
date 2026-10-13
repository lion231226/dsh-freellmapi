/**
 * Upstream frame classification tests.
 *
 * These cover the shapes `research/freellmapi-protocol.md` §5 documents as
 * actually occurring on the wire: a usage frame re-emitted after the finish
 * chunk (with `choices: []` or without a `choices` key at all), `_fusion`
 * additive frames with no choices, `stream_error` frames after a mid-stream
 * failure, plus malformed payloads that must be skipped rather than fatal.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { FRAME_KIND, classifyFrame } from '../lib/frames.js'

test('[DONE] is recognised, with or without surrounding whitespace', () => {
  assert.equal(classifyFrame('[DONE]').kind, FRAME_KIND.DONE)
  assert.equal(classifyFrame(' [DONE] ').kind, FRAME_KIND.DONE)
})

test('a content chunk is classified as a chunk with its choices', () => {
  const frame = classifyFrame(JSON.stringify({
    id: 'chatcmpl-1',
    model: 'llama-3.3-70b',
    choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
  }))
  assert.equal(frame.kind, FRAME_KIND.CHUNK)
  assert.equal(frame.choices.length, 1)
  assert.equal(frame.model, 'llama-3.3-70b')
})

test('a chunk that also carries usage exposes both', () => {
  const frame = classifyFrame(JSON.stringify({
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  }))
  assert.equal(frame.kind, FRAME_KIND.CHUNK)
  assert.deepEqual(frame.usage, { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 })
})

test('a usage frame with an empty choices array is a usage frame', () => {
  const frame = classifyFrame(JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
  assert.equal(frame.kind, FRAME_KIND.USAGE)
})

test('a usage frame with no choices key at all is a usage frame', () => {
  const frame = classifyFrame(JSON.stringify({ object: 'chat.completion.chunk', usage: { prompt_tokens: 1, completion_tokens: 1 } }))
  assert.equal(frame.kind, FRAME_KIND.USAGE)
})

test('an additive _fusion frame without choices is ignored, not fatal', () => {
  const frame = classifyFrame(JSON.stringify({ _fusion: { panel: ['a', 'b'], stage: 'panel' } }))
  assert.equal(frame.kind, FRAME_KIND.IGNORED)
})

test('a role-only preamble chunk is a chunk with an empty delta', () => {
  const frame = classifyFrame(JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }))
  assert.equal(frame.kind, FRAME_KIND.CHUNK)
  assert.deepEqual(frame.choices[0].delta, { role: 'assistant' })
})

test('a stream_error frame is an error frame with a message', () => {
  const frame = classifyFrame(JSON.stringify({ type: 'stream_error', error: { message: 'upstream reset', type: 'api_error' } }))
  assert.equal(frame.kind, FRAME_KIND.ERROR)
  assert.equal(frame.message, 'upstream reset')
  assert.equal(frame.code, 'api_error')
})

test('an error frame is detected through the error key alone', () => {
  const frame = classifyFrame(JSON.stringify({ error: { message: 'all providers failed', code: 'upstream_error' } }))
  assert.equal(frame.kind, FRAME_KIND.ERROR)
  assert.equal(frame.message, 'all providers failed')
  assert.equal(frame.code, 'upstream_error')
})

test('a bare string error is detected', () => {
  const frame = classifyFrame(JSON.stringify({ error: 'quota exhausted for every key' }))
  assert.equal(frame.kind, FRAME_KIND.ERROR)
  assert.equal(frame.message, 'quota exhausted for every key')
})

test('malformed JSON is tolerated and reported without throwing', () => {
  const frame = classifyFrame('{"choices": [')
  assert.equal(frame.kind, FRAME_KIND.MALFORMED)
  assert.equal(frame.raw, '{"choices": [')
})

test('a non-object JSON payload is ignored', () => {
  assert.equal(classifyFrame('42').kind, FRAME_KIND.IGNORED)
  assert.equal(classifyFrame('[]').kind, FRAME_KIND.IGNORED)
  assert.equal(classifyFrame('null').kind, FRAME_KIND.IGNORED)
})

test('a frame with neither choices nor usage is ignored', () => {
  assert.equal(classifyFrame(JSON.stringify({ object: 'chat.completion.chunk' })).kind, FRAME_KIND.IGNORED)
})
