/**
 * `GenerateOptions` → OpenAI chat-completions wire mapping tests.
 *
 * All pure: the attachment-reading half is exercised through an injected
 * `imageParts` map, so nothing here touches a filesystem or a socket.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EMPTY_TOOL_OUTPUT,
  TOOL_ERROR_PREFIX,
  buildChatRequest,
  collectImageParts,
  contentHasImage,
  imagePlaceholder,
  toOpenAiMessages,
  toOpenAiTools,
} from '../lib/wire.js'

const user = (content) => ({ role: 'user', content })
const assistant = (content) => ({ role: 'assistant', content })
const toolResult = (extra) => ({ role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'sunny' }], ...extra })

test('GenerateOptions.system becomes the leading system message', () => {
  const messages = toOpenAiMessages({ system: 'be brief', messages: [user([{ type: 'text', text: 'hi' }])] })
  assert.deepEqual(messages, [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hi' },
  ])
})

test('a leading system history message is the prompt when system is absent', () => {
  const messages = toOpenAiMessages({
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'from history' }] },
      user([{ type: 'text', text: 'hi' }]),
    ],
  })
  assert.deepEqual(messages[0], { role: 'system', content: 'from history' })
})

test('system and a leading system message are concatenated, not duplicated', () => {
  const messages = toOpenAiMessages({
    system: 'configured',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'history' }] },
      user([{ type: 'text', text: 'hi' }]),
    ],
  })
  assert.deepEqual(messages[0], { role: 'system', content: 'configured\n\nhistory' })
  assert.equal(messages.filter((message) => message.role === 'system').length, 1)
})

test('a non-leading system message keeps its position', () => {
  const messages = toOpenAiMessages({
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'first' }] },
      user([{ type: 'text', text: 'hi' }]),
      { role: 'system', content: [{ type: 'text', text: 'update' }] },
    ],
  })
  assert.deepEqual(messages.map((message) => message.role), ['system', 'user', 'system'])
})

test('a developer message maps to system in place', () => {
  const messages = toOpenAiMessages({
    messages: [
      user([{ type: 'text', text: 'hi' }]),
      { role: 'developer', content: [{ type: 'text', text: 'tool added: lookup' }] },
      user([{ type: 'text', text: 'go' }]),
    ],
  })
  assert.deepEqual(messages.map((message) => message.role), ['user', 'system', 'user'])
  assert.equal(messages[1].content, 'tool added: lookup')
})

test('a pure-text user message degrades to a plain string', () => {
  const messages = toOpenAiMessages({ messages: [user([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])] })
  assert.equal(messages[0].content, 'a\nb')
})

test('a user message with an image becomes a content-parts array', () => {
  const ref = { attachmentId: 'sha256:abc12345', mediaType: 'image/png', bytes: 10, width: 1, height: 1 }
  const parts = new Map([['sha256:abc12345', 'data:image/png;base64,AAAA']])
  const messages = toOpenAiMessages({
    messages: [user([{ type: 'text', text: 'what is this?' }, { type: 'image', attachment: ref }])],
  }, { imageParts: parts })
  assert.deepEqual(messages[0].content, [
    { type: 'text', text: 'what is this?' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
  ])
})

test('an image whose bytes could not be read degrades to a text placeholder', () => {
  const ref = { attachmentId: 'sha256:deadbeef00', mediaType: 'image/png' }
  const messages = toOpenAiMessages({ messages: [user([{ type: 'image', attachment: ref }])] }, { imageParts: new Map() })
  assert.equal(messages[0].content[0].type, 'text')
  assert.match(messages[0].content[0].text, /^\[image omitted: attachment sha256:deadbeef could not be attached to this request\]$/)
  assert.equal(imagePlaceholder(ref), '[image omitted: attachment sha256:deadbeef could not be attached to this request]')
})

test('an assistant message sends a string content and raw tool-call arguments', () => {
  const messages = toOpenAiMessages({
    messages: [assistant([
      { type: 'reasoning', text: 'hidden' },
      { type: 'text', text: 'checking' },
      { type: 'tool-call', id: 'call_1', name: 'get_weather', arguments: '{"city":"Beijing"}' },
    ])],
  })
  assert.equal(messages[0].content, 'checking')
  assert.deepEqual(messages[0].tool_calls, [
    { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Beijing"}' } },
  ])
})

test('an assistant message with only tool calls gets an empty string content', () => {
  const messages = toOpenAiMessages({
    messages: [assistant([{ type: 'tool-call', id: 'c', name: 'n', arguments: '{}' }])],
  })
  assert.equal(messages[0].content, '')
  assert.equal(messages[0].tool_calls.length, 1)
})

test('an assistant tool call with empty arguments is sent as {}', () => {
  const messages = toOpenAiMessages({ messages: [assistant([{ type: 'tool-call', id: 'c', name: 'n', arguments: '' }])] })
  assert.equal(messages[0].tool_calls[0].function.arguments, '{}')
})

test('a tool result maps tool_call_id and joins its text blocks', () => {
  const messages = toOpenAiMessages({
    messages: [{ role: 'tool', toolCallId: 'call_7', content: [{ type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }] }],
  })
  assert.deepEqual(messages[0], { role: 'tool', tool_call_id: 'call_7', content: 'line1\nline2' })
})

test('an empty tool result gets a placeholder and an error result is marked in the text', () => {
  const empty = toOpenAiMessages({ messages: [{ role: 'tool', toolCallId: 'c', content: [] }] })
  assert.equal(empty[0].content, EMPTY_TOOL_OUTPUT)
  const failed = toOpenAiMessages({ messages: [toolResult({ isError: true })] })
  assert.equal(failed[0].content, `${TOOL_ERROR_PREFIX}sunny`)
})

test('tool-addition and tool-removal blocks never reach the wire', () => {
  const messages = toOpenAiMessages({
    messages: [
      assistant([{ type: 'text', text: 'ok' }, { type: 'tool-addition', toolName: 'lookup' }, { type: 'tool-removal', toolName: 'old' }]),
    ],
  })
  assert.equal(messages[0].content, 'ok')
  assert.equal(messages[0].tool_calls, undefined)
})

test('tools map to function declarations with a JSON-Schema object', () => {
  const tools = toOpenAiTools([
    { name: 'get_weather', description: 'get it', parameters: { type: 'object', properties: { city: { type: 'string' } } }, deferLoading: true },
  ])
  assert.deepEqual(tools, [{
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'get it',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
    },
  }])
  assert.equal(toOpenAiTools([]), undefined)
  assert.equal(toOpenAiTools(undefined), undefined)
})

test('buildChatRequest passes the model through verbatim and always streams', () => {
  const body = buildChatRequest({ model: 'auto:fast', messages: [user([{ type: 'text', text: 'hi' }])] }, {})
  assert.equal(body.model, 'auto:fast')
  assert.equal(body.stream, true)
  assert.equal(body.max_tokens, undefined)
  assert.equal(body.temperature, undefined)
  assert.equal(body.stream_options, undefined)
})

test('buildChatRequest honours the maxTokensField switch', () => {
  const withDefault = buildChatRequest({ model: 'auto', messages: [], maxTokens: 128 }, {})
  assert.equal(withDefault.max_tokens, 128)
  const withCompletion = buildChatRequest({ model: 'auto', messages: [], maxTokens: 128 }, { maxTokensField: 'max_completion_tokens' })
  assert.equal(withCompletion.max_completion_tokens, 128)
  assert.equal(withCompletion.max_tokens, undefined)
})

test('buildChatRequest forwards temperature, stop and reasoning effort', () => {
  const body = buildChatRequest({
    model: 'auto',
    messages: [],
    temperature: 0.2,
    stop: ['\n\n'],
    reasoningEffort: 'high',
    tools: [{ name: 't', description: '', parameters: {} }],
  }, {})
  assert.equal(body.temperature, 0.2)
  assert.deepEqual(body.stop, ['\n\n'])
  assert.equal(body.reasoning_effort, 'high')
  assert.equal(body.tools.length, 1)
})

test('contentHasImage only reports image blocks', () => {
  assert.equal(contentHasImage([{ type: 'text', text: 'x' }]), false)
  assert.equal(contentHasImage([{ type: 'image', attachment: { attachmentId: 'a' } }]), true)
  assert.equal(contentHasImage(undefined), false)
})

test('collectImageParts resolves each attachment once and survives a reader failure', async () => {
  const ref = { attachmentId: 'a1', mediaType: 'image/png' }
  const calls = []
  const parts = await collectImageParts({
    messages: [
      { role: 'user', content: [{ type: 'image', attachment: ref }, { type: 'image', attachment: ref }] },
      { role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a2' } }] },
    ],
  }, async (candidate) => {
    calls.push(candidate.attachmentId)
    if (candidate.attachmentId === 'a2') throw new Error('unreadable')
    return 'data:image/png;base64,AAAA'
  })
  assert.deepEqual(calls, ['a1', 'a2'])
  assert.equal(parts.size, 1)
  assert.equal(parts.get('a1'), 'data:image/png;base64,AAAA')
})
