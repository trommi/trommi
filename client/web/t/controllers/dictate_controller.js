// The microphone beside a text field (server/views/text.mjs micButton): a press starts live dictation into the field
// named by its value, a second press (or Escape) stops it. The words come from the hub's speech service.
import { Controller } from '@hotwired/stimulus'
import { toggleDictation, paintButton, dictatingInto, stopDictation } from '/t/lib/dictate.js'

export default class extends Controller {
  static values = { field: String }
  connect() { paintButton(this.element, null) }
  disconnect() { if (dictatingInto() && !dictatingInto().isConnected) stopDictation() }
  // Keeps a phone's keyboard closed and the caret where it is.
  keep(event) { event.preventDefault() }
  toggle(event) {
    event.preventDefault()
    const field = document.getElementById(this.fieldValue)
    if (!field) return
    toggleDictation(field, this.element, text => this.say(text))
  }
  say(text) {
    const note = document.createElement('p')
    note.className = 'dictate-error'
    note.setAttribute('role', 'alert')
    note.textContent = text
    this.element.closest('form')?.prepend(note)
    setTimeout(() => note.remove(), 6000)
  }
}
