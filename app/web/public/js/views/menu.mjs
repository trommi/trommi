// The Trommi menu (what opens from the floating pill at the top centre), the jump page's results (/jump; the menu
// itself has no search field for now), and the sheet a long press on a Desk row brings up on a phone. The menu's markup is the old client's (index.html,
// js/bar.js), so css/app.css and css/clipboard.css style it; the controller t/controllers/menu_controller.js adds the
// arrows and a new desk, sheet_controller.js the long press. Opening and closing the
// menu and the theme: t/application.js.
import { html, raw } from './html.mjs'
import { WORDS, cardNr } from './text.mjs'
import { cardPath } from './desk.mjs'
import { sketchSvg } from '../pen.js'

const sk = name => raw(sketchSvg(name))
const JUMP_MAX = 8
const DEFAULT_DESK = 'main'

/** The desks with what waits on each: [{ id, name, open, knocks }]. */
function desksOf(model) {
  const desks = model.state.desks?.length ? model.state.desks : [{ id: DEFAULT_DESK, name: 'Desk' }]
  const deskOf = card => { const d = model.byAgent.get(card.agent)?.desk; return desks.some(x => x.id === d) ? d : desks[0].id }
  return desks.map(d => { const mine = (model.allFresh ?? model.fresh).filter(c => deskOf(c) === d.id); return { id: d.id, name: d.name || 'Desk', open: mine.length, knocks: mine.some(c => ['high', 'critical'].includes(c.urgency)) } })
}

// Small drawings of the menu's own, in the pen's line: Log out, the plus of "New desk", and the light of the desk lamp.
// Log out: a door frame, open to the right, and an arrow walking out of it.
const LEAVE = raw('<svg viewBox="0 0 24 24" class="sketch" aria-hidden="true" style="rotate:-1deg"><path d="M10.2 4.3Q7.4 4.1 5.2 4.4Q4.9 12.1 5.2 19.7Q7.7 19.9 10.1 19.8"/><path d="M9.4 12.2Q14.5 11.8 19.5 12.1"/><path d="M16.3 8.7Q18.2 10.4 19.6 12.1Q18 13.8 16.2 15.3"/></svg>')
const PLUS = raw('<svg viewBox="0 0 24 24" class="sketch" aria-hidden="true" style="rotate:3deg"><path d="M12.2 5.2Q11.8 12 12 18.8"/><path d="M5.3 12.3Q12 11.7 18.7 12.1"/></svg>')
// The lamp switched on, drawn under the desk's lines: the shade glowing, a soft cone of light down onto the top, three short rays.
const LIGHT = '<g class="lamp-light"><path class="lamp-glow" d="M14.9 2.4Q11.7 3.7 10.7 4.7Q9.6 5.7 9 6.6Q8.5 7.4 9 7.6Q9.5 7.9 12.4 7Q15.2 6.1 15.6 6.1Q15.9 6.1 15.8 4.7Q15.7 3.4 14.9 2.4Z"/><path class="lamp-cone" d="M9.2 7.9Q12.4 7.1 15.6 6.3L17.3 11.9Q12 12.1 6.4 12.2Z"/><path d="M7.6 9Q5.9 10.1 4.3 11.2"/><path d="M7.1 7.2Q5.3 7.3 3.5 7.5"/><path d="M7.9 5Q6.4 4.2 4.9 3.5"/></g>'
/** The desk drawing of the sidebar; the desk in view has its lamp on. */
const deskMark = lit => raw(lit ? sketchSvg('desk', 'menu-lamp is-lit').replace(/(<svg[^>]*>)/, `$1${LIGHT}`) : sketchSvg('desk', 'menu-lamp'))

/** The menu: <nav id="brand-doors">, hidden until the pill is pressed (or Ctrl K). For the layout's topbar, in place of its own <nav>.
 *  Three calm groups: the desks, each a row with the desk drawing (the one in view has its lamp on), the Demo as one more
 *  desk, and a quiet "New desk" (a line to name it, Enter makes it: menu_controller.js); places (Agents & devices,
 *  Help, Keys); this device (Push, Log out, and the theme as a small sun/moon beside Log out). The connection is not
 *  said here: a lost one is a dot on the pill (views/layout.mjs). */
export function menuDoors(model, base) {
  const desks = desksOf(model)
  const lit = d => (model.desk ? d.id === model.desk : d === desks[0])
  return html`<nav class="sidedoors" id="brand-doors" role="menu" aria-label="Desks, places and settings" data-controller="menu" data-menu-desk-value="${base}/" data-action="keydown->menu#walk click->menu#chosen" hidden>
<div class="menu-desks" id="menu-desks">${desks.map((d, i) => html`<a role="menuitemradio" class="menu-desk" data-nav draggable="false" href="${base}/?desk=${d.id}" data-desk="${d.id}" aria-checked="${String(lit(d))}">${deskMark(lit(d))}<b>${d.name}</b><i${d.knocks && i ? raw(' class="is-knock"') : ''}>${d.open} open</i>${i < 9 ? html`<kbd>${i + 1}</kbd>` : ''}</a>`)}
<a role="menuitem" class="menu-desk is-demo" href="${base}/?mock=1" data-turbo="false" draggable="false" id="dev-mock" title="The demo: a made-up room, nothing is kept">${deskMark(false)}<b>Demo</b><i>sample room</i></a>
<button type="button" role="menuitem" class="menu-desk-add" id="desk-add" data-action="click->menu#newDesk" aria-label="New desk">${PLUS}<span>New desk</span></button>
<form class="menu-desk-form" id="desk-new" data-menu-target="deskForm" data-action="submit->menu#makeDesk" hidden><input class="menu-desk-field" data-menu-target="deskName" data-action="keydown->menu#deskKey" maxlength="40" placeholder="Name of the new desk" aria-label="Name of the new desk" autocomplete="off"><button type="submit">Make</button></form>
<p class="menu-desk-error" data-menu-target="deskError" role="alert"></p></div>
<div class="menu-grid"><a role="menuitem" href="${base}/agents" data-nav draggable="false" id="menu-agents" title="Agents and devices: the sessions, and who is in the room">${sk('heads')}<span>Agents &amp; devices</span></a><a role="menuitem" href="${base}/assets" data-nav draggable="false" id="menu-assets" title="Assets: everything your agents sent">${sk('picture')}<span>Assets</span></a><a role="menuitem" href="/help.html">${sk('page')}<span>Help</span></a><button role="menuitem" type="button" id="keys-open" data-action="click->menu#keys" aria-haspopup="dialog" aria-keyshortcuts="?">${sk('keycap')}<span>Keys</span></button></div>
<div class="menu-foot"><button role="menuitemcheckbox" type="button" id="push-toggle" aria-checked="false" aria-label="Push on this device">${sk('bell')}</button></div>
<div class="menu-leave"><a role="menuitem" href="${base}/logout" data-nav draggable="false" id="menu-logout" class="menu-logout" title="Log out of this device">${LEAVE}<span>Log out</span></a><button role="menuitemcheckbox" type="button" id="theme-toggle" class="menu-theme" aria-label="Light or dark (T)" title="Light or dark (T)">${raw(sketchSvg('moon', 'ico-moon'))}${raw(sketchSvg('sun', 'ico-sun'))}</button></div>
</nav>`
}

/** Where a query leads: sessions by name, a question by its number or by words of its title, places. [{ label, icon, href }] */
export function jumpPlaces(model, base, query) {
  const q = String(query ?? '').trim().toLowerCase().slice(0, 80)
  if (!q) return []
  const out = []
  const hit = text => String(text ?? '').toLowerCase().includes(q)
  const nr = /^(?:nr\.?\s*|#)?(\d+)$/.exec(q)
  const numbered = nr ? model.state.cards.find(c => String(c.number) === nr[1]) : null
  if (numbered) out.push({ label: `${cardNr(numbered)}: ${numbered.title}`, icon: 'stack', href: cardPath(numbered, base) })
  if (hit('desk inbox')) out.push({ label: WORDS.desk, icon: 'desk', href: `${base}/` })
  if (hit('agents ledger sessions')) out.push({ label: 'Agents', icon: 'heads', href: `${base}/agents` })
  if (hit(`${WORDS.walk} walk`) && model.fresh.length) out.push({ label: WORDS.walk, icon: 'go', href: `${base}/walk` })
  if (hit('scratchpad pad')) out.push({ label: 'Scratchpad', icon: 'pen', href: `${base}/pad` })
  if (hit('help')) out.push({ label: 'Help', icon: 'page', href: '/help.html' })
  if (hit('keys keyboard')) out.push({ label: 'Keys', icon: 'keycap', href: '/help.html#keys' })
  for (const a of model.agents) if (hit(a.name)) out.push({ label: a.name, icon: 'bubble', href: `${base}/s/${encodeURIComponent(a.id)}` })
  // Words of a title: what is open first, then the rest, the newest first.
  if (q.length > 1) {
    const open = new Set(model.open.map(c => c.id))
    const cards = model.state.cards.filter(c => c !== numbered && hit(c.title)).sort((a, b) => open.has(b.id) - open.has(a.id) || (b.created ?? 0) - (a.created ?? 0))
    for (const c of cards) out.push({ label: `${cardNr(c)}: ${c.title}`, icon: 'stack', href: cardPath(c, base) })
  }
  return out.slice(0, JUMP_MAX)
}

/** The results as the frame the menu holds (#jump-results); Enter in the field takes the first. */
export const jumpResults = (model, base, query) => html`<turbo-frame id="jump-results" target="_top" role="listbox" aria-label="Places">${jumpPlaces(model, base, query).map((p, i) => html`<a role="option" data-nav draggable="false" href="${p.href}"${i ? '' : raw(' aria-selected="true"')}>${sk(p.icon)}<span>${p.label}</span></a>`)}</turbo-frame>`

/** The sheet a long press on a Desk row brings up on a phone (css/phone-desk.css, dialog.rowmenu): one form, each way its own
 *  button. The hub renders it once per Desk; the controller t/controllers/sheet_controller.js points it at the row that was held. */
export function rowSheet(base) {
  const way = (name, drawing, word, cls = '', tip = '') => html`<button type="submit" data-way="${name}"${cls ? html` class="${cls}"` : ''}${tip ? html` title="${tip}" aria-label="${tip}"` : ''}>${sk(drawing)}${tip ? '' : html`<span>${word}</span>`}</button>`
  return html`<dialog class="rowmenu" id="row-sheet" data-controller="sheet" data-sheet-cards-value="${base}/cards" data-action="click->sheet#tapped turbo:submit-start->sheet#sent" aria-labelledby="row-sheet-title"><div class="rowmenu-in">
<h3 id="row-sheet-title"></h3>
<form method="post" id="row-sheet-form"><input type="hidden" name="stay" value="1">
${way('snooze', 'snooze', WORDS.later)}${way('revise', 'reverse', WORDS.revise)}${way('trust', 'duck', WORDS.trust)}${way('what', 'what', WORDS.what, '', 'What?? — explain this to me')}${way('shred', 'bin', WORDS.shred, 'is-shred')}</form>
<a class="rowmenu-open" data-nav draggable="false" href="${base}/">${sk('page')}<span>Open</span></a>
</div></dialog>`
}

/** The jump route. One import and one entry in PAGES (server/turbo.mjs). */
export function register(t) {
  // The menu's field asks into its frame; without scripts the same form leads to this small page.
  t.get(/^\/jump$/, ({ req, res, url }) => {
    const m = t.model()
    t.page(req, res, { model: m, title: 'Jump · Trommi', view: 'jump', sidebar: false, stream: null, main: html`<main id="inbox" aria-label="Jump">${jumpResults(m, t.BASE, url.searchParams.get('q'))}</main>` })
  })
}
