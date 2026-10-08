// parity.mjs: the feature parity of the iPhone (Swift) against the web (JS), the "API abgleich" (README "Interop").
//
//   node dev/interop/parity.mjs                  out/parity.md, out/parity.html, out/parity.json; a summary on stdout
//   node dev/interop/parity.mjs --check          exit 1 when a row got worse than dev/interop/parity-baseline.json
//                                                (or a web evidence went stale): for CI
//   node dev/interop/parity.mjs --update-baseline   write the current state as the baseline
//
// What the web does is the reference, read from code wherever there is a registry:
//   routes      the README's route table (## Routes) against the call sites in shared/ + app/web (JS) and in
//               TrommiCore/TrommiClient + TrommiApp (Swift)
//   wire        envelope kinds, object types, card types, content types, answer actions, timeline kinds:
//               shared/codec.mjs against TrommiCore (Compat.swift, Envelope.swift)
//   fields      every body field of a card, a message and an answer (codec.mjs FIELDS): read by the Swift core, used
//               by the app
//   driver      the interop driver commands (driver-js.mjs against Driver.swift)
//   features    the list below: each row names its evidence in the web code (must match, else the row is "stale")
//               and in the Swift core and the app. The app may declare a row in ios/TrommiApp/features.json
//               ({ "features": { "<id>": { "status": "full" | "partial" | "missing", "note": "…" } } }); a
//               declaration wins over the inference from code.
//   tested      a row whose scenario passed for a Swift pair in out/run.json (node dev/interop/run.mjs) says so.
import fs from 'node:fs'
import path from 'node:path'
import * as codec from '../../shared/codec.ts'
import { COMMANDS } from './protocol.mjs'

const here = path.dirname(new URL(import.meta.url).pathname)
const root = path.join(here, '../..')
const rd = p => { try { return fs.readFileSync(path.join(root, p), 'utf8') } catch { return '' } }
const files = (dir, ext) => { try { return fs.readdirSync(path.join(root, dir)).filter(f => f.endsWith(ext)).map(f => `${dir}/${f}`) } catch { return [] } }
const cat = list => list.map(f => rd(f)).join('\n')

const WEB = cat([...files('app/web/public', '.mjs')])
const JSCORE = cat(['shared/client.mjs', 'shared/agent.mjs', 'shared/model.ts', 'shared/transport.mjs', 'shared/account.mjs', 'shared/room.mjs', 'shared/scribble.mjs', 'shared/codec.ts'])
const SWCORE = cat([...files('ios/TrommiCore/Sources/TrommiClient', '.swift'), ...files('ios/TrommiCore/Sources/TrommiCore', '.swift')])
const SWAPP = cat(files('ios/TrommiApp/Sources/TrommiApp', '.swift'))
const DRIVER_SWIFT = rd('ios/TrommiCore/Sources/trommi-swift/Driver.swift')
const declared = (() => { try { return JSON.parse(rd('ios/TrommiApp/features.json') || 'null') } catch { return null } })()
const run = (() => { try { return JSON.parse(fs.readFileSync(path.join(here, 'out/run.json'), 'utf8')) } catch { return null } })()

const has = (text, re) => (re instanceof RegExp ? re.test(text) : text.includes(re))
const any = (text, list) => list.some(re => has(text, re))
const RANK = { full: 2, partial: 1, missing: 0 }
const MARK = { full: '✓', partial: 'partial', missing: 'missing', stale: 'stale' }

// ---- 1. routes -----------------------------------------------------------------------------------------------------
function readmeRoutes() {
  const md = rd('README.md')
  const sec = md.split('### Routes')[1]?.split('\n### ')[0] ?? ''
  const out = new Map()
  for (const m of sec.matchAll(/^\| `(GET|POST|PUT|DELETE) (\/v1\/[^`?\s]*)[^`]*`[^|]*\| ([^|]*)\|/gm)) out.set(`${m[1]} ${m[2].replace(/:[a-z_]+/g, ':x')}`, m[3].trim())
  return out
}
const norm = p => `/v1${p}`.replace(/\$\{[^}]*\}|\\\([^)]*(\([^)]*\))?[^)]*\)|:[a-z_]+/g, ':x').replace(/\/+$/, '').replace(/\?.*$/, '')
function jsRoutes() {
  const src = cat(['shared/transport.mjs', 'shared/account.mjs', 'shared/client.mjs', 'shared/room.mjs']) + WEB
  const out = new Set()
  for (const m of src.matchAll(/request\(\s*'(GET|POST|PUT|DELETE)',\s*(?:[\w.]+\.)?(roomPath\()?\s*(?:`([^`]*)`|'([^']*)')/g)) out.add(`${m[1]} ${norm((m[2] ? '/rooms/:x' : '') + (m[3] ?? m[4]))}`)
  if (/roomPath\('\/stream'\)/.test(src)) out.add('GET /v1/rooms/:x/stream')
  if (/['`]\/v1\/version['`]/.test(src)) out.add('GET /v1/version')
  return out
}
function swiftRoutes() {
  const src = SWCORE + SWAPP
  const out = new Set()
  // request("M", roomPath("…")), request("M", accountPath("…")), request("M", "/rooms/\(…)/…")
  const lit = s => s.replace(/\\\((?:[^()]|\([^()]*\))*\)/g, ':x')
  for (const m of src.matchAll(/request\(\s*"(GET|POST|PUT|DELETE)",\s*(roomPath|accountPath|room\.accountPath)?\(?\s*"((?:[^"\\]|\\\((?:[^()]|\([^()]*\))*\))*)"/g)) {
    const prefix = m[2] === 'roomPath' ? '/rooms/:x' : m[2]?.endsWith('accountPath') ? '/rooms/:x/account' : ''
    out.add(`${m[1]} ${norm(prefix + lit(m[3]))}`)
  }
  for (const m of src.matchAll(/request\(\s*"(GET|POST|PUT|DELETE)",\s*(room\.)?accountPath\(\)\s*[,)]/g)) out.add(`${m[1]} /v1/rooms/:x/account`)
  if (/\/v1\/rooms\/\\\(record\.roomId\)\/stream/.test(src)) out.add('GET /v1/rooms/:x/stream')
  if (/\/v1\/version/.test(src)) out.add('GET /v1/version')
  if (/roomPath\("\/attachments\//.test(src)) { out.add('GET /v1/rooms/:x/attachments/:x'); if (/httpMethod = "PUT"/.test(src)) out.add('PUT /v1/rooms/:x/attachments/:x') }
  return out
}

/** A route the web uses one at a time where the iPhone uses the bundled one (or the reverse): the same capability. */
const ROUTE_ALT = {
  'GET /v1/rooms/:x/sessions': 'GET /v1/rooms/:x/session_grants', 'GET /v1/rooms/:x/sessions/:x/grants': 'GET /v1/rooms/:x/session_grants',
  'GET /v1/rooms/:x/sessions/:x/sealed_session_keys': 'GET /v1/rooms/:x/session_grants', 'GET /v1/rooms/:x/sessions/:x/key_back_links': 'GET /v1/rooms/:x/session_grants',
  'POST /v1/rooms/:x/sessions/:x/grants': 'POST /v1/rooms/:x/session_grants',
}

// ---- 2. wire vocabulary -------------------------------------------------------------------------------------------
const swiftSet = name => { const m = new RegExp(`${name}: Set<\\w+> = \\[([^\\]]*)\\]`).exec(SWCORE); return m ? m[1].split(',').map(s => s.trim().replace(/"/g, '')).filter(Boolean) : [] }
function wire() {
  const swKinds = (() => { const m = /static let MAX = (\d+)/.exec(SWCORE); return m ? Array.from({ length: Number(m[1]) }, (_, i) => i + 1) : [] })()
  const swTimeline = (() => { const m = /enum TIMELINE \{ public static let ([^}]*)\}/.exec(SWCORE); return m ? [...m[1].matchAll(/(\w+) = (\d+)/g)].map(x => `${x[2]} ${x[1].toLowerCase()}`) : [] })()
  const jsTimeline = Object.entries(codec.TIMELINE_KIND_NAME).map(([n, v]) => `${n} ${v}`)
  const rows = []
  const add = (group, js, sw, label = x => x) => { for (const v of [...new Set([...js, ...sw])].sort()) rows.push({ group, item: label(v), web: js.includes(v), ios: sw.includes(v) }) }
  add('envelope kind', Object.entries(codec.KIND).map(([k, n]) => `${n} ${k}`), swKinds.map(n => `${n} ${codec.KIND_NAME[n] ?? '?'}`))
  add('content type', [...codec.CONTENT_TYPES], swiftSet('CONTENT_TYPES'))
  add('object type', [...codec.OBJECT_TYPES], swiftSet('OBJECT_TYPES'))
  add('card type', [...codec.CARD_TYPES], swiftSet('CARD_TYPES'))
  add('answer action', [...codec.ANSWER_ACTIONS], swiftSet('ANSWER_ACTIONS'))
  add('timeline kind', jsTimeline, swTimeline)
  // what each side writes: envelope kinds a human device sends
  const jsWrites = Object.keys(codec.KIND).filter(k => new RegExp(`kind: codec\\.KIND\\.${k}\\b`).test(JSCORE))
  const swWrites = Object.keys(codec.KIND).filter(k => new RegExp(`kind: KIND\\.${k.toUpperCase()}\\b`).test(SWCORE))
  const AGENT_ONLY = ['permission_request']
  for (const k of [...new Set([...jsWrites, ...swWrites])].filter(k => !AGENT_ONLY.includes(k))) rows.push({ group: 'writes kind', item: k, web: jsWrites.includes(k), ios: swWrites.includes(k) })
  return rows
}

// ---- 3. body fields: read by the Swift core, used by the app --------------------------------------------------------
const camel = s => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
const FIELD_ALIAS = { merged_into_object_id: ['mergedInto'], merged_from_object_ids: ['mergedFrom'], hand_back: ['handback'], present_card: ['present'], copied_cards: ['copiedCards'],
  published_object_id: ['published'], note: ['note'], card_type: ['kind'], answer_action: ['action', 'markRead', 'shred'], allows_multiple: ['allowsMultiple', 'multiple'], close_summary: ['summary'], option_notes: ['optionNotes'], change_note: ['revisionNote'] }
function fields() {
  const rows = []
  for (const [kind, list] of [['card', codec.FIELDS.card.slice(3)], ['message', codec.FIELDS.message.slice(1)], ['answer', codec.FIELDS.answer]]) {
    for (const f of list) {
      const names = [f, camel(f), ...(FIELD_ALIAS[f] ?? [])]
      const core = has(SWCORE, `"${f}"`) || names.some(n => new RegExp(`\\b(var|let) ${n}\\b`).test(SWCORE))
      const app = names.some(n => new RegExp(`\\.${n}\\b|"${n}"`).test(SWAPP))
      const web = has(WEB + JSCORE, f)
      rows.push({ group: kind, item: f, web, core, app, status: core && app ? 'full' : core || app ? 'partial' : 'missing' })
    }
  }
  return rows
}

// ---- 4. features (rank: 1 = used every day) -----------------------------------------------------------------------------
// web: evidence in app/web or shared (must match); core / app: evidence in TrommiCore / TrommiApp; test: run.mjs scenario.
const F = (id, rank, group, label, web, core, app, test = null) => ({ id, rank, group, label, web, core, app, test })
const FEATURES = [
  F('desk', 1, 'Desk', 'The Desk: open cards as rows, the stack order', [/deskMain|desk\.mjs/], [/var stack/], [/struct DeskScreen/], 'cards:'),
  F('answer', 1, 'Cards', 'Answer a card with a tap', [/\.answer\(/], [/func answer\(cardId/], [/\.answer\(cardId/], 'answer:'),
  F('card-page', 1, 'Cards', 'The card page (title, body, options)', [/cardPage|card\.mjs/], [/struct DeskCard/], [/struct CardScreen/]),
  F('push', 1, 'Push', 'Push notifications for new cards', [/pushSubscribe/], [/registerApns/], [/registerApns/], 'push:'),
  F('chat', 1, 'Chat', 'A session\'s conversation: read and write', [/sendMessage\(/], [/func sendMessage\(/], [/sendMessage\(/], 'chat:'),
  F('live', 1, 'Sync', 'Live updates (the stream)', [/\.stream\(|_openStream/], [/func runLive/], [/runLive\(/], 'cards:'),
  F('chat-history', 2, 'Chat', 'Older messages page in (Earlier)', [/timelineWindow|loadTimeline/], [/func loadOlder/], [/loadOlder\(/], 'chat:'),
  F('multiple', 2, 'Cards', 'Several answers (allows_multiple)', [/allows_multiple/], [/allowsMultiple/], [/\.multiple\b|allowsMultiple/], 'multiple'),
  F('final', 2, 'Cards', 'Options marked final settle the card', [/choicesFinal|\.final\b/], [/func choicesFinal/], [/\.final\b|settled/], 'multiple'),
  F('urgency', 2, 'Cards', 'Urgency: knock, blocking, reason', [/urgency_reason/], [/urgencyReason/], [/knockWord|urgencyReason/]),
  F('info-read', 2, 'Cards', 'Info cards: mark as read', [/markRead/], [/func markRead/], [/markRead\(/], 'read and shred'),
  F('shred', 2, 'Cards', 'Shred a card', [/shred/], [/func shred/], [/shred\(/], 'read and shred'),
  F('duck', 2, 'Cards', 'Duck: the agent\'s own recommendation (trust)', [/trust\(/], [/func trust\(/], [/trust\(cardId/]),
  F('snooze', 2, 'Desk', 'Later: snooze a card', [/snooze/], [/func snooze/], [/snooze\(/], 'registers'),
  F('sections', 2, 'Cards', 'Cards with sections', [/sections/], [/sections/], [/\.sections\b/], 'cards:'),
  F('attachments-card', 2, 'Cards', 'Pictures and files on a card', [/attachments/], [/fetchAttachment/], [/struct Attachments|AttachmentImage/]),
  F('html', 3, 'Cards', 'Rich html on cards and messages', [/\.html\b/], [/html/], [/SandboxedPage|RichText/], 'cards:'),
  F('video', 3, 'Media', 'Videos (and their poster)', [/video/], [/media_type/], [/VideoFile/]),
  F('marks', 3, 'Cards', 'Marks on pictures (circled regions)', [/marks/], [/marks/], [/\.marks\b|marks:/]),
  F('option-notes', 3, 'Cards', 'A note per option, a note with the answer', [/option_notes/], [/optionNotes/], [/optionNotes/]),
  F('answer-files', 3, 'Cards', 'Files and drawings attached to an answer', [/uploadAttachment/], [/func uploadAttachment/], [/uploadAttachment\(/]),
  F('decide-again', 3, 'Cards', 'Decide again (take an answer back)', [/decideAgain/], [/func decideAgain/], [/decideAgain\(/], 'decide again'),
  F('permission', 3, 'Cards', 'Permission requests: allow / deny', [/verdict/], [/func verdict/], [/verdict\(/]),
  F('versions', 3, 'Cards', 'A revised card: its earlier versions', [/versions/], [/CardVersion/], [/\.versions\b/], 'agent side'),
  F('drafts', 3, 'Cards', 'Answer drafts kept across devices', [/setDraft/], [/func setDraft/], [/setDraft\(/]),
  F('hand-back', 3, 'Chat', 'Hand a card back, "What??" (explain), present', [/hand_back/], [/hand_back/], [/handback|hand_back/]),
  F('chat-files', 3, 'Chat', 'Files in a message', [/attachments/], [/sendMessage\(.*fields/], [/uploadAttachment\(/]),
  F('chat-details', 3, 'Chat', 'Details (collapsed) in a message', [/details/], [/details/], [/\.details\b/]),
  F('card-replies', 3, 'Chat', 'A card\'s own thread (replies on a card)', [/card\//], [/card\//], [/CardThread/]),
  F('copied-cards', 4, 'Chat', 'Copy a card into a message', [/copied_cards/], [/copied_cards|copiedCards/], [/copiedCards/]),
  F('selection', 4, 'Chat', 'Send a selection of the Scribble Board', [/selection_sent/], [/sendSelection/], [/sendSelection\(/]),
  F('blitz', 3, 'Desk', 'Blitz: one card at a time', [/blitz/], [/stack/], [/BlitzScreen/]),
  F('desks', 3, 'Desk', 'Desks: create, rename, filter, order', [/setDesk|'\/desk'/], [/func setDesk/], [/setDesk\(/], 'registers'),
  F('crown', 4, 'Desk', 'The crown (main session of a desk)', [/setCrown/], [/func setCrown/], [/setCrown\(/]),
  F('end-list', 3, 'Desk', 'The end list, piles of answered cards', [/end list|piles|endList/i], [/finished/], [/EndList/]),
  F('selection-bar', 4, 'Desk', 'Select several rows, act on all', [/select/], [/stack/], [/SelectionBar/]),
  F('off-your-mind', 3, 'Desk', 'Off your mind (stacks/off)', [/stacks\/off/], [/snooze|archived/], [/OffScreen/]),
  F('notes', 3, 'Notes', 'The corner note (notes)', [/saveNote/], [/func saveNote/], [/saveNote\(/], 'registers and notes'),
  F('sessions-open', 3, 'Sessions', 'Sessions: rename, star, archive', [/archived/], [/func editSession/], [/editSession\(/]),
  F('sessions-delete', 4, 'Sessions', 'Delete a session (its connector removed)', [/sessions\/\$\{encodeURIComponent\(a\.id\)\}\/delete|session-delete/], [/func removeDevices/], [/delete.*session|deleteSession/i]),
  F('sub-sessions', 4, 'Sessions', 'Helpers (sub-sessions) under their main', [/parent_session/], [/parentSessionOf/], [/\.parent\b|subs/]),
  F('media', 4, 'Media', 'Media: every picture and file', [/'\/assets'|\/assets/], [/fetchAttachment/], [/MediaScreen/]),
  F('pages', 4, 'Media', 'Pages: what agents published', [/'\/pages'|\/pages/], [/PublishedObject/], [/PublishedCard|published/]),
  F('share-links', 4, 'Media', 'Share links: make, list, revoke', [/shareAttachment/], [/func shareAttachment/], [/shareAttachment\(/]),
  F('share-revoke', 5, 'Media', 'Revoke a share link', [/revokeShare/], [/func revokeShare/], [/revokeShare\(/]),
  F('scribble', 4, 'Scribble', 'The Scribble Board: draw, see strokes', [/sendStrokes|scribble/], [/func sendCanvas|func loadCanvas/], [/ScribbleScreen/], 'scribble board'),
  F('settings-agents', 4, 'Settings', 'Settings: agents (invite an agent)', [/createInvite/], [/func createAgentInvite/], [/createAgentInvite\(/], 'agent invite from A'),
  F('settings-devices', 4, 'Settings', 'Settings: devices, remove one', [/removeDevices/], [/func removeDevices/], [/removeDevices\(/], 'removal from A'),
  F('pair-out', 4, 'Pairing', 'Pair a device from here (QR, emoji)', [/createInvite/], [/func createPairing/], [/createPairing\(/], 'pairing from A'),
  F('pair-in', 2, 'Pairing', 'Join by a link / QR code (emoji compare)', [/joinRoom/], [/static func join\(link/], [/QRScannerView|Room\.join\(/], 'setup'),
  F('login', 2, 'Account', 'Sign in with email and password', [/loginWithPassword/], [/func loginWithPassword/], [/loginWithPassword|signInWithPassword/], 'account'),
  F('account', 5, 'Account', 'Account: status, email code, password, Emergency Kit', [/makeEmergencyKit/], [/func makeEmergencyKit/], [/makeEmergencyKit\(/], 'account'),
  F('forgot', 5, 'Account', 'Forgot password (Emergency Kit words)', [/resetPassword/], [/func resetPassword/], [/resetPassword\(/], 'account'),
  F('found-room', 5, 'Account', 'Create an account (found a room)', [/createAccount|foundRoom/], [/func foundRoom|func createAccount/], [/createAccount|foundRoom/]),
  F('recovery-code', 5, 'Account', 'Recover with the old recovery code', [/recoverRoom|joinWithRecoveryCode/], [/func joinWithRecoveryCode/], [/joinWithRecoveryCode\(/]),
  F('logout', 5, 'Account', 'Log out (the device removes itself)', [/leaveRoom/], [/func leaveRoom/], [/leaveRoom\(/], 'log out'),
  F('takeover', 5, 'Sessions', 'Continue a session in a new agent (takeover invite)', [/takeover/], [/takeover/], [/takeover/]),
  F('version-check', 5, 'Versions', 'Update notice / "please update" (GET /v1/version, 426)', [/\/v1\/version/], [/func versionInfo/], [/UpdateRequired|UpdateBanner/], 'version_info'),
  F('newer', 5, 'Versions', 'What a newer client wrote shows as "needs an update"', [/UPDATE_MESSAGE|unsupported/], [/UPDATE_MESSAGE/], [/UnsupportedLine|UPDATE_MESSAGE/], 'newer version'),
  F('offline-cache', 3, 'Sync', 'Instant start from a stored copy', [/snapshot|loadPersisted/], [/ios-cache|saveCache/], [/saveCache|loadCache|cache/i]),
  F('keys', 5, 'Help', 'Keyboard keys, help page', [/help\.html/], [/./], [/CardKeys|keys/i]),
]

function features() {
  // the interop run: a scenario of the row passed (true) or failed (false) for a pair with Swift; null: not run
  const swiftRuns = name => (run?.results ?? []).filter(r => /swift/.test(r.pair) && r.name.includes(name))
  const passedSwift = name => { const l = swiftRuns(name); return l.length ? l.every(r => r.ok) : null }
  return FEATURES.map(f => {
    const web = any(WEB + JSCORE, f.web)
    const core = any(SWCORE, f.core), app = any(SWAPP, f.app)
    let status = core && app ? 'full' : core || app ? 'partial' : 'missing'
    let source = 'code'
    const d = declared?.features?.[f.id]
    if (d?.status && d.status in RANK) { status = d.status; source = 'declared' }
    const tested = f.test ? passedSwift(f.test) : null
    let note = d?.note ?? ''
    // what the code seems to have, the interop run did not confirm: partial at most
    if (tested === false && status === 'full') { status = 'partial'; note = `${note ? `${note}; ` : ''}interop scenario "${f.test}" fails with Swift` }
    return { id: f.id, rank: f.rank, group: f.group, label: f.label, web, core, app, status: web ? status : 'stale', source, note, tested }
  })
}

// ---- 5. driver commands ----------------------------------------------------------------------------------------------
function driver() {
  const js = [...rd('dev/interop/driver-js.mjs').matchAll(/^  async (\w+)\(/gm)].map(m => m[1])
  const sw = (/DRIVER_COMMANDS = \[([\s\S]*?)\]/.exec(DRIVER_SWIFT)?.[1] ?? '').match(/"(\w+)"/g)?.map(s => s.slice(1, -1)) ?? []
  return Object.keys(COMMANDS).map(c => ({ item: c, who: COMMANDS[c].who, web: js.includes(c), ios: sw.includes(c) }))
}

// ---- the report --------------------------------------------------------------------------------------------------------
const routes = (() => {
  const readme = readmeRoutes(), js = jsRoutes(), sw = swiftRoutes()
  const all = [...new Set([...readme.keys(), ...js, ...sw])].sort((a, b) => a.split(' ')[1].localeCompare(b.split(' ')[1]) || a.localeCompare(b))
  // agent-only routes (README "Who": agent …) are not the iPhone's
  return all.map(r => ({ item: r, readme: readme.has(r), who: readme.get(r) ?? '', agent_only: /^agent\b/.test(readme.get(r) ?? ''), web: js.has(r), ios: sw.has(r) || (ROUTE_ALT[r] != null && sw.has(ROUTE_ALT[r])), via: !sw.has(r) && ROUTE_ALT[r] && sw.has(ROUTE_ALT[r]) ? ROUTE_ALT[r] : null }))
})()
const wireRows = wire(), fieldRows = fields(), featureRows = features(), driverRows = driver()

const count = (rows, ok = r => r.status) => {
  const c = { full: 0, partial: 0, missing: 0, stale: 0 }
  for (const r of rows) c[ok(r)]++
  return c
}
const pairStatus = r => (r.web ? (r.ios ? 'full' : 'missing') : (r.ios ? 'full' : 'full'))
const sections = {
  features: { rows: featureRows, c: count(featureRows) },
  fields: { rows: fieldRows, c: count(fieldRows.filter(r => r.web)) },
  routes: { rows: routes, c: count(routes.filter(r => r.web && !r.agent_only), pairStatus) },
  wire: { rows: wireRows, c: count(wireRows.filter(r => r.web), pairStatus) },
  driver: { rows: driverRows, c: count(driverRows.filter(r => r.web && (r.who === 'human' || r.who === 'any')), pairStatus) },
}
const score = c => { const n = c.full + c.partial + c.missing; return n ? Math.round((100 * (c.full + 0.5 * c.partial)) / n) : 100 }
const summary = Object.fromEntries(Object.entries(sections).map(([k, s]) => [k, { ...s.c, score: score(s.c) }]))
const missingTop = featureRows.filter(r => r.status !== 'full').sort((a, b) => a.rank - b.rank || RANK[a.status] - RANK[b.status])

// machine-checkable state: one status per row id
const state = {}
for (const r of featureRows) state[`feature:${r.id}`] = r.status
for (const r of fieldRows) if (r.web) state[`field:${r.group}.${r.item}`] = r.status
for (const r of routes) if (r.web && !r.agent_only) state[`route:${r.item}`] = r.ios ? 'full' : 'missing'
for (const r of wireRows) if (r.web) state[`wire:${r.group}:${r.item}`] = r.ios ? 'full' : 'missing'

const out = path.join(here, 'out')
fs.mkdirSync(out, { recursive: true })
const json = { at: new Date().toISOString(), declared: !!declared, run: run ? { at: run.at, passed: run.passed, failed: run.failed } : null, summary, missing_top: missingTop.map(r => r.id), state, sections: Object.fromEntries(Object.entries(sections).map(([k, s]) => [k, s.rows])) }
fs.writeFileSync(path.join(out, 'parity.json'), JSON.stringify(json, null, 2))

const yes = b => (b ? '✓' : '–')
let md = `# iPhone parity with the web\n\n${new Date().toISOString().slice(0, 16)} · source: code${declared ? ' + ios/TrommiApp/features.json' : ' (no ios/TrommiApp/features.json yet)'}${run ? ` · interop run ${run.passed} passed, ${run.failed} failed` : ''}\n\n`
md += '| Section | ✓ | partial | missing | score |\n| --- | --- | --- | --- | --- |\n'
for (const [k, s] of Object.entries(summary)) md += `| ${k} | ${s.full} | ${s.partial} | ${s.missing}${s.stale ? ` (+${s.stale} stale)` : ''} | ${s.score}% |\n`
md += '\n## Features (by daily use)\n\n| # | Feature | Group | iPhone | core | app | tested | note |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n'
for (const r of [...featureRows].sort((a, b) => a.rank - b.rank || a.group.localeCompare(b.group))) md += `| ${r.rank} | ${r.label} | ${r.group} | ${MARK[r.status]}${r.source === 'declared' ? ' (declared)' : ''} | ${yes(r.core)} | ${yes(r.app)} | ${r.tested == null ? '' : r.tested ? '✓' : '✗'} | ${r.note} |\n`
md += '\n## Body fields (codec.mjs FIELDS)\n\n| Kind | Field | Swift core | app | iPhone |\n| --- | --- | --- | --- | --- |\n'
for (const r of fieldRows) md += `| ${r.group} | \`${r.item}\` | ${yes(r.core)} | ${yes(r.app)} | ${MARK[r.status]} |\n`
md += '\n## Hub routes\n\n| Route | README | web | iPhone |\n| --- | --- | --- | --- |\n'
for (const r of routes) md += `| \`${r.item}\`${r.agent_only ? ' (agent)' : ''} | ${yes(r.readme)} | ${yes(r.web)} | ${yes(r.ios)}${r.via ? ` via \`${r.via.split(' ')[1].split('/').pop()}\`` : ''} |\n`
md += '\n## Wire vocabulary\n\n| What | Value | web | iPhone |\n| --- | --- | --- | --- |\n'
for (const r of wireRows) md += `| ${r.group} | \`${r.item}\` | ${yes(r.web)} | ${yes(r.ios)} |\n`
md += '\n## Interop driver commands\n\n| Command | for | JS | Swift |\n| --- | --- | --- | --- |\n'
for (const r of driverRows) md += `| \`${r.item}\` | ${r.who} | ${yes(r.web)} | ${yes(r.ios)} |\n`
fs.writeFileSync(path.join(out, 'parity.md'), md)

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const cell = st => `<td class="s-${st}">${MARK[st] ?? st}</td>`
const yn = b => `<td class="${b ? 's-full' : 's-missing'}">${b ? '✓' : '–'}</td>`
const table = (head, rows) => `<div class="wrap"><table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>iPhone parity</title><style>
:root{--bg:#fbfaf7;--fg:#1d211f;--muted:#69706b;--line:#dcd9d2;--full:#1f7a4d;--partial:#a3640b;--missing:#b3261e;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#141716;--fg:#e8ebe9;--muted:#9aa29d;--line:#323835;--full:#5fcf95;--partial:#e8b04f;--missing:#f2867d;--card:#1b1f1d}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif}main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:1.7rem;margin:0 0 4px}h2{margin:36px 0 10px;font-size:1.2rem}.muted{color:var(--muted)}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin:18px 0}.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}
.tile b{display:block;font-size:1.8rem}.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;background:var(--card)}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{font-size:.8rem;color:var(--muted);font-weight:600}code{font-size:.85em}.s-full{color:var(--full)}.s-partial{color:var(--partial)}.s-missing,.s-stale{color:var(--missing);font-weight:600}
</style></head><body><main><h1>iPhone parity with the web</h1><p class="muted">${esc(json.at.slice(0, 16))} · source: code${declared ? ' + ios/TrommiApp/features.json' : ' (no ios/TrommiApp/features.json yet: inferred from the Swift sources)'}${run ? ` · interop run ${run.passed} passed, ${run.failed} failed` : ''}</p>
<div class="tiles">${Object.entries(summary).map(([k, s]) => `<div class="tile"><span class="muted">${k}</span><b>${s.score}%</b><span class="s-full">${s.full} ✓</span> · <span class="s-partial">${s.partial} partial</span> · <span class="s-missing">${s.missing} missing</span></div>`).join('')}</div>
<h2>Not there yet, by daily use</h2>${table(['#', 'Feature', 'iPhone', 'core', 'app'], missingTop.map(r => `<tr><td>${r.rank}</td><td>${esc(r.label)}</td>${cell(r.status)}${yn(r.core)}${yn(r.app)}</tr>`))}
<h2>Features</h2>${table(['#', 'Feature', 'Group', 'iPhone', 'core', 'app', 'tested', 'note'], [...featureRows].sort((a, b) => a.rank - b.rank).map(r => `<tr><td>${r.rank}</td><td>${esc(r.label)}</td><td>${esc(r.group)}</td>${cell(r.status)}${yn(r.core)}${yn(r.app)}<td>${r.tested == null ? '' : r.tested ? '✓' : '✗'}</td><td>${esc(r.note)}</td></tr>`))}
<h2>Body fields</h2>${table(['Kind', 'Field', 'Swift core', 'app', 'iPhone'], fieldRows.map(r => `<tr><td>${r.group}</td><td><code>${r.item}</code></td>${yn(r.core)}${yn(r.app)}${cell(r.status)}</tr>`))}
<h2>Hub routes</h2>${table(['Route', 'README', 'web', 'iPhone'], routes.map(r => `<tr><td><code>${esc(r.item)}</code>${r.agent_only ? ' <span class="muted">agent</span>' : ''}</td>${yn(r.readme)}${yn(r.web)}${yn(r.ios)}</tr>`))}
<h2>Wire vocabulary</h2>${table(['What', 'Value', 'web', 'iPhone'], wireRows.map(r => `<tr><td>${r.group}</td><td><code>${esc(r.item)}</code></td>${yn(r.web)}${yn(r.ios)}</tr>`))}
<h2>Interop driver commands</h2>${table(['Command', 'for', 'JS', 'Swift'], driverRows.map(r => `<tr><td><code>${r.item}</code></td><td>${r.who}</td>${yn(r.web)}${yn(r.ios)}</tr>`))}
</main></body></html>`
fs.writeFileSync(path.join(out, 'parity.html'), html)

console.log(Object.entries(summary).map(([k, s]) => `${k.padEnd(9)} ${String(s.score).padStart(3)}%  ${s.full} ✓  ${s.partial} partial  ${s.missing} missing${s.stale ? `  ${s.stale} STALE` : ''}`).join('\n'))
console.log(`top missing: ${missingTop.slice(0, 10).map(r => `${r.id} (${r.status})`).join(', ')}`)
console.log('dev/interop/out/parity.{md,html,json}')

// ---- CI: compare with the baseline ---------------------------------------------------------------------------------
const basePath = path.join(here, 'parity-baseline.json')
if (process.argv.includes('--update-baseline')) {
  fs.writeFileSync(basePath, JSON.stringify({ note: 'node dev/interop/parity.mjs --update-baseline; --check fails when a row is worse than here', state }, null, 2) + '\n')
  console.log('baseline written')
}
if (process.argv.includes('--check')) {
  const base = JSON.parse(fs.readFileSync(basePath, 'utf8')).state
  const worse = Object.entries(base).filter(([k, v]) => (state[k] === 'stale') || (k in state ? RANK[state[k]] < RANK[v] : false))
  const stale = Object.entries(state).filter(([, v]) => v === 'stale').map(([k]) => k)
  for (const [k, v] of worse) console.error(`regression: ${k} ${v} -> ${state[k]}`)
  for (const k of stale) if (!worse.some(([w]) => w === k)) console.error(`stale web evidence: ${k} (fix its row in parity.mjs)`)
  process.exit(worse.length || stale.length ? 1 : 0)
}
