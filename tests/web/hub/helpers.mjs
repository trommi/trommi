// helpers.mjs: what the hub client's tests share. A fake hub (tests/web/stand-in/hub.mjs, no cryptography) with one
// room and one human device, a Hub signed in to it, and the JSON "structs" the fake hub reads by default.
import { randomBytes } from 'node:crypto'
import { Hub } from '../../../app/web/core/hub.ts'
import { b64u } from '../../../app/web/core/ids.ts'
import { startFakeHub } from '../stand-in/hub.mjs'

/** A random id, as bytes; `txt` is its text in the hub's JSON, its paths and the fake hub's state. */
export const id = n => new Uint8Array(randomBytes(n))
export const txt = b64u
/** UTF-8 of a text, or of a value as JSON with every id in it as base64url. */
export const utf8 = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value, (_, v) => v instanceof Uint8Array ? b64u(v) : v))

/** A signer as the stand-in core's: HubAuth as JSON, any signature (the fake hub checks none). */
export function signer(room_id, device, calls = { n: 0 }) {
  return async (hub, challenge) => { calls.n += 1; return { auth: utf8({ room_id, hub, device, challenge }), signature: new Uint8Array(64) } }
}

/** An envelope of the stand-in kind: its header as JSON. */
export function envelope(group, sender, seq, more = {}) {
  return utf8({ group, sender, seq, kind: 'item', file_ids: [], ...more })
}

/** A fake hub with a room and a human device, and a client signed in as that device. Waits are short. */
export async function scene(t, opts = {}) {
  const fake = await startFakeHub(opts)
  t.after(() => fake.close())
  const room_id = id(32), device = id(32), signs = { n: 0 }
  const room = fake.seedRoom(txt(room_id), [txt(device)])
  const hub = client(fake, room_id, device, signs)
  return { fake, hub, room_id, device, signs, room }
}
export function client(fake, room_id, device, signs = { n: 0 }) {
  const hub = new Hub({ hub_url: fake.url, client_name: 'app/2.0.0' })
  Object.assign(hub.timing, { get_retry: [], backoff_first: 20, backoff_max: 160 })
  if (room_id) hub.useSigner(room_id, signer(room_id, device, signs))
  return hub
}
/** The requests the fake hub received on a path (a string or RegExp). */
export const received = (fake, path, method) => fake.requests.filter(r => (path instanceof RegExp ? path.test(r.path) : r.path === path) && (!method || r.method === method))
export const until = async (holds, ms = 3000) => {
  const end = Date.now() + ms
  while (!holds()) { if (Date.now() > end) throw new Error('waited in vain'); await new Promise(r => setTimeout(r, 5)) }
}
