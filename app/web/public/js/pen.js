// The pen: every hand-drawn mark of the board as an SVG string. No DOM, no browser, no Node API, so the hub
// (server/views) and the page (islands) draw with the same code and the same seeds: a name or a session id
// always gives the same strokes, byte for byte.
//
// The stroke tables and generators below are the ones of js/ui.js and js/agents.js (the old client builds
// DOM nodes from them). Until the old client is retired they stand in both places: when a drawing changes
// there, run `node dev/pen-sync.mjs` to copy the tables here again.

// ---- tables (copied from js/ui.js by dev/pen-sync.mjs; do not edit between the two marks) ----
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
export const DRAWINGS = [...KINDS, ...Object.keys(NAMED)]
export const drawingMark = name => `draw:${name}`
/** The drawing a mark names ("draw:rocket" -> "rocket"), or null for a seeded scribble. */
export const drawingOf = mark => { const name = /^draw:(.+)$/.exec(String(mark ?? ''))?.[1]; return DRAWINGS.includes(name) ? name : null }
// Every drawing has one colour of its own, wherever it shows: a hue, turned by the golden angle from
// one drawing to the next, so neighbours in the picker never look alike. (A session with a seeded
// scribble instead of a named drawing keeps the colour that comes from its id.) The hue is used as
// hsl(hue 62% 30%) on light and hsl(hue 70% 76%) on dark, which reads for every hue.
export const drawingHue = name => { const at = DRAWINGS.indexOf(name); return at < 0 ? null : Math.round((162 + at * 137.508) % 360) }

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
  // the waste-paper basket at the end of the Desk's stacks (server/views/stacks.mjs): rim, body, a loose weave; full: a crumpled sheet over the rim
  basket: [[[3.6, 8.3], [8, 7.7], [12.2, 7.6], [16.4, 7.9], [20.4, 8.4]], [[4.9, 8.8], [5.9, 14.6], [7.1, 21.1], [12.1, 21.6], [16.9, 21], [18, 14.8], [19.2, 8.9]], [[8.7, 10.6], [9.3, 15.4], [9.9, 19.6]], [[12.2, 10.8], [12.1, 15.2], [12.3, 19.9]], [[15.6, 10.5], [15, 15.3], [14.4, 19.5]], [[6.4, 14.9], [9.6, 14.4], [13.2, 14.7], [17.6, 14.3]]],
  'basket-full': [[[3.6, 8.3], [8, 7.7], [12.2, 7.6], [16.4, 7.9], [20.4, 8.4]], [[4.9, 8.8], [5.9, 14.6], [7.1, 21.1], [12.1, 21.6], [16.9, 21], [18, 14.8], [19.2, 8.9]], [[8.7, 10.6], [9.3, 15.4], [9.9, 19.6]], [[12.2, 10.8], [12.1, 15.2], [12.3, 19.9]], [[15.6, 10.5], [15, 15.3], [14.4, 19.5]], [[6.4, 14.9], [9.6, 14.4], [13.2, 14.7], [17.6, 14.3]], [[8.6, 7.4], [7.8, 5.6], [8.9, 3.9], [10.9, 4.1], [12.4, 2.7], [14.8, 3.2], [15.9, 4.9], [15.2, 7.2]], [[10.1, 5.8], [11.6, 6.6], [12.7, 5.1], [13.9, 6.2]]],
  // other waste-paper baskets, proposed for the Desk's stacks (a decision card): a bucket with its lid ajar, a heap of
  // crumpled paper balls, a small shredder with its strips
  'bin-lid': [[[5.6, 10.8], [6.2, 16], [6.8, 21.1], [12, 21.4], [17.2, 21], [17.8, 16], [18.4, 10.8]], [[4.6, 10.6], [12, 10.2], [19.4, 10.6]], [[4.2, 8.4], [11.4, 5.6], [18.8, 3.4]], [[10.6, 6], [11.2, 4.4], [12.8, 4]], [[9.8, 13.4], [10, 16.4], [10.2, 19.2]], [[14.2, 13.4], [14, 16.4], [13.8, 19.2]], [[7.6, 10.2], [8.6, 8], [10.4, 8.6], [11.6, 7.4]]],
  'bin-balls': [[[7.4, 14.0], [9.7, 14.5], [11.6, 16.0], [11.1, 18.3], [9.9, 20.1], [7.8, 21.0], [5.7, 20.1], [3.9, 18.9], [3.4, 16.8], [4.3, 14.7], [6.8, 14.5], [8.9, 14.4]], [[16.4, 14.5], [19.0, 14.2], [20.5, 16.2], [19.7, 18.4], [19.5, 20.9], [16.8, 21.9], [14.3, 21.0], [12.5, 19.2], [12.9, 17.1], [14.0, 15.5], [15.6, 13.9], [17.8, 14.8]], [[11.9, 7.4], [14.0, 7.9], [15.0, 9.6], [15.7, 11.5], [14.4, 13.3], [12.3, 14.6], [9.9, 13.7], [8.1, 12.2], [8.0, 10.0], [8.9, 7.9], [11.2, 7.1], [13.4, 7.6]], [[5.6, 16], [7, 17.4], [6.6, 19], [8.6, 18.6]], [[14.6, 15.8], [16.4, 17], [15.6, 19.4], [18, 18.8]], [[10.4, 9], [11.4, 11.4], [12.6, 9.6], [13.4, 12]]],
  'bin-shredder': [[[4.2, 9.2], [12, 8.9], [19.8, 9.2], [19.9, 11.6], [19.8, 14.1], [12, 14.3], [4.2, 14.1], [4.1, 11.6], [4.2, 9.2]], [[6.4, 11.7], [12, 11.5], [17.6, 11.7]], [[8.2, 8.9], [8.1, 6], [8.2, 3.7], [8.3, 3.5], [12, 3.4], [15.7, 3.5], [15.8, 3.7], [15.9, 6], [16, 8.9]], [[9.8, 5.6], [14, 5.5]], [[9.8, 7.2], [12.6, 7.1]], [[7, 14.4], [7.4, 17.6], [6.8, 21]], [[10, 14.4], [10.3, 17.8], [10, 20.2]], [[13.2, 14.4], [12.8, 17.4], [13.3, 20.8]], [[16.6, 14.4], [16.9, 17], [16.5, 19.6]]],
  // a magnifier: search a stack's sheets (server/views/stacks.mjs)
  search: [[[10.5, 4.2], [6.1, 5.7], [4.3, 10.3], [6.3, 14.7], [10.7, 16.3], [15, 14.5], [16.7, 10.1], [14.7, 5.6], [10.1, 4]], [[15.1, 15.2], [19.9, 19.9]]],
  // a paperclip, bent in one go: attach something
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
  // Push on this device (js/push.js): a bell, its rim and its clapper.
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
  ['thin', 'M0.4 38.8 C1.8 38 3 39.2 4.4 38.6'],
  ['thin', 'M39 38.6 C40.8 37.6 42.6 39.4 44.4 38.6 C45.6 38 46.6 38.6 47.6 38.4'],
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

export function loopPath(r, { rad = 14.9, drift = 1.1, jitter = .9, start = 3.6 } = {}) {
  const steps = 17
  return penPath(Array.from({ length: steps }, (_, i) => {
    const a = start + (i / (steps - 2)) * Math.PI * 2, at = rad - (i / steps) * drift + (r() - .5) * jitter
    return [16 + Math.cos(a) * at, 16 + Math.sin(a) * at * .97]
  }))
}
export const penSeed = text => seeded(text)
// pen-tables:end

// ---- strings -------------------------------------------------------------------

const svg = (box, cls, inner, more = '') => `<svg viewBox="${box}"${cls ? ` class="${cls}"` : ''} aria-hidden="true"${more}>${inner}</svg>`
const paths = list => list.map(d => `<path d="${d}"/>`).join('')
const kept = new Map()
const once = (key, make) => { let v = kept.get(key); if (v == null) { v = make(); kept.set(key, v) } return v }

// The duck's parts as paths. Widths are in screen pixels (non-scaling), so the duck draws as heavy at 24 px as at 50.
const SURFACE = 'var(--surface, #fff)'
const DUCK_STYLE = {
  line: `fill:${SURFACE}`,
  open: '',
  thin: 'stroke-width:1.1px',
  bill: `fill:color-mix(in srgb, currentColor 22%, ${SURFACE});stroke-width:1.3px`,
  ink: 'fill:currentColor;stroke-width:1px',
  glint: `stroke:${SURFACE};stroke-width:1.4px`,
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
export const SKETCH_NAMES = Object.keys(SKETCH)

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
export const crownInner = () => `<path class="crown-wash" d="${CROWN_WASH}"/><path class="crown-pen" d="${CROWN}"/>${CROWN_JEWELS.map(([x, y, r]) => `<circle class="crown-jewel" cx="${x}" cy="${y}" r="${r}"/>`).join('')}`

/** The raised hand in its loop: a session that waits for the human (ui.js raisedHand). */
export function handSvg() {
  return once('hand', () => {
    const r = seeded('raised hand')
    const loop = loopPath(r)
    const hand = penPath(HAND.map(([x, y]) => [x + 2.9 + (r() - .5) * .8, y + 1.9 + (r() - .5) * .8]))
    return svg('0 0 32 32', 'hand-mark', `<path class="hand-loop" d="${loop}"/><path class="hand-pen" d="${hand}"/>`)
  })
}

/** The circle round a count (inbox.js penCircle). */
export const circleSvg = () => once('circle', () => `<svg viewBox="0 0 32 32" preserveAspectRatio="none" aria-hidden="true"><path d="${loopPath(seeded('count circle'), { rad: 14.2, drift: 1.4, jitter: .8, start: 4.1 })}"/></svg>`)

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
export function hueOf(id) {
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

/** A count kept on paper: strokes, five to a gate (ui.js tally). */
export function tallySvg(n, cap = 25) {
  const r = seeded('tally')
  const shown = Math.min(n, cap), gates = Math.ceil(shown / 5), width = Math.max(1, gates) * 34 - 6
  let out = ''
  for (let i = 0; i < shown; i++) {
    const gate = Math.floor(i / 5), at = i % 5, x0 = gate * 34 + 3
    const w = () => (r() - .5) * 1.6
    if (at < 4) { const x = x0 + at * 6.4; out += `<path d="${penPath([[x + w(), 3.4 + w()], [x + .6 + w() * .5, 12], [x + w(), 20.6 + w()]])}"/>` }
    else out += `<path d="${penPath([[x0 - 3 + w(), 17.6 + w()], [x0 + 10, 12 + w()], [x0 + 23.4 + w(), 6.2 + w()]])}"/>`
  }
  return `<span class="tally" role="img" aria-label="${n}"><svg viewBox="0 0 ${width} 24" class="tally-mark" aria-hidden="true" style="width:${width}px">${out}</svg>${n > shown ? `<span class="tally-more">+${n - shown}</span>` : ''}</span>`
}

/** A stack of paper: one sheet for every three that lie on it (piles.js paper). */
export function paperSvg(n, key = '') {
  let seed = 7 + n
  for (const ch of key) seed = (seed * 31 + ch.charCodeAt(0)) % 2147483647
  const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - .5
  const sheets = Math.min(6, Math.max(1, Math.ceil(n / 3))), W = 124, H = 78, pad = 6, step = 3.4
  const sheet = () => {
    const c = [[pad, pad], [pad + W, pad], [pad + W, pad + H], [pad, pad + H]].map(([x, y]) => [x + r() * 1.8, y + r() * 1.8])
    let d = `M${c[0][0].toFixed(1)} ${c[0][1].toFixed(1)}`
    for (let i = 1; i <= 4; i++) { const a = c[i - 1], b = c[i % 4]; d += ` Q${((a[0] + b[0]) / 2 + r() * 2.4).toFixed(1)} ${((a[1] + b[1]) / 2 + r() * 2.4).toFixed(1)} ${b[0].toFixed(1)} ${b[1].toFixed(1)}` }
    return `${d}Z`
  }
  let out = ''
  for (let i = sheets - 1; i >= 0; i--) out += `<path transform="translate(${i ? (r() * 7).toFixed(1) : 0} ${(i * step).toFixed(1)}) rotate(${(r() * (i ? 7 : 1.6)).toFixed(2)} ${pad + W / 2} ${pad + H / 2})" d="${sheet()}"/>`
  const h = (H + 2 * pad + (sheets - 1) * step).toFixed(0)
  return `<svg class="inbox-stack-sheets" width="${W + 2 * pad}" height="${h}" viewBox="0 0 ${W + 2 * pad} ${h}" aria-hidden="true">${out}</svg>`
}

/** The pointing hand beside the paragraph an agent marks with "☞" (ui.js pointingHand). */
export function pointingHandSvg() {
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
export { seeded, penPath, SKETCH, SNOOZE_Z }
