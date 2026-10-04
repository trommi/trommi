// room.mjs: founding, opening, joining and recovering a room. Each returns a Client (client.mjs) whose
// state is in `storage`. Contract: client/core/README.md "Opening a room".
import * as z from './zcrypto.mjs'
import { Hub, normaliseHubUrl } from './transport.mjs'
import { Client, secretToJson, secretFromJson } from './client.mjs'
import './agent.mjs'

const { b64u, unb64u, hex, unhex, ZError, ROLE } = z
const sleep = ms => new Promise(r => setTimeout(r, ms))
const roleName = r => (r === ROLE.HUMAN ? 'human' : 'agent')

async function newDevice(storage) {
  return z.generateDevice({ extractable: !!storage.extractable_keys })
}

async function makeClient({ storage, device, state, secrets, roomRecord, fetch, client: clientName = null }) {
  const me = z.memberAt(state, device.id)
  const client = new Client({ storage, hub_url: roomRecord.hub_url, room_id: roomRecord.room_id, device, state, secrets: new Map(secrets.map(s => [s.epoch, s])),
    my_role: me ? roleName(me.role) : roomRecord.my_role, roomRecord, fetch, client: clientName })
  await client._saveRoom()
  await client.loadPersisted()
  return client
}

/**
 * Found a room on a hub: device keys, recovery code (returned ONCE: show it, never store it), epoch 1.
 * device_info goes into the encrypted register device/<id> on the first start ({ device_name, platform, folder, host }).
 */
export async function foundRoom({ hub_url, storage, client: client_name = null, device_name = '', device_info = null, found_token = null, fetch = null }) {
  hub_url = normaliseHubUrl(hub_url)
  if (await storage.get('room')) throw new ZError('room-exists', 'this storage already holds a room')
  const device = await newDevice(storage)
  const recovery_code = z.generateRecoveryCode()
  const room = await z.createRoom({ device, name: '', recovery: await z.recoveryDevice(recovery_code) })
  const hub = new Hub({ hub_url, fetch, found_token, client: client_name })
  const r = await hub.foundRoom({ signed_entry: b64u(room.entry), sealed_room_keys: room.wraps.map(w => ({ device_id: hex(w.id), key_sealed: b64u(w.sealed) })) })
  if (r.room_id !== hex(room.roomId)) throw new ZError('wrong-room', 'the hub named another room id')
  await storage.saveDevice(device, { room_id: r.room_id })
  const roomRecord = { hub_url, room_id: r.room_id, my_device_id: hex(device.id), my_role: 'human', device_info: device_info ?? { device_name }, device_register_sent: false }
  const client = await makeClient({ storage, device, state: room.state, secrets: [room.secret], roomRecord, fetch, client: client_name })
  return { client, recovery_code }
}

/** Open the room in this storage (warm start): verify the stored member list against the stored room id, load the model. */
export async function openRoom({ storage, client: client_name = null, fetch = null }) {
  const roomRecord = await storage.get('room')
  if (!roomRecord) return null
  const device = await storage.loadDevice()
  if (!device) throw new ZError('no-device', 'the room is stored but the device key is missing')
  const state = await z.verifyLog(roomRecord.entries.map(unb64u), unhex(roomRecord.room_id))
  return makeClient({ storage, device, state, secrets: roomRecord.secrets.map(secretFromJson), roomRecord, fetch, client: client_name })
}

/**
 * Join with an invite link. Returns { check_code: Promise<string>, client: Promise<Client>, cancel() }.
 * A human shows check_code for the inviter to type; an agent may log it. client resolves once the inviter added this device.
 */
export function joinRoom({ link, storage, client: client_name = null, device_name = '', device_info = null, fetch = null, poll_ms = 800, timeout_ms = 15 * 60_000 }) {
  let cancelled = false, codeResolve, codeReject
  const check_code = new Promise((res, rej) => { codeResolve = res; codeReject = rej })
  check_code.catch(() => {})
  const client = (async () => {
    if (await storage.get('room')) throw new ZError('room-exists', 'this storage already holds a room')
    const { hub: hub_url, roomId } = z.parseInviteLink(link)
    const room_id = hex(roomId)
    const hub = new Hub({ hub_url, room_id, fetch, client: client_name })
    const { secret } = z.parseInviteLink(link)
    const inviteId = hex(await z.hkdf(secret, roomId, z.LABEL.inviteId, new Uint8Array(0), 16))
    const inv = await hub.getInvite(inviteId)
    const device = await newDevice(storage)
    const log = inv.signed_entries.map(unb64u)
    const { request, join } = await z.createJoinRequest({ link, offer: unb64u(inv.signed_offer), log, device, name: '' })
    const { request_hash } = await hub.postRequest(inviteId, b64u(request))
    const until = Date.now() + timeout_ms
    let revealed = false
    while (!cancelled && Date.now() < until) {
      const s = await hub.joinStatus(inviteId, request_hash)
      if (s.join_status === 'taken') throw new ZError('invite-used', 'this invite was answered for another device')
      if ((s.join_status === 'revealed' || s.join_status === 'joined') && !revealed && s.signed_reveal) {
        revealed = true
        codeResolve(await z.checkReveal({ join, reveal: unb64u(s.signed_reveal), log: s.signed_entries ? s.signed_entries.map(unb64u) : log }))
      }
      if (s.join_status === 'joined') {
        const entries = s.signed_entries.map(unb64u)
        const done = await z.completeJoin({ join, device, log: entries, wrap: unb64u(s.key_sealed) })
        await storage.saveDevice(device, { room_id })
        const roomRecord = { hub_url: normaliseHubUrl(hub_url), room_id, my_device_id: hex(device.id), my_role: roleName(join.role), device_info: device_info ?? { device_name }, device_register_sent: false }
        const c = await makeClient({ storage, device, state: done.state, secrets: [done.secret], roomRecord, fetch, client: client_name })
        if (c.is_human) { await c.hub.signIn(); await c._walkBackLinks().catch(() => {}); await c._saveRoom() }
        return c
      }
      await sleep(poll_ms)
    }
    throw new ZError(cancelled ? 'cancelled' : 'invite-expired', cancelled ? 'join cancelled' : 'the invite ran out before it was confirmed')
  })()
  client.catch(e => codeReject(e))
  return { check_code, client, cancel() { cancelled = true } }
}

/**
 * All devices lost, code at hand: sign in as the recovery key, enrol a new device, remove every human device, keep the agents,
 * new epoch, NEW recovery code (returned once).
 */
export async function recoverRoom({ hub_url, room_id, code, storage, client: client_name = null, device_name = '', device_info = null, fetch = null }) {
  hub_url = normaliseHubUrl(hub_url)
  const rec = await z.recoveryDevice(code)
  const hub = new Hub({ hub_url, room_id, fetch, client: client_name, signer: challenge => z.signHubAuth({ device: rec, roomId: unhex(room_id), hub: hub_url, challenge }) })
  await hub.signIn()
  const m = await hub.members({ after_entry_number: -1 })
  const state = await z.verifyLog(m.signed_entries.map(unb64u), unhex(room_id))
  const keys = await hub.sealedRoomKeys(0)
  const wrap = keys.sealed_room_keys.find(k => k.key_epoch === state.epoch)
  if (!wrap) throw new ZError('no-key', 'the hub holds no sealed key of the current epoch for the recovery key')
  const device = await newDevice(storage)
  const newCode = z.generateRecoveryCode()
  const r = await z.recoverRoom({ state, code, newCode, newDevice: device, name: '', recoveryWrap: unb64u(wrap.key_sealed) })
  await hub.postMember({ signed_entry: b64u(r.entry), sealed_room_keys: r.wraps.map(w => ({ device_id: hex(w.id), key_sealed: b64u(w.sealed) })), key_back_link: r.backLink ? b64u(r.backLink) : undefined })
  await storage.saveDevice(device, { room_id })
  // The recovery key held every older epoch through the back links: open them so history stays readable.
  const secrets = [r.secret, r.previous]
  const roomRecord = { hub_url, room_id, my_device_id: hex(device.id), my_role: 'human', device_info: device_info ?? { device_name }, device_register_sent: false, epoch_changed_at: Date.now() }
  const client = await makeClient({ storage, device, state: r.state, secrets, roomRecord, fetch, client: client_name })
  await client.hub.signIn()
  await client._walkBackLinks().catch(() => {})
  await client._saveRoom()
  return { client, recovery_code: newCode }
}

export { secretToJson }

/** The link a fresh device types or scans to sign in with a passphrase or to recover: `<app>#r1.<b64u hub>.<b64u room>`. Not secret. */
export function roomLink(hub_url, room_id, app = 'https://app.trommi.com/login') {
  return `${app}#r1.${b64u(new TextEncoder().encode(normaliseHubUrl(hub_url)))}.${b64u(unhex(room_id))}`
}
export function parseRoomLink(text) {
  const s = String(text).trim()
  const frag = s.includes('#') ? s.slice(s.indexOf('#') + 1) : s
  const parts = frag.split('.')
  if (parts[0] !== 'r1' || parts.length !== 3) throw new ZError('bad-format', 'not a room link')
  const room = unb64u(parts[2])
  if (room.length !== 32) throw new ZError('bad-format', 'room id')
  return { hub_url: normaliseHubUrl(new TextDecoder('utf-8', { fatal: true }).decode(unb64u(parts[1]))), room_id: hex(room) }
}
