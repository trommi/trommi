// What must hold of the shell's files (app/shell/build.mjs):  node tests/shell/check.mjs OUT_DIR
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const out = process.argv[2]
if (!out) { console.error('usage: node tests/shell/check.mjs OUT_DIR'); process.exit(2) }
const failures = []
let checks = 0
const check = (ok, what) => { checks++; if (!ok) failures.push(what) }
const read = name => fs.readFileSync(path.join(out, name))
const has = name => fs.existsSync(path.join(out, name))

const html = read('index.html').toString()
check(!/<script(?![^>]*\bsrc=)/.test(html) && !/<style/.test(html) && !/\sstyle=/.test(html) && !/\son\w+=/.test(html), 'index.html has no inline script, style or handler (the policy forbids them)')
const script = /<script type="module" src="\/(gen\/app\/shell-[0-9a-f]{12}\.mjs)">/.exec(html)?.[1]
check(script && has(script), 'index.html names the page script, and it is there')
const app = fs.readdirSync(path.join(out, 'gen/app'))
const wasm = app.filter(f => /^trommi-core-[0-9a-f]{12}\.wasm$/.test(f))
const worker = app.filter(f => /^proof-worker-[0-9a-f]{12}\.mjs$/.test(f))
check(wasm.length === 1 && worker.length === 1, 'gen/app/ holds one core .wasm and one proof worker, named by their content')
if (script && wasm.length === 1 && worker.length === 1) {
  const bytes = read(`gen/app/${wasm[0]}`)
  check(bytes.equals(fs.readFileSync(path.join(REPO, 'core/wasm/pkg/trommi_core_wasm_bg.wasm'))), 'the .wasm is byte for byte what core/wasm/build.sh wrote')
  check(wasm[0] === `trommi-core-${crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12)}.wasm`, 'the .wasm is named by its SHA-256')
  const w = read(`gen/app/${worker[0]}`).toString()
  check(w.includes(`/gen/app/${wasm[0]}`) && w.includes(crypto.createHash('sha256').update(bytes).digest('base64')), 'the proof worker names the .wasm and its SHA-256')
  check(read(script).toString().includes(`/gen/app/${worker[0]}`), 'the page script names the proof worker')
}
check(read('_headers').equals(fs.readFileSync(path.join(REPO, 'app/web/public/_headers'))), "_headers is the app's own")
check(/^commit: [0-9a-f]{7}$/m.test(read('gen/build.txt').toString()), 'gen/build.txt names the commit')
check(has('sw.js') && read('sw.js').toString().includes('unregister'), 'sw.js removes an earlier service worker')
check(has('icons/trommi-192.png') && has('robots.txt'), 'the icon and robots.txt are there')

if (failures.length) { console.error(`shell: ${failures.length} of ${checks} checks FAILED\n${failures.map(f => `  not: ${f}`).join('\n')}`); process.exit(1) }
console.log(`shell: ${checks} checks passed`)
