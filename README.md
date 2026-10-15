# dsh-freellmapi

**Free-tier multi-provider routing for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**
Eighteen provider entries behind one DSH provider route — five of them enabled by default, and all five of
those with a free tier — plus a per-request complexity classifier, capability/speed ranking, and automatic
429/5xx failover.

```text
install the plugin  →  start DSH  →  pick provider "freellmapi" + model "auto"  →  it answers
```

No external process. No gateway to run. No API key required to get a first answer — the built-in pool
contains keyless providers that the maintainer verified with real, credential-free requests.

> ### Unofficial plugin — please read
>
> This is a community project. It is **not** affiliated with, endorsed by, sponsored by or supported by
> any of the upstream providers it talks to, nor by DeepSeek. It is not an official DSH plugin.
> Provider names and "DeepSeek Harness" / `@deepseek-ai/*` belong to their respective owners.
> Licensed under the [MIT License](LICENSE). **You are responsible for complying with each provider's
> terms of service, and for what you send to a free tier that may log and train on it.**

---

## Table of contents

- [Quick start](#quick-start)
- [What you get](#what-you-get)
- [Zero config: what works with no key at all](#zero-config-what-works-with-no-key-at-all)
- [Adding keys](#adding-keys)
- [How to read the model list](#how-to-read-the-model-list)
- [Pinned models are strict](#pinned-models-are-strict)
- [How it picks a model](#how-it-picks-a-model)
- [Failover and health](#failover-and-health)
- [Two modes: `direct` and `gateway`](#two-modes-direct-and-gateway)
- [Configuration](#configuration)
- [How to see what it did](#how-to-see-what-it-did)
- [Just one key? No keys?](#just-one-key-no-keys)
- [Architecture](#architecture)
- [Troubleshooting](#troubleshooting)
- [Limitations and unverified claims](#limitations-and-unverified-claims)
- [Compatibility](#compatibility)
- [Development](#development)
- [Upstream and credits](#upstream-and-credits)
- [License](#license)

## Quick start

1. **Install** — open the DSH web GUI, go to the **Plugins** manager in the sidebar, install the bundle
   and paste one of these specs:

   ```text
   github:lion231226/dsh-freellmapi          # from GitHub (no npm publish needed)
   github:lion231226/dsh-freellmapi#v0.7.5   # pinned to a tag
   dsh-freellmapi                            # from npm, once published
   ```

   CLI equivalent, and the manual path, are in [Install details](#install-details).

2. **(Optional) paste a few keys** — see [Adding keys](#adding-keys). Skipping this step is a supported
   configuration: the two keyless providers still answer.

3. **Pick the model** — in the DSH model picker choose provider **FreeLLMAPI (Auto)** and model `auto`.

4. **Watch it work** — with `logRouting` on (the default) every request logs one line:

   ```text
   dsh-freellmapi: tier=complex -> openrouter/deepseek/deepseek-v3.1:free (capability=5, speed=3, 2 candidates tried)
   ```

That is the whole setup. Everything below is detail.

### Install details

| Method | How |
|---|---|
| **Plugins manager (recommended)** | Sidebar → **Plugins** → install → paste `github:lion231226/dsh-freellmapi` (or the npm name once published), confirm, restart if DSH asks. The manager accepts registry names, absolute paths, git addresses and tarball URLs, and refuses any spec whose manifest declares no `dsh.bundle` — this package declares one. |
| **`dsh plugin` CLI** | `dsh plugin --profile desktop add github:lion231226/dsh-freellmapi` — the subcommands come from DSH's own runtime error text; ⚠️ not verified end-to-end here, so confirm against your DSH build. |
| **Manual placement** | Copy the package to `$DSH_HOME/profiles/<profile>/node_modules/dsh-freellmapi/`, add it to **both** `dependencies` and `dsh.profile.bundles` in the profile's `package.json`, then run `dsh plugin --profile <profile> install` and restart. Listing it in `bundles` is what makes DSH load it at all. |

The package ships its own `cordis.patch.yml` (`- insert: [{ id: freellmapi, name: 'dsh-freellmapi' }]`),
so a correctly installed bundle needs no hand-written patch row. **Never add a second row with the same
`id`** in the profile's own `cordis.patch.yml`: two entries with one id abort bundle composition with
`duplicate loader entry id "freellmapi"`.

## What you get

| | |
|---|---|
| **Self-contained routing** | The plugin owns the routing intelligence. `direct` mode (the default) needs no gateway, no daemon, no Docker — nothing but DSH itself. |
| **A built-in pool of 18 providers / 45 models** | Groq, Cerebras, OpenRouter, GitHub Models, Mistral, Z.ai (Zhipu), Volcengine Ark, LongCat, LLM7, Kilo, NVIDIA NIM and OVH AI Endpoints, plus the six 0.7.0 additions — ModelScope (魔搭), iFlytek Spark (讯飞星火), SiliconFlow (硅基流动), SambaNova, HuggingFace Router and Routeway — with per-model capability, speed, context window, vision and tool-calling facts. **Only five of the eighteen are enabled out of the box.** |
| **Per-request complexity routing** | Every request is scored and classified `simple` / `medium` / `complex`; the tier decides whether capability or speed dominates the ranking. A one-line "list the files here" and a 12-tool refactoring task do not go to the same model. |
| **Automatic failover** | A rate-limited (429), broken (5xx), timed-out or `model_unavailable` candidate is parked and the next-ranked one is tried — **only before the first chunk has been sent**, so a single answer is never spliced from two models. |
| **Health tracking and cooldowns** | The **first retryable failure already parks** the candidate (2 minutes), and each further consecutive failure escalates one step: 2 m → 10 m → 1 h → 24 h. `Retry-After` from the provider always wins; a rejected credential (401/403) parks that provider for 24 h. The scoring penalty decays with a 60-second half-life, so a single 429 is never a life sentence. |
| **Zero-config start** | Kilo and LLM7 answer without any credential; a fresh install has a non-empty candidate pool before you configure anything. |
| **Honest diagnostics** | One log line per request names the tier, the winner and how many candidates were tried; every failure is an in-band `finish` chunk with a stable code, never an exception. |
| **No silent substitutions** | Picking a concrete model id is a **strict pin**: if it has no credential, does not exist, or is cooling down, you get an explicit error with instructions instead of somebody else's answer. The model list shows only what can actually serve, plus one `setup:<provider>` signpost per unkeyed provider. |
| **`gateway` mode kept intact** | The v0.1.0 behaviour — forwarding to an external [freellmapi](https://github.com/tashfeenahmed/freellmapi) gateway — is still there behind `mode: gateway`, unchanged, for people who want the gateway's own bandit scoring, caching and `fusion`. |

## Zero config: what works with no key at all

The pool marks three providers **keyless** (no `Authorization` header at all). The maintainer verified
them with real requests on 2026-10-13 (`_lead/live-probe-2026-10-13.md`), sending **no** credential:

| Provider | Model | Result |
|---|---|---|
| `kilo` (`https://api.kilo.ai/api/gateway/v1`) | `nvidia/nemotron-3-super-120b-a12b:free` | **HTTP 200**, real completion |
| `kilo` | `nvidia/nemotron-3-ultra-550b-a55b:free` | free route, 550B class |
| `ovh` (`https://oai.endpoints.kepler.ai.cloud.ovh.net/v1`) | `gpt-oss-120b` | **HTTP 200** |
| `llm7` (`https://api.llm7.io/v1`) | `DeepSeek-V4-Flash-0731` | **HTTP 200** (anonymous) |
| `llm7` | `codestral-latest` | **HTTP 200** (anonymous) |

`kilo` and `llm7` are **enabled by default**, so those two carry the "install and it works" promise.
`ovh` is keyless too but **disabled by default** (2 requests/minute — far too tight to be in the default
candidate set); enable it explicitly if you want it.

Three things you should know before you rely on a keyless pool:

- **Keyless is not unlimited.** Kilo is documented at ~200 requests/hour per IP, LLM7 at ~100/hour, OVH at
  2 RPM. Quota numbers throughout this document come from the upstream registry baseline (2026-04) and may
  be stale; the plugin reacts to them rather than trusting them — a 429 parks that candidate and moves on.
- **Free traffic may be recorded and used for training.** Kilo states this in its own provider registry
  (free prompts and completions are logged for training). If that is not acceptable to you, disable it:

  ```yaml
  providers:
    kilo:
      enabled: false
  ```

  With `kilo` off, zero-config still works through `llm7` alone.
- **Free model catalogs drift.** During the 2026-10-13 probe, `llm7` answered `400 model_unavailable` for
  `gpt-oss-20b` and `GLM-4.6V-Flash` — the same kind of id that worked the day before. The router treats
  `model_unavailable` as a *per-model* condition: it parks that `(provider, model)` pair and tries the next
  candidate instead of failing your request. Seeing one of these is normal operation, not a bug.

## Adding keys

Keys are the single biggest quality upgrade: the default candidate pool is `groq`, `cerebras`, `openrouter`,
`kilo`, `llm7`, and adding the first three gives you the strong-and-fast models.

Set a key by exporting the environment variable named in `apiKeyEnv` — or store it through DSH's
credentials service, which is the first thing resolution consults. Resolution order is:
credentials service → `config.providers[id].apiKey` → environment variable named by `apiKeyEnv` → the
convention `<PROVIDER_ID>_API_KEY`. Empty values count as "not configured".

> **Where to edit in the GUI.** **Settings → Models** lists this plugin's provider route (*FreeLLMAPI*) as
> an ordinary card, and the key rows render **inside that card** — one per upstream that is enabled but has
> no usable credential, each with a link to its key page, the environment-variable name it will be stored
> under, a password field and Save. Saving writes through DSH's credentials service, which is read without
> caching, so **the key takes effect on the next request with no restart**.
>
> Two notes on the host's own editor, so its behaviour is not mistaken for a bug:
>
> - The **编辑** button next to that card opens DSH's provider editor, which can only render fields for its
>   own two provider families (`llm-deepseek`, `llm-pi-ai`); for any other namespace it shows "other fields
>   live in `cordis.patch.yml`" and disables Save. That is a current host limitation and the key rows above
>   are the answer to it.
> - The card shows a **missing-credential dot** while the root `apiKeyEnv` (`FREELLMAPI_API_KEY`) is unset.
>   Direct mode needs no such key — the dot refers to the optional gateway credential and can be ignored.
>
> The full field set (including the per-upstream `providers` map and the routing knobs) is on the plugin's
> **own settings page: Settings → Plugins → dsh-freellmapi**, generated from the schema; it is also editable
> in `cordis.patch.yml`.
>
> The card offers a key field for the pool's **default-enabled** providers (`groq`, `cerebras`,
> `openrouter`, `llm7`, `kilo`). The browser table is generated at build time from those defaults, so a
> provider you enable yourself through `providers.<id>.enabled` will **not** grow a key row — set its
> `apiKeyEnv` and store the credential directly in that case. That applies to all six providers added in
> 0.7.0, which ship disabled on purpose: enabling one of them does **not** make a key row appear in the
> card (this is the known gap recorded in the 0.6.1 changelog, not a bug).

### Which providers are actually reachable — and how to ask

Free-tier access is network-sensitive, so this section tells you **how to measure**, not what to believe.
It previously carried a table claiming `groq` and `cerebras` were region-blocked "and a key changes
nothing". **That table was wrong**, and the reason is worth keeping: the probe sent **no `Authorization`
header**. Measured 2026-10-15:

| Provider | No credential | Syntactically valid but bogus key |
|---|---|---|
| `groq` | HTTP **403** | HTTP **401** → reachable, it just wants a real key |
| `cerebras` | HTTP **403** | HTTP **401** → reachable |
| `ovh` (keyless) | HTTP **200** | HTTP **403** → *sending a key breaks a keyless provider* |

So **a 403 is never self-explanatory.** It means one of three different things depending on what you sent:
*anonymous request rejected*, *credential rejected*, or *region rejected*. Reporting one without the other is
how the wrong table got written.

**Probe correctly, per provider:**

- **keyless** providers (`llm7`, `kilo`, `ovh`) — send **no** `Authorization` header; `200` is healthy.
- **key-required** providers — send a syntactically valid but **bogus** `Authorization: Bearer …` header;
  `401` is healthy (the endpoint exists and refused politely), `200` is fine too.
- Treat `403` as **ambiguous**: it needs a second probe with the other method before it means anything.
- `404`/`400`/`422` usually mean the path differs, not that the host is down.

**The request body is part of the method too.** Probing a chat endpoint with a **model id that does not
exist** yields the *opposite* conclusion: `modelscope` answers `400 Invalid model id` and `sambanova`
answers `404 model_not_found`, and neither can be told apart from "this provider's chat needs no
credential" — the request never reached the credential check. Replaying the same request with a **real id
from the catalog** returned `401` from both. Same URL, same headers, different body, opposite verdict.

The gate automates the header split: `node tools/gate.mjs --online` → **G7** probes every pool provider with
the method that suits it and prints the method beside each result, so the verdict can be audited rather than
trusted. G7 asks `GET {baseURL}/models` only, so read its green as *"the host answers"*, not as *"this
provider will serve you a completion once you add a key"*.

Measured this way on 2026-10-15:

- **All 12 pre-0.7 pool providers answer** (G7, 2026-10-15) — including the two the old table called blocked.
- **The six 0.7.0 additions**, probed anonymously *and* with a bogus header: `modelscope`, `xfyun`,
  `siliconflow`, `sambanova` and `huggingface` are reachable. **`routeway`'s anonymous chat path is the one
  open `AMBIGUOUS`**: without a credential its `POST /chat/completions` gets a Cloudflare interstitial
  (`403`, HTML, "Attention Required"), while the same request **with** a bogus `Authorization` header
  reaches the origin and gets a plain-JSON `401 Invalid API key`. A single response cannot separate
  *anonymous rejected* from *region rejected*; a real key, or a second egress IP, would settle it. Nothing
  in this README depends on that path being open.

**Which egress each probe used is part of the result.** The probe host runs a **VPN in split-tunnel mode**:
traffic to mainland-Chinese destinations goes out **direct**, everything else goes through the proxy, whose
exit is **US-Los Angeles**. **The LA exit is the overseas path's location — it is not the host's location,
and this README does not claim otherwise.** So the results above split by path, and the split is stated
rather than left to inference:

- **Direct (within mainland China):** `modelscope`, `xfyun` and `siliconflow` — the three mainland-Chinese
  hosts in the 0.7.0 additions. Each answered its probe **over the direct path** (`xfyun` and `siliconflow`
  returned `401` to the bogus-credential probe; `modelscope` was also reached, see the doc-site note below).
- **Through the proxy (overseas exit, US-LA):** the other three additions and all 12 pre-0.7 providers.
  `routeway`'s Cloudflare behaviour is measured on **this** path, which is why its `403` still cannot be
  separated from a region rejection — see the `AMBIGUOUS` note above.
- **The application-layer verdicts** (`401`, RFC 6750 credential challenges, origin error JSON) do not depend
  on the egress at all; *"reachable from your network"* does, which is why the path is recorded per provider.

**A tool limit is not a property of the site.** An earlier draft of this section reasoned from a failed
`web_fetch` of a Chinese vendor documentation site — *"hostname resolves to a non-public IP address"* — to
*"Chinese vendor and documentation sites are unreachable from this machine."* **That inference was wrong.**
The message is this project's own **DNS guard**: a split-tunnel VPN answers DNS with **fake-IP** addresses
from the reserved benchmarking range `198.18.0.0/15`, and `web_fetch` refuses to fetch any hostname that
resolves there. It rejected `www.xfyun.cn` **and `github.com` in the same session with the same sentence**,
which is what exposes it as a guard rather than a measurement. Re-measured (2026-10-15) over the direct path
with an ordinary HTTP client:

| Host | Result over the direct path |
|---|---|
| `www.xfyun.cn` (vendor doc page) | **HTTP `200`, 128 382 B, 618 ms**, `Server: Tengine` |
| `modelscope.cn` | **HTTP `200`, 4 639 B, 290 ms** |
| `spark-api-open.xf-yun.com` (`POST /v1/chat/completions`) | **HTTP `401`**, `{"message":"HMAC signature cannot be verified: apikey not found"}` |
| `siliconflow`'s `api.siliconflow.com` (`GET /v1/models`) | **HTTP `401`**, `{"code":30014,…"message":"Token is invalid."}` |

So the Chinese documentation sites were **always reachable from this machine**; only `web_fetch` could not
read them. Any verdict about *"sites in country X cannot be reached"* needs a **reachability measurement
(an HTTP client speaking to the host)**, never a **fetch-tool error**, because the latter reports the tool's
policy and the former reports the network.

And when a provider genuinely is unreachable from your network, turning it off is the whole change, in
`$DSH_HOME/profiles/<profile>/cordis.patch.yml` (or the plugin's own `providers` field):

```yaml
- id: freellmapi
  config:
    providers:
      someprovider: { enabled: false }
```

Key request pages (the first seven were verified reachable on 2026-10-14):
`groq` <https://console.groq.com/keys>, `cerebras` <https://cloud.cerebras.ai/>,
`openrouter` <https://openrouter.ai/keys>, `mistral` <https://console.mistral.ai/api-keys>,
`zhipu` <https://open.bigmodel.cn/usercenter/apikeys>, `volcengine` <https://console.volcengine.com/ark>,
`longcat` <https://longcat.chat/platform/api_keys>.
**The six 0.7.0 additions' key pages below are the pool's own `keyURL` values and were *not* independently
verified** — only `modelscope`'s carries an upstream citation. (An earlier draft justified that gap with the
claim that Chinese vendor/documentation sites "resolve to non-public addresses" from this machine. **That
claim is withdrawn**: it was a `web_fetch` DNS-guard artefact, and the vendor doc page was in fact fetched
over the direct path — see the reachability table above. The key pages themselves remain unverified; only
the reason previously given for that was wrong.)

| Provider | `apiKeyEnv` | Key page | Free tier (upstream baseline) | Default | Notes |
|---|---|---|---|---|---|
| `groq` | `GROQ_API_KEY` | <https://console.groq.com/keys> | 30 RPM / 1000 RPD / ~8K TPM / 200K TPD | ✅ on | Fast; `openai/gpt-oss-120b`, `llama-3.3-70b-versatile`, `llama-3.1-8b-instant` |
| `cerebras` | `CEREBRAS_API_KEY` | <https://cloud.cerebras.ai/> | 30 RPM / no RPD / 60K TPM / 1M TPD | ✅ on | Two models rated capability 5 **and** speed 5; upstream notes a second, tighter quota revision (5 RPM / 30K TPM) |
| `openrouter` | `OPENROUTER_API_KEY` | <https://openrouter.ai/keys> | 20 RPM / 200 RPD | ✅ on | The `complex` tier's main supplier (`deepseek/deepseek-v3.1:free`, `moonshotai/kimi-k2.6:free`, `qwen/qwen3-coder:free`) |
| `llm7` | `LLM7_API_KEY` | <https://token.llm7.io/> | ~100 req/hour | ✅ on | **Keyless works**; a key raises the ceiling. Key page is reported, not independently verified |
| `kilo` | `KILO_API_KEY` | — | ~200 req/hour per IP | ✅ on | **Keyless works.** Free traffic is logged for training |
| `github` | `GITHUB_MODELS_TOKEN` | — | 10 RPM / 50 RPD | ⬜ off | Has `openai/gpt-5`; the rate limits are punishing |
| `mistral` | `MISTRAL_API_KEY` | <https://console.mistral.ai/api-keys> | 500K TPM | ⬜ off | `mistral-large-latest`, `magistral-medium-latest`, `codestral-latest` |
| `zhipu` | `ZHIPU_API_KEY` | — | ~1M TPD | ⬜ off · ⚠️ **speculative** | `glm-4.7-flash`, `glm-4.6v-flash`. **`baseURL` is the single riskiest row in the pool**: the mainland and overseas sites do not share keys, and picking the wrong hostname gives a guaranteed 401. Enable it only if you know which site your key belongs to. |
| `volcengine` | `ARK_API_KEY` | — | ~2M TPD | ⬜ off · ⚠️ **speculative** | Chinese provider, real-name registration required; the model id is inferred, not verified |
| `longcat` | `LONGCAT_API_KEY` | — | — | ⬜ off · ⚠️ **speculative** | No real-name requirement; model id inferred, not verified |
| `nvidia` | `NVIDIA_API_KEY` | — | 40 RPM | ⬜ off | High capability ceiling (`qwen/qwen3-coder-480b-a35b-instruct`), but "evaluation only" trial ToS, first token can take minutes, and see the known gap in [Limitations](#limitations-and-unverified-claims) |
| `ovh` | `OVH_AI_ENDPOINTS_KEY` | — | 2 RPM | ⬜ off | **Keyless works**, but 2 RPM only |
| `modelscope` | `MODELSCOPE_API_KEY` | <https://modelscope.cn/my/myaccesstoken> | Upstream wrote 2 000 req/day, then marked that figure historical (billing moved to magic grains 魔粒) | ⬜ off | Alibaba's ModelScope (魔搭). **A token only serves traffic once the account is bound to an Alibaba Cloud China-site account with Chinese real-name verification** — unbound tokens answer `401 please bind your alibaba cloud account before use` on every call. Its `GET /models` answers `200` for *any* credential, so it cannot validate a key; use a 1-token chat instead |
| `xfyun` | `XFYUN_API_KEY` | <https://console.xfyun.cn/> | No published token/QPS ceiling — upstream sets `null` rather than guessing | ⬜ off · ⚠️ **speculative** | iFlytek Spark (讯飞星火). **Chinese real-name verification required.** Auth is the console *APIPassword* as a bearer token. Its model id `lite` is now **vendor-documented, not a placeholder**: the official HTTP API page (`spark-api-open.xf-yun.com/v1`, fetched 2026-10-15 over the direct path) lists `4.0Ultra` / `generalv3.5` / `max-32k` / `generalv3` / `pro-128k` / `lite` as the accepted `model` values, and its version table describes **Lite** as 轻量级 and **支持免费使用** (*supports free use*). Still **not exercised with a valid credential here**; `confidence` stays `speculative` |
| `siliconflow` | `SILICONFLOW_API_KEY` | <https://cloud.siliconflow.com/account/ak> | **No recurring free chat tier** — the `.com` endpoint is a one-time $1 trial credit | ⬜ off · ⚠️ **speculative** | SiliconFlow (硅基流动). **Chinese real-name verification required.** Upstream keeps the platform for its **free generative-media** models (image/TTS), which this plugin's LLM seam cannot consume; the chat model it once listed is **paid** ($0.06/M) and upstream deleted that row |
| `sambanova` | `SAMBANOVA_API_KEY` | <https://cloud.sambanova.ai/apis> | **None — the free tier was permanently retired.** With a valid key, chat answers `402 payment method required` | ⬜ off · ⚠️ **speculative** | **Listed for the record, not as a free tier.** Upstream dropped it in V23 for exactly that reason. Its `baseURL` is **not** transcribed from upstream (zero matches there) but taken from vendor documentation, and its `/models` still answers `200` — which upstream itself records as a billing-gate false positive |
| `huggingface` | `HUGGINGFACE_API_KEY` | <https://huggingface.co/settings/tokens> | Recurring **$0.10/mo** router credit, no card required (upstream: ~1–3M tokens/month on a 70B) | ⬜ off | The Inference Providers router. Free-ness there is an **account credit, not a catalog flag**: of the 296 provider rows in its catalog, **0** report `is_free: true`. `contextWindow` differs per backend for the same id |
| `routeway` | `ROUTEWAY_API_KEY` | <https://routeway.ai/> | Docs say 20 RPM / 200 RPD; an upstream live test saw a stricter 5 RPM — upstream contradicts itself, so every limit is `null` | ⬜ off · ⚠️ **speculative** | An aggregator with `:free` routes. **Its anonymous chat path is an open `AMBIGUOUS`** (see above); a `User-Agent` disguise is *not* what unlocks it — the `Authorization` header is |

> **Read those six rows as "catalogued", not as "free and working".** All six ship **disabled**
> (`enabled: false`), each needs a key you supply yourself, and **none of them is part of the "install and it
> works" default set** — that set is `groq`, `cerebras`, `openrouter`, `llm7`, `kilo`, unchanged in 0.7.0.
> What the free-tier column actually means:
>
> - **`huggingface` and `routeway` are the only two with reusable free *chat* quota evidence**, and in both
>   cases it is upstream's own statement (a recurring $0.10/mo router credit; `:free` routes cost $0).
>   Neither has been verified here with a real key.
> - **`sambanova` has no free tier left.** It is in the pool so that the entry is on record, not so that you
>   can use it for free.
> - **`siliconflow`'s free half is the half this plugin cannot use** — the free models are generative media,
>   the chat model is paid. `modelscope` and `xfyun` publish no limits, so their free quota **cannot be
>   verified without a credential**; do not read `enabled: true` on those two as a promise of free capacity.
> - **`xfyun` and `siliconflow` require Chinese real-name verification** before a key serves traffic, and
>   `modelscope` additionally needs the Alibaba-Cloud-China-site binding. That is a real barrier to the
>   "zero config" story, and it is why these rows are labelled rather than enabled.
> - ⚠️ **speculative** marks the entries whose pool `confidence` is `speculative`: the transcription is
>   best-effort and can be wrong. `xfyun`'s model id is no longer the example — it is vendor-documented now
>   (see its row above); what remains unverified for it is that no valid credential has ever used it.
>   Enabling one is you accepting that.
> - **The key rows in the settings card will not grow for any of these six** while they stay disabled. That
>   is expected: the browser table is generated at build time from `enabled === true` entries only (see
>   [Adding keys](#adding-keys) and the 0.6.1 note in the changelog). Enable one and set its `apiKeyEnv`
>   yourself, or paste the key in the plugin's own settings page.

> **`apiKeyEnv` is this plugin's own convention, not an upstream fact.** freellmapi has no such concept —
> its keys live behind its dashboard in an encrypted store. Every name above is a *default* that you can
> override per provider, which is what makes a wrong guess harmless:

```yaml
providers:
  groq:
    apiKeyEnv: MY_GROQ_KEY        # any name you like
  mistral:
    enabled: true
  acme-gateway:                   # a provider that is not in the built-in pool at all
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

## How to read the model list

The picker is built from three groups, in this order:

1. **The virtual routes** — `auto`, `auto:simple`, `auto:medium`, `auto:complex`. These always exist.
2. **Every model whose provider can actually serve it** — keyless providers, plus providers whose
   credential resolved.
3. **One `setup:<provider>` guidance entry per enabled provider that has no usable credential.**
   It replaces that provider's model rows, because those rows would only end in
   `MISSING_CREDENTIAL` if you picked one.

A provider that is **disabled** (`enabled: false`, which includes thirteen of the eighteen by default)
contributes nothing at all, so its models never appear.

`setup:` entries are **not models**. Selecting one sends no request — it is a signpost whose name carries
the exact environment variable and where to get a free key:

```text
setup:groq        Groq ▸ needs GROQ_API_KEY (free key: console.groq.com/keys)
setup:cerebras    Cerebras ▸ needs CEREBRAS_API_KEY (free key: cloud.cerebras.ai)
setup:openrouter  OpenRouter ▸ needs OPENROUTER_API_KEY (free key: openrouter.ai/keys)
```

| What you configured | What the picker shows |
|---|---|
| **Nothing** (zero credentials) | **13 entries**: the 4 virtual routes, then the 6 models of the two keyless providers (`llm7/codestral-latest`, `llm7/DeepSeek-V4-Flash-0731`, four `kilo/…:free`), then 3 guidance entries (`setup:groq`, `setup:cerebras`, `setup:openrouter`). Nothing that cannot answer. |
| **`GROQ_API_KEY` set** | **15 entries**: the same shape, but `groq`'s three real models appear (in the pool's own order, so they lead the concrete rows) and `setup:groq` is gone. `setup:cerebras` and `setup:openrouter` remain. |

The list is rebuilt on every `listModels()` call, so after you set a key you only need to **reopen the
picker** — the real models appear and that provider's guidance entry disappears. No restart, no config
edit.

The reason for the fold: in the zero-credential install of v0.2.0 the picker advertised 21 entries, of
which only 6 could answer — and the unreachable Groq/Cerebras rows happened to sit at the very top. That
is a picker that looks broken. Working models are now sorted ahead of the guidance, always.

## Pinned models are strict

`auto` and `auto:simple|medium|complex` ask the plugin to **choose**. Any other model id — the composite
`provider/model` from the picker, or a bare id such as `llama-3.3-70b-versatile` — is a **pin**: it asks
for that one model, and the plugin will never answer with a different one.

That strictness is the point. Up to v0.2.0 a pinned model could be **silently substituted**: with no key
configured, picking `Llama 3.3 70B · Groq` was answered by a different provider's model and reported as a
successful turn, and a completely invented id (`totally-made-up-model-xyz`) was answered too. Nothing in
the transcript said so. Since v0.3.0 a pin that cannot be served fails loudly, before any provider is
contacted:

| Situation | Failure code | What the message tells you |
|---|---|---|
| The provider serving that model has no credential | `MISSING_CREDENTIAL` | Which exact environment variable is missing, where to get a free key, that you can paste it in the DSH settings page instead, and that `auto` works right now |
| No provider in the pool serves that id | `UNKNOWN_MODEL` | The three closest model ids in the pool, whether the provider prefix you used is merely disabled, and a suggestion to use `auto` |
| It exists, but every provider serving it is gated out (cooldown, vision, tools, context window) | `MODEL_UNAVAILABLE` | The per-candidate exclusion reasons, and a suggestion to use `auto` or retry after the cooldown |

All three end the stream as an in-band `finish` error chunk with **zero upstream requests** — that last
part is what the tests assert, because "reports an error after quietly asking somebody else" would be the
same bug wearing a hat.

**`auto` and the tier overrides are unaffected.** They deliberately select freely inside the pool and fail
over between candidates; that is what they are for. If you want the plugin to decide, use `auto`.

## How it picks a model

Every request is scored by a **pure, deterministic classifier** (`lib/complexity.js`): no clock, no
randomness, no network, no mutation. The same conversation always routes the same way, and every signal
that produced the verdict is reported.

### The three tiers

| Tier | Score | What it means for ranking |
|---|---|---|
| `simple` | `< 0.34` | Capability counts 0.25, speed 0.75 — take the fastest model that can do the job |
| `medium` | `0.34 – 0.67` | 0.50 / 0.50 — balanced |
| `complex` | `≥ 0.67` | Capability 0.80, speed 0.20 — take the strongest model, latency be damned |

### The signals

Seven signals, each normalised to `[0, 1]` and multiplied by its own weight. They are combined with a
**noisy-OR**, so several independently demanding facets compound instead of averaging away:

```text
score = 1 − Π (1 − wᵢ · sᵢ)  −  simplePenalty
```

| Signal | Weight | Saturates at | What it reads |
|---|---|---|---|
| `tokens` | 0.46 | 2 500 estimated tokens | Input size. CJK counts ≈ 1 token/char, Latin ≈ 1 token/4 chars |
| `tools` | 0.52 | 8 tool schemas | Every tool the model must follow instructions for |
| `keywords` | 0.60 | 2 distinct word families | `refactor`, `architect`, `prove`, `debug`, `重构`, `架构`, `证明`, `为什么`, … |
| `reasoning` | 0.50 | — | Math notation (0.25), comparison words (0.25), "step by step" (0.5) |
| `code` | 0.32 | 2 blocks / 120 lines | Fenced code blocks (40 %) and their line count (60 %) |
| `depth` | 0.20 | 20 messages / 6 turns | Conversation length and assistant+tool turns |
| `images` | 0.06 | 2 images | Presence of an image — plus a **hard floor at `medium`**, because only a vision-capable model can serve it |

Simple-task words (`translate`, `summarize`, `list`, `翻译`, `总结`, `列出`, …) **subtract** a 0.22 penalty —
the one place a signal can lower the score.

### Worked examples (measured, not invented)

Run against this implementation:

| Request | Tier | Score | Why |
|---|---|---|---|
| `列出这个目录下的文件` | `simple` | 0.000 | 10 tokens, one simple-task keyword that subtracts everything |
| `解释这段代码` + a 200-line fenced block | `medium` | 0.349 | 659 estimated tokens and 200 code lines — just over the `medium` boundary |
| `重构这个模块并给出架构权衡与失败模式分析` + 12 tool schemas | `complex` | 0.822 | 12 tools, 4 complexity keywords, 1 comparison marker — and only ~27 tokens, which a weighted *mean* would have averaged away |

And what the tier actually changes, with the default pool and every key configured:

| Rank | `simple` | `complex` |
|---|---|---|
| 1–5 | cerebras `llama-4-maverick-17b` (c5/s5), cerebras `qwen-3-coder-480b` (c5/s5), cerebras `gpt-oss-120b` (c4/s5) | same two c5/s5 models, then kilo `nemotron-3-super-120b` (c5/s3) |
| 6–7 | cerebras `llama3.1-8b` (c2/s5), groq `llama-3.1-8b-instant` (c2/s5) | openrouter `deepseek-v3.1:free` (c5/s3), `kimi-k2.6:free` (c5/s3) |
| 16–17 | openrouter `qwen3-coder:free` (c5/s3), `nemotron-nano-12b-v2-vl` (c3/s3) | cerebras `llama3.1-8b` (c2/s5), groq `llama-3.1-8b-instant` (c2/s5) |

(The two Cerebras models are rated capability 5 *and* speed 5, so they legitimately top every tier. The
tier decides the order **below** them, and that is where a small fast model jumps from 17th to 6th.)

### When it gets it wrong, and how to override it

**This is a heuristic, not semantic understanding.** It counts tokens, fences, tool schemas and words. It
can be wrong in both directions, and here are real cases from this implementation:

| Request | Tier | Why it is wrong |
|---|---|---|
| `证明这个定理` ("prove this theorem") | `simple` (0.304) | One complexity word family saturates only halfway, and the request is six tokens long — a genuine reasoning task lands in the fast lane |
| 3 750 tokens of keyword-free prose | `medium` (0.463) | Tokens alone cap out at 0.46, below the `complex` boundary — a long, demanding analysis never reaches `complex` on size alone |
| `翻译这段话` + 12 tools | `medium` (0.413) | The tool signal pushes it up while the simple-task penalty pulls it down |

So when *you* know better than the classifier, say so — the model id **is** the override:

| Model | Effect |
|---|---|
| `auto` | Classify, then route (the default) |
| `auto:simple` | Force the fast lane |
| `auto:medium` | Force the balanced lane |
| `auto:complex` | Force the strongest lane |

Any **other** id — `llm7/codestral-latest`, or a bare `llama-3.3-70b-versatile` — is a strict pin rather
than a lane: see [Pinned models are strict](#pinned-models-are-strict).

The classifier still runs for the forced tiers — the score and the reasons are recorded, and the log line
says `(forced by the selected model id)` — but the tier no longer decides.

Tuning, if you want to bend the thresholds rather than pin a lane (advanced; edit in the profile patch):

```yaml
routing:
  thresholds:
    medium: 0.25      # default 0.34 — more requests become "medium"
    complex: 0.55     # default 0.67 — more requests become "complex"
  weights:
    tokens: 0.60      # standalone maximum contribution, not a share of a total
    tools: 0.40
```

## Failover and health

**The one hard rule: failover may only happen before a single chunk has reached DSH.** Once any chunk has
been yielded — even a bare `block-start` — a failure ends the stream with an error instead of switching
provider, because splicing two models' output into one assistant message is worse than an honest failure.
The rule is enforced twice (in `dispatchOnce` and again in the failover loop), and tested against a socket
that dies mid-stream plus a healthy standby that must receive **zero** requests.

What gets retried:

| Condition | Failover? | Why |
|---|---|---|
| `429`, `408`, `409`, `410`, `422`, `5xx` | ✅ | The provider's problem; the next one may well answer |
| `404` | ✅ | Usually means "this provider does not serve that id" — and it parks the pair, like `model_unavailable` below |
| `400 model_unavailable` | ✅ | **The deliberate exception to "400 is a bad request"**: aggregators rotate their catalogs, so this is a per-`(provider, model)` state → park it exactly like a `404 model_not_found`, then try the next candidate |
| Other `400`s | ❌ | A malformed request stays malformed everywhere |
| `401` / `403` | ❌ | A rejected credential belongs to that provider; the provider is parked for 24 h |

Health and cooldowns:

- **The first retryable failure already parks the candidate**, for 2 minutes — no "three strikes" grace
  period, because a free-tier 429 means "back off now", and paying the same wall twice only adds latency.
  Each further consecutive failure escalates one step: **2 m → 10 m → 1 h → 24 h**. A `Retry-After` header
  overrides the ladder, because the provider is the only party that knows when its budget resets.
- Failures also lower a candidate's score, so a recently failed route ranks below healthy peers:
  `1 / (1 + 0.15 · effectiveFailures)` (floor 0.4). `effectiveFailures` **decays with a 60-second
  half-life**, so the penalty cannot starve a candidate forever: by the time the 2-minute cooldown has
  expired, a single failure weighs only 0.25, and one success clears the counter outright.
- Latency participates only when it is real evidence:
  - the factor is `fastest / latency`, clamped to `[0.85, 1]` and computed against the fastest candidate
    **of this request**;
  - **an unmeasured candidate does not get a perfect score.** With no evidence of its own it is treated as
    "no faster than the slowest factor actually measured in this request"; only when nothing measurable was
    observed does the signal drop out completely (everyone gets 1). Otherwise "we have never looked at it"
    would beat "we measured it and it is slow", which is backwards;
  - a **100 ms noise floor** applies: if the spread between the measured candidates is smaller than that,
    the whole latency signal is discarded as warm-up noise (a 4 ms versus 26 ms localhost difference is not
    throughput), and every candidate scores as unmeasured.
  Because the demotion is capped at 0.85, latency can reorder candidates but cannot overturn the tier's
  capability-versus-speed decision.
- A mid-stream failure does not park the provider (one interrupted stream is weak evidence); it only counts
  as a failure for the next ranking.
- Attempts are bounded by `routing.maxAttempts` (default 6) and `routing.budgetMs` (default 45 000 ms), both
  checked *before* each attempt.

### A request that is simply too large

A session can outgrow the candidate the router picked. Upstream answers that with a `400`
(`maximum context length … However, you requested about N tokens`), and the plugin treats it as a
**per-candidate** condition, not a dead end:

- **It fails over — but only towards a bigger context window.** A candidate whose `contextWindow` is not
  wider than the one that just refused the request is skipped, because retrying a too-large request on a
  smaller model cannot succeed. (Verified: with candidates of 131 072 / 100 000 / 262 144 tokens, the
  100 000 one is never contacted.)
- **The refusal costs the candidate nothing.** It is not parked and does not count as a failure — the model
  is healthy and would answer a shorter request fine. The useful memory is the window it just reported,
  and the gate (plus `routing.contextSafetyFactor`) uses it next time.
- **The hard invariant still holds.** If any chunk has already reached DSH, there is no failover at all
  (`STREAM_INTERRUPTED`); this change did not touch that rule.

When nothing in the pool is wide enough, the error tells you both numbers you need — how big your request
is and how big the biggest reachable model is:

```text
dsh-freellmapi: this request does not fit any model the router can use; it is about 297538 estimated input
tokens; the widest model that refused it declares 262144 tokens; the largest context window in the pool is
262144 (kilo/nvidia/nemotron-3-super-120b-a12b:free); compact the session or lower the attached history,
then retry. — [kilo/small-model → CONTEXT_WINDOW_EXCEEDED; kilo/wide-model → CONTEXT_WINDOW_EXCEEDED]
```

(The line breaks are added for readability here; the real message is one line.) The situation is also a
data question, which is why the context windows are documented in
[Limitations](#context-windows-what-is-measured-and-what-is-estimated).

**Failures come back in-band, not as a crash.** Every outcome below ends the stream with a terminal
`finish` chunk carrying a stable DSH code: no exception ever crosses the adapter boundary.

| Code | Meaning |
|---|---|
| `NO_CANDIDATES` | Nothing usable in the pool — nothing configured and no keyless provider enabled, or every candidate failed a hard gate (vision / tools / context window / cooldown). The message lists key-application entry points. |
| `ALL_CANDIDATES_FAILED` | Every ranked candidate was tried and failed; the message carries a `provider/model → code` trail. |
| `STREAM_INTERRUPTED` | The stream failed after output had already been sent — no failover by design. |
| `MODEL_UNAVAILABLE` | The provider does not currently serve that model. |
| `ABORTED`, `TIMEOUT`, `TRANSPORT`, `AUTH`, `RATE_LIMIT`, `QUOTA`, `CONTEXT_WINDOW_EXCEEDED`, `UNSUPPORTED_CONTENT`, `UNSUPPORTED_OPTION`, `INVALID_REQUEST`, `SERVER`, `MISSING_CREDENTIAL`, `INVALID_CREDENTIAL`, `EMPTY_RESPONSE`, `CONTENT_FILTER`, `UNKNOWN` | The usual per-attempt classifications |

For `429`/`quota_exceeded`, the provider's `Retry-After` (when it sends one) is parsed into DSH's
retry-after field, so the harness backs off for exactly as long as the pool said to.

## Two modes: `direct` and `gateway`

| | `direct` (**default**) | `gateway` |
|---|---|---|
| Who routes | This plugin (classifier + ranker + failover) | An external [freellmapi](https://github.com/tashfeenahmed/freellmapi) gateway |
| Needs an external process | ❌ no | ✅ yes (Docker or `node server/dist/index.js` on `:3001`) |
| Credentials | One key per provider, or none at all | One unified `freellmapi-…` gateway key |
| Model picker | `auto`, `auto:simple/medium/complex`, then `provider/model` | `auto`, `auto:smart/fast/cheap/reliable/balanced`, `fusion`, discovered catalog |
| Log line | `dsh-freellmapi: tier=… -> provider/model (…)` | `dsh-freellmapi: routed via <platform>/<model> (model=…)` |
| Use it when | You want the shortest path from install to a working model | You already run the gateway, or you want its bandit scoring, `fusion`, prompt compression and dashboard |

Switch with one field:

```yaml
mode: gateway            # default is "direct"; gateway also needs baseURL + a freellmapi-… key
```

> **The two modes can coexist in one install, but the `freellmapi` provider name is owned by exactly one
> adapter.** freellmapi's official `npx freellmapi setup-dsh --url http://localhost:3001 --api-key <key>`
> writes an `llm-pi-ai.providers.freellmapi` route, whose DSH provider name is also `freellmapi`. Provider
> route names are unique per process, so whichever adapter registers second is rejected. If you already ran
> `setup-dsh`, remove that route before installing this plugin — the plugin refuses to load with a message
> naming exactly this conflict, rather than failing silently.
>
> And yes: **if the gateway is the only thing you want, `setup-dsh` needs no plugin at all.** It writes
> `$DSH_HOME/settings.yaml` + `$DSH_HOME/.env` (mode `0600`) and sets the default model. This plugin's
> `gateway` mode exists for people who want the routed-via visibility and per-request failure detail on top.

## Configuration

Every field is **live** (a settings edit applies to the next request, no restart) and validated
**totally** — a malformed value falls back to its default instead of preventing the plugin from loading.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `mode` | `direct` \| `gateway` | `direct` | Self-contained routing, or forward to an external gateway |
| `baseURL` | string | `http://localhost:3001/v1` | Gateway mode only: OpenAI-compatible root of the freellmapi gateway |
| `apiKeyEnv` | string | `FREELLMAPI_API_KEY` | Gateway mode only: credential *reference name* (not the key) |
| `apiKey` | string (secret) | `''` | Gateway mode only: optional inline credential; prefer `apiKeyEnv` |
| `providers` | dict or array | `{}` | Per-provider overrides for the built-in pool (see below) |
| `routing` | dict | `{maxAttempts: 6, budgetMs: 45000}` | Routing-engine knobs (see below) |
| `logRouting` | boolean | `true` | Log the direct-mode routing decision (tier, winner, candidates tried) |
| `logRoutedVia` | boolean | `true` | Log `X-Routed-Via` / fallback trail (gateway mode) |
| `vision` | boolean | `true` | Advertise image input when the chosen model supports it; set `false` to force text-only |
| `contextWindow` | number | `131072` | Context window assumed for ids the pool does not describe |
| `maxTokens` | number | `0` | Output cap declared to DSH; `0` = declare none and let the provider decide |
| `timeoutMs` | number | `600000` | Per-attempt timeout in milliseconds; `0` disables it |
| `includeFusion` | boolean | `true` | Gateway mode: advertise the gateway's `fusion` route |
| `exposeDiscoveredModels` | boolean | `true` | Gateway mode: merge `GET /v1/models` into the picker |
| `discoveryTimeoutMs` | number | `5000` | Gateway mode: timeout for that discovery request |
| `discoveryCacheMs` | number | `60000` | Gateway mode: how long a discovery result stays fresh |
| `maxTokensField` | `max_tokens` \| `max_completion_tokens` | `max_tokens` | Which wire field carries the cap. `max_tokens` is the canonical field; the gateway also accepts the other |
| `headers` | map | `{}` | Extra request headers. `user-agent`, `authorization`, `content-type`, `accept` are reserved |
| `taskType` | `''` \| `auto` \| `code` \| `chat` | `''` | Gateway mode: optional `X-FreeLLM-Task-Type` hint (empty sends no header) |
| `cacheMode` | `''` \| `on` \| `off` | `''` | Gateway mode: optional `X-FreeLLM-Cache` switch (empty sends no header) |

> The schema is a static import of `@deepseek-ai/schemastery`, declared in both `peerDependencies` and
> `devDependencies`. There is **no fallback**: if the schema builder cannot be resolved the plugin fails
> loudly at load rather than degrading. That matters because the degradation is invisible downstream — a
> plugin whose `Config` lacks `toJSON()` gets no settings namespace, and the Models page then shows its
> provider *nowhere* while it keeps routing traffic. `pnpm install` in this package during development so
> a `link:`-ed install resolves the builder from its own tree.
>
> No configuration value, however malformed, can stop the plugin from loading.

One environment escape hatch worth knowing: **`FREELLMAPI_BASE_URL`** overrides the gateway endpoint from
the environment, and it is honoured **only while `baseURL` still holds its built-in default**, so an
explicit setting always wins over the environment.

### `providers.<id>` — override one pool entry

| Key | Meaning |
|---|---|
| `enabled` | Turn a provider on/off. This is how you enable the thirteen providers that ship disabled |
| `displayName` | Label used in the picker and logs |
| `baseURL` | Endpoint root — fix a hostname without waiting for a release (see `zhipu`) |
| `apiKeyEnv` | Your own credential reference name for this provider |
| `apiKey` | Inline credential for this provider (stored in the profile patch — prefer `apiKeyEnv`) |
| `keyless` | Mark a custom endpoint as usable without a credential |
| `models` | **Replaces** the built-in model list for that provider. Each entry: `id`, `name`, and `capability` / `speed` (1–5), `contextWindow`, `maxTokens`, `vision`, `toolCalling` — either inline or under `caps` |

A provider that is not in the built-in pool at all is added the same way: give it `id`/`baseURL` and a
`models` list (see [Adding keys](#adding-keys)).

### `routing` — engine knobs

| Key | Default | Meaning |
|---|---|---|
| `maxAttempts` | `6` | Maximum candidates tried for one request |
| `budgetMs` | `45000` | Total failover time budget; `0` = unlimited |
| `contextSafetyFactor` | `1.15` | Safety margin on the context gate: a candidate must satisfy `contextWindow >= estimated tokens × this factor`. The token estimate is a heuristic and **undercounts**, so one model of headroom is cheaper than a 400 from upstream. A value below `1` is rejected and the default applies |
| `thresholds.medium` | `0.34` | Score at which `simple` becomes `medium` |
| `thresholds.complex` | `0.67` | Score at which `medium` becomes `complex` |
| `weights` | per-tier defaults | `{capability, speed}` or `{simple: {…}, medium: {…}, complex: {…}}` |
| `preferredOrder` | `[]` | Provider ids you want preferred; a bounded bonus of at most 0.05 |

### Three ways to set them

1. **Settings page** — **Settings → Plugins → dsh-freellmapi** (every top-level field, with the generated
   form described above).
2. **Profile patch** — `$DSH_HOME/profiles/<profile>/cordis.patch.yml`; the recommended place for
   `providers` and `routing`:

   ```yaml
   - id: freellmapi
     config:
       mode: direct
       logRouting: true
       providers:
         cerebras:
           enabled: true
         kilo:
           enabled: false        # if you do not accept its training-recording terms
       routing:
         maxAttempts: 4
         preferredOrder: [cerebras, groq]
   ```

3. **Environment** — the per-provider `apiKeyEnv` names in [Adding keys](#adding-keys).

## How to see what it did

**Direct mode** logs one line per request:

```text
dsh-freellmapi: tier=complex -> openrouter/deepseek/deepseek-v3.1:free (capability=5, speed=3, 2 candidates tried)
dsh-freellmapi: tier=simple -> no candidate (0 candidates tried)
```

**Gateway mode** logs its original line:

```text
dsh-freellmapi: routed via groq/llama-3.3-70b (model=auto) fallback-attempts=2 trail=groq/… key1=rate_limited; …
```

The plugin also keeps the last 50 routing observations in a process-wide ring buffer — exported as
`getRecentRoutes()` (with `formatDirectRouteLine()` / `formatRouteLine()`) for tests and future UI. Each
record carries the tier, score, chosen provider/model, every attempt and its failure code, the candidates
that were excluded and why, and the classifier's reasons. It is not a DSH tool or service, so the log line
is what you use day to day.

## Just one key? No keys?

**No keys at all:** works, through `kilo` and `llm7` (both enabled and keyless). "Complexity routing" then
means choosing between two pools' worth of models rather than five — still real routing and still
failover-capable, but a much thinner choice.

**Exactly one provider configured:** works, and the classifier still runs — but with a single provider's
models the ranking degenerates into "pick the best model that provider has for this tier". You need **at
least two** providers before routing has anything to route *between*.

**What does *not* happen:** a missing key is never an error. Providers without a usable credential are
dropped from the routing candidates silently — no warning, no "configuration incomplete" banner — and in
the model list they appear as a single `setup:<provider>` signpost instead of rows that cannot answer
(see [How to read the model list](#how-to-read-the-model-list)). That is deliberate: a keyless pool must
keep working on a machine where nothing is configured.

## Architecture

```text
┌───────────────────────────── DeepSeek Harness (host process) ────────────────────────────┐
│                                                                                          │
│  agent loop / chat turn                                                                  │
│       │                                                                                  │
│       ▼                                                                                  │
│  llm service (ctx.llm)     route chosen by GenerateOptions.provider                      │
│       │                                                                                  │
│       ▼                                                                                  │
│  LlmAdapter  (this plugin, provider = "freellmapi")                                      │
│       │                                                                                  │
│       │  the model id decides the lane:                                                  │
│       │    auto            → classify                                                    │
│       │    auto:simple     → force the fast lane                                         │
│       │    auto:medium     → force the balanced lane                                     │
│       │    auto:complex    → force the strongest lane                                    │
│       │    provider/model  → pin exactly one candidate (strict: no substitution)         │
│       ▼                                                                                  │
│  scoreComplexity()  →  simple / medium / complex  +  score  +  reasons                   │
│       │                                                                                  │
│       ▼                                                                                  │
│  listProviderModels()  →  rankCandidates()                                               │
│       │      hard gates: vision · tools · context window · cooldown                      │
│       │      soft: consecutive failures · latency · preferred order                      │
│       ▼                                                                                  │
│  dispatchWithFailover()    attempt 1 ─▶ 429 / 5xx / model_unavailable / timeout          │
│       │                        └─▶ park it, take the next ─▶ attempt 2                   │
│       │                                                                                  │
│       │  ══════════════════════════════════════════════════════════════════════          │
│       │  the first chunk reached DSH                                                     │
│       │    past this line NO failover happens: a mid-stream failure ends the stream      │
│       │    with an error instead of splicing two models into one answer                  │
│       ▼                                                                                  │
│  StreamChunk sequence → DSH                                                              │
│                                                                                          │
└──────────┬───────────────┬───────────────┬───────────────┬───────────────┬───────────────┘
           ▼               ▼               ▼               ▼               ▼
     ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐
     │ groq       │  │ cerebras   │  │ openrouter │  │ kilo       │  │ llm7       │
     └────────────┘  └────────────┘  └────────────┘  └────────────┘  └────────────┘
   kilo and llm7 answer without any key at all      ·      18 pools in total
```

Notes on the seams:

- **Every** outbound request carries DSH's attribution `user-agent` and uses `redirect: 'error'`, so a
  redirect can never leak a credential to a third host.
- Credentials are resolved **per request** (one lookup per provider, not per model) and never cached.
- `stream()` never throws. Every failure is an in-band `finish` chunk, which is what makes the plugin
  immune to module-identity splits — see the red line in [Troubleshooting](#troubleshooting).
- Zero runtime dependencies: no `dependencies` at all, and the DSH LLM runtime is resolved with a guarded
  dynamic import that falls back to local shims outside DSH.

## Troubleshooting

### 1. `401` / `403` — a provider rejects the key

Only one provider is affected; the router parks it (`invalid` ⇒ 24 h cooldown) and continues with the next
candidate. Check:

- Is the key exported under the exact name in `apiKeyEnv` (defaults in [Adding keys](#adding-keys))? You can
  override the name per provider if your shell already uses a different convention.
- Does that provider require something else — signup, real-name verification, or a specific site
  (`zhipu` is the notorious case: mainland and overseas keys do not interchange)?
- An empty string counts as "not configured", so an exported-but-empty variable looks identical to a
  missing one.

### 2. `429` — rate limited, and what happens next

This is normal weather on free pools, not an outage. The candidate is parked immediately, on the first
failure, and escalates the ladder if it keeps failing (`2 m → 10 m → 1 h → 24 h`), using the provider's
`Retry-After` when it sends one; the request continues on the next-ranked candidate. Remedies: add another
provider's key, lower concurrency, or use
`preferredOrder` to steer to the pool with quota left.

### 3. Every candidate failed — where do I look?

The terminal chunk says `ALL_CANDIDATES_FAILED` and carries the trail:

```text
dsh-freellmapi: all 3 candidate(s) failed for tier=medium after 2 attempts — groq/llama-3.3-70b-versatile: RATE_LIMIT; …
```

`NO_CANDIDATES` instead means the pool was empty before any request went out: nothing configured and no
keyless provider enabled, or every candidate failed a hard gate (vision / tools / context window /
cooldown). Its message lists key-application entry points. `STREAM_INTERRUPTED` means output had already
been delivered, so by design there was no failover.

### 4. The model list only shows `auto`, the tier routes and some `setup:` entries

That is the intended zero-credential shape: the virtual routes plus whatever is genuinely reachable. A
`setup:<provider>` entry means that provider is enabled but has no usable credential — set the environment
variable in its name and reopen the picker. See
[How to read the model list](#how-to-read-the-model-list).

### 5. A provider I configured is being skipped

Missing key ⇒ silently dropped from the routing candidates, no warning (the picker shows it as a
`setup:<provider>` signpost instead). Also check:

- `enabled` — thirteen providers ship **disabled**: `github`, `mistral`, `zhipu`, `volcengine`, `longcat`,
  `nvidia`, `ovh`, plus the six 0.7.0 additions (`modelscope`, `xfyun`, `siliconflow`, `sambanova`,
  `huggingface`, `routeway`); turn them on in `providers.<id>.enabled`.
- Hard gates — a model without `vision: true` is excluded from image requests, `toolCalling: false` from
  tool requests, and anything whose `contextWindow` is smaller than the estimated prompt size.
- Cooldowns — a recently failed candidate is parked; the `exclusions` list in the routing record says so
  explicitly ("cooling down for another Ns after …").

### 6. The profile misbehaves or will not start (the dependency red line)

**`@deepseek-ai/dsh-*` must never appear in this plugin's `dependencies`.** It ships **zero** runtime
dependencies, and it does not even import the DSH LLM runtime statically: it resolves
`@deepseek-ai/dsh-llm` through a guarded dynamic import and falls back to local shims outside DSH. The only
declared peer is the optional `@deepseek-ai/cordis`.

Why it matters: DSH supplies its runtime through **filesystem junctions** —
`$DSH_HOME/profiles/node_modules/<pkg>` points into the `npx` install cache
(`…\npm-cache\_npx\<hash>\node_modules\…`). A plugin that declares, say, `@deepseek-ai/dsh-llm` as an
ordinary dependency makes the package manager hoist a **second copy** into
`profiles/<profile>/node_modules/@deepseek-ai/`, which then wins module resolution. Class identity breaks
across the copies: `instanceof` fails, error codes silently degrade, and services go missing. The version
range makes it worse — npm's `@deepseek-ai/dsh-llm` only exists in `0.0.1-rc.x`–`0.1.x`, far below the
`0.2.0-rc.2` runtime this plugin targets.

Health check — in a healthy profile, the only entries in the *profile's own* scope are `cosmokit` and
`schemastery`:

```powershell
Get-ChildItem "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@deepseek-ai"
```

Anything else (`dsh-llm`, `cordis`, another `dsh-*` adapter) is a leaked dependency. Find the culprit with
`pnpm why @deepseek-ai/dsh-llm` inside the profile, remove it, reinstall, restart.

### 7. `400 model_unavailable` keeps appearing

That is catalog drift on an aggregator (LLM7 rotates models), not a broken install. It carries the same
meaning as a `404 model_not_found`: the `(provider, model)` pair is **parked** (starting at the 2-minute
cooldown step) and the next candidate serves the request. If it happens constantly for one model, remove it
from that provider's `models` list or set `providers.<id>.enabled: false`.

### 8. I picked a specific model and got `MISSING_CREDENTIAL`

**That is intentional** — it is the strict-pinning behaviour described in
[Pinned models are strict](#pinned-models-are-strict). A concrete model id asks for *that* model, and if
its provider has no credential the plugin refuses rather than quietly answering with another provider's
model. The message names the exact environment variable and where to get a free key. Two ways forward:

- set that variable (or paste the key in the DSH settings page), then send the request again; or
- select `auto`, which uses the providers that need no key at all right now.

### 9. `UNKNOWN_MODEL`

The id you asked for is not served by any provider in the pool. The message lists the three closest ids
and tells you when the provider prefix you used is merely disabled. Common causes: a typo, an id copied
from a provider's own docs that is not in this pool, or a model of a provider that ships disabled
(`github`, `mistral`, `zhipu`, `volcengine`, `longcat`, `nvidia`, `ovh`, plus the six 0.7.0 additions) —
enable it under `config.providers.<id>` first. Use `auto` if you just want an answer.

A pinned model that exists but is cooling down reports `MODEL_UNAVAILABLE` instead, with the exclusion
reason for each candidate; `auto` or waiting out the cooldown both work.

## Limitations and unverified claims

Stated plainly, so you know what you are relying on:

1. **The complexity classifier is a heuristic, not understanding.** It counts tokens, fenced code, tool
   schemas and vocabulary. [When it gets it wrong](#when-it-gets-it-wrong-and-how-to-override-it) shows
   three real misjudgements from this implementation. When you know better, pin `auto:simple` /
   `auto:medium` / `auto:complex`, or pin one `provider/model`.
2. **No end-to-end run against real providers.** Every test in this repository runs against in-process
   mock providers, deliberately, so CI stays offline. The only *real* external calls ever made were the
   maintainer's keyless probe (five requests, four 200s and one 404 documented in
   `_lead/live-probe-2026-10-13.md`) plus the credential-free reachability and catalog probes behind the
   reachability section above (`_lead/research/reachability-v0.7.md`, 2026-10-15). **No completion has ever
   been requested with a real key**, so everything else — every keyed provider, every quota number, every
   model id except the ones a public catalog publishes — is **documentation-level evidence**, not
   measurement.
3. **Only credential-free requests were ever made.** `groq`, `cerebras`, `openrouter`, `github`, `mistral`,
   `nvidia` and the rest were contacted without credentials (status codes and public catalogs only, never a
   completion), so their `baseURL`s and model ids come from upstream's registry and migrations. Rate-limit
   numbers are the 2026-04 baseline and will drift.
4. **`zhipu` is the riskiest entry in the pool**, and `volcengine` / `longcat` model ids are inferred —
   all three ship **disabled** with `confidence: 'speculative'`. Enabling them is you accepting that risk.
   The `zhipu` hostname in particular differs between the mainland and overseas sites and the keys do not
   interchange: a wrong hostname is a guaranteed 401.
5. **Free catalogs drift.** The same model id can answer 200 today and `400 model_unavailable` tomorrow.
   The router treats that as a per-model condition (park + next candidate), so it degrades instead of
   failing — but it is normal operation, not a bug.
6. **`stream_error` frame shapes are documentation-level.** Upstream does not pin the JSON shape, so the
   parser recognises the four plausible forms (`type`, `code`, `object`, nested `error`) and treats any
   error-shaped frame as terminal.
7. **The image path is not verified against a real attachments service.** Bytes are read through
   `attachments.imageHostPath()`, the only documented way for an adapter to reach them, and inlined as
   `data:` URLs (up to 20 MB each); if that service differs in your build, each affected image degrades to
   a placeholder text and the request still succeeds. Only two models in the default pool declare
   `vision: true`.
8. **`sessionId` / `purpose` from `GenerateOptions` are not mapped** — Chat Completions has no standard
   field for them.
9. **Health state is not persisted.** Cooldowns live in the process; after a restart a parked provider is
   retried once. `HealthTracker` can round-trip its state, but nothing writes it to disk.
10. **A failed-over answer comes from a different model than the first choice.** When candidate 1 fails,
    candidate 2 answers, and they are different models. That is safe (nothing was emitted yet) and fully
    recorded in the routing record's `attempts`, but the answer is not from the top-ranked model.
11. **`nvidia` needs `parallel_tool_calls: false`.** Several NIM models reject parallel tool calls, so the
    pool declares the flag and it is applied to the request body. NVIDIA still ships disabled by default
    (trial-only ToS, minutes-long first token, tight limits).
12. **`routing.weights` / `routing.thresholds` are advanced fields** with no rendered form in the settings
    page (they are `z.any()` payloads). Edit them in the profile patch.
13. **Still open from the v0.1.0 verification round** (re-checked against this implementation):
    `maxTokens` above `Number.MAX_SAFE_INTEGER` still makes `resolveModel()` return metadata DSH refuses
    (`INVALID_MODEL_MAX_TOKENS`); a `role: "user"` message whose `content` is a plain string is still sent
    with empty content; in gateway mode `includeFusion: false` can still be undone by the gateway's own
    `fusion` entry; and `discover()` can still return duplicate ids (DSH de-duplicates them). `L1` — the
    incomplete failure-code list — is fixed.

### Context windows: what is measured and what is estimated

Every model's `contextWindow` decides whether a request is even attempted (see
[A request that is simply too large](#a-request-that-is-simply-too-large)), so a wrong number hurts twice:
too large and the router picks a model that will refuse the request; too small and a model that could have
served it gets filtered out before the first byte.

The four `kilo` models were wrong in exactly those two directions and were corrected on 2026-10-14 from
kilo's own `GET /api/gateway/models`:

| Model | Was | Now (measured) |
|---|---|---|
| `kilo/nvidia/nemotron-3-super-120b-a12b:free` | 1 000 000 | **262 144** |
| `kilo/nvidia/nemotron-3-ultra-550b-a55b:free` | 131 072 | **1 000 000** |
| `kilo/poolside/laguna-s-2.1:free` | 131 072 | **262 144** |
| `kilo/cohere/north-mini-code:free` | 131 072 | **256 000** |

**Every other context window in the pool is either a catalog reading or an estimate.** Those providers'
`GET /v1/models` answers `403` without a credential, and OVH's endpoint — although it answers `200` — does
not publish a context field at all. The `source` note on each entry in `lib/providers.js` says where its
number came from and when; treat anything that does not say "measured" as an estimate. Measured rows
include `llm7`'s two (`context_window.tokens`), `sambanova`'s four and `routeway`'s four
(`context_length`, both catalogs fetched anonymously on 2026-10-15 — two `routeway` `:free` routes declare
**42 000**, not the 62 000 the rest of its `:free` family declares), and `huggingface`'s two, whose number is
the **selected backend's** `context_length` and deliberately not the largest one on offer. The six 0.7.0
additions that ship disabled are otherwise conservative defaults: `modelscope`'s catalog publishes no
context field at all, and `xfyun`'s and `siliconflow`'s catalogs need a credential nobody here has.

If a provider in your install reports a different window, override it per model — no code change needed:

```yaml
providers:
  groq:
    models:
      - id: llama-3.3-70b-versatile
        name: Llama 3.3 70B
        capability: 4
        speed: 5
        contextWindow: 131072     # your number wins
        toolCalling: true
```

## Compatibility

| Component | Supported | Notes |
|---|---|---|
| DeepSeek Harness runtime | `0.2.0-rc.2` (written and verified against it) | Other `0.2.0-rc.x` builds are likely fine; only stable LLM seam APIs are used |
| Node.js | `>= 22` | Matches the reference DSH plugins |
| Provider APIs | OpenAI-compatible `POST {baseURL}/chat/completions` with SSE | Everything in the pool speaks the same wire |
| `dsh-freellmapi` | `0.7.5` | Zero runtime dependencies; the DSH LLM runtime is resolved at load time; peers are `@deepseek-ai/schemastery` (the config schema) and the optional `@deepseek-ai/cordis` |
| freellmapi gateway | `v0.13.x` protocol surface | Only relevant in `gateway` mode |

> Version-numbering note: the upstream gateway's releases are `v0.13.x`, while the npm CLI package
> `freellmapi` (which provides `setup-dsh`) is versioned independently (e.g. `0.8.1`). Do not treat the two
> numbers as the same series.

## Development

```bash
npm test          # offline test suite — no network, no provider, no API key required
```

The suite is hermetic on purpose: it must pass on a clean GitHub runner, so it never contacts a real
provider. CI runs the same command on `ubuntu-latest` with Node 22 (`.github/workflows/ci.yml`).

```text
dsh-freellmapi/
├── lib/
│   ├── index.js        # plugin entry: apply(), adapter, listModels/resolveModel/stream
│   ├── config.js       # the config schema and its total normalisation (DEFAULTS is authoritative)
│   ├── providers.js    # the built-in pool + per-provider overrides + credential resolution
│   ├── complexity.js   # the classifier: signals, weights, thresholds
│   ├── router.js       # pure candidate ranking (gates, health, latency, preferred order)
│   ├── health.js       # cooldowns, failure counts, latency EWMA
│   ├── dispatch.js     # one provider attempt + the failover loop
│   ├── wire.js         # GenerateOptions → OpenAI-compatible request
│   ├── sse.js / frames.js / translate.js   # SSE → DSH StreamChunk
│   ├── errors.js / routes.js / catalog.js / runtime.js / types.js
├── tests/              # offline tests (411 of them)
├── tools/gate.mjs      # the project gate — one command, one verdict (npm run gate)
├── docs/               # EXPANSION-v0.7.md (task brief) · NEW-SESSION.md (bootstrap)
├── IMPLEMENTATION.md   # design notes, including every deliberate deviation
├── PROJECT-RULES.md    # operating manual: PDCA loop, 8 hard rules, lesson ledger
├── README.md / README-zh.md / CHANGELOG.md / NOTICE / LICENSE
└── .github/workflows/ci.yml
```

## Upstream and credits

This plugin is a **derived work of [freellmapi](https://github.com/tashfeenahmed/freellmapi)**
(Copyright © 2026 Tashfeen Ahmed, MIT). Saying so plainly matters, because the earlier revisions of this
README mentioned that project only as "the external gateway `gateway` mode can forward to" — which reads as
though the plugin were independent of it. It is not:

- **The provider catalogue** in `lib/providers.js` is transcribed from freellmapi's own sources —
  `providers/index.ts`, `server/src/db/migrations/20260101_000000_legacy_baseline.ts` and
  `docs/en/providers/*`. Each entry carries a `source:` or `note:` field naming the upstream file and line
  range it came from; those citations are the provenance record.
- **The failover/cooldown policy** in `lib/health.js` follows freellmapi's own escalation ladder.
- **The routing model** — score the request, pick a tier, fail over across providers — is freellmapi's
  design.

What is *not* derived: no upstream file is vendored here (upstream is TypeScript; this package is plain
JavaScript and shares no file with it), and the DSH integration — adapter, provider route, settings schema,
browser half — is this package's own, written against the DSH plugin contract. `apiKeyEnv` names are this
package's convention, since DSH resolves credentials by reference name and each provider needed a stable
one.

The upstream MIT notice and licence text are reproduced in full in [`NOTICE`](./NOTICE), which ships with
the package as its licence requires.

## License

[MIT](LICENSE) © 2026 lion231226 — a derived work of freellmapi; see [`NOTICE`](./NOTICE).

Not affiliated with, endorsed by or supported by any provider in the pool, the freellmapi project, or
DeepSeek. Provider names belong to their owners; "DeepSeek Harness" and `@deepseek-ai/*` are DeepSeek's.
Free tiers have quotas, terms and privacy policies that are yours to comply with — several of them log or
train on what you send. Upstream describes itself as "personal experimentation only"; read their terms
before deploying either project.



