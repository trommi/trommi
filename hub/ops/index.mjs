// hub/ops: running the hub (stream "Hub-Betrieb"). Client versions, test rooms, backpressure, metrics,
// the attachment quota, wired into hub/server.mjs through createOps():
//
//   ops.handle(req, res, url)   first thing for every request: metrics, version gate (426), write admission
//                               (503), and the routes below; true when it answered
//   ops.send(s, chunk)          every chunk for a live stream (bounded buffer)    ops.track(s, req)  a new stream
//   ops.unlimited(req, roomId)  rate limits lifted (a signed test request, or a test room)
//   ops.testRooms.wanted/mark   founding with test_room: true                      ops.quota.check/make  uploads
//
// Routes: GET /v1/version · DELETE /v1/rooms/:room_id (test rooms) · GET /v1/rooms/:room_id/usage. Metrics: METRICS_PORT (+ METRICS_HOST, default 127.0.0.1) only.
import http from 'node:http'
import { envNumber } from './env.mjs'
import { sendJson } from './http.mjs'
import { clientVersions, parseClient } from './versions.mjs'
import { flowControl } from './flow.mjs'
import { testRooms } from './test-rooms.mjs'
import { attachmentQuota } from './quota.mjs'
import { walKeeper } from './wal.mjs'
import { hubMetrics } from './metrics.mjs'

export { limitsFromEnv } from './env.mjs'

const ROOM_ROUTE = /^\/v1\/rooms\/([0-9a-f]{64})(?:\/(usage))?$/

export async function createOps({ db, dataDir, files, room, closeRoom, announce, bearer, ipOf, now = Date.now, log = () => {}, env = process.env }) {
  const versions = clientVersions({ env, log, now })
  const flow = flowControl({ maxWrites: envNumber(env, 'HUB_WRITE_QUEUE', 512), maxMembershipWrites: envNumber(env, 'HUB_WRITE_QUEUE_MEMBERSHIP', 32),
    maxWritesPerIp: envNumber(env, 'HUB_WRITE_PER_IP', 16), ipOf, streamBufferBytes: envNumber(env, 'HUB_STREAM_BUFFER_BYTES', 4 << 20) })
  const tests = testRooms({ db, dataDir, publicKey: env.HUB_TEST_PUBLIC_KEY, closeRoom, now, log })
  const quota = attachmentQuota({ db, files, quotaBytes: envNumber(env, 'ROOM_ATTACHMENT_QUOTA_BYTES', 1 << 30), announce, log })
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

  async function roomRoute(req, res, roomId, sub) {
    const m = req.method
    if (!sub && m === 'DELETE') { await tests.delete(req, roomId); return sendJson(res, 200, { ok: true }) }
    if (sub === 'usage' && m === 'GET') {
      ;(await room(roomId)).hub.authorise(bearer(req), { member: true })
      return sendJson(res, 200, { attachment_bytes: quota.used(roomId), quota_bytes: quota.quotaBytes })
    }
    return false
  }

  return {
    flow, versions, metrics, wal, quota, testRooms: tests, unlimited,
    metricsPort: () => metricsServer?.address().port ?? null,
    async handle(req, res, url) {
      metrics.request(req, res, url.pathname)
      versions.check(req)
      flow.admit(req, res)
      if (url.pathname === '/v1/version' && req.method === 'GET') { sendJson(res, 200, versions.info()); return true }
      const m = ROOM_ROUTE.exec(url.pathname)
      if (!m) return false
      return (await roomRoute(req, res, m[1], m[2])) !== false
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
