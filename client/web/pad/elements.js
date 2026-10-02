// Pad elements: the record, its geometry, how it is painted and how it is hit.
// No DOM state in here, so the same code paints the screen and the PNG an agent gets.
//
// One element is one record (see docs/pad.md):
//   { id, pad, type, x, y, w, h, rotation, z, group, author, created, updated, rev,
//     blob, data, sent: [{ session, at, message_id, rev }] }
// blob is the id of the element's bytes in the blob store (the picture of an image,
// the audio of a voice note) or null; it stands outside data so that a server can
// keep and delete the file without reading data.
// x, y, w, h is the box in world units (CSS pixels at 100 % zoom). data by type:
//   stroke  { tool: 'pen' | 'hl', color, size, box: [w0, h0], pts: [x0, y0, …], pr?: [p0, …] }
//           pts are relative to the box as it was drawn (w0 x h0); the box may since
//           have been moved or scaled, the points never change
//   text    { text, size, color, wrap }       wrap: the width lines break at; null = the default
//           (TEXT_WRAP, scaled with the size). The box is as wide as the longest line.
//   voice   a text that was spoken: { text, size, color, wrap, ms, stub }
//   image   { mime, nw, nh, name }

export const INK = 'ink'   // the one colour that follows the theme: dark on light paper, light on dark
export const PEN_COLORS = [[INK, 'Ink'], ['#e03131', 'Red'], ['#f08c00', 'Orange'], ['#2f9e44', 'Green'], ['#1971c2', 'Blue'], ['#9c36b5', 'Violet']]
export const HL_COLORS = [['#ffd43b', 'Yellow'], ['#69db7c', 'Green'], ['#ff8cc6', 'Pink'], ['#66c2ff', 'Blue'], ['#ffa94d', 'Orange']]
export const SIZES = { pen: [2, 4, 7, 12], hl: [10, 18, 28, 42] }
export const TEXT_SIZE = 20
export const TEXT_WRAP = 460      // a typed line breaks here unless the element was given a width
const LINE = 1.35
const VOICE_INSET = 14            // room for the bar that marks spoken text
const FONT_STACK = '"IBM Plex Sans", "Segoe UI", system-ui, sans-serif'
export const textFont = size => `400 ${size}px ${FONT_STACK}`

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
export const r2 = v => Math.round(v * 100) / 100

// Ids sort by creation time (base36 milliseconds, then randomness), which keeps an
// append-only log and a directory listing in a sensible order.
export function newId() {
  const rand = crypto.getRandomValues(new Uint8Array(8))
  return Date.now().toString(36).padStart(9, '0') + [...rand].map(b => (b % 36).toString(36)).join('')
}

export const resolveInk = (color, dark) => (color === INK ? (dark ? '#e9eeea' : '#1b1f23') : color)

// ── strokes ─────────────────────────────────────────────────────────────────
// Constant-width strokes are one stroked path through the midpoints (quadratic
// smoothing). Pressure strokes become one filled path: discs along the curve
// joined by quads, all wound the same way so nonzero fill unions them.
// (Taken from js/scribble.js; the points are local to the element here.)
const geomCache = new WeakMap()
export function buildGeom(s) {
  const p = s.pts, n = p.length >> 1, half = s.size / 2
  const path = new Path2D()
  if (!s.pr) {
    path.moveTo(p[0], p[1])
    if (n === 1) path.lineTo(p[0] + 0.01, p[1])
    else {
      for (let i = 1; i < n - 1; i++) {
        const x = p[2 * i], y = p[2 * i + 1]
        path.quadraticCurveTo(x, y, (x + p[2 * i + 2]) / 2, (y + p[2 * i + 3]) / 2)
      }
      path.lineTo(p[2 * n - 2], p[2 * n - 1])
    }
    return { path, fill: false }
  }
  const rad = i => half * (0.35 + 1.3 * (s.pr[i] ?? 0.5))
  const out = []   // samples: x, y, r
  const push = (x, y, r) => {
    const k = out.length
    if (k && Math.hypot(x - out[k - 3], y - out[k - 2]) < Math.max(0.4, r * 0.3)) return
    out.push(x, y, r)
  }
  const curve = (ax, ay, ar, cx, cy, bx, by, br) => {
    const len = Math.hypot(cx - ax, cy - ay) + Math.hypot(bx - cx, by - cy)
    const steps = Math.max(1, Math.ceil(len / Math.max(0.75, Math.min(ar, br) * 0.5)))
    for (let k = 1; k <= steps; k++) {
      const t = k / steps, u = 1 - t
      push(u * u * ax + 2 * u * t * cx + t * t * bx, u * u * ay + 2 * u * t * cy + t * t * by, ar + (br - ar) * t)
    }
  }
  let ax = p[0], ay = p[1], ar = rad(0)
  out.push(ax, ay, ar)
  for (let i = 1; i < n - 1; i++) {
    const cx = p[2 * i], cy = p[2 * i + 1]
    const bx = (cx + p[2 * i + 2]) / 2, by = (cy + p[2 * i + 3]) / 2, br = (rad(i) + rad(i + 1)) / 2
    curve(ax, ay, ar, cx, cy, bx, by, br)
    ax = bx; ay = by; ar = br
  }
  if (n > 1) {
    const bx = p[2 * n - 2], by = p[2 * n - 1]
    curve(ax, ay, ar, (ax + bx) / 2, (ay + by) / 2, bx, by, rad(n - 1))
    const k = out.length
    if (out[k - 3] !== bx || out[k - 2] !== by) out.push(bx, by, rad(n - 1))
  }
  for (let i = 0; i < out.length; i += 3) {
    const x = out[i], y = out[i + 1], r = out[i + 2]
    path.moveTo(x + r, y)
    path.arc(x, y, r, 0, Math.PI * 2, true)
    if (i + 3 < out.length) {
      const bx = out[i + 3], by = out[i + 4], br = out[i + 5]
      const dx = bx - x, dy = by - y, l = Math.hypot(dx, dy) || 1
      const nx = -dy / l, ny = dx / l
      path.moveTo(x + nx * r, y + ny * r)
      path.lineTo(bx + nx * br, by + ny * br)
      path.lineTo(bx - nx * br, by - ny * br)
      path.lineTo(x - nx * r, y - ny * r)
      path.closePath()
    }
  }
  return { path, fill: true }
}
function geom(data) {
  let g = geomCache.get(data)
  if (!g) geomCache.set(data, g = buildGeom(data))
  return g
}

/** Paint stroke data in its own coordinates (the caller has set the transform). */
export function paintStroke(c, data, dark, g = geom(data)) {
  const color = resolveInk(data.color, dark)
  if (data.tool === 'hl') {
    // Multiply reads as a marker on light paper; on dark paper it would vanish.
    c.globalAlpha = dark ? 0.38 : 0.5
    c.globalCompositeOperation = dark ? 'source-over' : 'multiply'
  }
  if (g.fill) { c.fillStyle = color; c.fill(g.path) }
  else {
    c.strokeStyle = color
    c.lineWidth = data.size
    c.lineCap = c.lineJoin = 'round'
    c.stroke(g.path)
  }
  c.globalAlpha = 1
  c.globalCompositeOperation = 'source-over'
}

/** Turn points drawn in world units into the box and data of a stroke element. */
export function strokeFromWorld(pts, pr, { tool, color, size }) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (let i = 0; i < pts.length; i += 2) {
    x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i])
    y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1])
  }
  const pad = (size / 2) * (pr ? 1.7 : 1) + 1
  const x = r2(x0 - pad), y = r2(y0 - pad), w = r2(x1 - x0 + 2 * pad), h = r2(y1 - y0 + 2 * pad)
  const data = { tool, color, size, box: [w, h], pts: pts.map((v, i) => r2(v - (i % 2 ? y : x))) }
  if (pr) data.pr = pr.map(r2)
  return { x, y, w, h, data }
}

function distPtSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy
  const t = l ? clamp(((px - ax) * dx + (py - ay) * dy) / l, 0, 1) : 0
  return Math.hypot(px - ax - t * dx, py - ay - t * dy)
}

// ── text ────────────────────────────────────────────────────────────────────
let measureCtx = null
const layoutCache = new WeakMap()
/** Break the text of a text or voice element into lines. Returns { lines, w, h, inset, lh }. */
export function layoutText(data, type = 'text') {
  let out = layoutCache.get(data)
  if (out) return out
  measureCtx ??= document.createElement('canvas').getContext('2d')
  const c = measureCtx
  c.font = textFont(data.size)
  const inset = type === 'voice' ? VOICE_INSET * (data.size / TEXT_SIZE) : 0
  const max = Math.max(data.size * 2, (data.wrap ?? TEXT_WRAP * (data.size / TEXT_SIZE)) - inset)
  const lines = []
  let widest = 0
  for (const para of String(data.text).split('\n')) {
    let line = ''
    for (const word of para.split(/(\s+)/)) {
      if (!word) continue
      const next = line + word
      if (line && !/^\s+$/.test(word) && c.measureText(next).width > max) {
        lines.push(line.trimEnd())
        line = word
      } else line = next
      // a single word longer than the line: break it by letters
      while (c.measureText(line).width > max && line.length > 1) {
        let k = line.length - 1
        while (k > 1 && c.measureText(line.slice(0, k)).width > max) k--
        lines.push(line.slice(0, k))
        line = line.slice(k)
      }
    }
    lines.push(line.trimEnd())
  }
  for (const l of lines) widest = Math.max(widest, c.measureText(l).width)
  const lh = data.size * LINE
  out = { lines, inset, lh, w: r2(Math.max(data.size * 0.6, Math.ceil(widest) + inset + 2)), h: r2(Math.max(1, lines.length) * lh) }
  layoutCache.set(data, out)
  return out
}

export const isText = el => el.type === 'text' || el.type === 'voice'

// ── painting ────────────────────────────────────────────────────────────────
/** Paint one element in world coordinates.
 *  env: { dark, accent, placeholder, picture(blobId) → { img, ok } } */
export function paintElement(c, el, env) {
  const d = el.data
  if (el.type === 'stroke') {
    c.save()
    c.translate(el.x, el.y)
    c.scale(el.w / d.box[0], el.h / d.box[1])
    paintStroke(c, d, env.dark)
    c.restore()
  } else if (el.type === 'image') {
    const rec = el.blob ? env.picture(el.blob) : null
    if (rec?.ok) { c.imageSmoothingQuality = 'high'; c.drawImage(rec.img, el.x, el.y, el.w, el.h) }
    else { c.fillStyle = env.placeholder; c.fillRect(el.x, el.y, el.w, el.h) }
  } else if (isText(el)) {
    const lay = layoutText(d, el.type)
    c.font = textFont(d.size)
    c.textBaseline = 'middle'
    c.fillStyle = resolveInk(d.color, env.dark)
    lay.lines.forEach((line, i) => c.fillText(line, el.x + lay.inset, el.y + (i + 0.5) * lay.lh))
    if (el.type === 'voice') {
      // spoken text carries a bar on its left, like a quotation
      const bw = Math.max(2, d.size * 0.16)
      c.fillStyle = env.accent
      c.beginPath()
      c.roundRect(el.x, el.y + lay.lh * 0.14, bw, el.h - lay.lh * 0.28, bw / 2)
      c.fill()
    }
  }
}

// ── hit testing ─────────────────────────────────────────────────────────────
export const boxOf = el => ({ x0: el.x, y0: el.y, x1: el.x + el.w, y1: el.y + el.h })

/** Is the world point on the element? tol is the slack in world units. */
export function hitElement(el, wx, wy, tol) {
  if (wx < el.x - tol || wy < el.y - tol || wx > el.x + el.w + tol || wy > el.y + el.h + tol) return false
  if (el.type !== 'stroke') return true
  return strokeNear(el, wx, wy, wx, wy, tol)
}

/** Does the segment a→b (world) pass within r of the stroke's line? */
export function strokeNear(el, ax, ay, bx, by, r) {
  const d = el.data, sx = el.w / d.box[0], sy = el.h / d.box[1]
  const p = d.pts, n = p.length >> 1
  const thr = r + (d.size * Math.max(sx, sy)) / 2
  if (Math.max(ax, bx) + thr < el.x || Math.min(ax, bx) - thr > el.x + el.w || Math.max(ay, by) + thr < el.y || Math.min(ay, by) - thr > el.y + el.h) return false
  const X = i => el.x + p[2 * i] * sx, Y = i => el.y + p[2 * i + 1] * sy
  if (n === 1) return distPtSeg(X(0), Y(0), ax, ay, bx, by) < thr
  for (let i = 0; i < n - 1; i++) {
    const cx = X(i), cy = Y(i), dx = X(i + 1), dy = Y(i + 1)
    const o = (px, py, qx, qy, rx, ry) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px))
    if (o(ax, ay, bx, by, cx, cy) !== o(ax, ay, bx, by, dx, dy) && o(cx, cy, dx, dy, ax, ay) !== o(cx, cy, dx, dy, bx, by)) return true
    if (Math.min(distPtSeg(ax, ay, cx, cy, dx, dy), distPtSeg(bx, by, cx, cy, dx, dy), distPtSeg(cx, cy, ax, ay, bx, by), distPtSeg(dx, dy, ax, ay, bx, by)) < thr) return true
  }
  return false
}

/** Does the element touch the world rectangle (a marquee)? */
export function inRect(el, x0, y0, x1, y1) {
  if (el.x > x1 || el.y > y1 || el.x + el.w < x0 || el.y + el.h < y0) return false
  if (el.type !== 'stroke') return true
  const d = el.data, sx = el.w / d.box[0], sy = el.h / d.box[1]
  for (let i = 0; i < d.pts.length; i += 2) {
    const x = el.x + d.pts[i] * sx, y = el.y + d.pts[i + 1] * sy
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return true
  }
  return false
}

export function unionBox(list) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const e of list) { x0 = Math.min(x0, e.x); y0 = Math.min(y0, e.y); x1 = Math.max(x1, e.x + e.w); y1 = Math.max(y1, e.y + e.h) }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** Scale an element by k about the fixed world point (ax, ay). Uniform, so text and line widths follow. */
export function scaled(el, k, ax, ay) {
  const next = { ...el, x: r2(ax + (el.x - ax) * k), y: r2(ay + (el.y - ay) * k), w: r2(el.w * k), h: r2(el.h * k) }
  if (isText(el)) {
    const data = { ...el.data, size: r2(el.data.size * k), wrap: el.data.wrap == null ? null : r2(el.data.wrap * k) }
    const lay = layoutText(data, el.type)
    next.data = data; next.w = lay.w; next.h = lay.h
  }
  return next
}

// ── what an agent receives ──────────────────────────────────────────────────
/** The plain text of the text and voice elements, in reading order. */
export function textOf(list) {
  return list.filter(isText)
    .sort((a, b) => (Math.abs(a.y - b.y) > Math.min(a.h, b.h) / 2 ? a.y - b.y : a.x - b.x))
    .map(e => e.data.text.trim()).filter(Boolean).join('\n\n')
}

/** A PNG of the bounding box of these elements, on white paper, without grid or
 *  selection frame. Returns { png (data URL), bbox, width, height }. */
export function renderPNG(list, env, { max = 2000, margin = 24 } = {}) {
  const b = unionBox(list)
  const w = b.w + 2 * margin, h = b.h + 2 * margin
  const scale = Math.min(2, max / Math.max(w, h))
  const cv = document.createElement('canvas')
  cv.width = Math.max(1, Math.round(w * scale))
  cv.height = Math.max(1, Math.round(h * scale))
  const c = cv.getContext('2d', { alpha: false })
  c.fillStyle = '#ffffff'
  c.fillRect(0, 0, cv.width, cv.height)
  c.setTransform(scale, 0, 0, scale, (margin - b.x) * scale, (margin - b.y) * scale)
  for (const el of list) paintElement(c, el, { ...env, dark: false })
  return { png: cv.toDataURL('image/png'), bbox: { x: r2(b.x), y: r2(b.y), w: r2(b.w), h: r2(b.h) }, width: cv.width, height: cv.height }
}

/** A picture of exactly this rectangle of the paper (world units): everything that shows in it,
 *  whole or cut off at its edge, on white. What the human saw is what the agent gets. */
export function renderRect(list, rect, env, { max = 2000 } = {}) {
  const scale = Math.min(2, max / Math.max(rect.w, rect.h))
  const cv = document.createElement('canvas')
  cv.width = Math.max(1, Math.round(rect.w * scale))
  cv.height = Math.max(1, Math.round(rect.h * scale))
  const c = cv.getContext('2d', { alpha: false })
  c.fillStyle = '#ffffff'
  c.fillRect(0, 0, cv.width, cv.height)
  c.setTransform(scale, 0, 0, scale, -rect.x * scale, -rect.y * scale)
  for (const el of list) {
    if (el.x > rect.x + rect.w || el.y > rect.y + rect.h || el.x + el.w < rect.x || el.y + el.h < rect.y) continue
    paintElement(c, el, { ...env, dark: false })
  }
  return { png: cv.toDataURL('image/png'), bbox: { x: r2(rect.x), y: r2(rect.y), w: r2(rect.w), h: r2(rect.h) }, width: cv.width, height: cv.height }
}
