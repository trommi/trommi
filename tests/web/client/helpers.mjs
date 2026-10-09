// helpers.mjs: what the client tests share. Everything here runs in Node against the STAND-IN core
// (tests/web/stand-in/core.ts: the real WASM binding for devices, groups and files; plain JSON for stored content and
// invites) and the FAKE hub (tests/web/stand-in/hub.mjs: no cryptography). Nothing here is evidence against a hub.
import { startFakeHub } from '../stand-in/hub.mjs'
import { hubReaders, loadBinding, standInCore } from '../stand-in/core.ts'
import { Hub } from '../../../app/web/core/hub.ts'
import { roomsOn } from '../../../app/web/core/room.ts'
import { AgentHub, AgentStandIn } from '../stand-in/agent.ts'
import assert from 'node:assert/strict'

/** What survives a "restart" in a test: name -> { revision, entries, owned }. */
const disk = new Map()
const keyOf = bytes => Buffer.from(bytes).toString('hex')

/** A store in memory with the core's contract (as tests/bindings/stores.mjs), whose `load` may be called twice like
 *  the app's store (store-idb.ts). One owner at a time, by a flag that stands for the lock. */
export class MemoryStore {
  #state = null
  #loaded = null
  constructor(name) { this.name = name }
  load() {
    return this.#loaded ??= (async () => {
      const state = disk.get(this.name) ?? { revision: 0, entries: new Map(), owned: false }
      if (state.owned) throw Object.assign(new Error('another owner has this state open'), { name: 'StoreConflict' })
      state.owned = true
      disk.set(this.name, state)
      this.#state = state
      return { revision: state.revision, entries: [...state.entries.values()].map(({ key, value }) => ({ key: key.slice(), value: value.slice() })) }
    })()
  }
  async apply(write) {
    const state = this.#state
    if (!state || state.revision !== write.expectedRevision) throw Object.assign(new Error('another owner wrote to this state'), { name: 'StoreConflict' })
    if (failing.has(this.name)) { const left = failing.get(this.name) - 1; if (left <= 0) { failing.delete(this.name); throw new Error('the disk is full') } failing.set(this.name, left) }
    for (const key of write.delete) state.entries.delete(keyOf(key))
    for (const { key, value } of write.put) state.entries.set(keyOf(key), { key: key.slice(), value: value.slice() })
    state.revision += 1
  }
  close() { if (this.#state) this.#state.owned = false; this.#state = null; this.#loaded = null }
}
const failing = new Map()
/** The `nth` write from now to the store `name` fails, writing nothing (1: the next one). */
export const failWrite = (name, nth = 1) => failing.set(name, nth)
export const stored = name => disk.get(name)
export const wipe = name => { for (const k of [...disk.keys()]) if (k === name || k.startsWith(`${name}:`)) disk.delete(k) }

/** The app's cache (store-idb.ts `Cache`) in memory. */
const caches = new Map()
export function memoryCache(name) {
  const map = caches.get(name) ?? new Map()
  caches.set(name, map)
  return {
    async get(key) { return structuredClone(map.get(key)) },
    async set(key, value) { map.set(key, structuredClone(value)) },
    async delete(key) { map.delete(key) },
    async setMany(entries) { for (const [key, value] of entries) { if (value === undefined) map.delete(key); else map.set(key, structuredClone(value)) } },
    async range(prefix, { after, before, limit, reverse = false } = {}) {
      let keys = [...map.keys()].filter(k => k.startsWith(prefix) && (after === undefined || k > after) && (before === undefined || k < before)).sort()
      if (reverse) keys.reverse()
      if (limit !== undefined) keys = keys.slice(0, limit)
      return keys.map(k => [k, structuredClone(map.get(k))])
    },
    close() {},
  }
}

let binding = null
/** The stand-in core, loaded once per process. */
export async function core() {
  binding ??= await loadBinding()
  return standInCore(binding, { stateStore: store => new MemoryStore(`${store.name}:stand-in`) })
}

/** Waits short enough for a test (the product's are seconds to minutes). */
export const TIMING = { heal_delay: 40, backoff_first: 30, backoff_max: 300, blocked_retry: 300, halted_retry: 200 }
/** room.ts on the stand-in core, memory stores and a memory cache: `foundRoom`, `openRoom`, `joinRoom`, `joinWithCode`.
 *  `agent`: with the hub client an agent device needs on the fake hub (stand-in/agent.ts `AgentHub`). */
export async function rooms({ agent = false, timing = {} } = {}) {
  const c = await core()
  return roomsOn({
    core: async () => c,
    store: name => new MemoryStore(name),
    cache: async name => memoryCache(name),
    destroy: async name => { wipe(name); caches.delete(name) },
    timing: { ...TIMING, ...timing },
    // the hub client's waits, shortened like the engine's
    hub: opts => Object.assign(agent ? new AgentHub(opts) : new Hub(opts), { timing: { ...new Hub(opts).timing, get_retry: [20, 40], backoff_first: 30, backoff_max: 200, stream_stood: 50 } }),
  })
}

/** A fake hub that reads the stand-in's bytes; closed when the test ends. */
export async function hub(t, opts = {}) {
  const fake = await startFakeHub({ ...opts, readers: { ...hubReaders, ...opts.readers } })
  t.after(() => fake.close())
  return fake
}

export const sleep = ms => new Promise(r => setTimeout(r, ms))
/** Waits until `check()` is truthy; fails with `what` after `ms`. */
export async function until(check, what, ms = 8000) {
  const end = Date.now() + ms
  for (;;) {
    const got = await check()
    if (got) return got
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(15)
  }
}
let names = 0
/** A fresh storage name per device of a test. */
export const storage = (label = 'device') => ({ name: `${label}-${++names}-${process.pid}` })

/** Lets a new human device in by an invite link of `inviter`; both sides must show the same six numbers. */
export async function addHuman(t, R, inviter, label = 'b', { stream = true } = {}) {
  const invite = await inviter.createInvite({ device_role: 'human', app_url: 'https://app.example/join' })
  const name = storage(label)
  const joining = R.joinRoom({ link: invite.link, storage: name, poll_ms: 20, device_name: label })
  const code = await joining.check_code
  await until(() => inviter.model.invites.get(invite.invite_id)?.invite_state === 'confirm_code', 'the inviter sees the Request')
  assert.equal(inviter.model.invites.get(invite.invite_id).check_code, code, 'both sides show the same six numbers')
  await inviter.confirmInvite(invite.invite_id, true)
  const client = await joining.client
  t.after(() => client.stop().catch(() => {}))
  await client.start({ stream })
  // the inviter adds it to every live session (5.2.7) once its KeyPackages are at the hub
  await until(async () => { if (!stream) await client.catchUp().catch(() => {}); return [...inviter.model.sessions.values()].every(s => !s.group_id || client.model.sessions.get(s.session_id)?.group_id) }, 'the newcomer in every session')
  await inviter.settle()
  await client.settle()
  /** (for a test that opens the device again) */
  client.stored_as = name
  return client
}
/** Lets an agent stand-in in by an invite link of `inviter` (`more`: createInvite's options, e.g. a takeover). */
export async function addAgent(t, inviter, more = {}, label = 'agent') {
  const R = await rooms({ agent: true })
  const invite = await inviter.createInvite({ device_role: 'agent', app_url: 'https://app.example/join', ...more })
  const joining = R.joinRoom({ link: invite.link, storage: storage(label), poll_ms: 20 })
  const code = await joining.check_code
  await until(() => inviter.model.invites.get(invite.invite_id)?.invite_state === 'confirm_code', 'the inviter sees the agent\'s Request')
  assert.equal(inviter.model.invites.get(invite.invite_id).check_code, code)
  await inviter.confirmInvite(invite.invite_id, true)
  const client = await joining.client
  t.after(() => client.stop().catch(() => {}))
  const agent = new AgentStandIn(client)
  await client.start()
  await client.settle()
  await inviter.settle()
  return agent
}
/** A room with its founder `a` started; `second`: a human device `b`; `agent`: an agent stand-in with its session. */
export async function scene(t, { second = false, agent = false, timing = {} } = {}) {
  const fake = await hub(t), R = await rooms({ timing })
  const name = storage('a')
  const { client: a, recovery_code } = await R.foundRoom({ storage: name, hub_url: fake.url, device_name: 'a' })
  t.after(() => a.stop().catch(() => {}))
  await a.start()
  const out = { fake, R, a, recovery_code, name }
  if (agent) out.agent = await addAgent(t, a)
  if (second) out.b = await addHuman(t, R, a, 'b')
  return out
}

const plain = v => JSON.parse(JSON.stringify(v ?? null))
/** What two human devices of a room must agree on, of one model: cards, permission requests, sessions, notes,
 *  room registers, members, and the items their timelines both hold. */
export function shared(model) {
  const pick = (map, fn) => Object.fromEntries([...map].filter(([, v]) => !v.pending).map(([k, v]) => [k, fn(v)]).sort(([x], [y]) => (x < y ? -1 : 1)))
  return {
    cards: pick(model.cards, c => plain({ state: c.object_state, title: c.title, version: c.version_hash, versions: c.versions.length, answer: c.answer?.envelope_hash ?? null, closed_how: c.closed_how, urgency: c.urgency, session: c.session_id, owner: c.agent_device_id })),
    permissions: pick(model.permissions, p => plain({ state: p.permission_state, tool: p.tool_name, verdict: p.verdict?.allow ?? null })),
    sessions: pick(model.sessions, s => plain({ group: s.group_id, agent: s.agent_device_id, agents: [...s.agent_device_ids].sort(), active: s.is_active, stale: s.stale, settings: s.settings, profile: s.profile, lines: s.status_lines.map(l => [l.id, l.label, l.state]) })),
    notes: pick(model.notes, n => plain({ text: n.text, version: n.version_hash, state: n.object_state })),
    registers: pick(model.human.raw, r => plain(r.value)),
    members: pick(model.members, m => plain({ role: m.device_role, active: m.is_active, name: m.device_name })),
    stack: [...model.stack],
  }
}
/** Fails unless the two models agree on everything `shared` names, and on every timeline item both hold. */
export function modelsAgree(x, y, what = 'the two devices') {
  assert.deepEqual(shared(x), shared(y), `${what} disagree`)
  for (const [key, t] of x.timelines) {
    const other = y.timelines.get(key)
    if (!other) continue
    for (const [n, item] of t.items) {
      const twin = typeof n === 'number' ? other.items.get(n) : null
      if (twin?.content && item.content && !item.content.work) assert.deepEqual(plain(item.content), plain(twin.content), `${what} disagree on item ${n} of ${key}`)
    }
  }
}
