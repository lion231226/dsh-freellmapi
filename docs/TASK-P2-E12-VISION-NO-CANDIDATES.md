# 任务书 P2-E12：vision NO_CANDIDATES 诊断与覆盖信息性输出（不改能力声明，结论写“不知道”）

> 来源：`_lead/优化方案-2026-10-16.md`（P2）、`_lead/ws-gates-method.md`（E12 方案）、acceptance-2026-10-15.md E12 原文。  
> 适用仓库：`dsh-freellmapi`，HEAD `ee4865b7e6a0350dd15b9dc5ed69fc6a6ca21172`（v0.7.17）。  
> 执行约束：不改任何 `caps.vision` 声明（保持现状）；不做线上视觉正控（缺凭据，OpenRouter 401 未建立）；不把 `NO_CANDIDATES` 改成阻断门或自动降级到文本模型（静默降级违反 `PROJECT-RULES.md` 规则 1）；不改动 acceptance 文件。

## 目标（可证伪的单句）
不改任何 `caps.vision` 声明；当图片请求在适配器内被 `NO_CANDIDATES` 挡下（0 次线上调用）时，诊断必须枚举“哪些行声明了 vision、各被什么原因（key 缺失/禁用/冷却中）阻止”；把 vision 覆盖情况作为 G7/G10 的附加信息性输出（非阻断）；关于视觉能力结论一律写“我不知道”，不推断模型是否支持视觉。

## 验收标准（先写，后做；每条机械判定）
1. **NO_CANDIDATES 诊断**：触发含图片请求（tier=medium，无 keyless 可达 vision 行）后，期望输出：失败信息/诊断中列出所有声明 `vision: true` 的 model 行，每行带阻断原因，如 `groq/llama-4-maverick-17b-128e-instruct — key missing (GROQ_API_KEY)`、`cerebras/llama-4-maverick-... — key missing (HTTP 401)`、`openrouter/dots-studio/dots-3-note-preview:free — key missing`、`kilo/* — 未声明 vision 或不可达`、`llm7/* — 未声明 vision`；并明确 `online attempts: 0`。
2. **门输出**：`node tools/gate.mjs --online`；期望输出：G7/G10 附加一条信息性记录（不影响 PASS/FAIL），如 `vision coverage: <N> default-enabled rows declare vision; keyless reachable vision rows: 0`（本环境期望 0，因声明 vision 的 6 行本轮全部不可达，E12 原文）。
3. **反向注入**：若 NO_CANDIDATES 诊断不再枚举 vision 行与阻断原因，或 G7/G10 不再输出 vision 覆盖信息，则标准 1/2 红。

## 方法（file:line / 流程步骤）
**现状（已复核）**：
- `lib/routes.js:142–153` `formatDirectRouteLine` 已有 `no candidate (0 candidates tried)` 行；E12 原文证据：`dsh-freellmapi: tier=medium -> no candidate (0 candidates tried)`，`{"type":"finish","reason":{"kind":"error","failure":{"code":"NO_CANDIDATES",…}}}`，线上请求次数 0。
- `lib/providers.js` 中声明 `vision: true` 的行（如 cerebras `llama-4-maverick-17b-128e-instruct`、openrouter 两条 vision 真实测试行、github 两条 vision 行），但均 `enabled: false` 或 key-required；`tools/gate.mjs` G7/G10 目前无 vision 覆盖信息性输出。（注：具体 vision 行的 `lib/providers.js` 行号未在此次 Lead 复核中读取，执行时需重新确认。）

**步骤（方案层面，不动源码；如后续入代码，按此实现）**：
1. 在抛 `NO_CANDIDATES` 前（或在 terminalFailure 的 failure 字段里），枚举 pool 中所有 `caps.vision === true` 的行，按 provider+model 归属，对每行标注静态可判定的阻断原因：`apiKeyEnv` 未配置（key missing）、`enabled: false`（禁用）、不可达（G7 UNREACHABLE）；运行时的“冷却中”来自 `lib/health.js`（line 未读取，标“待行号核对”），离线 gate 不够，需标注“运行时可见，离线不可得”。
2. 把枚举写入失败信息或附加诊断字段，供验收会话读取；持久位置可复用 E10 的 per-request 路由日志/telemetry 摘要。
3. G7/G10 增加附加信息性输出（非阻断，不影响门的 PASS/FAIL）：`vision coverage: default-enabled 声明 vision 的行数；keyless 且可达的 vision 行数`。
4. 验收结论里关于任何模型的视觉能力，一律写“我不知道”，不推断；正控失败（OpenRouter 401，E12 原文）不得被读成“不支持视觉”。

## 不做（Out of scope）
- 不把任何 `vision: false` 的行改为 `vision: true`，不改动能力声明或 catalog 数据。
- 不做线上视觉正控（缺凭据，OpenRouter 401 未建立，E12 原定性）。
- 不把 `NO_CANDIDATES` 改成阻断门或改为自动降级到文本模型（静默降级违反 `PROJECT-RULES.md` 规则 1）。
- 不改动 `dsh-freellmapi/` 源码、`acceptance-2026-10-15.md`。

## 已知风险 / 未知项
- “冷却中”等运行时健康状态（`lib/health.js` 的 `effectiveFailures`/延迟 EWMA）离线 gate 脚本够不到，只能报 key missing/未启用/不可达这些静态原因，冷却需标注“运行时可见，离线不可得”。
- 多 provider 同一 id（如 nemotron 在 kilo/openrouter 并存），枚举须按 provider+model 归属，避免把不同网关上的同一 id 混为一谈（`lib/providers.js` 注释已有此类教训，如 cohere/north-mini-code 在 kilo 与 openrouter 的差异）。
- 结论只能写“不知道”，对用户信息量有限，必须诚实，不得以“0 次线上调用”推出“不支持视觉”。
- 只读口径下无法改 `lib/index.js` 的 NO_CANDIDATES 分支，方案停留在“诊断应当包含什么”与“门应当输出什么信息”层面。

---
name: p2-e12-vision-no-candidates-diagnosis
status: pending
owner: unowned
write_scopes: ["dsh-freellmapi/lib/index.js", "dsh-freellmapi/lib/providers.js", "dsh-freellmapi/lib/routes.js", "dsh-freellmapi/tools/gate.mjs"]
blocked_by: []
