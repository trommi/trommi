// A crowned main's folded stack in the sidebar (views/sidebar.mjs, css/crowns.css): when the pointer thumbs it, its
// card edges fan out towards the side the mouse is on. Over the middle they go straight down, at the right they lean
// right, at the left they lean left. Sets --lean (-1 … 1) and --lean-abs (0 … 1) on the row; the CSS turns them into
// the fan. A mouse or pen only (a touch has no hover), and nothing under prefers-reduced-motion.
import { Controller } from '/js/app/stimulus.mjs'

export default class extends Controller {
  disconnect() { this.rest() }
  follow(event) {
    if (event.pointerType === 'touch' || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    this.x = event.clientX
    if (!this.frame) this.frame = requestAnimationFrame(() => this.set())
  }
  set() {
    this.frame = 0
    const box = this.element.getBoundingClientRect()
    if (!box.width) return
    const lean = Math.max(-1, Math.min(1, ((this.x - box.left) / box.width) * 2 - 1))
    this.element.style.setProperty('--lean', lean.toFixed(2))
    this.element.style.setProperty('--lean-abs', Math.abs(lean).toFixed(2))
  }
  rest() {
    cancelAnimationFrame(this.frame); this.frame = 0
    this.element.style.removeProperty('--lean')
    this.element.style.removeProperty('--lean-abs')
  }
}
