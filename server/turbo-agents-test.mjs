// The Agents page of the server-rendered board (server/views/agents.mjs, server/views/session-edit.mjs):
// the ledger from the hub, its forms (with and without Turbo), what the hub refuses said in the line, and
// the live stream. Run by server/turbo-test.mjs on its hub; (worker B).
import assert from 'node:assert/strict'
import http from 'node:http'
import { sessionHeadEdit } from './views/session-edit.mjs'
import { DRAWINGS } from '../client/web/js/pen.js'

export async function agentsTests({ base, cookie, agent, get, post, STREAM, stateOnce, eventually, listen, open }) {
  const sessionOf = async id => (await stateOnce()).agents.find(a => a.id === id)
  const pageNow = async (query = '') => (await get(`/t/agents${query}`)).text()
  const lineOf = (page, id) => new RegExp(`<div class="[^"]*" role="row" id="ledger-${id}"[\\s\\S]*?\\n</div>`).exec(page)?.[0] ?? ''
  // one more session, held online the way the probe is
  const link = async (name, id) => {
    const got = []
    const req = http.get(`${base}/agent/link?${new URLSearchParams({ name, id, instance: `${id}-instance-0001`, cwd: `/tmp/${id}`, host: 'h', platform: 'p' })}`, { headers: { 'x-board-token': 'secret' } }, res => { res.setEncoding('utf8'); res.on('data', c => got.push(c)) })
    open.push(req)
    await eventually(() => /"hello":"([\w-]+)"/.test(got.join('')), `the hub to greet ${name}`)
    return { id: /"hello":"([\w-]+)"/.exec(got.join(''))[1], req }
  }
  const helper = await link('Helfer', 'helfer'), third = await link('Dritte', 'dritte')
  await eventually(async () => (await sessionOf(third.id))?.online, 'the sessions to be online')
  const edit = (id, fields, headers) => post(`/t/sessions/${id}/edit`, fields, headers)

  // ---- the partial for a session's heading: mark and name as the controls that change them ----
  const head = String(sessionHeadEdit({ id: 'a b', name: 'Na<me>', mark: 'draw:moon', hue: 10, online: true }, '/t', { back: '/t/s/a%20b' }))
  assert.match(head, /<span class="t-session-edit" data-controller="pops">/)
  assert.match(head, /<form method="post" action="\/t\/sessions\/a%20b\/edit" data-turbo-frame="_top"><input type="hidden" name="back" value="\/t\/s\/a%20b">/)
  assert.match(head, /<input type="text" id="session-name-a b" name="label" value="Na&lt;me&gt;" maxlength="60"/)
  assert.match(head, /<turbo-frame id="marks-a b" src="\/t\/sessions\/a%20b\/marks\?back=%2Ft%2Fs%2Fa%2520b" loading="lazy">/)
  assert.ok(!head.includes('Na<me>'))

  // ---- the page comes complete from the hub ----
  assert.equal((await fetch(`${base}/t/agents`)).status, 401)
  let res = await get('/t/agents')
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /^text\/html/)
  let page = await res.text()
  assert.match(page, /<main id="ledger" aria-label="Agents">/)
  assert.match(page, /<body [^>]*data-t-view="agents"[^>]*data-page="roster"/)
  assert.match(page, /<link rel="stylesheet" href="\/css\/ledger\.css">/)
  assert.match(page, /<p id="ledger-lead">3 of 3 sessions are connected\.<\/p>/)
  assert.match(page, /<turbo-stream-source id="live" src="\/t\/stream\?rev=[0-9a-f]+-\d+&view=agents&bar=1">/)
  // one line per session, in the board's order; no dialog anywhere
  assert.deepEqual([...page.matchAll(/role="row" id="ledger-([\w-]+)"/g)].map(m => m[1]), [agent.id, helper.id, third.id])
  assert.doesNotMatch(/<main id="ledger"[\s\S]*?<\/main>/.exec(page)[0], /<dialog/)
  let line = lineOf(page, agent.id)
  assert.match(line, /data-state="(asking|waiting|working|idle)"/)
  // board content is escaped: the session's name, wherever it stands
  assert.ok(line.includes('<strong>Probe &lt;b&gt;</strong>') && !page.includes('Probe <b>'))
  // the forms: rename at the name, the crown at the mark, the drawings as a frame that loads when opened
  assert.match(line, new RegExp(`<form method="post" action="/t/sessions/${agent.id}/edit" data-turbo-frame="_top"><input type="hidden" name="stay" value="1"><label class="caps"[^>]*>Rename the session</label><input type="text"[^>]* name="label" value="Probe &lt;b&gt;"`))
  assert.match(line, new RegExp(`<form method="post" action="/t/sessions/${agent.id}/star"><input type="hidden" name="stay" value="1"><button class="crown-toggle ledger-crown" data-ledger="crown" type="submit" name="starred" value="[01]" aria-pressed="(true|false)"`))
  assert.match(line, new RegExp(`<turbo-frame id="marks-${agent.id}" src="/t/sessions/${agent.id}/marks\\?stay=1" loading="lazy">`))
  // a session that is online has no archive control; the way to its conversation is a link
  assert.doesNotMatch(line, /name="archived"/)
  assert.match(line, new RegExp(`<a class="ledger-ib" data-ledger="open" data-nav href="/t/s/${agent.id}" title="Open the conversation"`))
  // its open question is a link to the card's own page (no answering in the line)
  if (/class="ledger-q"/.test(line)) assert.match(line, /<a class="ledger-q" data-ledger="question" data-nav href="\/t\/q\/\d+"/)
  // the main agent: a choice whose options are buttons of one form
  line = lineOf(page, helper.id)
  assert.match(line, new RegExp(`<summary class="ledger-desk ledger-main" data-ledger="main" title="Main agent of Helfer[^"]*"[^>]*><svg[^>]*class="sketch"[\\s\\S]*?</svg><span>No main</span></summary>\\s*<form class="t-pop t-menu" method="post" action="/t/sessions/${helper.id}/edit">`))
  assert.match(line, new RegExp(`<button type="submit" name="parent" value="${agent.id}">↳ Probe &lt;b&gt;</button>`))
  assert.match(page, /<div class="ledger" role="table" id="ledger-list" data-controller="pops" data-mains>/)
  // finding and sorting are links and a GET form
  assert.match(page, /<form method="get" action="\/t\/agents" role="search">/)
  assert.match(page, /<a class="ledger-th th-name" data-nav role="columnheader" aria-sort="none" href="\/t\/agents\?sort=name">Session<\/a>/)
  page = await pageNow('?find=dritte')
  assert.deepEqual([...page.matchAll(/role="row" id="ledger-([\w-]+)"/g)].map(m => m[1]), [third.id])
  page = await pageNow('?sort=name&down=1')
  assert.deepEqual([...page.matchAll(/role="row" id="ledger-([\w-]+)"/g)].map(m => m[1]), [agent.id, helper.id, third.id])   // Probe, Helfer, Dritte
  assert.match(page, /aria-sort="descending" href="\/t\/agents\?sort=name">Session<i>↓<\/i>/)
  assert.match((await pageNow('?find=%22%3E%3Cscript%3E')), /name="find" value="&quot;&gt;&lt;script&gt;"/)

  // ---- the live stream of the page ----
  const revOf = async () => /stream\?rev=([0-9a-f]+-\d+)/.exec(await pageNow())[1]
  const live = listen(`/t/stream?rev=${await revOf()}&view=agents&bar=1`)
  await eventually(() => live.heard.length > 0, 'the stream of the Agents page to open')
  let at = live.heard.length

  // ---- rename: a plain form is answered with the page; Turbo's with nothing, the stream brings the line ----
  assert.equal((await fetch(`${base}/t/sessions/${helper.id}/edit`, { method: 'POST', headers: { Cookie: cookie, Origin: 'http://evil.example' } })).status, 403)
  res = await edit(helper.id, { label: 'Neu <i>x</i>' })
  assert.equal(res.status, 303)
  assert.equal(res.headers.get('location'), '/t/agents')
  assert.equal((await sessionOf(helper.id)).label, 'Neu <i>x</i>')
  await eventually(() => new RegExp(`<turbo-stream action="replace" target="ledger-${helper.id}"><template><div class="ledger-line"[\\s\\S]*?<strong>Neu &lt;i&gt;x&lt;/i&gt;</strong>`).test(live.since(at)), 'the renamed line on the stream')
  // (the other lines name it as a possible main: they are replaced too; nothing fetches the page anew)
  assert.doesNotMatch(live.since(at), /action="refresh"/)
  assert.ok(!live.since(at).includes('<i>x</i>'))
  at = live.heard.length
  res = await edit(helper.id, { label: 'Helferin', stay: '1' }, STREAM)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /^text\/vnd\.turbo-stream\.html/)
  assert.equal(await res.text(), '')
  assert.equal((await sessionOf(helper.id)).label, 'Helferin')
  await eventually(() => live.since(at).includes('<strong>Helferin</strong>'), 'the second rename on the stream')
  // the name the session gave itself is no name of the human's
  await edit(helper.id, { label: 'Helfer' })
  assert.equal((await sessionOf(helper.id)).label, '')
  // where to go afterwards: only a path of this board
  assert.equal((await edit(helper.id, { label: 'Helferin', back: `/t/s/${helper.id}` })).headers.get('location'), `/t/s/${helper.id}`)
  assert.equal((await edit(helper.id, { label: 'Helferin', back: '//evil.example/x' })).headers.get('location'), '/t/agents')
  assert.equal((await edit(helper.id, { label: 'Helferin', back: 'https://evil.example/t/' })).headers.get('location'), '/t/agents')

  // ---- his own order: a line moves one place up or down; the lines change places, so the page fetches itself anew ----
  const orderNow = async () => [...(await pageNow()).matchAll(/role="row" id="ledger-([\w-]+)"/g)].map(m => m[1])
  assert.match(lineOf(await pageNow(), third.id), new RegExp(`<span class="ledger-grip"><form method="post" action="/t/sessions/${third.id}/move"><input type="hidden" name="stay" value="1"><button type="submit" data-ledger="up" name="dir" value="up"`))
  at = live.heard.length
  assert.equal((await post(`/t/sessions/${third.id}/move`, { dir: 'up', stay: '1' }, STREAM)).status, 200)
  assert.deepEqual(await orderNow(), [agent.id, third.id, helper.id])
  await eventually(() => /action="refresh"/.test(live.since(at)), 'the refresh after a move')
  assert.equal((await post(`/t/sessions/${agent.id}/move`, { dir: 'down' })).status, 303)
  assert.deepEqual(await orderNow(), [third.id, agent.id, helper.id])
  await post(`/t/sessions/${agent.id}/move`, { dir: 'down' })
  await post(`/t/sessions/${agent.id}/move`, { dir: 'down' })   // already last: nothing moves
  assert.deepEqual(await orderNow(), [third.id, helper.id, agent.id])
  for (const id of [third.id, third.id, helper.id]) await post(`/t/sessions/${id}/move`, { dir: 'down' })
  assert.deepEqual(await orderNow(), [agent.id, helper.id, third.id])
  // a page sorted by a column says so to its stream, and fetches itself anew when that column's order changes
  const sortedPage = await pageNow('?sort=name')
  assert.match(sortedPage, /<turbo-stream-source id="live" src="\/t\/stream\?rev=[0-9a-f]+-\d+&view=agents&bar=1&amp;sort=name">/)
  assert.match(sortedPage, /id="ledger-list" data-controller="pops" data-sorted/)
  const byName = listen(`/t/stream?rev=${/stream\?rev=([0-9a-f]+-\d+)/.exec(sortedPage)[1]}&view=agents&bar=1&sort=name`)
  await eventually(() => byName.heard.length > 0, 'the stream of the sorted page to open')
  let from = byName.heard.length
  await edit(third.id, { label: 'Zzz' })
  await eventually(() => /action="refresh"/.test(byName.since(from)), 'the refresh of the page sorted by name')
  from = byName.heard.length
  await edit(third.id, { icon: 'draw:moon' })   // the order by name is the same: the line alone
  await eventually(() => new RegExp(`action="replace" target="ledger-${third.id}"`).test(byName.since(from)), 'the changed line on the sorted page')
  assert.doesNotMatch(byName.since(from), /action="refresh"/)
  await edit(third.id, { label: 'Dritte' })

  res = await get(`/t/sessions/${helper.id}/marks?stay=1`)
  assert.equal(res.status, 200)
  let marks = await res.text()
  assert.match(marks, new RegExp(`<turbo-frame id="marks-${helper.id}"><form method="post" action="/t/sessions/${helper.id}/edit" data-turbo-frame="_top"><input type="hidden" name="stay" value="1">`))
  assert.equal([...marks.matchAll(/<button class="mark-tile" type="submit" name="icon" value="draw:/g)].length, DRAWINGS.length)
  assert.match(await (await get(`/t/sessions/${helper.id}/marks?in=s`)).text(), new RegExp(`<turbo-frame id="marks-s-${helper.id}">`))
  assert.equal((await get('/t/sessions/niemand/marks')).status, 404)
  assert.equal((await edit(helper.id, { icon: 'draw:rocket', stay: '1' }, STREAM)).status, 200)
  assert.deepEqual([(await sessionOf(helper.id)).icon, (await sessionOf(helper.id)).icon_by], ['draw:rocket', 'human'])
  marks = await (await get(`/t/sessions/${helper.id}/marks`)).text()
  assert.match(marks, /value="draw:rocket" role="radio" aria-checked="true"/)

  // ---- the main agent: a sub stands under its main; what the hub refuses is said in the line ----
  at = live.heard.length
  assert.equal((await edit(helper.id, { parent: agent.id, stay: '1' }, STREAM)).status, 200)
  assert.equal((await sessionOf(helper.id)).parent, agent.id)
  page = await pageNow()
  assert.match(lineOf(page, helper.id), /^<div class="ledger-line is-sub"/)
  assert.match(lineOf(page, agent.id), /^<div class="ledger-line is-main"/)
  assert.match(lineOf(page, helper.id), /<summary class="ledger-desk ledger-main"[^>]* data-set><svg[\s\S]*?<\/svg><span>Probe &lt;b&gt;<\/span>/)
  // (a main with subs cannot become a sub: it has no such choice)
  assert.doesNotMatch(lineOf(page, agent.id), /name="parent"/)
  const before = JSON.stringify((await stateOnce()).agents.map(a => [a.id, a.parent ?? null]))
  res = await edit(agent.id, { parent: third.id, stay: '1' }, STREAM)
  assert.equal(res.status, 200)
  let body = await res.text()
  assert.match(body, new RegExp(`^<turbo-stream action="replace" target="ledger-${agent.id}"><template><div class="ledger-line is-main"`))
  assert.match(body, /<p class="ledger-err" role="alert">Not saved: [\w-]+ has subs of its own, so it cannot become a sub \(one level\)<\/p>/)
  res = await edit(agent.id, { parent: third.id })
  assert.equal(res.status, 422)
  page = await res.text()
  assert.match(lineOf(page, agent.id), /<p class="ledger-err" role="alert">Not saved: [\w-]+ has subs of its own/)
  assert.equal(JSON.stringify((await stateOnce()).agents.map(a => [a.id, a.parent ?? null])), before)
  res = await edit('niemand', { label: 'x', stay: '1' }, STREAM)
  assert.match(await res.text(), /^<turbo-stream action="refresh"><\/turbo-stream>$/)
  assert.equal((await edit('niemand', { label: 'x' })).status, 422)
  await edit(helper.id, { parent: '' })
  assert.equal((await sessionOf(helper.id)).parent ?? null, null)

  // ---- the crown: one form, the hub's own rule ----
  assert.equal((await post(`/t/sessions/${third.id}/star`, { starred: '1', stay: '1' }, STREAM)).status, 200)
  assert.equal((await sessionOf(third.id)).starred, true)
  assert.match(lineOf(await pageNow(), third.id), /name="starred" value="0" aria-pressed="true"/)
  assert.equal((await post(`/t/sessions/${third.id}/star`, { starred: '0' })).status, 303)
  assert.equal((await sessionOf(third.id)).starred, false)

  // ---- laid together, and taken out again ----
  assert.equal((await post(`/t/sessions/${third.id}/pair`, { with: helper.id, stay: '1' }, STREAM)).status, 200)
  const group = (await sessionOf(third.id)).group
  assert.ok(group && (await sessionOf(helper.id)).group === group)
  line = lineOf(await pageNow(), third.id)
  assert.match(line, /<span class="ledger-with" title="with Helferin"><span class="ledger-with-names">with Helferin<\/span><form method="post" action="\/t\/sessions\/[\w-]+\/unpair">/)
  assert.equal((await post(`/t/sessions/${third.id}/unpair`, { out: '1' })).status, 303)
  assert.deepEqual([(await sessionOf(third.id)).group, (await sessionOf(helper.id)).group], [null, null])

  // ---- archive: only a session that is away ----
  res = await edit(helper.id, { archived: '1', stay: '1' }, STREAM)
  assert.match(await res.text(), /<p class="ledger-err" role="alert">Not saved: a session that is online cannot be archived<\/p>/)
  assert.equal(Boolean((await sessionOf(helper.id)).archived), false)
  // it goes away: its line says so, by the stream
  at = live.heard.length
  helper.req.destroy()
  await eventually(async () => (await sessionOf(helper.id)).online === false, 'the session to go offline')
  await eventually(() => /action="refresh"|data-state="away"/.test(live.since(at)), 'the stream to tell that the session went away')
  page = await pageNow()
  assert.match(page, /<p id="ledger-lead">2 of 3 sessions are connected\.<\/p>/)
  assert.match(page, new RegExp(`<h3 class="ledger-sub">Disconnected</h3>\\s*<div class="ledger-line" role="row" id="ledger-${helper.id}" data-id="${helper.id}" data-state="away"`))
  assert.match(lineOf(page, helper.id), /<button class="ledger-ib" data-ledger="archive" type="submit" name="archived" value="1" title="Archive: put this session away"/)
  at = live.heard.length
  assert.equal((await edit(helper.id, { archived: '1', stay: '1' }, STREAM)).status, 200)
  assert.equal((await sessionOf(helper.id)).archived, true)
  // lines changed places: the page fetches itself anew
  await eventually(() => /<turbo-stream action="refresh"><\/turbo-stream>/.test(live.since(at)), 'the refresh after archiving')
  page = await pageNow()
  assert.match(page, new RegExp(`<h3 class="ledger-sub">Archive</h3>\\s*<div class="ledger-line is-archived" role="row" id="ledger-${helper.id}"`))
  assert.match(lineOf(page, helper.id), new RegExp(`<form method="post" action="/t/sessions/${helper.id}/edit"><input type="hidden" name="stay" value="1"><button class="ledger-link" data-ledger="fetch" type="submit" name="archived" value="0">Fetch back</button>`))
  assert.match(page, /<p id="ledger-lead">2 of 2 sessions are connected\.<\/p>/)
  assert.equal((await edit(helper.id, { archived: '0' })).status, 303)
  assert.equal((await sessionOf(helper.id)).archived, false)
  // left as it was found, for whatever runs after this
  await edit(helper.id, { archived: '1' })
  third.req.destroy()
  await eventually(async () => (await sessionOf(third.id)).online === false, 'the third session to go offline')
  await edit(third.id, { archived: '1' })
}
