// Test cards for debugging the board's UI, against a running hub: a desk "Test" with the fake sessions Test Alpha and
// Test Beta (the existing ones are reused, with their subs), and one card of every kind (server/fixtures.mjs holds the set; the hub files them itself, through the
// route the Dev menu's "Create test cards" uses). His real desk stays as it is.
//   node dev/fixtures.mjs [--hub http://127.0.0.1:8790] [--kind all|decision|info|thread|artifact|urgent|<kind>]…
//   node dev/fixtures.mjs clear [--hub …]        takes away only what the fixtures filed (cards, their conversation, files);
//                                                the desk "Test" and both sessions stay, out of the real desk
//   node dev/fixtures.mjs kinds                  lists the kinds and groups
// The token is read from BOARD_TOKEN or <data>/token (BOARD_DATA, else data/); it is never printed. --base names the
// pages' prefix if the hub has one (BOARD_TURBO_BASE, e.g. /t).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { KINDS, GROUPS, FIXTURES } from '../server/fixtures.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const { values: opt, positionals: [cmd = 'make'] } = parseArgs({
  allowPositionals: true,
  options: { hub: { type: 'string' }, kind: { type: 'string', multiple: true }, base: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
})
if (opt.help || !['make', 'clear', 'kinds'].includes(cmd)) {
  console.log('usage: node dev/fixtures.mjs [make|clear|kinds] [--hub URL] [--kind KIND]… [--base /t]')
  process.exit(opt.help ? 0 : 1)
}
if (cmd === 'kinds') {
  console.log(`groups: all, ${GROUPS.join(', ')}`)
  for (const f of FIXTURES) console.log(`${f.kind.padEnd(10)} ${f.who.padEnd(6)} ${f.tool.padEnd(16)} ${f.args.title ?? f.args.text.slice(0, 50)}`)
  process.exit(0)
}

const hub = new URL(opt.hub ?? `http://127.0.0.1:${process.env.BOARD_PORT || 8790}`)
const base = (opt.base ?? process.env.BOARD_TURBO_BASE ?? '').replace(/\/+$/, '')
const data = process.env.BOARD_DATA || path.join(root, 'data')
const token = process.env.BOARD_TOKEN || fs.readFileSync(path.join(data, 'token'), 'utf8').trim()
const unknown = (opt.kind ?? []).filter(k => k !== 'all' && !KINDS.includes(k) && !GROUPS.includes(k))
if (unknown.length) { console.error(`unknown kind ${unknown.join(', ')}; see: node dev/fixtures.mjs kinds`); process.exit(1) }

// The same login and Origin a page of the board has: the login cookie, the hub's own origin.
const res = await fetch(new URL(`${base}/dev/fixtures${cmd === 'clear' ? '/clear' : ''}`, hub), {
  method: 'POST',
  headers: { Cookie: `board=${token}`, Origin: hub.origin, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams((opt.kind ?? []).map(k => ['kind', k])),
}).catch(err => { console.error(`the hub at ${hub.origin} did not answer: ${err.message}`); process.exit(1) })
const out = await res.json().catch(() => ({}))
if (!res.ok) {
  console.error(res.status === 404 ? `${hub.origin} has no /dev/fixtures yet: it needs a restart with this code` : `not done (${res.status}): ${out.error ?? res.statusText}`)
  process.exit(1)
}
if (cmd === 'clear') console.log(`removed ${out.cards.length} test cards of Test Alpha and Test Beta`)
else console.log(`made ${out.cards.length} test cards on the desk "Test" (Nr. ${out.cards.join(', ')}); open ${hub.origin}${base}/?desk=${out.desk}`)
