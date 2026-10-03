// The Dev menu's test cards (server/fixtures.mjs, dev/fixtures.mjs): a desk "Test" with Test Alpha and Test Beta and
// one card of every kind; "Remove test cards" takes away only what the fixtures filed. Run by server/turbo-test.mjs on
// its hub (pages under /t), last, because it adds a desk.
import assert from 'node:assert/strict'
import http from 'node:http'
import { KINDS, GROUPS, FIXTURES, pick } from './fixtures.mjs'

export async function fixturesTests({ base, cookie, ask, get, post, STREAM, stateOnce, cardOf, eventually }) {
  // ---- the set: every kind once, groups name their kinds, an unknown kind is refused ----
  assert.equal(new Set(KINDS).size, KINDS.length, 'kinds are unique')
  assert.equal(pick().length, FIXTURES.length)
  assert.equal(pick(['all']).length, FIXTURES.length)
  assert.deepEqual(pick(['info']).map(f => f.kind), ['info', 'code', 'files'])
  assert.ok(GROUPS.includes('decision') && pick(['decision']).every(f => f.groups.includes('decision')))
  assert.throws(() => pick(['nope']), /unknown kind nope/)

  // ---- the menu's Dev group has both items, as plain forms ----
  const desk = await (await get('/t/')).text()
  assert.match(desk, /<form method="post" action="\/t\/dev\/fixtures" class="menu-dev-form" data-controller="fixtures" data-fixtures-desk-value="\/t\/" data-action="turbo:submit-end->fixtures#open"><input type="hidden" name="stay" value="1"><button role="menuitem" type="submit" id="dev-fixtures">Create test cards<\/button><\/form>/)
  assert.match(desk, /action="\/t\/dev\/fixtures\/clear"[^>]*>.*?id="dev-fixtures-clear">Remove test cards</)

  // ---- only behind the login and from the page itself ----
  assert.equal((await fetch(`${base}/t/dev/fixtures`, { method: 'POST' })).status, 401)
  assert.equal((await fetch(`${base}/t/dev/fixtures`, { method: 'POST', headers: { Cookie: cookie, Origin: 'http://evil.example' } })).status, 403)
  assert.equal((await post('/t/dev/fixtures', { kind: 'nope' }, { Accept: 'application/json' })).status, 400)

  // ---- an existing "Test Alpha" (the crown test sessions) is taken as it is, with its sub; "Test Beta" is made ----
  const linkOf = (name, id, extra = {}) => new Promise(resolve => {
    const req = http.get(`${base}/agent/link?${new URLSearchParams({ name, id, instance: `${id}-instance-01`, cwd: '/tmp', host: 'h', platform: 'p', ...extra })}`, { headers: { 'x-board-token': 'secret' } }, res => { res.setEncoding('utf8'); res.once('data', () => resolve(req)) })
  })
  const alphaLink = await linkOf('Test Alpha', 'test-alpha')
  const subLink = await linkOf('Test Alpha 1', 'test-alpha-1', { parent: 'test-alpha' })
  await eventually(async () => (await stateOnce()).agents.find(a => a.id === 'test-alpha-1')?.parent === 'test-alpha', 'the sub under Test Alpha')
  const real = await ask('Echte Karte bleibt')   // a card of another session: the fixtures never touch it

  // ---- a script's call (dev/fixtures.mjs): JSON ----
  let res = await post('/t/dev/fixtures', { kind: 'yesno' }, { Accept: 'application/json' })
  assert.equal(res.status, 200)
  let out = await res.json()
  assert.equal(out.cards.length, 1)
  let state = await stateOnce()
  const test = state.desks.find(d => d.fixture)
  assert.equal(test.name, 'Test')
  assert.equal(out.desk, test.id)
  const alpha = state.agents.find(a => a.id === 'test-alpha'), beta = state.agents.find(a => a.id === 'test-beta')
  assert.equal(alpha.name, 'Test Alpha')
  assert.ok(alpha.fixture && !alpha.demo, 'the linked session is reused, not replaced')
  assert.ok(beta.fixture && beta.demo, 'a missing one is made as the hub\'s own')
  for (const id of ['test-alpha', 'test-alpha-1', 'test-beta']) assert.equal(state.agents.find(a => a.id === id).desk, test.id, `${id} on the test desk`)
  // the cards are on the test desk, not on the real one
  const yesno = state.cards.find(c => c.number === out.cards[0])
  assert.ok(yesno.fixture && yesno.agent === 'test-alpha')
  assert.doesNotMatch(await (await get('/t/')).text(), /Alte Navigation löschen\?/)
  assert.match(await (await get('/t/', { Cookie: `${cookie}; trommi_desk=${test.id}` })).text(), /Alte Navigation löschen\?/)

  // ---- the menu's form with Turbo: the toast (Undo removes them again), and the browser goes to the test desk ----
  res = await post('/t/dev/fixtures', { stay: '1' }, STREAM)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('set-cookie'), new RegExp(`^trommi_desk=${test.id}; Path=/;`))
  const said = await res.text()
  assert.match(said, new RegExp(`^<turbo-stream action="prepend" target="says-host"><template><div class="says"[^>]*><span class="says-words"><b>Test cards made</b><span>${FIXTURES.filter(f => f.tool !== 'reply').length} on the desk “Test”</span></span><form method="post" action="/t/dev/fixtures/clear">`))
  state = await stateOnce()
  const made = state.cards.filter(c => c.fixture)
  assert.equal(made.length, 1 + FIXTURES.filter(f => f.tool !== 'reply').length)
  const kindOf = title => made.find(c => c.title === title)
  // one of each sort the contract knows
  assert.ok(made.some(c => c.kind === 'info') && made.some(c => c.multiple) && made.some(c => c.sections?.length) && made.some(c => c.html))
  assert.ok(made.some(c => c.urgency === 'critical') && made.some(c => c.urgency === 'high'))
  assert.ok(made.some(c => c.snoozed_until), 'a snoozed card')
  assert.ok(made.some(c => c.with_agent), 'a card handed back')
  assert.ok(made.some(c => c.version === 2), 'a revised card')
  assert.ok(made.some(c => c.attachments.some(a => a.page?.kind === 'file')) && made.some(c => c.attachments.some(a => a.marks?.length)), 'a picture with its page, a picture with marks')
  assert.ok(made.some(c => c.attachments.some(a => !a.image)), 'files')
  assert.equal(kindOf('Changelog ab jetzt führen?').status, 'done', 'the answered card closed itself (nobody listens for Test Beta)')
  const thread = kindOf('Migration auf der Produktions-Datenbank ausführen?')
  assert.ok(state.messages.filter(m => m.card_id === thread.id && (m.from === 'agent' || m.from === 'user')).length >= 4, 'a conversation under the card')
  assert.equal(state.messages.filter(m => m.fixture && m.asset).length, 2, 'a page and a picture as assets')
  // a plain post (no scripts): to the Desk, which is now the test desk
  res = await post('/t/dev/fixtures', { kind: 'info' })
  assert.equal(res.status, 303)
  assert.equal(res.headers.get('location'), '/t/')

  // ---- an answer to a test card of a session nobody listens for closes it ----
  const high = kindOf('Zertifikat läuft in 2 Tagen ab. Jetzt erneuern?')
  assert.equal((await post(`/t/cards/${high.id}/decide`, { key: 'yes' })).status, 303)
  await eventually(async () => (await cardOf(high.id)).status === 'done', 'the answered test card to close')

  // ---- "Remove test cards": only what the fixtures filed goes; the desk and the sessions stay ----
  const before = await stateOnce()
  const fixtureCount = before.cards.filter(c => c.fixture).length
  res = await post('/t/dev/fixtures/clear', { stay: '1' }, STREAM)
  assert.equal(res.status, 200)
  assert.match(await res.text(), new RegExp(`<b>Test cards removed</b><span>${fixtureCount} cards of Test Alpha and Test Beta</span>`))
  state = await stateOnce()
  assert.equal(state.cards.filter(c => c.fixture).length, 0)
  assert.equal(state.messages.filter(m => m.fixture).length, 0)
  assert.equal(state.messages.filter(m => made.some(c => c.id === m.card_id)).length, 0, 'their conversation went with them')
  assert.ok(await cardOf(real), 'a real card stays')
  assert.equal(state.cards.length, before.cards.length - fixtureCount)
  assert.ok(state.desks.some(d => d.id === test.id) && ['test-alpha', 'test-alpha-1', 'test-beta'].every(id => state.agents.find(a => a.id === id)?.desk === test.id))
  // the Undo of the toast is the same route, quiet: no toast of its own
  res = await post('/t/dev/fixtures/clear', { stay: '1', quiet: '1' }, STREAM)
  assert.equal(await res.text(), '')
  assert.deepEqual((await (await post('/t/dev/fixtures/clear', {}, { Accept: 'application/json' })).json()).cards, [])
  alphaLink.destroy()
  subLink.destroy()
  console.log('ok: turbo fixtures (the test desk, Test Alpha and Test Beta, every kind of card, the menu items, remove)')
}
