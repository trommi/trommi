#!/usr/bin/env node
// Import a state.json as server.mjs writes it today (and wrote it in earlier versions) into a store database.
//
//   node server/store/migrate.mjs <state.json | data dir> <target.db> [--dry-run] [--owner <id>] [--data <dir>]
//
// The source is only read. Running it twice imports nothing twice: every imported record carries a client id
// derived from its old id. --dry-run imports into a database in memory and prints the counts; the target is
// not opened. --owner names the session that records without an agent belong to (state files from before
// several agents could share a board); default: the hub named in the file, else its first agent, else "agent".
// --data is the folder with files/, scribbles/ and assets/, to record file sizes and canvases; default: the
// folder the state file is in.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Store, URGENCIES, STATUS_STATES, QUEUE_MAX } from './store.mjs'

const SESSION_ENDED = 'Session ended before the approval was answered'
const ASSET_ID = /^[A-Za-z0-9_-]{22}$/
const slug = name => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent'
const PROFILE = ['name', 'label', 'icon', 'group', 'model', 'client', 'task', 'cwd', 'host', 'platform', 'starred']

// The file as JSON, or why not. A missing file is an empty board; a broken one is an error, and unlike
// load() in server.mjs nothing is renamed: this tool never writes next to its source.
export function readState(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return { raw: {}, missing: true }
    return { error: `cannot read ${file}: ${err.message}` }
  }
  try {
    const raw = JSON.parse(text)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `${file} is not a state file: the top level is not an object` }
    return { raw }
  } catch (err) {
    return { error: `${file} is not valid JSON (${err.message})` }
  }
}

// Every shape load() in server.mjs tolerates, brought to today's: records that are not objects are dropped,
// missing agents become the owner, missing numbers and urgencies are filled in, an approval that was open when
// the hub stopped is done.
export function normalise(raw, ownerGiven) {
  const skipped = { messages: 0, cards: 0, tasks: 0, agents: 0, pending: 0, assets: 0 }
  const list = key => {
    const all = Array.isArray(raw[key]) ? raw[key] : []
    const good = all.filter(x => x && typeof x === 'object' && !Array.isArray(x))
    skipped[key === 'tasks' ? 'tasks' : key] += all.length - good.length
    return good
  }
  const keep = (key, items, test) => items.filter(x => test(x) || (skipped[key]++, false))
  const agents = keep('agents', list('agents'), a => a.id).map(a => ({ ...a, id: String(a.id) }))
  const owner = String(ownerGiven ?? raw.hub ?? agents[0]?.id ?? 'agent')
  const messages = keep('messages', list('messages'), m => ['user', 'agent', 'event'].includes(m.from))
    .map(m => ({ agent: owner, ...(m.from === 'agent' ? { attachments: [] } : {}), ...m }))
  const defaultUrgency = kind => (kind === 'permission' ? 'critical' : 'normal')
  const cards = keep('cards', list('cards'), c => c.id).map(c => ({
    agent: owner, urgency_reason: '', ...c, id: String(c.id), kind: c.kind === 'permission' ? 'permission' : 'decision',
    status: ['open', 'decided', 'done'].includes(c.status) ? c.status : 'open',
    options: Array.isArray(c.options) ? c.options : [], attachments: Array.isArray(c.attachments) ? c.attachments : [],
    urgency: c.kind === 'permission' || !URGENCIES.includes(c.urgency) ? defaultUrgency(c.kind) : c.urgency,
  }))
  for (const c of cards) {
    if (c.kind === 'permission' && c.status === 'open') Object.assign(c, { status: 'done', summary: SESSION_ENDED })
  }
  const numbered = n => Number.isInteger(n) && n > 0
  let next = Math.max(1, numbered(raw.next_number) ? raw.next_number : 1, ...cards.filter(c => numbered(c.number)).map(c => c.number + 1))
  for (const c of cards) if (!numbered(c.number)) c.number = next++
  const tasks = keep('tasks', list('tasks'), t => t.id && STATUS_STATES.includes(t.state)).map(t => ({ agent: owner, ...t }))
  const pending = {}
  for (const [id, queue] of Object.entries(raw.pending && typeof raw.pending === 'object' && !Array.isArray(raw.pending) ? raw.pending : {})) {
    if (!Array.isArray(queue)) continue
    const good = queue.filter(e => e && typeof e.method === 'string')
    skipped.pending += queue.length - good.length
    if (good.length) pending[id] = good.slice(-QUEUE_MAX)
  }
  const assets = keep('assets', list('assets'), a => ASSET_ID.test(a.id))
  return { owner, hub: raw.hub ?? null, agents, messages, cards, tasks, pending, assets, next_number: next, skipped }
}

// The stack as server.mjs orders it, to check the import against.
export function queueOf(cards, agents = []) {
  const rank = c => (c.kind === 'permission' ? URGENCIES.length : URGENCIES.indexOf(c.urgency))
  const shelved = new Set(agents.filter(a => a.archived).map(a => a.id))
  return cards.filter(c => c.status === 'open' && !shelved.has(c.agent))
    .sort((a, b) => rank(b) - rank(a) || a.created - b.created || a.number - b.number).map(c => c.id)
}

// Write a normalised state into the store, in one transaction. Returns what was new and what was already there.
export function importState(store, state, { dataDir = null, now = Date.now() } = {}) {
  const made = { sessions: 0, messages: 0, cards: 0, card_events: 0, notes: 0, status_lines: 0, deliveries: 0, blobs: 0, canvases: 0, admin_log: 0 }
  const present = { sessions: 0, messages: 0, cards: 0, card_events: 0, notes: 0, status_lines: 0, deliveries: 0, blobs: 0, canvases: 0 }
  const missing = []
  const tally = (key, result) => { if (result.duplicate) present[key]++; else made[key]++; return result }
  const num = (value, fallback = 0) => (Number.isFinite(Number(value)) && value != null ? Number(value) : fallback)
  const sizeOf = rel => {
    if (!dataDir) return undefined
    try { return fs.lstatSync(path.join(dataDir, rel)).size } catch { return null }
  }

  store.tx(() => {
    // -- sessions: the known ones, and a placeholder for every id something else still names
    const known = new Set()
    for (const a of state.agents) {
      const profile = Object.fromEntries(PROFILE.filter(k => a[k] != null).map(k => [k, a[k]]))
      const out = store.upsertSession({
        id: a.id, instance: a.instance ?? null, profile, archived: a.archived === true, online: false,
        joined: num(a.joined, now), connected: a.connected ?? null, seen: a.seen ?? null, at: num(a.joined, now), sender: 'import',
      })
      known.add(a.id)
      if (out.created) made.sessions++; else present.sessions++
    }
    const named = [...state.messages.map(m => [m.agent, m.ts]), ...state.cards.map(c => [c.agent, c.created]), ...state.tasks.map(t => [t.agent, t.updated]),
      ...Object.keys(state.pending).map(id => [id, now]), ...state.assets.map(a => [a.agent, a.created])]
    for (const [id, ts] of named) {
      if (id == null || known.has(String(id))) continue
      known.add(String(id))
      if (store.session(String(id))) { present.sessions++; continue }
      store.upsertSession({ id: String(id), profile: { name: String(id) }, online: false, joined: num(ts, now), at: num(ts, now), sender: 'import' })
      made.sessions++
    }

    // -- files: recorded by reference; nothing is copied or opened
    const blob = (id, kind, session, at, meta, { size: given, ...extra } = {}) => {
      const onDisk = sizeOf(extra.path ?? id)
      if (onDisk === null) missing.push(extra.path ?? id)
      const size = given ?? onDisk
      const out = store.registerBlob({ id, kind, path: id, size: size ?? null, session, meta, at, ...extra })
      if (out.duplicate) present.blobs++; else made.blobs++
      return id
    }
    const attached = (list, session, at) => (Array.isArray(list) ? list : []).flatMap(a => {
      if (!a || typeof a !== 'object') return []
      const meta = { name: a.name ?? '', kind: a.kind ?? (a.image ? 'image' : 'file') }
      if (a.kind === 'scribble' && /^[0-9a-f]+$/.test(String(a.id ?? ''))) {
        const ids = [blob(`scribbles/${a.id}.png`, 'scribble', session, at, meta)]
        if (sizeOf(`scribbles/${a.id}.json`) !== null) ids.push(blob(`scribbles/${a.id}.json`, 'scribble', session, at, { name: `${a.id}.json`, kind: 'file' }))
        return ids
      }
      // The name only, as server.mjs does: a state file is never a way to a path outside the folder.
      if (typeof a.url === 'string' && a.url.startsWith('/files/')) return [blob(`files/${path.basename(a.url)}`, 'attachment', session, at, meta, a.size != null ? { size: a.size } : {})]
      return []
    })
    const assets = new Set()
    for (const a of state.assets) {
      assets.add(a.id)
      blob(a.id, 'asset', known.has(String(a.agent)) ? String(a.agent) : null, num(a.created, now), { type: a.type ?? null, title: a.title ?? '', silent: a.silent === true },
        { path: `assets/${a.id}`, size: a.size ?? undefined, retention: a.keep === true ? 'keep' : 'age', wrappedKey: null })
    }

    // -- the timeline: cards and messages in the order they happened
    const ops = []
    const at = (ts, run) => ops.push({ ts: num(ts), i: ops.length, run })
    const cardsById = new Map(state.cards.map(c => [c.id, c]))
    const markers = new Map()
    for (const m of state.messages) {
      if (m.from === 'event' && m.card_id != null && cardsById.has(String(m.card_id))) markers.set(String(m.card_id), [...(markers.get(String(m.card_id)) ?? []), m])
    }
    // Markers the card's own events stand for: the question, the answer that holds, the end.
    const covered = new Set()
    for (const c of state.cards) {
      const own = markers.get(c.id) ?? []
      const answered = c.choice != null
      const asked = own.find(m => m.kind === 'asked')
      const decided = answered && c.kind === 'decision' ? own.findLast(m => m.kind === 'decided') : null
      const ended = c.status === 'done' ? own.findLast(m => m.kind === 'done') : null
      for (const m of [asked, decided, ended]) if (m) covered.add(m)
      const created = num(c.created)
      const session = String(c.agent)
      at(created, () => {
        const out = tally('cards', store.askCard({
          id: c.id, session, kind: c.kind, urgency: c.urgency, number: c.number, requestId: c.request_id, push: false,
          body: { kind: c.kind, title: c.title ?? '', body: c.body ?? '', options: c.options, recommended: c.recommended ?? null, urgency_reason: c.urgency_reason ?? '', attachments: c.attachments },
          blobs: attached(c.attachments, session, created), sender: session, clientId: `import:c:${c.id}:ask`, at: created,
        }))
        tally('card_events', out)
      })
      const when = Math.max(created, num(c.decided, created))
      if (answered) {
        at(when, () => tally('card_events', store.answerCard({ id: c.id, body: { choice: c.choice, note: c.note ?? '' }, sender: 'human', clientId: `import:c:${c.id}:answer`, at: when })))
      }
      if (c.status !== 'done') continue
      const end = Math.max(when, num(ended?.ts, when))
      const key = `import:c:${c.id}:end`
      if (c.kind === 'permission') {
        // An answered approval is done by its answer; an unanswered one ended with its session.
        if (!answered) at(end, () => tally('card_events', store.expireCard({ id: c.id, summary: c.summary || SESSION_ENDED, clientId: key, at: end })))
      } else if (answered || !/^(Withdrawn|Zurückgezogen)/.test(ended?.text ?? 'Withdrawn')) {
        at(end, () => tally('card_events', store.closeCard({ id: c.id, summary: c.summary ?? '', sender: session, clientId: key, at: end })))
      } else {
        at(end, () => tally('card_events', store.withdrawCard({ id: c.id, reason: c.summary ?? '', sender: session, clientId: key, at: end })))
      }
    }
    const ids = new Set()
    state.messages.forEach((m, index) => {
      if (covered.has(m)) return
      let id = String(m.id ?? `x${crypto.createHash('sha256').update(JSON.stringify(m)).digest('hex').slice(0, 12)}`)
      while (ids.has(id)) id = `${id}~${index}`
      ids.add(id)
      const session = String(m.agent)
      const { id: _id, agent: _agent, ts: _ts, ...rest } = m
      if (m.from === 'event') {
        const card = m.card_id != null ? cardsById.get(String(m.card_id)) : null
        // History the card itself no longer shows: earlier answers, reopenings, changes of urgency.
        if (card) {
          at(Math.max(num(m.ts), num(card.created)), () => tally('notes', store.noteCard({ id: card.id, body: { kind: m.kind ?? '', text: m.text ?? '' }, sender: 'import', clientId: `import:n:${id}`, at: Math.max(num(m.ts), num(card.created)) })))
        } else {
          at(m.ts, () => tally('notes', store.append({ type: 'note', session, sender: 'import', clientId: `import:n:${id}`, body: rest, at: num(m.ts) })))
        }
        return
      }
      at(m.ts, () => tally('messages', store.postMessage({
        session, from: m.from, id, body: rest, sender: m.from === 'agent' ? session : 'human', clientId: `import:m:${id}`, at: num(m.ts),
        blobs: [...attached(m.attachments, session, num(m.ts)), ...(m.asset?.id && !m.asset.gone && assets.has(m.asset.id) ? [m.asset.id] : [])],
      })))
    })
    ops.sort((a, b) => a.ts - b.ts || a.i - b.i)
    for (const op of ops) op.run()

    // -- status lines, as they stand
    for (const t of state.tasks) {
      const session = String(t.agent)
      const card = t.state === 'decision' && t.card_id != null ? store.card(String(t.card_id)) : null
      tally('status_lines', store.setStatus({
        session, id: String(t.id), state: t.state, label: String(t.label || t.id), detail: String(t.detail ?? ''),
        cardId: card?.session === session ? card.id : null, clientId: `import:t:${session}:${t.id}`, at: num(t.updated, now),
      }))
    }

    // -- notifications that wait for sessions that are away
    for (const [id, queue] of Object.entries(state.pending)) {
      queue.forEach((e, i) => {
        const dedupe = `import:${id}:${i}:${crypto.createHash('sha256').update(JSON.stringify(e)).digest('hex').slice(0, 16)}`
        // Remembered beside the queue: an entry that was imported, handed over and acknowledged must not come back with a second run.
        if (store.meta(dedupe)) return void present.deliveries++
        tally('deliveries', store.enqueue(id, e.method, e.params ?? null, { at: num(e.ts, now), dedupe }))
        store.setMeta(dedupe, now)
      })
    }

    // -- canvases and the admin log live in files beside the state
    if (dataDir) {
      for (const id of known) {
        const [doc, image] = ['json', 'png'].map(ext => `scribbles/canvas-${slug(id)}.${ext}`)
        if (sizeOf(doc) === null || store.canvas(id)) { if (store.canvas(id)) present.canvases++; continue }
        const mtime = Math.round(fs.statSync(path.join(dataDir, doc)).mtimeMs)
        blob(doc, 'canvas', id, mtime, { name: path.basename(doc) })
        if (sizeOf(image) !== null) blob(image, 'canvas', id, mtime, { name: path.basename(image) })
        store.saveCanvas({ session: id, doc, image: sizeOf(image) !== null ? image : undefined, by: 'import', clientId: `import:canvas:${id}`, at: mtime })
        made.canvases++
      }
      let lines = []
      try { lines = fs.readFileSync(path.join(dataDir, 'admin-log.jsonl'), 'utf8').split('\n') } catch {}
      if (!store.meta('import.admin_log')) {
        for (const line of lines.slice(-301)) {
          let e
          try { e = JSON.parse(line) } catch { continue }
          if (!e || typeof e !== 'object' || !e.action) continue
          store.q('INSERT INTO admin_log (ts, action, detail, origin, count) VALUES (?, ?, ?, ?, ?)').run(num(e.ts, now), String(e.action), String(e.detail ?? ''), String(e.from ?? ''), num(e.count, 1))
          made.admin_log++
        }
        if (made.admin_log) store.setMeta('import.admin_log', now)
      }
    }

    store.setMeta('next_number', Math.max(store.meta('next_number'), state.next_number))
    if (state.hub != null) store.setMeta('hub', String(state.hub))
    store.setMeta('import.last', now)
  })
  return { imported: made, already_present: present, skipped: state.skipped, missing_files: missing }
}

// Compare the store with the state it was imported from. Returns what differs; empty means it matches.
export function verify(store, state) {
  const problems = []
  const same = (what, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`${what}: store has ${JSON.stringify(got)}, state has ${JSON.stringify(want)}`) }
  for (const c of state.cards) {
    const got = store.card(c.id)
    if (!got) { problems.push(`card ${c.id} is missing`); continue }
    same(`card ${c.id}`, [got.session, got.number, got.kind, got.status, got.urgency, got.answer?.choice ?? null, got.ask?.title],
      [String(c.agent), c.number, c.kind, c.status, c.urgency, c.choice ?? null, c.title ?? ''])
  }
  const snap = store.snapshot({ cards: 5000 })
  if (!snap.truncated) same('stack', snap.queue, queueOf(state.cards, state.agents))
  const count = status => state.cards.filter(c => c.status === status).length
  same('cards by status', snap.counts.cards, { open: count('open'), decided: count('decided'), done: count('done') })
  const perSession = {}
  for (const m of state.messages) if (m.from !== 'event') perSession[m.agent] = (perSession[m.agent] ?? 0) + 1
  for (const [id, n] of Object.entries(perSession)) same(`messages of ${id}`, store.session(id)?.messages, n)
  for (const [id, queue] of Object.entries(state.pending)) same(`queue of ${id}`, store.queued(id), queue.length)
  same('status lines', store.q('SELECT COUNT(*) AS n FROM status_lines').get().n, new Set(state.tasks.map(t => `${t.agent}\n${t.id}`)).size)
  same('next card number', store.meta('next_number') >= state.next_number, true)
  return problems
}

function main(argv) {
  const flags = new Set()
  const values = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--owner' || argv[i] === '--data') values[argv[i]] = argv[++i]
    else if (argv[i].startsWith('--')) flags.add(argv[i])
    else positional.push(argv[i])
  }
  const value = name => values[name]
  const [source, target] = positional
  const dry = flags.has('--dry-run')
  if (!source || (!target && !dry)) {
    console.error('usage: migrate.mjs <state.json | data dir> <target.db> [--dry-run] [--owner <id>] [--data <dir>]')
    return 1
  }
  const file = fs.existsSync(source) && fs.statSync(source).isDirectory() ? path.join(source, 'state.json') : source
  const dataDir = value('--data') ?? path.dirname(file)
  const read = readState(file)
  if (read.error) {
    console.error(`${read.error}\nnothing imported`)
    return 2
  }
  const state = normalise(read.raw, value('--owner'))
  const store = new Store(dry ? ':memory:' : target)
  try {
    const report = importState(store, state, { dataDir: fs.existsSync(dataDir) ? dataDir : null })
    const problems = verify(store, state)
    const stats = store.stats()
    console.log(JSON.stringify({
      mode: dry ? 'dry run: imported into memory, nothing written' : `imported into ${target}`,
      source: file, ...(read.missing ? { note: 'no state file there: an empty board' } : {}), owner: state.owner,
      ...report, store: { schema: stats.version, events: stats.cursor, ...stats.rows }, verified: problems.length ? problems : 'matches the state file',
    }, null, 2))
    return problems.length ? 3 : 0
  } finally {
    store.close()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2))
