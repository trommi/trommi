// Turns a state export of today's board (node server/board-store.mjs export <data> out.json, with the demo state and
// the test cards: dev/demo-state.mjs + dev/fixtures.mjs in trommi-hub) into the mock room's fixture, in the shape of
// the client core's model (core/README.md in trommi-hub). Pictures are copied to public/demo/files/.
//   node dev/make-fixture.mjs <state-export.json> <board-data-dir>
// Adds what the export lacks so every part of the board shows: a crowned main session with two subs and status
// lines, an online agent, a pending permission request, a memo.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const [exportFile, dataDir] = process.argv.slice(2)
if (!exportFile || !dataDir) { console.error('usage: node dev/make-fixture.mjs <state-export.json> <board-data-dir>'); process.exit(2) }
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'public', 'demo')
fs.mkdirSync(path.join(out, 'files'), { recursive: true })
const s = JSON.parse(fs.readFileSync(exportFile, 'utf8'))
const hex = (text, n) => crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, n)
const dev = name => hex(`device:${name}`, 64)
const oid = id => hex(`object:${id}`, 32)

// ---- sessions ----
const now = Date.now(), shift = now - Math.max(...s.messages.map(m => m.ts), ...s.cards.map(c => c.created))   // the export's times, moved up to now
const T = ts => (ts ? ts + shift : ts)
const extra = [
  { id: 'trommi', name: 'trommi', icon: 'draw:bell', task: 'Trommi: Board, Hub und App', model: 'claude-opus-5-5', online: true, main: true, desk: 'main' },
  { id: 'trommi-ui', name: 'UI', icon: 'draw:brush', task: 'Desk und Karten', model: 'claude-opus-5-5', online: true, parent: 'trommi', desk: 'main' },
  { id: 'trommi-docs', name: 'Docs', icon: 'draw:book', task: 'README und Hilfe', model: 'claude-sonnet-5', online: false, parent: 'trommi', desk: 'main' },
  { id: 'crypto', name: 'crypto', icon: 'draw:key', task: 'Ende-zu-Ende-Verschlüsselung', model: 'claude-opus-5-5', online: true, desk: 'main' },
]
const agents = [...extra, ...s.agents.map(a => ({ id: a.id, name: a.name, icon: a.icon, task: a.task, model: a.model, online: false, desk: a.desk }))]
const sessions = agents.map(a => ({
  agent_device_id: dev(a.id), agent_session_id: a.id, device_name: a.name, is_active: true, is_online: a.online,
  profile: { model: a.model ?? '', task: a.task ?? '', icon: a.icon ?? '', agent_name: a.name, parent_session: a.parent ? a.parent : null, is_main: Boolean(a.main) },
  status_lines: s.tasks.filter(t => t.agent === a.id).map(t => ({ id: t.id, label: t.label, state: t.state, detail: t.detail, object_id: t.card_id ? oid(t.card_id) : null, updated_at: T(t.updated) })),
  settings: { name: '', desk: a.desk ?? 'main', archived: false, group: null, icon: null },
}))
sessions.find(x => x.agent_session_id === 'trommi-ui').status_lines.push({ id: 'desk', label: 'Desk-Zeilen', state: 'working', detail: 'Fenster für lange Listen', object_id: null, updated_at: now - 60000 })
sessions.find(x => x.agent_session_id === 'crypto').status_lines.push({ id: 'keys', label: 'Schlüssel', state: 'done', detail: 'Koppeln mit Prüfcode geht', object_id: null, updated_at: now - 300000 })
const byOld = new Map(agents.map(a => [a.id, dev(a.id)]))

// ---- envelopes in order: card versions, answers, messages ----
let n = 0
const events = []
const att = a => {
  if (!a) return null
  const name = path.basename(String(a.url ?? a.name ?? ''))
  const src = path.join(dataDir, 'files', name)
  if (a.url?.startsWith('/files/') && fs.existsSync(src)) fs.copyFileSync(src, path.join(out, 'files', name))
  const type = a.type ?? (a.image ? (/\.png$/i.test(name) ? 'image/png' : /\.jpe?g$/i.test(name) ? 'image/jpeg' : /\.svg$/i.test(name) ? 'image/svg+xml' : 'image/png') : /\.html?$/i.test(name) ? 'text/html' : /\.json$/i.test(name) ? 'application/json' : /\.txt|\.log$/i.test(name) ? 'text/plain' : 'application/octet-stream')
  return { attachment_id: hex(`att:${name}`, 32), file_key: '', sha256: '', file_name: a.name ?? name, media_type: type, total_size: a.size ?? 0, width: a.width, height: a.height, caption: a.caption ?? a.title, page: a.page?.url ?? a.page, marks: a.marks, url: `/demo/files/${name}` }
}
const content = c => ({
  card_type: c.kind === 'info' ? 'info' : 'decision', title: c.title, body: c.body ?? '', options: c.options ?? [], sections: c.sections ?? null, html: c.html ?? null,
  allows_multiple: Boolean(c.multiple), recommended: c.recommended ?? null, urgency_reason: c.urgency_reason ?? '', attachments: (c.attachments ?? []).map(att),
  change_note: c.revision_note ?? '', close_summary: null, withdraw_reason: null, merged_into_object_id: null, merged_from_object_ids: null,
})
for (const c of s.cards.filter(c => c.kind !== 'permission')) {
  const vs = [...(c.versions ?? []).map(v => ({ ...c, ...v, version: v.n, at: v.at })), { ...c, version: c.version ?? 1, at: c.revised ?? c.created }]
  vs.forEach((v, i) => events.push({ ts: T(v.at) + i, type: 'version', card: c, v, i, last: i === vs.length - 1 }))
  if (c.status !== 'open' && (c.choice != null || c.trusted || c.read || c.status === 'shredded')) events.push({ ts: T(c.decided ?? c.shredded ?? c.created) + 5, type: 'answer', card: c })
}
for (const m of s.messages.filter(m => m.from === 'user' || m.from === 'agent')) events.push({ ts: T(m.ts), type: 'message', m })
events.sort((a, b) => a.ts - b.ts)

const cards = new Map(), timelines = {}, published = []
// Published assets (the old board's /a/<id>): a published object and the session message that announces it.
const ASSET_SOURCE = { html: ['demo/fixtures/artifact.html', 'text/html'], image: ['demo/design-g2.png', 'image/png'] }
const assetRef = a => {
  const [rel, type] = ASSET_SOURCE[a.type] ?? ASSET_SOURCE.html
  const src = path.join(process.env.TROMMI_HUB ?? path.join(process.env.HOME, 'git/trommi'), rel), name = `asset-${a.id}${path.extname(rel)}`
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(out, 'files', name))
  return { attachment_id: hex(`att:${name}`, 32), file_key: '', sha256: '', file_name: path.basename(rel), media_type: type, total_size: a.size ?? 0, url: `/demo/files/${name}` }
}
const tl = key => (timelines[key] ??= [])
for (const e of events) {
  const envelope_number = ++n, envelope_hash = hex(`env:${n}`, 64)
  if (e.type === 'version') {
    const c = e.card, id = oid(c.id)
    let card = cards.get(id)
    const ver = { object_version: e.v.version, version_hash: envelope_hash, previous_version_hash: card?.version_hash ?? null, envelope_number, sent_at: e.ts, object_state: 'open', urgency: e.v.urgency ?? c.urgency, content: content(e.v) }
    if (!card) {
      card = { object_id: id, agent_device_id: byOld.get(c.agent), first_envelope_number: envelope_number, created_at: e.ts, versions: [], answer: null, answers: [], closed_how: null, in_revision: null, timeline_key: `chat:card/${id}`, content_state: 'ok', old_number: c.number }
      cards.set(id, card)
    }
    card.versions.push(ver)
    Object.assign(card, ver.content, { object_state: 'open', urgency: ver.urgency, object_version: ver.object_version, version_hash: envelope_hash, envelope_number, updated_at: e.ts })
    if (e.last && c.status !== 'open') {
      if (c.status === 'done' && c.choice == null && !c.read) { card.object_state = 'closed'; card.closed_how = c.summary?.startsWith('Withdrawn') ? 'withdrawn' : 'closed'; card.close_summary = c.summary || null }
    }
  } else if (e.type === 'answer') {
    const c = e.card, card = cards.get(oid(c.id))
    const action = c.status === 'shredded' ? 'shred' : c.kind === 'info' ? 'read' : 'answer'
    card.answer = { answer_action: action, choices: c.choices ?? (c.choice ? [c.choice] : []), note: c.note ?? '', option_notes: c.option_notes ?? {}, attachments: (c.note_attachments ?? []).map(att), marks: c.marks ?? [], trusted: Boolean(c.trusted), bound_version_hash: card.version_hash, bound_object_version: card.object_version, envelope_number, envelope_hash, by_device_id: dev('laptop'), answered_at: e.ts, taken_back_at: null }
    card.answers.push(card.answer)
    card.object_state = c.status === 'done' && action === 'answer' ? 'closed' : action === 'answer' ? 'answered' : 'closed'
    card.closed_how = action === 'shred' ? 'shredded' : action === 'read' ? 'read' : 'answered'
    if (c.status === 'done' && c.summary) card.close_summary = c.summary
  } else {
    const m = e.m, agentDev = byOld.get(m.agent)
    const key = m.card_id ? `chat:card/${oid(m.card_id)}` : `chat:session/${agentDev}`
    let content = { text: m.text ?? '', details: m.details, html: m.html, attachments: (m.attachments ?? []).map(att), hand_back: m.handback || undefined, explain: m.explain || undefined, marks: m.marks }
    if (m.asset) {
      const ref = assetRef(m.asset), object_id = oid(`asset:${m.asset.id}`)
      published.push({ object_id, agent_device_id: agentDev, attachments: [ref], title: m.asset.title, note: m.asset.note ?? '', released_until: null, object_version: 1, version_hash: hex(`pub:${m.asset.id}`, 64), envelope_number, sent_at: e.ts, object_state: 'open' })
      content = { text: `**${m.asset.title}**\n\n${m.asset.note ?? ''}`, attachments: [ref], published_object_id: object_id }
    }
    tl(key).push({ envelope_number, local_id: null, pending: false, envelope_hash, sender_device_id: m.from === 'user' ? dev('laptop') : agentDev, recipient_device_id: m.from === 'user' ? agentDev : null, sent_at: e.ts, item_state: 'loaded', content_type: 'message', content })
    if (m.handback || m.explain) { const card = cards.get(oid(m.card_id)); if (card && card.object_state === 'open') card.in_revision = { by: m.handback ? 'hand_back' : 'explain', envelope_number } }
  }
}
// The permission request (always on top), the snooze, the draft, the crown.
const perm = { object_id: oid('perm-1'), agent_device_id: dev('trommi-ui'), tool_name: 'Bash', description: 'Run the app tests', input_preview: 'node dev/ui-test.mjs --all', expires_at: now + 3600e3, version_hash: hex('perm', 64), envelope_number: ++n, sent_at: now - 120000, permission_state: 'pending', verdict: null }
const human = {
  drafts: {}, snoozes: {}, ducks: {}, crown: { agent_device_id: dev('trommi') },
  desks: { main: { name: 'Desk', created_at: now - 864e5 }, test: { name: 'Test', created_at: now - 3600e3 } },
  session_settings: Object.fromEntries(sessions.map(x => [x.agent_device_id, x.settings])), read_up_to: {},
}
for (const x of sessions) if (x.settings.desk === '0defcecc') x.settings.desk = 'test'
for (const c of s.cards) if (c.snoozed_until) human.snoozes[oid(c.id)] = { until: now + 6 * 3600e3, at: now - 600000 }
const memos = [{ object_id: oid('memo-1'), by_device_id: dev('laptop'), text: 'Morgen: Pairing auf dem Handy testen', x: 0, y: 0, color: null, desk_id: 'main', place: 'stack', object_version: 1, version_hash: hex('memo', 64), envelope_number: ++n, object_state: 'open' }]
const members = [
  { device_id: dev('laptop'), device_role: 'human', device_name: 'Laptop', is_active: true, added_entry_number: 0, removed_entry_number: null, is_me: true, is_online: true },
  { device_id: dev('phone'), device_role: 'human', device_name: 'Phone', is_active: true, added_entry_number: 1, removed_entry_number: null, is_me: false, is_online: false },
  ...sessions.map((x, i) => ({ device_id: x.agent_device_id, device_role: 'agent', device_name: x.device_name, is_active: true, added_entry_number: 2 + i, removed_entry_number: null, is_me: false, is_online: x.is_online, agent_session_id: x.agent_session_id })),
]
const fixture = {
  made_at: now, room: { room_id: hex('room', 64), hub_url: 'mock:', my_device_id: dev('laptop'), my_role: 'human', key_epoch: 1, last_entry_number: members.length - 1, last_envelope_number: n, connection: 'live' },
  members, sessions, cards: [...cards.values()], permissions: [perm], memos, published, timelines, human,
}
fs.writeFileSync(path.join(out, 'fixture.json'), JSON.stringify(fixture))
console.log(`fixture: ${cards.size} cards, ${sessions.length} sessions, ${Object.values(timelines).flat().length} timeline items, ${fs.readdirSync(path.join(out, 'files')).length} files`)
