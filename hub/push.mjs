// push.mjs: Web Push for the hub, Node's crypto only (from server/push.mjs). The payload is exactly
// { room_id, envelope_number, urgency } (README "Push"), encrypted for the one browser (RFC 8291, aes128gcm),
// the request signed with the hub's VAPID key (RFC 8292). The key pair is made on first boot in HUB_DATA.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const b64 = b => Buffer.from(b).toString('base64url')
const unb64 = t => Buffer.from(String(t ?? ''), 'base64url')
const hkdf = (salt, ikm, info, length) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length))
const PADDED = 128

export function encrypt(plain, p256dh, auth) {
  const browser = unb64(p256dh), secret = unb64(auth)
  if (browser.length !== 65 || browser[0] !== 4 || secret.length !== 16) throw new Error('not the keys of a push subscription')
  const mine = crypto.createECDH('prime256v1')
  const sender = mine.generateKeys()
  const ikm = hkdf(secret, mine.computeSecret(browser), Buffer.concat([Buffer.from('WebPush: info\0'), browser, sender]), 32)
  const salt = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-128-gcm', hkdf(salt, ikm, 'Content-Encoding: aes128gcm\0', 16), hkdf(salt, ikm, 'Content-Encoding: nonce\0', 12))
  const record = Buffer.concat([plain, Buffer.from([2]), Buffer.alloc(Math.max(0, PADDED - plain.length - 1))])
  const size = Buffer.alloc(4)
  size.writeUInt32BE(4096)
  return Buffer.concat([salt, size, Buffer.from([sender.length]), sender, cipher.update(record), cipher.final(), cipher.getAuthTag()])
}

export const publicKeyOf = privateKey => {
  const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' })
  return b64(Buffer.concat([Buffer.from([4]), unb64(jwk.x), unb64(jwk.y)]))
}

export function vapid(privateKey, endpoint, subject, now = Date.now()) {
  const part = v => b64(JSON.stringify(v))
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })}`
  const signature = crypto.sign('sha256', Buffer.from(unsigned), { key: privateKey, dsaEncoding: 'ieee-p1363' })
  return `vapid t=${unsigned}.${b64(signature)}, k=${publicKeyOf(privateKey)}`
}

// Browser push services only, so the hub cannot be made to post anywhere; HUB_PUSH_HOSTS adds more (tests).
const HOSTS = ['web.push.apple.com', 'fcm.googleapis.com', 'jmt17.google.com', 'push.services.mozilla.com', 'notify.windows.com']

export function pusher({ dir, subject = process.env.HUB_PUSH_SUBJECT || 'https://trommi.com', hosts = (process.env.HUB_PUSH_HOSTS || '').split(',').map(h => h.trim()).filter(Boolean), log = () => {} }) {
  const keyFile = path.join(dir, 'vapid.pem')
  if (!fs.existsSync(keyFile)) {
    const tmp = `${keyFile}.${process.pid}`
    fs.writeFileSync(tmp, crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    try { fs.linkSync(tmp, keyFile) } catch {}
    fs.rmSync(tmp, { force: true })
  }
  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyFile))
  const publicKey = publicKeyOf(privateKey)
  const allowed = endpoint => {
    let url
    try { url = new URL(endpoint) } catch { return false }
    if (hosts.includes(url.host)) return true
    return url.protocol === 'https:' && HOSTS.some(h => url.hostname === h || url.hostname.endsWith(`.${h}`))
  }
  /** Check a subscription object from a browser; returns it normalised or null. */
  const check = sub => {
    if (!sub || typeof sub.endpoint !== 'string' || sub.endpoint.length > 1024 || !allowed(sub.endpoint)) return null
    const { p256dh, auth } = sub.keys ?? {}
    if (unb64(p256dh).length !== 65 || unb64(auth).length !== 16) return null
    return { endpoint: sub.endpoint, keys: { p256dh, auth } }
  }
  /** Send one message; resolves with the HTTP status (0 on a network error). 404/410 mean: forget it. */
  async function send(sub, message, { urgency = 'normal' } = {}) {
    try {
      const res = await fetch(sub.endpoint, {
        method: 'POST',
        headers: { Authorization: vapid(privateKey, sub.endpoint, subject), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: urgency },
        body: encrypt(Buffer.from(JSON.stringify(message)), sub.keys.p256dh, sub.keys.auth),
        signal: AbortSignal.timeout(10000),
      })
      await res.arrayBuffer().catch(() => {})
      return res.status
    } catch (err) { log(`push failed: ${err.message}`); return 0 }
  }
  return { publicKey, check, send }
}
