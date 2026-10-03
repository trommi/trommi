// Read a card aloud: the hub speaks it (GET /speech/card/<id>, when a speech service is set up); a second press stops.
import { Controller } from '@hotwired/stimulus'

export default class extends Controller {
  static values = { url: String }
  toggle(event) {
    event.preventDefault()
    if (this.audio && !this.audio.paused) return this.stop()
    this.audio = new Audio(this.urlValue)
    this.element.setAttribute('aria-pressed', 'true')
    this.audio.addEventListener('ended', () => this.stop())
    this.audio.play().catch(() => this.stop())
  }
  stop() { this.audio?.pause(); this.element.setAttribute('aria-pressed', 'false') }
  disconnect() { this.stop() }
}
