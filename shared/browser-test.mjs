// browser-test.mjs: the SAME shared/ files in headless Chromium (IndexedDB storage, non-extractable keys),
// against the real hub in-process, with a Node agent on the other side. Needs Chromium outside the command sandbox.
//   node shared/browser-test.mjs [--n=2000]
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { startHub, LIMITS } from '../hub/server.mjs'
import { launchChromium } from '../dev/cdp.mjs'
import { joinRoom, memoryStorage } from './index.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const N = Number(process.argv.find(a => a.startsWith('--n='))?.slice(4) ?? 2000)
const sleep = ms => new Promise(r => setTimeout(r, ms))
LIMITS.foundPerIpHour = 10_000
LIMITS.envelopesPerSecond = 100_000; LIMITS.envelopeBurst = 100_000

async function freePort(skip = new Set()) {
  for (let p = 8891; p <= 8899; p++) {
    if (skip.has(p)) continue
    const ok = await new Promise(res => { const s = net.createServer().once('error', () => res(false)).listen(p, '127.0.0.1', () => s.close(() => res(true))) })
    if (ok) return p
  }
  return 0   // range full (other streams' hubs): let the OS pick
}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'trommi-core-browser-'))
const hubPort = await freePort()
const hub = await startHub({ port: hubPort, host: '127.0.0.1', dataDir: path.join(scratch, 'hub'), log: () => {} })
const types = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.html': 'text/html' }
const web = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname))
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><title>core</title>') }
  res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream' })
  fs.createReadStream(p).pipe(res)
})
const webPort = await freePort(new Set([hub.port]))
await new Promise(r => web.listen(webPort, '127.0.0.1', r))
const ORIGIN = `http://127.0.0.1:${web.address().port}`

const browser = await launchChromium({ width: 800, height: 600 })
let failed = 0
const out = (ok, name, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` ${extra}` : ''}`) }
try {
  const page = await browser.page()
  await page.send('Runtime.enable')
  page.on('Runtime.consoleAPICalled', e => { if (e.type === 'error') console.log('[page]', e.args.map(a => a.value ?? a.description).join(' ')) })
  await page.send('Page.enable')
  const nav = async () => { await page.send('Page.navigate', { url: `${ORIGIN}/index.html` }); await sleep(400) }
  const run = async expr => {
    const r = await page.send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }
  await nav()
  const imp = `const core = await import('${ORIGIN}/shared/index.mjs');`
  // 1. found in the browser
  const founded = await run(`${imp}
    const storage = core.idbStorage({ name: 'trommi-test', prefix: 'r1/' })
    const { client, recovery_code } = await core.foundRoom({ hub_url: '${hub.hubUrl}', storage, device_name: 'Browser' })
    await client.start()
    window.client = client
    const d = await storage.loadDevice()
    const inv = await client.createInvite({ device_role: 'agent' })
    return { room_id: client.model.room.room_id, extractable: d.signKey.extractable, link: inv.link, code: recovery_code.length }`)
  out(founded.extractable === false, 'browser founds a room; device key non-extractable in IndexedDB')
  // 2. a Node agent joins from the browser's invite
  const j = joinRoom({ link: founded.link, storage: memoryStorage(), device_name: 'Node agent', poll_ms: 50 })
  // every agent invite asks: the browser's human confirms the six emoji the agent shows
  const agentCode = await j.check_code
  await run(`for (let k = 0; k < 400; k++) { const i = [...client.model.invites.values()][0]; if (i?.invite_state === 'confirm_code') { await client.confirmInvite(i.invite_id, i.check_code === '${agentCode}'); return true } await new Promise(r => setTimeout(r, 25)) } throw new Error('no code')`)
  const agent = await j.client
  await agent.start()
  if (agent.whenSession) await agent.whenSession()
  const id = await agent.sendCard({ title: 'From Node', options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] })
  await agent.settle()
  const commands = []
  agent.on('command', c => commands.push(c))
  const seen = await run(`
    for (let i = 0; i < 200 && !client.model.cards.has('${id}'); i++) await new Promise(r => setTimeout(r, 20))
    const c = client.model.cards.get('${id}')
    await client.answer({ object_id: '${id}', choices: ['b'] })
    await client.settle()
    return { title: c?.title, members: client.model.members.size }`)
  out(seen.title === 'From Node' && seen.members === 2, 'browser decrypts the Node agent\'s card live')
  for (let i = 0; i < 200 && !commands.length; i++) await sleep(20)
  out(commands[0]?.command === 'answer' && commands[0].choices[0] === 'b', 'Node agent gets the browser\'s signed answer')

  // 3. catch-up of N envelopes in the browser, main-thread blocking measured with long tasks
  await run(`await client.stop(); return true`)
  for (let i = 0; i < N; i++) {
    if (i % 10 === 0) agent.setStatus({ [`status_line/s${i % 30}`]: { label: `s${i}`, state: 'working' } })
    else agent.sendMessage({ text: `message ${i}` })
  }
  await agent.settle({ timeout_ms: 300_000 })
  const perf = await run(`
    const longTasks = []
    new PerformanceObserver(l => { for (const e of l.getEntries()) longTasks.push(e.duration) }).observe({ type: 'longtask', buffered: false })
    client.stats.verified = 0; client.stats.verify_ms = 0
    const t0 = performance.now()
    await client.catchUp()
    const ms = performance.now() - t0
    await client.flush()
    await new Promise(r => setTimeout(r, 50))
    return { ms, verified: client.stats.verified, processing: client.stats.verify_ms, longest: Math.max(0, ...longTasks), long: longTasks.length }`)
  out(perf.verified >= N, `browser catch-up of ${perf.verified} envelopes`, `${perf.ms.toFixed(0)} ms incl. HTTP = ${(perf.verified / perf.ms * 1000).toFixed(0)}/s; long tasks ${perf.long}, longest ${perf.longest.toFixed(0)} ms`)
  out(perf.longest < 200, 'no long task over 200 ms during catch-up')

  // 4. warm start: reload the page, open from IndexedDB, delta only
  await agent.sendMessage({ text: 'while away' })
  await agent.settle()
  await nav()
  const warm = await run(`${imp}
    const t0 = performance.now()
    const client = await core.openRoom({ storage: core.idbStorage({ name: 'trommi-test', prefix: 'r1/' }) })
    const openMs = performance.now() - t0
    const cursor = client.model.room.last_envelope_number
    const card = client.model.cards.get('${id}')?.object_state
    client.stats.verified = 0
    const t1 = performance.now()
    await client.start()
    const startMs = performance.now() - t1
    window.client = client
    const key = 'chat:session/' + '${agent.session_id ?? agent.my_device_id}'
    const t2 = performance.now()
    const page = await client.loadTimeline(key, { limit: 50 })
    const pageMs = performance.now() - t2
    const items = [...client.model.timelines.get(key).items.values()].sort((a, b) => a.envelope_number - b.envelope_number)
    const second = await core.openRoom({ storage: core.idbStorage({ name: 'trommi-test', prefix: 'r1/' }) })
    const conflict = await second.start().then(() => 'started', e => e.code)
    await client.stop()
    return { openMs, startMs, pageMs, cursor, card, delta: client.stats.verified, last: items.at(-1)?.content?.text, loaded: page.loaded, conflict }`)
  out(warm.conflict === 'tab-conflict', 'a second tab on the same room is refused (Web Lock)')
  out(warm.card === 'answered' && warm.delta <= 2 && warm.cursor > N, 'warm start from IndexedDB: model and cursor restored, only the delta verified', `open ${warm.openMs.toFixed(0)} ms, start ${warm.startMs.toFixed(0)} ms, delta ${warm.delta}`)
  out(warm.last === 'while away' && warm.loaded === 50, 'newest timeline page fetched and decrypted on open', `${warm.pageMs.toFixed(0)} ms for 50`)
  await agent.stop()
} catch (e) { failed++; console.log('FAIL', e.stack) }
finally {
  await browser.close()
  await hub.close()
  web.close()
  fs.rmSync(scratch, { recursive: true, force: true })
}
console.log(failed ? `${failed} failed` : 'all ok')
process.exit(failed ? 1 : 0)
