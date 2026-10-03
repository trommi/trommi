// The rail (card Nr. 150): the sidebar folded to the sessions' drawings with their marks (crown, bracket, the drawing
// that fills itself in while a session works, the count). Wide screens only (css/app.css, [data-rail="folded"]).
// The small "|<" at the sidebar's foot folds and opens it, and so does the key [ (t/lib/keys.js presses this button).
// Remembered per browser: the layout's head sets data-rail on <html> before first paint; this controller only flips it.
// The rail shows no names, so a row says its name in a note beside it while the pointer or the keyboard is on it.
import { Controller } from '@hotwired/stimulus'

const KEY = 'trommi-rail'
const wide = () => matchMedia('(min-width: 861px)').matches
const folded = () => document.documentElement.dataset.rail === 'folded'

export default class extends Controller {
  connect() { this.paint() }
  disconnect() { this.untip() }

  toggle() {
    if (!wide()) return
    const fold = !folded()
    if (fold) document.documentElement.dataset.rail = 'folded'; else delete document.documentElement.dataset.rail
    try { fold ? localStorage.setItem(KEY, 'folded') : localStorage.removeItem(KEY) } catch {}
    this.untip()
    this.paint()
    dispatchEvent(new Event('resize'))   // the brackets of unfolded mains are drawn again for the new width
  }

  paint() {
    const label = `${folded() ? 'Open the sidebar' : 'Fold the sidebar to a rail'} ( [ )`
    this.element.title = label
    this.element.setAttribute('aria-label', label)
    this.element.setAttribute('aria-pressed', String(folded()))
  }

  tip(event) {
    const row = event.target.closest?.('#agents .agent-row')
    if (row === this.row) return
    this.untip()
    if (!row || !folded() || !wide()) return
    const name = row.querySelector('.agent-text strong')?.textContent.trim()
    if (!name) return
    const r = row.getBoundingClientRect()
    const note = document.createElement('div')
    note.className = 'rail-tip'
    note.setAttribute('aria-hidden', 'true')
    note.textContent = name
    note.style.left = `${Math.round(r.right + 10)}px`
    note.style.top = `${Math.round(r.top + r.height / 2 - 13)}px`
    document.body.append(note)
    this.row = row
    this.note = note
    // The sidebar scrolls under a still pointer: the note would stand beside the wrong row.
    this.off = () => this.untip()
    document.getElementById('agents')?.addEventListener('scroll', this.off, { once: true, passive: true })
  }

  untip() {
    this.note?.remove()
    if (this.off) document.getElementById('agents')?.removeEventListener('scroll', this.off)
    this.note = this.row = this.off = null
  }
}
