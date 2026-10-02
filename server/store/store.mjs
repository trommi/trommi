// Trommi's storage layer: an append-only event log with a few materialised
// views beside it, in one SQLite file per room. Not wired into server.mjs yet.
// The data model is described in docs/storage.md, the API in README.md here.
//
// Rules this file keeps:
//   - every change that touches more than one row runs in one transaction
//   - every read is bounded by a limit; nothing returns "all rows"
//   - payloads are opaque bytes; the store looks inside only while they are
//     plaintext JSON (enc = 0) and only for conveniences that go away with encryption
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite'
import crypto from 'node:crypto'
import fs from 'node:fs'

export const SCHEMA_VERSION = 3
export const DAY = 86400000
export const URGENCIES = ['low', 'normal', 'high', 'critical']
export const STATUS_STATES = ['decision', 'working', 'done']
export const ELEMENT_TYPES = ['stroke', 'image', 'text', 'voice']
export const BLOB_KINDS = ['attachment', 'asset', 'scribble', 'canvas', 'pad', 'voice']
// How a blob ends: with the last event that points to it, by age, never, or with its owner.
export const RETENTIONS = ['refs', 'age', 'keep', 'owner']
// Payload encodings. 0: plaintext JSON. 1: an envelope as in docs/krypto-konzept.md, section 5.
export const ENC_JSON = 0
export const ENC_SEALED = 1
// Notifications kept for a session that is away; the oldest give way.
export const QUEUE_MAX = 100
const ADMIN_LOG_MAX = 300
// Types whose views this file maintains; they are written through their own methods only.
const RESERVED = /^(card|status|session|pad|canvas|blob)\.|^message$/

// Marks a column that takes the seq of the event being written.
const SEQ = Symbol('seq')

export class StoreError extends Error {
  // code: invalid (bad argument), not_found, illegal (state does not allow it), conflict
  constructor(code, message) {
    super(message)
    this.name = 'StoreError'
    this.code = code
  }
}
const fail = (code, message) => { throw new StoreError(code, message) }

// ---- schema ----------------------------------------------------------------

// One entry per version; PRAGMA user_version says how many have run. An entry
// is never edited once released, only followed by another.
const MIGRATIONS = [
  // 1: the log and its views
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value) WITHOUT ROWID;

  -- Whoever appends: a session, a human device, the hub itself. Later: a device from the member list.
  CREATE TABLE senders (
    n        INTEGER PRIMARY KEY,
    id       TEXT NOT NULL UNIQUE,
    last_seq INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE sessions (
    id           TEXT PRIMARY KEY,
    instance     TEXT,
    online       INTEGER NOT NULL DEFAULT 0,
    archived     INTEGER NOT NULL DEFAULT 0,
    joined       INTEGER NOT NULL,
    connected    INTEGER,
    seen         INTEGER,
    forgotten_at INTEGER,
    messages     INTEGER NOT NULL DEFAULT 0,
    profile      BLOB,
    profile_enc  INTEGER NOT NULL DEFAULT 0,
    profile_seq  INTEGER
  ) WITHOUT ROWID;

  -- The log. Rows are never deleted and seq is never reused; a purge empties payload and keeps the header.
  CREATE TABLE events (
    seq         INTEGER PRIMARY KEY,
    sender      INTEGER NOT NULL REFERENCES senders(n),
    sender_seq  INTEGER NOT NULL,
    client_id   TEXT NOT NULL,
    type        TEXT NOT NULL,
    session     TEXT REFERENCES sessions(id),
    card_id     TEXT,
    card_status TEXT,
    answered_at INTEGER,
    ref         TEXT,
    push        INTEGER NOT NULL DEFAULT 0,
    created     INTEGER NOT NULL,
    sent        INTEGER,
    enc         INTEGER NOT NULL DEFAULT 0,
    epoch       INTEGER NOT NULL DEFAULT 0,
    payload     BLOB,
    size        INTEGER NOT NULL DEFAULT 0,
    hash        BLOB,
    prev_hash   BLOB,
    sig         BLOB,
    purged_at   INTEGER,
    UNIQUE (sender, client_id),
    UNIQUE (sender, sender_seq)
  );
  CREATE INDEX events_session ON events (session, seq);
  CREATE INDEX events_card ON events (card_id, seq) WHERE card_id IS NOT NULL;

  CREATE TABLE cards (
    id          TEXT PRIMARY KEY,
    session     TEXT NOT NULL REFERENCES sessions(id),
    number      INTEGER NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('decision', 'permission')),
    status      TEXT NOT NULL CHECK (status IN ('open', 'decided', 'done')),
    closed_as   TEXT CHECK (closed_as IN ('closed', 'withdrawn', 'expired', 'answered')),
    urgency     TEXT CHECK (urgency IN ('low', 'normal', 'high', 'critical')),
    request_id  TEXT,
    created     INTEGER NOT NULL,
    answered_at INTEGER,
    closed_at   INTEGER,
    ask_seq     INTEGER NOT NULL REFERENCES events(seq),
    answer_seq  INTEGER REFERENCES events(seq),
    close_seq   INTEGER REFERENCES events(seq),
    urgency_seq INTEGER REFERENCES events(seq),
    last_seq    INTEGER NOT NULL REFERENCES events(seq)
  ) WITHOUT ROWID;
  CREATE INDEX cards_session ON cards (session, number);
  CREATE INDEX cards_status ON cards (status, created);
  CREATE INDEX cards_number ON cards (number);

  CREATE TABLE messages (
    id      TEXT PRIMARY KEY,
    seq     INTEGER NOT NULL UNIQUE REFERENCES events(seq),
    session TEXT NOT NULL REFERENCES sessions(id),
    origin  TEXT NOT NULL CHECK (origin IN ('user', 'agent')),
    created INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX messages_session ON messages (session, seq);

  CREATE TABLE status_lines (
    session TEXT NOT NULL REFERENCES sessions(id),
    id      TEXT NOT NULL,
    state   TEXT NOT NULL CHECK (state IN ('decision', 'working', 'done')),
    card_id TEXT,
    updated INTEGER NOT NULL,
    seq     INTEGER NOT NULL REFERENCES events(seq),
    payload BLOB,
    enc     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session, id)
  ) WITHOUT ROWID;
  CREATE INDEX status_lines_card ON status_lines (card_id) WHERE card_id IS NOT NULL;

  CREATE TABLE deliveries (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    session   TEXT NOT NULL REFERENCES sessions(id),
    method    TEXT NOT NULL,
    params    BLOB NOT NULL,
    enc       INTEGER NOT NULL DEFAULT 0,
    event_seq INTEGER REFERENCES events(seq),
    dedupe    TEXT UNIQUE,
    created   INTEGER NOT NULL,
    handed_at INTEGER,
    attempts  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX deliveries_session ON deliveries (session, id);
  CREATE INDEX deliveries_created ON deliveries (created);

  CREATE TABLE blobs (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN ('attachment', 'asset', 'scribble', 'canvas', 'pad', 'voice')),
    path        TEXT NOT NULL UNIQUE,
    size        INTEGER,
    sha256      BLOB,
    session     TEXT REFERENCES sessions(id),
    retention   TEXT NOT NULL CHECK (retention IN ('refs', 'age', 'keep', 'owner')),
    created     INTEGER NOT NULL,
    meta        BLOB,
    meta_enc    INTEGER NOT NULL DEFAULT 0,
    wrapped_key BLOB,
    doomed_at   INTEGER
  ) WITHOUT ROWID;
  CREATE INDEX blobs_retention ON blobs (retention, created);
  CREATE INDEX blobs_session ON blobs (session);
  CREATE INDEX blobs_doomed ON blobs (doomed_at) WHERE doomed_at IS NOT NULL;

  CREATE TABLE event_blobs (
    seq     INTEGER NOT NULL REFERENCES events(seq),
    blob_id TEXT NOT NULL REFERENCES blobs(id),
    PRIMARY KEY (seq, blob_id)
  ) WITHOUT ROWID;
  CREATE INDEX event_blobs_blob ON event_blobs (blob_id);

  CREATE TABLE canvases (
    session    TEXT PRIMARY KEY REFERENCES sessions(id),
    version    INTEGER NOT NULL,
    doc_blob   TEXT REFERENCES blobs(id),
    image_blob TEXT REFERENCES blobs(id),
    updated    INTEGER NOT NULL,
    updated_by TEXT
  ) WITHOUT ROWID;

  CREATE TABLE admin_log (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    ts     INTEGER NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL DEFAULT '',
    count  INTEGER NOT NULL DEFAULT 1
  );
  `,
  // 2: the global pad, one row per element
  `
  CREATE TABLE pads (
    id      TEXT PRIMARY KEY,
    created INTEGER NOT NULL
  ) WITHOUT ROWID;

  CREATE TABLE pad_elements (
    id         TEXT PRIMARY KEY,
    pad        TEXT NOT NULL REFERENCES pads(id),
    type       TEXT NOT NULL CHECK (type IN ('stroke', 'image', 'text', 'voice')),
    grp        TEXT,
    x          REAL NOT NULL DEFAULT 0,
    y          REAL NOT NULL DEFAULT 0,
    w          REAL NOT NULL DEFAULT 0,
    h          REAL NOT NULL DEFAULT 0,
    rotation   REAL NOT NULL DEFAULT 0,
    z          INTEGER NOT NULL,
    author     TEXT NOT NULL,
    created    INTEGER NOT NULL,
    updated    INTEGER NOT NULL,
    rev        INTEGER NOT NULL DEFAULT 1,
    deleted_at INTEGER,
    blob_id    TEXT REFERENCES blobs(id),
    payload    BLOB,
    enc        INTEGER NOT NULL DEFAULT 0,
    seq        INTEGER NOT NULL REFERENCES events(seq)
  ) WITHOUT ROWID;
  CREATE INDEX pad_elements_z ON pad_elements (pad, z, id);
  CREATE INDEX pad_elements_seq ON pad_elements (pad, seq);

  -- "Sent to": which element went to which session, with which event, in which revision.
  CREATE TABLE pad_links (
    element TEXT NOT NULL REFERENCES pad_elements(id),
    session TEXT NOT NULL REFERENCES sessions(id),
    seq     INTEGER NOT NULL REFERENCES events(seq),
    rev     INTEGER NOT NULL,
    sent_at INTEGER NOT NULL,
    sent_by TEXT NOT NULL,
    PRIMARY KEY (element, session, seq)
  ) WITHOUT ROWID;
  CREATE INDEX pad_links_session ON pad_links (session, seq);
  `,
  // 3: what the crypto concept needs the hub to keep (docs/krypto-konzept.md, sections 2 to 4)
  `
  CREATE TABLE member_log (
    n         INTEGER PRIMARY KEY,
    prev_hash BLOB,
    hash      BLOB NOT NULL UNIQUE,
    kind      TEXT NOT NULL CHECK (kind IN ('founding', 'add', 'remove', 'epoch')),
    device    TEXT,
    role      TEXT CHECK (role IN ('human', 'agent', 'recovery')),
    epoch     INTEGER,
    signer    TEXT NOT NULL,
    entry     BLOB NOT NULL,
    created   INTEGER NOT NULL
  );

  CREATE TABLE devices (
    id        TEXT PRIMARY KEY,
    role      TEXT NOT NULL CHECK (role IN ('human', 'agent', 'recovery')),
    session   TEXT REFERENCES sessions(id),
    sign_pub  BLOB,
    kex_pub   BLOB,
    added_n   INTEGER NOT NULL REFERENCES member_log(n),
    removed_n INTEGER REFERENCES member_log(n)
  ) WITHOUT ROWID;

  CREATE TABLE wrapped_keys (
    epoch     INTEGER NOT NULL,
    recipient TEXT NOT NULL,
    kind      TEXT NOT NULL DEFAULT 'member' CHECK (kind IN ('member', 'recovery', 'previous')),
    wrapped   BLOB NOT NULL,
    created   INTEGER NOT NULL,
    PRIMARY KEY (epoch, recipient)
  ) WITHOUT ROWID;
  CREATE INDEX wrapped_keys_recipient ON wrapped_keys (recipient, epoch);

  CREATE TABLE invites (
    id      TEXT PRIMARY KEY,
    role    TEXT NOT NULL CHECK (role IN ('human', 'agent')),
    created INTEGER NOT NULL,
    expires INTEGER NOT NULL,
    used_at INTEGER
  ) WITHOUT ROWID;
  `,
]

// ---- helpers ---------------------------------------------------------------

const isBytes = v => v instanceof Uint8Array
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest()
const newId = (bytes = 4) => crypto.randomBytes(bytes).toString('hex')
const clamp = (n, fallback, max) => Math.max(1, Math.min(max, Number.isInteger(n) ? n : fallback))
const urgencyRank = "CASE c.urgency WHEN 'critical' THEN 3 WHEN 'high' THEN 2 WHEN 'low' THEN 0 ELSE 1 END"

// What the caller gave as content: `payload` (bytes, taken as they are) or `body` (any JSON value).
function encode(given, encWhenBytes = ENC_SEALED) {
  if (given.payload != null) {
    if (!isBytes(given.payload)) fail('invalid', 'payload must be bytes (Uint8Array); use body for JSON')
    return { payload: given.payload, enc: given.enc ?? encWhenBytes }
  }
  if (given.body === undefined) return { payload: null, enc: ENC_JSON }
  return { payload: Buffer.from(JSON.stringify(given.body)), enc: ENC_JSON }
}
// The JSON inside a plaintext payload; undefined for ciphertext, purged or unreadable content.
function decode(payload, enc) {
  if (payload == null || enc !== ENC_JSON) return undefined
  try { return JSON.parse(Buffer.from(payload).toString()) } catch { return undefined }
}
function blobPath(given) {
  const p = String(given ?? '')
  if (!p || p.startsWith('/') || p.includes('\\') || p.split('/').some(part => part === '' || part === '.' || part === '..')) {
    fail('invalid', `a blob path is relative to the data directory and stays inside it; got ${JSON.stringify(given)}`)
  }
  return p
}

const eventOf = r => r && ({
  seq: r.seq, sender: r.sender_id, senderSeq: r.sender_seq, clientId: r.client_id, type: r.type, session: r.session,
  cardId: r.card_id, cardStatus: r.card_status, answeredAt: r.answered_at, ref: r.ref, push: r.push === 1,
  created: r.created, sent: r.sent, enc: r.enc, epoch: r.epoch, size: r.size, hash: r.hash, prevHash: r.prev_hash, sig: r.sig,
  purged: r.purged_at != null, payload: r.payload, body: decode(r.payload, r.enc),
})
const EVENT_SQL = 'SELECT e.*, s.id AS sender_id FROM events e JOIN senders s ON s.n = e.sender'

const cardOf = r => r && ({
  id: r.id, session: r.session, number: r.number, kind: r.kind, status: r.status, closedAs: r.closed_as, urgency: r.urgency,
  requestId: r.request_id, created: r.created, answeredAt: r.answered_at, closedAt: r.closed_at,
  askSeq: r.ask_seq, answerSeq: r.answer_seq, closeSeq: r.close_seq, urgencySeq: r.urgency_seq, lastSeq: r.last_seq,
  ask: decode(r.ask_payload, r.ask_enc), answer: decode(r.answer_payload, r.answer_enc),
  close: decode(r.close_payload, r.close_enc), urgencyNote: decode(r.urgency_payload, r.urgency_enc),
  askPayload: r.ask_payload ?? null, askEnc: r.ask_enc ?? ENC_JSON,
})
// A card with the content of the events that made it what it is.
const CARD_SQL = `SELECT c.*, a.payload AS ask_payload, a.enc AS ask_enc, n.payload AS answer_payload, n.enc AS answer_enc,
    d.payload AS close_payload, d.enc AS close_enc, u.payload AS urgency_payload, u.enc AS urgency_enc
  FROM cards c JOIN events a ON a.seq = c.ask_seq
  LEFT JOIN events n ON n.seq = c.answer_seq LEFT JOIN events d ON d.seq = c.close_seq LEFT JOIN events u ON u.seq = c.urgency_seq`

const sessionOf = r => r && ({
  id: r.id, instance: r.instance, online: r.online === 1, archived: r.archived === 1, joined: r.joined, connected: r.connected,
  seen: r.seen, forgotten: r.forgotten_at != null, messages: r.messages, profile: decode(r.profile, r.profile_enc) ?? null,
  profilePayload: r.profile, profileEnc: r.profile_enc, profileSeq: r.profile_seq,
})
const statusOf = r => r && ({
  ...(decode(r.payload, r.enc) ?? {}), session: r.session, id: r.id, state: r.state, cardId: r.card_id, updated: r.updated,
  seq: r.seq, payload: r.payload, enc: r.enc,
})
const blobOf = r => r && ({
  id: r.id, kind: r.kind, path: r.path, size: r.size, sha256: r.sha256, session: r.session, retention: r.retention,
  created: r.created, meta: decode(r.meta, r.meta_enc) ?? null, metaPayload: r.meta, metaEnc: r.meta_enc,
  wrappedKey: r.wrapped_key, doomed: r.doomed_at != null,
})
const elementOf = r => r && ({
  id: r.id, pad: r.pad, type: r.type, x: r.x, y: r.y, w: r.w, h: r.h, rotation: r.rotation, z: r.z, group: r.grp, author: r.author,
  created: r.created, updated: r.updated, rev: r.rev, deleted: r.deleted_at != null, blob: r.blob_id, seq: r.seq,
  data: decode(r.payload, r.enc), payload: r.payload, enc: r.enc,
})
const deliveryOf = r => r && ({
  id: r.id, session: r.session, method: r.method, params: decode(r.params, r.enc), payload: r.params, enc: r.enc,
  eventSeq: r.event_seq, created: r.created, handedAt: r.handed_at, attempts: r.attempts,
})
const fileOf = r => ({ id: r.id, kind: r.kind, path: r.path, size: r.size ?? 0 })

// ---- the store -------------------------------------------------------------

export class Store {
  // file: a path, or ':memory:'. options:
  //   now            clock, for tests
  //   synchronous    'FULL' (default: a committed write survives power loss) or 'NORMAL' (survives a crash of the
  //                  process, may lose the last commits on power loss, never corrupts)
  //   targetVersion  stop migrating at this schema version (tests only)
  //   busyTimeout    how long a write waits for another connection, in ms
  constructor(file, { now = Date.now, synchronous = 'FULL', targetVersion = SCHEMA_VERSION, busyTimeout = 5000 } = {}) {
    if (!['FULL', 'NORMAL'].includes(synchronous)) fail('invalid', 'synchronous must be FULL or NORMAL')
    this.file = file
    this.now = now
    this.depth = 0
    this.statements = new Map()
    this.db = new DatabaseSync(file)
    this.db.exec(`PRAGMA busy_timeout = ${Number(busyTimeout) | 0}`)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(`PRAGMA synchronous = ${synchronous}`)
    this.db.exec('PRAGMA foreign_keys = ON')
    this.migrate(targetVersion)
  }

  get version() { return this.db.prepare('PRAGMA user_version').get().user_version }

  migrate(target = SCHEMA_VERSION) {
    const from = this.version
    if (from > SCHEMA_VERSION) {
      this.db.close()
      fail('conflict', `the database is at schema version ${from}, this code knows up to ${SCHEMA_VERSION}; refusing to open it`)
    }
    for (let v = from; v < Math.min(target, MIGRATIONS.length); v++) {
      // Schema and version number move together or not at all.
      this.db.exec('BEGIN IMMEDIATE')
      try {
        // Another process may have migrated while this one waited for the lock.
        if (this.version === v) this.db.exec(`${MIGRATIONS[v]}; PRAGMA user_version = ${v + 1}`)
        this.db.exec('COMMIT')
      } catch (err) {
        this.db.exec('ROLLBACK')
        throw err
      }
    }
    if (this.version >= 1) {
      this.db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('next_number', 1), ('created', ?)").run(this.now())
    }
  }

  close() {
    this.statements.clear()
    try {
      this.db.exec('PRAGMA optimize')
      this.db.close()
    } catch {}
  }

  // Prepared once, reused: preparing is most of the cost of a small statement.
  q(sql) {
    let stmt = this.statements.get(sql)
    if (!stmt) this.statements.set(sql, stmt = this.db.prepare(sql))
    return stmt
  }

  // Everything fn does is committed together or not at all. fn must be synchronous.
  // Inside another tx it becomes a savepoint, so a refused step can be caught without losing the rest.
  tx(fn) {
    if (this.depth > 0) {
      const name = `sp${this.depth++}`
      this.db.exec(`SAVEPOINT ${name}`)
      try {
        const out = fn()
        this.db.exec(`RELEASE ${name}`)
        return out
      } catch (err) {
        this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`)
        throw err
      } finally {
        this.depth--
      }
    }
    this.db.exec('BEGIN IMMEDIATE')
    this.depth = 1
    try {
      const out = fn()
      if (out && typeof out.then === 'function') fail('invalid', 'a transaction cannot wait: tx(fn) needs a synchronous fn')
      this.db.exec('COMMIT')
      return out
    } catch (err) {
      try { this.db.exec('ROLLBACK') } catch {}
      throw err
    } finally {
      this.depth = 0
    }
  }

  meta(key) { return this.q('SELECT value FROM meta WHERE key = ?').get(key)?.value }
  setMeta(key, value) { this.q('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value) }

  // ---- the log -------------------------------------------------------------

  // The cursor: the seq of the newest event. A client that has applied everything up to it is up to date.
  cursor() { return this.q('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get().seq }

  dup(sender, clientId) {
    if (clientId == null) return null
    return this.q('SELECT e.seq, e.sender_seq, e.created, e.card_id FROM events e JOIN senders s ON s.n = e.sender WHERE s.id = ? AND e.client_id = ?').get(String(sender), String(clientId)) ?? null
  }
  duplicate(found, extra = {}) {
    return { seq: found.seq, senderSeq: found.sender_seq, created: found.created, duplicate: true, ...extra }
  }

  // The one place a row enters the log. Runs inside the caller's transaction.
  write(e) {
    const senderId = String(e.sender ?? '')
    if (!senderId) fail('invalid', 'sender is required')
    if (!e.type) fail('invalid', 'type is required')
    const clientId = e.clientId == null ? crypto.randomUUID() : String(e.clientId)
    let sender = this.q('SELECT n, last_seq FROM senders WHERE id = ?').get(senderId)
    if (!sender) sender = { n: Number(this.q('INSERT INTO senders (id) VALUES (?)').run(senderId).lastInsertRowid), last_seq: 0 }
    const senderSeq = sender.last_seq + 1
    // A sender that numbers its own messages (signed envelopes) must continue exactly where it left off.
    if (e.senderSeq != null && e.senderSeq !== senderSeq) {
      fail('conflict', `sender ${senderId} is at ${sender.last_seq}; the next number is ${senderSeq}, got ${e.senderSeq}`)
    }
    const created = e.at ?? this.now()
    const { payload, enc } = encode(e)
    const run = this.q(`INSERT INTO events (sender, sender_seq, client_id, type, session, card_id, card_status, answered_at, ref, push,
        created, sent, enc, epoch, payload, size, hash, prev_hash, sig) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sender.n, senderSeq, clientId, String(e.type), e.session ?? null, e.cardId ?? null, e.cardStatus ?? null, e.answeredAt ?? null,
        e.ref ?? null, e.push ? 1 : 0, created, e.sent ?? null, enc, e.epoch ?? 0, payload, payload?.length ?? 0,
        payload ? sha256(payload) : null, e.prevHash ?? null, e.sig ?? null)
    const seq = Number(run.lastInsertRowid)
    this.q('UPDATE senders SET last_seq = ? WHERE n = ?').run(senderSeq, sender.n)
    for (const blob of e.blobs ?? []) {
      if (!this.q('SELECT 1 FROM blobs WHERE id = ?').get(String(blob))) fail('not_found', `no blob ${blob}`)
      this.q('INSERT OR IGNORE INTO event_blobs (seq, blob_id) VALUES (?, ?)').run(seq, String(blob))
    }
    return { seq, senderSeq, created, duplicate: false }
  }

  needSession(id) {
    const row = this.q('SELECT * FROM sessions WHERE id = ?').get(String(id ?? ''))
    if (!row) fail('not_found', `no session ${id}`)
    return row
  }

  // Append an event of a type the store keeps no view of. Idempotent on (sender, clientId):
  // the same pair again returns the first event and changes nothing.
  append(e) {
    if (RESERVED.test(String(e.type ?? ''))) fail('invalid', `events of type ${e.type} are written by their own method, which keeps the view in step`)
    return this.tx(() => {
      const found = this.dup(e.sender, e.clientId)
      if (found) return this.duplicate(found)
      if (e.session != null) this.needSession(e.session)
      return this.write(e)
    })
  }

  // Several appends, one commit.
  appendMany(list) {
    return this.tx(() => list.map(e => this.append(e)))
  }

  // Events after a cursor, oldest first. `more` says whether to ask again with the returned cursor.
  // session: only that session's conversation. Purged events come back with payload null, so numbering has no holes.
  eventsAfter(cursor = 0, { limit = 200, session } = {}) {
    const take = clamp(limit, 200, 1000)
    const after = Number.isInteger(cursor) && cursor > 0 ? cursor : 0
    const rows = session == null
      ? this.q(`${EVENT_SQL} WHERE e.seq > ? ORDER BY e.seq LIMIT ?`).all(after, take + 1)
      : this.q(`${EVENT_SQL} WHERE e.session = ? AND e.seq > ? ORDER BY e.seq LIMIT ?`).all(String(session), after, take + 1)
    const more = rows.length > take
    const events = rows.slice(0, take).map(eventOf)
    return { events, cursor: events.length ? events.at(-1).seq : after, more }
  }

  // The newest events of one conversation before a cursor, newest first: for scrolling back.
  eventsBefore(session, before = null, { limit = 100 } = {}) {
    const take = clamp(limit, 100, 1000)
    const rows = this.q(`${EVENT_SQL} WHERE e.session = ? AND e.seq < ? ORDER BY e.seq DESC LIMIT ?`)
      .all(String(session), before ?? Number.MAX_SAFE_INTEGER, take + 1)
    const events = rows.slice(0, take).map(eventOf)
    return { events, cursor: events.length ? events.at(-1).seq : before, more: rows.length > take }
  }

  // One sender's events after its own number: what a client asks for when it sees a gap in a sender's chain.
  eventsFrom(sender, afterSenderSeq = 0, { limit = 200 } = {}) {
    const take = clamp(limit, 200, 1000)
    const rows = this.q(`${EVENT_SQL} WHERE s.id = ? AND e.sender_seq > ? ORDER BY e.sender_seq LIMIT ?`).all(String(sender), afterSenderSeq, take + 1)
    return { events: rows.slice(0, take).map(eventOf), more: rows.length > take }
  }

  event(seq) { return eventOf(this.q(`${EVENT_SQL} WHERE e.seq = ?`).get(seq)) ?? null }

  // ---- sessions ------------------------------------------------------------

  // Create a session or change what is known about it. profile is merged into the stored one while both are
  // plaintext; an event is written only when something the clients show has changed. Presence is not logged.
  upsertSession(s) {
    const id = String(s.id ?? '')
    if (!id) fail('invalid', 'a session needs an id')
    const sender = s.sender ?? 'hub'
    return this.tx(() => {
      const found = this.dup(sender, s.clientId)
      if (found) return this.duplicate(found, { id })
      const at = s.at ?? this.now()
      const known = this.q('SELECT * FROM sessions WHERE id = ?').get(id)
      let profile, enc
      if (s.payload != null) ({ payload: profile, enc } = encode(s))
      else {
        const before = known && !known.forgotten_at ? decode(known.profile, known.profile_enc) ?? {} : {}
        const merged = { ...before, ...(s.profile ?? {}) }
        profile = Buffer.from(JSON.stringify(merged))
        enc = ENC_JSON
      }
      const archived = s.archived == null ? (known?.archived ?? 0) : s.archived ? 1 : 0
      const changed = !known || known.forgotten_at != null || known.archived !== archived || known.profile_enc !== enc
        || !known.profile || !Buffer.from(known.profile).equals(profile)
      let ev = null
      if (changed) {
        ev = this.write({ sender, clientId: s.clientId, type: known ? 'session.updated' : 'session.joined', ref: id, payload: profile, enc, at })
      }
      if (!known) {
        this.q(`INSERT INTO sessions (id, instance, online, archived, joined, connected, seen, profile, profile_enc, profile_seq)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, s.instance ?? null, s.online ? 1 : 0, archived, s.joined ?? at, s.connected ?? null, s.seen ?? null, profile, enc, ev.seq)
      } else {
        this.q(`UPDATE sessions SET instance = COALESCE(?, instance), online = COALESCE(?, online), archived = ?, forgotten_at = NULL,
            connected = COALESCE(?, connected), seen = COALESCE(?, seen), profile = ?, profile_enc = ?, profile_seq = COALESCE(?, profile_seq) WHERE id = ?`)
          .run(s.instance ?? null, s.online == null ? null : s.online ? 1 : 0, archived, s.connected ?? null, s.seen ?? null, profile, enc, ev?.seq ?? null, id)
      }
      return { id, seq: ev?.seq ?? null, created: !known, changed, duplicate: false }
    })
  }

  // Online or away. Who is online is not part of the log: it is true only for as long as the hub runs.
  setPresence(id, online, { instance, at = this.now() } = {}) {
    const run = online
      ? this.q('UPDATE sessions SET online = 1, connected = ?, seen = ?, instance = COALESCE(?, instance) WHERE id = ?').run(at, at, instance ?? null, String(id))
      : this.q('UPDATE sessions SET online = 0, seen = ? WHERE id = ?').run(at, String(id))
    if (!run.changes) fail('not_found', `no session ${id}`)
  }

  // After a restart of the hub nobody is linked.
  allOffline() { return Number(this.q('UPDATE sessions SET online = 0 WHERE online = 1').run().changes) }

  session(id) { return sessionOf(this.q('SELECT * FROM sessions WHERE id = ? AND forgotten_at IS NULL').get(String(id))) ?? null }

  sessions({ after = '', limit = 200 } = {}) {
    return this.q('SELECT * FROM sessions WHERE forgotten_at IS NULL AND id > ? ORDER BY id LIMIT ?').all(String(after), clamp(limit, 200, 1000)).map(sessionOf)
  }

  // Take a session off the board. Its status lines and waiting notifications go in any case. With data, the
  // content of its conversation goes too: payloads are emptied (headers stay, the log keeps its numbering),
  // cards and messages leave the views, and its files are returned for deletion.
  forgetSession(id, { data = false, sender = 'hub', clientId, at = this.now() } = {}) {
    return this.tx(() => {
      const found = this.dup(sender, clientId)
      if (found) return this.duplicate(found, { messages: 0, cards: 0, files: [] })
      const row = this.needSession(id)
      if (row.forgotten_at != null) fail('not_found', `no session ${id}`)
      if (row.online) fail('conflict', `session ${id} is online; only a session that is away can be forgotten`)
      const gone = { messages: 0, cards: 0, files: [] }
      this.q('DELETE FROM status_lines WHERE session = ?').run(row.id)
      this.q('DELETE FROM deliveries WHERE session = ?').run(row.id)
      if (data) {
        gone.messages = Number(this.q('DELETE FROM messages WHERE session = ?').run(row.id).changes)
        this.q('UPDATE status_lines SET card_id = NULL WHERE card_id IN (SELECT id FROM cards WHERE session = ?)').run(row.id)
        gone.cards = Number(this.q('DELETE FROM cards WHERE session = ?').run(row.id).changes)
        this.q('UPDATE events SET payload = NULL, purged_at = ? WHERE session = ? AND purged_at IS NULL').run(at, row.id)
        this.q('UPDATE events SET payload = NULL, purged_at = ? WHERE seq = ? AND purged_at IS NULL').run(at, row.profile_seq)
        this.q('DELETE FROM canvases WHERE session = ?').run(row.id)
        this.q('UPDATE blobs SET doomed_at = ? WHERE session = ? AND doomed_at IS NULL').run(at, row.id)
        this.q('UPDATE sessions SET messages = 0, profile = NULL WHERE id = ?').run(row.id)
        gone.files = this.q('SELECT id, kind, path, size FROM blobs WHERE session = ? AND doomed_at IS NOT NULL ORDER BY id LIMIT 5000').all(row.id).map(fileOf)
      }
      this.q('UPDATE sessions SET forgotten_at = ?, online = 0 WHERE id = ?').run(at, row.id)
      const ev = this.write({ sender, clientId, type: 'session.forgotten', ref: row.id, body: { data }, at })
      return { ...ev, ...gone }
    })
  }

  // ---- cards ---------------------------------------------------------------

  cardRow(id) {
    const row = this.q('SELECT * FROM cards WHERE id = ?').get(String(id ?? ''))
    if (!row) fail('not_found', `no card ${id}`)
    return row
  }
  // An agent only ever touches its own cards.
  ownCard(id, by) {
    const row = this.cardRow(id)
    if (by != null && row.session !== String(by)) fail('not_found', `no card ${id}`)
    return row
  }
  card(id) { return cardOf(this.q(`${CARD_SQL} WHERE c.id = ?`).get(String(id))) ?? null }

  // Cards of one session or of all, newest number first; `before` pages back by number.
  cards({ session, status, before = null, limit = 100 } = {}) {
    const where = ['c.number < ?']
    const args = [before ?? Number.MAX_SAFE_INTEGER]
    if (session != null) { where.push('c.session = ?'); args.push(String(session)) }
    if (status != null) { where.push('c.status = ?'); args.push(String(status)) }
    return this.q(`${CARD_SQL} WHERE ${where.join(' AND ')} ORDER BY c.number DESC LIMIT ?`).all(...args, clamp(limit, 100, 1000)).map(cardOf)
  }

  // The stack the human works through: approvals first, then by urgency, then oldest first.
  // The questions of an archived session stay open, but are not in the stack.
  openCards({ limit = 500 } = {}) {
    return this.q(`${CARD_SQL} WHERE c.status = 'open'
      ORDER BY (c.kind = 'permission') DESC, ${urgencyRank} DESC, c.created, c.number LIMIT ?`).all(clamp(limit, 500, 5000)).map(cardOf)
  }

  // A new question. kind 'permission' is an approval request: always critical, and one per request_id.
  // urgency null keeps it out of the plaintext (the client then sorts); left out means 'normal'.
  askCard(c) {
    const kind = c.kind ?? 'decision'
    if (!['decision', 'permission'].includes(kind)) fail('invalid', `kind must be decision or permission; got ${JSON.stringify(c.kind)}`)
    const urgency = kind === 'permission' ? 'critical' : c.urgency === undefined ? 'normal' : c.urgency
    if (urgency !== null && !URGENCIES.includes(urgency)) fail('invalid', `urgency must be one of ${URGENCIES.join(', ')}; got ${JSON.stringify(c.urgency)}`)
    const sender = c.sender ?? c.session
    return this.tx(() => {
      const found = this.dup(sender, c.clientId)
      if (found) return this.duplicate(found, { card: this.card(found.card_id) })
      const session = this.needSession(c.session).id
      if (kind === 'permission' && c.requestId != null) {
        // A spoke repeats a request it got no answer for; that must not make a second card.
        const open = this.q("SELECT id, ask_seq FROM cards WHERE session = ? AND kind = 'permission' AND status = 'open' AND request_id = ?").get(session, String(c.requestId))
        if (open) return { seq: open.ask_seq, duplicate: true, card: this.card(open.id) }
      }
      const id = String(c.id ?? newId())
      if (this.q('SELECT 1 FROM cards WHERE id = ?').get(id)) fail('conflict', `card ${id} exists`)
      const next = this.meta('next_number')
      const number = Number.isInteger(c.number) && c.number > 0 ? c.number : next
      this.setMeta('next_number', Math.max(next, number + 1))
      const ev = this.write({
        sender, clientId: c.clientId, type: 'card.asked', session, cardId: id, cardStatus: 'open', blobs: c.blobs,
        body: c.body, payload: c.payload, enc: c.enc, push: c.push ?? true, at: c.at, sent: c.sent,
      })
      this.q(`INSERT INTO cards (id, session, number, kind, status, urgency, request_id, created, ask_seq, last_seq)
        VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`).run(id, session, number, kind, urgency, c.requestId == null ? null : String(c.requestId), ev.created, ev.seq, ev.seq)
      return { ...ev, card: this.card(id) }
    })
  }

  // One step of a card's life: checks that the card allows it, writes the event, moves the view.
  // check gets the row and throws if the step is illegal; step returns the event fields and the new columns.
  // agent: the step is the agent's (close, withdraw, urgency), so without a sender it is the card's session.
  transition(type, a, check, step, agent = false) {
    return this.tx(() => {
      const sender = a.sender ?? a.by ?? (agent ? this.q('SELECT session FROM cards WHERE id = ?').get(String(a.id ?? ''))?.session ?? 'hub' : 'human')
      const found = this.dup(sender, a.clientId)
      // A repeated request gets the answer the first one got, even though the card has moved on since.
      if (found) return this.duplicate(found, { card: found.card_id ? this.card(found.card_id) : null })
      const row = this.ownCard(a.id, a.by)
      check(row)
      const at = a.at ?? this.now()
      const { status = row.status, set = {}, body } = step(row, at)
      const ev = this.write({
        sender, clientId: a.clientId, type, session: row.session, cardId: row.id, cardStatus: status,
        answeredAt: set.answered_at === undefined ? row.answered_at : set.answered_at,
        body: a.payload != null ? undefined : a.body ?? body, payload: a.payload, enc: a.enc, at, sent: a.sent,
      })
      const cols = { status, last_seq: ev.seq, ...set }
      for (const [key, value] of Object.entries(cols)) if (value === SEQ) cols[key] = ev.seq
      const names = Object.keys(cols)
      this.q(`UPDATE cards SET ${names.map(n => `${n} = ?`).join(', ')} WHERE id = ?`).run(...names.map(n => cols[n]), row.id)
      const out = { ...ev, card: this.card(row.id) }
      if (a.deliver) this.deliverWith(a.deliver, row.session, out)
      return out
    })
  }

  // The human's answer. A decision becomes 'decided' and waits for the agent to act on it; an approval is done
  // at once. Status lines that waited on the card turn to 'working'. deliver: a notification for the session,
  // queued in the same transaction, so an answer can never be stored without its notification.
  answerCard(a) {
    return this.tx(() => {
      const out = this.transition('card.answered', a, row => {
        if (row.status !== 'open') fail('illegal', `card ${row.id} is ${row.status}; only an open card can be answered`)
        // While the question is plaintext the store can tell an option that was never offered.
        const ask = this.q('SELECT payload, enc FROM events WHERE seq = ?').get(row.ask_seq)
        const asked = decode(ask?.payload, ask?.enc)
        const keys = Array.isArray(asked?.options) ? asked.options.map(o => o?.key) : []
        if (a.choice != null && keys.length && !keys.includes(a.choice)) fail('invalid', `card ${row.id} has no option ${JSON.stringify(a.choice)}`)
      }, (row, at) => ({
        status: row.kind === 'permission' ? 'done' : 'decided',
        set: { answered_at: at, answer_seq: SEQ, ...(row.kind === 'permission' ? { closed_as: 'answered', closed_at: at } : {}) },
        body: { choice: a.choice ?? null, note: a.note ?? '' },
      }))
      if (!out.duplicate) {
        this.q("UPDATE status_lines SET state = 'working', card_id = NULL, updated = ? WHERE session = ? AND card_id = ? AND state = 'decision'")
          .run(out.created, out.card.session, out.card.id)
      }
      return out
    })
  }

  // The human takes an answer back; the card returns to the stack. Not for approvals, and not for a card the
  // agent withdrew (it was never answered).
  reopenCard(a) {
    let previous
    const out = this.transition('card.reopened', a, row => {
      if (row.kind !== 'decision') fail('illegal', 'only decisions can be reopened')
      if (row.status === 'open') fail('illegal', `card ${row.id} is already open`)
      if (row.answered_at == null) fail('illegal', `card ${row.id} was withdrawn by the agent, not answered`)
      const answer = this.q('SELECT payload, enc FROM events WHERE seq = ?').get(row.answer_seq)
      previous = decode(answer?.payload, answer?.enc) ?? null
    }, () => ({
      status: 'open',
      set: { answered_at: null, closed_at: null, closed_as: null, answer_seq: null, close_seq: null },
      body: { previous_choice: previous?.choice ?? null },
    }))
    return out.duplicate ? out : { ...out, previous }
  }

  // The agent has acted on the answer. Also closes an open decision the agent no longer needs answered,
  // as server.mjs allows today; an open approval is the human's alone.
  closeCard(a) {
    return this.transition('card.closed', a, row => {
      if (row.kind === 'permission' && row.status === 'open') fail('illegal', 'an open permission card cannot be closed; only the human answers it')
    }, (row, at) => ({ status: 'done', set: { closed_as: 'closed', closed_at: at, close_seq: SEQ }, body: { summary: a.summary ?? '' } }), true)
  }

  // The question became moot before it was answered.
  withdrawCard(a) {
    return this.transition('card.withdrawn', a, row => {
      if (row.kind === 'permission') fail('illegal', 'permission cards cannot be withdrawn')
      if (row.status === 'decided') fail('illegal', `card ${row.id} was already decided; act on the answer or close it`)
      if (row.status !== 'open') fail('illegal', `card ${row.id} is already done`)
    }, (row, at) => ({ status: 'done', set: { closed_as: 'withdrawn', closed_at: at, close_seq: SEQ }, body: { reason: a.reason ?? '' } }), true)
  }

  setUrgency(a) {
    if (!URGENCIES.includes(a.urgency)) fail('invalid', `urgency must be one of ${URGENCIES.join(', ')}; got ${JSON.stringify(a.urgency)}`)
    return this.transition('card.urgency', a, row => {
      if (row.kind === 'permission') fail('illegal', 'permission cards are always critical')
      if (row.status !== 'open') fail('illegal', `card ${row.id} is ${row.status}; urgency only applies to open cards`)
    }, row => ({ set: { urgency: a.urgency, urgency_seq: SEQ }, body: { urgency: a.urgency, reason: a.reason ?? '', changed: row.urgency !== a.urgency } }), true)
  }

  // A marker in a card's timeline that changes nothing about its state. Used by the import for history that
  // today's state file keeps only as conversation markers (earlier answers, reopenings, urgency changes).
  noteCard(a) {
    return this.transition('card.note', a, () => {}, () => ({ body: a.body }), true)
  }

  // An approval request dies with the session that asked: nobody is waiting for the answer any more.
  expireCard(a) {
    return this.transition('card.expired', { sender: 'hub', ...a }, row => {
      if (row.kind !== 'permission' || row.status !== 'open') fail('illegal', `card ${row.id} is not an open approval request`)
    }, (row, at) => ({ status: 'done', set: { closed_as: 'expired', closed_at: at, close_seq: SEQ }, body: { summary: a.summary ?? 'Session ended before the approval was answered' } }))
  }

  // All open approval requests of a session, when its link drops.
  expirePermissions(session, { summary, at } = {}) {
    return this.tx(() => {
      const open = this.q("SELECT id FROM cards WHERE session = ? AND kind = 'permission' AND status = 'open' LIMIT 1000").all(String(session))
      for (const { id } of open) this.expireCard({ id, summary, at })
      return open.length
    })
  }

  // ---- messages ------------------------------------------------------------

  // A chat message in one session's conversation, from the human ('user') or the agent.
  postMessage(m) {
    if (!['user', 'agent'].includes(m.from)) fail('invalid', `from must be user or agent; got ${JSON.stringify(m.from)}`)
    const sender = m.sender ?? (m.from === 'agent' ? m.session : 'human')
    return this.tx(() => {
      const found = this.dup(sender, m.clientId)
      if (found) return this.duplicate(found, { id: this.q('SELECT id FROM messages WHERE seq = ?').get(found.seq)?.id ?? null })
      const session = this.needSession(m.session).id
      const id = String(m.id ?? newId())
      if (this.q('SELECT 1 FROM messages WHERE id = ?').get(id)) fail('conflict', `message ${id} exists`)
      const ev = this.write({
        sender, clientId: m.clientId, type: 'message', session, ref: id, blobs: m.blobs, push: m.push ?? false,
        body: m.body, payload: m.payload, enc: m.enc, at: m.at, sent: m.sent,
      })
      this.q('INSERT INTO messages (id, seq, session, origin, created) VALUES (?, ?, ?, ?, ?)').run(id, ev.seq, session, m.from, ev.created)
      this.q('UPDATE sessions SET messages = messages + 1 WHERE id = ?').run(session)
      const out = { ...ev, id }
      if (m.deliver) this.deliverWith(m.deliver, session, out)
      return out
    })
  }

  // The messages of one conversation, newest first; `before` pages back by seq.
  messages(session, { before = null, limit = 100 } = {}) {
    return this.q(`SELECT m.id, m.origin, e.seq, e.created, e.payload, e.enc, e.purged_at FROM messages m JOIN events e ON e.seq = m.seq
      WHERE m.session = ? AND m.seq < ? ORDER BY m.seq DESC LIMIT ?`).all(String(session), before ?? Number.MAX_SAFE_INTEGER, clamp(limit, 100, 1000))
      .map(r => ({ id: r.id, from: r.origin, seq: r.seq, created: r.created, body: decode(r.payload, r.enc), payload: r.payload, enc: r.enc, purged: r.purged_at != null }))
  }

  // ---- status lines --------------------------------------------------------

  // One line of a session's status strip. label and detail are content: they live in the payload. state and
  // card_id are plaintext for now, because the hub turns a waiting line yellow when its card is answered.
  setStatus(t) {
    const id = String(t.id ?? '').trim()
    if (!id) fail('invalid', 'id is required')
    if (!STATUS_STATES.includes(t.state)) fail('invalid', `state must be one of ${STATUS_STATES.join(', ')}; got ${JSON.stringify(t.state)}`)
    const sender = t.sender ?? t.session
    return this.tx(() => {
      const found = this.dup(sender, t.clientId)
      if (found) return this.duplicate(found)
      const session = this.needSession(t.session).id
      // Checked before anything changes, so a refused call leaves no half-made line behind.
      if (t.cardId != null) this.ownCard(t.cardId, session)
      const known = this.q('SELECT * FROM status_lines WHERE session = ? AND id = ?').get(session, id)
      let payload, enc
      if (t.payload != null) ({ payload, enc } = encode(t))
      else {
        const before = decode(known?.payload, known?.enc) ?? {}
        if (!known && !t.label) fail('invalid', `label is required for the new status line "${id}"`)
        const line = { label: t.label ? String(t.label) : before.label ?? '', detail: t.detail != null ? String(t.detail) : before.detail ?? '', state: t.state }
        payload = Buffer.from(JSON.stringify(line))
        enc = ENC_JSON
      }
      const cardId = t.state === 'decision' ? t.cardId ?? known?.card_id ?? null : null
      const ev = this.write({ sender, clientId: t.clientId, type: 'status.set', session, ref: id, cardId, payload, enc, at: t.at })
      this.q(`INSERT INTO status_lines (session, id, state, card_id, updated, seq, payload, enc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (session, id) DO UPDATE SET state = excluded.state, card_id = excluded.card_id, updated = excluded.updated,
          seq = excluded.seq, payload = excluded.payload, enc = excluded.enc`).run(session, id, t.state, cardId, ev.created, ev.seq, payload, enc)
      return ev
    })
  }

  // Remove one line, or all lines of the session when no id is given.
  clearStatus({ session, id, sender = session, clientId, at } = {}) {
    return this.tx(() => {
      const found = this.dup(sender, clientId)
      if (found) return this.duplicate(found, { removed: 0 })
      const owner = this.needSession(session).id
      const removed = id == null
        ? this.q('DELETE FROM status_lines WHERE session = ?').run(owner).changes
        : this.q('DELETE FROM status_lines WHERE session = ? AND id = ?').run(owner, String(id)).changes
      const ev = this.write({ sender, clientId, type: 'status.cleared', session: owner, ref: id == null ? null : String(id), at })
      return { ...ev, removed: Number(removed) }
    })
  }

  statusLines({ session, limit = 500 } = {}) {
    const rows = session == null
      ? this.q('SELECT * FROM status_lines ORDER BY session, updated LIMIT ?').all(clamp(limit, 500, 2000))
      : this.q('SELECT * FROM status_lines WHERE session = ? ORDER BY updated LIMIT ?').all(String(session), clamp(limit, 500, 2000))
    return rows.map(statusOf)
  }

  // ---- delivery queue ------------------------------------------------------

  // A notification for a session. It stays until the session has acknowledged it, across restarts of the hub.
  // dedupe: a key that makes a repeated enqueue a no-op.
  enqueue(session, method, params, { at = this.now(), dedupe = null, eventSeq = null, max = QUEUE_MAX, payload, enc } = {}) {
    if (typeof method !== 'string' || !method) fail('invalid', 'method is required')
    return this.tx(() => {
      const owner = this.needSession(session).id
      if (dedupe != null) {
        const known = this.q('SELECT id FROM deliveries WHERE dedupe = ?').get(String(dedupe))
        if (known) return { id: known.id, duplicate: true }
      }
      const content = encode(payload != null ? { payload, enc } : { body: params ?? null })
      const id = Number(this.q('INSERT INTO deliveries (session, method, params, enc, event_seq, dedupe, created) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(owner, method, content.payload, content.enc, eventSeq, dedupe == null ? null : String(dedupe), at).lastInsertRowid)
      // Older ones give way to newer ones, as today.
      this.q('DELETE FROM deliveries WHERE session = ? AND id NOT IN (SELECT id FROM deliveries WHERE session = ? ORDER BY id DESC LIMIT ?)').run(owner, owner, clamp(max, QUEUE_MAX, 10000))
      return { id, duplicate: false }
    })
  }
  deliverWith(deliver, session, out) {
    const d = typeof deliver === 'function' ? deliver(out) : deliver
    if (!d) return
    out.delivery = this.enqueue(d.session ?? session, d.method, d.params, { at: out.created, eventSeq: out.seq, dedupe: d.dedupe }).id
  }

  // What waits for a session, oldest first, marked as handed over. Nothing leaves the queue here: an entry that
  // was handed over but never acknowledged (the hub or the link died in between) is handed over again next time.
  handOver(session, { limit = 50, at = this.now() } = {}) {
    return this.tx(() => {
      const rows = this.q('SELECT * FROM deliveries WHERE session = ? ORDER BY id LIMIT ?').all(String(session), clamp(limit, 50, 1000))
      for (const r of rows) this.q('UPDATE deliveries SET handed_at = ?, attempts = attempts + 1 WHERE id = ?').run(at, r.id)
      return rows.map(r => deliveryOf({ ...r, handed_at: at, attempts: r.attempts + 1 }))
    })
  }

  // The session has the notification; forget it.
  acknowledge(ids) {
    const list = [ids].flat()
    return this.tx(() => list.reduce((n, id) => n + Number(this.q('DELETE FROM deliveries WHERE id = ?').run(id).changes), 0))
  }

  queued(session) { return this.q('SELECT COUNT(*) AS n FROM deliveries WHERE session = ?').get(String(session)).n }
  clearQueue(session) { return Number(this.q('DELETE FROM deliveries WHERE session = ?').run(String(session)).changes) }

  // ---- blobs ---------------------------------------------------------------

  // Record a file that lives outside the database: an attachment, an asset, a scribble, a canvas, a pad image.
  // The store never reads or writes the file; path is relative to the data directory. Registering the same id
  // again returns the first record.
  registerBlob(b) {
    const id = String(b.id ?? '')
    if (!id) fail('invalid', 'a blob needs an id')
    if (!BLOB_KINDS.includes(b.kind)) fail('invalid', `kind must be one of ${BLOB_KINDS.join(', ')}; got ${JSON.stringify(b.kind)}`)
    const retention = b.retention ?? (b.kind === 'asset' ? 'age' : ['canvas', 'pad'].includes(b.kind) ? 'owner' : 'refs')
    if (!RETENTIONS.includes(retention)) fail('invalid', `retention must be one of ${RETENTIONS.join(', ')}`)
    const file = blobPath(b.path)
    return this.tx(() => {
      const known = this.q('SELECT * FROM blobs WHERE id = ?').get(id)
      if (known) return { ...blobOf(known), duplicate: true }
      if (this.q('SELECT 1 FROM blobs WHERE path = ?').get(file)) fail('conflict', `another blob already uses ${file}`)
      if (b.session != null) this.needSession(b.session)
      const meta = b.metaPayload != null ? { payload: b.metaPayload, enc: b.metaEnc ?? ENC_SEALED } : encode({ body: b.meta })
      this.q(`INSERT INTO blobs (id, kind, path, size, sha256, session, retention, created, meta, meta_enc, wrapped_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, b.kind, file, b.size ?? null, b.sha256 ?? null, b.session ?? null, retention,
        b.at ?? this.now(), meta.payload, meta.enc, b.wrappedKey ?? null)
      return { ...blobOf(this.q('SELECT * FROM blobs WHERE id = ?').get(id)), duplicate: false }
    })
  }

  blob(id) { return blobOf(this.q('SELECT * FROM blobs WHERE id = ?').get(String(id))) ?? null }

  blobs({ kind, session, after = '', limit = 200 } = {}) {
    const where = ['id > ?', 'doomed_at IS NULL']
    const args = [String(after)]
    if (kind != null) { where.push('kind = ?'); args.push(String(kind)) }
    if (session != null) { where.push('session = ?'); args.push(String(session)) }
    return this.q(`SELECT * FROM blobs WHERE ${where.join(' AND ')} ORDER BY id LIMIT ?`).all(...args, clamp(limit, 200, 1000)).map(blobOf)
  }

  // End a blob now (revoke_asset, a deleted pad image). The events that showed it lose their payload, and with
  // it the hub forgets whatever key the payload carried. Returns the file to delete.
  revokeBlob(id, { by, at = this.now() } = {}) {
    return this.tx(() => {
      const row = this.q('SELECT * FROM blobs WHERE id = ? AND doomed_at IS NULL').get(String(id))
      if (!row || (by != null && row.session !== String(by))) fail('not_found', `no blob ${id}`)
      this.q('UPDATE events SET payload = NULL, purged_at = ? WHERE purged_at IS NULL AND seq IN (SELECT seq FROM event_blobs WHERE blob_id = ?)').run(at, row.id)
      this.q('UPDATE blobs SET doomed_at = ? WHERE id = ?').run(at, row.id)
      return fileOf(row)
    })
  }

  // Files the store has given up but whose deletion nobody confirmed yet: what to retry after a crash.
  doomedFiles({ limit = 500 } = {}) {
    return this.q('SELECT id, kind, path, size, session FROM blobs WHERE doomed_at IS NOT NULL ORDER BY doomed_at, id LIMIT ?').all(clamp(limit, 500, 5000))
  }

  // The caller has deleted the files; drop their records.
  confirmDeleted(ids) {
    return this.tx(() => {
      let n = 0
      for (const id of [ids].flat()) {
        if (!this.q('SELECT 1 FROM blobs WHERE id = ? AND doomed_at IS NOT NULL').get(String(id))) continue
        this.q('DELETE FROM event_blobs WHERE blob_id = ?').run(String(id))
        if (this.version >= 2) this.q('UPDATE pad_elements SET blob_id = NULL WHERE blob_id = ?').run(String(id))
        this.q('UPDATE canvases SET doc_blob = NULL WHERE doc_blob = ?').run(String(id))
        this.q('UPDATE canvases SET image_blob = NULL WHERE image_blob = ?').run(String(id))
        n += Number(this.q('DELETE FROM blobs WHERE id = ?').run(String(id)).changes)
      }
      return n
    })
  }

  // ---- retention -----------------------------------------------------------

  // Delete what is past retention:
  //   - cards that are not open and were answered (or, never answered, created) more than `days` ago: the card
  //     leaves the view, every event of the card loses its payload, status lines stop pointing at it
  //   - notifications that waited longer than that for a session that never came back
  //   - assets (retention 'age') published longer ago than that, unless kept; the message that showed the link
  //     loses its payload, and with it the key
  //   - optionally chat messages older than messageDays (today's server keeps them for ever: null)
  //   - files no live event points to any more, and pad elements deleted longer ago than that
  // Open cards are never touched. At most `limit` cards per call; `more` says to call again.
  // Returns counts and `files`: what the caller must delete from disk, then confirm with confirmDeleted().
  // dryRun does all of it and rolls back: the same numbers, nothing changed.
  purge({ days = 30, messageDays = null, limit = 500, dryRun = false, at = this.now() } = {}) {
    const take = clamp(limit, 500, 5000)
    const cutoff = at - days * DAY
    const out = { cutoff, cards: 0, events: 0, messages: 0, deliveries: 0, assets: 0, elements: 0, files: [], more: false }
    const DRY = Symbol('dry')
    const emptied = run => { out.events += Number(run.changes) }
    try {
      this.tx(() => {
        out.deliveries = Number(this.q('DELETE FROM deliveries WHERE created < ?').run(cutoff).changes)

        const assets = this.q("SELECT id FROM blobs WHERE retention = 'age' AND created < ? AND doomed_at IS NULL ORDER BY created LIMIT ?").all(cutoff, take)
        for (const { id } of assets) {
          emptied(this.q('UPDATE events SET payload = NULL, purged_at = ? WHERE purged_at IS NULL AND seq IN (SELECT seq FROM event_blobs WHERE blob_id = ?)').run(at, id))
          this.q('UPDATE blobs SET doomed_at = ? WHERE id = ?').run(at, id)
        }
        out.assets = assets.length

        const old = this.q("SELECT id FROM cards WHERE status != 'open' AND COALESCE(answered_at, created) < ? ORDER BY created LIMIT ?").all(cutoff, take + 1)
        out.more = old.length > take || assets.length === take
        for (const { id } of old.slice(0, take)) {
          emptied(this.q("UPDATE events SET payload = NULL, purged_at = ? WHERE card_id = ? AND type GLOB 'card.*' AND purged_at IS NULL").run(at, id))
          this.q('UPDATE status_lines SET card_id = NULL WHERE card_id = ?').run(id)
          this.q('DELETE FROM cards WHERE id = ?').run(id)
          out.cards++
        }

        if (messageDays != null) {
          const before = at - messageDays * DAY
          const stale = this.q('SELECT id, seq, session FROM messages WHERE created < ? ORDER BY seq LIMIT ?').all(before, take + 1)
          if (stale.length > take) out.more = true
          for (const m of stale.slice(0, take)) {
            emptied(this.q('UPDATE events SET payload = NULL, purged_at = ? WHERE seq = ? AND purged_at IS NULL').run(at, m.seq))
            this.q('DELETE FROM messages WHERE id = ?').run(m.id)
            this.q('UPDATE sessions SET messages = MAX(0, messages - 1) WHERE id = ?').run(m.session)
            out.messages++
          }
        }

        if (this.version >= 2) {
          const gone = this.q('SELECT id, blob_id FROM pad_elements WHERE deleted_at IS NOT NULL AND deleted_at < ? LIMIT ?').all(cutoff, take)
          for (const el of gone) {
            this.q('DELETE FROM pad_links WHERE element = ?').run(el.id)
            this.q('DELETE FROM pad_elements WHERE id = ?').run(el.id)
            // Its file was kept for an undo; it goes with the tombstone, unless another element shows it too.
            if (el.blob_id && !this.q('SELECT 1 FROM pad_elements WHERE blob_id = ?').get(el.blob_id)) {
              this.q("UPDATE blobs SET doomed_at = ? WHERE id = ? AND doomed_at IS NULL AND retention = 'owner'").run(at, el.blob_id)
            }
          }
          out.elements = gone.length
        }

        // A file goes when the last event that showed it has been emptied, or when nothing ever pointed to it
        // and it is older than the retention (a registration that never made it into a message).
        this.q(`UPDATE blobs SET doomed_at = ? WHERE doomed_at IS NULL AND retention = 'refs'
          AND NOT EXISTS (SELECT 1 FROM event_blobs eb JOIN events e ON e.seq = eb.seq WHERE eb.blob_id = blobs.id AND e.purged_at IS NULL)
          AND (EXISTS (SELECT 1 FROM event_blobs eb WHERE eb.blob_id = blobs.id) OR created < ?)`).run(at, cutoff)
        out.files = this.q('SELECT id, kind, path, size FROM blobs WHERE doomed_at = ? ORDER BY id LIMIT ?').all(at, 5000).map(fileOf)
        if (dryRun) throw DRY
      })
    } catch (err) {
      if (err !== DRY) throw err
    }
    return out
  }

  // ---- canvases ------------------------------------------------------------

  // The lasting canvas of a session: two files (the drawing and its picture), a version that only goes up.
  // Pass version to refuse a save that is older than what is stored (two devices drawing at once).
  saveCanvas({ session, doc, image, version, by = 'human', clientId, at } = {}) {
    return this.tx(() => {
      const found = this.dup(by, clientId)
      if (found) return this.duplicate(found, { version: this.q('SELECT version FROM canvases WHERE session = ?').get(String(session))?.version ?? 0 })
      const owner = this.needSession(session).id
      const known = this.q('SELECT * FROM canvases WHERE session = ?').get(owner)
      const next = version ?? (known?.version ?? 0) + 1
      if (known && next <= known.version) fail('conflict', `canvas of ${owner} is at version ${known.version}; refusing version ${next}`)
      for (const id of [doc, image]) if (id != null && !this.q('SELECT 1 FROM blobs WHERE id = ?').get(String(id))) fail('not_found', `no blob ${id}`)
      const ev = this.write({ sender: by, clientId, type: 'canvas.saved', session: owner, body: { version: next }, at })
      this.q(`INSERT INTO canvases (session, version, doc_blob, image_blob, updated, updated_by) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (session) DO UPDATE SET version = excluded.version, doc_blob = COALESCE(excluded.doc_blob, doc_blob),
          image_blob = COALESCE(excluded.image_blob, image_blob), updated = excluded.updated, updated_by = excluded.updated_by`)
        .run(owner, next, doc ?? null, image ?? null, ev.created, by)
      return { ...ev, version: next }
    })
  }

  canvas(session) {
    const r = this.q('SELECT * FROM canvases WHERE session = ?').get(String(session))
    return r ? { session: r.session, version: r.version, doc: r.doc_blob, image: r.image_blob, updated: r.updated, updatedBy: r.updated_by } : null
  }

  // ---- the pad -------------------------------------------------------------

  // Create or change one element of a pad. The record has the shape client/web/pad uses: geometry, stacking
  // order and group are columns, so a client can ask for what is in view; what the element is (points of a
  // stroke, text, caption of a voice note) is `data`, stored as the payload.
  // rev: the client's revision; it must be newer than the stored one, or the write is refused as stale.
  // Left out, the store counts up. ifRev: change only if the stored revision is exactly this one.
  // A deleted element comes back when it is put again with a newer revision and its data: that is what
  // undoing a delete is. "updated" is always the hub's time, whatever the client's clock says.
  putElement(el) {
    const pad = String(el.pad ?? 'global')
    const sender = el.sender ?? el.author
    return this.tx(() => {
      const found = this.dup(sender, el.clientId)
      if (found) return this.duplicate(found, { element: this.element(this.q('SELECT ref FROM events WHERE seq = ?').get(found.seq).ref) })
      const id = String(el.id ?? newId(8))
      const known = this.q('SELECT * FROM pad_elements WHERE id = ?').get(id)
      const at = el.at ?? this.now()
      const back = known?.deleted_at != null
      if (back && !(el.rev != null && el.rev > known.rev)) fail('not_found', `no element ${id}`)
      if (back && el.payload == null && el.data === undefined) fail('invalid', `element ${id} was deleted; bringing it back needs its data`)
      if (known && el.ifRev != null && el.ifRev !== known.rev) fail('conflict', `element ${id} is at revision ${known.rev}, not ${el.ifRev}`)
      if (known && el.rev != null && el.rev <= known.rev) fail('conflict', `element ${id} is at revision ${known.rev}; revision ${el.rev} is stale`)
      if (!known) {
        if (!ELEMENT_TYPES.includes(el.type)) fail('invalid', `type must be one of ${ELEMENT_TYPES.join(', ')}; got ${JSON.stringify(el.type)}`)
        if (!el.author) fail('invalid', 'author is required')
      } else if (el.type != null && el.type !== known.type) fail('invalid', `element ${id} is a ${known.type}; an element does not change its type`)
      if (el.blob != null && !this.q('SELECT 1 FROM blobs WHERE id = ? AND doomed_at IS NULL').get(String(el.blob))) fail('not_found', `no blob ${el.blob}`)
      this.q('INSERT OR IGNORE INTO pads (id, created) VALUES (?, ?)').run(pad, at)
      const rev = el.rev ?? (known?.rev ?? 0) + 1
      const ev = this.write({ sender, clientId: el.clientId, type: 'pad.put', ref: id, body: { pad, rev }, at })
      const content = el.payload != null || el.data !== undefined ? encode({ payload: el.payload, enc: el.enc, body: el.data }) : { payload: known?.payload ?? null, enc: known?.enc ?? ENC_JSON }
      const num = (value, old, fallback = 0) => (value == null ? old ?? fallback : Number(value))
      if (!known) {
        const z = el.z ?? this.q('SELECT COALESCE(MAX(z), 0) + 1 AS z FROM pad_elements WHERE pad = ?').get(pad).z
        this.q(`INSERT INTO pad_elements (id, pad, type, grp, x, y, w, h, rotation, z, author, created, updated, rev, blob_id, payload, enc, seq)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, pad, el.type, el.group ?? null, num(el.x), num(el.y), num(el.w), num(el.h), num(el.rotation), z,
          String(el.author), el.created ?? at, at, rev, el.blob ?? null, content.payload, content.enc, ev.seq)
      } else {
        this.q('UPDATE pad_elements SET deleted_at = NULL, grp = ?, x = ?, y = ?, w = ?, h = ?, rotation = ?, z = ?, updated = ?, rev = ?, blob_id = ?, payload = ?, enc = ?, seq = ? WHERE id = ?')
          .run(el.group === undefined ? known.grp : el.group, num(el.x, known.x), num(el.y, known.y), num(el.w, known.w), num(el.h, known.h), num(el.rotation, known.rotation), el.z ?? known.z,
            at, rev, el.blob === undefined ? known.blob_id : el.blob, content.payload, content.enc, ev.seq, id)
      }
      return { ...ev, element: this.element(id) }
    })
  }

  // One element; with deleted: true also its tombstone, if that is all that is left of it.
  element(id, { deleted = false } = {}) {
    const row = this.q('SELECT * FROM pad_elements WHERE id = ?').get(String(id))
    return row && (deleted || row.deleted_at == null) ? elementOf(row) : null
  }

  // Elements of a pad in stacking order, bottom first. box [x0, y0, x1, y1]: only what touches that rectangle.
  // after [z, id]: the page after that element. sinceSeq instead: what changed after a cursor, tombstones of
  // deleted elements included, so another device learns of a deletion.
  elements({ pad = 'global', box, after, sinceSeq, limit = 500 } = {}) {
    const take = clamp(limit, 500, 2000)
    if (sinceSeq != null) {
      return this.q('SELECT * FROM pad_elements WHERE pad = ? AND seq > ? ORDER BY seq LIMIT ?').all(String(pad), sinceSeq, take).map(elementOf)
    }
    const where = ['pad = ?', 'deleted_at IS NULL']
    const args = [String(pad)]
    if (after) { where.push('(z, id) > (?, ?)'); args.push(after[0], String(after[1])) }
    if (box) { where.push('x <= ? AND x + w >= ? AND y <= ? AND y + h >= ?'); args.push(box[2], box[0], box[3], box[1]) }
    return this.q(`SELECT * FROM pad_elements WHERE ${where.join(' AND ')} ORDER BY z, id LIMIT ?`).all(...args, take).map(elementOf)
  }

  // Take an element off the pad. Its row stays as a tombstone until the purge, so other devices learn of it
  // and so the delete can be undone (putElement with a newer revision); its file stays as long as the tombstone.
  // rev: the revision the delete counts as; it must be newer than the stored one. Left out, the next one.
  deleteElement(id, { by = 'human', clientId, at, rev } = {}) {
    return this.tx(() => {
      const found = this.dup(by, clientId)
      if (found) return this.duplicate(found)
      const row = this.q('SELECT * FROM pad_elements WHERE id = ? AND deleted_at IS NULL').get(String(id))
      if (!row) fail('not_found', `no element ${id}`)
      if (rev != null && rev <= row.rev) fail('conflict', `element ${id} is at revision ${row.rev}; revision ${rev} is stale`)
      const ev = this.write({ sender: by, clientId, type: 'pad.deleted', ref: row.id, body: { pad: row.pad }, at })
      this.q('UPDATE pad_elements SET deleted_at = ?, updated = ?, rev = ?, payload = NULL, seq = ? WHERE id = ?').run(ev.created, ev.created, rev ?? row.rev + 1, ev.seq, row.id)
      return { ...ev, element: elementOf(this.q('SELECT * FROM pad_elements WHERE id = ?').get(row.id)) }
    })
  }

  // Send chosen elements to a session: one event that names them, one link per element (so the pad can show
  // what went where and in which revision), and optionally the notification for the agent, all in one commit.
  sendElements({ ids, session, by = 'human', body, clientId, deliver, at } = {}) {
    const list = [...new Set([ids].flat().map(String))]
    if (!list.length || list.length > 500) fail('invalid', 'send between 1 and 500 elements at a time')
    return this.tx(() => {
      const found = this.dup(by, clientId)
      if (found) return this.duplicate(found, { elements: [] })
      const target = this.needSession(session).id
      const elements = list.map(id => this.element(id) ?? fail('not_found', `no element ${id}`))
      const ev = this.write({
        sender: by, clientId, type: 'pad.sent', session: target, push: false, at,
        body: { ...(body ?? {}), elements: elements.map(e => ({ id: e.id, rev: e.rev })) },
      })
      for (const e of elements) {
        this.q('INSERT INTO pad_links (element, session, seq, rev, sent_at, sent_by) VALUES (?, ?, ?, ?, ?, ?)').run(e.id, target, ev.seq, e.rev, ev.created, String(by))
        // Not a new revision, but news about the element: a device that catches up by seq learns where it went.
        this.q('UPDATE pad_elements SET seq = ? WHERE id = ?').run(ev.seq, e.id)
      }
      const out = { ...ev, elements: elements.map(e => ({ ...e, seq: ev.seq })) }
      if (deliver) this.deliverWith(deliver, target, out)
      return out
    })
  }

  // Where an element was sent, newest first; or what a session was sent.
  elementLinks({ element, session, limit = 200 } = {}) {
    const take = clamp(limit, 200, 1000)
    const rows = element != null
      ? this.q('SELECT * FROM pad_links WHERE element = ? ORDER BY seq DESC LIMIT ?').all(String(element), take)
      : this.q('SELECT * FROM pad_links WHERE session = ? ORDER BY seq DESC LIMIT ?').all(String(session ?? ''), take)
    return rows.map(r => ({ element: r.element, session: r.session, seq: r.seq, rev: r.rev, sentAt: r.sent_at, sentBy: r.sent_by }))
  }

  // ---- members and keys ----------------------------------------------------

  // Append to the signed member list. The store checks only what a log needs: the number is the next one and
  // the entry names its predecessor. Whether the signature holds is for the hub's verifier and for every client.
  appendMember(m) {
    if (!isBytes(m.entry)) fail('invalid', 'entry must be the signed bytes')
    return this.tx(() => {
      const last = this.q('SELECT n, hash FROM member_log ORDER BY n DESC LIMIT 1').get()
      const n = (last?.n ?? 0) + 1
      if (m.n != null && m.n !== n) fail('conflict', `the member list is at ${last?.n ?? 0}; the next entry is ${n}, got ${m.n}`)
      if (last ? !(m.prevHash && Buffer.from(m.prevHash).equals(Buffer.from(last.hash))) : m.prevHash != null) {
        fail('conflict', `entry ${n} does not name entry ${n - 1} as its predecessor`)
      }
      if (n === 1 && m.kind !== 'founding') fail('illegal', 'the first entry is the founding entry')
      if (n > 1 && m.kind === 'founding') fail('illegal', 'a room is founded once')
      const hash = sha256(m.entry)
      this.q('INSERT INTO member_log (n, prev_hash, hash, kind, device, role, epoch, signer, entry, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(n, m.prevHash ?? null, hash, m.kind, m.device ?? null, m.role ?? null, m.epoch ?? null, String(m.signer), m.entry, m.at ?? this.now())
      if (m.kind === 'founding' || m.kind === 'add') {
        if (this.q('SELECT 1 FROM devices WHERE id = ?').get(String(m.device))) fail('conflict', `device ${m.device} is already a member`)
        this.q('INSERT INTO devices (id, role, session, sign_pub, kex_pub, added_n) VALUES (?, ?, ?, ?, ?, ?)')
          .run(String(m.device), m.role, m.session ?? null, m.signPub ?? null, m.kexPub ?? null, n)
      } else if (m.kind === 'remove') {
        if (!this.q('UPDATE devices SET removed_n = ? WHERE id = ? AND removed_n IS NULL').run(n, String(m.device)).changes) fail('not_found', `no member ${m.device}`)
      }
      return { n, hash }
    })
  }

  memberLog({ after = 0, limit = 200 } = {}) {
    return this.q('SELECT * FROM member_log WHERE n > ? ORDER BY n LIMIT ?').all(after, clamp(limit, 200, 1000))
      .map(r => ({ n: r.n, prevHash: r.prev_hash, hash: r.hash, kind: r.kind, device: r.device, role: r.role, epoch: r.epoch, signer: r.signer, entry: r.entry, created: r.created }))
  }

  devices({ limit = 500 } = {}) {
    return this.q('SELECT * FROM devices ORDER BY added_n LIMIT ?').all(clamp(limit, 500, 2000))
      .map(r => ({ id: r.id, role: r.role, session: r.session, signPub: r.sign_pub, kexPub: r.kex_pub, addedN: r.added_n, removedN: r.removed_n, member: r.removed_n == null }))
  }

  // A room key sealed for one recipient. The hub stores it and cannot open it.
  putWrappedKey({ epoch, recipient, kind = 'member', wrapped, at = this.now() }) {
    if (!isBytes(wrapped)) fail('invalid', 'wrapped must be bytes')
    this.q('INSERT INTO wrapped_keys (epoch, recipient, kind, wrapped, created) VALUES (?, ?, ?, ?, ?) ON CONFLICT (epoch, recipient) DO NOTHING').run(epoch, String(recipient), kind, wrapped, at)
  }

  wrappedKeys(recipient, { afterEpoch = 0, limit = 100 } = {}) {
    return this.q('SELECT * FROM wrapped_keys WHERE recipient = ? AND epoch > ? ORDER BY epoch LIMIT ?').all(String(recipient), afterEpoch, clamp(limit, 100, 1000))
      .map(r => ({ epoch: r.epoch, recipient: r.recipient, kind: r.kind, wrapped: r.wrapped, created: r.created }))
  }

  // ---- admin log -----------------------------------------------------------

  // What was done on the admin page. Repeated wrong keys count up in one line, so they cannot push the rest out.
  audit({ action, detail = '', from = '', at = this.now() }) {
    return this.tx(() => {
      const last = this.q('SELECT id, action, count FROM admin_log ORDER BY id DESC LIMIT 1').get()
      if (action === 'login-failed' && last?.action === action) this.q('UPDATE admin_log SET ts = ?, count = count + 1 WHERE id = ?').run(at, last.id)
      else this.q('INSERT INTO admin_log (ts, action, detail, origin) VALUES (?, ?, ?, ?)').run(at, String(action), String(detail), String(from))
      this.q('DELETE FROM admin_log WHERE id NOT IN (SELECT id FROM admin_log ORDER BY id DESC LIMIT ?)').run(ADMIN_LOG_MAX)
    })
  }

  adminLog({ limit = ADMIN_LOG_MAX } = {}) {
    return this.q('SELECT * FROM (SELECT * FROM admin_log ORDER BY id DESC LIMIT ?) ORDER BY id').all(clamp(limit, ADMIN_LOG_MAX, ADMIN_LOG_MAX))
      .map(r => ({ ts: r.ts, action: r.action, detail: r.detail, from: r.origin, ...(r.count > 1 ? { count: r.count } : {}) }))
  }

  // ---- snapshot, stats, export ---------------------------------------------

  // What a client needs to draw the board without replaying the log: the sessions, the open cards in stack
  // order, the status lines, and counts. `cursor` is the seq this picture corresponds to; everything after it
  // comes from eventsAfter(cursor). All of it is read in one transaction, so the picture and the cursor agree
  // even while another connection writes.
  snapshot({ cards: cardLimit = 500, sessions: sessionLimit = 500 } = {}) {
    const read = () => {
      const cursor = this.cursor()
      const sessions = this.sessions({ limit: sessionLimit })
      const cards = this.openCards({ limit: cardLimit })
      const shelved = new Set(sessions.filter(s => s.archived).map(s => s.id))
      const byStatus = { open: 0, decided: 0, done: 0 }
      for (const r of this.q('SELECT status, COUNT(*) AS n FROM cards GROUP BY status').all()) byStatus[r.status] = r.n
      const queued = Object.fromEntries(this.q('SELECT session, COUNT(*) AS n FROM deliveries GROUP BY session LIMIT 1000').all().map(r => [r.session, r.n]))
      return {
        cursor, sessions, cards, queue: cards.filter(c => !shelved.has(c.session)).map(c => c.id), status: this.statusLines(),
        counts: { events: cursor, cards: byStatus, messages: Object.fromEntries(sessions.map(s => [s.id, s.messages])), queued },
        next_number: this.meta('next_number'),
        truncated: cards.length < byStatus.open || sessions.length === clamp(sessionLimit, 500, 1000),
      }
    }
    if (this.depth > 0) return read()
    // A read transaction: in WAL mode it sees one committed state from start to end and blocks no writer.
    this.db.exec('BEGIN')
    try { return read() } finally { this.db.exec('COMMIT') }
  }

  stats() {
    const size = file => { try { return fs.statSync(file).size } catch { return 0 } }
    const count = table => this.q(`SELECT COUNT(*) AS n FROM ${table}`).get().n
    return {
      version: this.version, cursor: this.cursor(),
      bytes: { db: size(this.file), wal: size(`${this.file}-wal`) },
      rows: { sessions: count('sessions'), cards: count('cards'), messages: count('messages'), status_lines: count('status_lines'), deliveries: count('deliveries'), blobs: count('blobs') },
      blob_bytes: this.q('SELECT COALESCE(SUM(size), 0) AS n FROM blobs WHERE doomed_at IS NULL').get().n,
    }
  }

  // Move the write-ahead log into the main file and shrink it; for a tidy size on disk and before copying the file.
  checkpoint() { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)') }

  // A consistent copy of the whole database while it is in use.
  backup(file) { return sqliteBackup(this.db, file) }

  // Every row of every table, one at a time, as { table, row }. Bytes become { $b64 }; plaintext JSON payloads
  // are given as `body`. Notifications that wait for agents are left out but counted, as the admin export does
  // today: they repeat chat text and name paths on this machine.
  * exportRows() {
    const plain = (table, row) => {
      const out = {}
      for (const [key, value] of Object.entries(row)) {
        if (!isBytes(value)) { out[key] = value; continue }
        const encKey = key === 'payload' ? 'enc' : key === 'profile' ? 'profile_enc' : key === 'meta' ? 'meta_enc' : null
        const body = encKey && row[encKey] === ENC_JSON ? decode(value, ENC_JSON) : undefined
        out[key] = body !== undefined ? { $json: body } : { $b64: Buffer.from(value).toString('base64') }
      }
      return { table, row: out }
    }
    yield { format: 'trommi-store', schema: this.version, exported: this.now(), cursor: this.cursor(), next_number: this.meta('next_number') }
    const tables = [
      ['sessions', 'id'], ['senders', 'n'], ['events', 'seq'], ['cards', 'number'], ['messages', 'seq'], ['status_lines', 'session, id'],
      ['blobs', 'id'], ['event_blobs', 'seq, blob_id'], ['canvases', 'session'], ['admin_log', 'id'],
      ...(this.version >= 2 ? [['pads', 'id'], ['pad_elements', 'pad, z, id'], ['pad_links', 'element, session, seq']] : []),
      ...(this.version >= 3 ? [['member_log', 'n'], ['devices', 'id'], ['wrapped_keys', 'epoch, recipient'], ['invites', 'id']] : []),
    ]
    for (const [table, order] of tables) {
      // iterate() steps through the result; no table is ever held in memory as a whole.
      for (const row of this.db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).iterate()) yield plain(table, row)
    }
    for (const r of this.q('SELECT session, COUNT(*) AS n FROM deliveries GROUP BY session').iterate()) yield { table: 'pending_counts', row: { session: r.session, count: r.n } }
  }

  // The export as a file of JSON lines. scrub: a function applied to every line, e.g. to remove secrets that got into a text.
  exportTo(file, { scrub = line => line } = {}) {
    const fd = fs.openSync(file, 'w', 0o600)
    let lines = 0
    try {
      for (const item of this.exportRows()) {
        fs.writeSync(fd, `${scrub(JSON.stringify(item))}\n`)
        lines++
      }
    } finally {
      fs.closeSync(fd)
    }
    return lines
  }
}

export const openStore = (file, options) => new Store(file, options)
