// quota.mjs: attachment bytes per room (ROOM_ATTACHMENT_QUOTA_BYTES, default 1 GiB), counted from
// attachments.total_size. An upload that would exceed it evicts the oldest evictable attachments first:
// those of answered or closed objects, and those that only thread items name. Never evicted: attachments
// of open objects (a released published page is an open object), anything a human's status register names (the
// canvas snapshot pointers), and attachments no envelope names yet (an upload in flight).
// Review 3 (a member pinning the quota, N3/H3):
//   - Only the uploader's OWN envelopes count as references: naming someone else's attachment neither protects it nor
//     makes it evictable.
//   - An agent's upload evicts only that agent's own attachments, never another device's.
//   - Agents together hold at most AGENT_SHARE of the quota; beyond it an agent's upload is refused (413), so whatever
//     agents pin, humans keep the rest.
//   - An agent's status protects only what its newest attachment-naming status in that scope names (a canvas snapshot
//     pointer is replaced by the next one); an older status pins nothing.
import { refuse } from './http.mjs'

const OPEN = 1, TIMELINE_ITEM = 1, STATUS = 6
export const AGENT_SHARE = 0.25

export function attachmentQuota({ db, files, quotaBytes = 1 << 30, agentShare = AGENT_SHARE, announce = () => {}, log = () => {} }) {
  const used = roomId => db.q('SELECT COALESCE(SUM(total_size), 0) AS n FROM attachments WHERE room_id = ?').get(roomId).n
  const agentsOf = roomId => new Set(db.q("SELECT device_id FROM devices WHERE room_id = ? AND device_role = 'agent'").all(roomId).map(r => r.device_id))
  const agentBytes = (roomId, agents) => db.q('SELECT uploader_device_id, total_size FROM attachments WHERE room_id = ?').all(roomId)
    .reduce((n, a) => n + (agents.has(a.uploader_device_id) ? a.total_size : 0), 0)
  const scopeOf = header => { const hb = Buffer.from(header); return hb[38] === 1 ? Buffer.from(hb.subarray(39, 55)).toString('hex') : 'room' }

  /** Evictable attachments of a room, oldest first (only `uploader`'s when given). */
  function evictable(roomId, uploader = null) {
    const agents = agentsOf(roomId)
    const refs = new Map()            // `${uploader} ${attachment_id}` -> Set of envelope kinds of the uploader's own envelopes naming it
    const newestAgentStatus = new Map()   // `${agent} ${scope}` -> attachment ids of its newest attachment-naming status there
    for (const e of db.q('SELECT envelope_kind, attachment_ids, sender_device_id, envelope_header FROM envelopes WHERE room_id = ? AND attachment_ids IS NOT NULL ORDER BY envelope_number').iterate(roomId)) {
      const sender = Buffer.from(e.sender_device_id).toString('hex')
      const ids = e.attachment_ids.split(',')
      if (e.envelope_kind === STATUS && agents.has(sender)) { newestAgentStatus.set(`${sender} ${scopeOf(e.envelope_header)}`, ids); continue }
      for (const id of ids) { const key = `${sender} ${id}`; let k = refs.get(key); if (!k) refs.set(key, k = new Set()); k.add(e.envelope_kind) }
    }
    const pinnedByAgents = new Set()
    for (const [key, ids] of newestAgentStatus) for (const id of ids) pinnedByAgents.add(`${key.split(' ')[0]} ${id}`)
    return db.q(`SELECT a.attachment_id, a.total_size, a.object_id, a.uploader_device_id, o.object_state FROM attachments a
        LEFT JOIN objects o ON o.room_id = a.room_id AND o.object_id = a.object_id WHERE a.room_id = ? ORDER BY a.stored_at, a.attachment_id`).all(roomId)
      .filter(a => {
        if (uploader && a.uploader_device_id !== uploader) return false
        const own = `${a.uploader_device_id} ${a.attachment_id}`
        if (pinnedByAgents.has(own)) return false
        const k = refs.get(own)
        if (!k) return agents.has(a.uploader_device_id) && a.object_id == null && newestAgentStatusNamed(a)   // only an agent's older statuses named it
        if (k.has(STATUS)) return false
        return a.object_id ? a.object_state != null && a.object_state !== OPEN : k.size === 1 && k.has(TIMELINE_ITEM)
      })
    function newestAgentStatusNamed(a) { return db.q("SELECT 1 FROM envelopes WHERE room_id = ? AND envelope_kind = ? AND sender_device_id = ? AND (',' || attachment_ids || ',') LIKE ?")
      .get(roomId, STATUS, Buffer.from(a.uploader_device_id, 'hex'), `%,${a.attachment_id},%`) != null }
  }

  /** What has to go so that `bytes` more fit (for an upload by `uploader`); refuses with 413 quota-exceeded otherwise. */
  function plan(roomId, bytes, uploader = null) {
    const agents = uploader ? agentsOf(roomId) : new Set()
    const isAgent = !!uploader && agents.has(uploader)
    const now = used(roomId)
    const cap = Math.floor(quotaBytes * agentShare)
    const agentNow = isAgent ? agentBytes(roomId, agents) : 0
    if (now + bytes <= quotaBytes && (!isAgent || agentNow + bytes <= cap)) return []
    const out = []
    let freed = 0
    for (const a of evictable(roomId, isAgent ? uploader : null)) {
      if (now - freed + bytes <= quotaBytes && (!isAgent || agentNow - freed + bytes <= cap)) break
      out.push(a)
      freed += a.total_size
    }
    if (now - freed + bytes <= quotaBytes && (!isAgent || agentNow - freed + bytes <= cap)) return out
    if (isAgent && now - freed + bytes <= quotaBytes) refuse(413, 'quota-exceeded', `agents hold at most ${cap} bytes of this room's attachments`, { used: agentNow, quota: cap })
    refuse(413, 'quota-exceeded', `this room holds at most ${quotaBytes} bytes of attachments`, { used: now, quota: quotaBytes })
  }

  return {
    quotaBytes,
    used,
    /** Before an upload of a known size: refuse early if it cannot fit (evicts nothing). */
    check(roomId, bytes, uploader = null) { plan(roomId, bytes, uploader) },
    /** Right before storing `bytes` (synchronous, so no other upload interleaves): evict what has to go, or refuse. */
    make(roomId, bytes, uploader = null) {
      const gone = plan(roomId, bytes, uploader)
      if (!gone.length) return
      db.tx(() => { for (const a of gone) db.q('DELETE FROM attachments WHERE room_id = ? AND attachment_id = ?').run(roomId, a.attachment_id) })
      for (const a of gone) files.delete(roomId, a.attachment_id)
      log(`room ${roomId.slice(0, 8)}: evicted ${gone.length} attachment(s) for the quota`)
      announce(roomId, 'attachment_evicted', { attachment_ids: gone.map(a => a.attachment_id) })
    },
  }
}
