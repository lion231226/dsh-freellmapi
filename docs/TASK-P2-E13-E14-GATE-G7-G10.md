# 任务书 P2-E13+E14：gate 判据——G7 HTTP TypeError 不计 reachable；G10 带凭据在线覆盖 + 无凭据时报覆盖空洞 + fixture 离线复核

> 来源：`_lead/优化方案-2026-10-16.md`（P2）、`_lead/ws-gates-method.md`（E13+E14 方案）、acceptance-2026-10-15.md E13/E14 原文、`tools/gate.mjs:239–247`、`tools/gate.mjs:306–334`。  
> 适用仓库：`dsh-freellmapi`，HEAD `ee4865b7e6a0350dd15b9dc5ed69fc6a6ca21172`（v0.7.17）。  
> 执行约束：G7 不得改为阻断门（G7 是信息性）；不把 key-required provider 的 HTTP 401 当成 dead id（401 ≠ “该 id 不存在”）；不把 `unchecked anonymously` 读成“全部验证”；不在无凭据环境下强制在线覆盖；不把 G10 的覆盖空洞在无凭据时做成阻断；不改动 acceptance 文件。

## 目标（可证伪的单句）
G7 只在主机有 HTTP 应答时才记 `reachable`；传输层失败（HTTP TypeError、无状态码）必须记 `UNREACHABLE`；同一次运行内，同一 provider 不得出现“G7 说 reachable、G10 说 HTTP TypeError”的不一致。G10 作为阻断门，对默认启用的 5 家（groq/cerebras/openrouter/kilo/llm7，`lib/providers.js:104`），带真实凭据时在线覆盖每个声明 model id 是否被上游 `GET /models` serving；无凭据时明确报告“覆盖空洞：哪些默认启用 provider 未被 id 级校验”，不得把绿读成“5 家全部被验证”；并能离线复核（沿用 G9 已提交字节 fixture 纪律）。

## 验收标准（先写，后做；每条机械判定）
**E13**：
1. 离线单元：对 `verdictOf` 传入 `{error:'TypeError', status:null}`（或 `anonymous`），期望返回 `'UNREACHABLE'`；传入 `{status:401}`，期望返回 `'reachable'`；传入 `{status:200}`，期望返回 `'reachable'`。
2. 在线：`node tools/gate.mjs --online`；G7 行中任何 `status:null` 的探测记为 `UNREACHABLE`；若同一 provider 在 G7 与 G10 的两次探测结果不一致（如 G7 reachable、G10 TypeError），输出必须显式标注“两次探测结果不一致，以 transport error 为准”，不得静默混淆。
3. 反向注入：把 `verdictOf` 改回把 `error !== undefined` 的行也按某种 status 判为 reachable，或 G7/G10 再次独立探测不共享结果，则标准 1/2 红。

**E14**：
1. 在线（有凭据）：`node tools/gate.mjs --online`；G10 行列出 `0 enabled with dead ids`，并额外列出 `coverage gaps: groq (no credential → not id-checked), cerebras (no credential → not id-checked), …`；key-required 的默认启用 provider 明确标记 `unchecked — no credential`，不将其计入 `checked` 数；若有凭据且发现缺失 id，则 `liveDead` 非空 ⇒ G10 红。
2. 在线（无凭据，本环境）：输出口径更明确，如 `5 default-enabled providers not id-checked (no credential): groq, cerebras, openrouter, …` —— 不 id-checked 的名单必须显式包含默认启用的 groq/cerebras，且不与“已检查”混淆。
3. 离线：对已提交的 catalogue fixture 取 sha256 复核，断言每个默认启用 provider 的每个声明 model id 在 fixture model 列表中；缺失 id ⇒ fail（阻断）。fixture 带 `at`（ISO 8601 +08:00）、`method`、`bodySha256`。
4. 反向注入：把“无凭据未检查”的默认启用 provider 算作“已校验”，或去掉覆盖空洞名单，则标准 2 红。

## 方法（file:line / 流程步骤）
**现状（已复核）**：
- `tools/gate.mjs:227–236` `probe`：传输层失败时返回 `{provider, status: null, method, error: error.name}`。
- `tools/gate.mjs:239–247` `verdictOf`：line 240 `if (row.error !== undefined) return 'UNREACHABLE'`（已对 error 返回 UNREACHABLE，但 G7/G10 各自独立探测一次，line 249–263 与 line 269–283 分别调用 `probe`，同一 provider 两次网络结果可能不同）。
- `tools/gate.mjs:279` G10 内 `const result = await probe(...)`，`result.status !== 200` 即标记 `checked: false`，未区分“HTTP 401（有应答，不可证明 id 缺失）”与“HTTP TypeError（无应答，传输层失败）”。
- `tools/gate.mjs:306–334` G10：`record('G10', ...)` 只输出 `checked`/`unchecked anonymously` 计数与名单，未把“默认启用 + 未检查”显式标为覆盖空洞。

**步骤**：
1. 保持 `verdictOf` line 240 对 `error` 的 `UNREACHABLE` 判定，并让 G7 的记录行把探测方法与错误名一并写出（`probe` 已返回 `method` 与 `error`），供人类按规则 3（探测方法是断言的一部分）判断 401 与 TypeError 的区别。
2. G7 与 G10 共享同一次探测结果，或 G10 在 `result.status !== 200` 时，若 `result.error` 存在，明确标注 `unchecked — transport error (<error name>)`，与 `unchecked — HTTP 401` 分开，避免把“不能连上”和“需要凭据”混为一谈。
3. G7 记录末尾追加不一致说明：若同一 provider 在 G7 与 G10 的 verdict 分别为 `reachable` 与 transport-error/`unchecked`，输出一条提示，避免把绿读成“该 provider 被双方都证实”。
4. G10 判据改为：对 `enabled === true` 的 provider，若匿名目录不可读（401/TypeError/no model list），标记 `coverage gap` 并显式列出 provider 名，不计入 `checked`；若有真实凭据，在线逐 id 校验，缺失 id ⇒ `liveDead` ⇒ 阻断（line 322–325 的 `assert` 保持）。
5. 在 `record('G10', ...)` 的信息性文本里追加覆盖空洞说明，如 `; <k> default-enabled provider(s) not id-checked (no credential): <names>`。
6. 离线复测：按 G9 纪律，把各 provider 的匿名 catalogue 响应字节作为 fixture 提交仓库（`tests/fixtures/`），编写/复用测试（`tests/free-model-guard.test.mjs` 先例）对 fixture 做 sha256 与 model-id 集合断言，并设 `FREE_VERIFIED_BLOCK_DAYS` 类时效阈值（stale 即 red，re-measure 而非 widen window）。
7. fixture 元数据：`at`、`method`（匿名 GET /models）、`bodySha256`、`served ids` 列表。

## 不做（Out of scope）
- 不把 G7 改为阻断门（`PROJECT-RULES.md` §1：G7 是信息性，provider 在本线路上不可达不是插件缺陷，硬失败会在高铁/受限网络上红）。
- 不把 key-required provider 的 HTTP 401 当成 dead id（401 ≠ “该 id 不存在”）。
- 不把 `unchecked anonymously` 读成“该 provider 的 id 都被验证过”。
- 不改动 `lib/providers.js`、`dsh-freellmapi/` 任何源码、`acceptance-2026-10-15.md`。
- 不在无凭据环境下强制在线覆盖（会因 401 产出假阳性）。
- 不把 G10 的覆盖空洞做成阻断（无凭据时保持信息性，阻断只针对“带凭据后发现的 dead id”）。

## 已知风险 / 未知项
- G7 与 G10 即使共享探测，单次运行仍可能因网络抖动出不同结果（如第一次 401、第二次 TypeError），单次运行不足以判定缺陷，需多次运行或标注“单次测量”。
- 不可达可能由本地代理/防火墙/ DNS（如 asar 内 fake-IP `198.18.0.0/15`，`PROJECT-RULES.md` L14）造成，非上游问题，人类判断不可省。
- 带凭据的在线覆盖需要 GROQ_API_KEY/CEREBRAS_API_KEY 等真实凭据，验收环境可能没有，属环境限制，方案只能保证“无凭据时报覆盖空洞”这一条可机械判定。
- 上游 catalogue 实时漂移（acceptance 记录附加观察：14 分钟内 462→461），fixture 有时效性，必须标注采集时刻并配 block days，跨时间点比对须写明时刻。
- 仅离线 fixture 只能证明“已提交字节与声明一致”，不能证明“上游现在还在服务”，必须与在线 G10 互补，且不能把绿读成能力保证。

---
name: p2-e13-e14-gate-g7-g10
status: pending
owner: unowned
write_scopes: ["dsh-freellmapi/tools/gate.mjs", "dsh-freellmapi/tests/free-model-guard.test.mjs", "dsh-freellmapi/tests/fixtures"]
blocked_by: []
