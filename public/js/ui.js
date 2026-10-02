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

export const clock = ts => new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })

export function ago(ts) {
  const min = Math.round((Date.now() - ts) / 60000)
  if (min < 1) return 'gerade eben'
  if (min < 60) return `vor ${min} Min.`
  if (min < 1440) return `vor ${Math.round(min / 60)} Std.`
  return new Date(ts).toLocaleDateString('de-DE', { day: 'numeric', month: 'short' })
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

export const URGENCY_LABEL = { low: 'Hat Zeit', normal: 'Normal', high: 'Dringend', critical: 'Blockiert' }

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
