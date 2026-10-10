// Writes the tables of THIRD-PARTY.md from what cargo reports, or checks that they are current.
//
//   node .github/scripts/third_party.mjs           rewrites the tables in THIRD-PARTY.md
//   node .github/scripts/third_party.mjs --check   exit 1, with the difference, when the file is not what would be written
//
// What counts (the head of THIRD-PARTY.md says the same): every crate of Cargo.lock that is a dependency of a client
// library on a target it ships for. "Linked" is `cargo tree -e normal,no-proc-macro`; "only while building" is
// `cargo tree -e normal,build` without those. The licence is the one the crate declares (`cargo metadata`).
// Only the two tables and the binding generator's list are written; the prose around them is kept as it is.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const FILE = 'THIRD-PARTY.md'
const CLIENTS = [
  { label: 'web', pkg: 'trommi-core-wasm', targets: ['wasm32-unknown-unknown'] },
  { label: 'iOS', pkg: 'trommi-core-swift', targets: ['aarch64-apple-ios', 'aarch64-apple-ios-sim'] },
  { label: 'connector', pkg: 'trommi-core', targets: ['x86_64-unknown-linux-musl', 'aarch64-unknown-linux-musl', 'aarch64-apple-darwin', 'x86_64-apple-darwin'] },
]
const BINDGEN = 'trommi-uniffi-bindgen'

const cargo = args => execFileSync('cargo', args, { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'inherit'] })
const meta = JSON.parse(cargo(['metadata', '--format-version', '1', '--locked']))
const licence = new Map(), own = new Set()
for (const p of meta.packages) {
  licence.set(`${p.name} ${p.version}`, p.license ?? (p.license_file ? `see ${p.license_file}` : 'UNKNOWN'))
  if (p.source === null) own.add(`${p.name} ${p.version}`)
}
/** The crates of a tree, as "name version", without the workspace's own. */
function tree(pkg, target, edges) {
  const args = ['tree', '--locked', '-p', pkg, '-e', edges, '--prefix', 'none', '--format', '{p}']
  if (target) args.push('--target', target)
  const found = new Set()
  for (const line of cargo(args).split('\n')) {
    const m = line.match(/^(\S+) v(\S+)/)
    if (m && !own.has(`${m[1]} ${m[2]}`)) found.add(`${m[1]} ${m[2]}`)
  }
  return found
}

const linked = new Map(), building = new Set()   // crate → the clients it is linked into
for (const client of CLIENTS) {
  for (const target of client.targets) {
    const inside = tree(client.pkg, target, 'normal,no-proc-macro')
    for (const crate of inside) linked.set(crate, (linked.get(crate) ?? new Set()).add(client.label))
    for (const crate of tree(client.pkg, target, 'normal,build')) if (!inside.has(crate)) building.add(crate)
  }
}
for (const crate of linked.keys()) building.delete(crate)
const bindgen = [...tree(BINDGEN, null, 'normal,build')].filter(c => !linked.has(c) && !building.has(c))

const byName = (a, b) => { const [an, av] = a.split(' '), [bn, bv] = b.split(' '); return an < bn ? -1 : an > bn ? 1 : av.localeCompare(bv, 'en', { numeric: true }) }
const shown = crate => { const l = licence.get(crate) ?? 'UNKNOWN'; return /MPL/.test(l) ? `**${l}**` : l }
const where = set => set.size === CLIENTS.length ? 'all' : CLIENTS.filter(c => set.has(c.label)).map(c => c.label).join(', ')
const row = (crate, ...more) => `| ${crate.split(' ')[0]} | ${crate.split(' ')[1]} | ${[shown(crate), ...more].join(' | ')} |`

const tables = {
  '| Crate | Version | Licence | In |': [...linked.keys()].sort(byName).map(c => row(c, where(linked.get(c)))),
  '| Crate | Version | Licence |': [...building].sort(byName).map(c => row(c)),
}
const lines = readFileSync(FILE, 'utf8').split('\n'), out = []
const seen = new Set()
for (let i = 0; i < lines.length; i++) {
  const rows = tables[lines[i]]
  if (rows) {
    seen.add(lines[i])
    out.push(lines[i], lines[i + 1], ...rows)
    i += 2
    while (i < lines.length && lines[i].startsWith('|')) i++
    i--
  } else if (lines[i].startsWith('adds: ')) {
    seen.add('adds')
    out.push(`adds: ${bindgen.sort(byName).map(c => `${c} (${licence.get(c) ?? 'UNKNOWN'})`).join(', ')}.`)
    while (i + 1 < lines.length && lines[i + 1] !== '') i++
  } else out.push(lines[i])
}
if (seen.size !== 3) { console.error(`${FILE}: not all three generated places were found (${[...seen].join('; ')})`); process.exit(2) }
const text = out.join('\n')
if (process.argv.includes('--check')) {
  const now = readFileSync(FILE, 'utf8')
  if (now === text) { console.log(`${FILE} is current: ${linked.size} linked, ${building.size} only while building, ${bindgen.length} of the binding generator`); process.exit(0) }
  const a = new Set(now.split('\n')), b = new Set(out)
  for (const l of a) if (!b.has(l)) console.error(`- ${l.slice(0, 200)}`)
  for (const l of b) if (!a.has(l)) console.error(`+ ${l.slice(0, 200)}`)
  console.error(`\n${FILE} is not current: run node .github/scripts/third_party.mjs and commit the result`)
  process.exit(1)
}
writeFileSync(FILE, text)
console.log(`${FILE}: ${linked.size} linked, ${building.size} only while building, ${bindgen.length} of the binding generator`)
