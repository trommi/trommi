// The foot of the Desk: his notes ("Notes": every note not sent yet; a new note lies here, plain, until he sends it),
// then one place per state a card can be in once it left the open rows: "Later", "In the works", "Done" and the
// waste-paper basket ("Trash").
//
// Which card lies where (stackOf below; the hub's card fields decide, nothing else):
//   later   status "open" and snoozed_until set: he put it off; "Wake up" fetches it back
//   works   status "open" and with_agent set (handed back by Revise or What??; it returns by itself; "Take back"),
//           or status "decided" while it is really with its session: answered within ACTING_MS and the session is
//           online (it acts on the answer and has not closed it yet; "Take back")
//   done    status "decided" but older than ACTING_MS or its session is offline (its line says "not closed by the
//           agent"), and status "done" with an answer of his (choice, or trusted), or an info he read; "Take back"
//   trash   status "shredded" (he threw it away; "Take back" fishes it out), or status "done" without an answer
//           of his (its session withdrew it; the hub takes nothing back there, so the line has no way back)
// A permission card is never listed (the hub closes it by itself). The newest lies on top of each.
//
// The look (card Nr. 198, his pick c): no big stacks of paper. The four places are small stamped tabs in one line
// under the cards (two rows on a phone): the stamp's sign (the basket for the bin), its word and the count, in the
// stamp's ink; the gear of "Working" turns while it holds something. A click opens that place's list right below the
// tabs (the controller "piles": one open at a time, Escape closes), with its search and its ways back. Markup per tab:
//   <section class="inbox-stack inbox-pile …" data-stack="later|works|done|trash" data-pile="…">
//     <h3 class="inbox-stack-title"><button class="inbox-stack-head inbox-pile-head …" aria-label="Later, 5 cards">
//       <span class="stack-stamp stack-tab-stamp" data-stamp="later"><span class="stack-stamp-sign"></span>
//       <span class="stack-stamp-word">Snooze</span><span class="stack-stamp-num">5</span></span></button></h3>
//     <div class="inbox-pile-sheets"> the search, then the lines in <turbo-frame id="stack-list-later"> </div></section>
// An empty place is a faint tab that cannot be pressed (.inbox-stack.is-empty). Look: css/piles.css, css/stamps.css.
import { html, raw } from './html.mjs'
import { WORDS, cardNr, plain, advisedLabels, agoSpan } from './text.mjs'
import { smallMark } from './sidebar.mjs'
import { crownOf } from './memo.mjs'
import { deskMain } from './desk.mjs'   // (the search's page without script: the Desk; a cycle, used only at call time)
import { sketchSvg, ringSvg } from '../pen.js'

const FAN_MAX = 8      // a fanned stack shows so many of the newest sheets, then "N more"
const OPEN_MAX = 200   // an open stack (?pile=) or a search shows at most so many; the rest are found by searching
export const STACKS = ['notes', 'later', 'works', 'done', 'trash']
const STRAIGHT = true    // the tabs without any tilt (css/piles.css .is-straight); decided "gerade" on card 205
export const STAMPS = { notes: 'Notes', later: 'Snooze', works: 'Working', done: 'Done', trash: 'Trash' }   // line 1 of each stack's stamp; line 2 is its sign (css/stamps.css: three Z, gear, tick) and the number
const sk = name => raw(sketchSvg(name))
const cardPath = (card, base) => `${base}/q/${encodeURIComponent(card.number ?? card.id)}`
const answeredBy = c => (c.kind === 'decision' && (c.choice != null || c.trusted)) || (c.kind === 'info' && Boolean(c.read))

/** The place a card lies at the foot of the Desk: 'later' | 'works' | 'done' | 'trash', or null (it is an open row, or never listed). */
export const ACTING_MS = 6 * 60 * 60 * 1000   // an answered card counts as worked on by its session for so long
/** ctx: { now, online(agentId) }: the time, and whether a session is online (both only for a "decided" card). */
export function stackOf(card, { now = Date.now(), online = () => true } = {}) {
  if (card.kind === 'permission') return card.status === 'open' && card.snoozed_until ? 'later' : null
  if (card.status === 'open') return card.snoozed_until ? 'later' : card.with_agent ? 'works' : null
  if (card.status === 'shredded') return 'trash'
  if (card.status === 'decided') return !answeredBy(card) ? null : now - (card.decided ?? 0) < ACTING_MS && online(card.agent) ? 'works' : 'done'
  if (card.status === 'done') return answeredBy(card) ? 'done' : 'trash'
  return null
}

/** The four places with their cards, the newest first: { later, revising, acting, done, trash }. */
export function stackCards(model) {
  const { state, desks, desk, byAgent } = model
  // (The desk in view: the model's rule. A card of a session of another desk lies on that desk's stacks.)
  const deskOf = a => (desks.some(d => d.id === a?.desk) ? a.desk : desks[0].id)
  const mine = c => !desks.length || deskOf(byAgent.get(c.agent)) === desk
  const newest = (cards, at) => [...cards].sort((a, b) => (at(b) ?? 0) - (at(a) ?? 0))
  const closed = state.cards.filter(c => c.status !== 'open' && mine(c))
  const ctx = { now: Date.now(), online: id => Boolean(byAgent.get(id)?.online) }
  return {
    later: model.snoozed.filter(c => stackOf(c, ctx) === 'later'),
    revising: model.revising.filter(c => stackOf(c, ctx) === 'works'),
    acting: newest(closed.filter(c => c.status === 'decided' && stackOf(c, ctx) === 'works'), c => c.decided),
    done: newest(closed.filter(c => stackOf(c, ctx) === 'done'), c => c.decided),
    trash: newest(closed.filter(c => stackOf(c, ctx) === 'trash'), c => (c.status === 'shredded' ? c.shredded : c.created)),
  }
}

/** How many cards lie in each place: { later, works, done, trash }. Every place that counts them uses this (the tabs,
 *  the Desk's heading "Desk is clear. 7 working · 2 snoozed"), so the numbers agree. */
export function stackCounts(model) {
  const c = stackCards(model)
  return { later: c.later.length, works: c.revising.length + c.acting.length, done: c.done.length, trash: c.trash.length }
}

// ---- a line on one of the places: one sheet of a fan ----
// kind: why it lies there: 'later' | 'asked' (in revision) | 'answered' | 'shredded' | 'withdrawn'.
function line(card, kind, said, model, base) {
  const sender = model.byAgent.get(card.agent)
  const since = kind === 'asked' ? card.with_agent : kind === 'later' ? card.snoozed_at : kind === 'shredded' ? card.shredded : kind === 'withdrawn' ? null : card.decided
  const word = kind === 'later' ? WORDS.wake : WORDS.takeBack
  const way = kind === 'asked' ? 'takeback' : kind === 'later' ? 'wake' : 'reopen'
  const tip = kind === 'asked' ? 'Take it back: the session need not rework it' : kind === 'later' ? `${WORDS.wake}: fetch this question back` : 'Take back: the question is open again'
  const mark = kind === 'asked' ? html`${sk('reverse')}${raw(ringSvg({ drop: true }))}` : sk(kind === 'later' ? 'snooze' : kind === 'shredded' || kind === 'withdrawn' ? 'bin' : 'tick')
  return html`<div class="inbox-pile-item"><article class="inbox-done inbox-revising-row" tabindex="-1" data-id="${card.id}" data-kind="${kind}"${kind === 'later' ? raw(' data-later') : ''}>
<a class="inbox-revising-open" data-nav href="${cardPath(card, base)}" title="${cardNr(card)}: open it">${mark}<strong>${card.title}</strong>${said ? html`<span class="inbox-revising-sent">${said}</span>` : ''}</a>
<span class="inbox-revising-tail">${sender ? html`${smallMark(sender)}<span class="inbox-stack-who">${sender.name}</span>` : ''}${since ? agoSpan(since) : ''}</span>
${kind === 'withdrawn' ? '' : html`<form method="post" action="${base}/cards/${card.id}/${way}"><input type="hidden" name="stay" value="1"><button class="inbox-takeback inbox-revising-take" type="submit" title="${tip}" aria-label="${word}: ${card.title}">${word}</button></form>`}
</article></div>`
}

// The waste-paper basket: drawn with the pen (sketch 'basket' of the shared module); with something in it a crumpled
// sheet looks over its rim ('basket-full').
const basketSvg = n => sketchSvg(n ? 'basket-full' : 'basket', 'inbox-bin-drawing')

// ---- a line on the Notes stack: one of his notes, not sent yet ----
// The note's words (a click opens it to write on: POST /memos/<id>/open), when it was last written, and its ways:
// send it to a session (the crown first; POST /memos/<id>/send with to=<session>) and throw it away (…/bin). Plain
// yellow paper, no tape: the tape is what a note gets once it is sent and stuck into the conversation (views/session.mjs).
const noteWords = m => m.text.trim().replace(/\s+/g, ' ') || (m.attachments?.length ? `${m.attachments.length} attached` : 'Empty note')
function noteLine(memo, model, base) {
  const act = what => `${base}/memos/${memo.id}/${what}`
  // (its own session first when it was written on a session's page, else the crown; then every session of the desk)
  const first = (memo.session && model.agents.find(a => a.id === memo.session)) || crownOf(model)
  const to = [...(first ? [first] : []), ...model.agents.filter(a => a !== first)]
  const words = noteWords(memo)
  return html`<div class="inbox-pile-item is-note"><article class="inbox-done note-line" tabindex="-1" data-id="${memo.id}" data-kind="note">
<form class="note-open-form" method="post" action="${act('open')}"><button class="inbox-revising-open note-open" type="submit" title="Open the note to write on it">${sk('page')}<strong>${words}</strong></button></form>
<span class="inbox-revising-tail">${memo.updated ? agoSpan(memo.updated) : ''}</span>
${to.length ? html`<form class="note-send" method="post" action="${act('send')}"><label class="note-to" title="Send to"><span class="sr-only">Send to</span><select name="to" aria-label="Send the note to">${to.map(a => html`<option value="${a.id}">${a.name}${a.starred ? ' (crown)' : ''}</option>`)}</select></label><button class="inbox-takeback note-send-go" type="submit" aria-label="Send: ${words.slice(0, 60)}">Send</button></form>` : ''}
<form method="post" action="${act('bin')}"><button class="inbox-takeback note-bin" type="submit" title="Throw the note away" aria-label="Throw away: ${words.slice(0, 60)}">Delete</button></form>
</article></div>`
}

/** The notes on the Notes stack: every note of the desk that is not out on the page and not on its way, newest first. */
export const deskNotes = model => (model.state.memos ?? []).filter(m => m.place !== 'float' && !m.held && (!m.desk || !model.desk || m.desk === model.desk)).sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))

/** The fan of a stack: a search field over its sheets (a GET into the frame, js controller "stack-search"; without
 *  script a plain form that shows the Desk with this stack open and searched), then the sheets in a frame: the newest
 *  eight and "N more", or, while words are searched for, every sheet that has them, or one quiet line. */
function stackFan(pile, base, q, hits, cap) {
  const n = pile.lines.length, frame = `stack-list-${pile.kind}`
  // (Beyond OPEN_MAX a line says how many more there are: the search above finds every one of them.)
  const rest = k => html`<p class="stack-search-none">${k.toLocaleString('en-GB')} more: search to find them.</p>`
  const list = hits ? (hits.length ? html`${hits.slice(0, OPEN_MAX).map(l => l())}${hits.length > OPEN_MAX ? rest(hits.length - OPEN_MAX) : ''}` : html`<p class="stack-search-none">Nothing here has these words.</p>`)
    : html`${pile.lines.slice(0, cap).map(l => l())}${n > cap ? (cap < OPEN_MAX ? html`<a class="inbox-pile-item inbox-stack-more" data-nav href="${base}/?pile=${pile.kind}" title="Show all of them">${n - cap} more</a>` : rest(n - cap)) : ''}`
  const fresh = pile.notes ? html`<form class="note-new" method="post" action="${base}/memos"><input type="hidden" name="place" value="float"><button class="inbox-takeback note-new-go" type="submit" title="Write a new note">+ New note</button></form>` : ''
  return html`<div class="inbox-pile-sheets">${fresh}${n ? html`<form class="stack-search" method="get" action="${base}/stacks/${pile.kind}" role="search" data-turbo-frame="${frame}" data-controller="stack-search" data-stack-search-kind-value="${pile.kind}" data-action="input->stack-search#typed keydown.esc->stack-search#clear"><label>${sk('search')}<input type="search" name="q" value="${q}" placeholder="Search ${pile.bin ? 'the basket' : `“${pile.word}”`}" aria-label="Search ${pile.word}" autocomplete="off" spellcheck="false" data-stack-search-target="field"></label></form>` : ''}<turbo-frame id="${frame}" class="stack-list" data-stack-search-frame="${pile.kind}">${list}</turbo-frame></div>`
}

/** The places at the foot of the Desk (#desk-stacks). open: the one that stands fanned out with all its sheets
 *  ('later' | 'works' | 'done' | 'trash'), from ?pile=. q: words searched for in the open one (title, session's name,
 *  the grey line: answer, last word, why). All four always stand, an empty one faint: nothing shifts when a card arrives. */
export function deskStacks(model, base, open = null, q = '') {
  const { state } = model
  const cards = stackCards(model)
  const ctx = { now: Date.now(), online: id => Boolean(model.byAgent.get(id)?.online) }
  // (The last word of each card, from one pass over the messages, made only when a line in the works is drawn.)
  let words = null
  const lastWord = c => {
    if (!words) { words = new Map(); for (const m of state.messages) if (m.card_id && m.from !== 'event' && m.text) words.set(m.card_id, m) }
    const last = words.get(c.id)
    return last ? plain(`${last.from === 'user' ? 'You: ' : ''}${last.text}`, state.assets).slice(0, 220) : ''
  }
  const until = c => (c.snoozed_until ? `Until ${new Date(c.snoozed_until).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : '')
  const answerOf = c => { if (c.kind === 'info') return 'Read'; if (c.trusted) return `${WORDS.trust}${advisedLabels(c) ? `: ${advisedLabels(c)}` : ''}`; const picked = c.choices?.length ? c.choices : [c.choice]; return c.options.filter(o => picked.includes(o.key)).map(o => o.label).join(', ') || String(c.choice) }
  // A sheet: the card, why it lies there, its grey line. (An info he read he closed himself: only "Read".)
  // A sheet's grey line is worked out only when the sheet is drawn or searched (a Done stack can hold thousands).
  const sheet = (card, kind, say) => { let said = null; return { card, kind, get said() { return (said ??= say()) } } }
  const answered = c => sheet(c, 'answered', () => `${answerOf(c)}${c.status === 'done' && c.kind !== 'info' ? ' · done by the agent' : c.status === 'decided' && stackOf(c, ctx) === 'done' ? ' · not closed by the agent' : ''}`)
  const thrown = c => (c.status === 'shredded' ? sheet(c, 'shredded', () => 'Shredded') : sheet(c, 'withdrawn', () => `Withdrawn${c.summary ? `: ${plain(c.summary, state.assets).slice(0, 220)}` : ''}`))
  const piles = [
    { kind: 'notes', word: 'Notes', notes: true, sheets: deskNotes(model).map(m => ({ card: { title: noteWords(m), agent: null }, memo: m, kind: 'note', said: '' })) },
    { kind: 'later', word: 'Later', sheets: cards.later.map(c => sheet(c, 'later', () => until(c))) },
    { kind: 'works', word: 'In the works', sheets: [...cards.revising.map(c => sheet(c, 'asked', () => lastWord(c))), ...cards.acting.map(answered)] },
    { kind: 'done', also: 'answered', word: 'Done', sheets: cards.done.map(answered) },
    { kind: 'trash', word: 'Trash', bin: true, sheets: cards.trash.map(thrown) },
  ]
  const terms = String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const found = sheet => { const text = `${sheet.card.title} ${model.byAgent.get(sheet.card.agent)?.name ?? ''} ${sheet.said}`.toLowerCase(); return terms.every(w => text.includes(w)) }
  return html`<div class="inbox-stacks stack-tabs${STRAIGHT ? ' is-straight' : ''}" id="desk-stacks" data-controller="piles" data-action="keydown.esc->piles#shut">${piles.map((pile, at) => {
    const draw = sheet => () => (sheet.memo ? noteLine(sheet.memo, model, base) : line(sheet.card, sheet.kind, sheet.said, model, base))
    pile.lines = pile.sheets.map(draw)
    const n = pile.lines.length, names = [pile.kind, ...(pile.also ? [pile.also] : [])]
    const stands = n > 0 && open === pile.kind
    const cap = stands ? OPEN_MAX : FAN_MAX
    const cls = `${n ? `inbox-stack inbox-group inbox-pile ${names.map(k => `inbox-group-${k}`).join(' ')}${stands ? ' is-open' : ''}` : 'inbox-stack is-empty'}${pile.bin ? ' inbox-bin' : ''}`
    const title = pile.bin ? `${pile.word}: show what is in it` : pile.notes ? 'Your notes: open the stack' : 'Fan the stack out'
    // On a stack the stamp carries the count; the basket has it as a small number.
    // A small tab, stamped: the sign (the basket for the bin), the word and the count, in the stamp's ink (card Nr. 198: c).
    const tab = html`<span class="stack-stamp stack-tab-stamp" data-stamp="${pile.kind}">${pile.bin ? html`<span class="stack-tab-bin" aria-hidden="true">${raw(basketSvg(n))}</span>` : raw('<span class="stack-stamp-sign" aria-hidden="true"></span>')}<span class="stack-stamp-word">${STAMPS[pile.kind] ?? pile.word}</span><span class="stack-stamp-num">${n}</span></span>`
    const unit = pile.notes ? 'note' : 'card'
    const name = `${pile.word}, ${n === 1 ? `1 ${unit}` : `${n} ${unit}s`}`
    return html`<section class="${cls}" data-stack="${pile.kind}"${n ? html` data-pile="${pile.kind}" data-piles-target="pile"` : html` data-pile-empty="${pile.kind}"`} style="--at:${at}">
<h3 class="inbox-stack-title"><button class="${n ? `inbox-stack-head inbox-pile-head ${names.map(k => `inbox-${k}-toggle`).join(' ')}` : 'inbox-stack-head'}" type="button" aria-label="${name}"${n ? html` aria-expanded="${String(stands)}" title="${title}" data-action="click->piles#toggle"` : raw(' disabled')}>${tab}</button></h3>
${stackFan(pile, base, stands ? q : '', stands && terms.length ? pile.sheets.filter(found).map(draw) : null, cap)}
</section>`
  })}</div>`
}

/** The search of a stack: GET <base>/stacks/<kind>?q=… The Desk with that stack open and searched (a Turbo Frame takes
 *  only its list from it; without script it is the page). */
export function register(t) {
  t.get(/^\/stacks\/(notes|later|works|done|trash)$/, ({ req, res, url, match }) => {
    const m = t.model(), q = String(url.searchParams.get('q') ?? '').trim().slice(0, 120)
    const n = m.fresh.length
    t.page(req, res, { model: m, title: n ? `(${n}) ${m.deskName} · Trommi` : `${m.deskName} · Trommi`, view: 'desk', main: deskMain(m, t.BASE, { pile: match[1], q }) })
  })
}
