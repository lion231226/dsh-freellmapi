/**
 * Flake probe: run the `nvidia` extraBody scenario in a tight loop and dump the
 * full chunk sequence the first time the request fails to reach the mock.
 *
 * The suite-level symptom was `mock.requests.at(-1)` being `undefined` — zero
 * requests recorded — while `collect()` returned normally. That combination only
 * makes sense if the stream ended with an error/finish chunk the collector
 * tolerates. This prints that chunk.
 */

import { clearRecentRoutes } from '../lib/routes.js'
import { mountPlugin } from '../tests/helpers/context.mjs'
import { offlinePool, startProviderMock } from '../tests/helpers/pool.mjs'

const ask = (text, extra = {}) => ({
  provider: 'freellmapi',
  model: 'auto',
  messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  ...extra,
})

const ITERATIONS = Number(process.argv[2] ?? 200)

for (let i = 1; i <= ITERATIONS; i += 1) {
  const mock = await startProviderMock({
    ids: ['meta/llama-3.3-70b-instruct', 'qwen/qwen3-coder-480b-a35b-instruct'],
    answer: 'MERGED',
  })
  try {
    clearRecentRoutes()
    const mounted = mountPlugin({
      config: {
        mode: 'direct',
        providers: {
          ...offlinePool([]),
          nvidia: {
            enabled: true,
            baseURL: mock.baseURL,
            apiKey: 'test-key-not-real',
            extraBody: { top_p: 0.25 },
          },
        },
      },
    })

    const chunks = []
    let thrown = null
    try {
      for await (const entry of mounted.adapter.stream(ask('hello'))) chunks.push(entry)
    } catch (error) {
      thrown = error
    }

    if (mock.requests.length === 0) {
      console.log(`\n=== FAILED at iteration ${i} ===`)
      console.log('mock hits :', mock.hits)
      console.log('baseURL   :', mock.baseURL)
      console.log('thrown    :', thrown === null ? '(none)' : `${thrown.name}: ${thrown.message}`)
      console.log('chunks    :', JSON.stringify(chunks, null, 2))
      process.exit(0)
    }
  } finally {
    await mock.close()
  }
}

console.log(`no failure in ${ITERATIONS} iterations`)
