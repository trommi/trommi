// The sheet behind "?": the keys of the view that is up, rendered by the hub from the one table of keys
// (client/web/t/lib/keys.js; t/controllers/keys_controller.js listens for them). No veil: a <dialog> with a clear backdrop
// (css/keys.css); "?" , Escape, its Close button or a click beside it closes. The whole table: /help.html#keys.
// pageSheets() is what the layout includes: this sheet, and on the Desk the sheet a long press on a row brings up.
import { html } from './html.mjs'
import { LAYOUT, SHORT, scopesOf, capOf } from '../../client/web/t/lib/keys.js'
import { rowSheet } from './menu.mjs'

// One key as caps: 'g d' is G then D; "Mod" is Ctrl here and ⌘ on a Mac (the controller swaps the cap marked data-mod).
const caps = spec => html`<span class="keys-caps">${(spec === ' ' ? [spec] : spec.split(' ')).map((part, i) => html`${i ? html`<i>then</i>` : ''}${capOf(part).map(text => (text === 'Ctrl' ? html`<kbd data-mod>Ctrl</kbd>` : html`<kbd>${text}</kbd>`))}`)}</span>`

/** The groups of the table that count on a view, first to hear first. has: { sidebar, desks } (what the page carries). */
export function keyGroups(view, has = {}) {
  const scopes = scopesOf(view)
  return scopes.map(scope => LAYOUT.find(g => g.scope === scope)).filter(Boolean)
    .map(g => ({ title: g.title, keys: g.keys.filter(k => !k.needs || has[k.needs]) }))
    .filter(g => g.keys.length)
}

/** The key sheet of a view. sidebar: the page shows the sessions and the Trommi menu. */
export function keySheet(view, { sidebar = true } = {}) {
  void view; void sidebar   // (one short list for every view, card Nr. 200; keyGroups() keeps the whole table per view)
  return html`<dialog class="keys-sheet" id="keys-sheet" data-controller="keys" data-action="click->keys#beside" aria-labelledby="keys-sheet-title">
<header><h2 id="keys-sheet-title">Keys</h2><form method="dialog"><button class="keys-close" type="submit">Close<kbd>Esc</kbd></button></form></header>
<div class="keys-groups"><section><dl>${SHORT.map(k => html`<div><dt>${k.keys.map((spec, i) => html`${i ? html`<i>or</i>` : ''}${caps(spec)}`)}</dt><dd>${k.does}</dd></div>`)}</dl></section></div>
<p class="keys-foot">More keys later. Keys rest while you type in a field. <a href="/help.html#keys">On the help page</a></p>
</dialog>`
}

/** For the layout, once per page, anywhere in the body: `${pageSheets(view, base, { sidebar })}`. */
export const pageSheets = (view, base, { sidebar = true } = {}) => html`${keySheet(view, { sidebar })}${view === 'desk' ? rowSheet(base) : ''}`
