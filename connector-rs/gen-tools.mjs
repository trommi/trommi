#!/usr/bin/env node
// gen-tools.mjs: the tools' schemas of connector/tools.mjs, without their descriptions, as connector-rs/tools.json.
// The Rust connector takes the schemas from that file and every description from connector/prompt.md, both at build
// time (build.rs), so tools/list is byte for byte the JS connector's. Run it after a change of connector/tools.mjs:
//
//   node connector-rs/gen-tools.mjs            write connector-rs/tools.json
//   node connector-rs/gen-tools.mjs --check    exit 1 when tools.json is not what tools.mjs gives (cargo test runs this)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

delete process.env.BOARD_MAX_HTML_KB          // the default (200 KB) is in the texts; the binary substitutes another
const here = path.dirname(fileURLToPath(import.meta.url))
const T = await import('../connector/tools.mjs')
const strip = t => Object.fromEntries(Object.entries(t).filter(([k]) => k !== 'description'))
const out = { tools: T.TOOLS.map(strip), reload: strip(T.RELOAD_TOOL), inbox: strip(T.INBOX_TOOL), session_tools: T.SESSION_TOOLS, examples: T.TOOL_EXAMPLES }
const text = JSON.stringify(out, null, 2) + '\n'
const file = path.join(here, 'tools.json')
if (process.argv.includes('--check')) {
  const now = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  if (now !== text) { console.error('connector-rs/tools.json is stale: run node connector-rs/gen-tools.mjs'); process.exit(1) }
  console.log('tools.json is current')
} else {
  fs.writeFileSync(file, text)
  console.log(`wrote ${path.relative(process.cwd(), file)} (${out.tools.length} tools + reload_connector + inbox)`)
}
