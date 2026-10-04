// A <details> whose content is put in only when it opens (views/agents.mjs, views/session-edit.mjs): the lists of a
// Agents line (lay together with…, main agent, desk, the phone's sheet) and the grid of forty drawings would make a
// page of many sessions carry thousands of elements nobody opened. They wait in a <template> of this <details>.
import { Controller } from '/js/app/stimulus.mjs'

export default class extends Controller {
  fill() {
    if (!this.element.open) return
    for (const t of this.element.querySelectorAll('template')) if (t.parentElement.closest('details') === this.element) t.replaceWith(t.content)
  }
}
