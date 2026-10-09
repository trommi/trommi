// verify.mjs: is the app a server serves the build of this repository? Anyone can run it (README "Verifying the build").
//   git checkout <the commit app.trommi.com names in /gen/build.txt> && npm ci
//   node app/web/dev/verify.mjs [--app https://app.trommi.com]   (read only: it builds nothing on disk and changes nothing)
// 1. reads the server's gen/build.txt (commit, build hash) and gen/manifest.json (every file it serves, with its SHA-256)
//    and checks that the manifest is the one the build hash names;
// 2. builds this checkout as the deploy does (dev/build.mjs, nothing written) and compares its manifest file by file;
// 3. fetches every file the manifest names and checks that the server serves exactly those bytes.
// Exit 0: the served app is this source. Exit 1: what differs is printed.
import crypto from 'node:crypto'
import { guard } from './guard.mjs'
const args = guard({ usage: 'node dev/verify.mjs [--app URL]', values: ['app'] })   // (a public app is what it is for: no target check)

const APP = String(args.app ?? 'https://app.trommi.com').replace(/\/$/, '')
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')
const get = async (p, as = 'text') => {
  const r = await fetch(`${APP}/${p}`, { cache: 'no-store' })
  if (!r.ok) throw new Error(`${APP}/${p}: ${r.status}`)
  return as === 'bytes' ? Buffer.from(await r.arrayBuffer()) : r.text()
}
const problems = []

const buildTxt = await get('gen/build.txt')
const commit = /^commit: (\w+)$/m.exec(buildTxt)?.[1]
const buildHash = /^build: ([0-9a-f]{64})$/m.exec(buildTxt)?.[1]
if (!commit || !buildHash) { console.error(`${APP}/gen/build.txt names no commit or build hash:\n${buildTxt}`); process.exit(1) }
const manifestText = await get('gen/manifest.json')
if (sha256(manifestText) !== buildHash) problems.push(`the served manifest is not the one the build hash names (${sha256(manifestText).slice(0, 12)} vs ${buildHash.slice(0, 12)})`)
const served = JSON.parse(manifestText)
console.log(`${APP}: commit ${commit}, build ${buildHash.slice(0, 12)}, ${Object.keys(served.files).length} files`)

// the same build here: the commit as the deploy names it
process.env.WORKERS_CI_COMMIT_SHA ??= commit
const { generate } = await import('./build.mjs')
const { out } = await generate()
const local = JSON.parse(out['gen/manifest.json'])
for (const k of ['node', 'esbuild']) if (local.toolchain?.[k] !== served.toolchain?.[k]) problems.push(`built with ${k} ${served.toolchain?.[k] ?? '?'} there, ${local.toolchain?.[k] ?? '?'} here (pinned: .node-version, package-lock.json): run it with that`)
if (local.commit !== served.commit) problems.push(`this checkout builds commit ${local.commit}, the server names ${served.commit}: check out ${served.commit} first`)
for (const f of new Set([...Object.keys(local.files), ...Object.keys(served.files)])) {
  if (!(f in served.files)) problems.push(`${f}: built here, not served`)
  else if (!(f in local.files)) problems.push(`${f}: served, not built here`)
  else if (local.files[f] !== served.files[f]) problems.push(`${f}: served ${served.files[f].slice(0, 12)}, built here ${local.files[f].slice(0, 12)}`)
}

// what the server really hands out (index.html at /, the rest at its path)
let fetched = 0
for (const [f, hash] of Object.entries(served.files)) {
  if (f === '_headers') continue   // (the host's configuration, not a file it serves: compared above)
  try {
    const bytes = await get(f === 'index.html' ? '' : f, 'bytes')
    if (sha256(bytes) !== hash) problems.push(`${f}: the server sends other bytes than its manifest says`)
    fetched++
  } catch (e) { problems.push(`${f}: ${e.message}`) }
}

if (problems.length) { console.error(`NOT VERIFIED (${problems.length}):\n  ${problems.join('\n  ')}`); process.exit(1) }
console.log(`verified: ${fetched} files served are the build of commit ${commit} from this checkout`)
