/**
 * Mapping from DSH's `GenerateOptions` request vocabulary to the
 * OpenAI-compatible chat-completions wire used by a FreeLLMAPI gateway.
 *
 * Everything in this module is a pure function over plain objects, so the whole
 * mapping table is unit-testable with no network and no DSH runtime. The only
 * asynchronous part — reading attachment bytes for `image_url` parts — is
 * lifted into {@link collectImageParts}, which the adapter drives before the
 * pure mapping runs.
 *
 * Documented degradations (all deliberate, see `docs/SPEC.md` §6.6):
 * - `reasoning` history blocks are dropped (Chat Completions has no standard
 *   reasoning input field; folding them into `content` teaches models to imitate
 *   the format);
 * - `tool-addition` / `tool-removal` blocks never reach the wire — this adapter
 *   does not declare `toolUpdate`, so the runtime already strips them;
 * - `file` blocks never reach an adapter at all (projected to text by the
 *   runtime); a defensive text handle is emitted if one ever does;
 * - `GenerateOptions.seed` does not exist in the runtime (`docs/SPEC.md` §6.2),
 *   so it is not mapped.
 *
 * @module dsh-freellmapi/wire
 */

import { LlmError } from './runtime.js'

/** Fallback text for a tool result that carried no content. */
export const EMPTY_TOOL_OUTPUT = '(no tool output)'

/** Prefix that preserves `ToolResultMessage.isError` in a wire with no error bit. */
export const TOOL_ERROR_PREFIX = 'Error: '

/**
 * Placeholder used when an image attachment's bytes could not be read. Keeps the
 * request valid (and the failure visible to the model) instead of dropping the
 * occurrence silently.
 * @param {unknown} ref an `ImageAttachmentRef`-shaped value
 * @returns {string}
 */
export function imagePlaceholder(ref) {
  const raw = typeof ref === 'object' && ref !== null
    ? /** @type {Record<string, unknown>} */ (ref).attachmentId
    : undefined
  const id = typeof raw === 'string' && raw.length > 0 ? raw : 'unknown'
  const digest = id.startsWith('sha256:') ? id.slice('sha256:'.length, 'sha256:'.length + 8) : id.slice(0, 8)
  return `[image omitted: attachment sha256:${digest} could not be attached to this request]`
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Turn one `ImageBlock` into an OpenAI `image_url` part.
 * @param {Record<string, unknown>} block an `image` content block
 * @param {Map<string, string>} imageParts attachment id → `data:` URL
 * @returns {Record<string, unknown>} an `image_url` or `text` content part
 */
function imageBlockToPart(block, imageParts) {
  const ref = isRecord(block.attachment) ? block.attachment : undefined
  const attachmentId = typeof ref?.attachmentId === 'string' ? ref.attachmentId : undefined
  const resolved = attachmentId === undefined ? undefined : imageParts.get(attachmentId)
  if (typeof resolved === 'string' && resolved.length > 0) {
    return { type: 'image_url', image_url: { url: resolved } }
  }
  return { type: 'text', text: imagePlaceholder(ref) }
}

/** Collect the `ImageBlock`s of one message that have an attachment id. */
function imageRefsOf(content) {
  const refs = []
  if (!Array.isArray(content)) return refs
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'image') continue
    const ref = isRecord(block.attachment) ? block.attachment : undefined
    if (typeof ref?.attachmentId === 'string' && ref.attachmentId.length > 0) refs.push(ref)
  }
  return refs
}

/**
 * Resolve every image attachment referenced by a request into a `data:` URL.
 *
 * The adapter supplies `readImage`, which returns the URL or `undefined` when
 * the bytes are unavailable (no attachments service, unreadable path, encoding
 * failure). Failures degrade that single image to a text placeholder — they
 * never fail the request.
 *
 * @param {{messages?: readonly unknown[]}} options a `GenerateOptions`-shaped request
 * @param {(ref: Record<string, unknown>) => Promise<string | undefined>} readImage
 * @returns {Promise<Map<string, string>>} attachment id → data URL
 */
export async function collectImageParts(options, readImage) {
  const parts = new Map()
  const messages = Array.isArray(options?.messages) ? options.messages : []
  const refs = []
  for (const message of messages) {
    if (!isRecord(message)) continue
    for (const ref of imageRefsOf(message.content)) refs.push(ref)
  }
  for (const ref of refs) {
    const id = /** @type {string} */ (ref.attachmentId)
    if (parts.has(id)) continue
    let url
    try {
      url = await readImage(ref)
    } catch {
      url = undefined
    }
    if (typeof url === 'string' && url.length > 0) parts.set(id, url)
  }
  return parts
}

/**
 * Whether a message's content contains an `image` block. Used by the adapter to
 * decide whether an attachment lookup is worth doing.
 * @param {unknown} content
 * @returns {boolean}
 */
export function contentHasImage(content) {
  return imageRefsOf(content).length > 0
}

/** Join the text blocks of a content list; non-text blocks are ignored. */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * Convert a user-role content list to the wire form: a plain string when every
 * block is text (maximally compatible), otherwise an OpenAI content-parts array.
 */
function userContent(content, imageParts) {
  const blocks = Array.isArray(content) ? content : []
  const parts = []
  let sawNonText = false
  for (const block of blocks) {
    if (!isRecord(block)) continue
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') parts.push({ type: 'text', text: block.text })
        break
      case 'image':
        parts.push(imageBlockToPart(block, imageParts))
        sawNonText = true
        break
      case 'file': {
        // Unreachable in practice (the runtime projects files to text first).
        const ref = isRecord(block.attachment) ? block.attachment : undefined
        const id = typeof ref?.attachmentId === 'string' ? ref.attachmentId : 'unknown'
        parts.push({ type: 'text', text: `[file attachment ${id} is not readable through this provider]` })
        sawNonText = true
        break
      }
      default:
        // `tool-addition` / `tool-removal` are protocol declarations, never
        // user content; `reasoning` has no user-role equivalent.
        break
    }
  }
  if (!sawNonText) return parts.map((part) => part.text).join('\n')
  return parts
}

/**
 * Convert one assistant message: text becomes a plain string `content` (an
 * assistant `content` array is non-standard and some models echo the structure),
 * `tool-call` blocks become `tool_calls[]` with raw JSON argument strings.
 */
function assistantMessage(content) {
  const blocks = Array.isArray(content) ? content : []
  const texts = []
  const toolCalls = []
  for (const block of blocks) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text)
    } else if (block.type === 'tool-call') {
      const id = typeof block.id === 'string' ? block.id : ''
      const name = typeof block.name === 'string' ? block.name : ''
      const args = typeof block.arguments === 'string' ? block.arguments : ''
      toolCalls.push({
        id,
        type: 'function',
        function: { name, arguments: args.length === 0 ? '{}' : args },
      })
    }
    // `reasoning` is dropped on purpose; `tool-addition`/`tool-removal` never
    // arrive because this adapter declares no `toolUpdate` capability.
  }
  return {
    role: 'assistant',
    content: texts.join('\n'),
    ...toolCalls.length === 0 ? {} : { tool_calls: toolCalls },
  }
}

/** Convert one tool-result message; `isError` degrades into the text. */
function toolMessage(message) {
  const text = textOf(message.content)
  const body = text.length === 0 ? EMPTY_TOOL_OUTPUT : text
  const isError = message.isError === true
  const content = isError && !body.startsWith(TOOL_ERROR_PREFIX) ? `${TOOL_ERROR_PREFIX}${body}` : body
  return {
    role: 'tool',
    tool_call_id: typeof message.toolCallId === 'string' ? message.toolCallId : '',
    content,
  }
}

/**
 * Map `GenerateOptions.messages` (+ `system`) to the OpenAI `messages[]` array.
 *
 * System-prompt selection mirrors both shipped adapters: the *leading* system
 * history message supplies the prompt, `GenerateOptions.system` is concatenated
 * in front of it with a blank line between (`dsh-llm-deepseek`:
 * `[options.system, historySystem].filter(Boolean).join("\n\n")`), and later
 * system messages keep their position in the history.
 *
 * `developer` history messages (tool-change announcements) map to `system`,
 * which preserves their position and is accepted by every OpenAI-compatible
 * endpoint — the FreeLLMAPI gateway folds `developer` into `system` anyway.
 *
 * @param {{messages?: readonly unknown[], system?: string}} options
 * @param {{imageParts?: Map<string, string>}} [context]
 * @returns {Record<string, unknown>[]}
 */
export function toOpenAiMessages(options, context = {}) {
  const imageParts = context.imageParts ?? new Map()
  const messages = Array.isArray(options?.messages) ? options.messages : []
  const out = []

  const configured = typeof options?.system === 'string' ? options.system : undefined
  const leadingSystem = messages.length > 0 && isRecord(messages[0]) && messages[0].role === 'system'
    ? textOf(messages[0].content)
    : undefined
  const prompt = configured === undefined
    ? leadingSystem
    : leadingSystem === undefined || leadingSystem.length === 0
      ? configured
      : `${configured}\n\n${leadingSystem}`
  if (prompt !== undefined && prompt.length > 0) out.push({ role: 'system', content: prompt })

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (!isRecord(message)) continue
    const role = message.role
    if (role === 'system') {
      // The leading system message was already consumed into position 0.
      if (index === 0 && leadingSystem !== undefined) continue
      out.push({ role: 'system', content: textOf(message.content) })
      continue
    }
    if (role === 'developer') {
      out.push({ role: 'system', content: textOf(message.content) })
      continue
    }
    if (role === 'user') {
      out.push({ role: 'user', content: userContent(message.content, imageParts) })
      continue
    }
    if (role === 'assistant') {
      out.push(assistantMessage(message.content))
      continue
    }
    if (role === 'tool') {
      out.push(toolMessage(message))
    }
  }

  return out
}

/**
 * Map `GenerateOptions.tools` to the OpenAI `tools[]` array. `deferLoading` is
 * an adapter-side scheduling hint with no wire equivalent and is dropped.
 * @param {readonly Record<string, unknown>[] | undefined} tools
 * @returns {Record<string, unknown>[] | undefined}
 */
export function toOpenAiTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  const mapped = tools.flatMap((tool) => {
    if (!isRecord(tool)) return []
    const name = typeof tool.name === 'string' ? tool.name : ''
    if (name.length === 0) return []
    const description = typeof tool.description === 'string' ? tool.description : ''
    const parameters = isRecord(tool.parameters) ? tool.parameters : { type: 'object', properties: {} }
    return [{ type: 'function', function: { name, description, parameters } }]
  })
  return mapped.length === 0 ? undefined : mapped
}

/**
 * Build the complete JSON body for `POST {baseURL}/chat/completions`.
 *
 * The model string is passed through **verbatim**: `auto`, `auto:smart`,
 * `auto:<user profile>`, `fusion` and concrete catalog ids all reach the gateway
 * unchanged. This adapter never rewrites, normalises or omits it — that
 * pass-through is the whole point of Auto mode.
 *
 * @param {Record<string, any>} options a `GenerateOptions`-shaped request
 * @param {{maxTokensField?: string}} [config] resolved plugin config
 * @param {{imageParts?: Map<string, string>}} [context]
 * @returns {Record<string, unknown>} the request body
 */
export function buildChatRequest(options, config = {}, context = {}) {
  const maxTokensField = config.maxTokensField === 'max_completion_tokens'
    ? 'max_completion_tokens'
    : 'max_tokens'
  const body = {
    model: options?.model,
    messages: toOpenAiMessages(options, context),
    stream: true,
  }
  if (typeof options?.temperature === 'number' && Number.isFinite(options.temperature)) {
    body.temperature = options.temperature
  }
  if (typeof options?.maxTokens === 'number' && Number.isFinite(options.maxTokens) && options.maxTokens > 0) {
    body[maxTokensField] = options.maxTokens
  }
  if (Array.isArray(options?.stop) && options.stop.length > 0) {
    body.stop = [...options.stop]
  }
  // ★ `reasoning_effort` is sent ONLY when the operator has said the pool accepts
  // it (`config.forwardReasoningEffort`). Nothing in the pool's provenance mentions
  // this field, and an anonymous probe could not settle it — all four providers
  // rejected at auth/model resolution, before any field validation — so forwarding
  // it by default would push an unverified field at every provider, which is the
  // silently-degrading shape rule 1 forbids. The drop is reported, not hidden.
  if (suppressedReasoningEffort(options, config) === undefined
    && options?.reasoningEffort !== undefined && options.reasoningEffort !== null) {
    body.reasoning_effort = String(options.reasoningEffort)
  }
  const tools = toOpenAiTools(options?.tools)
  if (tools !== undefined) body.tools = tools
  return body
}

/**
 * The reasoning effort DSH asked for but this adapter will not forward, or
 * `undefined` when there is nothing to suppress.
 *
 * Exported so the routing decision can **report** the drop rather than let it
 * disappear: a request control that DSH believes it set, and that never reaches
 * a provider, is exactly the "silent degradation" this project treats as its most
 * expensive failure shape.
 *
 * @param {Record<string, any>} options `GenerateOptions`
 * @param {Record<string, any>} [config] normalised config
 * @returns {string | undefined}
 */
export function suppressedReasoningEffort(options, config) {
  const requested = options?.reasoningEffort
  if (requested === undefined || requested === null) return undefined
  if (config?.forwardReasoningEffort === true) return undefined
  return String(requested)
}

/**
 * Guard the one request control this adapter genuinely cannot honour.
 * `GenerateOptions` is deep-frozen, so nothing may be rewritten in place.
 * @param {Record<string, any>} options
 * @returns {void}
 * @throws {LlmError} `UNSUPPORTED_OPTION` for a stop value that is not a string
 */
export function assertSupportedOptions(options) {
  if (options?.stop === undefined || options.stop === null) return
  if (!Array.isArray(options.stop)) {
    throw new LlmError('dsh-freellmapi: GenerateOptions.stop must be an array of strings', 'UNSUPPORTED_OPTION')
  }
  for (const entry of options.stop) {
    if (typeof entry !== 'string') {
      throw new LlmError('dsh-freellmapi: GenerateOptions.stop must contain only strings', 'UNSUPPORTED_OPTION')
    }
  }
}
