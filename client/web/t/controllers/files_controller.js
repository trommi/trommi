// A session's files drawer (server/views/session.mjs filesDrawer): "N files" beside the quiet line (on a phone,
// "Files (N)" in the filter menu) opens it, the chip again, Escape, a click beside it or its × close it. The list is
// a frame: the link that opens it loads it once (data-turbo-frame); later it is kept current by the live stream.
// "Jump to" scrolls to the message and marks it for a moment when it is on the page; otherwise its link loads the
// window of the conversation that ends with it.
import { Controller } from '@hotwired/stimulus'

const PHONE = '(max-width: 860px)'

export default class extends Controller {
  static targets = ['drawer', 'frame']

  get isOpen() { return this.hasDrawerTarget && !this.drawerTarget.hidden }

  toggle(event) {
    if (this.isOpen) { event.preventDefault(); this.close() } else this.open(event)
  }
  open(event) {
    if (!this.hasDrawerTarget) return
    event?.target.closest('details')?.removeAttribute('open')
    // Loaded before: only shown. Otherwise the link goes on and Turbo loads the list into the frame.
    if (this.frameTarget.childElementCount) event?.preventDefault()
    this.drawerTarget.hidden = false
    this.element.setAttribute('data-files-open', '')
  }
  close(event) {
    event?.preventDefault()
    if (!this.hasDrawerTarget) return
    this.drawerTarget.hidden = true
    this.element.removeAttribute('data-files-open')
    // Opened as its own address (/s/<id>/files): the address becomes the conversation's again.
    if (/\/files$/.test(location.pathname)) history.replaceState(history.state, '', location.pathname.replace(/\/files$/, '') + location.search)
  }
  key(event) {
    if (event.key === 'Escape' && this.isOpen && !event.defaultPrevented) { event.preventDefault(); this.close() }
  }
  outside(event) {
    if (!this.isOpen || !event.target.isConnected) return
    if (this.drawerTarget.contains(event.target) || event.target.closest('.files-chip, .session-filter-files, .session-filter')) return
    this.close()
  }
  jump(event) {
    const at = document.getElementById(`msg-${event.params.msg}`)
    if (!at) return   // not on the page: the link loads the window that holds it
    event.preventDefault()
    if (matchMedia(PHONE).matches) this.close()
    at.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    at.classList.remove('is-jumped')
    void at.offsetWidth
    at.classList.add('is-jumped')
    clearTimeout(this.unmark)
    this.unmark = setTimeout(() => at.classList.remove('is-jumped'), 1800)
  }
  disconnect() { clearTimeout(this.unmark) }
}
