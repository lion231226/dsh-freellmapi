# 任务书 P3-E1+E11：阶段 0 前置断言与新会话 freellmapi 路由文档

> 来源：`_lead/优化方案-2026-10-16.md`（P3）、`_lead/ws-gates-method.md`（E1+E11 方案）、acceptance-2026-10-15.md E1/E11 原文。  
> 适用仓库：验收口径文档（`_lead/`），不改动 `dsh-freellmapi/` 源码，不改动 `acceptance-2026-10-15.md`。  
> 执行约束：不改动 `dsh-freellmapi/` 源码；不改动 `acceptance-2026-10-15.md`；不强制给 teammate 独立模型选择器（DSH 核心/宿主行为，E11 归属环境，非插件缺陷）；不把非 freellmapi 路由上的表现（E2/E7/E8）当作插件缺陷证据。

## 目标（可证伪的单句）
验收流程在阶段 2（动态验收）前增加“阶段 0 前置断言”：从会话日志读 `request/context`（或 `request/header`），断言 `provider == freellmapi`；不成立则阶段 2 作废并记 E1，不得把非 freellmapi 路由上的行为当作插件证据；并文档化“如何让一个新会话按 freellmapi 路由运行”（新开会话 → 主模型选择器选 freellmapi 模型 → 委派子代理）。

## 验收标准（先写，后做；每条机械判定）
1. **阶段 0 前置断言**：命令示例（人工/脚本读会话日志），如 `zgrep -a '"type":"request/context"' <session.v4.jsonl.zstd> | tail -n 1`，期望输出包含 `"provider":"freellmapi"`；断言通过才进入阶段 1/2，否则输出 `E1: session not on freellmapi route (provider=<actual>); stage 2 voided` 并停止后续动态验收。
2. **新会话按 freellmapi 路由运行**：新开会话 → 主模型选择器选 freellmapi 提供的模型（如 freellmapi/auto 或钉 groq/kilo/llm7 行）→ 委派 teammate（spawn_teammate）；期望：teammate 的 `request/context.provider` 也为 `freellmapi`（继承父路由，E11 根因），且验收可把子代理行为作为 freellmapi 证据。
3. **反向注入**：若阶段 0 不做前置断言，或验收会话实际 provider 为 `opencode2dsh`（E1 原文）却照常做阶段 2，则 E1/E11 会被误读 ⇒ 标准 1/2 红（把“环境路由问题”误判为“插件缺陷”），证明前置断言必要。

## 方法（文档化验收口径，不动源码、不动 acceptance 文件）
**现状（已复核）**：
- `_lead/acceptance-2026-10-15.md` 阶段 0 表（0.1–0.4）有“任何一项为否 ⇒ 立即停止”，但 E1 记阶段 0 前提“本验收会话自己就跑在被验收插件上”从未成立（实际 `provider=opencode2dsh, model=deepseek-v4.1-flash-free`）；会话日志里 `request/context` 有 provider 字段（E1 证据：`{"type":"request/context",…,"provider":"opencode2dsh",…}`）；`dsh-freellmapi/lib` 检索 `opencode2dsh` 0 命中（opencode2dsh 非插件）。
- E11：`spawn_teammate.provider` 是机制名（spawn/fork）而非 LLM 模型名，teammate 继承父路由（`dsh-tool-subagent/README.zh.md:69`，线号待行号核对），`agentRouteDefaults` 在 asar 内只有类型声明无供给，本 Lead 会话 0 条 `subagent/model-selection-policy` 事件 ⇒ teammate 全继承 Lead 路由，无法钉 freellmapi；文档化补救：新开会话，主模型选择器选 freellmapi 模型，再委派。

**步骤**：
1. 阶段 0 新增 0.0 前置断言：读取当前会话日志（`C:\Users\81521\.dsh\sessions\...\session-<id>\session.v4.jsonl.zstd`）中最近一条 `request/context`（或 `request/header`），断言 `config.provider === 'freellmapi'`；通过才进入阶段 1/2，否则记 E1、作废阶段 2，并转而按“新会话按 freellmapi 路由运行”补救。
2. 补救：新开会话；在主模型选择器选一个 freellmapi 模型；再委派 teammate（spawn_teammate/fork），子代理继承父路由从而在 freellmapi 上运行；随后再做阶段 2，并标注“该会话已通过前置断言”。
3. 把前置断言与补救步骤写进验收口径文档（`_lead/` 下新文或补充说明，不动 `acceptance-2026-10-15.md`）。

## 不做（Out of scope）
- 不改动 `dsh-freellmapi/` 源码。
- 不改动 `acceptance-2026-10-15.md`。
- 不强制给 teammate 独立模型选择器（DSH 核心/宿主行为，E11 归属环境，非插件缺陷）。
- 不把非 freellmapi 路由上的表现（E2/E7/E8 等）当作插件缺陷证据；它们只能作为“该路由上的现场证据”，且必须标注路由归属。

## 已知风险 / 未知项
- 会话日志是 zstd 帧拼接（acceptance 记录附加记录 2），整文件 `zstdDecompressSync` 只得头部（实测 218 字节），需按帧魔数 `28 B5 2F FD` 切帧逐帧解压才能读到 `request/context`；取数时须冻结时刻（日志持续追加，同一文件先后读数不同，如 888 帧 vs 953 帧），否则断言结果不可复现。
- “新开会话 + 主模型选择器选模型”依赖 GUI 操作与签名 cookie（acceptance 记：GUI 需签名 cookie，未认证访问 `/api/*` 全 401），部分步骤无法自动化，需人工执行并记录。
- 即使新会话选 freellmapi，DSH 主进程未重启仍可能持有 stale module（E2/E4 过程级判断），路由/行为可能不反映 HEAD 代码，需在文档里注明“重启后更可靠”。
- 阶段 0 前置断言把很多历史验收（本次含）的阶段 2 降级为“驱动 adapter，非本会话自举”，验收结论需逐条标注降级，不能统一声称“在真实会话中验证”。

---
name: p3-e1-e11-stage-0-preflight
status: pending
owner: unowned
write_scopes: ["_lead/验收口径补充说明.md"]
blocked_by: []
