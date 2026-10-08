// metrics.mjs: what the hub is doing, as Prometheus text (metricsText) and as a ring buffer of the last hour
// in 10 s samples (metricsHistory) for the admin page. Served only on its own listener (METRICS_PORT), never
// on the public port. Host values (load, memory) come from /proc, which a container sees for the whole host.
// The admin graphs also need 24 h and 7 d: every minute the samples of that minute are folded into one row of
// <dataDir>/metrics.db (its own small SQLite file, not hub.db; rows older than 7 days are deleted), read back by
// series(), so the graphs survive a restart.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks'

const BUCKETS_MS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 10000]
const ROUTES = new Set(['challenge', 'access_tokens', 'members', 'devices', 'sealed_room_keys', 'key_back_links', 'invites', 'envelopes', 'threads',
  'stream', 'agent_lease', 'agent_sessions', 'sessions', 'attachments', 'push_subscriptions', 'usage'])
const SAMPLE_MS = 10000, SAMPLES = 360
const MINUTE = 60000, KEEP_MS = 7 * 24 * 3600000
export const METRICS_FILE = 'metrics.db'
/** Columns of one persisted minute (averages of that minute's samples; request_ms_p95 and open_streams the maximum). */
export const SERIES_COLUMNS = ['cpu_percent', 'mem_used_percent', 'disk_free_bytes', 'disk_total_bytes', 'open_streams', 'envelopes_per_minute',
  'requests_per_second', 'request_ms_p95', 'sqlite_bytes', 'wal_bytes', 'rss_bytes']
const MAX_COLUMNS = new Set(['request_ms_p95', 'open_streams'])

/** A bounded route label: "POST envelopes", "GET version", "POST rooms" … */
export function routeLabel(method, pathname) {
  const m = /^\/v1\/rooms(?:\/[^/]+(?:\/([^/]+))?)?/.exec(pathname)
  if (m) return `${method} ${m[1] ? (ROUTES.has(m[1]) ? m[1] : 'other') : 'rooms'}`
  const top = /^\/(v1\/version|v1\/push_key|healthz)$/.exec(pathname)
  return `${method} ${top ? top[1].replace('v1/', '') : 'other'}`
}

function histogram() {
  const counts = new Map()          // label -> { buckets: [], sum, count }
  return {
    observe(label, ms) {
      let h = counts.get(label)
      if (!h) counts.set(label, h = { buckets: BUCKETS_MS.map(() => 0), sum: 0, count: 0 })
      for (let i = 0; i < BUCKETS_MS.length; i++) if (ms <= BUCKETS_MS[i]) h.buckets[i]++
      h.sum += ms; h.count++
    },
    counts,
  }
}

const readProc = file => { try { return fs.readFileSync(file, 'utf8') } catch { return '' } }
/** Host CPU ticks from /proc/stat: { busy, total }, or null where there is no /proc. */
function cpuTicks() {
  const line = readProc('/proc/stat').split('\n')[0]
  if (!line.startsWith('cpu ')) return null
  const v = line.trim().split(/\s+/).slice(1).map(Number)
  const total = v.reduce((a, b) => a + b, 0), idle = (v[3] ?? 0) + (v[4] ?? 0)
  return { busy: total - idle, total }
}
/** p-quantile in ms from bucket counts (upper bound of the bucket that holds it). */
function quantile(buckets, count, p) {
  if (!count) return 0
  const want = Math.ceil(count * p)
  for (let i = 0; i < BUCKETS_MS.length; i++) if (buckets[i] >= want) return BUCKETS_MS[i]
  return BUCKETS_MS.at(-1)
}

/** The persisted minute series in <dataDir>/metrics.db. Writable from the hub, read-only for anyone else. */
export function openSeries(dataDir, { readOnly = false } = {}) {
  const file = path.join(dataDir, METRICS_FILE)
  if (readOnly && !fs.existsSync(file)) return null
  const db = new DatabaseSync(file, readOnly ? { readOnly: true } : {})
  if (!readOnly) db.exec(`CREATE TABLE IF NOT EXISTS metrics_minute (at INTEGER PRIMARY KEY, ${SERIES_COLUMNS.map(c => `${c} REAL`).join(', ')})`)
  return {
    db,
    write(row) { db.prepare(`INSERT OR REPLACE INTO metrics_minute (at, ${SERIES_COLUMNS.join(', ')}) VALUES (?${', ?'.repeat(SERIES_COLUMNS.length)})`).run(row.at, ...SERIES_COLUMNS.map(c => Number.isFinite(row[c]) ? row[c] : null)) },
    prune(before) { db.prepare('DELETE FROM metrics_minute WHERE at < ?').run(before) },
    /** Points since `since`, folded into at most `points` buckets (avg; max for p95 and streams). */
    read(since, points = 360, until = Date.now()) {
      const step = Math.max(MINUTE, Math.ceil((until - since) / points / MINUTE) * MINUTE)
      const cols = SERIES_COLUMNS.map(c => `${MAX_COLUMNS.has(c) ? 'MAX' : 'AVG'}(${c}) AS ${c}`).join(', ')
      return db.prepare(`SELECT (at / ${step}) * ${step} AS at, ${cols} FROM metrics_minute WHERE at >= ? GROUP BY at / ${step} ORDER BY at`).all(since)
        .map(r => ({ ...r, at: Number(r.at) }))
    },
    close() { try { db.close() } catch {} },
  }
}
export function hostStats(dataDir) {
  const load = readProc('/proc/loadavg').split(' ').slice(0, 3).map(Number)
  const mem = Object.fromEntries(readProc('/proc/meminfo').split('\n').map(l => /^(\w+):\s+(\d+)/.exec(l)).filter(Boolean).map(m => [m[1], Number(m[2]) * 1024]))
  let disk = { total: 0, free: 0 }
  try { const s = fs.statfsSync(dataDir); disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize } } catch {}
  let fds = 0
  try { fds = fs.readdirSync('/proc/self/fd').length } catch {}
  return {
    load: load.length === 3 && load.every(Number.isFinite) ? load : os.loadavg(),
    memTotal: mem.MemTotal ?? os.totalmem(), memAvailable: mem.MemAvailable ?? os.freemem(), disk, fds, cpus: os.availableParallelism(),
  }
}

export function hubMetrics({ dataDir, flow, wal, now = Date.now, persist = true, log = () => {} }) {
  const latency = histogram()
  let window = { buckets: BUCKETS_MS.map(() => 0), sum: 0, count: 0 }   // all routes since the last sample
  let cpuPrev = cpuTicks()
  let series = null
  if (persist && dataDir) { try { series = openSeries(dataDir) } catch (err) { log(`metrics: no ${METRICS_FILE}: ${err.message}`) } }
  let minute = []                                                         // samples not yet folded into a minute row
  const requests = new Map()        // "label|status" -> count
  let envelopes = 0
  const loop = monitorEventLoopDelay({ resolution: 10 })
  loop.enable()
  const gc = { count: 0, totalMs: 0, maxMs: 0 }
  const gcObserver = new PerformanceObserver(list => { for (const e of list.getEntries()) { gc.count++; gc.totalMs += e.duration; gc.maxMs = Math.max(gc.maxMs, e.duration) } })
  gcObserver.observe({ entryTypes: ['gc'] })
  const ring = []
  let prev = { at: now(), envelopes: 0, requests: 0 }
  const totalRequests = () => { let n = 0; for (const v of requests.values()) n += v; return n }

  /** Call when a request starts; it records itself when the response is done. */
  function request(req, res, pathname) {
    const t = performance.now()
    const label = routeLabel(req.method, pathname)
    res.once('finish', () => {
      const key = `${label}|${res.statusCode}`
      requests.set(key, (requests.get(key) ?? 0) + 1)
      if (label === 'POST envelopes' && res.statusCode === 200) envelopes++
      if (label !== 'GET stream') {
        const ms = performance.now() - t
        latency.observe(label, ms)
        for (let i = 0; i < BUCKETS_MS.length; i++) if (ms <= BUCKETS_MS[i]) window.buckets[i]++
        window.sum += ms; window.count++
      }
    })
  }

  function snapshot() {
    const mu = process.memoryUsage()
    return {
      mu, host: hostStats(dataDir), out: flow.outbound(), dbBytes: wal.dbBytes(), walBytes: wal.walBytes(),
      loop: { p50: loop.percentile(50) / 1e6, p99: loop.percentile(99) / 1e6, max: loop.max / 1e6 },
    }
  }

  function sample() {
    const s = snapshot()
    const t = now(), dt = Math.max(1, t - prev.at) / 1000, reqs = totalRequests()
    const ticks = cpuTicks()
    const cpu = ticks && cpuPrev && ticks.total > cpuPrev.total ? (100 * (ticks.busy - cpuPrev.busy)) / (ticks.total - cpuPrev.total) : (100 * s.host.load[0]) / s.host.cpus
    cpuPrev = ticks
    const entry = {
      at: t, envelopes_per_second: (envelopes - prev.envelopes) / dt, requests_per_second: (reqs - prev.requests) / dt,
      write_queue_depth: flow.writeQueueDepth, open_streams: s.out.count, outbound_bytes_max: s.out.max, outbound_bytes_total: s.out.total,
      rss_bytes: s.mu.rss, heap_used_bytes: s.mu.heapUsed, event_loop_lag_p99_ms: s.loop.p99, event_loop_lag_max_ms: s.loop.max, gc_max_ms: gc.maxMs,
      sqlite_bytes: s.dbBytes, wal_bytes: s.walBytes, load1: s.host.load[0], mem_available_bytes: s.host.memAvailable, disk_free_bytes: s.host.disk.free,
      cpu_percent: Math.max(0, Math.min(100, cpu)), cpus: s.host.cpus, mem_total_bytes: s.host.memTotal, disk_total_bytes: s.host.disk.total,
      request_ms_avg: window.count ? window.sum / window.count : 0, request_ms_p95: quantile(window.buckets, window.count, 0.95),
    }
    ring.push(entry)
    if (ring.length > SAMPLES) ring.shift()
    prev = { at: t, envelopes, requests: reqs }
    window = { buckets: BUCKETS_MS.map(() => 0), sum: 0, count: 0 }
    loop.reset(); gc.maxMs = 0
    if (minute.length && Math.floor(minute[0].at / MINUTE) !== Math.floor(t / MINUTE)) flushMinute()
    minute.push(entry)
  }

  /** Fold the collected samples into one row of metrics.db (the minute they started in). */
  function flushMinute() {
    const list = minute
    minute = []
    if (!series || !list.length) return
    const avg = f => list.reduce((a, x) => a + f(x), 0) / list.length
    const max = f => Math.max(...list.map(f))
    const at = Math.floor(list[0].at / MINUTE) * MINUTE
    try {
      series.write({
        at, cpu_percent: avg(x => x.cpu_percent), mem_used_percent: avg(x => (x.mem_total_bytes ? (100 * (x.mem_total_bytes - x.mem_available_bytes)) / x.mem_total_bytes : 0)),
        disk_free_bytes: avg(x => x.disk_free_bytes), disk_total_bytes: avg(x => x.disk_total_bytes), open_streams: max(x => x.open_streams),
        envelopes_per_minute: avg(x => x.envelopes_per_second) * 60, requests_per_second: avg(x => x.requests_per_second), request_ms_p95: max(x => x.request_ms_p95),
        sqlite_bytes: avg(x => x.sqlite_bytes), wal_bytes: avg(x => x.wal_bytes), rss_bytes: avg(x => x.rss_bytes),
      })
      if (at % 3600000 === 0) series.prune(at - KEEP_MS)
    } catch (err) { log(`metrics: ${err.message}`) }
  }
  const timer = setInterval(sample, SAMPLE_MS)
  timer.unref()

  function text() {
    const s = snapshot()
    const lines = []
    const metric = (name, type, help, rows) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`)
      for (const [labels, v] of rows) lines.push(`${name}${labels} ${Number.isFinite(v) ? v : 0}`)
    }
    const one = (name, type, help, v) => metric(name, type, help, [['', v]])
    const lbl = obj => `{${Object.entries(obj).map(([k, v]) => `${k}="${v}"`).join(',')}}`
    metric('trommi_requests_total', 'counter', 'HTTP requests by route and status.',
      [...requests].map(([k, v]) => { const [route, status] = k.split('|'); return [lbl({ route, status }), v] }))
    lines.push('# HELP trommi_request_duration_ms Request latency (streams excluded).', '# TYPE trommi_request_duration_ms histogram')
    for (const [route, h] of latency.counts) {
      BUCKETS_MS.forEach((le, i) => lines.push(`trommi_request_duration_ms_bucket${lbl({ route, le })} ${h.buckets[i]}`))
      lines.push(`trommi_request_duration_ms_bucket${lbl({ route, le: '+Inf' })} ${h.count}`, `trommi_request_duration_ms_sum${lbl({ route })} ${h.sum}`, `trommi_request_duration_ms_count${lbl({ route })} ${h.count}`)
    }
    one('trommi_envelopes_ingested_total', 'counter', 'Envelopes accepted.', envelopes)
    one('trommi_write_queue_depth', 'gauge', 'Write requests in flight.', flow.writeQueueDepth)
    one('trommi_writes_refused_total', 'counter', 'Writes refused with 503 because the queue was full.', flow.counters.refusedWrites)
    one('trommi_open_streams', 'gauge', 'Open live streams.', s.out.count)
    one('trommi_streams_dropped_total', 'counter', 'Streams dropped because their send buffer was full.', flow.counters.droppedStreams)
    one('trommi_stream_outbound_bytes', 'gauge', 'Bytes waiting to be sent, all streams.', s.out.total)
    one('trommi_stream_outbound_bytes_max', 'gauge', 'Bytes waiting to be sent, the fullest stream.', s.out.max)
    one('trommi_sqlite_bytes', 'gauge', 'Size of hub.db.', s.dbBytes)
    one('trommi_sqlite_wal_bytes', 'gauge', 'Size of hub.db-wal.', s.walBytes)
    one('trommi_sqlite_checkpoint_lag_frames', 'gauge', 'WAL frames not yet checkpointed at the last checkpoint.', wal.last.log_frames - wal.last.checkpointed_frames)
    one('trommi_sqlite_checkpoint_ms', 'gauge', 'Duration of the last checkpoint.', wal.last.last_ms)
    one('process_resident_memory_bytes', 'gauge', 'Resident memory.', s.mu.rss)
    metric('nodejs_heap_bytes', 'gauge', 'V8 heap.', [[lbl({ kind: 'used' }), s.mu.heapUsed], [lbl({ kind: 'total' }), s.mu.heapTotal], [lbl({ kind: 'external' }), s.mu.external]])
    metric('nodejs_eventloop_lag_ms', 'gauge', 'Event loop delay since the last sample.', [[lbl({ quantile: '0.5' }), s.loop.p50], [lbl({ quantile: '0.99' }), s.loop.p99], [lbl({ quantile: '1' }), s.loop.max]])
    one('nodejs_gc_pauses_total', 'counter', 'Garbage collections.', gc.count)
    one('nodejs_gc_pause_ms_total', 'counter', 'Time spent in garbage collection.', gc.totalMs)
    one('process_open_fds', 'gauge', 'Open file descriptors.', s.host.fds)
    metric('host_load', 'gauge', 'Host load average (/proc/loadavg).', s.host.load.map((v, i) => [lbl({ minutes: [1, 5, 15][i] }), v]))
    one('host_cpus', 'gauge', 'CPUs available.', s.host.cpus)
    metric('host_memory_bytes', 'gauge', 'Host memory (/proc/meminfo).', [[lbl({ kind: 'total' }), s.host.memTotal], [lbl({ kind: 'available' }), s.host.memAvailable]])
    metric('host_data_disk_bytes', 'gauge', 'The data volume (statfs).', [[lbl({ kind: 'total' }), s.host.disk.total], [lbl({ kind: 'free' }), s.host.disk.free]])
    return `${lines.join('\n')}\n`
  }

  return {
    request,
    text,
    history: () => ring.slice(),
    /** The persisted minutes since `since` (ms), at most `points` of them, oldest first; [] without metrics.db. */
    series: (since, points) => { try { return series ? series.read(since, points, now()) : [] } catch { return [] } },
    sample,
    flushMinute,
    close() { clearInterval(timer); loop.disable(); gcObserver.disconnect(); flushMinute(); series?.close(); series = null },
  }
}
