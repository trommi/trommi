// quota.mjs: attachment bytes per room (ROOM_ATTACHMENT_QUOTA_BYTES, default 1 GiB), counted from
// attachments.total_size. An upload that would exceed it evicts the oldest evictable attachments first:
// those of answered or closed objects, and those that only thread items name. Never evicted: attachments
// of open objects (a released published page is an open object), anything a status register names (the
// canvas snapshot pointers), and attachments no envelope names yet (an upload in flight).
import { refuse } from './http.mjs'

const OPEN = 1, TIMELINE_ITEM = 1, STATUS = 6

export function attachmentQuota({ db, files, quotaBytes = 1 << 30, announce = () => {}, log = () => {} }) {
  const used = roomId => db.q('SELECT COALESCE(SUM(total_size), 0) AS n FROM attachments WHERE room_id = ?').get(roomId).n

  /** Evictable attachments of a room, oldest first. */
  function evictable(roomId) {
    const kinds = new Map()           // attachment_id -> Set of envelope kinds that name it
    for (const e of db.q('SELECT envelope_kind, attachment_ids FROM envelopes WHERE room_id = ? AND attachment_ids IS NOT NULL').iterate(roomId)) {
      for (const id of e.attachment_ids.split(',')) { let k = kinds.get(id); if (!k) kinds.set(id, k = new Set()); k.add(e.envelope_kind) }
    }
    return db.q(`SELECT a.attachment_id, a.total_size, a.object_id, o.object_state FROM attachments a
        LEFT JOIN objects o ON o.room_id = a.room_id AND o.object_id = a.object_id WHERE a.room_id = ? ORDER BY a.stored_at, a.attachment_id`).all(roomId)
      .filter(a => {
        const k = kinds.get(a.attachment_id)
        if (!k || k.has(STATUS)) return false
        return a.object_id ? a.object_state != null && a.object_state !== OPEN : k.size === 1 && k.has(TIMELINE_ITEM)
      })
  }

  /** What has to go so that `bytes` more fit; refuses with 413 quota-exceeded when even that is not enough. */
  function plan(roomId, bytes) {
    const now = used(roomId)
    if (now + bytes <= quotaBytes) return []
    const out = []
    let freed = 0
    for (const a of evictable(roomId)) {
      out.push(a)
      freed += a.total_size
      if (now - freed + bytes <= quotaBytes) return out
    }
    refuse(413, 'quota-exceeded', `this room holds at most ${quotaBytes} bytes of attachments`, { used: now, quota: quotaBytes })
  }

  return {
    quotaBytes,
    used,
    /** Before an upload of a known size: refuse early if it cannot fit (evicts nothing). */
    check(roomId, bytes) { plan(roomId, bytes) },
    /** Right before storing `bytes` (synchronous, so no other upload interleaves): evict what has to go, or refuse. */
    make(roomId, bytes) {
      const gone = plan(roomId, bytes)
      if (!gone.length) return
      db.tx(() => { for (const a of gone) db.q('DELETE FROM attachments WHERE room_id = ? AND attachment_id = ?').run(roomId, a.attachment_id) })
      for (const a of gone) files.delete(roomId, a.attachment_id)
      log(`room ${roomId.slice(0, 8)}: evicted ${gone.length} attachment(s) for the quota`)
      announce(roomId, 'attachment_evicted', { attachment_ids: gone.map(a => a.attachment_id) })
    },
  }
}
