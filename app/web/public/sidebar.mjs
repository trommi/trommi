// The sidebar (#agents): one row per session, a main with its subs under it, and the floating Desk's state.
// The markup is the one app.css and sidebar.css style.
import { BASE, crownOf, renderStreamMessage, stream } from './app.mjs'
import { BELL, Controller, PLUS, agoSpan, cardPath, paintTopStrip, nextThemeMode, setThemeMode, avatar, badge, controller, crownSvg, edgeQuirk, el, html, linkCap, raw, sk, sketchSvg, toast } from './ui.mjs'
const EDGES = 7   // more subs than this lie in a folded stack without an edge of their own

function row(u, base, current) {
  const a = u.agent
  const shut = Boolean(u.subs)   // a main is rendered folded; the island "folds" opens the ones this browser unfolded
  const shown = shut ? u.whole : u
  const names = u.subs?.map(s => s.agent.name) ?? []
  const tip = u.subs ? `Unfold ${a.name}'s ${names.length === 1 ? 'sub' : `${names.length} subs`}: ${names.join(', ')}` : ''
  const lie = u.subs ? (u.subs.length > EDGES ? [...u.subs].sort((x, y) => Boolean(y.blocked) - Boolean(x.blocked)).slice(0, EDGES) : u.subs) : []
  const cls = ['agent-row', u.parent && 'is-sub', (a.main || u.subs) && 'is-main', shown.open || shown.blocked ? 'has-badge' : '', !u.online && 'is-offline', current === u.id && 'is-active', ['asleep', 'cut', 'gone'].includes(u.parent?.link?.state) && 'is-hushed', u.subs?.some(x => x.id === current) && 'has-active'].filter(Boolean).join(' ')
  return html`<div class="${cls}" id="agent-${a.id}" data-folds-target="row" data-unit="${a.id}" data-members="${a.id}"${u.parent ? html` data-parent="${u.parent.id}" hidden` : ''}${u.subs ? html` data-fold="shut" style="--ghue:${a.hue};--n:${lie.length}" data-controller="lean" data-action="pointermove->lean#follow pointerleave->lean#rest"` : ''}>
<a class="agent-entry" data-nav href="${base}/s/${encodeURIComponent(a.id)}" draggable="false" title="${shown.online && shown.running ? `Working${a.task ? `: ${a.task}` : ''}` : a.task ?? ''}"${current === u.id ? raw(' aria-current="page"') : ''}>${avatar(a, { crown: !u.subs, working: Boolean(shown.online && shown.running) })}<span class="agent-text"><strong>${a.name}</strong>${shown.online && shown.running ? html`<span class="sr-only"> (working)</span>` : ''}${linkCap(shown.link, shown.unheard)}</span></a>
${u.subs ? html`<button class="crown-fold${a.starred ? '' : ' is-plain'}" type="button" aria-expanded="false" title="${tip}" aria-label="${tip}" data-action="click->folds#toggle" data-folds-id-param="${a.id}">${a.starred ? raw(crownSvg()) : ''}</button>
<svg class="crown-bracket" aria-hidden="true" data-folds-target="bracket"><path/><path class="crown-bracket-hit" data-action="click->folds#toggle" data-folds-id-param="${a.id}"><title>Fold ${a.name}'s subs</title></path></svg>
<span class="crown-edges" title="${tip}" data-action="click->folds#toggle" data-folds-id-param="${a.id}">${lie.map((s, i) => { const q = edgeQuirk(s.id); return html`<i${s.blocked ? raw(' class="is-knock"') : ''} style="--i:${i};--hue:${s.agent.hue};--tilt:${q.tilt}deg;--dx:${q.dx}px">${raw(q.svg)}</i>` })}</span>` : ''}
${u.subs ? html`<button type="button" class="rail-subs" data-action="click->folds#toggle" data-folds-id-param="${a.id}" title="${tip}" aria-label="${tip}">${u.subs.length}</button>` : ''}${badge(u, shown, base, true)}
</div>`
}

// ---- the session in view, marked in the sidebar ----
// The rows are the same markup on every page (so a page change keeps the sidebar's nodes as they are, app.mjs
// paintBody); which one is the session in view is set on them here, after every page and whenever rows are put in
// (the live stream's replacements): .is-active and aria-current on its row, .has-active on its main's.
let inView = null
function paintCurrent(root = document) {
  for (const r of root.querySelectorAll('#agents .agent-row[data-unit]')) {
    const on = r.dataset.unit === inView
    r.classList.toggle('is-active', on)
    r.querySelector(':scope > .agent-entry')?.toggleAttribute('aria-current', on)
    if (on) r.querySelector(':scope > .agent-entry')?.setAttribute('aria-current', 'page')
    r.classList.toggle('has-active', !r.dataset.parent && inView != null && !on && Boolean(document.querySelector(`#agents .agent-row[data-parent="${CSS.escape(r.dataset.unit)}"][data-unit="${CSS.escape(inView)}"]`)))
  }
}
let watching = null
/** The session in view (null: none): marked in the sidebar now and in every row put in later. */
export function markCurrent(current) {
  inView = current ?? null
  paintCurrent()
  watching ??= new MutationObserver(list => { if (list.some(ch => [...ch.addedNodes].some(n => n.nodeType === 1 && (n.matches('.agent-row, #agents') || n.querySelector?.('.agent-row'))))) paintCurrent() })
  const agents = document.getElementById('agents')
  if (agents && watching.target !== agents) { watching.disconnect(); watching.observe(agents, { childList: true, subtree: true }); watching.target = agents }
}

const inviteAgentButton = () => html`<form method="post" action="/pair" class="agent-invite"><input type="hidden" name="role" value="agent"><button type="submit" class="agent-invite-go" id="sidebar-invite" title="Invite an agent" aria-label="Invite an agent">${PLUS}<span class="agent-invite-label">New Agent…</span></button></form>`

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
  // On All desks the note asks which desk's crowned session gets it (his word, 8 October; the last one marked)
  const crowns = model.all ? (model.desks ?? []).map(d => ({ desk: d, a: model.everyone.find(a => a.starred && !a.archived && model.deskOf(a) === d.id) })).filter(x => x.a) : []
  const chooser = crowns.length > 1 ? html`<div class="note-to-pick" role="menu" aria-label="Send to" hidden>${crowns.map(x => html`<button type="button" role="menuitem" class="note-to-row" data-action="corner-note#sendTo" data-to="${x.a.id}">${raw(sketchSvg('desk'))}<span><b>${x.desk.name || 'Desk'}</b><small>${x.a.name}</small></span></button>`)}</div>` : ''
  const text = note?.text ?? '', files = note?.attachments ?? []
  return html`<section class="corner-note-box${text || files.length ? ' has-words' : ''}" id="corner-note-box" aria-label="Your note" data-controller="corner-note" data-corner-note-id-value="${note?.id ?? ''}" data-corner-note-base-value="${base}">
<button type="button" class="corner-note-head" data-action="corner-note#open" title="${text || files.length ? 'Your note: open it (N)' : 'New note (N)'}" aria-label="${text || files.length ? 'Your note: open it' : 'New note'}" aria-expanded="false">${NOTE_ICON}</button>
<div class="corner-note-body" hidden data-action="paste->corner-note#paste dragover->corner-note#over dragleave->corner-note#out drop->corner-note#drop keydown->corner-note#key">${crown ? html`<span class="corner-note-to">${avatar(crown, { crown: false })}<b>${crown.name}</b></span>` : ''}<textarea class="corner-note-field" rows="2" aria-label="Your note${crown ? ` to ${crown.name}` : ''}" aria-keyshortcuts="${SEND_KEYS}" data-action="input->corner-note#typed">${text}</textarea><div class="corner-note-files">${raw(noteFiles(files))}</div>
<footer class="corner-note-foot"><button type="button" class="corner-note-clip" data-action="corner-note#pick" title="Attach a picture or a file (or paste it, or drop it on the note)" aria-label="Attach a picture or a file">${CLIP}</button><button type="button" class="corner-note-bin" data-action="corner-note#bin" title="Throw the note away" aria-label="Throw the note away">${BIN}</button><i></i>${crown ? html`<span class="corner-note-sending">${chooser}<button type="button" class="note-send corner-note-send" data-action="corner-note#send" data-name="${crown.name}" aria-label="Send to ${crown.name}" aria-keyshortcuts="${SEND_KEYS}">${raw(crownSvg())}</button><kbd class="corner-note-keys" aria-hidden="true">${SEND_WORD}</kbd></span>` : html`<a class="corner-note-nocrown" data-nav href="${base}/settings/sessions">Give a session the crown to send</a>`}</footer></div>
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
    this.away = e => { if (this.element.contains(e.target)) return; if (e.target.closest?.('.tab[data-tab="note"]')) this.element.dataset.tabClosed = '1'; this.close() }
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
    // What is on its way shows at once (his word, 7 October: a grey box and no sign of anything): the picture itself from
    // this device, a drawn ring turning and "uploading…"; done, the note's own chip takes its place with the same
    // picture; refused, the chip says so and offers to try again.
    const kept = this.files(), box = this.element.querySelector('.corner-note-files')
    const previews = got.map(f => (/^image\//.test(f.type) ? URL.createObjectURL(f) : null))
    const pending = got.map((f, i) => {
      const chip = el('span', `corner-note-file is-uploading${previews[i] ? ' is-pic' : ''}`)
      if (previews[i]) chip.append(Object.assign(document.createElement('img'), { src: previews[i], alt: '' })); else chip.append(el('span', '', f.name || 'file'))
      chip.insertAdjacentHTML('beforeend', '<i class="note-up" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3.2A8.8 8.8 0 1 1 3.4 10.4"/></svg></i><b class="note-up-word">uploading…</b>')
      box.append(chip)
      return chip
    })
    try {
      const fresh = await Promise.all(got.map(read))
      const res = await fetch('/note', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: this.idValue, attachments: [...kept, ...fresh] }) })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText)
      this.paintFiles(previews)
    } catch (err) {
      console.warn('note', err)
      for (const chip of pending) {
        chip.classList.replace('is-uploading', 'is-failed')
        chip.querySelector('.note-up-word').textContent = 'upload failed'
        const again = el('button', 'note-up-again', 'retry')
        again.type = 'button'
        again.addEventListener('click', e => { e.stopPropagation(); for (const c of pending) c.remove(); this.attach(got) }, { once: true })
        chip.append(again)
      }
    }
  }
  /** previews: this device's own pictures of the newest attachments, shown until the note's copies are drawn. */
  paintFiles(previews = []) {
    const m = (window.trommi?.model?.().state.notes ?? []).find(n => n.id === this.idValue)
    const box = this.element.querySelector('.corner-note-files')
    box.innerHTML = noteFiles(m?.attachments ?? [])
    const chips = [...box.querySelectorAll('.corner-note-file')].slice(-previews.length || box.children.length)
    previews.forEach((url, i) => {
      const img = url && chips[i]?.querySelector('img')
      if (!img) return
      const real = img.src, probe = new Image()
      img.src = url
      probe.src = real
      ;(probe.decode ? probe.decode() : Promise.resolve()).then(() => { img.src = real; URL.revokeObjectURL(url) }, () => {})
    })
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
  sendTo(e) { e.stopPropagation(); const to = e.currentTarget.dataset.to; try { localStorage.setItem('trommi-note-to', to) } catch {} ; this.element.querySelector('.note-to-pick').hidden = true; this.send(null, to) }
  async send(e, to = null) {
    const text = this.field.value
    if (!text.trim() && !this.files().length) return this.field.focus()
    const pick = this.element.querySelector('.note-to-pick')
    if (pick && !to) {
      // (on All desks: the crowns to choose from, the last one marked; Enter or a second press sends to it)
      let last = null; try { last = localStorage.getItem('trommi-note-to') } catch {}
      const rows = [...pick.querySelectorAll('.note-to-row')], marked = rows.find(r => r.dataset.to === last) ?? rows[0]
      if (pick.hidden) { pick.hidden = false; for (const r of rows) r.classList.toggle('is-last', r === marked); marked?.focus(); return }
      to = marked?.dataset.to
    }
    if (!this.idValue) { await this.save(); if (!this.idValue) return }
    const id = this.idValue
    this.idValue = ''; this.field.value = ''; this.element.querySelector('.corner-note-files').innerHTML = ''
    this.close()
    await this.post(`/notes/${id}/send`, to ? { text, to } : { text })
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
  return html`${here.map(r => r[1])}${inviteAgentButton()}${away.length ? html`<h2 class="caps agent-heading agent-heading-away">Disconnected</h2>${away.map(r => r[1])}` : ''}${inDemo() ? raw('<span class="side-demo">Demo · <a href="/screens?mock=1" target="_blank" rel="noopener" title="Every screen of the app in the demo, for review">All screens</a> · <a href="/?mock=0" data-turbo="false" title="Leave the demo: back to your desks">leave</a></span>') : ''}`
}
/** The same rows one by one, for the live stream: [id, row] of those connected (here) and those that are not (away);
 *  shape says their order, so that a change within one row replaces that row only (app.mjs, the board's live streams). */
// ---- All desks as a filter (his pick, 8 October) ----
// The head says only where he is: "All desks" or the desk's name, big, beside the desk drawing, a small chevron after it
// (his pick "name": no counts, no row of names). A press opens a quiet list: All desks, each desk (its lamp lit and a
// small orange dot while something waits there), New desk. The folded rail's tag opens the same list. On All the
// sidebar shows every session, a hand-drawn divider over each desk's; a desk shows only its own.
function deskSwitchList(model, base) {
  const item = (href, name, on, waits, all = false) => html`<a role="menuitemradio" class="desk-switch-item${all ? ' is-all' : ''}" data-nav draggable="false" href="${href}" aria-checked="${String(on)}">${all ? ALL_MARK : deskMark(waits)}<b>${name}</b>${waits ? raw('<i class="desk-switch-dot" aria-label="something waits"></i>') : ''}</a>`
  return html`<span class="desk-switch-list" id="desk-switch-list">${item(`${base}/?desk=all`, 'All Desks', model.all, false, true)}${desksOf(model).map(d => item(`${base}/?desk=${d.id}`, d.name, !model.all && d.id === model.desk, d.open > 0))}<button type="button" role="menuitem" class="desk-switch-add desk-word-add">${PLUS}<span>New Desk…</span></button></span>`
}
const RULE = raw('<svg class="desk-rule" viewBox="0 0 200 6" preserveAspectRatio="none" aria-hidden="true"><path d="M1 3.4 Q40 2.2 90 3.1 T199 2.6"/></svg>')
/** On All: the divider over one desk's sessions: its drawing, its name (a press shows that desk alone), a pen rule, the count. */
function deskDivider(model, base, d) {
  return html`<div class="agent-row desk-divider" id="agent-desk-${d.id}"><a class="desk-divider-name" data-nav draggable="false" href="${base}/?desk=${d.id}" title="Show ${d.name} alone">${raw(sketchSvg('desk', 'desk-divider-mark'))}<span>${d.name}</span></a>${RULE}${d.open ? html`<b class="desk-divider-n">${d.open}</b>` : ''}</div>`
}
function sidebarParts(model, base, current = null) {
  const top = model.units.filter(u => !u.parent)
  const rows = u => [[u.id, row(u, base, current)], ...(u.subs ?? []).map(s => [s.id, row(s, base, current)])]
  const live = u => u.online || Boolean(u.subs?.some(s => s.online))
  // All desks: every session, desk by desk, each desk under its divider (connected and not, the way they stand)
  if (model.all) {
    const groups = desksOf(model).flatMap(d => { const mine = top.filter(u => model.deskOf(u.agent) === d.id); return mine.length ? [[`desk-${d.id}`, deskDivider(model, base, d)], ...[...mine.filter(live), ...mine.filter(u => !live(u))].flatMap(rows)] : [] })
    const here = groups
    return { here, away: [], shape: here.map(r => r[0]).join(' ') }
  }
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
    // (on the rail a main's helpers are its stack and count: a click opens the sidebar with them unfolded)
    if (document.documentElement.dataset.rail === 'folded') { open.add(id); write(FOLD_KEY, [...open]); for (const row of this.rowTargets) this.apply(row); document.querySelector('.rail-fold')?.click(); return }
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
// itself has no search field for now), and the sheet a long press on a Desk row brings up on a phone. app.css and sidebar.css style the
// menu; the controller "menu" adds the arrows and a new desk, the Desk's row menu (desk.mjs) the long press. Opening and closing the
// menu and the theme: ui.mjs.

const DEFAULT_DESK = 'main'

/** The desks with what waits on each: [{ id, name, open, knocks }]. */
function desksOf(model) {
  const desks = model.state.desks?.length ? model.state.desks : [{ id: DEFAULT_DESK, name: 'Desk' }]
  const deskOf = card => { const d = model.byAgent.get(card.agent)?.desk; return desks.some(x => x.id === d) ? d : desks[0].id }
  return desks.map(d => { const mine = (model.allFresh ?? model.fresh).filter(c => deskOf(c) === d.id); return { id: d.id, name: d.name || 'Desk', open: mine.length, knocks: mine.some(c => ['high', 'critical'].includes(c.urgency)) } })
}

/** Whether this tab shows the demo room (app.mjs: ?mock=1, remembered for the tab; ?mock=0 ends it). */
const inDemo = () => { try { return Boolean(globalThis.sessionStorage?.getItem('trommi-mock')) } catch { return false } }
const DEMO_MARK = raw('<svg viewBox="0 0 24 24" class="sketch" aria-hidden="true"><path d="M5 6.2Q12 5.6 19.2 6.1Q19.6 12 19 17.8Q12 18.4 4.8 17.9Q4.4 12 5 6.2Z"/><path d="M10 9.4Q13.6 11.6 15.4 12Q13.4 13 10.2 14.8Q9.8 12 10 9.4Z"/></svg>')
// Small drawings of the menu's own, in the pen's line: Log out, the plus of "New desk", and the light of the desk lamp.
// Log out: a door frame, open to the right, and an arrow walking out of it.
const LEAVE = raw('<svg viewBox="0 0 24 24" class="sketch" aria-hidden="true" style="rotate:-1deg"><path d="M10.2 4.3Q7.4 4.1 5.2 4.4Q4.9 12.1 5.2 19.7Q7.7 19.9 10.1 19.8"/><path d="M9.4 12.2Q14.5 11.8 19.5 12.1"/><path d="M16.3 8.7Q18.2 10.4 19.6 12.1Q18 13.8 16.2 15.3"/></svg>')
const NEW_DESK = raw('<svg viewBox="0 0 24 24" class="sketch" aria-hidden="true" style="rotate:3deg"><path d="M12.2 5.2Q11.8 12 12 18.8"/><path d="M5.3 12.3Q12 11.7 18.7 12.1"/></svg>')
// The lamp switched on, drawn under the desk's lines: the shade glowing, a soft cone of light down onto the top, three short rays.
const LIGHT = '<g class="lamp-light"><path class="lamp-glow" d="M14.9 2.4Q11.7 3.7 10.7 4.7Q9.6 5.7 9 6.6Q8.5 7.4 9 7.6Q9.5 7.9 12.4 7Q15.2 6.1 15.6 6.1Q15.9 6.1 15.8 4.7Q15.7 3.4 14.9 2.4Z"/><path class="lamp-cone" d="M9.2 7.9Q12.4 7.1 15.6 6.3L17.3 11.9Q12 12.1 6.4 12.2Z"/><path d="M7.6 9Q5.9 10.1 4.3 11.2"/><path d="M7.1 7.2Q5.3 7.3 3.5 7.5"/><path d="M7.9 5Q6.4 4.2 4.9 3.5"/></g>'
/** The desk drawing of the menu's desk rows and the Desk box: its lamp lit while something waits on that desk. */
const deskMark = lit => raw(lit ? sketchSvg('desk', 'menu-lamp is-lit').replace(/(<svg[^>]*>)/, `$1${LIGHT}`) : sketchSvg('desk', 'menu-lamp'))
/** All Desks' own drawing: two desks, one behind the other (the parent row of the desk lists). */
const ALL_MARK = raw(sketchSvg('desks', 'menu-lamp menu-all-mark'))

/** The desk rows of the menu (#menu-desk-rows, kept current by the live stream): the desk in view checked (the marked
 *  row); a desk's lamp is lit while something waits on it. */
function menuDeskRows(model, base) {
  const desks = desksOf(model)
  const here = d => (model.all ? false : model.desk ? d.id === model.desk : d === desks[0])
  // (a row: the link to the desk, and beside it the pencil that renames it: menu#rename puts a field in the name's place)
  const allRow = desks.length > 1 ? html`<span class="menu-desk-row is-all" data-desk="all"><a role="menuitemradio" class="menu-desk is-all" data-nav draggable="false" href="${base}/?desk=all" data-desk="all" aria-checked="${String(Boolean(model.all))}">${ALL_MARK}<b>All Desks</b>${model.allFresh?.length ? html`<i class="menu-n">${model.allFresh.length}</i>` : ''}</a></span>` : ''
  return html`<span class="menu-desk-rows${desks.length > 1 ? ' has-all' : ''}" id="menu-desk-rows">${allRow}${desks.map((d, i) => html`<span class="menu-desk-row" data-desk="${d.id}"><a role="menuitemradio" class="menu-desk" data-nav draggable="false" href="${base}/?desk=${d.id}" data-desk="${d.id}" aria-checked="${String(here(d))}">${deskMark(d.open > 0)}<b>${d.name}</b>${d.open ? html`<i class="menu-n">${d.open}</i>` : ''}</a><button type="button" class="menu-desk-pen" data-action="click->menu#rename" data-menu-id-param="${d.id}" title="Rename ${d.name}" aria-label="Rename the desk ${d.name}">${sk('pen')}</button></span>`)}</span>`
}

/** The menu: <nav id="brand-doors">, hidden until its button (#brand-menu) is pressed (or Ctrl K).
 *  Three calm groups: the desks, each a row with the desk drawing (lamp lit while something waits there; the desk in
 *  view is the marked row), the Demo as one more desk, and a quiet "New desk" (a line to name it, Enter makes it);
 *  places (Settings: agents, devices, account; Keys); this device (the theme, Push under it, Log out).
 *  The connection is not said here: a lost one is a dot on the menu's button (app.mjs). While it is open the keys are
 *  its own (data-owns-keys: the page's keys in ui.mjs stand back, so the arrows walk the menu and not the Desk's rows). */
/** The sessions in the menu (#menu-sessions, kept current by the live stream): each with its drawing and what waits
 *  on it. The pill and the tab bar (8 October, his choice "both") have no sidebar: this is the way to a session. */
function menuSessions(model, base) {
  const fresh = model.allFresh ?? model.fresh
  const rows = model.agents.filter(a => !a.archived)
  return html`<div class="menu-sessions" id="menu-sessions">${rows.length ? html`<p class="menu-h">Sessions</p>` : ''}${rows.map(a => { const n = fresh.filter(c => c.agent === a.id).length; return html`<a role="menuitem" class="menu-session" data-nav draggable="false" href="${base}/s/${encodeURIComponent(a.id)}">${avatar(a, { crown: false, working: Boolean(a.working) })}<b>${a.name}</b>${n ? html`<i class="menu-n">${n}</i>` : ''}</a>` })}</div>`
}

const NOTE_EMPTY = raw('<svg viewBox="0 0 24 24" class="sketch" aria-hidden="true"><path d="M5.4 4.6Q12 4.2 18.8 4.7Q19.3 10 19.1 14.6L14.4 19.4Q9.8 19.7 5.2 19.3Q4.8 12 5.4 4.6Z"/><path d="M19.1 14.6Q15.6 14.3 14.6 15Q14.3 17 14.4 19.4"/></svg>'), NOTE_WRITTEN = raw('<svg viewBox="0 0 24 24" class="sketch" aria-hidden="true"><path d="M5.4 4.6Q12 4.2 18.8 4.7Q19.3 10 19.1 14.6L14.4 19.4Q9.8 19.7 5.2 19.3Q4.8 12 5.4 4.6Z"/><path d="M19.1 14.6Q15.6 14.3 14.6 15Q14.3 17 14.4 19.4"/><path d="M8 8.6Q12 8.2 15.8 8.5"/><path d="M8 11.7Q11.6 11.4 15.6 11.6"/><path d="M8 14.8Q10 14.6 11.8 14.8"/></svg>')
const noteGlyph = model => { const n = deskNotesOf(model)[0]; return html`<span class="tab-note-ico" id="tab-note-ico">${n && (String(n.text ?? '').trim() || n.attachments?.length) ? NOTE_WRITTEN : NOTE_EMPTY}</span>` }
/** The phone's bar (his word, 8 October: "Menu" is no tab; the menu is the pill at the top left, as on a wide screen):
 *  a small glass capsule at the foot, centred: Scribble · Desk · Note. The Desk carries what waits as its number (red
 *  while something knocks); Note opens the corner note to the crowned session. On a card's own page it stands back. */
export function tabBar(model, base, view) {
  const fresh = model.allFresh ?? model.fresh
  const knocks = fresh.some(c => ['high', 'critical'].includes(c.urgency))
  const chat = lastChat(model), unread = unreadChats(model)
  // (monochrome pen drawings; Chat opens the last chat, Desk carries what waits, Note opens the note; inside a chat or
  // a card the capsule stands back)
  // (in a chat the capsule stays; the composer waits folded into a round glass pen beside it)
  const pen = view === 'session' ? html`<button type="button" class="compose-fab" id="compose-fab" aria-label="Write a message" title="Write a message">${sk('pen')}</button>` : ''
  return html`${pen}<nav class="tabbar" id="tabbar" aria-label="Chat, Desk, Note"${['card', 'picture', 'whiteboard'].includes(view) ? raw(' hidden') : ''}>
<a class="tab" data-tab="chat" data-nav draggable="false" href="${chat ? `${base}/s/${encodeURIComponent(chat)}` : `${base}/chats`}"${view === 'chats' ? raw(' aria-current="page"') : ''}>${sk('bubble')}<span>Chat</span><i class="tab-badge" id="chat-badge"${unread ? '' : raw(' hidden')}>${unread}</i></a>
<a class="tab" data-tab="desk" data-nav draggable="false" href="${base}/"${view === 'desk' ? raw(' aria-current="page"') : ''}>${sk('desk')}<span>Desk</span>${waitingBadge(fresh.length, knocks)}</a>
<button type="button" class="tab" data-tab="note" aria-controls="corner-note-box" aria-expanded="false">${noteGlyph(model)}<span>Note</span></button>
</nav>`
}
const waitingBadge = (n, knocks) => html`<i class="tab-badge${knocks ? ' is-knock' : ''}" id="tab-badge"${n ? '' : raw(' hidden')}>${n > 99 ? '99+' : n}</i>`

// A gear in the pen's line (Settings).
const GEAR = raw('<svg viewBox="0 0 24 24" class="sketch" aria-hidden="true"><path d="M12 3.2L13.4 5.6L16.1 4.9L16.8 7.6L19.4 8.4L18.6 11.1L20.6 13L18.5 14.8L19.1 17.5L16.4 18.1L15.4 20.7L12.9 19.6L10.6 21.1L9.3 18.6L6.5 18.8L6.4 16L4 14.6L5.5 12.2L4.4 9.6L7 8.6L7.4 5.8L10.2 6.1Z"/><path d="M12.1 9.3Q14.7 9.6 14.8 12Q14.6 14.6 12 14.7Q9.4 14.5 9.3 12Q9.5 9.4 12.1 9.3Z"/></svg>')
/** The Trommi menu (#brand-doors): the wide screen's (from the sidebar's foot) and the phone's (from the pill), one
 *  component: the desks (each with its drawing and what waits, New Desk…), Settings, and one row of small buttons for
 *  this device: Push (Off → All → Only knocking), Theme (Light → Dark → System), Keyboard Shortcuts, Demo. A phone
 *  also has its places here (Scribble, Artifacts). Log Out is in Settings · Account. */
function menuDoors(model, base) {
  return html`<nav class="sidedoors" id="brand-doors" role="menu" aria-label="Desks and settings" data-controller="menu" data-menu-desk-value="${base}/" data-action="keydown->menu#walk click->menu#chosen" data-owns-keys hidden>
<div class="menu-desks" id="menu-desks">${menuDeskRows(model, base)}
<button type="button" role="menuitem" class="menu-desk-add is-plus" id="desk-add" data-action="click->menu#newDesk" aria-label="New Desk…" title="New Desk…">${NEW_DESK}</button>
<form class="menu-desk-form" id="desk-new" data-menu-target="deskForm" data-action="submit->menu#makeDesk" hidden><input class="menu-desk-field" data-menu-target="deskName" data-action="keydown->menu#deskKey" maxlength="40" placeholder="Name of the new desk" aria-label="Name of the new desk" autocomplete="off"><button type="submit">Add</button></form>
<p class="menu-desk-error" data-menu-target="deskError" role="alert"></p></div>
<a role="menuitem" class="menu-settings" href="${base}/settings" data-nav draggable="false" id="menu-settings">${GEAR}<span>Settings</span></a>
<button role="menuitemcheckbox" type="button" id="demo-toggle" class="menu-demo-row demo-toggle" aria-checked="${String(inDemo())}" title="${inDemo() ? 'Leave the demo: back to your desks' : 'The demo: a made-up room, nothing is kept'}">${sk('play')}<span>Demo</span><i class="demo-switch" aria-hidden="true"><b></b></i></button>
<div class="menu-places">${[['scribble-board', 'pen', 'Scribble'], ['artifacts', 'picture', 'Artifacts']].map(([p, icon, word]) => html`<a role="menuitem" href="${base}/${p}" data-nav draggable="false">${sk(icon)}<span>${word}</span></a>`)}</div>
<div class="menu-icons" role="group" aria-label="This device">
<button role="menuitem" type="button" id="push-toggle" class="menu-ico" data-level="off" aria-label="Push on this device: No" title="Push on this device">${sk('bell')}${raw('<svg class="push-mark push-off" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.2 3.8Q12 12.2 19.9 20.4"/></svg><svg class="push-mark push-knock" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7.6Q11.9 10.4 12.1 12.9"/><path d="M12 15.6Q12.1 15.8 12 16"/></svg>')}</button>
<button role="menuitem" type="button" id="theme-toggle" class="menu-ico menu-theme-row" aria-label="Theme: Light, Dark or System (T)" title="Theme: Light → Dark → System (T)">${raw(sketchSvg('moon', 'ico-moon'))}${raw(sketchSvg('sun', 'ico-sun'))}<i class="ico-auto" aria-hidden="true">A</i></button>
<button role="menuitem" type="button" id="keys-open" class="menu-ico" data-action="click->menu#keys" aria-haspopup="dialog" aria-keyshortcuts="?" aria-label="Keyboard Shortcuts (?)" title="Keyboard Shortcuts (?)">${sk('question')}</button>

</div>
<p class="menu-push-note" id="menu-push-note" role="status" hidden></p>
</nav>`
}

// ---- the sidebar's frame: the Desk box at its top with the Trommi menu's button, and its foot ----
// The foot (wide screens; sidebar.css): the ground under the sessions, which scroll above it. The menu's button stands
// on its left (a child of the Desk box's header), the
// button that folds the sidebar to a rail at its right end.
export const SIDE_FOOT = raw(`<div class="side-foot"><button type="button" class="rail-fold" data-controller="rail" data-action="click->rail#toggle pointerover@document->rail#tip focusin@document->rail#tip focusout@document->rail#untip turbo:before-cache@document->rail#untip" title="Fold the sidebar to a rail ( [ )" aria-label="Fold the sidebar to a rail ( [ )" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.3 4.4Q4.8 11.6 5.4 19.7"/><path d="M15.1 6.1Q12.2 9.2 9.1 12.1Q12.1 14.7 14.8 18"/></svg></button></div>`)

/** How big the desk's name may stand in the Desk box: s (as "Desk"), m (a little smaller), l (two smaller lines). */
/** The desk switcher (his word, 7 October: "up here there must be a dropdown"): opened by the chevron beside the desk's
 *  name at the top of the sidebar, and by the folded rail's tag; All desks first, the desks set in under it, the one in
 *  view marked. One component for both. Kept current by the live stream (#desk-switch-list). */
const deskSwitch = (model, base) => html`<nav class="desk-switch" id="desk-switch" role="menu" aria-label="Desks" hidden>${deskSwitchList(model, base)}</nav>`
/** The desk's name on the rail's tag: two short lines at most, whole words (a word too long is cut by its line). */
function tagLines(name) {
  const words = String(name).trim().split(/\s+/), lines = []
  while (words.length && lines.length < 2) { let line = words.shift(); while (words.length && (line + ' ' + words[0]).length <= 6) line += ` ${words.shift()}`; lines.push(line) }
  if (words.length) lines[1] += '…'
  return lines
}
const nameSize = name => { const n = [...String(name)].length; return n <= 6 ? 's' : n <= 11 ? 'm' : 'l' }
/** The head's words: the place's name (never empty: "Desk" when a desk has none) and the chevron that opens the desk
 *  list (always there, so New desk is reachable with one desk too). Kept current by the live stream (#desk-place):
 *  a room's desks arrive after the page was drawn. */
const placeName = model => String(model?.deskName ?? '').trim() || 'Desk'
/** The pill's words (the menu's button on a wide screen): the desk's drawing and the place's name (#pill-place, live). */
const pillPlace = (model, current = null) => { const s = current ? model.byAgent.get(current) : null; return s ? html`<span class="pill-place" id="pill-place">${avatar(s, { crown: false })}<b>${s.name}</b></span>` : html`<span class="pill-place" id="pill-place"><span class="desk-lamp">${deskLamp(model)}</span><b>${placeName(model)}</b></span>` }
const deskPlace = model => html`<span class="desk-place" id="desk-place"><span class="desk-name" data-size="${nameSize(placeName(model))}">${placeName(model)}</span></span>`
const deskChevron = html`<button type="button" class="desk-switch-open" aria-haspopup="menu" aria-expanded="false" aria-controls="brand-doors" title="Desks and settings" aria-label="Desks and settings">${sk('unfold')}</button>`
export function topbar(model, base, current, session = null) {
    return html`<header class="topbar"><div class="brand">
<h1 class="deskpill"><a href="${base}/" data-nav draggable="false" class="desk-go" id="desk-go" title="${placeName(model)}: everything that waits for you"${current ? raw(' aria-current=""') : ''}><span class="desk-lamp" id="desk-lamp">${deskLamp(model)}</span>${BELL}${deskPlace(model)}</a>${deskChevron}
<button type="button" class="brand-open" id="brand-menu"${session && model.byAgent.get(session) ? html` data-session="${session}"` : ''} aria-haspopup="menu" aria-expanded="false" aria-controls="brand-doors" aria-label="Where you are: ${placeName(model)}. Menu: desks, sessions, places, settings" title="Menu (Ctrl K)">${raw(String(BELL).replace('class="brand-mark"', 'class="brand-mark open-mark"'))}<b class="open-word">Trommi</b>${pillPlace(model, session)}<span class="conn open-conn" id="conn" data-state="connecting" role="status"><i aria-hidden="true"></i><span id="conn-text" class="tc-sr">Connecting</span></span><span class="brand-fold">${sk('unfold')}</span></button>${inDemo() ? html`<a class="pill-demo" href="${base}/screens?mock=1" target="_blank" rel="noopener" title="The demo: a made-up room. Every screen of the app">Demo · All screens</a>` : ''}</h1>
${menuDoors(model, base)}
${deskSwitch(model, base)}
<button type="button" class="rail-tag" aria-haspopup="menu" aria-controls="brand-doors" title="Desk ${model.deskName}: switch desks" aria-label="Desk ${model.deskName}: switch desks"><span class="rail-tag-string" aria-hidden="true"></span><span class="rail-tag-paper"><b>${tagLines(model.deskName).map(l => html`<span>${l}</span>`)}</b></span></button>
</div></header>`
}

// The phone's menu: the pill opens it, a choice or a tap beside closes it; New Desk… makes a desk (POST /desk, as the
// wide screen's menu); All Sessions… the whole list as a sheet from below.
controller('phone-menu', class extends Controller {
  connect() {
    this.pill = document.getElementById('phone-pill')
    this.onPill = e => { e.stopPropagation(); this.toggle() }
    this.pill?.addEventListener('click', this.onPill)
    this.beside = e => { if (!this.element.hidden && !this.element.contains(e.target) && e.target !== this.pill && !this.pill?.contains(e.target)) this.close() }
    document.addEventListener('click', this.beside, true)
    this.keys = e => { if (e.key === 'Escape' && !this.element.hidden) this.close() }
    document.addEventListener('keydown', this.keys)
    this.element.addEventListener('click', e => { if (e.target.closest('a[href]')) this.close() })
  }
  disconnect() { this.pill?.removeEventListener('click', this.onPill); document.removeEventListener('click', this.beside, true); document.removeEventListener('keydown', this.keys) }
  toggle() { if (this.element.hidden) this.open(); else this.close() }
  open() { this.element.hidden = false; this.pill?.setAttribute('aria-expanded', 'true'); requestAnimationFrame(() => this.element.classList.add('is-open')) }
  close() { this.element.classList.remove('is-open'); this.pill?.setAttribute('aria-expanded', 'false'); this.element.hidden = true; const f = this.element.querySelector('.pm-desk-form'); if (f) f.hidden = true }
  newDesk() { const f = this.element.querySelector('.pm-desk-form'); f.hidden = false; f.querySelector('input').focus() }
  async makeDesk(e) {
    e.preventDefault()
    const f = e.currentTarget, name = f.querySelector('input').value.trim(), err = f.querySelector('.pm-error')
    if (!name) return
    try {
      const res = await fetch('/desk', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
      const out = await res.json().catch(() => ({}))
      if (!res.ok || !out.desk?.id) { err.textContent = `Not made: ${out.error || res.statusText}`; return }
      this.close()
      window.trommi?.router?.visit(`/?desk=${encodeURIComponent(out.desk.id)}`)
    } catch (x) { err.textContent = `Not made: ${x.message}` }
  }
})
// After a desk picked in the menu the page is drawn anew: the menu opens again where it was.
if (typeof document !== 'undefined') document.addEventListener('turbo:load', () => {
  let keep = null
  try { keep = sessionStorage.getItem('trommi-menu-keep'); sessionStorage.removeItem('trommi-menu-keep') } catch {}
  if (!keep) return
  requestAnimationFrame(() => { const doors = document.getElementById('brand-doors'); if (!doors) return; doors.hidden = false; for (const b of document.querySelectorAll('#brand-menu, .desk-switch-open, #desk-pill')) if (b.offsetParent || b.id === 'brand-menu') b.setAttribute('aria-expanded', 'true') })
})
// The phone's desk pill opens the Trommi menu (#brand-doors), the same as the sidebar's foot.
if (typeof document !== 'undefined') document.addEventListener('click', e => {
  const pill = e.target instanceof Element ? e.target.closest('#desk-pill') : null
  if (!pill) return
  e.stopImmediatePropagation()
  document.getElementById('brand-menu')?.click()
  requestAnimationFrame(() => pill.setAttribute('aria-expanded', String(document.getElementById('brand-doors')?.hidden === false)))
})
// A phone's chat: the pen opens the composer and gives it the keyboard; leaving it folds it again (a draft marks the pen).
if (typeof document !== 'undefined') {
  const root = document.documentElement, field = () => document.querySelector('#session .session-compose textarea')
  document.addEventListener('click', e => {
    if (!(e.target instanceof Element) || !e.target.closest('#compose-fab')) return
    root.dataset.compose = ''
    requestAnimationFrame(() => field()?.focus())
  })
  document.addEventListener('focusout', e => {
    if (!(e.target instanceof Element) || !e.target.closest('#session .session-compose')) return
    setTimeout(() => {
      if (document.activeElement?.closest?.('#session .session-compose')) return
      delete root.dataset.compose
      document.getElementById('compose-fab')?.toggleAttribute('data-draft', Boolean(field()?.value.trim()))
    }, 120)
  })
  document.addEventListener('turbo:load', () => { delete root.dataset.compose; document.getElementById('compose-fab')?.toggleAttribute('data-draft', Boolean(field()?.value.trim())) })
}
// The capsule stands back while the keyboard is up (a phone: a text field has the focus).
if (typeof document !== 'undefined') {
  const field = n => n instanceof Element && n.matches('input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), textarea, [contenteditable=""], [contenteditable="true"]')
  document.addEventListener('focusin', e => { if (field(e.target)) document.documentElement.dataset.keyboard = '' })
  document.addEventListener('focusout', e => { if (field(e.target)) delete document.documentElement.dataset.keyboard })
}

// ---- a phone's top line and the drawer (sidebar.css "A phone") ----
// A phone has no room for the sidebar beside the page: the same sidebar (the Desk box, the sessions, the foot with the
// Trommi menu) is a drawer that slides in from the left over the page. The slim line at the top holds its handle (three
// pen lines; a red dot while a session is stopped or a card knocks) and the name of the place in view: the desk, or
// the session with its drawing. Wide screens show neither.
const HANDLE = raw('<svg viewBox="0 0 24 24" class="sketch" aria-hidden="true"><path d="M4.2 6.9Q12 6.1 19.9 6.8"/><path d="M4.1 12.3Q11 11.6 19.6 12.2"/><path d="M4.4 17.3Q12.4 18 19.8 17.1"/></svg>')
const PLACES = { off: 'Off your mind', agents: 'Settings', room: 'Settings', artifacts: 'Artifacts', whiteboard: 'Scribble Board' }
/** The phone's menu (his word, 8 October): a glass sheet that grows out of the pill: Settings; the desks (the one in
 *  view checked, New Desk…); the sessions (the first eight by what waits and activity, then All Sessions… as a sheet
 *  from below); then Scribble, Artifacts. */
function phoneMenu(model, base) {
  const fresh = model.allFresh ?? model.fresh
  const desks = desksOf(model), here = d => !model.all && (model.desk ? d.id === model.desk : d === desks[0])
  const row = (href, icon, word, { on = false, n = 0, cls = '' } = {}) => html`<a role="menuitem" class="pm-row${cls ? ` ${cls}` : ''}" data-nav draggable="false" href="${href}"${on ? raw(' aria-current="true"') : ''}>${icon}<b>${word}</b>${n ? html`<i class="pm-n">${n}</i>` : ''}${on ? html`<span class="pm-check">${sk('tick')}</span>` : ''}</a>`
  return html`<div class="phone-menu" id="phone-menu" role="menu" aria-label="Desks and places" data-controller="phone-menu" hidden>
${row(`${base}/settings`, sk('key'), 'Settings', { cls: 'is-settings' })}
<p class="pm-h">Desks</p>
${desks.length > 1 ? row(`${base}/?desk=all`, deskMark(false), 'All Desks', { on: Boolean(model.all), n: fresh.length }) : ''}${desks.map(d => row(`${base}/?desk=${d.id}`, deskMark(false), d.name, { on: here(d) }))}
<button type="button" class="pm-row pm-add" data-action="phone-menu#newDesk">${PLUS}<b>New Desk…</b></button>
<form class="pm-desk-form" data-action="submit->phone-menu#makeDesk" hidden><input name="name" maxlength="40" placeholder="Name of the new desk" aria-label="Name of the new desk" autocomplete="off"><button type="submit">Add</button><p class="pm-error" role="alert"></p></form>
<div class="pm-places">${row(`${base}/scribble-board`, sk('pen'), 'Scribble')}${row(`${base}/artifacts`, sk('picture'), 'Artifacts')}</div>
</div>`
}

/** In a chat (a phone): its title, the drawing and the name with ▾, opens the agents of the desk in view to switch to. */
function chatSwitch(model, base, current) {
  const s = model.byAgent.get(current)
  if (!s) return ''
  const fresh = model.allFresh ?? model.fresh
  const deskId = model.deskOf?.(s)
  const mates = model.agents.filter(a => !a.archived && (model.deskOf?.(a) ?? null) === (deskId ?? null))
  return html`<button type="button" class="phone-pill chat-title" id="phone-pill" aria-haspopup="menu" aria-controls="phone-menu" aria-expanded="false" aria-label="${s.name}: switch to another agent">${avatar(s, { crown: false })}<b>${s.name}</b>${sk('unfold')}</button>
<div class="phone-menu" id="phone-menu" role="menu" aria-label="Agents of this desk" data-controller="phone-menu" hidden><p class="pm-h">${model.desks?.find(d => d.id === deskId)?.name ?? 'This desk'}</p>${mates.map(a => { const n = fresh.filter(c => c.agent === a.id).length; return html`<a role="menuitem" class="pm-row" data-nav draggable="false" href="${base}/s/${encodeURIComponent(a.id)}"${a.id === s.id ? raw(' aria-current="true"') : ''}>${avatar(a, { crown: false })}<b>${a.name}</b>${n ? html`<i class="pm-n">${n}</i>` : ''}${a.id === s.id ? html`<span class="pm-check">${sk('tick')}</span>` : ''}</a>` })}</div>`
}

// The chats (a phone's Chat tab): the last chat opened (the crowned session's at first); what is new since.
const CHAT_KEY = 'trommi-last-chat', READ_KEY = 'trommi-chat-read'
const readMap = () => { try { return JSON.parse(localStorage.getItem(READ_KEY) || '{}') } catch { return {} } }
export function chatOpened(id) { try { localStorage.setItem(CHAT_KEY, id); const m = readMap(); m[id] = Date.now(); localStorage.setItem(READ_KEY, JSON.stringify(m)) } catch {} }
const lastChat = model => { let id = null; try { id = localStorage.getItem(CHAT_KEY) } catch {} ; return (id && model.byAgent.get(id) && !model.byAgent.get(id).archived ? id : null) ?? crownOf(model)?.id ?? model.agents.find(a => !a.archived)?.id ?? null }
/** Sessions with something new since he last opened their chat (their last activity after that). */
const unreadChats = model => { const m = readMap(); return model.agents.filter(a => !a.archived && Number(a.seen) > (m[a.id] ?? 0)).length }
export function chatsMain(model, base) {
  const fresh = model.allFresh ?? model.fresh, m = readMap()
  const list = [...model.agents.filter(a => !a.archived)].sort((x, y) => (Number(y.seen) || 0) - (Number(x.seen) || 0))
  return html`<main id="chats" class="chats-page" aria-label="Chats"><h1 class="chats-h">Chats</h1><ul class="chats-list">${list.map(a => { const n = fresh.filter(c => c.agent === a.id).length, nw = Number(a.seen) > (m[a.id] ?? 0); return html`<li><a class="chats-row${nw ? ' is-new' : ''}" data-nav draggable="false" href="${base}/s/${encodeURIComponent(a.id)}">${avatar(a, { crown: false })}<span class="chats-words"><b>${a.name}</b><small>${a.task || a.model || ''}</small></span><span class="chats-side">${a.seen ? agoSpan(Number(a.seen), 'ago') : ''}${n ? html`<i class="pm-n">${n}</i>` : ''}</span></a></li>` })}</ul></main>`
}

export function phoneBar(model, base, { view = '', current = null, title = '' } = {}) {
  const waits = (model.blocked ?? 0) + (model.knocking ?? 0) > 0
  // In a chat: back to the chats, its title switches the agent. Elsewhere the pill: the desk's drawing and name with
  // ▾; it opens the phone's menu (phoneMenu).
  if (view === 'session' && current) return html`<div class="phone-bar is-chat" id="phone-bar"><a class="phone-back" data-nav draggable="false" href="${base}/chats" aria-label="Chats">${raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.8 5.6Q11 9 7.6 12.1Q11 15.4 14.9 18.6"/></svg>')}</a>${chatSwitch(model, base, current)}</div>`
  const place = ['desk', 'card', 'picture', 'chats'].includes(view) ? ''
    : html`<span class="phone-place"><b>${PLACES[view] ?? String(title).replace(/^\(\d+\) /, '').replace(/ · Trommi$/, '')}</b></span>`
  return html`<div class="phone-bar" id="phone-bar"><button type="button" class="phone-pill" id="desk-pill" data-opens="brand-doors" aria-haspopup="menu" aria-controls="brand-doors" aria-expanded="false" aria-label="${placeName(model)}: desks and places" title="Desks and places"${waits ? raw(' data-waits') : ''}><span class="desk-lamp" id="phone-lamp">${deskMark(false)}</span><b>${placeName(model)}</b>${sk('unfold')}</button>${place}</div>`
}
export const DRAWER_VEIL = raw('<div class="drawer-veil" id="drawer-veil" aria-hidden="true"></div>')

/** The drawer's switch: <html data-drawer="open">. The handle and the veil open and close it, Escape and a choice made
 *  in it close it; a finger opens it from the left edge and pushes it back (the drawer follows the finger: --dx). */
function drawer() {
  const root = document.documentElement, phone = matchMedia('(max-width: 860px)')
  const isOpen = () => root.dataset.drawer === 'open'
  requestAnimationFrame(paintTopStrip)
  const width = () => $('#agents')?.offsetWidth || 300
  const set = (open, { focus = true } = {}) => {
    if (open === isOpen()) return
    if (open) root.dataset.drawer = 'open'; else delete root.dataset.drawer
    $('#drawer-open')?.setAttribute('aria-expanded', String(open))
    paintTopStrip()
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
  // (his word, 8 October: Push and Theme and picking a desk keep the menu open, the board behind changes live; what
  // goes to another page closes it; Esc and a click beside it close it too)
  chosen(event) {
    const t = event.target
    if (t.closest('#push-toggle, #theme-toggle, #desk-add, .menu-desk-pen, .menu-desk-form')) return
    if (t.closest('.menu-desk[data-desk]')) { try { sessionStorage.setItem('trommi-menu-keep', '1') } catch {} return }
    if (t.closest('[role="menuitem"]:not([data-menu-body-param]), [role="menuitemradio"], [role="option"]')) this.close()
  }

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
  t.get(/^\/chats$/, ({ req, res }) => { const m = t.model(); t.page(req, res, { model: m, title: 'Chats · Trommi', view: 'chats', main: chatsMain(m, BASE) }) })
  document.addEventListener('turbo:load', () => { const m = /^\/s\/([^/?#]+)$/.exec(location.pathname); if (m) chatOpened(decodeURIComponent(m[1])) })
  // The Trommi menu opens and closes (its button, a click beside it, Escape); the theme switch.
  const shut = () => { const doors = $('#brand-doors'); if (doors && !doors.hidden) { doors.hidden = true; $('#brand-menu')?.setAttribute('aria-expanded', 'false'); delete doors.dataset.from } }
  document.addEventListener('click', e => {
    const t = e.target instanceof Element ? e.target : null
    if (!t) return
    // the desk switcher: the chevron beside the desk's name and the rail's tag (with one desk the tag opens the menu)
    if (t.closest('.desk-word-add')) { shut(); const sw0 = $('#desk-switch'); if (sw0) sw0.hidden = true; $('#brand-menu')?.click(); requestAnimationFrame(() => $('#desk-add')?.click()); return }
    // (his word, 8 October: the whole Trommi menu opens from the desk head's chevron, and from the folded rail's tag)
    if (t.closest('.desk-switch-open, .rail-tag') && !t.closest('#desk-pill')) { const doors = $('#brand-doors'), b = $('#brand-menu'); if (doors && b) { doors.dataset.from = 'head'; doors.hidden = !doors.hidden; b.setAttribute('aria-expanded', String(!doors.hidden)); for (const o of document.querySelectorAll('.desk-switch-open, .rail-tag')) o.setAttribute('aria-expanded', String(!doors.hidden)) } return }
    const sw = $('#desk-switch'), opener = t.closest('.desk-switch-open, .rail-tag')
    if (sw && opener) { const open = sw.hidden; sw.hidden = !open; for (const b of document.querySelectorAll('.desk-switch-open, .rail-tag')) b.setAttribute('aria-expanded', String(open)); shut(); return }
    if (sw && !sw.hidden && (!t.closest('#desk-switch') || t.closest('a[href]'))) { sw.hidden = true; for (const b of document.querySelectorAll('.desk-switch-open, .rail-tag')) b.setAttribute('aria-expanded', 'false') }
    const menu = t.closest('#brand-menu, .rail-tag') && $('#brand-menu'), doors = $('#brand-doors')   // (with one desk the rail's tag opens the menu, at its desks)
    if (menu && doors) { delete doors.dataset.from; doors.hidden = !doors.hidden; menu.setAttribute('aria-expanded', String(!doors.hidden)); return }
    if (doors && !doors.hidden && !t.closest('#brand-doors')) shut()
    // the demo: a switch, never a desk; off takes the tab back to its own room for sure (app.mjs ?mock=0)
    if (t.closest('#demo-toggle')) { location.assign(inDemo() ? '/?mock=0' : '/?mock=1'); return }
    if (t.closest('#theme-toggle')) setThemeMode(nextThemeMode())   // Light → Dark → System
  })
  // The phone's bar: Note opens the corner note (the sticky itself stands back on a phone with the bar).
  document.addEventListener('click', e => {
    const tab = e.target instanceof Element ? e.target.closest('.tab[data-tab="note"]') : null
    if (!tab) return
    const box = $('#corner-note-box'), head = $('#corner-note-box .corner-note-head')
    if (box?.dataset.tabClosed) { delete box.dataset.tabClosed; tab.setAttribute('aria-expanded', 'false'); return }
    head?.click()
    requestAnimationFrame(() => tab.setAttribute('aria-expanded', String($('#corner-note-box .corner-note-head')?.getAttribute('aria-expanded') === 'true')))
  })
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { shut(); const sw = $('#desk-switch'); if (sw && !sw.hidden) { sw.hidden = true; $('.desk-switch-open')?.focus() } } })
  drawer()
  // The rail is a wide screen's: a narrow window has the drawer, whole (the head's data-rail is taken off there).
  const narrow = matchMedia('(max-width: 860px)')
  const rail = () => { if (narrow.matches) delete document.documentElement.dataset.rail; else { try { if (localStorage.getItem(KEY) === 'folded') document.documentElement.dataset.rail = 'folded' } catch {} } dispatchEvent(new Event('resize')) }
  narrow.addEventListener('change', rail)
  if (narrow.matches) rail()
  t.live('', {
    take: m => ({ waits: (m.blocked ?? 0) + (m.knocking ?? 0) > 0, sidebar: sidebarRows(m, BASE), rows: sidebarParts(m, BASE), lamp: deskLamp(m), place: deskPlace(m), pill: pillPlace(m), noteIco: noteGlyph(m), badge: waitingBadge((m.allFresh ?? m.fresh).length, (m.allFresh ?? m.fresh).some(c => ['high', 'critical'].includes(c.urgency))), sw: deskSwitchList(m, BASE), desks: menuDeskRows(m, BASE), notes: cornerNote(m, BASE) }),
    diff: (was, now) => `${was.waits !== now.waits ? (document.getElementById('drawer-open')?.toggleAttribute('data-waits', now.waits), '') : ''}${t.differs(was.notes, now.notes) ? stream('replace', 'corner-note-box', now.notes) : ''}${t.differs(was.sw, now.sw) && now.sw ? stream('replace', 'desk-switch-list', now.sw) : ''}${t.differs(was.place, now.place) ? stream('replace', 'desk-place', now.place) : ''}${t.differs(was.pill, now.pill) && !document.getElementById('brand-menu')?.dataset.session ? stream('replace', 'pill-place', now.pill) : ''}${t.differs(was.noteIco, now.noteIco) ? stream('replace', 'tab-note-ico', now.noteIco) : ''}${t.differs(was.badge, now.badge) ? stream('replace', 'tab-badge', now.badge) : ''}${t.differs(was.lamp, now.lamp) ? stream('update', 'desk-lamp', now.lamp) + stream('update', 'phone-lamp', now.lamp) : ''}${t.differs(was.desks, now.desks) ? stream('replace', 'menu-desk-rows', now.desks) : ''}${!t.differs(was.sidebar, now.sidebar) ? ''
      : was.rows.shape !== now.rows.shape ? stream('update', 'agents', now.sidebar)
        : [...now.rows.here, ...now.rows.away].map(([id, row], i) => (t.differs([...was.rows.here, ...was.rows.away][i][1], row) ? stream('replace', `agent-${id}`, row) : '')).join('')}`,
  })
}

