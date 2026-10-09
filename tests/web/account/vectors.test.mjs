// The account's known answers (spec/account-vectors.json) through the REAL core's binding, as account.ts calls it:
// the password's keys, the kit's keys, a passkey's wrap key, and each sealed copy opened. This is what proves that
// the app on the v2 core still opens the copies an account already holds. Then the page's own light checks
// (app/web/core/passwords.ts, passkey.ts, wordlist.ts) against the core, so that the two cannot drift apart.
//
//   node --test tests/web/account/vectors.test.mjs        (the binding built: core/wasm/build.sh)
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { core, no_core, b64u, hex, unb64u, unhex, bytes } from './setup.mjs'
import * as page from '../../../app/web/core/passwords.ts'
import { PASSKEY_PRF_INPUT } from '../../../app/web/core/passkey.ts'
import { WORDS } from '../../../app/web/core/wordlist.ts'

const skip = no_core ?? false
const V = JSON.parse(await readFile(new URL('../../../spec/account-vectors.json', import.meta.url), 'utf8'))
const codeOf = error => error?.code
const refuses = (run, code) => assert.throws(run, e => codeOf(e) === code, `refused with ${code}`)

test('password: the e-mail as kept, both keys, the sealed copy opens to the code', { skip }, () => {
  const p = V.password, room = unhex(p.roomId)
  assert.equal(core.normaliseEmail(p.email), p.normalisedEmail)
  assert.deepEqual(JSON.parse(core.kdfRecord()), p.kdf)
  const keys = core.passwordKeys(p.email, p.password, JSON.stringify(p.kdf))
  assert.equal(b64u(keys.authKey), p.authKeyB64u)
  assert.equal(hex(keys.wrapKey), p.wrapKey)
  // no record from the hub is the pinned one
  assert.deepEqual(core.passwordKeys(p.normalisedEmail, p.password), keys)
  const code = core.openRecoveryCode(keys.wrapKey, room, 'password', null, unb64u(p.keyWrappedB64u))
  assert.equal(hex(code), p.codeRaw)
  assert.equal(core.formatRecoveryCode(code), p.code)
  assert.deepEqual(core.parseRecoveryCode(p.code.toLowerCase().replaceAll('-', ' ')), code)
})

test('Emergency Kit: the words as typed, both keys, the sealed copy opens to the code', { skip }, () => {
  const r = V.recovery, p = V.password, room = unhex(p.roomId)
  assert.equal(core.parseKitWords(r.wordsAsTyped), r.words)
  const keys = core.kitKeys(p.email, r.wordsAsTyped)
  assert.equal(b64u(keys.authKey), r.recoveryAuthB64u)
  assert.equal(hex(keys.wrapKey), r.wrapKey)
  assert.equal(hex(core.openRecoveryCode(keys.wrapKey, room, 'kit', null, unb64u(r.recoveryWrappedB64u))), p.codeRaw)
})

test('passkey: the prf input, the wrap key, the sealed copy opens to the code', { skip }, () => {
  const k = V.passkey, room = unhex(k.roomId), id = unhex(k.credentialId)
  assert.equal(new TextDecoder().decode(core.passkeyPrfInput()), k.prfInput)
  const wrap = core.passkeyWrapKey(unhex(k.prfOutput), room, id)
  assert.equal(hex(wrap), k.wrapKey)
  assert.equal(hex(core.openRecoveryCode(wrap, room, 'passkey', id, unb64u(k.keyWrappedB64u))), V.password.codeRaw)
  refuses(() => core.passkeyWrapKey(new Uint8Array(0), room, id), 'no-prf')
  refuses(() => core.passkeyWrapKey(new Uint8Array(31), room, id), 'no-prf')
})

test('a copy opens only as what it was sealed for: the way in, the room, the passkey', { skip }, () => {
  const p = V.password, k = V.passkey, room = unhex(p.roomId), other = bytes(32)
  const wrap = unhex(p.wrapKey), copy = unb64u(p.keyWrappedB64u)
  refuses(() => core.openRecoveryCode(wrap, other, 'password', null, copy), 'wrong-login')
  refuses(() => core.openRecoveryCode(wrap, room, 'kit', null, copy), 'wrong-recovery')
  refuses(() => core.openRecoveryCode(wrap, room, 'passkey', unhex(k.credentialId), copy), 'wrong-login')
  refuses(() => core.openRecoveryCode(unhex(k.wrapKey), room, 'passkey', bytes(20), unb64u(k.keyWrappedB64u)), 'wrong-login')
  // the copies v1 refused stay refused: the older format is not converted, the older key opens nothing
  refuses(() => core.openRecoveryCode(wrap, room, 'password', null, unb64u(V.refused.keyWrappedVersion1B64u)), 'bad-format')
  refuses(() => core.openRecoveryCode(wrap, room, 'password', null, unb64u(V.refused.keyWrappedOldFormatB64u)), 'bad-format')
  refuses(() => core.openRecoveryCode(wrap, room, 'password', null, unb64u(V.refused.keyWrappedOldKeyB64u)), 'wrong-login')
  assert.notEqual(V.refused.oldAuthKeyB64u, p.authKeyB64u)
})

test('a fresh copy of each way opens again, and is 61 bytes beginning with 0x02', { skip }, () => {
  const room = bytes(32), code = core.generateRecoveryCode(), id = bytes(64)
  for (const [way, credential] of [['password', null], ['kit', null], ['passkey', id]]) {
    const wrap = bytes(32), copy = core.sealRecoveryCode(wrap, room, way, credential, code)
    assert.deepEqual([copy.length, copy[0]], [61, 2])
    assert.deepEqual(core.openRecoveryCode(wrap, room, way, credential, copy), code)
    assert.notDeepEqual(core.sealRecoveryCode(wrap, room, way, credential, code), copy, 'a fresh nonce each time')
  }
})

test('the key derivation record: only the pinned one is derived with', { skip }, () => {
  const p = V.password
  for (const record of V.kdf.refused) refuses(() => core.passwordKeys(p.email, p.password, JSON.stringify(record)), 'bad-kdf')
  refuses(() => core.passwordKeys(p.email, p.password, 'not json'), 'bad-kdf')
  refuses(() => core.passwordKeys(p.email, p.password, JSON.stringify({ ...V.kdf.pinned, pad: 'x'.repeat(1024) })), 'bad-kdf')
  for (const record of V.kdf.accepted) assert.equal(b64u(core.passwordKeys(p.email, p.password, JSON.stringify(record)).authKey), p.authKeyB64u)
})

// ---- the page's light checks against the core

const coreEmail = text => { try { return core.normaliseEmail(text) } catch (e) { return codeOf(e) } }
const pageEmail = text => { try { return page.normaliseEmail(text) } catch (e) { return codeOf(e) } }

test('the e-mail rule: the vectors, by the core and by the page alike', { skip }, () => {
  assert.ok(V.email.cases.length >= 30)
  for (const c of V.email.cases) {
    const expected = c.normalised ?? 'bad-email'
    assert.equal(coreEmail(c.input), expected, `core: ${JSON.stringify(c.input)} (${c.why})`)
    assert.equal(pageEmail(c.input), expected, `page: ${JSON.stringify(c.input)} (${c.why})`)
  }
})

test('the e-mail rule: 20 000 made-up addresses, the page says what the core says', { skip }, () => {
  // a small alphabet, so that the cases near the rule's edges (dots, a second @, blanks, capitals, other characters) are common
  const alphabet = ['a', 'B', 'z', '0', '.', '.', '@', '@', '-', '_', ' ', '\t', '\n', 'é', ' ', ' ', '+', '/']
  let seed = 20261009, accepted = 0
  const next = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n }
  const run = max => Array.from({ length: next(max) }, () => alphabet[next(alphabet.length)]).join('')
  const long = n => 'a'.repeat(n)
  for (let i = 0; i < 20_000; i++) {
    const text = i % 4 === 0 ? `${run(4)}${long(next(70))}@${long(next(200))}.${long(next(70))}${run(3)}` : i % 4 === 1 ? `${run(6)}@${run(6)}.${run(5)}` : run(24)
    const said = coreEmail(text)
    if (said !== 'bad-email') accepted += 1
    assert.equal(pageEmail(text), said, JSON.stringify(text))
  }
  assert.ok(accepted > 500 && accepted < 19_500, `both answers are common among them (${accepted} accepted)`)
})

test('the password rule: the vectors, by the core and by the page alike', { skip }, () => {
  assert.equal(page.PASSWORD_MIN, V.passwordRule.min)
  const more = [{ password: '', ok: false }, { password: 'é'.repeat(12), ok: true }, { password: 'é'.repeat(11), ok: false }, { password: '😀'.repeat(12), ok: true }, { password: '😀'.repeat(11), ok: false }]
  for (const c of [...V.passwordRule.cases, ...more]) {
    let byCore = true
    try { core.checkPassword(c.password) } catch (e) { assert.equal(codeOf(e), 'weak-password'); byCore = false }
    assert.equal(byCore, c.ok, `core: ${JSON.stringify(c.password)}`)
    assert.equal(page.passwordProblem(c.password) === null, c.ok, `page: ${JSON.stringify(c.password)}`)
  }
})

test('the kit\'s words: the page counts them, the core knows them; the page never lets through fewer than the core takes', { skip }, () => {
  const r = V.recovery
  assert.equal(page.parseRecoveryWords(r.wordsAsTyped), r.words)
  const cases = [r.words, r.wordsAsTyped, r.words.toUpperCase(), r.words.replaceAll(' ', ' - '), `${r.words} acorn`, r.words.split(' ').slice(1).join(' '), '', 'acorn', r.words.replace('acorn', 'acorm'), r.words.replace('acorn', 'äcorn'), r.words.replace(' ', '')]
  for (const text of cases) {
    let byCore = null, byPage = null
    try { byCore = core.parseKitWords(text) } catch (e) { assert.equal(codeOf(e), 'bad-recovery-words') }
    try { byPage = page.parseRecoveryWords(text) } catch (e) { assert.equal(codeOf(e), 'bad-recovery-words') }
    // what the core takes, the page lets through, and as the same text
    if (byCore !== null) assert.equal(byPage, byCore, JSON.stringify(text))
  }
  // a word that is none passes the page's count and is refused by the core: the core decides
  const typo = r.words.replace('acorn', 'acorm')
  assert.equal(page.parseRecoveryWords(typo), typo)
  refuses(() => core.parseKitWords(typo), 'bad-recovery-words')
})

test('the word list of generated passwords is the core\'s list of the kit', { skip }, () => {
  assert.equal(WORDS.length, 7772)
  assert.equal(new Set(WORDS).size, 7772)
  // twelve at a time through the core: it refuses a text with a word that is not on its list
  for (let i = 0; i < WORDS.length; i += 12) {
    const twelve = Array.from({ length: 12 }, (_, j) => WORDS[(i + j) % WORDS.length]).join(' ')
    assert.equal(core.parseKitWords(twelve), twelve)
  }
  for (let i = 0; i < 20; i++) for (const word of core.generateKitWords().split(' ')) assert.ok(WORDS.includes(word), word)
})

test('a generated password: five words of the list, and long enough by both rules', { skip }, () => {
  for (let i = 0; i < 50; i++) {
    const password = page.generatePassword(), words = password.split('-')
    assert.equal(words.length, 5)
    for (const word of words) assert.ok(WORDS.includes(word), word)
    assert.equal(page.passwordProblem(password), null)
    core.checkPassword(password)
  }
  assert.notEqual(page.generatePassword(), page.generatePassword())
})

test('the prf input the page asks a passkey with is the core\'s', { skip }, () => {
  assert.deepEqual(new Uint8Array(PASSKEY_PRF_INPUT), core.passkeyPrfInput())
})

test('codes and words: fresh each time, and what is shown is read back', { skip }, () => {
  const code = core.generateRecoveryCode(), shown = core.formatRecoveryCode(code)
  assert.equal(code.length, 32)
  assert.match(shown, /^([0-9A-HJKMNP-TV-Z]{4}-){12}[0-9A-HJKMNP-TV-Z]{4}$/)
  assert.deepEqual(core.parseRecoveryCode(shown), code)
  assert.notDeepEqual(core.generateRecoveryCode(), code)
  refuses(() => core.parseRecoveryCode('TRMI-4K7Q'), 'bad-recovery-code')
  const words = core.generateKitWords()
  assert.equal(words.split(' ').length, 12)
  assert.equal(core.parseKitWords(words), words)
  assert.notEqual(core.generateKitWords(), words)
  assert.equal(core.generateUserHandle().length, 32)
})
