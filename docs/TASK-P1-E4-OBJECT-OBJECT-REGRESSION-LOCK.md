# 任务书 P1-E4：`[object Object]` 回归锁——所有未知值进 message 的路径必须走 `describeUnknown`

> 来源：`_lead/优化方案-2026-10-16.md`（P1）、`_lead/ws-defects.md`（E4 方案）、acceptance-2026-10-15.md E4 原文、`dccaeaa`（v0.7.3）补丁提交信息。  
> 适用仓库：`dsh-freellmapi`，HEAD `ee4865b7e6a0350dd15b9dc5ed69fc6a6ca21172`（v0.7.17）。  
> 执行约束：只改 `lib/dispatch.js:148–159`、`lib/index.js:1262–1281`、`lib/errors.js:301–315` 与新增守卫测试；不改动 acceptance 文件；不重构已通过补丁的 `lib/errors.js` `describeUnknown` 本身（除非审计发现其内部仍有遗漏路径）。

## 目标（可证伪的单句）
任何由 `failureOf()`、`describeTransportFailure()`、`describeUnknown()` 生成的失败消息，绝不能出现字面 `[object Object]`，也不能返回空串；所有将未知值塞入 message 的路径必须经 `describeUnknown` 处理。

## 验收标准（先写，后做；每条机械判定）
1. 新增守卫测试：分别向 `describeUnknown`、`describeTransportFailure`、`failureOf`（两处实现 `lib/dispatch.js:148–159` 与 `lib/index.js:1262–1281`）传入 object / Error / 非字符串值，返回的 message 必须**不匹配** `/\[object Object]/` 且 `length > 0`。
2. `lib/dispatch.js:148–159` 的 `failureOf` 中当前存在的裸路径 `String(record.message)`（第 153 行）与 `String(error)`（第 156 行）必须改为走 `describeUnknown`（与 `lib/errors.js` 中已补丁的 `describeUnknown` 对齐），兜底使用 `'failure with no message'` / `'unknown failure'`。
3. 在副本上运行 `tests/failure-message.test.mjs` 与新增守卫测试，全部**报绿**。
4. 反向注入：把 `lib/dispatch.js` 的 `failureOf` 改回裸 `String(error)` / `String(record.message)`，守卫测试在临时副本上必须**报红**（出现 `[object Object]` 或空串）。
5. 注入前与恢复后，受改动文件（`lib/dispatch.js`、`lib/index.js`、`lib/errors.js`、新增测试文件）的 sha256 必须一致。

## 方法（到文件:行）
**第一步——写守卫测试**：新增/追加到 `tests/failure-message.test.mjs`，断言 object/Error/非字符串输入下 `describeUnknown`、`describeTransportFailure`、`failureOf` 绝不返回 `[object Object]` 且不返回空串；覆盖 `Error` 实例的 `message` 为非字符串（如 object）的边界，以及 `cause` 链。

**第二步——改代码**：
- `lib/dispatch.js` `failureOf`：将 `String(record.message)` 和 `String(error)` 替换为 `describeUnknown(...)`。
- 审计 `lib/index.js` `failureOf`（line 1262–1281）与 `lib/errors.js` `describeTransportFailure`（line 301–315），确认所有将未知值塞入 message 的分支均经 `describeUnknown`，无直传 `String(unknown)` 的残余路径。

**第三步——反向注入**：在临时副本上把 `lib/dispatch.js` 的 `failureOf` 改回裸 `String(record.message)` / `String(error)`（即重现 E4 原始路径）；运行新增守卫测试确认报红；恢复后校验 sha256 与注入前完全一致。**禁止在共享工作区对共享文件做反向注入。**

## 不做（Out of scope）
- 不改动 acceptance 文件。
- 不重构已通过补丁的 `lib/errors.js` `describeUnknown` 本身，除非审计发现其内部仍有遗漏路径。
- 不改动 `describeHttpFailure` 的 HTTP-body 解析逻辑（该路径由 `detailText` / `upstreamMessage` 已做字符串提取，不在本 E4 范围）。

## 已知风险 / 未知项
- 运行中 DSH 进程可能持有 stale module（旧 `failureOf` 实现仍被加载）；反向注入与守卫测试必须在当前源码副本上运行，而非依赖已构建/缓存的模块。
- `dispatch.js` 与 `index.js` 存在两份独立的 `failureOf` 实现，必须一并审计，遗漏任一份都会留下 `[object Object]` 泄漏路径。

---
name: p1-e4-object-object-regression-lock
status: pending
owner: unowned
write_scopes: ["dsh-freellmapi/lib/dispatch.js", "dsh-freellmapi/lib/index.js", "dsh-freellmapi/lib/errors.js", "dsh-freellmapi/tests/failure-message.test.mjs"]
blocked_by: []
