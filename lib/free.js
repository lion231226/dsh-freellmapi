/**
 * The one authority for "is this free model actually free".
 *
 * ## Why this module exists
 *
 * The pool used to answer that question with a **naming convention**: a model id
 * ending in `:free` was treated as a free model. On 2026-10-15 all four
 * `openrouter` rows carrying that suffix turned out to be **unservable** — three
 * had a catalogue record but `endpoints: []`, one answered HTTP 404 — while the
 * convention itself was intact for other models (14 of 14 live `:free` ids were
 * genuinely zero-priced). The suffix is part of the upstream id and must stay in
 * the id; it must never be the *judgement*. (`_lead/research/free-model-audit.md`.)
 *
 * ## The criterion
 *
 * ```
 * free  ⇔  pricing.prompt === '0'  &&  pricing.completion === '0'  &&  serving endpoints ≥ 1
 * ```
 *
 * Three deliberate properties:
 *
 * 1. **Prices are compared as the strings the catalogue publishes** (`'0'`), not
 *    as parsed numbers: `Number('') === 0` and `Number(null) === 0`, so a numeric
 *    test would call a missing field free. Only the literal `'0'` (or the number
 *    `0`) counts.
 * 2. **A zero price is not enough** — a model nobody serves cannot be used for
 *    free or otherwise. The four dead ids were exactly this case.
 * 3. **Nothing here reads an id.** `isFreeVerified()` receives an evidence record
 *    and never the model id, so the naming convention cannot leak back in.
 *
 * ## Evidence records, and how they age
 *
 * A `verified` record is *evidence*: the time it was taken, the method used, the
 * price fields observed, the serving-endpoint count, and a hash of the raw
 * response body it came from. Free sets change over time, so evidence has a
 * shelf life — {@link FREE_VERIFIED_STALE_DAYS} (reported by gate G9) and
 * {@link FREE_VERIFIED_BLOCK_DAYS} (a blocking assertion), both read from here so
 * the gate and the tests can never disagree about the threshold.
 *
 * @module dsh-freellmapi/free
 */

/** Beyond this age the evidence is reported as stale (gate G9, informational). */
export const FREE_VERIFIED_STALE_DAYS = 60

/** Beyond this age the offline guard fails: refresh the evidence and the pool. */
export const FREE_VERIFIED_BLOCK_DAYS = 90

const DAY_MS = 86_400_000

/** The criterion, as text, for anything a user reads. */
export const FREE_CRITERION = 'pricing.prompt === "0" && pricing.completion === "0" && endpoints >= 1'

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `'0'` exactly, or the number `0`. Never `''`, `null` or `0.0000001`. */
const isZero = (value) => value === '0' || value === 0

/**
 * The minimal criterion the task book names verbatim:
 * `pricing.prompt === "0" && pricing.completion === "0"`.
 *
 * @param {unknown} pricing
 * @returns {boolean}
 */
export function isFreePriced(pricing) {
  return isRecord(pricing) && pricing.prompt === '0' && pricing.completion === '0'
}

/**
 * The strong form: **every** price field on the row is zero (`discount` is a
 * percentage off, not a price, and is ignored). Some catalogues publish more than
 * `prompt`/`completion` (per-request, image, web-search, cache read/write); a row
 * that charges for one of those is not free, however cheap its tokens are.
 *
 * @param {unknown} pricing
 * @returns {boolean}
 */
export function isZeroPrice(pricing) {
  if (!isRecord(pricing)) return false
  const fields = Object.entries(pricing).filter(([key]) => key !== 'discount')
  if (fields.length === 0) return false
  return fields.every(([, value]) => isZero(value))
}

/**
 * Whether a value is a well-formed evidence record. Shape only — it does not
 * judge freeness. Used by `lib/providers.js` to decide whether a declaration may
 * carry evidence at all.
 *
 * @param {unknown} verified
 * @returns {boolean}
 */
export function isVerifiedRecord(verified) {
  if (!isRecord(verified)) return false
  if (typeof verified.at !== 'string' || !Number.isFinite(Date.parse(verified.at))) return false
  if (typeof verified.method !== 'string' || verified.method.trim().length === 0) return false
  if (!isRecord(verified.pricing)) return false
  if (!Number.isInteger(verified.endpoints) || verified.endpoints < 0) return false
  if (verified.endpointPricingZero !== true) return false
  if (typeof verified.bodySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(verified.bodySha256)) return false
  if (verified.alias !== undefined && typeof verified.alias !== 'boolean') return false
  return true
}

/**
 * The judgement: is this model free, according to evidence?
 *
 * `endpoints >= 1` is required because a zero price is worthless if nothing
 * serves the model. The single exception is an explicit alias row
 * (`alias: true`, e.g. OpenRouter's documented Free Models Router
 * `openrouter/free`, which is dispatched upstream and has no endpoint list of its
 * own) — and it must say so, rather than being waved through.
 *
 * @param {unknown} verified
 * @returns {boolean}
 */
export function isFreeVerified(verified) {
  if (!isVerifiedRecord(verified)) return false
  if (!isFreePriced(verified.pricing)) return false
  return verified.alias === true || verified.endpoints >= 1
}

/**
 * The one-line note appended to a model-picker row, so the claim a user reads
 * states its own criterion and the date it was taken (project rule 3).
 *
 * @param {Record<string, any>} verified
 * @returns {string}
 */
export function freeEvidenceNote(verified) {
  const day = String(verified.at).slice(0, 10)
  return `free: ${FREE_CRITERION}, verified ${day} (anonymous price check)`
}

/**
 * Whole days since the evidence was taken. Negative when `at` is in the future.
 *
 * @param {{at: string}} verified
 * @param {number} [now] epoch milliseconds, injectable for tests
 * @returns {number}
 */
export function verifiedAgeDays(verified, now = Date.now()) {
  return Math.floor((now - Date.parse(verified.at)) / DAY_MS)
}

/**
 * How trustworthy the evidence still is:
 *
 *   - `missing` — no evidence at all (cannot happen in the shipped pool: the
 *     guard rejects a `:free` row without one);
 *   - `ok`      — younger than {@link FREE_VERIFIED_STALE_DAYS};
 *   - `stale`   — older than the reporting threshold, still usable (G9 reports);
 *   - `expired` — older than {@link FREE_VERIFIED_BLOCK_DAYS}, the guard fails.
 *
 * @param {unknown} verified
 * @param {number} [now] epoch milliseconds, injectable for tests
 * @returns {'missing' | 'malformed' | 'ok' | 'stale' | 'expired'}
 */
export function freeVerificationState(verified, now = Date.now()) {
  if (verified === undefined || verified === null) return 'missing'
  if (!isVerifiedRecord(verified)) return 'malformed'
  const age = verifiedAgeDays(/** @type {{at: string}} */ (verified), now)
  if (age > FREE_VERIFIED_BLOCK_DAYS) return 'expired'
  if (age > FREE_VERIFIED_STALE_DAYS) return 'stale'
  return 'ok'
}
