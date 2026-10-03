// Parity with the old board (worker "parity"), called from server/turbo-test.mjs with that suite's hub and helpers:
// the phone's Agents button, the memo count a phone shows, "Next, please" as index cards (views/nextplease.mjs),
// the tab title's count on the live stream (controller "title"), and the working line under a session's last message.
import assert from 'node:assert/strict'

export async function parityTests({ base, cookie, agent, ask, get, post, STREAM, stateOnce, eventually, listen }) {
  const json = (route, body) => fetch(base + route, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const revOf = async () => /stream\?rev=([0-9a-f]+-\d+)/.exec(await (await get('/t/')).text())[1]
  const rows = page => [...page.matchAll(/<article class="inbox-row" id="row-(\w+)"/g)].map(m => m[1])

  // ---- the Agents button in the bar (shown on a phone by css/app.css), current on the Agents page ----
  let page = await (await get('/t/')).text()
  assert.match(page, /<a href="\/t\/agents" data-nav draggable="false" class="icon-btn roster-open" id="roster-open" aria-label="Agents" title="Agents"><svg/)
  assert.match(await (await get('/t/agents')).text(), /id="roster-open" aria-label="Agents" title="Agents" aria-current="page">/)

  // ---- "Next" above the Desk: one plain sentence with the count and the arrow, no index-card tabs ----
  for (let i = 0; i < 5; i++) await ask(`Reiter ${i} <i>x</i>`)
  page = await (await get('/t/')).text()
  const order = rows(page), n = order.length
  assert.ok(n >= 5, `five open cards at least: ${n}`)
  const head = /<header class="inbox-head" id="desk-head"[\s\S]*?<\/header>/.exec(page)[0]
  assert.match(head, new RegExp(`^<header class="inbox-head" id="desk-head" data-controller="title" data-title-count-value="${n}"><div class="inbox-title"><p class="inbox-heading inbox-next"><a class="inbox-walk inbox-go" data-nav href="/t/walk"`))
  assert.match(head, new RegExp(`<span>Next</span><b class="inbox-next-n">${n}</b><svg`))
  assert.ok(!head.includes('inbox-index'), 'no index-card tabs any more')
  assert.ok(!head.includes('<i>x</i>') && !head.includes('Reiter'), 'the heading names no card')
  assert.equal(new RegExp(`<title>\\(${n}\\) `).test(page), true)

  // ---- the count of the tab title follows the stream: the heading arrives with its new count ----
  const live = listen(`/t/stream?rev=${await revOf()}&view=desk&bar=1`)
  await eventually(() => live.heard.length > 0, 'the Desk stream')
  const mark = live.heard.length
  await ask('Noch eine')
  await eventually(() => live.since(mark).includes(`<turbo-stream action="replace" target="desk-head"><template><header class="inbox-head" id="desk-head" data-controller="title" data-title-count-value="${n + 1}">`), 'the heading with the new count on the stream')

  // ---- a session's tab title: its count rides on the filters, which the stream replaces when it changes ----
  page = await (await get(`/t/s/${agent.id}`)).text()
  assert.match(page, new RegExp(`<details class="t-pick session-filter" id="session-filters-${agent.id}" data-controller="pops title" data-title-count-value="\\d+">`))

  // ---- the memo button: a floating note is counted on a phone (the second number), not on a wide screen ----
  for (const m of (await stateOnce()).memos) await json('/memo', { id: m.id, remove: true })
  let res = await post('/t/memos', { text: 'schwebt', place: 'float', x: '300', y: '200' }, STREAM)
  assert.ok(res.status < 400)
  page = await (await get('/t/')).text()
  const button = /<button class="icon-btn quick-open memo-open[\s\S]*?<\/button>/.exec(page)[0]
  assert.ok(button.includes('<b class="memo-count memo-count-phone">1</b>'), button.slice(-200))
  assert.ok(!button.includes('<b class="memo-count">'), 'nothing put away: no number on a wide screen')
  for (const m of (await stateOnce()).memos) await json('/memo', { id: m.id, remove: true })
}
