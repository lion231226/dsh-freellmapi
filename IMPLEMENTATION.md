# dsh-freellmapi — 技术实现说明（IMPLEMENTATION）

> 本文是 **T3（实现）** 的交付说明，同时作为用户 README 的**技术实现章节草稿**。
> 契约依据：`docs/SPEC.md`（DSH 适配器开发契约）与 `research/freellmapi-protocol.md`（上游协议）。
> 版本基线：DSH `0.2.0-rc.2`、`@deepseek-ai/cordis` `4.0.4`、freellmapi `server` 协议面（v0.13.x）。

---

## 1. 交付物与形态

| 文件 | 作用 |
|---|---|
| `package.json` | 包元数据（**零 `dependencies`**，唯一 peer 是可选的 `@deepseek-ai/cordis`） |
| `cordis.patch.yml` | bundle 补丁：`- insert: [{ id: freellmapi, name: 'dsh-freellmapi' }]` |
| `lib/index.js` | 插件入口：导出 `name` / `inject` / `Config` / `apply`，并新增导出 `getRecentRoutes()` / `formatRouteLine()` / `configSchemaKind` |
| `lib/runtime.js` | 对 `@deepseek-ai/dsh-llm` 的**运行时桥接 + 完整降级垫片** |
| `lib/config.js` | `Config` 导出（schemastery 优先，普通 Standard Schema 兜底）+ 全防御 `normalizeConfig()` |
| `lib/sse.js` | 增量 SSE 解码器（纯函数状态机） |
| `lib/frames.js` | SSE payload → 帧分类（纯函数） |
| `lib/translate.js` | 帧 → `StreamChunk` 状态机（纯函数） |
| `lib/wire.js` | `GenerateOptions` → OpenAI wire 映射（纯函数） |
| `lib/errors.js` | HTTP/传输失败分类与**人话诊断** |
| `lib/catalog.js` | 静态虚拟路由 + `GET /v1/models` 发现与缓存 |
| `lib/routes.js` | `X-Routed-Via` 可观测性：日志渲染 + 50 条环形缓冲 |
| `lib/types.js` | 纯 JSDoc 类型词汇（无运行时代码） |
| `tests/**/*.test.mjs` | 144 条离线测试（`node:test`，内置 `node:http` mock 网关，端口 0） |

**无构建步骤**：`main`/`exports["."]` 直接指向 `lib/index.js`，DSH 用 `import()` 加载源码本身。

```bash
npm test        # 144 tests, 0 fail; 不需要网关、不需要网络、不需要 API key
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
| 3 | §5.2 把 `LLM:lib/types/assistant-stream.js` 当作 **adapter 输出的校验点** | adapter 输出**没有**运行时校验：`adapterStream`（`LLM:lib/index.js:2328-2348`）只 `yield item.value`；`safeIndex`/类型检查发生在 `AssistantStreamAccumulator.push`（**记录**时）。不合法的 chunk 既不会被 `adapterStream` 拒绝，也不会在流上被报错 | 因此本插件自建了独立校验器（`tests/helpers/harness.mjs`），把 `index` 单调、start/end 配对、`block-end` 字节一致、`usage` 先于 `finish`、`finish` 唯一且最后等规则**硬断言**在 144 条测试里 |
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
```
$ cd dsh-freellmapi && npm test
ℹ tests 144
ℹ pass 144
ℹ fail 0
```
- **模式 A（真品绑定）**：临时建 junction `dsh-freellmapi/node_modules -> %USERPROFILE%\.dsh\profiles\node_modules` 后：
  `llmRuntimeAvailable = true`、`LlmAdapter.name = "LlmAdapter"`、`attributionHeaders() = {"user-agent":"deepseek-harness/0.2.0-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)"}`、`configSchemaKind = schemastery`（设置页 schema 可重建：16 个字段全 volatile、全带 description 与 default）→ **144 pass**。
- **模式 B（裸检出垫片）**：删掉 junction 后 **144 pass**。
- 证明：同一套代码在"有真运行时"和"什么都没有"两种环境下行为一致。（验证用的 junction 已删除，不是交付物的一部分。）

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
7. **`maxTokensField` 默认与 README 不一致**（README 第 320 行写 `max_completion_tokens`）——**已在本文件 §7 与收口报告里标注，需 T4 更正**。
8. **日志行文案与 Lead 示例措辞略有差异**：采用 README 已有文案 `dsh-freellmapi: routed via <via> (model=<model>)`（Lead 示例写的是 `(requested model: <model>)`）。选 README 版本是为了让已交付的用户文档逐字为真；如需改回只需改 `lib/routes.js::formatRouteLine()` 一处。
