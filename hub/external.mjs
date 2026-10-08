// external.mjs: startHub() for a hub that is not this Node process: the Rust hub (hub-rs) or any build that speaks
// the README protocol. The test suites import it instead of server.mjs when HUB_CMD names the binary
//   HUB_CMD=hub-rs/target/release/trommi-hub node hub/test.mjs
// and get an object of the same shape as server.mjs's startHub(): port, hubUrl, db (the same hub.db, opened here
// with node:sqlite), prune(), sweepPending(), capStreams(), rebuildDerived(), stats, ops.flow, ops.testRooms,
// ops.updateVersions, ops.metrics, ops.wal, accounts.sweep, admin, close(). What a test reaches inside an in-process
// hub goes over the hub's test-control routes (/__test/…, only with HUB_TEST_CONTROL=1, which this file sets); the
// synchronous ones (stats.roomLoads, prune() …) through a worker that the caller waits on (Atomics.wait).
// startHub options become the hub's environment (README of hub-rs, "Configuration"); `now` becomes the header
// x-test-now on every request this process sends to that hub, so a test's clock is the hub's clock.
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { Worker, MessageChannel, receiveMessageOnPort } from 'node:worker_threads'
import fs from 'node:fs'
import path from 'node:path'

export { LIMITS } from './server.mjs'

// ---- synchronous HTTP (a worker does the fetch, this thread waits) ----------------------------------

let syncFetch = null
function requester() {
  const { port1, port2 } = new MessageChannel()
  const shared = new Int32Array(new SharedArrayBuffer(4))
  const worker = new Worker(`
    const { workerData } = require('node:worker_threads')
    const { port, shared } = workerData
    port.on('message', async ({ url, method, body, headers }) => {
      let out
      try { const r = await fetch(url, { method, headers, body }); out = { status: r.status, text: await r.text() } } catch (e) { out = { error: String(e?.message ?? e) } }
      port.postMessage(out); Atomics.store(shared, 0, 1); Atomics.notify(shared, 0)
    })`, { eval: true, workerData: { port: port2, shared }, transferList: [port2] })
  worker.unref()
  port1.unref?.()
  return (url, method = 'GET', body) => {
    Atomics.store(shared, 0, 0)
    port1.postMessage({ url, method, body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? {} : { 'content-type': 'application/json' } })
    if (Atomics.wait(shared, 0, 0, 30000) === 'timed-out') throw new Error(`external hub: ${method} ${url} timed out`)
    const m = receiveMessageOnPort(port1)?.message
    if (!m || m.error) throw new Error(`external hub: ${method} ${url}: ${m?.error ?? 'no answer'}`)
    if (m.status >= 300) throw new Error(`external hub: ${method} ${url}: ${m.status} ${m.text}`)
    return m.text ? JSON.parse(m.text) : null
  }
}

// ---- the test clock: x-test-now on every request to a hub that was given `now` -----------------------

const clocks = new Map()      // base URL -> now()
let fetchPatched = false
function patchFetch() {
  if (fetchPatched) return
  fetchPatched = true
  const original = globalThis.fetch
  globalThis.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input)
    for (const [base, now] of clocks) {
      if (url.startsWith(base)) {
        const headers = new Headers(init.headers ?? (typeof input === 'object' && input?.headers) ?? {})
        headers.set('x-test-now', String(Math.round(now())))
        return original(input, { ...init, headers })
      }
    }
    return original(input, init)
  }
}

/** The hub.db helpers of hub/store.mjs, on the test's own connection to the same file. */
function openTestDb(file) {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA busy_timeout = 5000')
  const cache = new Map()
  db.q = sql => { let s = cache.get(sql); if (!s) cache.set(sql, s = db.prepare(sql)); return s }
  let depth = 0
  db.tx = fn => {
    if (depth) return fn()
    depth++
    db.exec('BEGIN IMMEDIATE')
    try { const out = fn(); db.exec('COMMIT'); return out } catch (err) { db.exec('ROLLBACK'); throw err } finally { depth-- }
  }
  return db
}

/** startHub options -> the hub's environment. */
function envOf(o) {
  const env = { ...process.env, HUB_TEST_CONTROL: '1', HUB_QUIET: '0' }
  const set = (k, v) => { if (v === undefined) return; if (v === null || v === false) delete env[k]; else env[k] = String(v) }
  set('HUB_PORT', o.port ?? process.env.HUB_PORT ?? 0)
  set('HUB_HOST', o.host ?? process.env.HUB_HOST ?? '127.0.0.1')
  set('HUB_DATA', o.dataDir)
  set('HUB_URL', o.hubUrl)
  set('COMMIT', o.commit)
  if (o.origins) { env.HUB_ORIGINS = o.origins.join(','); env.HUB_PREVIEW_ORIGINS = '' }
  set('HUB_FOUND_TOKEN', o.foundToken)
  set('HUB_MAX_ROOMS', o.maxRooms)
  if (o.trustCloudflare !== undefined) env.HUB_TRUST_CF = o.trustCloudflare ? '1' : '0'
  set('HUB_APP_URL', o.appUrl)
  if (o.pushHosts) env.HUB_PUSH_HOSTS = o.pushHosts.join(',')
  if (o.apns !== undefined) {
    for (const k of ['APNS_KEY', 'APNS_KEY_FILE', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_TOPIC']) delete env[k]
    if (o.apns) Object.assign(env, { APNS_KEY: o.apns.key, APNS_KEY_ID: o.apns.keyId, APNS_TEAM_ID: o.apns.teamId, APNS_TOPIC: o.apns.topics.join(',') })
  }
  if (o.apnsHosts) env.HUB_APNS_HOSTS = JSON.stringify(o.apnsHosts)
  set('HUB_PING_MS', o.pingMs)
  set('HUB_RETENTION_EVERY_MS', o.retentionEveryMs)
  set('HUB_STREAM_CAP_EVERY_MS', o.streamCapEveryMs)
  set('HUB_BODY_TIMEOUT_MS', o.bodyTimeoutMs)
  set('HUB_LOSS_MS', o.lossMs)
  if (o.adminPort !== undefined) env.ADMIN_PORT = String(o.adminPort)
  return env
}

export async function startHub(o = {}) {
  const cmd = process.env.HUB_CMD
  if (!cmd) throw new Error('external.mjs needs HUB_CMD (the hub binary)')
  syncFetch ??= requester()
  const dataDir = o.dataDir ?? process.env.HUB_DATA ?? '/data'
  fs.mkdirSync(dataDir, { recursive: true })
  const log = o.log ?? (msg => console.log(`[hub] ${msg}`))
  const t0 = performance.now()
  const [bin, ...args] = cmd.split(' ')
  const child = spawn(bin, args, { env: envOf({ ...o, dataDir }), stdio: ['ignore', 'pipe', 'pipe'] })
  let exited = null
  const exit = new Promise(ok => child.once('exit', (code, sig) => { exited = { code, sig }; ok(exited) }))
  let adminPort = null, metricsPortSeen = null
  const ready = new Promise((ok, bad) => {
    let buf = ''
    const line = l => {
      const m = /^\[hub\] (.*)$/.exec(l)
      const msg = m ? m[1] : l
      const a = /^admin on .*:(\d+)$/.exec(msg)
      if (a) adminPort = Number(a[1])
      const mp = /^metrics on .*:(\d+)$/.exec(msg)
      if (mp) metricsPortSeen = Number(mp[1])
      const r = /^listening on .*:(\d+) as (\S+),/.exec(msg)
      if (r) ok({ port: Number(r[1]), hubUrl: r[2] })
      if (msg) log(msg)
    }
    child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1) } })
    child.stderr.on('data', d => { for (const l of String(d).split('\n')) if (l) log(l.replace(/^\[hub\] /, '')) })
    exit.then(e => bad(new Error(`hub exited before it listened (${e.code ?? e.sig})`)))
    child.once('error', bad)
  })
  const { port, hubUrl } = await ready
  const base = `http://127.0.0.1:${port}`
  if (o.now) { clocks.set(base, o.now); clocks.set(hubUrl, o.now); patchFetch() }
  const control = (p, body) => {
    if (o.now) syncFetch(`${base}/__test/now`, 'POST', { now: o.now() })
    return syncFetch(`${base}/__test/${p}`, body === undefined ? 'GET' : 'POST', body)
  }
  const db = openTestDb(path.join(dataDir, 'hub.db'))
  const hub = {
    port, hubUrl, db, startupMs: performance.now() - t0, process: child,
    get stats() { const s = control('stats'); return { roomLoads: s.room_loads, catchUpSlices: s.catch_up_slices } },
    prune: ({ days } = {}) => control('prune', days === undefined ? {} : { days }),
    sweepPending: ({ olderThanMs } = {}) => control('sweep_pending', olderThanMs === undefined ? {} : { older_than_ms: olderThanMs }),
    capStreams: () => control('cap_streams', {}),
    rebuildDerived: () => { control('rebuild_derived', {}) },
    ops: {
      flow: {
        get writeQueueDepth() { return control('flow').write_queue_depth },
        get membershipQueueDepth() { return control('flow').membership_queue_depth },
        get streams() { return control('flow').streams.map(s => ({ ...s, res: { writableLength: s.writable_length } })) },
        get counters() { return control('flow').counters },
      },
      testRooms: {
        get enabled() { return control('test_rooms').enabled },
        isTestRoom: id => control('test_rooms/is', { room_id: id }),
        expire: async () => { control('test_rooms/expire', {}) },
      },
      updateVersions: next => { control('versions', next) },
      metrics: { sample: () => { control('metrics/sample', {}) }, history: () => control('metrics/history'), flushMinute: () => { control('metrics/flush', {}) } },
      wal: { checkpoint: () => control('wal/checkpoint', {}) },
      metricsPort: () => metricsPortSeen,
      unlimited: () => false,
    },
    accounts: {
      sweep: () => control('accounts/sweep', {}),
      get expire() { return control('accounts').expire },
    },
    get admin() { return adminPort ? { port: adminPort, close: async () => {} } : null },
    async close() {
      clocks.delete(base); clocks.delete(hubUrl)
      if (!exited) { child.kill('SIGTERM'); await Promise.race([exit, new Promise(ok => setTimeout(ok, 8000).unref())]) }
      if (!exited) { child.kill('SIGKILL'); await exit }
      try { db.close() } catch {}
    },
  }
  return hub
}
