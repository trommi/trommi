// Pairing and keys (card Nr. 80, docs/pairing.md): crypto/hub.mjs wired to HTTP, with its storage in the
// hub's database (data/pad.db, tables pair_*). Off unless BOARD_PAIRING=1.
//
// Phase B of docs/pairing.md, section 7, and only its hub side: the routes stand behind today's login
// (the cookie for a page, the token header for a process on this machine), and nothing else on the board
// uses them yet. A signed sign-in does not replace the token here; it gives the session token the
// routes below ask for in `x-pair-token`.
//
// Bytes travel as base64url strings; ids as hex, as crypto/hub.mjs returns them.
//
//   GET  /pair/room                                   { roomId, members } (roomId null before a room is founded)
//   POST /pair/found         { entry, wraps }          the first device founds the room
//   POST /pair/entry         { entry, wraps, backLink } add, remove, recover
//   GET  /pair/log?after=&invite=                     the signed member list            (x-pair-token, or an open invite)
//   POST /pair/challenge                              { challenge }
//   POST /pair/sign-in       { signed }                { token, id, kind, role, expiresAt }
//   GET  /pair/wraps?after_epoch=                     own sealed room keys               (x-pair-token)
//   GET  /pair/back-links                             links back to older room keys      (x-pair-token, humans)
//   POST /pair/invites       { offer }                 announce an invite                 (x-pair-token, humans)
//   GET  /pair/invites/<id>                           the offer and the member list, for the newcomer
//   POST /pair/invites/<id>/requests { request }      the newcomer's request
//   GET  /pair/invites/<id>/requests                  the requests, for the inviter      (x-pair-token)
//   POST /pair/invites/<id>/reveal   { reveal }       the inviter answers one request    (x-pair-token)
//   GET  /pair/invites/<id>/status?request=<hash>     for the newcomer, polled
//   POST /pair/envelopes     { envelope }              (x-pair-token, members)
//   GET  /pair/envelopes?after=&limit=                (x-pair-token, members)
//   POST /pair/claim         { name, instance }        an agent's board session id for its key (x-pair-token, agents)
import { DatabaseSync } from 'node:sqlite'
import { createHub } from '../crypto/hub.mjs'
import * as z from '../crypto/zcrypto.mjs'

// Byte values inside an invite record (offer, requests, reveal) are kept as { $b: base64url } in its JSON.
const pack = value => JSON.stringify(value, (k, v) => (v instanceof Uint8Array ? { $b: z.b64u(v) } : v))
const unpack = text => JSON.parse(text, (k, v) => (v && typeof v === 'object' && typeof v.$b === 'string' && Object.keys(v).length === 1 ? z.unb64u(v.$b) : v))
const bytes = value => (value instanceof Uint8Array ? value : new Uint8Array(value))

/** Its own connection to the hub's database file (WAL, like board-store.mjs). */
export function openPairDb(file) {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA journal_mode = WAL')
  return db
}

/** The storage crypto/hub.mjs asks for (the methods of its memoryStorage), on a node:sqlite database. */
export function sqliteStorage(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pair_log (n INTEGER PRIMARY KEY, bytes BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS pair_wraps (epoch INTEGER NOT NULL, id TEXT NOT NULL, sealed BLOB NOT NULL, PRIMARY KEY (epoch, id)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS pair_back_links (epoch INTEGER PRIMARY KEY, bytes BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS pair_invites (id TEXT PRIMARY KEY, doc TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS pair_envelopes (n INTEGER PRIMARY KEY, bytes BLOB NOT NULL, meta TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pair_sessions (device TEXT PRIMARY KEY, session TEXT NOT NULL UNIQUE) WITHOUT ROWID;
  `)
  const q = sql => db.prepare(sql)
  const s = {
    entries: q('SELECT bytes FROM pair_log ORDER BY n'),
    appendEntry: q('INSERT INTO pair_log (bytes) VALUES (?)'),
    putWrap: q('INSERT OR IGNORE INTO pair_wraps (epoch, id, sealed) VALUES (?, ?, ?)'),
    wraps: q('SELECT epoch, id, sealed FROM pair_wraps WHERE id = ? AND epoch > ? ORDER BY epoch'),
    putBackLink: q('INSERT OR IGNORE INTO pair_back_links (epoch, bytes) VALUES (?, ?)'),
    backLinks: q('SELECT epoch, bytes FROM pair_back_links ORDER BY epoch'),
    putInvite: q('INSERT INTO pair_invites (id, doc) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET doc = excluded.doc'),
    invite: q('SELECT doc FROM pair_invites WHERE id = ?'),
    invites: q('SELECT doc FROM pair_invites'),
    appendEnvelope: q('INSERT INTO pair_envelopes (bytes, meta) VALUES (?, ?)'),
    envelopes: q('SELECT n, bytes, meta FROM pair_envelopes WHERE n > ? ORDER BY n LIMIT ?'),
    replaceEnvelope: q("UPDATE pair_envelopes SET bytes = ?, meta = json_set(meta, '$.pruned', json('true')) WHERE n = ?"),
    bindSession: q('INSERT INTO pair_sessions (device, session) VALUES (?, ?) ON CONFLICT (device) DO UPDATE SET session = excluded.session'),
    sessionOf: q('SELECT session FROM pair_sessions WHERE device = ?'),
    boundSessions: q('SELECT session FROM pair_sessions'),
  }
  return {
    entries: () => s.entries.all().map(r => bytes(r.bytes)),
    appendEntry: entry => { s.appendEntry.run(entry) },
    putWrap: (epoch, id, sealed) => { s.putWrap.run(epoch, id, sealed) },
    wraps: (id, afterEpoch = 0) => s.wraps.all(id, afterEpoch).map(r => ({ epoch: r.epoch, id: r.id, sealed: bytes(r.sealed) })),
    putBackLink: (epoch, link) => { s.putBackLink.run(epoch, link) },
    backLinks: () => s.backLinks.all().map(r => ({ epoch: r.epoch, bytes: bytes(r.bytes) })),
    putInvite: (id, invite) => { s.putInvite.run(id, pack(invite)) },
    invite: id => { const r = s.invite.get(id); return r ? unpack(r.doc) : null },
    invites: () => s.invites.all().map(r => unpack(r.doc)),
    appendEnvelope: (envelope, meta) => Number(s.appendEnvelope.run(envelope, JSON.stringify(meta)).lastInsertRowid),
    envelopes: (after = 0, limit = 200) => s.envelopes.all(after, Number.isFinite(limit) ? limit : -1).map(r => ({ n: r.n, bytes: bytes(r.bytes), ...JSON.parse(r.meta) })),
    replaceEnvelope: (n, pruned) => { s.replaceEnvelope.run(pruned, n) },
    bindSession: (device, session) => { s.bindSession.run(device, session) },
    sessionOf: device => s.sessionOf.get(device)?.session ?? null,
    boundSessions: () => s.boundSessions.all().map(r => r.session),
  }
}

const STATUS = {
  unauthorised: 401, forbidden: 403, 'not-member': 403, 'wrong-sender': 403, 'removed-sender': 403,
  'not-found': 404, 'no-room': 404,
  'room-exists': 409, 'invite-used': 409, 'instance-conflict': 409, replay: 409, 'too-many': 429,
  'invite-expired': 410,
}

/**
 * The routes. `open(dataDir)` gives the database; the hub module is made on the first request, from what is
 * stored (it verifies the stored member list and envelopes again). The caller lets through only who holds
 * today's token, so anyone who gets here may found the room. Returns async (req, res, url, readJson, send).
 */
export function pairingRoutes({ db, hubUrl }) {
  let hub = null
  const ready = () => (hub ??= createHub({ hubUrl, storage: sqliteStorage(db) }).catch(err => { hub = null; throw err }))
  const b = value => {
    if (typeof value !== 'string') throw new z.ZError('bad-format', 'bytes are sent as base64url strings')
    return z.unb64u(value)
  }
  const out = value => JSON.stringify(value, (k, v) => (v instanceof Uint8Array ? z.b64u(v) : v))
  const wrapsOf = list => (Array.isArray(list) ? list.map(w => ({ id: b(w?.id), sealed: b(w?.sealed) })) : list)
  const int = (value, fallback) => (value != null && /^-?\d+$/.test(value) ? Number(value) : fallback)

  return async function route(req, res, url, readJson, send) {
    if (!url.pathname.startsWith('/pair/')) return false
    const token = String(req.headers['x-pair-token'] ?? '')
    const parts = url.pathname.split('/').slice(2)
    const get = req.method === 'GET'
    try {
      const h = await ready()
      const body = get ? {} : await readJson(req)
      let result
      const [what, inviteId, sub] = parts
      if (get && what === 'room' && parts.length === 1) result = { roomId: h.roomId, members: h.roomId ? h.members() : [] }
      else if (!get && what === 'found' && parts.length === 1) {
        result = await h.found({ entry: b(body.entry), wraps: wrapsOf(body.wraps) })
      } else if (!get && what === 'entry' && parts.length === 1) result = await h.postEntry({ entry: b(body.entry), wraps: wrapsOf(body.wraps), backLink: body.backLink == null ? undefined : b(body.backLink) })
      else if (get && what === 'log' && parts.length === 1) result = h.log({ token, inviteId: url.searchParams.get('invite') ?? undefined, after: int(url.searchParams.get('after'), -1) })
      else if (!get && what === 'challenge' && parts.length === 1) result = { challenge: h.challenge() }
      else if (!get && what === 'sign-in' && parts.length === 1) result = await h.signIn(b(body.signed))
      else if (get && what === 'wraps' && parts.length === 1) result = h.wraps(token, { afterEpoch: int(url.searchParams.get('after_epoch'), 0) })
      else if (get && what === 'back-links' && parts.length === 1) result = h.backLinks(token)
      else if (!get && what === 'invites' && parts.length === 1) result = await h.postInvite(token, b(body.offer))
      else if (get && what === 'invites' && parts.length === 2) result = h.invite(inviteId)
      else if (!get && what === 'invites' && sub === 'requests' && parts.length === 3) result = await h.postRequest(inviteId, b(body.request))
      else if (get && what === 'invites' && sub === 'requests' && parts.length === 3) result = h.requests(token, inviteId)
      else if (!get && what === 'invites' && sub === 'reveal' && parts.length === 3) result = await h.postReveal(token, inviteId, b(body.reveal))
      else if (get && what === 'invites' && sub === 'status' && parts.length === 3) result = h.joinStatus(inviteId, url.searchParams.get('request') ?? '')
      else if (!get && what === 'envelopes' && parts.length === 1) result = await h.postEnvelope(token, b(body.envelope))
      else if (get && what === 'envelopes' && parts.length === 1) result = h.envelopes(token, { after: int(url.searchParams.get('after'), 0), limit: Math.min(int(url.searchParams.get('limit'), 200), 500) })
      else if (!get && what === 'claim' && parts.length === 1) result = h.claimSession(token, { name: String(body.name ?? ''), instance: String(body.instance ?? '') })
      else return send(res, 404, '{"error":"not found"}'), true
      send(res, 200, out(result ?? { ok: true }))
    } catch (err) {
      if (err instanceof z.ZError) send(res, STATUS[err.code] ?? 400, out({ error: err.code, message: err.message }))
      else send(res, 400, out({ error: 'bad-request', message: err.message }))
    }
    return true
  }
}
