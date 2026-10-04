// End-to-end check: act as Claude Code over stdio and as the browser over HTTP.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath as toPath } from 'node:url'
import { readBoard, writeBoard } from './board-store.mjs'

// Run from anywhere: the server is the file next to this test.
const SERVER = toPath(new URL('./server.mjs', import.meta.url))

// A free port for every run (BOARD_TEST_PORT names one instead): several runs side by side, by several workers, do
// not meet on one port, and a hub left over from a run that failed half-way cannot be taken for this run's.
const freePort = () => new Promise((resolve, reject) => { const probe = http.createServer(); probe.once('error', reject); probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)) }) })
const PORT = Number(process.env.BOARD_TEST_PORT) || await freePort()
const base = `http://localhost:${PORT}`
if (await fetch(base).then(() => true, () => false)) {
  console.error(`port ${PORT} is taken: find what holds it with "ss -ltnp | grep ${PORT}"`)
  process.exit(1)
}
// Hubs this test starts as processes of their own must not outlive it, however it ends.
const spawned = []
process.on('exit', () => { for (const child of spawned) try { child.kill() } catch {} })
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
// An answer right after a rewrite is refused for a moment; keep that moment short here.
process.env.BOARD_REVISE_GRACE_MS = '250'
process.env.BOARD_SNOOZE_TICK_MS = '100'

const received = []
// Every notification any session got, to compare with what the help page says arrives.
const heard = []
// What the servers write to stderr, to check what they did and how often.
const logs = []
const serverEnv = (name, env) => ({ ...process.env, BOARD_PORT: String(PORT), BOARD_DATA: data, BOARD_TOKEN: 'secret', BOARD_AGENT: name, BOARD_ADMIN_TOKEN: 'adminkey', BOARD_PUBLIC_URL: '', TINFOIL_API_KEY: '', BOARD_DRAWINGS: path.join(data, 'drawings.json'), BOARD_MEMO_HOLD_MS: '0', ...env })   // (a sent memo is held only in the memo section)
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

const cookie = `board_${PORT}=secret`
const post = (url, body, origin = base) => fetch(base + url, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: JSON.stringify(body),
})
const state = async (as = cookie) => {
  const res = await fetch(`${base}/events`, { headers: { Cookie: as } })
  const reader = res.body.getReader()
  // The first frame is the whole state; a long one arrives in several pieces.
  const decoder = new TextDecoder()
  let frame = ''
  while (!frame.includes('\n\n')) {
    const { value, done } = await reader.read()
    if (done) break
    frame += decoder.decode(value, { stream: true })
  }
  await reader.cancel()
  return JSON.parse(frame.slice(0, frame.indexOf('\n\n')).replace(/^data: /, ''))
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
  ['reply', 'create_decision', 'create_info', 'revise_card', 'merge_cards', 'set_urgency', 'withdraw_card', 'close_card', 'set_status', 'clear_status', 'introduce', 'create_voiceover', 'list_cards', 'publish_asset', 'list_assets', 'revoke_asset', 'adopt_session', 'share_asset'],
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

// the message log (card Nr. 33): a running number on every message, and ?since=<n> for what a page missed
const sinceStream = async (since, headers = {}) => {
  const res = await fetch(`${base}/events${since == null ? '' : `?since=${since}`}`, { headers: { Cookie: cookie, ...headers } })
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  return {
    async next() {
      while (!buffer.includes('\n\n')) {
        const { value, done } = await reader.read()
        if (done) throw new Error('stream ended')
        buffer += decoder.decode(value, { stream: true })
      }
      const raw = buffer.slice(0, buffer.indexOf('\n\n'))
      buffer = buffer.slice(raw.length + 2)
      const id = raw.match(/^id: (\d+)$/m)?.[1]
      return { id: id == null ? null : Number(id), ...JSON.parse(raw.slice(raw.indexOf('data: ') + 6)) }
    },
    close: () => reader.cancel(),
  }
}
s = await state()
assert.deepEqual(s.messages.map(m => m.seq), s.messages.map((m, at) => at + 1), 'numbered 1, 2, 3 … in order')
assert.deepEqual([s.message_seq, 'messages_since' in s], [s.messages.length, false])
const top = s.message_seq
{
  // without since: whole, no SSE id, as before
  const plain = await sinceStream()
  const f0 = await plain.next()
  assert.deepEqual([f0.id, f0.messages.length, 'messages_since' in f0], [null, s.messages.length, false])
  await plain.close()
  // since=0: whole, but said so, with the id to resume from
  const all = await sinceStream(0)
  const a0 = await all.next()
  assert.deepEqual([a0.id, a0.messages.length, a0.messages_since, a0.message_seq], [top, s.messages.length, 0, top])
  await all.close()
  // since=top-2: only the last two, and the rest of the state whole
  const tail = await sinceStream(top - 2)
  const t0 = await tail.next()
  assert.deepEqual([t0.id, t0.messages.map(m => m.seq), t0.messages_since, t0.cards.length], [top, [top - 1, top], top - 2, s.cards.length])
  // a new message arrives as a frame with the messages after the page's starting point
  assert.equal((await post('/message', { text: 'nach dem Stand' })).status, 200)
  const t1 = await tail.next()
  assert.deepEqual([t1.id, t1.messages.map(m => m.seq), t1.messages.at(-1).text, t1.messages_since], [top + 1, [top - 1, top, top + 1], 'nach dem Stand', top - 2])
  await tail.close()
  // Last-Event-ID (a browser reconnecting) wins over the since in the address
  const back = await sinceStream(3, { 'Last-Event-ID': String(top) })
  const b0 = await back.next()
  assert.deepEqual([b0.messages.map(m => m.text), b0.messages_since], [['nach dem Stand'], top])
  await back.close()
  // nothing missed: an empty list; a number this hub never gave, or junk: the whole list
  for (const [given, n, since] of [[top + 1, 0, top + 1], [top + 999, top + 1, 0], ['x', top + 1, 0], [-4, top + 1, 0]]) {
    const one = await sinceStream(given)
    const f = await one.next()
    assert.deepEqual([f.messages.length, f.messages_since], [n, since], String(given))
    await one.close()
  }
}

// the stack: a fixed order, oldest first; urgency marks a card and does not move it
await refused('create_decision', { title: 'x', options: [option('a'), option('b')], urgency: 'urgent' }, /urgency must be one of low, normal, high, critical/)
const normal1 = await ask('normal eins')
const low = await ask('hat Zeit', { urgency: 'low' })
const high = await ask('dringend', { urgency: 'high', urgency_reason: 'blockiert die Aufgabe' })
const normal2 = await ask('normal zwei')
const critical = await ask('blockiert', { urgency: 'critical', urgency_reason: 'nichts geht mehr' })
s = await state()
assert.deepEqual(s.queue, [normal1, low, high, normal2, critical])
assert.deepEqual(s.queue.map(id => s.cards.find(c => c.id === id).number), [5, 6, 7, 8, 9], 'the stack is the order of filing')
assert.deepEqual(s.queue.map(id => s.cards.find(c => c.id === id).urgency), ['normal', 'low', 'high', 'normal', 'critical'], 'the urgency stays on the card, for the mark and the knock')
assert.equal(s.cards.find(c => c.id === high).urgency_reason, 'blockiert die Aufgabe')

// raising a card marks it and leaves a marker in the conversation; its place stays
await call('set_urgency', { card_id: low, urgency: 'critical', reason: 'Deploy wartet' })
s = await state()
assert.deepEqual(s.queue, [normal1, low, high, normal2, critical], 'nothing moved')
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
assert.deepEqual(s.queue, [low, high, normal2, critical])
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
// an approval gates what the agent may do: it cannot be left to the agent
{
  const no = await post('/decide', { card_id: perm.id, trust: true })
  assert.deepEqual([no.status, /cannot be left to the agent/.test((await no.json()).error), (await state()).cards.find(c => c.id === perm.id).status], [400, true, 'open'])
{
  const no = await post('/shred', { card_id: perm.id })
  assert.deepEqual([no.status, /cannot be thrown away/.test((await no.json()).error), (await state()).cards.find(c => c.id === perm.id).status], [400, true, 'open'])
}
}
assert.ok(perm, 'permission card created')
assert.equal(perm.urgency, 'critical')
assert.equal(perm.number, 10)
s = await state()
assert.deepEqual(s.queue, [low, high, normal2, perm.id], 'an approval is a new card like any other: last in the fixed order, marked critical')
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
assert.match(login.headers.get('set-cookie'), new RegExp(String.raw`^board_${PORT}=secret; HttpOnly; SameSite=Lax`))
// a login from before the cookie was named after the port still works
assert.equal((await fetch(`${base}/`, { headers: { Cookie: 'board=secret' } })).status, 200)
assert.equal(fs.readFileSync(path.join(data, 'url.txt'), 'utf8').split('\n')[0], `${base}/?t=secret`)
// the page keeps its place in the address: those paths are the page, behind the login, and the login keeps path and query
// Since the flip (docs/turbo.md) the main addresses are the server-rendered pages; the old page is at /old/ only, and a path
// the new pages do not have yet leads there.
const placeAt = place => fetch(base + place, { headers: { Cookie: cookie }, redirect: 'manual' })
for (const place of ['/', '/s/api', '/s/api/fragen', '/agents', '/inbox', '/pad', '/walk', '/q/12', '/q/abc12345', '/s/api/q/12', '/old/', '/old/s/api', '/t/']) assert.equal((await fetch(base + place, { redirect: 'manual' })).status, 401, place)
const home = await placeAt('/')
assert.deepEqual([home.status, home.headers.get('content-type')], [200, 'text/html; charset=utf-8'])
assert.match(await home.text(), /<html lang="en" data-loaded data-ui="turbo"[^>]*>[\s\S]*<script type="module" src="\/t\/application\.js"><\/script>[\s\S]*<main id="inbox"/)
assert.equal((await placeAt('/agents')).status, 200)
assert.equal((await placeAt('/q/99999')).status, 404)
assert.deepEqual([(await placeAt('/t/')).status, (await placeAt('/t/')).headers.get('location')], [302, '/'])
assert.equal((await placeAt('/t/q/12?pic=2')).headers.get('location'), '/q/12?pic=2')
assert.equal((await placeAt('/t/application.js')).status, 200)   // the files under /t/ are files
const old = await placeAt('/old/')
assert.deepEqual([old.status, old.headers.get('content-type')], [200, 'text/html; charset=utf-8'])
assert.match(await old.text(), /<script type="module" src="\/js\/app\.js"><\/script>/)
for (const [place, to] of [['/old', '/old/#/'], ['/old/s/api', '/old/#/s/api'], ['/old/q/12?x=1', '/old/#/q/12?x=1'], ['/s/a+b', '/old/#/s/a+b'], ['/s/api/scribble', '/old/#/s/api/scribble'], ['/s/api/fragen', '/old/#/s/api/fragen'], ['/inbox', '/old/#/inbox'], ['/pad', '/old/#/pad']]) {
  const there = await placeAt(place)
  assert.deepEqual([there.status, there.headers.get('location')], [302, to], place)
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
assert.equal((await under('/src/stil.css', `board_${PORT}=falsch`))[0], 401)
for (const no of ['/.geheim.html', '/src/.git/config.json', '/notiz.txt', '/skript.sh', '/zustand.json', '/src/', '/src', '/fehlt.html', '/src/..%2F..%2F..%2F..%2Fpackage.json', '/%2e%2e/%2e%2e/%2e%2e/package.json', '/..%5C..%5Cpackage.json', '/%00.html', '/%zz']) {
  assert.equal((await under(no))[0], 404, no)
}
assert.equal((await fetch(`${base}/css/tokens.css`, { headers: { Cookie: cookie } })).headers.get('content-type'), 'text/css; charset=utf-8')
// routes keep precedence over files
assert.equal((await fetch(`${base}/events/`, { headers: { Cookie: cookie } })).status, 404)
// The page's files go out compressed (brotli or gzip, as the browser takes it), are kept by the browser and asked for
// again with their ETag: unchanged, the answer is a 304 without a body. Never without the login. The stream of states
// is compressed too.
{
  const source = fs.readFileSync(new URL('../client/web/js/app.js', import.meta.url), 'utf8')
  const get = (url, headers = {}) => fetch(base + url, { headers: { Cookie: cookie, ...headers } })
  const plain = await get('/js/app.js', { 'Accept-Encoding': 'identity' })
  assert.deepEqual([plain.status, plain.headers.get('content-encoding'), plain.headers.get('cache-control'), plain.headers.get('vary')], [200, null, 'private, no-cache', 'Accept-Encoding'])
  assert.equal(await plain.text(), source)
  for (const coding of ['gzip', 'br']) {
    const res = await get('/js/app.js', { 'Accept-Encoding': coding })
    assert.deepEqual([res.status, res.headers.get('content-encoding')], [200, coding])
    assert.ok(Number(res.headers.get('content-length')) < Buffer.byteLength(source) / 2, `${coding}: ${res.headers.get('content-length')} bytes`)
    assert.equal(await res.text(), source, coding)
    const tag = res.headers.get('etag')
    assert.ok(tag && tag !== plain.headers.get('etag'), 'each coding has an ETag of its own')
    const again = await get('/js/app.js', { 'Accept-Encoding': coding, 'If-None-Match': tag })
    assert.deepEqual([again.status, await again.text(), again.headers.get('etag')], [304, '', tag])
    assert.equal((await get('/js/app.js', { 'Accept-Encoding': coding, 'If-None-Match': '"other"' })).status, 200)
    assert.equal((await fetch(`${base}/js/app.js`, { headers: { 'If-None-Match': tag } })).status, 401)
  }
  const home = await get('/old/', { 'Accept-Encoding': 'gzip' })
  assert.deepEqual([home.status, home.headers.get('content-encoding'), home.headers.get('cache-control'), Boolean(home.headers.get('etag'))], [200, 'gzip', 'private, no-cache', true])
  assert.equal((await get('/old/', { 'If-None-Match': home.headers.get('etag'), 'Accept-Encoding': 'gzip' })).status, 304)
  for (const [accepts, coding] of [['gzip', 'gzip'], ['identity', null]]) {
    const stream = await get('/events', { 'Accept-Encoding': accepts })
    assert.deepEqual([stream.status, stream.headers.get('content-encoding'), stream.headers.get('cache-control')], [200, coding, 'no-store'])
    const reader = stream.body.getReader()
    // the first state arrives whole, without waiting in the compressor
    let text = ''
    while (!text.includes('\n\n')) { const { value, done } = await reader.read(); if (done) break; text += Buffer.from(value).toString() }
    assert.ok(text.startsWith('data: {') && Array.isArray(JSON.parse(text.split('\n\n')[0].slice(6)).cards), accepts)
    await reader.cancel()
  }
}
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
  assert.match(res.headers.get('set-cookie'), new RegExp(String.raw`^board_admin_${PORT}=[\w-]{32}; HttpOnly; SameSite=Strict; Path=\/admin; Max-Age=43200$`))
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
// the message log, for a session: what it missed of its own conversation, and only its own
{
  const top = (await state()).message_seq
  const reader = new AbortController()
  const linked = await fetch(`http://127.0.0.1:${PORT}/agent/link?name=Leser&instance=leser1`, { headers: { 'x-board-token': 'secret' }, signal: reader.signal })
  const hello = JSON.parse(new TextDecoder().decode((await linked.body.getReader().read()).value).split('\n')[0].slice(6))
  for (const text of ['eins', 'zwei', 'drei']) assert.equal((await post('/message', { text, agent: hello.hello })).status, 200)
  const agentMessages = body => fetch(`http://127.0.0.1:${PORT}/agent/messages`, { method: 'POST', headers: { 'x-board-token': 'secret', 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const missed = await (await agentMessages({ id: hello.hello, instance: 'leser1', since: top + 1, limit: 1 })).json()
  assert.deepEqual([missed.messages.map(m => [m.seq, m.text]), missed.more, missed.message_seq], [[[top + 2, 'zwei']], true, top + 3])
  assert.deepEqual((await (await agentMessages({ id: hello.hello, instance: 'leser1' })).json()).messages.map(m => m.text), ['eins', 'zwei', 'drei'])
  assert.equal((await agentMessages({ id: hello.hello, instance: 'other', since: 0 })).status, 409)
  assert.equal((await agentMessages({ id: 'nobody', since: 0 })).status, 409)
  reader.abort()
  // away again, and forgotten with its words, so the rest of this test sees the board it expects
  await eventually(async () => !(await state()).agents.find(a => a.id === hello.hello).online, 'the reader to go away')
  const forgot = await adminLogin('adminkey', cookie)
  assert.equal((await adminPost('sessions/forget', { id: hello.hello, confirm: hello.hello, data: true }, forgot)).status, 200)
  await adminPost('logout', {}, forgot)
}
// the health check needs no login and says nothing but that the hub answers
const health = await fetch(`${base}/healthz`)
assert.deepEqual([health.status, await health.text()], [200, '{"ok":true}'])
assert.equal((await fetch(`${base}/healthz`, { method: 'POST', headers: { Origin: base }, body: '{}' })).status, 401)
// the hub's own agent cannot be spoken for by someone who merely knows its id
assert.equal((await agentPost('/agent/tool', { id: 'main', name: 'reply', args: { text: 'x' } })).status, 409)
assert.equal((await state()).messages.some(m => m.text === 'x'), false)
// the state file is replaced whole, and only its owner may read it
for (const f of fs.readdirSync(data).filter(f => f.startsWith('pad.db'))) assert.equal(fs.statSync(path.join(data, f)).mode & 0o077, 0, f)
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

// an info: something to read that asks nothing; the human closes it, the agent hears it quietly, and it can be taken back
{
  const textOf = res => res.content[0].text
  const onBoard = async id => (await state()).cards.find(c => c.id === id)
  const question = await ask('gleich dringend, später gestellt', { urgency: 'low' })
  let out = textOf(await call('create_info', { title: 'So läuft die Migration', urgency: 'low', attachments: [shot], sections: [{ text: 'Du wolltest wissen, warum.' }, 'Erst Backup, dann Migration.'] }))
  const info = out.match(/^info (\w+) put on the board as Nr\. \d+, position \d+ of \d+ in the stack; when the human has read and closed it, info_read arrives/)[1]
  s = await state()
  let c = s.cards.find(k => k.id === info)
  assert.deepEqual([c.kind, c.status, c.options, c.multiple, c.recommended, c.version, c.body, c.sections, c.attachments[0].name],
    ['info', 'open', [], false, null, 1, 'Du wolltest wissen, warum.\n\nErst Backup, dann Migration.', [{ text: 'Du wolltest wissen, warum.' }, { text: 'Erst Backup, dann Migration.' }], 'mock.png'])
  assert.deepEqual([s.messages.at(-1).kind, s.messages.at(-1).card_id], ['info', info])
  const early = await call('create_info', { title: 'früher, aber nur zu lesen', body: 'x', urgency: 'low' }).then(r => textOf(r).match(/^info (\w+)/)[1])
  const later = await ask('noch später gestellt', { urgency: 'low' })
  s = await state()
  assert.deepEqual(s.queue.filter(id => [question, info, early, later].includes(id)), [question, info, early, later], 'questions and what is only to be read stand in the order they were filed')
  await call('withdraw_card', { card_id: early })
  await call('withdraw_card', { card_id: later })
  await call('withdraw_card', { card_id: question })
  // it has nothing to choose, and it is no question
  await refused('create_info', { title: 'x', body: 'y', options: [option('a'), option('b')] }, /an info has no options/)
  await refused('create_info', { title: 'x', text: 'Text.\n\n[a] A: x' }, /no block may have a key \(got "a"\)/)
  await refused('create_info', { title: 'x', body: 'y', recommended: 'a' }, /an info has no recommended/)
  await refused('create_info', { title: 'x' }, /needs something to read/)
  await refused('create_info', { title: ' ', body: 'y' }, /needs a title/)
  await refused('create_info', { title: 'x', body: 'y', sections: ['z'] }, /sections and body cannot be combined/)
  await refused('merge_cards', { card_ids: [info, advised], title: 'x', options: [option('a'), option('b')] }, /is an info, not a question/)
  await refused('revise_card', { card_id: info, options: [option('a'), option('b')] }, /an info has no options/)
  for (const wrong of [{ key: 'a' }, { keys: ['a'] }, {}]) assert.equal((await post('/decide', { card_id: info, ...wrong })).status, 400, JSON.stringify(wrong))
  assert.equal((await post('/draft', { card_id: info, keys: [] })).status, 400)
  assert.equal((await post('/reopen', { card_id: info })).status, 400)
  const listed = JSON.parse(textOf(await call('list_cards', {}))).find(k => k.id === info)
  assert.deepEqual([listed.kind, listed.status, listed.options, listed.body.length > 0, listed.sections.length], ['info', 'open', [], true, 2])
  // the human hands it back; the agent reworks it, and it is the same card in a new version
  received.length = 0
  assert.equal((await post('/message', { text: 'zu knapp', card_id: info, handback: true })).status, 200)
  await until(() => received.length === 1)
  assert.deepEqual([received[0].params.meta, (await onBoard(info)).with_agent > 0], [{ kind: 'chat', card_id: info, handback: '1' }, true])
  out = textOf(await call('revise_card', { card_id: info, body: 'Ausführlicher: erst Backup, dann Migration, dann Deploy.', note: 'ausführlicher' }))
  assert.match(out, new RegExp(`^card ${info} revised`))
  assert.doesNotMatch(out, /a lot to read|how something looks/)
  s = await state()
  c = s.cards.find(k => k.id === info)
  assert.deepEqual([c.kind, c.version, c.versions.length, 'sections' in c, c.options, 'with_agent' in c, c.attachments.length], ['info', 2, 1, false, [], false, 1])
  assert.deepEqual([s.messages.at(-1).kind, s.messages.at(-1).text, s.messages.at(-1).again], ['revised', 'Presented again: ausführlicher', true])
  // closing it is all there is to do
  assert.equal((await post('/close', { card_id: advised })).status, 400, 'a question is not closed by reading it')
  assert.equal((await post('/close', { card_id: 'gibtsnicht' })).status, 400)
  assert.equal((await post('/close', { card_id: info }, 'https://evil.example')).status, 403)
  assert.equal((await post('/close', { card_id: info })).status, 200)
  await until(() => received.length === 2)
  assert.deepEqual(received[1].params, { content: 'The human read "So läuft die Migration" and closed it. Nothing is expected of you.', meta: { kind: 'info_read', card_id: info } })
  s = await state()
  c = s.cards.find(k => k.id === info)
  assert.deepEqual([c.status, c.read > 0, c.decided === c.read, c.choice, s.queue.includes(info)], ['done', true, true, null, false])
  assert.deepEqual([s.messages.at(-1).kind, s.messages.at(-1).card_id], ['read', info])
  assert.equal((await post('/close', { card_id: info })).status, 409)
  // taken back it is unread again, and the agent is not bothered
  assert.equal((await post('/reopen', { card_id: info })).status, 200)
  s = await state()
  c = s.cards.find(k => k.id === info)
  assert.deepEqual([c.status, c.read, c.decided, s.queue.includes(info), s.messages.at(-1).kind], ['open', null, null, true, 'reopened'])
  await sleep(100)
  assert.equal(received.length, 2)
  // the agent may take it away itself; then there is nothing to take back
  await call('withdraw_card', { card_id: info, reason: 'überholt' })
  assert.equal((await post('/reopen', { card_id: info })).status, 400)
  received.length = 0
}

// "Shred": the human throws a card away unanswered; it leaves the stack for good, the agent is told not to ask again, and it can be fished out
{
  const onBoard = async id => (await state()).cards.find(c => c.id === id)
  received.length = 0
  const junk = await ask('Brauche ich nicht?')
  await post('/draft', { card_id: junk, keys: ['a'] })
  await call('set_status', { id: 'wartet', label: 'Wartet', state: 'decision', card_id: junk })
  assert.equal((await post('/shred', { card_id: junk }, 'https://evil.example')).status, 403)
  assert.equal((await post('/shred', { card_id: 'gibtsnicht' })).status, 400)
  assert.equal((await post('/shred', { card_id: junk, note: ' egal ' })).status, 200)
  await until(() => received.length === 1)
  assert.deepEqual(received[0].params, {
    content: 'The human threw the question "Brauche ich nicht?" away unanswered. That is neither a yes nor a no. Do not ask it again, in these or other words; carry on without an answer, using your own judgement, or drop the matter.\n\nTheir note: egal',
    meta: { kind: 'shredded', card_id: junk },
  })
  s = await state()
  let k = s.cards.find(c => c.id === junk)
  assert.deepEqual([k.status, k.shredded > 0, k.choice, k.choices, k.note, 'draft' in k, s.queue.includes(junk)], ['shredded', true, null, [], 'egal', false, false])
  assert.deepEqual([s.messages.at(-1).kind, s.messages.at(-1).card_id, s.messages.at(-1).text], ['shredded', junk, 'Brauche ich nicht? · egal'])
  assert.deepEqual((({ state: st, card_id }) => [st, card_id])(s.tasks.find(t => t.id === 'wartet')), ['working', null])
  await call('clear_status', { id: 'wartet' })
  const listed = JSON.parse((await call('list_cards', {})).content[0].text).find(c => c.id === junk)
  assert.deepEqual([listed.status, listed.shredded, listed.queue_position], ['shredded', k.shredded, null])
  // it is no longer there to answer, shred, revise or withdraw
  assert.equal((await post('/shred', { card_id: junk })).status, 409)
  assert.equal((await post('/decide', { card_id: junk, key: 'a' })).status, 400)
  await refused('revise_card', { card_id: junk, title: 'nochmal?' }, /already done/)
  await refused('withdraw_card', { card_id: junk }, /already done/)
  // fished out again it is open as it was, and the agent hears it
  assert.equal((await post('/reopen', { card_id: junk })).status, 200)
  await until(() => received.length === 2)
  assert.deepEqual(received[1].params.meta, { kind: 'decision_reopened', card_id: junk, previous_choice: '', shredded: '1' })
  s = await state()
  k = s.cards.find(c => c.id === junk)
  assert.deepEqual([k.status, k.shredded, k.note, s.queue.includes(junk), s.messages.at(-1).kind], ['open', null, '', true, 'reopened'])
  assert.equal((await post('/shred', { card_id: junk })).status, 200)
  await until(() => received.length === 3)
  // an info can be thrown away too; an approval cannot (checked with the approvals)
  const leaflet = (await call('create_info', { title: 'ungelesen weg', body: 'x' })).content[0].text.match(/^info (\w+)/)[1]
  assert.equal((await post('/shred', { card_id: leaflet })).status, 200)
  await until(() => received.length === 4)
  assert.deepEqual([received[3].params.content, received[3].params.meta, (await onBoard(leaflet)).status], ['The human threw "ungelesen weg" away unread. Do not send it again.', { kind: 'shredded', card_id: leaflet }, 'shredded'])
  received.length = 0
}

// the human hands a card back and thinks better of it: the card is theirs again and the agent is told it need not rework it
{
  received.length = 0
  const back = await ask('Doch nicht zurück?')
  assert.equal((await post('/handback', { card_id: back, clear: true })).status, 409, 'it is not with the agent')
  assert.equal((await post('/message', { text: 'mach neu', card_id: back, handback: true })).status, 200)
  await until(() => received.length === 1)
  assert.ok((await state()).cards.find(c => c.id === back).with_agent > 0)
  assert.equal((await post('/handback', { card_id: back })).status, 400)
  assert.equal((await post('/handback', { card_id: 'gibtsnicht', clear: true })).status, 400)
  assert.equal((await post('/handback', { card_id: back, clear: true })).status, 200)
  await until(() => received.length === 2)
  assert.deepEqual(received[1].params, { content: 'The human took "Doch nicht zurück?" back; there is no need to rework or explain it. If you already have, that is fine.', meta: { kind: 'handback_withdrawn', card_id: back } })
  s = await state()
  assert.deepEqual(['with_agent' in s.cards.find(c => c.id === back), s.messages.at(-1).kind, s.messages.at(-1).card_id], [false, 'handback_withdrawn', back])
  await call('withdraw_card', { card_id: back })
  received.length = 0
}

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

// files from the browser: a chat message carries them, they are stored and served, and the agent is told where they lie
const uploadNote = 'data:text/plain;base64,' + Buffer.from('hallo').toString('base64')
assert.equal((await post('/message', { text: 'schau mal', attachments: [{ name: 'bild.png', data: dot }, { name: '../../notiz.txt', data: uploadNote }] })).status, 200)
await until(() => received.length === 1)
const uploadedMsg = (await state()).messages.at(-1)
assert.deepEqual(uploadedMsg.attachments.map(a => [a.name, a.kind, a.size]), [['bild.png', 'image', fs.statSync(shot).size], ['notiz.txt', 'file', 5]])
const uploadPaths = received[0].params.meta.files.split(',')
assert.deepEqual([received[0].params.content, received[0].params.meta.kind, received[0].params.meta.image_path], ['schau mal', 'chat', uploadPaths[0]])
assert.deepEqual(fs.readFileSync(uploadPaths[0]), fs.readFileSync(shot))
assert.equal(fs.readFileSync(uploadPaths[1], 'utf8'), 'hallo')
assert.ok(uploadPaths.every(p => path.dirname(p) === path.join(data, 'files')), 'a name cannot place a file anywhere else')
assert.equal((await fetch(base + uploadedMsg.attachments[0].url, { headers: { Cookie: cookie } })).headers.get('content-type'), 'image/png')
// a message may be nothing but a file; the agent then reads a sentence that names it
received.length = 0
assert.equal((await post('/message', { text: '', attachments: [{ name: 'nur.png', data: dot }] })).status, 200)
await until(() => received.length === 1)
assert.match(received[0].params.content, /nur\.png/)
// what is no data URL is refused, and one bad entry stores none of them
const uploadsBefore = fs.readdirSync(path.join(data, 'files')).length
assert.equal((await post('/message', { text: 'x', attachments: [{ name: 'gut.png', data: dot }, { name: 'boese', data: 'http://example.org/x.png' }] })).status, 400)
assert.equal((await post('/message', { text: 'x', attachments: 'bild' })).status, 400)
assert.equal((await post('/message', { text: '', attachments: [] })).status, 400)
assert.equal(fs.readdirSync(path.join(data, 'files')).length, uploadsBefore)
assert.equal((await post('/message', { text: 'x', attachments: [{ name: 'bild.png', data: dot }] }, 'http://evil.example')).status, 403)
// with an answer: the files belong to its note; an answer that is not taken keeps none. (An open card is
// answered and taken back again, so that the stack stays as the checks further down expect it.)
received.length = 0
assert.equal((await post('/decide', { card_id: low, key: 'zzz', attachments: [{ name: 'skizze.png', data: dot }] })).status, 400)
assert.equal(fs.readdirSync(path.join(data, 'files')).length, uploadsBefore)
assert.equal((await post('/decide', { card_id: low, key: 'a', note: 'so', attachments: [{ name: 'skizze.png', data: dot }] })).status, 200)
await until(() => received.length === 1)
assert.deepEqual(fs.readFileSync(received[0].params.meta.image_path), fs.readFileSync(shot))
assert.deepEqual((await state()).cards.find(c => c.id === low).note_attachments.map(a => [a.name, a.kind]), [['skizze.png', 'image']])
assert.equal((await post('/reopen', { card_id: low })).status, 200)
await until(() => received.length === 2)
received.length = 0

// the pad: one record per element, behind the login, with a running number for every change
const padGet = async (query = '') => (await fetch(`${base}/pad/elements?pad=global${query}`, { headers: { Cookie: cookie } })).json()
const padEl = (id, rev, rest = {}) => ({ id, pad: 'global', type: 'text', x: 10, y: 20, w: 100, h: 27, rotation: 0, z: 1, group: null, author: 'human', created: 5, updated: 5, rev, blob: null, data: { text: 'Notiz', size: 20, color: 'ink', wrap: null }, sent: [{ session: 'erfunden' }], ...rest })
assert.equal((await fetch(`${base}/pad/elements?pad=global`)).status, 401)
assert.equal((await post('/pad/elements', { pad: 'global', elements: [padEl('padnote000001', 1)] }, 'http://evil.example')).status, 403)
const padEmpty = await padGet()
assert.deepEqual([padEmpty.seq, padEmpty.elements], [0, []])
assert.match(padEmpty.epoch, /^[0-9a-f]{12}$/)
// live changes: a second page hears what the first one writes
const padStream = await fetch(`${base}/pad/events?pad=global&since=0`, { headers: { Cookie: cookie } })
const padHeard = []
;(async () => {
  let buffer = ''
  for await (const chunk of padStream.body) {
    buffer += new TextDecoder().decode(chunk)
    for (let at; (at = buffer.indexOf('\n\n')) >= 0;) {
      const frame = buffer.slice(0, at)
      buffer = buffer.slice(at + 2)
      if (frame.startsWith('data: ')) padHeard.push(JSON.parse(frame.slice(6)))
    }
  }
})().catch(() => {})
const padBefore = Date.now()
let padOut = await (await post('/pad/elements', { pad: 'global', client_id: 'tab-a', elements: [padEl('padnote000001', 1), padEl('padstroke00001', 1, { type: 'stroke', z: 2, data: { tool: 'pen', color: 'ink', size: 4, box: [10, 10], pts: [0, 0, 10, 10] } })] })).json()
assert.deepEqual(padOut.results.map(r => [r.id, r.rev, r.seq]), [['padnote000001', 1, 1], ['padstroke00001', 1, 2]])
// the hub's clock sets "updated", and "sent" is the server's to write
assert.ok(padOut.results[0].updated >= padBefore)
let padNow = await padGet()
assert.deepEqual(padNow.elements.map(e => [e.id, e.rev, e.seq, e.sent, e.updated >= padBefore]), [['padnote000001', 1, 1, [], true], ['padstroke00001', 1, 2, [], true]])
await until(() => padHeard.some(f => f.elements?.length === 2))
assert.deepEqual([padHeard[0].hello, padHeard.find(f => f.elements).client_id], [true, 'tab-a'])
// last writer wins per element: a write that is behind is refused and answered with what counts
padOut = await (await post('/pad/elements', { pad: 'global', elements: [padEl('padnote000001', 2, { x: 50 }), padEl('padstroke00001', 1, { x: 99 })] })).json()
assert.deepEqual(padOut.results.map(r => [r.id, r.error ?? 'ok', r.current?.x]), [['padnote000001', 'ok', undefined], ['padstroke00001', 'conflict', 10]])
assert.equal((await post('/pad/elements', { pad: 'global', elements: [padEl('padnote000001', 3, { type: 'voice' })] }).then(r => r.json())).results[0].error, 'type')
for (const bad of [{ elements: [] }, { elements: [padEl('../x', 1)] }, { elements: [padEl('padnote000002', 0)] }, { elements: [padEl('padnote000002', 1, { type: 'frame' })] }, { elements: [padEl('padnote000002', 1, { data: null })] }]) {
  assert.equal((await post('/pad/elements', { pad: 'global', ...bad })).status, 400, JSON.stringify(bad).slice(0, 80))
}
// a delete is a tombstone, listed only for those who catch up; undoing it writes the element again
const padDelete = await fetch(`${base}/pad/elements/padnote000001`, { method: 'DELETE', headers: { Cookie: cookie, Origin: base } })
assert.deepEqual([padDelete.status, (await padDelete.json()).rev], [200, 3])
assert.equal((await fetch(`${base}/pad/elements/gibtesnicht`, { method: 'DELETE', headers: { Cookie: cookie, Origin: base } })).status, 404)
assert.equal((await fetch(`${base}/pad/elements/padstroke00001`, { method: 'DELETE', headers: { Cookie: cookie } })).status, 403)
assert.deepEqual((await padGet()).elements.map(e => e.id), ['padstroke00001'])
assert.deepEqual((await padGet('&since=2')).elements.map(e => [e.id, e.deleted, e.rev, e.data]), [['padnote000001', true, 3, undefined]])
assert.equal((await post('/pad/elements', { pad: 'global', elements: [padEl('padnote000001', 3)] }).then(r => r.json())).results[0].error, 'conflict')
padOut = await (await post('/pad/elements', { pad: 'global', elements: [padEl('padnote000001', 4, { x: 50 })] })).json()
assert.deepEqual([padOut.results[0].rev, (await padGet()).elements.map(e => [e.id, e.x, e.deleted])], [4, [['padnote000001', 50, undefined], ['padstroke00001', 10, undefined]]])
// bytes of pictures and voice notes
const padBlob = (id, init = {}) => fetch(`${base}/pad/blobs/${id}`, { headers: { Cookie: cookie, Origin: base, 'Content-Type': 'image/png' }, ...init })
assert.equal((await padBlob('padblob0000001', { method: 'PUT', body: fs.readFileSync(shot) })).status, 200)
const padBytes = await padBlob('padblob0000001')
assert.deepEqual([padBytes.status, padBytes.headers.get('content-type'), Buffer.from(await padBytes.arrayBuffer()).equals(fs.readFileSync(shot))], [200, 'image/png', true])
assert.equal((await padBlob('padblob0000002', { method: 'PUT', body: '<script>', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'text/html' } })).status, 200)
assert.equal((await padBlob('padblob0000002')).headers.get('content-type'), 'application/octet-stream')
assert.equal((await padBlob('fehlt000000001')).status, 404)
assert.equal((await padBlob('..%2Ftoken')).status, 404)
assert.equal((await padBlob('padblob0000003', { method: 'PUT', body: 'x', headers: { Cookie: cookie, 'Content-Type': 'image/png' } })).status, 403)
// a picture's element survives its own delete and undo with its bytes
await post('/pad/elements', { pad: 'global', elements: [padEl('padimage000001', 1, { type: 'image', blob: 'padblob0000001', data: { mime: 'image/png', nw: 1, nh: 1, name: '' } })] })
await post('/pad/elements', { pad: 'global', elements: [{ id: 'padimage000001', pad: 'global', deleted: true, author: 'human', rev: 2 }] })
assert.equal((await padBlob('padblob0000001')).status, 200, 'the file stays while the tombstone does')
await post('/pad/elements', { pad: 'global', elements: [padEl('padimage000001', 3, { type: 'image', blob: 'padblob0000001', data: { mime: 'image/png', nw: 1, nh: 1, name: '' } })] })
assert.equal((await padGet()).elements.find(e => e.id === 'padimage000001').blob, 'padblob0000001')
// sending a selection: the session gets the words and a picture it can open, the conversation shows it, the elements remember
const padSend = body => post('/pad/send', { pad: 'global', session: 'main', elements: [{ id: 'padnote000001', type: 'text', rev: 4 }, { id: 'padstroke00001', type: 'stroke', rev: 1 }], text: 'Notiz', bbox: { x: 0, y: 0, w: 1, h: 1 }, png: dot, ...body })
const padSent = await padSend({})
assert.equal(padSent.status, 200)
const padSentOut = await padSent.json()
await until(() => received.length === 1)
const padMeta = received[0].params.meta
assert.deepEqual([received[0].params.content, padMeta.kind, padMeta.pad, padMeta.elements, padMeta.message_id], ['Notiz', 'pad', 'global', 'padnote000001,padstroke00001', padSentOut.message_id])
assert.deepEqual(fs.readFileSync(padMeta.image_path), fs.readFileSync(shot))
const padMessage = (await state()).messages.at(-1)
assert.deepEqual([padMessage.id, padMessage.from, padMessage.agent, padMessage.text, padMessage.attachments[0].image], [padSentOut.message_id, 'user', 'main', 'Notiz', true])
assert.equal((await fetch(base + padMessage.attachments[0].url, { headers: { Cookie: cookie } })).headers.get('content-type'), 'image/png')
padNow = await padGet()
assert.deepEqual(padNow.elements.map(e => [e.id, e.rev, e.sent.map(l => [l.session, l.message_id, l.rev])]), [
  ['padimage000001', 3, []], ['padnote000001', 4, [['main', padSentOut.message_id, 4]]], ['padstroke00001', 1, [['main', padSentOut.message_id, 1]]],
])
assert.deepEqual(padSentOut.elements.map(e => e.id), ['padnote000001', 'padstroke00001'])
await until(() => padHeard.some(f => f.elements?.some(e => e.sent?.length)))
assert.equal(padNow.seq, padSentOut.seq)
// without words the agent is told to look at the picture; what cannot be sent says why
received.length = 0
assert.equal((await padSend({ text: '' })).status, 200)
await until(() => received.length === 1)
assert.match(received[0].params.content, /image_path/)
assert.deepEqual([(await padSend({ session: 'niemand' })).status, (await padSend({ png: 'data:text/html;base64,AAAA' })).status, (await padSend({ elements: [] })).status, (await padSend({ elements: [{ id: 'gibtesnicht' }] })).status], [404, 400, 400, 409])
await padStream.body.cancel().catch(() => {})
// the pad's store is a SQLite file of its own beside state.json: read again from disk it is the same pad
assert.ok(fs.existsSync(path.join(data, 'pad.db')) && !JSON.stringify(readBoard(data)).includes('padnote000001'))
assert.equal(fs.statSync(path.join(data, 'pad', 'blobs')).mode & 0o777, 0o700)
const { openPadStore, padSupport } = await import('./pad.mjs')
assert.equal(padSupport(), null)
const padAgain = await openPadStore(data)
assert.deepEqual([padAgain.seq, padAgain.epoch, padAgain.list('global').elements], [padNow.seq + 1, padNow.epoch, (await padGet()).elements])
assert.equal(padAgain.list('global', 0).elements.length, 3)
padAgain.close()
received.length = 0

// speech is optional: without a key the board says so instead of failing oddly
assert.equal((await state()).speech, false)
await refused('create_voiceover', { text: 'hallo' }, /not set up/)
// dictation was removed (out of scope for launch): its routes are gone
for (const route of ['/speech/transcribe', '/speech/live']) assert.equal((await fetch(`${base}${route}`, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'audio/webm' }, body: 'x' })).status, 404, route)

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
const linkOf = said => said.match(new RegExp(String.raw`http:\/\/localhost:${PORT}\/a\/([\w-]{22})#([\w-]{43})(?=\s|$)`)).slice(1)
const publish = async (who, args) => (await who.callTool({ name: 'publish_asset', arguments: args })).content[0].text
const blobOf = async id => Buffer.from(await (await fetch(`${base}/a/${id}/blob`, { headers: { Cookie: cookie } })).arrayBuffer())
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
// the blob is served to who is signed in (card Nr. 175), and it is the same ciphertext
const signedIn = { headers: { Cookie: cookie } }
const served = await fetch(`${base}/a/${aid}/blob`, signedIn)
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
// the viewer is served to who is signed in, under a policy that lets it load only itself
const viewer = await fetch(`${base}/a/${aid}`, signedIn)
const policy = viewer.headers.get('content-security-policy')
assert.deepEqual([viewer.status, viewer.headers.get('content-type'), viewer.headers.get('referrer-policy')], [200, 'text/html; charset=utf-8', 'no-referrer'])
for (const rule of ["default-src 'none'", "script-src 'self'", "frame-ancestors 'none'", "form-action 'none'", "base-uri 'none'"]) assert.ok(policy.includes(rule), rule)
assert.ok(!/unsafe|https?:|\*/.test(policy), 'nothing inline and nothing foreign in the viewer')
assert.ok(!(await viewer.text()).includes(akey))
for (const file of ['asset.js', 'asset.css', 'tokens.css']) assert.deepEqual([(await fetch(`${base}/a/-/${file}`, signedIn)).status, (await fetch(`${base}/a/-/${file}`)).status], [200, 401], file)
// an HTML asset runs in a frame with a policy of its own: its own scripts, no network, no origin
const frame = await fetch(`${base}/a/-/frame.html`)
const framed = frame.headers.get('content-security-policy')
assert.equal(frame.status, 200)
for (const rule of ["default-src 'none'", 'sandbox allow-scripts', "frame-ancestors 'self'", "form-action 'none'"]) assert.ok(framed.includes(rule), rule)
assert.ok(!/allow-same-origin|allow-top|allow-popups|allow-forms|connect-src|https?:|\*/.test(framed))
// the same page answers for any address, so it does not say which assets exist; the blob does
assert.equal((await fetch(`${base}/a/${'A'.repeat(22)}`, signedIn)).status, 200)
assert.equal((await fetch(`${base}/a/${'A'.repeat(22)}/blob`, signedIn)).status, 404)
// assets only with the login (card Nr. 175): without it the link opens nothing. The page is the sign-in page (the key
// stays behind the #), the ciphertext a plain 401, and neither tells an asset that exists from one that does not
for (const id of [aid, 'A'.repeat(22)]) {
  const [shut, door] = [await fetch(`${base}/a/${id}/blob`), await fetch(`${base}/a/${id}`)]
  const doorText = await door.text()
  assert.deepEqual([shut.status, await shut.text(), door.status, /Sign in with a passkey/.test(doorText), doorText.includes('asset.js')], [401, '{"error":"unauthorised"}', 401, true, false], id)
}
// not with a wrong cookie; a process on this machine with the board token gets it (an agent's own access), a proxied caller with it does not
assert.equal((await fetch(`${base}/a/${aid}/blob`, { headers: { Cookie: `board_${PORT}=wrong` } })).status, 401)
assert.deepEqual(Buffer.from(await (await fetch(`http://127.0.0.1:${PORT}/a/${aid}/blob`, { headers: { 'x-board-token': 'secret' } })).arrayBuffer()), stored)
assert.equal((await fetch(`http://127.0.0.1:${PORT}/a/${aid}/blob`, { headers: { 'x-board-token': 'secret', 'X-Forwarded-For': '100.64.0.9' } })).status, 401)
assert.equal((await fetch(`http://127.0.0.1:${PORT}/a/${aid}/blob`, { headers: { 'x-board-token': 'wrong' } })).status, 401)
// the login link leads to the asset's page (the browser keeps the #key across the redirect)
const viaLink = await fetch(`${base}/a/${aid}?t=secret`, { redirect: 'manual' })
assert.deepEqual([viaLink.status, viaLink.headers.get('location'), new RegExp(String.raw`^board_${PORT}=secret;`).test(viaLink.headers.get('set-cookie'))], [302, `/a/${aid}`, true])
// everything else still wants the login
for (const closed of ['/', '/a.html', '/js/asset.js', '/css/tokens.css', '/events', '/api/tools', '/help.html', '/files/x.png', '/a', '/assets']) assert.equal((await fetch(base + closed)).status, 401, closed)
// no path out of the folder, nothing but GET, nothing but the three files
for (const odd of ['/a/..%2Ftoken/blob', '/a/..%2F..%2Fstate.json', '/a/-/..%2F..%2Findex.html', '/a/-/app.js', '/a/-/constructor', `/a/${aid}/blob/x`, `/a/${aid}/`, '/a/token/blob', `/a/${aid}%00/blob`, '/a/-/']) {
  assert.equal((await fetch(base + odd, signedIn)).status, 404, odd)
  assert.notEqual((await fetch(base + odd)).status, 200, odd)
}
assert.notEqual(await rawGet(`/a/${aid}/../../token`), 200)
assert.equal((await fetch(`${base}/a/${aid}/blob`, { method: 'POST', headers: { Origin: base }, body: 'x' })).status, 404)

// a silent asset: the hub is told neither key nor title nor type, and nothing appears on the board
const hush = await publish(client, { content: '<p>nur für dich Geheimwort</p>', title: 'Stiller Titel', silent: true, keep: true })
const [qid, qkey] = linkOf(hush)
assert.match(hush, /kept until revoked[\s\S]*The hub never saw the key/)
s = await state()
assert.equal(s.messages.length, talk + 1)
assert.deepEqual({ ...s.assets.at(-1), created: 0, size: 0 }, { id: qid, agent: 'main', type: null, title: '', size: 0, created: 0, keep: true, silent: true, wrapped_key: null })
const quiet = await openAsset(await blobOf(qid), qkey, qid)
assert.deepEqual([quiet.header.type, quiet.header.title, quiet.header.name, quiet.content.toString()], ['html', 'Stiller Titel', 'page.html', '<p>nur für dich Geheimwort</p>'])
// the type follows the file, and bytes come back as they went in
const [pid, pkey] = linkOf(await publish(client, { path: shot }))
const picture = await openAsset(await blobOf(pid), pkey, pid)
assert.deepEqual([picture.header.type, picture.header.mime, picture.header.title, picture.content.equals(fs.readFileSync(shot))], ['image', 'image/png', 'mock.png', true])
// neither the state, as the page gets it and as it lies on disk, nor the admin export knows the silent key or title;
// the key of an asset shown on the board is in all three today, in the message that carries the link
const exportA = await adminLogin('adminkey', cookie)
const known = [JSON.stringify(await state()), JSON.stringify(readBoard(data)), await (await adminGet('export', exportA)).text()]
for (const place of known) {
  for (const hidden of [qkey, 'Stiller Titel', 'Geheimwort']) assert.ok(!place.includes(hidden), `the hub knows "${hidden}"`)
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
assert.equal((await fetch(`${base}/a/${aid}/blob`, signedIn)).status, 404)
assert.equal(fs.existsSync(path.join(data, 'assets', aid)), false)
s = await state()
assert.deepEqual([s.assets.map(a => a.id), s.messages[talk].text, s.messages[talk].asset], [[qid, pid], '**Lasttest** (withdrawn)', { id: aid, type: 'html', title: 'Lasttest', gone: true }])
// a message that was already out changed: a page that comes back with an older number gets the whole list again
assert.equal(s.message_floor, s.message_seq + 1)
{
  const stale = await sinceStream(s.message_seq)
  const f = await stale.next()
  assert.deepEqual([f.messages_since, f.messages.length, f.messages[talk].asset.gone], [0, s.messages.length, true])
  await stale.close()
}
assert.ok(!JSON.stringify(readBoard(data)).includes(akey), 'the hub forgot the key with the asset')
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
assert.deepEqual(kinds.map(e => e.kind), ['chat', 'decision', 'decision_reopened', 'shredded', 'handback_withdrawn', 'info_read', 'scribble', 'pad'])
for (const event of kinds) {
  const real = heard.find(n => n.method === event.method && n.params.meta.kind === event.kind)
  assert.deepEqual(Object.keys(real.params.meta).sort(), Object.keys(event.meta).sort(), event.kind)
  assert.match(event.example, new RegExp(`^<channel source="board" kind="${event.kind}"`))
}
const verdict = reference.events.find(e => e.method === 'notifications/claude/channel/permission')
assert.deepEqual(Object.keys(heard.find(n => n.method === verdict.method).params).sort(), Object.keys(verdict.params).sort())
assert.deepEqual(Object.keys(reference.events.find(e => e.method.endsWith('/permission_request')).params), ['request_id', 'tool_name', 'description', 'input_preview'])
assert.deepEqual(kinds.map(e => Object.keys(e.optional ?? {})), [['card_id', 'handback', 'explain', 'cards', 'cards_json', 'marks', 'files', 'image_path'], ['choices', 'trust', 'marks', 'option_notes', 'files', 'image_path'], ['previous_choices', 'trust', 'shredded'], ['marks', 'files', 'image_path'], [], [], [], []])
assert.ok(reference.tools[0].inputSchema.properties.card_id)
assert.deepEqual(reference.events.map(e => e.direction), ['to_agent', 'to_agent', 'to_agent', 'to_agent', 'to_agent', 'to_agent', 'to_agent', 'to_agent', 'to_agent', 'from_client', 'from_client'])

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
const saved = readBoard(data)
assert.deepEqual(saved.queue, [low, high, normal2])
assert.equal(saved.next_number, 21)
await client.close()
client = await start()
assert.deepEqual((await state()).queue, [low, high, normal2])
const late = await ask('nach dem Neustart', { urgency: 'high' })
s = await state()
assert.equal(s.cards.at(-1).number, 21)
assert.deepEqual(s.queue, [low, high, normal2, late], 'a new card goes to the end, however urgent')

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

{
const textOf = res => res.content[0].text
// revising: an open card is rewritten in place, keeps id, number and place, and the conversation says so
const stackBefore = (await state()).queue
const rev = await ask('Welche Architektur?', { body: 'unklar', recommended: 'a' })
const revNumber = (await state()).cards.at(-1).number
let out = textOf(await call('revise_card', { card_id: rev, title: 'Monolith oder Dienste?', options: [{ key: 'a', label: 'Monolith' }, { key: 'dienste', label: 'Dienste', detail: 'mehr Betrieb' }], note: 'Optionen benannt' }))
assert.match(out, new RegExp(`^card ${rev} revised, still Nr\\. ${revNumber}, position ${stackBefore.length + 1} of ${stackBefore.length + 1} in the stack$`))
s = await state()
let revised = s.cards.find(c => c.id === rev)
assert.deepEqual([revised.number, revised.status, revised.title, revised.body, revised.recommended, revised.revisions], [revNumber, 'open', 'Monolith oder Dienste?', 'unklar', 'a', 1])
assert.deepEqual(revised.options, [{ key: 'a', label: 'Monolith', detail: '' }, { key: 'dienste', label: 'Dienste', detail: 'mehr Betrieb' }])
assert.ok(revised.revised >= revised.created)
assert.deepEqual(s.queue, [...stackBefore, rev])
assert.deepEqual([s.messages.at(-1).from, s.messages.at(-1).kind, s.messages.at(-1).card_id, s.messages.at(-1).text], ['event', 'revised', rev, 'Optionen benannt'])
// an answer holds for the question the human read: a key that is gone, or a page that saw the earlier wording, is refused and says why
await sleep(300)
let stale = await post('/decide', { card_id: rev, key: 'b' })
assert.equal(stale.status, 409)
assert.match((await stale.json()).error, /the agent revised this question while you were answering/)
assert.equal((await post('/decide', { card_id: rev, key: 'a', revised: null })).status, 409, 'the page had not seen the revision')
assert.equal((await post('/decide', { card_id: rev, key: 'a', revised: revised.revised - 1 })).status, 409)
// nor one that comes so soon after a rewrite that nobody can have read it
await call('revise_card', { card_id: rev, body: 'Für den Prototyp' })
s = await state()
revised = s.cards.find(c => c.id === rev)
assert.equal(s.messages.at(-1).text, 'Monolith oder Dienste?', 'without a note the marker shows the title')
assert.equal((await post('/decide', { card_id: rev, key: 'a', revised: revised.revised })).status, 409)
assert.equal((await state()).cards.find(c => c.id === rev).status, 'open')
// urgency alone is no revision: the card is marked and stays where it is, the wording and its stamp stay
out = textOf(await call('revise_card', { card_id: rev, urgency: 'critical', urgency_reason: 'alles steht' }))
assert.match(out, /unchanged in wording/)
s = await state()
assert.deepEqual((({ urgency, urgency_reason, revised: at, revisions }) => [urgency, urgency_reason, at, revisions])(s.cards.find(c => c.id === rev)), ['critical', 'alles steht', revised.revised, 2])
assert.deepEqual([s.queue.indexOf(rev) === stackBefore.length, s.messages.at(-1).kind, s.messages.at(-1).card_id, s.messages.at(-1).text], [true, 'urgency', rev, 'Blocking: alles steht'])
// advice that names an option which is gone is dropped; a list needs a card that takes several
await call('revise_card', { card_id: rev, options: [{ key: 'x', label: 'Eins' }, { key: 'y', label: 'Zwei' }], urgency: 'normal' })
revised = (await state()).cards.find(c => c.id === rev)
assert.deepEqual([revised.recommended, revised.urgency, revised.urgency_reason, revised.revisions], [null, 'normal', '', 3])
await call('revise_card', { card_id: rev, multiple: true, recommended: ['x', 'y'] })
await call('revise_card', { card_id: rev, options: [{ key: 'y', label: 'Zwei' }, { key: 'z', label: 'Drei' }] })
assert.deepEqual((await state()).cards.find(c => c.id === rev).recommended, ['y'])
await call('revise_card', { card_id: rev, recommended: [] })
assert.equal((await state()).cards.find(c => c.id === rev).recommended, null, 'an empty recommendation clears the advice')
await refused('revise_card', { card_id: rev }, /nothing to revise: pass at least one of title, body, options/)
await refused('revise_card', { card_id: rev, options: [option('a')] }, /at least two entries/)
await refused('revise_card', { card_id: rev, recommended: 'weg' }, /recommended must be the key of one of the options; got "weg"/)
await refused('revise_card', { card_id: rev, multiple: false, recommended: ['y', 'z'] }, /needs multiple: true/)
await refused('revise_card', { card_id: 'nope', title: 'x' }, /no card nope/)
revised = (await state()).cards.find(c => c.id === rev)
assert.deepEqual([revised.multiple, revised.revisions], [true, 6], 'a refused revision changes nothing')
// answered as it now stands, it is an ordinary decision; after that it is no longer the agent's to rewrite
await sleep(300)
assert.equal((await post('/decide', { card_id: rev, keys: ['z'], revised: revised.revised })).status, 200)
await until(() => received.length === 1)
assert.deepEqual(received[0].params.meta, { kind: 'decision', card_id: rev, choice: 'z', choices: 'z' })
await refused('revise_card', { card_id: rev, title: 'doch anders' }, /already decided \(choice: z\); the human answered the question as it stood/)
await call('close_card', { card_id: rev })
await refused('revise_card', { card_id: rev, title: 'doch anders' }, /already done/)
const listedRev = JSON.parse(textOf(await call('list_cards', {}))).find(c => c.id === rev)
assert.equal(listedRev.revised, revised.revised)
received.length = 0

// merging: several open cards become one new card in one step; the old ones point at it, and it says what it replaces
const m1 = await ask('Datenbank: SQLite?', { urgency: 'low' })
const m2 = await ask('Anhänge als Dateien?', { urgency: 'high', urgency_reason: 'der Umbau wartet' })
const m3 = await ask('Sync zwischen Hubs?')
assert.equal((await post('/message', { text: 'was heißt Sync?', card_id: m3 })).status, 200)
await until(() => received.length === 1)
await call('reply', { text: 'Abgleich zweier Rechner', card_id: m3 })
await call('set_status', { id: 'arch', label: 'Architektur', state: 'decision', card_id: m2 })
s = await state()
const olds = [m1, m2, m3].map(id => s.cards.find(c => c.id === id))
const merge = { title: 'Welchen Teilen stimmst du zu?', body: 'Kreuze an, was ich bauen darf.', multiple: true, recommended: ['sqlite', 'files'], options: [{ key: 'sqlite', label: 'SQLite' }, { key: 'files', label: 'Anhänge als Dateien' }, { key: 'sync', label: 'Sync' }] }
// refused merges leave every card as it was
await refused('merge_cards', { ...merge, card_ids: [m1] }, /at least two cards; to change one card use revise_card/)
await refused('merge_cards', { ...merge, card_ids: [m1, m1] }, /at least two cards/)
await refused('merge_cards', { ...merge, card_ids: [m1, 'nope'] }, /no card nope/)
await refused('merge_cards', { ...merge, card_ids: [m1, m2, rev] }, /already done/)
await refused('merge_cards', { ...merge, card_ids: [m1, m2, late], options: [option('a')] }, /at least two entries/)
await refused('merge_cards', { ...merge, card_ids: 'alle' }, /card_ids must be a list/)
assert.deepEqual((await state()).cards.filter(c => [m1, m2, m3].includes(c.id)).map(c => c.status), ['open', 'open', 'open'])
out = textOf(await call('merge_cards', { ...merge, card_ids: [m1, m2, m3] }))
const merged = out.match(/^card (\w+) created as Nr\. (\d+), replacing Nr\. ([\d, ]+), position \d+ of \d+ in the stack; answers to the replaced cards will no longer arrive/)
assert.ok(merged, out)
assert.equal(merged[3], olds.map(c => c.number).join(', '))
s = await state()
const one = s.cards.find(c => c.id === merged[1])
assert.equal(one, s.cards.at(-1))
assert.deepEqual(one.merged_from, olds.map(c => ({ id: c.id, number: c.number, title: c.title })))
assert.deepEqual([one.number, one.status, one.multiple, one.recommended, one.urgency, one.urgency_reason, one.created], [Number(merged[2]), 'open', true, ['sqlite', 'files'], 'high', 'der Umbau wartet', olds[0].created], 'as pressing as the most pressing, as old as the oldest')
for (const c of [m1, m2, m3].map(id => s.cards.find(x => x.id === id))) {
  assert.deepEqual([c.status, c.choice, c.merged_into, c.summary], ['done', null, one.id, `Merged into Nr. ${one.number}: Welchen Teilen stimmst du zu?`])
  assert.ok(!s.queue.includes(c.id))
}
assert.ok(s.queue.includes(one.id))
assert.deepEqual(s.messages.slice(-4).map(m => [m.kind, m.card_id]), [['asked', one.id], ['done', m1], ['done', m2], ['done', m3]])
// what was asked back about an old card is still in the conversation, and the status line waits on the new card
assert.deepEqual(s.messages.filter(m => m.card_id === m3 && m.from !== 'event').map(m => [m.from, m.text]), [['user', 'was heißt Sync?'], ['agent', 'Abgleich zweier Rechner']])
assert.deepEqual((({ state: light, card_id }) => [light, card_id])(s.tasks.find(t => t.id === 'arch')), ['decision', one.id])
assert.equal((await post('/decide', { card_id: m1, key: 'a' })).status, 400, 'a replaced card cannot be answered')
await refused('merge_cards', { ...merge, card_ids: [m1, one.id] }, /already done/)
const listedOne = JSON.parse(textOf(await call('list_cards', {})))
assert.deepEqual(listedOne.find(c => c.id === one.id).merged_from, olds.map(c => c.number))
assert.equal(listedOne.find(c => c.id === m1).merged_into, one.id)
assert.deepEqual(listedOne.find(c => c.id === one.id).options.map(o => o.key), ['sqlite', 'files', 'sync'], 'open cards are listed with what they ask')
assert.equal((await post('/decide', { card_id: one.id, keys: ['sqlite', 'files'] })).status, 200)
await until(() => received.length === 2)
assert.deepEqual(received[1].params.meta, { kind: 'decision', card_id: one.id, choice: 'sqlite', choices: 'sqlite,files' })
await refused('merge_cards', { ...merge, card_ids: [late, one.id] }, /already decided \(choice: sqlite\)/)
assert.equal((await state()).cards.find(c => c.id === late).status, 'open')
await call('close_card', { card_id: one.id })
await call('clear_status', { id: 'arch' })

// the hub nudges: a session that files a question while three of its own are open is reminded to bundle, and shown them
s = await state()
const mineOpen = s.cards.filter(c => c.agent === one.agent && c.kind === 'decision' && c.status === 'open')
assert.ok(mineOpen.length >= 3)
out = textOf(await call('create_decision', { title: 'noch  eine\nFrage', options: [option('a'), option('b')] }))
const extra = out.match(/^card (\w+) created as Nr\. (\d+), /)
assert.match(out, new RegExp(`\\nYou now have ${mineOpen.length + 1} open questions\\. If some of them are one subject, replace them by one with merge_cards .* revise_card`))
assert.deepEqual(out.split('\n').slice(2), [...mineOpen.map(c => `Nr. ${c.number} (${c.id}, ${c.urgency}): ${c.title}`), `Nr. ${extra[2]} (${extra[1]}, normal): noch eine Frage`])
await call('withdraw_card', { card_id: extra[1] })

// and says, without refusing, when a card is a lot to read
out = textOf(await call('create_decision', { title: 'lang', body: 'x'.repeat(301), options: [{ key: 'a', label: 'A', detail: 'y'.repeat(60) }, { key: 'b', label: 'B', detail: 'y'.repeat(61) }, { key: 'c', label: 'C', detail: 'z'.repeat(80) }] }))
const wordy = out.match(/^card (\w+) /)[1]
assert.match(out, /\nThis is a lot to read: the body has 301 characters \(aim for at most about 300, one or two short sentences\); the detail of "b", "c" is longer than one short line \(aim for about six words\)\. A question has to fit one card on one screen: a title of one line \(about 70 characters\), a body of at most about 300 characters or 5 short lines, per option a label of at most 4 words and a detail of one short line \(about six words\), at most 10 options\. Shorten it with revise_card: say it in a picture rather than in prose, and move the background to an attached page or a published asset linked from the body/)
assert.equal((await state()).cards.at(-1).status, 'open')
out = textOf(await call('revise_card', { card_id: wordy, body: 'x'.repeat(300) }))
assert.match(out, /\nThis is a lot to read: the detail of "b", "c" is longer/)
assert.doesNotMatch(out, /the body has/)
out = textOf(await call('revise_card', { card_id: wordy, options: [{ key: 'a', label: 'A', detail: 'kurz' }, { key: 'b', label: 'B' }] }))
assert.doesNotMatch(out, /a lot to read/)
// the other parts of the budget: a title of more than a line, more than five lines, a label that is a sentence
out = textOf(await call('revise_card', { card_id: wordy, title: 't'.repeat(91), body: 'eins\nzwei\ndrei\nvier\nfünf\nsechs', options: [{ key: 'a', label: 'eins zwei drei vier fünf sechs sieben' }, { key: 'b', label: 'eins zwei drei vier fünf sechs' }] }))
assert.match(out, /\nThis is a lot to read: the title has 91 characters \(aim for one line, about 70\); the body has 6 lines \(aim for at most 5 short ones\); the label of "a" is longer than about 4 words\. A question has to fit one card on one screen/)
assert.equal((await state()).cards.find(c => c.id === wordy).status, 'open', 'said, not refused')
assert.doesNotMatch(textOf(await call('revise_card', { card_id: wordy, title: 't'.repeat(90), body: 'eins\nzwei\ndrei\nvier\nfünf', options: [{ key: 'a', label: 'eins zwei drei vier' }, { key: 'b', label: 'B' }] })), /a lot to read/)
await call('withdraw_card', { card_id: wordy })
received.length = 0
}

{
// a question as one structured text: flagged blocks become the options, and body and recommended are derived
const textOf = res => res.content[0].text
const mine = async id => JSON.parse(textOf(await call('list_cards', {}))).find(c => c.id === id)
const onBoard = async id => (await state()).cards.find(c => c.id === id)
const blocks = [
  { text: '  Drei Teile, kreuze an.  ' },
  { key: 'sqlite', label: 'SQLite', recommended: true, text: 'Eine Datei, kein Server.' },
  'Dazwischen ein Satz.',
  { key: 'files', label: 'Dateien', text: 'Bilder als Dateien.', picture: 'mock.png' },
  { key: 'sync', label: 'Abgleich', recommended: true, text: '', picture: 0 },
]
let out = textOf(await call('create_decision', { title: 'Speicherplan?', multiple: true, sections: blocks, attachments: [shot] }))
const sec = out.match(/^card (\w+) /)[1]
assert.doesNotMatch(out, /a lot to read/)
let c = await onBoard(sec)
assert.deepEqual(c.sections, [
  { text: 'Drei Teile, kreuze an.' },
  { key: 'sqlite', label: 'SQLite', text: 'Eine Datei, kein Server.', recommended: true },
  { text: 'Dazwischen ein Satz.' },
  { key: 'files', label: 'Dateien', text: 'Bilder als Dateien.', recommended: false, picture: 0 },
  { key: 'sync', label: 'Abgleich', text: '', recommended: true, picture: 0 },
])
assert.deepEqual(c.options, [{ key: 'sqlite', label: 'SQLite', detail: '' }, { key: 'files', label: 'Dateien', detail: '' }, { key: 'sync', label: 'Abgleich', detail: '' }])
assert.deepEqual([c.recommended, c.multiple, c.attachments[0].name], [['sqlite', 'sync'], true, 'mock.png'])
assert.equal(c.body, 'Drei Teile, kreuze an.\n\n**SQLite**: Eine Datei, kein Server.\n\nDazwischen ein Satz.\n\n**Dateien**: Bilder als Dateien.\n\n**Abgleich**')
// the agent gets its blocks back to revise them, and the answer arrives by key as ever
assert.deepEqual((await mine(sec)).sections, c.sections)

// what is refused: both forms at once, a flagged block without a label, fewer than two options, twice the same key, a picture the card does not have, two marks on a card with one answer
const two = [{ key: 'a', label: 'A', text: 'x' }, { key: 'b', label: 'B', text: 'y' }]
await refused('create_decision', { title: 'x', sections: two, options: [option('a'), option('b')] }, /sections and options cannot be combined/)
await refused('create_decision', { title: 'x', text: '[a] A: x\n\n[b] B: y', options: [option('a'), option('b')] }, /text and options cannot be combined/)
await refused('create_decision', { title: 'x', sections: two, body: 'vorweg' }, /sections and body cannot be combined/)
await refused('create_decision', { title: 'x', sections: two, text: '[a] A: x\n\n[b] B: y' }, /sections or text, not both/)
await refused('create_decision', { title: 'x', sections: [{ key: 'a', text: 'x' }, two[1]] }, /section "a" has a key, so it becomes an option and needs a label/)
await refused('create_decision', { title: 'x', sections: [{ text: 'nur Text' }, two[0]] }, /at least two options with unique keys: flag at least two blocks/)
await refused('create_decision', { title: 'x', sections: [two[0], two[0]] }, /unique keys/)
await refused('create_decision', { title: 'x', sections: [{ text: ' ' }, ...two] }, /section 1 is empty/)
await refused('create_decision', { title: 'x', sections: 'kein Feld' }, /sections must be a list/)
await refused('create_decision', { title: 'x', sections: [{ ...two[0], picture: 'fehlt.png' }, two[1]], attachments: [shot] }, /section "a" names the picture "fehlt\.png", which is not among this card's attachments \(0: mock\.png\)/)
await refused('create_decision', { title: 'x', sections: [{ ...two[0], picture: 1 }, two[1]], attachments: [shot] }, /names the picture "1"/)
await refused('create_decision', { title: 'x', sections: [{ ...two[0], picture: 'mock.png' }, two[1]] }, /it has none/)
await refused('create_decision', { title: 'x', sections: two.map(b => ({ ...b, recommended: true })) }, /recommended as a list needs multiple: true/)
await refused('create_decision', { title: 'x', sections: two, recommended: 'zzz' }, /recommended must be the key of one of the options; got "zzz"/)
assert.equal((await state()).cards.at(-1).id, sec, 'a refused question leaves no card')

// recommended said outright wins over the marks, and the marks follow it
out = textOf(await call('create_decision', { title: 'eine Antwort', sections: [{ ...two[0], recommended: true }, two[1]], recommended: 'b' }))
const single = out.match(/^card (\w+) /)[1]
c = await onBoard(single)
assert.deepEqual([c.recommended, c.multiple, c.sections.map(b => b.recommended)], ['b', false, [false, true]])
await call('withdraw_card', { card_id: single })

// the same as one text block: paragraphs, of which those starting with [key] are options
out = textOf(await call('create_decision', {
  title: 'Export?', attachments: [shot],
  text: 'Der Export läuft in ein Limit.\r\n\r\n[limit*] Limit anheben: 60 statt 30 Sekunden.\nGeht schnell.\n\n\n[async] Im Hintergrund (recommended)\nDie Datei kommt per Mail: etwa zwei Tage.\npicture: mock.png\n\n  [page] Nur blättern  \n\nSiehe [das Protokoll](https://example.org) dazu.\n\n[x.y-z] Zeit 12:30 Uhr:\nPICTURE: 0',
  multiple: true,
}))
const block = out.match(/^card (\w+) /)[1]
c = await onBoard(block)
assert.deepEqual(c.sections, [
  { text: 'Der Export läuft in ein Limit.' },
  { key: 'limit', label: 'Limit anheben', text: '60 statt 30 Sekunden.\nGeht schnell.', recommended: true },
  { key: 'async', label: 'Im Hintergrund', text: 'Die Datei kommt per Mail: etwa zwei Tage.', recommended: true, picture: 0 },
  { key: 'page', label: 'Nur blättern', text: '', recommended: false },
  { text: 'Siehe [das Protokoll](https://example.org) dazu.' },
  { key: 'x.y-z', label: 'Zeit 12:30 Uhr', text: '', recommended: false, picture: 0 },
])
assert.deepEqual([c.options.map(o => o.key), c.recommended], [['limit', 'async', 'page', 'x.y-z'], ['limit', 'async']])
await refused('create_decision', { title: 'x', text: 'Nur ein Absatz.\n\n[a] A: allein' }, /paragraphs starting with \[key\] Label:/)
await refused('create_decision', { title: 'x', text: '[a]\n\n[b] B: y' }, /section "a" has a key/)
await call('withdraw_card', { card_id: block })

// a long block draws the hint, the derived body does not, and no block is refused for its length
out = textOf(await call('create_decision', { title: 'lang', sections: [{ text: 'x'.repeat(400) }, { key: 'a', label: 'A', text: 'y'.repeat(401) }, { key: 'b', label: 'B', text: 'z'.repeat(400) }, { text: 'w'.repeat(450) }] }))
const lengthy = out.match(/^card (\w+) /)[1]
assert.match(out, /\nThis is a lot to read: the section text of "a" \(401\), block 4 \(450\) is longer than about 400 characters/)
assert.doesNotMatch(out, /the body has/)
await call('withdraw_card', { card_id: lengthy })

// revising with blocks replaces body and options; number and place stay
const before = await onBoard(sec)
out = textOf(await call('revise_card', { card_id: sec, text: 'Zwei Teile.\n\n[sqlite] SQLite: Eine Datei.\npicture: 0\n\n[files*] Dateien: Wie bisher.', note: 'Abgleich gestrichen' }))
assert.match(out, new RegExp(`^card ${sec} revised, still Nr\\. ${before.number}`))
c = await onBoard(sec)
assert.deepEqual([c.options.map(o => o.key), c.recommended, c.multiple, c.revisions], [['sqlite', 'files'], ['files'], true, 1])
assert.deepEqual(c.sections.map(b => [b.key, b.recommended, b.picture]), [[undefined, undefined, undefined], ['sqlite', false, 0], ['files', true, undefined]])
assert.equal(c.body, 'Zwei Teile.\n\n**SQLite**: Eine Datei.\n\n**Dateien**: Wie bisher.')
// only the title, the advice or the kind of card: the blocks stand, and their marks follow
await call('revise_card', { card_id: sec, title: 'Speicherplan, zweiter Anlauf?' })
assert.deepEqual([(await onBoard(sec)).sections, (await onBoard(sec)).recommended], [c.sections, ['files']])
await call('revise_card', { card_id: sec, recommended: ['sqlite'] })
c = await onBoard(sec)
assert.deepEqual([c.recommended, c.sections.map(b => b.recommended)], [['sqlite'], [undefined, true, false]])
await call('revise_card', { card_id: sec, recommended: [] })
c = await onBoard(sec)
assert.deepEqual([c.recommended, c.sections.map(b => b.recommended)], [null, [undefined, false, false]])
// a block that points at a picture holds the card to having one
await refused('revise_card', { card_id: sec, attachments: [] }, /section "sqlite" names the picture "0"/)
await refused('revise_card', { card_id: sec, sections: two, options: [option('a'), option('b')] }, /sections and options cannot be combined/)
await refused('revise_card', { card_id: sec, text: '[a] A: x\n\n[b] B: y', body: 'vorweg' }, /text and body cannot be combined/)
assert.equal((await onBoard(sec)).body, c.body)
// plain options make it a plain card again, and the agent is told
out = textOf(await call('revise_card', { card_id: sec, options: [option('a'), option('b')] }))
assert.match(out, /it is a plain card now: body and options replaced its sections/)
c = await onBoard(sec)
assert.deepEqual(['sections' in c, c.options.map(o => o.key), c.body, 'sections' in await mine(sec)], [false, ['a', 'b'], 'Zwei Teile.\n\n**SQLite**: Eine Datei.\n\n**Dateien**: Wie bisher.', false])
// and a plain card becomes a sectioned one the same way
await call('revise_card', { card_id: sec, sections: two })
assert.deepEqual((await onBoard(sec)).sections.map(b => b.key), ['a', 'b'])

// merging takes blocks too
const part = await ask('ein Teil')
out = textOf(await call('merge_cards', { card_ids: [sec, part], title: 'Alles zusammen?', multiple: true, text: 'Kreuze an.\n\n[eins*] Erstens: so.\n\n[zwei] Zweitens: oder so.' }))
const merged = out.match(/^card (\w+) /)[1]
c = await onBoard(merged)
assert.deepEqual([c.sections.length, c.options.map(o => o.key), c.recommended, c.merged_from.map(m => m.id)], [3, ['eins', 'zwei'], ['eins'], [sec, part]])
await refused('merge_cards', { card_ids: [merged, late], title: 'x', sections: two, options: [option('a'), option('b')] }, /cannot be combined/)

// a question about looks that shows nothing draws a reminder, never a refusal; a picture or a link to a page settles it
out = textOf(await call('create_decision', { title: 'Which layout for the sidebar?', options: [option('a'), option('b')] }))
const looks = out.match(/^card (\w+) /)[1]
assert.match(out, /\nThis reads like a question about how something looks, and it shows nothing\. Add a picture with revise_card: .* named <anything>-<key>\.png .*\(publish_asset\)/)
assert.equal((await onBoard(looks)).status, 'open')
assert.match(textOf(await call('revise_card', { card_id: looks, title: 'Welche Farbe für den Knopf?' })), /about how something looks/)
assert.doesNotMatch(textOf(await call('revise_card', { card_id: looks, body: 'Zum Ausprobieren: `/designs/s5.html`' })), /about how something looks/)
assert.match(textOf(await call('revise_card', { card_id: looks, body: 'ohne Bild' })), /about how something looks/)
assert.doesNotMatch(textOf(await call('revise_card', { card_id: looks, attachments: [shot] })), /about how something looks/)
assert.doesNotMatch(textOf(await call('revise_card', { card_id: looks, title: 'Outlook-Konto anbinden?', attachments: [] })), /about how something looks/)
assert.match(textOf(await call('revise_card', { card_id: looks, text: 'Zwei Wege.\n\n[a] Icon links: so.\n\n[b] Rechts: so.' })), /about how something looks/)
await call('withdraw_card', { card_id: looks })

// one card through its whole life: every rewording keeps the version it replaces, and a hand-back is answered by presenting the card again
{
  received.length = 0
  const life = await ask('Erste Fassung?')
  let k = await onBoard(life)
  assert.deepEqual([k.version, 'versions' in k, 'with_agent' in k], [1, false, false])
  await call('revise_card', { card_id: life, urgency: 'high', urgency_reason: 'eilt' })
  assert.deepEqual([(await onBoard(life)).version, 'versions' in await onBoard(life)], [1, false], 'a change of urgency is no version')
  await call('revise_card', { card_id: life, title: 'Zweite Fassung?', body: 'mit Bild', attachments: [shot], note: 'Bild dazu' })
  k = await onBoard(life)
  assert.deepEqual([k.version, k.revisions, k.revision_note], [2, 1, 'Bild dazu'])
  assert.deepEqual(k.versions, [{ n: 1, at: k.created, title: 'Erste Fassung?', body: '', options: [option('a'), option('b')], recommended: null, multiple: false, attachments: [], urgency: 'high', note: '' }])
  let mark = (await state()).messages.at(-1)
  assert.deepEqual([mark.kind, mark.text, mark.version, 'again' in mark], ['revised', 'Bild dazu', 2, false])
  // a question back is chat about the card; only a hand-back or "Explain" puts the card with the agent
  assert.equal((await post('/message', { text: 'wieso?', card_id: life })).status, 200)
  await until(() => received.length === 1)
  assert.deepEqual([received[0].params.meta, 'with_agent' in await onBoard(life)], [{ kind: 'chat', card_id: life }, false])
  assert.equal((await post('/message', { text: 'bitte neu', card_id: life, handback: true })).status, 200)
  await until(() => received.length === 2)
  assert.deepEqual(received[1].params, { content: 'bitte neu', meta: { kind: 'chat', card_id: life, handback: '1' } })
  s = await state()
  assert.deepEqual([s.messages.at(-1).handback, 'explain' in s.messages.at(-1)], [true, false])
  const since = s.cards.find(x => x.id === life).with_agent
  assert.ok(since > 0 && (await mine(life)).with_agent === since)
  assert.equal((await post('/message', { text: 'ohne Karte', handback: true })).status, 200)
  await until(() => received.length === 3)
  assert.deepEqual(received[2].params.meta, { kind: 'chat' }, 'a hand-back names a card or is plain chat')
  // the rewording after a hand-back presents the card again; the version it replaced keeps its picture
  const pictured = k.attachments[0].url
  await call('revise_card', { card_id: life, title: 'Dritte Fassung?', attachments: [], recommended: 'b' })
  k = await onBoard(life)
  mark = (await state()).messages.at(-1)
  assert.deepEqual([mark.kind, mark.text, mark.version, mark.again], ['revised', 'Presented again: Dritte Fassung?', 3, true])
  assert.deepEqual(['with_agent' in k, k.version, k.versions.map(v => [v.n, v.title, v.note, v.attachments.length, v.recommended])], [false, 3, [[1, 'Erste Fassung?', '', 0, null], [2, 'Zweite Fassung?', 'Bild dazu', 1, null]]])
  assert.ok(k.versions[1].at > k.versions[0].at)
  assert.equal((await fetch(base + pictured, { headers: { Cookie: cookie } })).status, 200, 'an earlier version still shows its picture')
  // "Explain" waits for the reply about the card
  assert.equal((await post('/message', { text: 'What??', card_id: life, explain: true })).status, 200)
  await until(() => received.length === 4)
  assert.deepEqual(received[3].params.meta, { kind: 'chat', card_id: life, explain: '1' })
  assert.ok((await onBoard(life)).with_agent > 0)
  await call('reply', { text: 'so ist es gemeint', card_id: life })
  assert.deepEqual(['with_agent' in await onBoard(life), (await onBoard(life)).version], [false, 3])
  assert.equal((await state()).messages.at(-1).presented, true, 'the answer to "Explain" puts the card before the human by itself')
  // handed back: an acknowledgement is a message on the card and no more; the card stays in revision
  const n0 = received.length
  const ack = await ask('Zurück und bestätigt?')
  assert.equal((await post('/message', { text: 'bitte kürzer', card_id: ack, handback: true })).status, 200)
  await until(() => received.length === n0 + 1)
  const handed = (await onBoard(ack)).with_agent
  let said = (await call('reply', { text: 'kommt, bin dran', card_id: ack })).content[0].text
  assert.match(said, new RegExp(`^sent; card ${ack} stays with you \\(in revision\\): .*revise_card.*present: true`))
  s = await state()
  assert.deepEqual([s.cards.find(c => c.id === ack).with_agent, s.messages.at(-1).text, s.messages.at(-1).card_id, 'presented' in s.messages.at(-1), s.queue.includes(ack)], [handed, 'kommt, bin dran', ack, false, true])
  await call('reply', { text: 'noch dabei', card_id: ack, present: false })
  await call('reply', { text: 'ohne Karte', })
  assert.equal((await onBoard(ack)).with_agent, handed, 'a reply without the card changes nothing either')
  // present: true returns it, without a new version
  said = (await call('reply', { text: 'kürzer geht es nicht, so stimmt es', card_id: ack, present: true })).content[0].text
  assert.match(said, new RegExp(`^sent; card ${ack} is before the human again`))
  s = await state()
  assert.deepEqual(['with_agent' in s.cards.find(c => c.id === ack), s.cards.find(c => c.id === ack).version, s.messages.at(-1).presented], [false, 1, true])
  // handed back again: revise_card returns it, as it always did
  assert.equal((await post('/message', { text: 'doch kürzer', card_id: ack, handback: true })).status, 200)
  await until(() => received.length === n0 + 2)
  await call('reply', { text: 'verstanden', card_id: ack })
  assert.ok((await onBoard(ack)).with_agent > 0)
  await call('revise_card', { card_id: ack, title: 'Dritte Fassung, kürzer?' })
  assert.deepEqual(['with_agent' in await onBoard(ack), (await onBoard(ack)).version], [false, 2])
  // asked to explain after a hand-back that is still running: the reply explains, the rework is not done, so it stays
  assert.equal((await post('/message', { text: 'nochmal', card_id: ack, handback: true, explain: true })).status, 200)
  await until(() => received.length === n0 + 3)
  await call('reply', { text: 'gemeint ist …', card_id: ack })
  assert.ok((await onBoard(ack)).with_agent > 0)
  await call('revise_card', { card_id: ack, title: 'Dritte Fassung?' })
  await call('withdraw_card', { card_id: ack })
  // on a card that is not with the agent the flag does nothing, and a plain question back never took the card away
  await call('reply', { text: 'zur Karte', card_id: life, present: true })
  assert.deepEqual(['with_agent' in await onBoard(life), 'presented' in (await state()).messages.at(-1)], [false, false])
  received.length = n0
  // an answer holds for the version it was given to
  await sleep(300)
  assert.equal((await post('/decide', { card_id: life, key: 'a' })).status, 200)
  assert.deepEqual([(await onBoard(life)).answered_version, (await mine(life)).answered_version, (await mine(life)).version], [3, 3, 3])
  assert.equal((await post('/reopen', { card_id: life })).status, 200)
  assert.deepEqual([(await onBoard(life)).answered_version, 'answered_version' in await mine(life)], [null, false])
  // the last twenty versions are kept; with the oldest goes the picture only they showed
  for (let i = 4; i <= 24; i++) await call('revise_card', { card_id: life, title: `Fassung ${i}?` })
  k = await onBoard(life)
  assert.deepEqual([k.version, k.versions.length, k.versions[0].n, k.versions.at(-1).n, k.title], [24, 20, 4, 23, 'Fassung 24?'])
  assert.equal((await fetch(base + pictured, { headers: { Cookie: cookie } })).status, 404)
  await call('withdraw_card', { card_id: life })
  received.length = 0
}

// the agent picks the drawing that fits its task; the list comes from a file, and what the human picked by hand stays
{
  const iconOf = async () => (({ icon, icon_by }) => [icon, icon_by])((await state()).agents.find(a => a.id === 'main'))
  const iconProp = async () => (await client.listTools()).tools.find(t => t.name === 'introduce').inputSchema.properties.icon.description
  // without the file any plain name is taken, and no list is offered
  assert.doesNotMatch(await iconProp(), /One of:/)
  assert.equal(textOf(await call('introduce', { model: 'm', task: 'bauen', icon: 'rocket' })), 'noted; symbol "rocket"')
  assert.deepEqual(await iconOf(), ['draw:rocket', 'agent'])
  await refused('introduce', { model: 'anders', icon: 'Kein Name' }, /lower-case letters only; got "Kein Name"/)
  assert.equal((await state()).agents.find(a => a.id === 'main').model, 'm', 'a refused symbol changes nothing')
  // with the file the name must be one of the drawings, and the agent is shown them
  fs.writeFileSync(path.join(data, 'drawings.json'), JSON.stringify([{ name: 'server', meaning: 'backend work', hue: 200 }, { name: 'brush', meaning: 'design', hue: 20 }, { nichts: 1 }]))
  assert.match(await iconProp(), /One of: server \(backend work\), brush \(design\)$/)
  assert.deepEqual((await (await fetch(`${base}/api/tools`, { headers: { Cookie: cookie } })).json()).drawings, [{ name: 'server', meaning: 'backend work', hue: 200 }, { name: 'brush', meaning: 'design', hue: 20 }])
  await refused('introduce', { model: 'm', icon: 'rocket' }, /no drawing "rocket"; choose one of: server \(backend work\), brush \(design\)/)
  assert.equal(textOf(await call('introduce', { model: 'm', icon: 'draw:brush' })), 'noted; symbol "brush"')
  assert.deepEqual(await iconOf(), ['draw:brush', 'agent'])
  assert.equal(textOf(await call('introduce', { model: 'm' })), 'noted')
  // the human's own choice wins, until they clear it
  assert.equal((await post('/session', { agent: 'main', icon: 'draw:server' })).status, 200)
  assert.deepEqual(await iconOf(), ['draw:server', 'human'])
  assert.match(textOf(await call('introduce', { model: 'm', icon: 'brush' })), /^noted; the human chose this session's symbol by hand, so it stays$/)
  assert.deepEqual(await iconOf(), ['draw:server', 'human'])
  assert.equal((await post('/session', { agent: 'main', icon: '' })).status, 200)
  assert.deepEqual(await iconOf(), ['', undefined])
  await call('introduce', { model: 'm', icon: 'brush' })
  assert.deepEqual(await iconOf(), ['draw:brush', 'agent'])
  fs.rmSync(path.join(data, 'drawings.json'))
  assert.doesNotMatch(await iconProp(), /One of:/)
}

// a picture comes with the page it was rendered from: given outright, found by its name, or as a link; the page is served as a stranger
{
  const dir = fs.mkdtempSync(path.join(data, 'pages-'))
  const put = (name, text) => { const file = path.join(dir, name); fs.writeFileSync(file, text); return file }
  const bild = name => { const file = path.join(dir, name); fs.copyFileSync(shot, file); return file }
  const seite = put('entwurf.html', '<!doctype html><button onclick="this.textContent=1">Klick</button>')
  put('zwilling.html', '<p>Zwilling</p>')
  let out = textOf(await call('create_decision', {
    title: 'Mit Seiten', options: [option('a'), option('b')],
    attachments: [{ path: bild('a.png'), page: seite, title: ' Variante A ' }, bild('zwilling.png'), { path: bild('b.png'), page: '/designs/s5.html' }, { path: bild('c.png'), page: 'https://example.org/x?y=1' }, bild('allein.png'), { path: put('notiz.txt', 'x') }],
  }))
  const paged = out.match(/^card (\w+) /)[1]
  assert.match(out, /\nLinked by name, so the human can open the page under the picture: zwilling\.png → zwilling\.html$/)
  let k = await onBoard(paged)
  assert.deepEqual(k.attachments.map(a => [a.name, a.title, a.page?.kind, a.page?.kind === 'link' ? a.page.url : undefined]),
    [['a.png', 'Variante A', 'file', undefined], ['zwilling.png', undefined, 'file', undefined], ['b.png', undefined, 'link', '/designs/s5.html'], ['c.png', undefined, 'link', 'https://example.org/x?y=1'], ['allein.png', undefined, undefined, undefined], ['notiz.txt', undefined, undefined, undefined]])
  const pageUrl = k.attachments[0].page.url
  assert.match(pageUrl, /^\/files\/[0-9a-f]+\.html$/)
  // the page renders, with scripts, but sandboxed into an origin of its own and loading nothing from anywhere
  assert.equal((await fetch(base + pageUrl)).status, 401)
  const shown = await fetch(base + pageUrl, { headers: { Cookie: cookie } })
  assert.deepEqual([shown.status, shown.headers.get('content-type'), shown.headers.get('x-content-type-options'), await shown.text()], [200, 'text/html; charset=utf-8', 'nosniff', fs.readFileSync(seite, 'utf8')])
  const csp = shown.headers.get('content-security-policy')
  assert.match(csp, /^sandbox allow-scripts; default-src 'none'; /)
  assert.ok(!/allow-same-origin|connect-src|https?:/.test(csp) && /script-src 'unsafe-inline'/.test(csp) && /img-src data:/.test(csp), csp)
  assert.equal((await fetch(base + k.attachments[0].url, { headers: { Cookie: cookie } })).headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'a picture is served as before')
  // a reply takes the same, and a page that is nothing is refused
  out = textOf(await call('reply', { text: 'so sieht es aus', attachments: [{ path: bild('d.png'), page: seite }] }))
  assert.equal(out, 'sent')
  assert.equal((await state()).messages.at(-1).attachments[0].page.kind, 'file')
  await refused('reply', { text: 'x', attachments: [{ path: bild('e.png'), page: path.join(dir, 'fehlt.html').slice(1) }] }, /page not found/)
  await refused('reply', { text: 'x', attachments: [{ path: bild('e.png'), page: path.join(dir, 'notiz.txt') }] }, /page must be an HTML file/)
  await refused('reply', { text: 'x', attachments: [{ page: seite }] }, /an attachment must be the path of a file, or \{ path, page, title \}/)
  // an earlier version keeps its pictures and their pages; a section still finds its picture by name
  await call('revise_card', { card_id: paged, attachments: [{ path: bild('neu.png'), page: seite }], text: 'Zwei.\n\n[a] A: so.\npicture: neu.png\n\n[b] B: anders.' })
  k = await onBoard(paged)
  assert.deepEqual([k.attachments.length, k.attachments[0].page.kind, k.sections[1].picture, k.versions[0].attachments[0].page.url], [1, 'file', 0, pageUrl])
  assert.equal((await fetch(base + pageUrl, { headers: { Cookie: cookie } })).status, 200)
  await call('withdraw_card', { card_id: paged })
}

// "Trust": the human leaves the decision to the agent; what it advised stands as the choice, and it can be taken back like any answer
{
  received.length = 0
  const sure = await ask('Mit Empfehlung überlassen?', { options: [{ key: 'a', label: 'Anton' }, { key: 'b', label: 'Berta' }], recommended: 'b' })
  await post('/draft', { card_id: sure, keys: ['a'] })
  assert.equal((await post('/decide', { card_id: sure, trust: true, key: 'a' })).status, 400, 'trust is no choice')
  assert.equal((await post('/decide', { card_id: sure, trust: true, note: ' mach du ' })).status, 200)
  await until(() => received.length === 1)
  assert.deepEqual(received[0].params, {
    content: 'The human trusts you with "Mit Empfehlung überlassen?": decide yourself (your advice was: Berta [b]). Say in one line what you chose with reply and this card_id, then close_card; do not ask again.\n\nTheir note: mach du',
    meta: { kind: 'decision', card_id: sure, choice: 'b', trust: '1' },
  })
  s = await state()
  let k = s.cards.find(c => c.id === sure)
  assert.deepEqual([k.status, k.trusted, k.choice, k.choices, k.note, k.answered_version, 'draft' in k], ['decided', true, 'b', ['b'], 'mach du', 1, false])
  assert.deepEqual([s.messages.at(-1).kind, s.messages.at(-1).text, s.messages.at(-1).trusted], ['decided', 'Whatever: your call · Berta', true])
  assert.equal((await mine(sure)).trusted, true)
  assert.equal((await post('/decide', { card_id: sure, trust: true })).status, 400, 'once is enough')
  // taking it back: open again, nothing ticked, the note still there, and the agent hears what no longer holds
  assert.equal((await post('/reopen', { card_id: sure })).status, 200)
  await until(() => received.length === 2)
  assert.deepEqual(received[1].params.meta, { kind: 'decision_reopened', card_id: sure, previous_choice: 'b', trust: '1' })
  k = await onBoard(sure)
  assert.deepEqual([k.status, k.trusted, k.choice, k.choices, k.answered_version, k.draft.keys, k.draft.note], ['open', false, null, [], null, [], 'mach du'])
  assert.equal((await post('/decide', { card_id: sure, key: 'a' })).status, 200)
  await until(() => received.length === 3)
  assert.deepEqual([received[2].params.meta, (await onBoard(sure)).trusted], [{ kind: 'decision', card_id: sure, choice: 'a' }, false])
  await call('close_card', { card_id: sure })
  // without advice the choice stays empty, with several pieces of advice all of them stand; the agent closes the card as ever
  const open1 = await ask('Ohne Empfehlung überlassen?')
  const many = await ask('Mehrere überlassen?', { multiple: true, options: [option('a'), option('b'), option('c')], recommended: ['a', 'c'] })
  received.length = 0
  assert.equal((await post('/decide', { card_id: open1, trust: true })).status, 200)
  assert.equal((await post('/decide', { card_id: many, trust: true })).status, 200)
  await until(() => received.length === 2)
  assert.deepEqual(received.map(n => n.params.meta), [{ kind: 'decision', card_id: open1, choice: '', trust: '1' }, { kind: 'decision', card_id: many, choice: 'a', choices: 'a,c', trust: '1' }])
  assert.match(received[0].params.content, /decide yourself \(you gave no advice\)/)
  s = await state()
  assert.deepEqual([s.cards.find(c => c.id === open1).choice, s.cards.find(c => c.id === open1).choices, s.cards.find(c => c.id === many).choices, s.messages.at(-2).text, s.messages.at(-1).text], [null, [], ['a', 'c'], 'Whatever: your call', 'Whatever: your call · a, c'])
  assert.equal(textOf(await call('close_card', { card_id: open1, summary: 'a genommen' })), 'closed')
  assert.equal((await post('/reopen', { card_id: open1 })).status, 200, 'a trusted card without a choice can be taken back too')
  await call('withdraw_card', { card_id: open1 })
  await call('close_card', { card_id: many })
  // only a question can be left to the agent
  const told = textOf(await call('create_info', { title: 'nur lesen', body: 'x' })).match(/^info (\w+)/)[1]
  const no = await post('/decide', { card_id: told, trust: true })
  assert.deepEqual([no.status, (await no.json()).error], [400, 'only a question can be left to the agent; an info is closed with /close'])
  assert.equal((await post('/decide', { card_id: 'gibtsnicht', trust: true })).status, 400)
  await call('withdraw_card', { card_id: told })
  received.length = 0
}

// notes and drawings pinned to places on a card: kept in the draft, sent with the answer, a question back or the shredder, and read by the agent as lines
{
  received.length = 0
  const pin = textOf(await call('create_decision', { title: 'Wo anheften?', attachments: [shot], text: 'Der Hub merkt sich alles.\n\n[split] Split: zwei Spalten.\n\n[stack] Stapel: untereinander.' })).match(/^card (\w+) /)[1]
  const marks = [
    { id: 'm1', anchor: { kind: 'option', key: 'split', x: 0.5, y: 0.25, unsinn: 1 }, text: ' zu eng ' },
    { id: 'm2', anchor: { kind: 'section', index: 2 }, text: 'gefällt mir' },
    { id: 'm3', anchor: { kind: 'picture', index: 0, x: 0.1, y: 0.9 }, strokes: [[1, 2, 3, 4], [5, 6, 7, 8]] },
    { id: 'm4', anchor: { kind: 'text', quote: 'Der Hub merkt sich alles.' }, text: 'wirklich alles?', strokes: [[0, 0, 1, 1]] },
    { id: 'm5', anchor: { kind: 'card' }, text: 'insgesamt gut' },
    { id: 'leer', anchor: { kind: 'card' }, text: '  ' },
  ]
  const kept = [
    { id: 'm1', anchor: { kind: 'option', key: 'split', x: 0.5, y: 0.25 }, text: 'zu eng' },
    { id: 'm2', anchor: { kind: 'section', index: 2 }, text: 'gefällt mir' },
    { id: 'm3', anchor: { kind: 'picture', index: 0, x: 0.1, y: 0.9 }, strokes: [[1, 2, 3, 4], [5, 6, 7, 8]] },
    { id: 'm4', anchor: { kind: 'text', quote: 'Der Hub merkt sich alles.' }, text: 'wirklich alles?', strokes: [[0, 0, 1, 1]] },
    { id: 'm5', anchor: { kind: 'card' }, text: 'insgesamt gut' },
  ]
  // in the draft: stored whole, an empty one dropped, what points nowhere dropped, too much refused
  assert.equal((await post('/draft', { card_id: pin, marks: [...marks, { id: 'weg', anchor: { kind: 'option', key: 'gibtsnicht' }, text: 'x' }, { id: 'weg2', anchor: { kind: 'section', index: 9 }, text: 'x' }] })).status, 200)
  let k = await onBoard(pin)
  assert.deepEqual([k.draft.marks, k.draft.keys, k.draft.notes], [kept, [], {}])
  for (const wrong of [{ marks: 'x' }, { marks: [{ text: 'x' }] }, { marks: [{ anchor: { kind: 'wo' }, text: 'x' }] }, { marks: [{ anchor: { kind: 'card' }, text: 'x'.repeat(2001) }] }, { marks: [{ anchor: { kind: 'card' }, strokes: 'x' }] },
    { marks: [{ anchor: { kind: 'card' }, strokes: [Array(40000).fill(1)] }] }, { marks: Array(201).fill({ anchor: { kind: 'card' }, text: 'x' }) }, { marks: Array(20).fill({ anchor: { kind: 'card' }, strokes: [Array(30000).fill(1)] }) }]) {
    const res = await post('/draft', { card_id: pin, ...wrong })
    assert.equal(res.status, 400, JSON.stringify(wrong).slice(0, 80))
  }
  assert.deepEqual((await onBoard(pin)).draft.marks, kept, 'a refused draft changes nothing')
  // the agent rewrites the card: marks on an option or paragraph that is gone go, the others stay
  await call('revise_card', { card_id: pin, text: 'Der Hub merkt sich alles.\n\n[split] Split: zwei Spalten.' + '\n\n[tabs] Reiter: nebeneinander.' })
  assert.deepEqual((await onBoard(pin)).draft.marks.map(m => m.id), ['m1', 'm2', 'm3', 'm4', 'm5'])
  await call('revise_card', { card_id: pin, text: '[stack] Stapel: untereinander.\n\n[tabs] Reiter: nebeneinander.' })
  assert.deepEqual((await onBoard(pin)).draft.marks.map(m => m.id), ['m3', 'm4', 'm5'])
  await call('revise_card', { card_id: pin, text: 'Der Hub merkt sich alles.\n\n[split] Split: zwei Spalten.\n\n[stack] Stapel: untereinander.' })
  await sleep(300)
  // with a question back: on the message, and as lines for the agent, with the picture of the annotated card
  received.length = 0
  assert.equal((await post('/message', { text: '', card_id: pin, marks: [marks[0]], attachments: [{ name: 'karte.png', data: dot }] })).status, 200)
  await until(() => received.length === 1)
  s = await state()
  assert.deepEqual([s.messages.at(-1).marks, s.messages.at(-1).attachments.length], [[kept[0]], 1])
  assert.match(received[0].params.content, /^The human sent a file: karte\.png\. .*\n\nNotes pinned to the card:\n- on option "Split" \[split\]: zu eng$/)
  assert.deepEqual([received[0].params.meta.marks, received[0].params.meta.card_id, /\.png$/.test(received[0].params.meta.image_path)], ['1', pin, true])
  assert.equal((await post('/message', { text: '', card_id: pin, marks: [marks[5]] })).status, 400, 'nothing said, nothing pinned')
  assert.equal((await post('/message', { text: 'x', card_id: pin, marks: [{ anchor: { kind: 'option', key: 'gibtsnicht' }, text: 'x' }] })).status, 409, 'a mark on what the card no longer has')
  // with the answer: on the card, counted in the conversation, read by the agent, and what was pinned to an option is a note on it too
  assert.equal((await post('/decide', { card_id: pin, key: 'stack', notes: { split: 'eigentlich nicht' }, marks, attachments: [{ name: 'karte.png', data: dot }] })).status, 200)
  await until(() => received.length === 2)
  assert.equal(received[1].params.content, [
    'Decision on "Wo anheften?": stack', '', 'Notes on options:', '- Split [split], not chosen: eigentlich nicht', '', 'Notes pinned to the card:',
    '- on option "Split" [split]: zu eng', '- on option "Stapel" [stack]: gefällt mir', '- on the picture mock.png: (drawn; see the picture)',
    '- on the text "Der Hub merkt sich alles.": wirklich alles? (also drawn; see the picture)', '- general: insgesamt gut',
  ].join('\n'))
  assert.deepEqual((({ image_path, files, ...rest }) => [rest, /\.png$/.test(image_path)])(received[1].params.meta), [{ kind: 'decision', card_id: pin, choice: 'stack', option_notes: 'split', marks: '5' }, true])
  s = await state()
  k = s.cards.find(c => c.id === pin)
  assert.deepEqual([k.marks, k.option_notes, 'draft' in k, k.note_attachments.length], [kept, { split: 'eigentlich nicht\nzu eng', stack: 'gefällt mir' }, false, 1])
  assert.equal(s.messages.at(-1).text, 'Stapel · Split: eigentlich nicht · 5 notes')
  // taken back, the marks are the draft's again
  assert.equal((await post('/reopen', { card_id: pin })).status, 200)
  k = await onBoard(pin)
  assert.deepEqual([k.draft.marks, k.draft.keys, 'marks' in k], [kept, ['stack'], false])
  // into the shredder with a last word pinned to it, and out again
  await until(() => received.length === 3)
  assert.equal((await post('/shred', { card_id: pin, marks: [marks[4]], attachments: [{ name: 'karte.png', data: dot }] })).status, 200)
  await until(() => received.length === 4)
  assert.match(received[3].params.content, /\n\nNotes pinned to the card:\n- general: insgesamt gut$/)
  assert.deepEqual([received[3].params.meta.kind, received[3].params.meta.marks, /\.png$/.test(received[3].params.meta.image_path)], ['shredded', '1', true])
  s = await state()
  assert.deepEqual([s.cards.find(c => c.id === pin).marks, s.messages.at(-1).text], [[kept[4]], 'Wo anheften? · 1 note'])
  assert.equal((await post('/reopen', { card_id: pin })).status, 200)
  assert.deepEqual([(await onBoard(pin)).draft.marks, 'marks' in await onBoard(pin)], [[kept[4]], false])
  await call('withdraw_card', { card_id: pin })
  assert.equal('draft' in await onBoard(pin), false)
  received.length = 0
}

// more than ten options draw a reminder to offer only what the agent stands behind; ten do not
{
  const eleven = 'abcdefghijk'.split('').map(option)
  let out = textOf(await call('create_decision', { title: 'Zu viele?', options: eleven }))
  const crowd = out.match(/^card (\w+) /)[1]
  assert.match(out, /\nMany options \(11; a card holds about 10\): keep only the ones you are sure of\. Two or three you stand behind beat a dozen; put the rest on a page .* Shorten it with revise_card\.$/)
  assert.equal((await onBoard(crowd)).options.length, 11, 'reminded, not refused')
  assert.doesNotMatch(textOf(await call('revise_card', { card_id: crowd, options: eleven.slice(0, 10) })), /Many options/)
  assert.match(textOf(await call('revise_card', { card_id: crowd, options: eleven, body: 'x'.repeat(301) })), /This is a lot to read: the body has 301 characters.*at most 10 options.*\nMany options \(11; a card holds about 10\)/s)
  await call('withdraw_card', { card_id: crowd })
}

// "Later": a card the human puts off leaves the stack, on every device, and comes back when called or when its time has come; the agent is not told
{
  received.length = 0
  const nap = await ask('Später?')
  const morning = (() => { const at = new Date(); at.setHours(7, 0, 0, 0); if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1); return at.getTime() })()
  for (const wrong of [{ until: 'irgendwann' }, { until: Date.now() - 1000 }, { until: {} }]) assert.equal((await post('/snooze', { card_id: nap, ...wrong })).status, 400, JSON.stringify(wrong))
  assert.equal((await post('/snooze', { card_id: 'gibtsnicht' })).status, 400)
  assert.equal((await post('/snooze', { card_id: nap }, 'https://evil.example')).status, 403)
  for (const until of [undefined, null, 'next_morning', Date.now() + 7 * 86400000]) {
    const t = Date.now()
    assert.equal((await post('/snooze', { card_id: nap, until })).status, 200)
    s = await state()
    const k = s.cards.find(c => c.id === nap)
    assert.deepEqual([k.snoozed_until, k.snoozed_at >= t, k.status, s.queue.includes(nap)], [morning, true, 'open', false], String(until))
  }
  // called back because the rest is done
  assert.equal((await post('/snooze', { card_id: nap, clear: true })).status, 200)
  s = await state()
  let k = s.cards.find(c => c.id === nap)
  assert.deepEqual(['snoozed_until' in k, 'snoozed_at' in k, k.unsnoozed > 0, s.queue.includes(nap)], [false, false, true, true])
  assert.equal((await post('/snooze', { card_id: nap, clear: true })).status, 200, 'calling back what is not put off changes nothing')
  // its time comes: back by itself, with a marker in the conversation
  assert.equal((await post('/snooze', { card_id: nap, until: Date.now() + 300 })).status, 200)
  assert.deepEqual([(await onBoard(nap)).snoozed_until < morning, 'unsnoozed' in await onBoard(nap), (await state()).queue.includes(nap)], [true, false, false])
  await eventually(async () => (await state()).queue.includes(nap), 'the card to come back from snooze')
  s = await state()
  k = s.cards.find(c => c.id === nap)
  assert.deepEqual(['snoozed_until' in k, k.unsnoozed > 0, s.messages.at(-1).kind, s.messages.at(-1).card_id, s.messages.at(-1).text], [false, true, 'unsnoozed', nap, 'Back from snooze'])
  // answered while put off, the put-off is over; and nothing of all this reached the agent
  assert.equal((await post('/snooze', { card_id: nap })).status, 200)
  assert.equal('snoozed_until' in (await mine(nap)), false, 'list_cards does not show it')
  assert.equal((await post('/decide', { card_id: nap, key: 'a' })).status, 200)
  await until(() => received.length === 1)
  assert.deepEqual([received[0].params.meta.kind, 'snoozed_until' in await onBoard(nap)], ['decision', false])
  assert.equal((await post('/snooze', { card_id: nap })).status, 409, 'only an open card can be put off')
  await call('close_card', { card_id: nap })
  received.length = 0
}

// a card filed the old way is what it always was: no sections anywhere
const oldStyle = await ask('wie früher', { body: 'kurz', recommended: 'a' })
c = await onBoard(oldStyle)
assert.deepEqual(['sections' in c, 'draft' in c, c.body, c.options, c.recommended, 'sections' in await mine(oldStyle)], [false, false, 'kurz', [option('a'), option('b')], 'a', false])
await call('withdraw_card', { card_id: oldStyle })

// a draft: what the human ticked and wrote without sending is kept on the card, for every page, and the agent hears nothing
received.length = 0
const draft = body => post('/draft', { card_id: merged, ...body })
assert.equal((await post('/draft', { card_id: merged, keys: ['zwei'] }, 'https://evil.example')).status, 403)
assert.equal((await fetch(`${base}/draft`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ card_id: merged, keys: ['zwei'] }) })).status, 401)
assert.equal((await draft({ keys: ['zwei', 'eins', 'gibtsnicht'], note: ' halb fertig', notes: { eins: ' ja, aber später ', zwei: '  ', gibtsnicht: 'x' } })).status, 200)
c = await onBoard(merged)
assert.deepEqual((({ ts, ...rest }) => rest)(c.draft), { keys: ['eins', 'zwei'], note: ' halb fertig', notes: { eins: 'ja, aber später' } })
assert.ok(c.draft.ts > 0 && c.status === 'open')
const stamp = c.draft.ts
// the same draft again changes nothing; the file follows within a moment
assert.equal((await draft({ keys: ['eins', 'zwei'], note: ' halb fertig', notes: { eins: 'ja, aber später' } })).status, 200)
assert.equal((await onBoard(merged)).draft.ts, stamp)
await eventually(async () => readBoard(data).cards.find(k => k.id === merged).draft?.keys.length === 2, 'the draft to reach the state file')
assert.equal('draft' in await mine(merged), false, 'list_cards does not show a draft')
for (const wrong of [{ keys: 'eins' }, { notes: ['x'] }, { notes: { eins: 'x'.repeat(2001) } }, { note: 'x'.repeat(10001) }]) assert.equal((await draft(wrong)).status, 400, JSON.stringify(wrong))
assert.equal((await post('/draft', { card_id: 'gibtsnicht', keys: [] })).status, 400)
assert.equal((await onBoard(merged)).draft.ts, stamp, 'a refused draft changes nothing')
// the agent rewrites the card: what the draft says about options that are gone goes with them
await call('revise_card', { card_id: merged, text: 'Kreuze an.\n\n[zwei] Zweitens: oder so.\n\n[drei] Drittens: ganz anders.' })
assert.deepEqual((({ ts, ...rest }) => rest)((await onBoard(merged)).draft), { keys: ['zwei'], note: ' halb fertig', notes: {} })
// an empty draft clears it
assert.equal((await draft({ keys: [], note: '', notes: {} })).status, 200)
assert.equal('draft' in await onBoard(merged), false)
assert.equal(received.length, 0, 'a draft is none of the agent\'s business')

// an answer can carry a note per option, chosen or not; the agent reads them in the text and finds their keys in option_notes
await draft({ keys: ['drei'], notes: { drei: 'vielleicht' } })
await sleep(300)
for (const wrong of [{ notes: 'x' }, { notes: { vier: 'x' } }, { notes: { zwei: 'x'.repeat(2001) } }]) assert.ok([400, 409].includes((await post('/decide', { card_id: merged, keys: ['zwei'], ...wrong })).status), JSON.stringify(wrong))
assert.equal((await onBoard(merged)).status, 'open')
assert.equal((await post('/decide', { card_id: merged, keys: ['zwei'], note: 'so machen wir es', notes: { drei: ' nicht das,\nzu teuer ', zwei: 'aber erst morgen', } })).status, 200)
await until(() => received.length === 1)
assert.deepEqual(received[0].params, {
  content: 'so machen wir es\n\nNotes on options:\n- Zweitens [zwei], chosen: aber erst morgen\n- Drittens [drei], not chosen: nicht das, zu teuer',
  meta: { kind: 'decision', card_id: merged, choice: 'zwei', choices: 'zwei', option_notes: 'zwei,drei' },
})
s = await state()
c = s.cards.find(k => k.id === merged)
assert.deepEqual([c.status, c.note, c.option_notes, 'draft' in c], ['decided', 'so machen wir es', { zwei: 'aber erst morgen', drei: 'nicht das,\nzu teuer' }, false])
assert.deepEqual([s.messages.at(-1).kind, s.messages.at(-1).text], ['decided', 'Zweitens · Zweitens: aber erst morgen · Drittens: nicht das, zu teuer'])
assert.equal((await draft({ keys: ['zwei'] })).status, 409, 'an answered card keeps no draft')
// taking the answer back loses nothing: ticks and notes are the draft of the open card
assert.equal((await post('/reopen', { card_id: merged })).status, 200)
await until(() => received.length === 2)
c = await onBoard(merged)
assert.deepEqual([c.status, c.choices, c.note, c.option_notes], ['open', [], '', {}])
assert.deepEqual((({ ts, ...rest }) => rest)(c.draft), { keys: ['zwei'], note: 'so machen wir es', notes: { zwei: 'aber erst morgen', drei: 'nicht das, zu teuer'.replace(', ', ',\n') } })
// without notes the event is what it always was, and withdrawing or closing a card drops its draft
assert.equal((await post('/decide', { card_id: merged, key: 'drei' })).status, 200)
await until(() => received.length === 3)
assert.deepEqual(received[2].params, { content: 'Decision on "Alles zusammen?": drei', meta: { kind: 'decision', card_id: merged, choice: 'drei', choices: 'drei' } })
assert.deepEqual((await onBoard(merged)).option_notes, {})
await call('close_card', { card_id: merged })
const drafted = await ask('mit Entwurf')
await post('/draft', { card_id: drafted, keys: ['b'] })
assert.deepEqual((await onBoard(drafted)).draft.keys, ['b'])
await call('withdraw_card', { card_id: drafted })
assert.equal('draft' in await onBoard(drafted), false)
received.length = 0
}

// several agents on one board: the first process is the hub, the others link to it
const gotApi = [], gotInfra = []
const api = await start('API', gotApi)
const infra = await start('Infra', gotInfra)
const apiCard = (await api.callTool({ name: 'create_decision', arguments: { title: 'vom zweiten Agenten', options: [option('a'), option('b')], urgency: 'critical' } }))
  .content[0].text.match(/^card (\w+) /)[1]
// another session's card is not there to revise or merge, and a short card of a session with one question draws no hint
await refused('revise_card', { card_id: apiCard, title: 'gekapert' }, new RegExp(`no card ${apiCard}`))
await refused('merge_cards', { card_ids: [late, apiCard], title: 'gekapert', options: [option('a'), option('b')] }, new RegExp(`no card ${apiCard}`))
assert.deepEqual((({ title, status }) => [title, status])((await state()).cards.find(c => c.id === apiCard)), ['vom zweiten Agenten', 'open'])
assert.equal((await state()).cards.find(c => c.id === late).status, 'open')
const calm = (await api.callTool({ name: 'revise_card', arguments: { card_id: apiCard, body: 'kurz' } })).content[0].text
assert.doesNotMatch(calm, /open questions|a lot to read/)
await sleep(300)
await infra.callTool({ name: 'set_status', arguments: { id: 'deploy', label: 'Deploy', state: 'working' } })
s = await state()
assert.deepEqual(s.agents.map(a => [a.id, a.name, a.online]), [['main', 'main', true], ['api', 'API', true], ['infra', 'Infra', true]])
// each agent says where it runs; model and task come from the agent itself
await api.callTool({ name: 'introduce', arguments: { model: 'Claude Test', task: 'prüfen' } })
const me = (await state()).agents[1]
assert.deepEqual([me.host, me.model, me.task, me.client], [os.hostname(), 'Claude Test', 'prüfen', 'test 0'])
assert.equal(s.cards.at(-1).agent, 'api')
assert.ok(s.queue.indexOf(apiCard) > s.queue.indexOf(late), 'one shared stack in the order of filing: the critical card of one agent stands after the older card of another')
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
assert.ok(!JSON.stringify(readBoard(data)).includes(tkey) && !logs.join('\n').includes(tkey) && !logs.join('\n').includes(skey))
// assets are fenced like cards: only the session that published one sees it or ends it
await refused('revoke_asset', { id: sid }, /no asset/)
assert.deepEqual(JSON.parse((await infra.callTool({ name: 'list_assets', arguments: {} })).content[0].text), [])
assert.deepEqual(JSON.parse((await api.callTool({ name: 'list_assets', arguments: {} })).content[0].text).map(a => [a.id, a.link]), [[sid, `${base}/a/${sid}#${skey}`], [tid, null]])
await api.callTool({ name: 'revoke_asset', arguments: { id: tid } })
assert.deepEqual([(await fetch(`${base}/a/${tid}/blob`, signedIn)).status, fs.existsSync(path.join(data, 'assets', tid)), (await fetch(`${base}/a/${sid}/blob`, signedIn)).status], [404, false, 200])

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
assert.equal(readBoard(data).agents[0].archived, true)
assert.equal((await post('/session', { agent: 'main', archived: false })).status, 200)
assert.deepEqual((await state()).queue.filter(id => mainOpen.includes(id)).length, mainOpen.length, 'un-archived: the cards are back on the stack')
assert.equal((await post('/session', { agent: 'main', archived: true })).status, 200)
// sessions that share a group form a pair; the group is a free string, cut at 40 characters, and null clears it
assert.equal((await post('/session', { agent: 'api', group: 'paar-1' })).status, 200)
assert.equal((await post('/session', { agent: 'infra', group: 'paar-1', label: 'Unterbau' })).status, 200)
assert.equal((await post('/session', { agent: 'main', group: 'x'.repeat(50) })).status, 200)
s = await state()
assert.deepEqual(s.agents.map(a => [a.group, a.label ?? '']), [['x'.repeat(40), ''], ['paar-1', 'Schnittstelle'], ['paar-1', 'Unterbau']])
// the order of the sidebar is the human's: a session is put before another one or at the end, a group moves as one, and each carries its position
{
  const order = async () => (await state()).agents.map(a => a.id)
  const move = (agent, before) => post('/session', { agent, before })
  assert.deepEqual((await state()).agents.map(a => [a.id, a.position]), [['main', 0], ['api', 1], ['infra', 2]])
  assert.equal((await move('infra', 'main')).status, 200)
  assert.deepEqual(await order(), ['api', 'infra', 'main'], 'the group came along')
  assert.equal((await move('infra', 'api')).status, 200)
  assert.deepEqual(await order(), ['infra', 'api', 'main'], 'before a member of its own group: within the group')
  assert.equal((await move('main', 'api')).status, 200)
  assert.deepEqual(await order(), ['main', 'infra', 'api'], 'before a group, not into it')
  assert.equal((await move('api', 'infra')).status, 200)
  assert.equal((await move('api', 'api')).status, 200)
  assert.deepEqual(await order(), ['main', 'api', 'infra'])
  assert.equal((await move('main', null)).status, 200)
  assert.deepEqual((await state()).agents.map(a => [a.id, a.position]), [['api', 0], ['infra', 1], ['main', 2]])
  assert.deepEqual(readBoard(data).agents.map(a => [a.id, a.position]), [['api', 0], ['infra', 1], ['main', 2]])
  assert.equal((await move('api', 'niemand')).status, 400)
  assert.equal((await post('/session', { agent: 'niemand', before: null })).status, 400)
  assert.deepEqual(await order(), ['api', 'infra', 'main'], 'a refused move changes nothing')
  assert.equal((await post('/session', { agent: 'api', before: null, label: 'Schnittstelle' })).status, 200)
  assert.deepEqual(await order(), ['main', 'api', 'infra'])
}
// one crown per desk (card Nr. 172; these three stand on one desk): crowning one takes it from the other, taking it off leaves none
{
  const crowns = async () => (await state()).agents.filter(a => a.starred).map(a => a.id)
  const before = await crowns()
  assert.equal((await post('/star', { agent: 'infra', starred: true })).status, 200)
  assert.deepEqual(await crowns(), ['infra'])
  assert.equal((await post('/star', { agent: 'main', starred: true })).status, 200)
  assert.deepEqual([await crowns(), (await state()).agents.find(a => a.id === 'main').starred_at > 0], [['main'], true])
  assert.equal((await post('/star', { agent: 'infra', starred: false })).status, 200)
  assert.deepEqual(await crowns(), ['main'], 'taking off a crown nobody wears changes nothing')
  assert.equal((await post('/star', { agent: 'main', starred: false })).status, 200)
  assert.deepEqual(await crowns(), [])
  for (const id of before) await post('/star', { agent: id, starred: true })
  assert.deepEqual(await crowns(), before.slice(-1))
}
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
const kept = readBoard(data)
const days = n => Date.now() - n * 86400000
fs.writeFileSync(path.join(data, 'files', 'old.png'), 'x')
fs.writeFileSync(path.join(data, 'files', 'young.png'), 'x')
const aged = (id, status, decided, file) => ({ ...oldCard(id, status, days(40), { decided, choice: decided ? 'a' : null }), agent: 'main', number: 900, attachments: [{ name: file, url: `/files/${file}`, kind: 'image', image: true }] })
// assets age the same way, unless they were published to be kept
assert.deepEqual(kept.assets.map(a => a.id), [qid, pid, sid], 'assets outlast restarts and changes of hub')
const [aOld, aKeep, aYoung] = ['O', 'K', 'Y'].map(c => c.repeat(22))
for (const id of [aOld, aKeep, aYoung]) fs.writeFileSync(path.join(data, 'assets', id), 'ZWA1' + 'x'.repeat(60))
const published = (id, created, keep) => ({ id, agent: 'main', type: 'html', title: 'Alt', size: 64, created, keep, silent: false, wrapped_key: null })
writeBoard(data, ({
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
assert.deepEqual([(await fetch(`${base}/a/${aOld}/blob`, signedIn)).status, (await fetch(`${base}/a/${aKeep}/blob`, signedIn)).status], [404, 200])
assert.equal(fs.existsSync(path.join(data, 'files', 'old.png')), false)
assert.equal(fs.existsSync(path.join(data, 'files', 'young.png')), true)
await client.close()

// ---- a second board, to look at who is who and at what waits for whom ----
const portFree = () => eventually(() => fetch(base).then(() => false, () => true), 'the port to be free')
await portFree()
const data2 = fs.mkdtempSync(path.join(os.tmpdir(), 'board-test-'))
const on2 = { BOARD_DATA: data2 }
const file2 = () => readBoard(data2)
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
spawned.push(raw)
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
const res3 = await fetch(`${base}/events`, { headers: { Cookie: `board_${PORT}=${token3}` } })
const reader3 = res3.body.getReader()
const state3 = JSON.parse(new TextDecoder().decode((await reader3.read()).value).replace(/^data: /, ''))
await reader3.cancel()
assert.deepEqual(state3.agents.map(a => [a.model, a.online]), [['m', true], ['m', true]])
assert.deepEqual(fs.readdirSync(data3).filter(f => f.startsWith('token')), ['token'])
// the damaged file is left alone, not overwritten
assert.deepEqual(fs.readdirSync(data3).filter(f => f.startsWith('state.broken-')), [], 'it is not read again, so it need not be moved')
assert.equal(fs.readFileSync(path.join(data3, 'state.json'), 'utf8'), '{"cards": [{"id": "halb')
assert.deepEqual(readBoard(data3).agents.map(a => a.model), ['m', 'm'], 'the board started empty and rests in the database')
await Promise.all(pair.map(c => c.close()))

// ---- a hub of its own: it serves the board without being a session, and has nothing on stdin ----
await portFree()
const data5 = fs.mkdtempSync(path.join(os.tmpdir(), 'board-test-'))
const on5 = { BOARD_DATA: data5 }
const lone = spawn('node', [SERVER], { env: serverEnv('Dienst', { ...on5, BOARD_HUB_ONLY: '1' }), stdio: ['ignore', 'ignore', 'pipe'] })
spawned.push(lone)
lone.stderr.on('data', chunk => logs.push(...String(chunk).split('\n').filter(Boolean)))
await eventually(async () => (await state()).agents.length === 0, 'the hub of its own to answer')
s = await state()
assert.deepEqual([s.agents, s.hub, s.queue], [[], null, []])
for (const dir of ['files', 'scribbles', 'speech', 'assets']) assert.equal(fs.statSync(path.join(data5, dir)).mode & 0o777, 0o700, dir)
assert.ok(logs.some(l => l.includes(`hub on 0.0.0.0:${PORT} without a session of its own`)))
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
spawned.push(spare)
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
// a hub without SQLite (as a Node older than 22.13 would be) does not start on a board that rests in the database: it would show the past
const lost = spawn('node', [SERVER], { env: serverEnv('Dienst', { ...on5, BOARD_HUB_ONLY: '1', NODE_OPTIONS: '--no-experimental-sqlite' }), stdio: ['ignore', 'ignore', 'pipe'] })
spawned.push(lost)
let lostSaid = ''
lost.stderr.on('data', chunk => { lostSaid += chunk })
assert.equal(await new Promise(resolve => lost.on('close', resolve)), 1)
assert.match(lostSaid, /this board rests in SQLite .*cannot open on Node .*board-store\.mjs back /)
// the way back is a command: the state goes into state.json, and from there the old way works, with only the pad missing
const toJson = spawnSync('node', [toPath(new URL('./board-store.mjs', import.meta.url)), 'back', data5])
assert.deepEqual([toJson.status, fs.existsSync(path.join(data5, 'state.in-sqlite')), JSON.parse(fs.readFileSync(path.join(data5, 'state.json'), 'utf8')).agents.map(a => a.task)], [0, false, ['allein']])
const back = spawn('node', [SERVER], { env: serverEnv('Dienst', { ...on5, BOARD_HUB_ONLY: '1', NODE_OPTIONS: '--no-experimental-sqlite' }), stdio: ['ignore', 'ignore', 'pipe'] })
spawned.push(back)
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
// without node:sqlite the hub runs and serves the board; the pad's routes say what is missing, once in the log too
const noPad = await fetch(`${base}/pad/elements?pad=global`, { headers: { Cookie: cookie } })
assert.deepEqual([noPad.status, /node:sqlite/.test((await noPad.json()).error)], [501, true])
assert.equal((await post('/pad/send', { session: 'solo', elements: [{ id: 'padnote000001' }], png: dot })).status, 501)
assert.deepEqual([(await fetch(`${base}/pad`, { headers: { Cookie: cookie } })).status, back.exitCode, logs.slice(mark).filter(l => l.includes('The pad is off')).length], [200, null, 1])

// a worker without a channel publishes through dev/session.mjs: the helper encrypts with the same envelope
// and uploads like a spoke, so the hub is handed ciphertext, and of a silent asset no key
const SESSION = toPath(new URL('../dev/session.mjs', import.meta.url))
const helperEnv = { ...process.env, BOARD_PORT: String(PORT), BOARD_DATA: data5, BOARD_TOKEN: 'secret', BOARD_PUBLIC_URL: '' }
const helper = (...args) => new Promise(resolve => {
  const child = spawn('node', [SESSION, ...args], { env: helperEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  spawned.push(child)
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
spawned.push(held)
await eventually(async () => (await state()).agents.some(a => a.id === 'helfer' && a.online), 'the helper session to link')
const helperTalk = (await state()).messages.length
const shownOut = await helper('publish', 'helfer', sheet, '--title', 'Blatt', '--note', 'aus dem Helfer')
assert.equal(shownOut.code, 0, shownOut.stderr)
// the base is the first line of data/url.txt without its query
const [hid, hkey] = shownOut.stdout.match(new RegExp(String.raw`^http:\/\/localhost:${PORT}\/a\/([\w-]{22})#([\w-]{43})\n$`)).slice(1)
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
const [zid, zkey] = quietOut.stdout.match(new RegExp(String.raw`^http:\/\/localhost:${PORT}\/a\/([\w-]{22})#([\w-]{43})\n$`)).slice(1)
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
// The speech service (read aloud), played by a local server. No real key is involved.
const tinfoil = { auth: [], spoken: [], sound: 'ID3 klang' }
const fakeSpeech = http.createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  tinfoil.auth.push(req.headers.authorization)
  // text to speech: the request is kept, the answer is a few bytes that stand for the sound
  if (req.url === '/v1/audio/speech') {
    tinfoil.spoken.push(JSON.parse(Buffer.concat(chunks).toString()))
    if (tinfoil.sound == null) return res.writeHead(500, { 'Content-Type': 'application/json' }).end('{"error":{"message":"no voice"}}')
    return res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(tinfoil.sound)
  }
  res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":{"message":"not found"}}')
})
await new Promise(resolve => fakeSpeech.listen(0, '127.0.0.1', resolve))
const on4 = { BOARD_DATA: data4, BOARD_TOKEN: '', BOARD_ADMIN_TOKEN: '', BOARD_PUBLIC_URL: 'https://rechner.example.ts.net/', BOARD_SPEECH_API: `http://127.0.0.1:${fakeSpeech.address().port}/v1` }
const file4 = () => readBoard(data4)
const has4 = (...parts) => fs.existsSync(in4(...parts))
const gotSpeiche = []
const chef = await start('Chef', [], on4)
const speiche = await start('Speiche', gotSpeiche, on4)
const token4 = fs.readFileSync(in4('token'), 'utf8')
const adminKey4 = fs.readFileSync(in4('admin-token'), 'utf8')
assert.equal(fs.statSync(in4('admin-token')).mode & 0o077, 0)
assert.notEqual(adminKey4, token4)
let board4 = `board_${PORT}=${token4}`
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
assert.equal((await adminPost('login', { key: adminKey4 }, `board_${PORT}=falsch`)).status, 401)
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
assert.ok(d.lines.some(l => new RegExp(String.raw`hub on 0\.0\.0\.0:${PORT} as "chef"`).test(l.line) && l.ts > 0))
assert.ok(d.lines.length <= 200)
assert.deepEqual(d.links.map(l => [l.id, l.state, l.queued]), [['weg', 'away', 2], ['alt', 'away', 0], ['chef', 'hub', 0], ['speiche', 'linked', 0]])

// read aloud: the key goes to the service and nowhere else
{
const sayHead = { Origin: base, Cookie: board4 }
// read aloud: any text, in pieces from the page; a known language is named to the voice, the same piece is only made once
const sayIt = (body, head = sayHead) => fetch(`${base}/speech/say`, { method: 'POST', headers: { ...head, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
assert.equal((await sayIt({ text: 'Hallo' }, {})).status, 401)
assert.equal((await sayIt({ text: 'Hallo' }, { ...sayHead, Origin: 'http://evil.example' })).status, 403)
let heard = await sayIt({ text: ' Der Deploy ist fertig. ', lang: 'de' })
assert.deepEqual([heard.status, heard.headers.get('content-type'), Buffer.from(await heard.arrayBuffer()).toString()], [200, 'audio/mpeg', 'ID3 klang'])
assert.deepEqual(tinfoil.spoken, [{ model: 'qwen3-tts', input: 'Der Deploy ist fertig.', response_format: 'mp3', language: 'German' }])
assert.deepEqual([...new Set(tinfoil.auth)], ['Bearer tinfoil-geheim'])
heard = await sayIt({ text: 'Der Deploy ist fertig.', lang: 'de' })
assert.deepEqual([heard.status, tinfoil.spoken.length], [200, 1], 'the same piece is spoken from the cache')
// another language is another recording; an unknown one leaves the choice to the voice; WAV is passed on as WAV
tinfoil.sound = 'RIFF....WAVE'
heard = await sayIt({ text: 'Der Deploy ist fertig.', lang: 'en' })
assert.deepEqual([heard.headers.get('content-type'), tinfoil.spoken.at(-1).language], ['audio/wav', 'English'])
await sayIt({ text: 'Bonjour.', lang: '__proto__' })
assert.deepEqual(tinfoil.spoken.at(-1), { model: 'qwen3-tts', input: 'Bonjour.', response_format: 'mp3' })
assert.equal(tinfoil.spoken.length, 3)
// nothing to say, and a service that fails: said as text, nothing is kept
for (const bad of [{}, { text: '  ' }, { text: 7 }]) {
  const res = await sayIt(bad)
  assert.deepEqual([res.status, (await res.json()).error], [400, 'text is missing'])
}
tinfoil.sound = null
heard = await sayIt({ text: 'Das geht schief.', lang: 'de' })
assert.deepEqual([heard.status, (await heard.json()).error], [400, 'Speech service: no voice'])
tinfoil.sound = 'ID3 klang'
assert.equal((await sayIt({ text: 'Das geht schief.', lang: 'de' })).status, 200)
// what was spoken lies in the speech folder under a name that says nothing about the text (and is cleared here, for the counts below)
const recordings = fs.readdirSync(in4('speech')).filter(f => /^[0-9a-f]{24}\.mp3$/.test(f))
assert.equal(recordings.length, 4)
for (const f of recordings) fs.rmSync(in4('speech', f))
fakeSpeech.closeAllConnections()
fakeSpeech.close()
}

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
assert.equal(turned.headers.get('set-cookie'), `board_${PORT}=${fresh4}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`)
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
board4 = `board_${PORT}=${fresh4}`
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
assert.equal((await fetch(`${base}/`, { headers: { Cookie: `board_${PORT}=${token4}` } })).status, 401)
assert.equal((await adminGet('overview', admin4)).status, 403, 'admin sessions do not move to the next hub')
admin4 = await adminLogin(adminKey4, board4)
o = await (await adminGet('overview', admin4)).json()
assert.ok(['speiche', 'neu'].includes(o.hub.id))
assert.deepEqual(o.sessions.map(a => [a.id, a.online]), [['chef', false], ['speiche', true], ['neu', true]])
assert.deepEqual((await (await adminGet('log', admin4)).json()).entries.map(e => e.action).slice(-2), ['rotate', 'login'])
assert.ok(!(await say(speiche, 'list_cards', {})).isError && !(await say(neu, 'list_cards', {})).isError)
assert.equal(fs.readFileSync(in4('token'), 'utf8'), fresh4)

// ---- rich content: html beside a message or a question, and ```html fenced inside a text ----
{
  const { cleanHtml, HTML_MAX } = await import('../hub/richhtml.mjs')
  const textOf = res => res.content?.[0]?.text ?? ''
  const fails = async (name, args, pattern) => {
    const res = await say(neu, name, args).catch(err => ({ isError: true, content: [{ text: err.message }] }))
    assert.ok(res.isError, `${name} should have been refused`)
    assert.match(textOf(res), pattern)
  }
  const mine = async () => { const s = await state(board4); return { messages: s.messages.filter(m => m.agent === 'neu'), cards: s.cards.filter(c => c.agent === 'neu') } }
  const table = '<table><tr><th>Way</th><th>Lock</th></tr><tr><td>Now</td><td>40 s</td></tr></table>'

  // a message: the field is accepted, stored and delivered; the words stay what they were
  let res = await say(neu, 'reply', { text: 'Two ways, **now** is fine.', html: table })
  assert.equal(textOf(res), 'sent')
  let last = (await mine()).messages.at(-1)
  assert.deepEqual([last.text, last.html], ['Two ways, **now** is fine.', table])
  // never without words beside it, never anything but a string, never more than the limit
  await fails('reply', { text: '  ', html: table }, /html needs text beside it/)
  await fails('reply', { text: 'x', html: { a: 1 } }, /must be a string/)
  await fails('reply', { text: 'x', html: `<p>${'a'.repeat(HTML_MAX)}</p>` }, /at most 200 KB/)
  assert.equal(textOf(await say(neu, 'reply', { text: 'big but allowed', html: `<p>${'a'.repeat(HTML_MAX - 7)}</p>` })), 'sent')
  await fails('reply', { text: 'x', html: '<script>alert(1)</script>' }, /html is empty after cleaning/)
  // what runs, loads or sends is taken out before it is stored, and the agent is told
  res = await say(neu, 'reply', { text: 'cleaned', html: `<div onclick="steal()" title="on = > ok">A<script>fetch('/events')</script><img src="https://evil.example/p.png"><img src="data:image/png;base64,AAAA" onerror=x()><a href="java&#x73;cript:x()">l</a><a href="https://example.org/">w</a><iframe src="/"></iframe><form action="/message"><input name=t></form><meta http-equiv="refresh" content="0;url=https://evil.example"><style>@import "https://evil.example/a.css"; td { background: url(https://evil.example/b.png) }</style><scr<script>x</script>ipt>y()</scr<script></script>ipt></div>` })
  for (const what of ['<script> (', '<meta>', '<iframe>', '<form>', 'handlers (2)', 'script addresses', 'pictures from an address', 'addresses in CSS (2)']) assert.ok(textOf(res).startsWith('sent\nRemoved from your html') && textOf(res).includes(what), `the answer names ${what}`)
  last = (await mine()).messages.at(-1)
  assert.doesNotMatch(last.html, /<script|onclick|onerror|evil\.example|<iframe|<form|<meta|javascript|java&#|@import|steal|fetch/i)
  assert.match(last.html, /title="on = > ok"/)
  assert.match(last.html, /<img src="data:image\/png;base64,AAAA"\s*>/)
  assert.match(last.html, /<a href="https:\/\/example\.org\/">w<\/a>/)
  assert.match(last.html, /<input name=t>/)
  // cleaning what is clean changes nothing, and the next call does not inherit the report
  assert.equal(cleanHtml(last.html), last.html)
  assert.equal(textOf(await say(neu, 'reply', { text: 'plain' })), 'sent')

  // the same inside a text: a block fenced as html is cleaned in place, text and details alike; other fences are left alone
  res = await say(neu, 'reply', { text: 'Look:\n\n```html\n<b onmouseover="x()">bold</b><script>1</script>\n```\n\n```js\n<script>stays()</script>\n```', details: '```html\n<i>fine</i><script>2</script>\n```' })
  assert.match(textOf(res), /Removed from your html/)
  last = (await mine()).messages.at(-1)
  assert.equal(last.text, 'Look:\n\n```html\n<b >bold</b>\n```\n\n```js\n<script>stays()</script>\n```')
  assert.equal(last.details, '```html\n<i>fine</i>\n```')
  assert.equal(last.html, undefined)
  await fails('reply', { text: `\`\`\`html\n<p>${'a'.repeat(HTML_MAX)}</p>\n\`\`\`` }, /an html block in text is \d+ KB/)

  // a question: html beside the body
  const opts = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }]
  await fails('create_decision', { title: 'T', html: table, options: opts }, /html needs body beside it/)
  await fails('create_decision', { title: 'T', html: table, sections: [{ text: 'intro' }, { key: 'a', label: 'A', text: 'x' }, { key: 'b', label: 'B', text: 'y' }] }, /html and sections \(or text\) cannot be combined/)
  res = await say(neu, 'create_decision', { title: 'Which way?', body: 'Two ways.\n\n```html\n<p onclick="x()">' + 'long '.repeat(200) + '</p>\n```', html: `${table}<script>1</script>`, options: opts })
  const rid = textOf(res).match(/^card (\w+) /)[1]
  // a layout is looked at, not read: it does not count as a long body; what was removed is said
  assert.doesNotMatch(textOf(res), /a lot to read/)
  assert.match(textOf(res), /Removed from your html.*handlers, <script>/s)
  let card = (await mine()).cards.find(c => c.id === rid)
  assert.equal(card.html, table)
  assert.doesNotMatch(card.body, /onclick/)
  // revised: the new layout is the card's, the old one stays with the version it belonged to
  res = await say(neu, 'revise_card', { card_id: rid, html: '<ul><li>one</li><li>two</li></ul>', note: 'as a list' })
  assert.match(textOf(res), /revised/)
  card = (await mine()).cards.find(c => c.id === rid)
  assert.deepEqual([card.html, card.version, card.versions.length, card.versions[0].html], ['<ul><li>one</li><li>two</li></ul>', 2, 1, table])
  // untouched by a revision of something else; listed for the agent; taken away by ''
  await say(neu, 'revise_card', { card_id: rid, title: 'Which way then?' })
  card = (await mine()).cards.find(c => c.id === rid)
  assert.deepEqual([card.html, card.version, card.versions[1].html], ['<ul><li>one</li><li>two</li></ul>', 3, '<ul><li>one</li><li>two</li></ul>'])
  assert.equal(JSON.parse(textOf(await say(neu, 'list_cards', {}))).find(c => c.id === rid).html, card.html)
  assert.match(textOf(await say(neu, 'revise_card', { card_id: rid, html: '' })), /revised/)
  card = (await mine()).cards.find(c => c.id === rid)
  assert.deepEqual(['html' in card, card.version, card.versions.at(-1).html], [false, 4, '<ul><li>one</li><li>two</li></ul>'])
  assert.match(textOf(await say(neu, 'revise_card', { card_id: rid, html: '' })), /unchanged in wording/)

  // sections: a block carries its own layout, beside its own words
  await fails('create_decision', { title: 'T', sections: [{ text: 'intro' }, { key: 'a', label: 'A', html: table }, { key: 'b', label: 'B', text: 'y' }] }, /the html of section a needs text beside it/)
  res = await say(neu, 'create_decision', { title: 'Blocks', sections: [{ text: 'Intro.', html: `${table}<script>1</script>` }, { key: 'a', label: 'A', text: 'First.', html: '<mark>a</mark>' }, { key: 'b', label: 'B', text: 'Second.' }] })
  const sid = textOf(res).match(/^card (\w+) /)[1]
  card = (await mine()).cards.find(c => c.id === sid)
  assert.deepEqual(card.sections.map(s => s.html), [table, '<mark>a</mark>', undefined])
  assert.equal(card.body, 'Intro.\n\n**A**: First.\n\n**B**: Second.')
  assert.equal(card.html, undefined)
  // as one text: a fenced block keeps its blank lines and stays in its paragraph
  res = await say(neu, 'create_decision', { title: 'Text', text: 'Intro.\n\n```html\n<p>one</p>\n\n<p onclick="x()">two</p>\n```\n\n[a] A: First.\n```html\n<b>x</b>\n\n<b>y</b>\n```\n\n[b] B: Second.' })
  card = (await mine()).cards.find(c => c.id === textOf(res).match(/^card (\w+) /)[1])
  assert.deepEqual(card.sections.map(s => [s.key ?? null, s.text]), [[null, 'Intro.'], [null, '```html\n<p>one</p>\n\n<p >two</p>\n```'], ['a', 'First.\n```html\n<b>x</b>\n\n<b>y</b>\n```'], ['b', 'Second.']])
  // merged: the new card carries its layout
  res = await say(neu, 'merge_cards', { card_ids: [rid, sid], title: 'Both', body: 'In one.', html: table, options: opts })
  card = (await mine()).cards.find(c => c.id === textOf(res).match(/^card (\w+) /)[1])
  assert.equal(card.html, table)
  // nothing that runs was ever written down
  assert.doesNotMatch(JSON.stringify(readBoard(data4)).replace(/```js[\s\S]*?```/g, ''), /<script|onclick=|onerror=|evil\.example/i)
  // the reference shows a three-column comparison that is clean as it stands
  const example = (await (await fetch(`${base}/api/tools`, { headers: { Cookie: board4 } })).json()).tools.find(t => t.name === 'reply').example
  assert.equal(example.html.match(/<th>/g).length, 3)
  assert.equal(cleanHtml(example.html), example.html)
  assert.ok(example.text.trim())
}

await Promise.all([speiche.close(), neu.close()])

// ---- the board moves from state.json into SQLite: once, whole, and the file stays as it was ----
await portFree()
const data6 = fs.mkdtempSync(path.join(os.tmpdir(), 'board-test-'))
const in6 = name => path.join(data6, name)
const old6 = {
  hub: 'alt', next_number: 50, queue: ['veraltet'],
  agents: [
    { id: 'alt', name: 'Alt', model: 'm', client: '', task: 'umziehen', joined: 5, online: true, instance: 'x', position: 1, label: 'Mein Alter', icon: 'draw:brush', icon_by: 'human', starred: true, starred_at: 20 },
    { id: 'fern', name: 'Fern', model: 'm', client: '', task: '', joined: 6, online: false, position: 0, archived: true, group: 'paar', starred: true, starred_at: 10 },
  ],
  cards: [
    {
      id: 'c-offen', agent: 'alt', number: 41, kind: 'decision', status: 'open', urgency: 'high', urgency_reason: 'eilt', title: 'Dritte Fassung?', body: 'Vorweg.\n\n**A**: so.\n\n**B**: anders.',
      options: [{ key: 'a', label: 'A', detail: '' }, { key: 'b', label: 'B', detail: '' }], attachments: [], multiple: true, recommended: ['a'], choice: null, choices: [], note: '', summary: '', created: 100, decided: null,
      sections: [{ text: 'Vorweg.' }, { key: 'a', label: 'A', text: 'so.', recommended: true }, { key: 'b', label: 'B', text: 'anders.', recommended: false }],
      version: 3, revisions: 2, revised: 300, revision_note: 'klarer', with_agent: 350,
      versions: [{ n: 1, at: 100, title: 'Erste Fassung?', body: 'x', options: [{ key: 'a', label: 'A', detail: '' }, { key: 'b', label: 'B', detail: '' }], recommended: null, multiple: false, attachments: [], urgency: 'normal', note: '' },
        { n: 2, at: 200, title: 'Zweite Fassung?', body: 'y', options: [{ key: 'a', label: 'A', detail: '' }, { key: 'b', label: 'B', detail: '' }], recommended: 'a', multiple: false, attachments: [], urgency: 'high', note: 'Bild dazu' }],
      draft: { keys: ['b'], note: 'halb', notes: { a: 'eher nicht' }, marks: [{ id: 'm1', anchor: { kind: 'section', index: 2, x: 0.5 }, text: 'hier', strokes: [[1, 2, 3, 4]] }], ts: 400 },
    },
    { id: 'c-fertig', agent: 'alt', number: 42, kind: 'decision', status: 'decided', urgency: 'normal', urgency_reason: '', title: 'Schon beantwortet', body: '', options: [{ key: 'a', label: 'A', detail: '' }, { key: 'b', label: 'B', detail: '' }], attachments: [], multiple: false, choice: 'b', choices: ['b'], note: 'so', option_notes: { a: 'nein, weil' }, answered_version: 1, version: 1, summary: '', created: 110, decided: Date.now() },
    { id: 'c-weg', agent: 'fern', number: 43, kind: 'decision', status: 'shredded', shredded: Date.now(), urgency: 'low', urgency_reason: '', title: 'Weggeworfen', body: '', options: [{ key: 'a', label: 'A', detail: '' }, { key: 'b', label: 'B', detail: '' }], attachments: [], multiple: false, choice: null, choices: [], note: '', version: 1, summary: '', created: 120, decided: null },
    { id: 'c-info', agent: 'alt', number: 44, kind: 'info', status: 'open', urgency: 'normal', urgency_reason: '', title: 'Zum Lesen', body: 'So geht das.', options: [], attachments: [], multiple: false, recommended: null, choice: null, choices: [], note: '', version: 1, summary: '', created: 130, decided: null },
  ],
  messages: [
    { id: 'n1', agent: 'alt', from: 'user', text: 'hallo', attachments: [], ts: 1 },
    { id: 'dup', agent: 'alt', from: 'agent', text: 'erste mit dieser Kennung', attachments: [], ts: 2 },
    { id: 'dup', agent: 'alt', from: 'agent', text: 'zweite mit dieser Kennung', attachments: [], ts: 3 },
    { id: 'n4', agent: 'alt', from: 'event', kind: 'revised', card_id: 'c-offen', text: 'klarer', version: 3, ts: 4 },
    { id: 'n5', agent: 'fern', from: 'user', text: 'für Fern', attachments: [], handback: true, card_id: 'c-weg', marks: [{ id: 'x', anchor: { kind: 'card' }, text: 'Ümlaut “quote” 🙂' }], ts: 5 },
  ],
  tasks: [{ agent: 'alt', id: 'bau', label: 'Bau', state: 'working', detail: 'läuft', card_id: null, updated: 7 }, { agent: 'fern', id: 'bau', label: 'Bau', state: 'done', detail: '', card_id: null, updated: 8 }],
  assets: [],
  pending: { alt: [{ method: 'notifications/claude/channel', params: { content: 'wartete im alten Zustand', meta: { kind: 'chat' } }, ts: 9 }], fern: [{ method: 'notifications/claude/channel', params: { content: 'für später', meta: { kind: 'chat' } }, ts: Date.now() }] },
}
fs.writeFileSync(in6('state.json'), JSON.stringify(old6, null, 2))
const bytes6 = fs.readFileSync(in6('state.json'))
const on6 = { BOARD_DATA: data6, BOARD_ADMIN_TOKEN: '' }
const gotAlt = []
mark = logs.length
let alt = await start('Alt', gotAlt, on6)
// what the page gets is the old board, record for record
s = await state()
assert.deepEqual(s.cards, old6.cards)
// the messages get their running number in the order they were stored (card Nr. 33)
const seq6 = old6.messages.map((m, at) => ({ ...m, seq: at + 1 }))
assert.deepEqual(s.messages, seq6)
assert.deepEqual([s.message_seq, s.message_floor], [5, 0])
assert.deepEqual(s.tasks, old6.tasks)
assert.deepEqual(s.agents.map(a => [a.id, a.position, a.label ?? '', a.icon ?? '', a.archived ?? false, a.group ?? null, a.starred ?? false]), [['fern', 0, '', '', true, 'paar', false], ['alt', 1, 'Mein Alter', 'draw:brush', false, null, true]])
assert.deepEqual([s.next_number, s.queue], [50, ['c-offen', 'c-info']])
// what waited for the agent is handed over, what waits for one that is away keeps waiting
await until(() => gotAlt.length === 1)
assert.equal(gotAlt[0].params.content, 'wartete im alten Zustand')
// the database holds the same, the log says so once, and state.json is byte for byte what it was
let db6 = readBoard(data6)
assert.deepEqual([db6.cards, db6.messages, db6.tasks, db6.next_number, db6.pending], [old6.cards, seq6, old6.tasks, 50, { fern: old6.pending.fern }])
assert.equal(logs.slice(mark).filter(l => l.includes('the state moved from state.json into')).length, 1)
assert.match(logs.slice(mark).find(l => l.includes('the state moved')), /4 cards, 5 messages, 2 sessions\. state\.json is kept as it was and no longer written/)
assert.ok(fs.readFileSync(in6('state.json')).equals(bytes6) && fs.existsSync(in6('state.in-sqlite')))
for (const f of fs.readdirSync(data6).filter(f => f.startsWith('pad.db'))) assert.equal(fs.statSync(in6(f)).mode & 0o077, 0, f)
// from here on changes go to the database only
assert.equal((await post('/decide', { card_id: 'c-offen', keys: ['a'], note: 'nach dem Umzug' })).status, 200)
assert.equal((await post('/message', { text: 'neu nach dem Umzug', agent: 'alt' })).status, 200)
await call.call(null, 'list_cards', {}).catch(() => {})
db6 = readBoard(data6)
assert.deepEqual([db6.cards[0].status, db6.cards[0].choices, db6.cards[0].versions.length, 'draft' in db6.cards[0], db6.messages.at(-1).text, db6.messages.length], ['decided', ['a'], 2, false, 'neu nach dem Umzug', 7])
assert.ok(fs.readFileSync(in6('state.json')).equals(bytes6))
// the tool reads the same out again, as the JSON state.json would hold
const tool6 = (...args) => spawnSync('node', [toPath(new URL('./board-store.mjs', import.meta.url)), ...args], { encoding: 'utf8' })
assert.deepEqual(JSON.parse(tool6('counts', data6).stdout), { agents: 2, cards: 4, desks: 1, messages: 7, tasks: 2 })
assert.deepEqual(JSON.parse(tool6('export', data6).stdout).cards, db6.cards)
// a card copied into a message to another session: that agent reads the whole decision, the message keeps a chip, the card is untouched
{
  const before = JSON.stringify((await state()).cards)
  gotAlt.length = 0
  for (const wrong of [{ cards: 'x' }, { cards: ['gibtsnicht'] }, { cards: ['c-fertig', 1, 2, 3, 4, 5] }]) assert.equal((await post('/message', { text: 'x', agent: 'alt', ...wrong })).status, 400, JSON.stringify(wrong))
  assert.equal((await post('/message', { text: 'richte dich danach', agent: 'fern', cards: ['c-fertig'] })).status, 200, 'to a session that is away: it waits')
  assert.equal((await post('/message', { text: 'richte dich danach', agent: 'alt', cards: ['c-fertig', '42', 'c-weg', 'c-info'] })).status, 200)
  await until(() => gotAlt.length === 1)
  const got = gotAlt[0].params
  assert.equal(got.content, [
    'richte dich danach', '',
    '--- Question Nr. 42 (card c-fertig), asked by the session "Mein Alter" [alt] ---', 'Schon beantwortet', '',
    'Options:', '- A [a]', '- B [b]', '',
    'Answer: B [b]', 'The human\'s note: so', 'Note on A [a]: nein, weil', '',
    '--- Question Nr. 43 (card c-weg), asked by the session "Fern" [fern] ---', 'Weggeworfen', '',
    'Options:', '- A [a]', '- B [b]', '',
    'Answer: none. The human threw it away unanswered.', '',
    '--- Info Nr. 44 (card c-info), written by the session "Mein Alter" [alt] ---', 'Zum Lesen', '', 'So geht das.', '',
    'Not read yet.',
  ].join('\n'))
  assert.deepEqual([got.meta.kind, got.meta.cards, JSON.parse(got.meta.cards_json)[0]], ['chat', 'c-fertig,c-weg,c-info', { id: 'c-fertig', number: 42, title: 'Schon beantwortet', agent: 'alt', choice_label: 'B', kind: 'decision', status: 'decided', choices: ['b'] }])
  const now = await state()
  assert.deepEqual([now.messages.at(-1).agent, now.messages.at(-1).cards], ['alt', [{ id: 'c-fertig', number: 42, title: 'Schon beantwortet', agent: 'alt', choice_label: 'B' }, { id: 'c-weg', number: 43, title: 'Weggeworfen', agent: 'fern', choice_label: null }, { id: 'c-info', number: 44, title: 'Zum Lesen', agent: 'alt', choice_label: null }]])
  assert.equal(JSON.stringify(now.cards), before, 'the cards themselves are as they were')
  // a message may be nothing but the card; an open question with advice and a picture reads so
  assert.equal((await post('/message', { text: '', agent: 'alt', cards: ['c-offen'] })).status, 200)
  await until(() => gotAlt.length === 2)
  assert.match(gotAlt[1].params.content, /^The human passes a card on to you\.\n\n--- Question Nr\. 41 \(card c-offen\), .*\nDritte Fassung\?\n\n[\s\S]*\nOptions \(several may be chosen\):\n- A \[a\] \(the agent's advice\)\n- B \[b\]\n\nAnswer: A \[a\]\nThe human's note: nach dem Umzug$/)
}

// a restart reads the database: a state.json that says something else is not looked at again
await alt.close()
await portFree()
fs.writeFileSync(in6('state.json'), JSON.stringify({ cards: [], messages: [{ id: 'falsch', agent: 'alt', from: 'user', text: 'aus der alten Datei', ts: 1 }] }))
mark = logs.length
alt = await start('Alt', [], on6)
s = await state()
assert.deepEqual([s.cards.map(c => [c.id, c.status]), s.messages.some(m => m.text === 'aus der alten Datei'), s.messages.some(m => m.text === 'neu nach dem Umzug'), s.next_number], [[['c-offen', 'decided'], ['c-fertig', 'decided'], ['c-weg', 'shredded'], ['c-info', 'open']], false, true, 50])
assert.equal(logs.slice(mark).filter(l => l.includes('the state moved')).length, 0)
assert.deepEqual(s.agents.map(a => [a.id, a.online]), [['fern', false], ['alt', true]])
await alt.close()
await portFree()
// told to stay with state.json, a hub does not start beside a board that has moved
const stay = spawnSync('node', [SERVER], { env: serverEnv('Alt', { ...on6, BOARD_STORE: 'json', BOARD_HUB_ONLY: '1' }), encoding: 'utf8' })
assert.deepEqual([stay.status, /this board rests in SQLite .*BOARD_STORE=json/.test(stay.stderr)], [1, true])
// a board that never had a state.json is born in the database, and one kept in JSON on purpose stays there
const data7 = fs.mkdtempSync(path.join(os.tmpdir(), 'board-test-'))
const born = await start('Neu', [], { BOARD_DATA: data7 })
await say(born, 'reply', { text: 'erste Nachricht' })
assert.deepEqual([readBoard(data7).messages.map(m => m.text), fs.existsSync(path.join(data7, 'state.json')), fs.existsSync(path.join(data7, 'state.in-sqlite'))], [['erste Nachricht'], false, true])
await born.close()
await portFree()
const data8 = fs.mkdtempSync(path.join(os.tmpdir(), 'board-test-'))
const plain = await start('Json', [], { BOARD_DATA: data8, BOARD_STORE: 'json' })
await say(plain, 'reply', { text: 'bleibt in der Datei' })
assert.deepEqual([JSON.parse(fs.readFileSync(path.join(data8, 'state.json'), 'utf8')).messages.map(m => m.text), fs.existsSync(path.join(data8, 'state.in-sqlite')), readBoard(data8)], [['bleibt in der Datei'], false, null])
await plain.close()

// ---- stable agent ids (card Nr. 80): made once by the hub, kept by the session with a key, never handed on ----
await portFree()
const data9 = fs.mkdtempSync(path.join(os.tmpdir(), 'board-test-'))
const on9 = { BOARD_DATA: data9 }
const hub9 = () => {
  const child = spawn('node', [SERVER], { env: serverEnv('Dienst', { ...on9, BOARD_HUB_ONLY: '1' }), stdio: ['ignore', 'ignore', 'ignore'] })
  spawned.push(child)
  return child
}
let h9 = hub9()
await eventually(async () => (await state()).agents.length === 0, 'the hub for stable ids')
const online9 = async id => (await state()).agents.find(a => a.id === id)?.online
const link9 = async (name, { instance = crypto.randomBytes(4).toString('hex'), claims, keeps = true, id } = {}) => {
  const ctl = new AbortController()
  const q = new URLSearchParams({ name, instance, ...(keeps ? { keeps: '1' } : {}), ...(id ? { id } : {}) })
  const headers = { 'x-board-token': 'secret', ...(claims ? { 'x-board-claims': Buffer.from(JSON.stringify(claims)).toString('base64url') } : {}) }
  const res = await fetch(`http://127.0.0.1:${PORT}/agent/link?${q}`, { headers, signal: ctl.signal })
  const reader = res.body.getReader()
  let buffer = ''
  while (!buffer.includes('\n\n')) buffer += new TextDecoder().decode((await reader.read()).value)
  const hello = JSON.parse(buffer.slice(6, buffer.indexOf('\n\n')))
  return { id: hello.hello, key: hello.key, instance, close: async () => { ctl.abort(); await eventually(async () => !(await online9(hello.hello)), `${hello.hello} to go away`) } }
}
const sha = key => crypto.createHash('sha256').update(key).digest('hex')
// a new session: the slug of its name, and a key that the hub keeps only as a hash, never on the page
const bau = await link9('Bau')
assert.deepEqual([bau.id, /^[0-9a-f]{32}$/.test(bau.key)], ['bau', true])
let rec9 = readBoard(data9).agents.find(a => a.id === 'bau')
assert.deepEqual([rec9.key_hash, rec9.bound], [sha(bau.key), true])
assert.ok(!JSON.stringify(await state()).includes(rec9.key_hash) && !JSON.stringify(readBoard(data9)).includes(bau.key))
await bau.close()
// it comes back under another name: same id, no new key, the name is only a label
const renamed = await link9('Umbenannt', { claims: [{ id: 'bau', key: bau.key }] })
assert.deepEqual([renamed.id, renamed.key, (await state()).agents.find(a => a.id === 'bau').name], ['bau', undefined, 'Umbenannt'])
// a second process with the same key while the first is linked, a wrong key, no key: each a session of its own
const twin9 = await link9('Bau', { claims: [{ id: 'bau', key: bau.key }] })
const forged = await link9('Bau', { claims: [{ id: 'bau', key: 'f'.repeat(32) }, { id: 'nobody', key: 'x' }, 'junk'] })
await renamed.close()
const fresh9 = await link9('Bau')
assert.deepEqual([twin9.id, forged.id, fresh9.id], ['bau-2', 'bau-3', 'bau-4'], 'a session that keeps its key is never taken over by name')
for (const l of [twin9, forged, fresh9]) await l.close()
// the oldest claim that fits wins; one held by a running process is passed over
const both = await link9('Bau', { claims: [{ id: 'bau-2', key: twin9.key }, { id: 'bau', key: bau.key }] })
assert.equal(both.id, 'bau-2')
await both.close()
// sessions from before stable ids, and processes that keep no key (an older server.mjs, dev/session.mjs), as before:
// the same instance gets its id back, and a new process gets the slug of its name while nobody holds it
const old9 = await link9('Alt', { keeps: false, instance: 'alt1' })
assert.equal(old9.id, 'alt')
await old9.close()
assert.equal((await link9('Alt', { keeps: false, instance: 'alt1', id: 'alt' }).then(async l => { await l.close(); return l.id })), 'alt')
const oldNew = await link9('Alt', { keeps: false })
assert.equal(oldNew.id, 'alt')
await oldNew.close()
assert.equal(readBoard(data9).agents.find(a => a.id === 'alt').bound, undefined)
// …until a process that keeps keys takes it: then it is bound to that key
const adopt = await link9('Alt')
assert.deepEqual([adopt.id, typeof adopt.key], ['alt', 'string'])
await adopt.close()
const late9 = await link9('Alt', { keeps: false })
assert.equal(late9.id, 'alt-2')
await late9.close()
// a forgotten session's id is never handed out again, also not after a restart of the hub
const admin9 = await adminLogin('adminkey', cookie)
assert.equal((await adminPost('sessions/forget', { id: 'bau-4', confirm: 'bau-4' }, admin9)).status, 200)
assert.deepEqual(readBoard(data9).retired_ids, ['bau-4'])
h9.kill()
await portFree()
h9 = hub9()
await eventually(async () => (await state()).agents.length > 0, 'the hub for stable ids, again')
const next9 = await link9('Bau')
assert.equal(next9.id, 'bau-5')
await next9.close()
const again9 = await link9('Bau', { claims: [{ id: 'bau', key: bau.key }] })
assert.equal(again9.id, 'bau', 'the key outlives a restart of the hub')
await again9.close()
// a Claude Code session (server.mjs as a spoke) keeps its key in data/agents/, so a restarted process is who it was
const spoke9 = await start('Werk', [], on9)
await say(spoke9, 'reply', { text: 'erstes Leben' })
await spoke9.close()
await eventually(async () => !(await online9('werk')), 'werk to go away')
const keyFiles = fs.readdirSync(path.join(data9, 'agents'))
assert.equal(keyFiles.length, 1)
assert.equal(fs.statSync(path.join(data9, 'agents', keyFiles[0])).mode & 0o077, 0)
assert.equal(readBoard(data9).agents.find(a => a.id === 'werk').bound, true)
const spoke9b = await start('Werk', [], on9)
const spoke9c = await start('Werk', [], on9)
await say(spoke9b, 'reply', { text: 'zweites Leben' })
await say(spoke9c, 'reply', { text: 'ein anderer' })
s = await state()
assert.deepEqual(s.messages.filter(m => m.from === 'agent').map(m => [m.agent, m.text]), [['werk', 'erstes Leben'], ['werk', 'zweites Leben'], ['werk-2', 'ein anderer']])
assert.equal(JSON.parse(fs.readFileSync(path.join(data9, 'agents', keyFiles[0]), 'utf8')).length, 2)
await Promise.all([spoke9b.close(), spoke9c.close()])
h9.kill()

// ---- pairing and keys behind BOARD_PAIRING (docs/pairing.md): off by default, then a room, an agent joins, it all survives a restart ----
await portFree()
assert.equal((await fetch(`${base}/pair/room`, { headers: { Cookie: cookie } }).catch(() => null)), null, 'nothing listens between the hubs')
{
  const z = await import('../crypto/zcrypto.mjs')
  const HUB = 'https://hub.example'
  const data10 = fs.mkdtempSync(path.join(os.tmpdir(), 'board-test-'))
  const hub10 = pairing => {
    const child = spawn('node', [SERVER], { env: serverEnv('Dienst', { BOARD_DATA: data10, BOARD_HUB_ONLY: '1', BOARD_PAIR_HUB_URL: HUB, ...(pairing ? { BOARD_PAIRING: '1' } : {}) }), stdio: ['ignore', 'ignore', 'ignore'] })
    spawned.push(child)
    return child
  }
  // off by default: the routes are not there
  let h10 = hub10(false)
  await eventually(async () => (await fetch(`${base}/healthz`)).ok, 'the hub without pairing')
  assert.equal((await fetch(`${base}/pair/room`, { headers: { Cookie: cookie } })).status, 404)
  h10.kill()
  await portFree()
  h10 = hub10(true)
  await eventually(async () => (await fetch(`${base}/healthz`)).ok, 'the hub with pairing')
  // only behind today's login, and a page's write only from the page's own origin
  assert.equal((await fetch(`${base}/pair/room`)).status, 401)
  assert.equal((await fetch(`${base}/pair/challenge`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.example' } })).status, 403)
  assert.deepEqual(await (await fetch(`${base}/pair/room`, { headers: { Cookie: cookie } })).json(), { roomId: null, members: [] })
  // the hub module's interface over HTTP, so the clients below speak to it as crypto/hub-test.mjs does
  const enc = v => JSON.stringify(v, (k, x) => (x instanceof Uint8Array ? z.b64u(x) : x))
  const call = async (method, route, { token, body } = {}) => {
    const res = await fetch(`http://127.0.0.1:${PORT}/pair/${route}`, { method, headers: { 'x-board-token': 'secret', 'Content-Type': 'application/json', ...(token ? { 'x-pair-token': token } : {}) }, body: body ? enc(body) : undefined })
    const out = await res.json()
    if (!res.ok) throw new z.ZError(out.error, out.message)
    return out
  }
  const B = z.unb64u
  const http10 = {
    found: async a => call('POST', 'found', { body: a }),
    postEntry: async a => call('POST', 'entry', { body: a }),
    challenge: async () => B((await call('POST', 'challenge')).challenge),
    signIn: async signed => call('POST', 'sign-in', { body: { signed } }),
    log: async ({ token, inviteId }) => { const r = await call('GET', `log${inviteId ? `?invite=${inviteId}` : ''}`, { token }); return { ...r, entries: r.entries.map(B) } },
    wraps: async (token, { afterEpoch = 0 } = {}) => (await call('GET', `wraps?after_epoch=${afterEpoch}`, { token })).map(w => ({ epoch: w.epoch, sealed: B(w.sealed) })),
    postInvite: async (token, offer) => call('POST', 'invites', { token, body: { offer } }),
    invite: async id => { const r = await call('GET', `invites/${id}`); return { ...r, offer: B(r.offer), entries: r.entries.map(B) } },
    postRequest: async (id, request) => call('POST', `invites/${id}/requests`, { body: { request } }),
    requests: async (token, id) => (await call('GET', `invites/${id}/requests`, { token })).map(B),
    postReveal: async (token, id, reveal) => call('POST', `invites/${id}/reveal`, { token, body: { reveal } }),
    joinStatus: async (id, hash) => { const r = await call('GET', `invites/${id}/status?request=${hash}`); return { ...r, ...(r.reveal ? { reveal: B(r.reveal) } : {}), ...(r.entries ? { entries: r.entries.map(B) } : {}), ...(r.wrap ? { wrap: B(r.wrap) } : {}) } },
    postEnvelope: async (token, envelope) => call('POST', 'envelopes', { token, body: { envelope } }),
    envelopes: async (token, after = 0) => (await call('GET', `envelopes?after=${after}`, { token })).map(e => ({ ...e, bytes: B(e.bytes) })),
    claim: async (token, name, instance) => call('POST', 'claim', { token, body: { name, instance } }),
  }
  const signIn10 = async (device, roomId) => (await http10.signIn(await z.signHubAuth({ device, roomId, hub: HUB, challenge: await http10.challenge() }))).token
  // the phone founds the room
  const phone = await z.generateDevice()
  const room = await z.createRoom({ device: phone, name: 'Phone', recovery: await z.recoveryDevice(z.generateRecoveryCode()) })
  await http10.found({ entry: room.entry, wraps: room.wraps })
  await assert.rejects(http10.found({ entry: room.entry, wraps: room.wraps }), e => ['room-exists', 'replay'].includes(e.code))
  const roomId = room.roomId
  let phoneToken = await signIn10(phone, roomId)
  let phoneState = await z.verifyLog((await http10.log({ token: phoneToken })).entries, roomId)
  // an agent joins by a link, without a check code
  const agent = await z.generateDevice({ extractable: true })
  const made = await z.createInvite({ state: phoneState, inviter: phone, hub: HUB, role: z.ROLE.AGENT })
  await http10.postInvite(phoneToken, made.offer)
  const link = z.parseInviteLink(made.link)
  const inviteId = z.hex(await z.hkdf(link.secret, link.roomId, z.LABEL.inviteId, new Uint8Array(0), 16))
  const served = await http10.invite(inviteId)
  const { request, join } = await z.createJoinRequest({ link: made.link, offer: served.offer, log: served.entries, device: agent, name: 'Krypto' })
  const { requestHash } = await http10.postRequest(inviteId, request)
  assert.equal((await http10.joinStatus(inviteId, requestHash)).status, 'waiting')
  const [first] = await http10.requests(phoneToken, inviteId)
  const { reveal } = await z.acceptJoinRequest({ invite: made.invite, request: first, inviter: phone })
  await http10.postReveal(phoneToken, inviteId, reveal)
  assert.equal((await http10.joinStatus(inviteId, requestHash)).status, 'revealed')
  const done = await z.finalizeInvite({ invite: made.invite, state: phoneState, inviter: phone, secret: room.secret, skipCheckCode: true })
  await http10.postEntry({ entry: done.entry, wraps: done.wrap ? [{ id: agent.id, sealed: done.wrap }] : [] })   // agents get no room key (v1.1)
  const fin = await http10.joinStatus(inviteId, requestHash)
  assert.equal(fin.status, 'joined')
  const joined = await z.completeJoin({ join, device: agent, log: fin.entries, wrap: fin.wrap })
  // the agent signs in and claims its board session; a second process under the same key is refused
  const agentToken = await signIn10(agent, roomId)
  assert.deepEqual([(await http10.claim(agentToken, 'Krypto', 'p1')).sessionId], ['krypto'])
  await assert.rejects(http10.claim(agentToken, 'Krypto', 'p2'), e => e.code === 'instance-conflict')
  await assert.rejects(http10.claim(phoneToken, 'Phone', 'p1'), e => e.code === 'forbidden')
  // a sealed envelope from the phone under the room key (agents read session keys only since v1.1); the phone reads it back
  phoneState = await z.verifyLog((await http10.log({ token: phoneToken })).entries, roomId)
  const env = await z.sealEnvelope({ device: phone, state: phoneState, secret: room.secret, chains: z.newChains(), kind: z.KIND.TIMELINE_ITEM, timelineKind: z.TIMELINE.CHAT, timelineId: 'desk/' + '0d'.repeat(16), payload: z.utf8('run the tests') })
  assert.equal((await http10.postEnvelope(phoneToken, env.bytes)).n, 1)
  await assert.rejects(http10.postEnvelope(phoneToken, env.bytes), e => e.code === 'replay')
  await assert.rejects(http10.envelopes('falsch'), e => e.code === 'unauthorised')
  // after a restart the hub verifies what it stored, and everything is still there
  h10.kill()
  await portFree()
  h10 = hub10(true)
  await eventually(async () => (await fetch(`${base}/healthz`)).ok, 'the hub with pairing, again')
  const room10 = await (await fetch(`${base}/pair/room`, { headers: { Cookie: cookie } })).json()
  assert.deepEqual([room10.roomId, room10.members.map(m => [m.role, m.active])], [z.hex(roomId), [['human', true], ['agent', true]]])
  const agentToken2 = await signIn10(agent, roomId)
  const [got] = await http10.envelopes(agentToken2)
  void joined
  const opened = await z.openEnvelope(got.bytes, { state: phoneState, chains: z.newChains(), secrets: new Map([[1, room.secret]]) })
  assert.equal(new TextDecoder().decode(opened.payload), 'run the tests')
  assert.equal((await http10.claim(agentToken2, 'Anders', 'p3')).sessionId, 'krypto', 'the same key, the same session id')
  assert.ok(!fs.readFileSync(path.join(data10, 'pad.db')).includes(Buffer.from('run the tests')), 'the hub stored ciphertext only')
  h10.kill()
  await portFree()
  fs.rmSync(data10, { recursive: true })
}

// ---- passkey login (server/passkey.mjs): a software authenticator registers and signs in; everything forged is refused ----
{
  const data11 = fs.mkdtempSync(path.join(os.tmpdir(), 'board-test-'))
  const h11 = spawn('node', [SERVER], { env: serverEnv('Dienst', { BOARD_DATA: data11, BOARD_HUB_ONLY: '1' }), stdio: ['ignore', 'ignore', 'pipe'] })
  spawned.push(h11)
  let err11 = ''
  h11.stderr.on('data', chunk => { err11 += chunk })
  await eventually(async () => (await fetch(`${base}/healthz`)).ok, 'the hub for passkeys')
  const u = b => Buffer.from(b).toString('base64url')
  const sha = b => crypto.createHash('sha256').update(b).digest()
  const pk = (route, body = {}, { as, origin = base } = {}) => fetch(`${base}/auth/passkey/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...(as ? { Cookie: as } : {}) }, body: JSON.stringify(body) })
  const errorOf = async res => [res.status, (await res.json()).error]
  // an authenticator in software: a key pair, a credential id, a counter
  const authenticator = (kind = 'ec') => {
    const { publicKey, privateKey } = kind === 'ec' ? crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }) : kind === 'rsa' ? crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }) : crypto.generateKeyPairSync('ed25519')
    const jwk = publicKey.export({ format: 'jwk' })
    const B = x => Buffer.from(x, 'base64url')
    const bstr = b => Buffer.concat([b.length < 24 ? Buffer.from([0x40 + b.length]) : b.length < 256 ? Buffer.from([0x58, b.length]) : Buffer.from([0x59, b.length >> 8, b.length & 255]), b])
    const cose = kind === 'ec' ? Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21]), bstr(B(jwk.x)), Buffer.from([0x22]), bstr(B(jwk.y))])
      : kind === 'rsa' ? Buffer.concat([Buffer.from([0xa4, 0x01, 0x03, 0x03, 0x39, 0x01, 0x00, 0x20]), bstr(B(jwk.n)), Buffer.from([0x21]), bstr(B(jwk.e))])
        : Buffer.concat([Buffer.from([0xa4, 0x01, 0x01, 0x03, 0x27, 0x20, 0x06, 0x21]), bstr(B(jwk.x))])
    const id = crypto.randomBytes(32)
    const a = { id, count: 0, privateKey }
    const head = (rp, flags) => { const n = Buffer.alloc(4); n.writeUInt32BE(++a.count); return Buffer.concat([sha(rp), Buffer.from([flags]), n]) }
    const clientData = (type, challenge, origin) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }))
    a.create = (challenge, { origin = base, rp = 'localhost', flags = 0x45 } = {}) => {
      const len = Buffer.alloc(2); len.writeUInt16BE(id.length)
      const authData = Buffer.concat([head(rp, flags), Buffer.alloc(16), len, id, cose])
      const text = t => Buffer.concat([Buffer.from([0x60 + t.length]), Buffer.from(t)])
      const att = Buffer.concat([Buffer.from([0xa3]), text('fmt'), text('none'), text('attStmt'), Buffer.from([0xa0]), text('authData'), bstr(authData)])
      return { clientDataJSON: u(clientData('webauthn.create', challenge, origin)), attestationObject: u(att) }
    }
    a.get = (challenge, { origin = base, rp = 'localhost', flags = 0x05, type = 'webauthn.get', key = privateKey } = {}) => {
      const authData = head(rp, flags), cd = clientData(type, challenge, origin)
      const signed = Buffer.concat([authData, sha(cd)])
      const signature = kind === 'ed' ? crypto.sign(null, signed, key) : crypto.sign('sha256', signed, key)
      return { id: u(id), clientDataJSON: u(cd), authenticatorData: u(authData), signature: u(signature) }
    }
    return a
  }
  const challengeFor = async (route, opts) => (await (await pk(route, {}, opts)).json()).challenge
  // without the cookie: a page gets the sign-in page, an API route the plain refusal, both 401
  const page = await fetch(`${base}/s/api?q=abc`)
  assert.deepEqual([page.status, page.headers.get('content-type'), /Sign in with a passkey/.test(await page.clone().text()), /data\/url\.txt/.test(await page.text())], [401, 'text/html; charset=utf-8', true, true])
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/)
  const refusedApi = await fetch(`${base}/events`)
  assert.deepEqual([refusedApi.status, await refusedApi.text()], [401, 'Access only through the link in data/url.txt'])
  assert.equal((await fetch(`${base}/auth/passkey.js`)).status, 200)
  // registering, listing and removing: only signed in, and only from the hub's own pages
  for (const route of ['register/options', 'register/verify', 'remove']) assert.deepEqual(await errorOf(await pk(route)), [401, 'unauthorised'], route)
  assert.equal((await fetch(`${base}/auth/passkey/list`)).status, 401)
  assert.equal((await fetch(`${base}/passkeys`)).status, 401)
  assert.deepEqual(await errorOf(await pk('login/options', {}, { origin: 'https://evil.example' })), [403, 'forbidden'])
  assert.deepEqual(await errorOf(await pk('register/options', {}, { as: cookie, origin: 'https://evil.example' })), [403, 'forbidden'])
  assert.match(await (await fetch(`${base}/passkeys`, { headers: { Cookie: cookie } })).text(), /Add a passkey on this device/)
  // a stolen registration challenge is no use to someone who is not signed in
  const phone = authenticator()
  const options = await (await pk('register/options', {}, { as: cookie })).json()
  assert.deepEqual([options.rp, options.attestation, options.authenticatorSelection.residentKey, options.pubKeyCredParams.map(p => p.alg), options.excludeCredentials], [{ name: 'Trommi' }, 'none', 'required', [-7, -8, -257], []])
  assert.deepEqual(await errorOf(await pk('register/verify', phone.create(options.challenge))), [401, 'unauthorised'])
  // refused: another origin, another rp, no user present, a login challenge, a challenge used before
  assert.deepEqual(await errorOf(await pk('register/verify', phone.create(await challengeFor('register/options', { as: cookie }), { origin: 'https://evil.example' }), { as: cookie })), [403, 'wrong-origin'])
  assert.deepEqual(await errorOf(await pk('register/verify', phone.create(await challengeFor('register/options', { as: cookie }), { rp: 'evil.example' }), { as: cookie })), [403, 'wrong-rp'])
  assert.deepEqual(await errorOf(await pk('register/verify', phone.create(await challengeFor('register/options', { as: cookie }), { flags: 0x44 }), { as: cookie })), [400, 'user-not-present'])
  assert.deepEqual(await errorOf(await pk('register/verify', phone.create(await challengeFor('login/options')), { as: cookie })), [400, 'bad-challenge'])
  // registered; the same attestation again is a replay
  const made = phone.create(await challengeFor('register/options', { as: cookie }))
  const added = await pk('register/verify', { ...made, name: 'Phone' }, { as: cookie })
  assert.deepEqual([added.status, (await added.json()).name], [200, 'Phone'])
  assert.deepEqual(await errorOf(await pk('register/verify', made, { as: cookie })), [400, 'bad-challenge'])
  let listed = (await (await fetch(`${base}/auth/passkey/list`, { headers: { Cookie: cookie } })).json()).passkeys
  assert.deepEqual(listed.map(p => [p.name, p.host, p.last_used, /^[0-9a-f]{12}$/.test(p.handle)]), [['Phone', 'localhost', null, true]])
  assert.deepEqual((await (await pk('register/options', {}, { as: cookie })).json()).excludeCredentials, [{ type: 'public-key', id: u(phone.id) }])
  // signing in: the cookie the login link sets, and it opens the board
  const good = await pk('login/verify', phone.get(await challengeFor('login/options')))
  assert.equal(good.status, 200)
  assert.equal(good.headers.get('set-cookie'), `board_${PORT}=secret; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`)
  assert.equal((await fetch(`${base}/`, { headers: { Cookie: good.headers.get('set-cookie').split(';')[0] } })).status, 200)
  const stranger = authenticator()
  // RS256 and EdDSA authenticators work as well
  for (const kind of ['rsa', 'ed']) {
    const other = authenticator(kind)
    assert.equal((await pk('register/verify', { ...other.create(await challengeFor('register/options', { as: cookie })), name: kind }, { as: cookie })).status, 200, kind)
    assert.equal((await pk('login/verify', other.get(await challengeFor('login/options')))).status, 200, kind)
    if (kind === 'rsa') assert.deepEqual(await errorOf(await pk('login/verify', other.get(await challengeFor('login/options'), { key: stranger.privateKey }))), [401, 'bad-signature'], kind)
  }
  // refused, and none of it sets a cookie: a replayed challenge, a wrong origin, a wrong rp, a registration challenge,
  // the wrong type, a signature by another key, a changed signature, an unknown credential, a counter that went back
  const spent = await challengeFor('login/options')
  assert.equal((await pk('login/verify', phone.get(spent))).status, 200)
  const forged = phone.get(await challengeFor('login/options'))
  forged.signature = u(Buffer.from(forged.signature, 'base64url').map((b, at) => (at === 12 ? b ^ 1 : b)))
  const before11 = phone.count
  const bad = [
    [phone.get(spent), 400, 'bad-challenge'],
    [phone.get(await challengeFor('login/options'), { origin: 'https://evil.example' }), 403, 'wrong-origin'],
        [phone.get(await challengeFor('login/options'), { rp: 'board.example' }), 403, 'wrong-rp'],
    [phone.get(await challengeFor('register/options', { as: cookie })), 400, 'bad-challenge'],
    [phone.get(await challengeFor('login/options'), { type: 'webauthn.create' }), 400, 'wrong-type'],
    [phone.get(await challengeFor('login/options'), { key: stranger.privateKey }), 401, 'bad-signature'],
    [forged, 401, 'bad-signature'],
    [stranger.get(await challengeFor('login/options')), 401, 'unknown-passkey'],
  ]
  for (const [body, status, code] of bad) {
    const res = await pk('login/verify', body)
    assert.deepEqual([res.headers.get('set-cookie'), ...(await errorOf(res))], [null, status, code], code)
  }
  // nine failures in a minute are borne, the tenth closes the door for everyone until the minute is over
  phone.count = 1
  assert.deepEqual(await errorOf(await pk('login/verify', phone.get(await challengeFor('login/options')))), [401, 'counter-went-back'])
  phone.count = before11 + 20
  assert.deepEqual(await errorOf(await pk('login/verify', phone.get(await challengeFor('login/options')))), [429, 'too-many-attempts'])
  // nothing of it on the page, in the state or in the log; the database has the public key and no more
  const frame11 = JSON.stringify(await state())
  assert.ok(!frame11.includes(u(phone.id)) && !frame11.includes('passkey'))
  assert.ok(!err11.includes(u(phone.id)))
  const { DatabaseSync } = await import('node:sqlite')
  const db11 = new DatabaseSync(path.join(data11, 'pad.db'), { readOnly: true })
  const row11 = db11.prepare("SELECT * FROM passkeys WHERE name = 'Phone'").get()
  db11.close()
  assert.deepEqual([row11.id, row11.rp_id, row11.alg, Object.keys(JSON.parse(row11.jwk)).sort(), row11.name], [u(phone.id), 'localhost', -7, ['crv', 'kty', 'x', 'y'], 'Phone'])
  // removed: it no longer signs in (checked after a restart, which also lifts the limit and keeps the passkeys)
  h11.kill()
  await portFree()
  const h11b = spawn('node', [SERVER], { env: serverEnv('Dienst', { BOARD_DATA: data11, BOARD_HUB_ONLY: '1', BOARD_PUBLIC_URL: 'https://board.example' }), stdio: ['ignore', 'ignore', 'ignore'] })
  spawned.push(h11b)
  await eventually(async () => (await fetch(`${base}/healthz`)).ok, 'the hub for passkeys, again')
  assert.equal((await pk('login/verify', phone.get(await challengeFor('login/options')))).status, 200, 'a passkey outlives a restart')
  // this hub has a public address: a passkey is made there only (one made on localhost would not work on the phone),
  // and the page says so with a link; a passkey that exists still signs in here
  for (const route of ['register/options', 'register/verify']) {
    const res = await pk(route, {}, { as: cookie })
    assert.deepEqual([res.status, await res.json()], [409, { error: 'use-public-address', public: 'https://board.example/passkeys' }], route)
  }
  const manage = await (await fetch(`${base}/passkeys`, { headers: { Cookie: cookie } })).text()
  assert.match(manage, /data-home="https:\/\/board\.example"[\s\S]*href="https:\/\/board\.example\/passkeys"[\s\S]*data\/url\.txt/)
  assert.match(manage, /<meta name="viewport" content="width=device-width, initial-scale=1">/)
  listed = (await (await fetch(`${base}/auth/passkey/list`, { headers: { Cookie: cookie } })).json()).passkeys
  assert.deepEqual(listed.map(p => [p.name, p.last_used > 0]), [['Phone', true], ['rsa', true], ['ed', true]])
  assert.deepEqual(await errorOf(await pk('remove', { handle: 'gibtsnicht' }, { as: cookie })), [404, 'not-found'])
  assert.equal((await pk('remove', { handle: listed[0].handle }, { as: cookie })).status, 200)
  assert.deepEqual(await errorOf(await pk('login/verify', phone.get(await challengeFor('login/options')))), [401, 'unknown-passkey'])
  // the login link works as it did
  const viaLink = await fetch(`${base}/?t=secret`, { redirect: 'manual' })
  assert.deepEqual([viaLink.status, viaLink.headers.get('set-cookie')], [302, `board_${PORT}=secret; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`])
  h11b.kill()
  await portFree()
  fs.rmSync(data11, { recursive: true })
}

// ---- assets: uploads that were cut off, fetches counted per caller, release for third parties (docs/asset-sharing.md) ----
{
  const data12 = fs.mkdtempSync(path.join(os.tmpdir(), 'board-test-'))
  const on12 = { BOARD_DATA: data12, BOARD_ASSET_RATE: '40' }
  const teiler = await start('Teiler', [], on12)
  const txt = res => res.content[0].text
  const [aid, akey] = linkOf(await publish(teiler, { content: '<h1>für Dritte</h1><script>document.title = 1</script>', title: 'Angebot Müller', note: 'zum Weitergeben' }))
  const [hid, hkey] = linkOf(await publish(teiler, { content: 'still', silent: true, type: 'file' }))
  const get = route => fetch(base + route)
  // the board's own address is for who is signed in (card Nr. 175); `get` is the stranger
  const inside = route => fetch(base + route, { headers: { Cookie: cookie } })
  const share = body => post('/asset/share', body)
  // the board's own viewer and blob answer as they did, with the stricter headers
  const viaA = await inside(`/a/${aid}/blob`)
  assert.deepEqual([viaA.status, viaA.headers.get('cross-origin-resource-policy'), viaA.headers.get('x-content-type-options'), viaA.headers.get('cache-control'), viaA.headers.get('content-security-policy'), /camera=\(\)/.test(viaA.headers.get('permissions-policy'))], [200, 'same-origin', 'nosniff', 'no-store', "default-src 'none'; sandbox", true])
  // an upload that was cut off on its way is refused: a whole blob has one of few lengths
  const whole = Buffer.from(await viaA.arrayBuffer())
  const linked12 = await fetch(`http://127.0.0.1:${PORT}/agent/link?name=Lader&instance=lader1`, { headers: { 'x-board-token': 'secret' } })
  const lader = JSON.parse(new TextDecoder().decode((await linked12.body.getReader().read()).value).split('\n')[0].slice(6)).hello
  const upload12 = (id, blob) => fetch(`http://127.0.0.1:${PORT}/agent/asset?id=${lader}&instance=lader1`, { method: 'POST', headers: { 'x-board-token': 'secret', 'x-asset': Buffer.from(JSON.stringify({ id, silent: true })).toString('base64url') }, body: blob })
  const cut = await upload12('C'.repeat(22), whole.subarray(0, whole.length - 7))
  assert.deepEqual([cut.status, /cut off/.test((await cut.json()).error), fs.existsSync(path.join(data12, 'assets', 'C'.repeat(22)))], [400, true, false])
  assert.equal((await upload12('D'.repeat(22), whole)).status, 200, 'a whole blob under a fresh id is taken (it will not open: the id is part of what is authenticated)')
  await assert.rejects(openAsset(Buffer.from(await (await inside(`/a/${'D'.repeat(22)}/blob`)).arrayBuffer()), akey, 'D'.repeat(22)), 'a blob replayed under another id does not open')
  // not released: outsiders get the page (the same for every id) and no ciphertext, whether the asset exists or not
  const page12 = await get(`/r/${aid}`)
  const html12 = await page12.text()
  assert.deepEqual([page12.status, page12.headers.get('content-security-policy').includes("script-src 'self'"), page12.headers.get('content-security-policy').includes("frame-ancestors 'none'"), html12 === await (await get(`/r/${'x'.repeat(22)}`)).text()], [200, true, true, true])
  assert.match(html12, /Shared with you through Trommi[\s\S]*name="viewport"|name="viewport"[\s\S]*Shared with you through Trommi/)
  assert.ok(!/\/js\/|\/css\/|\/a\/-\//.test(html12) && !html12.includes('Angebot'), 'nothing of the board on the recipient\'s page')
  for (const [file, type] of [['view.js', 'text/javascript; charset=utf-8'], ['view.css', 'text/css; charset=utf-8'], ['frame.html', 'text/html; charset=utf-8']]) {
    const res = await get(`/r/-/${file}`)
    assert.deepEqual([res.status, res.headers.get('content-type')], [200, type], file)
    if (file === 'frame.html') assert.match(res.headers.get('content-security-policy'), /default-src 'none'.*sandbox allow-scripts$/)
  }
  for (const id of [aid, hid, 'x'.repeat(22), '-']) assert.equal((await get(`/r/${id}/blob`)).status, 404, id)
  assert.equal((await fetch(`${base}/r/${aid}/blob`, { method: 'POST', headers: { Origin: base, Cookie: cookie } })).status, 404)
  // releasing is the session's own, or the human's; never another session's
  const other12 = await start('Fremd', [], on12)
  assert.match((await other12.callTool({ name: 'share_asset', arguments: { id: aid } }).then(r => txt(r), e => e.message)), /no asset/)
  assert.equal((await fetch(`${base}/asset/share`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ id: aid }) })).status, 401)
  const none12 = await share({ id: 'gibtsnicht' })
  assert.deepEqual([none12.status, await none12.json()], [404, { error: 'no such asset', code: 'no-asset' }])
  assert.deepEqual(await (await post('/asset/gibtsnicht', {})).json().then(o => o.code, () => undefined), undefined, 'an unknown route says nothing of the kind')
  const said = txt(await teiler.callTool({ name: 'share_asset', arguments: { id: aid, expires_hours: 2 } }))
  assert.match(said, new RegExp(`is released until .*\\nLink for the recipient: http://localhost:${PORT}/r/${aid}#${akey}\\n`))
  // the recipient fetches the ciphertext and opens it with the key from the link; each fetch is counted
  const got12 = await get(`/r/${aid}/blob`)
  assert.equal(got12.status, 200)
  const opened12 = await openAsset(Buffer.from(await got12.arrayBuffer()), akey, aid)
  assert.deepEqual([opened12.header.title, opened12.content.toString().startsWith('<h1>für Dritte</h1>')], ['Angebot Müller', true])
  await get(`/r/${aid}/blob`)
  await eventually(async () => (await state()).assets.find(a => a.id === aid).share?.opens === 2, 'the opens to be counted')
  let rec12 = (await state()).assets.find(a => a.id === aid)
  assert.deepEqual([rec12.share.opens, rec12.share.expires > Date.now() + 7000000, rec12.share.opened > 0, JSON.stringify(rec12).includes(akey)], [2, true, true, false])
  // the page gets the outside addresses with the state (so they survive a reload); they are not stored
  assert.deepEqual([rec12.share.urls, 'urls' in readBoard(data12).assets.find(a => a.id === aid).share, (await state()).assets.find(a => a.id === hid).share], [[`http://localhost:${PORT}/r/${aid}`], false, undefined])
  assert.deepEqual(JSON.parse(txt(await teiler.callTool({ name: 'list_assets', arguments: {} }))).map(a => [a.id, a.released, a.opens ?? null]), [[aid, true, 2], [hid, false, null]])
  // a silent asset can be released too; the hub cannot complete its link
  assert.match(txt(await teiler.callTool({ name: 'share_asset', arguments: { id: hid } })), new RegExp(`/r/${hid}#<key>\\n[\\s\\S]*does not know the key`))
  assert.equal((await openAsset(Buffer.from(await (await get(`/r/${hid}/blob`)).arrayBuffer()), hkey, hid)).content.toString(), 'still')
  // the human changes the release (no end, kept), and takes it back: gone at once, the board's own link still opens
  let res12 = await share({ id: aid, expires_hours: 0, keep: true })
  assert.deepEqual([res12.status, await res12.json().then(o => [o.released, o.path, o.urls, o.share.expires, o.share.opens])], [200, [true, `/r/${aid}`, [`http://localhost:${PORT}/r/${aid}`], null, 2]])
  assert.equal((await state()).assets.find(a => a.id === aid).keep, true)
  assert.equal((await share({ id: aid, expires_hours: -1 })).status, 400)
  res12 = await share({ id: aid, release: false })
  const back12 = await res12.json()
  assert.deepEqual([back12.path, back12.urls], [null, []])
  assert.deepEqual([res12.status, back12.released, (await get(`/r/${aid}/blob`)).status, (await inside(`/a/${aid}/blob`)).status, 'share' in (await state()).assets.find(a => a.id === aid)], [200, false, 404, 200, false])
  assert.match(txt(await teiler.callTool({ name: 'share_asset', arguments: { id: hid, release: false } })), /release taken back/)
  // a release that has run out is none
  await teiler.callTool({ name: 'share_asset', arguments: { id: aid, expires_hours: 0.00002 } })
  await sleep(120)
  assert.equal((await get(`/r/${aid}/blob`)).status, 404)
  assert.equal(JSON.parse(txt(await teiler.callTool({ name: 'list_assets', arguments: {} })))[0].released, false)
  // revoking ends both addresses
  await teiler.callTool({ name: 'share_asset', arguments: { id: aid } })
  assert.equal((await get(`/r/${aid}/blob`)).status, 200)
  await teiler.callTool({ name: 'revoke_asset', arguments: { id: aid } })
  assert.deepEqual([(await get(`/r/${aid}/blob`)).status, (await inside(`/a/${aid}/blob`)).status], [404, 404])
  // the admin log has every step, by id, without key or title
  const journal12 = fs.readFileSync(path.join(data12, 'admin-log.jsonl'), 'utf8')
  assert.deepEqual(journal12.trim().split('\n').map(l => JSON.parse(l).action), ['asset-released', 'asset-released', 'asset-release-changed', 'asset-unreleased', 'asset-unreleased', 'asset-released', 'asset-released'])
  assert.ok(journal12.includes(aid) && !journal12.includes(akey) && !journal12.includes(hkey) && !journal12.includes('Angebot'))
  // fetches without a login are counted per caller: beyond the limit 429 until the minute is over
  let last12 = 200
  for (let i = 0; i < 45 && last12 !== 429; i++) last12 = (await get(`/r/${hid}/blob`)).status
  assert.equal(last12, 429)
  assert.deepEqual([(await inside(`/a/${hid}/blob`)).status, (await get(`/a/${hid}/blob`)).status], [429, 401])
  await Promise.all([teiler.close(), other12.close()])
  await portFree()
  // ---- assets only with the login, strangers need a release (card Nr. 175) ----
  // without the login: the ciphertext a 401, the page the sign-in page, the viewer's files a 401; with it: all there
  const gated = await start('Teiler', [], { BOARD_DATA: data12 })
  const [gid, gkey] = linkOf(await publish(gated, { content: 'nur für mich' }))
  assert.deepEqual([(await get(`/a/${gid}/blob`)).status, (await get(`/a/${gid}`)).status, (await get('/a/-/asset.js')).status, (await get(`/r/${gid}/blob`)).status], [401, 401, 401, 404])
  assert.match(await (await get(`/a/${gid}`)).text(), /Sign in with a passkey/)
  assert.deepEqual([(await inside(`/a/${gid}`)).status, (await inside('/a/-/asset.js')).status, (await inside(`/r/${gid}/blob`)).status], [200, 200, 404])
  assert.equal((await openAsset(Buffer.from(await (await inside(`/a/${gid}/blob`)).arrayBuffer()), gkey, gid)).content.toString(), 'nur für mich')
  // a release opens it for someone without a login, under /r/ only: the board's own address still wants the login
  await gated.callTool({ name: 'share_asset', arguments: { id: gid } })
  const out12 = await get(`/r/${gid}/blob`)
  assert.deepEqual([out12.status, (await get(`/r/${gid}`)).status, (await get(`/a/${gid}/blob`)).status, (await get(`/a/${gid}`)).status], [200, 200, 401, 401])
  assert.equal((await openAsset(Buffer.from(await out12.arrayBuffer()), gkey, gid)).content.toString(), 'nur für mich')
  // taken back: gone for the stranger at once, still there for who is signed in
  await gated.callTool({ name: 'share_asset', arguments: { id: gid, release: false } })
  assert.deepEqual([(await get(`/r/${gid}/blob`)).status, (await inside(`/a/${gid}/blob`)).status], [404, 200])
  // run out: gone as well
  await gated.callTool({ name: 'share_asset', arguments: { id: gid, expires_hours: 0.00002 } })
  await sleep(120)
  assert.deepEqual([(await get(`/r/${gid}/blob`)).status, (await inside(`/a/${gid}/blob`)).status], [404, 200])
  // revoked while released: gone under both addresses, for everyone
  await gated.callTool({ name: 'share_asset', arguments: { id: gid } })
  assert.equal((await get(`/r/${gid}/blob`)).status, 200)
  await gated.callTool({ name: 'revoke_asset', arguments: { id: gid } })
  assert.deepEqual([(await get(`/r/${gid}/blob`)).status, (await inside(`/a/${gid}/blob`)).status, (await get(`/a/${gid}/blob`)).status], [404, 404, 401])
  await gated.close()
  await portFree()
  // BOARD_ASSET_LOGIN=0 is the way back to "the link is the permission"; nothing sets it
  const open12 = await start('Teiler', [], { BOARD_DATA: data12, BOARD_ASSET_LOGIN: '0' })
  const [oid] = linkOf(await publish(open12, { content: 'x' }))
  assert.deepEqual([(await get(`/a/${oid}/blob`)).status, (await get(`/a/${oid}`)).status], [200, 200])
  await open12.close()
  await portFree()
  // without passkeys the refusal of the page is the plain one
  const plain12 = await start('Teiler', [], { BOARD_DATA: data12, BOARD_PASSKEYS: '0' })
  const shut12 = await get(`/a/${oid}`)
  assert.deepEqual([shut12.status, await shut12.text(), (await inside(`/a/${oid}`)).status], [401, 'Access only through the link in data/url.txt', 200])
  await plain12.close()
  await portFree()
  fs.rmSync(data12, { recursive: true })
}

// ---- an option in two or three words (card Nr. 157): options[i].short, cut at a word, absent when not given ----
{
  const data15 = fs.mkdtempSync(path.join(os.tmpdir(), 'board-test-'))
  const kurz = await start('Kurz', [], { BOARD_DATA: data15 })
  const made = async (name, args) => { const r = await kurz.callTool({ name, arguments: args }); assert.ok(!r.isError, r.content[0].text); return r.content[0].text.match(/card (\w+) /)[1] }
  const cardOf = async id => (await state()).cards.find(c => c.id === id)
  const a15 = await made('create_decision', { title: 'Alte Entwürfe?', options: [{ key: 'del', label: 'Alle alten Entwürfe endgültig löschen', short: '  Löschen ' }, { key: 'keep', label: 'Im Archiv behalten', short: 'Im Archiv behalten und nie wieder ansehen' }, { key: 'x', label: 'Später', short: '   ' }] })
  assert.deepEqual((await cardOf(a15)).options, [{ key: 'del', label: 'Alle alten Entwürfe endgültig löschen', detail: '', short: 'Löschen' }, { key: 'keep', label: 'Im Archiv behalten', detail: '', short: 'Im Archiv behalten' }, { key: 'x', label: 'Später', detail: '' }])
  assert.deepEqual(JSON.parse((await kurz.callTool({ name: 'list_cards', arguments: {} })).content[0].text).find(c => c.id === a15).options.map(o => o.short), ['Löschen', 'Im Archiv behalten', undefined])
  // one long word is cut at the limit
  const b15 = await made('create_decision', { title: 'Wort?', options: [{ key: 'a', label: 'A', short: 'Donaudampfschifffahrtsgesellschaft' }, { key: 'b', label: 'B' }] })
  assert.deepEqual((await cardOf(b15)).options.map(o => o.short), ['Donaudampfschifffa', undefined])
  // in sections and in the text form the flagged block carries it, and so does its option
  const c15 = await made('create_decision', { title: 'Blöcke?', sections: [{ text: 'Vorweg.' }, { key: 'a', label: 'Ausführlich erklären', short: 'Lang', text: 'so' }, { key: 'b', label: 'Knapp halten', text: 'anders' }] })
  let k15 = await cardOf(c15)
  assert.deepEqual([k15.sections.map(x => x.short), k15.options], [[undefined, 'Lang', undefined], [{ key: 'a', label: 'Ausführlich erklären', detail: '', short: 'Lang' }, { key: 'b', label: 'Knapp halten', detail: '' }]])
  const d15 = await made('create_decision', { title: 'Text?', text: 'Vorweg.\n\n[a] Alles neu bauen: dauert.\nshort: Neu bauen\n\n[b*] Flicken: geht schnell.\nshort: Flicken\npicture: 0', attachments: [shot] })
  k15 = await cardOf(d15)
  assert.deepEqual([k15.options.map(o => [o.key, o.short]), k15.sections.filter(x => x.key).map(x => [x.text, x.short, x.picture ?? null])], [[['a', 'Neu bauen'], ['b', 'Flicken']], [['dauert.', 'Neu bauen', null], ['geht schnell.', 'Flicken', 0]]])
  // revised: what the new options say; merged: the new card's own
  await made('revise_card', { card_id: a15, options: [{ key: 'del', label: 'Löschen' }, { key: 'keep', label: 'Behalten', short: 'Bleibt' }] })
  assert.deepEqual((await cardOf(a15)).options.map(o => o.short), [undefined, 'Bleibt'])
  await made('revise_card', { card_id: a15, title: 'Alte Entwürfe weg?' })
  assert.deepEqual((await cardOf(a15)).options.map(o => o.short), [undefined, 'Bleibt'], 'a rewording of something else leaves it')
  const m15 = await made('merge_cards', { card_ids: [b15, c15], title: 'Beides?', options: [{ key: 'j', label: 'Ja, beides zusammen', short: 'Beides' }, { key: 'n', label: 'Nein, getrennt lassen', short: 'Getrennt' }] })
  assert.deepEqual((await cardOf(m15)).options.map(o => o.short), ['Beides', 'Getrennt'])
  await kurz.close()
  await portFree()
  fs.rmSync(data15, { recursive: true })
}

// ---- where on a picture the thing is: attachments[i].marks, regions in fractions of the picture ----
{
  const data16 = fs.mkdtempSync(path.join(os.tmpdir(), 'board-test-'))
  const zeiger = await start('Zeiger', [], { BOARD_DATA: data16 })
  const run = async (name, args) => zeiger.callTool({ name, arguments: args }).then(r => [r.isError === true, r.content[0].text], e => [true, e.message])
  const opts = [option('a'), option('b')]
  const note16 = path.join(data16, 'notiz.txt')
  fs.writeFileSync(note16, 'kein Bild')
  const files16 = () => fs.readdirSync(path.join(data16, 'files')).length
  // one mark, or several; clamped into the picture, the label cut; the plain forms beside it as before
  let [bad16, out16] = await run('create_decision', { title: 'Wo?', options: opts, attachments: [{ path: shot, mark: { x: 0.1, y: 0.82, w: 0.8, h: 0.5, label: '  Die Zeile   am Fuß des Bildschirms  ' } }, shot, { path: shot, title: 'ohne' }] })
  assert.equal(bad16, false, out16)
  const wo = out16.match(/^card (\w+) /)[1]
  const att = async id => (await state()).cards.find(c => c.id === id).attachments
  assert.deepEqual((await att(wo)).map(a => a.marks), [[{ x: 0.1, y: 0.82, w: 0.8, h: 0.18, label: 'Die Zeile am Fuß des Bil' }], undefined, undefined])
  ;[bad16, out16] = await run('reply', { text: 'hier', attachments: [{ path: shot, marks: [{ x: -1, y: 0, w: 0.5, h: 0.25 }, { x: 0.5, y: 0.5, w: 9, h: 9 }], mark: { x: 0.2, y: 0.2, w: 0.1, h: 0.1 } }] })
  assert.equal(bad16, false, out16)
  assert.deepEqual((await state()).messages.at(-1).attachments[0].marks, [{ x: 0.2, y: 0.2, w: 0.1, h: 0.1 }, { x: 0, y: 0, w: 0.5, h: 0.25 }, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }])
  // refused, and nothing is copied: no numbers, no size, more than four, a file that is no picture
  const before16 = files16()
  for (const [entry, why] of [
    [{ path: shot, mark: { x: '0.1', y: 0, w: 0.5, h: 0.5 } }, /a mark on mock\.png is \{ x, y, w, h \} in fractions/],
    [{ path: shot, mark: 'unten' }, /a mark on mock\.png is/],
    [{ path: shot, mark: { x: 1, y: 0, w: 0.5, h: 0.5 } }, /has no size inside the picture/],
    [{ path: shot, mark: { x: 0, y: 0, w: 0, h: 0.5 } }, /has no size inside the picture/],
    [{ path: shot, marks: Array(5).fill({ x: 0, y: 0, w: 0.1, h: 0.1 }) }, /at most 4 marks on one picture/],
    [{ path: note16, mark: { x: 0, y: 0, w: 0.5, h: 0.5 } }, /a mark needs a picture; notiz\.txt is none/],
  ]) {
    ;[bad16, out16] = await run('create_decision', { title: 'x', options: opts, attachments: [entry] })
    assert.deepEqual([bad16, why.test(out16)], [true, true], out16)
  }
  assert.equal(files16(), before16)
  // revised: the same picture again without a word about marks keeps them; a new mark replaces, null takes them away
  await run('revise_card', { card_id: wo, attachments: [shot] })
  assert.deepEqual((await att(wo)).map(a => a.marks), [[{ x: 0.1, y: 0.82, w: 0.8, h: 0.18, label: 'Die Zeile am Fuß des Bil' }]])
  await run('revise_card', { card_id: wo, title: 'Wo genau?' })
  assert.equal((await att(wo))[0].marks.length, 1, 'a rewording of something else leaves them')
  await run('revise_card', { card_id: wo, attachments: [{ path: shot, mark: { x: 0, y: 0, w: 0.25, h: 0.25 } }] })
  assert.deepEqual((await att(wo))[0].marks, [{ x: 0, y: 0, w: 0.25, h: 0.25 }])
  await run('revise_card', { card_id: wo, attachments: [{ path: shot, mark: null }] })
  assert.equal('marks' in (await att(wo))[0], false)
  // the earlier versions keep what they showed; a merged card carries its own
  assert.deepEqual((await state()).cards.find(c => c.id === wo).versions.map(v => v.attachments[0].marks?.length ?? 0), [1, 1, 1, 1])
  const other16 = (await run('create_decision', { title: 'Und?', options: opts }))[1].match(/^card (\w+) /)[1]
  ;[bad16, out16] = await run('merge_cards', { card_ids: [wo, other16], title: 'Beides?', options: opts, attachments: [{ path: shot, mark: { x: 0.5, y: 0.5, w: 0.5, h: 0.5, label: 'hier' } }] })
  assert.deepEqual((await att(out16.match(/card (\w+) /)[1]))[0].marks, [{ x: 0.5, y: 0.5, w: 0.5, h: 0.5, label: 'hier' }])
  await zeiger.close()
  await portFree()
  fs.rmSync(data16, { recursive: true })
}

// ---- the fixed order of the stack: oldest first, and whatever leaves and comes back stands where it stood ----
{
  const data17 = fs.mkdtempSync(path.join(os.tmpdir(), 'board-test-'))
  const fest = await start('Fest', [], { BOARD_DATA: data17 })
  const file = async (title, extra = {}) => (await fest.callTool({ name: 'create_decision', arguments: { title, options: [option('a'), option('b')], ...extra } })).content[0].text.match(/^card (\w+) /)[1]
  const tell = async (name, args) => (await fest.callTool({ name, arguments: args })).content[0].text
  const [c1, c2, c3, c4] = [await file('eins'), await file('zwei', { urgency: 'critical', urgency_reason: 'eilt' }), await file('drei', { urgency: 'low' }), await file('vier', { urgency: 'high', urgency_reason: 'x' })]
  const order = async () => (await state()).queue
  assert.deepEqual(await order(), [c1, c2, c3, c4])
  // the details of a card go under it as a message: on an open card that is with the human this changes nothing
  // about the card, neither its place nor its state, and nothing is sent to anyone but the pages
  const before17 = JSON.stringify([(await state()).cards.find(c => c.id === c2), await order()])
  assert.equal(await tell('reply', { text: 'Hintergrund: gemessen an 3 Läufen, 412 ms im Mittel.', card_id: c2, details: 'lange Herleitung' }), 'sent')
  let s17 = await state()
  assert.equal(JSON.stringify([s17.cards.find(c => c.id === c2), s17.queue]), before17)
  assert.deepEqual([s17.messages.at(-1).card_id, s17.messages.at(-1).from, s17.messages.at(-1).details, 'presented' in s17.messages.at(-1), s17.messages.at(-1).kind ?? null], [c2, 'agent', 'lange Herleitung', false, null])
  assert.equal(await tell('reply', { text: 'und fertig', card_id: c2, present: true }), 'sent', 'present on a card that is not in revision does nothing')
  assert.equal(JSON.stringify([(await state()).cards.find(c => c.id === c2), await order()]), before17)
  // raised, lowered, reworded: nobody moves
  await tell('set_urgency', { card_id: c3, urgency: 'critical', reason: 'jetzt' })
  await tell('set_urgency', { card_id: c2, urgency: 'low' })
  assert.match(await tell('revise_card', { card_id: c4, title: 'vier, neu gefasst' }), /position 4 of 4 in the stack/)
  assert.deepEqual(await order(), [c1, c2, c3, c4])
  // put off and back; handed back and presented again; answered and taken back: each returns to its own place
  assert.equal((await post('/snooze', { card_id: c2 })).status, 200)
  assert.deepEqual(await order(), [c1, c3, c4])
  assert.equal((await post('/snooze', { card_id: c2, clear: true })).status, 200)
  assert.deepEqual(await order(), [c1, c2, c3, c4])
  assert.equal((await post('/message', { text: 'anders', card_id: c1, handback: true })).status, 200)
  await sleep(300)
  await tell('revise_card', { card_id: c1, title: 'eins, überarbeitet' })
  assert.deepEqual(await order(), [c1, c2, c3, c4])
  await sleep(300)
  assert.equal((await post('/decide', { card_id: c3, key: 'a' })).status, 200)
  assert.deepEqual(await order(), [c1, c2, c4])
  assert.equal((await post('/reopen', { card_id: c3 })).status, 200)
  assert.deepEqual(await order(), [c1, c2, c3, c4])
  // a new card goes to the end; a merged one stands where the oldest of the cards it replaces stood
  const c5 = await file('fünf', { urgency: 'critical', urgency_reason: 'x' })
  assert.deepEqual(await order(), [c1, c2, c3, c4, c5])
  const merged = (await tell('merge_cards', { card_ids: [c4, c2], title: 'zwei und vier', options: [option('a'), option('b')] })).match(/^card (\w+) /)[1]
  assert.deepEqual(await order(), [c1, merged, c3, c5])
  assert.deepEqual(JSON.parse(await tell('list_cards', {})).filter(c => c.queue_position).map(c => [c.id, c.queue_position]), [[c1, 1], [c3, 3], [c5, 4], [merged, 2]])
  // and so it stands after a restart
  await fest.close()
  await portFree()
  const fest2 = await start('Fest', [], { BOARD_DATA: data17 })
  assert.deepEqual(await order(), [c1, merged, c3, c5])
  await fest2.close()
  await portFree()
  fs.rmSync(data17, { recursive: true })
}

// ---- test cards: the hub files fake decisions as its own session "Demo", and takes them away again ----
{
  const data18 = fs.mkdtempSync(path.join(os.tmpdir(), 'board-test-'))
  const echt = await start('Echt', [], { BOARD_DATA: data18 })
  const fake = body => post('/dev/fake-decisions', body)
  // only the signed-in human, from the page itself; n within reason
  assert.equal((await fetch(`${base}/dev/fake-decisions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: '{}' })).status, 401)
  assert.equal((await post('/dev/fake-decisions', {}, 'https://evil.example')).status, 403)
  for (const n of [0, 21, 1.5, 'fünf']) assert.equal((await fake({ n })).status, 400, String(n))
  assert.deepEqual(await (await fake({ clear: true })).json(), { ok: true, cards: [] })
  // five by default: one of each kind in turn, cards like any other, from a session that is plainly no agent
  let res18 = await fake({})
  assert.deepEqual([res18.status, await res18.json()], [200, { ok: true, cards: [1, 2, 3, 4, 5] }])
  s = await state()
  const demo18 = s.agents.find(a => a.id === 'demo')
  assert.deepEqual([demo18.name, demo18.demo, demo18.online, demo18.main, demo18.parent ?? null, demo18.desk], ['Demo', true, false, false, null, 'main'])
  let fakes = s.cards.filter(c => c.agent === 'demo')
  assert.ok(fakes.every(c => c.title.startsWith('Test: ') && c.status === 'open'))
  assert.deepEqual(fakes.map(c => [c.kind, c.options.length, c.multiple, c.urgency, [c.recommended ?? []].flat().length]), [['decision', 2, false, 'normal', 1], ['decision', 2, false, 'normal', 0], ['decision', 3, false, 'normal', 1], ['decision', 5, true, 'normal', 2], ['decision', 2, false, 'critical', 0]])
  assert.deepEqual(fakes[1].options.map(o => o.short), ['Löschen', 'Behalten'])
  assert.deepEqual(s.queue, fakes.map(c => c.id))
  // the next ones go on in the cycle: two pictures that belong to their options, then one that is only to be read
  assert.deepEqual((await (await fake({ n: 3 })).json()).cards, [6, 7, 8])
  s = await state()
  fakes = s.cards.filter(c => c.agent === 'demo')
  assert.deepEqual([fakes[5].attachments.map(a => [a.name, a.image]), fakes[6].kind, fakes[7].title], [[['design-a.png', true], ['design-b.png', true]], 'info', 'Test: Backup heute Nacht laufen lassen?'])
  assert.equal((await fetch(base + fakes[5].attachments[0].url, { headers: { Cookie: cookie } })).status, 200)
  // answering one closes it: nobody is waiting, nothing queues up for the session
  assert.equal((await post('/decide', { card_id: fakes[0].id, key: 'yes' })).status, 200)
  assert.equal((await post('/decide', { card_id: fakes[3].id, keys: ['done', 'next'] })).status, 200)
  assert.equal((await post('/message', { text: 'hallo Demo', agent: 'demo' })).status, 200)
  await eventually(async () => (await state()).cards.find(c => c.id === fakes[0].id).status === 'done', 'the answered test card to close')
  s = await state()
  assert.deepEqual([s.cards.find(c => c.id === fakes[0].id).choice, s.cards.find(c => c.id === fakes[3].id).status, s.cards.find(c => c.id === fakes[3].id).choices, readBoard(data18).pending], ['yes', 'done', ['done', 'next'], {}])
  // a real session called Demo does not take the hub's own over, and real cards are left alone by the clearing
  const real18 = (await echt.callTool({ name: 'create_decision', arguments: { title: 'echt', options: [option('a'), option('b')] } })).content[0].text.match(/^card (\w+) /)[1]
  const named = await start('Demo', [], { BOARD_DATA: data18 })
  await eventually(async () => (await state()).agents.some(a => a.id === 'demo-2'), 'the real Demo')
  const files18 = fs.readdirSync(path.join(data18, 'files')).length
  res18 = await fake({ clear: true })
  assert.deepEqual((await res18.json()).cards, [1, 2, 3, 4, 5, 6, 7, 8])
  s = await state()
  assert.deepEqual([s.agents.map(a => a.id), s.cards.map(c => c.id), s.messages.some(m => m.agent === 'demo'), fs.readdirSync(path.join(data18, 'files')).length, readBoard(data18).retired_ids], [['echt', 'demo-2'], [real18], false, files18 - 2, []])
  // and again, after the clearing
  assert.deepEqual((await (await fake({ n: 1 })).json()).cards.length, 1)
  await Promise.all([echt.close(), named.close()])
  await portFree()
  fs.rmSync(data18, { recursive: true })
}

// ---- memos: the human's notes that rest on the hub until they are sent ----
{
  const data19 = fs.mkdtempSync(path.join(os.tmpdir(), 'board-test-'))
  const on19 = { BOARD_DATA: data19, BOARD_MEMO_HOLD_MS: '300' }   // a sent memo is held this long (server.mjs memoAct)
  const got19 = [], gotB19 = []
  const eins19 = await start('Eins', got19, on19)
  const zwei19 = await start('Zwei', gotB19, on19)
  await eventually(async () => (await state()).agents.length === 2, 'both sessions')
  const memo = body => post('/memo', body)
  const png = 'data:image/png;base64,' + fs.readFileSync(shot).toString('base64')
  const files19 = () => fs.readdirSync(path.join(data19, 'files'))
  assert.deepEqual((await state()).memos, [])
  // only the signed-in human, from the page
  assert.equal((await fetch(`${base}/memo`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: '{}' })).status, 401)
  assert.equal((await post('/memo', {}, 'https://evil.example')).status, 403)
  // made (an empty note is one), changed, moved
  let res19 = await memo({})
  let m19 = (await res19.json()).memo
  assert.deepEqual([res19.status, { ...m19, id: 0, created: 0, updated: 0 }, /^[0-9a-f]{8}$/.test(m19.id), m19.created === m19.updated], [200, { id: 0, text: '', to: null, session: null, place: 'float', x: 0, y: 0, attachments: [], created: 0, updated: 0 }, true, true])
  await sleep(5)
  m19 = (await (await memo({ id: m19.id, text: 'Milch kaufen', place: 'paper', x: 1200.5, y: -40, to: 'zwei' })).json()).memo
  assert.deepEqual([m19.text, m19.place, m19.x, m19.y, m19.to, m19.updated > m19.created], ['Milch kaufen', 'paper', 1200.5, -40, 'zwei', true])
  const second = (await (await memo({ text: 'zweite Notiz', x: 0.25, y: 0.5 })).json()).memo
  assert.deepEqual((await state()).memos.map(m => m.text), ['zweite Notiz', 'Milch kaufen'], 'newest first')
  // refused, and nothing changes: an unknown note, place, session, a coordinate that is no number
  for (const [body, status] of [[{ id: 'gibtsnicht', text: 'x' }, 404], [{ id: m19.id, place: 'wand' }, 400], [{ id: m19.id, to: 'niemand' }, 404], [{ id: m19.id, x: 'links' }, 400], [{ remove: true }, 400], [{ send: true }, 400], [{ id: m19.id, attachments: [{ url: '/files/fremd.png' }] }, 400]]) assert.equal((await memo(body)).status, status, JSON.stringify(body))
  assert.equal((await state()).memos[1].text, 'Milch kaufen')
  // files are stored like a message's; the list given is the whole list, what is left out is deleted
  m19 = (await (await memo({ id: m19.id, attachments: [{ name: 'eins.png', data: png }, { name: 'zwei.png', data: png }] })).json()).memo
  assert.deepEqual([m19.attachments.map(a => [a.name, a.image, a.kind]), files19().length], [[['eins.png', true, 'image'], ['zwei.png', true, 'image']], 2])
  assert.equal((await fetch(base + m19.attachments[0].url, { headers: { Cookie: cookie } })).status, 200)
  m19 = (await (await memo({ id: m19.id, attachments: [{ url: m19.attachments[1].url }, { name: 'drei.png', data: png }] })).json()).memo
  assert.deepEqual([m19.attachments.map(a => a.name), files19().length], [['zwei.png', 'drei.png'], 2])
  // nothing of it has reached an agent, and the cleanup of loose files leaves a note's files alone
  assert.deepEqual([got19.length, gotB19.length, (await state()).messages.length], [0, 0, 0])
  const admin19 = await adminLogin('adminkey', cookie)
  assert.equal((await adminPost('orphans', { confirm: 'orphans' }, admin19)).status, 200)
  assert.equal(files19().length, 2)
  // it all survives a restart of the hub
  await Promise.all([eins19.close(), zwei19.close()])
  await portFree()
  got19.length = gotB19.length = 0
  const eins19b = await start('Eins', got19, on19)
  const zwei19b = await start('Zwei', gotB19, on19)
  await eventually(async () => (await state()).agents.filter(a => a.online).length === 2, 'both sessions, again')
  assert.deepEqual((await state()).memos.map(m => [m.text, m.to, m.place, m.attachments.length]), [['zweite Notiz', null, 'float', 0], ['Milch kaufen', 'zwei', 'paper', 2]])
  // sent: it arrives as a message of the human like any other, with its files, and the note is gone
  // (it is held first: stored as sent and on no page, but not delivered before the hold is over; Undo brings it back)
  res19 = await memo({ id: m19.id, send: true })
  let sent19 = await res19.json()
  assert.deepEqual([res19.status, sent19.sent.agent, sent19.held.agent, sent19.held.ms > 0 && sent19.held.ms <= 300], [200, 'zwei', 'zwei', true])
  assert.deepEqual([(await state()).memos.find(m => m.id === m19.id).held.to, gotB19.length], ['zwei', 0])
  res19 = await memo({ id: m19.id, unsend: true })
  assert.deepEqual([res19.status, (await res19.json()).memo.held], [200, undefined])
  await new Promise(r => setTimeout(r, 450))
  assert.deepEqual([gotB19.length, (await state()).memos.find(m => m.id === m19.id)?.attachments.length], [0, 2], 'undone within the hold: never delivered, the note as it was')
  res19 = await memo({ id: m19.id, unsend: true })
  assert.deepEqual([res19.status, (await res19.json()).code], [409, 'not-sent'])
  res19 = await memo({ id: m19.id, send: true })
  sent19 = await res19.json()
  assert.deepEqual([res19.status, sent19.sent.agent], [200, 'zwei'])
  await new Promise(r => setTimeout(r, 100))
  assert.equal(gotB19.length, 0, 'not delivered before the hold is over')
  await eventually(() => gotB19.length === 1, 'the memo to arrive')
  res19 = await memo({ id: m19.id, unsend: true })
  const late19 = await res19.json()
  assert.deepEqual([res19.status, late19.code, /^too late: the memo already went to /.test(late19.error)], [409, 'delivered', true], 'Undo after the hold is refused')
  assert.deepEqual([gotB19[0].params.content, gotB19[0].params.meta.kind, gotB19[0].params.meta.files.split(',').length, fs.existsSync(gotB19[0].params.meta.image_path), got19.length], ['Milch kaufen', 'chat', 2, true, 0])
  s = await state()
  assert.deepEqual([s.memos.map(m => m.text), s.messages.at(-1).id, s.messages.at(-1).from, s.messages.at(-1).agent, s.messages.at(-1).text, s.messages.at(-1).attachments.map(a => a.name)], [['zweite Notiz'], s.messages.at(-1).id, 'user', 'zwei', 'Milch kaufen', ['zwei.png', 'drei.png']])
  // a note that names no session goes to the starred one; with several sessions and no star it stays, and says why
  res19 = await memo({ id: second.id, send: true })
  assert.deepEqual([res19.status, (await res19.json()).code, (await state()).memos.length], [409, 'no-session', 1])
  assert.equal((await post('/star', { agent: 'eins', starred: true })).status, 200)
  assert.equal((await memo({ id: second.id, send: true })).status, 200)
  await eventually(() => got19.length === 1, 'the memo for the starred session')
  await eventually(async () => (await state()).memos.length === 0, 'the delivered memo gone')
  assert.deepEqual([got19[0].params, (await state()).memos], [{ content: 'zweite Notiz', meta: { kind: 'chat' } }, []])
  // a note written on a session's page belongs to that session: it goes there, whoever wears the crown
  const own19 = (await (await memo({ text: 'nur für Zwei', session: 'zwei' })).json()).memo
  assert.equal(own19.session, 'zwei')
  assert.equal((await memo({ text: 'x', session: 'niemand' })).status, 404)
  assert.equal((await memo({ id: own19.id, send: true })).status, 200)
  await eventually(() => gotB19.length === 2, 'the session note to its session')
  assert.deepEqual([gotB19[1].params.content, got19.length], ['nur für Zwei', 1])
  // an empty note is not sent; thrown away, a note takes its files along
  const empty19 = (await (await memo({ attachments: [{ name: 'weg.png', data: png }] })).json()).memo
  const blank19 = (await (await memo({ text: '   ' })).json()).memo
  assert.equal((await memo({ id: blank19.id, send: true })).status, 400)
  const count19 = files19().length
  assert.equal((await memo({ id: empty19.id, remove: true })).status, 200)
  assert.deepEqual([files19().length, (await state()).memos.map(m => m.id)], [count19 - 1, [blank19.id]])
  // at most fifty
  for (let i = 1; i < 50; i++) assert.equal((await memo({ text: `n${i}` })).status, 200)
  res19 = await memo({ text: 'zu viel' })
  assert.deepEqual([res19.status, (await res19.json()).code, (await state()).memos.length], [409, 'too-many', 50])
  assert.equal((await memo({ id: blank19.id, text: 'ändern geht weiter' })).status, 200)
  await Promise.all([eins19b.close(), zwei19b.close()])
  await portFree()
  fs.rmSync(data19, { recursive: true })
}

// ---- desks (card Nr. 149): each a world of its own sessions and their stack; a board from before is one desk ----
{
  const data13 = fs.mkdtempSync(path.join(os.tmpdir(), 'board-test-'))
  const on13 = { BOARD_DATA: data13 }
  // a board from before desks: two sessions, one names a desk that does not exist
  writeBoard(data13, {
    agents: [{ id: 'alt', name: 'Alt', joined: 1, position: 0 }, { id: 'irr', name: 'Irr', joined: 2, position: 1, desk: 'gibtsnicht' }],
    cards: [], messages: [], tasks: [], assets: [],
  })
  fs.writeFileSync(path.join(data13, 'state.in-sqlite'), '')
  const werk = await start('Werk', [], on13)
  const privat = await start('Privat', [], on13)
  const desk = body => post('/desk', body)
  s = await state()
  assert.deepEqual([s.desks.map(d => [d.id, d.name]), s.agents.map(a => [a.id, a.desk])], [[['main', 'Desk']], [['alt', 'main'], ['irr', 'main'], ['werk', 'main'], ['privat', 'main']]])
  // made, renamed, put in order
  let res13 = await desk({ name: '  Privat  ' })
  const home = (await res13.json()).desk
  assert.deepEqual([res13.status, home.name, /^[0-9a-f]{8}$/.test(home.id)], [200, 'Privat', true])
  const third = (await (await desk({ name: 'Verein' })).json()).desk
  assert.equal((await desk({ id: 'main', name: 'Arbeit' })).status, 200)
  assert.equal((await desk({ id: third.id, before: 'main' })).status, 200)
  assert.deepEqual((await state()).desks.map(d => d.name), ['Verein', 'Arbeit', 'Privat'])
  assert.equal((await desk({ id: third.id, before: null })).status, 200)
  assert.deepEqual((await state()).desks.map(d => d.name), ['Arbeit', 'Privat', 'Verein'])
  // refused: no name, an unknown desk, a write without the login or from elsewhere
  for (const [body, status] of [[{}, 400], [{ name: '   ' }, 400], [{ id: 'main', name: '' }, 400], [{ id: 'gibtsnicht', name: 'x' }, 404], [{ id: 'main', before: 'gibtsnicht' }, 404], [{ id: 'main', remove: true }, 409]]) assert.equal((await desk(body)).status, status, JSON.stringify(body))
  assert.equal((await fetch(`${base}/desk`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: '{"name":"x"}' })).status, 401)
  assert.equal((await post('/desk', { name: 'x' }, 'https://evil.example')).status, 403)
  // a session moves to another desk, with the session it is paired with; its cards go where it goes
  assert.equal((await post('/session', { agent: 'privat', desk: 'gibtsnicht' })).status, 404)
  assert.equal((await post('/session', { agent: 'alt', group: 'paar' })).status, 200)
  assert.equal((await post('/session', { agent: 'privat', group: 'paar' })).status, 200)
  assert.equal((await post('/session', { agent: 'privat', desk: home.id })).status, 200)
  const cardP = (await privat.callTool({ name: 'create_decision', arguments: { title: 'privat?', options: [option('a'), option('b')] } })).content[0].text.match(/^card (\w+) /)[1]
  const cardW = (await werk.callTool({ name: 'create_decision', arguments: { title: 'arbeit?', options: [option('a'), option('b')] } })).content[0].text.match(/^card (\w+) /)[1]
  s = await state()
  const deskOf = id => s.agents.find(a => a.id === s.cards.find(c => c.id === id).agent).desk
  assert.deepEqual([Object.fromEntries(s.agents.map(a => [a.id, a.desk])), deskOf(cardP), deskOf(cardW)], [{ alt: home.id, irr: 'main', werk: 'main', privat: home.id }, home.id, 'main'])
  // the stack itself stays whole, so a client that knows no desks sees everything, and a knock from the other desk is there
  assert.deepEqual([s.queue.includes(cardP), s.queue.includes(cardW)], [true, true])
  // more than twelve are refused
  for (let i = 3; i < 12; i++) assert.equal((await desk({ name: `D${i}` })).status, 200)
  assert.equal((await desk({ name: 'zu viel' })).status, 409)
  // it all survives a restart; a session that comes back stays on its desk, a new one starts on the default
  await Promise.all([werk.close(), privat.close()])
  await portFree()
  const privat2 = await start('Privat', [], on13)
  const neu13 = await start('Neu', [], on13)
  await eventually(async () => (await state()).agents.some(a => a.id === 'neu'), 'the new session')
  s = await state()
  assert.deepEqual([s.desks.length, s.desks.slice(0, 3).map(d => d.name), s.agents.find(a => a.id === 'privat').desk, s.agents.find(a => a.id === 'neu').desk, readBoard(data13).desks.length], [12, ['Arbeit', 'Privat', 'Verein'], home.id, 'main', 12])
  // removed: its sessions fall back to the default desk, their cards with them
  assert.equal((await desk({ id: home.id, remove: true })).status, 200)
  s = await state()
  assert.deepEqual([s.desks.some(d => d.id === home.id), s.agents.filter(a => a.desk !== 'main').length, s.cards.find(c => c.id === cardP).status], [false, 0, 'open'])
  assert.equal((await desk({ id: home.id, name: 'wieder' })).status, 404)
  await Promise.all([privat2.close(), neu13.close()])
  await portFree()
  fs.rmSync(data13, { recursive: true })
}

// ---- main agents and their subs (card Nr. 160): a session names its main; one level; subs stand on their main's desk ----
{
  const data14 = fs.mkdtempSync(path.join(os.tmpdir(), 'board-test-'))
  const on14 = { BOARD_DATA: data14 }
  // a board from before: no parents; one session names a parent that is gone
  writeBoard(data14, { agents: [{ id: 'waise', name: 'Waise', joined: 1, position: 0, parent: 'gibtsnicht', host: 'woanders' }], cards: [], messages: [], tasks: [], assets: [] })
  fs.writeFileSync(path.join(data14, 'state.in-sqlite'), '')
  const chef = await start('Chef', [], on14)
  const eins = await start('Eins', [], on14)
  const zwei = await start('Zwei', [], on14)
  const tool = async (who, name, args) => who.callTool({ name, arguments: args }).then(r => [r.isError === true, r.content[0].text], e => [true, e.message])
  const family = async () => Object.fromEntries((await state()).agents.map(a => [a.id, [a.parent ?? null, a.main, a.desk]]))
  assert.deepEqual(await family(), { waise: [null, false, 'main'], chef: [null, false, 'main'], eins: [null, false, 'main'], zwei: [null, false, 'main'] })
  assert.ok(!('parent' in readBoard(data14).agents[0]), 'a parent that is gone is none')
  // a helper says who its main is, by id or by name; the main is a main because it has a sub, or because it says so
  assert.deepEqual(await tool(eins, 'introduce', { model: 'm', parent: 'chef' }), [false, 'noted; you stand under your main session chef'])
  assert.deepEqual((await family()).chef, [null, true, 'main'])
  // the crown (card Nr. 172): a desk without one gives it to the first session that becomes a main there; a second main gets none
  const crowns14 = async () => (await state()).agents.filter(a => a.starred).map(a => `${a.id}@${a.desk}`)
  assert.deepEqual(await crowns14(), ['chef@main'], 'the first main of the desk is crowned by itself')
  assert.deepEqual((await tool(zwei, 'introduce', { model: 'm', parent: 'Niemand' }))[0], true)
  assert.deepEqual(await tool(zwei, 'introduce', { model: 'm', main: true }), [false, 'noted'])
  assert.deepEqual((await family()).zwei, [null, true, 'main'])
  assert.deepEqual(await crowns14(), ['chef@main'], 'a second main keeps its stack and wears no crown')
  // one level only: a sub cannot be a main's main, a main with subs cannot become a sub, nobody is its own main
  assert.match((await tool(zwei, 'introduce', { model: 'm', parent: 'eins' }))[1], /eins is itself a sub of chef/)
  assert.match((await tool(chef, 'introduce', { model: 'm', parent: 'zwei' }))[1], /chef has subs of its own/)
  assert.match((await tool(zwei, 'introduce', { model: 'm', parent: 'zwei' }))[1], /its own main/)
  // a main takes an existing session, unless it has another main; and lets it go
  assert.match((await tool(zwei, 'adopt_session', { id: 'eins' }))[1], /eins already belongs to chef/)
  assert.match((await tool(chef, 'adopt_session', { id: 'Waise' }))[1], /waise runs on another machine/)
  assert.deepEqual(await tool(chef, 'adopt_session', { id: 'zwei' }), [false, 'zwei is your helper now and stands under you on the board'])
  assert.deepEqual((await family()).zwei, ['chef', false, 'main'], 'a sub is no main, whatever it said')
  assert.match((await tool(eins, 'adopt_session', { id: 'zwei', release: true }))[1], /not your helper/)
  assert.deepEqual(await tool(chef, 'adopt_session', { id: 'zwei', release: true }), [false, 'zwei stands alone again'])
  // the human sets and clears it; what does not fit is refused and changes nothing
  assert.equal((await post('/session', { agent: 'zwei', parent: 'chef' })).status, 200)
  assert.deepEqual((await family()).zwei, ['chef', false, 'main'])
  assert.equal((await post('/session', { agent: 'chef', parent: 'eins' })).status, 409)
  assert.equal((await post('/session', { agent: 'waise', parent: 'gibtsnicht' })).status, 409)
  assert.equal((await post('/session', { agent: 'zwei', parent: null })).status, 200)
  assert.deepEqual((await family()).zwei, [null, false, 'main'])
  assert.equal((await post('/session', { agent: 'zwei', parent: 'chef' })).status, 200)
  // subs stand on their main's desk: moving the main moves them, a sub does not move alone
  const desk14 = (await (await post('/desk', { name: 'Privat' })).json()).desk.id
  assert.equal((await post('/session', { agent: 'chef', desk: desk14 })).status, 200)
  assert.deepEqual(await family(), { waise: [null, false, 'main'], chef: [null, true, desk14], eins: ['chef', false, desk14], zwei: ['chef', false, desk14] })
  assert.equal((await post('/session', { agent: 'eins', desk: 'main' })).status, 409)
  assert.equal((await post('/session', { agent: 'waise', parent: 'chef' })).status, 200)
  assert.equal((await family()).waise[2], desk14, 'a new sub joins its main\'s desk')
  // ---- one crown per desk (card Nr. 172) ----
  {
    const memo14 = async (text, desk) => {
      const id = (await (await post('/memo', { text })).json()).memo.id
      const res = await post('/memo', { id, send: true, ...(desk ? { desk } : {}) })
      const out = [res.status, res.status === 200 ? (await res.json()).sent.agent : (await res.json()).code]
      if (res.status !== 200) await post('/memo', { id, remove: true })
      return out
    }
    assert.deepEqual(await crowns14(), [`chef@${desk14}`], 'the crown went along to a desk that had none')
    // a second desk gets its own crown: zwei stands alone on the default desk and says it is a main
    assert.equal((await post('/session', { agent: 'zwei', parent: null })).status, 200)
    assert.equal((await post('/session', { agent: 'zwei', desk: 'main' })).status, 200)
    assert.deepEqual(await crowns14(), [`chef@${desk14}`], 'a session that is no main is not crowned by itself')
    assert.deepEqual(await tool(zwei, 'introduce', { model: 'm', main: true }), [false, 'noted'])
    assert.deepEqual(await crowns14(), [`chef@${desk14}`, 'zwei@main'], 'one crown on each desk')
    // the human gives it: on the same desk it moves, the other desk keeps its own; a sub can wear it
    assert.equal((await post('/star', { agent: 'eins', starred: true })).status, 200)
    assert.deepEqual(await crowns14(), [`eins@${desk14}`, 'zwei@main'])
    // the memo goes to the crown of the desk it is sent from; without a desk named, to the default desk's crown
    assert.deepEqual([await memo14('nach Privat', desk14), await memo14('nach Desk', 'main'), await memo14('ohne Desk')], [[200, 'eins'], [200, 'zwei'], [200, 'zwei']])
    // a crowned session that comes to a desk with a crown leaves its own behind; back on a desk without one, a main is crowned again
    assert.equal((await post('/session', { agent: 'zwei', desk: desk14 })).status, 200)
    assert.deepEqual(await crowns14(), [`eins@${desk14}`], 'the one that arrives loses its crown')
    assert.deepEqual(await memo14('kein Kronenträger', 'main'), [409, 'no-session'])
    assert.equal((await post('/session', { agent: 'zwei', desk: 'main' })).status, 200)
    assert.deepEqual(await crowns14(), [`eins@${desk14}`, 'zwei@main'])
    // taken off by hand, the desk stays without a crown, whoever becomes a main there, until he gives one
    assert.equal((await post('/star', { agent: 'zwei', starred: false })).status, 200)
    assert.deepEqual(await tool(zwei, 'introduce', { model: 'm', main: true }), [false, 'noted'])
    assert.deepEqual([await crowns14(), readBoard(data14).desks.find(d => d.id === 'main').crown_off], [[`eins@${desk14}`], true])
    assert.equal((await post('/star', { agent: 'zwei', starred: true })).status, 200)
    assert.deepEqual([await crowns14(), readBoard(data14).desks.find(d => d.id === 'main').crown_off], [[`eins@${desk14}`, 'zwei@main'], undefined])
    // put away, a session lays its crown down, and the desk's first main takes it
    assert.equal((await post('/session', { agent: 'waise', parent: null })).status, 200)
    assert.equal((await post('/star', { agent: 'waise', starred: true })).status, 200)
    assert.equal((await post('/session', { agent: 'waise', archived: true })).status, 200)
    assert.deepEqual(await crowns14(), [`chef@${desk14}`, 'zwei@main'])
    assert.equal((await post('/session', { agent: 'waise', archived: false, parent: 'chef' })).status, 200)
    // back as it was: zwei under chef again, so it comes to chef's desk and leaves its crown
    assert.equal((await post('/session', { agent: 'zwei', parent: 'chef' })).status, 200)
    assert.deepEqual([await crowns14(), (await family()).zwei], [[`chef@${desk14}`], ['chef', false, desk14]])
  }
  // a helper started by hand names its main when it links
  const helper = spawn('node', [toPath(new URL('../dev/session.mjs', import.meta.url)), 'link', 'Helfer', '--parent', 'chef'], { env: serverEnv('x', on14), stdio: 'ignore' })
  spawned.push(helper)
  await eventually(async () => (await family()).helfer?.[0] === 'chef', 'the helper to stand under its main')
  helper.kill()
  // it all survives a restart; a main that is forgotten leaves its subs standing alone
  await Promise.all([chef.close(), eins.close(), zwei.close()])
  await portFree()
  const eins2 = await start('Eins', [], on14)
  await eventually(async () => (await state()).agents.find(a => a.id === 'eins')?.online, 'eins to be back')
  assert.deepEqual([(await family()).eins, (await family()).chef], [['chef', false, desk14], [null, true, desk14]])
  assert.deepEqual(await crowns14(), [`chef@${desk14}`], 'the crown survives a restart')
  assert.deepEqual(readBoard(data14).agents.map(a => [a.id, a.parent ?? null, 'main' in a]), [['waise', 'chef', false], ['chef', null, false], ['eins', 'chef', false], ['zwei', 'chef', false], ['helfer', 'chef', false]])
  const admin14 = await adminLogin('adminkey', cookie)
  assert.equal((await adminPost('sessions/forget', { id: 'chef', confirm: 'chef' }, admin14)).status, 200)
  assert.deepEqual(Object.values(await family()).map(f => [f[0], f[1]]), [[null, false], [null, false], [null, false], [null, false]])
  await eins2.close()
  await portFree()
  fs.rmSync(data14, { recursive: true })
}

// ---- backup and restore (card Nr. 175): deploy/backup.sh snapshots the SQLite database of a running hub, deploy/restore.sh puts it back ----
{
  const { execFileSync } = await import('node:child_process')
  const root = path.dirname(path.dirname(SERVER))
  const dataB = fs.mkdtempSync(path.join(os.tmpdir(), 'board-test-'))
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'board-backup-'))
  const [archives, restored] = [path.join(work, 'archives'), path.join(work, 'restored')]
  const run = (script, args) => execFileSync(path.join(root, 'deploy', script), args, { encoding: 'utf8', env: { ...process.env, BOARD_DATA: '', TMPDIR: work, XDG_CONFIG_HOME: work }, stdio: ['ignore', 'pipe', 'pipe'] })
  const kinds = dir => JSON.parse(execFileSync('node', [path.join(root, 'deploy', 'sqlite-snapshot.mjs'), '--counts', path.join(dir, 'pad.db')], { encoding: 'utf8' })).board
  // the secrets as files, as on a real board (the other hubs of this test get them from the environment)
  const own = { BOARD_DATA: dataB, BOARD_TOKEN: '', BOARD_ADMIN_TOKEN: '' }
  for (const [name, secret] of [['token', 'secret'], ['admin-token', 'adminkey']]) fs.writeFileSync(path.join(dataB, name), secret + '\n', { mode: 0o644 })
  const hubB = await start('Sicherung', [], own)
  const sayB = (name, args) => hubB.callTool({ name, arguments: args })
  for (let i = 0; i < 3; i++) await sayB('create_decision', { title: `Frage ${i}`, options: [option('a'), option('b')] })
  for (let i = 0; i < 5; i++) await sayB('reply', { text: `Nachricht ${i} Kennwort-im-Text-4711`, ...(i ? {} : { attachments: [shot] }) })
  const [bid, bkey] = linkOf(await publish(hubB, { content: 'gesichert', title: 'Sicherung' }))
  const before = await state()
  const attached = before.messages.flatMap(m => m.attachments ?? []).map(a => path.basename(a.url))
  assert.deepEqual([before.cards.length, before.messages.length >= 5, attached.length], [3, true, 1])
  // the hub is running and has the database open in WAL mode while the backup is taken
  assert.ok(fs.existsSync(path.join(dataB, 'pad.db-wal')))
  const told = run('backup.sh', ['--data', dataB, '--to', archives])
  const [archive] = fs.readdirSync(archives)
  assert.match(archive, /^trommi-data-\d{8}-\d{6}\.tar\.gz$/)
  assert.equal(fs.statSync(path.join(archives, archive)).mode & 0o777, 0o600)
  // what it says: counts and sizes, never a secret or a message
  assert.match(told, /1 SQLite snapshot\(s\), integrity checked; pad\.db holds \{"board":\{[^}]*"cards":3/)
  assert.ok(!/\bsecret\b|adminkey|Kennwort|Frage 0/.test(told.replace(/secrets:/g, '')), 'the backup prints no secret and no content')
  // in the archive: one database file, never the raw -wal or -shm, no login link, no log; the secrets with mode 0600
  const listing = execFileSync('tar', ['-tvzf', path.join(archives, archive)], { encoding: 'utf8' }).trim().split('\n')
  const entry = name => listing.find(line => line.endsWith(` trommi-data/${name}`))
  assert.ok(entry('pad.db') && entry(`files/${attached[0]}`) && entry(`assets/${bid}`))
  assert.ok(!listing.some(line => /pad\.db-(wal|shm)$|url\.txt$|\.log$/.test(line)))
  for (const name of ['token', 'admin-token', 'pad.db']) assert.match(entry(name), /^-rw------- /, name)
  // the board goes on after the snapshot: what comes later is not in it
  await sayB('reply', { text: 'nach der Sicherung' })
  await sayB('create_decision', { title: 'später', options: [option('a'), option('b')] })
  const live = kinds(dataB)
  // restore into another directory and compare records per kind
  const back = run('restore.sh', [path.join(archives, archive), '--data', restored])
  assert.match(back, /database: integrity checked; pad\.db holds \{"board"/)
  assert.deepEqual(kinds(restored), { ...live, cards: 3, messages: before.messages.length })
  assert.deepEqual([live.cards, live.messages > before.messages.length, kinds(restored).assets], [4, true, 1])
  assert.deepEqual([fs.existsSync(path.join(restored, 'pad.db-wal')), fs.readFileSync(path.join(restored, 'token'), 'utf8').trim(), fs.statSync(path.join(restored, 'token')).mode & 0o777, fs.statSync(path.join(restored, 'pad.db')).mode & 0o777], [false, 'secret', 0o600, 0o600])
  assert.deepEqual(fs.readFileSync(path.join(restored, 'files', attached[0])), fs.readFileSync(path.join(dataB, 'files', attached[0])))
  assert.deepEqual(fs.readFileSync(path.join(restored, 'assets', bid)), fs.readFileSync(path.join(dataB, 'assets', bid)))
  // a directory with data is not written over, unless asked: then it is moved aside, never deleted
  assert.throws(() => run('restore.sh', [path.join(archives, archive), '--data', restored]), /not empty/)
  // a second backup without the secrets, and --keep
  const more = path.join(work, 'more')
  fs.mkdirSync(more)
  fs.copyFileSync(path.join(archives, archive), path.join(more, 'trommi-data-20200101-000000.tar.gz'))
  run('backup.sh', ['--data', dataB, '--to', more, '--no-secrets'])
  await sleep(1100)
  run('backup.sh', ['--data', dataB, '--to', more, '--no-secrets', '--keep', '2'])
  const newest = fs.readdirSync(more).sort()
  assert.deepEqual([newest.length, newest.includes('trommi-data-20200101-000000.tar.gz')], [2, false])
  assert.ok(!execFileSync('tar', ['-tzf', path.join(more, newest[1])], { encoding: 'utf8' }).split('\n').some(name => /\/(token|admin-token|tinfoil\.key)$/.test(name)))
  // an archive that is not ours is refused, and so is a directory that is no data directory
  execFileSync('tar', ['-czf', path.join(work, 'fremd.tar.gz'), '-C', dataB, 'token'])
  assert.throws(() => run('restore.sh', [path.join(work, 'fremd.tar.gz'), '--data', path.join(work, 'x')]), /not made by deploy\/backup\.sh/)
  assert.throws(() => run('backup.sh', ['--data', work, '--to', archives]), /neither pad\.db nor state\.json/)
  await hubB.close()
  await portFree()
  // a hub started on the restored directory serves the board as it was at the snapshot: the cards, the messages, the
  // attachment, and the asset opens with its key; --replace moved nothing away here, so the original is untouched
  const hubR = await start('Sicherung', [], { ...own, BOARD_DATA: restored })
  const after = await state()
  assert.deepEqual([after.cards.map(c => c.title), after.messages.length, after.messages.some(m => m.text === 'nach der Sicherung')], [['Frage 0', 'Frage 1', 'Frage 2'], before.messages.length, false])
  assert.equal((await fetch(`${base}/files/${attached[0]}`, { headers: { Cookie: cookie } })).status, 200)
  assert.equal((await openAsset(await blobOf(bid), bkey, bid)).content.toString(), 'gesichert')
  await hubR.close()
  await portFree()
  // a directory in which a hub has its database open is refused, with or without --replace
  const hubO = await start('Sicherung', [], { ...own, BOARD_DATA: restored })
  assert.throws(() => run('restore.sh', [path.join(archives, archive), '--data', restored, '--replace']), /stop the hub first/)
  await hubO.close()
  await portFree()
  // --replace: the directory that was there is moved aside whole
  run('restore.sh', [path.join(archives, archive), '--data', restored, '--replace'])
  const aside = fs.readdirSync(work).filter(name => name.startsWith('restored.before-restore-'))
  assert.deepEqual([aside.length, fs.existsSync(path.join(work, aside[0], 'pad.db')), kinds(restored).cards], [1, true, 3])
  for (const dir of [dataB, work]) fs.rmSync(dir, { recursive: true })
}

// ---- push (server/push.mjs, docs/push.md): a knock goes to the subscribed browser, encrypted for it and signed by the hub ----
{
  const data15 = fs.mkdtempSync(path.join(os.tmpdir(), 'board-test-'))
  // the push service of a browser maker, played here: it keeps what it is sent and answers as told
  const pushed = []
  let answer = 201
  const service = http.createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => { pushed.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) }); res.writeHead(answer); res.end() })
  })
  await new Promise(done => service.listen(0, '127.0.0.1', done))
  const host15 = `127.0.0.1:${service.address().port}`
  const agent15 = await start('Klopfer', [], { BOARD_DATA: data15, BOARD_PUSH_HOSTS: host15, BOARD_PUSH_AWAY_MS: '300' })
  const tool15 = (name, args) => agent15.callTool({ name, arguments: args })
  const card15 = async (title, extra = {}) => (await tool15('create_decision', { title, options: [option('a'), option('b')], ...extra })).content[0].text.match(/^card (\w+) /)[1]
  const numberOf = async id => (await state()).cards.find(c => c.id === id).number
  // the browser: its key pair and its secret, as PushManager.subscribe() makes them
  const browser = crypto.createECDH('prime256v1')
  const p256dh = browser.generateKeys().toString('base64url')
  const auth = crypto.randomBytes(16)
  const endpoint = `http://${host15}/send/abc`
  const mine = { endpoint, keys: { p256dh, auth: auth.toString('base64url') } }
  // RFC 8291, read from the receiving side
  const hkdf15 = (salt, ikm, info, n) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, n))
  const opened = body => {
    const salt = body.subarray(0, 16), sender = body.subarray(21, 21 + body[20]), sealed = body.subarray(21 + body[20])
    assert.deepEqual([body.readUInt32BE(16), body[20], sender[0]], [4096, 65, 4])
    const ikm = hkdf15(auth, browser.computeSecret(sender), Buffer.concat([Buffer.from('WebPush: info\0'), browser.getPublicKey(), sender]), 32)
    const plain = crypto.createDecipheriv('aes-128-gcm', hkdf15(salt, ikm, 'Content-Encoding: aes128gcm\0', 16), hkdf15(salt, ikm, 'Content-Encoding: nonce\0', 12))
    plain.setAuthTag(sealed.subarray(-16))
    const record = Buffer.concat([plain.update(sealed.subarray(0, -16)), plain.final()])
    const end = record.lastIndexOf(2)
    assert.ok(record.subarray(end + 1).every(b => b === 0), 'after the delimiter only padding')
    return { length: record.length, message: JSON.parse(record.subarray(0, end)) }
  }

  // what a phone fetches without the cookie is there, and the worker does nothing but push
  const manifest = await fetch(`${base}/manifest.webmanifest`)
  assert.deepEqual([manifest.status, manifest.headers.get('content-type'), (await manifest.json()).name], [200, 'application/manifest+json', 'Trommi'])
  assert.equal((await fetch(`${base}/icons/trommi-180.png`)).headers.get('content-type'), 'image/png')
  const worker = await (await fetch(`${base}/sw.js`)).text()
  assert.ok(/addEventListener\('push'/.test(worker) && /addEventListener\('notificationclick'/.test(worker) && !/addEventListener\('fetch'|caches\./.test(worker))
  // the routes are behind the login and the origin check
  assert.equal((await fetch(`${base}/push/key`)).status, 401)
  assert.equal((await fetch(`${base}/push/subscribe`, { method: 'POST', headers: { Origin: base }, body: JSON.stringify(mine) })).status, 401)
  assert.equal((await post('/push/subscribe', mine, 'https://evil.example')).status, 403)
  const { key: key15 } = await (await fetch(`${base}/push/key`, { headers: { Cookie: cookie } })).json()
  assert.deepEqual([Buffer.from(key15, 'base64url').length, Buffer.from(key15, 'base64url')[0]], [65, 4])
  // only the browsers' push services, and only real keys
  assert.equal((await post('/push/subscribe', { ...mine, endpoint: 'https://evil.example/x' })).status, 400)
  assert.equal((await post('/push/subscribe', { ...mine, endpoint: 'http://web.push.apple.com/x' })).status, 400)
  assert.equal((await post('/push/subscribe', { ...mine, keys: { p256dh: 'AAAA', auth: 'AAAA' } })).status, 400)
  assert.deepEqual(await (await post('/push/state', { endpoint })).json(), { ok: true, subscribed: false, title: false, away: false })
  // JSON that is no object is refused, and the hub stays up (it once threw outside the error boundary)
  for (const route of ['/push/state', '/push/subscribe', '/push/unsubscribe', '/push/test']) for (const odd of [null, 7, 'x', [1]]) assert.equal((await post(route, odd)).status, 400, `${route} ${JSON.stringify(odd)}`)
  assert.equal((await fetch(`${base}/healthz`)).status, 200)
  // subscribed: kept on the hub, the owner's alone, as is the key; the card's title is shown unless the device says otherwise (card Nr. 185)
  assert.deepEqual(await (await post('/push/subscribe', mine)).json(), { ok: true, subscribed: true, title: true, away: true })
  const kept15 = () => JSON.parse(fs.readFileSync(path.join(data15, 'push.json'), 'utf8')).subs
  assert.deepEqual(kept15().map(s => [s.endpoint, s.p256dh, s.title, s.away]), [[endpoint, p256dh, true, true]])
  assert.deepEqual(['push.json', 'push-vapid.pem'].map(f => fs.statSync(path.join(data15, f)).mode & 0o777), [0o600, 0o600])
  assert.ok(!logs.some(line => line.includes(key15) || line.includes('PRIVATE KEY') || line.includes('/send/abc')), 'neither key nor subscription in the log')

  // a page of the board is open: he is there. A card that does not knock sends nothing; raised, it sends one message
  const open15 = new AbortController()
  const page15 = await fetch(`${base}/events`, { headers: { Cookie: cookie }, signal: open15.signal })
  const quiet = await card15('Geheimer Titel der Karte')
  await sleep(200)
  assert.equal(pushed.length, 0)
  await tool15('set_urgency', { card_id: quiet, urgency: 'high', reason: 'es eilt' })
  await eventually(() => pushed.length === 1, 'the push for the knock')
  const first = pushed[0]
  assert.deepEqual([first.path, first.headers['content-encoding'], first.headers.ttl, first.headers.urgency, /^[\w-]{1,32}$/.test(first.headers.topic)], ['/send/abc', 'aes128gcm', '86400', 'high', true])
  // signed by the hub (RFC 8292): the key it hands the browser verifies the token, which names this push service
  const [, jwt, k] = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(first.headers.authorization)
  assert.equal(k, key15)
  const point = Buffer.from(k, 'base64url')
  const hubKey = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') } })
  const [head, claims, signature] = jwt.split('.')
  assert.ok(crypto.verify('sha256', Buffer.from(`${head}.${claims}`), { key: hubKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')))
  const said = JSON.parse(Buffer.from(claims, 'base64url'))
  assert.deepEqual([JSON.parse(Buffer.from(head, 'base64url')), said.aud, said.sub], [{ typ: 'JWT', alg: 'ES256' }, `http://${host15}`, 'https://trommi.com'])
  assert.ok(said.exp > Date.now() / 1000 && said.exp <= Date.now() / 1000 + 24 * 3600)
  // encrypted for this browser (RFC 8291): its keys open it and nobody else reads the title; every message is as long as any other
  assert.ok(!first.body.includes('Geheimer') && !first.body.includes('Knock'))
  const nr = await numberOf(quiet)
  assert.deepEqual(opened(first.body), { length: 512, message: { title: 'Trommi', body: 'Knock: Geheimer Titel der Karte', tag: `card-${quiet}`, url: `/q/${nr}` } })
  // down and up again within the minute: the card does not ring twice
  await tool15('set_urgency', { card_id: quiet, urgency: 'normal' })
  await tool15('set_urgency', { card_id: quiet, urgency: 'critical', reason: 'jetzt aber' })
  await sleep(200)
  assert.equal(pushed.length, 1)

  // a card that knocks from the start rings as well, board open or not
  const loud = await card15('Deploy freigeben?', { urgency: 'critical', urgency_reason: 'alles wartet' })
  await eventually(() => pushed.length === 2, 'the push for a card that knocks from the start')
  assert.deepEqual([pushed[1].headers.topic !== first.headers.topic, opened(pushed[1].body).message], [true, { title: 'Trommi', body: 'Knock: Deploy freigeben?', tag: `card-${loud}`, url: `/q/${await numberOf(loud)}` }])
  // this device wants the discreet text (what else it wants stays as it was)
  assert.deepEqual(await (await post('/push/subscribe', { ...mine, title: false })).json(), { ok: true, subscribed: true, title: false, away: true })
  assert.equal(kept15().length, 1)
  // a new card rings only when he is away (card Nr. 186): not with a page open, but some time after the last one closed
  await sleep(400)
  await card15('Während er da ist')
  await sleep(200)
  assert.equal(pushed.length, 2)
  open15.abort()
  await page15.body.cancel().catch(() => {})
  await sleep(600)
  await card15('Während er weg ist')
  await eventually(() => pushed.length === 3, 'the push for a new card while away')
  assert.deepEqual([pushed[2].headers.urgency, opened(pushed[2].body).message.body], ['normal', 'A new card'])
  const hasty = await card15('Eilt, und diskret', { urgency: 'high', urgency_reason: 'eilt' })
  await eventually(() => pushed.length === 4, 'the discreet push')
  assert.deepEqual(opened(pushed[3].body).message, { title: 'Trommi', body: 'Something knocks', tag: `card-${hasty}`, url: `/q/${await numberOf(hasty)}` })
  // a test message on request
  assert.deepEqual(await (await post('/push/test', { endpoint })).json(), { ok: true, status: 201 })
  assert.equal(opened(pushed[4].body).message.body, 'Push works on this device')
  assert.equal((await post('/push/test', { endpoint: `http://${host15}/other` })).status, 404)

  // the push service says the subscription is gone: the hub forgets it
  answer = 410
  await card15('Noch eine', { urgency: 'high', urgency_reason: 'eilt' })
  await eventually(() => kept15().length === 0, 'the dead subscription to be removed')
  assert.equal(pushed.length, 6)
  assert.equal((await (await post('/push/state', { endpoint })).json()).subscribed, false)
  // switched off by the browser itself
  answer = 201
  await post('/push/subscribe', mine)
  assert.deepEqual(await (await post('/push/unsubscribe', { endpoint })).json(), { ok: true, subscribed: false, title: false, away: false })
  assert.equal(kept15().length, 0)
  await card15('Und noch eine', { urgency: 'high', urgency_reason: 'eilt' })
  await sleep(200)
  assert.equal(pushed.length, 6)
  await agent15.close()

  // the five minutes and the burst, with a clock of the test's own (the module alone, no hub)
  {
    const { pusher } = await import('./push.mjs')
    fs.writeFileSync(path.join(data15, 'push.json'), JSON.stringify({ subs: [
      { endpoint: 'https://web.push.apple.com/titel', p256dh, auth: auth.toString('base64url'), title: true },
      { endpoint: 'https://web.push.apple.com/diskret', p256dh, auth: auth.toString('base64url'), title: false },
      { endpoint: 'https://web.push.apple.com/nur-klopfen', p256dh, auth: auth.toString('base64url'), title: true, away: false },
    ] }))
    const MIN = 60000
    let clock = 1e12, pages = 1
    const sentTo = [], timers = [], looks = []
    const p = pusher({ dir: data15, web: data15, boards: () => pages, now: () => clock, later: (fn, ms) => timers.push({ fn, at: clock + ms }), every: fn => looks.push(fn),
      fetch: async (to, req) => { sentTo.push([to.split('/').pop(), opened(req.body).message.body, opened(req.body).message.url]); return { status: 201 } } })
    const board = { cards: [], queue: [] }
    let n15 = 0
    const file = (title, urgency = 'normal') => { const c = { id: `c${++n15}`, number: n15, kind: 'decision', status: 'open', urgency, title }; board.cards.push(c); board.queue.push(c.id); p.watch(board); return c }
    // time passes: the hub looks for open pages as it goes, and the timers that are due run
    const pass = ms => {
      for (const end = clock + ms; clock < end;) {
        clock += 5000
        for (const fn of looks) fn()
        for (const t of timers.splice(0)) if (t.at <= clock) t.fn(); else timers.push(t)
      }
    }
    const got = () => sentTo.splice(0)
    p.watch(board)
    // at the board: a new card is silent, a knock rings on every device
    file('Eins')
    assert.deepEqual(got(), [])
    file('Zwei', 'high')
    assert.deepEqual(got(), [['titel', 'Knock: Zwei', '/q/2'], ['diskret', 'Something knocks', '/q/2'], ['nur-klopfen', 'Knock: Zwei', '/q/2']])
    // the last page closes: for five minutes he still counts as there
    pass(MIN)
    pages = 0
    pass(4 * MIN + 55000)
    file('Drei')
    assert.deepEqual(got(), [])
    // five minutes without a page: the first new card rings at once, on the devices that want new cards
    pass(5000)
    file('Vier')
    assert.deepEqual(got(), [['titel', 'Nr. 4: Vier', '/q/4'], ['diskret', 'A new card', '/q/4']])
    // a burst within the minute comes as one; what was answered in the meantime is not counted
    file('Fünf'); const six = file('Sechs'); file('Sieben')
    assert.deepEqual(got(), [])
    six.status = 'done'; board.queue = board.queue.filter(id => id !== six.id); p.watch(board)
    pass(MIN)
    assert.deepEqual(got(), [['titel', '2 new cards', '/'], ['diskret', '2 new cards', '/']])
    // the next minute holds one card: it comes by itself, with its title; then the minutes are over and a new card rings at once again
    file('Acht')
    assert.deepEqual(got(), [])
    pass(MIN)
    assert.deepEqual(got(), [['titel', 'Nr. 8: Acht', '/q/8'], ['diskret', 'A new card', '/q/8']])
    pass(2 * MIN)
    file('Neun')
    assert.equal(got().length, 2)
    // he is back before the minute is over: what waited in it stays silent, and so does what comes while he is there
    file('Zehn')
    pages = 1
    pass(2 * MIN)
    file('Elf')
    assert.deepEqual(got(), [])
  }

  // ---- a stopped session rings once per stop (server/blocked.mjs, cards Nr. 202/203) ----
  {
    const { pusher } = await import('./push.mjs')
    const { SILENT_MS, OFFLINE_GRACE_MS } = await import('./blocked.mjs')
    let clock = 2e12
    const sentTo = []
    const p = pusher({ dir: data15, web: data15, boards: () => 1, now: () => clock, later: () => {}, every: () => {},
      fetch: async (to, req) => { sentTo.push([to.split('/').pop(), opened(req.body).message.body, opened(req.body).message.url]); return { status: 201 } } })
    const got = () => sentTo.splice(0)
    const builder = { id: 'bau', name: 'bau', label: 'Builder', online: true, connected: clock, active: clock }
    const board = { agents: [builder], tasks: [{ agent: 'bau', id: 'x', state: 'working', updated: clock }], cards: [], queue: [] }
    p.watch(board)
    assert.deepEqual(got(), [])
    // the link drops: a blip is nothing; gone for longer while working, it rings once on every device
    builder.online = false; builder.seen = clock
    p.watch(board)
    assert.deepEqual(got(), [])
    clock += OFFLINE_GRACE_MS
    p.watch(board)
    assert.deepEqual(got(), [['titel', 'Stopped: Builder. Disconnected while working', '/s/bau'], ['diskret', 'An agent is stopped', '/s/bau'], ['nur-klopfen', 'Stopped: Builder. Disconnected while working', '/s/bau']])
    // the same stop with another cause rings no more
    builder.online = true; builder.error = 'API overloaded'
    p.watch(board)
    assert.deepEqual(got(), [])
    // it runs again, then falls silent: a new stop, a new ring
    delete builder.error; builder.active = clock
    p.watch(board)
    assert.deepEqual(got(), [])
    clock += SILENT_MS
    p.watch(board)
    assert.deepEqual(got().map(x => x[1]), [`Stopped: Builder. Silent for ${Math.round(SILENT_MS / 60000)} min`, 'An agent is stopped', `Stopped: Builder. Silent for ${Math.round(SILENT_MS / 60000)} min`])
    // a stop that is a card (an approval, a card marked blocking) rings as that card's knock, not a second time
    board.tasks = []; builder.active = clock
    p.watch(board)
    board.cards.push({ id: 'blk', number: 99, agent: 'bau', kind: 'decision', status: 'open', urgency: 'critical', title: 'Blockiert' }); board.queue.push('blk')
    p.watch(board)
    assert.deepEqual(got(), [['titel', 'Knock: Blockiert', '/q/99'], ['diskret', 'Something knocks', '/q/99'], ['nur-klopfen', 'Knock: Blockiert', '/q/99']])
    board.cards = []; board.queue = []
    // a session without working lines is never "silent"; nor "disconnected while working"
    board.tasks = []; builder.active = clock
    p.watch(board); clock += 2 * SILENT_MS; builder.online = false; builder.seen = 0
    p.watch(board)
    assert.deepEqual(got(), [])
  }

  await new Promise(done => service.close(done))
  await portFree()
  fs.rmSync(data15, { recursive: true })
}

// The server-rendered board (turbo.mjs): its own file, its own hub.
await (await import('./turbo-test.mjs')).run()

for (const dir of [data, data2, data3, data4, data5, data6, data7, data8, data9]) fs.rmSync(dir, { recursive: true })
console.log('ok: chat, decision, attachment, the stack in its fixed order, status strip, undo, scribble, media, numbering, withdraw, revise and merge with stale answers and nudges, questions as sections and as one text block, notes on options, drafts, order of sessions, versions of a card and hand-back, infos to read and close, pictures with their pages, trust, shredding, notes and drawings pinned to a card, snooze, one crown, a card copied to another session, a symbol chosen by the agent, migration, restart, several agents, hub takeover, message log with since, cleanup after 30 days, permission relay, token and origin check, malformed input, stable agent ids made by the hub and kept by key, pairing and keys behind a flag, passkey login, assets released for third parties, assets only with the login, backup and restore of the database, desks, main agents and their subs, push to a subscribed browser, short words on options, marks on pictures, test cards from the hub, memos kept until sent, queue for away agents across hub changes, calls during a takeover, silent hub, simultaneous start, damaged state file, admin backend, static files, archive and groups, encrypted assets from hub and spoke and from the session helper, tool reference, rich html beside messages and questions, app paths, hub of its own, the move from state.json into SQLite, pad elements and blobs and live changes and sending a selection, live dictation, read aloud')
process.exit(0)
