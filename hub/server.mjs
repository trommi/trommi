// server.mjs: the thin hub (hub.trommi.com). A hostile mailbox: it keeps the signed member lists, sealed room
// keys, invites, encrypted envelopes and attachments of many rooms and serves no UI. The contract is the
// README section "Hub v1: the wire protocol"; every check on signed bytes lives in crypto/ (zcrypto.mjs,
// hub.mjs), this file is transport, storage, limits and the live stream.
//
// Run: node hub/server.mjs    env: HUB_PORT (8790), HUB_HOST (0.0.0.0), HUB_DATA (/data), HUB_URL (the address
// devices sign; https://hub.trommi.com in prod), COMMIT, HUB_ORIGINS (+ HUB_PREVIEW_ORIGINS, set by the deploy), HUB_FOUND_TOKEN, HUB_MAX_ROOMS (1000),
// HUB_PUSH_HOSTS, HUB_PUSH_SUBJECT, APNS_KEY_FILE or APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC (hub/apns.mjs), HUB_TRUST_CF (1: trust cf-connecting-ip, only from a loopback or private peer,
// i.e. cloudflared on this machine or through Docker's port proxy; off by default).
import http from 'node:http'
import { pipeline } from 'node:stream/promises'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as z from '../shared/crypto/zcrypto.mjs'
import { createHub } from '../shared/crypto/hub.mjs'
import { openDb, roomStorage, envelopeBytes, chunkCount, rebuildDerived, vacuumStep } from './store.mjs'
import { fileStore } from './attachments.mjs'
import { pusher } from './push.mjs'
import { apnsConfig, apnsSender, pushTickets } from './apns.mjs'
import { createOps, limitsFromEnv } from './ops/index.mjs'
import { createAccounts } from './accounts.mjs'
import { createMailer } from './mail.mjs'

export const PROTOCOL_VERSION = 1
const DAY = 86400000
/** What a push registration rings for: every card that asks to push, or only the knocking ones (urgency high, critical). */
const PUSH_LEVELS = ['all', 'knocking']
export const LIMITS = limitsFromEnv({
  json: 1 << 20,
  ciphertext: 65536 + 16,
  attachment: 64 << 20,
  foundPerIpHour: 10,
  envelopesPerSecond: 50, envelopeBurst: 200,
  streamsPerDevice: 8,
  openRequestsPerIpMinute: 600,
  pushSubscriptionsPerDevice: 10,
  retentionDays: 30,
})
const STATUS = {
  'bad-format': 400, 'bad-argument': 400, 'bad-version': 400, 'newer-version': 400, 'bad-entry': 400, 'bad-signature': 400, 'bad-invite': 400, 'wrong-room': 400,
  incomplete: 400, 'bad-grant': 400, 'chain-break': 400, 'log-behind': 400, 'log-fork': 400,
  unauthorised: 401, 'bad-challenge': 401,
  forbidden: 403, 'not-member': 403, 'removed-sender': 403, 'wrong-sender': 403,
  'not-found': 404, 'no-room': 404,
  replay: 409, gap: 409, equivocation: 409, 'room-exists': 409, 'invite-used': 409, 'instance-conflict': 409, 'wrong-epoch': 409, 'lease-lost': 409, 'stale-grant': 409, 'stale-session-key': 409, 'invite-burned': 410,
  'invite-expired': 410, 'too-large': 413, 'too-many': 429, 'rate-limited': 429, internal: 500,
}
const CATCH_UP_SLICE = 64
const CATCH_UP_HIGH_WATER = 256 << 10
const TIMELINE_NAMES = { chat: z.TIMELINE.CHAT, scribble: z.TIMELINE.SCRIBBLE }
const HEX64 = /^[0-9a-f]{64}$/, HEX32 = /^[0-9a-f]{32}$/
const JSON_BODY_MS = 15000           // a JSON body arrives whole within this
const IDLE_MS = 30000                // a request with no bytes moving for this long is closed (streams ping every 25 s)
const UPLOAD_MIN_BYTES_PER_S = 16384 // an upload may take 60 s + size / this, then it is cut off
/** Loopback or a private (RFC 1918 / ULA) peer: a proxy on this machine. Not the tailnet's 100.64/10, not public. */
export function trustedPeer(ip) {
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.\d+\.\d+$/.exec(ip)
  if (v4) { const [a, b] = [Number(v4[1]), Number(v4[2])]; return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) }
  return ip === '::1' || /^f[cd][0-9a-f]{2}:/i.test(ip)
}

class HubError extends Error {
  constructor(code, message, extra) { super(message); this.code = code; Object.assign(this, extra) }
}
const fail = (code, message, extra) => { throw new HubError(code, message, extra) }

/** A token bucket per key: `rate` per second, up to `burst`. take() -> 0 if allowed, else seconds to wait. */
function buckets(rate, burst, now) {
  const map = new Map()
  return {
    take(key) {
      const t = now()
      let b = map.get(key)
      if (!b) {
        if (map.size >= 100000) { for (const [k, x] of map) if (t - x.at > 60000) map.delete(k) }   // bounded under a flood
        b = { tokens: burst, at: t }; map.set(key, b)
      }
      b.tokens = Math.min(burst, b.tokens + ((t - b.at) / 1000) * rate)
      b.at = t
      if (b.tokens >= 1) { b.tokens -= 1; return 0 }
      return Math.ceil((1 - b.tokens) / rate)
    },
    sweep() { const t = now(); for (const [k, b] of map) if (t - b.at > 3600000) map.delete(k) },
    get size() { return map.size },
  }
}

export async function startHub({
  port = Number(process.env.HUB_PORT || 8790), host = process.env.HUB_HOST || '0.0.0.0',
  dataDir = process.env.HUB_DATA || '/data', hubUrl = process.env.HUB_URL, commit = process.env.COMMIT || 'dev',
  origins = `${process.env.HUB_ORIGINS || ''},${process.env.HUB_PREVIEW_ORIGINS || ''}`.split(',').map(s => s.trim()).filter(Boolean),
  foundToken = process.env.HUB_FOUND_TOKEN || '', maxRooms = Number(process.env.HUB_MAX_ROOMS || 1000),
  trustCloudflare = process.env.HUB_TRUST_CF === '1', appUrl = process.env.HUB_APP_URL || 'https://app.trommi.com', pushHosts, apns: apnsOptions = apnsConfig(), apnsHosts, now = Date.now, log = msg => console.log(`[hub] ${msg}`),
  pingMs = 25000, retentionEveryMs = DAY, streamCapEveryMs = 1000, bodyTimeoutMs = JSON_BODY_MS, adminPort = process.env.ADMIN_PORT, lossMs = Number(process.env.HUB_LOSS_MS || 60000), liveMs = Number(process.env.HUB_LIVE_MS || 2000),
} = {}) {
  const t0 = performance.now()
  const db = openDb(dataDir, { log })
  const files = fileStore(path.join(dataDir, 'attachments'))
  const push = pusher({ dir: dataDir, ...(pushHosts ? { hosts: pushHosts } : {}), log })
  const apns = apnsSender(apnsOptions, { ...(apnsHosts ? { hosts: apnsHosts } : {}), log, now })
  if (apns) log(`apns on for ${apns.topics.join(', ')}`)
  /** One push to one registration: a browser's Web Push subscription, or an iPhone's APNs token ({ apns }). */
  const pushTo = (sub, message, opts) => sub.apns ? (apns ? apns.send(sub.apns, message, opts) : Promise.resolve(0)) : push.send(sub, message, opts)
  /** Tickets for one envelope each, sealed into an iPhone's push (apns.mjs pushTickets; GET push_envelope). */
  const tickets = pushTickets(dataDir)
  const rooms = new Map()            // room_id -> Promise<{ hub, streams: Set }>
  const founded = new Map()          // ip -> [times]
  const envelopeLimit = buckets(LIMITS.envelopesPerSecond, LIMITS.envelopeBurst, now)
  const pushLimit = buckets(10 / 60, 10, now)
  const openLimit = buckets(LIMITS.openRequestsPerIpMinute / 60, LIMITS.openRequestsPerIpMinute, now)
  const stats = { roomLoads: [], catchUpSlices: 0 }

  // ---- rooms, loaded on first use --------------------------------------------------

  const roomExists = id => !!db.q('SELECT 1 FROM rooms WHERE room_id = ?').get(id)
  const makeHub = id => createHub({ hubUrl, storage: roomStorage(db, id), now })
  function room(id) {
    if (!HEX64.test(id)) fail('bad-argument', 'a room id is 64 hex characters')
    let p = rooms.get(id)
    if (!p) {
      if (!roomExists(id)) fail('no-room', 'no such room on this hub')
      const t = performance.now()
      p = makeHub(id).then(hub => { stats.roomLoads.push({ room_id: id, ms: performance.now() - t }); return { id, hub, streams: new Set(), offlineSince: new Map(), link: new Map() } })
      p.catch(err => { rooms.delete(id); log(`room ${id.slice(0, 8)} failed to load: ${err.message}`) })
      rooms.set(id, p)
    }
    return p
  }

  async function closeRoom(id) {
    const p = rooms.get(id)
    rooms.delete(id)
    const r = await p?.catch(() => null)
    if (r) for (const s of r.streams) s.res.end()
  }

  // ---- the live stream -------------------------------------------------------------

  const sse = (event, data, id) => `${id != null ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  function deliver(r, chunk, filter = () => true) {
    for (const s of r.streams) if (!s.res.writableEnded && !s.res.destroyed && filter(s)) ops.send(s, chunk)
  }
  const deviceStreams = (r, deviceId) => [...r.streams].filter(s => s.deviceId === deviceId)
  function closeStreams(r, ids, which = () => true) {
    const gone = new Set(ids)
    for (const s of r.streams) if (gone.has(s.deviceId) && which(s) && !s.res.writableEnded) s.res.end()
  }

  // ---- HTTP helpers ------------------------------------------------------------------

  // H11: localhost origins only outside production (or listed in HUB_ORIGINS).
  const devOrigins = process.env.NODE_ENV !== 'production'
  const allowedOrigin = o => !!o && (o === 'https://app.trommi.com' || (devOrigins && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)) || origins.includes(o))
  function cors(req, res) {
    const o = req.headers.origin
    if (allowedOrigin(o)) {
      res.setHeader('Access-Control-Allow-Origin', o)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Expose-Headers', 'content-range, content-length, retry-after')
    }
  }
  // C06: cf-connecting-ip only when enabled AND the socket peer is this machine or a private address (cloudflared on
  // the host, seen through Docker's port proxy as the bridge gateway). Never from the tailnet (100.64/10) or the internet.
  const ipOf = req => {
    const peer = req.socket.remoteAddress || 'unknown'
    const h = req.headers['cf-connecting-ip']
    return trustCloudflare && typeof h === 'string' && h.length <= 64 && trustedPeer(peer) ? h : peer
  }
  function send(res, status, body) {
    if (res.headersSent) { res.end(); return }
    const text = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) })
    res.end(text)
  }
  async function readJson(req) {
    if (Number(req.headers['content-length'] || 0) > LIMITS.json) fail('too-large', `a JSON request is at most ${LIMITS.json} bytes`)
    const parts = []
    let size = 0
    // C03: a JSON body arrives whole within JSON_BODY_MS, or the connection goes (a half-sent body must not hold a write slot).
    const deadline = setTimeout(() => req.destroy(), bodyTimeoutMs)
    try {
      for await (const c of req) {
        size += c.length
        if (size > LIMITS.json) fail('too-large', `a JSON request is at most ${LIMITS.json} bytes`)
        parts.push(c)
      }
    } finally { clearTimeout(deadline) }
    if (req.destroyed && !req.complete) fail('bad-format', 'the request body did not arrive in time')
    try { const v = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); if (v && typeof v === 'object' && !Array.isArray(v)) return v } catch {}
    fail('bad-format', 'the request body is not a JSON object')
  }
  const b64 = (v, what) => {
    if (typeof v !== 'string' || !v) fail('bad-argument', `${what} (base64url) is missing`)
    return z.unb64u(v)
  }
  const bearer = req => {
    const m = /^Bearer ([A-Za-z0-9_-]{16,200})$/.exec(req.headers.authorization || '')
    if (!m) fail('unauthorised', 'sign in first: Authorization: Bearer <access_token>')
    return m[1]
  }
  const intParam = (url, name, dflt, min, max) => {
    const v = url.searchParams.get(name)
    if (v == null || v === '') return dflt
    const n = Number(v)
    if (!Number.isSafeInteger(n) || n < min || n > max) fail('bad-argument', `${name} must be an integer from ${min} to ${max}`)
    return n
  }
  const hexParam = (v, re, what) => { if (typeof v !== 'string' || !re.test(v)) fail('bad-argument', `${what} must be lowercase hex`); return v }
  const openRoute = (req, roomId) => { if (ops.unlimited(req, roomId)) return; const wait = openLimit.take(ipOf(req)); if (wait) fail('rate-limited', 'too many requests from this address', { retryAfter: wait }) }

  /** The envelope rows of a room after a number, with the depth rule: body only for heads not pruned. */
  const envelopeRows = (roomId, after, limit) => db.q(`SELECT envelope_number, envelope_header, envelope_nonce, envelope_signature, encrypted_body_hash, void_code,
      CASE WHEN envelope_kind != 1 THEN encrypted_body END AS encrypted_body FROM envelopes WHERE room_id = ? AND envelope_number > ? ORDER BY envelope_number LIMIT ?`).all(roomId, after, limit)
  const record = r => ({ envelope_number: r.envelope_number, envelope: z.b64u(envelopeBytes(r, true)), ...(r.void_code ? { void: true, void_code: r.void_code } : {}) })

  // ---- routes ------------------------------------------------------------------------

  async function found(req, res) {
    // A signed test request founds a test room (and only that) without the token and the per-address limit.
    const signedTest = ops.testRooms.isTestRequest(req)
    if (foundToken && req.headers['x-found-token'] !== foundToken && !signedTest) fail('forbidden', 'founding a room on this hub needs x-found-token')
    const ip = ipOf(req)
    const recent = (founded.get(ip) ?? []).filter(t => now() - t < 3600000)
    if (recent.length >= LIMITS.foundPerIpHour && !signedTest) fail('rate-limited', 'too many rooms founded from this address in the last hour', { retryAfter: Math.ceil((recent[0] + 3600000 - now()) / 1000) })
    const body = await readJson(req)
    const testRoom = ops.testRooms.wanted(req, body)
    if (signedTest && !testRoom) fail('forbidden', 'a signed test request founds test rooms only (test_room: true)')
    const entry = b64(body.signed_entry, 'signed_entry')
    if (!Array.isArray(body.sealed_room_keys)) fail('bad-argument', 'sealed_room_keys must be a list')
    const wraps = body.sealed_room_keys.map(w => ({ id: z.unhex(hexParam(w?.device_id, HEX64, 'device_id')), sealed: b64(w?.key_sealed, 'key_sealed') }))
    if (entry.length < 64) fail('bad-format', 'signed_entry')
    const id = z.hex(await z.hash(z.LABEL.logEntry, entry.slice(0, entry.length - 64)))
    if (rooms.has(id) || roomExists(id)) fail('room-exists', 'this room is already founded')
    if (db.q('SELECT COUNT(*) AS n FROM rooms').get().n >= maxRooms) fail('too-many', 'this hub holds as many rooms as it may')
    const p = (async () => {
      const hub = await makeHub(id)
      const r = await hub.found({ entry, wraps })
      return { r, room: { id, hub, streams: new Set(), offlineSince: new Map(), link: new Map() } }
    })()
    const roomPromise = p.then(x => x.room)
    roomPromise.catch(() => {})
    rooms.set(id, roomPromise)
    let out
    try { out = await p } catch (err) { rooms.delete(id); throw err }
    recent.push(now()); founded.set(ip, recent)
    if (testRoom) ops.testRooms.mark(id)
    log(`room ${id.slice(0, 8)} founded`)
    send(res, 201, { room_id: id, entry_number: 0, entry_hash: out.r.hash, key_epoch: 1 })
  }

  async function memberEntry(r, req, res) {
    const body = await readJson(req)
    const entry = b64(body.signed_entry, 'signed_entry')
    if (!Array.isArray(body.sealed_room_keys)) fail('bad-argument', 'sealed_room_keys must be a list')
    const wraps = body.sealed_room_keys.map(w => ({ id: z.unhex(hexParam(w?.device_id, HEX64, 'device_id')), sealed: b64(w?.key_sealed, 'key_sealed') }))
    const backLink = body.key_back_link != null ? b64(body.key_back_link, 'key_back_link') : undefined
    const out = await r.hub.postEntry({ entry, wraps, backLink })
    // A removal takes effect at once: streams closed (tokens were revoked inside), its agent session freed.
    if (out.removed.length) {
      closeStreams(r, out.removed)
      log(`room ${r.id.slice(0, 8)}: ${out.removed.length} device(s) removed, key epoch ${out.epoch}`)
    }
    deliver(r, { text: sse('member_entry', { entry_number: out.seq, entry_hash: out.hash, key_epoch: out.epoch }) })
    const action = { [z.ENTRY.GENESIS]: 'room_founded', [z.ENTRY.ADD]: 'device_added', [z.ENTRY.REMOVE]: 'devices_removed', [z.ENTRY.RECOVER]: 'recovery' }[out.type]
    send(res, 200, { entry_number: out.seq, entry_hash: out.hash, key_epoch: out.epoch, entry_action: action })
  }

  async function postEnvelope(r, req, res) {
    const token = bearer(req)
    const me = r.hub.authorise(token, { member: true })
    const wait = ops.unlimited(req, r.id) ? 0 : envelopeLimit.take(`${r.id}:${me.id}`)
    if (wait) fail('rate-limited', 'too many envelopes from this device', { retryAfter: wait })
    const body = await readJson(req)
    const bytes = b64(body.envelope, 'envelope')
    const peek = z.peekEnvelope(bytes, { strictKinds: true })
    if (peek.ciphertext && peek.ciphertext.length > LIMITS.ciphertext) fail('too-large', 'an envelope body is at most 64 KiB padded; put more into an attachment')
    const lease = req.headers['x-lease-generation']
    if (lease != null && !/^\d{1,16}$/.test(lease)) fail('bad-argument', 'x-lease-generation')
    let out
    try { out = await r.hub.postEnvelope(token, bytes, { leaseGeneration: lease != null ? Number(lease) : null }) } catch (err) {
      // A void record (review 2 #5) took the number: everyone sees it in order, and the sender learns its number.
      if (err.voided) {
        const rec = { envelope_number: err.envelopeNumber, envelope: z.b64u(err.voidBytes), void: true, void_code: err.code }
        deliver(r, { n: err.envelopeNumber, text: sse('envelope', rec, err.envelopeNumber) })
      }
      throw err
    }
    deliver(r, { n: out.n, text: sse('envelope', { envelope_number: out.n, envelope: body.envelope }, out.n) })
    send(res, 200, { envelope_number: out.n })
    // send_push is honoured only on an object's own versions and requests (shared/crypto/hub.mjs), and rate-limited per sender.
    if (out.push && !pushLimit.take(`${r.id}:${me.id}`)) sendPushes(r, me.id, out).catch(err => log(`push: ${err.message}`))
    if (out.card) liveSoon(r)
  }

  /**
   * The link (README "The link"): what an agent's connector says about itself (POST agent_link), kept in memory per
   * device, served with GET devices and announced to every stream of the room when it changes (event `presence`, also
   * when a device's first stream opens or its last one closes). The hub reads none of it but three things, for the push:
   * `working`, `exit.claude` and `cut_since`.
   *
   * One push to the room's human devices, never repeated, when
   *   - the device's last stream stays closed for lossMs and it had running work, or its Claude Code process lives on
   *     without it (exit.claude 'alive': cut off). Not for a session that said goodbye, ended with its Claude Code and
   *     had nothing running: the human ended it himself. A stream that returns in time pushes nothing, and the next
   *     push needs a new stream first;
   *   - a connected agent reports a session of its folder cut off (cut_since), once per value.
   * A connector before the link report says only `working` (POST agent_watch) and is pushed for as before.
   */
  const LINK_HEARS = ['live', 'oncall'], LINK_CLAUDE = ['alive', 'gone', 'checking']
  const linkOf = (r, deviceId) => { let e = r.link.get(deviceId); if (!e) r.link.set(deviceId, e = { report: null, working: false, timer: null, lost_pushed: false, cut_pushed: null, said: '' }); return e }
  function linkReport(body) {
    const time = (v, what) => { if (v == null) return null; if (!Number.isSafeInteger(v) || v <= 0) fail('bad-argument', `${what} is a time in milliseconds, or null`); return v }
    if (!LINK_HEARS.includes(body.hears)) fail('bad-argument', 'hears: live or oncall')
    if (body.attached != null && typeof body.attached !== 'boolean') fail('bad-argument', 'attached')
    if (body.working != null && typeof body.working !== 'boolean') fail('bad-argument', 'working')
    let exit = null
    if (body.exit != null) {
      if (typeof body.exit !== 'object' || typeof body.exit.reason !== 'string' || !/^[a-z0-9-]{1,40}$/.test(body.exit.reason) || !LINK_CLAUDE.includes(body.exit.claude)) fail('bad-argument', 'exit: { reason, claude: alive | gone | checking }')
      exit = { reason: body.exit.reason, claude: body.exit.claude }
    }
    return { hears: body.hears, attached: body.attached !== false, last_call_at: time(body.last_call_at, 'last_call_at'), working: body.working === true, since: time(body.since, 'since'), cut_since: time(body.cut_since, 'cut_since'), ...(exit ? { exit } : {}) }
  }
  /** A device's row of GET devices, without what the member list says: presence and the link. */
  function presenceOf(r, deviceId) {
    const online = deviceStreams(r, deviceId).length > 0, report = r.link.get(deviceId)?.report
    return { device_id: deviceId, is_online: online, ...(!online && r.offlineSince.has(deviceId) ? { offline_since: r.offlineSince.get(deviceId) } : {}), ...(report ? { link: report } : {}) }
  }
  /** Tell every stream of the room what a device's row is now, unless it was said already. */
  function announce(r, deviceId) {
    const row = presenceOf(r, deviceId), text = JSON.stringify(row), e = linkOf(r, deviceId)
    if (e.said === text) return
    e.said = text
    deliver(r, { text: sse('presence', row) })
  }
  function streamOpened(r, deviceId) {
    const e = linkOf(r, deviceId)
    clearTimeout(e.timer); e.timer = null
    e.lost_pushed = false
    if (e.report?.exit) { const { exit, ...rest } = e.report; e.report = rest }   // the last word of an earlier process
    announce(r, deviceId)
  }
  function streamsGone(r, deviceId) {
    const e = linkOf(r, deviceId)
    announce(r, deviceId)
    clearTimeout(e.timer)
    e.timer = setTimeout(() => {
      e.timer = null
      if (deviceStreams(r, deviceId).length || e.lost_pushed) return
      const cut = e.report?.exit?.claude === 'alive'
      if (!cut && !e.working) return
      e.lost_pushed = true
      e.working = false
      liveSoon(r)
      sendLinkPush(r, deviceId, cut ? 'cut' : 'gone', r.offlineSince.get(deviceId) ?? null).catch(err => log(`push: ${err.message}`))
    }, lossMs)
    e.timer.unref?.()
  }
  async function sendLinkPush(r, deviceId, state, since) {
    const subs = db.q(`SELECT p.device_id, p.endpoint, p.subscription FROM push_subscriptions p JOIN devices d ON d.room_id = p.room_id AND d.device_id = p.device_id
      WHERE p.room_id = ? AND d.device_role = 'human' AND d.removed_entry_number IS NULL`).all(r.id)
    const message = { room_id: r.id, kind: 'agent-lost', state, device_id: deviceId, since }
    await Promise.all(subs.map(async s => {
      const status = await pushTo(JSON.parse(s.subscription), message, { urgency: 'high' })
      if (status === 404 || status === 410) db.q('DELETE FROM push_subscriptions WHERE room_id = ? AND device_id = ? AND endpoint = ?').run(r.id, s.device_id, s.endpoint)
    }))
  }

  async function sendPushes(r, senderId, out) {
    const urgency = out.card?.urgency ?? null
    const knocks = urgency != null && urgency >= z.URGENCY.HIGH
    const subs = db.q(`SELECT p.device_id, p.endpoint, p.subscription FROM push_subscriptions p JOIN devices d ON d.room_id = p.room_id AND d.device_id = p.device_id
      WHERE p.room_id = ? AND d.device_role = 'human' AND d.removed_entry_number IS NULL AND p.device_id != ? AND (p.level = 'all' OR ?)`).all(r.id, senderId, knocks ? 1 : 0)
    const webUrgency = urgency >= z.URGENCY.HIGH ? 'high' : 'normal'
    await Promise.all(subs.map(async s => {
      const sub = JSON.parse(s.subscription), message = { room_id: r.id, envelope_number: out.n, urgency }
      // an iPhone also gets a ticket for this one envelope: its Notification Service Extension shows the card's title
      if (sub.apns) message.t = tickets.issue(r.id, s.device_id, out.n, now())
      const status = await pushTo(sub, message, { urgency: webUrgency })
      if (status === 404 || status === 410) db.q('DELETE FROM push_subscriptions WHERE room_id = ? AND device_id = ? AND endpoint = ?').run(r.id, s.device_id, s.endpoint)
    }))
  }

  /**
   * Live Activity (README "Live Activity"): per human iPhone one row, its push-to-start token and the token of its
   * running activity. The counts are what the hub sees anyway: agents whose link says `working`, open objects owned by
   * an agent (cards and permission requests). A change goes out at most every liveMs (HUB_LIVE_MS, 2 s): start when agents begin to work
   * (once, until it ended), update, end when none works any more.
   */
  function liveSoon(r) {
    if (!apns || r.liveTimer) return
    r.liveTimer = setTimeout(() => { r.liveTimer = null; liveNow(r).catch(err => log(`live: ${err.message}`)) }, liveMs)
    r.liveTimer.unref?.()
  }
  function liveCounts(r) {
    const agents = new Set(db.q("SELECT device_id FROM devices WHERE room_id = ? AND device_role = 'agent' AND removed_entry_number IS NULL").all(r.id).map(d => d.device_id))
    let working = 0
    for (const [id, e] of r.link) if (e.working && agents.has(id)) working++
    const waiting = db.q(`SELECT COUNT(*) AS n FROM objects o JOIN devices d ON d.room_id = o.room_id AND d.device_id = o.owner_device_id
      WHERE o.room_id = ? AND o.object_state = 1 AND d.device_role = 'agent'`).get(r.id).n
    return { working, waiting }
  }
  async function liveNow(r) {
    const rows = db.q(`SELECT l.* FROM live_activities l JOIN devices d ON d.room_id = l.room_id AND d.device_id = l.device_id
      WHERE l.room_id = ? AND d.device_role = 'human' AND d.removed_entry_number IS NULL`).all(r.id)
    if (!rows.length) return
    const state = liveCounts(r), key = `${state.working}:${state.waiting}`
    const set = (row, cols) => db.q(`UPDATE live_activities SET ${Object.keys(cols).map(c => `${c} = ?`).join(', ')} WHERE room_id = ? AND device_id = ?`).run(...Object.values(cols), r.id, row.device_id)
    await Promise.all(rows.map(async row => {
      const reg = { environment: row.environment, topic: row.topic }
      if (row.activity_token) {
        if (!state.working) {
          await apns.sendLive({ ...reg, token: row.activity_token }, { event: 'end', state })
          return set(row, { activity_token: null, started_at: null, sent: null })
        }
        if (row.sent === key) return
        const before = Number(String(row.sent ?? '0:0').split(':')[1])
        const status = await apns.sendLive({ ...reg, token: row.activity_token }, { event: 'update', state, urgent: state.waiting > before })
        return set(row, status === 410 ? { activity_token: null, started_at: null, sent: null } : { sent: key })
      }
      if (!state.working) return row.started_at != null ? set(row, { started_at: null, sent: null }) : undefined
      // started and its token not here yet (the app registers it when iOS wakes it): no second start
      if (!row.start_token || (row.started_at != null && now() - row.started_at < 8 * 3600000)) return
      const status = await apns.sendLive({ ...reg, token: row.start_token }, { event: 'start', state, tag: row.tag })
      set(row, status === 410 ? { start_token: null } : status === 200 ? { started_at: now(), sent: key } : {})
    }))
  }

  /** R4 fencing (review 3: also streams and uploads): an agent names the lease generation it holds. */
  function fenced(r, req, me) {
    if (me.role !== 'agent') return null
    const raw = req.headers['x-lease-generation']
    // Strict: no header, or one that is not a generation, is lease-lost.
    if (raw == null || !/^\d{1,16}$/.test(raw)) fail('lease-lost', 'an agent names its lease generation (x-lease-generation): take the lease with agent_lease first')
    const held = r.hub.leaseOf(me.id)
    if (!held || held.generation !== Number(raw)) fail('lease-lost', 'another process took over this agent key')
    return Number(raw)
  }

  async function stream(r, req, res, url) {
    const me = r.hub.authorise(bearer(req), { member: true })
    if (deviceStreams(r, me.id).length >= LIMITS.streamsPerDevice) fail('too-many', `at most ${LIMITS.streamsPerDevice} streams per device`)
    // A stream that names an older lease generation belongs to a process that was taken over (R4).
    const leaseGeneration = fenced(r, req, me)
    let after = intParam(url, 'after_envelope_number', 0, 0, Number.MAX_SAFE_INTEGER)
    const last = Number(req.headers['last-event-id'])
    if (!url.searchParams.has('after_envelope_number') && Number.isSafeInteger(last) && last > 0) after = last
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no', connection: 'keep-alive' })
    res.flushHeaders()
    req.setTimeout(0)                                  // a stream lives on its pings, not on the request idle timeout
    req.socket.setNoDelay(true)
    const s = { deviceId: me.id, leaseGeneration, res, catchingUp: true, pending: [] }
    r.streams.add(s)
    ops.track(s, req)
    res.on('error', () => {})
    const ping = setInterval(() => { if (!res.writableEnded) res.write(sse('ping', {})) }, pingMs)
    // An agent's lease lives while it has a stream open, and 60 s after the last one closed.
    // A timer and the close handler call this: a throw there would be an uncaught exception and take the hub down.
    const touch = () => { try { r.hub.touchLease(me.id) } catch (err) { log(`lease touch: ${err.message}`) } }
    const lease = me.role === 'agent' ? setInterval(touch, 20000) : null
    if (lease) touch()
    r.offlineSince.delete(me.id)
    if (deviceStreams(r, me.id).length === 1) streamOpened(r, me.id)
    const done = () => {
      clearInterval(ping); if (lease) clearInterval(lease)
      if (!r.streams.delete(s)) return
      if (me.role === 'agent') touch()
      if (deviceStreams(r, me.id).length) return
      r.offlineSince.set(me.id, now())
      streamsGone(r, me.id)
    }
    res.on('close', done)
    res.write(': trommi hub\n\n')
    // Catch-up first (the depth rule of GET envelopes), then whatever arrived meanwhile, then live.
    let sent = after
    // A stream is over when the hub ended it or when it was destroyed (the client went away, a buffer cap dropped it):
    // writableEnded alone stays false after a destroy, and the catch-up would read the whole room for nobody.
    const over = () => res.writableEnded || res.destroyed
    // In small slices: read a few rows, write them, and wait until the socket took them before reading more,
    // so a thousand slow clients catching up from 0 hold kilobytes each, not megabytes.
    while (!over()) {
      const rows = envelopeRows(r.id, sent, CATCH_UP_SLICE)
      stats.catchUpSlices++
      for (const row of rows) if (!over()) res.write(sse('envelope', record(row), row.envelope_number))
      if (rows.length) sent = rows.at(-1).envelope_number
      if (rows.length < CATCH_UP_SLICE || over()) break
      // Both listeners go once either fires: a long catch-up must not pile up 'close' listeners on the response.
      if (res.writableLength > CATCH_UP_HIGH_WATER) await new Promise(ok => { const go = () => { res.off('drain', go); res.off('close', go); ok() }; res.on('drain', go); res.on('close', go) })
      else await new Promise(ok => setImmediate(ok))      // let live traffic and other streams in between slices
    }
    if (over()) return
    for (const c of s.pending) if (c.n == null || c.n > sent) res.write(c.text)
    s.pending = []
    s.catchingUp = false
  }

  async function putAttachment(r, req, res, attachmentId) {
    const me = r.hub.authorise(bearer(req), { member: true })
    hexParam(attachmentId, HEX32, 'attachment_id')
    fenced(r, req, me)
    if (Number(req.headers['content-length'] || 0) > LIMITS.attachment) fail('too-large', 'an attachment is at most 64 MiB')
    ops.quota.check(r.id, Number(req.headers['content-length'] || 0), me.id)
    if (db.q('SELECT 1 FROM attachments WHERE room_id = ? AND attachment_id = ?').get(r.id, attachmentId)) fail('replay', 'this attachment is already stored; attachments are immutable')
    let size
    // C03: an upload gets 60 s plus a minimum rate, then the connection goes.
    const deadline = setTimeout(() => req.destroy(), 60000 + Math.ceil(Number(req.headers['content-length'] || LIMITS.attachment) / UPLOAD_MIN_BYTES_PER_S) * 1000)
    try { size = await files.put(r.id, attachmentId, req, LIMITS.attachment) } catch (err) {
      if (err.code === 'too-large' || err.code === 'replay') fail(err.code, err.message)
      throw err
    } finally { clearTimeout(deadline) }
    // C04: removed while uploading -> nothing stored.
    try { r.hub.authorise(bearer(req), { member: true }) } catch (err) { files.delete(r.id, attachmentId); throw err }
    try { ops.quota.make(r.id, size, me.id) } catch (err) { files.delete(r.id, attachmentId); throw err }
    db.q('INSERT INTO attachments (room_id, attachment_id, object_id, uploader_device_id, total_size, chunk_count, stored_at) VALUES (?, ?, NULL, ?, ?, ?, ?)')
      .run(r.id, attachmentId, me.id, size, chunkCount(size), now())
    send(res, 201, { attachment_id: attachmentId, total_size: size })
  }

  function getAttachment(r, req, res, attachmentId) {
    r.hub.authorise(bearer(req), { member: true })
    hexParam(attachmentId, HEX32, 'attachment_id')
    serveFile(req, res, r.id, attachmentId)
  }

  // ---- links for people outside the room (share_asset) ---------------------------------------------
  // The uploader, or a human device of the room for any attachment of it (the app's Links page), registers a share:
  // { share_id, share_secret_hash = b64u(SHA-256(secret)), expires_at }. Whoever
  // holds the secret (it travels in the link's #, never to a server but this hub, in a header) gets the encrypted
  // bytes; the key to open them is in the # as well and never reaches the hub.
  const SHARE_MAX_MS = 30 * DAY
  db.exec(`CREATE TABLE IF NOT EXISTS shares (share_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, attachment_id TEXT NOT NULL, share_secret_hash BLOB NOT NULL,
    expires_at INTEGER NOT NULL, created_by_device_id TEXT NOT NULL, created_at INTEGER NOT NULL) WITHOUT ROWID`)
  const shareLimit = buckets(60 / 60, 60, now)
  async function postShare(r, req, res, attachmentId) {
    const me = r.hub.authorise(bearer(req), { member: true })
    hexParam(attachmentId, HEX32, 'attachment_id')
    const a = db.q('SELECT uploader_device_id FROM attachments WHERE room_id = ? AND attachment_id = ?').get(r.id, attachmentId)
    if (!a) fail('not-found', 'no such attachment')
    if (a.uploader_device_id !== me.id && me.role !== 'human') fail('forbidden', 'only the uploader or a human device shares an attachment')
    const body = await readJson(req)
    r.hub.authorise(bearer(req), { member: true })          // C04: still a member once the body is in
    const shareId = hexParam(body.share_id, HEX32, 'share_id')
    const hash = b64(body.share_secret_hash, 'share_secret_hash')
    if (hash.length !== 32) fail('bad-argument', 'share_secret_hash is a SHA-256 (32 bytes)')
    const expiresAt = body.expires_at
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now() || expiresAt > now() + SHARE_MAX_MS) fail('bad-argument', 'expires_at: in the future, at most 30 days')
    if (db.q('SELECT 1 FROM shares WHERE share_id = ?').get(shareId)) fail('replay', 'this share id is taken')
    if (db.q('SELECT COUNT(*) AS n FROM shares WHERE room_id = ? AND expires_at > ?').get(r.id, now()).n >= 1000) fail('too-many', 'too many open shares in this room')
    db.q('INSERT INTO shares (share_id, room_id, attachment_id, share_secret_hash, expires_at, created_by_device_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(shareId, r.id, attachmentId, hash, expiresAt, me.id, now())
    send(res, 201, { share_id: shareId, expires_at: expiresAt })
  }
  function deleteShare(r, req, res, attachmentId, shareId) {
    const me = r.hub.authorise(bearer(req), { member: true })
    hexParam(shareId, HEX32, 'share_id')
    const sh = db.q('SELECT created_by_device_id FROM shares WHERE share_id = ? AND room_id = ? AND attachment_id = ?').get(shareId, r.id, attachmentId)
    if (!sh) fail('not-found', 'no such share')
    if (sh.created_by_device_id !== me.id && me.role !== 'human') fail('forbidden', 'the creator or a human device revokes a share')
    db.q('DELETE FROM shares WHERE share_id = ?').run(shareId)
    send(res, 200, { ok: true })
  }
  function getShare(req, res, shareId) {
    const wait = shareLimit.take(ipOf(req))
    if (wait) fail('rate-limited', 'too many share requests from this address', { retryAfter: wait })
    hexParam(shareId, HEX32, 'share_id')
    const secret = req.headers['x-share-secret']
    const sh = db.q('SELECT room_id, attachment_id, share_secret_hash, expires_at FROM shares WHERE share_id = ?').get(shareId)
    // One answer for "no such share", "wrong secret" and "expired": nothing to learn by guessing.
    let okSecret = false
    if (sh && typeof secret === 'string' && /^[A-Za-z0-9_-]{43}$/.test(secret)) {
      const h = crypto.createHash('sha256').update(Buffer.from(secret, 'base64url')).digest()
      okSecret = h.length === sh.share_secret_hash.length && crypto.timingSafeEqual(h, Buffer.from(sh.share_secret_hash))
    }
    if (!okSecret || sh.expires_at <= now()) fail('not-found', 'no such share, or it ran out')
    res.setHeader('cache-control', 'private, no-store')
    serveFile(req, res, sh.room_id, sh.attachment_id, { cacheable: false })
  }

  function serveFile(req, res, roomId, attachmentId, { cacheable = true } = {}) {
    // Opened before the answer starts (a file evicted or pruned meanwhile is a 404, an unreadable one a 500, never an
    // unhandled stream error), and piped with pipeline(): a client that goes away mid-file closes the file too.
    const f = db.q('SELECT 1 FROM attachments WHERE room_id = ? AND attachment_id = ?').get(roomId, attachmentId) ? files.open(roomId, attachmentId) : null
    if (!f) fail('not-found', 'no such attachment')
    let body = null
    try {
      const size = f.size
      const headers = { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes', 'cache-control': cacheable ? 'private, max-age=31536000, immutable' : 'private, no-store' }
      const range = req.headers.range
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
        let start, end
        if (m && m[1] !== '') { start = Number(m[1]); end = m[2] !== '' ? Math.min(Number(m[2]), size - 1) : size - 1 }
        else if (m && m[2] !== '') { start = Math.max(0, size - Number(m[2])); end = size - 1 }
        if (!m || start > end || start >= size) {
          res.writeHead(416, { 'content-range': `bytes */${size}`, 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'bad-argument', message: 'range not satisfiable' }))
          return
        }
        res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 })
        if (req.method === 'HEAD') return res.end()
        body = f.read({ start, end })
      } else {
        res.writeHead(200, { ...headers, 'content-length': size })
        if (req.method === 'HEAD') return res.end()
        body = f.read()
      }
    } finally { if (!body) f.close() }
    pipeline(body, res).catch(() => {})
  }

  async function roomRoute(req, res, url, roomId, rest) {
    const m = req.method
    const r = await room(roomId)
    const hub = r.hub
    const parts = rest.split('/').filter(Boolean)
    const [a, b, c] = parts
    if (m === 'POST' && a === 'challenge' && !b) { openRoute(req, r.id); return send(res, 200, { challenge: z.b64u(hub.challenge()) }) }
    if (m === 'POST' && a === 'access_tokens' && !b) {
      openRoute(req, r.id)
      const body = await readJson(req)
      const t = await hub.signIn(b64(body.signed_challenge, 'signed_challenge'))
      return send(res, 200, { access_token: t.token, device_id: t.id, signer: t.kind === 'recovery' ? 'recovery' : 'device', device_role: t.kind === 'recovery' ? null : t.role, expires_at: t.expiresAt })
    }
    if (a === 'members' && !b) {
      if (m === 'GET') {
        const after = intParam(url, 'after_entry_number', -1, -1, 2 ** 32)
        const inviteId = url.searchParams.get('invite_id')
        if (inviteId != null) { openRoute(req, r.id); hexParam(inviteId, HEX32, 'invite_id') }
        const out = hub.log(inviteId != null ? { inviteId, after } : { token: bearer(req), after })
        return send(res, 200, { room_id: out.roomId, last_entry_number: out.head, signed_entries: out.entries.map(z.b64u) })
      }
      if (m === 'POST') return memberEntry(r, req, res)
    }
    if (m === 'GET' && a === 'devices' && !b) {
      hub.authorise(bearer(req), { member: true })
      const online = new Set([...r.streams].map(s => s.deviceId))
      const devices = db.q('SELECT device_id, device_role, removed_entry_number FROM devices WHERE room_id = ? ORDER BY added_entry_number, device_id').all(r.id)
        .map(d => ({ device_id: d.device_id, device_role: d.device_role, is_active: d.removed_entry_number == null, is_online: online.has(d.device_id), ...(!online.has(d.device_id) && r.offlineSince.has(d.device_id) ? { offline_since: r.offlineSince.get(d.device_id) } : {}), ...(r.link.get(d.device_id)?.report ? { link: r.link.get(d.device_id).report } : {}) }))
      return send(res, 200, { last_entry_number: hub.state.head.seq, devices })
    }
    if (m === 'GET' && a === 'sealed_room_keys' && !b) {
      const afterEpoch = intParam(url, 'after_key_epoch', 0, 0, 2 ** 32)
      return send(res, 200, { sealed_room_keys: hub.wraps(bearer(req), { afterEpoch }).map(w => ({ key_epoch: w.epoch, key_sealed: z.b64u(w.sealed) })) })
    }
    if (m === 'GET' && a === 'key_back_links' && !b) {
      return send(res, 200, { key_back_links: hub.backLinks(bearer(req)).map(l => ({ key_epoch: l.epoch, key_back_link: z.b64u(l.bytes) })) })
    }
    if (a === 'invites') {
      if (m === 'POST' && !b) {
        const token = bearer(req)
        hub.authorise(token, { human: true })                // before the body: a bad token holds no write slot
        const body = await readJson(req)
        const out = await hub.postInvite(token, b64(body.signed_offer, 'signed_offer'))
        return send(res, 200, { invite_id: out.inviteId, device_role: out.role, expires_at: out.expiresAt })
      }
      if (b) hexParam(b, HEX32, 'invite_id')
      if (m === 'DELETE' && b && !c) return send(res, 200, await hub.burnInvite(bearer(req), b))
      if (m === 'GET' && b && !c) {
        openRoute(req, r.id)
        const inv = hub.invite(b)
        return send(res, 200, { signed_offer: z.b64u(inv.offer), device_role: inv.role, expires_at: inv.expiresAt, room_id: inv.roomId, signed_entries: inv.entries.map(z.b64u) })
      }
      if (b && c === 'requests' && !parts[3]) {
        if (m === 'POST') {
          openRoute(req, r.id)
          const body = await readJson(req)
          const out = await hub.postRequest(b, b64(body.signed_request, 'signed_request'))
          if (!out.repeated) deliver(r, { text: sse('join_request', { invite_id: b }) }, s => s.deviceId === out.inviter)
          return send(res, 200, { request_hash: out.requestHash })
        }
        if (m === 'GET') return send(res, 200, { signed_requests: hub.requests(bearer(req), b).map(z.b64u) })
      }
      if (m === 'POST' && b && c === 'reveal' && !parts[3]) {
        const token = bearer(req)
        hub.authorise(token, { human: true })
        const body = await readJson(req)
        const out = await hub.postReveal(token, b, b64(body.signed_reveal, 'signed_reveal'))
        return send(res, 200, { request_hash: out.requestHash })
      }
      if (m === 'GET' && b && c === 'status' && !parts[3]) {
        openRoute(req, r.id)
        const requestHash = hexParam(url.searchParams.get('request_hash'), HEX64, 'request_hash')
        const st = hub.joinStatus(b, requestHash)
        return send(res, 200, {
          join_status: st.status,
          ...(st.reveal ? { signed_reveal: z.b64u(st.reveal) } : {}),
          ...(st.entries ? { signed_entries: st.entries.map(z.b64u) } : {}),
          ...(st.wrap ? { key_sealed: z.b64u(st.wrap) } : {}),
        })
      }
    }
    if (a === 'envelopes' && !b) {
      if (m === 'POST') return postEnvelope(r, req, res)
      if (m === 'GET') {
        // Members; also the recovery key, in the pruned form only (it signs the removal cuts of a recovery from the heads).
        const who = hub.authorise(bearer(req))
        let after = intParam(url, 'after_envelope_number', 0, 0, Number.MAX_SAFE_INTEGER)
        const limit = intParam(url, 'limit', 1000, 1, 1000)
        const last = db.q('SELECT last_envelope_number FROM rooms WHERE room_id = ?').get(r.id).last_envelope_number
        // newest=1: the newest `limit` envelopes after the cursor (a new device finds the snapshot pointer in one request)
        if (url.searchParams.get('newest') === '1') after = Math.max(after, last - limit)
        const rows = envelopeRows(r.id, after, limit)
        const out = who.kind === 'recovery' ? rows.map(x => record({ ...x, encrypted_body: null })) : rows.map(record)
        return send(res, 200, { last_envelope_number: last, envelopes: out })
      }
    }
    if (m === 'GET' && a === 'threads' && !b) {
      hub.authorise(bearer(req), { member: true })
      const kindParam = url.searchParams.get('timeline_kind') ?? ''
      const kind = TIMELINE_NAMES[kindParam] ?? (/^\d{1,3}$/.test(kindParam) && Number(kindParam) >= 1 && Number(kindParam) <= 255 ? Number(kindParam) : null)
      if (kind == null) fail('bad-argument', 'timeline_kind: chat, canvas or a number')
      const timelineId = url.searchParams.get('timeline_id')
      if (!timelineId || Buffer.byteLength(timelineId) > z.TIMELINE_ID_MAX) fail('bad-argument', 'timeline_id')
      const limit = intParam(url, 'limit', 50, 1, 500)
      const cols = 'envelope_number, envelope_header, envelope_nonce, envelope_signature, encrypted_body_hash, encrypted_body'
      let rows
      if (url.searchParams.has('after_envelope_number')) {
        const after = intParam(url, 'after_envelope_number', 0, 0, Number.MAX_SAFE_INTEGER)
        rows = db.q(`SELECT ${cols} FROM envelopes WHERE room_id = ? AND timeline_kind = ? AND timeline_id = ? AND envelope_number > ? ORDER BY envelope_number LIMIT ?`).all(r.id, kind, timelineId, after, limit + 1)
      } else {
        const before = intParam(url, 'before_envelope_number', Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER)
        rows = db.q(`SELECT ${cols} FROM envelopes WHERE room_id = ? AND timeline_kind = ? AND timeline_id = ? AND envelope_number < ? ORDER BY envelope_number DESC LIMIT ?`).all(r.id, kind, timelineId, before, limit + 1)
      }
      const hasMore = rows.length > limit
      return send(res, 200, { envelopes: rows.slice(0, limit).map(record), has_more: hasMore })
    }
    if (m === 'GET' && a === 'stream' && !b) return stream(r, req, res, url)
    if (m === 'POST' && a === 'agent_lease' && !b) {
      const token = bearer(req)
      hub.authorise(token, { member: true })
      const body = await readJson(req)
      const instance = body.process_instance
      if (typeof instance !== 'string' || !instance || instance.length > 200) fail('bad-argument', 'process_instance')
      const me = hub.authorise(token, { member: true })
      const out = hub.takeLease(token, { instance, renew: body.renew === true })
      // A new process took the key over: every stream of this key that does not name the new generation ends now.
      // The new process reconnects naming it; the old one reconnects naming its own and gets lease-lost, as its posts do.
      if (out.previousInstance) closeStreams(r, [me.id], s => s.leaseGeneration !== out.generation)
      return send(res, 200, { lease_generation: out.generation, expires_at: out.expiresAt })
    }
    if (m === 'POST' && a === 'agent_link' && !b) {
      // The link report (above): an agent's connector about itself, under its lease.
      const me = hub.authorise(bearer(req), { member: true })
      if (me.role !== 'agent') fail('forbidden', 'only an agent reports its link')
      fenced(r, req, me)
      const report = linkReport(await readJson(req))
      const e = linkOf(r, me.id)
      e.report = report
      if (e.working !== report.working) liveSoon(r)
      e.working = report.working
      announce(r, me.id)
      if (!report.cut_since) e.cut_pushed = null
      else if (e.cut_pushed !== report.cut_since && deviceStreams(r, me.id).length) {
        e.cut_pushed = report.cut_since
        sendLinkPush(r, me.id, 'cut', report.cut_since).catch(err => log(`push: ${err.message}`))
      }
      return send(res, 200, { ok: true })
    }
    if (m === 'POST' && a === 'agent_watch' && !b) {
      // A connector before the link report: only whether it has running work.
      const me = hub.authorise(bearer(req), { member: true })
      if (me.role !== 'agent') fail('forbidden', 'only an agent arms the loss watch')
      fenced(r, req, me)
      const body = await readJson(req)
      if (typeof body.working !== 'boolean') fail('bad-argument', 'working')
      if (linkOf(r, me.id).working !== body.working) liveSoon(r)
      linkOf(r, me.id).working = body.working
      return send(res, 200, { ok: true })
    }
    // One atomic batch of session grants (a removal re-keys every session in one post): all or none.
    if (a === 'session_grants' && !b && m === 'POST') {
      const body = await readJson(req)
      if (!Array.isArray(body.grants)) fail('bad-argument', 'grants must be a list')
      const list = body.grants.map(g => ({
        sessionId: hexParam(g?.session_id, HEX32, 'session_id'), grant: b64(g?.signed_grant, 'signed_grant'),
        wraps: (Array.isArray(g?.sealed_session_keys) ? g.sealed_session_keys : fail('bad-argument', 'sealed_session_keys must be a list')).map(w => ({ id: z.unhex(hexParam(w?.device_id, HEX64, 'device_id')), sealed: b64(w?.key_sealed, 'key_sealed') })),
        backLink: g?.key_back_link != null ? b64(g.key_back_link, 'key_back_link') : undefined,
      }))
      const out = await hub.postGrants(list)
      for (const o of out) deliver(r, { text: sse('session_grant', { session_id: o.sessionId, grant_number: o.grantNumber, session_key_epoch: o.sessionKeyEpoch }) })
      return send(res, 200, { grants: out.map(o => ({ session_id: o.sessionId, grant_number: o.grantNumber, grant_hash: o.grantHash, session_key_epoch: o.sessionKeyEpoch })) })
    }
    // Grants, own sealed session keys and back links of many sessions in one answer (a new device, a reconnect).
    if (a === 'session_grants' && !b && m === 'GET') {
      const raw = url.searchParams.get('session_ids')
      const ids = raw == null ? null : raw.split(',').filter(Boolean).map(x => hexParam(x, HEX32, 'session_id'))
      if (ids && ids.length > 256) fail('bad-argument', 'at most 256 session_ids')
      const out = hub.sessionBundle(bearer(req), ids)
      return send(res, 200, { sessions: out.map(x => ({
        session_id: x.sessionId,
        signed_grants: x.grants.map(z.b64u),
        sealed_session_keys: x.wraps.map(w => ({ session_key_epoch: w.epoch, key_sealed: z.b64u(w.sealed) })),
        ...(x.links ? { key_back_links: x.links.map(l => ({ session_key_epoch: l.epoch, key_back_link: z.b64u(l.bytes) })) } : {}),
      })) })
    }
    if (a === 'sessions') {
      if (m === 'GET' && !b) {
        hub.authorise(bearer(req))
        return send(res, 200, { sessions: hub.sessionsList() })
      }
      if (b) hexParam(b, HEX32, 'session_id')
      if (b && c === 'grants' && !parts[3]) {
        if (m === 'POST') {
          const body = await readJson(req)
          const grant = b64(body.signed_grant, 'signed_grant')
          if (!Array.isArray(body.sealed_session_keys)) fail('bad-argument', 'sealed_session_keys must be a list')
          const wraps = body.sealed_session_keys.map(w => ({ id: z.unhex(hexParam(w?.device_id, HEX64, 'device_id')), sealed: b64(w?.key_sealed, 'key_sealed') }))
          const backLink = body.key_back_link != null ? b64(body.key_back_link, 'key_back_link') : undefined
          const out = await hub.postGrant({ sessionId: b, grant, wraps, backLink })
          deliver(r, { text: sse('session_grant', { session_id: b, grant_number: out.grantNumber, session_key_epoch: out.sessionKeyEpoch }) })
          return send(res, 200, { grant_number: out.grantNumber, grant_hash: out.grantHash, session_key_epoch: out.sessionKeyEpoch })
        }
        if (m === 'GET') {
          const after = intParam(url, 'after_grant_number', -1, -1, 2 ** 32)
          return send(res, 200, { signed_grants: (await hub.grants(bearer(req), b)).slice(after + 1).map(z.b64u) })
        }
      }
      if (m === 'GET' && b && c === 'sealed_session_keys' && !parts[3]) {
        const afterEpoch = intParam(url, 'after_session_key_epoch', 0, 0, 2 ** 32)
        return send(res, 200, { sealed_session_keys: hub.sessionWraps(bearer(req), b, { afterEpoch }).map(w => ({ session_key_epoch: w.epoch, key_sealed: z.b64u(w.sealed) })) })
      }
      if (m === 'GET' && b && c === 'key_back_links' && !parts[3]) {
        return send(res, 200, { key_back_links: (await hub.sessionBackLinks(bearer(req), b)).map(l => ({ session_key_epoch: l.epoch, key_back_link: z.b64u(l.bytes) })) })
      }
    }
    if (a === 'attachments' && b) hexParam(b, HEX32, 'attachment_id')
    if (a === 'attachments' && b && c === 'shares' && parts[3]) hexParam(parts[3], HEX32, 'share_id')
    if (a === 'attachments' && b && !c) {
      if (m === 'PUT') return putAttachment(r, req, res, b)
      if (m === 'GET' || m === 'HEAD') return getAttachment(r, req, res, b)
    }
    if (a === 'attachments' && b && c === 'shares') {
      if (m === 'POST' && !parts[3]) return postShare(r, req, res, b)
      if (m === 'DELETE' && parts[3] && !parts[4]) return deleteShare(r, req, res, b, parts[3])
    }
    // Every human device's push state, for its settings page: per device how many registrations and their levels (no
    // endpoint, no key: what a device registered stays its own).
    if (m === 'GET' && a === 'push_subscriptions' && !b) {
      hub.authorise(bearer(req), { human: true })
      const rows = db.q(`SELECT p.device_id, p.endpoint, p.level FROM push_subscriptions p JOIN devices d ON d.room_id = p.room_id AND d.device_id = p.device_id
        WHERE p.room_id = ? AND d.device_role = 'human' AND d.removed_entry_number IS NULL`).all(r.id)
      const devices = {}
      for (const row of rows) {
        const d = devices[row.device_id] ??= { web: 0, apns: 0, level: row.level }
        d[row.endpoint.startsWith('apns:') ? 'apns' : 'web']++
        if (row.level === 'all') d.level = 'all'
      }
      return send(res, 200, { devices })
    }
    if (m === 'POST' && a === 'push_subscriptions' && !b) {
      const me = hub.authorise(bearer(req), { human: true })
      const body = await readJson(req)
      // An iPhone registers { apns: { token, environment, topic, key } } (hub/apns.mjs); its row's endpoint is apns:<token>.
      if (body.apns != null && !apns) fail('bad-argument', 'this hub sends no APNs push')
      const a = body.apns != null ? apns.check(body.apns) : null
      if (body.apns != null && !a) fail('bad-argument', 'not an APNs registration: { token, environment: sandbox | production, topic, key }')
      const sub = a ? { endpoint: `apns:${a.token}`, apns: a } : push.check(body.subscription)
      if (!sub) fail('bad-argument', 'not a Web Push subscription of a browser push service')
      if (body.level != null && !PUSH_LEVELS.includes(body.level)) fail('bad-argument', `level is one of ${PUSH_LEVELS.join(', ')}`)
      if (body.remove === true) db.q('DELETE FROM push_subscriptions WHERE room_id = ? AND device_id = ? AND endpoint = ?').run(r.id, me.id, sub.endpoint)
      else {
        const n = db.q('SELECT COUNT(*) AS n FROM push_subscriptions WHERE room_id = ? AND device_id = ?').get(r.id, me.id).n
        if (n >= LIMITS.pushSubscriptionsPerDevice && !db.q('SELECT 1 FROM push_subscriptions WHERE room_id = ? AND device_id = ? AND endpoint = ?').get(r.id, me.id, sub.endpoint)) fail('too-many', 'too many push subscriptions for this device')
        // (a registration made again keeps its level unless the body names one)
        db.q(`INSERT INTO push_subscriptions (room_id, device_id, endpoint, subscription, created_at, level) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET subscription = excluded.subscription${body.level != null ? ', level = excluded.level' : ''}`)
          .run(r.id, me.id, sub.endpoint, JSON.stringify(sub), now(), body.level ?? 'all')
      }
      return send(res, 200, { ok: true })
    }
    // One envelope for an iPhone's Notification Service Extension, against the ticket its push carried (apns.mjs
    // pushTickets): no access token, no device key; the envelope is ciphertext, the extension opens it on the phone.
    if (m === 'GET' && a === 'push_envelope' && !b) {
      openRoute(req, r.id)
      const n = intParam(url, 'envelope_number', 0, 1, Number.MAX_SAFE_INTEGER)
      const deviceId = hexParam(url.searchParams.get('device_id'), HEX64, 'device_id')
      if (!tickets.check(r.id, deviceId, n, url.searchParams.get('ticket'), now())) fail('forbidden', 'no valid ticket for this envelope')
      if (!db.q("SELECT 1 FROM devices WHERE room_id = ? AND device_id = ? AND device_role = 'human' AND removed_entry_number IS NULL").get(r.id, deviceId)) fail('forbidden', 'not an active human device')
      const row = envelopeRows(r.id, n - 1, 1)[0]
      if (!row || row.envelope_number !== n) fail('not-found', 'no such envelope')
      return send(res, 200, record(row))
    }
    // An iPhone's Live Activity tokens (README "Live Activity"): kind start (its push-to-start token, with the tag the
    // activity's attributes carry) or activity (the token of the activity that runs); remove: true forgets it.
    if (m === 'POST' && a === 'live_activity' && !b) {
      const me = hub.authorise(bearer(req), { human: true })
      const body = await readJson(req)
      if (!apns) fail('bad-argument', 'this hub sends no APNs push')
      const reg = apns.checkLive(body.apns)
      if (!reg) fail('bad-argument', 'not an APNs token: { token, environment: sandbox | production, topic }')
      if (body.kind !== 'start' && body.kind !== 'activity') fail('bad-argument', 'kind is start or activity')
      const col = body.kind === 'start' ? 'start_token' : 'activity_token'
      if (body.remove === true) {
        db.q(`UPDATE live_activities SET ${col} = NULL WHERE room_id = ? AND device_id = ? AND ${col} = ?`).run(r.id, me.id, reg.token)
        db.q('DELETE FROM live_activities WHERE room_id = ? AND device_id = ? AND start_token IS NULL AND activity_token IS NULL').run(r.id, me.id)
      } else {
        if (body.kind === 'start' && (typeof body.tag !== 'string' || !/^[0-9a-f]{8,32}$/.test(body.tag))) fail('bad-argument', 'tag: 8 to 32 lowercase hex')
        db.q(`INSERT INTO live_activities (room_id, device_id, environment, topic, tag, ${col}, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (room_id, device_id) DO UPDATE SET environment = excluded.environment, topic = excluded.topic, ${col} = excluded.${col}${body.kind === 'start' ? ', tag = excluded.tag' : ''}`)
          .run(r.id, me.id, reg.environment, reg.topic, body.kind === 'start' ? body.tag : '', reg.token, now())
        liveSoon(r)
      }
      return send(res, 200, { ok: true, ...liveCounts(r) })
    }
    fail('not-found', 'no such route')
  }

  async function handle(req, res) {
    cors(req, res)
    const url = new URL(req.url, 'http://hub')
    if (req.method === 'OPTIONS') {
      if (allowedOrigin(req.headers.origin)) {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE')
        res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, range, last-event-id, x-found-token, x-test-signature, x-lease-generation, x-share-secret, trommi-client, trommi-protocol')
        res.setHeader('Access-Control-Max-Age', '86400')
      }
      res.writeHead(204).end()
      return
    }
    if (await ops.handle(req, res, url)) return
    if (await accounts.handle(req, res, url)) return
    if (url.pathname === '/healthz' && req.method === 'GET') return send(res, 200, { ok: true, commit, protocol_version: PROTOCOL_VERSION })
    if (url.pathname === '/v1/push_key' && req.method === 'GET') return send(res, 200, { vapid_public_key: push.publicKey, apns: !!apns })
    const share = /^\/v1\/shares\/([^/]+)$/.exec(url.pathname)
    if (share && (req.method === 'GET' || req.method === 'HEAD')) return getShare(req, res, share[1])
    if (url.pathname === '/v1/rooms' && req.method === 'POST') return found(req, res)
    const m = /^\/v1\/rooms\/([^/]+)(\/.*)?$/.exec(url.pathname)
    if (m) return roomRoute(req, res, url, m[1], m[2] ?? '')
    // A person who opens the hub in a browser lands in the app: GET / and any other page navigation outside the API.
    if ((req.method === 'GET' || req.method === 'HEAD') && !url.pathname.startsWith('/v1/') && (url.pathname === '/' || isNavigation(req))) {
      res.writeHead(302, { location: appUrl, 'cache-control': 'no-store', 'content-length': '0' }).end()
      return
    }
    fail('not-found', 'no such route')
  }
  const isNavigation = req => req.headers['sec-fetch-mode'] === 'navigate' || /\btext\/html\b/.test(req.headers.accept ?? '')

  // F14: requests in flight are counted; close() refuses new ones and waits for these before the database closes.
  let closing = false, inFlight = 0, drained = null
  const server = http.createServer((req, res) => {
    req.setTimeout(IDLE_MS, () => req.destroy())       // C03: no bytes moving for 30 s -> closed (the stream turns this off)
    if (closing) { res.setHeader('retry-after', '1'); return send(res, 503, { error: 'overloaded', message: 'the hub is restarting; try again in a second' }) }
    inFlight++
    const done = () => { inFlight--; if (closing && inFlight === 0) drained?.() }
    handle(req, res).finally(done).catch(err => {
      if (err?.reply) return send(res, err.reply.status, err.reply.body)
      let code = err?.code, message = err?.message
      if (!(err instanceof z.ZError || err instanceof HubError) || !STATUS[code]) {
        // A ZError with a code the table does not list is still a refusal of the request, not our failure.
        if (err instanceof z.ZError) { send(res, 400, { error: code, message }); return }
        log(`internal error on ${req.method} ${req.url.split('?')[0]}: ${err?.stack ?? err}`)
        code = 'internal'; message = 'internal error'
      }
      if (err.retryAfter) res.setHeader('retry-after', String(err.retryAfter))
      send(res, STATUS[code], { error: code, message, ...(err.voided ? { voided: true, envelope_number: err.envelopeNumber } : {}), ...(err.signedEntries ? { signed_entries: err.signedEntries.map(z.b64u) } : {}) })
    })
  })
  server.requestTimeout = 0          // streams and big uploads: their own idle timeout and deadline (above); headers time out
  server.headersTimeout = 30000
  server.keepAliveTimeout = 65000

  // ---- retention ---------------------------------------------------------------------

  /** Prune objects answered or closed for 30 days: their envelopes and their card chat keep only header, hash, signature. */
  function prune({ days = LIMITS.retentionDays } = {}) {
    const cutoff = now() - days * DAY
    const due = db.q(`SELECT o.room_id, o.object_id FROM objects o JOIN envelopes e ON e.room_id = o.room_id AND e.envelope_number = o.latest_head_envelope_number
      WHERE o.object_state != 1 AND e.received_at < ?`).all(cutoff)
    let envelopes = 0, attachments = 0
    for (const o of due) {
      const gone = []
      db.tx(() => {
        envelopes += Number(db.q(`UPDATE envelopes SET encrypted_body = NULL WHERE room_id = ? AND encrypted_body IS NOT NULL
          AND (object_id = ? OR (timeline_kind = 1 AND timeline_id = ?))`).run(o.room_id, o.object_id, `card/${o.object_id}`).changes)
        for (const a of db.q('SELECT attachment_id FROM attachments WHERE room_id = ? AND object_id = ?').all(o.room_id, o.object_id)) {
          db.q('DELETE FROM attachments WHERE room_id = ? AND attachment_id = ?').run(o.room_id, a.attachment_id)
          gone.push(a.attachment_id)
        }
      })
      // Files go after the commit (H10): a rolled-back transaction never leaves rows without files.
      for (const id of gone) files.delete(o.room_id, id)
      attachments += gone.length
    }
    if (envelopes || attachments) log(`retention: pruned ${envelopes} envelopes, deleted ${attachments} attachments`)
    return { objects: due.length, envelopes, attachments }
  }
  /** H3: an upload no envelope of its uploader named within an hour is deleted (it would pin the quota forever). */
  function sweepPending({ olderThanMs = 3600000 } = {}) {
    const due = db.q('SELECT room_id, attachment_id FROM attachments WHERE referenced_at IS NULL AND stored_at < ?').all(now() - olderThanMs)
    for (const a of due) {
      db.q('DELETE FROM attachments WHERE room_id = ? AND attachment_id = ? AND referenced_at IS NULL').run(a.room_id, a.attachment_id)
      files.delete(a.room_id, a.attachment_id)
    }
    if (due.length) log(`deleted ${due.length} upload(s) no envelope named within an hour`)
    return due.length
  }
  // A global bound on what all streams together hold in send buffers: over it, the fattest are dropped and
  // resume by cursor (HUB_STREAM_BUFFER_TOTAL_BYTES, default 256 MiB). Checked every streamCapEveryMs.
  const streamTotalCap = Number(process.env.HUB_STREAM_BUFFER_TOTAL_BYTES || 256 << 20)
  function capStreams() {
    const all = [...ops.flow.streams].map(x => ({ x, b: x.res.writableLength + (x.catchingUp ? (x.pendingBytes ?? 0) : 0) }))
    let total = all.reduce((t, e) => t + e.b, 0)
    if (total <= streamTotalCap) return 0
    let dropped = 0
    for (const e of all.sort((p, q) => q.b - p.b)) {
      if (total <= streamTotalCap * 0.8) break
      e.x.res.destroy(); total -= e.b; dropped++
    }
    log(`stream buffers over ${streamTotalCap >> 20} MiB: dropped ${dropped} stream(s); they resume by cursor`)
    return dropped
  }
  const timers = [
    setInterval(() => { try { capStreams() } catch (err) { log(`stream cap: ${err.message}`) } }, streamCapEveryMs),
    setInterval(() => { try { vacuumStep(db) } catch (err) { log(`vacuum: ${err.message}`) } }, 30000),
    setInterval(() => { try { prune() } catch (err) { log(`retention failed: ${err.message}`) } }, retentionEveryMs),
    setInterval(() => { try { sweepPending() } catch (err) { log(`pending uploads: ${err.message}`) } }, 600000),
    setInterval(() => {
      envelopeLimit.sweep(); openLimit.sweep(); pushLimit.sweep()
      for (const [ip, times] of founded) { const keep = times.filter(t => now() - t < 3600000); if (keep.length) founded.set(ip, keep); else founded.delete(ip) }
    }, 600000),
  ]
  for (const t of timers) t.unref()
  const firstPrune = setTimeout(() => { if (closing) return; try { prune() } catch (err) { log(`retention failed: ${err.message}`) } }, 60000)
  firstPrune.unref()

  const ops = await createOps({ db, dataDir, files, room, bearer, ipOf, now, log, closeRoom, announce: (id, event, data) => rooms.get(id)?.then(r => deliver(r, { text: sse(event, data) }), () => {}) })
  const accounts = createAccounts({ db, room, bearer, ipOf, mailer: createMailer({ log }), now, log })
  // The admin page (hub/admin.mjs, read-only but for the test-account cleanup it hands back to ops) on its own listener, only with ADMIN_PORT. It never takes the hub down:
  // a missing ADMIN_LOGINS or a busy port is logged and the hub runs without it.
  let admin = null
  if (adminPort) {
    try {
      const { startAdmin } = await import('./admin.mjs')
      admin = await startAdmin({ dbPath: path.join(dataDir, 'hub.db'), dataDir, port: Number(adminPort), host: process.env.ADMIN_HOST || '127.0.0.1',
        allowPublishedLoopback: process.env.ADMIN_PUBLISHED_LOOPBACK === '1', metrics: ops.metrics,
        actions: { deleteTestRooms: (ids, o) => ops.deleteTestRooms(ids, o) }, log: { warn: m => log(m), error: (...a) => log(a.join(' ')) } })
      log(`admin on ${process.env.ADMIN_HOST || '127.0.0.1'}:${admin.port}`)
    } catch (err) { log(`admin not started: ${err.message}`) }
  }
  await new Promise((ok, bad) => { server.once('error', bad); server.listen(port, host, ok) })
  const address = server.address()
  if (!hubUrl) hubUrl = `http://127.0.0.1:${address.port}`
  const startupMs = performance.now() - t0
  log(`listening on ${host}:${address.port} as ${hubUrl}, commit ${commit}, ready in ${startupMs.toFixed(1)} ms`)
  return {
    server, port: address.port, hubUrl, db, startupMs, stats, prune, sweepPending, ops, accounts, admin, capStreams, rebuildDerived: () => rebuildDerived(db),
    async close() {
      closing = true
      await admin?.close()
      clearTimeout(firstPrune)
      for (const t of timers) clearInterval(t)
      await ops.close()
      accounts.close()
      apns?.close()
      for (const p of rooms.values()) { const r = await p.catch(() => null); if (r) for (const s of r.streams) if (!s.res.writableEnded) s.res.end() }
      // Streams never finish on their own: they were ended above. Wait (at most 5 s) for the other requests.
      if (inFlight > 0) await Promise.race([new Promise(ok => { drained = ok }), new Promise(ok => setTimeout(ok, 5000).unref())])
      await new Promise(ok => { server.close(ok); server.closeAllConnections() })
      db.close()
    },
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const hub = await startHub()
  const stop = () => { hub.close().finally(() => process.exit(0)) }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}
