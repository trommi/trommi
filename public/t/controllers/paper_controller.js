// The Desk is paper: <div id="paper-island" data-controller="paper" data-sessions="…" hidden> on the Desk's page
// (server/views/memo.mjs paperIsland()). The work is /t/lib/paper.js (the pad's frame under the Desk, the two
// switches, zoom), fetched when the element is in the page and laid only when the browser is idle or the human
// first touches the page. A stream that replaces the element (the sessions changed) leaves the paper as it lies.
import { Controller } from '/js/app/stimulus.mjs'

export default class extends Controller {
  async connect() {
    this.paper = await import('/t/lib/paper.js')
    if (this.element.isConnected) this.paper.mount(this.element)
  }
  // Gone with its page: the paper is taken down. Replaced by a newer one: that one has taken over already.
  disconnect() { const node = this.element; setTimeout(() => this.paper?.leave(node)) }
}
