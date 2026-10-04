// worker.mjs: one worker thread: seeds in a loop (rotating mode and size), shrink every new failure, report to run.mjs.
import { parentPort, workerData } from 'node:worker_threads'
import { generate, runActions } from './model.mjs'
import { shrink, signature } from './lib/shrink.mjs'
import { makeRng } from './lib/rng.mjs'

const { id, baseSeed, mode: forcedMode, root, remote, quick, until, steps: forcedSteps, seen: seenInit, noshrink } = workerData
const seen = new Set(seenInit)
const send = m => parentPort.postMessage({ worker: id, ...m })
let n = 0
parentPort.on('message', m => { if (m.type === 'seen') seen.add(m.sig) })
while (Date.now() < until) {
  const seed = `${baseSeed}-w${id}-${n++}`
  const rng = makeRng(seed)
  const mode = forcedMode ?? (remote ? (rng.chance(0.5) ? 'chaos' : 'strict') : rng.weighted([['strict', 45], ['chaos', 35], ['hostile', 20]]))
  const steps = forcedSteps ?? (quick ? rng.range(30, 60) : mode === 'chaos' ? rng.range(150, 600) : rng.range(80, 300))
  const rooms = rng.chance(0.2) ? 2 : 1
  const actions = generate(seed, { steps, rooms, mode, remote: !!remote })
  send({ type: 'start', seed, mode, steps })
  let res
  try { res = await runActions(actions, { seed, mode, root, remote, port: 0, deadline: Math.min(until, Date.now() + (quick ? 12000 : 15 * 60000)) }) }
  catch (e) { send({ type: 'crash', seed, error: String(e?.stack ?? e) }); continue }
  send({ type: 'done', commit: res.commit, seed, mode, steps, ok: res.ok, stats: res.stats, known: res.known, finding: res.finding })
  if (!res.ok) {
    const sig = signature(res.finding)
    if (seen.has(sig)) { send({ type: 'dup', seed, sig }); continue }
    seen.add(sig)
    let shrunk = null
    if (!quick && !noshrink) { try { shrunk = await shrink(actions, res.finding, { seed, mode, root, remote, port: 0 }, { budgetMs: 4 * 60000 }) } catch (e) { shrunk = { error: String(e) } } }
    let repro = null
    const cut = shrunk?.finalCut ?? shrunk?.actions
    if (cut && !shrunk.flaky && !shrunk.error) { repro = 0; for (let k = 0; k < 3; k++) { const r = await runActions(cut, { seed, mode, root, remote, port: 0 }); if (!r.ok && signature(r.finding) === sig) repro++ } }
    send({ type: 'failure', repro, commit: res.commit, seed, mode, sig, finding: res.finding, trace: res.trace.slice(-25), actions: shrunk?.finalCut ?? shrunk?.actions ?? actions.slice(0, (res.finding.step ?? steps) + 1), shrunk: shrunk && { runs: shrunk.runs, ms: shrunk.ms, flaky: shrunk.flaky, finding: shrunk.finding, trace: shrunk.trace?.slice(-25) } })
  }
}
send({ type: 'exit' })
