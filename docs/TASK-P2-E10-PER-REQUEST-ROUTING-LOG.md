# 任务书 P2-E10：per-request 路由日志（默认开启、有界、可轮转，或文档化打开与定位）

> 来源：`_lead/优化方案-2026-10-16.md`（P2）、`_lead/ws-gates-method.md`（E10 方案）、acceptance-2026-10-15.md E10 原文。  
> 适用仓库：`dsh-freellmapi`，HEAD `ee4865b7e6a0350dd15b9dc5ed69fc6a6ca21172`（v0.7.17）。  
> 执行约束：本任务只产出方案与守卫测试框架，源码改动留待执行会话按 §P/D 纪律另行完成；不改动 acceptance 文件；不把 per-request 日志落盘做成阻塞写或阻断门；不记录 prompt/reply/reason 等文本内容；不把默认关闭改为默认开启的代码实现（退路保留“文档化如何在当前会话打开”）。

## 目标（可证伪的单句）
验收会话若在 freellmapi 路由上运行，每条路由决策都有一条可被该会话自查的 per-request 日志行，行内包含 tier、胜出的 provider/model（“哪家赢了”）与试了几家（candidateCount）；日志落盘到持久位置，有界且可轮转；≤ 5 步定位到日志文件。

## 验收标准（先写，后做；每条机械判定）
1. **per-request 行产出**：打开插件遥测后，在 freellmapi 路由上发起一次请求；读取持久日志文件，期望输出出现形如 `dsh-freellmapi: tier=simple -> llm7/DeepSeek-V4-Flash-0731 (capability=4, speed=4, 1 candidates tried)` 或 `dsh-freellmapi: tier=medium -> no candidate (0 candidates tried)` 的行，且行中的 `provider/model` 与请求实际胜出者一致、`candidateCount`（candidates tried）等于实际尝试的候选数。
2. **日志有界可轮转**：单个日志文件超过阈值（如 2 MB）或按 UTC 日期滚动，保留最近 N 个文件（如 10），旧文件按 mtime 清理；验收会话执行 `ls -t <持久目录>/routes-*.log | head -n 1` 能得到一个非空文件。
3. **可定位**：验收会话按文档给出的步骤（Settings → 技能 → dsh-freellmapi 配置卡片 → 展开 → 开启路由遥测，或直接定位 `~/.dsh/storages/dsh-freellmapi/`）在 ≤ 5 步内找到日志文件，并能 `grep 'dsh-freellmapi:'` 看到 per-request 行。
4. **反向注入（证明标准能红）**：若把遥测开关关回默认关闭，或把 per-request 写入改回“只写聚合摘要不落 per-request 行”（现状），则标准 1 的 per-request 行不再产出 ⇒ 标准红。

## 方法（file:line / 流程步骤）
**现状（已复核）**：
- `lib/routes.js:142–153` `formatDirectRouteLine` 已有 per-request 格式化器，产出 `dsh-freellmapi: tier=... -> provider/model (N candidates tried)`；`lib/routes.js:97–115` `recordRoute`/`getRecentRoutes` 是进程内环形缓冲（最多 50 条，不持久）。
- `lib/routes.js:169–196` `reportRoute` 只在 `context.enabled !== false` 时才 `logger.info`；`lib/index.js:920` `if (config.logRouting !== true) return` 抑制控制台日志；`lib/index.js:1060–1081` `#reportDirectRoute` 把 `onRoute` 记录送入 `reportRoute`。
- `lib/telemetry.js` 默认关闭，落盘的是聚合摘要 `telemetry.json` 而非 per-request 线；`~/.dsh/storages/` 下无 freellmapi 设置文件 ⇒ 验收会话运行在默认配置，看不到路由日志（E10 原文）。

**步骤（方案层面，不动源码；如后续入代码，按此实现）**：
1. 在插件配置页（侧边栏 插件 → dsh-freellmapi → 配置卡片，默认折叠，点标题展开）开启路由遥测/日志开关（对应 `telemetry: true` 或 `logRouting: true`）；按 `PROJECT-RULES.md` 规则 6，客户端半侧/配置结构改动需重启 DSH 后生效。
2. 新增 best-effort per-request writer：在 `lib/routes.js` `reportRoute`（line 169）或 `lib/index.js` `#reportDirectRoute`（line 1060）内，追加把 `formatDirectRouteLine` 记录按追加方式写入 `~/.dsh/storages/dsh-freellmapi/routes-<UTC日期>.log`；写失败吞掉（observability must never fail a request，同 `lib/telemetry.js` 的设计）。
3. 轮转：按 UTC 日期拆文件；单文件超过阈值（如 2 MB）时新建并保留最近 10 个，超出按 mtime 删除，避免无界增长。
4. 验收会话自查：文档化定位命令，如 `ls -t ~/.dsh/storages/dsh-freellmapi/routes-*.log | head -n 1`，再 `grep 'dsh-freellmapi:'`；“哪家赢了/试了几家”直接读自 per-request 行（`provider/model` 与 `candidates tried`），并可与 `lib/telemetry.js` 聚合摘要的 `byProvider[].wins/attempts` 互相印证。

## 不做（Out of scope）
- 不把 per-request 日志落盘做成请求路径上的阻塞写或阻断门（best-effort、吞异常，绝不能失败请求）。
- 不记录 prompt/reply/reason 等文本内容（`lib/telemetry.js` 已明确“aggregates only，never a prompt, never a reply, never a reason string”）。
- 不把默认关闭改为默认开启的代码实现（本任务只产出方案；若默认开启，需和“配置是用户的”原则权衡，方案里保留“或至少文档化如何在当前会话打开”的退路）。
- 不改动 `dsh-freellmapi/` 源码、`acceptance-2026-10-15.md`。

## 已知风险 / 未知项
- 运行中 DSH 进程可能持有 stale module（`link:` 实时引用但主进程未重启），配置改后不重启则看不到新日志（规则 6）。
- 多会话并发追加同一文件可能出现条目交错，需以追加方式写入并接受少量交错，或按会话 ID 分文件。
- 按日期/体积轮转后，验收会话可能找不到“当天”文件（时钟/时区），文档必须按 mtime 找最新文件而非硬编码文件名。
- 默认若不开，验收会话仍看不到 per-request 日志——方案的退路是文档化打开与定位，验收口径需把“未开遥测 ⇒ 无 per-request 日志”作为配置状态如实记录（E10 原定性），不得把“不可见”误判为插件缺陷。

---
name: p2-e10-per-request-routing-log
status: pending
owner: unowned
write_scopes: ["dsh-freellmapi/lib/routes.js", "dsh-freellmapi/lib/index.js", "dsh-freellmapi/lib/telemetry.js"]
blocked_by: []
