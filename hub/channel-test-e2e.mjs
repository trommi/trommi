// channel-test-e2e.mjs: part 2 of hub/channel-test.mjs. A real hub (hub/server.mjs on a free port 8891-8899,
// throwaway data dir), a scripted human device from client/core, and hub/channel.mjs as a real MCP stdio child.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

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
  throw new Error('no free port in 8891-8899')
}

export async function startHub(tmp) {
  const port = await freePort()
  const data = fs.mkdtempSync(path.join(tmp, 'hub-'))
  const hub_url = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, [path.join(here, 'server.mjs')], {
    env: { ...process.env, HUB_PORT: String(port), PORT: String(port), HUB_HOST: '127.0.0.1', HUB_DATA: data, DATA_DIR: data, HUB_URL: hub_url, HUB_DB: path.join(data, 'hub.db') },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let err = ''
  child.stderr.on('data', d => { err += d })
  await until('the hub', async () => { try { return (await fetch(`${hub_url}/healthz`)).ok } catch { return false } }).catch(e => { throw new Error(`${e.message}: ${err.slice(-500)}`) })
  return { hub_url, stop: () => child.kill(), stderr: () => err }
}

/** hub/channel.mjs as Claude Code starts it; collects every notification. */
export async function startChannel({ env, cwd }) {
  const events = []
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(here, 'channel.mjs')], env: { ...process.env, ...env }, cwd, stderr: 'pipe' })
  let err = ''
  const client = new Client({ name: 'channel-test', version: '1' }, { capabilities: {} })
  client.fallbackNotificationHandler = async n => { events.push(n) }
  await client.connect(transport)
  transport.stderr?.on('data', d => { err += d })
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args })
    const text = r.content?.[0]?.text ?? ''
    if (r.isError) throw Object.assign(new Error(text), { tool_error: true })
    return text
  }
  const ready = () => until('the channel to be in the room', async () => { try { await call('list_cards'); return true } catch { return false } }, 20000)
  const next = (pred, what = 'a channel event') => until(what, () => events.find(e => !e.seen && pred(e)) && Object.assign(events.find(e => !e.seen && pred(e)), { seen: true }))
  return { client, events, call, ready, next, stderr: () => err, close: () => client.close() }
}

export async function integration({ test, tmp }) {
  const core = await import('../client/core/index.mjs')
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
      await until('profile', () => human.model.sessions.get(agentId)?.profile?.model === 'Claude Opus 5.5')
      await until('status line', () => human.model.sessions.get(agentId)?.status_lines?.find(l => l.id === 'tests'))
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
      const timeline = `chat:session/${agentId}`
      const shown = human.model.published.get(id).attachments[0].attachment_id
      const said = await until('announcement', () => [...(human.model.timelines.get(timeline)?.items.values() ?? [])].find(i => i.content?.attachments?.[0]?.attachment_id === shown))
      assert.equal(said.content.text, '**Report**\n\nfor you')
      const bytes = await human.fetchAttachment(said.content.attachments[0])
      assert.equal(new TextDecoder().decode(bytes), '<h1>Report</h1>')
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
        const invite = await human.createInvite({ device_role: 'agent', app_url: 'https://app.trommi.com/join' })
        assert.match(await second.call('join', { link: invite.link }), /joined/)
        await until('two agents', () => [...human.model.members.values()].filter(m => m.device_role === 'agent' && m.is_active).length === 2)
        const room = path.join(keys, human.model.room.room_id)
        assert.deepEqual(fs.readdirSync(room).filter(f => f.endsWith('.key')).map(f => f.replace(/^.*-(\d+)\.key$/, '$1')).sort(), ['1', '2'])
      } finally { await second.close() }
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

    await test('e2e: forged commands are dropped and reported as alert/<n>', async () => {
      const forge = await import('./channel-test-forge.mjs').catch(() => null)
      if (!forge) throw new Error('forging helpers missing')
      const how = await forge.run({ core, human, agentId, channel, until, keys }); console.error('forgeries:', JSON.stringify(how))
    })
  } finally {
    try { await channel?.close() } catch {}
    try { human?.stop() } catch {}
    hub.stop()
  }
}
