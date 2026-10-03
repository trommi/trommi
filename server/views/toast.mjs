// The toast: one quiet line at the top right that says what just happened ("Answered: <title>", "Memo sent to
// <name>") and, when it can be taken back, an Undo button. The same on every page and on the phone. It goes by
// itself (about five seconds, a held memo's own hold), stays while the pointer rests on it, and stacks: three at
// most, the newest on top. U presses the newest Undo (t/controllers/keys_controller.js).
//
//   toast({ head, line?, undo?: { action, label?, fields? }, role?, ms? })   the markup (html)
//   in turbo.mjs: t.toast(opts) is the stream action that puts one on the page (prepend into #says-host),
//                 t.says(card, way) the toast of a card's answer
//
// The Undo is a form that posts to the route that takes the action back (a card's /reopen, /wake, /takeback; a
// memo's /unsend; a session's /edit with archived=0), with stay=1 (answer with a stream) and quiet=1 (no new toast
// for taking it back). The behaviour (time, pause, the stack, gone once Undo is pressed) is the controller "says"
// in client/web/t/application.js; the look is the block "toast" in css/turbo.css.
import { html, raw } from './html.mjs'

const UNDO = raw('<svg class="back-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3"/></svg>')
// The time left runs out along a scribbled line (css/back.css .back-line).
const CLOCK = raw('<svg class="back-line" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true"><path d="M0 3 Q12 1 25 3 T50 3 T75 3 T100 3" pathLength="100"/></svg>')
const ACTION = 'pointerenter->says#pause pointerleave->says#run turbo:submit-start->says#leave turbo:submit-end->says#gone'

function undoForm({ action, label = 'Undo', fields = {} }) {
  return html`<form method="post" action="${action}"><input type="hidden" name="stay" value="1"><input type="hidden" name="quiet" value="1">${Object.entries(fields).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}<button class="says-back" type="submit" title="${label} (U)" aria-keyshortcuts="u">${UNDO}${label}<kbd>U</kbd></button></form>`
}

/** One toast. head: what happened, in one or two words; line: of what (a title, a name), may be empty; undo: the route
 *  that takes it back (none: a plain note); role: 'alert' for what went wrong; ms: how long it stays (default 5 s). */
export function toast({ head, line = '', undo = null, role = 'status', ms = null }) {
  return html`<div class="says" data-controller="says" data-action="${ACTION}" role="${role}"${ms ? html` data-says-ms-value="${Math.round(ms)}"` : ''}><span class="says-words"><b>${head}</b>${line ? html`<span>${line}</span>` : ''}</span>${undo ? undoForm(undo) : ''}${CLOCK}</div>`
}
