/**
 * The built-in free-provider pool.
 *
 * ## Provenance
 *
 * `BUILTIN_PROVIDERS` is a direct transform of `research/provider-catalog.json`
 * (T7's evidence report, generated from `freellmapi@v0.14.0` provider registry +
 * bundled model migrations + official provider docs), **corrected by the Lead's
 * live keyless probe** of 2026-10-13 (`_lead/live-probe-2026-10-13.md`):
 *
 * - `kilo` · `poolside/laguna-m.1:free` returned **404** (id does not exist) and
 *   was replaced with `poolside/laguna-s-2.1:free` from a live `GET /v1/models`;
 * - `kilo` gained `nvidia/nemotron-3-ultra-550b-a55b:free` (550B, free);
 * - `llm7` · `gpt-oss-20b` and `llm7` · `GLM-4.6V-Flash` both returned
 *   **400 `model_unavailable`** and were removed — the latter also carried a
 *   wrong `vision: true`;
 * - `llm7` gained `DeepSeek-V4-Flash-0731`, verified anonymous-200 by the probe.
 *
 * ## `contextWindow` provenance (T19)
 *
 * A wrong `contextWindow` is not a cosmetic error: the context gate uses it to
 * *choose* between candidates and to *exclude* them. Claiming 1,000,000 for a
 * model that serves 262,144 sent a 297k-token session to a model that answered
 * HTTP 400, while the one model in the pool that really could hold it was
 * mislabelled 131,072 and excluded before dispatch.
 *
 * Values are therefore either **measured** or **marked as an estimate** in each
 * model's `source`:
 *
 * - `kilo` (4 models) and `llm7` (2 models): measured 2026-10-13 from a live
 *   anonymous `GET /models` (`context_length`, and `context_window.tokens` for
 *   LLM7's nested shape).
 * - `groq` / `cerebras` / `openrouter` / `mistral` / `zhipu` /
 *   `volcengine` / `longcat` / `nvidia`: their catalogs answered **403** without
 *   a credential, so the shipped numbers remain catalogue-derived **estimates**.
 * - `ovh`: its `GET /v1/models` answers 200 but publishes **no** context field at
 *   all, so its value stays an estimate too.
 *
 * ### v0.7 additions (6 providers, all `enabled: false`)
 *
 * - `sambanova` (6 rows), `routeway` (290 rows, 9 `:free`) and `huggingface`
 *   (132 rows) answered an anonymous `GET /v1/models` with a native
 *   `context_length`, so those values are **measured 2026-10-15**. `huggingface`
 *   is a meta-router: its context lives in `providers[].context_length`, one
 *   value **per backend**, so the lowest live backend value is recorded and the
 *   chosen backend is named in each `source` — taking the maximum would pass one
 *   backend's capacity off as the id's own.
 * - `modelscope` publishes **no** context field at all (36 ids, `id/object/
 *   owned_by/created` only) and `xfyun` / `siliconflow` answer 401 without a
 *   credential, so those three ship **estimates**. They are labelled as such.
 *
 * ## The 6 new providers are not "keyless" — `keyless` means *chat* needs no key
 *
 * Four of them (`modelscope`, `sambanova`, `huggingface`, `routeway`) answer an
 * anonymous `GET /models` with 200, which is how the v0.6.1 reachability table
 * would have read them. Their `POST /chat/completions` all answer **401**
 * (routeway: 403 from a Cloudflare interstitial), so `keyless: true` would make
 * {@link isProviderUsable} report them usable with no credential and route a
 * request that cannot be authenticated. All six ship `keyless: false`.
 *
 * ## Conservative capability claims
 *
 * A wrong `vision: true` is the one field that can make a user's request fail in
 * a way they cannot work around (images sent to a text-only model), so no model
 * is marked `vision: true` without code-level or live-probe evidence. The same
 * rule is applied to `toolCalling` where the family has no whitelist entry.
 * `maxTokens` is only an ordering hint and is overridable per model — upstream
 * publishes no such field at all.
 *
 * ## "free" is a price claim, never a naming convention
 *
 * A model id ending in `:free` is a naming convention, not a price promise. On
 * 2026-10-15 **every** `openrouter` row carrying that suffix was found
 * unservable — three had a catalogue record with `endpoints: []`, one answered
 * HTTP 404 — while the suffix itself was intact elsewhere: 14 of 14 live
 * `:free` ids were genuinely zero-priced, and the four `kilo` rows re-measured
 * clean on the same day. (`_lead/research/free-model-audit.md`.)
 *
 * So a row that claims to be free carries a `verified` **evidence record**: when
 * it was taken, the method, the price fields observed, the number of serving
 * endpoints and a hash of the raw response body. `lib/free.js` is the only place
 * that turns that evidence into the word "free", and it never reads an id. The
 * committed fixtures under `tests/fixtures/` are the bytes those hashes name, so
 * the claim is recomputable offline; `tools/gate.mjs` G9 re-checks it online and
 * reports drift, and evidence older than `FREE_VERIFIED_BLOCK_DAYS` fails the
 * guard — staleness is a defect, not a footnote.
 *
 * The criteria are never relaxed to make a guard pass: a row that cannot be
 * verified free comes out of the pool.
 *
 * ## `apiKeyEnv` is *our* convention, never upstream truth
 *
 * freellmapi has no `apiKeyEnv` concept (its gateway keys live in an encrypted
 * SQLite store behind its dashboard). Every value here is therefore a **default**
 * that a user can override per provider, and resolution always consults the DSH
 * credentials service first. See {@link resolveProviderKey}.
 *
 * @module dsh-freellmapi/providers
 */

import { isVerifiedRecord } from './free.js'

/** Provider ids enabled when the user has configured nothing. */
export const DEFAULT_ENABLED_PROVIDERS = Object.freeze(['groq', 'cerebras', 'openrouter', 'kilo', 'llm7'])

/** Providers that work with **no credential at all** (live-probe verified). */
export const KEYLESS_PROVIDER_IDS = Object.freeze(['kilo', 'llm7', 'ovh'])

/** Conservative capability defaults for a model a user declares by hand. */
export const CONSERVATIVE_CAPS = Object.freeze({
  capability: 3,
  speed: 3,
  contextWindow: 32_768,
  maxTokens: 4_096,
  vision: false,
  toolCalling: false,
})

/**
 * Recursively freeze the generated pool so no consumer can mutate shared state.
 * @template T
 * @param {T} providers
 * @returns {T}
 */
function freezePool(providers) {
  const list = /** @type {any} */ (providers)
  for (const provider of list) {
    for (const model of provider.models) {
      Object.freeze(model.caps)
      // The evidence record is part of the model, so the pool's "recursively
      // frozen" promise has to cover it: an unfrozen `verified` would let any
      // consumer rewrite the date or the price fields a guard reads.
      if (model.verified !== undefined) Object.freeze(model.verified)
      Object.freeze(model)
    }
    Object.freeze(provider.models)
    if (provider.limits !== undefined) Object.freeze(provider.limits)
    if (provider.extraBody !== undefined) Object.freeze(provider.extraBody)
    Object.freeze(provider)
  }
  return Object.freeze(list)
}

/* @generated:catalog:start */
/**
 * The frozen built-in pool.
 *
 * ## ⚠️ This block is NOT generated, despite the marker above it
 *
 * The `@generated:catalog` markers are a leftover from an arrangement this repository
 * no longer has, and the description that used to sit here — "generated from
 * `research/provider-catalog.json` + the lead live probe" — named a process that does
 * not exist. Measured 2026-10-15:
 *
 *   - **`research/provider-catalog.json` is absent.** No such file is in the tree.
 *   - **No generator writes this block.** Nothing in `tests/` or `tools/` reads these
 *     markers, so nothing can refresh or diff it.
 *   - **No gate covers it as a whole.** `tools/gate.mjs` G6 checks only the
 *     browser-half `client-setup` block, which *is* genuinely generated.
 *
 * A marker that describes a missing process is worse than no marker: it invites a
 * maintainer either to hold back an edit ("something will overwrite this") or to wait
 * for a regeneration that will never come. It was flagged rather than fixed in the
 * 0.7.1 notes; this comment is that fix.
 *
 * ## What is actually true
 *
 * **These rows are hand-maintained.** Edit them directly — every change since the
 * generator disappeared has been made that way, including the free-model audit, the
 * retired-id replacements, and the reasoning-effort vocabularies.
 *
 * The data is not unguarded, it is guarded *piecewise* by the online gates, each of
 * which checks a mechanically verifiable claim rather than the block's text:
 *
 *   - **G7** — every pool provider is reachable by the method that suits it.
 *   - **G8** — upstream platform drift (informational).
 *   - **G9** — free-model evidence has not drifted, with committed byte fixtures.
 *   - **G10** — every declared model id is one the provider actually serves.
 *
 * The markers are kept so that a future generator could adopt the same boundaries. If
 * it is ever worth generating again, the honest inputs would be the upstream
 * catalogues recorded under `_lead/probes/catalogs/` plus a recorded probe run — and
 * that is a design decision, not a cleanup.
 */
export const BUILTIN_PROVIDERS = freezePool([
  {
    id: 'groq',
    displayName: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    keyURL: 'https://console.groq.com/keys',
    keyless: false,
    enabled: true,
    confidence: 'confirmed',
    limits: {
      rpm: 30,
      rpd: 1000,
      tpm: 8000,
      tpd: 200000,
      note: '免费额度随模型与账户等级变化；上表按 2026-04 迁移基线中最紧的一档填写，并已置为可配置项而非硬编码。**注意**：那条基线取自 `llama-3.3-70b`，而 2026-10-15 实测该模型已从 `GET /models` 下架（chat 返回 404），故这里的 rpm/rpd/tpm/tpd 只应视为**保守的历史基线**，不代表当前在售模型的额度'
    },
    models: [
      {
        id: 'openai/gpt-oss-120b',
        name: 'GPT-OSS 120B (Groq)',
        caps: {
          capability: 4,
          speed: 5,
          contextWindow: 131072,
          maxTokens: 32768,
          vision: false,
          toolCalling: true
        },
        // Measured 2026-10-15 with a real credential: Groq validates the field and
        // rejects anything outside its allowlist, answering
        // "`reasoning_effort` must be one of `low`, `medium`, or `high`".
        reasoning: ['low', 'medium', 'high'],
        source: 'server/src/db/migrations/20260101_000000_legacy_baseline.ts:632 (migrateModelsV10); reasoning vocabulary measured 2026-10-15 (low/medium/high accepted, `none` rejected HTTP 400)'
      },
      {
        id: 'qwen/qwen3.8-27b',
        name: 'Qwen3.8 27B (Groq)',
        caps: {
          capability: 4,
          speed: 5,
          contextWindow: 131072,
          maxTokens: 32768,
          vision: false,
          toolCalling: true
        },
        // Measured 2026-10-15: this model accepts `none` as well, unlike both
        // gpt-oss models — the vocabulary is per model, not per provider.
        reasoning: ['low', 'medium', 'high', 'none'],
        source: 'id and contextWindow 131072 measured 2026-10-15 from `GET https://api.groq.com/openai/v1/models` (11 models served); toolCalling true measured 2026-10-15 by a one-tool probe (one get_weather tool with a required `city` argument) which returned a structured tool_calls entry with valid JSON arguments. Replaces `llama-3.3-70b-versatile`, which that same listing no longer serves and which answered HTTP 404. reasoning_effort vocabulary measured the same day: low/medium/high/none'
      },
      {
        id: 'openai/gpt-oss-20b',
        name: 'GPT-OSS 20B (Groq)',
        caps: {
          capability: 2,
          speed: 5,
          contextWindow: 131072,
          maxTokens: 8192,
          vision: false,
          toolCalling: true
        },
        // Measured 2026-10-15: `none` is REJECTED here (HTTP 400), unlike
        // qwen/qwen3.8-27b — hence a per-model list rather than a per-provider one.
        reasoning: ['low', 'medium', 'high'],
        source: 'id and contextWindow 131072 measured 2026-10-15 from `GET https://api.groq.com/openai/v1/models` (11 models served); toolCalling true measured 2026-10-15 by the same one-tool probe (structured tool_calls, valid JSON, required argument present). Replaces `llama-3.1-8b-instant`, which that listing no longer serves and which answered HTTP 404. reasoning_effort vocabulary measured the same day: low/medium/high accepted, `none` rejected with HTTP 400'
      }
    ]
  },
  {
    id: 'cerebras',
    displayName: 'Cerebras',
    baseURL: 'https://api.cerebras.ai/v1',
    apiKeyEnv: 'CEREBRAS_API_KEY',
    keyURL: 'https://cloud.cerebras.ai/',
    keyless: false,
    enabled: true,
    confidence: 'confirmed',
    limits: {
      rpm: 30,
      rpd: null,
      tpm: 60000,
      tpd: 1000000,
      note: '免费池 30 RPM / 1M TPD（无 RPD 上限）；注：V26 审计曾把该池改为 5 RPM / 30K TPM / 1M TPD 并随后移入托管目录，故 RPM/TPM 存在版本差异，实现侧应可配置'
    },
    models: [
      {
        id: 'qwen-3-coder-480b',
        name: 'Qwen3-Coder 480B',
        caps: {
          capability: 5,
          speed: 5,
          contextWindow: 131072,
          maxTokens: 32768,
          vision: false,
          toolCalling: true
        },
        source: 'server/src/db/migrations/20260101_000000_legacy_baseline.ts:310 (seedModels); tool via V22 规则 :1763 (%qwen-3%)'
      },
      {
        id: 'gpt-oss-120b',
        name: 'GPT-OSS 120B (Cerebras)',
        caps: {
          capability: 4,
          speed: 5,
          contextWindow: 131072,
          maxTokens: 32768,
          vision: false,
          toolCalling: true
        },
        source: 'server/src/db/migrations/20260101_000000_legacy_baseline.ts:1058 (migrateModelsV13); tool via V22 :1757'
      },
      {
        id: 'llama-4-maverick-17b-128e-instruct',
        name: 'Llama 4 Maverick',
        caps: {
          capability: 5,
          speed: 5,
          contextWindow: 131072,
          maxTokens: 32768,
          vision: true,
          toolCalling: true
        },
        source: 'server/src/db/migrations/20260101_000000_legacy_baseline.ts:311 (seedModels); vision via V16 :1443-1447; tool via V22 :1758'
      },
      {
        id: 'llama3.1-8b',
        name: 'Llama 3.1 8B (Cerebras)',
        caps: {
          capability: 2,
          speed: 5,
          contextWindow: 131072,
          maxTokens: 8192,
          vision: false,
          toolCalling: true
        },
        source: 'server/src/db/migrations/20260101_000000_legacy_baseline.ts:1059 (migrateModelsV13); tool via V22 :1758'
      }
    ]
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    keyURL: 'https://openrouter.ai/keys',
    keyless: false,
    enabled: true,
    confidence: 'confirmed',
    limits: {
      rpm: 20,
      rpd: 50,
      tpm: null,
      tpd: null,
      note: '免费判据（不是命名约定）：pricing.prompt === "0" && pricing.completion === "0"，且该 id 至少有一个服务端点；判据实现见 lib/free.js，判定不读 id 后缀。取数 2026-10-15，方法：匿名（不带任何凭据）GET https://openrouter.ai/api/v1/models（462 条，响应体 sha256 fe83d51d8696c1b21cea8b522876a439bb1e35ca4f412485e19f1bf7353184bb），并对每个 id 核对 /models/<id>/endpoints。额度（官方文档常量，2026-10-15 取，出处 https://openrouter.ai/docs/api_reference/limits）：20 RPM；Requests per day 由累计购买 credits（all-time credits purchased，不是当前余额）决定 —— 少于 10 credits 为 50 RPD，达到 10 credits 为 1000 RPD。'
    },
    models: [
      {
        id: 'nvidia/nemotron-3-ultra-550b-a55b:free',
        name: 'Nemotron 3 Ultra 550B (free)',
        caps: {
          capability: 5,
          speed: 3,
          contextWindow: 1000000,
          maxTokens: 32768,
          vision: false,
          toolCalling: true
        },
        verified: {
          at: '2026-10-15T19:25:01+08:00',
          method: 'anonymous GET https://openrouter.ai/api/v1/models (+ /models/<id>/endpoints)',
          pricing: { prompt: '0', completion: '0' },
          endpoints: 1,
          endpointPricingZero: true,
          bodySha256: 'fe83d51d8696c1b21cea8b522876a439bb1e35ca4f412485e19f1bf7353184bb'
        },
        source: '同 id 已在 kilo 条取证（provider kilo，model nvidia/nemotron-3-ultra-550b-a55b:free）：caps 六项原样沿用，取证方法与来源见该条 source（2026-10-13 匿名 GET https://api.kilo.ai/api/gateway/models → context_length=1000000；lead live probe isFree=true）。OpenRouter 侧 2026-10-15 匿名核对：context_length=1000000（与 kilo 条一致）、pricing={"prompt":"0","completion":"0"}、/models/<id>/endpoints → endpoints=1 且该端点 pricing 全 0。上游 top_provider.max_completion_tokens=65536，本行 maxTokens 按 CONSERVATIVE_CAPS 取 32768（少声明只影响排序，多声明会发模型接不住的请求）。'
      },
      {
        id: 'nvidia/nemotron-3-super-120b-a12b:free',
        name: 'Nemotron 3 Super 120B (free)',
        caps: {
          capability: 5,
          speed: 3,
          contextWindow: 262144,
          maxTokens: 32768,
          vision: false,
          toolCalling: true
        },
        verified: {
          at: '2026-10-15T19:25:01+08:00',
          method: 'anonymous GET https://openrouter.ai/api/v1/models (+ /models/<id>/endpoints)',
          pricing: { prompt: '0', completion: '0' },
          endpoints: 1,
          endpointPricingZero: true,
          bodySha256: 'fe83d51d8696c1b21cea8b522876a439bb1e35ca4f412485e19f1bf7353184bb'
        },
        source: '同 id 已在 kilo 条取证（provider kilo，model nvidia/nemotron-3-super-120b-a12b:free）：caps 六项原样沿用，取证见该条 source（2026-10-13 实测 context_length=262144，修正了此前 1000000 的 4x 高估；tool via 上游 V22 %nemotron-3-super%）。OpenRouter 侧 2026-10-15 匿名核对：context_length=262144（与 kilo 条一致）、pricing={"prompt":"0","completion":"0"}、endpoints=1 且端点 pricing 全 0。上游 top_provider.max_completion_tokens=235929，本行 maxTokens 按 CONSERVATIVE_CAPS 取 32768。'
      },
      {
        id: 'cohere/north-mini-code:free',
        name: 'Cohere North Mini Code (free)',
        caps: {
          capability: 3,
          speed: 4,
          contextWindow: 256000,
          maxTokens: 16384,
          vision: false,
          // Measured 2026-10-15 on the OpenRouter endpoint with a real credential: a
          // one-tool request returned a structured `tool_calls` entry with valid JSON
          // and the required argument present. This RESOLVES the inconsistency the
          // previous source note recorded honestly (kilo said false, OpenRouter's
          // supported_parameters said tools).
          //
          // When only this side had been measured, the standing reading was "two
          // endpoints, two facts, so leave kilo at false". The kilo gateway was then
          // measured directly (it is keyless) and it ALSO returns a structured call —
          // so the two routes agree, and both rows now say true on evidence rather
          // than one of them saying false out of caution.
          toolCalling: true
        },
        verified: {
          at: '2026-10-15T19:25:01+08:00',
          method: 'anonymous GET https://openrouter.ai/api/v1/models (+ /models/<id>/endpoints)',
          pricing: { prompt: '0', completion: '0' },
          endpoints: 1,
          endpointPricingZero: true,
          bodySha256: 'fe83d51d8696c1b21cea8b522876a439bb1e35ca4f412485e19f1bf7353184bb'
        },
        source: '同 id 已在 kilo 条取证（provider kilo，model cohere/north-mini-code:free）：caps 六项原样沿用（2026-10-13 实测 context_length=256000，lead live probe isFree=true）。OpenRouter 侧 2026-10-15 匿名核对：context_length=256000、pricing={"prompt":"0","completion":"0"}、endpoints=1 且端点 pricing 全 0。✅ toolCalling 的旧矛盾已于 2026-10-15 **在 OpenRouter 端点上实测解决**：带一个必填 `city` 参数的 get_weather 工具请求返回结构化 tool_calls、JSON 合法、必填项齐备 ⇒ 本行取 true。**kilo 行仍取 false**：那是另一个端点，同一 id 经不同网关不等于是同一个服务——这不是待调和的矛盾，而是两条路由上的两个事实。'
      },
      {
        id: 'poolside/laguna-s-2.1:free',
        name: 'Poolside Laguna S 2.1 (free)',
        caps: {
          capability: 4,
          speed: 4,
          contextWindow: 262144,
          maxTokens: 32768,
          vision: false,
          toolCalling: false
        },
        verified: {
          at: '2026-10-15T19:25:01+08:00',
          method: 'anonymous GET https://openrouter.ai/api/v1/models (+ /models/<id>/endpoints)',
          pricing: { prompt: '0', completion: '0' },
          endpoints: 1,
          endpointPricingZero: true,
          bodySha256: 'fe83d51d8696c1b21cea8b522876a439bb1e35ca4f412485e19f1bf7353184bb'
        },
        source: '同 id 已在 kilo 条取证（provider kilo，model poolside/laguna-s-2.1:free）：caps 六项原样沿用（该条 2026-10-13 实测 context_length=262144，并取代返回 HTTP 404 的 poolside/laguna-m.1:free）。OpenRouter 侧 2026-10-15 匿名核对：context_length=262144、上游 max_completion_tokens=32768（与声明一致）、pricing={"prompt":"0","completion":"0"}、endpoints=1 且端点 pricing 全 0。⚠️ 同 north-mini-code：toolCalling 我方 false / OpenRouter 含 tools，按保守取 false 并留档。vision 槽位取舍：本行 vision=false —— 该约束曾由 Lead 裁决接受，**2026-10-15 已由本家新增的 dots-studio/dots-3-note-preview:free 与 nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free 两条实测视觉模型解除**（见其 source）。toolCalling 于 2026-10-15 两次实测均为 HTTP 429（上游限流，控制组同样 429），**未能测得**，故维持 false —— 没有证据不改声明。'
      },
      {
        id: 'nvidia/nemotron-3.5-lightning:free',
        name: 'Nemotron 3.5 Lightning (free)',
        caps: {
          capability: 3,
          speed: 5,
          contextWindow: 1000000,
          maxTokens: 32768,
          vision: false,
          toolCalling: true
        },
        verified: {
          at: '2026-10-15T21:20:00+08:00',
          method: 'anonymous GET https://openrouter.ai/api/v1/models (+ /models/<id>/endpoints)',
          pricing: { prompt: '0', completion: '0' },
          endpoints: 1,
          endpointPricingZero: true,
          bodySha256: 'fe83d51d8696c1b21cea8b522876a439bb1e35ca4f412485e19f1bf7353184bb'
        },
        source: '新增 2026-10-15（本家扩容扫描）。contextWindow 1000000 与 upstream max_completion_tokens 65536 均取自带凭据的 GET https://openrouter.ai/api/v1/models（零价条目扫描，pricing prompt/completion 全 "0"）；本行 maxTokens 按 CONSERVATIVE_CAPS 取 32768。toolCalling true 为**实测**：一个必填 `city` 的 get_weather 工具请求返回结构化 tool_calls、JSON 合法、必填项齐备（控制组 200）。capability 3 / speed 5 是**判断**：上游描述为 30B 总参 / 3B 激活的 MoE、面向 high-throughput，故按池内标尺取"能力中等、速度最高"，**不是测量值**。vision false:上游 architecture.input_modalities 仅 ["text"]。'
      },
      {
        id: 'dots-studio/dots-3-note-preview:free',
        name: 'Dots3 Note Preview (free)',
        caps: {
          capability: 4,
          speed: 3,
          contextWindow: 512000,
          maxTokens: 32768,
          vision: true,
          toolCalling: true
        },
        verified: {
          at: '2026-10-15T21:20:00+08:00',
          method: 'anonymous GET https://openrouter.ai/api/v1/models (+ /models/<id>/endpoints)',
          pricing: { prompt: '0', completion: '0' },
          endpoints: 1,
          endpointPricingZero: true,
          bodySha256: 'fe83d51d8696c1b21cea8b522876a439bb1e35ca4f412485e19f1bf7353184bb'
        },
        source: '新增 2026-10-15（本家扩容扫描）。contextWindow 512000 与 upstream max_completion_tokens 460800 取自带凭据的 GET https://openrouter.ai/api/v1/models（零价条目，pricing 全 "0"）；maxTokens 按 CONSERVATIVE_CAPS 取 32768。toolCalling true 为**实测**（一工具探针，控制组 200，结构化 tool_calls + JSON 合法 + 必填项齐备）。**vision true 为实测**：`_lead/probe-vision-live.mjs` 用一张纯红与一张纯蓝 32x32 PNG 提同一个问题，模型分别答 "red" / "blue"（各答中自己那张图）⇒ VISION CONFIRMED。注意该模型是 reasoning 型，首次以 max_tokens=32 探测时把 token 全用在 reasoning 上、content 返回 null，探针一度误报 "NOT VISION"——**那是探针施加的上限所致，不是模型的能力**，提高上限后即确认。**这一条与 nemotron-3-nano-omni 一起解除了本家此前"没有视觉模型"的约束。** capability 4 / speed 3 是**判断**：上游描述为 280B 总参 / 16B 激活的 MoE，故取"能力较高、速度中等"，**不是测量值**。名称含 Preview，属预览版模型。'
      },
      {
        id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
        name: 'Nemotron 3 Nano Omni (free)',
        caps: {
          capability: 3,
          speed: 4,
          contextWindow: 256000,
          maxTokens: 32768,
          vision: true,
          toolCalling: true
        },
        verified: {
          at: '2026-10-15T21:20:00+08:00',
          method: 'anonymous GET https://openrouter.ai/api/v1/models (+ /models/<id>/endpoints)',
          pricing: { prompt: '0', completion: '0' },
          endpoints: 1,
          endpointPricingZero: true,
          bodySha256: 'fe83d51d8696c1b21cea8b522876a439bb1e35ca4f412485e19f1bf7353184bb'
        },
        source: '新增 2026-10-15（本家扩容扫描）。contextWindow 256000 与 upstream max_completion_tokens 65536 取自带凭据的 GET https://openrouter.ai/api/v1/models（零价条目，pricing 全 "0"）；maxTokens 按 CONSERVATIVE_CAPS 取 32768。toolCalling true 为**实测**（一工具探针，控制组 200，结构化 tool_calls + JSON 合法 + 必填项齐备）。**vision true 为实测**：`_lead/probe-vision-live.mjs` 用一张纯红与一张纯蓝 32x32 PNG 提同一个问题，模型分别答 "red" / "blue"（各答中自己那张图）⇒ VISION CONFIRMED。上游 architecture.input_modalities 另声明 audio/video 输入，**本行只声明 vision，即仅承认已实测的那一项**。**这一条与 dots-studio/dots-3-note-preview 一起解除了本家此前"没有视觉模型"的约束。** capability 3 / speed 4 是**判断**：上游描述为 30B-A3B 多模态子代理模型，故取"能力中等、速度较高"，**不是测量值**。'
      }
    ]
  },
  {
    id: 'mistral',
    displayName: 'Mistral',
    baseURL: 'https://api.mistral.ai/v1',
    apiKeyEnv: 'MISTRAL_API_KEY',
    keyURL: 'https://console.mistral.ai/api-keys',
    keyless: false,
    enabled: false,
    confidence: 'confirmed',
    limits: {
      rpm: null,
      rpd: null,
      tpm: 500000,
      tpd: null,
      note: '免费 Experiment 池：约 1 req/s（≈60 RPM，上游按每秒计）、500K TPM，月度 token 预算共享（上游量级 ~1B/月，目录按 ~50-100M 保守估计）'
    },
    models: [
      {
        id: 'mistral-large-latest',
        name: 'Mistral Large',
        caps: {
          capability: 4,
          speed: 3,
          contextWindow: 131072,
          maxTokens: 32768,
          vision: false,
          toolCalling: true
        },
        source: 'server/src/db/migrations/20260101_000000_legacy_baseline.ts:319 (seedModels)；tool via V22 :1768 (%mistral-large%)'
      },
      {
        id: 'magistral-medium-latest',
        name: 'Magistral Medium',
        caps: {
          capability: 4,
          speed: 3,
          contextWindow: 40000,
          maxTokens: 16384,
          vision: false,
          toolCalling: true
        },
        source: 'server/src/db/migrations/20260101_000000_legacy_baseline.ts:320 (seedModels)；tool via V22 :1771'
      },
      {
        id: 'codestral-latest',
        name: 'Codestral',
        caps: {
          capability: 3,
          speed: 4,
          contextWindow: 32000,
          maxTokens: 16384,
          vision: false,
          toolCalling: true
        },
        source: 'server/src/db/migrations/20260101_000000_legacy_baseline.ts:321 (seedModels)；tool via V22 :1772'
      }
    ]
  },
  {
    id: 'zhipu',
    displayName: 'Zhipu (Z.ai / bigmodel.cn)',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyEnv: 'ZHIPU_API_KEY',
    keyURL: 'https://open.bigmodel.cn/usercenter/apikeys',
    keyless: false,
    enabled: false,
    confidence: 'speculative',
    limits: {
      rpm: null,
      rpd: null,
      tpm: null,
      tpd: 1000000,
      note: 'GLM Flash 系列按 1M TPD 计（上游基线的 tpd_limit=1000000）；月度量级标记为 ~30M。**baseURL 为推测**：上游 registry 的家用默认主机是 open.bigmodel.cn（国内站），另一可用主机是 api.z.ai（海外站），两者 key 不互通（ZhipuProvider 会在校验时自动改写探测另一主机）；实现前请用一次真实 key 验证所选主机'
    },
    models: [
      {
        id: 'glm-4.7-flash',
        name: 'GLM-4.7 Flash',
        caps: {
          capability: 4,
          speed: 4,
          contextWindow: 131072,
          maxTokens: 32768,
          vision: false,
          toolCalling: true
        },
        source: 'server/src/db/migrations/20260101_000000_legacy_baseline.ts:879 (migrateModelsV11)；tool via V22 :1762 (%glm-%)',
        speculative: true
      },
      {
        id: 'glm-4.6v-flash',
        name: 'GLM-4.6V Flash',
        caps: {
          capability: 3,
          speed: 4,
          contextWindow: 131072,
          maxTokens: 16384,
          vision: true,
          toolCalling: true
        },
        source: 'server/src/db/migrations/20260101_000000_legacy_baseline.ts:1859 (migrateModelsV23)；vision 于 2026-06-07 live-probed（V16 :1457）；tool via V22 :1762',
        speculative: true
      }
    ]
  },
  {
    id: 'volcengine',
    displayName: 'Volcengine Ark (ByteDance)',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKeyEnv: 'ARK_API_KEY',
    keyURL: 'https://console.volcengine.com/ark',
    keyless: false,
    enabled: false,
    confidence: 'speculative',
    limits: {
      rpm: null,
      rpd: null,
      tpm: null,
      tpd: 2000000,
      note: '个人开发者每个模型 2M tokens/日，另有一次性 500K 新用户额度；需完成中国站实名认证'
    },
    models: [
      {
        id: 'doubao-seed-1-6-250615',
        name: 'Doubao Seed 1.6',
        caps: {
          capability: 4,
          speed: 3,
          contextWindow: 131072,
          maxTokens: 16384,
          vision: false,
          toolCalling: false
        },
        source: '推测：模型 id 未在 freellmapi 迁移基线的 id 集合中出现（上游把该家模型行放在托管目录）。baseURL 与免费额度已确证：providers/index.ts:574-578 + docs/en/providers/01-supported-platforms.md:57',
        speculative: true
      }
    ]
  },
  {
    id: 'longcat',
    displayName: 'LongCat (Meituan)',
    baseURL: 'https://api.longcat.chat/openai/v1',
    apiKeyEnv: 'LONGCAT_API_KEY',
    keyURL: 'https://longcat.chat/platform/api_keys',
    keyless: false,
    enabled: false,
    confidence: 'speculative',
    limits: {
      rpm: null,
      rpd: null,
      tpm: null,
      tpd: null,
      note: '每日免费额度（上游未给出具体数字，记为未公开）；中国厂商中唯一支持海外邮箱注册、无需实名的一家（providers/index.ts:580-586 注释）'
    },
    models: [
      {
        id: 'LongCat-Flash-Chat',
        name: 'LongCat Flash Chat',
        caps: {
          capability: 3,
          speed: 3,
          contextWindow: 131072,
          maxTokens: 16384,
          vision: false,
          toolCalling: false
        },
        source: '推测：模型 id 未在 freellmapi 迁移基线的 id 集合中出现。baseURL 已确证：providers/index.ts:582-586 + docs/en/providers/01-supported-platforms.md:58',
        speculative: true
      }
    ]
  },
  {
    id: 'llm7',
    displayName: 'LLM7',
    baseURL: 'https://api.llm7.io/v1',
    apiKeyEnv: 'LLM7_API_KEY',
    keyURL: 'https://token.llm7.io/',
    keyless: true,
    enabled: true,
    confidence: 'confirmed',
    limits: {
      rpm: 100,
      rpd: null,
      tpm: null,
      tpd: null,
      note: '免费 100 req/hr（上游基线按 100 RPM 记账，实为每小时额度，实现侧应按小时桶限流）；基础模型允许匿名调用（无 key）'
    },
    models: [
      {
        id: 'codestral-latest',
        name: 'Codestral (LLM7)',
        caps: {
          capability: 3,
          speed: 4,
          contextWindow: 32000,
          maxTokens: 16384,
          vision: false,
          toolCalling: true
        },
        source: 'contextWindow measured 2026-10-13 from `GET https://api.llm7.io/v1/models` → context_window.tokens=32000 (confirms the catalogue value). tool via V22 :1772'
      },
      {
        id: 'DeepSeek-V4-Flash-0731',
        name: 'DeepSeek V4 Flash (LLM7)',
        caps: {
          contextWindow: 400000,
          maxTokens: 32768,
          capability: 4,
          speed: 4,
          vision: false,
          toolCalling: true
        },
        source: 'contextWindow measured 2026-10-13 from `GET https://api.llm7.io/v1/models` → context_window.tokens=400000 (confirms the shipped value). lead live probe 2026-10-13: anonymous HTTP 200; tools:true, reasoning:true'
      }
    ]
  },
  {
    id: 'kilo',
    displayName: 'Kilo Gateway',
    baseURL: 'https://api.kilo.ai/api/gateway/v1',
    apiKeyEnv: 'KILO_API_KEY',
    keyURL: null,
    keyless: true,
    enabled: true,
    confidence: 'confirmed',
    limits: {
      rpm: null,
      rpd: null,
      tpm: null,
      tpd: null,
      note: '**keyless**：匿名（免 key）即可用 :free 路由，200 req/hr per IP。上游以 keyless:true 注册（不发 Authorization 头），因此 key 缺失是正常状态而非错误。提示：免费 prompt/输出会被记录用于训练（providers/index.ts:262-266）'
    },
    models: [
      {
        id: 'nvidia/nemotron-3-super-120b-a12b:free',
        name: 'Nemotron 3 Super 120B (Kilo)',
        caps: {
          capability: 5,
          speed: 3,
          contextWindow: 262144,
          maxTokens: 32768,
          vision: false,
          toolCalling: true
        },
        verified: {
          at: '2026-10-15T19:27:52+08:00',
          method: 'anonymous GET https://api.kilo.ai/api/gateway/models (gateway-published row and pricing)',
          pricing: { prompt: '0', completion: '0' },
          endpoints: 1,
          endpointPricingZero: true,
          bodySha256: '57257ffe3a1f6737c96f049946c3764d7ce9245d90cd865fbc77c43b3c1d90ce'
        },
        source: 'contextWindow measured 2026-10-13 from `GET https://api.kilo.ai/api/gateway/models` → context_length=262144 (the value shipped before this was 1000000, a 4x overstatement that let the router pick this model for a 297k-token session and get a 400). tool via V22 :1780 (%nemotron-3-super%) ｜ 2026-10-15 free 判据复核：匿名 GET https://api.kilo.ai/api/gateway/models（394 条，响应体 sha256 57257ffe3a1f6737c96f049946c3764d7ce9245d90cd865fbc77c43b3c1d90ce）→ 本 id 在售、isFree=true、pricing={"prompt":"0","completion":"0","discount":0}。kilo 网关直接发布它所服务的每个模型及其价格，因此该目录行即服务端点（verified.endpoints=1 表示网关在服务它）。'
      },
      {
        id: 'nvidia/nemotron-3-ultra-550b-a55b:free',
        name: 'Nemotron 3 Ultra 550B (Kilo)',
        caps: {
          contextWindow: 1000000,
          maxTokens: 32768,
          capability: 5,
          speed: 3,
          vision: false,
          toolCalling: true
        },
        verified: {
          at: '2026-10-15T19:27:52+08:00',
          method: 'anonymous GET https://api.kilo.ai/api/gateway/models (gateway-published row and pricing)',
          pricing: { prompt: '0', completion: '0' },
          endpoints: 1,
          endpointPricingZero: true,
          bodySha256: '57257ffe3a1f6737c96f049946c3764d7ce9245d90cd865fbc77c43b3c1d90ce'
        },
        source: 'contextWindow measured 2026-10-13 from `GET https://api.kilo.ai/api/gateway/models` → context_length=1000000 (the value shipped before this was 131072, an 8x understatement that made the context gate skip the only model in the pool that could hold a 297k-token session). lead live probe 2026-10-13: GET /v1/models isFree=true; vision false assumed ｜ 2026-10-15 free 判据复核：同一匿名端点（394 条，响应体 sha256 57257ffe3a1f6737c96f049946c3764d7ce9245d90cd865fbc77c43b3c1d90ce）→ isFree=true、pricing={"prompt":"0","completion":"0","discount":0}；目录行即服务端点。'
      },
      {
        id: 'poolside/laguna-s-2.1:free',
        name: 'Poolside Laguna S 2.1 (Kilo)',
        caps: {
          contextWindow: 262144,
          maxTokens: 32768,
          capability: 4,
          speed: 4,
          vision: false,
          toolCalling: false
        },
        verified: {
          at: '2026-10-15T19:27:52+08:00',
          method: 'anonymous GET https://api.kilo.ai/api/gateway/models (gateway-published row and pricing)',
          pricing: { prompt: '0', completion: '0' },
          endpoints: 1,
          endpointPricingZero: true,
          bodySha256: '57257ffe3a1f6737c96f049946c3764d7ce9245d90cd865fbc77c43b3c1d90ce'
        },
        source: 'contextWindow measured 2026-10-13 from `GET https://api.kilo.ai/api/gateway/models` → context_length=262144. Replaces poolside/laguna-m.1:free which returned HTTP 404 ｜ 2026-10-15 free 判据复核：同一匿名端点（394 条，响应体 sha256 57257ffe3a1f6737c96f049946c3764d7ce9245d90cd865fbc77c43b3c1d90ce）→ 在售、isFree=true、pricing={"prompt":"0","completion":"0","discount":0}；目录行即服务端点。'
      },
      {
        id: 'cohere/north-mini-code:free',
        name: 'Cohere North Mini Code (Kilo)',
        caps: {
          contextWindow: 256000,
          maxTokens: 16384,
          capability: 3,
          speed: 4,
          vision: false,
          // Measured 2026-10-15 on the KILO gateway, anonymously (this provider is
          // keyless): a one-tool request returned a structured `tool_calls` entry with
          // valid JSON and the required argument present (control HTTP 200).
          //
          // This CLOSES the toolCalling contradiction that had been recorded rather
          // than papered over. It was first noted as "our false vs OpenRouter's
          // supported_parameters says tools"; the OpenRouter side was then measured
          // true, and the honest reading at that point was "two endpoints, two facts".
          // The kilo endpoint has now been measured too, and it is also true — so the
          // two routes agree after all, and both rows say so on evidence.
          toolCalling: true
        },
        verified: {
          at: '2026-10-15T19:27:52+08:00',
          method: 'anonymous GET https://api.kilo.ai/api/gateway/models (gateway-published row and pricing)',
          pricing: { prompt: '0', completion: '0' },
          endpoints: 1,
          endpointPricingZero: true,
          bodySha256: '57257ffe3a1f6737c96f049946c3764d7ce9245d90cd865fbc77c43b3c1d90ce'
        },
        source: 'contextWindow measured 2026-10-13 from `GET https://api.kilo.ai/api/gateway/models` → context_length=256000. lead live probe 2026-10-13: GET /v1/models isFree=true ｜ 2026-10-15 free 判据复核：同一匿名端点（394 条，响应体 sha256 57257ffe3a1f6737c96f049946c3764d7ce9245d90cd865fbc77c43b3c1d90ce）→ isFree=true、pricing={"prompt":"0","completion":"0","discount":0}；目录行即服务端点。'
      }
    ]
  },
  {
    id: 'nvidia',
    displayName: 'NVIDIA NIM',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    apiKeyEnv: 'NVIDIA_API_KEY',
    keyURL: null,
    keyless: false,
    enabled: false,
    confidence: 'confirmed',
    limits: {
      rpm: 40,
      rpd: null,
      tpm: null,
      tpd: null,
      note: '免费访问为 40 RPM 限速（2025 年信用体系已停止）；上游把该家月度量级标为 credits-based 且默认关闭若干行，稳定性弱于其他家，建议默认不启用。该家部分模型拒绝并行 tool calls，需固定 parallel_tool_calls=false；首字节可能极慢（上游给 180s 超时）'
    },
    models: [
      {
        id: 'meta/llama-3.3-70b-instruct',
        name: 'Llama 3.3 70B (NV)',
        caps: {
          capability: 4,
          speed: 3,
          contextWindow: 131072,
          maxTokens: 32768,
          vision: false,
          toolCalling: true
        },
        source: 'server/src/db/migrations/20260101_000000_legacy_baseline.ts:1043 (migrateModelsV11，2026-05 live-probed)；tool via V22 :1758'
      },
      {
        id: 'qwen/qwen3-coder-480b-a35b-instruct',
        name: 'Qwen3-Coder 480B (NV)',
        caps: {
          capability: 5,
          speed: 3,
          contextWindow: 262144,
          maxTokens: 32768,
          vision: false,
          toolCalling: true
        },
        source: 'server/src/db/migrations/20260101_000000_legacy_baseline.ts:1340 (migrateModelsV13)；tool via V22 :1763'
      }
    ],
    extraBody: {
      parallel_tool_calls: false
    }
  },
  {
    id: 'ovh',
    displayName: 'OVH AI Endpoints',
    baseURL: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
    apiKeyEnv: 'OVH_AI_ENDPOINTS_KEY',
    keyURL: null,
    keyless: true,
    enabled: false,
    confidence: 'confirmed',
    limits: {
      rpm: 2,
      rpd: null,
      tpm: null,
      tpd: null,
      note: '**keyless** 匿名档：文档写 2 req/min per IP per model（实测更严）；已认证档 400 RPM 但需要带付款方式的 Public Cloud 项目，故本目录只收匿名档。上游以 keyless:true 注册（providers/index.ts:323-328，2026-06-10 live-probed）'
    },
    models: [
      {
        id: 'gpt-oss-120b',
        name: 'GPT-OSS 120B (OVH)',
        caps: {
          capability: 4,
          speed: 3,
          contextWindow: 131072,
          maxTokens: 16384,
          vision: false,
          toolCalling: true
        },
        source: 'providers/index.ts:320-321（2026-06-10 live-probed 结构化 tool_calls）；模型 id 出处为同段注释；tool via V22 :1757'
      },
      {
        id: 'Meta-Llama-3_3-70B-Instruct',
        name: 'Llama 3.3 70B (OVH)',
        caps: {
          capability: 4,
          speed: 3,
          contextWindow: 131072,
          maxTokens: 16384,
          vision: false,
          toolCalling: true
        },
        source: 'providers/index.ts:320-321（2026-06-10 live-probed 结构化 tool_calls）；tool via V22 :1758。注意该 id 用下划线形式（3_3），与多数家的 3.3 写法不同'
      }
    ]
  },

  /* ── v0.7 additions — 6 providers, all `enabled: false` ──────────────────
   * Shipped off by default on purpose (task book §5 S2): catalog first, real-key
   * verification later (S3). `enabled: false` keeps them out of the generated
   * browser table, which only carries `enabled === true` rows (AC3).
   * Every `source`/`note` below cites an upstream commit
   * `5a3abac8b4286cdfdc6dd53f1b99290cc804be2d` path:line, or says plainly that
   * the value is not from upstream.
   * ------------------------------------------------------------------------ */
  {
    id: 'modelscope',
    displayName: 'ModelScope 魔搭',
    baseURL: 'https://api-inference.modelscope.cn/v1',
    apiKeyEnv: 'MODELSCOPE_API_KEY',
    keyURL: 'https://modelscope.cn/my/myaccesstoken',
    keyless: false,
    enabled: false,
    confidence: 'confirmed',
    limits: {
      rpm: null,
      rpd: null,
      tpm: null,
      tpd: null,
      note: '**准入门槛（非技术阻塞）**：token 必须把 ModelScope 账号绑定到阿里云中国站 + 中国实名认证账号，未绑定的 token 每次调用 401 `please bind your alibaba cloud account before use` —— providers/index.ts:541-544、modelscope.ts:56-59。额度：providers/index.ts:540 写 2000 requests/day account-wide，但同一上游在 modelscope.ts:45-53 把该数字标为 historical（现按魔粒计费，2026-08-14 观察 2 魔粒/ultra 请求）⇒ **本条目不给 RPM/RPD 数字**，四档全 null。keyURL 取自 providers/index.ts:541 的 modelscope.cn/my/myaccesstoken。'
    },
    models: [
      {
        id: 'deepseek-ai/DeepSeek-V4-Flash-0731',
        name: 'DeepSeek V4 Flash (魔搭)',
        caps: {
          capability: 4,
          speed: 3,
          contextWindow: 131072,
          maxTokens: 8192,
          vision: false,
          toolCalling: false
        },
        source: 'id 逐字来自 2026-10-15 实测匿名 `GET https://api-inference.modelscope.cn/v1/models`（HTTP 200，36 条）；该 id 也是 T2 唯一用真实 id 补测过 chat 的 id —— 匿名与假凭据均 401（证明该 id 被接受、鉴权在 chat 上）。contextWindow **estimate，无上游依据、无实测目录字段**：该目录只返回 id/object/owned_by/created，**没有任何 context 字段**，因此这里取保守默认值 131072 —— **这是一个保守取值，不是实测值，也不是从上游任何一行读到的**（此前版本曾引用池内其它家的同族条目作为理由，T4-F3 已删除该跨家引用）。maxTokens 同为保守默认值。该 id 不在上游仓库任何位置（上游把模型行放在托管目录，providers/index.ts:562-564）。'
      },
      {
        id: 'Qwen/Qwen3.8-Flash-Next',
        name: 'Qwen3.8 Flash Next (魔搭)',
        caps: {
          capability: 4,
          speed: 3,
          contextWindow: 131072,
          maxTokens: 8192,
          vision: false,
          toolCalling: false
        },
        note: 'id 逐字来自 2026-10-15 实测匿名 `GET .../v1/models`（36 条花名册）。**无上游仓库行、无实测 context**：contextWindow 131072 与 maxTokens 为保守 estimate（该目录无 context 字段）。⚠️ 该花名册对**假凭据返回字节级相同的 36 条**（modelscope.ts:31-35 记录 + T2 复现）⇒ 它是平台花名册，**不代表本账号可调用集合**，本条目不做 entitlement 断言。'
      },
      {
        id: 'ZhipuAI/GLM-4.7-Flash',
        name: 'GLM-4.7 Flash (魔搭)',
        caps: {
          capability: 4,
          speed: 4,
          contextWindow: 131072,
          maxTokens: 8192,
          vision: false,
          toolCalling: false
        },
        source: 'id 逐字来自 2026-10-15 实测匿名 `GET .../v1/models`。contextWindow **estimate，无上游依据、无实测目录字段**（该目录无 context 字段）：131072 是保守默认值，**不是本 id 的实测值**。此前版本曾引用上游 `legacy_baseline.ts:879`（`zhipu/glm-4.7-flash` 的落库值）作为理由 —— T4-F3 已删除该跨家引用：**魔搭的 id 与 zhipu 的 id 是两家平台的两次注册，别家的落库值不构成本家 id 的证据。** toolCalling 保守取 false（无本 id 的代码或实测证据）。'
      }
    ]
  },
  {
    id: 'xfyun',
    displayName: 'iFlytek Spark 讯飞星火',
    baseURL: 'https://spark-api-open.xf-yun.com/v1',
    apiKeyEnv: 'XFYUN_API_KEY',
    keyURL: 'https://console.xfyun.cn/',
    keyless: false,
    enabled: false,
    confidence: 'speculative',
    limits: {
      rpm: null,
      rpd: null,
      tpm: null,
      tpd: null,
      note: '**四档全 null 是上游规则要求的**：上游 docs/en/providers/03-adding-a-new-provider.md:60 逐字 —— If the platform publishes no limits, set null rather than guessing；docs/en/providers/01-supported-platforms.md:59 逐字 —— no published token/QPS ceiling (#936) ⇒ 无任何公开上限数字可引。鉴权：console 的 APIPassword 当 Bearer token（providers/index.ts:590 逐字 Auth is the console APIPassword as a Bearer token; the Lite model is the free one）。**需中国实名认证**（providers/index.ts:560-561 逐字：Every one of these requires Chinese real-name verification on the cloud account before a key serves traffic），这会直接影响零配置可用的定位。**订正（2026-10-15）**：厂商官方文档页已**经直连**取得（HTTP 200 / 128 382 B / `Server: Tengine`），其版本表把 **Lite** 写为「轻量级大语言模型，具有更高的响应速度，**支持免费使用**」——即**厂商确实明示 Lite 免费**，与本条目 free 侧的定性一致；但该页**只给定性、未给任何 RPM/RPD/TPM/TPD 数字**，故四档维持 `null` 仍然正确，且「需一把真 key 才能核实额度实数」这一结论**不受订正影响**。'
    },
    models: [
      {
        id: 'lite',
        name: 'Spark Lite (讯飞星火)',
        caps: {
          capability: 3,
          speed: 4,
          contextWindow: 8192,
          maxTokens: 4096,
          vision: false,
          toolCalling: false
        },
        note: '**该 id 已由厂商文档证实，不再是规格占位。** 上游只说免费的是 Lite 档 —— providers/index.ts:591 与 docs/en/providers/01-supported-platforms.md:59 逐字 the Lite model is the documented free one —— 而**仓库侧没有这个 id 的字符串**。**已尝试的取证路径与结果**：①全部 40 个上游 migration 中搜 xfyun **零命中**（上游把模型行放在托管目录，providers/index.ts:562-564）；②`GET /v1/models` 匿名与假凭据**均 401**（T2 四变体，需真凭据，目录未取得）；③**厂商官方文档：已取得**（2026-10-15，经**直连**路径，HTTP 200 / 128 382 B / `Server: Tengine`）—— `https://www.xfyun.cn/doc/spark/HTTP调用文档.html` 逐字把 `model` 的取值列为 `4.0Ultra` / `generalv3.5` / `max-32k` / `generalv3` / `pro-128k` / `lite`，且其版本表把 **Lite** 写为「轻量级大语言模型，具有更高的响应速度，**支持免费使用**」。⇒ 上游的 the Lite model is the documented free one 与厂商文档一致，`lite` 是该端点的合法服务名。**订正记录**：本条此前写「该 id 未经上游或实测确认，属规格占位」并称「本机网络无法访问任何中文厂商/文档站点」（依据是 resolves to a non-public IP address）—— **该依据已撤回**，那是本机 DNS 守卫对智能分流 VPN fake-IP（`198.18.0.0/15`）解析结果的拒绝，属工具限制而非站点属性（同一会话同句话亦拒绝了 `github.com`），故路径③并非失败而是当时未走通。**仍未证实**：从未有有效凭据用过它（chat 在凭据校验前即 401，`generalv3.5` 与不存在的 id 返回同一个 401，故服务名无法用假凭据证伪）。**后续动作（S3）**：仍需一把真实 key 跑一次真实 chat 补全，确认服务名被后端接受且免费额度为真。**数值来源（2026-10-15 订正）**：`contextWindow` 由 `32768` 改为 **`8192`**。依据是厂商同一张表（就挂在 `2.1 语言模型` 小节、正文给出的 `spark-api-open.xf-yun.com/v1/chat/completions` 即本池 baseURL 的正下方）：Lite 列「最大输入长度 **8K**」、`Max`/`Pro` 用 `8K\\32K`、`8K\\128K` 反斜杠并列而 **Lite 列是单值 `<td>8K</td>`** ⇒ 属**固定上限**，非可选子档。⚠️ **厂商原文写的是 `8K` 而非 `8192`**：`8192` 是按**同表内部记法**折算（同表 `4K` 对应 `maxTokens 4096`，即 `4×1024`，故 `8K = 8×1024`）——**这是折算值，不是厂商逐字原文，可被审计勿被当成原文引用**。**仍未证实（真未知项）**：厂商未逐字说明 8K 是"输入上限"还是"输入+输出合计"；**若为合计，8192 仍可能偏大**，需随 S3 真 key 实测确认。原 `32768` **无任何来源**（既非 upstream 亦非实测），且高出文档上限 4 倍；偏大的后果是把装不下的上下文**静默**发出去，故不必保留免责声明而应直接订正。`maxTokens 4096` 与厂商「最大输出 4K」一致（同为同表折算），保留。完整取证见 `_lead/research/xfyun-lite-limits.md`（R7/task-14）。'
      }
    ]
  },
  {
    id: 'siliconflow',
    displayName: 'SiliconFlow 硅基流动',
    baseURL: 'https://api.siliconflow.com/v1',
    apiKeyEnv: 'SILICONFLOW_API_KEY',
    keyURL: 'https://cloud.siliconflow.com/account/ak',
    keyless: false,
    enabled: false,
    confidence: 'speculative',
    limits: {
      rpm: null,
      rpd: null,
      tpm: null,
      tpd: null,
      note: '⚠️ **chat 侧没有可循环免费额度，上游已明确否定并被主动 DELETE 掉模型行。** legacy_baseline.ts:1398-1407（migrateModelsV15，基线 May 2026）逐字：SiliconFlow was briefly added (#131) on the belief Qwen/Qwen3-8B was a $0 free model. Re-verification showed it is PAID ($0.06/M in+out) … SiliconFlow 的 .com 端点是 one-time $1 trial credit, not a recurring free tier。删除语句在 :1415。上游把它留在注册表里，是为了**免费的生成式媒体模型**（FLUX.1-schnell 图像、CosyVoice2 TTS，providers/index.ts:373-375）——而媒体端点在 DSH 的 LlmAdapter seam 上用不了（任务书 §3.3 已划掉媒体类）。**⇒ 本条的免费部分恰好是本池用不上的那一半**，这也是 confidence 取 speculative 的原因。四档额度全 null（上游未给 RPM/RPD/TPM/TPD）。baseURL 用 .com（上游逐字 providers/index.ts:381），**不要**换成 .cn —— 上游只用 .com，.cn 与 .com 的关系在上游 57 个已取证文件中无任何说明（T1 U5）。'
    },
    models: [
      {
        id: 'Qwen/Qwen3-8B',
        name: 'Qwen3 8B (硅基流动)',
        caps: {
          capability: 3,
          speed: 4,
          contextWindow: 32768,
          maxTokens: 8192,
          vision: false,
          toolCalling: false
        },
        source: 'id 逐字见 legacy_baseline.ts:1400（migrateModelsV15 注释里的 Qwen/Qwen3-8B）。⚠️ 同一条注释的结论是**该模型不是 $0 免费**（实为 $0.06/M in+out，零成本读数是 4 位小数舍入假象）⇒ 收录该 id 仅为满足 models[] 非空并留档，**不构成免费可用断言**。contextWindow **estimate，无上游依据、无实测数据**：该家 `GET /v1/models` 需真凭据（T2 四变体全 401，带 www-authenticate RFC 6750 挑战），**目录未取得**；32768 是保守默认值。此前版本曾引用 `legacy_baseline.ts:321` 作为理由 —— T4-F3 已删除：那一行是 **`mistral/codestral-latest`** 的落库值（32000），**与本家、与本 id 均无关**，用别家的数字当依据会让读者误以为有证据。'
      }
    ]
  },
  {
    id: 'sambanova',
    displayName: 'SambaNova',
    baseURL: 'https://api.sambanova.ai/v1',
    apiKeyEnv: 'SAMBANOVA_API_KEY',
    keyURL: 'https://cloud.sambanova.ai/apis',
    keyless: false,
    enabled: false,
    confidence: 'speculative',
    limits: {
      rpm: null,
      rpd: null,
      tpm: null,
      tpd: null,
      note: '🚩 **上游已把该家退役，理由是免费额度永久取消 —— 收进来只为留档，默认关闭。** server/src/providers/index.ts:148-151 逐字：SambaNova was dropped in V23 (June 2026): the free tier is permanently gone. …once it lapses, every chat call 402s payment method required with no recurring no-card path back；shared/types.ts:61-62 说明保留 id 只为历史 key 行；官方状态表 docs/en/providers/01-supported-platforms.md:28 逐字 `Retired (V23) | Not registered`。**两条 baseURL provenance 警告**：①`api.sambanova.ai` 在上游文件里**零匹配**（该家已无 adapter）⇒ **不是上游转录，来自厂商公开文档**；②本条的 models[] id 与 contextWindow 来自 2026-10-15 实测匿名 `GET https://api.sambanova.ai/v1/models`（HTTP 200，6 条），上游把该 200 记作 billing gate 假阳性：legacy_baseline.ts:1803-1804 逐字 /v1/models still 200s (billing gate, not a key problem) —— **即目录绿不代表 chat 可用，持有效 key 时可能每次 402**。历史额度（已失效，仅考古）：legacy_baseline.ts:626-629 的 rpm 20 / rpd 20。'
    },
    models: [
      {
        id: 'DeepSeek-V3.1',
        name: 'DeepSeek V3.1 (SambaNova)',
        caps: {
          capability: 5,
          speed: 3,
          contextWindow: 131072,
          maxTokens: 7168,
          vision: false,
          toolCalling: false
        },
        source: 'contextWindow **measured** 2026-10-15 from `GET https://api.sambanova.ai/v1/models` → context_length=131072（匿名 200；带假凭据返回字节级相同的 body）；同一条目的 max_completion_tokens=7168 即此处 maxTokens 的实测来源。该 id 的历史上游行见 legacy_baseline.ts:626（migrateModelsV4，token 上限 tpd 200000 —— **已随 V23 删除**，不可当现值）。'
      },
      {
        id: 'Meta-Llama-3.3-70B-Instruct',
        name: 'Llama 3.3 70B (SambaNova)',
        caps: {
          capability: 4,
          speed: 4,
          contextWindow: 131072,
          maxTokens: 3072,
          vision: false,
          toolCalling: false
        },
        source: 'contextWindow **measured** 2026-10-15 from `GET https://api.sambanova.ai/v1/models` → context_length=131072（max_completion_tokens=3072 即 maxTokens 的实测来源）。历史上游行 legacy_baseline.ts:317（seedModels，当时的落库 context_window 是 8192 —— 与本条实测值冲突，**以实测为准**）。'
      },
      {
        id: 'gpt-oss-120b',
        name: 'GPT-OSS 120B (SambaNova)',
        caps: {
          capability: 4,
          speed: 4,
          contextWindow: 131072,
          maxTokens: 131072,
          vision: false,
          toolCalling: false
        },
        source: 'contextWindow **measured** 2026-10-15 from `GET https://api.sambanova.ai/v1/models` → context_length=131072（max_completion_tokens=131072，本条两者一致）。历史上游行 legacy_baseline.ts:629（migrateModelsV4，当时落库 131072，与实测一致）。'
      },
      {
        id: 'MiniMax-M3',
        name: 'MiniMax M3 (SambaNova)',
        caps: {
          capability: 4,
          speed: 3,
          contextWindow: 1048576,
          maxTokens: 1048576,
          vision: false,
          toolCalling: false
        },
        source: 'contextWindow **measured** 2026-10-15 from `GET https://api.sambanova.ai/v1/models` → context_length=1048576（max_completion_tokens=1048576）。**无上游仓库行**（该 id 不在 legacy_baseline 的任何 sambanova 行里 —— 那 7 行见 :317,:626-629,:911-912，均不含 MiniMax）。'
      }
    ]
  },
  {
    id: 'huggingface',
    displayName: 'HuggingFace Router',
    baseURL: 'https://router.huggingface.co/v1',
    apiKeyEnv: 'HUGGINGFACE_API_KEY',
    keyURL: 'https://huggingface.co/settings/tokens',
    keyless: false,
    enabled: false,
    confidence: 'confirmed',
    limits: {
      rpm: null,
      rpd: null,
      tpm: null,
      tpd: null,
      note: '免费形态是**账户额度**而非目录标记：providers/index.ts:237 逐字 Recurring $0.10/mo router credit on the free tier, no card required；换算 ~1-3M token/月（legacy_baseline.ts:330 逐字 budget closer to 1-3M on a 70B model，落库值 `~1-3M` 见 :331,:1354-1356）。四档速率全 null（上游未给 RPM/RPD/TPM/TPD）。⚠️ T2 实测 `GET /v1/models` 的 296 条 provider 行里 **is_free 为 true 的 0 条** ⇒ 免费性读不出目录，只能来自账户 credit，两者一致。$0.10/mo 的基线日期上游未标注（T1 U6）。'
    },
    models: [
      {
        id: 'deepseek-ai/DeepSeek-V4-Flash',
        name: 'DeepSeek V4 Flash (HF Router)',
        caps: {
          capability: 4,
          speed: 3,
          contextWindow: 131072,
          maxTokens: 8192,
          vision: false,
          toolCalling: false
        },
        source: 'id 逐字见上游 legacy_baseline.ts:1354（migrateModelsV15 additions；该行落库 context_window=131072，且实测目录中存在该 id）。contextWindow 取 **131072 这个保守下界**，依据：2026-10-15 实测匿名 `GET https://router.huggingface.co/v1/models` 显示该 id 由多个后端提供、`providers[].context_length` **逐后端不同**（deepinfra 报 1048576，另有后端报 131072）—— **不取最大值**，因为那是把某一个后端的能力冒充成这个 router id 的能力（取高值正是本项目 contextWindow 事故的成因）。**选定的后端值：131072（与上游落库值一致）**。'
      },
      {
        id: 'moonshotai/Kimi-K2.6',
        name: 'Kimi K2.6 (HF Router)',
        caps: {
          capability: 5,
          speed: 3,
          contextWindow: 262144,
          maxTokens: 8192,
          vision: false,
          toolCalling: false
        },
        source: 'id 与 contextWindow 双重一致：上游 legacy_baseline.ts:1355（migrateModelsV15，落库 context_window=262144）+ 2026-10-15 实测匿名 `GET .../v1/models` → 该 id 的 providers[] 中 novita 与 deepinfra **两个后端均报 context_length=262144**（选定的后端值，两者一致）。⚠️ 实测该 id 的 input_modalities 含 image，但 vision 仍保守取 false（无本 house 的代码级或补全实测证据，见头部保守能力声明）；toolCalling 同样取 false。'
      }
    ]
  },
  {
    id: 'routeway',
    displayName: 'Routeway',
    baseURL: 'https://api.routeway.ai/v1',
    apiKeyEnv: 'ROUTEWAY_API_KEY',
    keyURL: 'https://routeway.ai/',
    keyless: false,
    enabled: false,
    // Not `confirmed`: the baseURL transcription and the measured catalog are
    // solid, but this provider's anonymous chat path is an open AMBIGUOUS
    // (Cloudflare interstitial vs origin 401 — see `limits.note`). T4 audit
    // finding T4-F1: the field must reflect that, not just the URL evidence.
    confidence: 'speculative',
    limits: {
      rpm: null,
      rpd: null,
      tpm: null,
      tpd: null,
      note: '⚠️ **本家的匿名 chat 路径判定为 AMBIGUOUS，未定论（如实留档）。** 方法（T2，2026-10-15，本机直连未用代理，出口 US-LA）：匿名 `POST /v1/chat/completions` → **403 `text/html` 5771B，`<title>Attention Required! | Cloudflare</title>`**（Cloudflare WAF 拦截页，`cf-ray …-LAX`，无 `x-request-id`）——**这不是 API 响应**；同一请求**带语法合法但无效的 `Authorization` 头** → **401 干净 JSON `Invalid API key`**（到 origin，带 `x-request-id`）。⇒ 403 的三种含义（拒匿名/拒假凭据/真封锁）在此无法单条区分。**后续动作**：需①一把真实免费 key 跑一次真实补全（200 即定论，同时验证免费额度真伪）②换出口 IP 复测。**不受影响的部分**：可达性本身不歧义（带凭据到 origin 401）。额度：providers/index.ts:397-398 逐字 docs say 20 rpm / 200 rpd, but a live test on 2026-06-26 observed a stricter 5 rpm ⇒ 上游自述与实测自相矛盾，按上游自己的规则（03-adding-a-new-provider.md:60 不猜）**置 null**。另：`User-Agent` 伪装**不是**必要条件 —— 上游 index.ts:399-400 称 Cloudflare rejects non-browser User-Agents with error 1010，但 T2 用 3 种 UA × 2 种凭据的矩阵实测**决定 403/401 的变量只是 Authorization 头的有无，与 UA 无关**（该上游说法在本网络本时刻未被复现，不断言其错）。'
    },
    models: [
      {
        id: 'deepseek-v4-flash:free',
        name: 'DeepSeek V4 Flash (free)',
        caps: {
          capability: 4,
          speed: 3,
          contextWindow: 42000,
          maxTokens: 8192,
          vision: false,
          toolCalling: false
        },
        source: 'id 与 contextWindow 均 **measured** 2026-10-15 from 匿名 `GET https://api.routeway.ai/v1/models`（HTTP 200，290 条，全部 available:true）→ 该 id `context_length=**42000**`。⚠️ 注意 T2 报告正文的汇总表把 9 条 `:free` 一并写成 62000，与同一次抓取的抽取产物 `catalogs/routeway.models.json` **不一致**（该文件里本 id 与 minimax-m2.7:free 均为 42000，其余 7 条才是 62000）⇒ **本条以原始抽取产物为准**。id 带 `:free` 后缀符合上游 index.ts:396-397 逐字 Free models carry a :free suffix and cost $0（后缀是上游证实的形态，**具体 id 不是** —— 上游 index.ts:400-401 逐字 Catalog rows live in the catalog，仓库侧无 id）。'
      },
      {
        id: 'minimax-m2.7:free',
        name: 'MiniMax M2.7 (free)',
        caps: {
          capability: 4,
          speed: 3,
          contextWindow: 42000,
          maxTokens: 8192,
          vision: false,
          toolCalling: false
        },
        source: 'id 与 contextWindow 均 **measured** 2026-10-15 from 匿名 `GET https://api.routeway.ai/v1/models` → `context_length=42000`（同 deepseek-v4-flash:free；T2 正文汇总表误记为 62000，以抽取产物为准）。无上游仓库行（上游只证实 `:free` 后缀形态，index.ts:396-397）。'
      },
      {
        id: 'muse-glimmer-30b:free',
        name: 'Muse Glimmer 30B (free)',
        caps: {
          capability: 3,
          speed: 4,
          contextWindow: 131072,
          maxTokens: 8192,
          vision: false,
          toolCalling: false
        },
        source: 'id 与 contextWindow 均 **measured** 2026-10-15 from 匿名 `GET https://api.routeway.ai/v1/models` → `context_length=131072`（9 条 `:free` 里唯一不是 42000/62000 的一条）。无上游仓库行。'
      },
      {
        id: 'gemma-4-26b-a4b-it-moonlight:free',
        name: 'Gemma 4 26B A4B Moonlight (free)',
        caps: {
          capability: 3,
          speed: 4,
          contextWindow: 62000,
          maxTokens: 8192,
          vision: false,
          toolCalling: false
        },
        source: 'id 与 contextWindow 均 **measured** 2026-10-15 from 匿名 `GET https://api.routeway.ai/v1/models` → `context_length=62000`。9 条 `:free` 中有 6 条是同一 base id 的变体（chimerax/darksoul/luminous/moonlight/musica/meromero，各 1 条、均 62000）——**只收 moonlight 一条作代表**，避免 6 条近重复条目占满候选位；其余 5 条 id 见 `_lead/probes/catalogs/routeway.models.json`。'
      }
    ]
  }
])
/* @generated:catalog:end */

/** Built-in provider ids, in catalog order. */
export const BUILTIN_PROVIDER_IDS = Object.freeze(BUILTIN_PROVIDERS.map((provider) => provider.id))

/** @param {unknown} value @returns {Record<string, any> | null} */
function asObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : null
}

/** @param {unknown} value @returns {string} */
function asTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** @param {unknown} value @param {number} fallback @param {{min?: number, max?: number}} [bounds] */
function asNumber(value, fallback, bounds = {}) {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  if (bounds.min !== undefined && parsed < bounds.min) return fallback
  if (bounds.max !== undefined && parsed > bounds.max) return fallback
  return parsed
}

/** @param {unknown} value @param {boolean} fallback */
function asBoolean(value, fallback) {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 'yes') return true
  if (value === 'false' || value === 'no') return false
  return fallback
}

/**
 * Normalise one model declaration into the frozen capability shape.
 *
 * Anything missing falls back to {@link CONSERVATIVE_CAPS}: an under-declared
 * model is merely ranked lower, whereas an over-declared one gets a request it
 * cannot serve.
 *
 * `verified` is deliberately **not** copied: it is *our* measurement of a
 * provider, not a declaration. A user-declared model that wrote its own
 * `verified` block would otherwise be able to print "free, verified <date>" in
 * the model picker on its own say-so. The rejection is explicit and guarded
 * (`tests/free-model-guard.test.mjs`), not an accident of this object literal.
 *
 * @param {unknown} raw
 * @returns {{id: string, name: string, caps: Record<string, any>} | null} null when the id is unusable
 */
export function normalizeModel(raw) {
  const record = asObject(raw)
  if (record === null) return null
  const id = asTrimmedString(record.id)
  if (id.length === 0) return null
  const capsSource = asObject(record.caps) ?? record
  return {
    id,
    name: asTrimmedString(record.name) || id,
    caps: {
      capability: asNumber(capsSource.capability, CONSERVATIVE_CAPS.capability, { min: 1, max: 5 }),
      speed: asNumber(capsSource.speed, CONSERVATIVE_CAPS.speed, { min: 1, max: 5 }),
      contextWindow: Math.trunc(asNumber(capsSource.contextWindow, CONSERVATIVE_CAPS.contextWindow, { min: 1 })),
      maxTokens: Math.trunc(asNumber(capsSource.maxTokens, CONSERVATIVE_CAPS.maxTokens, { min: 1 })),
      vision: asBoolean(capsSource.vision, CONSERVATIVE_CAPS.vision),
      toolCalling: asBoolean(capsSource.toolCalling, CONSERVATIVE_CAPS.toolCalling),
    },
  }
}

/**
 * Read the user's `config.providers` override map.
 *
 * Two spellings are accepted because both are natural in a YAML patch: a
 * dictionary keyed by provider id, or a list of entries carrying their own `id`.
 *
 * @param {unknown} raw
 * @returns {Map<string, Record<string, any>>} id → override, in a deterministic order
 */
function readOverrides(raw) {
  /** @type {Map<string, Record<string, any>>} */
  const overrides = new Map()
  const source = asObject(raw)
  if (source !== null) {
    for (const [key, value] of Object.entries(source)) {
      const record = asObject(value)
      if (record === null) continue
      const id = asTrimmedString(record.id) || asTrimmedString(key)
      if (id.length === 0) continue
      overrides.set(id, record)
    }
    return overrides
  }
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const record = asObject(entry)
      if (record === null) continue
      const id = asTrimmedString(record.id)
      if (id.length === 0) continue
      overrides.set(id, record)
    }
  }
  return overrides
}

/**
 * Apply one override to one provider declaration.
 * @param {Record<string, any>} provider the built-in or blank declaration
 * @param {Record<string, any> | undefined} override
 * @returns {Record<string, any>} a detached declaration
 */
function applyOverride(provider, override) {
  const enabled = override === undefined
    ? provider.enabled
    : asBoolean(override.enabled, provider.enabled)
  const declaration = {
    id: provider.id,
    displayName: asTrimmedString(override?.displayName) || provider.displayName,
    baseURL: asTrimmedString(override?.baseURL) || provider.baseURL,
    apiKeyEnv: asTrimmedString(override?.apiKeyEnv) || provider.apiKeyEnv,
    apiKey: asTrimmedString(override?.apiKey),
    keyless: override === undefined ? provider.keyless : asBoolean(override.keyless, provider.keyless),
    enabled,
    confidence: provider.confidence,
    limits: provider.limits,
    keyURL: asTrimmedString(override?.keyURL) || provider.keyURL,
    // These are real wire-level requirements, not documentation: NVIDIA refuses
    // parallel tool calls and must always receive `parallel_tool_calls: false`.
    // Rebuilding the declaration without them silently dropped the requirement —
    // `listProviderModels()` reported `{}` and nothing ever reached the request.
    // Shallow-merged (not replaced) so a user override adds to the built-in value
    // instead of erasing it.
    extraBody: {
      ...asObject(provider.extraBody) ?? {},
      ...asObject(override?.extraBody) ?? {},
    },
    extraHeaders: {
      ...asObject(provider.extraHeaders) ?? {},
      ...asObject(override?.extraHeaders) ?? {},
    },
    models: [],
  }

  const declaredModels = override?.models
  if (Array.isArray(declaredModels) && declaredModels.length > 0) {
    // A user-declared model list replaces the built-in one wholesale, so a
    // provider that started serving a different catalog can be corrected without
    // waiting for a plugin release.
    for (const entry of declaredModels) {
      const model = normalizeModel(entry)
      if (model !== null) declaration.models.push(model)
    }
  } else {
    for (const model of provider.models ?? []) declaration.models.push(model)
  }
  return declaration
}

/**
 * Every usable `provider` × `model` pair from the pool, after the user's
 * overrides. Disabled providers and providers left with no models are omitted.
 *
 * Ordering is deterministic (catalog order, then custom providers by id, models
 * in declaration order) so the router's tie-breaks are reproducible.
 *
 * @param {unknown} [config] the normalised plugin config
 * @returns {{provider: string, model: string, caps: Record<string, any>, apiKeyEnv: string,
 *   baseURL: string, displayName: string, keyless: boolean, extraBody: Record<string, any>,
 *   extraHeaders: Record<string, string>, maxTokens: number}[]}
 */
export function listProviderModels(config) {
  const declarations = providerDeclarations(config)
  const out = []
  for (const declaration of declarations) {
    if (declaration.enabled !== true) continue
    if (declaration.baseURL.length === 0) continue
    for (const model of declaration.models) {
      out.push({
        provider: declaration.id,
        model: model.id,
        modelName: model.name,
        caps: { ...model.caps },
        apiKeyEnv: declaration.apiKeyEnv,
        baseURL: declaration.baseURL,
        displayName: declaration.displayName,
        keyless: declaration.keyless === true,
        // Carried through so the model picker can tell the user *where* to get the
        // credential it is missing; see `buildDirectCatalog`.
        keyURL: typeof declaration.keyURL === 'string' && declaration.keyURL.length > 0 ? declaration.keyURL : null,
        // Evidence travels with the row it justifies. Without this line the
        // picker cannot tell a verified free model from an unverified one, and
        // `verified` would be dropped *in silence* — the failure mode this
        // repository has already paid for twice (see the module header).
        //
        // Only well-formed evidence is carried. A malformed record is dropped so
        // that nothing false can reach a user, and the offline guard fails on
        // the pool instead: never claim, always fail the gate.
        ...isVerifiedRecord(model.verified) === true
          ? { verified: { ...model.verified, pricing: { ...model.verified.pricing } } }
          : {},
        // The reasoning-effort vocabulary this model is MEASURED to accept. Carried
        // through for the same reason `verified` is: without this line the field is
        // dropped in silence and a measured capability becomes invisible — the
        // failure mode this repository has already paid for.
        //
        // Only a well-formed, non-empty list of non-empty strings travels; anything
        // else is dropped, so a malformed entry can never reach DSH as a capability
        // claim. An absent field means "not measured", which is the honest default.
        ...Array.isArray(model.reasoning)
          && model.reasoning.length > 0
          && model.reasoning.every((id) => typeof id === 'string' && id.length > 0)
          ? { reasoning: [...model.reasoning] }
          : {},
        extraBody: { ...asObject(declaration.extraBody) ?? {} },
        extraHeaders: { ...asObject(declaration.extraHeaders) ?? {} },
        maxTokens: model.caps.maxTokens,
      })
    }
  }
  return out
}

/**
 * Every provider declaration with the user's overrides applied: the built-ins in
 * catalog order, then any user-added providers sorted by id.
 *
 * The single place where "what providers exist and what do they declare" is
 * decided — both {@link listProviderModels} and {@link keyEntryPoints} read it, so
 * the model list and the guidance text can never disagree about a provider.
 *
 * @param {unknown} [config]
 * @returns {Record<string, any>[]}
 */
export function providerDeclarations(config) {
  const settings = asObject(config) ?? {}
  const overrides = readOverrides(settings.providers)
  /** @type {Record<string, any>[]} */
  const declarations = []

  for (const provider of BUILTIN_PROVIDERS) {
    declarations.push(applyOverride(provider, overrides.get(provider.id)))
    overrides.delete(provider.id)
  }
  // Anything left is a user-added provider; sort for reproducibility.
  for (const id of [...overrides.keys()].sort()) {
    const override = overrides.get(id)
    declarations.push(applyOverride({
      id,
      displayName: id,
      baseURL: '',
      apiKeyEnv: `${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`,
      apiKey: '',
      keyless: false,
      enabled: true,
      confidence: 'user',
      limits: undefined,
      models: [],
    }, override))
  }
  return declarations
}

/**
 * The enabled providers that publish a key-application URL, as
 * `{ id, displayName, apiKeyEnv, keyURL }`.
 *
 * ## Why this function exists
 *
 * `lib/dispatch.js` used to carry its own hardcoded list of entry points
 * (`'Cerebras https://cloud.cerebras.ai/'`, …) while the model picker read
 * `provider.keyURL`. The same fact lived in two tables that could only drift
 * apart — and did: `cerebras.keyURL` was `null`, so the picker told users to
 * "configure it in DSH settings" for a provider whose console URL the other table
 * already knew. There is now exactly one source: {@link providerDeclarations},
 * backed by `BUILTIN_PROVIDERS` and the user's overrides.
 *
 * @param {unknown} [config]
 * @returns {{id: string, displayName: string, apiKeyEnv: string, keyURL: string}[]}
 */
export function keyEntryPoints(config) {
  const out = []
  for (const declaration of providerDeclarations(config)) {
    if (declaration.enabled !== true) continue
    const keyURL = typeof declaration.keyURL === 'string' && declaration.keyURL.length > 0
      ? declaration.keyURL
      : undefined
    if (keyURL === undefined) continue
    out.push({
      id: declaration.id,
      displayName: typeof declaration.displayName === 'string' && declaration.displayName.length > 0
        ? declaration.displayName
        : declaration.id,
      apiKeyEnv: declaration.apiKeyEnv,
      keyURL,
    })
  }
  return out
}

/**
 * One provider declaration from the pool, with the user's overrides applied.
 * @param {string} id
 * @param {unknown} [config]
 * @returns {Record<string, any> | undefined}
 */export function providerById(id, config) {
  const settings = asObject(config) ?? {}
  const override = readOverrides(settings.providers).get(id)
  const builtin = BUILTIN_PROVIDERS.find((provider) => provider.id === id)
  if (builtin !== undefined) return applyOverride(builtin, override)
  if (override === undefined) return undefined
  return applyOverride({
    id,
    displayName: id,
    baseURL: '',
    apiKeyEnv: `${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`,
    apiKey: '',
    keyless: false,
    enabled: true,
    confidence: 'user',
    limits: undefined,
    models: [],
  }, override)
}

/** @param {unknown} source @returns {(key: string) => string | undefined} */
function envReader(source) {
  if (typeof source === 'function') {
    return (key) => {
      try {
        const value = source(key)
        return typeof value === 'string' ? value : undefined
      } catch {
        return undefined
      }
    }
  }
  const record = asObject(source)
  if (record === null) return () => undefined
  return (key) => {
    const value = record[key]
    return typeof value === 'string' ? value : undefined
  }
}

/**
 * Resolve the credential for one provider.
 *
 * Order (the Lead's ruling, and the only order that lets a user keep the naming
 * they already use):
 *
 * 1. the DSH **credentials service** under `apiKeyEnv` — this is the authority,
 *    and it is itself layered over process env → managed store → `$DSH_HOME/.env`;
 * 2. an **explicit** key in the plugin config (`config.providers[id].apiKey`);
 * 3. the environment variable named by `apiKeyEnv`;
 * 4. the generic convention name `<PROVIDER_ID>_API_KEY`.
 *
 * Never cached: a rotated key must take effect on the next request, and the
 * credentials service is explicitly per-operation.
 *
 * @param {{id: string, apiKeyEnv?: string, apiKey?: string}} provider
 * @param {{credentials?: any, env?: any, settings?: unknown}} [deps]
 * @returns {Promise<string | undefined>} the trimmed key, or undefined
 */
export async function resolveProviderKey(provider, deps = {}) {
  const id = asTrimmedString(provider?.id)
  const ref = asTrimmedString(provider?.apiKeyEnv)
  const settings = asObject(deps.settings) ?? {}
  const override = readOverrides(settings.providers).get(id)
  const explicit = asTrimmedString(provider?.apiKey) || asTrimmedString(override?.apiKey)

  if (ref.length > 0 && deps.credentials !== undefined && deps.credentials !== null) {
    try {
      const credentials = deps.credentials
      const pending = typeof credentials === 'function'
        ? credentials(ref)
        : typeof credentials.resolve === 'function'
          ? credentials.resolve(ref)
          : undefined
      const hit = await pending
      const value = typeof hit === 'string' ? hit : hit?.value
      if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    } catch {
      // A failing credential seam must not mask the environment fallbacks.
    }
  }

  if (explicit.length > 0) return explicit

  const readEnv = envReader(deps.env ?? (typeof process === 'object' ? process.env : undefined))
  if (ref.length > 0) {
    const value = readEnv(ref)
    if (value !== undefined && value.trim().length > 0) return value.trim()
  }
  const convention = `${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
  if (convention !== ref) {
    const value = readEnv(convention)
    if (value !== undefined && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/**
 * Whether a provider can be used with the credential that was resolved.
 *
 * A keyless provider is usable with no key at all; every other provider needs
 * one. This is a **silent** predicate: a missing key removes the provider from
 * the candidate pool without producing an error, a warning or a "configuration
 * incomplete" notice (`research/free-provider-catalog.md` §14.3).
 *
 * @param {{keyless?: boolean} | undefined} provider
 * @param {string | undefined} key
 * @returns {boolean}
 */
export function isProviderUsable(provider, key) {
  if (provider?.keyless === true) return true
  return typeof key === 'string' && key.trim().length > 0
}

/**
 * Split a direct-mode model id into its provider and model halves.
 *
 * Pool models are advertised as `provider/model`, and some catalog ids
 * themselves contain slashes (`groq/openai/gpt-oss-120b`), so the split is on the
 * **first** slash.
 *
 * @param {string} id
 * @returns {{provider: string, model: string} | undefined}
 */
export function splitPoolModelId(id) {
  const value = asTrimmedString(id)
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return undefined
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) }
}
