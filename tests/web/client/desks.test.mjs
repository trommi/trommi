// The first desk of every account (spec/v1.md 9.3.3): "Personal", `desk/main`, written by a human device when it
// founds the room and whenever it finds no desk; the last desk is never removed. STAND-IN core, FAKE hub.
import test from 'node:test'
import assert from 'node:assert/strict'
import { addHuman, scene, until } from './helpers.mjs'

test('every account has a desk from its creation on: "Personal" (desk/main); two devices make one; the last one stays', async t => {
  const { R, a } = await scene(t)
  await until(() => a.model.human.desks.get('main')?.name === 'Personal', 'the first desk on the founding device')
  assert.deepEqual([...a.model.human.desks].filter(([, v]) => v).map(([id, v]) => [id, v.name, v.created_at]), [['main', 'Personal', 0]])
  const b = await addHuman(t, R, a, 'b')
  await a.settle(); await b.settle()
  assert.deepEqual([...b.model.human.desks].filter(([, v]) => v).map(([id]) => id), ['main'], 'the device that joined sees the one desk, and made no second')
  // both find no desk at the same moment (the list emptied by a hub-side loss is stood in for by writing it away
  // below the guard): each writes the same register
  await a.setRegisters({ 'desk/main': null }); await a.settle(); await b.settle()
  await Promise.all([a.ensureDesk(), b.ensureDesk()])
  await a.settle(); await b.settle(); await a.settle()
  for (const c of [a, b]) assert.deepEqual([...c.model.human.desks].filter(([, v]) => v).map(([id, v]) => [id, v.name]), [['main', 'Personal']])
  await assert.rejects(a.setDesk('main', null), e => e.code === 'last-desk', 'the last desk is not removed')
  await a.setDesk('11'.repeat(16), { name: 'Work', created_at: 1 })
  await a.settle()
  await a.setDesk('main', null)
  await a.settle()
  await assert.rejects(a.setDesk('11'.repeat(16), null), e => e.code === 'last-desk', 'nor the one left after another went')
})
