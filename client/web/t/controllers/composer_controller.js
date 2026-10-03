// The composer of a session's page (server/views/session.mjs): a plain form that works by itself. This adds what
// a form cannot do alone: Enter sends (Shift+Enter is a new line; on a touch screen Enter stays a new line, and
// Ctrl/Cmd+Enter sends everywhere), the field grows with its words, the chosen files stand as chips that can be
// taken off, a pasted picture or a file dropped anywhere on the page is attached, and what was typed survives a
// reload. Nothing is fetched or drawn here; the form is sent as it is.
import { Controller } from '@hotwired/stimulus'

const MAX_FILES = 12
const fine = matchMedia('(pointer: fine)')

export default class extends Controller {
  static targets = ['field', 'picker', 'chips', 'send']
  static values = { agent: String, focus: Boolean }

  connect() {
    if (!this.fieldTarget.value) { try { this.fieldTarget.value = localStorage.getItem(this.key) ?? '' } catch {} }
    this.paint()
    if (this.focusValue) { this.fieldTarget.focus(); this.fieldTarget.setSelectionRange(this.fieldTarget.value.length, this.fieldTarget.value.length) }
  }
  // Replaced (a fresh form after sending) or gone with the page: the previews' object URLs are let go.
  disconnect() { this.revoke() }
  revoke() { if (this.hasChipsTarget) for (const img of this.chipsTarget.querySelectorAll('img')) URL.revokeObjectURL(img.src) }
  get key() { return `agent-board-draft:${this.agentValue}` }
  forget() { try { localStorage.removeItem(this.key) } catch {} }

  fit() {
    const field = this.fieldTarget
    field.style.height = 'auto'
    const max = Math.max(120, Math.min(260, innerHeight * 0.36))
    field.style.height = `${Math.min(field.scrollHeight, max)}px`
    field.style.overflowY = field.scrollHeight > max ? 'auto' : 'hidden'
    this.sendTarget.disabled = !field.value.trim() && !this.pickerTarget.files.length
  }
  typed() { this.fit(); try { localStorage.setItem(this.key, this.fieldTarget.value) } catch {} }
  keys(e) {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return
    if (!(fine.matches || e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    if (!this.sendTarget.disabled) this.element.requestSubmit(this.sendTarget)
  }
  // Sent: the hub answers with a fresh form; the draft is forgotten.
  // (A refusal comes as 422, so success is false and the words and files stay.)
  sent(e) { if (e.detail.success) { this.forget(); this.revoke() } }
  // A click anywhere in the box goes to the field, as in a text box.
  aim(e) { if (e.target === this.element) this.fieldTarget.focus() }

  // ---- files ----
  setFiles(list) {
    const dt = new DataTransfer()
    for (const f of list.slice(0, MAX_FILES)) dt.items.add(f)
    this.pickerTarget.files = dt.files
    this.paint()
  }
  add(files) { if (files.length) this.setFiles([...this.pickerTarget.files, ...files]) }
  off({ params: { at } }) { this.setFiles([...this.pickerTarget.files].filter((_, n) => n !== at)) }
  paint() {
    this.revoke()
    this.chipsTarget.replaceChildren(...[...this.pickerTarget.files].map((file, at) => {
      const chip = document.createElement('span')
      chip.className = 'composer-file'
      if (file.type.startsWith('image/')) {
        const thumb = document.createElement('img')
        thumb.src = URL.createObjectURL(file)
        thumb.alt = ''
        chip.classList.add('has-thumb')
        chip.append(thumb)
      }
      const name = document.createElement('span')
      name.textContent = file.name
      const off = document.createElement('button')
      off.type = 'button'
      off.className = 'composer-file-off'
      off.textContent = '×'
      off.title = `${file.name}: take it off`
      off.setAttribute('aria-label', off.title)
      off.dataset.action = 'composer#off'
      off.dataset.composerAtParam = String(at)
      chip.append(name, off)
      return chip
    }))
    this.element.toggleAttribute('data-files', this.pickerTarget.files.length > 0)
    this.fit()
  }
  paste(e) {
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
