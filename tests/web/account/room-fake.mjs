// room-fake.mjs: a FAKE of app/web/core/room.ts for the account's tests, in the place of that module (setup.mjs).
// TEST ONLY. It is exactly the contract account.ts codes against, and nothing more:
//
//   foundRoom({ storage: { name }, hub_url, client?, fetch?, found_token?, recovery_code, account: room_id => body })
//       → { client, recovery_code }        the body is asked for once the room id exists, before anything is posted
//   joinWithCode({ storage, hub_url, room_id (hex), code, recover?, account?: new_code => copies | null }) → { client }
//   client.core, client.hub, client.room_id, client.replaceRecoveryCode({ code, account: new_code => copies }),
//   client.checkRecoveryCode(code) (`wrong-recovery` unless it is the code in force), client.stop()
// The new code of a recovery or a replacement is made HERE, as the core makes it in the real one (the binding's
// prepareRecovery and newRecoveryCode), and `account` is asked for its copies before anything is posted.
//
// It holds no engine and no MLS. Against the FAKE hub (tests/web/stand-in/hub.mjs) a room is the JSON stand-ins that
// hub reads: a GroupInfo `{ group, epoch, leaves, recovery_signature_key }`, a Commit `{ added, removed }`, a HubAuth
// as JSON. The key a recovery code signs in with is a hash of the code here, so the fake hub knows the code's key as
// the real one knows the room's `recovery_signature_key`; a code that is not the room's is `wrong-recovery`, as
// 8.4 has it. The fake hub does not replace that key on a recovery or on `recovery-code`; this fake does it in the
// hub's state (`stage.fake`), which is the one place it reaches behind the hub's routes.
//
// Against the REAL hub (`stage.real`, real-hub.test.mjs) the room is founded by a real `Device` of the core's
// binding, nothing put in its place. Joining with the code and replacing it are room.ts's and are not played here:
// against the real hub they refuse with `core-missing` (the code in force there is the one the room was founded
// with: nothing replaces it). tests/web/hub/real-hub.test.mjs does both with the real core.
//
// `stage.calls` keeps what account.ts handed over and what was made for it: the codes as hex (taken at the call:
// account.ts zeroes its arrays afterwards, and `held` keeps the arrays themselves so that a test can see them zeroed).
import { createHash, randomBytes } from 'node:crypto'
import { Hub } from '../../../app/web/core/hub.ts'
import { b64u, hex, unhex } from '../../../app/web/core/ids.ts'
import { loadCore } from './core-node.mjs'

export const stage = {}
/** A fresh stage. `fake`: the fake hub in use; `real`: `{ binding, MemoryStore }` for the real hub;
 *  `core_missing`: joining with the code and replacing it refuse, as on the binding of today. */
export function resetStage(more = {}) {
  for (const k of Object.keys(stage)) delete stage[k]
  Object.assign(stage, { fake: null, real: null, core_missing: false, calls: [], stores: new Map() }, more)
  return stage
}
resetStage()

const utf8 = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value, (_, v) => v instanceof Uint8Array ? b64u(v) : v))
const refusal = (code, message) => Object.assign(new Error(message), { code })
const missing = call => refusal('core-missing', `core-missing: the core's WASM binding has no ${call} yet`)
/** The stand-in for the signature key a code derives (spec 8: recovery_sign). */
const keyOf = code => new Uint8Array(createHash('sha256').update('recovery key of ').update(code).digest())
const hubFor = o => new Hub({ hub_url: o.hub_url, client_name: o.client ?? null, ...(o.fetch ? { fetch: o.fetch } : {}) })
const signer = (room_id, device) => async (hub, challenge) => ({ auth: utf8({ room_id, hub, device, challenge }), signature: new Uint8Array(64) })
const groupInfo = (room_id, epoch, leaves, code) => utf8({ group: room_id, epoch, leaves, recovery_signature_key: keyOf(code) })
/** What the fake hub leaves out: new recovery keys replace the old ones. */
const rekey = (room_id, code) => { stage.fake.state.rooms.get(b64u(room_id)).recovery_keys = new Set([b64u(keyOf(code))]) }
function claim(o) {
  if (stage.stores.has(o.storage.name)) throw refusal('room-exists', 'this storage already holds a room')
}

async function clientOf(o, hub, room_id, device, more = {}) {
  const client = {
    core: await loadCore(), hub, room_id, device, stopped: false,
    /** How this device signs in to the hub: for a test that gives it a second hub client. */
    sign: more.sign ?? signer(room_id, device),
    async stop() { client.stopped = true; await more.close?.() },
    async checkRecoveryCode(code) {
      const mine = stage.real ? hex(code) === more.code : stage.fake.state.rooms.get(b64u(room_id)).recovery_keys.has(b64u(keyOf(code)))
      if (!mine) throw refusal('wrong-recovery', 'this is not the code in force')
    },
    async replaceRecoveryCode({ code, account }) {
      const call = { fn: 'replaceRecoveryCode', code: hex(code), new_code: null, account: null, held: { code } }
      stage.calls.push(call)
      if (stage.core_missing || stage.real) throw missing('replaceRecoveryCode')
      await client.checkRecoveryCode(code)
      const new_code = new Uint8Array(randomBytes(32))
      call.new_code = hex(new_code)
      const { epoch } = await hub.groupInfo(room_id)
      const leaves = (await hub.roomGroups()).find(g => g.kind === 'room').leaves
      call.account = await account(new_code)
      await hub.postRecoveryCode(room_id, { epoch, commit: utf8({ nonce: randomBytes(8).toString('hex') }), group_info: groupInfo(room_id, epoch + 1, leaves, new_code), sealed_key: utf8('sealed') }, utf8('link'), call.account)
      rekey(room_id, new_code)
    },
  }
  stage.stores.set(o.storage.name, client)
  return client
}

export async function foundRoom(o) {
  const code = o.recovery_code ?? new Uint8Array(randomBytes(32))
  const call = { fn: 'foundRoom', code: hex(code), found_token: o.found_token ?? null, held: { code }, room_id: null, body: null }
  stage.calls.push(call)
  claim(o)
  const hub = hubFor(o)
  if (stage.real) return foundReal(o, hub, code, call)
  const room_id = new Uint8Array(randomBytes(32)), device = new Uint8Array(randomBytes(32))
  call.room_id = hex(room_id)
  call.body = o.account ? await o.account(room_id) : null
  const founded = await hub.foundRoom({ group_info: groupInfo(room_id, 0, [device], code), sealed_key: utf8('sealed'), account: call.body, found_token: o.found_token ?? null })
  if (hex(founded.room_id) !== call.room_id) throw refusal('bad-answer', 'another room than the one founded')
  hub.useSigner(room_id, signer(room_id, device))
  return { client: await clientOf(o, hub, room_id, device), recovery_code: code }
}

export async function joinWithCode(o) {
  const call = { fn: 'joinWithCode', room_id: o.room_id, code: hex(o.code), recover: o.recover === true, new_code: null, account: undefined, posted_before_copies: null, held: { code: o.code } }
  stage.calls.push(call)
  claim(o)
  if (stage.core_missing || stage.real) throw missing('joinWithCode')
  const room_id = unhex(o.room_id), device = new Uint8Array(randomBytes(32))
  const outside = hubFor(o)
  outside.useSigner(room_id, signer(room_id, keyOf(o.code)))
  // 8.4: the room's state must hold the keys this code derives
  try { await outside.signIn() } catch (e) { if (e.code === 'not-member') throw refusal('wrong-recovery', 'this code is not the room\'s'); throw e }
  const { epoch } = await outside.groupInfo(room_id)
  const others = (await outside.roomGroups()).find(g => g.kind === 'room').leaves
  if (o.recover) {
    // 8.7: one recovery; the join removes every other human device and brings the new recovery keys
    const { recovery_id } = await outside.openRecovery()
    // the core's prepareRecovery makes the new code once the recovery is open; its copies are asked for before a part is posted
    const new_code = new Uint8Array(randomBytes(32))
    call.new_code = hex(new_code)
    call.posted_before_copies = stage.fake.requests.filter(r => /\/recovery\/[^/]+\/(commits|finish)$/.test(r.path)).length
    call.account = o.account ? await o.account(new_code) : null
    // (as room.ts: a recovery that fails is dropped at the hub, which gives the room back)
    try {
      await outside.recoveryCommit(recovery_id, room_id, { epoch, commit: utf8({ added: [device], removed: others }), group_info: groupInfo(room_id, epoch + 1, [device], new_code), sealed_key: utf8('sealed'), recovery_auth: utf8('auth') })
      await outside.finishRecovery(recovery_id, utf8('link'), call.account)
    } catch (e) { await outside.dropRecovery(recovery_id).catch(() => {}); throw e }
    rekey(room_id, new_code)
  } else {
    await outside.postCommit(room_id, { epoch, commit: utf8({ added: [device] }), group_info: groupInfo(room_id, epoch + 1, [...others, device], o.code), sealed_key: utf8('sealed'), recovery_auth: utf8('auth') })
  }
  const hub = hubFor(o)
  hub.useSigner(room_id, signer(room_id, device))
  return { client: await clientOf(o, hub, room_id, device) }
}

/** The founding by a real device of the core, posted to the real hub with the account in the same request. */
async function foundReal(o, hub, code, call) {
  const device = await stage.real.binding.Device.create(new stage.real.MemoryStore(`${o.storage.name}-${Date.now()}`))
  try {
    const room_id = await device.foundRoom(code, Date.now())
    call.room_id = hex(room_id)
    call.body = o.account ? await o.account(room_id) : null
    const entry = (await device.outbox()).find(e => e.kind === 'roomFounding')
    const founded = await hub.foundRoom({ group_info: entry.parts[0], sealed_key: entry.parts[1], account: call.body, found_token: o.found_token ?? null })
    if (hex(founded.room_id) !== call.room_id) throw refusal('bad-answer', 'another room than the one founded')
    await device.outboxAccepted(entry.id, null)
    const sign = (address, challenge) => device.hubSignIn(address, challenge)
    hub.useSigner(room_id, sign)
    return { client: await clientOf(o, hub, room_id, await device.id(), { close: () => device.close(), sign, code: hex(code) }), recovery_code: code }
  } catch (e) { await device.close(); throw e }
}
