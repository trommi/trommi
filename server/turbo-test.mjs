// The server-rendered board (server/turbo.mjs, server/views, docs/turbo.md): what the hub renders, that it is
// escaped, what a form does, and what the live stream sends. Runs by itself (node server/turbo-test.mjs) and
// at the end of server/test.mjs. Starts a hub of its own on a free port with a throwaway data folder.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { html, raw, esc } from './views/html.mjs'
import { rich, plain, fitsTile, micButton } from './views/text.mjs'
import { sketchSvg, doodleSvg, hueFor } from '../client/web/js/pen.js'

const SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url))
// A free port for every run (BOARD_TURBO_TEST_PORT names one instead), so that runs side by side do not collide.
const PORT = Number(process.env.BOARD_TURBO_TEST_PORT) || await new Promise((resolve, reject) => { const probe = http.createServer(); probe.once('error', reject); probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)) }) })
const base = `http://127.0.0.1:${PORT}`
const cookie = `board_${PORT}=secret`
const sleep = ms => new Promise(r => setTimeout(r, ms))
const eventually = async (test, what) => { for (let i = 0; i < 100; i++) { if (await test()) return; await sleep(50) } assert.fail(`timed out waiting for ${what}`) }

function units() {
  // one escaping helper: text and attribute values alike; markup only through html`` or raw()
  assert.equal(String(html`<p title="${'a"b'}">${'<script>x</script> & co'}</p>`), '<p title="a&quot;b">&lt;script&gt;x&lt;/script&gt; &amp; co</p>')
  assert.equal(String(html`<ul>${['<a>', html`<li>${'b&'}</li>`, null, false]}</ul>`), '<ul>&lt;a&gt;<li>b&amp;</li></ul>')
  assert.equal(String(html`${raw('<b>')}${0}`), '<b>0')
  assert.equal(esc("'"), '&#39;')
  // the light markdown: no markup of the agent's reaches the page
  const text = String(rich('Hello **bold** <img src=x onerror=alert(1)> `code` __wichtig__ https://example.org/a.\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | <i>2</i> |\n\n```html\n<table><tr><td onclick="x()">cell</td></tr></table>\n```'))
  assert.match(text, /<strong>bold<\/strong>/)
  assert.match(text, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.doesNotMatch(text, /<img|<i>|<td onclick/)
  assert.match(text, /<code>code<\/code>/)
  assert.match(text, /<span class="rich-under">wichtig<\/span>/)
  assert.match(text, /<a href="https:\/\/example\.org\/a" target="_blank" rel="noopener noreferrer"/)
  assert.match(text, /<ul><li>one<\/li><li>two<\/li><\/ul>/)
  assert.match(text, /<table class="rich-table">/)
  // a layout fenced as html is not markup of the page: an inert holder, its source escaped, for the sandboxed frame
  assert.match(text, /<div class="rich-html" data-controller="richhtml" data-richhtml-source-value="&lt;table&gt;&lt;tr&gt;&lt;td onclick=&quot;x\(\)&quot;&gt;cell/)
  assert.match(String(rich('☞ Das hier zuerst.\n\nRest.')), /<p class="rich-point"><svg viewBox="0 2 32 22" class="advice-hand"/)
  assert.equal(plain('**Hi** `x` https://example.org/some/long/path?q=1 __u__'), 'Hi x example.org/some/long/path u')
  // the microphone for dictation: only where the hub has a speech service, tied to its field by id
  assert.match(String(micButton('card-field-1', true)), /^<button class="dictate-mic" type="button" data-controller="dictate" data-dictate-field-value="card-field-1"/)
  assert.equal(String(micButton('card-field-1', false)), '')
  // markdown links, also with a path as label; *italic*; numbered lists after a line of text; paragraphs apart
  assert.match(String(rich('Siehe [Zehn Abzüge](/designs/x.html) und [/pad/ bei 360](/pad/).')), /<a href="\/designs\/x\.html" target="_blank" rel="noopener" title="\/designs\/x\.html">Zehn Abzüge<\/a> und <a href="\/pad\/"[^>]*>\/pad\/ bei 360<\/a>\./)
  assert.match(String(rich('[Seite](https://example.org/a?b=1)')), /<a href="https:\/\/example\.org\/a\?b=1" target="_blank" rel="noopener noreferrer"[^>]*>Seite<\/a>/)
  assert.match(String(rich('[<b>x</b>](/a.html)')), /&lt;b&gt;x&lt;\/b&gt;<\/a>/)
  assert.equal(String(rich('ein *kursives* Wort, 2 * 3 * 4')), '<div class="rich"><p>ein <em>kursives</em> Wort, 2 * 3 * 4</p></div>')
  assert.equal(String(rich('Liste:\n1. eins\n2. **zwei**\nDanach.')), '<div class="rich"><p>Liste:</p><ol><li>eins</li><li><strong>zwei</strong></li></ol><p>Danach.</p></div>')
  assert.equal(String(rich('Erster.\n\nZweiter.')), '<div class="rich"><p>Erster.</p><p>Zweiter.</p></div>')
  assert.equal(String(rich('☞ wichtig', { hand: false })), '<div class="rich"><p>wichtig</p></div>')   // sober in a conversation
  assert.equal(fitsTile('Im Verlauf darunter'), true)
  assert.equal(fitsTile('Ein sehr langes Wort Donaudampfschifffahrt'), false)
  // the pen is seeded: the same name, the same strokes; and it is the old client's drawing (first stroke of the thumb)
  assert.equal(sketchSvg('yes'), sketchSvg('yes'))
  assert.match(sketchSvg('yes'), /^<svg viewBox="0 0 24 24" class="sketch" aria-hidden="true" style="rotate:-3\.4deg"><path d="M4\.4 11\.4 Q4\.4 19\.4 /)
  assert.match(doodleSvg('trommi'), /style="rotate:5deg"><path d="M5\.2 25\.1 L11\.5 8\.0"\/>/)
  assert.equal(hueFor({ id: 'design', mark: 'design' }), 48)
  assert.equal(hueFor({ id: 'x', mark: 'draw:moon' }) !== null, true)
}

export async function run() {
  units()
  if (await fetch(base).then(() => true, () => false)) throw new Error(`port ${PORT} is taken, probably by a hub left over from an earlier run: find it with "ss -ltnp | grep ${PORT}" and stop it`)
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'board-turbo-'))
  const hub = spawn('node', [SERVER], { env: { ...process.env, BOARD_PORT: String(PORT), BOARD_HOST: '127.0.0.1', BOARD_DATA: data, BOARD_TOKEN: 'secret', BOARD_ADMIN_TOKEN: 'adminkey', BOARD_HUB_ONLY: '1', BOARD_PASSKEYS: 'off', BOARD_PUBLIC_URL: '', BOARD_REVISE_GRACE_MS: '50', BOARD_TURBO_BASE: '/t', BOARD_TURBO_CLOG_MS: '6000', BOARD_MEMO_HOLD_MS: '400' }, stdio: ['ignore', 'ignore', 'pipe'] })
  let log = ''
  hub.stderr.on("data", chunk => { log += chunk; if (process.env.TURBO_DEBUG) process.stderr.write(chunk) })
  const stop = () => { try { hub.kill() } catch {} }
  process.on('exit', stop)
  const open = []   // streams and links to close at the end
  try {
    await eventually(() => fetch(`${base}/healthz`).then(r => r.ok, () => false), 'the hub')
    // a session, held online the way dev/session.mjs does it
    const agent = { id: 'probe', instance: 'probe-instance-0001' }
    const got = []   // what the hub told the session
    open.push(http.get(`${base}/agent/link?${new URLSearchParams({ name: 'Probe <b>', id: agent.id, instance: agent.instance, cwd: '/tmp', host: 'h', platform: 'p' })}`, { headers: { 'x-board-token': 'secret' } }, res => { res.setEncoding('utf8'); res.on('data', c => got.push(c)) }))
    const tool = async (name, args) => {
      const res = await fetch(`${base}/agent/tool`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-board-token': 'secret' }, body: JSON.stringify({ ...agent, name, args }) })
      const out = await res.json()
      assert.ok(res.ok, out.error)
      return out.text
    }
    await eventually(() => /"hello":"([\w-]+)"/.test(got.join('')), 'the hub to greet the session')
    agent.id = /"hello":"([\w-]+)"/.exec(got.join(''))[1]
    let why = ''
    await eventually(() => tool('set_status', { id: 's', label: 'probe', state: 'working' }).then(() => true, err => { why = err.message; return false }), 'the session to be linked').catch(err => { throw new Error(`${err.message}: ${why} ${got.join('').slice(0, 200)}`) })
    const ask = async (title, extra = {}) => (await tool('create_decision', { title, options: [{ key: 'a', label: 'Ja' }, { key: 'b', label: 'Nein' }], ...extra })).match(/^card (\w+) /)[1]
    const get = (route, headers = {}) => fetch(base + route, { headers: { Cookie: cookie, ...headers }, redirect: 'manual' })
    const post = (route, fields, headers = {}) => fetch(base + route, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields) })
    const STREAM = { Accept: 'text/vnd.turbo-stream.html, text/html' }
    const state = async () => JSON.parse((await (await get('/events?once')).body.getReader().read().then(r => Buffer.from(r.value).toString())).split('\n').find(l => l.startsWith('data: ')).slice(6))
    const cardOf = async id => (await stateOnce()).cards.find(c => c.id === id)
    // (the state as the old page gets it, one frame)
    const stateOnce = () => new Promise((resolve, reject) => {
      const req = http.get(`${base}/events`, { headers: { Cookie: cookie } }, res => {
        let buf = ''
        res.setEncoding('utf8')
        res.on('data', c => { buf += c; const end = buf.indexOf('\n\n'); if (end >= 0) { req.destroy(); resolve(JSON.parse(buf.slice(buf.indexOf('data: ') + 6, end))) } })
      })
      req.on('error', reject)
    })
    void state

    // ---- the login guards the pages like everything else ----
    assert.equal((await fetch(`${base}/t/`)).status, 401)
    assert.equal((await fetch(`${base}/t/stream`)).status, 401)
    assert.equal((await fetch(`${base}/t/cards/x/decide`, { method: 'POST', headers: { Cookie: cookie, Origin: 'http://evil.example' } })).status, 403)

    // ---- the Desk comes complete from the hub ----
    const first = await ask('Erste <script>alert(1)</script> & "Frage"', { body: 'Text mit **fett** und <b>Markup</b>.' })
    const second = await ask('Zweite: drei Wege', { options: [{ key: 'x', label: 'Eins' }, { key: 'y', label: 'Zwei' }, { key: 'z', label: 'Drei' }], recommended: 'y' })
    const loud = await ask('Dritte klopft', { urgency: 'high', urgency_reason: 'eilt sehr' })
    const numberOf = async id => (await cardOf(id)).number
    let res = await get('/t/')
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /^text\/html/)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    let page = await res.text()
    // the rows, in the queue's fixed order
    const order = [...page.matchAll(/<article class="inbox-row" id="row-(\w+)"/g)].map(m => m[1])
    assert.deepEqual(order, [first, second, loud])
    // board content is escaped: title, session name
    assert.ok(page.includes('<strong class="inbox-question" data-controller="fit">Erste &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Frage&quot;</strong>'))
    assert.ok(!page.includes('<script>alert(1)</script>'))
    assert.ok(page.includes('Probe &lt;b&gt;'))
    assert.match(page, /<span class="inbox-gutter-name" aria-hidden="true">Probe &lt;b&gt;<\/span><\/a>/)   // who asks: drawing and name, beside the row
    assert.ok(!page.includes('Probe <b>'))
    assert.ok(page.includes('<span class="inbox-body-text">Text mit fett und &lt;b&gt;Markup&lt;/b&gt;.</span>'))
    // a two-way question answers from the row: a form, one button per option; the agent's first option is the lead
    assert.match(page, new RegExp(`<form class="inbox-actions" method="post" action="/t/cards/${first}/decide">`))
    assert.match(page, /<button class="inbox-answer is-thumb" type="submit" name="key" value="b"[^>]*aria-label="Nein">/)
    assert.match(page, /<button class="inbox-answer is-thumb is-lead" type="submit" name="key" value="a"[^>]*aria-label="Ja">/)
    // more than two options: no tiles to answer with, a real link to the card's own page
    assert.match(page, new RegExp(`<a class="inbox-answer is-wide is-lead" data-nav href="/t/q/${await numberOf(second)}"`))
    assert.match(page, new RegExp(`<a class="inbox-text has-sender" data-nav href="/t/q/${await numberOf(first)}"`))
    // snooze and shred on the row, as buttons with their own address
    assert.match(page, new RegExp(`formaction="/t/cards/${first}/snooze"`))
    assert.match(page, new RegExp(`formaction="/t/cards/${first}/shred"`))
    // the knock marker, and the reason in the row's text
    assert.match(page, /<header class="inbox-row-head"><span class="inbox-tab"><svg[^>]*class="sketch"[\s\S]*?<\/svg>Knock<\/span>/)
    assert.ok(page.includes('eilt sehr'))
    // heading, sidebar, pill, stacks, stream
    assert.match(page, /<p class="inbox-heading inbox-next"><a class="inbox-walk inbox-go" data-nav href="\/t\/walk"[^>]*><span>Next<\/span><b class="inbox-next-n">3<\/b><svg/)
    assert.match(page, new RegExp(`<div class="agent-row[^"]*" id="agent-${agent.id}" data-folds-target="row" data-unit="${agent.id}"`))
    assert.match(page, /<a class="desk-next is-knock" data-nav href="\/t\/walk" title="Next: walk through the 3 cards \(1 knock\)"[^>]*><b class="desk-next-n">3<\/b>/)
    assert.match(page, /<div class="inbox-stacks stack-tabs(?: is-straight)?" id="desk-stacks" data-controller="piles"/)
    for (const kind of ['later', 'works', 'done', 'trash']) assert.ok(page.includes(` data-stack="${kind}"`), kind)   // four places (views/stacks.mjs)
    assert.match(page, /<turbo-stream-source id="live" src="\/t\/stream\?rev=[0-9a-f]+-\d+&view=desk&bar=1">/)
    assert.match(page, /<script type="module" src="\/t\/application\.js"><\/script>/)
    // the files it needs are served, compressed and with an ETag
    for (const file of ['/t/application.js', '/t/controllers/card_controller.js', '/vendor/stimulus.js', '/vendor/turbo.es2017-esm.js', '/css/turbo.css', '/js/pen.js']) {
      const f = await get(file, { 'Accept-Encoding': 'br' })
      assert.equal(f.status, 200, file)
      assert.ok(f.headers.get('etag'), file)
      assert.equal((await get(file, { 'If-None-Match': f.headers.get('etag'), 'Accept-Encoding': 'br' })).status, 304, file)
    }
    assert.equal((await get('/vendor/turbo.es2017-esm.js', { 'Accept-Encoding': 'br' })).headers.get('content-encoding'), 'br')
    assert.equal((await get('/t/', { 'Accept-Encoding': 'gzip' })).headers.get('content-encoding'), 'gzip')

    // ---- a card's own page ----
    res = await get(`/t/q/${await numberOf(second)}`)
    assert.equal(res.status, 200)
    page = await res.text()
    assert.match(page, /<h1 class="tc-title" id="card-title-\w+">Zweite: drei Wege<\/h1>/)
    assert.match(page, new RegExp(`<button class="tc-opt is-advised" type="submit" form="card-form-${second}" formaction="/t/cards/${second}/decide" name="key" value="y"`))
    assert.match(page, new RegExp(`<button class="tc-opt" type="submit" form="card-form-${second}" formaction="/t/cards/${second}/decide" name="key" value="x"`))
    assert.match(page, new RegExp(`formaction="/t/cards/${second}/trust"`))
    assert.match(page, new RegExp(`<form class="tc-ask tc-chat" id="card-form-${second}" method="post" action="/t/cards/${second}/message"`))
    assert.match(page, /<a class="tc-back" data-nav href="\/t\/"/)
    assert.match(page, new RegExp(`src="/t/stream\\?rev=[0-9a-f]+-\\d+&view=card&bar=1&amp;card=${second}"`))
    assert.equal((await get('/t/q/99999')).status, 404)
    // the walk leads to the oldest open card
    assert.equal((await get('/t/walk')).headers.get('location'), `/t/q/${await numberOf(first)}?walk=1`)
    // a page the old client still has: sent there
    assert.equal((await get('/t/pad')).headers.get('location'), '/pad')   // (a session's page is rendered here now: turbo-session-test.mjs)

    // ---- the live stream: only the element that changed ----
    const listen = route => {
      const heard = []
      open.push(http.get(base + route, { headers: { Cookie: cookie } }, r => { r.setEncoding('utf8'); r.on('data', c => heard.push(c)) }))
      return { heard, text: () => heard.join(''), since: n => heard.slice(n).join('') }
    }
    const revOf = async () => /stream\?rev=([0-9a-f]+-\d+)/.exec(await (await get('/t/')).text())[1]
    const desk = listen(`/t/stream?rev=${await revOf()}&view=desk&bar=1`)
    await eventually(() => desk.heard.length > 0, 'the stream to open')
    assert.doesNotMatch(desk.text(), /action="refresh"/)   // the page is current: nothing to fetch again
    // a page that was rendered before something changed fetches itself anew, once
    const stale = listen('/t/stream?rev=old-1&view=desk')
    await eventually(() => /<turbo-stream action="refresh"><\/turbo-stream>/.test(stale.text()), 'the refresh for a stale page')

    // a card arrives: it is put before the stacks, as a row of its own; the counts follow
    let mark = desk.heard.length
    const fourth = await ask('Vierte kommt dazu')
    await eventually(() => desk.since(mark).includes(`id="row-${fourth}"`), 'the new row on the stream')
    let frame = desk.since(mark)
    assert.match(frame, /<turbo-stream action="before" target="desk-stacks"><template><section class="inbox-group"/)
    assert.match(frame, /<turbo-stream action="replace" target="desk-head">/)
    assert.match(frame, /<turbo-stream action="update" target="desk-state">/)
    assert.ok(frame.includes('aria-label="Next: walk through the 4 cards'))
    assert.ok(!frame.includes(`id="row-${first}"`), 'rows that did not change are not sent again')
    assert.ok(frame.split('\n').every(line => line === '' || line.startsWith('data: ') || line.startsWith(':') || line.startsWith('retry: ')), 'every line of a frame is an SSE line')

    // answered with one tap from the row: the form's own answer removes the row and says what happened; every page hears the removal
    mark = desk.heard.length
    res = await post(`/t/cards/${first}/decide`, { key: 'a', stay: '1' }, STREAM)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /^text\/vnd\.turbo-stream\.html/)
    let answer = await res.text()
    assert.ok(answer.includes(`<turbo-stream action="remove" target="row-${first}"></turbo-stream>`))
    assert.match(answer, /<turbo-stream action="prepend" target="says-host"><template><div class="says"[^<]*><span class="says-words"><b>Answered<\/b><span>Erste &lt;script&gt;[^<]* → Ja<\/span>/)
    assert.ok(answer.includes(`action="/t/cards/${first}/reopen"`))
    await eventually(() => desk.since(mark).includes(`<turbo-stream action="remove" target="row-${first}"></turbo-stream>`), 'the removal on the stream')
    assert.match(desk.since(mark), /<turbo-stream action="replace" target="desk-stacks">/)   // it lies on "Done" now
    assert.equal((await cardOf(first)).choice, 'a')
    await eventually(() => got.join('').includes('"choice":"a"'), 'the session to hear the answer')
    // taken back from the note: the row is there again (the order changed back, so the list is sent whole)
    mark = desk.heard.length
    assert.equal((await post(`/t/cards/${first}/reopen`, { stay: '1', quiet: '1' }, STREAM)).status, 200)
    await eventually(() => desk.since(mark).includes(`id="row-${first}"`), 'the row to come back')
    assert.match(desk.since(mark), /<turbo-stream action="update" target="desk-list">/)

    // without Turbo the same form is a plain post: a redirect back to the Desk, which then shows the note
    res = await post(`/t/cards/${fourth}/snooze`, { stay: '1' })
    assert.equal(res.status, 303)
    assert.equal(res.headers.get('location'), `/t/?said=${fourth}:snooze`)
    page = await (await get(res.headers.get('location'))).text()
    assert.match(page, /<div class="says"[^<]*><span class="says-words"><b>Snoozed<\/b><span>Vierte kommt dazu<\/span>/)
    assert.ok(!page.includes(`id="row-${fourth}"`))
    assert.ok(page.includes(`data-id="${fourth}" data-kind="later" data-later`))   // it lies on "Later"
    assert.equal((await post(`/t/cards/${fourth}/wake`, { stay: '1' }, STREAM)).status, 200)
    assert.ok((await (await get('/t/')).text()).includes(`id="row-${fourth}"`))

    // an answer that is not taken: the row comes back with the reason, nothing is saved
    res = await post(`/t/cards/${fourth}/decide`, { key: 'nope', stay: '1' }, STREAM)
    answer = await res.text()
    assert.match(answer, new RegExp(`<turbo-stream action="replace" target="row-${fourth}">`))
    assert.match(answer, /<p class="inbox-error inbox-row-error" role="alert">Not saved: unknown option<\/p>/)
    assert.equal((await cardOf(fourth)).status, 'open')
    assert.equal((await post('/t/cards/00000000/decide', { key: 'a' })).status, 404)

    // ---- on the card's page: the note goes along, the answer leads on; the page hears what the session says ----
    const page2 = listen(`/t/stream?rev=${await revOf()}&view=card&card=${second}`)
    await eventually(() => page2.heard.length > 0, 'the card stream to open')
    mark = page2.heard.length
    await tool('reply', { text: 'Dazu noch: <u>eins</u> ist billiger.', card_id: second })
    await eventually(() => page2.since(mark).includes(`<turbo-stream action="replace" target="card-thread-${second}">`), 'the reply on the card page')
    assert.ok(page2.since(mark).includes('Dazu noch: &lt;u&gt;eins&lt;/u&gt; ist billiger.'))
    assert.ok(!page2.since(mark).includes('desk-head'), 'a card page gets nothing of the Desk')
    mark = page2.heard.length
    res = await post(`/t/cards/${second}/decide`, { key: 'y', note: 'bitte so' })
    assert.equal(res.status, 303)
    assert.equal(res.headers.get('location'), `/t/?said=${second}:decide`)
    assert.deepEqual([(await cardOf(second)).choice, (await cardOf(second)).note], ['y', 'bitte so'])
    await eventually(() => page2.since(mark).includes(`<turbo-stream action="replace" target="card-answer-${second}">`), 'the answered state on the card page')
    // a step of the walk leads to the next card
    res = await post(`/t/cards/${loud}/decide`, { key: 'b', walk: '1' })
    assert.match(res.headers.get('location'), /^\/t\/q\/\d+\?walk=1&said=/)   // on to the card that stood after it, with the note

    // Revise hands the card back to its session: it leaves the rows and lies on "Later"; taking it back returns it
    assert.equal((await post(`/t/cards/${fourth}/revise`, { stay: '1' }, STREAM)).status, 200)
    assert.ok((await cardOf(fourth)).with_agent)
    await eventually(() => got.join('').includes('"handback":"1"'), 'the session to hear the hand-back')
    page = await (await get('/t/')).text()
    assert.ok(!page.includes(`id="row-${fourth}"`) && page.includes(`data-id="${fourth}" data-kind="asked"`))
    assert.equal((await post(`/t/cards/${fourth}/takeback`, { stay: '1' }, STREAM)).status, 200)
    assert.equal((await cardOf(fourth)).with_agent, undefined)
    // an info is acknowledged with one tap
    const note = (await tool('create_info', { title: 'Nur zur Kenntnis', body: 'Fertig.' })).match(/^card (\w+) /)?.[1]
    if (note) {
      page = await (await get('/t/')).text()
      assert.match(page, new RegExp(`<form class="inbox-actions" method="post" action="/t/cards/${note}/close">`))
      assert.equal((await post(`/t/cards/${note}/close`, { stay: '1' }, STREAM)).status, 200)
      assert.equal((await cardOf(note)).status, 'done')
    }
    // ---- a session's page (worker A): server/turbo-session-test.mjs ----
    await (await import('./turbo-session-test.mjs')).sessionTests({ base, cookie, agent, got, tool, ask, get, post, STREAM, stateOnce, cardOf, eventually, listen })
    // ---- a session's files: the chip and the drawer (card Nr. 204): server/turbo-files-test.mjs ----
    await (await import('./turbo-files-test.mjs')).filesTests({ agent, tool, ask, get, stateOnce, eventually, listen })
    // ---- the Agents page (worker B): server/turbo-agents-test.mjs ----
    await (await import('./turbo-agents-test.mjs')).agentsTests({ base, cookie, agent, get, post, STREAM, stateOnce, eventually, listen, open })
    // ---- the stacks at the foot of the Desk: Later, In the works, Done, the basket: server/turbo-stacks-test.mjs ----
    await (await import('./turbo-stacks-test.mjs')).stacksTests({ tool, ask, get, post, STREAM, cardOf, eventually, listen })
    // ---- memos and the Desk's paper (worker C): server/turbo-memo-test.mjs ----
    await (await import('./turbo-memo-test.mjs')).memoTests({ base, cookie, agent, got, get, post, STREAM, stateOnce, eventually, listen })
    // ---- the one toast, top right, with Undo: server/turbo-toast-test.mjs ----
    await (await import('./turbo-toast-test.mjs')).toastTests({ base, cookie, agent, ask, get, post, STREAM, stateOnce, cardOf, eventually })
    // ---- sized variants of stored pictures (worker F): server/turbo-thumbs-test.mjs ----
    await (await import('./turbo-thumbs-test.mjs')).thumbsTests({ base, tool, get, cardOf })
    // ---- fixes from the code review (stamp, old versions, stacks, a stream that stops reading): server/turbo-fixes-test.mjs ----
    await (await import('./turbo-fixes-test.mjs')).fixesTests({ base, cookie, tool, ask, get, post, STREAM, cardOf, eventually, listen, clogMs: 6000 })
    // ---- parity with the old board: Agents button, memo count on a phone, index-card heading, title count: server/turbo-parity-test.mjs ----
    await (await import('./turbo-parity-test.mjs')).parityTests({ base, cookie, agent, ask, get, post, STREAM, stateOnce, eventually, listen })
    // ---- keys, the Trommi menu and jump, the long-press sheet (worker D): server/turbo-keys-test.mjs ----
    await (await import('./turbo-keys-test.mjs')).keysTests({ ask, get, cardOf })
    // ---- the sidebar folded to a rail (card Nr. 150): server/turbo-rail-test.mjs ----
    await (await import('./turbo-rail-test.mjs')).railTests({ get })
    // ---- a stopped session (the red hand) apart from a knocking card (cards Nr. 202/203): server/turbo-blocked-test.mjs ----
    await (await import('./turbo-blocked-test.mjs')).blockedTests()
    // ---- the card page in full: a note on one option, the draft, files, versions, where it stands ----
    const fifth = await ask('Fünfte mit Notizen', { options: [{ key: 'x', label: 'Eins', detail: 'siehe https://example.org/eins' }, { key: 'y', label: 'Zwei' }, { key: 'z', label: 'Drei' }] })
    page = await (await get(`/t/q/${await numberOf(fifth)}`)).text()
    assert.match(page, /<label class="tc-opt-note" data-note="x" hidden>[\s\S]*?<input type="text" name="note-x" form="card-form-\w+"/)
    assert.match(page, /data-controller="card" data-card-draft-value="\/t\/cards\/\w+\/draft"/)
    assert.match(page, /<span class="tc-count"[^>]*>\d+ of \d+<\/span>/)
    // a link written into an option stands under the card, not on the tile
    assert.match(page, /<span class="tc-opt-detail">siehe example\.org\/eins<\/span>/)
    assert.match(page, /<div class="tc-did t-opt-links">[\s\S]*?<b>Eins<\/b> <a href="https:\/\/example\.org\/eins"/)
    // the draft is kept, and comes back with the page; it does not send the answer piece over the stream
    const page5 = listen(`/t/stream?rev=${await revOf()}&view=card&card=${fifth}`)
    await eventually(() => page5.heard.length > 0, 'the stream of the fifth card')
    mark = page5.heard.length
    assert.equal((await post(`/t/cards/${fifth}/draft`, { note: 'halb getippt', 'note-y': 'zu Zwei' })).status, 204)
    assert.deepEqual([(await cardOf(fifth)).draft.note, (await cardOf(fifth)).draft.notes], ['halb getippt', { y: 'zu Zwei' }])
    page = await (await get(`/t/q/${await numberOf(fifth)}`)).text()
    assert.match(page, />halb getippt<\/textarea>/)
    assert.match(page, /<label class="tc-opt-note" data-note="y">[\s\S]*?value="zu Zwei"/)
    await sleep(150)
    assert.ok(!page5.since(mark).includes('card-answer-'), 'a draft replaces nothing on the page that types it')
    // the agent rewords the question: the page hears it, the feed says "Revised" and leads to the version before
    await tool('revise_card', { card_id: fifth, title: 'Fünfte, neu gefasst', note: 'kürzer' })
    await eventually(() => page5.since(mark).includes(`target="card-lead-${fifth}"`), 'the revised face on the card page')
    page = await (await get(`/t/q/${await numberOf(fifth)}`)).text()
    assert.match(page, /<div class="tc-turn" id="turn-\w+" data-version="2">/)
    assert.match(page, new RegExp(`<a class="tc-turn-before" data-nav href="/t/q/${await numberOf(fifth)}\\?v=1">See version 1</a>`))
    page = await (await get(`/t/q/${await numberOf(fifth)}?v=1`)).text()
    assert.match(page, /<h1 class="tc-title" id="card-title-\w+">Fünfte mit Notizen<\/h1>/)
    assert.ok(page.includes('version 1, as it was') && !page.includes(`formaction="/t/cards/${fifth}/decide" name="key"`))
    // an answer with a note on an option and a file (multipart, as the page's form sends it)
    await sleep(300)   // (an answer right after a rewrite is refused for a moment)
    const many = new FormData()
    many.set('key', 'y'); many.set('note', 'so'); many.set('note-y', 'aber leise'); many.set('revised', String((await cardOf(fifth)).revised))
    many.set('files', new Blob([Buffer.from('hello')], { type: 'text/plain' }), 'notiz.txt')
    res = await fetch(`${base}/t/cards/${fifth}/decide`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: base }, body: many })
    assert.equal(res.status, 303)
    const answered = await cardOf(fifth)
    assert.deepEqual([answered.choice, answered.note, answered.option_notes, answered.note_attachments?.[0]?.name], ['y', 'so', { y: 'aber leise' }, 'notiz.txt'])
    await eventually(() => /aber leise/.test(got.join('')), 'the session to hear the note on the option')
    // marks drawn on a card go along with the answer (the field "marks", as the card's form sends it) and with its draft
    const drawn = await ask('Mit Zeichnung')
    const pen = [{ id: 'pen-1', anchor: { kind: 'card' }, strokes: [{ color: 'var(--accent)', pts: [0.1, 0.1, 0.3, 0.2] }] }]
    assert.equal((await post(`/t/cards/${drawn}/draft`, { note: '', marks: JSON.stringify(pen) })).status, 204)
    assert.equal((await cardOf(drawn)).draft.marks.length, 1)
    assert.match(await (await get(`/t/q/${await numberOf(drawn)}`)).text(), /<input type="hidden" name="marks" value="\[\{&quot;id&quot;:&quot;pen-1&quot;/)
    assert.equal((await post(`/t/cards/${drawn}/decide`, { key: 'a', marks: JSON.stringify(pen) })).status, 303)
    assert.equal((await cardOf(drawn)).marks?.length, 1)
    // a long talk under a card: What?? with its answer as one block, a hand-back with the version it brought, earlier versions folded
    const talk = await ask('Lange Rede')
    await post(`/t/cards/${talk}/what`, {})
    await tool('reply', { text: 'So gemeint: erstens, zweitens.', card_id: talk })
    await post(`/t/cards/${talk}/revise`, { note: 'Bitte kürzer.' })
    await sleep(300)
    await tool('revise_card', { card_id: talk, title: 'Kurze Rede', note: 'gekürzt' })
    await tool('reply', { text: 'Jetzt kürzer.', card_id: talk })
    page = await (await get(`/t/q/${await numberOf(talk)}`)).text()
    assert.match(page, /<details class="tc-fold tc-earlier"><summary>Earlier versions \(1\)<\/summary><section class="tc-explained"><p class="tc-explained-head"><b>You asked: What\?\?<\/b>[\s\S]*?So gemeint: erstens, zweitens\.[\s\S]*?<\/details><article class="msg msg-user"[^>]*><div class="bubble"><p>Bitte kürzer\.<\/p>[\s\S]*?<div class="tc-turn"[^>]*><p class="tc-turn-head"><b>Version 2, as you asked<\/b>/)
    assert.match(page, /<\/div><article class="msg msg-agent"[^>]*>[\s\S]*?Jetzt kürzer\./)
    // what was sent leaves the draft: the field comes back empty and a later answer does not carry it again
    const once = await ask('Nur einmal')
    await post(`/t/cards/${once}/draft`, { note: 'Anklopfen für dringend' })
    await post(`/t/cards/${once}/message`, { note: 'Anklopfen für dringend' })
    assert.equal((await cardOf(once)).draft?.note ?? '', '')
    assert.doesNotMatch(await (await get(`/t/q/${await numberOf(once)}`)).text(), />Anklopfen für dringend<\/textarea>/)
    await post(`/t/cards/${once}/decide`, { key: 'a' })
    assert.equal((await cardOf(once)).note, '')
    assert.equal((await stateOnce()).messages.filter(m => m.card_id === once && m.from === 'user' && m.text === 'Anklopfen für dringend').length, 1)
    // the field under the card sends a message and the card stays with him; the reverse field hands it back
    const split = await ask('Getrennt')
    res = await post(`/t/cards/${split}/message`, { note: 'Nur eine Frage.' })
    assert.equal(res.headers.get('location'), `/t/q/${await numberOf(split)}?said=${split}:message`)
    assert.equal((await cardOf(split)).with_agent, undefined)
    page = await (await get(res.headers.get('location'))).text()
    assert.match(page, /<b[^>]*>Message sent<\/b>/)
    assert.match(page, new RegExp(`<details class="tc-revise"[\\s\\S]*?<summary class="tc-tile tc-reverse"[\\s\\S]*?<form class="tc-revise-form" method="post" action="/t/cards/${split}/revise"`))
    assert.equal((await post(`/t/cards/${split}/revise`, { note: 'Kürzer bitte.' })).status, 303)
    assert.ok((await cardOf(split)).with_agent)
    assert.doesNotMatch(log, /turbo stream:/)
  } finally {
    for (const req of open) req.destroy()
    stop()
    await sleep(200)
    fs.rmSync(data, { recursive: true, force: true })
  }
  console.log('ok: turbo (escaping, rich text, pen, the Desk and a card page from the hub, forms with and without Turbo, the live stream)')
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) { await run(); process.exit(0) }
