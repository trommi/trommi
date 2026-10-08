// The Scribble Board on the wire (README "Scribble strokes", Security rules R1, R2, R9), without DOM: the shapes as
// timeline items carry them, the reducer that turns a scribble timeline into shapes, and the snapshot. The app's
// Scribble Board (app/web/public/whiteboard.mjs openCanvas) drives it with the client core; ink.mjs packs a stroke's
// points, palette.mjs names its colours.
//
// A scribble item's body (content_type and its fields as in the README):
//   strokes    { strokes: [Entry] }           new shapes, or a piece of a stroke still being drawn (~ every 150 ms)
//   erase      { stroke_ids }                 gone (erase wins over everything, for good)
//   send_away  { stroke_ids }                 gone because it was sent to a session ("what was sent leaves the board")
//   move       { stroke_ids, offset: [dx, dy] }   offsets add up (a stroke: onto its transform's tx, ty)
// Entry, by tool (board units, colour tokens):
//   stroke  { tool: 'pen' | 'marker', color, width, points, transform?: [a, b, c, d, tx, ty], z?, group? }
//           points: ink.mjs packPoints (x, y, t, force, azimuth?, altitude? per point), as a PKStroke
//   piece   { continues: <stroke id>, points }   more points of a stroke still being drawn (only from its sender)
//   note    { tool: 'text' | 'voice' | 'sticky', at: [x, y], text, size, color, wrap?, z?, group? }   (at: top left)
//   picture { tool: 'image', rect: [x0, y0, x1, y1], attachment, nw?, nh?, mime?, name?, z?, group? }
// A stroke id is never read from a body: every receiver derives it (R1) as `<sender_device_id>/<sender_sequence>/<index>`,
// so nobody can name, continue or collide with another member's shapes; agents may erase and move only their own.
//
// Merging: adding is once per id, erasing wins, moving adds offsets. All three commute, so the board is the same
// whatever order the items arrive in (no causal order is needed, R2), and an item is applied at most once: each
// sender's items come in its sender_sequence order, and the frontier (sender -> [sequence, envelope_hash]) says up to
// where a sender is applied. The snapshot carries that frontier; items it covers are skipped.

import { packPoints, unpackPoints, bake, STROKE_TOOLS } from './ink.mjs'
export * from './ink.mjs'       // one import for the app: the format, the shape and the palette
export * from './palette.mjs'

// ---- shapes ----
// A shape is the board's own form of one element: { id, by, tool, pts (board units), z, group, … }.
//   stroke: pts = its points with the transform baked in, t, f, az, al, sim (ink.mjs), color, width
//   note:   pts = [x, y], text, size, color, wrap        picture: pts = [x0, y0, x1, y1], attachment, nw, nh, mime, name
const STROKES = new Set(STROKE_TOOLS)
const WORDS = new Set(['text', 'voice', 'sticky'])   // the tools that carry text and wrap
const TOOLS = new Set([...STROKES, ...WORDS, 'image'])
export const WIDTH = Object.freeze({ pen: 4, marker: 18 })   // a stroke's default width
const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : null)
const num = (v, d = 0) => (Number.isFinite(v) ? v : d)
const r2 = v => Math.round(v * 100) / 100
const nums = (v, n) => (Array.isArray(v) && v.length === n && v.every(Number.isFinite) ? v : null)
export const isStroke = s => STROKES.has(s?.tool)
export const inkOf = s => ({ pts: s.pts, t: s.t, f: s.f, az: s.az ?? null, al: s.al ?? null, sim: Boolean(s.sim) })

/** A shape -> an Entry (for a strokes item, or for the snapshot with id and by added). */
export function entryOf(s) {
  const e = { tool: s.tool }
  if (isStroke(s)) Object.assign(e, { color: s.color ?? (s.tool === 'marker' ? 'yellow' : 'ink'), width: r2(num(s.width, WIDTH[s.tool])), points: packPoints(inkOf(s)) })
  else if (WORDS.has(s.tool)) {
    Object.assign(e, { at: [r2(s.pts[0]), r2(s.pts[1])], text: s.text ?? '', size: num(s.size, 20), color: s.color ?? 'ink' })
    if (s.wrap != null) e.wrap = s.wrap
  } else if (s.tool === 'image') {
    Object.assign(e, { rect: s.pts.slice(0, 4).map(r2), attachment: s.attachment })
    for (const k of ['nw', 'nh', 'mime', 'name']) if (s[k] != null) e[k] = s[k]
  }
  if (s.z != null) e.z = s.z
  if (s.group) e.group = s.group
  return e
}
/** An Entry -> a shape (null when it is not one this app can show). */
export function shapeOf(e, id, by) {
  const tool = e?.tool
  if (!TOOLS.has(tool)) return null
  const s = { id, by, tool, z: num(e.z), group: str(e.group, 80) }
  if (STROKES.has(tool)) {
    const got = unpackPoints(e.points)
    if (!got) return null
    const { ink, scale } = bake(got, e.transform)
    const w = num(e.width, WIDTH[tool])
    return Object.assign(s, ink, { color: str(e.color, 40), width: (w > 0 && w <= 1000 ? w : WIDTH[tool]) * scale })
  }
  if (WORDS.has(tool)) {
    const at = nums(e.at, 2)
    if (!at) return null
    return Object.assign(s, { pts: [...at], text: String(e.text ?? '').slice(0, 20000), size: num(e.size, 20), color: str(e.color, 40), wrap: Number.isFinite(e.wrap) ? e.wrap : null })
  }
  const rect = nums(e.rect, 4)
  if (!rect || !e.attachment?.attachment_id) return null
  return Object.assign(s, { pts: [...rect], attachment: e.attachment, nw: num(e.nw, 0), nh: num(e.nh, 0), mime: str(e.mime, 80), name: str(e.name) })
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
          if (!own(e.continues) || !head || !isStroke(head)) return
          const more = unpackPoints(e.points)
          if (!more) return
          head.pts.push(...more.pts); head.t.push(...more.t); head.f.push(...more.f)
          if (head.az && more.az) { head.az.push(...more.az); head.al.push(...more.al) } else head.az = head.al = null
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
    return { v: 2, shapes: [...this.shapes.values()].map(s => ({ id: s.id, by: s.by, ...entryOf(s) })), frontier: Object.fromEntries(this.frontier), last_envelope_number: this.last_envelope_number }
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
