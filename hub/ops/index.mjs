// hub/ops: running the hub (stream "Hub-Betrieb"). Client versions, test rooms, backpressure, metrics,
// the attachment quota and the password escrow, wired into hub/server.mjs through createOps():
//
//   ops.handle(req, res, url)   first thing for every request: metrics, version gate (426), write admission
//                               (503), and the routes below; true when it answered
//   ops.send(s, chunk)          every chunk for a live stream (bounded buffer)    ops.track(s, req)  a new stream
//   ops.unlimited(req, roomId)  rate limits lifted (a signed test request, or a test room)
//   ops.testRooms.wanted/mark   founding with test_room: true                      ops.quota.check/make  uploads
//
// Routes: GET /v1/version · DELETE /v1/rooms/:room_id (test rooms) · GET /v1/rooms/:room_id/usage ·
// PUT|GET|DELETE /v1/rooms/:room_id/escrow (GET with a human token: status; GET /escrow/:escrow_id anonymous). Metrics: METRICS_PORT (+ METRICS_HOST, default 127.0.0.1) only.
import http from 'node:http'
import { envNumber } from './env.mjs'
import { sendJson, readJson, windowLimit, refuse } from './http.mjs'
import { clientVersions, parseClient } from './versions.mjs'
import { flowControl } from './flow.mjs'
import { testRooms } from './test-rooms.mjs'
import { attachmentQuota } from './quota.mjs'
import { passwordEscrow } from './escrow.mjs'
import { walKeeper } from './wal.mjs'
import { hubMetrics } from './metrics.mjs'

export { limitsFromEnv } from './env.mjs'

const ROOM_ROUTE = /^\/v1\/rooms\/([0-9a-f]{64})(?:\/(usage|escrow)(?:\/([^/]+))?)?$/
const HOUR = 3600000

export async function createOps({ db, dataDir, files, room, closeRoom, announce, bearer, ipOf, now = Date.now, log = () => {}, env = process.env }) {
  const versions = clientVersions({ env, log, now })
  const flow = flowControl({ maxWrites: envNumber(env, 'HUB_WRITE_QUEUE', 512), maxMembershipWrites: envNumber(env, 'HUB_WRITE_QUEUE_MEMBERSHIP', 32),
    maxWritesPerIp: envNumber(env, 'HUB_WRITE_PER_IP', 16), ipOf, streamBufferBytes: envNumber(env, 'HUB_STREAM_BUFFER_BYTES', 4 << 20) })
  const tests = testRooms({ db, dataDir, publicKey: env.HUB_TEST_PUBLIC_KEY, closeRoom, now, log })
  const quota = attachmentQuota({ db, files, quotaBytes: envNumber(env, 'ROOM_ATTACHMENT_QUOTA_BYTES', 1 << 30), announce, log })
  const escrow = passwordEscrow({ db, now })
  const escrowReads = windowLimit(envNumber(env, 'HUB_LIMIT_ESCROW_READS_PER_HOUR', 10), HOUR, now)
  const wal = walKeeper({ db, dataDir, truncateBytes: envNumber(env, 'HUB_WAL_TRUNCATE_BYTES', 64 << 20) })
  const metrics = hubMetrics({ dataDir, flow, wal, now, log })
  // Limits are lifted for test rooms only (a signed founding with test_room: true is handled in server.mjs).
  const unlimited = (req, roomId) => !!roomId && tests.isTestRoom(roomId)

  const guard = fn => () => { try { const p = fn(); p?.catch?.(err => log(`ops: ${err.message}`)) } catch (err) { log(`ops: ${err.message}`) } }
  const timers = [setInterval(guard(() => wal.checkpoint()), 10000), setInterval(guard(() => tests.expire()), 600000)]
  for (const t of timers) t.unref()
  guard(() => tests.expire())()

  let metricsServer = null
  const metricsPort = env.METRICS_PORT
  if (metricsPort) {
    metricsServer = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/metrics') { res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }); return res.end(metrics.text()) }
      if (req.method === 'GET' && req.url === '/metrics/history') return sendJson(res, 200, { interval_ms: 10000, samples: metrics.history() })
      sendJson(res, 404, { error: 'not-found', message: 'GET /metrics or /metrics/history' })
    })
    await new Promise((ok, bad) => { metricsServer.once('error', bad); metricsServer.listen(Number(metricsPort), env.METRICS_HOST || '127.0.0.1', ok) })
    log(`metrics on ${env.METRICS_HOST || '127.0.0.1'}:${metricsServer.address().port}`)
  }

  async function roomRoute(req, res, roomId, sub, escrowId) {
    if (escrowId != null && (sub !== 'escrow' || req.method !== 'GET')) return false
    if (escrowId != null && !/^[0-9a-f]{32}$/.test(escrowId)) refuse(400, 'bad-argument', 'escrow_id must be 32 lowercase hex')
    const m = req.method
    if (!sub && m === 'DELETE') { await tests.delete(req, roomId); return sendJson(res, 200, { ok: true }) }
    if (sub === 'usage' && m === 'GET') {
      ;(await room(roomId)).hub.authorise(bearer(req), { member: true })
      return sendJson(res, 200, { attachment_bytes: quota.used(roomId), quota_bytes: quota.quotaBytes })
    }
    if (sub === 'escrow') {
      if (m === 'GET' && escrowId == null && req.headers.authorization) {
        // A signed-in human member: status and revision (for PUT/DELETE); a v1 blob only here, to migrate it.
        const r = await room(roomId)
        r.hub.authorise(bearer(req), { human: true })
        return sendJson(res, 200, escrow.status(roomId))
      }
      if (m === 'GET') {
        // Anonymous, never unlimited. The address budget is charged first, so one address cannot spend the room's.
        // The room's budget counts only misses (review 3): reads with the right escrow id always go through, so
        // nobody can lock the owner out by burning the room's reads from many addresses. "No room", "no escrow" and
        // the retired room-id route are one answer.
        const wait = escrowReads.take(`ip:${ipOf(req)}`)
        const tooMany = w => { res.setHeader('retry-after', String(w)); return sendJson(res, 429, { error: 'rate-limited', message: 'too many escrow reads; try again later' }) }
        if (wait) return tooMany(wait)
        if (escrowId != null && db.q('SELECT 1 FROM rooms WHERE room_id = ?').get(roomId) && escrow.exists(roomId, escrowId)) return sendJson(res, 200, escrow.get(roomId, escrowId))
        const missWait = escrowReads.take(`room:${roomId}`)
        if (missWait) return tooMany(missWait)
        return sendJson(res, 404, { error: 'not-found', message: 'this room has no password escrow' })
      }
      const r = await room(roomId)
      const me = r.hub.authorise(bearer(req), { human: true })
      if (m === 'PUT') {
        const body = await readJson(req, 8192)
        r.hub.authorise(bearer(req), { human: true })        // C04: still a member once the body is in
        const out = escrow.put(roomId, me.id, body)
        announce(roomId, 'escrow_changed', { escrow_version: out.escrow_version, revision: out.revision, updater_device_id: me.id })
        return sendJson(res, 200, out)
      }
      if (m === 'DELETE') {
        const rev = new URL(req.url, 'http://x').searchParams.get('revision')
        const out = escrow.delete(roomId, me.id, rev != null && /^\d{1,15}$/.test(rev) ? Number(rev) : undefined)
        announce(roomId, 'escrow_changed', { escrow_version: null, revision: out.revision, updater_device_id: me.id })
        return sendJson(res, 200, { ok: true, revision: out.revision })
      }
    }
    return false
  }

  return {
    flow, versions, metrics, wal, quota, escrow, testRooms: tests, unlimited,
    metricsPort: () => metricsServer?.address().port ?? null,
    async handle(req, res, url) {
      metrics.request(req, res, url.pathname)
      versions.check(req)
      flow.admit(req, res)
      if (url.pathname === '/v1/version' && req.method === 'GET') { sendJson(res, 200, versions.info()); return true }
      const m = ROOM_ROUTE.exec(url.pathname)
      if (!m) return false
      return (await roomRoute(req, res, m[1], m[2], m[3])) !== false
    },
    track(s, req) { flow.track(s, parseClient(req.headers['trommi-client'])) },
    send: (s, chunk) => flow.send(s, chunk),
    /** New minimum versions at run time: open streams of clients now too old get `upgrade_required` and are closed. */
    updateVersions(next) {
      versions.update(next)
      for (const s of flow.streams) {
        if (!versions.tooOld(s.client) || s.res.writableEnded) continue
        s.res.end(`event: upgrade_required\ndata: ${JSON.stringify(versions.upgradeBody(s.client))}\n\n`)
      }
    },
    async close() {
      for (const t of timers) clearInterval(t)
      metrics.close()
      if (metricsServer) await new Promise(ok => { metricsServer.close(ok); metricsServer.closeAllConnections() })
    },
  }
}
