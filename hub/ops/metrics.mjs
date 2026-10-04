// metrics.mjs: what the hub is doing, as Prometheus text (metricsText) and as a ring buffer of the last hour
// in 10 s samples (metricsHistory) for the admin page. Served only on its own listener (METRICS_PORT), never
// on the public port. Host values (load, memory) come from /proc, which a container sees for the whole host.
import fs from 'node:fs'
import os from 'node:os'
import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks'

const BUCKETS_MS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 10000]
const ROUTES = new Set(['challenge', 'access_tokens', 'members', 'devices', 'sealed_room_keys', 'key_back_links', 'invites', 'envelopes', 'threads',
  'stream', 'agent_lease', 'agent_sessions', 'sessions', 'attachments', 'push_subscriptions', 'usage', 'escrow', 'ephemeral'])
const SAMPLE_MS = 10000, SAMPLES = 360

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

export function hubMetrics({ dataDir, flow, wal, now = Date.now }) {
  const latency = histogram()
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
      if (label !== 'GET stream') latency.observe(label, performance.now() - t)
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
    ring.push({
      at: t, envelopes_per_second: (envelopes - prev.envelopes) / dt, requests_per_second: (reqs - prev.requests) / dt,
      write_queue_depth: flow.writeQueueDepth, open_streams: s.out.count, outbound_bytes_max: s.out.max, outbound_bytes_total: s.out.total,
      rss_bytes: s.mu.rss, heap_used_bytes: s.mu.heapUsed, event_loop_lag_p99_ms: s.loop.p99, event_loop_lag_max_ms: s.loop.max, gc_max_ms: gc.maxMs,
      sqlite_bytes: s.dbBytes, wal_bytes: s.walBytes, load1: s.host.load[0], mem_available_bytes: s.host.memAvailable, disk_free_bytes: s.host.disk.free,
    })
    if (ring.length > SAMPLES) ring.shift()
    prev = { at: t, envelopes, requests: reqs }
    loop.reset(); gc.maxMs = 0
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
    sample,
    close() { clearInterval(timer); loop.disable(); gcObserver.disconnect() },
  }
}
