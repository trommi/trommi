// The memos of a page: <div id="memo-layer" data-controller="memos"> around the round yellow button, the list of
// the notes that were put away, and the notes that are out (server/views/memo.mjs memoLayer()). The button makes a
// note, or shows the list when notes wait there. What concerns all notes of the page is here too: streams that
// change a note in place, a phone's tap beside the sheet, keeping what was
// typed when the page is left. The work is /t/lib/memo.js. The key "/" may click #memo-open.
import { Controller } from '/js/app/stimulus.mjs'
import { write, putAway, showAway, waits, onStream, standAll, beside, flushAll, sheet } from '/t/lib/memo.js'

export default class extends Controller {
  connect() {
    const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); this.undo.push(() => target.removeEventListener(type, fn, opts)) }
    this.undo = []
    on(document, 'turbo:before-stream-render', onStream)
    on(document, 'turbo:before-visit', () => flushAll())
    on(document, 'turbo:before-cache', () => flushAll())
    on(window, 'pagehide', () => flushAll())
    on(window, 'resize', standAll)
    on(sheet, 'change', standAll)
    on(document, 'pointerdown', e => { beside(e); if (this.listOpen && !(e.target instanceof Element && e.target.closest('#memo-new'))) showAway(false) })
    // Escape closes the list, or puts the note away the keyboard is in (heard at the window, before any table of keys).
    on(window, 'keydown', e => {
      if (e.key !== 'Escape') return
      const note = e.target instanceof Element ? e.target.closest('.memo') : null
      if (!this.listOpen && !note) return
      e.preventDefault(); e.stopPropagation()
      if (this.listOpen) { showAway(false); document.getElementById('memo-open')?.focus({ preventScroll: true }) }
      else putAway(note)   // Escape in a note puts it away; what was written stays on it
    }, true)
    standAll()
  }
  disconnect() { for (const undo of this.undo) undo() }

  get listOpen() { const list = document.getElementById('memo-away'); return Boolean(list && !list.hidden) }
  /** The round button: with notes put away it shows them (and "New memo"); with none it makes a note at once. */
  open(e) {
    e.preventDefault()
    if (!waits().length) return write()
    showAway(!this.listOpen)
  }
  write(e) { e.preventDefault(); showAway(false); write() }
  shut() { showAway(false) }
}
