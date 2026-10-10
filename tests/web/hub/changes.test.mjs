// Catch-up (`GET /v1/changes`) against the fake hub: pages in the hub's order, and a hub that serves anything else.
import test from 'node:test'
import assert from 'node:assert/strict'
import { scene, received, envelope, utf8, txt } from './helpers.mjs'

async function fill(hub, room_id, device, n) {
  for (let seq = 1; seq <= n; seq++) await hub.postEnvelope(envelope(room_id, device, seq))
}

test('pages come in the hub\'s order, each from the cursor of the one before, to the end', async t => {
  const { fake, hub, room_id, device } = await scene(t)
  await fill(hub, room_id, device, 7)
  await hub.postCommit(room_id, { epoch: 0, commit: utf8('c1'), group_info: utf8('i1'), sealed_key: utf8('s1') })
  await hub.postMessage(room_id, 1, utf8('m1'), false)
  const seen = []
  let cursor = 0, pages = 0
  for (;;) {
    const page = await hub.changes(cursor, 4)
    pages += 1
    assert.ok(page.items.length <= 4)
    seen.push(...page.items)
    cursor = page.change
    if (!page.more) break
  }
  assert.equal(pages, 3)
  assert.deepEqual(seen.map(i => i.change), [1, 2, 3, 4, 5, 6, 7, 8, 10], 'change 9 is the Commit\'s SealedKey: read on its own route')
  assert.deepEqual(seen.map(i => i.kind), [...Array(7).fill('envelope'), 'commit', 'message'])
  assert.equal(cursor, fake.state.rooms.get(txt(room_id)).change)
  assert.deepEqual(received(fake, '/v1/changes').map(r => r.query), [{ after: '0', limit: '4' }, { after: '4', limit: '4' }, { after: '8', limit: '4' }])
  const commit = seen[7]
  assert.deepEqual([commit.group, commit.n, commit.epoch, commit.sender, commit.recovery_auth], [room_id, 1, 0, device, null])
  assert.deepEqual(commit.bytes, utf8('c1'))
  assert.ok(seen[0].envelope instanceof Uint8Array)
  assert.equal(seen[0].void_code, null)
  assert.deepEqual(await hub.changes(cursor), { items: [], change: cursor, more: false })
})

const hostile = {
  'descending changes': a => ({ ...a, items: [a.items[1], a.items[0], ...a.items.slice(2)] }),
  'the same change twice': a => ({ ...a, items: [a.items[0], a.items[0]] }),
  'a change at or below the cursor asked for': a => ({ ...a, items: [{ ...a.items[0], change: 0 }] }),
  'an item above the answer\'s cursor': a => ({ ...a, change: 2 }),
  'a cursor that goes back': a => ({ items: [], change: -1, more: false }),
  'a cursor far beyond the stretch': a => ({ items: [], change: 5_000_000, more: false }),
  'more to come, and no step': () => ({ items: [], change: 0, more: true }),
  'more items than asked for': a => ({ ...a, items: Array.from({ length: 6 }, (_, i) => ({ ...a.items[0], change: i + 1 })), change: 6 }),
  'a change that is no number': a => ({ ...a, items: [{ ...a.items[0], change: '1' }] }),
  'a change beyond 2^53': a => ({ ...a, items: [{ ...a.items[0], change: 2 ** 53 }], change: 2 ** 53 }),
  'an envelope that is not canonical base64url': a => ({ ...a, items: [{ ...a.items[0], envelope: a.items[0].envelope + '=' }] }),
  'base64url with stray bits': a => ({ ...a, items: [{ ...a.items[0], envelope: 'AB' }] }),
  'standard base64 instead of base64url': a => ({ ...a, items: [{ ...a.items[0], envelope: '+/+/' }] }),
  'an envelope that is an object': a => ({ ...a, items: [{ ...a.items[0], envelope: { length: 4 } }] }),
  'an empty envelope': a => ({ ...a, items: [{ ...a.items[0], envelope: '' }] }),
  'an envelope larger than any envelope': a => ({ ...a, items: [{ ...a.items[0], envelope: 'A'.repeat(200_000) }] }),
  'an unknown kind': a => ({ ...a, items: [{ ...a.items[0], kind: 'grant' }] }),
  'a log entry with a group id of the wrong length': a => ({ ...a, items: [{ change: 1, kind: 'commit', group_id: 'AAAA', n: 1, epoch: 0, at: 1, bytes: 'AAAA', sender: a.items[0].envelope }] }),
  'a void code that is no code': a => ({ ...a, items: [{ ...a.items[0], void_code: '<script>' }] }),
  'items that are no list': a => ({ ...a, items: { length: 1, 0: a.items[0] } }),
  'more that is no boolean': a => ({ ...a, more: 'yes' }),
  'an answer that is a list': a => a.items,
  'null': () => null,
}
for (const [what, answer] of Object.entries(hostile)) {
  test(`a hub that serves ${what} is refused whole`, async t => {
    const { fake, hub, room_id, device } = await scene(t)
    await fill(hub, room_id, device, 3)
    fake.faults.add({ path: '/v1/changes', answer })
    await assert.rejects(hub.changes(0, 5), e => e.code === 'bad-answer' && e.transient && !e.voided)
    assert.equal((await hub.changes(0, 5)).items.length, 3, 'the honest answer is taken')
  })
}
