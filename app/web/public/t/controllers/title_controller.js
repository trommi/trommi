// The count in the browser's tab title, "(8) Desk · Trommi": it follows the live stream. An element the stream
// replaces when the count changes carries it (<header id="desk-head" data-controller="title" data-title-count-value="8">);
// the new element connects and writes the title.
import { Controller } from '/js/app/stimulus.mjs'

export default class extends Controller {
  static values = { count: Number }

  countValueChanged() {
    const rest = document.title.replace(/^\(\d+\)\s*/, '')
    document.title = this.countValue > 0 ? `(${this.countValue}) ${rest}` : rest
  }
}
