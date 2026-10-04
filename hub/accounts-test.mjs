// Tests for accounts (hub/accounts.mjs + client/core/account.mjs): Argon2 vectors, create account, login on a
// second device, wrong password, enumeration resistance, rate limits, Emergency Kit + forgot password, password
// change, email verification, expiry of unconfirmed claims. Real HTTP against hub/server.mjs on a free port.
// Run: node hub/accounts-test.mjs [name filter]
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { argon2id } from '../client/core/argon2.mjs'
import * as A from '../client/core/account.mjs'
import { memoryStorage } from '../client/core/index.mjs'

const outbox = fs.mkdtempSync(path.join(os.tmpdir(), 'trommi-mail-'))
Object.assign(process.env, { HUB_MAIL_OUTBOX: outbox, HUB_LIMIT_LOGINS_PER_IP_10MIN: '1000', HUB_ACCOUNT_EXPIRE: '1' })
const { startHub } = await import('./server.mjs')

const tests = []
const test = (name, fn) => tests.push({ name, fn })
const dirs = [outbox]
let skew = 0
let ipN = 0
const freshIp = () => `10.88.${(++ipN >> 8) & 255}.${ipN & 255}`

async function newHub(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trommi-acct-test-'))
  dirs.push(dir)
  const saved = { ...process.env }
  Object.assign(process.env, env)
  try {
    const hub = await startHub({ port: 0, host: '127.0.0.1', dataDir: dir, commit: 'test', log: () => {}, trustCloudflare: true, now: () => Date.now() + skew })
    return hub
  } finally { process.env = saved }
}
/** A fetch that comes from its own address (cf-connecting-ip, trusted from loopback in tests). */
const fetchFrom = (ip = freshIp()) => (url, init = {}) => fetch(url, { ...init, headers: { ...(init.headers ?? {}), 'cf-connecting-ip': ip } })
const post = (hub, p, body, ip = freshIp()) => fetch(hub.hubUrl + p, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify(body) })
const mails = to => fs.readdirSync(outbox).sort().map(f => JSON.parse(fs.readFileSync(path.join(outbox, f), 'utf8'))).filter(m => m.to === to)
const lastCode = to => /(\d{6})/.exec(mails(to).at(-1)?.subject ?? '')?.[1]
let emailN = 0
const freshEmail = () => `Person.${++emailN}.${crypto.randomBytes(3).toString('hex')}@Example.org `
const PW = 'correct horse battery'

async function makeAccount(hub, email = freshEmail(), password = PW) {
  const { client, recovery_code } = await A.createAccount({ hub_url: hub.hubUrl, email, password, storage: memoryStorage(), device_name: 'Laptop', fetch: fetchFrom() })
  return { client, recovery_code, email: A.normaliseEmail(email), password }
}
const members = c => [...c.state.members.values()].filter(m => m.removedSeq === null).length

// ---- Argon2 ------------------------------------------------------------------------

test('argon2: hash-wasm equals node:crypto argon2id; RFC 9106 vector via node', async () => {
  for (const [pw, salt, t, m, p, len] of [['password', 'somesaltsomesalt', 3, 65536, 1, 32], ['p', 'saltsaltsaltsalt', 1, 19456, 1, 32], ['pässwörd ✓', crypto.randomBytes(32), 2, 8192, 2, 64]]) {
    const a = await argon2id({ password: pw, salt, iterations: t, parallelism: p, memorySize: m, hashLength: len, outputType: 'hex' })
    const b = crypto.argon2Sync('argon2id', { message: pw, nonce: salt, passes: t, parallelism: p, memory: m, tagLength: len }).toString('hex')
    assert.equal(a, b)
  }
  // RFC 9106 5.3 (with secret and associated data: node's argon2 is the reference here; hash-wasm has no ad input)
  const rfc = crypto.argon2Sync('argon2id', { message: Buffer.alloc(32, 1), nonce: Buffer.alloc(16, 2), secret: Buffer.alloc(8, 3), associatedData: Buffer.alloc(12, 4), passes: 3, memory: 32, parallelism: 4, tagLength: 32 }).toString('hex')
  assert.equal(rfc, '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659')
  // hash-wasm with a secret, no ad, against node
  const s = await argon2id({ password: Buffer.alloc(32, 1), salt: Buffer.alloc(16, 2), secret: Buffer.alloc(8, 3), iterations: 3, parallelism: 4, memorySize: 32, hashLength: 32, outputType: 'hex' })
  assert.equal(s, crypto.argon2Sync('argon2id', { message: Buffer.alloc(32, 1), nonce: Buffer.alloc(16, 2), secret: Buffer.alloc(8, 3), passes: 3, memory: 32, parallelism: 4, tagLength: 32 }).toString('hex'))
})

test('account keys: known answer of the v1 derivation (Argon2id 64 MiB, t 3, p 1 over the email salt)', async () => {
  const email = 'ada@example.org', pw = 'correct horse battery'
  const salt = crypto.createHash('sha256').update(Buffer.concat([Buffer.from('trommi/v1/account-salt'), Buffer.of(0), Buffer.from(email)])).digest()
  const master = crypto.argon2Sync('argon2id', { message: pw, nonce: salt, passes: 3, parallelism: 1, memory: 65536, tagLength: 32 })
  const auth = Buffer.from(crypto.hkdfSync('sha256', master, salt, 'trommi/v1/account-auth', 32)).toString('base64url')
  const t = performance.now()
  const k = await A.passwordKeys(' Ada@Example.org', pw)
  console.log(`    (derivation ${(performance.now() - t).toFixed(0)} ms in Node)`)
  assert.equal(k.auth_key, auth)
})

test('password rule: 12 characters, nothing else; generated passwords and kit words', () => {
  assert.equal(A.passwordProblem('short pw 11'), 'at least 12 characters')
  assert.equal(A.passwordProblem('aaaaaaaaaaaa'), null)
  const g = A.generatePassword()
  assert.match(g, /^[a-z]+(-[a-z]+){4}$/)
  assert.equal(A.passwordProblem(g), null)
  const w = A.generateRecoveryWords()
  assert.equal(w.split(' ').length, 12)
  assert.equal(A.parseRecoveryWords(`  ${w.toUpperCase().replace(/ /g, '-')}\n`), w)
  assert.throws(() => A.parseRecoveryWords('one two'), /12 words/)
})

// ---- create, log in -------------------------------------------------------------------

test('create account, then log in on a second device with email + password', async () => {
  const hub = await newHub()
  try {
    const a = await makeAccount(hub)
    assert.equal(a.client.model.room.my_role, 'human')
    const st = await A.accountStatus(a.client)
    assert.equal(st.email, a.email)
    assert.equal(st.email_verified_at, null)
    assert.equal(st.has_recovery, false)
    const { client: b } = await A.loginWithPassword({ hub_url: hub.hubUrl, email: a.email.toUpperCase(), password: PW, storage: memoryStorage(), device_name: 'Phone', fetch: fetchFrom() })
    assert.equal(b.model.room.room_id, a.client.model.room.room_id)
    assert.equal(b.model.room.my_role, 'human')
    assert.equal(members(b), 2)
    // a third device too; the hub row never holds the password
    const { client: c } = await A.loginWithPassword({ hub_url: hub.hubUrl, email: a.email, password: PW, storage: memoryStorage(), device_name: 'Tablet', fetch: fetchFrom() })
    assert.equal(members(c), 3)
    const row = hub.db.prepare('SELECT * FROM accounts').get()
    assert.ok(!JSON.stringify(row, (k, v) => (typeof v === 'bigint' ? String(v) : v)).includes(PW))
    for (const x of [a.client, b, c]) await x.stop()
  } finally { await hub.close() }
})

test('a room has one account; a second POST is 409; weak password refused in the core', async () => {
  const hub = await newHub()
  try {
    const a = await makeAccount(hub)
    await assert.rejects(A.addAccount(a.client, { email: freshEmail(), password: PW, recovery_code: a.recovery_code }), e => e.code === 'account-exists')
    await assert.rejects(A.createAccount({ hub_url: hub.hubUrl, email: freshEmail(), password: 'short', storage: memoryStorage(), fetch: fetchFrom() }), e => e.code === 'weak-password')
    await a.client.stop()
  } finally { await hub.close() }
})

test('wrong password and unknown email: one answer (401 wrong-login, same body), similar time', async () => {
  const hub = await newHub()
  try {
    const a = await makeAccount(hub)
    await assert.rejects(A.loginWithPassword({ hub_url: hub.hubUrl, email: a.email, password: 'not the password', storage: memoryStorage(), fetch: fetchFrom() }), e => e.code === 'wrong-login' && e.status === 401)
    await assert.rejects(A.loginWithPassword({ hub_url: hub.hubUrl, email: 'nobody@example.org', password: PW, storage: memoryStorage(), fetch: fetchFrom() }), e => e.code === 'wrong-login' && e.status === 401)
    const key = crypto.randomBytes(32).toString('base64url')
    const time = async email => { const t = performance.now(); const r = await post(hub, '/v1/accounts/login', { email, auth_key: key }); return { ms: performance.now() - t, status: r.status, body: await r.json() } }
    const known = [], unknown = []
    for (let i = 0; i < 6; i++) { known.push(await time(a.email)); unknown.push(await time(`nobody${i}@example.org`)) }
    assert.deepEqual(known[0].body, unknown[0].body)
    assert.equal(known[0].status, unknown[0].status)
    const med = l => l.map(x => x.ms).sort((p, q) => p - q)[3]
    console.log(`    (median known ${med(known).toFixed(1)} ms, unknown ${med(unknown).toFixed(1)} ms)`)
    assert.ok(Math.abs(med(known) - med(unknown)) < Math.max(15, med(known) * 0.5), 'known and unknown emails take about as long')
    await a.client.stop()
  } finally { await hub.close() }
})

test('registering an email another room uses looks the same (201), and both claims stay until one confirms', async () => {
  const hub = await newHub()
  try {
    const email = freshEmail()
    const a = await makeAccount(hub, email)
    const b = await makeAccount(hub, email, 'another password 2')
    // each logs in with its own password into its own room
    const la = await post(hub, '/v1/accounts/login', { email: a.email, auth_key: (await A.passwordKeys(a.email, PW)).auth_key })
    assert.equal((await la.json()).room_id, a.client.model.room.room_id)
    const lb = await post(hub, '/v1/accounts/login', { email: a.email, auth_key: (await A.passwordKeys(a.email, 'another password 2')).auth_key })
    assert.equal((await lb.json()).room_id, b.client.model.room.room_id)
    // b confirms the email: a's claim goes
    await A.verifyEmail(b.client, lastCode(a.email))
    assert.equal(await A.accountStatus(a.client), null)
    const la2 = await post(hub, '/v1/accounts/login', { email: a.email, auth_key: (await A.passwordKeys(a.email, PW)).auth_key })
    assert.equal(la2.status, 401)
    await a.client.stop(); await b.client.stop()
  } finally { await hub.close() }
})

test('rate limits: per address on every try, per email on failures (429 for known and unknown alike)', async () => {
  const hub = await newHub({ HUB_LIMIT_LOGINS_PER_IP_10MIN: '5', HUB_LIMIT_LOGIN_FAILURES_PER_EMAIL_HOUR: '3' })
  try {
    const key = crypto.randomBytes(32).toString('base64url')
    const ip = freshIp()
    const st = []
    for (let i = 0; i < 6; i++) st.push((await post(hub, '/v1/accounts/login', { email: `x${i}@example.org`, auth_key: key }, ip)).status)
    assert.deepEqual(st, [401, 401, 401, 401, 401, 429])
    const a = await makeAccount(hub)
    for (const email of [a.email, 'ghost@example.org']) {
      const s = []
      for (let i = 0; i < 4; i++) s.push((await post(hub, '/v1/accounts/login', { email, auth_key: key })).status)
      assert.deepEqual(s, [401, 401, 401, 429], email)
    }
    // the right password is refused too while the email is locked (no oracle), and works after the hour
    const good = (await A.passwordKeys(a.email, PW)).auth_key
    assert.equal((await post(hub, '/v1/accounts/login', { email: a.email, auth_key: good })).status, 429)
    skew += 3600_000 + 1000
    try { assert.equal((await post(hub, '/v1/accounts/login', { email: a.email, auth_key: good })).status, 200) } finally { skew -= 3600_000 + 1000 }
    await a.client.stop()
  } finally { await hub.close() }
})

// ---- Emergency Kit, forgot password, change password ----------------------------------------------

test('Emergency Kit + forgot password: new device with the words sets a new password; the old one stops working', async () => {
  const hub = await newHub()
  try {
    const a = await makeAccount(hub)
    const kit = await A.makeEmergencyKit(a.client, { recovery_code: a.recovery_code })
    assert.equal(kit.email, a.email)
    assert.equal((await A.accountStatus(a.client)).has_recovery, true)
    await assert.rejects(A.resetPassword({ hub_url: hub.hubUrl, email: a.email, words: A.generateRecoveryWords(), new_password: 'brand new password', storage: memoryStorage(), fetch: fetchFrom() }), e => e.code === 'wrong-recovery' && e.status === 401)
    const { client: b } = await A.resetPassword({ hub_url: hub.hubUrl, email: a.email, words: kit.words.toUpperCase(), new_password: 'brand new password', storage: memoryStorage(), device_name: 'New phone', fetch: fetchFrom() })
    assert.equal(b.model.room.room_id, a.client.model.room.room_id)
    await assert.rejects(A.loginWithPassword({ hub_url: hub.hubUrl, email: a.email, password: PW, storage: memoryStorage(), fetch: fetchFrom() }), e => e.code === 'wrong-login')
    const { client: c } = await A.loginWithPassword({ hub_url: hub.hubUrl, email: a.email, password: 'brand new password', storage: memoryStorage(), fetch: fetchFrom() })
    assert.equal(members(c), 3)
    // a kit made later from the password replaces the first one
    const kit2 = await A.makeEmergencyKit(c, { password: 'brand new password' })
    assert.notEqual(kit2.words, kit.words)
    await assert.rejects(A.resetPassword({ hub_url: hub.hubUrl, email: a.email, words: kit.words, new_password: 'brand new password', storage: memoryStorage(), fetch: fetchFrom() }), e => e.code === 'wrong-recovery')
    for (const x of [a.client, b, c]) await x.stop()
  } finally { await hub.close() }
})

test('change password on a signed-in device: needs the current one; re-wraps only', async () => {
  const hub = await newHub()
  try {
    const a = await makeAccount(hub)
    await assert.rejects(A.changePassword(a.client, { current: 'wrong password!', next: 'the next password' }), e => e.code === 'wrong-login')
    await assert.rejects(A.changePassword(a.client, { current: PW, next: 'short' }), e => e.code === 'weak-password')
    const before = (await A.accountStatus(a.client)).revision
    await A.changePassword(a.client, { current: PW, next: 'the next password' })
    assert.equal((await A.accountStatus(a.client)).revision, before + 1)
    await assert.rejects(A.loginWithPassword({ hub_url: hub.hubUrl, email: a.email, password: PW, storage: memoryStorage(), fetch: fetchFrom() }), e => e.code === 'wrong-login')
    const { client: b } = await A.loginWithPassword({ hub_url: hub.hubUrl, email: a.email, password: 'the next password', storage: memoryStorage(), fetch: fetchFrom() })
    assert.equal(members(b), 2)
    await a.client.stop(); await b.stop()
  } finally { await hub.close() }
})

// ---- email verification and expiry -------------------------------------------------------------

test('email code: wrong code, five tries, resend once a minute, then confirmed', async () => {
  const hub = await newHub()
  try {
    const a = await makeAccount(hub)
    const code = lastCode(a.email)
    assert.match(code, /^\d{6}$/)
    const wrong = code === '000000' ? '111111' : '000000'
    await assert.rejects(A.verifyEmail(a.client, wrong), e => e.code === 'wrong-code')
    for (let i = 0; i < 4; i++) await assert.rejects(A.verifyEmail(a.client, wrong), e => e.code === 'wrong-code')
    await assert.rejects(A.verifyEmail(a.client, code), e => e.code === 'wrong-code', 'after five wrong tries the code is dead')
    skew += 61_000
    try { await A.resendEmailCode(a.client); await assert.rejects(A.resendEmailCode(a.client), e => e.code === 'rate-limited') } finally { skew -= 61_000 }
    const fresh = lastCode(a.email)
    const out = await A.verifyEmail(a.client, fresh)
    assert.ok(out.email_verified_at)
    assert.ok((await A.accountStatus(a.client)).email_verified_at)
    await assert.rejects(A.resendEmailCode(a.client), e => e.code === 'already-verified')
    await a.client.stop()
  } finally { await hub.close() }
})

test('an unconfirmed claim expires after 24 h (login gone, row swept); a confirmed one stays', async () => {
  const hub = await newHub()
  try {
    const a = await makeAccount(hub)
    const b = await makeAccount(hub)
    await A.verifyEmail(b.client, lastCode(b.email))
    skew += 24 * 3600_000 + 1000
    try {
      await assert.rejects(A.loginWithPassword({ hub_url: hub.hubUrl, email: a.email, password: PW, storage: memoryStorage(), fetch: fetchFrom() }), e => e.code === 'wrong-login')
      assert.equal(await A.accountStatus(a.client), null)
      const { client: b2 } = await A.loginWithPassword({ hub_url: hub.hubUrl, email: b.email, password: PW, storage: memoryStorage(), fetch: fetchFrom() })
      assert.equal(members(b2), 2)
      assert.equal(hub.accounts.sweep(), 1)
      assert.equal(hub.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 1)
      await b2.stop()
    } finally { skew -= 24 * 3600_000 + 1000 }
    await a.client.stop(); await b.client.stop()
  } finally { await hub.close() }
})

test('with the log transport unconfirmed claims do not expire (nobody could confirm)', async () => {
  const hub = await newHub({ HUB_MAIL_OUTBOX: '', HUB_MAIL_TRANSPORT: 'log', HUB_ACCOUNT_EXPIRE: '' })
  try {
    assert.equal(hub.accounts.expire, false)
    const a = await makeAccount(hub)
    skew += 48 * 3600_000
    try { assert.equal((await A.accountStatus(a.client)).email, a.email); assert.equal(hub.accounts.sweep(), 0) } finally { skew -= 48 * 3600_000 }
    await a.client.stop()
  } finally { await hub.close() }
})

test('bad input: email, key sizes, kdf; account routes need a human token', async () => {
  const hub = await newHub()
  try {
    const key = crypto.randomBytes(32).toString('base64url')
    assert.equal((await post(hub, '/v1/accounts/login', { email: 'not-an-email', auth_key: key })).status, 400)
    assert.equal((await post(hub, '/v1/accounts/login', { email: 'a@example.org', auth_key: 'abc' })).status, 400)
    const a = await makeAccount(hub)
    const r = await fetch(`${hub.hubUrl}/v1/rooms/${a.client.model.room.room_id}/account`, { headers: { 'cf-connecting-ip': freshIp() } })
    assert.equal(r.status, 401)
    await a.client.stop()
  } finally { await hub.close() }
})

const filter = process.argv[2]
let failed = 0
for (const t of tests) {
  if (filter && !t.name.includes(filter)) continue
  const t0 = performance.now()
  try { await t.fn(); console.log(`ok   ${t.name} (${(performance.now() - t0).toFixed(0)} ms)`) } catch (err) { failed++; console.log(`FAIL ${t.name}\n${err.stack}`) }
}
for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
console.log(failed ? `${failed} failed` : 'all passed')
process.exit(failed ? 1 : 0)
