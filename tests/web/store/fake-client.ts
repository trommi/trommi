// fake-client.ts: the two smallest things tabs.ts can run as "the client", for the store and tabs tests only.
// Neither is the Trommi client: there is no engine, no hub and no real model behind them.
//
// - `openFake`: NO core. Its "device state" is a list of texts, one stored entry per text, written through the real
//   device store (store-idb.ts over the binding's IdbStore) one write at a time, as a Device writes. Its model is a
//   real empty model (model-shape.ts) whose `stack` lists the texts and whose `room.last_envelope_number` is the
//   store's revision, so a follower's copy can be compared with what is stored.
// - `openReal`: the REAL core's Device (the WASM binding) over the same store; its model only names the device and
//   its room.
import type { DeviceStore } from '../../../app/web/core/store-idb.ts'
import { emptyChange, emptyModel } from '../../../app/web/core/model-shape.ts'
import type { ClientLike } from '../../../app/web/core/tabs.ts'
import type { StoredState } from '../../../app/web/core/core-api.ts'
import type { Change, Model } from '../../../app/web/core/types.ts'
import type * as Binding from '../../../core/wasm/js/trommi-core.js'

const utf8 = new TextEncoder(), text = new TextDecoder()
export const hex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, '0')).join('')
/** The key of the n-th text: four bytes, big-endian. */
export const keyOf = (n: number): Uint8Array => new Uint8Array([n >>> 24, n >>> 16, n >>> 8, n])
const numberOf = (key: Uint8Array): number => new DataView(key.buffer, key.byteOffset).getUint32(0)

/** What both fakes share: a model and its listeners. */
function base(name: string) {
  const model: Model = emptyModel()
  model.room.room_id = name
  const listeners = new Map<string, Set<(data: any) => void>>()
  const emit = (event: string, data?: unknown) => { for (const fn of [...(listeners.get(event) ?? [])]) fn(data) }
  const on = (event: string, fn: (data: any) => void) => {
    let set = listeners.get(event)
    if (!set) listeners.set(event, set = new Set())
    set.add(fn)
    return () => { set.delete(fn) }
  }
  const changed = () => { const c: Change = emptyChange(); c.stack = true; c.room = true; emit('change', c) }
  return { model, emit, on, changed }
}

export interface FakeClient extends ClientLike {
  /** How often each method ran in this client. */
  ran: Record<string, number>
}

/** The fake over a loaded store; null when nothing is stored and `create` is not set (the caller closes the store). */
export function openFake(name: string, store: DeviceStore, stored: StoredState, { create = false }: { create?: boolean } = {}): FakeClient | null {
  if (!stored.entries.length && !create) return null
  let revision = stored.revision
  const { model, emit, on, changed } = base(name)
  model.room.last_envelope_number = revision
  model.stack = stored.entries.slice().sort((a, b) => numberOf(a.key) - numberOf(b.key)).map(e => text.decode(e.value))
  const ran: Record<string, number> = {}
  const count = (method: string) => { ran[method] = (ran[method] ?? 0) + 1 }

  // One write after another, as a Device makes them: the next text's key is chosen when its turn has come.
  let tail: Promise<unknown> = Promise.resolve()
  const seal = (what: string): Promise<string> => {
    const job = tail.then(async () => {
      await store.apply({ expectedRevision: revision, put: [{ key: keyOf(model.stack.length), value: utf8.encode(what) }], delete: [] })
      revision++   // (durable before the result is used)
      model.stack.push(what)
      model.room.last_envelope_number = revision
      changed()
      return what.toUpperCase()
    })
    tail = job.catch(() => {})
    return job
  }

  const client: FakeClient = {
    model, ran, on,
    stop() { return store.close() },
    echo(value: unknown) { count('echo'); return value },
    fail() { count('fail'); throw Object.assign(new Error('the fake refuses'), { code: 'fake-refusal', status: 418 }) },
    uncloneable() { count('uncloneable'); return () => {} },
    async slow(ms: number) { count('slow'); await new Promise(r => setTimeout(r, ms)); return ran['slow'] },
    /** A change of the model that is not stored. */
    poke(what: string) { count('poke'); model.stack.push(what); changed(); return null },
    alert(what: string) { emit('alert', { what }); return null },
    seal(what: string) { count('seal'); return seal(what) },
    /** Seals durably and then never answers: the owner that went between the write and the answer. */
    async sealAndHang(what: string) { count('sealAndHang'); await seal(what); return new Promise(() => {}) },
    /** What the engine says when its Device closed itself (a failed write, or another owner wrote). */
    deviceClosed() { emit('device-closed'); return null },
  }
  return client
}

/** The real core's Device over a loaded store: created when the store is empty, else opened from what is stored. */
export async function openReal(core: typeof Binding, name: string, store: DeviceStore, stored: StoredState): Promise<ClientLike> {
  const device = stored.entries.length ? await core.Device.open(store) : await core.Device.create(store)
  const { model, on, changed } = base(name)
  const refresh = async () => {
    const room = await device.room()
    model.room.my_device_id = hex(await device.id())
    model.room.room_id = room ? hex(room) : null
    model.stack = (await device.outbox()).map(entry => entry.kind)
  }
  await refresh()
  return {
    model, on,
    async stop() { await device.close() },
    async foundRoom() {
      const room = await device.foundRoom(core.generateRecoveryCode(), Date.now())
      await refresh()
      changed()
      return hex(room)
    },
  }
}
