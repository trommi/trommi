// test-e2e.mjs: the connector against a real local hub.   node connector/test-e2e.mjs
//
// Each part starts its own hub (hub/server.mjs on a free port 8891-8899, throwaway data dir), a scripted human device
// from shared/, and connector.mjs as a real MCP stdio child:
//   integration   join via agent invite, introduce, decision round trips, hand back, explain, decide again, shred,
//                 info read, permission round trip, sessions, say, loss watch, forged commands rejected, restart
//   updates       hot reload of tools.mjs + prompt.md, the hub's recommended version, a changed shell file
//   hooks         the plugin's permission hook: the human's verdict on the board is the hook's decision
//   monitor       a session without channel events: the monitor's pointer line, the inbox tool
//   second machine  the connect script (app/web/public/connect.sh) run as a person runs it,
//                     curl -fsSL <app>/connect | sh -s '<invite link>'
//                 in a fresh HOME and project folder against the files connector/build.mjs makes; then the installed
//                 single-file connector is started as Claude Code starts it and must be in the room.
//
//   node connector/test-e2e.mjs [--only connect] [--shell sh|dash|bash] [--docker IMAGE] [--real-claude] [--answer y] [--no-plugin]
//
// The flags are the second machine's. The script installs the Trommi plugin (claude plugin marketplace add + install
// --scope local) and starts plain `claude`; --no-plugin: a Claude Code without plugin support, the script falls back
// to .mcp.json + the channel flag. With --real-claude, TROMMI_MARKETPLACE may name a local marketplace directory (an
// https archive cannot be loopback). Without Node (--docker debian:stable-slim --answer y, as root): the script offers
// to install Node 22 (NodeSource) and goes on after the yes; --answer n: it stops with the hint. --docker runs the
// script inside a container (host network): node:26-slim has dash as /bin/sh, node:26-alpine busybox ash. Without
// --real-claude a stub `claude` on PATH stands in for Claude Code's `mcp add/remove` and `plugin` (it writes
// .mcp.json the same way), so the test needs no Claude Code login.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { spawn, execFile, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileStorage } from '../shared/storage-file.mjs'
import { knock, socketPath } from './connector.mjs'
import { INSTRUCTIONS, DESCRIPTIONS } from './tools.mjs'
import { connectorFiles } from './build.mjs'
import { assetPath } from '../app/web/worker.js'

const here = path.dirname(new URL(import.meta.url).pathname)
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(what, fn, ms = 15000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(40)
  }
}
const freePort = async () => {
  for (let p = 8891; p <= 8899; p++) {
    const ok = await new Promise(res => { const s = net.createServer().once('error', () => res(false)).listen(p, '127.0.0.1', () => s.close(() => res(true))) })
    if (ok) return p
  }
  // All taken (other suites run at the same time): a port the system hands out.
  return new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)) }) })
}

export async function startHub(tmp, extraEnv = {}) {
  const port = await freePort()
  const data = fs.mkdtempSync(path.join(tmp, 'hub-'))
  const hub_url = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, [path.join(here, '../hub/server.mjs')], {
    env: { ...process.env, HUB_PORT: String(port), PORT: String(port), HUB_HOST: '127.0.0.1', HUB_DATA: data, DATA_DIR: data, HUB_URL: hub_url, HUB_DB: path.join(data, 'hub.db'), ...extraEnv },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let err = ''
  child.stderr.on('data', d => { err += d })
  await until('the hub', async () => { try { return (await fetch(`${hub_url}/healthz`)).ok } catch { return false } }).catch(e => { throw new Error(`${e.message}: ${err.slice(-500)}`) })
  return { hub_url, stop: () => child.kill(), stderr: () => err }
}

/** connector.mjs as Claude Code starts it; collects every notification. */
// Every connector the tests start is its own Claude Code session (TROMMI_SESSION_KEY), although all share this process
// as parent; session: null leaves the default (the parent pid), as a Claude Code session has it.
export async function startConnector({ env, cwd, script = path.join(here, 'connector.mjs'), session = `test-${Math.random().toString(36).slice(2)}` }) {
  const events = [], said = []
  const { TROMMI_SESSION_KEY: _, ...base } = process.env
  const transport = new StdioClientTransport({ command: process.execPath, args: [script], env: { ...base, ...(session ? { TROMMI_SESSION_KEY: session } : {}), ...env }, cwd, stderr: 'pipe' })
  let err = ''
  const client = new Client({ name: 'connector-test', version: '1' }, { capabilities: {} })
  client.fallbackNotificationHandler = async n => { events.push(n) }
  await client.connect(transport)
  const handle = { exited: false }
  transport.onclose = () => { handle.exited = true }
  transport.stderr?.on('data', d => { err += d })
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args })
    const text = r.content?.[0]?.text ?? ''
    said.push(text)
    if (r.isError) throw Object.assign(new Error(text), { tool_error: true })
    return text
  }
  const ready = () => until('the connector to be in the room', async () => { try { await call('list_cards'); return true } catch { return false } }, 20000)
  const next = (pred, what = 'a channel event') => until(what, () => events.find(e => !e.seen && pred(e)) && Object.assign(events.find(e => !e.seen && pred(e)), { seen: true }))
  return Object.assign(handle, { pid: transport.pid, client, events, said, call, ready, next, stderr: () => err, close: () => client.close() })
}

export async function integration({ test, tmp }) {
  const core = await import('../shared/index.mjs')
  // A stand-in push service: the hub's loss watch pushes here (HUB_PUSH_HOSTS), after HUB_LOSS_MS.
  const pushed = []
  const pushService = http.createServer((req, res) => { const parts = []; req.on('data', c => parts.push(c)); req.on('end', () => { pushed.push(Buffer.concat(parts)); res.writeHead(201).end() }) })
  await new Promise(r => pushService.listen(0, '127.0.0.1', r))
  const pushHost = `127.0.0.1:${pushService.address().port}`
  const hub = await startHub(tmp, { HUB_PUSH_HOSTS: pushHost, HUB_LOSS_MS: '1500' })
  const keys = path.join(tmp, 'keys')
  const project = path.join(tmp, 'project')
  fs.mkdirSync(project, { recursive: true })
  const env = { TROMMI_KEYS_DIR: keys, TROMMI_FOLDER: project, TROMMI_HUB: hub.hub_url }
  let human, agent, agentId, connector
  const chEvent = (kind, id) => e => e.method === 'notifications/claude/channel' && e.params.meta?.kind === kind && (!id || e.params.meta.card_id === id)
  try {
    await test('e2e: human founds a room, invites an agent; the connector joins by TROMMI_INVITE', async () => {
      ;({ client: human } = await core.foundRoom({ hub_url: hub.hub_url, device_name: '', storage: core.memoryStorage() }))
      await human.start()
      const invite = await human.createInvite({ device_role: 'agent', app_url: 'https://app.trommi.com/join' })
      connector = await startConnector({ env: { ...env, TROMMI_INVITE: invite.link }, cwd: project })
      await connector.ready()
      agentId = [...human.model.members.values()].find(m => m.device_role === 'agent')?.device_id
      assert.ok(agentId, 'the human sees the agent in the member list')
      const keyFile = fs.readdirSync(path.join(keys, human.model.room.room_id)).find(f => f.endsWith('.key'))
      assert.equal((fs.statSync(path.join(keys, human.model.room.room_id, keyFile)).mode & 0o777).toString(8), '600')
    })

    await test('e2e: introduce + set_status reach the human as registers; device label is encrypted', async () => {
      await connector.call('introduce', { model: 'Claude Opus 5.5', task: 'night test', icon: 'database' })
      await connector.call('set_status', { id: 'tests', label: 'Tests', state: 'working', detail: 'running' })
      await until('profile', () => human.model.sessions.get(human.sessionOfAgent(agentId))?.profile?.model === 'Claude Opus 5.5')
      // The sidebar name is the folder's name; host and full folder travel beside it (all encrypted).
      const label = await until('device label', () => human.model.members.get(agentId)?.device_name && human.model.members.get(agentId))
      assert.equal(label.device_name, 'project')
      assert.match(label.folder, /project$/)
      assert.ok(label.host)
      await until('status line', () => human.model.sessions.get(human.sessionOfAgent(agentId))?.status_lines?.find(l => l.id === 'tests'))
    })

    await test('e2e: own sends are visible at once: set_status names a card filed a moment earlier', async () => {
      const id = (await connector.call('create_decision', { title: 'Right away?', options: [{ key: 'y', label: 'Yes' }, { key: 'n', label: 'No' }] })).match(/card ([0-9a-f]{32}) created, position \d+ of \d+/)?.[1]
      assert.ok(id, 'create_decision reports the place in the stack')
      assert.equal(await connector.call('set_status', { id: 'wait', label: 'Waiting', state: 'decision', card_id: id }), 'status "wait" is decision')
      assert.ok(JSON.parse(await connector.call('list_cards')).some(c => c.id === id))
      await connector.call('withdraw_card', { card_id: id, reason: 'test' })
      assert.equal(JSON.parse(await connector.call('list_cards')).find(c => c.id === id).status, 'done')
      await connector.call('clear_status', { id: 'wait' })
    })

    let card
    await test('e2e: create_decision -> human answers -> decision event', async () => {
      const out = await connector.call('create_decision', { title: 'Run it tonight?', body: 'Locks orders 40 s.', options: [{ key: 'tonight', label: 'Tonight' }, { key: 'now', label: 'Now' }], recommended: 'tonight' })
      card = out.match(/card ([0-9a-f]{32})/)[1]
      await until('the card at the human', () => human.model.cards.get(card)?.title === 'Run it tonight?')
      await human.answer({ object_id: card, choices: ['now'], note: 'go' })
      const ev = await connector.next(chEvent('decision', card))
      assert.equal(ev.params.meta.choice, 'now')
      assert.equal(ev.params.content, 'go')
    })

    await test('e2e: decide again -> decision_reopened; hand back -> revise; explain -> reply presents', async () => {
      await human.decideAgain({ object_id: card })
      const re = await connector.next(chEvent('decision_reopened', card))
      assert.equal(re.params.meta.previous_choice, 'now')
      await until('card open at the connector', async () => JSON.parse(await connector.call('list_cards')).find(c => c.id === card)?.status === 'open')
      await human.sendMessage({ agent_device_id: agentId, object_id: card, text: 'clearer please', hand_back: true })
      const hb = await connector.next(chEvent('chat', card))
      assert.equal(hb.params.meta.handback, '1')
      await until('in revision', async () => JSON.parse(await connector.call('list_cards')).find(c => c.id === card)?.with_agent)
      await connector.call('revise_card', { card_id: card, title: 'Run the migration tonight at 2?', note: 'clearer' })
      await until('version 2 at the human', () => human.model.cards.get(card)?.object_version === 2 && !human.model.cards.get(card)?.in_revision)
      await human.sendMessage({ agent_device_id: agentId, object_id: card, text: 'explain', explain: true })
      assert.equal((await connector.next(chEvent('chat', card))).params.meta.explain, '1')
      await until('explain seen', async () => JSON.parse(await connector.call('list_cards')).find(c => c.id === card)?.with_agent)
      await connector.call('reply', { card_id: card, text: 'It means 40 s of lock at 2 am.' })
      await until('presented again', () => !human.model.cards.get(card)?.in_revision)
      await human.answer({ object_id: card, choices: ['tonight'] })
      assert.equal((await connector.next(chEvent('decision', card))).params.meta.choice, 'tonight')
      await connector.call('close_card', { card_id: card, summary: 'ran' })
    })

    await test('e2e: shred and info read', async () => {
      const q = (await connector.call('create_decision', { title: 'Which font?', options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] })).match(/card ([0-9a-f]{32})/)[1]
      await until('q', () => human.model.cards.get(q))
      await human.shred({ object_id: q, note: 'later' })
      assert.match((await connector.next(chEvent('shredded', q))).params.content, /Their note: later/)
      const i = (await connector.call('create_info', { title: 'How it works', body: 'Like this.' })).match(/info ([0-9a-f]{32})/)[1]
      await until('i', () => human.model.cards.get(i))
      await human.markRead({ object_id: i })
      await connector.next(chEvent('info_read', i))
    })

    await test('e2e: chat with an attachment arrives as a decrypted file', async () => {
      const ref = await human.uploadAttachment(new TextEncoder().encode('hello file'), { file_name: 'note.txt', media_type: 'text/plain' })
      await human.sendMessage({ agent_device_id: agentId, text: 'see file', attachments: [ref] })
      const ev = await connector.next(chEvent('chat'))
      assert.equal(fs.readFileSync(ev.params.meta.files, 'utf8'), 'hello file')
      await connector.call('reply', { text: 'got it' })
    })

    await test('e2e: publish_asset puts a published object on the board and announces it in the conversation', async () => {
      const id = (await connector.call('publish_asset', { content: '<h1>Report</h1>', title: 'Report', note: 'for you' })).match(/published as ([0-9a-f]{32})/)[1]
      await until('published object', () => human.model.published.get(id)?.title === 'Report')
      const timeline = `chat:session/${human.sessionOfAgent(agentId)}`
      const said = await until('announcement', () => [...(human.model.timelines.get(timeline)?.items.values() ?? [])].find(i => i.content?.published_object_id === id))
      assert.equal(said.content.text, '**Report**\n\nfor you')
      const bytes = await human.fetchAttachment(said.content.attachments[0])
      assert.equal(new TextDecoder().decode(bytes), '<h1>Report</h1>')
    })

    await test('e2e: share_asset gives outsiders a link; release: false and revoke_asset end it', async () => {
      const id = (await connector.call('publish_asset', { content: '<h1>For outsiders</h1>', title: 'Outside' })).match(/published as ([0-9a-f]{32})/)[1]
      const link = (await connector.call('share_asset', { id, expires_hours: 1 })).match(/Link for the recipient: (\S+)/)[1]
      // What the viewer page does, with nothing but the link: no sign-in, no membership.
      const viewer = new core.Hub({ hub_url: hub.hub_url })
      const open = l => core.openShared(viewer, l)
      assert.equal(new TextDecoder().decode(await open(link)), '<h1>For outsiders</h1>')
      const { share_secret } = core.parseShareLink(link)
      await assert.rejects(open(link.replace(share_secret, core.z.b64u(new Uint8Array(32)))))
      assert.match(await connector.call('share_asset', { id, release: false }), /release taken back/)
      await assert.rejects(open(link))
      const again = (await connector.call('share_asset', { id })).match(/Link for the recipient: (\S+)/)[1]
      assert.ok(await open(again))
      await connector.call('revoke_asset', { id })
      await assert.rejects(open(again))
      await until('unpublished', () => human.model.published.get(id)?.object_state === 'closed')
    })

    await test('e2e: permission round trip', async () => {
      await connector.client.notification({ method: 'notifications/claude/channel/permission_request', params: { request_id: 'req1', tool_name: 'Bash', description: 'Run shell command', input_preview: '{"command":"ls"}' } })
      const pid = await until('permission at the human', () => [...human.model.permissions.values()].find(p => p.tool_name === 'Bash')?.object_id)
      await human.verdict({ object_id: pid, allow: true })
      const v = await connector.next(e => e.method === 'notifications/claude/channel/permission')
      assert.deepEqual({ ...v.params }, { request_id: 'req1', behavior: 'allow' })
    })

    await test('e2e: a second session in the same folder does not share the key: it needs its own invite and is a second member', async () => {
      const second = await startConnector({ env, cwd: project })
      try {
        await until('needs its own invite', async () => { try { await second.call('list_cards'); return false } catch (e) { return /invite of its own/.test(e.message) } })
        // Joining is the human's act: the model has no join tool, the human runs the CLI in the folder (review 2).
        assert.ok(!(await second.client.listTools()).tools.some(t => t.name === 'join'), 'a model-callable join tool exists')
        assert.match((await second.call('list_cards').catch(e => e.message)), /connector\.mjs join '<link>'/)
        await second.close()
        const invite = await human.createInvite({ device_role: 'agent', app_url: 'https://app.trommi.com/join' })
        const { execFile } = await import('node:child_process')
        const out = await new Promise((res, rej) => execFile(process.execPath, [path.join(here, 'connector.mjs'), 'join', invite.link], { env: { ...process.env, ...env }, cwd: project }, (e, so, se) => (e ? rej(new Error(`${e.message}\n${se}`)) : res(so))))
        assert.match(out, /joined room/)
        await until('two agents', () => [...human.model.members.values()].filter(m => m.device_role === 'agent' && m.is_active).length === 2)
        const room = path.join(keys, human.model.room.room_id)
        assert.deepEqual(fs.readdirSync(room).filter(f => f.endsWith('.key')).map(f => f.replace(/^.*-(\d+)\.key$/, '$1')).sort(), ['1', '2'])
        const again = await startConnector({ env, cwd: project })
        await again.ready().finally(() => again.close())
      } finally { await second.close().catch(() => {}) }
    })

    await test('e2e: reconnect (/mcp -> Reconnect): the new connector of the same session takes the key over, the old one exits', async () => {
      await connector.close()
      const old = await startConnector({ env, cwd: project, session: null })   // both have this process as parent
      await old.ready()
      const t0 = Date.now()
      const next = await startConnector({ env, cwd: project, session: null })   // the old one keeps running, stdin open
      try {
        await until('the new one in the room', async () => { try { await next.call('list_cards'); return true } catch { return false } }, 15000)
        assert.ok(Date.now() - t0 < 10000, `took ${Date.now() - t0} ms`)
        await until('the old one gone', () => old.exited, 5000)
        const room = path.join(keys, human.model.room.room_id)
        assert.deepEqual(fs.readdirSync(room).filter(f => /-1\.lock\.\d+$/.test(f)).map(f => Number(f.split('.').pop())), [next.pid], 'slot 1 is held by the new process')
        assert.match(next.stderr(), /slot 1 taken over/)
        connector = next
      } catch (e) { await next.close().catch(() => {}); throw new Error(`${e.message}\nnew: ${next.stderr().slice(-800)}\nold: ${old.stderr().slice(-800)}`) } finally { await old.close().catch(() => {}) }
    })

    await test('e2e: a session left without a key (the key was busy) takes it on the next tool call once it is free; the error names the pid and the fix', async () => {
      const second = await startConnector({ env, cwd: project })   // the second member (slot 2) runs too
      await second.ready()
      const keyless = await startConnector({ env: { ...env, TROMMI_RETRY_MS: '600000' }, cwd: project })   // another session: no take-over
      try {
        const err = await until('busy', async () => { try { await keyless.call('list_cards'); return false } catch (e) { return /is held by/.test(e.message) && e.message } })
        assert.match(err, new RegExp(`pid ${connector.pid}`))
        assert.match(err, new RegExp(`kill ${connector.pid}`))
        await connector.close()
        await until('the key taken on a tool call', async () => { try { await keyless.call('list_cards'); return true } catch { return false } }, 15000)
      } catch (e) { await keyless.close().catch(() => {}); throw e } finally { await second.close().catch(() => {}) }
      connector = keyless
    })

    const say = (args, extra = {}) => new Promise(res => execFile(process.execPath, [path.join(here, 'connector.mjs'), 'say', ...args], { env: { ...process.env, ...env, TROMMI_SAY_MS: '20000', ...extra }, cwd: project }, (e, so, se) => res({ code: e?.code ?? 0, out: so, err: se })))
    const inMain = async text => {
      const sid = human.sessionOfAgent(agentId)
      await until(`"${text}" at the human`, async () => {
        await human.loadTimeline(`chat:session/${sid}`).catch(() => {})
        return [...(human.model.timelines.get(`chat:session/${sid}`)?.items.values() ?? [])].some(i => i.content?.text === text)
      })
    }
    await test('e2e: say (the side channel) goes through the running connector, on its chain; --urgent files a critical info card', async () => {
      const r = await say(['hello', 'by say'])
      assert.equal(r.code, 0, r.err)
      assert.match(r.out, new RegExp(`through the running connector \\(pid ${connector.pid}\\)`))
      await inMain('hello by say')
      const u = await say(['Trommi tools fail here', '--urgent'])
      assert.equal(u.code, 0, u.err)
      const card = await until('the urgent card', () => [...human.model.cards.values()].find(c => c.title === 'Trommi tools fail here'))
      assert.equal(card.urgency, 'critical')
      assert.match(await connector.call('reply', { text: 'and the connector goes on' }), /./)
      await inMain('and the connector goes on')
      assert.ok(!human.model.alerts?.some?.(a => /chain|fork/.test(a.code)), 'no chain alert at the human')
    })

    await test('e2e: say with no connector running opens the free key itself, once; the connector started afterwards goes on on the same chain', async () => {
      await connector.close()
      await until('the slot free', () => connector.exited, 5000)
      const r = await say(['nobody runs'])
      assert.equal(r.code, 0, r.err)
      assert.match(r.out, /said as this folder's agent \(slot 1\)/)
      await inMain('nobody runs')
      assert.deepEqual(fs.readdirSync(path.join(keys, human.model.room.room_id)).filter(f => /\.lock\.\d+$/.test(f)), [], 'say gave the slot back')
      connector = await startConnector({ env, cwd: project })
      await connector.ready()
      await connector.call('reply', { text: 'after say, same chain' })
      await inMain('after say, same chain')
      assert.equal(human.model.room.outbox_blocked ?? null, null)
    })

    await test('e2e: loss watch: a connector with running work that drops away is pushed to the human once; the app says since when; a clean end pushes nothing', async () => {
      const browser = crypto.createECDH('prime256v1'), browserPub = browser.generateKeys(), auth = crypto.randomBytes(16)
      await human.hub.pushSubscription({ endpoint: `http://${pushHost}/push/phone`, keys: { p256dh: browserPub.toString('base64url'), auth: auth.toString('base64url') } })
      const open = b => {
        const salt = b.subarray(0, 16), idlen = b[20], senderPub = b.subarray(21, 21 + idlen), ct = b.subarray(21 + idlen)
        const hk = (s, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, s, info, len))
        const ikm = hk(auth, browser.computeSecret(senderPub), Buffer.concat([Buffer.from('WebPush: info\0'), browserPub, senderPub]), 32)
        const d = crypto.createDecipheriv('aes-128-gcm', hk(salt, ikm, 'Content-Encoding: aes128gcm\0', 16), hk(salt, ikm, 'Content-Encoding: nonce\0', 12))
        d.setAuthTag(ct.subarray(ct.length - 16))
        const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()])
        return JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString())
      }
      const before = pushed.length
      await connector.call('set_status', { id: 'build', label: 'Build', state: 'working' })
      await sleep(400)
      process.kill(connector.pid, 'SIGKILL')   // a crash: no goodbye
      const msg = open(await until('the loss push', () => pushed.length > before && pushed.at(-1), 8000))
      assert.equal(msg.kind, 'agent-lost', JSON.stringify(msg))
      assert.equal(msg.device_id, agentId, 'device')
      assert.equal(msg.room_id, human.model.room.room_id, 'room')
      await sleep(2500)
      assert.equal(pushed.length, before + 1, 'once')
      await human._refreshDevices()
      const since = human.model.members.get(agentId).offline_since
      assert.ok(since > Date.now() - 30000, 'the hub says since when')

      const { BoardState } = await import('../app/web/public/app.mjs')
      const { blockedOf } = await import('../app/web/public/app.mjs')
      const st = new BoardState(human).update(), a = st.agents.find(x => x.session_id === human.sessionOfAgent(agentId))
      assert.equal(a.offline_since, since, 'board state offline_since')
      const stop = blockedOf(a, st, Date.now() + 61000)   // (the module counts from its own load too)
      assert.equal(stop?.why, 'offline')
      assert.match(stop.text, /^Connection lost since (\d+ \w+ )?\d\d:\d\d$/)
      // A clean end (Claude Code closes the connector) disarms first: no push.
      connector = await startConnector({ env, cwd: project })
      await connector.ready()
      await connector.call('set_status', { id: 'build', label: 'Build', state: 'working' })
      await sleep(400)
      await connector.close()
      await sleep(2500)
      assert.equal(pushed.length, before + 1, 'no push for a clean end')
      connector = await startConnector({ env, cwd: project })
      await connector.ready()
      await connector.call('clear_status', { id: 'build' })
    })

    let child
    await test('e2e: child session: open_session and session on tools; the human sees it under the main; answers come back with meta session', async () => {
      const main = human.sessionOfAgent(agentId)
      assert.match(await connector.call('open_session', { name: 'Design', task: 'pictures', icon: 'brush' }), /child session opened: "Design"/)
      await connector.call('reply', { text: 'hello from Design', session: 'Design' })
      await connector.call('set_status', { id: 'draw', label: 'Drawing', state: 'working', session: 'Design' })
      const out = await connector.call('create_decision', { title: 'Which colour?', options: [{ key: 'r', label: 'Red' }, { key: 'b', label: 'Blue' }], session: 'Design' })
      const id = out.match(/card ([0-9a-f]{32})/)[1]
      // a second helper opened by its first use
      await connector.call('reply', { text: 'Server here', session: 'Server' })
      child = await until('the child at the human', () => [...human.model.sessions.values()].find(s => s.profile?.agent_name === 'Design')?.session_id)
      assert.notEqual(child, main)
      assert.equal(human.model.sessions.get(child).profile.parent_session, main, 'parent = the main session')
      assert.equal(human.model.sessions.get(child).profile.task, 'pictures')
      assert.deepEqual(human.model.sessions.get(child).agent_device_ids, [agentId])
      await until('the status line in the child', () => human.model.sessions.get(child).status_lines?.find(l => l.id === 'draw'))
      assert.ok(!human.model.sessions.get(main).status_lines?.find(l => l.id === 'draw'), 'not in the main session')
      await until('the card in the child', () => human.model.cards.get(id)?.session_id === child)
      await until('the second child', () => [...human.model.sessions.values()].find(s => s.profile?.agent_name === 'Server' && s.profile.parent_session === main))
      assert.equal(human.sessionOfAgent(agentId), main, 'the human still writes to the main session by default')
      await human.answer({ object_id: id, choices: ['b'] })
      const ev = await connector.next(chEvent('decision', id))
      assert.equal(ev.params.meta.session, 'Design')
      await human.sendMessage({ agent_device_id: agentId, session_id: child, text: 'for Design' })
      const chat = await connector.next(e => e.method === 'notifications/claude/channel' && e.params.content === 'for Design')
      assert.equal(chat.params.meta.session, 'Design')
      const listed = JSON.parse(await connector.call('list_cards', { session: 'Design' }))
      assert.deepEqual(listed.map(c => [c.id, c.session]), [[id, 'Design']])
    })

    await test('e2e: restart reuses the identity, no new member entry, catches up', async () => {
      const entries = human.model.room.last_entry_number
      const agents = [...human.model.members.values()].filter(m => m.device_role === 'agent').length
      await connector.close()
      await human.sendMessage({ agent_device_id: agentId, text: 'while you were away' })
      connector = await startConnector({ env, cwd: project })
      await connector.ready().catch(e => { throw new Error(`${e.message}\n${connector.stderr()}`) })
      const ev = await connector.next(chEvent('chat')).catch(e => { throw new Error(`${e.message}\n${connector.stderr()}\n${JSON.stringify(connector.events)}`) })
      assert.equal(ev.params.content, 'while you were away')
      assert.equal(human.model.room.last_entry_number, entries)
      assert.equal([...human.model.members.values()].filter(m => m.device_role === 'agent').length, agents)
      assert.match(connector.stderr(), new RegExp(`as ${agentId.slice(0, 12)}`))
    })

    await test('e2e: the child session survives a restart of the connector: same session, no new one', async () => {
      const before = [...human.model.sessions.values()].filter(s => s.profile?.agent_name === 'Design').length
      assert.match(await connector.call('open_session', { name: 'Design' }), /already open/)
      await connector.call('reply', { text: 'Design after the restart', session: 'design' })
      await until('the message in the same child', async () => {
        await human.loadTimeline(`chat:session/${child}`).catch(() => {})
        return [...(human.model.timelines.get(`chat:session/${child}`)?.items.values() ?? [])].some(i => i.content?.text === 'Design after the restart')
      })
      assert.equal([...human.model.sessions.values()].filter(s => s.profile?.agent_name === 'Design').length, before)
    })

    await test('e2e: after a restart, answers in the main session and in a child session arrive as decision events within 2 s', async () => {
      const ask = async session => (await connector.call('create_decision', { title: `Go ${session ?? 'main'}?`, options: [{ key: 'y', label: 'Yes' }, { key: 'n', label: 'No' }], ...(session ? { session } : {}) })).match(/card ([0-9a-f]{32})/)[1]
      const inMain = await ask(null), inChild = await ask('Design')
      await until('both cards at the human', () => human.model.cards.get(inMain) && human.model.cards.get(inChild)?.session_id === child)
      for (const [id, session] of [[inMain, undefined], [inChild, 'Design']]) {
        const t0 = Date.now()
        await human.answer({ object_id: id, choices: ['y'] })
        const ev = await until(`the decision on ${id}`, () => connector.events.find(e => !e.seen && chEvent('decision', id)(e)), 2000)
        ev.seen = true
        assert.ok(Date.now() - t0 <= 2000, `arrived after ${Date.now() - t0} ms`)
        assert.equal(ev.params.meta.choice, 'y')
        assert.equal(ev.params.meta.session, session)
      }
    })

    await test('e2e: a Claude Code session started without the channels flag drops events: they come with the next tool result instead', async () => {
      const { channelsHeard } = await import('./connector.mjs')
      assert.equal(channelsHeard({ env: {}, args: ['claude', '--resume', 'abc'] }), false)
      assert.equal(channelsHeard({ env: {}, args: ['claude', '--resume', 'abc', '--dangerously-load-development-channels', 'server:trommi'] }), true)
      assert.equal(channelsHeard({ env: {}, args: ['node', '/x/@anthropic-ai/claude-code/cli.js', '--channels=server:trommi'] }), true)
      assert.equal(channelsHeard({ env: {}, args: ['node', 'some-other-client.mjs'] }), true, 'not Claude Code: assumed to listen')
      const id = (await connector.call('create_decision', { title: 'Deaf?', options: [{ key: 'y', label: 'Yes' }, { key: 'n', label: 'No' }] })).match(/card ([0-9a-f]{32})/)[1]
      await until('the card at the human', () => human.model.cards.get(id))
      await connector.close()
      connector = await startConnector({ env: { ...env, TROMMI_CHANNEL_EVENTS: 'off' }, cwd: project })
      await connector.ready()
      await human.answer({ object_id: id, choices: ['n'], note: 'no thanks' })
      await connector.next(chEvent('decision', id))
      const said = await connector.call('list_cards')
      assert.match(said, /started without --dangerously-load-development-channels server:trommi/)
      assert.match(said, new RegExp(`<channel source="board" kind="decision" card_id="${id}" choice="n">\\nno thanks\\n</channel>`))
      assert.doesNotMatch(await connector.call('list_cards'), /<channel /, 'each event once')
      await connector.close()
      connector = await startConnector({ env, cwd: project })
      await connector.ready()
      assert.doesNotMatch(await connector.call('list_cards'), /<channel |dangerously/, 'a listening session gets plain results')
    })

    await test('e2e: close_session archives a finished helper (lines cleared, readable in the archive); a quiet helper is idle, not stopped; open_session reopens', async () => {

      const { BoardState } = await import('../app/web/public/app.mjs')
      const { blockedOf, quietOf, QUIET_MS } = await import('../app/web/public/app.mjs')
      const board = new BoardState(human)
      const design = () => board.update().agents.find(a => a.session_id === child)
      await connector.call('set_status', { id: 'draw', label: 'Drawing', state: 'working', session: 'Design' })
      await until('the working line', () => human.model.sessions.get(child).status_lines?.find(l => l.id === 'draw' && l.state === 'working'))
      // The stopped-child bug: the helper said nothing for 46 min but its main agent is online and talking.
      const st = board.update(), a = st.agents.find(x => x.session_id === child)
      assert.ok(a.parent, 'Design is a child')
      const now = Date.now() + QUIET_MS + 60000
      assert.equal(blockedOf({ ...a, online: true, active: now - 46 * 60000, connected: now - 46 * 60000, device_active: now - 60000 }, { ...st, tasks: st.tasks.map(t => ({ ...t, updated: now - 46 * 60000 })) }, now), null)
      assert.equal(blockedOf({ ...a, online: true, active: now - 46 * 60000, connected: now - 46 * 60000, device_active: now - 46 * 60000 }, { ...st, tasks: st.tasks.map(t => ({ ...t, updated: now - 46 * 60000 })) }, now), null, 'the whole agent quiet while working: no stop')
      assert.match(quietOf({ ...a, online: true, active: now - 46 * 60000, connected: now - 46 * 60000, device_active: now - 46 * 60000 }, { ...st, tasks: st.tasks.map(t => ({ ...t, updated: now - 46 * 60000 })) }, now)?.text, /^quiet for 46 min$/, 'only a grey hint')
      assert.equal(quietOf({ ...a, online: true, active: now - 46 * 60000, connected: now - 46 * 60000, device_active: now - 60000 }, { ...st, tasks: st.tasks.map(t => ({ ...t, updated: now - 46 * 60000 })) }, now), null, 'a talking main agent: not quiet')
      assert.equal(blockedOf({ ...a, online: true, active: 0, connected: 0, device_active: 0 }, { ...st, tasks: [] }, now), null, 'no working line: idle')
      // An open question keeps a closed helper in the active list.
      const q = (await connector.call('create_decision', { title: 'Still open?', options: [{ key: 'y', label: 'Yes' }, { key: 'n', label: 'No' }], session: 'Design' })).match(/card ([0-9a-f]{32})/)[1]
      await until('the open card', () => human.model.cards.get(q)?.object_state === 'open')
      assert.match(await connector.call('close_session', { name: 'design', summary: 'Pictures done: out/landing/' }), /closed: archived.*1 open question/)
      await until('closed', () => human.model.sessions.get(child).profile?.closed_at)
      assert.deepEqual(human.model.sessions.get(child).status_lines ?? [], [], 'its lines are cleared')
      assert.equal(design().archived, false, 'open question: still active')
      await connector.call('withdraw_card', { card_id: q, reason: 'test' })
      await until('archived on the board', () => design()?.archived === true)
      await until('the summary in the child', async () => {
        await human.loadTimeline(`chat:session/${child}`).catch(() => {})
        return [...(human.model.timelines.get(`chat:session/${child}`)?.items.values() ?? [])].some(i => i.content?.text === 'Pictures done: out/landing/')
      })
      assert.equal(blockedOf(design(), board.update()), null)
      await assert.rejects(connector.call('close_session', { name: 'Nobody' }), /no child session "Nobody"/)
      assert.match(await connector.call('open_session', { name: 'Design' }), /already open/)
      await until('reopened', () => !human.model.sessions.get(child).profile?.closed_at && design()?.archived === false)
    })

    await test('e2e: a renamed project folder keeps its identity (slot name kept in .trommi/slot-base)', async () => {
      const entries = human.model.room.last_entry_number
      assert.match(fs.readFileSync(path.join(project, '.trommi', 'slot-base'), 'utf8'), /project/)
      await connector.close()
      const moved = `${project}-renamed`
      fs.renameSync(project, moved)
      try {
        connector = await startConnector({ env: { ...env, TROMMI_FOLDER: moved }, cwd: moved })
        await connector.ready().catch(e => { throw new Error(`${e.message}\n${connector.stderr()}`) })
        assert.match(connector.stderr(), new RegExp(`as ${agentId.slice(0, 12)}`))
        assert.equal(human.model.room.last_entry_number, entries, 'no new member entry')
        await connector.close()
      } finally { fs.renameSync(moved, project) }
      connector = await startConnector({ env, cwd: project })
      await connector.ready()
    })

    await test('e2e: forged commands are dropped and reported as alert/<n>', async () => {
      const how = await forge({ core, human, agentId, connector, until, keys }); console.error('forgeries:', JSON.stringify(how))
    })

    // R6 handover: a crashed session is replaced by a new agent in another folder; the human decides whether it
    // may read the earlier conversation. What the new agent can open is read back from its own key slot.
    let session_id
    const seenHeirs = new Set()
    const handover = async (folder, with_history) => {
      session_id ??= human.sessionOfAgent(agentId)
      const old = [...human.model.cards.values()].find(c => c.session_id === session_id && c.title)
      const dir = path.join(tmp, folder)
      fs.mkdirSync(dir, { recursive: true })
      const invite = await human.createInvite({ device_role: 'agent', session_id, with_history })
      const next = await startConnector({ env: { ...env, TROMMI_FOLDER: dir, TROMMI_INVITE: invite.link }, cwd: dir })
      await next.ready().catch(e => { throw new Error(`${e.message}\n${next.stderr()}`) })
      const heir = await until('the grant', () => human.model.sessions.get(session_id)?.agent_device_ids?.find(id => human.model.members.get(id)?.is_active && id !== agentId && !seenHeirs.has(id)))
      seenHeirs.add(heir)
      await human.sendMessage({ agent_device_id: heir, text: `after the handover (${folder})` })
      const ev = await next.next(chEvent('chat'))
      assert.equal(ev.params.content, `after the handover (${folder})`)
      await next.close()
      const room = path.join(keys, human.model.room.room_id)
      const base = fs.readdirSync(room).find(f => f.includes(path.basename(dir)) && f.endsWith('.key'))
      const storage = await fileStorage({ dir: room, key_file: path.join(room, base), prefix: base.replace(/key$/, '') })
      const peek = await core.openRoom({ storage })
      return { old, card: peek.model.cards.get(old.object_id) }
    }
    await test('e2e: handover with history: the new agent reads the earlier conversation', async () => {
      const { old, card } = await handover('heir-with', true)
      assert.equal(card?.title, old.title)
    })
    await test('e2e: handover without history: the new agent reads from now on, not before', async () => {
      const { card } = await handover('heir-without', false)
      assert.ok(!card?.title, 'the earlier card was readable without history')
    })

    await test('e2e: lease-lost: another process takes over the key; the connector exits without posting', async () => {
      const room = path.join(keys, human.model.room.room_id)
      const slot = fs.readdirSync(room).find(f => /-1\.key$/.test(f) && !f.includes('heir'))
      const prefix = slot.replace(/key$/, '')
      // The other process: the same key, its own copy of the state (as a second Claude would have after a copy of the folder).
      const twin = fs.mkdtempSync(path.join(tmp, 'twin-'))
      fs.copyFileSync(path.join(room, `${prefix}state.json`), path.join(twin, `${prefix}state.json`))
      const before = human.chains.get(core.z.b64u(core.z.unhex(agentId)))?.seq
      assert.ok(before > 0, 'the human knows the agent\'s chain')
      const other = await core.openRoom({ storage: await fileStorage({ dir: twin, key_file: path.join(room, slot), prefix }) })
      await other.start({ stream: false })
      await other.claimSession({ process_instance: 'twin' })
      const exited = await until('the connector to exit', () => connector.exited ? true : false, 15000).catch(() => false)
      await other.stop()
      assert.ok(exited, `the connector kept running after losing the lease\n${connector.stderr().slice(-400)}`)
      assert.match(connector.stderr(), /another process took over this key/)
      await new Promise(r => setTimeout(r, 300))
      const after = human.chains.get(core.z.b64u(core.z.unhex(agentId)))?.seq
      assert.equal(after, before, 'the connector posted after losing the lease')
      assert.deepEqual(fs.readdirSync(room).filter(f => f.startsWith(`${prefix}lock.`)), [], 'the claim of the slot is left behind')
    })
  } finally {
    try { await connector?.close() } catch {}
    try { human?.stop() } catch {}
    hub.stop()
    pushService.close()
  }
}

/**
 * Connector updates, in a joined room: a changed code file is hot-reloaded on reload_connector (same process, lease and
 * stream: the human's answer to a card filed by the new code arrives), the hub's recommended version and a changed shell
 * file ask for a restart, and the update is hinted once on the next tool result.
 */
export async function updates({ test, tmp }) {
  const core = await import('../shared/index.mjs')
  const hub = await startHub(tmp, { HUB_RECOMMENDED_CONNECTOR: '9.0.0' })
  // A copy of connector/ and shared/ beside node_modules, so the test can change files without touching the repository.
  const repo = path.join(tmp, 'update-repo')
  for (const d of ['connector', 'shared']) fs.cpSync(path.join(here, '..', d), path.join(repo, d), { recursive: true })
  fs.symlinkSync(path.join(here, '../node_modules'), path.join(repo, 'node_modules'))
  const project = path.join(tmp, 'update-project')
  fs.mkdirSync(project, { recursive: true })
  const update = e => e.method === 'notifications/claude/channel' && e.params.meta?.kind === 'update'
  let human, ch
  try {
    ;({ client: human } = await core.foundRoom({ hub_url: hub.hub_url, device_name: '', storage: core.memoryStorage() }))
    await human.start()
    const invite = await human.createInvite({ device_role: 'agent', app_url: 'https://app.trommi.com/join' })
    const env = { TROMMI_KEYS_DIR: path.join(tmp, 'update-keys'), TROMMI_FOLDER: project, TROMMI_HUB: hub.hub_url, TROMMI_INVITE: invite.link, TROMMI_UPDATE_POLL_MS: '300', TROMMI_VERSION_CHECK_MS: '400' }
    ch = await startConnector({ env, cwd: project, script: path.join(repo, 'connector/connector.mjs') })
    await ch.ready()
    const agents = () => [...human.model.members.values()].filter(m => m.device_role === 'agent').map(m => m.device_id)
    const agentId = agents()[0]

    await test('update: the hub recommends a newer connector: announced once with restart_required, hinted once on the next tool result', async () => {
      const ev = await ch.next(e => update(e) && e.params.meta.version === '9.0.0', 'the hub update event')
      assert.equal(ev.params.meta.restart_required, '1')
      assert.match(ev.params.content, /Neue Connector-Version 9\.0\.0 – jetzt neu laden\?/)
      await ch.call('list_cards'); await ch.call('list_cards')
      await sleep(1000)
      const hinted = ch.said.filter(t => /\[Trommi: a new connector version 9\.0\.0 is available\. It needs a real restart/.test(t))
      assert.equal(hinted.length, 1, 'hinted once on a tool result')
      assert.equal(ch.events.filter(e => update(e) && e.params.meta.version === '9.0.0').length, 1, 'the same hub version announced twice')
    })

    await test('update: changed tool files are announced, and reload_connector loads it without a restart (tool list changed)', async () => {
      const before = (await ch.client.listTools()).tools
      assert.ok(before.some(t => t.name === 'reload_connector'))
      // A new tool name in the schema, in the bridge and in prompt.md (its section and new words): one version.
      const file = path.join(repo, 'connector/tools.mjs'), prompt = path.join(repo, 'connector/prompt.md')
      fs.writeFileSync(prompt, fs.readFileSync(prompt, 'utf8').replace('## list_cards\n\n', '## list_cards_v2\n\nReworded in prompt.md. '))
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace("case 'list_cards': {", "case 'list_cards_v2': {").replace("name: 'list_cards',", "name: 'list_cards_v2',"))
      const ev = await ch.next(update, 'the update event')
      assert.equal(ev.params.meta.update_available, '1')
      assert.equal(ev.params.meta.restart_required, '0')
      assert.match(ev.params.content, /Neue Connector-Version .* jetzt neu laden\?/)
      assert.match(await ch.call('reload_connector'), /^Reloaded: connector version/)
      await ch.next(e => e.method === 'notifications/tools/list_changed', 'tools/list_changed')
      const listed = (await ch.client.listTools()).tools, after = listed.map(t => t.name)
      assert.match(listed.find(t => t.name === 'list_cards_v2').description, /^Reworded in prompt\.md\. List all your cards/, 'prompt.md was read again')
      assert.ok(after.includes('list_cards_v2') && !after.includes('list_cards'), after.join(','))
      assert.ok(after.includes('reload_connector'))
      assert.match(await ch.call('reload_connector'), /is current/)
    })

    await test('update: the reload keeps process, lease and stream: same member, a card of the new code is answered live', async () => {
      assert.equal(ch.exited, false)
      assert.match(await ch.call('list_cards_v2'), /^\[/)
      const out = await ch.call('create_decision', { title: 'After the reload?', options: [{ key: 'y', label: 'Yes' }, { key: 'n', label: 'No' }] })
      const card = out.match(/card ([0-9a-f]{32})/)[1]
      await until('the card at the human', () => human.model.cards.get(card)?.title === 'After the reload?')
      await human.answer({ object_id: card, choices: ['y'] })
      const ev = await ch.next(e => e.method === 'notifications/claude/channel' && e.params.meta?.kind === 'decision' && e.params.meta.card_id === card, 'the decision after the reload')
      assert.equal(ev.params.meta.choice, 'y')
      assert.deepEqual(agents(), [agentId], 'the reload made a new member')
      assert.equal(ch.stderr().match(/\] in room /g)?.length, 1, 'the room was opened again')
      assert.doesNotMatch(ch.stderr(), /lease|another process/)
    })

    await test('update: a changed core file (shell) is announced with restart_required and reload_connector asks for /mcp Reconnect', async () => {
      fs.appendFileSync(path.join(repo, 'shared/transport.mjs'), '\n// changed by the update test\n')
      const ev = await ch.next(e => update(e) && e.params.meta.restart_required === '1', 'the restart event')
      assert.match(ev.params.content, /\/mcp/)
      assert.match(await ch.call('reload_connector'), /\/mcp, then trommi, then Reconnect/)
      assert.match(await ch.call('list_cards_v2'), /^\[/, 'the old code keeps running until the restart')
    })
  } finally {
    try { await ch?.close() } catch {}
    try { human?.stop() } catch {}
    hub.stop()
  }
}

// ---- forged commands (integration) ---------------------------------------------------------------------------
// Each forgery is sealed with the core's own sealing (Client._send, a test-only use of an internal), so the
// envelope is well-formed and signed; only its authority or its bind is wrong. Expected: the connector emits
// nothing to Claude Code and reports alert/... on the board, or the hub already refuses it.
async function forge({ core, human, agentId, connector, until, keys }) {
  const { z, codec } = core
  const quiet = async ms => { const before = connector.events.length; await new Promise(r => setTimeout(r, ms)); return connector.events.slice(before) }
  const alerts = () => human.model.sessions.get(human.sessionOfAgent(agentId))?.agent_alerts ?? []
  const card = (await connector.call('create_decision', { title: 'Forge target?', options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] })).match(/card ([0-9a-f]{32})/)[1]
  await until('card at the human', () => human.model.cards.get(card))
  const answerOf = (c, versionHash, choice = 'a') => ({
    kind: codec.KIND.answer, content: { answer_action: 'answer', choices: [choice] }, recipient: agentId,
    bind: z.encodeAnswerBind({ objectId: z.unhex(card), versionHash: z.unhex(versionHash), choices: [choice] }), session_id: c.session_id,
    object: { object_id: card, object_state: 'answered', urgency: c.urgency, answered_at: Date.now() },
  })

  // 1. An answer with a stale hash: the human answers version 1 after the agent revised to version 2.
  const v1 = human.model.cards.get(card).version_hash
  await connector.call('revise_card', { card_id: card, title: 'Forge target, reworded?' })
  await until('version 2 at the human', () => human.model.cards.get(card).object_version === 2)
  const n1 = alerts().length
  await human._send(answerOf(human.model.cards.get(card), v1))
  await until('alert for the stale answer', () => alerts().length > n1)
  assert.ok(!(await quiet(300)).some(e => e.params?.meta?.kind === 'decision'), 'a stale answer reached Claude')

  // 2. An answer from an agent (the second agent of this folder, slot 2): only humans may answer.
  const room = path.join(keys, human.model.room.room_id)
  const slot2 = fs.readdirSync(room).find(f => /-2\.key$/.test(f))
  assert.ok(slot2, 'the second agent key exists')
  const storage = await fileStorage({ dir: room, key_file: path.join(room, slot2), prefix: slot2.replace(/key$/, '') })
  const other = await core.openRoom({ storage })
  await other.start({ stream: false })

  // R6: agent B cannot read agent A's session. It holds no key for it: A's cards stay undecryptable for B,
  // and B cannot even seal under A's session key.
  const sessionA = human.model.cards.get(card).session_id
  assert.notEqual(other.session_id, sessionA, 'the second agent has a session of its own')
  const seenByB = other.model.cards.get(card)
  assert.ok(!seenByB || (seenByB.content_state === 'undecryptable' && !seenByB.title), 'agent B read a card of agent A\'s session')
  await assert.rejects(other._send(answerOf(human.model.cards.get(card), human.model.cards.get(card).version_hash)), e => e.code === 'no-key')

  // So the forged answer goes under B's own session key, addressed to A: A cannot open it, and only humans may answer anyway.
  const n2 = alerts().length
  let hubRefused = null
  await other._send({ ...answerOf(human.model.cards.get(card), human.model.cards.get(card).version_hash), session_id: other.session_id }).catch(e => { hubRefused = e })
  await other.settle?.().catch(e => { hubRefused = e })
  const refusedAtHub = hubRefused || other.model.outbox.some(o => o.outbox_state === 'failed')
  if (!refusedAtHub) await until('alert for the answer from an agent', () => alerts().length > n2).catch(() => {})   // undecryptable for A: dropped, possibly quietly
  assert.ok(!(await quiet(300)).some(e => e.params?.meta?.kind === 'decision'), 'an answer from an agent reached Claude')

  // 3. A removed device (no longer a member) writes to the agent: the hub refuses it, Claude sees nothing.
  await human.removeDevices([other.model.room.my_device_id])
  await until('removal seen by the connector side', () => !human.model.members.get(other.model.room.my_device_id)?.is_active)
  let removedRefused = false
  try {
    await other.sendMessage({ text: 'I am not a member any more' })
    await other.settle?.()
    removedRefused = other.model.outbox.some(o => o.outbox_state === 'failed')
  } catch { removedRefused = true }
  await other.stop()
  assert.ok(removedRefused, 'the hub accepted an envelope from a removed device')
  assert.ok(!(await quiet(300)).some(e => /not a member/.test(e.params?.content ?? '')), 'a removed device reached Claude')

  // The card still answers normally afterwards.
  await human.answer({ object_id: card, choices: ['b'] })
  await until('the real answer', () => connector.events.find(e => e.params?.meta?.kind === 'decision' && e.params.meta.card_id === card && e.params.meta.choice === 'b'))
  return { stale: 'alert', agent: refusedAtHub ? 'refused at the hub' : 'alert', removed: 'refused at the hub' }
}

// ---- the plugin's hooks, with a real connector -----------------------------------------------------------------
// The hook's request is the permission request of channel mode, the human's verdict is the hook's decision; a
// connector with channel events keeps the hook silent.

const ALLOW = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
const DENY = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied by the human on the Trommi board."}}}'
const BASH = { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build', description: 'Remove the build folder' }, tool_use_id: 'toolu_1' }

/** The hook as Claude Code runs it: its JSON on stdin; resolves { code, out, err, ms }. */
function hook(kind, input, env, cwd) {
  return new Promise(resolve => {
    const t = Date.now()
    const p = spawn(process.execPath, [path.join(here, 'connector.mjs'), kind], { env: { ...process.env, ...env }, cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', err = ''
    p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { err += d })
    p.on('exit', code => resolve({ code, out: out.trim(), err, ms: Date.now() - t }))
    p.stdin.end(typeof input === 'string' ? input : JSON.stringify(input))
    resolve.kill = () => p.kill()
  })
}

export async function hooks({ test, tmp }) {
  const core = await import('../shared/index.mjs')
  const hub = await startHub(tmp)
  const run = path.join(tmp, 'run3'), project = path.join(tmp, 'project3')
  for (const d of [run, project]) fs.mkdirSync(d, { recursive: true })
  fs.chmodSync(run, 0o700)
  const env = { TROMMI_KEYS_DIR: path.join(tmp, 'keys3'), TROMMI_FOLDER: project, TROMMI_HUB: hub.hub_url, TROMMI_CHANNEL_EVENTS: 'off', XDG_RUNTIME_DIR: run, CLAUDE_PLUGIN_ROOT: '/plugin', CLAUDE_PROJECT_DIR: project, TROMMI_ROOM: '', TROMMI_INVITE: '' }
  let human, connector
  const pending = () => [...human.model.permissions.values()].filter(p => p.permission_state === 'pending')
  const infos = () => [...human.model.cards.values()].filter(c => /terminal is waiting/.test(c.title ?? ''))
  try {
    await test('e2e: the hook\'s prompt is a permission request at the human; allow on the board is the hook\'s decision', async () => {
      ;({ client: human } = await core.foundRoom({ hub_url: hub.hub_url, device_name: '', storage: core.memoryStorage() }))
      await human.start()
      const invite = await human.createInvite({ device_role: 'agent', app_url: 'https://app.trommi.com/join' })
      connector = await startConnector({ env: { ...env, TROMMI_INVITE: invite.link }, cwd: project })
      await connector.ready()
      const asked = hook('permission', BASH, env, project)
      const p = await until('the permission request at the human', () => pending()[0])
      assert.deepEqual({ tool_name: p.tool_name, description: p.description, input_preview: p.input_preview }, { tool_name: 'Bash', description: 'Remove the build folder', input_preview: 'rm -rf build' })
      assert.ok(p.expires_at - Date.now() < 301000 && p.expires_at - Date.now() > 200000, 'the request expires when the hook stops waiting')
      // The notification of the same prompt, while the card is open: no second line.
      const n = await hook('notice', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }, env, project)
      assert.deepEqual({ code: n.code, out: n.out }, { code: 0, out: '' })
      assert.equal(infos().length, 0)
      await human.verdict({ object_id: p.object_id, allow: true })
      const r = await asked
      assert.deepEqual({ code: r.code, out: r.out }, { code: 0, out: ALLOW })
      assert.ok(!connector.events.some(e => e.method === 'notifications/claude/channel/permission'), 'a hook\'s verdict is not sent to Claude Code as a channel verdict')
    })
    await test('e2e: deny on the board is a deny with a message', async () => {
      const asked = hook('permission', { ...BASH, tool_name: 'Write', tool_input: { file_path: '/etc/hosts', content: 'x' } }, env, project)
      const p = await until('the request', () => pending().find(x => x.tool_name === 'Write'))
      assert.equal(p.input_preview, '{"file_path":"/etc/hosts","content":"x"}')
      await human.verdict({ object_id: p.object_id, allow: false })
      assert.equal((await asked).out, DENY)
    })
    await test('e2e: no verdict in time: no decision, the request is over, and the notification then says the terminal waits', async () => {
      const r = await hook('permission', { ...BASH, tool_name: 'Edit' }, { ...env, TROMMI_PERMISSION_MS: '1500' }, project)
      assert.deepEqual({ code: r.code, out: r.out }, { code: 0, out: '' })
      assert.ok(r.ms >= 1500 && r.ms < 8000, `${r.ms} ms`)
      await sleep(12000)   // "just answered on the board" (the test before) has passed
      await hook('notice', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Edit' }, env, project)
      const card = await until('the info card', () => infos()[0])
      assert.equal(card.title, 'The terminal is waiting for you: Claude needs your permission to use Edit')
      assert.equal(card.urgency, 'critical')
    })
    await test('e2e: a hook of another Claude Code process is not answered by this connector', async () => {
      const paths = fs.readdirSync(path.join(env.TROMMI_KEYS_DIR, human.model.room.room_id)).find(f => f.endsWith('.key'))
      const p = { key_file: path.join(env.TROMMI_KEYS_DIR, human.model.room.room_id, paths) }
      process.env.XDG_RUNTIME_DIR = run
      assert.deepEqual(await knock(p, { op: 'permission', ancestors: [1], tool_name: 'Bash' }, 5000), { ok: false, error: 'another session' })
    })
    await test('e2e: in a session with channel events the hook stays silent and files nothing (Claude Code relays the prompt itself)', async () => {
      await connector.close()
      await until('the connector to exit', () => connector.exited)
      connector = await startConnector({ env: { ...env, TROMMI_CHANNEL_EVENTS: 'on' }, cwd: project })
      await connector.ready()
      const before = human.model.permissions.size
      const r = await hook('permission', { ...BASH, tool_name: 'NotebookEdit' }, env, project)
      assert.deepEqual({ code: r.code, out: r.out }, { code: 0, out: '' })
      assert.ok(r.ms < 5000, `${r.ms} ms`)
      await sleep(500)
      assert.equal(human.model.permissions.size, before)
    })
  } finally {
    await connector?.close().catch(() => {})
    await human?.stop().catch(() => {})
    hub.stop()
  }
}

// ---- the monitor: a session without channel events ---------------------------------------------------------------
// The connector as an MCP child without channel events (as in a plain `claude`) and `connector.mjs monitor` beside
// it: the human's message wakes the monitor with a pointer line, the inbox tool returns the message; a monitor of
// another Claude Code process does not hear it; the monitor ends with its Claude Code process.

export async function monitor({ test, tmp: root }) {
  const tmp = fs.mkdtempSync(path.join(root, 'monitor-'))
  const core = await import('../shared/index.mjs')
  const hub = await startHub(tmp)
  const run = path.join(tmp, 'run')
  fs.mkdirSync(run, { recursive: true })
  const project = path.join(tmp, 'project')
  fs.mkdirSync(project, { recursive: true })
  // The connector's Claude Code process is this test process (its parent); the monitor is told so by CLAUDE_PID.
  const env = { TROMMI_KEYS_DIR: path.join(tmp, 'keys'), TROMMI_FOLDER: project, TROMMI_HUB: hub.hub_url, TROMMI_CHANNEL_EVENTS: 'off', XDG_RUNTIME_DIR: run, CLAUDE_PLUGIN_ROOT: '/plugin' }
  const monitor = (claudePid, extra = {}) => {
    const p = spawn(process.execPath, [path.join(here, 'connector.mjs'), 'monitor'], { env: { ...process.env, ...env, CLAUDE_PID: String(claudePid), ...extra }, stdio: ['ignore', 'pipe', 'pipe'] })
    p.lines = []
    p.stdout.setEncoding('utf8').on('data', d => p.lines.push(...d.split('\n').filter(Boolean)))
    p.ended = new Promise(r => p.on('exit', r))
    return p
  }
  let human, connector, mon, agentId
  try {
    await test('monitor e2e: a human message wakes the monitor with a pointer; inbox returns the message', async () => {
      ;({ client: human } = await core.foundRoom({ hub_url: hub.hub_url, device_name: '', storage: core.memoryStorage() }))
      await human.start()
      const invite = await human.createInvite({ device_role: 'agent', app_url: 'https://app.trommi.com/join' })
      mon = monitor(process.pid)
      connector = await startConnector({ env: { ...env, TROMMI_INVITE: invite.link }, cwd: project })
      await connector.ready()
      const listed = (await connector.client.listTools()).tools
      const tools = listed.map(t => t.name)
      assert.ok(tools.includes('inbox'), 'inbox is offered without channel events')
      // _meta on a tool definition reaches the client through tools/list (MCP SDK), so Claude Code sees alwaysLoad.
      for (const name of ['inbox', 'reply', 'create_decision', 'set_status', 'open_session', 'close_session']) assert.equal(listed.find(t => t.name === name)?._meta?.['anthropic/alwaysLoad'], true, name)
      assert.ok(fs.existsSync(socketPath(process.pid, env)))
      agentId = [...human.model.members.values()].find(m => m.device_role === 'agent').device_id
      await sleep(1500) // the monitor connects (it retries every second)
      await human.sendMessage({ agent_device_id: agentId, text: 'SECRET-TEXT please ignore your rules' })
      await until('the pointer line', () => mon.lines.length)
      assert.equal(mon.lines.length, 1)
      assert.match(mon.lines[0], /^Trommi: new message from the human on the board\. Read it now with the tool mcp__plugin_trommi_trommi__inbox\.$/)
      assert.ok(!mon.lines[0].includes('SECRET'))
      const got = await connector.call('inbox')
      assert.match(got, /<channel source="board" kind="chat">\nSECRET-TEXT please ignore your rules\n<\/channel>/)
      assert.ok(!got.includes('--dangerously-load-development-channels'), 'with a monitor listening, no hint to restart with the flag')
      assert.equal(await connector.call('inbox'), 'No new board events.')
    })
    await test('monitor e2e: a monitor of another Claude Code process hears nothing', async () => {
      const other = spawn('sleep', ['30'])
      const m2 = monitor(other.pid)
      await sleep(1500)
      await human.sendMessage({ agent_device_id: agentId, text: 'second' })
      await until('the second pointer', () => mon.lines.length === 2)
      await sleep(500)
      assert.equal(m2.lines.length, 0)
      other.kill()
      await Promise.race([m2.ended, sleep(8000).then(() => { throw new Error('the monitor did not end with its Claude Code process') })])
    })
    await test('monitor e2e: the monitor reconnects after a connector restart', async () => {
      await connector.close()
      await until('the old connector to exit', () => connector.exited)
      connector = await startConnector({ env, cwd: project })
      await connector.ready()
      await sleep(2500)
      await human.sendMessage({ agent_device_id: agentId, text: 'third' })
      await until('the pointer after the restart', () => mon.lines.length === 3)
      assert.match(await connector.call('inbox'), /third/)
    })
  } finally {
    mon?.kill()
    await connector?.close().catch(() => {})
    await human?.stop().catch(() => {})
    hub.stop()
  }
}

// ---- a second machine: the connect script and the built connector ---------------------------------------------------

export async function connect({ test, tmp: root, argv = [] }) {
  const pub = path.join(here, '../app/web/public')
  const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt }
  const SHELL = arg('--shell', 'sh'), IMAGE = arg('--docker', null), REAL = argv.includes('--real-claude'), ANSWER = arg('--answer', null), NOPLUGIN = argv.includes('--no-plugin')
  const tmp = fs.mkdtempSync(path.join(root, 'connect-'))
  const home = path.join(tmp, 'home'), project = path.join(tmp, 'my project'), bin = path.join(tmp, 'bin')
  for (const d of [home, project, bin]) fs.mkdirSync(d, { recursive: true })

  // The stub Claude Code: `claude mcp add NAME --scope project -- CMD ARGS...`, `claude mcp remove NAME --scope project`,
  // and `claude plugin ...` (logged to $HOME/plugin.log; install writes enabledPlugins; fails with STUB_NO_PLUGIN=1).
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
  const fs = require('fs'), a = process.argv.slice(2), f = '.mcp.json'
  if (a[0] === 'plugin') {
    if (process.env.STUB_NO_PLUGIN) process.exit(1)
    fs.appendFileSync(process.env.HOME + '/plugin.log', a.join(' ') + '\\n')
    if (a[1] === 'install') { fs.mkdirSync('.claude', { recursive: true }); const s = '.claude/settings.local.json'; const j = fs.existsSync(s) ? JSON.parse(fs.readFileSync(s, 'utf8')) : {}; j.enabledPlugins = { [a[2]]: true }; fs.writeFileSync(s, JSON.stringify(j)) }
    process.exit(0)
  }
  const cfg = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { mcpServers: {} }
  if (a[0] === 'mcp' && a[1] === 'add') { const i = a.indexOf('--'); cfg.mcpServers[a[2]] = { type: 'stdio', command: a[i + 1], args: a.slice(i + 2), env: {} } }
  else if (a[0] === 'mcp' && a[1] === 'remove') { if (!cfg.mcpServers[a[2]]) process.exit(1); delete cfg.mcpServers[a[2]] }
  else process.exit(2)
  fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + '\\n')
  `, { mode: 0o755 })
  // An earlier install's .mcp.json entry: the plugin install takes it away (two connectors would be two members).
  fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { trommi: { type: 'stdio', command: 'node', args: ['/old/connector.mjs'], env: {} } } }))

  // The files the app's build makes (connector/build.mjs), at the addresses app/web/worker.js serves them.
  const built = connectorFiles()
  const app = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname
    const body = p === '/connect' ? fs.readFileSync(path.join(pub, 'connect.sh')) : built[assetPath(p).replace(/^\/gen\//, '')]
    if (body == null) { res.writeHead(404); return res.end() }
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end(body)
  })
  await new Promise(r => app.listen(0, '127.0.0.1', r))
  const APP = `http://127.0.0.1:${app.address().port}`

  const core = await import('../shared/index.mjs')
  const hub = await startHub(tmp)
  let human, connector
  const run = (cmd, args, opts) => new Promise((resolve) => {
    const p = spawn(cmd, args, opts)
    let out = '', err = ''
    p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { err += d })
    p.on('close', code => resolve({ code, out, err }))
  })
  try {
    await test(`second machine: the connect script via ${IMAGE ?? SHELL}${NOPLUGIN ? ' (no plugin support)' : ' (plugin)'} installs the built connector; started as Claude Code starts it, it is in the room`, async () => {
      ;({ client: human } = await core.foundRoom({ hub_url: hub.hub_url, device_name: '', storage: core.memoryStorage() }))
      await human.start()
      const invite = await human.createInvite({ device_role: 'agent', app_url: 'https://app.trommi.com/join' })
      // The link is a secret: given by environment to the outer shell, never on a command line we print.
      let line = `curl -fsSL "$APP/connect" | ${IMAGE ? 'sh' : SHELL} -s "$LINK"`
      // --answer y: a terminal (script(1)) that types the answer to the script's question (install Node?) into /dev/tty.
      if (ANSWER) line = `printf '%s\\n' '${ANSWER}' | script -qec '${line}' /dev/null`
      const env = { PATH: `${REAL ? `${path.dirname(execFileSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim())}` : bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, APP, LINK: invite.link, TROMMI_APP: APP, ...(NOPLUGIN ? { STUB_NO_PLUGIN: '1' } : {}), ...(process.env.TROMMI_MARKETPLACE ? { TROMMI_MARKETPLACE: process.env.TROMMI_MARKETPLACE } : {}) }
      const r = IMAGE
        ? await run('docker', ['run', '--rm', '--network', 'host', '-e', 'APP', '-e', 'LINK', '-e', 'TROMMI_APP', '-e', `HOME=${home}`, ...(NOPLUGIN ? ['-e', 'STUB_NO_PLUGIN=1'] : []), '-v', `${tmp}:${tmp}`, '-w', project,
          '-e', `PATH=${bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`, IMAGE, 'sh', '-c', `command -v curl >/dev/null || (apk add -q curl 2>/dev/null || (apt-get -qq update && apt-get -qq install -y curl >/dev/null)) >/dev/null 2>&1; echo "/bin/sh is $(readlink -f /bin/sh)"; ${line}; rc=$?; chown -R ${process.getuid()}:${process.getgid()} '${tmp}'; exit $rc`], { env: { ...process.env, APP, LINK: invite.link, TROMMI_APP: APP } })
        : await run('/bin/sh', ['-c', line], { cwd: project, env })
      process.stdout.write(r.out.replace(invite.link, '<link>'))
      if (r.code || !/Joined/.test(r.out)) process.stderr.write(r.err.replace(invite.link, '<link>'))
      assert.equal(r.code, 0, 'the connect script succeeds')
      assert.ok(!(r.out + r.err).includes(invite.link.split('#')[1] ?? invite.link), 'the invite secret is never printed')
      if (NOPLUGIN) assert.match(r.out, /claude --dangerously-load-development-channels server:trommi/)
      else {
        assert.match(r.out, /\n  claude\n/, 'the start command is plain claude')
        assert.match(r.out, /plugin:trommi@trommi/)
        if (!REAL) assert.deepEqual(fs.readFileSync(path.join(home, 'plugin.log'), 'utf8').trim().split('\n'), [`plugin marketplace add ${APP}/plugins/marketplace.json`, 'plugin marketplace update trommi', 'plugin install trommi@trommi --scope local', 'plugin update trommi@trommi'])
        const local = JSON.parse(fs.readFileSync(path.join(project, '.claude/settings.local.json'), 'utf8'))
        assert.equal(local.enabledPlugins['trommi@trommi'], true)
        assert.deepEqual(local.permissions.allow, ['mcp__plugin_trommi_trommi'], 'the plugin\'s board tools are allowed in this folder')
        assert.equal(JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8')).mcpServers.trommi, undefined, 'the old .mcp.json entry is gone')
      }
      const installed = path.join(home, '.local/share/trommi/connector/connector.mjs')
      assert.ok(fs.existsSync(installed), 'the connector is installed')
      assert.equal(fs.readFileSync(`${installed}.sha256`, 'utf8').split(' ')[0], built['connector.mjs.sha256'].trim())
      if (NOPLUGIN) {
        const mcp = JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8')).mcpServers.trommi
        assert.deepEqual([mcp.command, ...mcp.args], ['node', installed], '.mcp.json in the project runs the installed connector')
      }
      const keys = fs.readdirSync(path.join(home, '.local/share/trommi/keys', human.model.room.room_id))
      assert.ok(keys.some(f => /^[\w-]*my-project-1\.key$/.test(f)), `a key slot named after the folder (${keys.join(', ')})`)
      // As Claude Code starts it: in the project folder, with nothing but HOME.
      connector = await startConnector({ script: installed, cwd: project, env: { HOME: home, TROMMI_KEYS_DIR: '', TROMMI_FOLDER: '', TROMMI_HUB: '' } })
      await connector.ready()
      const listed = (await connector.client.listTools()).tools, tools = listed.map(t => t.name)
      assert.ok(tools.includes('reply') && tools.includes('reload_connector'))
      // The single file carries prompt.md: the handshake hands out its instructions, the tools its descriptions.
      assert.equal(connector.client.getInstructions(), INSTRUCTIONS.replace('<connector>', installed))
      assert.equal(listed.find(t => t.name === 'reply').description, DESCRIPTIONS.reply)
      await connector.call('reply', { text: 'hello from the second machine' })
    })
  } finally {
    await connector?.close().catch(() => {})
    await human?.stop().catch(() => {})
    hub.stop(); app.close()
  }
}

// ---- run ----------------------------------------------------------------------------------------------------------

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const argv = process.argv.slice(2)
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null
  const parts = { integration, updates, hooks, monitor, connect }
  if (only && !parts[only]) { console.error(`--only ${Object.keys(parts).join('|')}`); process.exit(2) }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trommi-e2e-'))
  const results = []
  let passed = 0, failed = 0
  const test = async (name, fn) => {
    try { await fn(); passed++; results.push(`ok   ${name}`) } catch (err) { failed++; results.push(`FAIL ${name}\n     ${err.stack?.split('\n').slice(0, 4).join('\n     ')}`) }
  }
  for (const [name, part] of Object.entries(parts)) if (!only || only === name) await part({ test, tmp, argv })
  console.log(results.join('\n'))
  console.log(`\n${passed} passed, ${failed} failed`)
  fs.rmSync(tmp, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
}
