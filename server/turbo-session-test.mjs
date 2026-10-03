// The session page of the server-rendered board (server/views/session.mjs): called from server/turbo-test.mjs
// with that suite's hub and helpers. What the hub renders, that it is escaped, what the composer does with and
// without Turbo, what the live stream sends, the earlier messages, the files and a picture's page.
import assert from 'node:assert/strict'
import { readMultipart, PAGE } from './views/session.mjs'

export async function sessionTests({ base, cookie, agent, got, tool, ask, get, post, STREAM, stateOnce, cardOf, eventually, listen }) {
  // ---- a form with files, read without a library ----
  const form = new FormData()
  form.append('text', 'Zeile eins\r\nZeile zwei')
  form.append('stay', '1')
  form.append('files', new Blob([Buffer.from([0, 1, 2, 13, 10, 45, 45, 255])], { type: 'image/png' }), 'a "b".png')
  form.append('files', new Blob([]), '')   // the empty field a browser sends when no file was chosen
  const sent = new Response(form)
  const read = readMultipart(Buffer.from(await sent.arrayBuffer()), sent.headers.get('content-type'))
  assert.equal(read.fields.get('text'), 'Zeile eins\r\nZeile zwei')
  assert.equal(read.fields.get('stay'), '1')
  assert.equal(read.files.length, 1)
  assert.deepEqual([...read.files[0].bytes], [0, 1, 2, 13, 10, 45, 45, 255])
  assert.equal(read.files[0].type, 'image/png')
  assert.throws(() => readMultipart(Buffer.from('x'), 'multipart/form-data'), /boundary/)
  // the boundary's words inside a file, without the line break before them, are the file's own bytes (RFC 2046)
  {
    const b = 'XyZ123', inner = Buffer.from(`a--${b}b\n--${b}--c`)
    const body = Buffer.concat([Buffer.from(`preamble\r\n--${b}\r\nContent-Disposition: form-data; name="text"\r\n\r\nhi --${b} there\r\n--${b}\r\nContent-Disposition: form-data; name="files"; filename="x.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`), inner, Buffer.from(`\r\n--${b}--\r\nepilogue --${b}\r\n`)])
    const r = readMultipart(body, `multipart/form-data; boundary=${b}`)
    assert.equal(r.fields.get('text'), `hi --${b} there`)
    assert.equal(r.files.length, 1)
    assert.ok(r.files[0].bytes.equals(inner))
    const atStart = readMultipart(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--${b}--`), `multipart/form-data; boundary="${b}"`)
    assert.equal(atStart.fields.get('a'), '1')
  }

  const id = agent.id, here = `/t/s/${id}`
  const messages = async () => (await stateOnce()).messages.filter(m => m.agent === id)

  // ---- the page comes complete from the hub ----
  await tool('reply', { text: 'Hallo **fett** <img src=x onerror=alert(1)>\n\n```html\n<table><tr><td>Zelle</td></tr></table>\n```' })
  const waiting = await ask('Fünfte <i>steht</i> im Gespräch', { body: 'Kurz.' })
  let res = await get(here)
  assert.equal(res.status, 200)
  let page = await res.text()
  assert.match(page, new RegExp(`<body data-view="chat" data-scope="${id}" data-t-view="session"`))
  assert.match(page, /<link rel="stylesheet" href="\/css\/session\.css">/)
  assert.match(page, new RegExp(`<main id="session" aria-label="Session: Probe &lt;b&gt;" data-controller="files"`))
  // the heading: drawing, name (escaped), the quiet line; the row of the sidebar is the current one
  assert.match(page, new RegExp(`<div class="pane-who" id="session-who-${id}"[^>]*><h2 class="pane-name offscreen">Probe &lt;b&gt;</h2><span class="t-session-edit"`))
  // the mark and the name are the controls that change them (views/session-edit.mjs); the page stays, the stream brings the change
  assert.match(page, new RegExp(`<summary class="t-head-mark"[^>]*><span class="agent-avatar`))
  assert.match(page, new RegExp(`<summary class="t-head-name"[^>]*><strong>Probe &lt;b&gt;</strong></summary>\\s*<div class="session-editor t-pop"><form method="post" action="/t/sessions/${id}/edit"[^>]*><input type="hidden" name="stay" value="1">`))
  assert.doesNotMatch(page, /Probe <b>/)
  assert.match(page, new RegExp(`<p class="pane-now" id="session-now-${id}"><span>[^<]+</span>`))
  assert.match(page, /aria-current="page"/)
  // the agent's words: light markdown, nothing of its markup; a layout goes into the sandboxed frame's holder
  assert.match(page, /<article class="msg msg-agent" id="msg-\w+"><header class="msg-head">/)
  assert.match(page, /<strong>fett<\/strong> &lt;img src=x onerror=alert\(1\)&gt;/)
  assert.doesNotMatch(page, /<img src=x/)
  assert.match(page, /<div class="rich-html" data-controller="richhtml" data-richhtml-source-value="&lt;table&gt;/)
  // an open question stands in the conversation as its row; its text links to the card's page under the session
  const nr = (await cardOf(waiting)).number
  assert.match(page, new RegExp(`<div class="ask ask-card" id="msg-\\w+"><article class="inbox-row" id="row-${waiting}"`))
  assert.match(page, new RegExp(`<a class="inbox-text[^"]*" data-nav href="/t/s/${id}/q/${nr}"`))
  assert.match(page, /Fünfte &lt;i&gt;steht&lt;\/i&gt; im Gespräch/)
  assert.doesNotMatch(page, /<i>steht<\/i>/)
  // "N open", the filters as links with the count, the status line of running work
  const openNow = (await stateOnce()).queue.length
  assert.match(page, new RegExp(`<a class="open-jump" id="session-open-${id}" data-nav href="#msg-\\w+"[^>]*><span data-log-target="openText">${openNow} open</span>`))
  assert.match(page, new RegExp(`<div class="column session-compose">.*</form>\\n?<details class="t-pick session-filter" id="session-filters-${id}" data-controller="pops title" data-title-count-value="${openNow}"><summary class="session-filter-btn" title="Filter: All messages"`, 's'))
  assert.match(page, new RegExp(`<a href="/t/s/${id}" data-nav aria-current="true">.*<span>All messages</span></a><a href="/t/s/${id}\\?only=questions" data-nav id="filter-questions">.*<span>Questions only</span><b id="filter-count">${openNow}</b></a>(?:<a href="/t/s/${id}/files" data-nav id="filter-files" class="session-filter-files"[^>]*>.*?<span>Files \\(\\d+\\)</span></a>)?</nav></details>`))
  assert.doesNotMatch(page, /session-filter-dot/)
  assert.match(page, new RegExp(`<div class="session-status" id="session-status-${id}"><p class="status-line" data-state="working">`))
  // the composer is a plain form with a file field; the stream of this page names the session
  assert.match(page, new RegExp(`<form class="composer" id="composer-${id}" method="post" action="/t/s/${id}/message" enctype="multipart/form-data" data-controller="composer" data-composer-agent-value="${id}" data-action="turbo:submit-end->composer#sent`))
  assert.doesNotMatch(page, /data-island="composer"/)
  // the log's own controller: the way to the end, the open chip, the times (written with their instant, shown in the browser's zone)
  assert.match(page, /<div class="chat-pane" data-agent="[\w-]+" data-controller="log">/)
  assert.match(page, /<button type="button" class="jump" hidden data-log-target="jump" data-action="log#toEnd">/)
  assert.match(page, /<time class="msg-time" datetime="\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z" title="[^"]+">\d\d:\d\d<\/time>/)
  assert.match(page, /<div class="day" data-day="\d+"><span>Today<\/span><\/div>/)
  assert.match(page, /<input class="offscreen" type="file" name="files" multiple data-composer-target="picker"/)
  assert.match(page, /<textarea name="text" id="composer-field-[^"]*" rows="1" data-composer-target="field" data-action="input->composer#typed keydown->composer#keys paste->composer#paste"/)
  assert.match(page, new RegExp(`<turbo-stream-source id="live" src="/t/stream\\?rev=[0-9a-f]+-\\d+&view=session&bar=1&amp;session=${id}">`))
  assert.match(page, /<meta name="t-pages" content="[^"]*\\\/s\\\/\(\[\^\/\+\]\+\)\$/)
  // a code block carries the button that copies it; the starters of an empty conversation are links that fill the field
  await tool('reply', { text: 'So:\n\n```js\nconst a = "<b>"\n```' })
  page = await (await get(here)).text()
  assert.match(page, /<div class="code" data-controller="copy"><div class="code-head"><span class="code-lang">Code<\/span><button type="button" class="code-copy" data-action="copy#copy">.*?<span data-copy-target="label">Copy<\/span><\/button><\/div><pre data-copy-target="source"><code>const a = &quot;&lt;b&gt;&quot;<\/code><\/pre><\/div>/)
  page = await (await get(`${here}?say=${encodeURIComponent('Where do <we> stand?')}`)).text()
  assert.match(page, /data-composer-focus-value="true"[\s\S]*?<textarea [^\n]*>Where do &lt;we&gt; stand\?<\/textarea>/)
  // a session that is not there; sessions laid together are still the old page's
  assert.equal((await get('/t/s/nobody')).status, 404)
  res = await get('/t/s/a+b')
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), '/s/a+b')
  assert.equal((await fetch(`${base}${here}`)).status, 401)

  // ---- the composer ----
  // a plain post: the message is in the conversation, the session hears it, the browser is sent back to the page
  let before = (await messages()).length
  res = await post(`${here}/message`, { text: 'Hallo <b>Sitzung</b> & co' })
  assert.equal(res.status, 303)
  assert.equal(res.headers.get('location'), here)
  let said = (await messages()).at(-1)
  assert.deepEqual([said.from, said.text, said.attachments.length], ['user', 'Hallo <b>Sitzung</b> & co', 0])
  await eventually(() => got.join('').includes('Hallo <b>Sitzung</b> & co'), 'the session to hear the message')
  page = await (await get(here)).text()
  assert.match(page, /<article class="msg msg-user" id="msg-\w+"><div class="bubble"><p>Hallo &lt;b&gt;Sitzung&lt;\/b&gt; &amp; co<\/p><\/div>/)
  assert.match(page, /<div class="session-status" id="session-status-[\w-]+"><div class="working">[\s\S]*?<span>Agent is working<\/span><span class="dots">/)   // under the last message, also beside a working status line (as the old client)
  // sent by Turbo, with a picture and a file: the answer is a fresh form; the files are stored and shown
  const many = new FormData()
  many.append('stay', '1')
  many.append('text', 'mit Anhang')
  many.append('files', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), 'bild <1>.png')
  many.append('files', new Blob(['Notiz']), 'notiz.txt')
  res = await fetch(`${base}${here}/message`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: base, ...STREAM }, body: many })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /^text\/vnd\.turbo-stream\.html/)
  let answer = await res.text()
  assert.match(answer, new RegExp(`<turbo-stream action="replace" target="composer-${id}"><template><form class="composer" id="composer-${id}"[^>]* data-composer-focus-value="true"`))
  assert.match(answer, new RegExp(`<turbo-stream action="replace" target="session-error-${id}"><template><p class="send-error" id="session-error-${id}" role="alert" hidden>`))
  said = (await messages()).at(-1)
  assert.deepEqual([said.text, said.attachments.map(a => [a.name, a.kind])], ['mit Anhang', [['bild <1>.png', 'image'], ['notiz.txt', 'file']]])
  assert.equal(Buffer.from(await (await get(said.attachments[0].url)).arrayBuffer()).toString('hex'), '89504e470d0a1a0a')
  await eventually(() => got.join('').includes('mit Anhang'), 'the session to hear of the files')
  page = await (await get(here)).text()
  assert.match(page, new RegExp(`<a class="shot" data-nav href="/t/s/${id}/files/1\\?from=${said.id}" aria-label="Enlarge bild &lt;1&gt;.png"><img src="${said.attachments[0].url}" alt="bild &lt;1&gt;.png" loading="lazy" decoding="async" width="320" height="240"></a>`))
  assert.match(page, new RegExp(`<a class="file-chip" href="${said.attachments[1].url}" target="_blank" rel="noopener">.*?<span>notiz.txt</span></a>`))
  // nothing to send: nothing is stored; the page says so (422), a Turbo form gets the reason in place
  before = (await messages()).length
  res = await post(`${here}/message`, { text: '   ' })
  assert.equal(res.status, 422)
  assert.match(await res.text(), new RegExp(`<p class="send-error" id="session-error-${id}" role="alert">Not sent: write something first</p>`))
  res = await post(`${here}/message`, { text: '', stay: '1' }, STREAM)
  assert.equal(res.status, 422)   // (Turbo then counts it as not sent: the composer keeps the draft)
  assert.match(await res.text(), new RegExp(`^<turbo-stream action="replace" target="session-error-${id}"><template><p class="send-error" id="session-error-${id}" role="alert">Not sent: write something first</p></template></turbo-stream>$`))
  assert.equal((await messages()).length, before)
  assert.equal((await fetch(`${base}${here}/message`, { method: 'POST', headers: { Cookie: cookie, Origin: 'http://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'text=x' })).status, 403)
  // the old page's JSON route does the same as before (one function for both)
  res = await fetch(`${base}/message`, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: id, text: '' }) })
  assert.deepEqual([res.status, await res.text()], [400, '{"error":"empty message"}'])
  res = await fetch(`${base}/message`, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: id, text: 'vom alten Client' }) })
  assert.deepEqual([res.status, await res.text()], [200, '{"ok":true}'])

  // ---- live: only the element that changed ----
  const rev = /stream\?rev=([0-9a-f]+-\d+)/.exec(await (await get(here)).text())[1]
  const live = listen(`/t/stream?rev=${rev}&view=session&session=${id}`)
  await eventually(() => live.heard.length > 0, 'the session stream to open')
  assert.doesNotMatch(live.text(), /action="refresh"/)
  // a new message is put at the log's end, and nothing else of the log is sent
  let mark = live.heard.length
  await tool('reply', { text: 'Antwort <u>live</u>' })
  await eventually(() => live.since(mark).includes('Antwort &lt;u&gt;live&lt;/u&gt;'), 'the new message on the stream')
  let frame = live.since(mark)
  assert.match(frame, new RegExp(`<turbo-stream action="before" target="log-end-${id}"><template><article class="msg msg-agent" id="msg-\\w+">`))
  assert.equal(frame.match(/<turbo-stream action="before"/g).length, 1)
  assert.doesNotMatch(frame, /mit Anhang|action="refresh"/)
  // a status line changes: that piece alone
  mark = live.heard.length
  await tool('set_status', { id: 's', label: 'probe', state: 'working', detail: 'baut <em>etwas</em>' })
  await eventually(() => live.since(mark).includes('baut &lt;em&gt;etwas&lt;/em&gt;'), 'the status line on the stream')
  frame = live.since(mark)
  assert.match(frame, new RegExp(`<turbo-stream action="replace" target="session-status-${id}"><template><div class="session-status" id="session-status-${id}">`))
  assert.doesNotMatch(frame, /action="before"|target="msg-/)
  // a question is answered: where it stood in the conversation there is one quiet line now, a link to its page; the counts follow
  const askMsg = (await messages()).findLast(m => m.kind === 'asked' && m.card_id === waiting).id
  mark = live.heard.length
  assert.equal((await post(`/t/cards/${waiting}/decide`, { key: 'a', stay: '1' }, STREAM)).status, 200)
  await eventually(() => live.since(mark).includes(`target="msg-${askMsg}"`), 'the answered question on the stream')
  frame = live.since(mark)
  assert.match(frame, new RegExp(`<turbo-stream action="replace" target="msg-${askMsg}"><template><div class="ask" id="msg-${askMsg}"><a class="event event-decided" data-nav href="/t/s/${id}/q/${nr}"`))
  assert.match(frame, new RegExp(`<turbo-stream action="replace" target="session-filters-${id}">`))
  assert.match(frame, new RegExp(`<turbo-stream action="replace" target="session-open-${id}">`))
  // a new question arrives as its row at the end
  mark = live.heard.length
  const sixth = await ask('Sechste kommt live')
  await eventually(() => live.since(mark).includes(`id="row-${sixth}"`), 'the new question on the stream')
  assert.match(live.since(mark), new RegExp(`<turbo-stream action="before" target="log-end-${id}"><template><div class="ask ask-card" id="msg-\\w+">`))

  // ---- "Questions only" and "Files" ----
  page = await (await get(`${here}?only=questions`)).text()
  assert.match(page, / data-filter="questions">/)
  assert.match(page, new RegExp(`<div class="pane-list pane-questions"><div class="column"><div class="session-cards" id="session-questions-${id}">`))
  assert.match(page, new RegExp(`id="row-${sixth}"`))
  assert.match(page, new RegExp(`<a class="event event-decided cont" data-nav href="/t/s/${id}/q/${nr}"`))
  assert.match(page, new RegExp(`<details class="t-pick session-filter" id="session-filters-${id}" data-on [^>]*><summary class="session-filter-btn" title="Filter: Questions only"[^>]*>.*<i class="session-filter-dot"></i></summary>`))
  assert.match(page, new RegExp(`<a href="/t/s/${id}\\?only=questions" data-nav id="filter-questions" aria-current="true">`))
  assert.doesNotMatch(page, /class="log"/)
  res = await get(`${here}/questions`)
  assert.deepEqual([res.status, res.headers.get('location')], [303, `/t/s/${id}?only=questions`])
  // a second picture, so there is one before and one after
  const two = new FormData()
  two.append('files', new Blob([Buffer.from('89504e470d0a1a0a00', 'hex')], { type: 'image/png' }), 'zwei.png')
  assert.equal((await fetch(`${base}${here}/message`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: base }, body: two })).status, 303)
  // (the files drawer, its chip and its list: server/turbo-files-test.mjs)
  page = await (await get(`${here}/files`)).text()
  assert.doesNotMatch(page, / data-filter=/)
  assert.match(page, new RegExp(`<aside class="files-drawer" id="files-drawer-${id}" data-files-target="drawer" aria-label="Files of this session"><header`))
  // a picture, large, is a page: the one before, the next, and the way back
  page = await (await get(`${here}/files/2`)).text()
  assert.match(page, /<div class="t-picture">/)
  assert.match(page, new RegExp(`<a class="focus-back-desk t-picture-back" data-nav href="/t/s/${id}/files"`))
  assert.match(page, /<b>2 \/ 2<\/b> zwei\.png/)
  assert.match(page, new RegExp(`<a class="focus-stage-step is-prev" data-nav href="/t/s/${id}/files/1"`))
  assert.match(page, new RegExp(`<a class="focus-stage-step is-next" data-nav href="/t/s/${id}/files/1"`))
  assert.doesNotMatch(page, /turbo-stream-source|class="lightbox"/)
  // opened from a message, the way back is that message
  page = await (await get(`${here}/files/1?from=${said.id}`)).text()
  assert.match(page, new RegExp(`<a class="focus-back-desk t-picture-back" data-nav href="/t/s/${id}#msg-${said.id}"`))
  assert.match(page, new RegExp(`href="/t/s/${id}/files/2\\?from=${said.id}"`))

  // ---- a long conversation: the latest part, the earlier ones on demand ----
  for (let i = 1; i <= PAGE + 5; i++) await tool('reply', { text: `Zeile Nummer ${i}.` })
  const all = await messages()
  page = await (await get(here)).text()
  assert.equal(page.match(/ id="msg-\w+"/g).length, PAGE)
  assert.match(page, new RegExp(`Zeile Nummer ${PAGE + 5}\\.`))
  assert.doesNotMatch(page, /Zeile Nummer 5\./)
  const firstShown = all.at(-PAGE).id
  assert.match(page, new RegExp(`<div class="column log-inner"[^>]*><turbo-frame class="log-earlier" id="earlier-${firstShown}"><a class="log-earlier-link" data-nav href="/t/s/${id}\\?before=${firstShown}">Earlier messages<b>${all.length - PAGE}</b></a></turbo-frame>`))
  // the link's page holds the frame of that name with the messages before, and the next link when there are more
  page = await (await get(`${here}?before=${firstShown}`, { 'Turbo-Frame': `earlier-${firstShown}` })).text()
  const inFrame = new RegExp(`<turbo-frame class="log-earlier" id="earlier-${firstShown}">([\\s\\S]*?)</turbo-frame><a class="log-earlier-link is-later"`).exec(page)?.[1]
  assert.ok(inFrame, 'the frame of the earlier messages')
  assert.match(inFrame, /Zeile Nummer 5\./)
  assert.doesNotMatch(inFrame, new RegExp(`Zeile Nummer ${PAGE + 5}\\.`))
  assert.equal(inFrame.match(/ id="msg-\w+"/g).length, Math.min(PAGE, all.length - PAGE))
  assert.doesNotMatch(page, new RegExp(`id="log-end-${id}"`))   // an earlier window takes no live messages
}
