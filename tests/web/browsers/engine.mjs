// engine.mjs: what an engine gives of the things Trommi's core stands on, asked by pages/probe.mjs under the app's
// own Content-Security-Policy, in the page and in a module worker:
//   WebAssembly under 'wasm-unsafe-eval' (and refused without it) · IndexedDB `transaction.durability` for the hint
//   "strict" (core/wasm/js/idb-store.js refuses to write when it does not read back "strict") · Web Locks: exclusive,
//   ifAvailable, a wait given up, steal and its notice, query, a lock freed when its worker ends · a stream of
//   events read with fetch as app/web/core/hub.ts reads it.
// `probeChecks` is also what private.mjs holds a private window against.
import { APP_CSP, CSP_WITHOUT_WASM } from './serve.mjs'

/** What the core's store needs of one context's answers: [ok, what, seen] each. */
export function contextChecks(found, where) {
  if (!found || found.error) return [[false, `${where}: the probe ran`, found?.error ?? null]]
  const l = found.locks ?? {}, d = found.idb?.durability ?? {}, s = found.stream ?? {}
  return [
    [found.wasm === true, `${where}: WebAssembly compiles under the app's policy`, found.wasm],
    [d.strict?.said === 'strict', `${where}: a transaction asked for durability "strict" says "strict"`, found.idb?.error ?? d.strict],
    [found.idb?.readBack === 1024, `${where}: a strict write completes and is read back`, found.idb?.error ?? found.idb?.readBack],
    [/Uint8Array|ArrayBuffer/.test(found.idb?.bytesKey ?? '') && found.idb.bytesKey.endsWith('1,2,3'), `${where}: bytes work as a key`, found.idb?.bytesKey],
    [l.has === true, `${where}: navigator.locks is there`, l.error ?? l.has],
    [l.taken === true && l.secondRefused === true, `${where}: an exclusive lock is taken, a second ifAvailable request gets null`, l],
    [l.query === true, `${where}: locks.query() lists the held lock`, l.query],
    [l.waitGivenUp === 'AbortError', `${where}: a wait for a lock is given up by its signal (AbortError)`, l.waitGivenUp],
    [l.steal === true && l.stolenFrom === 'rejected AbortError', `${where}: steal is granted and the first holder's request rejects with AbortError`, { steal: l.steal, stolenFrom: l.stolenFrom }],
    // (tests/bindings/web/page.mjs `store` writes right after the thief was granted and expects a StoreConflict)
    // (WHEN it is told is a note, not a check: by one promise step it is a race in more than one engine; see probeNotes)
    [/^at once$|microtasks later$/.test(l.markedAfterGrant ?? ''), `${where}: the first holder is told of the steal within the task that granted the thief`, { markedWhenGranted: l.markedWhenGranted, markedAfterGrant: l.markedAfterGrant }],
    [l.freeAfter === true, `${where}: the lock is free after its release`, l.freeAfter],
    [s.status === 200 && s.events >= 4 && s.header === true && s.reads?.length >= 2 && s.reads.at(-1) - s.reads[0] >= 300, `${where}: events of a fetch stream arrive one by one, with the Authorization header sent`, found.stream],
    [s.afterAbort === 'AbortError' || s.afterAbort === 'done', `${where}: aborting ends the stream's read`, s.afterAbort],
    [found.has?.BroadcastChannel === true && found.has?.['AbortSignal.any'] === true, `${where}: BroadcastChannel and AbortSignal.any are there`, found.has],
  ]
}
export function probeChecks(found) {
  const a = found.across ?? {}
  return [
    ...contextChecks(found.page, 'page'),
    ...contextChecks(found.worker, 'module worker'),
    [a.held === true && a.refused === true && typeof a.freedAfterMs === 'number', 'a lock held by a worker is refused to the page, and free once the worker is ended', a],
    [found.violations?.length === 0, 'no violation of the policy', found.violations],
  ]
}
/** The lines a report shows for one probe. */
export function probeNotes(found) {
  const one = c => c?.error ? `error: ${c.error}` : `durability said none/default/relaxed/strict = ${['none', 'default', 'relaxed', 'strict'].map(h => c?.idb?.durability?.[h]?.said ?? c?.idb?.durability?.[h]?.error ?? '?').join('/')}; first strict write ${c?.idb?.durability?.strict?.ms ?? '?'} ms, relaxed ${c?.idb?.durability?.relaxed?.ms ?? '?'} ms, ten strict writes ${JSON.stringify(c?.idb?.strictSeries)} ms; the questions took ${JSON.stringify(c?.took)} ms; steal: the first holder's mark (set as idb-store.js sets it) is ${c?.locks?.markedWhenGranted ? 'set' : 'NOT set'} when the thief's grant is seen (set ${c?.locks?.markedAfterGrant}); set in the rejection's own handler it is ${c?.locks?.directWhenGranted ? 'set' : 'NOT set'} by then; secure context ${c?.secure}; persisted ${JSON.stringify(c?.storage?.persisted)}; quota ${c?.storage?.quota ? Math.round(c.storage.quota / 2 ** 20) + ' MiB' : c?.storage?.quota}; stream reads at ${JSON.stringify(c?.stream?.reads ?? c?.stream?.error)} ms; EventSource ${JSON.stringify(c?.eventSource?.events ?? c?.eventSource)}; missing: ${Object.entries(c?.has ?? {}).filter(([, v]) => !v).map(([k]) => k).join(', ') || 'nothing'}`
  return [`${found.userAgent}`, `page: ${one(found.page)}`, `worker: ${one(found.worker)}`, `a worker's lock freed ${found.across?.freedAfterMs ?? JSON.stringify(found.across)} ms after the worker was ended`]
}

export async function probeIn(profile, url) {
  await profile.page.go(url)
  await profile.page.until("typeof probeAll === 'function'", 'the probe page', 20000)
  return profile.page.js('return probeAll()')
}

export const steps = [
  ['the engine under the app\'s policy, page and module worker: WebAssembly, strict durability, Web Locks, a fetch stream', async ctx => {
    const { check, note } = ctx.run
    await ctx.within('probe', {}, async profile => {
      const found = await probeIn(profile, `${ctx.server.origin}/probe`)
      ctx.report.probe = found
      ctx.report.version = profile.version
      for (const [ok, what, seen] of probeChecks(found)) check(ok, what, seen)
      for (const line of probeNotes(found)) note(line)
    })
  }],
  ['the same by the IP address (127.0.0.1 instead of localhost)', async ctx => {
    const { check, note } = ctx.run
    await ctx.within('probe-ip', {}, async profile => {
      const found = await probeIn(profile, `${ctx.server.numeric}/probe`)
      ctx.report.probeNumeric = found
      for (const [ok, what, seen] of probeChecks(found)) check(ok, what, seen)
      note(`secure context: page ${found.page?.secure}, worker ${found.worker?.secure}`)
    })
  }],
  ['without \'wasm-unsafe-eval\' WebAssembly is refused: in the page by the page\'s policy, in a worker by the policy of the worker script\'s response', async ctx => {
    const { check, note } = ctx.run
    ctx.report.refused = {}
    try {
      for (const [name, policies, where] of [['the page without it', { page: CSP_WITHOUT_WASM, worker: CSP_WITHOUT_WASM }, 'page'], ['the worker\'s script without it, the page with it', { page: APP_CSP, worker: CSP_WITHOUT_WASM }, 'worker']]) {
        Object.assign(ctx.server.policy, policies)
        await ctx.within('refused', {}, async profile => {
          const found = await probeIn(profile, `${ctx.server.origin}/probe`)
          const said = found[where]?.wasm
          ctx.report.refused[where] = said
          check(said?.error && said !== true, `WebAssembly is refused (${name})`, said)
          note(`${name}: ${said?.error ?? JSON.stringify(said)}`)
          if (where === 'worker') check(found.page?.wasm === true, 'the page itself still compiles', found.page?.wasm)
        })
      }
    } finally { Object.assign(ctx.server.policy, { page: APP_CSP, worker: APP_CSP }) }
  }],
]
