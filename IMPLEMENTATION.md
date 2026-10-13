# dsh-freellmapi — 技术实现说明（IMPLEMENTATION）

> 本文是 **T3（v0.1.0 gateway 模式）** 与 **T9（v0.2.0 direct 模式）** 的交付说明，同时作为用户 README 的**技术实现章节草稿**。
> 契约依据：`docs/SPEC.md`（DSH 适配器开发契约）、`research/freellmapi-protocol.md`（上游协议）、`research/free-provider-catalog.md` + `research/provider-catalog.json`（内置 provider 池），以及 `_lead/live-probe-2026-10-13.md`（keyless 免凭据实测）。
> 版本基线：DSH `0.2.0-rc.2`、`@deepseek-ai/cordis` `4.0.4`、freellmapi `server` 协议面（v0.13.x）。
>
> **v0.2.0 起默认模式是 `direct`（自包含智能路由，不需要任何外部进程）；`gateway` 模式保留 v0.1.0 的转发行为，一字未改。** 见 [§12](#12-v020-direct-模式自包含智能路由)。

---

## 0. v0.2.0 变更摘要（T9）

| 项 | v0.1.0 | v0.2.0 |
|---|---|---|
| 默认 `mode` | —（只有转发） | **`direct`**：插件自带路由智能，装完选 `auto` 即可用，无需外部进程 |
| `gateway` 模式 | 全部行为 | **保留，零回归**（现有 gateway 测试全部显式以 `mode:'gateway'` 运行并全绿） |
| 新增模块 | — | `lib/providers.js`、`lib/router.js`、`lib/health.js`、`lib/dispatch.js` |
| 改造模块 | — | `lib/index.js`、`lib/config.js`、`lib/routes.js`、`lib/catalog.js`、`lib/errors.js`（一处，见 §12.6） |
| 模型列表 | 网关虚拟路由 + 发现结果 | `auto` → `auto:simple/medium/complex` → 池中每个 `provider/model` |
| 路由依据 | 网关 | `lib/complexity.js` 的三档 + 能力/速度/健康度排序 + failover |

---

## 1. 交付物与形态

| 文件 | 作用 |
|---|---|
| `package.json` | 包元数据（**零 `dependencies`**，唯一 peer 是可选的 `@deepseek-ai/cordis`） |
| `cordis.patch.yml` | bundle 补丁：`- insert: [{ id: freellmapi, name: 'dsh-freellmapi' }]` |
| `lib/index.js` | 插件入口：导出 `name` / `inject` / `Config` / `apply`，并新增导出 `getRecentRoutes()` / `formatRouteLine()` / `formatDirectRouteLine()` / `configSchemaKind` |
| `lib/runtime.js` | 对 `@deepseek-ai/dsh-llm` 的**运行时桥接 + 完整降级垫片** |
| `lib/config.js` | `Config` 导出（schemastery 优先，普通 Standard Schema 兜底）+ 全防御 `normalizeConfig()` |
| `lib/complexity.js` | **启发式复杂度分类器**（T8；纯函数，三档 + 可解释 signals/reasons） |
| `lib/providers.js` | **内置 provider 池**（12 家 / 30 模型，keyless 标记、用户覆盖、凭据解析） |
| `lib/router.js` | **候选排序**（纯函数：无 import、无时钟、无 I/O） |
| `lib/health.js` | **冷却与延迟追踪**（有状态、无 I/O、时钟可注入） |
| `lib/dispatch.js` | **direct 模式的唯一 I/O 模块**：单次尝试 + failover 循环 |
| `lib/sse.js` | 增量 SSE 解码器（纯函数状态机） |
| `lib/frames.js` | SSE payload → 帧分类（纯函数） |
| `lib/translate.js` | 帧 → `StreamChunk` 状态机（纯函数） |
| `lib/wire.js` | `GenerateOptions` → OpenAI wire 映射（纯函数） |
| `lib/errors.js` | HTTP/传输失败分类与**人话诊断**（含 `MODEL_UNAVAILABLE`） |
| `lib/catalog.js` | 静态虚拟路由 + `GET /v1/models` 发现与缓存（gateway）/ direct 目录 |
| `lib/routes.js` | 路由可观测性：两种日志渲染 + 50 条环形缓冲 |
| `lib/types.js` | 纯 JSDoc 类型词汇（无运行时代码） |
| `tests/**/*.test.mjs` | **328 条离线测试**（`node:test`，内置 `node:http` mock 端点，端口 0；**任何测试都不会访问真实 provider**，且 direct 模式的 mock **会校验 `body.model`**，像真实 provider 一样对未知模型回 404） |

**无构建步骤**：`main`/`exports["."]` 直接指向 `lib/index.js`，DSH 用 `import()` 加载源码本身。

```bash
npm test        # 328 tests, 0 fail; 不需要网关、不需要网络、不需要 API key
```

---

## 2. 红线落地：为什么是「运行时桥接」而不是 `dependencies`

`@deepseek-ai/dsh-*` 绝不能进 `dependencies`（`docs/SPEC.md` §2）。但本包又必须在**没有 `node_modules` 的裸检出**里 `import` 成功（这就是验收自证之一），所以不能在模块顶层 `import { LlmAdapter } from '@deepseek-ai/dsh-llm'`。

`lib/runtime.js` 的解法是**顶层 `await import()` + 完整本地垫片**：

```js
let runtime = null
try { runtime = await import('@deepseek-ai/dsh-llm') } catch { runtime = null }
export const llmRuntimeAvailable = runtime !== null
export const LlmAdapter = runtime?.LlmAdapter ?? ShimLlmAdapter
export const LlmError   = runtime?.LlmError   ?? ShimLlmError
export const attributionHeaders = () => runtime?.attributionHeaders?.() ?? { 'user-agent': FALLBACK_UA }
// isQuotaExceededError / isContextWindowExceededError / assertUsableApiKey 同构
```

- 在**真实 profile 环境**里解析到真品（实测见 §10）；
- 在**裸检出**里落到垫片：
  - `ShimLlmAdapter` 逐方法镜像 `LLM:lib/index.js:1670-1740` 的基类默认实现；
  - `ShimLlmError` 复刻 `LLM:lib/index.js:1615-1640` 的构造校验与 `failure` 快照形状；
  - `shimNormalizeApiKey` 复刻 `LLM:lib/types/api-key.js:14` 的 `/^[\x21-\x7E]+$/`；
  - 归因头退化为 `deepseek-harness/unknown (+https://github.com/deepseek-ai/deepseek-harness)`。

**关键点：本适配器对模块身份（`instanceof`）完全不敏感**（见 §9），所以垫片与真品行为等价，且"跨副本"问题在本插件里不可能发生。

---

## 3. D1–D8 逐条落地

### D1 — 零运行时依赖 ✅
`package.json` **没有 `dependencies` 字段**；`peerDependencies` 只有 `{"@deepseek-ai/cordis":"*"}` + `peerDependenciesMeta.optional`。**没有**把 `@deepseek-ai/dsh-llm` 或 `@deepseek-ai/schemastery` 写进 peer（写了会被 `autoInstallPeers` 拉进 profile 顶层从而遮蔽运行时副本）。
两者都改用**运行时可选动态 import**（`lib/runtime.js`、`lib/config.js`），不产生任何依赖声明。

### D2 — 配置校验不用 schemastery 硬依赖，且任何畸形配置只降级 ✅（**部分调整，理由见下**）
- **`normalizeConfig()` 是总函数**：任何输入（`undefined`、标量、数组、带抛错 getter 的宿主对象、错误类型、非法 URL）都只降级为默认值，绝不抛错。逐字段 `readField()` 兼容"普通值"与 schemastery 的 `Volatile`（`{get()}`）两种形态。
- **`Config` 导出的形态按宿主能力二选一**，并且**永远可被 cordis 接受**：
  1. 宿主能解析 `@deepseek-ai/schemastery` → 用真 schema（**16 个字段全部 `.volatile()`**，每个字段都 `.loose()`，外层对象也 `.loose()`）；
  2. 否则 → 普通对象 `{ '~standard': { version, vendor, validate } }`，`validate` 直接返回 `{ value: normalizeConfig(value) }`。

> **为什么要做这个"部分调整"（D2 原话是"用最朴素的形态"）**：我实测了 DSH 侧的两个硬事实，它们决定了"朴素形态"的代价与风险边界：
> - `ASAR:cordis/lib/index.js:956-962`：`if (!runtime.Config) return config;` → 不导出 `Config` 也能加载；只要有 `'~standard'.validate` 就行，**不要求 schemastery**；但**一旦 `validate()` 返回 `issues`，cordis 抛 `ValidationError`**（fiber 起不来）。
> - `ASAR:dsh-settings/lib/index.js:538-541`：`schema(entry)` 是 `return schema !== undefined && "toJSON" in schema ? schema : undefined` → **没有 `toJSON` 的 `Config` 会让该插件静默地从设置页里消失**（不崩，但用户无法在 GUI 里填 baseURL / apiKey）。
>
> 所以纯朴素形态会**牺牲整个设置页**。折中方案既保住了 D2 的目标（profile 绝不因本插件起不来），又拿到设置页：
> - schemastery **不是声明依赖**，只是"能解析就用"的可选 import；解析失败一律回落；
> - `.loose()` 让**类型错误也不产生 issue**（实测：`{baseURL:7}`、`{logRoutedVia:'yes'}`、`{headers:5}`、根级 `7`/`"x"`/`[]` 全部 0 issues）；
> - schema 构造整体包在 `try/catch` 里，并校验 `toJSON`/`'~standard'.validate` 存在，否则回落朴素形态。
>
> 两种形态下 `apply()` 的读取路径完全相同（都过 `normalizeConfig`），热更新也都成立（schemastery 走 volatile 就地更新；朴素形态走 fiber 重建后重进 `apply`）。

### D3 — `providerRetryPolicy` 返回 `undefined` ✅
```js
providerRetryPolicy(_provider) { return undefined }   // 走运行时默认：normal / 5 次 / 500ms→10s
```
理由（记录在 `lib/index.js` 的 JSDoc 里）：上游 freellmapi 自己就在做 429 冷却与跨 provider 故障转移（`research` §5/§7.3），DSH 侧再叠一层重试只会**放大延迟**——而"谁该重试"的判断权在网关手里（它知道哪些 key 在冷却、哪条链还有候选）。同时避开 `LLM:lib/index.js:1867` 的陷阱：运行时对非 `undefined` 返回值**不做任何校验**，一旦要自定义就必须自己调 `resolveRetryPolicy()`。

### D4 — model 策略全集 + 目录顺序 + 目录合法性 ✅
`lib/catalog.js` 的静态部分（顺序即 GUI 顺序）：

| # | id | name |
|---|---|---|
| 1 | `auto` | Auto (router picks the best available model) |
| 2 | `auto:smart` | Auto · Smartest |
| 3 | `auto:fast` | Auto · Fastest |
| 4 | `auto:cheap` | Auto · Cheapest |
| 5 | `auto:reliable` | Auto · Most reliable |
| 6 | `auto:balanced` | Auto · Balanced |
| 7 | `fusion` | Fusion (panel + judge)（可由 `includeFusion:false` 关闭） |
| 8+ | `GET /v1/models` 的 `data[].id` | 上游给的 `name`，否则 id 自身 |

- **绝不白名单拒绝 `auto:<任意后缀>`**：`resolveModel()` 对任何 id 都返回元数据，未知 profile 由网关回 `400`，`lib/errors.js` 把它翻译成"这个 profile 名不存在，去 dashboard 核对 / 或者用裸 `auto`"。
- 去重（`INVALID_CATALOG` 的重复 id 是硬错误）；`auto` 恒在第一位。
- `fusion` 同时也会从 `GET /v1/models` 出现（网关对虚拟条目不做过滤），去重后只留一条。
- 发现结果里的 `context_window` / `context_length` / `max_tokens` 不在 `LlmModelInfo` 里（运行时会剥掉），因此**旁路保存在 `ModelDiscovery` 缓存**，供 `resolveModel()` 使用。

### D5 — tool-call-delta 精确语义 ✅
`lib/translate.js`：
- **每一片都带 `id`**（`tool-call-delta.id` 类型上非可选）。上游首片缺 id 时用**确定性的** `call_<wireIndex>`，保证它与后面 `tool_call_id` 的关联稳定；
- **`name` 只在第一次得知的那一片出现**（`entry.nameSent` 守卫；空串/重复不再发）；
- **`argumentsDelta` 是上游 JSON 字符串的原始切片**，不是对象、不做 `JSON.parse`+`stringify`；
- **同时兼容两种上游行为**：真分片（`index`/`id` 首片、后续只带 `function.arguments`）与 freellmapi 的**合并整块**（缓冲后在结束前一次性发出完整 `tool_calls` + `finish_reason:'tool_calls'`）。二者共用同一条代码路径；
- 本地块 index 与上游 `tool_calls[].index` 是**两个命名空间**，用 `Map` 映射（与 `DS:lib/index.js:1938-1947` 同法）；
- 多工具并行调用各占一个块，index 严格递增。

### D6 — usage 与失败帧容错 ✅
| 上游行为 | 处理 |
|---|---|
| usage 帧在 finish chunk **之后**补发 | 翻译器**不**在见到 `finish_reason` 时立即终结，而是记住 reason、继续消费到 `[DONE]`/流结束，再按 `usage → finish` 顺序吐出（满足"usage 必须先于 finish"这一协议不变量） |
| `stream_error` 帧（响应头已发出后的中流失败，之后跟 `[DONE]`） | 翻译成 `finish {kind:'error', failure:{message, code}}`，保留已流出的块 |
| **无 `choices`** 的 `_fusion` 加法帧 / keep-alive / role-only 帧 | `frames.js` 分类为 `IGNORED`（有 `usage` 则是 `USAGE`），累加计数后跳过，**不会崩** |
| 畸形 JSON（半截帧、心跳、被截断） | 分类为 `MALFORMED`，跳过并计数；下一帧照常处理 |
| `GenerateOptions.seed` | **不存在**（`docs/SPEC.md` §6.2 已确证），不映射 |

### D7 — `attributionHeaders()` 展开进每个上游请求 ✅
`lib/index.js` 的 headers 构造里 **`...attributionHeaders()` 是第一个展开位**，其后才是 `content-type` / `accept` / `authorization` / 配置项。`lib/config.js` 的 `headersField()` 会**剥掉** `user-agent`、`authorization`、`content-type`、`accept` 四个保留头，所以用户配置**无法覆盖归因头**（`docs/SPEC.md` §7.1："nothing can suppress attribution entirely"）。
模型发现请求（`GET /models`）同样带 `...attributionHeaders()`（SPEC §7.3 自查清单要求"每个出站请求"）。两个请求都使用 `redirect: 'error'`。

### D8 — 恰好一个 provider route ✅
`PROVIDER_ID = 'freellmapi'`，`providerInfo()` 返回 `{ id: provider, name: 'FreeLLMAPI (Auto)' }`（`id` 原样回传入参，否则注册抛 `INVALID_ADAPTER`）。注册三件套按 `docs/SPEC.md` §4.6 的顺序：`registerConfigurableProviders` → `registerModelDiscovery` → `registerAdapter`，并在 `loader/volatile-update` 里 `try/catch` 对账。

---

## 4. Lead 追加项：`X-Routed-Via` 可见性

这是本插件相对"官方 pi-ai 路径"的**首要增量**。

- `lib/routes.js::readRoutingHeaders()` 读 `X-Routed-Via` / `X-Fallback-Attempts` / `X-Fallback-Trail`；非 ASCII 的 model id 会**先百分号解码再记录**（`decodeURIComponent`，畸形转义原样保留、不抛）。
- 每次 `stream()` 拿到响应（**包括非 2xx**）后都会调 `recordRoute()` + （开关打开时）`ctx.logger?.info?.(...)`。
- 日志文案与 README §"How to confirm which provider actually answered" **逐字一致**：
  ```
  dsh-freellmapi: routed via groq/llama-3.3-70b (model=auto)
  dsh-freellmapi: routed via google/gemini-2.5-flash (model=auto:fast) fallback-attempts=2 trail=groq/… key1=rate_limited; …
  ```
- 配置开关 `logRoutedVia`（**默认 true**）。关掉后**仍然记录进环形缓冲**，只是不打日志。
- 模块内 50 条环形缓冲，导出纯函数 **`getRecentRoutes()`**（返回数组浅拷贝，调用方改动不影响内部）；另导出 `formatRouteLine()`。**没有**注册 service、**没有**加 tool、**没有**新增依赖。
- 日志调用三重防御：`ctx.logger` 可能不存在 → 可选链；`info` 可能不存在 → 判型；**logger 抛错 → `try/catch` 吞掉**。可观测性绝不允许影响流。

> **为什么这是"基于适配器设计的判断"而非对 pi-ai 的实测结论**：pi-ai 适配器把消息交给 `@earendil-works/pi-ai` 的库层，最终 HTTP 由库内部发出（`PIAI:lib/index.js:1887` 的 `requestHeaders()` 只提供 *请求* 头钩子），适配器这一层**拿不到 `Response` 对象**，因此没有"读响应头"的位置。本插件是直连 `fetch`，`Response.headers` 天然可读。结论是**结构推论**，不是对 pi-ai 内部实现的观测——README 里也照此措辞。（若 pi-ai 未来提供响应头回调，这条差异会消失。）

---

## 5. Lead 裁决：tool-call arguments **不做 `{}` 兜底**

`docs/SPEC.md` §5.4 说 `block-end` 的 `arguments` "必须是合法 JSON 字符串……空参数时给 `'{}'`"；但同一条也要求 `block-end` 是本次流式内容的**完整物化**。当上游给出**截断/非法 JSON** 时这两条会冲突。

**裁决（Lead，已实现）**：

1. `block-end.block.arguments` **与已流出的 `argumentsDelta` 分片逐字节一致**。绝不把 `{"a":` 改写成 `{}`——那会篡改历史、与 replay 矛盾，更危险的是让工具**以空参数静默执行**。截断 payload 原样闭合，随后**整个流以 `finish {kind:'error', failure:{code:'INVALID_REQUEST'}}` 终结**，因此这个畸形块永远不会被真正执行。
2. 只有**上游完全没给参数内容**（`function.arguments` 缺失 / `null` / `''`）时，才补成 `'{}'`——而且是以**真实分片** `tool-call-delta{argumentsDelta:'{}'}` 的形式流出，再以 `'{}'` 闭合。这样"分片拼装 == block-end" 的不变量**依然成立**，同时满足 SPEC §5.4 对空参数的要求（无参工具调用是完全正常的语义，不是静默改写内容）。
3. 测试里 `tests/helpers/harness.mjs` 把这条不变量保留为**硬断言**（`block.arguments !== streamed` 直接失败），并单独记录"哪些工具的流式参数无法解析"；`tests/translate.test.mjs` 对截断场景断言块内容为 `{"a":` 且 finish 为 `INVALID_REQUEST`。

---

## 6. 与 SPEC 的差异 / SPEC 纠错（逐条带证据）

| # | SPEC 的说法 | 实测/复核 | 本实现的选择 |
|---|---|---|---|
| 1 | §2.2(b) 暗示 `@deepseek-ai/dsh-llm` 由 **app.asar 运行时**提供（"模块解析是双锚点…profile node_modules 优先"） | **机理不同**：`C:\Users\81521\.dsh\profiles\node_modules\@deepseek-ai\` 下有一整套 **NTFS junction**（`dsh-llm`、`cordis`、`schemastery`、约 250 个 `dsh-*`），全部指向 `%LOCALAPPDATA%\npm-cache\_npx\<hash>\node_modules\…`。所以从**任意 profile 的任意插件目录**向上走一级就能解析到真品（npm 版），与 app.asar 无关 | 结论不变（仍不进 `dependencies`），但**插件被设计成"模块身份无关"**（§9），这样即使解析到的那份与 DSH 进程自用的那份不是同一实例也安全 |
| 2 | §1.2 "`@deepseek-ai/cordis` 和所有 `@deepseek-ai/dsh-*` 一个都不在（profile node_modules）" | 只看了 `profiles/desktop/node_modules` 这一层；**上一级 `profiles/node_modules` 里全都在** | 已按 §1 修正理解 |
| 3 | §5.2 把 `LLM:lib/types/assistant-stream.js` 当作 **adapter 输出的校验点** | adapter 输出**没有**运行时校验：`adapterStream`（`LLM:lib/index.js:2328-2348`）只 `yield item.value`；`safeIndex`/类型检查发生在 `AssistantStreamAccumulator.push`（**记录**时）。不合法的 chunk 既不会被 `adapterStream` 拒绝，也不会在流上被报错 | 因此本插件自建了独立校验器（`tests/helpers/harness.mjs`），把 `index` 单调、start/end 配对、`block-end` 字节一致、`usage` 先于 `finish`、`finish` 唯一且最后等规则**硬断言**在 gateway 与 direct 两条流路径的全部测试里 |
| 4 | §6.3 `developer` → "建议 `role:'user'`（或折叠进 system）" | freellmapi 的 `Message.role` 明确包含 `developer`，且网关自己会把 `developer → system`（`research` §11.4 引 `cli/src/tools.ts`） | 实现选 `role:'system'`：**位置保序**（工具增删公告的时序语义不丢）且对所有 OpenAI 兼容端点最安全；网关侧结果等价 |
| 5 | §6.3 的 system 口径含糊（"`system` 存在就用它作为唯一的 system prompt"） | 两个官方适配器的实际做法一致且更精确：`PIAI:lib/index.js:1244-1258` 的 `splitSystemPrompt()`；`DS:lib/index.js:1701` 是 `[options.system, historySystem].filter(Boolean).join("\n\n")` | 采用 **DeepSeek 的拼接语义**：前导 system 历史消息 + `options.system` 用空行拼接成**唯一**一条 `role:'system'`（不重复、不丢历史） |
| 6 | §5.4 "空参数时给 `'{}'`" 与 "block-end 是完整物化" 的冲突 | 见 §5 | 按 Lead 裁决实现 |
| 7 | §6.6 建议 `maxTokens` 字段名"必须做成 Config 开关" | 正确 | `maxTokensField`，**默认 `max_tokens`**（freellmapi 的 OpenAPI 只声明 `max_tokens`，`max_completion_tokens` 是"实现但未文档化"的别名）。⚠️ **README 第 320 行写的是默认 `max_completion_tokens`，需由 T4 更正** |
| 8 | §8.4 的凭据片段在"没配 key"时抛 `MISSING_CREDENTIAL` | 对云端 provider 正确 | 本插件同样**在没有可用凭据时不发请求**，但把这个失败做成**带内 `finish {kind:'error', code:'MISSING_CREDENTIAL'}`**（而不是抛出），因为任务要求"错误 → finish error 不抛"，且这样 GUI 里的报错文案能被用户看到 |
| 9 | 附录 A 骨架把 `RetryPolicySchema` 放进 `Config` | 可行 | 按 D3 不暴露重试策略（返回 `undefined`），少一个用户可配坏的旋钮 |

**没有发现的 SPEC 事实性错误**：§3 的 `LlmAdapter` 逐方法契约、§3.2 的 `listModels` / `resolveModel` 校验表、§4 的注册三件套语义与错误码、§5.2/§5.3 的 chunk 校验规则、§5.5 的 `adapterFailureChunk` 映射、§7 的归因头、§8 的 volatile/credentials 语义，我都在源码里逐条复核**一致**。

---

## 7. 配置字段全集（供 T4 更新 README）

`schema` 即设置页；16 个字段全部 `.volatile()`，改动即时生效（下一次请求读取）。

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `baseURL` | string | `http://localhost:3001/v1` | 网关 OpenAI 兼容根地址；**必须以 `/v1` 结尾**；尾部斜杠会被去掉；非法值回落默认 |
| `apiKeyEnv` | string | `FREELLMAPI_API_KEY` | 凭据**引用名**（环境变量名 / 凭据存储键），不是密钥本体 |
| `apiKey` | string(secret) | `""` | 可选内联凭据（会被 `role('secret')` 脱敏）。优先用 `apiKeyEnv` |
| `maxTokensField` | `max_tokens` \| `max_completion_tokens` | `max_tokens` | 承载输出上限的 wire 字段 |
| `logRoutedVia` | boolean | `true` | 记录/打印上游 `X-Routed-Via` 与 fallback trail |
| `includeFusion` | boolean | `true` | 是否把 `fusion` 放进模型选择器 |
| `exposeDiscoveredModels` | boolean | `true` | 是否把 `GET /v1/models` 的结果合并进选择器 |
| `vision` | boolean | `true` | 声明图片输入能力（关闭则运行时会把图片替换成占位文本） |
| `contextWindow` | number | `131072` | 网关未描述 context 时使用的上下文窗口 |
| `maxTokens` | number | `0` | 声明的默认输出上限；`0` = 不声明，交给网关与上游 |
| `timeoutMs` | number | `600000` | 单请求超时（毫秒）；`0` = 不限时 |
| `discoveryTimeoutMs` | number | `5000` | `GET /v1/models` 的超时 |
| `discoveryCacheMs` | number | `60000` | 发现结果的缓存有效期 |
| `headers` | dict(string) | `{}` | 额外请求头；`user-agent` / `authorization` / `content-type` / `accept` **不可覆盖** |
| `taskType` | string | `""` | 可选 `X-FreeLLM-Task-Type`（`auto` / `code` / `chat`）；空 = 不发该头 |
| `cacheMode` | string | `""` | 可选 `X-FreeLLM-Cache`（`on` / `off`）；空 = 不发该头 |

**配置方式三选一**（README §Configuration 已覆盖）：设置页 → 环境变量（`FREELLMAPI_API_KEY` / `FREELLMAPI_BASE_URL`）→ profile patch 的 `- id: freellmapi` + `config:`。
`FREELLMAPI_BASE_URL` **只在 `baseURL` 仍是内置默认值时才生效**，显式配置永远优先。

---

## 8. 凭据解析顺序与"每次现取"

`#resolveApiKey()`（每次请求都执行，**不缓存**）：

1. `ctx.get('credentials').resolve(config.apiKeyEnv)`（凭据服务本身分层：进程环境 → provider 存储 → `$DSH_HOME/.env`）；空串/纯空白 = 未配置；
2. 插件自身设置里的 `apiKey`（内联）；
3. 环境变量 `process.env[apiKeyEnv]`，再退到 `process.env.FREELLMAPI_API_KEY`（Windows 下按大小写不敏感查找）。

任一步取到的值都要过 `assertUsableApiKey()`（真品存在时用真品，否则用同规则垫片）：空白 → `INVALID_CREDENTIAL`（"是空值"），含 HTTP 头装不下的字符 → `INVALID_CREDENTIAL`（"含非法字符"），**两处都不会把密钥写进 message**。
`ctx.get('credentials')` 抛错时不吞掉 `INVALID_CREDENTIAL`，但其它异常会被忽略并继续走后面的兜底（凭据 seam 故障不该掩盖环境变量）。

### 图片附件
`vision:true` 时 `ImageBlock` 会真的到达适配器。适配器用 `attachments.imageHostPath(ref)`（`@deepseek-ai/dsh-llm/lib/types/content.js:13-18` 的 `resolveImageAttachmentAccess` 正是这个调用）拿宿主路径 → `fs.readFile` → `data:<mediaType>;base64,…`；单图上限 20 MB。**任何一步失败都只把那一张图降级为文本占位符**（`[image omitted: attachment sha256:… could not be attached to this request]`），绝不让请求失败。

---

## 9. 为什么本插件对"模块身份分裂"免疫

SPEC §2.2(c) 的机理（跨副本 `instanceof HarnessError` 失败 → 错误码静默降级为 `UNKNOWN`）只会在**适配器把 `LlmError` 抛过适配器边界**时发生。本插件**从不这样做**：

| 边界 | 行为 | 是否受模块身份影响 |
|---|---|---|
| `stream()` 内的一切失败（HTTP、传输、超时、abort、凭据、流中错误） | 一律转成**带内** `finish` chunk，`failure` 是**纯数据对象** `{message, code, status?}` | ❌ 不受影响（不抛，也不做 `instanceof`） |
| `providerInfo()` / `listModels()` / `resolveModel()` / `prepareCall()` | 只返回纯数据；`listModels` 与 `resolveModel` 都有 try/catch，永不 reject | ❌ |
| `providerRetryPolicy()` | 返回 `undefined` | ❌ |
| `attributionHeaders()` / `isQuotaExceededError()` / `assertUsableApiKey()` | 纯函数；后者抛出的错误**立刻在 `stream()` 内被 `failureOf()` 按数据属性读取**（读 `.code` / `.failure`，不用 `instanceof`） | ❌ |
| `registerAdapter([...], adapter)` | 运行时只做鸭子类型（`providerInfo` / `providerRetryPolicy`），**没有** `instanceof LlmAdapter` | ❌ |
| `apply()` 里的路由冲突 | 抛 `LlmError(..., 'DUPLICATE_ADAPTER')` 让 loader 报错（SPEC §4.2 + README §Troubleshooting 5 的预期行为） | ⚠️ 唯一出口；但该 `code` 不经过 DSH 的失败归一化路径，只被 loader 记录 |

⇒ 即使 `@deepseek-ai/dsh-llm` 解析到的那份与 DSH 进程自用的那份**不是同一模块实例**，本插件行为不变。这比"把 peer 声明写对"更强。

---

## 10. 自证记录（真实执行）

### 10.1 裸检出 import
```
$ node -e "import('./dsh-freellmapi/lib/index.js').then(m=>console.log(Object.keys(m)))"
[ 'Config', 'apply', 'configSchemaKind', 'formatRouteLine', 'getRecentRoutes', 'inject', 'name' ]
```

### 10.2 测试（两种运行时模式都全绿）

**v0.2.0（T9 之后，全量）**：
```
$ cd dsh-freellmapi && npm test
ℹ tests 328
ℹ pass 328
ℹ fail 0
```
- **模式 A（真品绑定）**：临时建 junction `dsh-freellmapi/node_modules -> %USERPROFILE%\.dsh\profiles\node_modules` 后：
  `llmRuntimeAvailable = true`、`LlmAdapter.name = "LlmAdapter"`、`attributionHeaders() = {"user-agent":"deepseek-harness/0.2.0-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)"}`、`configSchemaKind = schemastery`（设置页 schema 可重建：**20 个字段全 volatile、全带 description 与 default**，`validate()` 对全畸形样本 0 issues）。
- **模式 B（裸检出垫片）**：删掉 junction 后同样全绿。
- 证明：同一套代码在"有真运行时"和"什么都没有"两种环境下行为一致。（验证用的 junction 已删除，不是交付物的一部分。）

**T3 时的基线（v0.1.0，144 条）**保留在下方，便于对比：

```
$ cd dsh-freellmapi && npm test
ℹ tests 144
ℹ pass 144
ℹ fail 0
```

测试分布（v0.2.0）：`adapter` 41（**全部 gateway 模式**，即 v0.1.0 的零回归基线）· `complexity` 50（T8）· `direct` 21 · `providers` 26 · `router` 41 · `health` 20 · `dispatch` 33 · `sse` 17 · `frames` 13 · `translate` 26 · `wire` 18 · `config` 12 · `catalog` 22。

### 10.3 真实 profile 环境下加载
```
$ cd C:\Users\81521\.dsh\profiles\desktop
$ node -e "import(pathToFileURL('D:/…/dsh-freellmapi/lib/index.js').href).then(m=>console.log(...))"
exports: Config, apply, configSchemaKind, formatRouteLine, getRecentRoutes, inject, name | configSchemaKind = plain
```
（`plain` 是因为探针文件本身位于工作区、旁边没有 `node_modules`；一旦安装到 `profiles/<p>/node_modules/dsh-freellmapi/`，同级向上即可解析到真品 —— 见 10.2 模式 A 与 §6 第 1 条。**本任务未在 profile 里安装/修改任何东西，全部为只读探针。**）

---

## 11. 已知未解项 / 风险

1. **未跑过真实网关的端到端**：全部测试针对内置 mock（符合"离线可跑"的要求）。真实 freellmapi 的 SSE 细节（尤其 `stream_error` 帧的**确切 JSON 形状**）只有文档级证据，因此解析器对 `type:'stream_error'`、`code:'stream_error'`、`object:'error'`、`error:{…}` 四种形态都做了识别。
2. **`X-Routed-Via` 的百分号解码**：按 `research` §7.1 的说明实现；若网关实际不做百分号编码，`decodeURIComponent` 对不含 `%` 的值是恒等操作，无副作用。
3. **`fusion` 的 `_fusion` 帧**：只做到"识别并跳过"（不崩、不污染内容）。若要把它渲染成 DSH 的进度提示，需要新的 UI 面（本插件是 host-only，未做）。
4. **`maxTokens` 默认不声明**：DSH 因此不会物化输出上限，由网关与上游决定；若上游默认上限过小导致截断，用户可设 `maxTokens`。
5. **图片链路未在真实 attachments 服务上验证**：`attachments.imageHostPath()` 是从 `dsh-llm` 的 `resolveImageAttachmentAccess` 反推的唯一可用入口；若该服务形状变化，图片会退化为占位文本（有降级、无崩溃）。
6. **`sessionId` / `purpose` 未映射**（SPEC §6.6 说"无标准字段，可映射为 header，也可忽略"）。当前忽略；如需可加 `x-dsh-session-id` 头。
7. ~~**`maxTokensField` 默认与 README 不一致**~~ —— **已解决**：README 已更正为默认 `max_tokens`，与本实现一致。
8. **日志行文案与 Lead 示例措辞略有差异**：采用 README 已有文案 `dsh-freellmapi: routed via <via> (model=<model>)`（Lead 示例写的是 `(requested model: <model>)`）。选 README 版本是为了让已交付的用户文档逐字为真；如需改回只需改 `lib/routes.js::formatRouteLine()` 一处。

### 11.1 v0.2.0 direct 模式新增的未解项

1. **除 3 家 keyless 之外，其余 provider 的真实可用性未实测**（没有 key）。`groq` / `cerebras` / `openrouter` 的 baseURL 与模型 id 是"已确证"级证据，但**限流数字全部是 2026-04 基线**，可能过期。后果被设计隔离：限流猜错只会更早触发 429 → 冷却 → 换家，不会静默失败。
2. **`maxTokens` 全是估计值**（上游 schema 无此字段）。它只影响 `defaultMaxTokens`（DSH 的输出上限）与候选排序里的次要项；可按模型覆盖。
3. **`nemotron-3-ultra-550b-a55b:free` 的 `toolCalling:true` 是推断**（同系列 super 在上游工具白名单里，ultra 不在）。若它实际不支持工具，DSH 的 agent 请求会拿到 400。判断依据：标 `false` 会让这个 550B 模型在任何带工具的会话里**永远选不中**，等于白列；而 error 是可见可修的。若 Lead 更保守，把它改成 `false` 只需动 `lib/providers.js` 生成块里的一行。
4. **健康状态不持久化**：`HealthTracker` 只活在进程内（`toJSON`/`fromJSON` 已备好，但没有落盘）。重启后冷却清零，冷却中的 provider 会被重新尝试一次。
5. **`model_unavailable` 的识别基于错误文本/`code` 字段**（`model_unavailable` / `model_not_found` / `no such model` / `unknown model` / `model is currently unavailable`）。若某家换一种措辞，会退回"不可重试的 400"。这是**保守方向**（不会误重试真实的请求错误）。
6. **failover 不做跨 provider 的语义等价校验**：复杂档可能先试 A 家再落到 B 家，两家是不同模型。这在"还没吐 chunk"时是安全的，但用户看到的最终答案来自 B 而非首选 A——路由记录里完整写明了 `attempts`，可追溯。
7. **`routing.weights` / `routing.thresholds` 是高级字段**，在设置页里以 `z.any()` 暴露（可编辑但无表单渲染）。这是刻意的：嵌套 volatile 对象在 schemastery 里有"固定路径"约束，做深了会把整个 schema 拖进 try/catch 兜底路径。建议在 profile patch 里改。

---

## 12. v0.2.0 direct 模式（自包含智能路由）

### 12.1 双模式与零回归

`config.mode`：`'direct'`（默认）| `'gateway'`。

| | direct | gateway |
|---|---|---|
| 上游 | 内置 provider 池（`lib/providers.js`） | 外部 freellmapi 网关（`baseURL`） |
| `stream()` | `dispatchWithFailover()` | 原有 `#streamGateway()`，**代码未改** |
| `listModels()` | `auto` → `auto:simple/medium/complex` → `provider/model…` | 网关虚拟路由 → `GET /v1/models` |
| 日志行 | `tier=… -> provider/model (…)` | `routed via … (model=…)` |

`gateway` 的零回归不是口头保证：**原有 41 个 gateway 测试现在全部显式以 `mode:'gateway'` 挂载**（`tests/adapter.test.mjs` 的 `mount()` 与 `mountPlugin()` 调用点各加一个 `mode` 字段，逻辑断言一字未动），它们在 v0.2.0 下全绿。`formatRouteLine()` 的输出格式也保持不变，新增的 direct 行由独立函数 `formatDirectRouteLine()` 渲染。

### 12.2 ★ 硬不变量：吐过 chunk 就不许换家

> **failover 只允许发生在"还没有向 DSH 发出任何 chunk"之前。**

一旦任何一个 chunk 已经 `yield` 给 DSH（哪怕只是 `block-start`），再出错就**不得**尝试下一个候选——那会把两家的输出拼进同一条 assistant 消息，用户看到的将是一段"前半句 A 模型、后半句 B 模型"的污染流。

落地为**三重**保障，任何一层单独失效都不会破坏它：

1. `dispatchOnce()` 的契约：**首次 chunk 之前**的失败（传输 / 超时 / 非 2xx）**抛 `AttemptError`**——这是 failover 循环唯一被允许动作的信号；**首次 chunk 之后**的失败一律翻译成带内 `finish{kind:'error'}` 并 `return`，**绝不 rethrow**。
2. `dispatchWithFailover()` 自己维护 `emittedHere`，**独立复检**同一条件；即使将来 `dispatchOnce` 被改坏，它也会以 `STREAM_INTERRUPTED` 终止而不是换家。
3. 测试直接证明：`tests/dispatch.test.mjs` 用"先吐 2 个 token 再断流"的脚本化 fetch，断言**只有 1 次上游请求**且以 error 终结；`tests/direct.test.mjs` 再用真实 socket（写完两帧后 `socket.destroy()`）+ 一个健康的备用 provider，断言备用 provider **收到 0 次请求**、且已吐出的 `one two ` 原样交付、不被重掷。

中途失败的代价只记在**下一次**请求上：`recordFailure(..., { cooldown: false })` 只累加失败计数（轻微降权），不 park——因为一次流中断不足以证明该家整体不可用。

### 12.3 路由引擎

```
scoreComplexity(options)          // lib/complexity.js（T8，未改）
        ↓ tier / score / reasons
listProviderModels(config)        // 池 → provider/model 候选（enabled 且 key 可用）
        ↓
rankCandidates({tier, tokens, needsVision, needsTools, now, candidates, weights, preferredOrder})
        ↓ 已排序的 {provider, model, score, reasons}
dispatchWithFailover(options, plan, deps)
```

**排序规则**（`lib/router.js`，纯函数：零 import、无时钟、无随机、无 I/O）：

```
base  = wCapability·capabilityNorm + wSpeed·speedNorm      // 1–5 归一到 (v-1)/4
score = base · failureFactor · latencyFactor + preferredBonus
```

| tier | capability | speed | 语义 |
|---|---|---|---|
| simple | 0.25 | **0.75** | 最快的能干的就行 |
| medium | 0.50 | 0.50 | 均衡 |
| complex | **0.80** | 0.20 | 最强优先，慢一点无所谓 |

**硬门槛（命中即淘汰，不是降权）**：请求带图且 `vision !== true`；请求带 `tools` 且 `toolCalling !== true`；估算 token > `contextWindow`；该 `(provider, model)` 在冷却期内。淘汰原因由 `explainExclusions()` 逐条给出，写进日志与路由记录。

**软惩罚**：失败计数经**时间衰减**后乘 `1/(1+0.15·effectiveFailures)`（下限 0.4，不会把候选打到 0）；`latencyEwma` 相对**当前请求里最快的候选**取 `fastest/latency`，下限 0.85。

> **一个真实的设计修正（demo 抓出来的）**：latency 惩罚下限最初取 0.5，结果 `auto:simple`（强制快档）在快模型记录过一次较慢首字节后**改选了强模型**——因为 0.8125×0.5 < 0.4375。这违背了"强制档位"的语义。下限改为 **0.85**：latency 只在同档内做 tie-breaker，不再能翻转 tier 决策。已在 `router.test.mjs` 加断言固定这条。

**429 冷却**：`2m → 10m → 1h → 24h` 逐级（与 freellmapi 口径一致），`Retry-After` 存在时优先用它；401/403 记为 `invalid` 并 park 24h；普通 400（请求格式错误）不 park，但 `400 model_unavailable` 会 park（见 §12.12）。

**尝试上限**：`routing.maxAttempts`（默认 6）与 `routing.budgetMs`（默认 45 000，`0` = 不限）。两者都在每次尝试**之前**检查，且都有测试。

**永不抛**：`stream()` 的任何路径都以一个终结 `finish` chunk 结束。全部候选失败时产出 `ALL_CANDIDATES_FAILED` 并把 `provider/model → CODE` 的清单写进 message；池子是空的则产出 `NO_CANDIDATES` 并附上 3–5 家的 key 申请入口。

### 12.4 内置池与 keyless「装完即可用」

`BUILTIN_PROVIDERS` 是 `research/provider-catalog.json` 的直译，加上 Lead 的 keyless 实测修正后共 **12 家 / 30 个模型**（3+4+4+2+3+2+1+1+2+4+2+2），其中**默认启用 17 条 `provider/model`**（groq 3 + cerebras 4 + openrouter 4 + llm7 2 + kilo 4）。修正内容：

| 修正 | 内容 |
|---|---|
| 删 | `kilo` · `poolside/laguna-m.1:free`（实测 **404**，id 不存在） |
| 删 | `llm7` · `gpt-oss-20b`、`llm7` · `GLM-4.6V-Flash`（实测 **400 `model_unavailable`**；后者目录里还错标了 `vision:true`） |
| 增 | `kilo` · `poolside/laguna-s-2.1:free`、`kilo` · `cohere/north-mini-code:free` |
| 增 | `kilo` · `nvidia/nemotron-3-ultra-550b-a55b:free`（550B，complex 档） |
| 增 | `llm7` · `DeepSeek-V4-Flash-0731`（实测匿名 200，400k 上下文，`tools:true`） |

**默认启用集 = 5 家**：`groq`、`cerebras`、`openrouter`、`llm7`、`kilo`（`DEFAULT_ENABLED_PROVIDERS`）。其余 7 家默认关闭，可由用户在 `config.providers` 里一键打开——**不是"全部启用"**，否则只配了 1 把 key 的用户会看到满屏 unavailable 噪音。

其中 **`kilo` 与 `llm7` 是 keyless**（Lead 亲自用无 `Authorization` 的真实请求验证过 200），所以「装进 DSH → 选 `auto` → 直接可用」在**用户一个 key 都不配**的情况下成立：默认池里始终有非空候选。key 缺失的 provider 按 T7 §14.3 **静默跳过**——不报错、不告警、不提示"配置不完整"。

**推测项的处理**（`research/free-provider-catalog.md` §15 的第 1–4 项）：

| 推测项 | 处理 | 理由 |
|---|---|---|
| `zhipu.baseURL`（国内/海外 key 不互通） | **保留在池中但默认关闭**，`confidence:'speculative'` | 模型 id 已确证，只有主机名可疑；`baseURL` 与 `apiKeyEnv` 都可被用户覆盖，所以这是一个"打开前请自行确认主机"的条目，而不是死数据 |
| `volcengine.models[0].id` | **保留但默认关闭**，模型级标 `speculative: true` | 与 §15 建议一致：默认关闭 + 明确标注，用户显式启用即视为接受该风险 |
| `longcat.models[0].id` | 同上 | "无需实名的中国 provider"这个属性有独立价值 |
| `ovh.apiKeyEnv = OVH_AI_ENDPOINTS_KEY`（自定名） | **保留**，并让 `apiKeyEnv` 全程可覆盖 | 这正是 §12.5 存在的理由 |

其它保守取值：`maxTokens` 全部是估计值（上游 schema 无此字段），可按模型覆盖；`poolside/*` 与 `cohere/north-mini-code` 的 `toolCalling` 取**保守 false**（该 family 不在上游 V22 工具白名单里）；`nemotron-3-ultra-550b` 的 `vision` 取 false（宁可少声明能力），`toolCalling` 取 true（否则在 DSH 的 agent 会话里永远选不中，等于白列）。

**默认池的视觉能力**：仅 `cerebras/llama-4-maverick-17b-128e-instruct` 与 `openrouter/nvidia/nemotron-nano-12b-v2-vl:free` 两家（其余两家带 vision 的 provider 默认关闭）。删掉 llm7 那个错标的 entry 之后，池里**没有任何未经验证的 `vision:true`**。

`schema` 里的 `providers` 支持两种写法：按 id 的字典，或带 `id` 的数组。每个条目可覆盖 `enabled` / `displayName` / `baseURL` / `apiKeyEnv` / `apiKey` / `keyless` / `models`（给了 `models` 就**整份替换**）。加一个自建 OpenAI 兼容端点只需 4 个字段。

### 12.5 `apiKeyEnv` 是约定，不是上游事实

freellmapi 本身没有 `apiKeyEnv` 概念（它的 key 存在 dashboard 背后的加密库里），所以 T7 目录里的每个 `apiKeyEnv` 都是**我们自己的命名约定**。因此 `resolveProviderKey()` 的解析顺序设计成"约定永远可被覆盖"：

1. **`ctx.credentials`**（DSH 的权威凭据层，本身分层：进程环境 → 托管存储 → `$DSH_HOME/.env`）—— 用 provider 的 `apiKeyEnv` 作为引用名；
2. **配置里显式给的** `config.providers[id].apiKey`；
3. 环境变量 `apiKeyEnv`；
4. 兜底约定名 `<PROVIDER_ID>_API_KEY`。

每一步都 trim，空串视为未配置；**每次请求现取、绝不缓存**。凭据服务抛错时不吞掉、但也不阻断后面的兜底层。于是哪怕我们对某家命名猜偏，用户改一行配置就能自救。

### 12.6 `model_unavailable`：唯一一个可 failover 的 400

**Lead 的实测发现**：llm7 这类聚合器的模型可用性会漂移——同一个 id 今天 200、明天
`400 {"error":{"code":"model_unavailable","message":"Model 'X' is currently unavailable."}}`。

`lib/errors.js::classifyStatus()` 原本把 400 整体归为**不可重试**的请求错误，这对该 code 是错的：它语义上是"这家现在没有这个模型"，属于**一个 `(provider, model)` 的状态**，应当冷却该组合并换下一个候选。

改动（**这是本任务唯一一处越出 T9 名单的修改，Lead 在消息中明确要求**）：

- 新增 `MODEL_UNAVAILABLE_CODE` 与 `isModelUnavailableError()`；`classifyStatus()` 在 401/403 之后、429 之前识别该 code，**其它 400 一律保持不可重试**；
- `describeHttpFailure()` 为该 code 给出一句能行动的诊断（点名 provider 与 model，说明这是 per-model 条件）；
- `lib/dispatch.js::isRetryableStatus()` 把它列为可重试，并额外把 **404 也列为可重试**——404 通常就是"这家没有这个 id"，与 freellmapi 自己的 exhaustion 集合（`429/502/413/404/503`）一致。

测试覆盖**两种情况**：`model_unavailable` 的 400 会 failover（有 e2e：第二个 provider 服务了请求，路由记录里第一次尝试的 code 是 `MODEL_UNAVAILABLE`）；普通 400（如 `messages is required`）**不会** failover（断言只发出一次上游请求）。

### 12.7 配置新增（供 T10 写文档）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `mode` | `'direct'` \| `'gateway'` | `direct` | 自包含路由 / 转发到外部网关 |
| `logRouting` | boolean | `true` | 记录并打印路由决策（tier、选中者、尝试了几家） |
| `providers` | dict | `{}` | 按 provider id 覆盖内置池（`enabled` / `baseURL` / `apiKeyEnv` / `apiKey` / `keyless` / `models`） |
| `routing.maxAttempts` | number | `6` | 单请求最多尝试几个候选 |
| `routing.budgetMs` | number | `45000` | 单请求 failover 总预算；`0` = 不限 |
| `routing.thresholds` | `{medium, complex}` | 见 T8 | 覆盖复杂度阈值 |
| `routing.weights` | `{capability, speed}` 或按档 | — | 覆盖排序权重 |
| `routing.preferredOrder` | string[] | `[]` | provider id 的偏好顺序（有界加分，最多 0.05） |

全部字段沿用 T3 的防御性契约：**任何畸形配置只降级、绝不抛**（`Config['~standard'].validate` 在全畸形样本下 0 issues，见 §10.2）。

### 12.8 direct 模式的模型列表契约

第一项恒为 **`auto`**，其后是 `auto:simple` / `auto:medium` / `auto:complex`（强制档位；分类器仍会跑，分数照记，只是 tier 被覆盖并在 reasons 里注明"forced by the selected model id"），再是池里每个启用的 `provider/model`。返回值全部满足运行时校验：`provider === 'freellmapi'`、id 唯一、name 非空。`resolveModel()` 对**显式点名的** `provider/model` 使用该池条目的 `contextWindow` / `maxTokens` / `inputModalities`，这样 DSH 的压缩预算与实际作答的模型一致。

### 12.9 direct 模式自证（真实执行）

同一 mock 池里放"快但弱"（capability 2 / speed 5）与"强但慢"（capability 5 / speed 2），一次真实端到端输出：

```text
--- SIMPLE request ---
  request     : model=auto  prompt="列出这个目录下的文件"
  upstream    : answered by FAST/WEAK (capability 2, speed 5)
  finish      : stop
  classified  : tier=simple  score=0.000  candidates tried=1
  selected    : fastmock/fast-weak  (capability=2, speed=5)
  log line    : dsh-freellmapi: tier=simple -> fastmock/fast-weak (capability=2, speed=5, 1 candidates tried)
  reasons     : ["tier=simple score=0.000","10 estimated input tokens","1 simple-task keywords (lowers the score)","simple tier weights: capability 0.25 / speed 0.75","capability 2/5"]

--- COMPLEX request ---
  request     : model=auto + 12 tools  prompt="重构这个模块并给出架构权衡与失败模式分析"
  upstream    : answered by STRONG/SLOW (capability 5, speed 2)
  finish      : stop
  classified  : tier=complex  score=0.822  candidates tried=1
  selected    : strongmock/strong-slow  (capability=5, speed=2)
  log line    : dsh-freellmapi: tier=complex -> strongmock/strong-slow (capability=5, speed=2, 1 candidates tried)
  reasons     : ["tier=complex score=0.822","20 estimated input tokens","12 tool schemas","4 complexity keywords","1 comparison markers"]
```

同一份输出已固化为 `tests/direct.test.mjs` 的 `core promise` 测试（断言两个 mock 的**请求计数**，而不只是内容），所以这条承诺每次 `npm test` 都会被重新证明一次。

### 12.10 ★ picker id → wire model 的映射（T12 修复）

**缺陷**：direct 模式曾把 **DSH 层的路由 id** 当作模型名发给上游。选路是对的（`target.model` 是正确的真实模型名），但线上发的是 picker id：

| picker id（用户在 GUI 选的） | 曾经发到上游的 `body.model` | 修复后 |
|---|---|---|
| `auto` | `auto` ❌ | 被选中模型在 provider 侧的真实 id |
| `auto:simple` / `auto:medium` / `auto:complex` | 同名 ❌ | 同上 |
| `provider/model`（如 `groq/llama-3.3-70b-versatile`） | 复合 id ❌ | 只发 `model` 那一半 |

真实 provider 收到这些只会回 `404 model_not_found`，因此**任何真实 provider 上 100% 失效**——选路正确、请求全挂。

**修复**：`lib/dispatch.js::dispatchOnce()` 在 `buildChatRequest(...)` 之后、`Object.assign(body, target.extraBody)` **之前**写入 `body.model = target.model`。顺序刻意如此：provider 声明仍可用 `extraBody.model` 改写线协议模型名（某些网关需要别名），把合并放在后面才保住这个语义。

**两条归一化路径都收敛到同一个值**：

| 用户选择 | 选路依据 | 上线模型名 |
|---|---|---|
| `auto` / `auto:<tier>` | `scoreComplexity()` + `rankCandidates()` 选出 `(provider, model)` | `target.model`（provider 侧裸 id） |
| `provider/model` | `splitPoolModelId()` 按**第一个** `/` 切分 → 过滤池 → 该条目唯一 | `target.model`（= 第一个 `/` 之后的一切，含 id 内自带的 `/`，如 `openai/gpt-oss-120b`） |

**三个 id 因此自洽**：`listModels()` 播发的是 DSH 侧标识（虚拟路由或 `provider/model`），`resolveModel()` 用它查池取元数据，`dispatch` 发出的是 provider 侧裸 id。`tests/direct.test.mjs` 里有一条测试**遍历完整目录的每一个 id**，断言上游收到的 `body.model` 既不等于 picker id、又必须是该 mock 端点真正提供的 id。

**为什么这类 bug 能藏住（以及现在为什么不能）**：当时的 mock 对任何模型名都回 200。现在 `tests/helpers/pool.mjs::startProviderMock()` 像真实 provider 一样**校验 `body.model`**，不在它声明的 id 集合里就回 `404 {"error":{"code":"model_not_found"}}`，并把这个值记进 `badModels`。补上校验后 **27 条 direct 测试里有 17 条立刻变红**——红就是缺陷被抓住的证明；修完实现后全绿。另有一条元测试直接 `fetch` 打 mock、断言它对 `model:"auto"` 真的回 404，证明这套校验本身有效。

### 12.11 provider 声明的 `extraBody` / `extraHeaders` 必须真的上 wire

`applyOverride()` 曾经逐字段重建 provider 声明（`id` / `displayName` / `baseURL` / `apiKeyEnv` / `apiKey` / `keyless` / `enabled` / `models`），**丢掉了 `extraBody` / `extraHeaders`**。后果是静默的：`listProviderModels()` 永远给出 `extraBody: {}`，`dispatch.js` 的 `Object.assign(body, target.extraBody)` 什么也拿不到，于是

> NVIDIA 必须固定 `parallel_tool_calls: false` 这条要求**从未离开过进程**。

修法：两者都带进 declaration，并做**浅合并**（`{...内置, ...用户}`），这样用户 override 是叠加而不是抹掉内置值。测试断言的是**出站请求体**（`mock.requests.at(-1).body.parallel_tool_calls === false`）与**出站请求头**，而不是对象相等——对象相等正是当初漏掉它的那种断言。

### 12.12 `model_not_found`（404）与 `model_unavailable`（400）是同一类

两者都表示"**这家此刻没有这个模型**"，只是状态码不同：真实 provider 对未知 id 回 `404 model_not_found`，漂移中的聚合器对下架模型回 `400 model_unavailable`。

处理方式：`errors.js::isModelUnavailableError()` 的标记集同时覆盖两种措辞，`classifyStatus()` 在 401/403 之后、其它 400/404 分支之前把它们统一归类为 `MODEL_UNAVAILABLE`；`dispatch.js::isRetryableStatus()` 因此把这两种情况都判为**可重试**（冷却该 `(provider, model)` 组合并换下一个候选），而不是让整个请求失败。

**同时，一个不带该措辞的裸 404 也是可重试的**。理由：404 在这里几乎总是"这家没有这个 id"（本次修复前 catalog 里就有一个 404 的死 id），而 freellmapi 自己的 exhaustion 集合 `429/502/413/404/503` 也把 404 当作"换一家"的信号。代价是当 `baseURL` 整体写错（例如漏了 `/v1`）时每个候选都会 404，最终以 `ALL_CANDIDATES_FAILED` 结束——诊断信息里逐条列出 `provider/model → MODEL_UNAVAILABLE`，仍是可读的失败。

三种情况都有测试：400 `model_unavailable` failover、404 `model_not_found` failover（并断言该组合被冷却、下一次请求不再重打）、普通 400（`messages is required`）**不** failover。

### 12.13 T13：四处语义修正

#### 12.13.1 未被测量的延迟不是满分（M-2，发布闸门）

原先"从未测量"的候选拿到满分因子 1.0，于是"**测过且慢**"输给"**从没测过**"：

```text
场景：auto:simple；fastweak(2,5) 测到 60000ms；balanced(4,4) 从未测量；strongslow(5,2) 测到 1000ms
  修正前  ranked = [balanced 0.7500, fastweak 0.6906, strongslow 0.4375]   ← 快车道不再选快模型
  修正后  ranked = [fastweak 0.6906, balanced 0.6375, strongslow 0.4375]   ← 快模型拿回快车道
```

修法不是调下限，而是改语义：**未测量的因子 = 本次请求里已测到的最慢因子**（"没有证据，就当你不会比我们见过的最慢更快"）；当**一个都没测过**时，所有候选都是 1.0，延迟信号整体不参与。这样"已测且快"必然赢过"从未测量"，未来可被证伪而不是靠一个常数。

正向断言已固定：三条能力完全相同的候选里，测到 800ms 的必须排在从未测量的前面。

**外加一条噪声门（`LATENCY_NOISE_FLOOR_MS = 100`）**：只有当已测样本的**极差 ≥ 100ms** 时延迟信号才参与排序，否则整体丢弃（每个候选都按"未测量"处理）。理由是实测出来的：Lead 验收脚本里的三个 localhost mock 被测到 26ms 与 4ms——相差 6 倍，但两个亚 100ms 样本的比值只是**预热噪声**，不是吞吐量。按它排序等于按噪声排序，还会把"恰好先答完"的候选永久抬高。加门之后：

- 验收脚本的 medium 档：三条候选能力分完全相同（0.625/0.625/0.625），延迟被判定为噪声 ⇒ 三方并列 ⇒ 按 provider id 决胜 ⇒ `balanced`（脚本期望值）✓
- M-2 场景：极差 59 000ms ⇒ 信号有效 ⇒ 快模型保住快车道 ✓

两者不再冲突，而且各自成立的理由是真实的，不是互相迁就。

#### 12.13.2 失败必须随时间衰减（M-1，永久饿死）

一次 429 让失败因子变成 0.870，候选掉到从未失败的同伴之后 ⇒ **再不被选中 ⇒ 永远拿不到那个能清零的成功**。实测（修复前）：+61s、+10h 都仍是同伴被选中。

修法：`failures` 保留原始计数（诊断用），另外暴露 **`effectiveFailures`**，按 `0.5 ** (elapsed / failureHalfLifeMs)` 衰减，半衰期默认 **60s**（远短于 2m→10m→1h→24h 的冷却阶梯——冷却才是真正的惩罚，这个因子只用来在"已获准运行"的候选之间排序）。冷却刚过期时残余权重只剩 0.25，候选重新排到首位；一次成功则两者一起清零。

测试用可注入时钟推进到冷却刚过期（断言它**重新排在首位**，不只是 `isAvailable()`），再推到 +10h（断言残余惩罚 < 0.001）。

#### 12.13.3 第几次失败才 park（L-1）——选择「改文档」

实现保持不变：**首次可重试失败即 park** 2 分钟，之后每次连续失败把阶梯升一级（2m→10m→1h→24h）。

理由：免费额度下的 429 本来就意味着"现在该退避"，第一次不 park 只会让下一个请求再撞一次同样的墙、白付一次延迟；而阶梯本就是"越失败越久"的设计，把"窗口内 N 次"叠上去只会让它更复杂而不更正确。

**需要 T14 改 README 第 293–294 行**（`dsh-freellmapi/README.md`，`Health and cooldowns` 第一条）：

> 原：`Consecutive failures multiply a candidate's score by \`1 / (1 + 0.15 · failures)\` (floor 0.4), and the **third failure in a row** parks it: **2 m → 10 m → 1 h → 24 h**.`

建议改为：`Consecutive failures multiply a candidate's score by \`1 / (1 + 0.15 · effectiveFailures)\` (floor 0.4), where the failure weight decays with a 60-second half-life. The **first retryable failure already parks the candidate** for 2 minutes, and each further consecutive failure escalates the ladder: **2 m → 1 h → 24 h**.`

（同页第 90 行与第 296–297 行关于"latency 是同档内 tie-breaker、floor 0.85"的表述与实现一致，无需改动。）

#### 12.13.4 畸形 `caps` 一律保守降级（L-3）

`rankCandidates` 原先在两处出错：

- `usable.push({ …, ...record })` 把规范化后的 `caps` 用**原始值覆盖**回去了，于是 `caps: null` 的候选在打分阶段变成 `null.capability` → **TypeError**；
- `contextWindow` 缺失时默认 0，任何非空请求都会被 context 门**静默丢掉**——静默丢候选比抛错更危险。

修法：只在 `usable` 里放规范化后的字段；`caps` 缺失/畸形时用保守默认（capability 3 / speed 3 / contextWindow 32768，`vision` 与 `toolCalling` 取 false）；`contextWindow` 是**假设**而非声明时，候选照常参与排序并在 `reasons` 里写明 `no context window declared; a conservative default is assumed`；只有估算 token 超过这个保守假设时才淘汰，淘汰原因也标明是"假设值"。

边界测试覆盖 `caps: null` / `undefined` / `{}` / 标量 / 数组 / 字段全是垃圾。

#### 12.13.5 与 T11 验证套件的关系（`_verify2/`，只读）

T11 的 harness 有三条"信息性探针"，修复后其中两条变成 `not reproduced`：

```text
  not reproduced  a demoted candidate can be starved permanently (no failure decay)
  not reproduced  rankCandidates throws on a candidate whose caps/health are not objects
```

控制组 **72/72 checks passed, VERDICT PASS**（修复前它是红的），静态检查 19/19 PASS，缺陷注入 6/6 DETECTED（含 `i6` 删掉 `body.model = model` 那行）。

`i3-no-cooldown-after-429` 的注入锚点是 `lib/health.js` 里的一行字面量；我在重写 `recordFailure()` 时**特意保留了那一行的原文**，并把"凭据失效必然 park"的规则挪到 `&&` **之后**再做一次或运算（`const cools = shouldCool || invalid`），这样抑制策略永远不会让一个被拒的 key 留在轮换里。六个锚点现在都在源码里各出现一次。

**第三条探针仍然显示 `REPRODUCED`，且这是正确的**：它的输入是**裸 `{status: 400}`（不带任何 code）**，而裸 400 是"请求格式错误"，本就不该 park；它的名称虽提到 `model_unavailable`，却没有构造那个条件。真正的 `model_unavailable` 修复在 dispatch 层（`cooldown: error.retryable`），由本插件自己的 e2e 测试钉住（400 与 404 两种拼写**都** park 并跳过下一次请求）。如果把裸 400 也改成默认 park，这条探针反而会抛错、harness 变红——那才是错的方向。

### 12.14 T15：静默替换（严重）与"装死的列表"

#### 12.14.1 缺陷 A：钉模型被静默替换

零凭据实测（`_lead/pinned-probe.mjs`）：

| 请求的 model | 修复前 | 修复后 |
|---|---|---|
| `llama-3.3-70b-versatile`（groq 的模型，无 key） | 由 `llm7/DeepSeek-V4-Flash-0731` 作答，**`finish: stop`** | `finish: error` / `MISSING_CREDENTIAL`，**上游 0 次请求** |
| `totally-made-up-model-xyz`（不存在） | 由 `kilo/cohere/north-mini-code:free` 作答，**`finish: stop`** | `finish: error` / `UNKNOWN_MODEL`，**上游 0 次请求** |

根因：`#streamDirect` 只把 `splitPoolModelId(options.model)` 当**过滤器**用，而它对不带 `/` 的 id 返回 `undefined` ⇒ 过滤器等于不存在 ⇒ 落回"池内自由选型"。用户点名的模型于是被当成 `auto` 处理。

**严格模式**：`model` 既不是 `auto` 也不是 `auto:<tier>` 时就是**钉模型**，只允许匹配该模型的候选，绝不回退：

1. 先按 `provider/model` 精确匹配（picker 播发的复合 id）；
2. 再按**裸 model id** 精确匹配（`GET /v1/models` 与各家文档的写法，例如 `llama-3.3-70b-versatile`；也可能同时命中多家的同名模型——那仍是同一个模型，所以它们之间 failover 是诚实的）；
3. 都不命中 ⇒ `UNKNOWN_MODEL`：message 给"最接近的 3 个 id"、提示"该 provider 默认关闭时怎么打开"，并建议改用 `auto`；
4. 命中但该家**没有凭据** ⇒ `MISSING_CREDENTIAL`：message 点名**确切的 env 名**与**申请地址**，并说明"或在 DSH 设置页粘贴"；
5. 命中但被**冷却 / 其它硬门槛**挡住 ⇒ `MODEL_UNAVAILABLE`：附上逐条排除原因，建议 `auto` 或稍后重试。

`auto` / `auto:simple|medium|complex` 的行为**一字未改**（池内选型 + failover 照旧）。

#### 12.14.2 缺陷 B：列表里 15/21 是装死的

`listModels()` 原先不解析凭据（`stream()` 才在 dispatch 前 `isProviderUsable` 过滤），零凭据下 advertised 21 / 真正可连通 6，而用户截图里最前面的正是打不通的 Groq/Cerebras。

**方案 C（用户拍板）**：`listModels()` 现在也解析凭据（每个 provider 一次，与 `stream()` 共用 `#resolveProviderKeys`）：

| provider 状态 | 产出 |
|---|---|
| keyless，或解析到凭据 | 照常列出它的真实模型 |
| `enabled` 但拿不到凭据 | **恰好 1 条**引导项 `setup:<provider>`，名字形如 `Groq ▸ needs GROQ_API_KEY (free key: console.groq.com/keys)`，`description` 同样带 env 名与申请地址 |
| `enabled: false` | **什么都不产出**（zhipu / volcengine / longcat 不会混进来） |

引导项的 id 约定是 **`setup:<providerId>`**（`catalog.js::setupModelId()` / `SETUP_MODEL_PREFIX`），已被测试固定。排序上**可服务的模型排在引导项之前**——起因就是"打不通的排在最前"，引导项绝不能把能用的模型挤下去。

零凭据默认池现在是 **13 条**（4 条虚拟路由 + 6 条 kilo/llm7 真实模型 + 3 条引导项），**没有一条装死的模型行**。配好 key 后下一次 `listModels()` 会重新解析凭据 ⇒ 真实模型出现、引导项消失（有测试）。

#### 12.14.3 这次为什么旧 mock 又没抓住

上一轮把 mock 加固成"校验 `body.model`"，抓住的是**形状**问题（发出去的模型名对不对）；静默替换是**该不该发这个请求**的问题——mock 只看到"来了一个请求、模型名合法"就回 200，于是"本该被拒绝的请求被发到了别的 provider"完全不在它的观测范围内。

新的直证断言把两件事绑在一起：**任何"应当被拒绝"的场景都必须同时满足 ①以 error 终结、②整个 mock 池收到 0 次请求**。第二条才是"没有偷偷打给别人"的证据——只看 ① 的话，一个"先偷偷打给别人、失败后再报错"的实现也会通过。`tests/pinning.test.mjs` 里 8 个拒绝场景全部带这一条（`totalRequests(pool) === 0`）。

#### 12.14.4 需要 T14 补的文档

- 模型列表新增 `setup:<provider>` 引导项：说清"它不是一个模型、选中它不会发起请求"，以及"配好 `apiKeyEnv` 后重开列表即可"。
- 钉模型是**严格模式**：请求 `provider/model` 或裸 model id 时，插件只会用那个模型；没 key / 模型不存在 / 正在冷却都会**报错并给引导**，绝不替你换一家。想让它自由选型请用 `auto`。

### 12.15 T17：key 申请地址的**单一来源**（N-2 同类：常量副本漂移）

文档席位在 T16 收口时如实报出：三个引导项里 `cerebras` 那条**没有申请地址**，文案是 `Cerebras ▸ needs CEREBRAS_API_KEY (free key: configure it in DSH settings)`——而它正是默认启用集里的一家，且用户这次要的就是"引导去添加 API key"。

**根因**：同一个事实存在两处。`lib/dispatch.js` 里有一张硬编码的 `KEY_ENTRY_POINTS`（含 `'Cerebras https://cloud.cerebras.ai/'`），`lib/catalog.js::setupHint()` 却读 `provider.keyURL`；`providers.js` 里 `cerebras.keyURL = null`，于是**一张表知道地址、另一张表是空的**。这与 T11 验证席位把 `CONSERVATIVE_CAPS` 副本列为 N-2 是同一类问题：两份会各自演化的数据。

**收敛**（`providers.js` 现在是唯一权威）：

| 位置 | 变化 |
|---|---|
| `providers.js::providerDeclarations(config)` | **新增**：把"有哪些 provider、各自声明什么"抽成一个函数——内置顺序 + 用户覆盖，`listProviderModels()` 与 `keyEntryPoints()` 共用它 |
| `providers.js::keyEntryPoints(config)` | **新增**：enabled 且 `keyURL` 非空的 provider → `{id, displayName, apiKeyEnv, keyURL}` |
| `providers.js::BUILTIN_PROVIDERS` | `cerebras.keyURL` 由 `null` 补为 `https://cloud.cerebras.ai/` |
| `dispatch.js` | **删掉** `KEY_ENTRY_POINTS`，`NO_CANDIDATES` 的文案改为调用 `keyEntryPoints(config)` |

`NO_CANDIDATES` 现在引用**用户自己池子里**能用的入口；如果用户把所有 provider 都关了（这是走到这条诊断最常见的原因），回落到出厂默认池的入口，所以文案不会因为没有 enabled 的家而变成空话。

**为什么不给其余几家编 URL**：`github` / `zhipu` / `volcengine` / `longcat` / `nvidia` / `ovh` 在 `research/free-provider-catalog.md` 里**没有** key 申请地址的取证记录（各家的 `key 申请` 一栏要么缺失、要么写着"未列（不编造 URL）"）。它们默认关闭，编一个错的地址比留空更糟，因此保持 `null`，`setupHint()` 的措辞退化为 `(free key: configure it in DSH settings)`——依然可操作，且不出现 `null` 字样。

`kilo` 也是 `null`：它**keyless**，永远可用，因此**永远不会**产出引导项，不需要 key 地址；`llm7` 同为 keyless 但保留它的 token 页（用户想提高额度时用得上）。因此不变式写成**"enabled 且非 keyless ⇒ 必须有 keyURL"**，而不是"enabled ⇒ 必须有"。

**反漂移断言**（`tests/pinning.test.mjs`）：

1. **源码级**：`lib/dispatch.js` 里**不允许出现任何 `http(s)://` 字面量**——地址再想回来就得先过这条测试；
2. **数据级**：每个 enabled 且非 keyless 的 provider 必须有 keyURL，且必须是 `https://`；
3. **文案级**：`NO_CANDIDATES` 的 message 必须逐一包含 `keyEntryPoints()` 里前 5 条的 URL，且必须含 `cloud.cerebras.ai`（就是这次回归的那一条）；
4. **覆盖级**：用户改了 `providers.groq.keyURL` 时，文案引用的是**用户的值**而不是内置值；
5. **措辞级**：遍历所有 provider 的 `setupHint()`，断言不含 `null` / `undefined` 且都带 `needs <ENV>`。

补后的全表（enabled 且 needs-key 的家**全部**有地址）：

```text
ON  groq         needs-key  https://console.groq.com/keys
ON  cerebras     needs-key  https://cloud.cerebras.ai/          ← 本次补齐
ON  openrouter   needs-key  https://openrouter.ai/keys
off mistral      needs-key  https://console.mistral.ai/api-keys
ON  llm7         keyless    https://token.llm7.io/
ON  kilo         keyless    (null)   ← keyless，永不产出引导项
off github / zhipu / volcengine / longcat / nvidia / ovh   (null)   ← 无取证，不编造
```

### 12.16 T18：引导项被选中时，答复必须**就是**那条引导

用户（李刚）重启后截图显示 v0.3.0 的列表完全正确，但拖动选中态落在了 `Groq ▸ needs GROQ_API_KEY` 那一行上。实测"真点它会怎样"：

```text
finish  : error
code    : UNKNOWN_MODEL
message : dsh-freellmapi: no provider in the pool serves the model id "setup:groq".
          Select "auto" to let the plugin pick a model that is actually available.
```

**标签在引导，行为在误导**：整段话没提 key（而这行的全部意义就是让你去配 key）、把一条**我们自己播发**的引导项当成拼错的模型名、还建议改用 `auto`——等于让用户放弃他本来想配的那家。同期 `resolveModel('setup:groq').name` 返回裸 id `setup:groq`，而 `listModels()` 里同一条是友好文案，**同一个实体两个名字**。

**修法**：`setup:` 前缀在严格路径里**先于**钉模型判定被识别（用 `catalog.js::SETUP_MODEL_PREFIX`，没有第二处字符串常量）：

| 输入 | 分支 | code |
|---|---|---|
| `setup:groq`（provider 在池里） | 引导分支 | **`SETUP_REQUIRED`** |
| `setup:nosuchprovider`（provider 不在池里） | 未知模型分支 | `UNKNOWN_MODEL` |
| `totally-made-up-model-xyz` | 未知模型分支 | `UNKNOWN_MODEL` |
| `llama-3.3-70b-versatile`（真模型、无 key） | 缺凭据分支 | `MISSING_CREDENTIAL` |

**message 与列表同源**：新抽出的 `catalog.js::setupModelEntry(runtimeProvider, providerId, declaration)` 是这条实体的唯一构造器，`buildDirectCatalog()`、`#modelInfo()`（`resolveModel` / `prepareCall`）与 `setupRequiredFailure()` 三处都调它。于是

- message **逐字等于** picker 里那条的 `description`（前一句就是 `setupHint()` 的文案）；
- `resolveModel(id).name === listModels()` 里同一条的 `name`（有测试断言相等，`prepareCall` 也一并断言）；
- 想改文案只改一处，三处一起变。

**为什么用专用码 `SETUP_REQUIRED` 而不是复用 `MISSING_CREDENTIAL`**：这是**两种不同的用户动作**。`MISSING_CREDENTIAL` 表示"你要的是一个真模型，但这台机器服务不了它"；`SETUP_REQUIRED` 表示"你点的是那条专门用来提示你去配 key 的引导行"。分开还有一个实际好处：`UNKNOWN_MODEL` 的语义因此一点都不用动——真正的拼写错误仍然走它，三条分支各有各的修法。测试里专门断言了 `setup:` 与拼错模型的 **code 不相等**，以及引导文案里**不出现** `no provider in the pool serves` 这句未知模型措辞。

`setup:` 行依旧**不发任何上游请求**，并且现在连凭据 seam 都不碰（有断言：`credentials.resolve` 调用次数为 0）——这行的存在前提就是凭据缺失，为它去解析凭据是自相矛盾的。

### 12.17 T19：contextWindow 数据错误 + 上下文溢出应当换更大的家

用户真实会话（29.7 万 token）撞上的报错：

```text
dsh-freellmapi: the request exceeds the context window of the model the router selected;
compact the session or lower the attached history, then retry
— [model=nvidia/nemotron-3-super-120b-a12b:free status=400]
— upstream said: This endpoint's maximum context length is 262144 tokens.
  However, you requested about 297538 tokens.
```

#### 12.17.1 主因：一个错数据同时造成"选错"和"排除了对的"

`kilo` 四家的 `contextWindow` 全错，而且**两个方向都错**：

| model | 修复前声明 | 上游实测（2026-10-13 `GET https://api.kilo.ai/api/gateway/models`） |
|---|---|---|
| `nvidia/nemotron-3-super-120b-a12b:free` | 1,000,000 | **262,144**（虚报 4 倍） |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 131,072 | **1,000,000**（少报 8 倍） |
| `poolside/laguna-s-2.1:free` | 131,072 | **262,144** |
| `cohere/north-mini-code:free` | 131,072 | **256,000** |

于是路由**以为** super 能装 100 万 → 选它 → 上游 400；而**真正能装 100 万的 ultra 被标成 131k，被上下文闸门在 dispatch 之前就排除了**。一个数字同时毁掉两端。

**复核结果**（`source` 字段逐条写明来源与日期）：

- **实测**：`kilo` 四家 + `llm7` 两家（`DeepSeek-V4-Flash-0731` = 400000、`codestral-latest` = 32000，与既有值一致）。llm7 的字段是嵌套的 `context_window.tokens`。
- **仍是估计**：`groq` / `cerebras` / `openrouter` / `github` / `mistral` / `zhipu` / `volcengine` / `longcat` / `nvidia` —— 这些家的 `/v1/models` 无凭据一律 **403**；`ovh` 虽然 200，但**根本不发布** context 字段。这些值保持原样并在文件头注明是目录估计值，**没有编造任何一个数字**。

#### 12.17.2 估算偏低 ⇒ 闸门必须保守（安全裕度）

估算器是启发式的（CJK ≈ 1 token/字，其余 ≈ 4 字符/token），对真实 297,538 token 的会话给出的是**偏小**的值，所以它从 262,144 的闸门底下溜了过去。

新增 `routing.contextSafetyFactor`（默认 **1.15**，可配置）：候选必须满足 `contextWindow >= estimate * contextSafetyFactor`。

**非法值怎么处理**（实测口径，与 README 一致）：`config.js` 用的是 `numberField(value, DEFAULT, { min: 1 })`，所以

| 输入 | 结果 | 原因 |
|---|---|---|
| `1` | `1` | **合法**——等于"不要裕度"，此时闸门退化为 `estimate > contextWindow` 才排除 |
| `0.5` / `0` / 负数 | **1.15** | 小于 `min: 1` ⇒ **该值被拒绝、回落到默认**（不是"夹到 1"） |
| `'abc'` / `NaN` / `null` | **1.15** | 非有限数 ⇒ 同样回落默认 |

即裕度**永远不会低于 1**，但靠的是"拒绝并回落默认"而非钳位。`router.js` 里另有一层 `safetyFactor < 1 → 1` 的防御，只对**绕过 `normalizeConfig` 直接调用 `rankCandidates()` 的调用方**生效（单测就是这么调的）；正常配置路径到不了那里。

宁可少选一个"可能刚好装下"的模型，也不要发出去被上游 400 打回——前者的代价是一点选型质量，后者的代价是整单失败。

#### 12.17.3 上下文溢出改为**只向更宽的家**换

上游的 `maximum context length` 措辞本来就被 DSH 的 `isContextWindowExceededError` 认成 `CONTEXT_WINDOW_EXCEEDED`（归类一直是对的，问题在于它是**终结性**的）。现在：

- `dispatch.js::isRetryableStatus()` 把该 code 判为**可换家**（与 `model_unavailable` 同族：请求没问题，这个候选装不下）。
- 换家有**方向约束**：`minimumContextWindow` 记录已经拒绝过的最大窗口，循环跳过所有 `contextWindow <= 它` 的候选。换一个更小的没有意义。
- **硬不变量不动**：一旦已向 DSH 吐出过 chunk，仍然绝不换家（`STREAM_INTERRUPTED`）。
- 全池都装不下时，错误信息给出**本次估算 token**、**拒绝它的那个窗口**、**池内最大 contextWindow 及其模型名**，以及可操作建议。

**冷却语义（自行裁决并记录在此）**：上下文溢出**完全不记 failure、也不冷却**。它没坏——同一个模型换一个短请求照样正常服务；把它 park 几分钟属于误判。真正有用的信息是它刚告诉我们的那个窗口，而闸门（含裕度）下次就会用上它。这一条有测试断言 `cooldownUntil === 0 && failures === 0`。

#### 12.17.4 这次 mock 的盲区：它从不强制执行自己声明的约束

历轮的 mock 校验模型名、校验请求体形状，却**从不校验请求体大小**，所以"把装不下的请求发给这个模型"整类不可见——和当年"不校验模型名"是同一个毛病：**mock 没有强制执行它所模拟系统的约束**。

`tests/helpers/pool.mjs` 现在让每个端点**强制执行自己声明的 `contextWindow`**：超限就回 `400 {"error":{"message":"This endpoint's maximum context length is N tokens. However, you requested about M tokens.","code":"context_length_exceeded"}}`（照上游真实形状），并记进 `overflows`。强制执行用的窗口直接取自池里声明的同一个数字（`startMockPool` 一次传入），所以改测试模型的窗口会同时改它的模拟上限，两者不可能漂移；`setContextWindow()` 可以单独压低强制值，用来模拟"目录漂移"（声明 1M、实际只给 100k）。

`tests/context-window.test.mjs`（14 条）覆盖：数据表断言、池内最大窗口能装下 297,538、裕度与边界（9200 够 / 8199 不够）、**30 万 token 请求选中装得下的那个且 262,144 那个一次都没被请求**、上游 400 后**只向更宽的换**、溢出**不冷却**、全池装不下时的 message 含估算与池内最大值、**吐过 chunk 后不换家**、以及一条元断言"mock 真的会拒绝超限请求"。

#### 12.17.5 复现脚本的额外收获

`t19-repro.mjs` 用真实 kilo 数值跑同一请求两次（只改"池子声明什么"，端点始终按真实窗口强制执行）：

```text
A. BEFORE  declared super=1,000,000 / ultra=131,072
   super asked: 1 (400s: 1)   ultra asked: 0   finish: error / CONTEXT_WINDOW_EXCEEDED
   → 用户的事故原样复现；且因为 ultra 被声明得**更小**，连新的换家规则也救不了它
     （换家只向更宽的方向走）——数据错误就是致命的。
B. AFTER   declared super=262,144 / ultra=1,000,000
   super asked: 0   ultra asked: 1   finish: stop, answer "ULTRA"
   → 一次请求直达能装下的那家。
```

这个脚本当场抓出一个单测没覆盖的缺陷：`contextOverflowFailure(plan, attempts, minimumContextWindow)` **实参顺序传反**（签名是 `(plan, refusedUpTo, attempts)`），只有在"先真打过一次、再没有更宽的候选"这条路径上才会暴露成 `attempts.map is not a function`。已修，并补了对应的单测。

### 12.18 T22：按官方知识库补齐交付合规（展示元数据是最实质的一条）

前 12 节都是"它能不能正确工作"，这一节是"**它在 Plugin Manager 里看起来对不对**"。0.2 世代把展示信息做成**在不激活插件的前提下读取**的独立交付面：能跑 ≠ 交付完成。

依据（`dsh-plugin-guide` v0.3.33，本机安装）：`guide/plugin-dev-guide.md` §7.0.1（展示元数据与图标）与 §8（规范与质量门禁），清单细则在 `references/official-plugin-dev-skill.md` §3.1。

#### 12.18.1 机械检查：`FAILED (7 passed, 1 failed, 3 warned)` → `OK (10 passed, 0 failed, 1 warned)`

| 检查 | 修前 | 修后 |
|---|---|---|
| `manifest-engines`（error） | ✗ `engines.node: ">=22"` | ✓ `"^22.19.0 \|\| >=24.0.0"`（同时允许 Node 22 与 24） |
| `display-meta`（warning，硬性交付项） | ! 完全没有展示元数据 | ✓ locale meta + 导出的 icon |
| `manifest-package-manager` | ! 未钉 | ✓ `"pnpm@11.7.0"` |
| `readme-five-langs` | ! | ! **有意保留**，理由见 §12.18.3 |

#### 12.18.2 展示元数据：§3.1 清单逐条

| 清单条目 | 实现 |
|---|---|
| `locale/en.json` 含 `meta.title` / `meta.description` | `locale/en.json`（英文是**必需的 fallback**，检查器会单独校验它） |
| 按用户语言补 `locale/zh.json` 等 | `locale/zh.json` |
| 导出 `"./locale/*.json"` | `exports["./locale/*.json"] = "./locale/*.json"` |
| 导出 `"./icon"` | `exports["./icon"] = "./icon.svg"`（也可在 `package.json` 顶层写 `icon`，我们选子路径导出，与知识库自身一致） |
| 图标格式 SVG/PNG/JPEG/WebP | SVG，自绘 |
| 图标 ≤ 256 KiB | **990 字节** |
| 图标 realpath 必须在包内 | 实文件、非 symlink，realpath 落在包根内（逐项实测） |
| 图标原创或可再分发 + 署名 | 自绘原创，MIT（与包许可一致）；SVG 内注释写明无第三方素材 |
| `files` 含 patch、locale、图标与**每个运行时文件** | `npm pack --dry-run` 实测：`lib/` 16 个文件**全部**进包（磁盘 16 = 包内 16，零遗漏），locale 2 + icon 1 + 清单/文档 7 |

`display-meta` 的另一半是"**文件名合规不等于字节能渲染**"，所以图标不是"放个文件就算"：已实跑 XML 解析（`<svg>` 根元素、`viewBox="0 0 64 64"`、11 个子节点、`<title>` 存在），并且 locale 两个文件都真实解析出 `meta.title` / `meta.description`。

**没有加 `dsh.manifestVersion` / `engines.dsh`**：§7.0.1 把两者列为**可选作者字段**（`engines.dsh` 明说"当前不校验，只作声明"），机械检查不查，而随包分发的知识库自身（一个已发布、可用的插件）也没有写。在无法验证宿主是否严格校验 `dsh` 键的情况下新增未验证的清单字段，风险大于收益。用户侧可见的收益为零，所以不加。

#### 12.18.3 五语 README：判断为"家族惯例、非生态硬性要求"，故不补

**判断依据（三条，都可复核）**：

1. 本检查**自己引用的那一节**（§8，检查器输出里逐行标注 `skill: guide/plugin-dev-guide.md §8`）写的硬性口径是**双语**："文档双语：README/文档有 `.zh.md` 成对"。五语不在 §8 里。
2. `guide/family-toolchain.md` 的 `CC5` 明确把"五语 README"归为**PerryLink 家族三重门**，并且原文写着"**规范明说'这不是生态标准'**"、"非 PerryLink 工作区报 `skip`（`not-applicable`）"。我们不是 PerryLink 工作区。
3. 检查器自己的分级就是**警告级**：缺英文 `README.md` 才是 `severity: error`；缺 es/pt/hi 是 `severity: warning`。

因此本轮**不新增 es/pt/hi**：§8 要求的双语我们已经满足，机器翻译凑数恰好是本任务禁止的做法，而这三份没有任何人会校对的 README 只会变成三份将来必然漂移的假文档。

**但检查器的这条警告对我们的事实描述是错的，值得记一笔**：它报缺 `README-zh.md`，而我们的中文 README 叫 **`README.zh-CN.md`**——检查器用 `README_LANGS = ['README.md','README-zh.md','README-es.md','README-pt.md','README-hi.md']` 按**文件名**匹配，所以"中文版存在"这件事它看不见。生态惯例（知识库自身、harness 仓库、`guide/links.md`）是 `README-zh.md` 这种**连字符**形式。改名的代价是同步 `README.md:870` 与 `README.zh-CN.md:797` 两处文件树示意 + `package.json` 的 `files`，而本轮红线是"不动 README 正文"。**建议下一轮由文档席位一次改到位**（`git mv README.zh-CN.md README-zh.md` + 上述三处引用），改名后这条警告会从"缺 4 个"变成"缺 3 个"，`readme-consistency` 也会从 `skip` 转为真正比对两份 README 的结构一致性。

> **T22 之后（Lead 已完成该改名）**：`README.zh-CN.md` → `README-zh.md` 已落地，`readme-five-langs` 不再误报缺中文版，`readme-consistency` 从 `skip` 转为**真实运行**。它现在报 `README-zh.md is missing headings: <19 个英文标题>`——这是**按字面比较标题文本**造成的假阳性：两份 README 的结构实测完全一致（h2 19=19、h3 19=19、h4 0=0，共 38 个标题），zh 只是把标题翻译了。这条留给文档席位判断：要么接受（它列出的是英文标题、zh 有对应中文标题），要么把 zh 标题改成"中文 + 英文"双语形式以满足字面比较。

### 12.19 T23：client half —— 在「设置 → 模型」卡片里申请 + 填入 API key

用户选定**方案 A**：在**本插件自己那张 provider 卡片内**，为每个 enabled 却拿不到凭据的家渲染「上方申请链接 + 下方 API key 填入框 + 保存」。保存写回 DSH 的凭据 seam，而 seam 明令 **每个操作重新 resolve、从不跨操作缓存**（`docs/subsystems/credentials.md:5`、`:20`）⇒ **保存后下一次请求即生效，无需重启**。

#### 12.19.1 凭据写回的 API（文档原文引用，非推测）

| 事项 | 出处（文件:行） |
|---|---|
| Host 侧服务 `ctx.credentialsController` — `CredentialsController`，"Host service backing the generated `ctx.remote.credentials` namespace" | `references/official-docs/docs/subsystems/credentials.md:229-231` |
| `@Remote async set(ref: string, value: string): Promise<void>` | 同上 `:245-252` |
| `@Remote async describe(refs: string[]): Promise<Record<string, CredentialInfo>>` | 同上 `:234-243` |
| Client 消费方式："declares both `remote` and `remote.<namespace>` in its `inject`, and the call site writes `ctx.remote.<namespace>.<method>(...)`；结果是 `RemoteResult<T>`，用 `if (!result.ok)` 分支" | `references/official-docs/docs/cookbook/adding-a-remote-api.md:109` |
| 官方页面的实际写法（同一份 API，装在本机的构建产物） | `@deepseek-ai/dsh-client-ui-settings-models/lib/client.js:2784-2790`：`const response = await ctx.remote.credentials.set(ref, value); return response.ok ? void 0 : response.error.message` |
| 页面自己声明的注入面 | 同上 `lib/types/client/operations.d.ts`："which declares `remote.credentials`, `remote.llm`, and `remote.settings` in its own `inject`" |

因此本插件写的是 `ctx.remote.credentials.set(apiKeyEnv, 字面值)`，读取用 `describe([apiKeyEnv])`；两者都按 `RemoteResult` 分支，**不写防御性 catch**（文档明说 "a Remote call does not reject"），失败时把 `error.message` 原样显示给用户——**失败不静默**。

`inject` 是**静态数组** `['slots', 'locale', 'remote', 'remote.credentials']`。缺 `remote.credentials` 时插件不激活（而不是渲染一个存不进去的输入框）。

#### 12.19.2 落点：`settings.models.provider-card`

| 事项 | 出处 |
|---|---|
| `'settings.models.provider-card': { kind: 'keyed', scope: 'root', owner: ProviderCardExtrasOwnerProps }`，"dispatched with `entryKey = settingsNs`" | `@deepseek-ai/dsh-client-ui-settings-models/lib/types/client/slot-contract.d.ts:30-34`、`:56-63` |
| owner 三个 props：`provider: ProviderDirectoryEntry`（含 `settingsNs`）、`configured`、`keyConfigured` | 同上 `:56-63` |
| keyed 的登记选项是 `key?: string`（`list` 用 `id`） | `@deepseek-ai/dsh-client-ui-slots/lib/types/index.d.ts:622` |
| 注册形态 `{ name, key, locale, inject }` + `ctx.slots.inject(owner, () => ctx.slots.register(...))` | `references/official-docs/docs/subsystems/slots.md:103`；本机可运行范例 `dsh-peak-hours/lib/client.js:1511-1557` |

本插件的 `settingsNs` 是 `freellmapi`（`lib/config.js:37`），所以按 `key: 'freellmapi'` 注册即渲染进自己那张卡片。**没有**碰 `conversation.input.model`（那是 `single` + `shadows-shipped-ui`，等于替换 DSH 自带选择器）。

#### 12.19.3 浏览器半边的形态

`lib/client.js` 是客户端模块系统要的 **lazy-CJS factory**（`window.__ModuleLoader__.load({ id, factory })`，见 `docs/subsystems/client-modules.md:80`、`:88`），**零构建、零 npm 依赖**：只 `require('react')` 与 `require('react/jsx-runtime')`——这两个是 shell 自带的种子模块（`dsh-peak-hours/lib/client.js:20-29` 是同一写法）。清单侧加了 `exports["./client"]` 与 `dsh.client.platform = 'web'`。

**没有写 `dsh.client.inject`**：它是**包级**排序边，缺失的包名会让这一行永远不 materialize，而"卡片整块不出现"正是本轮最想避免的失败模式；真正需要的前置条件（`slots`/`locale`/`remote.credentials` 服务）由 cordis 层 `inject` 表达，服务缺失时插件保持不激活而不是渲染坏掉的 UI。本机可用的同作者插件 `dsh-peak-hours` 同样只写 `platform: 'web'`。

样式**全部走 `--dsw-*` token** 且写成 inline style（不注入样式表 = 不在组件外写任何东西）；数值逐条镜像宿主自带的 `ui-primitives` 样式表（输入框 `fields.module.css` 的 `.input`、按钮 `Button.module.css` 的 `.button/.sm/.primary`、卡片材质 `docs/ui-radius.md` §Settings card materials 的 `--dsw-radius-xl` + `--dsw-alias-settings-card-*`；本卡片是卡片内的嵌套编辑器，按该文档用 **R16 / `--dsw-radius-lg`**）。不含任何颜色字面量。**没有 iframe、没有 `document.body`、没有第二个应用根**。

#### 12.19.4 客户端那份 provider 表：生成副本 + 反漂移

浏览器读不到 `lib/providers.js`（客户端模块系统只服务 `exports["./client"]`），所以卡片要的 `{ displayName, apiKeyEnv, keyURL, keyless }` 随包带了一份。为了不重演 T17 的 `KEY_ENTRY_POINTS` 漂移：

- 那一份写在 `lib/client.js` 的 `/* @generated:client-setup:start|end */` 标记内，生成器是 `tests/regenerate-client-setup.mjs`（支持 `--check`）；
- `tests/client.test.mjs` 的 `★ the client-side provider table is a faithful copy of the Host pool` 逐字段比对 `lib/providers.js` 的 `providerDeclarations()`，并断言 `apiKeyEnv:` 在文件里出现次数恰等于 provider 数（防止有人另写第二份表）；
- **实跑反证**：只改客户端副本的 `displayName`（不动 `lib/providers.js`）⇒ `--check` 退出码 **1**、`client.test.mjs` 失败 **2** 条且正是那条漂移断言；恢复后 `--check` 退出码 0。

#### 12.19.5 渲染验证（无浏览器）

组件不能靠"代码看起来对"交付：client 组件抛错的表现是**整个 slot 变白**（`guide/unfixed-issues.md` 的 T3 同族）。因此：

1. **无依赖的那条**（永远跑）：用最小 React stub 直接调用组件函数，遍历返回的元素树，断言 3 个 `<a>`（href/target/rel 正确）、3 个 `type="password"` 的 `<input>`、3 个 Save 与 3 个 Show 按钮、链接在文档序里位于输入框**之前**、keyless 家显示"Works without a key"而不是输入框、非本卡返回 `null`、以及 7 组畸形 props 全部不抛。
2. **真 React 的那条**（本机有 React 时跑，否则 `skip` 并说明原因）：用真实 `react-dom/server` 的 `renderToStaticMarkup` 渲染同一棵树并断言产出的 HTML（链接、`type="password"`、env 名、`<button>Save</button>`、`--dsw-alias-` token、无 `<iframe>`），再用中文词典渲染一次断言 `需要 API key` / `保存` 出现。

**这条真渲染当场抓到一个 stub 看不见的缺陷**：`key` 被当成 props 传给了 `jsxs('div', { key: id, ... })`。React 19 对此**只打印警告**（"A props object containing a "key" prop is being spread into JSX"），不是异常——所以任何只看"抛没抛"的验证都会放过它。已改为 `jsxs('div', props, id)`（key 作第三个实参），并在 stub 里加了**违规记录**：`★ no element smuggles key through props` 现在会在有人写回 `props.key` 时直接失败。修完真渲染 stderr **零警告**。

**诚实边界**：以上证明的是"组件返回的树/HTML 含这些元素且不抛"，**不是**像素级布局。真实浏览器渲染、明暗主题、点击保存的端到端链路（Host 收到 `set` 并写盘）**未验证**——需要一趟装了插件的浏览器会话。这一条如实记在这里，不当作已验证。
