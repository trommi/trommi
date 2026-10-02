// Writes tests/fixtures/doodles.json: what client/web/js/ui.js draws for a set
// of seeds, so the C++ port can be compared with the web stroke for stroke.
// The same seeds as client/ios/tools/doodle-fixtures.mjs, and more: every named
// drawing, every sketch, the crown, the raised hand, the loops.
//   node client/linux/tools/doodle-fixtures.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

// ui.js builds SVG nodes; this is the little of the DOM it touches.
const node = tag => ({
  tag, attrs: {}, children: [], dataset: {},
  style: { rotate: '', setProperty() {} },
  setAttribute(k, v) { this.attrs[k] = String(v) },
  append(...kids) { this.children.push(...kids) },
  get childNodes() { return this.children },
})
// (querySelector answers with something, so a module that adds its stylesheet once thinks it is there.)
globalThis.document = { createElementNS: (_, tag) => node(tag), createElement: tag => node(tag), querySelectorAll: () => [], querySelector: () => node('link'), head: node('head'), body: node('body') }
globalThis.setInterval = () => 0

const src = path.join(here, '..', '..', 'web', 'js', 'ui.js')
const ui = await import(pathToFileURL(src).href)
const paths = svg => svg.children.filter(c => c.tag === 'path').map(c => c.attrs.d)

const seeds = ['api', 'web-frontend', 'infrastructure', 'docs', 'docs-review', 'ios-app', 'main', 'old-spike', 'linux-client', 'api:1', 'api:2', 'api:3', 'web-frontend:7',
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'Trommi', 'Größe', 'séance', '日本語', '🙂 session', '',
  ...ui.DRAWINGS.map(ui.drawingMark), 'draw:nothing-of-the-kind']
const doodles = seeds.map(seed => {
  const svg = ui.doodle(seed)
  return { seed, rotate: parseFloat(svg.style.rotate) || 0, paths: paths(svg) }
})
const names = [...fs.readFileSync(src, 'utf8').split('const SKETCH = {')[1].split('\n}\n')[0].matchAll(/^  (\w+): /gm)].map(m => m[1])
const sketches = names.map(name => {
  const svg = ui.sketch(name)
  return { name, rotate: parseFloat(svg.style.rotate) || 0, paths: paths(svg) }
})
const pairs = [['docs', 'docs-review'], ['api', 'web-frontend', 'infrastructure'], ['a', 'b', 'c', 'd']].map(ids => {
  const svg = ui.pairDoodle(ids.map(id => ({ id, mark: id === 'docs' ? 'docs:3' : id, hue: 0 })))
  return {
    members: ids.map(id => ({ id, mark: id === 'docs' ? 'docs:3' : id })),
    transforms: svg.children.filter(c => c.tag === 'g').map(g => g.attrs.transform),
    loop: svg.children.find(c => c.tag === 'path').attrs.d,
  }
})
const out = {
  doodles, sketches, pairs,
  crown: paths(ui.crown())[0],
  hand: paths(ui.raisedHand()),
  advice: paths(ui.adviceLoop())[0],
  groupLoops: ['docs+docs-review', 'api+web-frontend+infrastructure'].map(seed => ({ seed, path: paths(ui.groupLoop(seed))[0] })),
  // The loop of the working ring (RING_LOOP in agents.js) and the marks of the Focus rail (focus.js).
  loops: [
    { seed: 'working ring', rad: 14.55, drift: .5, jitter: .6, start: 1.1 },
    { seed: 'rail:c-1', rad: 5.8, drift: .5, jitter: 1, start: 3.6 },
    { seed: 'raised hand', rad: 14.9, drift: 1.1, jitter: .9, start: 3.6 },
  ].map(o => ({ ...o, path: ui.loopPath(ui.penSeed(o.seed), o) })),
  // hueOf in agents.js (which cannot be loaded without a page): a stable hue per session.
  hues: seeds.slice(0, 35).map(id => { let h = 0; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return { id, hue: [162, 28, 262, 205, 338, 96, 48, 232][h % 8] } }),
}
const file = path.join(here, '..', 'tests', 'fixtures', 'doodles.json')
fs.writeFileSync(file, JSON.stringify(out, null, 1) + '\n')
console.log(`${doodles.length} doodles, ${sketches.length} sketches, ${pairs.length} pairs -> ${file}`)
