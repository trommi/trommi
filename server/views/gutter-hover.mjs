// Decided on card Nr. 208 ("Pfeil aus der Sidebar"): who asks is shown by a hand-drawn arrow from the session's row in the
// left sidebar to the Desk card under the pointer, and from a session row under the pointer to its cards (controller
// "pointto"). With it, the session's name under its drawing beside the card goes; the drawing stays. On by default;
// TROMMI_NAME_ON_HOVER=0 turns it off (the name stands under the drawing again, no arrows).
// A phone has no hover and no sidebar beside the cards: it is unchanged there (the card's first line names the session).
// css/turbo.css styles it (.inbox-gutter.is-sidebar-arrow, .pointto-layer).
import { raw } from './html.mjs'

export const NAME_ON_HOVER = process.env.TROMMI_NAME_ON_HOVER !== '0'

/** The class the gutter link gets: '' when switched off. */
export const gutterHoverClass = () => (NAME_ON_HOVER ? ' is-sidebar-arrow' : '')

/** The hidden element in the Desk's <main> that carries the controller; '' while off. */
export const pointerHost = () => (NAME_ON_HOVER ? raw('<div hidden data-controller="pointto" data-action="pointerover@document->pointto#over pointerout@document->pointto#out resize@window->pointto#redraw turbo:before-cache@document->pointto#clear turbo:before-stream-render@document->pointto#later"></div>') : '')
