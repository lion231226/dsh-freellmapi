# 新会话引导词

> **用法**：把下面 ` ```text ` 代码块里的内容整体复制，粘贴到新会话的第一条消息里。
> **生成时间**：2026-10-15 · 生成时 HEAD `b74c23e`（v0.6.2）+ 本次未提交的规则/门/任务书

---

```text
【项目】dsh-freellmapi —— DSH 的免费 LLM 自动路由插件
【工作区】D:\MyProject\研究学习\DSH插件\dsh-freellmapi
【仓库】https://github.com/lion231226/dsh-freellmapi （MIT，已发布 v0.6.2）

## 先读这三份，再动手（按顺序）

1. D:\MyProject\研究学习\DSH插件\dsh-freellmapi\PROJECT-RULES.md
   → 操作手册 + PDCA 循环 + 8 条硬规则 + 教训账本。**每一条规则背后都有一次具体的失败。**
2. D:\MyProject\研究学习\DSH插件\dsh-freellmapi\docs\EXPANSION-v0.7.md
   → 本次要做的事：pool 扩展。含已实测的候选清单与 7 条机械验收标准。
3. D:\MyProject\研究学习\DSH插件\dsh-freellmapi\IMPLEMENTATION.md
   → 设计说明与每一处刻意偏离（需要时才查）。

## 这个项目是什么

一个 DSH LLM 适配器插件：注册一个 `freellmapi` provider 路由，对外只暴露一个 `auto` 模型，
内部按请求复杂度打分、在 12 家免费 provider 之间自动选择并故障转移。

**它是 tashfeenahmed/freellmapi（https://github.com/tashfeenahmed/freellmapi，MIT）的衍生作品。**
移植了：provider 目录（lib/providers.js 逐条带 source:/note: 溯源注释）、冷却阶梯（lib/health.js）、
路由模型。**没有**内嵌任何上游文件（上游 TypeScript，本包纯 JavaScript）。
上游署名是 MIT 法定义务，`NOTICE` 文件必须随包分发——不要删。

## 当前状态（会话开始时应先复核）

- 版本 v0.6.2；测试 411 项；`node tools/gate.mjs --online` 应全绿
- profile 安装方式：**link:** 指向工作区 ⇒ **改工作区代码 = 改已安装代码，重启 DSH 生效**
- 池子 12 家；默认开启 5 家（groq / cerebras / openrouter / llm7 / kilo）
- 上游 70 个 Platform；门 G8 会报告还有多少家未纳入

## 第一步动作

    cd D:\MyProject\研究学习\DSH插件\dsh-freellmapi
    node tools/gate.mjs --online

**先看门的输出，再决定做什么。** 门是编号的（G1–G8），失败可以引用编号。

## 八条不可违反的规则（摘要，细则见 PROJECT-RULES.md §3）

1. **绝不静默降级**。任何"失败就退回能用的东西"的分支都必须有人负责：要么响亮失败，要么留下可观测证据。
   （代价：一个"优雅"的 schema 回退让 provider 在 UI 里消失了几小时，而它在正常路由流量。）
2. **先读产物，再下结论**。DSH 插件契约大多没文档，答案在 app.asar 的实现里。
   不要从其他插件的相似行为推断，也不要用文档猜。
3. **探测方法是断言的一部分**。报"可达/不可达"必须同时报"怎么探的"。
   403 有三种含义（拒匿名/拒假凭据/真封锁），完全取决于你发了什么头。
4. **上游署名是法定义务**。新增 provider 数据必须带 source:/note: 字段。
5. **装 profile 只走 `plugin_manager install_bundle`**（绝对目录）。
   不要手写 profile 的 package.json / cordis.patch.yml，不要在 profile 目录跑 pnpm。
6. **区分"需重启"与"即时生效"**：客户端半侧/patch 行/schema 结构需重启；凭据写入即时生效。
7. **"注册了但看不见"是高频失败形态**。固定诊断顺序见 PROJECT-RULES.md §3 规则 7——从上往下查。
8. **偶发失败必须诊断，不许重试掩盖**。报告测试结果要说清口径（"411/411"指干净运行，非确定性）。

## 不要做的事

- 不要动 `NOTICE` / `LICENSE` 里的上游声明
- 不要给 `package.json` 加 `dependencies`（会遮蔽 profile 的运行时并整档禁用）
- 不要在 `lib/config.js` 里恢复任何 schema 回退
- 不要把 `settingsPath` 从 `[]` 改回 `['providers', ...]`
- 不要从"功能相似度"推断一个包的出处；读代码里的 source:/note: 注释
- 不要在没有机械验收标准的情况下开始改代码

## 本次要交付的

按 docs\EXPANSION-v0.7.md 执行。其中 S1（修正 README 里错误的可达性表 + 落地 tools/gate.mjs）
应已在前一会话完成，请先确认；确认后从 S2（纳入第一批 6 家候选）开始。

## 交付要求

- 每个修复/新增都带守卫测试，并做**反向注入**（撤掉改动确认测试变红，再改回）
- 涉及实质改动的声明，交付前用 verified_progress_verify 让独立验证者核一遍
  （注意：验证者的验收标准必须落在它能力范围内——它不能执行命令，别把 git blob hash 之类塞进去）
- 发布走 PROJECT-RULES.md §1 的[A]发布仪式，顺序不许跳
```

---

## 为什么引导词要写成这样

| 段落 | 解决的问题 |
|---|---|
| **先读三份文档** | 今天最大的时间浪费来自"没读文档就开始改"。规则手册把八次失败压缩成八条可执行的约束。 |
| **把它是什么说清** | 我两次误判了它的来源（先当网关适配器、再错认成第三方插件的路线），正确答案是上游本身。**新会话不该再走这条弯路。** |
| **当前状态要复核** | 版本/测试数/门状态是**会变的**，写死数字会腐。所以写的是"应全绿"+第一条命令就是跑门。 |
| **第一步动作是命令** | 不要用叙述启动，用一条可执行的命令启动。 |
| **不要做的事** | 六条都是**已经踩过**的坑，每条都能指向具体代价。 |
| **交付要求** | 反向注入与独立验证是今天唯一有效拦住错误的手段（连续 5 轮 COMPLETE 就是这么来的）。 |

**这份引导词是 `PROJECT-RULES.md` 的入口，不是替代品。** 它只负责把新会话带到门口。
