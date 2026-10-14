/**
 * Regenerate the `@generated:client-setup` block in `lib/client.js` from
 * `lib/providers.js`.
 *
 *   node tests/regenerate-client-setup.mjs           # rewrite in place
 *   node tests/regenerate-client-setup.mjs --check   # exit 1 when stale
 *
 * The browser half cannot read `lib/providers.js` — the client module system only
 * serves `exports["./client"]`, and pulling a Node module into the bundle would
 * mean shipping the whole provider catalog to the browser. The table is therefore
 * a **generated copy**, and `tests/client.test.mjs` asserts it is current. Two
 * hand-maintained tables is exactly the drift this repository already paid for
 * once (`KEY_ENTRY_POINTS` vs `keyURL`); this keeps one authority and a machine
 * check instead of a second opinion.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { providerDeclarations } from '../lib/providers.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const target = path.join(here, '..', 'lib', 'client.js')
const START = '/* @generated:client-setup:start'
const END = '/* @generated:client-setup:end */'

/** Single-quoted JS string literal, matching the file's existing style. */
function quote(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/** The block that belongs in `lib/client.js`, verbatim. */
export function renderSetupBlock(config) {
  const lines = []
  for (const declaration of providerDeclarations(config)) {
    if (declaration.enabled !== true) continue
    const keyURL = typeof declaration.keyURL === 'string' && declaration.keyURL.length > 0
      ? quote(declaration.keyURL)
      : 'null'
    lines.push(
      `  ${declaration.id}: Object.freeze({ displayName: ${quote(declaration.displayName)}, `
        + `apiKeyEnv: ${quote(declaration.apiKeyEnv)}, keyURL: ${keyURL}, `
        + `keyless: ${declaration.keyless === true} }),`,
    )
  }
  const last = lines.length - 1
  if (last >= 0) lines[last] = lines[last].replace(/,$/, '')
  return [
    `${START} — regenerated from lib/providers.js; a test asserts equality */`,
    '/** Pool providers this card can offer a key field for, keyed by provider id. */',
    'const PROVIDER_SETUP = Object.freeze({',
    ...lines,
    '})',
    END,
  ].join('\n')
}

/** The block currently in the file. */
export function currentSetupBlock(source) {
  const from = source.indexOf(START)
  const to = source.indexOf(END)
  if (from < 0 || to < 0) throw new Error('lib/client.js has no @generated:client-setup block')
  return source.slice(from, to + END.length)
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const source = readFileSync(target, 'utf8')
  const wanted = renderSetupBlock({})
  const current = currentSetupBlock(source)
  if (process.argv.includes('--check')) {
    if (current === wanted) {
      console.log('client-setup block is current')
      process.exit(0)
    }
    console.error('client-setup block is STALE — run: node tests/regenerate-client-setup.mjs')
    process.exit(1)
  }
  if (current === wanted) {
    console.log('client-setup block already current; nothing written')
    process.exit(0)
  }
  writeFileSync(target, source.replace(current, wanted), 'utf8')
  console.log('client-setup block regenerated from lib/providers.js')
}
