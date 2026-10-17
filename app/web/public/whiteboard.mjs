// The Scribble Board: the page /scribble-board, and the pad the Desk keeps under its turned corner (app.mjs bodyParts:
// whiteboardMain(vm), part "pad").
//
//   register(t)           the page /scribble-board: the pad as large as the main area
//
// It draws the board the core has in view (vm.board, BoardView: shapes in board units, others' strokes still drawn,
// this device's items not back yet) and sends what the person does: Action::BoardItem (strokes, erase, send_away,
// move), Action::StrokePiece (a stroke while it is drawn), t.attach (a picture's bytes). The board is the team's
// in view. The pad runs on the page
// itself (mountPad, controller "whiteboard"); linkBoard ties its element records to the view model.
import { Controller, controller, html, isTyping, letterKeysOn, markArt, raw, sk, sayError, whoOf } from './ui.mjs'

/** The board toolkit (app.mjs createBoard), once register(t) ran. */
let T = null

// ---- palette, ink: how a stroke looks and how its points are packed (pure drawing and encoding, no rules) ----
// A stroke and a note carry a palette token, never a colour value: each is painted in its light or dark look.
const PALETTE = {
  ink: { pen: ['#1b1f23', '#e9eeea'] },
  red: { pen: ['#e03131', '#ff6b6b'], marker: ['#ff8787', '#ff8787'] },
  orange: { pen: ['#f08c00', '#ffa94d'], marker: ['#ffa94d', '#ffa94d'] },
  yellow: { pen: ['#e8b400', '#ffd43b'], marker: ['#ffd43b', '#ffd43b'] },
  green: { pen: ['#2f9e44', '#51cf66'], marker: ['#69db7c', '#69db7c'] },
  blue: { pen: ['#1971c2', '#4dabf7'], marker: ['#66c2ff', '#66c2ff'] },
  violet: { pen: ['#9c36b5', '#cc5de8'], marker: ['#b197fc', '#b197fc'] },
  pink: { pen: ['#d6336c', '#f783ac'], marker: ['#ff8cc6', '#ff8cc6'] },
}
const PEN_COLORS = ['ink', 'red', 'orange', 'green', 'blue', 'violet']
const MARKER_COLORS = ['yellow', 'green', 'pink', 'blue', 'orange']
const MARKER_OPACITY = { light: 0.5, dark: 0.38 }
/** A token's colour for a tool on light or dark paper (an unknown token: the tool's first colour). */
function colorOf(token, tool = 'pen', dark = false) {
  const set = tool === 'marker' ? 'marker' : 'pen'
  return (PALETTE[token]?.[set] ?? PALETTE[set === 'marker' ? 'yellow' : 'ink'][set])[dark ? 1 : 0]
}
const TAU = Math.PI * 2, HALF_PI = Math.PI / 2
const fin = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
/** The most points of one stroke (and of one piece); more is refused as a whole. */
const MAX_POINTS = 10_000
/** How thick the pen is at a force, as a factor of its width. */
const thickness = f => 0.3 + 1.4 * Math.sqrt(clamp(fin(f), 0, 1))
/** A force for an input without pressure, from its speed (px per ms); prev: the force before (null at the start). */
function forceFromSpeed(prev, speed) {
  const target = clamp(0.36 - 0.075 * fin(speed), 0.07, 0.36)
  return prev == null ? 0.2 : prev + (target - prev) * 0.3
}
/** Pointer Events tiltX/tiltY (degrees) -> { az, al } in radians, as PencilKit measures them. */
function anglesOfTilt(tiltX = 0, tiltY = 0) {
  const tx = (clamp(fin(tiltX), -89, 89) * Math.PI) / 180, ty = (clamp(fin(tiltY), -89, 89) * Math.PI) / 180
  if (!tx && !ty) return { az: 0, al: HALF_PI }
  const X = Math.tan(tx), Y = Math.tan(ty)
  return { az: (Math.atan2(Y, X) + TAU) % TAU, al: Math.atan(1 / Math.hypot(X, Y)) }
}
/** An ink -> the packed points of a BoardItem's stroke (base64url; spec/v1.md 10.6, trommi-core board_items::Ink):
 *  flags (bit 0 tilt, bit 1 simulated force), then per point zigzag LEB128 dx, dy in 1/16 unit, LEB128 dt in ms,
 *  force 0..255, and with tilt azimuth and altitude 0..255. */
function packPoints(ink) {
  const p = ink.pts, n = p.length >> 1, az = ink.az, al = ink.al
  const tilt = Boolean(az && al && az.length >= n && al.length >= n)
  const out = [(tilt ? 1 : 0) | (ink.sim ? 2 : 0)]
  const put = v => { while (v >= 128) { out.push((v % 128) + 128); v = Math.floor(v / 128) } out.push(v) }
  const zig = d => ((d << 1) ^ (d >> 31)) >>> 0
  let lx = 0, ly = 0, lt = 0
  for (let i = 0; i < n; i++) {
    const x = Math.round(fin(p[2 * i]) * 16) | 0, y = Math.round(fin(p[2 * i + 1]) * 16) | 0
    const t = Math.min(0xffffffff, Math.max(i ? lt : 0, Math.round(fin(ink.t?.[i] ?? lt))))
    put(zig((x - lx) | 0)); put(zig((y - ly) | 0)); put(t - lt)
    out.push(Math.round(clamp(fin(ink.f?.[i] ?? 0.5), 0, 1) * 255))
    if (tilt) out.push(Math.round(((((fin(az[i]) % TAU) + TAU) % TAU) / TAU) * 256) % 256, Math.round((clamp(fin(al[i]), 0, HALF_PI) / HALF_PI) * 255))
    lx = x; ly = y; lt = t
  }
  let s = ''
  for (const b of out) s += String.fromCharCode(b)
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
/** The stroke's line as samples [x, y, r, …] along the clamped uniform cubic B-spline of its points (PencilKit's
 *  shape); from, to: only those spans (a stroke being drawn is sampled piece by piece). */
function sampleStroke(pts, f, { tool = 'pen', width = 4, step = 1, from = 0, to = Infinity } = {}) {
  const n = pts.length >> 1
  if (!n) return []
  const half = width / 2
  const rAt = i => (tool === 'marker' ? half : half * thickness(f?.[i] ?? 0.25))
  if (n === 1) return [pts[0], pts[1], rAt(0)]
  const P = j => Math.min(n - 1, Math.max(0, j - 2))
  const out = [pts[0], pts[1], rAt(0)]
  if (from > 0) {
    const a = P(from), b = P(from + 1), c = P(from + 2)
    out[0] = (pts[2 * a] + 4 * pts[2 * b] + pts[2 * c]) / 6; out[1] = (pts[2 * a + 1] + 4 * pts[2 * b + 1] + pts[2 * c + 1]) / 6; out[2] = (rAt(a) + 4 * rAt(b) + rAt(c)) / 6
  }
  for (let s = Math.max(0, from); s <= Math.min(n, to); s++) {
    const i0 = P(s), i1 = P(s + 1), i2 = P(s + 2), i3 = P(s + 3)
    const x0 = pts[2 * i0], y0 = pts[2 * i0 + 1], x1 = pts[2 * i1], y1 = pts[2 * i1 + 1], x2 = pts[2 * i2], y2 = pts[2 * i2 + 1], x3 = pts[2 * i3], y3 = pts[2 * i3 + 1]
    const r0 = rAt(i0), r1 = rAt(i1), r2_ = rAt(i2), r3 = rAt(i3)
    const len = Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2)
    const steps = Math.max(1, Math.min(64, Math.ceil(len / 3 / step)))
    for (let k = 1; k <= steps; k++) {
      const t = k / steps, t2 = t * t, t3 = t2 * t, u = 1 - t
      const b0 = (u * u * u) / 6, b1 = (3 * t3 - 6 * t2 + 4) / 6, b2 = (-3 * t3 + 3 * t2 + 3 * t + 1) / 6, b3 = t3 / 6
      const x = b0 * x0 + b1 * x1 + b2 * x2 + b3 * x3, y = b0 * y0 + b1 * y1 + b2 * y2 + b3 * y3
      const m = out.length
      if (Math.abs(x - out[m - 3]) + Math.abs(y - out[m - 2]) < step * 0.25 && !(s === n && k === steps)) continue
      out.push(x, y, b0 * r0 + b1 * r1 + b2 * r2_ + b3 * r3)
    }
  }
  return out
}

// ---- the page ----
/** The team the board belongs to, as the sidebar has it: the pad is mounted again when it changes. */
const teamInView = vm => vm.sidebar?.team ?? ''

/** The sessions for the pad's "Send to…" (read by the controller), and when the board last changed: the controller
 *  draws the board again when this element is replaced (a new render, a picture's bytes came). */
function whiteboardSessions(vm) {
  const sessions = (vm.sidebar?.sessions ?? []).map(s => { const w = whoOf(s); return { id: s.id, name: w.name, online: w.online, hue: w.hue, mark: String(markArt({ ...w, crowned: false })) } })
  const pictures = (vm.board?.shapes ?? []).filter(s => s.attachment && T?.fileUrl(s.attachment)).length
  return html`<div id="whiteboard-sessions" hidden data-rev="${vm.rev}:${pictures}" data-sessions="${JSON.stringify(sessions)}"></div>`
}

/** The Scribble Board's page. It is a part of its own in the frame (app.mjs bodyParts, key "pad"): the Desk keeps the
 *  same markup under its sheet once the corner was touched, so a turn of the page mounts nothing anew. */
export const whiteboardMain = vm => raw(`<main id="whiteboard" aria-label="Scribble Board" data-controller="whiteboard" data-whiteboard-canvas-value="${teamInView(vm)}">
${whiteboardSessions(vm)}
<div class="pad" id="pad" data-tool="pen" data-place data-owns-keys>
  <canvas class="pad-canvas" id="canvas" role="img" aria-label="Scribble Board: an endless surface for notes, drawings and pictures"></canvas>

  <p class="pad-hint" id="hint"><b><span class="if-mouse">Click</span><span class="if-touch">Tap</span> anywhere</b> and type. <b>Drag</b> to draw.</p>

  <div class="pad-editor" id="editor" role="textbox" aria-multiline="true" aria-label="Note" spellcheck="false" hidden></div>
  <div class="pad-caret-tip" id="caret-tip" hidden>
    <span>Type · Esc closes</span>
  </div>

  <div class="pad-top">
    <div class="pad-pill">
      <button type="button" class="pad-icon-btn" id="zoom-out" data-icon="minus" aria-label="Zoom out" data-tip="Zoom out · -"></button>
      <button type="button" class="pad-zoom" id="zoom" aria-label="Reset zoom to 100 %" data-tip="100 % · 0">100 %</button>
      <button type="button" class="pad-icon-btn" id="zoom-in" data-icon="plus" aria-label="Zoom in" data-tip="Zoom in · +"></button>
      <button type="button" class="pad-icon-btn" id="fit" data-icon="fit" aria-label="Fit everything" data-tip="Fit everything · F"></button>
    </div>
  </div>

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
  <div class="pad-menu pad-area-menu" id="area-menu" role="menu" aria-label="Send this area to a session" hidden></div>
  <div class="pad-fly" id="fly" aria-hidden="true"></div>

  <div class="pad-bar">
    <div class="pad-pill pad-tools" role="toolbar" aria-label="Tools">
      <button type="button" class="pad-icon-btn" id="undo" data-icon="undo" aria-label="Undo" data-tip="Undo · Ctrl+Z"></button>
      <button type="button" class="pad-icon-btn" id="redo" data-icon="redo" aria-label="Redo" data-tip="Redo · Ctrl+Shift+Z"></button>
      <span class="pad-sep"></span>
      <button type="button" class="pad-icon-btn pad-tool" data-tool="select" data-icon="select" aria-label="Select" data-tip="Select · V"></button>
      <button type="button" class="pad-icon-btn pad-tool" data-tool="pen" data-icon="pen" aria-label="Pen; again: colour and width" aria-haspopup="true" aria-expanded="false" data-tip="Pen (P)"></button>
      <button type="button" class="pad-icon-btn pad-tool" data-tool="marker" data-icon="marker" aria-label="Highlighter; again: colour and width" aria-haspopup="true" aria-expanded="false" data-tip="Highlighter (H)"></button>
      <button type="button" class="pad-icon-btn pad-tool" data-tool="eraser" data-icon="eraser" aria-label="Eraser" data-tip="Eraser · E"></button>
      <button type="button" class="pad-icon-btn pad-tool" data-tool="text" data-icon="text" aria-label="Text: click on the paper and type" data-tip="Text · T"></button>
      <div class="pad-style" id="style" hidden>
        <div class="pad-style-row"><span class="pad-label">Colour</span><div class="pad-swatches" id="swatches" role="group" aria-label="Colour"></div></div>
        <div class="pad-style-row"><span class="pad-label">Width</span><div class="pad-widths" id="widths" role="group" aria-label="Width"></div></div>
      </div>
      <span class="pad-sep"></span>
      <button type="button" class="pad-icon-btn" id="image" data-icon="clip" aria-label="Attach a picture" data-tip="Picture (I)"></button>
    </div>
    <button type="button" class="pad-tool pad-cut" data-tool="area" aria-label="Cut out and send to an agent" data-tip="Send (A)"><svg viewBox="0 -9 76 56" aria-hidden="true"><path class="cut-line" d="M17 4.2 Q44 3.4 71.4 4 Q72.2 23 71.6 42 Q44 42.8 17.4 42.2 Q16.6 23 17 4.2"/><g class="cut-letter"><path class="cut-paper" d="M24 11.4 L64.6 10.8 L65 35.4 L24.4 36 Z"/><path d="M24 11.4 Q44 10.6 64.6 10.8 Q65.2 23 65 35.4 Q44 36.2 24.4 36 Q23.6 23 24 11.4"/><path d="M24.4 12 Q34.6 20.6 44.2 25 Q54.4 20 64.4 11.4"/></g><g class="cut-scissors" transform="translate(-1 -8.4)"><path d="M21.4 5.2 Q16.6 9.6 11.4 13.6 Q9.8 15 8.6 16.2 Q7 15.6 5.6 16 Q3.8 16.8 3.8 18.4 Q3.8 20.4 5 21 Q6.6 21.6 7.8 21.2 Q9.2 20.4 9.2 18.8 Q9 17.4 8.2 16.6"/><path d="M21.8 19.6 Q16.4 14.8 11.6 10.6 Q10 9.2 8.8 8 Q7.2 8.6 5.8 8.4 Q4 7.8 3.6 6.2 Q3.6 4.2 4.6 3.4 Q6.2 2.6 7.6 3 Q9.2 3.8 9.2 5.4 Q9 6.8 8.4 7.8"/></g></svg></button>
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
  T = t
  t.get(/^\/scribble-board$/, ({ req, res }) => {
    const vm = t.vm()
    t.page(req, res, { title: 'Scribble Board · Trommi', view: 'whiteboard', bodyAttrs: ' data-page="whiteboard"', main: whiteboardMain(vm) })
  })
}

// ---- controller "thumbs" ----
// The teams' boards small (vm.thumbs: the core reads each team's board while such a page is in view): every
// canvas[data-thumb=<team id>] in it painted with its shapes (paintThumb), and [data-thumb-n] says how many there are.
// Painted again on every render of the core in which a board changed.
controller('thumbs', class extends Controller {
  connect() {
    this.paint = () => {
      const vm = (T?.vm ?? globalThis.window?.trommi?.vm)?.()
      const list = new Map((vm?.thumbs ?? []).map(x => [x.team_id, x]))
      for (const cv of this.element.querySelectorAll('canvas[data-thumb]')) {
        const th = list.get(cv.dataset.thumb)
        if (!th) continue
        const key = `${th.state}:${th.count}:${th.shapes?.at(-1)?.id ?? ''}:${document.documentElement.dataset.theme ?? ''}`
        if (cv.dataset.painted !== key) { paintThumb(cv, th.shapes ?? []); cv.dataset.painted = key }
        for (const n of this.element.querySelectorAll(`[data-thumb-n="${CSS.escape(th.team_id)}"]`)) n.textContent = th.state === 'loading' ? '' : th.count ? String(th.count) : 'empty'
      }
    }
    // (not at once: this controller can connect while this module is still being read, before what painting needs
    //  further down is defined, e.g. isStroke: a ReferenceError)
    queueMicrotask(() => { if (this.element.isConnected) this.paint() })
    import('./app.mjs').then(app => { if (this.element.isConnected) this.off = app.onCore('render', () => requestAnimationFrame(() => this.paint())) }).catch(() => {})
  }
  disconnect() { this.off?.() }
})

// ---- controller "whiteboard" ----
// Mounts the pad (below) on its markup and draws the board in view again whenever #whiteboard-sessions is replaced
// (every render of the core: app.mjs puts the new one in); puts the pen in its hand (P: "trommi:pen").
controller('whiteboard', class extends Controller {
  static values = { canvas: String }
  connect() {
    if (!T) return
    this.pad = mountPad(this.element)
    this.sync = () => {
      const vm = T.vm()
      try { this.pad.setSessions(JSON.parse(document.getElementById('whiteboard-sessions')?.dataset.sessions ?? '[]')) } catch {}
      this.pad.sync(vm)
    }
    this.sync()
    this.watch = new MutationObserver(this.sync)
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
//   stroke  { tool: 'pen' | 'marker', color (a palette token), width, box: [w0, h0], pts: [x0, y0, …],
//             t, f, az, al, sim }   (time, force, azimuth, altitude per point)
//           pts are relative to the box as it was drawn (w0 x h0); the box may since
//           have been moved or scaled, the points never change
//   text    { text, size, color, wrap }       wrap: the width lines break at; null = the default
//           (TEXT_WRAP, scaled with the size). The box is as wide as the longest line.
//   voice   a text that was spoken: { text, size, color, wrap, ms, stub }
//   sticky  a note on yellow paper, held by a strip of tape (the corner note parked here): { text, size, color, wrap }
//           wrap is the paper's width; the box is the paper
//   image   { mime, nw, nh, name }

// Colours are palette tokens (PALETTE above): each is painted in its light or dark look.
const INK = 'ink'
const named = list => list.map(t => [t, t[0].toUpperCase() + t.slice(1)])
const PEN_SWATCHES = named(PEN_COLORS), MARKER_SWATCHES = named(MARKER_COLORS)
const SIZES = { pen: [2, 4, 7, 12], marker: [10, 18, 28, 42] }   // a stroke's width, board units
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

const resolveInk = (token, dark, tool = 'pen') => colorOf(token, tool, dark)

// ── strokes ──────────────────────────────────────────────────────────────────
// A stroke is drawn as PencilKit draws it (sampleStroke above): its points are the control points of a clamped
// uniform cubic B-spline, sampled about every unit. The pen's outline is the union of discs along that line, the disc
// at each sample as wide as the force there (thickness), joined by quads; all wound the same way, so one nonzero fill
// is the outline (round ends and joins, never a notch, and a see-through ink is laid once). The marker is one width:
// the line stroked with round ends, translucent. (The points are local to the element.)
const geomCache = new WeakMap()
const LAY = 64   // samples per piece of a pen's outline
/** Lay samples [x, y, r, …] (sampleStroke) into a path. begin: the path is empty (a piece that continues a
 *  stroke being drawn joins what is there). The pen's discs and quads go in as pieces of LAY samples (addPath):
 *  Chromium's Path2D takes longer for every new contour the more it holds, so one path built contour by contour
 *  cost the square of the stroke's length (4,000 samples: 157 ms; in pieces: 4 ms). */
function lay(path, out, marker, begin = true) {
  if (marker) {
    if (begin) { path.moveTo(out[0], out[1]); if (out.length === 3) path.lineTo(out[0] + 0.01, out[1]) }
    for (let i = begin ? 3 : 0; i < out.length; i += 3) path.lineTo(out[i], out[i + 1])
    return
  }
  for (let a = 0; a < out.length; a += 3 * LAY) {
    const piece = new Path2D()
    for (let i = a; i < out.length && i < a + 3 * LAY; i += 3) {
      const x = out[i], y = out[i + 1], r = out[i + 2]
      piece.moveTo(x + r, y)
      piece.arc(x, y, r, 0, Math.PI * 2, true)
      if (i + 3 < out.length) {
        const bx = out[i + 3], by = out[i + 4], br = out[i + 5]
        const dx = bx - x, dy = by - y, l = Math.hypot(dx, dy) || 1
        const nx = -dy / l, ny = dx / l
        piece.moveTo(x + nx * r, y + ny * r)
        piece.lineTo(bx + nx * br, by + ny * br)
        piece.lineTo(bx - nx * br, by - ny * br)
        piece.lineTo(x - nx * r, y - ny * r)
        piece.closePath()
      }
    }
    path.addPath(piece)
  }
}
function buildGeom(s) {
  const path = new Path2D(), marker = s.tool === 'marker'
  lay(path, sampleStroke(s.pts, s.f, { tool: s.tool, width: s.width }), marker)
  return { path, fill: !marker }
}
/** The outline of a stroke while it is drawn (g: the gesture; its points grow), in world units. Only what a new point
 *  changes is made again: with n points the spline's spans 0..n-2 are final and stay in g.wet.path, the last two
 *  spans (the clamped end under the pen) are laid fresh for each frame. A frame costs the same at the stroke's first
 *  point and at its thousandth. */
function wetGeom(g) {
  const w = g.wet ??= { path: new Path2D(), spans: 0 }
  const n = g.t.length, marker = g.tool === 'marker', opt = { tool: g.tool, width: g.width }
  if (n - 2 >= w.spans) {
    lay(w.path, sampleStroke(g.pts, g.f, { ...opt, from: w.spans, to: n - 2 }), marker, w.spans === 0)
    w.spans = n - 1
  }
  const path = new Path2D(w.path)
  lay(path, sampleStroke(g.pts, g.f, { ...opt, from: w.spans }), marker, w.spans === 0)
  return { path, fill: !marker }
}
function geom(data) {
  let g = geomCache.get(data)
  if (!g) geomCache.set(data, g = buildGeom(data))
  return g
}

/** Paint stroke data in its own coordinates (the caller has set the transform). */
function paintStroke(c, data, dark, g = geom(data)) {
  const color = resolveInk(data.color, dark, data.tool)
  if (data.tool === 'marker') {
    // Multiply reads as a marker on light paper; on dark paper it would vanish.
    c.globalAlpha = dark ? MARKER_OPACITY.dark : MARKER_OPACITY.light
    c.globalCompositeOperation = dark ? 'source-over' : 'multiply'
  }
  if (g.fill) { c.fillStyle = color; c.fill(g.path) }
  else {
    c.strokeStyle = color
    c.lineWidth = data.width
    c.lineCap = c.lineJoin = 'round'
    c.stroke(g.path)
  }
  c.globalAlpha = 1
  c.globalCompositeOperation = 'source-over'
}

/** Part of an ink from point i on (a piece of a stroke being drawn). */
const inkFrom = (k, i = 0) => ({ pts: k.pts.slice(2 * i), t: k.t.slice(i), f: k.f.slice(i), az: k.az ? k.az.slice(i) : null, al: k.al ? k.al.slice(i) : null, sim: Boolean(k.sim) })

/** Turn an ink drawn in world units (pts, t, f, az, al, sim) into the box and data of a stroke element. */
export function strokeFromWorld(ink, { tool, color, width }) {
  const pts = ink.pts
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (let i = 0; i < pts.length; i += 2) {
    x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i])
    y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1])
  }
  const pad = (width / 2) * (tool === 'marker' ? 1 : 1.6) + 1
  const x = r2(x0 - pad), y = r2(y0 - pad), w = r2(x1 - x0 + 2 * pad), h = r2(y1 - y0 + 2 * pad)
  const n = pts.length >> 1
  const data = { tool, color, width, box: [w, h], pts: pts.map((v, i) => v - (i % 2 ? y : x)), t: ink.t?.length === n ? ink.t : new Array(n).fill(0),
    f: ink.f?.length === n ? ink.f : new Array(n).fill(0.25), az: ink.az?.length === n ? ink.az : null, al: ink.al?.length === n ? ink.al : null, sim: Boolean(ink.sim) }
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
  const thr = r + (d.width * (d.tool === 'marker' ? 1 : 1.3) * Math.max(sx, sy)) / 2
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

/** A board small (its shapes, BoardShape[]): everything on it fitted into the canvas, on the paper of the theme.
 *  Pictures show as their place (a card is a hint of the board, not the board). */
export function paintThumb(cv, shapes) {
  const list = shapes.map(s => recordOf(s))
  const c = cv.getContext('2d'), css = getComputedStyle(document.documentElement), dark = document.documentElement.dataset.theme === 'dark'
  c.setTransform(1, 0, 0, 1, 0, 0)
  c.fillStyle = css.getPropertyValue('--surface').trim() || '#fff'
  c.fillRect(0, 0, cv.width, cv.height)
  const b = unionBox(list)
  if (!b) return
  const edge = 14, k = Math.min((cv.width - 2 * edge) / Math.max(1, b.w), (cv.height - 2 * edge) / Math.max(1, b.h), 2)
  c.setTransform(k, 0, 0, k, (cv.width - b.w * k) / 2 - b.x * k, (cv.height - b.h * k) / 2 - b.y * k)
  const env = { dark, accent: css.getPropertyValue('--accent').trim(), placeholder: css.getPropertyValue('--sunken').trim(), picture: () => ({ ok: false }) }
  for (const el of [...list].sort((p, q) => p.z - q.z || (p.id < q.id ? -1 : 1))) paintElement(c, el, env)
}

// ---- the board's link to the core ----
// The pad works on element records (above); the core holds the board. linkBoard turns the board in view (vm.board)
// into records and the pad's changes into actions:
//
//   const link = linkBoard({ onRemote })
//   link.sync(vm)                    a render: the records that changed or went go to onRemote
//   link.push(changes, how)          the pad changed: [{ id, before, after }] (after null: gone; how 'send_away' for a send)
//   link.live(g) / claim(g, id) / drop(g)   a stroke being drawn goes out in pieces every ~150 ms (StrokePiece); at its
//                                    end it is element id, whose shape names the pieces (`live`)
//   link.state()                     { mode, pending, error } for the pad's status line
//
// Ids: an element made here keeps the pad's id (stable for undo and selection); its shape is known by the BoardItem's
// local_id until the core shows it (BoardShape.local), then by its shape id. Others' shapes have their shape id as the
// pad id. A change that is not a plain move (resize, recolour, an edited note, z) erases the old shape and adds the new
// one; the pad's id then stands for the new shape.
const FLUSH_MS = 150
const ITEM_BYTES = 48_000   // a strokes item stays under the core's 60 KB body limit
const IDS = 400             // shape ids in one erase, send_away or move item
const hex16 = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('')
const chunks = (list, n = IDS) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out }
const isStroke = s => s.tool === 'pen' || s.tool === 'marker'

/** A shape of the view model -> a pad record (id: the pad's id for it). */
function recordOf(s, id = s.id) {
  const base = { id, rotation: 0, z: s.z ?? 0, group: s.group ?? null, author: s.by, rev: 1, blob: null, sent: [] }
  if (isStroke(s)) {
    const k = strokeFromWorld({ pts: s.pts, t: s.t, f: s.f, az: s.az ?? null, al: s.al ?? null, sim: s.sim }, { tool: s.tool, color: s.color ?? (s.tool === 'marker' ? 'yellow' : 'ink'), width: s.width ?? (s.tool === 'marker' ? 18 : 4) })
    return { ...base, type: 'stroke', x: k.x, y: k.y, w: k.w, h: k.h, data: k.data }
  }
  if (s.tool === 'image') return { ...base, type: 'image', x: s.pts[0], y: s.pts[1], w: r2(s.pts[2] - s.pts[0]), h: r2(s.pts[3] - s.pts[1]), blob: s.attachment ?? null, data: { mime: s.mime ?? '', nw: s.nw ?? 0, nh: s.nh ?? 0, name: s.name ?? '' } }
  const data = { text: s.text ?? '', size: s.size ?? TEXT_SIZE, color: s.color ?? 'ink', wrap: s.wrap ?? null }
  const lay = layoutText(data, s.tool)
  return { ...base, type: s.tool, x: s.pts[0], y: s.pts[1], w: lay.w, h: lay.h, data }
}
/** What tells a shape's drawing apart from the one before (a shape changes only by a move, or while it is drawn). */
const sigOf = s => `${s.pts.length},${s.pts[0]},${s.pts[1]},${s.pts.at(-1)},${s.z},${s.group ?? ''},${s.attachment ?? ''}`
/** A pad record -> a shape of a strokes item (the BoardItem's content form, board units). */
function entryOf(r) {
  const d = r.data ?? {}
  const e = { tool: r.type === 'stroke' ? d.tool : r.type }
  if (r.type === 'stroke') {
    const sx = r.w / d.box[0], sy = r.h / d.box[1], n = Math.min(MAX_POINTS, d.pts.length >> 1)
    const pts = d.pts.slice(0, 2 * n).map((v, i) => (i % 2 ? r.y + v * sy : r.x + v * sx))
    Object.assign(e, { color: d.color, width: r2(d.width * Math.sqrt(sx * sy)), points: packPoints({ pts, t: d.t?.slice(0, n), f: d.f?.slice(0, n), az: d.az?.slice(0, n), al: d.al?.slice(0, n), sim: d.sim }) })
  } else if (r.type === 'image') Object.assign(e, { rect: [r.x, r.y, r.x + r.w, r.y + r.h].map(r2), attachment: r.blob, nw: d.nw, nh: d.nh, mime: d.mime, name: d.name })
  else Object.assign(e, { at: [r2(r.x), r2(r.y)], text: d.text, size: d.size, color: d.color, ...(d.wrap != null ? { wrap: d.wrap } : {}) })
  if (r.z) e.z = r.z
  if (r.group) e.group = r.group
  return e
}
const plainMove = (a, b) => a.type === b.type && a.w === b.w && a.h === b.h && a.data === b.data && a.z === b.z && (a.group ?? null) === (b.group ?? null) && a.blob === b.blob

function linkBoard({ onRemote }) {
  let boardId = null, lastBoard, lastVm = null, flushTimer = 0
  const seen = new Map()      // shape id -> its sig, as drawn
  const padOf = new Map()     // shape id -> pad id, for those made here
  const wireOf = new Map()    // pad id -> shape id, for those made here
  const localOf = new Map()   // `<local_id>/<index>` -> pad id, until the core shows the shape
  const lives = new Map()     // gesture -> { g, stroke (32 hex), number: pieces sent, sent: points sent }
  const liveOf = new Map()    // pad id -> the stroke id its pieces went under while it was drawn
  let waiting = []            // ops on shapes the core has not shown yet
  const act = action => T?.act(action)

  /** A render of the core: what changed on the board goes to the pad. */
  function sync(vm) {
    lastVm = vm
    const b = vm.board
    if (b === lastBoard) return
    lastBoard = b
    if (!b) return
    const out = []
    if (b.board_id !== boardId) {
      for (const id of seen.keys()) out.push({ id: padOf.get(id) ?? id, deleted: true })
      seen.clear(); padOf.clear(); wireOf.clear(); localOf.clear(); waiting = []
      boardId = b.board_id
    }
    const now = new Set()
    for (const s of b.shapes ?? []) {
      now.add(s.id)
      const mine = s.local ? localOf.get(s.local) : null
      if (mine) { padOf.set(s.id, mine); wireOf.set(mine, s.id); localOf.delete(s.local) }
      const sig = sigOf(s)
      if (seen.get(s.id) === sig) continue
      seen.set(s.id, sig)
      out.push(recordOf(s, padOf.get(s.id) ?? s.id))
    }
    for (const id of [...seen.keys()]) {
      if (now.has(id)) continue
      seen.delete(id)
      const p = padOf.get(id) ?? id
      padOf.delete(id)
      // (a shape made again under the same pad id: the pad's element is the new one now)
      if (wireOf.get(p) === id) wireOf.delete(p)
      else if (p !== id || wireOf.has(p)) continue
      out.push({ id: p, deleted: true })
    }
    if (waiting.length) { const w = waiting; waiting = []; send(w) }
    if (out.length) onRemote(out)
  }

  /** The shape a pad id stands for now: made here and shown, or someone's. */
  const wireNow = id => wireOf.get(id) ?? (seen.has(id) && !padOf.has(id) && !String(id).startsWith('live:') ? id : null)
  /** The pad changed. One call is one undo step of the pad; it becomes adds, moves and erasures. */
  function push(changes, how = 'erase') {
    const ops = []
    for (const c of changes) {
      if (c.before && !c.after) { ops.push({ gone: how, pad: c.before.id, wire: wireNow(c.before.id) }); continue }
      if (c.before && plainMove(c.before, c.after)) {
        const dx = r2(c.after.x - c.before.x), dy = r2(c.after.y - c.before.y)
        if (dx || dy) ops.push({ move: [dx, dy], pad: c.before.id, wire: wireNow(c.before.id) })
        continue
      }
      if (c.before) { ops.push({ gone: 'erase', pad: c.before.id, wire: wireNow(c.before.id) }); wireOf.delete(c.before.id) }
      const live = c.before ? null : liveOf.get(c.after.id)
      liveOf.delete(c.after.id)
      ops.push({ add: { ...entryOf(c.after), ...(live ? { live } : {}) }, pad: c.after.id })
    }
    send(ops)
  }
  /** Ops to the core: new shapes first (in items under ITEM_BYTES), then moves by offset, then what is gone. An op on
   *  a shape the core has not shown yet waits for the render that shows it. */
  function send(ops) {
    if (!boardId) { waiting.push(...ops); return }
    const ready = []
    for (const op of ops) {
      if (op.add) { ready.push(op); continue }
      op.wire ??= wireNow(op.pad)
      if (op.wire) ready.push(op)
      else if (wireOf.has(op.pad) || [...localOf.values()].includes(op.pad)) waiting.push(op)
    }
    const adds = ready.filter(op => op.add)
    for (let at = 0; at < adds.length;) {
      let end = at, size = 0
      while (end < adds.length && (end === at || size + JSON.stringify(adds[end].add).length < ITEM_BYTES)) size += JSON.stringify(adds[end++].add).length
      const local_id = `pad-${hex16()}`
      adds.slice(at, end).forEach((op, i) => localOf.set(`${local_id}/${i}`, op.pad))
      act({ do: 'board_item', board_id: boardId, local_id, content: { content_type: 'strokes', strokes: adds.slice(at, end).map(op => op.add) } })
      at = end
    }
    const moves = new Map()
    for (const op of ready) if (op.move) { const k = op.move.join(','); moves.set(k, [...(moves.get(k) ?? []), op.wire]) }
    for (const [k, ids] of moves) for (const part of chunks(ids)) act({ do: 'board_item', board_id: boardId, local_id: `pad-${hex16()}`, content: { content_type: 'move', stroke_ids: part, offset: k.split(',').map(Number) } })
    for (const how of ['erase', 'send_away']) {
      const ids = ready.filter(op => op.gone === how).map(op => op.wire)
      for (const part of chunks(ids)) act({ do: 'board_item', board_id: boardId, local_id: `pad-${hex16()}`, content: { content_type: how, stroke_ids: part } })
    }
  }

  // ---- a stroke while it is drawn (g: the pad's gesture; its points grow): a piece every FLUSH_MS ----
  function pieces() {
    flushTimer = 0
    for (const l of lives.values()) {
      const ink = inkFrom(l.g, l.sent)
      if (!ink.t.length || !boardId) continue
      l.sent += ink.t.length
      act({ do: 'stroke_piece', board_id: boardId, piece: { stroke: l.stroke, number: ++l.number, tool: l.g.tool, color: l.g.color, width: l.g.width, points: packPoints(ink) } })
    }
  }
  function live(g) {
    if (!lives.has(g)) lives.set(g, { g, stroke: hex16(), number: 0, sent: 0 })
    flushTimer ||= setTimeout(pieces, FLUSH_MS)
  }
  /** The stroke ended and became element id: it goes out whole, as one shape that names its pieces. */
  function claim(g, id) {
    const l = lives.get(g)
    lives.delete(g)
    if (l?.number) liveOf.set(id, l.stroke)
  }
  /** A stroke that is not kept (a second finger came): its pieces fade at the others' (the core's LIVE_MS). */
  function drop(g) { lives.delete(g) }

  /** For the pad's status line. */
  function state() {
    const b = lastVm?.board, phase = lastVm?.phase
    const pending = waiting.length + lives.size + (b?.shapes ?? []).filter(s => s.local).length
    const error = b?.state === 'withheld' ? 'not all of it could be read here' : b?.state === 'newer_version' ? 'a part needs a newer Trommi' : null
    return { mode: !b || b.state === 'loading' ? 'starting' : phase === 'live' ? 'online' : 'offline', pending, error }
  }
  return { sync, push, live, claim, drop, state, close() { clearTimeout(flushTimer); if (lives.size) pieces() } }
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

// ---- the pad: mounted on the page /scribble-board by the controller "whiteboard" ----
// main: the page's <main> (pad markup inside). Returns { sync(vm), setSessions(list), unmount() }.
function mountPad(main) {
  const PAD = main.dataset.whiteboardCanvasValue
  const listening = new AbortController()
  // (Under the Desk's sheet the pad is mounted but not the page: what the window and the document hear is not its.)
  const here = () => document.body.dataset.tView === 'whiteboard'
  const on = (target, type, fn, opts = {}) => target.addEventListener(type, target === window || target === document ? e => { if (here()) fn(e) } : fn, { ...(typeof opts === 'boolean' ? { capture: opts } : opts), signal: listening.signal })
  const board = { board: true, sessions: [] }
  const AUTHOR = 'human'   // a record made here; on the wire the author is the signed sender
  const MIN_Z = 0.05, MAX_Z = 8
  const UNDO_MAX = 200
  const CLICK_PX = 5        // further than this and a press is a drag
  const ERASER_R = 11
  const MAX_IMG = 2000, KEEP_BYTES = 1_500_000

  const $ = id => document.getElementById(id)
  /** A control's disabled state; a control that left the page (the board was closed meanwhile) is passed over. */
  const disable = (id, off) => { const b = $(id); if (b) b.disabled = off }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
  const root = document.documentElement
  const pad = $('pad'), canvas = $('canvas'), editor = $('editor')
  const ctx = canvas.getContext('2d', { alpha: false })
  const layer = document.createElement('canvas')   // everything that is not changing right now
  const lctx = layer.getContext('2d', { alpha: false })

  // ── icons ───────────────────────────────────────────────────────────────────
  const ICONS = {
    more: ['M6 9l6 6 6-6'],
    select: ['M5 3.5l13.5 6.6-5.7 1.9-2 5.7z', 'M13.5 13.5l5 5'],
    pen: ['M4 20l1.2-4.4L16.6 4.2a2 2 0 012.9 0l.3.3a2 2 0 010 2.9L8.4 18.8z', 'M14.5 6.5l3 3'],
    marker: ['M14.5 4l5.5 5.5-8 8H7.5v-4.5z', 'M11.5 7l5.5 5.5', 'M4 21h10'],
    eraser: ['M20 20H9.5l-5-5a2 2 0 010-2.8l8-8a2 2 0 012.8 0l4.9 4.9a2 2 0 010 2.8L12 20', 'M8.7 8.3l7 7'],
    text: ['M5.5 7V5h13v2', 'M12 5v14', 'M9.5 19h5'],
    clip: ['M20 11.5l-8.2 8.2a5 5 0 01-7.1-7.1l8.6-8.6a3.3 3.3 0 014.7 4.7l-8.6 8.6a1.7 1.7 0 01-2.4-2.4l7.9-7.9'],   // attach
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
  const timeline = linkBoard({ onRemote: records => applyRemote(records) })   // the board in the core
  let els = new Map()            // id → record; tombstones are not in here
  const revs = new Map()         // id → highest revision seen, tombstones included
  let order = null               // records back to front, rebuilt when z changes
  const sel = new Set()
  const undo = [], redo = []     // each entry: [{ id, before, after }], a record or null on either side
  const view = { x: 0, y: 0, z: 1 }   // screen = world * z + (x, y)
  let W = 0, H = 0, dpr = 1
  let tool = 'pen', drawTool = 'pen'
  const style = { pen: { color: INK, w: 1 }, marker: { color: MARKER_COLORS[0], w: 1 } }
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
    timeline.push(changes, how)
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

  // Undo writes the earlier state again as a new revision: for the store and for
  // other devices an undo is just another change, never a rollback of history.
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
  /** A picture on the board, by its file id: drawn once the core handed its bytes over (t.fileUrl; the controller
   *  syncs again when they come). */
  function picture(id, src = null) {
    let p = pictures.get(id)
    if (!p) {
      const img = new Image()
      p = { img, ok: false, ready: null, load: null }
      p.ready = new Promise(resolve => {
        img.onload = () => { p.ok = true; dirty(); resolve() }
        img.onerror = () => resolve()
        p.load = () => { const url = src ?? T?.fileUrl(id); if (url && !img.src) img.src = url }
      })
      pictures.set(id, p)
    }
    p.load()
    return p
  }
  /** Files this pad waits for (an upload of its own): resolved with the attachment id once ready. */
  const uploads = new Map()   // local id -> { done, fail }
  const uploaded = localId => new Promise((done, fail) => {
    uploads.set(localId, { done, fail })
    sync(T.vm())
    // (a core that took no upload at all, e.g. the demo room: no entry comes)
    setTimeout(() => { if (uploads.has(localId) && !T.vm().files?.[localId]) { uploads.delete(localId); fail(new Error('The picture could not be uploaded here.')) } }, 5000)
  })
  /** A render of the core: the board, the pictures whose bytes came, the uploads this pad waits for. */
  function sync(vm) {
    for (const [id, w] of uploads) {
      const f = vm.files?.[id]
      if (f?.state === 'ready' && f.attachment_id) { uploads.delete(id); w.done(f.attachment_id) }
      else if (f && f.state !== 'uploading') { uploads.delete(id); w.fail(new Error('The picture could not be uploaded.')) }
    }
    for (const p of pictures.values()) if (!p.ok) p.load()
    timeline.sync(vm)
    renderStatus()
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
      paintStroke(ctx, gesture, dark(), wetGeom(gesture))
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
    disable('undo', !undo.length)
    disable('redo', !redo.length)
    disable('fit', !els.size)
    $('hint').dataset.show = String(!els.size && !edit && !gesture)
    for (const b of main.querySelectorAll('.pad-tool')) b.setAttribute('aria-pressed', String(b.dataset.tool === tool))
    pad.dataset.tool = tool
    const st = style[drawTool]
    // each drawing tool shows the colour it draws in
    for (const k of ['pen', 'marker']) toolButton(k).style.setProperty('--c', resolveInk(style[k].color, dark(), k))
    for (const b of $('swatches').children) b.setAttribute('aria-pressed', String(b.dataset.color === st.color))
    ;[...$('widths').children].forEach((b, i) => b.setAttribute('aria-pressed', String(i === st.w)))
    const list = selected()
    const grouped = list.length > 1 && list[0].group && list.every(e => e.group === list[0].group)
    disable('group', list.length < 2)
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
    const s = timeline.state()
    const where = s.error ? s.error
      : s.mode === 'online' ? (s.pending ? 'saving…' : 'saved, end-to-end encrypted')
      : s.mode === 'offline' ? 'no connection: kept on this device until it is back'
      : 'loading'
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
    $('swatches').replaceChildren(...(drawTool === 'marker' ? MARKER_SWATCHES : PEN_SWATCHES).map(([color, name]) => {
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
  const paintSwatches = () => { for (const b of $('swatches').children) b.style.setProperty('--c', resolveInk(b.dataset.color, dark(), drawTool)) }
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
    if (next === 'pen' || next === 'marker') {
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
  const closeStyle = () => { $('style').hidden = true; for (const k of ['pen', 'marker']) toolButton(k).setAttribute('aria-expanded', 'false') }
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
      if (list[k].type !== 'stroke' || list[k].data.tool !== 'marker') return list[k]
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
  async function addImages(files, at, top = false) {
    const list = [...files].filter(f => f.type.startsWith('image/'))
    if (!list.length) return note('That is not a picture.', 'error')
    note(list.length > 1 ? `Adding ${list.length} pictures…` : 'Adding the picture…', 'busy', 0)
    const added = []
    let failed = 0, z = topZ()
    for (const f of list) {
      try {
        const { blob, nw, nh } = await importImage(f)
        const id = await uploaded(await T.attach(new File([blob], f.name || 'picture', { type: blob.type })))
        await picture(id, URL.createObjectURL(blob)).ready
        const k = Math.min(1, (0.6 * W) / view.z / nw, (0.5 * Math.max(120, H - 150)) / view.z / nh)
        const w = r2(nw * k), h = r2(nh * k)
        const [cx, cy] = at ? toWorld(at[0], at[1]) : toWorld(W / 2, (H - 20) / 2)
        const off = (added.length * 28) / view.z
        added.push(make('image', { x: cx - w / 2 + off, y: cy - (top ? 0 : h / 2) + off, w, h }, { mime: blob.type, nw, nh, name: f.name || '' }, ++z, id))
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
  /** One sample of the pointer into the stroke being drawn, as PencilKit records it: where (board units), when (ms
   *  since the stroke began), how hard (a pen's pressure; mouse and finger: a force from their speed), and a
   *  pen's azimuth and altitude. Raw: the shape is smoothed when it is drawn (B-spline), never here. */
  function addPoint(g, e, last) {
    const [px, py] = local(e)
    const [wx, wy] = toWorld(px, py)
    const n = g.t.length
    const t = Math.max(n ? g.t[n - 1] : 0, Math.round(e.timeStamp - g.ts0))
    let d = 0
    if (n) {
      d = Math.hypot(wx - g.pts[2 * n - 2], wy - g.pts[2 * n - 1]) * view.z   // screen px
      if (d < (last ? 0.01 : 0.75)) return
    }
    const f = !g.sim ? (e.pressure > 0 ? e.pressure : n ? g.f[n - 1] : 0.25)
      : forceFromSpeed(n ? g.f[n - 1] : null, n ? d / Math.max(1, t - g.t[n - 1]) : 0)
    g.pts.push(wx, wy)
    g.t.push(t)
    g.f.push(Math.round(f * 1000) / 1000)
    if (g.az) {
      const a = Number.isFinite(e.azimuthAngle) && Number.isFinite(e.altitudeAngle) ? { az: e.azimuthAngle, al: e.altitudeAngle } : anglesOfTilt(e.tiltX, e.tiltY)
      g.az.push(a.az); g.al.push(a.al)
    }
  }
  function endDraw(g) {
    if (!g.t.length) return
    const s = strokeFromWorld(inkFrom(g), { tool: g.tool, color: g.color, width: g.width })
    const el = make('stroke', s, s.data, g.z)
    timeline.claim(g, el.id)   // its pieces went out while it was drawn: this is the rest of it
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
    if (g.type === 'draw' && g.moved && performance.now() - g.t0 > 350 && g.t.length > 12) endDraw(g)
    else if (g.type === 'draw') timeline.drop(g)
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
        const pen = e.pointerType === 'pen'   // pressure and tilt; mouse and finger have neither
        gesture = { ...base, type: 'draw', hit, tool, color: st.color, width: SIZES[tool][st.w], ts0: e.timeStamp, pts: [], t: [], f: [], az: pen ? [] : null, al: pen ? [] : null, sim: !pen, z: topZ() + 1 }
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
      if (g.moved) timeline.live(g)   // others see it while it is drawn: a piece every ~150 ms
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
    b.addEventListener('click', () => { if (tool === b.dataset.tool && (tool === 'pen' || tool === 'marker')) toggleStyle(); else if (tool === 'area' && b.dataset.tool === 'area') setTool(toolBefore); else setTool(b.dataset.tool) })   // (the scissors again: out of cutting)
  }
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
    // (a paste into a field outside the pad, the corner note's, is that field's: it took it already, or takes the words)
    if (e.target === editor || e.defaultPrevented || (e.target instanceof Element && !pad.contains(e.target) && e.target.closest('textarea, input, [contenteditable]')) || document.querySelector('dialog[open]')) return
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
    // (writing anywhere, the corner note too, is never a tool's key: ui.mjs isTyping; a letter on a phone without a
    // keyboard neither: letterKeysOn)
    if (e.key !== 'Escape' && (isTyping(e) || (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !letterKeysOn(e)))) return
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
    const tools = { v: 'select', p: 'pen', h: 'marker', e: 'eraser', t: 'text', a: 'area' }
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
    disable('send-go', false)
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
    disable('send-go', true)
    $('send-go').textContent = 'Sending…'
    try {
      await sendTo(session, payload)
      takeAway(payload.elements.map(e => e.id))
      $('send-dialog').close()
      note(`Sent to ${session.name}`)
    } catch (err) {
      out.textContent = `Not sent. ${sayError(err)}`
      out.hidden = false
      $('send-go').textContent = 'Try again'
      disable('send-go', false)
    }
  })

  /** The picture of the selection and its words go to the session: the picture attached (its name, selection.png,
   *  is how the conversation knows it for a scribble: the core's talk view), then a line to the session with it. */
  async function sendTo(session, payload) {
    const bytes = Uint8Array.from(atob(payload.png.slice(payload.png.indexOf(',') + 1)), c => c.charCodeAt(0))
    const id = await uploaded(await T.attach(new File([bytes], 'selection.png', { type: 'image/png' })))
    T.act({ do: 'write', session_id: session.id, text: payload.text || '', attachments: [id] })
  }

  // What was sent leaves the paper: it is the agent's now. One step, so one undo brings all of it back.
  // Without a frame (a selection was sent) exactly those elements go. With a frame, notes and pictures that
  // lie in it go whole, and a stroke that crosses its edge is cut there: the part outside stays, as a stroke
  // of its own.
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
      // a point of the stroke into a run, at (x, y), with time, force and angles of point i
      const put = (into, x, y, i) => { into.pts.push(x, y); into.t.push(d.t[i]); into.f.push(d.f[i]); if (into.az) { into.az.push(d.az[i]); into.al.push(d.al[i]) } }
      for (let i = 0; i < n; i++) {
        const x = X(i), y = Y(i), inside = within(x, y)
        if (!run || run.inside !== inside) {
          const prev = run
          run = { inside, pts: [], t: [], f: [], az: d.az ? [] : null, al: d.al ? [] : null, sim: d.sim }
          runs.push(run)
          if (prev) {
            const cut = inside ? edge(x, y, X(i - 1), Y(i - 1)) : edge(X(i - 1), Y(i - 1), x, y)
            put(prev, ...cut, i - 1)
            put(run, ...cut, i)
          }
        }
        put(run, x, y, i)
      }
      if (!runs.some(run => run.inside)) continue   // only its box reached into the frame: it stays
      changes.push({ id, before: el, after: null })
      for (const run of runs) {
        if (run.inside) continue
        const part = strokeFromWorld(run, { tool: d.tool, color: d.color, width: r2(d.width * sx) })
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
    // (the heading and the field stand still; only the list of sessions scrolls)
    const list = Object.assign(document.createElement('div'), { className: 'pad-menu-list' })
    list.append(...items)
    menu.replaceChildren(...nodes, list)
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
    // One rule: beside the frame that was just drawn, its top on the frame's top: at the right; at the left when
    // there is no room there; inside the frame's right edge when neither side has room. Always inside the paper,
    // above the tools at the foot.
    const gap = 12, foot = 96
    let tx = x + w + gap
    if (tx + mw > W - 8) tx = x - mw - gap
    if (tx < 8) tx = clamp(x + w - mw - gap, 8, Math.max(8, W - mw - 8))
    const ty = clamp(y, 8, Math.max(8, H - foot - mh))
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
      note(`Not sent. ${sayError(err)}`, 'error', 6000)
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
      if (saved.style?.pen && saved.style?.marker) Object.assign(style, saved.style)
      if (saved.tool === 'marker') drawTool = 'marker'
    } else { setView(W / 2, H / 2, 1); firstLook = !els.size }
    $('zoom').textContent = `${Math.round(view.z * 100)} %`
    buildSwatches()
    refresh()
    paintSendTo()
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
    const box = pad.getBoundingClientRect(), { text, x, y, pictures = [] } = e.detail ?? {}
    const words = String(text ?? '').trim()
    if ((!words && !pictures.length) || x < box.left || x > box.right || y < box.top || y > box.bottom) return
    commitEditor()
    const px = x - box.left, py = y - box.top
    let under = py
    if (words) {
      addSticky(words, ...toWorld(px, py))
      const made = ordered().at(-1)
      under = py + (made.h / 2) * view.z + 24
    }
    e.detail.taken = true
    // The note's pictures, laid under the sticky one after the other; placed: the urls of those that are on the board
    // now (the corner's note keeps a picture that could not be read).
    e.detail.placed = (async () => {
      const done = []
      for (const p of pictures) {
        try {
          // (the note's file is in the room already: the board names it, nothing is uploaded again)
          const id = p.id ?? /([0-9a-f]{32})/.exec(String(p.url ?? ''))?.[1]
          const pic = id && picture(id)
          if (!pic) continue
          await Promise.race([pic.ready, new Promise(r => setTimeout(r, 8000))])
          if (!pic.ok) continue
          const nw = pic.img.naturalWidth || 800, nh = pic.img.naturalHeight || 600
          const k = Math.min(1, (0.6 * W) / view.z / nw, (0.5 * Math.max(120, H - 150)) / view.z / nh)
          const w = r2(nw * k), h = r2(nh * k), [cx, cy] = toWorld(px, under)
          const el = make('image', { x: cx - w / 2, y: cy, w, h }, { mime: '', nw, nh, name: p.name || '' }, topZ() + 1, id)
          add([el])
          sel.clear(); sel.add(el.id)
          done.push(p.url ?? p.id); under += h * view.z + 16
        } catch (err) { console.warn('park picture', err) }
      }
      sel.clear(); refresh()
      return done
    })()
  })

  // For scripts that drive the page (dev/e2e.mjs) and for the curious in the console.
  window.pad = {
    elements: () => ordered(),
    selection: () => [...sel],
    view: () => ({ ...view }),
    state: () => ({ tool, editing: Boolean(edit), undo: undo.length, redo: redo.length, board, sync: timeline.state() }),
    area: () => (area ? { x: area.x, y: area.y, w: area.w, h: area.h, ids: area.list.map(e => e.id), sending: Boolean(area.sending) } : null),
    payload: async session => (await buildPayload(session ?? board.sessions[0], selected())).payload,
    tool: name => setTool(name),
    rest: () => { commitEditor(); closePopovers(); sel.clear(); setTool('select') },
    world: (px, py) => toWorld(px, py),
  }

  start()
  return {
    sync,
    setSessions(list) { board.sessions = list; renderStatus(); paintSendTo() },
    unmount() {
      commitEditor()
      listening.abort(); resized.disconnect(); themed.disconnect()
      cancelAnimationFrame(raf)
      timeline.close()
      delete window.pad
    },
  }
}
