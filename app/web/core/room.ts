// room.ts: how a device comes to hold a room, and the `Client` over it: founding one, opening the stored one, joining
// by an invite link (spec/v2.md 12.1), signing in with the recovery code (8.4) and recovering with it (8.7). What
// account.ts and core-worker.ts call; they hold no key and no device themselves.
//
// Every function here returns a client that is NOT started (`client.start()` is the caller's). A step that fails
// leaves nothing stored: the device it made is closed and its stores are deleted, so the same step can be taken
// again. The recovery code is copied on the way in and the copy is overwritten when the step is over.
//
// Where the core, the device's store and the cache come from is one small record (`RoomEnv`). The product's is
// below: core-wasm.ts and store-idb.ts, loaded when first needed. Tests hand in another (the stand-in core over
// the real binding, stores in memory) through `roomsOn`; the product has no switch for that.
//
// The hub's address is not part of a device's state. It is kept in the cache (`client/room`, written durably when
// the room is made); a caller that knows it may pass `hub_url` to `openRoom` for a cache that was lost.
import { Client, ClientError, engineMeta } from './client.ts'
import type { Core, Device, ServedEnvelope, Store } from './core-api.ts'
import { Engine } from './engine.ts'
import type { EngineTiming } from './engine.ts'
import { accountCopiesBytes, Hub, HubError, hubAddress } from './hub.ts'
import type { AccountCopies, NewAccount } from './hub.ts'
import { b64u, hex, unb64u, unhex } from './ids.ts'
import type { Cache } from './store-idb.ts'

export interface DeviceOptions {
  storage: { name: string }
  client?: string | null; device_name?: string; device_info?: unknown; fetch?: typeof fetch | null
  /** The store on `storage.name`, loaded: for a caller that holds its lock already (tabs.ts `adoptInTabs`). The
   *  device made over it is then not opened again in place when it closes itself: that caller takes over. */
  store?: Store
}
/** Where a room's parts come from. */
export interface RoomEnv {
  core(): Promise<Core>
  /** A new store object on the device state `name`; `load()` takes its lock. */
  store(name: string): Store
  cache(name: string): Promise<Cache>
  /** Deletes everything stored under `name`. */
  destroy(name: string): Promise<void>
  /** Left out in the product. Tests: another hub client (one that also hands an agent device the room group's
   *  Commits, which the fake hub's catch-up leaves out), and shorter waits. */
  hub?(opts: { hub_url: string; client_name: string | null; fetch?: typeof fetch }): Hub
  timing?: Partial<EngineTiming>
}
export interface Joining { check_code: Promise<string>; client: Promise<Client>; cancel(): void }
export interface Rooms {
  foundRoom(o: DeviceOptions & { hub_url: string; recovery_code?: Uint8Array; found_token?: string | null; account?: ((room_id: Uint8Array) => Record<string, unknown> | Promise<Record<string, unknown>>) | null }): Promise<{ client: Client; recovery_code: Uint8Array }>
  /** null: nothing is stored. */
  openRoom(o: DeviceOptions & { hub_url?: string }): Promise<Client | null>
  /** The client over a store that is loaded already (tabs.ts holds its lock): null when it holds no room. Its
   *  device is not opened again in place when it closes itself; the client says `device-closed` and tabs.ts takes over. */
  openRoomOver(o: DeviceOptions & { hub_url?: string }, store: Store): Promise<Client | null>
  /** `check_code`: the six numbers both sides compare, 'nn-nn-nn-nn-nn-nn'. */
  joinRoom(o: DeviceOptions & { link: string; poll_ms?: number; timeout_ms?: number }): Joining
  /** Signs in on a new device with the code (8.4). With `recover` the recovery of 8.7: every other human device is
   *  removed and the code replaced; `account` is called exactly once with the new code, before anything is posted,
   *  and gives the account's new sealed copies (null: a room without an account). */
  joinWithCode(o: DeviceOptions & { hub_url: string; room_id: string; code: Uint8Array; recover?: boolean; account?: ((new_code: Uint8Array) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>) | null }): Promise<{ client: Client }>
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i])
const codeText = (numbers: readonly number[]): string => numbers.map(n => String(n).padStart(2, '0')).join('-')

export function roomsOn(env: RoomEnv): Rooms {
  const hubOf = (o: DeviceOptions, hub_url: string): Hub => {
    const opts = { hub_url, client_name: o.client ?? null, ...(o.fetch ? { fetch: o.fetch } : {}) }
    return env.hub ? env.hub(opts) : new Hub(opts)
  }
  const timing = env.timing ? { timing: env.timing } : {}
  /** Where a device that closed itself is opened again: here, unless the caller holds the store's lock itself. */
  const again = (o: DeviceOptions): { store?: () => Store } => (o.store ? {} : { store: () => env.store(o.storage.name) })

  /** A new device in an empty store. A store that holds something is a room already: `room-exists`, nothing touched. */
  async function fresh(o: DeviceOptions, core: Core): Promise<Device> {
    const store = o.store ?? env.store(o.storage.name)
    let stored
    try { stored = await store.load() } catch (e) { await store.close?.(); throw e }
    if (stored.revision !== 0 || stored.entries.length) { await store.close?.(); throw new ClientError('room-exists', 'this browser holds an account already') }
    return core.createDevice(store)
  }
  /** Undoes a step that failed: the device it made holds nothing anyone else knows of. */
  async function discard(o: DeviceOptions, device: Device, engine: Engine | null): Promise<void> {
    if (engine) await engine.stop().catch(() => {}); else await device.close().catch(() => {})
    await env.destroy(o.storage.name).catch(() => {})
  }
  async function clientOf(o: DeviceOptions, core: Core, hub: Hub, engine: Engine, cache: Cache): Promise<Client> {
    return new Client({ core, hub, engine, cache, ...(o.device_name ? { device_name: o.device_name } : {}), ...(o.device_info !== undefined ? { device_info: o.device_info } : {}) }).open()
  }
  /** Posts everything in the outbox now, in order: a step's own posts, whose failure is the step's. An entry the
   *  hub did not answer is the same bytes again, a few times (the hub answers a repeated post like the first). */
  async function postAll(engine: Engine): Promise<void> {
    for (let tries = 0; (await engine.outbox()).length;) {
      try { await engine.postHead(); tries = 0 } catch (e) {
        if (!(e instanceof HubError) || !e.transient || ++tries > 4) throw e
        await sleep(300 * 2 ** tries)
      }
    }
  }
  /** Whether a failed post may have reached the hub all the same: its answer was lost, or the hub was busy. */
  const uncertain = (e: unknown): boolean => e instanceof HubError && e.transient

  async function foundRoom(o: Parameters<Rooms['foundRoom']>[0]): Promise<{ client: Client; recovery_code: Uint8Array }> {
    const core = await env.core()
    const hub = hubOf(o, o.hub_url)
    const device = await fresh(o, core)
    let engine: Engine | null = null, posting = false
    const code = o.recovery_code ? o.recovery_code.slice() : core.generateRecoveryCode()
    try {
      const room_id = await device.foundRoom(code, Date.now())
      // the account's sealed copies bind the room id: they are made now, before the founding is posted
      const account = o.account ? await o.account(room_id) as unknown as NewAccount : null
      const cache = await env.cache(o.storage.name)
      await cache.set('client/room', { hub_url: hub.hub_url }, { durable: true })
      engine = new Engine({ core, hub, meta: engineMeta(cache), ...again(o), ...timing }, device)
      const founding = (await engine.outbox()).find(e => e.kind === 'roomFounding') ?? (() => { throw new ClientError('internal', 'the core made no founding') })()
      await engine.attach(founding.id, { account, found_token: o.found_token ?? null })
      posting = true
      await postAll(engine)
      await engine.load()
      return { client: await clientOf(o, core, hub, engine, cache), recovery_code: code }
    } catch (e) {
      code.fill(0)
      // A founding the hub may have taken (its answers were lost) is NOT thrown away: the device and its outbox
      // stay, with the account that goes with them, and the next start of this stored room posts the same bytes
      // again. Everything else leaves nothing stored.
      if (posting && uncertain(e)) { if (engine) await engine.stop().catch(() => {}); else await device.close().catch(() => {}) }
      else await discard(o, device, engine)
      throw e
    }
  }

  async function over(o: DeviceOptions & { hub_url?: string }, store: Store, reopen: boolean): Promise<Client | null> {
    let stored
    try { stored = await store.load() } catch (e) { await store.close?.(); throw e }
    if (stored.revision === 0 && !stored.entries.length) { await store.close?.(); return null }
    const core = await env.core()
    const device = await core.openDevice(store)
    try {
      // a device that never came to hold a room (a join that was given up) is nothing to open
      if (!(await device.room()) && !(await device.groups()).length) { await device.close(); return null }
      const cache = await env.cache(o.storage.name)
      const kept = (await cache.get('client/room')) as { hub_url?: string } | undefined
      const hub_url = kept?.hub_url ?? o.hub_url ?? (() => { throw new ClientError('no-hub', 'this device no longer knows its hub\'s address') })()
      const hub = hubOf(o, hub_url)
      const engine = new Engine({ core, hub, meta: engineMeta(cache), ...(reopen ? { store: () => env.store(o.storage.name) } : {}), ...timing }, device)
      await engine.load()
      return await clientOf(o, core, hub, engine, cache)
    } catch (e) { await device.close().catch(() => {}); throw e }
  }

  function joinRoom(o: Parameters<Rooms['joinRoom']>[0]): Joining {
    const poll = o.poll_ms ?? 800, until = Date.now() + (o.timeout_ms ?? 15 * 60_000)
    let cancelled = false
    let tellCode: (code: string) => void = () => {}, failCode: (e: unknown) => void = () => {}
    const check_code = new Promise<string>((resolve, reject) => { tellCode = resolve; failCode = reject })
    check_code.catch(() => {})
    const wait = async (): Promise<void> => {
      if (cancelled) throw new ClientError('cancelled', 'joining was given up')
      if (Date.now() > until) throw new ClientError('invite-expired', 'nobody confirmed this device in time')
      await sleep(poll)
    }
    const client = (async (): Promise<Client> => {
      const core = await env.core()
      const link = core.inviteLinkParse(o.link)
      const hub = hubOf(o, link.hub)
      const device = await fresh(o, core)
      let engine: Engine | null = null
      try {
        const invite = await hub.getInvite(link.inviteId)
        const request = await device.joinRequest(o.link, { offer: invite.offer, signature: invite.signature }, Date.now())
        await hub.postInviteRequest(link.inviteId, { request: request.request, mac: request.mac, signature: request.signature })
        // the inviter's Reveal: with it both sides hold the same six numbers
        let reveal = null
        while (!reveal) {
          try { reveal = await hub.getReveal(link.inviteId) } catch (e) { if (!(e instanceof HubError) || (e.code !== 'not-found' && !e.transient)) throw e; await wait() }
        }
        tellCode(codeText([...(await device.joinReveal(reveal)).numbers]))
        // Let in once the person confirmed on the inviter's side: from then on the hub knows this device's key.
        hub.useSigner(link.roomId, (address, challenge) => device.hubSignIn(address, challenge))
        for (;;) {
          try { await hub.signIn(); break } catch (e) {
            if (!(e instanceof HubError) || (e.code !== 'not-member' && !e.transient)) throw e
            // "They don't match" burns the invite: the hub says so on the invite's own route
            try { await hub.getReveal(link.inviteId) } catch (burned) { if (burned instanceof HubError && burned.code === 'invite-burned') throw new ClientError('code-mismatch', 'the other device said the codes do not match') }
            await wait()
          }
        }
        if (request.role === 'agent') {
          // an agent device follows the room group from the epoch the Offer names (12.1.6)
          const info = await hub.groupInfo(core.roomGroupId(link.roomId), request.roomEpoch)
          await device.joinObserve(info.group_info)
        }
        const cache = await env.cache(o.storage.name)
        await cache.set('client/room', { hub_url: hub.hub_url }, { durable: true })
        engine = new Engine({ core, hub, meta: engineMeta(cache), ...again(o), ...timing }, device)
        await engine.load(link.roomId)
        // The Welcome: into the room group for a human device, into its session for an agent; committed by the inviter.
        const inside = (): boolean => (request.role === 'human' ? engine!.is_human : engine!.groups.some(g => g.session !== null))
        while (!inside()) { if (!(await engine.joinNow(request.inviter)) || !inside()) await wait() }
        return await clientOf(o, core, hub, engine, cache)
      } catch (e) {
        failCode(e)
        await discard(o, device, engine)
        throw e
      }
    })()
    client.catch(() => {})
    return { check_code, client, cancel() { cancelled = true } }
  }

  async function joinWithCode(o: Parameters<Rooms['joinWithCode']>[0]): Promise<{ client: Client }> {
    const core = await env.core()
    const room = unhex(o.room_id), code = o.code.slice()
    const hub = hubOf(o, o.hub_url)
    let device: Device | null = null, engine: Engine | null = null
    try {
      device = await fresh(o, core)
      const held = device
      // under the recovery key's token: it reads what a join needs and posts the join's Commits (12.3.2)
      hub.useSigner(room, async (address, challenge) => core.recoverySignIn(code, room, address, challenge))
      const cache = await env.cache(o.storage.name)
      await cache.set('client/room', { hub_url: hub.hub_url }, { durable: true })
      engine = new Engine({ core, hub, meta: engineMeta(cache), ...again(o), ...timing }, device)
      if (o.recover) {
        // The new code is made, and the account's copies of it (or the person's own copy: the caller's `account`
        // resolves once the code is on their screen), BEFORE the recovery is opened: the hub locks the room for
        // ten minutes from then on, and nothing of a recovery is posted for a code nobody holds.
        const { served } = await hub.servedRoom({ anchorOf: rows => core.recoveryAnchor(code, room, rows) })
        const plan = await held.prepareRecovery(code, served)
        let copies: Uint8Array
        try { copies = accountCopiesBytes(o.account ? await o.account(plan.newCode) as AccountCopies | null : null) } finally { plan.newCode.fill(0) }
        // A removed device's chain ends at its Cut for everyone (9.0.10). The core takes the Cuts itself, from
        // the chains as the hub serves them, each verified from number 1.
        const chains: ServedEnvelope[] = []
        for (const removal of plan.removals) for (const gone of removal.devices) {
          for (let after = 0, more = true; more;) {
            const page = await hub.chain(removal.group, gone, { after, limit: 500 })
            for (const link of page.items) { chains.push({ bytes: link.envelope, change: link.change, voidCode: link.void_code === null ? null : core.errorCodeFromText(link.void_code) ?? 'hub-voided-other' }); after = link.seq }
            more = page.more && page.items.length > 0
          }
        }
        const recovery = await hub.openRecovery()
        try {
          const done = await held.recover(code, served, chains, copies, Date.now())
          for (const id of done.outbox) await engine.attach(id, { recovery_id: recovery.recovery_id })
          await postAll(engine)
        } catch (e) { await hub.dropRecovery(recovery.recovery_id).catch(() => {}); throw e }
      } else {
        const { served } = await hub.servedRoom({ anchorOf: rows => core.recoveryAnchor(code, room, rows) })
        await held.joinRoomWithCode(code, served, Date.now())
        await postAll(engine)
        // every live session group, main sessions first (the order the hub client serves them in)
        for (const session of served.sessions) {
          await held.joinSessionWithCode(code, session, Date.now())
          await postAll(engine)
        }
      }
      await engine.load()
      // what the room holds from before is read once the hub's order was taken: a recovery took the removed
      // devices' chains already, and their envelopes are then read back
      await engine.wantRescan()
      return { client: await clientOf(o, core, hub, engine, cache) }
    } catch (e) {
      if (device) await discard(o, device, engine)
      throw e
    } finally { code.fill(0) }
  }

  return {
    foundRoom, joinRoom, joinWithCode,
    openRoom: o => over(o, env.store(o.storage.name), true),
    openRoomOver: (o, store) => over(o, store, false),
  }
}

/** The product's parts: the WASM core and IndexedDB, loaded when a room function first needs them. */
const product: RoomEnv = (() => {
  const wasm = () => import('./core-wasm.ts')
  const idb = () => import('./store-idb.ts')
  return {
    core: async () => (await wasm()).loadCore(),
    store(name: string): Store {
      // the store's modules are loaded by `load()`, the first thing anyone calls on a store
      let inner: Promise<Store> | null = null
      const open = (): Promise<Store> => inner ??= (async () => { const [{ IdbStore }, { openDeviceStore }] = await Promise.all([wasm(), idb()]); return openDeviceStore({ name, IdbStore }) })()
      return { load: async () => (await open()).load(), apply: async write => (await open()).apply(write), close: async () => { if (inner) await (await inner).close?.() } }
    },
    cache: async name => (await idb()).openCache(name),
    destroy: async name => { const [{ IdbStore }, { deleteStores }] = await Promise.all([wasm(), idb()]); await deleteStores({ name, IdbStore }) },
  }
})()
export const { foundRoom, openRoom, openRoomOver, joinRoom, joinWithCode } = roomsOn(product)

/** The address a fresh device needs to log in to a room by hand: `<app>#r1.<hub>.<room id>`, both base64url. Its
 *  form is the app's own and older than protocol v2; it names no secret. */
export function roomLink(hub_url: string, room_id: string, app = 'https://app.trommi.com/login'): string {
  return `${app}#r1.${b64u(new TextEncoder().encode(hubAddress(hub_url)))}.${b64u(unhex(room_id))}`
}
export function parseRoomLink(text: unknown): { hub_url: string; room_id: string } {
  const s = String(text).trim()
  const parts = (s.includes('#') ? s.slice(s.indexOf('#') + 1) : s).split('.')
  if (parts[0] !== 'r1' || parts.length !== 3) throw new ClientError('bad-format', 'not a room link')
  let room: Uint8Array, hub: string
  try { room = unb64u(parts[2]!); hub = hubAddress(new TextDecoder('utf-8', { fatal: true }).decode(unb64u(parts[1]!))) } catch { throw new ClientError('bad-format', 'not a room link') }
  if (room.length !== 32) throw new ClientError('bad-format', 'not a room link')
  return { hub_url: hub, room_id: hex(room) }
}
