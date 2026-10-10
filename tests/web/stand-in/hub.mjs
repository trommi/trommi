// hub.mjs: a FAKE hub for tests, in this process, on Node's http. TEST ONLY: never shipped, never a hub.
//
// It follows spec/hub-api.md as the real hub (hub/src/*.rs) has it: the routes, the statuses of spec/v1.md section
// 16, the JSON shapes, the room's one `change` counter, each group's ordered log, envelopes filed by their header,
// the Desk, pages, catch-up, the live stream as real server-sent events with resume by `after`, files with `Range`,
// invites, shares, KeyPackages (single use, then the last-resort one), sealed keys, requests, the account, a recovery.
// A repeated post of the same bytes gets the first answer again, as the real hub promises.
//
// What it does NOT check, at all: cryptography. No signature (it takes any, on a sign-in, an Offer, a Reveal, a
// passkey), no MLS (a Commit is accepted when it names the group's current epoch; who it adds or removes is what
// `readers.commit` says), no GroupInfo or KeyPackage validation, no SealedKey or RecoveryLink parsing, no MAC, no
// slow hash (a login key is compared as it is), no envelope rule of v1.md 9 beyond the sender's chain numbers, no
// rate limit, no quota, no retention. It is no evidence that a client is safe against a hub; it is a stage for the
// client's own logic.
// What it also leaves out of the real hub's behaviour: who may see what below "a human device sees all, another
// device its groups" (no public sight of Commits for agents, no pruned form, no Cut marks on a chain, `stale` is
// always false), the 8 MiB budget of an answer and `truncated`, the limits and lifetimes of KeyPackages, requests,
// invites and passkeys (a passkey challenge of an account is bound to the account's revision, as the real one), transactions (a refused request may leave a part of its writes), the checks of a recovery's
// parts and that its finish replaces the recovery key, push endpoints, `/v2/link`, `/v2/live-activity`,
// `/v2/push-envelope`, `Trommi-Lease`, the stream's bounded queue and pings. Cross-origin requests are answered for
// any origin. tests/web/hub/real-hub.test.mjs runs the client against the real hub for what must not rest on this.
//
// The structs it must look into are read by `opts.readers`. By default each is UTF-8 JSON, which is what the stand-in
// core (tests/web/stand-in/core.ts) writes; ids in them are base64url text:
//   hubAuth    { room_id, hub, device, challenge }
//   groupInfo  { group, epoch, leaves?: [device], session?: { session_id, parent }, recovery_signature_key? }
//   commit     { added?: [device], removed?: [device], agents?: [device] }          (anything else: no change of members)
//   envelope   { group, sender, seq, kind, timeline?: { kind, scope, ref }, object?: { object_id, object_type,
//                object_state, urgency, answered_at }, register_id?, file_ids }      (names as core-api EnvelopeHeader)
//   offer      { room_id, invite_id, expires_at }        reveal  { invite_id, request_hash }
//   requestHash(request, mac)  optional: the hash a Reveal names its Request by (default: SHA-256 of both)
//
// Faults (`hub.faults`): rules matched against a request, each used `times` times (default once):
//   hub.faults.add({ method?, path?: string | RegExp, when?: req => boolean, times?,
//     delay_ms?,                          wait, then go on
//     drop?: 'before' | 'after' | 'mid',  cut the connection: unhandled / handled but unanswered / in the answer's middle
//     refuse?: { error, message?, voided?, retry_after?, status? },   answer this refusal, handle nothing
//     raw?: { status, headers?, body },   answer exactly this, handle nothing
//     answer?: json => json })            handle, then answer what this makes of the real answer (a hostile hub)
//   hub.faults.clear()
// `hub.requests` logs every request received (method, path, query, body, device, status, dropped): tests assert the
// order and exactly-once on it. `hub.restart()` kills the hub and starts it again on the same port with its state;
// tokens and challenges are forgotten, as the real hub's are. `hub.push(room, text)` writes raw text into the room's
// streams and `hub.dropStreams()` cuts them.
import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'

const b64 = bytes => Buffer.from(bytes).toString('base64url')
const unb64 = text => {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) return null
  const bytes = Buffer.from(text, 'base64url')
  return b64(bytes) === text ? bytes : null
}
const sha256 = bytes => createHash('sha256').update(bytes).digest()
const json = bytes => JSON.parse(Buffer.from(bytes).toString('utf8'))

/** The statuses of the codes, as hub/src/error.rs `status_of`. */
const STATUS = {
  400: ['bad-format', 'newer-version', 'bad-commit', 'bad-signature', 'bad-invite', 'bad-key-package', 'wrong-room', 'incomplete', 'chain-break', 'bad-email', 'bad-passkey'],
  401: ['unauthorised', 'bad-challenge', 'wrong-login', 'wrong-recovery'],
  403: ['forbidden', 'not-member', 'removed-sender', 'wrong-sender'],
  404: ['not-found', 'no-room'], 405: ['method-not-allowed'], 410: ['gone', 'invite-expired', 'invite-burned'],
  409: ['epoch-taken', 'wrong-epoch', 'room-behind', 'group-behind', 'stale-session', 'epoch-full', 'replay', 'gap', 'equivocation', 'room-exists', 'invite-used', 'lease-lost', 'account-exists', 'last-way-in', 'account-changed'],
  413: ['too-large', 'quota-exceeded'], 416: ['range'], 426: ['client-too-old'], 429: ['too-many', 'rate-limited'], 503: ['overloaded'],
}
const statusOf = code => Number(Object.keys(STATUS).find(s => STATUS[s].includes(code)) ?? 500)

class Refused extends Error {
  constructor(code, message, extra = {}, retry_after = null) { super(message); Object.assign(this, { code, extra, retry_after }) }
}
const refuse = (code, message, extra, retry_after) => new Refused(code, message, extra, retry_after)

export const defaultReaders = {
  hubAuth: bytes => json(bytes), groupInfo: bytes => json(bytes), envelope: bytes => json(bytes), offer: bytes => json(bytes), reveal: bytes => json(bytes),
  commit: bytes => { try { const c = json(bytes); return typeof c === 'object' && c !== null ? c : {} } catch { return {} } },
}

const CHANGES_WINDOW = 20_000
const TURNS_AFTER_CLOSE = 3
const FILE_LIMIT = 64 << 20
const OBJECT_TABLES = { card: 'cards', note: 'notes', request: 'permission_requests', artifact: 'artifacts' }
const STATES = { open: 1, answered: 2, closed: 3 }
const URGENCIES = { low: 0, normal: 1, high: 2, critical: 3 }

function newRoom(room_id) {
  return {
    room_id, change: 0, devices: new Map(), recovery_keys: new Set(), groups: new Map(), changes: [], envelopes: [], chains: new Map(), sealed_keys: [], links: [], welcomes: [],
    key_packages: new Map(), files: new Map(), requests: [], push: new Map(), recovery: null, finished: new Map(), founding: null,
  }
}
/** Everything the fake hub keeps across a restart. Tests may read it and, to set a scene, write it. */
export function newState() {
  return { rooms: new Map(), accounts: new Map(), invites: new Map(), shares: new Map(), next_id: 1 }
}

export async function startFakeHub(opts = {}) {
  const readers = { ...defaultReaders, ...opts.readers }
  if (opts.readEnvelopeHeader) readers.envelope = opts.readEnvelopeHeader
  const state = opts.state ?? newState()
  const rules = []
  const faults = {
    add(rule) { const r = { times: 1, ...rule }; rules.push(r); return r },
    clear() { rules.length = 0 },
  }
  const requests = []
  let session, server, sockets, streams, url = null
  const now = () => Date.now()

  // ---- what a request needs

  const room = id => state.rooms.get(id)
  function standing(r, device) { return r.devices.get(device) ?? (r.recovery_keys.has(device) ? 'recovery' : null) }
  function auth(rq) {
    const token = /^Bearer ([A-Za-z0-9_-]{16,200})$/.exec(rq.headers.authorization ?? '')?.[1]
    const held = token && session.tokens.get(token)
    if (!held || held.expires_at <= now()) throw refuse('unauthorised', 'sign in')
    const r = room(held.room), who = standing(r, held.device)
    if (!who) throw refuse('not-member', 'this device is no longer in the room')
    rq.log.device = held.device
    return { room: r, device: held.device, who, expires_at: held.expires_at }
  }
  const human = a => { if (a.who !== 'human') throw refuse('forbidden', 'only a human device does this'); return a }
  const member = a => { if (a.who === 'recovery') throw refuse('forbidden', 'the recovery key reads and joins, nothing else'); return a }
  /** A write to a room: not while it is being recovered (hub-api.md "Decided" 14). */
  function writer(rq) {
    const a = auth(rq)
    if (a.room.recovery && a.room.recovery.expires_at > now()) throw refuse('overloaded', 'the room is being recovered: try again in a moment', {}, 30)
    return a
  }
  function field(body, name) {
    const bytes = unb64(body[name])
    if (!bytes) throw refuse('bad-format', `${name}: base64url bytes`)
    return bytes
  }
  const optional = (body, name) => body[name] === null || body[name] === undefined ? null : field(body, name)
  function pathId(text, n) {
    const bytes = n === 16 && text.length === 32 && /^[0-9a-f]+$/.test(text) ? Buffer.from(text, 'hex') : unb64(text)
    if (!bytes || bytes.length !== n) throw refuse('bad-format', 'an id in the path is not what it must be')
    return b64(bytes)
  }
  function groupId(text) {
    const bytes = unb64(text)
    if (!bytes || (bytes.length !== 32 && bytes.length !== 48)) throw refuse('bad-format', 'a group id is 32 or 48 bytes, base64url')
    return text
  }
  function number(rq, name) {
    const v = rq.query.get(name)
    if (v === null) return null
    if (!/^\d{1,18}$/.test(v)) throw refuse('bad-format', `${name}: a number`)
    return Number(v)
  }
  const clamp = (v, fallback, max) => Math.min(max, Math.max(1, v ?? fallback))
  function group(r, id) {
    const g = r.groups.get(id)
    if (!g) throw refuse('not-found', 'no such group')
    return g
  }
  const sees = (a, g) => a.who === 'human' || a.who === 'recovery' || g.leaves.has(a.device)
  function read(reader, bytes, what) {
    try { return readers[reader](bytes) } catch { throw refuse('bad-format', `${what} does not parse`) }
  }

  // ---- the live stream

  /** A stream that was ended (its device was removed, its token ran out) gets nothing more, whatever is still open of it. */
  const open = s => !s.res.writableEnded && !s.res.destroyed
  function endStream(s) { streams.delete(s); if (open(s)) s.res.end() }
  function emit(r, name, change, data, group_id = null, except = null) {
    const text = (change === null ? '' : `id: ${change}\n`) + `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
    for (const s of streams) {
      if (s.room !== r || s.catching_up || s.device === except || !open(s)) continue
      if (s.who !== 'human' && !(group_id && r.groups.get(group_id)?.leaves.has(s.device))) continue
      s.res.write(text)
    }
  }
  /** Gives the next change number to an item of the room's one order and announces it. */
  function record(r, item, group_id) {
    item.change = ++r.change
    r.changes.push(item)
    emit(r, item.kind === 'envelope' ? 'envelope' : 'log', item.change, served(item), group_id)
    return item.change
  }
  function openStream(rq, res) {
    const a = auth(rq)
    const after = rq.query.get('after') ?? rq.headers['last-event-id'] ?? null
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no', ...cors(rq.headers) })
    res.write(': trommi hub\n\n')
    const s = { room: a.room, device: a.device, who: a.who, res, catching_up: true }
    streams.add(s)
    res.on('close', () => { streams.delete(s); clearTimeout(s.end) })
    if (after !== null && /^\d+$/.test(after)) {
      for (const item of a.room.changes) {
        if (item.change <= Number(after) || !visible(a, item)) continue
        res.write(`id: ${item.change}\nevent: ${item.kind === 'envelope' ? 'envelope' : 'log'}\ndata: ${JSON.stringify(served(item))}\n\n`)
      }
    }
    s.catching_up = false
    // a stream lives as long as the token it was opened with
    s.end = setTimeout(() => endStream(s), Math.max(0, a.expires_at - now()))
    s.end.unref()
  }
  function visible(a, item) {
    if (a.who === 'human' || a.who === 'recovery') return true
    const g = a.room.groups.get(item.kind === 'envelope' ? item.group : item.group_id)
    return Boolean(g?.leaves.has(a.device))
  }
  /** An item as catch-up and the stream serve it: the fake's own notes on an envelope (group, header) stay inside. */
  const served = item => item.kind === 'envelope' ? { kind: 'envelope', ...paged(item) } : item
  /** An envelope as the read routes serve it. */
  const paged = e => ({ change: e.change, received_at: e.received_at, envelope: e.envelope, ...(e.void_code ? { void_code: e.void_code } : {}) })

  // ---- groups

  function addGroup(r, info, bytes) {
    const g = {
      group_id: info.group, kind: info.session ? (info.session.parent ? 'helper' : 'main') : 'room', session_id: info.session?.session_id ?? null, parent: info.session?.parent ?? null,
      epoch: 0, room_epoch: r.groups.get(r.room_id)?.epoch ?? 0, live: true, leaves: new Set(info.leaves ?? []), log: [], infos: new Map([[0, bytes]]),
    }
    r.groups.set(g.group_id, g)
    return g
  }
  /** Applies an accepted Commit: the next epoch, the log entry, the members `readers.commit` names, the Welcomes. */
  function applyCommit(r, g, a, c) {
    const facts = readers.commit(c.commit)
    const entry = { group_id: g.group_id, n: g.log.length + 1, epoch: g.epoch, at: now(), kind: 'commit', bytes: b64(c.commit), sender: a.device }
    if (c.recovery_auth) entry.recovery_auth = b64(c.recovery_auth)
    g.epoch += 1
    g.infos.set(g.epoch, c.group_info)
    for (const d of facts.added ?? []) {
      g.leaves.add(d)
      if (g.kind === 'room') r.devices.set(d, 'human')
      else if (!r.devices.has(d)) r.devices.set(d, 'helper')
      if (c.welcome) { r.welcomes.push({ device: d, group_id: g.group_id, welcome: b64(c.welcome), at: now() }); emit(r, 'welcome', null, { group_id: g.group_id }, g.group_id) }
    }
    for (const d of facts.agents ?? []) r.devices.set(d, 'agent')
    for (const d of facts.removed ?? []) {
      g.leaves.delete(d)
      if (g.kind === 'room') { r.devices.delete(d); for (const s of [...streams]) if (s.room === r && s.device === d) endStream(s) }
      // what the key may still read, for thirty days: the group's Commits up to this one (hub-api.md 42)
      if (opts.serves_removal !== false) { r.removed ??= new Map(); if (!r.removed.has(d)) r.removed.set(d, new Map()); r.removed.get(d).set(g.group_id, entry.n) }
    }
    g.log.push(entry)
    joined(r, g, a.device)
    // the Commit takes its change number first, its SealedKey the next (hub delivery.rs commit_in)
    const change = record(r, entry, g.group_id)
    r.sealed_keys.push({ change: ++r.change, sealed_key: b64(c.sealed_key) })
    return { epoch: g.epoch, change }
  }
  function commitBody(body) {
    if (!Number.isSafeInteger(body.epoch) || body.epoch < 0) throw refuse('bad-format', 'epoch: the epoch the Commit builds on')
    return { epoch: body.epoch, commit: field(body, 'commit'), group_info: field(body, 'group_info'), welcome: optional(body, 'welcome'), sealed_key: field(body, 'sealed_key'), recovery_auth: optional(body, 'recovery_auth') }
  }
  function commit(r, g, a, c) {
    // what was accepted before gets its first answer, whatever the group has become since
    const before = g.log.find(e => e.kind === 'commit' && e.bytes === b64(c.commit))
    if (before) return { epoch: before.epoch + 1, change: before.change }
    if (!g.live) throw refuse('gone', 'the session is archived')
    if (c.epoch < g.epoch) throw refuse('epoch-taken', 'another Commit took this epoch', { epoch: g.epoch })
    if (c.epoch > g.epoch) throw refuse('bad-commit', 'a Commit of an epoch the group has not reached')
    return applyCommit(r, g, a, c)
  }
  /** A device that writes in a group has joined it: its Welcome is no longer kept. */
  function joined(r, g, device) { r.welcomes = r.welcomes.filter(w => !(w.device === device && w.group_id === g.group_id)) }

  // ---- envelopes

  function postEnvelope(a, bytes) {
    const h = read('envelope', bytes, 'the envelope'), r = a.room
    const g = r.groups.get(h.group)
    if (!g) throw refuse('wrong-room', 'no such group in this room')
    if (!g.live) throw refuse('gone', 'the session is archived')
    if (h.sender !== a.device) throw refuse('wrong-sender', 'the envelope names another sender')
    if (!g.leaves.has(a.device)) throw refuse('not-member', 'the sender is no leaf of this group')
    const key = `${h.group} ${h.sender}`, chain = r.chains.get(key) ?? [], text = b64(bytes)
    const held = chain[h.seq - 1]
    if (held) {
      if (held.envelope !== text) throw refuse('equivocation', 'another envelope under this number')
      if (held.void_code) throw refuse(held.void_code, 'refused before', { voided: true })
      return { change: held.change }
    }
    if (!Number.isSafeInteger(h.seq) || h.seq < 1) throw refuse('bad-format', 'seq')
    if (h.seq !== chain.length + 1) throw refuse('gap', 'the chain misses envelopes before this one', { seq: chain.length })
    const item = { kind: 'envelope', envelope: text, received_at: now(), group: h.group, header: h }
    const void_code = a.rule?.void ?? null
    if (void_code) item.void_code = void_code
    chain.push(item)
    r.chains.set(key, chain)
    r.envelopes.push(item)
    const change = record(r, item, h.group)
    joined(r, g, a.device)
    for (const f of h.file_ids ?? []) { const file = r.files.get(f); if (file && !file.group) Object.assign(file, { group: h.group, object: h.object?.object_id ?? null }) }
    if (void_code) throw refuse(void_code, 'refused, and kept as a void record', { voided: true })
    return { change }
  }
  const timelineOf = h => h.timeline ? `${h.timeline.kind}/${h.timeline.scope}/${h.timeline.ref}` : null
  function page(items, limit) { return { items: items.slice(0, limit).map(paged), more: items.length > limit } }
  function objectsOf(r, a) {
    const objects = new Map()
    for (const e of r.envelopes) {
      const o = e.header.object
      if (!o || e.void_code || !sees(a, r.groups.get(e.group))) continue
      const held = objects.get(o.object_id) ?? { object_id: o.object_id, type: o.object_type, group_id: e.group, owner: e.header.sender, first_change: e.change, version: null, items: [] }
      Object.assign(held, { state: STATES[o.object_state] ?? 1, urgency: URGENCIES[o.urgency] ?? 1, answered_at: o.answered_at ?? 0, head_change: e.change })
      if (e.header.kind === 'version' || e.header.kind === 'request') held.version = e
      held.items.push(e)
      objects.set(o.object_id, held)
    }
    return objects
  }
  function groupList(a) {
    return [...a.room.groups.values()].filter(g => sees(a, g) || g.kind === 'room').map(g => ({
      group_id: g.group_id, kind: g.kind, session_id: g.session_id, parent: g.parent, epoch: g.epoch, room_epoch: g.room_epoch, live: g.live, stale: false, leaves: [...g.leaves],
    }))
  }
  function desk(a) {
    const out = { cards: [], notes: [], permission_requests: [], artifacts: [] }
    const objects = [...objectsOf(a.room, a).values()].filter(o => o.state === 1).sort((x, y) => y.urgency - x.urgency || x.first_change - y.first_change)
    for (const o of objects) {
      out[OBJECT_TABLES[o.type] ?? 'cards'].push({
        object_id: o.object_id, group_id: o.group_id, state: o.state, urgency: o.urgency, answered_at: o.answered_at, owner: o.owner,
        first_change: o.first_change, head_change: o.head_change, version: o.version ? paged(o.version) : null,
      })
    }
    const registers = new Map()
    for (const e of a.room.envelopes) if (e.header.register_id && !e.void_code && sees(a, a.room.groups.get(e.group))) registers.set(`${e.group} ${e.header.sender} ${e.header.register_id}`, e)
    return { ...out, registers: [...registers.values()].sort((x, y) => x.change - y.change).map(paged), truncated: false, groups: groupList(a), change: a.room.change }
  }
  function changes(a, after, limit) {
    const head = a.room.change, upto = Math.min(after + CHANGES_WINDOW, head)
    const found = a.room.changes.filter(i => i.change > after && i.change <= upto && visible(a, i))
    const items = found.slice(0, limit)
    const cursor = found.length > limit ? items[items.length - 1].change : upto
    return { items: items.map(served), change: Math.max(cursor, after), more: cursor < head }
  }

  // ---- the account (no slow hash: a login key is compared as it is)

  function sealedCopy(v, name) {
    const copy = unb64(v?.[name])
    if (!copy || copy.length !== 61 || copy[0] !== 2) throw refuse('bad-format', `${name}: 61 bytes, base64url`)
    return v[name]
  }
  function authKey(v) {
    if (unb64(v?.auth_key)?.length !== 32) throw refuse('bad-format', 'auth_key: 32 bytes, base64url')
    return v.auth_key
  }
  function kdfRecord(v) {
    const k = v?.kdf
    if (!(k?.alg === 'argon2id' && k.v === 1 && k.m === 65536 && k.t === 3 && k.p === 1)) throw refuse('bad-format', 'the key derivation record is pinned to argon2id v1, m 65536, t 3, p 1')
    return { alg: 'argon2id', v: 1, m: 65536, t: 3, p: 1 }
  }
  // The account id: a UUID. Its text is `account`, its 16 bytes are `user_handle` (hub accounts.rs).
  const asUuid = id => { id[6] = (id[6] & 0x0f) | 0x40; id[8] = (id[8] & 0x3f) | 0x80; return id }
  const idText = id => { const h = Buffer.from(id).toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` }
  /** The id that goes with a passkey challenge: an account made with a passkey registered on it gets it. */
  const idOfChallenge = challenge => asUuid(sha256(Buffer.concat([Buffer.from('trommi account id\0'), challenge])).subarray(0, 16))
  /** An id as typed: case, white space and dashes are ignored; what is left is 32 hex digits. */
  const parseId = text => { const d = String(text).replace(/[\s-]/gu, ''); return /^[0-9a-fA-F]{32}$/.test(d) ? Buffer.from(d, 'hex') : null }
  const normalEmail = text => { const e = typeof text === 'string' ? text.trim().toLowerCase() : ''; return /^[\x21-\x7e]+@[\x21-\x7e]+\.[\x21-\x7e]{2,}$/.test(e) && e.split('@').length === 2 ? e : null }
  /** The one field `account` (read as `email` too): an e-mail if it contains `@`, else the account's id. */
  function named(body) {
    const text = typeof body.account === 'string' ? body.account : typeof body.email === 'string' ? body.email : ''
    if (text.includes('@')) { const email = normalEmail(text); return email ? [...state.accounts.values()].find(a => a.email === email) : undefined }
    const id = parseId(text)
    return id ? state.accounts.get(idText(id)) : undefined
  }
  /** The kit's form follows from the account alone (v1.md 8.8.2): its e-mail where it has one, else its id. */
  const kitForm = (_kit, has_email) => (has_email ? 'email' : 'id')
  const needsEmail = account => { if (account.email === null) throw refuse('bad-email', 'a password signs in under an e-mail: this account has none') }
  function passkeyChallenge(scope) {
    const challenge = randomBytes(32), c = b64(challenge)
    session.passkey_challenges.set(c, scope)
    const id = scope ? Buffer.from(scope.user_handle, 'base64url') : idOfChallenge(challenge)
    return { challenge: c, account: idText(id), user_handle: b64(id) }
  }
  /** The credential id in an attestation object's authenticator data (WebAuthn 6.1: rpIdHash 32, flags 1, counter 4,
   *  then, with the flag 0x40, aaguid 16, length 2, the id), or null. The CBOR around it is not read: the data is
   *  the byte string after the text "authData". */
  function attestedCredentialId(attestation) {
    const at = attestation.indexOf('authData')
    if (at < 0) return null
    const head = at + 8, kind = attestation[head]
    const start = kind === 0x58 ? head + 2 : kind === 0x59 ? head + 3 : -1
    if (start < 0 || attestation.length < start + 55 || !(attestation[start + 32] & 0x40)) return null
    const length = attestation.readUInt16BE(start + 53)
    return length >= 1 && length <= 1023 && attestation.length >= start + 55 + length ? attestation.subarray(start + 55, start + 55 + length) : null
  }
  /** A registration on a challenge of `scope`: null for a sign-up, else the account it was handed out for, as it was then. */
  function passkey(v, scope = null) {
    const attestation = unb64(v?.attestation_object), client = unb64(v?.client_data_json)
    if (!attestation?.length || !client?.length) throw refuse('bad-format', 'attestation_object: base64url')
    const held = takePasskeyChallenge(client, 'bad-passkey')
    if ((held?.account ?? null) !== (scope?.account ?? null) || (held && held.revision !== scope.revision)) throw refuse('bad-passkey', 'challenge')
    // the credential id is read out of the attestation as the real hub reads it, where it is one (a browser's);
    // bytes that are no attestation (a unit test's) are named by their hash. Nothing of it is verified.
    return { credential_id: b64(attestedCredentialId(attestation) ?? sha256(attestation).subarray(0, 16)), sealed_copy: sealedCopy(v, 'sealed_copy'), transports: v.transports ?? [], created_at: now(), last_used_at: null, algorithm: -7, sign_count: 0 }
  }
  /** Uses a challenge up; returns the scope it was handed out for (null: no account's). */
  function takePasskeyChallenge(client_data, code) {
    let challenge = null
    try { challenge = json(client_data).challenge } catch { /* refused below */ }
    if (!session.passkey_challenges.has(challenge)) throw refuse(code, 'challenge')
    const scope = session.passkey_challenges.get(challenge)
    session.passkey_challenges.delete(challenge)
    return scope
  }
  const scopeOf = account => ({ account: account.account, revision: account.revision, user_handle: account.user_handle })
  function createAccount(r, v) {
    const email = v.email == null ? null : normalEmail(v.email)
    if (v.email != null && !email) throw refuse('bad-email', 'not an e-mail address this hub takes')
    // with a passkey the id is the one the hub named with the registration's challenge; else it is minted now
    let id = asUuid(randomBytes(16))
    if (v.passkey) { try { id = idOfChallenge(Buffer.from(json(unb64(v.passkey.client_data_json)).challenge, 'base64url')) } catch { throw refuse('bad-passkey', 'client-data') } }
    const account = {
      email, account: idText(id), user_handle: b64(id), created_at: now(), updated_at: now(), revision: 1, kit_auth: authKey(v.kit), kit_copy: sealedCopy(v.kit, 'sealed_copy'),
      kit_form: null, auth: null, password_copy: null, kdf: null, passkeys: [], rooms: [r.room_id],
    }
    if (v.password) Object.assign(account, { auth: authKey(v.password), password_copy: sealedCopy(v.password, 'sealed_copy'), kdf: kdfRecord(v.password) })
    if (v.passkey) account.passkeys.push(passkey(v.passkey))
    account.kit_form = kitForm(v.kit, email !== null)
    if (!account.auth && !account.passkeys.length) throw refuse('bad-format', 'an account needs a way in: a password or a passkey')
    if (accountOf(r, false)) throw refuse('account-exists', 'this room has an account')
    if (account.auth && email === null) throw refuse('bad-email', 'a password signs in under an e-mail')
    if ((email !== null && [...state.accounts.values()].some(a => a.email === email)) || state.accounts.has(account.account)) throw refuse('account-exists', 'an account with this e-mail or id exists')
    state.accounts.set(account.account, account)
    return accountView(account)
  }
  function accountOf(r, must = true) {
    const account = [...state.accounts.values()].find(a => a.rooms.includes(r.room_id))
    if (!account && must) throw refuse('not-found', 'this room has no account')
    return account
  }
  function accountView(a) {
    return {
      email: a.email, account: a.account, kit_form: a.kit_form, created_at: a.created_at, updated_at: a.updated_at, revision: a.revision, has_password: a.auth !== null, kdf: a.kdf, password_copy: a.password_copy,
      kit_copy: a.kit_copy, user_handle: a.user_handle, passkeys: a.passkeys.map(p => ({ ...p })), rooms: [...a.rooms],
    }
  }
  function loginAnswer(account, copy) {
    return { rooms: account.rooms.map(room_id => ({ room_id, sealed_copy: copy, challenge: challenge(room_id) })), kdf: account.kdf, account: account.account, email: account.email }
  }
  function revised(account, v) {
    if (v.revision !== account.revision) throw refuse('account-changed', 'the account changed meanwhile: read it again')
    account.revision += 1
    return { revision: account.revision }
  }
  function replaceCopies(r, v) {
    const account = accountOf(r, false)
    if (!account) { if (v === null || v === undefined) return; throw refuse('not-found', 'this room has no account') }
    if (v === null || v === undefined) throw refuse('incomplete', 'new recovery keys come with the account\'s new sealed copies')
    try { Object.assign(account, { kit_auth: authKey(v.kit), kit_copy: sealedCopy(v.kit, 'sealed_copy'), kit_form: kitForm(v.kit, account.email !== null) }) } catch { throw refuse('incomplete', 'the account\'s new Emergency Kit copy') }
    // one way in, every other removed: the one used just now with a new copy, or one set anew (hub accounts.rs replace_copies)
    if (v.password?.auth_key != null && !v.passkey) needsEmail(account)
    if (v.password?.auth_key != null && !v.passkey) Object.assign(account, { auth: authKey(v.password), password_copy: sealedCopy(v.password, 'sealed_copy'), kdf: kdfRecord(v.password), passkeys: [] })
    else if (v.password && !v.passkey) {
      if (!account.auth) throw refuse('incomplete', 'the account has no password')
      Object.assign(account, { password_copy: sealedCopy(v.password, 'sealed_copy'), passkeys: [] })
    } else if (v.passkey?.attestation_object != null && !v.password) Object.assign(account, { passkeys: [passkey(v.passkey, scopeOf(account))], auth: null, password_copy: null, kdf: null })
    else if (v.passkey && !v.password) {
      const kept = account.passkeys.find(p => p.credential_id === v.passkey.credential_id)
      if (!kept) throw refuse('incomplete', 'the account has no such passkey')
      kept.sealed_copy = sealedCopy(v.passkey, 'sealed_copy')
      Object.assign(account, { passkeys: [kept], auth: null, password_copy: null, kdf: null })
    } else throw refuse('incomplete', 'one sealed copy under one way in: the password or passkey used just now, or one set anew')
    account.revision += 1
  }

  // ---- sign-in

  function challenge(room_id) {
    const c = b64(randomBytes(32))
    session.challenges.set(c, { room: room_id, expires_at: now() + 120_000 })
    return c
  }
  function signIn(room_id, body) {
    const auth_bytes = field(body, 'auth')
    field(body, 'signature')
    const a = read('hubAuth', auth_bytes, 'HubAuth')
    const known = session.challenges.get(a.challenge)
    session.challenges.delete(a.challenge)
    if (!known || known.room !== room_id || known.expires_at <= now()) throw refuse('bad-challenge', 'the challenge is unknown, used or ran out')
    if (a.room_id !== room_id) throw refuse('wrong-room', 'signed for another room')
    if (a.hub !== url) throw refuse('bad-format', 'signed for another hub address')
    const r = room(room_id), who = r && (standing(r, a.device) ?? (r.removed?.has(a.device) ? 'removed' : null))
    if (!who) throw refuse('not-member', 'this key has no standing in the room')
    const token = b64(randomBytes(32)), expires_at = now() + (opts.token_ms ?? 600_000)
    session.tokens.set(token, { room: room_id, device: a.device, expires_at })
    return { token, expires_at, role: who }
  }

  // ---- files

  function range(header, size) {
    if (header === undefined) return null
    const m = /^bytes=(\d*)-(\d*)$/.exec(header)
    if (!m || (m[1] === '' && m[2] === '')) return false
    let start, end
    if (m[1] === '') { const n = Number(m[2]); if (n === 0) return false; start = Math.max(0, size - n); end = size - 1 }
    else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1) }
    return size === 0 || start >= size || start > end ? false : [start, end]
  }
  function fileAnswer(bytes, header) {
    const r = range(header, bytes.length)
    if (r === false) return { status: 416, headers: { 'content-range': `bytes */${bytes.length}` }, json: { error: 'range', message: 'the range cannot be served' } }
    const [start, end] = r ?? [0, bytes.length - 1]
    const headers = { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes' }
    if (r) headers['content-range'] = `bytes ${start}-${end}/${bytes.length}`
    return { status: r ? 206 : 200, headers, bytes: bytes.subarray(start, end + 1) }
  }
  function readableFile(a, file_id) {
    const file = member(a).room.files.get(file_id)
    const allowed = file && !file.deleted && (a.who === 'human' || (file.group ? a.room.groups.get(file.group)?.leaves.has(a.device) : file.uploader === a.device))
    if (!allowed) throw refuse('not-found', 'no such file')
    return file
  }

  // ---- the routes

  function route(rq) {
    const { method, segs, body } = rq
    const is = (m, ...pattern) => method === m && segs.length === pattern.length && pattern.every((p, i) => p === null || p === segs[i])
    const next = () => state.next_id++

    // no token
    if (is('POST', 'account', 'login') || is('POST', 'account', 'recover')) {
      // an id nobody has, an address nobody has and a text that is neither are answered like a wrong key
      const kit = segs[1] === 'recover', key = authKey(body), account = named(body)
      if (!account || key !== (kit ? account.kit_auth : account.auth)) throw refuse(kit ? 'wrong-recovery' : 'wrong-login', 'e-mail or secret is wrong')
      return loginAnswer(account, kit ? account.kit_copy : account.password_copy)
    }
    if (is('POST', 'account', 'passkey', 'challenge')) return passkeyChallenge(null)
    if (is('POST', 'account', 'passkey', 'login')) {
      // every failure of this route is the one answer, a malformed request too (hub-api.md "Decided" 36)
      if (['credential_id', 'authenticator_data', 'client_data_json', 'signature'].some(name => !unb64(body[name])?.length)) throw refuse('wrong-login', 'e-mail or secret is wrong')
      const account = [...state.accounts.values()].find(a => a.passkeys.some(p => p.credential_id === body.credential_id))
      let fresh = true
      try { fresh = takePasskeyChallenge(field(body, 'client_data_json'), 'wrong-login') === null } catch { fresh = false }
      if (!account || !fresh || (body.user_handle && body.user_handle !== account.user_handle)) throw refuse('wrong-login', 'e-mail or secret is wrong')
      const used = account.passkeys.find(p => p.credential_id === body.credential_id)
      used.last_used_at = now()
      return loginAnswer(account, used.sealed_copy)
    }
    if (is('POST', 'rooms')) {
      if (opts.found_token && rq.headers['x-found-token'] !== opts.found_token) throw refuse('forbidden', 'this hub founds rooms by invitation')
      const [group_info, sealed_key] = [field(body, 'group_info'), field(body, 'sealed_key')]
      const info = read('groupInfo', group_info, 'the GroupInfo')
      const held = room(info.group)
      if (held) {
        // a repeated founding is known by its GroupInfo (hub delivery.rs found_room)
        if (held.founding !== b64(group_info)) throw refuse('room-exists', 'this room exists')
        return { room_id: held.room_id }
      }
      const r = newRoom(info.group)
      r.founding = b64(group_info)
      for (const d of info.leaves ?? []) r.devices.set(d, 'human')
      if (info.recovery_signature_key) r.recovery_keys.add(info.recovery_signature_key)
      addGroup(r, { ...info, session: null }, group_info)
      r.sealed_keys.push({ change: ++r.change, sealed_key: b64(sealed_key) })
      state.rooms.set(r.room_id, r)
      if (body.account) { try { createAccount(r, body.account) } catch (e) { state.rooms.delete(r.room_id); throw e } }
      return { room_id: r.room_id }
    }
    if (is('GET', 'rooms', null, 'challenge')) return { challenge: challenge(pathId(segs[1], 32)) }
    if (is('POST', 'rooms', null, 'tokens')) return signIn(pathId(segs[1], 32), body)
    if (is('GET', 'invites', null)) {
      const invite = openInvite(pathId(segs[1], 16))
      let asker = null
      try { asker = auth(rq) } catch { /* by invite id only */ }
      const out = { offer: invite.offer, signature: invite.signature, ...(invite.mac ? { mac: invite.mac } : {}), expires_at: invite.expires_at }
      if (asker?.who === 'human' && asker.room.room_id === invite.room) out.requests = invite.requests.map(({ request, mac, signature }) => ({ request, mac, signature }))
      return out
    }
    if (is('POST', 'invites', null, 'request')) {
      const invite = openInvite(pathId(segs[1], 16))
      const [request, mac, signature] = [field(body, 'request'), field(body, 'mac'), field(body, 'signature')]
      if (invite.reveal) throw refuse('invite-used', 'the inviter accepted a Request')
      // (how a Request is named in its Reveal: the real hash where a reader gives it, `readers.requestHash`)
      const request_hash = readers.requestHash ? readers.requestHash(request, mac) : b64(sha256(Buffer.concat([request, mac])))
      if (!invite.requests.some(q => q.request_hash === request_hash)) {
        if (invite.requests.length >= 4) throw refuse('too-many', 'an invite takes four Requests')
        invite.requests.push({ request_hash, request: b64(request), mac: b64(mac), signature: b64(signature) })
        emit(room(invite.room), 'request', null, { kind: 'invite', invite_id: invite.invite_id })
      }
      return { request_hash }
    }
    if (is('GET', 'invites', null, 'reveal')) {
      const invite = state.invites.get(pathId(segs[1], 16))
      if (!invite) throw refuse('not-found', 'no such invite')
      if (invite.burned) throw refuse('invite-burned', 'this invite was burned')
      if (!invite.reveal) throw refuse('not-found', 'not revealed yet')
      return { reveal: invite.reveal, signature: invite.reveal_signature }
    }

    // signing out: that token ends at once, and the device's streams are cut
    if (is('DELETE', 'token')) {
      const a = auth(rq)
      session.tokens.delete(/^Bearer (.+)$/.exec(rq.headers.authorization)[1])
      for (const s of streams) if (s.room === a.room && s.device === a.device) s.res.end()
      return {}
    }
    // the account, by a human device of the room
    if (is('POST', 'account')) return createAccount(human(writer(rq)).room, body)
    if (is('GET', 'account')) return accountView(accountOf(human(auth(rq)).room))
    if (is('PUT', 'account', 'password')) {
      const account = accountOf(human(writer(rq)).room)
      if (body.revision === account.revision) needsEmail(account)
      const answer = revised(account, body)
      Object.assign(account, { auth: authKey(body), password_copy: sealedCopy(body, 'sealed_copy'), kdf: kdfRecord(body) })
      return answer
    }
    if (is('PUT', 'account', 'kit')) {
      const account = accountOf(human(writer(rq)).room)
      const form = body.revision === account.revision ? kitForm(body, account.email !== null) : account.kit_form
      const answer = revised(account, body)
      Object.assign(account, { kit_auth: authKey(body), kit_copy: sealedCopy(body, 'sealed_copy'), kit_form: form })
      return answer
    }
    if (is('PUT', 'account', 'email')) {
      const account = accountOf(human(writer(rq)).room)
      if (body.revision !== account.revision) throw refuse('account-changed', 'the account changed meanwhile: read it again')
      const email = normalEmail(body.email)
      if (!email) throw refuse('bad-email', 'not an e-mail address this hub takes')
      if (account.email !== null) throw refuse('forbidden', 'the e-mail of an account is set once')
      if ([...state.accounts.values()].some(a => a.email === email)) throw refuse('account-exists', 'an account with this e-mail exists')
      // with an e-mail the kit's keys are under the e-mail's salt: the kit comes anew in this request
      let kit
      try { kit = { kit_auth: authKey(body.kit), kit_copy: sealedCopy(body.kit, 'sealed_copy'), kit_form: 'email' } } catch { throw refuse('incomplete', 'an e-mail comes with the kit made anew under it') }
      Object.assign(account, { email }, kit)
      account.revision += 1
      return { revision: account.revision }
    }
    if (is('POST', 'account', 'passkeys', 'challenge')) {
      // a human device, or the recovery key before it finishes; with the challenge the account's id
      const a = auth(rq)
      if (a.who !== 'human' && a.who !== 'recovery') throw refuse('forbidden', 'a human device or the recovery key')
      const account = accountOf(a.room)
      return { ...passkeyChallenge(scopeOf(account)), email: account.email, kit_form: account.kit_form }
    }
    if (is('POST', 'account', 'passkeys')) {
      const account = accountOf(human(writer(rq)).room), added = passkey(body, scopeOf(account))
      account.passkeys.push(added)
      account.revision += 1
      return { credential_id: added.credential_id, created_at: added.created_at }
    }
    if (is('DELETE', 'account', 'passkeys', null)) {
      const account = accountOf(human(writer(rq)).room)
      if (!unb64(segs[2])) throw refuse('bad-format', 'a credential id, base64url')
      if (!account.passkeys.some(p => p.credential_id === segs[2])) throw refuse('not-found', 'no such passkey')
      if (!account.auth && account.passkeys.length <= 1) throw refuse('last-way-in', 'this is the last way into the account')
      account.passkeys = account.passkeys.filter(p => p.credential_id !== segs[2])
      account.revision += 1
      return { deleted: true }
    }

    // groups
    if (is('POST', 'groups')) {
      const a = writer(rq), [group_info_0, sealed_key_0] = [field(body, 'group_info_0'), field(body, 'sealed_key_0')]
      const first = commitBody({ ...body, epoch: 0 }), info = read('groupInfo', group_info_0, 'the GroupInfo')
      const held = a.room.groups.get(info.group)
      if (held) {
        if (held.log[0]?.bytes !== b64(first.commit)) throw refuse('replay', 'this session exists')
        return { group_id: held.group_id }
      }
      if (!info.session || !unb64(info.group) || unb64(info.group).length !== 48) throw refuse('bad-commit', 'a session group carries its session')
      const g = addGroup(a.room, info, group_info_0)
      a.room.sealed_keys.push({ change: ++a.room.change, sealed_key: b64(sealed_key_0) })
      applyCommit(a.room, g, a, first)
      return { group_id: g.group_id }
    }
    if (is('POST', 'groups', null, 'commits')) { const a = writer(rq); return commit(a.room, group(a.room, groupId(segs[1])), a, commitBody(body)) }
    if (is('POST', 'groups', null, 'reject')) {
      const a = writer(rq), g = group(a.room, groupId(segs[1]))
      const entry = g.log.find(e => e.n === body.n && e.kind === 'commit')
      if (!Number.isSafeInteger(body.n)) throw refuse('bad-format', 'n: the log number of the Commit')
      if (!entry) throw refuse('not-found', 'no such Commit')
      return addRequest(a, 'reject', g.group_id, null, body.n, entry.sender)
    }
    if (is('POST', 'groups', null, 'archive')) {
      const a = human(writer(rq)), g = group(a.room, groupId(segs[1]))
      if (g.kind === 'room') throw refuse('forbidden', 'the room group is not archived')
      if (g.live) { g.live = false; emit(a.room, 'presence', null, { group_id: g.group_id, archived: true }, g.group_id) }
      return { archived: true }
    }
    if (is('GET', 'groups', null, 'log')) {
      const a = auth(rq), g = group(a.room, groupId(segs[1]))
      const [after, limit] = [number(rq, 'after') ?? 0, clamp(number(rq, 'limit'), 200, 1000)]
      const found = g.log.filter(e => e.n > after && (rq.query.get('kind') !== 'commit' || e.kind === 'commit'))
      return { items: found.slice(0, limit), more: found.length > limit }
    }
    // a removed key's one read (hub-api.md 42): the group's Commits up to and including the one that removed it
    if (is('GET', 'groups', null, 'removal')) {
      const token = /^Bearer ([A-Za-z0-9_-]{16,200})$/.exec(rq.headers.authorization ?? '')?.[1]
      const held = token && session.tokens.get(token)
      if (!held || held.expires_at <= now()) throw refuse('unauthorised', 'sign in')
      const r = room(held.room), g = group(r, groupId(segs[1]))
      const removed_at = standing(r, held.device) ? undefined : r.removed?.get(held.device)?.get(g.group_id)
      if (!removed_at) throw refuse('not-found', 'nothing to show this key')
      rq.log.device = held.device
      const after = number(rq, 'after') ?? 0
      const found = g.log.filter(e => e.kind === 'commit' && e.n > after && e.n <= removed_at)
      return { items: found.slice(0, 200), more: found.length > 200, removed_at }
    }
    if (is('POST', 'groups', null, 'messages')) {
      const a = writer(rq), g = group(a.room, groupId(segs[1])), message = field(body, 'message')
      if (!Number.isSafeInteger(body.epoch)) throw refuse('bad-format', 'epoch')
      if (!g.leaves.has(a.device)) throw refuse('not-member', 'only a leaf of the group sends in it')
      const before = body.relay === true ? null : g.log.find(e => e.kind === 'message' && e.bytes === b64(message) && e.sender === a.device)
      if (before) return { n: before.n }
      if (!g.live) throw refuse('gone', 'the session is archived')
      if (body.epoch !== g.epoch) throw refuse('wrong-epoch', 'the group is at another epoch', { epoch: g.epoch })
      if (body.relay === true) {
        if (g.kind !== 'room') throw refuse('forbidden', 'only the room group relays')
        // passed on every time it is posted, to everyone but its sender (hub delivery.rs message)
        emit(a.room, 'relay', null, { group_id: g.group_id, epoch: body.epoch, sender: a.device, message: b64(message) }, g.group_id, a.device)
        return { n: null }
      }
      const entry = { group_id: g.group_id, n: g.log.length + 1, epoch: g.epoch, at: now(), kind: 'message', bytes: b64(message), sender: a.device }
      g.log.push(entry)
      joined(a.room, g, a.device)
      record(a.room, entry, g.group_id)
      return { n: entry.n }
    }
    if (is('GET', 'groups', null, 'info')) {
      const a = auth(rq), g = group(a.room, groupId(segs[1])), epoch = number(rq, 'epoch') ?? g.epoch
      if (!g.infos.has(epoch)) throw refuse('not-found', 'the group has not reached this epoch')
      return { epoch, group_info: b64(g.infos.get(epoch)) }
    }
    if (is('GET', 'groups', null, 'chains', null)) {
      const a = auth(rq), g = group(a.room, groupId(segs[1])), sender = pathId(segs[3], 32)
      const [after, limit] = [number(rq, 'after') ?? 0, clamp(number(rq, 'limit'), 500, 2000)]
      const found = (a.room.chains.get(`${g.group_id} ${sender}`) ?? []).filter((_, i) => i + 1 > after)
      return { items: found.slice(0, limit).map(e => ({ ...paged(e), seq: e.header.seq })), more: found.length > limit }
    }
    if (is('GET', 'rooms', null, 'groups')) {
      const a = ownRoom(auth(rq), segs[1]), all = groupList(a)
      // paged as the hub pages it (point 43): in the order of founding, `after` the answer's own cursor; bare without `limit`
      const limit = number(rq, 'limit')
      if (limit === null || limit === undefined || opts.bare_lists) return all
      const after = number(rq, 'after') ?? 0, size = opts.groups_page ?? clamp(limit, 1000, 1000)
      const items = all.slice(after, after + size)
      return { items, more: after + size < all.length, after: after + items.length }
    }
    if (is('GET', 'welcomes')) {
      // numbered, oldest first, after the one numbered `after`; `welcomes_page` (default all) per answer, as the 8 MiB do
      const a = auth(rq), after = number(rq, 'after') ?? 0
      const mine = a.room.welcomes.filter(w => w.device === a.device && (w.id ??= (state.welcome_ids = (state.welcome_ids ?? 0) + 1)) > after).sort((x, y) => x.id - y.id)
      if (opts.bare_lists) return a.room.welcomes.filter(w => w.device === a.device).map(({ group_id, welcome, at }) => ({ group_id, welcome, at }))
      return mine.slice(0, opts.welcomes_page ?? mine.length).map(({ id, group_id, welcome, at }) => ({ id, group_id, welcome, at }))
    }
    if (is('PUT', 'key-packages')) {
      const a = member(writer(rq)), single = body.single_use ?? []
      if (!Array.isArray(single) || single.length > 100 || single.some(k => !unb64(k))) throw refuse('bad-format', 'single_use: at most 100 KeyPackages')
      const last = optional(body, 'last_resort')
      const held = a.room.key_packages.get(a.device) ?? { single: [], handed: new Set(), last: null }
      for (const k of single) if (!held.single.includes(k) && !held.handed.has(k)) held.single.push(k)
      if (last) held.last = b64(last)
      a.room.key_packages.set(a.device, held)
      if (held.single.length > 100) throw refuse('too-many', 'a device keeps at most 100 single-use KeyPackages')
      return { unused: held.single.length }
    }
    if (is('POST', 'key-packages', 'claim')) {
      const a = writer(rq), devices = body.devices
      if (!Array.isArray(devices) || devices.length < 1 || devices.length > 64) throw refuse('bad-format', 'devices: 1 to 64 device ids')
      if (a.who !== 'human' && a.who !== 'agent') throw refuse('forbidden', 'only a human or agent device claims KeyPackages')
      if (new Set(devices).size !== devices.length) throw refuse('bad-format', 'a device is named once')
      const missing = devices.find(d => { const k = a.room.key_packages.get(pathId(String(d), 32)); return !k || (!k.single.length && !k.last) })
      if (missing) throw refuse('not-found', 'no KeyPackage for a device', { device: missing })
      const key_packages = {}
      for (const d of devices) {
        const held = a.room.key_packages.get(d), taken = held.single.shift()
        if (taken) held.handed.add(taken)
        key_packages[d] = taken ?? held.last
      }
      return { key_packages }
    }
    if (is('PUT', 'sealed-keys')) {
      const a = human(writer(rq)), key = b64(field(body, 'sealed_key'))
      if (!a.room.sealed_keys.some(k => k.sealed_key === key)) a.room.sealed_keys.push({ change: ++a.room.change, sealed_key: key })
      return { stored: true }
    }
    if (is('GET', 'sealed-keys')) {
      const a = auth(rq), [after, limit] = [number(rq, 'after') ?? 0, clamp(number(rq, 'limit'), 500, 2000)]
      if (a.who !== 'human' && a.who !== 'recovery') throw refuse('forbidden', 'sealed keys are read by human devices and the recovery key')
      // two lists under one cursor: the answer goes as far as both are complete (hub delivery.rs sealed_keys)
      const [rows, links] = [a.room.sealed_keys.filter(k => k.change > after), a.room.links.filter(l => l.change > after)]
      const cut = [rows, links].filter(l => l.length > limit).map(l => l[limit - 1].change), more = cut.length > 0
      const change = more ? Math.min(...cut) : Math.max(after, rows.at(-1)?.change ?? 0, links.at(-1)?.change ?? 0)
      return { rows: rows.filter(k => k.change <= change), links: links.filter(l => l.change <= change), change, more }
    }
    if (is('POST', 'requests')) {
      const a = member(writer(rq))
      if (!['readmit', 'handover', 'session'].includes(body.kind)) throw refuse('bad-format', 'kind: readmit, handover or session')
      const g = typeof body.group === 'string' ? group(a.room, groupId(body.group)).group_id : null
      return addRequest(a, body.kind, g, optional(body, 'key_package'), null, null)
    }
    if (is('GET', 'requests')) { const a = member(auth(rq)); return a.room.requests.filter(q => a.who === 'human' || q.device === a.device) }

    // recovery
    if (is('POST', 'rooms', null, 'recovery')) {
      const a = ownRoom(auth(rq), segs[1])
      if (a.who !== 'recovery') throw refuse('forbidden', 'a recovery is run with the recovery key')
      if (a.room.recovery && a.room.recovery.expires_at > now()) throw refuse('too-many', 'a recovery of this room is running')
      a.room.recovery = { recovery_id: b64(randomBytes(16)), expires_at: now() + 600_000, key: a.device, parts: [] }
      return { recovery_id: a.room.recovery.recovery_id, expires_at: a.room.recovery.expires_at }
    }
    if (is('POST', 'rooms', null, 'recovery', null, 'commits')) {
      const a = ownRoom(auth(rq), segs[1]), rec = recoveryOf(a, pathId(segs[3], 16))
      if (typeof body.group_id !== 'string') throw refuse('bad-format', 'group_id: the group this part is for')
      const g = group(a.room, groupId(body.group_id)), c = commitBody(body)
      if (!rec.parts.some(p => p.group_id === g.group_id && p.c.commit.equals(c.commit))) rec.parts.push({ group_id: g.group_id, c })
      return { epoch: c.epoch + 1, kept: true }
    }
    if (is('POST', 'rooms', null, 'recovery', null, 'finish')) {
      const a = ownRoom(auth(rq), segs[1]), recovery_id = pathId(segs[3], 16)
      const done = a.room.finished.get(recovery_id)
      if (done) return done
      const rec = recoveryOf(a, recovery_id), link = field(body, 'recovery_link')
      const first_change = a.room.change + 1
      let device = a.device
      for (const p of rec.parts) { device = readers.commit(p.c.commit).added?.[0] ?? device; applyCommit(a.room, a.room.groups.get(p.group_id), { ...a, device }, p.c) }
      a.room.links.push({ room_epoch: a.room.groups.get(a.room.room_id).epoch, change: ++a.room.change, recovery_link: b64(link) })
      replaceCopies(a.room, body.account)
      a.room.recovery = null
      const answer = { published: true, first_change, change: a.room.change, device }
      a.room.finished.set(recovery_id, answer)
      return answer
    }
    if (is('DELETE', 'rooms', null, 'recovery', null)) {
      const a = ownRoom(auth(rq), segs[1]), dropped = a.room.recovery?.recovery_id === pathId(segs[3], 16)
      if (dropped) a.room.recovery = null
      return { dropped }
    }
    if (is('POST', 'rooms', null, 'recovery-code')) {
      // the Commit's fields come under `commit` (hub-api.md); beside the other members they are not read
      if (typeof body.commit !== 'object' || body.commit === null) throw refuse('bad-format', 'commit: the room Commit with its GroupInfo and SealedKey')
      const a = human(ownRoom(writer(rq), segs[1])), c = commitBody(body.commit), link = b64(field(body, 'recovery_link'))
      const g = a.room.groups.get(a.room.room_id), again = g.log.some(e => e.kind === 'commit' && e.bytes === b64(c.commit))
      if (again) return commit(a.room, g, a, c)
      // all or nothing (8.6): a Commit that would be refused for its epoch leaves the account as it was
      if (c.epoch !== g.epoch) return commit(a.room, g, a, c)
      replaceCopies(a.room, body.account)
      const answer = commit(a.room, g, a, c)
      a.room.links.push({ room_epoch: answer.epoch, change: ++a.room.change, recovery_link: link })
      return answer
    }

    // content
    if (is('POST', 'envelopes')) { const a = writer(rq); return postEnvelope({ ...a, rule: rq.rule }, field(body, 'envelope')) }
    if (is('GET', 'desk')) return desk(member(auth(rq)))
    if (is('GET', 'chats', null, null, 'items')) {
      const a = member(auth(rq))
      if (!['session', 'card'].includes(segs[1]) || !/^[0-9a-f]{32}$/.test(segs[2])) throw refuse('bad-format', 'a Chat is session/<id> or card/<id>, named by 32 hex digits')
      const key = `chat/${segs[1]}/${b64(Buffer.from(segs[2], 'hex'))}`, before = number(rq, 'before') ?? Infinity
      const found = a.room.envelopes.filter(e => timelineOf(e.header) === key && e.change < before && sees(a, a.room.groups.get(e.group))).reverse()
      return page(found, clamp(number(rq, 'limit'), 50, 200))
    }
    if (is('GET', 'boards', null)) {
      const a = member(auth(rq)), key = `board/desk/${pathId(segs[1], 16)}`, after = number(rq, 'after_change') ?? 0
      return page(a.room.envelopes.filter(e => timelineOf(e.header) === key && e.change > after && sees(a, a.room.groups.get(e.group))), clamp(number(rq, 'limit'), 500, 2000))
    }
    if (method === 'GET' && segs.length === 2 && ['cards', 'notes', 'permission-requests', 'artifacts'].includes(segs[0])) {
      const a = member(auth(rq)), o = objectsOf(a.room, a).get(pathId(segs[1], 16))
      if (!o || (OBJECT_TABLES[o.type] ?? 'cards') !== segs[0].replace('-', '_')) throw refuse('not-found', 'no such object')
      const after = number(rq, 'after') ?? 0
      return {
        object_id: o.object_id, group_id: o.group_id, state: o.state, urgency: o.urgency, owner: o.owner, first_change: o.first_change, head_change: o.head_change,
        ...page(o.items.filter(e => e.change > after), clamp(number(rq, 'limit'), 500, 2000)),
      }
    }
    if (is('GET', 'changes')) return changes(auth(rq), number(rq, 'after') ?? 0, clamp(number(rq, 'limit'), 200, 1000))

    // files and shares
    if (is('PUT', 'files', null)) {
      const a = member(writer(rq)), file_id = pathId(segs[1], 16), held = a.room.files.get(file_id), hash = b64(sha256(rq.raw))
      if (rq.raw.length > FILE_LIMIT) throw refuse('too-large', 'a file is at most 64 MiB')
      if (held?.deleted) throw refuse('gone', 'this file was deleted; its id is not used again')
      if (held && (held.uploader !== a.device || held.sha256 !== hash)) throw refuse('replay', 'other bytes under a used file id')
      if (!held) a.room.files.set(file_id, { bytes: rq.raw, uploader: a.device, sha256: hash, group: null, deleted: false })
      return { file_id, size: rq.raw.length, sha256: hash }
    }
    if (is('GET', 'files', null)) return fileAnswer(readableFile(auth(rq), pathId(segs[1], 16)).bytes, rq.headers.range)
    if (is('DELETE', 'files', null)) {
      const a = member(writer(rq)), file_id = pathId(segs[1], 16), file = a.room.files.get(file_id)
      if (!file || file.deleted || !(a.who === 'human' || file.uploader === a.device)) throw refuse('not-found', 'no such file')
      Object.assign(file, { deleted: true, bytes: Buffer.alloc(0) })
      emit(a.room, 'file_evicted', null, { file_id }, file.group)
      return { deleted: true }
    }
    if (is('POST', 'shares')) {
      const a = writer(rq)
      const sizes = { share_id: 16, secret_hash: 32, file_id: 16 }
      for (const [name, n] of Object.entries(sizes)) if (field(body, name).length !== n) throw refuse('bad-format', `${name}: ${n} bytes`)
      if (!Number.isSafeInteger(body.expires_at)) throw refuse('bad-format', 'expires_at')
      const shared = readableFile(a, body.file_id), artifact = shared.object && objectsOf(a.room, a).get(shared.object)
      if (!(artifact?.type === 'artifact' && artifact.state === 1)) throw refuse('forbidden', 'a Share link gives a file of an open Artifact')
      if (body.expires_at <= now() || body.expires_at > now() + 180 * 86_400_000) throw refuse('bad-format', 'a Share link expires within 180 days')
      const share = { share_id: body.share_id, secret_hash: body.secret_hash, file_id: body.file_id, expires_at: body.expires_at, room: a.room.room_id, created_by: a.device }
      const held = state.shares.get(share.share_id)
      if (held && JSON.stringify(held) !== JSON.stringify(share)) throw refuse('replay', 'this share id is used')
      state.shares.set(share.share_id, share)
      return { share_id: share.share_id, expires_at: share.expires_at }
    }
    if (is('DELETE', 'shares', null)) {
      const a = member(writer(rq)), share = state.shares.get(pathId(segs[1], 16))
      if (!share || share.room !== a.room.room_id || !(a.who === 'human' || share.created_by === a.device)) throw refuse('not-found', 'no such share')
      state.shares.delete(share.share_id)
      return { deleted: true }
    }
    if (is('GET', 'shares', null)) {
      const missing = refuse('not-found', 'no such share, or it ran out')
      const share = state.shares.get(unb64(segs[1])?.length === 16 ? segs[1] : ''), secret = unb64(rq.headers['x-share-secret'])
      const file = share && room(share.room).files.get(share.file_id)
      if (!file || file.deleted || secret?.length !== 32 || b64(sha256(secret)) !== share.secret_hash || share.expires_at <= now()) throw missing
      return fileAnswer(file.bytes, rq.headers.range)
    }

    // invites, by human devices
    if (is('POST', 'invites')) {
      const a = human(writer(rq)), [offer, signature] = [field(body, 'offer'), field(body, 'signature')]
      const o = read('offer', offer, 'the Offer'), held = state.invites.get(o.invite_id)
      if (held) { if (held.offer !== b64(offer)) throw refuse('replay', 'this invite id is used'); return { invite_id: held.invite_id } }
      if (o.room_id !== a.room.room_id) throw refuse('bad-invite', 'an Offer of this room, by the device that posts it')
      // the MAC that binds the Offer to its link: kept and served as it came (optional, as on the hub at first)
      const mac = body.mac === undefined || body.mac === null ? null : b64(field(body, 'mac'))
      state.invites.set(o.invite_id, { invite_id: o.invite_id, room: a.room.room_id, inviter: a.device, offer: b64(offer), signature: b64(signature), mac, expires_at: o.expires_at, requests: [], reveal: null, reveal_signature: null, burned: false })
      return { invite_id: o.invite_id }
    }
    if (is('PUT', 'invites', null, 'reveal')) {
      const a = human(writer(rq)), invite = state.invites.get(pathId(segs[1], 16)), [reveal, signature] = [field(body, 'reveal'), field(body, 'signature')]
      if (!invite || invite.room !== a.room.room_id || invite.inviter !== a.device) throw refuse('not-found', 'no such invite')
      if (invite.reveal) { if (invite.reveal !== b64(reveal)) throw refuse('invite-used', 'this invite revealed another Request'); return { revealed: true } }
      openInvite(invite.invite_id)
      if (!invite.requests.some(q => q.request_hash === read('reveal', reveal, 'the Reveal').request_hash)) throw refuse('bad-invite', 'the Reveal names a Request the hub does not hold')
      Object.assign(invite, { reveal: b64(reveal), reveal_signature: b64(signature) })
      return { revealed: true }
    }
    if (is('DELETE', 'invites', null)) {
      const a = human(writer(rq)), invite = state.invites.get(pathId(segs[1], 16))
      if (!invite || invite.room !== a.room.room_id) throw refuse('not-found', 'no such invite')
      invite.burned = true
      return { burned: true }
    }

    // push
    if (is('POST', 'push')) {
      const a = human(writer(rq)), list = a.room.push.get(a.device) ?? []
      if (!['all', 'knocking'].includes(body.level)) throw refuse('bad-format', 'level: all or knocking')
      const kind = body.web_push ? 'web_push' : body.apns ? 'apns' : null, endpoint = body.web_push?.endpoint ?? body.apns?.token
      if (!kind || typeof endpoint !== 'string') throw refuse('bad-format', 'web_push or apns')
      a.room.push.set(a.device, [...list.filter(s => s.endpoint !== endpoint), { kind, endpoint, level: body.level, created_at: now() }])
      return { registered: true }
    }
    if (is('GET', 'push')) { const a = human(auth(rq)); return { subscriptions: a.room.push.get(a.device) ?? [], vapid_public_key: b64(Buffer.alloc(65, 4)), apns: false } }
    if (is('DELETE', 'push')) {
      const a = human(writer(rq)), list = a.room.push.get(a.device) ?? [], kept = typeof body.endpoint === 'string' ? list.filter(s => s.endpoint !== body.endpoint) : []
      a.room.push.set(a.device, kept)
      return { deleted: list.length - kept.length }
    }
    throw refuse('not-found', 'no such route')

    function ownRoom(a, text) { if (pathId(text, 32) !== a.room.room_id) throw refuse('wrong-room', 'signed in to another room'); return a }
    function openInvite(invite_id) {
      const invite = state.invites.get(invite_id)
      if (!invite) throw refuse('not-found', 'no such invite')
      if (invite.burned) throw refuse('invite-burned', 'this invite was burned')
      if (invite.expires_at <= now()) throw refuse('invite-expired', 'this invite ran out')
      return invite
    }
    function recoveryOf(a, recovery_id) {
      const rec = a.room.recovery
      if (!rec || rec.recovery_id !== recovery_id) throw refuse('not-found', 'no such recovery')
      if (rec.expires_at <= now()) throw refuse('gone', 'the recovery ran out')
      return rec
    }
    function addRequest(a, kind, group_id, key_package, n, committer) {
      const row = { id: next(), device: a.device, kind, group_id, key_package: key_package ? b64(key_package) : null, n, at: now(), committer }
      a.room.requests.push(row)
      emit(a.room, 'request', null, { id: row.id, kind, device: a.device, group_id, n, ...(committer ? { committer } : {}) })
      return { id: row.id }
    }
  }

  // ---- HTTP

  /** As the real hub answers a page of another origin (a browser test's worker): the origin it came from is allowed. */
  function cors(headers) {
    return headers.origin ? { 'access-control-allow-origin': headers.origin, vary: 'Origin', 'access-control-expose-headers': 'content-range, content-length, retry-after' } : {}
  }
  function refusalAnswer(r) {
    const status = r.status ?? statusOf(r.code)
    return { status, headers: r.retry_after ? { 'retry-after': String(r.retry_after) } : {}, json: { error: r.code, message: r.message, ...r.extra } }
  }
  function tooOld(header) {
    if (!opts.min_client) return false
    const parse = v => { const parts = String(v).split('/').pop().split('.').map(Number); return parts.some(Number.isNaN) ? null : parts }
    const [have, need] = [header === undefined ? null : parse(header), parse(opts.min_client)]
    if (!have) return true
    for (let i = 0; i < Math.max(have.length, need.length); i++) if ((have[i] ?? -1) !== (need[i] ?? -1)) return (have[i] ?? -1) < (need[i] ?? -1)
    return false
  }
  function handle(rq, res) {
    const { method, segs } = rq
    if (rq.path === '/healthz') return { status: 200, json: { ok: true, commit: 'fake', protocol_version: 2 } }
    if (segs.shift() !== 'v2') return refusalAnswer(refuse('not-found', 'every route is under /v2/'))
    if (tooOld(rq.headers['trommi-client'])) return refusalAnswer(refuse('client-too-old', 'this client is too old for this hub'))
    const binary = method === 'PUT' && segs[0] === 'files'
    try {
      if (!binary) {
        let parsed = {}
        if (rq.raw.length) { try { parsed = JSON.parse(rq.raw.toString('utf8')) } catch { parsed = null } }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw refuse('bad-format', 'the body is one JSON object')
        rq.body = rq.log.body = parsed
      } else rq.log.body = { bytes: rq.raw.length }
      if (method === 'GET' && segs.length === 1 && segs[0] === 'stream') { openStream(rq, res); return null }
      const answer = route(rq)
      return answer?.status ? answer : { status: 200, json: answer }
    } catch (e) {
      if (e instanceof Refused) return refusalAnswer(e)
      throw e
    }
  }
  function write(res, answer, cut) {
    const body = answer.bytes ?? Buffer.from(typeof answer.body === 'string' || Buffer.isBuffer(answer.body) ? answer.body : JSON.stringify(answer.json))
    const headers = { ...(answer.bytes || answer.body !== undefined ? {} : { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }), 'content-length': body.length, ...res.cors, ...answer.headers }
    res.writeHead(answer.status, headers)
    if (!cut) return res.end(body)
    res.write(body.subarray(0, Math.floor(body.length / 2)), () => res.destroy())
  }
  async function onRequest(req, res) {
    res.cors = cors(req.headers)
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...res.cors, 'access-control-allow-methods': 'GET, POST, PUT, DELETE', 'access-control-max-age': '86400',
        'access-control-allow-headers': 'authorization, content-type, trommi-client, trommi-lease, x-share-secret, x-found-token, range, last-event-id' })
      return res.end()
    }
    const chunks = []
    for await (const c of req) chunks.push(c)
    const at = new URL(req.url, 'http://hub')
    const log = { method: req.method, path: at.pathname, query: Object.fromEntries(at.searchParams), body: null, device: null, status: null, dropped: null }
    const rq = { method: req.method, path: at.pathname, segs: at.pathname.split('/').filter(Boolean), query: at.searchParams, headers: req.headers, raw: Buffer.concat(chunks), body: {}, log, rule: null }
    requests.push(log)
    const rule = rules.find(r => r.times > 0 && (!r.method || r.method === rq.method) && (!r.path || (r.path instanceof RegExp ? r.path.test(rq.path) : r.path === rq.path)) && (!r.when || r.when(rq)))
    if (rule) { rule.times -= 1; rq.rule = rule }
    if (rule?.delay_ms) await new Promise(r => setTimeout(r, rule.delay_ms))
    if (rule?.drop === 'before') { log.dropped = 'before'; return res.destroy() }
    let answer
    if (rule?.refuse) answer = refusalAnswer(refuse(rule.refuse.error, rule.refuse.message ?? rule.refuse.error, rule.refuse.voided ? { voided: true } : {}, rule.refuse.retry_after ?? null))
    else if (rule?.raw) answer = rule.raw
    else answer = handle(rq, res)
    if (rule?.refuse?.status) answer.status = rule.refuse.status
    if (answer === null) { log.status = 200; return }
    if (rule?.answer && answer.json !== undefined) { const made = rule.answer(answer.json, answer); answer = made?.status ? made : { ...answer, json: made } }
    log.status = answer.status
    if (rule?.drop === 'after') { log.dropped = 'after'; return res.destroy() }
    if (rule?.drop === 'mid') log.dropped = 'mid'
    write(res, answer, rule?.drop === 'mid')
  }

  async function listen(port) {
    session = { tokens: new Map(), challenges: new Map(), passkey_challenges: new Map() }
    sockets = new Set()
    streams = new Set()
    server = http.createServer((req, res) => {
      onRequest(req, res).catch(() => { if (!res.headersSent) write(res, refusalAnswer(refuse('internal', 'internal error'))); else res.destroy() })
    })
    server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
    url = `http://127.0.0.1:${server.address().port}`
  }
  async function close() {
    for (const s of sockets) s.destroy()
    await new Promise(resolve => server.close(resolve))
    // A client in this same process (the tests' fetch keeps its connections alive) learns that its connections were
    // cut only when the event loop comes round to them. Until then it would send its next request into a dead one,
    // which no client of a hub in another process does: the hub is "stopped" once that has happened.
    for (let turn = 0; turn < TURNS_AFTER_CLOSE; turn++) await new Promise(resolve => setImmediate(resolve))
  }
  await listen(opts.port ?? 0)

  return {
    get url() { return url },
    state, faults, requests, close,
    /** Kills the hub (every connection is cut, tokens and challenges are gone) and starts it again with its state. */
    async restart() { const port = server.address().port; await close(); await listen(port) },
    /** Stops the hub; `start()` brings it back on the same port with its state. */
    async stop() { this.port = server.address().port; await close() },
    async start() { await listen(this.port) },
    /** Writes raw text into every open stream of a room: for events a real hub would never send. */
    push(room_id, text) { for (const s of streams) if (s.room.room_id === room_id && open(s)) s.res.write(text) },
    dropStreams() { for (const s of streams) s.res.destroy() },
    /** Cuts every connection without a word, as a hub that died does; clients that kept one alive find out when they use it. */
    dropConnections() { for (const s of sockets) s.destroy() },
    get streams() { return streams.size },
    /** How many tokens the hub holds: a sign-out ends one. */
    get tokens() { return session.tokens.size },
    /** A room set up without a founding: its room group at epoch 0 with these human devices as leaves. */
    seedRoom(room_id, devices, more = {}) {
      const r = newRoom(room_id)
      for (const d of devices) r.devices.set(d, 'human')
      for (const k of more.recovery_keys ?? []) r.recovery_keys.add(k)
      addGroup(r, { group: room_id, leaves: devices, session: null }, Buffer.from('{}'))
      state.rooms.set(room_id, r)
      return r
    },
  }
}
