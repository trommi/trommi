// shrink.mjs: ddmin over the action list. An action whose names do not resolve any more (its creator was removed from
// the list) becomes a skip, so removing any subset is safe. The predicate is "the same kind of failure again".
import { runActions } from '../model.mjs'

export const signature = f => {
  const lines = String(f.message).split('\n').filter(l => l.trim()); const first = lines.slice(0, 2).join(' / ')
  const norm = first.replace(/[0-9a-f]{8,}/g, '<h>').replace(/\b\d+\b/g, 'N').replace(/FZMARK[^ ]*( b\d+)?( FZMARK-\w+)?/g, 'FZ').replace(/\r?\n/g, ' ').replace(/r\d+:[HA]\d+/g, 'DEV').replace(/\s+/g, ' ').slice(0, 150)
  return `${f.kind}: ${norm}`
}

export async function shrink(actions, failure, opts, { budgetMs = 240000, log = () => {}, tries = 1 } = {}) {
  const sig = signature(failure)
  const t0 = Date.now()
  let runs = 0
  const fails = async list => {
    for (let k = 0; k < tries; k++) {
      runs++
      const r = await runActions(list, { ...opts, deadline: Infinity })
      if (!r.ok && signature(r.finding) === sig) return r
    }
    return null
  }
  // everything after the failing step is irrelevant
  let cur = actions.slice(0, Math.min(actions.length, (failure.step ?? actions.length) + 1))
  let last = await fails(cur)
  if (!last) { cur = actions; last = await fails(cur); if (!last) return { actions: cur, flaky: true, runs } }
  let n = 2
  while (cur.length >= 2 && Date.now() - t0 < budgetMs) {
    const size = Math.ceil(cur.length / n)
    let reduced = false
    for (let i = 0; i < cur.length; i += size) {
      if (Date.now() - t0 > budgetMs) break
      const cand = cur.slice(0, i).concat(cur.slice(i + size))
      if (!cand.length || cand[0].t !== 'found') continue
      const r = await fails(cand)
      if (r) { cur = cand; last = r; n = Math.max(n - 1, 2); reduced = true; break }
    }
    if (!reduced) { if (n >= cur.length) break; n = Math.min(cur.length, n * 2) }
  }
  const finalCut = last.finding.step != null ? cur.slice(0, last.finding.step + 1) : cur
  return { actions: cur, finalCut, runs, ms: Date.now() - t0, finding: last.finding, trace: last.trace }
}
