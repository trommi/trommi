// End-to-end check: act as Claude Code over stdio and as the browser over HTTP.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import crypto from 'node:crypto'
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
// Every notification any session got, to compare with what the help page says arrives.
const heard = []
// What the servers write to stderr, to check what they did and how often.
const logs = []
const serverEnv = (name, env) => ({ ...process.env, BOARD_PORT: String(PORT), BOARD_DATA: data, BOARD_TOKEN: 'secret', BOARD_AGENT: name, BOARD_ADMIN_TOKEN: 'adminkey', BOARD_PUBLIC_URL: '', TINFOIL_API_KEY: '', ...env })
async function start(name = 'main', sink = received, env = {}) {
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} })
  client.fallbackNotificationHandler = async n => { sink.push(n); heard.push(n) }
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
const state = async (as = cookie) => {
  const res = await fetch(`${base}/events`, { headers: { Cookie: as } })
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
  ['reply', 'create_decision', 'set_urgency', 'withdraw_card', 'close_card', 'set_status', 'clear_status', 'introduce', 'create_voiceover', 'list_cards', 'publish_asset', 'list_assets', 'revoke_asset'],
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
assert.deepEqual([marker.from, marker.kind, marker.card_id, marker.text], ['event', 'urgency', low, 'Blocking: Deploy wartet'])
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
assert.deepEqual([s.messages.at(-1).kind, s.messages.at(-1).card_id, s.messages.at(-1).text], ['done', normal1, 'Withdrawn: hat sich erledigt'])
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
// the page keeps its place in the address: those paths are the page, behind the login, and the login keeps path and query
const home = await (await fetch(`${base}/`, { headers: { Cookie: cookie } })).text()
for (const place of ['/s/api', '/s/api/fragen', '/agents', '/inbox']) {
  assert.equal((await fetch(base + place)).status, 401, place)
  const there = await fetch(base + place, { headers: { Cookie: cookie } })
  assert.deepEqual([there.status, there.headers.get('content-type'), await there.text()], [200, 'text/html; charset=utf-8', home], place)
}
for (const place of ['/sonstwo', '/agents/x', '/s', '/inbox.php']) assert.equal((await fetch(base + place, { headers: { Cookie: cookie } })).status, 404, place)
// whatever else lies in the web client is served behind the login: nested files, a folder's index; no dotfiles, no way out, no other kinds
const web = toPath(new URL('../client/web/', import.meta.url))
const nest = path.join(web, `test-static-${process.pid}`)
process.on('exit', () => fs.rmSync(nest, { recursive: true, force: true }))
fs.mkdirSync(path.join(nest, 'src', '.git'), { recursive: true })
for (const [name, text] of [['index.html', '<p>Mappe</p>'], ['src/stil.css', 'p{}'], ['src/daten.json', '{"a":1}'], ['src/bild.svg', '<svg/>'], ['src/modul.mjs', 'export {}'], ['.geheim.html', 'x'], ['src/.git/config.json', '{}'], ['notiz.txt', 'x'], ['skript.sh', 'x']]) fs.writeFileSync(path.join(nest, name), text)
fs.symlinkSync(path.join(data, 'state.json'), path.join(nest, 'zustand.json'))
const under = async (rel, as = cookie) => {
  const res = await fetch(`${base}/${path.basename(nest)}${rel}`, { headers: { Cookie: as }, redirect: 'manual' })
  return [res.status, res.headers.get('content-type'), res.status === 200 ? await res.text() : res.headers.get('location')]
}
assert.deepEqual(await under('/src/stil.css'), [200, 'text/css; charset=utf-8', 'p{}'])
assert.deepEqual(await under('/src/daten.json'), [200, 'application/json', '{"a":1}'])
assert.deepEqual(await under('/src/bild.svg'), [200, 'image/svg+xml', '<svg/>'])
assert.deepEqual(await under('/src/modul.mjs'), [200, 'text/javascript; charset=utf-8', 'export {}'])
assert.deepEqual(await under('/'), [200, 'text/html; charset=utf-8', '<p>Mappe</p>'])
assert.deepEqual(await under('/index.html'), [200, 'text/html; charset=utf-8', '<p>Mappe</p>'])
assert.deepEqual(await under('?x=1'), [302, null, `/${path.basename(nest)}/?x=1`])
assert.equal((await under('/src/stil.css', 'board_8791=falsch'))[0], 401)
for (const no of ['/.geheim.html', '/src/.git/config.json', '/notiz.txt', '/skript.sh', '/zustand.json', '/src/', '/src', '/fehlt.html', '/src/..%2F..%2F..%2F..%2Fpackage.json', '/%2e%2e/%2e%2e/%2e%2e/package.json', '/..%5C..%5Cpackage.json', '/%00.html', '/%zz']) {
  assert.equal((await under(no))[0], 404, no)
}
assert.equal((await fetch(`${base}/css/tokens.css`, { headers: { Cookie: cookie } })).headers.get('content-type'), 'text/css; charset=utf-8')
// routes keep precedence over files
assert.equal((await fetch(`${base}/events/`, { headers: { Cookie: cookie } })).status, 404)
const landing = async link => (await fetch(base + link, { redirect: 'manual' })).headers.get('location')
assert.equal(await landing('/s/api?q=abc12345&t=secret&x=1'), '/s/api?q=abc12345&x=1')
assert.equal(await landing('/inbox?t=secret'), '/inbox')
assert.equal(await landing('/?t=secret'), '/')
assert.equal((await fetch(`${base}/s/api?q=abc&t=falsch`, { redirect: 'manual' })).status, 401)

// the admin routes want a key of their own on top of the login, and a pinned token is not rotated
const adminGet = (route, as) => fetch(`${base}/admin/api/${route}`, { headers: { Cookie: as } })
const adminPost = (route, body, as, origin = base) => fetch(`${base}/admin/api/${route}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: as }, body: JSON.stringify(body),
})
const adminLogin = async (key, as) => {
  const res = await adminPost('login', { key }, as)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('set-cookie'), /^board_admin_8791=[\w-]{32}; HttpOnly; SameSite=Strict; Path=\/admin; Max-Age=43200$/)
  return `${as}; ${res.headers.get('set-cookie').split(';')[0]}`
}
assert.equal((await adminGet('overview', cookie)).status, 403)
const pinned = await adminLogin('adminkey', cookie)
assert.equal((await adminGet('overview', pinned)).status, 200)
const kept1 = await adminPost('token/rotate', { confirm: 'rotate' }, pinned)
assert.equal(kept1.status, 409)
assert.match((await kept1.json()).error, /BOARD_TOKEN/)
assert.equal((await fetch(`${base}/`, { headers: { Cookie: cookie } })).status, 200)
assert.equal((await adminPost('logout', {}, pinned)).status, 200)
assert.equal((await adminGet('overview', pinned)).status, 403, 'a logout ends the admin session on the server')

// malformed input is refused and never takes the server down
const rawGet = reqPath => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: PORT, path: reqPath }, res => { res.resume(); resolve(res.statusCode) }).on('error', reject)
})
assert.equal(await rawGet('//'), 400, 'a request line that is no URL is answered, not thrown')
assert.equal(await rawGet('/css/../../../package.json'), 401, 'dots in a raw request line lead nowhere')
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
// a proxy on this machine speaks for someone elsewhere: with its headers the right token opens nothing here
for (const header of ['X-Forwarded-For', 'Tailscale-User-Login']) {
  const through = { 'Content-Type': 'application/json', 'x-board-token': 'secret', [header]: '100.64.0.7' }
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/agent/tool`, { method: 'POST', headers: through, body: '{"id":"nobody"}' })).status, 403, header)
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/agent/link?name=x`, { headers: through })).status, 403, header)
}
assert.deepEqual((await state()).agents.map(a => a.id), ['main'])
// the health check needs no login and says nothing but that the hub answers
const health = await fetch(`${base}/healthz`)
assert.deepEqual([health.status, await health.text()], [200, '{"ok":true}'])
assert.equal((await fetch(`${base}/healthz`, { method: 'POST', headers: { Origin: base }, body: '{}' })).status, 401)
// the hub's own agent cannot be spoken for by someone who merely knows its id
assert.equal((await agentPost('/agent/tool', { id: 'main', name: 'reply', args: { text: 'x' } })).status, 409)
assert.equal((await state()).messages.some(m => m.text === 'x'), false)
// the state file is replaced whole, and only its owner may read it
assert.equal(fs.statSync(path.join(data, 'state.json')).mode & 0o077, 0)
assert.deepEqual(fs.readdirSync(data).filter(f => f.includes('.tmp')), [])

// the agent's advice travels with the card and must name a real option
const advised = await ask('mit Empfehlung', { recommended: 'b' })
assert.equal((await state()).cards.find(c => c.id === advised).recommended, 'b')
await refused('create_decision', { title: 'x', options: [option('a'), option('b')], recommended: 'zzz' }, /recommended must be/)
await call('withdraw_card', { card_id: advised })

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
await refused('create_voiceover', { text: 'hallo' }, /not set up/)
const mute = await fetch(`${base}/speech/transcribe`, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'audio/webm' }, body: 'x' })
assert.equal(mute.status, 400)
assert.match((await mute.json()).error, /not set up/)

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

// ---- assets: encrypted beside the agent, stored as ciphertext, opened with the key behind the # ----
// Opens a blob the way the viewer does, with WebCrypto.
const openAsset = async (blob, key, id) => {
  assert.equal(blob.subarray(0, 4).toString(), 'ZWA1')
  const aes = await crypto.subtle.importKey('raw', Buffer.from(key, 'base64url'), 'AES-GCM', false, ['decrypt'])
  const plain = Buffer.from(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.subarray(4, 16), additionalData: Buffer.from(`ZWA1/${id}`) }, aes, blob.subarray(16)))
  const n = plain.readUInt32BE(0)
  const header = JSON.parse(plain.subarray(4, 4 + n))
  return { header, content: plain.subarray(4 + n, 4 + n + header.size), padding: plain.subarray(4 + n + header.size) }
}
const linkOf = said => said.match(/http:\/\/localhost:8791\/a\/([\w-]{22})#([\w-]{43})(?=\s|$)/).slice(1)
const publish = async (who, args) => (await who.callTool({ name: 'publish_asset', arguments: args })).content[0].text
const blobOf = async id => Buffer.from(await (await fetch(`${base}/a/${id}/blob`)).arrayBuffer())
const page = path.join(data, 'bericht.html')
const html = '<!doctype html><title>Bericht</title><h1>Geheimer Bericht 4711</h1>'
fs.writeFileSync(page, html)
const talk = (await state()).messages.length
const said = await publish(client, { path: page, title: 'Lasttest', note: 'drei Varianten' })
const [aid, akey] = linkOf(said)
assert.match(said, new RegExp(`^asset ${aid} published \\(html, \\d+ bytes encrypted, deleted after 100000 days\\)`))
assert.match(said, /Shown in the conversation/)
s = await state()
const stored = fs.readFileSync(path.join(data, 'assets', aid))
// the record names no key and keeps the slot for the room key; the message is what shows the link today
assert.deepEqual({ ...s.assets.at(-1), created: 0 }, { id: aid, agent: 'main', type: 'html', title: 'Lasttest', size: stored.length, created: 0, keep: false, silent: false, wrapped_key: null })
assert.deepEqual([s.messages.length, s.messages.at(-1).from, s.messages.at(-1).text], [talk + 1, 'agent', `**Lasttest** (HTML page)\n\ndrei Varianten\n\n${base}/a/${aid}#${akey}`])
assert.deepEqual(s.messages.at(-1).asset, { id: aid, type: 'html', title: 'Lasttest', note: 'drei Varianten', url: `/a/${aid}#${akey}`, size: stored.length })
// what lies on disk is not the page and holds neither key nor title
assert.equal(fs.statSync(path.join(data, 'assets', aid)).mode & 0o077, 0)
for (const clear of ['Geheimer Bericht', 'Lasttest', 'bericht.html', akey]) assert.ok(!stored.includes(clear), `the stored asset holds "${clear}"`)
assert.ok(!stored.includes(Buffer.from(akey, 'base64url')))
// the blob is served without a login, and it is the same ciphertext
const served = await fetch(`${base}/a/${aid}/blob`)
assert.deepEqual([served.status, served.headers.get('content-type'), served.headers.get('cache-control'), served.headers.get('x-content-type-options')], [200, 'application/octet-stream', 'no-store', 'nosniff'])
assert.deepEqual(Buffer.from(await served.arrayBuffer()), stored)
// with the key from the link it opens: the bytes, and what the envelope says about them
const opened = await openAsset(stored, akey, aid)
assert.deepEqual({ ...opened.header, created: 0 }, { v: 1, type: 'html', title: 'Lasttest', name: 'bericht.html', mime: 'text/html', size: html.length, created: 0 })
assert.equal(opened.content.toString(), html)
assert.ok(opened.padding.length > 500 && opened.padding.every(b => b === 0), 'a small asset is padded to a step')
assert.equal(stored.length, 4 + 12 + 1024 + 16)
// not with another key, not under another address, and not when a byte was changed
await assert.rejects(openAsset(stored, crypto.randomBytes(32).toString('base64url'), aid))
await assert.rejects(openAsset(stored, akey, 'A'.repeat(22)))
const bent = Buffer.from(stored)
bent[40] ^= 1
await assert.rejects(openAsset(bent, akey, aid))
// the viewer is served without a login too, under a policy that lets it load only itself
const viewer = await fetch(`${base}/a/${aid}`)
const policy = viewer.headers.get('content-security-policy')
assert.deepEqual([viewer.status, viewer.headers.get('content-type'), viewer.headers.get('referrer-policy')], [200, 'text/html; charset=utf-8', 'no-referrer'])
for (const rule of ["default-src 'none'", "script-src 'self'", "frame-ancestors 'none'", "form-action 'none'", "base-uri 'none'"]) assert.ok(policy.includes(rule), rule)
assert.ok(!/unsafe|https?:|\*/.test(policy), 'nothing inline and nothing foreign in the viewer')
assert.ok(!(await viewer.text()).includes(akey))
for (const file of ['asset.js', 'asset.css', 'tokens.css']) assert.equal((await fetch(`${base}/a/-/${file}`)).status, 200, file)
// an HTML asset runs in a frame with a policy of its own: its own scripts, no network, no origin
const frame = await fetch(`${base}/a/-/frame.html`)
const framed = frame.headers.get('content-security-policy')
assert.equal(frame.status, 200)
for (const rule of ["default-src 'none'", 'sandbox allow-scripts', "frame-ancestors 'self'", "form-action 'none'"]) assert.ok(framed.includes(rule), rule)
assert.ok(!/allow-same-origin|allow-top|allow-popups|allow-forms|connect-src|https?:|\*/.test(framed))
// the same page answers for any address, so it does not say which assets exist; the blob does
assert.equal((await fetch(`${base}/a/${'A'.repeat(22)}`)).status, 200)
assert.equal((await fetch(`${base}/a/${'A'.repeat(22)}/blob`)).status, 404)
// everything else still wants the login
for (const closed of ['/', '/a.html', '/js/asset.js', '/css/tokens.css', '/events', '/api/tools', '/help.html', '/files/x.png', '/a', '/assets']) assert.equal((await fetch(base + closed)).status, 401, closed)
// no path out of the folder, nothing but GET, nothing but the three files
for (const odd of ['/a/..%2Ftoken/blob', '/a/..%2F..%2Fstate.json', '/a/-/..%2F..%2Findex.html', '/a/-/app.js', '/a/-/constructor', `/a/${aid}/blob/x`, `/a/${aid}/`, '/a/token/blob', `/a/${aid}%00/blob`, '/a/-/']) {
  assert.equal((await fetch(base + odd)).status, 404, odd)
}
assert.notEqual(await rawGet(`/a/${aid}/../../token`), 200)
assert.equal((await fetch(`${base}/a/${aid}/blob`, { method: 'POST', headers: { Origin: base }, body: 'x' })).status, 404)

// a silent asset: the hub is told neither key nor title nor type, and nothing appears on the board
const hush = await publish(client, { content: '<p>nur für dich 0815</p>', title: 'Stiller Titel', silent: true, keep: true })
const [qid, qkey] = linkOf(hush)
assert.match(hush, /kept until revoked[\s\S]*The hub never saw the key/)
s = await state()
assert.equal(s.messages.length, talk + 1)
assert.deepEqual({ ...s.assets.at(-1), created: 0, size: 0 }, { id: qid, agent: 'main', type: null, title: '', size: 0, created: 0, keep: true, silent: true, wrapped_key: null })
const quiet = await openAsset(await blobOf(qid), qkey, qid)
assert.deepEqual([quiet.header.type, quiet.header.title, quiet.header.name, quiet.content.toString()], ['html', 'Stiller Titel', 'page.html', '<p>nur für dich 0815</p>'])
// the type follows the file, and bytes come back as they went in
const [pid, pkey] = linkOf(await publish(client, { path: shot }))
const picture = await openAsset(await blobOf(pid), pkey, pid)
assert.deepEqual([picture.header.type, picture.header.mime, picture.header.title, picture.content.equals(fs.readFileSync(shot))], ['image', 'image/png', 'mock.png', true])
// neither the state, as the page gets it and as it lies on disk, nor the admin export knows the silent key or title;
// the key of an asset shown on the board is in all three today, in the message that carries the link
const exportA = await adminLogin('adminkey', cookie)
const known = [JSON.stringify(await state()), fs.readFileSync(path.join(data, 'state.json'), 'utf8'), await (await adminGet('export', exportA)).text()]
for (const place of known) {
  for (const hidden of [qkey, 'Stiller Titel', '0815']) assert.ok(!place.includes(hidden), `the hub knows "${hidden}"`)
  assert.ok(place.includes(qid) && place.includes(akey))
}
assert.equal((await adminPost('logout', {}, exportA)).status, 200)
const mine = JSON.parse((await call('list_assets', {})).content[0].text)
assert.deepEqual(mine.map(a => [a.id, a.type, a.title, a.silent, a.link, a.expires === null]), [
  [aid, 'html', 'Lasttest', false, `${base}/a/${aid}#${akey}`, false], [qid, null, '', true, null, true], [pid, 'image', 'mock.png', false, `${base}/a/${pid}#${pkey}`, false],
])
await refused('publish_asset', {}, /either path .* or content/)
await refused('publish_asset', { path: page, content: 'x' }, /either path .* or content/)
await refused('publish_asset', { content: 'x', type: 'pdf' }, /type must be one of html, image, video, audio, file/)
await refused('publish_asset', { path: path.join(data, 'gibt-es-nicht.html') }, /ENOENT/)
await refused('publish_asset', { path: data }, /not a file/)
assert.equal((await state()).assets.length, 3, 'a refused call stores nothing')
// the spokes' route: not without the token, not for a session that is not linked, and never a blob that is none
const upload = (query, body, token = 'secret') => fetch(`http://127.0.0.1:${PORT}/agent/asset?${query}`, { method: 'POST', headers: { 'x-board-token': token, 'x-asset': Buffer.from(JSON.stringify({ id: 'B'.repeat(22), silent: true })).toString('base64url') }, body })
assert.equal((await upload('id=main', 'ZWA1' + 'x'.repeat(40), 'wrong')).status, 403)
assert.equal((await upload('id=nobody', 'ZWA1' + 'x'.repeat(40))).status, 409)
assert.equal((await upload('id=main&instance=falsch', 'ZWA1' + 'x'.repeat(40))).status, 409)
assert.equal(fs.existsSync(path.join(data, 'assets', 'B'.repeat(22))), false)
// revoking: the blob is gone from disk and from the web, and the message keeps the title but no longer the key
assert.equal((await call('revoke_asset', { id: aid })).content[0].text.startsWith('revoked'), true)
assert.equal((await fetch(`${base}/a/${aid}/blob`)).status, 404)
assert.equal(fs.existsSync(path.join(data, 'assets', aid)), false)
s = await state()
assert.deepEqual([s.assets.map(a => a.id), s.messages[talk].text, s.messages[talk].asset], [[qid, pid], '**Lasttest** (withdrawn)', { id: aid, type: 'html', title: 'Lasttest', gone: true }])
assert.ok(!fs.readFileSync(path.join(data, 'state.json'), 'utf8').includes(akey), 'the hub forgot the key with the asset')
await refused('revoke_asset', { id: aid }, /no asset/)
await refused('revoke_asset', { id: '../token' }, /no asset/)

// the help page draws its reference from the server: the tools as the agent is given them, each with a call that fits its schema
assert.equal((await fetch(`${base}/api/tools`)).status, 401)
const reference = await (await fetch(`${base}/api/tools`, { headers: { Cookie: cookie } })).json()
const given = (await client.listTools()).tools
assert.deepEqual(reference.tools.map(t => [t.name, t.description, t.inputSchema]), given.map(t => [t.name, t.description, t.inputSchema]))
for (const tool of reference.tools) {
  assert.ok(tool.example && typeof tool.example === 'object', `${tool.name} has an example`)
  for (const key of Object.keys(tool.example)) assert.ok(key in tool.inputSchema.properties, `${tool.name}: the example names "${key}", the schema does not`)
  for (const key of tool.inputSchema.required ?? []) assert.ok(key in tool.example, `${tool.name}: the example lacks "${key}"`)
}
// and the events as they really arrive: every kind this test has received so far, with exactly those meta fields
const kinds = reference.events.filter(e => e.kind)
assert.deepEqual(kinds.map(e => e.kind), ['chat', 'decision', 'decision_reopened', 'scribble'])
for (const event of kinds) {
  const real = heard.find(n => n.method === event.method && n.params.meta.kind === event.kind)
  assert.deepEqual(Object.keys(real.params.meta).sort(), Object.keys(event.meta).sort(), event.kind)
  assert.match(event.example, new RegExp(`^<channel source="board" kind="${event.kind}"`))
}
const verdict = reference.events.find(e => e.method === 'notifications/claude/channel/permission')
assert.deepEqual(Object.keys(heard.find(n => n.method === verdict.method).params).sort(), Object.keys(verdict.params).sort())
assert.deepEqual(Object.keys(reference.events.find(e => e.method.endsWith('/permission_request')).params), ['request_id', 'tool_name', 'description', 'input_preview'])
assert.deepEqual(kinds.map(e => Object.keys(e.optional ?? {})), [['card_id'], ['choices'], ['previous_choices'], []])
assert.ok(reference.tools[0].inputSchema.properties.card_id)
assert.deepEqual(reference.events.map(e => e.direction), ['to_agent', 'to_agent', 'to_agent', 'to_agent', 'to_agent', 'from_client', 'from_client'])

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
assert.equal(saved.next_number, 14)
await client.close()
client = await start()
assert.deepEqual((await state()).queue, [low, high, normal2])
const late = await ask('nach dem Neustart', { urgency: 'high' })
s = await state()
assert.equal(s.cards.at(-1).number, 14)
assert.deepEqual(s.queue, [low, high, late, normal2])

// asking back about a card instead of answering it: the message names the card, the agent hears which, and the card stays open
received.length = 0
assert.equal((await post('/message', { text: 'was hängt daran?', card_id: late })).status, 200)
await until(() => received.length === 1)
assert.deepEqual(received[0].params, { content: 'was hängt daran?', meta: { kind: 'chat', card_id: late } })
await call('reply', { text: 'der Deploy', card_id: late })
s = await state()
assert.deepEqual(s.messages.slice(-2).map(m => [m.from, m.text, m.card_id]), [['user', 'was hängt daran?', late], ['agent', 'der Deploy', late]])
assert.deepEqual([s.cards.find(c => c.id === late).status, s.queue.includes(late)], ['open', true])
await refused('reply', { text: 'x', card_id: 'nope' }, /no card nope/)
// a card that is not open, or not there, makes it an ordinary message
for (const id of ['nope', card.id]) assert.equal((await post('/message', { text: `zu ${id}`, card_id: id })).status, 200)
await until(() => received.length === 3)
assert.deepEqual(received.slice(1).map(n => n.params.meta), [{ kind: 'chat' }, { kind: 'chat' }])
assert.deepEqual((await state()).messages.slice(-2).map(m => 'card_id' in m), [false, false])
received.length = 0

// a question with several answers: the human sends a list, the agent hears the first as choice and all as choices
const multi = await ask('welche davon?', { multiple: true, options: [{ key: 'a', label: 'Anton' }, { key: 'b', label: 'Berta' }, { key: 'c', label: 'Cäsar' }], recommended: ['a', 'c'] })
s = await state()
assert.deepEqual((({ multiple, recommended, choice, choices }) => [multiple, recommended, choice, choices])(s.cards.at(-1)), [true, ['a', 'c'], null, []])
assert.deepEqual([s.cards.find(c => c.id === late).multiple, s.cards.find(c => c.id === late).choices], [false, []])
await refused('create_decision', { title: 'x', options: [option('a'), option('b')], recommended: ['a', 'b'] }, /needs multiple: true/)
await refused('create_decision', { title: 'x', multiple: true, options: [option('a'), option('b')], recommended: ['a', 'zzz'] }, /recommended must be the key of one of the options; got "zzz"/)
for (const wrong of [{ keys: [] }, { keys: ['a', 'nope'] }, { keys: 'a' }, {}]) assert.equal((await post('/decide', { card_id: multi, ...wrong })).status, 400, JSON.stringify(wrong))
assert.equal((await post('/decide', { card_id: late, keys: ['a'] })).status, 400, 'a card with one answer does not take a list')
assert.equal((await state()).cards.find(c => c.id === late).status, 'open')
assert.equal((await post('/decide', { card_id: multi, keys: ['c', 'a', 'c'] })).status, 200)
await until(() => received.length === 1)
assert.deepEqual(received[0].params, { content: 'Decision on "welche davon?": a, c', meta: { kind: 'decision', card_id: multi, choice: 'a', choices: 'a,c' } })
s = await state()
assert.deepEqual((({ status, choice, choices }) => [status, choice, choices])(s.cards.at(-1)), ['decided', 'a', ['a', 'c']])
assert.deepEqual([s.messages.at(-1).kind, s.messages.at(-1).text], ['decided', 'Anton, Cäsar'])
// taking it back clears both, and names all that no longer hold
assert.equal((await post('/reopen', { card_id: multi })).status, 200)
await until(() => received.length === 2)
assert.deepEqual(received[1].params.meta, { kind: 'decision_reopened', card_id: multi, previous_choice: 'a', previous_choices: 'a,c' })
assert.match(received[1].params.content, /took back their answer "Anton, Cäsar"/)
assert.deepEqual((({ status, choice, choices }) => [status, choice, choices])((await state()).cards.at(-1)), ['open', null, []])
// one key is an answer to such a card too
assert.equal((await post('/decide', { card_id: multi, key: 'b', note: 'nur die' })).status, 200)
await until(() => received.length === 3)
assert.deepEqual(received[2].params, { content: 'nur die', meta: { kind: 'decision', card_id: multi, choice: 'b', choices: 'b' } })
assert.deepEqual((({ multiple, choice, choices }) => [multiple, choice, choices])(JSON.parse((await call('list_cards', {})).content[0].text).find(c => c.id === multi)), [true, 'b', ['b']])
await call('close_card', { card_id: multi })
received.length = 0

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

// a spoke encrypts in its own process: the hub is handed ciphertext, and of a silent asset no key
const spokeTalk = (await state()).messages.length
const [sid, skey] = linkOf(await publish(api, { content: '<h1>von der Speiche 31337</h1>', title: 'Speichenseite' }))
const [tid, tkey] = linkOf(await publish(api, { content: 'still 27182', type: 'file', silent: true }))
const told = await state()
assert.deepEqual(told.assets.slice(-2).map(a => [a.id, a.agent, a.type, a.title, a.silent]), [[sid, 'api', 'html', 'Speichenseite', false], [tid, 'api', null, '', true]])
assert.deepEqual([told.messages.length, told.messages.at(-1).agent, told.messages.at(-1).asset.url], [spokeTalk + 1, 'api', `/a/${sid}#${skey}`])
const onDisk = fs.readFileSync(path.join(data, 'assets', sid))
assert.ok(!onDisk.includes('31337') && !onDisk.includes(skey) && !fs.readFileSync(path.join(data, 'assets', tid)).includes('27182'))
const spoken = await openAsset(await blobOf(sid), skey, sid)
assert.deepEqual([spoken.header.type, spoken.header.title, spoken.content.toString()], ['html', 'Speichenseite', '<h1>von der Speiche 31337</h1>'])
const hidden = await openAsset(await blobOf(tid), tkey, tid)
assert.deepEqual([hidden.header.type, hidden.header.mime, hidden.header.name, hidden.content.toString()], ['file', 'text/plain', 'asset.txt', 'still 27182'])
await assert.rejects(openAsset(await blobOf(sid), tkey, sid))
assert.ok(!fs.readFileSync(path.join(data, 'state.json'), 'utf8').includes(tkey) && !logs.join('\n').includes(tkey) && !logs.join('\n').includes(skey))
// assets are fenced like cards: only the session that published one sees it or ends it
await refused('revoke_asset', { id: sid }, /no asset/)
assert.deepEqual(JSON.parse((await infra.callTool({ name: 'list_assets', arguments: {} })).content[0].text), [])
assert.deepEqual(JSON.parse((await api.callTool({ name: 'list_assets', arguments: {} })).content[0].text).map(a => [a.id, a.link]), [[sid, `${base}/a/${sid}#${skey}`], [tid, null]])
await api.callTool({ name: 'revoke_asset', arguments: { id: tid } })
assert.deepEqual([(await fetch(`${base}/a/${tid}/blob`)).status, fs.existsSync(path.join(data, 'assets', tid)), (await fetch(`${base}/a/${sid}/blob`)).status], [404, false, 200])

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
// a session that is away can be archived: its open cards stay, but leave the stack
s = await state()
const mainOpen = s.cards.filter(c => c.agent === 'main' && c.status === 'open').map(c => c.id)
assert.ok(mainOpen.length >= 3 && mainOpen.every(id => s.queue.includes(id)))
assert.equal((await post('/session', { agent: 'api', archived: true })).status, 409, 'an online session cannot be archived')
assert.equal((await state()).agents[1].archived, false)
assert.equal((await post('/session', { agent: 'main', archived: true })).status, 200)
s = await state()
assert.equal(s.agents[0].archived, true)
assert.ok(mainOpen.every(id => !s.queue.includes(id) && s.cards.find(c => c.id === id).status === 'open'))
assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8')).agents[0].archived, true)
assert.equal((await post('/session', { agent: 'main', archived: false })).status, 200)
assert.deepEqual((await state()).queue.filter(id => mainOpen.includes(id)).length, mainOpen.length, 'un-archived: the cards are back on the stack')
assert.equal((await post('/session', { agent: 'main', archived: true })).status, 200)
// sessions that share a group form a pair; the group is a free string, cut at 40 characters, and null clears it
assert.equal((await post('/session', { agent: 'api', group: 'paar-1' })).status, 200)
assert.equal((await post('/session', { agent: 'infra', group: 'paar-1', label: 'Unterbau' })).status, 200)
assert.equal((await post('/session', { agent: 'main', group: 'x'.repeat(50) })).status, 200)
s = await state()
assert.deepEqual(s.agents.map(a => [a.group, a.label ?? '']), [['x'.repeat(40), ''], ['paar-1', 'Schnittstelle'], ['paar-1', 'Unterbau']])
assert.equal((await post('/session', { agent: 'infra', group: null })).status, 200)
assert.equal((await post('/session', { agent: 'api', label: 'Schnittstelle' })).status, 200, 'other fields leave the group alone')
assert.deepEqual((await state()).agents.map(a => a.group), ['x'.repeat(40), 'paar-1', null])
// a message for an agent that is away waits for it
assert.equal((await post('/message', { text: 'für später', agent: 'main' })).status, 200)
received.length = 0
client = await start()
await until(() => received.length === 1)
assert.equal(received[0].params.content, 'für später')
// connecting again ends the archive, and the cards are back
s = await state()
assert.equal(s.agents[0].archived, false)
assert.ok(mainOpen.every(id => s.queue.includes(id)))

await Promise.all([client.close(), api.close(), infra.close()])

// cleanup: an answered card older than the limit goes with its attachment and its markers; open ones stay
await new Promise(r => setTimeout(r, 300))
const kept = JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8'))
const days = n => Date.now() - n * 86400000
fs.writeFileSync(path.join(data, 'files', 'old.png'), 'x')
fs.writeFileSync(path.join(data, 'files', 'young.png'), 'x')
const aged = (id, status, decided, file) => ({ ...oldCard(id, status, days(40), { decided, choice: decided ? 'a' : null }), agent: 'main', number: 900, attachments: [{ name: file, url: `/files/${file}`, kind: 'image', image: true }] })
// assets age the same way, unless they were published to be kept
assert.deepEqual(kept.assets.map(a => a.id), [qid, pid, sid], 'assets outlast restarts and changes of hub')
const [aOld, aKeep, aYoung] = ['O', 'K', 'Y'].map(c => c.repeat(22))
for (const id of [aOld, aKeep, aYoung]) fs.writeFileSync(path.join(data, 'assets', id), 'ZWA1' + 'x'.repeat(60))
const published = (id, created, keep) => ({ id, agent: 'main', type: 'html', title: 'Alt', size: 64, created, keep, silent: false, wrapped_key: null })
fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({
  ...kept,
  cards: [aged('gone', 'done', days(31), 'old.png'), aged('recent', 'done', days(29), 'young.png'), aged('waiting', 'open', null, 'young.png')],
  messages: [
    { id: 'e1', agent: 'main', from: 'event', kind: 'done', card_id: 'gone', text: 'x', ts: 1 }, { id: 'e2', agent: 'main', from: 'event', kind: 'done', card_id: 'recent', text: 'x', ts: 2 },
    { id: 'am', agent: 'main', from: 'agent', text: `**Alt** (HTML page)\n\n${base}/a/${aOld}#${'k'.repeat(43)}`, attachments: [], asset: { id: aOld, type: 'html', title: 'Alt', note: '', url: `/a/${aOld}#${'k'.repeat(43)}`, size: 64 }, ts: 3 },
  ],
  // the last record names no asset; a state file is never a way to a path outside the folder
  assets: [published(aOld, days(31), false), published(aKeep, days(31), true), published(aYoung, days(29), false), { id: '../token', agent: 'main', created: 1 }],
}))
process.env.BOARD_RETENTION_DAYS = '30'
client = await start()
s = await state()
assert.deepEqual(s.cards.map(c => c.id), ['recent', 'waiting'])
assert.deepEqual(s.messages.map(m => m.id), ['e2', 'am'])
assert.deepEqual([s.assets.map(a => a.id), s.messages[1].text, s.messages[1].asset], [[aKeep, aYoung], '**Alt** (removed after 30 days)', { id: aOld, type: 'html', title: 'Alt', gone: true }])
assert.deepEqual([aOld, aKeep, aYoung].map(id => fs.existsSync(path.join(data, 'assets', id))), [false, true, true])
assert.deepEqual([(await fetch(`${base}/a/${aOld}/blob`)).status, (await fetch(`${base}/a/${aKeep}/blob`)).status], [404, 200])
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

// ---- a hub of its own: it serves the board without being a session, and has nothing on stdin ----
await portFree()
const data5 = fs.mkdtempSync(path.join(os.tmpdir(), 'board-test-'))
const on5 = { BOARD_DATA: data5 }
const lone = spawn('node', [SERVER], { env: serverEnv('Dienst', { ...on5, BOARD_HUB_ONLY: '1' }), stdio: ['ignore', 'ignore', 'pipe'] })
lone.stderr.on('data', chunk => logs.push(...String(chunk).split('\n').filter(Boolean)))
await eventually(async () => (await state()).agents.length === 0, 'the hub of its own to answer')
s = await state()
assert.deepEqual([s.agents, s.hub, s.queue], [[], null, []])
for (const dir of ['files', 'scribbles', 'speech', 'assets']) assert.equal(fs.statSync(path.join(data5, dir)).mode & 0o777, 0o700, dir)
assert.ok(logs.some(l => l.includes('hub on 0.0.0.0:8791 without a session of its own')))
assert.equal((await post('/message', { text: 'ist da wer?' })).status, 400, 'nobody to talk to yet')
const gotSolo = []
const solo = await start('Solo', gotSolo, on5)
await say(solo, 'introduce', { model: 'm', task: 'allein' })
await say(solo, 'reply', { text: 'ich bin da' })
const soloCard = (await say(solo, 'create_decision', { title: 'geht das?', options: [option('a'), option('b')] })).content[0].text.match(/^card (\w+) /)[1]
assert.equal((await post('/message', { text: 'hallo Solo' })).status, 200)
assert.equal((await post('/decide', { card_id: soloCard, key: 'a' })).status, 200)
await eventually(() => gotSolo.length === 2, 'the spoke of a hub of its own to hear the human')
assert.deepEqual(gotSolo.map(n => n.params.meta.kind), ['chat', 'decision'])
const [lid, lkey] = linkOf(await publish(solo, { content: '<p>über den Dienst</p>' }))
assert.equal((await openAsset(await blobOf(lid), lkey, lid)).content.toString(), '<p>über den Dienst</p>')
s = await state()
assert.deepEqual([s.agents.map(a => [a.id, a.task, a.online]), s.hub, [...new Set(s.messages.map(m => m.agent))]], [[['solo', 'allein', true]], null, ['solo']])
// a second hub of its own does not link as a session either; it waits for the port
const spare = spawn('node', [SERVER], { env: serverEnv('Ersatz', { ...on5, BOARD_HUB_ONLY: '1' }), stdio: ['ignore', 'ignore', 'ignore'] })
await sleep(600)
assert.deepEqual([(await state()).agents.map(a => a.id), spare.exitCode], [['solo'], null])
spare.kill()
// such a hub keeps the port: when it stops, its spoke does not take over, and links again when the hub is back
mark = logs.length
lone.kill()
await portFree()
await sleep(1500)
await assert.rejects(fetch(base), 'the spoke of a hub of its own left the port alone')
await fails(solo, 'list_cards', {}, /try again in a moment/)
const back = spawn('node', [SERVER], { env: serverEnv('Dienst', { ...on5, BOARD_HUB_ONLY: '1' }), stdio: ['ignore', 'ignore', 'pipe'] })
back.stderr.on('data', chunk => logs.push(...String(chunk).split('\n').filter(Boolean)))
await eventually(async () => (await state()).agents[0].online === true, 'the spoke to link to the hub that came back')
assert.ok(!(await say(solo, 'reply', { text: 'wieder da' })).isError)
s = await state()
assert.deepEqual([s.agents.map(a => [a.id, a.task, a.online]), s.hub, s.messages.at(-1).text], [[['solo', 'allein', true]], null, 'wieder da'])
assert.deepEqual(logs.slice(mark).filter(l => l.includes('] hub on ')).map(l => l.includes('without a session of its own')), [true])
// the last session leaves and the hub stays
await solo.close()
await eventually(async () => (await state()).agents[0].online === false, 'the hub of its own to outlast its only session')
assert.equal(back.exitCode, null)

// a worker without a channel publishes through dev/session.mjs: the helper encrypts with the same envelope
// and uploads like a spoke, so the hub is handed ciphertext, and of a silent asset no key
const SESSION = toPath(new URL('../dev/session.mjs', import.meta.url))
const helperEnv = { ...process.env, BOARD_PORT: String(PORT), BOARD_DATA: data5, BOARD_TOKEN: 'secret', BOARD_PUBLIC_URL: '' }
const helper = (...args) => new Promise(resolve => {
  const child = spawn('node', [SESSION, ...args], { env: helperEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  const out = { stdout: '', stderr: '' }
  for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => { out[stream] += chunk })
  child.on('close', code => resolve({ code, ...out }))
})
const sheet = path.join(data5, 'blatt.html')
const sheetBytes = Buffer.concat([Buffer.from('<!doctype html><h1>vom Helfer 16180</h1>'), crypto.randomBytes(3000)])
fs.writeFileSync(sheet, sheetBytes)
// a session that is not linked is refused, as it is for a spoke
assert.deepEqual([(await helper('publish', 'Helfer', sheet)).code, fs.readdirSync(path.join(data5, 'assets')).length], [1, 1])
const held = spawn('node', [SESSION, 'link', 'Helfer'], { env: helperEnv, stdio: 'ignore' })
await eventually(async () => (await state()).agents.some(a => a.id === 'helfer' && a.online), 'the helper session to link')
const helperTalk = (await state()).messages.length
const shownOut = await helper('publish', 'helfer', sheet, '--title', 'Blatt', '--note', 'aus dem Helfer')
assert.equal(shownOut.code, 0, shownOut.stderr)
// the base is the first line of data/url.txt without its query
const [hid, hkey] = shownOut.stdout.match(/^http:\/\/localhost:8791\/a\/([\w-]{22})#([\w-]{43})\n$/).slice(1)
// the blob is fetched without a cookie and opens with the key from the printed link: the same bytes
const fetched = await blobOf(hid)
assert.deepEqual(fetched, fs.readFileSync(path.join(data5, 'assets', hid)))
assert.ok(!fetched.includes('16180') && !fetched.includes(hkey))
const unsealed = await openAsset(fetched, hkey, hid)
assert.deepEqual([unsealed.header.type, unsealed.header.title, unsealed.header.name, unsealed.header.mime, unsealed.content.equals(sheetBytes)], ['html', 'Blatt', 'blatt.html', 'text/html', true])
// announced on the board exactly as the tool does it
s = await state()
assert.deepEqual([s.messages.length, s.messages.at(-1).agent, s.messages.at(-1).from, s.messages.at(-1).text], [helperTalk + 1, 'helfer', 'agent', `**Blatt** (HTML page)\n\naus dem Helfer\n\n${base}/a/${hid}#${hkey}`])
assert.deepEqual(s.messages.at(-1).asset, { id: hid, type: 'html', title: 'Blatt', note: 'aus dem Helfer', url: `/a/${hid}#${hkey}`, size: fetched.length })
// silent: nothing on the board, and the hub's state holds neither key nor title nor type
const quietOut = await helper('publish', 'helfer', sheet, '--silent', '--keep', '--type', 'file', '--title', 'Verschwiegen')
assert.equal(quietOut.code, 0, quietOut.stderr)
const [zid, zkey] = quietOut.stdout.match(/^http:\/\/localhost:8791\/a\/([\w-]{22})#([\w-]{43})\n$/).slice(1)
s = await state()
assert.equal(s.messages.length, helperTalk + 1)
assert.deepEqual({ ...s.assets.at(-1), created: 0, size: 0 }, { id: zid, agent: 'helfer', type: null, title: '', size: 0, created: 0, keep: true, silent: true, wrapped_key: null })
for (const where of [JSON.stringify(s), fs.readFileSync(path.join(data5, 'state.json'), 'utf8')]) assert.ok(!where.includes(zkey) && !where.includes('Verschwiegen'), 'the hub knows something about a silent asset')
const hushed = await openAsset(await blobOf(zid), zkey, zid)
assert.deepEqual([hushed.header.type, hushed.header.title, hushed.content.equals(sheetBytes)], ['file', 'Verschwiegen', true])
// the public address, when one is named, is what the printed link starts with
helperEnv.BOARD_PUBLIC_URL = 'https://rechner.example.ts.net/, https://zweite.example'
assert.match((await helper('publish', 'helfer', sheet, '--silent')).stdout, /^https:\/\/rechner\.example\.ts\.net\/a\/[\w-]{22}#[\w-]{43}\n$/)
assert.match((await helper('publish', 'helfer', sheet, '--type', 'pdf')).stderr, /type must be one of/)
held.kill()
back.kill()

// ---- the admin backend, on a board whose state, files and sizes are known ----
await portFree()
const data4 = fs.mkdtempSync(path.join(os.tmpdir(), 'board-test-'))
const in4 = (...parts) => path.join(data4, ...parts)
const put = (dir, name, bytes) => fs.writeFileSync(in4(dir, name), Buffer.alloc(bytes, 1))
for (const dir of ['files', 'scribbles', 'speech', 'assets']) fs.mkdirSync(in4(dir))
put('files', 'ref.png', 10); put('files', 'card.png', 20); put('files', 'aging.png', 30); put('files', 'orphan.bin', 40); put('files', 'keep.png', 10)
put('scribbles', 'abc123.png', 5); put('scribbles', 'abc123.json', 5); put('scribbles', 'canvas-weg.json', 6); put('scribbles', 'canvas-chef.json', 7)
put('scribbles', 'canvas-alt.json', 3); put('scribbles', 'dead.png', 8); put('scribbles', 'canvas-niemand.json', 9)
put('speech', 'alt.mp3', 11); put('speech', 'neu.mp3', 12)
// a blob no record points to
put('assets', 'L'.repeat(22), 9)
fs.utimesSync(in4('speech', 'alt.mp3'), new Date(days(2)), new Date(days(2)))
fs.writeFileSync(in4('tinfoil.key'), 'tinfoil-geheim')
// a link in the folder is neither counted nor followed
fs.symlinkSync(in4('tinfoil.key'), in4('files', 'link.bin'))
// this card crosses the 30 days a few seconds after the hub has started
const ripe = Date.now() + 6000
const gone = (id, extra = {}) => ({ id, name: id, cwd: `/tmp/${id}`, host: 'alt', platform: 'p', instance: 'i', model: 'M', client: 'c', task: 't', joined: 1, connected: 1, seen: 1000, online: false, ...extra })
const pic = name => ({ name, url: `/files/${name}`, kind: 'image', image: true })
const card4 = (id, agent, status, decided, attachments = []) => ({ ...oldCard(id, status, days(40), { decided, choice: decided ? 'a' : null }), agent, attachments })
const waits = text => ({ method: 'notifications/claude/channel', params: { content: text, meta: { kind: 'chat' } }, ts: Date.now() })
fs.writeFileSync(in4('state.json'), JSON.stringify({
  agents: [gone('weg'), gone('alt')],
  messages: [
    // the second attachment names a file outside the folder; forgetting the session must not follow it
    { id: 'w1', agent: 'weg', from: 'agent', text: 'mit Bild', attachments: [pic('ref.png'), { name: 'x', url: '/files/../token', kind: 'file' }], ts: 1 },
    { id: 'w2', agent: 'weg', from: 'user', text: '', attachments: [{ kind: 'scribble', id: 'abc123', name: 'Scribble', url: '/scribbles/abc123.png', image: true }], ts: 2 },
    { id: 'a1', agent: 'alt', from: 'agent', text: 'bleibt', attachments: [pic('keep.png')], ts: 3 },
    { id: 'c1', agent: 'chef', from: 'user', text: 'hallo', ts: 4 },
    { id: 'e1', agent: 'chef', from: 'event', kind: 'done', card_id: 'aging', text: 'x', ts: 5 },
  ],
  cards: [
    card4('wopen', 'weg', 'open', null, [pic('card.png')]), card4('aging', 'chef', 'done', ripe - 30 * 86400000, [pic('aging.png')]),
    card4('cdec', 'chef', 'decided', days(1)), card4('cdone', 'chef', 'done', days(1)),
  ],
  pending: { weg: [waits('wartet eins'), waits('wartet zwei')] },
}))
const on4 = { BOARD_DATA: data4, BOARD_TOKEN: '', BOARD_ADMIN_TOKEN: '', BOARD_PUBLIC_URL: 'https://rechner.example.ts.net/' }
const file4 = () => JSON.parse(fs.readFileSync(in4('state.json'), 'utf8'))
const has4 = (...parts) => fs.existsSync(in4(...parts))
const gotSpeiche = []
const chef = await start('Chef', [], on4)
const speiche = await start('Speiche', gotSpeiche, on4)
const token4 = fs.readFileSync(in4('token'), 'utf8')
const adminKey4 = fs.readFileSync(in4('admin-token'), 'utf8')
assert.equal(fs.statSync(in4('admin-token')).mode & 0o077, 0)
assert.notEqual(adminKey4, token4)
let board4 = `board_8791=${token4}`
const post4 = (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, Cookie: board4 }, body: JSON.stringify(body) })
const reads = ['overview', 'cleanup', 'log', 'diagnose', 'export']
const writes = { purge: { confirm: 'purge' }, orphans: { confirm: 'orphans' }, 'sessions/forget': { id: 'weg', confirm: 'weg', data: true }, 'sessions/clear-queue': { id: 'weg', confirm: 'weg' }, 'token/rotate': { confirm: 'rotate' }, links: {} }

// nothing without the login, and the login alone opens nothing but the question for the key
for (const route of reads) assert.equal((await fetch(`${base}/admin/api/${route}`)).status, 401, route)
for (const route of reads) {
  const res = await adminGet(route, board4)
  assert.deepEqual([res.status, await res.json()], [403, { error: 'admin key required', admin: false }], route)
}
for (const [route, body] of Object.entries(writes)) {
  assert.equal((await fetch(`${base}/admin/api/${route}`, { method: 'POST', headers: { Origin: base }, body: JSON.stringify(body) })).status, 401, route)
  assert.equal((await adminPost(route, body, board4)).status, 403, route)
}
assert.equal((await adminPost('login', { key: adminKey4 }, board4, 'https://evil.example')).status, 403)
assert.equal((await adminPost('login', { key: adminKey4 }, 'board_8791=falsch')).status, 401)
// the login token is not the admin key, and a wrong key takes its time
began = Date.now()
assert.equal((await adminPost('login', { key: token4 }, board4)).status, 403)
assert.equal((await adminPost('login', { key: 'geraten' }, board4)).status, 403)
assert.ok(Date.now() - began >= 2000)
let admin4 = await adminLogin(adminKey4, board4)
assert.ok(!admin4.includes(adminKey4), 'the browser holds a session, not the key')
// the admin session is worth nothing without the login
assert.equal((await adminGet('overview', admin4.split('; ')[1])).status, 401)

// a link someone follows cannot remove anything: GET is not answered there, another site is refused, and a POST must say what it means
for (const [route, body] of Object.entries(writes)) {
  const res = await adminGet(route, admin4)
  assert.deepEqual([res.status, res.headers.get('allow')], [405, 'POST'], route)
  assert.equal((await adminGet(`${route}?confirm=${body.confirm}&id=weg`, admin4)).status, 405, route)
  assert.equal((await adminPost(route, body, admin4, 'https://evil.example')).status, 403, route)
  if (!body.confirm) continue
  for (const wrong of [undefined, true, 'ja']) {
    const unsure = await adminPost(route, { ...body, confirm: wrong }, admin4)
    assert.equal(unsure.status, 400, route)
    assert.match((await unsure.json()).error, /not confirmed/)
  }
}
assert.equal((await adminPost('overview', {}, admin4)).status, 405)
assert.equal((await adminGet('nichts', admin4)).status, 404)
assert.equal((await adminGet('constructor', admin4)).status, 404)
assert.equal((await fetch(`${base}/admin/api/purge`, { method: 'POST', headers: { Origin: base, Cookie: admin4 }, body: '[]' })).status, 400)
assert.deepEqual(fs.readdirSync(in4('files')).sort(), ['aging.png', 'card.png', 'keep.png', 'link.bin', 'orphan.bin', 'ref.png'])
assert.deepEqual([file4().agents.length, file4().cards.length, file4().pending.weg.length, fs.readFileSync(in4('token'), 'utf8')], [4, 4, 2, token4])

// overview: the numbers of the state and the folders as they were written
const view = await adminGet('overview', admin4)
assert.equal(view.headers.get('cache-control'), 'no-store')
let o = await view.json()
assert.equal(o.version, JSON.parse(fs.readFileSync(toPath(new URL('../package.json', import.meta.url)), 'utf8')).version)
assert.deepEqual([o.hub.id, o.hub.host, o.port, o.bind, o.speech, o.token_fixed, o.retention_days], ['chef', os.hostname(), PORT, '0.0.0.0', true, false, 30])
assert.ok(Number.isInteger(o.hub.pid) && o.hub.pid !== process.pid && o.uptime >= 0 && Date.now() - o.hub.since < 60000)
assert.deepEqual(o.data, { dir: data4, state: fs.statSync(in4('state.json')).size, files: { count: 5, bytes: 110 }, scribbles: { count: 7, bytes: 43 }, speech: { count: 2, bytes: 23 }, assets: { count: 1, bytes: 9 } })
assert.deepEqual({ ...o.counts, sse: 0 }, { messages: 5, cards: { open: 1, decided: 1, done: 2 }, queued: { weg: 2 }, sse: 0 })
assert.deepEqual(o.sessions.map(a => [a.id, a.online, a.hub, a.queued, a.messages, a.cards]), [
  ['weg', false, false, 2, 2, 1], ['alt', false, false, 0, 1, 0], ['chef', true, true, 0, 2, 3], ['speiche', true, false, 0, 0, 0],
])
assert.deepEqual((({ model, host, cwd, client, seen }) => [model, host, cwd, client, seen])(o.sessions[0]), ['M', 'alt', '/tmp/weg', 'c', 1000])
assert.ok(!JSON.stringify(o).includes(token4) && !JSON.stringify(o).includes(adminKey4))

// cleanup, as a count first: what nothing points to, and nothing to purge yet
let c = await (await adminGet('cleanup', admin4)).json()
assert.ok(Date.now() < ripe, 'the fixture was looked at before its card came of age')
assert.deepEqual(c.orphans, { files: { count: 1, bytes: 40 }, scribbles: { count: 2, bytes: 17 }, speech: { count: 1, bytes: 11 }, assets: { count: 1, bytes: 9 } })
assert.deepEqual([c.retention_days, c.purge.cards, c.purge.count, c.purge.markers], [30, 0, 0, 0])

// diagnose: what the hub logged, who is linked, how many pages listen
const page4 = await fetch(`${base}/events`, { headers: { Cookie: board4 } })
const pageReader = page4.body.getReader()
await pageReader.read()
let d
await eventually(async () => (d = await (await adminGet('diagnose', admin4)).json()).sse === 1, 'one page to be counted')
assert.ok(d.lines.some(l => /hub on 0\.0\.0\.0:8791 as "chef"/.test(l.line) && l.ts > 0))
assert.ok(d.lines.length <= 200)
assert.deepEqual(d.links.map(l => [l.id, l.state, l.queued]), [['weg', 'away', 2], ['alt', 'away', 0], ['chef', 'hub', 0], ['speiche', 'linked', 0]])

// export: the state without what waits for agents, and without any secret, even one typed into the chat
assert.equal((await post4('/message', { text: `der Link war ?t=${token4} und der Schlüssel tinfoil-geheim`, agent: 'speiche' })).status, 200)
const dump = await adminGet('export', admin4)
assert.deepEqual([dump.status, dump.headers.get('cache-control')], [200, 'no-store'])
assert.match(dump.headers.get('content-disposition'), /^attachment; filename="trommi-\d{4}-\d\d-\d\d\.json"$/)
const dumped = await dump.text()
for (const secret of [token4, adminKey4, 'tinfoil-geheim', 'wartet eins']) assert.ok(!dumped.includes(secret), `the export carries ${secret}`)
const exported = JSON.parse(dumped)
assert.deepEqual([exported.messages.length, exported.cards.length, exported.agents.length, 'pending' in exported, exported.pending_counts], [6, 4, 4, false, { weg: 2 }])
assert.equal(exported.messages.at(-1).text, 'der Link war ?t=[removed] und der Schlüssel [removed]')

// the queue of a session that is away can be dropped
assert.deepEqual(await (await adminPost('sessions/clear-queue', { id: 'weg', confirm: 'weg' }, admin4)).json(), { ok: true, removed: 2 })
assert.equal(file4().pending.weg, undefined)
assert.equal((await adminPost('sessions/clear-queue', { id: 'niemand', confirm: 'niemand' }, admin4)).status, 404)

// orphans: the files nothing points to go, everything referenced stays, the old speech goes and the fresh one stays
assert.deepEqual(await (await adminPost('orphans', { confirm: 'orphans' }, admin4)).json(), { ok: true, removed: 5, bytes: 77 })
assert.deepEqual(fs.readdirSync(in4('files')).sort(), ['aging.png', 'card.png', 'keep.png', 'link.bin', 'ref.png'])
assert.deepEqual(fs.readdirSync(in4('scribbles')).sort(), ['abc123.json', 'abc123.png', 'canvas-alt.json', 'canvas-chef.json', 'canvas-weg.json'])
assert.deepEqual([fs.readdirSync(in4('speech')), fs.readdirSync(in4('assets'))], [['neu.mp3'], []])
assert.equal(fs.readFileSync(in4('tinfoil.key'), 'utf8'), 'tinfoil-geheim')
c = await (await adminGet('cleanup', admin4)).json()
assert.deepEqual(c.orphans, { files: { count: 0, bytes: 0 }, scribbles: { count: 0, bytes: 0 }, speech: { count: 0, bytes: 0 }, assets: { count: 0, bytes: 0 } })

// forgetting: never a session that is online, and its data only when asked
for (const id of ['chef', 'speiche']) assert.equal((await adminPost('sessions/forget', { id, confirm: id, data: true }, admin4)).status, 409, id)
assert.equal((await adminPost('sessions/forget', { id: 'niemand', confirm: 'niemand' }, admin4)).status, 404)
// "true" as a word is not the explicit choice: the data stays
assert.deepEqual(await (await adminPost('sessions/forget', { id: 'alt', confirm: 'alt', data: 'true' }, admin4)).json(), { ok: true, messages: 0, cards: 0, files: 0, bytes: 0 })
assert.deepEqual([file4().agents.map(a => a.id), file4().messages.some(m => m.id === 'a1'), has4('files', 'keep.png'), has4('scribbles', 'canvas-alt.json')], [['weg', 'chef', 'speiche'], true, true, true])
assert.deepEqual(await (await adminPost('sessions/forget', { id: 'weg', confirm: 'weg', data: true }, admin4)).json(), { ok: true, messages: 2, cards: 1, files: 5, bytes: 46 })
s = await state(board4)
assert.deepEqual([s.agents.map(a => a.id), s.messages.map(m => m.id).slice(0, 3), s.cards.map(c => c.id), s.queue], [['chef', 'speiche'], ['a1', 'c1', 'e1'], ['aging', 'cdec', 'cdone'], []])
assert.deepEqual(fs.readdirSync(in4('files')).sort(), ['aging.png', 'keep.png', 'link.bin'])
assert.deepEqual(fs.readdirSync(in4('scribbles')).sort(), ['canvas-alt.json', 'canvas-chef.json'])
assert.ok(has4('token') && has4('admin-token') && has4('state.json'), 'a forged attachment path did not reach outside the folder')

// purge: once the card is past the limit the count says so, and running it removes card, marker and file
await sleep(Math.max(0, ripe - Date.now()) + 50)
c = await (await adminGet('cleanup', admin4)).json()
assert.deepEqual((({ cards, count, bytes, markers, queued }) => ({ cards, count, bytes, markers, queued }))(c.purge), { cards: 1, count: 1, bytes: 30, markers: 1, queued: 0 })
assert.equal(has4('files', 'aging.png'), true, 'counting removes nothing')
assert.deepEqual(await (await adminPost('purge', { confirm: 'purge' }, admin4)).json(), { ok: true, cards: 1, count: 1, bytes: 30, markers: 1, queued: 0, assets: 0 })
s = await state(board4)
assert.deepEqual([s.cards.map(c => c.id), s.messages.some(m => m.id === 'e1'), has4('files', 'aging.png'), has4('files', 'keep.png')], [['cdec', 'cdone'], false, false, true])
assert.equal((await (await adminGet('overview', admin4)).json()).counts.cards.done, 1)

// the links are only handed out on request, never with a page that could be cached
const shown = await adminPost('links', {}, admin4)
assert.equal(shown.headers.get('cache-control'), 'no-store')
const links4 = (await shown.json()).links
assert.deepEqual([links4[0], links4.at(-1)], [{ kind: 'local', url: `${base}/?t=${token4}` }, { kind: 'public', url: `https://rechner.example.ts.net/?t=${token4}` }])
assert.deepEqual(fs.readFileSync(in4('url.txt'), 'utf8').trim().split('\n'), links4.map(l => l.url))

// rotation: every old login ends, the one who rotated stays in, and the spoke carries on with the new token
const turned = await adminPost('token/rotate', { confirm: 'rotate' }, admin4)
assert.equal(turned.status, 200)
const fresh4 = fs.readFileSync(in4('token'), 'utf8')
assert.ok(fresh4 !== token4 && fresh4.length >= 32)
assert.equal(turned.headers.get('set-cookie'), `board_8791=${fresh4}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`)
assert.equal((await turned.json()).links[0].url, `${base}/?t=${fresh4}`)
assert.equal(fs.readFileSync(in4('url.txt'), 'utf8').split('\n')[0], `${base}/?t=${fresh4}`)
assert.deepEqual(fs.readdirSync(data4).filter(f => f.startsWith('token')), ['token'])
assert.equal(fs.statSync(in4('token')).mode & 0o077, 0)
assert.equal((await fetch(`${base}/`, { headers: { Cookie: board4 } })).status, 401, 'the old cookie is refused')
assert.equal((await adminGet('overview', admin4)).status, 401, 'also on the admin routes')
assert.equal((await fetch(`${base}/?t=${token4}`, { redirect: 'manual' })).status, 401, 'the old link is dead')
assert.equal((await fetch(`${base}/?t=${fresh4}`, { redirect: 'manual' })).status, 302, 'the new link logs in')
await eventually(async () => (await pageReader.read()).done, 'the page that was open to be cut off')
admin4 = admin4.replace(token4, fresh4)
board4 = `board_8791=${fresh4}`
assert.equal((await adminGet('overview', admin4)).status, 200)
// the spoke was linked with the old token: its next call is refused once, it reads the file and goes on
assert.ok(!(await say(speiche, 'reply', { text: 'nach dem Wechsel' })).isError)
await say(speiche, 'introduce', { model: 'm', task: 'weiter' })
gotSpeiche.length = 0
assert.equal((await post4('/message', { text: 'hörst du noch?', agent: 'speiche' })).status, 200)
await until(() => gotSpeiche.length === 1)
s = await state(board4)
assert.deepEqual([s.messages.at(-2).text, s.messages.at(-2).agent, s.agents.find(a => a.id === 'speiche').task], ['nach dem Wechsel', 'speiche', 'weiter'])
// the old token no longer speaks for a spoke, and a session that starts now links with the new one
assert.equal((await agentPost('/agent/tool', { id: 'speiche', name: 'reply', args: { text: 'x' } }, token4)).status, 403)
const neu = await start('Neu', [], on4)
assert.ok(!(await say(neu, 'reply', { text: 'neu dabei' })).isError)
assert.deepEqual((await state(board4)).agents.map(a => [a.id, a.online]), [['chef', true], ['speiche', true], ['neu', true]])

// the log says what was done, in order, and neither it nor the diagnosis names a secret
const journal = (await (await adminGet('log', admin4)).json()).entries
assert.deepEqual(journal.map(e => e.action), ['login-failed', 'login', 'export', 'clear-queue', 'orphans', 'forget', 'forget', 'purge', 'links', 'rotate'])
assert.deepEqual([journal[0].count, journal[3].detail, journal[5].detail, journal[6].detail], [2, 'weg, 2 notifications', 'alt, data kept', 'weg, with 2 messages, 1 cards, 5 files'])
assert.ok(journal.every(e => e.ts > 0 && typeof e.from === 'string'))
const written = fs.readFileSync(in4('admin-log.jsonl'), 'utf8') + JSON.stringify(await (await adminGet('diagnose', admin4)).json()) + logs.join('\n')
for (const secret of [token4, fresh4, adminKey4, 'tinfoil-geheim', 'geraten']) assert.ok(!written.includes(secret), `a log names ${secret}`)
assert.equal(fs.statSync(in4('admin-log.jsonl')).mode & 0o077, 0)

// the hub goes: whoever takes over uses the new token, knows the same key, kept the log, and asks for the key again
await chef.close()
await eventually(async () => (await state(board4)).agents.filter(a => a.online).length === 2, 'a spoke to take over after the rotation')
assert.equal((await fetch(`${base}/`, { headers: { Cookie: `board_8791=${token4}` } })).status, 401)
assert.equal((await adminGet('overview', admin4)).status, 403, 'admin sessions do not move to the next hub')
admin4 = await adminLogin(adminKey4, board4)
o = await (await adminGet('overview', admin4)).json()
assert.ok(['speiche', 'neu'].includes(o.hub.id))
assert.deepEqual(o.sessions.map(a => [a.id, a.online]), [['chef', false], ['speiche', true], ['neu', true]])
assert.deepEqual((await (await adminGet('log', admin4)).json()).entries.map(e => e.action).slice(-2), ['rotate', 'login'])
assert.ok(!(await say(speiche, 'list_cards', {})).isError && !(await say(neu, 'list_cards', {})).isError)
assert.equal(fs.readFileSync(in4('token'), 'utf8'), fresh4)
await Promise.all([speiche.close(), neu.close()])

for (const dir of [data, data2, data3, data4, data5]) fs.rmSync(dir, { recursive: true })
console.log('ok: chat, decision, attachment, urgency stack, status strip, undo, scribble, media, numbering, withdraw, migration, restart, several agents, hub takeover, cleanup after 30 days, permission relay, token and origin check, malformed input, stable agent ids, queue for away agents across hub changes, calls during a takeover, silent hub, simultaneous start, damaged state file, admin backend, static files, archive and groups, encrypted assets from hub and spoke and from the session helper, tool reference, app paths, hub of its own')
process.exit(0)
