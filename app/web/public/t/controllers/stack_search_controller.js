// The search field over a fanned stack at the foot of the Desk (server/views/stacks.mjs). Typing sends the form a
// moment later: a GET into the stack's Turbo Frame, which the hub answers with the sheets that have the words.
// Escape empties it. The live stream replaces the stacks when a card moves: the words, the keyboard and the caret are
// put back into the new field and the search is sent again, so typing is never lost.
import { Controller } from '/js/app/stimulus.mjs'

let kept = null   // { kind, q, focus, caret }: the search as it stood when its field left the page

export default class extends Controller {
  static targets = ['field']
  static values = { kind: String }

  connect() {
    const was = kept
    if (!was || was.kind !== this.kindValue || !was.q || this.fieldTarget.value) return
    this.fieldTarget.value = was.q
    if (was.focus) { this.fieldTarget.focus({ preventScroll: true }); try { this.fieldTarget.setSelectionRange(was.caret, was.caret) } catch {} }
    this.send()
  }
  disconnect() {
    clearTimeout(this.timer)
    const field = this.hasFieldTarget ? this.fieldTarget : null
    if (field?.value) kept = { kind: this.kindValue, q: field.value, focus: document.activeElement === field, caret: field.selectionStart ?? field.value.length }
  }
  typed() {
    kept = this.fieldTarget.value ? { kind: this.kindValue, q: this.fieldTarget.value, focus: true, caret: this.fieldTarget.selectionStart } : null
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.send(), 220)
  }
  clear(event) {
    if (!this.fieldTarget.value) return   // (an empty field leaves Escape to the stack: it gathers)
    event.preventDefault()
    event.stopPropagation()
    this.fieldTarget.value = ''
    kept = null
    this.send()
  }
  send() { if (this.element.isConnected) this.element.requestSubmit() }
}
