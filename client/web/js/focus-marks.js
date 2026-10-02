// Writing and scribbling anywhere on a question card (the Focus window, behind its flag).
//
// The card itself is the surface. A click on what is asked (a paragraph, the title, empty space) puts a caret
// there: a small note that stays with what was clicked. The pen scribbles over everything that scrolls. Both
// are "marks":
//   { id, anchor: { kind: 'card' | 'section' | 'option', index?, key?, quote? }, text }      a written note
//   { id, anchor: { kind: 'card' }, strokes: [{ color, pts: [x0, y0, x1, y1, …] }] }          a scribble
// A section's index counts the blocks of the card's text (quote: how it begins, to find it again after a
// rewording). Stroke points are fractions of the content's WIDTH (y too), so a scribble keeps its place while the
// column keeps its width and scales with it otherwise.
//
//   const marks = cardMarks({ scroll, blocks(), labelOf(key), onChange() })
//   marks.controls            the pen, the eraser, undo: put them on the card
//   marks.get() / set(list)   the marks, plain data (for the card's draft)
//   marks.note(anchor)        begin a note there (the keyboard's way in; a click on the content does it by itself)
//   marks.text()              the written notes for the agent, each with what it refers to; '' when there are none
//   marks.optionNotes()       { key: text } for notes written on options
//   marks.picture()           Promise<PNG data URL | null>: the card as the human sees it, notes and scribbles drawn in
//   marks.count()
import { el, sketch } from './ui.js'

const NS = 'http://www.w3.org/2000/svg'
const newId = () => Math.random().toString(36).slice(2, 10)
const INK = ['var(--urg-high)', 'var(--accent)']

export function cardMarks({ scroll, blocks, labelOf, onChange }) {
  let list = []
  let pen = false, erasing = false, ink = 0
  let drawing = null

  // ── the layer the scribbles lie on: as large as what scrolls, scrolling with it ──
  const layer = document.createElementNS(NS, 'svg')
  layer.setAttribute('class', 'focus-ink')
  layer.setAttribute('aria-hidden', 'true')
  scroll.append(layer)
  const width = () => scroll.clientWidth || 1
  const fit = () => { layer.style.height = '0px'; layer.style.height = `${scroll.scrollHeight}px`; paintInk() }
  new ResizeObserver(fit).observe(scroll)

  const pathOf = pts => {
    const w = width()
    let d = ''
    for (let i = 0; i < pts.length; i += 2) d += `${i ? 'L' : 'M'}${(pts[i] * w).toFixed(1)} ${(pts[i + 1] * w).toFixed(1)}`
    return d
  }
  function paintInk() {
    const nodes = []
    for (const mark of list) for (const [at, stroke] of (mark.strokes ?? []).entries()) {
      const path = document.createElementNS(NS, 'path')
      path.setAttribute('d', pathOf(stroke.pts))
      path.style.stroke = stroke.color
      path.dataset.mark = mark.id
      path.dataset.at = at
      nodes.push(path)
    }
    layer.replaceChildren(...nodes)
  }
  const point = e => { const box = scroll.getBoundingClientRect(); return [(e.clientX - box.left + scroll.scrollLeft) / width(), (e.clientY - box.top + scroll.scrollTop) / width()] }

  layer.addEventListener('pointerdown', e => {
    if (!pen || e.button) return
    e.preventDefault()
    if (erasing) return rub(e)
    layer.setPointerCapture(e.pointerId)
    let mark = list.findLast(m => m.strokes)
    if (!mark) { mark = { id: newId(), anchor: { kind: 'card' }, strokes: [] }; list.push(mark) }
    drawing = { mark, stroke: { color: INK[ink], pts: point(e) } }
    mark.strokes.push(drawing.stroke)
    paintInk()
  })
  layer.addEventListener('pointermove', e => {
    if (erasing && e.buttons & 1) return rub(e)
    if (!drawing) return
    const [x, y] = point(e), pts = drawing.stroke.pts
    if (Math.hypot(x - pts.at(-2), y - pts.at(-1)) * width() < 2) return
    pts.push(Number(x.toFixed(4)), Number(y.toFixed(4)))
    layer.lastElementChild?.setAttribute('d', pathOf(pts))
  })
  const lift = () => { if (!drawing) return; if (drawing.stroke.pts.length < 4) drawing.mark.strokes.pop(); drawing = null; changed() }
  layer.addEventListener('pointerup', lift)
  layer.addEventListener('pointercancel', lift)
  function rub(e) {
    const hit = document.elementFromPoint(e.clientX, e.clientY)
    if (!(hit instanceof SVGPathElement) || hit.parentNode !== layer) return
    const mark = list.find(m => m.id === hit.dataset.mark)
    mark?.strokes.splice(Number(hit.dataset.at), 1)
    changed()
  }

  // ── the controls: the pen, a second colour, the eraser, undo ──
  const control = (cls, label, drawingName, act) => {
    const b = el('button', `focus-mark-tool ${cls}`)
    b.type = 'button'
    b.title = label
    b.setAttribute('aria-label', label)
    b.append(sketch(drawingName))
    b.addEventListener('click', act)
    return b
  }
  const penBtn = control('focus-mark-pen', 'Draw on the card (D)', 'pen', () => setPen(!pen))
  const inkBtn = control('focus-mark-ink', 'The other colour', 'pen', () => { ink = (ink + 1) % INK.length; erasing = false; paintTools() })
  const rubBtn = control('focus-mark-rub', 'Eraser: rub a line away', 'no', () => { erasing = !erasing; paintTools() })
  const undoBtn = control('focus-mark-undo', 'Undo the last line', 'back', () => { const mark = list.findLast(m => m.strokes?.length); mark?.strokes.pop(); changed() })
  const controls = el('span', 'focus-mark-tools')
  controls.append(undoBtn, rubBtn, inkBtn, penBtn)
  function paintTools() {
    penBtn.setAttribute('aria-pressed', String(pen))
    rubBtn.setAttribute('aria-pressed', String(erasing))
    inkBtn.style.color = INK[ink]
    inkBtn.hidden = rubBtn.hidden = undoBtn.hidden = !pen
    layer.toggleAttribute('data-pen', pen)
    layer.toggleAttribute('data-rub', pen && erasing)
  }
  function setPen(on) { pen = on; erasing = false; paintTools() }

  // ── written notes ──
  const anchorOf = target => {
    const all = blocks()
    const block = all.find(b => b.contains(target))
    if (!block) return { kind: 'card' }
    return { kind: 'section', index: all.indexOf(block), quote: block.textContent.trim().replace(/\s+/g, ' ').slice(0, 48) }
  }
  /** Where a note of that anchor stands: after its block, under its option, or at the end of the text. */
  function placeOf(anchor) {
    if (anchor.kind === 'section') {
      const all = blocks()
      return all.find(b => b.textContent.trim().replace(/\s+/g, ' ').startsWith(anchor.quote ?? '\u0000')) ?? all[anchor.index] ?? null
    }
    if (anchor.kind === 'option') return scroll.closest('.focus-card')?.querySelector(`.focus-opt[data-key="${CSS.escape(anchor.key)}"]`) ?? null
    return null
  }
  const noteNodes = new Map()   // mark id -> node
  function paintNotes() {
    for (const [id, node] of noteNodes) if (!list.some(m => m.id === id && m.text != null)) { node.remove(); noteNodes.delete(id) }
    for (const mark of list) {
      if (mark.text == null) continue
      let node = noteNodes.get(mark.id)
      if (!node) {
        node = el('label', 'focus-mark')
        const field = el('textarea')
        field.rows = 1
        field.placeholder = 'Write here'
        field.setAttribute('aria-label', mark.anchor.kind === 'option' ? `Note on ${labelOf(mark.anchor.key)}` : 'Note on this place')
        const grow = () => { field.style.height = 'auto'; field.style.height = `${field.scrollHeight}px` }
        field.addEventListener('input', () => { mark.text = field.value; grow(); onChange() })
        // Enter finishes the note, Shift+Enter breaks the line, Escape leaves; an empty note is gone.
        field.addEventListener('keydown', e => {
          if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey && !e.isComposing)) { e.preventDefault(); e.stopPropagation(); field.blur() }
        })
        field.addEventListener('blur', () => { if (!field.value.trim()) { list = list.filter(m => m !== mark); changed() } })
        node.append(sketch('pen'), field)
        node.grow = grow
        noteNodes.set(mark.id, node)
      }
      const field = node.querySelector('textarea')
      if (document.activeElement !== field && field.value !== mark.text) field.value = mark.text
      const place = placeOf(mark.anchor)
      node.dataset.kind = mark.anchor.kind
      const home = place ?? scroll.querySelector('.focus-body, .focus-lead')
      if (node.previousElementSibling !== home && !(node.previousElementSibling?.classList.contains('focus-mark') && node.isConnected)) home?.after(node)
      node.grow()
    }
  }
  function note(anchor = { kind: 'card' }) {
    // one note per place: a second click there goes on writing the first
    let mark = list.find(m => m.text != null && m.anchor.kind === anchor.kind && m.anchor.key === anchor.key && (anchor.kind !== 'section' || m.anchor.quote === anchor.quote))
    if (!mark) { mark = { id: newId(), anchor, text: '' }; list.push(mark) }
    paintNotes()
    noteNodes.get(mark.id)?.querySelector('textarea').focus({ preventScroll: false })
  }
  // A click on what is asked begins a note there. Not on what does something itself (a link, a button, a picture
  // that opens large, a field), not while text is being selected, not while the pen is in the hand.
  scroll.addEventListener('click', e => {
    if (pen || e.defaultPrevented || e.button) return
    if (e.target.closest('a, button, input, textarea, select, label, summary, iframe, video, audio, .focus-mark, .focus-answer, .focus-thread, .focus-media, .focus-earlier')) return
    if (String(getSelection()).trim()) return
    note(anchorOf(e.target))
  })

  function changed() {
    list = list.filter(m => m.text != null || m.strokes?.length)
    paintInk()
    paintNotes()
    onChange()
  }

  // ── what the agent gets ──
  const refer = anchor => (anchor.kind === 'option' ? `on option "${labelOf(anchor.key)}"` : anchor.kind === 'section' ? `on the paragraph beginning "${anchor.quote}"` : 'general')
  const written = () => list.filter(m => m.text?.trim())
  function text() {
    const notes = written().filter(m => m.anchor.kind !== 'option')
    if (!notes.length) return ''
    if (notes.length === 1 && notes[0].anchor.kind === 'card') return notes[0].text.trim()
    return notes.map(m => `${refer(m.anchor)}: ${m.text.trim()}`).join('\n')
  }
  const optionNotes = () => Object.fromEntries(written().filter(m => m.anchor.kind === 'option').map(m => [m.anchor.key, m.text.trim()]))

  /** The card as the human sees it, with notes and scribbles: what scrolls is copied with its looks written into
   *  every element, its pictures taken in as data, laid into an SVG and painted on a canvas at twice the size.
   *  Where a browser will not hand such a canvas out (Safari taints it), the notes and the scribbles are painted
   *  plainly on paper instead. */
  async function picture() {
    const w = scroll.clientWidth, h = Math.min(scroll.scrollHeight, 6000)
    const scale = 2
    const done = canvas => { try { return canvas.toDataURL('image/png') } catch { return null } }
    try {
      const copy = scroll.cloneNode(true)
      const from = [scroll, ...scroll.querySelectorAll('*')], to = [copy, ...copy.querySelectorAll('*')]
      for (let i = 0; i < from.length; i++) {
        const a = from[i], b = to[i]
        if (!(b instanceof HTMLElement || b instanceof SVGElement)) continue
        const style = getComputedStyle(a)
        let css = ''
        for (const prop of style) css += `${prop}:${style.getPropertyValue(prop)};`
        b.setAttribute('style', css)
        if (b instanceof HTMLTextAreaElement) b.textContent = a.value
        if (b instanceof HTMLIFrameElement) { const box = el('div'); box.setAttribute('style', `${css}background:#eee;`); b.replaceWith(box) }
      }
      copy.style.overflow = 'visible'
      copy.style.height = `${h}px`
      copy.style.maxHeight = 'none'
      copy.style.background = getComputedStyle(scroll.closest('.focus-card') ?? scroll).backgroundColor
      await Promise.all([...copy.querySelectorAll('img')].map(async img => {
        try {
          const blob = await (await fetch(img.src)).blob()
          img.src = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(blob) })
        } catch { img.removeAttribute('src') }
      }))
      copy.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml')
      const svg = `<svg xmlns="${NS}" width="${w}" height="${h}"><foreignObject width="100%" height="100%">${new XMLSerializer().serializeToString(copy)}</foreignObject></svg>`
      const image = new Image()
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` })
      const canvas = document.createElement('canvas')
      canvas.width = w * scale
      canvas.height = h * scale
      const c = canvas.getContext('2d')
      c.fillStyle = '#fff'
      c.fillRect(0, 0, canvas.width, canvas.height)
      c.drawImage(image, 0, 0, canvas.width, canvas.height)
      const out = done(canvas)
      if (out) return out
    } catch {}
    // the plain way: paper, the notes as lines of text, the scribbles where they were drawn
    const canvas = document.createElement('canvas')
    canvas.width = w * scale
    canvas.height = h * scale
    const c = canvas.getContext('2d')
    c.scale(scale, scale)
    c.fillStyle = '#fff'
    c.fillRect(0, 0, w, h)
    c.fillStyle = '#222'
    c.font = '16px system-ui, sans-serif'
    let y = 28
    for (const line of [text(), ...Object.entries(optionNotes()).map(([key, t]) => `on option "${labelOf(key)}": ${t}`)].join('\n').split('\n')) { c.fillText(line, 16, y); y += 22 }
    c.lineWidth = 2.5
    c.lineCap = c.lineJoin = 'round'
    for (const mark of list) for (const stroke of mark.strokes ?? []) {
      c.strokeStyle = '#b4531a'
      c.beginPath()
      for (let i = 0; i < stroke.pts.length; i += 2) c[i ? 'lineTo' : 'moveTo'](stroke.pts[i] * w, stroke.pts[i + 1] * w)
      c.stroke()
    }
    return done(canvas)
  }

  paintTools()
  return {
    controls, note, text, optionNotes, picture, setPen,
    penOn: () => pen,
    get: () => list.map(m => ({ ...m, strokes: m.strokes?.map(s => ({ color: s.color, pts: [...s.pts] })) })),
    set(next) {
      list = (Array.isArray(next) ? next : []).filter(m => m && m.id && m.anchor).map(m => ({ id: m.id, anchor: m.anchor, ...(m.text != null ? { text: String(m.text) } : {}), ...(m.strokes ? { strokes: m.strokes } : {}) }))
      fit()
      paintNotes()
    },
    count: () => list.filter(m => m.text?.trim() || m.strokes?.length).length,
    refit: fit,
  }
}
