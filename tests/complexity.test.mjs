/**
 * Complexity classifier tests.
 *
 * The classifier decides which model tier a request routes to, so these tests are
 * about *properties* rather than golden numbers: determinism, totality (no input
 * shape may throw), monotonicity in each single variable, and a handful of
 * realistic requests landing in the tier a human would pick.
 *
 * Fully offline: no network, no filesystem, no clock.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_SIMPLE_PENALTY,
  DEFAULT_THRESHOLDS,
  DEFAULT_TOKEN_SCALE,
  DEFAULT_WEIGHTS,
  TIERS,
  estimateTokens,
  scoreComplexity,
} from '../lib/complexity.js'

// ---------------------------------------------------------------------------
// builders
// ---------------------------------------------------------------------------

/** One user message carrying plain text. */
const userText = (text) => ({ role: 'user', content: [{ type: 'text', text }] })

/** A well-formed fenced code block with `lines` lines. */
const fence = (lines, language = 'js') => {
  const body = Array.from({ length: lines }, (_, index) => `  const value${index} = compute(${index});`).join('\n')
  return `\`\`\`${language}\n${body}\n\`\`\``
}

/** Requests with `count` tool schemas. */
const tools = (count) => Array.from({ length: count }, (_, index) => ({
  name: `tool_${index}`,
  description: `tool number ${index}`,
  parameters: { type: 'object', properties: {} },
}))

/** Neutral prose: no keywords, no math notation, no fences. */
const NEUTRAL = 'The quick brown fox jumps over the lazy dog. '

/** Recursively freeze a value so an accidental write throws in strict mode. */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

test('estimateTokens: empty and non-string input estimate to zero', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens(undefined), 0)
  assert.equal(estimateTokens(null), 0)
  assert.equal(estimateTokens(42), 0)
  assert.equal(estimateTokens({}), 0)
  assert.equal(estimateTokens([]), 0)
})

test('estimateTokens: ASCII counts roughly four characters per token', () => {
  assert.equal(estimateTokens('a'), 1)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('abcde'), 2)
  assert.equal(estimateTokens('a'.repeat(100)), 25)
  assert.equal(estimateTokens('a'.repeat(400)), 100)
})

test('estimateTokens: CJK counts roughly one token per character', () => {
  assert.equal(estimateTokens('中'), 1)
  assert.equal(estimateTokens('中文测试'), 4)
  assert.equal(estimateTokens('中'.repeat(100)), 100)
  assert.equal(estimateTokens('中'.repeat(400)), 400)
})

test('estimateTokens: equal character counts give the documented 4:1 ratio', () => {
  assert.equal(estimateTokens('中'.repeat(400)), 4 * estimateTokens('a'.repeat(400)))
})

test('estimateTokens: mixed scripts add both components', () => {
  assert.equal(estimateTokens('中文abc'), 2 + 1)
  assert.equal(estimateTokens('中文abcd'), 2 + 1)
  assert.equal(estimateTokens('中文abcde'), 2 + 2)
})

test('estimateTokens: full-width punctuation and kana count as CJK', () => {
  assert.equal(estimateTokens('，。！'), 3)
  assert.equal(estimateTokens('カタカナ'), 4)
})

test('estimateTokens: non-decreasing as text grows', () => {
  const source = 'The quick brown fox 中文测试 jumps over the lazy dog 再次测试。'
  let previous = 0
  for (let length = 0; length <= source.length; length += 1) {
    const current = estimateTokens(source.slice(0, length))
    assert.ok(current >= previous, `length ${length}: ${current} < ${previous}`)
    previous = current
  }
})

// ---------------------------------------------------------------------------
// result shape, determinism, purity
// ---------------------------------------------------------------------------

test('the frozen constants are exactly the documented values', () => {
  assert.deepEqual([...TIERS], ['simple', 'medium', 'complex'])
  assert.deepEqual({ ...DEFAULT_THRESHOLDS }, { medium: 0.34, complex: 0.67 })
  assert.equal(Object.isFrozen(TIERS), true)
  assert.equal(Object.isFrozen(DEFAULT_THRESHOLDS), true)
  assert.equal(Object.isFrozen(DEFAULT_WEIGHTS), true)
  for (const value of Object.values(DEFAULT_WEIGHTS)) {
    assert.ok(typeof value === 'number' && value >= 0 && value < 1)
  }
  assert.ok(DEFAULT_SIMPLE_PENALTY > 0 && DEFAULT_SIMPLE_PENALTY < 1)
  assert.ok(DEFAULT_TOKEN_SCALE > 0)
})

test('the result always has the documented shape', () => {
  const samples = [
    {},
    { messages: [] },
    { messages: [userText('hi')] },
    { messages: [userText(fence(30))], tools: tools(12), system: 'be terse' },
  ]
  for (const sample of samples) {
    const result = scoreComplexity(sample)
    assert.equal(typeof result.tier, 'string')
    assert.ok(TIERS.includes(result.tier), `illegal tier ${result.tier}`)
    assert.equal(typeof result.score, 'number')
    assert.ok(Number.isFinite(result.score))
    assert.ok(result.score >= 0 && result.score <= 1, `score out of range: ${result.score}`)
    assert.equal(typeof result.tokens, 'number')
    assert.ok(Number.isInteger(result.tokens) && result.tokens >= 0)
    assert.equal(typeof result.signals, 'object')
    for (const [name, value] of Object.entries(result.signals)) {
      assert.ok(Number.isFinite(value), `signal ${name} is not a finite number: ${value}`)
    }
    assert.ok(Array.isArray(result.reasons))
    for (const reason of result.reasons) assert.equal(typeof reason, 'string')
  }
})

test('the same input scores identically one hundred times', () => {
  const options = deepFreeze({
    system: 'You are a careful engineer.',
    messages: [userText('重构这个模块并给出架构权衡与失败模式分析'), userText(fence(40))],
    tools: tools(12),
  })
  const first = scoreComplexity(options)
  for (let round = 0; round < 100; round += 1) {
    assert.deepEqual(scoreComplexity(options), first, `round ${round} differed`)
  }
})

test('the classifier does not mutate its input', () => {
  const options = {
    system: 'be terse',
    messages: [
      userText('分析这段代码'),
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"a"}' }] },
      { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'file contents' }] },
      { role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'sha256:x', mediaType: 'image/png' } }] },
    ],
    tools: tools(4),
  }
  const before = JSON.stringify(options)
  deepFreeze(options)
  assert.doesNotThrow(() => scoreComplexity(options))
  assert.equal(JSON.stringify(options), before)
})

test('the config argument is never mutated either', () => {
  const config = { thresholds: { medium: 0.2, complex: 0.5 }, weights: { tokens: 0.7 }, tokenScale: 1000 }
  const before = JSON.stringify(config)
  deepFreeze(config)
  assert.doesNotThrow(() => scoreComplexity({ messages: [userText('hello')] }, config))
  assert.equal(JSON.stringify(config), before)
})

// ---------------------------------------------------------------------------
// totality: no shape may throw
// ---------------------------------------------------------------------------

test('degenerate options never throw and always return a legal verdict', () => {
  const code = 'x'.repeat(100_000)
  const cases = [
    undefined, null, 42, 'a string', [], true, () => {},
    {},
    { messages: undefined },
    { messages: null },
    { messages: 42 },
    { messages: [] },
    { messages: [null, 1, 'x', [], true] },
    { messages: [{ role: 'user' }] },
    { messages: [{ role: 'user', content: undefined }] },
    { messages: [{ role: 'user', content: null }] },
    { messages: [{ role: 'user', content: 42 }] },
    { messages: [{ role: 'user', content: [] }] },
    { messages: [{ role: 'user', content: '' }] },
    { messages: [{ role: 'user', content: 'a bare string, out of contract' }] },
    { messages: [{ role: 'user', content: [null, 1, 'x', { type: 'unknown-kind' }] }] },
    { messages: [{ role: 'user', content: [{ type: 'text', text: 42 }] }] },
    { messages: [{ role: 'user', content: [{ type: 'image' }] }] },
    { messages: [{ role: 'user', content: [{ type: 'tool-call' }] }] },
    { messages: [{ role: 'tool', content: [{ type: 'text', text: 'r' }] }] },
    { messages: [userText(code)] },
    { messages: [userText('中文'.repeat(20_000))] },
    { messages: [userText('混合 mixed 中文 and English 文本。' + NEUTRAL.repeat(50))] },
    { messages: [userText('unclosed fence\n```js\nconst a = 1\n')] },
    { messages: [userText('```\n```\n```\n')] },
    { messages: [userText('')], system: undefined },
    { messages: [], system: code },
    { messages: [], system: 42 },
    { messages: [], tools: undefined },
    { messages: [], tools: null },
    { messages: [], tools: 'not an array' },
    { messages: [], tools: [null, 1, { name: 'ok' }] },
  ]
  for (const [index, sample] of cases.entries()) {
    let result
    assert.doesNotThrow(() => {
      result = scoreComplexity(sample)
    }, `case #${index} threw`)
    assert.ok(TIERS.includes(result.tier), `case #${index} returned tier ${result.tier}`)
    assert.ok(result.score >= 0 && result.score <= 1, `case #${index} returned score ${result.score}`)
    assert.ok(Array.isArray(result.reasons) && result.reasons.length > 0, `case #${index} had no reasons`)
  }
})

test('builders undefined for messages/tools are treated as empty', () => {
  const base = scoreComplexity({})
  assert.deepEqual(scoreComplexity({ messages: undefined, tools: undefined }), base)
  assert.deepEqual(scoreComplexity({ messages: null, tools: null }), base)
  assert.deepEqual(scoreComplexity({ messages: 'nope', tools: 'nope' }), base)
})

// ---------------------------------------------------------------------------
// monotonicity
// ---------------------------------------------------------------------------

test('more tokens never lowers the score', () => {
  let previous = -1
  for (let repeats = 0; repeats <= 200; repeats += 10) {
    const { score } = scoreComplexity({ messages: [userText(NEUTRAL.repeat(repeats))] })
    assert.ok(score >= previous, `repeats ${repeats}: ${score} < ${previous}`)
    previous = score
  }
})

test('more tool schemas never lowers the score', () => {
  let previous = -1
  for (let count = 0; count <= 20; count += 1) {
    const { score } = scoreComplexity({ messages: [userText('continue')], tools: tools(count) })
    assert.ok(score >= previous, `tools ${count}: ${score} < ${previous}`)
    previous = score
  }
})

test('more code never lowers the score', () => {
  let previous = -1
  for (let lines = 0; lines <= 240; lines += 10) {
    const { score } = scoreComplexity({ messages: [userText(`explain this\n${fence(lines)}`)] })
    assert.ok(score >= previous, `lines ${lines}: ${score} < ${previous}`)
    previous = score
  }
})

test('more fenced blocks never lower the score', () => {
  let previous = -1
  for (let blocks = 0; blocks <= 5; blocks += 1) {
    const body = Array.from({ length: blocks }, () => fence(10)).join('\n')
    const { score } = scoreComplexity({ messages: [userText(body)] })
    assert.ok(score >= previous, `blocks ${blocks}: ${score} < ${previous}`)
    previous = score
  }
})

test('deeper conversations never lower the score', () => {
  let previous = -1
  for (let depth = 0; depth <= 40; depth += 2) {
    const messages = []
    for (let turn = 0; turn < depth; turn += 1) {
      messages.push({ role: 'assistant', content: [{ type: 'text', text: 'noted.' }] })
      messages.push({ role: 'tool', content: [{ type: 'text', text: 'ok' }] })
    }
    messages.push(userText('continue please'))
    const { score } = scoreComplexity({ messages })
    assert.ok(score >= previous, `depth ${depth}: ${score} < ${previous}`)
    previous = score
  }
})

// ---------------------------------------------------------------------------
// realistic requests land in a sensible tier
// ---------------------------------------------------------------------------

const SAMPLES = [
  { name: 'translate one sentence', options: { messages: [userText('翻译这句话')] }, tier: 'simple' },
  { name: 'rewrite a paragraph more concisely', options: { messages: [userText('把这段话改写得更简洁一点')] }, tier: 'simple' },
  { name: 'list the files in a directory', options: { messages: [userText('列出这个目录下的文件')] }, tier: 'simple' },
  { name: 'summarize a document (English)', options: { messages: [userText('Summarize this document')] }, tier: 'simple' },
  { name: 'trivial factual question', options: { messages: [userText('What is the capital of France?')] }, tier: 'simple' },
  { name: 'explain 200 lines of code', options: { messages: [userText(`解释这份 200 行代码的作用\n${fence(200)}`)] }, tier: 'medium' },
  {
    name: 'long multi-turn session',
    options: {
      messages: [
        ...Array.from({ length: 11 }, () => ({ role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(200) }] })),
        ...Array.from({ length: 11 }, () => ({ role: 'tool', content: [{ type: 'text', text: 'y'.repeat(200) }] })),
        userText('continue'),
      ],
    },
    tier: 'medium',
  },
  {
    name: 'refactor with trade-offs, 12 tools available',
    options: {
      messages: [userText('重构这个模块并给出架构权衡与失败模式分析')],
      tools: tools(12),
    },
    tier: 'complex',
  },
  {
    name: 'prove and analyse step by step',
    options: { messages: [userText('Prove that the algorithm terminates and analyze its complexity step by step')] },
    tier: 'complex',
  },
]

for (const sample of SAMPLES) {
  test(`tier: ${sample.name} -> ${sample.tier}`, () => {
    const result = scoreComplexity(sample.options)
    assert.equal(result.tier, sample.tier, `score was ${result.score} (signals: ${JSON.stringify(result.signals)})`)
  })
}

test('tiers are ordered: a more demanding request never scores lower', () => {
  const simple = scoreComplexity({ messages: [userText('列出这个目录下的文件')] }).score
  const medium = scoreComplexity({ messages: [userText(`解释这份 200 行代码的作用\n${fence(200)}`)] }).score
  const complex = scoreComplexity({
    messages: [userText('重构这个模块并给出架构权衡与失败模式分析')],
    tools: tools(12),
  }).score
  assert.ok(simple < medium, `${simple} !< ${medium}`)
  assert.ok(medium < complex, `${medium} !< ${complex}`)
})

// ---------------------------------------------------------------------------
// images
// ---------------------------------------------------------------------------

const imageMessage = (text) => ({
  role: 'user',
  content: [
    ...text === undefined ? [] : [{ type: 'text', text }],
    { type: 'image', attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 10, width: 4, height: 4 } },
  ],
})

test('an image-only request is never simple: it needs a vision model', () => {
  const result = scoreComplexity({ messages: [imageMessage()] })
  assert.equal(result.signals.images, 1)
  assert.equal(result.tier, 'medium')
  assert.ok(result.score >= DEFAULT_THRESHOLDS.medium)
})

test('an image cannot be dragged back to simple by simple-task words', () => {
  const result = scoreComplexity({ messages: [imageMessage('translate this screenshot')] })
  assert.equal(result.tier, 'medium')
})

test('the image floor follows an overridden medium threshold', () => {
  const result = scoreComplexity({ messages: [imageMessage()] }, { thresholds: { medium: 0.9, complex: 0.95 } })
  assert.equal(result.tier, 'medium')
  assert.equal(result.score, 0.9)
})

test('many images raise the score further', () => {
  const one = scoreComplexity({ messages: [imageMessage()] }).score
  const many = scoreComplexity({
    messages: [imageMessage(), imageMessage(), imageMessage(), imageMessage()],
  }).score
  assert.ok(many >= one, `${many} < ${one}`)
})

// ---------------------------------------------------------------------------
// config overrides
// ---------------------------------------------------------------------------

test('thresholds move a borderline request between tiers', () => {
  const options = { messages: [userText(`解释这份 200 行代码的作用\n${fence(200)}`)] }
  const byDefault = scoreComplexity(options)
  assert.equal(byDefault.tier, 'medium')
  const strict = scoreComplexity(options, { thresholds: { medium: 0.1, complex: 0.2 } })
  assert.equal(strict.tier, 'complex')
  assert.equal(strict.score, byDefault.score, 'thresholds must not change the score')
  const lax = scoreComplexity(options, { thresholds: { medium: 0.9, complex: 0.95 } })
  assert.equal(lax.tier, 'simple')
})

test('a flat config form (no thresholds wrapper) is accepted', () => {
  const options = { messages: [userText(`解释这份 200 行代码的作用\n${fence(200)}`)] }
  assert.equal(scoreComplexity(options, { medium: 0.1, complex: 0.2 }).tier, 'complex')
})

test('weights change the score', () => {
  const options = { messages: [userText('continue')], tools: tools(12) }
  const byDefault = scoreComplexity(options).score
  const heavy = scoreComplexity(options, { weights: { tools: 0.9 } }).score
  const light = scoreComplexity(options, { weights: { tools: 0.05 } }).score
  assert.ok(heavy > byDefault, `${heavy} !> ${byDefault}`)
  assert.ok(light < byDefault, `${light} !< ${byDefault}`)
})

test('tokenScale changes where the token signal saturates', () => {
  const options = { messages: [userText('x'.repeat(2_000))] }
  const wide = scoreComplexity(options, { tokenScale: 100_000 }).score
  const narrow = scoreComplexity(options, { tokenScale: 100 }).score
  assert.ok(narrow > wide, `${narrow} !> ${wide}`)
})

test('an unusable config falls back to the defaults instead of throwing', () => {
  const options = { messages: [userText(`解释这份 200 行代码的作用\n${fence(200)}`)] }
  const baseline = scoreComplexity(options)
  const badConfigs = [
    null, undefined, 42, 'x', [],
    { thresholds: null },
    { thresholds: 'x' },
    { thresholds: { medium: 'x', complex: 'y' } },
    { thresholds: { medium: -1, complex: 5 } },
    { thresholds: { medium: 0.8, complex: 0.2 } }, // inverted: complex falls back to the default
    { thresholds: { medium: 0.9, complex: 0.95 }, weights: { tools: -1 } },
    { weights: 5 },
    { weights: null },
    { weights: { tokens: 'many', code: 2, tools: Number.NaN } },
    { tokenScale: 0 },
    { tokenScale: -5 },
    { tokenScale: 'big' },
    { simplePenalty: -1 },
    { simplePenalty: 'none' },
  ]
  for (const [index, config] of badConfigs.entries()) {
    let result
    assert.doesNotThrow(() => {
      result = scoreComplexity(options, config)
    }, `config #${index} threw`)
    assert.ok(TIERS.includes(result.tier))
    if (index === 0 || index === 1 || index === 9) {
      assert.equal(result.score, baseline.score, `config #${index} should have used the defaults`)
    }
  }
})

test('an inverted threshold pair keeps medium reachable', () => {
  const options = { messages: [userText(`解释这份 200 行代码的作用\n${fence(200)}`)] }
  const result = scoreComplexity(options, { thresholds: { medium: 0.8, complex: 0.2 } })
  assert.equal(result.tier, 'medium')
})

// ---------------------------------------------------------------------------
// signals and reasons
// ---------------------------------------------------------------------------

test('signals expose both the raw measure and the normalised contribution', () => {
  const options = { messages: [userText(`解释这份代码\n${fence(50)}`)], tools: tools(3) }
  const { signals, tokens } = scoreComplexity(options)
  assert.equal(signals.tokens, tokens)
  assert.equal(signals.tools, 3)
  assert.equal(signals.codeBlocks, 1)
  assert.equal(signals.codeLines, 50)
  assert.equal(signals.messages, 1)
  assert.ok(Object.keys(signals).length >= 13, 'every signal must be visible in `signals`')
  for (const key of ['tokensScore', 'codeScore', 'toolsScore', 'depthScore', 'keywordScore', 'reasoningScore', 'imageScore']) {
    assert.ok(Number.isFinite(signals[key]), `missing normalised signal ${key}`)
  }
  assert.ok(signals.tokensScore >= 0 && signals.tokensScore <= 1)
  assert.ok(signals.codeScore >= 0 && signals.codeScore <= 1)
  assert.ok(signals.toolsScore >= 0 && signals.toolsScore <= 1)
  assert.ok(signals.depthScore >= 0 && signals.depthScore <= 1)
  assert.ok(signals.reasoningScore >= 0 && signals.reasoningScore <= 1)
  assert.ok(signals.imageScore >= 0 && signals.imageScore <= 1)
  assert.ok(signals.keywordScore >= -1 && signals.keywordScore <= 1)
})

test('signals count tool schemas, fenced blocks and conversation depth', () => {
  const messages = [
    ...Array.from({ length: 11 }, () => ({ role: 'assistant', content: [{ type: 'text', text: 'x' }] })),
    ...Array.from({ length: 11 }, () => ({ role: 'tool', content: [{ type: 'text', text: 'y' }] })),
    userText('continue'),
  ]
  const result = scoreComplexity({ messages, tools: tools(12) })
  assert.equal(result.signals.tools, 12)
  assert.equal(result.signals.messages, 23)
  assert.equal(result.signals.turns, 22)
  assert.ok(result.reasons.includes('12 tool schemas'))
  assert.ok(result.reasons.includes('deep conversation (23 messages)'))
})

test('reasons describe the code signal in the documented wording', () => {
  const result = scoreComplexity({ messages: [userText(`explain\n${fence(140)}\nand more\n${fence(10)}`)] })
  assert.equal(result.signals.codeBlocks, 2)
  assert.equal(result.signals.codeLines, 150)
  assert.ok(result.reasons.includes('2 fenced code blocks (150 lines)'), JSON.stringify(result.reasons))
})

test('simple-task words are reported as lowering the score', () => {
  const result = scoreComplexity({ messages: [userText('请翻译这段话并总结要点')] })
  assert.ok(result.signals.simpleKeywords >= 2)
  assert.ok(result.signals.keywordScore < 0)
  assert.ok(result.reasons.some((reason) => reason.includes('simple-task keywords')))
})

test('complex vocabulary raises the keyword signal', () => {
  const plain = scoreComplexity({ messages: [userText('look at this module')] })
  const asked = scoreComplexity({ messages: [userText('重构这个模块并分析架构')] })
  assert.equal(plain.signals.complexKeywords, 0)
  assert.ok(asked.signals.complexKeywords >= 3)
  assert.ok(asked.signals.keywordScore > 0)
  assert.ok(asked.score > plain.score)
})

test('keywords inside fenced code are not counted as user intent', () => {
  const inCode = scoreComplexity({
    messages: [userText('what does this do?\n```js\n// refactor and analyze the architecture\nconst design = prove()\n```')],
  })
  assert.equal(inCode.signals.complexKeywords, 0)
  assert.equal(inCode.signals.mathSymbols, 0)
})

test('step-by-step wording is detected in both languages', () => {
  assert.equal(scoreComplexity({ messages: [userText('请逐步推导这个公式')] }).signals.stepByStep, 1)
  assert.equal(scoreComplexity({ messages: [userText('explain this step by step')] }).signals.stepByStep, 1)
  assert.equal(scoreComplexity({ messages: [userText('explain this')] }).signals.stepByStep, 0)
})

test('math notation raises the reasoning signal', () => {
  const plain = scoreComplexity({ messages: [userText('sum these numbers')] })
  const maths = scoreComplexity({ messages: [userText('show that ∑ x² ≤ ∫ f and x ≠ y')] })
  assert.equal(plain.signals.mathSymbols, 0)
  assert.ok(maths.signals.mathSymbols >= 3)
  assert.ok(maths.signals.reasoningScore > plain.signals.reasoningScore)
})

test('reasoning blocks count towards tokens but not towards the vocabulary', () => {
  const withReasoning = scoreComplexity({
    messages: [
      { role: 'assistant', content: [{ type: 'reasoning', text: 'I should refactor and analyze the architecture' }] },
      userText('continue'),
    ],
  })
  assert.equal(withReasoning.signals.complexKeywords, 0)
  assert.ok(withReasoning.tokens > scoreComplexity({ messages: [userText('continue')] }).tokens)
})

test('tool-call arguments count as input text', () => {
  const result = scoreComplexity({
    messages: [
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'write', arguments: `{"patch":"${'z'.repeat(400)}"}` }] },
    ],
  })
  assert.ok(result.signals.tokens >= 100)
  assert.ok(result.reasons.includes('1 replayed tool call(s)'))
})

test('an empty request still explains itself', () => {
  const result = scoreComplexity({})
  assert.deepEqual(result.reasons, ['empty request'])
  assert.equal(result.tier, 'simple')
  assert.equal(result.score, 0)
})
