// tabs-test.mjs: one room in several tabs of one Chromium profile (shared/tabs.ts), against the real hub in-process,
// with a Node agent that counts what arrives. Needs Chromium outside the command sandbox.
//   node shared/tabs-test.mjs
// Write in A (leader), in B (follower, forwarded), in A again: every message arrives once, no fork alert in any tab.
// Closing the leader hands over to the next tab. A follower's call whose answer never came (the leader sealed it, then
// closed) is answered by the new leader from the outbox, not sealed twice. A send racing the leader's close arrives once.
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startHub, LIMITS } from '../hub/server.mjs'
import { launchChromium } from '../dev/cdp.mjs'
import { joinRoom, memoryStorage } from './index.ts'
import { toJs } from '../dev/ts.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))
LIMITS.foundPerIpHour = 10_000

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'trommi-tabs-'))
const hub = await startHub({ port: 0, host: '127.0.0.1', dataDir: path.join(scratch, 'hub'), log: () => {} })
const web = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname))
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><title>tabs</title>') }
  if (p.endsWith('.ts')) { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(toJs(fs.readFileSync(p, 'utf8'), path.relative(ROOT, p))) }   // (types erased)
  res.writeHead(200, { 'content-type': p.endsWith('.mjs') || p.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' })
  fs.createReadStream(p).pipe(res)
})
await new Promise(r => web.listen(0, '127.0.0.1', r))
const ORIGIN = `http://127.0.0.1:${web.address().port}`
const PAGE = `${ORIGIN}/index.html`

const browser = await launchChromium({ width: 800, height: 600 })
let failed = 0
const out = (ok, name, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` ${extra}` : ''}`) }
const imp = `const core = await import('${ORIGIN}/shared/index.ts');`
const OPEN = `${imp}
  const st = () => core.idbStorage({ name: 'trommi-tabs', prefix: 'r/' })
  window.c = await core.openRoomInTabs({ storage: st(), makeStorage: st, client: 'tabs-test' })
  window.alertsSeen = []
  c.on('alert', a => alertsSeen.push(a.code))
  await c.start()
  return c.tabRole`

async function tab() {
  const t = await browser.tab(PAGE)
  await t.session.send('Runtime.enable')
  t.session.on('Runtime.consoleAPICalled', e => { if (e.type === 'error') console.log('[page]', e.args.map(a => a.value ?? a.description).join(' ')) })
  await sleep(400)
  t.run = async expr => {
    const r = await t.session.send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }
  return t
}
const waitFor = async (fn, ms = 15_000) => { for (let t = 0; t < ms; t += 50) { if (await fn()) return true; await sleep(50) } return false }

try {
  // A room founded in tab A, a Node agent in it, then A closes its founding client and opens the room the tabs way.
  const A = await tab()
  const founded = await A.run(`${imp}
    const storage = core.idbStorage({ name: 'trommi-tabs', prefix: 'r/' })
    const { client } = await core.foundRoom({ hub_url: '${hub.hubUrl}', storage, device_name: 'Browser' })
    await client.start()
    const inv = await client.createInvite({ device_role: 'agent' })
    window.founder = client
    return { link: inv.link }`)
  const joining = joinRoom({ link: founded.link, storage: memoryStorage(), device_name: 'agent', poll_ms: 50 })
  // every agent invite asks: the human compares the six emoji (here: the founder confirms the code the agent shows)
  const agentCode = await joining.check_code
  await A.run(`for (let k = 0; k < 400; k++) { const i = [...founder.model.invites.values()][0]; if (i?.invite_state === 'confirm_code') { await founder.confirmInvite(i.invite_id, i.check_code === '${agentCode}'); return true } await new Promise(r => setTimeout(r, 25)) } throw new Error('no code')`)
  const agent = await joining.client
  await agent.start()
  await agent.whenSession()
  const texts = []
  agent.on('command', c => { if (c.command === 'message') texts.push(c.content.text) })
  const AGENT = agent.my_device_id
  await A.run(`await founder.settle(); await founder.stop(); return true`)
  out(await A.run(OPEN) === 'leader', 'tab A opens the room as the leader (writer)')
  const B = await tab()
  out(await B.run(OPEN) === 'follower', 'tab B opens it as a follower, usable at once')
  const send = (t, text) => t.run(`await c.sendMessage({ agent_device_id: '${AGENT}', text: '${text}' }); return true`)
  const arrived = (list, ms) => waitFor(() => list.every(x => texts.includes(x)), ms)
  const once = list => list.every(x => texts.filter(y => y === x).length === 1)

  await send(A, 'a1'); await send(B, 'b1'); await send(A, 'a2'); await send(B, 'b2')
  out(await arrived(['a1', 'b1', 'a2', 'b2']) && once(['a1', 'b1', 'a2', 'b2']), 'A, B, A, B: every message arrives once', texts.join(' '))
  const seen = t => t.run(`const tl = c.model.timelines.get('chat:session/' + c.sessionOfAgent('${AGENT}'))
    return [...(tl?.items.values() ?? [])].map(i => i.content?.text).filter(Boolean)`)
  out(await waitFor(async () => (await seen(B)).length >= 4), 'the follower shows all four from its own stream', (await seen(B)).join(' '))
  const forks = t => t.run(`return alertsSeen.concat(c.model.alerts.map(a => a.code)).filter(x => /equivocation|fork|chain|voided/.test(x))`)
  out((await forks(A)).length === 0 && (await forks(B)).length === 0, 'no fork or chain alert in either tab', JSON.stringify([await forks(A), await forks(B)]))

  // Closing the leader: B takes over, sends itself.
  await A.close()
  out(await waitFor(() => B.run('return c.tabRole === "leader"')), 'closing the leader tab: B becomes the leader')
  await send(B, 'b3')
  out(await arrived(['b3']) && once(['b3']), 'B sends as the new leader: arrives once')

  // C follows B. B seals C's call but its answer never reaches C (dropped), then B closes: C, now leader, finds the
  // call in the outbox / acked list and answers it without sealing again.
  const C = await tab()
  out(await C.run(OPEN) === 'follower', 'tab C follows B')
  await B.run(`const post = BroadcastChannel.prototype.postMessage
    BroadcastChannel.prototype.postMessage = function (m) { if (m?.t === 'result') return; return post.call(this, m) }; return true`)
  await C.run(`window.p1 = c.sendMessage({ agent_device_id: '${AGENT}', text: 'c1' }).then(() => 'done', e => e.code); return true`)
  await arrived(['c1'])
  await sleep(300)
  await B.close()
  out(await waitFor(() => C.run('return c.tabRole === "leader"')), 'B closes: C becomes the leader')
  out(await C.run('return await p1') === 'done', 'C\'s call that B sealed (answer lost) resolves from the outbox')
  await sleep(1500)
  out(once(['c1']), 'and arrives once', texts.filter(x => x === 'c1').length + 'x')

  // D follows C; D sends while C closes at the same moment (mid-typing): the send arrives once.
  const D = await tab()
  out(await D.run(OPEN) === 'follower', 'tab D follows C')
  await D.run(`window.p2 = c.sendMessage({ agent_device_id: '${AGENT}', text: 'd1' }).then(() => 'done', e => e.code); return true`)
  await C.close()
  out(await waitFor(() => D.run('return c.tabRole === "leader"')), 'C closes mid-send: D becomes the leader')
  out(await D.run('return await p2') === 'done', 'D\'s send resolves')
  await arrived(['d1']); await sleep(1500)
  out(once(['d1']), 'and arrives once', texts.filter(x => x === 'd1').length + 'x')
  await send(D, 'd2')
  out(await arrived(['d2']) && once(['d2']), 'D goes on sending')
  out((await forks(D)).length === 0, 'no fork or chain alert after the handovers', JSON.stringify(await forks(D)))
  const all = ['a1', 'b1', 'a2', 'b2', 'b3', 'c1', 'd1', 'd2']
  out(texts.length === all.length && once(all), 'agent got exactly the eight messages', texts.join(' '))
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
