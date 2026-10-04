// snapshot.mjs: the signed room snapshot (research notes, README "Adopted from the research"). A human device
// writes its verified model, the chain heads per sender (the frontier) and the cursor as one encrypted attachment and
// points the human register `room_snapshot` at it. A new human device loads the newest snapshot from a human device
// (stated trust, like a canvas snapshot: it cannot be checked without replaying) and syncs only the tail after it,
// with full chain checks from the frontier on. Threads stay lazy; items from before the snapshot are checked by
// their signature when opened.
//
//   register room_snapshot = { attachment: <README reference>, envelope_number, log_seq, log_hash, frontier: { <sender>: [seq, hash] }, written_at }
//   attachment = gzip(JSON { schema: 1, room_id, envelope_number, log_seq, log_hash, chains, frontiers, model })
import * as z from './zcrypto.mjs'
import * as M from './model.mjs'
import * as codec from './codec.mjs'

const { b64u, unb64u, hex, unhex, ZError } = z
export const SNAPSHOT_SCHEMA = 1
export const SNAPSHOT_EVERY = 5000          // envelopes between two snapshots of one device
const SCAN_PAGES = 12                       // pages of 1000 scanned back for the newest pointer

async function gzip(bytes) {
  if (typeof CompressionStream === 'undefined') return { bytes, encoding: 'identity' }
  const out = await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()
  return { bytes: new Uint8Array(out), encoding: 'gzip' }
}
async function gunzip(bytes, encoding) {
  if (encoding !== 'gzip') return bytes
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
}

/** What goes into a snapshot: the model as persisted records (timeline items stay out: they are lazy). */
export function snapshotOf(client) {
  const m = client.model
  const chains = {}
  for (const [k, c] of client.chains) if (k !== b64u(client.device.id)) chains[k] = [c.seq, b64u(c.hash)]
  return {
    schema: SNAPSHOT_SCHEMA, room_id: m.room.room_id, envelope_number: m.room.last_envelope_number,
    log_seq: client.state.head.seq, log_hash: hex(client.state.head.hash),
    chains, frontiers: Object.fromEntries([...client.frontiers].map(([k, f]) => [k, Object.fromEntries(f)])),
    model: {
      cards: [...m.cards.values()], permissions: [...m.permissions.values()], memos: [...m.memos.values()], published: [...m.published.values()],
      sessions: [...m.sessions.values()].map(M.serialiseSession), timelines: [...m.timelines.values()].map(M.serialiseTimelineMeta),
      human: [...m.human.raw], device_registers: [...(m._device_registers ?? [])],
    },
  }
}

/** Human devices: write a snapshot now. Returns the register value. */
export async function writeSnapshot(client) {
  if (!client.is_human) throw new ZError('forbidden', 'only human devices write room snapshots')
  await client.settle().catch(() => {})
  const snap = await client.serial(async () => snapshotOf(client))
  const { bytes, encoding } = await gzip(new TextEncoder().encode(JSON.stringify(snap)))
  const ref = await client.uploadAttachment(bytes, { file_name: 'room-snapshot.json' + (encoding === 'gzip' ? '.gz' : ''), media_type: encoding === 'gzip' ? 'application/gzip' : 'application/json' })
  client.attachmentCache.delete(ref.attachment_id)
  const value = { attachment: ref, encoding, envelope_number: snap.envelope_number, log_seq: snap.log_seq, log_hash: snap.log_hash, frontier: snap.chains, written_at: Date.now() }
  await client.setRegisters({ room_snapshot: value })
  client._lastSnapshotAt = snap.envelope_number
  return value
}

/**
 * Find the newest room_snapshot pointer: scan the newest pages of envelopes backwards, check each status head's
 * signature and sender (an active-at-the-time human device), decrypt it. Returns { value, envelope_number, sender } or null.
 */
export async function findSnapshot(client) {
  const head = await client.hub.envelopes({ after_envelope_number: 0, limit: 1 })
  const last = head.last_envelope_number ?? 0
  if (last < 2000) return null                     // small room: replaying is as fast
  for (let page = 0, before = last; page < SCAN_PAGES && before > 0; page++) {
    const after = Math.max(0, before - 1000)
    const r = await client.hub.envelopes({ after_envelope_number: after, limit: 1000 })
    for (const { envelope_number, envelope } of [...r.envelopes].reverse()) {
      if (envelope_number > before) continue
      const bytes = unb64u(envelope)
      const peek = z.peekEnvelope(bytes)
      const h = peek.header
      if (h.kind !== codec.KIND.status || peek.pruned || h.keyScope === 1) continue
      try {
        const o = await z.openEnvelope(bytes, { state: client.state, chains: new Map(), allowChainStart: true, allowRemovedSender: true, commit: false, secrets: client.openKeys, quarantine: false })
        const member = client.state.members.get(b64u(h.sender))
        if (!member || member.role !== z.ROLE.HUMAN) continue
        const d = codec.decodePayload(o.payload)
        const v = d.content?.values?.room_snapshot
        if (v?.attachment && v.envelope_number <= envelope_number) return { value: v, envelope_number, sender: hex(h.sender) }
      } catch { /* not readable for us: go on */ }
    }
    before = after
  }
  return null
}

/** Load a snapshot into a fresh client (cursor 0). Returns true if loaded. */
export async function bootFromSnapshot(client) {
  if (!client.is_human || client.model.room.last_envelope_number !== 0) return false
  const t0 = performance.now()
  const found = await findSnapshot(client)
  if (!found) return false
  const v = found.value
  if (v.log_seq > client.state.head.seq || hex(client.state.hashes[v.log_seq]) !== v.log_hash) return false   // another member list: do not trust it
  const raw = await client.fetchAttachment(v.attachment)
  const snap = JSON.parse(new TextDecoder().decode(await gunzip(raw, v.encoding)))
  if (snap.schema !== SNAPSHOT_SCHEMA || snap.room_id !== client.model.room.room_id || snap.envelope_number !== v.envelope_number) return false
  await client.serial(async () => {
    const m = client.model
    const me = b64u(client.device.id)
    for (const [k, [seq, hash]] of Object.entries(snap.chains)) {
      if (k === me) continue
      client.chains.set(k, { seq, hash: unb64u(hash), hashes: new Map([[seq, unb64u(hash)]]) })
      client._dirty.chains.add(k)
    }
    client.frontiers = new Map(Object.entries(snap.frontiers).map(([k, f]) => [k, new Map(Object.entries(f))]))
    for (const c of snap.model.cards) m.cards.set(c.object_id, c)
    for (const p of snap.model.permissions) m.permissions.set(p.object_id, p)
    for (const x of snap.model.memos) m.memos.set(x.object_id, x)
    for (const x of snap.model.published) m.published.set(x.object_id, x)
    for (const s of snap.model.sessions) m.sessions.set(s.session_id ?? s.agent_device_id, { ...M.deserialiseSession(s), ...pick(m.sessions.get(s.session_id), ['agent_device_ids', 'agent_device_id', 'session_key_epoch', 'with_history']) })
    for (const t of snap.model.timelines) m.timelines.set(t.timeline_key, M.deserialiseTimelineMeta(t))
    M.deserialiseHuman(m, { raw: snap.model.human })
    m._device_registers = new Map(snap.model.device_registers)
    for (const [id, reg] of m._device_registers) { const mem = m.members.get(id); if (mem) Object.assign(mem, { device_name: reg?.device_name ?? '', platform: reg?.platform ?? null, folder: reg?.folder ?? null, host: reg?.host ?? null }) }
    m.room.last_envelope_number = snap.envelope_number
    client.snapshotCursor = snap.envelope_number
    const ch = M.emptyChange()
    for (const k of ['cards', 'sessions', 'permissions', 'memos', 'published', 'timelines']) for (const id of m[k].keys()) ch[k].add(id)
    ch.members = ch.stack = ch.room = true
    M.project(m, ch)
    client._markDirty(ch, [])
    client._emitChange(ch)
  })
  client.stats.snapshot = { envelope_number: snap.envelope_number, bytes: raw.length, ms: performance.now() - t0, from: found.sender }
  return true
}

function pick(o, keys) { const out = {}; if (o) for (const k of keys) if (o[k] !== undefined) out[k] = o[k]; return out }
export { unhex }
