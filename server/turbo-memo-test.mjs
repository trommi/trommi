// Memos and the Desk's paper on the server-rendered board (server/views/memo.mjs): the button and the notes come
// from the hub, escaped; the forms make, put away, open, throw away and send a note, with and without Turbo; the
// live stream brings a note to every page. Run by server/turbo-test.mjs on its hub; (worker C).
import assert from 'node:assert/strict'

export async function memoTests({ base, cookie, agent, got, get, post, STREAM, stateOnce, eventually, listen }) {
  const json = (route, body) => fetch(base + route, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const memos = async () => (await stateOnce()).memos
  const revOf = async () => /stream\?rev=([0-9a-f]+-\d+)/.exec(await (await get('/t/')).text())[1]
  for (const m of await memos()) await json('/memo', { id: m.id, remove: true })
  for (const a of (await stateOnce()).agents) if (a.starred) await json('/star', { agent: a.id, starred: false })

  // ---- every page has the button and the notes' place; only the Desk has the paper; no Memos stack ----
  let page = await (await get('/t/')).text()
  assert.match(page, /<div id="memo-layer" data-controller="memos"><div class="memo-new" id="memo-new"><form method="post" action="\/t\/memos"><button class="icon-btn quick-open memo-open memo-open-free" id="memo-open" type="submit" data-action="click->memos#open"/)
  assert.match(page, /<div id="memos"><\/div>/)
  assert.match(page, /<div id="paper-island" data-controller="paper" hidden[^>]* data-sessions="\[\{&quot;id&quot;:/)
  assert.ok(!page.includes('inbox-stack-word">Memos<'), 'there is no Memos stack')
  assert.ok(!page.includes('/pad/?embed'), 'the pad is not part of the page: the controller lays it after first paint')
  const number = (await stateOnce()).cards.find(c => c.status === 'open')?.number
  if (number != null) {
    const card = await (await get(`/t/q/${number}`)).text()
    assert.match(card, /id="memo-open"/)
    assert.ok(!card.includes('id="paper-island"'), 'no paper on a card page')
    assert.match(card, /href="\/css\/quicksend\.css"/)
  }
  // the login and the origin guard the forms
  assert.equal((await fetch(`${base}/t/memos`, { method: 'POST' })).status, 401)
  assert.equal((await fetch(`${base}/t/memos`, { method: 'POST', headers: { Cookie: cookie, Origin: 'http://evil.example' } })).status, 403)

  // ---- making a note: a plain post comes back to the page; the note is rendered, escaped ----
  const live = listen(`/t/stream?rev=${await revOf()}&view=desk&bar=1`)
  const onCard = listen(`/t/stream?rev=${await revOf()}&view=card&card=none`)
  await eventually(() => live.heard.length > 0 && onCard.heard.length > 0, 'the streams to open')
  let res = await post('/t/memos', { text: 'Hallo <script>alert(1)</script> & "du"', x: '300', y: '200' }, { Referer: `${base}/t/q/7?walk=1` })
  assert.equal(res.status, 303)
  assert.equal(res.headers.get('location'), '/t/q/7?walk=1')
  let [note] = await memos()
  assert.equal(note.text, 'Hallo <script>alert(1)</script> & "du"')
  assert.deepEqual([note.place, note.x, note.y], ['float', 300, 200])
  page = await (await get('/t/')).text()
  assert.match(page, new RegExp(`<div class="memo" id="memo-${note.id}" data-controller="memo" data-action="[^"]*" data-id="${note.id}" data-place="float" data-x="300" data-y="200" style="left:clamp\\(4px, 300px, calc\\(100vw - 344px\\)\\);top:clamp\\(4px, 200px, calc\\(100vh - 120px\\)\\)">`))
  assert.ok(page.includes('Hallo &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;du&quot;</textarea>'))
  assert.ok(!page.includes('<script>alert(1)</script>'))
  assert.ok(!/<textarea class="memo-field"[^>]*placeholder/.test(page), 'no placeholder')
  assert.ok(!page.includes('memo-tear'), 'no drawn tear line in the markup')
  // the live stream brought it to every page with a stream, also a card's
  for (const s of [live, onCard]) await eventually(() => s.text().includes(`<turbo-stream action="append" target="memos"><template><div class="memo" id="memo-${note.id}"`), 'the note on the stream')

  // ---- the crown: none on the desk, the hollow crown leads to the Agents page; one crown, one button ----
  assert.match(page, /<a class="quick-send memo-send is-none" data-nav href="\/t\/agents"/)
  res = await post(`/t/memos/${note.id}/send`, { text: note.text }, STREAM)
  assert.equal(res.status, 422)
  assert.match(await res.text(), /<turbo-stream action="prepend" target="says-host"><template><div class="says" data-controller="says" data-action="[^"]*" role="alert"><span class="says-words"><b>Not sent<\/b><span>no crown on this desk yet/)
  assert.equal((await memos()).length, 1, 'a note that was not sent stays')
  let mark = live.heard.length
  assert.equal((await json('/star', { agent: agent.id, starred: true })).status, 200)
  await eventually(() => live.since(mark).includes(`<turbo-stream action="replace" target="memo-${note.id}">`), 'the note with its crown on the stream')
  page = await (await get('/t/')).text()
  assert.equal(page.match(/class="quick-send memo-send/g).length, 1, 'exactly one crown button')
  assert.match(page, new RegExp(`<button class="quick-send memo-send" type="submit" data-action="click->memo#send" name="to" value="${agent.id}" data-name="Probe &lt;b&gt;"`))

  // ---- typing is kept through the hub's own route; the stream carries the change ----
  mark = live.heard.length
  assert.equal((await json('/memo', { id: note.id, text: 'Bitte prüfen' })).status, 200)
  await eventually(() => /Bitte prüfen<\/textarea>/.test(live.since(mark)), 'the typed words on the stream')

  // ---- put away: the note hangs off the button (count and list); opened again it is out ----
  mark = live.heard.length
  res = await post(`/t/memos/${note.id}/stack`, { text: 'Bitte prüfen <b>' }, STREAM)
  assert.equal(res.status, 200)
  assert.equal(await res.text(), `<turbo-stream action="remove" target="memo-${note.id}"></turbo-stream>`)
  assert.deepEqual((await memos()).map(m => [m.place, m.text]), [['stack', 'Bitte prüfen <b>']])
  await eventually(() => live.since(mark).includes(`<turbo-stream action="remove" target="memo-${note.id}">`) && live.since(mark).includes('<turbo-stream action="replace" target="memo-new">'), 'the note gone and the button changed on the stream')
  page = await (await get('/t/')).text()
  assert.match(page, /id="memo-open"[^<]* data-draft data-count="1"[^<]*>[\s\S]*?<b class="memo-count">1<\/b><\/button>/)
  assert.match(page, new RegExp(`<form method="post" action="/t/memos/${note.id}/open"><button class="memo-away-line" type="submit" role="menuitem" data-memo="${note.id}"[^>]*>[\\s\\S]*?<span>Bitte prüfen &lt;b&gt;</span></button></form>`))
  assert.match(page, /<div id="memos"><\/div>/)
  res = await post(`/t/memos/${note.id}/open`, {}, STREAM)
  assert.match(await res.text(), new RegExp(`^<turbo-stream action="append" target="memos"><template><div class="memo" data-fresh id="memo-${note.id}"`))
  assert.equal((await memos())[0].place, 'float')
  // an empty note that is put away is simply gone
  await post('/t/memos', {})
  const empty = (await memos()).find(m => !m.text)
  await post(`/t/memos/${empty.id}/stack`, {}, STREAM)
  assert.equal((await memos()).length, 1)

  // ---- the bin, and the way back within the passing line ----
  res = await post(`/t/memos/${note.id}/bin`, { text: 'Bitte prüfen <b>' }, STREAM)
  const said = await res.text()
  assert.match(said, new RegExp(`^<turbo-stream action="remove" target="memo-${note.id}"></turbo-stream><turbo-stream action="prepend" target="says-host"><template><div class="says" data-controller="says" data-action="[^"]*" role="status"><span class="says-words"><b>Note thrown away</b><span>Bitte prüfen &lt;b&gt;</span></span><form method="post" action="/t/memos"><input type="hidden" name="stay" value="1"><input type="hidden" name="quiet" value="1"><input type="hidden" name="text" value="Bitte prüfen &lt;b&gt;"><input type="hidden" name="place" value="float"><input type="hidden" name="x" value="300"><input type="hidden" name="y" value="200">`))
  assert.equal((await memos()).length, 0)
  res = await post('/t/memos', { text: 'Bitte prüfen <b>', place: 'float', x: '300', y: '200' }, STREAM)
  assert.equal(res.status, 200)
  note = (await memos())[0]
  assert.deepEqual([note.text, note.x, note.y], ['Bitte prüfen <b>', 300, 200])
  // a note that is gone: said, nothing breaks
  res = await post('/t/memos/nope/bin', {}, STREAM)
  assert.equal(res.status, 404)
  assert.equal((await post('/t/memos/nope/bin', {})).status, 303)

  // ---- the crown sends: the note is gone at once, the hub holds it (BOARD_MEMO_HOLD_MS, 400 in this suite) and Undo
  // in the toast brings it back as it was; after the hold the session gets the words as the form had them ----
  const shown = async () => (await memos()).filter(m => !m.held)
  const userSaid = async () => (await stateOnce()).messages.filter(m => m.from === 'user').map(m => m.text)
  res = await post(`/t/memos/${note.id}/send`, { text: 'Doch nicht', to: agent.id }, STREAM)
  assert.equal(res.status, 200)
  assert.match(await res.text(), new RegExp(`^<turbo-stream action="remove" target="memo-${note.id}"></turbo-stream><turbo-stream action="prepend" target="says-host"><template><div class="says" data-controller="says" data-action="[^"]*" role="status" data-says-ms-value="\\d+"><span class="says-words"><b>Memo sent to Probe &lt;b&gt;</b></span><form method="post" action="/t/memos/${note.id}/unsend"><input type="hidden" name="stay" value="1"><input type="hidden" name="quiet" value="1"><button class="says-back" type="submit"[^>]*>`))
  assert.equal((await shown()).length, 0, 'a sent note is on no page')
  res = await post(`/t/memos/${note.id}/unsend`, { stay: '1', quiet: '1' }, STREAM)
  assert.equal(res.status, 200)
  assert.match(await res.text(), new RegExp(`^<turbo-stream action="append" target="memos"><template><div class="memo" data-fresh data-back id="memo-${note.id}"`))
  assert.deepEqual((await shown()).map(m => [m.id, m.text, m.x, m.y]), [[note.id, 'Doch nicht', 300, 200]], 'Undo: the note is back as it was')
  await new Promise(r => setTimeout(r, 600))
  assert.ok(!(await userSaid()).includes('Doch nicht'), 'an undone memo is never delivered')
  const before = got.join('').length
  mark = live.heard.length
  res = await post(`/t/memos/${note.id}/send`, { text: 'Bitte die Tab-Leiste prüfen', to: agent.id }, STREAM)
  assert.equal(res.status, 200)
  assert.match(await res.text(), /<b>Memo sent to Probe &lt;b&gt;<\/b>/)
  assert.equal((await shown()).length, 0)
  assert.ok(!(await userSaid()).includes('Bitte die Tab-Leiste prüfen'), 'not delivered before the hold is over')
  await eventually(async () => (await memos()).length === 0, 'the held memo to go')
  const last = (await stateOnce()).messages.filter(m => m.from === 'user').at(-1)
  assert.deepEqual([last.agent, last.text], [agent.id, 'Bitte die Tab-Leiste prüfen'])
  await eventually(() => got.join('').slice(before).includes('Bitte die Tab-Leiste prüfen'), 'the session to get the memo')
  await eventually(() => live.since(mark).includes(`<turbo-stream action="remove" target="memo-${note.id}">`), 'the sent note gone on the stream')
  // without Turbo: a plain post, then back to the page
  await post('/t/memos', { text: 'ohne Skript' })
  note = (await memos())[0]
  res = await post(`/t/memos/${note.id}/send`, { text: 'ohne Skript', to: agent.id })
  assert.equal(res.status, 303)
  assert.equal((await shown()).length, 0)
  await eventually(async () => (await memos()).length === 0, 'the held memo to go')
  // Undo after the hold: refused, said plainly
  res = await post(`/t/memos/${note.id}/unsend`, { stay: '1' }, STREAM)
  assert.equal(res.status, 422)
  assert.match(await res.text(), /role="alert"><span class="says-words"><b>Not undone<\/b><span>too late: the memo already went to Probe &lt;b&gt;<\/span>/)
  assert.equal((await stateOnce()).messages.filter(m => m.from === 'user').at(-1).text, 'ohne Skript')
  // a note on the paper is rendered in the paper's pixels
  await json('/memo', { text: 'auf dem Papier', place: 'paper', x: 40, y: 900 })
  page = await (await get('/t/')).text()
  assert.match(page, /data-place="paper" data-x="40" data-y="900" style="left:40px;top:900px">/)
  for (const m of await memos()) await json('/memo', { id: m.id, remove: true })
}
