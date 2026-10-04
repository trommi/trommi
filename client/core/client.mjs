// client.mjs: one room as seen by one device. The sync engine (one cursor, verify every header, decrypt heads,
// lazy timelines), the outbox, persistence, membership changes, and the human actions. The agent actions are in
// agent.mjs (mixed into the same class). Contract: client/core/README.md.
import * as z from './zcrypto.mjs'
import { Hub } from './transport.mjs'
import * as codec from './codec.mjs'
import * as M from './model.mjs'
import { sealEscrowV2, openEscrow, generatePassphrase } from './escrow.mjs'
import * as G from './session-grants.mjs'
import { bootFromSnapshot, writeSnapshot, SNAPSHOT_EVERY } from './snapshot.mjs'

const { b64u, unb64u, hex, unhex, ZError, ROLE } = z
const CHAIN_HASHES_KEPT = 256
const PAGE = 1000
const YIELD_MS = 12
const PERSIST_DELAY_MS = 150
const BLOCKED_RETRY_MS = 60_000
const SIGNED_SKEW_MS = 3 * 60_000      // B03: clock skew allowed between the signer of an epoch change and a sender
const pad = n => String(n).padStart(12, '0')
const roleName = r => (r === ROLE.HUMAN ? 'human' : 'agent')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const yieldNow = () => new Promise(r => setTimeout(r, 0))
const randomHex = n => hex(globalThis.crypto.getRandomValues(new Uint8Array(n)))
const isZeroHex = h => !h || /^0+$/.test(h)

/** R1: object_id = first 16 bytes of H("trommi/v1/object-id", creator device_id || sender_sequence u64 of version 1). Hex. */
export async function objectIdOf(creatorHex, seq) {
  if (z.objectIdOf) return hex(await z.objectIdOf(unhex(creatorHex), seq))
  const n = new Uint8Array(8)
  new DataView(n.buffer).setBigUint64(0, BigInt(seq))
  return hex((await z.hash('trommi/v1/object-id', unhex(creatorHex), n)).slice(0, 16))
}
export const ZERO_HASH = '0'.repeat(64)

// ---- (de)serialising crypto state --------------------------------------------------------------

export const secretToJson = s => ({ epoch: s.epoch, key: b64u(s.key), hist: s.hist ? b64u(s.hist) : null })
export const secretFromJson = o => ({ epoch: o.epoch, key: unb64u(o.key), hist: o.hist ? unb64u(o.hist) : null })
const pinToJson = p => ({ seq: p.seq, hash: b64u(p.hash), hashes: p.hashes.map(b64u), lastRecoverSeq: p.lastRecoverSeq })
const pinFromJson = o => o && ({ seq: o.seq, hash: unb64u(o.hash), hashes: o.hashes.map(unb64u), lastRecoverSeq: o.lastRecoverSeq })
function chainToJson(c) {
  const hashes = [...c.hashes].sort((a, b) => a[0] - b[0]).slice(-CHAIN_HASHES_KEPT)
  return { seq: c.seq, hash: b64u(c.hash), hashes: hashes.map(([s, h]) => [s, b64u(h)]) }
}
const chainFromJson = o => ({ seq: o.seq, hash: unb64u(o.hash), hashes: new Map(o.hashes.map(([s, h]) => [s, unb64u(h)])) })
function trimChain(c) { if (c.hashes.size > CHAIN_HASHES_KEPT * 2) { const keep = [...c.hashes.keys()].sort((a, b) => a - b).slice(-CHAIN_HASHES_KEPT); c.hashes = new Map(keep.map(k => [k, c.hashes.get(k)])) } }

/** Members of a verified zcrypto log state, in model shape. */
export function membersOf(state) {
  return [...state.members.values()].map(m => ({ device_id: hex(m.id), device_role: roleName(m.role), is_active: m.removedSeq === null, added_entry_number: m.addedSeq, removed_entry_number: m.removedSeq }))
}

/**
 * R3 cuts for devices this device holds no chain of (recovery, removal after a fresh start): page the hub's envelopes,
 * verify every header chain (signatures, prev hashes), and return the verified head { seq, hash } per sender id (hex).
 * A hub that withholds the newest envelopes only lowers the cut (it could withhold them anyway).
 */
export async function verifiedHeads(hub, state, ids) {
  const want = new Set(ids)
  const chains = new Map()
  let after = 0
  for (;;) {
    let r
    try { r = await hub.envelopes({ after_envelope_number: after, limit: 1000 }) }
    catch (e) { if (e.code === 'forbidden') return null; throw e }      // an older hub: the recovery key reads no envelopes
    for (const { envelope_number, envelope } of r.envelopes) {
      after = Math.max(after, envelope_number)
      try {
        const bytes = unb64u(envelope)
        if (!want.has(hex(z.peekEnvelope(bytes).header.sender))) continue
        await z.verifyEnvelope(bytes, { state, chains, allowChainStart: true, allowRemovedSender: true, commit: true })
      } catch { /* a broken or out-of-order envelope ends nothing: the cut is the last verified one */ }
    }
    if (!r.envelopes.length || after >= (r.last_envelope_number ?? after)) break
  }
  const out = {}
  for (const id of want) { const c = chains.get(b64u(unhex(id))); if (c?.seq) out[id] = { seq: c.seq, hash: c.hash } }
  return out
}

export class Client {
  constructor({ storage, hub_url, room_id, device, state, secrets, my_role, roomRecord, fetch, client = null }) {
    this.storage = storage
    this.device = device
    this.state = state
    this.secrets = secrets              // Map epoch -> secret
    this.chains = z.newChains()
    this.roomRecord = roomRecord
    this.hub = new Hub({ hub_url, room_id, fetch, client, signer: challenge => z.signHubAuth({ device, roomId: state.roomId, hub: this.hub.hub_url, challenge }) })
    this.hub.onForbidden = () => { this.serial(() => this._refreshMembers()).catch(() => {}) }
    this.hub.onTooOld = e => { if (this._tooOld) return; this._tooOld = true; this.emit('error', e); this.stop().catch(() => {}) }
    // lease-lost: first ask for the lease again (renew: a restarted hub that knows no live lease gives it back with a new
    // generation); only if ANOTHER live process holds it does this process stop (R4 fencing).
    this.hub.onLeaseLost = e => {
      if (this._leaseLost) return
      const attempt = this._leaseRecoveryFailed ? Promise.resolve(false) : this._recoverLease()
      attempt.then(ok => {
        if (ok) { if (this._started) { this._stream?.close(); this._openStream() } this._pumpOutbox(); return }
        this._leaseLost = true; clearInterval(this._leaseTimer); this.emit('error', e); this.stop().catch(() => {})
      })
    }
    this.model = M.emptyModel()
    Object.assign(this.model.room, { room_id, hub_url: this.hub.hub_url, my_device_id: hex(device.id), my_role, key_epoch: state.epoch, last_entry_number: state.head.seq })
    this.listeners = new Map()
    this.outbox = []                    // [{ local_id, bytes(b64u), seq, hash(hex), kind, ... }]
    this.recentSent = []                // acked envelopes kept for gap repair
    this.echoes = new Map()             // local_id -> undo()
    this.byHash = new Map()             // own envelope hash -> local_id (until it comes back)
    this.invitesPrivate = new Map()     // invite_id -> zcrypto invite record (+ code)
    this.delivered = new Map()          // human sender device id -> highest sender_sequence handed out as a command (R4)
    this.ledgerSet = new Set()          // executed commands (envelope hashes), kept by the channel via client.ledger (R4)
    this.frontiers = new Map()          // sender -> Map(other sender -> highest sequence it has seen): causal order (R2)
    this.commandsHalted = null          // 'log-fork' halts every command until a human acts (R3)
    this.startedAt = Date.now()
    this.sessionKeys = new Map()        // session_id -> { state (grant chain), secrets: Map(epoch -> secret), grants: [b64u], since: epoch change time } (R6)
    this.leaseGeneration = null
    this.options = {}                   // { snapshot: false, snapshot_every }
    this.attachmentCache = new Map()
    this._echoItems = new Map()         // local_id -> pending TimelineItem (gets sender_sequence once sealed)
    this.sentContent = new Map()        // own envelope hash -> content (until it comes back), for own pruned copies
    this.localHeads = new Map()         // own objects: object_id -> { object_version, version_hash, content } as last SENT
    this.stats = { verified: 0, decrypted: 0, verify_ms: 0, batches: 0 }
    this._queue = Promise.resolve()
    this._dirty = { records: new Map(), chains: new Set(), timer: null }
    this._stream = null
    this._started = false
    this._pump = null
    this.epochChangedAt = roomRecord.epoch_changed_at ?? null
  }

  get my_device_id() { return this.model.room.my_device_id }

  /** R4: renew the lease after a lease-lost; true if this process holds it again (at most once every 5 s). */
  async _recoverLease() {
    if (!this._leaseInstance) return false
    // one attempt serves every caller of the next 5 s (the stream and the outbox both see the same restart)
    if (this._leaseRecovery && Date.now() - this._leaseRecovery.at < 5000) return this._leaseRecovery.promise
    const promise = this.hub.agentLease({ process_instance: this._leaseInstance, renew: true })
      .then(r => { this.hub.lease_generation = r.lease_generation; return true }, () => false)
    this._leaseRecovery = { at: Date.now(), promise }
    return promise
  }

  /**
   * THE key choice (R6), in one place: which secret seals an envelope, given what it is about. Today every envelope
   * uses the room key of the current epoch. With per-session keys this returns the session key (and the header's
   * key scope + session id) for a session's cards, chat, canvas and agent registers, the room key for the rest.
   * Returns { secret, scope } where scope is spread into sealEnvelope.
   */
  keyFor({ session_id = null }) {
    if (session_id) {
      const sk = this.sessionKeys.get(session_id)
      const secret = sk?.secrets.get(sk.state.epoch)
      if (!secret) throw new ZError('no-key', `no key for session ${session_id.slice(0, 8)}`)
      return { secret, scope: { keyScope: z.KEY_SCOPE?.SESSION ?? 1, sessionId: unhex(session_id) } }
    }
    if (!this.is_human) throw new ZError('no-session', 'agents send under a session key: no session is assigned to this agent yet')
    return { secret: this.secrets.get(this.state.epoch), scope: {} }
  }
  /**
   * A1: never seal under a session key a removed device may hold. While the session's newest grant predates a removal
   * or recovery, a human re-keys it at once; an agent waits for the new grant (up to a minute), then gives up unsigned.
   */
  async _awaitFreshSession(session_id) {
    const stale = () => { const k = this.sessionKeys.get(session_id); return !!(k?.state && G.grantIsStale?.(k.state, this.state)) }
    if (!stale()) return
    if (this.is_human) { await this._healStaleSessions(); if (!stale()) return }
    for (let t = 0; t < 60_000 && stale(); t += 1000) { await sleep(1000); await this._refreshMembers().catch(() => {}); await this._refreshSessions().catch(() => {}) }
    if (stale()) throw new ZError('stale-session-key', 'this session waits for a human device to re-key it after a removal')
  }
  /** The opening side of keyFor: (epoch, header) -> secret, room or session scope. */
  get openKeys() {
    return this._openKeys ??= (epoch, h) => (h?.keyScope === 1 ? this.sessionKeys.get(hex(h.sessionId))?.secrets.get(epoch) : this.secrets.get(epoch))
  }
  /** Agents: the sessions assigned to this agent now (grants), the first one is the default for every send. */
  get session_ids() { return [...this.sessionKeys.values()].filter(k => k.state.agentIds.includes(this.my_device_id)).map(k => k.state.sessionId) }
  get session_id() { return this.session_ids[0] ?? null }
  /** Agents: resolves with the first session assigned to this agent. */
  whenSession() {
    if (this.session_id) return Promise.resolve(this.session_id)
    return new Promise(resolve => { const off = this.on('session', e => { off(); resolve(e.session_id) }) })
  }
  /** Humans: the session an agent is assigned to now (the first). */
  sessionOfAgent(agent_device_id) {
    for (const k of this.sessionKeys.values()) if (k.state.agentIds.includes(agent_device_id)) return k.state.sessionId
    return null
  }
  get is_human() { return this.model.room.my_role === 'human' }

  // ---- events --------------------------------------------------------------------------
  on(event, fn) { if (!this.listeners.has(event)) this.listeners.set(event, new Set()); this.listeners.get(event).add(fn); return () => this.off(event, fn) }
  off(event, fn) { this.listeners.get(event)?.delete(fn) }
  emit(event, data) { for (const fn of this.listeners.get(event) ?? []) { try { fn(data) } catch (e) { console.error('[core] listener', e) } } }
  _emitChange(change) {
    if (globalThis.process?.env?.CORE_DEBUG && change.alerts) for (const a of this.model.alerts.slice(-3)) if (!a._logged) { a._logged = true; console.error(`[core ${this.model.room.my_role} ${this.my_device_id.slice(0, 6)}] alert ${a.code}: ${a.message}`) }
    if (change.alerts) for (const a of this.model.alerts.slice(-5)) if (!a._emitted) { a._emitted = true; this.emit('alert', a) }
    if (!M.changeIsEmpty(change)) this.emit('change', change)
  }

  /** Run fn strictly after everything queued before (stream records, sends, membership changes). */
  serial(fn) { const run = this._queue.then(fn, fn); this._queue = run.catch(() => {}); return run }

  // ---- warm start ----------------------------------------------------------------------------

  /** Load the persisted model, chains and cursor (called by openRoom). */
  async loadPersisted() {
    const st = this.storage
    const sync = await st.get('sync')
    this._freshStorage = !sync
    for (const [k, v] of await st.range('chain/')) this.chains.set(k.slice(6), chainFromJson(v))
    if (sync) {
      this.model.room.last_envelope_number = sync.cursor
      this.delivered = new Map(Object.entries(sync.delivered ?? {}))
      this.frontiers = new Map(Object.entries(sync.frontiers ?? {}).map(([k, v]) => [k, new Map(Object.entries(v))]))
      this.lamport = sync.lamport ?? 0
      if (sync.stale_hashes) this._staleHashes = new Set(sync.stale_hashes)
      // A device that booted from a room snapshot reads items older than it by signature (lazy threads): keep that across restarts.
      if (sync.snapshot_cursor) { this.snapshotCursor = sync.snapshot_cursor; this._snapshotChains = new Map(Object.entries(sync.snapshot_chains ?? {})) }
    }
    // The lamport counter is also written with every send, before the post (review 3): the larger of the two.
    const sentLamport = (await st.get('lamport')) ?? 0
    if (Number.isSafeInteger(sentLamport) && sentLamport > (this.lamport ?? 0)) this.lamport = sentLamport
    // R4: the history boundary. A process that starts without sync state treats every command sent before it started as
    // history, not as a prompt, and keeps that boundary across restarts (a hub replaying old commands later gains nothing).
    this.historyBefore = sync ? (sync.history_before ?? null) : this.startedAt
    this.ledgerSet = new Set((await st.get('ledger')) ?? [])
    const m = this.model
    for (const [sid, rec] of Object.entries(this.roomRecord.sessions ?? {})) {
      try {
        const state = await G.verifyGrants(rec.grants.map(unb64u), this.state)
        this.sessionKeys.set(sid, { state, grants: rec.grants, secrets: new Map(rec.secrets.map(x => [x.epoch, secretFromJson(x)])), since: rec.since })
      } catch (e) { console.error('[core] stored grants of', sid, e.message) }
    }
    m._device_registers = new Map((await st.get('devregs')) ?? [])
    M.applyMembers(m, membersOf(this.state), M.emptyChange())
    const online = (await st.get('devices')) ?? []
    M.applyDevices(m, online, M.emptyChange())
    for (const [, v] of await st.range('session/')) m.sessions.set(v.session_id ?? v.agent_device_id, M.deserialiseSession(v))
    for (const [, v] of await st.range('card/')) m.cards.set(v.object_id, v)
    for (const [, v] of await st.range('perm/')) m.permissions.set(v.object_id, v)
    for (const [, v] of await st.range('memo/')) m.memos.set(v.object_id, v)
    for (const [, v] of await st.range('pub/')) m.published.set(v.object_id, v)
    for (const [, v] of await st.range('tlmeta/')) m.timelines.set(v.timeline_key, M.deserialiseTimelineMeta(v))
    const regs = await st.range('reg/')
    M.deserialiseHuman(m, { raw: regs.map(([k, v]) => [k.slice(4), v]) })
    for (const [, v] of await st.range('invite/')) {
      this.invitesPrivate.set(v.invite_id, inviteFromJson(v))
      m.invites.set(v.invite_id, v.public)
    }
    const outbox = (await st.get('outbox')) ?? []
    this.outbox = outbox
    for (const o of outbox) this.byHash.set(o.hash, o.local_id)
    m.outbox = outbox.map(o => o.public)
    for (const k of this.sessionKeys.values()) M.applySessionGrant(m, k.state, M.emptyChange(), everAgents(k), epochAgents(k))
    m._proj = null
    M.project(m, M.emptyChange())
  }

  async _saveRoom() {
    const r = this.roomRecord
    r.entries = this.state.entries.map(e => b64u(z.concat(e.body, e.signature)))
    r.pin = pinToJson(z.pinOf(this.state))
    r.secrets = [...this.secrets.values()].map(secretToJson)
    r.epoch_changed_at = this.epochChangedAt
    r.sessions = Object.fromEntries([...this.sessionKeys].map(([sid, k]) => [sid, { grants: k.grants, secrets: [...k.secrets.values()].map(secretToJson), since: k.since ?? null }]))
    await this.storage.set('room', r)
  }

  // ---- start / stop ----------------------------------------------------------------------------

  async start({ stream = true } = {}) {
    if (this._started) return
    await this._takeLock()
    this._started = true
    this._setConnection('connecting')
    await this.hub.signIn()
    await this.serial(() => this._refreshMembers())
    await this.serial(() => this._refreshSessions())
    await this.serial(() => this._healStaleSessions()).catch(e => this._localAlert('rekey', e))
    await this._refreshDevices().catch(() => {})
    this._pumpOutbox()
    await this._sendDeviceRegister()
    this._setConnection('catching_up')
    if (this.model.room.last_envelope_number === 0 && this.is_human && this.options?.snapshot !== false) {
      await bootFromSnapshot(this).catch(e => this._localAlert('snapshot', e))
    }
    await this.catchUp()
    this._maybeSnapshot()
    this._resolveRevisions().catch(e => this._localAlert('revisions', e))
    for (const [id, inv] of this.invitesPrivate) if (!inv.finalized && Date.now() < inv.expiresAt) this._watchInvite(id)
    if (stream) this._openStream()
    else this._setConnection('live')
    if (!this._onOnline && globalThis.addEventListener) { this._onOnline = () => { this.hub.wake(); this._pumpOutbox() }; globalThis.addEventListener('online', this._onOnline) }
    // Presence (is_online) goes stale otherwise: refresh the device list every minute while running.
    clearInterval(this._devicesTimer)
    this._devicesTimer = setInterval(() => { if (this._started) this._refreshDevices().catch(() => {}) }, 60_000)
    this._devicesTimer.unref?.()
    // B03: a device that slept (timers late by > 20 s) was not live; until its stream opens again it judges old-epoch
    // envelopes by signed times, not by its own wall clock.
    clearInterval(this._beatTimer)
    this._beat = Date.now()
    this._beatTimer = setInterval(() => { const n = Date.now(); if (n - this._beat > 20_000) this._liveFrom = null; this._beat = n }, 5_000)
    this._beatTimer.unref?.()
  }

  /** device/<id> right after joining; agents only once a session is assigned (they hold no room key). */
  async _sendDeviceRegister() {
    if (this.roomRecord.device_register_sent || !this.roomRecord.device_info) return
    if (!this.is_human && !this.session_id) return
    this.roomRecord.device_register_sent = true
    await this._saveRoom()
    await this.setRegisters({ [`device/${this.my_device_id}`]: this.roomRecord.device_info }, { own_device: true })
  }

  /**
   * R6: fetch the grant chains of every session (new grants only), verify them against the member list, open this
   * device's session keys (humans also walk the back links). Emits 'session' on an agent when a session is assigned to it.
   */
  async _refreshSessions() {
    let list
    try { list = (await this.hub.sessions()).sessions } catch (e) { if (e.status === 404) return; throw e }
    const change = M.emptyChange()
    const before = new Set(this.session_ids)
    for (const { session_id } of list) {
      if (!/^[0-9a-f]{32}$/.test(session_id ?? '')) continue          // not a session id: never into a URL
      const known = this.sessionKeys.get(session_id)
      const r = await this.hub.sessionGrants(session_id, known ? known.state.grantNumber : -1)
      if (!r.signed_grants.length && known) continue
      let state = known?.state ?? null
      const grants = [...(known?.grants ?? [])]
      try {
        for (const g of r.signed_grants) {
          try { state = await G.applyGrant(state, unb64u(g), this.state) }
          catch (e) { if (e.code !== 'log-behind') throw e; await this._refreshMembers(); state = await G.applyGrant(state, unb64u(g), this.state) }
          grants.push(g)
        }
      } catch (e) { M.pushAlert(this.model, change, { code: e.code ?? 'bad-grant', message: `session ${session_id.slice(0, 8)}: ${e.message}` }); continue }
      if (!state) continue
      const k = known ?? { secrets: new Map(), since: null }
      if (known && state.epoch !== known.state.epoch) k.since = Date.now()
      k.state = state; k.grants = grants
      this.sessionKeys.set(session_id, k)
      const holds = this.is_human || state.agentIds.includes(this.my_device_id)
      if (holds && !k.secrets.has(state.epoch)) {
        const wraps = await this.hub.sealedSessionKeys(session_id, 0)
        for (const w of wraps.sealed_session_keys) {
          if (k.secrets.has(w.session_key_epoch)) continue
          try {
            k.secrets.set(w.session_key_epoch, await G.unwrapSessionKey({ roomId: this.state.roomId, sessionState: state, device: this.device, sealed: unb64u(w.key_sealed), epoch: w.session_key_epoch }))
            if (this._missingKeys?.has(`${session_id}:${w.session_key_epoch}`)) this._needResync = true
          }
          catch (e) { M.pushAlert(this.model, change, { code: e.code ?? 'bad-key', message: `session key ${session_id.slice(0, 8)}/${w.session_key_epoch}: ${e.message}` }) }
        }
        await this._walkSessionBackLinks(session_id).catch(() => {})
      }
      M.applySessionGrant(this.model, state, change, everAgents(this.sessionKeys.get(session_id)), epochAgents(this.sessionKeys.get(session_id)))
    }
    await this._saveRoom()
    M.project(this.model, change)
    this._emitChange(change)
    if (!this.is_human) for (const sid of this.session_ids) if (!before.has(sid)) {
      const k = this.sessionKeys.get(sid)
      this.emit('session', { session_id: sid, with_history: !!k.state.withHistory })
      this._sendDeviceRegister().catch(e => this.emit('error', e))
    }
  }

  async _walkSessionBackLinks(session_id) {
    const k = this.sessionKeys.get(session_id)
    let low = Math.min(...k.secrets.keys())
    if (!(low > 1) || !k.secrets.get(low)?.hist) return
    const r = await this.hub.sessionBackLinks(session_id)
    const links = new Map(r.key_back_links.map(l => [l.session_key_epoch, unb64u(l.key_back_link)]))
    while (low > 1 && links.has(low) && k.secrets.get(low)?.hist) {
      const prev = await G.openSessionBackLink({ roomId: this.state.roomId, sessionState: k.state, secret: k.secrets.get(low), link: links.get(low) })
      k.secrets.set(prev.epoch, prev)
      if (this._missingKeys?.has(`${session_id}:${prev.epoch}`)) this._needResync = true
      low = prev.epoch
    }
  }

  /**
   * R4: one sealing client per device and room. In browsers a Web Lock held for the client's lifetime: a second tab
   * gets ZError 'tab-conflict' (the app says "Trommi is open in another tab"). Node processes lock their key file (channel).
   */
  async _takeLock() {
    const locks = globalThis.navigator?.locks
    if (!locks || this._lockRelease) return
    const name = `trommi-room-${this.model.room.room_id}-${this.my_device_id}`
    await new Promise((resolve, reject) => {
      locks.request(name, { ifAvailable: true }, lock => {
        if (!lock) { reject(new ZError('tab-conflict', 'this room is open in another tab or window')); return }
        resolve()
        return new Promise(release => { this._lockRelease = release })
      }).catch(reject)
    })
  }

  async stop() {
    this._lockRelease?.(); this._lockRelease = null
    this._started = false
    this._stream?.close()
    this._stream = null
    for (const inv of this.invitesPrivate.values()) clearInterval(inv._timer)
    clearInterval(this._devicesTimer); clearInterval(this._beatTimer)
    this._liveFrom = null
    clearTimeout(this._dirty.timer)
    await this.flush()
    this._setConnection('offline')
  }

  _setConnection(c) {
    if (this.model.room.connection === c) return
    this.model.room.connection = c
    const ch = M.emptyChange(); ch.room = true
    this._emitChange(ch)
  }

  _openStream() {
    this._stream = this.hub.stream({
      after_envelope_number: () => this.model.room.last_envelope_number,
      onState: (s, err) => {
        if (s === 'open') { this._liveFrom ??= Date.now(); this._setConnection('live'); this._refreshDevices().catch(() => {}) }   // presence after every (re)connect
        else if (s === 'closed') { this._liveFrom = null; this._setConnection('connecting'); if (err && err.status >= 400 && err.status !== 401) this._localAlert('stream', err) }
      },
      onEvent: ev => this._onStreamEvent(ev),
    })
  }

  async _onStreamEvent({ event, data }) {
    if (event === 'envelope') {
      if (data.envelope_number <= this.model.room.last_envelope_number) return
      if (data.envelope_number > this.model.room.last_envelope_number + 1) await this.catchUp()   // missed something: page it in
      if (data.envelope_number === this.model.room.last_envelope_number + 1) await this.processRecords([data], { live: true })
    } else if (event === 'member_entry') {
      await this.serial(() => this._refreshMembers())
      this.serial(() => this._healStaleSessions()).catch(e => this._localAlert('rekey', e))
      this._refreshDevices().catch(() => {})
    } else if (event === 'session_grant') {
      await this.serial(async () => { await this._refreshSessions(); if (this._needResync) await this._resync() })
    } else if (event === 'join_request') {
      if (data.invite_id) this._checkInvite(data.invite_id).catch(e => this._localAlert('invite', e))
    } else if (event === 'escrow_changed') {
      if (this.is_human) this._onEscrowChanged(data)
    }
  }

  /**
   * "In revision" needs the body of the newest human message on a card (hand_back / explain), which catch-up only
   * sees as a header. For open cards whose conversation has a human item newer than the card's version, fetch the
   * newest page of that conversation and settle it.
   */
  async _resolveRevisions() {
    if (!this.is_human) return
    const change = M.emptyChange()
    for (const card of this.model.cards.values()) {
      if (card.object_state !== 'open') continue
      const t = this.model.timelines.get(card.timeline_key)
      if (!t || t.newest_human_envelope_number <= card.envelope_number || card.in_revision) continue
      const items = await this._readTimeline(card.timeline_key, { before: this.model.room.last_envelope_number + 1, limit: 20 })
      let rev = null
      for (const it of items) {
        if (it.envelope_number <= card.envelope_number || !it.content) continue
        if (it.content.present_card) rev = null
        else if (this.model.members.get(it.sender_device_id)?.device_role === 'human' && (it.content.hand_back || it.content.explain)) rev = { by: it.content.hand_back ? 'hand_back' : 'explain', envelope_number: it.envelope_number }
      }
      if (rev) { card.in_revision = rev; change.cards.add(card.object_id); change.sessions.add(card.agent_device_id) }
    }
    if (change.cards.size) { this._markDirty(change, []); this._emitChange(change) }
  }

  /** Page through GET envelopes from the cursor to the hub's end. */
  async catchUp() {
    for (;;) {
      const r = await this.hub.envelopes({ after_envelope_number: this.model.room.last_envelope_number, limit: PAGE })
      if (!r.envelopes.length) break
      await this.processRecords(r.envelopes)
      if (this.model.room.last_envelope_number >= r.last_envelope_number) break
    }
  }

  // ---- membership and keys ----------------------------------------------------------------------

  async _refreshMembers({ throwOnFork = false } = {}) {
    const r = await this.hub.members({ after_entry_number: this.state.head.seq })
    const change = M.emptyChange()
    if (r.last_entry_number < this.state.head.seq) {
      M.pushAlert(this.model, change, { code: 'log-rollback', message: `the hub shows member list entry ${r.last_entry_number}, this device saw ${this.state.head.seq}` })
      this._emitChange(change)
      if (throwOnFork) throw new ZError('log-rollback', 'member list rolled back')
      return
    }
    let state = this.state, epochBefore = state.epoch
    try {
      for (const e of r.signed_entries) {
        state = await z.applyEntry(state, unb64u(e))
        // A device added by the recovery key (a passphrase sign-in, or someone holding the code): every human device says so.
        const last = state.entries.at(-1)
        if (this.is_human && last?.signerKind === z.SIGNER?.RECOVERY && last.type === z.ENTRY.ADD) {
          M.pushAlert(this.model, change, { code: 'recovery-add', message: 'a device was added with the recovery code or the passphrase: if that was not you, remove it and make a new recovery code' })
        }
      }
      const verdict = z.checkLogAgainstPin(state, pinFromJson(this.roomRecord.pin))
      if (verdict.status === 'recovery-override') M.pushAlert(this.model, change, { code: 'recovery-override', message: 'a recovery replaced the member list this device knew' })
    } catch (e) {
      M.pushAlert(this.model, change, { code: e.code ?? 'bad-entry', message: e.message })
      this._emitChange(change)
      if (throwOnFork) throw e
      return
    }
    if (state === this.state && r.signed_entries.length === 0) return
    this.state = state
    if (state.epoch !== epochBefore) this.epochChangedAt = Date.now()
    this.model.room.last_entry_number = state.head.seq
    this.model.room.key_epoch = state.epoch
    change.room = true
    M.applyMembers(this.model, membersOf(state), change)
    const me = state.members.get(b64u(this.device.id))
    if (!me || me.removedSeq !== null) {
      this.model.room.connection = 'removed'
      M.pushAlert(this.model, change, { code: 'removed', message: 'this device was removed from the room' })
      await this._saveRoom()
      this._emitChange(change)
      this._stream?.close()
      return
    }
    if (!this.secrets.has(state.epoch)) await this._fetchKeys()
    await this._saveRoom()
    this._emitChange(change)
  }

  async _fetchKeys() {
    const have = Math.max(0, ...this.secrets.keys())
    const r = await this.hub.sealedRoomKeys(have)
    for (const k of r.sealed_room_keys) {
      if (this.secrets.has(k.key_epoch)) continue
      this.secrets.set(k.key_epoch, await z.unwrapEpochKey(this.state, this.device, unb64u(k.key_sealed), k.key_epoch))
    }
    if (this.is_human) await this._walkBackLinks()
  }

  /** Human devices: open the back links down to epoch 1, so history from before joining can be read. */
  async _walkBackLinks() {
    let low = Math.min(...this.secrets.keys())
    if (low <= 1) return
    const r = await this.hub.keyBackLinks()
    const links = new Map(r.key_back_links.map(l => [l.key_epoch, unb64u(l.key_back_link)]))
    while (low > 1 && links.has(low) && this.secrets.get(low)?.hist) {
      const prev = await z.openBackLink(this.state, this.secrets.get(low), links.get(low))
      this.secrets.set(prev.epoch, prev)
      low = prev.epoch
    }
  }

  async _refreshDevices() {
    const r = await this.hub.devices()
    const change = M.emptyChange()
    M.applyDevices(this.model, r.devices, change)
    await this.storage.set('devices', r.devices.map(d => ({ device_id: d.device_id, is_online: d.is_online, agent_session_id: d.agent_session_id ?? null })))
    this._emitChange(change)
  }

  // ---- the sync engine -------------------------------------------------------------------------

  /**
   * Process records { envelope_number, envelope(b64u) } in hub order. Verifies every header chain (pruned forms
   * included), decrypts what came in full, reduces into the model, persists the touched records in one write.
   */
  processRecords(records, opts = {}) {
    return this.serial(async () => {
      await this._processBatch(records, opts)
      if (this._needResync) await this._resync()
    })
  }
  async _processBatch(records, { live = false } = {}) {
    this._liveBatch = live && !this._resyncing
    {
      const change = M.emptyChange()
      const tl = []                      // timeline item records to persist
      const commands = []                // agents: commands in order
      let t0 = performance.now(), tStart = t0
      const todo = records.filter(r => r.envelope_number > this.model.room.last_envelope_number)
      const WINDOW = 64
      let window = [], wAt = 0
      for (let i = 0; i < todo.length; i++) {
        const r = todo[i]
        if (i >= wAt + window.length) {
          wAt = i; window = await Promise.all(todo.slice(i, i + WINDOW).map(x => this._precheck(x)))
          // A session key this device should hold but has not fetched yet (a grant just arrived): fetch, then open again.
          if (window.some(p => p.needKeys)) {
            await this._refreshSessions().catch(e => this._localAlert('sessions', e))
            window = await Promise.all(window.map((p, j) => (p.needKeys ? this._precheck({ ...todo[i + j], retried: true }).then(q => (q.retriedKeys = true, q)) : p)))
          }
        }
        const pre = window[i - wAt]
        try {
          const rec = await this._commit(pre)
          if (pre.missingKey) (this._missingKeys ??= new Set()).add(pre.missingKey)
          if (rec && rec.object && (rec.kind === codec.KIND.object_version || rec.kind === codec.KIND.permission_request)) {
            rec.object_id_ok = (await objectIdOf(rec.sender_device_id, rec.sender_sequence)) === rec.object.object_id
          }
          if (rec) {
            const cmd = this.model.room.my_role === 'agent' ? this._preAuthorise(rec) : null
            const result = M.applyRecord(this.model, rec, change)
            if (rec.kind === codec.KIND.timeline_item) tl.push(rec)
            if (cmd) commands.push({ ...cmd, applied: result.applied, refused: cmd.refused ?? (rec.is_head && !result.applied ? result.refused : null) })
          }
        } catch (e) {
          if (globalThis.process?.env?.CORE_DEBUG) console.error('[rec]', e.stack.split('\n').slice(0, 5).join(' | '))
          M.pushAlert(this.model, change, { code: e.code ?? 'internal', message: e.message, envelope_number: r.envelope_number })
          // L10: a gap would silence that sender on this device for good: replay the room once (at most every 10 minutes).
          if (e.code === 'gap' && !this._resyncing && Date.now() - (this._lastGapResync ?? 0) > 10 * 60_000) { this._lastGapResync = Date.now(); this._needResync = true }
        }
        this.model.room.last_envelope_number = r.envelope_number
        if (performance.now() - t0 > YIELD_MS) { await yieldNow(); t0 = performance.now() }
      }
      this.stats.verify_ms += performance.now() - tStart
      this.stats.batches++
      change.room = true
      M.project(this.model, change)
      this._markDirty(change, tl)
      this._emitChange(change)
      if (commands.length) await this._deliverCommands(commands)
      if (live) this._maybeSnapshot()
    }
  }

  /** Human devices write a room snapshot every SNAPSHOT_EVERY envelopes (counted from the newest one anyone wrote). */
  _maybeSnapshot() {
    if (!this.is_human || this._snapshotting || this._resyncing || this.options?.snapshot === false) return
    const latest = Math.max(this.model.human.raw.get('room_snapshot')?.value?.envelope_number ?? 0, this._lastSnapshotAt ?? 0, this.snapshotCursor ?? 0)
    if (this.model.room.last_envelope_number - latest < (this.options?.snapshot_every ?? SNAPSHOT_EVERY)) return
    this._snapshotting = true
    setTimeout(() => writeSnapshot(this).catch(e => this._localAlert('snapshot', e)).finally(() => { this._snapshotting = false }), 50 + Math.random() * 2000)
  }
  writeSnapshot() { return writeSnapshot(this) }

  /**
   * Keys arrived for epochs this device already saw envelopes of without being able to open them (a grant with
   * history, a re-seal that came after a join): replay the room from the start, verifying everything again. The
   * own chain for sealing is kept aside; commands already delivered stay delivered.
   */
  async _resync() {
    this._needResync = false
    const me = b64u(this.device.id)
    const own = this.chains.get(me)
    const keep = this.model
    const m = M.emptyModel()
    Object.assign(m.room, keep.room, { last_envelope_number: 0 })
    m.members = keep.members; m.invites = keep.invites; m.outbox = keep.outbox; m._device_registers = keep._device_registers
    for (const k of this.sessionKeys.values()) M.applySessionGrant(m, k.state, M.emptyChange(), everAgents(k), epochAgents(k))
    this.model = m
    this.chains = new Map()
    this.frontiers = new Map()
    this._missingKeys = new Set()
    this._resyncing = true
    try {
      for (;;) {
        const r = await this.hub.envelopes({ after_envelope_number: this.model.room.last_envelope_number, limit: PAGE })
        if (!r.envelopes.length) break
        await this._processBatch(r.envelopes)
        if (this.model.room.last_envelope_number >= r.last_envelope_number) break
      }
    } finally {
      this._resyncing = false
      if (own) this.chains.set(me, own)
      this._dirty.chains.add(me)
    }
    M.project(this.model, M.emptyChange())
    const ch = M.emptyChange()
    for (const k of ['cards', 'sessions', 'permissions', 'memos', 'published', 'timelines']) for (const id of this.model[k].keys()) ch[k].add(id)
    ch.members = ch.stack = ch.room = true
    this._markDirty(ch, [])
    await this.flush()
    this.stats.resyncs = (this.stats.resyncs ?? 0) + 1
    this._emitChange(ch)
  }

  /**
   * Phase 1, run for many records at once (signatures and decryption run in parallel inside WebCrypto):
   * everything that does not depend on the sender's chain. Uses an empty chain map, so no chain advances here.
   */
  async _precheck({ envelope_number, envelope, void: isVoid = false, void_code = null }) {
    const bytes = unb64u(envelope)
    const pre = { envelope_number, bytes, peek: null, v: null, opened: null, content_state: 'ok', error: null, void: !!isVoid, void_code: isVoid ? void_code : null, stale: false }
    try {
      const peek = pre.peek = z.peekEnvelope(bytes)
      const h = peek.header
      if (hex(h.sender) === this.my_device_id && !this._resyncing) return pre          // own envelopes: checked against our own chain in phase 2
      // B03: the epoch cutoff is decided here (_isStale), not inside verify: a stale envelope is still verified and moves
      // its sender's chain on (no gap, so no resync that would apply it after all), but it is never applied.
      if (!pre.void) pre.stale = this._isStale(h)
      const opts = { state: this.state, chains: new Map(), allowChainStart: true, allowRemovedSender: true, commit: false, freshness: null }
      if (!peek.pruned) {
        try {
          pre.opened = await z.openEnvelope(bytes, { ...opts, secrets: this.openKeys, self: this.device.id })
          pre.v = pre.opened
          if (pre.opened.quarantined) { pre.opened = null; pre.content_state = 'undecryptable' }   // signature and chain good, body broken (R4)
        } catch (e) {
          if (e.code === 'no-key' && e.keyScope === 1 && !pre.retriedKeys) pre.needKeys = true
          if (!['no-key', 'decrypt-failed', 'kind-mismatch', 'bad-format', 'bad-version'].includes(e.code)) throw e
          if (e.code === 'no-key') pre.missingKey = e.keyScope === 1 ? `${hex(e.sessionId)}:${e.epoch}` : `room:${e.epoch}`
          pre.v = await z.verifyEnvelope(bytes, opts)            // signature good, body unreadable: quarantine the body (R4)
          pre.content_state = 'undecryptable'
        }
      } else {
        pre.v = await z.verifyEnvelope(bytes, opts)
        pre.content_state = h.isHead ? 'pruned' : 'header'
      }
    } catch (e) { pre.error = e; if (globalThis.process?.env?.CORE_DEBUG) console.error("[pre]", e.stack.split("\n").slice(0, 4).join(" | ")) }
    return pre
  }

  /**
   * R3 on clients (B03/A7, completed in review 3): is this envelope in an older key epoch of its scope past the grace?
   * - Live, on a device whose stream has been open since before it learned of the change (`since`): by its own clock,
   *   EPOCH_GRACE_MS after `since` (what the hub does; a late delivery by a hostile hub is refused).
   * - Otherwise (catch-up after sleep or offline, a resync, a fresh device reading history): by signed times, so a
   *   device that slept refuses nothing the honest hub accepted: the sender's signed `time` must lie within
   *   EPOCH_GRACE_MS + SIGNED_SKEW_MS of the signed time of the entry or grant that started the next epoch.
   * - An envelope refused as stale once stays refused (its hash is kept), also in a resync.
   */
  _isStale(h, hashHex = null) {
    if (hashHex && this._staleHashes?.has(hashHex)) return true
    const info = this._epochInfo(h)
    if (!info || h.epoch >= info.current) return false
    if (this._liveBatch && this._started && !this._resyncing && info.since != null && this._liveFrom != null && this._liveFrom <= info.since)
      return Date.now() - info.since > z.EPOCH_GRACE_MS
    const changedAt = info.signedAt(h.epoch + 1)
    if (changedAt == null) return false
    return h.time - changedAt > z.EPOCH_GRACE_MS + SIGNED_SKEW_MS
  }
  /** The scope's current epoch, when this device learned of it, and the signed start time of an epoch. */
  _epochInfo(h) {
    if (h.keyScope === 1) {
      const k = h.sessionId ? this.sessionKeys.get(hex(h.sessionId)) : null
      if (!k?.state) return null
      return { current: k.state.epoch, since: k.since ?? null, signedAt: e => epochStartTime(k, e) }
    }
    const state = this.state
    return { current: state.epoch, since: this.epochChangedAt ?? null, signedAt: e => { const at = state.epochs.get(e); return at ? (state.entries.find(x => x.seq === at.seq)?.time ?? null) : null } }
  }
  /** A void record from another sender: is the hub's reason one this device can re-check from the signed header? */
  _voidPlausible(h, code) {
    if (code === 'wrong-epoch') { const info = this._epochInfo(h); return !!info && h.epoch !== info.current }
    if (code === 'forbidden') {
      const role = this.state.members.get(b64u(h.sender))?.role
      if (role !== z.ROLE.AGENT) return false
      if (h.keyScope !== 1) return true                                    // agents hold no room key
      const k = h.sessionId ? this.sessionKeys.get(hex(h.sessionId)) : null
      const at = k ? epochAgents(k)?.[h.epoch] : null
      return !!at && !at.includes(hex(h.sender))                            // not assigned at that session key epoch
    }
    return false
  }
  _rememberStale(hashHex) {
    const s = (this._staleHashes ??= new Set())
    s.add(hashHex)
    if (s.size > 4096) s.delete(s.values().next().value)
  }

  /**
   * Phase 2, strictly in hub order: the sender's chain (crypto/FORMAT.md §9 step 6 and 7, the same rules as
   * zcrypto's verifyEnvelope) and our own envelopes. Returns the reducer record, or null for a replay.
   */
  async _commit(pre) {
    if (pre.error?.code === 'log-behind') { await this._refreshMembers(); Object.assign(pre, await this._precheck({ envelope_number: pre.envelope_number, envelope: b64u(pre.bytes) })) }
    if (pre.error) throw pre.error
    const { peek } = pre
    const h = peek.header
    const sender = hex(h.sender)
    const key = b64u(h.sender)
    if (sender === this.my_device_id && !this._resyncing) {
      const own = this.chains.get(key)
      const known = own?.hashes.get(h.seq)
      if (!known) throw new ZError('equivocation', `an envelope in this device's name that it did not send (#${h.seq})`)
      const localId = this.byHash.get(hex(known))
      if (pre.void) {                                // the hub refused it and kept it as a void record: never applied
        if (!this._voidedOwn?.has(hex(known)) && localId) this._localAlert('hub-voided', new ZError('hub-voided', `the hub voided envelope #${h.seq} after accepting it`))
        this.byHash.delete(hex(known)); this.sentContent.delete(hex(known))
        return null
      }
      let v, opened = null, content_state = 'ok'
      if (!peek.pruned) {
        opened = await z.openVerifiedEnvelope(pre.bytes, { state: this.state, secrets: this.openKeys, envelopeHash: known, self: this.device.id })
        v = { header: opened.header, hash: opened.hash, member: opened.member }
      } else {
        const got = await z.hash(z.LABEL.envelope, peek.headerBytes, peek.nonce, peek.ciphertextHash)
        if (!z.bytesEqual(got, known)) throw new ZError('equivocation', `the hub shows another envelope #${h.seq} in this device's name`)
        v = { header: h, hash: known, member: null }
        content_state = h.isHead ? 'pruned' : 'header'
      }
      this.stats.verified++
      const rec = this._record(pre.envelope_number, v, opened, content_state, localId)
      const sent = this.sentContent.get(rec.envelope_hash)
      if (sent && !rec.content) { rec.content = sent; rec.content_state = 'ok' }
      this.sentContent.delete(rec.envelope_hash)
      return rec
    }
    const v = pre.v
    const hash = v.hash
    const chain = this.chains.get(key)
    if (!chain) {
      if (h.seq !== 1) throw new ZError('gap', `first envelope seen from this sender has number ${h.seq}`, { have: 0, got: h.seq })
      if (!h.prev.every(b => b === 0)) throw new ZError('chain-break', 'the first envelope names a predecessor')
    } else if (h.seq <= chain.seq) {
      const known = chain.hashes.get(h.seq)
      if (known && !z.bytesEqual(known, hash)) throw new ZError('equivocation', `two different envelopes with number ${h.seq} from one sender`)
      return null                                                   // replay: already processed
    } else if (h.seq > chain.seq + 1) {
      throw new ZError('gap', `envelope ${h.seq} arrived, ${chain.seq + 1} is missing`, { have: chain.seq, got: h.seq })
    } else if (!z.bytesEqual(h.prev, chain.hash)) {
      throw new ZError('chain-break', 'the predecessor hash does not match the envelope accepted before')
    }
    for (const s of h.seen) {
      const known = this.chains.get(b64u(s.sender))?.hashes.get(s.seq)
      if (known && !z.bytesEqual(known, s.hash)) throw new ZError('equivocation', 'the sender saw a different envelope than this device under the same number')
    }
    const c = chain ?? { seq: 0, hash: null, hashes: new Map() }
    c.seq = h.seq; c.hash = hash; c.hashes.set(h.seq, hash)
    this.chains.set(key, c)
    trimChain(c)
    this._dirty.chains.add(key)
    this.stats.verified++
    if (pre.void) {
      // A void record: the chain moves on, nothing applies. Review 3: the void flag is the hub's word, not the sender's,
      // so a hub could drop any envelope quietly that way. Only a reason this device can re-check from the signed header
      // passes silently; any other void from another sender is shown (like the gap it would have been before).
      this._advanceFrontier(sender, h)
      if (!this._voidPlausible(h, pre.void_code)) {
        const ch = M.emptyChange()
        M.pushAlert(this.model, ch, { code: 'hub-voided-other', message: `the hub withheld envelope #${h.seq} of this sender as void (${pre.void_code ?? 'no reason'})`, envelope_number: pre.envelope_number, sender_device_id: sender })
        this._emitChange(ch)
      }
      return null
    }
    if (pre.stale || this._staleHashes?.has(hex(hash))) {
      // B03: verified and in chain order, but sent in an old key epoch past the grace: the chain moves on, the body never applies.
      this._rememberStale(hex(hash))
      this._advanceFrontier(sender, h)
      const ch = M.emptyChange()
      M.pushAlert(this.model, ch, { code: 'wrong-epoch', message: `envelope #${h.seq} was sent in an outdated key epoch: ignored`, envelope_number: pre.envelope_number, sender_device_id: sender })
      this._emitChange(ch)
      return null
    }
    if (pre.opened) this.stats.decrypted++
    return this._record(pre.envelope_number, v, pre.opened, pre.content_state, null)
  }

  /** R2: carry each sender's view of the others forward (seen lists only what changed, R5). */
  _advanceFrontier(sender, h) {
    let f = this.frontiers.get(sender)
    if (!f) this.frontiers.set(sender, f = new Map())
    for (const s of h.seen) { const o = hex(s.sender); if ((f.get(o) ?? 0) < s.seq) f.set(o, s.seq) }
    f.set(sender, h.seq)
    return f
  }

  _record(envelope_number, v, opened, content_state, local_id) {
    const h = v.header
    const sender = hex(h.sender)
    const frontier = this._advanceFrontier(sender, h)
    let content = null, bind = null
    if (opened) {
      const d = decodeOpened(opened, h)
      content = d.content; content_state = d.content_state
      try { bind = codec.decodeBindFor(opened.kind, opened.bind) } catch { bind = null }
    }
    let lamport = M.lamportOf(content)
    const claimed = typeof content?.lamport === 'number' && content.lamport > 0 ? content.lamport : 0
    if (claimed && !(lamport && M.lamportAccepted(lamport, this.lamport))) {
      // Review 3: inflated far beyond anything this device has seen: refused (counts as 0, not adopted).
      const ch = M.emptyChange()
      M.pushAlert(this.model, ch, { code: 'lamport-inflated', message: `a write claims lamport ${claimed}, far above ${this.lamport ?? 0}: ignored`, envelope_number, sender_device_id: sender })
      this._emitChange(ch)
      lamport = 0
    }
    if (lamport > (this.lamport ?? 0)) this.lamport = lamport
    const member = this.state.members.get(b64u(h.sender))
    return {
      envelope_number, envelope_hash: hex(v.hash), sender_device_id: sender, sender_role: member ? roleName(member.role) : 'unknown',
      recipient_device_id: h.recipient.every(b => b === 0) ? null : hex(h.recipient), sent_at: h.time, kind: h.kind, is_head: h.isHead,
      object: h.card ? { object_id: hex(h.card.id), object_state: h.card.state, urgency: h.card.urgency, answered_at: h.card.answeredAt } : null,
      timeline_kind: h.timelineKind ? (codec.TIMELINE_KIND_NAME[h.timelineKind] ?? String(h.timelineKind)) : null, timeline_id: h.timelineId,
      session_id: h.keyScope === 1 && h.sessionId ? hex(h.sessionId) : null,
      attachment_ids: h.blobs.map(hex), content, content_state, bind, local_id: local_id ?? null,
      causal: { sender_device_id: sender, sender_sequence: h.seq, sent_at: h.time, lamport },
      sender_sequence: h.seq,
      _header: h, _bind: opened?.bind ?? null, _epoch: h.epoch,
      object_id_ok: v.object_id_ok ?? null,
      ...(local_id ? this._undoEcho(local_id, v.hash) : {}),
    }
  }

  // ---- persistence -------------------------------------------------------------------------------

  _markDirty(change, tlRecs) {
    const d = this._dirty.records
    const m = this.model
    for (const id of change.cards) { const c = m.cards.get(id); if (c) d.set(`card/${id}`, c) }
    for (const id of change.sessions) { const s = m.sessions.get(id); if (s) d.set(`session/${id}`, M.serialiseSession(s)) }
    for (const id of change.permissions) { const p = m.permissions.get(id); if (p) d.set(`perm/${id}`, p) }
    for (const id of change.memos) { const x = m.memos.get(id); if (x) d.set(`memo/${id}`, x) }
    for (const id of change.published) { const x = m.published.get(id); if (x) d.set(`pub/${id}`, x) }
    for (const key of change.timelines) { const t = m.timelines.get(key); if (t) d.set(`tlmeta/${key}`, M.serialiseTimelineMeta(t)) }
    for (const key of change.registers) {
      if (key.startsWith('device/')) d.set('devregs', [...(m._device_registers ?? [])])
      else if (m.human.raw.has(key) && !m.human.raw.get(key).pending) d.set(`reg/${key}`, m.human.raw.get(key))
    }
    for (const rec of tlRecs) {
      const key = M.timelineKey(rec.timeline_kind, rec.timeline_id)
      d.set(`tl/${key}/${pad(rec.envelope_number)}`, { n: rec.envelope_number, h: rec.envelope_hash, s: rec.sender_device_id, q: rec.sender_sequence, r: rec.recipient_device_id, t: rec.sent_at, c: rec.content, cs: rec.content_state })
    }
    if (!this._dirty.timer) this._dirty.timer = setTimeout(() => { this._dirty.timer = null; this.flush().catch(e => this.emit('error', e)) }, PERSIST_DELAY_MS)
  }

  _syncRecord() {
    return { cursor: this.model.room.last_envelope_number, delivered: Object.fromEntries(this.delivered), history_before: this.historyBefore ?? null, lamport: this.lamport ?? 0,
      ...(this._staleHashes?.size ? { stale_hashes: [...this._staleHashes] } : {}),
      ...(this.snapshotCursor ? { snapshot_cursor: this.snapshotCursor, snapshot_chains: Object.fromEntries(this._snapshotChains ?? []) } : {}),
      frontiers: Object.fromEntries([...this.frontiers].map(([k, m]) => [k, Object.fromEntries(m)])) }
  }

  /** The executed-command ledger (R4): the channel marks a command executed; survives restarts. */
  get ledger() {
    return {
      has: hash => this.ledgerSet.has(hash),
      mark: async hash => {
        this.ledgerSet.add(hash)
        if (this.ledgerSet.size > 5000) this.ledgerSet.delete(this.ledgerSet.values().next().value)
        await this.storage.set('ledger', [...this.ledgerSet])
      },
    }
  }

  /** Write everything dirty in one transaction, with the cursor and the touched chains. */
  async flush() {
    clearTimeout(this._dirty.timer); this._dirty.timer = null
    const entries = [...this._dirty.records]
    this._dirty.records = new Map()
    for (const k of this._dirty.chains) { const c = this.chains.get(k); if (c) entries.push([`chain/${k}`, chainToJson(c)]) }
    this._dirty.chains = new Set()
    entries.push(['sync', this._syncRecord()])
    await this.storage.setMany(entries)
    if (this.storage.flush) await this.storage.flush()
  }

  // ---- sending: seal, echo, outbox ------------------------------------------------------------

  /**
   * Seal one envelope and queue it. opts: { kind, content, bind, recipient, object: { object_id, object_state, urgency, answered_at },
   * timeline: { timeline_kind, timeline_id }, push, echo: () => undo }. Returns { local_id, envelope_hash }.
   */
  async _send({ kind, content, bind = null, recipient = null, object = null, timeline = null, push = false, echo = null, after = null, session_id = null }) {
    const local_id = `local-${randomHex(8)}`
    if (echo) {
      const undo = echo(local_id)
      if (undo) this.echoes.set(local_id, undo)
    }
    return this.serial(async () => {
      try {
        if (this._storageFailed) throw new ZError('storage-failed', 'storage failed earlier: restart before sending')
        if (typeof content === 'function') { const built = await content(); content = built.content; object = built.object ?? object; bind = built.bind ?? bind; session_id = built.session_id ?? session_id }
        // R2: registers and memos carry a lamport one above every one this device has seen (compareWrites).
        if (kind === codec.KIND.status || (kind === codec.KIND.object_version && content?.object_type === 'memo')) { this.lamport = (this.lamport ?? 0) + 1; content = { ...content, lamport: this.lamport } }
        const payload = codec.encodePayload(kind, content)
        if (payload.length > 60_000) throw new ZError('too-large', 'body over 60 KB: put it into an attachment')
        if (kind === codec.KIND.status && payload.length + (bind?.length ?? 0) + 16 > 4096) throw new ZError('too-large', 'a status body is at most 4 KiB')
        const blobs = codec.attachmentIdsOf(content).map(unhex)
        if (session_id) await this._awaitFreshSession(session_id)
        const { secret, scope } = this.keyFor({ kind, object, timeline, recipient, session_id })
        if (!secret) throw new ZError('no-key', 'no key for the current epoch')
        const sealed = await z.sealEnvelope({
          device: this.device, state: this.state, secret, chains: this.chains, ...scope, kind, payload, bind: bind ?? new Uint8Array(0),
          recipient: recipient ? unhex(recipient) : null, push, blobs,
          card: object ? { id: unhex(object.object_id), state: codec.OBJECT_STATE[object.object_state] ?? 1, urgency: codec.URGENCY[object.urgency] ?? 1, answeredAt: object.answered_at ?? 0 } : null,
          timelineKind: timeline ? codec.TIMELINE_KIND[timeline.timeline_kind] ?? timeline.timeline_kind : null, timelineId: timeline?.timeline_id ?? null,
        })
        const hashHex = hex(sealed.hash)
        this.sentContent.set(hashHex, content)
        if (after) after(sealed, content)
        const echoItem = this._echoItems.get(local_id)
        if (echoItem) echoItem.sender_sequence = sealed.seq
        const pub = { local_id, envelope_kind: codec.KIND_NAME[kind], object_id: object?.object_id ?? null, timeline_key: timeline ? M.timelineKey(timeline.timeline_kind, timeline.timeline_id) : null,
          recipient_device_id: recipient, content, outbox_state: 'sending', error: null }
        const item = { local_id, bytes: b64u(sealed.bytes), seq: sealed.seq, hash: hashHex, prev: b64u(sealed.header.prev), public: pub,
          args: { kind, content, bind: bind?.length ? b64u(bind) : null, recipient, object, timeline, push, session_id } }
        this.outbox.push(item)
        this.byHash.set(hashHex, local_id)
        this.model.outbox.push(pub)
        // The own chain and the outbox reach storage before the hub sees the envelope: a crash must not reuse a number.
        const me = b64u(this.device.id)
        // The lamport counter goes with it (review 3): a crash must not hand out one lamport twice.
        try { await this.storage.setMany([['outbox', this.outbox], [`chain/${me}`, chainToJson(this.chains.get(me))], ['lamport', this.lamport ?? 0]], { durable: true }) }
        catch (e) {
          // Not on disk: never post it (a crash would reuse its number). This device stops sending until restarted.
          this.outbox.splice(this.outbox.indexOf(item), 1); this.model.outbox.splice(this.model.outbox.indexOf(pub), 1)
          this._storageFailed = e
          this.emit('error', new ZError('storage-failed', `could not save before sending: ${e.message}`))
          throw new ZError('storage-failed', `could not save before sending: ${e.message}`)
        }
        const ch = M.emptyChange(); ch.outbox = true; this._emitChange(ch)
        this._pumpOutbox()
        return { local_id, envelope_hash: hashHex, seq: sealed.seq }
      } catch (e) {
        this._rollbackEcho(local_id)
        throw e
      }
    })
  }

  _pumpOutbox() {
    if (this._pump) return this._pump
    this._pump = (async () => {
      await null
      let backoff = 300, leaseRetried = false
      while (this.outbox.length) {
        const item = this.outbox[0]
        try {
          if (!this.is_human && this.hub.lease_generation == null) await this.claimSession()   // agents post under their lease (R4)
          const r = await this.hub.postEnvelope(item.bytes)
          item.envelope_number = r.envelope_number
          leaseRetried = false
          if (this.model.room.outbox_blocked) { this.model.room.outbox_blocked = null; const ch = M.emptyChange(); ch.room = true; this._emitChange(ch) }
          this._acked(item)
          backoff = 300
        } catch (e) {
          if (globalThis.process?.env?.CORE_DEBUG) console.error('[core] post', e.code, e.message)
          if (e.code === 'replay') { this._acked(item); continue }
          if (e.code === 'lease-lost') { if (!leaseRetried && await this._recoverLease()) { leaseRetried = true; continue } this._leaseRecovery = null; this._leaseRecoveryFailed = true; this.hub.onLeaseLost(e); break }
          if (e.code === 'gap') {
            for (const old of this.recentSent) { try { await this.hub.postEnvelope(old.bytes) } catch {} }
            await sleep(backoff); backoff = Math.min(backoff * 2, 10_000)
            continue
          }
          if (e.status === 0 || e.status >= 500 || e.status === 429 || e.code === 'unauthorised' || e.code === 'stale-session-key') {
            await sleep(e.retry_after ? e.retry_after * 1000 : backoff); backoff = Math.min(backoff * 2, 2_000)   // a restarting hub: retry soon
            if (!this._started && e.status === 0) break
            continue
          }
          // Refused for good. A signed sequence number is never reused (D2): the own chain is NOT wound back.
          if (e.body?.voided) {
            // The hub stored it as a void record (header only, counted, never applied): the chain goes on behind it.
            await this.serial(async () => {
              item.public.outbox_state = 'failed'; item.public.error = e.code
              this._rollbackEcho(item.local_id)
              this.sentContent.delete(item.hash)
              ;(this._voidedOwn ??= new Set()).add(item.hash)
              this._acked(item)
              const ch = M.emptyChange()
              M.pushAlert(this.model, ch, { code: e.code ?? 'refused', message: `the hub refused an envelope: ${e.message}` })
              this._emitChange(ch)
            })
            continue
          }
          // Not voided: keep the bytes, halt this device's sending (everything behind it waits), retry the same bytes
          // now and then (a refusal can depend on state that changes). Never sign another envelope at this number.
          if (!this.model.room.outbox_blocked || this.model.room.outbox_blocked.local_id !== item.local_id) {
            item.public.outbox_state = 'blocked'; item.public.error = e.code
            this.model.room.outbox_blocked = { local_id: item.local_id, code: e.code ?? 'refused', message: e.message ?? '' }
            const ch = M.emptyChange(); ch.outbox = true; ch.room = true
            M.pushAlert(this.model, ch, { code: 'chain-halted', message: `the hub refused an envelope (${e.code}): ${e.message}. Sending is halted; the same envelope is retried.` })
            this._emitChange(ch)
          }
          for (let t = 0; t < BLOCKED_RETRY_MS && this._started; t += 250) await sleep(250)
          if (!this._started) break
        }
      }
      this._pump = null
    })()
    return this._pump
  }

  _acked(item) {
    this.outbox.shift()
    this.recentSent.push(item)
    if (this.recentSent.length > 32) this.recentSent.shift()
    const at = this.model.outbox.indexOf(item.public)
    if (at >= 0) this.model.outbox.splice(at, 1)
    this.storage.set('outbox', this.outbox).catch(() => {})
    const ch = M.emptyChange(); ch.outbox = true; this._emitChange(ch)
  }

  /** Wait until the outbox is empty and the hub's copies came back through sync. */
  async settle({ timeout_ms = 10_000 } = {}) {
    const until = Date.now() + timeout_ms
    while (Date.now() < until) {
      if (this.model.room.outbox_blocked) throw new ZError('chain-halted', `sending is halted: the hub refused an envelope (${this.model.room.outbox_blocked.code})`)
      await this._queue
      if (this._pump) await Promise.race([this._pump, sleep(50)])   // a halted pump waits long: look at outbox_blocked again soon
      if (!this.outbox.length && this.byHash.size === 0) return
      if (!this._stream || this.model.room.connection !== 'live') await this.catchUp()
      else await sleep(10)
    }
    throw new ZError('timeout', `outbox not settled (${this.outbox.length} waiting, ${this.byHash.size} not echoed)`)
  }

  _undoEcho(local_id, hashBytes) {
    this.byHash.delete(hex(hashBytes))
    const undo = this.echoes.get(local_id)
    this.echoes.delete(local_id)
    if (undo) undo({ confirmed: true })
    return {}
  }
  _rollbackEcho(local_id) {
    const undo = this.echoes.get(local_id)
    this.echoes.delete(local_id)
    if (!undo) return
    const ch = undo({ confirmed: false }) ?? M.emptyChange()
    M.project(this.model, ch)
    this._emitChange(ch)
  }

  // echo helpers: apply now, return an undo
  _echoTimelineItem(timeline, content, recipient, object_id) {
    return local_id => {
      const key = M.timelineKey(timeline.timeline_kind, timeline.timeline_id)
      const t = M.timelineOf(this.model, key)
      const item = { envelope_number: null, local_id, pending: true, envelope_hash: null, sender_device_id: this.my_device_id, sender_sequence: null, recipient_device_id: recipient, sent_at: Date.now(),
        item_state: 'loaded', content_type: content.content_type, content }
      t.items.set(local_id, item)
      this._echoItems.set(local_id, item)
      const ch = M.emptyChange(); ch.timelines.add(key); M.addItem(ch, key, item)
      if (object_id) ch.cards.add(object_id)
      this._emitChange(ch)
      return ({ confirmed }) => {
        this._echoItems.delete(local_id)
        if (!confirmed) { t.items.delete(local_id); const c = M.emptyChange(); c.timelines.add(key); return c }
        // confirmed: the reducer replaces the item in place (same local_id); keep the echo until then.
      }
    }
  }
  _echoRegisters(values) {
    return local_id => {
      const ch = M.emptyChange()
      const before = new Map()
      for (const [k, v] of Object.entries(values)) {
        if (!isHumanRegisterKey(k)) continue
        before.set(k, this.model.human.raw.get(k))
        M.setHumanRegister(this.model, k, v, { envelope_number: null, sender_device_id: this.my_device_id, pending: true }, ch)
      }
      M.project(this.model, ch)
      this._emitChange(ch)
      return ({ confirmed }) => {
        if (confirmed) return
        const c = M.emptyChange()
        for (const [k, old] of before) M.setHumanRegister(this.model, k, old?.value ?? null, { envelope_number: old?.envelope_number ?? null, sender_device_id: old?.by_device_id ?? null }, c)
        return c
      }
    }
  }
  _echoAnswer(object_id, answer, state) {
    return local_id => {
      const card = this.model.cards.get(object_id)
      if (!card) return null
      const saved = { answer: card.answer, object_state: card.object_state, closed_how: card.closed_how }
      card.answer = { ...answer, pending: true, local_id }
      card.object_state = state
      const ch = M.emptyChange(); ch.cards.add(object_id); ch.sessions.add(card.agent_device_id)
      M.project(this.model, ch)
      this._emitChange(ch)
      // The real answer is judged against the card as it was: undo first in either case.
      return () => { Object.assign(card, saved); const c = M.emptyChange(); c.cards.add(object_id); return c }
    }
  }

  _localAlert(where, e) {
    const ch = M.emptyChange()
    M.pushAlert(this.model, ch, { code: e.code ?? where, message: `${where}: ${e.message}` })
    this._emitChange(ch)
  }

  // ---- timelines: lazy, newest first ---------------------------------------------------------

  /** Load the next older page of a timeline into the window: from storage when the bodies are cached, else GET threads. */
  async loadTimeline(timeline_key, { limit = 50 } = {}) {
    const t = M.timelineOf(this.model, timeline_key)
    t.window_open = true
    const before = Number.isFinite(t.loaded_down_to) ? t.loaded_down_to : this.model.room.last_envelope_number + 1
    const items = await this._readTimeline(timeline_key, { before, limit })
    for (const it of items) t.items.set(it.envelope_number, it)
    if (items.length) t.loaded_down_to = Math.min(t.loaded_down_to, items[0].envelope_number)
    const olderKnown = await this.storage.range(`tl/${timeline_key}/`, { before: `tl/${timeline_key}/${pad(t.loaded_down_to)}`, limit: 1, reverse: true })
    t.has_more = olderKnown.length > 0 || this._hubHasMore
    const ch = M.emptyChange(); ch.timelines.add(timeline_key)
    for (const it of items) M.addItem(ch, timeline_key, it)
    this._emitChange(ch)
    return { loaded: items.length, has_more: t.has_more }
  }

  /** A windowed read for scrolling: items oldest first, before an envelope number, bodies fetched as needed. Does not grow the window. */
  async timelineWindow(timeline_key, { before_envelope_number = Infinity, limit = 50 } = {}) {
    const before = Number.isFinite(before_envelope_number) ? before_envelope_number : this.model.room.last_envelope_number + 1
    return this._readTimeline(timeline_key, { before, limit })
  }

  async _readTimeline(timeline_key, { before, limit }) {
    if (this._dirty.records.size) await this.flush()
    const prefix = `tl/${timeline_key}/`
    let recs = (await this.storage.range(prefix, { before: prefix + pad(before), limit, reverse: true })).map(([, v]) => v)
    const missing = recs.filter(r => !r.c && r.cs !== 'pruned' && r.cs !== 'undecryptable')
    if (missing.length || recs.length < limit) {
      const { timeline_kind, timeline_id } = M.parseTimelineKey(timeline_key)
      const res = await this.hub.threads({ timeline_kind, timeline_id, before_envelope_number: before, limit })
      this._hubHasMore = res.has_more
      const byN = new Map(recs.map(r => [r.n, r]))
      const writes = []
      for (const { envelope_number, envelope } of res.envelopes) {
        let r = byN.get(envelope_number) ?? (await this.storage.get(prefix + pad(envelope_number)))
        if (!r && this.snapshotCursor && envelope_number <= this.snapshotCursor) {
          // Before the snapshot this device never saw the header: check the sender's signature and membership on its own.
          try {
            const v = await z.verifyEnvelope(unb64u(envelope), { state: this.state, chains: new Map(), allowChainStart: true, allowRemovedSender: true, commit: false })
            const vh = v.header
            // D5: the signed header must name this very timeline, as a thread item, from a sender allowed to write there,
            // at most as far as the snapshot's frontier for that sender; one (sender, sequence) is one item whatever its number.
            const sender = hex(vh.sender)
            const tk = vh.timelineKind ? (codec.TIMELINE_KIND_NAME[vh.timelineKind] ?? String(vh.timelineKind)) : null
            if (vh.kind !== codec.KIND.timeline_item || tk !== timeline_kind || vh.timelineId !== timeline_id) continue
            const head = this._snapshotChains?.get(sender)
            if (head != null && vh.seq > head) continue
            const role = this.state.members.get(b64u(vh.sender))?.role === ROLE.HUMAN ? 'human' : 'agent'
            if (M.timelineRefusal(this.model, { timeline_kind: tk, timeline_id: vh.timelineId, sender_role: role, sender_device_id: sender, recipient_device_id: vh.recipient.every(b => b === 0) ? null : hex(vh.recipient), session_id: vh.keyScope === 1 && vh.sessionId ? hex(vh.sessionId) : null, _epoch: vh.epoch })) continue
            if ([...byN.values()].some(x => x.s === sender && x.q === vh.seq)) continue
            r = { n: envelope_number, h: hex(v.hash), s: sender, q: vh.seq, r: vh.recipient.every(b => b === 0) ? null : hex(vh.recipient), t: vh.time, c: null, cs: 'header' }
          } catch { continue }
        }
        if (!r) continue                                   // not verified by sync yet: the stream brings it
        if (r.c) { byN.set(envelope_number, r); continue }
        try {
          const o = await z.openVerifiedEnvelope(unb64u(envelope), { state: this.state, secrets: this.openKeys, envelopeHash: unhex(r.h), self: this.device.id })
          const d = decodeOpened(o)
          r = { ...r, c: d.content, cs: d.content_state }
          this.stats.decrypted++
        } catch (e) {
          r = { ...r, cs: e.code === 'pruned' ? 'pruned' : 'undecryptable' }
          if (e.code === 'hash-mismatch' || e.code === 'bad-signature') this._localAlert('timeline', e)
        }
        byN.set(envelope_number, r)
        writes.push([prefix + pad(envelope_number), r])
      }
      if (writes.length) await this.storage.setMany(writes)
      recs = [...byN.values()].sort((a, b) => b.n - a.n).slice(0, limit)
    }
    return recs.sort((a, b) => a.n - b.n).map(r => itemFromStored(r))
  }

  // ---- attachments ------------------------------------------------------------------------------

  async uploadAttachment(bytes, meta = {}) {
    const asset = await z.encryptAsset(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
    await this.hub.putAttachment(hex(asset.blobId), asset.blob)
    const ref = codec.attachmentRef(asset, meta)
    this.attachmentCache.set(ref.attachment_id, bytes)
    return ref
  }
  async fetchAttachment(ref) {
    const hit = this.attachmentCache.get(ref.attachment_id)
    if (hit) return hit
    const blob = await this.hub.getAttachment(ref.attachment_id)
    const bytes = await z.decryptAsset(blob, unb64u(ref.file_key), unb64u(ref.sha256))
    if (this.attachmentCache.size > 64) this.attachmentCache.delete(this.attachmentCache.keys().next().value)
    this.attachmentCache.set(ref.attachment_id, bytes)
    return bytes
  }
  /**
   * A link for someone outside the room (the uploader shares its own attachment): `<app>/a/<share_id>#<secret>.<file_key>.<sha256>`.
   * The hub stores only SHA-256(secret); everything after # stays in the browser. expires_at: ms, at most 30 days ahead.
   */
  async shareAttachment(ref, { expires_at = Date.now() + 30 * 86400_000 - 60_000, app_url = 'https://app.trommi.com' } = {}) {
    const secret = globalThis.crypto.getRandomValues(new Uint8Array(32))
    const share_id = randomHex(16)
    const r = await this.hub.postShare(ref.attachment_id, { share_id, share_secret_hash: b64u(await z.sha256(secret)), expires_at })
    const shares = (await this.storage.get('shares')) ?? {}
    shares[share_id] = { attachment_id: ref.attachment_id, expires_at: r.expires_at ?? expires_at }
    for (const [id, x] of Object.entries(shares)) if (x.expires_at < Date.now()) delete shares[id]
    await this.storage.set('shares', shares)
    return { share_id, link: shareLink(app_url, share_id, secret, ref), expires_at: r.expires_at ?? expires_at }
  }
  /** End a share link. attachment_id is looked up from this device's own shares (pass it when another device made the share). */
  async revokeShare(share_id, { attachment_id = null } = {}) {
    const shares = (await this.storage.get('shares')) ?? {}
    const att = attachment_id ?? shares[share_id]?.attachment_id
    if (!att) throw new ZError('not-found', 'unknown share: pass its attachment_id')
    await this.hub.deleteShare(att, share_id)
    delete shares[share_id]
    await this.storage.set('shares', shares)
  }

  async attachmentBlob(ref) { return new Blob([await this.fetchAttachment(ref)], { type: ref.media_type ?? 'application/octet-stream' }) }

  // ---- human actions -----------------------------------------------------------------------------

  _needHuman() { if (!this.is_human) throw new ZError('forbidden', 'only a human device can do this') }
  _card(object_id) { const c = this.model.cards.get(object_id); if (!c) throw new ZError('not-found', `no card ${object_id}`); return c }

  /** A message: from a human to one agent (session or card conversation), from an agent to everyone. */
  async sendMessage({ agent_device_id = null, object_id = null, ...fields }) {
    let recipient = null, timeline, sid
    const card = object_id ? this._card(object_id) : null
    if (this.is_human) {
      sid = card?.session_id ?? fields_session(fields) ?? (agent_device_id ? this.sessionOfAgent(agent_device_id) : null)
      recipient = card?.agent_device_id ?? agent_device_id ?? this.sessionKeys.get(sid)?.state.agentIds[0] ?? null
      if (!recipient || !sid) throw new ZError('bad-argument', 'a message from a human names a session (with an agent) or a card')
    } else {
      sid = card?.session_id ?? fields_session(fields) ?? this.session_id
    }
    delete fields.session_id
    timeline = { timeline_kind: 'chat', timeline_id: object_id ? `card/${object_id}` : `session/${sid}` }
    return this._send({ kind: codec.KIND.timeline_item, content: { content_type: 'message', ...fields }, recipient, timeline, session_id: sid, echo: this._echoTimelineItem(timeline, { content_type: 'message', ...fields }, recipient, object_id) })
  }

  async answer({ object_id, choices = [], note, option_notes, attachments, marks, trusted, answer_action = 'answer' }) {
    this._needHuman()
    const card = this._card(object_id)
    if (card.object_state !== 'open') throw new ZError('card-closed', 'the card is not open')
    const content = { answer_action, choices, note, option_notes, attachments, marks, trusted }
    const bind = z.encodeAnswerBind({ objectId: unhex(object_id), versionHash: unhex(card.version_hash), choices, cardId: unhex(object_id), cardHash: unhex(card.version_hash), choice: choices[0] ?? '' })
    const state = answer_action === 'answer' ? 'answered' : 'closed'
    const answered_at = Date.now()
    return this._send({ kind: codec.KIND.answer, content, bind, recipient: card.agent_device_id, session_id: card.session_id, object: { object_id, object_state: state, urgency: card.urgency, answered_at },
      echo: this._echoAnswer(object_id, { answer_action, choices, note: note ?? null, option_notes: option_notes ?? {}, attachments: attachments ?? [], marks: marks ?? [], trusted: !!trusted,
        bound_version_hash: card.version_hash, bound_object_version: card.object_version, envelope_number: null, envelope_hash: null, by_device_id: this.my_device_id, answered_at, taken_back_at: null }, state) })
  }
  trust({ object_id, note }) {
    const card = this._card(object_id)
    const rec = card.recommended == null ? [] : Array.isArray(card.recommended) ? card.recommended : [card.recommended]
    return this.answer({ object_id, choices: rec, note, trusted: true })
  }
  markRead({ object_id }) { return this.answer({ object_id, answer_action: 'read' }) }
  shred({ object_id, note }) { return this.answer({ object_id, answer_action: 'shred', note }) }

  async decideAgain({ object_id }) {
    this._needHuman()
    const card = this._card(object_id)
    if (!card.answer?.envelope_hash) throw new ZError('decision-mismatch', 'no answer in force to take back')
    const bind = z.encodeRedecideBind({ objectId: unhex(object_id), previousHash: unhex(card.answer.envelope_hash), versionHash: unhex(card.version_hash), cardId: unhex(object_id), choice: card.answer.choices[0] ?? '' })
    return this._send({ kind: codec.KIND.decide_again, content: {}, bind, recipient: card.agent_device_id, session_id: card.session_id, object: { object_id, object_state: 'open', urgency: card.urgency } })
  }

  async verdict({ object_id, allow }) {
    this._needHuman()
    const p = this.model.permissions.get(object_id)
    if (!p) throw new ZError('not-found', 'no such permission request')
    const bind = z.encodeVerdictBind({ requestId: unhex(object_id), requestHash: unhex(p.version_hash), expiresAt: p.expires_at, allow: !!allow })
    return this._send({ kind: codec.KIND.verdict, content: {}, bind, recipient: p.agent_device_id, session_id: p.session_id, object: { object_id, object_state: 'answered', urgency: 'critical', answered_at: Date.now() } })
  }

  /** Registers: human keys from human devices, agent keys from agents, `device/<own id>` from anyone. */
  async setRegisters(values, { own_device = false, session_id = null } = {}) {
    for (const k of Object.keys(values)) {
      if (k.startsWith('device/')) { if (k !== `device/${this.my_device_id}`) throw new ZError('forbidden', 'a device writes only its own device register'); continue }
      if (this.is_human ? !isHumanRegisterKey(k) && isAgentRegisterKey(k) : isHumanRegisterKey(k)) throw new ZError('forbidden', `${k} is not a ${this.model.room.my_role} key`)
    }
    return this._send({ kind: codec.KIND.status, content: { values }, session_id: this.is_human ? session_id : (session_id ?? this.session_id), echo: this.is_human ? this._echoRegisters(values) : null })
  }
  setDraft(object_id, draft) { return this.setRegisters({ [`draft/${object_id}`]: draft ?? null }) }
  snooze(object_id, until) { return this.setRegisters({ [`snooze/${object_id}`]: until == null ? null : { until } }) }
  duck(object_id, value) { return this.setRegisters({ [`duck/${object_id}`]: value ?? null }) }
  setCrown(value) { return this.setRegisters({ crown: value ?? null }) }
  setDesk(desk_id, value) { return this.setRegisters({ [`desk/${desk_id}`]: value ?? null }) }
  setSessionSettings(agent_device_id, value) { return this.setRegisters({ [`session/${agent_device_id}`]: value ?? null }) }
  markReadUpTo(agent_device_id, envelope_number) { return this.setRegisters({ [`read_up_to/${agent_device_id}`]: envelope_number }) }
  setDeviceInfo(info) { return this.setRegisters({ [`device/${this.my_device_id}`]: info }) }

  /** A memo's newest version as THIS client sealed it (may be ahead of the model while versions are in flight). */
  _memoHead(object_id) {
    const local = this.localHeads.get(object_id)
    const m = this.model.memos.get(object_id)
    const base = m?.pending ? m._base : m
    if (local && (!base || local.object_version >= base.object_version)) return local
    return base ? { object_version: base.object_version, version_hash: base.version_hash, content: memoFields(base) } : null
  }

  /**
   * New memo or a new version. Optimistic: the memo is in model.memos at once (pending: true; a new one first under its
   * local_id, then under its object_id once sealed). Versions chain on what this client sealed last. Resolves to the object_id.
   */
  async saveMemo({ object_id = null, ...fields }) {
    this._needHuman()
    let id = object_id
    let echoKey = object_id
    const r = await this._send({
      kind: codec.KIND.object_version,
      echo: local_id => {
        echoKey = object_id ?? local_id
        const prev = this.model.memos.get(echoKey)
        const base = prev?.pending ? prev._base : prev ?? null
        this.model.memos.set(echoKey, { ...(base ?? {}), ...fields, object_id: echoKey, local_id, pending: true, _base: base, object_state: 'open', by_device_id: this.my_device_id })
        const ch = M.emptyChange(); ch.memos.add(echoKey); this._emitChange(ch)
        return ({ confirmed }) => {
          if (confirmed) return
          const cur = this.model.memos.get(id ?? echoKey)
          const c = M.emptyChange()
          if (cur?.pending) { if (cur._base) this.model.memos.set(cur.object_id, cur._base); else this.model.memos.delete(cur.object_id); c.memos.add(cur.object_id) }
          return c
        }
      },
      content: async () => {
        if (!id) id = await objectIdOf(this.my_device_id, (this.chains.get(b64u(this.device.id))?.seq ?? 0) + 1)
        const head = object_id ? this._memoHead(object_id) : null
        const content = { ...(head?.content ?? {}), ...fields, object_type: 'memo', object_version: (head?.object_version ?? 0) + 1, previous_version_hash: head?.version_hash ?? ZERO_HASH }
        for (const k of Object.keys(content)) if (content[k] === undefined) delete content[k]
        return { content, object: { object_id: id, object_state: fields.object_state === 'closed' ? 'closed' : 'open', urgency: 'normal' } }
      },
      after: (sealed, content) => {
        this.localHeads.set(id, { object_version: content.object_version, version_hash: hex(sealed.hash), content: memoFields(content) })
        if (echoKey !== id) {                     // a new memo: move the echo from its local id to its object id
          const e = this.model.memos.get(echoKey)
          this.model.memos.delete(echoKey)
          if (e) this.model.memos.set(id, { ...e, object_id: id })
          const ch = M.emptyChange(); ch.memos.add(echoKey); ch.memos.add(id); this._emitChange(ch)
        }
      },
    })
    return id
  }
  async deleteMemo(object_id) {
    if (!this._memoHead(object_id)) throw new ZError('not-found', 'no such memo')
    this._needHuman()
    let echoed = null
    return this._send({
      kind: codec.KIND.object_version,
      echo: local_id => {
        const prev = this.model.memos.get(object_id)
        const base = prev?.pending ? prev._base : prev
        this.model.memos.set(object_id, { ...prev, object_state: 'closed', pending: true, local_id, _base: base })
        echoed = base
        const ch = M.emptyChange(); ch.memos.add(object_id); this._emitChange(ch)
        return ({ confirmed }) => {
          if (confirmed) return
          const c = M.emptyChange(); if (echoed) this.model.memos.set(object_id, echoed); c.memos.add(object_id); return c
        }
      },
      content: () => {
        const head = this._memoHead(object_id)
        return { content: { ...head.content, object_type: 'memo', object_version: head.object_version + 1, previous_version_hash: head.version_hash }, object: { object_id, object_state: 'closed', urgency: 'normal' } }
      },
      after: (sealed, content) => this.localHeads.set(object_id, { object_version: content.object_version, version_hash: hex(sealed.hash), content: memoFields(content) }),
    })
  }

  /** Canvas items: strokes, erase, move, send_away, selection_sent; timeline_id e.g. 'desk/<desk_id>'. */
  async sendStrokes({ timeline_id, content_type = 'strokes', recipient_device_id = null, ...fields }) {
    const content = { content_type, ...fields }
    const timeline = { timeline_kind: content_type === 'selection_sent' && recipient_device_id ? 'chat' : 'canvas', timeline_id }
    const p = M.parseTimelineKey(`x:${timeline_id}`)
    const sid = p.scope === 'session' ? p.scope_id : p.scope === 'card' ? this.model.cards.get(p.scope_id)?.session_id ?? null : (this.is_human ? null : this.session_id)
    return this._send({ kind: codec.KIND.timeline_item, content, recipient: recipient_device_id, timeline, session_id: sid, echo: this._echoTimelineItem(timeline, content, recipient_device_id, null) })
  }
  /** Canvas tail after a snapshot: every item after an envelope number, oldest first (loops over pages). Returns { loaded, items, has_more: false }. */
  async loadTimelineAfter(timeline_key, after_envelope_number) {
    if (this._dirty.records.size) await this.flush()
    const { timeline_kind, timeline_id } = M.parseTimelineKey(timeline_key)
    const t = M.timelineOf(this.model, timeline_key)
    t.window_open = true
    const prefix = `tl/${timeline_key}/`
    const out = []
    let after = after_envelope_number
    for (;;) {
      const res = await this.hub.threads({ timeline_kind, timeline_id, after_envelope_number: after, limit: 500 })
      const writes = []
      for (const { envelope_number, envelope } of res.envelopes) {
        after = Math.max(after, envelope_number)
        const r = await this.storage.get(prefix + pad(envelope_number))
        if (!r) continue            // beyond this client's verified cursor: the stream brings it
        try {
          let stored = r
          if (!r.c) {
            const o = await z.openVerifiedEnvelope(unb64u(envelope), { state: this.state, secrets: this.openKeys, envelopeHash: unhex(r.h), self: this.device.id })
            const d = decodeOpened(o)
            stored = { ...r, c: d.content, cs: d.content_state }
            writes.push([prefix + pad(envelope_number), stored])
          }
          const item = itemFromStored(stored)
          t.items.set(envelope_number, item)
          out.push(item)
        } catch (e) { this._localAlert('timeline', e) }
      }
      if (writes.length) await this.storage.setMany(writes)
      if (!res.has_more || !res.envelopes.length) break
    }
    const ch = M.emptyChange(); ch.timelines.add(timeline_key)
    for (const it of out) M.addItem(ch, timeline_key, it)
    this._emitChange(ch)
    return { loaded: out.length, items: out, has_more: false }
  }


  // ---- membership: invites, removal ---------------------------------------------------------

  async createInvite({ device_role = 'human', app_url = 'https://app.trommi.com/join', ttl_ms, label = null, session_id = null, with_history = false } = {}) {
    this._needHuman()
    const role = device_role === 'agent' ? ROLE.AGENT : ROLE.HUMAN
    const { link, offer, invite } = await z.createInvite({ state: this.state, inviter: this.device, hub: this.hub.hub_url, role, app: app_url, ...(ttl_ms ? { ttlMs: ttl_ms } : {}) })
    const r = await this.hub.postInvite(b64u(offer))
    const invite_id = r.invite_id
    const pub = { invite_id, device_role, link, label, session_id, with_history, expires_at: invite.expiresAt, invite_state: 'open', newcomer: null, error: null }
    invite.public = pub
    this.invitesPrivate.set(invite_id, invite)
    this.model.invites.set(invite_id, pub)
    await this._saveInvite(invite_id)
    const ch = M.emptyChange(); ch.invites.add(invite_id); this._emitChange(ch)
    this._watchInvite(invite_id)
    return pub
  }
  async _saveInvite(invite_id) { const inv = this.invitesPrivate.get(invite_id); await this.storage.set(`invite/${invite_id}`, inviteToJson(invite_id, inv)) }

  /** Poll the invite's requests while it is open (the join_request event triggers a check at once too). */
  _watchInvite(invite_id) {
    const inv = this.invitesPrivate.get(invite_id)
    if (!inv || inv._timer) return
    inv._timer = setInterval(() => {
      if (!this._started || inv.finalized || inv.public.invite_state === 'failed' || inv.public.invite_state === 'confirm_code' || Date.now() > inv.expiresAt + 1000) {
        if (Date.now() > inv.expiresAt && inv.public.invite_state === 'open') this._setInvite(invite_id, { invite_state: 'expired' })
        if (inv.public.invite_state !== 'confirm_code' || Date.now() > inv.expiresAt + z.INVITE_CONFIRM_MS) { clearInterval(inv._timer); inv._timer = null }
        return
      }
      this._checkInvite(invite_id).catch(() => {})
    }, 1000)
  }

  _setInvite(invite_id, fields) {
    const inv = this.invitesPrivate.get(invite_id)
    Object.assign(inv.public, fields)
    this._saveInvite(invite_id).catch(() => {})
    const ch = M.emptyChange(); ch.invites.add(invite_id); this._emitChange(ch)
  }

  async _checkInvite(invite_id) {
    const inv = this.invitesPrivate.get(invite_id)
    if (!inv || inv.used || inv._checking) return
    inv._checking = true
    try {
      const r = await this.hub.getRequests(invite_id)
      for (const q of r.signed_requests) {
        let accepted
        try { accepted = await z.acceptJoinRequest({ invite: inv, request: unb64u(q), inviter: this.device }) }
        catch (e) { if (e.code === 'invite-expired') { this._setInvite(invite_id, { invite_state: 'expired', error: e.code }); return } continue }
        await this.hub.postReveal(invite_id, b64u(accepted.reveal))
        inv.code = accepted.code
        if (accepted.requestHash) inv.requestHash = accepted.requestHash
        const choices = [accepted.code]
        while (choices.length < 4) { const c = String(globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0'); if (!choices.includes(c)) choices.push(c) }
        for (let i = choices.length - 1; i > 0; i--) { const j = globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1); [choices[i], choices[j]] = [choices[j], choices[i]] }
        this._setInvite(invite_id, { code_choices: choices, newcomer: { device_id: hex(accepted.member.id), device_name: accepted.member.name || '' }, invite_state: inv.role === ROLE.AGENT ? 'adding' : 'confirm_code' })
        if (inv.role === ROLE.AGENT) await this._finalizeInvite(invite_id, { skipCheckCode: true })
        return
      }
    } finally { inv._checking = false }
  }

  /** Human invites: the six digits the human typed on this (the inviting) device. A wrong code burns the invite. */
  async confirmInvite(invite_id, typed_code) {
    const inv = this.invitesPrivate.get(invite_id)
    if (!inv || inv.public.invite_state !== 'confirm_code') throw new ZError('bad-invite', 'this invite waits for no code')
    if (String(typed_code).replace(/\s/g, '') !== inv.code) {
      inv.finalized = true
      this._setInvite(invite_id, { invite_state: 'failed', error: 'code-mismatch' })
      this.hub.deleteInvite(invite_id).catch(() => {})     // the hub tells the newcomer at once (status 410 invite-burned)
      throw new ZError('code-mismatch', 'the code does not match: nobody was added, the invite is spent')
    }
    this._setInvite(invite_id, { invite_state: 'adding' })
    await this._finalizeInvite(invite_id, { codeConfirmed: true })
  }

  _finalizeInvite(invite_id, opts) {
    return this.serial(async () => {
      const inv = this.invitesPrivate.get(invite_id)
      try {
        const secret = this.secrets.get(this.state.epoch)
        const added = await z.finalizeInvite({ invite: inv, state: this.state, inviter: this.device, secret, ...(inv.requestHash ? { requestHash: inv.requestHash } : {}), ...opts })
        const newId = inv.public.newcomer.device_id
        await this.hub.postMember({ signed_entry: b64u(added.entry), sealed_room_keys: added.wrap ? [{ device_id: newId, key_sealed: b64u(added.wrap) }] : [] })
        clearInterval(inv._timer); inv._timer = null
        await this._refreshMembers()
        if (inv.role === ROLE.AGENT) {
          // R6: an agent gets a session: the one named in the invite (handover, with or without history) or a new one.
          const sid = inv.public.session_id
            ? (await this._assignSessionLocked({ session_id: inv.public.session_id, agent_device_ids: [newId], with_history: !!inv.public.with_history }), inv.public.session_id)
            : await this._createSessionLocked({ agent_device_ids: [newId] })
          inv.public.session_id = sid
          // R8: the label the human chose when inviting wins over what the agent calls itself.
          if (inv.public.label) {
            const cur = this.model.human.session_settings.get(sid) ?? {}
            this.setRegisters({ [`session/${sid}`]: { ...cur, name: inv.public.label } }).catch(e => this._localAlert('invite', e))
          }
        } else {
          await this._resealSessionsLocked()   // a new human device gets every session key
        }
        this._setInvite(invite_id, { invite_state: 'joined' })
      } catch (e) {
        this._setInvite(invite_id, { invite_state: 'failed', error: e.code ?? 'failed' })
        throw e
      }
    })
  }

  /**
   * Remove devices: one member entry with the cut (R3: the last envelope of each removed device this device has seen),
   * a new room key for the humans who stay, and a new session key for every session (R6) without the removed ones.
   */
  removeDevices(device_ids) {
    this._needHuman()
    return this.serial(async () => {
      await this._refreshMembers()
      await this._refreshSessions()
      const previous = this.secrets.get(this.state.epoch)
      const cuts = {}
      for (const id of device_ids) { const c = this.chains.get(b64u(unhex(id))); if (c) cuts[id] = { seq: c.seq, hash: c.hash } }
      const unknown = device_ids.filter(id => !cuts[id])
      if (unknown.length) Object.assign(cuts, (await verifiedHeads(this.hub, this.state, unknown)) ?? {})   // never a blind cut at 0
      const r = await z.removeMembers(this.state, this.device, { ids: device_ids.map(unhex), cuts, previous })
      await this.hub.postMember({ signed_entry: b64u(r.entry), sealed_room_keys: r.wraps.map(w => ({ device_id: hex(w.id), key_sealed: b64u(w.sealed) })), key_back_link: r.backLink ? b64u(r.backLink) : undefined })
      this.secrets.set(r.secret.epoch, r.secret)
      await this._refreshMembers()
      // A1: every session is re-keyed now. The pending work is in the signed state itself (a grant older than the removal is
      // stale), so a crash or a refused post here is finished by the next start of any human device (_healStaleSessions).
      await this._healStaleSessions().catch(e => this._localAlert('rekey', e))
      return { key_epoch: r.secret.epoch }
    })
  }

  // ---- sessions (R6): created, assigned and re-keyed by human devices ----------------------------

  /** A new session for an agent (or none yet). Returns its session_id. */
  createSession({ agent_device_ids = [], agent_device_id = null } = {}) {
    this._needHuman()
    return this.serial(() => this._createSessionLocked({ agent_device_ids: agent_device_id ? [agent_device_id] : agent_device_ids }))
  }
  async _createSessionLocked({ agent_device_ids }) {
    const r = await G.createSessionGrant({ state: this.state, signer: this.device, agentIds: agent_device_ids })
    await this._postGrant(r)
    return r.sessionState.sessionId
  }
  /**
   * Assign agents to a session or hand it over. with_history: the agents may read the session's earlier history (the
   * current key is re-sealed with its history key); otherwise a new session key epoch starts first ("Darf er den
   * bisherigen Verlauf lesen?" — no).
   */
  assignSession({ session_id, agent_device_ids = null, agent_device_id = null, with_history = false }) {
    this._needHuman()
    return this.serial(() => this._assignSessionLocked({ session_id, agent_device_ids: agent_device_ids ?? (agent_device_id ? [agent_device_id] : []), with_history }))
  }
  async _assignSessionLocked({ session_id, agent_device_ids, with_history }) {
    await this._refreshSessions()
    return this._grantLocked(session_id, { agent_device_ids, with_history, rotate: true })
  }
  async _grantLocked(session_id, opts) {
    const { r, current, historyAgentIds } = await this._makeGrant(session_id, opts)
    await this._postGrant(r, current)
    this._noteHistoryAgents(session_id, r.sessionState.agentIds, historyAgentIds)
    return r.sessionState
  }
  async _makeGrant(session_id, { agent_device_ids, with_history = false, rotate = false }) {
    const k = this.sessionKeys.get(session_id)
    if (!k) throw new ZError('not-found', `no session ${session_id}`)
    const current = k.secrets.get(k.state.epoch)
    const active = agent_device_ids.filter(a => z.memberAt(this.state, unhex(a))?.role === ROLE.AGENT)
    // Whoever loses access loses the key: any agent dropped from the set means a new session key epoch (R6). A handover
    // "with history" rotates too; the new holder reads back through the back links.
    if (k.state.agentIds.some(a => !active.includes(a))) rotate = true
    // Per-agent history (PoC p4): the agents newly assigned in this call with with_history get the history key, and so
    // does every agent that was given the history before and is still assigned (review 3: otherwise an agent lost its
    // history at the next rotation and could not walk back after rebuilding its storage). Who was given it is kept in
    // the human register session_history/<session> (room scope: humans only), so every human device rotates alike.
    const entitled = this._historyAgents(session_id)
    const historyAgentIds = active.filter(a => (with_history && !k.state.agentIds.includes(a)) || entitled.includes(a))
    const r = await G.createSessionGrant({ state: this.state, signer: this.device, sessionState: k.state, current, agentIds: active, withHistory: historyAgentIds.length > 0, historyAgentIds, rotate: rotate || !current })
    return { r, current, historyAgentIds }
  }
  /** The agents of a session that were given its history (and are still on it): the human register, else this device's note. */
  _historyAgents(session_id) {
    const reg = this.model.human.raw.get(`session_history/${session_id}`)?.value?.agents
    const local = this.roomRecord.session_history?.[session_id]
    return Array.isArray(reg) ? reg : Array.isArray(local) ? local : []
  }
  /** After a grant: remember who holds the history (dropped agents lose the entitlement). Written outside the queue. */
  _noteHistoryAgents(session_id, agentIds, historyAgentIds) {
    const next = [...new Set(historyAgentIds)].filter(a => agentIds.includes(a)).sort()
    const was = [...this._historyAgents(session_id)].sort()
    if (JSON.stringify(next) === JSON.stringify(was)) return
    ;(this.roomRecord.session_history ??= {})[session_id] = next
    this._saveRoom().catch(() => {})
    queueMicrotask(() => this.setRegisters({ [`session_history/${session_id}`]: { agents: next } }).catch(e => this._localAlert('session-history', e)))
  }
  /** Re-seal every session's current key for everyone who holds it now (a new human device). */
  async _resealSessionsLocked() {
    await this._refreshSessions()
    for (const [sid, k] of this.sessionKeys) await this._grantLocked(sid, { agent_device_ids: k.state.agentIds, with_history: !!k.state.withHistory, rotate: false })
  }
  /**
   * A1: humans re-key every session whose newest grant predates a removal or recovery (G.grantIsStale), dropping agents
   * that are no longer members. Runs at start, after member entries and after a removal; idempotent. A concurrent re-key
   * by another human device makes the hub refuse ours: refresh and look again.
   */
  async _healStaleSessions() {
    if (!this.is_human || !G.grantIsStale) return
    for (let round = 0; round < 3; round++) {
      const stale = [...this.sessionKeys].filter(([, k]) => k.state && G.grantIsStale(k.state, this.state))
      if (!stale.length) return
      let refused = false
      const items = []
      for (const [sid, k] of stale) {
        if (!k.secrets.get(k.state.epoch)) continue                   // not this device's to re-key (no current key)
        items.push(await this._makeGrant(sid, { agent_device_ids: k.state.agentIds, rotate: true }))
      }
      // one atomic post for all of them (a removal of one agent in a room with 24 sessions: one request, not 24)
      try { await this._postGrants(items) }
      catch (e) { if (e.status >= 400 && e.status < 500) refused = true; else throw e }
      if (!refused) return
      await this._refreshSessions()
    }
  }

  async _postGrant(r, current = null) {
    await this.hub.postSessionGrant(r.sessionState.sessionId, grantBody(r))
    await this._applyOwnGrants([{ r, current }])
  }
  /**
   * Several grants in one atomic post (POST session_grants: all or none), e.g. a removal re-keying every session.
   * Batches of 64; a hub without the route gets them one by one.
   */
  async _postGrants(items) {
    for (let i = 0; i < items.length; i += 64) {
      const part = items.slice(i, i + 64)
      try { await this.hub.postSessionGrants(part.map(({ r }) => ({ session_id: r.sessionState.sessionId, ...grantBody(r) }))) }
      catch (e) { if (e.status !== 404) throw e; for (const { r } of part) await this.hub.postSessionGrant(r.sessionState.sessionId, grantBody(r)) }
      await this._applyOwnGrants(part)
    }
  }
  async _applyOwnGrants(items) {
    const ch = M.emptyChange()
    for (const { r, current } of items) this._adoptGrant(r, current, ch)
    M.project(this.model, ch)
    await this._saveRoom()
    this._emitChange(ch)
  }
  _adoptGrant(r, current, ch) {
    const sid = r.sessionState.sessionId
    const k = this.sessionKeys.get(sid) ?? { secrets: new Map(), grants: [], since: null }
    if (k.state && k.state.epoch !== r.sessionState.epoch) k.since = Date.now()
    k.state = r.sessionState
    k.grants = [...k.grants, b64u(r.grant)]
    k.secrets.set(r.secret.epoch, r.secret)
    if (current) k.secrets.set(current.epoch, current)
    this.sessionKeys.set(sid, k)
    M.applySessionGrant(this.model, k.state, ch, everAgents(k), epochAgents(k))
  }

  // ---- password escrow (optional; escrow.mjs) ----------------------------------------------------

  /**
   * Seal the recovery code under a passphrase (escrow v2) and store it on the hub. The code is needed once (the device
   * never keeps it). Only a generated passphrase (generatePassphrase, escrow.mjs) is accepted. Replaces any earlier
   * escrow of the room by compare-and-swap: if another device changed it in between, ZError 'escrow-changed'.
   */
  async setPassphrase(passphrase, { recovery_code } = {}) {
    this._needHuman()
    if (!recovery_code) throw new ZError('bad-argument', 'setting a passphrase needs the recovery code once')
    const rec = await z.recoveryDevice(recovery_code)
    if (!z.bytesEqual(rec.id, this.state.recovery.id)) throw new ZError('bad-recovery-code', 'this code does not belong to the room')
    const sealed = await sealEscrowV2({ room_id: this.model.room.room_id, recovery_code, passphrase })
    const { revision } = await this.hub.escrowStatus()
    const out = await this.hub.putEscrow({ ...sealed, replaces: revision })
    this.roomRecord.has_passphrase = true
    this.roomRecord.escrow_revision = out.revision
    await this._saveRoom()
    this._setRoom({ has_passphrase: true })
  }
  async removePassphrase() {
    this._needHuman()
    const { revision } = await this.hub.escrowStatus()
    const out = await this.hub.deleteEscrow(revision)
    this.roomRecord.has_passphrase = false
    this.roomRecord.escrow_revision = out.revision
    await this._saveRoom()
    this._setRoom({ has_passphrase: false })
  }
  /** Whether this room has an escrow (asked as a signed-in human; anonymous reads never tell). */
  async checkPassphrase() {
    if (!this.is_human) return this.model.room.has_passphrase
    const st = await this.hub.escrowStatus()
    this._setRoom({ has_passphrase: !!st.has_escrow, escrow_v1: st.escrow_version === 1 })
    return this.model.room.has_passphrase
  }
  /**
   * Migrate a retired v1 escrow (review 3): the hub hands its blob only to a signed-in human. Opens it with the old
   * passphrase, seals the recovery code again under a NEW generated passphrase (v2), and replaces the v1 blob, which
   * the hub then no longer holds. Returns the new passphrase (show it once).
   */
  async migratePassphrase(old_passphrase) {
    this._needHuman()
    const st = await this.hub.escrowStatus()
    if (st.escrow_version !== 1 || !st.key_escrow) throw new ZError('not-found', 'this room has no v1 escrow to migrate')
    const recovery_code = await openEscrow({ room_id: this.model.room.room_id, key_escrow: st.key_escrow, passphrase: old_passphrase })
    const passphrase = generatePassphrase()
    await this.setPassphrase(passphrase, { recovery_code })
    this._setRoom({ escrow_v1: false })
    return passphrase
  }
  /** escrow_changed from the hub: another human device set or removed the escrow. Shown, so nobody swaps it silently. */
  _onEscrowChanged(data) {
    if (data?.revision != null && data.revision === this.roomRecord.escrow_revision) return
    this.roomRecord.escrow_revision = data?.revision ?? null
    if (data?.updater_device_id === this.my_device_id) return
    const ch = M.emptyChange()
    M.pushAlert(this.model, ch, { code: 'escrow-changed', sender_device_id: data?.updater_device_id ?? null, message: data?.escrow_version ? 'another device set a new sign-in passphrase' : 'another device turned the sign-in passphrase off' })
    this.model.room.has_passphrase = !!data?.escrow_version
    ch.room = true
    this._emitChange(ch)
    this._saveRoom().catch(() => {})
  }
  _setRoom(fields) { Object.assign(this.model.room, fields); const ch = M.emptyChange(); ch.room = true; this._emitChange(ch) }

  async pushSubscribe(subscription, remove = false) { return this.hub.pushSubscription(subscription, remove) }
}

const MEMO_META = new Set(['lamport', 'object_id', 'by_device_id', 'object_version', 'version_hash', 'version_hashes', 'causal', 'envelope_number', 'object_state', 'pending', 'local_id', '_base', 'schema_version', 'object_type', 'previous_version_hash'])
function memoFields(m) { const out = {}; for (const [k, v] of Object.entries(m)) if (!MEMO_META.has(k)) out[k] = v; return out }

const fields_session = f => f.session_id ?? null
const grantBody = r => ({ signed_grant: b64u(r.grant), sealed_session_keys: r.wraps.map(w => ({ device_id: hex(w.id), key_sealed: b64u(w.sealed) })), key_back_link: r.backLink ? b64u(r.backLink) : undefined })
export const shareLink = (app_url, share_id, secret, ref) => `${String(app_url).replace(/\/+$/, '')}/a/${share_id}#${b64u(secret)}.${ref.file_key}.${ref.sha256}`
/** Viewer page: parse a share link. -> { share_id, share_secret, file_key, sha256 } */
export function parseShareLink(link) {
  const m = /\/a\/([0-9a-f]{32})#([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(String(link))
  if (!m) throw new ZError('bad-format', 'not a share link')
  return { share_id: m[1], share_secret: m[2], file_key: m[3], sha256: m[4] }
}
/** Viewer page: fetch and decrypt a shared file with a Hub client for the hub address (no room, no sign-in). */
export async function openShared(hub, link) {
  const p = parseShareLink(link)
  const blob = await hub.getShared(p.share_id, p.share_secret)
  return z.decryptAsset(blob, unb64u(p.file_key), unb64u(p.sha256))
}
/** Every agent a session was ever assigned to (its history stays theirs to have written). */
/** Session key epoch -> the agents its grants gave that key (B03: who may write under it). */
function epochAgents(k) {
  if (!k?.grants) return null
  if (k._byEpoch && k._byEpochN === k.grants.length) return k._byEpoch
  const out = {}
  for (const g of k.grants) { const d = G.decodeGrant(unb64u(g)); const l = (out[d.epoch] ??= []); for (const id of d.agentIds) if (!l.includes(hex(id))) l.push(hex(id)) }
  k._byEpoch = out; k._byEpochN = k.grants.length
  return out
}
/** Session key epoch -> the signed time of the first grant that set it (B03: when that epoch started, by a human's clock). */
function epochStartTime(k, epoch) {
  if (!k?.grants) return null
  if (!k._startN || k._startN !== k.grants.length) {
    k._start = new Map()
    for (const g of k.grants) { const d = G.decodeGrant(unb64u(g)); if (!k._start.has(d.epoch)) k._start.set(d.epoch, d.time) }
    k._startN = k.grants.length
  }
  return k._start.get(epoch) ?? null
}
function everAgents(k) {
  if (!k?.grants) return []
  if (k._ever && k._everN === k.grants.length) return k._ever
  const set = new Set()
  for (const g of k.grants) for (const id of G.decodeGrant(unb64u(g)).agentIds) set.add(hex(id))
  k._ever = [...set]; k._everN = k.grants.length
  return k._ever
}

/** Decode an opened body. Every attachment it references must be in the signed header's blob list (quota, retention, and
 *  no id the hub never saw); attachment ids are hex (codec). Otherwise the body counts as undecryptable. */
function decodeOpened(o, header = o.header) {
  const d = codec.decodePayload(o.payload)
  if (d.content && header && codec.attachmentIdsOf(d.content).some(id => !header.blobs.some(b => hex(b) === id))) return { content: null, content_state: 'undecryptable' }
  return d
}

function itemFromStored(r) {
  return { envelope_number: r.n, local_id: null, pending: false, envelope_hash: r.h, sender_device_id: r.s, sender_sequence: r.q ?? null, recipient_device_id: r.r, sent_at: r.t,
    item_state: r.c ? (r.cs === 'ok' ? 'loaded' : r.cs) : (r.cs === 'pruned' || r.cs === 'undecryptable' ? r.cs : 'header'), content_type: r.c?.content_type ?? null, content: r.c ?? null }
}

const HUMAN_KEY = /^(crown$|room_snapshot$|draft\/|snooze\/|duck\/|desk\/|session\/|read_up_to\/|canvas_snapshot\/)/
const AGENT_KEY = /^(profile$|status_line\/|alert\/)/
export const isHumanRegisterKey = k => HUMAN_KEY.test(k)
export const isAgentRegisterKey = k => AGENT_KEY.test(k)

function inviteToJson(invite_id, inv) {
  return { invite_id, public: inv.public, roomId: b64u(inv.roomId), hub: inv.hub, role: inv.role, secret: b64u(inv.secret), nonce: b64u(inv.nonce), inviteId: b64u(inv.inviteId),
    expiresAt: inv.expiresAt, offer: b64u(inv.offer), used: inv.used, finalized: inv.finalized, request: inv.request ? b64u(inv.request) : null, acceptedAt: inv.acceptedAt, code: inv.code ?? null }
}
function inviteFromJson(o) {
  return { public: o.public, roomId: unb64u(o.roomId), hub: o.hub, role: o.role, secret: unb64u(o.secret), nonce: unb64u(o.nonce), inviteId: unb64u(o.inviteId), expiresAt: o.expiresAt,
    offer: unb64u(o.offer), used: o.used, finalized: o.finalized, request: o.request ? unb64u(o.request) : null, acceptedAt: o.acceptedAt, code: o.code }
}
export { isZeroHex, randomHex }
