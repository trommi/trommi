// End-to-end check: act as Claude Code over stdio and as the browser over HTTP.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PORT = 8791
const base = `http://localhost:${PORT}`
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'board-test-'))
const shot = path.join(data, 'mock.png')
fs.writeFileSync(shot, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))

// A state file as the previous version wrote it: no number, urgency or queue,
// and an agent message without attachments.
const option = key => ({ key, label: key, detail: '' })
const oldCard = (id, status, created, rest) => ({
  id, kind: 'decision', status, title: id, body: '', options: [option('a'), option('b')], attachments: [],
  choice: null, note: '', summary: '', created, decided: null, ...rest,
})
fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({
  messages: [{ id: 'm-old1', from: 'user', text: 'alt', ts: 1 }, { id: 'm-old2', from: 'agent', text: 'auch alt', ts: 2 }],
  cards: [
    oldCard('old-done', 'done', 10, { choice: 'a', decided: 11, summary: 'fertig' }),
    oldCard('old-open', 'open', 20),
    { ...oldCard('old-perm', 'open', 30), kind: 'permission', request_id: 'stale' },
  ],
}))

// The fixtures below are dated 1970; keep them out of the cleanup until it is tested on purpose.
process.env.BOARD_RETENTION_DAYS = '100000'

const received = []
async function start(name = 'main', sink = received) {
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} })
  client.fallbackNotificationHandler = async n => { sink.push(n) }
  await client.connect(new StdioClientTransport({
    command: 'node', args: ['./server.mjs'],
    env: { ...process.env, BOARD_PORT: String(PORT), BOARD_DATA: data, BOARD_TOKEN: 'secret', BOARD_AGENT: name, TINFOIL_API_KEY: '' },
  }))
  return client
}
let client = await start()
const call = (name, args) => client.callTool({ name, arguments: args })
const ask = async (title, extra = {}) => {
  const res = await call('create_decision', { title, options: [option('a'), option('b')], ...extra })
  return res.content[0].text.match(/^card (\w+) /)[1]
}
// The SDK reports a throwing tool either as a rejection or as an isError result.
const refused = async (name, args, pattern) => {
  let message
  try {
    const res = await call(name, args)
    assert.ok(res.isError, `${name} should have been refused`)
    message = res.content[0].text
  } catch (err) {
    message = err.message
  }
  assert.match(message, pattern)
}

const cookie = 'board_8791=secret'
const post = (url, body, origin = base) => fetch(base + url, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: JSON.stringify(body),
})
const state = async () => {
  const res = await fetch(`${base}/events`, { headers: { Cookie: cookie } })
  const reader = res.body.getReader()
  const { value } = await reader.read()
  await reader.cancel()
  return JSON.parse(new TextDecoder().decode(value).replace(/^data: /, ''))
}
const until = async test => {
  for (let i = 0; i < 50 && !test(); i++) await new Promise(r => setTimeout(r, 20))
  assert.ok(test(), 'timed out waiting for notification')
}

assert.deepEqual(
  (await client.listTools()).tools.map(t => t.name),
  ['reply', 'create_decision', 'set_urgency', 'withdraw_card', 'close_card', 'set_status', 'clear_status', 'introduce', 'create_voiceover', 'list_cards'],
)

// migration: old cards get numbers in creation order, an urgency, and a queue
let s = await state()
assert.deepEqual(s.cards.map(c => [c.id, c.number, c.urgency, c.urgency_reason]), [
  ['old-done', 1, 'normal', ''], ['old-open', 2, 'normal', ''], ['old-perm', 3, 'critical', ''],
])
// an approval left over from the previous session is closed, not queued
assert.deepEqual(s.queue, ['old-open'])
assert.equal(s.cards[2].status, 'done')
assert.equal((await post('/decide', { card_id: 'old-perm', key: 'a' })).status, 400)
assert.equal(s.next_number, 4)
assert.deepEqual(s.messages[1].attachments, [])
await call('withdraw_card', { card_id: 'old-open' })
const before = (await state()).messages.length

// chat in both directions
assert.equal((await post('/message', { text: 'hallo' })).status, 200)
await until(() => received.length === 1)
assert.deepEqual(received[0].params, { content: 'hallo', meta: { kind: 'chat' } })
await call('reply', { text: 'hi', attachments: [shot] })

// decision with keyed options and an image
await call('create_decision', {
  title: 'Welche Datenbank?', body: 'Für den Prototyp',
  options: [{ key: 'sqlite', label: 'SQLite' }, { key: 'pg', label: 'Postgres', detail: 'braucht Server' }, { key: 'later', label: 'Später' }],
  attachments: [shot],
})
s = await state()
const card = s.cards.at(-1)
assert.equal(card.status, 'open')
assert.equal(card.number, 4)
assert.equal(card.urgency, 'normal', 'urgency defaults to normal')
assert.equal(card.urgency_reason, '')
assert.deepEqual(s.queue, [card.id])
assert.equal(card.attachments[0].image, true)
assert.equal((await fetch(base + card.attachments[0].url, { headers: { Cookie: cookie } })).headers.get('content-type'), 'image/png')

assert.equal((await post('/decide', { card_id: card.id, key: 'nope' })).status, 400)
assert.equal((await post('/decide', { card_id: card.id, key: 'pg', note: 'mit Docker' })).status, 200)
await until(() => received.length === 2)
assert.deepEqual(received[1].params, { content: 'mit Docker', meta: { kind: 'decision', card_id: card.id, choice: 'pg' } })
assert.equal((await post('/decide', { card_id: card.id, key: 'sqlite' })).status, 400, 'second decision refused')
s = await state()
assert.deepEqual(s.queue, [], 'a decided card leaves the queue')
await refused('set_urgency', { card_id: card.id, urgency: 'high' }, /only applies to open cards/)
await refused('withdraw_card', { card_id: card.id, reason: 'egal' }, /already decided/)

await call('close_card', { card_id: card.id, summary: 'Postgres eingerichtet' })
s = await state()
assert.equal(s.cards.at(-1).status, 'done')
assert.deepEqual(s.messages.slice(before).map(m => m.from), ['user', 'agent', 'event', 'event', 'event'])
assert.deepEqual(s.messages.slice(before + 2).map(m => m.kind), ['asked', 'decided', 'done'])

// the stack: urgency first, then oldest first
await refused('create_decision', { title: 'x', options: [option('a'), option('b')], urgency: 'urgent' }, /urgency must be one of low, normal, high, critical/)
const normal1 = await ask('normal eins')
const low = await ask('hat Zeit', { urgency: 'low' })
const high = await ask('dringend', { urgency: 'high', urgency_reason: 'blockiert die Aufgabe' })
const normal2 = await ask('normal zwei')
const critical = await ask('blockiert', { urgency: 'critical', urgency_reason: 'nichts geht mehr' })
s = await state()
assert.deepEqual(s.queue, [critical, high, normal1, normal2, low])
assert.deepEqual(s.queue.map(id => s.cards.find(c => c.id === id).number), [9, 7, 5, 8, 6], 'numbers follow creation, not the stack')
assert.equal(s.cards.find(c => c.id === high).urgency_reason, 'blockiert die Aufgabe')

// raising a card moves it up and leaves a marker in the conversation
await call('set_urgency', { card_id: low, urgency: 'critical', reason: 'Deploy wartet' })
s = await state()
assert.deepEqual(s.queue, [low, critical, high, normal1, normal2], 'within a level the older card stays on top')
const raised = s.cards.find(c => c.id === low)
assert.deepEqual([raised.urgency, raised.urgency_reason, raised.number], ['critical', 'Deploy wartet', 6])
const marker = s.messages.at(-1)
assert.deepEqual([marker.from, marker.kind, marker.card_id, marker.text], ['event', 'urgency', low, 'Blockiert: Deploy wartet'])
await call('set_urgency', { card_id: low, urgency: 'critical', reason: 'Deploy wartet immer noch' })
assert.equal((await state()).messages.length, s.messages.length, 'no marker when the level stays the same')
await refused('set_urgency', { card_id: low, urgency: 'asap' }, /urgency must be one of/)
await refused('set_urgency', { card_id: 'nope', urgency: 'low' }, /no card nope/)

const listed = JSON.parse((await call('list_cards', {})).content[0].text)
assert.deepEqual(listed.filter(c => c.queue_position).sort((a, b) => a.queue_position - b.queue_position).map(c => c.id), s.queue)
assert.deepEqual(
  (({ number, urgency, urgency_reason, queue_position, status }) => ({ number, urgency, urgency_reason, queue_position, status }))(listed.find(c => c.id === high)),
  { number: 7, urgency: 'high', urgency_reason: 'blockiert die Aufgabe', queue_position: 3, status: 'open' },
)
assert.equal(listed.find(c => c.id === card.id).queue_position, null)

// withdrawing takes the question off the stack without an answer
await call('withdraw_card', { card_id: normal1, reason: 'hat sich erledigt' })
s = await state()
const withdrawn = s.cards.find(c => c.id === normal1)
assert.deepEqual([withdrawn.status, withdrawn.summary, withdrawn.choice], ['done', 'hat sich erledigt', null])
assert.deepEqual(s.queue, [low, critical, high, normal2])
assert.deepEqual([s.messages.at(-1).kind, s.messages.at(-1).card_id, s.messages.at(-1).text], ['done', normal1, 'Zurückgezogen: hat sich erledigt'])
assert.equal((await post('/decide', { card_id: normal1, key: 'a' })).status, 400, 'a withdrawn card cannot be answered')
await refused('withdraw_card', { card_id: normal1 }, /already done/)

// a decided card leaves the stack, the rest keeps its order
received.length = 0
assert.equal((await post('/decide', { card_id: critical, key: 'a' })).status, 200)
await until(() => received.length === 1)
assert.deepEqual((await state()).queue, [low, high, normal2])
received.length = 0

// permission relay
await client.notification({ method: 'notifications/claude/channel/permission_request', params: {
  request_id: 'abcde', tool_name: 'Bash', description: 'Run shell command', input_preview: '{"command":"npm test"}',
} })
let perm
for (let i = 0; i < 50 && !perm; i++) { perm = (await state()).cards.find(c => c.kind === 'permission' && c.status === 'open'); await new Promise(r => setTimeout(r, 20)) }
assert.ok(perm, 'permission card created')
assert.equal(perm.urgency, 'critical')
assert.equal(perm.number, 10)
s = await state()
assert.deepEqual(s.queue, [perm.id, low, high, normal2], 'an approval goes on top of everything')
await refused('set_urgency', { card_id: perm.id, urgency: 'low' }, /always critical/)
await refused('withdraw_card', { card_id: perm.id }, /cannot be withdrawn/)
assert.equal((await post('/decide', { card_id: perm.id, key: 'allow' })).status, 200)
await until(() => received.length === 1)
assert.equal(received[0].method, 'notifications/claude/channel/permission')
assert.deepEqual(received[0].params, { request_id: 'abcde', behavior: 'allow' })
assert.deepEqual((await state()).queue, [low, high, normal2])

// other sites are refused, and nothing works without the token
assert.equal((await post('/message', { text: 'x' }, 'https://evil.example')).status, 403)
assert.equal((await fetch(`${base}/`)).status, 401)
assert.equal((await fetch(`${base}/events`, { headers: { Cookie: 'board=wrong!' } })).status, 401)
assert.equal((await fetch(`${base}/message`, { method: 'POST', headers: { Origin: base }, body: '{"text":"x"}' })).status, 401)
const login = await fetch(`${base}/?t=secret`, { redirect: 'manual' })
assert.equal(login.status, 302)
assert.match(login.headers.get('set-cookie'), /^board_8791=secret; HttpOnly; SameSite=Lax/)
// a login from before the cookie was named after the port still works
assert.equal((await fetch(`${base}/`, { headers: { Cookie: 'board=secret' } })).status, 200)
assert.equal(fs.readFileSync(path.join(data, 'url.txt'), 'utf8').split('\n')[0], `${base}/?t=secret`)

// taking an answer back: the card returns to the stack and the agent hears about it
const redo = await ask('zum Zurücknehmen', {})
assert.equal((await post('/reopen', { card_id: redo })).status, 400, 'open cards cannot be reopened')
assert.equal((await post('/decide', { card_id: redo, key: 'a' })).status, 200)
received.length = 0
assert.equal((await post('/reopen', { card_id: redo })).status, 200)
await until(() => received.length === 1)
assert.deepEqual(received[0].params.meta, { kind: 'decision_reopened', card_id: redo, previous_choice: 'a' })
s = await state()
assert.deepEqual([s.cards.at(-1).status, s.cards.at(-1).choice, s.queue.includes(redo)], ['open', null, true])
assert.equal(s.messages.at(-1).kind, 'reopened')
assert.equal((await post('/decide', { card_id: redo, key: 'b' })).status, 200)
await call('close_card', { card_id: redo })
assert.equal((await post('/reopen', { card_id: redo })).status, 200, 'done cards can be reopened too')
await call('withdraw_card', { card_id: redo })
assert.equal((await post('/reopen', { card_id: redo })).status, 400, 'withdrawn cards stay closed')
received.length = 0

// scribble: doc and picture are stored, the chat gets an attachment, the agent gets the picture's path
const dot = 'data:image/png;base64,' + fs.readFileSync(shot).toString('base64')
const sent = await post('/scribble', { doc: { v: 1, items: [] }, png: dot, view: dot, text: 'so meine ich das' })
assert.equal(sent.status, 200)
const scribbleId = (await sent.json()).id
await until(() => received.length === 1)
assert.equal(received[0].params.content, 'so meine ich das')
assert.equal(received[0].params.meta.kind, 'scribble')
assert.deepEqual(fs.readFileSync(received[0].params.meta.image_path), fs.readFileSync(shot))
const drawn = (await state()).messages.at(-1)
assert.deepEqual([drawn.from, drawn.attachments[0].kind, drawn.attachments[0].id], ['user', 'scribble', scribbleId])
assert.deepEqual(await (await fetch(`${base}/scribbles/${scribbleId}.json`, { headers: { Cookie: cookie } })).json(), { v: 1, items: [] })
assert.equal((await fetch(base + drawn.attachments[0].url, { headers: { Cookie: cookie } })).headers.get('content-type'), 'image/png')
assert.equal((await post('/scribble', { doc: {}, png: 'data:text/html;base64,AAAA' })).status, 400)
// the canvas itself lasts: the agent is given its picture and its document, and the page can load and save it
assert.deepEqual(fs.readFileSync(received[0].params.meta.canvas_path), fs.readFileSync(shot))
assert.deepEqual(JSON.parse(fs.readFileSync(received[0].params.meta.canvas_doc, 'utf8')), { v: 1, items: [] })
assert.equal((await post('/canvas', { doc: { v: 1, items: ['mehr'] } })).status, 200)
assert.deepEqual(await (await fetch(`${base}/canvas`, { headers: { Cookie: cookie } })).json(), { v: 1, items: ['mehr'] })
// what the agent chooses to show of its reasoning travels with the reply
await call('reply', { text: 'kurz', details: 'lang und **ausführlich**' })
assert.equal((await state()).messages.at(-1).details, 'lang und **ausführlich**')
assert.equal((await fetch(`${base}/scribbles/..%2Ftoken`, { headers: { Cookie: cookie } })).status, 404)
received.length = 0

// speech is optional: without a key the board says so instead of failing oddly
assert.equal((await state()).speech, false)
await refused('create_voiceover', { text: 'hallo' }, /nicht eingerichtet/)
const mute = await fetch(`${base}/speech/transcribe`, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'audio/webm' }, body: 'x' })
assert.equal(mute.status, 400)
assert.match((await mute.json()).error, /nicht eingerichtet/)

// media: a video is stored as such and served with Range support
const clip = path.join(data, 'render.mp4')
fs.writeFileSync(clip, Buffer.alloc(5000, 7))
await call('reply', { text: 'Video', attachments: [clip] })
const video = (await state()).messages.at(-1).attachments[0]
assert.deepEqual([video.kind, video.image, video.size], ['video', false, 5000])
const part = await fetch(base + video.url, { headers: { Cookie: cookie, Range: 'bytes=100-199' } })
assert.equal(part.status, 206)
assert.equal(part.headers.get('content-range'), 'bytes 100-199/5000')
assert.equal(part.headers.get('content-type'), 'video/mp4')
assert.equal((await part.arrayBuffer()).byteLength, 100)
const tail = await fetch(base + video.url, { headers: { Cookie: cookie, Range: 'bytes=-10' } })
assert.equal(tail.headers.get('content-range'), 'bytes 4990-4999/5000')
assert.equal((await fetch(base + video.url, { headers: { Cookie: cookie, Range: 'bytes=9000-' } })).status, 416)

// status strip: upsert, link to a card, and turn yellow when that card is answered
await call('set_status', { id: 'srv', label: 'Server', state: 'working', detail: 'läuft' })
const gate = await ask('für den Status', {})
await call('set_status', { id: 'srv', state: 'decision', card_id: gate })
await call('set_status', { id: 'ui', label: 'Oberfläche', state: 'done' })
s = await state()
assert.deepEqual(s.tasks.map(t => [t.id, t.label, t.state, t.card_id]), [['srv', 'Server', 'decision', gate], ['ui', 'Oberfläche', 'done', null]])
assert.equal(s.tasks[0].detail, 'läuft')
await refused('set_status', { id: 'x', state: 'working' }, /label is required/)
await refused('set_status', { id: 'srv', state: 'red' }, /state must be one of/)
assert.equal((await post('/decide', { card_id: gate, key: 'a' })).status, 200)
await call('close_card', { card_id: gate })
assert.deepEqual((await state()).tasks[0], { ...s.tasks[0], state: 'working', card_id: null, updated: (await state()).tasks[0].updated })
await call('clear_status', { id: 'ui' })
assert.deepEqual((await state()).tasks.map(t => t.id), ['srv'])
received.length = 0

// the stack and the numbering survive a restart
const saved = JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8'))
assert.deepEqual(saved.queue, [low, high, normal2])
assert.equal(saved.next_number, 13)
await client.close()
client = await start()
assert.deepEqual((await state()).queue, [low, high, normal2])
const late = await ask('nach dem Neustart', { urgency: 'high' })
s = await state()
assert.equal(s.cards.at(-1).number, 13)
assert.deepEqual(s.queue, [low, high, late, normal2])

// several agents on one board: the first process is the hub, the others link to it
const gotApi = [], gotInfra = []
const api = await start('API', gotApi)
const infra = await start('Infra', gotInfra)
const apiCard = (await api.callTool({ name: 'create_decision', arguments: { title: 'vom zweiten Agenten', options: [option('a'), option('b')], urgency: 'critical' } }))
  .content[0].text.match(/^card (\w+) /)[1]
await infra.callTool({ name: 'set_status', arguments: { id: 'deploy', label: 'Deploy', state: 'working' } })
s = await state()
assert.deepEqual(s.agents.map(a => [a.id, a.name, a.online]), [['main', 'main', true], ['api', 'API', true], ['infra', 'Infra', true]])
// each agent says where it runs; model and task come from the agent itself
await api.callTool({ name: 'introduce', arguments: { model: 'Claude Test', task: 'prüfen' } })
const me = (await state()).agents[1]
assert.deepEqual([me.host, me.model, me.task, me.client], [os.hostname(), 'Claude Test', 'prüfen', 'test 0'])
assert.equal(s.cards.at(-1).agent, 'api')
assert.ok(s.queue.indexOf(apiCard) < s.queue.indexOf(late), 'one shared stack: the critical card of one agent sits above the high card of another')
assert.deepEqual(s.tasks.filter(t => t.agent === 'infra').map(t => t.id), ['deploy'])
assert.ok(s.messages.every(m => m.agent), 'every message names its agent')
// a session can be starred from the page
assert.equal((await post('/star', { agent: 'api', starred: true })).status, 200)
assert.equal((await state()).agents[1].starred, true)
assert.equal((await post('/session', { agent: 'api', label: 'Schnittstelle', icon: 'api:3' })).status, 200)
assert.deepEqual([(await state()).agents[1].label, (await state()).agents[1].icon, (await state()).agents[1].name], ['Schnittstelle', 'api:3', 'API'])
// agents are fenced off from each other
await refused('close_card', { card_id: apiCard }, /no card/)
assert.equal(JSON.parse((await infra.callTool({ name: 'list_cards', arguments: {} })).content[0].text).length, 0)
// the page must say whom it is talking to, and only that agent hears it
received.length = 0
assert.equal((await post('/message', { text: 'an wen?' })).status, 400)
assert.equal((await post('/message', { text: 'nur Infra', agent: 'infra' })).status, 200)
assert.equal((await post('/decide', { card_id: apiCard, key: 'b' })).status, 200)
for (let i = 0; i < 50 && !(gotInfra.length && gotApi.length); i++) await new Promise(r => setTimeout(r, 20))
assert.deepEqual(gotInfra.map(n => n.params.content), ['nur Infra'])
assert.deepEqual(gotApi.map(n => n.params.meta), [{ kind: 'decision', card_id: apiCard, choice: 'b' }])
assert.equal(received.length, 0)
// a spoke's approval request becomes its own card, and the verdict goes back to it
await api.notification({ method: 'notifications/claude/channel/permission_request', params: { request_id: 'spoke', tool_name: 'Bash', description: 'd', input_preview: 'p' } })
let spokePerm
for (let i = 0; i < 50 && !spokePerm; i++) { spokePerm = (await state()).cards.find(c => c.request_id === 'spoke'); await new Promise(r => setTimeout(r, 20)) }
assert.equal(spokePerm.agent, 'api')
assert.equal((await post('/decide', { card_id: spokePerm.id, key: 'deny' })).status, 200)
for (let i = 0; i < 50 && gotApi.length < 2; i++) await new Promise(r => setTimeout(r, 20))
assert.deepEqual(gotApi[1].params, { request_id: 'spoke', behavior: 'deny' })

// the hub's session ends: a spoke takes the port over and nothing is lost
await client.close()
let after
for (let i = 0; i < 100; i++) {
  await new Promise(r => setTimeout(r, 50))
  try {
    after = await state()
    if (after.agents.filter(a => a.online).length === 2) break
  } catch {}
}
assert.deepEqual(after.agents.map(a => [a.id, a.online]), [['main', false], ['api', true], ['infra', true]])
assert.equal(after.cards.length, s.cards.length + 1)
gotApi.length = gotInfra.length = 0
assert.equal((await post('/message', { text: 'noch da?', agent: 'api' })).status, 200)
assert.equal((await post('/message', { text: 'und du?', agent: 'infra' })).status, 200)
for (let i = 0; i < 50 && !(gotInfra.length && gotApi.length); i++) await new Promise(r => setTimeout(r, 20))
assert.deepEqual([gotApi[0].params.content, gotInfra[0].params.content], ['noch da?', 'und du?'])
// a message for an agent that is away waits for it
assert.equal((await post('/message', { text: 'für später', agent: 'main' })).status, 200)
received.length = 0
client = await start()
await until(() => received.length === 1)
assert.equal(received[0].params.content, 'für später')

await Promise.all([client.close(), api.close(), infra.close()])

// cleanup: an answered card older than the limit goes with its attachment and its markers; open ones stay
await new Promise(r => setTimeout(r, 300))
const kept = JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8'))
const days = n => Date.now() - n * 86400000
fs.writeFileSync(path.join(data, 'files', 'old.png'), 'x')
fs.writeFileSync(path.join(data, 'files', 'young.png'), 'x')
const aged = (id, status, decided, file) => ({ ...oldCard(id, status, days(40), { decided, choice: decided ? 'a' : null }), agent: 'main', number: 900, attachments: [{ name: file, url: `/files/${file}`, kind: 'image', image: true }] })
fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({
  ...kept,
  cards: [aged('gone', 'done', days(31), 'old.png'), aged('recent', 'done', days(29), 'young.png'), aged('waiting', 'open', null, 'young.png')],
  messages: [{ id: 'e1', agent: 'main', from: 'event', kind: 'done', card_id: 'gone', text: 'x', ts: 1 }, { id: 'e2', agent: 'main', from: 'event', kind: 'done', card_id: 'recent', text: 'x', ts: 2 }],
}))
process.env.BOARD_RETENTION_DAYS = '30'
client = await start()
s = await state()
assert.deepEqual(s.cards.map(c => c.id), ['recent', 'waiting'])
assert.deepEqual(s.messages.map(m => m.id), ['e2'])
assert.equal(fs.existsSync(path.join(data, 'files', 'old.png')), false)
assert.equal(fs.existsSync(path.join(data, 'files', 'young.png')), true)
await client.close()
fs.rmSync(data, { recursive: true })
console.log('ok: chat, decision, attachment, urgency stack, status strip, undo, scribble, media, numbering, withdraw, migration, restart, several agents, hub takeover, cleanup after 30 days, permission relay, token and origin check')
process.exit(0)
