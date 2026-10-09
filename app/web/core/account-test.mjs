// account-test.mjs: the account's bytes (account.ts, passwords.ts) against spec/account-vectors.json, the known
// answers every implementation checks (the iOS app's Swift tests read the same file).
//
//   node app/web/core/account-test.mjs                    builds the vectors again and compares, then runs account.ts on them
//   node app/web/core/account-test.mjs --write-vectors    rewrites the file
//
// The vectors are NOT made with account.ts: this file derives them with node:crypto (Argon2id, HKDF, AES-256-GCM, each
// spelled out below as the README's "Account" table says it), so account.ts is checked against a second derivation.
import assert from 'node:assert/strict'
import nodeCrypto from 'node:crypto'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as z from './crypto/zcrypto.mjs'
import * as A from './account.ts'

const VECTORS = fileURLToPath(new URL('../../../spec/account-vectors.json', import.meta.url))
const hex = b => Buffer.from(b).toString('hex')
const b64u = b => Buffer.from(b).toString('base64url')
const label = s => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.of(0)])
const kdf = (ikm, salt, l) => Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, label(l), 32))
function seal(key, nonce, aad, plain, version = 2) {
  const c = nodeCrypto.createCipheriv('aes-256-gcm', key, nonce)
  c.setAAD(aad)
  return Buffer.concat([Buffer.of(version), nonce, c.update(plain), c.final(), c.getAuthTag()])
}

function build() {
  const v = { about: 'Known answers for the Trommi account (app/web/core/account.ts; the Swift client checks the same file). Hex unless a name ends in B64u. Regenerate with: node app/web/core/account-test.mjs --write-vectors' }
  v.labels = { rule: 'Every label is followed by one 0x00 byte where it is used, and has one use.', salt: 'trommi/v1/account-salt', auth: 'trommi/v1/account-auth', wrapKey: 'trommi/v1/account-wrap-key',
    recoveryAuth: 'trommi/v1/recovery-auth', recoveryWrapKey: 'trommi/v1/recovery-wrap-key', wrapAad: 'trommi/v1/account-wrap', passkeyWrapKey: 'trommi/v1/passkey-wrap-key' }

  // The room and its recovery code: fixed bytes, nothing of a real room.
  const roomId = Buffer.alloc(32, 0xa7), code = Buffer.from(Array.from({ length: 32 }, (_, i) => 0x40 + i))
  const aad = what => Buffer.concat([label(v.labels.wrapAad), roomId, Buffer.from(what, 'utf8')])

  // Password: the email as typed (capitals, spaces around it), the password in decomposed form (NFD), so both the
  // email rule and the password's NFC are part of the answer.
  const email = '  Owner@Example.COM ', normalisedEmail = 'owner@example.com'
  const password = 'Zu\u0308rich-cafe\u0301-correct-horse'          // Zurich-cafe with a combining diaeresis on the u and a combining acute on the e (decomposed)
  const salt = nodeCrypto.createHash('sha256').update(Buffer.concat([label(v.labels.salt), Buffer.from(normalisedEmail, 'utf8')])).digest()
  const master = nodeCrypto.argon2Sync('argon2id', { message: Buffer.from(password.normalize('NFC'), 'utf8'), nonce: salt, passes: 3, parallelism: 1, memory: 65536, tagLength: 32 })
  const authKey = kdf(master, salt, v.labels.auth), wrapKey = kdf(master, salt, v.labels.wrapKey)
  const nonce = Buffer.alloc(12, 0xc1)
  v.password = {
    email, normalisedEmail, password, passwordNfcUtf8: hex(Buffer.from(password.normalize('NFC'), 'utf8')), kdf: { alg: 'argon2id', v: 1, m: 65536, t: 3, p: 1 },
    salt: hex(salt), master: hex(master), authKeyB64u: b64u(authKey), wrapKey: hex(wrapKey),
    roomId: hex(roomId), code: z.formatRecoveryCode(new Uint8Array(code)), codeRaw: hex(code), nonce: hex(nonce), aad: hex(aad('password')),
    keyWrappedB64u: b64u(seal(wrapKey, nonce, aad('password'), code)),
  }

  // Emergency Kit: twelve words of the list, made up for this file; typed with numbers, capitals and line breaks.
  const words = 'acorn velvet tidy hamper oxford banjo cradle dolphin eagle fabric gallery harbor'
  const r = Buffer.from(words, 'utf8')
  const recoveryAuth = kdf(r, salt, v.labels.recoveryAuth), recoveryWrapKey = kdf(r, salt, v.labels.recoveryWrapKey)
  const nonce2 = Buffer.alloc(12, 0xc2)
  v.recovery = {
    words, wordsAsTyped: words.split(' ').map((w, i) => `${i + 1}. ${w[0].toUpperCase()}${w.slice(1)}`).join('\n'),
    recoveryAuthB64u: b64u(recoveryAuth), wrapKey: hex(recoveryWrapKey), nonce: hex(nonce2), aad: hex(aad('recovery')),
    recoveryWrappedB64u: b64u(seal(recoveryWrapKey, nonce2, aad('recovery'), code)),
  }

  // A passkey's copy (README "Accounts", passkeys): the wrap key from the authenticator's prf output, the room id as
  // salt and the credential id as the label's context; the credential id is also in the associated data. The web
  // client makes it (core/passkey.ts); the iOS app's Swift tests check the same bytes.
  const prf = Buffer.alloc(32, 0x9f), credentialId = Buffer.from(Array.from({ length: 20 }, (_, i) => 0xd0 + i)), nonce3 = Buffer.alloc(12, 0xc3)
  const passkeyWrapKey = Buffer.from(nodeCrypto.hkdfSync('sha256', prf, roomId, Buffer.concat([label(v.labels.passkeyWrapKey), credentialId]), 32))
  const passkeyAad = Buffer.concat([aad('passkey'), credentialId])
  v.passkey = {
    rule: 'wrap key = HKDF-SHA-256(ikm = prf output, salt = room id, info = "trommi/v1/passkey-wrap-key" 0x00 credential id, 32 bytes); aad = "trommi/v1/account-wrap" 0x00 room id "passkey" credential id; the copy as the others: 0x02, nonce, AES-256-GCM',
    prfInput: 'trommi/v1/passkey-prf', prfOutput: hex(prf), credentialId: hex(credentialId), roomId: hex(roomId), wrapKey: hex(passkeyWrapKey), nonce: hex(nonce3), aad: hex(passkeyAad),
    keyWrappedB64u: b64u(seal(passkeyWrapKey, nonce3, passkeyAad, code)),
  }

  // The email rule (passwords.ts normaliseEmail; the iOS app has the same): what the salt is made of.
  const a = n => 'a'.repeat(n)
  const ok = (input, normalised, why) => ({ input, normalised, why }), no = (input, why) => ({ input, error: 'bad-email', why })
  v.email = {
    rule: '1. drop leading and trailing U+0020 and U+0009..U+000D. 2. every character left is U+0021..U+007E, else bad-email (nothing is mapped or normalised). 3. A-Z become a-z. 4. at most 254 characters; exactly one "@"; 1 to 64 characters before it; after it a "." with 1 to 190 characters before and 2 to 63 after.',
    cases: [
      ok('owner@example.com', 'owner@example.com', 'as it is'),
      ok('  Owner@Example.COM ', 'owner@example.com', 'capitals, spaces around it'),
      ok('\t\r\n\u000b\u000cAda.Lovelace+Notes@Sub.Example.ORG\n', 'ada.lovelace+notes@sub.example.org', 'every dropped character around it; dots and a plus kept'),
      ok("O'Brien_{x}|~!#$%&*/=?^`@example.org", "o'brien_{x}|~!#$%&*/=?^`@example.org", 'printable ASCII in the local part is kept as it is'),
      ok('user@xn--mller-kva.example.org', 'user@xn--mller-kva.example.org', 'a domain in punycode'),
      ok('a@example..com', 'a@example..com', 'two dots: the rule asks for one dot with enough on both sides'),
      ok('a@example.com.', 'a@example.com.', 'a dot at the end: the dot before "com." counts'),
      ok(`${a(64)}@example.org`, `${a(64)}@example.org`, '64 characters before the @'),
      ok(`${a(64)}@${a(177)}.example.com`, `${a(64)}@${a(177)}.example.com`, '254 characters'),
      ok(`x@${a(190)}.example.com`, `x@${a(190)}.example.com`, '190 characters before the first dot'),
      ok(`x@a.${'7'.repeat(63)}`, `x@a.${'7'.repeat(63)}`, '63 characters after the dot'),
      ok('A@B.CD', 'a@b.cd', 'the shortest'),
      no('', 'empty'), no('   ', 'only spaces'), no('owner', 'no @'), no('owner@example', 'no dot after the @'), no('@example.com', 'nothing before the @'),
      no('owner@@example.com', 'two @'), no('a@b@example.com', 'two @'), no('owner@.com', 'nothing before the dot'), no('owner@example.c', 'one character after the dot'),
      no('own er@example.com', 'a space inside'), no('owner@exam\tple.com', 'a tab inside'), no('owner@example.com\u0000', 'a control character'), no('owner\u007f@example.com', 'DEL'),
      no(`${a(65)}@example.org`, '65 characters before the @'), no(`${a(64)}@${a(178)}.example.com`, '255 characters'),
      no(`x@${a(191)}.example.com`, '191 characters and more before every dot'), no(`x@a.${'7'.repeat(64)}`, '64 characters after the dot'),
      no('m\u00fcller@example.com', 'a letter outside ASCII (composed)'), no('mu\u0308ller@example.com', 'the same letter decomposed'), no('user@m\u00fcller.example.org', 'a domain outside ASCII: write it as punycode'),
      no('\u00a0owner@example.com', 'a no-break space is not dropped'), no('owner@example.com\ufeff', 'a byte order mark is not dropped'), no('owner@example.com\u2028', 'a line separator is not dropped'),
      no('owner\uff20example.com', 'a fullwidth @'), no('\u0130stanbul@example.com', 'a capital outside ASCII is not lowercased'), no('owner@example.com\ud83d\ude00', 'an emoji'),
      no('owner@example\u3002com', 'an ideographic full stop is no dot'),
    ],
  }
  // The password rule: at least 12 code points of the NFC form (passwords.ts passwordProblem; the same in the iOS app).
  v.passwordRule = { min: 12, rule: 'a password may be used if its NFC form has at least 12 code points', cases: [
    { password: 'abcdefghijkl', ok: true }, { password: 'abcdefghijk', ok: false }, { password: '', ok: false },
    { password: 'e\u0301'.repeat(11), ok: false, why: '11 letters, each with a combining accent: 11 code points in NFC' }, { password: 'e\u0301'.repeat(12), ok: true },
    { password: '\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67'.repeat(3), ok: true, why: 'three family emoji: 15 code points (3 on screen)' },
    { password: '\ud83d\ude00'.repeat(11), ok: false, why: '11 emoji: 11 code points (22 UTF-16 units)' },
  ] }

  // The kdf record a hub hands out: only the pinned set is accepted (account.ts acceptKdf; the same in the iOS app).
  const pinned = { alg: 'argon2id', v: 1, m: 65536, t: 3, p: 1 }
  v.kdf = {
    rule: 'A record is accepted only if alg, v, m, t and p are exactly those of pinned (other fields are ignored); no record (null) means pinned. Everything in refused is bad-kdf: nothing is derived with it.',
    pinned,
    accepted: [pinned, { ...pinned, note: 'another field' }, null],
    refused: [
      { ...pinned, m: 19456 }, { ...pinned, m: 8 }, { ...pinned, m: 65535 }, { ...pinned, m: 65537 }, { ...pinned, m: 2097152 }, { ...pinned, m: 4294967295 },
      { ...pinned, t: 1 }, { ...pinned, t: 2 }, { ...pinned, t: 4 }, { ...pinned, t: 20 }, { ...pinned, p: 2 }, { ...pinned, p: 8 }, { ...pinned, p: 0 },
      { ...pinned, v: 2 }, { ...pinned, v: 0 }, { ...pinned, alg: 'argon2i' }, { ...pinned, alg: 'argon2d' }, { ...pinned, alg: 'scrypt' }, { ...pinned, alg: 'Argon2id' },
      { ...pinned, m: '65536' }, { ...pinned, t: '3' }, { ...pinned, p: true }, { ...pinned, m: 65536.5 }, { ...pinned, m: null },
      { alg: 'argon2id', v: 1, t: 3, p: 1 }, { alg: 'argon2id', v: 1, m: 65536, t: 3 }, { v: 1, m: 65536, t: 3, p: 1 }, {}, [], 'argon2id', 1, true,
    ],
  }

  // What must not open: a copy in the earlier format (HKDF info without the 0x00, the wrap key's info equal to the
  // aad's label, first byte 0x01), and the same earlier keys under the current first byte.
  const old = l => Buffer.from(nodeCrypto.hkdfSync('sha256', master, salt, Buffer.from(l, 'utf8'), 32))
  const oldWrapKey = old('trommi/v1/account-wrap')
  v.refused = {
    oldAuthKeyB64u: b64u(old('trommi/v1/account-auth')),
    keyWrappedOldFormatB64u: b64u(seal(oldWrapKey, nonce, aad('password'), code, 1)),
    keyWrappedOldKeyB64u: b64u(seal(oldWrapKey, nonce, aad('password'), code, 2)),
    keyWrappedVersion1B64u: b64u(seal(wrapKey, nonce, aad('password'), code, 1)),
  }
  return v
}

/** The file as written: every character outside ASCII as \uXXXX, so no editor or tool can change a combining mark, a no-break space or a line separator in it. */
const asciiJson = v => JSON.stringify(v, null, 2).replace(/[^\x00-\x7f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`) + '\n'
const tests = []
const test = (name, fn) => tests.push([name, fn])
const rejects = async (fn, code) => { try { await fn() } catch (e) { assert.equal(e.code, code, `${e.code}: ${e.message}`); return } assert.fail(`expected ${code}, nothing thrown`) }

let built
test('account-vectors.json regenerates byte for byte (node:crypto, not account.ts)', () => {
  built = build()
  if (process.argv.includes('--write-vectors')) { fs.writeFileSync(VECTORS, asciiJson(built)); console.log(`  wrote ${VECTORS}`); return }
  assert.ok(fs.existsSync(VECTORS), 'spec/account-vectors.json is missing: run with --write-vectors')
  assert.equal(fs.readFileSync(VECTORS, 'utf8'), asciiJson(built))
})
const stored = () => (process.argv.includes('--write-vectors') ? JSON.parse(JSON.stringify(built)) : JSON.parse(fs.readFileSync(VECTORS, 'utf8')))
const rawKey = hexKey => crypto.subtle.importKey('raw', Buffer.from(hexKey, 'hex'), 'AES-GCM', false, ['encrypt', 'decrypt'])

test('labels: the constants of account.ts are the vectors\' labels', () => {
  const { rule, ...labels } = stored().labels
  assert.deepEqual({ ...A.ACCOUNT_LABEL }, labels)
  assert.equal(new Set(Object.values(labels)).size, Object.keys(labels).length, 'one use per label')
})
test('password: salt, master, auth key and the sealed copy (email as typed, password in NFD)', async () => {
  const p = stored().password
  assert.equal(A.normaliseEmail(p.email), p.normalisedEmail)
  assert.equal(hex(await A.masterKey(p.normalisedEmail, p.password)), p.master)
  const k = await A.passwordKeys(p.email, p.password)
  assert.equal(k.auth_key, p.authKeyB64u)
  assert.equal(await A.unwrapCode(k.wrap_key, p.roomId, p.keyWrappedB64u, 'password'), p.code)
  assert.equal((await A.passwordKeys(p.email, p.password.normalize('NFC'))).auth_key, p.authKeyB64u, 'composed and decomposed are one password')
  // What account.ts seals, the vectors' key opens (a fresh nonce each time).
  const mine = await A.wrapCode(k.wrap_key, p.roomId, p.code, 'password')
  assert.notEqual(mine, p.keyWrappedB64u)
  assert.equal(Buffer.from(mine, 'base64url')[0], 2)
  assert.equal(await A.unwrapCode(await rawKey(p.wrapKey), p.roomId, mine, 'password'), p.code)
})
test('passkey copy: the documented bytes open with WebCrypto (HKDF with the label, 0x00 and the credential id) and with core/passkey.ts', async () => {
  const v = stored(), k = v.passkey, un = h => Buffer.from(h, 'hex')
  const ikm = await crypto.subtle.importKey('raw', un(k.prfOutput), 'HKDF', false, ['deriveBits'])
  const info = Buffer.concat([Buffer.from(A.ACCOUNT_LABEL.passkeyWrapKey), Buffer.of(0), un(k.credentialId)])
  const raw = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: un(k.roomId), info }, ikm, 256))
  assert.equal(hex(raw), k.wrapKey)
  const blob = Buffer.from(k.keyWrappedB64u, 'base64url')
  assert.equal(blob[0], 2)
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt'])
  const code = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.subarray(1, 13), additionalData: un(k.aad) }, key, blob.subarray(13)))
  assert.equal(z.formatRecoveryCode(code), v.password.code)
  // and the client's own code (core/passkey.ts) derives the same key and opens the same copy
  assert.equal(await A.unwrapCodeWithPasskey(un(k.prfOutput), k.roomId, un(k.credentialId), k.keyWrappedB64u), v.password.code)
})
test('passkey copy: account.ts seals to the documented bytes; another prf output, room, credential id, kind or byte does not open it', async () => {
  const v = stored(), k = v.passkey, un = h => new Uint8Array(Buffer.from(h, 'hex'))
  const prf = un(k.prfOutput), id = un(k.credentialId), code = v.password.code
  const { wrap_key } = await A.passkeyKeys(prf, k.roomId, id)
  assert.equal(await A.wrapCode(wrap_key, k.roomId, code, 'passkey', id, un(k.nonce)), k.keyWrappedB64u)
  // a credential id of any length (WebAuthn: up to 1023 bytes) seals and opens
  for (const n of [1, 16, 32, 64, 1023]) {
    const cid = new Uint8Array(n).fill(n & 0xff)
    assert.equal(await A.unwrapCodeWithPasskey(prf, k.roomId, cid, await A.wrapCodeForPasskey(prf, k.roomId, cid, code)), code, `a ${n}-byte credential id`)
  }
  const other = prf.slice(); other[0] ^= 1
  await rejects(() => A.unwrapCodeWithPasskey(other, k.roomId, id, k.keyWrappedB64u), 'wrong-login')
  await rejects(() => A.unwrapCodeWithPasskey(prf, 'a8'.repeat(32), id, k.keyWrappedB64u), 'wrong-login')
  await rejects(() => A.unwrapCodeWithPasskey(prf, k.roomId, new Uint8Array([...id, 0]), k.keyWrappedB64u), 'wrong-login')
  await rejects(() => A.unwrapCode(wrap_key, k.roomId, k.keyWrappedB64u, 'passkey'), 'wrong-login')        // the credential id left out of the associated data
  await rejects(() => A.unwrapCode(wrap_key, k.roomId, k.keyWrappedB64u, 'password', id), 'wrong-login')   // the kind "password"
  const bent = Buffer.from(k.keyWrappedB64u, 'base64url'); bent[20] ^= 1
  await rejects(() => A.unwrapCodeWithPasskey(prf, k.roomId, id, bent.toString('base64url')), 'wrong-login')
  await rejects(() => A.unwrapCodeWithPasskey(prf, k.roomId, id, k.keyWrappedB64u.slice(4)), 'bad-format')
  // a prf output that is not 32 bytes is no key
  for (const bad of [new Uint8Array(31), new Uint8Array(33), new Uint8Array(0), null, 'x'.repeat(32)]) await rejects(() => A.passkeyKeys(bad, k.roomId, id), 'no-prf')
})
test('email: one rule over single characters, the same cases as the Swift code', () => {
  const { cases } = stored().email
  assert.ok(cases.length >= 38)
  for (const c of cases) {
    if (c.error) assert.throws(() => A.normaliseEmail(c.input), e => e.code === c.error, `${JSON.stringify(c.input)}: ${c.why}`)
    else {
      assert.equal(A.normaliseEmail(c.input), c.normalised, c.why)
      assert.equal(A.normaliseEmail(c.normalised), c.normalised, 'normalising twice changes nothing')
      assert.match(c.normalised, /^[\x21-\x7e]+$/)
    }
  }
  for (const other of [null, undefined, 7, {}, []]) assert.throws(() => A.normaliseEmail(other), e => e.code === 'bad-email')
  // Not in the file: a byte order mark in front (some JSON readers drop one at the start of a string).
  assert.throws(() => A.normaliseEmail('\ufeffowner@example.com'), e => e.code === 'bad-email')
})
test('password rule: 12 code points of the NFC form', () => {
  const r = stored().passwordRule
  assert.equal(A.PASSWORD_MIN, r.min)
  for (const c of r.cases) assert.equal(A.passwordProblem(c.password) === null, c.ok, JSON.stringify(c.password))
})
test('kdf: only the pinned parameter set is accepted from a hub; nothing is derived with another', async () => {
  const v = stored(), p = v.password
  assert.deepEqual({ ...A.ACCOUNT_KDF }, v.kdf.pinned)
  for (const k of v.kdf.accepted) assert.equal(A.acceptKdf(k), A.ACCOUNT_KDF, JSON.stringify(k))
  assert.equal(A.acceptKdf(undefined), A.ACCOUNT_KDF)
  for (const k of v.kdf.refused) {
    await rejects(async () => A.acceptKdf(k), 'bad-kdf')
    const t = performance.now()
    await rejects(() => A.masterKey(p.normalisedEmail, p.password, k), 'bad-kdf')
    await rejects(() => A.passwordKeys(p.email, p.password, k), 'bad-kdf')
    assert.ok(performance.now() - t < 50, `refused before any derivation: ${JSON.stringify(k)}`)
  }
  // A signed-in device that changes its password takes the record from the hub's answer: a hub that names its own cost is refused.
  const hub = kdf => ({ model: { room: { room_id: p.roomId } }, hub: { roomPath: x => x, request: async () => ({ email: p.normalisedEmail, revision: 1, key_wrapped: p.keyWrappedB64u, kdf }) } })
  await rejects(() => A.changePassword(hub({ ...v.kdf.pinned, m: 8, t: 1 }), { current: p.password, next: 'another-long-password' }), 'bad-kdf')
  await rejects(() => A.makeEmergencyKit(hub({ ...v.kdf.pinned, m: 2097152 }), { password: p.password }), 'bad-kdf')
})
test('Emergency Kit: auth key and the sealed copy from the twelve words, also as a person types them', async () => {
  const v = stored(), p = v.password, r = v.recovery
  for (const words of [r.words, r.wordsAsTyped]) {
    const k = await A.recoveryKeys(p.email, words)
    assert.equal(k.recovery_auth, r.recoveryAuthB64u)
    assert.equal(await A.unwrapCode(k.wrap_key, p.roomId, r.recoveryWrappedB64u, 'recovery'), p.code)
  }
})
test('refused: a copy of another kind, another room, the old labels, the old first byte', async () => {
  const v = stored(), p = v.password, r = v.recovery
  const key = await rawKey(p.wrapKey), kit = await rawKey(r.wrapKey)
  await rejects(() => A.unwrapCode(key, p.roomId, p.keyWrappedB64u, 'recovery'), 'wrong-login')
  await rejects(() => A.unwrapCode(kit, p.roomId, r.recoveryWrappedB64u, 'password'), 'wrong-login')
  await rejects(() => A.unwrapCode(kit, p.roomId, p.keyWrappedB64u, 'password'), 'wrong-login')
  await rejects(() => A.unwrapCode(key, 'a8'.repeat(32), p.keyWrappedB64u, 'password'), 'wrong-login')
  assert.notEqual(v.refused.oldAuthKeyB64u, p.authKeyB64u, 'the auth key of the old labels is another key')
  await rejects(() => A.unwrapCode(key, p.roomId, v.refused.keyWrappedOldFormatB64u, 'password'), 'bad-format')
  await rejects(() => A.unwrapCode(key, p.roomId, v.refused.keyWrappedVersion1B64u, 'password'), 'bad-format')
  await rejects(() => A.unwrapCode(key, p.roomId, v.refused.keyWrappedOldKeyB64u, 'password'), 'wrong-login')
})

let failed = 0
for (const [name, fn] of tests) {
  const t = performance.now()
  try { await fn(); console.log(`ok   ${name} (${(performance.now() - t).toFixed(0)} ms)`) }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.stack ?? e}`) }
}
console.log(failed ? `\n${failed} of ${tests.length} failed` : `\n${tests.length} of ${tests.length} tests passed`)
process.exit(failed ? 1 : 0)
