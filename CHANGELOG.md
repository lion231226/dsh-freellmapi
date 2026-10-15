# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.7.8] - 2026-10-15

**Two of groq's three models had been retired upstream and were still shipped as default-on.** Measured with a
real credential, which is the only way this was ever going to be found.

### Fixed

- **`groq` shipped two dead model ids.** `GET https://api.groq.com/openai/v1/models` serves **11 models**, and
  neither `llama-3.3-70b-versatile` nor `llama-3.1-8b-instant` is among them — both answer **HTTP 404**. They
  were **default-enabled**, so the default `groq` pool was two-thirds dead.

  Both are replaced by ids verified live in the same run:

  | replaces | with | tool calling | context |
  |---|---|---|---|
  | `llama-3.3-70b-versatile` | `qwen/qwen3.8-27b` | **measured**: structured `tool_calls`, valid JSON | 131,072 (measured) |
  | `llama-3.1-8b-instant` | `openai/gpt-oss-20b` | **measured**: structured `tool_calls`, valid JSON | 131,072 (measured) |

  Every field on the two new rows carries its method in `source:` — the listing it came from, the tool probe
  that established `toolCalling`, and the day it was measured. `capability`/`speed` keep the ratings of the
  rows they replace, which is a **judgement, not a measurement**, and is the one thing on these rows not
  traceable to a probe.

- **`limits.note` no longer cites a retired model as its baseline.** The quota figures came from a 2026-04
  baseline built on `llama-3.3-70b`, so they are now labelled a **conservative historical baseline** rather
  than a description of anything currently on sale.

- **The READMEs no longer present retired ids as current** — the provider table, the pinning examples, the
  worked routing examples, the sample routing log and a YAML snippet all named models that no longer exist.
  The worked examples were relabelled from live models onto the current pool rather than left as plausible-
  looking fiction.

### Notes on scope

- **The gate could not have caught this, and still cannot.** `tools/gate.mjs` G7 probes **provider-level**
  reachability: one `GET /models` per provider, checking 200/401/403. It never compares a **model id** against
  what the provider actually serves, so "the provider is up, but the id we transcribed is retired" is invisible
  to it. This is the same gap that let four dead OpenRouter ids ship until a user reported them (0.7.1).
  An **id-level check** for credential-free providers is the obvious next gate; for keyed providers it can only
  run when a credential is present. Recorded, not yet built.
- **A measurement method worth keeping.** The tool-calling probe's control request originally used the same
  "call the tool" prompt as the test, so the model tried to call it anyway and the control failed with
  `400 tool_use_failed: "Tool choice is none, but model called a tool"`. The run correctly reported
  **NOT MEASURED** rather than a verdict, and the control was changed to a prompt that does not invite a call.
  A control has to be a request the provider should answer *without* the feature under test.
- **`reasoning_effort`, measured at last.** groq validates the field and rejects unknown values with an explicit
  allowlist — `` `reasoning_effort` must be one of `low`, `medium`, or `high` `` — and the vocabulary is
  **per model** (`qwen/qwen3.8-27b` also accepts `none`; both gpt-oss models reject it). This is the evidence
  the anonymous probes could not obtain, and it means a `reasoning` declaration, if added, must be per model.
  Not implemented in this release.

## [0.7.7] - 2026-10-15

**A README section for the one thing a user most needs to know, and could not find.**

### Documented

- **"Long-running agent sessions: read this before you pick `auto`"** — added to both READMEs (and their tables
  of contents). The most actionable finding of the 0.7.2–0.7.6 work had been recorded only in the workspace
  notes: that a long agent session and a single request are different shapes of problem, and that `auto` is
  built for the second.

  It states, in the user's terms: what capacity `auto` declares and why it is bounded by the pool; that a
  summarisation call carries the history it is compressing, so it cannot succeed on a model that cannot hold
  it, at any retry; that the summary is written by whichever model the router picks, over a pool whose windows
  differ by more than an order of magnitude; and what to do instead — **pin a model explicitly for long agent
  tasks**, because pinning is strict by design and never substitutes behind your back.

  It also records what the plugin now does about it (compaction calls are never pinned, carry a capacity floor,
  and fail loudly rather than looping) and an **honest status line**: this reduces the failure, it does not make
  a free pool equivalent to one wide-window model.

### Notes on scope

- **This is documentation, not a fix.** The measured details stay in
  `_lead/research/routing-redesign.md`; the README carries what changes a user's decision.
- **Why it took a release to appear.** The finding was in the workspace notes from the moment it was measured,
  and the release notes mentioned it — but the README is where a user picks a model, and it said nothing. A
  finding that does not reach the place where the decision is made has not really been reported.

## [0.7.6] - 2026-10-15

**`auto` no longer declares a capacity wider than the models it will actually route to.** This is P2, the gap
0.7.5 recorded rather than hid — and the branch that had to change was not the one the plan named.

### Fixed

- **The capacity `auto` declares to DSH is now `min(pool, config)`, floored at 131,072.** DSH budgets its
  compaction threshold from that declaration, so a declaration wider than what routing may pick lets a session
  grow past the model's real limit. Measured 2026-10-15: `auto` declared **131,072** while a **32,000**-token
  model served every plain request.

  **The fix had to go in a different place than the plan said.** The first attempt changed the *gateway* branch
  of `#modelInfo()`, but in `direct` mode — the default — `auto` is not a `provider/model` pair, so it takes
  the *pin* branch and falls through `caps?.contextWindow ?? config.contextWindow`. The gateway change was
  therefore **inert for the configuration that mattered**, and reverse injection said so: two of three injected
  defects left the guard green because the code they patched never ran. The same two injections turned red once
  the fix moved to the branch `auto` actually uses.

- **Models below the declared capacity are excluded from `auto`**, with an exclusion reason naming the contract
  rather than a silent skip. A pool that cannot reach the floor is treated differently: it declares what it can
  serve (`min(pool, config)`) and keeps every model, because such a pool is already below DSH's 65,536-token
  headroom — imposing the floor there would empty `auto` and help nobody.

- **`config.contextWindow` is now an upper bound, not the exact declaration.** The operator says "budget no more
  than this"; the pool says "and no more than I can serve". Meaning preserved, so no silent semantic change to
  a documented knob — but the *effect* is a behaviour change and is called out here: **enabling a provider whose
  models are smaller than 131,072 tokens no longer brings those models into `auto`.** They remain reachable by
  pinning them explicitly, which the capacity contract deliberately does not constrain.

- **A pinned `provider/model` is never subject to the floor.** The contract exists to constrain `auto`'s own
  choices, not the user's explicit one.

### Added

- **`tests/agent-session.test.mjs`** gained the two assertions this required: a pool that cannot reach the floor
  must declare what it can serve *and stay usable*, and a pool that can reach it must never have a model below
  the declaration served. The second fixture is load-bearing — with the original harness pool, both the correct
  rule and the naive `config.contextWindow` return 131,072, so that fixture **cannot tell them apart**.

### Notes on scope

- **Why the floor is 131,072 and not "just above DSH's headroom".** DSH's threshold is
  `min(W × 0.8, W − 65,536)`. Declaring 65,537 — just above the headroom — makes the second term **1**, which
  would compact on essentially every step: a worse failure than the one being fixed. 131,072 keeps the
  threshold at 65,536, the value DSH was already using.
- **Reverse injection (on a copy)**: 3/3 injected defects reddened the guard — ignoring the pool again,
  ignoring what a small pool can serve, and letting routing back below the declaration — with the copy's sha256
  compared before and after each. The first run reported 1/3, and that partial result is what exposed the
  wrong branch.

## [0.7.5] - 2026-10-15

**An agent-session harness — and it found a real defect on its first run.**

### Added

- **`tests/agent-session.test.mjs`** drives a *growing* conversation through the adapter turn by turn, because
  every guard until now checked a single request and the reported problem is about what happens as a session
  grows. Four assertions:

  - a session that outgrows the cheap model **stops being routed to it**, and the small model is never sent a
    request it cannot hold (an upstream 400 is the failure being prevented, not the symptom);
  - a summary call in a grown session is served **only** by a model that can hold the history being summarised
    — the 0.7.2 fix, now asserted across a session instead of one call;
  - one streamed answer never mixes two providers (the invariant `dispatch.js` documents);
  - the capacity `auto` declares to DSH covers every model the session can actually route to.

  The pool is deliberately the shape that broke: a small-window model that wins on capability and speed, plus
  two larger ones that do not.

### Known gap (named, not hidden)

- **The fourth assertion fails, and that is the finding: `auto` declares
  `contextWindow: 131072` while the router serves a `32000`-token model** — and it does so for every plain
  request. DSH budgets its compaction threshold from the declared capacity (131,072 gives a threshold of
  65,536), so a session may grow to ~65k against a model that holds 32k. The 0.7.2 work stops that from
  *failing* — the per-request gate moves the turn to a wider model — but the declaration still overstates what
  routing may pick, so a session is steered to the edge and then has to fail over at it.

  The fix is the semantic change tracked as **P2**: declare a capacity routing cannot undercut
  (`min(pool, config)`, clamped to a floor just above DSH's 65,536-token headroom, with smaller models excluded
  from `auto`). It changes what `config.contextWindow` *means*, which this project requires sign-off for, so
  the test ships **skipped with the defect named in it** rather than deleted, and rather than loosened until it
  agreed with the code — a guard edited until it passes measures nothing.

### Notes on scope

- **The skip is a recorded defect, not a pass.** `node --test` reports it as `skipped 1`; G5 counts it as
  neither a pass nor a failure, and the reason string names the defect, the values involved, and the tracked
  fix.

## [0.7.4] - 2026-10-15

**`reasoning_effort` was sent to every provider. Whether any of them accept it was never established, so it is
now withheld by default — and the withholding is reported.**

### Changed

- **`reasoning_effort` is no longer forwarded by default.** The adapter takes DSH's `reasoningEffort` and wrote
  it into every request body as the OpenAI-compatible `reasoning_effort` field — verbatim, to every provider in
  the pool. Nothing in the pool's provenance mentions that field, and the question could not be settled
  anonymously: probing four providers (kilo, llm7, openrouter, ovh) with a control request and with
  `low`/`medium`/`high`/`max` returned **byte-identical responses to the control in every case**, because all
  four reject at authentication or model resolution and never reach field validation. That is an `AMBIGUOUS`
  measurement, not evidence of support.

  Sending an unverified control at endpoints that may not know it means the complaint arrives from upstream,
  after a wasted request and a failover — the silently-degrading shape rule 1 forbids. Set
  **`forwardReasoningEffort: true`** to send it anyway, once a real credential has established which values a
  provider accepts.

- **The withheld value is reported, not hidden.** When a request carries a `reasoningEffort` that will not be
  forwarded, the routing log records it — control, value and reason. A request control that DSH believes it set,
  and that never reaches a provider, must leave a trace or it is a silent degradation.

### Added

- **`forwardReasoningEffort`** (default `false`) and `suppressedReasoningEffort(options, config)`, exported from
  `lib/wire.js` so the decision to drop a control is one named function rather than an inline condition.

- **Five guards**: the default withholds the field; the opt-in forwards it; the suppression helper reports
  exactly what it withholds (including `null` and absent); end to end, the field is absent from the upstream
  body *and* the drop appears once in the log; and opting in produces no log line.

### Notes on scope

- **This does not make `auto` support reasoning effort — it stops it from pretending.** Withholding is the
  honest default, not a feature. Establishing which values each provider accepts needs a real credential; the
  path is recorded in `_lead/research/routing-redesign.md` §E.
- **A mechanism I nearly implemented does not exist.** The first plan was to declare
  `adapterDefaults.reasoningEffort: true` as an "adapter owns this field" opt-out. Reading the artifact showed
  `adapterDefaults` is **computed by DSH** from whether a value was injected — it means the opposite of what the
  plan assumed, and declaring it would have changed nothing. Caught before any code was written.
- **Reverse injection (on a copy)**: 3/3 injected defects reddened the guard — dropping the gate, ignoring the
  opt-in, and silencing the report — with the copy's sha256 compared before and after each.

## [0.7.3] - 2026-10-15

**A failure message said `[object Object]`. It said it during a compaction loop — the moment a reader most needs
the reason.**

### Fixed

- **`error.message` is no longer assumed to be a string.** A `compaction/end` record in the 2026-10-15 session
  log reads, in full: `"error": "dsh-freellmapi: [object Object]"` — from turn 116 of the session that compacted
  fifteen times. `error.message` is a string only **by convention**; an error crossing a library or wire
  boundary can carry anything, and `String(object)` then yields the literal. Both failure-describing paths
  assumed otherwise:

  - `failureOf()` took the `instanceof Error` branch without checking the type of `message`.
  - `describeTransportFailure()` did the same — found while fixing the first one, and it also chained
    `error.cause.message` unchecked.

  Both now go through one `describeUnknown(value, fallback)` in `lib/errors.js`, which prefers a plausible
  string field (`message`, `reason`, `code`, `type`, `detail`), falls back to a JSON dump for an opaque
  object, survives a circular value that cannot be serialised, and never returns an empty string.

### Added

- **`tests/failure-message.test.mjs`** — six assertions over both boundaries: the helper's own contract
  (including an unserialisable value and a non-string `error.message`), a 400 whose body nests an object where
  a string belongs, an unreachable provider, and an aborted request.

  The helper is tested **directly** as well as end-to-end, and that is deliberate: an earlier version of this
  file passed with the defect reinstated, because a nested `error.message` object is *lifted* to a string by
  `upstreamMessage()` before the broken branch is ever reached. A guard that cannot fail is not a guard — the
  reverse injection below is what exposed it.

### Notes on scope

- **Reverse injection (on a copy, never in the working tree)**: 3/3 injected defects reddened the guard, with
  the copy's sha256 compared before and after each — including reinstating the original expression and
  short-circuiting the helper to `String(value)`. An injection that did **not** go red on the first attempt is
  why the direct tests exist; the harness now reports a partial result honestly instead of rounding up.
- **`describeUnknown` lives in `lib/errors.js`**, not at either call site, so the two paths cannot drift into
  disagreeing about what a usable message is.

## [0.7.2] - 2026-10-15

**A context-summarisation call is not an ordinary request, and routing it like one made compaction fail
forever.**

### Fixed

- **The two ways a compaction could never succeed are both closed.** DSH compresses a long session by asking
  a model to summarise the span it is about to drop, so that call carries the *whole history being
  compressed* as its input. Two failure modes were measured on 2026-10-15 from a durable session log:

  1. The call was routed to a 262,144-token model with about 297,538 tokens of input: `maximum context length
     is 262144 tokens. However, you requested about 297538 tokens`. It could not succeed at any retry, and the
     session never got smaller.
  2. Two further attempts failed with `SETUP_REQUIRED` for the model id `setup:groq` — a **guidance row**,
     which is not a model at all. The session's active route was that row, so the summary inherited it.

  A summary call now **routes across the pool like `auto` does** (a guidance row is no longer a valid target
  for it, while it stays the correct answer for a normal step — that branch is untouched and still guarded),
  and it is subject to an absolute **capacity floor**: `routing.compactionMinContextWindow`, default
  **262,144**, applied only to the summary path. A model that cannot hold a large context at all cannot write
  the summary, whatever this request's estimate happens to be.

- **When the pool has nothing above the floor, the compaction fails loudly and says why** — naming the floor
  and the model it excluded. Silence was the original defect: the retry loop was unbounded *because* every
  attempt failed without anyone being able to see what was wrong.

### Added

- **`routing.compactionMinContextWindow`** (default `262_144`, `0` disables). The relative
  `contextSafetyFactor` gate cannot substitute for it: an estimate undercounts, and a summary call must fit
  *after* the compaction it is performing.

- **`tests/compaction-routing.test.mjs`** — four guards: a summary pinned to a guidance row is served across
  the pool while the same row still returns `SETUP_REQUIRED` on a normal step; a summary skips a model below
  the floor; the floor does not narrow the ordinary path; and an unservable summary fails with a capacity
  message rather than hanging.

### Notes on scope

- **The floor is not a copy of DSH's own threshold.** DSH decides *when* to compact from the capacity the
  adapter declares; this floor decides only *which model may write the summary*. They are different questions
  and are allowed to disagree.
- **`purpose` reaching the adapter was verified before it was relied on.** `GenerateOptions.purpose` is
  declared as `'compaction' | 'session-title'`, and `dsh-compaction-basic`'s summarisation call sets
  `purpose: "compaction"` literally. It is **not** persisted in the request header, so its absence from the
  session log is not evidence of its absence at runtime — an earlier note in this project ("sessionId/purpose
  unmapped") was read as the latter and would have ruled this fix out.
- **Reverse injection run on a copy, not in the working tree**: 4/4 injected defects reddened the intended
  guard, with the copy's sha256 compared before and after each injection. The first attempt at this run
  reported 4/4 reds **whose real cause was a missing `node_modules` in the copy** — a control run exposed it,
  and the harness now links the real tree and asserts the control is green before injecting.

## [0.7.1] - 2026-10-15

**Four "free" OpenRouter models were not free — they were not served at all. The word now costs evidence.
Two claims this project had published about its own measurements were also wrong, and are corrected below.**

### Fixed

- **`openrouter` shipped four `:free` ids that no longer exist upstream, and the model picker called them
  free.** An anonymous `GET https://openrouter.ai/api/v1/models` on 2026-10-15 (462 entries) contains none of
  `deepseek/deepseek-v3.1:free`, `moonshotai/kimi-k2.6:free`, `qwen/qwen3-coder:free` or
  `nvidia/nemotron-nano-12b-v2-vl:free`. The per-model sub-resource agrees and says why: the first answers
  **`404 Not Found`**, the other three still have a catalogue record with **`endpoints: []`** — a zero price
  nobody serves. Positive controls in the same run (`nvidia/nemotron-3-super-120b-a12b:free` and
  `poolside/laguna-s-2.1:free` → `endpoints: 1`) rule out a method artefact, and `kilo`'s four `:free` ids
  re-measured clean the same day — so the naming convention was never the problem. **These four rows were.**

- **All four are replaced by ids verified free in the same run**, with `caps` copied verbatim from the rows
  this pool already carries evidence for under `kilo`, so no capability or speed number is invented:
  `nvidia/nemotron-3-ultra-550b-a55b:free`, `nvidia/nemotron-3-super-120b-a12b:free`,
  `cohere/north-mini-code:free`, `poolside/laguna-s-2.1:free`. `openrouter` therefore **no longer offers a
  vision model**; the default-on pool's visual option is `cerebras/llama-4-maverick-17b-128e-instruct`
  (`zhipu/glm-4.6v-flash` stays available, off by default). A missing capability slot was preferred to a
  fabricated rating.

- **`limits.note` corrected, with its source named.** It said *"20 RPM / 200 RPD"* and read the tier off the
  account **balance**. OpenRouter's own documentation constants (fetched 2026-10-15) are
  `FREE_MODEL_RATE_LIMIT_RPM=20`, `FREE_MODEL_NO_CREDITS_RPD=50`, `FREE_MODEL_HAS_CREDITS_RPD=1000`,
  `FREE_MODEL_CREDITS_THRESHOLD=10`, and the tier is selected by **all-time credits purchased** — not by
  balance. `limits.rpd` is now `50`, and the "unverified relaxation value" disclaimer is gone because the
  value now has a source.

- **Two silent-drop sites closed.** `listProviderModels()` rebuilds every pair field-by-field and would have
  dropped the new `verified` field without a word; `freezePool()` did not freeze it. Both are fixed and
  guarded: the guard walks the pool → pair path and asserts the evidence survives and is frozen with the pool.
  `normalizeModel()` deliberately **rejects** `verified` from user declarations — evidence is our measurement,
  not a self-certification — and that rejection is asserted, so the drop can never quietly become a pass-through.

- **`xfyun/lite` declared a context window four times larger than the vendor's.** The row said
  `contextWindow: 32768`; iFlytek's own HTTP interface documentation (fetched 2026-10-15 over the direct,
  non-proxied path) states **Lite: max input 8K / max output 4K**, in a table whose `Max`/`Pro` columns use
  `8K\32K`-style *alternatives* while **Lite's cells are single-valued**. The transfer is proven by the row's
  own `maxTokens: 4096`, which matches that table's 4K exactly: **the output cell was copied correctly and the
  input cell was not.** It is now `8192` (`8192` is derived from the table's own `4K = 4096` notation and is
  labelled as a derivation, not as vendor text). An over-large window is worse than an error, because it sends
  a context the endpoint cannot hold and the failure is silent.

- **A wrong claim about this machine's network path is retracted.** The 0.7.0 notes said the measurements were
  taken without a proxy "so a domestic direct connection may behave differently". Both halves were wrong: this
  host uses a **split-tunnel VPN** (domestic names direct, foreign traffic proxied), and its DNS resolves
  **every** name into the `198.18.0.0/15` fake-IP pool — so *"resolves to a non-public address"* is
  **always true and carries no information**, and it was never evidence about a remote site. The proof is that
  one call rejected `www.xfyun.cn` and `github.com` **together**. Re-measured over the direct path:
  `www.xfyun.cn` **200 / 128 382 B / 618 ms**, `modelscope.cn` **200 / 4 639 B**.

### Added

- **`lib/free.js`, the only place that decides what "free" means:**
  `pricing.prompt === "0" && pricing.completion === "0" && endpoints >= 1`. It never reads a model id, so the
  `:free` suffix cannot leak back in as a criterion. The evidence shelf life lives there too
  (`FREE_VERIFIED_STALE_DAYS = 60`, reported; `FREE_VERIFIED_BLOCK_DAYS = 90`, blocking), so the gate and the
  tests cannot disagree about the threshold.

- **Every free row that can be price-checked now carries a `verified` evidence record** — when it was taken,
  the method, the price fields observed, the serving-endpoint count and a sha256 of the raw response body.
  All eight such rows (`openrouter`, `kilo`) carry one. `routeway`'s four cannot: its catalogue publishes
  **no** pricing field at all, so they are **declared unproven and stay `enabled: false`** rather than being
  handed evidence that does not exist.

- **The model picker states the criterion and the date.** A verified row's description ends with
  `free: pricing.prompt === "0" && pricing.completion === "0" && endpoints >= 1, verified 2026-10-15
  (anonymous price check)`; a row without evidence prints nothing.

- **`tests/free-model-guard.test.mjs` — 13 assertions against committed fixtures**: the byte-exact anonymous
  catalogues of 2026-10-15 (`openrouter` 774 095 B, sha256 `fe83d51d…`; `kilo` 490 164 B, `57257ffe…`) plus
  the four per-model `/endpoints` bodies, so "free" is recomputable offline instead of taken on trust. Evidence
  older than 90 days fails the guard; the fix is to re-measure, not to widen the window (both thresholds are
  pinned by an assertion of their own).

- **`tests/providers-context-window-invariants.test.mjs`** — a *structural* guard (`maxTokens <= contextWindow`,
  both positive integers) over every model in the pool. It is explicitly **not** a claim that any window has
  been verified against its vendor, and the header records the evidence-linked ceiling guard that was written,
  measured and **rejected**: it would have red-flagged `sambanova/MiniMax-M3 = 1 048 576`, whose own `source`
  reads *measured*, while still missing the `32768` bug — any threshold low enough to catch it also catches
  confirmed values such as `github/openai/gpt-4.1 = 8000`. **Guarding a relative error with an absolute
  threshold is a category error**; that reasoning is kept in the file so it is not re-proposed.

- **Gate G9 (`--online`)**: re-reads the public catalogue anonymously and reports drift and staleness per free
  row. Informational, like G7 and G8 — an upstream free set changing is an event, not a defect in this plugin.
  Measured 2026-10-15: `4 free rows vs 17 zero-priced upstream entries of 462: 0 drifted, 0 stale`.

### Notes on scope

- **The four dead ids are not quietly deleted — they are named in the guard.** The test asserts they are *not*
  in the live zero-price set, so re-adding one fails loudly instead of shipping a dead row again.
- **No credential was used for any measurement in this release.** Every price and endpoint fact comes from
  anonymously readable endpoints. Whether a resurrected id would bill an account cannot be answered from here,
  and is not claimed: the defect was *unservable*, not *charged*.
- **The `@generated:catalog` markers in `lib/providers.js` are not backed by a generator in this tree.** The
  pool data block is hand-maintained, `research/provider-catalog.json` (which the module header names as its
  source) is absent, and no gate covers it — G6 checks only the browser-half `client-setup` block. Flagged
  rather than fixed here; as written, the markers promise more than the repository delivers.
- **`_lead/` is now ignored by git.** It is the workbench (probes, raw responses, measurements, design notes)
  and this package is published; a `git add -A` in the release ceremony was one stray write away from putting
  internal notes on GitHub. The tracked `_lead/flake-probe.mjs` is unaffected — gitignore never untracks a file
  already in the index.

## [0.7.0] - 2026-10-15

**The pool goes from 12 providers to 18 — and all six additions say out loud what their free tier is
actually worth.**

### Added

- **Six providers, every one of them shipped `enabled: false`** (`docs/EXPANSION-v0.7.md` §3.1, stage S2):
  `modelscope` (ModelScope 魔搭), `xfyun` (iFlytek Spark 讯飞星火), `siliconflow` (SiliconFlow 硅基流动),
  `sambanova`, `huggingface` (the Inference Providers router) and `routeway` — 15 models between them, taking
  the pool to **18 providers / 45 models**. `DEFAULT_ENABLED_PROVIDERS` is untouched: `groq`, `cerebras`,
  `openrouter`, `llm7`, `kilo`. The order is the point: catalogue first with the switch off, verify with a
  real key later (S3). Adding a disabled entry costs nothing; enabling an unverified one would cost a route.

  Each entry carries per-model `source:`/`note:` citations naming the upstream file and line (upstream commit
  `5a3abac8…`), which is the licence record — and, wherever a value is *not* from upstream, a plain sentence
  saying so instead of a citation that only looks like evidence.

- **`contextWindow` provenance is no longer one story.** `sambanova`'s four values and `routeway`'s four are
  **measured** from their own anonymously readable catalogs (2026-10-15), as are `huggingface`'s two — the
  latter taken from the *selected backend*, deliberately not the largest value on offer for that id.
  Everything else is marked an estimate or a conservative default inside the entry. Two `routeway` `:free`
  routes declare **42 000**, not the 62 000 the rest of its `:free` family declares.

### Documented

- **How reachable the six are, and by which method** (an anonymous probe *and* a syntactically valid but
  bogus-credential probe, 2026-10-15): five are reachable. `routeway`'s **anonymous chat path is the one open
  `AMBIGUOUS`** — with no credential it gets a Cloudflare interstitial (`403`, HTML, "Attention Required"),
  while the same request carrying a bogus `Authorization` header reaches the origin and gets a plain-JSON
  `401 Invalid API key`. One response cannot separate *anonymous rejected* from *region rejected*, so both
  READMEs say so and nothing in this release depends on that path.

- **What each new "free tier" is really worth, in the README row itself rather than in a footnote.**

  | provider | the honest version |
  |---|---|
  | `sambanova` | **No free tier left.** Upstream retired it in V23 *because* the free tier was permanently cancelled — with a valid key, chat answers `402 payment method required`. Its `baseURL` is **not** an upstream transcription (zero matches in the upstream tree): it comes from vendor documentation. Its `/models` still answers `200`, which upstream itself records as a billing-gate false positive. |
  | `siliconflow` | The `.com` endpoint is a **one-time $1 trial credit, not a recurring free tier**. Upstream keeps the platform for its *free generative-media* models (image/TTS), which this plugin's LLM seam cannot consume; the chat row it once listed is paid ($0.06/M) and upstream deleted that row. |
  | `modelscope` / `xfyun` | Free quota **cannot be verified without a credential**, so neither publishes an RPM/RPD number. `xfyun`'s model id is **vendor-documented** (`lite`, marked 支持免费使用) but has never been used with a real key — see **Corrected**. |
  | `huggingface` / `routeway` | The only two with **reusable free *chat* quota evidence** — and in both cases it is upstream's own statement (a recurring $0.10/mo router credit; `:free` routes cost $0), not a measurement made here. |
  | `modelscope` / `xfyun` / `siliconflow` | **Chinese real-name verification is required** before a key serves traffic, and `modelscope` additionally needs the account bound to an Alibaba Cloud China-site account. That is a real barrier to this project's "zero config" positioning, so it is labelled rather than glossed over. |

- **The generated browser table only carries `enabled === true` providers, so the six additions do not
  appear in the settings-page key rows — expected behaviour, not a defect.** `lib/client.js`'s
  `@generated:client-setup` block is produced by `tests/regenerate-client-setup.mjs`, which filters on the
  default-enabled set; an entry that ships off contributes nothing there, and gate G6 confirms the block is
  current and unchanged by this release. Enabling one of the six by hand will **not** grow a key row either —
  that is the coverage gap already recorded in 0.6.1, restated here because 0.7.0 adds six more entries to it.
  Set `providers.<id>.apiKeyEnv` and store the credential, or paste it on the plugin's own settings page.

- **Probing method, once more: the request body can flip the verdict.** Both READMEs' reachability sections
  now record that a chat probe sent with a **non-existent model id** produces the opposite answer —
  `modelscope` returns `400 Invalid model id`, `sambanova` returns `404 model_not_found` — and neither can be
  told apart from *"this provider's chat is keyless"*, because the request never reaches the credential check.
  Replaying the identical request with a **real id from the catalog** returned `401` from both. Same URL,
  same headers, different body, opposite conclusion.

### Notes on scope

- **The six entries are catalogued, not vouched for.** `xfyun` is `confidence: 'speculative'` for exactly
  that reason, though **not** for its model id any more: the vendor's own API documentation was reached over
  the direct path and confirms `lite` as an accepted `model` value marked 支持免费使用 — see **Corrected**
  below, which also withdraws the claim that the documentation sites were unreachable. What still holds is
  that no valid credential has ever been used against it.
- **No provider was contacted with a real credential in this release, and none of the six was ever asked for
  a completion.** Status codes and public catalogs only.
- One transcription error surfaced during the release and was resolved in favour of the raw artifact: a probe
  report's summary table listed two `routeway` `:free` context windows as 62 000, while the catalog captured
  in the same run says **42 000**. `lib/providers.js` and both READMEs use 42 000.
- `package.json` gains **no** `dependencies` — the only manifest change is the version.

### Corrected

- **Two reachability claims in this release rested on a false premise, and both READMEs are corrected in
  place rather than silently.** The version number stays **0.7.0**: this is a documentation correction, not a
  new release. Nothing was deleted and no number was quietly changed — the wrong sentences are named here
  first, then replaced.

  **What was wrong, claim 1 — the host's location.** Both READMEs said the probes came from *"a direct
  connection with no proxy configured (all six proxy environment variables empty) whose egress is
  US-Los Angeles, not mainland China"*, and concluded that no result could be extrapolated to a domestic
  direct connection. **The premise is false: the probe host runs a VPN in split-tunnel mode**, so traffic to
  mainland-Chinese destinations goes out **direct** and only overseas traffic uses the proxy. **US-LA is where
  the overseas path exits; it is not where the host is.** The "domestic-reachability results are not
  extrapolable" disclaimer therefore had no basis, and is removed. Note what this does *not* change: it
  strengthens, not weakens, the `modelscope` / `xfyun` / `siliconflow` results, because those three are
  mainland hosts and were in fact reached **over the direct path** — the path a domestic user shares. The
  error was **reading a proxy exit as the host's location**.

  **What was wrong, claim 2 — a tool limit read as a site property.** A verification attempt reported that
  the Chinese vendor documentation site *"resolves to a non-public IP address"*, and that was carried into
  both READMEs and into `lib/providers.js` as evidence that **Chinese vendor/documentation sites are
  unreachable from this machine**. **It was never evidence of that.** The message is this project's own
  **DNS guard**: a split-tunnel VPN answers DNS with **fake-IP** addresses drawn from the reserved
  benchmarking range `198.18.0.0/15`, and the fetch tool refuses any hostname that resolves there. The
  decisive check is that it rejected `www.xfyun.cn` **and `github.com` with the identical sentence in the
  same session** — a guard, not a measurement. Re-measured on 2026-10-15 with an ordinary HTTP client over
  the direct path: `www.xfyun.cn`'s doc page returned **`200`, 128 382 B in 618 ms (`Server: Tengine`)**,
  `modelscope.cn` returned **`200`**, and `spark-api-open.xf-yun.com` and `api.siliconflow.cn` both returned
  **`401`** — i.e. hosts answering, wanting credentials. The sites were reachable all along; only the fetch
  tool could not read them. The error was **reading the limit of the observing instrument as a property of
  the observed object** — the same failure mode as the wrong 0.6.1 table recorded below, where a 403 from an
  anonymous probe was read as "region blocked".

  **What this unlocked.** With the documentation sites reachable again, `xfyun`'s model id was re-attempted
  over the direct path and **succeeded**: the vendor's official HTTP API page lists the accepted `model`
  values as `4.0Ultra` / `generalv3.5` / `max-32k` / `generalv3` / `pro-128k` / `lite`, and its version table
  describes **Lite** as 轻量级 with **支持免费使用** (*supports free use*). So `lite` is **vendor-documented
  rather than a specification placeholder** — the id itself was already right, and is unchanged; what changed
  is that it now has a source. `confidence` stays `speculative` because no valid credential has ever been
  used against it. The `lib/providers.js` note that asserted *"本机网络无法访问任何中文厂商/文档站点"* is
  **withdrawn** on the same grounds.

  **Unchanged by this correction:** `routeway`'s anonymous chat path remains an open **`AMBIGUOUS`**. A
  single response still cannot separate *anonymous rejected* from *region rejected*, and settling it still
  needs a real key or a **second egress IP** — the split-tunnel correction removes a false premise, it does
  not supply a second measurement. Nothing in either README depends on that path being open.

  **Method rule this adds.** Every reachability claim in both READMEs now names **which path it was measured
  on** (direct vs. proxy), because the two are different measurements. And no reachability verdict may be
  sourced from a **fetch-tool error**: that reports the tool's policy, while reachability requires an HTTP
  client that actually speaks to the host.

## [0.6.3] - 2026-10-15

**A wrong claim, a gate that would have caught it, and the rules this project runs on.**

### Fixed

- **The 0.6.1 reachability table was wrong, and its method was the reason.** It claimed `groq` and
  `cerebras` were region-blocked "and a key changes nothing". The probe sent **no `Authorization` header**,
  so it read *"this edge rejects anonymous requests"* as *"this region is blocked"*. Measured again on
  2026-10-15 with the header present:

  | Provider | no credential | bogus-but-well-formed key |
  |---|---|---|
  | `groq` | 403 | **401 → reachable** |
  | `cerebras` | 403 | **401 → reachable** |
  | `ovh` (keyless) | 200 | **403 → sending a key breaks a keyless provider** |

  A `403` means one of three different things depending on what was sent — anonymous rejected, credential
  rejected, or region rejected — and reporting one without the other is how the bad table got written. Both
  READMEs now document the **method** per provider class rather than a verdict, and record that all twelve
  pool providers measured reachable once probed correctly.

### Added

- **`tools/gate.mjs` — one command, one verdict.** An eight-gate self-check (`npm run gate` offline,
  `npm run gate:online` adds the network gates). Gates are numbered so a failure can be cited as `G4`:

  | Gate | Checks |
  |---|---|
  | G1 | no `dependencies`; schemastery in peer **and** dev; `NOTICE` ships with the upstream licence; patch row name matches the package |
  | G2 | `Config` is a **live** schemastery schema (static import, no fallback path, `toJSON`, `type === 'object'`, ≥1 volatile field) |
  | G3 | the provider directory entry uses `settingsPath: []` and `settingsNs === provider` |
  | G4 | browser-half red lines: only `react`, no harness require, no DOM writes, no colour literals, static `inject` naming the slot owner |
  | G5 | the test suite |
  | G6 | the generated client table is current |
  | G7 | pool reachability, **method-aware**: keyless providers probed anonymously, key-required ones with a bogus key, `403` reported as ambiguous |
  | G8 | upstream drift against `tashfeenahmed/freellmapi`'s `Platform` union (`missing` is a backlog, `extra` is a defect) |

  G7/G8 are **informational**, not blocking: a provider being unreachable from one network is not a defect in
  the plugin, and making it fatal would make the gate fail on a train.

- **`PROJECT-RULES.md` — the operating manual.** A PDCA loop with gates between the phases; three mechanisms
  that let the loop run without a human (`tools/gate.mjs` for self-check, router telemetry for
  self-optimisation, a scheduled `--online` run for self-iteration); and **eight hard rules each tied to a
  concrete failure**, plus a lesson ledger mapping every red light to the guard that now catches it.

  The rules that cost the most to learn: never degrade silently; read the shipped artifact before concluding
  what the platform supports; a probe's method is part of the claim; upstream attribution is a licence
  obligation; distinguish "needs a restart" from "live"; and *"registered but invisible"* is this project's
  signature failure shape, with a fixed top-down diagnostic order.

- **`docs/EXPANSION-v0.7.md` — the task brief for pool expansion**, with seven mechanically checkable
  acceptance criteria, the corrected candidate list (probed by the right method), and risks stated as
  unknowns rather than guesses.
- **`docs/NEW-SESSION.md` — a paste-ready bootstrap** so the next session starts from the rules instead of
  rediscovering them.

## [0.6.2] - 2026-10-14

**Attribution fix. This package is a derived work of [freellmapi](https://github.com/tashfeenahmed/freellmapi)
and the repository did not say so.**

### Fixed

- **The upstream copyright notice was missing, which the upstream licence requires.** freellmapi is MIT
  (Copyright © 2026 Tashfeen Ahmed), and the MIT terms state that the copyright notice *and* the permission
  notice must be included in all copies or substantial portions of the software. This package ports
  freellmapi's routing design and transcribes its provider catalogue, so it qualifies — yet `LICENSE`
  carried only this package's own copyright, there was no `NOTICE`, and nothing in the manifest recorded
  the derivation.

  Added a `NOTICE` file containing the derivation statement and the upstream MIT text **verbatim**, listed
  it in `package.json#files` so it ships, and pointed `LICENSE` at it.

- **The README framed freellmapi as merely "the external gateway `gateway` mode can forward to"**, which
  reads as though this plugin were independent of it. Both READMEs now open a dedicated **Upstream and
  credits** section stating the derivation, naming what was ported (the provider catalogue in
  `lib/providers.js` with its per-entry `source:`/`note:` citations, the failover ladder in `lib/health.js`,
  and the routing model itself) and what was not (no upstream file is vendored — upstream is TypeScript,
  this package is plain JavaScript — and the DSH integration is this package's own).

- Corrected the stale "314 tests" figure in both READMEs' file trees, which had been wrong since 0.3.x.

### Note on scope

Upstream describes itself as "personal experimentation only". That is their statement about their project;
it is quoted here rather than restated or reinterpreted, and neither README should be read as granting or
restricting anything beyond the MIT licence.

## [0.6.1] - 2026-10-14

**Two of the default-enabled providers are hard-blocked from some networks, and the key rows do not cover
providers you enable yourself.** Both are now documented from measurement rather than assumption.

### Documented

- **Regional reachability, measured.** An unauthenticated `GET {baseURL}/models` against all twelve
  providers from a mainland-China connection: `groq` and `cerebras` answer **403 — the API, not just the
  console** — so a key cannot help until traffic leaves through a different route; `openrouter` answers 200
  in ~0.5 s (5/5 probes); `kilo`, `llm7`, `ovh`, `nvidia` and `github` answer 200; `mistral`, `zhipu`,
  `volcengine` and `longcat` answer 401, which is the healthy answer from a provider that wants a key.

  The 403 carries **no Cloudflare headers**, which is what distinguishes an operator-level IP/region
  rejection from a WAF challenge — and it is why the console page and the API fail together. The README now
  carries the table plus the two-line config that turns a permanently-blocked provider off, since it would
  otherwise spend an attempt on every request.

- **The key rows follow the pool's default-enabled set.** `lib/client.js` carries a generated copy of the
  provider table, and `tests/regenerate-client-setup.mjs` filters it to `enabled === true` at build time — so
  enabling a provider through `providers.<id>.enabled` does **not** produce a key row for it. The README says
  so, and points at `apiKeyEnv` plus the credentials service for that case. Fixing it properly means letting
  the browser half read the effective enabled set from the host; that is left as a known gap rather than
  guessed at.

### Added

- `keyURL` for `zhipu`, `volcengine` and `longcat` — all three were `null`, so enabling any of them produced
  a key row with no link. Each URL was verified reachable (HTTP 200) before being added.

## [0.6.0] - 2026-10-14

**The key form is back, and this time there is a row for it to attach to.** Reverts the removal in 0.5.0,
which was decided on a premise that turned out to be false.

### Fixed

- **`settings.models.provider-card` is the *only* seat a third-party plugin has on the Models page, so
  removing the browser half removed the only way to enter a key there.** 0.5.0 dropped `lib/client.js` on
  the reasoning that "the platform already renders a configurable provider's editor from the schema". That
  holds for DSH's own two provider families and for nothing else: the page picks an editor's fields from
  `layoutOf(ns)`, hard-coded to `llm-deepseek` and `llm-pi-ai`, and returns `"unknown"` for every other
  namespace — which renders the "edit it in `cordis.patch.yml`" hint and **disables Save**
  (`dsh-client-ui-settings-models/lib/client.js:1493-1497`, `:1813-1816`, `:1828`). The own-settings-page
  fallback is real but weaker: it cannot express per-upstream keys, and it lives three clicks away from the
  page where a user looks for a model key.

  The browser half is restored from v0.4.1. Its registration is keyed `key: 'freellmapi'`, which the page
  matches against `row.entry.settingsNs` — and that row only began to exist once 0.5.0 gave the plugin a
  settings namespace and 0.5.1 pointed its directory entry at the namespace root. So 0.4.0 and 0.4.1 were
  not wasted work; they were correct code waiting on a deeper bug, and both are live again.

  The slot renders in the ordinary row card as well as in the first-run setup card
  (`dsh-client-ui-settings-models/lib/client.js:2215-2219` and `:2150-2154`), so the per-upstream key rows
  appear inside this plugin's own card whether or not anything is configured yet.

### Changed

- Restored the `./client` export, the `dsh.client` manifest block (with its `inject` ordering edges) and
  the client test suite. Suite: 411 tests.

## [0.5.1] - 2026-10-14

**The provider now shows up in the Models page.** 0.5.0 fixed why it could not; this release points its
directory entry at the right place so it is actually listed.

### Fixed

- **The configurable-provider entry declared `settingsPath: ['providers', 'freellmapi']`, which names
  something that does not exist.** `config.providers` is keyed by **upstream** provider (`groq`,
  `cerebras`, `kilo`, ...), never by the route this plugin registers, so `schema.getPath(value, path)` was
  always undefined. The Models page treats an empty path as "the namespace itself" and any other path as a
  sub-object it must be able to resolve, so the row counted as **not configured**: it was hidden from the
  card list and offered only through "add model provider" — where pressing Save would have written a junk
  `providers.freellmapi` entry into the upstream override map. The path is now `[]`.

  That also keeps `removable` false, which is correct: it requires a non-empty path, and a route the plugin
  owns is not the user's to delete.

### Documented

- **The Models page cannot render an editable form for a third-party provider, and no `settingsPath` can
  change that.** Its editor picks its fields from `layoutOf(ns)`, which is hard-coded to `llm-deepseek` and
  `llm-pi-ai` and returns `"unknown"` for every other namespace; an unknown layout renders only "other
  fields live in cordis.patch.yml" and **disables Save**
  (`dsh-client-ui-settings-models/lib/client.js:1493-1497`, `:1813-1816`, `:1828`). The provider row is
  therefore correct and visible, but read-only there — and the hint it shows is the honest one.

  This plugin's editable surface is its **own settings page** (Settings → Plugins → dsh-freellmapi), which
  is generated from the schema and exists precisely because 0.5.0 made `Config` a real schemastery schema.
  Two tests now pin the directory entry to the namespace root and assert that the namespace and the route
  id cannot drift apart.

## [0.5.0] - 2026-10-14

**The provider was invisible in the Models page while still routing traffic.** 0.4.1 chased the wrong
cause; this release fixes the real one and deletes the feature that was never needed.

### Fixed

- **`Config` silently degraded from a schemastery schema to a plain object**, which cost this plugin its
  settings namespace entirely. The schema used to be built by a *guarded* dynamic
  `import('@deepseek-ai/schemastery')` that fell back to a plain Standard Schema object on any failure.
  A profile install `link:`s this package into the profile, and Node resolves bare specifiers from a
  module's **realpath** — so the import ran against this package's own directory, never the profile's,
  got `ERR_MODULE_NOT_FOUND`, and quietly took the fallback.

  The consequence was not local and not visible. `dsh-settings` skips any entry whose `Config` lacks
  `toJSON()` (`dsh-settings/lib/index.js:538-541`), so the plugin got **no settings namespace**. The
  Models page builds its rows from `joinProviderDirectory(listProviders(), listConfigurableProviders())`
  and resolves a row's namespace by `settingsNs`; with no namespace the row is neither `configured`
  (so it is not drawn as a card) nor `addable` (so it is not offered under "add model provider"). The
  provider landed in a **dead zone — absent from the UI, working on the wire**, which is the worst
  failure shape available because everything appears to be fine.

  `Config` is now a static-import schemastery schema with no fallback at all, per
  `guide/plugin-dev-guide.md` §3.6 (*a plain object is not an acceptable `Config`; an unusable schema
  must fail loud*). `@deepseek-ai/schemastery` is declared in **`peerDependencies` and
  `devDependencies`** as `family-toolchain.md` R5 requires — the opportunistic import was a deliberate
  deviation from that rule and it is what broke.
- **The schema test could not have caught it.** It returned early when `configSchemaKind` was not
  `schemastery` — so it passed for the entire life of the bug. It now asserts, and additionally ties the
  schema to the consumer contract: `providers` must be declared, because the Models page reads a row's
  credential reference as `namespace.value[settingsPath].apiKeyEnv` and this plugin declares
  `settingsPath: ['providers', 'freellmapi']`.

### Removed

- **The browser half (`lib/client.js`), the `dsh.client` manifest block and the `./client` export.**
  0.4.0/0.4.1 assumed `settings.models.provider-card` was a seat for introducing a new provider card. It
  is not: it is an add-on *inside a row DSH already knows about*, and the card list renders only rows
  whose namespace resolved. The platform already has this UI — a configurable provider row gets the
  built-in editor and the credential indicator from the schema alone. With the schema fixed, the
  provider appears under "add model provider" and DSH's own editor stores the key through the credentials
  service, so ~25 KB of client code and its whole risk surface (bundle format, activation ordering, slot
  contracts) are gone.

### Added

- `@deepseek-ai/schemastery` in `devDependencies`, and `pnpm install` in this package for local
  development, so a `link:`-ed install resolves the schema builder from the package's own tree.

## [0.4.1] - 2026-10-14

**The settings card shipped in 0.4.0 never appeared.** No error, no log, no card — the client half was
loading and calling `slots.inject()` on a slot that did not exist yet.

### Fixed

- **`dsh.client.inject` was empty, so the browser half could activate before the slot it registers into.**
  `docs/subsystems/slots.md` states the rule plainly: *a child slot exists only when its named parent entry
  is mounted*. `settings.models.provider-card` sits under `settings.section` → `sidebar.settings`, so a half
  with no ordering edge can reach `slots.inject()` before the settings package has mounted that subtree —
  and registering into a slot that does not exist is a **silent no-op**. The official settings-card cookbook
  declares this edge (`"inject": ["@deepseek-ai/dsh-client-ui-settings"]`) and every working settings-card
  plugin carries it; this one declared `platform` alone. The manifest now orders activation after
  `@deepseek-ai/dsh-client-ui-settings` (the slot owner), `@deepseek-ai/dsh-client-locale` (the dictionary
  face) and `@deepseek-ai/dsh-client-connection` (the Remote credential face).
- **The test suite could not have caught it.** `client.test.mjs` asserted the *plugin's* cordis `inject`
  was a static array, but never the *manifest's* `dsh.client.inject` — the field that actually decides
  activation order. A new test reads `package.json`, rejects the documented function-form trap
  (`cordis` would declare zero dependencies and `apply()` would throw on the first service it touches),
  and maps each service the half reaches for to the package that provides it, so the two inject
  declarations can no longer drift apart. Verified by reverse injection: removing the manifest edge fails
  the test.

### Added

- The `settings.models.footer` and `settings.models.provider-card` slot names, plus the parent-mount rule,
  are now cited in `lib/client.js` next to the registration so the constraint is visible where it applies.

## [0.4.0] - 2026-10-14

**Provider keys can be pasted in place instead of exported into the shell.**

### Added

- **A browser half and a settings card.** Each provider without usable credentials gets a
  `settings.models.provider-card` entry showing where to get a key (with a link), which environment
  variable name the key is stored under, and a password field with an explicit save. Values are written
  through `ctx.remote.credentials.set()`, so they land in DSH's credential service — the first source the
  host-side key resolution consults, and one it reads without caching, so **a saved key takes effect
  without a restart**.
- Localized card text (`en`, `zh`) registered through `ctx.locale.register`, and a package icon.

### Changed

- Provider setup rows are guidance, not models: they never appear as selectable models and cannot be
  accidentally pinned.

## [0.3.1] - 2026-10-14

**A wrong context window was doing damage in both directions** — this release follows a real session that
sent 297 538 tokens to a model whose actual limit is 262 144.

### Fixed

- **Wrong `contextWindow` for all four `kilo` models**, measured against kilo's own `GET /api/gateway/models`.
  The single bad number set caused two opposite failures: `nemotron-3-super-120b-a12b:free` was overstated
  at 1 000 000 (so the router picked it for a 297k-token request and upstream answered `400`) while
  `nemotron-3-ultra-550b-a55b:free` was understated at 131 072 (so the model that *could* have served the
  request was filtered out by the context gate before it was ever tried). `poolside/laguna-s-2.1:free` and
  `cohere/north-mini-code:free` were corrected as well.
- **A context-window overflow now fails over instead of ending the request.** Upstream's `400
  "maximum context length"` was terminal; it is now a per-candidate condition that moves to a candidate with
  a **larger** context window (a smaller one cannot succeed, so the loop only moves in that direction). The
  refused candidate is neither cooled down nor counted as a failure, because it is healthy — the same model
  serves a shorter request fine. The hard invariant is untouched: once any chunk has reached DSH there is
  still no failover, and the stream ends with `STREAM_INTERRUPTED`.
- **A crash in the "nothing fits" path.** `contextOverflowFailure` was called with its arguments in the
  wrong order (`(plan, attempts, minimumContextWindow)` instead of `(plan, refusedUpTo, attempts)`), which
  threw `attempts.map is not a function` — but only on the path where a request had already been refused
  once *and* no wider candidate remained. The message now also reports the estimated request size and the
  widest model in the pool.
- **Per-provider `extraBody` / `extraHeaders` declarations now reach the wire**, closing the limitation
  recorded under 0.2.0. They were being dropped while the provider declaration was rebuilt, so
  `nvidia`'s required `parallel_tool_calls: false` never made it into a request body.

### Added

- **`routing.contextSafetyFactor`** (default `1.15`): the context gate now requires
  `contextWindow >= estimated tokens × this factor`. The token estimate is a heuristic and undercounts — a
  real 297 538-token session was estimated below 262 144 and slipped through the gate — so one model of
  headroom is cheaper than an upstream `400`. Values below `1` are rejected and the default applies.

## [0.3.0] - 2026-10-13

**A pinned model is now honoured or refused — never quietly replaced.**

### Changed

- **⚠️ Behaviour change: requesting a concrete model id is now a strict pin.** In v0.2.0 a pinned model
  could be *silently substituted*: with no credential configured, picking `Llama 3.3 70B · Groq` was
  answered by a different provider's model and reported as a successful turn, and a completely invented id
  (`totally-made-up-model-xyz`) was answered as well. The user could not tell. From v0.3.0, `auto` and
  `auto:simple|medium|complex` still select freely inside the pool, but any other id (the composite
  `provider/model` or a bare model id) is served **only** by that model — a pin that cannot be served fails
  with an explicit error and **zero upstream requests**.
- **The model list now shows only what can answer.** A provider that is enabled but has no usable
  credential contributes **one `setup:<provider>` guidance entry** instead of its unreachable model rows,
  and servable models are sorted ahead of the guidance. In the zero-credential default install the picker
  went from 21 advertised entries (15 of them unreachable, and sitting at the top) to 13 — 4 virtual
  routes, 6 keyless models, 3 guidance entries.

### Fixed

- **Silent substitution of pinned models** (the "answers with somebody else and calls it a success" defect
  above). The root cause was that a model id without a `/` was treated as a failed filter and fell back to
  free selection inside the pool.
- Listing models that could never be served: `listModels()` did not resolve credentials, so every enabled
  provider looked usable.

### Added

- **`setup:<provider>` guidance entries** whose names carry the exact environment variable and where to
  get a free key, e.g.
  `Groq ▸ needs GROQ_API_KEY (free key: console.groq.com/keys)`. They are signposts, not models: selecting
  one issues no request, and after the credential is set the provider's real models appear and the entry
  disappears.
- **`UNKNOWN_MODEL` and `MODEL_UNAVAILABLE` failure codes** with actionable messages: the closest model ids
  plus a "enable that provider" hint, or the per-candidate exclusion reasons (cooldown, vision, tools,
  context window) plus a "use `auto`, or retry after the cooldown" hint. `MISSING_CREDENTIAL` for a pinned
  model now names the exact variable, the free-key page, the DSH settings page, and `auto` as the
  alternative.
- Pins resolve against both spellings: the composite `provider/model` from the picker and the bare model
  id used by `GET /v1/models` and provider documentation.

## [0.2.0] - 2026-10-13

**The plugin became self-contained.** v0.1.0 forwarded everything to an external freellmapi gateway;
v0.2.0 ships its own free-provider pool and its own routing engine, so installing the plugin is the
whole setup. `gateway` mode is still there, unchanged, behind a config field.

### Added

- **`direct` mode — built-in routing, no external process.** `lib/providers.js`, `lib/router.js`,
  `lib/health.js` and `lib/dispatch.js`: a per-request complexity classifier, capability/speed ranking
  with hard gates, health tracking, and failover across providers.
- **Built-in free-provider pool: 12 providers / 30 models** — Groq, Cerebras, OpenRouter, GitHub
  Models, Mistral, Z.ai (Zhipu), Volcengine Ark, LongCat, LLM7, Kilo, NVIDIA NIM and OVH AI Endpoints,
  each model carrying capability (1–5), speed (1–5), context window, `vision` and `toolCalling`.
  Five providers are enabled by default.
- **Zero-config start.** Kilo and LLM7 answer with **no credential at all** — verified by real requests
  sent without any `Authorization` header. A fresh install has a non-empty candidate pool before
  anything is configured.
- **Per-request complexity routing.** A pure, deterministic classifier scores seven signals (estimated
  tokens, tool schemas, complexity vocabulary, reasoning burden, fenced code, conversation depth, image
  input) with a noisy-OR combination, a simple-task penalty, and a hard `medium` floor for images; the
  resulting `simple` / `medium` / `complex` tier sets the capability-vs-speed weights (0.25/0.75,
  0.50/0.50, 0.80/0.20).
- **Tier overrides in the model picker:** `auto:simple`, `auto:medium`, `auto:complex` force a lane
  while still recording the classifier's score, and pinning a `provider/model` id pins that candidate.
- **Automatic failover with one hard invariant: it only happens before the first chunk reaches DSH.**
  `429`, `5xx`, timeouts, `404 model_not_found` and `400 model_unavailable` park the failed pair and move to
  the next-ranked candidate; `401`/`403` and other `400`s do not. A mid-stream failure ends the stream
  instead of splicing two models into one answer.
- **Health tracking and cooldowns.** The **first retryable failure already parks** a candidate (2 minutes),
  and each further consecutive failure escalates one step up the `2 m → 10 m → 1 h → 24 h` ladder; a
  provider's `Retry-After` wins over the ladder; a rejected credential parks that provider for 24 h.
  Failures also lower a candidate's score (`1 / (1 + 0.15 · effectiveFailures)`, floor 0.4), and that
  penalty decays with a **60-second half-life** so a single 429 can never starve a candidate permanently.
- **Latency participates only as real evidence.** The factor is `fastest / latency` clamped to `[0.85, 1]`
  against the fastest candidate of the same request; **an unmeasured candidate no longer scores a perfect
  1.0** (it is treated as "no faster than the slowest factor measured in this request"), and a
  **100 ms noise floor** discards the whole signal when the measured spread is smaller than that, so
  warm-up jitter cannot change the selection.
- **Per-provider configuration** through `config.providers`: `enabled`, `displayName`, `baseURL`,
  `apiKeyEnv`, `apiKey`, `keyless` and `models` (which replaces a provider's model list wholesale, so a
  drifted catalog can be corrected without a release). Providers that are not in the built-in pool can
  be added the same way.
- **Routing-engine knobs** through `config.routing`: `maxAttempts` (6), `budgetMs` (45 000),
  `thresholds`, `weights` and `preferredOrder`.
- **Direct-mode routing log line** (`logRouting`, default on):
  `dsh-freellmapi: tier=complex -> provider/model (capability=5, speed=3, 2 candidates tried)`.
- **Bounded attempt budget** and new in-band failure codes: `NO_CANDIDATES`,
  `ALL_CANDIDATES_FAILED`, `STREAM_INTERRUPTED`, `MODEL_UNAVAILABLE` (the deliberate exception to
  "400 is not retryable", because aggregators rotate their catalogs).

### Changed

- **`mode` now defaults to `direct`, and that is a behaviour change.** An install that used to forward
  every request to `http://localhost:3001` now routes across the built-in pool instead. Set
  `mode: gateway` (plus `baseURL` and a `freellmapi-…` key) to get the v0.1.0 behaviour back.
- The model picker in `direct` mode lists `auto`, the three tier overrides and every enabled
  `provider/model`, instead of the gateway's virtual routes and discovered catalog.
- `resolveModel()` in `direct` mode takes the context window, output cap and modalities of the pinned
  pool entry, so DSH's compaction budget matches the model that will actually answer.
- A missing provider credential is now a **silent, supported state** rather than an error path:
  unconfigured providers are dropped from the candidate pool without warnings.

### Fixed

- `model_unavailable` (HTTP 400) is recognised as a per-`(provider, model)` condition and triggers
  failover, instead of being classified as a permanently bad request. Other `400`s keep their
  non-retryable classification.
- The latency penalty can no longer flip a tier decision: its floor was raised from 0.5 to 0.85 after a
  forced `auto:simple` request was observed changing to a strong-but-slow model.
- Catalog corrections from the live keyless probe: removed `kilo`'s non-existent
  `poolside/laguna-m.1:free` (404) and two `llm7` ids that answered `400 model_unavailable` (one of
  which was also mislabelled `vision: true`); added `llm7`'s verified `DeepSeek-V4-Flash-0731` and
  three free `kilo` models.

### Known limitations

- No end-to-end run against real keyed providers; rate-limit numbers are the upstream 2026-04 baseline.
- The complexity classifier is a heuristic and demonstrably misjudges (see the README's worked
  counter-examples); pin a tier or a model when you know better.
- `zhipu`'s `baseURL` is the riskiest entry in the pool, and `volcengine` / `longcat` model ids are
  inferred; all three ship disabled with `confidence: 'speculative'`.
- Free catalogs drift (`model_unavailable` is normal weather, not a bug).
- `nvidia` declares `parallel_tool_calls: false` but the declaration never reaches the wire; NVIDIA is
  disabled by default.
- Health state is not persisted across restarts, and a failed-over answer comes from a different model
  than the top-ranked one.
- Still open from the v0.1.0 verification round: `maxTokens` above `Number.MAX_SAFE_INTEGER`,
  plain-string `user` content, `includeFusion: false` being undone by the gateway's own `fusion` entry
  (gateway mode), and duplicate ids from `discover()`.

## [0.1.0] - 2026-10-13

First public release.

### Added

- DSH LLM adapter for a self-hosted [freellmapi](https://github.com/tashfeenahmed/freellmapi)
  gateway, registered as the provider route `freellmapi` (displayed as **FreeLLMAPI (Auto)**).
- Auto-routing models in the DSH model picker: bare `auto` (current fallback chain) first, then
  the global strategies `auto:smart`, `auto:fast`, `auto:cheap`, `auto:reliable` and
  `auto:balanced`, plus `fusion` and any named fallback chain (`auto:<profile>`) discovered from
  the gateway. The model string is forwarded verbatim, and unlisted ids are still answered —
  the catalog is a convenience, not a whitelist.
- Live model discovery from the running router (`GET /v1/models`), with a configurable timeout
  and cache window (`discoveryTimeoutMs`, `discoveryCacheMs`). Discovery failures keep the last
  cached catalog and leave the virtual routes selectable instead of emptying the picker.
- Streaming chat completions over `POST /v1/chat/completions` (SSE): incremental SSE decoding
  across chunk boundaries, tool calls, `delta.reasoning_content`, captured usage frames, and the
  gateway's additive `_fusion` frames.
- Image input support (`vision`): referenced attachments are inlined as `data:` URLs, and an
  attachment that cannot be read degrades to a text placeholder instead of failing the request.
- Upstream routing observability: `X-Routed-Via` (the provider/model that actually served the
  request), plus `X-Fallback-Attempts` / `X-Fallback-Trail` when a fallback happened, reported
  through the DSH log under the `logRoutedVia` switch. The last 50 observations are also kept in
  a process-wide ring buffer (`getRecentRoutes()`).
- Gateway-aware error translation, reported **in-band** as a terminal error chunk rather than a
  thrown exception: `AUTH`, `RATE_LIMIT`, `QUOTA`, `CONTEXT_WINDOW_EXCEEDED`,
  `UNSUPPORTED_CONTENT`, `UNSUPPORTED_OPTION`, `INVALID_REQUEST`, `SERVER`, `TRANSPORT`, `TIMEOUT`,
  `ABORTED`, `MISSING_CREDENTIAL`, `INVALID_CREDENTIAL`, `EMPTY_RESPONSE`, `CONTENT_FILTER` and
  `UNKNOWN`. Unknown `auto:<profile>` (`400`) and exhausted quota (`429`, including `Retry-After`
  parsed into DSH's retry-after field) get messages that say what to do next. An in-band error
  frame from the gateway keeps its own `error.code` verbatim (falling back to `SERVER` only when
  the frame carries none), so codes the gateway invents are reported as-is rather than normalised
  into a retryable one.
- Configuration through the DSH settings page and the profile patch file: `baseURL`, `apiKeyEnv`,
  `apiKey`, `maxTokensField`, `logRoutedVia`, `includeFusion`, `exposeDiscoveredModels`, `vision`,
  `contextWindow`, `maxTokens`, `timeoutMs`, `discoveryTimeoutMs`, `discoveryCacheMs`, `headers`,
  `taskType` (`X-FreeLLM-Task-Type`) and `cacheMode` (`X-FreeLLM-Cache`). The key is resolved per
  request through the DSH credentials service, with an inline value and the environment as
  fallbacks; no configuration value can prevent the plugin from loading.
- Zero runtime dependencies: no `dependencies` at all, and the DSH LLM runtime is resolved with a
  guarded dynamic import that falls back to local shims outside DSH, so the plugin never
  materialises a second copy of `@deepseek-ai/*`. The only declared peer is the optional
  `@deepseek-ai/cordis`.

### Known limitations

Registered from the independent verification round; none of these blocks a release, and none is
fixed in 0.1.0.

- `maxTokens` above `Number.MAX_SAFE_INTEGER` is accepted by the config but rejected by DSH: the
  runtime requires a safe integer for `defaultMaxTokens`, so `resolveModel()` returns metadata DSH
  refuses with `INVALID_MODEL_MAX_TOKENS` instead of clamping the value.
- A `role: "user"` message whose `content` is a plain string is sent with empty content. DSH always
  supplies `ContentBlock[]`, so DSH itself cannot produce that shape, but `lib/wire.js` tolerates
  strings in its own `textOf` helper — an internal inconsistency rather than a reachable path.
- `includeFusion: false` removes `fusion` from the static catalog, but the gateway's own
  `GET /v1/models` response lists it and model discovery merges it back. `exposeDiscoveredModels:
  false` is required as well to hide it completely.
- `discover()` can return duplicate model ids when the gateway lists an id twice. DSH's own
  `discoverModels` step de-duplicates by endpoint order, so the GUI is unaffected.

### Notes

- This is an unofficial community plugin. It is not affiliated with, endorsed by or
  supported by the freellmapi project or by DeepSeek.
- freellmapi's official `setup-dsh` integration already covers the plain "use the gateway
  from DSH" case without any plugin; see the README for an honest comparison.
- **The official route and this plugin cannot be enabled at the same time:** both own the DSH
  provider route name `freellmapi`. Installing this plugin while a `setup-dsh` route exists makes
  the plugin refuse to load with a message naming the conflict; remove one of the two.
- MIT licensed.

[Unreleased]: https://github.com/lion231226/dsh-freellmapi/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/lion231226/dsh-freellmapi/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/lion231226/dsh-freellmapi/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/lion231226/dsh-freellmapi/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/lion231226/dsh-freellmapi/releases/tag/v0.1.0
