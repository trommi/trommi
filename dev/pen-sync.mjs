// Copy the stroke tables of client/web/js/ui.js into client/web/js/pen.js (between its two marks).
//   node dev/pen-sync.mjs
// pen.js draws the board's hand-drawn marks as SVG strings for the hub's templates (server/views) and for
// islands; the old client still draws from ui.js. Run this after a drawing changed there. See docs/turbo.md.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = fs.readFileSync(path.join(root, 'client/web/js/ui.js'), 'utf8').split('\n')
const at = (re, from = 0) => { const i = src.findIndex((l, n) => n >= from && re.test(l)); if (i < 0) throw new Error(`ui.js has no line like ${re}`); return i }
const cut = (a, b) => src.slice(a, b).join('\n')
const hand = at(/^const HAND = \[/), point = at(/^const POINTING_HAND = \[/)
const tables = [
  cut(at(/^\/\/ Small seeded generator/), at(/^\/\/ What each drawing stands for/)),   // seeded, penPath, DOODLES, NAMED, DRAWINGS, hues
  src[at(/^const linePath/)],
  cut(at(/^const CROWN_WASH = /), at(/^const CROWN_JEWELS = /) + 1),                     // the crown: wash, pen line, stones
  cut(at(/^const flip = /), at(/^\/\/ Putting a question off/)),                         // THUMB, SKETCH
  cut(hand, at(/^\]/, hand) + 1),
  cut(point, at(/^\]/, point) + 1),
  cut(at(/^export function loopPath/), at(/^export const penSeed/) + 1),
].join('\n\n')
const file = path.join(root, 'client/web/js/pen.js')
const pen = fs.readFileSync(file, 'utf8')
const begin = '// pen-tables:begin\n', end = '// pen-tables:end\n'
const a = pen.indexOf(begin), b = pen.indexOf(end)
if (a < 0 || b < 0) throw new Error('pen.js has lost its marks')
const next = pen.slice(0, a + begin.length) + tables + '\n' + pen.slice(b)
if (next === pen) console.log('pen.js is up to date')
else { fs.writeFileSync(file, next); console.log('pen.js: tables copied from ui.js') }
