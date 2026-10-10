// The known answers of spec/vectors/account.json through the browser binding: the Emergency Kit of an account
// without an e-mail. node.mjs and web/page.mjs run it; tests/bindings/swift and facade.rs check the same file.
const unhex = text => Uint8Array.from(text.match(/../g) ?? [], byte => parseInt(byte, 16))
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
const check = (holds, what) => { if (!holds) throw new Error(`account vectors: ${what}`) }

/** Throws at the first answer that is not the vector's. Returns how many cases ran. */
export function accountVectors(core, vectors) {
  check(core.accountIdParse(vectors.account_id_text) === vectors.account_id_text, 'the id is not its own text')
  // What typing adds is tidied away; what the vectors refuse stays refused unless tidying makes an id of it.
  const typed = vectors.account_id_text.toUpperCase().replaceAll('-', ' ')
  check(core.accountIdParse(` ${typed} `) === vectors.account_id_text, 'a typed id was not tidied')
  for (const text of ['', vectors.account_id_text.slice(1), vectors.account_id_text + '0', vectors.account_id_text.replace(/.$/, 'g'), `{${vectors.account_id_text}}`, `urn:uuid:${vectors.account_id_text}`]) {
    let refused = null
    try { core.accountIdParse(text) } catch (error) { refused = error.code }
    check(refused === 'bad-format', `${JSON.stringify(text)} was read as an id`)
  }
  // The keys' own call takes the one text form only.
  for (const { text } of vectors.refused_id_texts) {
    let refused = null
    try { core.kitKeysFor({ id: text }, vectors.words) } catch (error) { refused = error.code }
    check(refused === 'bad-format', `${JSON.stringify(text)} named an account`)
  }
  for (const entry of vectors.cases) {
    const keys = core.kitKeysFor(entry.account, vectors.words)
    check(hex(keys.authKey) === entry.auth_key && hex(keys.wrapKey) === entry.wrap_key, `the keys of "${entry.why}"`)
    let result
    try {
      result = `opens: ${hex(core.openRecoveryCode(keys.wrapKey, unhex(vectors.room_id), 'kit', null, unhex(vectors.sealed)))}`
    } catch (error) { result = error.code }
    check(result === entry.result, `"${entry.why}" gave ${result}`)
  }
  let both = null
  try { core.kitKeysFor({ email: 'owner@example.com', id: vectors.account_id_text }, vectors.words) } catch (error) { both = error.code }
  check(both === 'bad-format', 'an account was named twice')
  return vectors.cases.length
}
