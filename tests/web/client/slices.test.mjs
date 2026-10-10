// A room older than one slice: more Commits in the room group than the core takes in one call (256). A join with
// the code, a recovery (8.7) and the past a device that joined by link learns all read the hub's logs page by page
// and hand them to the core's walks in steps; a slice the core refuses `too-large` is halved. STAND-IN core (the
// real binding), FAKE hub.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Hub } from '../../../app/web/core/hub.ts'
import { roomsOn } from '../../../app/web/core/room.ts'
import { SLICE } from '../../../app/web/core/slices.ts'
import { MemoryStore, TIMING, addHuman, core, memoryCache, scene, storage, until, wipe } from './helpers.mjs'

const OLD = 300

/** Ages the room: `count` forced updates of the room group by `a`, each one Commit taken by the hub. */
async function age(a, count = OLD) {
  const room = Buffer.from(a.model.room.room_id, 'hex')
  for (let i = 0; i < count; i++) await a.engine.land(d => d.update(new Uint8Array(room), true, Date.now()))
  await a.settle()
}
const commitPages = (fake, since) => fake.requests.slice(since).filter(r => /\/log$/.test(r.path) && r.query?.kind === 'commit')

/** room.ts on the stand-in core, every device wrapped to write down its walk calls: [name, items, refusal]. */
async function counted() {
  const base = await core(), calls = []
  const wrap = device => new Proxy(device, {
    get(target, name) {
      const f = target[name]
      if (typeof f !== 'function' || !/Slice$/.test(String(name))) return f
      return async (...args) => {
        const items = args.find(Array.isArray)?.length ?? 0
        try { const out = await f.apply(target, args); calls.push([name, items, null]); return out } catch (e) { calls.push([name, items, e.code]); throw e }
      }
    },
  })
  const R = roomsOn({
    core: async () => ({ ...base, createDevice: async store => wrap(await base.createDevice(store)) }),
    store: name => new MemoryStore(name),
    cache: async name => memoryCache(name),
    destroy: async name => { wipe(name) },
    timing: TIMING,
    hub: opts => Object.assign(new Hub(opts), { timing: { ...new Hub(opts).timing, get_retry: [20, 40], backoff_first: 30, backoff_max: 200, stream_stood: 50 } }),
  })
  return { R, calls }
}

test('a room older than one slice: a new device signs in with the code, in slices, and reads the history', async t => {
  const { fake, a, agent, recovery_code } = await scene(t, { agent: true })
  const note = await a.saveNote({ text: 'written before the room grew old' })
  await a.settle(); await agent.settle()
  await age(a)
  const { R, calls } = await counted()
  const since = fake.requests.length
  const { client: c } = await R.joinWithCode({ storage: storage('c'), hub_url: fake.url, room_id: a.model.room.room_id, code: recovery_code, device_name: 'c' })
  t.after(() => c.stop().catch(() => {}))
  assert.ok(commitPages(fake, since).length >= 2, 'the room group\'s log was read in pages')
  const room = calls.filter(([name]) => name === 'codeCheckSlice')
  assert.ok(room.length >= 2 && room.every(([, n, code]) => n <= 256 && code === null), `the room was checked in slices: ${JSON.stringify(room)}`)
  assert.ok(room.reduce((n, [, k]) => n + k, 0) > OLD)
  assert.ok(calls.some(([name, , code]) => name === 'sessionCheckSlice' && code === null), 'the session was checked in slices')
  await c.start()
  await c.settle(); await a.settle()
  assert.equal(a.model.members.get(c.my_device_id)?.device_role, 'human')
  assert.ok(c.model.sessions.get(agent.session_id)?.group_id, 'it joined the session with the code too')
  await until(() => c.model.notes.get(note)?.text === 'written before the room grew old', 'the room\'s history')
})

test('a room older than one slice: the recovery of 8.7 removes the lost device and replaces the code', async t => {
  const { fake, a, agent, recovery_code } = await scene(t, { agent: true })
  const note = await a.saveNote({ text: 'written by the device that is lost' })
  await a.settle(); await agent.settle()
  await age(a)
  const lost = a.my_device_id, room_id = a.model.room.room_id
  await a.stop()
  const { R, calls } = await counted()
  let new_code = null
  const { client: c } = await R.joinWithCode({ storage: storage('c'), hub_url: fake.url, room_id, code: recovery_code, recover: true, device_name: 'c', account: code => { new_code = code.slice(); return null } })
  t.after(() => c.stop().catch(() => {}))
  for (const name of ['recoveryPlanSlice', 'codeCheckSlice']) {
    const slices = calls.filter(([n]) => n === name)
    assert.ok(slices.length >= 2 && slices.every(([, k, code]) => k <= 256 && code === null), `${name} in slices: ${JSON.stringify(slices)}`)
  }
  assert.equal([...fake.state.rooms.values()][0].devices.has(Buffer.from(lost, 'hex').toString('base64url')), false, 'the lost device is out')
  await c.start()
  await c.settle()
  await until(() => c.model.notes.get(note)?.text === 'written by the device that is lost', 'the room\'s history')
  await c.checkRecoveryCode(new_code)
  await assert.rejects(c.checkRecoveryCode(recovery_code), { code: 'wrong-recovery' })
})

test('a room older than one slice: a device that joined by link learns the room group\'s past in slices', async t => {
  const { fake, a } = await scene(t)
  await age(a)
  const { R, calls } = await counted()
  const since = fake.requests.length
  const b = await addHuman(t, R, a, 'b')
  const group = new Uint8Array(Buffer.from(b.model.room.room_id, 'hex'))
  await until(async () => (await b.engine.device.groupPast(group))?.learned === true, 'the room group\'s past learned', 20_000)
  const past = await b.engine.device.groupPast(group)
  assert.ok(past.fromEpoch > 256, `its own knowledge begins after more than one slice (${past.fromEpoch})`)
  assert.ok(commitPages(fake, since).filter(r => r.path.includes(Buffer.from(group).toString('base64url'))).length >= 2, 'the log was read in pages')
  const slices = calls.filter(([name]) => name === 'learnSlice')
  assert.ok(slices.length >= 2 && slices.every(([, n, code]) => n <= 256 && code === null), `learned in slices: ${JSON.stringify(slices)}`)
})

test('a slice the core refuses too-large is halved and handed again: the walk stands', async t => {
  const { fake, a, recovery_code } = await scene(t)
  await age(a)
  const { R, calls } = await counted()
  // slices larger than the core takes: the first one is refused, its halves are not
  const before = { ...SLICE }
  SLICE.commits = 600
  t.after(() => Object.assign(SLICE, before))
  const { client: c } = await R.joinWithCode({ storage: storage('c'), hub_url: fake.url, room_id: a.model.room.room_id, code: recovery_code, device_name: 'c' })
  t.after(() => c.stop().catch(() => {}))
  const room = calls.filter(([name]) => name === 'codeCheckSlice')
  assert.equal(room[0][2], 'too-large', `the first slice was refused: ${JSON.stringify(room)}`)
  assert.ok(room[0][1] > 256)
  assert.deepEqual(room.slice(1).map(([, n, code]) => [n <= 256, code]), room.slice(1).map(() => [true, null]), 'its halves were taken')
  assert.equal(room.slice(1).reduce((n, [, k]) => n + k, 0), room[0][1], 'the halves are the slice, nothing skipped or handed twice')
  await c.start()
  await c.settle(); await a.settle()
  assert.equal(a.model.members.get(c.my_device_id)?.device_role, 'human')
})
