// spent.ts: where a device's time goes, summed in milliseconds by part, for measuring (tests/web/e2e/catchup.browser.mjs
// reads it from the core worker as `globalThis.__trommiSpent`). Parts nest: `core` (every call into the device)
// holds `store` (the store's writes of those calls), which holds `wrap` (the values encrypted at rest) and `idb` (the
// strict IndexedDB transaction). `model` is the client's own work on what the engine tells it (outside `core`),
// `cache` the writes of the app's cache, `hub` the waits for the hub's pages of a catch-up. Nothing here is sent
// anywhere; the sums cost two clock reads per counted step.
export interface Spent { core: number; store: number; wrap: number; idb: number; model: number; cache: number; hub: number; items: number; calls: number; writes: number }
export const spent: Spent = { core: 0, store: 0, wrap: 0, idb: 0, model: 0, cache: 0, hub: 0, items: 0, calls: 0, writes: 0 }
;(globalThis as { __trommiSpent?: Spent }).__trommiSpent = spent
type Part = 'core' | 'store' | 'wrap' | 'idb' | 'model' | 'cache' | 'hub'
const clock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())
/** Adds the time `job` takes (until its promise settles) to `part`. */
export async function timed<T>(part: Part, job: () => Promise<T>): Promise<T> {
  const t = clock()
  try { return await job() } finally { spent[part] += clock() - t }
}
/** The same for a step that does not wait. */
export function timedSync<T>(part: Part, job: () => T): T {
  const t = clock()
  try { return job() } finally { spent[part] += clock() - t }
}
/** For a measurement only: `itemByItem` makes the engine hand a catch-up to the core one item per call, as before
 *  `feed` (`globalThis.__trommiMeasure`). */
export const measuring = { itemByItem: false }
;(globalThis as { __trommiMeasure?: typeof measuring }).__trommiMeasure = measuring
/** Sets every sum back to zero. */
export function resetSpent(): void { for (const k of Object.keys(spent) as (keyof Spent)[]) spent[k] = 0 }
