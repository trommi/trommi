// Scribble: an infinite canvas to draw on, drop images onto, and send to the
// agent. The module owns its state; nothing outside re-renders it. It fills
// whatever box its root has, from a phone screen to a wide desktop pane.
//
//   const board = mountScribble(root, { send, onChange, draftKey })
//   send({ doc, png, view, text })   async; png is the whole canvas, view exactly
//                                    the section on screen; text is always ''
//                                    (the human writes in the chat afterwards)
//   onChange(doc)                    a moment after the human changed the canvas;
//                                    never for load() or clear()
//   draftKey                         IndexedDB key for a local draft; null when
//                                    the host keeps the canvas (via onChange)
//   board.load(doc) / clear()        replace the content; a change still waiting
//                                    to be reported is reported first
//   board.flush()                    report a waiting change right now, e.g.
//                                    before the host switches to another canvas
//   board.isEmpty()
//
// Doc format (v1), plain JSON, world units are CSS pixels at 100 % zoom:
//   { v: 1,
//     images:  [{ id, x, y, w, h, nw, nh, src }],          back to front; src is a data URL
//     strokes: [{ id, tool: 'pen' | 'hl', color, size,     oldest first, always above the images
//                 pts: [x0, y0, x1, y1, …],
//                 pr?: [p0, p1, …] }] }                    pressure 0..1 per point, stylus only
import { el } from './ui.js'

const NS = 'http://www.w3.org/2000/svg'
const ICONS = {
  select: ['M5 3.5l13.5 6.6-5.7 1.9-2 5.7z', 'M13.5 13.5l5 5'],
  pen: ['M4 20l1.2-4.4L16.6 4.2a2 2 0 012.9 0l.3.3a2 2 0 010 2.9L8.4 18.8z', 'M14.5 6.5l3 3'],
  hl: ['M14.5 4l5.5 5.5-8 8H7.5v-4.5z', 'M11.5 7l5.5 5.5', 'M4 21h10'],
  eraser: ['M20 20H9.5l-5-5a2 2 0 010-2.8l8-8a2 2 0 012.8 0l4.9 4.9a2 2 0 010 2.8L12 20', 'M8.7 8.3l7 7'],
  image: ['M5 4h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z', 'M3.5 17l5-5 4 4 2.5-2.5 5.5 5.5', 'M15.5 8.5h.01'],
  undo: ['M9 14L4 9l5-5', 'M4 9h10.5a5.5 5.5 0 010 11H11'],
  redo: ['M15 14l5-5-5-5', 'M20 9H9.5a5.5 5.5 0 000 11H13'],
  trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12', 'M9 7V4h6v3'],
  fit: ['M4 9V5h4', 'M20 9V5h-4', 'M4 15v4h4', 'M20 15v4h-4'],
  plus: ['M12 5v14', 'M5 12h14'],
  minus: ['M5 12h14'],
  front: ['M12 20V8', 'M6.5 13L12 7.5l5.5 5.5', 'M5 4h14'],
  back: ['M12 4v12', 'M6.5 11l5.5 5.5 5.5-5.5', 'M5 20h14'],
  send: ['M12 19V5', 'M5.5 11.5L12 5l6.5 6.5'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  alert: ['M12 8v5', 'M12 16.5h.01', 'M10.3 3.9L2.6 17a2 2 0 001.7 3h15.4a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z'],
}
function icon(name) {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('class', 'scr-icon')
  svg.setAttribute('aria-hidden', 'true')
  for (const d of ICONS[name]) {
    const p = document.createElementNS(NS, 'path')
    p.setAttribute('d', d)
    svg.append(p)
  }
  return svg
}

// Ink is content, not chrome: these colours are stored in the doc and have to
// read on white paper and on photos alike, so they do not follow the theme.
const PEN_COLORS = [['#1b1f23', 'Schwarz'], ['#e03131', 'Rot'], ['#f08c00', 'Orange'], ['#2f9e44', 'Grün'], ['#1971c2', 'Blau'], ['#9c36b5', 'Violett']]
const HL_COLORS = [['#ffd43b', 'Gelb'], ['#69db7c', 'Grün'], ['#ff8cc6', 'Rosa'], ['#66c2ff', 'Blau'], ['#ffa94d', 'Orange']]
const SIZES = { pen: [2, 4, 7, 12], hl: [10, 18, 28, 42] }
const HL_ALPHA = 0.5
// The drawing surface stays paper in both themes: ink colours, photos and the
// PNG the agent receives all assume a white ground. Dark only dims it a little.
const PAPER = { light: '#ffffff', dark: '#eceee9' }
const DOT = 'rgb(20 28 24 / .27)'
const SELECT = '#1b6a57'
const PLACEHOLDER = '#e6e9e3'

const MIN_Z = 0.05, MAX_Z = 8
const MAX_IMG = 2000        // longest side of an imported image
const KEEP_BYTES = 350_000  // smaller files are embedded untouched
const PNG_MAX = 2400         // longest side of the whole-canvas picture
const VIEW_MAX = 2000        // longest side of the picture of the visible section
const CHANGE_MS = 900        // onChange fires this long after the hand stops
const DOCK_BELOW = 520       // narrower than this, Senden gets a bar of its own under the canvas
const UNDO_MAX = 200

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const r2 = v => Math.round(v * 100) / 100
const uid = () => Math.random().toString(36).slice(2, 10)
const clone = v => JSON.parse(JSON.stringify(v))

// ── stroke geometry ─────────────────────────────────────────────────────────
// Constant-width strokes are one stroked path through the midpoints (quadratic
// smoothing). Pressure strokes become one filled path: discs along the curve
// joined by quads, all wound the same way so nonzero fill unions them.
const geomCache = new WeakMap()
function buildGeom(s, mult = 1) {
  const p = s.pts, n = p.length >> 1, half = s.size * mult / 2
  const path = new Path2D()
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (let i = 0; i < n; i++) {
    const x = p[2 * i], y = p[2 * i + 1]
    if (x < x0) x0 = x; if (x > x1) x1 = x
    if (y < y0) y0 = y; if (y > y1) y1 = y
  }
  const pad = half * (s.pr ? 1.7 : 1) + 1
  const bbox = { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad }

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
    return { path, width: half * 2, fill: false, bbox }
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
  return { path, width: 0, fill: true, bbox }
}
function geom(s) {
  let g = geomCache.get(s)
  if (!g) geomCache.set(s, g = buildGeom(s))
  return g
}
function paintStroke(c, s, g) {
  if (s.tool === 'hl') { c.globalAlpha = HL_ALPHA; c.globalCompositeOperation = 'multiply' }
  if (g.fill) { c.fillStyle = s.color; c.fill(g.path) }
  else {
    c.strokeStyle = s.color
    c.lineWidth = g.width
    c.lineCap = c.lineJoin = 'round'
    c.stroke(g.path)
  }
  c.globalAlpha = 1
  c.globalCompositeOperation = 'source-over'
}

function distPtSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy
  const t = l ? clamp(((px - ax) * dx + (py - ay) * dy) / l, 0, 1) : 0
  return Math.hypot(px - ax - t * dx, py - ay - t * dy)
}
function segDist(ax, ay, bx, by, cx, cy, dx, dy) {
  const o = (px, py, qx, qy, rx, ry) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px))
  if (o(ax, ay, bx, by, cx, cy) !== o(ax, ay, bx, by, dx, dy) && o(cx, cy, dx, dy, ax, ay) !== o(cx, cy, dx, dy, bx, by)) return 0
  return Math.min(distPtSeg(ax, ay, cx, cy, dx, dy), distPtSeg(bx, by, cx, cy, dx, dy), distPtSeg(cx, cy, ax, ay, bx, by), distPtSeg(dx, dy, ax, ay, bx, by))
}
/** Does the eraser sweep a→b with radius r touch stroke s? */
function strokeHit(s, ax, ay, bx, by, r) {
  const b = geom(s).bbox
  if (Math.max(ax, bx) + r < b.x0 || Math.min(ax, bx) - r > b.x1 || Math.max(ay, by) + r < b.y0 || Math.min(ay, by) - r > b.y1) return false
  const p = s.pts, n = p.length >> 1, thr = r + s.size / 2
  if (n === 1) return distPtSeg(p[0], p[1], ax, ay, bx, by) < thr
  for (let i = 0; i < n - 1; i++) {
    if (segDist(ax, ay, bx, by, p[2 * i], p[2 * i + 1], p[2 * i + 2], p[2 * i + 3]) < thr) return true
  }
  return false
}

// ── image import ────────────────────────────────────────────────────────────
const readDataURL = file => new Promise((resolve, reject) => {
  const fr = new FileReader()
  fr.onload = () => resolve(fr.result)
  fr.onerror = () => reject(fr.error)
  fr.readAsDataURL(file)
})
async function importImage(file) {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const nw = img.naturalWidth || 800, nh = img.naturalHeight || 600
    const k = Math.min(1, MAX_IMG / Math.max(nw, nh))
    const w = Math.max(1, Math.round(nw * k)), h = Math.max(1, Math.round(nh * k))
    if (k === 1 && file.size <= KEEP_BYTES && /^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
      return { src: await readDataURL(file), nw: w, nh: h }
    }
    const cv = document.createElement('canvas')
    cv.width = w; cv.height = h
    const c = cv.getContext('2d')
    c.imageSmoothingQuality = 'high'
    c.drawImage(img, 0, 0, w, h)
    let alpha = false
    if (file.type !== 'image/jpeg') {
      const probe = document.createElement('canvas')
      probe.width = probe.height = 96
      const pc = probe.getContext('2d', { willReadFrequently: true })
      pc.drawImage(cv, 0, 0, 96, 96)
      const d = pc.getImageData(0, 0, 96, 96).data
      for (let i = 3; i < d.length; i += 4) if (d[i] < 250) { alpha = true; break }
    }
    // WebP where the browser can encode it (smaller, keeps transparency),
    // otherwise JPEG for opaque pictures and PNG for transparent ones.
    let src = cv.toDataURL('image/webp', 0.86)
    if (!src.startsWith('data:image/webp')) src = alpha ? cv.toDataURL('image/png') : cv.toDataURL('image/jpeg', 0.86)
    return { src, nw: w, nh: h }
  } finally {
    URL.revokeObjectURL(url)
  }
}

// ── draft store (IndexedDB; every failure is swallowed) ─────────────────────
function draftDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('scr-scribble', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('drafts')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
async function draftOp(mode, fn) {
  try {
    const db = await draftDB()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('drafts', mode)
      const req = fn(tx.objectStore('drafts'))
      tx.oncomplete = () => { db.close(); resolve(req.result) }
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error) }
    })
  } catch { return undefined }
}

export function mountScribble(root, { send, draftKey = 'draft', onChange } = {}) {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')
  const mod = k => (mac ? `⌘${k}` : `Strg+${k}`)
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
  const desktop = matchMedia('(hover: hover) and (pointer: fine)').matches

  // ── state ────────────────────────────────────────────────────────────────
  let images = [], strokes = []
  const undo = [], redo = []
  const view = { x: 0, y: 0, z: 1 }     // screen = world * z + (x, y)
  let W = 0, H = 0, dpr = 1
  let tool = 'pen', drawTool = 'pen'
  const style = { pen: { color: PEN_COLORS[0][0], w: 1 }, hl: { color: HL_COLORS[0][0], w: 1 } }
  let sel = null                         // id of the selected image
  let gesture = null
  const pointers = new Map()             // pointerId → { x, y } in stage coordinates
  let hover = null                       // eraser ring position
  let spaceDown = false
  let staticDirty = true, raf = 0, anim = null
  let pendingFit = true
  let sending = false
  let gen = 0                            // bumps on every change; guards the async draft restore
  const imgCache = new Map()             // src → { img, ok }

  // ── DOM ──────────────────────────────────────────────────────────────────
  const btn = (cls, label, iconName, tip, pos) => {
    const b = el('button', cls)
    b.type = 'button'
    b.setAttribute('aria-label', label)
    b.dataset.tip = tip ?? label
    if (pos) b.dataset.tipPos = pos
    if (iconName) b.append(icon(iconName))
    return b
  }

  const scr = el('div', 'scr')
  const stage = el('div', 'scr-stage')
  const canvas = el('canvas', 'scr-canvas')
  canvas.setAttribute('role', 'img')
  canvas.setAttribute('aria-label', 'Zeichenfläche')
  const ctx = canvas.getContext('2d', { alpha: false })
  const layer = document.createElement('canvas')   // everything that is not being drawn right now
  const lctx = layer.getContext('2d', { alpha: false })

  const hint = el('div', 'scr-hint')
  hint.append(icon('pen'), el('span', null, desktop ? 'Zeichne los, oder zieh ein Bild hierher.' : 'Zeichne mit einem Finger. Zwei Finger verschieben und zoomen.'))

  const drop = el('div', 'scr-drop')
  drop.append(el('span', null, 'Bild hier ablegen'))
  drop.hidden = true

  const toastEl = el('div', 'scr-toast')
  toastEl.setAttribute('role', 'status')
  toastEl.hidden = true

  // top bar
  const top = el('div', 'scr-top')
  const gHist = el('div', 'scr-group')
  const bUndo = btn('scr-btn', 'Rückgängig', 'undo', `Rückgängig · ${mod('Z')}`, 'below-start')
  const bRedo = btn('scr-btn', 'Wiederholen', 'redo', `Wiederholen · ${mac ? '⇧⌘Z' : 'Strg+Umschalt+Z'}`, 'below-start')
  gHist.append(bUndo, bRedo)
  const gView = el('div', 'scr-group')
  const bOut = btn('scr-btn scr-wide', 'Verkleinern', 'minus', 'Verkleinern', 'below')
  const bZoom = btn('scr-zoom', 'Zoom auf 100 % zurücksetzen', null, 'Auf 100 % · 0', 'below')
  const bIn = btn('scr-btn scr-wide', 'Vergrößern', 'plus', 'Vergrößern', 'below')
  const bFit = btn('scr-btn', 'Alles einpassen', 'fit', 'Alles einpassen · F', 'below-end')
  gView.append(bOut, bZoom, bIn, bFit)
  const gClear = el('div', 'scr-group')
  const bClear = btn('scr-btn', 'Alles löschen', 'trash', 'Alles löschen', 'below-end')
  bClear.setAttribute('aria-haspopup', 'dialog')
  gClear.append(bClear)
  top.append(gHist, el('span', 'scr-gap'), gView, gClear)

  // clear-all confirmation
  const confirmEl = el('div', 'scr-confirm')
  confirmEl.setAttribute('role', 'alertdialog')
  confirmEl.setAttribute('aria-label', 'Alles löschen?')
  confirmEl.hidden = true
  const confirmText = el('div', 'scr-confirm-text')
  confirmText.append(el('strong', null, 'Alles löschen?'), el('span', null, 'Die Fläche wird geleert. Rückgängig holt sie zurück.'))
  const confirmRow = el('div', 'scr-confirm-row')
  const bKeep = el('button', 'scr-pill', 'Abbrechen')
  const bWipe = el('button', 'scr-pill scr-pill-danger', 'Löschen')
  bKeep.type = bWipe.type = 'button'
  confirmRow.append(bKeep, bWipe)
  confirmEl.append(confirmText, confirmRow)

  // bottom toolbar
  const bar = el('div', 'scr-bar')
  const tools = el('div', 'scr-tools')
  tools.setAttribute('role', 'toolbar')
  tools.setAttribute('aria-label', 'Werkzeuge')
  const TOOLS = [['select', 'Auswählen', 'V'], ['pen', 'Stift', 'P'], ['hl', 'Marker', 'H'], ['eraser', 'Radierer', 'E']]
  const toolBtns = {}
  for (const [id, label, key] of TOOLS) {
    const b = btn('scr-btn scr-tool', label, id, `${label} · ${key}`)
    b.dataset.tool = id
    b.addEventListener('click', () => { if (tool === id && (id === 'pen' || id === 'hl')) toggleStyle(); else setTool(id) })
    toolBtns[id] = b
    tools.append(b)
  }
  const bStyle = btn('scr-btn scr-stylebtn', 'Farbe und Stärke', null, 'Farbe und Stärke')
  bStyle.setAttribute('aria-haspopup', 'true')
  const styleDot = el('span', 'scr-dot')
  bStyle.append(styleDot)
  const panel = el('div', 'scr-style')
  const rowColor = el('div', 'scr-style-row')
  const swatches = el('div', 'scr-swatches')
  swatches.setAttribute('role', 'group')
  swatches.setAttribute('aria-label', 'Farbe')
  rowColor.append(el('span', 'scr-label', 'Farbe'), swatches)
  const rowWidth = el('div', 'scr-style-row')
  const widths = el('div', 'scr-widths')
  widths.setAttribute('role', 'group')
  widths.setAttribute('aria-label', 'Stärke')
  rowWidth.append(el('span', 'scr-label', 'Stärke'), widths)
  panel.append(rowColor, rowWidth)
  const widthBtns = [0, 1, 2, 3].map(i => {
    const b = btn('scr-width', `Stärke ${i + 1}`, null, `Stärke ${i + 1} · ${i + 1}`)
    b.style.setProperty('--d', `${[5, 9, 13, 18][i]}px`)
    b.append(el('span', 'scr-dot'))
    b.addEventListener('click', () => setWidth(i))
    widths.append(b)
    return b
  })
  const bImage = btn('scr-btn', 'Bild einfügen', 'image', 'Bild einfügen · I')
  const file = el('input', 'scr-file')
  file.type = 'file'
  file.accept = 'image/*'
  file.multiple = true
  file.tabIndex = -1
  file.setAttribute('aria-hidden', 'true')
  tools.append(el('span', 'scr-sep'), bStyle, panel, el('span', 'scr-sep'), bImage)
  bar.append(tools)

  // actions for the selected image
  const ctxBar = el('div', 'scr-ctx')
  ctxBar.setAttribute('role', 'toolbar')
  ctxBar.setAttribute('aria-label', 'Ausgewähltes Bild')
  ctxBar.hidden = true
  const bFront = btn('scr-btn', 'Nach vorn', 'front', 'Nach vorn')
  const bBack = btn('scr-btn', 'Nach hinten', 'back', 'Nach hinten')
  const bDel = btn('scr-btn scr-danger', 'Bild löschen', 'trash', 'Löschen · Entf')
  ctxBar.append(bFront, bBack, el('span', 'scr-sep'), bDel)

  // send: one button. With room it stands at the end of the toolbar, on a
  // narrow screen in a bar of its own under the canvas (see placeSend).
  const SEND_TIP = 'Schickt dem Agenten, was du gerade siehst, und dazu die ganze Fläche'
  const bSend = el('button', 'scr-send')
  bSend.type = 'button'
  bSend.dataset.tip = SEND_TIP
  bSend.dataset.tipPos = 'above-end'
  const sendIcon = el('span', 'scr-send-icon')
  const sendLabel = el('span', 'scr-send-label')
  bSend.append(sendIcon, sendLabel)
  bar.append(bSend)
  const dock = el('div', 'scr-dock')

  const errorEl = el('div', 'scr-error')
  errorEl.setAttribute('role', 'alert')
  errorEl.hidden = true
  const errorText = el('span', 'scr-error-text')
  const bErrClose = btn('scr-error-close', 'Meldung schließen', 'close', 'Schließen')
  errorEl.append(icon('alert'), errorText, bErrClose)
  const live = el('div', 'scr-sr')
  live.setAttribute('aria-live', 'polite')

  stage.append(canvas, hint, drop, top, confirmEl, ctxBar, toastEl, errorEl, bar)
  scr.append(stage, dock, live, file)
  root.append(scr)

  function placeSend() {
    const w = W || root.clientWidth
    const home = w && w < DOCK_BELOW ? dock : bar
    if (bSend.parentNode !== home) home.append(bSend)
  }
  placeSend()

  // ── view ─────────────────────────────────────────────────────────────────
  const theme = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')
  const invalidate = () => { if (!raf) raf = requestAnimationFrame(paint) }
  const dirty = () => { staticDirty = true; invalidate() }
  const toWorld = (px, py) => [(px - view.x) / view.z, (py - view.y) / view.z]
  const local = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] }

  function setView(x, y, z) {
    view.x = x; view.y = y; view.z = z
    bZoom.textContent = `${Math.round(z * 100)} %`
    saveDraftSoon()
    dirty()
  }
  function animateTo(x, y, z, animate = true) {
    if (!animate || reduced() || !W) { anim = null; return setView(x, y, z) }
    anim = { from: { ...view }, to: { x, y, z }, t0: performance.now(), ms: 260 }
    invalidate()
  }
  function zoomAt(px, py, factor, animate = false) {
    const z = clamp(view.z * factor, MIN_Z, MAX_Z)
    const [wx, wy] = toWorld(px, py)
    animateTo(px - wx * z, py - wy * z, z, animate)
  }
  function bounds() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const i of images) { x0 = Math.min(x0, i.x); y0 = Math.min(y0, i.y); x1 = Math.max(x1, i.x + i.w); y1 = Math.max(y1, i.y + i.h) }
    for (const s of strokes) { const b = geom(s).bbox; x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1) }
    return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  }
  function fit(animate = true) {
    if (!W || !H) { pendingFit = true; return }
    const b = bounds()
    if (!b) return animateTo(W / 2, H / 2, 1, animate)
    const padX = 28, padT = 68, padB = 84
    const aw = Math.max(40, W - 2 * padX), ah = Math.max(40, H - padT - padB)
    const z = clamp(Math.min(1, aw / b.w, ah / b.h), MIN_Z, MAX_Z)
    animateTo(padX + (aw - b.w * z) / 2 - b.x * z, padT + (ah - b.h * z) / 2 - b.y * z, z, animate)
  }

  // ── painting ─────────────────────────────────────────────────────────────
  function sizeCanvas() {
    dpr = Math.min(window.devicePixelRatio || 1, 3)
    canvas.width = layer.width = Math.max(1, Math.round(W * dpr))
    canvas.height = layer.height = Math.max(1, Math.round(H * dpr))
    staticDirty = true
  }
  function picture(src) {
    let rec = imgCache.get(src)
    if (!rec) {
      const img = new Image()
      rec = { img, ok: false, ready: null }
      rec.ready = new Promise(resolve => {
        img.onload = () => { rec.ok = true; dirty(); resolve() }
        img.onerror = () => resolve()
      })
      img.src = src
      imgCache.set(src, rec)
    }
    return rec
  }
  function paintGrid(c) {
    let step = 24
    while (step * view.z < 14) step *= 2
    while (step * view.z >= 28) step /= 2
    const s = step * view.z, fade = (s - 14) / 14, size = Math.max(1, Math.round(1.5 * dpr)) / dpr
    const i0 = Math.floor(-view.x / s), j0 = Math.floor(-view.y / s)
    const major = new Path2D(), minor = new Path2D()
    for (let j = j0; j * s + view.y < H; j++) {
      for (let i = i0; i * s + view.x < W; i++) {
        const x = Math.round((i * s + view.x) * dpr) / dpr, y = Math.round((j * s + view.y) * dpr) / dpr
        ;(i % 2 === 0 && j % 2 === 0 ? major : minor).rect(x - size / 2, y - size / 2, size, size)
      }
    }
    c.fillStyle = DOT
    c.fill(major)
    c.globalAlpha = fade
    c.fill(minor)
    c.globalAlpha = 1
  }
  function paintContent(c, x0, y0, x1, y1, imgs, strs) {
    c.imageSmoothingQuality = 'high'
    for (const i of imgs) {
      if (i.x > x1 || i.y > y1 || i.x + i.w < x0 || i.y + i.h < y0) continue
      const rec = picture(i.src)
      if (rec.ok) c.drawImage(rec.img, i.x, i.y, i.w, i.h)
      else { c.fillStyle = PLACEHOLDER; c.fillRect(i.x, i.y, i.w, i.h) }
    }
    for (const s of strs) {
      const g = geom(s), b = g.bbox
      if (b.x0 > x1 || b.y0 > y1 || b.x1 < x0 || b.y1 < y0) continue
      paintStroke(c, s, g)
    }
  }
  function paintLayer() {
    const c = lctx
    c.setTransform(dpr, 0, 0, dpr, 0, 0)
    c.fillStyle = PAPER[theme()]
    c.fillRect(0, 0, W, H)
    paintGrid(c)
    c.setTransform(dpr * view.z, 0, 0, dpr * view.z, dpr * view.x, dpr * view.y)
    const [x0, y0] = toWorld(0, 0), [x1, y1] = toWorld(W, H)
    paintContent(c, x0, y0, x1, y1, images, strokes)
  }
  function paint(now) {
    raf = 0
    if (!W || !H) return
    if (Math.min(window.devicePixelRatio || 1, 3) !== dpr) sizeCanvas()
    if (anim) {
      const t = clamp(((now ?? performance.now()) - anim.t0) / anim.ms, 0, 1), k = 1 - (1 - t) ** 3
      const a = anim.from, b = anim.to
      // interpolate zoom geometrically so the motion feels even
      const z = a.z * (b.z / a.z) ** k
      const done = t >= 1
      view.x = done ? b.x : a.x + (b.x - a.x) * k
      view.y = done ? b.y : a.y + (b.y - a.y) * k
      view.z = done ? b.z : z
      bZoom.textContent = `${Math.round(view.z * 100)} %`
      staticDirty = true
      if (done) { anim = null; saveDraftSoon() } else raf = requestAnimationFrame(paint)
    }
    if (staticDirty) { paintLayer(); staticDirty = false }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.drawImage(layer, 0, 0)

    if (gesture?.type === 'draw' && gesture.pts.length) {
      ctx.setTransform(dpr * view.z, 0, 0, dpr * view.z, dpr * view.x, dpr * view.y)
      const s = { tool: gesture.tool, color: gesture.color, size: gesture.size, pts: gesture.pts, pr: gesture.pen ? gesture.pr : undefined }
      paintStroke(ctx, s, buildGeom(s))
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const im = selected()
    if (im && tool === 'select') {
      const x = im.x * view.z + view.x, y = im.y * view.z + view.y, w = im.w * view.z, h = im.h * view.z
      ctx.strokeStyle = SELECT
      ctx.lineWidth = 1.5
      ctx.strokeRect(x, y, w, h)
      for (const [hx, hy] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) {
        ctx.beginPath()
        ctx.arc(hx, hy, 6, 0, Math.PI * 2)
        ctx.fillStyle = PAPER.light
        ctx.fill()
        ctx.lineWidth = 2
        ctx.stroke()
      }
    }
    if (tool === 'eraser' && hover) {
      ctx.beginPath()
      ctx.arc(hover[0], hover[1], ERASER_R, 0, Math.PI * 2)
      ctx.fillStyle = 'rgb(255 255 255 / .55)'
      ctx.fill()
      ctx.strokeStyle = 'rgb(20 28 24 / .6)'
      ctx.lineWidth = 1.25
      ctx.stroke()
    }
    placeCtx(im)
  }
  function cancelQueued() { if (raf) { cancelAnimationFrame(raf); raf = 0 } }

  function placeCtx(im) {
    const show = !!im && tool === 'select' && !gesture
    if (ctxBar.hidden === show) ctxBar.hidden = !show
    if (!show) return
    const bw = ctxBar.offsetWidth, bh = ctxBar.offsetHeight
    const x = im.x * view.z + view.x, y = im.y * view.z + view.y, w = im.w * view.z, h = im.h * view.z
    let ty = y - bh - 14
    if (ty < 60) ty = y + h + 14
    if (ty + bh > H - 76) ty = clamp(y + 12, 60, Math.max(60, H - 76 - bh))
    const tx = clamp(x + w / 2 - bw / 2, 8, Math.max(8, W - bw - 8))
    ctxBar.style.transform = `translate(${Math.round(tx)}px, ${Math.round(ty)}px)`
  }

  // ── document changes ─────────────────────────────────────────────────────
  const selected = () => (sel ? images.find(i => i.id === sel) : null)
  const isEmpty = () => !images.length && !strokes.length
  const serialise = () => ({ v: 1, images: clone(images), strokes: clone(strokes) })

  function record(prev) {
    undo.push(prev)
    if (undo.length > UNDO_MAX) undo.shift()
    redo.length = 0
  }
  /** The doc is different now. quiet: the host put it there itself, so it is not told. */
  function changed(quiet = false) {
    gen++
    if (sel && !images.some(i => i.id === sel)) sel = null
    sync()
    saveDraftSoon()
    if (!quiet) notifySoon()
    dirty()
  }
  function commit(next) {
    record({ images, strokes })
    if (next.images) images = next.images
    if (next.strokes) strokes = next.strokes
    changed()
  }
  function step(from, to) {
    if (!from.length || gesture) return
    to.push({ images, strokes })
    ;({ images, strokes } = from.pop())
    changed()
  }

  function sync() {
    const empty = isEmpty()
    bUndo.disabled = !undo.length
    bRedo.disabled = !redo.length
    bClear.disabled = empty
    bFit.disabled = empty
    bSend.disabled = empty || sending
    hint.dataset.show = String(empty && !gesture)
    for (const [id, b] of Object.entries(toolBtns)) b.setAttribute('aria-pressed', String(tool === id))
    scr.dataset.tool = tool
    const st = style[drawTool]
    styleDot.style.setProperty('--c', st.color)
    styleDot.style.setProperty('--d', `${[6, 10, 14, 18][st.w]}px`)
    bStyle.dataset.kind = drawTool
    panel.dataset.kind = drawTool
    for (const b of swatches.children) b.setAttribute('aria-pressed', String(b.dataset.color === st.color))
    widthBtns.forEach((b, i) => { b.setAttribute('aria-pressed', String(i === st.w)); b.style.setProperty('--c', st.color) })
    updateCursor()
  }
  function buildSwatches() {
    swatches.replaceChildren(...(drawTool === 'hl' ? HL_COLORS : PEN_COLORS).map(([color, name]) => {
      const b = btn('scr-swatch', name, null, name)
      b.dataset.color = color
      b.style.setProperty('--c', color)
      b.addEventListener('click', () => {
        style[drawTool].color = color
        if (tool !== drawTool) setTool(drawTool); else sync()
        saveDraftSoon()
      })
      return b
    }))
  }
  function setTool(next) {
    tool = next
    if (next === 'pen' || next === 'hl') {
      if (drawTool !== next) { drawTool = next; buildSwatches() }
    } else closeStyle()
    if (next !== 'select') sel = null
    if (next !== 'eraser') hover = null
    sync()
    invalidate()
  }
  function setWidth(i) {
    style[drawTool].w = i
    if (tool !== drawTool) setTool(drawTool); else sync()
    saveDraftSoon()
  }
  const closeStyle = () => { delete scr.dataset.style; bStyle.setAttribute('aria-expanded', 'false') }
  function toggleStyle() {
    if (scr.dataset.style) return closeStyle()
    closeConfirm()
    if (tool !== drawTool) setTool(drawTool)
    scr.dataset.style = 'open'
    bStyle.setAttribute('aria-expanded', 'true')
  }
  const closeConfirm = () => { confirmEl.hidden = true; bClear.setAttribute('aria-expanded', 'false') }
  const closePopovers = () => { closeStyle(); closeConfirm() }

  function updateCursor(mode) {
    stage.dataset.cursor = mode ?? (spaceDown ? 'grab' : tool === 'select' ? 'select' : tool === 'eraser' ? 'eraser' : 'draw')
  }

  let toastTimer = 0
  function toast(text, kind = 'info', ms = 2600) {
    clearTimeout(toastTimer)
    toastEl.textContent = text
    toastEl.dataset.kind = kind
    toastEl.hidden = false
    if (ms) toastTimer = setTimeout(() => { toastEl.hidden = true }, ms)
  }

  // ── images ───────────────────────────────────────────────────────────────
  async function addImages(files, at) {
    const list = [...files].filter(f => f.type.startsWith('image/'))
    if (!list.length) return toast('Das ist kein Bild.', 'error')
    toast(list.length > 1 ? `${list.length} Bilder werden eingefügt …` : 'Bild wird eingefügt …', 'busy', 0)
    const added = []
    let failed = 0
    for (const f of list) {
      try {
        const { src, nw, nh } = await importImage(f)
        await picture(src).ready
        const k = Math.min(1, (0.74 * W) / view.z / nw, (0.6 * Math.max(120, H - 150)) / view.z / nh)
        const w = r2(nw * k), h = r2(nh * k)
        const [cx, cy] = at ? toWorld(at[0], at[1]) : toWorld(W / 2, (H - 20) / 2)
        const off = (added.length * 28) / view.z
        added.push({ id: uid(), x: r2(cx - w / 2 + off), y: r2(cy - h / 2 + off), w, h, nw, nh, src })
      } catch { failed++ }
    }
    toastEl.hidden = true
    if (failed) toast(failed > 1 ? `${failed} Bilder konnten nicht gelesen werden.` : 'Das Bild konnte nicht gelesen werden.', 'error', 4000)
    if (!added.length) return
    commit({ images: [...images, ...added] })
    sel = added[added.length - 1].id
    setTool('select')
  }
  function reorder(toFront) {
    const im = selected()
    if (!im) return
    const rest = images.filter(i => i !== im)
    const next = toFront ? [...rest, im] : [im, ...rest]
    if (next.every((i, k) => i === images[k])) return
    commit({ images: next })
  }
  function removeSelected() {
    const im = selected()
    if (!im) return
    sel = null
    commit({ images: images.filter(i => i !== im) })
  }
  const hitImage = (wx, wy) => {
    for (let k = images.length - 1; k >= 0; k--) {
      const i = images[k]
      if (wx >= i.x && wx <= i.x + i.w && wy >= i.y && wy <= i.y + i.h) return i
    }
    return null
  }
  /** Corner handle of the selected image under a stage point: [sx, sy] with ±1 each, or null. */
  function hitHandle(px, py, touch) {
    const im = selected()
    if (!im) return null
    const r = touch ? 22 : 11
    let best = null, bestD = r
    for (const [hx, hy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const cx = (im.x + (hx > 0 ? im.w : 0)) * view.z + view.x, cy = (im.y + (hy > 0 ? im.h : 0)) * view.z + view.y
      const d = Math.hypot(px - cx, py - cy)
      if (d <= bestD) { best = [hx, hy]; bestD = d }
    }
    return best
  }

  // ── pointer input ────────────────────────────────────────────────────────
  const ERASER_R = 11

  function addPoint(g, e, force) {
    const [px, py] = local(e)
    let [wx, wy] = toWorld(px, py)
    const n = g.pts.length
    if (n) {
      const lx = g.pts[n - 2], ly = g.pts[n - 1]
      if (!force) {
        // light streamline: follow the pointer at 68 % per sample to take the jitter out
        wx = lx + (wx - lx) * 0.68
        wy = ly + (wy - ly) * 0.68
        if (Math.hypot(wx - lx, wy - ly) * view.z < 1.1) return
      } else if (wx === lx && wy === ly) return
    }
    let p = g.pen && e.pressure > 0 ? e.pressure : 0.5
    if (g.pr.length) p = g.pr[g.pr.length - 1] * 0.6 + p * 0.4
    g.pts.push(wx, wy)
    g.pr.push(p)
  }
  function endDraw(g, keep) {
    if (!keep || !g.pts.length) return
    const s = { id: uid(), tool: g.tool, color: g.color, size: g.size, pts: g.pts.map(r2) }
    if (g.pen && g.pr.some(p => Math.abs(p - g.pr[0]) > 0.03)) s.pr = g.pr.map(r2)
    commit({ strokes: [...strokes, s] })
  }
  function erase(g, px, py) {
    const [wx, wy] = toWorld(px, py)
    const r = ERASER_R / view.z
    const next = strokes.filter(s => !strokeHit(s, g.wx, g.wy, wx, wy, r))
    g.wx = wx; g.wy = wy
    if (next.length !== strokes.length) { strokes = next; sync(); dirty() }
  }
  /** Stop the running one-pointer gesture, e.g. because a second finger arrived. */
  function abortGesture() {
    const g = gesture
    gesture = null
    if (!g) return
    if (g.type === 'draw') {
      // a palm or the second finger of a pinch landed: drop a stroke that has barely begun
      const long = performance.now() - g.t0 > 350 && g.pts.length > 12
      endDraw(g, long)
    } else if (g.type === 'erase') {
      if (strokes !== g.base.strokes) { const now = strokes; strokes = g.base.strokes; commit({ strokes: now }) }
    } else if (g.type === 'move' || g.type === 'resize') {
      images = g.base.images
      changed(true)
    }
  }
  function startPinch() {
    const [a, b] = [...pointers.values()]
    gesture = { type: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, view: { ...view } }
  }

  canvas.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button === 2) return
    closePopovers()
    anim = null
    try { canvas.setPointerCapture(e.pointerId) } catch {}
    const [px, py] = local(e)
    pointers.set(e.pointerId, { x: px, y: py })
    const touch = e.pointerType === 'touch'
    if (e.pointerType === 'mouse') { pointers.clear(); pointers.set(e.pointerId, { x: px, y: py }) }
    if (touch && pointers.size === 2) { abortGesture(); startPinch(); sync(); return invalidate() }
    if (gesture || pointers.size > 1) return
    const [wx, wy] = toWorld(px, py)
    const base = { images, strokes }

    if (e.button === 1 || spaceDown) {
      e.preventDefault()
      gesture = { type: 'pan', id: e.pointerId, px, py, vx: view.x, vy: view.y }
      updateCursor('grabbing')
    } else if (tool === 'pen' || tool === 'hl') {
      const st = style[tool]
      gesture = { type: 'draw', id: e.pointerId, tool, color: st.color, size: SIZES[tool][st.w], pen: tool === 'pen' && e.pointerType === 'pen', pts: [], pr: [], t0: performance.now() }
      addPoint(gesture, e, true)
    } else if (tool === 'eraser') {
      gesture = { type: 'erase', id: e.pointerId, base, wx, wy }
      hover = [px, py]
      erase(gesture, px, py)
    } else {
      const handle = hitHandle(px, py, touch)
      const im = handle ? selected() : hitImage(wx, wy)
      if (handle) {
        gesture = { type: 'resize', id: e.pointerId, base, im, handle, ax: im.x + (handle[0] < 0 ? im.w : 0), ay: im.y + (handle[1] < 0 ? im.h : 0) }
      } else if (im) {
        sel = im.id
        gesture = { type: 'move', id: e.pointerId, base, im, wx, wy, moved: false }
      } else {
        sel = null
        gesture = { type: 'pan', id: e.pointerId, px, py, vx: view.x, vy: view.y }
        updateCursor('grabbing')
      }
    }
    sync()
    if (gesture?.type === 'pan') updateCursor('grabbing')
    invalidate()
  })

  canvas.addEventListener('pointermove', e => {
    const [px, py] = local(e)
    const ptr = pointers.get(e.pointerId)
    if (ptr) { ptr.x = px; ptr.y = py }
    const g = gesture
    if (!g) {
      if (e.pointerType !== 'touch') {
        if (tool === 'eraser') { hover = [px, py]; invalidate() }
        else if (tool === 'select' && !spaceDown) {
          const h = hitHandle(px, py, false)
          updateCursor(h ? (h[0] * h[1] > 0 ? 'nwse' : 'nesw') : hitImage(...toWorld(px, py)) ? 'move' : 'select')
        }
      }
      return
    }
    if (g.type === 'pinch') {
      if (pointers.size < 2) return
      const [a, b] = [...pointers.values()]
      const z = clamp(g.view.z * (Math.hypot(a.x - b.x, a.y - b.y) || 1) / g.d, MIN_Z, MAX_Z)
      const wx = (g.cx - g.view.x) / g.view.z, wy = (g.cy - g.view.y) / g.view.z
      return setView((a.x + b.x) / 2 - wx * z, (a.y + b.y) / 2 - wy * z, z)
    }
    if (g.id !== e.pointerId) return
    if (g.type === 'pan') return setView(g.vx + px - g.px, g.vy + py - g.py, view.z)
    if (g.type === 'draw') {
      const list = e.getCoalescedEvents?.() ?? []
      for (const c of list.length ? list : [e]) addPoint(g, c, false)
      return invalidate()
    }
    if (g.type === 'erase') { hover = [px, py]; erase(g, px, py); return invalidate() }
    const [wx, wy] = toWorld(px, py)
    if (g.type === 'move') {
      const dx = wx - g.wx, dy = wy - g.wy
      if (!g.moved && Math.hypot(dx, dy) * view.z < 3) return
      g.moved = true
      const next = { ...g.im, x: r2(g.im.x + dx), y: r2(g.im.y + dy) }
      images = g.base.images.map(i => (i === g.im ? next : i))
      return dirty()
    }
    if (g.type === 'resize') {
      const k = Math.max(Math.abs(wx - g.ax) / g.im.w, Math.abs(wy - g.ay) / g.im.h, 24 / view.z / Math.max(g.im.w, g.im.h))
      const w = r2(g.im.w * k), h = r2(g.im.h * k)
      const next = { ...g.im, w, h, x: r2(g.handle[0] < 0 ? g.ax - w : g.ax), y: r2(g.handle[1] < 0 ? g.ay - h : g.ay) }
      images = g.base.images.map(i => (i === g.im ? next : i))
      return dirty()
    }
  })

  function pointerEnd(e) {
    const had = pointers.delete(e.pointerId)
    const g = gesture
    if (!g || !had) return
    if (g.type === 'pinch') {
      if (pointers.size < 2) gesture = null
    } else if (g.id === e.pointerId) {
      gesture = null
      if (g.type === 'draw') {
        if (e.type === 'pointerup') addPoint(g, e, true)
        endDraw(g, true)
      } else if (g.type === 'erase') {
        if (e.pointerType === 'touch') hover = null
        if (strokes !== g.base.strokes) { const now = strokes; strokes = g.base.strokes; commit({ strokes: now }) }
      } else if (g.type === 'move' || g.type === 'resize') {
        if (images !== g.base.images) { const now = images; images = g.base.images; commit({ images: now }) }
      }
    } else return
    sync()
    invalidate()
  }
  canvas.addEventListener('pointerup', pointerEnd)
  canvas.addEventListener('pointercancel', pointerEnd)
  canvas.addEventListener('pointerleave', () => { if (!gesture && hover) { hover = null; invalidate() } })
  canvas.addEventListener('contextmenu', e => e.preventDefault())
  canvas.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault() })   // no autoscroll puck

  canvas.addEventListener('wheel', e => {
    e.preventDefault()
    anim = null
    const [px, py] = local(e)
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? H : 1
    if (e.ctrlKey || e.metaKey) return zoomAt(px, py, Math.exp(-clamp(e.deltaY * unit, -40, 40) * 0.01))
    let dx = e.deltaX * unit, dy = e.deltaY * unit
    if (e.shiftKey && !dx) { dx = dy; dy = 0 }
    setView(view.x - dx, view.y - dy, view.z)
  }, { passive: false })
  // Safari sends trackpad pinches as gesture events
  let gestureZ = 1
  canvas.addEventListener('gesturestart', e => { e.preventDefault(); gestureZ = view.z })
  canvas.addEventListener('gesturechange', e => {
    e.preventDefault()
    if (pointers.size) return
    const [px, py] = local(e)
    zoomAt(px, py, (gestureZ * e.scale) / view.z)
  })

  // ── buttons ──────────────────────────────────────────────────────────────
  bUndo.addEventListener('click', () => step(undo, redo))
  bRedo.addEventListener('click', () => step(redo, undo))
  bZoom.addEventListener('click', () => zoomAt(W / 2, H / 2, 1 / view.z, true))
  bOut.addEventListener('click', () => zoomAt(W / 2, H / 2, 1 / 1.3, true))
  bIn.addEventListener('click', () => zoomAt(W / 2, H / 2, 1.3, true))
  bFit.addEventListener('click', () => fit(true))
  bStyle.addEventListener('click', toggleStyle)
  bImage.addEventListener('click', () => { closePopovers(); file.click() })
  file.addEventListener('change', () => { if (file.files.length) addImages(file.files); file.value = '' })
  bFront.addEventListener('click', () => reorder(true))
  bBack.addEventListener('click', () => reorder(false))
  bDel.addEventListener('click', removeSelected)
  bClear.addEventListener('click', () => {
    if (!confirmEl.hidden) return closeConfirm()
    closeStyle()
    confirmEl.hidden = false
    bClear.setAttribute('aria-expanded', 'true')
    bKeep.focus({ preventScroll: true })
  })
  bKeep.addEventListener('click', () => { closeConfirm(); bClear.focus({ preventScroll: true }) })
  bWipe.addEventListener('click', () => {
    closeConfirm()
    if (isEmpty()) return
    sel = null
    commit({ images: [], strokes: [] })
    toast('Fläche geleert')
  })

  // ── drop and paste ───────────────────────────────────────────────────────
  const hasFiles = e => [...(e.dataTransfer?.types ?? [])].includes('Files')
  stage.addEventListener('dragenter', e => { if (hasFiles(e)) { e.preventDefault(); drop.hidden = false } })
  stage.addEventListener('dragover', e => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; drop.hidden = false } })
  stage.addEventListener('dragleave', e => { if (!stage.contains(e.relatedTarget)) drop.hidden = true })
  stage.addEventListener('drop', e => {
    if (!hasFiles(e)) return
    e.preventDefault()
    drop.hidden = true
    addImages(e.dataTransfer.files, local(e))
  })
  const visible = () => scr.getClientRects().length > 0
  const typing = t => !!t?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
  document.addEventListener('paste', e => {
    if (!visible()) return
    // an input elsewhere on the page (the chat composer) keeps its own paste
    if (typing(e.target) && !scr.contains(e.target)) return
    const files = [...(e.clipboardData?.files ?? [])].filter(f => f.type.startsWith('image/'))
    if (!files.length) return
    e.preventDefault()
    addImages(files)
  })

  // ── keyboard ─────────────────────────────────────────────────────────────
  document.addEventListener('keydown', e => {
    if (!visible() || e.defaultPrevented || e.altKey) return
    if (e.key === 'Escape' && (scr.dataset.style || !confirmEl.hidden)) {
      const back = !confirmEl.hidden
      closePopovers()
      if (back) bClear.focus({ preventScroll: true })
      return
    }
    if (typing(e.target)) return
    const cmd = e.ctrlKey || e.metaKey
    const key = e.key.toLowerCase()
    if (cmd) {
      if (key === 'z') { e.preventDefault(); step(e.shiftKey ? redo : undo, e.shiftKey ? undo : redo) }
      else if (key === 'y') { e.preventDefault(); step(redo, undo) }
      return
    }
    if (e.key === ' ') {
      // a keyboard-focused button keeps its own space key
      if (document.activeElement?.matches?.('button:focus-visible, a:focus-visible')) return
      e.preventDefault()
      if (!spaceDown) { spaceDown = true; updateCursor() }
      return
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selected()) { e.preventDefault(); removeSelected() }
      return
    }
    if (e.key === 'Escape') { if (sel) { sel = null; sync(); invalidate() } return }
    if (e.repeat) return
    const map = { v: 'select', p: 'pen', h: 'hl', e: 'eraser' }
    if (map[key]) setTool(map[key])
    else if (key >= '1' && key <= '4') setWidth(Number(key) - 1)
    else if (key === 'i') file.click()
    else if (key === 'f') fit(true)
    else if (key === '0') zoomAt(W / 2, H / 2, 1 / view.z, true)
    else if (key === '+' || key === '=') zoomAt(W / 2, H / 2, 1.3, true)
    else if (key === '-') zoomAt(W / 2, H / 2, 1 / 1.3, true)
    else return
    e.preventDefault()
  })
  const spaceUp = () => { if (spaceDown) { spaceDown = false; if (gesture?.type !== 'pan') updateCursor() } }
  document.addEventListener('keyup', e => { if (e.key === ' ') spaceUp() })
  window.addEventListener('blur', spaceUp)

  // ── send ─────────────────────────────────────────────────────────────────
  function renderPNG() {
    const b = bounds()
    const longest = Math.max(b.w, b.h)
    const margin = Math.max(24, longest * 0.04)
    const w = b.w + 2 * margin, h = b.h + 2 * margin
    const scale = Math.min(3, PNG_MAX / Math.max(w, h))
    const cv = document.createElement('canvas')
    cv.width = Math.max(1, Math.round(w * scale))
    cv.height = Math.max(1, Math.round(h * scale))
    const c = cv.getContext('2d', { alpha: false })
    c.fillStyle = PAPER.light
    c.fillRect(0, 0, cv.width, cv.height)
    c.setTransform(scale, 0, 0, scale, (margin - b.x) * scale, (margin - b.y) * scale)
    paintContent(c, -Infinity, -Infinity, Infinity, Infinity, images, [])
    for (const s of strokes) {
      // on a huge canvas the picture is scaled down: keep every line at least ~2 px wide
      const min = s.tool === 'hl' ? 6 : 2
      const mult = Math.max(1, min / (s.size * scale))
      paintStroke(c, s, mult === 1 ? geom(s) : buildGeom(s, mult))
    }
    return cv.toDataURL('image/png')
  }

  /** The section on screen right now, as the human sees it: same pan and zoom,
   *  images under strokes, on white paper without the dot grid, the selection
   *  frame or the toolbars. Twice the CSS size (whatever the screen's own pixel
   *  ratio is), less on a pane so large that the picture would pass VIEW_MAX. */
  function renderView() {
    if (!W || !H) return renderPNG()
    const scale = Math.min(2, VIEW_MAX / Math.max(W, H))
    const cv = document.createElement('canvas')
    cv.width = Math.max(1, Math.round(W * scale))
    cv.height = Math.max(1, Math.round(H * scale))
    const c = cv.getContext('2d', { alpha: false })
    c.fillStyle = PAPER.light
    c.fillRect(0, 0, cv.width, cv.height)
    c.setTransform(view.z * scale, 0, 0, view.z * scale, view.x * scale, view.y * scale)
    const [x0, y0] = toWorld(0, 0), [x1, y1] = toWorld(W, H)
    paintContent(c, x0, y0, x1, y1, images, strokes)
    return cv.toDataURL('image/png')
  }

  let sentTimer = 0
  function setSendState(state) {
    sending = state === 'sending'
    bSend.dataset.state = state
    sendIcon.replaceChildren(state === 'sending' ? el('span', 'scr-spinner') : icon(state === 'sent' ? 'check' : 'send'))
    sendLabel.textContent = state === 'sending' ? 'Sendet …' : state === 'sent' ? 'Gesendet' : 'Ausschnitt senden'
    bSend.setAttribute('aria-label', state === 'idle' ? `Ausschnitt senden. ${SEND_TIP}.` : sendLabel.textContent)
    bSend.setAttribute('aria-busy', String(sending))
    sync()
  }
  function showError(msg) {
    errorText.textContent = msg
    errorEl.hidden = false
  }
  async function doSend() {
    if (sending || isEmpty()) return
    if (gesture) abortGesture()
    clearTimeout(sentTimer)
    errorEl.hidden = true
    closePopovers()
    setSendState('sending')
    try {
      // let the button repaint before the canvas is rendered
      await new Promise(r => setTimeout(r, 30))
      await Promise.all(images.map(i => picture(i.src).ready))
      const payload = { doc: serialise(), png: renderPNG(), view: renderView(), text: '' }
      await send(payload)
      setSendState('sent')
      live.textContent = 'Scribble gesendet.'
      sentTimer = setTimeout(() => { setSendState('idle'); live.textContent = '' }, 2400)
    } catch (err) {
      setSendState('idle')
      showError(err?.message ? String(err.message) : 'Das Senden hat nicht geklappt.')
    }
  }
  bSend.addEventListener('click', doSend)
  bErrClose.addEventListener('click', () => { errorEl.hidden = true })

  // ── draft ────────────────────────────────────────────────────────────────
  // The local draft (IndexedDB, only with a draftKey) keeps doc, view and pen.
  let saveTimer = 0
  function saveNow() {
    clearTimeout(saveTimer)
    saveTimer = 0
    if (!draftKey) return
    if (isEmpty()) return void draftOp('readwrite', s => s.delete(draftKey))
    const rec = { doc: { v: 1, images, strokes }, view: { ...view }, style: clone(style), tool: drawTool }
    draftOp('readwrite', s => s.put(rec, draftKey))
  }
  function saveDraftSoon() {
    if (!draftKey || saveTimer) return
    saveTimer = setTimeout(saveNow, 700)
  }

  // The host hears about every change to the doc (not the view), a moment
  // after the hand stops. Never in the middle of erasing or dragging, when
  // the doc is in a state the human has not let go of yet.
  let changeTimer = 0
  function notifySoon() {
    if (!onChange) return
    clearTimeout(changeTimer)
    changeTimer = setTimeout(notify, CHANGE_MS)
  }
  function notify() {
    clearTimeout(changeTimer)
    changeTimer = 0
    if (gesture && gesture.type !== 'pan' && gesture.type !== 'pinch') return notifySoon()
    try { onChange(serialise()) } catch (err) { console.error(err) }
  }
  /** Report a change that is still waiting, now. */
  function flush() {
    if (!changeTimer) return
    if (gesture) abortGesture()
    notify()
  }
  const flushAll = () => { if (saveTimer) saveNow(); flush() }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAll() })
  window.addEventListener('pagehide', flushAll)

  function replace(doc) {
    // what the human drew before belongs to the old canvas: report it before it goes
    flush()
    images = doc.images
    strokes = doc.strokes
    undo.length = redo.length = 0
    imgCache.clear()
    sel = null
    gesture = null
    pointers.clear()
    errorEl.hidden = true
    closePopovers()
    changed(true)
  }
  function load(doc) {
    if (!doc || doc.v !== 1 || !Array.isArray(doc.images) || !Array.isArray(doc.strokes)) {
      throw new Error('Dieses Scribble hat ein unbekanntes Format.')
    }
    const copy = clone(doc)
    replace({ images: copy.images, strokes: copy.strokes })
    fit(false)
  }
  function clear() {
    replace({ images: [], strokes: [] })
    fit(false)
  }

  // ── start ────────────────────────────────────────────────────────────────
  new ResizeObserver(() => {
    const w = stage.clientWidth, h = stage.clientHeight
    if (w === W && h === H) return
    if (W && H && w && h) { view.x += (w - W) / 2; view.y += (h - H) / 2 }
    W = w; H = h
    if (!W || !H) return
    // moving the button changes the stage's height, so not inside this callback
    requestAnimationFrame(placeSend)
    sizeCanvas()
    if (pendingFit) { pendingFit = false; fit(false) }
    cancelQueued()
    paint()
  }).observe(stage)
  new MutationObserver(dirty).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

  buildSwatches()
  setSendState('idle')
  bZoom.textContent = '100 %'

  if (draftKey) {
    draftOp('readonly', s => s.get(draftKey)).then(rec => {
      if (!rec || gen || rec.doc?.v !== 1) return
      try {
        images = rec.doc.images ?? []
        strokes = rec.doc.strokes ?? []
        if (rec.style?.pen && rec.style?.hl) Object.assign(style, rec.style)
        if (rec.tool === 'hl') { drawTool = tool = 'hl'; buildSwatches() }
        changed()
        if (rec.view && W) { pendingFit = false; setView(rec.view.x, rec.view.y, clamp(rec.view.z, MIN_Z, MAX_Z)) } else fit(false)
      } catch { images = []; strokes = []; changed() }
    })
  }

  return { load, clear, isEmpty, flush }
}
