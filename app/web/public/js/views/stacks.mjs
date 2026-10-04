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
import { html, raw } from './html.mjs'
import { WORDS, cardNr, plain, advisedLabels, agoSpan } from './text.mjs'
import { smallMark } from './sidebar.mjs'
import { crownOf } from './memo.mjs'
import { deskMain } from './desk.mjs'   // (the search's page without script: the Desk; a cycle, used only at call time)
import { sketchSvg } from '../pen.js'
import { mediaPile } from './gallery.mjs'   // the third pile: the newest pictures and videos, fanned; a click opens the gallery

const FAN_MAX = 8      // a fanned stack shows so many of the newest sheets, then "N more"
const OPEN_MAX = 200   // an open stack (?pile=) or a search shows at most so many; the rest are found by searching
export const STACKS = ['notes', 'off']
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

/** The search of a stack: GET <base>/stacks/<kind>?q=… The Desk with that stack open and searched (a Turbo Frame takes
 *  only its list from it; without script it is the page). */
export function register(t) {
  t.get(/^\/stacks\/(notes|off)$/, ({ req, res, url, match }) => {
    const m = t.model(), q = String(url.searchParams.get('q') ?? '').trim().slice(0, 120)
    const n = m.fresh.length
    t.page(req, res, { model: m, title: n ? `(${n}) ${m.deskName} · Trommi` : `${m.deskName} · Trommi`, view: 'desk', main: deskMain(m, t.BASE, { pile: match[1], q }) })
  })
}
