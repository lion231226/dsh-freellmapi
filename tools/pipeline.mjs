#!/usr/bin/env node
/**
 * Self-optimisation pipeline: catalogue scan → candidate verification → advice.
 *
 * ## What this is, and the design constraint that shapes it
 *
 * `PROJECT-RULES.md` §2 describes self-optimisation as **advice, never automatic
 * config rewriting**: silently adjusting a user's configuration is the most
 * expensive failure shape this project has (rule 1), and "the config is the user's"
 * is a promise. So this tool **reads and reports**. It never writes `lib/providers.js`,
 * never edits a profile, never enables a provider.
 *
 * ## Division of labour with the gate (they must not duplicate each other)
 *
 * | question | owner |
 * |---|---|
 * | do we declare an id the provider does **not** serve? | gate **G10** (blocking) |
 * | does the provider serve something we have **not** declared? | **this pipeline** |
 * | is a free claim still supported by committed bytes? | gate **G9** |
 * | is a *candidate* plausibly free, and is it live? | **this pipeline**, reported per candidate |
 *
 * G10 protects the pool from rotting. This finds what is worth adding. Neither
 * substitutes for the other, which is why the second exists rather than being folded
 * into the first.
 *
 * ## Stages, and what each can honestly claim
 *
 * 1. **SCAN** — fetch each *credential-free* catalogue and set it against our ids.
 *    Providers needing a key are recorded `not checked`: a 401 is not evidence that a
 *    catalogue is empty, and pretending otherwise is how a scan reports zero
 *    candidates with total confidence.
 * 2. **TRIAGE** — for each candidate, evaluate the **price half** of the free
 *    criterion (`lib/free.js`, the single definition). This is anonymous and cheap.
 *    It never decides "this model is free" — only "its list price is zero".
 * 3. **ADVISE** — emit a report. Capability data (`contextWindow`, `toolCalling`,
 *    `vision`, `reasoning`) is deliberately **not** guessed here: those require the
 *    probe kits under `_lead/`, whose results carry a method and a date. A pipeline
 *    that filled them in from a model name would be manufacturing exactly the kind of
 *    unsourced number this project has already paid for twice.
 *
 * ## Telemetry is NOT in scope, and says so
 *
 * §2 wants routing telemetry turned into pool advice ("never wins", "always cooling",
 * "average attempts rising"). Those facts live in the **running** process
 * (`logRouting`, `lib/routes.js` `getRecentRoutes()`, `lib/health.js` EWMA) and a
 * script cannot reach them. This tool prints that as an explicit gap in its own
 * output rather than emitting a plausible-looking section with no data behind it.
 *
 * ## Usage
 *
 *   node tools/pipeline.mjs                 # offline: pool self-consistency only
 *   node tools/pipeline.mjs --online        # + SCAN and TRIAGE
 *   node tools/pipeline.mjs --online --json # machine-readable
 */
import { providerDeclarations } from '../lib/providers.js'
import { isZeroPrice, FREE_CRITERION } from '../lib/free.js'

const ONLINE = process.argv.includes('--online')
const JSON_OUT = process.argv.includes('--json')
const UA = 'dsh-freellmapi-pipeline/1.0'

/** One provider's catalogue, or a recorded reason there is none. */
async function fetchCatalogue (declaration) {
  const url = `${declaration.baseURL.replace(/\/$/, '')}/models`
  if (declaration.keyless !== true) {
    return { checked: false, reason: `needs ${declaration.apiKeyEnv} — a 401 would not prove the catalogue empty` }
  }
  try {
    const response = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20_000) })
    if (response.status !== 200) return { checked: false, reason: `HTTP ${response.status}` }
    const body = await response.json()
    const list = Array.isArray(body?.data) ? body.data : (Array.isArray(body?.models) ? body.models : null)
    if (list === null) return { checked: false, reason: 'no recognisable model list' }
    return { checked: true, models: list }
  } catch (error) {
    return { checked: false, reason: error.name }
  }
}

/** Pull an id, its full price row, and a context figure out of whichever shape this catalogue uses. */
function readRow (row) {
  const id = String(row?.id ?? row?.name ?? '')
  if (id.length === 0) return null
  const pricing = row?.pricing ?? null
  return {
    id,
    // The STRONG form of the price half: every price field zero, `discount` ignored.
    // The weak form (`prompt`/`completion` only) would pass a row that still charges
    // for images or web search, and "cheap tokens, paid everything else" is not free.
    zeroPrice: isZeroPrice(pricing),
    contextWindow: row?.context_length ?? row?.context_window ?? row?.top_provider?.context_length ?? null,
  }
}

const declarations = providerDeclarations({})
const report = {
  generatedAt: new Date().toISOString(),
  method: 'credential-free GET {baseURL}/models, compared against the shipped pool; price half of the free criterion from lib/free.js',
  criterion: FREE_CRITERION,
  scanned: [],
  dead: [],
  candidates: [],
  notChecked: [],
  telemetryGap: 'routing telemetry (never-wins / always-cooling / attempt-count trend) lives in the RUNNING process — logRouting, lib/routes.js getRecentRoutes(), lib/health.js — and is not reachable from a script. That stage of §2 is not implemented here.',
}

if (!ONLINE) {
  report.note = 'offline: no catalogue was fetched. Re-run with --online.'
} else {
  for (const declaration of declarations) {
    const catalogue = await fetchCatalogue(declaration)
    if (catalogue.checked !== true) {
      report.notChecked.push({ provider: declaration.id, reason: catalogue.reason })
      continue
    }
    const rows = catalogue.models.map(readRow).filter((row) => row !== null)
    const served = new Map(rows.map((row) => [row.id, row]))
    const declared = new Set((declaration.models ?? []).map((model) => model.id))
    const missing = [...declared].filter((id) => !served.has(id))
    // Only zero-priced ids we do NOT already carry are candidates: this pipeline
    // exists to find what is worth adding, not to re-list the pool.
    const fresh = rows.filter((row) => !declared.has(row.id) && row.zeroPrice)
    report.scanned.push({ provider: declaration.id, served: served.size, declared: declared.size, missing: missing.length, fresh: fresh.length })
    for (const id of missing) report.dead.push({ provider: declaration.id, id })
    for (const row of fresh) {
      report.candidates.push({
        provider: declaration.id,
        id: row.id,
        contextWindow: row.contextWindow,
        priceVerdict: 'list price is zero — the OTHER half (a serving endpoint) still needs a probe',
        needsBeforeAdoption: [
          'endpoints >= 1 — measured with a credential, not inferred',
          'toolCalling / vision / reasoning — via the probe kits under _lead/, with method and date recorded in `source:`',
          'capability / speed — a JUDGEMENT, which must be labelled as one, never dressed as a measurement',
        ],
      })
    }
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log('self-optimisation pipeline — ADVICE ONLY, nothing was modified\n')
  console.log(`criterion : ${report.criterion}`)
  console.log(`method    : ${report.method}\n`)
  if (report.note !== undefined) console.log(report.note)
  if (report.scanned.length > 0) {
    console.log('SCAN')
    for (const row of report.scanned) {
      console.log(`  ${row.provider.padEnd(14)} served=${String(row.served).padEnd(5)} declared=${String(row.declared).padEnd(4)} dead=${row.missing}  new-zero-priced=${row.fresh}`)
    }
  }
  if (report.dead.length > 0) {
    console.log(`\nDEAD IDS (${report.dead.length}) — gate G10 blocks on these for enabled providers`)
    for (const row of report.dead) console.log(`  ${row.provider}/${row.id}`)
  }
  if (report.candidates.length > 0) {
    console.log(`\nCANDIDATES (${report.candidates.length}) — upstream serves these at list price zero and we do not carry them`)
    for (const row of report.candidates) console.log(`  ${row.provider.padEnd(14)} ${String(row.id).padEnd(52)} ctx=${row.contextWindow ?? '?'}`)
    console.log('\n  Nothing above is adopted by this tool. Each needs the listed evidence first;')
    console.log('  a candidate that has only its price verified is not yet a safe pool row.')
  }
  if (report.notChecked.length > 0) {
    console.log(`\nNOT CHECKED (${report.notChecked.length})`)
    for (const row of report.notChecked) console.log(`  ${row.provider.padEnd(14)} ${row.reason}`)
  }
  console.log(`\nGAP: ${report.telemetryGap}`)
  console.log('\nNo file was written and no configuration was changed.')
}
