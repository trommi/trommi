// The one toast (server/views/toast.mjs): top right on every page, "<what happened>: <of what>" and Undo, which posts
// to the route that takes the action back. Run by server/turbo-test.mjs on its hub (BOARD_MEMO_HOLD_MS=400 there).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { toast } from './views/toast.mjs'

export async function toastTests({ base, cookie, agent, ask, get, post, STREAM, stateOnce, cardOf, eventually }) {
  // ---- the markup: escaped, Undo as a form with stay and quiet, a plain note without one ----
  const one = String(toast({ head: 'Answered', line: 'A <b>', undo: { action: '/t/cards/x/reopen', fields: { k: '"v"' } }, ms: 3000 }))
  assert.match(one, /^<div class="says" data-controller="says" data-action="[^"]*says#leave[^"]*says#gone" role="status" data-says-ms-value="3000"><span class="says-words"><b>Answered<\/b><span>A &lt;b&gt;<\/span><\/span><form method="post" action="\/t\/cards\/x\/reopen"><input type="hidden" name="stay" value="1"><input type="hidden" name="quiet" value="1"><input type="hidden" name="k" value="&quot;v&quot;"><button class="says-back" type="submit" title="Undo \(U\)" aria-keyshortcuts="u">/)
  const plain = String(toast({ head: 'Memo put away', role: 'alert' }))
  assert.ok(!plain.includes('<form') && !plain.includes('says-back') && plain.includes('role="alert"'), 'a plain note has no Undo')

  // ---- every page has the place, kept across Turbo's page changes ----
  for (const page of ['/t/', '/t/agents', `/t/s/${agent.id}`]) assert.match(await (await get(page)).text(), /<div class="says-host says-page" id="says-host" data-turbo-permanent>/, page)
  // the look is one block, at the top right (css/turbo.css)
  const css = fs.readFileSync(new URL('../client/web/css/turbo.css', import.meta.url), 'utf8')
  assert.match(css, /#says-host \{ top: 12px; right: 12px; left: auto;/)

  // ---- a card's ways: the toast is prepended (stacked), its Undo goes to the matching take-back ----
  const card = await ask('Toast <i>probe</i>')
  for (const [way, head, back] of [['snooze', 'Snoozed', 'wake'], ['shred', 'Shredded', 'reopen'], ['decide', 'Answered', 'reopen'], ['revise', 'Handed back', 'takeback']]) {
    const res = await post(`/t/cards/${card}/${way}`, { stay: '1', key: 'a' }, STREAM)
    assert.equal(res.status, 200, way)
    const said = await res.text()
    assert.match(said, new RegExp(`<turbo-stream action="prepend" target="says-host"><template><div class="says"[^>]*role="status"><span class="says-words"><b>${head}</b><span>Toast &lt;i&gt;probe&lt;/i&gt;[^<]*</span></span><form method="post" action="/t/cards/${card}/${back}">`), way)
    // Undo: the take-back, quiet (no new toast for it)
    const undo = await post(`/t/cards/${card}/${back}`, { stay: '1', quiet: '1' }, STREAM)
    assert.equal(undo.status, 200, `${way} undone`)
    assert.ok(!(await undo.text()).includes('says-host'), 'taking back adds no toast')
    await eventually(async () => { const c = await cardOf(card); return c.status === 'open' && !c.snoozed_until && c.with_agent == null }, `the card open again after ${way}`)
  }
  // what went wrong is a toast too, without Undo
  const wrong = await (await post('/t/cards/0000aaaa/snooze', { stay: '1' }, STREAM)).text()
  assert.match(wrong, /<turbo-stream action="prepend" target="says-host"><template><div class="says"[^>]*role="alert"><span class="says-words"><b>Not saved<\/b>/)
  assert.ok(!wrong.includes('says-back'))

  // ---- after a redirect: the page shows the toast of ?said=, the Desk and a session's page alike ----
  let res = await post(`/t/cards/${card}/snooze`, {})
  assert.equal(res.status, 303)
  assert.equal(res.headers.get('location'), `/t/?said=${card}:snooze`)
  assert.match(await (await get(res.headers.get('location'))).text(), new RegExp(`id="says-host" data-turbo-permanent><div class="says"[^>]*><span class="says-words"><b>Snoozed</b>[\\s\\S]*?action="/t/cards/${card}/wake"`))
  await post(`/t/cards/${card}/wake`, { stay: '1', quiet: '1' }, STREAM)
  res = await post(`/t/cards/${card}/snooze`, { back: `/t/s/${agent.id}` })
  assert.equal(res.headers.get('location'), `/t/s/${agent.id}?said=${card}:snooze`)
  assert.match(await (await get(res.headers.get('location'))).text(), /id="says-host" data-turbo-permanent><div class="says"[^>]*><span class="says-words"><b>Snoozed<\/b>/)
  await post(`/t/cards/${card}/wake`, { stay: '1', quiet: '1' }, STREAM)
  await post(`/t/cards/${card}/shred`, { stay: '1', quiet: '1' }, STREAM)
  void stateOnce
}
