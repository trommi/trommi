// A published page (views/session.mjs): its first screen on the card, or the whole page in the viewer (full).
// The page is fetched from /att/<id> (decrypted in this browser, js/app/att.mjs) once it comes near the screen and
// shown in the sandboxed frame /a/frame.html (no origin, no network, its own CSP; it gets the page as one message).
// Until then, and when anything fails, the drawn kind stays.
import { Controller } from '/js/app/stimulus.mjs'

const WIDTH = 1280            // a page is laid out this wide and scaled down to the card
const pages = new Map()       // src -> Promise<string>: a card the stream brings anew does not fetch again

const pageOf = src => {
  if (!pages.has(src)) {
    const job = fetch(src).then(res => { if (!res.ok) throw new Error(String(res.status)); return res.text() })
    job.catch(() => pages.delete(src))
    pages.set(src, job)
  }
  return pages.get(src)
}

export default class extends Controller {
  static values = { src: String, full: Boolean }

  connect() {
    if (!this.srcValue) return
    if (this.fullValue || !('IntersectionObserver' in window)) return this.show()
    this.seen = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) { this.seen.disconnect(); this.show() } }, { rootMargin: '400px' })
    this.seen.observe(this.element)
  }
  disconnect() {
    this.seen?.disconnect()
    this.fit?.disconnect()
    if (this.listen) removeEventListener('message', this.listen)
  }

  async show() {
    let html
    try { html = await pageOf(this.srcValue) } catch { if (this.fullValue) this.element.querySelector('.as-wait')?.replaceWith(Object.assign(document.createElement('p'), { className: 'as-problem', textContent: 'The page could not be opened here.' })); return }
    if (!this.element.isConnected) return
    const frame = document.createElement('iframe')
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.referrerPolicy = 'no-referrer'
    frame.title = this.fullValue ? 'Published page' : ''
    if (!this.fullValue) { frame.tabIndex = -1; frame.setAttribute('aria-hidden', 'true') }
    this.listen = e => {
      if (e.source !== frame.contentWindow || e.data !== 'ready') return
      removeEventListener('message', this.listen)
      this.listen = null
      // The frame's origin is opaque, so there is no origin to name; the source check above is the address.
      frame.contentWindow.postMessage({ html }, '*')
      this.element.classList.add('is-shown')
      this.element.querySelector('.as-wait')?.remove()
    }
    addEventListener('message', this.listen)
    if (!this.fullValue) {
      const scale = () => { frame.style.transform = `scale(${this.element.clientWidth / WIDTH})` }
      this.fit = new ResizeObserver(scale)
      this.fit.observe(this.element)
      scale()
    }
    frame.src = '/a/frame.html'
    this.element.prepend(frame)
  }
}
