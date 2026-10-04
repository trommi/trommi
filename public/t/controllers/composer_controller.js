// The composer of a session's page (views/session.mjs): a plain form that works by itself. This adds what a form
// cannot do alone: Enter sends (Shift+Enter is a new line; on a touch screen Enter stays a new line, and Ctrl/Cmd+Enter
// sends everywhere), the field grows with its words, the chosen files stand as chips that can be taken off, a pasted
// picture or a file dropped anywhere on the page is attached, a card copied elsewhere ("Copy" on a card, controller
// "clip") is offered and goes along as a chip, and what was typed survives a reload.
//
// Sending shows the message at once: the moment the form is taken (turbo:submit-start, after the router read it),
// the composer puts its own copy at the log's end and is empty again. The core's echo (the real message, pending)
// replaces that copy when it arrives (controller "log"); a refusal takes it out and gives the words and files back.
import { Controller } from '/js/app/stimulus.mjs'

const MAX_FILES = 12
const MAX_CARDS = 5
const CLIP_KEY = 'trommi-cardclip'   // written by controller "clip": { id, number, title, choice_label, text }
const fine = matchMedia('(pointer: fine)')
const two = n => String(n).padStart(2, '0')
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }
const held = () => { try { const c = JSON.parse(sessionStorage.getItem(CLIP_KEY) ?? 'null'); return c?.id ? c : null } catch { return null } }

export default class extends Controller {
  static targets = ['field', 'picker', 'chips', 'send']
  static values = { agent: String, focus: Boolean }

  connect() {
    this.cards = []
    if (!this.fieldTarget.value) { try { this.fieldTarget.value = localStorage.getItem(this.key) ?? '' } catch {} }
    this.paint()
    if (this.focusValue) { this.fieldTarget.focus(); this.fieldTarget.setSelectionRange(this.fieldTarget.value.length, this.fieldTarget.value.length) }
  }
  // Gone with the page: the previews' object URLs are let go.
  disconnect() { this.revoke() }
  revoke() { if (this.hasChipsTarget) for (const img of this.chipsTarget.querySelectorAll('img')) URL.revokeObjectURL(img.src) }
  get key() { return `agent-board-draft:${this.agentValue}` }
  forget() { try { localStorage.removeItem(this.key) } catch {} }
  get empty() { return !this.fieldTarget.value.trim() && !this.pickerTarget.files.length && !this.cards.length }

  fit() {
    const field = this.fieldTarget
    field.style.height = 'auto'
    const max = Math.max(120, Math.min(260, innerHeight * 0.36))
    field.style.height = `${Math.min(field.scrollHeight, max)}px`
    field.style.overflowY = field.scrollHeight > max ? 'auto' : 'hidden'
    this.sendTarget.disabled = this.empty
  }
  typed() { this.fit(); try { localStorage.setItem(this.key, this.fieldTarget.value) } catch {} }
  keys(e) {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return
    if (!(fine.matches || e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    if (!this.sendTarget.disabled) this.element.requestSubmit(this.sendTarget)
  }
  // A click anywhere in the box goes to the field, as in a text box.
  aim(e) { if (e.target === this.element) this.fieldTarget.focus() }

  // ---- sending ----
  start() {
    const files = [...this.pickerTarget.files]
    this.sending = { text: this.fieldTarget.value, files, cards: this.cards, echo: this.echo(this.fieldTarget.value.trim(), files, this.cards) }
    if (this.cards.length) { try { sessionStorage.removeItem(CLIP_KEY) } catch {} }
    this.fieldTarget.value = ''
    this.cards = []
    this.forget()
    this.setFiles([])
  }
  // Sent: the core has it. Not sent (422, or an error): the copy leaves, the words and files come back.
  sent(e) {
    const was = this.sending
    this.sending = null
    if (!was || e.detail.success) return
    was.echo?.remove()
    if (!this.fieldTarget.value) this.fieldTarget.value = was.text
    if (!this.cards.length) this.cards = was.cards
    if (!this.pickerTarget.files.length) this.setFiles(was.files)
    else this.paint()
    this.typed()
  }
  /** Our own copy of the message at the log's end, in the markup the session view gives a message of the human. */
  echo(text, files, cards) {
    const end = document.getElementById(`log-end-${this.agentValue}`)
    if (!end || (!text && !files.length && !cards.length)) return null
    const msg = el('article', 'msg msg-user')
    msg.dataset.echo = ''
    const prev = end.previousElementSibling
    if (prev?.matches('.msg-user') && !prev.querySelector('.cardclip-row, .shots, .files')) msg.classList.add('cont')
    const pics = files.filter(f => f.type.startsWith('image/')), rest = files.filter(f => !f.type.startsWith('image/'))
    if (pics.length) {
      const shots = el('div', `shots${pics.length === 1 ? ' shots-one' : ''}`)
      for (const f of pics) { const a = el('span', 'shot'), img = el('img'); img.src = URL.createObjectURL(f); img.alt = f.name; img.onload = () => URL.revokeObjectURL(img.src); a.append(img); shots.append(a) }
      msg.append(shots)
    }
    if (rest.length) { const box = el('div', 'files'); for (const f of rest) { const chip = el('span', 'file-chip'); chip.append(el('span', '', f.name)); box.append(chip) } msg.append(box) }
    if (cards.length) {
      const row = el('div', 'cardclip-row')
      for (const c of cards) { const chip = el('span', 'cardclip-chip is-link'); chip.append(el('b', '', `Nr. ${c.number}`), el('span', 'cardclip-title', c.title)); row.append(chip) }
      msg.append(row)
    }
    if (text) { const bubble = el('div', 'bubble'); bubble.append(el('p', '', text)); msg.append(bubble) }
    const now = new Date(), time = el('time', 'msg-time', `${two(now.getHours())}:${two(now.getMinutes())}`)
    time.dateTime = now.toISOString()
    msg.append(time)
    end.before(msg)
    return msg
  }

  // ---- files ----
  setFiles(list) {
    const dt = new DataTransfer()
    for (const f of list.slice(0, MAX_FILES)) dt.items.add(f)
    this.pickerTarget.files = dt.files
    this.paint()
  }
  add(files) { if (files.length) this.setFiles([...this.pickerTarget.files, ...files]) }
  off({ params: { at } }) { this.setFiles([...this.pickerTarget.files].filter((_, n) => n !== at)) }

  // ---- copied cards ----
  takeCard() {
    const c = held()
    if (c && !this.cards.some(x => x.id === c.id) && this.cards.length < MAX_CARDS) this.cards = [...this.cards, c]
    this.paint()
    this.fieldTarget.focus()
  }
  dropOffer() { try { sessionStorage.removeItem(CLIP_KEY) } catch {} this.paint() }
  cardOff({ params: { id } }) { this.cards = this.cards.filter(c => c.id !== id); this.paint() }

  paint() {
    this.revoke()
    const chips = [...this.pickerTarget.files].map((file, at) => {
      const chip = el('span', 'composer-file')
      if (file.type.startsWith('image/')) {
        const thumb = el('img')
        thumb.src = URL.createObjectURL(file)
        thumb.alt = ''
        chip.classList.add('has-thumb')
        chip.append(thumb)
      }
      const off = el('button', 'composer-file-off', '×')
      off.type = 'button'
      off.title = `${file.name}: take it off`
      off.setAttribute('aria-label', off.title)
      off.dataset.action = 'composer#off'
      off.dataset.composerAtParam = String(at)
      chip.append(el('span', '', file.name), off)
      return chip
    })
    for (const c of this.cards) {
      const chip = el('span', 'cardclip-chip')
      const off = el('button', 'cardclip-off', '×')
      off.type = 'button'
      off.setAttribute('aria-label', `Nr. ${c.number}: take it off`)
      off.dataset.action = 'composer#cardOff'
      off.dataset.composerIdParam = c.id
      const input = el('input')
      input.type = 'hidden'; input.name = 'cards'; input.value = c.id
      chip.title = `Nr. ${c.number} · ${c.title}${c.choice_label ? ` → ${c.choice_label}` : ''}`
      chip.append(el('b', '', `Nr. ${c.number}`), el('span', 'cardclip-title', c.title), ...(c.choice_label ? [el('span', 'cardclip-answer', `→ ${c.choice_label}`)] : []), off, input)
      chips.push(chip)
    }
    // A card copied elsewhere and not attached yet: offered, one click attaches it.
    const c = held()
    if (c && !this.cards.some(x => x.id === c.id) && this.cards.length < MAX_CARDS) {
      const offer = el('span', 'cardclip-offer')
      const take = el('button', 'cardclip-paste', `Paste Nr. ${c.number}`)
      take.type = 'button'; take.title = `Attach the copied card: ${c.title}`; take.dataset.action = 'composer#takeCard'
      const drop = el('button', 'cardclip-off', '×')
      drop.type = 'button'; drop.setAttribute('aria-label', 'Forget the copied card'); drop.dataset.action = 'composer#dropOffer'
      offer.append(take, drop)
      chips.push(offer)
    }
    this.chipsTarget.replaceChildren(...chips)
    this.element.toggleAttribute('data-files', this.pickerTarget.files.length > 0 || this.cards.length > 0)
    this.fit()
  }
  paste(e) {
    // The line a card's "Copy" wrote: the card itself, as a chip.
    const c = held(), said = e.clipboardData?.getData('text/plain')?.trim()
    if (c && said && said === String(c.text ?? '').trim()) { e.preventDefault(); this.takeCard(); return }
    const files = [...(e.clipboardData?.files ?? [])].map(f => (f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${Date.now()}.${(f.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg')}`, { type: f.type })))
    if (files.length) { e.preventDefault(); this.add(files) }
  }
  // A file dragged over the page: the box shows that it takes it; dropped anywhere, it is attached.
  over(e) { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); this.element.classList.add('is-drop') } }
  left(e) { if (!e.relatedTarget) this.element.classList.remove('is-drop') }
  drop(e) {
    this.element.classList.remove('is-drop')
    const files = [...(e.dataTransfer?.files ?? [])]
    if (files.length) { e.preventDefault(); this.add(files); this.fieldTarget.focus() }
  }
}
