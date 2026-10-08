// apns.mjs: Apple Push Notification service for the iOS app, Node's http2 and crypto only. The same two pushes as the
// Web Push (push.mjs, README "Push"), shown with a fixed text that says nothing about the card; what the hub would put
// into a Web Push ({ room_id, envelope_number, urgency } or the agent-lost word) rides along as `e`, sealed with
// AES-256-GCM under a key the app made and registered with its token, so Apple sees a token, a time and a fixed text.
// Token auth: an ES256 JWT from the team's APNs key (.p8), renewed every 40 minutes (Apple wants 20 to 60).
//
// env: APNS_KEY_FILE (path of the .p8) or APNS_KEY (its PEM text), APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC (bundle ids,
// comma list; the first is the default). Missing any of them: no APNs, and the hub refuses APNs registrations.
import crypto from 'node:crypto'
import fs from 'node:fs'
import http2 from 'node:http2'

const b64 = b => Buffer.from(b).toString('base64url')
const unb64 = t => Buffer.from(String(t ?? ''), 'base64url')
export const HOSTS = { production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' }
const AAD = Buffer.from('trommi-apns-v1')
const TOKEN = /^[0-9a-f]{64,200}$/
const BUNDLE = /^[A-Za-z0-9.-]{1,155}$/

/** The configuration from the environment, or null when APNs is not set up. */
export function apnsConfig(env = process.env) {
  const pem = env.APNS_KEY ? env.APNS_KEY.replace(/\\n/g, '\n') : env.APNS_KEY_FILE ? fs.readFileSync(env.APNS_KEY_FILE, 'utf8') : ''
  const topics = (env.APNS_TOPIC || '').split(',').map(t => t.trim()).filter(Boolean)
  if (!pem || !env.APNS_KEY_ID || !env.APNS_TEAM_ID || !topics.length) return null
  return { key: pem, keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID, topics }
}

/** The provider token: header { alg ES256, kid }, claims { iss: team, iat }, signed raw (r || s). */
export function providerToken(privateKey, keyId, teamId, now = Date.now()) {
  const part = v => b64(JSON.stringify(v))
  const unsigned = `${part({ alg: 'ES256', kid: keyId })}.${part({ iss: teamId, iat: Math.floor(now / 1000) })}`
  return `${unsigned}.${b64(crypto.sign('sha256', Buffer.from(unsigned), { key: privateKey, dsaEncoding: 'ieee-p1363' }))}`
}

/** `e` of a notification: nonce (12) || ciphertext || tag (16), base64url; CryptoKit's AES.GCM.SealedBox(combined:). */
export function seal(message, key) {
  const nonce = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce)
  c.setAAD(AAD)
  return b64(Buffer.concat([nonce, c.update(JSON.stringify(message)), c.final(), c.getAuthTag()]))
}
export function open(e, key) {
  const b = unb64(e)
  const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12))
  d.setAAD(AAD)
  d.setAuthTag(b.subarray(b.length - 16))
  return JSON.parse(Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString())
}

/** The fixed text a push shows: no title, no room, no card, only what kind of push it is. */
export function alertOf(message) {
  if (message.kind === 'agent-lost') return message.state === 'cut' ? 'Eine Sitzung ist abgeschnitten.' : 'Ein Agent hat die Verbindung verloren.'
  return message.urgency >= 2 ? 'Dringend: eine neue Frage.' : 'Eine neue Frage.'
}

/**
 * config: apnsConfig() or null (then null comes back). hosts: { production, sandbox } base URLs (tests point both at
 * a local h2c server). Returns { check, send, close } like push.mjs's pusher.
 */
export function apnsSender(config, { hosts = HOSTS, log = () => {}, now = Date.now } = {}) {
  if (!config) return null
  const privateKey = crypto.createPrivateKey(config.key)
  let jwt = null, jwtAt = 0
  const token = (fresh = false) => {
    if (fresh || !jwt || now() - jwtAt > 40 * 60000) { jwt = providerToken(privateKey, config.keyId, config.teamId, now()); jwtAt = now() }
    return jwt
  }
  const sessions = new Map()   // origin -> ClientHttp2Session, one connection per host, kept open (Apple asks for that)
  function session(origin) {
    let s = sessions.get(origin)
    if (s && !s.closed && !s.destroyed) return s
    s = http2.connect(origin)
    const forget = () => { if (sessions.get(origin) === s) sessions.delete(origin) }
    s.on('error', err => { log(`apns ${origin}: ${err.message}`); forget() })
    s.on('close', forget)
    s.on('goaway', forget)
    s.setTimeout(3600000, () => s.close())
    s.unref()
    sessions.set(origin, s)
    return s
  }
  function post(origin, path, headers, body) {
    return new Promise(resolve => {
      let req
      try { req = session(origin).request({ ':method': 'POST', ':path': path, 'content-type': 'application/json', ...headers }) }
      catch (err) { log(`apns: ${err.message}`); resolve({ status: 0 }); return }
      const parts = []
      let status = 0
      req.setTimeout(10000, () => req.close(http2.constants.NGHTTP2_CANCEL))
      req.on('response', h => { status = h[':status'] })
      req.on('data', c => parts.push(c))
      req.on('end', () => {
        let reason = ''
        try { reason = JSON.parse(Buffer.concat(parts).toString() || '{}').reason ?? '' } catch {}
        resolve({ status, reason })
      })
      req.on('error', err => { log(`apns: ${err.message}`); resolve({ status: 0 }) })
      req.end(body)
    })
  }

  /** Check what the app registers: { token (hex), environment, topic?, key (32 bytes, base64url) }; normalised or null. */
  const check = a => {
    if (!a || typeof a !== 'object') return null
    const tok = typeof a.token === 'string' ? a.token.toLowerCase() : ''
    const topic = a.topic ?? config.topics[0]
    if (!TOKEN.test(tok) || !(a.environment in hosts) || typeof topic !== 'string' || !BUNDLE.test(topic) || !config.topics.includes(topic)) return null
    if (unb64(a.key).length !== 32 || typeof a.key !== 'string') return null
    return { token: tok, environment: a.environment, topic, key: a.key }
  }
  /**
   * Send one message; resolves with an HTTP status like push.mjs (0 on a network error). A token Apple no longer
   * takes (410 Unregistered, 400 BadDeviceToken or DeviceTokenNotForTopic) comes back as 410: forget it.
   */
  async function send(a, message) {
    const payload = JSON.stringify({ aps: { alert: { title: 'Trommi', body: alertOf(message) }, sound: 'default' }, e: seal(message, unb64(a.key)) })
    const headers = token => ({
      authorization: `bearer ${token}`, 'apns-topic': a.topic, 'apns-push-type': 'alert',
      'apns-priority': '10', 'apns-expiration': String(Math.floor(now() / 1000) + 86400),
    })
    let r = await post(hosts[a.environment], `/3/device/${a.token}`, headers(token()), payload)
    if (r.status === 403 && r.reason === 'ExpiredProviderToken') r = await post(hosts[a.environment], `/3/device/${a.token}`, headers(token(true)), payload)
    if (r.status !== 200 && r.status) log(`apns ${r.status} ${r.reason}`)
    if (r.status === 410 || (r.status === 400 && (r.reason === 'BadDeviceToken' || r.reason === 'DeviceTokenNotForTopic'))) return 410
    return r.status
  }
  function close() { for (const s of sessions.values()) s.close(); sessions.clear() }
  return { topics: config.topics, check, send, close }
}
