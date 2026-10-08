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

import { packPoints, unpackPoints, bake, STROKE_TOOLS } from './ink.ts'
import type { Ink } from './ink.ts'
import type { AttachmentRef } from './types.ts'
import { unb64u } from './crypto/zcrypto.mjs'
import { PALETTE } from './palette.ts'
export * from './ink.ts'       // one import for the app: the format, the shape and the palette
export * from './palette.ts'

// ---- the first format (before 8 October 2026, cdaaa64) ----
// Boards drawn before the PencilKit format are timeline items that stay on the hub for good; this reads them, so
// such a board is never shown empty. A first-format entry is { points, pressure?, style: { tool, color?, size? }, z?,
// group?, text?, wrap?, attachment?, nw?, nh?, mime?, name? }: points base64url in 1/8 unit, the first point as two
// int32 BE, then int16 BE deltas; pressure one byte per point; tool 'pen' | 'hl' | 'text' | 'voice' | 'sticky' |
// 'image'; colours were hex values. A piece of a first-format stroke ({ continues, points, pressure? }) carries the
// same encoding: it is read so when the stroke it continues was (Shape.legacy).
const LEGACY_Q = 8
/** The first format's points -> board units ([] when malformed). */
export function legacyPoints(text: unknown): number[] {
  let b: Uint8Array
  try { b = unb64u(typeof text === 'string' ? text : '') } catch { return [] }
  if (b.length < 8 || (b.length - 8) % 4) return []
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  let x = v.getInt32(0), y = v.getInt32(4)
  const out = [x / LEGACY_Q, y / LEGACY_Q]
  for (let o = 8; o < b.length; o += 4) { x += v.getInt16(o); y += v.getInt16(o + 2); out.push(x / LEGACY_Q, y / LEGACY_Q) }
  return out
}
function legacyPressure(text: unknown, n: number): number[] | null {
  if (typeof text !== 'string' || !text) return null
  let b: Uint8Array
  try { b = unb64u(text) } catch { return null }
  return b.length === n ? Array.from(b, v => v / 255) : null
}
/** The first format's ink: no times (8 ms apart), the pressure as the force that draws the same width (the old pen was
 *  half · (0.35 + 1.3 p) wide, the new one half · thickness(f)); without pressure 0.25, the pen's plain width. */
function legacyInk(e: Entry, t0 = 0): Ink | null {
  const pts = legacyPoints(e['points']), n = pts.length >> 1
  if (!n) return null
  const pr = legacyPressure(e['pressure'], n)
  return { pts, t: Array.from({ length: n }, (_, i) => t0 + i * 8), f: pr ? pr.map(p => Math.min(1, ((0.05 + 1.3 * p) / 1.4) ** 2)) : new Array(n).fill(0.25), az: null, al: null, sim: !pr }
}
const LEGACY_COLORS: Readonly<Record<string, string>> = Object.freeze({
  '#e03131': 'red', '#f08c00': 'orange', '#2f9e44': 'green', '#1971c2': 'blue', '#9c36b5': 'violet',
  '#ffd43b': 'yellow', '#69db7c': 'green', '#ff8cc6': 'pink', '#66c2ff': 'blue', '#ffa94d': 'orange',
})
function legacyColor(c: unknown, tool: string): string | null {
  if (typeof c !== 'string') return null
  const k = c.toLowerCase()
  if (Object.hasOwn(PALETTE, k)) return k
  if (LEGACY_COLORS[k]) return LEGACY_COLORS[k]!
  const set = tool === 'marker' ? 'marker' : 'pen'
  return Object.keys(PALETTE).find(t => PALETTE[t]![set]?.includes(k)) ?? null
}
/** Is this an entry of the first format? */
export const isLegacyEntry = (e: Entry | null | undefined): boolean => Boolean(e && e['tool'] == null && e['style'] && typeof e['style'] === 'object')
/** A first-format entry -> the shape it was (null when it is not one). */
function legacyShape(e: Entry, id: string, by: string): Shape | null {
  const style = e['style'] as Record<string, unknown>
  const tool = style['tool'] === 'hl' ? 'marker' : style['tool']
  if (typeof tool !== 'string' || !TOOLS.has(tool)) return null
  const s: Shape = { id, by, tool, z: num(e['z']), group: str(e['group'], 80), pts: [] }
  if (STROKES.has(tool)) {
    const ink = legacyInk(e)
    if (!ink) return null
    const w = num(style['size'], WIDTH[tool])
    return Object.assign(s, ink, { color: legacyColor(style['color'], tool), width: w > 0 && w <= 1000 ? w : WIDTH[tool], legacy: true })
  }
  const pts = legacyPoints(e['points'])
  if (WORDS.has(tool)) {
    if (pts.length < 2) return null
    return Object.assign(s, { pts: pts.slice(0, 2), text: String(e['text'] ?? '').slice(0, 20000), size: num(style['size'], 20), color: legacyColor(style['color'], 'pen'), wrap: Number.isFinite(e['wrap']) ? e['wrap'] : null })
  }
  if (pts.length < 4 || !e['attachment']?.attachment_id) return null
  return Object.assign(s, { pts: pts.slice(0, 4), attachment: e['attachment'], nw: num(e['nw'], 0), nh: num(e['nh'], 0), mime: str(e['mime'], 80), name: str(e['name']) })
}

// ---- shapes ----
// A shape is the board's own form of one element: { id, by, tool, pts (board units), z, group, … }.
//   stroke: pts = its points with the transform baked in, t, f, az, al, sim (ink.mjs), color, width
//   note:   pts = [x, y], text, size, color, wrap        picture: pts = [x0, y0, x1, y1], attachment, nw, nh, mime, name
/** A shape on the board (see above): every tool's fields, the ones its tool does not use left out. */
export interface Shape {
  id: string; by: string; tool: string; z: number; group: string | null
  pts: number[]
  t?: number[]; f?: number[]; az?: number[] | null; al?: number[] | null; sim?: boolean
  color?: string | null; width?: number
  text?: string; size?: number; wrap?: number | null
  attachment?: AttachmentRef; nw?: number; nh?: number; mime?: string | null; name?: string | null
  [field: string]: unknown
}
/** An element as a strokes item carries it (README "Scribble strokes"). */
export type Entry = Record<string, any>
/** One canvas item as the reducer takes it. */
export interface CanvasItem { sender_device_id: string; sender_sequence: number | null | undefined; envelope_hash?: string | null; envelope_number?: number | null; content?: Record<string, any> | null; sender_role?: string | null }
/** The snapshot's content. */
export interface CanvasSnapshot { v: number; shapes: Entry[]; frontier: Record<string, [number, string | null]>; last_envelope_number: number }

const STROKES = new Set<unknown>(STROKE_TOOLS)
const WORDS = new Set<unknown>(['text', 'voice', 'sticky'])   // the tools that carry text and wrap
const TOOLS = new Set<unknown>([...STROKES, ...WORDS, 'image'])
export const WIDTH: Readonly<Record<string, number>> = Object.freeze({ pen: 4, marker: 18 })   // a stroke's default width
const str = (v: unknown, max = 200): string | null => (typeof v === 'string' ? v.slice(0, max) : null)
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const r2 = (v: number): number => Math.round(v * 100) / 100
const nums = (v: unknown, n: number): number[] | null => (Array.isArray(v) && v.length === n && v.every(Number.isFinite) ? v as number[] : null)
export const isStroke = (s: { tool?: unknown } | null | undefined): boolean => STROKES.has(s?.tool)
export const inkOf = (s: Shape): Ink => ({ pts: s.pts, t: s.t!, f: s.f!, az: s.az ?? null, al: s.al ?? null, sim: Boolean(s.sim) })

/** A shape -> an Entry (for a strokes item, or for the snapshot with id and by added). */
export function entryOf(s: Shape): Entry {
  const e: Entry = { tool: s.tool }
  if (isStroke(s)) Object.assign(e, { color: s.color ?? (s.tool === 'marker' ? 'yellow' : 'ink'), width: r2(num(s.width, WIDTH[s.tool])), points: packPoints(inkOf(s)) })
  else if (WORDS.has(s.tool)) {
    Object.assign(e, { at: [r2(s.pts[0]!), r2(s.pts[1]!)], text: s.text ?? '', size: num(s.size, 20), color: s.color ?? 'ink' })
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
export function shapeOf(e: Entry | null | undefined, id: string, by: string): Shape | null {
  if (isLegacyEntry(e)) return legacyShape(e!, id, by)
  const tool = e?.['tool']
  if (!e || !TOOLS.has(tool)) return null
  const s: Shape = { id, by, tool, z: num(e['z']), group: str(e['group'], 80), pts: [] }
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
/** The snapshot's version. 3: written by a reader of the first format. A v2 snapshot may have been written while
 *  first-format items were dropped (8 October 2026, cdaaa64 until this fix): its frontier covers them, so they would
 *  never be read again. A client ignores a snapshot older than this and reads the whole timeline. */
export const SNAPSHOT_V = 3
export const snapshotUsable = (snap: { v?: unknown } | null | undefined): boolean => typeof snap?.v === 'number' && snap.v >= SNAPSHOT_V

export class CanvasState {
  shapes = new Map<string, Shape>()      // id -> shape
  erased = new Set<string>()             // ids that are gone for good (also ones not seen yet)
  frontier = new Map<string, [number, string | null]>()    // sender -> [sender_sequence, envelope_hash]
  last_envelope_number = 0
  applied = 0                            // items applied since the last snapshot (written or loaded)
  covered(sender: string, seq: number): boolean { return (this.frontier.get(sender)?.[0] ?? 0) >= seq }

  /** Apply one canvas item. item: { sender_device_id, sender_sequence, envelope_hash, envelope_number, content, sender_role? }.
   *  Returns the ids it changed (added, moved, continued, gone), or null when it was skipped. */
  apply(item: CanvasItem): Set<string> | null {
    const by = item.sender_device_id, seq = item.sender_sequence
    if (!by || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1 || this.covered(by, seq)) return null
    this.frontier.set(by, [seq, item.envelope_hash ?? null])
    if (item.envelope_number) this.last_envelope_number = Math.max(this.last_envelope_number, item.envelope_number)
    this.applied++
    const c: Record<string, any> = item.content ?? {}
    const changed = new Set<string>()
    const own = (id: unknown): id is string => typeof id === 'string' && id.startsWith(`${by}/`)
    // R1: agents erase and move only their own shapes; humans anything on the canvas.
    const may = (id: unknown): id is string => typeof id === 'string' && (item.sender_role !== 'agent' || own(id))
    if (c.content_type === 'strokes') {
      ;(Array.isArray(c['strokes']) ? c['strokes'] : []).forEach((e: Entry | null, i: number) => {
        if (e?.continues != null) {
          const head = this.shapes.get(e.continues)
          if (!own(e.continues) || !head || !isStroke(head)) return
          const more = head.legacy ? legacyInk(e, (head.t!.at(-1) ?? 0) + 8) : unpackPoints(e.points)
          if (!more) return
          head.pts.push(...more.pts); head.t!.push(...more.t); head.f!.push(...more.f)
          if (head.az && more.az) { head.az.push(...more.az); head.al!.push(...more.al!) } else head.az = head.al = null
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
      const [dx, dy] = (Array.isArray(c['offset']) ? c['offset'].map((v: unknown) => num(v)) : [0, 0]) as [number, number]   // (a one-number offset moves y by NaN, as it always did)
      if (dx || dy) for (const id of Array.isArray(c.stroke_ids) ? c.stroke_ids : []) {
        const s = may(id) && this.shapes.get(id)
        if (!s) continue
        for (let k = 0; k < s.pts.length; k += 2) { s.pts[k]! += dx; s.pts[k + 1]! += dy }
        changed.add(id)
      }
    }
    return changed
  }

  /** The snapshot's content (JSON-able): every shape, the frontier, the newest envelope number. */
  snapshot(): CanvasSnapshot {
    return { v: SNAPSHOT_V, shapes: [...this.shapes.values()].map(s => ({ id: s.id, by: s.by, ...entryOf(s) })), frontier: Object.fromEntries(this.frontier), last_envelope_number: this.last_envelope_number }
  }
  /** Shapes of a snapshot (in slices, for a big one: load(snap, { shapes: false }) first). */
  addShapes(entries: Iterable<Entry | null | undefined>): void {
    for (const e of entries) {
      const s = typeof e?.id === 'string' && typeof e.by === 'string' ? shapeOf(e, e.id, e.by) : null
      if (s) this.shapes.set(s.id, s)
    }
  }
  /** Start from a snapshot (a fresh client). Replaces what is here. */
  load(snap: Partial<CanvasSnapshot> | null | undefined, { shapes = true }: { shapes?: boolean } = {}): void {
    this.shapes.clear(); this.erased.clear(); this.frontier.clear()
    if (shapes) this.addShapes(snap?.shapes ?? [])
    for (const [k, v] of Object.entries(snap?.frontier ?? {}) as [string, unknown][]) if (Array.isArray(v) && Number.isSafeInteger(v[0])) this.frontier.set(k, [v[0], v[1] ?? null])
    this.last_envelope_number = num(snap?.last_envelope_number)
    this.applied = 0
  }
}

// ---- snapshot bytes: gzip'd JSON ----
async function pipe(bytes: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream))
  return new Uint8Array(await out.arrayBuffer())
}
export const packSnapshot = (snap: unknown): Promise<Uint8Array<ArrayBuffer>> => pipe(new TextEncoder().encode(JSON.stringify(snap)), new CompressionStream('gzip'))
export async function unpackSnapshot(bytes: Uint8Array<ArrayBuffer>): Promise<any> { return JSON.parse(new TextDecoder().decode(await pipe(bytes, new DecompressionStream('gzip')))) }

/** Split a list of ids into chunks that keep an item under the body limit (60 KB). */
export function chunks<T>(list: T[], size = 400): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}
