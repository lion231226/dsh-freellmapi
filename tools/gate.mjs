#!/usr/bin/env node
/**
 * The project gate — one command, one verdict.
 *
 *   node tools/gate.mjs              # offline gates (fast, deterministic)
 *   node tools/gate.mjs --online     # adds the network probes
 *   node tools/gate.mjs --json       # machine-readable result
 *
 * WHY THIS EXISTS
 *
 * This project's most expensive failures were never "the code was wrong". They
 * were "nobody ran the check that would have said so":
 *
 *   - `Config` degraded from a schemastery schema to a plain object, so the
 *     plugin got no settings namespace and its provider became invisible in the
 *     Models page while still routing traffic. Nothing threw and nothing logged,
 *     because the degradation was a *deliberate fallback*.
 *   - The reachability table in the README claimed groq and cerebras were
 *     region-blocked. The probe sent no Authorization header, so it was reading
 *     "the edge rejects anonymous requests" as "the region is blocked". A user
 *     with a working groq key disproved it in one sentence.
 *
 * Both are the same defect class: **a claim whose method was never encoded**, so
 * it could not be re-run and could not fail. Every gate below therefore states
 * its method in the assertion, not just its expectation.
 *
 * Gates are numbered so a failure can be cited as `G4` in an issue, a commit or
 * a lesson entry.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** A Windows path is not importable — the ESM loader needs a file:// URL. */
const moduleUrl = (rel) => pathToFileURL(path.join(ROOT, rel)).href
const ONLINE = process.argv.includes('--online')
const JSON_OUT = process.argv.includes('--json')

const results = []
const record = (id, title, ok, detail) => results.push({ id, title, ok, detail })
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')
const has = (rel) => existsSync(path.join(ROOT, rel))

function assertion(id, title, run) {
  try {
    const detail = run()
    record(id, title, true, detail ?? 'ok')
  } catch (error) {
    record(id, title, false, error.message)
  }
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

// ---------------------------------------------------------------------------
// G1 — manifest contract
// ---------------------------------------------------------------------------

assertion('G1', 'manifest: no runtime dependencies, schema peer declared, NOTICE ships', () => {
  const pkg = JSON.parse(read('package.json'))
  const notes = []

  // A profile's pnpm hoists `@deepseek-ai/*`, so a normal `dependencies` entry
  // shadows the runtime copy and disables the whole profile. This has happened
  // to other plugins; the rule is peerDependencies only.
  assert(pkg.dependencies === undefined, 'package.json declares `dependencies` — shared dsh packages must be peerDependencies only')
  assert(pkg.peerDependencies?.['@deepseek-ai/schemastery'] !== undefined, '@deepseek-ai/schemastery missing from peerDependencies')
  assert(pkg.devDependencies?.['@deepseek-ai/schemastery'] !== undefined, '@deepseek-ai/schemastery missing from devDependencies (a link: install cannot resolve it otherwise)')
  assert(pkg.files?.includes('NOTICE'), 'NOTICE is not in package.json#files — the upstream MIT notice must ship')
  assert(has('NOTICE'), 'NOTICE file is missing')
  const notice = read('NOTICE')
  assert(notice.includes('MIT License'), 'NOTICE does not contain the upstream licence text')
  assert(notice.includes('Tashfeen Ahmed'), 'NOTICE does not contain the upstream copyright holder')
  notes.push('no dependencies, schemastery peer+dev, NOTICE ships')

  assert(has('cordis.patch.yml'), 'cordis.patch.yml is missing')
  const patch = read('cordis.patch.yml')
  const rowName = patch.match(/name:\s*'([^']+)'/)?.[1]
  assert(rowName === pkg.name, `cordis.patch.yml row name "${rowName}" != package name "${pkg.name}"`)
  notes.push(`row name matches package (${rowName})`)
  return notes.join('; ')
})

// ---------------------------------------------------------------------------
// G2 — the config schema is real, because a plain object silently removes the UI
// ---------------------------------------------------------------------------

assertion('G2', 'config schema is a live schemastery schema (method: load the module and inspect it)', () => {
  const source = read('lib/config.js')
  assert(/^import Schema from '@deepseek-ai\/schemastery'$/m.test(source), 'lib/config.js must statically import @deepseek-ai/schemastery')
  assert(!/FALLBACK_CONFIG|chooseConfigSchema/.test(source), 'a fallback schema path exists again — that is the 0.5.0 bug')

  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const m = await import(${JSON.stringify(moduleUrl('lib/index.js'))});
    const C = m.Config;
    const volatileCount = Object.values(C.dict ?? {}).filter((f) => f?.meta?.volatile === true).length;
    process.stdout.write(JSON.stringify({
      kind: m.configSchemaKind,
      toJSON: typeof C.toJSON === 'function',
      type: C.type,
      fields: Object.keys(C.dict ?? {}).length,
      volatileCount,
    }));
  `], { cwd: ROOT, encoding: 'utf8' })
  const seen = JSON.parse(out)

  // dsh-settings skips any entry whose Config lacks toJSON(); volatileForm()
  // needs type 'object' plus at least one child with meta.volatile. Without all
  // three the entry gets no namespace, and a provider with no namespace is
  // rendered nowhere while still working on the wire.
  assert(seen.kind === 'schemastery', `configSchemaKind is "${seen.kind}"`)
  assert(seen.toJSON === true, 'Config.toJSON is not a function — dsh-settings will skip this entry')
  assert(seen.type === 'object', `Config.type is "${seen.type}" — volatileForm will return undefined`)
  assert(seen.volatileCount > 0, 'no volatile field — volatileForm will return undefined')
  return `${seen.fields} fields, ${seen.volatileCount} volatile, toJSON present`
})

// ---------------------------------------------------------------------------
// G3 — the provider directory entry points at the namespace root
// ---------------------------------------------------------------------------

assertion('G3', 'directory entry points at the namespace root (method: mount with a fake ctx)', () => {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const { mountPlugin } = await import(${JSON.stringify(moduleUrl('tests/helpers/context.mjs'))});
    const mounted = mountPlugin({ config: { mode: 'gateway', apiKey: 'test-key-not-real' } });
    process.stdout.write(JSON.stringify(mounted.directoryEntries));
  `], { cwd: ROOT, encoding: 'utf8' })
  const entries = JSON.parse(out)
  assert(entries.length === 1, `expected exactly one configurable-provider entry, saw ${entries.length}`)
  const [entry] = entries
  // A non-empty settingsPath must name a real sub-object. `config.providers` is
  // keyed by UPSTREAM provider, so ['providers','freellmapi'] resolves to
  // nothing: the row then counts as unconfigured, is hidden from the card list,
  // and Save writes a junk key into the upstream map. The empty path is correct.
  assert(Array.isArray(entry.settingsPath) && entry.settingsPath.length === 0, `settingsPath must be [] (saw ${JSON.stringify(entry.settingsPath)})`)
  assert(entry.settingsNs === entry.provider, `settingsNs "${entry.settingsNs}" != provider "${entry.provider}"`)
  assert(entry.declared === true, 'entry must be declared: true')
  return `provider=${entry.provider}, settingsNs=${entry.settingsNs}, settingsPath=[]`
})

// ---------------------------------------------------------------------------
// G4 — UI red lines that have already broken this plugin once
// ---------------------------------------------------------------------------

assertion('G4', 'browser half: static inject, no harness require, no DOM writes, no colour literals', () => {
  const src = read('lib/client.js')
  const notes = []

  const requires = [...src.matchAll(/require\((['"`])([^'"`]+)\1\)/g)].map((m) => m[2])
  const allowed = new Set(['react', 'react/jsx-runtime'])
  const extra = requires.filter((r) => !allowed.has(r))
  assert(extra.length === 0, `client half requires ${extra.join(', ')} — only react and react/jsx-runtime are shell-seeded`)
  assert(!/require\(['"`]@deepseek-ai\//.test(src), 'client half must not require a Harness package')
  assert(!/\bwindow\.document\b/.test(src), 'client half must not reach for the document')
  assert(!/document\.body/.test(src), 'client half must not touch document.body')
  assert(!/<iframe/.test(src), 'client half must not host a page in an iframe')
  notes.push('requires only react')

  const colour = src.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/)
  assert(colour === null, `client half contains a colour literal (${colour?.[0]}) — theme tokens only`)
  const tokens = [...src.matchAll(/--dsw-[a-z0-9-]+/g)].length
  assert(tokens > 0, 'client half uses no --dsw-* theme tokens')
  notes.push(`${tokens} theme tokens, 0 colour literals`)

  // A function here is the documented cordis trap: the plugin declares zero
  // dependencies and apply() throws on the first service it reaches for.
  const manifest = JSON.parse(read('package.json'))
  const ordering = manifest.dsh?.client?.inject
  assert(Array.isArray(ordering), 'dsh.client.inject must be a static array')
  assert(ordering.includes('@deepseek-ai/dsh-client-ui-settings'), 'dsh.client.inject must order activation after the settings slot owner')
  notes.push(`inject edges: ${ordering.length}`)
  return notes.join('; ')
})

// ---------------------------------------------------------------------------
// G5 — the test suite
// ---------------------------------------------------------------------------

assertion('G5', 'test suite passes (method: node --test, parse the summary)', () => {
  let out = ''
  try {
    out = execFileSync(process.execPath, ['--test', 'tests/**/*.test.mjs'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    out = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
  const pass = Number(out.match(/^# pass (\d+)/m)?.[1] ?? out.match(/ℹ pass (\d+)/)?.[1] ?? -1)
  const fail = Number(out.match(/^# fail (\d+)/m)?.[1] ?? out.match(/ℹ fail (\d+)/)?.[1] ?? -1)
  assert(pass >= 0 && fail >= 0, 'could not parse the test summary')
  assert(fail === 0, `${fail} test(s) failed`)
  return `${pass} passed, ${fail} failed`
})

// ---------------------------------------------------------------------------
// G6 — the generated browser table is current
// ---------------------------------------------------------------------------

assertion('G6', 'generated client table matches lib/providers.js (method: --check)', () => {
  execFileSync(process.execPath, ['tests/regenerate-client-setup.mjs', '--check'], { cwd: ROOT, encoding: 'utf8' })
  return 'client-setup block is current'
})

// ---------------------------------------------------------------------------
// G7 — every pool provider is reachable *by the method that suits it*
// ---------------------------------------------------------------------------

/**
 * Probe one provider correctly.
 *
 * The method is per-provider and that is the whole point:
 *
 *   - a **keyless** provider must be probed with NO Authorization header. Send
 *     a bogus one and a working provider answers 403 (measured: ovh 200 → 403),
 *     which reads as "blocked" when it means "the key you invented is invalid".
 *   - a **key-required** provider must be probed WITH a syntactically valid but
 *     bogus header. Without it, an edge WAF answers 403 for anonymous requests
 *     even from a perfectly reachable region (measured: groq 403 → 401).
 *
 * A 403 is therefore never self-explanatory: it is "anonymous rejected",
 * "credential rejected" or "region rejected" depending entirely on what was
 * sent. Reporting one without the other is how the README got a wrong table.
 */
async function probe(provider, baseURL, keyless) {
  const url = `${baseURL.replace(/\/$/, '')}/models`
  const headers = { 'user-agent': 'dsh-freellmapi-gate/1.0' }
  if (!keyless) headers.authorization = 'Bearer dsh-freellmapi-gate-probe-not-a-real-key'
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) })
    return { provider, status: response.status, method: keyless ? 'anonymous' : 'bogus-key' }
  } catch (error) {
    return { provider, status: null, method: keyless ? 'anonymous' : 'bogus-key', error: error.name }
  }
}

const verdictOf = (row) => {
  if (row.error !== undefined) return 'UNREACHABLE'
  if (row.status === 401) return 'reachable'
  if (row.status === 200) return 'reachable'
  if (row.status === 403) return row.method === 'anonymous' ? 're-probe with a key' : 'AMBIGUOUS (bad-key or region)'
  if (row.status === 404 || row.status === 400 || row.status === 422) return 'reachable (different path)'
  if (row.status === 429) return 'reachable (rate limited)'
  return `HTTP ${row.status}`
}

if (ONLINE) {
  const { providerDeclarations } = await import(moduleUrl('lib/providers.js'))
  const declarations = providerDeclarations({})
  const rows = []
  for (const d of declarations) {
    rows.push({ ...(await probe(d.id, d.baseURL, d.keyless === true)), enabled: d.enabled === true, keyless: d.keyless === true })
  }
  // Reachability is informational: a provider being unreachable from THIS
  // network is not a defect in the plugin, and treating it as one would make the
  // gate fail on a train. The gate records the measurement; a human decides.
  const unreachable = rows.filter((r) => verdictOf(r) === 'UNREACHABLE')
  record('G7', 'pool reachability (informational, method-aware probes)', true,
    `${rows.length} probed, ${unreachable.length} unreachable${unreachable.length > 0 ? `: ${unreachable.map((r) => r.provider).join(', ')}` : ''}`)
  results[results.length - 1].rows = rows
}

// ---------------------------------------------------------------------------
// G8 — upstream drift
// ---------------------------------------------------------------------------

if (ONLINE) {
  const drift = await (async () => {
    const response = await fetch('https://api.github.com/repos/tashfeenahmed/freellmapi/contents/shared/types.ts', {
      headers: { 'user-agent': 'dsh-freellmapi-gate/1.0', accept: 'application/vnd.github.raw' },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`upstream types.ts: HTTP ${response.status}`)
    const source = await response.text()
    const start = source.split(/\r?\n/).findIndex((l) => /^export type Platform\s*=/.test(l))
    if (start < 0) throw new Error('upstream Platform union not found — the file moved')
    const upstream = []
    for (const line of source.split(/\r?\n/).slice(start + 1)) {
      const hit = line.trim().match(/^\|\s*'([^']+)'/)
      if (hit !== null) { upstream.push(hit[1]); continue }
      const t = line.trim()
      if (t.startsWith('//') || t === '') continue
      break
    }
    const { providerDeclarations } = await import(moduleUrl('lib/providers.js'))
    const mine = new Set(providerDeclarations({}).map((d) => d.id))
    const theirs = new Set(upstream.filter((p) => p !== 'custom'))
    const missing = [...theirs].filter((p) => !mine.has(p))
    const extra = [...mine].filter((p) => !theirs.has(p))
    return { total: theirs.size, mine: mine.size, missing, extra }
  })()
  // Drift is informational too: `extra` is a real defect (we shipped a provider
  // upstream does not have), `missing` is the expansion backlog.
  assert(drift.extra.length === 0, `we declare providers upstream does not have: ${drift.extra.join(', ')}`)
  record('G8', 'upstream drift (informational)', true,
    `upstream ${drift.total} platforms, we carry ${drift.mine}; ${drift.missing.length} not yet adopted`)
  results[results.length - 1].missing = drift.missing
}

// ---------------------------------------------------------------------------
// G9 — free-model evidence drift (informational, anonymous)
// ---------------------------------------------------------------------------

if (ONLINE) {
  const drift = await (async () => {
    const { BUILTIN_PROVIDERS } = await import(moduleUrl('lib/providers.js'))
    const { FREE_VERIFIED_STALE_DAYS, freeVerificationState, isFreePriced, verifiedAgeDays } = await import(moduleUrl('lib/free.js'))
    // Anonymous on purpose: OpenRouter's catalogue is readable with no credential,
    // which is exactly why this check is affordable to run every time. Sending a
    // key would make the measurement depend on the account, and the pool's claim is
    // about the public catalogue.
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { accept: 'application/json', 'user-agent': 'dsh-freellmapi-gate/1.0' },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`openrouter /models: HTTP ${response.status}`)
    const payload = await response.json()
    const free = new Set((payload.data ?? []).filter((entry) => isFreePriced(entry?.pricing)).map((entry) => entry.id))
    const rows = []
    for (const provider of BUILTIN_PROVIDERS) {
      if (provider.id !== 'openrouter') continue
      for (const entry of provider.models) {
        rows.push({
          id: entry.id,
          upstream: free.has(entry.id) ? 'zero-priced' : 'absent-or-paid',
          age: verifiedAgeDays(entry.verified),
          evidence: freeVerificationState(entry.verified),
          freeVerdict: free.has(entry.id) ? 'ok' : 'DRIFT (re-measure before shipping)',
        })
      }
    }
    return { entries: (payload.data ?? []).length, freeCount: free.size, staleDays: FREE_VERIFIED_STALE_DAYS, rows }
  })()
  const drifted = drift.rows.filter((row) => row.freeVerdict !== 'ok')
  const stale = drift.rows.filter((row) => row.evidence === 'stale' || row.evidence === 'expired')
  // Informational, for the same reason G7 and G8 are: a provider changing its free
  // set is an upstream event, not a defect in this plugin — but it must be
  // *visible* before someone ships a dead row. The blocking half lives offline in
  // `tests/free-model-guard.test.mjs`, against the committed fixture bytes.
  record('G9', 'free-model evidence drift (informational, anonymous price check)', true,
    `${drift.rows.length} free rows vs ${drift.freeCount} zero-priced upstream entries of ${drift.entries}: ${drifted.length} drifted, ${stale.length} stale (>${drift.staleDays}d)`)
  results[results.length - 1].rows = drift.rows
}

// ---------------------------------------------------------------------------
// verdict
// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.ok)
if (JSON_OUT) {
  process.stdout.write(`${JSON.stringify({ ok: failed.length === 0, results }, null, 2)}\n`)
} else {
  const width = Math.max(...results.map((r) => r.title.length))
  console.log('\n  dsh-freellmapi gate\n')
  for (const r of results) {
    console.log(`  ${r.ok ? '✔' : '✘'} ${r.id.padEnd(3)} ${r.title.padEnd(width)}  ${r.detail}`)
    if (Array.isArray(r.rows)) for (const row of r.rows) {
      // G9 rows carry the free-model drift shape, not a reachability probe shape.
      if (row.freeVerdict !== undefined) {
        console.log(`        ${String(row.id).padEnd(50)} ${String(row.upstream).padEnd(15)} age=${String(row.age).padStart(4)}d  ${String(row.evidence).padEnd(8)} ${row.freeVerdict}`)
        continue
      }
      console.log(`        ${row.provider.padEnd(13)} ${String(row.status ?? '—').padEnd(5)} ${row.method.padEnd(10)} ${verdictOf(row)}${row.enabled ? '' : '  (disabled by default)'}`)
    }
  }
  console.log(`\n  ${failed.length === 0 ? 'PASS' : `FAIL — ${failed.map((r) => r.id).join(', ')}`}${ONLINE ? '' : '   (offline; add --online for G7/G8)'}\n`)
}
process.exit(failed.length === 0 ? 0 : 1)
