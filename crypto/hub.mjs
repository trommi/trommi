// hub.mjs: what the hub does for one room, as one module without HTTP and without a database.
//
// The hub holds no key and decides nothing about content. It keeps the signed member list, the sealed
// room keys, the session grants and sealed session keys, open invites and sealed envelopes, and it refuses
// what a hub must refuse (README "Security rules", the hub as the second line behind every client):
//   - a member-list entry that a current human member (or the recovery key) did not sign,
//   - anything from a removed member: sign-in, envelopes, entries,
//   - a replayed entry or envelope, a gap or a second history in a sender's chain,
//   - an epoch change that does not bring a sealed key for everyone who stays,
//   - an envelope its sender may not write (R1, R6): another member's object, a timeline that is not its own,
//     a session it is not assigned to, an old key epoch two minutes after the change (R3).
// Clients check all of this again; the hub's checks keep junk out and metadata in. See docs/pairing.md.
//
// `memoryStorage()` is the reference storage; hub/store.mjs is the SQLite one with the same methods.

import * as z from './zcrypto.mjs'
import { applyGrant, grantManifestHash } from './session-grants.mjs'

const { ZError, ROLE, ENTRY, KIND, KEY_SCOPE, TIMELINE, b64u, hex, unhex, bytesEqual } = z
const fail = (code, message, extra) => { throw new ZError(code, message, extra) }

export const CHALLENGE_TTL_MS = 2 * 60 * 1000
export const SESSION_TTL_MS = 10 * 60 * 1000
export const MAX_OPEN_INVITES = 16
export const MAX_REQUESTS_PER_INVITE = 4
export const INVITE_AFTER_USE_MS = 15 * 60 * 1000
export const LEASE_MS = 60 * 1000
export const RETENTION_DAYS = 30
const DAY = 86400000
const WRAP_AGENT = 2 + 32 + 33 + 16      // sealed box around 0x01 || key
const WRAP_HUMAN = 2 + 32 + 65 + 16      // sealed box around 0x02 || key || hist
const BACK_LINK = 2 + 4 + 64 + 16
const SESSION_BACK_LINK = 2 + 16 + 4 + 64 + 16
const isSealed = (b, len) => b instanceof Uint8Array && b.length === len && b[0] === 1 && b[1] === z.OBJ.SEALED

/** In-memory stand-in for the store. Everything the hub keeps is here, and nothing in it opens anything. */
export function memoryStorage() {
  const s = { log: [], logTimes: [], wraps: new Map(), backLinks: new Map(), invites: new Map(), envelopes: [], sessions: new Map(), objects: new Map(), grants: new Map(), sessionWraps: new Map(), sessionLinks: new Map() }
  return {
    _data: s,
    entries: () => [...s.log],
    entryTimes: () => [...s.logTimes],
    appendEntry(bytes, info) { s.log.push(bytes); s.logTimes.push(info?.at ?? Date.now()) },
    putWrap(epoch, id, sealed) { const k = `${epoch}:${id}`; if (!s.wraps.has(k)) s.wraps.set(k, { epoch, id, sealed }) },
    wraps: (id, afterEpoch = 0) => [...s.wraps.values()].filter(w => w.id === id && w.epoch > afterEpoch).sort((a, b) => a.epoch - b.epoch),
    putBackLink(epoch, bytes) { if (!s.backLinks.has(epoch)) s.backLinks.set(epoch, bytes) },
    backLinks: () => [...s.backLinks].sort((a, b) => a[0] - b[0]).map(([epoch, bytes]) => ({ epoch, bytes })),
    putInvite(id, invite) { s.invites.set(id, invite) },
    invite: id => s.invites.get(id) ?? null,
    invites: () => [...s.invites.values()],
    appendEnvelope(bytes, meta) {
      s.envelopes.push({ n: s.envelopes.length + 1, bytes, ...meta })
      const h = meta.header
      if (h?.card && !s.objects.has(hex(h.card.id))) s.objects.set(hex(h.card.id), { owner: meta.sender, firstKind: h.kind, keyScope: h.keyScope, sessionId: h.sessionId ? hex(h.sessionId) : null })
      return s.envelopes.length
    },
    envelopes: (after = 0, limit = 200) => s.envelopes.filter(e => e.n > after).slice(0, limit),
    replaceEnvelope(n, bytes) { s.envelopes[n - 1] = { ...s.envelopes[n - 1], bytes, pruned: true } },
    objectInfo: id => s.objects.get(id) ?? null,
    putGrant(sessionId, g) { const list = s.grants.get(sessionId) ?? []; list.push(g); s.grants.set(sessionId, list) },
    grants: sessionId => [...(s.grants.get(sessionId) ?? [])],
    putSessionWrap(sessionId, epoch, id, sealed) { const k = `${sessionId}:${epoch}:${id}`; if (!s.sessionWraps.has(k)) s.sessionWraps.set(k, { sessionId, epoch, id, sealed }) },
    sessionWraps: (sessionId, id, afterEpoch = 0) => [...s.sessionWraps.values()].filter(w => w.sessionId === sessionId && w.id === id && w.epoch > afterEpoch).sort((a, b) => a.epoch - b.epoch),
    putSessionBackLink(sessionId, epoch, bytes) { const k = `${sessionId}:${epoch}`; if (!s.sessionLinks.has(k)) s.sessionLinks.set(k, { epoch, bytes }) },
    sessionBackLinks: sessionId => [...s.sessionLinks].filter(([k]) => k.startsWith(`${sessionId}:`)).map(([, v]) => v).sort((a, b) => a.epoch - b.epoch),
    // Kept for the old board's pairing routes (server/pairing.mjs).
    bindSession(device, session) { s.sessions.set(device, session) },
    sessionOf: device => s.sessions.get(device) ?? null,
    boundSessions: () => [...s.sessions.values()],
  }
}

const slug = name => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent'
const isZeroId = b => b.every(x => x === 0)

/**
 * createHub({ hubUrl, storage, now, rng }) -> hub. Byte values are Uint8Array, ids travel as hex strings
 * in results. Every refusal is a ZError with a stable `code`.
 */
export async function createHub({ hubUrl, storage = memoryStorage(), now = Date.now, rng = n => globalThis.crypto.getRandomValues(new Uint8Array(n)), randomSessionIds = false }) {
  if (!hubUrl) fail('bad-argument', 'the hub needs its own address: devices sign it when they sign in')
  let state = null                       // the verified member list
  const chains = z.newChains()           // per-sender envelope chains, as far as the hub accepted them
  const challenges = new Map()           // b64u(challenge) -> expiry
  const sessions = new Map()             // token -> { id, kind, role, expiresAt }
  const live = new Map()                 // (old board) agent session id -> instance
  const leases = new Map()               // agent device id -> { instance, generation, expiresAt }
  const epochSince = new Map()           // room key epoch -> when the entry that started it arrived (R3)
  const sessionCache = new Map()         // session id -> { state, since: Map(epoch -> arrival) }

  // Come back up from what is stored: the member list is verified again. A storage that keeps every
  // envelope's hash and chain position in columns (hub/store.mjs) hands over the head of each sender's chain
  // instead of all envelopes: they were verified when they came in, and older hashes are looked up only when
  // a replay or a `seen` entry asks for them. Startup then costs the member list only.
  const tx = storage.transaction ? fn => storage.transaction(fn) : fn => fn()
  const stored = storage.entries()
  if (stored.length) {
    state = await z.verifyLog(stored)
    const times = storage.entryTimes?.() ?? []
    for (const [epoch, info] of state.epochs) epochSince.set(epoch, times[info.seq] ?? 0)
  }
  if (storage.chainHeads) {
    for (const c of storage.chainHeads()) chains.set(b64u(unhex(c.sender)), { seq: c.seq, hash: c.hash, hashes: lazyHashes(storage, c.sender) })
  } else {
    for (const e of storage.envelopes(0, Infinity)) await z.verifyEnvelope(e.bytes, { state, chains, allowRemovedSender: true })
  }

  // One change at a time: verification is asynchronous, and two writes must not both see the same head.
  let queue = Promise.resolve()
  const serial = fn => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run }

  const room = () => state ?? fail('no-room', 'no room has been founded on this hub')
  const id = bytes => hex(bytes)
  const roleName = r => (r === ROLE.HUMAN ? 'human' : 'agent')
  const activeRole = devId => z.memberAt(room(), typeof devId === 'string' ? unhex(devId) : devId)?.role ?? null

  function session(token, { human = false, member = false } = {}) {
    const s = sessions.get(token)
    if (!s || now() > s.expiresAt) { sessions.delete(token); fail('unauthorised', 'sign in first') }
    // A removal takes effect at once, not when the token runs out; a spent recovery code as well (C16).
    if (s.kind === 'member' && !z.memberAt(room(), s.idBytes)) { sessions.delete(token); fail('not-member', 'this device was removed') }
    if (s.kind === 'recovery' && !bytesEqual(s.idBytes, room().recovery.id)) { sessions.delete(token); fail('unauthorised', 'this recovery code was replaced') }
    if ((member || human) && s.kind !== 'member') fail('forbidden', 'the recovery key only reads the member list and its own sealed keys')
    if (human && s.role !== ROLE.HUMAN) fail('forbidden', 'agents cannot do this')
    return s
  }
  const sweepTokens = () => { const t = now(); for (const [k, s] of sessions) if (t > s.expiresAt) sessions.delete(k) }

  function checkWraps(wraps, wanted, sizeOf) {
    const given = new Map()
    for (const w of wraps ?? []) {
      if (!(w?.id instanceof Uint8Array) || !(w?.sealed instanceof Uint8Array)) fail('bad-format', 'a wrap is { id, sealed }')
      if (given.has(id(w.id))) fail('bad-format', 'two wraps for one recipient')
      given.set(id(w.id), w.sealed)
    }
    if (given.size !== wanted.length) fail('incomplete', `this needs ${wanted.length} sealed keys, got ${given.size}`)
    for (const r of wanted) {
      const sealed = given.get(id(r.id))
      if (!sealed) fail('incomplete', `no sealed key for ${id(r.id).slice(0, 8)}`)
      // The hub cannot look inside. Length tells whether the history key is in it.
      if (!isSealed(sealed, sizeOf(r))) fail('bad-format', 'not a sealed key of the right kind for this recipient')
    }
    return [...given].map(([k, sealed]) => ({ id: k, sealed }))
  }

  async function acceptEntry({ entry, wraps, backLink }, founding) {
    if (!(entry instanceof Uint8Array)) fail('bad-format', 'entry must be bytes')
    const body = entry.slice(0, Math.max(0, entry.length - 64))
    const h = await z.hash(z.LABEL.logEntry, body)
    if (state?.hashes.some(x => bytesEqual(x, h))) fail('replay', 'this entry is already in the member list')
    if (founding && state) fail('room-exists', 'this hub already has a room')
    if (!founding) room()
    const next = await z.applyEntry(state, entry)      // throws bad-entry, bad-signature, bad-format
    const e = next.entries.at(-1)
    if (founding !== (e.type === ENTRY.GENESIS)) fail('bad-entry', 'a room is founded through found(), and only once')

    // The room key goes to human devices and the recovery key only (R6): an agent's add carries no wrap.
    const recovery = { id: next.recovery.id, role: ROLE.HUMAN }
    let wanted
    if (e.type === ENTRY.ADD) {
      const m = z.memberAt(next, await z.deviceId(e.member.signPub, e.member.kexPub))
      wanted = m.role === ROLE.HUMAN ? [m] : []
    } else wanted = [...z.activeMembers(next).filter(m => m.role === ROLE.HUMAN), recovery]
    const sealed = checkWraps(wraps, wanted, () => WRAP_HUMAN)
    const rotated = e.type === ENTRY.REMOVE || e.type === ENTRY.RECOVER || e.type === ENTRY.GENESIS
    if (rotated && e.type !== ENTRY.GENESIS) {
      if (!(backLink instanceof Uint8Array) || backLink.length !== BACK_LINK || backLink[0] !== 1 || backLink[1] !== z.OBJ.BACK_LINK ||
          new DataView(backLink.buffer, backLink.byteOffset).getUint32(2) !== next.epoch) fail('incomplete', 'a new room key comes with the link back to the old one')
    } else if (backLink) fail('bad-format', 'only an epoch change carries a back link')

    // An add that names an invite must be the outcome of that invite: the device the inviter answered, in the invited role.
    let inv = null
    if (e.type === ENTRY.ADD && !isZeroId(e.inviteId)) {
      inv = storage.invite(id(e.inviteId))
      if (!inv) fail('bad-invite', 'the entry names an invite this hub never saw')
      const devId = id(await z.deviceId(e.member.signPub, e.member.kexPub))
      const answered = inv.reveal && inv.requests.find(r => r.hash === inv.reveal.requestHash)
      if (!answered || answered.device !== devId || inv.role !== roleName(e.member.role) || inv.inviter !== id(e.signer)) fail('bad-invite', 'the entry is not the outcome of this invite')
    }

    const at = now()
    const removedIds = [...next.members.values()].filter(m => m.removedSeq === e.seq).map(m => id(m.id))
    // Everything checked: now write, all of it or nothing (C15).
    tx(() => {
      storage.appendEntry(entry, { seq: e.seq, hash: id(next.head.hash), prevHash: id(e.prev), type: e.type, signer: id(e.signer), at, state: next, removed: removedIds })
      for (const w of sealed) storage.putWrap(next.epoch, w.id, w.sealed)
      if (backLink) storage.putBackLink(next.epoch, backLink)
      if (inv) storage.putInvite(inv.id, { ...inv, usedAt: at, entrySeq: e.seq, ...addedOf(next, e) })
    })
    state = next
    if (rotated) epochSince.set(next.epoch, at)
    const signedOut = []
    for (const [token, s] of sessions) {
      if (s.kind === 'recovery' ? !bytesEqual(s.idBytes, state.recovery.id) : !z.memberAt(state, s.idBytes)) { sessions.delete(token); signedOut.push(s.id) }
    }
    for (const d of removedIds) { live.delete(storage.sessionOf?.(d)); leases.delete(d) }
    sessionCache.clear()
    return { seq: e.seq, hash: id(state.head.hash), epoch: state.epoch, type: e.type, signedOut, removed: removedIds }
  }
  // The device an add entry enrolled, for the invite record.
  function addedOf(next, e) {
    if (e.type !== ENTRY.ADD) return {}
    for (const m of next.members.values()) if (m.addedSeq === e.seq) return { member: id(m.id) }
    return {}
  }

  const openInvite = (inviteId, { used = false } = {}) => {
    const inv = storage.invite(typeof inviteId === 'string' ? inviteId : id(inviteId))
    if (!inv) fail('not-found', 'no such invite')
    if (inv.burnedAt) fail('invite-burned', 'the inviter called this invite off')
    if (!used && inv.usedAt) fail('invite-used', 'this invite already produced a member')
    if (inv.usedAt && now() - inv.usedAt > INVITE_AFTER_USE_MS) fail('invite-expired', 'this invite was used and is closed now')
    if (!inv.usedAt && now() > inv.expiresAt) fail('invite-expired', 'this invite has run out')
    return inv
  }

  // ---- session grants (R6) ---------------------------------------------------------

  async function sessionOf(sessionId) {
    let c = sessionCache.get(sessionId)
    if (c) return c
    let st = null
    const since = new Map()
    for (const g of storage.grants(sessionId)) {
      const prev = st
      st = await applyGrant(st, g.bytes, room())
      if (!prev || st.epoch !== prev.epoch) since.set(st.epoch, g.receivedAt)
    }
    c = { state: st, since }
    sessionCache.set(sessionId, c)
    return c
  }
  /** The agents currently assigned to a session: in its newest grant and still active members. */
  const assignedAgents = st => (st?.agentIds ?? []).filter(a => activeRole(a) === ROLE.AGENT)

  async function acceptGrant({ sessionId, grant, wraps, backLink }) {
    if (!/^[0-9a-f]{32}$/.test(sessionId ?? '')) fail('bad-argument', 'a session id is 32 hex characters')
    if (!(grant instanceof Uint8Array)) fail('bad-format', 'grant must be bytes')
    const c = await sessionOf(sessionId)
    const prev = c.state
    const next = await applyGrant(prev, grant, room())          // chain, signer at its log state, agents, commitments
    if (next.sessionId !== sessionId) fail('bad-argument', 'the grant names another session')
    // The signer must still be an active human device (or the room's current recovery key).
    if (!bytesEqual(unhex(next.signerId), room().recovery.id) && activeRole(next.signerId) !== ROLE.HUMAN) fail('forbidden', 'the signer is no longer an active human device')
    for (const a of next.agentIds) if (activeRole(a) !== ROLE.AGENT) fail('bad-grant', 'an assigned agent is no longer a member')
    // Sealed keys: every active human device, the recovery key, every assigned agent. Agents without history get the key only.
    const humans = z.activeMembers(room()).filter(m => m.role === ROLE.HUMAN).map(m => ({ id: m.id, human: true }))
    const wanted = [...humans, { id: room().recovery.id, human: true }, ...next.agentIds.map(a => ({ id: unhex(a), human: next.withHistory }))]
    const given = checkWraps(wraps, wanted, r => (r.human ? WRAP_HUMAN : WRAP_AGENT))
    if (!bytesEqual(await grantManifestHash(wraps), next.manifestHash)) fail('bad-grant', 'the sealed keys are not the ones the grant lists')
    const rose = prev && next.epoch > prev.epoch
    if (rose) {
      if (!(backLink instanceof Uint8Array) || backLink.length !== SESSION_BACK_LINK || backLink[0] !== 1 || backLink[1] !== 0x0f ||
          id(backLink.slice(2, 18)) !== sessionId || new DataView(backLink.buffer, backLink.byteOffset).getUint32(18) !== next.epoch) fail('incomplete', 'a new session key comes with the link back to the old one')
    } else if (backLink) fail('bad-format', 'only a new session key epoch carries a back link')
    const at = now()
    tx(() => {
      storage.putGrant(sessionId, { bytes: grant, grantNumber: next.grantNumber, grantHash: id(next.grantHash), previousGrantHash: prev ? id(prev.grantHash) : '0'.repeat(64), epoch: next.epoch, signer: next.signerId, receivedAt: at })
      for (const w of given) storage.putSessionWrap(sessionId, next.epoch, w.id, w.sealed)
      if (rose) storage.putSessionBackLink(sessionId, next.epoch, backLink)
    })
    if (!prev || rose) c.since.set(next.epoch, at)
    c.state = next
    return { grantNumber: next.grantNumber, grantHash: id(next.grantHash), sessionKeyEpoch: next.epoch, agentIds: next.agentIds }
  }

  // ---- who may write what (R1, R6), the hub's second line --------------------------

  async function authoriseEnvelope(h, senderRole) {
    const sender = id(h.sender)
    const human = senderRole === ROLE.HUMAN
    const recipient = isZeroId(h.recipient) ? null : id(h.recipient)
    let sess = null
    if (h.keyScope === KEY_SCOPE.SESSION) {
      const c = await sessionOf(id(h.sessionId))
      if (!c.state) fail('forbidden', 'no such session')
      sess = { ...c, agents: assignedAgents(c.state) }
      if (!human && !sess.agents.includes(sender)) fail('forbidden', 'this agent is not assigned to the session')
      if (h.epoch > c.state.epoch) fail('wrong-epoch', 'a session key epoch the hub does not know')
      if (h.epoch < c.state.epoch) {
        const since = c.since.get(h.epoch + 1)
        if (since == null || now() - since > z.EPOCH_GRACE_MS) fail('wrong-epoch', 'sent in an old session key epoch: fetch the grants')
      }
    } else {
      if (!human) fail('forbidden', 'agents hold no room key')
      if (h.epoch < room().epoch) {
        const since = epochSince.get(h.epoch + 1)
        if (since == null || now() - since > z.EPOCH_GRACE_MS) fail('wrong-epoch', 'sent in an old key epoch: fetch the member list')
      }
    }
    const scopeOf = info => `${info.keyScope}:${info.sessionId ?? ''}`
    const myScope = `${h.keyScope}:${h.sessionId ? id(h.sessionId) : ''}`
    let pushAllowed = false
    switch (h.kind) {
      case KIND.OBJECT_VERSION:
      case KIND.PERMISSION_REQUEST: {
        const oid = id(h.card.id)
        const info = storage.objectInfo(oid)
        if (!info) {
          if (oid !== id(await z.objectIdOf(h.sender, h.seq))) fail('forbidden', 'a new object id is derived from its creator and sequence number')
          if (h.kind === KIND.PERMISSION_REQUEST && human) fail('forbidden', 'permission requests come from agents')
        } else {
          if (scopeOf(info) !== myScope) fail('forbidden', 'an object stays under the key it was created with')
          if (info.firstKind !== h.kind) fail('forbidden', 'an object keeps its kind')
          const memo = room().members.get(b64u(unhex(info.owner)))?.role === ROLE.HUMAN   // memos: any human device
          if (info.owner !== sender && !(memo && human)) fail('forbidden', 'only its creator writes new versions of an object')
        }
        pushAllowed = h.push
        break
      }
      case KIND.ANSWER:
      case KIND.DECIDE_AGAIN:
      case KIND.VERDICT: {
        if (!human) fail('forbidden', 'answers and verdicts come from human devices')
        const info = storage.objectInfo(id(h.card.id))
        if (!info) fail('forbidden', 'no such object')
        if (recipient !== info.owner) fail('forbidden', "addressed to the object's creator")
        if (scopeOf(info) !== myScope) fail('forbidden', 'answered under the key of the object')
        if (h.kind === KIND.VERDICT && info.firstKind !== KIND.PERMISSION_REQUEST) fail('forbidden', 'a verdict answers a permission request')
        if (h.kind !== KIND.VERDICT && info.firstKind !== KIND.OBJECT_VERSION) fail('forbidden', 'an answer answers an object')
        break
      }
      case KIND.STATUS: break                                   // scope rules above; keys are inside the body
      case KIND.TIMELINE_ITEM: {
        const t = z.parseTimelineId(h.timelineId)
        const ref = id(t.ref)
        if (t.scope === z.TIMELINE_SCOPE.SESSION) {
          // Under that session's key (zcrypto checked). Chat: its agent, or a human writing to it. Canvas: humans and its agent.
          if (!human) break
          if (h.timelineKind === TIMELINE.CHAT && (!recipient || !sess.agents.includes(recipient))) fail('forbidden', "a human's message in a session goes to its agent")
        } else if (t.scope === z.TIMELINE_SCOPE.CARD) {
          const info = storage.objectInfo(ref)
          if (!info) fail('forbidden', 'no such card')
          if (scopeOf(info) !== myScope) fail('forbidden', "a card's chat is under the card's key")
          if (sender !== info.owner && !(human && recipient === info.owner)) fail('forbidden', "a card's chat: its creator, or a human writing to the creator")
        } else if (!human) fail('forbidden', 'desks are for human devices')
        break
      }
      default: fail('bad-format', 'unknown kind')
    }
    return { pushAllowed }
  }

  return {
    hubUrl,
    /** Check a token for a route that is answered outside this module: { id, kind, role } or a ZError. */
    authorise: (token, opts) => { const s = session(token, opts); return { id: s.id, kind: s.kind, role: s.role === ROLE.HUMAN ? 'human' : s.role === ROLE.AGENT ? 'agent' : null } },
    get state() { return state },
    get roomId() { return state ? id(state.roomId) : null },
    /** What the hub knows about the room: the public member list (no names since v1.1). */
    members: () => [...room().members.values()].map(m => ({ id: id(m.id), role: roleName(m.role), name: '', active: m.removedSeq === null })),

    // ---- the member list ---------------------------------------------------------

    found: ({ entry, wraps }) => serial(() => acceptEntry({ entry, wraps }, true)),
    /**
     * Add, remove or recover. The entry authenticates itself (signed by a human member or by the recovery key),
     * so this needs no session. `wraps`: for a human's add, the room key for it; none for an agent's add; for a
     * removal or a recovery, the NEW room key for every human device who stays and the recovery key, with `backLink`.
     */
    postEntry: args => serial(() => acceptEntry(args, false)),
    log({ token, inviteId, after = -1 } = {}) {
      if (inviteId != null) openInvite(inviteId, { used: true })
      else session(token)
      return { roomId: id(room().roomId), head: state.head.seq, entries: storage.entries().slice(after + 1) }
    },

    // ---- signing in --------------------------------------------------------------

    challenge() {
      for (const [k, exp] of challenges) if (now() > exp) challenges.delete(k)
      if (challenges.size > 10000) fail('too-many', 'too many open challenges')
      const c = rng(32)
      challenges.set(b64u(c), now() + CHALLENGE_TTL_MS)
      return c
    },
    /** Trade a signed challenge for a token that lasts ten minutes, bound to this device. Serialised with entries (C16). */
    signIn: signed => serial(async () => {
      const a = await z.verifyHubAuth(signed, { state: room(), hub: hubUrl })
      const k = b64u(a.challenge)
      const exp = challenges.get(k)
      challenges.delete(k)
      if (!exp || now() > exp) fail('bad-challenge', 'this challenge is not ours, was used, or ran out')
      sweepTokens()
      const token = b64u(rng(32))
      const s = { id: id(a.id), idBytes: a.id, kind: a.kind, role: a.member?.role ?? null, expiresAt: now() + SESSION_TTL_MS }
      sessions.set(token, s)
      return { token, id: s.id, kind: s.kind, role: a.member ? roleName(a.member.role) : 'recovery', expiresAt: s.expiresAt }
    }),

    // ---- sealed room keys ----------------------------------------------------------

    wraps(token, { afterEpoch = 0 } = {}) {
      const s = session(token)
      return storage.wraps(s.id, afterEpoch).map(w => ({ epoch: w.epoch, sealed: w.sealed }))
    },
    backLinks(token) {
      const s = session(token)
      if (s.kind === 'member' && s.role !== ROLE.HUMAN) fail('forbidden', 'agents hold no room key')
      return storage.backLinks()
    },

    // ---- session grants and keys -----------------------------------------------------

    /** A human device (or the recovery key) posts a session grant with the session key sealed for everyone who holds it. Self-authenticating. */
    postGrant: args => serial(() => acceptGrant(args)),
    async grants(token, sessionId) {
      session(token)
      return storage.grants(sessionId).map(g => g.bytes)
    },
    /** The caller's own sealed session keys for one session. */
    sessionWraps(token, sessionId, { afterEpoch = 0 } = {}) {
      const s = session(token)
      return storage.sessionWraps(sessionId, s.id, afterEpoch).map(w => ({ epoch: w.epoch, sealed: w.sealed }))
    },
    /** Back links of a session key: humans and the recovery key; an assigned agent only for epochs granted with history. */
    async sessionBackLinks(token, sessionId) {
      const s = session(token)
      const links = storage.sessionBackLinks(sessionId)
      if (s.kind === 'recovery' || s.role === ROLE.HUMAN) return links
      const c = await sessionOf(sessionId)
      if (!assignedAgents(c.state).includes(s.id)) fail('forbidden', 'not assigned to this session')
      return links.filter(l => c.state.epochs.get(l.epoch)?.withHistory)
    },
    sessionsList: () => (storage.sessions?.() ?? []).map(x => ({ session_id: x.session_id, last_grant_number: x.last_grant_number, session_key_epoch: x.session_key_epoch })),
    /** The current state of a session (for the hub's own routes): { epoch, agentIds, grantNumber } or null. */
    async sessionInfo(sessionId) { const c = await sessionOf(sessionId); return c.state ? { epoch: c.state.epoch, agentIds: assignedAgents(c.state), grantNumber: c.state.grantNumber } : null },

    // ---- invites -------------------------------------------------------------------

    postInvite: (token, offer) => serial(async () => {
      const s = session(token, { human: true })
      const o = await z.verifyInviteOffer(room(), offer, now())
      if (id(o.inviterId) !== s.id) fail('forbidden', 'an offer is posted by the device that signed it')
      const key = id(o.inviteId)
      if (storage.invite(key)) fail('replay', 'this invite is already known')
      if (storage.invites().filter(i => !i.usedAt && now() <= i.expiresAt).length >= MAX_OPEN_INVITES) fail('too-many', 'too many open invites')
      storage.putInvite(key, { id: key, role: roleName(o.role), inviter: s.id, created: now(), expiresAt: o.expiresAt, usedAt: null, offer, requests: [], reveal: null, member: null, entrySeq: null })
      return { inviteId: key, role: roleName(o.role), expiresAt: o.expiresAt }
    }),
    invite(inviteId) {
      const inv = openInvite(inviteId)
      return { offer: inv.offer, role: inv.role, expiresAt: inv.expiresAt, roomId: id(room().roomId), entries: storage.entries() }
    },
    postRequest: (inviteId, request) => serial(async () => {
      const inv = openInvite(inviteId)
      const q = await z.verifyInviteRequest(request)
      if (id(q.inviteId) !== inv.id || !bytesEqual(q.roomId, room().roomId) || roleName(q.role) !== inv.role) fail('bad-invite', 'the request does not belong to this invite')
      if (room().members.has(b64u(q.id))) fail('bad-invite', 'this device is or was a member')
      const requestHash = id(await z.inviteRequestHash(request))
      if (inv.requests.some(r => r.hash === requestHash)) return { requestHash, inviter: inv.inviter, repeated: true }
      if (inv.reveal) fail('invite-used', 'the inviter already answered another request')
      if (inv.requests.length >= MAX_REQUESTS_PER_INVITE) fail('too-many', 'too many requests for one invite')
      storage.putInvite(inv.id, { ...inv, requests: [...inv.requests, { hash: requestHash, bytes: request, device: id(q.id), at: now() }] })
      return { requestHash, inviter: inv.inviter }
    }),
    /** The inviter calls an invite off (a wrong check code was typed): it answers invite-burned from now on. */
    burnInvite: (token, inviteId) => serial(async () => {
      const s = session(token, { human: true })
      const inv = storage.invite(inviteId)
      if (!inv) fail('not-found', 'no such invite')
      if (inv.inviter !== s.id) fail('forbidden', 'not your invite')
      if (inv.usedAt) fail('invite-used', 'this invite already produced a member')
      storage.putInvite(inv.id, { ...inv, burnedAt: now() })
      return { ok: true }
    }),
    requests(token, inviteId) {
      const s = session(token, { human: true })
      const inv = openInvite(inviteId, { used: true })
      if (inv.inviter !== s.id) fail('forbidden', 'not your invite')
      return inv.requests.map(r => r.bytes)
    },
    postReveal: (token, inviteId, reveal) => serial(async () => {
      const s = session(token, { human: true })
      const inv = openInvite(inviteId)
      if (inv.inviter !== s.id) fail('forbidden', 'not your invite')
      const r = await z.verifyInviteReveal(room(), reveal, s.idBytes)
      if (id(r.inviteId) !== inv.id) fail('bad-invite', 'reveal for another invite')
      const requestHash = id(r.requestHash)
      if (!inv.requests.some(q => q.hash === requestHash)) fail('bad-invite', 'reveal for a request the hub never saw')
      if (inv.reveal) fail('invite-used', 'this invite was already answered')
      storage.putInvite(inv.id, { ...inv, reveal: { bytes: reveal, requestHash } })
      return { requestHash }
    }),
    /** For the joining device, polled: 'waiting', 'revealed', 'joined' (with the list and, for a human, its sealed room key), 'taken'. */
    joinStatus(inviteId, requestHash) {
      const inv = openInvite(inviteId, { used: true })
      const mine = inv.requests.find(r => r.hash === requestHash)
      if (!mine) fail('not-found', 'no such request')
      if (inv.reveal && inv.reveal.requestHash !== requestHash) return { status: 'taken' }
      if (inv.usedAt) {
        if (inv.member !== mine.device) return { status: 'taken' }
        const entry = room().entries[inv.entrySeq]
        return { status: 'joined', reveal: inv.reveal?.bytes ?? null, entries: storage.entries(), wrap: storage.wraps(mine.device).find(w => w.epoch === z.epochAt(state, entry.seq))?.sealed ?? null }
      }
      return inv.reveal ? { status: 'revealed', reveal: inv.reveal.bytes } : { status: 'waiting' }
    },

    // ---- envelopes -----------------------------------------------------------------

    /**
     * A member posts one sealed envelope. Refused: a sender who is not the signed-in device, a removed sender,
     * a bad signature, a replay, a gap, a second envelope under a number already taken, anything the sender may
     * not write (R1, R6), an old key epoch after the grace (R3, wrong-epoch), an older lease generation (lease-lost).
     * Returns what the hub may read: { n, push (honoured only from an object's creator), card, kind, recipient }.
     */
    postEnvelope: (token, bytes, { leaseGeneration = null } = {}) => serial(async () => {
      const s = session(token, { member: true })
      const head = z.peekEnvelope(bytes)
      if (head.pruned) fail('bad-format', 'an envelope is posted with its ciphertext')
      if (id(head.header.sender) !== s.id) fail('wrong-sender', 'a device posts its own envelopes only')
      if (leaseGeneration != null) {
        const l = leases.get(s.id)
        if (l && l.generation !== leaseGeneration) fail('lease-lost', 'another process took over this agent key')
      }
      const v = await z.verifyEnvelope(bytes, { state: room(), chains, commit: false })
      const h = v.header
      const { pushAllowed } = await authoriseEnvelope(h, s.role)
      const card = h.card ? { id: id(h.card.id), state: h.card.state, urgency: h.card.urgency, answeredAt: h.card.answeredAt } : null
      const n = storage.appendEnvelope(bytes, {
        sender: s.id, seq: h.seq, epoch: h.epoch, recipient: isZeroId(h.recipient) ? null : id(h.recipient), push: pushAllowed, card, time: now(), pruned: false,
        header: h, hash: v.hash, ciphertextHash: v.ciphertextHash, headerBytes: v._split.headerBytes, nonce: v._split.nonce, ciphertext: v._split.ct, signature: v._split.signature,
      })
      // The chain advances only once the envelope is stored: a failed write must not leave the hub a number ahead (C15).
      const k = b64u(h.sender)
      // With a store that can look hashes up, memory holds only a small window per chain (no growth per envelope).
      const c = chains.get(k) ?? { seq: 0, hash: null, hashes: storage.envelopeHash ? lazyHashes(storage, id(h.sender)) : new Map() }
      c.seq = h.seq; c.hash = v.hash; c.hashes.set(h.seq, v.hash)
      chains.set(k, c)
      return { n, push: pushAllowed, card, isHead: h.isHead, kind: h.kind, recipient: isZeroId(h.recipient) ? null : id(h.recipient) }
    }),

    envelopes(token, { after = 0, limit = 200 } = {}) {
      session(token, { member: true })
      return storage.envelopes(after, limit).map(e => ({ n: e.n, bytes: e.bytes, pruned: e.pruned }))
    },
    cards() {
      const out = new Map()
      for (const e of storage.envelopes(0, Infinity)) if (e.card) out.set(e.card.id, { ...e.card, n: e.n })
      return [...out.values()]
    },
    /**
     * Retention: 30 days after an object's newest head (accepted, so authorised) closed or answered it, by the hub's
     * own arrival time (a sender's answered_at is display only), every envelope of it loses its ciphertext.
     */
    prune: ({ days = RETENTION_DAYS } = {}) => serial(async () => {
      const done = new Map()
      const all = storage.envelopes(0, Infinity)
      for (const e of all) if (e.card && e.header?.isHead !== false) done.set(e.card.id, e.card.state !== z.CARD_STATE.OPEN ? e.time : null)
      let pruned = 0
      for (const e of all) {
        const at = e.card && done.get(e.card.id)
        if (!at || e.pruned || now() - at < days * DAY) continue
        storage.replaceEnvelope(e.n, await z.pruneEnvelope(e.bytes))
        pruned++
      }
      return { pruned }
    }),

    // ---- an agent's lease (R4) -------------------------------------------------------

    /**
     * One running process per agent key. A new process instance takes the lease over (the caller closes the old
     * process's streams); posts name the generation they hold, an older one gets lease-lost. The generation only
     * grows, also across hub restarts (it starts from the clock). The board id of an agent is hex(device_id)[0..16].
     * Returns { generation, expiresAt, previousInstance }.
     */
    takeLease(token, { instance }) {
      const s = session(token, { member: true })
      if (s.role !== ROLE.AGENT) fail('forbidden', 'only agents hold a lease')
      if (typeof instance !== 'string' || !instance) fail('bad-argument', 'process_instance')
      const old = leases.get(s.id)
      if (old && old.instance === instance && now() <= old.expiresAt) { old.expiresAt = now() + LEASE_MS; return { generation: old.generation, expiresAt: old.expiresAt, previousInstance: null } }
      const generation = Math.max((old?.generation ?? 0) + 1, now())
      const l = { instance, generation, expiresAt: now() + LEASE_MS }
      leases.set(s.id, l)
      return { generation, expiresAt: l.expiresAt, previousInstance: old && old.instance !== instance ? old.instance : null }
    },
    /** Keep a lease alive while its process has a stream open; end it when the last stream closed. */
    touchLease(deviceId) { const l = leases.get(deviceId); if (l) l.expiresAt = now() + LEASE_MS },
    leaseOf: deviceId => leases.get(deviceId) ?? null,

    // ---- the old board's agent ids (server/pairing.mjs) ---------------------------------

    claimSession(token, { name, instance }) {
      const s = session(token, { member: true })
      if (s.role !== ROLE.AGENT) fail('forbidden', 'only agents have a board session')
      if (!instance) fail('bad-argument', 'instance')
      let sessionId = storage.sessionOf(s.id)
      if (!sessionId) {
        const taken = new Set(storage.boundSessions())
        if (randomSessionIds) { do sessionId = hex(rng(8)); while (taken.has(sessionId)) }
        else { sessionId = slug(name); for (let n = 2; taken.has(sessionId); n++) sessionId = `${slug(name)}-${n}` }
        storage.bindSession(s.id, sessionId)
      }
      const holder = live.get(sessionId)
      if (holder && holder !== instance) fail('instance-conflict', 'another process is running with this key file')
      live.set(sessionId, instance)
      return { sessionId, device: s.id }
    },
    releaseSession(sessionId, instance) { if (live.get(sessionId) === instance) live.delete(sessionId) },
    releaseDevice(deviceId) { const sid = storage.sessionOf?.(deviceId); if (sid) live.delete(sid); leases.delete(deviceId) },
  }
}

/** The hashes of one sender's chain, looked up in the store when asked (replay, `seen`), the newest kept in memory. */
function lazyHashes(storage, sender) {
  const recent = new Map()
  return {
    get(seq) { return recent.get(seq) ?? storage.envelopeHash(sender, seq) ?? undefined },
    set(seq, hash) { recent.set(seq, hash); if (recent.size > 32) recent.delete(recent.keys().next().value) },
  }
}
