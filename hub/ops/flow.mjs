// flow.mjs: backpressure. Writes are admitted up to a bounded queue (beyond it: 503 + Retry-After), and every
// live stream has a bounded send buffer: a client that does not read is dropped and resumes with its cursor.
import { refuse } from './http.mjs'

const WRITES = new Set(['POST', 'PUT', 'DELETE'])

export function flowControl({ maxWrites = 512, streamBufferBytes = 4 << 20 } = {}) {
  let writes = 0
  const streams = new Set()         // { res, client, pendingBytes, catchingUp, pending }
  const counters = { refusedWrites: 0, droppedStreams: 0 }

  const drop = s => { counters.droppedStreams++; s.res.destroy() }

  return {
    counters,
    streams,
    get writeQueueDepth() { return writes },
    /** Count a write request until its response is done; refuse when the queue is full. */
    admit(req, res) {
      if (!WRITES.has(req.method)) return
      if (writes >= maxWrites) {
        counters.refusedWrites++
        res.setHeader('retry-after', '1')
        refuse(503, 'overloaded', 'the hub is busy; try again in a second')
      }
      writes++
      res.once('close', () => { writes-- })
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
