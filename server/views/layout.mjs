// The page around every view of the server-rendered board: head, styles, the floating Desk with the Trommi
// menu, the sidebar, the place for the passing note, the live stream. See docs/turbo.md.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { html, raw } from './html.mjs'
import { sidebarRows, deskState } from './sidebar.mjs'   // (slipHead, the taped slip of card Nr. 183, is taken back: he found it too much)
import { sketchSvg } from '../../client/web/js/pen.js'
import { menuDoors } from './menu.mjs'   // the Trommi menu (worker D)
import { pageSheets } from './keys.mjs'      // the key sheet, the long-press sheet (worker D)
import { memoLayer } from './memo.mjs'   // the memo button, the notes, the Desk's paper (worker C)

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'web')
const has = file => { try { return fs.statSync(path.join(WEB, file)).isFile() } catch { return false } }

// The stylesheets a view needs, in the order the old page loads them (later ones win). turbo.css is last:
// the few rules for what is new here (a tile that is a link, the picture page).
const CSS = {
  base: ['tokens', 'app', 'crowns', 'back', 'cardclip', 'phone-desk', 'piles', 'stamps', 'logo', 'links', 'quicksend', 'keys'],
  agents: ['tokens', 'app', 'crowns', 'back', 'cardclip', 'phone-desk', 'piles', 'logo', 'links', 'quicksend', 'keys', 'ledger'],
  session: ['tokens', 'app', 'crowns', 'back', 'beside', 'cardclip', 'phone-desk', 'piles', 'logo', 'links', 'quicksend', 'keys', 'richhtml', 'session', 'speech'],   // a session's page (views/session.mjs)
  card: ['tokens', 'app', 'crowns', 'back', 'cardclip', 'phone-desk', 'piles', 'stamps', 'logo', 'links', 'quicksend', 'keys', 'richhtml', 'cardpage', 'speech'],   // a card's page (views/card.mjs) in the frame, with its own sheet
  picture: ['tokens', 'app', 'back', 'logo', 'links', 'cardpage'],
}
const ICON = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cstyle%3Epath%7Bfill:none;stroke:%23fff;stroke-width:3;stroke-linecap:round;stroke-linejoin:round%7D.f%7Bdisplay:none%7D@media (min-width:24px)%7Bpath%7Bstroke-width:2.1%7D.f%7Bdisplay:inline%7D%7D%3C/style%3E%3Crect width='24' height='24' rx='6.75' fill='%231b6a57'/%3E%3Cg transform='translate(12 12.4) scale(.8) translate(-13 -12.2)'%3E%3Cpath d='M3.1 19Q12.3 18.6 16.7 19L21 19.3'/%3E%3Cpath d='M4.8 18.9Q5.2 15.1 5.7 13.7Q6.2 12.3 7.5 11.3Q8.7 10.3 10.3 9.5Q12 8.8 13.7 9.3Q15.3 9.8 16.4 11Q17.5 12.2 18.1 13.7Q18.6 15.2 18.8 17L18.9 18.8'/%3E%3Cpath class='f' d='M11.8 8.6L12.2 6.9'/%3E%3Cpath d='M10 6.6Q11.8 6 12.8 6.4L13.8 6.8'/%3E%3Cpath d='M18.5 7.3Q19.5 5.8 19.8 5.2L20 4.5'/%3E%3Cpath d='M20.6 10.3Q21.5 9.4 22.3 8.9L23.1 8.5'/%3E%3C/g%3E%3C/svg%3E`
const BELL = raw(`<svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.1 19Q12.3 18.6 16.7 19L21 19.3"/><path d="M4.8 18.9Q5.2 15.1 5.7 13.7Q6.2 12.3 7.5 11.3Q8.7 10.3 10.3 9.5Q12 8.8 13.7 9.3Q15.3 9.8 16.4 11Q17.5 12.2 18.1 13.7Q18.6 15.2 18.8 17L18.9 18.8"/><path d="M11.8 8.6L12.2 6.9"/><path d="M10 6.6Q11.8 6 12.8 6.4L13.8 6.8"/><path class="brand-mark-ring" d="M18.5 7.3Q19.5 5.8 19.8 5.2L20 4.5"/><path class="brand-mark-ring" d="M20.6 10.3Q21.5 9.4 22.3 8.9L23.1 8.5"/></svg>`)
// Hotwire without a build step: the two vendored files by their package names, for every module of the page.
const IMPORTS = raw('<script type="importmap">{"imports":{"@hotwired/turbo":"/vendor/turbo.es2017-esm.js","@hotwired/stimulus":"/vendor/stimulus.js"}}</script>')
// Before first paint: the theme this browser chose, and which mains it left unfolded in the sidebar.
const THEME = raw(`<script>(function(){var t='light';try{if(localStorage.getItem('agent-board-theme')==='dark')t='dark'}catch(e){}if(t==='dark')document.documentElement.dataset.theme='dark'})()</script>`)
// The rail (card Nr. 150): the sidebar folded to the sessions' drawings, remembered per browser; set before first paint, no flash.
const RAIL = raw(`<script>try{if(localStorage.getItem('trommi-rail')==='folded')document.documentElement.dataset.rail='folded'}catch(e){}</script>`)
// The small drawn "|<" at the sidebar's foot that folds it to the rail and opens it again (controller "rail"; key [ ).
const RAIL_FOLD = raw(`<button type="button" class="rail-fold" data-controller="rail" data-action="click->rail#toggle pointerover@document->rail#tip focusin@document->rail#tip focusout@document->rail#untip turbo:before-cache@document->rail#untip" title="Fold the sidebar to a rail ( [ )" aria-label="Fold the sidebar to a rail ( [ )" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.3 4.4Q4.8 11.6 5.4 19.7"/><path d="M15.1 6.1Q12.2 9.2 9.1 12.1Q12.1 14.7 14.8 18"/></svg></button>`)
const FOLDS = raw(`<script>(function(){try{var l=JSON.parse(localStorage.getItem('trommi-crowns-open')||'[]');for(var i=0;i<l.length;i++){var m=document.getElementById('agent-'+l[i]);if(!m||!m.hasAttribute('data-fold'))continue;m.setAttribute('data-fold','open');var e=m.querySelector('.crown-edges');if(e)e.hidden=true;var s=document.querySelectorAll('.agent-row[data-parent="'+l[i]+'"]');for(var j=0;j<s.length;j++)s[j].hidden=false}}catch(e){}})()</script>`)

/** The floating Desk and its menu. current: the Desk itself is in view. */
function topbar(model, base, current, view = '') {   // (the Agents button: on a phone, css/app.css .roster-open)
  const sk = name => raw(sketchSvg(name))
  return html`<header class="topbar"><div class="brand">
<h1 class="deskpill"><a href="${base}/" data-nav draggable="false" class="desk-go" id="desk-go" title="Desk: everything that waits for you"${current ? raw(' aria-current=""') : ''}>${sk('desk')}${BELL}<span class="desk-name" title="Desk">${model.deskName}</span></a><span class="desk-state" id="desk-state">${deskState(model, base)}</span>
<button type="button" class="brand-open" id="brand-menu" aria-haspopup="menu" aria-expanded="false" aria-controls="brand-doors" aria-label="Menu: jump, desks, places, settings">${raw(String(BELL).replace('class="brand-mark"', 'class="brand-mark pill-mark"'))}<b class="pill-word">Trommi</b><span class="conn pill-conn" id="conn" data-state="connecting" role="status"><i aria-hidden="true"></i><span id="conn-text" class="tc-sr">Connecting</span></span><span class="brand-fold">${sk('unfold')}</span></button></h1>
${menuDoors(model, base)}
</div>
<a href="${base}/agents" data-nav draggable="false" class="icon-btn roster-open" id="roster-open" aria-label="Agents" title="Agents"${view === 'agents' ? raw(' aria-current="page"') : ''}>${sk('heads')}</a></header>`
}

/**
 * A whole page. view: 'desk' | 'card' | 'picture' | … (the island loader and the stream read it).
 * main: the view's markup. sidebar: false leaves out the bar and the sidebar (a card is a page of its own).
 * stream: more for the query of this page's live stream ('&card=<id>'); null for a page without one.
 * says: a passing note to show at once. css: which set of stylesheets ('base' | 'card' | a name added to CSS above).
 * ported: the pattern of the paths rendered here (turbo.mjs fills it in; t/boot.js reads it).
 */
export function page({ title, view, model, base, main, rev, ported = '', sidebar = true, current = null, css = 'base', stream = '', says = '', bodyAttrs = '', scope = 'all' }) {
  const sheets = CSS[css] ?? CSS.base
  return `<!doctype html>
${html`<html lang="en" data-loaded data-ui="turbo">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="theme-color" content="#ffffff">
<meta name="turbo-refresh-method" content="morph">
<meta name="turbo-refresh-scroll" content="preserve">
<meta name="turbo-cache-control" content="no-cache">
<meta name="view-transition" content="same-origin">
<meta name="t-pages" content="${ported}">
<title>${title}</title>
<link rel="icon" type="image/svg+xml" href="${ICON}">
${has('manifest.webmanifest') ? raw('<link rel="manifest" href="/manifest.webmanifest">') : ''}
${THEME}
${RAIL}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" media="print" onload="this.media='all'" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700;12..96,800&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
${sheets.map(name => html`<link rel="stylesheet" href="/css/${name}.css">`)}
<link rel="stylesheet" href="/css/turbo.css">
${IMPORTS}
<link rel="modulepreload" href="/vendor/turbo.es2017-esm.js">
<link rel="modulepreload" href="/vendor/stimulus.js">
<script type="module" src="/t/application.js"></script>
${has('js/push.js') ? raw('<script type="module" src="/js/push.js"></script>') : ''}
</head>
<body data-view="chat" data-scope="${scope}" data-t-view="${view}" data-t-base="${base}"${raw(bodyAttrs)}>
${sidebar ? html`${topbar(model, base, view === 'desk', view)}
<nav id="agents" aria-label="Sessions" data-controller="folds">${sidebarRows(model, base, current)}</nav>${FOLDS}${RAIL_FOLD}` : ''}
${main}
<div class="says-host says-page" id="says-host" data-turbo-permanent>${says}</div>
${pageSheets(view, base, { sidebar })}
${stream !== null && model ? memoLayer(model, base, view, view === 'session' ? current : null) : ''}
${stream !== null ? html`<turbo-stream-source id="live" src="${base}/stream?rev=${rev}&view=${view}${sidebar ? raw('&bar=1') : ''}${stream}"></turbo-stream-source>` : ''}
</body>
</html>`}
`
}
