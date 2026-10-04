// The regions an agent marked on a picture (marks: [{ x, y, w, h, label? }] in fractions of the picture): each is
// circled with the pen over the picture as it is shown, its label beside it. The element holds the <img>.
import { Controller } from '/js/app/stimulus.mjs'

const NS = 'http://www.w3.org/2000/svg'
export default class extends Controller {
  static values = { marks: Array }
  connect() {
    this.img = this.element.querySelector('img')
    if (!this.img) return
    this.layer = document.createElementNS(NS, 'svg')
    this.layer.setAttribute('class', 'focus-circles')
    this.layer.setAttribute('aria-hidden', 'true')
    if (getComputedStyle(this.element).position === 'static') this.element.style.position = 'relative'
    this.element.append(this.layer)
    this.draw = this.draw.bind(this)
    this.sizes = new ResizeObserver(this.draw)
    this.sizes.observe(this.img)
    this.img.addEventListener('load', this.draw)
    this.draw()
  }
  disconnect() { this.sizes?.disconnect(); this.img?.removeEventListener('load', this.draw); this.layer?.remove() }
  // (The card puts another picture on the stage with its marks: drawn anew.)
  marksValueChanged() { if (this.layer) this.draw() }
  draw() {
    const img = this.img, w = img.offsetWidth, h = img.offsetHeight
    if (!w || !h) return this.layer.replaceChildren()
    Object.assign(this.layer.style, { left: `${img.offsetLeft}px`, top: `${img.offsetTop}px`, width: `${w}px`, height: `${h}px` })
    const nodes = []
    this.marksValue.forEach((m, n) => {
      const cx = (m.x + m.w / 2) * w, cy = (m.y + m.h / 2) * h
      const rx = Math.max(12, m.w * w / 2 * 1.16 + 5), ry = Math.max(12, m.h * h / 2 * 1.16 + 5)
      // one stroke of the pen, a little more than once round, never quite closing where it began
      let d = ''
      const turns = 34, seed = n * 7 + 3
      for (let i = 0; i <= turns; i++) {
        const t = -2.4 + (i / turns) * (Math.PI * 2 + .5)
        const wob = 1 + Math.sin(i * 1.7 + seed) * .035 + (i / turns - .5) * .05
        d += `${i ? 'L' : 'M'}${(cx + Math.cos(t) * rx * wob).toFixed(1)} ${(cy + Math.sin(t) * ry * wob).toFixed(1)}`
      }
      const path = document.createElementNS(NS, 'path')
      path.setAttribute('d', d)
      nodes.push(path)
      if (m.label) {
        const text = document.createElementNS(NS, 'text')
        text.setAttribute('x', Math.min(Math.max(cx - rx, 4), Math.max(4, w - 8 * String(m.label).length)).toFixed(1))
        text.setAttribute('y', (cy - ry < 22 ? cy + ry + 17 : cy - ry - 7).toFixed(1))
        text.textContent = m.label
        nodes.push(text)
      }
    })
    this.layer.replaceChildren(...nodes)
    this.dispatch('drawn')   // (the card draws its arrow from the first circle)
  }
}
