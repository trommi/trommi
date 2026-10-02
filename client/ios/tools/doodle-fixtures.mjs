// Writes TrommiTests/Fixtures/doodles.json: what doodle(), pairDoodle() and sketch()
// in client/web/js/ui.js draw for a few seeds, so the Swift port can be compared
// with the web stroke for stroke.   node client/ios/tools/doodle-fixtures.mjs
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
globalThis.document = { createElementNS: (_, tag) => node(tag), createElement: tag => node(tag), querySelectorAll: () => [] }
// ui.js keeps relative times current with an interval; nothing here needs it.
globalThis.setInterval = () => 0

const ui = await import(pathToFileURL(path.join(here, '..', '..', 'web', 'js', 'ui.js')).href)
const paths = svg => svg.children.filter(c => c.tag === 'path').map(c => c.attrs.d)

const seeds = ['api', 'web-frontend', 'infrastructure', 'docs', 'docs-review', 'ios-app', 'main', 'old-spike', 'api:1', 'api:2', 'api:3', 'web-frontend:7',
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'Trommi', 'Größe', 'séance', '日本語', '🙂 session', '',
  // The forty drawings a session can be given by name, and a name that is none of them (it falls back to the seed).
  ...ui.DRAWINGS.map(ui.drawingMark), 'draw:nothing-of-the-kind']
const doodles = seeds.map(seed => {
  const svg = ui.doodle(seed)
  return { seed, rotate: parseFloat(svg.style.rotate) || 0, paths: paths(svg) }
})
// The first eight are the icons of the first port; the others follow in the order they were taken over.
const sketches = ['yes', 'no', 'hand', 'later', 'back', 'choose', 'other', 'whenever',
  'mic', 'send', 'reverse', 'clip', 'explain', 'archive', 'unfold', 'go', 'tray', 'heads', 'question', 'page'].map(name => {
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
// The crown of a starred session: one fixed path in a box of 26 x 19.
const crownSvg = ui.crown()
const crown = { box: crownSvg.attrs.viewBox, path: paths(crownSvg)[0] }
const out = path.join(here, '..', 'TrommiTests', 'Fixtures', 'doodles.json')
fs.writeFileSync(out, JSON.stringify({ doodles, sketches, pairs, crown }, null, 1) + '\n')
console.log(`${doodles.length} doodles, ${sketches.length} sketches, ${pairs.length} pairs -> ${out}`)
