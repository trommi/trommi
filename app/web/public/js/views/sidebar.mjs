// The sidebar (#agents): one row per session, a main with its subs under it, and the floating Desk's state.
// The markup is the one css/app.css and css/crowns.css style (the old client built it in js/agents.js).
import { html, raw } from './html.mjs'
import { knocksText } from './text.mjs'
import { doodleSvg, crownSvg, ringSvg, handSvg, sketchSvg, edgeQuirk } from '../pen.js'

const EDGES = 7   // more subs than this lie in a folded stack without an edge of their own
const questions = n => (n === 1 ? '1 question' : `${n} questions`)

/** A session's mark: its scribble in its colour; with the crown when it is the desk's crowned session (`starred`, one per desk).
 *  working: the session is at work. Its drawing then fills itself in, stroke by stroke, over a faint trace of itself
 *  (crowns.css .is-drawing: a CSS animation of the strokes' dash, nothing runs per frame; still under reduced motion). */
export const avatar = (agent, { crown = true, working = false } = {}) => html`<span class="agent-avatar${agent.online ? '' : ' is-offline'}${working ? ' is-drawing' : ''}" aria-hidden="true" style="--hue:${agent.hue}"${crown && agent.starred ? raw(' data-vip') : ''}>${raw(working ? drawing(doodleSvg(agent.mark)) : doodleSvg(agent.mark))}${crown && agent.starred ? raw(crownSvg()) : ''}</span>`
// The drawing at work: a faint trace, and the same strokes over it that draw themselves (each path measured as 100).
const drawing = svg => svg.replace('class="doodle"', 'class="doodle mark-trace"') + svg.replace('class="doodle"', 'class="doodle mark-live"').replaceAll('<path ', '<path pathLength="100" ')

/** A session's drawing, with the crown when it is the desk's crowned session. */
export const markArt = agent => raw(doodleSvg(agent.mark) + (agent.starred ? crownSvg() : ''))
/** The small mark on a line that names who asked. */
export const smallMark = agent => html`<span class="inbox-from-mark" style="--hue:${agent.hue}">${markArt(agent)}</span>`

// The badge at the end of a row: the ring with the number of open questions; the raised red hand when the session is
// really stopped (blocked: disconnected while working, an error, waiting for permission; being quiet is no stop, blocked.mjs quietOf).
// The hand can stand without any question. That one of its questions knocks (is urgent) is told on the Desk, not here.
// A link into that session. That the session works is told by its drawing (avatar working), not here:
// a session that works and has no open question has no badge.
export function badge(u, shown, base) {
  const { open, online, running, blocked } = shown
  if (!open && !blocked) return ''
  const busy = Boolean(online && running)
  const state = blocked ? `Stopped: ${blocked.text}${open ? `, ${questions(open)} open` : ''}`
    : online ? (running ? `Working, ${questions(open)} open` : `${questions(open)} open`) : `Disconnected, ${questions(open)} open`
  const inner = blocked ? raw(handSvg()) : html`${raw(ringSvg())}<b>${open}</b>`
  const data = html` data-state="${blocked ? 'blocked' : 'open'}"${blocked ? html` data-why="${blocked.why}"` : ''}${!online ? raw(' data-offline') : ''}${busy ? raw(' data-working') : ''}`
  return html`<a class="agent-badge" data-nav href="${base}/s/${encodeURIComponent(u.id)}"${data} title="${u.agent.name}: ${state}" aria-label="${u.agent.name}: ${state}">${inner}</a>`
}

function row(u, base, current) {
  const a = u.agent
  const shut = Boolean(u.subs)   // a main is rendered folded; the island "folds" opens the ones this browser unfolded
  const shown = shut ? u.whole : u
  const names = u.subs?.map(s => s.agent.name) ?? []
  const tip = u.subs ? `Unfold ${a.name}'s ${names.length === 1 ? 'sub' : `${names.length} subs`}: ${names.join(', ')}` : ''
  const lie = u.subs ? (u.subs.length > EDGES ? [...u.subs].sort((x, y) => Boolean(y.blocked) - Boolean(x.blocked)).slice(0, EDGES) : u.subs) : []
  const cls = ['agent-row', u.parent && 'is-sub', (a.main || u.subs) && 'is-main', shown.open || shown.blocked ? 'has-badge' : '', !u.online && 'is-offline', current === u.id && 'is-active'].filter(Boolean).join(' ')
  return html`<div class="${cls}" id="agent-${a.id}" data-folds-target="row" data-unit="${a.id}" data-members="${a.id}"${u.parent ? html` data-parent="${u.parent.id}" hidden` : ''}${u.subs ? html` data-fold="shut" style="--ghue:${a.hue};--n:${lie.length}" data-controller="lean" data-action="pointermove->lean#follow pointerleave->lean#rest"` : ''}>
<a class="agent-entry" data-nav href="${base}/s/${encodeURIComponent(a.id)}" draggable="false" title="${shown.online && shown.running ? `Working${a.task ? `: ${a.task}` : ''}` : a.task ?? ''}"${current === u.id ? raw(' aria-current="page"') : ''}>${avatar(a, { crown: !u.subs, working: Boolean(shown.online && shown.running) })}<span class="agent-text"><strong>${a.name}</strong>${shown.online && shown.running ? html`<span class="sr-only"> (working)</span>` : ''}</span></a>
${u.subs ? html`<button class="crown-fold${a.starred ? '' : ' is-plain'}" type="button" aria-expanded="false" title="${tip}" aria-label="${tip}" data-action="click->folds#toggle" data-folds-id-param="${a.id}">${a.starred ? raw(crownSvg()) : ''}</button>
<svg class="crown-bracket" aria-hidden="true" data-folds-target="bracket"><path/><path class="crown-bracket-hit" data-action="click->folds#toggle" data-folds-id-param="${a.id}"><title>Fold ${a.name}'s subs</title></path></svg>
<span class="crown-edges" title="${tip}" data-action="click->folds#toggle" data-folds-id-param="${a.id}">${lie.map((s, i) => { const q = edgeQuirk(s.id); return html`<i${s.blocked ? raw(' class="is-knock"') : ''} style="--i:${i};--hue:${s.agent.hue};--tilt:${q.tilt}deg;--dx:${q.dx}px">${raw(q.svg)}</i>` })}</span>` : ''}
${badge(u, shown, base)}
</div>`
}

// A small drawn "+" under the connected sessions: invite an agent. The same form the Devices page sends (POST /pair,
// role agent, room.mjs), so it leads to the same invite page with the link for the Claude Code session.
export const PLUS = raw('<svg viewBox="0 0 24 24" class="sketch" aria-hidden="true"><path d="M12.3 5.2C11.9 9.7 12 14.2 12.1 18.9"/><path d="M5.3 12.4C9.8 11.8 14.3 11.9 18.8 12.2"/></svg>')
export const inviteAgentButton = () => html`<form method="post" action="/pair" class="agent-invite"><input type="hidden" name="role" value="agent"><button type="submit" class="agent-invite-go" id="sidebar-invite" title="Invite an agent" aria-label="Invite an agent">${PLUS}</button></form>`

/** The rows of #agents. current: the session in view, if any. */
export function sidebarRows(model, base, current = null) {
  const { here, away } = sidebarParts(model, base, current)
  return html`${here.map(r => r[1])}${inviteAgentButton()}${away.length ? html`<h2 class="caps agent-heading agent-heading-away">Disconnected</h2>${away.map(r => r[1])}` : ''}`
}
/** The same rows one by one, for the live stream: [id, row] of those connected (here) and those that are not (away);
 *  shape says their order, so that a change within one row replaces that row only (turbo.mjs). */
export function sidebarParts(model, base, current = null) {
  const top = model.units.filter(u => !u.parent)
  const rows = u => [[u.id, row(u, base, current)], ...(u.subs ?? []).map(s => [s.id, row(s, base, current)])]
  const live = u => u.online || Boolean(u.subs?.some(s => s.online))
  const here = top.filter(live).flatMap(rows), away = top.filter(u => !live(u)).flatMap(rows)
  return { here, away, shape: `${here.map(r => r[0]).join(' ')}|${away.map(r => r[0]).join(' ')}` }
}

/** What stands in the Desk box beside "Desk" (#desk-state): small and quiet, the count with an arrow, the way into the
 *  walk ("Next"); ringed in the knock's colour when something knocks. A small red hand before it when a session is
 *  stopped (blocked), leading to that session (to Agents when several are). Nothing when nothing waits and nobody is
 *  stopped. (No working ring here: the sidebar's rows show who works.) */
export function deskState(model, base = '') {
  const fresh = model.fresh.length, knocking = model.knocking
  const stopped = model.units.filter(u => u.blocked)
  const hand = stopped.length ? stoppedHand(stopped, base) : ''
  if (!fresh) return hand
  const tip = `Next: walk through the ${fresh === 1 ? 'card' : `${fresh} cards`}${knocking ? ` (${knocksText(knocking)})` : ''}`
  return html`${hand}<a class="desk-next${knocking ? ' is-knock' : ''}" data-nav href="${base}/walk" title="${tip}" aria-label="${tip}"><b class="desk-next-n">${fresh}</b>${raw(sketchSvg('go'))}</a>`
}
function stoppedHand(stopped, base) {
  const tip = `Stopped: ${stopped.map(u => `${u.agent.name} (${u.blocked.text})`).join(', ')}`
  const to = stopped.length === 1 ? `${base}/s/${encodeURIComponent(stopped[0].id)}` : `${base}/agents`
  return html`<a class="desk-blocked" data-nav href="${to}" title="${tip}" aria-label="${tip}">${raw(handSvg())}</a>`
}

// ---- the taped slip (card Nr. 183, t6): its head is the Desk ----
// The desk drawing (with a drawn "←" in front when the page is not the Desk) leads to the Desk; "Next, please" with
// the number of what waits leads into the walk, on the Desk with the walk's arrow. Styles: css/slip.css.
const WALK_ARROW = raw('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12.4C8.6 12 13.2 11.8 19 12.1M14.2 7.2 19.4 12.2 14 17"/></svg>')
const BACK_ARROW = raw('<svg class="slip-back" viewBox="0 0 28 22" aria-hidden="true"><path d="M25 11.6C18 11 11 11.2 4 11.4M10 4.6 3.4 11.4 10.2 18"/></svg>')
/** The number on the slip's head (#slip-n), kept current by the live stream. */
export const slipCount = model => html`<i class="slip-n" id="slip-n"${model.knocking ? raw(' data-knock') : ''}>${model.fresh.length || ''}</i>`
export function slipHead(model, base, view) {
  const desk = view === 'desk'
  return html`<div class="slip" aria-hidden="true"><i class="slip-tape"></i></div>
<div class="slip-head${desk ? '' : ' is-away'}"><a class="slip-desk" data-nav href="${base}/" title="Desk: everything that waits for you" aria-label="${desk ? 'Desk' : 'Back to the Desk'}">${desk ? '' : BACK_ARROW}${raw(sketchSvg('desk'))}</a><a class="slip-next" data-nav href="${base}/walk" title="Next, please: every open question, one after the other (G F)"><span>Next, please</span>${slipCount(model)}${desk ? html`<span class="slip-walk">${WALK_ARROW}</span>` : ''}</a></div>`
}
