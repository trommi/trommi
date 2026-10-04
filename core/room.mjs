// room.mjs: founding, opening, joining and recovering a room. Each returns a Client (client.mjs) whose
// state is in `storage`. Contract: core/README.md "Opening a room".
import * as z from './zcrypto.mjs'
import { Hub, normaliseHubUrl } from './transport.mjs'
import { Client, secretToJson, secretFromJson, verifiedHeads } from './client.mjs'
import './agent.mjs'
import { escrowKeyAndId, openEscrowV2 } from './escrow.mjs'
import * as G from './session-grants.mjs'
import { prefetchSnapshot } from './snapshot.mjs'

/**
 * As the recovery key: every session's grant chain and its current key (the recovery key holds every session key, R6).
 * raw: the answer of GET session_grants (fetched alongside the member list), or null: fetched here; a hub without
 * that route is asked per session.
 */
async function sessionsAsRecovery(hub, state, rec, raw = null) {
  const out = new Map()
  let bundle = raw ?? await fetchSessionBundle(hub)
  if (!bundle) {
    let list = []
    try { list = (await hub.sessions()).sessions } catch (e) { if (e.status === 404) return out; throw e }
    bundle = []
    for (const { session_id } of list) {
      if (!/^[0-9a-f]{32}$/.test(session_id ?? "")) continue
      bundle.push({ session_id, signed_grants: (await hub.sessionGrants(session_id, -1)).signed_grants, sealed_session_keys: (await hub.sealedSessionKeys(session_id, 0)).sealed_session_keys })
    }
  }
  for (const { session_id, signed_grants, sealed_session_keys } of bundle) {
    if (!/^[0-9a-f]{32}$/.test(session_id ?? "") || !signed_grants?.length) continue
    const sstate = await G.verifyGrants(signed_grants.map(unb64u), state)
    const w = (sealed_session_keys ?? []).find(x => x.session_key_epoch === sstate.epoch)
    const secrets = new Map()
    if (w) secrets.set(sstate.epoch, await G.unwrapSessionKey({ roomId: state.roomId, sessionState: sstate, device: rec, sealed: unb64u(w.key_sealed), epoch: sstate.epoch }))
    out.set(session_id, { state: sstate, grants: signed_grants, secrets, since: null })
  }
  return out
}
/** GET session_grants for the whole room: [{ session_id, signed_grants, sealed_session_keys }], or null (no such route). */
async function fetchSessionBundle(hub) {
  try { return (await hub.sessionBundle(null)).sessions }
  catch (e) { if (e.status === 404 || e.status === 405) return null; throw e }
}

const { b64u, unb64u, hex, unhex, ZError, ROLE } = z
const sleep = ms => new Promise(r => setTimeout(r, ms))
const roleName = r => (r === ROLE.HUMAN ? 'human' : 'agent')

async function newDevice(storage) {
  return z.generateDevice({ extractable: !!(storage.extractable_keys || storage.wraps_keys) })   // a wrapping storage hands back non-extractable keys (storage-idb.mjs)
}

async function makeClient({ storage, device, state, secrets, roomRecord, fetch, client: clientName = null, save = true, follower = false }) {
  const me = z.memberAt(state, device.id)
  const client = new Client({ storage, hub_url: roomRecord.hub_url, room_id: roomRecord.room_id, device, state, secrets: new Map(secrets.filter(Boolean).map(s => [s.epoch, s])),
    my_role: me ? roleName(me.role) : roomRecord.my_role, roomRecord, fetch, client: clientName })
  // A stored room is not saved again before it is loaded: that wrote an empty session list over the stored session
  // keys (review 3: a recovery's keys, older epochs an agent was given).
  // A follower tab (tabs.mjs) reads only: no seal, no post, no lock of its own; the hub handle refuses writes too.
  if (follower) { client.follower = true; client.externalLock = true; client.hub.readOnly = true }
  if (save) await client._saveRoom()
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
export async function openRoom({ storage, client: client_name = null, fetch = null, follower = false }) {
  const roomRecord = await storage.get('room')
  if (!roomRecord) return null
  const device = await storage.loadDevice()
  if (!device) throw new ZError('no-device', 'the room is stored but the device key is missing')
  const state = await z.verifyLog(roomRecord.entries.map(unb64u), unhex(roomRecord.room_id))
  return makeClient({ storage, device, state, secrets: roomRecord.secrets.map(secretFromJson), roomRecord, fetch, client: client_name, save: false, follower })
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
  // Review 3 (A12): the new device, its room record and the session keys reach storage BEFORE the entry is posted. A
  // crash after the post used to leave every session stale with nobody holding its key (the old humans are removed,
  // the new recovery key has no session wraps): now the next start finds the keys and re-keys the sessions.
  await storage.saveDevice(device, { room_id })
  // The recovery key held every older epoch through the back links: open them so history stays readable.
  const secrets = [r.secret, r.previous]
  const roomRecord = { hub_url, room_id, my_device_id: hex(device.id), my_role: 'human', device_info: device_info ?? { device_name }, device_register_sent: false, epoch_changed_at: Date.now(), recovery_pending: true }
  const client = await makeClient({ storage, device, state: r.state, secrets, roomRecord, fetch, client: client_name })
  for (const [sid, k] of sessions) client.sessionKeys.set(sid, k)
  await client._saveRoom()
  try {
    await hub.postMember({ signed_entry: b64u(r.entry), sealed_room_keys: r.wraps.map(w => ({ device_id: hex(w.id), key_sealed: b64u(w.sealed) })), key_back_link: r.backLink ? b64u(r.backLink) : undefined })
  } catch (e) {
    // Refused (not a crash): nothing changed on the hub; forget the room again so this storage can be used anew.
    if (e.status >= 400 && e.status < 500) await storage.set('room', undefined).catch(() => {})
    throw e
  }
  delete client.roomRecord.recovery_pending
  await client._saveRoom().catch(e => client._localAlert('storage', e))
  await client.hub.signIn()
  await client._walkBackLinks().catch(() => {})
  // Every session gets a new key: the old human devices held them (R6). Agents that stay keep their sessions.
  // The entry is in: from here on nothing may lose the new code. A failed re-key is finished at the next start (stale grants).
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
  // v2 only: the escrow id comes from the passphrase (a wrong passphrase finds nothing). A retired v1 blob is never
  // served anonymously; a member device migrates it (client.migratePassphrase).
  const { key, escrow_id } = await escrowKeyAndId(passphrase, room_id)
  let code
  try { code = await openEscrowV2({ room_id, key_escrow: (await pub.getEscrow(escrow_id)).key_escrow, key, escrow_id }) }
  catch (e) { if (e.code === 'not-found') throw new ZError('wrong-passphrase', 'this passphrase does not open an escrow of this room'); throw e }
  const { client } = await joinWithRecoveryCode({ hub_url, room_id, code, storage, client: client_name, device_name, device_info, fetch })
  client.model.room.has_passphrase = true
  return { client }
}

/**
 * A fresh device that holds the room's recovery code (from the passphrase escrow or an account login, account.mjs):
 * sign in as the recovery key, add ITSELF as a human device (entry signed by the recovery key; nobody is removed),
 * seal the room key and every session key for itself. Every human device then shows the alert 'recovery-add'.
 */
export async function joinWithRecoveryCode({ hub_url, room_id, code, storage, client: client_name = null, device_name = '', device_info = null, fetch = null, challenge = null }) {
  hub_url = normaliseHubUrl(hub_url)
  if (await storage.get('room')) throw new ZError('room-exists', 'this storage already holds a room')
  const rec = await z.recoveryDevice(code)
  const hub = new Hub({ hub_url, room_id, fetch, client: client_name, signer: challenge => z.signHubAuth({ device: rec, roomId: unhex(room_id), hub: hub_url, challenge }) })
  await hub.signIn({ challenge })                           // the login answer carries a challenge: one round trip less
  // The member list, the sealed room keys and every session's grants and keys: three requests side by side.
  const [m, keys, bundle] = await Promise.all([hub.members({ after_entry_number: -1 }), hub.sealedRoomKeys(0), fetchSessionBundle(hub)])
  const state = await z.verifyLog(m.signed_entries.map(unb64u), unhex(room_id))
  if (!z.bytesEqual(rec.id, state.recovery.id)) throw new ZError('bad-recovery-code', 'an old recovery code (a recovery happened since)')
  const wrap = keys.sealed_room_keys.find(k => k.key_epoch === state.epoch)
  if (!wrap) throw new ZError('no-key', 'the hub holds no sealed room key for the recovery key')
  const secret = await z.unwrapEpochKey(state, rec, unb64u(wrap.key_sealed), state.epoch)
  const sessions = await sessionsAsRecovery(hub, state, rec, bundle)
  const device = await newDevice(storage)
  const added = await z.addMember(state, rec, { member: { role: ROLE.HUMAN, signPub: device.signPub, kexPub: device.kexPub } })
  const sealed = await z.wrapEpochKey(added.state, secret, device.id)
  await storage.saveDevice(device, { room_id })            // before the entry that makes it a member (review 3)
  // The new device's sign-in challenge is asked side by side with the post that makes it a member (a challenge is
  // nobody's until it is signed; the hub checks membership when the signed one comes back).
  const nextChallenge = hub.challenge()
  nextChallenge.catch(() => {})
  await hub.postMember({ signed_entry: b64u(added.entry), sealed_room_keys: [{ device_id: hex(device.id), key_sealed: b64u(sealed) }] })
  const roomRecord = { hub_url, room_id, my_device_id: hex(device.id), my_role: 'human', device_info: device_info ?? { device_name }, device_register_sent: false }
  const client = await makeClient({ storage, device, state: added.state, secrets: [secret], roomRecord, fetch, client: client_name })
  // The new device is a human member now: re-seal every session key for everyone who holds it (itself included), all
  // sessions in one atomic post (POST session_grants, no sign-in needed), not one request per session. The device holds
  // every key already (as the recovery key), so the first start does not wait for it: a phone uploads the re-seal (one
  // wrap per holder and session) for about a second. The session refresh waits for it (client._resealing); a re-seal
  // that did not get through is posted at the next start (roomRecord.reseal_pending). Meanwhile, as soon as the device
  // is signed in: the room's older keys, and what the first start reads for a snapshot boot (snapshot.mjs).
  client._adoptSessionKeys(sessions)
  const reseal = [...sessions].filter(([, k]) => k.secrets.has(k.state.epoch)).map(([sid]) => sid)
  if (reseal.length) roomRecord.reseal_pending = reseal
  await client._saveRoom()
  // The snapshot's first request goes out before the re-seal's sealing takes the CPU (about 0.2 s on a phone), the
  // sealing then overlaps with the network instead of holding the request back.
  const signedIn = client.hub.signIn({ challenge: nextChallenge })
  client._snapshotPrefetch = signedIn.then(() => prefetchSnapshot(client))
  client._snapshotPrefetch.catch(() => {})
  const resealing = signedIn.catch(() => {}).then(() => reseal.length ? client._startReseal(reseal) : null)
  resealing.catch(() => {})
  await signedIn
  await client._walkBackLinks().catch(() => {})
  await client._saveRoom()
  client._joinedAt = Date.now()                       // start() trusts the member list and keys it was just handed
  return { client }
}
