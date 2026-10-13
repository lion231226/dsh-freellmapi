/**
 * SSE framing tests.
 *
 * The decoder sees `fetch()` body fragments, so every case here is about the
 * byte-level boundaries a real gateway produces: CRLF, a half line split across
 * two TCP writes, a keep-alive comment, a multi-line `data:`, a final line with
 * no terminator, and a malformed payload that must not poison the next event.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { SseDecoder, decodeSse, decodeSseBody } from '../lib/sse.js'

test('decodes a plain data event', () => {
  const decoder = new SseDecoder()
  const events = decoder.push('data: {"a":1}\n\n')
  assert.deepEqual(events, [{ data: '{"a":1}', event: '', id: '' }])
})

test('decodes several events from one fragment', () => {
  const decoder = new SseDecoder()
  const events = decoder.push('data: one\n\ndata: two\n\ndata: three\n\n')
  assert.deepEqual(events.map((event) => event.data), ['one', 'two', 'three'])
})

test('accepts CRLF line endings', () => {
  const decoder = new SseDecoder()
  const events = decoder.push('data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\n')
  assert.deepEqual(events.map((event) => event.data), ['{"a":1}', '{"b":2}'])
})

test('reassembles a line split across fragments', () => {
  const decoder = new SseDecoder()
  assert.deepEqual(decoder.push('da'), [])
  assert.deepEqual(decoder.push('ta: {"hel'), [])
  assert.deepEqual(decoder.push('lo": true}\n'), [])
  const events = decoder.push('\n')
  assert.deepEqual(events, [{ data: '{"hello": true}', event: '', id: '' }])
})

test('reassembles an event split in the middle of its blank line', () => {
  const decoder = new SseDecoder()
  assert.deepEqual(decoder.push('data: x\n'), [])
  assert.deepEqual(decoder.push('\n'), [{ data: 'x', event: '', id: '' }])
  assert.deepEqual(decoder.push('data: y\r'), [])
  assert.deepEqual(decoder.push('\n\r\n'), [{ data: 'y', event: '', id: '' }])
})

test('ignores keep-alive comment lines', () => {
  const decoder = new SseDecoder()
  const events = decoder.push(': ping\n\n: keep-alive\n\ndata: real\n\n')
  assert.deepEqual(events.map((event) => event.data), ['real'])
})

test('does not dispatch an event for comments alone', () => {
  const decoder = new SseDecoder()
  assert.deepEqual(decoder.push(':\n\n'), [])
  assert.deepEqual(decoder.end(), [])
})

test('joins multi-line data with a newline and strips exactly one leading space', () => {
  const decoder = new SseDecoder()
  const events = decoder.push('data: line1\ndata:  line2\ndata:line3\n\n')
  assert.equal(events[0].data, 'line1\n line2\nline3')
})

test('captures the event name and ignores unknown fields', () => {
  const decoder = new SseDecoder()
  const events = decoder.push('event: message\nfoo: bar\nretry: 2500\ndata: {"a":1}\n\n')
  assert.equal(events[0].event, 'message')
  assert.equal(events[0].retry, 2500)
  assert.equal(events[0].data, '{"a":1}')
})

test('keeps the last event id (sticky, per the SSE spec)', () => {
  const decoder = new SseDecoder()
  const events = decoder.push('id: 7\ndata: a\n\ndata: b\n\n')
  assert.equal(events[0].id, '7')
  assert.equal(events[1].id, '7')
})

test('flushes a final event with no trailing blank line', () => {
  const decoder = new SseDecoder()
  assert.deepEqual(decoder.push('data: [DONE]'), [])
  assert.deepEqual(decoder.end(), [{ data: '[DONE]', event: '', id: '' }])
})

test('flushes a trailing line with no newline at all', () => {
  const decoder = new SseDecoder()
  assert.deepEqual(decoder.push('data: partial'), [])
  assert.deepEqual(decoder.end().map((event) => event.data), ['partial'])
})

test('end() is idempotent', () => {
  const decoder = new SseDecoder()
  decoder.push('data: x\n\n')
  assert.equal(decoder.end().length, 0)
  assert.equal(decoder.end().length, 0)
})

test('a malformed payload does not affect the next event', () => {
  const decoder = new SseDecoder()
  const events = decoder.push('data: {"broken\n\ndata: {"ok":1}\n\n')
  assert.equal(events.length, 2)
  assert.equal(events[0].data, '{"broken')
  assert.equal(events[1].data, '{"ok":1}')
})

test('decodeSse yields every event from an async fragment source', async () => {
  async function* fragments() {
    yield 'data: a\n'
    yield '\ndata: b\n\ndata: [DONE]\n\n'
  }
  const seen = []
  for await (const event of decodeSse(fragments())) seen.push(event.data)
  assert.deepEqual(seen, ['a', 'b', '[DONE]'])
})

test('decodeSseBody reassembles UTF-8 split across byte boundaries', async () => {
  const payload = 'data: {"text":"中文测试"}\n\n'
  const bytes = new TextEncoder().encode(payload)
  // Split inside a multi-byte code point to prove the stream decoder is used.
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, 14))
      controller.enqueue(bytes.slice(14, 21))
      controller.enqueue(bytes.slice(21))
      controller.close()
    },
  })
  const seen = []
  for await (const event of decodeSseBody(body)) seen.push(event.data)
  assert.deepEqual(seen, ['{"text":"中文测试"}'])
})

test('decodeSseBody tolerates a missing body', async () => {
  const seen = []
  for await (const event of decodeSseBody(undefined)) seen.push(event)
  assert.deepEqual(seen, [])
})
