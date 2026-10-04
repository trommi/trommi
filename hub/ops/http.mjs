// http.mjs: the few HTTP pieces the ops modules share. A refusal is thrown as an Error carrying `reply`;
// the hub's error handler sends `reply.status` with `reply.body` ({ error, message, ...details }).

export function refuse(status, error, message, details = {}) {
  throw Object.assign(new Error(message), { code: error, reply: { status, body: { error, message, ...details } } })
}

export function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

/** The request body as a JSON object, at most `max` bytes. */
export async function readJson(req, max, deadlineMs = 15000) {
  const parts = []
  let size = 0
  const deadline = setTimeout(() => req.destroy(), deadlineMs)     // a half-sent body does not hold a write slot
  try {
    for await (const c of req) {
      size += c.length
      if (size > max) refuse(413, 'too-large', `this request is at most ${max} bytes`)
      parts.push(c)
    }
  } finally { clearTimeout(deadline) }
  try { const v = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); if (v && typeof v === 'object' && !Array.isArray(v)) return v } catch {}
  refuse(400, 'bad-format', 'the request body is not a JSON object')
}

/** One timestamp list per key: allow(key) is false once `max` hits fell into the last `windowMs`. Capped at `keys` keys. */
export function windowLimit(max, windowMs, now, keys = 100000) {
  const map = new Map()
  return {
    /** 0 if allowed (and counted), else seconds until the next hit is allowed. */
    take(key) {
      const t = now()
      const hits = (map.get(key) ?? []).filter(x => t - x < windowMs)
      map.delete(key)
      if (map.size >= keys) map.delete(map.keys().next().value)     // oldest key out: bounded, insertion order is LRU order
      map.set(key, hits)
      if (hits.length >= max) return Math.max(1, Math.ceil((hits[0] + windowMs - t) / 1000))
      hits.push(t)
      return 0
    },
  }
}
