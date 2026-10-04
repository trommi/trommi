// Copy a card as one line ("Nr. 12 · title → answer") to paste into another agent. It is also kept for this
// tab under the old client's key, so a composer can offer it as a chip.
import { Controller } from '/js/app/stimulus.mjs'

const KEY = 'trommi-cardclip'
export default class extends Controller {
  static values = { text: String, card: Object }
  async copy(event) {
    event.preventDefault()
    event.stopPropagation()
    try { sessionStorage.setItem(KEY, JSON.stringify({ ...this.cardValue, text: this.textValue })) } catch {}
    try { await navigator.clipboard.writeText(this.textValue) } catch {}
    this.element.classList.add('is-done')
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.element.classList.remove('is-done'), 1400)
  }
  disconnect() { clearTimeout(this.timer) }
}
