// The pad's link to the server: every element is one record, a change sends that
// record and nothing else (docs/pad.md, "Sync"). IndexedDB (db.js) stays what the
// page reads first and what it works on without a network; this file sends what
// changed, fetches what others changed, and listens for changes as they happen.
//
//   const sync = startSync({ pad, db, onRemote, onState })
//   sync.push(records)        changed here: send them (tombstones too)
//   sync.putBlob(rec)         bytes: kept locally, uploaded before the elements that use them
//   await sync.getBlob(id)    bytes: from this device, else from the server
//   await sync.settled()      true once nothing waits to be sent (false after a few seconds offline)
//   sync.take(records)        records the server handed back in another answer (sending)
//   sync.pause() / resume()   stop and restart listening (the pad is out of sight)
//   sync.state()              { mode: 'starting' | 'online' | 'offline' | 'local', pending, error }
//
// Rules: the server accepts a write only if its rev is higher than what it has, so
// the later arrival wins, per element. A refused write is dropped in favour of the
// server's record. "updated", "seq" and "sent" are the server's to set.

const FLUSH_MS = 120
const BATCH = 400

export function startSync({ pad, db, onRemote, onState }) {
  const clientId = Math.random().toString(36).slice(2, 12)
  const known = new Map()      // id -> { rev, seq } of the newest record seen, from here or from there
  const dirty = new Map()      // id -> record waiting to be sent
  const dirtyBlobs = new Set()
  let cursor = { seq: 0, epoch: null }
  let mode = 'starting', error = null
  let events = null, paused = false, flushing = false, flushTimer = 0, retryTimer = 0, retryMs = 1000
  let waiters = []

  const report = () => {
    onState?.(state())
    if (!dirty.size && !flushing) { for (const w of waiters) w(true); waiters = [] }
  }
  const state = () => ({ mode, pending: dirty.size, error })
  const setMode = next => { if (mode !== next) { mode = next; report() } }
  const meta = (key, value) => db.meta(`${key}:${pad}`, value).catch(() => undefined)
  const saveDirty = () => meta('dirty', { ids: [...dirty.keys()], blobs: [...dirtyBlobs] })
  const saveCursor = () => meta('sync', cursor)
  const api = async (url, init) => {
    const res = await fetch(url, init)
    let out = null
    try { out = await res.json() } catch {}
    return { res, out }
  }

  /** Records from the server: keep what is newer than what is known here, and show it. */
  function take(records, seq) {
    const fresh = []
    for (const rec of records) {
      const have = known.get(rec.id)
      const waiting = dirty.get(rec.id)
      if (waiting && waiting.rev > rec.rev) continue          // a newer change of ours is on its way
      if (have && (rec.rev < have.rev || (rec.rev === have.rev && (rec.seq ?? 0) <= (have.seq ?? 0)))) continue
      if (waiting) dirty.delete(rec.id)
      known.set(rec.id, { rev: rec.rev, seq: rec.seq ?? 0 })
      fresh.push(rec)
    }
    if (seq > cursor.seq) { cursor.seq = seq; saveCursor() }
    if (!fresh.length) return
    db.put(fresh).catch(() => {})
    onRemote?.(fresh)
  }

  /** Fetch what changed since the last time; everything, if this is another store than last time. */
  async function pull() {
    const since = cursor.epoch ? cursor.seq : 0
    const { res, out } = await api(`/pad/elements?pad=${encodeURIComponent(pad)}&since=${since}`)
    if (res.status === 404 || (res.ok && !out?.epoch)) return 'local'   // a board from before the pad had routes, or no board
    if (!res.ok) throw new Error(out?.error || `HTTP ${res.status}`)
    if (out.epoch !== cursor.epoch) {
      // A store this page has not met: the first time on this board, or a board that started over.
      const first = { seq: 0, epoch: out.epoch }
      const all = since === 0 ? out : (await api(`/pad/elements?pad=${encodeURIComponent(pad)}&since=0`)).out
      const there = new Map(all.elements.map(r => [r.id, r]))
      cursor = first
      // What only this device has goes up: notes made before the server could keep them.
      const local = await db.list(pad).catch(() => [])
      for (const rec of local) {
        const remote = there.get(rec.id)
        if (!remote ? !rec.deleted : rec.rev > remote.rev) {
          dirty.set(rec.id, rec)
          if (rec.blob) dirtyBlobs.add(rec.blob)
        }
      }
      for (const id of known.keys()) known.set(id, { rev: known.get(id).rev, seq: 0 })
      take(all.elements, all.seq)
      cursor.seq = all.seq
      saveCursor()
      saveDirty()
      return 'online'
    }
    take(out.elements, out.seq)
    return 'online'
  }

  function listen() {
    events?.close()
    events = null
    if (paused || mode === 'local') return
    const es = events = new EventSource(`/pad/events?pad=${encodeURIComponent(pad)}&since=${cursor.seq}`)
    es.onmessage = e => {
      let msg
      try { msg = JSON.parse(e.data) } catch { return }
      if (msg.hello) {
        retryMs = 1000
        if (msg.epoch !== cursor.epoch) return reconnect(0)
        setMode('online')
        return flush()
      }
      if (msg.elements) take(msg.elements, msg.seq)
    }
    // The browser would reconnect by itself, with the address it has: ask again from where we are instead.
    es.onerror = () => { if (events === es) { setMode('offline'); reconnect() } }
  }
  function reconnect(ms = retryMs) {
    events?.close()
    events = null
    clearTimeout(retryTimer)
    retryMs = Math.min(retryMs * 2, 15000)
    retryTimer = setTimeout(connect, ms)
  }
  async function connect() {
    clearTimeout(retryTimer)
    try {
      const got = await pull()
      if (got === 'local') return setMode('local')
      error = null
      setMode('online')
      listen()
      flush()
    } catch {
      setMode('offline')
      if (!paused) reconnect()
    }
  }

  async function flush() {
    clearTimeout(flushTimer)
    if (flushing || mode === 'local' || mode === 'starting' || (!dirty.size && !dirtyBlobs.size)) return report()
    flushing = true
    try {
      for (const id of [...dirtyBlobs]) {
        const found = await db.getBlob(id)
        if (found) {
          const res = await fetch(`/pad/blobs/${id}`, { method: 'PUT', headers: { 'Content-Type': found.type || found.blob.type || 'application/octet-stream' }, body: found.blob })
          if (!res.ok && res.status !== 400 && res.status !== 413) throw new Error(`HTTP ${res.status}`)
        }
        dirtyBlobs.delete(id)
      }
      while (dirty.size) {
        const batch = [...dirty.values()].slice(0, BATCH)
        const { res, out } = await api('/pad/elements', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pad, client_id: clientId, elements: batch }) })
        if (res.status === 400 || res.status === 413) {
          // The server will never take these as they are; do not ask forever.
          for (const rec of batch) if (dirty.get(rec.id) === rec) dirty.delete(rec.id)
          error = out?.error || `HTTP ${res.status}`
          continue
        }
        if (!res.ok || !out?.results) throw new Error(out?.error || `HTTP ${res.status}`)
        error = null
        const accepted = [], refused = []
        out.results.forEach((r, i) => {
          const rec = batch[i]
          const newer = dirty.get(rec.id) !== rec   // changed again while this was on its way
          if (!newer) dirty.delete(rec.id)
          if (r.error) { if (!newer && r.current) refused.push(r.current) }
          else if (!newer) accepted.push({ ...rec, updated: r.updated, seq: r.seq })
        })
        // The server's time and running number belong on the record; take() keeps them unless the
        // stream was quicker and has already brought something newer.
        if (accepted.length) take(accepted, 0)
        if (refused.length) {
          for (const rec of refused) known.delete(rec.id)
          take(refused, 0)
        }
      }
      saveDirty()
      setMode('online')
    } catch {
      setMode('offline')
      saveDirty()
      if (!events && !paused) reconnect()
      else flushTimer = setTimeout(flush, 3000)
    } finally {
      flushing = false
      report()
    }
  }

  // ── start: what this device knows, then the server ─────────────────────────
  const ready = (async () => {
    const [records, saved, waiting] = await Promise.all([db.list(pad).catch(() => []), meta('sync'), meta('dirty')])
    if (saved?.epoch) cursor = { seq: saved.seq ?? 0, epoch: saved.epoch }
    const byId = new Map(records.map(r => [r.id, r]))
    for (const r of records) known.set(r.id, { rev: r.rev ?? 1, seq: r.seq ?? 0 })
    for (const id of waiting?.ids ?? []) if (byId.has(id) && !dirty.has(id)) dirty.set(id, byId.get(id))
    for (const id of waiting?.blobs ?? []) dirtyBlobs.add(id)
    if (!/^https?:$/.test(location.protocol)) return setMode('local')
    await connect()
  })()

  return {
    clientId, ready, state, take,
    push(records) {
      for (const rec of records) {
        dirty.set(rec.id, rec)
        known.set(rec.id, { rev: rec.rev, seq: known.get(rec.id)?.seq ?? 0 })
      }
      saveDirty()
      clearTimeout(flushTimer)
      flushTimer = setTimeout(flush, FLUSH_MS)
      report()
    },
    async putBlob(rec) {
      await db.putBlob(rec)
      dirtyBlobs.add(rec.id)
      saveDirty()
    },
    async getBlob(id) {
      const local = await db.getBlob(id).catch(() => undefined)
      if (local || mode === 'local') return local
      try {
        const res = await fetch(`/pad/blobs/${id}`)
        if (!res.ok) return undefined
        const blob = await res.blob()
        const rec = { id, type: blob.type, blob }
        db.putBlob(rec).catch(() => {})
        return rec
      } catch { return undefined }
    },
    /** Resolves true when everything made here has reached the server, false if it does not within ms. */
    settled(ms = 6000) {
      if (mode === 'local') return Promise.resolve(false)
      flush()
      if (!dirty.size && !flushing) return Promise.resolve(true)
      return new Promise(resolve => {
        const timer = setTimeout(() => { waiters = waiters.filter(w => w !== done); resolve(false) }, ms)
        const done = ok => { clearTimeout(timer); resolve(ok) }
        waiters.push(done)
      })
    },
    pause() {
      paused = true
      clearTimeout(retryTimer)
      events?.close()
      events = null
    },
    resume() {
      if (!paused) return
      paused = false
      if (mode !== 'local' && mode !== 'starting') connect()
    },
  }
}
