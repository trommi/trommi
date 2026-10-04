// A choice on the Agents page that is filled in only when it opens (views/agents.mjs later()): the lists of a line
// (lay together with…, main agent, desk, the phone's sheet) name every other session, so a page of many sessions
// would carry thousands of buttons nobody opened. They wait in a <template> until their <details> opens.
import { Controller } from '/js/app/stimulus.mjs'

export default class extends Controller {
  fill() {
    for (const t of this.element.querySelectorAll(':scope > template, :scope > form > template')) t.replaceWith(t.content)
  }
}
