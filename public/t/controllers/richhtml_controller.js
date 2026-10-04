// A layout the agent sent along (a block fenced as html): shown in the sandboxed frame of js/richhtml.js,
// never as markup of this page. The hub put the source into the value, escaped.
import { Controller } from '/js/app/stimulus.mjs'

export default class extends Controller {
  static values = { source: String }
  async connect() {
    const { htmlBlock } = await import('/js/richhtml.js')   // the heavy part, fetched when the first layout shows
    if (this.element.isConnected) this.element.replaceChildren(htmlBlock(this.sourceValue))
  }
}
