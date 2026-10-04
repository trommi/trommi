// The frame around every view: the floating Desk with the Trommi menu, the sidebar, the place for toasts, the key
// sheet, the memos. A port of trommi-hub server/views/layout.mjs: the same markup, without the hub's <head>, the
// import map and the live stream (the router keeps the head and patches the body).
import { html, raw } from '../views/html.mjs'
import { sidebarRows, deskState } from '../views/sidebar.mjs'
import { sketchSvg } from '../pen.js'
import { menuDoors } from '../views/menu.mjs'
import { pageSheets } from '../views/keys.mjs'
import { memoLayer } from '../views/memo.mjs'

export const BELL = raw(`<svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.1 19Q12.3 18.6 16.7 19L21 19.3"/><path d="M4.8 18.9Q5.2 15.1 5.7 13.7Q6.2 12.3 7.5 11.3Q8.7 10.3 10.3 9.5Q12 8.8 13.7 9.3Q15.3 9.8 16.4 11Q17.5 12.2 18.1 13.7Q18.6 15.2 18.8 17L18.9 18.8"/><path d="M11.8 8.6L12.2 6.9"/><path d="M10 6.6Q11.8 6 12.8 6.4L13.8 6.8"/><path class="brand-mark-ring" d="M18.5 7.3Q19.5 5.8 19.8 5.2L20 4.5"/><path class="brand-mark-ring" d="M20.6 10.3Q21.5 9.4 22.3 8.9L23.1 8.5"/></svg>`)
const RAIL_FOLD = raw(`<button type="button" class="rail-fold" data-controller="rail" data-action="click->rail#toggle pointerover@document->rail#tip focusin@document->rail#tip focusout@document->rail#untip turbo:before-cache@document->rail#untip" title="Fold the sidebar to a rail ( [ )" aria-label="Fold the sidebar to a rail ( [ )" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.3 4.4Q4.8 11.6 5.4 19.7"/><path d="M15.1 6.1Q12.2 9.2 9.1 12.1Q12.1 14.7 14.8 18"/></svg></button>`)

// Stylesheets per view (the hub's CSS table); all are in the shell's <head>, the router enables the view's set.
export const CSS = {
  base: ['tokens', 'app', 'crowns', 'back', 'cardclip', 'phone-desk', 'piles', 'stamps', 'logo', 'links', 'quicksend', 'keys'],
  agents: ['tokens', 'app', 'crowns', 'back', 'cardclip', 'phone-desk', 'piles', 'logo', 'links', 'quicksend', 'keys', 'ledger'],
  session: ['tokens', 'app', 'crowns', 'back', 'beside', 'cardclip', 'phone-desk', 'piles', 'logo', 'links', 'quicksend', 'keys', 'richhtml', 'session', 'speech'],
  card: ['tokens', 'app', 'crowns', 'back', 'cardclip', 'phone-desk', 'piles', 'stamps', 'logo', 'links', 'quicksend', 'keys', 'richhtml', 'cardpage', 'speech'],
  picture: ['tokens', 'app', 'back', 'logo', 'links', 'cardpage'],
  asset: ['tokens', 'app', 'back', 'logo', 'links', 'cardpage', 'asset'],   // a published page or picture, in the app's viewer
  room: ['tokens', 'app', 'crowns', 'back', 'cardclip', 'phone-desk', 'piles', 'logo', 'links', 'quicksend', 'keys'],   // devices, pairing, settings: the sidebar stands beside them
}

function topbar(model, base, current, view = '') {
  const sk = name => raw(sketchSvg(name))
  return html`<header class="topbar"><div class="brand">
<h1 class="deskpill"><a href="${base}/" data-nav draggable="false" class="desk-go" id="desk-go" title="Desk: everything that waits for you"${current ? raw(' aria-current=""') : ''}>${sk('desk')}${BELL}<span class="desk-name" title="Desk">${model.deskName}</span></a><span class="desk-state" id="desk-state">${deskState(model, base)}</span>
<button type="button" class="brand-open" id="brand-menu" aria-haspopup="menu" aria-expanded="false" aria-controls="brand-doors" aria-label="Menu: jump, desks, places, settings">${raw(String(BELL).replace('class="brand-mark"', 'class="brand-mark pill-mark"'))}<b class="pill-word">Trommi</b><span class="conn pill-conn" id="conn" data-state="connecting" role="status"><i aria-hidden="true"></i><span id="conn-text" class="tc-sr">Connecting</span></span><span class="brand-fold">${sk('unfold')}</span></button></h1>
${menuDoors(model, base)}
</div>
<a href="${base}/agents" data-nav draggable="false" class="icon-btn roster-open" id="roster-open" aria-label="Agents" title="Agents"${view === 'agents' ? raw(' aria-current="page"') : ''}>${sk('heads')}</a></header>`
}

/** The body's parts for a page: [{ key, html }] in order (the router keeps a part whose markup did not change). */
export function bodyParts({ view, model, base = '', main, sidebar = true, current = null, says = '', stream = '' }) {
  const parts = []
  if (sidebar) {
    parts.push({ key: 'topbar', html: String(topbar(model, base, view === 'desk', view)) })
    parts.push({ key: 'agents', html: String(html`<nav id="agents" aria-label="Sessions" data-controller="folds">${sidebarRows(model, base, current)}</nav>`) })
    parts.push({ key: 'rail', html: String(RAIL_FOLD) })
  }
  parts.push({ key: 'main', html: String(main) })
  parts.push({ key: 'says', html: `<div class="says-host says-page" id="says-host" data-turbo-permanent>${says}</div>` })
  parts.push({ key: 'sheets', html: String(pageSheets(view, base, { sidebar })) })
  if (stream !== null && model) parts.push({ key: 'memos', html: String(memoLayer(model, base, view, view === 'session' ? current : null)) })
  return parts
}
