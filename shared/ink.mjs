// ink.mjs: one stroke's points on the wire and how a stroke is shaped (README "Scribble strokes"), without DOM.
// Modelled on PencilKit (PKStroke, PKStrokePath, PKStrokePoint), so the iOS app maps a stroke 1:1, and the web app
// draws it the same way. dev/interop/fixtures/strokes.json holds sample strokes with their packed form.
//
// Board units: the Scribble Board has one fixed coordinate space, independent of screen, zoom and device. One unit is
// one CSS pixel at 100 % zoom on the web and one point at zoom scale 1 in PKCanvasView; x grows to the right, y down;
// the origin is where the board was first opened (any number is fine, the board is endless).
//
// Ink (in memory): { pts: [x0, y0, x1, y1, …] (board units), t: [ms since the stroke began], f: [force 0..1],
//                    az: [azimuth, rad] | null, al: [altitude, rad] | null, sim: force was simulated (no pressure) }
// The points are the control points of a uniform cubic B-spline, as PKStrokePath's are; the ends are clamped (the
// first and the last point are repeated), so the line begins and ends exactly at them (sampleStroke).
//
// Packed (the `points` field, base64url of these bytes):
//   u8  flags        bit 0: every point carries azimuth and altitude; bit 1: the force is simulated;
//                    any other bit set: a newer format, the stroke is not readable here
//   then per point, until the bytes end:
//   zigzag LEB128    x in 1/16 unit: the first point absolute, then the difference to the point before
//   zigzag LEB128    y in 1/16 unit, the same
//   LEB128           t in ms: the first point since the stroke began (a piece that continues a stroke starts later),
//                    then the time since the point before
//   u8               force, 0..255 = 0..1
//   u8, u8           (flag 0) azimuth 0..255 = 0..2π (·2π/256), altitude 0..255 = 0..π/2 (·(π/2)/255)
import { b64u, unb64u } from './crypto/zcrypto.mjs'

export const Q = 16                         // 1/16 board unit
export const STROKE_TOOLS = Object.freeze(['pen', 'marker'])   // the eraser is a tool, never a stroke (it erases whole strokes)
export const MAX_POINTS = 50_000            // per packed piece; more is refused as a whole
/** UITouch.maximumPossibleForce of an Apple Pencil: PKStrokePoint.force = f · PK_MAX_FORCE (WebKit's PointerEvent.pressure is the same ratio). */
export const PK_MAX_FORCE = 4.166666666666667
const TAU = Math.PI * 2, HALF_PI = Math.PI / 2
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const fin = v => (Number.isFinite(v) ? v : 0)

// ---- varints (Number arithmetic, safe up to 2^53) ----
function putVar(out, v) { while (v >= 128) { out.push((v % 128) + 128); v = Math.floor(v / 128) } out.push(v) }
const zig = v => (v >= 0 ? 2 * v : -2 * v - 1)
const unzig = v => (v % 2 ? -(v + 1) / 2 : v / 2)

/** An ink -> the packed points (base64url). A point's time never runs backwards (it is held instead). */
export function packPoints(ink) {
  const p = ink.pts, n = p.length >> 1
  const tilt = Boolean(ink.az && ink.al && ink.az.length >= n && ink.al.length >= n)
  const out = [(tilt ? 1 : 0) | (ink.sim ? 2 : 0)]
  let lx = 0, ly = 0, lt = 0
  for (let i = 0; i < n; i++) {
    const x = Math.round(fin(p[2 * i]) * Q), y = Math.round(fin(p[2 * i + 1]) * Q)
    const t = Math.max(i ? lt : 0, Math.round(fin(ink.t?.[i] ?? lt)))
    putVar(out, zig(x - lx)); putVar(out, zig(y - ly)); putVar(out, t - lt)
    out.push(Math.round(clamp(fin(ink.f?.[i] ?? 0.5), 0, 1) * 255))
    if (tilt) {
      const az = ((fin(ink.az[i]) % TAU) + TAU) % TAU
      out.push(Math.round((az / TAU) * 256) % 256, Math.round((clamp(fin(ink.al[i]), 0, HALF_PI) / HALF_PI) * 255))
    }
    lx = x; ly = y; lt = t
  }
  return b64u(Uint8Array.from(out))
}

/** The packed points -> an ink, or null when they are not readable (malformed, a newer format, too many). */
export function unpackPoints(text) {
  let b
  try { b = unb64u(typeof text === 'string' ? text : '') } catch { return null }
  if (!b.length || b[0] & ~3) return null
  const tilt = (b[0] & 1) === 1
  const ink = { pts: [], t: [], f: [], az: tilt ? [] : null, al: tilt ? [] : null, sim: (b[0] & 2) === 2 }
  let o = 1, x = 0, y = 0, t = 0
  const v = () => {
    let r = 0, m = 1
    for (let k = 0; k < 8; k++) {
      if (o >= b.length) throw 0
      const c = b[o++]
      r += (c & 127) * m
      if (c < 128) return r
      m *= 128
    }
    throw 0
  }
  try {
    while (o < b.length) {
      if (ink.t.length >= MAX_POINTS) return null
      x += unzig(v()); y += unzig(v()); t += v()
      if (o + (tilt ? 3 : 1) > b.length) return null
      ink.pts.push(x / Q, y / Q); ink.t.push(t); ink.f.push(Math.round((b[o++] / 255) * 1000) / 1000)
      if (tilt) { ink.az.push((b[o++] / 256) * TAU); ink.al.push((b[o++] / 255) * HALF_PI) }
    }
  } catch { return null }
  return ink.t.length ? ink : null
}

/** A stroke's transform ([a, b, c, d, tx, ty], as CGAffineTransform: x' = a·x + c·y + tx, y' = b·x + d·y + ty)
 *  baked into its ink: the points moved, the azimuth turned. Returns { ink, scale } (scale multiplies the width). */
export function bake(ink, m) {
  if (!Array.isArray(m) || m.length !== 6 || !m.every(Number.isFinite)) return { ink, scale: 1 }
  const [a, b, c, d, tx, ty] = m
  const pts = ink.pts.slice()
  for (let i = 0; i < pts.length; i += 2) { const x = pts[i], y = pts[i + 1]; pts[i] = a * x + c * y + tx; pts[i + 1] = b * x + d * y + ty }
  const turn = Math.atan2(b, a)
  return { ink: { ...ink, pts, az: ink.az && turn ? ink.az.map(v => (((v + turn) % TAU) + TAU) % TAU) : ink.az }, scale: Math.sqrt(Math.abs(a * d - b * c)) || 1 }
}

// ---- force ----
/** How thick the pen is at a force, as a factor of its width (0.25, a light hand, is 1). PKStrokePoint.size of a pen
 *  point is width · thickness(f) in both directions; a marker point is width, whatever the force. */
export const thickness = f => 0.3 + 1.4 * Math.sqrt(clamp(fin(f), 0, 1))
/** A force for an input without pressure (mouse, finger), from its speed in screen px per ms: slow is a little
 *  heavier, fast is lighter, eased so it swells and thins as a pen does. prev: the force before (null at the start). */
export function forceFromSpeed(prev, speed) {
  const target = clamp(0.36 - 0.075 * fin(speed), 0.07, 0.36)
  return prev == null ? 0.2 : prev + (target - prev) * 0.3
}
/** Pointer Events tiltX/tiltY (degrees) -> { az, al } in radians, as PencilKit measures them (azimuth 0 along +x,
 *  turning towards +y; altitude π/2 upright, 0 flat on the paper). */
export function anglesOfTilt(tiltX = 0, tiltY = 0) {
  const tx = (clamp(fin(tiltX), -89, 89) * Math.PI) / 180, ty = (clamp(fin(tiltY), -89, 89) * Math.PI) / 180
  if (!tx && !ty) return { az: 0, al: HALF_PI }
  const X = Math.tan(tx), Y = Math.tan(ty)
  return { az: (Math.atan2(Y, X) + TAU) % TAU, al: Math.atan(1 / Math.hypot(X, Y)) }
}

// ---- shape ----
/** The stroke's line as samples [x, y, r, …] (r: half the ink's width there), every ~step units along the
 *  clamped uniform cubic B-spline of its points; force follows the same spline. A marker has one radius. */
export function sampleStroke(pts, f, { tool = 'pen', width = 4, step = 1 } = {}) {
  const n = pts.length >> 1
  if (!n) return []
  const half = width / 2
  const rAt = i => (tool === 'marker' ? half : half * thickness(f?.[i] ?? 0.25))
  if (n === 1) return [pts[0], pts[1], rAt(0)]
  const P = j => Math.min(n - 1, Math.max(0, j - 2))   // the padded control points: P0 P0 P0 P1 … Pn-1 Pn-1 Pn-1
  const out = [pts[0], pts[1], rAt(0)]
  for (let s = 0; s <= n; s++) {
    const i0 = P(s), i1 = P(s + 1), i2 = P(s + 2), i3 = P(s + 3)
    const x0 = pts[2 * i0], y0 = pts[2 * i0 + 1], x1 = pts[2 * i1], y1 = pts[2 * i1 + 1], x2 = pts[2 * i2], y2 = pts[2 * i2 + 1], x3 = pts[2 * i3], y3 = pts[2 * i3 + 1]
    const r0 = rAt(i0), r1 = rAt(i1), r2 = rAt(i2), r3 = rAt(i3)
    const len = Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2)
    const steps = Math.max(1, Math.min(64, Math.ceil(len / 3 / step)))
    for (let k = 1; k <= steps; k++) {
      const t = k / steps, t2 = t * t, t3 = t2 * t, u = 1 - t
      const b0 = (u * u * u) / 6, b1 = (3 * t3 - 6 * t2 + 4) / 6, b2 = (-3 * t3 + 3 * t2 + 3 * t + 1) / 6, b3 = t3 / 6
      const x = b0 * x0 + b1 * x1 + b2 * x2 + b3 * x3, y = b0 * y0 + b1 * y1 + b2 * y2 + b3 * y3
      const m = out.length
      if (Math.abs(x - out[m - 3]) + Math.abs(y - out[m - 2]) < step * 0.25 && !(s === n && k === steps)) continue
      out.push(x, y, b0 * r0 + b1 * r1 + b2 * r2 + b3 * r3)
    }
  }
  return out
}
