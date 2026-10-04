// accounts.mjs: email + password logins (README "Accounts"). An account maps an email to ONE room and keeps what a
// new device needs to get into it, all opaque to the hub: a scrypt hash of the client's auth key (from Argon2id of
// the password, core/account.mjs), the room's recovery code wrapped under the password, and optionally the
// same code wrapped under the Emergency Kit's words (with a scrypt hash of their auth key). The hub never sees the
// password, the words or the code. Plaintext here: the email, the room id, when the email was confirmed.
//
// Routes
//   POST /v1/rooms/:room/account            human token  { email, auth_key, key_wrapped, kdf } -> 201; mails a code
//   GET  /v1/rooms/:room/account            human token  -> { email, email_verified_at, key_wrapped, kdf, has_recovery, revision, … }
//   PUT  /v1/rooms/:room/account/password   human token  { auth_key, key_wrapped, kdf, revision }  (compare-and-swap)
//   PUT  /v1/rooms/:room/account/recovery   human token  { recovery_auth, recovery_wrapped, revision }
//   POST /v1/rooms/:room/account/verify     human token  { code }    POST …/account/code: send a new code
//   POST /v1/accounts/login                 anonymous    { email, auth_key }       -> { room_id, key_wrapped, kdf, challenge } | 401 wrong-login
//   POST /v1/accounts/recover               anonymous    { email, recovery_auth }  -> { room_id, recovery_wrapped, challenge } | 401 wrong-recovery
// Login and recover give one answer for "no such email" and "wrong secret", always after one scrypt (same time),
// limited per address and per email (failures). Registering never says whether an email is in use elsewhere: an
// email can be claimed by several rooms until one confirms it, which deletes the other claims. An unconfirmed claim
// is deleted after 24 h — only while a real mail transport is set (with the log transport no code reaches anyone,
// and deleting would lock people out; HUB_ACCOUNT_EXPIRE=1 forces it).
import crypto from 'node:crypto'
import { refuse, sendJson, readJson, windowLimit } from './ops/http.mjs'
import { envNumber } from './ops/env.mjs'

const HOUR = 3600000
const ROOM_ACCOUNT = /^\/v1\/rooms\/([0-9a-f]{64})\/account(?:\/(password|recovery|verify|code))?$/
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/
const B64U = /^[A-Za-z0-9_-]+$/
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 << 20 }
const CODE_MS = 30 * 60000
const MAX_CLAIMS = 5

export function normaliseEmail(v) {
  const e = typeof v === 'string' ? v.normalize('NFC').trim().toLowerCase() : ''
  if (e.length > 254 || !EMAIL.test(e)) refuse(400, 'bad-email', 'not an email address')
  return e
}
const bytesArg = (v, what, len) => {
  if (typeof v !== 'string' || !B64U.test(v)) refuse(400, 'bad-argument', `${what} (base64url) is missing`)
  const b = Buffer.from(v, 'base64url')
  if (len && b.length !== len) refuse(400, 'bad-argument', `${what} is ${len} bytes`)
  if (b.length > 512) refuse(400, 'bad-argument', `${what} is too long`)
  return b
}
const kdfArg = v => {
  if (!v || v.alg !== 'argon2id' || v.v !== 1 || ![v.m, v.t, v.p].every(Number.isInteger) || v.m < 19456 || v.m > 1 << 21 || v.t < 1 || v.t > 20 || v.p < 1 || v.p > 8) refuse(400, 'bad-argument', 'kdf: { alg: argon2id, v: 1, m, t, p }')
  return JSON.stringify({ alg: v.alg, v: v.v, m: v.m, t: v.t, p: v.p })
}
const slowHash = (secret, salt) => new Promise((ok, bad) => crypto.scrypt(secret, salt, 32, SCRYPT, (e, k) => (e ? bad(e) : ok(k))))
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b)
const codeHash = (salt, code) => crypto.createHash('sha256').update(salt).update(String(code)).digest()

export function createAccounts({ db, room, bearer, ipOf, mailer, now = Date.now, log = () => {}, env = process.env }) {
  db.exec(`CREATE TABLE IF NOT EXISTS accounts (
    room_id TEXT PRIMARY KEY, email TEXT NOT NULL, email_verified_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL,
    auth_salt BLOB NOT NULL, auth_hash BLOB NOT NULL, key_wrapped BLOB NOT NULL, kdf TEXT NOT NULL,
    recovery_salt BLOB, recovery_hash BLOB, recovery_wrapped BLOB,
    code_salt BLOB, code_hash BLOB, code_expires_at INTEGER, code_attempts INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS accounts_by_email ON accounts (email);`)
  const ttl = envNumber(env, 'HUB_ACCOUNT_UNVERIFIED_HOURS', 24) * HOUR
  const expire = env.HUB_ACCOUNT_EXPIRE === '1' || !['log', 'off'].includes(mailer.transport)
  const ipLimit = windowLimit(envNumber(env, 'HUB_LIMIT_LOGINS_PER_IP_10MIN', 30), 10 * 60000, now)
  const maxFailures = envNumber(env, 'HUB_LIMIT_LOGIN_FAILURES_PER_EMAIL_HOUR', 10)
  const failures = new Map()                       // email -> [times] of failed logins (checked before, counted after)
  const mailLimit = windowLimit(5, HOUR, now)      // codes per email address (no mail bombing through many rooms)
  const resendLimit = windowLimit(1, 60000, now)
  const dummySalt = crypto.randomBytes(16)

  const live = r => r.email_verified_at != null || !expire || r.created_at > now() - ttl
  const rowsOf = email => db.q('SELECT * FROM accounts WHERE email = ?').all(email).filter(live)
  const rowOfRoom = roomId => { const r = db.q('SELECT * FROM accounts WHERE room_id = ?').get(roomId); return r && live(r) ? r : null }
  const human = async (req, roomId) => (await room(roomId)).hub.authorise(bearer(req), { human: true })
  const swap = (r, revision) => { if (!Number.isInteger(revision) || revision !== r.revision) refuse(409, 'account-changed', `the account is at revision ${r.revision}; read it again`) }

  async function sendCode(r) {
    if (mailLimit.take(r.email)) return false
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0')
    const salt = crypto.randomBytes(16)
    db.q('UPDATE accounts SET code_salt = ?, code_hash = ?, code_expires_at = ?, code_attempts = 0 WHERE room_id = ?').run(salt, codeHash(salt, code), now() + CODE_MS, r.room_id)
    await mailer.send({ to: r.email, subject: `Your Trommi code: ${code}`, text: `Your code is ${code}. It confirms this email address for your Trommi account and works for 30 minutes.\n\nYou did not create a Trommi account? Then ignore this mail; nothing happens without the code.` })
      .catch(err => log(`mail to an account failed: ${err.message}`))
    return true
  }

  /** Anonymous login / recover: per-address limit on every try, per-email limit on failures, one scrypt per row (at least one). */
  async function anonymous(req, res, { secretField, saltCol, hashCol, reply, wrong }) {
    const wait = ipLimit.take(ipOf(req))
    const tooMany = w => { res.setHeader('retry-after', String(w)); refuse(429, 'rate-limited', 'too many tries; wait a moment') }
    if (wait) tooMany(wait)
    const body = await readJson(req, 4096)
    const email = normaliseEmail(body.email)
    const secret = bytesArg(body[secretField], secretField, 32)
    const fails = (failures.get(email) ?? []).filter(t => now() - t < HOUR)
    if (fails.length >= maxFailures) tooMany(Math.ceil((fails[0] + HOUR - now()) / 1000))
    const rows = rowsOf(email).filter(r => r[hashCol])
    let hit = null
    for (const r of rows) if (same(await slowHash(secret, r[saltCol]), Buffer.from(r[hashCol])) && !hit) hit = r
    if (!rows.length) await slowHash(secret, dummySalt)
    if (!hit) {
      fails.push(now()); failures.set(email, fails)
      if (failures.size > 100000) failures.delete(failures.keys().next().value)
      refuse(401, wrong, 'email or secret is wrong')
    }
    failures.delete(email)
    return sendJson(res, 200, await reply(hit))
  }
  /** A sign-in challenge of the account's room with the login answer: the new device signs in one round trip sooner. */
  const challengeOf = async roomId => { try { return Buffer.from((await room(roomId)).hub.challenge()).toString('base64url') } catch { return undefined } }

  async function roomRoute(req, res, roomId, sub) {
    const m = req.method
    if (!sub && m === 'POST') {
      const me = await human(req, roomId)
      const body = await readJson(req, 8192)
      await human(req, roomId)
      const email = normaliseEmail(body.email)
      const auth = bytesArg(body.auth_key, 'auth_key', 32)
      const wrapped = bytesArg(body.key_wrapped, 'key_wrapped', 61)
      const kdf = kdfArg(body.kdf)
      if (rowOfRoom(roomId)) refuse(409, 'account-exists', 'this room has an account already')
      if (rowsOf(email).filter(r => r.email_verified_at == null).length >= MAX_CLAIMS) refuse(429, 'too-many', 'too many open claims on this email; try again tomorrow')
      const salt = crypto.randomBytes(16)
      const hash = await slowHash(auth, salt)
      const at = now()
      db.tx(() => {
        db.q('DELETE FROM accounts WHERE room_id = ?').run(roomId)          // an expired claim of this room
        db.q('INSERT INTO accounts (room_id, email, created_at, updated_at, revision, auth_salt, auth_hash, key_wrapped, kdf) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)')
          .run(roomId, email, at, at, salt, hash, wrapped, kdf)
      })
      await sendCode(rowOfRoom(roomId))
      log(`room ${roomId.slice(0, 8)}: account created by ${me.id.slice(0, 8)}`)
      return sendJson(res, 201, { email, email_verified_at: null, revision: 1 })
    }
    await human(req, roomId)
    const r = rowOfRoom(roomId)
    if (!r) refuse(404, 'not-found', 'this room has no account')
    if (!sub && m === 'GET') {
      return sendJson(res, 200, { email: r.email, email_verified_at: r.email_verified_at, created_at: r.created_at, updated_at: r.updated_at, revision: r.revision,
        key_wrapped: Buffer.from(r.key_wrapped).toString('base64url'), kdf: JSON.parse(r.kdf), has_recovery: !!r.recovery_hash,
        ...(r.email_verified_at == null && expire ? { claim_expires_at: r.created_at + ttl } : {}) })
    }
    if (sub === 'password' && m === 'PUT') {
      const body = await readJson(req, 8192)
      await human(req, roomId)
      const auth = bytesArg(body.auth_key, 'auth_key', 32), wrapped = bytesArg(body.key_wrapped, 'key_wrapped', 61), kdf = kdfArg(body.kdf)
      const salt = crypto.randomBytes(16), hash = await slowHash(auth, salt)
      db.tx(() => {
        const cur = rowOfRoom(roomId); swap(cur, body.revision)
        db.q('UPDATE accounts SET auth_salt = ?, auth_hash = ?, key_wrapped = ?, kdf = ?, revision = revision + 1, updated_at = ? WHERE room_id = ?').run(salt, hash, wrapped, kdf, now(), roomId)
      })
      failures.delete(r.email)
      return sendJson(res, 200, { revision: r.revision + 1 })
    }
    if (sub === 'recovery' && m === 'PUT') {
      const body = await readJson(req, 8192)
      await human(req, roomId)
      const auth = bytesArg(body.recovery_auth, 'recovery_auth', 32), wrapped = bytesArg(body.recovery_wrapped, 'recovery_wrapped', 61)
      const salt = crypto.randomBytes(16), hash = await slowHash(auth, salt)
      db.tx(() => {
        const cur = rowOfRoom(roomId); swap(cur, body.revision)
        db.q('UPDATE accounts SET recovery_salt = ?, recovery_hash = ?, recovery_wrapped = ?, revision = revision + 1, updated_at = ? WHERE room_id = ?').run(salt, hash, wrapped, now(), roomId)
      })
      return sendJson(res, 200, { revision: r.revision + 1 })
    }
    if (sub === 'verify' && m === 'POST') {
      const body = await readJson(req, 1024)
      if (r.email_verified_at != null) return sendJson(res, 200, { email: r.email, email_verified_at: r.email_verified_at })
      const code = typeof body.code === 'string' && /^\d{6}$/.test(body.code) ? body.code : null
      const ok = code && r.code_hash && r.code_expires_at > now() && r.code_attempts < 5 && same(codeHash(Buffer.from(r.code_salt), code), Buffer.from(r.code_hash))
      if (!ok) {
        db.q('UPDATE accounts SET code_attempts = code_attempts + 1 WHERE room_id = ?').run(roomId)
        refuse(400, 'wrong-code', r.code_attempts + 1 >= 5 ? 'wrong code; ask for a new one' : 'wrong or expired code')
      }
      const at = now()
      db.tx(() => {
        db.q('UPDATE accounts SET email_verified_at = ?, code_hash = NULL, code_salt = NULL, code_expires_at = NULL, updated_at = ? WHERE room_id = ?').run(at, at, roomId)
        // The email is this room's now: every other claim on it goes.
        db.q('DELETE FROM accounts WHERE email = ? AND room_id != ?').run(r.email, roomId)
      })
      return sendJson(res, 200, { email: r.email, email_verified_at: at })
    }
    if (sub === 'code' && m === 'POST') {
      if (r.email_verified_at != null) refuse(409, 'already-verified', 'this email is confirmed')
      const w = resendLimit.take(roomId)
      if (w) { res.setHeader('retry-after', String(w)); refuse(429, 'rate-limited', 'a new code at most once a minute') }
      if (!(await sendCode(r))) refuse(429, 'rate-limited', 'too many codes to this email this hour')
      return sendJson(res, 200, { ok: true })
    }
    return false
  }

  /** Unconfirmed claims past 24 h (only with a real mail transport), and accounts of rooms that no longer exist. */
  function sweep() {
    let n = 0
    if (expire) n += Number(db.q('DELETE FROM accounts WHERE email_verified_at IS NULL AND created_at <= ?').run(now() - ttl).changes)
    n += Number(db.q('DELETE FROM accounts WHERE room_id NOT IN (SELECT room_id FROM rooms)').run().changes)
    return n
  }
  const timer = setInterval(() => { try { sweep() } catch (err) { log(`accounts sweep: ${err.message}`) } }, HOUR)
  timer.unref()

  return {
    sweep, expire,
    async handle(req, res, url) {
      const p = url.pathname
      if (p === '/v1/accounts/login' && req.method === 'POST') {
        await anonymous(req, res, { secretField: 'auth_key', saltCol: 'auth_salt', hashCol: 'auth_hash', wrong: 'wrong-login',
          reply: async r => ({ room_id: r.room_id, key_wrapped: Buffer.from(r.key_wrapped).toString('base64url'), kdf: JSON.parse(r.kdf), challenge: await challengeOf(r.room_id) }) })
        return true
      }
      if (p === '/v1/accounts/recover' && req.method === 'POST') {
        await anonymous(req, res, { secretField: 'recovery_auth', saltCol: 'recovery_salt', hashCol: 'recovery_hash', wrong: 'wrong-recovery',
          reply: async r => ({ room_id: r.room_id, recovery_wrapped: Buffer.from(r.recovery_wrapped).toString('base64url'), challenge: await challengeOf(r.room_id) }) })
        return true
      }
      const m = ROOM_ACCOUNT.exec(p)
      if (!m) return false
      return (await roomRoute(req, res, m[1], m[2])) !== false
    },
    close() { clearInterval(timer) },
  }
}
