/**
 * Heuristic request-complexity classifier.
 *
 * ## Why this is a separate, pure module
 *
 * The classifier is the judgement the whole smart router hangs on: it decides
 * whether a request goes to a small fast model or to the strongest one, so it has
 * to be *inspectable* (every signal and its weight are visible in the result),
 * *deterministic* (the same request must always be routed the same way) and
 * *total* (a malformed request must degrade to a tier, never to an exception
 * inside a stream).
 *
 * Everything here is therefore a pure function: no clock, no environment, no
 * randomness, no I/O, and no mutation of the caller's `options`.
 *
 * ## How the score is combined
 *
 * Each signal is normalised into `[0, 1]` by a saturating curve, multiplied by
 * its own weight, and the weighted contributions are combined with a
 * **noisy-OR**:
 *
 * ```
 * score = 1 - Π (1 - wᵢ · sᵢ) - simpleTaskPenalty
 * ```
 *
 * A weighted mean was tried first and rejected: it cannot express "several
 * independently demanding facets compound". A short prompt that carries twelve
 * tool schemas *and* asks for an architectural trade-off analysis is complex, but
 * its token count is tiny — under a mean, the strong signals get averaged away by
 * the weak ones. Noisy-OR lets each strong, independent facet push the score up
 * on its own while weak facets stay negligible, and it is still monotone in every
 * signal. `DEFAULT_WEIGHTS` therefore records each signal's **standalone maximum
 * contribution**, not a fraction of a total.
 *
 * `simple` task words (翻译 / translate / summarize / …) *subtract* a penalty,
 * which is the one place a signal can lower the score.
 *
 * @module dsh-freellmapi/complexity
 */

/** The three routing tiers, cheapest first. */
export const TIERS = Object.freeze(['simple', 'medium', 'complex'])

/** Default tier boundaries on the `[0, 1]` score. */
export const DEFAULT_THRESHOLDS = Object.freeze({ medium: 0.34, complex: 0.67 })

/**
 * Default per-signal maximum contribution.
 *
 * These are deliberately not normalised to sum to 1: see the noisy-OR note in the
 * module docstring. Every entry is the score this signal reaches **on its own**
 * when fully saturated.
 */
export const DEFAULT_WEIGHTS = Object.freeze({
  /** Estimated input tokens — the primary signal. */
  tokens: 0.46,
  /** Fenced code blocks: how much code the request is about. */
  code: 0.32,
  /** Tool schemas the model must follow instructions for. */
  tools: 0.52,
  /** Conversation depth (message count and assistant/tool turns). */
  depth: 0.2,
  /** Explicit complexity vocabulary (refactor / 架构 / …). */
  keywords: 0.6,
  /** Reasoning burden: notation, comparison, "step by step". */
  reasoning: 0.5,
  /** Image input (also carries a hard floor at the medium tier). */
  images: 0.06,
})

/** How much one saturated batch of `simple` task words subtracts. */
export const DEFAULT_SIMPLE_PENALTY = 0.22

/** Token count at which the token signal saturates. */
export const DEFAULT_TOKEN_SCALE = 2_500

/** Code lines at which the code signal's line component saturates. */
const CODE_LINE_SCALE = 120

/** Code blocks at which the code signal's block component saturates. */
const CODE_BLOCK_SCALE = 2

/** Tool count at which the tool signal saturates. */
const TOOL_SCALE = 8

/** Message count at which the depth signal's message component saturates. */
const MESSAGE_SCALE = 20

/** Assistant+tool turns at which the depth signal's turn component saturates. */
const TURN_SCALE = 6

/** Distinct keyword families that saturate the complexity vocabulary signal. */
const KEYWORD_SCALE = 2

/** Distinct math notation marks that saturate the notation component. */
const MATH_SCALE = 5

/** Distinct comparison markers that saturate the comparison component. */
const COMPARE_SCALE = 2

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Whether one code point belongs to a CJK-family script. CJK text is roughly one
 * token per character for the tokenizers these gateways use, whereas Latin text
 * is roughly one token per four characters.
 * @param {number} code
 * @returns {boolean}
 */
function isCjkCodePoint(code) {
  return (
    (code >= 0x1100 && code <= 0x11ff) // Hangul Jamo
    || (code >= 0x2e80 && code <= 0x2eff) // CJK Radicals Supplement
    || (code >= 0x3000 && code <= 0x303f) // CJK Symbols and Punctuation
    || (code >= 0x3040 && code <= 0x309f) // Hiragana
    || (code >= 0x30a0 && code <= 0x30ff) // Katakana
    || (code >= 0x3100 && code <= 0x312f) // Bopomofo
    || (code >= 0x3130 && code <= 0x318f) // Hangul Compatibility Jamo
    || (code >= 0x31c0 && code <= 0x31ef) // CJK Strokes
    || (code >= 0x3200 && code <= 0x32ff) // Enclosed CJK Letters and Months
    || (code >= 0x3400 && code <= 0x4dbf) // CJK Unified Ideographs Extension A
    || (code >= 0x4e00 && code <= 0x9fff) // CJK Unified Ideographs
    || (code >= 0xa960 && code <= 0xa97f) // Hangul Jamo Extended-A
    || (code >= 0xac00 && code <= 0xd7af) // Hangul Syllables
    || (code >= 0xf900 && code <= 0xfaff) // CJK Compatibility Ideographs
    || (code >= 0xfe30 && code <= 0xfe4f) // CJK Compatibility Forms
    || (code >= 0xff00 && code <= 0xffef) // Halfwidth and Fullwidth Forms
    || (code >= 0x20000 && code <= 0x2fa1f) // CJK Unified Ideographs Extension B+
  )
}

/**
 * Estimate the token count of one string.
 *
 * CJK characters count as roughly one token each; everything else as roughly one
 * token per four characters. The estimate is intentionally crude — it only has to
 * order requests by size, and it must never touch a network or a tokenizer.
 *
 * @param {unknown} text any value; non-strings estimate to 0
 * @returns {number} a non-negative integer
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let cjk = 0
  let other = 0
  for (const character of text) {
    if (isCjkCodePoint(character.codePointAt(0))) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 4)
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Substrings (matched case-insensitively) that mark an unusually demanding task. */
const COMPLEX_TERMS = Object.freeze([
  // Chinese
  '重构', '架构', '设计', '证明', '分析', '优化', '调试', '实现', '为什么', '推导',
  '迁移', '排查', '抽象', '泛化', '并发', '性能', '兼容', '失败模式', '边界条件',
  // English
  'refactor', 'architect', 'architecture', 'prove', 'proof', 'analyze', 'analyse',
  'analysis', 'optimize', 'optimise', 'debug', 'implement', 'implementation',
  'design', 'why', 'derive', 'derivation', 'migrate', 'migration', 'concurrency',
  'performance', 'security', 'compatibility', 'failure mode', 'edge case',
])

/** Substrings that mark a mechanical, low-reasoning task. */
const SIMPLE_TERMS = Object.freeze([
  // Chinese
  '翻译', '改写', '总结', '列出', '列举', '格式化', '摘要', '概括', '润色', '复述', '拼写',
  // English
  'translate', 'translation', 'rewrite', 'summarize', 'summarise', 'summary',
  'list', 'format', 'rephrase', 'paraphrase',
])

/** Substrings that ask for explicit reasoning or comparison. */
const COMPARE_TERMS = Object.freeze([
  '对比', '比较', '权衡', '取舍', '优劣', '优缺点',
  'versus', 'trade-off', 'tradeoff', 'compare', 'comparison', 'pros and cons',
])

/** Substrings that demand a step-by-step derivation. */
const STEP_TERMS = Object.freeze([
  '逐步', '一步一步', '一步步', '分步', '详细步骤', '推理过程', '思考过程',
  'step by step', 'step-by-step', 'chain of thought', 'chain-of-thought', 'reasoning steps',
])

/**
 * Compile a word-boundary matcher for the ASCII terms of a vocabulary.
 *
 * Non-global regexes keep no `lastIndex`, so a shared instance stays stateless
 * and the classifier remains deterministic.
 */
function compileAsciiMatcher(terms) {
  const ascii = terms.filter((term) => /^[\x20-\x7e]+$/.test(term))
  if (ascii.length === 0) return null
  const escaped = ascii.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`(?<![a-z0-9])(?:${escaped.join('|')})(?![a-z0-9])`, 'i')
}

const COMPLEX_ASCII = compileAsciiMatcher(COMPLEX_TERMS)
const SIMPLE_ASCII = compileAsciiMatcher(SIMPLE_TERMS)
const COMPARE_ASCII = compileAsciiMatcher(COMPARE_TERMS)
const STEP_ASCII = compileAsciiMatcher(STEP_TERMS)

/**
 * Count how many distinct terms of a vocabulary appear in one prose string.
 * @param {string} lower lower-cased haystack
 * @param {readonly string[]} terms the vocabulary
 * @param {RegExp | null} ascii matcher for the ASCII subset
 * @returns {number} the number of distinct terms found
 */
function countTermFamilies(lower, terms, ascii) {
  let hits = 0
  for (const term of terms) {
    if (/^[\x20-\x7e]+$/.test(term)) continue
    if (lower.includes(term)) hits += 1
  }
  if (ascii !== null) {
    const matches = lower.match(new RegExp(ascii.source, 'gi'))
    if (matches !== null) {
      const seen = new Set(matches.map((match) => match.toLowerCase().trim()))
      hits += seen.size
    }
  }
  return hits
}

/** Notation that marks a quantitative or mathematical request. */
const MATH_MARK_SOURCE = '[∑∫∏√±×÷≤≥≠≈≡∞∂∇∆πθαβγλμσΩ^]|<=|>=|!=|==|~='

/** A fresh matcher per call: a shared global regex would carry `lastIndex` state. */
function matchMathMarks(prose) {
  return prose.match(new RegExp(MATH_MARK_SOURCE, 'g'))
}

// ---------------------------------------------------------------------------
// Field readers (total: any shape must yield a number, never a throw)
// ---------------------------------------------------------------------------

/** @param {unknown} value @returns {Record<string, any> | null} */
function asObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : null
}

/** @param {unknown} value @returns {readonly unknown[]} */
function asArray(value) {
  return Array.isArray(value) ? value : []
}

/**
 * Collect the plain text of one message's content.
 *
 * DSH contract content is a `ContentBlock[]`; a bare string is out-of-contract but
 * has to be tolerated rather than thrown on. `tool-call` arguments count as text
 * (they are the model's own words, and a long tool payload is real complexity).
 *
 * @param {unknown} content
 * @param {{text: string[], prose: string, images: number, toolArguments: number}} sink
 */
function collectContent(content, sink) {
  if (typeof content === 'string') {
    sink.text.push(content)
    sink.prose += `\n${content}`
    return
  }
  for (const block of asArray(content)) {
    const record = asObject(block)
    if (record === null) continue
    switch (record.type) {
      case 'text':
        if (typeof record.text === 'string') {
          sink.text.push(record.text)
          sink.prose += `\n${record.text}`
        }
        break
      case 'reasoning':
        // Reasoning is historical model output: it is real input tokens but it is
        // not the user asking for something, so it never feeds the vocabulary.
        if (typeof record.text === 'string') sink.text.push(record.text)
        break
      case 'tool-call':
        if (typeof record.arguments === 'string') {
          sink.text.push(record.arguments)
          sink.toolArguments += 1
        }
        if (typeof record.name === 'string') sink.text.push(record.name)
        break
      case 'image':
        sink.images += 1
        break
      case 'file':
        sink.text.push('[file attachment]')
        break
      case 'tool-addition':
      case 'tool-removal':
        if (typeof record.toolName === 'string') sink.text.push(record.toolName)
        break
      default:
        break
    }
  }
}

/**
 * Split a body of text into prose and fenced code.
 *
 * Keywords and math notation are only meaningful in prose: `design` inside a code
 * sample and `=` inside an assignment are not the user's intent. Counting them
 * would make "explain these 200 lines" look like a maths proof.
 *
 * @param {string} text
 * @returns {{prose: string, codeBlocks: number, codeLines: number}}
 */
function splitFences(text) {
  const prose = []
  let codeBlocks = 0
  let codeLines = 0
  let inside = false
  const lines = text.split('\n')
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (inside) inside = false
      else {
        inside = true
        codeBlocks += 1
      }
      continue
    }
    if (inside) codeLines += 1
    else prose.push(line)
  }
  return { prose: prose.join('\n'), codeBlocks, codeLines }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Clamp into `[0, 1]`. */
function clamp01(value) {
  if (!Number.isFinite(value)) return 0
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

/** Saturating normalisation: `min(1, value / scale)`. */
function saturate(value, scale) {
  if (!Number.isFinite(value) || value <= 0) return 0
  if (!Number.isFinite(scale) || scale <= 0) return 0
  return value >= scale ? 1 : value / scale
}

/**
 * Read one weight, falling back to the default for anything unusable.
 * @param {Record<string, any> | null} weights
 * @param {string} key
 * @returns {number}
 */
function readWeight(weights, key) {
  const raw = weights === null ? undefined : weights[key]
  const value = typeof raw === 'number' ? raw : Number.NaN
  if (!Number.isFinite(value) || value < 0 || value >= 1) return DEFAULT_WEIGHTS[key]
  return value
}

/**
 * Read one threshold, falling back to the default for anything unusable.
 * @param {unknown} raw
 * @param {number} fallback
 * @returns {number}
 */
function readThreshold(raw, fallback) {
  const value = typeof raw === 'number' ? raw : Number.NaN
  if (!Number.isFinite(value) || value <= 0 || value >= 1) return fallback
  return value
}

/**
 * Score one model request.
 *
 * Pure and total: it never reads a clock, an environment variable or the
 * filesystem, never draws a random number, never mutates `options`, and never
 * throws — an unreadable request simply scores as `simple`.
 *
 * @param {unknown} options a `GenerateOptions` subset: `{ messages?, system?, tools? }`
 * @param {unknown} [config] optional overrides: `{ thresholds?, weights?, tokenScale?, simplePenalty? }`
 * @returns {{
 *   tier: 'simple' | 'medium' | 'complex',
 *   score: number,
 *   tokens: number,
 *   signals: Record<string, number>,
 *   reasons: string[],
 * }} the verdict, its score, and every signal that produced it
 */
export function scoreComplexity(options, config = {}) {
  const settings = asObject(config) ?? {}
  const thresholdsRaw = asObject(settings.thresholds) ?? settings
  const mediumCandidate = readThreshold(thresholdsRaw.medium, DEFAULT_THRESHOLDS.medium)
  const complexCandidate = readThreshold(thresholdsRaw.complex, DEFAULT_THRESHOLDS.complex)
  // A complex boundary at or below the medium boundary would make a whole tier
  // unreachable, so an inconsistent pair is rejected as a unit rather than
  // half-applied.
  const thresholdsUsable = complexCandidate > mediumCandidate
  const mediumThreshold = thresholdsUsable ? mediumCandidate : DEFAULT_THRESHOLDS.medium
  const complexThreshold = thresholdsUsable ? complexCandidate : DEFAULT_THRESHOLDS.complex

  const weightsRaw = asObject(settings.weights)
  const weight = (key) => readWeight(weightsRaw, key)
  const tokenScale = typeof settings.tokenScale === 'number' && Number.isFinite(settings.tokenScale) && settings.tokenScale > 0
    ? settings.tokenScale
    : DEFAULT_TOKEN_SCALE
  const simplePenalty = typeof settings.simplePenalty === 'number' && Number.isFinite(settings.simplePenalty) && settings.simplePenalty >= 0
    ? settings.simplePenalty
    : DEFAULT_SIMPLE_PENALTY

  const source = asObject(options) ?? {}
  const messages = asArray(source.messages)
  const tools = asArray(source.tools)

  /** @type {{text: string[], prose: string, images: number, toolArguments: number}} */
  const sink = { text: [], prose: '', images: 0, toolArguments: 0 }
  if (typeof source.system === 'string') {
    sink.text.push(source.system)
    sink.prose += `\n${source.system}`
  }
  let assistantTurns = 0
  let toolTurns = 0
  for (const message of messages) {
    const record = asObject(message)
    if (record === null) continue
    if (record.role === 'assistant') assistantTurns += 1
    else if (record.role === 'tool') toolTurns += 1
    collectContent(record.content, sink)
  }

  const joined = sink.text.join('\n')
  const tokens = estimateTokens(joined)
  // Only the user-facing prose is scanned for vocabulary, math notation and
  // fences: replayed reasoning and tool-call payloads are real input tokens, but
  // a `design` that the model itself wrote is not the user asking to design.
  const { prose, codeBlocks, codeLines } = splitFences(sink.prose)
  const lowerProse = prose.toLowerCase()

  const complexKeywords = countTermFamilies(lowerProse, COMPLEX_TERMS, COMPLEX_ASCII)
  const simpleKeywords = countTermFamilies(lowerProse, SIMPLE_TERMS, SIMPLE_ASCII)
  const compareMarkers = countTermFamilies(lowerProse, COMPARE_TERMS, COMPARE_ASCII)
  const stepTerms = countTermFamilies(lowerProse, STEP_TERMS, STEP_ASCII)
  const mathMatches = matchMathMarks(prose)
  const mathSymbols = mathMatches === null ? 0 : mathMatches.length
  const stepByStep = stepTerms > 0 ? 1 : 0

  // --- normalised signal values -------------------------------------------
  const tokensScore = saturate(tokens, tokenScale)
  const codeScore = 0.4 * saturate(codeBlocks, CODE_BLOCK_SCALE) + 0.6 * saturate(codeLines, CODE_LINE_SCALE)
  const toolsScore = saturate(tools.length, TOOL_SCALE)
  const depthScore = 0.5 * saturate(messages.length, MESSAGE_SCALE)
    + 0.5 * saturate(assistantTurns + toolTurns, TURN_SCALE)
  const keywordScore = saturate(complexKeywords, KEYWORD_SCALE) - saturate(simpleKeywords, KEYWORD_SCALE)
  const reasoningScore = 0.25 * saturate(mathSymbols, MATH_SCALE)
    + 0.25 * saturate(compareMarkers, COMPARE_SCALE)
    + 0.5 * stepByStep
  const imageScore = saturate(sink.images, 2)

  // --- noisy-OR combination ------------------------------------------------
  const contributions = [
    weight('tokens') * tokensScore,
    weight('code') * codeScore,
    weight('tools') * toolsScore,
    weight('depth') * depthScore,
    weight('keywords') * Math.max(0, keywordScore),
    weight('reasoning') * reasoningScore,
    weight('images') * imageScore,
  ]
  let score = 1
  for (const contribution of contributions) score *= 1 - clamp01(contribution)
  score = 1 - score
  score -= simplePenalty * saturate(simpleKeywords, KEYWORD_SCALE)
  score = clamp01(score)

  // An image has to reach a vision-capable model, so it can never route as
  // `simple`. Expressing the rule as a score floor (rather than a post-hoc tier
  // override) keeps `tier` a pure function of `score` and keeps the property
  // monotone.
  let imageFloorApplied = false
  if (sink.images > 0 && score < mediumThreshold) {
    score = mediumThreshold
    imageFloorApplied = true
  }

  const tier = score >= complexThreshold ? 'complex' : score >= mediumThreshold ? 'medium' : 'simple'

  // --- explanations --------------------------------------------------------
  const reasons = []
  if (tokens > 0) reasons.push(`${tokens} estimated input tokens`)
  if (tools.length > 0) reasons.push(`${tools.length} tool schemas`)
  if (codeBlocks > 0) reasons.push(`${codeBlocks} fenced code blocks (${codeLines} lines)`)
  if (messages.length >= 4) reasons.push(`deep conversation (${messages.length} messages)`)
  if (complexKeywords > 0) reasons.push(`${complexKeywords} complexity keywords`)
  if (simpleKeywords > 0) reasons.push(`${simpleKeywords} simple-task keywords (lowers the score)`)
  if (mathSymbols > 0) reasons.push(`${mathSymbols} math notation marks`)
  if (compareMarkers > 0) reasons.push(`${compareMarkers} comparison markers`)
  if (stepByStep === 1) reasons.push('step-by-step reasoning requested')
  if (sink.images > 0) reasons.push(`${sink.images} image input(s)`)
  if (sink.toolArguments > 0) reasons.push(`${sink.toolArguments} replayed tool call(s)`)
  if (imageFloorApplied) reasons.push('image input requires a vision-capable model (at least medium)')
  if (reasons.length === 0) reasons.push('empty request')

  return {
    tier,
    score,
    tokens,
    signals: {
      // raw measures
      tokens,
      codeBlocks,
      codeLines,
      tools: tools.length,
      messages: messages.length,
      turns: assistantTurns + toolTurns,
      complexKeywords,
      simpleKeywords,
      mathSymbols,
      compareMarkers,
      stepByStep,
      images: sink.images,
      // normalised contributions (what the score is actually made of)
      tokensScore,
      codeScore,
      toolsScore,
      depthScore,
      keywordScore,
      reasoningScore,
      imageScore,
    },
    reasons,
  }
}
