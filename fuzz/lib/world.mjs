// world.mjs: one simulated deployment: a hub (local, own port + throwaway dir, or a remote URL), rooms, and
// devices that are real client/core Clients (human devices and agents) with fault-injecting transports.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { threadId } from 'node:worker_threads'
import { makeRng } from './rng.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))
export { sleep }

export class Finding extends Error {
  constructor(kind, message, extra = {}) { super(message); this.kind = kind; Object.assign(this, extra) }
}

export class Dev {
  constructor(world, room, name, role, account) {
    Object.assign(this, { world, room, name, role, account, client: null, storage: null, gen: 0, dead: false, removed: false, removedBatch: null,
      joinedBatch: 0, incarnation: 0, commands: [], alerts: [], errors: [], controllers: new Set(), faults: { delay: 0, lose_response: 0, offline: 0 }, mitm: null, id: null, lastHistory: null })
  }
  get isHuman() { return this.role === 'human' }
}

/** A storage proxy that stops working once a newer incarnation of the device exists: a crashed process writes nothing more. */
export function fencedStorage(base, gen) {
  const guard = () => { if (base._gen !== gen) throw new Error('fenced: this process is dead') }
  return new Proxy(base, {
    get(t, prop) {
      const v = t[prop]
      if (typeof v !== 'function') return v
      return (...a) => { if (['get', 'set', 'delete', 'setMany', 'keys', 'range', 'saveDevice', 'flush'].includes(prop)) guard(); return v.apply(t, a) }
    },
  })
}

// ports below the ephemeral range, a private block per worker thread: no two worlds ever probe the same number
let portCounter = 0
const nextPort = () => 20000 + (((process.pid * 31) + threadId * 7) % 220) * 50 + (portCounter++ % 50)
export class World {
  constructor({ seed, target, remote = null, dir = null, log = () => {}, limits = 'fast' }) {
    this.seed = seed; this.t = target; this.remote = remote; this.log = log
    this.dir = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'trommi-fuzz-'))
    this.rooms = []                    // { idx, room_id, recovery_code, devs: Map<name, Dev>, humans: Set<account> }
    this.devs = new Map()              // name -> Dev
    this.hub = null
    this.hubLog = []                   // hub log lines that look like errors
    this.http = { total: 0, byStatus: {}, status500: [], slowest: 0 }
    this.stats = { actions: 0, envelopes: 0, skipped: 0, refused: 0, hubRestarts: 0, crashes: 0 }
    this.batch = 0                     // logical clock for "after the cut" checks
    this.hubPort = 0
    this.limits = limits
    this.plaintextMarkers = new Set()
    this.pidless = true
    this.known = new Map()             // known-and-reported behaviours the run keeps going through
  }

  // ---- hub --------------------------------------------------------------------------------
  async startHub() {
    if (this.remote) { this.hubUrl = this.remote.replace(/\/+$/, ''); return }
    if (this.limits === 'fast') Object.assign(this.t.LIMITS, { foundPerIpHour: 1e9, envelopesPerSecond: 1e6, envelopeBurst: 1e6, openRequestsPerIpMinute: 1e9, streamsPerDevice: 64 })
    const fresh = !this.hubPort
    if (fresh) this.hubPort = nextPort()
    for (let tries = 0; ; tries++) { try { this.hub = await this.t.startHub({ port: this.hubPort, host: '127.0.0.1', dataDir: path.join(this.dir, 'hub'), log: m => { if (/fail|error|internal|exception/i.test(m)) this.hubLog.push(m) }, pingMs: 4000, retentionEveryMs: 2 ** 31 - 1 }); break } catch (e) { if (e.code === 'EADDRINUSE' && fresh && tries < 30) { this.hubPort = nextPort(); continue } throw e } }
    this.hubPort = this.hub.port
    this.hubUrl = this.hub.hubUrl
  }
  async stopHub({ holdPort = false } = {}) {
    if (this.hub) {
      const h = this.hub; this.hub = null; await h.close()
      // keep the port reserved while the hub is down so no other worker's hub (port 0) can be handed the same number
      if (holdPort) this.placeholder = await new Promise((ok, bad) => { const s = net.createServer(); s.once('error', bad); s.listen(this.hubPort, '127.0.0.1', () => ok(s)) }).catch(() => null)
    }
  }
  async restartHub() {
    if (this.remote) return false
    const prev = this._restarting ?? Promise.resolve()
    const run = prev.then(() => this._restartHub())
    this._restarting = run.catch(() => {})
    return run
  }
  async _restartHub() {
    await this.stopHub()
    if (this.rng_sleep) await sleep(this.rng_sleep)
    for (let i = 0; ; i++) { try { await this.startHub(); break } catch (e) { if (e.code !== 'EADDRINUSE' || i > 100) throw e; await sleep(100) } }
    this.stats.hubRestarts++
    return true
  }

  // ---- transport with faults -----------------------------------------------------------------------
  makeFetch(dev) {
    const world = this
    return async (url, init = {}) => {
      if (dev.dead) throw new Error('process killed')
      const f = dev.faults
      dev.rng ??= makeRng(`${world.seed}/net/${dev.name}`)
      const rnd = () => dev.rng.next()
      const isStream = String(url).includes('/stream')
      const ac = new AbortController()
      dev.controllers.add(ac)
      ac.signal.addEventListener('abort', () => dev.controllers.delete(ac), { once: true })
      if (init.signal) { if (init.signal.aborted) ac.abort(init.signal.reason); else init.signal.addEventListener('abort', () => ac.abort(init.signal.reason), { once: true }) }
      try {
        if (f.delay && !isStream) await sleep(rnd() * f.delay)
        if (!isStream && f.offline && rnd() < f.offline) throw new Error('simulated: network down')
        if (dev.dead) throw new Error('process killed')
        const t0 = performance.now()
        let res = await fetch(url, { ...init, signal: ac.signal })
        const ms = performance.now() - t0
        world.http.total++
        dev.calls = (dev.calls ?? 0) + 1
        const key = `${dev.name} ${init.method ?? 'GET'} ${String(url).replace(/^https?:\/\/[^/]+/, '').replace(/[0-9a-f]{32,}/g, '<id>').replace(/\?.*/, '')}`
        world.http.hot ??= new Map(); world.http.hot.set(key, (world.http.hot.get(key) ?? 0) + 1)
        world.http.byStatus[res.status] = (world.http.byStatus[res.status] ?? 0) + 1
        if (!isStream) world.http.slowest = Math.max(world.http.slowest, ms)
        if (res.status >= 500) world.http.status500.push({ url: String(url).replace(/[0-9a-f]{32,}/g, '<id>'), status: res.status, method: init.method ?? 'GET' })
        if (!isStream && f.lose_response && rnd() < f.lose_response) { try { await res.arrayBuffer() } catch {} throw new Error('simulated: response lost') }
        if (dev.mitm) res = await dev.mitm(String(url), init, res) ?? res
        return res
      } finally { if (!isStream) dev.controllers.delete(ac) }
    }
  }

  killDev(dev) {
    dev.dead = true
    for (const ac of dev.controllers) { try { ac.abort(new Error('process killed')) } catch {} }
    dev.controllers.clear()
    dev.storage_base._gen = -1                 // fence: no write of the dead process reaches storage
    const c = dev.client
    if (c) {
      try { c._lockRelease?.(); c._lockRelease = null; c._started = false; c._stream?.close(); c._stream = null; clearTimeout(c._dirty.timer); for (const inv of c.invitesPrivate.values()) clearInterval(inv._timer) } catch {}
    }
  }

  // ---- devices -----------------------------------------------------------------------------------------
  newStorage(role) {
    const s = this.t.memoryStorage({ extractable_keys: role === 'agent' })
    s._gen = 0
    return s
  }
  attach(dev, client) {
    dev.client = client
    dev.id = client.my_device_id
    client.on('command', c => dev.commands.push({ ...c, card: undefined, permission: undefined, incarnation: dev.incarnation, hash: c.hash }))
    client.on('alert', a => dev.alerts.push(a))
    client.on('error', e => dev.errors.push(String(e?.message ?? e)))
  }
  /** Boot (or reboot) a device from its storage: openRoom, start. */
  async boot(dev, { claim = true } = {}) {
    dev.dead = false
    dev.faults = { delay: 0, lose_response: 0, offline: 0 }   // a process starts on a working network; faults are switched on by later actions
    dev.gen++
    dev.incarnation++
    dev.lastBootBatch = this.batch
    dev.storage_base._gen = dev.gen
    dev.storage = fencedStorage(dev.storage_base, dev.gen)
    if (this.attack && !dev.mitm) this.adversary.install(dev, this.attack)
    const client = await this.t.core.openRoom({ storage: dev.storage, fetch: this.makeFetch(dev) })
    if (!client) throw new Finding('boot', `${dev.name}: openRoom found no room in storage`)
    this.attach(dev, client)
    await client.start()
    if (client.session_id) dev.sessionId = client.session_id
    if (dev.role === 'agent') this.runner?.oracle(dev.room.idx).reassertOnBoot(dev.name)
    if (dev.role === 'agent' && claim) { try { await client.claimSession({ process_instance: `pi-${dev.name}-${dev.incarnation}-${Math.random().toString(36).slice(2)}` }) } catch (e) { dev.errors.push(`claim: ${e.code ?? e.message}`) } }
    return client
  }
  async crash(dev) {
    this.killDev(dev)
    this.stats.crashes++
    dev.client = null
  }

  /** Wait until every live device has caught up with the hub and has nothing left to send. */
  async quiesce({ timeout_ms = 20000, devs = null } = {}) {
    const end = Date.now() + timeout_ms
    const live = (devs ?? [...this.devs.values()]).filter(d => d.client && !d.dead && !d.removed)
    for (;;) {
      let pending = null
      // an agent whose lease was lost has stopped itself (the channel process would exit): start it again, as the channel's supervisor would
      for (const d of live) if (d.role === 'agent' && d.client?._leaseLost) {
        this.known.set('F16-agent-lease-lost-after-hub-restart', 'after a hub restart (every deploy) a running agent gets 409 lease-lost on its next post; the core stops itself (README: the channel process exits) and its outbox is stuck until the process is started again')
        this.killDev(d); this.stats.crashes++
        await sleep(100)
        try { await this.boot(d) } catch (e) { await sleep(500); d.faults = { delay: 0, lose_response: 0, offline: 0 }; try { await this.boot(d) } catch (e2) { { if (/tab-conflict/.test(e2.message)) { d.dead = true; d.client = null; continue } throw new Finding('exception', `agent restart after lease-lost failed: ${e2.message}`) } } }
      }
      for (const d of live) {
        if (!d.client || d.dead) continue
        try { await d.client.settle({ timeout_ms: Math.max(1000, end - Date.now()) }) } catch (e) { pending = `${d.name}: ${e.message}`; break }
      }
      if (!pending) {
        for (const room of this.rooms) {
          const members = live.filter(d => d.room === room)
          if (!members.length) continue
          const last = await this.hubLast(room, members[0])
          const lastEntry = this.hub ? Number(this.hub.db.q('SELECT last_entry_number AS n FROM rooms WHERE room_id = ?').get(room.room_id)?.n ?? 0) : null
          for (const d of members) {
            if (d.client.model.room.last_envelope_number < last) { pending = `${d.name}: cursor ${d.client.model.room.last_envelope_number} < hub ${last}`; try { await d.client.catchUp() } catch {} }
            if (lastEntry !== null && d.client.state.head.seq < lastEntry && d.client.model.room.connection !== 'removed') { pending = `${d.name}: member list at ${d.client.state.head.seq} < hub ${lastEntry}`; try { await d.client.serial(() => d.client._refreshMembers()) } catch {} }
          }
        }
      }
      if (!pending) return true
      if (Date.now() > end) throw new Finding('liveness', `did not quiesce within ${timeout_ms} ms: ${pending}`)
      await sleep(15)
    }
  }
  async hubLast(room, via) {
    if (this.hub) { const r = this.hub.db.q('SELECT last_envelope_number AS n FROM rooms WHERE room_id = ?').get(room.room_id); return Number(r?.n ?? 0) }
    const r = await via.client.hub.envelopes({ after_envelope_number: 1e12, limit: 1 })
    return r.last_envelope_number
  }

  async shutdown() {
    for (const d of this.devs.values()) { if (d.client && !d.dead) { try { this.killDev(d) } catch {} } }
    await this.stopHub().catch(() => {})
  }
  cleanup() { try { fs.rmSync(this.dir, { recursive: true, force: true }) } catch {} }
}
