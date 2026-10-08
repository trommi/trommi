// hub-local.mjs: the real hub (hub/server.mjs) on a free local port 8891-8899 for load runs, plus a metrics
// sampler. Limits that only exist to protect the public hub (founding per IP, streams per device, envelope rate)
// are lifted here; everything else is the production code path.
//
//   node dev/load/hub-local.mjs --data=<dir> --metrics=<file.jsonl> [--port=8891] [--every=5000] [--keep-limits] [--count]
//
// --count: the hub listens on an inner port and a counting proxy takes --port (the address members know): every byte
// in and out, by client (the trommi-client header: web, ios, a test name) and route. GET /__counters reads them,
// POST /__counters/reset zeroes them (dev/load/tempo.mjs, app-perf.mjs).
//
// Prints one JSON line {"ready":true,"port":..,"hub_url":..} on stdout once listening. Metrics, one JSON line every
// --every ms: time, process CPU % (of one core), RSS, heap, external, event-loop delay p50/p99/max, open sockets,
// bytes queued in socket buffers (slow consumers), hub.db + WAL size, envelope count.
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { startHub, LIMITS } from '../../hub/server.mjs'
import { guard } from '../guard.mjs'
guard({ usage: 'node dev/load/hub-local.mjs --data=DIR --metrics=FILE [--port=8891] [--every=5000] [--keep-limits] [--count]', values: ['data', 'every', 'metrics', 'port'], flags: ['keep-limits', 'count'] })

const arg = (name, def) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : def }
const dataDir = path.resolve(arg('data', `/tmp/trommi-e2e-hub-${process.pid}`))
const metricsFile = arg('metrics', path.join(dataDir, 'metrics.jsonl'))
const every = Number(arg('every', 5000))

async function freePort() {
  for (let p = 8899; p >= 8891; p--) {   // from the top: tests of other streams take the first free port from 8891
    const ok = await new Promise(res => { const s = net.createServer().once('error', () => res(false)).listen(p, '127.0.0.1', () => s.close(() => res(true))) })
    if (ok) return p
  }
  throw new Error('no free port in 8891-8899')
}

if (!process.argv.includes('--keep-limits')) {
  LIMITS.foundPerIpHour = 1e9
  LIMITS.streamsPerDevice = 1e6
  LIMITS.envelopesPerSecond = 1e6
  LIMITS.envelopeBurst = 1e6
  LIMITS.openRequestsPerIpMinute = 1e9
}
fs.mkdirSync(dataDir, { recursive: true })
const port = Number(arg('port', 0)) || await freePort()
const counting = process.argv.includes('--count')
const hub = await startHub({ port: counting ? 0 : port, host: '127.0.0.1', dataDir, ...(counting ? { hubUrl: `http://127.0.0.1:${port}` } : {}), log: m => process.stderr.write(`[hub] ${m}\n`) })
if (counting) countingFront(port, hub.port)

/** The counting proxy in front of the hub (--count). */
function countingFront(publicPort, innerPort) {
  let counters = {}
  const route = u => u.replace(/\/v1\/rooms\/[0-9a-f]+/, '').replace(/[0-9a-f]{32,}/g, ':id').replace(/\?.*/, '')
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/__counters')) {
      if (req.method === 'POST') counters = {}
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
      return res.end(JSON.stringify(counters))
    }
    const who = String(req.headers['trommi-client'] ?? 'none')
    const c = counters[who] ??= { requests: 0, bytes_in: 0, bytes_out: 0, routes: {} }
    const r = c.routes[`${req.method} ${route(req.url)}`] ??= { requests: 0, bytes_in: 0 }
    c.requests++; r.requests++
    const up = http.request({ host: '127.0.0.1', port: innerPort, method: req.method, path: req.url, headers: req.headers }, ur => {
      res.writeHead(ur.statusCode, ur.headers)
      ur.on('data', d => { c.bytes_in += d.length; r.bytes_in += d.length; res.write(d) })
      ur.on('end', () => res.end())
    })
    up.on('error', () => { try { res.writeHead(502); res.end() } catch {} })
    req.on('data', d => { c.bytes_out += d.length })
    req.pipe(up)
    res.on('close', () => { if (!res.writableFinished) up.destroy() })
  })
  server.listen(publicPort, '127.0.0.1')
}

const sockets = new Set()
hub.server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable()
const out = fs.createWriteStream(metricsFile, { flags: 'a' })
let lastCpu = process.cpuUsage(), lastAt = performance.now()
const size = f => { try { return fs.statSync(f).size } catch { return 0 } }
const countQ = hub.db.q("SELECT COALESCE(SUM(last_envelope_number), 0) AS n FROM rooms")
function sample() {
  const cpu = process.cpuUsage(lastCpu), t = performance.now()
  const m = process.memoryUsage()
  let queued = 0
  for (const s of sockets) queued += s.writableLength
  const rec = {
    at: Date.now(), cpu_percent: +((cpu.user + cpu.system) / 1000 / (t - lastAt) * 100).toFixed(1),
    rss_mb: +(m.rss / 1048576).toFixed(1), heap_used_mb: +(m.heapUsed / 1048576).toFixed(1), heap_total_mb: +(m.heapTotal / 1048576).toFixed(1),
    external_mb: +(m.external / 1048576).toFixed(1), array_buffers_mb: +(m.arrayBuffers / 1048576).toFixed(1),
    loop_p50_ms: +(loop.percentile(50) / 1e6).toFixed(2), loop_p99_ms: +(loop.percentile(99) / 1e6).toFixed(2), loop_max_ms: +(loop.max / 1e6).toFixed(1),
    sockets: sockets.size, socket_queued_mb: +(queued / 1048576).toFixed(2),
    db_mb: +((size(path.join(dataDir, 'hub.db')) + size(path.join(dataDir, 'hub.db-wal'))) / 1048576).toFixed(1),
    envelopes: countQ ? Number(countQ.get().n) : null,
  }
  lastCpu = process.cpuUsage(); lastAt = t; loop.reset()
  out.write(JSON.stringify(rec) + '\n')
}
setInterval(sample, every)
process.stdout.write(JSON.stringify({ ready: true, port: counting ? port : hub.port, hub_url: hub.hubUrl, counting, data: dataDir, metrics: metricsFile, pid: process.pid }) + '\n')
const stop = () => { sample(); hub.close().finally(() => process.exit(0)) }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
