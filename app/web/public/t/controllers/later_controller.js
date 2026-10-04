// A <details> whose content is made only when it opens (views/agents.mjs, views/session-edit.mjs LATER): the lists
// of an Agents line (lay together with…, main agent, desk, the phone's sheet) wait in a <template>; the grid of
// forty drawings is made here from views/session-edit.mjs marksFrame. A page of many sessions would otherwise carry
// thousands of elements nobody opened.
import { Controller } from '/js/app/stimulus.mjs'

const mine = (el, root) => el.parentElement.closest('details') === root
export default class extends Controller {
  async fill() {
    if (!this.element.open) return
    for (const t of this.element.querySelectorAll('template')) if (mine(t, this.element)) t.replaceWith(t.content)
    const places = [...this.element.querySelectorAll('.marks-later')].filter(p => mine(p, this.element))
    if (!places.length) return
    const { marksFrame } = await import('/js/views/session-edit.mjs')
    for (const p of places) {
      const { agent, base, opts } = JSON.parse(p.dataset.marks)
      p.outerHTML = String(marksFrame(agent, base, opts))
    }
  }
}
