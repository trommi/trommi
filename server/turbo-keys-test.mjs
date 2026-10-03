// The keys, the Trommi menu, its jump field and the long-press sheet (worker D), called from server/turbo-test.mjs
// with that suite's hub and helpers. What the browser does with them: dev/turbo-keys-test.mjs.
import assert from 'node:assert/strict'
import { LAYOUT, SHORT } from '../client/web/t/lib/keys.js'

export async function keysTests({ ask, get, cardOf }) {
  // ---- the one table: plain keys and "g then x" only, Ctrl/Cmd only for jump; every id once ----
  const all = LAYOUT.flatMap(g => g.keys)
  for (const entry of all) for (const spec of entry.keys) assert.ok(!/^(Ctrl|Alt|Meta)\+/.test(spec) && (!spec.startsWith('Mod+') || entry.id === 'go.jump'), `${entry.id}: ${spec}`)
  assert.equal(new Set(all.map(e => `${e.id}`)).size, all.length)
  assert.deepEqual(all.find(e => e.id === 'desk.switch').keys, ['d 1…9'])
  assert.deepEqual(all.find(e => e.id === 'go.session').keys, ['g 1…9'])
  // N is the note now; nothing answers with 1–9, Y or N any more
  assert.deepEqual(all.filter(e => e.keys.includes('n')).map(e => e.id), ['memo.new'])
  assert.ok(!all.some(e => e.keys.includes('y') || e.keys.includes('1…9')))
  assert.deepEqual(SHORT.map(k => k.keys.join(' ')), ['ArrowUp ArrowDown', 'Enter', 'Escape', 'n', 'l', '?'])

  // ---- the menu on the Desk: jump field into its frame, desks, places, switches, Dev ----
  const card = await ask('Sprung <b>fett</b> zur Karte')
  const nr = (await cardOf(card)).number
  let page = await (await get('/t/')).text()
  const menu = /<nav class="sidedoors" id="brand-doors"[\s\S]*?<\/nav>/.exec(page)?.[0] ?? ''
  assert.match(menu, /data-controller="menu"/)
  assert.match(menu, /<form id="jump-form" role="search" method="get" action="\/t\/jump" data-turbo-frame="jump-results">/)
  assert.match(menu, /<turbo-frame id="jump-results"/)
  assert.match(menu, /<a role="menuitemradio" class="menu-desk" data-nav draggable="false" href="\/t\/\?desk=main" data-desk="main"[^>]*><b>Desk<\/b><i>\d+ open<\/i><kbd>D 1<\/kbd><\/a>/)
  for (const id of ['menu-agents', 'keys-open', 'theme-toggle', 'push-toggle', 'dev-fake', 'dev-fake-clear', 'dev-screens', 'dev-old']) assert.ok(menu.includes(`id="${id}"`), id)
  assert.equal(menu.match(/>Old board</g).length, 1, '"Old board" once, under Dev')
  const dev = /<details class="menu-dev" id="menu-dev">[\s\S]*?<\/details>/.exec(menu)?.[0] ?? ''
  for (const id of ['dev-fake', 'dev-fake-clear', 'dev-screens', 'dev-old', 'dev-admin']) assert.ok(dev.includes(`id="${id}"`), `${id} under Dev`)
  // Agents is a line with its drawing; the connection is not said in the menu but as a dot on the pill; the theme is a sun/moon by the field; the pill always says Trommi; the desk in view is the ticked one in the menu
  assert.match(menu, /<a role="menuitem" href="\/t\/agents" data-nav draggable="false" id="menu-agents" title="Agents"><svg/)
  assert.ok(!menu.includes('id="conn"') && !menu.includes('Team'))
  assert.match(menu, /<\/form><button role="menuitemcheckbox" type="button" id="theme-toggle" class="menu-theme"/)
  assert.match(page, /<b class="pill-word">Trommi<\/b><span class="conn pill-conn" id="conn" data-state="connecting"/)
  assert.match(menu, /<button type="button" class="menu-desk-add" id="desk-add"[^<]*aria-label="New desk">/)
  assert.match(menu, /<form class="menu-desk-form" id="desk-new"[^<]*hidden>/)
  assert.ok(!page.includes('/css/clipboard.css'), 'the menu is a plain sheet, not the clipboard')
  // ---- the key sheet of the view (no veil: a dialog css/keys.css gives a clear backdrop), the long-press sheet ----
  const sheet = /<dialog class="keys-sheet" id="keys-sheet"[\s\S]*?<\/dialog>/.exec(page)?.[0] ?? ''
  assert.match(sheet, /data-controller="keys"/)
  // the short list only (card Nr. 200): arrows, Enter, Esc, N for a note, L for later, and ?; the rest is not listed
  assert.equal((sheet.match(/<div><dt>/g) ?? []).length, SHORT.length)
  assert.ok(sheet.includes('a new note (memo)') && sheet.includes('More keys later') && !sheet.includes('Whatever'))
  assert.ok(sheet.includes('<a href="/help.html#keys">On the help page</a>'))
  assert.match(page, /<dialog class="rowmenu" id="row-sheet" data-controller="sheet" data-sheet-cards-value="\/t\/cards"/)
  page = await (await get(`/t/q/${nr}`)).text()
  assert.ok(page.includes('a new note (memo)'), 'a card page has the same short list')
  assert.ok(!page.includes('id="row-sheet"'))

  // ---- jump: by number, by words of a title, by a session's name; escaped; nothing for nothing ----
  let res = await get(`/t/jump?q=${nr}`)
  assert.equal(res.status, 200)
  let found = await res.text()
  assert.match(found, new RegExp(`<a role="option" data-nav draggable="false" href="/t/q/${nr}" aria-selected="true">`))
  assert.ok(found.includes('Sprung &lt;b&gt;fett&lt;/b&gt; zur Karte') && !found.includes('<b>fett</b>'))
  found = await (await get('/t/jump?q=fett')).text()
  assert.ok(found.includes(`href="/t/q/${nr}"`))
  found = await (await get('/t/jump?q=probe')).text()
  assert.match(found, /href="\/t\/s\/[\w-]+"/)
  found = await (await get('/t/jump?q=')).text()
  assert.doesNotMatch(found, /role="option"/)
  assert.equal((await fetch(new URL('/t/jump?q=x', (await get('/t/')).url))).status, 401)
}
