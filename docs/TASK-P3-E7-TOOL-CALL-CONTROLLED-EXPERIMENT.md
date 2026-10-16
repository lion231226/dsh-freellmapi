# 任务书 P3-E7：工具调用畸形受控对照实验（依赖 P3-E1/E11 前置断言）

> 来源：`_lead/优化方案-2026-10-16.md`（P3）、acceptance-2026-10-15.md E7 原文、`_lead/ws-evidence.md`（E7 强相关非因果判断）。  
> 适用仓库：验收口径文档（`_lead/`），不改动 `dsh-freellmapi/` 源码，不改动 `acceptance-2026-10-15.md`。  
> 执行约束：在前置断言落地前不断言插件导致 E7；不把未控制变量的现场证据升格为因果结论；不把 E7 的强相关现场证据（Fisher ≈1.4e-9）当作插件缺陷证据。

## 目标（可证伪的单句）
在受 P3-E1/E11 前置断言约束的新会话对照中，判定 freellmapi 路由上的工具调用畸形是“弱模型生成质量”还是“工具契约未被正确注入”。同一任务、同一提示，新会话 A（按 freellmapi 路由）与新会话 B（非 freellmapi 对照）的工具调用畸形率差异具有统计显著性，且错误特征串可归因到具体 route（哪家、第几步）。

## 验收标准（先写，后做；每条机械判定）
1. 新会话 A（freellmapi 路由，通过 P3-E1/E11 前置断言确认 `provider == freellmapi`）与新会话 B（非 freellmapi 对照）执行等价工具调用任务，记录各自工具调用总数与畸形数（如 `unknown tool "read"`、`Identifier cannot follow number`、`require is not defined`、`a Team member cannot message itself`、`active teammate "dsh-freellmapi" not found`）。
2. 两组畸形率差异的 Fisher 精确检验右尾 P 值须写入报告；若 P ≤ 0.05 且 A 组显著高于 B 组，且错误特征串全落在 freellmapi 段，则可作为“该路由上的现场证据”记录，**仍不得断言插件导致**（未独立控制变量）。
3. 报告须标注：路由切换未独立控制（会话中途切换，非随机化）、两组叠加了“不同会话、不同任务”的混杂，故只报“强相关现场证据 + Fisher 精确 P 值”，不报因果结论。

## 方法（验收口径，不动源码）
- **会话条件**：新开会话 A，按 P3-E1/E11 步骤让 DSH 主路由为 freellmapi（主模型选择器选 freellmapi/auto 或钉 groq/kilo/llm7，再委派 teammate）；新开会话 B 走非 freellmapi 路由。
- **任务**：同一任务、同一提示，触发工具调用（如调用 `run_code` 读文件、写文件等），记录 `tool/result` 逐条 `isError` 与错误特征串。
- **统计口径**：按路由分层统计（切换时刻切段）；冻结统计时刻（ISO 8601 +08:00），因为会话日志持续追加。

## 不做（Out of scope）
- 在前置断言落地前不断言插件导致 E7。
- 不把未控制变量的现场证据升格为因果结论。
- 不把 E7 的强相关现场证据当作插件缺陷证据。

## 已知风险 / 未知项
- 路由切换未独立控制，无法独立控制变量（验收记录已标注）。
- “新开会话 + 主模型选择器选模型”依赖 GUI 操作与签名 cookie，部分步骤无法自动化，需人工执行并记录。

---
name: p3-e7-tool-call-aberrant-controlled-experiment
status: pending
owner: unowned
write_scopes: ["_lead/验收口径补充说明.md"]
blocked_by: ["p3-e1-e11-stage-0-preflight"]
