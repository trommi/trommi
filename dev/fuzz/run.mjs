// run.mjs: the runner.
//   node dev/fuzz/run.mjs --workers 16 --minutes 120 --seed night1            hard run (rotating seeds, strict + chaos)
//   node dev/fuzz/run.mjs --quick                                              CI-sized (< 60 s): a few short seeds, local hub
//   node dev/fuzz/run.mjs --hub https://hub.trommi.com --workers 3 --minutes 60   against a deployed hub (throwaway rooms)
//   options: --mode strict|chaos  --steps N  --root DIR (code under test)  --lead FILE (also append findings there)
import { Worker } from 'node:worker_threads'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FUZZ_DIR } from './lib/env.mjs'

const args = {}
for (let i = 2; i < process.argv.length; i++) { const a = process.argv[i]; if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); args[k] = v ?? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true) } }
const quick = !!args.quick
const workers = Number(args.workers ?? (quick ? 4 : 8))
const minutes = Number(args.minutes ?? (quick ? 0.25 : 10))
const baseSeed = String(args.seed ?? `s${Date.now().toString(36)}`)
const until = Date.now() + minutes * 60000
const remote = args.hub && args.hub !== true ? args.hub : null
const findingsFile = path.join(FUZZ_DIR, 'FINDINGS.md')
const failuresDir = path.join(FUZZ_DIR, 'failures')
fs.mkdirSync(failuresDir, { recursive: true })
const seenFile = path.join(FUZZ_DIR, 'failures', '.seen.json')
let seen = []
try { seen = JSON.parse(fs.readFileSync(seenFile, 'utf8')) } catch {}

const totals = { seeds: 0, ok: 0, failed: 0, actions: 0, envelopes: 0, http: 0, ms: 0, crashes: 0, hubRestarts: 0 }
let targetCommit = '?'
const failures = new Map()
const known = new Map()
const running = new Map()
const t0 = Date.now()

function spawn(id) {
  const w = new Worker(path.join(FUZZ_DIR, 'worker.mjs'), { workerData: { id, baseSeed, mode: args.mode, root: args.root, remote, quick, until, steps: args.steps ? Number(args.steps) : null, seen, noshrink: !!args.noshrink } })
  running.set(id, { w, seed: null, since: Date.now() })
  w.on('message', onMessage)
  w.on('error', e => { console.error(`worker ${id} error: ${e.stack}`); respawn(id) })
  w.on('exit', () => { if (running.get(id)?.w === w) running.delete(id) })
}
function respawn(id) { running.delete(id); if (Date.now() < until) spawn(id) }

function onMessage(m) {
  const r = running.get(m.worker)
  if (m.type === 'start') { if (r) { r.seed = m.seed; r.since = Date.now() } }
  else if (m.type === 'done') {
    targetCommit = m.commit ?? targetCommit
    totals.seeds++; totals[m.ok ? 'ok' : 'failed']++
    totals.actions += m.stats.actions; totals.envelopes += m.stats.envelopes ?? 0; totals.http += m.stats.http; totals.ms += m.stats.ms; totals.crashes += m.stats.crashes; totals.hubRestarts += m.stats.hubRestarts
    for (const [k, v] of m.known ?? []) if (!known.has(k)) { known.set(k, { v, seed: m.seed }); noteKnown(k, v, m.seed) }
    if (r) r.seed = null
  } else if (m.type === 'failure') recordFailure(m)
  else if (m.type === 'crash') { console.error(`worker harness crash on ${m.seed}: ${m.error}`) }
}

function recordFailure(m) {
  if (m.repro === 0) m.sig = `FLAKY ${m.sig}`
  seen.push(m.sig); fs.writeFileSync(seenFile, JSON.stringify([...new Set(seen)]))
  for (const [, r] of running) r.w.postMessage({ type: 'seen', sig: m.sig })
  failures.set(m.sig, m)
  const file = path.join(failuresDir, `${m.seed.replace(/[^\w.-]/g, '_')}.json`)
  fs.writeFileSync(file, JSON.stringify({ seed: m.seed, commit: m.commit, mode: m.mode, sig: m.sig, finding: m.finding, actions: m.actions, shrunk: m.shrunk, trace: m.trace, remote, time: new Date().toISOString() }, null, 1))
  const md = [`\n## ${m.sig}`, `- target commit \`${m.commit}\`; seed: \`${m.seed}\`, mode ${m.mode}${remote ? `, hub ${remote}` : ''}; trace file: \`dev/fuzz/failures/${path.basename(file)}\` (replay: \`node dev/fuzz/model.mjs --replay=dev/fuzz/failures/${path.basename(file)} --mode=${m.mode}\`)`,
    `- found: ${new Date().toISOString()} (${m.shrunk?.runs ?? 0} shrink runs${m.shrunk?.flaky ? ', FLAKY: did not reproduce' : ''}, minimal trace reproduces ${m.repro ?? '?'}/3, minimal trace ${m.actions.length} actions)`,
    '- message:', '```', String(m.shrunk?.finding?.message ?? m.finding.message).slice(0, 1500), '```', '- minimal action list:', '```', ...m.actions.map(a => JSON.stringify(a)).slice(-40), '```'].join('\n')
  fs.appendFileSync(findingsFile, md + '\n')
  if (args.lead) fs.appendFileSync(args.lead, `\n### fuzz finding: ${m.sig}\nseed ${m.seed} (${m.mode}); details dev/fuzz/FINDINGS.md; trace dev/fuzz/failures/${path.basename(file)}\n${String(m.finding.message).slice(0, 600)}\n`)
  console.log(`FAILURE ${m.sig.slice(0, 200).replace(/\n/g, ' ')} (seed ${m.seed})`)
}
function noteKnown(k, v, seed) {
  const line = `- known \`${k}\` (first seen seed ${seed}): ${v}\n`
  fs.appendFileSync(path.join(FUZZ_DIR, 'failures', 'known.md'), line)
  if (args.lead) fs.appendFileSync(args.lead, `\n### fuzz known behaviour: ${k}\n${v} (seed ${seed})\n`)
}

for (let i = 0; i < workers; i++) spawn(i)
// against a deployed hub: watch the server itself (health latency, errors); a slow or failing server is a finding
const health = { n: 0, slow: 0, bad: 0, maxMs: 0, last: null }
if (remote) {
  const poll = async () => {
    const t = performance.now()
    try { const r = await fetch(`${remote}/healthz`, { signal: AbortSignal.timeout(15000) }); const ms = performance.now() - t; health.n++; health.maxMs = Math.max(health.maxMs, ms); health.last = await r.json().catch(() => null)
      if (!r.ok) { health.bad++; recordHealth(`healthz answered ${r.status}`) } else if (ms > 2000) { health.slow++; recordHealth(`healthz took ${ms.toFixed(0)} ms`) } }
    catch (e) { health.bad++; recordHealth(`healthz failed: ${e.message}`) }
  }
  const recordHealth = what => { const sig = `server-health: ${what.replace(/\d+ ms/, 'N ms')}`; if (!failures.has(sig)) recordFailure({ worker: -1, seed: `health-${Date.now()}`, mode: 'remote', sig, finding: { kind: 'server-health', message: `${what} (server ${remote}, commit ${health.last?.commit?.slice(0, 7) ?? '?'})`, step: null }, actions: [], trace: [] }) }
  setInterval(poll, 10000).unref(); poll()
}
const status = setInterval(() => {
  const s = (Date.now() - t0) / 1000
  console.log(`[${s.toFixed(0)}s] seeds ${totals.seeds} (ok ${totals.ok}, failed ${totals.failed}) actions ${totals.actions} (${(totals.actions / s).toFixed(0)}/s) envelopes ${totals.envelopes} http ${totals.http} crashes ${totals.crashes} hub-restarts ${totals.hubRestarts} distinct failures ${failures.size} known ${known.size}`)
  // a seed that runs far beyond its deadline is a hang
  for (const [id, r] of running) if (r.seed && Date.now() - r.since > (quick ? 30000 : 25 * 60000)) {
    console.log(`HANG on ${r.seed}: terminating worker ${id}`)
    recordFailure({ worker: id, seed: r.seed, mode: '?', sig: `hang: seed ${r.seed.replace(/-w\d+-\d+$/, '')}`, finding: { kind: 'hang', message: `worker stuck on seed ${r.seed} for ${((Date.now() - r.since) / 60000).toFixed(0)} min`, step: null }, actions: [], trace: [] })
    r.w.terminate(); respawn(id)
  }
  if (!running.size) finish()
}, quick ? 5000 : 30000)
let finished = false
function finish() {
  if (finished) return; finished = true
  clearInterval(status)
  const s = (Date.now() - t0) / 1000
  const summary = { targetCommit, baseSeed, remote, wallSeconds: Math.round(s), workers, ...totals, actionsPerSecond: Math.round(totals.actions / s), envelopesPerSecond: Math.round(totals.envelopes / s), httpPerSecond: Math.round(totals.http / s), distinctFailures: [...failures.keys()], known: [...known.keys()], ...(remote ? { health } : {}) }
  console.log('SUMMARY ' + JSON.stringify(summary))
  fs.appendFileSync(path.join(FUZZ_DIR, 'failures', 'runs.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...summary }) + '\n')
  let accepted = []
  try { accepted = JSON.parse(fs.readFileSync(path.join(FUZZ_DIR, 'known-open.json'), 'utf8')).map(x => new RegExp(x.pattern)) } catch {}
  const fresh = [...failures.keys()].filter(sig => !accepted.some(re => re.test(sig)))
  if (fresh.length) console.log(`NEW FAILURES (not in dev/fuzz/known-open.json):\n  ${fresh.join('\n  ')}`)
  process.exit(fresh.length && quick ? 1 : 0)
}
setTimeout(() => { setTimeout(finish, quick ? 20000 : 120000).unref(); }, Math.max(0, until - Date.now())).unref()
process.on('SIGINT', finish); process.on('SIGTERM', finish)
