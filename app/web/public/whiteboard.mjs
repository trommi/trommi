// The Whiteboard: a place of its own in the sidebar, under the Desk's header (Christopher's pick "place", 4 Oct 2026:
// "wenn überall Whiteboard ist, ist nirgends Whiteboard"). The Desk is cards on plain paper; the drawing lives here.
//
//   register(t)           the page /whiteboard: the pad as large as the main area
//
// What is on it is the desk's canvas timeline, desk/<32 hex> (deskCanvas). The Desk's paper wrote to desk/<desk_id>
// with the desk's own id ('main', or 8 hex for a desk made in the menu); the core refuses such an id (a canvas
// timeline is desk/ and 32 hex, the core's parseTimelineId, since protocol v1.1), so none of the paper's strokes
// ever reached the hub or a second device: there is nothing to carry over, and the Whiteboard is where drawing is kept
// from now on. The pad runs on the page itself (mountPad, controller "whiteboard"); its elements live in that canvas
// timeline, end-to-end encrypted (openCanvas, the wire format is the core's canvas.mjs).
import { Controller, controller, html, markArt, raw } from './ui.mjs'
import { canvasWire } from './app.mjs'
/** The canvas timeline of a desk: desk/ and 32 hex. A desk id that is not 32 hex already ('main', a menu desk's 8 hex)
 *  is folded into 16 bytes (its UTF-8, XOR by position, the length last): the same desk is the same timeline on every
 *  device, two desks never share one. */
export function deskCanvas(desk) {
  const id = String(desk || 'main')
  if (/^[0-9a-f]{32}$/.test(id)) return `desk/${id}`
  const bytes = new TextEncoder().encode(id), out = new Uint8Array(16)
  bytes.forEach((v, i) => { out[i % 16] ^= v })
  out[15] ^= bytes.length & 0xff
  return `desk/${[...out].map(b => b.toString(16).padStart(2, '0')).join('')}`
}
const canvasOf = model => deskCanvas(model.desk)


/** The sessions for the pad's "Send to…" (read by the controller whiteboard). */
function whiteboardSessions(model) {
  const sessions = model.agents.map(a => ({ id: a.id, device: a.device_id ?? a.id, name: a.name, online: Boolean(a.online), hue: a.hue, mark: String(markArt({ ...a, starred: false })) }))
  return html`<div id="whiteboard-sessions" hidden data-sessions="${JSON.stringify(sessions)}"></div>`
}

/** The Scribble Board's page. It is a part of its own in the frame (app.mjs bodyParts, key "pad"): the Desk keeps the
 *  same markup under its sheet once the corner was touched, so a turn of the page mounts nothing anew. */
export const whiteboardMain = model => raw(`<main id="whiteboard" aria-label="Scribble Board" data-controller="whiteboard" data-whiteboard-canvas-value="${canvasOf(model)}">
${whiteboardSessions(model)}
<div class="pad" id="pad" data-tool="pen" data-place data-owns-keys>
  <canvas class="pad-canvas" id="canvas" role="img" aria-label="Scribble Board: an endless surface for notes, drawings and pictures"></canvas>

  <p class="pad-hint" id="hint"><b>Click anywhere</b> and type. <b>Drag</b> to draw.</p>

  <!-- the text being typed; it sits on the canvas and follows pan and zoom -->
  <div class="pad-editor" id="editor" role="textbox" aria-multiline="true" aria-label="Note" spellcheck="false" hidden></div>
  <div class="pad-caret-tip" id="caret-tip" hidden>
    <span>Type · Esc closes</span>
  </div>

  <div class="pad-top">
    <div class="pad-pill pad-title">
            <strong id="pad-word">Scribble Board</strong>
    </div>
    <span class="pad-gap"></span>
    <div class="pad-pill">
      <button type="button" class="pad-icon-btn" id="undo" data-icon="undo" aria-label="Undo" data-tip="Undo · Ctrl+Z"></button>
      <button type="button" class="pad-icon-btn" id="redo" data-icon="redo" aria-label="Redo" data-tip="Redo · Ctrl+Shift+Z"></button>
    </div>
    <div class="pad-pill">
      <button type="button" class="pad-icon-btn pad-wide" id="zoom-out" data-icon="minus" aria-label="Zoom out" data-tip="Zoom out · -"></button>
      <button type="button" class="pad-zoom" id="zoom" aria-label="Reset zoom to 100 %" data-tip="100 % · 0">100 %</button>
      <button type="button" class="pad-icon-btn pad-wide" id="zoom-in" data-icon="plus" aria-label="Zoom in" data-tip="Zoom in · +"></button>
      <button type="button" class="pad-icon-btn" id="fit" data-icon="fit" aria-label="Fit everything" data-tip="Fit everything · F"></button>
    </div>
    <div class="pad-pill">
      <button type="button" class="pad-icon-btn pad-wide" id="theme" data-icon="theme" aria-label="Light or dark" data-tip="Light or dark"></button>
      <button type="button" class="pad-icon-btn" id="help-btn" data-icon="help" aria-label="Keyboard shortcuts" data-tip="Shortcuts · ?"></button>
    </div>
  </div>

  <!-- actions for what is selected; pad.js places it above the selection -->
  <div class="pad-pill pad-selbar" id="selbar" role="toolbar" aria-label="Selection" hidden>
    <button type="button" class="pad-send" id="send-to" data-icon="send" aria-haspopup="menu" aria-expanded="false"><span id="send-to-label">Send to…</span></button>
    <button type="button" class="pad-icon-btn" id="send-other" data-icon="more" aria-label="Send to another session" data-tip="Another session" hidden></button>
    <span class="pad-sep"></span>
    <button type="button" class="pad-icon-btn" id="to-front" data-icon="front" aria-label="Bring to front" data-tip="To front · ]"></button>
    <button type="button" class="pad-icon-btn" id="to-back" data-icon="back-z" aria-label="Send to back" data-tip="To back · ["></button>
    <button type="button" class="pad-icon-btn" id="group" data-icon="group" aria-label="Group" aria-pressed="false" data-tip="Group · Ctrl+G"></button>
    <button type="button" class="pad-icon-btn pad-danger" id="delete" data-icon="trash" aria-label="Delete" data-tip="Delete · Del"></button>
  </div>
  <div class="pad-menu" id="send-menu" role="menu" aria-label="Send the selection to a session" hidden></div>
  <!-- the fast path: an area was framed, pick who gets it -->
  <div class="pad-menu pad-area-menu" id="area-menu" role="menu" aria-label="Send this area to a session" hidden></div>
  <div class="pad-fly" id="fly" aria-hidden="true"></div>

  <div class="pad-bar">
    <div class="pad-pill pad-tools" role="toolbar" aria-label="Tools">
      <button type="button" class="pad-icon-btn pad-tool" data-tool="select" data-icon="select" aria-label="Select" data-tip="Select · V"></button>
      <!-- the pen carries its colour; a click on it while it is in hand opens colour and width (the same for the highlighter) -->
      <button type="button" class="pad-icon-btn pad-tool" data-tool="pen" data-icon="pen" aria-label="Pen; again: colour and width" aria-haspopup="true" aria-expanded="false" data-tip="Pen · P · again: colour"></button>
      <button type="button" class="pad-icon-btn pad-tool" data-tool="hl" data-icon="hl" aria-label="Highlighter; again: colour and width" aria-haspopup="true" aria-expanded="false" data-tip="Highlighter · H · again: colour"></button>
      <button type="button" class="pad-icon-btn pad-tool" data-tool="eraser" data-icon="eraser" aria-label="Eraser" data-tip="Eraser · E"></button>
      <button type="button" class="pad-icon-btn pad-tool" data-tool="text" data-icon="text" aria-label="Text: click on the paper and type" data-tip="Text · T"></button>
      <div class="pad-style" id="style" hidden>
        <div class="pad-style-row"><span class="pad-label">Colour</span><div class="pad-swatches" id="swatches" role="group" aria-label="Colour"></div></div>
        <div class="pad-style-row"><span class="pad-label">Width</span><div class="pad-widths" id="widths" role="group" aria-label="Width"></div></div>
      </div>
      <span class="pad-sep"></span>
      <button type="button" class="pad-icon-btn" id="image" data-icon="clip" aria-label="Attach a picture" data-tip="Attach a picture · I"></button>
    </div>
    <!-- not a tool of the board: what takes something out of it. Scissors along a dashed line round a letter
         (the note's envelope, notes.css): cut out an area and send it to an agent. -->
    <button type="button" class="pad-tool pad-cut" data-tool="area" aria-label="Cut out and send to an agent" data-tip="Cut out and send to an agent · A"><svg viewBox="0 -9 76 56" aria-hidden="true"><path class="cut-line" d="M17 4.2 Q44 3.4 71.4 4 Q72.2 23 71.6 42 Q44 42.8 17.4 42.2 Q16.6 23 17 4.2"/><g class="cut-letter"><path class="cut-paper" d="M24 11.4 L64.6 10.8 L65 35.4 L24.4 36 Z"/><path d="M24 11.4 Q44 10.6 64.6 10.8 Q65.2 23 65 35.4 Q44 36.2 24.4 36 Q23.6 23 24 11.4"/><path d="M24.4 12 Q34.6 20.6 44.2 25 Q54.4 20 64.4 11.4"/></g><g class="cut-scissors" transform="translate(-1 -8.4)"><path d="M21.4 5.2 Q16.6 9.6 11.4 13.6 Q9.8 15 8.6 16.2 Q7 15.6 5.6 16 Q3.8 16.8 3.8 18.4 Q3.8 20.4 5 21 Q6.6 21.6 7.8 21.2 Q9.2 20.4 9.2 18.8 Q9 17.4 8.2 16.6"/><path d="M21.8 19.6 Q16.4 14.8 11.6 10.6 Q10 9.2 8.8 8 Q7.2 8.6 5.8 8.4 Q4 7.8 3.6 6.2 Q3.6 4.2 4.6 3.4 Q6.2 2.6 7.6 3 Q9.2 3.8 9.2 5.4 Q9 6.8 8.4 7.8"/></g></svg></button>
  </div>
  <input class="pad-file" id="file" type="file" accept="image/*" multiple tabindex="-1" aria-hidden="true">

  <div class="pad-status" id="status" role="status"></div>
  <div class="pad-drop" id="drop" hidden><span>Drop the picture here</span></div>
  <div class="pad-toast" id="toast" role="status" hidden></div>
</div>

<dialog class="pad-dialog" id="send-dialog" aria-labelledby="send-title">
  <header>
    <h2 id="send-title">Send to…</h2>
    <button type="button" class="pad-icon-btn" data-close data-icon="close" aria-label="Close"></button>
  </header>
  <p class="pad-dialog-lead" id="send-lead"></p>
  <div class="pad-payload">
    <figure>
      <figcaption>Picture <span id="send-png-info"></span></figcaption>
      <img id="send-png" alt="The selection as the agent will see it">
    </figure>
    <div>
      <h3>Text <span id="send-text-info"></span></h3>
      <pre id="send-text"></pre>
      <h3>Elements <span id="send-ids-info"></span></h3>
      <pre id="send-ids"></pre>
    </div>
  </div>
  <p class="pad-dialog-note" id="send-result" role="alert" hidden></p>
  <footer>
    <button type="button" class="pad-btn" data-close>Close</button>
    <button type="button" class="pad-btn pad-btn-primary" id="send-go" autofocus>Send</button>
  </footer>
</dialog>

<dialog class="pad-dialog pad-help" id="help" aria-labelledby="help-title">
  <header>
    <h2 id="help-title">Shortcuts</h2>
    <button type="button" class="pad-icon-btn" data-close data-icon="close" aria-label="Close"></button>
  </header>
  <div class="pad-keys" tabindex="-1" autofocus>
    <section>
      <h3>Put something down</h3>
      <dl>
        <dt>Click</dt><dd>Cursor there: just type</dd>
        <dt>Drag</dt><dd>Draw (pen, highlighter)</dd>
        <dt>Hold</dt><dd>Speak; let go to finish</dd>
        <dt><kbd>M</kbd></dt><dd>Speak at the cursor, again to finish</dd>
        <dt><kbd>I</kbd> · drop · paste</dt><dd>Picture</dd>
        <dt><kbd>Esc</kbd></dt><dd>Finish the note, drop the selection</dd>
        <dt><kbd>Enter</kbd></dt><dd>Edit the selected note (or double-click)</dd>
      </dl>
    </section>
    <section>
      <h3>Tools</h3>
      <dl>
        <dt><kbd>V</kbd></dt><dd>Select: drag a frame, drag to move</dd>
        <dt><kbd>P</kbd> <kbd>H</kbd> <kbd>E</kbd></dt><dd>Pen, highlighter, eraser; the pen again: colour</dd>
        <dt><kbd>T</kbd></dt><dd>Text: click and type</dd>
        <dt><kbd>1</kbd> to <kbd>4</kbd></dt><dd>Line width</dd>
        <dt><kbd>Shift</kbd> drag</dt><dd>Frame a selection with any tool</dd>
        <dt><kbd>Shift</kbd> click</dt><dd>Add to or take from the selection</dd>
      </dl>
    </section>
    <section>
      <h3>Selection</h3>
      <dl>
        <dt><kbd>A</kbd> drag</dt><dd>Frame an area and send it: <kbd>Enter</kbd> takes the first session</dd>
        <dt><kbd>S</kbd></dt><dd>Send the selection to a session</dd>
        <dt><kbd>Del</kbd></dt><dd>Delete</dd>
        <dt><kbd>Ctrl</kbd> <kbd>A</kbd></dt><dd>Select everything</dd>
        <dt><kbd>Ctrl</kbd> <kbd>D</kbd></dt><dd>Duplicate</dd>
        <dt><kbd>Ctrl</kbd> <kbd>G</kbd></dt><dd>Group, with <kbd>Shift</kbd> ungroup</dd>
        <dt><kbd>]</kbd> <kbd>[</kbd></dt><dd>To front, to back</dd>
        <dt>Arrows</dt><dd>Nudge, with <kbd>Shift</kbd> further</dd>
        <dt><kbd>Ctrl</kbd> <kbd>Z</kbd></dt><dd>Undo, with <kbd>Shift</kbd> redo</dd>
      </dl>
    </section>
    <section>
      <h3>Moving around</h3>
      <dl>
        <dt>Wheel · two fingers</dt><dd>Pan</dd>
        <dt><kbd>Ctrl</kbd> wheel · pinch</dt><dd>Zoom</dd>
        <dt><kbd>Space</kbd> drag</dt><dd>Pan with the mouse</dd>
        <dt><kbd>F</kbd></dt><dd>Fit everything</dd>
        <dt><kbd>0</kbd> <kbd>+</kbd> <kbd>-</kbd></dt><dd>100 %, zoom in, zoom out</dd>
        <dt><kbd>?</kbd></dt><dd>This list</dd>
      </dl>
    </section>
  </div>
</dialog>
</main>`)

export function register(t) {
  // The Scribble Board (one drawing on it is a scribble).
  t.get(/^\/scribble-board$/, ({ req, res }) => {
    const m = t.model()
    t.page(req, res, { model: m, title: `Scribble Board · Trommi`, view: 'whiteboard', bodyAttrs: ' data-page="whiteboard"', main: whiteboardMain(m) })
  })
  t.live('whiteboard', {
    take: m => ({ sessions: String(whiteboardSessions(m)), canvas: canvasOf(m) }),
    diff: (was, now) => (was.canvas !== now.canvas ? '' : was.sessions !== now.sessions ? t.stream('replace', 'whiteboard-sessions', raw(now.sessions)) : ''),
  })
}

// ---- controller "whiteboard" ----
// The Whiteboard's page: mounts the pad (below) on its markup, hands it the sessions for "Send to…" (the live stream
// replaces #whiteboard-sessions) and puts the pen in its hand (P: "trommi:pen").
controller('whiteboard', class extends Controller {
  static values = { canvas: String }
  connect() {
    const client = window.trommi?.client
    if (!client) return
    this.pad = mountPad(this.element, { canvasId: this.canvasValue, client })
    this.sessions = () => { try { this.pad.setSessions(JSON.parse(document.getElementById('whiteboard-sessions')?.dataset.sessions ?? '[]')) } catch {} }
    this.sessions()
    this.watch = new MutationObserver(this.sessions)
    this.watch.observe(this.element, { childList: true })
    this.onPen = () => window.pad?.tool('pen')
    document.addEventListener('trommi:pen', this.onPen)
  }
  disconnect() {
    this.watch?.disconnect()
    document.removeEventListener('trommi:pen', this.onPen)
    this.pad?.unmount()
  }
})

// ---- elements ----
// Pad elements: the record, its geometry, how it is painted and how it is hit.
// No DOM state in here, so the same code paints the screen and the PNG an agent gets.
//
// One element is one record:
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
//   sticky  a note on yellow paper, held by a strip of tape (the corner note parked here): { text, size, color, wrap }
//           wrap is the paper's width; the box is the paper
//   image   { mime, nw, nh, name }

const INK = 'ink'   // the one colour that follows the theme: dark on light paper, light on dark
const PEN_COLORS = [[INK, 'Ink'], ['#e03131', 'Red'], ['#f08c00', 'Orange'], ['#2f9e44', 'Green'], ['#1971c2', 'Blue'], ['#9c36b5', 'Violet']]
const HL_COLORS = [['#ffd43b', 'Yellow'], ['#69db7c', 'Green'], ['#ff8cc6', 'Pink'], ['#66c2ff', 'Blue'], ['#ffa94d', 'Orange']]
const SIZES = { pen: [2, 4, 7, 12], hl: [10, 18, 28, 42] }
const TEXT_SIZE = 20
const TEXT_WRAP = 460      // a typed line breaks here unless the element was given a width
const LINE = 1.35
const VOICE_INSET = 14            // room for the bar that marks spoken text
// A sticky is the note as a conversation shows it taped on (notes.css .msg-note, .msg-note-tape): the same paper, ink,
// edge, turn and strip of tape, painted on the canvas. Lengths are for the sticky's own text size and scale with it.
const STICKY = { size: 17, w: 240, min: 104, padX: 16, top: 16, bottom: 14, turn: -1, paper: ['#fbe7a1', '#d9c35f'], ink: ['#3b300d', '#231c06'], edge: ['rgb(138 109 20 / .35)', '#a58c2c'], tape: ['rgb(230 210 122 / .62)', 'rgb(255 242 184 / .58)'], tapeW: 68, tapeH: 20, tapeUp: 10, tapeTurn: -5 }
const FONT_STACK = '"IBM Plex Sans", "Segoe UI", system-ui, sans-serif'
const textFont = size => `400 ${size}px ${FONT_STACK}`

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const r2 = v => Math.round(v * 100) / 100

// Ids sort by creation time (base36 milliseconds, then randomness), which keeps an
// append-only log and a directory listing in a sensible order.
function newId() {
  const rand = crypto.getRandomValues(new Uint8Array(8))
  return Date.now().toString(36).padStart(9, '0') + [...rand].map(b => (b % 36).toString(36)).join('')
}

const resolveInk = (color, dark) => (color === INK ? (dark ? '#e9eeea' : '#1b1f23') : color)

// ── strokes ─────────────────────────────────────────────────────────────────
// Constant-width strokes are one stroked path through the midpoints (quadratic
// smoothing). Pressure strokes become one filled path: discs along the curve
// joined by quads, all wound the same way so nonzero fill unions them.
// (Taken from js/scribble.js; the points are local to the element here.)
const geomCache = new WeakMap()
function buildGeom(s) {
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
function paintStroke(c, data, dark, g = geom(data)) {
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
/** Break the text of a text, voice or sticky element into lines. Returns { lines, w, h, inset, top, lh }: w and h are
 *  the element's box (a sticky's: its paper), inset and top where the first line begins in it. */
function layoutText(data, type = 'text') {
  let out = layoutCache.get(data)
  if (out) return out
  measureCtx ??= document.createElement('canvas').getContext('2d')
  const c = measureCtx
  c.font = textFont(data.size)
  const sticky = type === 'sticky', k = data.size / STICKY.size
  const inset = sticky ? STICKY.padX * k : type === 'voice' ? VOICE_INSET * (data.size / TEXT_SIZE) : 0
  const paper = sticky ? data.wrap ?? STICKY.w * k : 0
  const max = sticky ? Math.max(data.size * 2, paper - 2 * inset) : Math.max(data.size * 2, (data.wrap ?? TEXT_WRAP * (data.size / TEXT_SIZE)) - inset)
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
  out = sticky
    ? { lines, inset, top: STICKY.top * k, lh, w: r2(paper), h: r2(Math.max(STICKY.min * k, Math.max(1, lines.length) * lh + (STICKY.top + STICKY.bottom) * k)) }
    : { lines, inset, top: 0, lh, w: r2(Math.max(data.size * 0.6, Math.ceil(widest) + inset + 2)), h: r2(Math.max(1, lines.length) * lh) }
  layoutCache.set(data, out)
  return out
}

const isText = el => el.type === 'text' || el.type === 'voice' || el.type === 'sticky'

// ── painting ────────────────────────────────────────────────────────────────
/** Paint one element in world coordinates.
 *  env: { dark, accent, placeholder, picture(blobId) → { img, ok } } */
function paintElement(c, el, env) {
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
    const sticky = el.type === 'sticky', t = env.dark ? 1 : 0
    if (sticky) {
      // the paper, turned a little about its middle; on it, at the top, the strip of tape with its torn ends
      const k = d.size / STICKY.size, cx = el.x + el.w / 2, cy = el.y + el.h / 2
      c.save()
      c.translate(cx, cy); c.rotate(STICKY.turn * Math.PI / 180); c.translate(-cx, -cy)
      c.shadowColor = 'rgb(0 0 0 / .14)'; c.shadowBlur = 5 * k; c.shadowOffsetY = 1.5 * k
      c.fillStyle = STICKY.paper[t]
      c.fillRect(el.x, el.y, el.w, el.h)
      c.shadowColor = 'transparent'
      c.strokeStyle = STICKY.edge[t]; c.lineWidth = 1 * k
      c.strokeRect(el.x, el.y, el.w, el.h)
      const w = STICKY.tapeW * k, h = STICKY.tapeH * k
      c.save()
      c.translate(cx, el.y - STICKY.tapeUp * k + h / 2); c.rotate(STICKY.tapeTurn * Math.PI / 180)
      c.beginPath()
      for (const [px, py] of [[.03, 0], [1, 0], [.97, .25], [1, .5], [.97, .75], [1, 1], [0, 1], [.03, .75], [0, .5], [.03, .25]]) c.lineTo((px - .5) * w, (py - .5) * h)
      c.closePath()
      c.fillStyle = STICKY.tape[t]; c.fill()
      c.strokeStyle = 'rgb(0 0 0 / .08)'; c.lineWidth = .5 * k; c.stroke()
      c.restore()
    }
    c.font = textFont(d.size)
    c.textBaseline = 'middle'
    c.fillStyle = sticky ? STICKY.ink[t] : resolveInk(d.color, env.dark)
    lay.lines.forEach((line, i) => c.fillText(line, el.x + lay.inset, el.y + lay.top + (i + 0.5) * lay.lh))
    if (sticky) c.restore()
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

/** Is the world point on the element? tol is the slack in world units. */
function hitElement(el, wx, wy, tol) {
  if (wx < el.x - tol || wy < el.y - tol || wx > el.x + el.w + tol || wy > el.y + el.h + tol) return false
  if (el.type !== 'stroke') return true
  return strokeNear(el, wx, wy, wx, wy, tol)
}

/** Does the segment a→b (world) pass within r of the stroke's line? */
function strokeNear(el, ax, ay, bx, by, r) {
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
function inRect(el, x0, y0, x1, y1) {
  if (el.x > x1 || el.y > y1 || el.x + el.w < x0 || el.y + el.h < y0) return false
  if (el.type !== 'stroke') return true
  const d = el.data, sx = el.w / d.box[0], sy = el.h / d.box[1]
  for (let i = 0; i < d.pts.length; i += 2) {
    const x = el.x + d.pts[i] * sx, y = el.y + d.pts[i + 1] * sy
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return true
  }
  return false
}

function unionBox(list) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const e of list) { x0 = Math.min(x0, e.x); y0 = Math.min(y0, e.y); x1 = Math.max(x1, e.x + e.w); y1 = Math.max(y1, e.y + e.h) }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** Scale an element by k about the fixed world point (ax, ay). Uniform, so text and line widths follow. */
function scaled(el, k, ax, ay) {
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
function textOf(list) {
  return list.filter(isText)
    .sort((a, b) => (Math.abs(a.y - b.y) > Math.min(a.h, b.h) / 2 ? a.y - b.y : a.x - b.x))
    .map(e => e.data.text.trim()).filter(Boolean).join('\n\n')
}

/** A PNG of the bounding box of these elements, on white paper, without grid or
 *  selection frame. Returns { png (data URL), bbox, width, height }. */
function renderPNG(list, env, { max = 2000, margin = 24 } = {}) {
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
function renderRect(list, rect, env, { max = 2000 } = {}) {
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

// ---- the canvas timeline ----
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

const FLUSH_MS = 150
const SNAP_EVERY = 300
const SNAP_IDLE_MS = 4000
const ITEM_BYTES = 48_000
const SLICE = 2000          // shapes per slice when a big canvas is loaded
const breath = () => (globalThis.scheduler?.yield ? scheduler.yield() : new Promise(r => setTimeout(r)))   // a strokes item stays under the core's 60 KB body limit

export async function openCanvas({ client, timeline_id, onRemote, onState }) {
  const { CanvasState, entryOf, encodePoints, packSnapshot, unpackSnapshot, chunks } = await canvasWire()
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

// ---- fly ----
// The swoosh: a cut-out piece of the paper lifts off, flies in an arc to a session's mark and is
// swallowed there. Used by the pad itself (to a row of its chooser) and by the board around it
// (to a strip of session marks at the edge), so both look the same.
//
//   await flySheet(layer, { png, rect: { x, y, w, h }, target: node })
//
// layer: a positioned element that covers the screen; rect and the target's box are in its
// coordinates (both are full-screen layers, so: viewport coordinates). About 650 ms; with
// reduced motion the sheet fades where it is and the mark blinks once.

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const done = anim => anim.finished.catch(() => {})

/** The mark takes it in: a small bounce (or one blink). */
function gulp(target) {
  if (!target?.animate) return Promise.resolve()
  if (reduced()) return done(target.animate([{ opacity: 1 }, { opacity: 0.25 }, { opacity: 1 }], { duration: 320 }))
  return done(target.animate(
    [{ scale: '1' }, { scale: '1.32', offset: 0.3 }, { scale: '0.9', offset: 0.62 }, { scale: '1.06', offset: 0.82 }, { scale: '1' }],
    { duration: 380, easing: 'ease-out' },
  ))
}

async function flySheet(layer, { png, rect, target }) {
  const sheet = document.createElement('div')
  Object.assign(sheet.style, {
    position: 'absolute', left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px`,
    background: `#fff url("${png}") center / 100% 100% no-repeat`, borderRadius: '2px', pointerEvents: 'none',
    transformOrigin: '50% 50%', willChange: 'transform, opacity', zIndex: '9',
  })
  layer.append(sheet)
  try {
    if (reduced()) {
      await done(sheet.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, easing: 'ease-out' }))
      sheet.remove()
      return gulp(target)
    }
    // The snip: the piece comes loose, tilts a little and casts a shadow.
    const lift = 'translate(0px, -6px) rotate(-2.5deg) scale(1.03)'
    const shadowUp = '0 0 0 1px rgb(20 30 25 / .18), 0 18px 36px -10px rgb(20 30 25 / .45)'
    await done(sheet.animate(
      [{ transform: 'none', boxShadow: '0 0 0 1.5px rgb(20 30 25 / .5)' }, { transform: lift, boxShadow: shadowUp }],
      { duration: 170, easing: 'cubic-bezier(.2, .9, .3, 1.3)', fill: 'forwards' },
    ))
    // The flight: an arc to the middle of the mark, shrinking to its size.
    const to = target.getBoundingClientRect(), base = layer.getBoundingClientRect()
    const dx = to.left - base.left + to.width / 2 - (rect.x + rect.w / 2)
    const dy = to.top - base.top + to.height / 2 - (rect.y + rect.h / 2)
    const end = Math.max(0.04, Math.min(1, (Math.min(to.width, to.height) * 0.9) / Math.max(rect.w, rect.h)))
    const rise = Math.min(160, 40 + Math.hypot(dx, dy) * 0.22)   // how far the arc bows upward
    const N = 14, frames = []
    for (let i = 0; i <= N; i++) {
      const t = i / N, k = t * t * (3 - 2 * t)            // slow out of the paper, quick into the mark
      const x = dx * k, y = dy * k - rise * Math.sin(Math.PI * k) - 6 * (1 - k)
      const s = 1.03 + (end - 1.03) * k ** 1.4
      frames.push({ transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${(-2.5 - 14 * Math.sin(Math.PI * k)).toFixed(1)}deg) scale(${s.toFixed(3)})`, boxShadow: shadowUp, opacity: 1, offset: t })
    }
    await done(sheet.animate(frames, { duration: 430, easing: 'cubic-bezier(.45, 0, .7, .6)', fill: 'forwards' }))
    const bounce = gulp(target)
    await done(sheet.animate([{ opacity: 1 }, { opacity: 0, transform: `${frames.at(-1).transform} scale(.2)` }], { duration: 90, easing: 'ease-in', fill: 'forwards' }))
    sheet.remove()
    await bounce
  } finally {
    sheet.remove()
  }
}

// ---- the pad: mounted on the page /whiteboard by the controller "whiteboard" ----
// main: the page's <main> (pad markup inside); canvasId: the canvas timeline; client: the room's core client.
// Returns { setSessions(list), unmount() }.
function mountPad(main, { canvasId: PAD, client }) {
  const listening = new AbortController()
  // (Under the Desk's sheet the pad is mounted but not the page: what the window and the document hear is not its.)
  const here = () => document.body.dataset.tView === 'whiteboard'
  const on = (target, type, fn, opts = {}) => target.addEventListener(type, target === window || target === document ? e => { if (here()) fn(e) } : fn, { ...(typeof opts === 'boolean' ? { capture: opts } : opts), signal: listening.signal })
  const board = { board: true, sessions: [] }
  const AUTHOR = 'human'   // a record made here; on the wire the author is the signed sender (canvas.js)
  const MIN_Z = 0.05, MAX_Z = 8
  const UNDO_MAX = 200
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
  for (const node of main.querySelectorAll('[data-icon]')) node.prepend(icon(node.dataset.icon))

  // ── state ───────────────────────────────────────────────────────────────────
  let timeline = null            // the canvas timeline (canvas.js), once it is loaded
  let canvasLoaded
  const canvasReady = new Promise(resolve => { canvasLoaded = resolve })   // the promise of it
  const early = []               // changes made before it was loaded: they go out once it is
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
  let lastClick = { id: null, t: 0 }
  let area = null                // the framed area waiting for a session: { x, y, w, h } in world units, list
  let toolBefore = 'pen'         // what was in hand before the area tool
  let theme = {}                 // colours read from the tokens
  const pictures = new Map()     // blob id → { img, ok, ready }

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

  let firstLook = false   // no view was saved on this device and nothing is on the pad yet
  /** Records that came from the server: another tab or device changed them, or the server
   *  confirmed ours (with its time, its running number, and where they were sent). */
  function applyRemote(records) {
    for (const r of records) {
      revs.set(r.id, Math.max(revs.get(r.id) ?? 0, r.rev ?? 1))
      if (r.deleted) { els.delete(r.id); sel.delete(r.id) }
      else els.set(r.id, r)
    }
    order = null
    refresh()
    // A device that has never looked at this pad starts with all of it in view.
    if (firstLook && els.size && !gesture && !edit) fit(false)
    firstLook = false
  }
  /** Change the pad. changes: [{ id, before, after }]; after null deletes. One call is one undo step. */
  function apply(changes, record = true, how = 'erase') {
    changes = changes.filter(c => c.before !== c.after)
    if (!changes.length) return
    for (const c of changes) {
      if (c.after) els.set(c.id, c.after)
      else { els.delete(c.id); sel.delete(c.id) }
    }
    order = null
    if (timeline) timeline.push(changes, how); else early.push([changes, how])
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
      p.ready = canvasReady.then(c => c.getBlob(id)).then(found => new Promise(resolve => {
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
      if (gesture?.erased?.has(el.id)) continue
      if (el.id === edit?.id) { if (el.type === 'sticky') paintElement(c, { ...el, data: { ...el.data, text: '' } }, e); continue }
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
  const VIEW_KEY = `trommi-pad-view:${PAD}`
  let viewTimer = 0
  function saveViewSoon() {
    clearTimeout(viewTimer)
    viewTimer = setTimeout(() => { try { localStorage.setItem(VIEW_KEY, JSON.stringify({ ...view, style, tool: drawTool })) } catch {} }, 500)
  }
  function setView(x, y, z) {
    view.x = x; view.y = y; view.z = z
    $('zoom').textContent = `${Math.round(z * 100)} %`
    saveViewSoon()
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
    $('hint').dataset.show = String(!els.size && !edit && !gesture)
    for (const b of main.querySelectorAll('.pad-tool')) b.setAttribute('aria-pressed', String(b.dataset.tool === tool))
    pad.dataset.tool = tool
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
    renderStatus()
    updateCursor()
    dirty()
  }
  function renderStatus() {
    const b = board
    const n = els.size
    const s = timeline?.state() ?? { mode: 'starting', pending: 0 }
    const where = s.error ? `not saved (${s.error})`
      : s.mode === 'online' ? (s.pending ? 'saving…' : 'saved, end-to-end encrypted')
      : s.mode === 'offline' ? 'no connection: kept on this device until it is back'
      : s.mode === 'starting' ? 'loading'
      : 'kept in this page only (mock room)'
    const count = `${b.sessions.length} session${b.sessions.length === 1 ? '' : 's'}`
    $('status').textContent = `${n} element${n === 1 ? '' : 's'} · ${where} · ${count}`
    $('status').dataset.kind = s.error ? 'error' : s.mode === 'offline' ? 'warn' : ''
    pad.dataset.sync = s.mode
  }
  function updateCursor(mode) {
    pad.dataset.cursor = mode ?? (spaceDown ? 'grab' : tool === 'select' ? 'select' : tool === 'eraser' ? 'eraser' : tool === 'area' ? 'area' : tool === 'text' ? 'text' : 'draw')
  }
  let toastTimer = 0
  function note(text, kind = 'info', ms = 2800) {
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
    note(`${list.length} elements grouped`)
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
    editor.style.color = spec.type === 'sticky' ? STICKY.ink[dark() ? 1 : 0] : resolveInk(spec.color, dark())
    editor.style.maxWidth = `${spec.max ?? spec.wrap ?? TEXT_WRAP * (spec.size / TEXT_SIZE)}px`
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
    // (a sticky's words begin inside its paper, which stays while they are edited)
    const lay = layoutText(el.data, el.type), sticky = el.type === 'sticky'
    openEditor({ id: el.id, type: el.type, x: el.x + (sticky ? lay.inset : 0), y: el.y + lay.top, size: el.data.size, color: el.data.color, wrap: el.data.wrap, ...(sticky ? { max: el.w - 2 * lay.inset } : {}) }, el.data.text)
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
      if (el) { sel.clear(); sel.add(el.id); refresh() }
    }
  })
  editor.addEventListener('blur', () => {
    // the window lost focus (another tab, a dialog): the note stays open
    setTimeout(() => { if (edit && document.hasFocus() && document.activeElement !== editor) commitEditor() }, 0)
  })
  editor.addEventListener('paste', e => {
    const files = [...(e.clipboardData?.files ?? [])].filter(f => f.type.startsWith('image/'))
    if (!files.length) return
    e.preventDefault()
    const at = [view.x + edit.x * view.z, view.y + edit.y * view.z]
    commitEditor()
    addImages(files, at)
  })

  /** Where a note lands when no spot was clicked: the open cursor, else the middle of the screen. */
  function spot() {
    if (edit) return [edit.x, edit.y + (edit.size * 1.35) / 2]
    return toWorld(W / 2, H * 0.42)
  }
  // this button must not take the focus from the open note: it marks the spot
  $('image').addEventListener('mousedown', e => e.preventDefault())

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
    if (!list.length) return note('That is not a picture.', 'error')
    note(list.length > 1 ? `Adding ${list.length} pictures…` : 'Adding the picture…', 'busy', 0)
    const added = []
    let failed = 0, z = topZ()
    for (const f of list) {
      try {
        const { blob, nw, nh } = await importImage(f)
        const id = await (await canvasReady).putBlob(blob, { nw, nh, name: f.name })
        await picture(id).ready
        const k = Math.min(1, (0.6 * W) / view.z / nw, (0.5 * Math.max(120, H - 150)) / view.z / nh)
        const w = r2(nw * k), h = r2(nh * k)
        const [cx, cy] = at ? toWorld(at[0], at[1]) : toWorld(W / 2, (H - 20) / 2)
        const off = (added.length * 28) / view.z
        added.push(make('image', { x: cx - w / 2 + off, y: cy - h / 2 + off, w, h }, { mime: blob.type, nw, nh, name: f.name || '' }, ++z, id))
      } catch { failed++ }
    }
    $('toast').hidden = true
    if (failed) note(failed > 1 ? `${failed} pictures could not be read.` : 'The picture could not be read.', 'error', 4000)
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
    const el = make('stroke', s, s.data, g.z)
    timeline?.claim(g, el.id)   // its pieces went out while it was drawn: this is the rest of it
    add([el])
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
    if (g.type === 'draw' && g.moved && performance.now() - g.t0 > 350 && g.pts.length > 24) endDraw(g)
    else if (g.type === 'draw') timeline?.drop(g)
    if (g.type === 'erase' && g.erased.size) remove([...g.erased].map(id => els.get(id)).filter(Boolean))
    dirty()
  }
  function startPinch() {
    const [a, b] = [...pointers.values()]
    gesture = { type: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, view: { ...view } }
  }

  canvas.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button === 2) return
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

    if (e.button === 1 || spaceDown) {
      e.preventDefault()
      gesture = { ...base, type: 'pan', vx: view.x, vy: view.y }
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
      } else if (tool === 'select' || (e.shiftKey && !hit)) {
        gesture = { ...base, type: 'marquee', keep: e.shiftKey ? new Set(sel) : new Set() }
      } else {
        const st = style[tool]
        gesture = { ...base, type: 'draw', hit, tool, color: st.color, size: SIZES[tool][st.w], pen: tool === 'pen' && e.pointerType === 'pen', pts: [], pr: [], z: topZ() + 1 }
        addPoint(gesture, e, true)
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
      const z = clamp(g.view.z * (Math.hypot(a.x - b.x, a.y - b.y) || 1) / g.d, MIN_Z, MAX_Z)
      const wx = (g.cx - g.view.x) / g.view.z, wy = (g.cy - g.view.y) / g.view.z
      return setView((a.x + b.x) / 2 - wx * z, (a.y + b.y) / 2 - wy * z, z)
    }
    if (g.id !== e.pointerId) return
    g.qx = px; g.qy = py
    if (!g.moved && Math.hypot(px - g.px, py - g.py) > CLICK_PX) { g.moved = true }
    if (g.type === 'pan') return setView(g.vx + px - g.px, g.vy + py - g.py, view.z)
    if (g.type === 'draw') {
      const list = e.getCoalescedEvents?.() ?? []
      for (const c of list.length ? list : [e]) addPoint(g, c, false)
      if (g.moved) timeline?.live(g)   // others see it while it is drawn: a piece every ~150 ms
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
    const g = gesture
    if (!g || !had) return
    if (g.type === 'pinch') {
      if (pointers.size < 2) gesture = null
      return refresh()
    }
    if (g.id !== e.pointerId) return
    gesture = null
    const cancelled = e.type === 'pointercancel'
    const click = !g.moved && !cancelled
    if (g.type === 'draw') {
      if (g.moved && !cancelled) { addPoint(g, e, true); endDraw(g) }
      else if (click && g.hit) { select(g.hit, g.shift); lastClick = { id: g.hit.id, t: performance.now() } }
      else if (click) placeCaret(g.wx, g.wy)
    } else if (g.type === 'marquee') {
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
  for (const b of main.querySelectorAll('.pad-tool')) {
    b.addEventListener('click', () => { if (tool === b.dataset.tool && (tool === 'pen' || tool === 'hl')) toggleStyle(); else if (tool === 'area' && b.dataset.tool === 'area') setTool(toolBefore); else setTool(b.dataset.tool) })   // (the scissors again: out of cutting)
  }
  function setTheme(next) {
    if (next === dark()) return
    if (next) root.dataset.theme = 'dark'; else delete root.dataset.theme
  }
  $('theme').addEventListener('click', () => {
    const next = !dark()
    setTheme(next)
    try { localStorage.setItem('agent-board-theme', next ? 'dark' : 'light') } catch {}
  })
  $('help-btn').addEventListener('click', () => $('help').showModal())
  for (const dialog of main.querySelectorAll('dialog')) {
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
  on(document, 'paste', e => {
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
  on(document, 'keydown', e => {
    if (e.defaultPrevented || e.altKey || document.querySelector('dialog[open]')) return
    if (e.target === editor) return   // the note has its own keys; everything else is text
    const cmd = e.ctrlKey || e.metaKey
    const key = e.key.toLowerCase()
    if (e.key === 'Escape') {
      if (area) { if (!area.sending) clearArea() }
      else if (!$('style').hidden || !$('send-menu').hidden) closePopovers()
      else if (tool === 'area') setTool(toolBefore)
      else if (sel.size) { sel.clear(); refresh() }
      return
    }
    if (cmd) {
      if (key === 'z') { e.preventDefault(); step(e.shiftKey ? redo : undo, e.shiftKey ? undo : redo) }
      else if (key === 'y') { e.preventDefault(); step(redo, undo) }
      else if (key === 'a') { e.preventDefault(); sel.clear(); for (const el of ordered()) sel.add(el.id); refresh() }
      else if (key === 'd') { e.preventDefault(); duplicate() }
      else if (key === 'g') { e.preventDefault(); toggleGroup(!e.shiftKey) }
      return
    }
    if (e.key === ' ') {
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
    else if (key === 'i') $('file').click()
    else if (key === 's') { if (sel.size) $('send-to').click() }
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
  on(document, 'keyup', e => { if (e.key === ' ') spaceUp() })
  on(window, 'blur', spaceUp)

  // ── send a selection to a session ───────────────────────────────────────────
  let sending = null   // { session, payload, list }
  function closeSendMenu() {
    if ($('send-menu').hidden) return
    $('send-menu').hidden = true
    $('send-to').setAttribute('aria-expanded', 'false')
  }
  function openSendMenu() {
    const menu = $('send-menu')
    const b = board
    const head = Object.assign(document.createElement('p'), { className: 'pad-menu-head', textContent: b.board ? 'Sessions on this board' : 'Sample sessions (no board)' })
    const here = new Set()
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
  const preferred = () => null
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

  /** What a session receives for a selection. */
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
      await sendTo(session, payload)
      takeAway(payload.elements.map(e => e.id))
      $('send-dialog').close()
      note(`Sent to ${session.name}`)
    } catch (err) {
      out.textContent = `Not sent. ${err.message}`
      out.hidden = false
      $('send-go').textContent = 'Try again'
      $('send-go').disabled = false
    }
  })

  /** The picture of the selection and its words go to the session (canvas.js send: selection_sent, end-to-end). */
  async function sendTo(session, payload) {
    if (!session.device) throw new Error('That session has no device in this room.')
    await (await canvasReady).send({ to: session.device, text: payload.text, png: payload.png, ids: payload.elements.map(e => e.id) })
  }

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
    apply(changes, true, 'send_away')
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
    if (!list.length) return note('Nothing in that area. Frame something that is on the paper.')
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
    // The scribble comes from the board's own page, not from anyone's input.
    if (s.mark) mark.innerHTML = s.mark
    else mark.textContent = (s.name || '?').trim().charAt(0).toUpperCase()
    return mark
  }
  function openAreaMenu() {
    const menu = $('area-menu')
    const b = board
    const here = new Set(), recent = lastSentTo()
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
        pad: PAD, session: session.id,
        elements: a.list.map(e => ({ id: e.id, type: e.type, rev: e.rev, ...(isText(e) ? { text: e.data.text } : {}) })),
        text: textOf(a.list), bbox: shot.bbox, png: shot.png,
      }
      const rect = { x: a.x * view.z + view.x, y: a.y * view.z + view.y, w: a.w * view.z, h: a.h * view.z }
      // The snip, then the flight into the chooser's row; the sending runs meanwhile.
      a.cut = true
      invalidate()
      const flight = (async () => {
        await new Promise(r => setTimeout(r, 90))
        a.gone = true
        invalidate()
        await flySheet($('fly'), { png: shot.png, rect, target: item.querySelector('.pad-mark') ?? item })
      })()
      const post = (async () => {
        await sendTo(session, payload)
        return {}
      })()
      const [, answer] = await Promise.all([flight, post.then(v => v, err => ({ failed: err }))])
      if (answer.failed) throw answer.failed
      takeAway(a.list.map(e => e.id), a)
      // What was sent cannot be taken back (the agent has it), so the note only says where it went. Undo puts it back on the paper.
      note(`Sent to ${session.name}`, 'info', 4000)
      area = null
      $('area-menu').hidden = true
      if (tool === 'area') setTool(toolBefore)
    } catch (err) {
      area = null
      $('area-menu').hidden = true
      note(`Not sent. ${err.message}`, 'error', 6000)
    }
    refresh()
  }

  // ── start ───────────────────────────────────────────────────────────────────
  const resized = new ResizeObserver(() => {
    const w = pad.clientWidth, h = pad.clientHeight
    if (w === W && h === H) return
    if (W && H && w && h) { view.x += (w - W) / 2; view.y += (h - H) / 2 }
    W = w; H = h
    if (!W || !H) return
    sizeCanvas()
    if (raf) { cancelAnimationFrame(raf); raf = 0 }
    paint()
  })
  resized.observe(pad)
  const themed = new MutationObserver(() => {
    readTheme()
    paintSwatches()
    if (edit) editor.style.color = resolveInk(edit.color, dark())
    refresh()
  })
  themed.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
  on(window, 'pagehide', () => commitEditor())
  on(document, 'visibilitychange', () => { if (document.visibilityState === 'hidden' && edit && editor.textContent) commitEditor() })

  async function start() {
    readTheme()
    let saved = null
    try { saved = JSON.parse(localStorage.getItem(VIEW_KEY) ?? 'null') } catch {}
    W = pad.clientWidth; H = pad.clientHeight
    sizeCanvas()
    if (saved?.z) {
      Object.assign(view, { x: saved.x, y: saved.y, z: clamp(saved.z, MIN_Z, MAX_Z) })
      if (saved.style?.pen && saved.style?.hl) Object.assign(style, saved.style)
      if (saved.tool === 'hl') drawTool = 'hl'
    } else { setView(W / 2, H / 2, 1); firstLook = !els.size }
    $('zoom').textContent = `${Math.round(view.z * 100)} %`
    buildSwatches()
    refresh()
    paintSendTo()
    // The paper works at once; what is on it comes from the room (snapshot + tail), end-to-end encrypted.
    timeline = await openCanvas({ client, timeline_id: PAD, onRemote: applyRemote, onState: renderStatus })
    canvasLoaded(timeline)
    await timeline.eachSlice(list => { for (const r of list) els.set(r.id, r) })
    order = null
    for (const [changes, how] of early.splice(0)) timeline.push(changes, how)
    if (!saved?.z && els.size) fit(false)
    refresh()
  }

  // ---- a note parked here (sidebar.mjs, the corner note dragged onto the board): a sticky, an element of its own ----
  // It is moved, selected, sent with a selection and deleted like any element; a double click edits its words.
  function addSticky(text, wx, wy) {
    const data = { text, size: STICKY.size, color: INK, wrap: STICKY.w }
    const lay = layoutText(data, 'sticky')
    const el = makeText('sticky', r2(wx - lay.w / 2), r2(wy - lay.h / 2), data)
    add([el])
    sel.clear()
    refresh()
  }
  on(document, 'trommi:park-note', e => {
    const box = pad.getBoundingClientRect(), { text, x, y } = e.detail ?? {}
    if (!String(text ?? '').trim() || x < box.left || x > box.right || y < box.top || y > box.bottom) return
    commitEditor()
    addSticky(String(text).trim(), ...toWorld(x - box.left, y - box.top))
    e.detail.taken = true
  })

  // For scripts that drive the page (dev/e2e.mjs) and for the curious in the console.
  window.pad = {
    elements: () => ordered(),
    selection: () => [...sel],
    view: () => ({ ...view }),
    state: () => ({ tool, editing: Boolean(edit), undo: undo.length, redo: redo.length, board, sync: timeline?.state(), timing: timeline?.timing }),
    settled: () => canvasReady.then(c => c.settled()),
    timeline: () => timeline,
    area: () => (area ? { x: area.x, y: area.y, w: area.w, h: area.h, ids: area.list.map(e => e.id), sending: Boolean(area.sending) } : null),
    payload: async session => (await buildPayload(session ?? board.sessions[0], selected())).payload,
    tool: name => setTool(name),
    rest: () => { commitEditor(); closePopovers(); sel.clear(); setTool('select') },
    world: (px, py) => toWorld(px, py),
  }

  start()
  return {
    setSessions(list) { board.sessions = list; renderStatus(); paintSendTo() },
    unmount() {
      commitEditor()
      listening.abort(); resized.disconnect(); themed.disconnect()
      cancelAnimationFrame(raf)
      timeline?.close()
      delete window.pad
    },
  }
}
