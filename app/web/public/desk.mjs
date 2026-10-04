// The Desk: every open question as a row, in the hub's fixed order, and the stacks at its foot
// (Later, Memos, Done). The markup is the one css/app.css, css/piles.css and css/phone-desk.css style
// (the old client built it in js/inbox.js and js/piles.js). A row never unfolds: its text is a link to
// the card's own page, its tiles are forms that answer with one tap.

import { BASE, crownOf, stream } from './app.mjs'
import { Controller, PLUS, WORDS, act, advisedLabels, agoSpan, calm, cardNr, controller, deskRow, el, galleryItems, html, isKnock, mediaPreview, mq, plain, raw, ringSvg, runSection, sk, sketchSvg, smallMark } from './ui.mjs'

// ---- the news: the infos (reports, notes; nothing to decide), out of the stack of questions ----
// (Christopher's pick "6" of ten, 4 October: bare lines, a box to tick on the left and the info's title, nothing else:
// no title over them, no count, no sender, no time, no "All read". Three lines, then "N more" that unfolds. With
// questions waiting they stand right above "Next"; on a clear Desk under the small "Clear" heading, which this block
// carries itself, so the order holds when the live stream replaces it. Its id stays for the stream: #desk-news.)
const NEWS_SHOWN = 3
function newsLine(card, base) {
  const knock = isKnock(card)
  return html`<li class="news-line" id="read-${card.id}" data-id="${card.id}"${knock ? raw(' data-knock') : ''}>
<form class="news-act" method="post" action="${act(card, base, 'close')}"><input type="hidden" name="stay" value="1"><button class="news-tick" type="submit" title="Read: put it away" aria-label="Read: ${card.title}">${sk('tick')}</button></form>
<a class="news-open" data-nav href="${cardPath(card, base)}" title="${cardNr(card)}: open it">${card.title}</a>
</li>`
}
/** The Desk is clear (sessions there, no question waiting): "Clear", and the sessions at work as a pill with the ring. */
const isClear = model => !model.fresh.length && model.units.length > 0
function clearHead(model) {
  const n = model.working
  return html`<header class="news-clear"><h2>${sk('tick', 'news-clear-tick')}Clear</h2>${n ? html`<span class="news-working" title="${n === 1 ? '1 session is' : `${n} sessions are`} at work">${raw(ringSvg({ drop: true }))}${n} working</span>` : ''}</header>`
}
function newsStrip(model, base) {
  const r = model.reads ?? [], clear = isClear(model)
  if (!r.length && !clear) return html`<div id="desk-news" class="news-at" hidden></div>`
  const shown = r.slice(0, NEWS_SHOWN), rest = r.slice(NEWS_SHOWN)
  return html`<div id="desk-news" class="news-at${clear ? ' is-clear' : ''}">${clear ? clearHead(model) : ''}${r.length ? html`<ul class="news-list" aria-label="News: ${r.length === 1 ? '1 info' : `${r.length} infos`}, nothing to decide">
${shown.map(c => newsLine(c, base))}${rest.length ? html`<li class="news-rest"><details class="news-more"><summary><span class="news-more-open">${rest.length} more</span><span class="news-more-shut">Less</span></summary><ul class="news-list">${rest.map(c => newsLine(c, base))}</ul></details></li>` : ''}</ul>` : ''}</div>`
}


/** The heading: "Next, please" with the number of what waits, the way into the walk; or that the Desk is clear. */
function deskHead(model, base) {
  const n = model.fresh.length
  if (n) return html`<header class="inbox-head" id="desk-head" data-controller="title" data-title-count-value="${n}"><div class="inbox-title">${nextPlease(model, base)}</div></header>`
  if (!model.units.length) return deskInvite()
  // (Clear: the heading "Clear" with the sessions at work stands in #desk-news, above the news: newsStrip.)
  return html`<header class="inbox-head" id="desk-head" data-controller="title" data-title-count-value="0" hidden></header>`
}

/** The Desk of a new account (no session yet): a calm note with one way on, inviting the first agent. The button sends
 *  the form the Devices page sends (POST /pair, role agent; room.mjs), so the same invite page with the link follows.
 *  It stands in the heading (#desk-head), which the live stream replaces: the note goes once a session is there. */
const deskInvite = () => html`<header class="inbox-head" id="desk-head" data-controller="title" data-title-count-value="0"><section class="desk-invite" id="desk-invite" aria-labelledby="desk-invite-title">
${sk('heads', 'desk-invite-art')}<h2 id="desk-invite-title">Invite your first agent</h2>
<p>You get one command for any computer with Claude Code: run it in the project folder, then start Claude Code there with plain <code>claude</code>. Its questions land here.</p>
<form method="post" action="/pair"><input type="hidden" name="role" value="agent"><button type="submit" class="desk-invite-go" id="desk-invite-go">${PLUS}<span>Invite an agent</span></button></form>
</section></header>`

/** The rows as runs: cards of one session that follow each other stand in one section. Returns [{ sender, cards }]. */
function runs(model) {
  const groups = []
  for (const card of model.fresh) {
    const sender = model.byAgent.get(card.agent)
    if (!sender) continue
    if (groups.at(-1)?.sender === sender) groups.at(-1).cards.push(card)
    else groups.push({ sender, cards: [card] })
  }
  return groups
}

/** Everything inside .inbox-groups (#desk-list). rowOf(card): the row's markup (the stream keeps what it rendered). */
function deskList(model, base, { pile = null, q = '', rowOf = card => deskRow(card, model, base) } = {}) {
  return html`${runs(model).map(({ sender, cards }) => runSection(sender, cards.map(rowOf), cards.length))}
${deskStacks(model, base, pile, q)}
${model.open.length ? '' : html`<div class="inbox-empty">${sk('desk')}<p>As soon as an agent has a question, it shows up here.</p></div>`}`
}

/** The Desk's <main>. */
// (Controller "desk": a card that arrives out of sight is said quietly, "1 new ↓"; a knock out of sight has a strip at
//  the list's edge that leads to it.)
const deskMain = (model, base, opts = {}) => html`<main id="inbox" aria-label="Desk" data-controller="desk" data-action="turbo:before-stream-render@document->desk#changing">
${newsStrip(model, base)}${deskHead(model, base)}
<div class="inbox-news-at"><button class="inbox-news" type="button" data-desk-target="news" data-action="desk#toNew" hidden></button></div>
<div class="inbox-groups" id="desk-list" data-desk-target="list">${deskList(model, base, opts)}</div>
<div class="inbox-edge is-up"><button class="inbox-edge-knock" type="button" data-desk-target="up" data-action="desk#toKnock" data-dir="up" hidden>↑ ${sk('knock')}<span></span></button></div>
<div class="inbox-edge is-down"><button class="inbox-edge-knock" type="button" data-desk-target="down" data-action="desk#toKnock" data-dir="down" hidden>↓ ${sk('knock')}<span></span></button></div>
</main>`

// ---- nextplease ----
// "Next" above the Desk: one small plain sentence, "Next 3 →", that leads into the walk through every open question.
// (It was an index-card divider tab with the next cards peeking behind it, card Nr. 166; Christopher asked on
// 3 October for a plain line of text instead: no tab, no card shape.) css/turbo.css styles it (.inbox-next).

/** The line for n > 0 open cards (model.fresh, in the hub's order): a link to the walk. */
function nextPlease(model, base) {
  const n = model.fresh.length
  return html`<p class="inbox-heading inbox-next"><a class="inbox-walk inbox-go" data-nav href="${base}/walk" title="${WORDS.walk}: every open question, one after the other (G F)" aria-label="${WORDS.walk}: ${n === 1 ? '1 open question' : `${n} open questions`}" aria-keyshortcuts="G F"><span>${WORDS.walk}</span><b class="inbox-next-n">${n}</b>${raw(sketchSvg('go'))}</a></p>`
}

/** The sheet a long press on a Desk row brings up on a phone (css/phone-desk.css, dialog.rowmenu): one form, each way its own
 *  button. The hub renders it once per Desk; the controller t/controllers/sheet_controller.js points it at the row that was held. */
export function rowSheet(base) {
  const way = (name, drawing, word, cls = '', tip = '') => html`<button type="submit" data-way="${name}"${cls ? html` class="${cls}"` : ''}${tip ? html` title="${tip}" aria-label="${tip}"` : ''}>${sk(drawing)}${tip ? '' : html`<span>${word}</span>`}</button>`
  return html`<dialog class="rowmenu" id="row-sheet" data-controller="sheet" data-sheet-cards-value="${base}/cards" data-action="click->sheet#tapped turbo:submit-start->sheet#sent" aria-labelledby="row-sheet-title"><div class="rowmenu-in">
<h3 id="row-sheet-title"></h3>
<form method="post" id="row-sheet-form"><input type="hidden" name="stay" value="1">
${way('snooze', 'snooze', WORDS.later)}${way('revise', 'reverse', WORDS.revise)}${way('trust', 'duck', WORDS.trust)}${way('what', 'what', WORDS.what, '', 'What?? — explain this to me')}${way('shred', 'bin', WORDS.shred, 'is-shred')}</form>
<a class="rowmenu-open" data-nav draggable="false" href="${base}/">${sk('page')}<span>Open</span></a>
</div></dialog>`
}

// ---- stacks ----
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
// The look (his pick "A, gefächerter Papierstapel", 4 October; it replaced the four tabs of card Nr. 198): Notes is a small
// stamped tab first in the row (the controller "piles": a click opens its list right below the row, one open at a time,
// Escape closes). Beside it ONE pile, "Off the desk N", for everything that left the open rows: the newest five sheets
// lie fanned on top of each other, each with the sign of its place (three Z, the gear, the tick, the basket), its title
// and when. A click unfolds the pile (the same controller): filter chips with counts (All · Snoozed · Working · Done ·
// Trash; radio buttons, CSS shows the lines of the checked one), the search, the newest ten lines and "N more". Each
// line has its way back (Wake up, Take back). Markup:
//   <section class="inbox-stack inbox-pile off-pile" data-stack="off" data-pile="off">
//     <h3 class="inbox-stack-title"><button class="inbox-stack-head inbox-pile-head off-head" aria-label="Off the desk, 51 cards">
//       <span class="off-label">Off the desk <b class="off-count">51</b></span><span class="off-fan"> five .off-sheet </span></button></h3>
//     <div class="inbox-pile-sheets off-body"> chips, the search, the lines in <turbo-frame id="stack-list-off"> </div></section>
// An empty pile is a faint label over one dashed sheet that cannot be pressed. Look: css/piles.css, css/stamps.css.

const FAN_MAX = 8      // a fanned stack shows so many of the newest sheets, then "N more"
const OPEN_MAX = 200   // an open stack (?pile=) or a search shows at most so many; the rest are found by searching
const STACKS = ['notes', 'off']
const STRAIGHT = true    // the tabs without any tilt (css/piles.css .is-straight); decided "gerade" on card 205
const STAMPS = { notes: 'Notes', later: 'Snooze', works: 'Working', done: 'Done', trash: 'Trash' }   // line 1 of each stack's stamp; line 2 is its sign (css/stamps.css: three Z, gear, tick) and the number
const cardPath = (card, base) => `${base}/q/${encodeURIComponent(card.number ?? card.id)}`
const answeredBy = c => (c.kind === 'decision' && (c.choice != null || c.trusted)) || (c.kind === 'info' && Boolean(c.read))

/** The place a card lies at the foot of the Desk: 'later' | 'works' | 'done' | 'trash', or null (it is an open row, or never listed). */
const ACTING_MS = 6 * 60 * 60 * 1000   // an answered card counts as worked on by its session for so long
/** ctx: { now, online(agentId) }: the time, and whether a session is online (both only for a "decided" card). */
function stackOf(card, { now = Date.now(), online = () => true } = {}) {
  if (card.kind === 'permission') return card.status === 'open' && card.snoozed_until ? 'later' : null
  if (card.status === 'open') return card.snoozed_until ? 'later' : card.with_agent ? 'works' : null
  if (card.status === 'shredded') return 'trash'
  if (card.status === 'decided') return !answeredBy(card) ? null : now - (card.decided ?? 0) < ACTING_MS && online(card.agent) ? 'works' : 'done'
  if (card.status === 'done') return answeredBy(card) ? 'done' : 'trash'
  return null
}

/** The four places with their cards, the newest first: { later, revising, acting, done, trash }. */
function stackCards(model) {
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

// ---- a line of the pile: one card that left the open rows ----
// kind: why it lies there: 'later' | 'asked' (in revision) | 'answered' | 'shredded' | 'withdrawn'. g: its place (the sign).
/** The sign of a place, in its stamp's ink (css/stamps.css): three Z, the gear, the tick; the basket for Trash. */
const signOf = g => (g === 'trash' ? html`<span class="off-sign" data-g="trash" aria-hidden="true">${raw(sketchSvg('basket-full'))}</span>` : html`<span class="stack-stamp off-sign" data-stamp="${g}" data-g="${g}" aria-hidden="true"><span class="stack-stamp-sign"></span></span>`)
const PLACE = { later: 'Snoozed', works: 'Working', done: 'Done', trash: 'Trash' }
// A card its session closed (status done, his answer on it) has no way back: the core does not count a decide-again
// there, so a Take back would do nothing. (An info he read he closed himself.)
const closedByAgent = c => c.status === 'done' && c.kind !== 'info'
function line(sheet, model, base, rest = false) {
  const { card, kind, g } = sheet, said = sheet.said
  const sender = model.byAgent.get(card.agent)
  const since = sheet.at
  const word = kind === 'later' ? WORDS.wake : WORDS.takeBack
  const way = kind === 'asked' ? 'takeback' : kind === 'later' ? 'wake' : 'reopen'
  const tip = kind === 'asked' ? 'Take it back: the session need not rework it' : kind === 'later' ? `${WORDS.wake}: fetch this question back` : 'Take back: the question is open again'
  return html`<article class="inbox-done off-line${rest ? ' is-rest' : ''}" tabindex="-1" data-id="${card.id}" data-kind="${kind}" data-g="${g}"${kind === 'later' ? raw(' data-later') : ''}>
${signOf(g)}<a class="inbox-revising-open off-open" data-nav href="${cardPath(card, base)}" title="${cardNr(card)} · ${PLACE[g]}: open it"><strong>${card.title}</strong>${said ? html`<span class="off-said">${said}</span>` : ''}</a>
<span class="off-tail">${sender ? html`${smallMark(sender)}<span class="off-who">${sender.name}</span>` : ''}${since ? agoSpan(since) : ''}</span>
${kind === 'withdrawn' || closedByAgent(card) ? html`<span class="off-way"></span>` : html`<form class="off-way" method="post" action="${base}/cards/${card.id}/${way}"><input type="hidden" name="stay" value="1"><button class="inbox-takeback" type="submit" title="${tip}" aria-label="${word}: ${card.title}">${word}</button></form>`}
</article>`
}


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
const deskNotes = model => (model.state.memos ?? []).filter(m => m.place !== 'float' && !m.held && (!m.desk || !model.desk || m.desk === model.desk)).sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))

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
function deskStacks(model, base, open = null, q = '') {
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
  // When a card went to its place: put off, handed back, answered, thrown away (a withdrawn one: when it came).
  const atOf = (c, kind) => (kind === 'asked' ? c.with_agent : kind === 'later' ? c.snoozed_at : kind === 'shredded' ? c.shredded : kind === 'withdrawn' ? (c.decided ?? c.created) : c.decided) ?? 0
  // A sheet: the card, why it lies there, its grey line. (An info he read he closed himself: only "Read".)
  // A sheet's grey line is worked out only when the sheet is drawn or searched (a Done stack can hold thousands).
  const sheet = (card, kind, say) => { let said = null; return { card, kind, at: atOf(card, kind), get said() { return (said ??= say()) } } }
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
  const notes = piles[0]
  // Notes: the small stamped tab, its list below the row.
  const notesTab = (pile => {
    pile.lines = pile.sheets.map(sheet => () => noteLine(sheet.memo, model, base))
    const n = pile.lines.length, stands = n > 0 && open === 'notes'
    const cls = n ? `inbox-stack inbox-group inbox-pile inbox-group-notes${stands ? ' is-open' : ''}` : 'inbox-stack is-empty'
    const tab = html`<span class="stack-stamp stack-tab-stamp" data-stamp="notes"><span class="stack-stamp-sign" aria-hidden="true"></span><span class="stack-stamp-word">${STAMPS.notes}</span><span class="stack-stamp-num">${n}</span></span>`
    return html`<section class="${cls}" data-stack="notes"${n ? html` data-pile="notes" data-piles-target="pile"` : raw(' data-pile-empty="notes"')} style="--at:0">
<h3 class="inbox-stack-title"><button class="${n ? 'inbox-stack-head inbox-pile-head inbox-notes-toggle' : 'inbox-stack-head'}" type="button" aria-label="Notes, ${n === 1 ? '1 note' : `${n} notes`}"${n ? html` aria-expanded="${String(stands)}" title="Your notes: open the stack" data-action="click->piles#toggle"` : raw(' disabled')}>${tab}</button></h3>
${stackFan(pile, base, stands ? q : '', stands && terms.length ? pile.sheets.filter(found).map(sheet => () => noteLine(sheet.memo, model, base)) : null, stands ? OPEN_MAX : FAN_MAX)}
</section>`
  })(notes)
  // Off the desk: every card of the four places in one pile, the newest first.
  const all = piles.slice(1).flatMap(p => p.sheets.map(s => Object.assign(s, { g: p.kind }))).sort((a, b) => b.at - a.at)
  return html`<div class="inbox-stacks stack-tabs${STRAIGHT ? ' is-straight' : ''}" id="desk-stacks" data-controller="piles" data-action="keydown.esc->piles#shut change->piles#filter">${notesTab}${offPile(all, model, base, open === 'off', terms.length ? all.filter(found) : null, q)}${mediaPile(model, base)}</div>`
}

const FAN = 5        // the pile shows so many sheets fanned
const SHOWN = 10     // the unfolded pile shows so many lines, then "N more"
const FILTERS = [['all', 'All'], ['later', 'Snoozed'], ['works', 'Working'], ['done', 'Done'], ['trash', 'Trash']]
/** The one pile "Off the desk" (his pick A). stands: it stands unfolded (?pile=off). hits: the sheets found by q, or null. */
function offPile(all, model, base, stands, hits, q) {
  const n = all.length
  const count = g => (g === 'all' ? n : all.filter(s => s.g === g).length)
  const name = `Off the desk, ${n === 1 ? '1 card' : `${n} cards`}`
  const fan = html`<span class="off-fan" style="--n:${Math.max(1, Math.min(FAN, n))}" aria-hidden="true">${n ? all.slice(0, FAN).map((s, i) => html`<span class="off-sheet" style="--i:${i}">${signOf(s.g)}<span class="off-t">${s.card.title}</span>${s.at ? agoSpan(s.at) : ''}</span>`) : html`<span class="off-sheet is-blank" style="--i:0"><span class="off-t">Nothing put away yet</span></span>`}</span>`
  const head = html`<h3 class="inbox-stack-title"><button class="${n ? 'inbox-stack-head inbox-pile-head off-head' : 'inbox-stack-head off-head'}" type="button" aria-label="${name}"${n ? html` aria-expanded="${String(stands)}" title="Unfold the pile" data-action="click->piles#toggle"` : raw(' disabled')}><span class="off-label">Off the desk <span class="off-count">${n}</span><span class="off-fold">Fold up ${sk('unfold')}</span></span>${fan}</button></h3>`
  if (!n) return html`<section class="inbox-stack is-empty off-pile" data-stack="off" data-pile-empty="off">${head}</section>`
  const chips = html`<div class="off-chips" role="radiogroup" aria-label="Show">${FILTERS.map(([g, word]) => html`<label class="off-chip" data-g="${g}"><input type="radio" name="off-filter" value="${g}" data-off-filter${g === 'all' ? raw(' checked') : ''}>${g === 'all' ? '' : signOf(g)}<span>${word}</span><b>${count(g)}</b></label>`)}</div>`
  const search = html`<form class="stack-search off-search" method="get" action="${base}/stacks/off" role="search" data-turbo-frame="stack-list-off" data-controller="stack-search" data-stack-search-kind-value="off" data-action="input->stack-search#typed keydown.esc->stack-search#clear"><label>${sk('search')}<input type="search" name="q" value="${q}" placeholder="Search everything off the desk" aria-label="Search everything off the desk" autocomplete="off" spellcheck="false" data-stack-search-target="field"></label></form>`
  const list = hits ? hits : all
  const shown = list.slice(0, OPEN_MAX)
  const beyond = list.length - shown.length
  const rest = hits ? 0 : Math.max(0, shown.length - SHOWN)
  const lines = hits && !hits.length ? html`<p class="stack-search-none">Nothing here has these words.</p>`
    : html`${shown.map((s, i) => line(s, model, base, !hits && i >= SHOWN))}${FILTERS.slice(1).map(([g, word]) => html`<p class="stack-search-none off-none" data-g="${g}">Nothing ${word.toLowerCase()}${hits ? ' has these words' : ''}.</p>`)}${rest ? html`<label class="off-more"><input type="checkbox" data-off-more><span class="off-more-open">${rest} more</span><span class="off-more-shut">Less</span></label>` : ''}${beyond > 0 ? html`<p class="stack-search-none">${beyond.toLocaleString('en-GB')} more: search to find them.</p>` : ''}`
  return html`<section class="inbox-stack inbox-group inbox-pile off-pile${stands ? ' is-open' : ''}" data-stack="off" data-pile="off" data-piles-target="pile">${head}
<div class="inbox-pile-sheets off-body">${chips}${search}<turbo-frame id="stack-list-off" class="stack-list off-list" data-stack-search-frame="off">${lines}</turbo-frame></div></section>`
}


/** The pile "Media N" at the foot of the Desk (in #desk-stacks, beside Notes and "Off the desk"; views/stacks.mjs): the
 *  newest pictures and videos fanned like prints, the newest on top; a click opens the gallery. Without any it is not
 *  there. (Pages and files only, no picture: their drawn kinds lie fanned instead.) */
const MEDIA_FAN = 4
function mediaPile(model, base) {
  const all = galleryItems(model, base)
  if (!all.length) return ''
  const media = all.filter(i => (i.type === 'image' || i.type === 'video') && i.url)
  const fan = (media.length ? media : all).slice(0, MEDIA_FAN)
  const pics = all.filter(i => i.type === 'image').length, vids = all.filter(i => i.type === 'video').length
  const name = `Media, ${all.length === 1 ? '1 thing' : `${all.length} things`}${pics || vids ? ` (${[pics && `${pics} pictures`, vids && `${vids} videos`].filter(Boolean).join(', ')})` : ''}: open the gallery`
  return html`<a class="media-pile" id="desk-media" data-nav href="${base}/assets" aria-label="${name}" title="All pictures, videos and files your agents sent"><span class="off-label">Media <span class="off-count">${all.length}</span></span><span class="media-fan" style="--n:${fan.length}" aria-hidden="true">${fan.map((i, at) => html`<span class="media-sheet" style="--i:${at}">${mediaPreview(i)}</span>`)}</span></a>`
}

// The stacks at the foot of the Desk: a click fans one out, a click gathers it. A stream may replace the stacks;
// the one that stood open stands open again, with the filter and "N more" of the pile "Off the desk" as they were.
let openPile, offFilter = 'all', offMore = false
controller('piles', class extends Controller {
  static targets = ['pile']
  connect() { if (openPile === undefined) openPile = this.pileTargets.find(p => p.classList.contains('is-open'))?.dataset.pile ?? null; this.apply() }
  toggle({ currentTarget }) {
    const pile = currentTarget.closest('[data-pile]')
    openPile = openPile === pile.dataset.pile ? null : pile.dataset.pile
    this.apply()
    if (openPile) pile.querySelector('.inbox-pile-sheets')?.scrollIntoView({ block: 'nearest', behavior: calm() ? 'instant' : 'smooth' })
  }
  // Escape inside the stacks (a tab or a line of the open list) closes the open one; the keyboard goes back to its tab.
  shut(event) {
    if (!openPile || event.defaultPrevented) return
    const head = this.pileTargets.find(p => p.dataset.pile === openPile)?.querySelector('.inbox-pile-head')
    openPile = null
    this.apply()
    event.preventDefault()
    event.stopPropagation()
    head?.focus({ preventScroll: true })
  }
  // A filter chip of "Off the desk" (radio buttons; CSS shows the lines of the checked one), or its "N more".
  filter({ target }) {
    if (target.matches('[data-off-filter]')) offFilter = target.value
    else if (target.matches('[data-off-more]')) offMore = target.checked
  }
  apply() {
    for (const box of this.element.querySelectorAll('[data-off-filter]')) box.checked = box.value === offFilter
    for (const box of this.element.querySelectorAll('[data-off-more]')) box.checked = offMore
    for (const pile of this.pileTargets) {
      const is = pile.dataset.pile === openPile
      pile.classList.toggle('is-open', is)
      pile.querySelector('.inbox-pile-head')?.setAttribute('aria-expanded', String(is))
    }
  }
})

// ---- desk window ----
// The Desk's window: rows beyond the first ones are rendered empty (register: windowed) and filled in here when they come
// within a screen or two of the viewport, a few per frame. A row once filled stays filled.
let io = null, rowMarkup = null
const queue = new Set()
let scheduled = false
function fill() {
  scheduled = false
  let n = 0
  for (const el of queue) {
    queue.delete(el)
    if (!el.isConnected || !el.hasAttribute('data-later')) continue
    const markup = rowMarkup(el.dataset.id)
    if (markup) { const t = document.createElement('template'); t.innerHTML = markup; el.replaceWith(t.content) }
    if (++n >= 6) break
  }
  if (queue.size && !scheduled) { scheduled = true; requestAnimationFrame(fill) }
}
function watch(root = document) {
  for (const el of root.querySelectorAll('.inbox-row[data-later]')) io.observe(el)
}
function startDeskWindow(markupOf) {
  rowMarkup = markupOf
  io = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); queue.add(e.target) }
    if (queue.size && !scheduled) { scheduled = true; requestAnimationFrame(fill) }
  }, { rootMargin: '1000px 0px' })
  document.addEventListener('turbo:load', () => watch())
  new MutationObserver(records => { for (const r of records) for (const n of r.addedNodes) if (n instanceof Element) { if (n.matches('.inbox-row[data-later]')) io.observe(n); else if (n.querySelector?.('.inbox-row[data-later]')) watch(n) } })
    .observe(document.body, { childList: true, subtree: true })
}

// ---- controller "desk" ----
// The Desk's list (views/desk.mjs). "New questions must not move my window": a card that arrives out of
// sight is said quietly ("1 new ↓", a tap goes there), and a knock that is out of sight has one strip at the edge
// of the list it lies beyond ("↓ 1 knock"), which leads to the nearest one.
// Which rows stand in sight is told by an IntersectionObserver; a row out of sight is above or below by its place in
// the list (rows are in order), so scrolling costs nothing and no row is measured while a page is being built.

const knocks = n => (n === 1 ? '1 knock' : `${n} knocks`)
const EDGE = 24   // a row closer than this to the window's edge counts as out of sight
const before = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
controller('desk', class extends Controller {
  static targets = ['list', 'news', 'up', 'down']
  connect() {
    // (A target is looked up on every read; these elements stay for the page's life: kept once.)
    this.list = this.listTarget; this.news = this.newsTarget; this.up = this.upTarget; this.down = this.downTarget
    this.unseen = new Set()      // ids of rows that arrived out of sight
    this.shown = new Set()       // rows in sight now
    this.listAt = 'in'           // the list as a whole: 'in' sight, 'up' (scrolled past) or 'down' (not reached)
    this.io = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (e.target === this.list) { const r = e.boundingClientRect; this.listAt = e.isIntersecting ? 'in' : r.bottom <= EDGE ? 'up' : 'down'; continue }
        if (e.isIntersecting && e.boundingClientRect.height) { this.shown.add(e.target); this.unseen.delete(e.target.id) } else this.shown.delete(e.target)
      }
      this.look()
    }, { rootMargin: `-${EDGE}px 0px` })
    this.io.observe(this.list)
    for (const row of this.list.querySelectorAll('.inbox-row')) this.io.observe(row)
    this.mo = new MutationObserver(records => {
      for (const r of records) {
        for (const node of r.addedNodes) if (node.nodeType === 1) { if (node.matches('.inbox-row')) this.io.observe(node); else if (node.firstElementChild) for (const row of node.querySelectorAll('.inbox-row')) this.io.observe(row) }
        for (const node of r.removedNodes) if (node.nodeType === 1) this.forget(node)
      }
      this.look()
    })
    this.mo.observe(this.list, { childList: true, subtree: true })
    // Where the list stands across, for the strips: read when its box changes (layout is fresh then), never per frame.
    this.ro = new ResizeObserver(() => { this.across = this.list.getBoundingClientRect(); this.look() })
    this.ro.observe(this.list)
  }
  disconnect() { this.io.disconnect(); this.mo.disconnect(); this.ro.disconnect(); cancelAnimationFrame(this.frame) }
  forget(node) { for (const row of this.shown) if (row === node || node.contains(row)) this.shown.delete(row) }

  // A stream is about to put a row in: it is "new" until it has been in sight.
  changing(event) {
    const el = event.target
    if (el.action !== 'before' || el.target !== 'desk-stacks') return
    const id = el.templateContent?.querySelector('.inbox-row')?.id
    if (id) this.unseen.add(id)   // (the observer says at once if it stands in sight, and takes it off)
  }
  /** Where a row out of sight lies: 'up' or 'down' (by its place against the rows in sight, or the list's own). */
  side(row) {
    if (this.shown.has(row)) return 'in'
    if (!this.shown.size) return this.listAt === 'down' ? 'down' : 'up'   // (no row in sight but the list: its foot, the stacks)
    for (const seen of this.shown) return before(row, seen) ? 'up' : 'down'
  }
  // Draw the news line and the two strips, once per frame at most.
  look() {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      for (const row of this.shown) if (!row.isConnected) this.shown.delete(row)
      const fresh = [...this.unseen].map(id => document.getElementById(id)).filter(row => row && !this.shown.has(row))
      this.news.hidden = !fresh.length
      if (fresh.length) { this.news.textContent = `${fresh.length} new ↓`; this.news.setAttribute('aria-label', `${fresh.length} new below: go there`) }
      const beyond = { up: [], down: [] }
      for (const row of this.list.querySelectorAll('.inbox-row[data-knock]')) { const at = this.side(row); if (at !== 'in') beyond[at].push(row) }
      this.beyond = beyond
      for (const [dir, button] of [['up', this.up], ['down', this.down]]) {
        const n = beyond[dir].length
        button.hidden = !n
        if (!n) continue
        button.querySelector('span').textContent = knocks(n)
        button.setAttribute('aria-label', `${knocks(n)} ${dir === 'up' ? 'above' : 'below'}: go there`)
        if (this.across) Object.assign(button.parentElement.style, { left: `${this.across.left}px`, width: `${this.across.width}px`, top: dir === 'up' ? '0px' : '', bottom: dir === 'down' ? '0px' : '' })
      }
    })
  }
  go(row) {
    row.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
    row.animate([{ outline: '3px solid var(--urg-high)', outlineOffset: '3px' }, { outline: '3px solid transparent', outlineOffset: '3px' }], { duration: 1600 })
  }
  toNew() { const row = [...this.unseen].map(id => document.getElementById(id)).find(r => r && !this.shown.has(r)); if (row) this.go(row) }
  toKnock({ currentTarget }) { const list = this.beyond?.[currentTarget.dataset.dir] ?? []; const row = currentTarget.dataset.dir === 'up' ? list.at(-1) : list[0]; if (row) this.go(row) }
})

// ---- controller "stack-search" ----
// The search field over a fanned stack at the foot of the Desk (server/views/stacks.mjs). Typing sends the form a
// moment later: a GET into the stack's Turbo Frame, which the hub answers with the sheets that have the words.
// Escape empties it. The live stream replaces the stacks when a card moves: the words, the keyboard and the caret are
// put back into the new field and the search is sent again, so typing is never lost.

let kept = null   // { kind, q, focus, caret }: the search as it stood when its field left the page

controller('stack-search', class extends Controller {
  static targets = ['field']
  static values = { kind: String }

  connect() {
    const was = kept
    if (!was || was.kind !== this.kindValue || !was.q || this.fieldTarget.value) return
    this.fieldTarget.value = was.q
    if (was.focus) { this.fieldTarget.focus({ preventScroll: true }); try { this.fieldTarget.setSelectionRange(was.caret, was.caret) } catch {} }
    this.send()
  }
  disconnect() {
    clearTimeout(this.timer)
    const field = this.hasFieldTarget ? this.fieldTarget : null
    if (field?.value) kept = { kind: this.kindValue, q: field.value, focus: document.activeElement === field, caret: field.selectionStart ?? field.value.length }
  }
  typed() {
    kept = this.fieldTarget.value ? { kind: this.kindValue, q: this.fieldTarget.value, focus: true, caret: this.fieldTarget.selectionStart } : null
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.send(), 220)
  }
  clear(event) {
    if (!this.fieldTarget.value) return   // (an empty field leaves Escape to the stack: it gathers)
    event.preventDefault()
    event.stopPropagation()
    this.fieldTarget.value = ''
    kept = null
    this.send()
  }
  send() { if (this.element.isConnected) this.element.requestSubmit() }
})

// ---- controller "sheet" ----
// A phone: the ways out of a Desk row behind a long press (css/phone-desk.css). The row shows who asks, the
// title and the answers; Snooze, Revise, Whatever, What??, Shred and Open come up as a sheet after a long press
// on the row, or a right click. The sheet is the hub's (views/menu.mjs, rowSheet): one form whose buttons
// are pointed at the row that was held. No veil; Escape, a tap beside it or focus leaving it closes. The finger
// that held does not open the link under it, and selects no text (the stylesheet takes selection and the callout
// off the row).
// The dialog is opened with show(), not showModal(): a modal dialog makes the whole page inert, and on a phone
// with a full Desk that costs a style recalculation of every element when it opens and again when it closes
// (60-90 ms each at 4x CPU, measured). What modal gave us is done here: a tap beside the sheet only closes it.

const PHONE = mq('(max-width: 860px)')
const HOLD_MS = 450
const HOLD_SLOP = 10   // px a finger may wander and still be holding
// Which ways a row has: the ones the hub put on it as buttons (a permission has neither Revise nor Shred).
const HAS = { snooze: '.inbox-later', revise: '.inbox-revise', trust: '.inbox-trust', what: '.inbox-revise', shred: '.inbox-shred' }
const rowOf = e => (e.target instanceof Element && !e.target.closest('.inbox-actions') ? e.target.closest('#desk-list .inbox-row') : null)

controller('sheet', class extends Controller {
  static values = { cards: String }

  connect() {
    this.stop = new AbortController()
    this.held = false    // a long press opened the sheet: the click that follows the lift is no tap
    this.armed = false   // nothing on the sheet acts before the finger that held is gone
    this.scrolled = { at: 0, node: null }   // the last scroll anywhere: a finger that scrolls, or stops a scroll, is not holding
    const s = this.element
    const on = (target, name, fn, opts = {}) => target.addEventListener(name, fn, { signal: this.stop.signal, ...opts })
    const beside = e => s.open && !s.contains(e.target)
    on(window, 'scroll', e => { this.scrolled = { at: performance.now(), node: e.target } }, { capture: true, passive: true })
    on(document, 'pointerdown', e => this.down(e))
    on(document, 'pointermove', e => { if (this.timer && Math.hypot(e.clientX - this.x0, e.clientY - this.y0) > HOLD_SLOP) this.drop() })
    for (const name of ['pointerup', 'pointercancel']) on(document, name, () => this.drop())
    // The sheet comes up under the finger that is still down. Its lift is no tap: the sheet is armed a moment after it, or by the next finger.
    for (const name of ['pointerup', 'pointercancel', 'pointerdown']) on(window, name, e => { if (!s.open) return; if (e.type === 'pointerdown') this.armed = true; else setTimeout(() => { this.armed = true }, 300) }, { capture: true })
    on(document, 'contextmenu', e => {
      const row = rowOf(e)
      if (!row || !PHONE.matches) return
      e.preventDefault()
      if (!this.held && !s.open) { this.node = row; this.open(row); this.armed = true }
    })
    // A click beside the open sheet closes it and reaches nothing else; the lift of the finger that held is no tap on the title under it.
    on(document, 'click', e => {
      if (beside(e)) { e.preventDefault(); e.stopPropagation(); if (this.armed) this.close() }
      else if (this.held && !s.contains(e.target)) { this.held = false; e.preventDefault(); e.stopPropagation() }
    }, { capture: true })
    on(document, 'keydown', e => { if (!s.open) return; this.armed = true; if (e.key === 'Escape') { e.preventDefault(); this.close() } }, { capture: true })
    // Focus that leaves the sheet by the keyboard closes it; a finger's focus beside it is left to the click above.
    on(document, 'pointerdown', () => { this.pointed = performance.now() }, { capture: true })
    on(document, 'focusin', e => { if (beside(e) && performance.now() - (this.pointed ?? -1e9) > 1000) this.close() })
    on(s, 'close', () => { this.held = false; for (const f of this.frames ?? []) f.style.pointerEvents = ''; this.frames = [] })
  }
  disconnect() { this.drop(); this.stop.abort(); if (this.element.open) this.element.close() }

  scrolledSince(t) { return this.scrolled.at >= t && (this.scrolled.node === document || this.scrolled.node?.contains?.(this.node)) }
  drop() { clearTimeout(this.timer); this.timer = 0; this.node?.classList.remove('is-held') }
  down(e) {
    this.held = false
    this.drop()
    if (this.element.open) return   // a finger beside the open sheet: the click that follows closes it
    this.node = rowOf(e)
    if (!this.node || !PHONE.matches || !e.isPrimary || e.button > 0) return
    const at = performance.now(), row = this.node
    if (this.scrolledSince(at - 250)) return   // the list was moving: this finger stops it
    this.x0 = e.clientX; this.y0 = e.clientY
    row.classList.add('is-held')
    this.timer = setTimeout(() => { if (this.scrolledSince(at)) this.drop(); else this.open(row) }, HOLD_MS)
  }
  open(row) {
    this.drop()
    const s = this.element
    if (s.open || !row.isConnected) return
    this.held = true
    this.armed = false
    s.style.setProperty('--hue', row.style.getPropertyValue('--hue') || '162')
    s.querySelector('h3').textContent = row.querySelector('.inbox-question')?.textContent ?? ''
    for (const b of s.querySelectorAll('button[data-way]')) {
      b.hidden = !row.querySelector(HAS[b.dataset.way])
      b.setAttribute('formaction', `${this.cardsValue}/${row.dataset.id}/${b.dataset.way}`)
    }
    const link = row.querySelector('a.inbox-text')
    if (link) s.querySelector('.rowmenu-open').href = link.href
    this.back = document.activeElement
    // a frame on the page (the Whiteboard's pad) would take a tap beside the sheet for itself: frames take none while it is open
    this.frames = [...document.querySelectorAll('iframe')].filter(f => f.style.pointerEvents !== 'none')
    for (const f of this.frames) f.style.pointerEvents = 'none'
    s.show()
    s.querySelector('button:not([hidden]), a')?.focus({ preventScroll: true })
  }
  close() {
    const s = this.element
    if (!s.open) return
    this.held = false
    s.close()
    if (this.back?.isConnected && s.contains(document.activeElement)) this.back.focus({ preventScroll: true })
  }

  // A click on the sheet (data-action): not before it is armed; on "Open" it closes.
  tapped(event) {
    if (!this.armed) { event.preventDefault(); event.stopPropagation(); return }
    if (event.target.closest('.rowmenu-open')) this.close()
  }
  // A way was chosen: the sheet goes, the hub's answer takes the row away and says what happened.
  sent() { this.close() }
})

// ---- the Desk's routes and live pieces ----
export function register(t) {
  const { BASE, model, says, redirect } = t
  // The search of a stack: GET <base>/stacks/<kind>?q=… The Desk with that stack open and searched (a frame takes only
  // its list from it).
  t.get(/^\/stacks\/(notes|off)$/, ({ req, res, url, match }) => {
    const m = t.model(), q = String(url.searchParams.get('q') ?? '').trim().slice(0, 120)
    const n = m.fresh.length
    t.page(req, res, { model: m, title: n ? `(${n}) ${m.deskName} · Trommi` : `${m.deskName} · Trommi`, view: 'desk', main: deskMain(m, t.BASE, { pile: match[1], q }) })
  })
  // ---- the Desk ----
  // The row cache: a row is rendered again only when its card (a new object after any change of it), its session or
  // the desk's frame changed. Keeps a change on a Desk of hundreds of cards to the rows it touched.
  const rowCache = new WeakMap()
  const rowOf = (c, m) => {
    const a = m.byAgent.get(c.agent), key = `${a?.name}|${a?.hue}|${a?.mark}|${a?.starred}|${a?.online}|${m.desk}`
    const hit = rowCache.get(c)
    if (hit && hit.key === key) return hit.row
    const row = deskRow(c, m, BASE)
    rowCache.set(c, { key, row })
    return row
  }
  // Windowed: the first WINDOW rows are whole; the rest stand as empty rows of the same id (and knock mark), filled in
  // when they come near the viewport (desk-window.mjs asks board.row(id)). A long Desk costs what is in view.
  const WINDOW = 16
  const later = c => raw(`<article class="inbox-row" id="row-${c.id}" data-later data-id="${c.id}"${isKnock(c) ? ' data-knock' : ''}></article>`)
  const windowed = m => { const first = new Set(m.fresh.slice(0, WINDOW).map(c => c.id)); return c => (first.has(c.id) ? rowOf(c, m) : later(c)) }
    t.get(/^\/$/, ({ req, res, url }) => {
      const m = model()
      const pile = STACKS.includes(url.searchParams.get('pile')) ? url.searchParams.get('pile') : null
      const [saidId, saidWhat] = String(url.searchParams.get('said') ?? '').split(':')
      const n = m.fresh.length
      t.page(req, res, { model: m, title: n ? `(${n}) ${m.deskName} · Trommi` : `${m.deskName} · Trommi`, view: 'desk', main: deskMain(m, BASE, { pile, rowOf: windowed(m) }), says: says(m.byCard.get(saidId), saidWhat) })
    })
    t.get(/^\/walk$/, ({ res, url }) => {
      const next = model().fresh[0], said = url.searchParams.get('said')
      redirect(res, next ? `${cardPath(next, BASE)}?walk=1` : `${BASE}/${said ? `?said=${encodeURIComponent(said)}` : ''}`)
    })
    t.live('desk', {
      take: m => ({ order: m.fresh.map(c => c.id), agents: new Map(m.fresh.map(c => [c.id, c.agent])), rows: new Map(m.fresh.map(c => [c.id, rowOf(c, m)])), head: deskHead(m, BASE), news: newsStrip(m, BASE), stacks: deskStacks(m, BASE) }),
      diff(was, now, client, m) {
        const out = []
        if (t.differs(was.head, now.head)) out.push(stream('replace', 'desk-head', now.head))
        if (t.differs(was.news, now.news)) out.push(stream('replace', 'desk-news', now.news))
        const kept = was.order.filter(id => now.rows.has(id)), added = now.order.filter(id => !was.rows.has(id))
        const sameOrder = kept.every((id, i) => now.order[i] === id)
        // A run is one section with the session's drawing on its first card only. A removal that brings two runs of
        // one session together (the card between them went) is drawn again whole, so they become one run.
        const runsOf = (ids, agentOf) => ids.filter((id, i) => i === 0 || agentOf(ids[i - 1]) !== agentOf(id)).length
        const keptSet = new Set(kept), wasRuns = []
        for (const id of was.order) { if (!wasRuns.length || was.agents.get(wasRuns.at(-1).at(-1)) !== was.agents.get(id)) wasRuns.push([]); wasRuns.at(-1).push(id) }
        const merges = runsOf(kept, id => was.agents.get(id)) < wasRuns.filter(r => r.some(id => keptSet.has(id))).length
        if (!sameOrder || merges) { const w = windowed(m); out.push(stream('update', 'desk-list', deskList(m, BASE, { rowOf: c => (w(c) === now.rows.get(c.id) ? now.rows.get(c.id) : w(c)) }))) }
        else {
          for (const id of was.order) if (!now.rows.has(id)) out.push(stream('remove', `row-${id}`))
          for (const id of kept) if (was.rows.get(id) !== now.rows.get(id) && t.differs(was.rows.get(id), now.rows.get(id))) out.push(stream('replace', `row-${id}`, now.rows.get(id)))
          // A card that arrives after a card of its own session joins that run (no second drawing); else it starts one.
          for (const id of added) {
            const card = m.byCard.get(id), sender = m.byAgent.get(card.agent); if (!sender) continue
            const prev = now.order[now.order.indexOf(id) - 1]
            if (prev && now.agents.get(prev) === card.agent) out.push(stream('after', `row-${prev}`, now.rows.get(id)))
            else out.push(stream('before', 'desk-stacks', runSection(sender, now.rows.get(id), 1)))
          }
        }
        if (t.differs(was.stacks, now.stacks)) out.push(stream('replace', 'desk-stacks', now.stacks))
        return out.join('')
      },
    })
  // Rows beyond the first ones stand empty until they come near (startDeskWindow): their markup is made then.
  startDeskWindow(id => { const m = model(), c = m.byCard.get(id); return c && m.fresh.includes(c) ? String(rowOf(c, m)) : '' })
}
