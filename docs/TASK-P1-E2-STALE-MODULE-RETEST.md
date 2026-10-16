# 任务书 P1-E2：E2 压缩失败群 stale-module 假说复测（决定是否为当前 HEAD 真缺陷）

> 来源：`_lead/优化方案-2026-10-16.md`（P1）、`_lead/ws-evidence.md`（E2 六条错误族溯源与 stale-module 判断）、acceptance-2026-10-15.md §2.5 与 E2 原文。  
> 适用仓库：`dsh-freellmapi`，HEAD `ee4865b7e6a0350dd15b9dc5ed69fc6a6ca21172`（v0.7.17）。  
> 执行约束：**本任务不改动任何源码**，只做独立复测与报告；不把 DSH 核心/上游错误族当作插件缺陷；不把未控制变量的现场证据升格为因果结论。

## 目标（可证伪的单句）
在新开会话（DSH 加载当前 HEAD 模块）走 freellmapi 路由做等长压缩，统计 E2 六条错误族命中率，与对照组比较；若 Fisher 右尾 P > 0.05 且显著低于 E2 窗口 20/22（9.1%），证伪 stale-module 主因，E2 降级为“过程级待复测”，不再为其新增代码。

## 验收标准（先写，后做；每条机械判定）
1. 组 A（freellmapi/auto，新会话）与组 B（非 freellmapi 对照，如 opencode2dsh/deepseek-v4.1-flash-free）的六条错误族命中率 Fisher 右尾 P > 0.05。
2. 组 A 六条错误族命中率显著低于 E2 窗口的 20/22（9.1%）。
3. 统计截止时刻须显式冻结（ISO 8601 +08:00），因为会话日志持续追加（同一文件先后读数不同，如 888 帧 vs 953 帧）。
4. 输出复测报告，包含：组 A / 组 B 各自 compaction 尝试数、成功数、失败数、六条错误族各命中数、Fisher 右尾 P 值、冻结时刻、实际使用的路由方式（驱动 adapter `purpose:'compaction'` 还是主模型选择器 freellmapi/auto，并标注“驱动 adapter 不等于本会话自举”）。

## 方法（实验设计）
- **会话条件**：新开会话（使 DSH 有机会加载当前 HEAD 模块；注意：若 DSH 主进程未重启，仍可能持有 stale module，这一点本身即是待观察变量）。会话主路由必须为 `freellmapi/auto`，并在会话内产生足够长的上下文以触发多次 `purpose: 'compaction'`。
- **对照组（组 B）**：同一新开会话（或另一新开会话），走非 freellmapi 路由，发等价长会话压缩请求。
- **请求命令**：优先用真实会话路由（主模型选择器选 `freellmapi/auto`，连续发送足够长的对话直到 DSH 触发压缩）；或驱动 adapter 直接调 `mounted.adapter.stream({ provider:'freellmapi', model:'auto', purpose:'compaction', messages:<长历史> })`。两种方式均可，但需注明实际使用的是哪种。
- **持续时间**：建议持续到触发 **≥10 次 `compaction/start`** 或时间窗 **≥30 分钟**，以与 E2 窗口（23:09–23:26，约 17 分钟，12 次 start）量级可比。
- **统计指标**：六条错误族的命中数与命中率（命中数 / compaction 尝试数）；同时记录 `compaction/start` 与 `compaction/end` 配对（id 一致）、起始时刻路由（归属口径同验收记录 §2.5）。

## 不做（Out of scope）
- 在复测前不为 E2 新增任何代码。
- 不把 `summarization produced no text summary content`、`summary is not smaller than the shadowed content`（DSH 核心/上游）、`the request exceeds the context window of the model`（跨路由出现/上游 413）、NVIDIA 503（上游）当作插件缺陷。
- 不把 E2 的强相关现场证据升格为因果结论。

## 已知风险 / 未知项
- 若 DSH 主进程未重启，新会话仍可能加载 stale module，这正是假说要检验的内容；复测结论需标注“是否在重启后进行”。
- 不同会话、不同任务存在混杂，单次复测不足以完全排除；必要时多次运行或标注“单次测量”。

---
name: p1-e2-stale-module-retest
status: pending
owner: unowned
write_scopes: []
blocked_by: []
