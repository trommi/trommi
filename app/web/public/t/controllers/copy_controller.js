// A button that copies: the text of its "source" target (a code block), or its text value (a link; one that begins
// with "/" is made whole with this page's address). The "label" target says for a moment whether it worked.
import { Controller } from '/js/app/stimulus.mjs'

/** Copies text; true when it worked. (The Clipboard API needs a secure context; the board is often open over plain http.) */
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true } catch {}
  const area = document.createElement('textarea')
  area.value = text
  area.readOnly = true
  area.className = 'offscreen'
  document.body.append(area)
  area.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch {}
  area.remove()
  return ok
}

export default class extends Controller {
  static targets = ['source', 'label']
  static values = { text: String, word: { type: String, default: 'Copy' } }
  disconnect() { clearTimeout(this.timer) }
  async copy() {
    const text = this.hasTextValue && this.textValue ? (this.textValue.startsWith('/') ? new URL(this.textValue, location.href).href : this.textValue) : this.sourceTarget.textContent
    const ok = await copyText(text)
    if (!this.hasLabelTarget) return
    this.labelTarget.textContent = ok ? 'Copied' : 'Not copied'
    this.element.classList.toggle('is-done', ok)
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.labelTarget.textContent = this.wordValue; this.element.classList.remove('is-done') }, 1800)
  }
}
