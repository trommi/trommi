// catchup.browser.mjs: what a catch-up costs the app in a browser, and where the time goes. Away devices of one
// account (each its own Chromium profile, KEPT on the real disk, not in a RAM folder) are closed while another
// device writes a history of chat items; then each is opened again and takes the history: half of them in batches (the
// engine's `feed`), half item by item (one core call per item, as before `feed`). Measured per device: the wall time
// from opening the page to the room live at the hub's head, and the core worker's sums (app/web/core/spent.ts):
// core calls (with the store's writes inside them: values wrapped at rest, the strict IndexedDB transaction), the
// client's own work on what the engine tells it (model), the app's cache writes, the waits for the hub's pages.
//
//   node tests/web/e2e/catchup.browser.mjs                 (needs Chromium and the built core; one browser at a time)
//   TROMMI_CATCHUP=2000,10000   the history sizes (default); each size gets two fresh away devices
//   TROMMI_DISK_LOAD=1          a writer fills the profiles' disk with synced 4 MiB writes during the catch-ups
//   TROMMI_CATCHUP_DIR=<dir>    where the kept profiles live (default: ~/.cache/trommi-catchup; must be a disk)
// REAL: the built app, its core worker with the real binding, IndexedDB on disk, WebCrypto. NOT REAL: the hub is the
// FAKE hub (no cryptography, in this process), and the history is chat items of one agent: the Node stand-in
// (tests/web/stand-in/agent.ts on the real binding), let in through the app's own agent invite.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startFakeHub } from '../stand-in/hub.mjs'
import { hubReaders } from '../stand-in/core.ts'
import { AgentStandIn } from '../stand-in/agent.ts'
import { rooms, storage } from '../client/helpers.mjs'
import { buildApp, main, openProfile, run, serveApp, sleep, standInWorker, watch } from './harness.mjs'
import * as ui from './ui.mjs'

const SIZES = (process.env.TROMMI_CATCHUP || '2000,10000').split(',').map(Number).filter(n => n > 0)
const LOAD = process.env.TROMMI_DISK_LOAD === '1'
const DIR = process.env.TROMMI_CATCHUP_DIR || path.join(os.homedir(), '.cache', 'trommi-catchup')
const headOf = fake => [...fake.state.rooms.values()][0].change

export async function setUp() {
  fs.rmSync(DIR, { recursive: true, force: true })
  fs.mkdirSync(DIR, { recursive: true })
  const dir = await buildApp('catchup-dist')
  await standInWorker(dir)
  let hubUrl = null
  const app = await serveApp(dir, () => hubUrl)
  const hubAuth = bytes => { const a = hubReaders.hubAuth(bytes); return a.hub === app.origin ? { ...a, hub: hubUrl } : a }
  const fake = await startFakeHub({ readers: { ...hubReaders, hubAuth } })
  hubUrl = fake.url
  return { app, fake, seen: watch(), run: run(`catch-up cost${LOAD ? ' under disk load' : ''}`), open: [], email: `catchup+${Date.now().toString(36)}@example.org`, results: [], loader: null }
}
export async function tearDown(ctx) {
  ctx.loader?.kill('SIGKILL')
  await ctx.agent?.client.stop().catch(() => {})
  for (const p of ctx.open.splice(0)) await p.close().catch(() => {})
  await ctx.app.close().catch(() => {})
  await ctx.fake.close().catch(() => {})
  fs.rmSync(DIR, { recursive: true, force: true })
}
const profile = async (ctx, name) => { const p = await openProfile(name, ctx.seen, { keep: path.join(DIR, name) }); ctx.open.push(p); return p }
const close = async (ctx, p) => { ctx.open.splice(ctx.open.indexOf(p), 1); await p.close() }
const away = SIZES.flatMap(n => [`batched-${n}`, `single-${n}`])

/** The agent says things until the hub's head has grown by `n`. */
async function write(ctx, n) {
  const until = headOf(ctx.fake) + n, t = Date.now()
  for (let i = 0; headOf(ctx.fake) < until; i++) {
    await ctx.agent.say({ text: `said ${i} ${'x'.repeat(200)}` })
    if (i % 200 === 199) await ctx.agent.client.settle({ timeout_ms: 60000 })
  }
  await ctx.agent.client.settle({ timeout_ms: 60000 })
  return Date.now() - t
}
/** The items of the agent's session on a page's model. */
const said = page => page.js("return [...trommi.client.model.timelines.values()].reduce((n, t) => n + (t.item_count ?? 0), 0)")

/** Opens the away device `name` again and lets it take everything; returns its numbers. */
async function takeUp(ctx, name, single) {
  const p = await profile(ctx, name), page = p.page, head = headOf(ctx.fake)
  const t = Date.now()
  await page.session.send('Page.navigate', { url: ctx.app.start('/') })
  // (item by item: said to the core worker as soon as it is there, before its first page)
  if (single) for (let i = 0; i < 400 && !(await page.workers('globalThis.__trommiMeasure ? (globalThis.__trommiMeasure.itemByItem = true) : undefined')).length; i++) await sleep(10)
  await page.until(`window.trommi?.client?.model.room.last_envelope_number >= ${head} && window.trommi.client.model.room.connection === 'live'`, `${name} at the head`, 30 * 60_000)
  const wall = Date.now() - t
  const [spent] = await page.workers('globalThis.__trommiSpent ? JSON.parse(JSON.stringify(globalThis.__trommiSpent)) : undefined')
  const items = await said(page)
  await close(ctx, p)
  return { name, single, wall, spent, items }
}

const ms = v => `${Math.round(v)} ms`
const per = (v, n) => `${(v / n).toFixed(2)} ms/item`

export const steps = [
  ['the account, an agent stand-in in Node let in by the app\'s invite, and every away device logged in once, then closed', async ctx => {
    const w = await profile(ctx, 'writer'), A = w.page
    ctx.password = await ui.signUp(A, ctx.app.start('/'), ctx.email)
    await ui.takeKit(A)
    await ui.live(A)
    await A.click('#desk-invite-go')
    await A.until("location.pathname.startsWith('/pair/') && document.querySelector('[data-state=open] .clip-copy')", 'the agent invite page')
    const link = /'(http\S+\/join#v1\.[^']+)'/.exec(await A.js("return document.querySelector('[data-state=open] .clip-copy[data-line=connect] code').textContent"))?.[1]
    const R = await rooms({ agent: true })
    const joining = R.joinRoom({ link, storage: storage('agent'), poll_ms: 50, device_name: 'agent' })
    await joining.check_code
    await A.until("document.querySelector('[data-state=confirm_code] .clip-ask .check-yes')", 'the six emoji')
    await A.click('[data-state=confirm_code] .clip-ask .check-yes')
    const client = await joining.client
    ctx.agent = new AgentStandIn(client)
    await client.start()
    await client.settle()
    await A.until("document.querySelector('[data-state=joined]')", 'the agent is in', 20000)
    for (const name of away) {
      const p = await profile(ctx, name)
      await ui.logIn(p.page, ctx.app.start('/'), ctx.email, ctx.password)
      await ui.live(p.page, `${name} live`, 60000)
      await close(ctx, p)
    }
    await close(ctx, w)
  }],
  ...SIZES.map((n, i) => [`${n} changes: one away device takes them in batches, one item by item`, async ctx => {
    // (the history grows to n: what the earlier sizes wrote counts)
    const grow = n - (i ? SIZES[i - 1] : 0)
    const took = await write(ctx, grow)
    ctx.run.note(`the agent wrote ${grow} chat items in ${Math.round(took / 1000)} s; head ${headOf(ctx.fake)}`)
    if (LOAD && !ctx.loader) ctx.loader = spawn('sh', ['-c', `while :; do dd if=/dev/zero of="${DIR}/load" bs=4M count=64 oflag=dsync status=none; rm -f "${DIR}/load"; done`], { stdio: 'ignore' })
    for (const single of [false, true]) {
      const r = await takeUp(ctx, `${single ? 'single' : 'batched'}-${n}`, single)
      ctx.results.push({ n, ...r })
      const s = r.spent ?? {}
      ctx.run.check(r.items >= n, `${r.name}: every item of the session is there`, r.items)
      if (single) ctx.run.check(s.calls >= s.items * 0.9, `${r.name}: it did go item by item`, [s.calls, s.items])
      ctx.run.note(`${r.name}: ${ms(r.wall)} wall (${per(r.wall, s.items || n)}); items ${s.items}, core calls ${s.calls}, store writes ${s.writes}; core ${ms(s.core)} of which store ${ms(s.store)} (wrap ${ms(s.wrap)}, idb ${ms(s.idb)}); model ${ms(s.model)}; cache ${ms(s.cache)}; hub ${ms(s.hub)}`)
    }
  }]),
  ['nothing the pages complained about', async ctx => {
    ctx.loader?.kill('SIGKILL'); ctx.loader = null
    ctx.run.check(ctx.seen.exceptions.length === 0, 'no uncaught exception', ctx.seen.exceptions.slice(0, 5))
    fs.writeFileSync(path.join(os.tmpdir(), `trommi-catchup${LOAD ? '-load' : ''}.json`), JSON.stringify(ctx.results, null, 2))
  }],
]

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main('catchup', { setUp, steps, tearDown }, {})
