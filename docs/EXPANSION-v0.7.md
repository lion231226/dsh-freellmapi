# 任务书：provider 池扩展 v0.7

> **状态**：待批准
> **前置**：`PROJECT-RULES.md`（操作手册）、`tools/gate.mjs`（自检门，已可运行）
> **一句话目标**：把池子从 **12 家**扩到 **18–20 家**，且**每一家都经过方法感知的可达性验证**、**每一家都有可用的免费额度**、**扩充后全量门仍绿**。

---

## 1. 为什么做

上游 `tashfeenahmed/freellmapi` 有 **70 个 Platform**（69 家真 provider + `custom`），我们只收 **12 家**（门 G8 实测：`upstream 70 platforms, we carry 12; 58 not yet adopted`）。

12 家是当初的合理取舍（只收"有免费额度 + DSH 的 OpenAI 兼容 seam 能直接消费"的家），但留下了两个具体缺口：

| 缺口 | 后果 |
|---|---|
| **单点依赖** | 默认开启的只有 5 家；`openrouter` 一家承担 `complex` 档主力 |
| **地域风险** | 免费额度对网络敏感；一旦某家策略变化，池子变薄 |

---

## 2. 必须先纠正的一个事实（本任务书的方法前提）

**v0.6.1 的 README 写着 groq / cerebras 被区域封锁、"配 key 也没用"。这句话是错的。**

错在方法：那次探测**没有带 `Authorization` 头**。实测（2026-10-15）：

```
groq      无凭据 → 403      带任意 Authorization 头 → 401（= 可达，只是要真 key）
cerebras  无凭据 → 403      带假凭据              → 401（= 可达）
ovh       无凭据 → 200      带假凭据              → 403（keyless 家反过来！）
```

**结论**：`403` 有三种互不相同的含义——**拒匿名 / 拒假凭据 / 真封锁**——完全取决于你发了什么。任何"可达性"结论都必须附带方法。

**本任务书的所有候选探测一律遵循**：

| provider 类型 | 探测方法 | 健康响应 |
|---|---|---|
| keyless（`keyless: true`） | **不带** Authorization 头 | `200` |
| 需 key | **带**语法合法但无效的 Authorization 头 | `401` |

`tools/gate.mjs` 的 `probe()` 已按此分流，`verdictOf()` 会对 403 标注"歧义"。

---

## 3. 候选清单（已按上述方法实测）

### 3.1 第一批：建议直接纳入（可达 + 免费额度 + OpenAI 兼容）

| provider | 实测 | 免费额度 | 价值 | 备注 |
|---|---|---|---|---|
| **`modelscope`** (魔搭) | `200` | 有 | **国内直连、注册免翻墙** | 阿里系，模型多 |
| **`xfyun`** (讯飞星火) | `401` ✓ | 有 | **国内直连** | 需实名 |
| **`siliconflow`** (硅基流动) | `401` ✓ | 有 | **国内直连、推理快** | 需实名 |
| **`sambanova`** | `200` | 有 | 高吞吐 | 海外可达 |
| **`huggingface`** (router) | `200` | 有 | 模型最全 | 需 token |
| **`routeway`** | `200` | 有 | — | 未深入调研 |

### 3.2 第二批：需先补充调研再决定

| provider | 实测 | 阻塞点 |
|---|---|---|
| **`qianfan`** (百度千帆) | `403`（**歧义**） | 403 可能是"拒假 key"而非封锁；需用真实免费 key 验证一次 |
| **`cloudflare`** (Workers AI) | `404` | 探测路径需要 account id；需读上游实现确定正确端点 |
| **`reka`** / **`sealion`** | `401` ✓ | 免费额度是否覆盖 DSH 的用途待确认 |
| **`ollama`** | 未探 | 需本地部署；属于"离线/隐私"场景，与免费额度主题不同 |

### 3.3 明确不做（本轮）

- **搜索类**（`tavily` / `exa` / `firecrawl` / `linkup`）、**语音类**（`speechify`）：DSH 的 `LlmAdapter` seam 消费不了，收进来只是死重量。
- **需要付费/无免费额度的家**：违背本项目"零配置可用"的定位。
- **`google` / `sail` / `aclide` 等需要特殊 API 形态的家**：非 OpenAI 兼容，需要额外适配层，另开任务。

---

## 4. 验收标准（先写，后做；每条机械可判定）

### AC1 — 数据完整性
每新增一家，`lib/providers.js` 的条目**必须**包含：
- `baseURL`、`apiKeyEnv`、`keyless`、`enabled`、`confidence`、`limits`、`models[]`
- **`source:` 或 `note:` 字段，指向上游 `providers/*.ts` 的文件与行号**（这是 MIT 溯源记录，见规则 4）

> 判定：`node tools/gate.mjs` 的 G1 通过 + 人工核每条都有溯源字段。

### AC2 — 可达性（方法感知）
每家新增 provider 在 `tools/gate.mjs --online` 的 G7 里显示 `reachable`。

> 判定：G7 输出中该家不是 `UNREACHABLE`；若为 `AMBIGUOUS`，必须在任务书里写明原因与后续动作。

### AC3 — 反漂移
`node tools/gate.mjs` 的 **G6** 通过（生成块与 `lib/providers.js` 一致）。

> 判定：G6 输出 `client-setup block is current`。
> **注意**：生成器只收录 `enabled === true` 的家。若新增家默认关闭，它不会进浏览器表——这是预期行为，但**必须在 CHANGELOG 说明**。

### AC4 — 不回归
`node tools/gate.mjs --online` 全绿，且测试数**只增不减**。

> 判定：G5 输出 `pass >= 411`、`fail === 0`。

### AC5 — 每个新家带一条守卫测试
在 `tests/providers.test.mjs` 增加断言：该家的 `apiKeyEnv` 唯一、`baseURL` 是 https、`models[]` 非空、`contextWindow` 为正整数。

> 判定：`node --test tests/providers.test.mjs` 通过；**并做反向注入**——故意把一个 `contextWindow` 改成 0，确认测试变红，再改回。

### AC6 — 文档同步
- `README.md` / `README-zh.md`：provider 表新增行；**删除 v0.6.1 那张错误的可达性表**，替换为"方法感知"的版本
- `CHANGELOG.md`：新版本条目写清根因（如果本次同时修正了探测方法，必须写明）
- 版本号：三条（`package.json` / 两版 README 标签）一致

> 判定：`grep` 三处版本号一致；README 里不再出现"region-blocked / 被封锁"这类**未附方法**的断言。

### AC7 — 发布仪式完成
`PROJECT-RULES.md` §1 的[A]清单全部执行，`git rev-parse HEAD` == 远端 `main` == 标签。

---

## 5. 分阶段执行建议

| 阶段 | 内容 | 产出 |
|---|---|---|
| **S1** | 先修正 Readme 的错误可达性表 + 落地 `tools/gate.mjs` | v0.6.3（**可独立发布**，已包含在本任务的前置里） |
| **S2** | 纳入 §3.1 的 6 家，默认 `enabled: false` | v0.7.0 |
| **S3** | 逐家实测（有 key 的用真 key 跑一次真实补全），把验证结果写进 `notes` | v0.7.x |
| **S4** | 对 §3.2 的歧义家补调研，能确证的纳入 | v0.7.x |
| **S5** | 跑一次池子体检（`PROJECT-RULES.md` §2 自优化），按"从未胜出"关闭低效家 | 配置建议，非代码 |

**S2 与 S3 的顺序不能颠倒**：先把家收进目录（默认关闭 = 零风险），再用真 key 验证；**不要**在没有任何一家真实验证过的情况下就把默认开关打开。

---

## 6. 已知风险与未知项

| 项 | 说明 |
|---|---|
| **`qianfan` 的 403** | 我**不知道**它是封锁还是拒假 key。必须用真实免费 key 验证，不许猜。 |
| **免费额度的时效性** | 上游 README 的额度数字来自 2026-04 基线，可能过期。收进来时以"能跑通"为准，不以数字为准。 |
| **国内厂商的实名要求** | `xfyun` / `siliconflow` / `qianfan` 需要实名；`modelscope` 相对宽松。这会直接影响"零配置可用"的定位——**但只影响"需要 key"的家，不影响 keyless 家**。 |
| **生成器只收录默认开启的家** | 新增家若默认关闭，卡片不会长出密钥行（这是 v0.6.1 已记录的**已知缺口**）。S2 之后若要补齐，需要另开任务让浏览器半侧读取**实际生效**的 enabled 集合。 |
| **偶发测试失败未解决** | 约 25 次全量运行出现 2 次，隔离跑 200 次复现不出。AC4 的"411"指的是干净运行，不是确定性。 |
