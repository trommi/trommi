// The sidebar (#agents): one row per session, a main with its subs under it, and the floating Desk's state.
// The markup is the one app.css and sidebar.css style (the old client built it in js/agents.js).
import { BASE, crownOf, renderStreamMessage, stream } from './app.mjs'
import { BELL, Controller, PLUS, avatar, badge, controller, crownSvg, edgeQuirk, el, html, linkCap, raw, sk, sketchSvg, toast } from './ui.mjs'
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
<a class="agent-entry" data-nav href="${base}/s/${encodeURIComponent(a.id)}" draggable="false" title="${shown.online && shown.running ? `Working${a.task ? `: ${a.task}` : ''}` : a.task ?? ''}"${current === u.id ? raw(' aria-current="page"') : ''}>${avatar(a, { crown: !u.subs, working: Boolean(shown.online && shown.running) })}<span class="agent-text"><strong>${a.name}</strong>${shown.online && shown.running ? html`<span class="sr-only"> (working)</span>` : ''}${linkCap(shown.link, shown.unheard)}</span></a>
${u.subs ? html`<button class="crown-fold${a.starred ? '' : ' is-plain'}" type="button" aria-expanded="false" title="${tip}" aria-label="${tip}" data-action="click->folds#toggle" data-folds-id-param="${a.id}">${a.starred ? raw(crownSvg()) : ''}</button>
<svg class="crown-bracket" aria-hidden="true" data-folds-target="bracket"><path/><path class="crown-bracket-hit" data-action="click->folds#toggle" data-folds-id-param="${a.id}"><title>Fold ${a.name}'s subs</title></path></svg>
<span class="crown-edges" title="${tip}" data-action="click->folds#toggle" data-folds-id-param="${a.id}">${lie.map((s, i) => { const q = edgeQuirk(s.id); return html`<i${s.blocked ? raw(' class="is-knock"') : ''} style="--i:${i};--hue:${s.agent.hue};--tilt:${q.tilt}deg;--dx:${q.dx}px">${raw(q.svg)}</i>` })}</span>` : ''}
${badge(u, shown, base, true)}
</div>`
}

const inviteAgentButton = () => html`<form method="post" action="/pair" class="agent-invite"><input type="hidden" name="role" value="agent"><button type="submit" class="agent-invite-go" id="sidebar-invite" title="Invite an agent" aria-label="Invite an agent">${PLUS}<span class="agent-invite-label">New agent</span></button></form>`

// ---- the note (his word, 4 October: "nur EINE Notiz"; 5 October: "wieder nach unten rechts") ----
// One drawn yellow sticky at the window's bottom-right, a part of the frame beside the sidebar (app.mjs bodyParts).
// Folded it is the sticky alone, and the sticky says how it stands: lines on it when the note holds something, blank
// when it is empty; a click unfolds it there,
// growing upward, into a field that grows with the words (Enter: a new line, Ctrl/Cmd+Enter sends, Esc folds), with
// the paperclip, the bin and the crown (send straight to the crown). Sent or thrown away, it is empty again. It is
// the newest unsent note.
const NOTE_ICON = raw('<svg viewBox="0 0 52 52" class="corner-note-ico" aria-hidden="true"><path class="note-fill" d="M9.5 11.2 Q25 9.6 42.6 10.6 Q43.4 25 42.8 38.4 L35.4 45.4 Q21 46.6 9.8 45.8 Q8.6 28 9.5 11.2 Z"/><path class="note-ink" d="M7.6 9.4 Q24 8.2 41.4 8.8 Q42.4 23.6 41.6 37.2 L34.2 44.2 Q20.4 45.2 8.2 44.4 Q6.8 27 7.6 9.4 Z"/><path class="note-ink" d="M41.6 37.2 Q37.2 36.6 34.8 37.6 Q34.1 40.8 34.2 44.2"/><path class="note-lines" d="M14.2 19.4 Q22 18.8 30.6 19.2 M14 25.6 Q20 25.1 26.4 25.5 M14.3 31.6 Q18.6 31.2 22.4 31.5"/></svg>')
const BIN = raw('<svg viewBox="0 0 24 24" class="sketch" aria-hidden="true"><path d="M5 7.2 Q12 6.8 19 7.3"/><path d="M9.6 6.9 Q9.8 4.8 12 4.7 Q14.3 4.8 14.4 6.9"/><path d="M6.6 7.6 Q7.4 14 8.2 20.2 Q12 20.6 15.8 20.2 Q16.6 14 17.4 7.6"/></svg>')
const isPic = a => /^image\//.test(a?.type ?? '') || /\.(png|jpe?g|gif|webp|svg)$/i.test(a?.name ?? '')
/** The note's attachments: a picture as a small thumbnail, a file by its name; a click takes it off. */
const noteFiles = atts => (atts ?? []).map(a => `<button type="button" class="corner-note-file${isPic(a) ? ' is-pic' : ''}" data-url="${String(a.url).replace(/"/g, '&quot;')}" data-action="corner-note#unclip" title="${String(a.name).replace(/"/g, '&quot;')}: click to take it off">${isPic(a) ? `<img src="${String(a.url).replace(/"/g, '&quot;')}" alt="" loading="lazy">` : `<span>${String(a.name).replace(/[<&]/g, c => (c === '<' ? '&lt;' : '&amp;'))}</span>`}<i>×</i></button>`).join('')
const CLIP = raw('<svg viewBox="0 0 24 24" class="sketch" aria-hidden="true"><path d="M15.6 7.2 Q11 12 8.4 14.8 Q7 16.6 8.6 17.8 Q10.2 18.8 11.6 17.2 Q15.6 12.8 18.2 9.8 Q20.4 7 18.2 5 Q16 3.4 13.8 5.6 Q9.4 10.4 6.4 13.8 Q3.8 17 6.4 19.6 Q9 21.8 12 19"/></svg>')
const deskNotesOf = model => (model.state.notes ?? []).filter(m => !m.held).sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
// Ctrl+Enter sends the note (Cmd+Enter on a Mac), anywhere on it; the keys stand small under the envelope. (The
// envelope's hover says to whom, the app's own label (notes.css data-name), not the browser's tooltip, which stood
// half outside the note.)
const MAC = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '')
const SEND_KEYS = MAC ? 'Meta+Enter' : 'Control+Enter', SEND_WORD = MAC ? '⌘ Enter' : 'Ctrl+Enter'
export function cornerNote(model, base) {
  const note = deskNotesOf(model)[0] ?? null, crown = crownOf(model)
  const text = note?.text ?? '', files = note?.attachments ?? []
  return html`<section class="corner-note-box${text || files.length ? ' has-words' : ''}" id="corner-note-box" aria-label="Your note" data-controller="corner-note" data-corner-note-id-value="${note?.id ?? ''}" data-corner-note-base-value="${base}">
<button type="button" class="corner-note-head" data-action="corner-note#open" title="${text || files.length ? 'Your note: open it (N)' : 'New note (N)'}" aria-label="${text || files.length ? 'Your note: open it' : 'New note'}" aria-expanded="false">${NOTE_ICON}</button>
<div class="corner-note-body" hidden data-action="paste->corner-note#paste dragover->corner-note#over dragleave->corner-note#out drop->corner-note#drop keydown->corner-note#key"><textarea class="corner-note-field" rows="2" aria-label="Your note${crown ? ` to ${crown.name}` : ''}" aria-keyshortcuts="${SEND_KEYS}" data-action="input->corner-note#typed">${text}</textarea><div class="corner-note-files">${raw(noteFiles(files))}</div>
<footer class="corner-note-foot"><button type="button" class="corner-note-clip" data-action="corner-note#pick" title="Attach a picture or a file (or paste it, or drop it on the note)" aria-label="Attach a picture or a file">${CLIP}</button><button type="button" class="corner-note-bin" data-action="corner-note#bin" title="Throw the note away" aria-label="Throw the note away">${BIN}</button><i></i>${crown ? html`<span class="corner-note-sending"><button type="button" class="note-send corner-note-send" data-action="corner-note#send" data-name="${crown.name}" aria-label="Send to ${crown.name}" aria-keyshortcuts="${SEND_KEYS}">${raw(crownSvg())}</button><kbd class="corner-note-keys" aria-hidden="true">${SEND_WORD}</kbd></span>` : html`<a class="corner-note-nocrown" data-nav href="${base}/agents">Give a session the crown to send</a>`}</footer></div>
</section>`
}
controller('corner-note', class extends Controller {
  static values = { id: String, base: String }
  connect() {
    this.field = this.element.querySelector('.corner-note-field')
    this.guard = e => { if (e.target?.getAttribute?.('target') === 'corner-note-box' && this.element.classList.contains('is-open')) e.preventDefault() }
    document.addEventListener('turbo:before-stream-render', this.guard)
    this.write = () => this.open()
    document.addEventListener('trommi:note', this.write)
    this.park()
  }
  // ---- park the note on the Scribble Board: there, the sticky can be dragged out of its corner (mouse or finger) and
  // dropped on the board; it stays where it was dropped as a sticky with its words (whiteboard.mjs), and the
  // corner is empty again. A press without a drag opens the note, as everywhere. Attached files do not go along:
  // they stay with the corner's note.
  park() {
    const head = this.element.querySelector('.corner-note-head')
    let drag = null
    const ghostAt = e => { drag.ghost.style.left = `${e.clientX}px`; drag.ghost.style.top = `${e.clientY}px` }
    head.addEventListener('pointerdown', e => {
      if (e.button > 0 || document.body.dataset.tView !== 'whiteboard' || !this.field.value.trim()) return
      drag = { x: e.clientX, y: e.clientY, id: e.pointerId, ghost: null }
      head.setPointerCapture(e.pointerId)
    })
    head.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.id) return
      if (!drag.ghost) {
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 8) return
        // (what is carried is the note as a conversation shows it: the paper with its strip of tape, notes.css .msg-note)
        drag.ghost = Object.assign(document.createElement('figure'), { className: 'msg-note corner-note-ghost' })
        drag.ghost.append(Object.assign(document.createElement('i'), { className: 'msg-note-tape' }), Object.assign(document.createElement('p'), { textContent: this.field.value.trim() }))
        document.body.append(drag.ghost)
        this.element.classList.add('is-parking')
      }
      ghostAt(e)
    })
    const end = e => {
      const d = drag; drag = null
      if (!d?.ghost) return
      d.ghost.remove()
      this.element.classList.remove('is-parking')
      this.skipOpen = true; setTimeout(() => { this.skipOpen = false }, 0)   // (the click that follows a drag opens nothing)
      const far = Math.hypot(e.clientX - d.x, e.clientY - d.y) > 48
      if (e.type === 'pointerup' && far) this.parked(e.clientX, e.clientY)
    }
    head.addEventListener('pointerup', end); head.addEventListener('pointercancel', end)
  }
  async parked(x, y) {
    const detail = { text: this.field.value, x, y, taken: false }
    document.dispatchEvent(new CustomEvent('trommi:park-note', { detail }))
    if (!detail.taken) return
    this.field.value = ''
    this.element.classList.toggle('has-words', this.files().length > 0)
    await this.save(true)
  }
  disconnect() { document.removeEventListener('turbo:before-stream-render', this.guard); document.removeEventListener('trommi:note', this.write); clearTimeout(this.timer) }
  async post(path, fields = {}) {
    const res = await fetch(`${this.baseValue}${path}`, { method: 'POST', headers: { Accept: 'text/vnd.turbo-stream.html', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) })
    const text = await res.text()
    if (text) renderStreamMessage(text)
    return res.ok
  }
  open() {
    if (this.skipOpen) return
    this.element.classList.add('is-open')
    this.element.querySelector('.corner-note-head').setAttribute('aria-expanded', 'true')
    this.element.querySelector('.corner-note-body').hidden = false
    this.fit(); this.field.focus(); this.field.setSelectionRange(this.field.value.length, this.field.value.length)
    this.away = e => { if (!this.element.contains(e.target)) this.close() }
    setTimeout(() => document.addEventListener('pointerdown', this.away), 0)
  }
  close() {
    document.removeEventListener('pointerdown', this.away)
    this.element.classList.remove('is-open')
    this.element.querySelector('.corner-note-head').setAttribute('aria-expanded', 'false')
    this.element.querySelector('.corner-note-body').hidden = true
    this.element.classList.toggle('has-words', Boolean(this.field.value.trim() || this.files().length))
    this.save(true)
  }
  fit() { this.field.style.height = 'auto'; this.field.style.height = `${Math.min(this.field.scrollHeight + 2, 320)}px` }
  typed() { this.fit(); clearTimeout(this.timer); this.timer = setTimeout(() => this.save(), 600) }
  key(e) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.send() }
    else if (e.key === 'Escape') { e.preventDefault(); this.close() }
  }
  // The words are kept as they stand: the note is made the first time there are words, gone when empty.
  async save(now = false) {
    clearTimeout(this.timer)
    const text = this.field.value
    if (this.saving) { this.again = true; return }
    this.saving = true
    try {
      if (!this.idValue) {
        if (!text.trim()) return
        await this.post('/notes', { text })
        const made = deskNotesOf(window.trommi?.model?.() ?? { state: {} })[0]
        if (made) this.idValue = made.id
      } else await this.post(`/notes/${this.idValue}/keep`, { text })
      if (!text.trim()) this.idValue = ''
    } finally { this.saving = false; if (this.again) { this.again = false; this.save() } }
  }
  // ---- attachments, as the note had them: POST /note with { id, attachments: [kept refs..., { name, data }] } ----
  files() { return [...this.element.querySelectorAll('.corner-note-file')].map(c => ({ url: c.dataset.url })) }
  async attach(list) {
    const got = [...list].filter(f => f instanceof File)
    if (!got.length) return
    if (!this.idValue) {
      await this.post('/notes', { text: this.field.value })
      const made = deskNotesOf(window.trommi?.model?.() ?? { state: {} })[0]
      if (!made) return
      this.idValue = made.id
    }
    const read = f => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve({ name: f.name || `pasted-${Date.now()}.png`, data: r.result }); r.onerror = () => reject(r.error); r.readAsDataURL(f) })
    try {
      const fresh = await Promise.all(got.map(read))
      const res = await fetch('/note', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: this.idValue, attachments: [...this.files(), ...fresh] }) })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText)
      this.paintFiles()
    } catch (err) { console.warn('note', err); this.element.querySelector('.corner-note-files').insertAdjacentHTML('beforeend', '<em class="corner-note-err">Not attached</em>') }
  }
  paintFiles() {
    const m = (window.trommi?.model?.().state.notes ?? []).find(n => n.id === this.idValue)
    this.element.querySelector('.corner-note-files').innerHTML = noteFiles(m?.attachments ?? [])
  }
  pick() {
    let input = this.element.querySelector('input[type=file]')
    if (!input) {
      input = Object.assign(document.createElement('input'), { type: 'file', multiple: true, hidden: true, tabIndex: -1 })
      input.addEventListener('change', async () => { await this.attach(input.files); input.value = ''; this.field.focus() })
      this.element.append(input)
    }
    input.click()
  }
  async unclip(e) {
    const chip = e.currentTarget, left = this.files().filter(f => f.url !== chip.dataset.url)
    chip.remove()
    if (this.idValue) await fetch('/note', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: this.idValue, attachments: left }) })
  }
  paste(e) { if (e.clipboardData?.files?.length) { e.preventDefault(); this.attach(e.clipboardData.files) } }
  over(e) { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); this.element.classList.add('is-drop') } }
  out() { this.element.classList.remove('is-drop') }
  drop(e) { this.out(); if (e.dataTransfer?.files?.length) { e.preventDefault(); this.attach(e.dataTransfer.files) } }
  async send() {
    const text = this.field.value
    if (!text.trim() && !this.files().length) return this.field.focus()
    if (!this.idValue) { await this.save(); if (!this.idValue) return }
    const id = this.idValue
    this.idValue = ''; this.field.value = ''; this.element.querySelector('.corner-note-files').innerHTML = ''
    this.close()
    await this.post(`/notes/${id}/send`, { text })
  }
  async bin() {
    const id = this.idValue, text = this.field.value
    this.idValue = ''; this.field.value = ''; this.element.querySelector('.corner-note-files').innerHTML = ''
    this.close()
    if (id) await this.post(`/notes/${id}/bin`, { text })
  }
})

/** The rows of #agents: the sessions (the Scribble Board is the back of the Desk: its page corner). current: the session in view, if any. */
export function sidebarRows(model, base, current = null) {
  const { here, away } = sidebarParts(model, base, current)
  return html`${here.map(r => r[1])}${inviteAgentButton()}${away.length ? html`<h2 class="caps agent-heading agent-heading-away">Disconnected</h2>${away.map(r => r[1])}` : ''}`
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
  return deskMark(model.fresh.length > 0)   // (model.fresh: the open questions of the sessions on this desk)
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
    if (!this.element.querySelector('.agent-row[data-fold="open"]') || document.documentElement.dataset.rail === 'folded') { for (const svg of this.bracketTargets) svg.style.display = 'none'; return }
    this.bracketTargets.forEach((svg, gi) => {
      const main = svg.closest('.agent-row')
      const subs = this.rowTargets.filter(r => r.dataset.parent === main?.dataset.unit && !r.hidden)
      if (!main || main.dataset.fold !== 'open' || !subs.length) { svg.style.display = 'none'; return }
      svg.style.display = ''
      const G = main.getBoundingClientRect(), last = subs.at(-1).getBoundingClientRect()
      const w = i => wob(gi * 17 + i, 1.1)
      const x = 4, h = 7, y0 = G.height - 4, y1 = last.bottom - G.top - 8
      const pts = [[x + h, y0 - 4], [x, y0 + 5 + w(1)], [x + w(2), (y0 + y1) / 2], [x, y1 + w(3)], [x + h, y1]]
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
// The Trommi menu (what opens from the row at the sidebar's foot; on a phone the sidebar is a drawer),
// the jump page's results (/jump; the menu
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
  // (a row: the link to the desk, and beside it the pencil that renames it: menu#rename puts a field in the name's place)
  return html`<span class="menu-desk-rows" id="menu-desk-rows">${desks.map((d, i) => html`<span class="menu-desk-row" data-desk="${d.id}"><a role="menuitemradio" class="menu-desk" data-nav draggable="false" href="${base}/?desk=${d.id}" data-desk="${d.id}" aria-checked="${String(here(d))}">${deskMark(d.open > 0)}<b>${d.name}</b>${i < 9 ? html`<kbd>${i + 1}</kbd>` : ''}</a><button type="button" class="menu-desk-pen" data-action="click->menu#rename" data-menu-id-param="${d.id}" title="Rename ${d.name}" aria-label="Rename the desk ${d.name}">${sk('pen')}</button></span>`)}</span>`
}

/** The menu: <nav id="brand-doors">, hidden until its button (#brand-menu) is pressed (or Ctrl K).
 *  Three calm groups: the desks, each a row with the desk drawing (lamp lit while something waits there; the desk in
 *  view is the marked row), the Demo as one more desk, and a quiet "New desk" (a line to name it, Enter makes it);
 *  places (Agents & devices, Help, Keys; Media is the pile on the Desk); this device (Push, Log out, and the theme as a small sun/moon beside Log out).
 *  The connection is not said here: a lost one is a dot on the menu's button (app.mjs). While it is open the keys are
 *  its own (data-owns-keys: the page's keys in ui.mjs stand back, so the arrows walk the menu and not the Desk's rows). */
function menuDoors(model, base) {
  return html`<nav class="sidedoors" id="brand-doors" role="menu" aria-label="Desks, places and settings" data-controller="menu" data-menu-desk-value="${base}/" data-action="keydown->menu#walk click->menu#chosen" data-owns-keys hidden>
<div class="menu-desks" id="menu-desks">${menuDeskRows(model, base)}
<a role="menuitem" class="menu-desk is-demo" href="${base}/?mock=1" data-turbo="false" draggable="false" id="dev-mock" title="The demo: a made-up room, nothing is kept">${deskMark(false)}<b>Demo</b></a>
<button type="button" role="menuitem" class="menu-desk-add" id="desk-add" data-action="click->menu#newDesk" aria-label="New desk">${NEW_DESK}<span>New desk</span></button>
<form class="menu-desk-form" id="desk-new" data-menu-target="deskForm" data-action="submit->menu#makeDesk" hidden><input class="menu-desk-field" data-menu-target="deskName" data-action="keydown->menu#deskKey" maxlength="40" placeholder="Name of the new desk" aria-label="Name of the new desk" autocomplete="off"><button type="submit">Make</button></form>
<p class="menu-desk-error" data-menu-target="deskError" role="alert"></p></div>
<div class="menu-grid"><a role="menuitem" href="${base}/agents" data-nav draggable="false" id="menu-agents" title="Agents and devices: the sessions, and who is in the room">${sk('heads')}<span>Agents &amp; devices</span></a><a role="menuitem" href="/help.html">${sk('page')}<span>Help</span></a><button role="menuitem" type="button" id="keys-open" data-action="click->menu#keys" aria-haspopup="dialog" aria-keyshortcuts="?">${sk('keycap')}<span>Keys</span></button></div>
<div class="menu-foot"><button role="menuitemcheckbox" type="button" id="push-toggle" aria-checked="false" aria-label="Push on this device">${sk('bell')}</button></div>
<div class="menu-leave"><a role="menuitem" href="${base}/logout" data-nav draggable="false" id="menu-logout" class="menu-logout" title="Log out of this device">${LEAVE}<span>Log out</span></a><button role="menuitemcheckbox" type="button" id="theme-toggle" class="menu-theme" aria-label="Light or dark (T)" title="Light or dark (T)">${raw(sketchSvg('moon', 'ico-moon'))}${raw(sketchSvg('sun', 'ico-sun'))}</button></div>
</nav>`
}

// ---- the sidebar's frame: the Desk box at its top with the Trommi menu's button, and its foot ----
// The foot (wide screens; sidebar.css): the ground under the sessions, which scroll above it. The menu's button stands
// on its left (a child of the Desk box's header), the
// button that folds the sidebar to a rail at its right end.
export const SIDE_FOOT = raw(`<div class="side-foot"><button type="button" class="rail-fold" data-controller="rail" data-action="click->rail#toggle pointerover@document->rail#tip focusin@document->rail#tip focusout@document->rail#untip turbo:before-cache@document->rail#untip" title="Fold the sidebar to a rail ( [ )" aria-label="Fold the sidebar to a rail ( [ )" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.3 4.4Q4.8 11.6 5.4 19.7"/><path d="M15.1 6.1Q12.2 9.2 9.1 12.1Q12.1 14.7 14.8 18"/></svg></button></div>`)

/** How big the desk's name may stand in the Desk box: s (as "Desk"), m (a little smaller), l (two smaller lines). */
const nameSize = name => { const n = [...String(name)].length; return n <= 6 ? 's' : n <= 11 ? 'm' : 'l' }
export function topbar(model, base, current) {
    return html`<header class="topbar"><div class="brand">
<h1 class="deskpill"><a href="${base}/" data-nav draggable="false" class="desk-go" id="desk-go" title="Desk ${model.deskName}: everything that waits for you"${current ? raw(' aria-current=""') : ''}><span class="desk-lamp" id="desk-lamp">${deskLamp(model)}</span>${BELL}<span class="desk-name" data-size="${nameSize(model.deskName)}">${model.deskName}</span></a>
<button type="button" class="brand-open" id="brand-menu" aria-haspopup="menu" aria-expanded="false" aria-controls="brand-doors" aria-label="Menu: jump, desks, places, settings" title="Menu">${raw(String(BELL).replace('class="brand-mark"', 'class="brand-mark open-mark"'))}<b class="open-word">Trommi</b><span class="conn open-conn" id="conn" data-state="connecting" role="status"><i aria-hidden="true"></i><span id="conn-text" class="tc-sr">Connecting</span></span><span class="brand-fold">${sk('unfold')}</span></button></h1>
${menuDoors(model, base)}
</div></header>`
}

// ---- a phone's top line and the drawer (sidebar.css "A phone") ----
// A phone has no room for the sidebar beside the page: the same sidebar (the Desk box, the sessions, the foot with the
// Trommi menu) is a drawer that slides in from the left over the page. The slim line at the top holds its handle (three
// pen lines; a red dot while a session is stopped or a card knocks) and the name of the place in view: the desk, or
// the session with its drawing. Wide screens show neither.
const HANDLE = raw('<svg viewBox="0 0 24 24" class="sketch" aria-hidden="true"><path d="M4.2 6.9Q12 6.1 19.9 6.8"/><path d="M4.1 12.3Q11 11.6 19.6 12.2"/><path d="M4.4 17.3Q12.4 18 19.8 17.1"/></svg>')
const PLACES = { agents: 'Agents', gallery: 'Media', whiteboard: 'Scribble Board' }
export function phoneBar(model, base, { view = '', current = null, title = '' } = {}) {
  const session = current ? model.byAgent.get(current) : null
  const waits = (model.blocked ?? 0) + (model.knocking ?? 0) > 0
  const place = session ? html`<a class="phone-place" data-nav draggable="false" href="${base}/s/${encodeURIComponent(session.id)}">${avatar(session, { crown: false })}<b>${session.name}</b></a>`
    : view === 'desk' || view === 'card' ? html`<a class="phone-place" data-nav draggable="false" href="${base}/"${view === 'desk' ? raw(' aria-current="page"') : ''}><span class="desk-lamp" id="phone-lamp">${deskLamp(model)}</span><b>${model.deskName}</b></a>`
      : html`<span class="phone-place"><b>${PLACES[view] ?? String(title).replace(/^\(\d+\) /, '').replace(/ · Trommi$/, '')}</b></span>`
  return html`<div class="phone-bar" id="phone-bar"><button type="button" class="drawer-open" id="drawer-open" aria-controls="agents" aria-expanded="false" aria-label="Sessions and menu" title="Sessions and menu"${waits ? raw(' data-waits') : ''}>${HANDLE}</button>${place}</div>`
}
export const DRAWER_VEIL = raw('<div class="drawer-veil" id="drawer-veil" aria-hidden="true"></div>')

/** The drawer's switch: <html data-drawer="open">. The handle and the veil open and close it, Escape and a choice made
 *  in it close it; a finger opens it from the left edge and pushes it back (the drawer follows the finger: --dx). */
function drawer() {
  const root = document.documentElement, phone = matchMedia('(max-width: 860px)')
  const isOpen = () => root.dataset.drawer === 'open'
  const width = () => $('#agents')?.offsetWidth || 300
  const set = (open, { focus = true } = {}) => {
    if (open === isOpen()) return
    if (open) root.dataset.drawer = 'open'; else delete root.dataset.drawer
    $('#drawer-open')?.setAttribute('aria-expanded', String(open))
    // (what lies under the veil is out of the keyboard's and a screen reader's way while the drawer is open)
    for (const el of document.querySelectorAll('body > main, #phone-bar, #corner-note-box, .curl')) el.inert = open
    if (!focus) return
    if (open) ($('#agents .agent-entry[aria-current="page"]') ?? $('#desk-go'))?.focus({ preventScroll: true })
    else if (document.activeElement?.closest?.('#agents, .topbar')) $('#drawer-open')?.focus({ preventScroll: true })
  }
  document.addEventListener('click', e => {
    const t = e.target instanceof Element ? e.target : null
    if (!t) return
    if (t.closest('#drawer-open')) return set(!isOpen())
    if (!isOpen()) return
    if (t.closest('#drawer-veil')) return set(false)
    // a place chosen in the drawer: a session, the Desk, a desk or a page of the menu (not the fold switches, not the menu's own button)
    if (t.closest('#agents a[href], #desk-go, #brand-doors a[href], #sidebar-invite')) set(false, { focus: false })
  })
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && isOpen() && $('#brand-doors')?.hidden !== false) { e.stopPropagation(); set(false) } }, true)
  document.addEventListener('turbo:load', () => { if (isOpen()) set(false, { focus: false }) })
  phone.addEventListener('change', () => set(false, { focus: false }))
  // The finger: from the left edge the drawer comes along; on the open drawer (or the veil) a push to the left takes it back.
  let drag = null
  const end = () => { root.classList.remove('is-drawer-drag'); root.style.removeProperty('--dx'); root.style.removeProperty('--veil'); drag = null }
  addEventListener('touchstart', e => {
    if (!phone.matches || e.touches.length !== 1) return
    const p = e.touches[0], open = isOpen()
    if (open ? p.clientX > width() + 80 : p.clientX > 22 || e.target.closest?.('#whiteboard, input, textarea')) return
    drag = { x: p.clientX, y: p.clientY, open, w: width(), on: false, at: p.clientX, t: e.timeStamp, v: 0 }
  }, { passive: true })
  addEventListener('touchmove', e => {
    if (!drag) return
    const p = e.touches[0], dx = p.clientX - drag.x, dy = p.clientY - drag.y
    if (!drag.on) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
      if (Math.abs(dy) > Math.abs(dx) || (drag.open ? dx > 0 : dx < 0)) return end()
      drag.on = true
      root.classList.add('is-drawer-drag')
    }
    const x = Math.max(-drag.w, Math.min(0, (drag.open ? 0 : -drag.w) + dx))
    drag.v = (p.clientX - drag.at) / Math.max(1, e.timeStamp - drag.t); drag.at = p.clientX; drag.t = e.timeStamp
    drag.now = x
    root.style.setProperty('--dx', `${x}px`)
    root.style.setProperty('--veil', (1 + x / drag.w).toFixed(3))
  }, { passive: true })
  const up = () => {
    if (!drag) return
    const d = drag
    end()
    if (d.on) set(Math.abs(d.v) > .35 ? d.v > 0 : d.now > -d.w / 2)
  }
  addEventListener('touchend', up, { passive: true })
  addEventListener('touchcancel', up, { passive: true })
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
    // Opened (its button, Ctrl+K, G then J): the menu takes the keyboard; the first arrow goes to the desk in view.
    // Closed, the keyboard is back on the button, unless it has gone to something else on the page.
    this.element.tabIndex = -1
    this.watch = new MutationObserver(() => {
      const at = document.activeElement
      if (!this.element.hidden) { if (!this.element.contains(at)) this.element.focus({ preventScroll: true }) }
      else if (!at || at === document.body || this.element.contains(at)) this.opener?.focus({ preventScroll: true })
    })
    this.watch.observe(this.element, { attributes: true, attributeFilter: ['hidden'] })
    // A refresh of the page (the live stream's "refresh" morphs it) must not shut the menu, the desk line or Dev under the hand.
    this.keep = e => {
      const t = e.target, name = e.detail?.attributeName
      if ((t === this.element && name === 'hidden') || (t.id === 'brand-menu' && name === 'aria-expanded') || (t.id === 'desk-new' && name === 'hidden')) e.preventDefault()
    }
    document.addEventListener('turbo:before-morph-attribute', this.keep)
    this.grab = this.grab.bind(this)
    this.element.addEventListener('pointerdown', this.grab)
    // (a row that was dragged is not also a click: the menu stays open and the desk is not switched)
    this.noClick = e => { if (this.dragged) { e.preventDefault(); e.stopImmediatePropagation(); this.dragged = false } }
    this.element.addEventListener('click', this.noClick, true)
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
  // ---- the desks' order: a row is picked up and dragged up or down (a mouse: as soon as it moves; a finger: held a
  // moment first, so a swipe still scrolls). The others make room; let go, the order is written (POST /desk { order }:
  // each desk's register holds its place, on all his devices) and the number keys 1…9 follow it. ----
  grab(event) {
    const row = event.target.closest?.('.menu-desk-row')
    if (!row || event.button > 0 || row.classList.contains('is-renaming') || event.target.closest('.menu-desk-pen, input')) return
    const list = row.parentElement, rows = () => [...list.querySelectorAll(':scope > .menu-desk-row')]
    if (rows().length < 2) return
    const y0 = event.clientY, x0 = event.clientX, touch = event.pointerType !== 'mouse', id = event.pointerId
    let live = false, timer = 0, grabAt = null
    const start = rows().map(r => r.dataset.desk).join()
    const lift = () => {
      live = true
      try { row.setPointerCapture(id) } catch {}
      row.classList.add('is-dragging'); list.classList.add('is-sorting')
      if (touch) navigator.vibrate?.(8)
    }
    if (touch) timer = setTimeout(lift, 280)
    const renumber = () => rows().forEach((r, i) => { const k = r.querySelector('kbd'); if (k) k.textContent = i < 9 ? String(i + 1) : '' })
    const move = e => {
      if (e.pointerId !== id) return
      const dy = e.clientY - y0
      if (!live) {
        if (touch) { if (Math.hypot(e.clientX - x0, dy) > 8) end(e, true); return }
        if (Math.abs(dy) < 5) return
        lift()
      }
      e.preventDefault()
      // the row follows the pointer; past the middle of a neighbour it takes that one's place
      row.style.translate = ''
      grabAt ??= y0 - row.getBoundingClientRect().top
      const before = rows().filter(r => r !== row).find(r => { const b = r.getBoundingClientRect(); return e.clientY < b.top + b.height / 2 }) ?? null
      if (before !== row.nextElementSibling) { list.insertBefore(row, before); renumber() }
      row.style.translate = `0 ${(e.clientY - grabAt - row.getBoundingClientRect().top).toFixed(1)}px`
    }
    const end = (e, cancel = false) => {
      if (e.pointerId !== id) return
      clearTimeout(timer)
      removeEventListener('pointermove', move); removeEventListener('pointerup', end); removeEventListener('pointercancel', end)
      if (!live) return
      this.dragged = true; setTimeout(() => { this.dragged = false }, 0)
      row.classList.remove('is-dragging'); list.classList.remove('is-sorting')
      row.animate?.([{ translate: row.style.translate || '0 0' }, { translate: '0 0' }], { duration: 160, easing: 'cubic-bezier(.3, 1.4, .5, 1)' })
      row.style.translate = ''
      const order = rows().map(r => r.dataset.desk)
      if (cancel || e.type === 'pointercancel' || order.join() === start) return
      fetch('/desk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order }) }).catch(err => console.warn('desk order', err))
    }
    addEventListener('pointermove', move, { passive: false }); addEventListener('pointerup', end); addEventListener('pointercancel', end)
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
  // ---- rename a desk: the pencil puts a field where the name is; Enter saves (POST /desk { id, name }), Escape leaves it ----
  rename({ params: { id } }) {
    const row = this.element.querySelector(`.menu-desk-row[data-desk="${CSS.escape(id)}"]`), was = row?.querySelector('b')?.textContent ?? ''
    if (!row || row.querySelector('.menu-desk-rename')) return
    const form = el('form', 'menu-desk-rename'), field = Object.assign(el('input', 'menu-desk-field'), { maxLength: 40, autocomplete: 'off', enterKeyHint: 'done', ariaLabel: `New name of the desk ${was}` })
    field.value = was
    form.append(field)
    row.classList.add('is-renaming'); row.append(form)
    // (the live stream leaves the rows alone while a name is being written)
    const hold = e => { if (e.target?.getAttribute?.('target') === 'menu-desk-rows') e.preventDefault() }
    document.addEventListener('turbo:before-stream-render', hold)
    const done = () => { document.removeEventListener('turbo:before-stream-render', hold); form.remove(); row.classList.remove('is-renaming') }
    field.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); done(); row.querySelector('.menu-desk-pen')?.focus() } })
    field.addEventListener('blur', () => setTimeout(() => { if (form.isConnected && !form.contains(document.activeElement)) done() }, 0))
    form.addEventListener('submit', async e => {
      e.preventDefault()
      const name = field.value.trim().slice(0, 40)
      if (!name || name === was) return done()
      try {
        const res = await fetch('/desk', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, name }) })
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText)
        row.querySelector('b').textContent = name
        if (row.querySelector('.menu-desk[aria-checked="true"]')) for (const n of document.querySelectorAll('.topbar .desk-name')) n.textContent = name   // (the sidebar's heading is the desk in view)
        done()
      } catch (err) { done(); toast({ head: 'Not renamed', line: err.message || 'the board did not answer', role: 'alert' }) }
    })
    field.focus(); field.select()
  }
  keys() { this.close(); document.dispatchEvent(new CustomEvent('trommi:keys')) }
})

// ---- controller "rail" ----
// The rail (card Nr. 150): the sidebar folded to the sessions' drawings with their marks (crown, bracket, the drawing
// that fills itself in while a session works, the count). Wide screens only (app.css, [data-rail="folded"]).
// The small "|<" at the right end of the sidebar's foot folds and opens it, and so does the key [ (ui.mjs (keys) presses this button).
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
  // The Trommi menu opens and closes (its button, a click beside it, Escape); the theme switch.
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
  drawer()
  // The rail is a wide screen's: a narrow window has the drawer, whole (the head's data-rail is taken off there).
  const narrow = matchMedia('(max-width: 860px)')
  const rail = () => { if (narrow.matches) delete document.documentElement.dataset.rail; else { try { if (localStorage.getItem(KEY) === 'folded') document.documentElement.dataset.rail = 'folded' } catch {} } dispatchEvent(new Event('resize')) }
  narrow.addEventListener('change', rail)
  if (narrow.matches) rail()
  t.live('', {
    take: m => ({ waits: (m.blocked ?? 0) + (m.knocking ?? 0) > 0, sidebar: sidebarRows(m, BASE), rows: sidebarParts(m, BASE), lamp: deskLamp(m), desks: menuDeskRows(m, BASE), notes: cornerNote(m, BASE) }),
    diff: (was, now) => `${was.waits !== now.waits ? (document.getElementById('drawer-open')?.toggleAttribute('data-waits', now.waits), '') : ''}${t.differs(was.notes, now.notes) ? stream('replace', 'corner-note-box', now.notes) : ''}${t.differs(was.lamp, now.lamp) ? stream('update', 'desk-lamp', now.lamp) + stream('update', 'phone-lamp', now.lamp) : ''}${t.differs(was.desks, now.desks) ? stream('replace', 'menu-desk-rows', now.desks) : ''}${!t.differs(was.sidebar, now.sidebar) ? ''
      : was.rows.shape !== now.rows.shape ? stream('update', 'agents', now.sidebar)
        : [...now.rows.here, ...now.rows.away].map(([id, row], i) => (t.differs([...was.rows.here, ...was.rows.away][i][1], row) ? stream('replace', `agent-${id}`, row) : '')).join('')}`,
  })
}
