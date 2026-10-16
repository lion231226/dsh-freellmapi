# 任务书 P1-E3：direct 模式 401 AUTH 缺少 provider/baseURL 归因，且误用“网关”语义

> 来源：`_lead/优化方案-2026-10-16.md`（P1）、`_lead/ws-defects.md`（E3 方案）、acceptance-2026-10-15.md E3 原文。  
> 适用仓库：`dsh-freellmapi`，HEAD `ee4865b7e6a0350dd15b9dc5ed69fc6a6ca21172`（v0.7.17）。  
> 执行约束：只改 `lib/errors.js:178–183`（`describeHttpFailure` 的 `case 'AUTH'`）与新增/扩展守卫测试；不改动 acceptance 文件；不给 AUTH 分支加入“网关”语义引导。

## 目标（可证伪的单句）
direct 模式下 HTTP 401 走 AUTH 分支时，用户可见消息必须携带导致失败的 `provider` 与 `baseURL` 归因，且不得再出现“网关”（gateway）字样（direct 模式下不存在网关概念）。

## 验收标准（先写，后做；每条机械判定）
1. `lib/errors.js:178–183` 的 AUTH 分支生成的消息中，必须包含 `provider="<实际 provider>"`（provider 为 undefined 时的兜底表述）与 `baseURL="<实际 baseURL>"`（为空时的兜底表述），且不包含子串 `"the gateway"` / `"gateway"`。
2. 覆盖 AUTH 分支的守卫测试（如 `tests/failure-message.test.mjs` 或新增针对 401/direct 的测试）在副本上必须**报绿**。
3. 反向注入后，同一守卫测试在临时副本上必须**报红**（消息重现“the gateway rejected the credential”且缺少 provider/baseURL 归因）。
4. 注入前与恢复后，`lib/errors.js` 的 sha256 必须一致。

## 方法（到文件:行）
**第一步——写守卫测试**：在 `tests/failure-message.test.mjs` 中新增针对 `describeHttpFailure` AUTH 分支的测试：构造 `status: 401`、`provider: 'groq'`、`baseURL: 'https://api.groq.com/openai/v1'` 的输入，断言返回消息包含 provider 与 baseURL 归因，且不包含 "the gateway"。

**第二步——改代码**：把 `lib/errors.js:178–183` 的
```js
case 'AUTH':
  parts.push(input.sentApiKey
    ? `the gateway rejected the credential (HTTP ${input.status})`
    : `no credential was configured, so the request was sent without an Authorization header (HTTP ${input.status})`)
  parts.push('set the credential reference named by `apiKeyEnv` (default FREELLMAPI_API_KEY) to the gateway\'s unified `freellmapi-…` key')
  break
```
改为加入 provider 与 baseURL 归因，例如 `provider "${input.provider ?? '<unknown>'}" at ${input.baseURL ?? '<unknown>'}`，并去掉“the gateway”语义，改为面向 direct 模式的凭证配置指引（`apiKeyEnv` / FREELLMAPI_API_KEY）。

**第三步——反向注入**：在临时副本上把 AUTH 分支改回原文（含 "the gateway rejected the credential"，不含 provider/baseURL）；运行守卫测试确认报红；恢复后校验 sha256 与注入前完全一致。**禁止在共享工作区对共享文件做反向注入。**

## 不做（Out of scope）
- 不给 AUTH 分支加入“网关”语义引导；不改成 gateway 运维建议。
- 不改动 QUOTA / RATE_LIMIT / SERVER / UNSUPPORTED_CONTENT / MODEL_UNAVAILABLE 等其他分支。
- 不改动 acceptance 文件。

## 已知风险 / 未知项
- direct 模式下 `input.provider` 可能为 `undefined`，`input.baseURL` 也可能为空，需在消息中做兜底表述，避免 `undefined` 字面泄漏到用户可见文本。
- 与 `describeHttpFailure` 消息模板（`dsh-freellmapi: ... [model=... status=...]`）的拼接需保持既有格式，不得破坏 `failure-message.test.mjs` 的既有断言。

---
name: p1-e3-direct-401-attribution
status: pending
owner: unowned
write_scopes: ["dsh-freellmapi/lib/errors.js", "dsh-freellmapi/tests/failure-message.test.mjs"]
blocked_by: []
