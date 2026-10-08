// snapshot.mjs: the signed room snapshot (research notes, README "Adopted from the research"). A human device
// writes its verified model, the chain heads per sender (the frontier) and the cursor as one encrypted attachment and
// points the human register `room_snapshot` at it. A new human device loads the newest snapshot from a human device
// (stated trust, like a canvas snapshot: it cannot be checked without replaying) and syncs only the tail after it,
// with full chain checks from the frontier on. Threads stay lazy; items from before the snapshot are checked by
// their signature when opened.
//
//   register room_snapshot = { attachment: <README reference>, encoding, envelope_number, log_seq, log_hash, written_at }  (the frontier is inside the attachment)
//   attachment = gzip(JSON { schema: 2, room_id, envelope_number, log_seq, log_hash, chains, frontiers, model })
import * as z from './crypto/zcrypto.mjs'
import * as M from './model.mjs'
import * as codec from './codec.mjs'
import * as G from './crypto/session-grants.mjs'

const { b64u, unb64u, hex, unhex, ZError } = z
export const SNAPSHOT_SCHEMA = 2
export const SNAPSHOT_EVERY = 5000          // envelopes between two snapshots of one device
const SCAN_PAGES = 12                       // pages of 1000 scanned back for the newest pointer
const OVERLAP = 1000                        // envelopes before the snapshot's cursor read again after a boot (D6)

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
  for (const [k, c] of client.chains) chains[k] = [c.seq, b64u(c.hash)]     // the writer's own chain too: the tail overlap needs every head
  return {
    schema: SNAPSHOT_SCHEMA, room_id: m.room.room_id, envelope_number: m.room.last_envelope_number,
    log_seq: client.state.head.seq, log_hash: hex(client.state.head.hash),
    chains, frontiers: Object.fromEntries([...client.frontiers].map(([k, f]) => [k, Object.fromEntries(f)])),
    model: {
      cards: [...m.cards.values()], permissions: [...m.permissions.values()], notes: [...m.notes.values()], published: [...m.published.values()],
      sessions: [...m.sessions.values()].map(M.serialiseSession), timelines: [...m.timelines.values()].map(M.serialiseTimelineMeta),
      human: [...m.human.raw], device_registers: [...(m._device_registers ?? [])],
    },
  }
}

/**
 * The snapshot as JSON bytes, made in slices that leave the page time between them (a huge room's model is tens of
 * MB of JSON: in one piece it was a task of seconds on a phone). Each slice is ~YIELD_MS of work; the result is the
 * same text JSON.stringify gives.
 */
const YIELD_MS = 12
export async function jsonBytes(snap) {
  const te = new TextEncoder(), parts = []
  let t0 = performance.now()
  const breathe = async () => { if (performance.now() - t0 > YIELD_MS) { await new Promise(r => setTimeout(r, 0)); t0 = performance.now() } }
  const { model, ...head } = snap
  parts.push(te.encode(JSON.stringify(head).slice(0, -1) + ',"model":{'))
  const keys = Object.keys(model)
  for (let k = 0; k < keys.length; k++) {
    const list = model[keys[k]]
    parts.push(te.encode(`${k ? ',' : ''}${JSON.stringify(keys[k])}:[`))
    for (let i = 0; i < list.length; i++) {
      parts.push(te.encode((i ? ',' : '') + (JSON.stringify(list[i]) ?? 'null')))
      await breathe()
    }
    parts.push(te.encode(']'))
  }
  parts.push(te.encode('}}'))
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

/** Human devices: write a snapshot now. Returns the register value. */
export async function writeSnapshot(client) {
  if (!client.is_human) throw new ZError('forbidden', 'only human devices write room snapshots')
  await client.settle().catch(() => {})
  const snap = await client.serial(async () => snapshotOf(client))
  const { bytes, encoding } = await gzip(await jsonBytes(snap))
  const ref = await client.uploadAttachment(bytes, { file_name: 'room-snapshot.json' + (encoding === 'gzip' ? '.gz' : ''), media_type: encoding === 'gzip' ? 'application/gzip' : 'application/json' })
  client.attachmentCache.delete(ref.attachment_id)
  // The frontier lives in the attachment: status bodies stay under 4 KiB (R5) whatever the number of senders.
  const value = { attachment: ref, encoding, envelope_number: snap.envelope_number, log_seq: snap.log_seq, log_hash: snap.log_hash, written_at: Date.now() }
  await client.setRegisters({ room_snapshot: value })
  client._lastSnapshotAt = snap.envelope_number
  return value
}

/**
 * Find the newest room_snapshot pointer: scan the newest pages of envelopes backwards, check each status head's
 * signature and sender (an active-at-the-time human device), decrypt it. Returns { value, envelope_number, sender } or null.
 */
export async function findSnapshot(client) {
  // The newest page and the head in one request (newest=1). A hub without it answers from envelope 1 on: then the
  // head it names is the start of the scan, as before.
  const first = await client.hub.envelopes({ after_envelope_number: 0, limit: 1000, newest: true })
  const last = first.last_envelope_number ?? 0
  if (last < 2000) return null                     // small room: replaying is as fast
  const newestPage = first.envelopes.length && first.envelopes.at(-1).envelope_number === last && first.envelopes[0].envelope_number === Math.max(1, last - 999) ? first : null
  const pages = []
  for (let page = 0, before = last; page < SCAN_PAGES && before > 0; page++) {
    const after = Math.max(0, before - 1000)
    const r = page === 0 && newestPage ? newestPage : await client.hub.envelopes({ after_envelope_number: after, limit: 1000 })
    pages.unshift(r.envelopes.filter(e => e.envelope_number > after && e.envelope_number <= before))
    for (const { envelope_number, envelope } of [...r.envelopes].reverse()) {
      if (envelope_number > before) continue
      const bytes = unb64u(envelope)
      const peek = z.peekEnvelope(bytes)
      const h = peek.header
      if (h.kind !== codec.KIND.status || peek.pruned || h.keyScope === 1) continue
      try {
        const o = await z.openEnvelope(bytes, { state: client.state, chains: new Map(), allowChainStart: true, allowRemovedSender: true, commit: false, secrets: client.openKeys, quarantine: false })
        const member = client.state.members.get(b64u(h.sender))
        // D5/D6: only from a human device that is still a member now (not one removed since).
        if (!member || member.role !== z.ROLE.HUMAN || member.removedSeq !== null) continue
        const d = codec.decodePayload(o.payload)
        const v = d.content?.values?.room_snapshot
        if (v?.attachment && v.envelope_number <= envelope_number) return { value: v, envelope_number, sender: hex(h.sender), scanned: { envelopes: pages.flat(), last_envelope_number: last } }
      } catch { /* not readable for us: go on */ }
    }
    before = after
  }
  return null
}

/**
 * Everything a snapshot boot reads from the hub, side by side where it can: the newest pages with the pointer, then
 * the attachment and the overlap window before the scanned pages (both named by the pointer) together. A new device
 * starts this as soon as it is signed in, while its re-seal is still on the way (room.mjs). -> { found, raw } | null.
 */
export async function prefetchSnapshot(client) {
  const found = await findSnapshot(client)
  if (!found) return null
  const v = found.value
  const scanned = found.scanned.envelopes
  const from = Math.max(0, v.envelope_number - OVERLAP)            // the catch-up starts here (D6)
  const lo = scanned.length ? scanned[0].envelope_number : found.scanned.last_envelope_number + 1
  const overlap = lo - 1 > from && lo - 1 - from <= 1000
    ? client.hub.envelopes({ after_envelope_number: from, limit: lo - 1 - from }).catch(() => null) : Promise.resolve(null)
  const [raw, extra] = await Promise.all([client.fetchAttachment(v.attachment), overlap])
  // The overlap joins the scanned pages when it closes the gap exactly (contiguous() checks); else it is read again later.
  if (extra?.envelopes?.length) found.scanned = { ...found.scanned, envelopes: [...extra.envelopes.filter(e => e.envelope_number > from && e.envelope_number < lo), ...scanned] }
  return { found, raw }
}

/** Load a snapshot into a fresh client (cursor 0). Returns true if loaded. */
export async function bootFromSnapshot(client) {
  if (!client.is_human || client.model.room.last_envelope_number !== 0) return false
  const t0 = performance.now()
  const pre = client._snapshotPrefetch
  client._snapshotPrefetch = null
  let got = pre ? await pre.catch(() => undefined) : undefined      // a failed prefetch is read again here
  if (got === undefined) got = await prefetchSnapshot(client)
  if (!got) return false
  const { found, raw } = got
  const v = found.value
  if (v.log_seq > client.state.head.seq || hex(client.state.hashes[v.log_seq]) !== v.log_hash) return false   // another member list: do not trust it
  // A snapshot from before the newest removal or recovery may hold what a removed device wrote beyond its cut: replay instead.
  if (G.lastMemberChange && v.log_seq < G.lastMemberChange(client.state)) return false
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
    client._snapshotChains = new Map(Object.entries(snap.chains).map(([k, [seq]]) => [hex(unb64u(k)), seq]))
    client.frontiers = new Map(Object.entries(snap.frontiers).map(([k, f]) => [k, new Map(Object.entries(f))]))
    for (const c of snap.model.cards) m.cards.set(c.object_id, c)
    m._proj = null                                    // project builds its sorted lists again
    for (const p of snap.model.permissions) m.permissions.set(p.object_id, p)
    for (const x of snap.model.notes) m.notes.set(x.object_id, x)
    for (const x of snap.model.published) m.published.set(x.object_id, x)
    for (const s of snap.model.sessions) m.sessions.set(s.session_id ?? s.agent_device_id, { ...M.deserialiseSession(s), ...pick(m.sessions.get(s.session_id), ['agent_device_ids', 'agent_device_id', 'session_key_epoch', 'with_history', 'epoch_agent_ids', 'ever_agent_ids']) })
    for (const t of snap.model.timelines) m.timelines.set(t.timeline_key, M.deserialiseTimelineMeta(t))
    M.deserialiseHuman(m, { raw: snap.model.human })
    // R2: this device's lamport counter starts above every write in the snapshot.
    // Review 3: only sane lamports (an inflated one in a snapshot is not adopted either).
    for (const [, v] of snap.model.human) client.lamport = Math.max(client.lamport ?? 0, M.lamportOf(v?.causal))
    for (const x of snap.model.notes) client.lamport = Math.max(client.lamport ?? 0, M.lamportOf(x?.causal))
    m._device_registers = new Map(snap.model.device_registers)
    for (const [id, reg] of m._device_registers) { const mem = m.members.get(id); if (mem) Object.assign(mem, { device_name: reg?.device_name ?? '', platform: reg?.platform ?? null, folder: reg?.folder ?? null, host: reg?.host ?? null }) }
    // D6: the hub's numbers are retrieval hints, not proof. The tail is read from an overlap window before the snapshot's
    // cursor; envelopes inside the frontier are recognised by (sender, sequence) and skipped (a different hash at a
    // frontier position is equivocation), everything beyond the frontier is applied whatever number the hub gave it.
    m.room.last_envelope_number = Math.max(0, snap.envelope_number - OVERLAP)
    client.snapshotCursor = snap.envelope_number
    client._scan = contiguous(found.scanned)          // the catch-up that follows reads these pages from memory
    const ch = M.emptyChange()
    for (const k of ['cards', 'sessions', 'permissions', 'notes', 'published', 'timelines']) for (const id of m[k].keys()) ch[k].add(id)
    ch.members = ch.stack = ch.room = true
    M.project(m, ch)
    client._markDirty(ch, [])
    client._emitChange(ch)
  })
  client.stats.snapshot = { envelope_number: snap.envelope_number, bytes: raw.length, ms: performance.now() - t0, from: found.sender }
  return true
}

/** The scanned records if they are one gapless run of envelope numbers, else null (then nothing is reused). */
function contiguous(scan) {
  const e = scan?.envelopes ?? []
  for (let i = 1; i < e.length; i++) if (e[i].envelope_number !== e[i - 1].envelope_number + 1) return null
  return e.length ? scan : null
}
function pick(o, keys) { const out = {}; if (o) for (const k of keys) if (o[k] !== undefined) out[k] = o[k]; return out }
export { unhex }
