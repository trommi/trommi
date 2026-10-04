// The Trommi menu (what opens from the floating pill at the top centre), the jump field's results, and the
// sheet a long press on a Desk row brings up on a phone. The menu's markup is the old client's (index.html,
// js/bar.js), so css/app.css and css/clipboard.css style it; the controller t/controllers/menu_controller.js adds the
// jump field's typing and the arrows, sheet_controller.js the long press. Opening and closing the
// menu and the theme: t/application.js.
import { html, raw } from './html.mjs'
import { WORDS, cardNr } from './text.mjs'
import { cardPath } from './desk.mjs'
import { sketchSvg, doodleSvg } from '../pen.js'

const sk = name => raw(sketchSvg(name))
const JUMP_MAX = 8
const DEFAULT_DESK = 'main'

/** The desks with what waits on each: [{ id, name, open, knocks }]. */
function desksOf(model) {
  const desks = model.state.desks?.length ? model.state.desks : [{ id: DEFAULT_DESK, name: 'Desk' }]
  const deskOf = card => { const d = model.byAgent.get(card.agent)?.desk; return desks.some(x => x.id === d) ? d : desks[0].id }
  return desks.map(d => { const mine = (model.allFresh ?? model.fresh).filter(c => deskOf(c) === d.id); return { id: d.id, name: d.name || 'Desk', open: mine.length, knocks: mine.some(c => ['high', 'critical'].includes(c.urgency)) } })
}

// Two small drawings of the menu's own, in the pen's line: the Dev symbol (</>) and the plus of "New desk".
const DEV = raw('<svg viewBox="0 0 24 24" class="sketch" aria-hidden="true" style="rotate:-2deg"><path d="M8.6 7.1Q6 9.6 3.9 12.2Q6.2 14.5 8.4 17"/><path d="M15.5 6.9Q18.1 9.4 20.1 11.9Q17.9 14.6 15.4 16.9"/><path d="M13.7 5.1Q12.1 11.8 10.4 18.9"/></svg>')
const PLUS = raw('<svg viewBox="0 0 24 24" class="sketch" aria-hidden="true" style="rotate:3deg"><path d="M12.2 5.2Q11.8 12 12 18.8"/><path d="M5.3 12.3Q12 11.7 18.7 12.1"/></svg>')

/** The menu: <nav id="brand-doors">, hidden until the pill is pressed. For the layout's topbar, in place of its own <nav>.
 *  Three calm groups and Dev: the jump field (with the theme as one small sun/moon beside it); the desks with "+" for a
 *  new one (a line to name it, Enter makes it: menu_controller.js); Go to (Agents, Help, Keys); this device (Push); and
 *  Dev folded away at the foot. The connection is not said here: a lost one is a dot on the pill (views/layout.mjs). */
export function menuDoors(model, base) {
  const desks = desksOf(model)
  return html`<nav class="sidedoors" id="brand-doors" role="menu" aria-label="Jump, desks, places and settings" data-controller="menu" data-menu-desk-value="${base}/" data-action="keydown->menu#walk click->menu#chosen turbo:frame-load->menu#loaded" hidden>
<div class="menu-top"><form id="jump-form" role="search" method="get" action="${base}/jump" data-turbo-frame="jump-results"><label class="jump-box"><input id="jump-field" data-menu-target="field" data-action="input->menu#typed keydown->menu#fieldKey" name="q" type="search" placeholder="Session, number, words…" aria-label="Jump to a session, a question by its number or words, or a place" aria-keyshortcuts="Control+K Meta+K" autocomplete="off" spellcheck="false"><kbd id="jump-key" data-menu-target="key">Ctrl K</kbd></label></form><button role="menuitemcheckbox" type="button" id="theme-toggle" class="menu-theme" aria-label="Light or dark (T)" title="Light or dark (T)">${raw(sketchSvg('moon', 'ico-moon'))}${raw(sketchSvg('sun', 'ico-sun'))}</button></div>
<turbo-frame id="jump-results" data-menu-target="results" target="_top" role="listbox" aria-label="Places"></turbo-frame>
<div class="menu-desks-head"><p class="menu-head">Desk</p><button type="button" class="menu-desk-add" id="desk-add" data-action="click->menu#newDesk" title="New desk" aria-label="New desk">${PLUS}</button></div>
<div class="menu-desks" id="menu-desks">${desks.map((d, i) => html`<a role="menuitemradio" class="menu-desk" data-nav draggable="false" href="${base}/?desk=${d.id}" data-desk="${d.id}" aria-checked="${String(model.desk ? d.id === model.desk : i === 0)}"><b>${d.name}</b><i${d.knocks && i ? raw(' class="is-knock"') : ''}>${d.open} open</i>${i < 9 ? html`<kbd>D ${i + 1}</kbd>` : ''}</a>`)}
<form class="menu-desk-form" id="desk-new" data-menu-target="deskForm" data-action="submit->menu#makeDesk" hidden><input class="menu-desk-field" data-menu-target="deskName" data-action="keydown->menu#deskKey" maxlength="40" placeholder="Name of the new desk" aria-label="Name of the new desk" autocomplete="off"><button type="submit">Make</button></form>
<p class="menu-desk-error" data-menu-target="deskError" role="alert"></p></div>
<div class="menu-grid"><a role="menuitem" href="${base}/agents" data-nav draggable="false" id="menu-agents" title="Agents">${sk('heads')}<span>Agents</span></a><a role="menuitem" href="/help.html">${sk('page')}<span>Help</span></a><button role="menuitem" type="button" id="keys-open" data-action="click->menu#keys" aria-haspopup="dialog" aria-keyshortcuts="?">${sk('keycap')}<span>Keys</span></button></div>
<a role="menuitem" href="${base}/devices" data-nav draggable="false" id="menu-devices" class="menu-devices" title="Geräte und Einstellungen">${raw(doodleSvg('draw:phone'))}<span>Geräte</span></a><div class="menu-foot"><button role="menuitemcheckbox" type="button" id="push-toggle" aria-checked="false" aria-label="Push on this device">${sk('bell')}</button></div>
<details class="menu-dev" id="menu-dev"><summary role="menuitem" id="dev-open">${DEV}<span>Dev</span></summary><div class="menu-dev-items"><a role="menuitem" href="${base}/?mock=1" data-turbo="false" id="dev-mock">Mock room</a></div></details>
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
