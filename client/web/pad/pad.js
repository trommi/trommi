// The global pad: one endless surface for notes, drawings, pictures and spoken
// text, where every element is a record of its own and any selection can be sent
// to a session. Prototype; the model and the server it needs are in docs/pad.md.
//
// How input is read:
//   click on empty paper   a cursor there; typing makes a text element
//   drag                   pen and highlighter draw; the select tool frames a selection
//   hold still             speak; the transcript lands there as a voice element
//   click on an element    selects it; what is selected moves when dragged, with any tool
import { openStore } from './db.js'
import {
  INK, PEN_COLORS, HL_COLORS, SIZES, TEXT_SIZE, TEXT_WRAP, r2, newId, resolveInk, textFont,
  buildGeom, paintStroke, strokeFromWorld, layoutText, isText, paintElement, hitElement, strokeNear, inRect,
  unionBox, scaled, textOf, renderPNG, renderRect,
} from './elements.js'
import { flySheet } from './fly.js'
import { connectBoard, onBoard, boardState, setBoard, transcribe, sendSelection, SAMPLE_TRANSCRIPT } from './board.js'
import { startSync } from './sync.js'
import { PAD_WORD } from './name.js'

const QUERY = new URLSearchParams(location.search)
const PAD = QUERY.get('pad') || 'global'
// Inside the board (js/padlink.js lays this page over whatever is shown): the board says who
// the sessions are and where the human came from, and "close" goes back there.
const EMBED = QUERY.has('embed') && window.parent !== window
// On the Desk (?desk): the pad is the paper the whole Desk lies on (js/padlink.js). It has no pan and no zoom of
// its own: the Desk's scrolling moves it (padDesk below), and the paper is as wide as the Desk.
const DESK = EMBED && QUERY.has('desk')
const tell = (type, extra = {}) => { if (EMBED) window.parent.postMessage({ trommi: 'pad', type, ...extra }, location.origin) }
let host = { open: !EMBED, prefer: [] }   // what the board last said: is the pad in sight, which session is behind it
const AUTHOR = 'human'   // with device keys this becomes the device id (docs/krypto-konzept.md)
const MIN_Z = 0.05, MAX_Z = 8
const UNDO_MAX = 200
const HOLD_MS = 550       // a press that stays put this long starts a recording
const CLICK_PX = 5        // further than this and a press is a drag
const ERASER_R = 11
const MAX_IMG = 2000, KEEP_BYTES = 1_500_000

const $ = id => document.getElementById(id)
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const root = document.documentElement
const pad = $('pad'), canvas = $('canvas'), editor = $('editor')
const ctx = canvas.getContext('2d', { alpha: false })
const layer = document.createElement('canvas')   // everything that is not changing right now
const lctx = layer.getContext('2d', { alpha: false })

// ── icons ───────────────────────────────────────────────────────────────────
const ICONS = {
  // a frame cut along a dashed line, and where it goes
  area: ['M4 8.5V6.200A2.200 2.200 0 016.200 4H8.500', 'M12 4h3', 'M18.500 4.300A2.200 2.200 0 0120 6.200V8.500', 'M4 12v3', 'M4 18.200A2.200 2.200 0 006.200 20H8.500', 'M12.500 20.500l7-7', 'M14.500 13.500h5v5'],
  more: ['M6 9l6 6 6-6'],
  select: ['M5 3.5l13.5 6.6-5.7 1.9-2 5.7z', 'M13.5 13.5l5 5'],
  pen: ['M4 20l1.2-4.4L16.6 4.2a2 2 0 012.9 0l.3.3a2 2 0 010 2.9L8.4 18.8z', 'M14.5 6.5l3 3'],
  hl: ['M14.5 4l5.5 5.5-8 8H7.5v-4.5z', 'M11.5 7l5.5 5.5', 'M4 21h10'],
  eraser: ['M20 20H9.5l-5-5a2 2 0 010-2.8l8-8a2 2 0 012.8 0l4.9 4.9a2 2 0 010 2.8L12 20', 'M8.7 8.3l7 7'],
  text: ['M5.5 7V5h13v2', 'M12 5v14', 'M9.5 19h5'],
  clip: ['M20 11.5l-8.2 8.2a5 5 0 01-7.1-7.1l8.6-8.6a3.3 3.3 0 014.7 4.7l-8.6 8.6a1.7 1.7 0 01-2.4-2.4l7.9-7.9'],   // attach
  mic: ['M12 3a3 3 0 013 3v5a3 3 0 01-6 0V6a3 3 0 013-3z', 'M5.5 11a6.5 6.5 0 0013 0', 'M12 17.5V21', 'M8.5 21h7'],
  undo: ['M9 14L4 9l5-5', 'M4 9h10.5a5.5 5.5 0 010 11H11'],
  redo: ['M15 14l5-5-5-5', 'M20 9H9.5a5.5 5.5 0 000 11H13'],
  trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12', 'M9 7V4h6v3'],
  fit: ['M4 9V5h4', 'M20 9V5h-4', 'M4 15v4h4', 'M20 15v4h-4'],
  plus: ['M12 5v14', 'M5 12h14'],
  minus: ['M5 12h14'],
  front: ['M12 20V8', 'M6.5 13L12 7.5l5.5 5.5', 'M5 4h14'],
  'back-z': ['M12 4v12', 'M6.5 11l5.5 5.5 5.5-5.5', 'M5 20h14'],
  group: ['M4 8V4h4', 'M20 8V4h-4', 'M4 16v4h4', 'M20 16v4h-4', 'M9 9h6v6H9z'],
  send: ['M12 19V5', 'M5.5 11.5L12 5l6.5 6.5'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  back: ['M15 5l-7 7 7 7'],
  help: ['M9.2 9a3 3 0 115 2.2c-.9.8-2.2 1.5-2.2 3', 'M12 18h.01'],
  theme: ['M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.500z'],
}
function icon(name) {
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('class', 'pad-icon')
  svg.setAttribute('aria-hidden', 'true')
  for (const d of ICONS[name]) {
    const p = document.createElementNS(NS, 'path')
    p.setAttribute('d', d)
    svg.append(p)
  }
  return svg
}
for (const node of document.querySelectorAll('[data-icon]')) node.prepend(icon(node.dataset.icon))

// ── state ───────────────────────────────────────────────────────────────────
let db = null
let sync = null                // the link to the server (sync.js)
let els = new Map()            // id → record; tombstones are not in here
const revs = new Map()         // id → highest revision seen, tombstones included
let order = null               // records back to front, rebuilt when z changes
const sel = new Set()
const undo = [], redo = []     // each entry: [{ id, before, after }], a record or null on either side
const view = { x: 0, y: 0, z: 1 }   // screen = world * z + (x, y)
let W = 0, H = 0, dpr = 1
let tool = 'pen', drawTool = 'pen'
const style = { pen: { color: INK, w: 1 }, hl: { color: HL_COLORS[0][0], w: 1 } }
let gesture = null
let preview = null             // id → record as it looks during a move or resize; null otherwise
const pointers = new Map()
let hover = null, spaceDown = false
let staticDirty = true, raf = 0, anim = null
let edit = null                // the open note: { id, type, x, y, size, color, wrap }
let rec = null                 // the running recording
let lastClick = { id: null, t: 0 }
let area = null                // the framed area waiting for a session: { x, y, w, h } in world units, list
let toolBefore = 'pen'         // what was in hand before the area tool
let theme = {}                 // colours read from the tokens
const pictures = new Map()     // blob id → { img, ok, ready }

// The Desk's paper: its top left corner in world units (x0: left of everything on it; y0: the top of the Desk's
// page), how far the Desk is scrolled (s), a sideways pan (panX). y0 is fixed once per browser (TOP_KEY): the
// first time, so that what was drawn under the Desk's list, when the paper began there, stays where it was.
const TOP_KEY = `trommi-deskpad-top:${PAD}`
const desk = { x0: -24, y0: null, s: 0, panX: 0, z: 1, bottom: -1, width: -1, front: null, loaded: false }
try { const v = Number(localStorage.getItem(TOP_KEY) ?? NaN); if (Number.isFinite(v)) desk.y0 = v } catch {}
const deskTop = () => desk.y0 ?? -32
function deskView() {
  // A point of the paper (px, py; 100 % pixels from its corner) stands on the screen at ((px - panX) * z, py * z - s):
  // the Desk's cards do not scale, the paper under them does (a pinch on a phone, padZoom below).
  view.z = desk.z; view.x = (-desk.x0 - desk.panX) * desk.z; view.y = -deskTop() * desk.z - desk.s
  dirty()
}
/** Content may lie above or left of the corner (it was put there on the pad's own page): the corner moves out to it. */
function deskOrigin() {
  for (const el of els.values()) desk.x0 = Math.min(desk.x0, el.x - 24)
}
/** Tell the Desk how far down the paper is used, so that it keeps free paper below. */
function deskExtent() {
  let bottom = edit ? edit.y + edit.size * 3 : deskTop(), right = 0
  for (const el of els.values()) { bottom = Math.max(bottom, el.y + el.h); right = Math.max(right, el.x + el.w) }
  bottom = Math.ceil(bottom - deskTop())
  const width = els.size ? Math.ceil(right + 24 - desk.x0) : 0   // how wide the paper is written: what "fit" has to show
  if (bottom !== desk.bottom || width !== desk.width) { desk.bottom = bottom; desk.width = width; tell('extent', { bottom, width }) }
}
function deskPan(dx) {
  let right = 0
  for (const el of els.values()) right = Math.max(right, el.x + el.w)
  desk.panX = clamp(desk.panX + dx / desk.z, 0, Math.max(0, right + 24 - desk.x0 - W / desk.z))
  tell('pan', { x: desk.panX })
  deskView()
}
const dark = () => root.dataset.theme === 'dark'
const toWorld = (px, py) => [(px - view.x) / view.z, (py - view.y) / view.z]
const local = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] }
const ordered = () => (order ??= [...els.values()].sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : 1)))
const shown = el => preview?.get(el.id) ?? el
const selected = () => ordered().filter(e => sel.has(e.id))
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

// ── records ─────────────────────────────────────────────────────────────────
const nextRev = id => { const r = (revs.get(id) ?? 0) + 1; revs.set(id, r); return r }
/** A record as it is written: every write gets a time and the next revision. */
const stamp = el => ({ ...el, updated: Date.now(), rev: nextRev(el.id), sent: els.get(el.id)?.sent ?? el.sent ?? [] })
const tombstone = el => ({ id: el.id, pad: el.pad, deleted: true, author: AUTHOR, updated: Date.now(), rev: nextRev(el.id) })
const topZ = () => ordered().reduce((m, e) => Math.max(m, e.z), 0)
function make(type, box, data, z = topZ() + 1, blob = null) {
  const now = Date.now()
  const id = newId()
  return { id, pad: PAD, type, x: r2(box.x), y: r2(box.y), w: r2(box.w), h: r2(box.h), rotation: 0, z, group: null, author: AUTHOR, created: now, updated: now, rev: nextRev(id), blob, data, sent: [] }
}
function makeText(type, x, y, data, blob = null) {
  const lay = layoutText(data, type)
  return make(type, { x, y, w: lay.w, h: lay.h }, data, undefined, blob)
}

let saveError = false
let firstLook = false   // no view was saved on this device and nothing is on the pad yet
function persist(records) {
  db.put(records).then(() => { saveError = false; renderStatus() }, () => { saveError = true; renderStatus() })
  sync.push(records)
}
/** Records that came from the server: another tab or device changed them, or the server
 *  confirmed ours (with its time, its running number, and where they were sent). */
function applyRemote(records) {
  for (const r of records) {
    revs.set(r.id, Math.max(revs.get(r.id) ?? 0, r.rev ?? 1))
    if (r.deleted) { els.delete(r.id); sel.delete(r.id) }
    else els.set(r.id, r)
  }
  order = null
  if (DESK) { deskOrigin(); deskView() }
  refresh()
  // A device that has never looked at this pad starts with all of it in view.
  if (firstLook && els.size && !gesture && !edit) fit(false)
  firstLook = false
}
/** Change the pad. changes: [{ id, before, after }]; after null deletes. One call is one undo step. */
function apply(changes, record = true) {
  changes = changes.filter(c => c.before !== c.after)
  if (!changes.length) return
  for (const c of changes) {
    if (c.after) els.set(c.id, c.after)
    else { els.delete(c.id); sel.delete(c.id) }
  }
  order = null
  if (DESK) { deskOrigin(); deskView() }
  persist(changes.map(c => c.after ?? tombstone(c.before)))
  if (record) {
    undo.push(changes)
    if (undo.length > UNDO_MAX) undo.shift()
    redo.length = 0
  }
  refresh()
}
const add = list => apply(list.map(el => ({ id: el.id, before: null, after: el })))
const change = pairs => apply(pairs.map(([before, after]) => ({ id: before.id, before, after: stamp(after) })))
const remove = list => apply(list.map(el => ({ id: el.id, before: el, after: null })))

// Undo writes the earlier state again as a new revision: for the store (and later
// for other devices) an undo is just another change, never a rollback of history.
function step(from, to) {
  if (gesture || !from.length) return
  commitEditor()
  const entry = from.pop()
  const inverse = entry.map(c => ({ id: c.id, before: c.after, after: c.before ? stamp(c.before) : null }))
  apply(inverse, false)
  to.push(inverse)
  sel.clear()
  for (const c of inverse) if (c.after) sel.add(c.id)
  refresh()
}

// ── painting ────────────────────────────────────────────────────────────────
function readTheme() {
  const css = getComputedStyle(root)
  const v = name => css.getPropertyValue(name).trim()
  theme = { paper: v('--surface'), dot: v('--line-strong'), accent: v('--accent'), placeholder: v('--sunken'), handle: v('--surface') }
}
function picture(id) {
  let p = pictures.get(id)
  if (!p) {
    const img = new Image()
    p = { img, ok: false, ready: null }
    p.ready = sync.getBlob(id).then(found => new Promise(resolve => {
      if (!found) return resolve()
      img.onload = () => { p.ok = true; dirty(); resolve() }
      img.onerror = () => resolve()
      img.src = URL.createObjectURL(found.blob)
    }), () => {})
    pictures.set(id, p)
  }
  return p
}
const env = () => ({ dark: dark(), accent: theme.accent, placeholder: theme.placeholder, picture })
const invalidate = () => { if (!raf) raf = requestAnimationFrame(paint) }
const dirty = () => { staticDirty = true; invalidate() }

function sizeCanvas() {
  dpr = Math.min(window.devicePixelRatio || 1, 3)
  canvas.width = layer.width = Math.max(1, Math.round(W * dpr))
  canvas.height = layer.height = Math.max(1, Math.round(H * dpr))
  staticDirty = true
}
// The dot grid belongs to the paper: it pans and zooms with it, and thins out
// when zoomed far away instead of turning grey.
function paintGrid(c) {
  let stepW = 24
  while (stepW * view.z < 14) stepW *= 2
  while (stepW * view.z >= 28) stepW /= 2
  const s = stepW * view.z, fade = (s - 14) / 14, size = Math.max(1, Math.round(1.5 * dpr)) / dpr
  const i0 = Math.floor(-view.x / s), j0 = Math.floor(-view.y / s)
  const major = new Path2D(), minor = new Path2D()
  for (let j = j0; j * s + view.y < H; j++) {
    for (let i = i0; i * s + view.x < W; i++) {
      const x = Math.round((i * s + view.x) * dpr) / dpr, y = Math.round((j * s + view.y) * dpr) / dpr
      ;(i % 2 === 0 && j % 2 === 0 ? major : minor).rect(x - size / 2, y - size / 2, size, size)
    }
  }
  c.fillStyle = theme.dot
  c.fill(major)
  c.globalAlpha = fade
  c.fill(minor)
  c.globalAlpha = 1
}
function paintLayer() {
  const c = lctx
  c.setTransform(dpr, 0, 0, dpr, 0, 0)
  c.fillStyle = theme.paper
  c.fillRect(0, 0, W, H)
  paintGrid(c)
  c.setTransform(dpr * view.z, 0, 0, dpr * view.z, dpr * view.x, dpr * view.y)
  const [x0, y0] = toWorld(0, 0), [x1, y1] = toWorld(W, H)
  const e = env()
  for (const rec0 of ordered()) {
    const el = shown(rec0)
    if (el.id === edit?.id || gesture?.erased?.has(el.id)) continue
    if (el.x > x1 || el.y > y1 || el.x + el.w < x0 || el.y + el.h < y0) continue
    paintElement(c, el, e)
  }
}
const HANDLES = [[-1, -1], [1, -1], [-1, 1], [1, 1]]
function selectionBox() {
  const list = selected().map(shown)
  return list.length ? { list, box: unionBox(list) } : null
}
function paint(now) {
  raf = 0
  if (!W || !H) return
  if (Math.min(window.devicePixelRatio || 1, 3) !== dpr) sizeCanvas()
  if (anim) {
    const t = clamp(((now ?? performance.now()) - anim.t0) / anim.ms, 0, 1), k = 1 - (1 - t) ** 3
    const a = anim.from, b = anim.to, done = t >= 1
    view.x = done ? b.x : a.x + (b.x - a.x) * k
    view.y = done ? b.y : a.y + (b.y - a.y) * k
    view.z = done ? b.z : a.z * (b.z / a.z) ** k
    $('zoom').textContent = `${Math.round(view.z * 100)} %`
    staticDirty = true
    if (done) { anim = null; saveViewSoon() } else raf = requestAnimationFrame(paint)
  }
  if (staticDirty) { paintLayer(); staticDirty = false }
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.drawImage(layer, 0, 0)

  if (gesture?.type === 'draw' && gesture.moved) {
    ctx.setTransform(dpr * view.z, 0, 0, dpr * view.z, dpr * view.x, dpr * view.y)
    const s = { tool: gesture.tool, color: gesture.color, size: gesture.size, pts: gesture.pts, pr: gesture.pen ? gesture.pr : undefined }
    paintStroke(ctx, s, dark(), buildGeom(s))
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  const S = selectionBox()
  if (S) {
    ctx.strokeStyle = theme.accent
    ctx.lineWidth = 1
    for (const el of S.list) ctx.strokeRect(el.x * view.z + view.x - 3, el.y * view.z + view.y - 3, el.w * view.z + 6, el.h * view.z + 6)
    const x = S.box.x * view.z + view.x - 3, y = S.box.y * view.z + view.y - 3, w = S.box.w * view.z + 6, h = S.box.h * view.z + 6
    if (S.list.length > 1) {
      ctx.setLineDash([5, 4])
      ctx.strokeRect(x, y, w, h)
      ctx.setLineDash([])
    }
    if (gesture?.type !== 'move') {
      for (const [hx, hy] of HANDLES) {
        ctx.beginPath()
        ctx.arc(hx < 0 ? x : x + w, hy < 0 ? y : y + h, 5.5, 0, Math.PI * 2)
        ctx.fillStyle = theme.handle
        ctx.fill()
        ctx.lineWidth = 2
        ctx.stroke()
      }
    }
  }
  // what has been sent to a session carries a small mark at its corner
  ctx.fillStyle = theme.accent
  for (const rec0 of ordered()) {
    if (!rec0.sent?.length) continue
    const el = shown(rec0)
    ctx.beginPath()
    ctx.arc((el.x + el.w) * view.z + view.x + 2, el.y * view.z + view.y - 2, 4, 0, Math.PI * 2)
    ctx.fill()
  }
  if (gesture?.type === 'marquee' && gesture.moved) {
    const x = Math.min(gesture.px, gesture.qx), y = Math.min(gesture.py, gesture.qy)
    const w = Math.abs(gesture.qx - gesture.px), h = Math.abs(gesture.qy - gesture.py)
    ctx.globalAlpha = 0.1
    ctx.fillStyle = theme.accent
    ctx.fillRect(x, y, w, h)
    ctx.globalAlpha = 1
    ctx.strokeStyle = theme.accent
    ctx.lineWidth = 1
    ctx.strokeRect(x + 0.5, y + 0.5, w, h)
  }
  if (gesture?.type === 'area' && gesture.moved) {
    sketchFrame(ctx, Math.min(gesture.px, gesture.qx), Math.min(gesture.py, gesture.qy), Math.abs(gesture.qx - gesture.px), Math.abs(gesture.qy - gesture.py))
  } else if (area && !area.gone) {
    sketchFrame(ctx, area.x * view.z + view.x, area.y * view.z + view.y, area.w * view.z, area.h * view.z, area.cut)
  }
  if (tool === 'eraser' && hover) {
    ctx.beginPath()
    ctx.arc(hover[0], hover[1], ERASER_R, 0, Math.PI * 2)
    ctx.strokeStyle = theme.accent
    ctx.lineWidth = 1.25
    ctx.stroke()
  }
  placeOverlays(S)
}

/** A frame as a hand draws it with a dashed pen: the sides wander a little and overshoot the corners.
 *  cut: the moment of the snip, drawn through. */
function sketchFrame(c, x, y, w, h, cut = false) {
  const J = [1.6, -1.2, 0.9, -1.7, 1.3, -0.8, 1.1, -1.4]
  const side = (ax, ay, bx, by, i) => {
    const nx = -(by - ay), ny = bx - ax, len = Math.hypot(nx, ny) || 1
    const ox = (nx / len) * J[i], oy = (ny / len) * J[i]
    const ex = ((bx - ax) / len) * 5, ey = ((by - ay) / len) * 5   // past the corner, like a quick stroke
    c.moveTo(ax - ex + ox * 0.4, ay - ey + oy * 0.4)
    c.quadraticCurveTo((ax + bx) / 2 + ox * 1.6, (ay + by) / 2 + oy * 1.6, bx + ex - ox * 0.5, by + ey - oy * 0.5)
  }
  c.save()
  c.globalAlpha = 0.07
  c.fillStyle = theme.accent
  c.fillRect(x, y, w, h)
  c.globalAlpha = 1
  c.beginPath()
  side(x, y, x + w, y, 0); side(x + w, y, x + w, y + h, 1); side(x + w, y + h, x, y + h, 2); side(x, y + h, x, y, 3)
  c.strokeStyle = theme.accent
  c.lineWidth = cut ? 2.4 : 1.8
  c.lineCap = 'round'
  c.setLineDash(cut ? [] : [8, 6])
  c.stroke()
  c.restore()
}

// DOM that sits on the paper follows pan and zoom here, once per frame.
function placeOverlays(S) {
  placeAreaMenu()
  if (edit) {
    editor.style.transform = `translate(${view.x + edit.x * view.z}px, ${view.y + edit.y * view.z}px) scale(${view.z})`
    const tip = $('caret-tip')
    if (!tip.hidden) tip.style.transform = `translate(${Math.round(clamp(view.x + edit.x * view.z, 8, Math.max(8, W - tip.offsetWidth - 8)))}px, ${Math.round(view.y + (edit.y + edit.size * 1.35) * view.z + 8)}px)`
  }
  if (rec) {
    const node = $('rec')
    node.style.transform = `translate(${Math.round(clamp(view.x + rec.x * view.z, 8, Math.max(8, W - node.offsetWidth - 8)))}px, ${Math.round(clamp(view.y + rec.y * view.z - 22, 60, Math.max(60, H - 150)))}px)`
  }
  const bar = $('selbar')
  const show = Boolean(S) && !gesture && !edit
  if (bar.hidden === show) { bar.hidden = !show; if (!show) closeSendMenu() }
  if (!show) return
  const bw = bar.offsetWidth, bh = bar.offsetHeight
  const x = S.box.x * view.z + view.x, y = S.box.y * view.z + view.y, w = S.box.w * view.z, h = S.box.h * view.z
  let ty = y - bh - 16
  if (ty < 60) ty = y + h + 16
  if (ty + bh > H - 76) ty = clamp(y + 12, 60, Math.max(60, H - 76 - bh))
  const tx = clamp(x + w / 2 - bw / 2, 8, Math.max(8, W - bw - 8))
  bar.style.transform = `translate(${Math.round(tx)}px, ${Math.round(ty)}px)`
  const menu = $('send-menu')
  if (!menu.hidden) {
    const below = ty + bh + 6 + menu.offsetHeight < H - 8
    menu.style.transform = `translate(${Math.round(clamp(tx, 8, Math.max(8, W - menu.offsetWidth - 8)))}px, ${Math.round(below ? ty + bh + 6 : Math.max(8, ty - menu.offsetHeight - 6))}px)`
  }
}

// ── view ────────────────────────────────────────────────────────────────────
const VIEW_KEY = `${DESK ? 'deskview' : 'view'}:${PAD}`   // the Desk's paper keeps the pen, not a view
let viewTimer = 0
function saveViewSoon() {
  clearTimeout(viewTimer)
  viewTimer = setTimeout(() => db?.meta(VIEW_KEY, { ...view, style, tool: drawTool }).catch(() => {}), 500)
}
function setView(x, y, z) {
  if (DESK) return deskView()
  view.x = x; view.y = y; view.z = z
  $('zoom').textContent = `${Math.round(z * 100)} %`
  saveViewSoon()
  dirty()
}
function animateTo(x, y, z, animate = true) {
  if (DESK) return deskView()
  if (!animate || reduced() || !W) { anim = null; return setView(x, y, z) }
  anim = { from: { ...view }, to: { x, y, z }, t0: performance.now(), ms: 260 }
  invalidate()
}
function zoomAt(px, py, factor, animate = false) {
  const z = clamp(view.z * factor, MIN_Z, MAX_Z)
  const [wx, wy] = toWorld(px, py)
  animateTo(px - wx * z, py - wy * z, z, animate)
}
function fit(animate = true) {
  const b = unionBox(ordered())
  if (!b) return animateTo(W / 2, H / 2, 1, animate)
  const padX = 28, padT = 72, padB = 92
  const aw = Math.max(40, W - 2 * padX), ah = Math.max(40, H - padT - padB)
  const z = clamp(Math.min(1, aw / b.w, ah / b.h), MIN_Z, MAX_Z)
  animateTo(padX + (aw - b.w * z) / 2 - b.x * z, padT + (ah - b.h * z) / 2 - b.y * z, z, animate)
}

// ── chrome ──────────────────────────────────────────────────────────────────
function refresh() {
  $('undo').disabled = !undo.length
  $('redo').disabled = !redo.length
  $('fit').disabled = !els.size
  $('hint').dataset.show = String(!els.size && !edit && !rec && !gesture)
  for (const b of document.querySelectorAll('.pad-tool')) b.setAttribute('aria-pressed', String(b.dataset.tool === tool))
  pad.dataset.tool = tool
  if (DESK) {
    // A finger scrolls the Desk unless it holds a tool that draws, or something is selected and can be moved.
    pad.dataset.touch = (tool === 'select' || tool === 'text') && !sel.size && !rec ? 'scroll' : 'draw'
    deskExtent()
    // In front: a tool is in hand, or something on the paper is held. The Desk's cards then let everything through
    // (and go faint); with the bare pointer they work as always. The tools show while the paper is in front.
    const front = tool !== 'select' || sel.size > 0 || Boolean(edit) || Boolean(area) || Boolean(rec)
    pad.toggleAttribute('data-started', front)
    if (front !== desk.front) { desk.front = front; tell('front', { front, tool }) }
  }
  const st = style[drawTool]
  // each drawing tool shows the colour it draws in
  for (const k of ['pen', 'hl']) toolButton(k).style.setProperty('--c', resolveInk(style[k].color, dark()))
  for (const b of $('swatches').children) b.setAttribute('aria-pressed', String(b.dataset.color === st.color))
  ;[...$('widths').children].forEach((b, i) => b.setAttribute('aria-pressed', String(i === st.w)))
  const list = selected()
  const grouped = list.length > 1 && list[0].group && list.every(e => e.group === list[0].group)
  $('group').disabled = list.length < 2
  $('group').setAttribute('aria-pressed', String(Boolean(grouped)))
  $('group').setAttribute('aria-label', grouped ? 'Ungroup' : 'Group')
  $('group').dataset.tip = grouped ? 'Ungroup · Ctrl+Shift+G' : 'Group · Ctrl+G'
  $('mic').setAttribute('aria-pressed', String(Boolean(rec)))
  renderStatus()
  updateCursor()
  dirty()
}
function renderStatus() {
  const b = boardState()
  const n = els.size
  const s = sync?.state() ?? { mode: 'starting', pending: 0 }
  const waiting = s.pending ? `, ${s.pending} to send` : ''
  const where = saveError ? 'could not be saved on this device'
    : s.error ? `the board refused a change (${s.error})`
    : s.mode === 'online' ? (s.pending ? `saving ${s.pending}…` : 'saved on the board')
    : s.mode === 'offline' ? `no connection: kept on this device${waiting}`
    : s.mode === 'starting' ? 'loading'
    : db?.kind === 'memory' ? 'not kept (this browser refuses storage)' : 'saved on this device only'
  const board = b.board ? `board: ${b.sessions.length} session${b.sessions.length === 1 ? '' : 's'}${b.speech ? '' : ', speech is a stub'}` : 'no board: sample sessions, speech is a stub'
  $('status').textContent = `${n} element${n === 1 ? '' : 's'} · ${where} · ${board}`
  $('status').dataset.kind = saveError || s.error ? 'error' : s.mode === 'offline' ? 'warn' : ''
  pad.dataset.sync = s.mode
}
function updateCursor(mode) {
  pad.dataset.cursor = mode ?? (spaceDown ? 'grab' : tool === 'select' ? 'select' : tool === 'eraser' ? 'eraser' : tool === 'area' ? 'area' : tool === 'text' ? 'text' : 'draw')
}
let toastTimer = 0
function toast(text, kind = 'info', ms = 2800) {
  clearTimeout(toastTimer)
  const node = $('toast')
  node.textContent = text
  node.dataset.kind = kind
  node.hidden = false
  if (ms) toastTimer = setTimeout(() => { node.hidden = true }, ms)
}

function buildSwatches() {
  $('swatches').replaceChildren(...(drawTool === 'hl' ? HL_COLORS : PEN_COLORS).map(([color, name]) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'pad-swatch'
    b.setAttribute('aria-label', name)
    b.dataset.color = color
    b.addEventListener('click', () => {
      style[drawTool].color = color
      // a colour picked with notes selected recolours them
      const texts = selected().filter(isText)
      if (texts.length && drawTool === 'pen') change(texts.map(e => [e, { ...e, data: { ...e.data, color } }]))
      if (tool !== drawTool) setTool(drawTool); else refresh()
      saveViewSoon()
    })
    return b
  }))
  paintSwatches()
}
const paintSwatches = () => { for (const b of $('swatches').children) b.style.setProperty('--c', resolveInk(b.dataset.color, dark())) }
$('widths').replaceChildren(...[0, 1, 2, 3].map(i => {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'pad-width'
  b.setAttribute('aria-label', `Width ${i + 1}`)
  b.style.setProperty('--d', `${[5, 9, 13, 18][i]}px`)
  b.append(Object.assign(document.createElement('span'), { className: 'pad-dot' }))
  b.addEventListener('click', () => setWidth(i))
  return b
}))
function setTool(next) {
  commitEditor()
  if (next === 'area' && tool !== 'area') { toolBefore = tool; sel.clear() }
  if (next !== 'area') clearArea()
  tool = next
  if (next === 'pen' || next === 'hl') {
    if (drawTool !== next) { drawTool = next; buildSwatches() }
  } else closeStyle()
  if (next !== 'eraser') hover = null
  if (next === 'eraser') sel.clear()
  refresh()
}
function setWidth(i) {
  style[drawTool].w = i
  if (tool !== drawTool) setTool(drawTool); else refresh()
  saveViewSoon()
}
const toolButton = name => document.querySelector(`.pad-tool[data-tool="${name}"]`)
const closeStyle = () => { $('style').hidden = true; for (const k of ['pen', 'hl']) toolButton(k).setAttribute('aria-expanded', 'false') }
/** Colour and width come up at the tool they belong to: a click on the pen that is already in hand. */
function toggleStyle() {
  if (!$('style').hidden) return closeStyle()
  if (tool !== drawTool) setTool(drawTool)
  const box = $('style'), b = toolButton(drawTool)
  box.hidden = false
  b.setAttribute('aria-expanded', 'true')
  const left = box.parentElement.getBoundingClientRect().left, half = box.offsetWidth / 2
  box.style.left = `${clamp(b.offsetLeft + b.offsetWidth / 2, 8 - left + half, Math.max(8 - left + half, W - 8 - left - half))}px`
}
const closePopovers = () => { closeStyle(); closeSendMenu(); if (!area?.sending) clearArea() }

// ── selection ───────────────────────────────────────────────────────────────
/** The ids that go together with this element: its group, or itself. */
const mates = el => (el.group ? ordered().filter(e => e.group === el.group).map(e => e.id) : [el.id])
function select(el, additive) {
  const ids = mates(el)
  if (!additive) { sel.clear(); for (const id of ids) sel.add(id); return }
  const all = ids.every(id => sel.has(id))
  for (const id of ids) all ? sel.delete(id) : sel.add(id)
}
function topAt(wx, wy, touch) {
  const tol = (touch ? 14 : 6) / view.z
  const list = ordered()
  // A highlighter stroke is see-through: what lies under it at this point is what the click means.
  // The stroke itself is picked where nothing else is under it.
  let marker = null
  for (let k = list.length - 1; k >= 0; k--) {
    if (!hitElement(list[k], wx, wy, tol)) continue
    if (list[k].type !== 'stroke' || list[k].data.tool !== 'hl') return list[k]
    marker ??= list[k]
  }
  return marker
}
/** The corner handle of the selection under a screen point: [sx, sy] with ±1 each, or null. */
function hitHandle(px, py, touch) {
  const S = selectionBox()
  if (!S) return null
  const r = touch ? 22 : 11
  let best = null, bestD = r
  for (const [hx, hy] of HANDLES) {
    const cx = (S.box.x + (hx > 0 ? S.box.w : 0)) * view.z + view.x + hx * 3, cy = (S.box.y + (hy > 0 ? S.box.h : 0)) * view.z + view.y + hy * 3
    const d = Math.hypot(px - cx, py - cy)
    if (d <= bestD) { best = [hx, hy]; bestD = d }
  }
  return best
}
function reorder(toFront) {
  const list = selected()
  if (!list.length) return
  const rest = ordered().filter(e => !sel.has(e.id))
  if (!rest.length) return
  // z is a plain number per element: to the front is "above the highest other", so
  // only the moved records are written, never the whole pad
  const edge = toFront ? Math.max(...rest.map(e => e.z)) : Math.min(...rest.map(e => e.z))
  change(list.map((e, i) => [e, { ...e, z: toFront ? edge + 1 + i : edge - list.length + i }]))
}
function toggleGroup(force) {
  const list = selected()
  if (list.length < 2 && force !== false) return
  const grouped = list.length && list[0].group && list.every(e => e.group === list[0].group)
  const ungroup = force === false || (force == null && grouped)
  if (ungroup) return change(list.filter(e => e.group).map(e => [e, { ...e, group: null }]))
  const id = newId()
  change(list.map(e => [e, { ...e, group: id }]))
  toast(`${list.length} elements grouped`)
}
function duplicate() {
  const list = selected()
  if (!list.length) return
  const off = 24 / view.z, groups = new Map()
  let z = topZ()
  const copies = list.map(e => {
    if (e.group && !groups.has(e.group)) groups.set(e.group, newId())
    return make(e.type, { x: e.x + off, y: e.y + off, w: e.w, h: e.h }, e.data, ++z, e.blob)
  }).map((c, i) => ({ ...c, group: list[i].group ? groups.get(list[i].group) : null }))
  add(copies)
  sel.clear()
  for (const c of copies) sel.add(c.id)
  refresh()
}
function nudge(dx, dy) {
  const list = selected()
  if (list.length) change(list.map(e => [e, { ...e, x: r2(e.x + dx), y: r2(e.y + dy) }]))
}

// ── the note being typed ────────────────────────────────────────────────────
function openEditor(spec, text = '') {
  edit = spec
  editor.hidden = false
  editor.textContent = text
  editor.contentEditable = 'plaintext-only'
  if (editor.contentEditable !== 'plaintext-only') editor.contentEditable = 'true'
  editor.style.font = textFont(spec.size)
  editor.style.lineHeight = '1.35'
  editor.style.color = resolveInk(spec.color, dark())
  editor.style.maxWidth = `${spec.wrap ?? TEXT_WRAP * (spec.size / TEXT_SIZE)}px`
  editor.style.paddingLeft = spec.type === 'voice' ? `${14 * (spec.size / TEXT_SIZE)}px` : '0'
  $('caret-tip').hidden = Boolean(spec.id || text)
  refresh()
  placeOverlays(null)
  editor.focus({ preventScroll: true })
  if (text) {
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    getSelection().removeAllRanges()
    getSelection().addRange(range)
  }
}
/** The width a new note at this spot may take before its lines break: the default,
 *  or less when the edge of the screen is nearer (a phone). null means the default. */
function wrapAt(wx) {
  const room = (W - 16 - (wx * view.z + view.x)) / view.z
  return room < TEXT_WRAP ? r2(Math.max(160 / view.z, room)) : null
}
/** Put the cursor on empty paper. The click point is the middle of the first line. */
function placeCaret(wx, wy) {
  const size = TEXT_SIZE
  sel.clear()
  openEditor({ id: null, type: 'text', x: r2(wx), y: r2(wy - (size * 1.35) / 2), size, color: style.pen.color, wrap: wrapAt(wx) })
}
function editElement(el) {
  sel.clear()
  openEditor({ id: el.id, type: el.type, x: el.x, y: el.y, size: el.data.size, color: el.data.color, wrap: el.data.wrap }, el.data.text)
}
/** Close the note and keep what was typed. Returns the element it became, if any. */
function commitEditor() {
  if (!edit) return null
  const spec = edit
  edit = null
  const text = editor.innerText.replace(/\r/g, '').replace(/ /g, ' ').replace(/\s+$/, '')
  editor.hidden = true
  editor.textContent = ''
  $('caret-tip').hidden = true
  if (document.activeElement === editor) editor.blur()
  let out = null
  if (spec.id) {
    const el = els.get(spec.id)
    if (el && !text) remove([el])
    else if (el && text !== el.data.text) {
      const data = { ...el.data, text }
      const lay = layoutText(data, el.type)
      change([[el, { ...el, data, w: lay.w, h: lay.h }]])
      out = els.get(el.id)
    } else out = el ?? null
  } else if (text) {
    out = makeText('text', spec.x, spec.y, { text, size: spec.size, color: spec.color, wrap: spec.wrap })
    add([out])
  }
  refresh()
  return out
}
editor.addEventListener('input', () => { $('caret-tip').hidden = Boolean(edit?.id) || editor.textContent.length > 0 })
editor.addEventListener('keydown', e => {
  if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
    e.preventDefault()
    e.stopPropagation()
    const el = commitEditor()
    if (el && !DESK) { sel.clear(); sel.add(el.id); refresh() }   // on the Desk the note is simply done: the cards answer again
  } else if ((e.key === 'm' || e.key === 'M') && e.ctrlKey) {
    e.preventDefault()
    e.stopPropagation()
    toggleRecording()
  }
})
editor.addEventListener('blur', () => {
  // the window lost focus (another tab, a dialog): the note stays open
  setTimeout(() => { if (edit && document.hasFocus() && document.activeElement !== editor && !rec) commitEditor() }, 0)
})
editor.addEventListener('paste', e => {
  const files = [...(e.clipboardData?.files ?? [])].filter(f => f.type.startsWith('image/'))
  if (!files.length) return
  e.preventDefault()
  const at = [view.x + edit.x * view.z, view.y + edit.y * view.z]
  commitEditor()
  addImages(files, at)
})

// ── speaking ────────────────────────────────────────────────────────────────
// On a board with a speech key, the audio goes to the board and the transcript
// comes back. Anywhere else the flow is the same, but nothing is recorded and a
// sample sentence lands: the element says so in data.stub.
const fmt = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`
async function startRecording(wx, wy, held = false) {
  if (rec) return
  commitEditor()
  sel.clear()
  const stub = !boardState().speech
  rec = { x: wx, y: wy, t0: performance.now(), stub, held, state: 'recording', chunks: [], recorder: null, stream: null, timer: 0, stopped: false }
  const mine = rec
  $('rec').hidden = false
  $('rec').dataset.state = 'recording'
  $('rec-label').textContent = (stub ? 'Demo recording (no speech service)' : 'Recording') + (held ? ' · let go to finish' : '')
  $('rec-stop').hidden = held
  $('rec-time').textContent = '0:00'
  rec.timer = setInterval(() => { $('rec-time').textContent = fmt(performance.now() - mine.t0) }, 250)
  refresh()
  if (stub) return
  const fail = msg => { if (rec === mine) endRecording(); toast(msg, 'error', 5000) }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    return fail(window.isSecureContext ? 'This browser cannot record.' : 'The microphone only works over HTTPS or on localhost.')
  }
  try {
    mine.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch {
    return fail('No access to the microphone. Allow it in the browser settings.')
  }
  if (rec !== mine || mine.stopped) { mine.stream.getTracks().forEach(t => t.stop()); if (rec === mine) endRecording(); return }
  mine.t0 = performance.now()
  mine.recorder = new MediaRecorder(mine.stream)
  mine.recorder.ondataavailable = e => { if (e.data.size) mine.chunks.push(e.data) }
  mine.recorder.onstop = () => finishRecording(mine)
  mine.recorder.start()
}
function endRecording() {
  if (!rec) return
  clearInterval(rec.timer)
  rec.stream?.getTracks().forEach(t => t.stop())
  rec = null
  $('rec').hidden = true
  refresh()
}
/** Stop and transcribe; with discard, stop and forget. */
function stopRecording(discard = false) {
  if (!rec || rec.state !== 'recording') return
  rec.stopped = true
  rec.discard = discard
  if (rec.stub) return finishRecording(rec)
  if (rec.recorder) rec.recorder.stop()
  // no recorder yet: the microphone prompt is still open, startRecording cleans up
}
async function finishRecording(r) {
  if (rec !== r) return
  clearInterval(r.timer)
  r.stream?.getTracks().forEach(t => t.stop())
  const ms = Math.round(performance.now() - r.t0)
  if (r.discard) return endRecording()
  r.state = 'working'
  $('rec').dataset.state = 'working'
  $('rec-label').textContent = r.stub ? 'Demo transcript' : 'Transcribing'
  $('rec-stop').hidden = true
  let text = ''
  try {
    if (r.stub) {
      await new Promise(done => setTimeout(done, 500))
      text = SAMPLE_TRANSCRIPT
    } else {
      const blob = new Blob(r.chunks, { type: r.recorder.mimeType || 'audio/webm' })
      if (!blob.size) throw new Error('nothing was recorded')
      // Only the words are kept: the recording is gone once it has been transcribed.
      text = (await transcribe(blob)).trim()
      if (!text) throw new Error('no words were heard')
    }
  } catch (err) {
    if (rec === r) endRecording()
    return toast(`Not transcribed: ${err.message}`, 'error', 5000)
  }
  if (rec !== r) return
  endRecording()
  const size = TEXT_SIZE
  const el = makeText('voice', r2(r.x), r2(r.y - (size * 1.35) / 2), { text, size, color: style.pen.color, wrap: wrapAt(r.x), ms, stub: r.stub })
  add([el])
  sel.clear()
  sel.add(el.id)
  refresh()
  reveal(el)
}
/** Pan just enough that the element is clear of the bars: a note spoken at the foot of a
 *  phone screen would otherwise land under the toolbar. */
function reveal(el) {
  const top = 64, bottom = H - 96, left = 8, right = W - 8
  const x0 = el.x * view.z + view.x, y0 = el.y * view.z + view.y, x1 = x0 + el.w * view.z, y1 = y0 + el.h * view.z
  let dx = 0, dy = 0
  if (y1 > bottom) dy = bottom - y1
  if (y0 + dy < top) dy = top - y0
  if (x1 > right) dx = right - x1
  if (x0 + dx < left) dx = left - x0
  if (DESK) { if (dy) tell('scroll', { by: -dy }); return }
  if (dx || dy) animateTo(view.x + dx, view.y + dy, view.z)
}
/** Where a note lands when no spot was clicked: the open cursor, else the middle of the screen. */
function spot() {
  if (edit) return [edit.x, edit.y + (edit.size * 1.35) / 2]
  return toWorld(W / 2, H * 0.42)
}
function toggleRecording() {
  if (rec) return stopRecording()
  const [wx, wy] = spot()
  startRecording(wx, wy)
}
// these buttons must not take the focus from the open note: it marks the spot
for (const id of ['mic', 'caret-mic', 'image']) $(id).addEventListener('mousedown', e => e.preventDefault())
$('mic').addEventListener('click', toggleRecording)
$('caret-mic').addEventListener('click', toggleRecording)
$('rec-stop').addEventListener('click', () => stopRecording())
$('rec-cancel').addEventListener('click', () => stopRecording(true))

// ── pictures ────────────────────────────────────────────────────────────────
async function importImage(file) {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const nw = img.naturalWidth || 800, nh = img.naturalHeight || 600
    const k = Math.min(1, MAX_IMG / Math.max(nw, nh))
    if (k === 1 && file.size <= KEEP_BYTES && /^image\/(png|jpeg|webp|gif)$/.test(file.type)) return { blob: file, nw, nh }
    const w = Math.max(1, Math.round(nw * k)), h = Math.max(1, Math.round(nh * k))
    const cv = document.createElement('canvas')
    cv.width = w; cv.height = h
    const c = cv.getContext('2d')
    c.imageSmoothingQuality = 'high'
    c.drawImage(img, 0, 0, w, h)
    const encode = (type, q) => new Promise(resolve => cv.toBlob(resolve, type, q))
    // WebP keeps transparency and is small; a browser that cannot encode it hands back PNG
    const blob = (await encode('image/webp', 0.86)) ?? (await encode('image/png'))
    return { blob, nw: w, nh: h }
  } finally {
    URL.revokeObjectURL(url)
  }
}
async function addImages(files, at) {
  const list = [...files].filter(f => f.type.startsWith('image/'))
  if (!list.length) return toast('That is not a picture.', 'error')
  toast(list.length > 1 ? `Adding ${list.length} pictures…` : 'Adding the picture…', 'busy', 0)
  const added = []
  let failed = 0, z = topZ()
  for (const f of list) {
    try {
      const { blob, nw, nh } = await importImage(f)
      const id = newId()
      await sync.putBlob({ id, type: blob.type, blob })
      await picture(id).ready
      const k = Math.min(1, (0.6 * W) / view.z / nw, (0.5 * Math.max(120, H - 150)) / view.z / nh)
      const w = r2(nw * k), h = r2(nh * k)
      const [cx, cy] = at ? toWorld(at[0], at[1]) : toWorld(W / 2, (H - 20) / 2)
      const off = (added.length * 28) / view.z
      added.push(make('image', { x: cx - w / 2 + off, y: cy - h / 2 + off, w, h }, { mime: blob.type, nw, nh, name: f.name || '' }, ++z, id))
    } catch { failed++ }
  }
  $('toast').hidden = true
  if (failed) toast(failed > 1 ? `${failed} pictures could not be read.` : 'The picture could not be read.', 'error', 4000)
  if (!added.length) return
  add(added)
  sel.clear()
  for (const el of added) sel.add(el.id)
  refresh()
}

// ── pointer input ───────────────────────────────────────────────────────────
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
function endDraw(g) {
  if (!g.pts.length) return
  const pr = g.pen && g.pr.some(p => Math.abs(p - g.pr[0]) > 0.03) ? g.pr : null
  const s = strokeFromWorld(g.pts, pr, { tool: g.tool, color: g.color, size: g.size })
  add([make('stroke', s, s.data)])
}
function erase(g, px, py) {
  const [wx, wy] = toWorld(px, py)
  const r = ERASER_R / view.z
  for (const el of ordered()) {
    if (el.type === 'stroke' && !g.erased.has(el.id) && strokeNear(el, g.wx, g.wy, wx, wy, r)) g.erased.add(el.id)
  }
  g.wx = wx; g.wy = wy
  dirty()
}
/** Stop the running one-pointer gesture without keeping it, e.g. because a second finger arrived. */
function abortGesture() {
  const g = gesture
  gesture = null
  preview = null
  if (!g) return
  clearTimeout(g.hold)
  if (g.type === 'draw' && g.moved && performance.now() - g.t0 > 350 && g.pts.length > 24) endDraw(g)
  if (g.type === 'erase' && g.erased.size) remove([...g.erased].map(id => els.get(id)).filter(Boolean))
  if (g.type === 'speak') stopRecording(true)
  dirty()
}
function startPinch() {
  const [a, b] = [...pointers.values()]
  gesture = { type: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, view: { ...view } }
}
/** A press on empty paper that stays put turns into a recording. */
function armHold(g, wx, wy) {
  g.hold = setTimeout(() => {
    if (gesture !== g || g.moved || rec) return
    gesture = { type: 'speak', id: g.id }
    startRecording(wx, wy, true)
  }, HOLD_MS)
}

canvas.addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse' && (e.button === 2 || (DESK && e.button === 1))) return
  // The tools come when he starts. A finger that only scrolls the Desk has not started: its tap counts, when it lifts.
  if (DESK && (e.pointerType !== 'touch' || pad.dataset.touch === 'draw')) pad.dataset.started = ''
  closePopovers()
  anim = null
  commitEditor()
  try { canvas.setPointerCapture(e.pointerId) } catch {}
  const [px, py] = local(e)
  const touch = e.pointerType === 'touch'
  if (e.pointerType === 'mouse') pointers.clear()
  pointers.set(e.pointerId, { x: px, y: py, sx: e.screenX, sy: e.screenY })
  if (touch && pointers.size === 2) { abortGesture(); startPinch(); refresh(); return }
  if (gesture || pointers.size > 1) return
  const [wx, wy] = toWorld(px, py)
  const base = { id: e.pointerId, px, py, qx: px, qy: py, wx, wy, moved: false, shift: e.shiftKey, touch, t0: performance.now() }

  if ((e.button === 1 || spaceDown) && !DESK) {
    e.preventDefault()
    gesture = { ...base, type: 'pan', vx: view.x, vy: view.y }
  } else if (rec) {
    gesture = { ...base, type: 'idle' }   // a recording is running: the paper waits
  } else if (tool === 'area') {
    gesture = { ...base, type: 'area' }
  } else if (tool === 'text') {
    gesture = { ...base, type: 'type', hit: topAt(wx, wy, touch) }   // a click puts the cursor there, or into the note under it
  } else if (tool === 'eraser') {
    gesture = { ...base, type: 'erase', erased: new Set() }
    hover = [px, py]
    erase(gesture, px, py)
  } else {
    const handle = hitHandle(px, py, touch)
    const hit = handle ? null : topAt(wx, wy, touch)
    if (handle) {
      const S = selectionBox()
      gesture = { ...base, type: 'resize', list: selected(), box: S.box, ax: S.box.x + (handle[0] < 0 ? S.box.w : 0), ay: S.box.y + (handle[1] < 0 ? S.box.h : 0) }
    } else if (hit && sel.has(hit.id)) {
      gesture = { ...base, type: 'move', hit, list: selected() }
    } else if (tool === 'select' && hit) {
      select(hit, e.shiftKey)
      gesture = { ...base, type: 'move', hit, list: selected(), fresh: true }
    } else if (DESK && touch && pad.dataset.touch === 'scroll' && !hit) {
      gesture = { ...base, type: 'deskpan' }   // up and down the browser scrolls the Desk; sideways the paper pans
    } else if (tool === 'select' || (e.shiftKey && !hit)) {
      gesture = { ...base, type: 'marquee', keep: e.shiftKey ? new Set(sel) : new Set() }
      if (!e.shiftKey && !(DESK && touch)) armHold(gesture, wx, wy)   // on the Desk a resting finger is about to scroll, not to speak
    } else {
      const st = style[tool]
      gesture = { ...base, type: 'draw', hit, tool, color: st.color, size: SIZES[tool][st.w], pen: tool === 'pen' && e.pointerType === 'pen', pts: [], pr: [] }
      addPoint(gesture, e, true)
      if (!hit) armHold(gesture, wx, wy)
    }
  }
  refresh()
  if (gesture?.type === 'pan') updateCursor('grabbing')
})

canvas.addEventListener('pointermove', e => {
  const [px, py] = local(e)
  const ptr = pointers.get(e.pointerId)
  if (ptr) { ptr.x = px; ptr.y = py; ptr.sx = e.screenX; ptr.sy = e.screenY }
  const g = gesture
  if (!g) {
    if (e.pointerType !== 'touch') {
      if (tool === 'eraser') { hover = [px, py]; invalidate() }
      else if (!spaceDown) {
        const h = hitHandle(px, py, false)
        const [wx, wy] = toWorld(px, py)
        const over = h ? null : topAt(wx, wy, false)
        updateCursor(h ? (h[0] * h[1] > 0 ? 'nwse' : 'nesw') : over && (sel.has(over.id) || tool === 'select') ? 'move' : undefined)
      }
    }
    return
  }
  if (g.type === 'pinch') {
    if (pointers.size < 2) return
    const [a, b] = [...pointers.values()]
    if (DESK) {
      // With the bare pointer two fingers are the Desk's: the browser scrolls, and a pinch zooms the paper (js/padlink.js).
      if (pad.dataset.touch === 'scroll') return
      // With a tool in hand two fingers move the paper: up and down scrolls the Desk, sideways pans. Measured on the
      // screen, because this frame itself moves while the Desk scrolls.
      const sx = (a.sx + b.sx) / 2, sy = (a.sy + b.sy) / 2
      if (g.sy != null) { tell('scroll', { by: g.sy - sy }); deskPan(g.sx - sx) }
      g.sx = sx; g.sy = sy
      return
    }
    const z = clamp(g.view.z * (Math.hypot(a.x - b.x, a.y - b.y) || 1) / g.d, MIN_Z, MAX_Z)
    const wx = (g.cx - g.view.x) / g.view.z, wy = (g.cy - g.view.y) / g.view.z
    return setView((a.x + b.x) / 2 - wx * z, (a.y + b.y) / 2 - wy * z, z)
  }
  if (g.id !== e.pointerId) return
  g.qx = px; g.qy = py
  if (!g.moved && Math.hypot(px - g.px, py - g.py) > CLICK_PX) { g.moved = true; clearTimeout(g.hold) }
  if (g.type === 'pan') return setView(g.vx + px - g.px, g.vy + py - g.py, view.z)
  if (g.type === 'deskpan') { if (g.moved) { deskPan((g.lx ?? g.px) - px); g.lx = px } return }
  if (g.type === 'draw') {
    const list = e.getCoalescedEvents?.() ?? []
    for (const c of list.length ? list : [e]) addPoint(g, c, false)
    return invalidate()
  }
  if (g.type === 'erase') { hover = [px, py]; return erase(g, px, py) }
  if (g.type === 'area') return invalidate()
  const [wx, wy] = toWorld(px, py)
  if (g.type === 'marquee') {
    if (!g.moved) return
    const x0 = Math.min(g.wx, wx), y0 = Math.min(g.wy, wy), x1 = Math.max(g.wx, wx), y1 = Math.max(g.wy, wy)
    sel.clear()
    for (const id of g.keep) sel.add(id)
    for (const el of ordered()) if (inRect(el, x0, y0, x1, y1)) for (const id of mates(el)) sel.add(id)
    return invalidate()
  }
  if (g.type === 'move') {
    if (!g.moved) return
    const dx = wx - g.wx, dy = wy - g.wy
    preview = new Map(g.list.map(el => [el.id, { ...el, x: r2(el.x + dx), y: r2(el.y + dy) }]))
    return dirty()
  }
  if (g.type === 'resize') {
    const min = 12 / view.z / Math.max(g.box.w, g.box.h)
    const k = Math.max(Math.abs(wx - g.ax) / g.box.w, Math.abs(wy - g.ay) / g.box.h, min)
    preview = new Map(g.list.map(el => [el.id, scaled(el, k, g.ax, g.ay)]))
    return dirty()
  }
})

function pointerEnd(e) {
  const had = pointers.delete(e.pointerId)
  if (DESK && had && e.type === 'pointerup') pad.dataset.started = ''
  const g = gesture
  if (!g || !had) return
  if (g.type === 'pinch') {
    if (pointers.size < 2) gesture = null
    return refresh()
  }
  if (g.id !== e.pointerId) return
  gesture = null
  clearTimeout(g.hold)
  const cancelled = e.type === 'pointercancel'
  const click = !g.moved && !cancelled
  if (g.type === 'speak') stopRecording(cancelled)
  else if (g.type === 'draw') {
    if (g.moved && !cancelled) { addPoint(g, e, true); endDraw(g) }
    else if (click && g.hit) { select(g.hit, g.shift); lastClick = { id: g.hit.id, t: performance.now() } }
    else if (click) placeCaret(g.wx, g.wy)
  } else if (g.type === 'marquee' || g.type === 'deskpan') {
    if (click && !g.shift) placeCaret(g.wx, g.wy)
  } else if (g.type === 'type') {
    if (click && g.hit && isText(g.hit) && els.has(g.hit.id)) editElement(els.get(g.hit.id))
    else if (click) placeCaret(g.wx, g.wy)
  } else if (g.type === 'area') {
    if (g.moved && !cancelled) frameArea(g)
  } else if (g.type === 'erase') {
    if (e.pointerType === 'touch') hover = null
    if (g.erased.size) remove([...g.erased].map(id => els.get(id)).filter(Boolean))
  } else if (g.type === 'move' || g.type === 'resize') {
    const next = preview
    preview = null
    if (next && !cancelled) change(g.list.map(el => [el, next.get(el.id)]))
    else if (click && g.type === 'move') {
      const now = performance.now()
      const twice = lastClick.id === g.hit.id && now - lastClick.t < 420
      lastClick = { id: g.hit.id, t: now }
      if (twice && !g.shift && isText(g.hit)) editElement(els.get(g.hit.id))
      else if (g.shift && !g.fresh) select(g.hit, true)
      else if (!g.shift) select(g.hit, false)
    }
  }
  refresh()
}
canvas.addEventListener('pointerup', pointerEnd)
canvas.addEventListener('pointercancel', pointerEnd)
canvas.addEventListener('pointerleave', () => { if (!gesture && hover) { hover = null; invalidate() } })
canvas.addEventListener('contextmenu', e => e.preventDefault())
canvas.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault() })   // no autoscroll puck

canvas.addEventListener('wheel', e => {
  if (DESK) {
    // The wheel is the Desk's: it scrolls the page, the paper with it. Only a sideways wheel pans the paper.
    const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX
    if (!e.ctrlKey && !e.metaKey && Math.abs(dx) > Math.abs(e.shiftKey ? 0 : e.deltaY)) { e.preventDefault(); deskPan(dx) }
    return
  }
  e.preventDefault()
  anim = null
  const [px, py] = local(e)
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? H : 1
  // a trackpad pinch arrives as a wheel with ctrlKey
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

// ── buttons ─────────────────────────────────────────────────────────────────
$('undo').addEventListener('click', () => step(undo, redo))
$('redo').addEventListener('click', () => step(redo, undo))
$('zoom').addEventListener('click', () => zoomAt(W / 2, H / 2, 1 / view.z, true))
$('zoom-out').addEventListener('click', () => zoomAt(W / 2, H / 2, 1 / 1.3, true))
$('zoom-in').addEventListener('click', () => zoomAt(W / 2, H / 2, 1.3, true))
$('fit').addEventListener('click', () => fit(true))
$('image').addEventListener('click', () => { closePopovers(); $('file').click() })
$('file').addEventListener('change', () => { if ($('file').files.length) addImages($('file').files); $('file').value = '' })
$('to-front').addEventListener('click', () => reorder(true))
$('to-back').addEventListener('click', () => reorder(false))
$('group').addEventListener('click', () => toggleGroup())
$('delete').addEventListener('click', () => remove(selected()))
for (const b of document.querySelectorAll('.pad-tool')) {
  b.addEventListener('click', () => { if (tool === b.dataset.tool && (tool === 'pen' || tool === 'hl')) toggleStyle(); else setTool(b.dataset.tool) })
}
function setTheme(next) {
  if (next === dark()) return
  if (next) root.dataset.theme = 'dark'; else delete root.dataset.theme
}
$('theme').addEventListener('click', () => {
  const next = !dark()
  setTheme(next)
  try { localStorage.setItem('agent-board-theme', next ? 'dark' : 'light') } catch {}
  tell('theme', { theme: next ? 'dark' : 'light' })   // the board around the pad follows
})
$('help-btn').addEventListener('click', () => $('help').showModal())
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', e => { if (e.target === dialog || e.target.closest('[data-close]')) dialog.close() })
}

// ── drop and paste ──────────────────────────────────────────────────────────
const hasFiles = e => [...(e.dataTransfer?.types ?? [])].includes('Files')
pad.addEventListener('dragenter', e => { if (hasFiles(e)) { e.preventDefault(); $('drop').hidden = false } })
pad.addEventListener('dragover', e => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; $('drop').hidden = false } })
pad.addEventListener('dragleave', e => { if (!pad.contains(e.relatedTarget)) $('drop').hidden = true })
pad.addEventListener('drop', e => {
  if (!hasFiles(e)) return
  e.preventDefault()
  $('drop').hidden = true
  commitEditor()
  addImages(e.dataTransfer.files, local(e))
})
document.addEventListener('paste', e => {
  if (e.target === editor || document.querySelector('dialog[open]')) return
  const files = [...(e.clipboardData?.files ?? [])].filter(f => f.type.startsWith('image/'))
  if (files.length) { e.preventDefault(); return addImages(files) }
  // pasted words become a note at the cursor
  const text = e.clipboardData?.getData('text/plain')?.replace(/\r/g, '').trim()
  if (!text) return
  e.preventDefault()
  const [wx, wy] = spot()
  const el = makeText('text', r2(wx), r2(wy - (TEXT_SIZE * 1.35) / 2), { text, size: TEXT_SIZE, color: style.pen.color, wrap: wrapAt(wx) })
  add([el])
  sel.clear()
  sel.add(el.id)
  refresh()
})

// ── keyboard ────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.defaultPrevented || e.altKey || document.querySelector('dialog[open]')) return
  if (e.target === editor) return   // the note has its own keys; everything else is text
  const cmd = e.ctrlKey || e.metaKey
  const key = e.key.toLowerCase()
  if (e.key === 'Escape') {
    if (rec) stopRecording(true)
    else if (area) { if (!area.sending) clearArea() }
    else if (!$('style').hidden || !$('send-menu').hidden) closePopovers()
    else if (tool === 'area') setTool(toolBefore)
    else if (sel.size) { sel.clear(); refresh() }
    else if (DESK && tool !== 'select') setTool('select')   // the pen is put down: the Desk's cards answer again
    else tell('close')   // nothing left to let go of: back to where the human came from
    return
  }
  if (cmd) {
    if (key === 'z') { e.preventDefault(); step(e.shiftKey ? redo : undo, e.shiftKey ? undo : redo) }
    else if (key === 'y') { e.preventDefault(); step(redo, undo) }
    else if (key === 'a') { e.preventDefault(); sel.clear(); for (const el of ordered()) sel.add(el.id); refresh() }
    else if (key === 'd') { e.preventDefault(); duplicate() }
    else if (key === 'g') { e.preventDefault(); toggleGroup(!e.shiftKey) }
    else if (key === 'm' && e.ctrlKey) { e.preventDefault(); toggleRecording() }
    return
  }
  if (e.key === ' ' && !DESK) {
    if (document.activeElement?.matches?.('button:focus-visible, a:focus-visible')) return
    e.preventDefault()
    if (!spaceDown) { spaceDown = true; updateCursor() }
    return
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (sel.size) { e.preventDefault(); remove(selected()) }
    return
  }
  if (e.key.startsWith('Arrow')) {
    if (!sel.size) return
    e.preventDefault()
    const d = (e.shiftKey ? 10 : 1) / view.z
    return nudge(e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0, e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0)
  }
  if (e.key === 'Enter') {
    if (e.target.closest?.('button, a')) return
    const list = selected()
    if (list.length === 1 && isText(list[0])) { e.preventDefault(); editElement(list[0]) }
    return
  }
  if (e.repeat) return
  const tools = { v: 'select', p: 'pen', h: 'hl', e: 'eraser', t: 'text', a: 'area' }
  if (tools[key]) setTool(tools[key])
  else if (key >= '1' && key <= '4') setWidth(Number(key) - 1)
  else if (key === 'm') toggleRecording()
  else if (key === 'i') $('file').click()
  else if (key === 's') { if (sel.size) $('send-to').click() }
  else if (DESK && 'f0+=-'.includes(key)) return   // no zoom on the Desk's paper
  else if (key === 'f') fit(true)
  else if (key === '0') zoomAt(W / 2, H / 2, 1 / view.z, true)
  else if (key === '+' || key === '=') zoomAt(W / 2, H / 2, 1.3, true)
  else if (key === '-') zoomAt(W / 2, H / 2, 1 / 1.3, true)
  else if (key === ']') reorder(true)
  else if (key === '[') reorder(false)
  else if (key === '?') $('help').showModal()
  else return
  e.preventDefault()
})
const spaceUp = () => { if (spaceDown) { spaceDown = false; if (gesture?.type !== 'pan') updateCursor() } }
document.addEventListener('keyup', e => { if (e.key === ' ') spaceUp() })
window.addEventListener('blur', spaceUp)

// ── send a selection to a session ───────────────────────────────────────────
let sending = null   // { session, payload, list }
function closeSendMenu() {
  if ($('send-menu').hidden) return
  $('send-menu').hidden = true
  $('send-to').setAttribute('aria-expanded', 'false')
}
function openSendMenu() {
  const menu = $('send-menu')
  const b = boardState()
  const head = Object.assign(document.createElement('p'), { className: 'pad-menu-head', textContent: b.board ? 'Sessions on this board' : 'Sample sessions (no board)' })
  const here = new Set(host.prefer)
  const items = [...b.sessions].sort((a, c) => here.has(c.id) - here.has(a.id)).map(s => {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'pad-menu-item'
    item.setAttribute('role', 'menuitem')
    item.dataset.online = String(s.online)
    item.append(Object.assign(document.createElement('span'), { className: 'pad-menu-dot' }), s.name, Object.assign(document.createElement('small'), { textContent: [here.has(s.id) ? 'where you were' : '', s.online ? '' : 'away'].filter(Boolean).join(' · ') }))
    item.addEventListener('click', () => { closeSendMenu(); openSendDialog(s) })
    return item
  })
  if (!items.length) items.push(Object.assign(document.createElement('p'), { className: 'pad-menu-head', textContent: 'No session is connected.' }))
  menu.replaceChildren(head, ...items)
  menu.hidden = false
  $('send-to').setAttribute('aria-expanded', 'true')
  placeOverlays(selectionBox())
  menu.querySelector('button')?.focus({ preventScroll: true })
}
/** The session the human was in when the pad was opened, if it was exactly one: sending goes there first. */
const preferred = () => (host.prefer.length === 1 ? boardState().sessions.find(s => s.id === host.prefer[0]) ?? null : null)
function paintSendTo() {
  const to = preferred()
  $('send-to-label').textContent = to ? `Send to ${to.name}` : 'Send to…'
  $('send-other').hidden = !to
  if (to) $('send-to').removeAttribute('aria-haspopup'); else $('send-to').setAttribute('aria-haspopup', 'menu')
}
$('send-to').addEventListener('click', () => {
  const to = preferred()
  if (to) { closeSendMenu(); return openSendDialog(to) }
  if ($('send-menu').hidden) openSendMenu(); else closeSendMenu()
})
$('send-other').addEventListener('click', () => ($('send-menu').hidden ? openSendMenu() : closeSendMenu()))

/** What a session receives for a selection (docs/pad.md, "Sending a selection"). */
async function buildPayload(session, list) {
  await Promise.all(list.filter(e => e.type === 'image' && e.blob).map(e => picture(e.blob).ready))
  const shot = renderPNG(list, env())
  return {
    shot,
    payload: {
      pad: PAD,
      session: session.id,
      elements: list.map(e => ({ id: e.id, type: e.type, rev: e.rev, ...(isText(e) ? { text: e.data.text } : {}) })),
      text: textOf(list),
      bbox: shot.bbox,
      png: shot.png,
    },
  }
}
async function openSendDialog(session) {
  const list = selected()
  if (!list.length) return
  const { shot, payload } = await buildPayload(session, list)
  sending = { session, payload, list }
  const kb = Math.round((shot.png.length * 0.75) / 1024)
  $('send-title').textContent = `Send to ${session.name}`
  $('send-lead').textContent = session.sample
    ? 'This is what a session would receive. The names are samples: no board is behind this page.'
    : `This is what ${session.name} receives: one picture of the selection, the words in it as plain text, and the ids of the elements, so the agent can refer to them or answer on the pad.`
  $('send-png').src = shot.png
  $('send-png-info').textContent = `${shot.width} × ${shot.height} px, ${kb} KB`
  $('send-text').textContent = payload.text || '(no text or voice elements in the selection)'
  $('send-text-info').textContent = payload.text ? `${payload.text.length} characters` : ''
  $('send-ids').textContent = payload.elements.map(e => `${e.id}  ${e.type}`).join('\n')
  $('send-ids-info').textContent = `${payload.elements.length}`
  $('send-result').hidden = true
  $('send-go').disabled = false
  $('send-go').textContent = 'Send'
  const dialog = $('send-dialog')
  dialog.showModal()
  // A panel at the selection, not a window over the paper: beside it where there is room (right, then left),
  // else under or above it; never outside the screen.
  const S = selectionBox()
  if (S) {
    const x = S.box.x * view.z + view.x, y = S.box.y * view.z + view.y, w = S.box.w * view.z, h = S.box.h * view.z
    const dw = dialog.offsetWidth, dh = dialog.offsetHeight, gap = 14, vw = window.innerWidth, vh = window.innerHeight
    const beside = x + w + gap + dw <= vw - 8 ? x + w + gap : x - gap - dw >= 8 ? x - gap - dw : null
    const left = beside ?? clamp(x, 8, Math.max(8, vw - dw - 8))
    const top = beside != null ? clamp(y, 8, Math.max(8, vh - dh - 8)) : y + h + gap + dh <= vh - 8 ? y + h + gap : Math.max(8, Math.min(y - gap - dh, vh - dh - 8))
    dialog.style.left = `${Math.round(left)}px`
    dialog.style.top = `${Math.round(top)}px`
    dialog.dataset.anchored = ''
  }
}
$('send-go').addEventListener('click', async () => {
  if (!sending) return
  const { session, payload } = sending
  const out = $('send-result')
  $('send-go').disabled = true
  $('send-go').textContent = 'Sending…'
  try {
    // The server sends what it has: everything selected must have arrived there first.
    if (sync.state().mode !== 'local' && !(await sync.settled())) throw new Error('The selection has not reached the board yet (no connection). Try again in a moment.')
    const answer = await sendSelection({ ...payload, client_id: sync.clientId })
    // Where an element went is the server's to note (no new revision, no undo step);
    // it hands the records back with "sent" filled in.
    if (answer.elements) sync.take(answer.elements, answer.seq ?? 0)
    takeAway(payload.elements.map(e => e.id))
    $('send-dialog').close()
    toast(`Sent to ${session.name}`)
    tell('sent', { session: session.id, message_id: answer.message_id })
  } catch (err) {
    out.textContent = `Not sent. ${err.message}`
    out.hidden = false
    $('send-go').textContent = 'Try again'
    $('send-go').disabled = false
  }
})

// What was sent leaves the paper: it is the agent's now. One step, so one undo brings all of it back.
// Without a frame (a selection was sent) exactly those elements go. With a frame, notes and pictures that
// lie in it go whole, and a stroke that crosses its edge is cut there: the part outside stays, as a stroke
// of its own (the same cut as the session's canvas makes, js/scribble.js).
function takeAway(ids, r = null) {
  const changes = []
  let z = topZ()
  for (const id of ids) {
    const el = els.get(id)
    if (!el) continue
    if (!r || el.type !== 'stroke') { changes.push({ id, before: el, after: null }); continue }
    const d = el.data, sx = el.w / d.box[0], sy = el.h / d.box[1], n = d.pts.length >> 1
    const X = i => el.x + d.pts[2 * i] * sx, Y = i => el.y + d.pts[2 * i + 1] * sy
    const x1 = r.x + r.w, y1 = r.y + r.h
    const within = (x, y) => x >= r.x && x <= x1 && y >= r.y && y <= y1
    // a inside, b outside: where the line between them leaves the frame
    const edge = (ax, ay, bx, by) => {
      let t = 1
      if (bx < r.x) t = Math.min(t, (r.x - ax) / (bx - ax))
      if (bx > x1) t = Math.min(t, (x1 - ax) / (bx - ax))
      if (by < r.y) t = Math.min(t, (r.y - ay) / (by - ay))
      if (by > y1) t = Math.min(t, (y1 - ay) / (by - ay))
      return [ax + (bx - ax) * t, ay + (by - ay) * t]
    }
    const runs = []
    let run = null
    for (let i = 0; i < n; i++) {
      const x = X(i), y = Y(i), inside = within(x, y)
      if (!run || run.inside !== inside) {
        const prev = run
        run = { inside, pts: [], pr: [] }
        runs.push(run)
        if (prev) {
          const cut = inside ? edge(x, y, X(i - 1), Y(i - 1)) : edge(X(i - 1), Y(i - 1), x, y)
          prev.pts.push(...cut); prev.pr.push(d.pr?.[i - 1])
          run.pts.push(...cut); run.pr.push(d.pr?.[i])
        }
      }
      run.pts.push(x, y); run.pr.push(d.pr?.[i])
    }
    if (!runs.some(run => run.inside)) continue   // only its box reached into the frame: it stays
    changes.push({ id, before: el, after: null })
    for (const run of runs) {
      if (run.inside) continue
      const part = strokeFromWorld(run.pts, d.pr ? run.pr : null, { tool: d.tool, color: d.color, size: r2(d.size * sx) })
      const piece = make('stroke', part, part.data, ++z)
      changes.push({ id: piece.id, before: null, after: piece })
    }
  }
  apply(changes)
}

// ── send an area: frame it, pick a session, and it is cut out and flies there ──
// The fast path beside "select, then Send to…". What goes: every element that lies in the frame,
// whole or in part (ids and words), and a picture of exactly the frame, as the human saw it.
function clearArea() {
  if (!area && $('area-menu').hidden) return
  area = null
  $('area-menu').hidden = true
  invalidate()
}
function frameArea(g) {
  const [x0, y0] = toWorld(Math.min(g.px, g.qx), Math.min(g.py, g.qy)), [x1, y1] = toWorld(Math.max(g.px, g.qx), Math.max(g.py, g.qy))
  if ((x1 - x0) * view.z < 12 || (y1 - y0) * view.z < 12) return
  const list = ordered().filter(el => inRect(el, x0, y0, x1, y1))
  if (!list.length) return toast('Nothing in that area. Frame something that is on the paper.')
  area = { x: r2(x0), y: r2(y0), w: r2(x1 - x0), h: r2(y1 - y0), list }
  openAreaMenu()
}
/** When a session was last sent something from this pad, to list the usual ones first. */
function lastSentTo() {
  const when = new Map()
  for (const el of els.values()) for (const l of el.sent ?? []) when.set(l.session, Math.max(when.get(l.session) ?? 0, l.at ?? 0))
  return when
}
function markOf(s) {
  const mark = Object.assign(document.createElement('span'), { className: 'pad-mark' })
  if (s.hue != null) mark.style.setProperty('--hue', s.hue)
  // The scribble comes from the board's own page (js/padlink.js), not from anyone's input.
  if (s.mark) mark.innerHTML = s.mark
  else mark.textContent = (s.name || '?').trim().charAt(0).toUpperCase()
  return mark
}
function openAreaMenu() {
  const menu = $('area-menu')
  const b = boardState()
  const here = new Set(host.prefer), recent = lastSentTo()
  // where the human came from first, then who was sent to most recently, then who is there
  const sessions = [...b.sessions].sort((p, q) => here.has(q.id) - here.has(p.id) || (recent.get(q.id) ?? 0) - (recent.get(p.id) ?? 0) || q.online - p.online)
  const n = area.list.length
  const head = Object.assign(document.createElement('p'), { className: 'pad-menu-head', textContent: `Send ${n} element${n === 1 ? '' : 's'} to` })
  const items = sessions.map(s => {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'pad-menu-item'
    item.setAttribute('role', 'menuitem')
    item.dataset.online = String(s.online)
    item.dataset.session = s.id
    item.dataset.name = s.name.toLowerCase()
    item.append(markOf(s), s.name, Object.assign(document.createElement('small'), { textContent: [here.has(s.id) ? 'where you were' : '', s.online ? '' : 'away'].filter(Boolean).join(' · ') }))
    item.addEventListener('click', () => sendArea(s, item))
    return item
  })
  const shownItems = () => items.filter(i => !i.hidden)
  const firstKey = () => { for (const i of items) i.querySelector('kbd')?.remove(); shownItems()[0]?.append(Object.assign(document.createElement('kbd'), { textContent: 'Enter' })) }
  const nodes = [head]
  let find = null
  if (items.length > 6) {
    find = Object.assign(document.createElement('input'), { className: 'pad-menu-find', type: 'search', placeholder: 'Find a session', autocomplete: 'off' })
    find.setAttribute('aria-label', 'Find a session')
    find.addEventListener('input', () => { const q = find.value.trim().toLowerCase(); for (const i of items) i.hidden = Boolean(q) && !i.dataset.name.includes(q); firstKey() })
    nodes.push(find)
  }
  if (!items.length) nodes.push(Object.assign(document.createElement('p'), { className: 'pad-menu-head', textContent: 'No session is connected.' }))
  menu.replaceChildren(...nodes, ...items)
  firstKey()
  menu.onkeydown = e => {
    const list = shownItems(), at = list.indexOf(document.activeElement)
    if (e.key === 'Enter' && (e.target === find || at < 0)) { e.preventDefault(); e.stopPropagation(); list[0]?.click() }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation()
      list[(at + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus({ preventScroll: true })
    } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); clearArea() }
    else if (e.target === find) e.stopPropagation()   // typing a name is not a tool key
  }
  menu.hidden = false
  placeAreaMenu()
  // The keyboard goes to the chooser: Enter takes the first, a name narrows the list.
  ;(find ?? menu).focus?.({ preventScroll: true })
  if (!find) { menu.tabIndex = -1; menu.focus({ preventScroll: true }) }
  invalidate()
}
function placeAreaMenu() {
  const menu = $('area-menu')
  if (menu.hidden || !area) return
  const x = area.x * view.z + view.x, y = area.y * view.z + view.y, w = area.w * view.z, h = area.h * view.z
  const mw = menu.offsetWidth, mh = menu.offsetHeight
  // under the frame; over it if there is no room; else inside its lower edge
  let ty = y + h + 10
  if (ty + mh > H - 84) ty = y - mh - 10
  if (ty < 60) ty = clamp(y + h - mh - 10, 60, Math.max(60, H - 84 - mh))
  const tx = clamp(x + w / 2 - mw / 2, 8, Math.max(8, W - mw - 8))
  menu.style.transform = `translate(${Math.round(tx)}px, ${Math.round(ty)}px)`
}
async function sendArea(session, item) {
  if (!area || area.sending) return
  const a = area
  a.sending = true
  for (const b of $('area-menu').querySelectorAll('button, input')) b.disabled = true
  try {
    await Promise.all(a.list.filter(e => e.type === 'image' && e.blob).map(e => picture(e.blob).ready))
    const shot = renderRect(ordered(), a, env())
    const payload = {
      pad: PAD, session: session.id, client_id: sync.clientId,
      elements: a.list.map(e => ({ id: e.id, type: e.type, rev: e.rev, ...(isText(e) ? { text: e.data.text } : {}) })),
      text: textOf(a.list), bbox: shot.bbox, png: shot.png,
    }
    const rect = { x: a.x * view.z + view.x, y: a.y * view.z + view.y, w: a.w * view.z, h: a.h * view.z }
    // The snip, then the flight; the sending runs meanwhile. On a wide screen inside the board, the
    // board draws the flight: it ends at the session's mark at the left edge, where the sidebar is.
    // Anywhere else (a phone, the pad on its own) the piece flies into the chooser's row.
    a.cut = true
    invalidate()
    const outside = EMBED && !DESK && W > 860
    const flight = (async () => {
      await new Promise(r => setTimeout(r, 90))
      a.gone = true
      invalidate()
      if (outside) {
        $('area-menu').hidden = true
        tell('fly', { png: shot.png, rect, session: session.id })
        await new Promise(r => setTimeout(r, reduced() ? 400 : 780))
      } else await flySheet($('fly'), { png: shot.png, rect, target: item.querySelector('.pad-mark') ?? item })
    })()
    const post = (async () => {
      if (sync.state().mode !== 'local' && !(await sync.settled())) throw new Error('It has not reached the board yet (no connection). Try again in a moment.')
      return sendSelection(payload)
    })()
    const [, answer] = await Promise.all([flight, post.then(v => v, err => ({ failed: err }))])
    if (answer.failed) throw answer.failed
    if (answer.elements) sync.take(answer.elements, answer.seq ?? 0)
    takeAway(a.list.map(e => e.id), a)
    // What was sent cannot be taken back (the agent has it), so the note only says where it went. Undo puts it back on the paper.
    toast(`Sent to ${session.name}`, 'info', 4000)
    tell('sent', { session: session.id, message_id: answer.message_id })
    area = null
    $('area-menu').hidden = true
    if (tool === 'area') setTool(toolBefore)
  } catch (err) {
    area = null
    $('area-menu').hidden = true
    toast(`Not sent. ${err.message}`, 'error', 6000)
  }
  refresh()
}

// ── start ───────────────────────────────────────────────────────────────────
new ResizeObserver(() => {
  const w = pad.clientWidth, h = pad.clientHeight
  if (w === W && h === H) return
  if (W && H && w && h && !DESK) { view.x += (w - W) / 2; view.y += (h - H) / 2 }
  W = w; H = h
  if (!W || !H) return
  sizeCanvas()
  if (raf) { cancelAnimationFrame(raf); raf = 0 }
  paint()
}).observe(pad)
new MutationObserver(() => {
  readTheme()
  paintSwatches()
  if (edit) editor.style.color = resolveInk(edit.color, dark())
  refresh()
}).observe(root, { attributes: true, attributeFilter: ['data-theme'] })
window.addEventListener('pagehide', () => commitEditor())
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && edit && editor.textContent) commitEditor() })

// ── inside the board ────────────────────────────────────────────────────────
function hostSays(msg) {
  if (msg.type !== 'context') return
  const was = host.open
  host = { open: Boolean(msg.open), prefer: Array.isArray(msg.prefer) ? msg.prefer : [] }
  if (msg.sessions) setBoard({ sessions: msg.sessions, speech: Boolean(msg.speech) })
  if (msg.theme) setTheme(msg.theme === 'dark')
  paintSendTo()
  if (host.open && !was) { sync?.resume(); if (!DESK) window.focus() }
  if (!host.open && was) {
    // Out of sight: keep what was being typed, drop what was being recorded, stop listening.
    commitEditor()
    if (rec) stopRecording(true)
    closePopovers()
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close()
    delete pad.dataset.started
    sync?.pause()
  }
}
if (DESK) {
  root.dataset.desk = ''
  tool = 'select'   // the bare pointer: the Desk's cards work, a finger scrolls; the pen is picked up (P, the switch, the bar)
  // The Desk's bar: pointer, pen, eraser, attach, undo, and, apart, send an area.
  document.querySelector('.pad-tools').append($('image'), $('undo'), Object.assign(document.createElement('span'), { className: 'pad-sep' }), toolButton('area'))
  /** The Desk says how far it is scrolled (s), where its list ends on the paper (listEnd), and whether that list is
   *  the real one (settled: the board's state has arrived). */
  window.padDesk = (s, listEnd, settled) => {
    if (desk.y0 == null && settled && desk.loaded) {
      // The first time in this browser. Until now the paper began under the list (32 px above the topmost thing on
      // it, or above world 0): it is laid so that this is where it still lies.
      let top = -32
      for (const el of els.values()) top = Math.min(top, el.y - 32)
      desk.y0 = Math.round(top - listEnd / desk.z)
      try { localStorage.setItem(TOP_KEY, String(desk.y0)) } catch {}
      desk.s = null
      refresh()
    }
    if (s === desk.s) return
    desk.s = s
    deskView()
  }
  /** The Desk zooms the paper: z, keeping the paper under the screen point x (of this frame) where it is. */
  window.padZoom = (z, x = 0) => {
    if (z === desk.z) return
    const px = x / desk.z + desk.panX
    desk.z = z
    desk.panX = px - x / z
    deskPan(0)
  }
}
if (EMBED) {
  root.dataset.embed = ''
  window.addEventListener('message', e => { if (e.origin === location.origin && e.source === window.parent && e.data?.trommi === 'pad') hostSays(e.data) })
  const back = $('back')
  back.replaceChildren(icon('close'))
  back.setAttribute('aria-label', 'Close and go back to where you were')
  back.dataset.tip = 'Close · Esc'
  back.addEventListener('click', e => { e.preventDefault(); tell('close') })
}

async function start() {
  readTheme()
  document.title = `${PAD_WORD} · Trommi`
  $('pad-word').textContent = PAD_WORD
  $('canvas').setAttribute('aria-label', `${PAD_WORD}: an endless surface for notes, drawings and pictures`)
  $('pad-name').textContent = PAD
  db = await openStore()
  sync = startSync({ pad: PAD, db, onRemote: applyRemote, onState: renderStatus })
  if (!host.open) sync.pause()
  const [records, saved] = await Promise.all([db.list(PAD), db.meta(VIEW_KEY)])
  for (const r of records) {
    revs.set(r.id, r.rev ?? 1)
    if (!r.deleted) els.set(r.id, r)
  }
  order = null   // a first paint may already have cached the empty pad
  W = pad.clientWidth; H = pad.clientHeight
  sizeCanvas()
  if (saved?.z) {
    Object.assign(view, { x: saved.x, y: saved.y, z: clamp(saved.z, MIN_Z, MAX_Z) })
    if (saved.style?.pen && saved.style?.hl) Object.assign(style, saved.style)
    if (saved.tool === 'hl') drawTool = 'hl'
  } else { setView(W / 2, H / 2, 1); firstLook = !els.size }
  if (DESK) { desk.loaded = true; deskOrigin(); deskView() }
  $('zoom').textContent = `${Math.round(view.z * 100)} %`
  buildSwatches()
  refresh()
  onBoard(() => { renderStatus(); paintSendTo() })
  connectBoard(EMBED)
  tell('ready')
}
start()

// For scripts that drive the page (dev/cdp.mjs) and for the curious in the console.
window.pad = {
  elements: () => ordered(),
  selection: () => [...sel],
  view: () => ({ ...view }),
  state: () => ({ tool, editing: Boolean(edit), recording: rec?.state ?? null, undo: undo.length, redo: redo.length, store: db?.kind, board: boardState(), sync: sync?.state(), embed: EMBED, host }),
  settled: ms => sync.settled(ms),
  area: () => (area ? { x: area.x, y: area.y, w: area.w, h: area.h, ids: area.list.map(e => e.id), sending: Boolean(area.sending) } : null),
  records: () => db.list(PAD),
  payload: async session => (await buildPayload(session ?? boardState().sessions[0], selected())).payload,
  wipe: async () => { await db.wipe(); location.reload() },
  // for the page around an embedded pad (js/padlink.js)
  tool: name => setTool(name),
  rest: () => { commitEditor(); closePopovers(); sel.clear(); setTool('select') },
  world: (px, py) => toWorld(px, py),
}
