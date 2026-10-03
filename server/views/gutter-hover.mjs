// Proposal (3 October, not decided yet): the session's name beside a Desk card shows only while the pointer is on
// the card, with a small hand-drawn arrow from the name to the card. Off by default: the live board keeps the name
// written under the drawing until Christopher picks. TROMMI_NAME_ON_HOVER=1 turns it on (for screenshots).
// A phone has no hover and no column of drawings: it is unchanged there (the card's first line names the session).
// css/turbo.css styles it (.inbox-gutter.is-hover-name, .inbox-gutter-arrow).
import { raw } from './html.mjs'
import { arrowStrokes } from '../../client/web/js/pen.js'

export const NAME_ON_HOVER = process.env.TROMMI_NAME_ON_HOVER === '1'

/** The class the gutter link gets: '' while the switch is off. */
export const gutterHoverClass = () => (NAME_ON_HOVER ? ' is-hover-name' : '')

/** The arrow from the name to the card (drawn with the session's seed, so it looks the same each time); '' while off. */
export function gutterArrow(from) {
  if (!NAME_ON_HOVER) return ''
  const strokes = arrowStrokes([[2, 8], [12, 22], [26, 24], [40, 14]], from.id)
  return raw(`<svg class="inbox-gutter-arrow" viewBox="0 0 44 32" aria-hidden="true">${strokes.map(d => `<path d="${d}"/>`).join('')}</svg>`)
}
