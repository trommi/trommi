// Write client/web/drawings.json: every drawing a session can wear, with what it stands for and its
// colour, so the hub can offer the list to agents without importing browser code.
//   node dev/drawings-json.mjs
// The data lives in client/web/js/ui.js (DRAWING_INFO); run this again after changing the drawings there.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const { DRAWING_INFO } = await import(pathToFileURL(path.join(root, 'client/web/js/ui.js')))
const out = path.join(root, 'client/web/drawings.json')
// The hub reads a plain list: [{ name, meaning, hue }] (docs/question-contract.md, section 7).
fs.writeFileSync(out, `[\n${DRAWING_INFO.map(d => `  ${JSON.stringify(d)}`).join(',\n')}\n]\n`)
console.log(`${DRAWING_INFO.length} drawings written to ${path.relative(root, out)}`)
process.exit(0)   // ui.js keeps a timer for the page; nothing to wait for here
