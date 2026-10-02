// End-to-end check: act as Claude Code over stdio and as the browser over HTTP.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath as toPath } from 'node:url'

// Run from anywhere: the server is the file next to this test.
const SERVER = toPath(new URL('./server.mjs', import.meta.url))

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
// What the servers write to stderr, to check what they did and how often.
const logs = []
const serverEnv = (name, env) => ({ ...process.env, BOARD_PORT: String(PORT), BOARD_DATA: data, BOARD_TOKEN: 'secret', BOARD_AGENT: name, TINFOIL_API_KEY: '', ...env })
async function start(name = 'main', sink = received, env = {}) {
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} })
  client.fallbackNotificationHandler = async n => { sink.push(n) }
  const transport = new StdioClientTransport({ command: 'node', args: [SERVER], env: serverEnv(name, env), stderr: 'pipe' })
  transport.stderr.on('data', chunk => {
    logs.push(...String(chunk).split('\n').filter(Boolean))
    process.stderr.write(chunk)
  })
  await client.connect(transport)
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
const sleep = ms => new Promise(r => setTimeout(r, ms))
// Like until, for things that take a moment longer and need a look at the server.
const eventually = async (test, what) => {
  for (let i = 0; i < 150; i++) {
    try { if (await test()) return } catch {}
    await sleep(40)
  }
  assert.fail(`timed out waiting for ${what}`)
}
// A tool call by any session that must be refused, whichever way the SDK reports it.
const fails = async (who, name, args, pattern) => {
  let message
  try {
    const res = await who.callTool({ name, arguments: args })
    assert.ok(res.isError, `${name} should have been refused`)
    message = res.content[0].text
  } catch (err) {
    message = err.message
  }
  assert.match(message, pattern)
}
const agentPost = (route, body, token = 'secret') => fetch(`http://127.0.0.1:${PORT}${route}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-board-token': token }, body: JSON.stringify(body),
})

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
await refused('close_card', { card_id: perm.id }, /cannot be closed/)
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

// malformed input is refused and never takes the server down
const rawGet = reqPath => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: PORT, path: reqPath }, res => { res.resume(); resolve(res.statusCode) }).on('error', reject)
})
assert.equal(await rawGet('//'), 400, 'a request line that is no URL is answered, not thrown')
const rawPost = (url, text) => fetch(base + url, { method: 'POST', headers: { Origin: base, Cookie: cookie }, body: text })
assert.equal((await rawPost('/message', 'null')).status, 400)
assert.equal((await rawPost('/message', '{"text":')).status, 400)
assert.equal((await rawPost('/decide', '[]')).status, 400)
assert.equal((await rawPost('/message', JSON.stringify({ text: 'x'.repeat(2e6) }))).status, 400)
await refused('reply', { text: 'x', attachments: 'kein Feld' }, /attachments must be a list/)
await refused('reply', { text: 'x', attachments: [7] }, /path of a file/)
await refused('create_decision', { title: 'x', options: [null, null] }, /unique keys/)
await refused('create_decision', { title: 'x', options: 'a,b' }, /options must be a list/)
// a refused status line leaves nothing behind
await refused('set_status', { id: 'halb', label: 'Halb', state: 'decision', card_id: 'nope' }, /no card nope/)
await call('set_status', { id: 'ganz', label: 'Ganz', state: 'working' })
assert.deepEqual((await state()).tasks.map(t => t.id), ['ganz'])
await call('clear_status', {})
// the routes for spokes need the token, and an agent that is linked
assert.equal((await fetch(`http://127.0.0.1:${PORT}/agent/link?name=x`)).status, 403)
assert.equal((await agentPost('/agent/tool', { id: 'main', name: 'reply', args: { text: 'x' } }, 'wrong')).status, 403)
assert.equal((await agentPost('/agent/tool', { id: 'nobody', name: 'reply', args: { text: 'x' } })).status, 409)
assert.equal((await agentPost('/agent/tool', null)).status, 409)
// the hub's own agent cannot be spoken for by someone who merely knows its id
assert.equal((await agentPost('/agent/tool', { id: 'main', name: 'reply', args: { text: 'x' } })).status, 409)
assert.equal((await state()).messages.some(m => m.text === 'x'), false)
// the state file is replaced whole, and only its owner may read it
assert.equal(fs.statSync(path.join(data, 'state.json')).mode & 0o077, 0)
assert.deepEqual(fs.readdirSync(data).filter(f => f.includes('.tmp')), [])

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

// a spoke is known by more than its id: another process cannot act under it
assert.equal((await agentPost('/agent/tool', { id: 'api', instance: 'falsch', name: 'reply', args: { text: 'untergeschoben' } })).status, 409)
assert.equal((await state()).messages.some(m => m.text === 'untergeschoben'), false)

// the hub's session ends: a spoke takes the port over and nothing is lost
let mark = logs.length
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
assert.equal(logs.slice(mark).filter(l => l.includes('] hub on ')).length, 1, 'exactly one spoke became the hub, once')
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

// ---- a second board, to look at who is who and at what waits for whom ----
const portFree = () => eventually(() => fetch(base).then(() => false, () => true), 'the port to be free')
await portFree()
const data2 = fs.mkdtempSync(path.join(os.tmpdir(), 'board-test-'))
const on2 = { BOARD_DATA: data2 }
const file2 = () => JSON.parse(fs.readFileSync(path.join(data2, 'state.json'), 'utf8'))
const say = (who, name, args) => who.callTool({ name, arguments: args })
const got1 = [], got2 = [], gotAway = []
const hub = await start('Hub', [], on2)
await say(hub, 'introduce', { model: 'm', task: 'hub' })
// two sessions in the same folder: the first is "twin", the second "twin-2"
const twin1 = await start('Twin', got1, on2)
await say(twin1, 'introduce', { model: 'm', task: 'eins' })
const twin2 = await start('Twin', got2, on2)
await say(twin2, 'introduce', { model: 'm', task: 'zwei' })
let away = await start('Away', gotAway, on2)
await say(away, 'introduce', { model: 'm', task: 'weg' })
s = await state()
assert.deepEqual(s.agents.map(a => [a.id, a.task]), [['hub', 'hub'], ['twin', 'eins'], ['twin-2', 'zwei'], ['away', 'weg']])
assert.equal(s.hub, 'hub')

// what an away agent missed is kept in the state file, the newest hundred of it, and is not sent to the page
await away.close()
await eventually(async () => !(await state()).agents[3].online, 'the away agent to be seen as gone')
for (let i = 1; i <= 105; i++) assert.equal((await post('/message', { text: `m${i}`, agent: 'away' })).status, 200)
assert.deepEqual([file2().pending.away.length, file2().pending.away[0].params.content, file2().pending.away.at(-1).params.content], [100, 'm6', 'm105'])
assert.equal('pending' in (await state()), false)

// the hub dies: calls made in the gap fail fast with a message that says to retry, or succeed; none hangs
mark = logs.length
await hub.close()
for (let done = false, tries = 0; !done; tries++) {
  assert.ok(tries < 40, 'the spoke never got its link back')
  const began = Date.now()
  try {
    const res = await say(twin1, 'list_cards', {})
    assert.ok(!res.isError)
    done = true
  } catch (err) {
    assert.match(err.message, /try again in a moment/)
    await sleep(50)
  }
  assert.ok(Date.now() - began < 7000, 'a call during the takeover was answered in time')
}
// whoever won the port, both twins are who they were
await say(twin1, 'reply', { text: 'ich bin eins' })
await say(twin2, 'reply', { text: 'ich bin zwei' })
s = await state()
assert.deepEqual(s.messages.filter(m => m.from === 'agent').map(m => [m.agent, m.text]), [['twin', 'ich bin eins'], ['twin-2', 'ich bin zwei']])
assert.deepEqual(s.agents.map(a => [a.id, a.task, a.online]), [['hub', 'hub', false], ['twin', 'eins', true], ['twin-2', 'zwei', true], ['away', 'weg', false]])
assert.ok(['twin', 'twin-2'].includes(s.hub))
assert.equal(logs.slice(mark).filter(l => l.includes('] hub on ')).length, 1)
got1.length = got2.length = 0
assert.equal((await post('/message', { text: 'an zwei', agent: 'twin-2' })).status, 200)
await until(() => got2.length === 1)
assert.equal(got1.length, 0)

// the queue outlived the old hub; the agent gets all of it, in order, when it returns
assert.equal(file2().pending.away.length, 100)
away = await start('Away', gotAway, on2)
await eventually(() => gotAway.length === 100, 'the queued messages')
assert.deepEqual([gotAway[0].params.content, gotAway[99].params.content], ['m6', 'm105'])
assert.equal(file2().pending.away, undefined)
assert.equal((await state()).agents.find(a => a.id === 'away').online, true, 'a new process in the folder takes the folder\'s id when nobody holds it')

// it also outlives the end of every session, and nothing is sent before the MCP handshake is done
assert.equal((await post('/message', { text: 'für den Hub', agent: 'hub' })).status, 200)
await Promise.all([twin1.close(), twin2.close(), away.close()])
await portFree()
assert.equal(file2().pending.hub[0].params.content, 'für den Hub')
const raw = spawn('node', [SERVER], { env: serverEnv('Hub', on2), stdio: ['pipe', 'pipe', 'inherit'] })
const lines = []
let partial = ''
raw.stdout.on('data', chunk => {
  partial += chunk
  const parts = partial.split('\n')
  partial = parts.pop()
  lines.push(...parts.filter(Boolean).map(l => JSON.parse(l)))
})
await eventually(async () => (await state()).agents[0].online, 'the raw session to be the hub')
await sleep(200)
assert.deepEqual(lines, [], 'nothing reaches Claude Code before it has initialised')
raw.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } }) + '\n')
await eventually(() => lines.length === 1, 'the answer to initialize')
raw.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
await eventually(() => lines.length === 2, 'the message that waited')
assert.deepEqual(lines[1].params, { content: 'für den Hub', meta: { kind: 'chat' } })
assert.equal(file2().pending.hub, undefined)
raw.stdin.end()
await portFree()

// ---- a hub that accepts the link but never answers: the spoke gives up, says so, and tries again ----
let linkTries = 0, greet = false
const stuck = http.createServer((req, res) => {
  if (req.url.startsWith('/agent/link')) {
    linkTries++
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(greet ? `data: ${JSON.stringify({ hello: 'ghost', ping: 100 })}\n\n` : ': nichts\n\n')
  }
})
await new Promise(resolve => stuck.listen(PORT, '127.0.0.1', resolve))
const ghost = await start('Ghost', [], { ...on2, BOARD_HUB_TIMEOUT_MS: '400' })
let began = Date.now()
await fails(ghost, 'list_cards', {}, /try again in a moment/)
assert.ok(Date.now() - began < 3000, 'a call without a link fails instead of waiting for ever')
await eventually(() => linkTries >= 2, 'a second attempt after a link that never said hello')
greet = true
const seen = linkTries
began = Date.now()
await eventually(async () => {
  try { await say(ghost, 'list_cards', {}) } catch (err) { return /did not answer within/.test(err.message) }
}, 'a call to a silent hub to time out')
assert.ok(Date.now() - began < 5000)
await eventually(() => linkTries >= seen + 2, 'the spoke to drop a link that went silent')
await ghost.close()
stuck.closeAllConnections()
await new Promise(resolve => stuck.close(resolve))
await portFree()

// ---- two sessions start at the same moment on an empty data directory whose state file is damaged ----
const data3 = fs.mkdtempSync(path.join(os.tmpdir(), 'board-test-'))
fs.writeFileSync(path.join(data3, 'state.json'), '{"cards": [{"id": "halb')
const on3 = { BOARD_DATA: data3, BOARD_TOKEN: '' }
const pair = await Promise.all([start('Eins', [], on3), start('Zwei', [], on3)])
await Promise.all(pair.map(c => say(c, 'introduce', { model: 'm' })))
// both agree on one token, so the one that lost the port could link
const token3 = fs.readFileSync(path.join(data3, 'token'), 'utf8')
const res3 = await fetch(`${base}/events`, { headers: { Cookie: `board_8791=${token3}` } })
const reader3 = res3.body.getReader()
const state3 = JSON.parse(new TextDecoder().decode((await reader3.read()).value).replace(/^data: /, ''))
await reader3.cancel()
assert.deepEqual(state3.agents.map(a => [a.model, a.online]), [['m', true], ['m', true]])
assert.deepEqual(fs.readdirSync(data3).filter(f => f.startsWith('token')), ['token'])
// the damaged file was put aside, not overwritten
const aside = fs.readdirSync(data3).filter(f => f.startsWith('state.broken-'))
assert.equal(aside.length, 1)
assert.equal(fs.readFileSync(path.join(data3, aside[0]), 'utf8'), '{"cards": [{"id": "halb')
await Promise.all(pair.map(c => c.close()))

for (const dir of [data, data2, data3]) fs.rmSync(dir, { recursive: true })
console.log('ok: chat, decision, attachment, urgency stack, status strip, undo, scribble, media, numbering, withdraw, migration, restart, several agents, hub takeover, cleanup after 30 days, permission relay, token and origin check, malformed input, stable agent ids, queue for away agents across hub changes, calls during a takeover, silent hub, simultaneous start, damaged state file')
process.exit(0)
