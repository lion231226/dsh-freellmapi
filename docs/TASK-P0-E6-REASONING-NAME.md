# 任务书 P0-E6：reasoning declaration 缺少 `name` 字段

> 来源：`_lead/优化方案-2026-10-16.md`（P0 唯一代码级已证实缺陷）、`_lead/ws-defects.md`。  
> 适用仓库：`dsh-freellmapi`，HEAD `ee4865b7e6a0350dd15b9dc5ed69fc6a6ca21172`（v0.7.17），全量测试 468/468 全绿。  
> 执行约束：只改 `lib/index.js:503–505` 与 `tests/reasoning-declaration.test.mjs`；不改动 DSH 侧 validator；不改动 `forwardReasoningEffort` 默认值（保持 false）；不改动 acceptance 文件。

## 目标（可证伪的单句）
在 `forwardReasoningEffort: true` 且钉住 groq 等可测模型时，DSH 声明注入的每个 reasoning effort 条目必须携带非空 `name` 字符串，使 `typeof effort.name === 'string' && effort.name.length > 0` 校验通过，不再抛 `INVALID_MODEL_REASONING: adapter returned invalid or duplicate reasoning effort metadata`。

## 验收标准（先写，后做；每条机械判定）
1. 在仓库副本上运行 `node --test tests/reasoning-declaration.test.mjs`，文件中新增的断言（`forward=true` 时，`declared.efforts` 的每个条目必须满足 `typeof entry.name === 'string' && entry.name.length > 0`）必须**报绿**。
2. 反向注入（见下文）后，同一命令在临时副本上必须**报红**，证明守卫真能捕捉缺陷。
3. 注入前与恢复后，`lib/index.js` 及 `tests/reasoning-declaration.test.mjs` 的 sha256 必须一致。

## 方法（到文件:行，先写测试，后改代码）
**第一步——写守卫测试（先红，再绿）**：在 `tests/reasoning-declaration.test.mjs` 的 `forward=true` 分支新增 `name` 存在性断言。现行第 63 行 `deepEqual(declared?.efforts, MEASURED_EFFORTS.map((id) => ({ id })))` 已固化 `{ id }` 缺陷形状，不改测试守卫永远不可红。

**第二步——改代码**：把 `lib/index.js:503–505` 的
```js
...config.forwardReasoningEffort === true && Array.isArray(entry?.reasoning) && entry.reasoning.length > 0
  ? { reasoning: { efforts: entry.reasoning.map((id) => ({ id })) } }
  : {},
```
的 `{ id }` 改为 `{ id, name: id }`（或按 DSH 期望的可读名称映射，需先与 `dsh-llm/lib/types/index.js:649–665` 预期确认，避免返回 "duplicate" 或 "invalid"）。

**第三步——反向注入**：在临时副本 / 临时 worktree 上把 `lib/index.js:504` 改回 `{ id }` 并把测试中新增的 `name` 断言注释掉或还原为只断言 `{ id }`；记录注入前 sha256，运行测试确认报红；恢复后校验 sha256 与注入前完全一致。**禁止在共享工作区对共享文件做反向注入。**

## 不做（Out of scope）
- 不改动 DSH 侧 validator（`dsh-llm/lib/types/index.js`），不跨仓库修改。
- 不引入 `defaultEffort`；不改动 `auto` 路由或未测量模型的声明逻辑。
- 不改动 acceptance 文件；不改动 `forwardReasoningEffort` 默认值。

## 已知风险 / 未知项
- `name` 的取值语义（与 `id` 相同，还是需人类可读映射）需与 DSH 侧 validator 预期再确认，避免又返回 "duplicate" 或 "invalid"。
- 现行测试固化了 `{ id }` 形状；若执行会话只改源码不改测试，守卫永远不可红，需同步提交测试变更。

---
name: p0-e6-reasoning-name
status: pending
owner: unowned
write_scopes: ["dsh-freellmapi/lib/index.js", "dsh-freellmapi/tests/reasoning-declaration.test.mjs"]
blocked_by: []
