// A card's page (server/views/card.mjs). The page works without this: every answer is a button of one form.
// This adds what needs a script: the pencil that opens the note on one option, the draft kept on the hub while
// typing, Enter that sends, the names of attached files (also pasted or dropped), and the arrow of the pen from
// the picture shown to the option it belongs to.
import { Controller } from '@hotwired/stimulus'
import { arrowStrokes } from '/js/pen.js'

const NS = 'http://www.w3.org/2000/svg'
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi)
let turn = 0

export default class extends Controller {
  static targets = ['form', 'field', 'files', 'chips', 'saved', 'figure', 'marks', 'revise', 'reviseField', 'reviseMarks']
  static values = { draft: String, pictures: Array }

  connect() {
    this.grow()
    if (this.hasMarksTarget) this.mountMarks()
    this.link = this.link.bind(this)
    addEventListener('resize', this.link)
    this.element.addEventListener('scroll', this.link, { capture: true, passive: true })
    this.link()
  }
  disconnect() {
    removeEventListener('resize', this.link)
    this.element.removeEventListener('scroll', this.link, { capture: true })
    clearTimeout(this.timer)
  }

  // ---- marks: draw on the card with the pen, write a note at a paragraph (the old client's js/focus-marks.js) ----
  // They travel in the form's field "marks" with whatever is pressed, and in the draft while nothing is.
  async mountMarks() {
    const { cardMarks } = await import('/js/focus-marks.js')
    const left = this.element.querySelector('.tc-left')
    if (!left || !this.element.isConnected || this.marksUi) return
    const labels = new Map([...this.element.querySelectorAll('.tc-opt[data-key]')].map(b => [b.dataset.key, b.querySelector('.tc-opt-label')?.textContent ?? b.dataset.key]))
    this.marksUi = cardMarks({
      scroll: left,
      blocks: () => [...left.querySelectorAll('.tc-title, .tc-text .rich > *, .focus-mark')],
      labelOf: key => labels.get(key) ?? key,
      onChange: () => { this.marksTarget.value = JSON.stringify(this.marksUi.get()); this.keep() },
    })
    try { this.marksUi.set(JSON.parse(this.marksTarget.value || '[]')) } catch {}
    this.element.querySelector('.tc-ask-row .tc-clip')?.after(this.marksUi.controls)
  }

  // ---- Revise: the small field under the reverse card ----
  // Its words are kept in this browser while it is open (the hub's draft holds the field below the card).
  get reviseKey() { return `trommi-revise-${this.element.dataset.id}` }
  reviseToggle() {
    if (this.reviseTarget.open) {
      try { this.reviseFieldTarget.value = sessionStorage.getItem(this.reviseKey) ?? '' } catch {}
      requestAnimationFrame(() => this.reviseFieldTarget.focus())
    }
  }
  reviseKeep() { try { sessionStorage.setItem(this.reviseKey, this.reviseFieldTarget.value) } catch {} }
  reviseKeys(event) {
    if (event.key === 'Escape') { event.preventDefault(); this.reviseTarget.open = false; this.reviseTarget.querySelector('summary').focus(); return }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); event.currentTarget.form.requestSubmit() }
  }
  // Nothing written: nothing happens. Marks drawn on the card go along.
  reviseSend(event) {
    if (!this.reviseFieldTarget.value.trim()) { event.preventDefault(); this.reviseFieldTarget.focus(); return }
    if (this.hasMarksTarget) this.reviseMarksTarget.value = this.marksTarget.value
    clearTimeout(this.timer)
    try { sessionStorage.removeItem(this.reviseKey) } catch {}
  }
  openRevise() { if (!this.hasReviseTarget) return false; this.reviseTarget.open = true; this.reviseToggle(); return true }

  // ---- an option's picture: while the pointer or the keyboard is on an option, its picture stands on the stage ----
  // (A finger has no hover: a tap answers, as before. Leaving the options puts the picture back that stood.)
  preview(event) {
    if (event.pointerType === 'touch') return
    const key = event.target.closest?.('.tc-opt[data-key]')?.dataset.key
    const pic = key != null && this.picturesValue.find(p => (p.keys ?? [p.key]).includes(key))
    if (pic) this.stage(pic, false, key)
  }
  unpreview(event) {
    if (event.relatedTarget instanceof Element && event.relatedTarget.closest('.tc-opts') === event.currentTarget) return
    if (this.shown) { const back = this.shown; this.shown = null; this.stage(back, true) }
  }
  // key: the option the picture stands for now (a picture several options share points at the one under the pointer).
  stage(pic, restoring = false, key = pic.key) {
    if (!this.hasFigureTarget) return
    const fig = this.figureTarget, img = fig.querySelector('img')
    const now = { at: Number(fig.dataset.at), key: fig.dataset.key ?? null }
    if (!restoring && !this.shown) this.shown = { ...(this.picturesValue.find(p => p.at === now.at) ?? {}), key: now.key }
    if (now.at === pic.at) { if (key != null) fig.dataset.key = key; return this.link() }
    img.src = pic.src
    if (pic.srcset) img.srcset = pic.srcset; else img.removeAttribute('srcset')
    fig.dataset.at = pic.at
    fig.href = pic.href
    if (key != null) fig.dataset.key = key; else delete fig.dataset.key
    fig.dataset.circlesMarksValue = JSON.stringify(pic.marks ?? [])
    const where = this.element.querySelector('.tc-where')
    if (where) where.textContent = `${pic.at} / ${this.picturesValue.length} · ${pic.name}`
    this.element.querySelectorAll('.tc-thumb').forEach((t, i) => t.setAttribute('aria-pressed', String(i + 1 === pic.at)))
    img.addEventListener('load', () => this.link(), { once: true })
    this.link()
  }

  // ---- the note on one option: the pencil opens its line ----
  note(event) {
    event.preventDefault()
    event.stopPropagation()
    const row = this.element.querySelector(`.tc-opt-note[data-note="${CSS.escape(event.currentTarget.dataset.key)}"]`)
    if (!row) return
    row.hidden = false
    row.querySelector('input').focus()
  }
  // (left empty, the line goes again; Enter in it is no answer)
  noteLeft({ currentTarget }) {
    const row = currentTarget.closest('.tc-opt-note'), said = currentTarget.value.trim()
    if (!said) row.hidden = true
    this.element.querySelector(`.tc-opt-pen[data-key="${CSS.escape(row.dataset.note)}"]`)?.toggleAttribute('data-noted', Boolean(said))
  }
  noteKey(event) { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } }

  // ---- the field ----
  typed() { this.grow(); this.keep() }
  grow() { const f = this.hasFieldTarget ? this.fieldTarget : null; if (f) { f.style.height = 'auto'; f.style.height = `${Math.min(f.scrollHeight, 220)}px` } }
  // Enter sends, Shift+Enter is a new line.
  keys(event) {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || (!this.fieldTarget.value.trim() && !this.filesTarget.files.length)) return
    event.preventDefault()
    this.formTarget.requestSubmit(this.formTarget.querySelector('.tc-send'))
  }

  // ---- the draft: what is ticked and written is kept on the hub a moment after the last stroke ----
  keep() {
    if (!this.draftValue) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.save(), 700)
  }
  async save() {
    const body = new URLSearchParams()
    for (const [name, value] of new FormData(this.formTarget)) if (typeof value === 'string' && (name === 'note' || name === 'keys' || name === 'marks' || name.startsWith('note-'))) body.append(name, value)
    const say = (state, words) => { if (this.hasSavedTarget) { this.savedTarget.hidden = false; this.savedTarget.dataset.state = state; this.savedTarget.textContent = words } }
    try {
      const res = await fetch(this.draftValue, { method: 'POST', body })
      say(res.ok ? 'saved' : 'failed', res.ok ? 'Saved' : 'Not saved')
    } catch { say('failed', 'Not saved') }
  }
  // (an answer is on its way: a save that is still waiting must not come after it)
  sent() { clearTimeout(this.timer) }

  // ---- files: chosen, pasted or dropped ----
  files() {
    const list = [...this.filesTarget.files]
    this.chipsTarget.hidden = !list.length
    this.chipsTarget.replaceChildren(...list.map(f => { const chip = document.createElement('span'); chip.className = 'focus-chip'; chip.textContent = f.name; return chip }))
    if (list.length) {
      const drop = document.createElement('button')
      drop.type = 'button'; drop.className = 'focus-chip t-chip-drop'; drop.textContent = 'Remove'
      drop.addEventListener('click', () => { this.filesTarget.value = ''; this.files() })
      this.chipsTarget.append(drop)
    }
  }
  add(list) {
    const all = new DataTransfer()
    for (const f of [...this.filesTarget.files, ...list]) all.items.add(f)
    this.filesTarget.files = all.files
    this.files()
  }
  paste(event) { const got = [...(event.clipboardData?.files ?? [])]; if (got.length) { event.preventDefault(); this.add(got) } }
  over(event) { if (event.dataTransfer?.types.includes('Files')) event.preventDefault() }
  drop(event) { const got = [...(event.dataTransfer?.files ?? [])]; if (got.length) { event.preventDefault(); this.add(got) } }

  // ---- the arrow: one line of the pen from the picture shown to the option it belongs to ----
  // The picture names its option (data-key); the option is marked (data-match) and, where the answers stand beside
  // the picture and both ends are in sight, the arrow is drawn into the option's left edge.
  link() {
    const host = this.element.querySelector('.tc-card')
    if (!host) return
    const picture = host.querySelector('.tc-media .tc-figure'), key = picture?.dataset.key
    for (const b of host.querySelectorAll('.tc-opt[data-key]')) b.toggleAttribute('data-match', key != null && b.dataset.key === key)
    const tile = host.querySelector('.tc-opt[data-match]'), answer = host.querySelector('.tc-right'), scroll = host.querySelector('.tc-left')
    const old = host.querySelector(':scope > .focus-arrow')
    const gone = () => { old?.remove(); this.arrowSig = '' }
    if (!picture || !tile || !answer || !scroll) return gone()
    const base = host.getBoundingClientRect()
    const box = n => { const r = n.getBoundingClientRect(); return { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height } }
    const P = box(picture), T = box(tile), A = box(answer), F = box(scroll), L = box(tile.parentElement)
    if (A.x < P.x + P.w - 1) return gone()   // a narrow window: the answers stand under the pictures
    const top = Math.max(P.y, F.y), bottom = Math.min(P.y + P.h, F.y + F.h)
    if (!P.w || bottom - top < 70 || T.y < L.y - 2 || T.y + T.h > L.y + L.h + 2) return gone()
    const ring = picture.querySelector(':scope > .focus-circles > path')?.getBoundingClientRect()
    const sig = [P.x, top, P.w, T.x, T.y, T.h, ring?.right ?? 0, ring?.top ?? 0].map(Math.round).join()
    if (sig === this.arrowSig && old) return
    this.arrowSig = sig
    old?.remove()
    const mid = T.y + T.h / 2
    // (it starts at the first circle where the agent marked a region, else near the picture's edge)
    const from = ring?.width ? [ring.right - base.left - 2, clamp(ring.top - base.top + ring.height / 2, top + 6, bottom - 6)] : [P.x + P.w - 30, clamp(mid - 46, top + 22, bottom - 22)]
    const gx = Math.max(P.x + P.w + 12, T.x - 26)   // down the gap just before the options, never across the words
    const points = [from, [P.x + P.w - 6, from[1] + 5], [gx - 8, from[1] + 9], [gx + 4, from[1] + (mid - from[1]) * .45], [gx + 6, mid - (mid > from[1] ? 14 : -14)], [gx + 12, mid - (mid > from[1] ? 3 : -3)], [T.x - 2, mid]]
    const svg = document.createElementNS(NS, 'svg')
    svg.setAttribute('class', 'focus-arrow')
    svg.setAttribute('aria-hidden', 'true')
    for (const d of arrowStrokes(points, `${tile.dataset.key}:${turn++}`)) { const path = document.createElementNS(NS, 'path'); path.setAttribute('d', d); svg.append(path) }
    host.append(svg)
  }
}
