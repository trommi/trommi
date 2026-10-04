// The Whiteboard: a place of its own in the sidebar, under the Desk's header (Christopher's pick "place", 4 Oct 2026:
// "wenn überall Whiteboard ist, ist nirgends Whiteboard"). The Desk is cards on plain paper; the drawing lives here.
//
//   whiteboardRow(base)   the row at the top of the sidebar (on a phone the first chip of the sessions' line)
//   register(t)           the page /whiteboard: the pad (public/pad/, embedded, ?place) as large as the main area
//
// What is on it is the desk's canvas timeline, desk/<32 hex> (deskCanvas). The Desk's paper wrote to desk/<desk_id>
// with the desk's own id ('main', or 8 hex for a desk made in the menu); the core refuses such an id (a canvas
// timeline is desk/ and 32 hex, core/zcrypto.mjs parseTimelineId, since protocol v1.1), so none of the paper's strokes
// ever reached the hub or a second device: there is nothing to carry over, and the Whiteboard is where drawing is kept
// from now on. The pad's page talks to this page as it talked to the Desk (postMessage, controller
// "whiteboard"): the sessions for "Send to…", the theme. Select-and-send is the pad's own, unchanged.

import { Controller, controller, html, markArt, raw, sketchSvg } from './ui.mjs'

const WHITEBOARD_WORD = 'Whiteboard'
/** The canvas timeline of a desk: desk/ and 32 hex. A desk id that is not 32 hex already ('main', a menu desk's 8 hex)
 *  is folded into 16 bytes (its UTF-8, XOR by position, the length last): the same desk is the same timeline on every
 *  device, two desks never share one. */
function deskCanvas(desk) {
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
  const sessions = model.agents.map(a => ({ id: a.id, name: a.name, online: Boolean(a.online), hue: a.hue, mark: String(markArt({ ...a, starred: false })) }))
  return html`<div id="whiteboard-sessions" hidden data-sessions="${JSON.stringify(sessions)}"></div>`
}

const whiteboardMain = model => html`<main id="whiteboard" aria-label="${WHITEBOARD_WORD}" data-controller="whiteboard">
${whiteboardSessions(model)}
<iframe class="whiteboard-frame" id="whiteboard-frame" title="${WHITEBOARD_WORD}" allow="clipboard-read; clipboard-write" src="/pad/?embed=1&amp;place=1&amp;canvas=${encodeURIComponent(canvasOf(model))}" data-whiteboard-target="frame"></iframe>
</main>`

export function register(t) {
  // The Scratchpad's old address.
  t.get(/^\/pad$/, ({ res }) => { t.redirect(res, '/whiteboard') })
  t.get(/^\/whiteboard$/, ({ req, res }) => {
    const m = t.model()
    t.page(req, res, { model: m, title: `${WHITEBOARD_WORD} · Trommi`, view: 'whiteboard', bodyAttrs: ' data-page="whiteboard"', main: whiteboardMain(m) })
  })
  t.live('whiteboard', {
    take: m => ({ sessions: String(whiteboardSessions(m)), canvas: canvasOf(m) }),
    diff: (was, now) => (was.canvas !== now.canvas ? '' : was.sessions !== now.sessions ? t.stream('replace', 'whiteboard-sessions', raw(now.sessions)) : ''),
  })
}

// ---- controller "whiteboard" ----
// The Whiteboard's page (js/views/whiteboard.mjs): the pad's own page in a frame as large as the main area. This tells
// the pad what it needs from the board (the sessions for "Send to…", the theme) and follows the pad's theme switch.
// The messages are the ones the Desk's paper used (pad/pad.js hostSays, tell).


controller('whiteboard', class extends Controller {
  static targets = ['frame']

  connect() {
    this.ready = false
    this.said = ''
    this.onMessage = e => {
      const frame = this.hasFrameTarget ? this.frameTarget : null
      if (e.origin !== location.origin || !frame || e.source !== frame.contentWindow || e.data?.trommi !== 'pad') return
      const msg = e.data
      if (msg.type === 'ready') { this.ready = true; this.tell(true); this.pen() }
      else if (msg.type === 'theme' && (document.documentElement.dataset.theme === 'dark') !== (msg.theme === 'dark')) document.getElementById('theme-toggle')?.click()
      else if (msg.type === 'close') { frame.blur(); window.focus() }   // Escape with nothing to let go of: the board's keys again
    }
    window.addEventListener('message', this.onMessage)
    this.onPen = () => this.pen()
    document.addEventListener('trommi:pen', this.onPen)
    // The sessions changed (the live stream replaced #whiteboard-sessions), or the theme: the pad hears it.
    this.watch = new MutationObserver(() => this.tell())
    this.watch.observe(this.element, { childList: true })
    this.theme = new MutationObserver(() => this.tell())
    this.theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  }

  disconnect() {
    window.removeEventListener('message', this.onMessage)
    document.removeEventListener('trommi:pen', this.onPen)
    this.watch?.disconnect()
    this.theme?.disconnect()
  }

  /** The pen in hand and the keyboard in the pad (P, and on arriving). */
  pen() {
    const win = this.ready && this.hasFrameTarget ? this.frameTarget.contentWindow : null
    if (!win?.pad) return
    win.pad.tool('pen')
    this.frameTarget.focus()
  }

  tell(force = false) {
    const win = this.ready && this.hasFrameTarget ? this.frameTarget.contentWindow : null
    if (!win) return
    const raw = document.getElementById('whiteboard-sessions')?.dataset.sessions ?? '[]'
    const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
    const key = `${theme}|${raw}`
    if (!force && key === this.said) return
    this.said = key
    let sessions = []
    try { sessions = JSON.parse(raw) } catch {}
    win.postMessage({ trommi: 'pad', type: 'context', open: true, prefer: [], theme, sessions }, location.origin)
  }
})
