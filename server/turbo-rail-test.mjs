// The rail (card Nr. 150): the sidebar folded to the sessions' drawings. Called from server/turbo-test.mjs with that
// suite's hub and helpers. What the browser does with it (fold, reload, the name beside a row): dev/turbo-ui-test.mjs "rail".
import assert from 'node:assert/strict'
import { LAYOUT } from '../client/web/t/lib/keys.js'

export async function railTests({ get }) {
  // the key: [ in the one table, anywhere a sidebar is
  const entry = LAYOUT.flatMap(g => g.keys).find(e => e.id === 'rail')
  assert.deepEqual(entry?.keys, ['['])
  assert.equal(entry.needs, 'sidebar')

  // a page with the sidebar: the remembered fold is set on <html> in the head, before the stylesheets (no flash),
  // and the drawn "|<" stands after the sidebar, outside #agents (a stream that updates #agents leaves it alone)
  const page = await (await get('/t/')).text()
  const head = page.slice(0, page.indexOf('</head>'))
  const set = head.indexOf("localStorage.getItem('trommi-rail')==='folded'")
  assert.ok(set > 0, 'the rail is read in the head')
  assert.ok(set < head.indexOf('<link rel="stylesheet"'), 'before the first stylesheet')
  const nav = page.indexOf('<nav id="agents"'), close = page.indexOf('</nav>', nav), button = page.indexOf('class="rail-fold"')
  assert.ok(nav > 0 && button > close, 'the button follows the sidebar')
  assert.equal(page.match(/class="rail-fold"/g).length, 1)
  assert.match(page, /<button type="button" class="rail-fold" data-controller="rail" data-action="click->rail#toggle [^"]*pointerover@document->rail#tip[^"]*" title="Fold the sidebar to a rail \( \[ \)" aria-label="[^"]+" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path/)
  // the key works but the "?" sheet lists only the short list now (card Nr. 200, worker D); the table still has it
  assert.ok((await import('../client/web/t/lib/keys.js')).LAYOUT.some(g => g.keys.some(k => k.id === 'rail' && k.keys.includes('['))))

  // the controller is served
  const controller = await get('/t/controllers/rail_controller.js')
  assert.equal(controller.status, 200)
  assert.match(await controller.text(), /trommi-rail/)
}
