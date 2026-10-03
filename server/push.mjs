// Web Push (docs/push.md): a notification on the human's device when a card knocks, and when a session is really
// stopped (server/blocked.mjs: the red hand), once per stop.
//
// The hub keeps one VAPID key pair (data/push-vapid.pem, the owner's alone, never logged or shown) and the
// subscriptions of the browsers that switched push on (data/push.json). A push is one outbound HTTPS request to
// the browser maker's push service; the text is encrypted for the one browser (RFC 8291, aes128gcm) and the
// request is signed with the VAPID key (RFC 8292). Nothing but Node's own crypto.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { blockedAll } from './blocked.mjs'

const b64 = bytes => Buffer.from(bytes).toString('base64url')
const unb64 = text => Buffer.from(String(text ?? ''), 'base64url')
const hkdf = (salt, ikm, info, length) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length))

// ---- RFC 8291: the message, encrypted for one subscription -----------------------------------------------

/** Every message is padded to this many bytes, so its length says nothing about the card. */
const PADDED = 512

/** plain (Buffer) -> the aes128gcm body for the browser that holds p256dh and auth (both base64url). */
export function encrypt(plain, p256dh, auth) {
  const browser = unb64(p256dh), secret = unb64(auth)
  if (browser.length !== 65 || browser[0] !== 4 || secret.length !== 16) throw new Error('not the keys of a push subscription')
  const mine = crypto.createECDH('prime256v1')
  const sender = mine.generateKeys()
  const ikm = hkdf(secret, mine.computeSecret(browser), Buffer.concat([Buffer.from('WebPush: info\0'), browser, sender]), 32)
  const salt = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-128-gcm', hkdf(salt, ikm, 'Content-Encoding: aes128gcm\0', 16), hkdf(salt, ikm, 'Content-Encoding: nonce\0', 12))
  // One record, the last: the text, the delimiter 2, then zeros.
  const record = Buffer.concat([plain, Buffer.from([2]), Buffer.alloc(Math.max(0, PADDED - plain.length - 1))])
  if (record.length + 16 > 4096 - 86) throw new Error('push message too long')
  const size = Buffer.alloc(4)
  size.writeUInt32BE(4096)
  return Buffer.concat([salt, size, Buffer.from([sender.length]), sender, cipher.update(record), cipher.final(), cipher.getAuthTag()])
}

// ---- RFC 8292: who is sending ----------------------------------------------------------------------------

/** The public key as the browser and the push service want it: the uncompressed point, base64url. */
export const publicKeyOf = privateKey => {
  const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' })
  return b64(Buffer.concat([Buffer.from([4]), unb64(jwk.x), unb64(jwk.y)]))
}

/** The Authorization header for one push service (aud is its origin). */
export function vapid(privateKey, endpoint, subject, now = Date.now()) {
  const part = value => b64(JSON.stringify(value))
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })}`
  const signature = crypto.sign('sha256', Buffer.from(unsigned), { key: privateKey, dsaEncoding: 'ieee-p1363' })
  return `vapid t=${unsigned}.${b64(signature)}, k=${publicKeyOf(privateKey)}`
}

// ---- the hub's part --------------------------------------------------------------------------------------

// The push services of the browsers; a subscription that points anywhere else is refused, so the hub cannot be
// made to post to an address of someone's choosing. BOARD_PUSH_HOSTS adds more (a test names its fake service).
// (jmt17.google.com is what a Chromium without Google's keys is given in place of fcm.googleapis.com.)
const HOSTS = ['web.push.apple.com', 'fcm.googleapis.com', 'jmt17.google.com', 'push.services.mozilla.com', 'notify.windows.com']
const SUBS_MAX = 20
// A card that goes up, down and up again does not ring again within this time.
const AGAIN_MS = Number(process.env.BOARD_PUSH_AGAIN_MS || 60000)
// "Away": no page of the board has been open for this long. Knocks ring always; a new card rings only then (card Nr. 186).
const AWAY_MS = Number(process.env.BOARD_PUSH_AWAY_MS || 300000)
// New cards that come in a burst ring together: at most one notification about new cards in this time.
const BURST_MS = Number(process.env.BOARD_PUSH_BURST_MS || 60000)
// The stops (server/blocked.mjs) that are a card waiting for him: that card knocks and rings by itself.
const BY_CARD = new Set(['permission', 'blocking'])
const isKnock = card => card.kind === 'permission' || card.urgency === 'high' || card.urgency === 'critical'
// The files a phone asks for before it is signed in (the icon and the manifest when the board is put on the Home
// Screen, the worker when the browser looks for a new version): nothing in them is the board's.
const OPEN_FILES = {
  '/manifest.webmanifest': 'application/manifest+json',
  '/sw.js': 'text/javascript; charset=utf-8',
  '/icons/trommi-180.png': 'image/png',
  '/icons/trommi-192.png': 'image/png',
  '/icons/trommi-512.png': 'image/png',
}

/**
 * dir: the data directory; web: client/web; boards(): how many pages of the board are open now (their live streams).
 * now, later, every: the clock and the timers, for a test that brings its own. Returns { route, watch, publicKey }.
 * route(req, res, url, { authed, sameOrigin, readJson, send }) answers the push routes and says whether it did.
 * watch(state) is called after every change of the board and sends what newly knocks, and what is new while the human is away.
 */
export function pusher({
  dir, web, boards = () => 0, log = () => {}, fetch: request = fetch,
  subject = process.env.BOARD_PUSH_SUBJECT || 'https://trommi.com',
  hosts = (process.env.BOARD_PUSH_HOSTS || '').split(',').map(h => h.trim()).filter(Boolean),
  now = Date.now, later = (fn, ms) => setTimeout(fn, ms).unref(), every = (fn, ms) => setInterval(fn, ms).unref(),
}) {
  const keyFile = path.join(dir, 'push-vapid.pem')
  const subsFile = path.join(dir, 'push.json')
  // Made once, put in place whole and never over an existing one (as the token is).
  if (!fs.existsSync(keyFile)) {
    const tmp = `${keyFile}.${process.pid}`
    fs.writeFileSync(tmp, crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    try { fs.linkSync(tmp, keyFile) } catch {}
    fs.rmSync(tmp, { force: true })
  }
  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyFile))
  const publicKey = publicKeyOf(privateKey)

  let subs = []
  try { subs = JSON.parse(fs.readFileSync(subsFile, 'utf8')).subs.filter(s => s && typeof s.endpoint === 'string') } catch {}
  const save = () => {
    const tmp = `${subsFile}.${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify({ subs }), { mode: 0o600 })
    fs.renameSync(tmp, subsFile)
  }
  const forget = endpoint => {
    const before = subs.length
    subs = subs.filter(s => s.endpoint !== endpoint)
    if (subs.length !== before) save()
    return subs.length !== before
  }

  const allowed = endpoint => {
    let url
    try { url = new URL(endpoint) } catch { return false }
    if (hosts.includes(url.host)) return true
    return url.protocol === 'https:' && HOSTS.some(h => url.hostname === h || url.hostname.endsWith(`.${h}`))
  }

  /** One message to one subscription. Resolves with the status; a subscription the service no longer knows is removed. */
  async function sendTo(sub, message, { topic, urgency = 'normal' } = {}) {
    let status = 0
    try {
      const res = await request(sub.endpoint, {
        method: 'POST',
        headers: {
          Authorization: vapid(privateKey, sub.endpoint, subject),
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          // Kept by the push service for a day if the device is off; a newer message for the same card replaces it.
          TTL: '86400',
          Urgency: urgency,
          ...(topic ? { Topic: topic } : {}),
        },
        body: encrypt(Buffer.from(JSON.stringify(message)), sub.p256dh, sub.auth),
        signal: AbortSignal.timeout(15000),
      })
      status = res.status
    } catch (err) {
      log(`push: ${new URL(sub.endpoint).host} not reached (${err.name})`)
      return 0
    }
    if (status === 404 || status === 410) forget(sub.endpoint)
    // The address of a subscription is a secret of its own: only the host is logged.
    else if (status < 200 || status > 299) log(`push: ${new URL(sub.endpoint).host} answered ${status}`)
    return status
  }

  // What the notification says: the card's title (card Nr. 185), unless the device asked for the discreet text;
  // a notification is shown on a lock screen.
  const titleOf = card => String(card.title ?? '').replace(/\s+/g, ' ').slice(0, 140)
  const knockFor = (card, sub) => ({ title: 'Trommi', body: sub.title ? `Knock: ${titleOf(card)}` : 'Something knocks', tag: `card-${card.id}`, url: `/q/${card.number}` })
  const newFor = (cards, sub) => (cards.length === 1
    ? { title: 'Trommi', body: sub.title ? `Nr. ${cards[0].number}: ${titleOf(cards[0])}` : 'A new card', tag: `card-${cards[0].id}`, url: `/q/${cards[0].number}` }
    : { title: 'Trommi', body: `${cards.length} new cards`, tag: 'new-cards', url: '/' })
  const stoppedFor = (agent, why, sub) => ({ title: 'Trommi', body: sub.title ? `Stopped: ${String(agent.label || agent.name || agent.id).slice(0, 60)}. ${why.text}` : 'An agent is stopped', tag: `agent-${agent.id}`, url: `/s/${encodeURIComponent(agent.id)}` })
  const topicOf = name => b64(crypto.createHash('sha256').update(String(name)).digest()).slice(0, 24)

  // When a page of the board was last open. All browsers share one login and the hub cannot tell a tab the human
  // looks at from one left open on a desk: an open page anywhere is "at the board". A phone that is locked drops its
  // stream, which is what is wanted. Looked at often enough that a page closed in between is noticed.
  let present = now()
  const look = () => { if (boards() > 0) present = now() }
  every(look, Math.max(50, Math.min(20000, AWAY_MS / 4)))
  const away = () => (look(), now() - present >= AWAY_MS)

  // The cards that wait, and whether each one knocks. What is here when the hub starts rings for nothing.
  let seen = null
  const sent = new Map()   // card id -> when its knock last rang
  // New cards while away: the first rings at once; what comes within the next minute rings together when it is over.
  let burst = null
  const ringNew = cards => subs.filter(s => s.away !== false).map(sub => sendTo(sub, newFor(cards, sub), { topic: topicOf(cards.length === 1 ? cards[0].id : 'new-cards') }))
  function burstOver() {
    // What was answered, taken back or started knocking in the meantime is not news any more; nor is anything once he is back.
    const cards = burst.filter(card => seen?.get(card.id) === false)
    burst = null
    if (!cards.length || away() === false) return
    ringNew(cards)
    burst = []
    later(burstOver, BURST_MS)
  }

  let stoppedSeen = null   // the sessions that were stopped at the last look (null: no look yet, nothing rings)
  function watch(state) {
    // A session that newly stops rings once; it rings again only after it ran again and stopped anew. A stop that is a
    // card (an approval, a card marked blocking) rings as that card's knock, not twice.
    const stopped = new Map([...blockedAll(state, now())].filter(([, why]) => !BY_CARD.has(why.why))), stoppedBefore = stoppedSeen
    stoppedSeen = new Set(stopped.keys())
    const ringing = []
    if (stoppedBefore && subs.length) for (const [id, why] of stopped) {
      if (stoppedBefore.has(id)) continue
      const agent = state.agents.find(a => a.id === id)
      for (const sub of subs) ringing.push(sendTo(sub, stoppedFor(agent, why, sub), { topic: topicOf(`agent-${id}`), urgency: 'high' }))
    }
    return [...ringing, ...watchCards(state)]
  }
  function watchCards(state) {
    const waiting = new Set(state.queue)
    const open = new Map(state.cards.filter(c => c.status === 'open' && waiting.has(c.id)).map(c => [c.id, isKnock(c)]))
    const before = seen
    seen = open
    for (const id of sent.keys()) if (!open.has(id)) sent.delete(id)
    if (!before || !subs.length) return []
    const sending = []
    for (const [id, knock] of open) {
      const fresh = !before.has(id)
      if (!fresh && !(knock && !before.get(id))) continue
      const card = state.cards.find(c => c.id === id)
      if (knock) {
        if (now() - (sent.get(id) ?? -Infinity) < AGAIN_MS) continue
        sent.set(id, now())
        for (const sub of subs) sending.push(sendTo(sub, knockFor(card, sub), { topic: topicOf(id), urgency: 'high' }))
      } else if (burst) burst.push(card)
      else if (away()) {
        sending.push(...ringNew([card]))
        burst = []
        later(burstOver, BURST_MS)
      }
    }
    return sending
  }

  async function route(req, res, url, { authed, sameOrigin, readJson, send }) {
    const type = OPEN_FILES[url.pathname]
    if (type && req.method === 'GET') {
      let bytes
      try { bytes = fs.readFileSync(path.join(web, url.pathname)) } catch { return send(res, 404, '{"error":"not found"}'), true }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Content-Length': bytes.length })
      return res.end(bytes), true
    }
    if (!url.pathname.startsWith('/push/')) return false
    if (!authed(req)) return send(res, 401, '{"error":"unauthorised"}'), true
    if (req.method === 'GET' && url.pathname === '/push/key') return send(res, 200, JSON.stringify({ key: publicKey })), true
    if (req.method !== 'POST') return send(res, 404, '{"error":"not found"}'), true
    if (!sameOrigin(req)) return send(res, 403, '{"error":"forbidden"}'), true
    let body
    try { body = await readJson(req, 1e4) } catch { return send(res, 400, '{"error":"bad request"}'), true }
    // JSON that is no object (null, a number, a list) is no request of these routes.
    if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, '{"error":"bad request"}'), true
    const endpoint = String(body.endpoint ?? '')
    const mine = subs.find(s => s.endpoint === endpoint)
    const shown = s => JSON.stringify({ ok: true, subscribed: Boolean(s), title: Boolean(s?.title), away: Boolean(s) && s.away !== false })
    switch (url.pathname) {
      // This browser switches push on, or changes what its notifications say.
      case '/push/subscribe': {
        if (!allowed(endpoint)) return send(res, 400, '{"error":"not a push service this board sends to"}'), true
        const next = { endpoint, p256dh: String(body.keys?.p256dh ?? ''), auth: String(body.keys?.auth ?? ''), title: body.title == null ? mine?.title ?? true : body.title === true, away: body.away == null ? mine?.away !== false : body.away === true, created: mine?.created ?? Date.now() }
        try { encrypt(Buffer.alloc(0), next.p256dh, next.auth) } catch (err) { return send(res, 400, JSON.stringify({ error: err.message })), true }
        subs = [...subs.filter(s => s.endpoint !== endpoint), next].slice(-SUBS_MAX)
        save()
        return send(res, 200, shown(next)), true
      }
      case '/push/unsubscribe':
        forget(endpoint)
        return send(res, 200, shown(null)), true
      // What the hub holds for this browser.
      case '/push/state':
        return send(res, 200, shown(mine)), true
      // One notification to this browser, to see that it arrives.
      case '/push/test': {
        if (!mine) return send(res, 404, '{"error":"this browser is not subscribed"}'), true
        const status = await sendTo(mine, { title: 'Trommi', body: 'Push works on this device', tag: 'push-test', url: '/' }, { urgency: 'high' })
        return send(res, status >= 200 && status < 300 ? 200 : 502, JSON.stringify({ ok: status >= 200 && status < 300, status })), true
      }
    }
    return send(res, 404, '{"error":"not found"}'), true
  }

  return { route, watch, publicKey }
}
