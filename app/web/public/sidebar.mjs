// The sidebar (#agents): one row per session, a main with its subs under it, and the floating Desk's state.
// The markup is the one app.css and sidebar.css style (the old client built it in js/agents.js).
import { BASE, crownOf, renderStreamMessage, stream } from './app.mjs'
import { BELL, Controller, PLUS, avatar, badge, controller, crownSvg, edgeQuirk, html, raw, sk, sketchSvg, toast } from './ui.mjs'
const EDGES = 7   // more subs than this lie in a folded stack without an edge of their own

function row(u, base, current) {
  const a = u.agent
  const shut = Boolean(u.subs)   // a main is rendered folded; the island "folds" opens the ones this browser unfolded
  const shown = shut ? u.whole : u
  const names = u.subs?.map(s => s.agent.name) ?? []
  const tip = u.subs ? `Unfold ${a.name}'s ${names.length === 1 ? 'sub' : `${names.length} subs`}: ${names.join(', ')}` : ''
  const lie = u.subs ? (u.subs.length > EDGES ? [...u.subs].sort((x, y) => Boolean(y.blocked) - Boolean(x.blocked)).slice(0, EDGES) : u.subs) : []
  const cls = ['agent-row', u.parent && 'is-sub', (a.main || u.subs) && 'is-main', shown.open || shown.blocked ? 'has-badge' : '', !u.online && 'is-offline', current === u.id && 'is-active'].filter(Boolean).join(' ')
  return html`<div class="${cls}" id="agent-${a.id}" data-folds-target="row" data-unit="${a.id}" data-members="${a.id}"${u.parent ? html` data-parent="${u.parent.id}" hidden` : ''}${u.subs ? html` data-fold="shut" style="--ghue:${a.hue};--n:${lie.length}" data-controller="lean" data-action="pointermove->lean#follow pointerleave->lean#rest"` : ''}>
<a class="agent-entry" data-nav href="${base}/s/${encodeURIComponent(a.id)}" draggable="false" title="${shown.online && shown.running ? `Working${a.task ? `: ${a.task}` : ''}` : a.task ?? ''}"${current === u.id ? raw(' aria-current="page"') : ''}>${avatar(a, { crown: !u.subs, working: Boolean(shown.online && shown.running) })}<span class="agent-text"><strong>${a.name}</strong>${shown.online && shown.running ? html`<span class="sr-only"> (working)</span>` : ''}</span></a>
${u.subs ? html`<button class="crown-fold${a.starred ? '' : ' is-plain'}" type="button" aria-expanded="false" title="${tip}" aria-label="${tip}" data-action="click->folds#toggle" data-folds-id-param="${a.id}">${a.starred ? raw(crownSvg()) : ''}</button>
<svg class="crown-bracket" aria-hidden="true" data-folds-target="bracket"><path/><path class="crown-bracket-hit" data-action="click->folds#toggle" data-folds-id-param="${a.id}"><title>Fold ${a.name}'s subs</title></path></svg>
<span class="crown-edges" title="${tip}" data-action="click->folds#toggle" data-folds-id-param="${a.id}">${lie.map((s, i) => { const q = edgeQuirk(s.id); return html`<i${s.blocked ? raw(' class="is-knock"') : ''} style="--i:${i};--hue:${s.agent.hue};--tilt:${q.tilt}deg;--dx:${q.dx}px">${raw(q.svg)}</i>` })}</span>` : ''}
${badge(u, shown, base)}
</div>`
}

const inviteAgentButton = () => html`<form method="post" action="/pair" class="agent-invite"><input type="hidden" name="role" value="agent"><button type="submit" class="agent-invite-go" id="sidebar-invite" title="Invite an agent" aria-label="Invite an agent">${PLUS}<span class="agent-invite-label">New agent</span></button></form>`

// ---- the note in the sidebar (his word, 4 October: "nur EINE Notiz") ----
// At the sidebar's foot, a fixed anchor (his word, 4 October: "immer unten links"): one yellow sticky. Folded it shows the note's first line, or "New note" when empty; a click
// unfolds it upward into a field that grows with the words (Enter: a new line, Ctrl/Cmd+Enter sends), with the crown
// (send straight to the crown, as the memo did) and the bin. Sent or thrown away, it is "New note" again. It is the
// desk's newest unsent note (place "stack", no session). Folded rail: the sticky with a dot when it holds words. A
// phone: a chip that opens it as a sheet.
const NOTE_ICON = raw('<svg viewBox="0 0 52 52" class="side-note-ico" aria-hidden="true"><path class="note-fill" d="M9.5 11.2 Q25 9.6 42.6 10.6 Q43.4 25 42.8 38.4 L35.4 45.4 Q21 46.6 9.8 45.8 Q8.6 28 9.5 11.2 Z"/><path class="note-ink" d="M7.6 9.4 Q24 8.2 41.4 8.8 Q42.4 23.6 41.6 37.2 L34.2 44.2 Q20.4 45.2 8.2 44.4 Q6.8 27 7.6 9.4 Z"/><path class="note-ink" d="M41.6 37.2 Q37.2 36.6 34.8 37.6 Q34.1 40.8 34.2 44.2"/><path class="note-lines" d="M14.2 19.4 Q22 18.8 30.6 19.2 M14 25.6 Q20 25.1 26.4 25.5 M14.3 31.6 Q18.6 31.2 22.4 31.5"/></svg>')
const BIN = raw('<svg viewBox="0 0 24 24" class="sketch" aria-hidden="true"><path d="M5 7.2 Q12 6.8 19 7.3"/><path d="M9.6 6.9 Q9.8 4.8 12 4.7 Q14.3 4.8 14.4 6.9"/><path d="M6.6 7.6 Q7.4 14 8.2 20.2 Q12 20.6 15.8 20.2 Q16.6 14 17.4 7.6"/></svg>')
const deskNotesOf = model => (model.state.memos ?? []).filter(m => m.place === 'stack' && !m.held && !m.session && (!m.desk || !model.desk || m.desk === model.desk)).sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
function sideNotes(model, base) {
  const note = deskNotesOf(model)[0] ?? null, crown = crownOf(model)
  const text = note?.text ?? ''
  const first = text.split('\n')[0].trim()
  return html`<section class="side-notes${text ? ' has-words' : ''}" id="side-notes" aria-label="Your note" data-controller="side-note" data-side-note-id-value="${note?.id ?? ''}" data-side-note-base-value="${base}">
<button type="button" class="side-note-head" data-action="side-note#open" title="${text ? 'Your note: open it' : 'New note (N)'}" aria-expanded="false">${NOTE_ICON}<span class="side-note-first">${first || 'New note'}</span></button>
<div class="side-note-body" hidden><textarea class="side-note-field" rows="2" aria-label="Your note${crown ? ` to ${crown.name}` : ''}" data-action="input->side-note#typed keydown->side-note#key">${text}</textarea>
<footer class="side-note-foot"><button type="button" class="side-note-bin" data-action="side-note#bin" title="Throw the note away" aria-label="Throw the note away">${BIN}</button><i></i>${crown ? html`<button type="button" class="quick-send memo-send side-note-send" data-action="side-note#send" title="Send to ${crown.name} (Ctrl+Enter)" aria-label="Send to ${crown.name}">${raw(crownSvg())}</button>` : html`<a class="side-note-nocrown" data-nav href="${base}/agents">Give a session the crown to send</a>`}</footer></div>
</section>`
}
controller('side-note', class extends Controller {
  static values = { id: String, base: String }
  connect() {
    this.field = this.element.querySelector('.side-note-field')
    this.guard = e => { if (e.target?.getAttribute?.('target') === 'side-notes' && this.element.classList.contains('is-open')) e.preventDefault() }
    document.addEventListener('turbo:before-stream-render', this.guard)
    this.write = () => this.open()
    document.addEventListener('trommi:memo', this.write)
  }
  disconnect() { document.removeEventListener('turbo:before-stream-render', this.guard); document.removeEventListener('trommi:memo', this.write); clearTimeout(this.timer) }
  async post(path, fields = {}) {
    const res = await fetch(`${this.baseValue}${path}`, { method: 'POST', headers: { Accept: 'text/vnd.turbo-stream.html', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) })
    const text = await res.text()
    if (text) renderStreamMessage(text)
    return res.ok
  }
  open() {
    this.element.classList.add('is-open')
    this.element.querySelector('.side-note-head').setAttribute('aria-expanded', 'true')
    this.element.querySelector('.side-note-body').hidden = false
    this.fit(); this.field.focus(); this.field.setSelectionRange(this.field.value.length, this.field.value.length)
    this.away = e => { if (!this.element.contains(e.target)) this.close() }
    setTimeout(() => document.addEventListener('pointerdown', this.away), 0)
  }
  close() {
    document.removeEventListener('pointerdown', this.away)
    this.element.classList.remove('is-open')
    this.element.querySelector('.side-note-head').setAttribute('aria-expanded', 'false')
    this.element.querySelector('.side-note-body').hidden = true
    const first = this.field.value.trim().split('\n')[0].trim()
    this.element.querySelector('.side-note-first').textContent = first || 'New note'
    this.element.classList.toggle('has-words', Boolean(first))
    this.save(true)
  }
  fit() { this.field.style.height = 'auto'; this.field.style.height = `${Math.min(this.field.scrollHeight + 2, 320)}px` }
  typed() { this.fit(); clearTimeout(this.timer); this.timer = setTimeout(() => this.save(), 600) }
  key(e) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.send() }
    else if (e.key === 'Escape') { e.preventDefault(); this.close() }
  }
  // The words are kept as they stand: a note of place "stack" (made the first time there are words, gone when empty).
  async save(now = false) {
    clearTimeout(this.timer)
    const text = this.field.value
    if (this.saving) { this.again = true; return }
    this.saving = true
    try {
      if (!this.idValue) {
        if (!text.trim()) return
        await this.post('/memos', { place: 'stack', text })
        const made = deskNotesOf(window.trommi?.model?.() ?? { state: {} })[0]
        if (made) this.idValue = made.id
      } else await this.post(`/memos/${this.idValue}/stack`, { text })
      if (!text.trim()) this.idValue = ''
    } finally { this.saving = false; if (this.again) { this.again = false; this.save() } }
  }
  async send() {
    const text = this.field.value
    if (!text.trim()) return this.field.focus()
    if (!this.idValue) { await this.save(); if (!this.idValue) return }
    const id = this.idValue
    this.idValue = ''; this.field.value = ''
    this.close()
    await this.post(`/memos/${id}/send`, { text })
  }
  async bin() {
    const id = this.idValue, text = this.field.value
    this.idValue = ''; this.field.value = ''
    this.close()
    if (id) await this.post(`/memos/${id}/bin`, { text })
  }
})

/** The rows of #agents: the sessions (the Scribble Board is the back of the Desk: its page corner). current: the session in view, if any. */
export function sidebarRows(model, base, current = null) {
  const { here, away } = sidebarParts(model, base, current)
  return html`${here.map(r => r[1])}${inviteAgentButton()}${away.length ? html`<h2 class="caps agent-heading agent-heading-away">Disconnected</h2>${away.map(r => r[1])}` : ''}${sideNotes(model, base)}`
}
/** The same rows one by one, for the live stream: [id, row] of those connected (here) and those that are not (away);
 *  shape says their order, so that a change within one row replaces that row only (turbo.mjs). */
function sidebarParts(model, base, current = null) {
  const top = model.units.filter(u => !u.parent)
  const rows = u => [[u.id, row(u, base, current)], ...(u.subs ?? []).map(s => [s.id, row(s, base, current)])]
  const live = u => u.online || Boolean(u.subs?.some(s => s.online))
  const here = top.filter(live).flatMap(rows), away = top.filter(u => !live(u)).flatMap(rows)
  return { here, away, shape: `${here.map(r => r[0]).join(' ')}|${away.map(r => r[0]).join(' ')}` }
}

/** The Desk box's drawing (#desk-lamp, kept current by the live stream): the desk with its lamp lit while something
 *  waits on it (open questions of this desk's sessions), dark when it is clear. No count and no hand beside it (his word,
 *  4 October): what waits is on the Desk, a stopped session shows its hand in its own row. */
function deskLamp(model) {
  const desks = model.state.desks?.length ? model.state.desks : [{ id: DEFAULT_DESK }]
  const here = c => { const d = model.byAgent.get(c.agent)?.desk; return (desks.some(x => x.id === d) ? d : desks[0].id) === (model.desk ?? desks[0].id) }
  return deskMark(model.fresh.some(here))   // (a knock of another desk stands on this one too, but lights its own lamp)
}

const $ = (sel, root = document) => root.querySelector(sel)
const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch { return fallback } }
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)) } catch {} }

// The sidebar: a main's subs fold away behind its crown. Which mains are open is this browser's own (localStorage);
// the hub renders them folded, and every row that arrives (also by a stream) is put the way this browser has it.
const FOLD_KEY = 'trommi-crowns-open'
// An unfolded main's subs are held together by a bracket drawn with the pen down their left side (card Nr. 160,
// "stack + bracket"); folded, the subs lie as card edges under the main and the bracket is gone.
const wob = (i, s) => (((Math.sin(i * 127.1 + 3.7) * 43758.5453) % 1 + 1) % 1 - .5) * 2 * s
function penLine(pts) {
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i], [nx, ny] = pts[i + 1]
    d += ` Q ${x.toFixed(1)} ${y.toFixed(1)} ${((x + nx) / 2).toFixed(1)} ${((y + ny) / 2).toFixed(1)}`
  }
  const last = pts.at(-1)
  return `${d} L ${last[0].toFixed(1)} ${last[1].toFixed(1)}`
}
controller('folds', class extends Controller {
  static targets = ['row', 'bracket']
  connect() { this.draw = () => this.brackets(); addEventListener('resize', this.draw); requestAnimationFrame(this.draw) }
  disconnect() { removeEventListener('resize', this.draw) }
  rowTargetConnected(row) { this.apply(row); cancelAnimationFrame(this.frame); this.frame = requestAnimationFrame(() => this.brackets()) }
  brackets() {
    // Nothing unfolded: no bracket to draw, and no layout to force.
    if (!this.element.querySelector('.agent-row[data-fold="open"]')) { for (const svg of this.bracketTargets) svg.style.display = 'none'; return }
    const flat = getComputedStyle(this.element).flexDirection === 'row'   // a phone's strip runs sideways: the bracket runs under the subs
    this.bracketTargets.forEach((svg, gi) => {
      const main = svg.closest('.agent-row')
      const subs = this.rowTargets.filter(r => r.dataset.parent === main?.dataset.unit && !r.hidden)
      if (!main || main.dataset.fold !== 'open' || !subs.length) { svg.style.display = 'none'; return }
      svg.style.display = ''
      const G = main.getBoundingClientRect(), first = subs[0].getBoundingClientRect(), last = subs.at(-1).getBoundingClientRect()
      const w = i => wob(gi * 17 + i, 1.1)
      let pts
      if (flat) { const y = G.height + 3, x0 = first.left - G.left + 3, x1 = last.right - G.left - 3; pts = [[x0, y - 7], [x0 + w(1), y], [(x0 + x1) / 2, y - 1 + w(2)], [x1 + w(3), y], [x1, y - 7]] }
      else { const x = document.documentElement.dataset.rail === 'folded' ? 3 : 13, y0 = G.height - 10, y1 = last.bottom - G.top - 8; pts = [[x + 9, y0 - 6], [x, y0 + 4 + w(1)], [x + w(2), (y0 + y1) / 2], [x, y1 + w(3)], [x + 9, y1]] }
      for (const p of svg.querySelectorAll('path')) p.setAttribute('d', penLine(pts))
    })
  }
  toggle({ params: { id } }) {
    const open = new Set(read(FOLD_KEY, []))
    if (open.has(id)) open.delete(id); else open.add(id)
    write(FOLD_KEY, [...open])
    for (const row of this.rowTargets) this.apply(row)
    this.brackets()
  }
  apply(row) {
    const open = new Set(read(FOLD_KEY, []))
    if (row.dataset.parent) row.hidden = !open.has(row.dataset.parent)
    if (!row.hasAttribute('data-fold')) return
    const is = open.has(row.dataset.unit)
    row.dataset.fold = is ? 'open' : 'shut'
    row.querySelector('.crown-fold')?.setAttribute('aria-expanded', String(is))
    const edges = row.querySelector('.crown-edges')
    if (edges) edges.hidden = is
  }
})

// ---- menu ----
// The Trommi menu (what opens from the floating pill at the top centre), the jump page's results (/jump; the menu
// itself has no search field for now), and the sheet a long press on a Desk row brings up on a phone. The menu's markup is the old client's (index.html,
// js/bar.js), so app.css and sidebar.css style it; the controller controller "menu" adds the
// arrows and a new desk, sheet_controller.js the long press. Opening and closing the
// menu and the theme: ui.mjs.

const DEFAULT_DESK = 'main'

/** The desks with what waits on each: [{ id, name, open, knocks }]. */
function desksOf(model) {
  const desks = model.state.desks?.length ? model.state.desks : [{ id: DEFAULT_DESK, name: 'Desk' }]
  const deskOf = card => { const d = model.byAgent.get(card.agent)?.desk; return desks.some(x => x.id === d) ? d : desks[0].id }
  return desks.map(d => { const mine = (model.allFresh ?? model.fresh).filter(c => deskOf(c) === d.id); return { id: d.id, name: d.name || 'Desk', open: mine.length, knocks: mine.some(c => ['high', 'critical'].includes(c.urgency)) } })
}

// Small drawings of the menu's own, in the pen's line: Log out, the plus of "New desk", and the light of the desk lamp.
// Log out: a door frame, open to the right, and an arrow walking out of it.
const LEAVE = raw('<svg viewBox="0 0 24 24" class="sketch" aria-hidden="true" style="rotate:-1deg"><path d="M10.2 4.3Q7.4 4.1 5.2 4.4Q4.9 12.1 5.2 19.7Q7.7 19.9 10.1 19.8"/><path d="M9.4 12.2Q14.5 11.8 19.5 12.1"/><path d="M16.3 8.7Q18.2 10.4 19.6 12.1Q18 13.8 16.2 15.3"/></svg>')
const NEW_DESK = raw('<svg viewBox="0 0 24 24" class="sketch" aria-hidden="true" style="rotate:3deg"><path d="M12.2 5.2Q11.8 12 12 18.8"/><path d="M5.3 12.3Q12 11.7 18.7 12.1"/></svg>')
// The lamp switched on, drawn under the desk's lines: the shade glowing, a soft cone of light down onto the top, three short rays.
const LIGHT = '<g class="lamp-light"><path class="lamp-glow" d="M14.9 2.4Q11.7 3.7 10.7 4.7Q9.6 5.7 9 6.6Q8.5 7.4 9 7.6Q9.5 7.9 12.4 7Q15.2 6.1 15.6 6.1Q15.9 6.1 15.8 4.7Q15.7 3.4 14.9 2.4Z"/><path class="lamp-cone" d="M9.2 7.9Q12.4 7.1 15.6 6.3L17.3 11.9Q12 12.1 6.4 12.2Z"/><path d="M7.6 9Q5.9 10.1 4.3 11.2"/><path d="M7.1 7.2Q5.3 7.3 3.5 7.5"/><path d="M7.9 5Q6.4 4.2 4.9 3.5"/></g>'
/** The desk drawing of the menu's desk rows and the Desk box: its lamp lit while something waits on that desk. */
const deskMark = lit => raw(lit ? sketchSvg('desk', 'menu-lamp is-lit').replace(/(<svg[^>]*>)/, `$1${LIGHT}`) : sketchSvg('desk', 'menu-lamp'))

/** The desk rows of the menu (#menu-desk-rows, kept current by the live stream): the desk in view checked (the marked
 *  row); a desk's lamp is lit while something waits on it. */
function menuDeskRows(model, base) {
  const desks = desksOf(model)
  const here = d => (model.desk ? d.id === model.desk : d === desks[0])
  return html`<span class="menu-desk-rows" id="menu-desk-rows">${desks.map((d, i) => html`<a role="menuitemradio" class="menu-desk" data-nav draggable="false" href="${base}/?desk=${d.id}" data-desk="${d.id}" aria-checked="${String(here(d))}">${deskMark(d.open > 0)}<b>${d.name}</b><i${d.knocks && i ? raw(' class="is-knock"') : ''}>${d.open} open</i>${i < 9 ? html`<kbd>${i + 1}</kbd>` : ''}</a>`)}</span>`
}

/** The menu: <nav id="brand-doors">, hidden until the pill or the Desk box's caret is pressed (or Ctrl K).
 *  Three calm groups: the desks, each a row with the desk drawing (lamp lit while something waits there; the desk in
 *  view is the marked row), the Demo as one more desk, and a quiet "New desk" (a line to name it, Enter makes it);
 *  places (Agents & devices, Help, Keys); this device (Push, Log out, and the theme as a small sun/moon beside Log out).
 *  The connection is not said here: a lost one is a dot on the pill (app.mjs). */
function menuDoors(model, base) {
  return html`<nav class="sidedoors" id="brand-doors" role="menu" aria-label="Desks, places and settings" data-controller="menu" data-menu-desk-value="${base}/" data-action="keydown->menu#walk click->menu#chosen" hidden>
<div class="menu-desks" id="menu-desks">${menuDeskRows(model, base)}
<a role="menuitem" class="menu-desk is-demo" href="${base}/?mock=1" data-turbo="false" draggable="false" id="dev-mock" title="The demo: a made-up room, nothing is kept">${deskMark(false)}<b>Demo</b><i>sample room</i></a>
<button type="button" role="menuitem" class="menu-desk-add" id="desk-add" data-action="click->menu#newDesk" aria-label="New desk">${NEW_DESK}<span>New desk</span></button>
<form class="menu-desk-form" id="desk-new" data-menu-target="deskForm" data-action="submit->menu#makeDesk" hidden><input class="menu-desk-field" data-menu-target="deskName" data-action="keydown->menu#deskKey" maxlength="40" placeholder="Name of the new desk" aria-label="Name of the new desk" autocomplete="off"><button type="submit">Make</button></form>
<p class="menu-desk-error" data-menu-target="deskError" role="alert"></p></div>
<div class="menu-grid"><a role="menuitem" href="${base}/agents" data-nav draggable="false" id="menu-agents" title="Agents and devices: the sessions, and who is in the room">${sk('heads')}<span>Agents &amp; devices</span></a><a role="menuitem" href="${base}/assets" data-nav draggable="false" id="menu-assets" title="Media: everything your agents sent">${sk('picture')}<span>Media</span></a><a role="menuitem" href="/help.html">${sk('page')}<span>Help</span></a><button role="menuitem" type="button" id="keys-open" data-action="click->menu#keys" aria-haspopup="dialog" aria-keyshortcuts="?">${sk('keycap')}<span>Keys</span></button></div>
<div class="menu-foot"><button role="menuitemcheckbox" type="button" id="push-toggle" aria-checked="false" aria-label="Push on this device">${sk('bell')}</button></div>
<div class="menu-leave"><a role="menuitem" href="${base}/logout" data-nav draggable="false" id="menu-logout" class="menu-logout" title="Log out of this device">${LEAVE}<span>Log out</span></a><button role="menuitemcheckbox" type="button" id="theme-toggle" class="menu-theme" aria-label="Light or dark (T)" title="Light or dark (T)">${raw(sketchSvg('moon', 'ico-moon'))}${raw(sketchSvg('sun', 'ico-sun'))}</button></div>
</nav>`
}

// ---- the frame's top: the floating Desk with the desk switcher and the Trommi menu; the rail's fold ----
export const RAIL_FOLD = raw(`<button type="button" class="rail-fold" data-controller="rail" data-action="click->rail#toggle pointerover@document->rail#tip focusin@document->rail#tip focusout@document->rail#untip turbo:before-cache@document->rail#untip" title="Fold the sidebar to a rail ( [ )" aria-label="Fold the sidebar to a rail ( [ )" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.3 4.4Q4.8 11.6 5.4 19.7"/><path d="M15.1 6.1Q12.2 9.2 9.1 12.1Q12.1 14.7 14.8 18"/></svg></button>`)

/** How big the desk's name may stand in the Desk box: s (as "Desk"), m (a little smaller), l (two smaller lines). */
const nameSize = name => { const n = [...String(name)].length; return n <= 6 ? 's' : n <= 11 ? 'm' : 'l' }
export function topbar(model, base, current, view = '') {
    return html`<header class="topbar"><div class="brand">
<h1 class="deskpill"><a href="${base}/" data-nav draggable="false" class="desk-go" id="desk-go" title="Desk ${model.deskName}: everything that waits for you"${current ? raw(' aria-current=""') : ''}><span class="desk-lamp" id="desk-lamp">${deskLamp(model)}</span>${BELL}<span class="desk-name" data-size="${nameSize(model.deskName)}">${model.deskName}</span></a>
<button type="button" class="brand-open" id="brand-menu" aria-haspopup="menu" aria-expanded="false" aria-controls="brand-doors" aria-label="Menu: jump, desks, places, settings">${raw(String(BELL).replace('class="brand-mark"', 'class="brand-mark pill-mark"'))}<b class="pill-word">Trommi</b><span class="conn pill-conn" id="conn" data-state="connecting" role="status"><i aria-hidden="true"></i><span id="conn-text" class="tc-sr">Connecting</span></span><span class="brand-fold">${sk('unfold')}</span></button></h1>
${menuDoors(model, base)}
</div>
<a href="${base}/agents" data-nav draggable="false" class="icon-btn roster-open" id="roster-open" aria-label="Agents" title="Agents"${view === 'agents' ? raw(' aria-current="page"') : ''}>${sk('heads')}</a></header>`
}

// ---- controller "menu" ----
// The Trommi menu (sidebar.mjs renders it; ui.mjs opens and closes it and switches the theme).
// Here: the arrows through the entries, a new desk, and "#jump" in the address, which opens it (the menu has no
// search field for now; Ctrl K opens the menu with the keyboard on the desk in view).

/** Go to a page the way a click on a link does (Turbo for the pages rendered here, a whole load for the others). */
function go(path) {
  const a = document.createElement('a')
  a.href = path
  a.style.display = 'none'
  document.body.append(a)
  a.click()
  a.remove()
}

controller('menu', class extends Controller {
  static targets = ['deskForm', 'deskName', 'deskError']
  static values = { desk: String }

  connect() {
    // Opened (the pill, Ctrl+K, G then J): the menu takes the keyboard; the first arrow goes to the desk in view.
    this.element.tabIndex = -1
    this.watch = new MutationObserver(() => { if (!this.element.hidden && !this.element.contains(document.activeElement)) this.element.focus({ preventScroll: true }) })
    this.watch.observe(this.element, { attributes: true, attributeFilter: ['hidden'] })
    // A refresh of the page (the live stream's "refresh" morphs it) must not shut the menu, the desk line or Dev under the hand.
    this.keep = e => {
      const t = e.target, name = e.detail?.attributeName
      if ((t === this.element && name === 'hidden') || (t.id === 'brand-menu' && name === 'aria-expanded') || (t.id === 'desk-new' && name === 'hidden')) e.preventDefault()
    }
    document.addEventListener('turbo:before-morph-attribute', this.keep)
    this.away = e => { if (!this.element.hidden && e.target instanceof Element && !e.target.closest('.brand')) this.close() }
    document.addEventListener('focusin', this.away)
    if (location.hash === '#jump') {
      history.replaceState(history.state, '', location.pathname + location.search)
      this.element.hidden = false
      this.opener?.setAttribute('aria-expanded', 'true')
    }
  }
  disconnect() {
    this.watch.disconnect()
    document.removeEventListener('focusin', this.away)
    document.removeEventListener('turbo:before-morph-attribute', this.keep)
    clearTimeout(this.timer)
  }
  get opener() { return document.getElementById('brand-menu') }
  get items() { return [...this.element.querySelectorAll('[role^="menuitem"], [role="option"]')].filter(n => n.checkVisibility()) }
  close() {
    this.element.hidden = true
    this.opener?.setAttribute('aria-expanded', 'false')
    delete this.element.dataset.from
  }

  /** Where the keyboard starts: the desk in view (its lamp on), else the first entry. */
  home() { return this.element.querySelector('.menu-desk[aria-checked="true"]') ?? this.items[0] }
  // The arrows walk the entries, round at both ends.
  walk(event) {
    const all = this.items, at = all.indexOf(document.activeElement)
    if (at < 0 && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); return this.home()?.focus() }
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: all.length - 1 }[event.key]
    if (to == null) return
    event.preventDefault()
    all[(to + all.length) % all.length]?.focus()
  }

  // ---- entries ----
  // A choice closes the menu; a switch (theme, push) leaves it open.
  // ("New desk" opens its line and leaves the menu open.)
  chosen(event) { if (event.target.closest('[role="menuitem"]:not([data-menu-body-param]):not(#desk-add), [role="menuitemradio"], [role="option"]')) this.close() }

  // ---- a new desk: "+" opens a line for its name; Enter makes it (POST /desk, the hub's desks) and goes there ----
  newDesk() {
    this.deskFormTarget.hidden = !this.deskFormTarget.hidden
    this.deskErrorTarget.textContent = ''
    if (!this.deskFormTarget.hidden) this.deskNameTarget.focus()
  }
  deskKey(event) {
    event.stopPropagation()   // the arrows and keys of the menu are not this line's
    if (event.key === 'Escape') { event.preventDefault(); this.deskNameTarget.value = ''; this.deskFormTarget.hidden = true; this.deskErrorTarget.textContent = ''; this.element.querySelector('#desk-add')?.focus() }
  }
  async makeDesk(event) {
    event.preventDefault()
    const name = this.deskNameTarget.value.trim()
    if (!name) return this.deskNameTarget.focus()
    try {
      const res = await fetch('/desk', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
      let out = {}
      try { out = await res.json() } catch {}
      if (!res.ok || !out.desk?.id) { this.deskErrorTarget.textContent = `Not made: ${out.error || res.statusText}`; return }
      this.deskNameTarget.value = ''
      this.deskFormTarget.hidden = true
      this.close()
      const made = out.desk.id, home = this.deskValue
      go(`${home}?desk=${encodeURIComponent(made)}`)
      // Undo takes the new desk away again and goes back to the default desk.
      toast({ head: 'Desk added', line: out.desk.name ?? name, undo: async () => {
        const res = await fetch('/desk', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: made, remove: true }) })
        if (!res.ok) { toast({ head: 'Not undone', line: 'the desk could not be taken away', role: 'alert' }); return }
        go(`${home}?desk=main`)
      } })
    } catch { this.deskErrorTarget.textContent = 'Not made: the board did not answer.' }
  }
  keys() { this.close(); document.dispatchEvent(new CustomEvent('trommi:keys')) }
})

// ---- controller "rail" ----
// The rail (card Nr. 150): the sidebar folded to the sessions' drawings with their marks (crown, bracket, the drawing
// that fills itself in while a session works, the count). Wide screens only (app.css, [data-rail="folded"]).
// The small "|<" at the sidebar's foot folds and opens it, and so does the key [ (ui.mjs (keys) presses this button).
// Remembered per browser: the layout's head sets data-rail on <html> before first paint; this controller only flips it.
// The rail shows no names, so a row says its name in a note beside it while the pointer or the keyboard is on it.

const KEY = 'trommi-rail'
const wide = () => matchMedia('(min-width: 861px)').matches
const folded = () => document.documentElement.dataset.rail === 'folded'

controller('rail', class extends Controller {
  connect() { this.paint() }
  disconnect() { this.untip() }

  toggle() {
    if (!wide()) return
    const fold = !folded()
    if (fold) document.documentElement.dataset.rail = 'folded'; else delete document.documentElement.dataset.rail
    try { fold ? localStorage.setItem(KEY, 'folded') : localStorage.removeItem(KEY) } catch {}
    this.untip()
    this.paint()
    dispatchEvent(new Event('resize'))   // the brackets of unfolded mains are drawn again for the new width
  }

  paint() {
    const label = `${folded() ? 'Open the sidebar' : 'Fold the sidebar to a rail'} ( [ )`
    this.element.title = label
    this.element.setAttribute('aria-label', label)
    this.element.setAttribute('aria-pressed', String(folded()))
  }

  tip(event) {
    const row = event.target.closest?.('#agents .agent-row')
    if (row === this.row) return
    this.untip()
    if (!row || !folded() || !wide()) return
    const name = row.querySelector('.agent-text strong')?.textContent.trim()
    if (!name) return
    const r = row.getBoundingClientRect()
    const note = document.createElement('div')
    note.className = 'rail-tip'
    note.setAttribute('aria-hidden', 'true')
    note.textContent = name
    note.style.left = `${Math.round(r.right + 10)}px`
    note.style.top = `${Math.round(r.top + r.height / 2 - 13)}px`
    document.body.append(note)
    this.row = row
    this.note = note
    // The sidebar scrolls under a still pointer: the note would stand beside the wrong row.
    this.off = () => this.untip()
    document.getElementById('agents')?.addEventListener('scroll', this.off, { once: true, passive: true })
  }

  untip() {
    this.note?.remove()
    if (this.off) document.getElementById('agents')?.removeEventListener('scroll', this.off)
    this.note = this.row = this.off = null
  }
})

// ---- controller "lean" ----
// A crowned main's folded stack in the sidebar (sidebar.mjs, sidebar.css): when the pointer thumbs it, its
// card edges fan out towards the side the mouse is on. Over the middle they go straight down, at the right they lean
// right, at the left they lean left. Sets --lean (-1 … 1) and --lean-abs (0 … 1) on the row; the CSS turns them into
// the fan. A mouse or pen only (a touch has no hover), and nothing under prefers-reduced-motion.

controller('lean', class extends Controller {
  disconnect() { this.rest() }
  follow(event) {
    if (event.pointerType === 'touch' || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    this.x = event.clientX
    if (!this.frame) this.frame = requestAnimationFrame(() => this.set())
  }
  set() {
    this.frame = 0
    const box = this.element.getBoundingClientRect()
    if (!box.width) return
    const lean = Math.max(-1, Math.min(1, ((this.x - box.left) / box.width) * 2 - 1))
    this.element.style.setProperty('--lean', lean.toFixed(2))
    this.element.style.setProperty('--lean-abs', Math.abs(lean).toFixed(2))
  }
  rest() {
    cancelAnimationFrame(this.frame); this.frame = 0
    this.element.style.removeProperty('--lean')
    this.element.style.removeProperty('--lean-abs')
  }
})

// ---- the sidebar's live piece, on every page that has it ----
export function register(t) {
  const { BASE, stream } = t
  // The Trommi menu opens and closes (the pill, the desk drawing, a click beside it, Escape); the theme switch.
  const shut = () => { const doors = $('#brand-doors'); if (doors && !doors.hidden) { doors.hidden = true; $('#brand-menu')?.setAttribute('aria-expanded', 'false'); delete doors.dataset.from } }
  document.addEventListener('click', e => {
    const t = e.target instanceof Element ? e.target : null
    if (!t) return
    const menu = t.closest('#brand-menu'), doors = $('#brand-doors')
    if (menu && doors) { delete doors.dataset.from; doors.hidden = !doors.hidden; menu.setAttribute('aria-expanded', String(!doors.hidden)); return }
    if (doors && !doors.hidden && !t.closest('#brand-doors')) shut()
    if (t.closest('#theme-toggle')) {
      const dark = document.documentElement.dataset.theme !== 'dark'
      if (dark) document.documentElement.dataset.theme = 'dark'; else delete document.documentElement.dataset.theme
      try { localStorage.setItem('agent-board-theme', dark ? 'dark' : 'light') } catch {}
    }
  })
  document.addEventListener('keydown', e => { if (e.key === 'Escape') shut() })
  t.live('', {
    take: m => ({ sidebar: sidebarRows(m, BASE), rows: sidebarParts(m, BASE), lamp: deskLamp(m), desks: menuDeskRows(m, BASE), notes: sideNotes(m, BASE) }),
    diff: (was, now) => `${t.differs(was.notes, now.notes) ? stream('replace', 'side-notes', now.notes) : ''}${t.differs(was.lamp, now.lamp) ? stream('update', 'desk-lamp', now.lamp) : ''}${t.differs(was.desks, now.desks) ? stream('replace', 'menu-desk-rows', now.desks) : ''}${!t.differs(was.sidebar, now.sidebar) ? ''
      : was.rows.shape !== now.rows.shape ? stream('update', 'agents', now.sidebar)
        : [...now.rows.here, ...now.rows.away].map(([id, row], i) => (t.differs([...was.rows.here, ...was.rows.away][i][1], row) ? stream('replace', `agent-${id}`, row) : '')).join('')}`,
  })
}
