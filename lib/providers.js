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
 * - `groq` / `cerebras` / `openrouter` / `github` / `mistral` / `zhipu` /
 *   `volcengine` / `longcat` / `nvidia`: their catalogs answered **403** without
 *   a credential, so the shipped numbers remain catalogue-derived **estimates**.
 * - `ovh`: its `GET /v1/models` answers 200 but publishes **no** context field at
 *   all, so its value stays an estimate too.
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
 * ## `apiKeyEnv` is *our* convention, never upstream truth
 *
 * freellmapi has no `apiKeyEnv` concept (its gateway keys live in an encrypted
 * SQLite store behind its dashboard). Every value here is therefore a **default**
 * that a user can override per provider, and resolution always consults the DSH
 * credentials service first. See {@link resolveProviderKey}.
 *
 * @module dsh-freellmapi/providers
 */

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
/** The frozen built-in pool (generated from research/provider-catalog.json + the lead live probe). */
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
      note: '免费额度随模型与账户等级变化；上表按 2026-04 迁移基线中最紧的一档填写（llama-3.3-70b 基线为 30/1000/6000/500000），并已置为可配置项而非硬编码'
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
        source: 'server/src/db/migrations/20260101_000000_legacy_baseline.ts:632 (migrateModelsV10)'
      },
      {
        id: 'llama-3.3-70b-versatile',
        name: 'Llama 3.3 70B',
        caps: {
          capability: 4,
          speed: 5,
          contextWindow: 131072,
          maxTokens: 32768,
          vision: false,
          toolCalling: true
        },
        source: 'server/src/db/migrations/20260101_000000_legacy_baseline.ts:323 (seedModels)'
      },
      {
        id: 'llama-3.1-8b-instant',
        name: 'Llama 3.1 8B Instant',
        caps: {
          capability: 2,
          speed: 5,
          contextWindow: 131072,
          maxTokens: 8192,
          vision: false,
          toolCalling: true
        },
        source: 'server/src/db/migrations/20260101_000000_legacy_baseline.ts:635 (migrateModelsV10)'
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
      rpd: 200,
      tpm: null,
      tpd: null,
      note: '免费模型（id 带 :free 后缀）统一 20 RPM / 200 RPD；账户余额 ≥$10 时 RPD 放宽至 1000（该放宽值未在本目录取证范围内，按 200 保守处理）'
    },
    models: [
      {
        id: 'deepseek/deepseek-v3.1:free',
        name: 'DeepSeek V3.1 (free)',
        caps: {
          capability: 5,
          speed: 3,
          contextWindow: 131072,
          maxTokens: 32768,
          vision: false,
          toolCalling: true
        },
        source: 'server/src/db/migrations/20260101_000000_legacy_baseline.ts:305 (seedModels); tool via V22 :1765 (%deepseek-v%)'
      },
      {
        id: 'moonshotai/kimi-k2.6:free',
        name: 'Kimi K2.6 (free)',
        caps: {
          capability: 5,
          speed: 3,
          contextWindow: 262144,
          maxTokens: 32768,
          vision: false,
          toolCalling: true
        },
        source: 'server/src/db/migrations/20260101_000000_legacy_baseline.ts:1854 (migrateModelsV23); tool via V22 :1766 (%kimi-k2%)'
      },
      {
        id: 'qwen/qwen3-coder:free',
        name: 'Qwen3 Coder (free)',
        caps: {
          capability: 5,
          speed: 3,
          contextWindow: 262144,
          maxTokens: 32768,
          vision: false,
          toolCalling: true
        },
        source: 'server/src/db/migrations/20260101_000000_legacy_baseline.ts:307 (seedModels); tool via V22 :1763'
      },
      {
        id: 'nvidia/nemotron-nano-12b-v2-vl:free',
        name: 'Nemotron Nano 12B VL (free)',
        caps: {
          capability: 3,
          speed: 3,
          contextWindow: 128000,
          maxTokens: 16384,
          vision: true,
          toolCalling: true
        },
        source: 'server/src/db/migrations/20260101_000000_legacy_baseline.ts:1856 (migrateModelsV23)；vision 与结构化 tool_calls 均于 2026-06-07 live-probed（V16 :1457-1461、V2'
      }
    ]
  },
  {
    id: 'github',
    displayName: 'GitHub Models',
    baseURL: 'https://models.github.ai/inference',
    apiKeyEnv: 'GITHUB_MODELS_TOKEN',
    keyURL: null,
    keyless: false,
    enabled: false,
    confidence: 'confirmed',
    limits: {
      rpm: 10,
      rpd: 50,
      tpm: null,
      tpd: null,
      note: '免费层按模型档位分档（Low/High），10 RPM / 50 RPD 为低档基线；目录使用 <publisher>/<model> 形式的 id'
    },
    models: [
      {
        id: 'openai/gpt-5',
        name: 'GPT-5 (GitHub)',
        caps: {
          capability: 5,
          speed: 3,
          contextWindow: 128000,
          maxTokens: 16384,
          vision: true,
          toolCalling: true
        },
        source: 'server/src/db/migrations/20260101_000000_legacy_baseline.ts:315 (seedModels)；vision V16 :1449-1453；tool V22 :1779'
      },
      {
        id: 'openai/gpt-4.1',
        name: 'GPT-4.1 (GitHub)',
        caps: {
          capability: 4,
          speed: 3,
          contextWindow: 8000,
          maxTokens: 8000,
          vision: true,
          toolCalling: true
        },
        source: 'server/src/db/migrations/20260101_000000_legacy_baseline.ts:642 (migrateModelsV10)；contextWindow 8000 来自上游 GitHub gpt-4.1 路由覆盖值（providers/index.ts 注释 '
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
        source: 'contextWindow measured 2026-10-13 from `GET https://api.kilo.ai/api/gateway/models` → context_length=262144 (the value shipped before this was 1000000, a 4x overstatement that let the router pick this model for a 297k-token session and get a 400). tool via V22 :1780 (%nemotron-3-super%)'
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
        source: 'contextWindow measured 2026-10-13 from `GET https://api.kilo.ai/api/gateway/models` → context_length=1000000 (the value shipped before this was 131072, an 8x understatement that made the context gate skip the only model in the pool that could hold a 297k-token session). lead live probe 2026-10-13: GET /v1/models isFree=true; vision false assumed'
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
        source: 'contextWindow measured 2026-10-13 from `GET https://api.kilo.ai/api/gateway/models` → context_length=262144. Replaces poolside/laguna-m.1:free which returned HTTP 404'
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
          toolCalling: false
        },
        source: 'contextWindow measured 2026-10-13 from `GET https://api.kilo.ai/api/gateway/models` → context_length=256000. lead live probe 2026-10-13: GET /v1/models isFree=true'
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
