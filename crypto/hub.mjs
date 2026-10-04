// hub.mjs: what the hub does for pairing and keys, as one module without HTTP and without a database.
//
// The hub holds no key and decides nothing about content. It keeps the signed member list, the sealed
// room keys, open invites and sealed envelopes, and it refuses what a hub must refuse:
//   - a member-list entry that a current human member (or the recovery key) did not sign,
//   - anything from a removed member: sign-in, envelopes, entries,
//   - a replayed entry or envelope, a gap or a second history in a sender's chain,
//   - an epoch change that does not bring a sealed key for everyone who stays.
// Clients check all of this again; the hub's checks keep junk out and metadata in. See docs/pairing.md.
//
// Not wired into server/server.mjs. `memoryStorage()` stands in for server/store/store.mjs; the methods it
// has are the ones the store must offer (see the note at the end of docs/pairing.md).

import * as z from './zcrypto.mjs'

const { ZError, ROLE, ENTRY, b64u, hex, bytesEqual } = z
const fail = (code, message, extra) => { throw new ZError(code, message, extra) }

export const CHALLENGE_TTL_MS = 2 * 60 * 1000
export const SESSION_TTL_MS = 10 * 60 * 1000
export const MAX_OPEN_INVITES = 16
export const MAX_REQUESTS_PER_INVITE = 4
export const RETENTION_DAYS = 30
const DAY = 86400000
const WRAP_AGENT = 2 + 32 + 33 + 16      // sealed box around 0x01 || key
const WRAP_HUMAN = 2 + 32 + 65 + 16      // sealed box around 0x02 || key || hist
const BACK_LINK = 2 + 4 + 64 + 16

/** In-memory stand-in for the store. Everything the hub keeps is here, and nothing in it opens anything. */
export function memoryStorage() {
  const s = { log: [], wraps: new Map(), backLinks: new Map(), invites: new Map(), envelopes: [], sessions: new Map() }
  return {
    _data: s,
    entries: () => [...s.log],
    appendEntry(bytes) { s.log.push(bytes) },
    putWrap(epoch, id, sealed) { const k = `${epoch}:${id}`; if (!s.wraps.has(k)) s.wraps.set(k, { epoch, id, sealed }) },
    wraps: (id, afterEpoch = 0) => [...s.wraps.values()].filter(w => w.id === id && w.epoch > afterEpoch).sort((a, b) => a.epoch - b.epoch),
    putBackLink(epoch, bytes) { if (!s.backLinks.has(epoch)) s.backLinks.set(epoch, bytes) },
    backLinks: () => [...s.backLinks].sort((a, b) => a[0] - b[0]).map(([epoch, bytes]) => ({ epoch, bytes })),
    putInvite(id, invite) { s.invites.set(id, invite) },
    invite: id => s.invites.get(id) ?? null,
    invites: () => [...s.invites.values()],
    appendEnvelope(bytes, meta) { s.envelopes.push({ n: s.envelopes.length + 1, bytes, ...meta }); return s.envelopes.length },
    envelopes: (after = 0, limit = 200) => s.envelopes.filter(e => e.n > after).slice(0, limit),
    replaceEnvelope(n, bytes) { s.envelopes[n - 1] = { ...s.envelopes[n - 1], bytes, pruned: true } },
    bindSession(device, session) { s.sessions.set(device, session) },
    sessionOf: device => s.sessions.get(device) ?? null,
    boundSessions: () => [...s.sessions.values()],
  }
}

const slug = name => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent'

/**
 * createHub({ hubUrl, storage, now, rng }) -> hub. Byte values are Uint8Array, ids travel as hex strings
 * in results. Every refusal is a ZError with a stable `code`.
 */
export async function createHub({ hubUrl, storage = memoryStorage(), now = Date.now, rng = n => globalThis.crypto.getRandomValues(new Uint8Array(n)), emptyNames = false, randomSessionIds = false }) {
  if (!hubUrl) fail('bad-argument', 'the hub needs its own address: devices sign it when they sign in')
  let state = null                       // the verified member list
  const chains = z.newChains()           // per-sender envelope chains, as far as the hub accepted them
  const challenges = new Map()           // b64u(challenge) -> expiry
  const sessions = new Map()             // token -> { id, kind, role, expiresAt }
  const live = new Map()                 // agent session id -> instance (one process per key file)

  // Come back up from what is stored: the hub trusts its own disk no more than a client trusts the hub.
  // A storage that keeps every envelope's hash and chain position in columns (hub/store.mjs) can hand over
  // the head of each sender's chain instead: the envelopes were verified when they came in, and older hashes
  // are looked up only when a replay or a `seen` entry asks for them. Startup then costs the member list only.
  const tx = storage.transaction ? fn => storage.transaction(fn) : fn => fn()
  const stored = storage.entries()
  if (stored.length) state = await z.verifyLog(stored)
  if (storage.chainHeads) {
    for (const c of storage.chainHeads()) chains.set(b64u(z.unhex(c.sender)), { seq: c.seq, hash: c.hash, hashes: lazyHashes(storage, c.sender) })
  } else {
    for (const e of storage.envelopes(0, Infinity)) await z.verifyEnvelope(e.bytes, { state, chains, allowRemovedSender: true })
  }

  // One change at a time: verification is asynchronous, and two entries must not both see the same head.
  let queue = Promise.resolve()
  const serial = fn => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run }

  const room = () => state ?? fail('no-room', 'no room has been founded on this hub')
  const id = bytes => hex(bytes)
  const roleName = r => (r === ROLE.HUMAN ? 'human' : 'agent')

  function session(token, { human = false, member = false } = {}) {
    const s = sessions.get(token)
    if (!s || now() > s.expiresAt) { sessions.delete(token); fail('unauthorised', 'sign in first') }
    // A removal takes effect at once, not when the token runs out.
    if (s.kind === 'member' && !z.memberAt(room(), s.idBytes)) { sessions.delete(token); fail('not-member', 'this device was removed') }
    if ((member || human) && s.kind !== 'member') fail('forbidden', 'the recovery key only reads the member list and its own sealed keys')
    if (human && s.role !== ROLE.HUMAN) fail('forbidden', 'agents cannot do this')
    return s
  }

  function checkWraps(next, wraps, wanted) {
    const given = new Map()
    for (const w of wraps ?? []) {
      if (!(w?.id instanceof Uint8Array) || !(w?.sealed instanceof Uint8Array)) fail('bad-format', 'a wrap is { id, sealed }')
      if (given.has(id(w.id))) fail('bad-format', 'two wraps for one recipient')
      given.set(id(w.id), w.sealed)
    }
    if (given.size !== wanted.length) fail('incomplete', `this entry needs ${wanted.length} sealed keys, got ${given.size}`)
    for (const r of wanted) {
      const sealed = given.get(id(r.id))
      if (!sealed) fail('incomplete', `no sealed key for ${r.name || id(r.id).slice(0, 8)}`)
      // The hub cannot look inside. Length tells whether the history key is in it: never for an agent.
      if (sealed.length !== (r.role === ROLE.AGENT ? WRAP_AGENT : WRAP_HUMAN) || sealed[0] !== 1 || sealed[1] !== z.OBJ.SEALED) fail('bad-format', 'not a sealed room key for this kind of member')
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
    if (emptyNames && e.member && e.member.name !== '') fail('bad-format', 'device names are not given to the hub: the name field must be empty')

    const recovery = { id: next.recovery.id, role: ROLE.HUMAN, name: 'the recovery key' }
    let wanted
    if (e.type === ENTRY.ADD) wanted = [z.memberAt(next, (await z.deviceId(e.member.signPub, e.member.kexPub)))]
    else wanted = [...z.activeMembers(next), recovery]
    const sealed = checkWraps(next, wraps, wanted)
    const rotated = e.type === ENTRY.REMOVE || e.type === ENTRY.RECOVER
    if (rotated) {
      if (!(backLink instanceof Uint8Array) || backLink.length !== BACK_LINK || backLink[0] !== 1 || backLink[1] !== z.OBJ.BACK_LINK ||
          new DataView(backLink.buffer, backLink.byteOffset).getUint32(2) !== next.epoch) fail('incomplete', 'a new room key comes with the link back to the old one')
    } else if (backLink) fail('bad-format', 'only an epoch change carries a back link')

    // An add that names an invite must be the outcome of that invite: the device the inviter answered, in the invited role.
    let inv = null
    if (e.type === ENTRY.ADD && !e.inviteId.every(b => b === 0)) {
      inv = storage.invite(id(e.inviteId))
      if (!inv) fail('bad-invite', 'the entry names an invite this hub never saw')
      const answered = inv.reveal && inv.requests.find(r => r.hash === inv.reveal.requestHash)
      if (!answered || answered.device !== id(wanted[0].id) || inv.role !== roleName(e.member.role) || inv.inviter !== id(e.signer)) fail('bad-invite', 'the entry is not the outcome of this invite')
    }

    // Everything checked: now write, all of it or nothing.
    tx(() => {
      storage.appendEntry(entry, { seq: e.seq, hash: id(next.head.hash), prevHash: id(e.prev), type: e.type, signer: id(e.signer), at: now(), state: next })
      for (const w of sealed) storage.putWrap(next.epoch, w.id, w.sealed)
      if (rotated) storage.putBackLink(next.epoch, backLink)
      if (inv) storage.putInvite(inv.id, { ...inv, usedAt: now(), member: id(wanted[0].id), entrySeq: e.seq })
    })
    state = next
    const removed = []
    for (const [token, s] of sessions) {
      if (s.kind === 'recovery' ? rotated && e.type === ENTRY.RECOVER : !z.memberAt(state, s.idBytes)) { sessions.delete(token); removed.push(s.id) }
    }
    for (const m of state.members.values()) if (m.removedSeq === e.seq) live.delete(storage.sessionOf(id(m.id)))
    const removedIds = [...state.members.values()].filter(m => m.removedSeq === e.seq).map(m => id(m.id))
    return { seq: e.seq, hash: id(state.head.hash), epoch: state.epoch, type: e.type, signedOut: removed, removed: removedIds }
  }

  const openInvite = (inviteId, { used = false } = {}) => {
    const inv = storage.invite(typeof inviteId === 'string' ? inviteId : id(inviteId))
    if (!inv) fail('not-found', 'no such invite')
    if (!used && inv.usedAt) fail('invite-used', 'this invite already produced a member')
    if (!inv.usedAt && now() > inv.expiresAt) fail('invite-expired', 'this invite has run out')
    return inv
  }

  return {
    hubUrl,
    /** Check a token for a route that is answered outside this module: { id, kind, role } or a ZError. */
    authorise: (token, opts) => { const s = session(token, opts); return { id: s.id, kind: s.kind, role: s.role === ROLE.HUMAN ? 'human' : s.role === ROLE.AGENT ? 'agent' : null } },
    get state() { return state },
    get roomId() { return state ? id(state.roomId) : null },
    /** What the hub knows about the room: the public member list, nothing else. */
    members: () => [...room().members.values()].map(m => ({ id: id(m.id), role: roleName(m.role), name: m.name, active: m.removedSeq === null })),

    // ---- the member list ---------------------------------------------------------

    /** The first device founds the room. The caller must have checked today's owner token: an empty hub takes any valid genesis. */
    found: ({ entry, wraps }) => serial(() => acceptEntry({ entry, wraps }, true)),

    /**
     * Add, remove or recover. The entry authenticates itself (it is signed by a human member or by the
     * recovery key), so this needs no session: a recovering human has no device yet.
     * `wraps`: [{ id, sealed }]: for an add, the room key for the new member; for a removal or a recovery,
     * the NEW room key for every member who stays (agents included) and for the recovery key. `backLink` with the latter.
     */
    postEntry: args => serial(() => acceptEntry(args, false)),

    /** The signed entries after number `after` (-1 for all). For members, the recovery key, and a joiner who names an open invite. */
    log({ token, inviteId, after = -1 } = {}) {
      if (inviteId != null) openInvite(inviteId, { used: true })
      else session(token)
      return { roomId: id(room().roomId), head: state.head.seq, entries: storage.entries().slice(after + 1) }
    },

    // ---- signing in --------------------------------------------------------------

    /** 32 random bytes to sign, good for two minutes and for one use. */
    challenge() {
      for (const [k, exp] of challenges) if (now() > exp) challenges.delete(k)
      const c = rng(32)
      challenges.set(b64u(c), now() + CHALLENGE_TTL_MS)
      return c
    },
    /** Trade a signed challenge (z.signHubAuth) for a token that lasts ten minutes and is bound to this device. */
    async signIn(signed) {
      const a = await z.verifyHubAuth(signed, { state: room(), hub: hubUrl })
      const k = b64u(a.challenge)
      const exp = challenges.get(k)
      challenges.delete(k)
      if (!exp || now() > exp) fail('bad-challenge', 'this challenge is not ours, was used, or ran out')
      const token = b64u(rng(32))
      const s = { id: id(a.id), idBytes: a.id, kind: a.kind, role: a.member?.role ?? null, expiresAt: now() + SESSION_TTL_MS }
      sessions.set(token, s)
      return { token, id: s.id, kind: s.kind, role: a.member ? roleName(a.member.role) : 'recovery', expiresAt: s.expiresAt }
    },

    // ---- sealed room keys ----------------------------------------------------------

    /** The caller's own sealed room keys, one per epoch it was a member of. Nobody gets another member's. */
    wraps(token, { afterEpoch = 0 } = {}) {
      const s = session(token)
      return storage.wraps(s.id, afterEpoch).map(w => ({ epoch: w.epoch, sealed: w.sealed }))
    },
    /** The links from each room key back to the one before. Only human devices and the recovery key can open them; agents are not handed them. */
    backLinks(token) {
      const s = session(token)
      if (s.kind === 'member' && s.role !== ROLE.HUMAN) fail('forbidden', 'agents do not read back in history')
      return storage.backLinks()
    },

    // ---- invites -------------------------------------------------------------------

    /** A human member announces an invite: the signed offer. The hub never sees the secret behind the # of the link. */
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

    /** For the joining device, which derived the invite id from the link: the offer and the member list to check it against. */
    invite(inviteId) {
      const inv = openInvite(inviteId)
      return { offer: inv.offer, role: inv.role, expiresAt: inv.expiresAt, roomId: id(room().roomId), entries: storage.entries() }
    },

    /** The joining device's request. The hub checks form and self-signature; only the inviter can check the MAC. */
    postRequest: (inviteId, request) => serial(async () => {
      const inv = openInvite(inviteId)
      const q = await z.verifyInviteRequest(request)
      if (emptyNames && q.name !== '') fail('bad-format', 'device names are not given to the hub: the name field must be empty')
      if (id(q.inviteId) !== inv.id || !bytesEqual(q.roomId, room().roomId) || roleName(q.role) !== inv.role) fail('bad-invite', 'the request does not belong to this invite')
      if (room().members.has(b64u(q.id))) fail('bad-invite', 'this device is or was a member')
      const requestHash = id(await z.hash(z.LABEL.inviteRequest, request))
      if (inv.requests.some(r => r.hash === requestHash)) return { requestHash, inviter: inv.inviter, repeated: true }
      if (inv.reveal) fail('invite-used', 'the inviter already answered another request')
      if (inv.requests.length >= MAX_REQUESTS_PER_INVITE) fail('too-many', 'too many requests for one invite')
      storage.putInvite(inv.id, { ...inv, requests: [...inv.requests, { hash: requestHash, bytes: request, device: id(q.id), at: now() }] })
      return { requestHash, inviter: inv.inviter }
    }),

    /** For the inviter: the requests that came in, in order of arrival. */
    requests(token, inviteId) {
      const s = session(token, { human: true })
      const inv = openInvite(inviteId, { used: true })
      if (inv.inviter !== s.id) fail('forbidden', 'not your invite')
      return inv.requests.map(r => r.bytes)
    },

    /** The inviter answers ONE request by revealing its number. A second reveal is refused. */
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

    /**
     * For the joining device, polled: 'waiting' (nothing yet), 'revealed' (compare the check code now),
     * 'joined' (the member list names it: here are the list and its sealed room key), 'taken' (the inviter
     * answered someone else: the link was used by another device).
     */
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
     * A member posts one sealed envelope. Refused: a sender who is not the signed-in device, a removed
     * sender, a bad signature, a replay, a gap, a second envelope under a number already taken.
     * Returns what the hub may read: { n, push, card: { id, state, urgency, answeredAt } | null }.
     */
    postEnvelope: (token, bytes) => serial(async () => {
      const s = session(token, { member: true })
      const head = z.peekEnvelope(bytes)
      if (head.pruned) fail('bad-format', 'an envelope is posted with its ciphertext')
      if (id(head.header.sender) !== s.id) fail('wrong-sender', 'a device posts its own envelopes only')
      const v = await z.verifyEnvelope(bytes, { state: room(), chains, commit: false })
      const h = v.header
      const card = h.card ? { id: id(h.card.id), state: h.card.state, urgency: h.card.urgency, answeredAt: h.card.answeredAt } : null
      const n = storage.appendEnvelope(bytes, {
        sender: s.id, seq: h.seq, epoch: h.epoch, recipient: h.recipient.every(b => b === 0) ? null : id(h.recipient), push: h.push, card, time: now(), pruned: false,
        header: h, hash: v.hash, ciphertextHash: v.ciphertextHash, headerBytes: v._split.headerBytes, nonce: v._split.nonce, ciphertext: v._split.ct, signature: v._split.signature,
      })
      // The chain advances only once the envelope is stored: a failed write must not leave the hub a number ahead.
      const k = b64u(h.sender)
      // With a store that can look hashes up, memory holds only a small window per chain (no growth per envelope).
      const c = chains.get(k) ?? { seq: 0, hash: null, hashes: storage.envelopeHash ? lazyHashes(storage, id(h.sender)) : new Map() }
      c.seq = h.seq; c.hash = v.hash; c.hashes.set(h.seq, v.hash)
      chains.set(k, c)
      return { n, push: h.push, card, isHead: h.isHead, kind: h.kind, recipient: h.recipient.every(b => b === 0) ? null : id(h.recipient) }
    }),

    /** Envelopes after the hub's number `after`, in the order the hub accepted them. */
    envelopes(token, { after = 0, limit = 200 } = {}) {
      session(token, { member: true })
      return storage.envelopes(after, limit).map(e => ({ n: e.n, bytes: e.bytes, pruned: e.pruned }))
    },

    /** What the hub can say about cards without any key: the newest readable state per card id. */
    cards() {
      const out = new Map()
      for (const e of storage.envelopes(0, Infinity)) if (e.card) out.set(e.card.id, { ...e.card, n: e.n })
      return [...out.values()]
    },

    /**
     * Delete answered cards after 30 days: every envelope of a card whose newest state is answered or
     * closed for longer than that loses its ciphertext. Header, hash and signature stay, so chains hold.
     */
    prune: ({ days = RETENTION_DAYS } = {}) => serial(async () => {
      const done = new Map()
      const all = storage.envelopes(0, Infinity)
      for (const e of all) if (e.card) done.set(e.card.id, e.card.state !== z.CARD_STATE.OPEN ? (e.card.answeredAt || e.time) : null)
      let pruned = 0
      for (const e of all) {
        const at = e.card && done.get(e.card.id)
        if (!at || e.pruned || now() - at < days * DAY) continue
        storage.replaceEnvelope(e.n, await z.pruneEnvelope(e.bytes))
        pruned++
      }
      return { pruned }
    }),

    // ---- an agent's stable id --------------------------------------------------------

    /**
     * The board's session id of an agent ("crypto", "crypto-2") belongs to its member key: the same key
     * file gets the same id back after any restart. `instance` names the running process; a second
     * process with the same key file is refused while the first is linked, because two processes would
     * write two histories under one key.
     */
    claimSession(token, { name, instance }) {
      const s = session(token, { member: true })
      if (s.role !== ROLE.AGENT) fail('forbidden', 'only agents have a board session')
      if (!instance) fail('bad-argument', 'instance')
      let sessionId = storage.sessionOf(s.id)
      if (!sessionId) {
        const taken = new Set(storage.boundSessions())
        if (randomSessionIds) {
          // 16 random hex characters: says nothing about the project or the agent's name.
          do sessionId = hex(rng(8)); while (taken.has(sessionId))
        } else {
          sessionId = slug(name)
          for (let n = 2; taken.has(sessionId); n++) sessionId = `${slug(name)}-${n}`
        }
        storage.bindSession(s.id, sessionId)
      }
      const holder = live.get(sessionId)
      if (holder && holder !== instance) fail('instance-conflict', 'another process is running with this key file')
      live.set(sessionId, instance)
      return { sessionId, device: s.id }
    },
    releaseSession(sessionId, instance) { if (live.get(sessionId) === instance) live.delete(sessionId) },
    /** Forget the running process of this device's session (its last stream closed). */
    releaseDevice(deviceId) { const sid = storage.sessionOf(deviceId); if (sid) live.delete(sid) },
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
