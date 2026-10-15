# dsh-freellmapi

**给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 做免费额度多 provider 智能路由。**
十八条 provider 条目藏在一条 DSH provider 路由背后——其中**五家开箱启用，且这五家都有免费额度**——
外加逐请求的复杂度分类器、能力/速度排序与 429/5xx 自动故障转移。

```text
装插件  →  启动 DSH  →  模型选 provider "freellmapi" + model "auto"  →  它就能答
```

不需要外部进程，不需要自己跑网关，也不需要一上来就配 key——内置池里有**免凭据**的 provider，
维护者已用不带任何 Authorization 头的真实请求验证过。

> ### 非官方插件，请先读这一段
>
> 这是一个社区项目，与它所访问的任何上游 provider、与 freellmapi 项目、与 DeepSeek **均无隶属
> 关系**，未获其背书、赞助或支持；也不是 DSH 的官方插件。各 provider 名称、"DeepSeek Harness" 与
> `@deepseek-ai/*` 的权利归各自所有者。本项目采用 [MIT 许可证](LICENSE)。
> **遵守各家服务条款是你自己的责任；免费档可能记录甚至用你的请求做训练，请自行判断。**

---

## 目录

- [快速开始](#快速开始)
- [你会得到什么](#你会得到什么)
- [零配置：一个 key 都不配时能用什么](#零配置一个-key-都不配时能用什么)
- [添加 key](#添加-key)
- [模型列表怎么读](#模型列表怎么读)
- [钉模型是严格模式](#钉模型是严格模式)
- [它怎么选模型](#它怎么选模型)
- [长时 Agent 会话：用 `auto` 之前请先读这一节](#长时-agent-会话用-auto-之前请先读这一节)
- [故障转移与健康度](#故障转移与健康度)
- [两种模式：`direct` 与 `gateway`](#两种模式direct-与-gateway)
- [配置](#配置)
- [怎么看出它做了什么](#怎么看出它做了什么)
- [只配一家？一家都不配？](#只配一家一家都不配)
- [架构](#架构)
- [故障排查](#故障排查)
- [限制与未验证项](#限制与未验证项)
- [兼容性](#兼容性)
- [开发](#开发)
- [上游与致谢](#上游与致谢)
- [许可证](#许可证)

## 快速开始

1. **装插件** —— 打开 DSH Web GUI，进侧边栏的**插件**管理器，安装 bundle 时粘贴下面任意一种 spec：

   ```text
   github:lion231226/dsh-freellmapi          # 直接从 GitHub 装（无需先发 npm）
   github:lion231226/dsh-freellmapi#v0.7.8   # 钉到某个 tag
   dsh-freellmapi                            # npm 包名（发布之后可用）
   ```

   CLI 写法和手工放置见[安装细节](#安装细节)。

2. **（可选）粘几把 key** —— 见[添加 key](#添加-key)。跳过这一步是**受支持的配置**：两家免凭据
   provider 照样能答。

3. **选模型** —— 在 DSH 的模型选择器里选 provider **FreeLLMAPI (Auto)**、模型 `auto`。

4. **看它干活** —— `logRouting` 默认打开，每个请求一行日志：

   ```text
   dsh-freellmapi: tier=complex -> openrouter/nvidia/nemotron-3-ultra-550b-a55b:free (capability=5, speed=3, 2 candidates tried)
   ```

安装到这里就结束了，下面全是细节。

### 安装细节

| 方法 | 做法 |
|---|---|
| **插件管理器（推荐）** | 侧边栏 → **插件** → 安装 → 粘贴 `github:lion231226/dsh-freellmapi`（或发布后的 npm 包名），确认，需要时重启 DSH。管理器接受 registry 包名、绝对路径、git 地址与 tarball URL，并会拒绝任何 manifest 里没有 `dsh.bundle` 的 spec——本包声明了。 |
| **`dsh plugin` 命令行** | `dsh plugin --profile desktop add github:lion231226/dsh-freellmapi` —— 子命令名取自 DSH 运行时自己的错误文案；⚠️ 本仓库未端到端验证过，动手前请用你的 DSH 版本确认。 |
| **手工放置** | 把包放到 `$DSH_HOME/profiles/<profile>/node_modules/dsh-freellmapi/`，在 profile 的 `package.json` 里**同时**加进 `dependencies` 与 `dsh.profile.bundles`，然后 `dsh plugin --profile <profile> install` 并重启。进 `bundles` 才是 DSH 真正加载它的原因。 |

本包自带 `cordis.patch.yml`（`- insert: [{ id: freellmapi, name: 'dsh-freellmapi' }]`），所以正确安装
的 bundle 不需要你手写任何 patch 行。**千万不要**在 profile 自己的 `cordis.patch.yml` 里再插一行同
`id` 的记录：两个同 id 的 entry 会让组合树以 `duplicate loader entry id "freellmapi"` 直接拒绝启动。

## 你会得到什么

| | |
|---|---|
| **自包含的路由** | 路由智能在插件里。默认的 `direct` 模式不需要网关、不需要常驻进程、不需要 Docker，只要有 DSH。 |
| **内置 18 家 / 45 个模型的池子** | Groq、Cerebras、OpenRouter、GitHub Models、Mistral、Z.ai（智谱）、火山方舟、LongCat、LLM7、Kilo、NVIDIA NIM、OVH AI Endpoints，加上 0.7.0 新增的六家——魔搭（ModelScope）、讯飞星火（iFlytek Spark）、硅基流动（SiliconFlow）、SambaNova、HuggingFace Router、Routeway——每个模型都带能力、速度、上下文、视觉与工具调用的事实标注。**十八家里只有五家开箱启用。** |
| **逐请求的复杂度路由** | 每个请求都被打分并分成 `simple` / `medium` / `complex` 三档；档位决定排序里"能力优先"还是"速度优先"。一句"列出目录里的文件"和一个带 12 个工具的重构任务，不会落到同一个模型上。 |
| **自动故障转移** | 被限流（429）、报错（5xx）、超时或 `model_unavailable` 的候选会被"停车"，然后按排名试下一个——**且只允许在第一个 chunk 发出之前**换家，所以一条回答绝不会由两个模型拼接而成。 |
| **健康度与冷却** | **首次可重试失败就已经停车**（2 分钟），之后每次连续失败升一级：2 分钟 → 10 分钟 → 1 小时 → 24 小时。provider 给的 `Retry-After` 永远优先；凭据被拒（401/403）则该家停车 24 小时。降权会按 60 秒半衰期衰减，所以一次 429 绝不会变成"无期徒刑"。 |
| **零配置即可起步** | Kilo 与 LLM7 不需要任何凭据就能答；全新安装在你配任何东西之前就已经有非空候选池。 |
| **诚实的诊断信息** | 每个请求一行日志，写明档位、胜出者与试了几家；所有失败都是带内 `finish` chunk 加稳定错误码，绝不抛异常。 |
| **绝不静默替换** | 选中具体模型 id 就是**严格钉模型**：没凭据、不存在、正在冷却，都会得到带指引的明确报错，而不是别人家的答案。模型列表只展示真的能服务的东西，每个没配凭据的家折叠成一条 `setup:<provider>` 路牌。 |
| **`gateway` 模式原样保留** | v0.1.0 的行为——转发给外部 [freellmapi](https://github.com/tashfeenahmed/freellmapi) 网关——仍在 `mode: gateway` 后面，一字未改，给想要网关自己的 bandit 打分、缓存与 `fusion` 的人。 |

## 零配置：一个 key 都不配时能用什么

池子里有三家被标为 **keyless**（完全不发 `Authorization` 头）。维护者在 2026-10-13 用**不带任何
凭据**的真实请求验证过（`_lead/live-probe-2026-10-13.md`）：

| Provider | 模型 | 结果 |
|---|---|---|
| `kilo`（`https://api.kilo.ai/api/gateway/v1`） | `nvidia/nemotron-3-super-120b-a12b:free` | **HTTP 200**，真实补全 |
| `kilo` | `nvidia/nemotron-3-ultra-550b-a55b:free` | 免费路由，550B 量级 |
| `ovh`（`https://oai.endpoints.kepler.ai.cloud.ovh.net/v1`） | `gpt-oss-120b` | **HTTP 200** |
| `llm7`（`https://api.llm7.io/v1`） | `DeepSeek-V4-Flash-0731` | **HTTP 200**（匿名） |
| `llm7` | `codestral-latest` | **HTTP 200**（匿名） |

`kilo` 与 `llm7` **默认启用**，"装完即可用"这条承诺就靠这两家撑起来。`ovh` 虽然也免凭据，但**默认
关闭**（2 请求/分钟，放进默认候选集太挤）；想用就显式打开。

依赖免凭据池之前，有三件事你必须知道：

- **免凭据不等于无限量。** Kilo 文档口径约 200 请求/小时每 IP，LLM7 约 100/小时，OVH 只有 2 RPM。
  本文里所有额度数字都来自上游 registry 的 2026-04 基线，可能过期；插件的做法不是相信它们，而是
  对它们做出反应——遇到 429 就把该候选停车、换下一个。
- **免费流量可能被记录并用于训练。** Kilo 在自己的 provider registry 里明说了免费 prompt 与输出会
  被记录用于训练。如果你不能接受，关掉它：

  ```yaml
  providers:
    kilo:
      enabled: false
  ```

  关掉 `kilo` 之后，零配置仍然能靠 `llm7` 单独工作。
- **免费模型目录会漂移。** 2026-10-13 的探针里，`llm7` 对 `gpt-oss-20b` 与 `GLM-4.6V-Flash` 返回了
  `400 model_unavailable`——同样的 id 前一天还能用。路由器把 `model_unavailable` 当作**逐模型**的
  状态：给这个 `(provider, model)` 组合停车，换下一个候选，而不是让你的请求失败。看到这种报错属于
  正常运行，不是 bug。

## 添加 key

key 是性价比最高的一步：默认候选池是 `groq`、`cerebras`、`openrouter`、`kilo`、`llm7`，把前三家补上
就有了又强又快的模型。

给 key 的方式是导出 `apiKeyEnv` 指定的那个环境变量——或者存进 DSH 的凭据服务，那是解析的第一顺位。
解析顺序是：凭据服务 → `config.providers[id].apiKey` → `apiKeyEnv` 指定的环境变量 →
约定名 `<PROVIDER_ID>_API_KEY`。空值一律等于"未配置"。

> **在 GUI 里到哪里编辑。** **设置 → 模型**里本插件的 provider 路由（*FreeLLMAPI*）会作为一张普通卡片
> 列出，而**密钥输入行就渲染在那张卡片内部**——每个"已启用但拿不到可用凭据"的家一行，含申请链接、
> 将要存入的环境变量名、密码框和保存。保存走 DSH 的凭据服务，而该服务读取时**不缓存**，所以
> **下一次请求即生效、无需重启**。
>
> 关于宿主自带编辑器的两点说明，免得把它的行为误当成 bug：
>
> - 卡片右侧的**编辑**按钮打开的是 DSH 的 provider 编辑器，它只能为自家的两个 provider 家族
>   （`llm-deepseek`、`llm-pi-ai`）渲染字段；其他命名空间一律显示"其余字段在 cordis.patch.yml 中"并
>   **禁用保存**。这是宿主当前的限制，上面那几行密钥输入就是针对它的解法。
> - 根级 `apiKeyEnv`（`FREELLMAPI_API_KEY`）未设置时卡片会显示**缺凭据红点**。direct 模式不需要这个
>   key——这一点只关乎可选的 gateway 凭据，可以忽略。
>
> 完整字段集（含各家上游的 `providers` 映射与路由旋钮）在插件**自己的设置页：设置 → 插件 →
> dsh-freellmapi**，由 schema 生成；也可以直接编辑 `cordis.patch.yml`。
>
> 卡片只为**默认开启**的家提供密钥输入行（`groq`、`cerebras`、`openrouter`、`llm7`、`kilo`）。浏览器
> 那份表是**构建时**按默认值生成的，所以你自己通过 `providers.<id>.enabled` 打开的家**不会**长出密钥
> 行——那种情况请直接设置它的 `apiKeyEnv` 并存好凭据。0.7.0 新增的六家全部属于这一类：**即使你把它
> 打开，卡片里也不会为它长出密钥行**（这是 0.6.1 变更记录里已登记的已知缺口，不是 bug）。

### 哪些家可达 —— 以及**该怎么问**

免费额度对网络敏感，所以这一节给的是**测量方法**，不是让你相信的结论。它此前那张表声称 `groq` 与
`cerebras` 被区域封锁、"配 key 也没用"——**那张表是错的**，而错因值得留着：那次探测**没带
`Authorization` 头**。2026-10-15 实测：

| Provider | 不带凭据 | 语法合法但无效的 key |
|---|---|---|
| `groq` | HTTP **403** | HTTP **401** → 可达，只是要真 key |
| `cerebras` | HTTP **403** | HTTP **401** → 可达 |
| `ovh`（免凭据） | HTTP **200** | HTTP **403** → **给免凭据的家塞 key 反而把它弄挂了** |

**所以 `403` 从不自解释。** 它取决于你发了什么，可能是三件完全不同的事：*拒绝匿名请求*、*拒绝凭据*、
*拒绝区域*。只报其中一个，就是那张错表的由来。

**按家分流，正确探测：**

- **免凭据**家（`llm7`、`kilo`、`ovh`）——**不要**发 `Authorization` 头；`200` 才健康。
- **需要 key** 的家——发一个**语法合法但无效**的 `Authorization: Bearer …`；`401` 是健康的
  （端点存在、礼貌拒绝），`200` 也好。
- **`403` 一律视为歧义**：必须换另一种方法再探一次，它才有意义。
- `404`/`400`/`422` 通常说明路径不同，不是主机不可达。

**请求体也是方法的一部分。** 用**不存在的 model id** 去探 chat 端点，会得出**相反**的结论：
`modelscope` 回 `400 Invalid model id`、`sambanova` 回 `404 model_not_found`，而两者都**无法**与
"这家的 chat 不需要凭据"区分——请求根本没走到凭据校验那一步。换成**目录里的真实 id** 重放同一请求，
两家双双回 `401`。同一个 URL、同一组 header，只换了 body，结论就翻了。

门把 header 那半套自动化了：`node tools/gate.mjs --online` 的 **G7** 会按每家适合的方法探测，并在结果
旁**打印所用方法**——结论可被审计，而不是只能被相信。但 G7 只请求 `GET {baseURL}/models`，所以它的
绿要读成"**主机有应答**"，而不是"这家配上 key 就一定能给你补全"。

按此方法在 2026-10-15 实测：

- **0.7 之前的 12 家全部有应答**（G7，2026-10-15），包括旧表里被称为"被封锁"的那两家。
- **0.7.0 新增的六家**（匿名 + 假凭据各探一次）：`modelscope`、`xfyun`、`siliconflow`、`sambanova`、
  `huggingface` 可达；**`routeway` 的匿名 chat 路径是唯一一处未定论的 `AMBIGUOUS`**——不带凭据时它的
  `POST /chat/completions` 拿到的是 Cloudflare 拦截页（`403`、HTML、"Attention Required"），而**带上**
  一个假 `Authorization` 头的同一请求能抵达 origin，拿到干净 JSON 的 `401 Invalid API key`。单条响应
  无法区分"拒匿名"与"拒区域"；一把真 key 或换一个出口 IP 才能定论。**本 README 没有任何结论依赖那条
  匿名路径是通的。**

**每条探测走的是哪条出口，本身就是结论的一部分。** 探测主机跑的是**智能分流（split-tunnel）VPN**：
发往中国大陆站点的流量**直连**出网，其余流量走代理，代理出口在**美国洛杉矶**。**洛杉矶这个出口是"国外
那条路径"的位置——它不是本机的位置，本 README 也不作此声称。** 因此上面的结果按路径分开陈述，而不是
留给读者去推：

- **直连（中国大陆境内）：** `modelscope`、`xfyun`、`siliconflow`——0.7.0 新增六家里位于中国大陆的三台
  主机。三家都是**经由直连路径**应答的（`xfyun` 与 `siliconflow` 对假凭据探测返回 `401`；`modelscope`
  同样可达，另见下方文档站点说明）。
- **经代理（国外出口，US-LA）：** 其余三家新增，以及 0.7 之前的全部 12 家。`routeway` 的 Cloudflare
  行为是在**这条**路径上测的——这正是它的 `403` 至今仍无法与"拒区域"区分开的原因，见上文的
  `AMBIGUOUS` 说明。
- **应用层的判定**（`401`、RFC 6750 凭据挑战、origin 的错误 JSON）与走哪条出口完全无关；"**从你的网络
  能不能到**"则有关——所以每条都记录了所用路径。

**工具的限制不是被测对象的属性。** 本节早先的草稿从一次 `web_fetch` 抓中文厂商文档站失败——报
*"hostname resolves to a non-public IP address"*——推出"**本机无法访问中文厂商/文档站点**"。**这个推论
是错的。** 那句话是本项目自己的 **DNS 守卫**在说话：智能分流 VPN 用保留的基准测试网段
`198.18.0.0/15` 里的**fake-IP** 地址应答 DNS，而 `web_fetch` 拒绝抓取任何解析到该网段的主机名。它在
**同一会话里用同一句话同时拒绝了 `www.xfyun.cn` 和 `github.com`**——这正是它属于"守卫"而非"测量"的
破绽。改用普通 HTTP 客户端经直连路径重测（2026-10-15）：

| 主机 | 直连路径下的结果 |
|---|---|
| `www.xfyun.cn`（厂商文档页） | **HTTP `200`，128 382 B，618 ms**，`Server: Tengine` |
| `modelscope.cn` | **HTTP `200`，4 639 B，290 ms** |
| `spark-api-open.xf-yun.com`（`POST /v1/chat/completions`） | **HTTP `401`**，`{"message":"HMAC signature cannot be verified: apikey not found"}` |
| `siliconflow` 的 `api.siliconflow.com`（`GET /v1/models`） | **HTTP `401`**，`{"code":30014,…"message":"Token is invalid."}` |

所以中文文档站点**一直是可达的**，读不到它们的只有 `web_fetch`。任何"某国的站点到不了"的结论都必须
基于**可达性测量（一个真正与主机通话的 HTTP 客户端）**，而绝不能基于**抓取工具报的错**——后者报告的
是工具的策略，前者才报告网络。

而当某家在你的网络里**确实**不可达时，关掉它就是全部改动，写进
`$DSH_HOME/profiles/<profile>/cordis.patch.yml`（或插件自己的 `providers` 字段）：

```yaml
- id: freellmapi
  config:
    providers:
      someprovider: { enabled: false }
```

申请页（前七家已于 2026-10-14 实测可达）：`groq` <https://console.groq.com/keys>、
`cerebras` <https://cloud.cerebras.ai/>、`openrouter` <https://openrouter.ai/keys>、
`mistral` <https://console.mistral.ai/api-keys>、`zhipu` <https://open.bigmodel.cn/usercenter/apikeys>、
`volcengine` <https://console.volcengine.com/ark>、`longcat` <https://longcat.chat/platform/api_keys>。
**下面 0.7.0 新增六家的申请页取自池条目自己的 `keyURL` 字段，均未经独立复核**——只有 `modelscope`
那一个有上游引用。（此前本节把这项缺口归因于"中文厂商/文档站点在本机一律解析到非公网地址"。**该说法
撤回**：那是 `web_fetch` 的 DNS 守卫造成的假象，厂商文档页实际经直连路径抓到了——见上方的可达性对照表。
申请页本身仍未复核；错的只是原先给的那个理由。）

| Provider | `apiKeyEnv` | 申请入口 | 免费额度（上游基线） | 默认 | 备注 |
|---|---|---|---|---|---|
| `groq` | `GROQ_API_KEY` | <https://console.groq.com/keys> | 30 RPM / 1000 RPD / ~8K TPM / 200K TPD | ✅ 开 | 快；`openai/gpt-oss-120b`、`qwen/qwen3.8-27b`、`openai/gpt-oss-20b`（_模型 id 于 2026-10-15 重新实测：有两条旧 id 已被上游下架_） |
| `cerebras` | `CEREBRAS_API_KEY` | <https://cloud.cerebras.ai/> | 30 RPM / 无 RPD / 60K TPM / 1M TPD | ✅ 开 | 两个模型同时是能力 5 与速度 5；上游另有一版更紧的额度记录（5 RPM / 30K TPM） |
| `openrouter` | `OPENROUTER_API_KEY` | <https://openrouter.ai/keys> | 20 RPM / 200 RPD | ✅ 开 | `complex` 档的主力（`nvidia/nemotron-3-ultra-550b-a55b:free`、`nemotron-3-super-120b-a12b:free`、`cohere/north-mini-code:free`） |
| `llm7` | `LLM7_API_KEY` | <https://token.llm7.io/> | 约 100 请求/小时 | ✅ 开 | **免凭据可用**；有 key 只是抬高上限。申请页是文档级证据，未经独立复核 |
| `kilo` | `KILO_API_KEY` | — | 约 200 请求/小时每 IP | ✅ 开 | **免凭据可用。** 免费流量会被记录用于训练 |
| `github` | `GITHUB_MODELS_TOKEN` | — | 10 RPM / 50 RPD | ⬜ 关 | 有 `openai/gpt-5`，但限流极紧 |
| `mistral` | `MISTRAL_API_KEY` | <https://console.mistral.ai/api-keys> | 500K TPM | ⬜ 关 | `mistral-large-latest`、`magistral-medium-latest`、`codestral-latest` |
| `zhipu` | `ZHIPU_API_KEY` | — | 约 1M TPD | ⬜ 关 · ⚠️ **推测** | `glm-4.7-flash`、`glm-4.6v-flash`。**`baseURL` 是整个池子里风险最高的一项**：国内站与海外站的 key 不互通，主机名选错必然 401。只有你清楚自己的 key 属于哪个站时才开。 |
| `volcengine` | `ARK_API_KEY` | — | 约 2M TPD | ⬜ 关 · ⚠️ **推测** | 国内 provider，需实名；模型 id 是推断的，未经实测 |
| `longcat` | `LONGCAT_API_KEY` | — | — | ⬜ 关 · ⚠️ **推测** | 无需实名；模型 id 是推断的，未经实测 |
| `nvidia` | `NVIDIA_API_KEY` | — | 40 RPM | ⬜ 关 | 能力上限高（`qwen/qwen3-coder-480b-a35b-instruct`），但试用 ToS 写着 "evaluation only"、首字节可能几分钟，另见[限制](#限制与未验证项)里的一条已知缺口 |
| `ovh` | `OVH_AI_ENDPOINTS_KEY` | — | 2 RPM | ⬜ 关 | **免凭据可用**，但只有 2 RPM |
| `modelscope` | `MODELSCOPE_API_KEY` | <https://modelscope.cn/my/myaccesstoken> | 上游写过 2000 请求/日，但上游自己已把该数字标为 historical（现按魔粒计费） | ⬜ 关 | 阿里魔搭。**token 只有在账号绑定到阿里云中国站 + 中国实名认证账号之后才能服务流量**——未绑定 token 每次调用都回 `401 please bind your alibaba cloud account before use`。它的 `GET /models` 对**任意**凭据都回 `200`，所以那个端点不能用来校验 key；要用 1-token chat |
| `xfyun` | `XFYUN_API_KEY` | <https://console.xfyun.cn/> | 无公开的 token/QPS 上限——上游按"不猜"原则置 `null` | ⬜ 关 · ⚠️ **推测** | 讯飞星火。**需中国实名认证。** 鉴权用控制台的 *APIPassword* 当 Bearer token。模型 id `lite` 现已**由厂商文档证实，不再是占位**：官方 HTTP 接口文档页（`spark-api-open.xf-yun.com/v1`，2026-10-15 经**直连**路径取得）把 `4.0Ultra` / `generalv3.5` / `max-32k` / `generalv3` / `pro-128k` / `lite` 列为 `model` 的可取枚举，且其版本表把 **Lite** 写为轻量级并注明**支持免费使用**。但**本机从未用有效凭据实际跑通**，故 `confidence` 仍为 `speculative` |
| `siliconflow` | `SILICONFLOW_API_KEY` | <https://cloud.siliconflow.com/account/ak> | **没有可循环的免费 chat 额度**——`.com` 端点是一次性 $1 试用额度 | ⬜ 关 · ⚠️ **推测** | 硅基流动。**需中国实名认证。** 上游保留这家是为了它的**免费生成式媒体**模型（图像/TTS），而本插件的 LLM seam 消费不了；它当初登记的 chat 模型是**付费**的（$0.06/M），上游已把那一行删掉 |
| `sambanova` | `SAMBANOVA_API_KEY` | <https://cloud.sambanova.ai/apis> | **没有——免费额度已被永久取消。** 持有效 key 时 chat 回 `402 payment method required` | ⬜ 关 · ⚠️ **推测** | **收进来是留档，不是当免费额度用。** 上游正是以这个理由在 V23 里把它退役。它的 `baseURL` **不是**上游转录（上游零匹配），来自厂商公开文档；而且它的 `/models` 仍然回 `200`——上游自己把那个 200 记为 billing gate 假阳性 |
| `huggingface` | `HUGGINGFACE_API_KEY` | <https://huggingface.co/settings/tokens> | 可循环的 **$0.10/月** router 额度，无需绑卡（上游口径：70B 模型上约 1–3M token/月） | ⬜ 关 | Inference Providers router。它的"免费"是**账户额度，不是目录标记**：实测其目录里 296 条 provider 行中 **0 条**标 `is_free: true`。同一个 id 的 `contextWindow` 逐后端不同 |
| `routeway` | `ROUTEWAY_API_KEY` | <https://routeway.ai/> | 文档写 20 RPM / 200 RPD，上游一次实测观察到更紧的 5 RPM——上游自相矛盾，故四档全 `null` | ⬜ 关 · ⚠️ **推测** | 带 `:free` 路由的聚合器。**它的匿名 chat 路径是唯一一处未定论的 `AMBIGUOUS`**（见上）；解锁它的**不是** `User-Agent` 伪装，而是 `Authorization` 头 |

> **这六行要读成"已登记"，不是"免费且能用"。** 六家全部**默认关闭**（`enabled: false`），都需要你自备
> key，而且**都不属于"安装即可用"的默认集合**——那个集合是 `groq`、`cerebras`、`openrouter`、`llm7`、
> `kilo`，在 0.7.0 里没有变。免费额度那一列的真实含义：
>
> - **只有 `huggingface` 与 `routeway` 有可复用的免费 *chat* 额度证据**，且两处都是**上游自己的陈述**
>   （可循环的 $0.10/月 router 额度；`:free` 路由成本 $0）。这两家在这里**都没有用真 key 验证过**。
> - **`sambanova` 已经没有免费额度了。** 它留在池里是为了留档，不是为了让你免费使用。
> - **`siliconflow` 免费的那一半，恰好是本插件用不上的那一半**——免费的是生成式媒体模型，chat 模型是
>   付费的。`modelscope` 与 `xfyun` 不公布任何上限，因此它们的免费额度**在没有凭据的情况下无法核实**；
>   不要把这两家的 `enabled: true` 读成"免费容量有保证"。
> - **`xfyun` 与 `siliconflow` 需要中国实名认证**，其 key 才能服务流量；`modelscope` 还额外要求绑定阿里云
>   中国站账号。这是对"零配置"定位的真实门槛，也正是这几行被标注而不是被默认开启的原因。
> - ⚠️ **推测**表示该条目的池内 `confidence` 为 `speculative`：转录是尽力而为，**可能是错的**。`xfyun`
>   的模型 id 已不再是那个例子——它现在有厂商文档背书（见上方它的行）；对它而言仍未证实的，是"从未有
>   有效凭据用过它"。启用它们等于你接受这个风险。
> - 在这六家保持默认关闭期间，**设置卡片的密钥行不会为它们长出任何一行**。这是预期行为：浏览器那份表是
>   构建时按 `enabled === true` 的条目生成的（见[添加 key](#添加-key)与 0.6.1 的变更记录）。要启用就自己
>   设好它的 `apiKeyEnv`，或在插件自己的设置页里粘贴 key。

> **`apiKeyEnv` 是本插件自己的命名约定，不是上游事实。** freellmapi 本身没有这个概念——它的 key 存在
> dashboard 背后的加密库里。上表每个名字都是**默认值**，你可以逐家覆盖，所以"我们猜偏了"这件事
> 本身无害：

```yaml
providers:
  groq:
    apiKeyEnv: MY_GROQ_KEY        # 你想起什么名字都行
  mistral:
    enabled: true
  acme-gateway:                   # 一个根本不在内置池里的 provider
    baseURL: https://llm.example.com/v1
    apiKeyEnv: ACME_KEY
    keyless: false
    models:
      - id: acme-large
        name: Acme Large
        capability: 5
        speed: 3
        contextWindow: 131072
        maxTokens: 16384
        toolCalling: true
```

## 模型列表怎么读

选择器里的条目分三组，顺序如下：

1. **虚拟路由** —— `auto`、`auto:simple`、`auto:medium`、`auto:complex`，永远存在；
2. **真的能服务的模型** —— 免凭据的家，以及凭据已解析到的家；
3. **每个"已启用但拿不到凭据"的家，折叠成 1 条 `setup:<provider>` 引导项。** 它代替那家的模型行，
   因为那些行选中了也只会得到 `MISSING_CREDENTIAL`。

被**关闭**的家（`enabled: false`，十八家里默认就有十三家）什么都不产出，它们的模型根本不会出现。

`setup:` **不是模型**：选中它不会发起任何请求，它只是一块路牌，名字里带着确切的环境变量名和免费
申请地址：

```text
setup:groq        Groq ▸ needs GROQ_API_KEY (free key: console.groq.com/keys)
setup:cerebras    Cerebras ▸ needs CEREBRAS_API_KEY (free key: cloud.cerebras.ai)
setup:openrouter  OpenRouter ▸ needs OPENROUTER_API_KEY (free key: openrouter.ai/keys)
```

| 你配了什么 | 选择器里显示什么 |
|---|---|
| **什么都没配**（零凭据） | **13 条**：4 条虚拟路由 → 两家免凭据家的 6 个真实模型（`llm7/codestral-latest`、`llm7/DeepSeek-V4-Flash-0731`、4 个 `kilo/…:free`）→ 3 条引导项（`setup:groq`、`setup:cerebras`、`setup:openrouter`）。**没有一条是打不通的。** |
| **配了 `GROQ_API_KEY`** | **15 条**：形状相同，但 groq 的三个真实模型出现（按池子自身顺序，因此排在具体模型的最前）且 `setup:groq` 消失；`setup:cerebras`、`setup:openrouter` 仍在。 |

列表在每次 `listModels()` 调用时重建，所以配好 key 之后你只需要**重新打开选择器**：真实模型出现、
那家的引导项消失。不用重启，也不用改配置。

为什么要折叠：v0.2.0 的零凭据安装里，选择器播发 21 条，真正能答的只有 6 条——而打不通的 Groq/Cerebras
恰好排在最前面。那看起来就是一个坏掉的选择器。现在**能用的模型永远排在引导项之前**。

## 钉模型是严格模式

`auto` 与 `auto:simple|medium|complex` 是让插件**替你选**。任何其它模型 id——选择器里的复合
`provider/model`，或像 `qwen/qwen3.8-27b` 这样的裸 id——都是**钉模型**：你点名要那一个，插件
绝不会拿另一个来答。

严格正是重点。到 v0.2.0 为止，钉住的模型会被**静默替换**：没配 key 时选 `Llama 3.3 70B · Groq`，
会由另一家的模型作答、并且以成功收尾；连 `totally-made-up-model-xyz` 这种根本不存在的 id 也照答不误。
对话记录里没有任何地方说明这件事。v0.3.0 起，钉住的模型若无法服务，会在**联系任何 provider 之前**
明确失败：

| 场景 | 错误码 | message 里会告诉你什么 |
|---|---|---|
| 服务该模型的那家没有凭据 | `MISSING_CREDENTIAL` | 缺的确是哪个环境变量、去哪免费申请、也可以直接在 DSH 设置页粘贴，以及现在就能用的 `auto` |
| 池子里没有任何一家提供该 id | `UNKNOWN_MODEL` | 池里最接近的三个 id、你用的 provider 前缀是否只是被默认关闭、以及改用 `auto` 的建议 |
| 模型存在，但服务它的候选全被门槛挡掉（冷却、视觉、工具、上下文窗口） | `MODEL_UNAVAILABLE` | 逐条排除原因，以及改用 `auto` 或等冷却结束的建议 |

三种结局都以带内 `finish` 错误 chunk 收尾，并且**上游请求数为 0**——最后这半句正是测试断言的东西，
因为"偷偷问了别人、失败了再报错"是同一个 bug 换顶帽子。

**`auto` 与三档覆盖完全不受影响**：它们本来就是在池内自由选型、在候选之间故障转移的。想让插件自己
决定，就用 `auto`。

## 它怎么选模型

每个请求都由一个**纯粹、确定性**的分类器（`lib/complexity.js`）打分：不读时钟、不掷随机数、不联网、
不改动入参。同一段对话永远走同一条路，而且打出这个结论的每个信号都会被记录下来。

### 三个档位

| 档位 | 分数 | 对排序的含义 |
|---|---|---|
| `simple` | `< 0.34` | 能力占 0.25、速度占 0.75——能干活的最快那个 |
| `medium` | `0.34 – 0.67` | 0.50 / 0.50——均衡 |
| `complex` | `≥ 0.67` | 能力占 0.80、速度占 0.20——最强优先，慢一点无所谓 |

### 打分的信号

七个信号，各自归一到 `[0, 1]` 后乘上自己的权重，再用 **noisy-OR** 合成——这样"几个互相独立的吃重
维度"会叠加，而不是被平均掉：

```text
score = 1 − Π (1 − wᵢ · sᵢ)  −  simplePenalty
```

| 信号 | 权重 | 饱和点 | 读的是什么 |
|---|---|---|---|
| `tokens` | 0.46 | 2500 估算 token | 输入规模。中文约 1 token/字，拉丁文约 1 token/4 字符 |
| `tools` | 0.52 | 8 个工具 schema | 模型必须照着执行指令的工具数量 |
| `keywords` | 0.60 | 2 个不同词族 | `refactor`、`architect`、`prove`、`debug`、`重构`、`架构`、`证明`、`为什么` 等 |
| `reasoning` | 0.50 | — | 数学记号（0.25）、比较词（0.25）、"step by step"（0.5） |
| `code` | 0.32 | 2 个块 / 120 行 | 围栏代码块（40%）与其行数（60%） |
| `depth` | 0.20 | 20 条消息 / 6 轮 | 对话长度与 assistant+tool 轮数 |
| `images` | 0.06 | 2 张图 | 是否带图——外加一条**硬地板：至少 medium**，因为只有视觉模型能服务它 |

"简单任务词"（`translate`、`summarize`、`list`、`翻译`、`总结`、`列出` 等）会**扣掉** 0.22——这是唯一
能把分数往下拉的信号。

### 实测例子（不是我编的）

对着本实现跑出来的结果：

| 请求 | 档位 | 分数 | 为什么 |
|---|---|---|---|
| `列出这个目录下的文件` | `simple` | 0.000 | 10 个 token，一个简单任务词把分数扣光 |
| `解释这段代码` + 200 行围栏代码块 | `medium` | 0.349 | 659 估算 token 加 200 行代码——刚刚越过 `medium` 边界 |
| `重构这个模块并给出架构权衡与失败模式分析` + 12 个工具 schema | `complex` | 0.822 | 12 个工具、4 个复杂关键词、1 个比较标记——而且只有约 27 个 token，换成加权**平均**就会被抹平 |

档位到底改变了什么？在默认池、所有 key 都配好的情况下：

| 名次 | `simple` | `complex` |
|---|---|---|
| 1–5 | cerebras `llama-4-maverick-17b`（c5/s5）、cerebras `qwen-3-coder-480b`（c5/s5）、cerebras `gpt-oss-120b`（c4/s5） | 同样两个 c5/s5 模型，然后是 kilo `nemotron-3-super-120b`（c5/s3） |
| 6–7 | cerebras `llama3.1-8b`（c2/s5）、groq `openai/gpt-oss-20b`（c2/s5） | openrouter `nvidia/nemotron-3-super-120b-a12b:free`（c5/s3） |
| 16–17 | openrouter `cohere/north-mini-code:free`（c3/s4） | cerebras `llama3.1-8b`（c2/s5）、groq `openai/gpt-oss-20b`（c2/s5） |

（两个 Cerebras 模型同时是能力 5 与速度 5，所以它们在任何档位都排第一，这是合理的。档位决定的是它们
**之后**的顺序——小快模型就是从第 17 名跳到第 6 名的那一段。）

### 它什么时候会判错——以及你怎么覆盖

**这是启发式规则，不是语义理解。** 它数 token、数围栏、数工具 schema、数词。两个方向都可能判错，
下面是本实现里的真实案例：

| 请求 | 档位 | 为什么不对 |
|---|---|---|
| `证明这个定理` | `simple`（0.304） | 一个复杂词族只饱和到一半，而请求只有六个 token——一个真正需要推理的任务落进了快车道 |
| 3750 个 token 的无关键词长文 | `medium`（0.463） | 光靠 token 最高只能贡献 0.46，够不到 `complex` 边界——一段长而吃力的分析，光凭体量永远进不了 `complex` |
| `翻译这段话` + 12 个工具 | `medium`（0.413） | 工具信号把它推上去，简单任务惩罚又把它拉下来 |

所以当你比分类器更清楚时，直接说出来——**模型 id 本身就是覆盖开关**：

| 模型 | 效果 |
|---|---|
| `auto` | 先分类再路由（默认） |
| `auto:simple` | 强制快车道 |
| `auto:medium` | 强制均衡档 |
| `auto:complex` | 强制最强档 |

任何**其它** id——`llm7/codestral-latest`，或裸的 `qwen/qwen3.8-27b`——都是严格钉模型而不是
档位：见[钉模型是严格模式](#钉模型是严格模式)。

强制档位时分类器**照跑**——分数与理由都会记录，日志行会注明 `(forced by the selected model id)`——
只是档位不再由它决定。

想调阈值而不是钉死档位（高级用法，建议写在 profile patch 里）：

```yaml
routing:
  thresholds:
    medium: 0.25      # 默认 0.34——更多请求变成 medium
    complex: 0.55     # 默认 0.67——更多请求变成 complex
  weights:
    tokens: 0.60      # 这是"单独饱和时的最大贡献"，不是占总量多少
    tools: 0.40
```

## 长时 Agent 会话：用 `auto` 之前请先读这一节

`auto` 是为**一次一个请求**设计的。长时 Agent 会话是形状不同的问题，而这个差别从模型选择器里看不出来——所以写在这里，而不是留给你自己撞上。

**`auto` 声明了什么。** DSH 依据**适配器为它路由到的那个模型声明的上下文容量**来决定**何时压缩**会话。而 `auto` 是代表整池的一个模型名，所以它声明 `min(池内, config.contextWindow)`——**不会宽于池子实际能服务的最小窗口**，也不会低于 131,072（再往下 DSH 自己的阈值会塌陷，几乎每一步都要压缩）。低于该声明的模型**会被排除出 `auto`**；显式钉住它们仍然可用。

**它在哪里仍会咬人。** 压缩会把会话最旧的一段替换成摘要，而**写摘要的那次调用本身带着"被压缩的那段历史"**。如果这次调用落到装不下它的模型上，压缩**在任何重试下都不可能成功**——会话永远不会变小。长会话里有两条机制会走到这一步：

- 摘要由**路由器为那次调用挑中的模型**来写；
- 而池内窗口相差超过一个数量级。

**该怎么办。** 长时 Agent 任务请优先用**显式钉住的模型**，或窗口足够大的单一 provider，而不是 `auto`。钉模型是刻意的严格模式：**它绝不会在背后替换成别的模型**——当任务已经跑了一个小时，这正是你想要的性质。

**插件目前做了什么。** 摘要调用（`purpose: 'compaction'`）**永不被钉**，且受一条自己的容量下限约束（`routing.compactionMinContextWindow`，默认 262,144）；当池内没有任何模型装得下该历史时，它会**响亮失败并点明这条下限**——让失败可见，而不是变成无界重试。路由日志会逐条记录每次排除及其理由。

**诚实的现状。** 这**减轻**了该故障，并没有让一个免费池等同于一个宽窗口模型。这些数字背后的测量记录在 `_lead/research/routing-redesign.md`（工作区笔记，不随包分发）。

## 故障转移与健康度

**唯一一条硬规则：故障转移只允许发生在第一个 chunk 到达 DSH 之前。** 一旦有任何 chunk 被 yield 出去
（哪怕只是个 `block-start`），再失败就只能以错误结束这条流，绝不能换家——把两个模型的输出拼进同一条
assistant 消息，比诚实地失败更糟。这条规则被实现了**两遍**（`dispatchOnce` 与 failover 循环各自独立
复检），并用"流中途把 socket 掐断 + 一个健康的备用 provider"测试过：备用 provider 必须收到 **0 次**
请求。

哪些情况会重试：

| 情况 | 换家？ | 理由 |
|---|---|---|
| `429`、`408`、`409`、`410`、`422`、`5xx` | ✅ | 那是这一家的问题，下一家很可能能答 |
| `404` | ✅ | 通常意味着"这家没有这个 id"——而且它会给这个组合停车，与下面的 `model_unavailable` 一致 |
| `400 model_unavailable` | ✅ | 这是"400 就是坏请求"的**刻意例外**：聚合器会滚动目录，所以它是 `(provider, model)` 的状态 → 与 `404 model_not_found` **完全同样地停车**，再换下一个候选 |
| 其它 `400` | ❌ | 坏请求换到哪家都是坏请求 |
| `401` / `403` | ❌ | 凭据被拒是这一家的事，直接停车 24 小时 |

健康度与冷却：

- **首次可重试失败就已经把候选停车**，停 2 分钟——没有"攒够三次"的宽限期：免费额度下的 429 意思就是
  "现在该退避"，第一次不 park 只会让下一个请求再撞一次同一堵墙、白付一次延迟。之后每次连续失败升一级：
  **2 分钟 → 10 分钟 → 1 小时 → 24 小时**。带 `Retry-After` 时以它为准——只有 provider 自己知道额度
  什么时候重置。
- 失败同时会降权，让刚失败过的候选排在健康同伴之后：`1 / (1 + 0.15 · effectiveFailures)`（下限 0.4）。
  `effectiveFailures` **按 60 秒半衰期衰减**，所以这个惩罚不可能把候选永久饿死：等到 2 分钟冷却过期时，
  一次失败的权重只剩 0.25，而一次成功就把计数直接清零。
- 延迟只有在构成真实证据时才参与排序：
  - 因子是 `fastest / latency`，钳制在 `[0.85, 1]`，其中 fastest 取**本次请求**里已测到的最快者；
  - **没被测量过的候选不再拿满分。** 自己没有证据时，就按"不会快过本次请求里已测到的最慢因子"处理；
    只有当完全测不到任何样本时，这个信号才整体退出（所有人都得 1）。否则"我们从没看过它"会赢过
    "我们测过而且它很慢"，那是反的；
  - 外加一道 **100 毫秒噪声门**：已测候选之间的极差小于它时，整个延迟信号按预热噪声丢弃（本机 4ms
    与 26ms 的差别不代表吞吐量），所有候选都按"未测量"计分。
  因为降幅上限是 0.85，延迟可以重排候选，但翻不动档位已经做出的"能力 vs 速度"决策。
- 流中途失败**不会**给该家停车（一次断流证据太弱），只计入失败次数，影响下一次排名。
- 尝试次数受 `routing.maxAttempts`（默认 6）与 `routing.budgetMs`（默认 45 000 毫秒）限制，两者都在
  每次尝试**之前**检查。

### 请求本身实在太大时

会话可能长过路由器选中的候选。上游对此回 `400`（`maximum context length … However, you requested
about N tokens`），插件把它当成**逐候选**的状况，而不是死路：

- **会换家——但只往上下文更大的方向换。** 不宽于刚刚拒绝它的那个窗口的候选会被直接跳过，因为拿一个
  更小的模型重试同一个超大请求不可能成功。（已实测：候选窗口分别是 131 072 / 100 000 / 262 144 时，
  100 000 那个一次都没被请求过。）
- **这次拒绝不让候选付出任何代价。** 它不会被停车、也不计失败——这个模型是健康的，换一个短请求照样
  服务。真正有用的记忆是它刚报出来的那个窗口，闸门（连同 `routing.contextSafetyFactor`）下一次就会用上。
- **硬不变量不变。** 只要已经有 chunk 吐给 DSH，就完全不换家（`STREAM_INTERRUPTED`）；本次改动没有
  碰这条规则。

当池子里没有一家装得下时，错误会把你需要的两个数字都给你——你的请求有多大，以及最宽的可达模型有多大：

```text
dsh-freellmapi: this request does not fit any model the router can use; it is about 297538 estimated input
tokens; the widest model that refused it declares 262144 tokens; the largest context window in the pool is
262144 (kilo/nvidia/nemotron-3-super-120b-a12b:free); compact the session or lower the attached history,
then retry. — [kilo/small-model → CONTEXT_WINDOW_EXCEEDED; kilo/wide-model → CONTEXT_WINDOW_EXCEEDED]
```

（上面的换行只是为了排版；真实 message 是一行。）这件事同时也是个数据问题，所以上下文窗口的准确性写在
[限制](#上下文窗口哪些是实测哪些是估计)一节里。

终结性结局，全部以带内 `finish` chunk 交付，而不是抛异常：

| 错误码 | 含义 |
|---|---|
| `NO_CANDIDATES` | 池子里没有可用候选——什么都没配且没有启用免凭据家，或所有候选都被硬门槛挡掉（视觉 / 工具 / 上下文 / 冷却）。message 里会列出申请 key 的入口。 |
| `ALL_CANDIDATES_FAILED` | 排好序的候选全试过且全失败；message 里带 `provider/model → 错误码` 的清单。 |
| `STREAM_INTERRUPTED` | 已经吐过输出之后流断了——按设计不再换家。 |
| `MODEL_UNAVAILABLE` | 这家当前没有这个模型。 |
| `ABORTED`、`TIMEOUT`、`TRANSPORT`、`AUTH`、`RATE_LIMIT`、`QUOTA`、`CONTEXT_WINDOW_EXCEEDED`、`UNSUPPORTED_CONTENT`、`UNSUPPORTED_OPTION`、`INVALID_REQUEST`、`SERVER`、`MISSING_CREDENTIAL`、`INVALID_CREDENTIAL`、`EMPTY_RESPONSE`、`CONTENT_FILTER`、`UNKNOWN` | 常见的逐次尝试分类 |

## 两种模式：`direct` 与 `gateway`

| | `direct`（**默认**） | `gateway` |
|---|---|---|
| 谁在路由 | 本插件（分类器 + 排序 + 故障转移） | 外部 [freellmapi](https://github.com/tashfeenahmed/freellmapi) 网关 |
| 需要外部进程 | ❌ 不需要 | ✅ 需要（Docker 或 `node server/dist/index.js`，监听 `:3001`） |
| 凭据 | 每家一把 key，或者一把都不要 | 一把统一的 `freellmapi-…` 网关 key |
| 模型选择器 | `auto`、`auto:simple/medium/complex`，再是 `provider/model` | `auto`、`auto:smart/fast/cheap/reliable/balanced`、`fusion`、发现到的目录 |
| 日志行 | `dsh-freellmapi: tier=… -> provider/model (…)` | `dsh-freellmapi: routed via <platform>/<model> (model=…)` |
| 什么时候用 | 想从"装完"到"能用"走最短的路 | 你已经在跑网关，或者想要它的 bandit 打分、`fusion`、prompt 压缩与面板 |

切换只需要一个字段：

```yaml
mode: gateway            # 默认是 "direct"；gateway 还需要 baseURL 与一把 freellmapi-… key
```

> **两种模式可以在同一份安装里共存，但 `freellmapi` 这个 provider 名只能属于一个适配器。**
> freellmapi 官方的 `npx freellmapi setup-dsh --url http://localhost:3001 --api-key <key>` 写的是
> `llm-pi-ai.providers.freellmapi`，它在 DSH 里的 provider 名同样是 `freellmapi`。provider 路由名在
> 单进程内唯一，所以后注册的一方会被拒绝。如果你已经跑过 `setup-dsh`，请先移除那条路由再装本插件——
> 插件会拒绝加载并点名这处冲突，而不是静默失败。
>
> 另外说清楚：**如果你要的只是那个网关，官方 `setup-dsh` 根本不需要插件。** 它会写
> `$DSH_HOME/settings.yaml` 与 `$DSH_HOME/.env`（权限 `0600`）并设好默认模型。本插件的 `gateway` 模式
> 是给想要"路由可见性"和逐请求失败细节的人准备的。

## 配置

每个字段都是**实时的**（设置改动下一次请求即生效，不用重启），并且校验是**全量兜底**的——非法取值会
退回默认值，而不是让插件加载失败。

| 字段 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `mode` | `direct` \| `gateway` | `direct` | 自包含路由，或转发给外部网关 |
| `baseURL` | string | `http://localhost:3001/v1` | 仅 gateway：freellmapi 网关的 OpenAI 兼容根地址 |
| `apiKeyEnv` | string | `FREELLMAPI_API_KEY` | 仅 gateway：凭据**引用名**（不是密钥本身） |
| `apiKey` | string（secret） | `''` | 仅 gateway：可选内联凭据；优先用 `apiKeyEnv` |
| `providers` | dict 或 array | `{}` | 逐家覆盖内置池（见下） |
| `routing` | dict | `{maxAttempts: 6, budgetMs: 45000}` | 路由引擎旋钮（见下） |
| `logRouting` | boolean | `true` | 是否记录 direct 模式的路由决策（档位、胜出者、试了几家） |
| `logRoutedVia` | boolean | `true` | 是否记录 `X-Routed-Via` / 回退轨迹（gateway 模式） |
| `vision` | boolean | `true` | 所选模型支持时就声明图片输入；设 `false` 强制纯文本 |
| `contextWindow` | number | `131072` | 池子里没描述上下文的 id 所假定的窗口 |
| `maxTokens` | number | `0` | 向 DSH 声明的输出上限；`0` = 不声明，交给 provider |
| `timeoutMs` | number | `600000` | 单次尝试超时（毫秒）；`0` = 不超时 |
| `includeFusion` | boolean | `true` | gateway：是否提供网关的 `fusion` 路由 |
| `exposeDiscoveredModels` | boolean | `true` | gateway：是否把 `GET /v1/models` 合并进选择器 |
| `discoveryTimeoutMs` | number | `5000` | gateway：该发现请求的超时 |
| `discoveryCacheMs` | number | `60000` | gateway：发现结果的新鲜期 |
| `maxTokensField` | `max_tokens` \| `max_completion_tokens` | `max_tokens` | 哪个 wire 字段承载上限。`max_tokens` 是规范字段；网关也接受另一个 |
| `headers` | map | `{}` | 附加请求头。`user-agent`、`authorization`、`content-type`、`accept` 为保留头 |
| `taskType` | `''` \| `auto` \| `code` \| `chat` | `''` | gateway：可选的 `X-FreeLLM-Task-Type` 提示（留空则不发该头） |
| `cacheMode` | `''` \| `on` \| `off` | `''` | gateway：可选的 `X-FreeLLM-Cache` 开关（留空则不发该头） |

### `providers.<id>` —— 覆盖池中某一家

| 键 | 含义 |
|---|---|
| `enabled` | 打开/关闭某家。默认关闭的十三家就是靠这个启用 |
| `displayName` | 选择器与日志里的显示名 |
| `baseURL` | 端点根地址——不用等发版就能修主机名（见 `zhipu`） |
| `apiKeyEnv` | 你给这家起的凭据引用名 |
| `apiKey` | 这家的内联凭据（会存进 profile patch——优先用 `apiKeyEnv`） |
| `keyless` | 把自建端点标成"无需凭据可用" |
| `models` | **整份替换**该家的内置模型列表。每项：`id`、`name`，以及 `capability` / `speed`（1–5）、`contextWindow`、`maxTokens`、`vision`、`toolCalling`——可以直接写在条目上，也可以放在 `caps` 里 |

完全不在内置池里的 provider 同样这样加：给它 `id`/`baseURL` 和一个 `models` 列表
（见[添加 key](#添加-key)）。

### `routing` —— 引擎旋钮

| 键 | 默认值 | 含义 |
|---|---|---|
| `maxAttempts` | `6` | 单个请求最多试几个候选 |
| `budgetMs` | `45000` | 故障转移总时间预算；`0` = 不限 |
| `contextSafetyFactor` | `1.15` | 上下文闸门的安全裕度：候选必须满足 `contextWindow >= 估算 token × 该系数`。token 估算是启发式的、**偏低**，所以宁可保守一个模型，也不要用上游的 400 换。小于 `1` 的值会被拒绝并改用默认值 |
| `thresholds.medium` | `0.34` | 分数到多少就从 `simple` 变 `medium` |
| `thresholds.complex` | `0.67` | 分数到多少就从 `medium` 变 `complex` |
| `weights` | 逐档默认 | `{capability, speed}`，或 `{simple: {…}, medium: {…}, complex: {…}}` |
| `preferredOrder` | `[]` | 你希望优先的 provider id；最多 0.05 的有界加分 |

### 设置它们的三种方式

1. **设置页** —— **设置 → 插件 → dsh-freellmapi**（所有顶层字段；表单由静态导入的
   `@deepseek-ai/schemastery` 生成，该包同时声明在 `peerDependencies` 与 `devDependencies`）。
2. **profile patch** —— `$DSH_HOME/profiles/<profile>/cordis.patch.yml`，`providers` 与 `routing`
   推荐写在这里：

   ```yaml
   - id: freellmapi
     config:
       mode: direct
       logRouting: true
       providers:
         cerebras:
           enabled: true
         kilo:
           enabled: false        # 如果你不接受它的训练记录条款
       routing:
         maxAttempts: 4
         preferredOrder: [cerebras, groq]
   ```

3. **环境变量** —— [添加 key](#添加-key) 里那些 `apiKeyEnv` 名字。

## 怎么看出它做了什么

**direct 模式**每个请求一行日志：

```text
dsh-freellmapi: tier=complex -> openrouter/nvidia/nemotron-3-ultra-550b-a55b:free (capability=5, speed=3, 2 candidates tried)
dsh-freellmapi: tier=simple -> no candidate (0 candidates tried)
```

**gateway 模式**保持它原来的那一行：

```text
dsh-freellmapi: routed via groq/llama-3.3-70b (model=auto) fallback-attempts=2 trail=groq/… key1=rate_limited; …
```

插件还会在进程内保留最近 50 条路由记录——以 `getRecentRoutes()` 导出（配套
`formatDirectRouteLine()` / `formatRouteLine()`），供测试与将来的界面使用。每条记录带着档位、分数、
最终 provider/模型、每一次尝试及其错误码、被淘汰的候选与原因，以及分类器的理由。它不是 DSH 工具也
不是服务，所以日常请以日志行为准。

## 只配一家？一家都不配？

**一家都不配：** 能用，靠 `kilo` 与 `llm7`（两家都默认启用且免凭据）。这时"按复杂度选型"退化成在两
家的模型之间挑——仍然是真实的路由、仍然能故障转移，但可选面窄得多。

**只配一家：** 能用，分类器照跑——但只有一家的模型时，排序退化成了"在这家里挑最适合本档位的模型"。
**至少两家**才有东西可"路由"。

**不会发生的事：** 缺 key 永远不是错误。没有可用凭据的 provider 会被静默移出**路由候选**——没有警告、
没有"配置不完整"的提示；而在模型列表里，它会以一条 `setup:<provider>` 路牌出现，而不是一排打不通的
模型行（见[模型列表怎么读](#模型列表怎么读)）。这是刻意的：在什么都没配的机器上，免凭据池必须还能工作。

## 架构

```text
┌───────────────────────────── DeepSeek Harness（宿主进程） ───────────────────────────────┐
│                                                                                          │
│  agent loop / 一轮对话                                                                   │
│       │                                                                                  │
│       ▼                                                                                  │
│  llm service (ctx.llm)     按 GenerateOptions.provider 选路由                            │
│       │                                                                                  │
│       ▼                                                                                  │
│  LlmAdapter  (this plugin, provider = "freellmapi")                                      │
│       │                                                                                  │
│       │  模型 id 决定走哪条车道：                                                        │
│       │    auto            → 先分类                                                      │
│       │    auto:simple     → 强制快车道                                                  │
│       │    auto:medium     → 强制均衡档                                                  │
│       │    auto:complex    → 强制最强档                                                  │
│       │    provider/model  → 钉死一个候选（严格：不替换）                                │
│       ▼                                                                                  │
│  scoreComplexity()  →  simple / medium / complex  +  分数  +  理由                       │
│       │                                                                                  │
│       ▼                                                                                  │
│  listProviderModels()  →  rankCandidates()                                               │
│       │      硬门槛：视觉 · 工具 · 上下文窗口 · 冷却                                     │
│       │      软惩罚：连续失败 · 延迟 · 偏好顺序                                          │
│       ▼                                                                                  │
│  dispatchWithFailover()    尝试 1 ─▶ 429 / 5xx / model_unavailable / 超时                │
│       │                        └─▶ 停车，取下一名 ─▶ 尝试 2                              │
│       │                                                                                  │
│       │  ══════════════════════════════════════════════════════════════════════          │
│       │  第一个 chunk 到达 DSH                                                           │
│       │    越过这条线就不再换家：流中途失败以错误收尾，                                  │
│       │    而不是把两个模型拼成一条回答                                                  │
│       ▼                                                                                  │
│  StreamChunk sequence → DSH                                                              │
│                                                                                          │
└──────────┬───────────────┬───────────────┬───────────────┬───────────────┬───────────────┘
           ▼               ▼               ▼               ▼               ▼
     ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐
     │ groq       │  │ cerebras   │  │ openrouter │  │ kilo       │  │ llm7       │
     └────────────┘  └────────────┘  └────────────┘  └────────────┘  └────────────┘
   kilo 与 llm7 不需要任何 key 就能答      ·      池子共 18 家
```

接口边界上的几点：

- **每一个**出站请求都带 DSH 的归因 `user-agent`，并使用 `redirect: 'error'`，重定向绝不可能把凭据
  泄漏到第三方主机。
- 凭据**逐请求解析**（每家一次查询，不是每个模型一次），且从不缓存。
- `stream()` 永不抛错。所有失败都是带内 `finish` chunk——这正是本插件对"模块身份分裂"免疫的原因，
  见[故障排查](#故障排查)第 6 条红线。
- 零运行时依赖：完全没有 `dependencies`，DSH 的 LLM 运行时用带保护的动态 import 解析，解析不到时
  降级到本地 shim。

## 故障排查

### 1. `401` / `403`——某家拒绝了 key

只影响这一家；路由器给它停车（`invalid` ⇒ 冷却 24 小时）并用下一个候选继续。检查：

- key 是否以 `apiKeyEnv` 的确切名字导出（默认名见[添加 key](#添加-key)）？如果你的 shell 里已经有
  别的命名习惯，可以逐家覆盖。
- 这家是否还要求别的东西——注册、实名，或者特定站点（`zhipu` 是典型：国内站与海外站的 key 不互通）？
- 空字符串等于"未配置"，所以"导出了但为空"和"没导出"表现完全一样。

### 2. `429`——被限流了，接下来会怎样

免费池里这是常态天气，不是故障。该候选在**第一次失败时立刻**停车，继续失败则逐级升档
（`2 分钟 → 10 分钟 → 1 小时 → 24 小时`），provider 给了 `Retry-After` 就以它为准；本次请求则由下一名
候选继续。缓解手段：再加一家的 key、降低并发，或用 `preferredOrder` 把流量引到还有额度的池子上。

### 3. 所有候选都失败了——去哪看原因

终结 chunk 会说 `ALL_CANDIDATES_FAILED`，并带上轨迹：

```text
dsh-freellmapi: all 3 candidate(s) failed for tier=medium after 2 attempts — groq/qwen/qwen3.8-27b: RATE_LIMIT; …
```

如果是 `NO_CANDIDATES`，说明在发请求之前池子就是空的：什么都没配且没有启用免凭据家，或者所有候选都
被硬门槛挡掉（视觉 / 工具 / 上下文 / 冷却）。它的 message 里会列出申请 key 的入口。
`STREAM_INTERRUPTED` 表示输出已经发出去了，按设计不再换家。

### 4. 模型列表里只有 `auto`、几个档位和一些 `setup:` 条目

这正是零凭据下的预期形状：虚拟路由 + 真正可达的东西。出现 `setup:<provider>` 表示那一家已启用但拿不到
可用凭据——按它名字里的环境变量配好，再重新打开选择器即可。见
[模型列表怎么读](#模型列表怎么读)。

### 5. 我配好的某家被跳过了

缺 key ⇒ 静默移出路由候选，没有警告（列表里它会显示成 `setup:<provider>` 路牌）。另外检查：

- `enabled`——有十三家是**默认关闭**的（`github`、`mistral`、`zhipu`、`volcengine`、`longcat`、
  `nvidia`、`ovh`，加上 0.7.0 新增的 `modelscope`、`xfyun`、`siliconflow`、`sambanova`、`huggingface`、
  `routeway`），要在 `providers.<id>.enabled` 里打开。
- 硬门槛——没有 `vision: true` 的模型会被带图请求排除，`toolCalling: false` 的会被带工具请求排除，
  `contextWindow` 小于估算 prompt 的也会被排除。
- 冷却——刚失败过的候选正在停车；路由记录里的 `exclusions` 会明说（"cooling down for another Ns
  after …"）。

### 6. profile 行为异常或起不来（依赖红线）

**`@deepseek-ai/dsh-*` 绝不能出现在本插件的 `dependencies` 里。** 本包**零**运行时依赖，甚至不在模块
顶层静态 import DSH 的 LLM 运行时：它用带保护的动态 import 解析 `@deepseek-ai/dsh-llm`，解析不到时
降级到本地 shim。唯一声明的 peer 是可选的 `@deepseek-ai/cordis`。

为什么这事重要：DSH 是通过**文件系统 junction** 提供运行时的——
`$DSH_HOME/profiles/node_modules/<包名>` 指向 `npx` 安装缓存
（`…\npm-cache\_npx\<hash>\node_modules\…`）。插件一旦把比如 `@deepseek-ai/dsh-llm` 声明成普通依赖，
包管理器就会把**第二份副本**提升进 `profiles/<profile>/node_modules/@deepseek-ai/`，而它在模块解析时
优先。类身份随之跨副本崩掉：`instanceof` 失败、错误码静默降级、服务缺失。版本区间让情况更糟——npm 上
的 `@deepseek-ai/dsh-llm` 只有 `0.0.1-rc.x`–`0.1.x`，远低于本插件面向的 `0.2.0-rc.2` 运行时。

健康检查——profile **自己的** scope 里除了 `cosmokit` 与 `schemastery` 不该有别的：

```powershell
Get-ChildItem "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@deepseek-ai"
```

多出任何东西（`dsh-llm`、`cordis`、别的 `dsh-*` 适配器）都是泄漏依赖。在 profile 目录里用
`pnpm why @deepseek-ai/dsh-llm` 找到是谁拉进来的，去掉它，重装，重启。

### 7. `400 model_unavailable` 反复出现

那是聚合器的目录漂移（LLM7 会轮换模型），不是安装坏了。它与 `404 model_not_found` 同义：这个
`(provider, model)` 组合会被**停车**（从 2 分钟那一档开始），接着由下一名候选服务本次请求。如果某个
模型持续如此，把它从该家的 `models` 列表里删掉，或 `providers.<id>.enabled: false`。

### 8. 我选了具体模型，却报 `MISSING_CREDENTIAL`

**这是有意行为**——就是[钉模型是严格模式](#钉模型是严格模式)里说的严格钉模型。具体模型 id 要的是
**那一个**模型，所以当它的 provider 没有凭据时，插件宁可直接拒绝，也不会偷偷换一家来答。message 里会
点名确切的环境变量与免费申请地址。两条出路：

- 配好那个变量（或在 DSH 设置页粘贴 key），再发一次；或者
- 选 `auto`，它会用现在就不需要任何 key 的那些家。

### 9. `UNKNOWN_MODEL`

你要的 id 池子里没有任何一家提供。message 会列出最接近的三个 id，并告诉你所用的 provider 前缀是否只是
被默认关闭了。常见原因：拼错；从某家自己的文档里抄来的、并不在本池里的 id；或者该家默认关闭
（`github`、`mistral`、`zhipu`、`volcengine`、`longcat`、`nvidia`、`ovh`，加上 0.7.0 新增的六家）——
先在 `config.providers.<id>` 里打开它。如果你只是想要一个答案，用 `auto`。

钉住的模型存在、只是正在冷却时报的是 `MODEL_UNAVAILABLE`，并附上每个候选的排除原因；用 `auto` 或等
冷却结束都可以。

## 限制与未验证项

直说清楚，你好知道自己依赖的是什么：

1. **复杂度分类器是启发式，不是理解。** 它数 token、围栏代码、工具 schema 和词。
   [它什么时候会判错](#它什么时候会判错以及你怎么覆盖)里给了本实现的三个真实误判。你更清楚时，直接钉
   `auto:simple` / `auto:medium` / `auto:complex`，或钉一个 `provider/model`。
2. **没有对真实 provider 跑过端到端。** 本仓库所有测试都跑在进程内的 mock provider 上——这是刻意的，
   为的是 CI 离线可跑。真正发出的外部请求只有维护者那次免凭据探针（5 个请求，4 个 200，1 个 404，
   记录在 `_lead/live-probe-2026-10-13.md`），加上上面可达性一节背后的免凭据可达性与目录探测
   （`_lead/research/reachability-v0.7.md`，2026-10-15）。**从未用真 key 请求过一次补全**，所以其余一切
   ——每一家有 key 的 provider、每一个额度数字、除公开目录发布之外的每一个模型 id——都是**文档级证据**，
   不是实测。
3. **只发过免凭据请求。** `groq`、`cerebras`、`openrouter`、`github`、`mistral`、`nvidia` 等等都是在**不带
   凭据**的情况下被访问的（只取状态码与公开目录，从不请求补全），它们的 `baseURL` 与模型 id 来自上游
   registry 与迁移脚本。限流数字是 2026-04 的基线，会漂移。
4. **`zhipu` 是池子里风险最高的一项**，`volcengine` / `longcat` 的模型 id 是推断的——这三家都以
   `confidence: 'speculative'` **默认关闭**。启用它们等于你接受该风险。`zhipu` 的主机名在国内站与
   海外站不同且 key 不互通：选错主机名必然 401。
5. **免费目录会漂移。** 同一个模型 id 今天 200、明天可能就 `400 model_unavailable`。路由器把它当作
   逐模型状态处理（停车 + 换下一名），所以是降级而不是失败——但这是正常现象，不是 bug。
6. **`stream_error` 帧的形状只有文档级证据。** 上游没有钉死它的 JSON 形状，所以解析器识别四种可能
   形态（`type`、`code`、`object`、嵌套 `error`），并把任何"像错误"的帧当作终结性失败。
7. **图片链路没有在真实 attachments 服务上验证过。** 字节读取走 `attachments.imageHostPath()`——适配器
   能拿到字节的唯一文档化入口；如果你的构建里该服务形状不同，受影响的每张图都会降级成占位文本，请求
   仍然成功。默认池里只有两个模型声明 `vision: true`。
8. **`GenerateOptions` 的 `sessionId` / `purpose` 未做映射**——Chat Completions 没有二者的标准字段。
9. **健康状态不持久化。** 冷却只活在进程内；重启后被停车的 provider 会被重试一次。`HealthTracker` 能
   往返序列化自己的状态，但没有任何代码把它写进磁盘。
10. **故障转移后的答案来自另一个模型。** 第 1 名失败时由第 2 名作答，而它们是不同的模型。这很安全
    （此时什么都没发出去），并且完整记录在路由记录的 `attempts` 里，但答案不是排名最高那个模型给的。
11. **`nvidia` 需要 `parallel_tool_calls: false`。** 部分 NIM 模型拒绝并行工具调用，池条目已声明该标志，
    并且会真的写进请求体。NVIDIA 仍默认关闭（试用版 ToS、首字节可能要几分钟、限流紧）。
12. **`routing.weights` / `routing.thresholds` 是高级字段**，设置页里没有渲染表单（它们是 `z.any()`
    载荷）。请在 profile patch 里改。
13. **v0.1.0 那轮验证遗留项的现状**（已按本实现重新核实）：`maxTokens` 超过
    `Number.MAX_SAFE_INTEGER` 时，`resolveModel()` 仍会返回 DSH 拒收的元数据
    （`INVALID_MODEL_MAX_TOKENS`）；`role: "user"` 且 `content` 为纯字符串的消息仍会被发成空内容；
    gateway 模式下 `includeFusion: false` 仍可能被网关自报的 `fusion` 抵消；`discover()` 仍可能返回重复
    id（DSH 会去重）。`L1`——失败码清单不全——已修。

### 上下文窗口：哪些是实测、哪些是估计

每个模型的 `contextWindow` 决定这个请求**要不要发**（见[请求本身实在太大时](#请求本身实在太大时)），
所以数字错了会**两头都伤人**：报大了，路由器会挑一个必然拒绝你的模型；报小了，一个本来装得下的模型在
发出第一个字节之前就被筛掉了。

`kilo` 这四家恰好就是两个方向都错，已于 2026-10-14 按 kilo 自己的 `GET /api/gateway/models` 更正：

| 模型 | 修前 | 修后（实测） |
|---|---|---|
| `kilo/nvidia/nemotron-3-super-120b-a12b:free` | 1 000 000 | **262 144** |
| `kilo/nvidia/nemotron-3-ultra-550b-a55b:free` | 131 072 | **1 000 000** |
| `kilo/poolside/laguna-s-2.1:free` | 131 072 | **262 144** |
| `kilo/cohere/north-mini-code:free` | 131 072 | **256 000** |

**池里其余各家的 contextWindow 要么是目录读数、要么是估计。** 那些家的 `GET /v1/models` 在没有凭据时
一律 `403`，而 OVH 的端点虽然回 `200`，却**根本不发布** context 字段。`lib/providers.js` 里每个条目的
`source` 注明了它的数字从哪来、什么时候来的——凡是没有写 "measured" 的，都请当作估计值。实测行包括
`llm7` 的两条（端点发布 `context_window.tokens`）、`sambanova` 的四条与 `routeway` 的四条
（`context_length`，两份目录均于 2026-10-15 匿名抓取——其中两条 `routeway` 的 `:free` 路由声明的是
**42 000**，而不是它 `:free` 家族其余成员声明的 62 000），以及 `huggingface` 的两条：它的数字是**选定的
那个后端**的 `context_length`，**刻意不取最大值**。0.7.0 新增且默认关闭的六家里，其余都是保守默认值：
`modelscope` 的目录**根本没有** context 字段，而 `xfyun` 与 `siliconflow` 的目录需要一把这里没有的凭据。

如果你的环境里某家报出的窗口不同，逐模型覆盖即可，不用改代码：

```yaml
providers:
  groq:
    models:
      - id: qwen/qwen3.8-27b
        name: Llama 3.3 70B
        capability: 4
        speed: 5
        contextWindow: 131072     # 你的数字说了算
        toolCalling: true
```

## 兼容性

| 组件 | 支持情况 | 说明 |
|---|---|---|
| DeepSeek Harness 运行时 | `0.2.0-rc.2`（针对它编写并核对） | 其它 `0.2.0-rc.x` 大概率可用；只用了稳定的 LLM seam API |
| Node.js | `>= 22` | 与参考 DSH 插件的声明一致 |
| Provider API | OpenAI 兼容的 `POST {baseURL}/chat/completions` + SSE | 池子里每一家说的都是同一种 wire |
| `dsh-freellmapi` | `0.7.8` | 零运行时依赖；DSH 的 LLM 运行时在加载时解析；peer 为 `@deepseek-ai/schemastery`（配置 schema）与可选的 `@deepseek-ai/cordis` |
| freellmapi 网关 | `v0.13.x` 协议面 | 仅在 `gateway` 模式下相关 |

> 版本号提醒：上游网关的 release 是 `v0.13.x`，而提供 `setup-dsh` 的 npm CLI 包 `freellmapi` 是独立
> 编号的（例如 `0.8.1`）。不要把两个数字当成同一条版本线。

## 开发

```bash
npm test          # 离线测试套件——不需要外网、不需要真实 provider、不需要 API key
```

测试套件刻意做成密闭的：必须能在干净的 GitHub runner 上通过，所以它绝不访问真实的 provider。CI 在
`ubuntu-latest` + Node 22 上跑同一条命令（`.github/workflows/ci.yml`）。

```text
dsh-freellmapi/
├── lib/
│   ├── index.js        # 插件入口：apply()、适配器、listModels/resolveModel/stream
│   ├── config.js       # 配置 schema 与全量归一化（DEFAULTS 是权威）
│   ├── providers.js    # 内置池 + 逐家覆盖 + 凭据解析
│   ├── complexity.js   # 分类器：信号、权重、阈值
│   ├── router.js       # 纯函数候选排序（门槛、健康度、延迟、偏好顺序）
│   ├── health.js       # 冷却、失败计数、延迟 EWMA
│   ├── dispatch.js     # 单家尝试 + 故障转移循环
│   ├── wire.js         # GenerateOptions → OpenAI 兼容请求
│   ├── sse.js / frames.js / translate.js   # SSE → DSH StreamChunk
│   ├── errors.js / routes.js / catalog.js / runtime.js / types.js
├── tests/              # 离线测试（411 个）
├── tools/gate.mjs      # 项目自检门 —— 一个命令、一个结论（npm run gate）
├── docs/               # EXPANSION-v0.7.md（任务书）· NEW-SESSION.md（新会话引导词）
├── IMPLEMENTATION.md   # 设计说明，含每一处刻意偏离
├── PROJECT-RULES.md    # 操作手册：PDCA 循环、八条硬规则、教训账本
├── README.md / README-zh.md / CHANGELOG.md / NOTICE / LICENSE
└── .github/workflows/ci.yml
```

## 上游与致谢

本插件是 **[freellmapi](https://github.com/tashfeenahmed/freellmapi) 的衍生作品**（Copyright © 2026
Tashfeen Ahmed，MIT）。把这件事说清楚很重要，因为本 README 此前的版本**只在"gateway 模式可以转发到的
那个外部网关"这个语境里**提到该项目——读起来像是本插件与它无关。事实不是：

- **`lib/providers.js` 的 provider 目录**转录自 freellmapi 自己的源码——`providers/index.ts`、
  `server/src/db/migrations/20260101_000000_legacy_baseline.ts`、`docs/en/providers/*`。每个条目都带
  `source:` 或 `note:` 字段，写明它来自哪个上游文件与行号；那些引用就是这次衍生的溯源记录。
- **`lib/health.js` 的故障转移与冷却策略**沿用 freellmapi 自己的升级阶梯。
- **路由模型本身**——给请求打分、按档位选家、跨家故障转移——是 freellmapi 的设计。

**没有**衍生的部分：本包没有内嵌任何上游文件（上游是 TypeScript，本包是纯 JavaScript，两者不共享任何
文件）；DSH 集成部分——适配器、provider 路由、配置 schema、浏览器半侧——是本包自己按 DSH 插件契约写的。
`apiKeyEnv` 命名是本包的约定：DSH 按引用名解析凭据，每家都需要一个稳定名字。

上游的 MIT 版权声明与许可原文完整收录在 [`NOTICE`](./NOTICE)，并按许可要求随包分发。

## 许可证

[MIT](LICENSE) © 2026 lion231226 —— freellmapi 的衍生作品，详见 [`NOTICE`](./NOTICE)。

与池中任何 provider、与 freellmapi 项目、与 DeepSeek 均无隶属关系，也未获其背书或支持。各 provider
名称归其所有者；"DeepSeek Harness" 与 `@deepseek-ai/*` 归 DeepSeek。免费档有自己的额度、条款与隐私
政策，遵守它们是你的责任——其中几家会记录甚至训练你发送的内容。上游自述为"personal experimentation
only"，部署任一项目前请阅读其自身条款。





