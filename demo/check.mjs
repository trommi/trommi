// The demo data's check (README.md beside this file): data/ is the one original, every consumer takes it at build time.
//   node demo/check.mjs           fails when the data is broken, a named file is missing, a file is named by nobody,
//                                 the JSON is not in its one written form, or a consumer keeps a copy of its own
//   node demo/check.mjs --write   writes fixture.json and screens.json in their one form (the same data gives the same
//                                 bytes; nothing else is changed)
// app/web/dev/check.mjs (npm test) runs it, and app/web/dev/build.mjs runs it before it builds: a web app with a broken
// demo is never deployed.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
/** The data's folder: what a consumer ships, nothing else in it. */
export const dataDir = (repo = REPO) => path.join(repo, 'demo', 'data')

const FIXTURE_KEYS = ['made_at', 'room', 'members', 'sessions', 'cards', 'permissions', 'notes', 'published', 'timelines', 'human']
const LISTS = ['members', 'sessions', 'cards', 'permissions', 'notes', 'published']
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** fixture.json as written: two spaces, the keys in the order they have, one newline at the end. */
export const formatFixture = fixture => `${JSON.stringify(fixture, null, 2)}\n`
/** screens.json as written: one state per line, its keys in one order. */
export function formatScreens({ states }) {
  const line = s => JSON.stringify({ id: s.id, screen: s.screen, state: s.state, web: { path: s.web.path, state: s.web.state ?? null, mock: s.web.mock } })
  return states.length ? `{\n  "states": [\n${states.map(s => `    ${line(s)}`).join(',\n')}\n  ]\n}\n` : '{\n  "states": []\n}\n'
}

/** The demo data, read and checked: { fixture, states, files: [name], problems: [text] }. */
export function readDemo(repo = REPO) {
  const dir = dataDir(repo), problems = []
  const json = name => { try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) } catch (err) { problems.push(`demo/data/${name}: ${err.message}`); return null } }
  const fixture = json('fixture.json'), screens = json('screens.json')
  // (files/ is there only when the room names files)
  const files = fs.existsSync(path.join(dir, 'files')) ? fs.readdirSync(path.join(dir, 'files')).sort() : []

  // ---- the room ----
  if (fixture) {
    const keys = Object.keys(fixture)
    if (keys.join() !== FIXTURE_KEYS.join()) problems.push(`demo/data/fixture.json: its keys are ${keys.join(', ')}; expected ${FIXTURE_KEYS.join(', ')} (demo/README.md "fixture.json")`)
    if (!Number.isFinite(fixture.made_at)) problems.push('demo/data/fixture.json: made_at is not a time (every time in the file is relative to it)')
    for (const k of LISTS) if (!Array.isArray(fixture[k])) problems.push(`demo/data/fixture.json: ${k} is not a list`)
    for (const k of ['room', 'timelines', 'human']) if (!fixture[k] || typeof fixture[k] !== 'object' || Array.isArray(fixture[k])) problems.push(`demo/data/fixture.json: ${k} is not an object`)
    const me = fixture.room?.my_device_id
    const members = Array.isArray(fixture.members) ? fixture.members : []
    if (typeof me !== 'string' || !members.some(m => m?.device_id === me && m.device_role === 'human')) problems.push('demo/data/fixture.json: room.my_device_id is not a human device of members (the device that looks at the room)')
  }
  // ---- the states (an empty list is fine: /screens then says there are none) ----
  const listed = Array.isArray(screens?.states)
  if (screens && !listed) problems.push('demo/data/screens.json: not { "states": [...] }')
  const states = listed ? screens.states : []
  const ids = new Set()
  for (const s of states) {
    const at = `demo/data/screens.json: ${s?.id ?? JSON.stringify(s)}`
    if (typeof s?.id !== 'string' || typeof s.screen !== 'string' || typeof s.state !== 'string' || typeof s.web?.path !== 'string' || typeof s.web?.mock !== 'string' || !(s.web.state === null || typeof s.web.state === 'string')) { problems.push(`${at}: not { id, screen, state, web: { path, state, mock } }`); continue }
    if (ids.has(s.id)) problems.push(`${at}: the id twice`)
    ids.add(s.id)
    const first = states.find(x => x.screen === s.screen) === s
    const want = first ? slug(s.screen) : `${slug(s.screen)}--${slug(s.state)}`
    if (s.id !== want) problems.push(`${at}: the id of "${s.screen}" / "${s.state}" is ${want}${first ? ' (the first state of a screen is the screen as it is)' : ''}`)
    if (!s.web.path.startsWith('/')) problems.push(`${at}: web.path does not start with /`)
  }
  // (a screen's states stand together: the web lists them under one title)
  const order = states.map(s => s?.screen).filter((x, i, all) => x !== all[i - 1])
  if (new Set(order).size !== order.length) problems.push('demo/data/screens.json: the states of one screen are not together')

  // ---- the one written form ----
  const written = [['fixture.json', fixture && formatFixture(fixture)], ['screens.json', listed && !problems.some(p => p.includes('screens.json')) && formatScreens(screens)]]
  for (const [name, text] of written) if (text && text !== fs.readFileSync(path.join(dir, name), 'utf8')) problems.push(`demo/data/${name}: not in its written form (node demo/check.mjs --write)`)

  // ---- the files: every named one is there, every one is named ----
  const named = new Map()   // name -> who names it
  const name = (file, who) => { if (!named.has(file)) named.set(file, who) }
  const refs = (text, who) => { for (const [, f] of text.matchAll(/\/demo\/files\/([\w.-]+\.\w+)/g)) name(f, who) }
  if (fixture) refs(JSON.stringify(fixture), 'demo/data/fixture.json')
  for (const f of files.filter(f => /\.html?$/.test(f))) refs(fs.readFileSync(path.join(dir, 'files', f), 'utf8'), `demo/data/files/${f}`)
  const code = 'app/web/public/demo/demo.mjs'
  const src = fs.existsSync(path.join(repo, code)) ? fs.readFileSync(path.join(repo, code), 'utf8') : (problems.push(`${code}: missing`), '')
  refs(src, code)
  for (const [f, who] of named) if (!files.includes(f)) problems.push(`${who} names /demo/files/${f}: no such file in demo/data/files/`)
  for (const f of files) if (!named.has(f)) problems.push(`demo/data/files/${f}: named by nobody (the fixture, demo.mjs, a page in files/)`)

  // ---- the consumers: no copy of their own ----
  const tracked = (() => { try { return execFileSync('git', ['-C', repo, 'ls-files', '--', 'app/web/public/demo'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean) } catch { return [] } })()   // (no git: a build from an archive)
  const OWN = ['app/web/public/demo/demo.mjs', 'app/web/public/demo/screens.css']
  for (const f of tracked) if (!OWN.includes(f)) problems.push(`${f}: a copy of the demo data in git; demo/data/ is the one original`)
  return { fixture, states, files, problems }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dir = dataDir()
  if (process.argv.includes('--write')) {
    fs.writeFileSync(path.join(dir, 'fixture.json'), formatFixture(JSON.parse(fs.readFileSync(path.join(dir, 'fixture.json'), 'utf8'))))
    fs.writeFileSync(path.join(dir, 'screens.json'), formatScreens(JSON.parse(fs.readFileSync(path.join(dir, 'screens.json'), 'utf8'))))
  }
  const { fixture, states, files, problems } = readDemo()
  if (problems.length) { console.error(problems.join('\n')); process.exit(1) }
  console.log(`demo data ok: ${fixture.cards.length} cards, ${fixture.sessions.length} sessions, ${states.length} states of ${new Set(states.map(s => s.screen)).size} screens, ${files.length} files`)
}
