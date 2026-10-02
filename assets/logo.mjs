// The Trommi mark: a scribbled Z in a ring drawn by hand that does not close, white on a green tile.
// This file is the source of the mark. assets/build.mjs makes every logo file from it and writes the small
// cuts into the web client (the top bar's mark in index.html, the icon link of the pages).
//
// A stroke is a list of points [x, y, r] in a 64 box, r the half width of the pen there. A point given
// twice is a sharp corner. Chosen from eight studies (client/web/designs/logo-ring.html, card Nr. 130);
// the pen below is the one of that study (client/web/designs/src/logo-build.mjs).

/** A circle by hand: a bit more than one turn, drifting inward, not closing. */
const loop = (cx, cy, rad, w, turns = 1.1, start = -2.3) => Array.from({ length: 15 }, (_, i) => {
  const wob = [0, .9, -.4, .6, -.8, .3, .9, -.5, .2, -.9, .5, .1, -.6, .4, 0][i]
  const a = start + (i / 14) * Math.PI * 2 * turns, at = rad - (i / 14) * 2.6 + wob
  return [cx + Math.cos(a) * at * 1.03, cy + Math.sin(a) * at * .97, w * (i < 2 ? .7 + i * .15 : i > 12 ? .75 : 1)]
})

/** The tile the mark stands on: a square of 64 with this corner. */
export const TILE = { size: 64, rx: 18 }

/** Three cuts of the same mark, by the size it is shown at.
 *  big:   48 px and up. The pen's pressure shows; drawn as a filled outline.
 *  small: 20 to 40 px (the top bar, a tab on a dense screen). A larger Z, a thinner ring further out, the
 *         pen heavier by `heavier`; drawn as plain strokes of one width, pressure cannot be seen at this size.
 *  tiny:  16 px. No ring: at 16 px it leaves the Z five pixels and turns to grey mush. The Z alone, as
 *         large as the tile takes, with a pen two and a half pixels wide. */
export const CUTS = {
  big: { strokes: [
    loop(32, 32, 27, 1.5),
    [[21, 23, 2.6], [32, 22, 2.7], [43, 21.5, 2.7], [43, 21.5, 2.7], [32, 32.5, 2.8], [21, 43, 2.8], [21, 43, 2.8], [32, 42.5, 2.7], [44, 42, 2.5]],
  ] },
  small: { heavier: 1.35, strokes: [
    loop(32, 32, 28, 1.25, 1.04),
    [[19.5, 21.5, 2.7], [32, 20.5, 2.8], [44.5, 20, 2.8], [44.5, 20, 2.8], [32, 32.5, 2.9], [19.5, 44.5, 2.9], [19.5, 44.5, 2.9], [32, 44, 2.8], [45.5, 43.5, 2.6]],
  ] },
  tiny: { heavier: 1, strokes: [
    [[17, 19.5, 5], [32, 18.5, 5], [47, 18, 5], [47, 18, 5], [32, 33, 5], [17, 46.5, 5], [17, 46.5, 5], [32, 46, 5], [48, 45.5, 5]],
  ] },
}
/** The square of the 64 box the big cut fills when it stands alone, without a tile: [x, y, side]. */
export const CROP = [2, 2, 60]

// ---- the pen ---------------------------------------------------------------------------------------

const seeded = seed => {
  let s = [...seed].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) || 1
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
}
const cr = (a, b, c, d, t) => .5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t)
function samples(pts, per = 7) {
  const p = [pts[0], ...pts, pts.at(-1)]
  const res = []
  for (let i = 1; i < p.length - 2; i++) {
    if (p[i][0] === p[i + 1][0] && p[i][1] === p[i + 1][1]) continue
    for (let s = 0; s < per; s++) {
      const t = s / per
      res.push([cr(p[i - 1][0], p[i][0], p[i + 1][0], p[i + 2][0], t), cr(p[i - 1][1], p[i][1], p[i + 1][1], p[i + 2][1], t), p[i][2] + (p[i + 1][2] - p[i][2]) * t])
    }
  }
  res.push([...pts.at(-1)])
  return res
}
const f = n => (Math.round(n * 100) / 100).toString()

/** One stroke as a filled outline with the pen's pressure: a disc at every sample, joined by quads. */
export function outline(pts, { seed = 'z', rough = .05 } = {}) {
  const r = seeded(seed)
  const p1 = r() * 6.3, p2 = r() * 6.3
  const sm = samples(pts).map(([x, y, w], i) => [x, y, Math.max(.25, w * (1 + rough * (Math.sin(i * .21 + p1) + .6 * Math.sin(i * .47 + p2))))])
  let d = ''
  const disc = ([x, y, w]) => `M${f(x - w)} ${f(y)}a${f(w)} ${f(w)} 0 1 1 ${f(2 * w)} 0a${f(w)} ${f(w)} 0 1 1 ${f(-2 * w)} 0z`
  for (let i = 0; i < sm.length; i++) {
    d += disc(sm[i])
    if (i === 0) continue
    const a = sm[i - 1], b = sm[i]
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy)
    if (len < .05) continue
    const nx = -dy / len, ny = dx / len
    let q = [[a[0] + nx * a[2], a[1] + ny * a[2]], [b[0] + nx * b[2], b[1] + ny * b[2]], [b[0] - nx * b[2], b[1] - ny * b[2]], [a[0] - nx * a[2], a[1] - ny * a[2]]]
    const area = q.reduce((s, p, k) => s + p[0] * q[(k + 1) % 4][1] - q[(k + 1) % 4][0] * p[1], 0)
    if (area < 0) q = q.reverse()
    d += `M${q.map(p => `${f(p[0])} ${f(p[1])}`).join('L')}z`
  }
  return d
}

/** One stroke as its middle line (the same curve through the points, as Bézier pieces) and one width:
 *  { d, width }. For the small cuts, where it is drawn with stroke-width. */
export function line(pts, heavier = 1) {
  const g = n => (Math.round(n * 10) / 10).toString()
  const p = [pts[0], ...pts, pts.at(-1)]
  let d = `M${g(pts[0][0])} ${g(pts[0][1])}`
  for (let i = 1; i < p.length - 2; i++) {
    const [a, b, c, e] = [p[i - 1], p[i], p[i + 1], p[i + 2]]
    if (b[0] === c[0] && b[1] === c[1]) continue
    d += `C${g(b[0] + (c[0] - a[0]) / 6)} ${g(b[1] + (c[1] - a[1]) / 6)} ${g(c[0] - (e[0] - b[0]) / 6)} ${g(c[1] - (e[1] - b[1]) / 6)} ${g(c[0])} ${g(c[1])}`
  }
  const mean = pts.reduce((s, q) => s + q[2], 0) / pts.length
  return { d, width: Math.round(mean * 2 * heavier * 10) / 10 }
}
