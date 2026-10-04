#!/usr/bin/env node
// A real E2E room for shooting the new app with real data: a hub (hub/server.mjs, port 8891-8899, throwaway data),
// the app founds the room in a kept Chromium profile, three channels (hub/channel.mjs, MCP stdio) join by agent
// invites as the sessions "test-alpha", "test-beta" and "courier", and file the fixture cards (server/fixtures.mjs),
// an approval request and status lines, the way the Turbo test board has them.
//   node dev/verify/app-room.mjs --verify-dir DIR [--app http://127.0.0.1:8900]
// Prints {"ready":true,...} and writes DIR/app-room.json ({ base, hub, userDataDir }); keeps hub and channels
// running until killed. Then: VERIFY_APP_MODE=room node dev/verify/shoot.mjs --target app --verify-dir DIR …
import fs from 'node:fs'
import path from 'node:path'
import { startHub, startChannel } from '../../hub/channel-test-e2e.mjs'
import { FIXTURES } from '../../server/fixtures.mjs'
import { arg, openPage, sleep, joinByCli } from './lib.mjs'

const dir = path.resolve(arg('verify-dir', '.'))
const APP = arg('app', 'http://127.0.0.1:8900')
const work = path.join(dir, 'app-room')
fs.rmSync(work, { recursive: true, force: true })
fs.mkdirSync(work, { recursive: true })
const userDataDir = path.join(work, 'chromium')
const hub = await startHub(work)
const h = await openPage({ profile: 'desktop-light', base: APP, userDataDir })
const until = async (js, what, ms = 20000) => { if (!await h.waitFor(`return Boolean(${js})`, ms)) throw new Error(`timed out: ${what}`) }
const channels = {}
try {
  await h.go(`/?hub=${encodeURIComponent(hub.hub_url)}`)
  await until(`document.querySelector('#found-form, #way-found')`, 'welcome')
  await h.ev(`document.querySelector('#way-found')?.click(); return 1`)
  await until(`document.querySelector('#found-form')`, 'found form')
  await h.ev(`document.querySelector('#found-form input[name=device_name]').value = 'Laptop'; document.querySelector('#found-form button[type=submit]').click(); return 1`)
  await until(`document.getElementById('recovery-code')`, 'recovery code')
  await h.ev(`document.querySelector('#recovery-form input[name=kept]').click(); document.querySelector('#recovery-form button').click(); return 1`)
  await until(`document.documentElement.hasAttribute('data-ready') && trommi.client.model.room.connection === 'live'`, 'room live')
  for (const name of ['test-alpha', 'test-beta', 'courier']) {
    await h.ev(`trommi.router.visit('/devices'); return 1`)
    await until(`document.querySelector('form[action="/pair"] input[value=agent]')`, 'devices')
    await h.ev(`document.querySelector('form[action="/pair"] input[value=agent]').form.requestSubmit(); return 1`)
    await until(`location.pathname.startsWith('/pair/') && document.querySelector('[data-state=open]')`, 'invite')
    const link = await h.ev(`return [...trommi.client.model.invites.values()].at(-1).link`)
    const folder = path.join(work, name)
    fs.mkdirSync(folder, { recursive: true })
    const chEnv = { TROMMI_KEYS_DIR: path.join(work, 'keys'), TROMMI_FOLDER: folder, TROMMI_HUB: hub.hub_url }
    await joinByCli({ root: path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..'), env: chEnv, cwd: folder, link })
    channels[name] = await startChannel({ env: chEnv, cwd: folder })
    await channels[name].ready()
  }
  const who = { alpha: channels['test-alpha'], beta: channels['test-beta'] }
  await who.alpha.call('introduce', { model: 'Claude Opus 5.5', task: 'UI-Testkarten: Entscheidungen', icon: 'flask' }).catch(() => {})
  await who.beta.call('introduce', { model: 'Claude Opus 5.5', task: 'UI-Testkarten: Inhalte und Gespräche', icon: 'bug' }).catch(() => {})
  const filed = {}
  for (const f of FIXTURES) {
    const out = await who[f.who].call(f.tool, f.args).catch(err => `ERR ${err.message}`)
    filed[f.kind] = out.slice(0, 120)
  }
  // the two published assets the Turbo fixture "artifact" puts into Test Beta's conversation
  const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..')
  for (const [p, title, note] of [[path.join(ROOT, 'demo', 'fixtures', 'artifact.html'), 'Testseite: Zähler', 'Eine Seite als Asset (verschlüsselt, mit Teilen).'], [path.join(ROOT, 'demo', 'design-g2.png'), 'Bild als Asset', 'Ein Bild als Asset.']]) {
    filed[`asset ${title}`] = (await who.beta.call('publish_asset', { path: p, title, note }).catch(err => `ERR ${err.message}`)).slice(0, 120)
  }
  await who.beta.call('set_status', { id: 'fixtures', label: 'Testkarten', state: 'done', detail: 'fertig' }).catch(() => {})
  const c = channels.courier
  await c.call('reply', { text: 'Ich bin **Courier**, die Sitzung des Prüfers. Gleich kommt eine Freigabe.' })
  await c.client.notification({ method: 'notifications/claude/channel/permission_request', params: { request_id: 'verify1', tool_name: 'Bash', description: 'Run the test suite', input_preview: '{"command":"npm test -- --coverage"}' } })
  await c.call('set_status', { id: 'verify', label: 'Prüfung', state: 'working', detail: 'Zustände werden fotografiert' })
  await sleep(3000)   // the app persists in batches
  const n = await h.ev(`return trommi.board.state.cards.length`)
  await h.close()
  const line = { ready: true, base: APP, hub: hub.hub_url, userDataDir, cards: n, filed }
  fs.writeFileSync(path.join(dir, 'app-room.json'), JSON.stringify(line, null, 1))
  console.log(JSON.stringify({ ...line, filed: undefined }))
  for (const [k, v] of Object.entries(filed)) if (v.startsWith('ERR')) console.error(`fixture ${k}: ${v}`)
} catch (err) {
  console.error(err.message)
  await h.shot(path.join(work, 'fail.png')).catch(() => {})
  await h.close(); hub.stop(); process.exit(1)
}
const end = async () => { for (const ch of Object.values(channels)) { try { await ch.close() } catch {} } hub.stop(); process.exit(0) }
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, end)
setInterval(() => {}, 1 << 30)
