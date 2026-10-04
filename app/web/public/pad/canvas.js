// The pad's canvas, end-to-end encrypted: one canvas timeline of the room (desk/<desk_id>, session/<session_id>),
// carried by the client core (trommi-hub client/core: sendStrokes, loadTimelineAfter, uploadAttachment, registers).
// The wire and the merge are wire.js; this file is the glue between the pad's element records (elements.js) and it.
//
//   const canvas = await openCanvas({ client, timeline_id, onRemote, onState })
//   canvas.records()                 every element now (pad records)
//   canvas.push(changes, how)        the pad changed: [{ id, before, after }] (after null: gone; how 'send_away' for a send)
//   canvas.live(g) / claim(g, id) / drop(g)   a stroke being drawn goes out every ~150 ms; at its end it is element id
//   await canvas.putBlob(blob, meta) the picture, encrypted and uploaded: its attachment id
//   await canvas.getBlob(id)         { blob } of a picture on the canvas
//   await canvas.send({ to, text, png, ids })   the selection as a picture with its words to a session (selection_sent)
//   canvas.state()                   { mode, pending, error }
//
// Ids: the pad keeps the id an element had when it was made here (stable for undo and selection); on the wire an
// element is its stroke id (wire.js, R1). A change that is not a plain move (resize, recolour, an edited note, z)
// erases the old shape and adds the new one, and the pad's id then stands for the new stroke id. Others' shapes have
// their stroke id as the pad id. An own item is applied to the canvas state through the same reducer as everyone
// else's, the moment it is sealed; when the hub's copy comes back, the frontier says it is applied already.
//
// Fresh load: the newest snapshot (register canvas_snapshot/<timeline_id> -> encrypted gzip attachment) + the tail
// after it. After SNAP_EVERY items applied, with the canvas idle and the outbox empty, this device writes a new one.
// Without a core (the mock room) the canvas lives in this page only.
import { CanvasState, entryOf, encodePoints, packSnapshot, unpackSnapshot, chunks } from './wire.js'
import { strokeFromWorld, layoutText, r2 } from './elements.js'

const FLUSH_MS = 150
const SNAP_EVERY = 300
const SNAP_IDLE_MS = 4000
const ITEM_BYTES = 48_000
const SLICE = 2000          // shapes per slice when a big canvas is loaded
const breath = () => (globalThis.scheduler?.yield ? scheduler.yield() : new Promise(r => setTimeout(r)))   // a strokes item stays under the core's 60 KB body limit

export async function openCanvas({ client, timeline_id, onRemote, onState }) {
  const key = `canvas:${timeline_id}`
  const st = new CanvasState()
  const real = typeof client.sendStrokes === 'function'
  const me = client.my_device_id ?? client.model?.room?.my_device_id ?? 'this-device'
  const refs = new Map()          // attachment id -> reference (pictures)
  const alias = new Map()         // pad id -> version { wire: stroke id | null } of an element made or changed here
  const padOf = new Map()         // stroke id -> pad id, for those
  const lives = new Map()         // gesture -> { g, ver, sent: points sent }
  const claims = new Map()        // pad id -> the version of the live stroke it became
  let queue = []                  // ops for the next flush: { add, ver } | { move: [dx, dy], ver } | { gone, ver } | { tail }
  let flushing = null, flushTimer = 0, snapTimer = 0, error = null, mockSeq = 0, lastOp = 0, started = false
  let mode = real ? 'starting' : 'local'
  const state = () => ({ mode, pending: queue.length + lives.size + (flushing ? 1 : 0), error })
  const report = () => onState?.(state())
  const connection = () => (client.model?.room?.connection === 'live' ? 'online' : 'offline')

  // ---- shapes <-> pad records ----
  const padId = id => padOf.get(id) ?? id
  function recordOf(s) {
    const base = { id: padId(s.id), pad: timeline_id, rotation: 0, z: s.z ?? 0, group: s.group ?? null, author: s.by, rev: 1, blob: null, sent: [] }
    if (s.tool === 'pen' || s.tool === 'hl') {
      const k = strokeFromWorld(s.pts, s.pr?.length === s.pts.length >> 1 ? s.pr : null, { tool: s.tool, color: s.color ?? 'ink', size: s.size })
      return { ...base, type: 'stroke', x: k.x, y: k.y, w: k.w, h: k.h, data: k.data }
    }
    if (s.tool === 'image') {
      refs.set(s.attachment.attachment_id, s.attachment)
      return { ...base, type: 'image', x: s.pts[0], y: s.pts[1], w: r2(s.pts[2] - s.pts[0]), h: r2(s.pts[3] - s.pts[1]), blob: s.attachment.attachment_id, data: { mime: s.mime, nw: s.nw, nh: s.nh, name: s.name ?? '' } }
    }
    const data = { text: s.text, size: s.size, color: s.color ?? 'ink', wrap: s.wrap }
    const lay = layoutText(data, s.tool)
    return { ...base, type: s.tool, x: s.pts[0], y: s.pts[1], w: lay.w, h: lay.h, data }
  }
  /** A pad record -> a shape (what goes into a strokes item). */
  function shapeOfRecord(r) {
    const d = r.data ?? {}
    const s = { tool: r.type === 'stroke' ? d.tool : r.type, z: r.z, group: r.group ?? null }
    if (r.type === 'stroke') {
      const sx = r.w / d.box[0], sy = r.h / d.box[1]
      Object.assign(s, { pts: d.pts.map((v, i) => (i % 2 ? r.y + v * sy : r.x + v * sx)), pr: d.pr ?? null, color: d.color, size: r2(d.size * Math.sqrt(sx * sy)) })
    } else if (r.type === 'image') {
      Object.assign(s, { pts: [r.x, r.y, r.x + r.w, r.y + r.h], attachment: refs.get(r.blob), nw: d.nw, nh: d.nh, mime: d.mime, name: d.name })
    } else Object.assign(s, { pts: [r.x, r.y], text: d.text, size: d.size, color: d.color, wrap: d.wrap ?? null })
    return s
  }
  const plainMove = (a, b) => a.type === b.type && a.w === b.w && a.h === b.h && a.data === b.data && a.z === b.z && (a.group ?? null) === (b.group ?? null) && a.blob === b.blob

  // ---- what comes in ----
  function take(items) {
    const changed = new Set()
    for (const it of items) {
      if (it.pending || it.item_state !== 'loaded' || !it.content) continue
      if (it.envelope_number > st.last_envelope_number && st.covered(it.sender_device_id, it.sender_sequence)) st.last_envelope_number = it.envelope_number   // an own item, confirmed
      const got = st.apply(it)
      if (got) for (const id of got) changed.add(id)
    }
    if (!changed.size) return
    onRemote?.([...changed].map(id => { const s = st.shapes.get(id); return s ? recordOf(s) : { id: padId(id), deleted: true } }))
    if (st.applied >= SNAP_EVERY) snapSoon()
  }
  const byNumber = (a, b) => (a.envelope_number ?? Infinity) - (b.envelope_number ?? Infinity)

  // ---- what goes out ----
  /** Seal one canvas item and apply it here. Returns its stroke id prefix `<me>/<sender_sequence>`. */
  async function seal(content) {
    let seq = ++mockSeq, envelope_hash = null
    if (real) ({ seq, envelope_hash } = await client.sendStrokes({ timeline_id, ...content }))
    st.apply({ sender_device_id: me, sender_sequence: seq, envelope_hash, content })
    return `${me}/${seq}`
  }
  /** A flush: at once for a finished change (pen up, a move, an erase), within FLUSH_MS while a stroke is drawn. */
  function soon(now = true) {
    lastOp = Date.now()
    if (now && flushTimer) { clearTimeout(flushTimer); flushTimer = 0 }
    flushTimer ||= setTimeout(flush, now ? 0 : FLUSH_MS)
    report()
  }
  async function flush() {
    clearTimeout(flushTimer); flushTimer = 0
    while (flushing) await flushing
    const ops = queue
    queue = []
    const live = [...lives.values()].filter(l => l.g.pts.length > l.sent * 2)
    if (!ops.length && !live.length) return report()
    flushing = send(ops, live).catch(e => { error = e.code ?? e.message; console.warn('canvas', e) })
    await flushing
    flushing = null
    if (st.applied >= SNAP_EVERY) snapSoon()
    report()
  }
  async function send(ops, live) {
    // 1. new shapes, and the strokes being drawn: their first piece, or the points since the last piece
    const entries = []   // [entry, version | null]
    for (const op of ops) if (op.add) entries.push([entryOf(op.add), op.ver])
    const pieces = (l, pts, pr) => (l.ver.wire ? [{ continues: l.ver.wire, ...encodePoints(pts, pr) }, null] : [entryOf({ tool: l.g.tool, pts, pr, color: l.g.color, size: l.g.size, z: l.g.z }), l.ver])
    for (const l of live) {
      const pts = l.g.pts.slice(l.sent * 2), pr = l.g.pen ? l.g.pr.slice(l.sent) : null
      l.sent += pts.length >> 1
      entries.push(pieces(l, pts, pr))
    }
    for (const op of ops) if (op.tail) entries.push(pieces(op.tail, op.pts, op.pr))
    for (let at = 0; at < entries.length;) {
      let end = at, size = 0
      while (end < entries.length && (end === at || size + JSON.stringify(entries[end][0]).length < ITEM_BYTES)) size += JSON.stringify(entries[end++][0]).length
      const prefix = await seal({ content_type: 'strokes', strokes: entries.slice(at, end).map(e => e[0]) })
      for (let i = at; i < end; i++) {
        const ver = entries[i][1]
        if (ver && !ver.wire) { ver.wire = `${prefix}/${i - at}`; if (ver.pad) padOf.set(ver.wire, ver.pad) }
      }
      at = end
    }
    // 2. moves, one item per offset
    const moves = new Map()
    for (const op of ops) if (op.move && op.ver?.wire) {
      const k = op.move.join(',')
      moves.set(k, [...(moves.get(k) ?? []), op.ver.wire])
    }
    for (const [k, ids] of moves) for (const part of chunks(ids)) await seal({ content_type: 'move', stroke_ids: part, offset: k.split(',').map(Number) })
    // 3. what is gone
    for (const how of ['erase', 'send_away']) {
      const ids = ops.filter(op => op.gone === how && op.ver?.wire).map(op => op.ver.wire)
      for (const part of chunks(ids)) await seal({ content_type: how, stroke_ids: part })
    }
    error = null
    if (real) mode = connection()
  }

  /** The version of what the pad knows as id: made or changed here (alias), else someone's stroke id. */
  const versionOf = id => alias.get(id) ?? { wire: id, pad: id }
  /** The pad changed. One call is one undo step of the pad; on the wire it becomes adds, moves and erasures. */
  function push(changes, how = 'erase') {
    for (const c of changes) {
      if (c.before && !c.after) { queue.push({ gone: how, ver: versionOf(c.before.id) }); alias.delete(c.before.id); continue }
      if (c.before && plainMove(c.before, c.after)) {
        const dx = r2(c.after.x - c.before.x), dy = r2(c.after.y - c.before.y)
        if (dx || dy) queue.push({ move: [dx, dy], ver: versionOf(c.before.id) })
        continue
      }
      const claimed = claims.get(c.after.id)   // a stroke whose pieces went out while it was drawn
      if (claimed && !c.before) { claims.delete(c.after.id); alias.set(c.after.id, claimed); continue }
      const was = c.before ? versionOf(c.before.id) : null
      const ver = { wire: null, pad: c.after.id }
      alias.set(c.after.id, ver)
      queue.push({ add: shapeOfRecord(c.after), ver })
      if (was) queue.push({ gone: 'erase', ver: was })
    }
    soon()
  }

  // ---- a stroke while it is drawn (g: the pad's gesture; its pts and pr grow) ----
  function live(g) {
    if (!lives.has(g)) lives.set(g, { g, ver: { wire: null, pad: null }, sent: 0 })
    soon(false)
  }
  /** The stroke ended and became element id: the rest of its points go out as its last piece. */
  function claim(g, id) {
    const l = lives.get(g)
    lives.delete(g)
    if (!l?.sent) return   // nothing went out yet: it goes as an ordinary new shape
    l.ver.pad = id
    if (l.ver.wire) padOf.set(l.ver.wire, id)
    claims.set(id, l.ver)
    const pts = g.pts.slice(l.sent * 2)
    if (pts.length) queue.push({ tail: l, pts, pr: g.pen ? g.pr.slice(l.sent) : null })
    soon()
  }
  /** A stroke that is not kept (a second finger came): what of it went out is erased. */
  function drop(g) {
    const l = lives.get(g)
    lives.delete(g)
    if (l?.sent) { queue.push({ gone: 'erase', ver: l.ver }); soon() }
  }

  // ---- snapshots ----
  function snapSoon() {
    if (!real) return
    clearTimeout(snapTimer)
    snapTimer = setTimeout(writeSnapshot, SNAP_IDLE_MS + Math.random() * 2000)
  }
  async function writeSnapshot() {
    if (Date.now() - lastOp < SNAP_IDLE_MS || flushing || queue.length || lives.size || client.model?.outbox?.length || connection() !== 'online') return snapSoon()
    try {
      const snap = st.snapshot(), applied = st.applied
      const attachment = await client.uploadAttachment(await packSnapshot(snap), { file_name: 'canvas.json.gz', media_type: 'application/gzip' })
      await client.setRegisters({ [`canvas_snapshot/${timeline_id}`]: { attachment, frontier: snap.frontier, last_envelope_number: snap.last_envelope_number, shapes: snap.shapes.length } })
      st.applied -= applied
    } catch (e) { console.warn('canvas snapshot', e) }
  }

  // ---- start: snapshot + tail, then live ----
  const off = client.on('change', ch => {
    if (ch.room && real && started) { mode = connection(); report() }
    const items = started && ch.items?.get?.(key)
    if (items?.length) take([...items].sort(byNumber))
  })
  // The pad's page goes (the Desk was left): it stops listening to the app's client at once.
  addEventListener('pagehide', () => off?.(), { once: true })
  const t0 = performance.now()
  if (real) {
    // The snapshot register and the tail need the room caught up (a fresh page paints before that).
    for (const until = Date.now() + 8000; client.model.room.connection !== 'live' && Date.now() < until;) await new Promise(r => setTimeout(r, 100))
    const snap = client.model.human?.canvas_snapshots?.get(timeline_id)
    if (snap?.attachment) {
      try {
        const got = await unpackSnapshot(await client.fetchAttachment(snap.attachment))
        st.load(got, { shapes: false })
        // in slices, so that a big canvas never holds the page for long (budget: no task over 200 ms on a slow phone)
        for (let i = 0; i < (got.shapes?.length ?? 0); i += SLICE) { st.addShapes(got.shapes.slice(i, i + SLICE)); await breath() }
      }
      catch (e) { console.warn('canvas: the snapshot is not readable, the whole timeline is read', e); st.load(null) }
    }
    const t1 = performance.now()
    let items = []
    try { items = (await client.loadTimelineAfter(key, st.last_envelope_number)).items ?? [] }
    catch (e) { error = e.code ?? e.message; items = [...(client.model.timelines.get(key)?.items.values() ?? [])] }
    started = true
    const before = new Set(st.shapes.keys())
    take(items.sort(byNumber))
    for (const id of before) if (!st.shapes.has(id)) before.delete(id)
    mode = connection()
    timing.snapshotMs = t1 - t0
    timing.tail = items.length
  }
  started = true
  timing.loadMs = performance.now() - t0
  report()

  return {
    state, push, live, claim, drop, real, timing,
    records: () => [...st.shapes.values()].map(recordOf),
    /** Every element, handed over in slices with a breath between (a big canvas on a slow phone). */
    async eachSlice(fn) {
      const all = [...st.shapes.values()]
      for (let i = 0; i < all.length; i += SLICE) { fn(all.slice(i, i + SLICE).map(recordOf)); if (i + SLICE < all.length) await breath() }
    },
    count: () => st.shapes.size,
    async putBlob(blob, meta = {}) {
      const ref = await client.uploadAttachment(blob, { file_name: meta.name || 'picture', media_type: blob.type, width: meta.nw, height: meta.nh })
      refs.set(ref.attachment_id, ref)
      return ref.attachment_id
    },
    async getBlob(id) {
      const ref = refs.get(id)
      if (!ref) return undefined
      try { return { id, blob: await client.attachmentBlob(ref) } } catch { return undefined }
    },
    /** The selection to a session: a picture and its words, as selection_sent into the session's conversation.
     *  to: the agent's device id. Throws a readable Error; never pretends. */
    async send({ to, text, png, ids }) {
      await flush()
      if (error) throw new Error(`The canvas could not be saved (${error}).`)
      const attachment = await client.uploadAttachment(dataUrlBytes(png), { file_name: 'selection.png', media_type: 'image/png' })
      const stroke_ids = ids.map(id => versionOf(id).wire).filter(Boolean)
      if (real) await client.sendStrokes({ timeline_id: `session/${to}`, content_type: 'selection_sent', recipient_device_id: to, ...(text ? { text } : {}), attachments: [attachment], stroke_ids })
      else await client.sendMessage({ agent_device_id: to, text: text || '', attachments: [{ ...attachment, kind: 'scribble' }] })
    },
    settled: async () => { await flush(); return !error },
    close() { off?.(); clearTimeout(snapTimer); if (queue.length || lives.size) flush() },
    snapshotNow: writeSnapshot,
  }
}
const timing = {}
/** A data: URL's bytes (fetch() of a data: URL is not allowed by the app's CSP). */
function dataUrlBytes(url) {
  const s = atob(url.slice(url.indexOf(',') + 1))
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}
