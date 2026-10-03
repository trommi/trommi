// Passkey (WebAuthn) login for the hub. No packages: node:crypto for the signatures, a minimal CBOR decoder
// for the attestation object and the COSE key, and a table of its own in the hub's database (data/pad.db).
//
// What it gives: a browser that reaches the hub without the login cookie gets a small sign-in page; a passkey
// that was added before, from a browser that was already signed in, sets the same cookie the login link sets.
// The link from data/url.txt and the admin key work as they did.
//
//   POST /auth/passkey/login/options                         -> { challenge, timeout, userVerification }
//   POST /auth/passkey/login/verify     { id, clientDataJSON, authenticatorData, signature }   -> sets the cookie
//   POST /auth/passkey/register/options                      signed in only
//   POST /auth/passkey/register/verify  { clientDataJSON, attestationObject, name }             signed in only
//   GET  /auth/passkey/list                                  signed in only: [{ handle, name, host, created, last_used }]
//   POST /auth/passkey/remove           { handle }           signed in only
//   GET  /auth/passkey.js                                    the script of the two pages
//   GET  /passkeys                                           signed in: the page to add, list and remove passkeys
//
// Checked on every ceremony: the challenge (random, the hub's own, one use, two minutes), the type, the origin
// against the hub's configured addresses (never the Host header), the rpId hash against that origin's host, the
// user-present flag, the signature (ES256, RS256, EdDSA), and that the signature counter did not go back.
// Only public keys are stored. Credential ids and keys never appear in the board's state or in the log.
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const CHALLENGE_TTL = 2 * 60 * 1000
const CHALLENGES_MAX = 500
const FAILS_MAX = 10          // failed sign-ins per minute, all callers together (adding a passkey needs the login anyway)
const FAILS_WINDOW = 60 * 1000
const PASSKEYS_MAX = 50
const b64u = bytes => Buffer.from(bytes).toString('base64url')
const unb64u = text => {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) throw refuse(400, 'bad-format')
  return Buffer.from(text, 'base64url')
}
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest()
const refuse = (status, code) => Object.assign(new Error(code), { status, code })

// ---- CBOR, as far as an attestation object and a COSE key need it ------------------------------------------
// Unsigned and negative integers, byte and text strings, arrays, maps, false / true / null. Definite lengths only.
export function cborDecode(bytes, at = 0, depth = 0) {
  if (depth > 8 || at >= bytes.length) throw refuse(400, 'bad-cbor')
  const first = bytes[at++]
  const major = first >> 5, info = first & 31
  let n
  if (info < 24) n = info
  else if (info === 24) { n = bytes[at]; at += 1 }
  else if (info === 25) { n = bytes.readUInt16BE(at); at += 2 }
  else if (info === 26) { n = bytes.readUInt32BE(at); at += 4 }
  else if (info === 27) { n = Number(bytes.readBigUInt64BE(at)); at += 8 }
  else throw refuse(400, 'bad-cbor')
  if (at > bytes.length || !Number.isSafeInteger(n)) throw refuse(400, 'bad-cbor')
  if (major === 0) return [n, at]
  if (major === 1) return [-1 - n, at]
  if (major === 2 || major === 3) {
    if (at + n > bytes.length) throw refuse(400, 'bad-cbor')
    const slice = bytes.subarray(at, at + n)
    return [major === 2 ? Buffer.from(slice) : slice.toString('utf8'), at + n]
  }
  if (major === 4) {
    if (n > 64) throw refuse(400, 'bad-cbor')
    const list = []
    for (let i = 0; i < n; i++) { let v; [v, at] = cborDecode(bytes, at, depth + 1); list.push(v) }
    return [list, at]
  }
  if (major === 5) {
    if (n > 64) throw refuse(400, 'bad-cbor')
    const map = new Map()
    for (let i = 0; i < n; i++) {
      let k, v
      ;[k, at] = cborDecode(bytes, at, depth + 1)
      ;[v, at] = cborDecode(bytes, at, depth + 1)
      map.set(k, v)
    }
    return [map, at]
  }
  if (major === 7 && info >= 20 && info <= 22) return [info === 21 ? true : info === 20 ? false : null, at]
  throw refuse(400, 'bad-cbor')
}

// A COSE public key as { alg, jwk }: ES256 (-7, P-256), RS256 (-257), EdDSA (-8, Ed25519). Anything else is refused.
export function coseToJwk(cose) {
  if (!(cose instanceof Map)) throw refuse(400, 'bad-key')
  const kty = cose.get(1), alg = cose.get(3)
  const bin = (label, length) => {
    const v = cose.get(label)
    if (!Buffer.isBuffer(v) || (length && v.length !== length)) throw refuse(400, 'bad-key')
    return b64u(v)
  }
  let jwk
  if (kty === 2 && alg === -7 && cose.get(-1) === 1) jwk = { kty: 'EC', crv: 'P-256', x: bin(-2, 32), y: bin(-3, 32) }
  else if (kty === 3 && alg === -257) jwk = { kty: 'RSA', n: bin(-1), e: bin(-2) }
  else if (kty === 1 && alg === -8 && cose.get(-1) === 6) jwk = { kty: 'OKP', crv: 'Ed25519', x: bin(-2, 32) }
  else throw refuse(400, 'unsupported-key')
  // Throws for a point that is not on the curve or a key that is none.
  try { crypto.createPublicKey({ key: jwk, format: 'jwk' }) } catch { throw refuse(400, 'bad-key') }
  if (alg === -257 && Buffer.from(jwk.n, 'base64url').length < 256) throw refuse(400, 'bad-key')
  return { alg, jwk }
}

function verifySignature(alg, jwk, data, signature) {
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' })
  try {
    if (alg === -7) return crypto.verify('sha256', data, { key, dsaEncoding: 'der' }, signature)
    if (alg === -257) return crypto.verify('sha256', data, { key, padding: crypto.constants.RSA_PKCS1_PADDING }, signature)
    if (alg === -8) return crypto.verify(null, data, key, signature)
  } catch {}
  return false
}

// rpIdHash (32) | flags (1) | signCount (4) | [aaguid (16) | credIdLen (2) | credId | COSE key]
function parseAuthData(data) {
  if (!Buffer.isBuffer(data) || data.length < 37) throw refuse(400, 'bad-authenticator-data')
  const flags = data[32]
  const out = { rpIdHash: data.subarray(0, 32), userPresent: Boolean(flags & 0x01), userVerified: Boolean(flags & 0x04), attested: Boolean(flags & 0x40), signCount: data.readUInt32BE(33) }
  if (out.attested) {
    if (data.length < 55) throw refuse(400, 'bad-authenticator-data')
    const length = data.readUInt16BE(53)
    if (length < 1 || length > 1023 || data.length < 55 + length) throw refuse(400, 'bad-authenticator-data')
    out.credentialId = Buffer.from(data.subarray(55, 55 + length))
    const [cose] = cborDecode(data, 55 + length)
    out.cose = cose
  }
  return out
}

/**
 * passkeys({ file, origins, name }) -> { enabled, route, signInPage, close }.
 * `origins`: the addresses the hub is reached under (scheme://host[:port]); a ceremony from any other is refused.
 * `route(req, res, url, { authed, sameOrigin, readJson, send, login, audit })` answers /auth/passkey… and /passkeys
 * and returns true, or false for a path that is not its own. `login(res)` sets the board's cookie.
 */
export function passkeys({ file, origins, publicUrls = [], name = 'Trommi', now = Date.now }) {
  const allowed = new Map()   // origin -> rpId
  for (const o of origins) try { const u = new URL(o); allowed.set(u.origin, u.hostname) } catch {}
  // A passkey belongs to the host it was made on. Where the hub has a public address, passkeys are made there
  // only: one made on localhost would be of no use on the phone. Signing in works wherever a passkey fits.
  const home = []
  for (const o of publicUrls) try { home.push(new URL(o).origin) } catch {}
  const mustMove = origin => home.length > 0 && !home.includes(origin)
  const db = new DatabaseSync(file)
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS passkeys (id TEXT PRIMARY KEY, rp_id TEXT NOT NULL, alg INTEGER NOT NULL, jwk TEXT NOT NULL,
      sign_count INTEGER NOT NULL, name TEXT NOT NULL, created INTEGER NOT NULL, last_used INTEGER) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS passkey_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
  `)
  const q = {
    all: db.prepare('SELECT id, rp_id, name, created, last_used FROM passkeys ORDER BY created'),
    one: db.prepare('SELECT * FROM passkeys WHERE id = ?'),
    add: db.prepare('INSERT INTO passkeys (id, rp_id, alg, jwk, sign_count, name, created) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    used: db.prepare('UPDATE passkeys SET sign_count = ?, last_used = ? WHERE id = ?'),
    drop: db.prepare('DELETE FROM passkeys WHERE id = ?'),
    meta: db.prepare('SELECT value FROM passkey_meta WHERE key = ?'),
    setMeta: db.prepare('INSERT OR IGNORE INTO passkey_meta (key, value) VALUES (?, ?)'),
  }
  // One user: every passkey of this hub opens the same board.
  q.setMeta.run('user', b64u(crypto.randomBytes(16)))
  const userHandle = q.meta.get('user').value
  // What the page names a passkey by: not its credential id.
  const handleOf = id => sha256(Buffer.from(id)).toString('hex').slice(0, 12)

  const challenges = new Map()   // challenge -> { kind, expires }
  function newChallenge(kind) {
    for (const [c, v] of challenges) if (now() > v.expires) challenges.delete(c)
    while (challenges.size >= CHALLENGES_MAX) challenges.delete(challenges.keys().next().value)
    const challenge = b64u(crypto.randomBytes(32))
    challenges.set(challenge, { kind, expires: now() + CHALLENGE_TTL })
    return challenge
  }
  let fails = []
  const tooMany = () => { fails = fails.filter(t => now() - t < FAILS_WINDOW); return fails.length >= FAILS_MAX }

  // The part both ceremonies share. Returns the rpId the browser acted for.
  function checkClientData(raw, type, kind) {
    let data
    try { data = JSON.parse(raw.toString('utf8')) } catch { throw refuse(400, 'bad-client-data') }
    if (data?.type !== type) throw refuse(400, 'wrong-type')
    // The challenge is spent by the first look at it, whatever comes of the rest.
    const known = typeof data.challenge === 'string' ? challenges.get(data.challenge) : null
    challenges.delete(data.challenge)
    if (!known || known.kind !== kind || now() > known.expires) throw refuse(400, 'bad-challenge')
    const rpId = allowed.get(data.origin)
    if (!rpId || data.crossOrigin === true) throw refuse(403, 'wrong-origin')
    return rpId
  }

  function register(body) {
    if (q.all.all().length >= PASSKEYS_MAX) throw refuse(409, 'too-many-passkeys')
    const rpId = checkClientData(unb64u(body.clientDataJSON), 'webauthn.create', 'register')
    const [att] = cborDecode(unb64u(body.attestationObject))
    if (!(att instanceof Map)) throw refuse(400, 'bad-attestation')
    // Attestation "none" is asked for; a statement that comes anyway is not looked at.
    const auth = parseAuthData(att.get('authData'))
    if (!auth.rpIdHash.equals(sha256(rpId))) throw refuse(403, 'wrong-rp')
    if (!auth.userPresent) throw refuse(400, 'user-not-present')
    if (!auth.attested) throw refuse(400, 'no-credential')
    const { alg, jwk } = coseToJwk(auth.cose)
    const id = b64u(auth.credentialId)
    if (q.one.get(id)) throw refuse(409, 'already-registered')
    const label = String(body.name ?? '').trim().slice(0, 60) || 'Passkey'
    q.add.run(id, rpId, alg, JSON.stringify(jwk), auth.signCount, label, now())
    return { handle: handleOf(id), name: label }
  }

  function signIn(body) {
    const clientData = unb64u(body.clientDataJSON)
    const rpId = checkClientData(clientData, 'webauthn.get', 'login')
    const authData = unb64u(body.authenticatorData)
    const auth = parseAuthData(authData)
    if (!auth.rpIdHash.equals(sha256(rpId))) throw refuse(403, 'wrong-rp')
    if (!auth.userPresent) throw refuse(400, 'user-not-present')
    const cred = typeof body.id === 'string' ? q.one.get(body.id) : null
    // An unknown passkey and one made for another address of the hub are told apart from nothing else.
    if (!cred || cred.rp_id !== rpId) throw refuse(401, 'unknown-passkey')
    if (!verifySignature(cred.alg, JSON.parse(cred.jwk), Buffer.concat([authData, sha256(clientData)]), unb64u(body.signature))) throw refuse(401, 'bad-signature')
    // A counter that does not move forward means a copy of the authenticator. Authenticators that do not count send 0.
    if ((auth.signCount || cred.sign_count) && auth.signCount <= cred.sign_count) throw refuse(401, 'counter-went-back')
    q.used.run(auth.signCount, now(), cred.id)
    return { handle: handleOf(cred.id), name: cred.name }
  }

  const list = () => q.all.all().map(p => ({ handle: handleOf(p.id), name: p.name, host: p.rp_id, created: p.created, last_used: p.last_used }))

  async function route(req, res, url, { authed, sameOrigin, readJson, send, login, audit = () => {} }) {
    const p = url.pathname
    if (req.method === 'GET' && p === '/auth/passkey.js') return send(res, 200, PAGE_SCRIPT, 'text/javascript; charset=utf-8'), true
    if (req.method === 'GET' && p === '/passkeys') {
      if (!authed(req)) return false
      return sendPage(res, 200, managePage(name, home)), true
    }
    if (!p.startsWith('/auth/passkey/')) return false
    const what = p.slice('/auth/passkey/'.length)
    const json = (code, body) => send(res, code, JSON.stringify(body))
    try {
      if (req.method === 'GET' && what === 'list') {
        if (!authed(req)) throw refuse(401, 'unauthorised')
        return json(200, { passkeys: list() }), true
      }
      if (req.method !== 'POST') throw refuse(404, 'not-found')
      // A write comes from one of the hub's own pages: the Origin is one of its addresses and names this host.
      if (!allowed.has(req.headers.origin) || !sameOrigin(req)) throw refuse(403, 'forbidden')
      const open = what === 'login/options' || what === 'login/verify'
      if (!open && !authed(req)) throw refuse(401, 'unauthorised')
      if (what === 'login/verify' && tooMany()) throw refuse(429, 'too-many-attempts')
      if ((what === 'register/options' || what === 'register/verify') && mustMove(req.headers.origin)) return json(409, { error: 'use-public-address', public: `${home[0]}/passkeys` }), true
      const body = await readJson(req, 64 * 1024)
      if (what === 'login/options') return json(200, { challenge: newChallenge('login'), timeout: CHALLENGE_TTL, userVerification: 'preferred' }), true
      if (what === 'register/options') {
        return json(200, {
          challenge: newChallenge('register'), timeout: CHALLENGE_TTL, rp: { name },
          user: { id: userHandle, name: name.toLowerCase(), displayName: name },
          pubKeyCredParams: [-7, -8, -257].map(alg => ({ type: 'public-key', alg })),
          authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'preferred' },
          attestation: 'none',
          // So that one authenticator does not hold two passkeys for this board.
          excludeCredentials: q.all.all().filter(c => c.rp_id === allowed.get(req.headers.origin)).map(c => ({ type: 'public-key', id: c.id })),
        }), true
      }
      if (what === 'login/verify') {
        let who
        try { who = signIn(body) } catch (err) { fails.push(now()); throw err }
        login(res)
        audit(req, 'passkey-login', who.name)
        return json(200, { ok: true }), true
      }
      if (what === 'register/verify') {
        const made = register(body)
        audit(req, 'passkey-added', made.name)
        return json(200, { ok: true, ...made }), true
      }
      if (what === 'remove') {
        const hit = q.all.all().find(c => handleOf(c.id) === body.handle)
        if (!hit) throw refuse(404, 'not-found')
        q.drop.run(hit.id)
        audit(req, 'passkey-removed', hit.name)
        return json(200, { ok: true }), true
      }
      throw refuse(404, 'not-found')
    } catch (err) {
      // What went wrong is a word, never the credential or the key.
      json(err.status ?? 400, { error: err.code ?? 'bad-request' })
      return true
    }
  }

  return { route, list, signInPage: () => signInPage(name), close: () => db.close() }
}

// ---- the two pages ---------------------------------------------------------------------------------------

// Nothing from elsewhere, no inline script; the style is the page's own.
const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
export function sendPage(res, code, html) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': PAGE_CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' })
  res.end(html)
}

const esc = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const STYLE = `
:root { color-scheme: light dark; --bg: #f6f5f1; --card: #fff; --ink: #1c1b19; --soft: #6b6862; --line: #dddad2; --accent: #1c1b19; --on: #fff; --bad: #b3261e }
@media (prefers-color-scheme: dark) { :root { --bg: #151514; --card: #1f1e1d; --ink: #eceae5; --soft: #a19d95; --line: #35332f; --accent: #eceae5; --on: #151514; --bad: #f2b8b5 } }
* { box-sizing: border-box }
[hidden] { display: none !important }
a { overflow-wrap: anywhere }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif }
main { width: 100%; max-width: 400px; background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 28px 24px }
h1 { margin: 0 0 4px; font-size: 22px; font-weight: 650; letter-spacing: -0.01em }
p { margin: 0 0 16px; color: var(--soft) }
button { font: inherit; cursor: pointer; border-radius: 10px; border: 1px solid var(--line); background: transparent; color: var(--ink); padding: 8px 12px }
button.main { width: 100%; min-height: 52px; padding: 12px 16px; font-size: 17px; background: var(--accent); color: var(--on); border-color: var(--accent); font-weight: 600 }
button:disabled { opacity: 0.55; cursor: default }
button:focus-visible, a:focus-visible, input:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px }
input { font: inherit; width: 100%; padding: 10px 12px; margin: 0 0 12px; border-radius: 10px; border: 1px solid var(--line); background: transparent; color: var(--ink) }
label { display: block; font-size: 14px; color: var(--soft); margin: 0 0 4px }
.note { font-size: 14px; margin: 16px 0 0 }
.error { color: var(--bad); font-size: 14px; margin: 12px 0 0; min-height: 1.5em }
code { font: 14px ui-monospace, SFMono-Regular, Menlo, monospace }
ul { list-style: none; margin: 0 0 20px; padding: 0 }
li { display: flex; gap: 12px; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid var(--line) }
li small { display: block; color: var(--soft) }
a { color: inherit }
`
const shell = (title, mode, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body data-passkey="${mode}"><main>${body}</main><script src="/auth/passkey.js"></script></body></html>`

const signInPage = name => shell(`${name}: sign in`, 'sign-in', `
<h1>${esc(name)}</h1>
<p>Sign in to open the board.</p>
<button class="main" id="go" type="button">Sign in with a passkey</button>
<p class="error" id="error" role="alert"></p>
<p class="note">No passkey on this device yet? Open the board once with the link from <code>data/url.txt</code>; that link still works. Then add a passkey at <code>/passkeys</code>.</p>`)

const managePage = (name, home = []) => shell(`${name}: passkeys`, 'manage', `
<h1>Passkeys</h1>
<p>A passkey signs you in to ${esc(name)} without the link, on this device and, if your password manager or phone syncs it, on your others.</p>
<ul id="list"></ul>
<div id="add">
<label for="name">Name for this passkey</label>
<input id="name" maxlength="60" autocomplete="off" placeholder="e.g. 1Password, Phone">
<button class="main" id="go" type="button">Add a passkey on this device</button>
</div>
<div id="move" hidden data-home="${esc(home.join(' '))}">
<p>A passkey only works at the address it was made for. Add it at the board's public address, so that it also works on your phone:</p>
<p><a id="home" href="${esc(home[0] ?? '')}/passkeys">${esc(home[0] ?? '')}/passkeys</a></p>
<p class="note">If that page asks you to sign in: open the <code>https</code> link from <code>data/url.txt</code> once in this browser, then come back to it.</p>
</div>
<p class="error" id="error" role="alert"></p>
<p class="note"><a href="/">Back to the board</a></p>`)

const PAGE_SCRIPT = `// Sign-in and passkey pages of the hub (server/passkey.mjs).
const mode = document.body.dataset.passkey
const $ = id => document.getElementById(id)
const enc = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '')
const dec = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
const post = async (route, body = {}) => {
  const res = await fetch('/auth/passkey/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const out = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(out.error || 'failed'), { code: out.error })
  return out
}
const WORDS = {
  'unknown-passkey': 'This passkey is not known to this board. Open the board with the link once and add it.',
  'too-many-attempts': 'Too many attempts. Wait a minute and try again.',
  'bad-challenge': 'That took too long. Try again.',
  'wrong-origin': 'This address is not one the board is set up for.',
  'already-registered': 'This passkey is already added.',
  'unauthorised': 'Sign in first.',
  'use-public-address': 'Add the passkey at the public address of the board.',
}
const say = err => { $('error').textContent = err ? (err.name === 'NotAllowedError' ? 'Nothing was chosen. Try again.' : err.name === 'InvalidStateError' ? WORDS['already-registered'] : WORDS[err.code] || 'That did not work. Try again, or use the link.') : '' }
const busy = on => { $('go').disabled = on }
if (!window.PublicKeyCredential) { $('go').disabled = true; $('error').textContent = 'This browser has no passkeys, or the page is not on https. Use the link.' }

async function signIn() {
  say(); busy(true)
  try {
    const o = await post('login/options')
    const cred = await navigator.credentials.get({ publicKey: { challenge: dec(o.challenge), timeout: o.timeout, userVerification: o.userVerification } })
    await post('login/verify', { id: cred.id, clientDataJSON: enc(cred.response.clientDataJSON), authenticatorData: enc(cred.response.authenticatorData), signature: enc(cred.response.signature) })
    location.reload()
  } catch (err) { say(err); busy(false) }
}

async function add() {
  say(); busy(true)
  try {
    const o = await post('register/options')
    const cred = await navigator.credentials.create({ publicKey: {
      ...o, challenge: dec(o.challenge), user: { ...o.user, id: dec(o.user.id) },
      excludeCredentials: o.excludeCredentials.map(c => ({ ...c, id: dec(c.id) })),
    } })
    await post('register/verify', { clientDataJSON: enc(cred.response.clientDataJSON), attestationObject: enc(cred.response.attestationObject), name: $('name').value })
    $('name').value = ''
    await show()
  } catch (err) { say(err) }
  busy(false)
}

async function show() {
  const res = await fetch('/auth/passkey/list')
  const { passkeys = [] } = await res.json().catch(() => ({}))
  const list = $('list')
  list.textContent = ''
  if (!passkeys.length) { const li = document.createElement('li'); li.textContent = 'No passkey yet.'; list.append(li) }
  for (const p of passkeys) {
    const li = document.createElement('li'), text = document.createElement('span'), small = document.createElement('small'), drop = document.createElement('button')
    text.textContent = p.name
    small.textContent = p.host + ' · added ' + new Date(p.created).toLocaleDateString() + (p.last_used ? ' · last used ' + new Date(p.last_used).toLocaleDateString() : ' · never used')
    text.append(small)
    drop.type = 'button'
    drop.textContent = 'Remove'
    drop.setAttribute('aria-label', 'Remove ' + p.name)
    drop.onclick = async () => {
      if (!confirm('Remove the passkey "' + p.name + '"? It can no longer sign in.')) return
      try { await post('remove', { handle: p.handle }); await show() } catch (err) { say(err) }
    }
    li.append(text, drop)
    list.append(li)
  }
}

if (mode === 'sign-in') $('go').onclick = signIn
else {
  $('go').onclick = add
  // Under another address than the public one a passkey would be of no use elsewhere: point there instead.
  const home = $('move').dataset.home.split(' ').filter(Boolean)
  if (home.length && !home.includes(location.origin)) { $('add').hidden = true; $('move').hidden = false }
  show()
}
`
