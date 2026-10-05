// model.mjs: the model-based fuzzer. One run = one seed = one world (hub + rooms + devices) driven by a pre-generated
// action sequence; invariants are checked after every step (cheap) and at checkpoints (deep).
//   node dev/fuzz/model.mjs --seed S [--steps N] [--mode strict|chaos] [--hub URL] [--root DIR] [--replay trace.json] [--keep]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeRng } from './lib/rng.mjs'
import { loadTarget, FUZZ_DIR } from './lib/env.mjs'
import { World, Finding, sleep } from './lib/world.mjs'
import { Gen, Runner } from './lib/actions.mjs'
import * as C from './lib/check.mjs'
import * as adversary from './lib/adversary.mjs'

export function generate(seed, { steps = 200, rooms = 1, mode = 'strict', remote = false } = {}) {
  const rng = makeRng(seed)
  const g = new Gen(rng, { rooms, profile: mode, remote })
  const actions = []
  for (let i = 0; i < rooms; i++) actions.push({ t: 'found', room: i })
  // seed the cast so that the first actions are productive
  for (let i = 0; i < rooms; i++) {
    actions.push({ t: 'invite_agent', room: i, inviter: `r${i}:H0`, name: `r${i}:A0`, _add: 'agent' }); g.R[i].agents.push(`r${i}:A0`); g.R[i].nA = 1
  }
  while (actions.length < steps) actions.push(g.next())
  return actions
}

/** Run one action list. Returns { ok, finding?, stats, log }. Rounds: strict = one action per round; chaos = several at once. */
export async function runActions(actions, { seed = 'x', mode = 'strict', root, remote = null, deepEvery = 25, log = () => {}, keepDir = false, round = 4, onStep = null, deadline = Infinity, inspect = null, port = 0 } = {}) {
  const target = await loadTarget(root)
  const w = new World({ seed, target, remote })
  w.hubPort = port
  const hostile = mode === 'hostile'
  const strict = mode === 'strict' || hostile
  const R = new Runner(w, { strict })
  w.runner = R
  if (hostile) { w.adversary = adversary; w.attack = adversary.makeAttack(seed, adversary.ATTACKS[Math.abs([...String(seed)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)) % adversary.ATTACKS.length]) }
  if (remote) w.onRoom = room => { try { fs.appendFileSync(path.join(FUZZ_DIR, 'remote-rooms.jsonl'), JSON.stringify({ at: new Date().toISOString(), hub: remote, room_id: room.room_id, tag: `fuzz-${seed}`, mode }) + '\n') } catch {} }
  const t0 = performance.now()
  let finding = null, step = 0
  const trace = []
  try {
    await w.startHub()
    let i = 0
    while (i < actions.length) {
      if (Date.now() > deadline) break
      const group = strict ? [actions[i]] : actions.slice(i, i + (actions[i].t === 'found' || actions[i].t === 'invite_agent' || actions[i].t === 'invite_human' || actions[i].t === 'recover' || actions[i].t === 'remove' ? 1 : round)).filter((a, k, arr) => k === 0 || !['found', 'invite_agent', 'invite_human', 'recover', 'remove'].includes(a.t))
      i += group.length
      w.batch++
      const outs = await Promise.all(group.map(async a => { try { return [a, await R.run(a)] } catch (e) { return [a, e] } }))
      for (const [a, o] of outs) { trace.push({ i: step, a, o: o instanceof Error ? `ERR ${o.message.split('\n')[0]}` : o }); step++ }
      for (const [, o] of outs) if (o instanceof Error) throw o
      onStep?.(step)
      // after every step
      { const top = [...(w.http.hot ?? [])].sort((x, y) => y[1] - x[1])[0]; if (top && top[1] > 40000) throw new Finding('hot-loop', `a client sent ${top[1]} requests in one run: ${top[0]} (busy retry loop without backoff)`) }
      if (hostile) { await sleep(40); await C.checkSafety(R); C.checkHub(w); C.checkCommands(R); onStep?.(step); if (step % deepEvery === 0) await C.checkSafety(R, { deep: true }); continue }
      await w.quiesce({ timeout_ms: 30000 })
      C.checkHub(w); C.checkCommands(R); C.checkNoForeign(R); C.checkRemoved(R); C.checkIsolation(R)
      if (strict && !R.stopCompare) await C.checkOracle(R)
      else if (step % 5 === 0) await C.checkConvergence(R)
      if (step % deepEvery === 0 || i >= actions.length) await deep(w, R, { strict })
    }
    if (hostile) await hostileEnd(w, R)
    else await deep(w, R, { strict })
  } catch (e) {
    finding = e instanceof Finding ? e : new Finding('exception', e?.stack ?? String(e))
    finding.step = step
    if (inspect) await inspect(w, R, finding)
  }
  const ms = performance.now() - t0
  const res = { ok: !finding, finding: finding && { kind: finding.kind, message: finding.message, step: finding.step, action: finding.action ?? null }, stats: { ...w.stats, ms, http: w.http.total, envelopes: w.hub ? Number(w.hub.db.prepare('SELECT COUNT(*) c FROM envelopes').get().c) : null, byStatus: w.http.byStatus, slowestMs: w.http.slowest }, trace, rooms: w.rooms.map(r => r?.room_id), known: [...w.known], commit: target.commit }
  await w.shutdown()
  if (!keepDir) w.cleanup(); else res.dir = w.dir
  return res
}

async function hostileEnd(w, R) {
  const a = w.attack
  await C.checkSafety(R, { deep: true })
  // detection: a client that was handed flipped bits must have said so
  // a device with network faults may drop a tampered copy unread (F12: a failed request stops the batch before it) and read the honest one later
  for (const [name, n] of a.tampered) { const d = w.devs.get(name); if (d?.client && n > 0 && !d.everFaulty && d.client.model.alerts.length === 0) throw new Finding('undetected-tampering', `${name} was handed ${n} tampered envelope(s) and raised no alert`) }
  // the hub turns honest again: do the clients find their way back to the truth?
  a.active = false
  for (const d of w.devs.values()) if (d.client && !d.dead) { try { await d.client.catchUp() } catch {} }
  // a device that met gaps re-reads the room after its gap backoff (2 s doubling, at most 10 min): wait for the ones due soon
  const due = Date.now() + 20000
  while (Date.now() < due && [...w.devs.values()].some(d => d.client && !d.dead && (d.client._gapTimer || d.client._needResync || d.client._resyncing))) await sleep(100)
  try { await w.quiesce({ timeout_ms: 20000 }); await C.checkConvergence(R) }
  catch (e) {
    // H1 (fixed): the clients converge once the hub is honest, within the gap backoff. Only a backoff that grew past the
    // wait above during a long attack (by design, at most 10 min) is reported as known.
    if (![...w.devs.values()].some(d => d.client && (d.client._gapBackoff ?? 0) > 16000)) throw new Finding('H1', `after a hub that ${a.kind}s turned honest: ${e.message}`)
    w.known.set(`H1-no-recovery-after-${a.kind}`, `after a hub that ${a.kind}s turned honest again the clients did not converge within the 20 s wait (gap backoff past 16 s) (${String(e.message).split(String.fromCharCode(10))[0].slice(0, 160)}): skipped or reordered envelopes are never fetched again because the cursor moved on`) }
  await C.checkSafety(R, { deep: true })
  w.known.set(`hostile-counters-${a.kind}`, JSON.stringify(a.counters))
}

async function deep(w, R, { strict }) {
  const saved = [...w.devs.values()].map(d => [d, d.faults]); for (const [d] of saved) d.faults = { delay: 0, lose_response: 0, offline: 0 }
  for (const d of [...w.devs.values()]) if (d.dead && !d.removed && d.client === null && d.storage_base) { try { await w.boot(d) } catch (e) { if (/simulated:|process killed|fenced:/.test(e?.message ?? '')) { d.faults = { delay: 0, lose_response: 0, offline: 0 }; try { await w.boot(d) } catch (e2) { throw new Finding('exception', `restart of ${d.name} failed: ${e2.stack}`) } } else throw new Finding('exception', `restart of ${d.name} failed: ${e.stack}`) } }
  await w.quiesce({ timeout_ms: 30000 })
  try { await C.checkConvergence(R); await C.checkTimelines(R, { against: strict && !R.stopCompare }) } finally { for (const [d, f] of saved) d.faults = f }
  C.checkDerived(w)
  C.checkPlaintext(w)
}

// ---- CLI ---------------------------------------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).map(a => a.startsWith('--') ? a.slice(2).split('=') : []).filter(a => a.length).map(([k, v]) => [k, v ?? true]))
  const seed = args.seed ?? String(Date.now())
  const mode = args.mode ?? 'strict'
  let actions
  if (args.replay) actions = JSON.parse(fs.readFileSync(args.replay, 'utf8')).actions
  else actions = generate(seed, { steps: Number(args.steps ?? 150), rooms: Number(args.rooms ?? 1), mode, remote: !!args.hub })
  const res = await runActions(actions, { seed, mode, root: args.root, remote: args.hub && args.hub !== true ? args.hub : null, keepDir: !!args.keep })
  const counts = {}
  for (const t of res.trace) counts[t.o.split(':')[0]] = (counts[t.o.split(':')[0]] ?? 0) + 1
  console.log(JSON.stringify({ seed, mode, ok: res.ok, stats: res.stats, outcomes: counts }, null, 1))
  if (!res.ok) { console.log(`FINDING [${res.finding.kind}] at step ${res.finding.step}\n${res.finding.message}\naction: ${JSON.stringify(res.finding.action)}`); if (args.trace) for (const t of res.trace.slice(-15)) console.log(JSON.stringify(t)) }
  process.exit(res.ok ? 0 : 1)
}
