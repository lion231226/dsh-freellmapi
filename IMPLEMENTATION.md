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
