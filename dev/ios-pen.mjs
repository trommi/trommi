// ios-pen.mjs: the web app's hand-drawn marks as SVG strings for the iOS app (ios/TrommiApp/Sources/TrommiApp/Resources/pen.json),
// drawn by the same code (app/web/public/ui.mjs), and a fixture of seeded scribbles for the Swift port of the pen
// (ios/TrommiCore/Tests/TrommiClientTests/Fixtures/pen-vectors.json), and the EFF wordlist as Swift (TrommiClient/Wordlist.swift).
//   node dev/ios-pen.mjs
import fs from 'node:fs'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname)
const pub = path.join(here, '../app/web/public')
const ui = await import(path.join(pub, 'ui.mjs'))
const src = fs.readFileSync(path.join(pub, 'ui.mjs'), 'utf8')
const out = {}
// The sketches: every name of the SKETCH table, and the three drawn apart (snooze, duck, what).
const table = /const SKETCH = \{([\s\S]*?)\n\}\n/.exec(src)[1]
const names = [...table.matchAll(/^  '?([a-z][\w-]*)'?:/gm)].map(m => m[1])
for (const n of [...new Set([...names, 'snooze', 'duck', 'what'])]) out[`sketch:${n}`] = ui.sketchSvg(n)
// Every named drawing a session can wear ("draw:<name>"), and the extra marks.
const drawings = /const KINDS = \[([^\]]*)\]/.exec(src)[1].match(/'([a-z]+)'/g).map(s => s.slice(1, -1))
const named = [...(/const NAMED = \{([\s\S]*?)\n\}\n/.exec(src)[1]).matchAll(/^  ([a-z]+):/gm)].map(m => m[1])
for (const n of [...drawings, ...named]) out[`draw:${n}`] = ui.doodleSvg(`draw:${n}`)
out.crown = ui.crownSvg()
out.hand = ui.handSvg()
out.ring = ui.ringSvg()
out['ring-drop'] = ui.ringSvg({ loop: false, drop: true })
for (const t of ['image', 'video', 'audio', 'html', 'file']) out[`glyph:${t}`] = String(ui.assetGlyph(t))
// Every SVG the views write as a constant (raw('<svg …') or '<svg …'): the Blitz bolt, the gear, the boxes, the bell, the clamp…
for (const f of fs.readdirSync(pub).filter(f => f.endsWith('.mjs'))) {
  const text = fs.readFileSync(path.join(pub, f), 'utf8')
  for (const m of text.matchAll(/const ([A-Z_][A-Z0-9_]*) = raw\((['`])(<svg[\s\S]*?<\/svg>)\2\)/g)) out[`${f.replace('.mjs', '')}:${m[1]}`] = m[3]
}
const sorted = Object.fromEntries(Object.keys(out).sort().map(k => [k, out[k]]))
fs.writeFileSync(path.join(here, '../ios/TrommiApp/Sources/TrommiApp/Resources/pen.json'), JSON.stringify(sorted, null, 0) + '\n')
// Seeded scribbles for the Swift pen's test.
const seeds = ['abc123def456', 'trommi', '0f3a9c2e11b7', 'Web App 3', 'session-x', '5b1e', 'deadbeefcafe', 'helper-ui', 'draw:spiral', 'draw:hatch', 'draw:burst', 'draw:knot']
const vec = seeds.map(s => ({ seed: s, svg: ui.doodleSvg(s), hue: ui.hueFor({ id: s, mark: s }) }))
fs.writeFileSync(path.join(here, '../ios/TrommiCore/Tests/TrommiClientTests/Fixtures/pen-vectors.json'), JSON.stringify(vec, null, 1) + '\n')
// The EFF wordlist of shared/wordlist.mjs as Swift (the Emergency Kit, generated passwords).
const { WORDS } = await import(path.join(here, '../shared/wordlist.mjs'))
const lines = []
for (let i = 0; i < WORDS.length; i += 12) lines.push('  ' + WORDS.slice(i, i + 12).map(w => JSON.stringify(w)).join(', ') + ',')
fs.writeFileSync(path.join(here, '../ios/TrommiCore/Sources/TrommiClient/Wordlist.swift'), '// Wordlist.swift: the EFF large wordlist (https://www.eff.org/dice, CC BY 3.0 US, Electronic Frontier Foundation) as\n// shared/wordlist.mjs has it (7772 words: the four hyphenated ones left out), for generated passwords and the\n// Emergency Kit. Written by dev/ios-pen.mjs from that file; do not edit.\npublic let WORDS: [String] = [\n' + lines.join('\n') + '\n]\n')
console.log(`${Object.keys(sorted).length} marks, ${vec.length} vectors, ${WORDS.length} words`)
