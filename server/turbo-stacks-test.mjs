// The foot of the Desk on the server-rendered board (server/views/stacks.mjs): four places, one per state of a
// card (Later, In the works, Done, the small basket), no Memos stack; the numbering stamp on each stack; the fan
// as server-rendered lines with their forms; the counts live by the stream. Run by server/turbo-test.mjs on its hub.
import assert from 'node:assert/strict'
import { boardModel } from './views/model.mjs'
import { sketchSvg } from '../client/web/js/pen.js'
import { deskStacks, stackOf, stackCounts, STACKS, STAMPS, ACTING_MS } from './views/stacks.mjs'
import { deskHead } from './views/desk.mjs'

/** What needs no hub: the rule, and the markup from a made-up state. */
export function stacksUnits() {
  // ---- the four-way rule: the hub's card fields decide ----
  const d = (extra = {}) => ({ kind: 'decision', status: 'open', choice: null, ...extra })
  assert.equal(stackOf(d()), null)                                              // an open row
  assert.equal(stackOf(d({ snoozed_until: 9 })), 'later')
  assert.equal(stackOf(d({ with_agent: 5 })), 'works')                          // handed back: in revision
  assert.equal(stackOf(d({ with_agent: 5, snoozed_until: 9 })), 'later')        // put off wins
  const NOW = 1e12, on = { now: NOW, online: () => true }
  assert.equal(stackOf(d({ status: 'decided', choice: 'a', decided: NOW - 1000 }), on), 'works')   // answered, its session acts on it
  assert.equal(stackOf(d({ status: 'decided', trusted: true, decided: NOW - ACTING_MS + 1000 }), on), 'works')
  assert.equal(stackOf(d({ status: 'decided', choice: 'a', decided: NOW - ACTING_MS - 1000 }), on), 'done')   // older than six hours
  assert.equal(stackOf(d({ status: 'decided', choice: 'a', decided: NOW - 1000 }), { now: NOW, online: () => false }), 'done')   // its session is offline
  assert.equal(ACTING_MS, 6 * 60 * 60 * 1000)
  assert.equal(stackOf(d({ status: 'done', choice: 'a' })), 'done')             // closed by its session
  assert.equal(stackOf({ kind: 'info', status: 'done', read: 3 }), 'done')      // an info he read
  assert.equal(stackOf(d({ status: 'shredded' })), 'trash')
  assert.equal(stackOf(d({ status: 'done' })), 'trash')                         // withdrawn: closed without his answer
  assert.equal(stackOf({ kind: 'info', status: 'done', read: null }), 'trash')
  assert.equal(stackOf({ kind: 'permission', status: 'done', choice: 'allow' }), null)
  assert.deepEqual(STACKS, ['later', 'works', 'done', 'trash'])

  // ---- the markup ----
  const card = (id, extra) => ({ id, number: Number(id.slice(1)), agent: 'a', kind: 'decision', status: 'open', title: `T ${id}`, body: '', options: [{ key: 'y', label: 'Ja <i>' }, { key: 'n', label: 'Nein' }], choice: null, choices: [], created: 1, ...extra })
  const cards = [
    card('c1'),
    card('c2', { snoozed_until: Date.now() + 1e6, snoozed_at: 20 }),
    card('c3', { with_agent: 30, title: 'In <b>revision</b>' }),
    card('c4', { status: 'decided', choice: 'y', choices: ['y'], decided: Date.now() - 1000 }),
    card('c8', { status: 'decided', choice: 'n', choices: ['n'], decided: 45 }),   // answered long ago, never closed
    card('c5', { status: 'done', choice: 'n', choices: ['n'], decided: 50 }),
    card('c6', { status: 'shredded', shredded: 60 }),
    card('c7', { status: 'done', summary: 'asked <again>' }),
    ...Array.from({ length: 10 }, (_, i) => card(`c${20 + i}`, { status: 'done', choice: 'y', choices: ['y'], decided: 100 + i })),
  ]
  const state = { cards, queue: ['c1', 'c3'], agents: [{ id: 'a', name: 'Alpha', online: true }], messages: [{ card_id: 'c3', from: 'user', text: 'bitte **neu**' }], tasks: [], assets: [], memos: [{ id: 'm1', place: 'stack', text: 'x' }] }
  const model = boardModel(state, state.agents)
  const page = String(deskStacks(model, '/t'))
  const section = kind => new RegExp(`<section class="([^"]*)" data-stack="${kind}"[\\s\\S]*?</section>`).exec(page)
  assert.match(page, /^<div class="inbox-stacks stack-tabs(?: is-straight)?" id="desk-stacks" data-controller="piles" data-action="keydown.esc->piles#shut">/)
  assert.deepEqual([...page.matchAll(/<section class="[^"]*" data-stack="(\w+)"/g)].map(m => m[1]), STACKS)   // all four, in this order
  assert.ok(!/memos|Memos/.test(page), 'no Memos stack')
  // which card lies where, and why (data-kind), with its way back
  const lying = kind => [...section(kind)[0].matchAll(/data-id="(\w+)" data-kind="(\w+)"/g)].map(m => `${m[1]}:${m[2]}`)
  assert.deepEqual(lying('later'), ['c2:later'])
  assert.deepEqual(lying('works'), ['c3:asked', 'c4:answered'])
  assert.deepEqual(lying('done').slice(0, 2), ['c29:answered', 'c28:answered'])   // the newest first
  assert.deepEqual(lying('trash'), ['c6:shredded', 'c7:withdrawn'])
  assert.match(section('later')[0], /<form method="post" action="\/t\/cards\/c2\/wake"><input type="hidden" name="stay" value="1"><button class="inbox-takeback inbox-revising-take" type="submit"[^>]*>Wake up<\/button>/)
  assert.match(section('works')[0], /action="\/t\/cards\/c3\/takeback"/)
  assert.match(section('works')[0], /action="\/t\/cards\/c4\/reopen"/)
  assert.match(section('trash')[0], /action="\/t\/cards\/c6\/reopen"/)
  assert.doesNotMatch(section('trash')[0], /cards\/c7\//)                         // what its session withdrew has no way back
  // board content is escaped
  assert.ok(page.includes('<strong>In &lt;b&gt;revision&lt;/b&gt;</strong>') && !page.includes('<b>revision</b>'))
  assert.ok(page.includes('Withdrawn: asked &lt;again&gt;'))
  assert.ok(page.includes('Ja &lt;i&gt;'))
  assert.ok(page.includes('<span class="inbox-revising-sent">You: bitte neu</span>'))
  // who closed it: a decision its session closed says so; an info he read says only "Read"
  assert.ok(page.includes('<span class="inbox-revising-sent">Ja &lt;i&gt; · done by the agent</span>'))
  const read = String(deskStacks(boardModel({ ...state, cards: [{ ...card('c90', { kind: 'info', options: [], status: 'done', read: 5, decided: 5 }) }] }, state.agents), '/t'))
  assert.ok(read.includes('<span class="inbox-revising-sent">Read</span>') && !read.includes('Read · done by the agent'))
  // each place is a small stamped tab (card Nr. 198: c): sign, word, count in one line; the bin's sign is the pen's basket
  for (const [kind, n] of [['later', 1], ['works', 2], ['done', 12]]) {
    assert.ok(section(kind)[0].includes(`<span class="stack-stamp stack-tab-stamp" data-stamp="${kind}"><span class="stack-stamp-sign" aria-hidden="true"></span><span class="stack-stamp-word">${STAMPS[kind]}</span><span class="stack-stamp-num">${n}</span></span>`), `the tab of ${kind}`)
  }
  assert.deepEqual(Object.values(STAMPS), ['Snooze', 'Working', 'Done', 'Trash'])
  assert.ok(section('trash')[0].includes(`<span class="stack-stamp stack-tab-stamp" data-stamp="trash"><span class="stack-tab-bin" aria-hidden="true">${sketchSvg('basket-full', 'inbox-bin-drawing')}</span><span class="stack-stamp-word">Trash</span><span class="stack-stamp-num">2</span></span>`))
  assert.match(section('trash')[1], /\binbox-bin\b/)
  for (const kind of ['later', 'works', 'done']) assert.doesNotMatch(section(kind)[1], /inbox-bin/)
  // no big stacks of paper any more
  assert.doesNotMatch(page, /inbox-stack-sheets|inbox-stack-paper/)
  // the name for whoever reads the page aloud stays English
  assert.match(section('later')[0], /aria-label="Later, 1 card" aria-expanded="false"/)
  assert.match(section('works')[0], /aria-label="In the works, 2 cards"/)
  assert.match(section('trash')[0], /aria-label="Trash, 2 cards"/)
  // the ring of a session at work: on "In the works" while a card is in revision
  // no ring of a session at work on the sheet: the turning gear of the stamp says it
  for (const kind of STACKS) assert.doesNotMatch(/<h3[\s\S]*?<\/h3>/.exec(section(kind)[0])[0], /stack-ring|agent-ring/)
  // a fan holds the newest eight, then "N more" leads to the whole pile; asked for, the whole pile stands open
  assert.equal(lying('done').length, 8)
  assert.match(section('done')[0], /<a class="inbox-pile-item inbox-stack-more" data-nav href="\/t\/\?pile=done"[^>]*>4 more<\/a>/)
  const whole = String(deskStacks(model, '/t', 'done'))
  assert.match(whole, /<section class="inbox-stack inbox-group inbox-pile inbox-group-done inbox-group-answered is-open" data-stack="done"/)
  assert.equal([...whole.matchAll(/data-kind="answered"/g)].length, 13)
  assert.ok(whole.includes('<span class="inbox-revising-sent">Nein · not closed by the agent</span>'))   // c8: on Done, said quietly
  assert.doesNotMatch(whole, /inbox-stack-more/)
  // the search over a fanned stack: a GET form into the stack's frame; words over title, session's name and the grey line
  assert.match(section('done')[0], /<form class="stack-search" method="get" action="\/t\/stacks\/done" role="search" data-turbo-frame="stack-list-done" data-controller="stack-search"[\s\S]*?><label><svg[\s\S]*?<\/svg><input type="search" name="q" value=""/)
  assert.match(section('done')[0], /<turbo-frame id="stack-list-done" class="stack-list"/)
  const hits = q => [...String(deskStacks(model, '/t', 'done', q)).split('data-stack="done"')[1].split('data-stack="trash"')[0].matchAll(/data-id="(\w+)" data-kind="answered"/g)].map(m => m[1])
  assert.deepEqual(hits('T c21'), ['c21'])                 // the title; every sheet of the stack, not only the first eight
  assert.equal(hits('alpha ja').length, 10)                // the session's name and the answer, all words (c5 was answered Nein)
  const none = String(deskStacks(model, '/t', 'done', 'zzz <script>'))
  assert.ok(none.includes('<p class="stack-search-none">Nothing here has these words.</p>') && none.includes('value="zzz &lt;script&gt;"') && !none.includes('<script>'))
  assert.doesNotMatch(none, /inbox-stack-more/)
  assert.ok(String(deskStacks(model, '/t', 'trash', 'again')).includes('data-id="c7" data-kind="withdrawn"'))
  assert.doesNotMatch(String(deskStacks(model, '/t', 'done', 'T c21')).split('data-stack="later"')[1].split('</section>')[0], /stack-search-none/)   // (only the open stack is searched)
  // the Desk's heading counts as the tabs count: one function, the same numbers and words
  const counts = stackCounts(model)
  assert.deepEqual(counts, { later: 1, works: 2, done: 12, trash: 2 })
  const clear = String(deskHead(boardModel({ ...state, queue: ['c3'] }, state.agents), '/t'))
  assert.ok(clear.includes('<p>2 working · 1 snoozed</p>'), clear)
  assert.ok(String(deskStacks(model, '/t')).includes('<span class="stack-stamp-word">Working</span><span class="stack-stamp-num">2</span>'))
  // an empty place stands all the same, faint, and cannot be pressed: nothing shifts when a card arrives
  const empty = String(deskStacks(boardModel({ ...state, cards: [card('c1')], queue: ['c1'] }, state.agents), '/t'))
  assert.equal([...empty.matchAll(/<section class="inbox-stack is-empty( inbox-bin)?" data-stack="\w+" data-pile-empty="\w+"/g)].length, 4)
  assert.equal([...empty.matchAll(/<button class="inbox-stack-head" type="button" aria-label="[^"]*, 0 cards" disabled>/g)].length, 4)
  assert.ok(empty.includes('<span class="stack-stamp-num">0</span>'))
  assert.ok(empty.includes(sketchSvg('basket', 'inbox-bin-drawing')))
}

/** On the hub: a card moves from place to place, and the open page hears of it. */
export async function stacksTests({ tool, ask, get, post, STREAM, cardOf, eventually, listen }) {
  stacksUnits()
  const where = async id => {
    const page = await (await get('/t/?pile=done')).text()
    for (const kind of STACKS) {
      const part = new RegExp(`<section class="[^"]*" data-stack="${kind}"[\\s\\S]*?</section>`).exec(page)?.[0] ?? ''
      const line = new RegExp(`data-id="${id}" data-kind="(\\w+)"`).exec(part)
      if (line) return `${kind}:${line[1]}`
    }
    return null
  }
  const numOf = (text, kind) => new RegExp(`data-stamp="${kind}"><span class="stack-stamp-sign" aria-hidden="true"></span><span class="stack-stamp-word">[^<]*</span><span class="stack-stamp-num">(\\d+)</span>`).exec(text)?.[1]
  const rev = /stream\?rev=([0-9a-f]+-\d+)/.exec(await (await get('/t/')).text())[1]
  const desk = listen(`/t/stream?rev=${rev}&view=desk`)
  await eventually(() => desk.heard.length > 0, 'the stream of the stacks test to open')

  const card = await ask('Stapel: vier Zustände')
  assert.equal(await where(card), null)                                   // an open row lies on no stack
  // put off: Later; its stamp counts it, live
  const before = Number(numOf(await (await get('/t/')).text(), 'later'))
  let mark = desk.heard.length
  assert.equal((await post(`/t/cards/${card}/snooze`, { stay: '1' }, STREAM)).status, 200)
  assert.equal(await where(card), 'later:later')
  await eventually(() => /<turbo-stream action="replace" target="desk-stacks">/.test(desk.since(mark)), 'the stacks to follow a snooze')
  assert.equal(Number(numOf(desk.since(mark), 'later')), before + 1)
  assert.equal(numOf(desk.since(mark), "later"), String(before + 1))
  assert.equal((await post(`/t/cards/${card}/wake`, { stay: '1' }, STREAM)).status, 200)
  assert.equal(await where(card), null)
  // handed back: In the works, as a card in revision; taken back, it is a row again
  assert.equal((await post(`/t/cards/${card}/revise`, { stay: '1', note: 'bitte kürzer' }, STREAM)).status, 200)
  assert.equal(await where(card), 'works:asked')
  assert.equal((await post(`/t/cards/${card}/takeback`, { stay: '1' }, STREAM)).status, 200)
  assert.equal(await where(card), null)
  // answered: In the works until its session closes it, then Done
  assert.equal((await post(`/t/cards/${card}/decide`, { stay: '1', key: 'a' }, STREAM)).status, 200)
  assert.equal((await cardOf(card)).status, 'decided')
  assert.equal(await where(card), 'works:answered')
  mark = desk.heard.length
  await tool('close_card', { card_id: card, summary: 'erledigt' })
  assert.equal(await where(card), 'done:answered')
  await eventually(() => /<turbo-stream action="replace" target="desk-stacks">/.test(desk.since(mark)), 'the stacks to follow the session closing a card')
  // taken back from Done, then shredded: the basket, with the way back
  assert.equal((await post(`/t/cards/${card}/reopen`, { stay: '1' }, STREAM)).status, 200)
  assert.equal(await where(card), null)
  assert.equal((await post(`/t/cards/${card}/shred`, { stay: '1' }, STREAM)).status, 200)
  assert.equal(await where(card), 'trash:shredded')
  assert.equal((await post(`/t/cards/${card}/reopen`, { stay: '1' }, STREAM)).status, 200)
  assert.equal((await cardOf(card)).status, 'open')
  // withdrawn by its session: the basket, and nothing takes it back
  await tool('withdraw_card', { card_id: card, reason: 'nicht mehr nötig' })
  assert.equal(await where(card), 'trash:withdrawn')
  const page = await (await get('/t/')).text()
  assert.ok(!page.includes(`/t/cards/${card}/reopen`))
  // the search's own address: the Desk with that stack open, only the sheets that have the words
  const found = await (await get(`/t/stacks/trash?q=${encodeURIComponent('Stapel vier')}`)).text()
  assert.match(found, new RegExp(`<turbo-frame id="stack-list-trash" class="stack-list"[^>]*><div class="inbox-pile-item"><article[^>]*data-id="${card}" data-kind="withdrawn"`))
  assert.match(found, /value="Stapel vier"/)
  assert.ok((await (await get('/t/stacks/trash?q=nichtdabei')).text()).includes('stack-search-none'))
  assert.ok(!(await (await get('/t/stacks/memos')).text()).includes('stack-list-memos'))
  assert.ok(!/data-stack="memos"|>Memos</.test(page), 'no Memos stack on the Desk')
}
