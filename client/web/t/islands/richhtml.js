// A layout the agent sent along (a block fenced as html): shown in the sandboxed frame of js/richhtml.js,
// never as markup of this page. The hub put the source into data-source, escaped.
import { htmlBlock } from '/js/richhtml.js'

export function mount(node) {
  node.replaceChildren(htmlBlock(node.dataset.source ?? ''))
}
