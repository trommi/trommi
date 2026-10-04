// flow.mjs: backpressure. Writes are admitted up to a bounded queue and a per-address cap (beyond: 503 + Retry-After),
// membership writes also into a small reserved pool; every
// live stream has a bounded send buffer: a client that does not read is dropped and resumes with its cursor.
import { refuse } from './http.mjs'

const WRITES = new Set(['POST', 'PUT', 'DELETE'])
// Membership and key operations (removals, session grants) may also use a small reserved pool, so a full general
// queue never blocks a removal.
const MEMBERSHIP = /^\/v1\/rooms\/[0-9a-f]{64}\/(?:members|sessions\/[^/]+\/grants)$/

export const isMembershipWrite = req => req.method === 'POST' && MEMBERSHIP.test(String(req.url).split('?')[0])

export function flowControl({ maxWrites = 512, maxMembershipWrites = 32, maxWritesPerIp = 16, ipOf = () => 'unknown', streamBufferBytes = 4 << 20 } = {}) {
  let writes = 0, membershipWrites = 0
  const perIp = new Map()           // ip -> write slots held now
  const streams = new Set()         // { res, client, pendingBytes, catchingUp, pending }
  const counters = { refusedWrites: 0, refusedWritesPerIp: 0, droppedStreams: 0 }

  const drop = s => { counters.droppedStreams++; s.res.destroy() }
  const busy = (res, message) => { res.setHeader('retry-after', '1'); refuse(503, 'overloaded', message) }

  return {
    counters,
    streams,
    get writeQueueDepth() { return writes + membershipWrites },
    get membershipQueueDepth() { return membershipWrites },
    /** Count a write request until its response is done; refuse when its address holds too many, or the queue is full. */
    admit(req, res) {
      if (!WRITES.has(req.method)) return
      const ip = ipOf(req)
      const held = perIp.get(ip) ?? 0
      if (held >= maxWritesPerIp) { counters.refusedWritesPerIp++; busy(res, 'too many writes in flight from this address; try again in a second') }
      let pool
      if (writes < maxWrites) pool = 'general'
      else if (membershipWrites < maxMembershipWrites && isMembershipWrite(req)) pool = 'membership'
      else { counters.refusedWrites++; busy(res, 'the hub is busy; try again in a second') }
      if (pool === 'general') writes++; else membershipWrites++
      perIp.set(ip, held + 1)
      res.once('close', () => {
        if (pool === 'general') writes--; else membershipWrites--
        const n = (perIp.get(ip) ?? 1) - 1
        if (n > 0) perIp.set(ip, n); else perIp.delete(ip)
      })
    },
    /** Register a live stream (the hub's stream object) with the client that opened it. */
    track(s, client) {
      s.client = client
      s.pendingBytes = 0
      streams.add(s)
      s.res.once('close', () => streams.delete(s))
    },
    /** Send a chunk ({ text, n? }) to a stream: queued while it catches up, written when live; over the buffer -> dropped. */
    send(s, chunk) {
      if (s.catchingUp) {
        s.pending.push(chunk)
        s.pendingBytes = (s.pendingBytes ?? 0) + chunk.text.length
        if (s.pendingBytes > streamBufferBytes) drop(s)
        return
      }
      s.res.write(chunk.text)
      if (s.res.writableLength > streamBufferBytes) drop(s)
    },
    /** Outbound bytes waiting per stream: { total, max, count }. */
    outbound() {
      let total = 0, max = 0
      for (const s of streams) { const b = s.res.writableLength + (s.catchingUp ? s.pendingBytes : 0); total += b; if (b > max) max = b }
      return { total, max, count: streams.size }
    },
  }
}
