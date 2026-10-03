// "Next" above the Desk: one small plain sentence, "Next 3 →", that leads into the walk through every open question.
// (It was an index-card divider tab with the next cards peeking behind it, card Nr. 166; Christopher asked on
// 3 October for a plain line of text instead: no tab, no card shape.) css/turbo.css styles it (.inbox-next).
import { html, raw } from './html.mjs'
import { WORDS } from './text.mjs'
import { sketchSvg } from '../../client/web/js/pen.js'

/** The line for n > 0 open cards (model.fresh, in the hub's order): a link to the walk. */
export function nextPlease(model, base) {
  const n = model.fresh.length
  return html`<p class="inbox-heading inbox-next"><a class="inbox-walk inbox-go" data-nav href="${base}/walk" title="${WORDS.walk}: every open question, one after the other (G F)" aria-label="${WORDS.walk}: ${n === 1 ? '1 open question' : `${n} open questions`}" aria-keyshortcuts="G F"><span>${WORDS.walk}</span><b class="inbox-next-n">${n}</b>${raw(sketchSvg('go'))}</a></p>`
}
