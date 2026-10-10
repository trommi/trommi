// ink.ts: one stroke's points on the wire and how a stroke is shaped (spec/v1.md 10.6), without DOM.
// Modelled on PencilKit (PKStroke, PKStrokePath, PKStrokePoint), so the iOS app maps a stroke 1:1, and the web app
// draws it the same way. spec/strokes.json holds sample strokes with their packed form.
//
// Board units: the Scribble Board has one fixed coordinate space, independent of screen, zoom and device. One unit is
// one CSS pixel at 100 % zoom on the web and one point at zoom scale 1 in PKCanvasView; x grows to the right, y down;
// the origin is where the board was first opened. On the wire every position is a whole number of 1/16 unit (Q),
// taken modulo 2^32 (quantum below).
//
// Ink (in memory): { pts: [x0, y0, x1, y1, …] (board units), t: [ms since the stroke began], f: [force 0..1],
//                    az: [azimuth, rad] | null, al: [altitude, rad] | null, sim: force was simulated (no pressure) }
// The points are the control points of a uniform cubic B-spline, as PKStrokePath's are; the ends are clamped (the
// first and the last point are repeated), so the line begins and ends exactly at them (sampleStroke).
//
// Packed (the `points` field, base64url of these bytes; the same bytes as trommi-core's `board_items::Ink`):
//   u8  flags        bit 0: every point carries azimuth and altitude; bit 1: the force is simulated;
//                    any other bit set: not readable
//   then per point, until the bytes end (1 to 10 000 points):
//   zigzag LEB128    x in 1/16 unit: the difference to the point before modulo 2^32 (the first point: to zero)
//   zigzag LEB128    y in 1/16 unit, the same
//   LEB128           t in ms: the first point since the stroke began (a piece of a stroke in progress starts later),
//                    then the time since the point before; the sum stays below 2^32
//   u8               force, 0..255 = 0..1
//   u8, u8           (flag 0) azimuth 0..255 = 0..2π (·2π/256), altitude 0..255 = 0..π/2 (·(π/2)/255)
// Every number is below 2^32 and written in the fewest bytes: a list of points has exactly one packed form, and
// anything else is refused as a whole.
import { b64u, unb64u } from './ids.ts'

/** A stroke's points in memory (see above): control points, times, forces, tilt, whether the force was simulated. */
export interface Ink { pts: number[]; t: number[]; f: number[]; az: number[] | null; al: number[] | null; sim: boolean }
/** An ink as a caller hands it to packPoints: times, forces and tilt may be missing. */
export interface InkIn { pts: number[]; t?: (number | undefined)[] | null | undefined; f?: (number | undefined)[] | null | undefined; az?: number[] | null | undefined; al?: number[] | null | undefined; sim?: boolean | undefined }
export type StrokeTool = 'pen' | 'marker'

export const Q = 16                         // 1/16 board unit
export const STROKE_TOOLS: readonly StrokeTool[] = Object.freeze(['pen', 'marker'] as const)   // the eraser is a tool, never a stroke (it erases whole strokes)
/** The most points of one stroke, and of one piece of a stroke in progress; more is refused as a whole. */
export const MAX_POINTS = 10_000
/** UITouch.maximumPossibleForce of an Apple Pencil: PKStrokePoint.force = f · PK_MAX_FORCE (WebKit's PointerEvent.pressure is the same ratio). */
export const PK_MAX_FORCE = 4.166666666666667
const TAU = Math.PI * 2, HALF_PI = Math.PI / 2
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
const fin = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

// ---- whole 1/16 units, varints ----
/** A position or offset in board units as its whole number of 1/16 unit, modulo 2^32 (an i32). */
export const quantum = (units: unknown): number => Math.round(fin(units) * Q) | 0
/** Two i32 quanta added modulo 2^32. */
export const wrapAdd = (a: number, b: number): number => (a + b) | 0
function putVar(out: number[], v: number): void { while (v >= 128) { out.push((v % 128) + 128); v = Math.floor(v / 128) } out.push(v) }
const zig = (d: number): number => ((d << 1) ^ (d >> 31)) >>> 0
const unzig = (v: number): number => (v >>> 1) ^ -(v & 1)

/** An ink -> the packed points (base64url). A point's time never runs backwards (it is held instead). More than
 *  MAX_POINTS points pack into something no reader takes: the caller cuts a stroke before that. */
export function packPoints(ink: InkIn): string {
  const p = ink.pts, n = p.length >> 1
  const az = ink.az, al = ink.al
  const tilt = Boolean(az && al && az.length >= n && al.length >= n)
  const out = [(tilt ? 1 : 0) | (ink.sim ? 2 : 0)]
  let lx = 0, ly = 0, lt = 0
  for (let i = 0; i < n; i++) {
    const x = quantum(p[2 * i]), y = quantum(p[2 * i + 1])
    const t = Math.min(0xffffffff, Math.max(i ? lt : 0, Math.round(fin(ink.t?.[i] ?? lt))))
    putVar(out, zig((x - lx) | 0)); putVar(out, zig((y - ly) | 0)); putVar(out, t - lt)
    out.push(Math.round(clamp(fin(ink.f?.[i] ?? 0.5), 0, 1) * 255))
    if (tilt) {
      const a = ((fin(az![i]) % TAU) + TAU) % TAU
      out.push(Math.round((a / TAU) * 256) % 256, Math.round((clamp(fin(al![i]), 0, HALF_PI) / HALF_PI) * 255))
    }
    lx = x; ly = y; lt = t
  }
  return b64u(Uint8Array.from(out))
}

/** The packed points -> an ink, or null when they are not the one packed form of 1 to MAX_POINTS points. */
export function unpackPoints(text: unknown): Ink | null {
  let b: Uint8Array
  try { b = unb64u(typeof text === 'string' ? text : '') } catch { return null }
  if (!b.length || b[0]! & ~3) return null
  const tilt = (b[0]! & 1) === 1
  const ink: Ink = { pts: [], t: [], f: [], az: tilt ? [] : null, al: tilt ? [] : null, sim: (b[0]! & 2) === 2 }
  let o = 1, x = 0, y = 0, t = 0
  // One LEB128 number below 2^32 in its shortest form.
  const v = () => {
    let r = 0, m = 1
    for (let k = 0; k < 5; k++) {
      if (o >= b.length) throw 0
      const c = b[o++]!
      r += (c & 127) * m
      if (c < 128) { if ((c === 0 && k > 0) || r > 0xffffffff) throw 0; return r }
      m *= 128
    }
    throw 0
  }
  try {
    while (o < b.length) {
      if (ink.t.length >= MAX_POINTS) return null
      x = (x + unzig(v())) | 0; y = (y + unzig(v())) | 0; t += v()
      if (t > 0xffffffff || o + (tilt ? 3 : 1) > b.length) return null
      ink.pts.push(x / Q, y / Q); ink.t.push(t); ink.f.push(Math.round((b[o++]! / 255) * 1000) / 1000)
      if (tilt) { ink.az!.push((b[o++]! / 256) * TAU); ink.al!.push((b[o++]! / 255) * HALF_PI) }
    }
  } catch { return null }
  return ink.t.length ? ink : null
}

// ---- force ----
/** How thick the pen is at a force, as a factor of its width (0.25, a light hand, is 1). PKStrokePoint.size of a pen
 *  point is width · thickness(f) in both directions; a marker point is width, whatever the force. */
export const thickness = (f: unknown): number => 0.3 + 1.4 * Math.sqrt(clamp(fin(f), 0, 1))
/** A force for an input without pressure (mouse, finger), from its speed in screen px per ms: slow is a little
 *  heavier, fast is lighter, eased so it swells and thins as a pen does. prev: the force before (null at the start). */
export function forceFromSpeed(prev: number | null | undefined, speed: unknown): number {
  const target = clamp(0.36 - 0.075 * fin(speed), 0.07, 0.36)
  return prev == null ? 0.2 : prev + (target - prev) * 0.3
}
/** Pointer Events tiltX/tiltY (degrees) -> { az, al } in radians, as PencilKit measures them (azimuth 0 along +x,
 *  turning towards +y; altitude π/2 upright, 0 flat on the paper). */
export function anglesOfTilt(tiltX: unknown = 0, tiltY: unknown = 0): { az: number; al: number } {
  const tx = (clamp(fin(tiltX), -89, 89) * Math.PI) / 180, ty = (clamp(fin(tiltY), -89, 89) * Math.PI) / 180
  if (!tx && !ty) return { az: 0, al: HALF_PI }
  const X = Math.tan(tx), Y = Math.tan(ty)
  return { az: (Math.atan2(Y, X) + TAU) % TAU, al: Math.atan(1 / Math.hypot(X, Y)) }
}

// ---- shape ----
/** The stroke's line as samples [x, y, r, …] (r: half the ink's width there), every ~step units along the
 *  clamped uniform cubic B-spline of its points; force follows the same spline. A marker has one radius.
 *  from, to: only the spans from..to of the n + 1 (a stroke being drawn is sampled piece by piece: with n points
 *  the spans 0..n-2 no longer change when a point is added, only the last two do); a piece begins where the span
 *  before it ends. */
export function sampleStroke(pts: number[], f: readonly (number | undefined)[] | null | undefined, { tool = 'pen', width = 4, step = 1, from = 0, to = Infinity }: { tool?: string; width?: number; step?: number; from?: number; to?: number } = {}): number[] {
  const n = pts.length >> 1
  if (!n) return []
  const half = width / 2
  const rAt = (i: number): number => (tool === 'marker' ? half : half * thickness(f?.[i] ?? 0.25))
  if (n === 1) return [pts[0]!, pts[1]!, rAt(0)]
  const P = (j: number): number => Math.min(n - 1, Math.max(0, j - 2))   // the padded control points: P0 P0 P0 P1 … Pn-1 Pn-1 Pn-1
  const out = [pts[0]!, pts[1]!, rAt(0)]
  if (from > 0) {   // the span's own beginning (t = 0): 1/6, 4/6, 1/6 of its first three control points
    const a = P(from), b = P(from + 1), c = P(from + 2)
    out[0] = (pts[2 * a]! + 4 * pts[2 * b]! + pts[2 * c]!) / 6; out[1] = (pts[2 * a + 1]! + 4 * pts[2 * b + 1]! + pts[2 * c + 1]!) / 6; out[2] = (rAt(a) + 4 * rAt(b) + rAt(c)) / 6
  }
  for (let s = Math.max(0, from); s <= Math.min(n, to); s++) {
    const i0 = P(s), i1 = P(s + 1), i2 = P(s + 2), i3 = P(s + 3)
    const x0 = pts[2 * i0]!, y0 = pts[2 * i0 + 1]!, x1 = pts[2 * i1]!, y1 = pts[2 * i1 + 1]!, x2 = pts[2 * i2]!, y2 = pts[2 * i2 + 1]!, x3 = pts[2 * i3]!, y3 = pts[2 * i3 + 1]!
    const r0 = rAt(i0), r1 = rAt(i1), r2 = rAt(i2), r3 = rAt(i3)
    const len = Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2)
    const steps = Math.max(1, Math.min(64, Math.ceil(len / 3 / step)))
    for (let k = 1; k <= steps; k++) {
      const t = k / steps, t2 = t * t, t3 = t2 * t, u = 1 - t
      const b0 = (u * u * u) / 6, b1 = (3 * t3 - 6 * t2 + 4) / 6, b2 = (-3 * t3 + 3 * t2 + 3 * t + 1) / 6, b3 = t3 / 6
      const x = b0 * x0 + b1 * x1 + b2 * x2 + b3 * x3, y = b0 * y0 + b1 * y1 + b2 * y2 + b3 * y3
      const m = out.length
      if (Math.abs(x - out[m - 3]!) + Math.abs(y - out[m - 2]!) < step * 0.25 && !(s === n && k === steps)) continue
      out.push(x, y, b0 * r0 + b1 * r1 + b2 * r2 + b3 * r3)
    }
  }
  return out
}
