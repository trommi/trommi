// room.mjs: founding, opening, joining and recovering a room. Each returns a Client (client.mjs) whose
// state is in `storage`. Contract: client/core/README.md "Opening a room".
import * as z from './zcrypto.mjs'
import { Hub, normaliseHubUrl } from './transport.mjs'
import { Client, secretToJson, secretFromJson, verifiedHeads } from './client.mjs'
import './agent.mjs'
import { openEscrow, escrowKeyAndId, openEscrowV2 } from './escrow.mjs'
import * as G from './session-grants.mjs'

/** As the recovery key: every session's grant chain and its current key (the recovery key holds every session key, R6). */
async function sessionsAsRecovery(hub, state, rec) {
  const out = new Map()
  let list = []
  try { list = (await hub.sessions()).sessions } catch (e) { if (e.status === 404) return out; throw e }
  for (const { session_id } of list) {
    if (!/^[0-9a-f]{32}$/.test(session_id ?? "")) continue
    const r = await hub.sessionGrants(session_id, -1)
    const sstate = await G.verifyGrants(r.signed_grants.map(unb64u), state)
    const wraps = (await hub.sealedSessionKeys(session_id, 0)).sealed_session_keys
    const w = wraps.find(x => x.session_key_epoch === sstate.epoch)
    const secrets = new Map()
    if (w) secrets.set(sstate.epoch, await G.unwrapSessionKey({ roomId: state.roomId, sessionState: sstate, device: rec, sealed: unb64u(w.key_sealed), epoch: sstate.epoch }))
    out.set(session_id, { state: sstate, grants: r.signed_grants, secrets, since: null })
  }
  return out
}

const { b64u, unb64u, hex, unhex, ZError, ROLE } = z
const sleep = ms => new Promise(r => setTimeout(r, ms))
const roleName = r => (r === ROLE.HUMAN ? 'human' : 'agent')

async function newDevice(storage) {
  return z.generateDevice({ extractable: !!storage.extractable_keys })
}

async function makeClient({ storage, device, state, secrets, roomRecord, fetch, client: clientName = null }) {
  const me = z.memberAt(state, device.id)
  const client = new Client({ storage, hub_url: roomRecord.hub_url, room_id: roomRecord.room_id, device, state, secrets: new Map(secrets.filter(Boolean).map(s => [s.epoch, s])),
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
        const done = await z.completeJoin({ join, device, log: entries, wrap: s.key_sealed ? unb64u(s.key_sealed) : null })
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
export async function recoverRoom({ hub_url, room_id, code, storage, client: client_name = null, device_name = '', device_info = null, fetch = null, remove_agents = [], on_recovery_code = null }) {
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
  const sessions = await sessionsAsRecovery(hub, state, rec)
  // R3: real cuts for every device the recovery removes (its last verified envelope), never an empty cut that would
  // refuse all its history on every device that verifies the room later.
  const removed = [...state.members.values()].filter(m => m.removedSeq === null && (m.role === ROLE.HUMAN || remove_agents.includes(hex(m.id)))).map(m => hex(m.id))
  const cuts = (await verifiedHeads(hub, state, removed)) ?? {}
  if (!Object.keys(cuts).length && removed.length) console.warn('[core] recovery: the hub let the recovery key read no envelopes; cuts are empty')
  // A12: the new code reaches the human before the entry that makes it valid is posted (show it, never store it).
  if (on_recovery_code) await on_recovery_code(newCode)
  const r = await z.recoverRoom({ state, code, newCode, newDevice: device, name: '', recoveryWrap: unb64u(wrap.key_sealed), removeAgents: remove_agents.map(unhex), cuts })
  await hub.postMember({ signed_entry: b64u(r.entry), sealed_room_keys: r.wraps.map(w => ({ device_id: hex(w.id), key_sealed: b64u(w.sealed) })), key_back_link: r.backLink ? b64u(r.backLink) : undefined })
  await storage.saveDevice(device, { room_id })
  // The recovery key held every older epoch through the back links: open them so history stays readable.
  const secrets = [r.secret, r.previous]
  const roomRecord = { hub_url, room_id, my_device_id: hex(device.id), my_role: 'human', device_info: device_info ?? { device_name }, device_register_sent: false, epoch_changed_at: Date.now() }
  const client = await makeClient({ storage, device, state: r.state, secrets, roomRecord, fetch, client: client_name })
  await client.hub.signIn()
  await client._walkBackLinks().catch(() => {})
  // Every session gets a new key: the old human devices held them (R6). Agents that stay keep their sessions.
  // The entry is in: from here on nothing may lose the new code. A failed re-key is finished at the next start (stale grants).
  for (const [sid, k] of sessions) client.sessionKeys.set(sid, k)
  await client._healStaleSessions().catch(e => client._localAlert('rekey', e))
  await client._saveRoom().catch(e => client._localAlert('storage', e))
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

/**
 * "Mit Passwort anmelden": a fresh device with the room link and the passphrase. Opens the escrow, signs in as the
 * recovery key, adds ITSELF as a human device (entry signed by the recovery key; nobody is removed), seals the room
 * key for itself. Returns { client }.
 */
export async function loginWithPassphrase({ room_link, passphrase, storage, client: client_name = null, device_name = '', device_info = null, fetch = null }) {
  const { hub_url, room_id } = parseRoomLink(room_link)
  if (await storage.get('room')) throw new ZError('room-exists', 'this storage already holds a room')
  const pub = new Hub({ hub_url, room_id, fetch, client: client_name })
  // v2: the escrow id comes from the passphrase (a wrong passphrase finds nothing); v1 blobs (by room id) as a fallback.
  const { key, escrow_id } = await escrowKeyAndId(passphrase, room_id)
  let code
  try { code = await openEscrowV2({ room_id, key_escrow: (await pub.getEscrow(escrow_id)).key_escrow, key, escrow_id }) }
  catch (e) {
    if (e.code !== 'not-found') throw e
    let v1
    try { v1 = await pub.getEscrow() } catch (e2) { if (e2.code === 'not-found') throw new ZError('wrong-passphrase', 'this passphrase does not open an escrow of this room'); throw e2 }
    code = await openEscrow({ room_id, key_escrow: v1.key_escrow, passphrase })
  }
  const rec = await z.recoveryDevice(code)
  const hub = new Hub({ hub_url, room_id, fetch, client: client_name, signer: challenge => z.signHubAuth({ device: rec, roomId: unhex(room_id), hub: hub_url, challenge }) })
  await hub.signIn()
  const m = await hub.members({ after_entry_number: -1 })
  const state = await z.verifyLog(m.signed_entries.map(unb64u), unhex(room_id))
  if (!z.bytesEqual(rec.id, state.recovery.id)) throw new ZError('bad-recovery-code', 'the escrow holds an old recovery code (a recovery happened since)')
  const keys = await hub.sealedRoomKeys(0)
  const wrap = keys.sealed_room_keys.find(k => k.key_epoch === state.epoch)
  if (!wrap) throw new ZError('no-key', 'the hub holds no sealed room key for the recovery key')
  const secret = await z.unwrapEpochKey(state, rec, unb64u(wrap.key_sealed), state.epoch)
  const sessions = await sessionsAsRecovery(hub, state, rec)
  const device = await newDevice(storage)
  const added = await z.addMember(state, rec, { member: { role: ROLE.HUMAN, signPub: device.signPub, kexPub: device.kexPub } })
  const sealed = await z.wrapEpochKey(added.state, secret, device.id)
  await hub.postMember({ signed_entry: b64u(added.entry), sealed_room_keys: [{ device_id: hex(device.id), key_sealed: b64u(sealed) }] })
  await storage.saveDevice(device, { room_id })
  const roomRecord = { hub_url, room_id, my_device_id: hex(device.id), my_role: 'human', device_info: device_info ?? { device_name }, device_register_sent: false }
  const client = await makeClient({ storage, device, state: added.state, secrets: [secret], roomRecord, fetch, client: client_name })
  await client.hub.signIn()
  await client._walkBackLinks().catch(() => {})
  // The new device is a human member now: re-seal every session key for everyone who holds it (itself included).
  for (const [sid, k] of sessions) {
    client.sessionKeys.set(sid, k)
    if (k.secrets.has(k.state.epoch)) await client._grantLocked(sid, { agent_device_ids: k.state.agentIds, with_history: !!k.state.withHistory, rotate: false })
  }
  await client._saveRoom()
  client.model.room.has_passphrase = true
  return { client }
}
