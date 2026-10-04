// The Whiteboard's page (js/views/whiteboard.mjs): the pad's own page in a frame as large as the main area. This tells
// the pad what it needs from the board (the sessions for "Send to…", the theme) and follows the pad's theme switch.
// The messages are the ones the Desk's paper used (pad/pad.js hostSays, tell).
import { Controller } from '/js/app/stimulus.mjs'

const root = document.documentElement

export default class extends Controller {
  static targets = ['frame']

  connect() {
    this.ready = false
    this.said = ''
    this.onMessage = e => {
      const frame = this.hasFrameTarget ? this.frameTarget : null
      if (e.origin !== location.origin || !frame || e.source !== frame.contentWindow || e.data?.trommi !== 'pad') return
      const msg = e.data
      if (msg.type === 'ready') { this.ready = true; this.tell(true); this.pen() }
      else if (msg.type === 'theme' && (root.dataset.theme === 'dark') !== (msg.theme === 'dark')) document.getElementById('theme-toggle')?.click()
      else if (msg.type === 'close') { frame.blur(); window.focus() }   // Escape with nothing to let go of: the board's keys again
    }
    window.addEventListener('message', this.onMessage)
    this.onPen = () => this.pen()
    document.addEventListener('trommi:pen', this.onPen)
    // The sessions changed (the live stream replaced #whiteboard-sessions), or the theme: the pad hears it.
    this.watch = new MutationObserver(() => this.tell())
    this.watch.observe(this.element, { childList: true })
    this.theme = new MutationObserver(() => this.tell())
    this.theme.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
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
    const theme = root.dataset.theme === 'dark' ? 'dark' : 'light'
    const key = `${theme}|${raw}`
    if (!force && key === this.said) return
    this.said = key
    let sessions = []
    try { sessions = JSON.parse(raw) } catch {}
    win.postMessage({ trommi: 'pad', type: 'context', open: true, prefer: [], theme, sessions }, location.origin)
  }
}
