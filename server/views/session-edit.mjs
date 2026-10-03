// What the human changes on a session, as small forms that stand right where they are used (docs/turbo.md):
// rename (a form under the name: Enter saves, Escape closes), the drawing (a grid under the mark, fetched when
// it is first opened). No veil, no dialog: each is a <details> whose content lies over the page; the controller
// "pops" (client/web/t/controllers/pops_controller.js) closes it on Escape or a click beside it and puts the keyboard in the field.
// The forms post to <base>/sessions/<id>/edit (views/agents.mjs), which hands them to the hub's own rules.
//
// Used by the Agents page (views/agents.mjs) and, through sessionHeadEdit(), by a session's heading.
import { html, raw } from './html.mjs'
import { avatar } from './sidebar.mjs'
import { doodleSvg, DRAWINGS, drawingMark, drawingHue, crownSvg } from '../../client/web/js/pen.js'

/** The address of a session's forms. */
export const sessionForms = (agent, base) => `${base}/sessions/${encodeURIComponent(agent.id)}`

/** How a form is answered. stay: the page stays as it is (the live stream brings the change);
 *  back: the page to show afterwards (a path under base), where there is no live piece for the change. */
export const answerFields = ({ stay = false, back = '' } = {}) => html`${stay ? raw('<input type="hidden" name="stay" value="1">') : ''}${back ? html`<input type="hidden" name="back" value="${back}">` : ''}`

/** The name as the control that renames. label: what stands in the control (default: the name, strong). */
export function renameControl(agent, base, { stay = false, back = '', cls = 'ledger-rename', label = null } = {}) {
  const field = `session-name-${agent.id}`
  return html`<details class="t-pick t-pick-name"><summary class="${cls}" data-ledger="rename" title="Rename" aria-label="${agent.name}: rename">${label ?? html`<strong>${agent.name}</strong>`}</summary>
<div class="session-editor t-pop"><form method="post" action="${sessionForms(agent, base)}/edit" data-turbo-frame="_top">${answerFields({ stay, back })}<label class="caps" for="${field}">Rename the session</label><input type="text" id="${field}" name="label" value="${agent.name}" maxlength="60" autocomplete="off" enterkeyhint="done" aria-label="Name of the session"><div class="session-buttons"><button type="button" data-pop-close>Cancel</button><button type="submit" class="is-lead">Save</button></div></form></div></details>`
}

const framed = (agent, where) => `marks-${where ? `${where}-` : ''}${agent.id}`
const marksQuery = ({ stay, back, where }) => new URLSearchParams({ ...(stay ? { stay: '1' } : {}), ...(back ? { back } : {}), ...(where ? { in: where } : {}) }).toString()

/** The grid of drawings, as the frame that the picker fetches when it is opened. */
export function marksFrame(agent, base, { stay = false, back = '', where = '' } = {}) {
  return html`<turbo-frame id="${framed(agent, where)}"><form method="post" action="${sessionForms(agent, base)}/edit" data-turbo-frame="_top">${answerFields({ stay, back })}<div class="mark-grid" role="radiogroup" aria-label="Drawing">${DRAWINGS.map(name => html`<button class="mark-tile" type="submit" name="icon" value="${drawingMark(name)}" role="radio" aria-checked="${String(agent.mark === drawingMark(name))}" aria-label="${name}" title="${name}" style="--hue:${drawingHue(name)}">${raw(doodleSvg(drawingMark(name)))}</button>`)}</div></form></turbo-frame>`
}

/** The place the grid of drawings loads into (lazily: when it comes into view, that is when its <details> opens). */
export const marksHolder = (agent, base, opts = {}) => {
  const query = marksQuery(opts)
  return html`<turbo-frame id="${framed(agent, opts.where)}" src="${sessionForms(agent, base)}/marks${query ? `?${query}` : ''}" loading="lazy"><p class="t-pop-wait">Drawings…</p></turbo-frame>`
}

/** The mark as the control that opens the drawings. (Without a crown: where the crown is shown, it is a control of its own.) */
export function markControl(agent, base, { stay = false, back = '', cls = 'ledger-mark' } = {}) {
  return html`<details class="t-pick t-pick-mark"><summary class="${cls}" data-ledger="mark" title="Choose a drawing" aria-label="${agent.name}: choose a drawing">${avatar(agent, { crown: false })}</summary>
<div class="mark-picker t-pop">${marksHolder(agent, base, { stay, back })}</div></details>`
}

/**
 * For a session's heading: its mark (opens the drawings) and its name (renames), side by side.
 * back: the path of the page that shows the heading; the form answers with a redirect to it.
 * Pass stay: true instead where the heading is kept current by the page's own live stream.
 */
export const sessionHeadEdit = (agent, base, { back = '', stay = false } = {}) => html`<span class="t-session-edit" data-controller="pops">${markControl(agent, base, { stay, back, cls: 't-head-mark' })}${crownControl(agent, base, { stay, back })}${renameControl(agent, base, { stay, back, cls: 't-head-name' })}</span>`

/** The crown as a switch on the corner of the mark: one per desk, given by his hand (the hub takes it from whoever wore it). */
export const crownControl = (agent, base, { stay = false, back = '' } = {}) => html`<form class="t-crown-form" method="post" action="${sessionForms(agent, base)}/star">${answerFields({ stay, back })}<button class="crown-toggle" type="submit" name="starred" value="${agent.starred ? '0' : '1'}" aria-pressed="${String(Boolean(agent.starred))}" title="${agent.starred ? 'Wears the crown of its desk. Click to take it off' : 'Give the crown'}" aria-label="${agent.name}: ${agent.starred ? 'wears the crown of its desk, take it off' : 'give the crown'}">${raw(crownSvg())}</button></form>`
