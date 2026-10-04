// The canvas on the wire (trommi-hub README "Canvases", Security rules R1, R2, R9), without DOM and without the core:
// the shapes as timeline items carry them, the reducer that turns a canvas timeline into shapes, and the snapshot.
// canvas.js drives it with the core; node pad/wire-test.mjs tests it.
//
// A canvas item's body (content_type and its fields as in the README):
//   strokes    { strokes: [Entry] }           new shapes, or a piece of a stroke still being drawn (~ every 150 ms)
//   erase      { stroke_ids }                 gone (erase wins over everything, for good)
//   send_away  { stroke_ids }                 gone because it was sent to a session ("what was sent leaves the canvas")
//   move       { stroke_ids, offset: [dx, dy] }   offsets add up
// Entry = { points, pressure?, style: { tool, color?, size? }, z?, group?, text?, wrap?, attachment?, nw?, nh?, mime?, name?, continues? }
//   tool 'pen' | 'hl': a stroke; points: the line (R9: base64url, 1/8 px, the first point absolute as two int32 BE,
//                      then int16 BE deltas); pressure: base64url, one byte per point
//   tool 'text' | 'voice': a note; points: the top left corner; text, wrap, style.size, style.color
//   tool 'image': a picture; points: top left and bottom right; attachment: the README attachment reference
//   continues: the stroke id of the first piece of the same stroke (only from the same sender): these points go on it
// A stroke id is never read from a body: every receiver derives it (R1) as `<sender_device_id>/<sender_sequence>/<index>`,
// so nobody can name, continue or collide with another member's shapes; agents may erase and move only their own.
//
// Merging: adding is once per id, erasing wins, moving adds offsets. All three commute, so the canvas is the same
// whatever order the items arrive in (no causal order is needed, R2), and an item is applied at most once: each
// sender's items come in its sender_sequence order, and the frontier (sender -> [sequence, envelope_hash]) says up to
// where a sender is applied. The snapshot carries that frontier; items it covers are skipped.

const Q = 8   // 1/8 px

// ---- base64url ----
export function b64u(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function unb64u(text) {
  const s = atob(String(text).replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

// ---- points (R9) ----
/** World points [x0, y0, x1, y1, …] -> base64url. A jump wider than an int16 delta (4096 px) is split into steps;
 *  pr (pressure per point) is stretched along. Returns { points, pressure? }. */
export function encodePoints(pts, pr = null) {
  const n = pts.length >> 1
  if (!n) return { points: '' }
  const q = v => Math.round(v * Q)
  const xs = [q(pts[0])], ys = [q(pts[1])], ps = pr ? [pr[0]] : null
  for (let i = 1; i < n; i++) {
    const x = q(pts[2 * i]), y = q(pts[2 * i + 1])
    const lx = xs[xs.length - 1], ly = ys[ys.length - 1]
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x - lx), Math.abs(y - ly)) / 32767))
    for (let k = 1; k <= steps; k++) {
      xs.push(Math.round(lx + ((x - lx) * k) / steps)); ys.push(Math.round(ly + ((y - ly) * k) / steps))
      if (ps) ps.push(pr[i])
    }
  }
  const m = xs.length
  const buf = new DataView(new ArrayBuffer(8 + 4 * (m - 1)))
  buf.setInt32(0, xs[0]); buf.setInt32(4, ys[0])
  for (let i = 1; i < m; i++) { buf.setInt16(8 + 4 * (i - 1), xs[i] - xs[i - 1]); buf.setInt16(10 + 4 * (i - 1), ys[i] - ys[i - 1]) }
  const out = { points: b64u(new Uint8Array(buf.buffer)) }
  if (ps) out.pressure = b64u(Uint8Array.from(ps, p => Math.max(0, Math.min(255, Math.round((p ?? 0.5) * 255)))))
  return out
}
/** base64url -> world points (numbers). Malformed input gives []. */
export function decodePoints(text) {
  let bytes
  try { bytes = unb64u(text ?? '') } catch { return [] }
  if (bytes.length < 8 || (bytes.length - 8) % 4) return []
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let x = v.getInt32(0), y = v.getInt32(4)
  const out = [x / Q, y / Q]
  for (let o = 8; o < bytes.length; o += 4) { x += v.getInt16(o); y += v.getInt16(o + 2); out.push(x / Q, y / Q) }
  return out
}
export function decodePressure(text, n) {
  if (!text) return null
  let bytes
  try { bytes = unb64u(text) } catch { return null }
  if (bytes.length !== n) return null
  return Array.from(bytes, b => Math.round((b / 255) * 100) / 100)
}

// ---- shapes ----
// A shape is the canvas's own form of one element: { id, by, tool, pts (world), pr, color, size, z, group, text, wrap,
// attachment, nw, nh, mime, name }. Strokes keep every point in world units; a note and a picture keep their corners.
const TOOLS = new Set(['pen', 'hl', 'text', 'voice', 'image'])
const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : null)
const num = (v, d = 0) => (Number.isFinite(v) ? v : d)

/** A shape -> an Entry (for a strokes item, or for the snapshot with id and by added). */
export function entryOf(s) {
  const e = { ...encodePoints(s.pts, s.pr), style: { tool: s.tool } }
  if (s.color != null) e.style.color = s.color
  if (s.size != null) e.style.size = s.size
  if (s.z != null) e.z = s.z
  if (s.group) e.group = s.group
  if (s.tool === 'text' || s.tool === 'voice') { e.text = s.text ?? ''; if (s.wrap != null) e.wrap = s.wrap }
  if (s.tool === 'image') { e.attachment = s.attachment; for (const k of ['nw', 'nh', 'mime', 'name']) if (s[k] != null) e[k] = s[k] }
  return e
}
/** An Entry -> a shape (null when it is not one this app can show). */
export function shapeOf(e, id, by) {
  const tool = e?.style?.tool
  if (!TOOLS.has(tool)) return null
  const pts = decodePoints(e.points)
  if (!pts.length || (tool === 'image' && pts.length < 4)) return null
  const s = { id, by, tool, pts, pr: tool === 'pen' ? decodePressure(e.pressure, pts.length >> 1) : null, color: str(e.style.color, 40), size: num(e.style.size, tool === 'hl' ? 18 : 4), z: num(e.z), group: str(e.group, 80) }
  if (tool === 'text' || tool === 'voice') { s.text = String(e.text ?? '').slice(0, 20000); s.wrap = Number.isFinite(e.wrap) ? e.wrap : null }
  if (tool === 'image') {
    if (!e.attachment?.attachment_id) return null
    s.attachment = e.attachment
    s.nw = num(e.nw, 0); s.nh = num(e.nh, 0); s.mime = str(e.mime, 80); s.name = str(e.name)
  }
  return s
}

// ---- the reducer ----
export class CanvasState {
  constructor() {
    this.shapes = new Map()      // id -> shape
    this.erased = new Set()      // ids that are gone for good (also ones not seen yet)
    this.frontier = new Map()    // sender -> [sender_sequence, envelope_hash]
    this.last_envelope_number = 0
    this.applied = 0             // items applied since the last snapshot (written or loaded)
  }
  covered(sender, seq) { return (this.frontier.get(sender)?.[0] ?? 0) >= seq }

  /** Apply one canvas item. item: { sender_device_id, sender_sequence, envelope_hash, envelope_number, content, sender_role? }.
   *  Returns the ids it changed (added, moved, continued, gone), or null when it was skipped. */
  apply(item) {
    const by = item.sender_device_id, seq = item.sender_sequence
    if (!by || !Number.isSafeInteger(seq) || seq < 1 || this.covered(by, seq)) return null
    this.frontier.set(by, [seq, item.envelope_hash ?? null])
    if (item.envelope_number) this.last_envelope_number = Math.max(this.last_envelope_number, item.envelope_number)
    this.applied++
    const c = item.content ?? {}
    const changed = new Set()
    const own = id => typeof id === 'string' && id.startsWith(`${by}/`)
    // R1: agents erase and move only their own shapes; humans anything on the canvas.
    const may = id => typeof id === 'string' && (item.sender_role !== 'agent' || own(id))
    if (c.content_type === 'strokes') {
      ;(Array.isArray(c.strokes) ? c.strokes : []).forEach((e, i) => {
        if (e?.continues != null) {
          const head = this.shapes.get(e.continues)
          if (!own(e.continues) || !head || (head.tool !== 'pen' && head.tool !== 'hl')) return
          const more = decodePoints(e.points)
          if (!more.length) return
          if (head.pr) { const p = decodePressure(e.pressure, more.length >> 1); head.pr.push(...(p ?? new Array(more.length >> 1).fill(0.5))) }
          for (const v of more) head.pts.push(v)
          changed.add(head.id)
          return
        }
        const id = `${by}/${seq}/${i}`
        if (this.erased.has(id) || this.shapes.has(id)) return
        const s = shapeOf(e, id, by)
        if (s) { this.shapes.set(id, s); changed.add(id) }
      })
    } else if (c.content_type === 'erase' || c.content_type === 'send_away') {
      for (const id of Array.isArray(c.stroke_ids) ? c.stroke_ids : []) {
        if (!may(id)) continue
        this.erased.add(id)
        if (this.shapes.delete(id)) changed.add(id)
      }
    } else if (c.content_type === 'move') {
      const [dx, dy] = Array.isArray(c.offset) ? c.offset.map(v => num(v)) : [0, 0]
      if (dx || dy) for (const id of Array.isArray(c.stroke_ids) ? c.stroke_ids : []) {
        const s = may(id) && this.shapes.get(id)
        if (!s) continue
        for (let k = 0; k < s.pts.length; k += 2) { s.pts[k] += dx; s.pts[k + 1] += dy }
        changed.add(id)
      }
    }
    return changed
  }

  /** The snapshot's content (JSON-able): every shape, the frontier, the newest envelope number. */
  snapshot() {
    return { v: 1, shapes: [...this.shapes.values()].map(s => ({ id: s.id, by: s.by, ...entryOf(s) })), frontier: Object.fromEntries(this.frontier), last_envelope_number: this.last_envelope_number }
  }
  /** Shapes of a snapshot (in slices, for a big one: load(snap, { shapes: false }) first). */
  addShapes(entries) {
    for (const e of entries) {
      const s = typeof e?.id === 'string' && typeof e.by === 'string' ? shapeOf(e, e.id, e.by) : null
      if (s) this.shapes.set(s.id, s)
    }
  }
  /** Start from a snapshot (a fresh client). Replaces what is here. */
  load(snap, { shapes = true } = {}) {
    this.shapes.clear(); this.erased.clear(); this.frontier.clear()
    if (shapes) this.addShapes(snap?.shapes ?? [])
    for (const [k, v] of Object.entries(snap?.frontier ?? {})) if (Array.isArray(v) && Number.isSafeInteger(v[0])) this.frontier.set(k, [v[0], v[1] ?? null])
    this.last_envelope_number = num(snap?.last_envelope_number)
    this.applied = 0
  }
}

// ---- snapshot bytes: gzip'd JSON ----
async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream))
  return new Uint8Array(await out.arrayBuffer())
}
export const packSnapshot = snap => pipe(new TextEncoder().encode(JSON.stringify(snap)), new CompressionStream('gzip'))
export async function unpackSnapshot(bytes) { return JSON.parse(new TextDecoder().decode(await pipe(bytes, new DecompressionStream('gzip')))) }

/** Split a list of ids into chunks that keep an item under the body limit (60 KB). */
export function chunks(list, size = 400) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}
