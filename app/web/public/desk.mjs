// The Desk: every open question as a row, in the hub's fixed order, and the stacks at its foot
// (Later, Notes, Done), the news beside them. The markup is the one app.css and desk.css style. A row never unfolds: its text is a link to
// the card's own page, its tiles are forms that answer with one tap.
import { BASE, GOALS_LINES, cleanGoals, closedMemo, linkOf, stream, flipOut, walkOf } from './app.mjs'
import { lastUndo, undoLast } from './ui.mjs'
import { Controller, PLUS, SETTLED, WORDS, advisedLabels, agoSpan, artifactItems, calm, controller, deskRow, el, act, html, isKnock, linkSlip, mediaPreview, mq, plain, raw, runSection, sideWays, sk } from './ui.mjs'
// ---- the infos: reports, notes, nothing to decide ----
// (His word, 4 October: "einfach untermischen".) An info is a card of the stack like any other, among the decisions by
// its time (a knock first): the drawn page where a decision has its pictures, the title, and at the right What?? and
// the tick (ui.mjs deskRow, tiles). Inserted into the hub's order of the decisions without changing it: each info
// stands after the knocks, before the first decision that is older.
// Blocking first, then the knocks, then the rest (his word, 4 October: "Blocking und Knocking … nach oben"); stable, so
// the hub's order holds within each.
const urgRank = c => (c.urgency === 'critical' ? 2 : isKnock(c) ? 1 : 0)
const byUrgency = cards => cards.map((c, i) => [c, i]).sort(([a, i], [b, j]) => urgRank(b) - urgRank(a) || i - j).map(([c]) => c)
// (What the agents finished stands in the end list, endList below, not among these rows.)
function deskCards(model) {
  const r = model.reads ?? []
  if (!r.length) return byUrgency(model.fresh)
  const out = [...model.fresh]
  for (const info of [...r].sort((a, b) => (a.created ?? 0) - (b.created ?? 0))) {
    // (after every knock unless it knocks itself; then before the first older card)
    const from = isKnock(info) ? 0 : out.findLastIndex(c => isKnock(c)) + 1
    const at = out.findIndex((c, i) => i >= from && (c.created ?? 0) < (info.created ?? 0))
    out.splice(at < 0 ? out.length : at, 0, info)
  }
  return byUrgency(out)
}
/** The Desk's top is where one arrives: one big line in the display face, its last word underlined with the pen, and
 *  at the right, on the list's right edge, the tools for what waits (the duck for all, Blitz: the count stands
 *  there). The line is one of the greetings below, picked once per page load (it does not change while the page stays
 *  open); when nothing waits, one of the calm ones. The app knows no name of the human, so none is said. */
const GREETINGS = [
  'Welcome back.', 'There you are.', 'The agents missed you.', 'Desk’s all yours.', 'Ring the bell.', 'Decisions, decisions.',
  'Your call.', 'Back at it.', 'Somebody knocked.', 'Look who’s here.', 'They’ve been waiting.', 'The floor is yours.',
  'Pick a card.', 'Over to you.', 'Right on time.', 'Pull up a chair.', 'Yes or no?', 'The boss is in.', 'What’ll it be?', 'Ready when you are.',
]
const CALM = ['All quiet.', 'Nothing needs you.', 'Clear desk.', 'Carry on.', 'As you were.', 'Go outside.']
const dice = Math.random()
const greeting = calm => { const set = calm ? CALM : GREETINGS; return set[Math.floor(dice * set.length)] }
/** No question waits, but it is not quiet: a session cannot hear him, an answer of his was not picked up, or Done rows wait to be seen. */
const unquiet = model => (model.cut?.length ? (model.cut.length === 1 ? 'One can’t hear you.' : 'Some can’t hear you.') : model.unheard ? (model.unheard === 1 ? 'An answer waits.' : 'Answers wait.') : '')
function deskHead(model, base) {
  const n = model.fresh.length
  if (!model.units.length) return deskInvite()
  const words = ((!n && unquiet(model)) || greeting(!n)).split(' '), last = words.pop()
  return html`<header class="inbox-head desk-top" id="desk-head" data-controller="title" data-title-count-value="${n}"><h2 class="desk-hello">${words.join(' ')} <em>${last}</em></h2>${deskGoals(model)}${n ? html`<div class="desk-tools">${duckAll(model, base)}${nextPlease(model, base)}</div>` : ''}</header>`
}

/** The desk's goals (his word, 8 October): a short note of his own right under the greeting, at most five lines
 *  ("1. … 2. … 3. …"), kept in the desk's register (desk/<id>, field goals: end-to-end encrypted like its name, on
 *  every device of his). Empty: only a faint "Goals…". A click writes in place (controller "goals" below); not on All
 *  desks. The write: app.mjs hub.desk({ id, goals }). */
function deskGoals(model) {
  if (model.all) return ''
  const text = model.goals ?? ''
  return html`<div class="desk-goals" data-controller="goals" data-goals-desk-value="${model.desk ?? 'main'}"><button type="button" class="desk-goals-show${text ? '' : ' is-empty'}" data-action="goals#edit" title="This desk’s goals: a few lines (click to write)">${text || 'Goals…'}</button></div>`
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
  for (const card of deskCards(model)) {
    const sender = model.byAgent.get(card.agent)
    if (!sender) continue
    if (groups.at(-1)?.sender === sender) groups.at(-1).cards.push(card)
    else groups.push({ sender, cards: [card] })
  }
  return groups
}

/** Everything inside .inbox-groups (#desk-list). rowOf(card): the row's markup (the stream keeps what it rendered). */
function deskList(model, base, { rowOf = card => deskRow(card, model, base, { slim: true }) } = {}) {
  // (The slip for the sessions that are cut off stands above the questions: #link-slip, hidden while there is none.)
  return html`${linkSlip(model.cut ?? [], base)}${runs(model).map(({ sender, cards }) => runSection(sender, cards.map(rowOf), cards.length))}
${model.open.length || (model.reads ?? []).length ? '' : html`<div class="inbox-empty">${sk('desk')}<p>Questions land here.</p></div>`}
${withAgents(model, base)}${endList(model, base)}${deskStacks(model, base)}`
}

/** The Desk's <main>. */
// (Controller "desk": a card that arrives out of sight is said quietly, "1 new ↓"; a knock out of sight has a strip at
//  the list's edge that leads to it.)
// (the selection bar and the knock strips stand in a layer of their own beside <main>: fixed things inside it kept
//  <main> from being a layout boundary, so every change in the list laid the whole page out)
const deskMain = (model, base, opts = {}) => html`<main id="inbox" aria-label="Desk" data-controller="desk" data-action="turbo:before-stream-render@document->desk#changing">
${deskHead(model, base)}
<div class="inbox-news-at"><button class="inbox-news" type="button" data-desk-target="news" data-action="desk#toNew" hidden></button></div>
<div class="inbox-groups" id="desk-list" data-desk-target="list">${deskList(model, base, opts)}</div>
</main>
<div class="desk-layer" id="desk-layer"><form class="sel-bar" id="sel-bar" method="post" action="${base}/cards/batch" hidden aria-label="Selected cards"><input type="hidden" name="stay" value="1"><input type="hidden" name="ids" value=""><span class="sel-n"></span>${sideWays({ many: true, between: html`<button type="submit" name="way" value="read" class="sel-read" hidden>${sk('tick')}<span>Read</span></button>` })}<button type="button" class="sel-clear" title="Clear the selection (Esc)" aria-label="Clear the selection"><svg viewBox="0 0 24 24" class="sketch" aria-hidden="true"><path d="M6.8 7.2 Q12 12.4 17.4 17.6"/><path d="M17.2 6.8 Q12.2 12 6.6 17.4"/></svg></button></form>
<div class="inbox-edge is-up"><button class="inbox-edge-knock" type="button" id="knock-up" data-dir="up" hidden>↑ ${sk('knock')}<span></span></button></div>
<div class="inbox-edge is-down"><button class="inbox-edge-knock" type="button" id="knock-down" data-dir="down" hidden>↓ ${sk('knock')}<span></span></button></div>
</div>`

// ---- the walk's button ----
// A drawn button into the walk through every open question (his word, 6 October: "ein Button mit eigenem Design"):
// a small lightning bolt in the pen's line, the word (WORDS.walk, the one place it stands: Blitz), the count in an ink
// disc. desk.css (.desk-blitz). The address is /blitz; a card in the walk carries ?walk=1, as a session's own walk does.
const BOLT = raw('<svg class="blitz-bolt" viewBox="0 0 24 24" aria-hidden="true"><path d="M13.9 2.9 Q10.2 8.2 6.3 13.4 Q9.4 13 12.2 13.2 Q10.8 17.2 9.7 21.2 Q14 15.7 18 10.2 Q14.8 10.7 11.9 10.6 Q13.1 6.7 13.9 2.9 Z"/></svg>')

/** The button for n > 0 open cards (model.fresh, in the hub's order): a link to the walk. */
function nextPlease(model, base) {
  const n = model.fresh.length
  return html`<a class="desk-blitz" data-nav href="${base}/blitz" title="${WORDS.walk}: every open question, one after the other (G B)" aria-label="${WORDS.walk}: ${n === 1 ? '1 open question' : `${n} open questions`}" aria-keyshortcuts="G B">${BOLT}<span>${WORDS.walk}</span><b class="desk-blitz-n">${n}</b></a>`
}

// ---- the duck for all ----
// Left of Blitz, smaller and quieter: the duck of "I don't give a duck". One press asks, in a small sheet of its
// own (no browser dialog); "Yes" answers every open decision on this Desk the way the single card's duck does, one
// answer per card (POST <base>/cards/batch, way "duck": hub.trust per card, one toast whose Undo takes all back).
// Infos and permission requests are not touched (the sheet does not say so: one line and two buttons). Not there when no decision is open.
function duckAll(model, base) {
  const ids = model.fresh.filter(c => c.kind === 'decision').map(c => c.id), n = ids.length
  if (!n) return ''
  const tip = n === 1 ? 'I don’t give a duck: for the one open decision' : `I don’t give a duck: for all ${n} open decisions`
  return html`<details class="t-pick desk-duck" data-controller="pops"><summary class="desk-duck-open" title="${tip}" aria-label="${tip}">${sk('duck')}</summary>
<form class="desk-duck-ask" method="post" action="${base}/cards/batch" aria-label="Answer all open decisions"><input type="hidden" name="way" value="duck"><input type="hidden" name="ids" value="${ids.join(',')}">
<p>Answer ${n === 1 ? 'it' : html`all ${n}`} with “I don’t give a duck”?</p>
<div class="desk-duck-ways"><button type="submit" class="desk-duck-yes">${sk('duck')}<span>Yes, duck ${n === 1 ? 'it' : 'them all'}</span></button><button type="button" class="desk-duck-no" data-pop-close>Cancel</button></div>
</form></details>`
}

/** The sheet a long press on a Desk row brings up on a phone (desk.css, dialog.rowmenu): one form, each way its own
 *  button. The hub renders it once per Desk; the controller controller "sheet" points it at the row that was held. */
export function rowSheet(base) {
  const way = (name, drawing, word, cls = '', tip = '') => html`<button type="submit" data-way="${name}"${cls ? html` class="${cls}"` : ''}${tip ? html` title="${tip}" aria-label="${tip}"` : ''}>${sk(drawing)}${tip ? '' : html`<span>${word}</span>`}</button>`
  return html`<dialog class="rowmenu" id="row-sheet" data-controller="sheet" data-sheet-cards-value="${base}/cards" data-action="click->sheet#tapped turbo:submit-start->sheet#sent" aria-labelledby="row-sheet-title"><div class="rowmenu-in">
<h3 id="row-sheet-title"></h3>
<form method="post" id="row-sheet-form"><input type="hidden" name="stay" value="1">
${way('snooze', 'snooze', WORDS.later)}${way('revise', 'reverse', WORDS.revise)}${way('trust', 'duck', WORDS.trust)}${way('what', 'what', WORDS.what, '', 'What?? — explain this to me')}${way('shred', 'bin', WORDS.shred, 'is-shred')}</form>
<a class="rowmenu-open" data-nav draggable="false" href="${base}/">${sk('page')}<span>Open</span></a>
<button type="button" class="rowmenu-undo" data-action="click->sheet#undo" hidden>${sk('back')}<span>Undo</span></button>
</div></dialog>`
}

// ---- stacks ----
// Every card that left the open rows (Later, Done, Trash, and what is with the agents) stands in the end list (endList
// below); its whole list with the search is the page /stacks/off. The foot of the Desk holds Artifacts.
//
// Which card lies where (stackOf below; the hub's card fields decide, nothing else):
//   later   status "open" and snoozed_until set: he put it off; "Wake up" fetches it back
//   works   status "open" and with_agent set (handed back by Revise or What??; it returns by itself; "Take back"),
//           or status "decided" while it is really with its session: answered within ACTING_MS and the session is
//           online or cut off (it acts on the answer and has not closed it yet), or it has not picked the answer up
//           (the receipt, card.heard false); "Take back"
//   done    status "decided" but older than ACTING_MS or its session is offline (its line says "not closed by the
//           agent"), and status "done" with an answer of his (choice, or trusted; one that was a final option settled
//           the card at once, it was never "decided": its line says "settled by your answer"), or an info he read; "Take back"
//   trash   status "shredded" (he threw it away; "Take back" fishes it out), or status "done" without an answer
//           of his (its session withdrew it; the hub takes nothing back there, so the line has no way back)
// A permission card is never listed (the hub closes it by itself). The newest lies on top of each.
const cardPath = (card, base) => `${base}/card/${encodeURIComponent(card.number ?? card.id)}`
const answeredBy = c => (c.kind === 'decision' && (c.choice != null || c.trusted)) || (c.kind === 'info' && Boolean(c.read))

/** The place a card lies at the foot of the Desk: 'later' | 'works' | 'done' | 'trash', or null (it is an open row, or never listed). */
const ACTING_MS = 6 * 60 * 60 * 1000   // an answered card counts as worked on by its session for so long
/** ctx: { now, online(agentId) }: the time, and whether a session is online (both only for a "decided" card). */
function stackOf(card, { now = Date.now(), online = () => true } = {}) {
  if (card.kind === 'permission') return card.status === 'open' && card.snoozed_until ? 'later' : null
  if (card.status === 'open') return card.snoozed_until ? 'later' : card.with_agent ? 'works' : null
  if (card.status === 'shredded') return 'trash'
  if (card.status === 'decided') return !answeredBy(card) ? null : now - (card.decided ?? 0) < ACTING_MS && (online(card.agent) || card.heard === false) ? 'works' : 'done'
  if (card.status === 'done') return answeredBy(card) ? 'done' : 'trash'
  return null
}

/** The four places with their cards, the newest first: { later, revising, acting, done, trash }. Once per model;
 *  the closed cards' places are kept while no card changed, the sessions are as online as they were and no answered
 *  card has passed ACTING_MS since (app.mjs cardsMemo: a chat message does not sort thousands of cards again). */
const stacksOfModel = new WeakMap()
function stackCards(model) {
  if (stacksOfModel.has(model)) return stacksOfModel.get(model)
  const { state, byAgent } = model
  // (A card lies where its session stands now: the model's rule, app.mjs boardModel.)
  const mine = c => model.onDesk(byAgent.get(c.agent))
  const newest = (cards, at) => [...cards].sort((a, b) => (at(b) ?? 0) - (at(a) ?? 0))
  // (A session that is cut off still runs: what it was given, or was to be given, stays with it.)
  const online = id => Boolean(byAgent.get(id)?.online) || linkOf(byAgent.get(id))?.state === 'cut'
  const now = Date.now()
  const ctx = { now, online }
  const key = `stacks ${model.desk} ${model.everyone.map(a => `${a.id}:${model.onDesk(a) ? 1 : 0}${online(a.id) ? 1 : 0}`)}`
  let closedPlaces = closedMemo(state, key, () => ({ until: 0 }))
  if (now >= closedPlaces.until) {
    const closed = state.cards.filter(c => c.status !== 'open' && mine(c))
    // (an answered card counts as worked on for ACTING_MS: the places hold until the first such card passes it)
    let until = Infinity
    for (const c of closed) if (c.status === 'decided' && c.decided && now - c.decided < ACTING_MS) until = Math.min(until, c.decided + ACTING_MS)
    closedPlaces = Object.assign(closedPlaces, {
      until,
      acting: newest(closed.filter(c => c.status === 'decided' && stackOf(c, ctx) === 'works'), c => c.decided),
      done: newest(closed.filter(c => stackOf(c, ctx) === 'done'), c => c.decided),
      trash: newest(closed.filter(c => stackOf(c, ctx) === 'trash'), c => (c.status === 'shredded' ? c.shredded : c.created)),
    })
  }
  const out = {
    later: model.snoozed.filter(c => stackOf(c, ctx) === 'later'),
    revising: model.revising.filter(c => stackOf(c, ctx) === 'works'),
    acting: closedPlaces.acting, done: closedPlaces.done, trash: closedPlaces.trash,
  }
  stacksOfModel.set(model, out)
  return out
}

// ---- with the agents ----
// An answered card whose session is still at it (stackCards: acting), or one handed back (revising): one line at the
// top of Off your mind (endList), "<session> is on it" or its status line. #desk-ip stays as the stream's place.
function workItems(model) {
  const cards = stackCards(model)
  const working = (model.state.tasks ?? []).filter(t => t.state === 'working')
  return [...cards.revising, ...cards.acting].map(card => {
    const sender = model.byAgent.get(card.agent)
    const line = working.find(t => t.card_id === card.id) ?? working.filter(t => t.agent === card.agent && !t.card_id).sort((a, b) => b.updated - a.updated)[0] ?? null
    return { card, sender, line, at: (card.status === 'open' ? card.with_agent : card.decided) ?? 0 }
  }).filter(i => i.sender).sort((a, b) => (b.line?.updated ?? b.at) - (a.line?.updated ?? a.at))
}
function withAgents() {
  // (one list, his word 8 October: the work stands at the top of Off your mind, endList; this keeps the stream's place)
  return html`<section id="desk-ip" class="tail" hidden></section>`
}


/** What lies off the desk, for the end list: the snoozed cards and the closed ones (Done and Trash merged, the newest
 *  first, made only as far as asked). */
function offParts(model) {
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
  // (A card his own answer settled, a final option, says so on its line: no agent closed it.)
  const answered = c => Object.assign(sheet(c, 'answered', () => `${answerOf(c)}${c.settled ? ` · ${SETTLED.toLowerCase()}` : c.status === 'done' && c.kind !== 'info' ? ' · done by the agent' : c.status === 'decided' && stackOf(c, ctx) === 'done' ? ' · not closed by the agent' : ''}`), c.settled ? { why: SETTLED.toLowerCase() } : {})
  const thrown = c => (c.status === 'shredded' ? sheet(c, 'shredded', () => 'Shredded') : sheet(c, 'withdrawn', () => `Withdrawn${c.summary ? `: ${plain(c.summary, state.assets).slice(0, 220)}` : ''}`))
  // Off the desk: Snoozed, Done and Trash, each the newest first (what is being worked on stands on the Desk: withAgents).
  // The closed cards' sheets are made once per list of them (stackCards keeps that list while nothing changed).
  const later = cards.later.map(c => Object.assign(sheet(c, 'later', () => until(c)), { g: 'later' })).sort((a, b) => b.at - a.at)
  // Done and Trash are each sorted the newest first already (stackCards): merged sheet by sheet, and only as far as
  // asked (the Desk wants five; a sheet is made when it is reached), kept with that pair of lists.
  let closed = closedSheets.get(cards.done)
  if (!closed || closed.trash !== cards.trash) {
    const atD = c => atOf(c, 'answered'), atT = c => atOf(c, c.status === 'shredded' ? 'shredded' : 'withdrawn')
    const made = [], d = cards.done, tr = [...cards.trash].sort((a, b) => atT(b) - atT(a))
    let i = 0, j = 0
    const upTo = n => {
      while (made.length < n && (i < d.length || j < tr.length)) {
        if (j >= tr.length || (i < d.length && atD(d[i]) >= atT(tr[j]))) made.push(Object.assign(answered(d[i++]), { g: 'done' }))
        else made.push(Object.assign(thrown(tr[j++]), { g: 'trash' }))
      }
      return made.slice(0, n)
    }
    closed = { trash: cards.trash, upTo, size: d.length + tr.length }
    closedSheets.set(cards.done, closed)
  }
  return { later, get closed() { return closed.upTo(Infinity) }, closedTop: n => closed.upTo(n), closedSize: closed.size }
}
const closedSheets = new WeakMap()
/** The foot of the Desk (#desk-stacks): Artifacts. */
const deskStacks = (model, base) => html`<div class="inbox-stacks stack-tabs is-straight is-two" id="desk-stacks">${artifactsPile(model, base)}</div>`

// ---- the end of the Desk's list: Off your mind, a plain feed (his word, 9 October: "no archiving, no ticking: the feed
// runs off at the bottom, that is enough") ----
// After the open questions: one slim list. First what the agents are still working on (a small green dot), then what is
// put off (Later: the three Z), then what is closed, the newest first (answered, done by its agent, read; shredded and
// withdrawn ones struck through). Nothing to tick, nothing to archive. Five rows, then "Show more" opens the whole list
// with its search (/stacks/off). A title opens its card.
const END_STEP = 5
/** A section's heading at the Desk's foot: a pen rule with its small label; a link (Show more) where the rule ends, at
 *  its right. With href the label itself is the link to the section's whole page (Artifacts, with its count). */
const divider = (label, link = '', { href = '', count = null } = {}) => html`<div class="end-divider"><svg viewBox="0 0 300 8" preserveAspectRatio="none" aria-hidden="true"><path d="M2 4.6 Q60 2.6 120 4.2 T238 3.6 T298 4.4"/></svg>${href ? html`<a class="end-head" data-nav href="${href}" aria-label="All ${label}${count == null ? '' : `, ${count}`}">${label}${count == null ? '' : html` <span class="off-count">${count}</span>`}</a>` : html`<span aria-hidden="true">${label}</span>`}${link}</div>`
/** The end list. On the Desk the first five rows and "Show more"; full (the page /stacks/off): every row, with its search. */
function endList(model, base, { full = false, q = '' } = {}) {
  const { later, closedTop, closedSize } = offParts(model)
  const works = workItems(model).map(i => ({ card: i.card, g: 'works', at: i.line?.updated ?? i.at, said: `${i.sender.name}${i.line?.label ? ` · ${i.line.label}` : ' is on it'}` }))
  const id = full ? 'off-end' : 'desk-end'
  const terms = String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  // (the Desk shows the first END_STEP: only so many of the thousands closed are taken, the count says the rest)
  const whole = full || terms.length
  let items = [...works, ...later, ...closedTop(whole ? Infinity : END_STEP)]
  const total = whole ? items.length : works.length + later.length + closedSize
  if (terms.length) items = items.filter(s => terms.every(w => `${s.card.title} ${model.byAgent.get(s.card.agent)?.name ?? ''} ${s.said}`.toLowerCase().includes(w)))
  if (!items.length && !full) return html`<section id="${id}" class="endlist" hidden></section>`
  const row = (s, i) => {
    const c = s.card, href = cardPath(c, base)
    const box = s.g === 'works' ? html`<span class="end-tick is-working" title="Being worked on" role="img" aria-label="Being worked on"><i class="work-dot"></i></span>`
      : s.g === 'later' ? html`<span class="end-tick is-later" title="Put off: Later" role="img" aria-label="Later">${sk('snooze')}</span>`
        : ''
    return html`<li class="end-row" data-g="${s.g}" data-id="${c.id}">${box}<a class="end-title" data-nav href="${href}" title="${c.title} · ${s.said}">${c.title}</a><span class="end-said">${s.said}</span>${agoSpan(s.at, 'ago end-ago')}</li>`
  }
  return html`<section id="${id}" class="endlist${full ? ' is-full' : ''}" aria-label="Off your mind">
${divider('Off your mind', !full && (terms.length ? items.length : total) > END_STEP ? html`<a class="end-link" data-nav href="${base}/stacks/off">Show more</a>` : '')}
<ol class="end-rows">${(full ? items : items.slice(0, END_STEP)).map(row)}</ol>${full && !items.length ? html`<p class="end-none">${terms.length ? 'Nothing here has these words.' : 'Nothing yet.'}</p>` : ''}
</section>`
}

/** The page /stacks/off: the whole list, the work with the agents first, then every row of the end list, with a search. */
const offMain = (model, base, q) => html`<main id="inbox" class="off-page" aria-label="Off your mind"><header class="inbox-head desk-top"><h2 class="desk-hello"><a class="off-back" data-nav href="${base}/" aria-label="Back to the Desk">←</a> Off your <em>mind</em></h2><form class="end-search" method="get" action="${base}/stacks/off" role="search"><label><span class="offscreen">Search</span><input type="search" name="q" value="${q}" placeholder="Search the list" autocomplete="off"></label></form></header>
<div class="inbox-groups" id="off-list">${withAgents(model, base)}${endList(model, base, { full: true, q })}</div></main>`



/** The pile "Artifacts N" at the foot of the Desk (in #desk-stacks): everything the agents made or sent, Media and
 *  Pages in one (ui.mjs artifactItems). The newest three pictures or videos lie fanned like prints; with none, the
 *  newest pages as sheets of paper with a folded corner. A click opens /artifacts (media.mjs). Without any it is not there. */
function artifactsPile(model, base) {
  // (his pick "row", 8 October: the last four as small cards in a row, picture or page, a one-line title; then all of them)
  const all = artifactItems(model, base)
  if (!all.length) return ''
  const seen = new Set(), four = []
  for (const x of all) { const k = x.item.url || x.item.pic || x.item.title; if (seen.has(k)) continue; seen.add(k); four.push(x); if (four.length === 4) break }
  const thumb = x => x.kind === 'media' ? mediaPreview(x.item) : html`<span class="df-page"${x.item.pic ? raw(` style="background-image:url('${x.item.pic}')"`) : ''}>${x.item.pic ? '' : html`<b>${x.item.title}</b><i></i><i></i><i></i>`}</span>`
  return html`<section class="df-cards" id="desk-artifacts" aria-label="Artifacts, ${all.length}">${divider('Artifacts', '', { href: `${base}/artifacts`, count: all.length })}
<div class="df-row">${four.map(x => html`<a class="df-card" data-nav href="${x.item.href ?? `${base}/artifacts`}" title="${x.item.title || x.item.name}"><span class="df-thumb">${thumb(x)}</span><span class="df-title">${x.item.title || x.item.name}</span></a>`)}</div></section>`
}

// ---- controller "goals" ----
// The goals under the greeting written in place: a click turns the line into a field of up to GOALS_LINES lines
// (Enter a new line, none past the last; Ctrl/⌘+Enter or a click beside keeps; Esc leaves it as it was). While he
// writes, the live stream does not replace the heading the field stands in: what comes is held, and applied when he
// is done (or dropped, when his own write follows: the stream then brings the heading anew).
controller('goals', class extends Controller {
  static values = { desk: String }
  connect() { this.held = new Map(); this.hold = e => this.holdStream(e) }
  disconnect() { if (this.field) this.done(true, { flush: false }) }
  edit() {
    if (this.field) return
    const show = this.element.querySelector('.desk-goals-show'), was = show.classList.contains('is-empty') ? '' : show.textContent
    const f = this.field = document.createElement('textarea')
    Object.assign(f, { className: 'desk-goals-field', value: was, maxLength: GOALS_LINES * 120, placeholder: 'Goals for this desk: up to five lines', spellcheck: true })
    f.setAttribute('aria-label', 'This desk’s goals, up to five lines')
    this.was = was; show.hidden = true; this.element.append(f); this.fit()
    f.addEventListener('input', () => this.fit())
    f.addEventListener('keydown', e => this.key(e))
    f.addEventListener('blur', () => this.done(true))
    document.addEventListener('turbo:before-stream-render', this.hold)
    f.focus(); f.setSelectionRange(f.value.length, f.value.length)
  }
  fit() {
    const f = this.field, lines = f.value.split('\n')
    if (lines.length > GOALS_LINES) { const at = f.selectionStart; f.value = lines.slice(0, GOALS_LINES).join('\n'); f.setSelectionRange(Math.min(at, f.value.length), Math.min(at, f.value.length)) }
    f.rows = Math.min(GOALS_LINES, f.value.split('\n').length)
  }
  key(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.done(false) }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.done(true) }
    else if (e.key === 'Enter' && this.field.value.split('\n').length >= GOALS_LINES) e.preventDefault()
  }
  holdStream(e) {
    const el = e.target, target = el?.getAttribute?.('target')
    if (!this.field || target !== 'desk-head' || !document.getElementById(target)?.contains(this.element)) return
    e.preventDefault(); this.held.set(`${el.getAttribute('action')} ${target}`, el.cloneNode(true))
  }
  done(keep, { flush = true } = {}) {
    const f = this.field
    if (!f) return
    this.field = null
    document.removeEventListener('turbo:before-stream-render', this.hold)
    const text = cleanGoals(f.value), show = this.element.querySelector('.desk-goals-show'), changed = keep && text !== this.was
    f.remove()
    if (show) { show.hidden = false; if (changed) { show.textContent = text || 'Goals…'; show.classList.toggle('is-empty', !text) } }
    const held = [...this.held.values()]; this.held.clear()
    const apply = () => { if (flush) for (const el of held) document.documentElement.append(el) }
    if (!changed) return apply()
    // (his own write: the heading comes anew with it; what was held is dropped, unless the write fails)
    fetch('/desk', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: this.deskValue, goals: text }) })
      .then(r => { if (!r.ok) throw new Error(`desk goals: ${r.status}`) })
      .catch(err => { console.warn(err); apply() })
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
// The Desk's list (desk.mjs). "New questions must not move my window": a card that arrives out of
// sight is said quietly ("1 new ↓", a tap goes there), and a knock that is out of sight has one strip at the edge
// of the list it lies beyond ("↓ 1 knock"), which leads to the nearest one.
// Which rows stand in sight is told by an IntersectionObserver; a row out of sight is above or below by its place in
// the list (rows are in order), so scrolling costs nothing and no row is measured while a page is being built.

const knocks = n => (n === 1 ? '1 knock' : `${n} knocks`)
const EDGE = 24   // a row closer than this to the window's edge counts as out of sight
const before = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
/** Pull rows DOWN to "Off the desk" (his word, 4 October: they live there then): a copy of each travels down to the
 *  list at the foot (or off the bottom of the window), shrinking, while the rows close up. Then done(). */
function pullDown(root, rows, done) {
  if (!rows.length) return done()
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { flipOut(rows); return done() }
  const pile = root.querySelector('#desk-end') ?? root.querySelector('#desk-stacks')
  const to = pile?.getBoundingClientRect(), seen = to && to.top < innerHeight
  rows.forEach((row, n) => {
    const r = row.getBoundingClientRect()
    const ghost = row.cloneNode(true)
    ghost.removeAttribute('id'); ghost.classList.add('is-ghost'); ghost.classList.remove('is-chosen')
    Object.assign(ghost.style, { position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, margin: 0, zIndex: 40, pointerEvents: 'none' })
    document.body.append(ghost)
    const dx = (seen ? to.left + to.width / 2 : r.left + r.width / 2) - (r.left + r.width / 2), dy = (seen ? to.top + to.height / 2 : innerHeight + 40) - (r.top + r.height / 2)
    ghost.animate([
      { transform: 'none', opacity: 1 },
      { transform: 'translate(0, 14px) rotate(-.6deg)', opacity: 1, offset: 0.18 },
      { transform: `translate(${dx}px, ${dy}px) scale(.22, .18) rotate(2deg)`, opacity: 0.15 },
    ], { duration: 640, delay: n * 60, easing: 'cubic-bezier(.5, 0, .75, .3)', fill: 'forwards' }).finished.then(() => ghost.remove(), () => ghost.remove())
  })
  // (the rows leave the layout at once; what stood below glides up, transform only: app.mjs flipOut)
  flipOut(rows, { ghost: false })
  setTimeout(done, 560 + (rows.length - 1) * 60)
}

// ---- Select several cards by their session's drawing (his idea, 4 October, "Multi-Select über das Logo des Agents"):
// a click on the drawing ticks the row (Shift: the range from the last one); while any is ticked a bar at the bottom
// puts them off (Later), leaves them to the agents (Duck it), reads the infos, or shreds them, all in one form
// (POST <base>/cards/batch, one toast with Undo for all). Esc or ✕ clears. A stream that renews a row keeps its tick.
const chosen = new Set()
let lastPicked = null
function selectWays(root) {
  const bar = document.getElementById('sel-bar')
  if (!bar) return () => {}
  const rows = () => [...root.querySelectorAll('.inbox-groups .inbox-row[data-id]')].filter(r => r.querySelector('[data-select]'))
  const paint = () => {
    for (const id of [...chosen]) if (!root.querySelector(`#row-${CSS.escape(id)}`)) chosen.delete(id)
    for (const r of rows()) { const on = chosen.has(r.dataset.id); r.classList.toggle('is-chosen', on); r.querySelector('[data-select]').setAttribute('aria-pressed', String(on)) }
    root.classList.toggle('is-choosing', chosen.size > 0)
    document.documentElement.classList.toggle('is-choosing', chosen.size > 0)   // (the page's corner steps aside)
    bar.hidden = !chosen.size
    bar.querySelector('.sel-n').textContent = `${chosen.size} selected`
    bar.elements.ids.value = [...chosen].join(',')
    const kinds = [...chosen].map(id => root.querySelector(`#row-${CSS.escape(id)}`)?.dataset.kind ?? '')
    bar.querySelector('.sel-read').hidden = !kinds.includes('info')
    bar.querySelector('.sel-duck').hidden = kinds.every(k => k === 'info')
  }
  const onClick = e => {
    const mark = e.target.closest?.('[data-select]')
    if (mark && root.contains(mark)) {
      e.preventDefault(); e.stopPropagation()
      const row = mark.closest('.inbox-row'), id = row.dataset.id, all = rows()
      if (e.shiftKey && lastPicked && all.some(r => r.dataset.id === lastPicked)) {
        const a = all.findIndex(r => r.dataset.id === lastPicked), b = all.indexOf(row)
        for (const r of all.slice(Math.min(a, b), Math.max(a, b) + 1)) chosen.add(r.dataset.id)
      } else if (chosen.has(id)) chosen.delete(id)
      else chosen.add(id)
      lastPicked = id
      return paint()
    }
    if (e.target.closest?.('.sel-clear')) { chosen.clear(); paint() }
  }
  const onKey = e => { if (e.key === 'Escape' && chosen.size) { chosen.clear(); paint(); e.preventDefault() } }
  const onSent = e => { if (e.target === bar) { chosen.clear(); setTimeout(paint) } }
  // Later pulls the chosen rows down into "Off the desk" first, then sends the form.
  const onSubmit = e => {
    if (e.target !== bar || e.submitter?.value !== 'later') return
    if (bar.dataset.pulled) { delete bar.dataset.pulled; return }
    if (bar.dataset.pulling) return e.preventDefault()
    e.preventDefault()
    bar.dataset.pulling = '1'
    const rows = [...chosen].map(id => root.querySelector(`#row-${CSS.escape(id)}`)).filter(Boolean)
    const tag = bar.querySelector('.sel-later svg')
    tag?.animate([{ transform: 'none' }, { transform: 'translateY(10px)' }, { transform: 'none' }], { duration: 300, easing: 'ease-out' })
    const ids = bar.elements.ids.value   // (the rows leave the page before the form goes: keep whom it is for)
    pullDown(root, rows, () => { delete bar.dataset.pulling; bar.dataset.pulled = '1'; bar.elements.ids.value = ids; bar.requestSubmit(bar.querySelector('.sel-later')) })
  }
  root.addEventListener('submit', onSubmit, true)
  root.addEventListener('click', onClick, true)
  bar.addEventListener('submit', onSubmit, true)
  bar.addEventListener('click', onClick, true)
  document.addEventListener('keydown', onKey)
  document.addEventListener('turbo:submit-start', onSent)
  const mo = new MutationObserver(() => paint())
  mo.observe(root.querySelector('#desk-list'), { childList: true, subtree: true })
  paint()
  return () => { root.removeEventListener('submit', onSubmit, true); root.removeEventListener('click', onClick, true); bar.removeEventListener('submit', onSubmit, true); bar.removeEventListener('click', onClick, true); document.removeEventListener('keydown', onKey); document.removeEventListener('turbo:submit-start', onSent); mo.disconnect() }
}

controller('desk', class extends Controller {
  static targets = ['list', 'news']
  connect() {
    // (A target is looked up on every read; these elements stay for the page's life: kept once.)
    this.list = this.listTarget; this.news = this.newsTarget; this.up = document.getElementById('knock-up'); this.down = document.getElementById('knock-down')
    this.knock = e => this.toKnock(e); this.up?.addEventListener('click', this.knock); this.down?.addEventListener('click', this.knock)
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
    // (read in the next frame, not in the observer: measuring there made WebKit report "ResizeObserver loop completed
    // with undelivered notifications" as a page error when the Desk is scrolled)
    // (read inside the observer, where the layout is fresh: reading in the next frame, after a stream changed the list,
    //  laid the whole page out once more; the strips are written in the frame)
    this.ro = new ResizeObserver(() => { this.across = this.list.getBoundingClientRect(); this.elTop = this.element.getBoundingClientRect().top; this.look() })
    this.ro.observe(this.list)
    // (folding the sidebar moves the list without resizing it: the window's resize, which the fold sends, measures again)
    this.moved = () => { this.across = this.list.getBoundingClientRect(); this.elTop = this.element.getBoundingClientRect().top; this.look() }
    addEventListener('resize', this.moved)
    this.offSelect = selectWays(this.element)
  }
  disconnect() { this.up?.removeEventListener('click', this.knock); this.down?.removeEventListener('click', this.knock); removeEventListener('resize', this.moved); this.io.disconnect(); this.mo.disconnect(); this.ro.disconnect(); cancelAnimationFrame(this.frame); this.offSelect?.() }
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
        if (this.across) Object.assign(button.parentElement.style, { left: `${this.across.left}px`, width: `${this.across.width}px`, top: dir === 'up' ? `${Math.max(0, Math.round(this.elTop ?? 0))}px` : '', bottom: dir === 'down' ? '0px' : '' })   // (under a phone's top line, not over it)
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

// ---- controller "sheet" ----
// A phone: the ways out of a Desk row behind a long press (desk.css). The row shows who asks, the
// title and the answers; Snooze, Revise, the duck, What??, Shred and Open come up as a sheet after a long press
// on the row, or a right click. The sheet is the hub's (sidebar.mjs, rowSheet): one form whose buttons
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
  undo() { undoLast(); this.close() }
  open(row) {
    this.drop()
    const s = this.element
    if (s.open || !row.isConnected) return
    this.held = true
    this.armed = false
    s.style.setProperty('--hue', row.style.getPropertyValue('--hue') || '162')
    s.querySelector('h3').textContent = row.querySelector('.inbox-question')?.textContent ?? ''
    // (the last toast's undo, without its clock: what went by itself can still be taken back here)
    const kept = lastUndo(), u = s.querySelector('.rowmenu-undo')
    if (u) { u.hidden = !kept; if (kept) u.querySelector('span').textContent = `Undo ${kept.head}` }
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
  t.get(/^\/stacks\/(off)$/, ({ req, res, url, match }) => {
    const m = t.model(), q = String(url.searchParams.get('q') ?? '').trim().slice(0, 120)
    const n = m.fresh.length
    t.page(req, res, { model: m, title: `Off your mind · ${m.deskName} · Trommi`, view: 'off', main: offMain(m, t.BASE, q) })
  })
  // (the whole list stays current: a tick, an untick, a card that comes or goes)
  t.live('off', {
    take: m => ({ list: String(html`${withAgents(m, BASE)}${endList(m, BASE, { full: true, q: new URLSearchParams(location.search).get('q') ?? '' })}`) }),
    diff: (was, now) => (was.list !== now.list ? stream('update', 'off-list', raw(now.list)) : ''),
  })
  // ---- the Desk ----
  // The row cache: a row is rendered again only when its card (a new object after any change of it), its session or
  // the desk's frame changed. Keeps a change on a Desk of hundreds of cards to the rows it touched.
  const rowCache = new WeakMap()
  const rowOf = (c, m) => {
    const a = m.byAgent.get(c.agent), key = `${a?.name}|${a?.hue}|${a?.mark}|${a?.starred}|${a?.online}|${m.desk}`
    const hit = rowCache.get(c)
    if (hit && hit.key === key) return hit.row
    const row = deskRow(c, m, BASE, { slim: true })
    rowCache.set(c, { key, row })
    return row
  }
  // Windowed: the first WINDOW rows are whole; the rest stand as empty rows of the same id (and knock mark), filled in
  // when they come near the viewport (desk-window.mjs asks board.row(id)). A long Desk costs what is in view.
  const WINDOW = 16
  const later = c => raw(`<article class="inbox-row" id="row-${c.id}" data-later data-id="${c.id}"${isKnock(c) ? ' data-knock' : ''}></article>`)
  const windowed = m => { const first = new Set(deskCards(m).slice(0, WINDOW).map(c => c.id)); return c => (first.has(c.id) ? rowOf(c, m) : later(c)) }
    t.get(/^\/$/, ({ req, res, url }) => {
      const m = model()
      const [saidId, saidWhat] = String(url.searchParams.get('said') ?? '').split(':')
      const n = m.fresh.length
      t.page(req, res, { model: m, title: n ? `(${n}) ${m.deskName} · Trommi` : `${m.deskName} · Trommi`, view: 'desk', main: deskMain(m, BASE, { rowOf: windowed(m) }), says: says(m.byCard.get(saidId), saidWhat) })
    })
    // Several cards at once (the selection bar): each through the same way as one card's own button; one toast whose
    // Undo takes all of them back (later -> wake, the others -> reopen).
    const BATCH = { later: id => t.hub.snooze(id, {}), wake: id => t.hub.snooze(id, { clear: true }), duck: id => t.hub.trust(id, ''), shred: id => t.hub.shred(id, ''), read: id => t.hub.closeInfo(id), reopen: id => t.hub.reopen(id) }
    const BACK = { later: 'wake', duck: 'reopen', shred: 'reopen', read: 'reopen' }
    const WHAT = { later: 'snooze', duck: 'trust', shred: 'shred' }   // (a single card's toast: app.mjs SAID)
    const SAID = { later: WORDS.later, duck: 'Left to the agents', shred: 'Shredded', read: 'Read', wake: 'Back on the Desk', reopen: 'Back on the Desk' }
    t.post(/^\/cards\/batch$/, async ({ req, res, form }) => {
      const way = String(form.get('way') ?? ''), m0 = model()
      if (!Object.hasOwn(BATCH, way)) { res.code = 400; return }
      const ids = [...new Set(String(form.get('ids') ?? '').split(',').filter(id => /^[0-9a-f]+$/.test(id) && m0.byCard.has(id)))]
      const done = []
      for (const id of ids) {
        const c = m0.byCard.get(id)
        if (way === 'duck' && c.kind !== 'decision') continue
        if (way === 'read' && c.kind !== 'info') continue
        if ((way === 'later' || way === 'shred') && c.kind === 'permission') continue
        try { await BATCH[way](id); done.push(id) } catch (err) { console.warn(way, id, err.message) }
      }
      // From a card's own page (from: that card): on to the next open card, or back to where it was opened from
      // (the Desk when none is left); the toast with its Undo comes along as on any card's action.
      if (form.has('from')) {
        const m = model(), from = m0.byCard.get(String(form.get('from'))), home = String(form.get('back') ?? '')
        const said = done.length && WHAT[way] ? `said=${done[0]}:${WHAT[way]}` : ''
        if (home.startsWith(`${BASE}/s/`) && /^[\w\-/%+.]+$/.test(home)) return redirect(res, `${home}${said ? `?${said}` : ''}`)
        const walk0 = walkOf(m0), walk = walkOf(m)
        const after = from ? walk0.slice(walk0.indexOf(from) + 1) : []
        const next = done.length ? after.map(c => m.byCard.get(c.id)).find(c => c && walk.includes(c)) ?? walk.find(c => c.id !== from?.id) : from
        return redirect(res, next ? `${cardPath(next, BASE)}${said ? `?${said}` : ''}` : `${BASE}/${said ? `?${said}` : ''}`)
      }
      if (!t.wantsStream(req)) return redirect(res, BASE || '/')
      const n = done.length, back = BACK[way]
      // Undone from a toast: one card, back to its page; several (the selection bar), back to the Desk
      if (form.has('undo') && n) {
        const at = new URL(String(req.headers.referer ?? '/'), location.origin).pathname
        const to = n === 1 ? cardPath(m0.byCard.get(done[0]), BASE) : `${BASE}/`
        if (at !== to) return t.sendStream(req, res, t.stream('visit', to))
      }
      return t.sendStream(req, res, t.toast({ head: SAID[way], line: n === 1 ? m0.byCard.get(done[0]).title : `${n} cards`, undo: back && n ? { action: `${BASE}/cards/batch`, fields: { way: back, ids: done.join(',') } } : null }))
    })
    t.get(/^\/blitz$/, ({ res, url }) => {
      const next = walkOf(model())[0], said = url.searchParams.get('said')
      redirect(res, next ? `${cardPath(next, BASE)}?walk=1` : `${BASE}/${said ? `?said=${encodeURIComponent(said)}` : ''}`)
    })
    t.live('desk', {
      take: m => { const all = deskCards(m); return { order: all.map(c => c.id), agents: new Map(all.map(c => [c.id, c.agent])), rows: new Map(all.map(c => [c.id, rowOf(c, m)])), head: deskHead(m, BASE), slip: linkSlip(m.cut ?? [], BASE), ip: withAgents(m, BASE), end: endList(m, BASE), stacks: deskStacks(m, BASE) } },
      diff(was, now, client, m) {
        const out = []
        if (t.differs(was.head, now.head)) out.push(stream('replace', 'desk-head', now.head))
        if (t.differs(was.slip, now.slip)) out.push(stream('replace', 'link-slip', now.slip))
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
          // One that lands beyond the window's first rows comes as an empty row, filled when it comes near (startDeskWindow):
          // a new question far below the fold costs no rendering of a row.
          const w = added.length ? windowed(m) : null
          for (const id of added) {
            const card = m.byCard.get(id), sender = m.byAgent.get(card.agent); if (!sender) continue
            const row = w(card) === now.rows.get(id) ? now.rows.get(id) : w(card)
            const prev = now.order[now.order.indexOf(id) - 1]
            if (prev && now.agents.get(prev) === card.agent) out.push(stream('after', `row-${prev}`, row))
            else out.push(stream('before', 'desk-ip', runSection(sender, row, 1)))
          }
        }
        if (t.differs(was.ip, now.ip)) out.push(stream('replace', 'desk-ip', now.ip))
        if (t.differs(was.end, now.end)) out.push(stream('replace', 'desk-end', now.end))
        if (t.differs(was.stacks, now.stacks)) out.push(stream('replace', 'desk-stacks', now.stacks))
        return out.join('')
      },
    })
  // Rows beyond the first ones stand empty until they come near (startDeskWindow): their markup is made then.
  startDeskWindow(id => { const m = model(), c = m.byCard.get(id); return c && deskCards(m).includes(c) ? String(rowOf(c, m)) : '' })
}
