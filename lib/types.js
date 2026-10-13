/**
 * Type vocabulary shared by this plugin's modules.
 *
 * There is nothing to execute here: the file exists so the JSDoc references in
 * the other modules resolve for editors and for anyone reading the source. The
 * declarations mirror the authoritative runtime types quoted in `docs/SPEC.md`
 * §3.1 and §5.1 — they are documentation, not a validation layer.
 *
 * @module dsh-freellmapi/types
 */

/**
 * @typedef {object} TextBlock
 * @property {'text'} type
 * @property {string} text
 */

/**
 * @typedef {object} ReasoningBlock
 * @property {'reasoning'} type
 * @property {string} text
 */

/**
 * @typedef {object} ToolCallBlock
 * @property {'tool-call'} type
 * @property {string} id
 * @property {string} name
 * @property {string} arguments raw JSON string
 */

/**
 * @typedef {object} TokenUsage
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} [totalTokens]
 * @property {number} [cacheReadTokens]
 * @property {number} [cacheWriteTokens]
 * @property {number} [reasoningTokens]
 */

/**
 * @typedef {object} LlmFailure
 * @property {string} message
 * @property {string} code
 * @property {number} [status]
 * @property {number} [providerRetryAfterMs]
 */

/**
 * @typedef {object} FinishReason
 * @property {'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error'} kind
 * @property {LlmFailure} [failure] present for `aborted` and `error`
 */

/**
 * The DSH stream vocabulary consumed by `BlockAssembler`.
 * @typedef {object} StreamChunkOut
 * @property {string} type one of block-start | text-delta | reasoning-delta | tool-call-delta | block-end | usage | finish
 * @property {number} [index]
 * @property {string} [blockType]
 * @property {string} [text]
 * @property {string} [id]
 * @property {string} [name]
 * @property {string} [argumentsDelta]
 * @property {TextBlock | ReasoningBlock | ToolCallBlock} [block]
 * @property {TokenUsage} [usage]
 * @property {FinishReason} [reason]
 */

/**
 * One entry of the plugin's configurable-provider directory.
 * @typedef {object} LlmConfigurableProvider
 * @property {string} provider
 * @property {string} displayName
 * @property {string} settingsNs
 * @property {readonly string[]} settingsPath
 * @property {boolean} [declared]
 * @property {string} [error]
 */

/**
 * One model advertised by `listModels()`.
 * @typedef {object} LlmModelInfo
 * @property {string} provider
 * @property {string} id
 * @property {string} name
 * @property {string} [description]
 * @property {readonly ('text' | 'image')[]} [inputModalities]
 */

export {}
