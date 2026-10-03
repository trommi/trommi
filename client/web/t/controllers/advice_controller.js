// The agent's advice: a highlighter swipe drawn by hand behind the words of the option it would pick (the old client's
// adviceLoop in js/ui.js, which measures the words and redraws when its host changes size). On a tile, a card option.
import { Controller } from '@hotwired/stimulus'

export default class extends Controller {
  async connect() {
    const { adviceLoop } = await import('/js/ui.js')
    if (!this.element.isConnected || this.element.querySelector(':scope > .advice-loop')) return
    this.element.append(adviceLoop())
  }
  disconnect() { this.element.querySelector(':scope > .advice-loop')?.remove() }
}
