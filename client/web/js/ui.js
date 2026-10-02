// Shared DOM helpers. Everything builds nodes, never HTML strings, so text
// from the agent can't inject markup.

export const el = (tag, cls, text) => {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text != null) node.textContent = text
  return node
}

function inline(parent, text) {
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(https?:\/\/[^\s<>)]+)/g
  let last = 0
  for (const m of text.matchAll(re)) {
    parent.append(text.slice(last, m.index))
    if (m[1]) parent.append(el('code', null, m[1].slice(1, -1)))
    else if (m[2]) parent.append(el('strong', null, m[2].slice(2, -2)))
    else {
      const a = el('a', null, m[3])
      a.href = m[3]
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      parent.append(a)
    }
    last = m.index + m[0].length
  }
  parent.append(text.slice(last))
}

/** Render the light markdown agents write: paragraphs, bullet lists, **bold**,
 *  `code`, fenced code blocks, bare links. Returns a div.rich. */
export function rich(text) {
  const root = el('div', 'rich')
  String(text).split(/```[^\n]*\n?/).forEach((chunk, i) => {
    if (i % 2) {
      const pre = el('pre')
      pre.append(el('code', null, chunk.replace(/\n$/, '')))
      return root.append(pre)
    }
    for (const block of chunk.split(/\n{2,}/)) {
      const lines = block.split('\n').filter(l => l.trim())
      if (!lines.length) continue
      if (lines.every(l => /^\s*[-*]\s+/.test(l))) {
        const ul = el('ul')
        for (const l of lines) inline(ul.appendChild(el('li')), l.replace(/^\s*[-*]\s+/, ''))
        root.append(ul)
      } else {
        inline(root.appendChild(el('p')), lines.join('\n'))
      }
    }
  })
  return root
}

export const clock = ts => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

export function ago(ts) {
  const min = Math.round((Date.now() - ts) / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  if (min < 1440) return `${Math.round(min / 60)} h ago`
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

/** A span whose relative time keeps itself current. */
export function agoNode(ts, cls = 'ago') {
  const node = el('span', cls, ago(ts))
  node.dataset.ts = ts
  return node
}
setInterval(() => {
  document.querySelectorAll('[data-ts]').forEach(n => { n.textContent = ago(Number(n.dataset.ts)) })
}, 30000)

export const URGENCY_LABEL = { low: 'Whenever', normal: 'Normal', high: 'Urgent', critical: 'Blocking' }

/** Older servers only say image yes/no; newer ones name the kind. */
export const kindOf = a => a.kind ?? (a.image ? 'image' : 'file')

/** Players for video and audio attachments. Returns a list of figure nodes. */
export function mediaNodes(list = []) {
  return list.filter(a => kindOf(a) === 'video' || kindOf(a) === 'audio').map(a => {
    const figure = el('figure', `media media-${kindOf(a)}`)
    const player = el(kindOf(a))
    player.src = a.url
    player.controls = true
    player.preload = 'metadata'
    if (kindOf(a) === 'video') player.playsInline = true
    figure.append(player, el('figcaption', null, a.name))
    return figure
  })
}

// ---- doodles: a hand-scribbled mark per session ------------------------------

// Small seeded generator, so a session always gets the same scribble.
function seeded(text) {
  let h = 2166136261
  for (const ch of String(text)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    return ((h ^= h >>> 16) >>> 0) / 4294967296
  }
}

// A smooth line through points, the way a pen moves: quadratic curves between midpoints.
function penPath(points, closed = false) {
  const p = closed ? [...points, points[0], points[1]] : points
  let d = `M${p[0][0].toFixed(1)} ${p[0][1].toFixed(1)}`
  for (let i = 1; i < p.length - 1; i++) {
    const mx = (p[i][0] + p[i + 1][0]) / 2, my = (p[i][1] + p[i + 1][1]) / 2
    d += ` Q${p[i][0].toFixed(1)} ${p[i][1].toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`
  }
  if (!closed) d += ` L${p.at(-1)[0].toFixed(1)} ${p.at(-1)[1].toFixed(1)}`
  return d
}

const DOODLES = [
  // burst: uneven rays from the middle
  r => {
    const n = 6 + Math.floor(r() * 4), turn = r() * Math.PI
    return Array.from({ length: n }, (_, i) => {
      const a = turn + (i / n) * Math.PI * 2 + (r() - .5) * .25, len = 7 + r() * 6, from = 1.5 + r() * 2
      return `M${(16 + Math.cos(a) * from).toFixed(1)} ${(16 + Math.sin(a) * from).toFixed(1)} L${(16 + Math.cos(a) * len).toFixed(1)} ${(16 + Math.sin(a) * len).toFixed(1)}`
    })
  },
  // spiral: wound by hand, never quite round
  r => {
    const turns = 2.2 + r() * 1.2, start = r() * 6
    return [penPath(Array.from({ length: 34 }, (_, i) => {
      const t = i / 33, a = start + t * turns * Math.PI * 2, rad = 1.5 + t * 11 + (r() - .5) * 1.1
      return [16 + Math.cos(a) * rad, 16 + Math.sin(a) * rad]
    }))]
  },
  // blob: circled twice, the passes do not line up
  r => [0, 1].map(pass => penPath(Array.from({ length: 9 }, (_, i) => {
    const a = (i / 9) * Math.PI * 2 + pass * .4, rad = 9.5 + (r() - .5) * 4 - pass * 1.5
    return [16 + Math.cos(a) * rad, 16 + Math.sin(a) * rad * .9]
  }), true)),
  // flower: loops around a point
  r => {
    const n = 4 + Math.floor(r() * 3), turn = r() * Math.PI
    return Array.from({ length: n }, (_, i) => {
      const a = turn + (i / n) * Math.PI * 2, w = .42 + r() * .12, len = 10.5 + r() * 2.5
      const tip = [16 + Math.cos(a) * len, 16 + Math.sin(a) * len]
      const l = [16 + Math.cos(a - w) * len * .72, 16 + Math.sin(a - w) * len * .72]
      const rr = [16 + Math.cos(a + w) * len * .72, 16 + Math.sin(a + w) * len * .72]
      return penPath([[16, 16], l, tip, rr, [16, 16]])
    })
  },
  // waves: three lines drawn left to right
  r => [9, 16, 23].map(y => penPath(Array.from({ length: 7 }, (_, i) => [4 + i * 4, y + (i % 2 ? -2.6 : 2.6) + (r() - .5) * 1.6]))),
  // knot: a figure that crosses itself
  r => {
    const a = 2 + Math.floor(r() * 2), b = 3, phase = r() * 3
    return [penPath(Array.from({ length: 40 }, (_, i) => {
      const t = (i / 39) * Math.PI * 2
      return [16 + Math.sin(a * t + phase) * 11 + (r() - .5) * .8, 16 + Math.sin(b * t) * 10 + (r() - .5) * .8]
    }))]
  },
  // bolt: a zigzag with weight
  r => [penPath(Array.from({ length: 6 }, (_, i) => [8 + (i % 2) * 12 + (r() - .5) * 5, 4 + i * 4.8])), penPath([[6 + r() * 3, 27], [26 - r() * 3, 27.5]])],
  // hatch: a patch shaded with quick strokes
  r => Array.from({ length: 6 }, (_, i) => `M${(5 + i * 3.6 + r()).toFixed(1)} ${(25 + r() * 2).toFixed(1)} L${(11 + i * 3.6 + r()).toFixed(1)} ${(6 + r() * 2).toFixed(1)}`),
]

/** A scribbled mark that belongs to one session. Returns an SVG element sized by CSS, drawn in currentColor. */
export function doodle(id) {
  const r = seeded(id)
  const paths = DOODLES[Math.floor(r() * DOODLES.length)](r)
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 32 32')
  svg.setAttribute('class', 'doodle')
  svg.setAttribute('aria-hidden', 'true')
  svg.style.rotate = `${Math.round((r() - .5) * 16)}deg`
  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}

/** Several sessions scribbled together as one mark: their doodles drawn over each other inside one
 *  loop that was circled by hand and does not quite close. members: [{ id, mark, hue }].
 *  Each doodle carries data-member, so a pointer can tell which one it is on. */
export function pairDoodle(members) {
  const NS = 'http://www.w3.org/2000/svg'
  const r = seeded(members.map(m => m.id).join('+'))
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 46 34')
  svg.setAttribute('class', 'pair-mark')
  svg.setAttribute('aria-hidden', 'true')
  const n = members.length
  const size = n > 2 ? .56 : .68
  members.forEach((m, i) => {
    const g = document.createElementNS(NS, 'g')
    const own = doodle(m.mark ?? m.id)
    const x = 4.5 + (n > 1 ? i * ((37 - 32 * size) / (n - 1)) : 0)
    const y = (34 - 32 * size) / 2 + (i % 2 ? 2.4 : -2.2)
    const turn = (parseFloat(own.style.rotate) || 0) + (i % 2 ? 9 : -7)
    g.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${size}) rotate(${turn} 16 16)`)
    g.dataset.member = m.id
    g.style.setProperty('--hue', m.hue)
    const hit = document.createElementNS(NS, 'rect')
    hit.setAttribute('width', '32')
    hit.setAttribute('height', '32')
    g.append(hit, ...own.childNodes)
    svg.append(g)
  })
  // The loop: one and a bit turns round both, starting and ending apart.
  const start = r() * 6, steps = 15
  const loop = document.createElementNS(NS, 'path')
  loop.setAttribute('class', 'pair-loop')
  loop.setAttribute('d', penPath(Array.from({ length: steps }, (_, i) => {
    const a = start + (i / (steps - 2)) * Math.PI * 2, drift = i / steps * 1.6
    return [23 + Math.cos(a) * (20.5 - drift + (r() - .5) * 1.4), 17 + Math.sin(a) * (14.5 - drift + (r() - .5) * 1.4)]
  })))
  svg.append(loop)
  return svg
}

// ---- sketched icons: the hand, the thumbs, later, choose ------------------------

// Strokes as a pen would make them, in a 24 box. Each is a list of points; the pen wobbles a little
// (seeded by the name, so an icon always looks the same) and lines neither meet nor end cleanly.
const flip = strokes => strokes.map(s => s.map(([x, y]) => [24 - x, 24 - y]))
const THUMB = [
  [[4.6, 11.2], [4.2, 19.6], [7.3, 19.9], [7.7, 11], [4.3, 10.7]],
  [[8.2, 11.4], [10, 7.6], [10.8, 3.6], [13.4, 3.9], [13, 7.4], [12.4, 9.9], [17.8, 9.6], [19.8, 10.8], [19.2, 13.4], [18.4, 16.8], [17.2, 19.8], [14, 20.1], [10.2, 19.8], [8.1, 18.9]],
  [[15.2, 13.2], [18.6, 13.3]],
  [[14.8, 16.4], [17.9, 16.6]],
]
const SKETCH = {
  yes: THUMB,
  no: flip(THUMB),
  // a raised hand: thumb, four fingers, drawn without lifting the pen, then the heel of the hand
  hand: [
    [[7.6, 14.6], [5.8, 12.2], [3.9, 11.4], [3.7, 13.3], [5.6, 16.2], [7.4, 19.4], [10, 21.3], [13.6, 21.4], [16.4, 19.6], [17.6, 15.4], [17.8, 8.4], [16.6, 7], [15.6, 8.6], [15.5, 11.6]],
    [[7.6, 14.2], [7.5, 6.2], [8.6, 4.8], [9.8, 6.2], [10, 11.2]],
    [[10, 11], [10.1, 4.2], [11.4, 2.7], [12.6, 4.2], [12.6, 11]],
    [[12.7, 11.2], [13, 5.2], [14.2, 4], [15.3, 5.6], [15.3, 11.8]],
  ],
  later: [[[12, 3.8], [12.3, 10], [11.9, 16.4]], [[6.6, 11.6], [12.1, 17.2], [17.4, 11.3]], [[4.6, 20.8], [12, 20.3], [19.6, 20.6]]],
  back: [[[12.1, 20.2], [11.8, 14], [12.2, 7.6]], [[6.6, 12.6], [12, 6.8], [17.5, 12.3]], [[4.6, 3.6], [12, 3.9], [19.5, 3.4]]],
  // three options, one of them ticked
  choose: [
    [[3.6, 6.6], [5.2, 8.6], [8.4, 4.4]],
    [[11.4, 6.6], [16, 6.3], [20.6, 6.8]],
    [[4.4, 12.4], [6.4, 12.3]], [[11.2, 12.4], [15, 12.7], [19, 12.2]],
    [[4.4, 18], [6.5, 18.2]], [[11.4, 18.2], [14, 17.9], [16.8, 18.3]],
  ],
  other: [[[4.6, 8.6], [11, 8.2], [18.8, 8.7]], [[14.6, 4.8], [19.2, 8.6], [14.9, 12.2]], [[19.4, 15.6], [12, 15.9], [5.2, 15.4]], [[9.4, 11.9], [4.8, 15.5], [9.2, 19.3]]],
  // an hourglass in one go, a little sand below: whenever
  whenever: [
    [[6.4, 3.8], [17.8, 3.6], [17.4, 6.4], [12.6, 11.8], [17.6, 17.6], [18, 20.4], [6.2, 20.6], [6.5, 17.8], [11.4, 12.2], [6.6, 6.6], [6.2, 3.4]],
    [[10.4, 18.4], [12.1, 16.6], [13.8, 18.5]],
  ],
}

/** An icon drawn like the session marks: a few uneven pen strokes with a little tilt. Sized and coloured by CSS. */
export function sketch(name) {
  const r = seeded(`sketch:${name}`)
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('class', 'sketch')
  svg.setAttribute('aria-hidden', 'true')
  svg.style.rotate = `${((r() - .5) * 9).toFixed(1)}deg`
  for (const stroke of SKETCH[name] ?? []) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', penPath(stroke.map(([x, y]) => [x + (r() - .5) * .7, y + (r() - .5) * .7])))
    svg.append(path)
  }
  return svg
}
