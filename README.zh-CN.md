# dsh-freellmapi

**把 [freellmapi](https://github.com/tashfeenahmed/freellmapi) 的 Auto 智能路由接进
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。**

`dsh-freellmapi` 是一个 DSH 的 LLM 适配器插件：它把本机的 freellmapi 网关注册成 DSH 的
provider 路由 `freellmapi`，把路由器提供的 `auto` / `auto:<策略>` 模型摆进 DSH 的模型选择器，
回报每一次请求**究竟是哪家上游在服务你**，并让模型列表跟着运行中的路由器实时更新。

```text
DSH  ──▶  provider "freellmapi"  ──▶  POST http://localhost:3001/v1/chat/completions
                                        { "model": "auto", "stream": true }
                                      ──▶  freellmapi 路由器  ──▶  ~34 家 provider
```

> ### 非官方插件，请先读这一段
>
> 这是一个社区作品。它与 freellmapi 项目、与 DeepSeek 官方**均无隶属关系**，未获其背书、
> 赞助或支持；它既不是 freellmapi 的官方客户端，也不是 DSH 的官方插件。
> "freellmapi" 与 "DeepSeek Harness" 的权利归各自所有者。本项目采用
> [MIT 许可证](LICENSE)。

> ### 你真的需要这个插件吗？
>
> **如果只是想用上 Auto 模式，多半不需要。**
> freellmapi 官方自带零插件的 DSH 接入方式：
>
> ```bash
> npx freellmapi setup-dsh --url http://localhost:3001 --api-key <unified-key>
> ```
>
> 它把网关写成 `$DSH_HOME/settings.yaml` 里的一条 `llm-pi-ai` route，把密钥写进
> `$DSH_HOME/.env`（权限 `0600`），并顺手设好默认模型——全程不需要任何插件。
> 由于它的模型清单来自实时 `GET /v1/models` 的响应，而该响应显式包含 `auto`、`fusion` 与
> 每条具名链的 `auto:<profile>` 行，**所以官方路径本来就能在 DSH 模型选择器里选到它们**。
> 本插件是官方路径的**可选替代/增强，不是必需品**。建议先看
> [与官方 `setup-dsh` 的关系](#与官方-setup-dsh-的关系)，再自行取舍。
>
> **一条硬约束**：两条路径注册的是同一个 DSH provider 路由名（`freellmapi`），因此**不能同时
> 启用**。如果你已经跑过 `setup-dsh`，请先移除它那条 `freellmapi` 路由，或者干脆不装本插件。

---

## 目录

- [本插件带来的增量](#本插件带来的增量)
- [与官方 `setup-dsh` 的关系](#与官方-setup-dsh-的关系)
- [前置条件](#前置条件)
- [安装](#安装)
- [配置](#配置)
- [使用 Auto 模式](#使用-auto-模式)
- [架构](#架构)
- [故障排查](#故障排查)
- [卸载](#卸载)
- [兼容性](#兼容性)
- [开发](#开发)
- [限制与未验证项](#限制与未验证项)
- [本文所述内容的核实方式](#本文所述内容的核实方式)
- [许可证](#许可证)

## 本插件带来的增量

只有四条，没有别的。四条都围绕**可观测性与使用体验**，而不是"能不能连上网关"——后者官方
配置方式已经解决了。

| # | 增量 | 为什么有用 |
|---|---|---|
| 1 | **`X-Routed-Via` 可见**。freellmapi 的每个响应都带 `X-Routed-Via: <platform>/<model>`，这是唯一能告诉你"这次请求实际由哪家 provider 的哪个模型服务"的头。本插件读取它并写进 DSH 日志（由配置开关控制）。DSH 里通用的 `openai-completions` pi-ai 路径不会把上游响应头透出来，在那种路径下"到底是谁答的"始终是黑盒。**这一条是基于适配器设计的判断，不是对 pi-ai 内部实现的实测结论。** | 用了 Auto 模式，就是让路由器替你挑；知道它挑了什么，才是重点。 |
| 2 | **freellmapi 专有错误被翻译成可操作的提示**。未知的 `auto:<profile>` 名是上游 `400`；配额耗尽 / 限流是上游 `429`（若是**月度预算**耗尽，还会带 `Retry-After` 与 `error.code: "quota_exceeded"`）。插件把这些翻成"下一步该做什么"的提示，而不是甩你一句 `HTTP 429`。 | 你会直接看到"加把 key / 等到下个 UTC 月初 / 名字写错了"，而不是靠猜。 |
| 3 | **不动你的全局 DSH 配置**。`baseURL`、凭据引用名以及所有其它开关都在插件自己的配置里，不会往 `$DSH_HOME/settings.yaml` 或 `$DSH_HOME/.env` 写任何东西。 | 网关设置留在你能看见的地方，事后重跑 `setup-dsh` 也不会悄悄改掉本插件的端点。代价是真实的——见下一节：两条路径抢同一个 DSH 路由名，所以**只能启用其中一个**。 |
| 4 | **模型列表在运行期刷新**。模型来自运行中路由器的 `GET /v1/models`；你在 freellmapi 面板里接上一家新 provider，DSH 这边不用重跑 CLI 就能看到。 | 不用每次网关有变动就重新生成一份快照。 |

它**刻意不做**的事：不直连各上游 provider、不取代路由器、不代管 freellmapi 的 key，也不会
让 Auto 模式"从不可能变成可能"（网关与官方接入方式本来就做到了）。

## 与官方 `setup-dsh` 的关系

freellmapi 官方文档给出了一条**完全不需要插件**的一等 DSH 接入方式：

```bash
# 1. 先确认网关已经跑起来（见「前置条件」），然后：
npx freellmapi setup-dsh --url http://localhost:3001 --api-key <unified-key>

# 2. 照常启动 DSH：
npx @deepseek-ai/dsh web
```

它往 `$DSH_HOME`（默认 `~/.dsh`）写两份东西：

```yaml
# $DSH_HOME/settings.yaml
llm-pi-ai:
  providers:
    freellmapi:
      displayName: FreeLLMAPI
      apiKeyEnv: FREELLMAPI_API_KEY      # 真正的密钥在 $DSH_HOME/.env（0600）
      api: openai-completions            # 复用 DSH 自带的 pi-ai 适配器
      baseURL: http://localhost:3001/v1
      models:                            # 取自实时 GET /v1/models 目录
        - { id: auto, name: Auto (router picks the best available model), contextWindow: … }
        - { id: auto:smart, name: …, contextWindow: … }
        # … 以及目录里每一个具体模型
agent-default-model:
  provider: freellmapi
  model: auto
```

```dotenv
# $DSH_HOME/.env   （权限 0600）
FREELLMAPI_API_KEY=freellmapi-…
```

有三个结论必须讲清楚：

1. **官方路径本来就能用 Auto 模式。** `GET /v1/models` 显式列出了 `auto`、`fusion`，以及每条
   具名回退链对应的 `auto:<profile>` 行，`setup-dsh` 把这些写进 `models:`，DSH 的选择器自然
   就能选。**选 `auto` 不需要本插件。**
2. **官方路径是更稳妥的默认选择。** 它由上游维护、一条命令搞定、走的是 DSH 自带的适配器，
   而不是第三方代码。
3. **两条路径互斥。** 官方那条 route 是 `llm-pi-ai.providers.freellmapi`，它在 DSH 里的
   provider 名就是 `freellmapi`；本插件注册的 provider 路由也是 `freellmapi`。provider 路由名
   在一个 DSH 进程内唯一，所以后注册的那一方会被拒绝。如果你已经跑过 `setup-dsh`，请先移除它
   那条 `freellmapi` 路由再装本插件——或者保留官方路由、别装本插件。真弄错了也不会让你猜：
   插件会拒绝加载，并在错误信息里点名这处冲突。

那什么时候值得装本插件？

| | 官方 `setup-dsh` | 本插件 |
|---|---|---|
| 在 DSH 里可选 `auto` / `auto:<策略>` / `auto:<profile>` | ✅ 可以 | ✅ 可以 |
| 模型列表来源 | 配置时刻抓一次 `GET /v1/models` | 运行期抓 `GET /v1/models`，可刷新 |
| 谁在服务这次请求（`X-Routed-Via`） | ❌ 不透出 | ✅ 写进 DSH 日志（有开关） |
| freellmapi 专有 `400` / `429` 文案 | 通用适配器错误 | ✅ 已翻译 |
| 网关错误 / 回退轨迹可见性 | ❌ | ✅ 有则记录 |
| 是否改写 `$DSH_HOME/settings.yaml` / `.env` | ✅ 会（结构化合并 + 带时间戳备份） | ❌ 不会，配置留在插件里 |
| 能否与另一方同时启用 | ❌ | ❌ —— 两者都占用 DSH provider 路由 `freellmapi`，只能二选一 |
| 塞进 profile 的额外代码 | 无 | 一个第三方 bundle |
| 由谁维护 | freellmapi 项目 | 本仓库 |

**诚实的结论：本插件是官方路径的可选替代/增强，不是必需项。** 想要最小、最受上游支持的
方案，就用 `setup-dsh`；如果恰好需要"看见实际服务方"和"网关感知的错误提示"，本插件补的正是
这一块。

## 前置条件

| 项 | 说明 |
|---|---|
| **一个运行中的 freellmapi 网关** | 默认在 `http://localhost:3001` 可访问。OpenAI 兼容根地址 `http://localhost:3001/v1` 与面板（dashboard）共用这个端口。 |
| **统一 API key** | 形如 `freellmapi-…`，在网关面板的 **Keys** 页生成。这是**单个网关 key**，不是你某家上游的 key。 |
| **DeepSeek Harness** | 本插件针对运行时 `0.2.0-rc.2` 编写（见[兼容性](#兼容性)）。 |
| **Node.js** | `>= 22`（与 DSH 运行时及参考 DSH 插件的声明一致）。 |

### 把网关跑起来

上游仓库是这里的权威，官方支持两种形态：

```bash
# 上游推荐：克隆仓库后用自带的 compose 文件起服务
git clone https://github.com/tashfeenahmed/freellmapi.git
cd freellmapi
docker compose up -d
# 镜像：ghcr.io/tashfeenahmed/freellmapi:latest（多架构：amd64 + arm64）

# 或者直接从源码跑（server 与 dashboard 共用 :3001）：
npm run build && node server/dist/index.js
```

上游仓库的 `desktop/` 下还有桌面版构建，`docs/en/clients/01-agent-clients.md` 里有面向各
Agent 客户端的接入说明。

### 装插件之前，先确认网关是通的

```bash
curl -s http://localhost:3001/v1/models \
  -H "Authorization: Bearer freellmapi-<unified-key>" | head -c 400
```

应当返回 OpenAI 形状的 `{"object":"list","data":[…]}`，且开头几条包含 `auto` 与 `fusion`。
这一步不通就别往下装了——插件救不了一个不响应的网关。

只看"此刻能服务"的模型：

```bash
curl -s "http://localhost:3001/v1/models?available=true" \
  -H "Authorization: Bearer freellmapi-<unified-key>"
```

## 安装

有三条路，**选一条**即可。注意不要把 A/B 与 C 里那条手写 patch 行叠加使用，原因见本节末尾。

### 方法 A —— DSH 插件管理器（图形界面）

1. 打开 DSH Web GUI。
2. 进侧边栏的**插件**管理器（插件清单页）。
3. 用其中的**安装 / 添加**入口，粘贴下面任意一种 spec：
   - `dsh-freellmapi` —— npm registry 包名（包发布到 npm 之后可用）；
   - `github:lion231226/dsh-freellmapi` —— 直接从 GitHub 装，无需先发 npm；
   - `github:lion231226/dsh-freellmapi#v0.1.0` —— 钉到某个 tag 或提交。
4. 确认。管理器会替你调用 profile 的包管理器、把该包登记为 profile bundle；如果 DSH 提示，
   重启应用。

管理器接受 registry 包名、绝对本地路径、git 地址与 tarball URL，并且会**拒绝任何 manifest
里没有声明 `dsh.bundle` 的 spec**——本包声明了，所以它是被当作真正的 profile bundle 装进去，
而不是一条装了也白装的普通依赖。

### 方法 B —— `dsh plugin` 命令行

```bash
# GitHub spec
dsh plugin --profile desktop add github:lion231226/dsh-freellmapi

# npm spec（包发布之后）
dsh plugin --profile desktop add dsh-freellmapi

# 把 profile 里已经声明的依赖装齐（手工改过 package.json 之后用）
dsh plugin --profile desktop install
```

`add` 与 `install` 这两个子命令来自 DSH 运行时自己打印的错误文案
（`run 'dsh plugin --profile <name> install' if its dependency is not installed`、
`create it with 'dsh plugin --profile <name> add <package>'`）。把 `desktop` 换成你的 profile
名，也就是 `$DSH_HOME/profiles/` 下的那个目录名。

> ⚠️ **本仓库没有做过端到端验证。** 子命令名取自 DSH 运行时的原始文案，而不是在真实 profile
> 上跑过的结果。动手写脚本前请先用你的 DSH 版本确认命令表面；拿不准就用方法 A。

直接手敲包管理器命令**不能**替代 `dsh plugin add`：在 profile 目录里 `pnpm add`（或
`npm install`）只会把包装进 `node_modules`，不会把它登记为 profile bundle，于是 DSH 只把它
当普通依赖加载，模型列表里什么都不会出现。真要手工装，请把方法 C 也做完。

### 方法 C —— 手工放置

适用于内网/离线机器、正在本地改的 checkout，或者你就是想看清到底改了哪些地方。

1. 把构建好的包放到：

   ```text
   $DSH_HOME/profiles/<profile>/node_modules/dsh-freellmapi/
   ```

   （本地 checkout 也可以做成链接而不是拷贝——参考 DSH 插件用的就是
   `"file:node_modules/<包名>"` 这种写法。）

2. 在 `$DSH_HOME/profiles/<profile>/package.json` 里登记它，**两处都要改**：

   ```jsonc
   {
     "dependencies": {
       "dsh-freellmapi": "file:node_modules/dsh-freellmapi"
     },
     "dsh": {
       "profile": {
         "bundles": [
           "@deepseek-ai/dsh-base",
           "@deepseek-ai/dsh-web-app",
           "dsh-freellmapi"            // ← 少了这一行，包永远不会被加载
         ]
       }
     }
   }
   ```

3. 把依赖落实到位，然后重启 DSH：

   ```bash
   dsh plugin --profile desktop install
   ```

为什么两处都要：运行时组合 loader 树时走的是 `dsh.profile.bundles`，而 `dependencies` 决定
这个包**能不能被解析到**。装上了但没进 `bundles`，会被静默忽略；列在 `bundles` 里却没装，
启动时会报"这个 bundle 解析不了"。

**插件自带的 patch 文件**（在包内，不需要你写）是一个顶层 YAML 数组，也是"正确安装的
bundle 不需要手写 patch 行"的原因：

```yaml
# node_modules/dsh-freellmapi/cordis.patch.yml
- insert:
    - id: freellmapi            # loader entry id 同时也是设置命名空间 id
      name: 'dsh-freellmapi'    # 必须能从 profile 解析到
```

> ⚠️ **只有当你"装了包但没登记成 bundle"**（也就是跳过了上面第 2 步的 `bundles` 那行）时，
> 才需要在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 里自己插入这一行：
>
> ```yaml
> - insert:
>     - id: freellmapi
>       name: 'dsh-freellmapi'
> ```
>
> **千万不要两边都写。** bundle 自己 insert 了一行，你又手写一行同样的 `id`，组合出的树里
> 就会出现两个同 id 的 entry，DSH 会以 `duplicate loader entry id "freellmapi"` 拒绝启动该
> profile。这是真实发生过的故障，也是推荐走图形界面安装的原因。

### 安装后自检

1. 插件管理器里能看到 `dsh-freellmapi`，且处于启用状态。
2. **设置 → 模型**里出现 **FreeLLMAPI (Auto)** 这条 provider 路由（插件把它注册为可配置 provider，
   所以还没填 key 时也应当可见）。
3. 模型选择器里能选到 `auto` 以及至少一个 `auto:<策略>`。
4. 选 `auto` 发一句话，返回的是文本，而不是 `MISSING_CREDENTIAL`。

第 2、3 步不成立时，见[故障排查](#故障排查)。

## 配置

插件的配置 schema 同时就是它的设置页，所以下表每个字段都可以在图形界面
（**设置 → 插件 → dsh-freellmapi**）里改，也可以在 profile 的 patch 文件里覆盖。所有字段都是
实时的：改完下一次请求就生效，不用重启，也不会重新注册。

| 字段 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `baseURL` | string | `http://localhost:3001/v1` | 网关的 OpenAI 兼容根地址。插件在其后拼 `/chat/completions` 与 `/models`，结尾多余的 `/` 会被去掉。不是合法 `http(s)://` 地址时直接退回默认值，而不是留到 `fetch` 里才炸。 |
| `apiKeyEnv` | string | `FREELLMAPI_API_KEY` | 凭据的**引用名**——环境变量名或凭据存储键，**不是**密钥本身。 |
| `apiKey` | string（secret） | `''` | 可选的内联凭据。建议留空、改用 `apiKeyEnv`：填在这里的值会以明文形式存进 profile 的 patch。 |
| `maxTokensField` | `max_tokens` \| `max_completion_tokens` | `max_tokens` | 用哪个 wire 字段承载输出上限。`max_tokens` 是规范字段（也是 freellmapi 文档里声明的那个）；网关同样接受 `max_completion_tokens`，两者都有时以 `max_tokens` 为准，所以只有某个模型明确要求时才切到后者。 |
| `logRoutedVia` | boolean | `true` | 是否逐请求记录上游的 `X-Routed-Via`，以及存在时的 `X-Fallback-Attempts` / `X-Fallback-Trail`。 |
| `includeFusion` | boolean | `true` | 是否在模型选择器里提供网关的 `fusion` 路由（一组模型作答 + judge 汇总）。 |
| `exposeDiscoveredModels` | boolean | `true` | 是否把 `GET /v1/models` 的结果与虚拟 `auto:*` 路由一起列进选择器。 |
| `vision` | boolean | `true` | 是否声明支持图片输入，让 DSH 真的把附件当图片发出去，而不是替换成文本。纯文本链可以设为 `false`。 |
| `contextWindow` | number | `131072` | 网关没有描述上下文的那些路由所假定的上下文窗口（用于压缩预算）。 |
| `maxTokens` | number | `0` | 向 DSH 声明的默认输出上限。`0` 表示不声明，交给网关与上游模型决定。 |
| `timeoutMs` | number | `600000` | 单请求超时（毫秒）；`0` 表示不超时。超时会以 `TIMEOUT` 失败收尾。 |
| `discoveryTimeoutMs` | number | `5000` | `GET /v1/models` 发现请求的超时。 |
| `discoveryCacheMs` | number | `60000` | 一次成功的模型发现结果保持新鲜多久。 |
| `headers` | map | `{}` | 附加请求头。`user-agent`、`authorization`、`content-type`、`accept` 为保留头，不可覆盖。 |
| `taskType` | `''` \| `auto` \| `code` \| `chat` | `''` | 可选的 `X-FreeLLM-Task-Type` 提示，用于偏置路由（`code` 用速度换智能）。留空则不发这个头；上游的 `fastest`/`reliable` 链会忽略它。 |
| `cacheMode` | `''` \| `on` \| `off` | `''` | 可选的 `X-FreeLLM-Cache` 开关，控制网关的精确匹配响应缓存。留空则不发这个头。 |

> 当宿主能解析到 `@deepseek-ai/schemastery` 时（DSH profile 里通常都能），设置表单由 schema 自动
> 生成。解析不到时插件依然照常加载并按上表默认值运行，只是没有自动生成的表单，此时请改用 profile
> patch 配置。任何非法配置值都不会导致插件加载失败。

### 给 `baseURL` 和密钥的三种方式

**方式 1：DSH 设置页（推荐）。** 打开**设置 → 模型**（或**设置 → 插件**里本插件自己的卡片），
填两项：

- `baseURL` → `http://localhost:3001/v1`（或你的远程网关地址）；
- 密钥 → 把 `freellmapi-…` 粘进该路由的凭据输入框。DSH 会通过凭据服务把它存在 `apiKeyEnv`
  指定的名字下；插件**每次请求都重新解析一次**，所以轮换密钥不需要重启。

**方式 2：环境变量。** `FREELLMAPI_API_KEY` 就是默认的引用名，所以这样写完全不用改配置：

```bash
# PowerShell（当前会话）
$env:FREELLMAPI_API_KEY = "freellmapi-…"

# bash / zsh
export FREELLMAPI_API_KEY="freellmapi-…"

# $DSH_HOME/.env —— DSH 会把它作为用户环境层加载，因此不必 export。
# 请保持该文件私密（官方 setup-dsh 就是以 0600 权限写它的）。
FREELLMAPI_API_KEY=freellmapi-…
```

如果你改了 `apiKeyEnv`，插件就按那个名字去找，找不到时仍会回落到 `FREELLMAPI_API_KEY`。端点
本身也有自己的逃生门：

```bash
FREELLMAPI_BASE_URL=http://192.168.1.20:3001/v1
```

`FREELLMAPI_BASE_URL` **只在 `baseURL` 还是内置默认值时**才生效，所以显式配置永远优先于环境
变量。

密钥本身按下面的顺序、在**每次请求**时解析：

1. DSH **凭据服务**中 `apiKeyEnv` 指定的名字（该服务自身又分层于进程环境、它管理的存储以及
   `$DSH_HOME/.env`）；
2. 插件自己的内联 `apiKey` 设置（如果你填了）；
3. **进程环境**：先是 `apiKeyEnv` 指定的名字，然后是 `FREELLMAPI_API_KEY`。

每一步里**空值都等于"没配"**，与变量不存在完全等价；此时插件会报 `MISSING_CREDENTIAL`，并
告诉你它找的是哪个引用名。因为解析发生在每次请求上，轮换密钥后下一次调用即生效，不用重启。

**方式 3：profile 的 patch 文件。** 不改全局设置文档，只在
`$DSH_HOME/profiles/<profile>/cordis.patch.yml` 里覆盖插件配置：

```yaml
- id: freellmapi                 # bundle 的 patch 插入的那个 loader entry id
  config:
    baseURL: http://localhost:3001/v1
    apiKeyEnv: FREELLMAPI_API_KEY
    logRoutedVia: true
```

这是 profile 自己的 patch 层，**在所有 bundle 层之后**应用，所以它能压过 bundle 自带的默认
值，同时完全不碰 `$DSH_HOME/settings.yaml`。

> 任何时候都不要把密钥本身写进 `cordis.patch.yml`、`settings.yaml` 或任何会被提交的文件。
> 配置里只放**引用名**（`apiKeyEnv`）。

## 使用 Auto 模式

1. 打开 DSH GUI 的模型选择器。
2. 选 provider **FreeLLMAPI (Auto)**（路由 id 是 `freellmapi`）。
3. 选模型：

| 模型 id | 网关会怎么做 |
|---|---|
| `auto` | 按**当前激活的回退链**走，不会对全局池重新排序。 |
| `auto:smart` | 智能优先（权重约 可靠性 0.35 / 速度 0.10 / 智能 0.55）。 |
| `auto:fast` | 实测速度优先——吞吐加首字节时延（约 0.35 / 0.55 / 0.10）。 |
| `auto:cheap` | 预算倾向。上游文档明确它与 `balanced` 是同一套配方（池子里本来就全免费）。 |
| `auto:reliable` | 近期成功率优先（约 0.70 / 0.15 / 0.15）。 |
| `auto:balanced` | 默认混合——可靠性优先，速度与智能平分其余（约 0.50 / 0.25 / 0.25）。 |
| `auto:<profile>` | 你在 freellmapi 面板里建的**具名回退链**；模型 id 里的名字会被转成小写。 |
| `fusion` | 网关的扇出模式（一组模型作答，judge 模型汇总）。运行中的路由器列出它时可选。 |

几个能省时间的细节：

- **模型字符串是原样送到网关的。** 适配器把 `auto`、`auto:smart`、`auto:<你的 profile>`、
  `fusion` 或任意具体目录 id 一字不改地转发，并且始终请求 `stream: true`——它绝不重写、归一化
  或省略模型名。选择器里显示什么只是方便，不是白名单：没列出来的 id 一样会被受理。
- **选择器里 `auto` 排最前，其余在后。** 它始终提供六条虚拟路由（裸 `auto` 打头，然后文档确认
  的五种策略），`includeFusion` 打开时再加 `fusion`，之后才是 `GET /v1/models` 报出来的内容。
- **整个模型字符串大小写不敏感**，网关还接受常见同义词（`auto:fastest`、`auto:speed`、
  `auto:smartest`、`auto:cheapest`、`auto:budget`）。请把上表当作"文档确认过的别名"，而不是
  封闭枚举——本插件**不会**拒绝它不认识的策略名。
- **未知的 `auto:<profile>` 会拿到上游 `400`。** freellmapi 在这种情况下不会静默退回
  `auto`，本插件也不会。失败信息会明确点出这一点，去面板核对链名即可。
- **失败是"在流里"报出来的，不是崩溃。** 传输层错误、`401`、`429`、`5xx`、流中途的
  `stream_error` 帧、不可用的 `GenerateOptions.stop`、超时、取消，都会以一个终结性 `finish`
  chunk 收尾（`reason.kind` 为 `error` 或 `aborted`），并带上稳定的 DSH 错误码：`AUTH`、
  `RATE_LIMIT`、`QUOTA`、`CONTEXT_WINDOW_EXCEEDED`、`UNSUPPORTED_CONTENT`、
  `UNSUPPORTED_OPTION`、`INVALID_REQUEST`、`SERVER`、`TRANSPORT`、`TIMEOUT`、`ABORTED`、
  `MISSING_CREDENTIAL`、`INVALID_CREDENTIAL`、`EMPTY_RESPONSE`、`CONTENT_FILTER`、`UNKNOWN`。
  正常结束则是 `stop`、`tool-calls` 或 `max-tokens`。遇到 `429`/`quota_exceeded` 时，只要网关给
  了 `Retry-After`，插件还会把它解析成 DSH 的重试时间字段。
- **有些错误码是刻意不做归一化的。** 上游带内错误帧自带 `error.code`，这个字符串会**原样**成为
  failure code——只有当帧里完全没有 code 时才回落到 `SERVER`。所以 `stream_error` 帧最终表现为
  `failure.code === "stream_error"`，而不是笼统的 `SERVER`。网关自造的错误码不在 DSH 的默认可重试
  集合（`EMPTY_RESPONSE`、`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`）里，因此这类失败**不会**
  触发 DSH 重试。这是有意为之：插件如实上报网关给出的码，而不是把它"洗"成一个可重试的码，从而把
  重试策略留在网关一侧。
- **图片**：`vision` 打开时插件会声明支持图片输入，读取被引用的附件并以内联 `data:` URL（单个上限
  20 MB）发出；读不到的附件会降级成一段文字占位符，而不是让请求失败。上游侧，带图片的请求只会被
  路由到有视觉能力的模型；当前链上一个都没有时，网关返回 `422` 与 `code: "no_vision_model"`，
  插件会告诉你遇到的是这两种情况中的哪一种。

### 怎么确认到底是哪家在服务

freellmapi 的每个响应都带 `X-Routed-Via: <platform>/<model>`。插件读取它并写进该请求的
DSH 日志（`logRoutedVia` 打开时，默认就是开的）。日志长这样：

```text
dsh-freellmapi: routed via groq/llama-3.3-70b (model=auto)
dsh-freellmapi: routed via google/gemini-2.5-flash (model=auto:fast) fallback-attempts=2 trail=groq/… key1=rate_limited; …
```

排查时值得记住的三点：

- `X-Routed-Via` 是**唯一**可靠的"谁服务了这次请求"信号。当前正在服务的那一跳**不可能**出现
  在 `X-Fallback-Trail` 里——响应头在响应体生成之前就已经发出去了。
- `X-Fallback-Attempts` / `X-Fallback-Trail` 只在真的发生了跨 provider 跌落时才有；它们不出现
  就说明"第一次就成功了"。
- 非 ASCII 的 model id 在头里是百分号编码的，插件会先解码再记录。

插件还会在进程内保留最近 50 条路由记录（以 `getRecentRoutes()` 导出，供测试与将来的界面使用）。
它不是 DSH 工具也不是服务，日常请以日志行为准。

不用 DSH 也能看到同样的信息：

```bash
curl -si http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer freellmapi-<unified-key>" \
  -H "content-type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"hi"}]}' \
  | grep -i '^x-routed-via'
```

## 架构

```text
┌──────────────────── DeepSeek Harness（宿主进程） ────────────────────────────────────────┐
│                                                                                          │
│  agent loop / 一轮对话                                                                   │
│       │                                                                                  │
│       ▼                                                                                  │
│  llm service (ctx.llm)  ── 按 GenerateOptions.provider 选路由 ──▶ freellmapi             │
│       │                                                                                  │
│       ▼                                                                                  │
│  LlmAdapter（本插件，provider = "freellmapi"）                                           │
│    • providerInfo()  →  { id: "freellmapi", name: "FreeLLMAPI (Auto)" }                  │
│    • listModels()    →  GET  {baseURL}/models          （实时目录）                      │
│    • resolveModel()  →  auto / auto:smart / auto:<profile> / fusion / <目录 id>          │
│    • stream()        →  POST {baseURL}/chat/completions  （SSE，model 原样透传）         │
│    • 读回            ←  X-Routed-Via、X-Fallback-Attempts / -Trail                       │
│    • 配置与密钥      ←  设置页 · 凭据服务 · 环境变量                                     │
│                                                                                          │
└────────────┬─────────────────────────────────────────────────────────────────────────────┘
             │  Authorization: Bearer freellmapi-…
             │  user-agent: deepseek-harness/<version> (+…)   ← 归因头
             ▼
   ┌──── freellmapi 网关 / 路由器 ────────────────────────────────────────────────────┐
   │  http://localhost:3001/v1                                                        │
   │  • 一把统一 key（freellmapi-…）挡在所有上游 provider 之前                        │
   │  • bandit 打分路由：可靠性 / 速度 / 智能 三档权重                                │
   │  • key 健康、冷却、月度预算、逐请求缓存与压缩                                    │
   │  • 跨 provider 回退，随后是 SSE 泵：工具调用重组、                               │
   │    usage、keep-alive 帧、错误映射                                                │
   └───────┬───────────────┬───────────────┬───────────────┬───────────────┬──────────┘
           ▼               ▼               ▼               ▼               ▼
      provider A      provider B      provider C      provider D      …（约 34 家）
          每次请求的胜出者由响应头  X-Routed-Via: <platform>/<model>  报出
```

接口边界上的几点：

- 本插件是纯 host 侧的 DSH 插件：用 `ctx.llm.registerAdapter` 注册一条 provider 路由，把这条
  路由登记进"可配置 provider 目录"供设置界面显示，再注册一个模型发现钩子给"添加模型"流程用。
- **每一个**出站 HTTP 请求（聊天补全与模型发现）都带 DSH 的归因 `user-agent`，并使用
  `redirect: 'error'`，确保凭据绝不会跟着重定向泄漏到第三方主机。
- 插件**零运行时依赖**，且从不在模块顶层 import 任何 DSH 包：它用带保护的动态 import 解析
  `@deepseek-ai/dsh-llm`，运行时缺席时降级到本地 shim；唯一声明的 peer
  （`@deepseek-ai/cordis`，可选）也从未被直接 import。结果正是关键的那一条——插件永远绑定到
  DSH 自己加载的那份运行时。相关红线见[故障排查](#故障排查)第 6 条。
- **重试交给网关和 DSH 的默认策略。** 适配器不返回自定义重试策略：freellmapi 本身已经做了 429
  冷却与跨 provider 故障转移，再叠一层重试只会让这种"网关更擅长处理"的情况延迟翻倍。请求带一个
  可配置的超时（`timeoutMs`），并与调用方的 abort 信号合并。

## 故障排查

### 1. `ECONNREFUSED` / 连不上 3001 端口

插件会把这种情况报成 `TRANSPORT` 失败，并写出它试过的确切地址：

```text
dsh-freellmapi: cannot reach the FreeLLMAPI gateway at http://localhost:3001/v1 — confirm the gateway is running (default http://localhost:3001/v1), that `baseURL` ends in `/v1`, and that nothing blocks the connection [model=auto] — fetch failed: connect ECONNREFUSED 127.0.0.1:3001
```

- 网关真的起来了吗？`curl -s http://localhost:3001/v1/models -H "Authorization: Bearer freellmapi-<key>"`。
- 检查 `baseURL`：它要指向 OpenAI 兼容根地址，通常以 `/v1` 结尾。只写
  `http://localhost:3001` 会变成一片 `404`，插件对此有单独提示（"check that `baseURL` is the
  OpenAI-compatible root and normally ends in `/v1`"）。
- Docker：确认端口已发布（`-p 3001:3001` 或 compose 里的端口映射），容器是健康的——server
  与 dashboard 共用 `3001`。
- 远程网关：用它的主机名，并确认中间没有防火墙或反向代理把 `Authorization` 头吃掉。插件不会
  偷偷换主机重试。
- Windows + Docker Desktop / WSL：如果 `localhost` 解析到了别的网络栈，试试
  `http://127.0.0.1:3001/v1`。
- 网关只是慢、不是死了？调大 `timeoutMs`（默认 10 分钟）；超过它的请求会被报成 `TIMEOUT`，
  而不是卡住不动。

### 2. `401` —— "Missing or invalid API key"

- 网关要的是 `Authorization: Bearer freellmapi-…`。随便哪家上游的 provider key 都不行，必须是
  freellmapi 面板里的**统一 key**。
- **空值等于没配。** 一个导出为空的 `FREELLMAPI_API_KEY` 与不存在的变量行为一致；插件会在发
  请求之前就报 `MISSING_CREDENTIAL`。所以要查的是"空字符串"，不只是"变量在不在"。
- 确认插件找的引用名（`apiKeyEnv`，默认 `FREELLMAPI_API_KEY`），并确认环境变量或凭据确实是
  以**这个名字**存在的。
- key 被撤销或轮换了？在设置页重新粘贴即可——插件每次请求都重新读凭据，不用重启。

### 3. `429` —— 配额或限流耗尽

这是网关层面的状况：所选模型的**每一把**候选 key 当前都在限流或已超预算。响应体形如
`{"error":{"message":…,"type":"invalid_request_error"}}`；如果是月度预算耗尽，网关还会额外带上
`error.code: "quota_exceeded"` 与指向下个 UTC 月首的 `Retry-After` 头。

- 插件会把它翻成一句点明状况、并在有该头时给出重试时间的提示——别不看就盲目重试。
- **不要假设 `Retry-After` 一定存在。** 只有月度预算耗尽（以及一个 embedding 相关的特殊场景）
  保证带它；普通聊天限流耗尽没有这个承诺。
- 真正有用的处置：等窗口过去、在面板里再加一把上游 key、降低并发，或换一个能摊开负载的策略
  （`auto:reliable` 偏向近期成功率，`auto:fast` 偏向吞吐）。
- 注意免费版与付费版的目录差异：免费安装看到的是可能滞后约 30 天的目录快照，所以它对"哪些模型
  可用"的认知会落后于现实。两种版本的接入方式、端点、鉴权与流式格式完全一致。

### 4. 模型列表偏少，或看不到具体模型

先明确这里的"空"可能指什么：六条 `auto`/`auto:*` 虚拟路由无论发现成功与否都会提供（`fusion`
也是如此，除非你把 `includeFusion` 关掉），所以发现失败绝不可能让选择器变成空白——丢的只是目录里的
具体模型。

- 直接测发现端点：
  `curl -s "http://localhost:3001/v1/models" -H "Authorization: Bearer freellmapi-<key>"`。
  如果这里就是空的，问题在网关，不在 DSH。
- `exposeDiscoveredModels` 还是 `true` 吗？把它设成 `false` 会刻意隐藏所有发现到的模型，只留
  虚拟路由。
- 如果发现请求缺密钥，插件会保留上次缓存并记录错误，而不是清空选择器（网关临时重启也不会让列表
  在本次会话余下时间里变空）。先查有没有 `MISSING_CREDENTIAL`——它在发请求之前就会暴露。
- 网关的目录同步会从 `https://api.freellmapi.co` 拉签名目录（每 12 小时一次，启动后约 10 秒首
  跑）。没有外网的机器会保留上一份目录；而**全新安装 + 无外网**确实可能一个具体模型都没有。
  这种时候虚拟路由仍然会被列出。
- 用 `?available=true`（别名 `?connected=true`、`?ready=true`）或
  `?execution_status=ready|needsKey|exhausted` 区分"目录里有"和"此刻能服务"。选择器看着很少，
  通常就是这个原因：目录在，但 key 缺失或正在冷却。
- 还要记得免费安装看到的是可能滞后约 30 天的目录快照，所以它的模型清单落后于上游当前提供的
  东西是正常的。

### 5. 插件始终不出现在模型列表里

按下面顺序排查：

- **它被登记为 bundle 了吗？** 打开 `$DSH_HOME/profiles/<profile>/package.json`，确认
  `dsh.profile.bundles` 里有 `dsh-freellmapi`。装了但没登记是最常见的原因；DSH 会把它当普通
  依赖加载，界面上什么都不出现。
- **patch 真的生效了吗？** 没有命中任何目标的 patch 只会给一条警告，所以写错名字的效果是
  "静默地什么都没发生"。核对 loader entry id 与包名。
- **entry id 重复了吗？** 如果 bundle 的 patch 和你的 profile patch 都 insert 了
  `id: freellmapi`，profile 会以 `duplicate loader entry id` 起不来。删掉你手写的那行
  （见[安装](#安装)）。
- **路由名撞车了吗？** provider 路由名在单进程内唯一，而这里最容易踩：**官方 `setup-dsh` 用的
  就是同一个名字。** 它写的是 `llm-pi-ai.providers.freellmapi`，在 DSH 里的 provider 名就是
  `freellmapi`，所以如果你早先配过它，本插件的注册会被拒绝，插件拒绝加载并给出点名冲突的信息：

  ```text
  dsh-freellmapi: cannot register provider route "freellmapi" — provider route "freellmapi" is
  already owned by another adapter. The FreeLLMAPI documentation's `npx freellmapi setup-dsh`
  writes an `llm-pi-ai.providers.freellmapi` route; remove that route (or this plugin) so exactly
  one adapter owns the name.
  ```

  两条路由删掉一条；它们无法共存。
- **`llm` 服务缺了吗？** 没有它插件会保持惰性，并记录
  `the llm service is unavailable; the plugin is inert`——那说明宿主的组合有问题，不是插件的问题。
- **手工装完重启了吗？** 手工编辑过的 profile，bundle 组合发生在启动时。
- 还不行就看 DSH 日志里插件自己的错误行；注册失败会被报出来，而不是被吞掉。（模型发现是唯一的
  软失败：它的注册被拒时 provider 路由照常工作，只会给一条警告。）

### 6. 整个 profile 行为异常或起不来（依赖遮蔽红线）

这是唯一能把 DSH 一起拖下水的故障模式，值得弄清原理。

**`@deepseek-ai/dsh-*` 绝不能出现在本插件的 `dependencies` 里。** 本包**零**运行时依赖，甚至
不在模块顶层静态 import DSH 的 LLM 运行时：它在加载时用带保护的动态 import 解析
`@deepseek-ai/dsh-llm`，解析不到时降级到本地的等价 shim（裸 checkout、单元测试），因此同一个
文件在 DSH profile 里和在外面都能加载。唯一声明的 peer 是可选的 `@deepseek-ai/cordis`。
之所以要这么讲究：

- **DSH 实际是怎么提供运行时的**：`$DSH_HOME/profiles/node_modules/<包名>` 是一整片指向 `npx`
  安装缓存（`…\npm-cache\_npx\<hash>\node_modules\…`）的文件系统 **junction**。所以
  `@deepseek-ai/dsh-llm@0.2.0-rc.2` 是从插件自己的目录**向上**走解析到的，自然也就继承了那份缓存
  副本的"身份"。
- DSH 从应用包内加载自己的运行时包。插件一旦把比如 `@deepseek-ai/dsh-llm` 声明成普通依赖，包
  管理器就会把**第二份副本**提升进 `profiles/<profile>/node_modules/@deepseek-ai/`。
- profile 的 `node_modules` 在模块解析时优先，于是插件绑到那份副本，而 DSH 其余部分仍在用运行时
  副本。类身份随之崩掉：跨副本的 `instanceof` 判定失败、错误码静默降级、插件期待的服务缺失。
- 版本让情况更糟：npm 上的 `@deepseek-ai/dsh-llm` 只有 `0.0.1-rc.x` – `0.1.x`，远低于本插件
  面向的 `0.2.0-rc.2` 运行时。也就是说那份遮蔽副本同时还是一份**不兼容**的副本。

第二份副本不是假设：正因为插件与 DSH 进程可能持有**不同的模块实例**，本插件被刻意写成
**身份无关**——不依赖任何跨副本 `instanceof`，`stream()` 永不抛错，一切失败都转成带内 `finish`
数据，`failure` 是纯数据对象 `{message, code, status}`，而不是跨越适配器边界的异常。把运行时声明
成依赖，等于白白丢掉这一层保护。

**健康检查** —— 看两个目录就够：

```powershell
# 1. 运行时供给：指向 npx 缓存的 junction（约 249 个包）。这是正常状态。
Get-ChildItem "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai" |
  Where-Object { $_.Name -eq 'dsh-llm' } | Select-Object Name, LinkType, Target
#   Name    LinkType Target
#   dsh-llm Junction C:\Users\…\npm-cache\_npx\<hash>\node_modules\@deepseek-ai\dsh-llm

# 2. profile 自己的 scope：健康时只有 cosmokit 与 schemastery。
Get-ChildItem "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@deepseek-ai"
```

第二个目录里多出任何东西——尤其是 `dsh-llm`、`cordis` 或任何 `dsh-*` 适配器——就是遮蔽了运行时
的泄漏依赖。

**修法**：找出是谁把它拉进来的（在 profile 目录里 `pnpm why @deepseek-ai/dsh-llm`），去掉那条
依赖，重装，重启 DSH。

> 准确性说明：上面那条目录清单是在真实 profile 上实测的。遮蔽安装的最终表现会随 DSH 版本不同
> 而变化——跨副本失败、服务缺失、甚至 profile 拒绝启动都在可能范围内。所以千万不要把"它启动
> 起来了"当成"这条依赖无害"的证据。

### 7. 具名策略或具名 profile 报 `400`

- `auto:<名字>` 里的名字不是你面板里的链 → 上游按设计返回 `400`。从 `GET /v1/models` 里把真实
  名字抄下来（它们以 `auto:<小写名字>` 形式出现），原样使用。
- `400` 也可能是请求体格式错误，或所选模型不支持的 `response_format`。能力是**逐模型**的，不是
  逐网关的：能接受 `tools` 的模型未必遵守 `response_format`，反之亦然。
- `409` 不是策略问题：它表示同一个 `Idempotency-Key` 被配上了**不同的**请求体。换一个新 key，
  不要拿同一个重试。

## 卸载

**图形界面（推荐）**：插件管理器 → `dsh-freellmapi` → 移除。管理器会替你跑包管理器移除并更新
`dsh.profile.bundles`。

**手工**：

1. 从 `$DSH_HOME/profiles/<profile>/package.json` 的 `dsh.profile.bundles` 与 `dependencies`
   里删掉 `dsh-freellmapi`；
2. 删除 `$DSH_HOME/profiles/<profile>/node_modules/dsh-freellmapi`；
3. 如果你加过 `- id: freellmapi` 的覆盖块，从 profile 的 `cordis.patch.yml` 里删掉；
4. 重新执行 `dsh plugin --profile desktop install`，重启 DSH。

> ⚠️ `dsh plugin --profile desktop remove dsh-freellmapi` 这种写法看起来是 `add` 的对称形式，
> 但**没有** DSH 运行时的原文佐证——请优先用图形界面或上面的手工步骤。

卸载本插件会释放 DSH 路由名 `freellmapi`，也就是说官方 `setup-dsh` 那条路由之后可以重新装上；
但要注意：卸载插件**不会**恢复你早先删掉的那条路由。不再需要那把 key 时，请单独从凭据存储或
`$DSH_HOME/.env` 里删除。

## 兼容性

| 组件 | 支持情况 | 说明 |
|---|---|---|
| DeepSeek Harness 运行时 | `0.2.0-rc.2`（针对它编写并核对） | 其它 `0.2.0-rc.x` 大概率可用；插件只用了稳定的 LLM seam API（`registerAdapter` / `registerConfigurableProviders` / `registerModelDiscovery`）。 |
| Node.js | `>= 22` | 与参考 DSH 插件的声明一致。 |
| freellmapi 网关 | `v0.13.x`（撰写时最新为 `v0.13.7`） | 用到的协议面：`POST /v1/chat/completions`（SSE）、`GET /v1/models`、`X-Routed-Via` 与回退头、`429 quota_exceeded`。 |
| freellmapi 版本档位 | 免费版与付费版 | 端点、鉴权、流式格式一致；差异只在目录新鲜度与可用模型集合。 |
| `dsh-freellmapi` | `0.1.0` | 零运行时依赖。DSH 的 LLM 运行时在加载时解析（解析不到则用本地 shim）；唯一声明的 peer 是可选的 `@deepseek-ai/cordis`。 |

> 版本号提醒：上游网关的 release 是 `v0.13.x`，而提供 `setup-dsh` 的 npm CLI 包 `freellmapi`
> 是独立编号的（例如 `0.8.1`）。不要把两个数字当成同一条版本线。

## 开发

```bash
npm test          # 离线测试套件——不需要网关、不需要外网、不需要 API key
```

测试套件刻意做成密闭的：必须能在干净的 GitHub runner 上通过，所以它绝不访问真实的 freellmapi
服务。CI 在 `ubuntu-latest` + Node 22 上跑同一条命令（`.github/workflows/ci.yml`），并注入一个
不可达的 `FREELLMAPI_BASE_URL` 与空的 `FREELLMAPI_API_KEY`——万一有人误加了真实调用，它会
响亮地失败，而不是悄悄通过。

仓库结构：

```text
dsh-freellmapi/
├── package.json              # dsh.bundle.patch + peerDependencies（绝不放 dependencies）
├── cordis.patch.yml          # 本 bundle 插入的 loader 行
├── lib/                      # 实际发布的插件代码
├── tests/                    # 离线测试
├── IMPLEMENTATION.md         # 实现说明与设计取舍
├── .github/workflows/ci.yml  # Node 22，离线
├── README.md                 # 英文（主文档）
├── README.zh-CN.md           # 中文（本文件）
├── CHANGELOG.md              # Keep a Changelog 格式
└── LICENSE                   # MIT
```

## 限制与未验证项

直说清楚，你好知道自己依赖的是什么：

1. **没有对真实 freellmapi 网关跑过端到端。** 本仓库的所有测试都针对进程内的 mock 网关——这是
   刻意的，为的是 CI 能离线跑。wire 细节来自 freellmapi 自己的文档与服务端源码，但第一次接真网关
   时，仍可能暴露出本插件没见过的帧细节。
2. **流中途 `stream_error` 帧只有文档级证据。** 上游没有把它的 JSON 形状钉死，所以解析器识别四种
   可能形态（`type: "stream_error"`、`code: "stream_error"`、`object: "error"`，以及嵌套的
   `error: {…}`），并把任何"像错误"的帧当作终结性失败处理。
3. **图片链路没有在真实 attachments 服务上验证过。** 读取附件字节走的是
   `attachments.imageHostPath()`——适配器能拿到字节的唯一文档化入口。如果你的构建里该服务形状不同，
   受影响的每张图都会降级成文字占位符：请求仍然成功，但模型看不到那张图。
4. **`GenerateOptions` 的 `sessionId` 与 `purpose` 未做映射。** Chat Completions 没有二者的标准
   字段；目前是直接丢弃，而不是塞进自定义头。
5. **`fusion` 的元数据帧只做到"识别并跳过"，没有渲染。** 加法式 `_fusion` 帧不会破坏流、也不会
   混进答案，但这个纯 host 插件不会把它变成进度显示。
6. **默认不声明输出上限**（`maxTokens: 0`），DSH 因此不会物化任何上限，交给网关与上游模型决定。
   如果某个上游的默认值把你的长回答截断了，请显式设置 `maxTokens`。
7. **`maxTokens` 超过 `Number.MAX_SAFE_INTEGER` 时，配置收得下、DSH 却拒收。** 该字段只校验"非负
   数字"，而运行时要求 `defaultMaxTokens` 是**安全整数**；因此像 `1e21` 这种荒谬取值会让
   `resolveModel()` 返回 DSH 拒收的元数据（`INVALID_MODEL_MAX_TOKENS`），而不是被静默钳制。
8. **`role: "user"` 且 `content` 是纯字符串的消息会被发成空内容。** DSH 的契约恒为
   `ContentBlock[]`，所以 DSH 自己构造不出这种形状；但 `lib/wire.js` 自己的 `textOf` 容忍字符串，
   属模块内部不一致——手工构造的这类消息会带着空 `content` 抵达网关，而不是被明确拒绝。
9. **`includeFusion: false` 可能被网关自己抵消。** 静态目录确实会去掉 `fusion`，但网关的
   `GET /v1/models` 响应会自报 `fusion`，模型发现又把它合并回来。真想让它消失，请同时关掉
   `exposeDiscoveredModels`。
10. **模型发现可能返回重复 id。** `discover()` 原样透传网关的清单；DSH 自己的 `discoverModels`
    会按 endpoint 顺序去重，所以对 GUI 无害——但直接读取原始发现结果的调用方会看到重复项。

## 本文所述内容的核实方式

为了让你能分清哪些是实测事实、哪些是设计判断：

- **实测 / 来自上游**：网关的安装命令与端点、`setup-dsh` 写了哪些文件、`auto:*` 策略与权重表、
  `X-Routed-Via` 与回退头、`400` / `401` / `409` / `422` / `429` / `502` 的语义、免费版与付费版
  的目录差异，以及"约 34 家 provider"这个数字，都来自 freellmapi 自己的文档与源码
  （`docs/en/api/01-rest-api.md`、`docs/en/architecture/*`、`cli/src/tools.ts`、
  `server/src/routes/proxy.ts`）。
- **实测 / DSH 侧**：profile → bundle → loader 的组合模型、patch 格式、`dsh.bundle.patch` 的
  必要性、settings / credentials / volatile 语义、GUI 选中模型依赖 `listModels` 这一要求，以及
  依赖遮蔽的健康检查，均取自 DSH `0.2.0-rc.2` 的运行时源码。插件管理器的行为（接受哪些 spec、
  拒绝没有 `dsh.bundle` 的 manifest）读自 `@deepseek-ai/dsh-plugin-manager`。
- **实测 / 本插件**：[配置](#配置)一节里每个字段、默认值与探测行为都读自 `lib/config.js`；日志
  行格式、`X-Routed-Via`/回退头的处理与环形缓冲读自 `lib/routes.js`；失败码与 `Retry-After` 解析
  读自 `lib/errors.js`；请求映射与"失败在流内上报"的行为读自 `lib/wire.js` 与 `lib/index.js`。
  将来若有字段改名，那属于破坏性变更，会写进 [CHANGELOG.md](CHANGELOG.md)。
- **属于设计判断，而非实测**："DSH 通用的 pi-ai `openai-completions` 路径不会把上游响应头透到
  日志里"——这是根据该适配器的实现方式推断的，也正是增量第 1 条存在的理由。请把它当作一个值得
  在你机器上验证的说法。
- **未验证的命令**都用 ⚠️ 就地标出，并附上它的证据来源。

## 许可证

[MIT](LICENSE) © 2026 lion231226

本项目与 freellmapi 项目、与 DeepSeek 均无隶属关系，也未获其背书或支持。"freellmapi" 归其
作者所有；"DeepSeek Harness" 与 `@deepseek-ai/*` 归 DeepSeek 所有。使用风险自负——被 Auto
路由到的每一次请求，都会消耗路由器所选那家上游 provider 的额度。
