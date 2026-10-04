// DOM helpers the controllers import: el (a node, never an HTML string, so text from an agent cannot inject markup),
// sketch (a pen icon as a node) and adviceLoop (the highlighter behind the advised option). The drawings are pen.js's.
import { seeded, penPath, SKETCH, SNOOZE_Z } from './pen.js'

export const el = (tag, cls, text) => {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text != null) node.textContent = text
  return node
}

/** An icon drawn like the session marks: a few uneven pen strokes with a little tilt. Sized and coloured by CSS. */
export function sketch(name) {
  const r = seeded(`sketch:${name}`)
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('class', 'sketch')
  svg.setAttribute('aria-hidden', 'true')
  if (name === 'snooze') {   // the three heavy z: each path carries its own width, which wins over the width CSS gives the icon
    for (const [d, width] of SNOOZE_Z) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', d)
      path.setAttribute('stroke-width', width)
      svg.append(path)
    }
    return svg
  }
  svg.style.rotate = `${((r() - .5) * 9).toFixed(1)}deg`
  for (const stroke of SKETCH[name] ?? []) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', penPath(stroke.map(([x, y]) => [x + (r() - .5) * .7, y + (r() - .5) * .7])))
    svg.append(path)
  }
  return svg
}

/** The mark of the agent's advice: a swipe of a highlighter behind the words of the option it would
 *  pick. One pass of the marker per line of the label, a little uneven, its ends slanted; it lies
 *  behind the words and never on them. This is the one place that draws it; whoever shows advice
 *  appends what this returns to the option (or to its label), and the mark finds the words by itself:
 *  the option's label (.focus-opt-label, or the option's own strong / span), else all the text of
 *  what it was put into. It measures the lines once it stands in the page and again whenever its
 *  host changes size. An option without words (a bare thumb) gets a short swipe where its word would
 *  be. Ink and strength are CSS: --advice and --marker (tokens.css); the host needs position: relative
 *  (.is-advised has it). (It was a loop round the option once: hence the name.) */
export function adviceLoop() {
  const NS = 'http://www.w3.org/2000/svg'
  const r = seeded('advice marker')
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('class', 'advice-loop advice-marker')
  svg.setAttribute('aria-hidden', 'true')
  const wobble = Array.from({ length: 24 }, () => (r() - .5) * 2.4)   // the same hand on every redraw
  // Measured and drawn in two phases for all marks of the page at once (one layout, not one per mark: a Desk of
  // hundreds of advised options would otherwise thrash layout).
  const measure = () => {
    const host = svg.parentElement
    if (!host) return null
    const label = host.querySelector('.focus-opt-label') ?? host.querySelector(':scope > strong, :scope > span:not(.inbox-disc)') ?? host
    // The words only: every piece of text in the label, line box by line box (a drawing in it has no line).
    const rects = []
    const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT)
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (!text.nodeValue.trim() || text.parentElement.closest('svg, kbd, .focus-sr')) continue
      const range = document.createRange()
      range.selectNodeContents(text)
      rects.push(...range.getClientRects())
    }
    const frame = svg.getBoundingClientRect()
    // in the svg's own pixels, whatever its host is scaled or turned by
    const k = (svg.clientWidth || frame.width) / (frame.width || 1) || 1
    const lines = []
    for (const b of rects) {
      if (!b.width || !b.height) continue
      const box = { x: (b.left - frame.left) * k, y: (b.top - frame.top) * k, w: b.width * k, h: b.height * k }
      const last = lines.at(-1)
      if (last && Math.abs(last.y - box.y) < 4) last.w = Math.max(last.w, box.x + box.w - last.x)
      else lines.push(box)
    }
    // No words to lie behind: a short swipe in the lower part of the tile, where its word would be.
    if (!lines.length) lines.push({ x: frame.width * k * .26, y: frame.height * k * .68, w: frame.width * k * .48, h: 16 })
    // On a tile that is filled with colour a band behind white words is only a smudge: there (the host
    // says so with --advice-under: 1, tokens.css) the mark is a light line drawn under the words instead,
    // no wider than they are, with a slight tilt.
    const under = getComputedStyle(host).getPropertyValue('--advice-under').trim() === '1'
    return () => {
    svg.classList.toggle('is-under', under)
    svg.replaceChildren(...lines.map((l, n) => {
      const w = i => wobble[(n * 4 + i) % wobble.length]
      const path = document.createElementNS(NS, 'path')
      if (under) {
        const y = l.y + l.h + 1.5, x0 = l.x + 1, x1 = l.x + l.w - 1
        path.setAttribute('d', penPath([[x0, y + .9 + w(0) * .2], [x0 + (x1 - x0) * .4, y - .2 + w(1) * .2], [x0 + (x1 - x0) * .75, y + .5 + w(2) * .2], [x1, y - .8 + w(3) * .2]]))
        path.style.strokeWidth = '2.4px'
      } else {
        // (kept inside its own box, so it never makes what holds it scroll sideways)
        const y = l.y + l.h * .54, x0 = Math.max(0, l.x - 4), x1 = Math.min(frame.width * k, l.x + l.w + 5)
        path.setAttribute('d', penPath([[x0, y + 1.2 + w(0) * .5], [x0 + (x1 - x0) * .35, y - .6 + w(1) * .5], [x0 + (x1 - x0) * .7, y + .8 + w(2) * .5], [x1, y - 1.2 + w(3) * .5]]))
        path.style.strokeWidth = `${(l.h * .78).toFixed(1)}px`
      }
      return path
    }))
    }
  }
  const draw = () => adviceFrame(measure)
  if (typeof ResizeObserver === 'function') {
    const watch = new ResizeObserver(draw)
    queueMicrotask(() => { if (svg.parentElement) watch.observe(svg.parentElement); draw() })
  }
  return svg
}
const adviceQueue = new Set()
let adviceRaf = 0
function adviceFrame(measure) {
  adviceQueue.add(measure)
  adviceRaf ||= requestAnimationFrame(() => {
    adviceRaf = 0
    const writes = [...adviceQueue].map(m => m())
    adviceQueue.clear()
    for (const write of writes) write?.()
  })
}
