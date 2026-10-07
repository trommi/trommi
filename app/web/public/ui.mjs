// What every view shares: the markup helpers (html, the pen's drawings, words, pictures, toasts), the controllers
// stand-in (Stimulus-like: controller(name, class)), rich text and the agent's layouts in their sandboxed frame,
// the keys, and the small pieces more than one view draws (a card's row, a session's mark, the room's frame).
// Importing it does nothing: app.mjs boot calls startUi().
//


// ---- html: the one escaping helper ----
// The one escaping helper of the server-rendered board.
//
//   html`<p title="${card.title}">${card.body}</p>`
//
// Every value put into the template is escaped, for text and for a quoted attribute alike. What is already
// markup is said so by being a Safe: the result of another html`` template, or raw('…') for a string this
// code made itself (an SVG from the pen, a stream wrapper). Board content (titles, texts, labels, names,
// anything an agent or the human wrote) never goes through raw().
// A list is its items one after the other; null, undefined and false are nothing.
const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ENT[ch])

class Safe {
  constructor(text) { this.text = text }
  toString() { return this.text }
}
export const raw = text => new Safe(String(text ?? ''))

const put = value => {
  if (value == null || value === false || value === true) return ''
  if (value instanceof Safe) return value.text
  if (Array.isArray(value)) return value.map(put).join('')
  return esc(value)
}

export function html(strings, ...values) {
  let out = strings[0]
  for (let i = 0; i < values.length; i++) out += put(values[i]) + strings[i + 1]
  return new Safe(out)
}

/** Attributes from an object: { class: 'a', hidden: true, title: null } -> ` class="a" hidden`. */
const attrs = map => raw(Object.entries(map).map(([name, value]) => (value == null || value === false ? '' : value === true ? ` ${name}` : ` ${name}="${esc(value)}"`)).join(''))

// ---- pen ----
// The pen: every hand-drawn mark of the board as an SVG string. No DOM, no browser, no Node API, so the hub
// (server/views) and the page (islands) draw with the same code and the same seeds: a name or a session id
// always gives the same strokes, byte for byte.
//
// The stroke tables and generators below are the ones of ui.mjs and js/agents.js (the old client builds
// DOM nodes from them). Until the old client is retired they stand in both places: when a drawing changes
// there, run `node dev/pen-sync.mjs` to copy the tables here again.

// ---- tables (copied from ui.mjs by dev/pen-sync.mjs; do not edit between the two marks) ----
// pen-tables:begin
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

// Drawings a session can be given by name, next to the eight kinds above: things one can tell apart
// at a glance. Points in the 32 box; a stroke marked straight keeps its corners, any other is drawn
// in one curve. The pen wobbles a little on every point.
const straight = points => Object.assign(points, { straight: true })
const NAMED = {
  star: [straight([[16, 4.6], [22.4, 26.2], [4.8, 12.4], [27.2, 12.2], [9.4, 26.4], [16.5, 5.2]])],
  zigzag: [straight([[4.6, 9], [10.6, 22.6], [15.6, 9.4], [21, 22.8], [27.4, 9.6]])],
  eight: [[[16, 16], [10, 9.5], [13.5, 4.5], [20, 5.6], [20.6, 11], [16, 16], [11, 21.6], [12.4, 27], [19, 27.4], [21.6, 22], [16.4, 16.2]]],
  arrow: [straight([[5.4, 26.2], [25.4, 7]]), straight([[14, 6.2], [26, 6.4], [25.6, 18.4]])],
  leaf: [[[6, 26.5], [7, 14], [15, 6.5], [26, 5.5], [25, 16], [17.5, 24], [6.5, 26.2]], straight([[6.4, 26], [19.6, 12.2]])],
  eye: [[[4, 16], [10, 9.6], [16, 8], [22, 9.6], [28, 16], [22, 22.4], [16, 24], [10, 22.4], [4.3, 16.4]], [[16, 12.4], [19.6, 16], [16, 19.6], [12.4, 16], [16.3, 12.3]]],
  key: [[[9, 5.6], [13.6, 7.6], [14.2, 12.6], [10, 15.4], [5.4, 13.4], [5, 8.4], [9.4, 5.4]], straight([[13.2, 13.4], [26.6, 26.6]]), straight([[21.2, 21.6], [24.6, 18.4]]), straight([[24.4, 24.8], [27.6, 21.6]])],
  anchor: [straight([[16, 7.6], [16.1, 27.2]]), [[16, 3.4], [18.4, 5.6], [16, 7.8], [13.6, 5.6], [16.2, 3.3]], straight([[10.4, 11.6], [21.6, 11.4]]), [[4.8, 18.4], [7.6, 24.6], [16, 27.4], [24.4, 24.6], [27.2, 18.4]]],
  kite: [straight([[16, 3.6], [25, 12.6], [16, 23.6], [7, 12.6], [16.3, 4]]), straight([[16, 4.2], [16.1, 23.4]]), [[16, 23.6], [13, 25.6], [17.6, 27], [14.4, 29.2]]],
  comb: [straight([[4.8, 8], [27.2, 8.4]]), straight([[7.4, 8.6], [7.2, 24]]), straight([[12, 8.6], [12.2, 24.6]]), straight([[16.5, 8.6], [16.3, 24]]), straight([[21, 8.6], [21.2, 24.4]]), straight([[25.4, 8.6], [25.2, 24]])],
  ladder: [straight([[10, 4], [9.4, 28]]), straight([[22, 4], [22.6, 28]]), straight([[10, 9], [22, 9.2]]), straight([[9.8, 15.6], [22.2, 15.8]]), straight([[9.6, 22.4], [22.4, 22.2]])],
  heart: [[[16, 27], [6, 17.6], [5, 10.6], [9.4, 6], [14, 7.6], [16, 11.6], [18.4, 7.6], [23, 6], [27, 10.6], [26, 17.6], [16.3, 26.6]]],
  moon: [[[20, 4.4], [11.6, 6.4], [7, 14], [9.4, 23], [18, 27.6], [25.6, 23.4], [19, 21], [15.4, 14.6], [17.4, 8], [20.4, 4.8]]],
  cloud: [[[8, 23.6], [4.4, 20], [6.4, 15], [11, 14.4], [13, 9.6], [19, 8.4], [22.6, 13], [26.6, 14.6], [27.6, 19.6], [24.4, 23.6], [8.4, 23.9]]],
  drop: [[[16, 3.8], [9.6, 15], [8.4, 21.6], [12, 26.6], [16, 27.6], [20, 26.6], [23.6, 21.6], [22.4, 15], [16.2, 4.2]]],
  flag: [straight([[8, 3.8], [8.4, 28.4]]), [[8.2, 5.6], [14, 4], [19, 8], [25.6, 6.4], [25, 16.4], [19, 18.6], [14, 14.6], [8.4, 16.6]]],
  house: [straight([[4.8, 15], [16, 5], [27.2, 15.4]]), straight([[8, 13], [8.2, 27], [24, 27.2], [23.8, 13]]), straight([[14, 27], [14.2, 19.6], [18.2, 19.4], [18, 27]])],
  tree: [straight([[16, 3.8], [6.4, 20], [25.6, 20.2], [16.4, 4.2]]), straight([[16, 20.2], [16.2, 28.6]])],
  fish: [[[4, 16], [10, 9.6], [18, 9], [23, 16], [18, 23], [10, 22.4], [4.3, 16.3]], straight([[22.6, 16], [28, 10.4], [27.6, 21.8], [22.9, 16.3]]), straight([[9.2, 14.4], [9.8, 15]])],
  bird: [[[3.8, 13.4], [7.6, 8.6], [12, 9.6], [16, 17]], [[16, 17], [20, 9.2], [24.4, 8], [28.2, 12.6]]],
  cup: [straight([[7, 9], [9, 26], [21, 26.2], [23, 9.2]]), straight([[6.4, 9], [23.6, 9.2]]), [[23, 12.4], [28, 13.6], [27.4, 19.6], [22.2, 20.6]]],
  bell: [[[6, 23.4], [9, 19.6], [9.6, 11.6], [13, 6.6], [16, 5.4], [19, 6.6], [22.4, 11.6], [23, 19.6], [26, 23.4]], straight([[5.4, 23.6], [26.6, 23.8]]), [[13.6, 26], [16, 28.2], [18.4, 26]]],
  cross: [straight([[7, 7], [25, 25.4]]), straight([[25, 6.6], [7, 25]])],
  triangle: [straight([[16, 5], [27, 26], [5, 26.4], [16.4, 5.4]])],
  square: [straight([[6.4, 6.6], [25.8, 6.2], [26, 25.6], [6.2, 26], [6.7, 6]])],
  diamond: [straight([[16, 3.8], [27, 16], [16, 28.2], [5, 16], [16.4, 4.3]]), straight([[9.4, 11.4], [22.8, 11.2]])],
  grid: [straight([[12, 4.4], [11.6, 27.6]]), straight([[21, 4.4], [20.6, 27.6]]), straight([[4.4, 12], [27.6, 11.6]]), straight([[4.4, 21], [27.6, 20.6]])],
  mountain: [straight([[3.4, 26], [12, 8], [17.6, 18], [21.6, 12.4], [28.6, 26.2]]), straight([[9.4, 13.6], [12.2, 15.6], [14.6, 12.8]])],
  umbrella: [[[4, 16.6], [7, 9.6], [16, 5.4], [25, 9.6], [28, 16.6]], straight([[4, 16.6], [28, 16.8]]), straight([[16, 5.6], [16.1, 25]]), [[16, 25], [15.4, 28], [12.6, 28.2], [12, 25.6]]],
  crown: [straight([[5, 24], [4.6, 9.6], [11, 17], [16, 7], [21, 17], [27.4, 9.6], [27, 24.2], [5.3, 24.4]])],
  flame: [[[15.6, 3.6], [15.6, 3.6], [21, 10.4], [24.4, 17.4], [22.6, 24], [16.6, 28], [10.4, 25.6], [7.8, 19.6], [9.6, 13.6], [12.6, 10.4], [15.2, 4]], [[16, 26.4], [13, 22.6], [16.2, 16.6], [16.2, 16.6], [19.2, 22.4], [16.4, 26.2]]],
  boat: [straight([[4, 19], [28, 19.2], [23.6, 26.6], [8.4, 26.4], [4.4, 19.4]]), straight([[15, 19], [15.2, 4.4]]), straight([[15.4, 5], [24, 16.4], [15.5, 16.6]])],
  // ---- the kinds of work agents do: a drawing each, so a session can wear what it is busy with ----
  browser: [straight([[4, 6], [28, 5.6], [28.2, 26], [3.8, 26.4], [4.2, 5.6]]), straight([[4.2, 11.4], [28, 11]]), straight([[7.2, 8.4], [8, 8.6]]), [[8, 18], [13, 16.4], [17.6, 19], [23.6, 17]]],
  terminal: [straight([[3.8, 6], [28, 5.8], [28.2, 26], [4, 26.2], [4, 5.6]]), straight([[8.4, 12], [13.6, 16], [8.6, 20]]), straight([[15.8, 20.6], [22.6, 20.4]])],
  database: [[[6, 9], [9, 6.4], [16, 5.4], [23, 6.4], [26, 9], [23, 11.6], [16, 12.6], [9, 11.6], [6.2, 9.3]], straight([[6, 9.4], [6.2, 23]]), straight([[26, 9.4], [25.8, 23]]), [[6.2, 23], [9, 25.8], [16, 26.8], [23, 25.8], [25.8, 23]], [[6.2, 16], [9, 18.6], [16, 19.6], [23, 18.6], [25.8, 16]]],
  phone: [straight([[10, 3.8], [22, 4], [22.4, 28], [9.8, 28.2], [10.2, 3.4]]), straight([[14.2, 7], [18, 7]]), straight([[15.6, 24.6], [16.6, 24.8]])],
  brush: [straight([[26.4, 4.4], [15, 16]]), [[15, 16], [12.2, 14.8], [10.4, 17.4], [13.2, 19.8], [16, 17.6]], [[11, 17.2], [7.2, 19.2], [6, 23], [4.2, 26.8], [9.2, 26.2], [12.8, 23.6], [13.6, 20]]],
  flask: [straight([[11, 4.4], [21, 4.2]]), straight([[12.8, 4.6], [12.8, 12]]), straight([[19.2, 4.6], [19.2, 12]]), [[12.8, 12], [9, 18.4], [6, 24], [7.6, 27.4], [16, 28], [24.4, 27.4], [26, 24], [23, 18.4], [19.2, 12]], [[9.2, 20.6], [13, 19.4], [18, 21.2], [22.8, 20]]],
  lock: [[[10.4, 14], [10.2, 9], [13, 5], [16, 4.2], [19, 5], [21.8, 9], [21.6, 14]], straight([[7, 14], [25, 13.8], [25.2, 27], [6.8, 27.2], [7.2, 13.4]]), straight([[16, 18.6], [16.1, 22.8]])],
  book: [straight([[16, 8.2], [16.2, 27]]), [[16, 8], [12, 5.8], [4.2, 6.6], [4.1, 15.6], [4, 24.6], [12, 24.4], [16, 27]], [[16, 8], [20, 5.8], [27.8, 6.6], [27.9, 15.6], [28, 24.6], [20, 24.4], [16.2, 27]]],
  rocket: [[[16, 3.2], [11.6, 9], [10.8, 16.6], [12, 22], [20, 22], [21.2, 16.6], [20.4, 9], [16.2, 3.5]], [[16, 10], [18, 12], [16, 14], [14, 12], [16.2, 9.9]], straight([[10.8, 16.6], [6.4, 23.6], [11.8, 21.4]]), straight([[21.2, 16.6], [25.6, 23.6], [20.2, 21.4]]), [[14, 24.6], [16, 29], [18, 24.6]]],
  mic: [[[16, 3.8], [12.6, 5.6], [12, 10], [12.4, 15], [16, 17.4], [19.6, 15], [20, 10], [19.4, 5.6], [16.3, 3.7]], [[8, 13.4], [9, 18.4], [12.6, 21.6], [16, 22.4], [19.4, 21.6], [23, 18.4], [24, 13.4]], straight([[16, 22.6], [16.1, 27.4]]), straight([[11.4, 27.6], [20.6, 27.4]])],
  bug: [[[16, 9], [11, 12], [10, 18], [12, 24], [16, 26], [20, 24], [22, 18], [21, 12], [16.2, 8.9]], [[12.6, 8.8], [16, 5.4], [19.4, 8.8]], straight([[16, 9.6], [16.1, 25.6]]), straight([[10.2, 14], [5, 11.4]]), straight([[9.8, 18.4], [4.4, 18.6]]), straight([[11, 22.6], [6, 26.2]]), straight([[21.8, 14], [27, 11.4]]), straight([[22.2, 18.4], [27.6, 18.6]]), straight([[21, 22.6], [26, 26.2]])],
  branch: [straight([[9, 7.6], [9.2, 24.8]]), [[9, 4], [11, 5.8], [9, 7.6], [7, 5.8], [9.2, 3.9]], [[9.2, 25], [11.2, 26.8], [9.2, 28.6], [7.2, 26.8], [9.4, 24.9]], [[23, 9], [25, 10.8], [23, 12.6], [21, 10.8], [23.2, 8.9]], [[23, 12.8], [22, 17.6], [14.6, 19], [9.6, 22.4]]],
}
const KINDS = ['burst', 'spiral', 'blob', 'flower', 'waves', 'knot', 'bolt', 'hatch']   // DOODLES, in their order
/** The drawings a session can be given: forty names. A session's mark is then "draw:<name>". */
const DRAWINGS = [...KINDS, ...Object.keys(NAMED)]
const drawingMark = name => `draw:${name}`
/** The drawing a mark names ("draw:rocket" -> "rocket"), or null for a seeded scribble. */
const drawingOf = mark => { const name = /^draw:(.+)$/.exec(String(mark ?? ''))?.[1]; return DRAWINGS.includes(name) ? name : null }
// Every drawing has one colour of its own, wherever it shows: a hue, turned by the golden angle from
// one drawing to the next, so neighbours in the picker never look alike. (A session with a seeded
// scribble instead of a named drawing keeps the colour that comes from its id.) The hue is used as
// hsl(hue 62% 30%) on light and hsl(hue 70% 76%) on dark, which reads for every hue.
const drawingHue = name => { const at = DRAWINGS.indexOf(name); return at < 0 ? null : Math.round((162 + at * 137.508) % 360) }

const linePath = points => `M${points.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L')}`

const CROWN_WASH = 'M5 16.9 L3.9 6.6 L9.8 11.6 L14 3.8 L18.5 11.4 L24.5 6.2 L23.3 17.1 Z'
const CROWN = 'M3.7 16.1 Q3.5 10.4 2.5 5.5 Q6.2 7.4 8.8 10.7 Q10.3 6.2 13.1 2.7 Q15.9 6.1 17.4 10.5 Q20 7 23.7 5.1 Q23.6 10.9 22.2 16.3 Q13.2 15.2 4.5 15.9'
const CROWN_JEWELS = []   // the three stones are off again ("zu viel"); a stone would be [cx, cy, r]

const flip = strokes => strokes.map(s => s.map(([x, y]) => [24 - x, 24 - y]))
const THUMB = [
  [[4.6, 11.2], [4.2, 19.6], [7.3, 19.9], [7.7, 11], [4.3, 10.7]],
  [[8.2, 11.4], [10, 7.6], [10.8, 3.6], [13.4, 3.9], [13, 7.4], [12.4, 9.9], [17.8, 9.6], [19.8, 10.8], [19.2, 13.4], [18.4, 16.8], [17.2, 19.8], [14, 20.1], [10.2, 19.8], [8.1, 18.9]],
  [[15.2, 13.2], [18.6, 13.3]],
  [[14.8, 16.4], [17.9, 16.6]],
]
// The ear's rim and its inner fold (the link's signs below).
const EAR_RIM = [[8.4, 13.8], [7.2, 10.2], [8, 6.4], [10.8, 4.2], [14.2, 4.2], [16.8, 6.4], [17.2, 9.8], [15.8, 12.8], [14.2, 15], [13.6, 18], [11.8, 20], [9.6, 19.6], [8.6, 17.8]]
const EAR_FOLD = [[10.6, 11], [10.9, 8.4], [12.6, 7.2], [14.2, 8.4], [13.9, 10.6], [12.4, 12.2]]
const SKETCH = {
  yes: THUMB,
  no: flip(THUMB),
  // The first hand, kept by name for the iOS port and its fixtures; the web draws raisedHand().
  hand: [
    [[7.6, 14.6], [5.8, 12.2], [3.9, 11.4], [3.7, 13.3], [5.6, 16.2], [7.4, 19.4], [10, 21.3], [13.6, 21.4], [16.4, 19.6], [17.6, 15.4], [17.8, 8.4], [16.6, 7], [15.6, 8.6], [15.5, 11.6]],
    [[7.6, 14.2], [7.5, 6.2], [8.6, 4.8], [9.8, 6.2], [10, 11.2]],
    [[10, 11], [10.1, 4.2], [11.4, 2.7], [12.6, 4.2], [12.6, 11]],
    [[12.7, 11.2], [13, 5.2], [14.2, 4], [15.3, 5.6], [15.3, 11.8]],
  ],
  // a microphone: the head a loop that does not close, its cradle, the stand and a foot
  mic: [
    [[12.3, 3.3], [9.9, 4.4], [9.3, 7.8], [9.5, 11.4], [11.9, 13.5], [14.5, 11.7], [14.8, 7.9], [14.3, 4.7], [12.9, 3.5]],
    [[6.3, 10.4], [7, 14.1], [9.3, 16.5], [12.1, 17.2], [14.9, 16.3], [17, 13.9], [17.8, 10.2]],
    [[12.1, 17.4], [12.3, 20.7]],
    [[8.9, 20.9], [12.2, 20.6], [15.5, 21]],
  ],
  later: [[[12, 3.8], [12.3, 10], [11.9, 16.4]], [[6.6, 11.6], [12.1, 17.2], [17.4, 11.3]], [[4.6, 20.8], [12, 20.3], [19.6, 20.6]]],
  // The Focus window's composer: send is an arrow up with a kick in its shaft; explain is a question mark
  // with three short rays, an "aha" about to happen.
  send: [[[12.4, 20.4], [11.6, 15.6], [12.5, 10.4], [12, 4.6]], [[6.2, 10.4], [12, 4.2], [17.8, 10]]],
  // a playing card with two arrows chasing each other: the turn goes back to the other side
  reverse: [
    [[7.2, 3.3], [17, 3.1], [18.7, 4.9], [18.9, 19.2], [17.1, 20.9], [7, 20.7], [5.3, 19], [5.1, 5], [7.4, 3.1]],
    [[8.5, 11.6], [9.1, 8.4], [12.2, 7], [15, 8.2]], [[13, 6.1], [15.4, 8.3], [13.1, 10.2]],
    [[15.5, 12.5], [14.9, 15.7], [11.8, 17.1], [9, 15.9]], [[11, 18], [8.6, 15.8], [10.9, 13.9]],
  ],
  // a pencil, held slanted, with the line it has just drawn: scribble instead of typing
  pen: [[[5.2, 18.8], [6.2, 15], [15.6, 5.2], [17.4, 4.6], [19.4, 6.6], [18.8, 8.4], [9, 17.8], [5.4, 18.9]], [[14.2, 6.8], [17.2, 9.8]], [[11.6, 20.4], [14.4, 19.2], [16.4, 20.6], [19.4, 19.6]]],
  // three z rising, each a little larger: asleep for now
  snooze: [[[4.4, 15.6], [9, 15.3], [9.2, 15.5], [4.8, 20.2], [4.6, 20.4], [9.6, 20.1]], [[10.4, 9.6], [15.4, 9.3], [15.6, 9.5], [10.8, 14.4], [10.6, 14.6], [16, 14.2]], [[15.4, 3.4], [20.8, 3.1], [21, 3.3], [15.8, 8.6], [15.6, 8.8], [21.4, 8.4]]],
  // two question marks written by hand, no two alike: the "??" of "What??"
  q1: [[[7.4, 8.6], [8, 5.2], [11.6, 3.4], [15.4, 4.8], [16.2, 8.2], [13.4, 11.4], [11.8, 13.6], [11.9, 16.2]], [[11.8, 20.2], [12.1, 20.8]]],
  q2: [[[8.2, 7.4], [10, 4.4], [13.8, 3.8], [16.6, 6.2], [15.8, 9.8], [12.6, 12], [12, 14.4], [12.4, 16.6]], [[12.3, 20.4], [12.7, 20.9]]],
  // a clock whose rim is an arrow turning back: the earlier versions of a question
  timemachine: [[[6.2, 7.8], [9.4, 4.7], [13.8, 4.2], [17.8, 6.6], [19.6, 10.8], [18.6, 15.4], [15.2, 18.6], [10.8, 19], [7, 16.6], [5.2, 12.8]], [[3.2, 8.6], [6.3, 7.6], [7.5, 10.8]], [[12.2, 8.2], [12.1, 12.2], [15, 13.8]]],
  q3: [[[7.8, 9], [8.6, 5.6], [12, 4], [15.6, 5.2], [16, 8.6], [13, 11], [12.2, 13.4], [12, 16.4]], [[12, 20.2], [12.4, 20.9]]],
  // two hands that meet: left to the agent
  trust: [[[3.2, 9.8], [7.4, 8.8], [10.6, 10.4], [13.2, 12.8], [15.6, 14.4]], [[20.8, 9.8], [16.6, 9], [13.8, 9.8], [11.4, 12.2], [9.4, 13.8]], [[9.6, 14], [11.4, 16.6], [13.6, 16.8], [15.4, 14.6]], [[3, 7.4], [3.5, 12.2]], [[21, 7.6], [20.5, 12.2]]],
  // a sheet going into the slot, strips coming out below: thrown away
  shred: [[[3.6, 10.8], [12, 10.3], [20.4, 10.9]], [[7.4, 10], [7.6, 3.6], [16.4, 3.4], [16.6, 10]], [[8, 12.6], [7.5, 16.2], [8.3, 20.2]], [[12, 12.8], [12.4, 17], [11.8, 21]], [[16, 12.6], [16.5, 15.8], [15.8, 19.6]]],
  // a wastebasket: thrown away
  bin: [[[4.8, 7.8], [12, 7.4], [19.2, 7.9]], [[6.6, 8.4], [7.7, 20], [16.3, 20.2], [17.4, 8.2]], [[10.1, 11], [10.4, 17.2]], [[13.9, 11], [13.6, 17.2]], [[9.4, 7.2], [9.9, 4.5], [14.1, 4.3], [14.6, 7.2]]],
  // the waste-paper basket at the end of the Desk's stacks (desk.mjs): rim, body, a loose weave; full: a crumpled sheet over the rim
  basket: [[[3.6, 8.3], [8, 7.7], [12.2, 7.6], [16.4, 7.9], [20.4, 8.4]], [[4.9, 8.8], [5.9, 14.6], [7.1, 21.1], [12.1, 21.6], [16.9, 21], [18, 14.8], [19.2, 8.9]], [[8.7, 10.6], [9.3, 15.4], [9.9, 19.6]], [[12.2, 10.8], [12.1, 15.2], [12.3, 19.9]], [[15.6, 10.5], [15, 15.3], [14.4, 19.5]], [[6.4, 14.9], [9.6, 14.4], [13.2, 14.7], [17.6, 14.3]]],
  'basket-full': [[[3.6, 8.3], [8, 7.7], [12.2, 7.6], [16.4, 7.9], [20.4, 8.4]], [[4.9, 8.8], [5.9, 14.6], [7.1, 21.1], [12.1, 21.6], [16.9, 21], [18, 14.8], [19.2, 8.9]], [[8.7, 10.6], [9.3, 15.4], [9.9, 19.6]], [[12.2, 10.8], [12.1, 15.2], [12.3, 19.9]], [[15.6, 10.5], [15, 15.3], [14.4, 19.5]], [[6.4, 14.9], [9.6, 14.4], [13.2, 14.7], [17.6, 14.3]], [[8.6, 7.4], [7.8, 5.6], [8.9, 3.9], [10.9, 4.1], [12.4, 2.7], [14.8, 3.2], [15.9, 4.9], [15.2, 7.2]], [[10.1, 5.8], [11.6, 6.6], [12.7, 5.1], [13.9, 6.2]]],
  // other waste-paper baskets, proposed for the Desk's stacks (a decision card): a bucket with its lid ajar, a heap of
  // crumpled paper balls, a small shredder with its strips
  'bin-lid': [[[5.6, 10.8], [6.2, 16], [6.8, 21.1], [12, 21.4], [17.2, 21], [17.8, 16], [18.4, 10.8]], [[4.6, 10.6], [12, 10.2], [19.4, 10.6]], [[4.2, 8.4], [11.4, 5.6], [18.8, 3.4]], [[10.6, 6], [11.2, 4.4], [12.8, 4]], [[9.8, 13.4], [10, 16.4], [10.2, 19.2]], [[14.2, 13.4], [14, 16.4], [13.8, 19.2]], [[7.6, 10.2], [8.6, 8], [10.4, 8.6], [11.6, 7.4]]],
  'bin-balls': [[[7.4, 14.0], [9.7, 14.5], [11.6, 16.0], [11.1, 18.3], [9.9, 20.1], [7.8, 21.0], [5.7, 20.1], [3.9, 18.9], [3.4, 16.8], [4.3, 14.7], [6.8, 14.5], [8.9, 14.4]], [[16.4, 14.5], [19.0, 14.2], [20.5, 16.2], [19.7, 18.4], [19.5, 20.9], [16.8, 21.9], [14.3, 21.0], [12.5, 19.2], [12.9, 17.1], [14.0, 15.5], [15.6, 13.9], [17.8, 14.8]], [[11.9, 7.4], [14.0, 7.9], [15.0, 9.6], [15.7, 11.5], [14.4, 13.3], [12.3, 14.6], [9.9, 13.7], [8.1, 12.2], [8.0, 10.0], [8.9, 7.9], [11.2, 7.1], [13.4, 7.6]], [[5.6, 16], [7, 17.4], [6.6, 19], [8.6, 18.6]], [[14.6, 15.8], [16.4, 17], [15.6, 19.4], [18, 18.8]], [[10.4, 9], [11.4, 11.4], [12.6, 9.6], [13.4, 12]]],
  'bin-shredder': [[[4.2, 9.2], [12, 8.9], [19.8, 9.2], [19.9, 11.6], [19.8, 14.1], [12, 14.3], [4.2, 14.1], [4.1, 11.6], [4.2, 9.2]], [[6.4, 11.7], [12, 11.5], [17.6, 11.7]], [[8.2, 8.9], [8.1, 6], [8.2, 3.7], [8.3, 3.5], [12, 3.4], [15.7, 3.5], [15.8, 3.7], [15.9, 6], [16, 8.9]], [[9.8, 5.6], [14, 5.5]], [[9.8, 7.2], [12.6, 7.1]], [[7, 14.4], [7.4, 17.6], [6.8, 21]], [[10, 14.4], [10.3, 17.8], [10, 20.2]], [[13.2, 14.4], [12.8, 17.4], [13.3, 20.8]], [[16.6, 14.4], [16.9, 17], [16.5, 19.6]]],
  // a magnifier: search a stack's sheets (desk.mjs)
  search: [[[10.5, 4.2], [6.1, 5.7], [4.3, 10.3], [6.3, 14.7], [10.7, 16.3], [15, 14.5], [16.7, 10.1], [14.7, 5.6], [10.1, 4]], [[15.1, 15.2], [19.9, 19.9]]],
  // a paperclip, bent in one go: attach something
  // a link of a chain: two open loops and the bar between them (the Desk's Links pile, the Links page)
  link: [[[10.8, 10.6], [7.4, 14], [6.6, 16.8], [8.2, 18.6], [10.8, 18], [13.6, 15.2]], [[13.2, 13.4], [16.6, 10], [17.4, 7.2], [15.8, 5.4], [13.2, 6], [10.4, 8.8]], [[9.6, 14.4], [14.4, 9.6]]],
  clip: [[[15.8, 7.4], [9.6, 13.8], [8.6, 16.4], [10.2, 18.2], [12.8, 17.4], [18.8, 11.2], [19.6, 7.8], [17.4, 5.2], [14, 5.6], [6.6, 13.2], [5.2, 17.2], [7.2, 20.4], [11.2, 20.6], [17.2, 15]]],
  explain: [
    [[7.6, 9.6], [7.8, 6.4], [10.4, 4.2], [13.6, 4.4], [15.6, 6.8], [15, 9.6], [12.6, 11.6], [11.6, 13.4], [11.7, 15.6]],
    [[11.6, 19.2], [11.9, 19.7]],
    [[18.2, 3.6], [19.6, 2.2]], [[19.4, 7.4], [21.4, 7.2]], [[18.6, 11], [20.2, 12.2]],
  ],
  back: [[[12.1, 20.2], [11.8, 14], [12.2, 7.6]], [[6.6, 12.6], [12, 6.8], [17.5, 12.3]], [[4.6, 3.6], [12, 3.9], [19.5, 3.4]]],
  // a box with its lid on and a grip: put away
  archive: [
    [[3.4, 5.4], [20.6, 5.1], [20.8, 9], [3.3, 9.2], [3.5, 5]],
    [[5.2, 9.6], [5.4, 19.5], [18.8, 19.8], [19, 9.4]],
    [[9.4, 13.2], [12, 13.5], [14.8, 13.1]],
  ],
  // what a session published: a sheet with a folded corner, a picture, something to play
  page: [[[6.4, 3.6], [14.2, 3.4], [18.4, 7.8], [18.2, 20.4], [6.2, 20.6], [6.5, 3.2]], [[13.8, 3.8], [14, 8.2], [18, 8]], [[9.4, 12.2], [15, 12]], [[9.3, 15.8], [13.6, 16]]],
  picture: [[[3.8, 5.2], [20.4, 4.9], [20.6, 19], [3.6, 19.3], [3.9, 4.8]], [[5.2, 17], [9.6, 11.4], [12.6, 15], [15.2, 12.6], [19.2, 17.2]], [[15.4, 8.2], [16.4, 7.6], [16.9, 8.8], [15.8, 9.2]]],
  play: [[[3.8, 5.2], [20.4, 4.9], [20.6, 19], [3.6, 19.3], [3.9, 4.8]], [[9.8, 8.6], [15.4, 12.2], [9.9, 15.6], [9.7, 8.2]]],
  // a key: the administration opens with one of its own
  key: [[[8, 5.2], [11.6, 6.8], [12, 10.8], [8.6, 13], [5, 11.4], [4.6, 7.4], [8.3, 5]], [[11.2, 11.6], [15.4, 15.8], [19.8, 20.4]], [[15.6, 16.2], [18, 13.8]], [[18.2, 18.8], [20.6, 16.6]]],
  // scissors, open: each blade runs into its grip in one stroke, the grips are loops that do not close
  scissors: [
    [[21.4, 5.2], [16.6, 9.6], [11.4, 13.6], [8.6, 16.2], [5.6, 16], [3.8, 18.4], [5, 21], [7.8, 21.2], [9.2, 18.8], [8.2, 16.6]],
    [[21.8, 19.6], [16.4, 14.8], [11.6, 10.6], [8.8, 8], [5.8, 8.4], [3.6, 6.2], [4.6, 3.4], [7.6, 3], [9.2, 5.4], [8.4, 7.8]],
  ],
  // scissors again, for the web: the blades are two straight cuts, the grips two loops of their own
  snip: [
    [[21.4, 5.2], [9.6, 15]],
    [[21.6, 19.2], [9.6, 9]],
    [[9, 15.6], [6, 15.4], [3.8, 17.8], [4.8, 20.8], [7.8, 21.2], [9.6, 18.8], [8.6, 16]],
    [[9, 8.4], [6, 8.6], [3.8, 6.2], [4.8, 3.2], [7.8, 2.8], [9.6, 5.2], [8.6, 8]],
  ],
  // a pile that unfolds: one stroke pointing down
  unfold: [[[6.2, 9.2], [12, 15.4], [17.8, 8.8]]],
  // belongs under: a line down from above that turns right into an arrowhead (the main agent a session works for)
  under: [[[6.4, 4.4], [6.2, 11.4], [8.4, 15.4], [18.8, 15.8]], [[14.4, 11], [19.4, 15.8], [14.6, 20.4]]],
  // onward: an arrow to the right
  go: [[[4.4, 12.2], [11, 11.7], [19.2, 12.1]], [[14.2, 7], [19.6, 12], [14.4, 17.2]]],
  // the theme: a moon for the dark one, a sun for the light one
  moon: [[[15.6, 3.8], [9, 5.6], [5.4, 11.6], [7.2, 18], [13.4, 20.6], [19.6, 17.6], [14.4, 15.6], [11.6, 10.6], [13, 5.8], [15.9, 4.2]]],
  // Push on this device: a bell, its rim and its clapper.
  bell: [[[4.6, 17.4], [6.8, 14.6], [7.2, 8.8], [9.8, 5.1], [12, 4.2], [14.2, 5.1], [16.8, 8.8], [17.2, 14.6], [19.4, 17.4]], [[4.2, 17.6], [12, 17.4], [19.8, 17.7]], [[10.2, 19.6], [12, 21.1], [13.8, 19.6]]],
  sun: [
    [[12, 7.6], [15.6, 9], [16.4, 12.4], [14.6, 15.8], [11.4, 16.4], [8.2, 14.6], [7.6, 11.2], [9.6, 8.2], [12.4, 7.5]],
    [[12, 2.4], [12.1, 4.6]], [[12, 19.4], [11.9, 21.6]], [[2.4, 12], [4.6, 12.1]], [[19.4, 12], [21.6, 11.9]],
    [[5.2, 5.4], [6.6, 6.8]], [[17.4, 17.4], [18.8, 18.8]], [[5.4, 18.8], [6.8, 17.4]], [[17.4, 6.6], [18.8, 5.2]],
  ],
  // Focus: the four corners of a frame
  frame: [[[4, 9], [4.2, 4.2], [9, 4]], [[15, 4], [19.8, 4.2], [20, 9]], [[20, 15], [19.8, 19.8], [15, 20]], [[9, 20], [4.2, 19.8], [4, 15]]],
  // help: a plain question mark
  question: [[[7.8, 9.4], [8, 6.2], [10.6, 4], [13.8, 4.2], [15.8, 6.8], [15, 9.6], [12.6, 11.6], [11.8, 13.4], [11.9, 15.6]], [[11.8, 19.2], [12.1, 19.7]]],
  // the keys: one key cap with its mark
  keycap: [[[5, 6], [12, 5.6], [19, 5.8], [19.4, 12], [19.2, 18.4], [12, 18.8], [4.8, 18.6], [4.6, 12], [5, 5.5]], [[8.6, 12.6], [12, 11.8], [15.4, 12.5]]],
  // the bar's two places: a tray for the inbox, two heads for the agents
  tray: [[[4.2, 13], [5.4, 9], [7, 5.6], [12, 5.3], [17, 5.5], [18.6, 9], [19.8, 13]], [[4, 13.2], [4.1, 16.4], [4.4, 19.4], [12, 19.7], [19.6, 19.5], [19.9, 16.4], [20, 13.2]], [[4.4, 13.2], [8.8, 13], [10, 15.8], [14, 15.8], [15.2, 13], [19.6, 13.2]]],
  heads: [
    [[9, 4.8], [11.6, 6.2], [11.8, 9.2], [9.2, 10.8], [6.6, 9.4], [6.4, 6.4], [9.3, 4.7]],
    [[3.4, 19.4], [5, 15.2], [9, 13.6], [13, 15.2], [14.6, 19.6]],
    [[15.4, 6], [17.8, 7.8], [17.2, 10.4], [15.2, 11]],
    [[16.6, 14], [19.4, 15.6], [20.6, 19.4]],
  ],
  // knuckles on a door: a fist seen from the side, and the two short strokes of its knock
  knock: [
    [[6.2, 10.4], [7.6, 7], [11, 6.2], [15, 6.6], [17.4, 9], [17.8, 13.4], [16, 17.2], [11.4, 18], [7.4, 16.6], [5.8, 13.4], [6.3, 10]],
    [[10, 6.8], [10.3, 10.6]], [[13.4, 6.6], [13.5, 10.8]],
    [[19.6, 6], [21.6, 4.2]], [[20.6, 10.2], [22.8, 9.6]],
  ],
  // a sun coming up over a line: wake a snoozed question
  wake: [[[6.2, 16.2], [7.6, 11.6], [12, 9.4], [16.4, 11.4], [17.8, 16.2]], [[3, 16.6], [12, 16.2], [21, 16.5]], [[12, 3.6], [12.1, 6.2]], [[5.4, 7.2], [7.2, 9]], [[18.6, 7], [16.9, 8.8]]],
  // a tick, made in one move: read, fine
  tick: [[[4.6, 12.8], [7.4, 15.2], [9.8, 18], [13, 12.4], [19.6, 5.6]]],
  // a session's link: an ear (it hears), the ear and three dots (it hears on its next step), the ear struck through
  // (it cannot hear), a plug pulled from its socket (it is gone), a letter (an answer on its way)
  ear: [EAR_RIM, EAR_FOLD],
  'ear-later': [EAR_RIM.map(([x, y]) => [x - 2.4, y - .6]), EAR_FOLD.map(([x, y]) => [x - 2.4, y - .6]), [[15.4, 19.2], [15.9, 19.3]], [[18.2, 19.2], [18.7, 19.3]], [[21, 19.2], [21.5, 19.3]]],
  'ear-off': [EAR_RIM, EAR_FOLD, [[4.4, 20], [12.2, 12.2], [19.8, 4.2]]],
  plug: [[[1.8, 12.2], [5.8, 12]], [[6, 8.4], [10.6, 8.2], [10.8, 15.8], [6, 15.6], [6.1, 8.6]], [[10.9, 10.2], [13.4, 10.1]], [[10.9, 14], [13.4, 13.9]], [[21.8, 8.2], [17.6, 8.4], [17.4, 15.8], [21.8, 15.6]]],
  letter: [[[4.2, 7.2], [19.8, 7], [20, 17.6], [4.2, 17.8], [4.3, 7.4]], [[4.6, 7.8], [12, 13.4], [19.6, 7.6]]],
  // a small stack of cards: there are questions here
  stack: [[[4.6, 11], [12, 10.6], [19.4, 11], [19.7, 15.4], [19.4, 19.8], [12, 20.1], [4.6, 19.8], [4.3, 15.4], [4.7, 10.7]], [[5.8, 10.4], [6.6, 7.4], [12, 7], [17.4, 7.4], [18.2, 10.4]], [[7.6, 6.8], [8.6, 4.2], [12, 3.9], [15.4, 4.2], [16.4, 6.8]], [[8.6, 15.4], [12, 15.2], [15.4, 15.5]]],
  // a speech bubble with its tail: write to someone
  bubble: [[[4.4, 8.6], [6, 6.4], [12, 6], [18.2, 6.4], [19.8, 8.8], [19.6, 14.6], [17.8, 16.8], [11.6, 17], [8.4, 20.6], [8.2, 17], [5.8, 16.6], [4.3, 14.4], [4.5, 8.2]]],
  // a desk with its lamp: the top, two legs, the lamp's foot, its arm with a knee, the shade bent over the top
  desk: [[[2.4, 12.6], [12, 12.2], [21.6, 12.6]], [[4.6, 12.9], [4.9, 17], [4.6, 20.8]], [[19.4, 12.9], [19.1, 17], [19.4, 20.8]], [[15.4, 12], [17.4, 12.1], [19.4, 12]], [[17.4, 11.8], [19.6, 7.6], [19.9, 7.2], [19.4, 6.8], [14.6, 4.2]], [[14.8, 2.6], [11.4, 3.4], [9.4, 5.6], [8.8, 7.6], [9.2, 8], [15.4, 6.2], [15.8, 5.8], [15.4, 3.4], [14.6, 2.5]]],
  // a shrug: a small figure, shoulders up, both arms out, palms up
  shrug: [[[12, 3], [14.2, 4], [14.4, 6.4], [12.2, 7.6], [9.8, 6.6], [9.6, 4.2], [11.8, 3]], [[12, 9.8], [8.8, 9.2], [6.2, 11.6], [3.8, 9.4]], [[2, 8.8], [5.2, 8.2]], [[12, 9.8], [15.2, 9.2], [17.8, 11.6], [20.2, 9.4]], [[18.8, 8.2], [22, 8.8]], [[12, 9.8], [12.2, 15.6]], [[12.2, 15.6], [9.6, 21.2]], [[12.2, 15.6], [14.8, 21.2]]],
  // a table: a sheet ruled into cells
  grid: [[[4, 5.6], [12, 5.3], [20, 5.6], [20.2, 12], [20, 18.6], [12, 18.8], [4.2, 18.5], [3.9, 12], [4.1, 5.3]], [[4.4, 10], [19.8, 10.2]], [[10, 5.8], [10.2, 18.4]]],
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

// Snooze: three z on one line, small, medium, large (the user's choice, card Nr. 177). Unlike the pen strokes above
// each z is one heavy line with round ends and sharp corners, of a width of its own: [path, line width]. No wobble,
// no tilt. sketch('snooze') draws these; SKETCH.snooze above is the earlier pen drawing, kept for the iOS port.
const SNOOZE_Z = [
  ['M2 12.2 L5.5 12 L2.1 16.5 L5.7 16.3', 2],
  ['M8.4 10.7 L12.9 10.4 L8.5 16.5 L13.1 16.2', 2.3],
  ['M16.2 8.8 L22 8.5 L16.3 16.5 L22.2 16.2', 2.6],
]

// Whatever: a duck in sunglasses, afloat (the user's choice, card Nr. 176 "bust"); the button shows it alone, the
// words come as its tooltip. Box 48 x 40 (not 24 x 24): size it 1.2 : 1. Parts are [kind, path]: line a pen line around
// a shape filled with the surface, open a pen line, thin a finer line, bill a light wash, ink filled with the pen
// (the lenses), glint a stroke in the surface colour on a lens. The head is drawn at its own scale (DUCK_HEAD_AT).
// pen.js sketchSvg('duck') draws it.
const DUCK_BODY = [
  ['line', 'M11 25 C4.6 27 2.4 32.6 5.4 37.2 C9 40.6 34 40.6 37.6 37.2 C40.6 32.6 38.6 27.4 32.6 25.6'],
  ['open', 'M10 31.4 C13.6 35.6 20 35.6 23.6 32'],
  ['water', 'M0.4 38.8 C1.8 38 3 39.2 4.4 38.6'],
  ['water', 'M39 38.6 C40.8 37.6 42.6 39.4 44.4 38.6 C45.6 38 46.6 38.6 47.6 38.4'],
]
const DUCK_HEAD_AT = 'translate(6.4 -1.2) scale(.78)'
const DUCK_HEAD = [
  ['line', 'M19.6 3.4 C28 3.4 33.6 9.4 33.6 18 C33.6 27 27.6 33.4 19.6 33.4 C11.6 33.4 5.6 27 5.6 18 C5.6 9.4 11.2 3.4 19.6 3.4 Z'],
  ['open', 'M18.6 3.4 C17.2 1.2 18.8 -0.2 20.8 0.6'],
  ['open', 'M21.4 3.5 C21.2 1.8 22.6 1 24 1.8'],
  ['bill', 'M29.6 20.6 C36 19.4 44.6 21.2 46.6 24.4 C45.4 28.2 36.6 29.8 29.4 28.6 Z'],
  ['thin', 'M30.6 24.8 C35.6 25.8 41.6 25.6 46.2 24.6'],
  ['ink', 'M7.6 10.4 h14 v4.03 c0 3.84 -3.08 5.57 -7 5.57 c-4.2 0 -7 -1.92 -7 -5.57 z'],
  ['glint', 'M10.68 12.7 l2.24 3.07'],
  ['ink', 'M24.4 10.4 h14 v4.03 c0 3.84 -3.08 5.57 -7 5.57 c-4.2 0 -7 -1.92 -7 -5.57 z'],
  ['glint', 'M27.48 12.7 l2.24 3.07'],
  ['ink', 'M21 10.4 h4 v2.4 h-4 z'],
  ['open', 'M7.6 11.4 L3.6 10.2'],
]

// What??: the word written by hand (card Nr. 206), plain strokes in a 68 x 24 box; pen.js sketchSvg('what') draws it.
const WHAT = [
  ['open', 'M2.2 5.4 C3.2 10.4 4.2 15.6 5.6 20.6 C7 17 8.2 13.4 9.4 10.2 C10.6 13.6 11.6 17.2 12.8 20.6 C14.4 15.4 15.6 10.4 16.6 5.2'],
  ['open', 'M19.8 3.8 C19.6 9.6 19.6 15.4 19.6 20.8'],
  ['open', 'M19.8 15 C20.8 12 25 10.8 26 14 C26.4 16.2 26.2 18.6 26.4 20.8'],
  ['open', 'M35.4 13.4 C34.2 11 29.8 11 28.8 15 C28 19.2 31 21.8 34 19.8 C35.4 18.6 35.6 15.6 35.6 12.2 C35.6 15.6 35.6 18.8 36.8 21'],
  ['open', 'M40.4 6 C40.2 10.6 40.2 15.6 40.8 18.8 C41.2 20.8 43 21.2 44.4 20.2'],
  ['open', 'M37.8 11.6 C39.8 11.6 41.8 11.4 43.8 11.2'],
  ['open', 'M47.6 8.2 C47.6 4.6 50.8 3 53.2 4.2 C55.6 5.6 55.2 8.8 52.8 10.4 C51.2 11.4 50.6 13 50.7 15.4'],
  ['open', 'M50.7 19.8 L50.9 20.4'],
  ['open', 'M57.4 7.4 C57.8 3.8 61 2.4 63.4 3.8 C65.6 5.2 65 8.6 62.6 10.2 C61 11.4 60.4 13 60.5 15.6'],
  ['open', 'M60.5 20 L60.7 20.6'],
]


const HAND = [
  [8.9, 22.6], [8.2, 18.4], [5.4, 15.2], [4.3, 12.5], [5.9, 12.1], [8.3, 14.6],
  [8.2, 8.2], [8.9, 6.3], [10.2, 8], [10.5, 12.6],
  [10.7, 6.3], [11.8, 4.5], [12.9, 6.4], [13, 12.5],
  [13.5, 7.4], [14.7, 6], [15.6, 7.8], [15.5, 13],
  [16.3, 10], [17.6, 9.2], [18.3, 10.9], [17.7, 15.6], [16.6, 19.8], [16.9, 23.2],
]

const POINTING_HAND = [
  [[2.6, 7.6], [8.8, 7.4], [11.6, 4.6], [14.4, 4], [15, 6], [13.4, 8.4], [19, 8.6], [27.4, 8.8], [29.6, 10.4], [27.6, 12.2], [20.4, 12.3], [17.6, 12.5]],
  [[17.4, 12.6], [20, 13.2], [20.4, 15.2], [17.6, 15.9], [19.4, 16.6], [19.2, 18.6], [16.8, 19], [17.6, 20], [16.6, 21.6], [13.6, 21.6], [8.6, 21], [2.4, 20.6]],
  [[5.4, 6], [5.9, 13.6], [5.5, 22.4]],
]

function loopPath(r, { rad = 14.9, drift = 1.1, jitter = .9, start = 3.6 } = {}) {
  const steps = 17
  return penPath(Array.from({ length: steps }, (_, i) => {
    const a = start + (i / (steps - 2)) * Math.PI * 2, at = rad - (i / steps) * drift + (r() - .5) * jitter
    return [16 + Math.cos(a) * at, 16 + Math.sin(a) * at * .97]
  }))
}
// pen-tables:end

// ---- strings -------------------------------------------------------------------

const svg = (box, cls, inner, more = '') => `<svg viewBox="${box}"${cls ? ` class="${cls}"` : ''} aria-hidden="true"${more}>${inner}</svg>`
const paths = list => list.map(d => `<path d="${d}"/>`).join('')
const kept = new Map()
const once = (key, make) => { let v = kept.get(key); if (v == null) { v = make(); kept.set(key, v) } return v }

// The duck's parts as paths. Widths are in screen pixels (non-scaling), so the duck draws as heavy at 24 px as at 50.
// A host may colour it: --surface is its body, --duck-bill its bill, --duck-glint the glint on its glasses,
// --duck-water the two wave lines it swims on (card.css, the duck's button).
const SURFACE = 'var(--surface, #fff)'
const DUCK_STYLE = {
  line: `fill:${SURFACE}`,
  open: '',
  thin: 'stroke-width:1.1px',
  water: 'stroke:var(--duck-water, currentColor);stroke-width:1.1px',
  bill: `fill:var(--duck-bill, color-mix(in srgb, currentColor 22%, ${SURFACE}));stroke-width:1.3px`,
  ink: 'fill:currentColor;stroke-width:1px',
  glint: `stroke:var(--duck-glint, ${SURFACE});stroke-width:1.4px`,
}
const duckParts = parts => parts.map(([kind, d]) => `<path d="${d}" vector-effect="non-scaling-stroke"${DUCK_STYLE[kind] ? ` style="${DUCK_STYLE[kind]}"` : ''}/>`).join('')

/** An icon drawn like the session marks (ui.js sketch). cls: extra classes. */
export function sketchSvg(name, cls = '') {
  return once(`sketch:${name}:${cls}`, () => {
    // the three heavy z (ui.js sketch): own widths, no wobble, no tilt
    if (name === 'snooze') return svg('0 0 24 24', `sketch${cls ? ` ${cls}` : ''}`, SNOOZE_Z.map(([d, width]) => `<path d="${d}" stroke-width="${width}"/>`).join(''))
    // the duck in sunglasses (Whatever): box 48 x 40, filled lenses, a glint; lines keep the width CSS gives .sketch
    if (name === 'duck') return svg('0 0 48 40', `sketch sketch-duck${cls ? ` ${cls}` : ''}`, `${duckParts(DUCK_BODY)}<g transform="${DUCK_HEAD_AT}">${duckParts(DUCK_HEAD)}</g>`)
    // What??: the word written by hand (card Nr. 206), plain strokes, box 68 x 24
    if (name === 'what') return svg('0 0 68 24', `sketch sketch-what${cls ? ` ${cls}` : ''}`, duckParts(WHAT))
    const r = seeded(`sketch:${name}`)
    const turn = ((r() - .5) * 9).toFixed(1)
    const ds = (SKETCH[name] ?? []).map(stroke => penPath(stroke.map(([x, y]) => [x + (r() - .5) * .7, y + (r() - .5) * .7])))
    return svg('0 0 24 24', `sketch${cls ? ` ${cls}` : ''}`, paths(ds), ` style="rotate:${turn}deg"`)
  })
}

/** A session's scribbled mark (ui.js doodle). id: a seed, or "draw:<name>". */
export function doodleSvg(id) {
  return once(`doodle:${id}`, () => {
    const r = seeded(id)
    const name = /^draw:(.+)$/.exec(String(id))?.[1]
    const ds = KINDS.includes(name) ? DOODLES[KINDS.indexOf(name)](r)
      : NAMED[name] ? NAMED[name].map(stroke => (stroke.straight ? linePath : penPath)(stroke.map(([x, y]) => [x + (r() - .5) * 1.1, y + (r() - .5) * 1.1])))
      : DOODLES[Math.floor(r() * DOODLES.length)](r)
    return svg('0 0 32 32', 'doodle', paths(ds), ` style="rotate:${Math.round((r() - .5) * 16)}deg"`)
  })
}

/** The crown of a main session (ui.js crown). */
export const crownSvg = () => svg('0 0 26 19', 'crown-mark', crownInner())
/** The three parts of the crown (wash, pen line, stones), as ui.js crownParts() builds them; for a mark that draws its own svg. */
const crownInner = () => `<path class="crown-wash" d="${CROWN_WASH}"/><path class="crown-pen" d="${CROWN}"/>${CROWN_JEWELS.map(([x, y, r]) => `<circle class="crown-jewel" cx="${x}" cy="${y}" r="${r}"/>`).join('')}`

/** The raised hand in its loop: a session that waits for the human (ui.js raisedHand). */
export function handSvg() {
  return once('hand', () => {
    const r = seeded('raised hand')
    const loop = loopPath(r)
    const hand = penPath(HAND.map(([x, y]) => [x + 2.9 + (r() - .5) * .8, y + 1.9 + (r() - .5) * .8]))
    return svg('0 0 32 32', 'hand-mark', `<path class="hand-loop" d="${loop}"/><path class="hand-pen" d="${hand}"/>`)
  })
}


// The working ring (agents.js ring): a loop circled by hand and, while the session works, a tapering stroke that goes round it.
const RING_TURN = 1900
const RING_STROKE = [[30, 1.15, .45], [19, 1.75, .8], [8, 2.3, 1]]
const ringWay = () => once('ring-way', () => {
  const r = seeded('working way'), phase = [r() * 6, r() * 6], n = 28
  const pts = Array.from({ length: n }, (_, i) => {
    const t = -Math.PI / 2 + i / n * Math.PI * 2
    const rad = 13.5 + .32 * Math.sin(2 * t + phase[0]) + .22 * Math.sin(3 * t + phase[1])
    return [16 + Math.cos(t) * rad, 16 + Math.sin(t) * rad * .975]
  })
  const mid = (a, b) => `${((a[0] + b[0]) / 2).toFixed(2)} ${((a[1] + b[1]) / 2).toFixed(2)}`
  return `M${mid(pts[n - 1], pts[0])}` + pts.map((p, i) => ` Q${p[0].toFixed(2)} ${p[1].toFixed(2)} ${mid(p, pts[(i + 1) % n])}`).join('') + ' Z'
})
/** loop: draw the ring itself; drop: the stroke that travels (the session is at work). */
export function ringSvg({ loop = true, drop = false, cls = '' } = {}) {
  return once(`ring:${loop}:${drop}:${cls}`, () => {
    const ring = loop ? `<path class="ring-loop" d="${loopPath(seeded('working ring'), { rad: 13.6, drift: .5, jitter: .6, start: 1.1 })}" pathLength="100"/>` : ''
    const way = drop ? `<g class="ring-drop">${RING_STROKE.map(([len, width, opacity]) => `<path d="${ringWay()}" pathLength="100" stroke-dasharray="${len} ${100 - len}" stroke-dashoffset="${len}" stroke-width="${width}" opacity="${opacity}"/>`).join('')}</g>` : ''
    return svg('0 0 32 32', `agent-ring${cls ? ` ${cls}` : ''}`, ring + way, ` style="--ring-turn:${RING_TURN}ms"`)
  })
}

// ---- colours -------------------------------------------------------------------

const HUES = [162, 28, 262, 205, 338, 96, 48, 232]
function hueOf(id) {
  let h = 0
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return HUES[h % HUES.length]
}
/** The colour of a session's mark (agents.js hueFor). agent: { id, mark }. */
export const hueFor = agent => drawingHue(drawingOf(agent.mark)) ?? hueOf(agent.id)

// ---- a sub's card edge in a folded main's stack (agents.js edgeQuirk) ----
function penLine(pts) {
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i], [nx, ny] = pts[i + 1]
    d += ` Q ${x.toFixed(1)} ${y.toFixed(1)} ${((x + nx) / 2).toFixed(1)} ${((y + ny) / 2).toFixed(1)}`
  }
  const last = pts.at(-1)
  return `${d} L ${last[0].toFixed(1)} ${last[1].toFixed(1)}`
}
/** { tilt, dx, svg } for the session with this id. */
export function edgeQuirk(id) {
  return once(`edge:${id}`, () => {
    const r = seeded(`edge:${id}`), j = s => (r() - .5) * 2 * s
    const tilt = j(.75).toFixed(2), dx = j(2.2).toFixed(1), sag = j(.55), l = j(.5), rr = j(.5), ya = 12.9 + j(.6), yb = 12.9 + j(.6), xa = 30 + j(8), xb = 68 + j(8), sl = j(1), sr = j(1)
    const line = (c, k) => penLine([[l * k, -2], [-l * k, 6 + sl], [c * .1, 11.3 + l * .6], [c, 12.9 + sag * .4], [xa, ya], [xb, yb], [100 - c, 12.9 - sag * .4], [100 - c * .1, 11.3 + rr * .6], [100 - rr * k, 6 + sr], [100 + rr * k, -2]])
    return { tilt, dx, svg: `<svg viewBox="0 0 100 15" preserveAspectRatio="none" aria-hidden="true"><path class="e-w" d="${line(4.5, .5)}"/><path class="e-n" d="${line(15, 1.6)}"/></svg>` }
  })
}

// ---- small drawings of the Desk ----



/** The pointing hand beside the paragraph an agent marks with "☞" (ui.js pointingHand). */
function pointingHandSvg() {
  return once('pointing', () => {
    const r = seeded('advice hand')
    const strokes = POINTING_HAND.map(stroke => penPath(stroke.map(([x, y]) => [x + (r() - .5) * .5, y + (r() - .5) * .5])))
    return `<svg viewBox="0 2 32 22" class="advice-hand" aria-hidden="true">${['advice-hand-paper', 'advice-hand-ink'].map(cls => strokes.map(d => `<path class="${cls}" d="${d}"/>`).join('')).join('')}</svg>`
  })
}

/** An arrow drawn with the pen through the given points (ui.js arrowStrokes): the d of line, barb, barb. */
export function arrowStrokes(points, seed) {
  const r = seeded(`arrow:${seed}`)
  const last = points.length - 1
  const line = points.map(([x, y], i) => (i === 0 || i === last ? [x, y] : [x + (r() - .5) * 2.4, y + (r() - .5) * 2.4]))
  const [a, b] = points.slice(-2), dir = Math.atan2(b[1] - a[1], b[0] - a[0])
  const barb = turn => [b[0] - Math.cos(dir + turn) * 9.5 + (r() - .5) * 1.4, b[1] - Math.sin(dir + turn) * 9.5 + (r() - .5) * 1.4]
  return [penPath(line), penPath([barb(.5), [b[0] + .3, b[1]], b]), penPath([barb(-.5), b, b])]
}


// For ui.js (sketch and adviceLoop draw with the same hand and tables).

/** A media query that also stands when the module is imported outside a page (the connector's tests). */
/** The theme: 'light', 'dark' or 'system' (follows the OS; the default). Kept in localStorage 'agent-board-theme'; the page's
 *  head sets it before the first paint (index.html), this keeps it and follows the OS while it is 'system'. */
export function themeMode() { try { return localStorage.getItem('agent-board-theme') || 'system' } catch { return 'system' } }
export function setThemeMode(mode) {
  const root = document.documentElement, dark = mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  root.dataset.themeMode = mode
  if (dark) root.dataset.theme = 'dark'; else delete root.dataset.theme
  try { if (mode === 'system') localStorage.removeItem('agent-board-theme'); else localStorage.setItem('agent-board-theme', mode) } catch {}
}
/** The next in the round Light → Dark → System. */
export const nextThemeMode = () => ({ light: 'dark', dark: 'system', system: 'light' })[themeMode()] ?? 'system'
globalThis.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (themeMode() === 'system') setThemeMode('system') })
export const mq = q => globalThis.matchMedia?.(q) ?? { matches: false, addEventListener() {}, removeEventListener() {} }
/** Under prefers-reduced-motion nothing moves by itself. */
export const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches
/** A pen drawing as markup. */
export const sk = (name, cls) => raw(sketchSvg(name, cls))

// ---- text ----
// Words and small rules the views share: what a card says in one line, how a label fits a tile, the light
// markdown agents write as safe HTML. The rules are those of the old client (ui.mjs, js/inbox.js); the
// output is strings made with html`` (html.mjs), so every piece of board content is escaped.

// ---- the board's words (one place; the old client has them in ui.mjs) ----
export const WORDS = {
  later: 'Later', duck: 'Duck it', wake: 'Wake up', ack: 'Got it', what: 'What??', trust: 'I don’t give a duck', revise: 'Reverse',
  revising: 'In revision', shred: 'Shred', walk: 'Blitz', desk: 'Desk', takeBack: 'Take back',
}
export const EXPLAIN_TEXT = 'Explain this question in more detail and in plain words: what it is about, what each option means for me, and what you would do.'

export const isKnock = card => card.kind === 'permission' || card.urgency === 'high' || card.urgency === 'critical'
export const knockWord = card => (card.kind === 'permission' ? 'Knock! Permission' : card.urgency === 'critical' ? 'Knock! Blocking' : card.urgency === 'high' ? 'Knock' : null)
export const cardNr = card => `Nr. ${card.number}`
export const cardNote = card => [card.merged_from?.length ? `replaces ${card.merged_from.length} questions` : '', card.revised ? 'revised' : ''].filter(Boolean).join(' · ')
export const kindOf = a => a.kind ?? (a.image ? 'image' : 'file')
export const advisedKeys = card => [].concat(card.recommended ?? [])
// A final option (the agent marked it: choosing it leaves nothing to do) ends the card with the answer. Its tile says
// so before he chooses: a small pen tick, on a card's own page with two words beside it.
export const FINAL_TIP = 'Settles it: nothing follows from this answer, the card goes straight to Done'
export const SETTLED = 'Settled by your answer'
export const finalSign = (words = false) => html`<span class="final-sign" title="${FINAL_TIP}">${sk('tick')}${words ? html`<span>settles it</span>` : ''}</span>`
export const advisedLabels = card => card.options.filter(o => advisedKeys(card).includes(o.key)).map(o => o.label).join(', ')

function ago(ts, now = Date.now()) {
  const min = Math.round((now - ts) / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  if (min < 1440) return `${Math.round(min / 60)} h ago`
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}
/** A time that keeps itself current in the page (ui.mjs rewrites every [data-ts] each 30 s). */
export const agoSpan = (ts, cls = 'ago') => html`<span class="${cls}" data-ts="${ts}">${ago(ts)}</span>`

// ---- links ----
const ASSET_URL = /^(https?:\/\/[^\/\s]+)?\/a\/([A-Za-z0-9_-]{16,64})#([A-Za-z0-9_-]{43})$/
const ASSET_LABEL = { html: 'Page', image: 'Picture', video: 'Video', audio: 'Audio', file: 'File' }
/** What a URL points at: one of the board's published assets ({ asset }) or anything else ({ text }, short). */
function linkInfo(url, assets = []) {
  const m = ASSET_URL.exec(url)
  if (m) {
    const record = assets.find(a => a.id === m[2])
    if (record || !m[1]) return { asset: { id: m[2], href: `/a/${m[2]}#${m[3]}`, title: record?.title || '', type: record?.type ?? null } }
  }
  let text = url.replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/$/, '')
  if (text.length > 34) text = `${text.slice(0, 33)}…`
  return { text }
}
const HTML_FENCE = /```html[^\n]*\n[\s\S]*?```/gi
const ROW = /^\s*\|.*\|\s*$/, RULE = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/
const withoutLayouts = text => {
  const lines = String(text ?? '').replace(HTML_FENCE, ' ').split('\n')
  return lines.filter((l, i) => !(ROW.test(l) || (l.includes('-') && RULE.test(l) && (lines[i - 1] ?? '').includes('|')))).join('\n')
}
const tidyLinks = (text, assets) => withoutLayouts(text).replace(/`?(https?:\/\/[^\s<>)`]+)`?/g, (_, url) => {
  const info = linkInfo(url, assets)
  return info.asset ? `[${info.asset.title || (ASSET_LABEL[info.asset.type] ?? 'published link')}]` : info.text
})
/** A text as one line of plain words: no fences, no markup signs, links as what they are. */
export const plain = (text, assets) => tidyLinks(String(text ?? '').replace(/```[\s\S]*?```/g, ' '), assets).replace(/(?<![\w.])__(?=\S)([^_\n]+?)__/g, '$1').replace(/[*`#]/g, '').replace(/\s+/g, ' ').trim()

// ---- tiles: how the labels of a two-way question stand under the thumbs (inbox.js) ----
const fits = (label, width, lines) => {
  let n = 1, used = 0
  for (const word of String(label).trim().replace(/-(?=\S)/g, '- ').split(/\s+/)) {
    if (word.length > width) return false
    if (used && used + 1 + word.length > width) { n++; used = word.length } else used += (used ? 1 : 0) + word.length
  }
  return n <= lines
}
const fitsTile = label => fits(label, 14, 2)
const labelSize = options => (options.every(o => fitsTile(o.label)) ? 'usual' : options.every(o => fits(o.label, 17, 3)) ? 'small' : 'none')
const BARE = /^(yes|no|ok|okay|allow|deny|ja|nein)$/i
const shortOf = o => { const s = String(o.short ?? '').trim(); return s.length <= 18 ? s : '' }
const quick = card => !card.multiple && (card.kind === 'permission' || card.options.length === 2)

// ---- what a card carries besides its words ----
const many = (n, one, more = `${one}s`) => (n === 1 ? `1 ${one}` : `${n} ${more}`)
function richMark(card) {
  const sections = card?.sections ?? []
  const texts = [card?.body, ...sections.map(s => s?.text)].filter(Boolean).join('\n\n')
  const blocks = [...(texts.match(HTML_FENCE) ?? []), card?.html, ...sections.map(s => s?.html)].filter(Boolean)
  if (blocks.some(b => !/<table\b/i.test(b))) return 'layout'
  if (blocks.length) return 'table'
  const lines = texts.replace(/```[\s\S]*?```/g, '').split('\n')
  return lines.some((l, i) => ROW.test(l) && RULE.test(lines[i + 1] ?? '') && (lines[i + 1] ?? '').includes('-')) ? 'table' : null
}
function carries(card, assets = []) {
  const list = card.attachments ?? [], count = kind => list.filter(a => kindOf(a) === kind).length
  const body = String(card.body ?? '').replace(/```[\s\S]*?```/g, '')
  const pages = new Set((body.match(/https?:\/\/[^\s<>)`]+|(?<=`)\/a\/[^\s`]+/g) ?? []).map(u => linkInfo(u.replace(/[.,;:!?]+$/, ''), assets).asset?.id).filter(Boolean)).size
  const table = richMark(card)
  return [
    count('image') && { icon: 'picture', text: many(count('image'), 'picture') },
    count('video') && { icon: 'play', text: many(count('video'), 'video') },
    count('audio') && { icon: 'play', text: many(count('audio'), 'recording') },
    count('file') && { icon: 'page', text: many(count('file'), 'file') },
    pages && { icon: 'page', text: many(pages, 'page') },
    table && { icon: 'grid', text: table === 'layout' ? 'a layout' : 'a table' },
  ].filter(Boolean)
}

// ---- the light markdown agents write (ui.js rich), as safe HTML ----
// Paragraphs, bullet lists, **bold**, `code`, fenced code, tables, bare links, paths to pages of this board,
// __underlined__ words. A block fenced as html is the agent's own layout: it is NOT put into the page. It
// stands as an inert holder with its source in a data attribute, and the controller "richhtml" shows it in the
// sandboxed frame of ui.mjs, exactly as the old client does.
const UNDER = /(?<![\w.])__(?=\S)([^_\n]+?)(?<=\S)__(?=$|[\s,;:!?)\]]|\.(?:\s|$))/gm
const INLINE = /(\[[^\]\n]+\]\((?:https?:\/\/[^\s)]+|\/[^\s)]*)\))|(?<![\w*])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?![\w*])|(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(https?:\/\/[^\s<>)]+)|((?<![\w.])__(?=\S)[^_\n]+?(?<=\S)__(?=$|[\s,;:!?)\]]|\.(?:\s|$)))|((?<![\w\/:.~\-])\/(?:[\w\-.]+\/)*[\w\-.]+\.html?(?:\?[\w\-.=&%+]*)?(?:#[\w\-.=&%+]*)?)/gm
const pathLink = path => html`<a href="${path}" target="_blank" rel="noopener">${path}</a>`
function linkTo(url, ctx) {
  const info = linkInfo(url, ctx.assets)
  if (info.asset) return html`<a class="asset-link" href="${info.asset.href}" target="_blank" rel="noopener">${info.asset.title || (ASSET_LABEL[info.asset.type] ?? 'Published link')}</a>`
  return html`<a href="${url}" target="_blank" rel="noopener noreferrer" title="${url}">${info.text}</a>`
}
function inline(text, ctx) {
  const out = []
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    out.push(text.slice(last, m.index))
    const [, md, em, code, bold, url, under, path] = m
    if (md) {
      // [label](target): the label is the link's words; a published asset keeps its chip, with the label as its title.
      const [, label, target] = /^\[([^\]]+)\]\((.+)\)$/.exec(md)
      const info = /^https?:/.test(target) ? linkInfo(target, ctx.assets) : null
      if (info?.asset) out.push(html`<a class="asset-link" href="${info.asset.href}" target="_blank" rel="noopener">${label}</a>`)
      else out.push(html`<a href="${target}" target="_blank" rel="noopener${/^https?:/.test(target) ? ' noreferrer' : ''}" title="${target}">${label}</a>`)
    }
    else if (em) out.push(html`<em>${inline(em, ctx)}</em>`)
    else if (code && /^`https?:\/\/[^\s`]+`$/.test(code)) out.push(linkTo(code.slice(1, -1), ctx))
    else if (code && /^`\/[\w\-./#?=&%+]+\.html?([#?][^\s`]*)?`$/.test(code)) out.push(pathLink(code.slice(1, -1)))
    else if (path) { const p = path.replace(/[.,;:!?]+$/, ''); out.push(pathLink(p), path.slice(p.length)) }
    else if (code) out.push(html`<code>${code.slice(1, -1)}</code>`)
    else if (bold) out.push(html`<strong>${inline(bold.slice(2, -2), ctx)}</strong>`)
    else if (under) out.push(ctx.underlining ? html`<span class="rich-under">${inline(under.slice(2, -2), ctx)}</span>` : inline(under.slice(2, -2), ctx))
    else { const u = url.replace(/[.,;:!?]+$/, ''); out.push(linkTo(u, ctx), url.slice(u.length)) }
    last = m.index + m[0].length
  }
  out.push(text.slice(last))
  return html`${out}`
}
/** text: what the agent wrote. extra: an html field that belongs under it (card.html, section.html). */
export function rich(text, { assets = [], extra = '', hand = true } = {}) {
  const source = `${String(text ?? '')}${extra ? `\n\n\`\`\`html\n${extra}\n\`\`\`` : ''}`
  const prose = source.replace(/```[\s\S]*?```/g, '')
  const under = [...prose.matchAll(UNDER)].reduce((n, m) => n + m[1].length, 0)
  // hand: false in a conversation (the comments under a card): sober there, no drawn hand.
  const ctx = { assets, hand, underlining: under * 3 <= prose.replace(/\s+/g, ' ').length }
  const langs = [...source.matchAll(/```([^\n]*)\n?/g)].map(m => m[1].trim().toLowerCase())
  const blocks = []
  source.split(/```[^\n]*\n?/).forEach((chunk, i) => {
    if (i % 2) {
      if (langs[i - 1] === 'html') return blocks.push(html`<div class="rich-html" data-controller="richhtml" data-richhtml-source-value="${chunk}"><noscript>A layout from the agent; it needs scripts to show.</noscript></div>`)
      return blocks.push(html`<pre><code>${chunk.replace(/\n$/, '')}</code></pre>`)
    }
    for (const block of chunk.split(/\n{2,}/)) {
      const lines = block.split('\n').filter(l => l.trim())
      if (!lines.length) continue
      const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
      if (lines.length > 1 && lines.every(l => ROW.test(l)) && RULE.test(lines[1])) {
        blocks.push(html`<div class="rich-table-wrap"><table class="rich-table"><thead><tr>${cells(lines[0]).map(c => html`<th>${inline(c, ctx)}</th>`)}</tr></thead><tbody>${lines.slice(2).map(l => html`<tr>${cells(l).map(c => html`<td>${inline(c, ctx)}</td>`)}</tr>`)}</tbody></table></div>`)
      } else if (/^\s*☞/.test(lines[0]) && !ctx.pointed && ctx.hand) {
        // "☞ " before a paragraph is the agent's mark for the one that matters: the drawn hand points at it. Once per text.
        ctx.pointed = true
        blocks.push(html`<p class="rich-point">${raw(pointingHandSvg())}${inline(lines.join('\n').replace(/^\s*☞\s*/, ''), ctx)}</p>`)
      } else {
        // Lines that are items of a list (- or *, or 1. 2.) make a list; the lines around them stay paragraphs.
        const kind = l => (/^\s*[-*]\s+/.test(l) ? 'ul' : /^\s*\d{1,3}[.)]\s+/.test(l) ? 'ol' : 'p')
        const runs = []
        for (const l of lines) { const k = kind(l); if (runs.at(-1)?.k === k) runs.at(-1).lines.push(l); else runs.push({ k, lines: [l] }) }
        for (const { k, lines: part } of runs) {
          if (k === 'p') blocks.push(html`<p>${inline(part.join('\n').replace(/^\s*☞\s*/, ''), ctx)}</p>`)
          else {
            const items = part.map(l => html`<li>${inline(l.replace(/^\s*(?:[-*]|\d{1,3}[.)])\s+/, ''), ctx)}</li>`)
            const start = k === 'ol' ? Number(/^\s*(\d+)/.exec(part[0])[1]) : 1
            blocks.push(k === 'ol' ? html`<ol${start !== 1 ? html` start="${start}"` : ''}>${items}</ol>` : html`<ul>${items}</ul>`)
          }
        }
      }
    }
  })
  return html`<div class="rich">${blocks}</div>`
}

// ---- picture ----
// Pictures in the views. The app has no thumbnail service (attachments are /att/<id>, decrypted in the page), so
// every picture keeps its own address and its own size.
//
//   html`<img${srcOf(a, 56)} alt="" loading="lazy" decoding="async" width="56" height="42">`

/** file: an attachment record ({ url, width?, height? }) -> { src, srcset: '', width, height } (null when unknown). */
export function thumb(file) {
  const own = file?.width > 0 && file?.height > 0
  return { src: file?.url ?? '', srcset: '', width: own ? file.width : null, height: own ? file.height : null }
}

/** The src attribute of an <img> for that file (the shown width is the caller's; there are no variants). */
export const srcOf = file => attrs({ src: thumb(file).src })

/** The page behind a picture (the HTML it was rendered from), as one thing to press: a sheet with the file's name.
 *  always: it stands hidden where the picture has no page (the controller shows it for one that has). */
export const pageChip = (page, always = false) => (page || always ? html`<a class="page-chip" data-card-target="page" target="_blank" rel="noopener noreferrer" href="${page?.url ?? '#'}" title="This picture has a page behind it: open the page"${page ? '' : raw(' hidden')}>${sk('page')}<b>${page?.name ?? ''}</b><i>open</i></a>` : '')

// ---- toast ----
// The toast: one small note in the bottom-left corner of the main area (a phone: a slim bar at the foot) that says what
// just happened ("Answered", "<title>") and, when it can be taken back, an Undo button. ONE slot: the same action again
// merges into it ("Archived · 3"), another replaces it. It goes by itself (about six seconds, a held note's own hold),
// stays while the pointer rests on it. U presses its Undo (controller "keys").
//
//   toast({ head, line?, undo?: { action, label?, fields? }, role?, ms? })   the markup (html)
//   in turbo.mjs: t.toast(opts) is the stream action that puts one on the page (prepend into #says-host),
//                 t.says(card, way) the toast of a card's answer
//
// The Undo is a form that posts to the route that takes the action back (a card's /reopen, /wake, /takeback; a
// note's /unsend; a session's /edit with archived=0), with stay=1 (answer with a stream) and quiet=1 (no new toast
// for taking it back). The behaviour (time, pause, the stack, gone once Undo is pressed) is the controller "says"
// in ui.mjs; the look is the block "toast" in app.css.

const UNDO = raw('<svg class="back-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3"/></svg>')
// The time left runs out along a scribbled line (app.css .back-line).
const CLOCK = raw('<svg class="back-line" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true"><path d="M0 3 Q12 1 25 3 T50 3 T75 3 T100 3" pathLength="100"/></svg>')
const ACTION = 'pointerenter->says#pause pointerleave->says#run turbo:submit-start->says#leave turbo:submit-end->says#gone'

// (Without an action the Undo is a plain button: showToast hangs the function on it.)
function undoForm({ action, label = 'Undo', fields = {} }) {
  const button = html`<button class="says-back" type="${action ? 'submit' : 'button'}" title="${label} (U)" aria-keyshortcuts="u">${UNDO}${label}<kbd>U</kbd></button>`
  if (!action) return button
  return html`<form method="post" action="${action}"><input type="hidden" name="stay" value="1"><input type="hidden" name="quiet" value="1"><input type="hidden" name="undo" value="1">${Object.entries(fields).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}${button}</form>`
}

/** One toast. head: what happened, in one or two words; line: of what (a title, a name), may be empty; undo: the route
 *  that takes it back (none: a plain note); role: 'alert' for what went wrong; ms: how long it stays (default 5 s). */
/** link: { href, label }: a way to the page where the thing is done (a device waiting for its check code), instead of an undo. */
export function toast({ head, line = '', undo = null, link = null, role = 'status', ms = null }) {
  return html`<div class="says" data-controller="says" data-action="${ACTION}" role="${role}"${ms ? html` data-says-ms-value="${Math.round(ms)}"` : ''}><span class="says-words"><b>${head}</b>${line ? html`<span>${line}</span>` : ''}</span>${undo ? undoForm(undo) : ''}${link ? html`<a class="says-back says-go" data-nav href="${link.href}" data-action="says#leave">${link.label}</a>` : ''}${CLOCK}</div>`
}

/** A toast made in the page, for an action a controller did itself: the same markup; undo is a function that takes it
 *  back (the toast goes as soon as it is pressed, also by U). */
function showToast({ head, line = '', undo = null, label = 'Undo', role = 'status', ms = null }) {
  const host = document.getElementById('says-host')
  if (!host) return null
  host.insertAdjacentHTML('afterbegin', String(toast({ head, line, role, ms, undo: undo && { label } })))
  const node = host.firstElementChild
  node.querySelector('.says-back')?.addEventListener('click', async () => { node.hidden = true; try { await undo() } finally { node.remove() } }, { once: true })
  return node
}

// ---- stimulus ----
// A small stand-in for Stimulus (the part of its API the board's controllers use), so the controllers of today's
// board (public/t/controllers, synced from trommi-hub) run unchanged without a framework.
//
// Supported: Application.start() / register(name, Controller); Controller with element, identifier, application,
// initialize/connect/disconnect; static targets (xTarget, xTargets, hasXTarget, xTargetConnected/Disconnected);
// static values (xValue get/set, types String/Number/Boolean/Array/Object, defaults, xValueChanged); this.dispatch;
// data-action descriptors "event->id#method", "id#method" (default event of the element), "event@document",
// "event@window", key filters ("keydown.esc"), options ":prevent :stop :once :self"; action params
// (data-id-name-param, typed, in event.params).
//
// How: one MutationObserver on the document. Controllers are created for [data-controller] elements once their
// class is registered (lazy registration works); actions are bound per element and find their controller when the
// event fires (the nearest element with that identifier), so a controller registered later still receives them.

const KEYS = { enter: 'Enter', tab: 'Tab', esc: 'Escape', space: ' ', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', home: 'Home', end: 'End', page_up: 'PageUp', page_down: 'PageDown' }
const camel = s => s.replace(/[-_](\w)/g, (_, c) => c.toUpperCase())
const kebab = s => s.replace(/([A-Z])/g, '-$1').toLowerCase()
const cap = s => s.charAt(0).toUpperCase() + s.slice(1)
const ids = el => (el.getAttribute('data-controller') ?? '').split(/\s+/).filter(Boolean)

function typeOf(def) {
  if (def === String || def === Number || def === Boolean || def === Array || def === Object) return { type: def, fallback: undefined }
  if (def && typeof def === 'object' && 'type' in def) return { type: def.type, fallback: def.default }
  if (typeof def === 'string') return { type: String, fallback: def }
  if (typeof def === 'number') return { type: Number, fallback: def }
  if (typeof def === 'boolean') return { type: Boolean, fallback: def }
  if (Array.isArray(def)) return { type: Array, fallback: def }
  return { type: Object, fallback: def }
}
const EMPTY = new Map([[String, ''], [Number, 0], [Boolean, false], [Array, []], [Object, {}]])
function readValue(type, raw, fallback) {
  if (raw == null) return fallback !== undefined ? (typeof fallback === 'object' && fallback ? structuredClone(fallback) : fallback) : structuredClone(EMPTY.get(type))
  switch (type) {
    case Number: return Number(raw.replace(/_/g, ''))
    case Boolean: return !(raw === '0' || raw === 'false')
    case Array: case Object: try { return JSON.parse(raw) } catch { return structuredClone(EMPTY.get(type)) }
    default: return raw
  }
}
const writeValue = (type, v) => (type === Array || type === Object ? JSON.stringify(v) : String(v))

function typedParam(raw) {
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw)
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^[[{]/.test(raw)) { try { return JSON.parse(raw) } catch {} }
  return raw
}

export class Controller {
  static targets = []
  static values = {}
  constructor(context) { this.context = context }
  get element() { return this.context.element }
  get identifier() { return this.context.identifier }
  get application() { return this.context.application }
  initialize() {}
  connect() {}
  disconnect() {}
  dispatch(eventName, { target = this.element, detail = {}, prefix = this.identifier, bubbles = true, cancelable = true } = {}) {
    const event = new CustomEvent(prefix ? `${prefix}:${eventName}` : eventName, { detail, bubbles, cancelable })
    target.dispatchEvent(event)
    return event
  }
}

// Getters for targets and values, put on a controller class once, when it is registered.
function equip(Klass, identifier) {
  const proto = Klass.prototype
  const targets = new Set()
  const values = {}
  for (let C = Klass; C && C !== Controller; C = Object.getPrototypeOf(C)) {
    for (const t of Object.hasOwn(C, 'targets') ? C.targets : []) targets.add(t)
    for (const [k, v] of Object.entries(Object.hasOwn(C, 'values') ? C.values : {})) if (!(k in values)) values[k] = v
  }
  for (const name of targets) {
    const attr = `data-${identifier}-target`
    const all = function () { return targetsOf(this, attr, name) }
    Object.defineProperty(proto, `${name}Targets`, { configurable: true, get: all })
    Object.defineProperty(proto, `${name}Target`, { configurable: true, get() { const t = all.call(this)[0]; if (!t) throw new Error(`Missing target element "${name}" for "${identifier}" controller`); return t } })
    Object.defineProperty(proto, `has${cap(name)}Target`, { configurable: true, get() { return all.call(this).length > 0 } })
  }
  const valueSpecs = Object.entries(values).map(([name, def]) => ({ name, attr: `data-${identifier}-${kebab(name)}-value`, ...typeOf(def) }))
  for (const spec of valueSpecs) {
    Object.defineProperty(proto, `${spec.name}Value`, {
      configurable: true,
      get() { return readValue(spec.type, this.element.getAttribute(spec.attr), spec.fallback) },
      set(v) { if (v == null) this.element.removeAttribute(spec.attr); else this.element.setAttribute(spec.attr, writeValue(spec.type, v)) },
    })
    Object.defineProperty(proto, `has${cap(spec.name)}Value`, { configurable: true, get() { return this.element.hasAttribute(spec.attr) } })
  }
  Klass.__equipped = { identifier, targets: [...targets], valueSpecs }
}
function targetsOf(controller, attr, name) {
  const root = controller.element, id = controller.identifier
  const out = []
  const sel = `[${attr}~="${name}"]`
  if (root.matches(sel)) out.push(root)
  for (const el of root.querySelectorAll(sel)) {
    // Scoped like Stimulus: a target inside a nested controller of the same identifier belongs to that one.
    const owner = el.parentElement?.closest(`[data-controller~="${id}"]`)
    if (owner === root || (el !== root && el.closest(`[data-controller~="${id}"]`) === el && owner === root)) out.push(el)
  }
  return out
}

class Application {
  constructor() {
    this.root = null                         // the document's element, once started
    this.classes = new Map()                 // identifier -> class
    this.live = new Map()                    // element -> Map(identifier -> controller)
    this.bound = new WeakMap()               // element -> { spec, listeners: [{ target, type, fn, opts }] }
    this.boundEls = new Set()
  }
  start(root = document.documentElement) {
    this.root = root
    this.observer = new MutationObserver(records => this.mutated(records))
    this.observer.observe(this.root, { childList: true, subtree: true, attributes: true, attributeOldValue: true })
    this.scan(this.root)
  }
  register(identifier, Klass) {
    if (this.classes.has(identifier)) return
    equip(Klass, identifier)
    this.classes.set(identifier, Klass)
    if (this.root) for (const el of this.root.querySelectorAll(`[data-controller~="${identifier}"]`)) this.connectOne(el, identifier)
  }
  getControllerForElementAndIdentifier(el, identifier) { return this.live.get(el)?.get(identifier) ?? null }

  // ---- connecting and disconnecting ----
  connectOne(el, identifier) {
    if (!el.isConnected) return
    const Klass = this.classes.get(identifier)
    if (!Klass) return
    let mine = this.live.get(el)
    if (mine?.has(identifier)) return
    if (!mine) this.live.set(el, (mine = new Map()))
    const c = new Klass({ element: el, identifier, application: this })
    c.__targets = new Map()
    c.__values = new Map()
    mine.set(identifier, c)
    try { c.initialize() } catch (err) { console.error(`${identifier}#initialize`, err) }
    // Values first (their Changed callbacks run before connect, as in Stimulus), then connect, then targets.
    for (const spec of Klass.__equipped.valueSpecs) {
      const v = c[`${spec.name}Value`]
      c.__values.set(spec.name, JSON.stringify(v))
      const cb = c[`${spec.name}ValueChanged`]
      if (typeof cb === 'function' && (el.hasAttribute(spec.attr) || spec.fallback !== undefined)) { try { cb.call(c, v, undefined) } catch (err) { console.error(`${identifier}#${spec.name}ValueChanged`, err) } }
    }
    try { c.connect() } catch (err) { console.error(`${identifier}#connect`, err) }
    this.syncTargets(c)
  }
  disconnectOne(el, identifier) {
    const mine = this.live.get(el), c = mine?.get(identifier)
    if (!c) return
    mine.delete(identifier)
    if (!mine.size) this.live.delete(el)
    for (const [name, set] of c.__targets) { const cb = c[`${name}TargetDisconnected`]; if (typeof cb === 'function') for (const t of set) { try { cb.call(c, t) } catch (err) { console.error(err) } } }
    try { c.disconnect() } catch (err) { console.error(`${identifier}#disconnect`, err) }
  }
  syncTargets(c) {
    for (const name of c.constructor.__equipped.targets) {
      const on = c[`${name}TargetConnected`], off = c[`${name}TargetDisconnected`]
      if (typeof on !== 'function' && typeof off !== 'function') continue
      const now = new Set(c[`${name}Targets`]), was = c.__targets.get(name) ?? new Set()
      c.__targets.set(name, now)
      if (typeof off === 'function') for (const t of was) if (!now.has(t)) { try { off.call(c, t) } catch (err) { console.error(err) } }
      if (typeof on === 'function') for (const t of now) if (!was.has(t)) { try { on.call(c, t) } catch (err) { console.error(err) } }
    }
  }
  syncValues(c) {
    for (const spec of c.constructor.__equipped.valueSpecs) {
      const v = c[`${spec.name}Value`], key = JSON.stringify(v), old = c.__values.get(spec.name)
      if (key === old) continue
      c.__values.set(spec.name, key)
      const cb = c[`${spec.name}ValueChanged`]
      if (typeof cb === 'function') { try { cb.call(c, v, old === undefined ? undefined : JSON.parse(old)) } catch (err) { console.error(err) } }
    }
  }

  // ---- actions ----
  bind(el) {
    const spec = el.getAttribute('data-action') ?? ''
    const had = this.bound.get(el)
    if (had?.spec === spec) return
    if (had) { for (const l of had.listeners) l.target.removeEventListener(l.type, l.fn, l.opts); this.bound.delete(el); this.boundEls.delete(el) }
    if (!spec.trim() || !el.isConnected) return
    const listeners = []
    for (const d of spec.trim().split(/\s+/)) {
      const m = /^(?:([\w:.\-]+?)(?:@(window|document))?->)?([\w-]+)#([\w$]+)(?::([\w:!]+))?$/.exec(d)
      if (!m) { console.warn('stimulus: bad action', d); continue }
      let [, evName, global, identifier, method, opts] = m
      if (!evName) evName = defaultEvent(el)
      let key = null
      const dot = evName.lastIndexOf('.')
      if (dot > 0 && /^key/.test(evName)) { key = evName.slice(dot + 1); evName = evName.slice(0, dot) }
      const options = new Set((opts ?? '').split(':').filter(Boolean))
      const target = global === 'window' ? window : global === 'document' ? document : el
      const fn = event => {
        if (key && !keyMatches(event, key)) return
        if (options.has('self') && event.target !== el) return
        const host = el.closest(`[data-controller~="${identifier}"]`)
        const c = host && this.live.get(host)?.get(identifier)
        if (!c || typeof c[method] !== 'function') return
        if (options.has('prevent')) event.preventDefault()
        if (options.has('stop')) event.stopPropagation()
        const params = {}
        const prefix = `data-${identifier}-`
        for (const a of el.attributes) if (a.name.startsWith(prefix) && a.name.endsWith('-param')) params[camel(a.name.slice(prefix.length, -6))] = typedParam(a.value)
        try { Object.defineProperty(event, 'params', { value: params, configurable: true }) } catch {}
        c[method](event)
      }
      const lopts = { once: options.has('once'), passive: options.has('passive') || undefined, capture: options.has('capture') || undefined }
      target.addEventListener(evName, fn, lopts)
      listeners.push({ target, type: evName, fn, opts: lopts })
    }
    this.bound.set(el, { spec, listeners })
    this.boundEls.add(el)
  }
  unbind(el) {
    const had = this.bound.get(el)
    if (!had) return
    for (const l of had.listeners) l.target.removeEventListener(l.type, l.fn, l.opts)
    this.bound.delete(el)
    this.boundEls.delete(el)
  }

  // ---- watching the page ----
  scan(root) {
    if (!(root instanceof Element)) return
    const els = root.matches('[data-controller], [data-action]') ? [root] : []
    els.push(...root.querySelectorAll('[data-controller], [data-action]'))
    for (const el of els) {
      if (el.hasAttribute('data-controller')) for (const id of ids(el)) this.connectOne(el, id)
      if (el.hasAttribute('data-action')) this.bind(el)
    }
  }
  mutated(records) {
    let structural = false
    const added = new Set(), touched = new Set()
    for (const r of records) {
      if (r.type === 'childList') {
        structural = true
        for (const n of r.addedNodes) if (n instanceof Element) added.add(n)
      } else if (r.type === 'attributes') {
        const el = r.target
        if (r.attributeName === 'data-controller') {
          const now = new Set(ids(el))
          for (const id of (r.oldValue ?? '').split(/\s+/).filter(Boolean)) if (!now.has(id)) this.disconnectOne(el, id)
          for (const id of now) this.connectOne(el, id)
        } else if (r.attributeName === 'data-action') this.bind(el)
        else if (/^data-[\w-]+-target$/.test(r.attributeName)) structural = true
        else if (/^data-[\w-]+-value$/.test(r.attributeName)) touched.add(el)
      }
    }
    if (structural) {
      // What left: controllers and listeners of elements no longer in the page.
      for (const [el, mine] of [...this.live]) if (!el.isConnected) for (const id of [...mine.keys()]) this.disconnectOne(el, id)
      for (const el of [...this.boundEls]) if (!el.isConnected) this.unbind(el)
      for (const n of added) if (n.isConnected) this.scan(n)
      for (const mine of this.live.values()) for (const c of mine.values()) this.syncTargets(c)
    }
    for (const el of touched) for (const c of this.live.get(el)?.values() ?? []) this.syncValues(c)
  }
}

function defaultEvent(el) {
  const tag = el.tagName
  if (tag === 'FORM') return 'submit'
  if (tag === 'SELECT') return 'change'
  if (tag === 'TEXTAREA') return 'input'
  if (tag === 'INPUT') return el.type === 'submit' ? 'click' : 'input'
  if (tag === 'DETAILS') return 'toggle'
  return 'click'
}
function keyMatches(event, filter) {
  const parts = filter.split('+')
  const key = parts.pop()
  const want = KEYS[key] ?? key
  if (String(event.key).toLowerCase() !== String(want).toLowerCase()) return false
  for (const mod of ['ctrl', 'alt', 'shift', 'meta']) if (event[`${mod}Key`] !== parts.includes(mod)) return false
  return true
}

// The page's controllers: every view registers its own with controller(name, class) when it is imported (that only
// keeps the class); startUi() starts them on the page.
const stimulus = new Application()
export const controller = (name, Klass) => stimulus.register(name, Klass)

// The toast (ui.mjs): it goes by itself; while the pointer rests on it, it stays. One slot (slot() below). Once its Undo is pressed it is gone (kept, hidden, until the form's
// answer is in: a form taken out of the page would lose its stream answer).
controller('says', class extends Controller {
  static values = { ms: { type: Number, default: 6000 } }
  connect() {
    // (Moved along with its place to the next page, it goes on with the time it had left.)
    if (this.element.dataset.born) { this.left = Number(this.element.dataset.born) - Date.now(); if (this.left <= 0) return this.element.remove(); this.element.style.setProperty('--back-ms', `${this.left}ms`); return this.run() }
    this.element.dataset.born = Date.now() + this.msValue
    const host = this.element.parentElement
    if (host?.id === 'says-host') this.slot(host)
    // A toast that came with the page's address (?said=…) is not shown again by a refresh of that page.
    const url = new URL(location.href)
    if (url.searchParams.has('said')) { url.searchParams.delete('said'); history.replaceState(history.state, '', url) }
    this.left = this.msValue; this.element.style.setProperty('--back-ms', `${this.left}ms`); this.run()
  }
  // One slot: the same action again merges into this toast ("Archived · 3", its Undo takes back the last; the titles
  // in its tooltip); another replaces it. (A toast whose Undo was pressed stays, hidden, for its form's answer; a device
  // that asks for its check code stays too: it is a question, not news.)
  slot(host) {
    const me = this.element, words = me.querySelector('.says-words'), head = words?.querySelector('b')?.textContent ?? ''
    const line = words?.querySelector('span')?.textContent ?? ''
    const shown = [...host.children].filter(n => n !== me && n.matches('.says:not([hidden])') && !n.querySelector('.says-go'))
    const same = me.querySelector('form') && shown.find(n => n.dataset.head === head && n.querySelector('form'))
    const titles = [...(same ? JSON.parse(same.dataset.titles || '[]') : []), line].filter(Boolean).slice(-30)
    me.dataset.head = head
    me.dataset.titles = JSON.stringify(titles)
    if (same && titles.length > 1) {
      words.replaceChildren(Object.assign(document.createElement('b'), { textContent: `${head} · ${titles.length}` }), Object.assign(document.createElement('span'), { textContent: `Last: ${line}` }))
      me.title = titles.join('\n')
      const back = me.querySelector('.says-back'); if (back) back.title = 'Undo the last (U)'
    }
    for (const old of shown) old.remove()
    document.body.dataset.says = ''
  }
  disconnect() { clearTimeout(this.timer); if (!document.querySelector('#says-host .says:not([hidden])')) delete document.body.dataset.says }
  run() { if (this.element.hidden) return; this.since = Date.now(); this.element.dataset.born = this.since + this.left; delete this.element.dataset.paused; clearTimeout(this.timer); this.timer = setTimeout(() => this.element.remove(), Math.max(this.left, 800)) }
  pause() { clearTimeout(this.timer); this.left -= Date.now() - this.since; this.element.dataset.paused = '' }
  leave() { clearTimeout(this.timer); this.element.hidden = true }
  gone() { this.element.remove() }
})

// A row's title of two lines leaves room for one line of text below it (css: .inbox-row[data-tall]).
let fitObserver = null
const fitting = () => (fitObserver ??= new ResizeObserver(entries => {
  for (const { target } of entries) {
    if (!target.clientHeight) continue
    target.closest('.inbox-row')?.toggleAttribute('data-tall', target.clientHeight > parseFloat(getComputedStyle(target).lineHeight) * 1.5)
  }
}))
controller('fit', class extends Controller {
  connect() { fitting().observe(this.element) }
  disconnect() { fitting().unobserve(this.element) }
})

// ---- the page curl (his pick, 4 October: "the back of the Desk"; free in the hand, 6 October: "wie Apple Books") ----
// The Desk and the Scribble Board are two sides of one sheet. Its top-right corner is a small dog-ear; as the pointer
// comes near it lifts and leans towards it, and held it follows the pointer freely: the flap's tip is under the
// finger, the fold is the line halfway between the tip and the sheet's corner, whatever its angle. Let go, it springs
// back, or past a third of the way (or flung) the page turns; a tap turns it too. Esc turns back from the Scribble
// Board; P turns either way (ui.mjs keys).
// What shows under the lifted sheet is the other page itself, not a drawing of it: on the Desk the Scribble Board
// (mounted once when the corner is first approached, kept from then on: app.mjs keepPad), on the Scribble Board the
// Desk as it is rendered now (app.mjs peek). So a turn swaps two things that are both there, and nothing flashes.
// Markup: curlHTML(side, to), a part of the frame on both pages (app.mjs bodyParts). Reduced motion: no peel, a fade.
export const curlHTML = (side, to) => raw(`<div class="curl" data-controller="curl" data-curl-side-value="${side}" data-curl-to-value="${to}"><div class="curl-back" hidden inert></div><svg class="curl-svg" aria-hidden="true"><defs><clipPath id="curl-flap-clip"><path class="curl-flap-clip"/></clipPath></defs><path class="curl-under"/><path class="curl-cast"/><path class="curl-flap"/><path class="curl-hatch" clip-path="url(#curl-flap-clip)"/><path class="curl-fold"/></svg><button type="button" class="curl-grab" title="${side === 'desk' ? 'Turn to the Scribble Board (P)' : 'Turn back to the Desk (Esc)'}" aria-label="${side === 'desk' ? 'Turn to the Scribble Board' : 'Turn back to the Desk'}"></button></div>`)
const CURL_REST = [-38, 28], CURL_NEAR = 130   // the dog-ear's tip from the corner at rest; how near the pointer wakes it
/** A convex polygon cut by the line through m with normal n: the part on n's side. */
function cutPoly(poly, m, n) {
  const f = p => (p[0] - m[0]) * n[0] + (p[1] - m[1]) * n[1], out = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], fa = f(a), fb = f(b)
    if (fa >= 0) out.push(a)
    if ((fa >= 0) !== (fb >= 0)) { const t = fa / (fa - fb); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]) }
  }
  return out
}
controller('curl', class extends Controller {
  static values = { side: String, to: String }
  connect() {
    const q = c => this.element.querySelector(c)
    this.svg = q('.curl-svg'); this.grab = q('.curl-grab'); this.back = q('.curl-back')
    this.calm = matchMedia('(prefers-reduced-motion: reduce)').matches
    this.tip = [0, 0]; this.vel = [0, 0]; this.goal = null; this.drag = null
    document.documentElement.dataset.curl = this.sideValue
    const on = (t, n, f, o) => { t.addEventListener(n, f, o); (this.offs ??= []).push(() => t.removeEventListener(n, f, o)) }
    on(window, 'resize', () => this.place())
    on(window, 'scroll', () => { this.tick ??= requestAnimationFrame(() => { this.tick = null; if (this.top !== this.barTop()) this.place() }) }, { passive: true })
    // near the corner it wakes: the other side is brought under it, the dog-ear leans towards the pointer
    on(document, 'pointermove', e => {
      if (this.drag || this.turning || e.pointerType === 'touch' || this.calm) return
      const b = this.box, dx = b.right - e.clientX, dy = e.clientY - b.top, d = Math.hypot(dx, dy)
      if (d > CURL_NEAR || dx < 0 || dy < 0) { if (this.goal) { this.goal = null; this.spring() } return }
      this.wake()
      const k = 1 - d / CURL_NEAR, len = 32 + 56 * k, a = Math.atan2(Math.max(dy, 6), Math.max(dx, 6)), lean = Math.min(1.15, Math.max(.35, a))
      this.goal = [-Math.cos(lean) * len, Math.sin(lean) * len]
      this.spring()
    }, { passive: true })
    on(this.grab, 'pointerdown', e => {
      if (this.turning || e.button > 0) return
      this.grab.setPointerCapture(e.pointerId); this.wake(); cancelAnimationFrame(this.anim); this.anim = null
      this.drag = { x: e.clientX, y: e.clientY, t: e.timeStamp, moved: false }
    })
    on(this.grab, 'pointermove', e => {
      const d = this.drag; if (!d) return
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) d.moved = true
      if (!d.moved || this.calm) return
      const b = this.box, was = this.tip, dt = Math.max(1, e.timeStamp - d.t)
      this.tip = this.held([e.clientX - b.right, e.clientY - b.top])
      this.vel = [(this.tip[0] - was[0]) / dt * 1000, (this.tip[1] - was[1]) / dt * 1000]; d.t = e.timeStamp
      this.render()
    })
    const drop = e => {
      const d = this.drag; this.drag = null; if (!d) return
      if (e.type === 'pointercancel') return this.spring()
      const far = Math.hypot(...this.tip) > Math.min(this.box.width, this.box.height) * 0.36, flung = this.vel[0] < -700 || this.vel[1] > 700
      if (!d.moved || far || flung) this.turn(); else this.spring()
    }
    on(this.grab, 'pointerup', drop); on(this.grab, 'pointercancel', drop)
    on(this.grab, 'keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.turn() } })
    on(document, 'trommi:curl', () => this.turn())
    on(document, 'keydown', e => {
      if (e.key !== 'Escape' || this.sideValue !== 'pad' || e.defaultPrevented) return
      const t = e.target; if (t?.closest?.('input, textarea, select, [contenteditable], dialog[open]')) return
      this.turn()
    })
    if (this.sideValue === 'pad') document.getElementById('whiteboard')?.removeAttribute('style')   // (it is the page now, not what lies under the Desk)
    this.place()
    // arriving from the other side, the sheet settles into its corner
    let arrived = false; try { arrived = sessionStorage.getItem('trommi-curl') === '1'; sessionStorage.removeItem('trommi-curl') } catch {}
    this.tip = arrived && !this.calm ? [-150, 110] : [...CURL_REST]
    if (this.sideValue === 'desk' && document.getElementById('whiteboard')) this.wake()
    this.render()
    if (arrived && !this.calm) this.spring()
  }
  disconnect() {
    cancelAnimationFrame(this.anim); cancelAnimationFrame(this.tick)
    for (const off of this.offs ?? []) off()
    if (document.documentElement.dataset.curl === this.sideValue) delete document.documentElement.dataset.curl
  }
  /** Where the sheet's top edge is: the window's, or the lower edge of a bar that stands over the corner (a phone's top bar and its sessions). */
  barTop() {
    const vw = document.documentElement.clientWidth
    return Math.round(Math.max(0, ...[...document.querySelectorAll('.topbar, #agents')].map(e => e.getBoundingClientRect()).filter(b => b.right >= vw - 24 && b.bottom > 0).map(b => b.bottom)))
  }
  /** The sheet is the page's main area: right of the sidebar, under a phone's bars, never beyond the window. */
  place() {
    const main = document.querySelector('main'), r = main.getBoundingClientRect(), vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight
    const left = Math.max(0, Math.round(r.left)), right = Math.min(Math.round(r.right), vw), top = this.top = this.barTop()
    this.box = { left, top, right, bottom: vh, width: right - left, height: vh - top }
    Object.assign(this.element.style, { left: `${left}px`, top: `${top}px`, width: `${this.box.width}px`, height: `${this.box.height}px` })
    this.svg.setAttribute('viewBox', `0 0 ${this.box.width} ${this.box.height}`)
    this.render()
  }
  /** The other side comes under the sheet (once): the mounted Scribble Board under the Desk, the Desk as rendered now under the board. */
  wake() {
    if (this.awake) return
    this.awake = true
    const router = window.trommi?.router
    if (this.sideValue === 'desk') { router?.keepPad(); this.render() }
    else router?.peek(this.toValue).then(html => {
      if (!html || !this.element.isConnected) return
      this.back.innerHTML = html.replace(/ data-(?:controller|action)="[^"]*"/g, '')
      this.back.style.background = getComputedStyle(document.body).backgroundColor   // (the Desk's own ground)
      this.back.hidden = false
      this.render()
    })
  }
  /** While held the paper does not tear: the tip stays within the sheet's reach of its far corners, and inside the window. */
  held([x, y]) {
    const W = this.box.width, H = this.box.height
    let p = [Math.min(-2, x), Math.max(2, y)]
    for (const [c, r] of [[[-W, 0], W], [[0, H], H], [[-W, 0], W]]) { const d = Math.hypot(p[0] - c[0], p[1] - c[1]); if (d > r) p = [c[0] + (p[0] - c[0]) * r / d, c[1] + (p[1] - c[1]) * r / d] }
    return p
  }
  render() {
    // tip: where the sheet's corner is now, from the corner itself (x to the left is negative, y down). The fold is the
    // line halfway between the two; what lies on the corner's side of it is lifted (there the other page shows), and
    // the flap is that piece mirrored over the fold. All of it is cut to the sheet's box, so nothing reaches the sidebar.
    if (!this.box) return
    const W = this.box.width, H = this.box.height, C = [W, 0], P = [W + this.tip[0], this.tip[1]], f = n => n.toFixed(1)
    const d = Math.hypot(P[0] - C[0], P[1] - C[1]), set = (c, v) => this.svg.querySelector(c).setAttribute('d', v)
    const path = pts => (pts.length ? `M${pts.map(p => `${f(p[0])},${f(p[1])}`).join(' L')} Z` : '')
    if (d < 3) { for (const c of ['.curl-under', '.curl-cast', '.curl-flap', '.curl-flap-clip', '.curl-hatch', '.curl-fold']) set(c, ''); return this.under([]) }
    for (const c of ['.curl-flap', '.curl-fold', '.curl-hatch']) this.svg.querySelector(c).style.strokeOpacity = Math.min(1, .5 + (d - 29.3) / 61).toFixed(2)   // (at rest the ink is light)
    const n = [(C[0] - P[0]) / d, (C[1] - P[1]) / d], M = [(C[0] + P[0]) / 2, (C[1] + P[1]) / 2]
    const lifted = cutPoly([[0, 0], [W, 0], [W, H], [0, H]], M, n)
    const mirror = p => { const k = 2 * ((p[0] - M[0]) * n[0] + (p[1] - M[1]) * n[1]); return [p[0] - k * n[0], p[1] - k * n[1]] }
    const flap = lifted.map(mirror), on = lifted.filter(p => Math.abs((p[0] - M[0]) * n[0] + (p[1] - M[1]) * n[1]) < 0.01)
    set('.curl-under', path(lifted)); set('.curl-flap', path(flap)); set('.curl-flap-clip', path(flap))
    this.svg.querySelector('.curl-cast').setAttribute('d', path(flap)); this.svg.querySelector('.curl-cast').setAttribute('transform', `translate(${f(-Math.min(5, d * .05))},${f(Math.min(5, d * .05))})`)
    if (on.length < 2) { set('.curl-fold', ''); set('.curl-hatch', ''); return this.under(lifted) }
    const [A, B] = on, len = Math.hypot(B[0] - A[0], B[1] - A[1]), u = [(B[0] - A[0]) / len, (B[1] - A[1]) / len]
    set('.curl-fold', `M${f(A[0])},${f(A[1])} L${f(B[0])},${f(B[1])}`)
    // pen hatching along the fold, on the flap: short strokes that lean, every 6 px of the fold, anchored to its upper end
    // (so they do not swim while the fold moves); their length follows the lift, up to 20 px
    const depth = Math.min(20, d * .22), lean = [-n[0] * .92 + u[0] * .4, -n[1] * .92 + u[1] * .4]
    let hatch = ''
    for (let s = 3.6, i = 0; s < len; s += 6, i++) { const x = A[0] + u[0] * s, y = A[1] + u[1] * s, l = depth * (i % 3 === 1 ? .62 : 1); hatch += `M${f(x)},${f(y)} l${f(lean[0] * l)},${f(lean[1] * l)}` }
    set('.curl-hatch', hatch)
    this.under(lifted)
  }
  /** The other page shows exactly where the sheet is lifted (lifted: that piece, in the box's own px). */
  under(lifted) {
    const clip = lifted.length ? `polygon(${lifted.map(p => `${p[0].toFixed(1)}px ${p[1].toFixed(1)}px`).join(', ')})` : 'polygon(0 0)'
    if (this.sideValue === 'pad') { this.back.style.clipPath = clip; return }
    const pad = document.getElementById('whiteboard'); if (!pad) return
    const b = this.box
    Object.assign(pad.style, { display: 'block', position: 'fixed', left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px`, margin: '0', zIndex: '6', pointerEvents: 'none', clipPath: clip })
    this.svg.classList.add('has-under')
  }
  /** Free again, the tip swings to where it belongs (the rest, or the lean towards a near pointer), with what speed it had. */
  spring() {
    if (this.anim || this.turning || this.drag) return
    let last = performance.now()
    const step = now => {
      const dt = Math.min(.032, (now - last) / 1000); last = now
      const to = this.goal ?? CURL_REST
      for (const i of [0, 1]) { this.vel[i] += (260 * (to[i] - this.tip[i]) - 21 * this.vel[i]) * dt; this.tip[i] += this.vel[i] * dt }
      this.tip[0] = Math.min(-2, this.tip[0]); this.tip[1] = Math.max(2, this.tip[1])
      this.render()
      const still = Math.hypot(to[0] - this.tip[0], to[1] - this.tip[1]) < .4 && Math.hypot(...this.vel) < 6
      if (still || this.drag || this.turning) { this.anim = null; if (still) { this.tip = [...to]; this.vel = [0, 0]; this.render() } return }
      this.anim = requestAnimationFrame(step)
    }
    this.anim = requestAnimationFrame(step)
  }
  /** Turn the sheet: it is carried off over the far corner, then the other side is the page (it is there already). */
  turn() {
    if (this.turning) return
    this.turning = true
    cancelAnimationFrame(this.anim); this.anim = null
    const go = () => { try { sessionStorage.setItem('trommi-curl', '1') } catch {} ; window.Turbo?.visit ? window.Turbo.visit(this.toValue) : location.assign(this.toValue) }
    if (this.calm) { const main = document.querySelector('main'); main?.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' }); return setTimeout(go, 160) }
    this.wake(); this.place()
    const from = [...this.tip], to = [-this.box.width * 2.1, this.box.height * 2.1], t0 = performance.now(), ms = 520
    const step = now => {
      const k = Math.min(1, (now - t0) / ms), e = k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
      this.tip = [from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e]
      this.render()
      if (k < 1) this.anim = requestAnimationFrame(step); else go()
    }
    this.anim = requestAnimationFrame(step)
  }
})

/** Wires the page (app.mjs boot): the controllers, times that keep themselves current, the tile that was tapped. */
export function startUi() {
  stimulus.start()
  setInterval(() => { for (const n of document.querySelectorAll('[data-ts]')) n.textContent = ago(Number(n.dataset.ts)) }, 30000)
  document.addEventListener('turbo:submit-start', e => { e.detail.formSubmission.submitter?.classList.add('is-picked') })
  document.addEventListener('turbo:submit-end', e => { e.detail.formSubmission.submitter?.classList.remove('is-picked') })
}

// ---- ui ----
// DOM helpers the controllers import: el (a node, never an HTML string, so text from an agent cannot inject markup),
// sketch (a pen icon as a node) and adviceLoop (the highlighter behind the advised option). The drawings are pen.js's.

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
function adviceLoop() {
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
  // (the display face arrives after the first measure and sets the words anew without changing the host's box:
  // the swipe lay beside its words, as in a gallery opened first)
  document.fonts?.ready.then(() => { if (svg.isConnected) draw() })
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

// ---- controller "advice" ----
// The agent's advice: a highlighter swipe drawn by hand behind the words of the option it would pick (the old client's
// adviceLoop in ui.mjs, which measures the words and redraws when its host changes size). On a tile, a card option.

controller('advice', class extends Controller {
  // (his pick "stroke", 7 October: the advice is one short pen stroke at the tile's foot, drawn by CSS on .is-advised;
  // the label stays clean, so this draws nothing any more and clears what an older page left)
  connect() { this.element.querySelector(':scope > .advice-loop')?.remove() }
})

// ---- richhtml ----
// Rich content in a text: tables as agents write them in markdown, and HTML an agent sends along
// (the field html beside a message or a question, or a block fenced as ```html inside a text).
//
// The HTML is never part of this page. It stands in a frame that has no origin of its own
// (sandbox without allow-same-origin: no cookies, no storage, no way to the board's DOM), under a
// policy that fetches nothing (default-src 'none', pictures as data: only) and runs one script, the
// one written here (it carries a nonce made for this frame; whatever the agent wrote has none, and
// handlers written into tags never run). That script does three things: it says how tall the
// content is, takes the theme when it changes, and hands a clicked link to this page, which opens
// it in a new tab (a link never moves the frame itself). No forms, no popups, no way to move the
// page around it.
// The agent's connector has already cleaned what it sent (connector/tools.mjs); here it is parsed and
// cleaned once more by the browser's own parser, so that old state and other senders hold too.
//
// The richhtml controller calls htmlBlock() for each block ui.mjs marks; richMark() names a card's extras.

// ---- tables ----------------------------------------------------------------------

// What counts as a number in a cell: 40, 1.250,50 €, ~12 ms, +3 %, 1.2 GB, $40/month.
const NUMERIC = /^[~≈<>≤≥±+\-−–]?\s*[€$£¥]?\s*\d[\d.,'’   ]*\s*(%|‰|[€$£¥]|[a-zA-Zµ°²³]{1,8})?(\s*\/\s*[a-zA-Z]{1,8})?$/
const NEUTRAL = /^([-–—]|n\/a|k\.\s?a\.)?$/i

/** Set a table's columns: a column of numbers stands right-aligned, in figures of one width; a rule
 *  row as markdown writes it (:--, :-:, --:) says it outright. Returns the table. */
function tidyTable(table, rule = '') {
  const rows = [...table.rows]
  if (!rows.length || rows.some(r => [...r.cells].some(c => c.colSpan > 1 || c.rowSpan > 1))) return table
  const said = String(rule).trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()).map(c => (/^:-+:$/.test(c) ? 'center' : /^-+:$/.test(c) ? 'right' : /^:-+$/.test(c) ? 'left' : ''))
  const width = Math.max(...rows.map(r => r.cells.length))
  for (let col = 0; col < width; col++) {
    const cells = rows.map(r => r.cells[col]).filter(Boolean)
    const body = cells.filter(c => c.tagName === 'TD').map(c => c.textContent.trim())
    const numbers = body.filter(t => NUMERIC.test(t)).length
    const numeric = numbers > 0 && body.every(t => NUMERIC.test(t) || NEUTRAL.test(t))
    const align = said[col] || (numeric ? 'right' : '')
    if (!align) continue
    for (const cell of cells) {
      // What the author set on a cell stands.
      if (cell.hasAttribute('align') || /text-align/i.test(cell.getAttribute('style') ?? '')) continue
      if (align === 'right') cell.classList.add('num')
      else if (align === 'center') cell.classList.add('mid')
    }
  }
  return table
}

// ---- the frame ---------------------------------------------------------------------

// Never part of a block: what runs, embeds, loads or redirects.
const BANNED = 'script, iframe, frame, frameset, object, embed, applet, meta, link, base, noscript, template, audio, video, source, track, portal'
const LINK_OK = /^(https?:|mailto:|#|[^:]*$)/i

/** Parse a block with the browser's parser (nothing runs, nothing loads) and take out what does not belong. */
function parse(source) {
  const doc = new DOMParser().parseFromString(String(source ?? ''), 'text/html')
  doc.querySelectorAll(BANNED).forEach(n => n.remove())
  doc.querySelectorAll('form').forEach(f => f.replaceWith(...f.childNodes))
  for (const node of doc.querySelectorAll('*')) {
    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on') || ['srcdoc', 'formaction', 'ping', 'srcset', 'poster', 'background'].includes(name)) node.removeAttribute(attr.name)
      else if (['href', 'xlink:href', 'action'].includes(name) && !LINK_OK.test(attr.value.replace(/[\s\u0000-\u001f]/g, ''))) node.setAttribute(attr.name, '#')
      else if (name === 'src' && !/^data:image\//i.test(attr.value.trim())) node.removeAttribute(attr.name)
    }
  }
  // A link never moves the frame: it asks for a new tab, which the frame may not open; the page around it does.
  // (A link to a place in the block is followed by the frame's script; an address of its own it has none.)
  doc.querySelectorAll('a[href], area[href]').forEach(a => { if (!a.getAttribute('href').startsWith('#')) a.target = '_blank' })
  doc.querySelectorAll('table').forEach(t => tidyTable(t))
  for (const style of doc.head.querySelectorAll('style')) doc.body.prepend(style)
  return { body: doc.body.innerHTML, kind: doc.querySelector('table') && !doc.querySelector('.grid, .card, details, h1, h2, h3, svg, img') ? 'table' : 'layout' }
}

// The house style inside the frame: plain semantic HTML looks like the board. Colours, radii and fonts
// are the board's own tokens, handed in per theme (tokens()).
const HOUSE = `
*,*::before,*::after{box-sizing:border-box}
html{background:transparent;-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;padding:1px 0;font:400 1rem/1.55 var(--font);color:var(--fg);overflow-wrap:anywhere}
body>:first-child{margin-top:0}body>:last-child{margin-bottom:0}
h1,h2,h3,h4,h5,h6{margin:1.15em 0 .45em;font-family:var(--display);font-weight:700;line-height:1.2}
h1{font-size:1.45rem}h2{font-size:1.25rem}h3{font-size:1.08rem}h4,h5,h6{font-size:1rem}
p,ul,ol,dl,table,pre,details,blockquote,figure,.grid{margin:0 0 .8em}
ul,ol{padding-left:1.35em}li+li{margin-top:.3em}li::marker{color:var(--faint)}
a{color:var(--accent);text-decoration-thickness:1px;text-underline-offset:3px}
strong,b{font-weight:600}
small,.muted,figcaption,caption{color:var(--muted)}
small,figcaption,caption{font-size:var(--t-sm)}
table{border-collapse:collapse;font-size:.95em;line-height:1.4}
th,td{padding:6px 14px 6px 0;text-align:left;vertical-align:top;border-bottom:1px solid var(--line-strong);overflow-wrap:normal}
th{font-weight:600}
thead th,table>tr:first-child>th,tbody:first-child>tr:first-child>th{border-bottom:2px solid var(--fg);white-space:nowrap}
tbody:last-child>tr:last-child>*,table>tr:last-child>*{border-bottom:0}
tfoot>tr>*{border-top:2px solid var(--fg);border-bottom:0;font-weight:600}
th:last-child,td:last-child{padding-right:0}
caption{caption-side:top;text-align:left;padding-bottom:6px}
.num,[align=right]{text-align:right;font-variant-numeric:tabular-nums}
.num{white-space:nowrap}
.mid,[align=center]{text-align:center}
code,kbd,samp,pre{font-family:var(--mono);font-size:.86em}
:not(pre)>code{padding:1px 5px;border-radius:5px;background:var(--sunken)}
pre{padding:12px 14px;border:1px solid var(--line);border-radius:var(--r-md);background:var(--surface-2);overflow-x:auto;line-height:1.6}
kbd{padding:1px 6px;border:1px solid var(--line-strong);border-bottom-width:2px;border-radius:5px;background:var(--surface)}
mark{padding:0 3px;border-radius:3px;background:var(--st-working-soft);color:inherit}
details{padding:8px 12px;border:1px solid var(--line);border-radius:var(--r-md)}
summary{cursor:pointer;font-weight:600}details[open]>summary{margin-bottom:6px}details>:last-child{margin-bottom:0}
blockquote{padding-left:12px;border-left:2px solid var(--line-strong);color:var(--muted)}
hr{margin:1em 0;border:0;border-top:1px solid var(--line-strong)}
img,svg{max-width:100%;height:auto}figure>img{display:block;border-radius:var(--r-sm)}figcaption{margin-top:4px}
dt{font-weight:600}dd{margin:0 0 .5em}
input,button,select,textarea{font:inherit;color:inherit}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(160px,1fr))}
.cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}.cols-3{grid-template-columns:repeat(3,minmax(0,1fr))}
@media (max-width:440px){.cols-2,.cols-3{grid-template-columns:minmax(0,1fr)}}
.card{padding:12px 14px;border:1px solid var(--line-strong);border-radius:var(--r-md);background:var(--surface)}
.card>:first-child{margin-top:0}.card>:last-child{margin-bottom:0}
.tag{display:inline-block;padding:1px 8px;border-radius:999px;background:var(--sunken);color:var(--muted);font-size:var(--t-xs);font-weight:600;white-space:nowrap}
.good{color:var(--st-done)}.warn{color:var(--st-working)}.bad{color:var(--st-decision)}
.tag.good{background:var(--st-done-soft)}.tag.warn{background:var(--st-working-soft)}.tag.bad{background:var(--st-decision-soft)}
`

// The board's tokens as they are right now, light or dark: every custom property that tokens.css sets on :root.
let tokenNames = null
function tokens() {
  if (!tokenNames) {
    tokenNames = new Set()
    for (const sheet of document.styleSheets) {
      let rules = []
      try { rules = sheet.cssRules } catch { continue }   // a sheet from another origin (the fonts) is not ours to read
      for (const rule of rules) {
        if (!/^:root\b/.test(rule.selectorText ?? '')) continue
        for (const name of rule.style) if (name.startsWith('--')) tokenNames.add(name)
      }
    }
    if (!tokenNames.size) tokenNames = null
  }
  const root = getComputedStyle(document.documentElement)
  const dark = document.documentElement.dataset.theme === 'dark'
  // Drawn marks (data: pictures in a token) stay on the board.
  const vars = [...(tokenNames ?? [])].map(name => [name, root.getPropertyValue(name).trim()]).filter(([, v]) => v && !v.includes('url(')).map(([n, v]) => `${n}:${v}`)
  return { css: `:root{${vars.join(';')};font-size:${root.fontSize};color-scheme:${dark ? 'dark' : 'light'}}`, scheme: dark ? 'dark' : 'light' }
}

// The board's fonts, for the frames. A frame fetches nothing, so this page fetches them once (the same
// files it shows its own text with, from the stylesheet in its head) and hands them in as data: the
// Latin cut of the text face in two weights, the display face and the mono face. Until they are here, and
// where they cannot be had, a frame stands in the system's face.
const FACES = [['IBM Plex Sans', '400'], ['IBM Plex Sans', '600'], ['IBM Plex Mono', '400'], ['Bricolage Grotesque', null]]
let fontCss = ''
const fontsReady = typeof document === 'undefined' ? Promise.resolve() : (async () => {
  const sheet = document.querySelector('link[href*="fonts.googleapis.com/css"]')
  if (!sheet) return
  const css = await (await fetch(sheet.href, { credentials: 'omit' })).text()
  const faces = new Map()   // file -> { family, style, weights }
  for (const block of css.split('/*').filter(b => /^\s*latin\s*\*\//.test(b))) {
    const family = /font-family:\s*['"]([^'"]+)['"]/.exec(block)?.[1], weight = /font-weight:\s*(\d+)/.exec(block)?.[1]
    const style = /font-style:\s*(\w+)/.exec(block)?.[1] ?? 'normal', url = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/.exec(block)?.[1]
    if (!family || !url || style !== 'normal' || !FACES.some(([f, w]) => f === family && (w == null || w === weight))) continue
    const face = faces.get(url) ?? { family, weights: [] }
    face.weights.push(Number(weight))
    faces.set(url, face)
  }
  const rules = await Promise.all([...faces].map(async ([url, face]) => {
    const bytes = new Uint8Array(await (await fetch(url, { credentials: 'omit' })).arrayBuffer())
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    const weights = [Math.min(...face.weights), Math.max(...face.weights)]
    return `@font-face{font-family:"${face.family}";font-style:normal;font-weight:${weights[0] === weights[1] ? weights[0] : weights.join(' ')};font-display:swap;src:url(data:font/woff2;base64,${btoa(binary)}) format("woff2")}`
  }))
  fontCss = rules.join('')
  for (const ref of live.values()) ref.deref()?.contentWindow?.postMessage({ trommiFonts: fontCss }, '*')
})().catch(() => {})

// The one script in a frame. It reports the height of the content (and whether it is wider than the
// frame), takes new tokens when the theme changes and the fonts when they are here, and hands a clicked link to the page around it.
const inside = id => `(()=>{
const id=${JSON.stringify(id)},root=document.documentElement
let last=''
const tell=()=>{const h=Math.ceil(root.getBoundingClientRect().height),wide=root.scrollWidth>root.clientWidth+1,now=h+'|'+wide;if(now===last)return;last=now;parent.postMessage({trommiRich:id,h,wide},'*')}
new ResizeObserver(tell).observe(root)
addEventListener('load',tell)
addEventListener('toggle',()=>requestAnimationFrame(tell),true)
tell()
addEventListener('message',e=>{if(e.source!==parent||!e.data)return;for(const k of ['trommiTokens','trommiFonts'])if(typeof e.data[k]==='string')document.getElementById(k==='trommiTokens'?'trommi-tokens':'trommi-fonts').textContent=e.data[k];last='';tell()})
addEventListener('click',e=>{const a=e.target&&e.target.closest&&e.target.closest('a[href],area[href]');if(!a)return;e.preventDefault();const href=a.getAttribute('href');if(href.charAt(0)==='#'){const to=href.length>1&&document.getElementById(href.slice(1));if(to)to.scrollIntoView();return}parent.postMessage({trommiRich:id,open:a.href},'*')},true)
})()`

const POLICY = nonce => `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'`

function documentOf(body, id, large) {
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${POLICY(nonce)}"><meta name="referrer" content="no-referrer"><style id="trommi-fonts">${fontCss}</style><style id="trommi-tokens">${tokens().css}</style><style>${HOUSE}${large ? 'body{padding:20px 24px}' : ''}</style></head><body>${body}<script nonce="${nonce}">${inside(id)}</script></body></html>`
}

// The frames that stand in the page, by the name their script signs with.
const live = new Map()   // id -> WeakRef(frame)
let seq = 0
// How tall a block came out, so that it is drawn again at that height at once (lists are redrawn often).
const heights = new Map()   // key of the source -> px
const keyOf = source => { let h = 0; for (let i = 0; i < source.length; i += 1 + (source.length >> 12)) h = (h * 31 + source.charCodeAt(i)) | 0; return `${source.length}:${h}:${Math.round(innerWidth / 40)}` }
const frameCap = () => Math.max(240, Math.round(innerHeight * 0.7))

// What the place a frame stands in adds to the tokens: its size of type and its ink (a question window
// sets its text a little larger than a conversation, details are greyer).
function dress(frame) {
  const { css, scheme } = tokens()
  const host = frame.parentElement && frame.dataset.large == null ? getComputedStyle(frame.parentElement) : null
  frame.style.colorScheme = scheme
  frame.contentWindow?.postMessage({ trommiTokens: host ? `${css}html{font-size:${host.fontSize}}body{color:${host.color}}` : css }, '*')
}

function fit(frame, h, wide) {
  if (frame.dataset.large != null) return
  // A sideways scroll bar takes room of its own.
  const need = wide == null ? h : Math.max(24, h + (wide ? 14 : 0))
  heights.set(frame.dataset.key, need)
  frame.dataset.need = need
  frame.style.height = `${Math.min(need, frameCap())}px`
  frame.parentElement?.classList.toggle('is-capped', need > frameCap())
  if (wide != null) frame.parentElement?.classList.toggle('is-wide', wide)
}

if (typeof window !== 'undefined') {
  addEventListener('message', e => {
    const said = e.data
    if (!said || typeof said.trommiRich !== 'string') return
    const frame = live.get(said.trommiRich)?.deref()
    // Only the frame that was given this name may speak under it.
    if (!frame || e.source !== frame.contentWindow) return
    // Its first word: it stands in the page now, so it can be told how the text around it is set.
    if (frame.dataset.met == null) { frame.dataset.met = ''; dress(frame) }
    if (Number.isFinite(said.h)) fit(frame, Math.min(Math.max(0, said.h), 100000), said.wide === true)
    else if (typeof said.open === 'string' && /^https?:\/\//i.test(said.open)) window.open(said.open, '_blank', 'noopener,noreferrer')
  })
  // The theme changed: every frame gets the new tokens, without being loaded again.
  new MutationObserver(() => {
    for (const [id, ref] of live) {
      const frame = ref.deref()
      if (!frame?.isConnected) { if (!frame) live.delete(id); continue }
      dress(frame)
    }
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  // The window changed: most of the screen is another height now.
  addEventListener('resize', () => {
    for (const ref of live.values()) {
      const frame = ref.deref()
      if (frame?.isConnected && frame.dataset.need) fit(frame, Number(frame.dataset.need), null)
    }
  })
}

function frameOf(body, source, large = false) {
  for (const [id, ref] of live) if (!ref.deref()) live.delete(id)
  const id = `r${++seq}-${Math.random().toString(36).slice(2, 10)}`
  const frame = el('iframe', 'rh-frame')
  // Scripts, and nothing else: no origin, no forms, no popups, no navigation of the page around it.
  frame.setAttribute('sandbox', 'allow-scripts')
  frame.referrerPolicy = 'no-referrer'
  frame.title = 'Layout from the agent'
  frame.style.colorScheme = tokens().scheme
  frame.dataset.key = keyOf(source)
  if (large) frame.dataset.large = ''
  else frame.style.height = `${Math.min(heights.get(frame.dataset.key) ?? 96, frameCap())}px`
  frame.srcdoc = documentOf(body, id, large)
  live.set(id, new WeakRef(frame))
  return frame
}

// The big view: the same block in the same sandboxed frame, over the whole window (a bar with Close; Escape closes).
function openLarge(body, text) {
  const stage = el('div', 'rh-large')
  stage.setAttribute('role', 'dialog')
  stage.setAttribute('aria-label', 'Layout from the agent, large')
  const close = el('button', 'rh-large-close', 'Close')
  close.type = 'button'
  const bar = el('div', 'rh-large-bar')
  bar.append(el('span', 'rh-large-name', 'From the agent'), close)
  stage.append(bar, frameOf(body, text, true))
  const shut = () => { stage.remove(); removeEventListener('keydown', key, true) }
  const key = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); shut() } }
  close.addEventListener('click', shut)
  addEventListener('keydown', key, true)
  document.body.append(stage)
  close.focus()
}

/** A block of HTML from an agent, shown at its place: a sandboxed frame as tall as its content, up to
 *  most of the screen (beyond that it scrolls inside), with "Open large". Returns a div.rh. */
function htmlBlock(source) {
  const text = String(source ?? '')
  const { body, kind } = parse(text)
  const box = el('div', `rh rh-${kind}`)
  box.dataset.rich = kind
  const frame = frameOf(body, text)
  const open = el('button', 'rh-open', 'Open large')
  open.type = 'button'
  open.addEventListener('click', e => { e.stopPropagation(); openLarge(body, text) })
  if ((heights.get(frame.dataset.key) ?? 0) > frameCap()) box.classList.add('is-capped')
  box.append(frame, open)
  return box
}

// ---- controller "richhtml" ----
// A layout the agent sent along (a block fenced as html): shown in the sandboxed frame of ui.mjs,
// never as markup of this page. The hub put the source into the value, escaped.

controller('richhtml', class extends Controller {
  static values = { source: String }
  connect() { this.element.replaceChildren(htmlBlock(this.sourceValue)) }
})

// ---- controller "copy" ----
// A button that copies: the text of its "source" target (a code block), or its text value (a link; one that begins
// with "/" is made whole with this page's address). The "label" target says for a moment whether it worked.

/** Copies text; true when it worked. (The Clipboard API needs a secure context; the board is often open over plain http.) */
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true } catch {}
  const area = document.createElement('textarea')
  area.value = text
  area.readOnly = true
  area.className = 'offscreen'
  document.body.append(area)
  area.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch {}
  area.remove()
  return ok
}

controller('copy', class extends Controller {
  static targets = ['source', 'label']
  static values = { text: String, word: { type: String, default: 'Copy' } }
  disconnect() { clearTimeout(this.timer) }
  async copy() {
    const text = this.hasTextValue && this.textValue ? (this.textValue.startsWith('/') ? new URL(this.textValue, location.href).href : this.textValue) : this.sourceTarget.textContent
    const ok = await copyText(text)
    if (!this.hasLabelTarget) return
    this.labelTarget.textContent = ok ? 'Copied' : 'Not copied'
    this.element.classList.toggle('is-done', ok)
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.labelTarget.textContent = this.wordValue; this.element.classList.remove('is-done') }, 1800)
  }
})

// ---- controller "clip" ----
// Copy a card as one line ("Nr. 12 · title → answer") to paste into another agent. It is also kept for this
// tab under the old client's key, so a composer can offer it as a chip.

const KEY = 'trommi-cardclip'
controller('clip', class extends Controller {
  static values = { text: String, card: Object }
  async copy(event) {
    event.preventDefault()
    event.stopPropagation()
    try { sessionStorage.setItem(KEY, JSON.stringify({ ...this.cardValue, text: this.textValue })) } catch {}
    try { await navigator.clipboard.writeText(this.textValue) } catch {}
    this.element.classList.add('is-done')
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.element.classList.remove('is-done'), 1400)
  }
  disconnect() { clearTimeout(this.timer) }
})

// ---- controller "title" ----
// The count in the browser's tab title, "(8) Desk · Trommi": it follows the live stream. An element the stream
// replaces when the count changes carries it (<header id="desk-head" data-controller="title" data-title-count-value="8">);
// the new element connects and writes the title.

controller('title', class extends Controller {
  static values = { count: Number }

  countValueChanged() {
    const rest = document.title.replace(/^\(\d+\)\s*/, '')
    document.title = this.countValue > 0 ? `(${this.countValue}) ${rest}` : rest
  }
})

// ---- controller "pops" ----
// Small things that open right at their control: <details class="t-pick"> with its content
// lying over the page (rename, the drawings, a choice of desk or main agent, the phone's sheet of a line).
// The hub renders them; this only does what <details> does not do by itself:
//   - Escape or a click beside it closes; opening one closes the others; a "Cancel"/"Close" (data-pop-close) closes
//   - the keyboard goes into the field of the one that opened, its text selected
//   - while one is open, the live stream does not replace the element it stands in (he may be typing):
//     what came is held and applied when it closes
//   - "/" goes to the Agents page's find field
// Any element with data-controller="pops" loads this. The controls may stand anywhere in the page and are replaced
// by streams, so the listeners hang on the document: added when the first such element connects, removed with the last.

const opened = () => [...document.querySelectorAll('details.t-pick[open]')]
const held = new Map()   // "action target" -> the stream element that waits

function flush() {
  if (!held.size || opened().length) return
  const waiting = [...held.values()]
  held.clear()
  for (const el of waiting) document.documentElement.append(el)
}
function close(pick, { focus = false } = {}) {
  if (!pick?.open) return
  pick.open = false
  if (focus) pick.querySelector(':scope > summary')?.focus({ preventScroll: true })
}

function onToggle(e) {
  const pick = e.target
  if (!(pick instanceof HTMLDetailsElement) || !pick.matches('details.t-pick')) return
  if (!pick.open) return flush()
  for (const other of opened()) if (other !== pick && !other.contains(pick)) other.open = false
  const field = pick.querySelector('input[type="text"]')
  if (field && field.getClientRects().length && !matchMedia('(max-width: 860px)').matches) { field.focus({ preventScroll: true }); field.select() }
}

function onClick(e) {
  const t = e.target instanceof Element ? e.target : null
  if (!t) return
  if (t.closest('[data-pop-close]')) return close(t.closest('details.t-pick'), { focus: true })
  for (const pick of opened()) if (!pick.contains(t)) pick.open = false
}

function onKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return
  if (e.key === 'Escape') {
    const last = opened().at(-1)
    if (last) { e.preventDefault(); e.stopPropagation(); close(last, { focus: true }) }
    return
  }
  const typing = e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
  if (e.key === '/' && !typing && !opened().length) {
    const find = document.querySelector('.ledger-find input')
    if (find) { e.preventDefault(); find.focus(); find.select() }
  }
}

// A form that was sent has done its work: its control closes, so the answer and the live stream can land.
function onSubmit(e) {
  for (let pick = e.target.closest?.('details.t-pick'); pick; pick = pick.parentElement?.closest('details.t-pick')) pick.open = false
}

function onStream(e) {
  const el = e.target, open = opened()
  if (!open.length || !el?.getAttribute) return
  const action = el.getAttribute('action'), target = el.getAttribute('target')
  const node = target ? document.getElementById(target) : null
  const hits = action === 'refresh' ? true : Boolean(node) && open.some(pick => node.contains(pick))
  if (!hits) return
  e.preventDefault()
  held.set(`${action} ${target ?? ''}`, el.cloneNode(true))
}

const LISTENERS = [['toggle', onToggle, true], ['click', onClick, false], ['keydown', onKey, true], ['turbo:submit-start', onSubmit, false], ['turbo:before-stream-render', onStream, false]]
let connected = 0

controller('pops', class extends Controller {
  connect() { if (connected++ === 0) for (const [name, fn, capture] of LISTENERS) document.addEventListener(name, fn, capture) }
  disconnect() { if (--connected === 0) for (const [name, fn, capture] of LISTENERS) document.removeEventListener(name, fn, capture) }
})

// ---- controller "later" ----
// A <details> whose content is made only when it opens (agents.mjs, ui.mjs LATER): the lists
// of an Agents line (lay together with…, main agent, desk, the phone's sheet) wait in a <template>; the grid of
// forty drawings is made here from ui.mjs marksFrame. A page of many sessions would otherwise carry
// thousands of elements nobody opened.

const mine = (el, root) => el.parentElement.closest('details') === root
controller('later', class extends Controller {
  fill() {
    if (!this.element.open) return
    for (const t of this.element.querySelectorAll('template')) if (mine(t, this.element)) t.replaceWith(t.content)
    const places = [...this.element.querySelectorAll('.marks-later')].filter(p => mine(p, this.element))
    if (!places.length) return
    for (const p of places) {
      const { agent, base, opts } = JSON.parse(p.dataset.marks)
      p.outerHTML = String(marksFrame(agent, base, opts))
    }
  }
})

// ---- controller "assetthumb" ----
// A published page (session.mjs): its first screen on the card, or the whole page in the viewer (full).
// The page is fetched from /att/<id> (decrypted in this browser, app.mjs) once it comes near the screen and
// shown in the sandboxed frame /frame.html (no origin, no network, its own CSP; it gets the page as one message).
// Until then, and when anything fails, the drawn kind stays.

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

controller('assetthumb', class extends Controller {
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
    frame.src = '/frame'
    this.element.prepend(frame)
  }
})

// ---- session edit ----
// What the human changes on a session, as small forms that stand right where they are used:
// rename (a form under the name: Enter saves, Escape closes), the drawing (a grid under the mark, fetched when
// it is first opened). No veil, no dialog: each is a <details> whose content lies over the page; the controller
// "pops" (controller "pops") closes it on Escape or a click beside it and puts the keyboard in the field.
// The forms post to <base>/sessions/<id>/edit (agents.mjs), which hands them to the hub's own rules.
//
// Used by the Agents page (agents.mjs) and, through sessionHeadEdit(), by a session's heading.

/** The address of a session's forms. */
export const sessionForms = (agent, base) => `${base}/sessions/${encodeURIComponent(agent.id)}`

/** How a form is answered. stay: the page stays as it is (the live stream brings the change);
 *  back: the page to show afterwards (a path under base), where there is no live piece for the change. */
export const answerFields = ({ stay = false, back = '' } = {}) => html`${stay ? raw('<input type="hidden" name="stay" value="1">') : ''}${back ? html`<input type="hidden" name="back" value="${back}">` : ''}`

/** The name as the control that renames. label: what stands in the control (default: the name, strong). */
export function renameControl(agent, base, { stay = false, back = '', cls = 'ledger-rename', label = null } = {}) {
  const field = `session-name-${agent.id}`
  return html`<details class="t-pick t-pick-name"><summary class="${cls}" data-ledger="rename" title="Rename" aria-label="${agent.name}: rename">${label ?? html`<strong>${agent.name}</strong>`}</summary>
<div class="session-editor t-pop"><form method="post" action="${sessionForms(agent, base)}/edit" data-turbo-frame="_top">${answerFields({ stay, back })}<label class="caps" for="${field}">Rename the session</label><input type="text" id="${field}" name="label" value="${agent.name}" maxlength="60" autocomplete="off" enterkeyhint="done" aria-label="Name of the session"><div class="session-buttons"><button type="button" data-pop-close>Cancel</button><button type="submit" class="is-lead">Save</button></div></form></div></details>`
}

const framed = (agent, where) => `marks-${where ? `${where}-` : ''}${agent.id}`

/** The grid of drawings, as the frame that the picker fetches when it is opened. */
export function marksFrame(agent, base, { stay = false, back = '', where = '' } = {}) {
  return html`<turbo-frame id="${framed(agent, where)}"><form method="post" action="${sessionForms(agent, base)}/edit" data-turbo-frame="_top">${answerFields({ stay, back })}<div class="mark-grid" role="radiogroup" aria-label="Drawing">${DRAWINGS.map(name => html`<button class="mark-tile" type="submit" name="icon" value="${drawingMark(name)}" role="radio" aria-checked="${String(agent.mark === drawingMark(name))}" aria-label="${name}" title="${name}" style="--hue:${drawingHue(name)}">${raw(doodleSvg(drawingMark(name)))}</button>`)}</div></form></turbo-frame>`
}

/** The place of the grid of drawings: made in the page when its <details> opens (that <details> carries LATER;
 *  controller "later" calls marksFrame with what this names). Forty drawings per session are not made before. */
export const marksHolder = (agent, base, { stay = false, back = '', where = '' } = {}) => html`<div class="marks-later" data-marks="${JSON.stringify({ agent: { id: agent.id, mark: agent.mark ?? '' }, base, opts: { stay, back, where } })}"><p class="t-pop-wait">Drawings…</p></div>`
/** On a <details> whose content waits in a <template> until it opens. */
export const LATER = raw(' data-controller="later" data-action="toggle->later#fill"')

/** The mark as the control that opens the drawings. (Without a crown: where the crown is shown, it is a control of its own.) */
export function markControl(agent, base, { stay = false, back = '', cls = 'ledger-mark' } = {}) {
  return html`<details class="t-pick t-pick-mark"${LATER}><summary class="${cls}" data-ledger="mark" title="Choose a drawing" aria-label="${agent.name}: choose a drawing">${avatar(agent, { crown: false })}</summary>
<div class="mark-picker t-pop">${marksHolder(agent, base, { stay, back })}</div></details>`
}

/**
 * For a session's heading: its mark (opens the drawings) and its name (renames), side by side.
 * back: the path of the page that shows the heading; the form answers with a redirect to it.
 * Pass stay: true instead where the heading is kept current by the page's own live stream.
 */
export const sessionHeadEdit = (agent, base, { back = '', stay = false } = {}) => html`<span class="t-session-edit" data-controller="pops">${markControl(agent, base, { stay, back, cls: 't-head-mark' })}${crownControl(agent, base, { stay, back })}${renameControl(agent, base, { stay, back, cls: 't-head-name' })}</span>`

/** The crown as a switch on the corner of the mark: one per desk, given by his hand (the hub takes it from whoever wore it). */
const crownControl = (agent, base, { stay = false, back = '' } = {}) => html`<form class="t-crown-form" method="post" action="${sessionForms(agent, base)}/star">${answerFields({ stay, back })}<button class="crown-toggle" type="submit" name="starred" value="${agent.starred ? '0' : '1'}" aria-pressed="${String(Boolean(agent.starred))}" title="${agent.starred ? 'Wears the crown of its desk. Click to take it off' : 'Give the crown'}" aria-label="${agent.name}: ${agent.starred ? 'wears the crown of its desk, take it off' : 'give the crown'}">${raw(crownSvg())}</button></form>`

// ---- keys ----
// The one table that says what the keys of the server-rendered board do. Read by the controller that listens
// (controller "keys") and by the hub for the "?" sheet (ui.mjs), so what the sheet
// lists and what works cannot drift apart. Plain data and two helpers: nothing here touches a page.

/** scope: where the keys count ('desk' | 'card' | 'picture' | 'agents' | 'app'). keys: 'j', 'ArrowDown', 'g d' (g, then d),
 *  '1…9' (any of them; the action gets the number), 'Mod+k'. repeat: may fire while held. typing: also in a field.
 *  needs: listed and taken only where the page has it ('sidebar': the sessions' list; 'desks': the menu's desks,
 *  and not on the Agents page, where D is a line's drawing). native: listed, handled where it lives (the key is left alone). verb: the longer wording for the sheet. */
const LAYOUT = [
  { scope: 'desk', title: 'On the Desk', keys: [
    { id: 'list.next', keys: ['j', 'ArrowDown'], does: 'next question; after the last, an opened stack below', repeat: true },
    { id: 'list.prev', keys: ['k', 'ArrowUp'], does: 'previous question', repeat: true },
    { id: 'list.first', keys: ['Home'], does: 'first question' },
    { id: 'list.last', keys: ['End'], does: 'last question' },
    { id: 'list.open', keys: ['Enter', 'c'], does: 'open the question on its own page' },
    { id: 'list.later', keys: ['l'], does: 'Later; on one put off: fetch it back' },
    { id: 'list.revise', keys: ['b'], does: 'Reverse: back to the agent' },
    { id: 'list.trust', keys: ['r'], does: 'Duck it: the agent decides' },
    { id: 'list.shred', keys: ['x'], does: 'Shred: throw it away unanswered' },
    { id: 'list.takeback', keys: ['u', 'Backspace'], does: 'take back: the marked line of a stack, else the newest toast\'s Undo' },
    { id: 'list.leave', keys: ['Escape'], does: 'drop the mark' },
  ] },
  { scope: 'card', title: 'An opened question', keys: [
    { id: 'ans.down', keys: ['ArrowDown'], does: 'through the answers: the options, the duck, What??, Reverse (first press: the first, or the advised one)', repeat: true },
    { id: 'ans.up', keys: ['ArrowUp'], does: 'back through the answers (first press: the last)', repeat: true },
    { id: 'ans.right', keys: ['ArrowRight'], does: 'on What??: over to Reverse' },
    { id: 'ans.left', keys: ['ArrowLeft'], does: 'on Reverse: over to What??' },
    { id: 'card.send', keys: ['Enter'], does: 'take the marked answer; tick it where several are allowed, or send when none is marked' },
    // (no letters here: on a question's own page a letter is writing, it goes into the field; see typeToField)
    { id: 'card.back', keys: ['Backspace'], does: 'undo: the newest toast\'s Undo, else this answer or the hand-back' },
    { id: 'card.next', keys: ['ArrowRight'], does: 'next question, without answering', repeat: true },
    { id: 'card.prev', keys: ['ArrowLeft'], does: 'previous question', repeat: true },
    { id: 'card.pic.next', keys: ['Shift+ArrowRight'], does: 'next picture', repeat: true },
    { id: 'card.pic.prev', keys: ['Shift+ArrowLeft'], does: 'previous picture', repeat: true },
    { id: 'card.leave', keys: ['Escape'], does: 'leave a field, full screen, then back to the Desk', typing: true },
  ] },
  { scope: 'picture', title: 'A picture', keys: [
    { id: 'ans.down', keys: ['ArrowDown'], does: 'through the answers beside the picture', repeat: true },
    { id: 'ans.up', keys: ['ArrowUp'], does: 'back through the answers', repeat: true },
    { id: 'card.send', keys: ['Enter'], does: 'take the marked answer' },
    { id: 'pic.next', keys: ['ArrowRight', 'j'], does: 'next picture', repeat: true },
    { id: 'pic.prev', keys: ['ArrowLeft', 'k'], does: 'previous picture', repeat: true },
    { id: 'pic.leave', keys: ['Escape'], does: 'back to the question' },
  ] },
  { scope: 'agents', title: 'On the Agents page', keys: [
    { id: 'ledger.next', keys: ['ArrowDown', 'j'], does: 'next session', repeat: true },
    { id: 'ledger.prev', keys: ['ArrowUp', 'k'], does: 'previous session', repeat: true },
    { id: 'ledger.open', keys: ['Enter'], does: 'open its conversation' },
    { id: 'ledger.walk', keys: ['q'], does: 'its questions, one after the other' },
    { id: 'ledger.rename', keys: ['r'], does: 'rename' },
    { id: 'ledger.mark', keys: ['d'], does: 'another drawing' },
    { id: 'ledger.crown', keys: ['c'], does: 'crown: its questions come first' },
    { id: 'ledger.pair', keys: ['+'], does: 'lay together with another' },
    { id: 'ledger.archive', keys: ['a'], does: 'archive a disconnected one; fetch an archived one back' },
    { id: 'ledger.down', keys: ['Shift+ArrowDown'], does: 'move it down' },
    { id: 'ledger.up', keys: ['Shift+ArrowUp'], does: 'move it up' },
    { id: 'ledger.find', keys: ['/'], does: 'find a session', native: true },
    { id: 'ledger.leave', keys: ['Escape'], does: 'close what is open, then drop the mark' },
  ] },
  { scope: 'app', title: 'Anywhere', keys: [
    { id: 'help', keys: ['?'], does: 'this list' },
    { id: 'note.new', keys: ['n'], does: 'a new note' },
    { id: 'go.desk', keys: ['g d', 'g i'], does: 'Desk', verb: 'go to the Desk' },
    { id: 'go.agents', keys: ['g a'], does: 'Agents', verb: 'go to the Agents page' },
    { id: 'go.jump', keys: ['Mod+k', 'g j'], does: 'menu', verb: 'open the Trommi menu: desks and places' },
    { id: 'go.walk', keys: ['g b'], does: 'Blitz', verb: 'Blitz: every open question, one after the other' },
    // 1…9 alone are the desks'; G then 1…9 are the sessions'.
    { id: 'go.session', keys: ['g 1…9'], does: 'session 1 to 9', verb: 'go to that session of the sidebar', needs: 'sidebar' },
    { id: 'desk.switch', keys: ['1…9'], does: 'desk 1 to 9', verb: 'switch to that desk', needs: 'desks' },
    { id: 'session.next', keys: ['.'], does: 'next session', needs: 'sidebar' },
    { id: 'session.prev', keys: [','], does: 'previous session', needs: 'sidebar' },
    { id: 'pen', keys: ['p'], does: 'turn the page: the Scribble Board on the back of the Desk, and back' },
    { id: 'rail', keys: ['['], does: 'fold the sidebar to a rail, or open it', needs: 'sidebar' },
    { id: 'back', keys: ['u', 'Backspace'], does: 'undo: the newest toast\'s Undo' },
    { id: 'theme', keys: ['t'], does: 'light or dark' },
    { id: 'field.leave', keys: ['Escape'], does: 'leave a field', typing: true },
  ] },
]

/** The scopes that listen on a view, first to hear first. */
/** The short list (card Nr. 200): the keys the "?" sheet and the help page show. Everything else in LAYOUT still
 *  works, but is not listed yet ("More keys later"). */
export const SHORT = [
  { id: 'move', keys: ['ArrowUp', 'ArrowDown'], does: 'move: the next or the previous question; on a card its answers (← → there: the questions)' },
  { id: 'open', keys: ['Enter'], does: 'open; on a card: take the marked answer' },
  { id: 'back', keys: ['Escape'], does: 'back: leave a field, close, back to the Desk' },
  { id: 'note.new', keys: ['n'], does: 'a new note' },
  { id: 'later', keys: ['l'], does: 'Later: put the question off (on the Desk; on a card a letter goes into the field)' },
  { id: 'help', keys: ['?'], does: 'this list' },
]

const scopesOf = view => (['desk', 'card', 'picture', 'agents'].includes(view) ? [view, 'app'] : ['app'])

const NAMES = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc', ' ': 'Space', Delete: 'Del', Backspace: '⌫' }
/** One part of a key ('Shift+ArrowUp', 'g', 'Mod+k') as the caps it is printed on. mod: what "Mod" is on this machine. */
export const capOf = (part, mod = 'Ctrl') => part.split('+').map(p => (p === 'Mod' ? mod : p === 'Shift' ? '⇧' : NAMES[p] ?? (p.length === 1 ? p.toUpperCase() : p)))

// ---- keys ----
// The sheet behind "?": the keys of the view that is up, rendered by the hub from the one table of keys
// (ui.mjs (keys); controller "keys" listens for them). No veil: a <dialog> with a clear backdrop
// (app.css); "?" , Escape, its Close button or a click beside it closes. The whole table: /help.html#keys.
// pageSheets() is what the layout includes: this sheet, and on the Desk the sheet a long press on a row brings up.

// One key as caps: 'g d' is G then D; "Mod" is Ctrl here and ⌘ on a Mac (the controller swaps the cap marked data-mod).
const caps = spec => html`<span class="keys-caps">${(spec === ' ' ? [spec] : spec.split(' ')).map((part, i) => html`${i ? html`<i>then</i>` : ''}${capOf(part).map(text => (text === 'Ctrl' ? html`<kbd data-mod>Ctrl</kbd>` : html`<kbd>${text}</kbd>`))}`)}</span>`

/** The groups of the table that count on a view, first to hear first. has: { sidebar, desks } (what the page carries). */
function keyGroups(view, has = {}) {
  const scopes = scopesOf(view)
  return scopes.map(scope => LAYOUT.find(g => g.scope === scope)).filter(Boolean)
    .map(g => ({ title: g.title, keys: g.keys.filter(k => !k.needs || has[k.needs]) }))
    .filter(g => g.keys.length)
}

/** The key sheet of a view. sidebar: the page shows the sessions and the Trommi menu. */
export function keySheet(view, { sidebar = true } = {}) {
  void view; void sidebar   // (one short list for every view, card Nr. 200; keyGroups() keeps the whole table per view)
  return html`<dialog class="keys-sheet" id="keys-sheet" data-controller="keys" data-action="click->keys#beside" aria-labelledby="keys-sheet-title">
<header><h2 id="keys-sheet-title">Keys</h2><form method="dialog"><button class="keys-close" type="submit">Close<kbd>Esc</kbd></button></form></header>
<div class="keys-groups"><section><dl>${SHORT.map(k => html`<div><dt>${k.keys.map((spec, i) => html`${i ? html`<i>or</i>` : ''}${caps(spec)}`)}</dt><dd>${k.does}</dd></div>`)}</dl></section></div>
<p class="keys-foot">More keys later. Keys rest while you type in a field. <a href="/help.html#keys">On the help page</a></p>
</dialog>`
}


// ---- controller "keys" ----
// The keyboard of the server-rendered board: the one listener. What the keys do is the table in ui.mjs (keys).
// A key does what a click would do: it follows a link or presses a button of a form the hub rendered. Nothing
// here knows the board's state. The controller hangs on the "?" sheet, which every page has (ui.mjs).
//
// Rules, for every key in the table:
//   - plain keys and "g then x" sequences only; nothing with Ctrl, Alt or Cmd is taken (one exception: Ctrl/Cmd+K, jump)
//   - nothing happens while typing in a field (only Escape, which leaves it)
//   - nothing happens while a dialog owns the keyboard (a sheet, a picture, a canvas with [data-owns-keys])
//   - Enter and Space on a button or link stay that control's own
//   - a key held down repeats only where that is harmless (moving), never an answer
//
// P leads to the Whiteboard with the pen in hand (its page's controller "whiteboard" hears "trommi:pen").

// The mark and a sequence under way outlive a page: they are this module's, not a controller's.
let listening = null   // the AbortController of the listeners, while a sheet is connected
let sheets = 0

controller('keys', class extends Controller {
  connect() { if (sheets++ === 0) { listening = new AbortController(); start(listening.signal) } }
  disconnect() { if (--sheets === 0) { listening.abort(); listening = null } }
  /** A click beside the sheet closes it (data-action on the dialog). */
  beside(event) { if (event.target === this.element) this.element.close() }
})

function start(signal) {
  const on = (target, name, fn, capture = false) => target.addEventListener(name, fn, { signal, capture })
  const SEQUENCE_MS = 1600
  const MARK_KEY = 'trommi-mark'
  const MAC = /Mac|iPhone|iPad/.test(navigator.platform)
  const $ = (sel, root = document) => root.querySelector(sel)
  const base = () => document.body.dataset.tBase ?? ''
  const view = () => document.body.dataset.tView ?? ''
  const shown = node => Boolean(node && !node.closest('[hidden], [inert]') && node.getClientRects().length)
  const typingIn = node => Boolean(node?.closest?.('input:not([type=checkbox], [type=radio], [type=button], [type=submit]), textarea, select, [contenteditable]:not([contenteditable="false"])'))
  /** A character typed on a question's page outside any field: into the card's field, at its end. */
  function typeToField(e) {
    if (view() !== 'card' || e.key.length !== 1 || e.key === ' ' || e.key === '?') return false
    const field = $('.tc-field')
    if (!field || !shown(field) || field.disabled) return false
    field.focus({ preventScroll: true })
    field.setRangeText(e.key, field.value.length, field.value.length, 'end')
    field.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }
  const isControl = node => Boolean(node?.closest?.('button, a[href], summary, [role="button"]'))
  /** Go to a page the way a click on a link does (Turbo for the pages rendered here, a whole load for the others: t/boot.js). */
  function go(path) {
    const a = document.createElement('a')
    a.href = path
    a.style.display = 'none'
    document.body.append(a)
    a.click()
    a.remove()
  }
  /** Press what the hub rendered: a button of a form, or a link. false: there is none here. */
  const press = node => { if (!node || node.disabled) return false; node.click() }
  const ANSWERS = '.tc-answer .tc-opts > button.tc-opt, .tc-answer .tc-opts > label.tc-opt > input, .tc-answer .tc-whatever, .tc-answer .tc-info-ways .tc-tile, .tc-answer .tc-wtf, .tc-answer .tc-reverse'
  const markAnswer = node => { if (!node) return false; node.focus({ preventScroll: true, focusVisible: true }); (node.closest('.tc-opt') ?? node).scrollIntoView({ block: 'nearest' }) }
  function walkAnswers(step) {
    const list = [...document.querySelectorAll(ANSWERS)].filter(n => !n.disabled && n.getClientRects().length)
    if (!list.length) return false
    const at = list.indexOf(document.activeElement)
    if (at >= 0) return markAnswer(list[(at + step + list.length) % list.length])
    return markAnswer(step > 0 ? list.find(n => n.closest('.is-advised')) ?? list[0] : list.at(-1))
  }

  // ---- the mark on the Desk: which row the keyboard is on ----
  // Kept by the card's id (and its place, for when that card leaves), so it holds across stream updates and page changes.
  // The Agents page has the same mark on its lines; each list keeps its own.
  const LISTS = { desk: '#desk-list .inbox-row, #desk-list .inbox-pile.is-open .inbox-done', agents: '#ledger-list .ledger-line[data-id]' }
  const HOSTS = '#desk-list .is-current, #ledger-list .is-current'
  const marks = {}   // view -> { id, pile, at }
  try { Object.assign(marks, JSON.parse(sessionStorage.getItem(MARK_KEY))) } catch {}
  const keep = () => { try { sessionStorage.setItem(MARK_KEY, JSON.stringify(marks)) } catch {} }
  const rows = () => (LISTS[view()] ? [...document.querySelectorAll(LISTS[view()])].filter(shown) : [])
  const current = () => { const row = $(HOSTS); return shown(row) ? row : null }
  const CAPS = [['.inbox-actions .inbox-answer.is-lead', 'Y'], ['.inbox-actions button.inbox-answer:not(.is-lead)', 'N'], ['.inbox-later', 'L'], ['.inbox-takeback', 'U']]
  function show(row, { focus = true } = {}) {
    for (const old of document.querySelectorAll(HOSTS)) if (old !== row) old.classList.remove('is-current')
    if (!row) return
    row.classList.add('is-current')
    // On the marked row the controls wear their keys (app.css).
    for (const [sel, cap] of CAPS) for (const node of row.querySelectorAll(sel)) node.dataset.cap = cap
    if (focus) { if (!row.hasAttribute('tabindex')) row.tabIndex = -1; row.focus({ preventScroll: true }); row.scrollIntoView({ block: 'nearest' }) }
  }
  function setMark(row) {
    if (row) marks[view()] = { id: row.dataset.id, pile: row.matches('.inbox-done'), at: rows().indexOf(row) }; else delete marks[view()]
    keep()
    show(row)
  }
  /** After the page changed (a stream, a visit, a refresh): the mark is where it was; if its card left, on the row that took its place. */
  function restore() {
    const mark = marks[view()]
    if (!mark || !LISTS[view()]) return
    const all = rows()
    const same = all.find(r => r.dataset.id === mark.id && r.matches('.inbox-done') === mark.pile)
    const row = same ?? all[Math.min(mark.at, all.length - 1)] ?? null
    if (!row) return show(null)
    if (!same) { marks[view()] = { id: row.dataset.id, pile: row.matches('.inbox-done'), at: all.indexOf(row) }; keep() } else mark.at = all.indexOf(row)
    if (row.classList.contains('is-current')) return
    // The keyboard follows only when nothing else holds it (a field someone types in keeps it).
    show(row, { focus: !document.activeElement || document.activeElement === document.body })
  }
  let queued = false
  const later = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; restore() }) }
  const watch = new MutationObserver(later)
  watch.observe(document.documentElement, { childList: true, subtree: true })
  signal.addEventListener('abort', () => watch.disconnect())
  for (const name of ['turbo:load', 'turbo:render', 'turbo:morph']) on(document, name, later)   // a morph takes the class off without moving a node
  // A page kept for the Back button holds no open sheet, and no mark of a moment ago.
  on(document, 'turbo:before-cache', () => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); for (const n of document.querySelectorAll(HOSTS)) n.classList.remove('is-current') })
  function step(by) {
    const all = rows()
    if (!all.length) return false
    const at = all.indexOf(current())
    setMark(all[at < 0 ? (by > 0 ? 0 : all.length - 1) : Math.min(Math.max(at + by, 0), all.length - 1)])
  }
  const inRow = sel => { const row = current(); return row ? press(row.querySelector(sel)) : false }

  // ---- places ----
  const menuOpen = () => { const doors = $('#brand-doors'); return Boolean(doors && !doors.hidden) }
  /** The Trommi menu, opened with the keyboard on the desk in view (menu_controller.js); on a page without the menu, the Desk with it open. */
  function openJump() {
    const doors = $('#brand-doors')
    if (!doors) return go(`${base()}/#jump`)
    doors.hidden = false
    $('#brand-menu')?.setAttribute('aria-expanded', 'true')
  }
  const sessions = () => [...document.querySelectorAll('#agents .agent-row[data-unit]')].filter(shown).map(r => r.querySelector('.agent-entry')).filter(Boolean)
  const desks = () => [...document.querySelectorAll('#brand-doors .menu-desk[data-desk]')]
  const HAS = {
    desks: () => desks().length > 0 && view() !== 'agents',
    sidebar: () => Boolean($('#agents')),
  }
  function sessionStep(by) {
    const all = sessions()
    if (!all.length) return false
    const at = all.findIndex(a => a.closest('.agent-row').classList.contains('is-active'))
    press(all[at < 0 ? (by > 0 ? 0 : all.length - 1) : (at + by + all.length) % all.length])
  }
  const sheet = () => $('#keys-sheet')
  function toggleSheet() {
    const s = sheet()
    if (!s) return false
    if (s.open) return s.close()
    const key = $('#keys-sheet [data-mod]')
    if (key && MAC) key.textContent = '⌘'
    s.showModal()
    $('.keys-close', s)?.focus()
  }
  const backNote = () => press($('#says-host .says:not([hidden]) .says-back'))   // the newest toast's Undo (ui.mjs)

  /** What the keys do, by the id in the table. A function that returns false did not take the key. */
  const ACTIONS = {
    'list.next': () => step(1),
    'list.prev': () => step(-1),
    'list.first': () => { const all = rows(); return all.length ? setMark(all[0]) : false },
    'list.last': () => { const all = rows(); return all.length ? setMark(all.at(-1)) : false },
    'list.open': () => inRow('a.inbox-text, a.inbox-revising-open'),
    'list.later': () => (current()?.matches('.inbox-done') ? inRow('[data-later] .inbox-takeback, [data-later].inbox-done .inbox-takeback') : inRow('.inbox-later')),
    'list.revise': () => inRow('.inbox-revise'),
    'list.trust': () => inRow('.inbox-trust'),
    'list.shred': () => inRow('.inbox-shred'),
    'list.takeback': () => (current()?.matches('.inbox-done') ? inRow('.inbox-takeback') : backNote()),
    'list.leave': () => { if (!current()) return false; setMark(null); document.activeElement?.blur?.() },

    // The arrows walk the answers of a card (its page, and beside a large picture): the options in order, the duck,
    // What??, the reverse card. Nothing is marked when a card opens. Enter on a marked button is the button's own;
    // on a marked tick-box it ticks; with nothing marked it sends where several answers are allowed.
    'ans.down': () => walkAnswers(1),
    'ans.up': () => walkAnswers(-1),
    'ans.right': () => (document.activeElement?.matches?.('.tc-answer .tc-wtf') ? markAnswer($('.tc-answer .tc-reverse')) : false),
    'ans.left': () => (document.activeElement?.matches?.('.tc-answer .tc-reverse') ? markAnswer($('.tc-answer .tc-wtf')) : false),
    'card.send': () => {
      const at = document.activeElement
      if (at?.matches?.('.tc-answer .tc-opt input[type="checkbox"]')) return at.click()
      if (at?.closest?.('.tc-answer') && at.matches('button')) return false
      return press($('.tc-answer .tc-send-many'))
    },
    'card.back': () => { if ($('#says-host .says:not([hidden]) .says-back')) return backNote(); const b = $('.tc-answer button[formaction$="/reopen"], .tc-answer button[formaction$="/takeback"]'); return b ? press(b) : false },
    'card.next': () => press($('.tc-rails a.is-next')),
    'card.prev': () => press($('.tc-rails a.is-prev')),
    'card.pic.next': () => press($('.tc-card .tc-step.is-next')),
    'card.pic.prev': () => press($('.tc-card .tc-step.is-prev')),
    'card.leave': (n, e) => { if (typingIn(e.target)) return e.target.blur(); return press($('.tc-page.is-full .tc-full.is-leave') ?? $('.tc-rails .tc-back')) },

    'ledger.next': () => step(1),
    'ledger.prev': () => step(-1),
    'ledger.open': () => (current()?.matches('.is-archived') ? false : inRow('[data-ledger="open"], a.ledger-open')),
    'ledger.walk': () => inRow('[data-ledger="walk"]'),
    'ledger.rename': () => inRow('[data-ledger="rename"]'),
    'ledger.mark': () => inRow('[data-ledger="mark"]'),
    'ledger.crown': () => inRow('[data-ledger="crown"]'),
    'ledger.pair': () => inRow('[data-ledger="pair"]'),
    'ledger.archive': () => inRow('[data-ledger="archive"], [data-ledger="fetch"]'),
    'ledger.down': () => inRow('[data-ledger="down"]'),
    'ledger.up': () => inRow('[data-ledger="up"]'),
    // Escape closes what is open first (the page's own "pops" controller); only then the mark goes.
    'ledger.leave': () => { if (!current() || $('#ledger-list details[open]')) return false; setMark(null); document.activeElement?.blur?.() },

    'pic.next': () => press($('.t-picture .tc-step.is-next')),
    'pic.prev': () => press($('.t-picture .tc-step.is-prev')),
    'pic.leave': () => press($('.t-picture-back')),

    'help': () => toggleSheet(),
    'note.new': () => document.dispatchEvent(new CustomEvent('trommi:note')),
    'go.desk': () => go(`${base()}/`),
    'go.agents': () => go(`${base()}/agents`),
    'go.walk': () => go(`${base()}/blitz`),
    'go.jump': () => openJump(),
    'desk.switch': n => { press(desks()[n - 1]) },   // a number past the last desk does nothing
    'go.session': n => { press(sessions()[n - 1]) },
    'session.next': () => sessionStep(1),
    'session.prev': () => sessionStep(-1),
    'pen': () => (document.querySelector('[data-controller~="curl"]') ? document.dispatchEvent(new CustomEvent('trommi:curl')) : go(`${base()}/scribble-board`)),
    'rail': () => (matchMedia('(min-width: 861px)').matches ? press($('.rail-fold')) : false),   // the sidebar's "|<" (rail_controller.js)
    'back': () => backNote(),
    'theme': () => {
      if ($('#theme-toggle')) return press($('#theme-toggle'))
      setThemeMode(nextThemeMode())
    },
    'field.leave': (n, e) => { if (!typingIn(e.target)) return false; e.target.blur() },
  }

  // ---- matching ----
  const nameOf = e => (e.key.length === 1 ? e.key.toLowerCase() : e.shiftKey ? `Shift+${e.key}` : e.key)
  // Does a key of the table match what was pressed? The number for a range, true, or null.
  function match(spec, name) {
    const range = spec.match(/^(.+[ +])?(\d)…(\d)$/)
    if (!range) return spec === name ? true : null
    const lead = range[1] ?? ''
    const digit = name.startsWith(lead) ? name.slice(lead.length) : ''
    return /^\d$/.test(digit) && digit >= range[2] && digit <= range[3] ? Number(digit) : null
  }
  const live = () => { const scopes = scopesOf(view()); return LAYOUT.filter(g => scopes.includes(g.scope)).sort((a, b) => scopes.indexOf(a.scope) - scopes.indexOf(b.scope)) }
  const offered = entry => !entry.needs || HAS[entry.needs]()
  function run(name, e, { typing = false, control = false } = {}) {
    for (const group of live()) {
      for (const entry of group.keys) {
        if ((typing && !entry.typing) || (control && !entry.control) || !offered(entry)) continue
        let arg = null
        for (const spec of entry.keys) if ((arg = match(spec, name)) != null) break
        if (arg == null) continue
        // The key belongs to whatever handles it in place: hands off, here and further down.
        if (entry.native) return false
        // A held key repeats a move; anything else waits for the next press.
        if (e.repeat && !entry.repeat) return true
        if (ACTIONS[entry.id]?.(arg === true ? undefined : arg, e) !== false) return true
      }
    }
    return false
  }

  // ---- a sequence under way: "g", then where to ----
  let pending = null   // { prefix, timer }
  let chip = null
  function setPending(prefix) {
    clearTimeout(pending?.timer)
    pending = prefix ? { prefix, timer: setTimeout(() => setPending(null), SEQUENCE_MS) } : null
    if (prefix) document.body.dataset.keys = prefix; else delete document.body.dataset.keys
    if (!prefix) { chip?.remove(); chip = null; return }
    // What may follow, from the table.
    chip = document.createElement('p')
    chip.className = 'keys-pending'
    chip.setAttribute('role', 'status')
    const kbd = text => { const k = document.createElement('kbd'); k.textContent = text; return k }
    chip.append(kbd(capOf(prefix).join('')))
    for (const group of live()) for (const entry of group.keys) for (const spec of entry.keys) {
      if (!spec.startsWith(`${prefix} `) || !offered(entry)) continue
      const pair = document.createElement('span')
      pair.append(kbd(capOf(spec.slice(prefix.length + 1)).join('')), entry.does)
      chip.append(pair)
    }
    document.body.append(chip)
  }
  on(window, 'blur', () => setPending(null))
  on(document, 'turbo:before-visit', () => setPending(null))
  signal.addEventListener('abort', () => setPending(null))

  // ---- the listener ----
  on(document, 'keydown', e => {
    if (e.defaultPrevented || e.altKey || e.isComposing || e.keyCode === 229) return
    const taken = () => { e.preventDefault(); e.stopPropagation() }
    // With Ctrl or Cmd nothing is taken, except the one the table names: the jump field.
    if (e.ctrlKey || e.metaKey) {
      if (e.key.toLowerCase() === 'k' && !e.shiftKey && !document.querySelector('dialog[open]')) { taken(); openJump() }
      return
    }
    if (['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Tab', 'Dead'].includes(e.key)) return
    const t = e.target instanceof Element ? e.target : null
    const typing = typingIn(t)
    if (sheet()?.open) {
      if (e.key === '?' && !typing) { taken(); sheet().close() }
      return   // Escape is the dialog's own
    }
    // A dialog owns the keyboard while it is open; so does whatever says so, and a player with its own keys.
    if (document.querySelector('dialog[open], [data-owns-keys]:not([hidden])') || t?.closest('video, audio, details[open]')) return
    const name = nameOf(e)
    // The open menu's Escape closes the menu (t/boot.js), and nothing else.
    if (name === 'Escape' && menuOpen()) return
    if (typing) {
      // A field's own Escape comes first (a note, the jump field, a picker): the table's Escape (leave the field,
      // then the page) acts only if the event comes back up to the document untouched.
      if (name === 'Escape') document.addEventListener('keydown', ev => { if (ev === e && !e.defaultPrevented && run(name, e, { typing: true })) e.preventDefault() }, { once: true, signal })
      return
    }
    // On a question's own page a letter, a digit or a mark is writing: it goes into the field to write to the agent,
    // never into a key that sends the card away (Later was "s", Shred "x", the duck "r"; one letter typed before the
    // field had the keyboard put the card off, and the next one stood on the clipboard in its place).
    if (typeToField(e)) return taken()
    if (pending) {
      const { prefix } = pending
      setPending(null)
      if (name !== 'Escape') run(`${prefix} ${name}`, e)
      return taken()   // the second key of a sequence never means anything else
    }
    // Enter and Space on a button or a link are that control's.
    const control = isControl(t) && (name === 'Enter' || name === ' ')
    if (run(name, e, { control })) return taken()
    if (control || e.repeat) return
    // The first key of a sequence?
    if (live().some(g => g.keys.some(k => offered(k) && k.keys.some(spec => spec.startsWith(`${name} `))))) { taken(); setPending(name) }
  }, true)

  // ---- the sheet behind "?" is opened from the menu too ("Keys") ----
  on(document, 'trommi:keys', () => toggleSheet())
  // A row that was clicked is where the keyboard goes on from.
  on(document, 'click', e => {
    const row = e.target instanceof Element ? e.target.closest('#desk-list .inbox-row') : null
    const mark = marks[view()]
    if (row && mark && row.dataset.id !== mark.id) { marks[view()] = { id: row.dataset.id, pile: false, at: rows().indexOf(row) }; keep(); show(row, { focus: false }) }
  })
  later()
}

// ---- a card as a row: the Desk's rows, and an open question inside its session's conversation ----
export const cardPath = (card, base) => `${base}/card/${encodeURIComponent(card.number ?? card.id)}`
const COPY_ICON = raw('<svg viewBox="0 0 24 24" class="sketch cardclip-ico" aria-hidden="true"><path d="M9.2 8.6C12.6 8.3 16 8.4 19.3 8.7C19.7 12.2 19.6 15.8 19.4 19.4C16 19.8 12.6 19.7 9.1 19.5C8.7 16 8.8 12.4 9 9"/><path d="M15 5.6C14.8 4.9 14.3 4.5 13.6 4.5C10.9 4.3 8.2 4.4 5.4 4.6C4.8 4.7 4.5 5.1 4.5 5.7C4.3 8.4 4.3 11.2 4.6 14C4.7 14.6 5.1 14.9 5.8 15"/></svg>')
/** The small button that copies a card as one line, to paste into another agent (controller "clip"). */
export function copyButton(card) {
  const picked = card.choices?.length ? card.options.filter(o => card.choices.includes(o.key)).map(o => o.label).join(', ') : ''
  const text = `Nr. ${card.number} · ${card.title}${picked ? ` → ${picked}` : ''}`
  return html`<button class="cardclip-copy" type="button" data-controller="clip" data-action="clip#copy" data-clip-text-value="${text}" data-clip-card-value="${JSON.stringify({ id: card.id, number: card.number, title: card.title, choice_label: picked })}" title="Copy to paste into another agent" aria-label="Copy to paste into another agent">${COPY_ICON}</button>`
}
export const act = (card, base, what) => `${base}/cards/${card.id}/${what}`

// A way out of the row, tucked beside the title: Snooze, Revise, Whatever, Shred. One form, each button its own address.
const tab = (cls, drawing, word, label, action, hidden = false) => html`<button class="inbox-tab-act ${cls}" type="submit" formaction="${action}" aria-label="${label}" title="${label}"${hidden ? raw(' hidden') : ''}><i class="inbox-later-flap">${sk(drawing)}<b>${word}</b></i></button>`

const tile = (cls, drawing, label, { name = 'key', value = '', action = null, title = '', aria = '', short = false, final = false } = {}) => html`<button class="inbox-answer ${cls}"${/\bis-advised\b/.test(cls) ? raw(' data-controller="advice"') : ''} type="submit"${value ? html` name="${name}" value="${value}"` : ''}${action ? html` formaction="${action}"` : ''}${title ? html` title="${title}"` : ''}${aria ? html` aria-label="${aria}"` : ''}>${final ? finalSign() : ''}<span class="inbox-disc">${sk(drawing)}</span>${label ? html`<span${short ? raw(' class="inbox-short"') : ''}>${label}</span>` : ''}</button>`

function tiles(card, base) {
  const stay = raw('<input type="hidden" name="stay" value="1">')
  const seen = card.revised ? html`<input type="hidden" name="revised" value="${card.revised}">` : ''
  // A Done row (the agent finished it): What?? to ask about it, Archive to put it down to Off the desk.
  if (card.landed) {
    return html`<form class="inbox-actions" method="post" action="${act(card, base, 'archive')}">${stay}
${tile('is-thumb is-what', 'what', '', { action: act(card, base, 'what'), title: `${WORDS.what}: ask the session about what it did`, aria: 'What?? — ask about it' })}
${tile('is-thumb is-lead is-ack is-archive', 'archive', 'Archive', { title: 'Archive: seen it, down to Off the desk' })}</form>`
  }
  if (card.kind === 'info') {
    return html`<form class="inbox-actions" method="post" action="${act(card, base, 'close')}">${stay}
${tile('is-thumb is-what', 'what', '', { action: act(card, base, 'what'), title: `${WORDS.what}: ask the session to explain this; it comes back explained`, aria: 'What?? — explain this to me' })}
${tile('is-thumb is-lead is-ack', 'tick', WORDS.ack, { title: `${WORDS.ack}: read, close it` })}</form>`
  }
  const bare = card.options.every(o => BARE.test(o.label.trim()))
  const size = bare ? 'none' : labelSize(card.options)
  const short = card.options.every(shortOf)
  if (quick(card) && (bare || size !== 'none' || short)) {
    // Thumbs only for a real yes or no (bare words, or a permission): down on the left, up on the right; the option
    // the agent leads with (its first, or "allow") is the up. Two named options are two plain tiles with their words,
    // in the order given, no thumbs; the one the agent advises is the filled one (and carries the pen's mark).
    const thumbs = bare || card.kind === 'permission'
    const advice = advisedKeys(card)
    const isYes = o => (card.kind === 'permission' ? o.key === 'allow' : thumbs ? o === card.options[0] : advice.includes(o.key))
    const worded = !bare && size === 'none'
    return html`<form class="inbox-actions" method="post" action="${act(card, base, 'decide')}">${stay}${seen}
${(thumbs ? [...card.options].sort((a, b) => isYes(a) - isYes(b)) : card.options).map(o => {
      const lead = isYes(o), advised = advisedKeys(card).includes(o.key)
      const cls = `is-thumb${thumbs ? '' : ' is-named'}${lead ? ' is-lead' : ''}${size === 'small' ? ' is-small' : ''}${worded ? ' is-short' : ''}${advised ? ' is-advised' : ''}`
      const final = o.final === true
      const title = [advised ? 'The agent recommends this' : [size === 'none' && !bare ? o.label : '', o.detail].filter(Boolean).join(': '), final ? FINAL_TIP : ''].filter(Boolean).join(' · ')
      return tile(cls, lead ? 'yes' : 'no', worded ? shortOf(o) : size === 'none' && !bare ? '' : o.label, { value: o.key, title, aria: final ? `${o.label} (settles it)` : o.label, short: worded, final })
    })}</form>`
  }
  // More than two ways, one of them advised by its agent (his pick "advised", 7 October): that option is the lead tile,
  // one press takes it (the same answer as on the card); beside it "+N other ways" opens the card.
  const advisedOne = card.kind === 'decision' && !card.multiple ? card.options.find(o => advisedKeys(card)[0] === o.key && advisedKeys(card).length === 1) : null
  if (advisedOne) {
    const others = card.options.length - 1, final = advisedOne.final === true
    return html`<form class="inbox-actions is-advised-pair" method="post" action="${act(card, base, 'decide')}">${stay}${seen}<a class="inbox-answer is-thumb is-others" data-nav href="${cardPath(card, base)}" title="The other ${others} ways: open the card" aria-label="${others} other ways: open the card"><b>+${others}</b><span>other ways</span></a><button class="inbox-answer is-thumb is-lead is-take is-advised" type="submit" name="key" value="${advisedOne.key}" title="${[advisedOne.label, advisedOne.detail, 'the agent recommends this', final ? FINAL_TIP : ''].filter(Boolean).join(' · ')}" aria-label="${advisedOne.label}, advised${final ? ' (settles it)' : ''}">${sk('yes')}<strong>${advisedOne.label}</strong></button></form>`
  }
  // More than two ways: one tile, "Choose". It is a link to the card's own page, where every option stands.
  const count = card.multiple ? `${card.options.length} options, several` : `${card.options.length} options`
  return html`<div class="inbox-actions"><a class="inbox-answer is-wide is-lead" data-nav href="${cardPath(card, base)}" title="${count}" aria-label="Choose: ${count}"><span class="inbox-disc">${sk('choose')}</span><span>Choose</span></a></div>`
}

const knockAttr = card => (isKnock(card) ? raw(' data-knock') : '')
/** One open question as a row. from: the session that asked. error: what went wrong with the last answer. */
// The pull-tag of Later: a paper tag on its string, the three Zs of sleep drawn down it (small at the hole, growing; a clear gap under the hole, as much under the last Z). The drawing of Later in sideWays
// below (the Desk's selection bar, with the word; under a card and beside a large picture, the tag alone).
export const LATER_TAG = raw('<svg viewBox="0 0 44 92" aria-hidden="true"><path d="M22 0 C23 8 21 14 22 22" class="tag-string"/><path d="M6 28 L38 27 L40 84 C40 88 37 90 34 90 L10 90.5 C7 90.5 4.6 88 4.8 85 Z" class="tag-paper"/><circle cx="22" cy="34.5" r="3"/><g class="tag-z"><path d="M21.6 48.4 L26.9 48.2 L21.8 54.1 L27.3 53.9" stroke-width="2.1"/><path d="M15.4 57.2 L22.6 56.9 L15.7 64.9 L23.2 64.6" stroke-width="2.4"/><path d="M18.8 68.2 L29.5 67.8 L19.2 79.2 L30 78.7" stroke-width="2.9"/></g></svg>')
/** The ways to put cards aside without answering them: Later, Duck it, Shred, in this order, with these drawings and
 *  names. One set for the Desk's selection bar (many cards) and a card's own page (this one): buttons of a form that
 *  posts to <base>/cards/batch with the ids (desk.mjs). later, duck, shred: which of them apply; between: what stands
 *  before Shred (the bar's Read). */
export const sideWays = ({ later = true, duck = true, shred = true, many = false, between = '', word = true } = {}) => {
  const it = many ? 'them' : 'it'
  return html`${later ? html`<button type="submit" name="way" value="later" class="sel-later" title="${WORDS.later}: put ${it} off, ${many ? 'they wait' : 'it waits'} in Off the desk" aria-label="${WORDS.later}">${LATER_TAG}${word ? html`<span>${WORDS.later}</span>` : ''}</button>` : ''}${duck ? html`<button type="submit" name="way" value="duck" class="sel-duck" title="${WORDS.duck}: ${many ? 'the agents take their' : 'the agent takes its'} own advice" aria-label="${WORDS.duck}">${sk('duck')}<span>${WORDS.duck}</span></button>` : ''}${between}${shred ? html`<button type="submit" name="way" value="shred" class="sel-shred" title="${WORDS.shred}: throw ${it} away" aria-label="${WORDS.shred}">${sk('bin')}<span>${WORDS.shred}</span></button>` : ''}`
}
const deskNameOf = (model, agent) => model.desks.find(d => d.id === model.deskOf?.(agent))?.name || 'Desk'
export function deskRow(card, model, base, { error = '' } = {}) {
  const from = model.byAgent.get(card.agent)
  const assets = model.state.assets
  // (with the card's own teaser, the urgency's reason stays on the card's page: the teaser says what matters)
  const about = [cardNote(card), card.unsnoozed && !card.snoozed_until ? 'Back from Later' : '', card.teaser ? '' : card.urgency_reason].filter(Boolean).join(' · ')
  // (the card's own teaser, two lines for the Desk; without one, the first lines of its body)
  const words = card.teaser || plain(card.body, assets)
  const extra = carries(card, assets)
  const images = (card.attachments ?? []).filter(a => kindOf(a) === 'image')
  // (Test, 4 October: the pictures and videos as a small fan beside the title; no "2 pictures" line.)
  const media = [...images, ...(card.attachments ?? []).filter(a => kindOf(a) === 'video')]
  const knock = isKnock(card)
  const quiet = knock ? '' : card.kind === 'info' ? html`<span class="inbox-whenever inbox-toread" title="To read: nothing to decide" role="img" aria-label="To read">${sk('page')}</span>`
    : card.urgency === 'low' ? html`<span class="inbox-whenever" title="Whenever: nothing waits on this" role="img" aria-label="Whenever">${sk('whenever')}</span>` : ''
  // A Done row: the title, the agent's closing line where the teaser stands, a quiet green tick; no Later, no Shred.
  if (card.landed) return doneRow(card, model, base, from, error)
  const trustTip = `I don’t give a duck: your call (R)${advisedLabels(card) ? ` · agent takes ${advisedLabels(card)}` : ''}`
  const href = cardPath(card, base)
  return html`<article class="inbox-row" id="row-${card.id}"${knockAttr(card)} tabindex="-1" data-id="${card.id}" data-urgency="${card.urgency}"${card.kind === 'info' ? raw(' data-kind="info"') : ''}${from ? html` data-from="${from.id}" style="--hue:${from.hue}"` : ''}>
${from ? html`<a class="inbox-gutter" data-nav href="${base}/s/${encodeURIComponent(from.id)}" aria-label="From ${from.name}: open the session" data-name="${from.name}" style="--hue:${from.hue}">${smallMark(from)}<span class="inbox-gutter-name" aria-hidden="true">${from.name}</span></a>` : ''}
<div class="inbox-content">
<header class="inbox-row-head"></header>
${media.length ? html`<a class="inbox-fan" data-nav href="${href}${images.length ? '/picture/1' : ''}" aria-label="${media.length === 1 ? 'Look at the picture' : `Look at ${media.length} pictures and videos`}">${media.slice(0, 3).map(a => kindOf(a) === 'image' ? html`<img${srcOf(a, 56)} alt="" loading="lazy" decoding="async" width="56" height="42">` : html`<video src="${a.url}" muted playsinline preload="metadata"></video>`)}</a>` : ''}
${from ? html`<button class="row-mark" type="button" style="--hue:${from.hue}" title="${from.name}: select (Shift: a range)" aria-label="Select: ${card.title}" aria-pressed="false" data-select>${markArt(from)}<span class="row-check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6.4 12.6Q8.8 15.1 10.4 17Q14 11.4 18.2 7.2"/></svg></span></button>` : ''}<a class="inbox-text${from ? ' has-sender' : ''}" data-nav href="${href}" title="${cardNr(card)}${from ? ` · ${from.name}` : ''}: ${card.title}">${from ? html`<span class="inbox-from-mark inbox-who" style="--hue:${from.hue}" title="${from.name}" role="img" aria-label="From ${from.name}">${markArt(from)}</span>` : ''}<strong class="inbox-question" data-controller="fit">${knock ? html`<span class="row-urg is-${card.urgency === 'critical' ? 'block' : 'knock'}" role="img" title="${knockWord(card)}" aria-label="${knockWord(card)}">${card.urgency === 'critical' ? raw(handSvg()) : sk('knock')}</span>` : card.kind !== 'info' && card.urgency === 'low' ? html`<span class="row-urg is-whenever" role="img" title="Whenever: nothing waits on this" aria-label="Whenever">${sk('whenever')}</span>` : ''}${card.title}</strong>${from ? html`<span class="row-meta"><span class="row-meta-mark">${raw(doodleSvg(from.mark))}</span><span class="row-meta-who">${from.name}</span><span class="row-meta-dot">·</span>${agoSpan(card.created, 'row-meta-ago')}</span>` : ''}${about || words ? html`<span class="inbox-body">${model.all && from ? html`<span class="row-desk" title="Desk ${deskNameOf(model, from)}">${deskNameOf(model, from)}</span>` : ''}${about ? html`<span class="inbox-body-about">${about}</span>` : ''}${words ? html`<span class="inbox-body-text">${about ? ` · ${words}` : words}</span>` : ''}</span>` : ''}</a>
<span class="inbox-when" title="${cardNr(card)} · asked ${ago(card.created)}"><form class="inbox-tabs" method="post" action="${act(card, base, 'snooze')}"><input type="hidden" name="stay" value="1">
<button class="inbox-tab-act inbox-later is-tag" type="submit" formaction="${act(card, base, 'snooze')}" aria-label="${WORDS.later}: put this question off; it waits for you below" title="${WORDS.later}: put this question off; it waits for you below">${LATER_TAG}</button>
${card.kind !== 'permission' ? tab('inbox-revise', 'reverse', WORDS.revise, `${WORDS.revise}: hand it back to the session at once; it returns reworked`, act(card, base, 'revise'), true) : ''}
${card.kind === 'decision' ? tab('inbox-trust', 'duck', WORDS.trust, trustTip, act(card, base, 'trust'), true) : ''}
${card.kind !== 'permission' ? tab('inbox-shred', 'bin', WORDS.shred, `${WORDS.shred}: throw this away unanswered. The session is told; it will not ask again`, act(card, base, 'shred')) : ''}
</form>${agoSpan(card.created, 'inbox-ago')}</span>
<p class="inbox-byline">${quiet}${from ? html`<span class="inbox-from">${smallMark(from)}<span>${from.name}</span></span><span class="inbox-sep"> · </span>` : ''}</p>
</div>
${tiles(card, base)}
<p class="inbox-error inbox-row-error" role="alert"${error ? '' : raw(' hidden')}>${error}</p>
</article>`
}

// ---- a Done row (his word, 7 October): what an agent finished stays on the Desk until he archives it ----
// The same row as a question (the session's gutter and mark, the title as the link to the card), but quiet: a green
// tick before the title, the agent's closing summary instead of the teaser, when it was finished, and two tiles,
// What?? and Archive. data-kind="done" (the selection bar offers Archive for it).
function doneRow(card, model, base, from, error = '') {
  const href = cardPath(card, base)
  const said = plain(card.summary || 'Done', model.state.assets)
  return html`<article class="inbox-row is-done" id="row-${card.id}" tabindex="-1" data-id="${card.id}" data-kind="done" data-urgency="${card.urgency}"${from ? html` data-from="${from.id}" style="--hue:${from.hue}"` : ''}>
${from ? html`<a class="inbox-gutter" data-nav href="${base}/s/${encodeURIComponent(from.id)}" aria-label="From ${from.name}: open the session" data-name="${from.name}" style="--hue:${from.hue}">${smallMark(from)}<span class="inbox-gutter-name" aria-hidden="true">${from.name}</span></a>` : ''}
<div class="inbox-content">
<header class="inbox-row-head"></header>
${from ? html`<button class="row-mark" type="button" style="--hue:${from.hue}" title="${from.name}: select (Shift: a range)" aria-label="Select: ${card.title}" aria-pressed="false" data-select>${markArt(from)}<span class="row-check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6.4 12.6Q8.8 15.1 10.4 17Q14 11.4 18.2 7.2"/></svg></span></button>` : ''}<a class="inbox-text${from ? ' has-sender' : ''}" data-nav href="${href}" title="${cardNr(card)}${from ? ` · ${from.name}` : ''}: done · ${card.title}">${from ? html`<span class="inbox-from-mark inbox-who" style="--hue:${from.hue}" title="${from.name}" role="img" aria-label="From ${from.name}">${markArt(from)}</span>` : ''}<strong class="inbox-question" data-controller="fit"><span class="row-urg is-done" role="img" title="Done by ${from?.name ?? 'the agent'}" aria-label="Done">${sk('tick')}</span>${card.title}</strong>${from ? html`<span class="row-meta"><span class="row-meta-mark">${raw(doodleSvg(from.mark))}</span><span class="row-meta-who">${from.name}</span><span class="row-meta-dot">·</span>${agoSpan(card.finished, 'row-meta-ago')}</span>` : ''}<span class="inbox-body">${model.all && from ? html`<span class="row-desk" title="Desk ${deskNameOf(model, from)}">${deskNameOf(model, from)}</span>` : ''}<span class="inbox-body-about is-done">Done</span><span class="inbox-body-text"> · ${said}</span></span></a>
<span class="inbox-when" title="${cardNr(card)} · done ${ago(card.finished)}">${agoSpan(card.finished, 'inbox-ago')}</span>
<p class="inbox-byline">${from ? html`<span class="inbox-from">${smallMark(from)}<span>${from.name}</span></span><span class="inbox-sep"> · </span>` : ''}</p>
</div>
${tiles(card, base)}
<p class="inbox-error inbox-row-error" role="alert"${error ? '' : raw(' hidden')}>${error}</p>
</article>`
}

export const runSection = (sender, rows, n) => html`<section class="inbox-group" data-sender="${sender.id}" data-run="${n > 1 ? 'many' : 'single'}" aria-label="${sender.name}: ${n === 1 ? '1 question' : `${n} questions`}"${sender.starred ? raw(' data-vip') : ''} style="--hue:${sender.hue}">${rows}</section>`

// ---- a session's mark, its badge ----
const questions = n => (n === 1 ? '1 question' : `${n} questions`)
/** A session's mark: its scribble in its colour; with the crown when it is the desk's crowned session (`starred`, one per desk).
 *  working: the session is at work. Its drawing then fills itself in, stroke by stroke, over a faint trace of itself
 *  (crowns.css .is-drawing: a CSS animation of the strokes' dash, nothing runs per frame; still under reduced motion). */
export const avatar = (agent, { crown = true, working = false } = {}) => html`<span class="agent-avatar${agent.online ? '' : ' is-offline'}${working ? ' is-drawing' : ''}" aria-hidden="true" style="--hue:${agent.hue}"${crown && agent.starred ? raw(' data-vip') : ''}>${raw(working ? drawing(doodleSvg(agent.mark)) : doodleSvg(agent.mark))}${crown && agent.starred ? raw(crownSvg()) : ''}</span>`
// The drawing at work: a faint trace, and the same strokes over it that draw themselves (each path measured as 100).
const drawing = svg => svg.replace('class="doodle"', 'class="doodle mark-trace"') + svg.replace('class="doodle"', 'class="doodle mark-live"').replaceAll('<path ', '<path pathLength="100" ')

/** A session's drawing, with the crown when it is the desk's crowned session. */
export const markArt = agent => raw(doodleSvg(agent.mark) + (agent.starred ? crownSvg() : ''))
/** The small mark on a line that names who asked. */
export const smallMark = agent => html`<span class="inbox-from-mark" style="--hue:${agent.hue}">${markArt(agent)}</span>`

// The badge at the end of a row: the open questions, as a number in a ring; the raised red hand when the session is
// really stopped (blocked: disconnected while working, an error, waiting for permission; being quiet is no stop, blocked.mjs quietOf).
// The hand can stand without any question. That one of its questions knocks (is urgent) is told on the Desk, not here.
// A link into that session. That the session works is told by its drawing (avatar working), not here:
// a session that works and has no open question has no badge.
// In the sidebar (tally) the count is a tally in the pen's line: a stroke for each question up to four, the fifth
// drawn across them, and a figure above five. The number is said by the link's label either way.
const TALLY = ['M3.9 2.2Q2.6 7.6 2.5 13.9', 'M8.6 1.6Q8.4 8.4 7.3 13.2', 'M13.7 2.6Q12.5 7.2 12.6 14.2', 'M18.6 1.9Q18.3 8.6 17.2 13.5']
const tallySvg = n => { const w = n > 4 ? 22 : n * 5 + 1; return `<svg class="agent-tally" viewBox="0 0 ${w} 16" width="${w}" height="16" aria-hidden="true">${TALLY.slice(0, Math.min(n, 4)).map(d => `<path d="${d}"/>`).join('')}${n > 4 ? '<path d="M.9 11.8Q10.5 7.6 21.1 3.5"/>' : ''}</svg>` }
export function badge(u, shown, base, tally = false) {
  const { open, online, running, blocked } = shown
  if (!open && !blocked) return ''
  const busy = Boolean(online && running)
  const state = blocked ? `Stopped: ${blocked.text}${open ? `, ${questions(open)} open` : ''}`
    : online ? (running ? `Working, ${questions(open)} open` : `${questions(open)} open`) : `Disconnected, ${questions(open)} open`
  const inner = blocked ? raw(handSvg()) : !tally ? html`${raw(ringSvg())}<b>${open}</b>` : open > 5 ? html`<b>${open}</b>` : raw(tallySvg(open))
  const data = html` data-state="${blocked ? 'blocked' : 'open'}"${blocked ? html` data-why="${blocked.why}"` : ''}${!online ? raw(' data-offline') : ''}${busy ? raw(' data-working') : ''}`
  return html`<a class="agent-badge" data-nav href="${base}/s/${encodeURIComponent(u.id)}"${data} title="${u.agent.name}: ${state}" aria-label="${u.agent.name}: ${state}">${inner}</a>`
}

// ---- a session's link: whether it hears him (app.mjs linkOf, heardOf) ----
// Nothing is drawn for a session that hears at once: the plain row IS "connected and listening". The sign is drawn with
// the pen; urgency is the sign and its ink, never a stripe (app.css .link-cap, .link-note, .link-slip).
/** The small line under a session's name in the sidebar: the sign and two or three words. unheard: answers it has not picked up. */
export const linkCap = (link, unheard = 0) => {
  if (link && link.state !== 'live') return html`<small class="link-cap" data-link="${link.state}" title="${link.line}">${sk(link.sign)}<span>${link.word}</span></small>`
  if (!unheard) return ''
  return html`<small class="link-cap" data-link="unheard" title="${unheard === 1 ? 'An answer of yours has' : `${unheard} answers of yours have`} not reached this session yet">${sk('letter')}<span>${unheard === 1 ? '1 answer waits' : `${unheard} answers wait`}</span></small>`
}
/** The note on a card's page and in a session: the receipt, the sentence about the session, and the way out as a line to type. */
export const linkNote = (link, { receipt = '', sign = null, tone = null, id = '' } = {}) => html`<aside class="link-note"${id ? html` id="${id}"` : ''} data-link="${tone ?? link?.state ?? 'live'}" role="status">${sk(sign ?? link?.sign ?? 'ear')}<div>${receipt ? html`<p class="link-receipt">${receipt}</p>` : ''}${link?.line && link.state !== 'live' ? html`<p>${link.line}</p>` : ''}${link?.fix ? html`<p class="link-fix">${link.fix.say} <code>${link.fix.code}</code></p>` : ''}</div></aside>`
/** The slip above the Desk's questions: one line per session that is cut off, with the step in its terminal. cut: [{ agent, link }]. */
export const linkSlip = (cut, base) => html`<section class="link-slip" id="link-slip" role="alert" aria-label="Sessions that are cut off"${cut.length ? '' : raw(' hidden')}>${cut.map(({ agent, link }) => html`<p><a data-nav href="${base}/s/${encodeURIComponent(agent.id)}">${sk('ear-off')}<span><b>${agent.name}</b> is cut off${link.since ? ` since ${link.word.split(' · ')[1]}` : ''}: it cannot hear you and cannot write to you.</span></a><span class="link-fix">${link.fix.say} <code>${link.fix.code}</code></span></p>`)}</section>`

// A quiet row "+ New agent" under the connected sessions (green while there is none): invite an agent. The same form the Devices page sends (POST /pair,
// role agent, room.mjs), so it leads to the same invite page with the link for the Claude Code session.
export const PLUS = raw('<svg viewBox="0 0 24 24" class="sketch" aria-hidden="true"><path d="M12.3 5.2C11.9 9.7 12 14.2 12.1 18.9"/><path d="M5.3 12.4C9.8 11.8 14.3 11.9 18.8 12.2"/></svg>')

// ---- what the agents sent: the Desk's Media pile and the gallery ----
const GLYPHS = {
  image: ['M4 5h16v14H4z', 'M4 16l5-5 4 4 3-3 4 4', 'M15.5 9.2a1.2 1.2 0 1 0 0-.1'],
  html: ['M3.5 5h17v14h-17z', 'M3.5 9h17', 'M6 7h.01M8.5 7h.01', 'M7 12.5h7M7 15.5h10'],
  video: ['M4 5h16v14H4z', 'M10 9.2v5.6l4.6-2.8z'],
  audio: ['M9 17.5V6l10-2v11.5', 'M9 17.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM19 15.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z'],
  file: ['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M9 12h6M9 15.5h6'],
}
export const assetGlyph = type => raw(`<svg viewBox="0 0 24 24" class="asset-glyph" aria-hidden="true">${(GLYPHS[type] ?? GLYPHS.file).map(d => `<path d="${d}"/>`).join('')}</svg>`)
const ext = name => (/\.([a-z0-9]{1,5})$/i.exec(name ?? '')?.[1] ?? '').toUpperCase()
/** Everything received, the newest first: [{ id, type, title, agent, ts, url, name, href, from, more }]. Kept per state. */
const galleryKept = new WeakMap()
export function galleryItems(model, base = '') {
  const { state } = model
  const hit = galleryKept.get(state)
  // (only what the sessions of the desk in view sent: a session that moved took its pictures along)
  const key = `${model.desk}|${model.everyone.map(a => a.desk).join(',')}`
  if (hit && hit.base === base && hit.key === key && hit.cards === state.cards && hit.assets === state.assets) return hit.out
  const out = []
  for (const a of state.assets ?? []) {
    const agent = model.byAgent.get(a.agent)
    if (!agent || !model.onDesk(agent)) continue
    const type = a.type === 'image' || a.type === 'html' || a.type === 'video' ? a.type : 'file'
    out.push({ id: a.id, type, title: a.title || 'Untitled', agent, ts: a.created ?? 0, url: a.att?.url ?? '', name: a.att?.name ?? '', href: `${base}/s/${encodeURIComponent(agent.id)}/a/${a.id}`, from: 'published' })
  }
  for (const c of state.cards) {
    const agent = model.byAgent.get(c.agent)
    if (!agent || !model.onDesk(agent)) continue
    const pics = (c.attachments ?? []).filter(a => kindOf(a) === 'image')
    if (pics.length) out.push({ id: c.id, type: 'image', title: c.title, agent, ts: c.created ?? 0, url: pics[0].url, name: pics[0].name, href: `${base}/card/${encodeURIComponent(c.number ?? c.id)}/picture/1`, from: `Nr. ${c.number}`, more: pics.length, urls: pics.slice(0, 3).map(a => a.url) })
    // Its videos stand on the card after the pictures (card.mjs cardMedia): the tile opens the card at the first one.
    const vids = (c.attachments ?? []).filter(a => kindOf(a) === 'video')
    if (vids.length) out.push({ id: `${c.id}-v`, type: 'video', title: c.title, agent, ts: c.created ?? 0, url: vids[0].url, name: vids[0].name, href: `${base}/card/${encodeURIComponent(c.number ?? c.id)}?pic=${pics.length + 1}`, from: `Nr. ${c.number}`, more: vids.length })
  }
  out.sort((x, y) => y.ts - x.ts)
  galleryKept.set(state, { base, key, cards: state.cards, assets: state.assets, out })
  return out
}

// ---- what the agents linked: the Desk's Links pile and the page /links ----
// Every web link and page the agents gave: the pages they published (assets of type html), the pages behind a card's
// pictures (page chips: an address, or a file of the room), and every http(s) address in a card's words (body, teaser,
// sections, options) or in an agent's message (the conversations as far as they are loaded). One entry per address
// (or per file of the room), the newest first. kind: 'page' (a published page) | 'file' (a page file of the room) |
// 'web' (an address outside). att: the attachment_id of a file of the room (what Share shares), else null.
const URL_RE = /https?:\/\/[^\s<>()\[\]"'`]+/g
const MD_LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g
const urlsKept = new Map()   // text -> [[url, label]] (bounded: texts repeat from one state to the next)
function urlsIn(text) {
  if (!text || typeof text !== 'string' || !text.includes('http')) return []
  const hit = urlsKept.get(text)
  if (hit) return hit
  const labels = new Map()
  for (const m of text.matchAll(MD_LINK)) labels.set(m[2], m[1].trim())
  const out = [...new Set([...text.matchAll(URL_RE)].map(m => m[0].replace(/[.,;:!?*_]+$/, '')))].filter(u => { try { return Boolean(new URL(u).host) } catch { return false } }).map(u => [u, labels.get(u) ?? ''])
  if (urlsKept.size > 2000) urlsKept.clear()
  urlsKept.set(text, out)
  return out
}
/** An address as a short line: its host and path, without the scheme and www. */
export const shortUrl = url => { const t = String(url).replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/$/, ''); return t.length > 60 ? `${t.slice(0, 59)}…` : t }
const hostOf = url => { try { return new URL(url).host.replace(/^www\./, '') } catch { return '' } }
const linksKept = new WeakMap()
/** [{ key, kind, url, href, title, host, agent, ts, att }], the newest first. Kept per state. */
export function linkItems(model, base = '') {
  const { state } = model
  const key = `${model.desk}|${model.everyone.map(a => a.desk).join(',')}|${base}`
  const hit = linksKept.get(state)
  if (hit && hit.key === key) return hit.out
  const by = new Map()
  const put = item => { const was = by.get(item.key); if (!was || item.ts > was.ts) by.set(item.key, was && !item.title ? { ...item, title: was.title } : item) }
  const here = agentId => { const agent = model.byAgent.get(agentId); return agent && model.onDesk(agent) ? agent : null }
  const web = (url, label, agent, ts) => put({ key: `web:${url}`, kind: 'web', url, href: url, title: label || '', host: hostOf(url), agent, ts, att: null })
  const pageOf = (a, agent, ts) => {
    const p = a?.page
    if (!p) return
    if (p.kind === 'link' && /^https?:/.test(p.url)) web(p.url, '', agent, ts)
    else if (p.kind === 'file' && /^\/att\/[0-9a-f]{32}$/.test(p.url)) put({ key: `file:${p.url.slice(5)}`, kind: 'file', url: p.url, href: p.url, title: p.name || 'Page', host: 'A page of this room', agent, ts, att: p.url.slice(5) })
  }
  for (const a of state.assets ?? []) {
    const agent = here(a.agent)
    if (!agent || a.type !== 'html') continue
    put({ key: `asset:${a.id}`, kind: 'page', url: a.att?.url ?? '', href: `${base}/s/${encodeURIComponent(agent.id)}/a/${a.id}`, title: a.title || 'Untitled page', host: 'Published page', agent, ts: a.created ?? 0, att: a.att?.ref?.attachment_id ?? null })
  }
  for (const c of state.cards) {
    const agent = here(c.agent)
    if (!agent || c.kind === 'permission') continue
    const ts = c.revised ?? c.created ?? 0
    const words = [c.body, c.teaser, ...(c.sections ?? []).map(x => x.text), ...(c.options ?? []).flatMap(o => [o.label, o.detail])]
    for (const text of words) for (const [url, label] of urlsIn(text)) web(url, label, agent, ts)
    for (const a of c.attachments ?? []) pageOf(a, agent, ts)
  }
  for (const msg of state.messages ?? []) {
    if (msg.from !== 'agent') continue
    const agent = here(msg.agent)
    if (!agent) continue
    for (const [url, label] of urlsIn(msg.text)) web(url, label, agent, msg.ts ?? 0)
    for (const a of msg.attachments ?? []) pageOf(a, agent, msg.ts ?? 0)
  }
  const out = [...by.values()].map(i => (i.title ? i : { ...i, title: shortUrl(i.url) })).sort((x, y) => y.ts - x.ts)
  linksKept.set(state, { key, out })
  return out
}

/** One preview, the app's own .asset-preview: a picture as itself, a video by its first frame with a play mark, a page by
 *  its first screen (controller "assetthumb", the drawn page until then), a file by its kind. Never an empty tile: what
 *  has no picture shows its drawn kind. */
const PLAY = raw('<span class="gal-play" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8.5 6.2v11.6L18 12z"/></svg></span>')
export const mediaPreview = (i, extra = '') => i.type === 'image' && i.url
  ? html`<span class="asset-preview is-shown" data-kind="image"><img src="${i.url}" alt="" loading="lazy" decoding="async">${extra}</span>`
  : i.type === 'video' && i.url
    ? html`<span class="asset-preview is-shown gal-video" data-kind="video">${assetGlyph('video')}<video src="${i.url}#t=0.001" muted playsinline preload="metadata" tabindex="-1" aria-hidden="true"></video>${PLAY}${extra}</span>`
    : i.type === 'html' && i.url
      ? html`<span class="asset-preview gal-page-thumb" data-kind="html" data-controller="assetthumb" data-assetthumb-src-value="${i.url}">${assetGlyph('html')}<span class="asset-page-label">Page</span>${extra}</span>`
      : html`<span class="asset-preview gal-file" data-kind="${i.type === 'video' ? 'video' : 'file'}">${assetGlyph(i.type === 'video' ? 'video' : i.type === 'html' ? 'html' : 'file')}<b class="gal-ext">${ext(i.name) || (i.type === 'video' ? 'VIDEO' : i.type === 'html' ? 'PAGE' : 'FILE')}</b>${extra}</span>`


// ---- the room's pages: their frame and tabs (Devices, Settings, the account screens) ----
export const BELL = raw(`<svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.1 19Q12.3 18.6 16.7 19L21 19.3"/><path d="M4.8 18.9Q5.2 15.1 5.7 13.7Q6.2 12.3 7.5 11.3Q8.7 10.3 10.3 9.5Q12 8.8 13.7 9.3Q15.3 9.8 16.4 11Q17.5 12.2 18.1 13.7Q18.6 15.2 18.8 17L18.9 18.8"/><path d="M11.8 8.6L12.2 6.9"/><path d="M10 6.6Q11.8 6 12.8 6.4L13.8 6.8"/><path class="brand-mark-ring" d="M18.5 7.3Q19.5 5.8 19.8 5.2L20 4.5"/><path class="brand-mark-ring" d="M20.6 10.3Q21.5 9.4 22.3 8.9L23.1 8.5"/></svg>`)
export const roomShell = (title, inner, cls = '') => html`<main id="room" class="room${cls ? ` ${cls}` : ''}" aria-label="${title}"><header class="room-head"><span class="room-bell">${BELL}</span><h2>${title}</h2></header>${inner}</main>`
/** One of the three tabbed pages (Agents is agents.mjs; Devices and Settings here): the tabs first, at the same place on
 *  all three, then the heading in the display face, then the page in one reading column (auth.css .room-paged). */
const ROOM_LINES = { devices: 'The people and agents with keys to this room.', settings: 'Your account, and what this device keeps.' }
export const roomPage = (title, on, inner, line = ROOM_LINES[on] ?? '') => html`<main id="room" class="room room-paged" aria-label="${title}"><div class="room-page">${roomTabs(on)}<header class="room-head page-head"><h2>${title}</h2>${line ? html`<p>${line}</p>` : ''}</header><div class="room-col">${inner}</div></div></main>`
export const roomTabs = (on, cls = '') => html`<nav class="room-tabs${cls ? ` ${cls}` : ''}" aria-label="Agents, devices and settings">${[['agents', 'Agents'], ['devices', 'Devices'], ['settings', 'Settings']].map(([p, word]) => html`<a href="/${p}" data-nav${on === p ? raw(' aria-current="page"') : ''}>${word}</a>`)}</nav>`
export const errorLine = e => (e ? html`<p class="room-error" role="alert">${e}</p>` : '')
