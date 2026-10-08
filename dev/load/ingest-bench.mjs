// ingest-bench.mjs: what a hub itself can take, without the load generator's sealing in the way. Founds a room,
// joins --members human devices (real invites, check codes), seals --per envelopes per member in advance (desk
// strokes under the room key, each member its own chain), then posts them all: one sequential poster per member,
// all members at once. A stream observer counts arrivals (delivery lag: from the start of its POST). Prints ingest rate, POST latency, delivery lag, and the hub
// process's CPU time and peak RSS (/proc). Both hubs run as their own process, started the same way:
//
//   node dev/load/ingest-bench.mjs --hub-cmd='node hub/server.mjs' [--members=32] [--per=1500]
//   node dev/load/ingest-bench.mjs --hub-cmd=hub-rs/target/release/trommi-hub
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as z from '../../shared/crypto/zcrypto.mjs'
import { arg, pct } from './lib.mjs'

const MEMBERS = Number(arg('members', 32)), PER = Number(arg('per', 1500))
process.env.HUB_CMD = arg('hub-cmd', 'node hub/server.mjs')
Object.assign(process.env, { HUB_LIMIT_ENVELOPES_PER_SECOND: '1000000', HUB_LIMIT_ENVELOPE_BURST: '1000000', HUB_LIMIT_OPEN_REQUESTS_PER_IP_MINUTE: '1000000000', HUB_WRITE_PER_IP: '100000', HUB_LIMIT_FOUND_PER_IP_HOUR: '1000000' })
const { startHub } = await import('../../hub/external.mjs')
const { ROLE, b64u, unb64u, hex } = z
const dir = fs.mkdtempSync(path.join(arg('tmp', os.tmpdir()), 'ingest-bench-'))
const hub = await startHub({ port: 0, host: '127.0.0.1', dataDir: dir, log: () => {} })
const base = hub.hubUrl, pid = hub.process.pid
const api = async (method, p, { token, body } = {}) => {
  const r = await fetch(base + p, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const j = await r.json()
  if (r.status >= 300) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(j)}`)
  return j
}

// ---- the room, the members --------------------------------------------------------------------------
const code = z.generateRecoveryCode()
const phone = { device: await z.generateDevice(), secrets: new Map(), chains: z.newChains() }
const room = await z.createRoom({ device: phone.device, recovery: await z.recoveryDevice(code) })
const roomId = hex(room.roomId), R = `/v1/rooms/${roomId}`
await api('POST', '/v1/rooms', { body: { signed_entry: b64u(room.entry), sealed_room_keys: room.wraps.map(x => ({ device_id: hex(x.id), key_sealed: b64u(x.sealed) })) } })
phone.secrets.set(1, room.secret)
const signIn = async c => {
  const { challenge } = await api('POST', `${R}/challenge`)
  c.token = (await api('POST', `${R}/access_tokens`, { body: { signed_challenge: b64u(await z.signHubAuth({ device: c.device, roomId: room.roomId, hub: hub.hubUrl, challenge: unb64u(challenge) })) } })).access_token
}
const sync = async c => {
  const m = await api('GET', `${R}/members`, { token: c.token })
  c.state = await z.verifyLog(m.signed_entries.map(unb64u), room.roomId)
}
await signIn(phone); await sync(phone)
const members = [phone]
for (let i = 1; i < MEMBERS; i++) {
  const device = await z.generateDevice()
  const made = await z.createInvite({ state: phone.state, inviter: phone.device, hub: hub.hubUrl, role: ROLE.HUMAN })
  const { invite_id } = await api('POST', `${R}/invites`, { token: phone.token, body: { signed_offer: b64u(made.offer) } })
  const served = await api('GET', `${R}/invites/${invite_id}`)
  const log = served.signed_entries.map(unb64u)
  const { request, join } = await z.createJoinRequest({ link: made.link, offer: unb64u(served.signed_offer), log, device })
  const { request_hash } = await api('POST', `${R}/invites/${invite_id}/requests`, { body: { signed_request: b64u(request) } })
  const { signed_requests } = await api('GET', `${R}/invites/${invite_id}/requests`, { token: phone.token })
  const { reveal } = await z.acceptJoinRequest({ invite: made.invite, request: unb64u(signed_requests[0]), inviter: phone.device })
  await api('POST', `${R}/invites/${invite_id}/reveal`, { token: phone.token, body: { signed_reveal: b64u(reveal) } })
  const done = await z.finalizeInvite({ invite: made.invite, state: phone.state, inviter: phone.device, secret: phone.secrets.get(1), codeConfirmed: true })
  await api('POST', `${R}/members`, { body: { signed_entry: b64u(done.entry), sealed_room_keys: [{ device_id: hex(device.id), key_sealed: b64u(done.wrap) }] } })
  const fin = await api('GET', `${R}/invites/${invite_id}/status?request_hash=${request_hash}`)
  const joined = await z.completeJoin({ join, device, log: fin.signed_entries.map(unb64u), wrap: unb64u(fin.key_sealed) })
  const c = { device, secrets: new Map([[1, joined.secret]]), chains: z.newChains() }
  await signIn(c); await sync(c)
  members.push(c)
  phone.state = (await z.verifyLog((await api('GET', `${R}/members`, { token: phone.token })).signed_entries.map(unb64u), room.roomId))
}
for (const c of members) await sync(c)

// ---- seal everything in advance -----------------------------------------------------------------------
const DESK = `desk/${'d5'.repeat(16)}`
const payload = new TextEncoder().encode(JSON.stringify({ schema_version: 1, content_type: 'strokes', strokes: [{ tool: 'pen', color: 'ink', width: 2, points: 'AAAA'.repeat(40) }] }))
const t0 = performance.now()
for (const c of members) {
  c.queue = []
  for (let i = 0; i < PER; i++) {
    const e = await z.sealEnvelope({ device: c.device, state: c.state, chains: c.chains, kind: z.KIND.TIMELINE_ITEM, payload, keyScope: 0, secret: c.secrets.get(1), timelineKind: z.TIMELINE.SCRIBBLE, timelineId: DESK })
    c.queue.push({ key: `${hex(c.device.id)}:${e.seq}`, body: JSON.stringify({ envelope: b64u(e.bytes) }) })
  }
}
const sealMs = performance.now() - t0

// ---- an observer stream, then post -------------------------------------------------------------------------
const total = MEMBERS * PER
let arrived = 0, firstAt = 0, lastAt = 0
const arrivedAt = new Map()     // "<sender>:<seq>" -> when it arrived on the stream (joined with when its POST began)
const ac = new AbortController()
const res = await fetch(`${base}${R}/stream?after_envelope_number=${1e12}`, { headers: { authorization: `Bearer ${phone.token}` }, signal: ac.signal })
;(async () => {
  const dec = new TextDecoder(); let buf = ''
  try {
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2)
        if (!block.includes('event: envelope')) continue
        arrived++
        const data = JSON.parse(block.slice(block.indexOf('data: ') + 6))
        const h = z.peekEnvelope(unb64u(data.envelope)).header
        arrivedAt.set(`${hex(h.sender)}:${h.seq}`, performance.timeOrigin + performance.now())
      }
    }
  } catch {}
})()
const ticks = () => { try { const v = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '); return Number(v[11]) + Number(v[12]) } catch { return 0 } }
const rss = () => { try { return Number(fs.readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]) * 4096 / 1048576 } catch { return 0 } }
let peak = rss()
const sampler = setInterval(() => { peak = Math.max(peak, rss()) }, 100)
const cpu0 = ticks(), start = performance.now()
// The posters run in --posters worker threads (one fetch client each would otherwise be the bottleneck).
const POSTERS = Number(arg('posters', 4))
const { Worker } = await import('node:worker_threads')
const postMs = [], postedAt = new Map()
let failed = 0
const POSTER = `
  const { parentPort, workerData } = require('node:worker_threads')
  const { url, members } = workerData
  ;(async () => {
    const ms = [], at = []
    let failed = 0
    await Promise.all(members.map(async m => {
      for (const { key, body } of m.queue) {
        const t = performance.now()
        at.push([key, performance.timeOrigin + t])
        const r = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + m.token, 'content-type': 'application/json' }, body })
        await r.arrayBuffer()
        ms.push(performance.now() - t)
        if (r.status !== 200) failed++
      }
    }))
    parentPort.postMessage({ ms, at, failed })
  })()`
const groups = Array.from({ length: POSTERS }, () => [])
members.forEach((c, i) => groups[i % POSTERS].push({ token: c.token, queue: c.queue }))
await Promise.all(groups.filter(g => g.length).map(g => new Promise((ok, bad) => {
  const w = new Worker(POSTER, { eval: true, workerData: { url: `${base}${R}/envelopes`, members: g } })
  w.once('message', m => { postMs.push(...m.ms); for (const [k, t] of m.at) postedAt.set(k, t); failed += m.failed; ok() })
  w.once('error', bad)
})))
const postSec = (performance.now() - start) / 1000
const until = Date.now() + 30000
while (arrived < total - failed && Date.now() < until) await new Promise(r => setTimeout(r, 50))
const allSec = (performance.now() - start) / 1000
const cpuSec = (ticks() - cpu0) / 100
clearInterval(sampler)
ac.abort()
const lag = []
for (const [k, t] of arrivedAt) { const p0 = postedAt.get(k); if (p0) lag.push(t - p0) }
const out = {
  hub: process.env.HUB_CMD, members: MEMBERS, posters: POSTERS, per_member: PER, envelopes: total, failed, seal_ms: Math.round(sealMs),
  ingest_per_s: Math.round(total / postSec), delivered: arrived, delivered_all_s: +allSec.toFixed(2),
  post_ms: pct(postMs), delivery_lag_ms: pct(lag), hub_cpu_s: +cpuSec.toFixed(2), hub_cpu_ms_per_1000: +(cpuSec * 1e6 / total).toFixed(0), hub_rss_peak_mb: +peak.toFixed(1),
  db_mb: +((fs.statSync(path.join(dir, 'hub.db')).size + (fs.existsSync(path.join(dir, 'hub.db-wal')) ? fs.statSync(path.join(dir, 'hub.db-wal')).size : 0)) / 1048576).toFixed(1),
}
console.log(JSON.stringify(out))
await hub.close()
fs.rmSync(dir, { recursive: true, force: true })
process.exit(0)
