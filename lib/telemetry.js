/**
 * Routing telemetry: the summary that makes §2's self-optimisation loop executable.
 *
 * ## Why this exists
 *
 * `PROJECT-RULES.md` §2 asks for pool advice derived from routing telemetry — "which
 * provider never wins", "which is always cooling", "is the average attempt count
 * rising". Those facts live in the running process (`logRouting`, `getRecentRoutes()`,
 * `lib/health.js`), and `tools/pipeline.mjs` is a script that cannot reach them. So
 * the loop was half-built: the scanner worked, the telemetry half printed a gap.
 *
 * This module is that gap closed. The plugin accumulates a bounded summary and, when
 * the operator opts in, persists it where the pipeline can read it.
 *
 * ## Design decisions, each with a reason
 *
 * **Off by default.** Persisting a file is a side effect. Rule 1 says every side
 * effect needs someone answerable for it, and "the config is the user's" means this
 * one is the user's to switch on. Nothing is written unless `telemetry: true`.
 *
 * **Aggregates only — never a prompt, never a reply, never a reason string.** The
 * summary counts *events*, not *text*. `reasons` is deliberately reduced to counts
 * keyed by a short code: a free-text field would eventually carry conversation
 * content, and a telemetry file is not the place to discover that.
 *
 * **A bounded window, not a log.** `windowSize` caps retained route records. An
 * unbounded file is a new failure mode, and §2 needs trends, not history.
 *
 * **Throttled writes, no timer.** Writing on every request would put IO on the
 * request path; a timer would keep the process alive and needs lifecycle hooks.
 * Instead a write is attempted at most once per `flushIntervalMs`, and a failure to
 * write is *reported by absence*, never by throwing into a request.
 *
 * **Reuse of an existing shape.** `lib/index.js` already guards its route reporting
 * with a comment that observability must never be able to fail a request. The same
 * rule applies here and is enforced by the caller's `try/catch` plus this module
 * never throwing.
 */

/** The default location: a plugin-namespaced directory under DSH's home. */
export const DEFAULT_TELEMETRY_FILE = 'telemetry.json'
export const DEFAULT_FLUSH_INTERVAL_MS = 30_000
export const DEFAULT_WINDOW_SIZE = 500

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** A short, stable bucket for a tier, so an unexpected value cannot explode the map. */
const tierKey = (tier) => (typeof tier === 'string' && /^[a-z]+$/i.test(tier) ? tier : 'unknown')

/**
 * Reduce one route record to the counters §2 needs.
 *
 * Kept separate from the accumulator so it can be tested directly — an accumulator
 * test would pass even if the field names drifted, which is the shape of guard that
 * L22 was about.
 *
 * @param {Record<string, any>} record as handed to `onRoute`
 * @returns {{tier: string, provider: string|null, attempts: number, candidates: number, failed: boolean}}
 */
export function classifyRoute (record) {
  const attempts = Array.isArray(record?.attempts) ? record.attempts : []
  return {
    tier: tierKey(record?.tier),
    provider: typeof record?.provider === 'string' && record.provider.length > 0 ? record.provider : null,
    // The number of candidates tried before one answered. Retries are a pool-health
    // signal: a healthy pool answers on the first or second try.
    attempts: attempts.length > 0 ? attempts.length : 1,
    candidates: Number.isFinite(record?.candidateCount) ? record.candidateCount : 0,
    // A record with no provider means routing failed to place the request at all.
    failed: record?.provider === undefined,
  }
}

/** An empty summary. Shape is stable so `readTelemetry` can compare against it. */
export function emptySummary () {
  return {
    version: 1,
    requests: 0,
    failures: 0,
    attemptsTotal: 0,
    attemptsMax: 0,
    byTier: {},
    byProvider: {},
    updatedAt: null,
  }
}

/**
 * Fold one classified route into a summary, mutating it.
 *
 * @param {ReturnType<typeof emptySummary>} summary
 * @param {ReturnType<typeof classifyRoute>} classified
 */
export function applyRoute (summary, classified) {
  summary.requests += 1
  if (classified.failed) summary.failures += 1
  summary.attemptsTotal += classified.attempts
  if (classified.attempts > summary.attemptsMax) summary.attemptsMax = classified.attempts
  summary.byTier[classified.tier] = (summary.byTier[classified.tier] ?? 0) + 1
  if (classified.provider !== null) {
    const entry = summary.byProvider[classified.provider] ?? { wins: 0, attempts: 0, candidates: 0 }
    entry.wins += 1
    entry.attempts += classified.attempts
    entry.candidates += classified.candidates
    summary.byProvider[classified.provider] = entry
  }
  return summary
}

/**
 * The advice §2 asks for, derived from a summary. Pure: takes a summary, returns
 * findings. No IO, so it can be asserted directly.
 *
 * @param {ReturnType<typeof emptySummary>} summary
 * @param {{enabledProviders?: string[]}} [context]
 */
export function deriveAdvice (summary, context = {}) {
  const findings = []
  const requests = Number(summary?.requests) || 0
  if (requests === 0) return [{ kind: 'no-data', detail: 'no routes recorded yet' }]

  const enabled = Array.isArray(context.enabledProviders) ? context.enabledProviders : null
  if (enabled !== null) {
    // §2: "never wins → consider disabling (it occupies a candidate slot and lengthens
    // sorting)". Only meaningful for providers that were actually in the running.
    const neverWon = enabled.filter((id) => (summary.byProvider?.[id]?.wins ?? 0) === 0)
    if (neverWon.length > 0) {
      findings.push({ kind: 'never-wins', providers: neverWon, detail: 'enabled but never placed a request — occupies candidate slots' })
    }
  }

  const average = requests === 0 ? 0 : summary.attemptsTotal / requests
  if (average > 2) {
    findings.push({ kind: 'attempts-rising', average: Number(average.toFixed(2)), detail: 'the pool is retrying more than twice per request on average' })
  }

  const tiers = Object.entries(summary.byTier ?? {}).sort((a, b) => b[1] - a[1])
  if (tiers.length > 0) {
    // “该 tier 的候选是否够宽” — a dominant tier is where candidate width matters most.
    findings.push({ kind: 'tier-mix', dominant: tiers[0][0], share: Number((tiers[0][1] / requests).toFixed(2)) })
  }

  const failures = Number(summary.failures) || 0
  if (failures > 0) {
    findings.push({ kind: 'failures', count: failures, rate: Number((failures / requests).toFixed(3)), detail: 'routing placed no provider for these requests' })
  }
  return findings
}

/**
 * A telemetry accumulator with a throttled, best-effort writer.
 *
 * @param {object} options
 * @param {boolean} options.enabled      when false, `record` does nothing at all
 * @param {string} options.file          absolute path to write
 * @param {() => Promise<typeof import('node:fs')>} options.fsLoader  injected so tests never touch disk
 * @param {number} [options.flushIntervalMs]
 * @param {number} [options.windowSize]
 * @param {() => number} [options.now]
 */
export function createTelemetry (options) {
  const enabled = options?.enabled === true
  const file = typeof options?.file === 'string' && options.file.length > 0 ? options.file : null
  const fsLoader = options?.fsLoader
  const flushIntervalMs = Number.isFinite(options?.flushIntervalMs) ? options.flushIntervalMs : DEFAULT_FLUSH_INTERVAL_MS
  const windowSize = Number.isFinite(options?.windowSize) && options.windowSize > 0 ? options.windowSize : DEFAULT_WINDOW_SIZE
  const now = typeof options?.now === 'function' ? options.now : Date.now

  let summary = emptySummary()
  let window = []
  let lastFlush = 0
  let writesAttempted = 0
  let writeFailures = 0
  let lastError = null

  return {
    get enabled () { return enabled && file !== null && typeof fsLoader === 'function' },
    get summary () { return summary },
    /** Diagnostics a test can assert without touching the filesystem. */
    get stats () { return { writesAttempted, writeFailures, lastError, retained: window.length } },

    /**
     * Fold one route in. Never throws: observability must not be able to fail a
     * request (the same rule `lib/index.js` states for its own reporting).
     */
    record (record) {
      if (!this.enabled) return false
      try {
        window.push(record)
        if (window.length > windowSize) window = window.slice(-windowSize)
        applyRoute(summary, classifyRoute(record))
        return true
      } catch (error) {
        lastError = error?.message ?? String(error)
        return false
      }
    },

    /** Write now if the throttle allows and anything changed. Best effort. */
    async flush (force = false) {
      if (!this.enabled) return false
      const at = now()
      if (!force && at - lastFlush < flushIntervalMs) return false
      lastFlush = at
      writesAttempted += 1
      try {
        const fs = await fsLoader()
        const { mkdir, writeFile } = fs.promises ?? fs
        const directory = file.replace(/[\\/][^\\/]+$/, '')
        if (directory.length > 0 && directory !== file) await mkdir(directory, { recursive: true })
        const payload = { ...summary, updatedAt: new Date(at).toISOString() }
        await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
        return true
      } catch (error) {
        writeFailures += 1
        lastError = error?.message ?? String(error)
        return false
      }
    },
  }
}

/**
 * Read a persisted summary, for `tools/pipeline.mjs`.
 *
 * Returns `null` rather than throwing or inventing a shape: "no telemetry" and
 * "telemetry says zero" are different findings, and the pipeline must be able to
 * tell them apart instead of reporting an empty pool as a healthy one.
 *
 * @param {{readFile: (path: string, encoding: string) => Promise<string>}} fs
 * @param {string} file
 */
export async function readTelemetry (fs, file) {
  try {
    const text = await fs.readFile(file, 'utf8')
    const parsed = JSON.parse(text)
    if (!isRecord(parsed) || !Number.isFinite(parsed.requests)) return null
    return parsed
  } catch {
    return null
  }
}
