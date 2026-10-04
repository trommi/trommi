// channel-test-e2e.mjs: part 2 of connector/channel-test.mjs. A real hub (hub/server.mjs on a free port 8891-8899,
// throwaway data dir), a scripted human device from client/core, and connector/channel.mjs as a real MCP stdio child.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileStorage } from '../core/storage-file.mjs'

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

export async function startHub(tmp) {
  const port = await freePort()
  const data = fs.mkdtempSync(path.join(tmp, 'hub-'))
  const hub_url = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, [path.join(here, '../hub/server.mjs')], {
    env: { ...process.env, HUB_PORT: String(port), PORT: String(port), HUB_HOST: '127.0.0.1', HUB_DATA: data, DATA_DIR: data, HUB_URL: hub_url, HUB_DB: path.join(data, 'hub.db') },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let err = ''
  child.stderr.on('data', d => { err += d })
  await until('the hub', async () => { try { return (await fetch(`${hub_url}/healthz`)).ok } catch { return false } }).catch(e => { throw new Error(`${e.message}: ${err.slice(-500)}`) })
  return { hub_url, stop: () => child.kill(), stderr: () => err }
}

/** connector/channel.mjs as Claude Code starts it; collects every notification. */
export async function startChannel({ env, cwd, script = path.join(here, 'channel.mjs') }) {
  const events = []
  const transport = new StdioClientTransport({ command: process.execPath, args: [script], env: { ...process.env, ...env }, cwd, stderr: 'pipe' })
  let err = ''
  const client = new Client({ name: 'channel-test', version: '1' }, { capabilities: {} })
  client.fallbackNotificationHandler = async n => { events.push(n) }
  await client.connect(transport)
  const handle = { exited: false }
  transport.onclose = () => { handle.exited = true }
  transport.stderr?.on('data', d => { err += d })
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args })
    const text = r.content?.[0]?.text ?? ''
    if (r.isError) throw Object.assign(new Error(text), { tool_error: true })
    return text
  }
  const ready = () => until('the channel to be in the room', async () => { try { await call('list_cards'); return true } catch { return false } }, 20000)
  const next = (pred, what = 'a channel event') => until(what, () => events.find(e => !e.seen && pred(e)) && Object.assign(events.find(e => !e.seen && pred(e)), { seen: true }))
  return Object.assign(handle, { client, events, call, ready, next, stderr: () => err, close: () => client.close() })
}

export async function integration({ test, tmp }) {
  const core = await import('../core/index.mjs')
  const hub = await startHub(tmp)
  const keys = path.join(tmp, 'keys')
  const project = path.join(tmp, 'project')
  fs.mkdirSync(project, { recursive: true })
  const env = { TROMMI_KEYS_DIR: keys, TROMMI_FOLDER: project, TROMMI_HUB: hub.hub_url }
  let human, agent, agentId, channel
  const chEvent = (kind, id) => e => e.method === 'notifications/claude/channel' && e.params.meta?.kind === kind && (!id || e.params.meta.card_id === id)
  try {
    await test('e2e: human founds a room, invites an agent; the channel joins by TROMMI_INVITE', async () => {
      ;({ client: human } = await core.foundRoom({ hub_url: hub.hub_url, device_name: '', storage: core.memoryStorage() }))
      await human.start()
      const invite = await human.createInvite({ device_role: 'agent', app_url: 'https://app.trommi.com/join' })
      channel = await startChannel({ env: { ...env, TROMMI_INVITE: invite.link }, cwd: project })
      await channel.ready()
      agentId = [...human.model.members.values()].find(m => m.device_role === 'agent')?.device_id
      assert.ok(agentId, 'the human sees the agent in the member list')
      const keyFile = fs.readdirSync(path.join(keys, human.model.room.room_id)).find(f => f.endsWith('.key'))
      assert.equal((fs.statSync(path.join(keys, human.model.room.room_id, keyFile)).mode & 0o777).toString(8), '600')
    })

    await test('e2e: introduce + set_status reach the human as registers; device label is encrypted', async () => {
      await channel.call('introduce', { model: 'Claude Opus 5.5', task: 'night test', icon: 'database' })
      await channel.call('set_status', { id: 'tests', label: 'Tests', state: 'working', detail: 'running' })
      await until('profile', () => human.model.sessions.get(human.sessionOfAgent(agentId))?.profile?.model === 'Claude Opus 5.5')
      // The sidebar name is the folder's name; host and full folder travel beside it (all encrypted).
      const label = await until('device label', () => human.model.members.get(agentId)?.device_name && human.model.members.get(agentId))
      assert.equal(label.device_name, 'project')
      assert.match(label.folder, /project$/)
      assert.ok(label.host)
      await until('status line', () => human.model.sessions.get(human.sessionOfAgent(agentId))?.status_lines?.find(l => l.id === 'tests'))
    })

    await test('e2e: own sends are visible at once: set_status names a card filed a moment earlier', async () => {
      const id = (await channel.call('create_decision', { title: 'Right away?', options: [{ key: 'y', label: 'Yes' }, { key: 'n', label: 'No' }] })).match(/card ([0-9a-f]{32}) created, position \d+ of \d+/)?.[1]
      assert.ok(id, 'create_decision reports the place in the stack')
      assert.equal(await channel.call('set_status', { id: 'wait', label: 'Waiting', state: 'decision', card_id: id }), 'status "wait" is decision')
      assert.ok(JSON.parse(await channel.call('list_cards')).some(c => c.id === id))
      await channel.call('withdraw_card', { card_id: id, reason: 'test' })
      assert.equal(JSON.parse(await channel.call('list_cards')).find(c => c.id === id).status, 'done')
      await channel.call('clear_status', { id: 'wait' })
    })

    let card
    await test('e2e: create_decision -> human answers -> decision event', async () => {
      const out = await channel.call('create_decision', { title: 'Run it tonight?', body: 'Locks orders 40 s.', options: [{ key: 'tonight', label: 'Tonight' }, { key: 'now', label: 'Now' }], recommended: 'tonight' })
      card = out.match(/card ([0-9a-f]{32})/)[1]
      await until('the card at the human', () => human.model.cards.get(card)?.title === 'Run it tonight?')
      await human.answer({ object_id: card, choices: ['now'], note: 'go' })
      const ev = await channel.next(chEvent('decision', card))
      assert.equal(ev.params.meta.choice, 'now')
      assert.equal(ev.params.content, 'go')
    })

    await test('e2e: decide again -> decision_reopened; hand back -> revise; explain -> reply presents', async () => {
      await human.decideAgain({ object_id: card })
      const re = await channel.next(chEvent('decision_reopened', card))
      assert.equal(re.params.meta.previous_choice, 'now')
      await until('card open at the channel', async () => JSON.parse(await channel.call('list_cards')).find(c => c.id === card)?.status === 'open')
      await human.sendMessage({ agent_device_id: agentId, object_id: card, text: 'clearer please', hand_back: true })
      const hb = await channel.next(chEvent('chat', card))
      assert.equal(hb.params.meta.handback, '1')
      await until('in revision', async () => JSON.parse(await channel.call('list_cards')).find(c => c.id === card)?.with_agent)
      await channel.call('revise_card', { card_id: card, title: 'Run the migration tonight at 2?', note: 'clearer' })
      await until('version 2 at the human', () => human.model.cards.get(card)?.object_version === 2 && !human.model.cards.get(card)?.in_revision)
      await human.sendMessage({ agent_device_id: agentId, object_id: card, text: 'explain', explain: true })
      assert.equal((await channel.next(chEvent('chat', card))).params.meta.explain, '1')
      await until('explain seen', async () => JSON.parse(await channel.call('list_cards')).find(c => c.id === card)?.with_agent)
      await channel.call('reply', { card_id: card, text: 'It means 40 s of lock at 2 am.' })
      await until('presented again', () => !human.model.cards.get(card)?.in_revision)
      await human.answer({ object_id: card, choices: ['tonight'] })
      assert.equal((await channel.next(chEvent('decision', card))).params.meta.choice, 'tonight')
      await channel.call('close_card', { card_id: card, summary: 'ran' })
    })

    await test('e2e: shred and info read', async () => {
      const q = (await channel.call('create_decision', { title: 'Which font?', options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] })).match(/card ([0-9a-f]{32})/)[1]
      await until('q', () => human.model.cards.get(q))
      await human.shred({ object_id: q, note: 'later' })
      assert.match((await channel.next(chEvent('shredded', q))).params.content, /Their note: later/)
      const i = (await channel.call('create_info', { title: 'How it works', body: 'Like this.' })).match(/info ([0-9a-f]{32})/)[1]
      await until('i', () => human.model.cards.get(i))
      await human.markRead({ object_id: i })
      await channel.next(chEvent('info_read', i))
    })

    await test('e2e: chat with an attachment arrives as a decrypted file', async () => {
      const ref = await human.uploadAttachment(new TextEncoder().encode('hello file'), { file_name: 'note.txt', media_type: 'text/plain' })
      await human.sendMessage({ agent_device_id: agentId, text: 'see file', attachments: [ref] })
      const ev = await channel.next(chEvent('chat'))
      assert.equal(fs.readFileSync(ev.params.meta.files, 'utf8'), 'hello file')
      await channel.call('reply', { text: 'got it' })
    })

    await test('e2e: publish_asset puts a published object on the board and announces it in the conversation', async () => {
      const id = (await channel.call('publish_asset', { content: '<h1>Report</h1>', title: 'Report', note: 'for you' })).match(/published as ([0-9a-f]{32})/)[1]
      await until('published object', () => human.model.published.get(id)?.title === 'Report')
      const timeline = `chat:session/${human.sessionOfAgent(agentId)}`
      const said = await until('announcement', () => [...(human.model.timelines.get(timeline)?.items.values() ?? [])].find(i => i.content?.published_object_id === id))
      assert.equal(said.content.text, '**Report**\n\nfor you')
      const bytes = await human.fetchAttachment(said.content.attachments[0])
      assert.equal(new TextDecoder().decode(bytes), '<h1>Report</h1>')
    })

    await test('e2e: share_asset gives outsiders a link; release: false and revoke_asset end it', async () => {
      const id = (await channel.call('publish_asset', { content: '<h1>For outsiders</h1>', title: 'Outside' })).match(/published as ([0-9a-f]{32})/)[1]
      const link = (await channel.call('share_asset', { id, expires_hours: 1 })).match(/Link for the recipient: (\S+)/)[1]
      // What the viewer page does, with nothing but the link: no sign-in, no membership.
      const viewer = new core.Hub({ hub_url: hub.hub_url })
      const open = l => core.openShared(viewer, l)
      assert.equal(new TextDecoder().decode(await open(link)), '<h1>For outsiders</h1>')
      const { share_secret } = core.parseShareLink(link)
      await assert.rejects(open(link.replace(share_secret, core.z.b64u(new Uint8Array(32)))))
      assert.match(await channel.call('share_asset', { id, release: false }), /release taken back/)
      await assert.rejects(open(link))
      const again = (await channel.call('share_asset', { id })).match(/Link for the recipient: (\S+)/)[1]
      assert.ok(await open(again))
      await channel.call('revoke_asset', { id })
      await assert.rejects(open(again))
      await until('unpublished', () => human.model.published.get(id)?.object_state === 'closed')
    })

    await test('e2e: permission round trip', async () => {
      await channel.client.notification({ method: 'notifications/claude/channel/permission_request', params: { request_id: 'req1', tool_name: 'Bash', description: 'Run shell command', input_preview: '{"command":"ls"}' } })
      const pid = await until('permission at the human', () => [...human.model.permissions.values()].find(p => p.tool_name === 'Bash')?.object_id)
      await human.verdict({ object_id: pid, allow: true })
      const v = await channel.next(e => e.method === 'notifications/claude/channel/permission')
      assert.deepEqual({ ...v.params }, { request_id: 'req1', behavior: 'allow' })
    })

    await test('e2e: a second session in the same folder does not share the key: it needs its own invite and is a second member', async () => {
      const second = await startChannel({ env, cwd: project })
      try {
        await until('needs its own invite', async () => { try { await second.call('list_cards'); return false } catch (e) { return /invite of its own/.test(e.message) } })
        // Joining is the human's act: the model has no join tool, the human runs the CLI in the folder (review 2).
        assert.ok(!(await second.client.listTools()).tools.some(t => t.name === 'join'), 'a model-callable join tool exists')
        assert.match((await second.call('list_cards').catch(e => e.message)), /channel\.mjs join '<link>'/)
        await second.close()
        const invite = await human.createInvite({ device_role: 'agent', app_url: 'https://app.trommi.com/join' })
        const { execFile } = await import('node:child_process')
        const out = await new Promise((res, rej) => execFile(process.execPath, [path.join(here, 'channel.mjs'), 'join', invite.link], { env: { ...process.env, ...env }, cwd: project }, (e, so, se) => (e ? rej(new Error(`${e.message}\n${se}`)) : res(so))))
        assert.match(out, /joined room/)
        await until('two agents', () => [...human.model.members.values()].filter(m => m.device_role === 'agent' && m.is_active).length === 2)
        const room = path.join(keys, human.model.room.room_id)
        assert.deepEqual(fs.readdirSync(room).filter(f => f.endsWith('.key')).map(f => f.replace(/^.*-(\d+)\.key$/, '$1')).sort(), ['1', '2'])
        const again = await startChannel({ env, cwd: project })
        await again.ready().finally(() => again.close())
      } finally { await second.close().catch(() => {}) }
    })

    let child
    await test('e2e: child session: open_session and session on tools; the human sees it under the main; answers come back with meta session', async () => {
      const main = human.sessionOfAgent(agentId)
      assert.match(await channel.call('open_session', { name: 'Design', task: 'pictures', icon: 'brush' }), /child session opened: "Design"/)
      await channel.call('reply', { text: 'hello from Design', session: 'Design' })
      await channel.call('set_status', { id: 'draw', label: 'Drawing', state: 'working', session: 'Design' })
      const out = await channel.call('create_decision', { title: 'Which colour?', options: [{ key: 'r', label: 'Red' }, { key: 'b', label: 'Blue' }], session: 'Design' })
      const id = out.match(/card ([0-9a-f]{32})/)[1]
      // a second helper opened by its first use
      await channel.call('reply', { text: 'Server here', session: 'Server' })
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
      const ev = await channel.next(chEvent('decision', id))
      assert.equal(ev.params.meta.session, 'Design')
      await human.sendMessage({ agent_device_id: agentId, session_id: child, text: 'for Design' })
      const chat = await channel.next(e => e.method === 'notifications/claude/channel' && e.params.content === 'for Design')
      assert.equal(chat.params.meta.session, 'Design')
      const listed = JSON.parse(await channel.call('list_cards', { session: 'Design' }))
      assert.deepEqual(listed.map(c => [c.id, c.session]), [[id, 'Design']])
    })

    await test('e2e: restart reuses the identity, no new member entry, catches up', async () => {
      const entries = human.model.room.last_entry_number
      const agents = [...human.model.members.values()].filter(m => m.device_role === 'agent').length
      await channel.close()
      await human.sendMessage({ agent_device_id: agentId, text: 'while you were away' })
      channel = await startChannel({ env, cwd: project })
      await channel.ready().catch(e => { throw new Error(`${e.message}\n${channel.stderr()}`) })
      const ev = await channel.next(chEvent('chat')).catch(e => { throw new Error(`${e.message}\n${channel.stderr()}\n${JSON.stringify(channel.events)}`) })
      assert.equal(ev.params.content, 'while you were away')
      assert.equal(human.model.room.last_entry_number, entries)
      assert.equal([...human.model.members.values()].filter(m => m.device_role === 'agent').length, agents)
      assert.match(channel.stderr(), new RegExp(`as ${agentId.slice(0, 12)}`))
    })

    await test('e2e: the child session survives a restart of the channel: same session, no new one', async () => {
      const before = [...human.model.sessions.values()].filter(s => s.profile?.agent_name === 'Design').length
      assert.match(await channel.call('open_session', { name: 'Design' }), /already open/)
      await channel.call('reply', { text: 'Design after the restart', session: 'design' })
      await until('the message in the same child', async () => {
        await human.loadTimeline(`chat:session/${child}`).catch(() => {})
        return [...(human.model.timelines.get(`chat:session/${child}`)?.items.values() ?? [])].some(i => i.content?.text === 'Design after the restart')
      })
      assert.equal([...human.model.sessions.values()].filter(s => s.profile?.agent_name === 'Design').length, before)
    })

    await test('e2e: a renamed project folder keeps its identity (slot name kept in .trommi/slot-base)', async () => {
      const entries = human.model.room.last_entry_number
      assert.match(fs.readFileSync(path.join(project, '.trommi', 'slot-base'), 'utf8'), /project/)
      await channel.close()
      const moved = `${project}-renamed`
      fs.renameSync(project, moved)
      try {
        channel = await startChannel({ env: { ...env, TROMMI_FOLDER: moved }, cwd: moved })
        await channel.ready().catch(e => { throw new Error(`${e.message}\n${channel.stderr()}`) })
        assert.match(channel.stderr(), new RegExp(`as ${agentId.slice(0, 12)}`))
        assert.equal(human.model.room.last_entry_number, entries, 'no new member entry')
        await channel.close()
      } finally { fs.renameSync(moved, project) }
      channel = await startChannel({ env, cwd: project })
      await channel.ready()
    })

    await test('e2e: forged commands are dropped and reported as alert/<n>', async () => {
      const forge = await import('./channel-test-forge.mjs').catch(() => null)
      if (!forge) throw new Error('forging helpers missing')
      const how = await forge.run({ core, human, agentId, channel, until, keys }); console.error('forgeries:', JSON.stringify(how))
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
      const next = await startChannel({ env: { ...env, TROMMI_FOLDER: dir, TROMMI_INVITE: invite.link }, cwd: dir })
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

    await test('e2e: lease-lost: another process takes over the key; the channel exits without posting', async () => {
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
      const exited = await until('the channel to exit', () => channel.exited ? true : false, 15000).catch(() => false)
      await other.stop()
      assert.ok(exited, `the channel kept running after losing the lease\n${channel.stderr().slice(-400)}`)
      assert.match(channel.stderr(), /another process took over this key/)
      await new Promise(r => setTimeout(r, 300))
      const after = human.chains.get(core.z.b64u(core.z.unhex(agentId)))?.seq
      assert.equal(after, before, 'the channel posted after losing the lease')
      assert.deepEqual(fs.readdirSync(room).filter(f => f.startsWith(`${prefix}lock.`)), [], 'the claim of the slot is left behind')
    })
  } finally {
    try { await channel?.close() } catch {}
    try { human?.stop() } catch {}
    hub.stop()
  }
}

/** Connector updates: a changed code file is hot-reloaded on reload_connector; a changed shell file asks for a restart. */
export async function updates({ test, tmp }) {
  // A copy of connector/ and core/ beside node_modules, so the test can change files without touching the repository.
  const repo = path.join(tmp, 'update-repo')
  for (const d of ['connector', 'core']) fs.cpSync(path.join(here, '..', d), path.join(repo, d), { recursive: true })
  fs.symlinkSync(path.join(here, '../node_modules'), path.join(repo, 'node_modules'))
  const project = path.join(tmp, 'update-project')
  fs.mkdirSync(project, { recursive: true })
  const env = { TROMMI_KEYS_DIR: path.join(tmp, 'update-keys'), TROMMI_FOLDER: project, TROMMI_HUB: 'http://127.0.0.1:9', TROMMI_UPDATE_POLL_MS: '300' }
  const ch = await startChannel({ env, cwd: project, script: path.join(repo, 'connector/channel.mjs') })
  const update = e => e.method === 'notifications/claude/channel' && e.params.meta?.kind === 'update'
  try {
    await test('update: a changed tool file is announced, and reload_connector loads it without a restart (tool list changed)', async () => {
      const before = (await ch.client.listTools()).tools
      assert.ok(before.some(t => t.name === 'reload_connector'))
      const file = path.join(repo, 'connector/channel-tools.mjs')
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace("name: 'list_cards',", "name: 'list_cards_v2',"))
      const ev = await ch.next(update, 'the update event')
      assert.equal(ev.params.meta.update_available, '1')
      assert.equal(ev.params.meta.restart_required, '0')
      assert.match(ev.params.content, /Neue Connector-Version .* jetzt neu laden\?/)
      assert.match(await ch.call('reload_connector'), /^Reloaded: connector version/)
      await ch.next(e => e.method === 'notifications/tools/list_changed', 'tools/list_changed')
      const after = (await ch.client.listTools()).tools.map(t => t.name)
      assert.ok(after.includes('list_cards_v2') && !after.includes('list_cards'), after.join(','))
      assert.ok(after.includes('reload_connector'))
      assert.match(await ch.call('reload_connector'), /is current/)
    })
    await test('update: a changed core file (shell) is announced with restart_required and reload_connector asks for /mcp Reconnect', async () => {
      fs.appendFileSync(path.join(repo, 'core/transport.mjs'), '\n// changed by the update test\n')
      const ev = await ch.next(e => update(e) && e.params.meta.restart_required === '1', 'the restart event')
      assert.match(ev.params.content, /\/mcp/)
      assert.match(await ch.call('reload_connector'), /\/mcp, then trommi, then Reconnect/)
    })
  } finally { await ch.close() }
}
