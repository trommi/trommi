// The Desk: every open question as a row, in the app core's order (vm.desk, views.d.ts DeskView), and under them the
// calm tiles (DeskView.tiles: Working / Done, Artifacts, Scribble Board, Knowledge); the page /stacks/off (vm.off) in
// its groups. The markup is the one app.css and desk.css
// style. A row never unfolds: its text is a link to the card's own page, its tiles are forms that answer with one tap
// (the card's routes, card.mjs). Nothing here decides what stands where: the core does; the page draws and acts.
import { flipOut, viewModule } from './app.mjs'
import { Controller, PLUS, WORDS, agoSpan, avatar, controller, deskRow, fileSrc, html, lastUndo, linkSlip, mq, raw, ringSvg, runSection, sideWays, sk, starMark, undoLast, whoOf } from './ui.mjs'

// ---- the head: the big line, the goals, Blitz and the duck ----
function deskHead(d, base) {
  if (d.mode === 'invite') return deskInvite()
  const words = (d.hello?.en ?? '').split(' '), last = words.pop()
  return html`<header class="inbox-head desk-top" id="desk-head" data-controller="title" data-title-count-value="${d.waiting}"><h2 class="desk-hello">${words.join(' ')} <em>${last}</em></h2>${d.reading ? html`<p class="desk-reading" role="status">${d.reading.en}</p>` : ''}${deskGoals(d.goals)}${d.blitz ? html`<div class="desk-tools" id="desk-tools">${duckAll(d, base)}${nextPlease(d, base)}</div>` : ''}</header>`
}

const CHEV = raw('<svg class="desk-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>')
/** The team's goals (GoalsView): a checklist of his own under the greeting; a click on the words writes in place
 *  (controller "goals": Action::SetGoal). One toggle folds them to the first line (Action::FoldGoals: GoalsView.folded);
 *  folded is this device's: the teams are kept in localStorage and sent to the core again at the start. */
const GOALS_LINES = 20, GOALS_LINE_MAX = 200
const GOALS_FOLDED = 'trommi-goals-folded'
const goalsFolded = () => { try { const v = JSON.parse(localStorage.getItem(GOALS_FOLDED) ?? '[]'); return Array.isArray(v) ? v.map(String) : [] } catch { return [] } }
function deskGoals(g) {
  if (!g) return ''
  const folded = g.foldable && g.folded
  return html`<div class="desk-goals${folded ? ' is-folded' : ''}" id="desk-goals" data-controller="goals" data-goals-team-value="${g.team_id}" data-goals-text-value="${g.lines.join('\n')}" data-goals-show-value="${g.show_all?.en ?? ''}" data-goals-fold-value="${g.folded ? '' : g.toggle?.en ?? ''}">${goalsWords(g, folded)}</div>`
}
/** A line that starts with an emoji or a tick box: the sign in a column of its own, so the words of such lines start
 *  under each other and a long line wraps under its words. */
const GOAL_SIGN = /^\s*((?:\p{Regional_Indicator}{2}|[☐☒✓✗]|\p{Extended_Pictographic})(?:️|⃣|\p{Emoji_Modifier}|‍\p{Extended_Pictographic})*)\s+(\S.*)$/u
/** The words of the goals and, when they can fold, the one toggle. */
export function goalsWords(g, folded = false) {
  const label = folded ? g.show_all?.en ?? '' : g.folded ? '' : g.toggle?.en ?? ''
  const fold = g.foldable ? html`<button type="button" class="desk-goals-toggle" data-action="goals#toggle" aria-expanded="${folded ? 'false' : 'true'}" aria-label="${label}" title="${folded ? 'Show all' : 'Fold'}">${sk('unfold')}</button>` : ''
  const line = l => { const m = GOAL_SIGN.exec(l); return m ? html`<span class="dg-line has-sign"><span class="dg-sign">${m[1]}</span><span>${m[2]}</span></span>` : html`<span class="dg-line">${l}</span>` }
  return html`<button type="button" class="desk-goals-show${g.lines.length ? '' : ' is-empty'}" data-action="goals#edit" title="Goals">${g.lines.length ? g.lines.map(line) : 'Goals…'}</button>${fold}`
}

/** The Desk of a new account (DeskView.mode "invite"): a calm note with one way on, approving a computer (POST
 *  /pair, role computer: the Devices page's form). */
const deskInvite = () => html`<header class="inbox-head" id="desk-head" data-controller="title" data-title-count-value="0"><section class="desk-invite" id="desk-invite" aria-labelledby="desk-invite-title">
${sk('heads', 'desk-invite-art')}<h2 id="desk-invite-title">Approve your computer</h2>
<p>Approve your computer once, then activate each Claude Code or Codex session with one command. Its questions land here.</p>
<form method="post" action="/pair"><input type="hidden" name="role" value="computer"><button type="submit" class="desk-invite-go" id="desk-invite-go">${PLUS}<span>Approve a computer</span></button></form>
</section></header>`

// ---- the walk's button: Blitz ----
// A drawn button into the walk through every open card: a small lightning bolt in the pen's line, the word, the count
// in an ink disc (desk.css .desk-blitz). /blitz goes to the first row; a card in the walk carries ?walk=1.
const BOLT = raw('<svg class="blitz-bolt" viewBox="0 0 24 24" aria-hidden="true"><path d="M13.9 2.9 Q10.2 8.2 6.3 13.4 Q9.4 13 12.2 13.2 Q10.8 17.2 9.7 21.2 Q14 15.7 18 10.2 Q14.8 10.7 11.9 10.6 Q13.1 6.7 13.9 2.9 Z"/></svg>')
const nextPlease = (d, base) => html`<a class="desk-blitz" data-nav href="${base}/blitz" title="${WORDS.walk} (G B)" aria-label="${d.blitz.en}" aria-keyshortcuts="G B">${BOLT}<span>${WORDS.walk}</span><b class="desk-blitz-n">${d.blitz.args?.n ?? ''}</b></a>`

// ---- the duck for all ----
// Left of Blitz, smaller and quieter: one press asks in a small sheet; "Yes" clears every open decision and what is
// only to read at once (POST /cards/batch, way "sweep": one toast whose Undo takes all back). Never a request.
function duckAll(d, base) {
  const ids = (d.rows ?? []).filter(r => r.kind !== 'request').map(r => r.id), n = ids.length
  if (!n) return ''
  return html`<details class="t-pick desk-duck" data-controller="pops"><summary class="desk-duck-open" title="${n === 1 ? 'Duck it' : `Duck all ${n}`}" aria-label="${n === 1 ? 'I don’t give a duck: for the one open card' : `I don’t give a duck: for all ${n} open cards`}">${sk('duck')}</summary>
<form class="desk-duck-ask" method="post" action="${base}/cards/batch" aria-label="Clear everything open"><input type="hidden" name="way" value="sweep"><input type="hidden" name="ids" value="${ids.join(',')}">
<p>${n === 1 ? 'Duck it?' : `Duck all ${n}?`}</p>
<div class="desk-duck-ways"><button type="button" class="desk-duck-no" data-pop-close>Cancel</button><button type="submit" class="desk-duck-yes" data-pop-focus>${sk('duck')}<span>${n === 1 ? 'Yes, duck it' : 'Yes, duck them all'}</span></button></div>
</form></details>`
}

/** The sheet a long press on a Desk row brings up on a phone (desk.css, dialog.rowmenu): one form, each way its own
 *  button. Rendered once per Desk (app.mjs bodyParts); the controller "sheet" points it at the row that was held. */
export function rowSheet(base) {
  const way = (name, drawing, word, cls = '', tip = '') => html`<button type="submit" data-way="${name}"${cls ? html` class="${cls}"` : ''}${tip ? html` title="${tip}" aria-label="${tip}"` : ''}>${sk(drawing)}${tip ? '' : html`<span>${word}</span>`}</button>`
  return html`<dialog class="rowmenu" id="row-sheet" data-controller="sheet" data-sheet-cards-value="${base}/cards" data-action="click->sheet#tapped turbo:submit-start->sheet#sent" aria-labelledby="row-sheet-title"><div class="rowmenu-in">
<h3 id="row-sheet-title"></h3>
<form method="post" id="row-sheet-form"><input type="hidden" name="stay" value="1">
${way('snooze', 'snooze', WORDS.later)}${way('revise', 'reverse', WORDS.revise)}${way('trust', 'duck', WORDS.trust)}${way('what', 'what', WORDS.what, '', 'What??')}${way('shred', 'bin', WORDS.shred, 'is-shred')}</form>
<a class="rowmenu-open" data-nav draggable="false" href="${base}/">${sk('page')}<span>Open</span></a>
<button type="button" class="rowmenu-undo" data-action="click->sheet#undo" hidden>${sk('back')}<span>Undo</span></button>
</div></dialog>`
}

// ---- the rows ----
// Rows beyond the first WINDOW stand empty (same id, knock mark) and are filled when they come near the viewport
// (startDeskWindow below); a row once filled stays filled, also when the page is drawn again. A browser test may set a
// smaller window (`globalThis.TROMMI_DESK_WINDOW`) to get placeholders from one team of the demo room.
const WINDOW = globalThis.TROMMI_DESK_WINDOW ?? 16
const filled = new Set()
const emptyRow = r => raw(`<article class="inbox-row" id="row-${r.id}" data-later data-id="${r.id}"${r.sign === 'knock' || r.sign === 'block' ? ' data-knock' : ''}></article>`)
/** A run of rows of one session (DeskRowView.run on its first row: how many), as one section with an id of its own. */
const run = (first, rows, n) => raw(String(runSection(whoOf(first.from), rows, n)).replace('<section ', `<section id="run-${first.id}" `))
function deskList(d, base) {
  const rows = d.rows ?? [], out = []
  rows.forEach((r, i) => { if (r.run || i === 0) out.push({ first: r, rows: [] }); out.at(-1).rows.push(i < WINDOW || filled.has(r.id) ? deskRow(r, base, { slim: true }) : emptyRow(r)) })
  return html`${linkSlip(d.slip ?? [], base)}${out.map(x => (x.first.from ? run(x.first, x.rows, x.rows.length) : x.rows))}
${d.empty ? html`<div class="inbox-empty${d.mode === 'reading' ? ' is-reading' : ''}" id="desk-empty"${d.mode === 'reading' ? raw(' role="status"') : ''}>${sk('desk')}<p>${d.empty.en}</p></div>` : ''}
<section id="desk-ip" class="tail" hidden></section>
${deskTiles(d, base)}`
}

/** Under the questions, the calm tiles (DeskView.tiles, in the core's order), each a link to its page: what runs and is
 *  done with the running cards (DeskTileView.items: ids of DeskView.off.running), the newest artifacts small (items:
 *  ids of vm.artifacts), the team's Scribble Board small (ViewModel.thumbs, painted by whiteboard.mjs's controller
 *  "thumbs"), the team's Knowledge. */
const TILE = { work: ['/stacks/off', 'tick'], artifacts: ['/artifacts', 'picture'], board: ['/scribble-board', 'pen'], knowledge: ['/knowledge', 'book'] }
function deskTiles(d, base) {
  const tiles = d.tiles ?? []
  if (!tiles.length) return html`<nav class="desk-tiles" id="desk-end" hidden></nav>`
  const vm = deskVm?.() ?? {}
  const running = new Map((d.off?.running ?? []).map(r => [r.id, r])), arts = new Map((vm.artifacts ?? []).map(a => [a.id, a]))
  const runRow = r => { const who = whoOf(r.from); return html`<span class="dt-run" style="--hue:${who.hue}">${avatar(who, { crown: false, working: r.running })}<span>${r.title}</span></span>` }
  const page = a => {
    const id = a.files?.[0], f = id ? vm.files?.[id] : null, type = f?.media_type ?? ''
    if (type.startsWith('image/')) return html`<span class="dt-page is-picture"><img src="${fileSrc(id)}" alt="" loading="lazy" decoding="async"></span>`
    return html`<span class="dt-page"><b>${a.title}</b><i></i><i></i><i></i></span>`
  }
  const inside = t => {
    if (t.key === 'work') return html`<span class="dt-runs">${t.items.map(id => running.get(id)).filter(Boolean).map(runRow)}</span>`
    if (t.key === 'artifacts') return t.items.length ? html`<span class="dt-pages">${t.items.map(id => arts.get(id)).filter(Boolean).map(page)}</span>` : ''
    if (t.key === 'board' && t.team_id) return html`<span class="dt-board"><canvas width="520" height="260" data-thumb="${t.team_id}" aria-hidden="true"></canvas></span>`
    return ''
  }
  if (tiles.some(t => t.key === 'board' && t.team_id)) viewModule('whiteboard').catch(() => {})   // (its controller paints the board small)
  return html`<nav class="desk-tiles" id="desk-end" aria-label="${tiles.map(t => t.title.en).join(', ')}">${tiles.map(t => html`<a class="desk-tile" id="tile-${t.key}" data-tile="${t.key}" data-nav href="${base}${TILE[t.key]?.[0] ?? '/'}"${t.key === 'board' ? raw(' data-controller="thumbs"') : ''} aria-label="${t.title.en}: ${t.line.en}"><span class="dt-head">${sk(TILE[t.key]?.[1] ?? 'page')}<b>${t.title.en}</b>${t.count != null && t.key !== 'work' ? html`<i>${t.count}</i>` : ''}${CHEV}</span><span class="dt-line">${t.line.en}</span>${inside(t)}</a>`)}</nav>`
}

let deskVm = null, deskAct = null

/** The Desk's <main>, and beside it its layer: the selection bar, the knock strips (fixed things
 *  inside <main> would keep it from being a layout boundary). */
const deskMain = (d, base) => html`<main id="inbox" aria-label="Desk" data-controller="desk">
${deskHead(d, base)}
<div class="inbox-news-at"><button class="inbox-news" type="button" data-desk-target="news" data-action="desk#toNew" hidden></button></div>
<div class="inbox-groups" id="desk-list" data-desk-target="list">${deskList(d, base)}</div>
</main>
<div class="desk-layer" id="desk-layer"><form class="sel-bar" id="sel-bar" method="post" action="${base}/cards/batch" hidden aria-label="Selected cards"><input type="hidden" name="stay" value="1"><input type="hidden" name="ids" value=""><span class="sel-n"></span>${sideWays({ many: true, between: html`<button type="submit" name="way" value="read" class="sel-read" hidden>${sk('tick')}<span>Read</span></button>` })}<button type="button" class="sel-clear" title="Clear (Esc)" aria-label="Clear the selection"><svg viewBox="0 0 24 24" class="sketch" aria-hidden="true"><path d="M6.8 7.2 Q12 12.4 17.4 17.6"/><path d="M17.2 6.8 Q12.2 12 6.6 17.4"/></svg></button></form>
<div class="inbox-edge is-up"><button class="inbox-edge-knock" type="button" id="knock-up" data-dir="up" hidden>↑ ${sk('knock')}<span></span></button></div>
<div class="inbox-edge is-down"><button class="inbox-edge-knock" type="button" id="knock-down" data-dir="down" hidden>↓ ${sk('knock')}<span></span></button></div>
</div>`

// ---- the page /stacks/off: the complete list (OffListView) in its groups (OffGroupView) ----
const cardPath = (id, base) => `${base}/card/${encodeURIComponent(id)}`
/** A card with its agent, one line: the drawing in its turning ring, the title, "agent · status line", how long. */
const workRow = (w, base) => { const who = whoOf(w.from); return html`<a class="off-row" id="off-${w.id}" data-nav href="${cardPath(w.id, base)}" style="--hue:${who.hue}" aria-label="${w.says.en}"><span class="off-mark">${avatar(who, { crown: false, working: true })}${raw(ringSvg({ drop: true }))}</span><b>${w.starred ? starMark() : ''}${w.title}</b><small>${who.name}<i> · ${w.label.en}</i></small>${agoSpan(w.at_ms, 'ago off-ago')}</a>` }
/** A put-off or closed card, one quiet line: its mark, the title, when (until when, for a put-off one). */
const restRow = (r, base) => html`<a class="off-row is-rest" id="off-${r.id}" data-nav href="${cardPath(r.id, base)}" data-g="${r.place}" data-id="${r.id}"${r.mark === 'shred' ? raw(' data-shredded') : ''} title="${r.title}"><span class="off-mark" role="img" aria-label="${r.says.en}">${sk(r.mark)}</span><b>${r.starred ? starMark() : ''}${r.title}</b><small></small>${r.until ? html`<span class="ago off-ago">${r.until.en}</span>` : r.at_ms > 0 ? agoSpan(r.at_ms, 'ago off-ago') : html`<span></span>`}</a>`
function offMain(o, base) {
  const q = o?.query ?? ''
  const works = new Map((o?.works ?? []).map(w => [w.id, w])), rest = new Map((o?.rest ?? []).map(r => [r.id, r]))
  const group = g => html`<section class="off-group" id="off-${g.key}" aria-label="${g.says.en}"><h3>${g.says.en} <b>${g.count}</b></h3>${g.ids.map(id => (g.key === 'running' ? works.has(id) && workRow(works.get(id), base) : rest.has(id) && restRow(rest.get(id), base)) || '')}</section>`
  return html`<main id="inbox" class="off-page" aria-label="Off your mind"><header class="inbox-head desk-top"><h2 class="desk-hello"><a class="off-back" data-nav href="${base}/" aria-label="Back to the Desk">←</a> Off your <em>mind</em></h2><form class="end-search" method="get" action="${base}/stacks/off" role="search"><label><span class="offscreen">Search</span><input type="search" name="q" value="${q}" placeholder="Search the list" autocomplete="off"></label></form></header>
<div class="inbox-groups" id="off-list"><div class="off-groups" id="off-end">${(o?.groups ?? []).map(group)}${o?.none ? html`<p class="end-none">${o.none.en}</p>` : ''}
${o?.more ? html`<form class="end-more" method="post" action="${base}/stacks/off/more"><input type="hidden" name="q" value="${q}"><button type="submit" class="end-more-go">${o.more.says.en}</button></form>` : ''}${o?.loading ? html`<p class="end-none" role="status">Loading…</p>` : ''}</div></div></main>`
}

// ---- controller "goals" ----
// The goals under the greeting. One toggle: folded, the first line; open, all of them; kept per team on this device.
// Written in place: a click turns the words into a field of up to GOALS_LINES lines that grows with them (Enter a new
// line, none past the last; Ctrl/⌘+Enter or a click beside keeps; Esc leaves it as it was). Leaving the field always
// keeps: the blur event, and, because a document without focus sends none, also a press outside it, the page being
// hidden or left, and a look at document.activeElement while the field is open. Kept: Action::SetGoal (POST /desk);
// the core cleans the lines and its echo draws them.
controller('goals', class extends Controller {
  static values = { team: String, text: String, show: String, fold: String }
  connect() {
    this.away = e => { if (this.field && e.target !== this.field) this.done(true) }
    this.left = () => { if (this.field && (document.visibilityState === 'hidden' || document.activeElement !== this.field)) this.done(true) }
  }
  disconnect() { if (this.field) this.done(true) }
  /** The chevron: the goals fold to their first line and open again, per team on this device. */
  toggle() {
    const folded = !this.element.classList.contains('is-folded')
    this.element.classList.toggle('is-folded', folded)
    const t = this.element.querySelector('.desk-goals-toggle')
    if (t) { t.setAttribute('aria-expanded', String(!folded)); t.setAttribute('aria-label', folded ? this.showValue : this.foldValue); t.title = folded ? 'Show all' : 'Fold' }
    try { localStorage.setItem(GOALS_FOLDED, JSON.stringify([...goalsFolded().filter(d => d !== this.teamValue), ...(folded ? [this.teamValue] : [])].slice(-50))) } catch {}
    deskAct?.({ do: 'fold_goals', team_id: this.teamValue, folded })
  }
  edit() {
    if (this.field) return
    const f = this.field = document.createElement('textarea')
    Object.assign(f, { className: 'desk-goals-field', value: this.textValue, rows: 1, maxLength: GOALS_LINES * (GOALS_LINE_MAX + 1), placeholder: `Goals for this team: one a line, up to ${GOALS_LINES}`, spellcheck: true })
    f.setAttribute('aria-label', `This team’s goals, up to ${GOALS_LINES} lines`)
    this.was = this.textValue; this.element.classList.add('is-writing'); this.element.append(f); this.fit()
    f.addEventListener('input', () => this.fit())
    f.addEventListener('keydown', e => this.key(e))
    f.addEventListener('blur', () => this.done(true))
    document.addEventListener('pointerdown', this.away, true)
    document.addEventListener('visibilitychange', this.left)
    window.addEventListener('pagehide', this.left)
    this.watch = setInterval(this.left, 400)
    f.focus(); f.setSelectionRange(f.value.length, f.value.length)
  }
  fit() {
    const f = this.field, lines = f.value.split('\n')
    if (lines.length > GOALS_LINES) { const at = f.selectionStart; f.value = lines.slice(0, GOALS_LINES).join('\n'); f.setSelectionRange(Math.min(at, f.value.length), Math.min(at, f.value.length)) }
    // (as high as its words, wrapped lines too, up to the style's max-height of twelve rows; beyond it scrolls)
    f.style.height = 'auto'; f.style.height = `${f.scrollHeight}px`
  }
  key(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.done(false) }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.done(true) }
    else if (e.key === 'Enter' && this.field.value.split('\n').length >= GOALS_LINES) e.preventDefault()
  }
  done(keep) {
    const f = this.field
    if (!f) return
    this.field = null
    clearInterval(this.watch)
    document.removeEventListener('pointerdown', this.away, true)
    document.removeEventListener('visibilitychange', this.left)
    window.removeEventListener('pagehide', this.left)
    f.remove(); this.element.classList.remove('is-writing')
    if (keep && f.value !== this.was) fetch('/desk', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: this.teamValue, goals: f.value }) }).catch(err => console.warn('desk goals', err))
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
// The Desk's list. A new question must not move the window: a card that arrives out of
// sight is said quietly ("1 new ↓", a tap goes there), and a knock that is out of sight has one strip at the edge
// of the list it lies beyond ("↓ 1 knock"), which leads to the nearest one.
// Which rows stand in sight is told by an IntersectionObserver; a row out of sight is above or below by its place in
// the list (rows are in order), so scrolling costs nothing and no row is measured while a page is being built.

const knocks = n => (n === 1 ? '1 knock' : `${n} knocks`)
const EDGE = 24   // a row closer than this to the window's edge counts as out of sight
const before = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
/** Pull rows DOWN to "Off the desk": a copy of each travels down to the
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

// ---- Select several cards by their session's drawing:
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
    // Cache this list's targets; a morph replacing the list reconnects its observers below.
    this.list = this.listTarget; this.news = this.newsTarget; this.up = document.getElementById('knock-up'); this.down = document.getElementById('knock-down')
    this.across = null
    this.retarget = new MutationObserver(() => { if (this.element.isConnected && this.list !== this.listTarget) { this.disconnect(); this.connect() } })
    this.retarget.observe(this.element, { childList: true, subtree: true })
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
    this.known = new Set()       // ids of every row this list has held (a row drawn again is not new)
    for (const row of this.list.querySelectorAll('.inbox-row')) { this.io.observe(row); this.known.add(row.id) }
    this.mo = new MutationObserver(records => {
      for (const r of records) {
        for (const node of r.addedNodes) if (node.nodeType === 1) for (const row of node.matches('.inbox-row') ? [node] : node.querySelectorAll('.inbox-row')) { this.io.observe(row); if (!this.known.has(row.id)) { this.known.add(row.id); this.unseen.add(row.id) } }   // (a row that came: new until it was in sight; the observer takes it off at once if it is)
        for (const node of r.removedNodes) if (node.nodeType === 1) this.forget(node)
      }
      this.look()
    })
    this.mo.observe(this.list, { childList: true, subtree: true })
    // Where the list stands across, for the strips: read when its box changes (layout is fresh then), never per frame.
    // (read inside the observer, where the layout is fresh: a read in the next frame, after a stream changed the list,
    //  would lay the whole page out once more; the strips are written in the frame)
    this.ro = new ResizeObserver(() => { this.across = this.list.getBoundingClientRect(); this.elTop = this.element.getBoundingClientRect().top; this.look() })
    this.ro.observe(this.list)
    // (folding the sidebar moves the list without resizing it: the window's resize, which the fold sends, measures again)
    this.moved = () => { this.across = this.list.getBoundingClientRect(); this.elTop = this.element.getBoundingClientRect().top; this.look() }
    addEventListener('resize', this.moved)
    this.offSelect = selectWays(this.element)
  }
  disconnect() { this.up?.removeEventListener('click', this.knock); this.down?.removeEventListener('click', this.knock); removeEventListener('resize', this.moved); this.io.disconnect(); this.mo.disconnect(); this.ro.disconnect(); this.retarget.disconnect(); cancelAnimationFrame(this.frame); this.offSelect?.() }
  forget(node) { for (const row of this.shown) if (row === node || node.contains(row)) this.shown.delete(row) }

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
        button.hidden = !n || !this.across?.width
        if (button.hidden) continue
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
// on the row, or a right click. The sheet is rendered once per Desk (rowSheet above): one form whose buttons
// are pointed at the row that was held. No veil; Escape, a tap beside it or focus leaving it closes. The finger
// that held does not open the link under it, and selects no text (the stylesheet takes selection and the callout
// off the row).
// The dialog is opened with show(), not showModal(): a modal dialog makes the whole page inert, and on a phone
// with a full Desk that costs a style recalculation of every element when it opens and again when it closes.
// What a modal dialog gives is done here: a tap beside the sheet only closes it.

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

// ---- the Desk's routes ----
/** The ways of the selection bar, the duck for all and a card page's Later (POST /cards/batch: way, ids): one action
 *  per card; the Undo of its toast posts the way back. */
const BATCH = {
  later: id => ({ do: 'snooze', card_id: id }),
  wake: id => ({ do: 'unsnooze', card_id: id }),
  duck: id => ({ do: 'answer', card_id: id, choices: [], trusted: true }),
  shred: id => ({ do: 'shred', card_id: id }),
  read: id => ({ do: 'read', card_id: id }),
  reopen: id => ({ do: 'decide_again', card_id: id }),
}
/** Which way a card of this kind takes (a request is never put aside here; "sweep": the duck for all). */
const WAY = {
  later: k => k !== 'request' && 'later', shred: k => k !== 'request' && 'shred', duck: k => k === 'decision' && 'duck', read: k => k === 'info' && 'read',
  sweep: k => (k === 'info' ? 'read' : k === 'decision' && 'duck'), wake: () => 'wake', reopen: () => 'reopen',
}
const BACK = { later: 'wake', duck: 'reopen', shred: 'reopen', read: 'reopen', sweep: 'reopen' }
const SAID = { later: WORDS.later, duck: 'Left to the agents', shred: 'Shredded', read: 'Read', sweep: 'Left to the agents' }

export function register(t) {
  deskVm = t.vm
  deskAct = t.act
  // (the teams whose goals are folded on this device: the core holds them for its run)
  for (const team_id of goalsFolded()) t.act({ do: 'fold_goals', team_id, folded: true })
  const desk = () => t.vm().desk
  const place = () => t.vm().sidebar?.place?.en ?? 'Desk'
  t.get(/^\/$/, ({ req, res }) => {
    const d = desk()
    t.page(req, res, { title: d.waiting ? `(${d.waiting}) ${place()} · Trommi` : `${place()} · Trommi`, view: 'desk', main: deskMain(d, t.BASE) })
  })
  t.get(/^\/blitz$/, ({ res }) => {
    const first = desk().rows?.[0]
    t.redirect(res, first ? `${cardPath(first.id, t.BASE)}?walk=1` : `${t.BASE}/`)
  })
  // The complete list with its search (Screen::Off, the query from ?q=: app.mjs screenOf); "Show more" grows its window.
  t.get(/^\/stacks\/off$/, ({ req, res }) => t.page(req, res, { title: `Off your mind · ${place()} · Trommi`, view: 'off', main: offMain(t.vm().off, t.BASE) }))
  t.post(/^\/stacks\/off\/more$/, ({ res, form }) => { t.act({ do: 'show_more', of: { list: 'off', query: String(form?.get('q') ?? '') } }); t.done(res) })

  t.post(/^\/cards\/batch$/, ({ req, res, form }) => {
    const way = String(form.get('way') ?? '')
    if (!Object.hasOwn(WAY, way)) { res.code = 400; return }
    const rows = new Map((desk().rows ?? []).map(r => [r.id, r]))
    const ids = [...new Set(String(form.get('ids') ?? '').split(',').filter(id => /^[0-9a-f]+$/.test(id)))]
    const done = [], used = new Set()
    for (const id of ids) { const w = WAY[way](rows.get(id)?.kind ?? 'decision'); if (w) { t.act(BATCH[w](id)); done.push(id); used.add(w) } }
    // From a card's own page (from: that card): back to its session, or on to the next row of the Desk
    if (form.has('from')) {
      const back = String(form.get('back') ?? '')
      if (back.startsWith(`${t.BASE}/chat/`) && /^[\w\-/%+.]+$/.test(back)) return t.redirect(res, back)
      const stack = desk().stack, from = String(form.get('from')), next = stack[stack.indexOf(from) + 1] ?? stack.find(id => id !== from)
      return t.redirect(res, next ? `${cardPath(next, t.BASE)}${form.has('focus') ? '?focus=1' : ''}` : `${t.BASE}/`)
    }
    if (form.has('undo') || !done.length) return t.done(res)
    const n = done.length
    t.sendStream(req, res, t.toast({ head: way === 'sweep' && !used.has('duck') ? SAID.read : SAID[way], line: n === 1 ? rows.get(done[0])?.title ?? '1 card' : `${n} cards`, undo: BACK[way] ? { action: `${t.BASE}/cards/batch`, fields: { way: BACK[way], ids: done.join(',') } } : null }))
  })

  // The goals written in place (controller "goals": fetch POST /desk, JSON { id, goals }). (The menu's teams act
  // themselves: sidebar.mjs.)
  t.post(/^\/desk$/, ({ res, json }) => {
    if (!json?.id || typeof json.goals !== 'string') return t.json(res, { error: 'nothing to do' }, 400)
    t.act({ do: 'set_goal', team_id: String(json.id), text: json.goals })
    t.json(res, { ok: true })
  })

  // Rows beyond the first ones stand empty until they come near (startDeskWindow): their markup is made then.
  if (typeof IntersectionObserver === 'function') startDeskWindow(id => { const r = desk().rows?.find(x => x.id === id); if (!r) return ''; filled.add(id); return String(deskRow(r, t.BASE, { slim: true })) })
}
