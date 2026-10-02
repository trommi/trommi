#!/usr/bin/env node
// Trommi: a Claude Code channel that serves a local chat and a stack of decision cards.
// Claude Code spawns this file over stdio, once per session. The first process
// to get the port is the hub: it holds the state and serves the web UI. Every
// later process is a spoke that forwards its agent's tool calls to the hub and
// relays the hub's messages back. When the hub's session ends, a spoke takes over.
// stdout belongs to the MCP transport, so all logging goes to stderr.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { cleanFences, htmlBeside, strippedHint, fences, HTML_MAX } from './richhtml.mjs'
import { kindOf, MIME, MAX_ASSET, ASSET_TYPES, ASSET_LABEL, ASSET_MAGIC, ASSET_ID, ASSET_KEY, ASSET_BLOB_MAX, prepareAsset, assetUpload, assetLink } from './asset-envelope.mjs'
import { padRoutes, padSupport } from './pad.mjs'
import { openBoard, MOVED_NAME } from './board-store.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.BOARD_PORT || 8790)
const HOST = process.env.BOARD_HOST || '0.0.0.0'
// The server lives in server/; data and the static web client sit beside it in the repository.
const DATA = process.env.BOARD_DATA || path.join(ROOT, '..', 'data')
const PUBLIC = path.join(ROOT, '..', 'client', 'web')
const FILES = path.join(DATA, 'files')
const SCRIBBLES = path.join(DATA, 'scribbles')
const ASSETS = path.join(DATA, 'assets')
const STATE_FILE = path.join(DATA, 'state.json')
// Rendered videos are the big case; the file is copied once and streamed with Range requests.
const MAX_ATTACHMENT = Number(process.env.BOARD_MAX_ATTACHMENT_MB || 1024) * 1024 * 1024
// A hub that is nobody's session: it holds the state and serves the pages, but is
// no agent itself. For a hub that runs as a service, with nothing on stdin.
const HUB_ONLY = /^(1|true|yes)$/i.test(process.env.BOARD_HUB_ONLY ?? '')
// Answered cards and their attachments are deleted after this many days.
const RETENTION_DAYS = Number(process.env.BOARD_RETENTION_DAYS || 30)
// A spoke never waits longer than this for the hub. Generous, because a tool
// call may copy a large video or wait for the speech service.
const HUB_TIMEOUT = Number(process.env.BOARD_HUB_TIMEOUT_MS || 120000)
// How long a tool call waits for a link that is being re-made before it fails.
const LINK_WAIT = Math.min(HUB_TIMEOUT, 5000)
// The hub writes to every spoke this often, so a spoke can tell a stuck hub from a quiet one.
const PING = Number(process.env.BOARD_PING_MS || 15000)
// Notifications kept for an agent whose session is away; older ones give way to newer ones.
const PENDING_MAX = 100
const VERSION = (() => {
  try { return String(JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'package.json'), 'utf8')).version ?? '') } catch { return '' }
})()
// Extra addresses the board is reached under, e.g. the HTTPS name from `tailscale serve`; comma-separated.
const PUBLIC_URLS = (process.env.BOARD_PUBLIC_URL || '').split(',').map(u => u.trim().replace(/\/+$/, '')).filter(Boolean)

// stderr is the only log there is; the admin page shows the end of it.
const LOG_LINES = 200
const logLines = []
const writeStderr = process.stderr.write.bind(process.stderr)
process.stderr.write = (chunk, ...rest) => {
  const said = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
  for (const line of said.split('\n')) if (line) logLines.push({ ts: Date.now(), line: line.slice(0, 2000) })
  logLines.splice(0, Math.max(0, logLines.length - LOG_LINES))
  return writeStderr(chunk, ...rest)
}
// Speech runs on Tinfoil's OpenAI-compatible API. Without a key the board
// works as before and simply offers no microphone or read-aloud.
const SPEECH = path.join(DATA, 'speech')
const SPEECH_API = process.env.BOARD_SPEECH_API || 'https://inference.tinfoil.sh/v1'
const STT_MODEL = process.env.BOARD_STT_MODEL || 'whisper-large-v3-turbo'
const TTS_MODEL = process.env.BOARD_TTS_MODEL || 'qwen3-tts'
// The voice, and what a text in a known language is spoken with instead ("de", "en"). Each of the
// per-language settings is optional: BOARD_TTS_MODEL_DE, BOARD_TTS_VOICE_DE, BOARD_TTS_LANGUAGE_DE.
const TTS_VOICE = process.env.BOARD_TTS_VOICE || ''
const TTS_LANGS = { de: 'German', en: 'English' }
const ttsFor = lang => {
  const known = Object.hasOwn(TTS_LANGS, lang) ? lang : ''
  const env = name => (known && process.env[`BOARD_TTS_${name}_${known.toUpperCase()}`]) || ''
  return { model: env('MODEL') || TTS_MODEL, voice: env('VOICE') || TTS_VOICE, language: env('LANGUAGE') || TTS_LANGS[known] || '' }
}
const speechKey = () => {
  if (process.env.TINFOIL_API_KEY) return process.env.TINFOIL_API_KEY
  try { return fs.readFileSync(path.join(DATA, 'tinfoil.key'), 'utf8').trim() } catch { return '' }
}

// Who this process speaks for. The name is what the human sees in the sidebar.
const SELF = {
  name: process.env.BOARD_AGENT || path.basename(process.cwd()) || 'agent', cwd: process.cwd(),
  host: os.hostname(), platform: `${os.type()} ${os.arch()}`,
}
// One per process. An agent keeps its id for as long as this stays the same,
// through reconnects and through a change of hub.
const INSTANCE = crypto.randomBytes(8).toString('hex')
const slug = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent'

// Everything in here is the owner's alone, like the state file.
for (const dir of [FILES, SCRIBBLES, SPEECH, ASSETS]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })

// The token is the only thing between the network and this session, so it is
// kept across restarts and never logged to the chat.
const TOKEN_FILE = path.join(DATA, 'token')
const readSecret = file => {
  try { return fs.readFileSync(file, 'utf8').trim() } catch { return '' }
}
const readToken = () => readSecret(TOKEN_FILE)
// Two sessions that start together must agree on one secret: the file is put
// in place whole, never over an existing one, and whoever comes second reads it.
function mintSecret(file) {
  const fresh = crypto.randomBytes(24).toString('base64url')
  const tmp = `${file}.${process.pid}`
  fs.writeFileSync(tmp, fresh, { mode: 0o600 })
  try { fs.linkSync(tmp, file) } catch {}
  fs.rmSync(tmp, { force: true })
  return readSecret(file) || fresh
}
let TOKEN = process.env.BOARD_TOKEN || readToken() || mintSecret(TOKEN_FILE)

// The hub may have replaced the token since this process read it (rotation on
// the admin page). A token pinned by the environment is never second-guessed.
function adoptToken() {
  const fresh = process.env.BOARD_TOKEN ? '' : readToken()
  if (!fresh || fresh === TOKEN) return false
  TOKEN = fresh
  return true
}

// The admin page can delete data and replace the token, so the login link alone
// does not open it: it also asks for this key, which only someone with a shell
// on the hub's machine can read. Set when this process becomes the hub.
const ADMIN_FILE = path.join(DATA, 'admin-token')
let adminKey = ''

// ---- state ---------------------------------------------------------------

const URGENCIES = ['low', 'normal', 'high', 'critical']
const SESSION_ENDED = 'Session ended before the approval was answered'
// Same wording as URGENCY_LABEL in client/web/js/ui.js, so timeline and card agree.
const URGENCY_LABEL = { low: 'Whenever', normal: 'Normal', high: 'Urgent', critical: 'Blocking' }

// State files from before urgency existed have no number, urgency or queue,
// and agent messages without attachments; fill those in instead of failing.
// The state rests in SQLite (board-store.mjs, the same file as the pad). state.json is where it was before:
// it is read once, when the database holds no board yet, and from then on neither read nor written.
// BOARD_STORE=json keeps the old way, as does a Node without SQLite.
let board = null
let movedMarked = false
// Set by load() when what it returned came from state.json and the database is still empty.
let fromJson = false
let jsonCounts = {}
function load(owner) {
  if (process.env.BOARD_STORE !== 'json' && !board) {
    try { board = openBoard(DATA) } catch (err) { console.error(`[board] the state stays in state.json: ${err.message}`) }
  }
  if (!board && fs.existsSync(path.join(DATA, MOVED_NAME))) {
    // state.json is from the day the board moved; starting from it would show the past and then write over nothing.
    console.error(`[board] this board rests in SQLite (${path.join(DATA, 'pad.db')}), which this hub ${process.env.BOARD_STORE === 'json' ? 'was told not to use (BOARD_STORE=json)' : `cannot open on Node ${process.versions.node}`}. Start it on Node 22.13 or newer, or go back to state.json first: node server/board-store.mjs back ${DATA}`)
    process.exit(1)
  }
  let raw = board?.read() ?? null
  fromJson = false
  if (!raw) try {
    raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object')
    fromJson = Boolean(board)
    // What the file holds, counted before anything is filled in or dropped: the database must not come up with less.
    jsonCounts = Object.fromEntries(['cards', 'messages', 'agents'].map(k => [k, Array.isArray(raw[k]) ? raw[k].filter(x => x && typeof x === 'object').length : 0]))
  } catch (err) {
    raw = {}
    if (err.code !== 'ENOENT' && board) console.error(`[board] state file unreadable (${err.message}); it is left as it is, starting empty`)
    // The next commit would overwrite a file that could not be read; keep it for a look.
    else if (err.code !== 'ENOENT') {
      const aside = path.join(DATA, `state.broken-${Date.now()}.json`)
      try { fs.renameSync(STATE_FILE, aside) } catch {}
      console.error(`[board] state file unreadable (${err.message}); kept as ${aside}, starting empty`)
    }
  }
  const list = key => (Array.isArray(raw[key]) ? raw[key] : []).filter(x => x && typeof x === 'object')
  // Before several agents could share a board nothing named its agent; those
  // records belong to whoever loads them first.
  const messages = list('messages')
    .map(m => ({ agent: owner, ...(m.from === 'agent' ? { attachments: [] } : {}), ...m }))
  const cards = list('cards').filter(c => c.id).map(c => ({
    agent: owner, urgency_reason: '', multiple: false, ...c,
    options: Array.isArray(c.options) ? c.options : [], attachments: Array.isArray(c.attachments) ? c.attachments : [],
    choices: Array.isArray(c.choices) ? c.choices : c.choice != null ? [c.choice] : [],
    version: Number.isInteger(c.version) ? c.version : (c.revisions ?? 0) + 1,
    urgency: c.kind === 'permission' || !URGENCIES.includes(c.urgency) ? defaultUrgency(c.kind) : c.urgency,
  }))
  // An approval request belongs to the session that asked; after a restart
  // nobody is waiting for its answer, so it must not sit on top of the stack.
  for (const c of cards) {
    if (c.kind === 'permission' && c.status === 'open') {
      c.status = 'done'
      c.summary = SESSION_ENDED
    }
  }
  const numbered = n => Number.isInteger(n) && n > 0
  let next = Math.max(1, numbered(raw.next_number) ? raw.next_number : 1, ...cards.filter(c => numbered(c.number)).map(c => c.number + 1))
  // Cards are stored in creation order, so numbering them in place keeps that order.
  for (const c of cards) if (!numbered(c.number)) c.number = next++
  const tasks = list('tasks')
    .filter(t => t.id && STATUSES.includes(t.state)).map(t => ({ agent: owner, ...t }))
  // The sessions stand in the order the human gave them; one without a place yet comes after those that have one.
  const place = a => (Number.isFinite(a.position) ? a.position : Infinity)
  const agents = list('agents').filter(a => a.id).map(a => ({ ...a, online: false }))
    .sort((a, b) => place(a) - place(b)).map((a, position) => ({ ...a, position }))
  // Spokes of the hub that just went away are probably still running and about to link again.
  reserved = new Map(list('agents').filter(a => a.online && a.instance && a.id !== raw.hub).map(a => [a.id, a.instance]))
  const pending = {}
  for (const [id, queue] of Object.entries(raw.pending && typeof raw.pending === 'object' ? raw.pending : {})) {
    if (Array.isArray(queue)) pending[id] = queue.filter(e => e && typeof e.method === 'string').slice(-PENDING_MAX)
  }
  const assets = list('assets').filter(a => ASSET_ID.test(a.id))
  return { agents, messages, cards, tasks, assets, queue: queueOf(cards, agents), next_number: next, pending }
}

// The traffic light the human reads at a glance: red waits on them, yellow is
// being worked on, green is finished.
const STATUSES = ['decision', 'working', 'done']

const defaultUrgency = kind => (kind === 'permission' ? 'critical' : 'normal')

// The stack the human works through: approvals first because Claude Code is
// waiting on them, then by urgency, then oldest first.
function queueOf(cards, agents = []) {
  const rank = c => (c.kind === 'permission' ? URGENCIES.length : URGENCIES.indexOf(c.urgency))
  // The questions of an archived session stay open, but nobody is asked to answer them.
  const shelved = new Set(agents.filter(a => a.archived).map(a => a.id))
  return cards
    .filter(c => c.status === 'open' && !shelved.has(c.agent))
    // Among equally urgent cards, what waits for an answer comes before what is only to be read.
    .sort((a, b) => rank(b) - rank(a) || (a.kind === 'info') - (b.kind === 'info') || a.created - b.created || a.number - b.number)
    .map(c => c.id)
}

let state = null   // set when this process becomes the hub

// Agents that are connected right now: id -> { instance, send, end }. send hands
// the agent a notification and says whether it could.
const links = new Map()
// Ids of agents that were linked to the previous hub, held for them for a moment
// after a takeover so that a session starting in the same folder cannot grab one.
let reserved = new Map()
let reservedUntil = 0

const clients = new Set()
// Set while a change that may wait a moment (a draft) is not yet in the state file.
let saveTimer = null
const newId = () => crypto.randomBytes(4).toString('hex')

// Written whole and then swapped in: a hub that dies in the middle of a write
// leaves the previous file behind, not half of a new one.
function save() {
  clearTimeout(saveTimer)
  saveTimer = null
  // Only the records that changed are written, all of them or none.
  if (board) {
    board.write(state)
    if (!movedMarked) {
      movedMarked = true
      const marker = path.join(DATA, MOVED_NAME)
      if (!fs.existsSync(marker)) fs.writeFileSync(marker, `The board's state rests in pad.db since ${new Date().toISOString()}. state.json, if there is one, is the backup of that day and is not read any more.\n`, { mode: 0o600 })
    }
    return
  }
  const tmp = `${STATE_FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, STATE_FILE)
}

// The page gets everything except what is still waiting to be delivered to agents.
const frameOf = () => `data: ${JSON.stringify({ ...state, pending: undefined })}\n\n`

// soon: the pages get the state at once, the file is written within a second, together with whatever else changed until then.
function commit(soon = false) {
  state.queue = queueOf(state.cards, state.agents)
  // The list is the order of the sidebar; position says the same as a number, so a new session is last and a forgotten one leaves no gap.
  state.agents.forEach((a, at) => { a.online = links.has(a.id); a.position = at })
  state.speech = Boolean(speechKey())
  if (!soon) save()
  else saveTimer ??= setTimeout(() => { if (role === 'hub') save() }, 1000).unref()
  const frame = frameOf()
  // A page on a slow connection gets the latest state once it has caught up,
  // not a growing backlog of every state in between.
  for (const res of clients) {
    if (res.writableNeedDrain) res.behind = true
    else res.write(frame)
  }
}

function addMessage(agent, from, text, attachments = [], extra = {}) {
  state.messages.push({ id: newId(), agent, from, text, attachments, ...extra, ts: Date.now() })
  commit()
}

// Board activity shows up in the conversation as a one-line marker that links to the card.
function addEvent(kind, card, text) {
  state.messages.push({ id: newId(), agent: card.agent, from: 'event', kind, card_id: card.id, text, ts: Date.now() })
}

function addCard(agent, kind, fields) {
  const card = {
    id: newId(), agent, number: state.next_number++, kind, status: 'open',
    urgency: defaultUrgency(kind), urgency_reason: '', title: '', body: '', options: [], attachments: [],
    version: 1, multiple: false, choice: null, choices: [], note: '', summary: '', created: Date.now(), decided: null, ...fields,
  }
  state.cards.push(card)
  return card
}

// An agent only ever touches its own cards.
function findCard(agent, id) {
  const card = state.cards.find(c => c.id === id && c.agent === agent)
  if (!card) throw new Error(`no card ${id}`)
  return card
}

// ---- agents --------------------------------------------------------------

// An id is the slug of the agent's name, with -2, -3 for further sessions of
// the same name. A process that comes back gets the id it had; a new process
// gets the plain slug only if no running session holds it.
function agentId(name, wanted, instance) {
  const taken = id => {
    const link = links.get(id)
    if (link) return link.instance !== instance
    return Date.now() < reservedUntil && reserved.has(id) && reserved.get(id) !== instance
  }
  if (wanted && !taken(wanted) && state.agents.some(a => a.id === wanted && a.instance === instance)) return wanted
  let id = slug(name)
  for (let n = 2; taken(id); n++) id = `${slug(name)}-${n}`
  return id
}

function register({ name, cwd, host = '', platform = '', id: wanted }, link) {
  const id = agentId(name, wanted, link.instance)
  // The same process linking again before its old connection was seen to close.
  links.get(id)?.end?.()
  links.set(id, link)
  const known = state.agents.find(a => a.id === id)
  const now = Date.now()
  // A session that is back is no longer archived.
  const fields = { name, cwd, host, platform, instance: link.instance, connected: now, seen: now, archived: false }
  if (known) Object.assign(known, fields)
  else state.agents.push({ id, model: '', client: '', task: '', joined: now, online: true, ...fields })
  commit()
  return id
}

// What the agent missed while it was away. An entry leaves the queue only once it was handed over.
function flush(id) {
  const link = links.get(id)
  const queue = state.pending[id]
  if (!link || !queue?.length) return
  while (queue.length && link.send(queue[0].method, queue[0].params)) queue.shift()
  if (!queue.length) delete state.pending[id]
  save()
}

function unregister(id, link) {
  // A newer link of the same agent may already have taken this one's place.
  if (links.get(id) !== link) return
  links.delete(id)
  // Its approval requests die with the session.
  for (const c of state.cards) {
    if (c.agent === id && c.kind === 'permission' && c.status === 'open') {
      c.status = 'done'
      c.summary = SESSION_ENDED
    }
  }
  const agent = state.agents.find(a => a.id === id)
  if (agent) agent.seen = Date.now()
  commit()
}

// Old answers are not kept forever: the card, its attachment files, and its
// markers in the conversation go together. Open cards are never touched.
const expired = cutoff => state.cards.filter(c => c.status !== 'open' && (c.decided ?? c.shredded ?? c.created) < cutoff)

function purge() {
  const cutoff = Date.now() - RETENTION_DAYS * 86400000
  // An agent that never came back does not keep its mail forever either.
  for (const [id, queue] of Object.entries(state.pending)) {
    const fresh = queue.filter(e => !(e.ts < cutoff))
    if (fresh.length === queue.length) continue
    if (fresh.length) state.pending[id] = fresh
    else delete state.pending[id]
    save()
  }
  const stale = staleAssets(cutoff)
  if (stale.length) {
    dropAssets(stale, `removed after ${RETENTION_DAYS} days`)
    commit()
    console.error(`[board] removed ${stale.length} assets published more than ${RETENTION_DAYS} days ago`)
  }
  const old = expired(cutoff)
  if (!old.length) return
  const ids = new Set(old.map(c => c.id))
  for (const card of old) {
    for (const name of [card, ...(card.versions ?? [])].flatMap(v => v.attachments ?? []).flatMap(filesOfAttachment)) fs.rmSync(path.join(FILES, name), { force: true })
  }
  state.cards = state.cards.filter(c => !ids.has(c.id))
  state.messages = state.messages.filter(m => !(m.from === 'event' && ids.has(m.card_id)))
  for (const t of state.tasks) if (ids.has(t.card_id)) t.card_id = null
  commit()
  console.error(`[board] removed ${old.length} cards answered more than ${RETENTION_DAYS} days ago`)
}

// What an agent says about itself: the model it runs on, the program it runs in, its current task.
function setProfile(id, fields) {
  const agent = state.agents.find(a => a.id === id)
  if (!agent) return
  for (const key of ['model', 'client', 'task']) if (fields[key] != null) agent[key] = String(fields[key]).slice(0, 200)
  commit()
}

// The named drawings a session can carry as its mark: [{ name, meaning, hue }], kept by the web client.
// Read again when the file changes; without the file any plain name is taken and no list is offered.
const DRAWINGS_FILE = process.env.BOARD_DRAWINGS || path.join(PUBLIC, 'drawings.json')
let drawingsSeen = { stamp: '', list: null }
function drawings() {
  let stamp = ''
  try { const st = fs.statSync(DRAWINGS_FILE); stamp = `${st.mtimeMs}:${st.size}` } catch {}
  if (stamp !== drawingsSeen.stamp) {
    let list = null
    try {
      const raw = JSON.parse(fs.readFileSync(DRAWINGS_FILE, 'utf8'))
      if (Array.isArray(raw)) list = raw.filter(d => d && typeof d.name === 'string' && d.name).map(d => ({ name: d.name, meaning: String(d.meaning ?? ''), ...(d.hue == null ? {} : { hue: d.hue }) }))
    } catch {}
    drawingsSeen = { stamp, list: list?.length ? list : null }
  }
  return drawingsSeen.list
}
const drawingList = list => list.map(d => (d.meaning ? `${d.name} (${d.meaning})` : d.name)).join(', ')

// The agent picks the drawing that fits its task. What the human picked by hand stays.
function setIcon(id, icon) {
  const agent = state.agents.find(a => a.id === id)
  if (!agent || icon == null || icon === '') return ''
  const name = String(icon).replace(/^draw:/, '')
  const list = drawings()
  if (list ? !list.some(d => d.name === name) : !/^[a-z]+$/.test(name)) {
    throw new Error(list ? `no drawing "${name}"; choose one of: ${drawingList(list)}` : `icon must be the name of a drawing, lower-case letters only; got "${name}"`)
  }
  if (agent.icon && agent.icon_by !== 'agent') return '; the human chose this session\'s symbol by hand, so it stays'
  Object.assign(agent, { icon: `draw:${name}`, icon_by: 'agent' })
  return `; symbol "${name}"`
}

// The queue of an agent that is away lives in the state file, so it outlasts the hub.
async function deliver(agent, method, params) {
  if (links.get(agent)?.send(method, params)) return
  const queue = state.pending[agent] ?? []
  state.pending[agent] = [...queue, { method, params, ts: Date.now() }].slice(-PENDING_MAX)
  save()
}

function urgencyArg(value, fallback) {
  if (value == null && fallback) return fallback
  if (!URGENCIES.includes(value)) throw new Error(`urgency must be one of ${URGENCIES.join(', ')}; got ${JSON.stringify(value)}`)
  return value
}

// Pictures that found their page by name in this call (foo.png beside foo.html), for the tool result.
let paired = []
const pairedHint = () => {
  const said = paired.length ? `\nLinked by name, so the human can open the page under the picture: ${paired.join(', ')}` : ''
  paired = []
  return said
}
// The files a stored attachment consists of: itself and, if it brought one, its page.
const filesOfAttachment = a => [a?.url, a?.page?.kind === 'file' ? a.page.url : null].filter(u => typeof u === 'string' && u.startsWith('/files/')).map(u => path.basename(u))

// The page a picture was rendered from: a self-contained HTML file, stored and served beside the picture
// (sandboxed, see /files), or a link: a path on the board, an asset link, a URL. A file that exists wins.
function pageOf(page) {
  if (typeof page !== 'string' || !page.trim()) throw new Error('page must be the path of an HTML file, a path on the board or a URL')
  const ref = page.trim()
  const link = /^https?:\/\//i.test(ref)
  const src = link ? null : path.isAbsolute(ref) ? ref : null
  if (src && fs.existsSync(src) && fs.statSync(src).isFile()) {
    const ext = path.extname(src).toLowerCase()
    if (ext !== '.html' && ext !== '.htm') throw new Error(`page must be an HTML file; got ${ref}`)
    if (fs.statSync(src).size > MAX_ATTACHMENT) throw new Error(`page larger than ${MAX_ATTACHMENT / 1024 / 1024} MB: ${ref}`)
    const stored = `${newId()}.html`
    fs.copyFileSync(src, path.join(FILES, stored))
    return { url: `/files/${stored}`, kind: 'file' }
  }
  // A path whose folder exists on this machine was meant as a file and is missing; any other /path is one on the board.
  const lost = src && path.dirname(src) !== '/' && fs.existsSync(path.dirname(src))
  if (link || (!lost && ref.startsWith('/') && !ref.startsWith('//'))) return { url: ref.slice(0, 2000), kind: 'link' }
  throw new Error(`page not found: ${ref} is neither an existing HTML file, nor a path on the board (/…), nor a URL`)
}

// entry: a path, or { path, page?, title? }.
function storeAttachment(entry) {
  const given = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : { path: entry }
  const file = given.path
  if (typeof file !== 'string' || !file) throw new Error('an attachment must be the path of a file, or { path, page, title }')
  const src = path.resolve(file)
  const stat = fs.statSync(src)
  if (!stat.isFile()) throw new Error(`not a file: ${file}`)
  if (stat.size > MAX_ATTACHMENT) throw new Error(`attachment larger than ${MAX_ATTACHMENT / 1024 / 1024} MB: ${file}`)
  const ext = path.extname(src).toLowerCase()
  const stored = `${newId()}${ext}`
  fs.copyFileSync(src, path.join(FILES, stored))
  const kind = kindOf(ext)
  // A picture is almost always a rendering of a page; one that lies beside it under the same name is taken to be it.
  const beside = src.slice(0, src.length - ext.length) + '.html'
  const twin = given.page == null && kind === 'image' && fs.existsSync(beside) && fs.statSync(beside).isFile() ? beside : null
  if (twin) paired.push(`${path.basename(src)} → ${path.basename(twin)}`)
  const page = given.page != null && given.page !== '' ? pageOf(given.page) : twin ? pageOf(twin) : null
  const title = String(given.title ?? '').trim().slice(0, 200)
  return { name: path.basename(src), url: `/files/${stored}`, kind, image: kind === 'image', size: stat.size, ...(title ? { title } : {}), ...(page ? { page } : {}) }
}

// What the human attaches in the browser (a file, a pasted screenshot, a drawing): a list of
// { name, data } with data a base64 data URL. Each is stored beside the agents' attachments and
// served like them; the agent is told where the files lie, so it can open them.
const MAX_UPLOADS = 12
const UPLOAD_BODY = 96e6
const UPLOAD_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg', 'application/pdf': '.pdf', 'text/plain': '.txt' }
function storeUploads(list) {
  if (list == null) return []
  if (!Array.isArray(list)) throw new Error('attachments must be a list')
  if (list.length > MAX_UPLOADS) throw new Error(`at most ${MAX_UPLOADS} attachments at once`)
  // All of them are read before the first is written: one bad entry stores nothing.
  const read = list.map(a => {
    const m = /^data:([\w.+-]+\/[\w.+-]+)?(?:;[\w.+=-]+)*;base64,([A-Za-z0-9+/=]+)$/.exec(String(a?.data ?? ''))
    if (!m) throw new Error('an attachment must be a base64 data URL')
    const bytes = Buffer.from(m[2], 'base64')
    if (!bytes.length) throw new Error('an attachment is empty')
    if (bytes.length > MAX_ATTACHMENT) throw new Error(`attachment larger than ${MAX_ATTACHMENT / 1024 / 1024} MB`)
    const name = path.basename(String(a.name ?? '').replace(/\\/g, '/')).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 120) || 'file'
    const named = path.extname(name).toLowerCase()
    return { name, bytes, ext: /^\.[a-z0-9]{1,8}$/.test(named) ? named : UPLOAD_EXT[m[1]] ?? '' }
  })
  return read.map(({ name, bytes, ext }) => {
    const stored = `${newId()}${ext}`
    fs.writeFileSync(path.join(FILES, stored), bytes, { mode: 0o600 })
    const kind = kindOf(ext)
    return { name, url: `/files/${stored}`, kind, image: kind === 'image', size: bytes.length }
  })
}
const uploadPath = a => path.join(FILES, path.basename(a.url))
/** For the agent: where the human's files lie (meta values are strings, so the paths travel comma-separated), the first picture also as image_path. */
function uploadMeta(files) {
  if (!files.length) return {}
  const picture = files.find(a => a.image)
  return { files: files.map(uploadPath).join(','), ...(picture ? { image_path: uploadPath(picture) } : {}) }
}
const uploadLine = files => `The human sent ${files.length === 1 ? 'a file' : `${files.length} files`}: ${files.map(a => a.name).join(', ')}. The meta attribute files holds ${files.length === 1 ? 'its path' : 'their paths'}.`

// ---- assets --------------------------------------------------------------

// The envelope itself (format, padding, id and key, link) is in asset-envelope.mjs,
// shared with dev/session.mjs.

// Runs in the process that got the tool call. The hub is handed the key only
// for an asset it has to show on the board; of a silent one it learns the
// address and the size, nothing else.
async function publishAsset(args) {
  const { id, key, blob, meta, record } = prepareAsset(args)
  const silent = record.silent
  const sent = assetUpload(selfId, INSTANCE, record, blob)
  const { bases } = role === 'hub' ? storeAsset(selfId, record, blob) : await hubFetch(sent.route, { headers: sent.headers, body: sent.body })
  const [link, ...more] = bases.map(base => assetLink(base, id, key))
  return [
    `asset ${id} published (${meta.type}, ${blob.length} bytes encrypted, ${record.keep ? 'kept until revoked' : `deleted after ${RETENTION_DAYS} days`}).`,
    `Link, opens without a board login for anyone who has it: ${link}`,
    ...more.map(other => `Same asset under the board's other address: ${other}`),
    silent ? 'Not shown on the board. The hub never saw the key: this link is the only copy, so hand it on yourself.' : 'Shown in the conversation on the board.',
  ].join('\n')
}

// Addresses a link can be opened under: WebCrypto needs HTTPS or localhost, so a plain LAN address is not one.
const assetBases = () => [...PUBLIC_URLS, `http://localhost:${PORT}`]

// Runs on the hub: keeps the ciphertext and, unless the asset is silent, shows the link in the conversation.
function storeAsset(agent, given, blob) {
  const id = String(given?.id ?? '')
  const silent = given.silent === true
  if (!ASSET_ID.test(id) || state.assets.some(a => a.id === id)) throw new Error('an asset needs a fresh id of 22 base64url characters')
  if (blob.length < 32 || blob.length > ASSET_BLOB_MAX || !blob.subarray(0, 4).equals(ASSET_MAGIC)) throw new Error('not an asset blob')
  if (!silent && !(ASSET_TYPES.includes(given.type) && ASSET_KEY.test(given.key))) throw new Error('an asset shown on the board needs its type and key')
  fs.writeFileSync(path.join(ASSETS, id), blob, { mode: 0o600, flag: 'wx' })
  const title = silent ? '' : String(given.title ?? '').slice(0, 200)
  state.assets.push({
    id, agent, type: silent ? null : given.type, title, size: blob.length, created: Date.now(), keep: given.keep === true, silent,
    // Empty until the room key exists (docs/krypto-konzept.md, sections 4 and 7). Planned: the asset key sealed
    // with AES-256-GCM under a key derived from the room key by HKDF-SHA-256, with room, epoch and asset id as
    // associated data. From then on the board gets the key from here, and the hub stops seeing it in a message.
    wrapped_key: null,
  })
  const bases = assetBases()
  if (silent) commit()
  else {
    const url = `/a/${id}#${given.key}`
    const note = String(given.note ?? '').trim()
    // The link in the text is what today's page turns into an anchor; the asset field is for a card of its own.
    addMessage(agent, 'agent', [`**${title}** (${ASSET_LABEL[given.type]})`, note, bases[0] + url].filter(Boolean).join('\n\n'), [], { asset: { id, type: given.type, title, note, url, size: blob.length } })
  }
  return { id, bases }
}

const staleAssets = cutoff => state.assets.filter(a => !a.keep && a.created < cutoff)

// Blob and record go, and the message that showed the link keeps only the title: with it the hub forgets the key.
function dropAssets(gone, why) {
  const ids = new Set(gone.map(a => a.id))
  for (const a of gone) removeFile(ASSETS, a.id)
  state.assets = state.assets.filter(a => !ids.has(a.id))
  for (const m of state.messages) {
    if (!ids.has(m.asset?.id)) continue
    m.text = `**${m.asset.title}** (${why})`
    m.asset = { id: m.asset.id, type: m.asset.type, title: m.asset.title, gone: true }
  }
}

function listAssets(agent) {
  const shown = id => state.messages.find(m => m.asset?.id === id)?.asset.url
  return state.assets.filter(a => a.agent === agent).map(a => ({
    id: a.id, type: a.type, title: a.title, bytes: a.size, created: new Date(a.created).toISOString(),
    expires: a.keep ? null : new Date(a.created + RETENTION_DAYS * 86400000).toISOString(), silent: a.silent,
    // Of a silent asset the hub has no key, so it cannot repeat the link.
    link: a.silent ? null : assetBases()[0] + shown(a.id),
  }))
}

// ---- MCP side ------------------------------------------------------------

const mcp = new Server(
  { name: 'board', version: '0.1.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
      tools: {},
    },
    instructions: [
      'You are connected to Trommi, a web page with a chat and a stack of decision cards. The human is on that page, often on a phone, and cannot see this terminal.',
      'Messages from the human arrive as <channel source="board" kind="chat">. Nothing you write in the terminal reaches them: every answer, question, and progress update for the human MUST be sent with the reply tool. After handling a channel message, always call reply at least once, even if only to confirm.',
      'The human sees only what you send through these tools: not your thinking, not your tool calls, not the terminal. When the reasoning or the evidence matters, put it in the details field of reply; it is shown collapsed under the message.',
      'Write replies as short chat messages; light markdown (bold, inline code, code fences, bullet lists) is rendered. For the one thing the human must not miss, write __two underscores around a few words__: the board underlines them by hand. Use it rarely; a text that underlines much is shown plain. Attach images, rendered videos, audio or other files to a reply by absolute path when showing beats telling; video and audio play inline on the board.',
      'To compare things, write a markdown table (| a | b | rows, a rule of dashes under the first): the board draws it as a real table, numbers right-aligned. For anything richer, pass html beside the words (reply, create_decision, revise_card, merge_cards, or a block in sections), or fence it as ```html inside a text: it is shown at its place in the house style, light and dark. Semantic HTML only: tables, headings, lists, details, mark, kbd, simple inline CSS, the classes grid, cols-2, cols-3, card, tag, muted, num, good, warn, bad. No scripts and nothing from the network, both are removed; pictures as data: URLs or as attachments. To show HTML as source instead, fence it as ```xml. Always say the gist in plain words in text (body for a question): that is what is read aloud and what clients without HTML show. A whole page to try out stays with publish_asset.',
      'When you need the human to choose something, do not ask in chat: call create_decision with a one-line question as title, a short body, and 2-6 options. Each option has a stable machine key, a human label, and where it helps a detail of a few words naming its consequence. Attach screenshots, mockups, or diffs by absolute path when they help the choice.',
      'When several options can hold at once (which of these to include, which to delete), set multiple: true: the human ticks any number of options and sends them together. The decision then arrives with choices="a,b", every chosen key comma-separated in the order of the options, next to choice, which is the first of them; recommended may then be a list of keys.',
      'Make simple decisions quick to answer: if a question is really yes or no, give exactly two options with short labels (under 18 characters), keep the body under about three lines, and attach nothing. Such cards are answered with one tap straight from the inbox; anything with more options, longer text, or attachments makes the human open the card first. Put the option you would pick first.',
      'Keep every question short to read: an option label is at most about four words; detail is optional and at most one short line of about six words, never a paragraph and never an explanation of what leaving it unticked means; the body is one or two short sentences. A longer explanation goes behind a link (publish_asset) or an attachment, or comes when the human presses "Explain", which reaches you as a question back.',
      'When the human asks for an explanation, or you have something they should read but need not decide (a report, how something works, what you found), file it with create_info: a card with a title and a text, with a picture or diagram where it helps and sections for structure. The human reads it and closes it; you then get <channel source="board" kind="info_read" card_id="...">, which needs no answer. Do not dress such a thing up as a question with made-up options. A plain progress note stays a reply. If the human hands an info back or asks back about it, rework it with revise_card.',
      'A question stays ONE card through its whole life. When the human hands a card back to you (a chat message with card_id and handback="1") or asks back about it, do not file a new question and do not only reply: rework the card with revise_card (new wording, options, pictures). It is then presented again, and the earlier versions stay visible to the human. Use withdraw_card and a new card only when the subject itself changed.',
      'Before filing a question, call list_cards. If you already have an open question on the same subject, do not add another: rewrite the open one with revise_card, which keeps its number and place, or replace several by one with merge_cards. Do this on your own initiative, without being asked; the human should never get many small questions that are really one.',
      'Prefer one question with multiple: true ("tick what you agree to", your advice as a recommended list) over several yes/no questions on one theme. More than about three open questions of yours on one theme is a sign to merge them.',
      'When a question needs explaining per option, do not write a body with one paragraph per option next to a separate options list: hand in ONE structured text, as sections (a list of blocks) or as text (one string), and flag the paragraphs that are options. The board then shows each paragraph tied to its option: the human ticks the paragraph itself. In text, paragraphs are separated by a blank line, and a paragraph starting with [key] Label: becomes the option "key" with that paragraph as its explanation ([key*] marks the one you would pick); every other paragraph is plain context. Keep labels to about four words and each paragraph short. Plain options stay right for simple questions.',
      'The human may answer, ask back or shred with notes pinned to parts of the question and drawings on it: they come as lines under "Notes pinned to the card:" (marks="N" in the event), with a picture of the annotated card in image_path. Read them together with the picture; they are part of the answer.',
      'The human can write a note on any option, chosen or not ("not this, because ..."). Such notes come with the decision: its text lists them as lines "- Label [key], chosen or not chosen: note" after the general note, and option_notes names the keys that have one. Read them before acting.',
      'Say which option you would pick: set recommended to its key. The board circles it by hand, the human still decides.',
      'When a question is easier to grasp with a picture, attach a small drawing, diagram or screenshot to the card (attachments), and name the option you would pick in recommended.',
      'A picture of something you built is almost always a rendering of a page: send the page with it, as an attachment { path, page }, so the human can open and try it right under the picture (a file foo.html beside foo.png is linked by itself). page is a self-contained HTML file, a path on the board or a link. A plain photo or diagram needs none.',
      'A question about how something looks or is laid out (UI, design, layout, wording or naming seen on screen) MUST carry a picture; words alone are not enough for it. Attach a screenshot, mockup or drawing per option where possible, each file named after its option key (<anything>-<key>.png), so the board shows each picture with its option; in sections, picture ties one to its block. For something that must be tried, link a clickable page: publish_asset, or a path on the board in backticks. When the human asks you to explain such a question, answer with a picture too.',
      'The human sees one card at a time, the top of the stack; urgency decides the order (most urgent first, then oldest first), so set it honestly on every card.',
      'critical: you are blocked and nothing else can proceed. high: it blocks your current task, but you have other work. normal (default): needed soon, nothing waits on it yet. low: nice to know, no work depends on it.',
      'For high and critical, give an urgency_reason: one short phrase, in the human\'s language, saying what is waiting. If everything is urgent, nothing is; most cards are normal.',
      'Keep the stack true as your work moves: when an open card starts blocking you, raise it with set_urgency; lower it if the pressure is gone; and call withdraw_card as soon as a question became moot, so the human never answers something you no longer need. list_cards shows the current stack.',
      'When the human trusts you with a question (the decision event carries trust="1"), the decision is yours: take the option you recommended or, if you recommended none, choose yourself. Then say in one line what you chose, with reply and that card_id, and call close_card with a summary. Do not ask again.',
      'The human may copy a card into a message to you, often another session\'s decision (cards="..." in the event): the content then holds that card in full, with the question, the options, the answer and the notes. Treat an answered one as decided; do not ask it again.',
      'The human can throw a question away unanswered: <channel source="board" kind="shredded" card_id="...">. That is not a yes and not a no. Do not file it again, nor a rewording of it; carry on with your own judgement or drop the matter. If you truly cannot proceed without an answer, say so once in a reply, not as a new question.',
      'The choice arrives later as <channel source="board" kind="decision" card_id="..." choice="KEY">; the body is the human\'s note if they wrote one. Act on it, then call close_card with a one-line summary of what you did.',
      'Do not block waiting for a decision: keep working on whatever does not depend on it.',
      'A chat message with a card_id (<channel source="board" kind="chat" card_id="...">) is a question back about that card, not an answer to it; the card stays open. Answer it with reply, passing the same card_id, and when the question back shows the card was unclear, do not only reply: rewrite the card with revise_card, so the question itself is clear.',
      'When that question back asks you to explain the card (the board has a one-tap "Explain"), answer with reply and the same card_id in plain words and briefly: what the question is about, what each option would mean for the human, and which one you would pick. The card waits out of the way until your reply arrives, so answer promptly.',
      'The human can attach files, pasted screenshots and small drawings to a chat message and to the note of an answer: the meta attribute files then holds their absolute paths, comma-separated, and image_path the first picture among them. Read them before you answer.',
      'When you introduce yourself, also pass icon: the drawing that fits your task, chosen from the names listed in the description of introduce. It becomes the symbol of your session; one the human picked by hand is kept.',
      'When the session starts, call introduce once with the model you are running as and a one-line description of your task, so the human can tell the sessions apart.',
      'Other agents may share this board; the human sees all stacks merged into one, ordered by urgency. You only see and change your own cards and status lines.',
      'You can speak: create_voiceover turns text into an MP3 with a natural voice and returns its path, for narration in videos you render or a spoken update attached to a reply. The human may dictate messages, so expect transcription slips in chat and read them charitably.',
      'The human has a lasting canvas for sketches and annotated screenshots. <channel source="board" kind="scribble" image_path="/abs/view.png" canvas_path="/abs/whole.png"> means they drew and pressed send: image_path is the part of the canvas they were looking at, so read it first; canvas_path is the entire canvas if you need the surroundings. A chat message explaining it often follows right after.',
      'The human also keeps one pad for everything: notes, drawings, pictures and spoken text, each an element of its own. <channel source="board" kind="pad" elements="ID,ID" image_path="/abs/selection.png"> means they selected some of it and sent it to you: the body is the words of the selected notes in reading order, image_path is a picture of exactly the selection, so read it; elements are the ids of what was selected.',
      'The human answers with one tap and can take an answer back: <channel source="board" kind="decision_reopened" card_id="..." previous_choice="KEY"> means the card is open again. Stop acting on the old choice, undo what you safely can, tell them briefly via reply what you rolled back, and wait for the new choice.',
      'To hand the human, or anyone they choose, a page or a file as a link, call publish_asset: a self-contained HTML page (inline CSS and scripts, images as data: URLs; nothing is loaded from the network), an image, a video, an audio file or any other file. It is encrypted before it leaves this process and the key is part of the link, so whoever has the link can open it without a login. revoke_asset ends a link.',
      'Keep the status strip current with set_status: one line per work stream or subagent, a traffic light the human reads at a glance. decision (red) = waiting on the human, pass the card_id of the question; working (yellow) = in progress; done (green) = finished. Update a line the moment its state changes and clear the strip with clear_status when a new piece of work starts.',
    ].join(' '),
  },
)

// The text-block form of a question, as shown to agents and on the help page.
const SECTION_TEXT_EXAMPLE = [
  'The export times out for large accounts. Tick what I may build.',
  '[limit*] Raise the limit: 60 instead of 30 seconds. Done in five minutes, but only moves the wall.',
  '[async] Export in the background: The file arrives by mail when it is ready. About two days.',
  '[page] Paginate the export\nSmaller files, but every consumer of the API has to follow.',
].join('\n\n')

// What a question is made of besides its title, the same for create_decision, revise_card and merge_cards.
const QUESTION_PROPS = {
  body: { type: 'string', description: 'Context the human needs to decide: one or two short sentences. Longer explanation belongs behind a link or in an attachment. Not together with sections or text, which carry their own context.' },
  html: { type: 'string', description: `Optional rich layout shown under the words, at its place, in the house style: a comparison table with merged cells, a small grid, a details block. Semantic HTML with inline CSS only (tables, headings, lists, details, mark, kbd; classes grid, cols-2, cols-3, card, tag, muted, num, good, warn, bad); scripts, forms, frames and anything fetched from the network are removed; pictures as data: URLs. At most ${HTML_MAX / 1024} KB. For a plain comparison a markdown table in the text is enough. Needs body beside it, the same in plain words; not together with sections or text, where a block carries its own html.` },
  options: {
    type: 'array',
    minItems: 2,
    description: 'The choices offered. Give options (with body), or sections, or text: one of the three.',
    items: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Stable identifier returned to you, e.g. "sqlite"' },
        label: { type: 'string', description: 'What the human sees on the button, at most about four words' },
        detail: { type: 'string', description: 'Optional consequence of this choice: one short line of about six words, never a paragraph, never what leaving it unticked means' },
      },
      required: ['key', 'label'],
    },
  },
  sections: {
    type: 'array',
    description: 'Instead of body and options: the whole question as one structured text, an ordered list of blocks. A block without key is plain text (introduction, context). A block with key is a flagged paragraph and becomes an option: the board shows the paragraph tied to its option, and options, body and recommended are derived from the blocks. At least two blocks need a key.',
    items: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The paragraph, markdown; for a flagged block what this option means, at most about 400 characters' },
        key: { type: 'string', description: 'Flags the block as an option: the stable identifier returned to you' },
        label: { type: 'string', description: 'Required with key: the short name of the option on its tile, at most about four words' },
        html: { type: 'string', description: 'A rich layout shown under this paragraph (see html); the text beside it says the same in plain words' },
        recommended: { type: 'boolean', description: 'true: you would pick this one; several only with multiple: true' },
        picture: { anyOf: [{ type: 'string' }, { type: 'integer' }], description: 'An attachment of this card that belongs to this option: its file name, or its position in attachments counted from 0' },
      },
      required: ['text'],
    },
  },
  text: {
    type: 'string',
    description: `The same as sections, written as one text block. Paragraphs are separated by a blank line. A paragraph that starts with [key] is an option: "[key] Label: explanation"; without a colon the first line is the label and the following lines explain. [key*], or (recommended) after the label, marks your advice. A last line "picture: file.png" ties an attachment to the option. Every other paragraph is plain context. Example:\n${SECTION_TEXT_EXAMPLE}`,
  },
  attachments: {
    type: 'array',
    description: 'Files to show on the card, each an absolute path or { path, page, title }; images render inline. A picture of something you built comes with the page it was rendered from (page); foo.html beside foo.png is linked by itself.',
    items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { path: { type: 'string', description: 'Absolute path of the file' }, page: { type: 'string', description: 'The page this picture was rendered from, so the human can open and try it under the picture: the path of a self-contained HTML file, a path on the board (/designs/x.html), an asset link or a URL' }, title: { type: 'string', description: 'A short caption' } }, required: ['path'] }] },
  },
  urgency: {
    type: 'string',
    enum: URGENCIES,
    description: 'Position in the stack. critical: you are blocked entirely; high: blocks your current task; normal (default): needed soon; low: nice to know',
  },
  urgency_reason: { type: 'string', description: 'What is waiting on this, one short phrase; expected for high and critical' },
  multiple: { type: 'boolean', description: 'true: the human may tick several options and sends them together; the decision then also carries choices, all chosen keys comma-separated. Default false: one tap on one option decides.' },
  recommended: {
    anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    description: 'The key of the option you would pick yourself; for a card with multiple: true it may be a list of keys. It is shown circled by hand, so the human sees your advice at a glance. Leave it out when you have no preference.',
  },
}

const TOOLS = [
  {
    name: 'reply',
    description: 'Send a chat message to the human on the Trommi board.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The message to show in the chat' },
        html: { type: 'string', description: `Optional rich layout shown under the words, at its place, in the house style: a comparison table with merged cells, a small grid, a details block. Semantic HTML with inline CSS only (tables, headings, lists, details, mark, kbd; classes grid, cols-2, cols-3, card, tag, muted, num, good, warn, bad); scripts, forms, frames and anything fetched from the network are removed; pictures as data: URLs. At most ${HTML_MAX / 1024} KB. For a plain comparison a markdown table in the text is enough. Needs text beside it: the gist in plain words, which is what is read aloud and what clients without HTML show.` },
        details: { type: 'string', description: 'Optional longer material shown collapsed under the message: your reasoning, what you tried, command output, a diff. Markdown. The human opens it only if they want to.' },
        attachments: {
          type: 'array',
          description: 'Absolute paths of files to show with the message; images, videos (mp4, webm, mov) and audio play inline, anything else is a download link. Each is an absolute path or { path, page, title }: a picture of something you built comes with the page it was rendered from (page); foo.html beside foo.png is linked by itself.',
          items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { path: { type: 'string', description: 'Absolute path of the file' }, page: { type: 'string', description: 'The page this picture was rendered from, so the human can open and try it under the picture: the path of a self-contained HTML file, a path on the board (/designs/x.html), an asset link or a URL' }, title: { type: 'string', description: 'A short caption' } }, required: ['path'] }] },
        },
        card_id: { type: 'string', description: 'When you answer a question the human asked back about a card (a chat message that carried card_id): that card. The board shows your answer with the card.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'create_decision',
    description: 'Put a decision card on the board for the human to answer. Returns the card id. Call list_cards first: if you already have an open question on the same subject, use revise_card or merge_cards instead of adding another. Keep it short: body one or two short sentences, option labels about four words, detail at most one short line. When every option needs a sentence or two of explanation, pass sections or text instead of body and options, so each paragraph sits with its option. A question about how something looks or is laid out must carry a picture: one attachment per option where possible, named <anything>-<key>.png, or a link to a page to try.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The question, one line' },
        ...QUESTION_PROPS,
      },
      required: ['title'],
    },
  },
  {
    name: 'create_info',
    description: 'Put something to read on the board: an explanation the human asked for, a report, how something works, what you found. It lies in the stack like a question but asks nothing: no options; the human reads it and closes it, and you get a quiet info_read event that needs no answer. Give the words as body, or structured as sections or text (plain blocks only), with a picture or diagram where it helps. revise_card reworks it, withdraw_card takes it away. Returns the card id.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What it is about, one line' },
        body: { type: 'string', description: 'The text, markdown. Or give sections or text.' },
        sections: {
          type: 'array',
          description: 'Instead of body: the text as an ordered list of blocks, each a paragraph or a short passage of its own. No block has a key: an info has no options.',
          items: { type: 'object', properties: { text: { type: 'string', description: 'The paragraph, markdown' }, html: QUESTION_PROPS.sections.items.properties.html }, required: ['text'] },
        },
        text: { type: 'string', description: 'The same as sections, written as one text block: paragraphs separated by a blank line.' },
        ...Object.fromEntries(['html', 'attachments', 'urgency', 'urgency_reason'].filter(k => QUESTION_PROPS[k]).map(k => [k, QUESTION_PROPS[k]])),
      },
      required: ['title'],
    },
  },
  {
    name: 'revise_card',
    description: 'Rewrite one of your open decision cards in place: pass only what changes. The card keeps its id, its number and its place with the human. Use it when a question back showed the card was unclear, when your work changed the options, or to fold a new point into a question you already have open instead of filing another. Same brevity as create_decision, and the same rule for questions about looks: they carry a picture per option or a link to a page to try. Every rewording is a new version of the same card; the earlier versions stay visible to the human, and after a hand-back the revision is what presents the card again. Decided cards cannot be revised.',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string' },
        title: { type: 'string', description: 'The question, one line' },
        ...QUESTION_PROPS,
        note: { type: 'string', description: 'One short line telling the human what changed, shown in the conversation; without it the new title is shown' },
      },
      required: ['card_id'],
    },
  },
  {
    name: 'merge_cards',
    description: 'Replace several of your open decision cards by one new card, in one step: the old cards leave the stack with a pointer to the new one, and the new card says what it replaces. Use it on your own initiative when several of your open questions are really one subject, typically with multiple: true and one option per former question ("tick what you agree to", your advice as a recommended list). Same fields and brevity as create_decision; answers to the old cards will no longer arrive; attachments of the old cards are not carried over, so a question about looks needs its pictures again. Returns the new card id.',
    inputSchema: {
      type: 'object',
      properties: {
        card_ids: { type: 'array', minItems: 2, items: { type: 'string' }, description: 'The open cards this one replaces, at least two' },
        title: { type: 'string', description: 'The one question, one line' },
        ...QUESTION_PROPS,
      },
      required: ['card_ids', 'title'],
    },
  },
  {
    name: 'set_urgency',
    description: 'Change the urgency of an open decision card, which moves it in the stack. Use it when a card starts or stops blocking you.',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string' },
        urgency: { type: 'string', enum: URGENCIES },
        reason: { type: 'string', description: 'Why the urgency changed, one short phrase shown to the human' },
      },
      required: ['card_id', 'urgency'],
    },
  },
  {
    name: 'withdraw_card',
    description: 'Take an open decision card off the stack because the question became moot. Decided cards cannot be withdrawn; finish those with close_card.',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string' },
        reason: { type: 'string', description: 'One line on why the answer is no longer needed' },
      },
      required: ['card_id'],
    },
  },
  {
    name: 'close_card',
    description: 'Move a decided card to Done once you have acted on the choice.',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string' },
        summary: { type: 'string', description: 'One line on what you did' },
      },
      required: ['card_id'],
    },
  },
  {
    name: 'set_status',
    description: 'Create or update one line of the status strip the human sees at the top of the board: one line per work stream or subagent. Call it whenever a stream starts, gets blocked on the human, or finishes.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Stable identifier of the work stream, e.g. "server" or "tests"' },
        label: { type: 'string', description: 'Short name the human sees, two or three words' },
        state: { type: 'string', enum: STATUSES, description: 'decision = red, waiting on the human; working = yellow, in progress; done = green, finished' },
        detail: { type: 'string', description: 'One line on where it stands' },
        card_id: { type: 'string', description: 'For state "decision": the card that holds the question. The line turns yellow by itself once the human answers it.' },
      },
      required: ['id', 'state'],
    },
  },
  {
    name: 'clear_status',
    description: 'Remove one line from the status strip, or all lines when no id is given (e.g. when a new piece of work starts).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
  },
  {
    name: 'introduce',
    description: 'Tell the board who you are. Call it once when the session starts, and again when your task changes; the human sees it on the agents overview. Pass icon: the drawing that fits your task, so the human knows your session by its symbol.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'The model you are running as, e.g. "Claude Opus 5.5"' },
        task: { type: 'string', description: 'What you are working on in this session, one line' },
        icon: { type: 'string', description: 'The name of the drawing that fits your task; it becomes the symbol of your session. A symbol the human picked by hand is kept.' },
      },
      required: ['model'],
    },
  },
  {
    name: 'create_voiceover',
    description: 'Turn text into spoken audio (MP3) with a natural voice, e.g. narration for a video you render or a spoken summary for the human. Returns the absolute path of the MP3; attach it to a reply to let the human hear it, or mux it into a video with ffmpeg.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What to say, up to about 4000 characters; split longer narration into several calls' },
        style: { type: 'string', description: 'Optional delivery instruction in plain words, e.g. "calm documentary narrator" or "upbeat and fast"' },
      },
      required: ['text'],
    },
  },
  {
    name: 'list_cards',
    description: 'List all your cards with number, status, urgency, chosen option, and queue_position (1 = the card the human sees now, null = not open); every card with its version (1 when first filed, one more with each rewording), a decided one with answered_version, the version the answer was given to, and one the human handed back with with_agent; open cards come with body, options and, when they were filed as one structured text, sections (pass them back changed to revise_card). Call it before filing a question, to see what you already have open on the subject.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'publish_asset',
    description: 'Publish a page or a file under a link that opens without a board login, e.g. a report or mockup as an HTML page for the human to pass on. The asset is encrypted here with a key of its own; the key is the part of the link after the #, and the board stores only ciphertext. Anyone who has the link can open it. Returns the link.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file to publish. Give this or content.' },
        content: { type: 'string', description: 'The asset itself as a string, e.g. the HTML of a page. Give this or path.' },
        type: { type: 'string', enum: ASSET_TYPES, description: 'How the viewer shows it. html: a page in a sandboxed frame, which must be self-contained (inline CSS and scripts, data: images), because nothing is loaded from the network; image, video, audio: shown or played; file: offered as a download. Left out: inferred from the file extension, html for content.' },
        title: { type: 'string', description: 'Shown above the asset and on the board; defaults to the file name' },
        note: { type: 'string', description: 'Optional line shown with the link on the board, e.g. what the page is for' },
        silent: { type: 'boolean', description: 'true: do not show the asset on the board. The hub then never sees the key or the title; the returned link is the only copy.' },
        keep: { type: 'boolean', description: `true: keep until revoked. Default: deleted after ${RETENTION_DAYS} days.` },
      },
    },
  },
  {
    name: 'list_assets',
    description: 'List the assets you published: id, type, title, size, when each expires, and the link for those shown on the board.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'revoke_asset',
    description: 'End a published asset: the stored ciphertext is deleted and the link stops working for everyone.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The asset id returned by publish_asset' } }, required: ['id'] },
  },
]

// One call per tool that does something sensible, for the help page. The test checks each against its schema.
const TOOL_EXAMPLES = {
  reply: {
    text: 'Three ways to run the migration. **Tonight at 2** is the cheapest: 40 seconds of lock while hardly anyone is online.',
    html: '<table><thead><tr><th>Way</th><th>Lock</th><th>Work for me</th></tr></thead><tbody><tr><td>Now</td><td>40 s</td><td>none</td></tr><tr><td><mark>Tonight at 2</mark></td><td>40 s</td><td>none</td></tr><tr><td>In batches</td><td>0 s</td><td>2 h</td></tr></tbody></table>',
    details: 'Ran `npm test`: 48 of 48 pass.\nThe slow one was the index on `orders`.', attachments: ['/home/me/project/out/before-after.png'],
  },
  create_decision: {
    title: 'Run the migration on production now?', body: 'It locks `orders` for about 40 seconds.', urgency: 'high', urgency_reason: 'the deploy waits on it', recommended: 'tonight',
    options: [{ key: 'tonight', label: 'Tonight at 2', detail: 'Hardly anyone is online' }, { key: 'now', label: 'Now', detail: 'Short outage for whoever is online' }],
  },
  create_info: {
    title: 'How the nightly migration works', attachments: [{ path: '/home/me/project/out/migration.png', page: '/home/me/project/out/migration.html', title: 'The three steps' }], urgency: 'low',
    sections: [
      { text: 'You asked why the deploy waits until 2. In short: the migration locks `orders`, and at 2 nobody is writing to it.' },
      { text: '**Order of events.** Backup at midnight, migration at 2, deploy right after. The picture shows the three steps.' },
      { text: '**If it fails,** the deploy does not start and you find a question from me in the morning.' },
    ],
  },
  revise_card: { card_id: 'a1b2c3d4', title: 'Run the migration tonight at 2?', options: [{ key: 'tonight', label: 'Tonight at 2' }, { key: 'weekend', label: 'At the weekend' }], recommended: 'tonight', note: 'Running it now is off the table: the backup takes until midnight' },
  merge_cards: {
    card_ids: ['a1b2c3d4', 'e5f6a7b8', 'c9d0e1f2'], title: 'Which parts of the storage plan do you agree to?', multiple: true, attachments: ['/home/me/project/out/sync.png'],
    sections: [
      { text: 'Three parts, each stands on its own. Tick what I may build.' },
      { key: 'sqlite', label: 'SQLite for cards', recommended: true, text: 'One file, no server to run. Cards survive a restart and can be searched.' },
      { key: 'files', label: 'Attachments as files', recommended: true, text: 'Pictures stay next to the database as plain files, so backups are a copy.' },
      { key: 'sync', label: 'Sync between hubs', picture: 'sync.png', text: 'Two machines show the same board. About two days more, and conflicts need a rule.' },
    ],
  },
  set_urgency: { card_id: 'a1b2c3d4', urgency: 'critical', reason: 'nothing else is left to do' },
  withdraw_card: { card_id: 'a1b2c3d4', reason: 'the staging run answered it' },
  close_card: { card_id: 'a1b2c3d4', summary: 'Migration ran at 02:00, 38 seconds' },
  set_status: { id: 'migration', label: 'Migration', state: 'decision', detail: 'waiting for the go-ahead', card_id: 'a1b2c3d4' },
  clear_status: { id: 'migration' },
  introduce: { model: 'Claude Opus 5.5', task: 'Prepare migration and deploy', icon: 'database' },
  create_voiceover: { text: 'The deploy went through. Two things need your answer.', style: 'calm, friendly' },
  list_cards: {},
  publish_asset: { path: '/home/me/project/out/report.html', title: 'Load test, 2 October', note: 'Charts for the three variants' },
  list_assets: {},
  revoke_asset: { id: 'q3n0XWb1kq0lYb6m3v8K2A' },
}

// Everything that travels over the channel besides tool calls, for the help page.
// to_agent: what this process sends Claude Code. from_client: what Claude Code sends this process.
const CHANNEL_EVENTS = [
  {
    direction: 'to_agent', method: 'notifications/claude/channel', kind: 'chat', when: 'The human sent a chat message.',
    content: 'the message; when the human sent only files, a sentence naming them', meta: { kind: 'chat' }, optional: { card_id: 'set when the human asks back about an open card instead of answering it; answer with reply and the same card_id', handback: '"1" when the human handed that card back to you to be reworked: revise it with revise_card, which presents it again', explain: '"1" when the human pressed "Explain" on that card', cards: 'ids of cards the human copied into this message, comma-separated, often another session\'s: each stands in full in the content (question, options, answer, notes, picture paths), so you can act on a decision you never saw', cards_json: 'the same cards as a JSON list of {id, number, title, agent, choice_label, kind, status, choices}', marks: 'how many notes and drawings the human pinned to parts of that card; they are lines of the content under "Notes pinned to the card:", and the picture of the annotated card is in image_path', files: 'absolute paths of the files and pictures the human attached, comma-separated; open them', image_path: 'the first attached picture, when there is one' },
    example: '<channel source="board" kind="chat">Please check the logs first.</channel>',
  },
  {
    direction: 'to_agent', method: 'notifications/claude/channel', kind: 'decision', when: 'The human answered a decision card.',
    content: 'the human\'s note, or a sentence naming the card and the chosen key; when the human wrote notes on single options, a blank line and "Notes on options:" follow, with one line "- Label [key], chosen: note" or "- Label [key], not chosen: note" per note, in the order of the options',
    meta: { kind: 'decision', card_id: 'the card', choice: 'key of the chosen option; of several, the first' },
    optional: { choices: 'only for a card made with multiple: true: every chosen key, comma-separated, in the order of the options', trust: '"1" when the human left the decision to you: choice is then the option you recommended, or empty if you recommended none; decide, say what you chose with reply and the card_id, and close the card', marks: 'how many notes and drawings the human pinned to parts of the card; they are lines of the content under "Notes pinned to the card:"', option_notes: 'only when the human wrote notes on single options: the keys that have one, comma-separated; the notes themselves are in the content', files: 'absolute paths of what the human attached to the note of the answer, comma-separated', image_path: 'the first attached picture, when there is one' },
    example: '<channel source="board" kind="decision" card_id="a1b2c3d4" choice="tonight">After the backup, please.</channel>',
  },
  {
    direction: 'to_agent', method: 'notifications/claude/channel', kind: 'decision_reopened', when: 'The human took an answer back; the card is open again.',
    content: 'a sentence saying which answer was taken back', meta: { kind: 'decision_reopened', card_id: 'the card', previous_choice: 'key of the answer that no longer holds' },
    optional: { previous_choices: 'only for a card made with multiple: true: every key that was chosen, comma-separated', trust: '"1" when what is taken back is the human leaving the decision to you', shredded: '"1" when the human took a card back out of the shredder; previous_choice is then empty' },
    example: '<channel source="board" kind="decision_reopened" card_id="a1b2c3d4" previous_choice="tonight">…</channel>',
  },
  {
    direction: 'to_agent', method: 'notifications/claude/channel', kind: 'shredded', when: 'The human threw a question (or an info) away unanswered.',
    content: 'a sentence saying so and what to do: do not ask again, carry on with your own judgement or drop the matter; then the human\'s note, if they wrote one', meta: { kind: 'shredded', card_id: 'the card' },
    optional: { marks: 'how many notes and drawings the human pinned to the card before throwing it away; they are lines of the content', files: 'absolute paths of the pictures that came with it, comma-separated', image_path: 'the first picture' },
    example: '<channel source="board" kind="shredded" card_id="a1b2c3d4">The human threw the question "Which font?" away unanswered. …</channel>',
  },
  {
    direction: 'to_agent', method: 'notifications/claude/channel', kind: 'handback_withdrawn', when: 'The human took back a card they had handed to you (or asked you to explain) before you reworked it.',
    content: 'a sentence saying there is no need to rework it', meta: { kind: 'handback_withdrawn', card_id: 'the card' },
    example: '<channel source="board" kind="handback_withdrawn" card_id="a1b2c3d4">The human took "Which font?" back; there is no need to rework or explain it.</channel>',
  },
  {
    direction: 'to_agent', method: 'notifications/claude/channel', kind: 'info_read', when: 'The human read an info card (create_info) and closed it. Nothing is expected of you.',
    content: 'a sentence naming the card', meta: { kind: 'info_read', card_id: 'the card' },
    example: '<channel source="board" kind="info_read" card_id="a1b2c3d4">The human read "How the nightly migration works" and closed it.</channel>',
  },
  {
    direction: 'to_agent', method: 'notifications/claude/channel', kind: 'scribble', when: 'The human drew on the canvas and pressed send.',
    content: 'the caption, or a sentence explaining the two pictures',
    meta: { kind: 'scribble', scribble_id: 'this moment of the canvas', image_path: 'PNG of what the human was looking at', canvas_path: 'PNG of the whole canvas', canvas_doc: 'the drawing as JSON' },
    example: '<channel source="board" kind="scribble" scribble_id="9f2c41d07a3e" image_path="/…/scribbles/9f2c41d07a3e.png" canvas_path="/…/scribbles/canvas-api.png" canvas_doc="/…/scribbles/canvas-api.json">This button, further left.</channel>',
  },
  {
    direction: 'to_agent', method: 'notifications/claude/channel', kind: 'pad', when: 'The human selected elements on the pad and sent them to this session.',
    content: 'the words of the selected notes and spoken notes in reading order, or a sentence pointing at the picture',
    meta: { kind: 'pad', pad: 'which pad: global', message_id: 'the message in the conversation that shows the selection', elements: 'ids of the selected elements, comma-separated', image_path: 'PNG of exactly the selection, on white' },
    example: '<channel source="board" kind="pad" pad="global" message_id="5e1f09ab" elements="0muqnb5cchmsr9cse,0muqnb7k2p1d4xw3a" image_path="/…/files/pad-9f2c41d07a3e.png">Ship the pad prototype</channel>',
  },
  {
    direction: 'to_agent', method: 'notifications/claude/channel/permission', kind: null, when: 'The human answered an approval card. Claude Code decides whether this or the terminal came first.',
    params: { request_id: 'the id from the request', behavior: 'allow or deny' },
    example: '{ "request_id": "abcde", "behavior": "allow" }',
  },
  {
    direction: 'from_client', method: 'notifications/claude/channel/permission_request', kind: null, when: 'Claude Code wants approval for a tool call. It becomes a card with Allow and Deny, always on top of the stack.',
    params: { request_id: 'echoed in the verdict', tool_name: 'e.g. Bash', description: 'what the tool does', input_preview: 'the arguments, shortened' },
    example: '{ "request_id": "abcde", "tool_name": "Bash", "description": "Run shell command", "input_preview": "{\\"command\\":\\"npm test\\"}" }',
  },
  {
    direction: 'from_client', method: 'initialize', kind: null, when: 'Once, when the MCP connection starts. The name appears as "Program" in the sessions overview.',
    params: { 'clientInfo.name': 'the program on the other end of stdio', 'clientInfo.version': 'its version' },
    example: '{ "clientInfo": { "name": "claude-code", "version": "2.1.0" } }',
  },
]

const text = t => ({ content: [{ type: 'text', text: t }] })

// The tools as they are handed out: introduce names the drawings there are to choose from right now.
function toolsNow() {
  const list = drawings()
  if (!list) return TOOLS
  return TOOLS.map(t => (t.name !== 'introduce' ? t : {
    ...t, inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, icon: { ...t.inputSchema.properties.icon, description: `${t.inputSchema.properties.icon.description} One of: ${drawingList(list)}` } } },
  }))
}
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolsNow() }))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = req.params.arguments ?? {}
  // The hub copies attachments; a relative path must mean this session's folder, not the hub's.
  const here = f => (typeof f === 'string' && f ? path.resolve(f) : f)
  // A page may also be a link or a path on the board; only what is a relative path of a file here is this folder's.
  const pageHere = p => (typeof p === 'string' && p && !/^(https?:)?\//i.test(p) && fs.existsSync(path.resolve(p)) ? path.resolve(p) : p)
  if (Array.isArray(args.attachments)) args.attachments = args.attachments.map(f => (f && typeof f === 'object' && !Array.isArray(f) ? { ...f, path: here(f.path), ...(f.page == null ? {} : { page: pageHere(f.page) }) } : here(f)))
  await whenUp()
  // The one tool that does its work here, beside the agent, before anything goes to the hub.
  if (req.params.name === 'publish_asset') return text(await publishAsset(args))
  if (role === 'hub') return text(await runTool(selfId, req.params.name, args))
  return text((await hubPost('/agent/tool', { name: req.params.name, args })).text)
})

const listArg = (value, what) => {
  if (value != null && !Array.isArray(value)) throw new Error(`${what} must be a list`)
  return value ?? []
}

// What the human reads and answers on a card. revise_card may change any of these.
const QUESTION_FIELDS = ['title', 'body', 'options', 'sections', 'text', 'multiple', 'recommended', 'urgency', 'urgency_reason', 'attachments', 'html']
const questionSig = c => JSON.stringify([c.title, c.body, c.options, c.multiple, c.recommended, c.attachments, c.sections ?? null, c.html ?? null])

// ---- a question as one structured text ------------------------------------

// The text-block form: paragraphs separated by a blank line; one that starts with [key] is an option.
//   [key] Label: explanation        [key*] or "Label (recommended):" marks the advice
//   [key] Label                     without a colon the first line is the label,
//   explanation ...                 the following lines explain
//   picture: file.png               as the last line: the attachment that belongs to the option
const FLAGGED = /^\[([\w.-]+)(\*)?\](?!\()[ \t]*/
function parseSections(text) {
  // A fenced block (an ```html layout, code) is one paragraph's own, blank lines and all.
  return fences.hide(String(text).replace(/\r\n?/g, '\n')).split(/\n[ \t]*\n/).map(p => fences.show(p).trim()).filter(Boolean).map(par => {
    const flag = FLAGGED.exec(par)
    if (!flag) return { text: par }
    let picture = null
    const rest = par.slice(flag[0].length).replace(/\n[ \t]*picture:[ \t]*(.+)$/i, (_, name) => { picture = name.trim(); return '' })
    const [first, ...lines] = rest.split('\n')
    const colon = first.search(/:(\s|$)/)
    let advised = Boolean(flag[2])
    const label = (colon < 0 ? first : first.slice(0, colon)).replace(/\s*(\*|\(recommended\))\s*$/i, () => { advised = true; return '' }).trim()
    return {
      key: flag[1], label, text: [colon < 0 ? '' : first.slice(colon + 1), ...lines].join('\n').trim(),
      ...(advised ? { recommended: true } : {}), ...(picture == null ? {} : { picture }),
    }
  })
}

// Which attachment a flagged block points at, as its position in the card's attachments.
function pictureOf(ref, names, key) {
  const at = Number.isInteger(ref) || /^\d+$/.test(String(ref)) ? Number(ref) : names.findIndex(n => n === String(ref) || n === path.basename(String(ref)))
  if (!(at >= 0 && at < names.length)) {
    throw new Error(`section "${key}" names the picture "${ref}", which is not among this card's attachments (${names.length ? names.map((n, i) => `${i}: ${n}`).join(', ') : 'it has none'}); give a file name or a position counted from 0`)
  }
  return at
}

// The blocks as they are stored: plain ones as { text }, flagged ones as { key, label, text, recommended, picture? }.
function sectionsOf(args, names) {
  if (args.sections != null && args.text != null) throw new Error('give sections or text, not both: text is the same thing written as one block')
  if (args.options != null) throw new Error(`${args.sections != null ? 'sections' : 'text'} and options cannot be combined: the flagged blocks are the options. Flag a block with key and label, or go back to body and options`)
  if (args.body != null) throw new Error(`${args.sections != null ? 'sections' : 'text'} and body cannot be combined: the blocks are the body. Put the introduction in as a first block without a key`)
  const blocks = args.sections != null ? listArg(args.sections, 'sections') : parseSections(args.text)
  return blocks.map((b, i) => {
    if (typeof b === 'string') b = { text: b }
    const said = cleanFences(String(b?.text ?? '').trim(), `section ${i + 1}`)
    // A layout of the block's own, shown under its paragraph.
    const rich = htmlBeside(b?.html, said, { field: `the html of section ${b?.key || i + 1}`, beside: 'text' })
    const layout = rich ? { html: rich } : {}
    if (b?.key == null || b.key === '') {
      if (!said) throw new Error(`section ${i + 1} is empty: a block without a key needs text`)
      return { text: said, ...layout }
    }
    const key = String(b.key)
    const label = String(b.label ?? '').trim()
    if (!label) throw new Error(`section "${key}" has a key, so it becomes an option and needs a label: the short name on its tile, at most about four words`)
    return { key, label, text: said, ...layout, recommended: b.recommended === true, ...(b.picture == null || b.picture === '' ? {} : { picture: pictureOf(b.picture, names, key) }) }
  })
}

// For pages and clients that know nothing of sections: the same text as markdown, each flagged paragraph led by its label.
const bodyOf = sections => sections.map(s => (s.key == null ? s.text : `**${s.label}**${s.text ? `: ${s.text}` : ''}`)).join('\n\n')

// In revise_card: the advice is taken away, whatever the blocks say.
const NO_ADVICE = Symbol('no advice')

// The fields of a question, checked the same way whether it is filed, revised or merged.
// names: the file names of the card's attachments, for blocks that point at one.
function questionFields(args, names = []) {
  const sections = args.sections != null || args.text != null ? sectionsOf(args, names) : null
  if (sections && args.html) throw new Error('html and sections (or text) cannot be combined: give the layout to the block it belongs to, as html on that section, or fenced as ```html inside the text')
  const body = sections ? bodyOf(sections) : cleanFences(String(args.body ?? ''), 'body')
  const html = sections ? '' : htmlBeside(args.html, body, { beside: 'body' })
  const flagged = sections?.filter(s => s.key != null)
  const options = flagged ? flagged.map(s => ({ key: s.key, label: s.label, detail: '' })) : listArg(args.options, 'options').map(o => ({
    key: String(o?.key), label: String(o?.label), detail: o?.detail ? String(o.detail) : '',
  }))
  const keys = new Set(options.map(o => o.key))
  if (options.length < 2 || keys.size !== options.length) {
    throw new Error(sections
      ? 'a question needs at least two options with unique keys: flag at least two blocks with key and label (in text: paragraphs starting with [key] Label:)'
      : 'options need at least two entries with unique keys')
  }
  const urgency = urgencyArg(args.urgency, 'normal')
  const multiple = args.multiple === true
  // Said outright it holds; otherwise the blocks marked as advice are it.
  const marked = flagged?.filter(s => s.recommended).map(s => s.key) ?? []
  const given = args.recommended === NO_ADVICE ? null : args.recommended ?? (!marked.length ? null : multiple || marked.length > 1 ? marked : marked[0])
  // One key, or for a card that takes several answers a list of them; stored the way it was given.
  const advised = given == null ? [] : [given].flat().map(String)
  const stray = advised.find(key => !keys.has(key))
  if (stray != null) throw new Error(`recommended must be the key of one of the options; got "${stray}"`)
  if (Array.isArray(given) && !multiple) throw new Error('recommended as a list needs multiple: true; a card with one answer has one recommendation')
  return {
    multiple, recommended: Array.isArray(given) ? advised : advised[0] ?? null,
    urgency, urgency_reason: String(args.urgency_reason ?? '').trim(),
    title: String(args.title ?? ''), body, ...(html ? { html } : {}), options,
    // The mark on each block says the same as recommended, whichever of the two was given.
    ...(sections ? { sections: sections.map(s => (s.key == null ? s : { ...s, recommended: advised.includes(s.key) })) } : {}),
  }
}
// Something to read: the words of a question without anything to choose.
function infoFields(args, names = []) {
  for (const key of ['options', 'multiple', 'recommended']) {
    if (args[key] != null) throw new Error(`an info has no ${key}: it asks nothing, the human reads it and closes it. Something to choose is a question: create_decision`)
  }
  const sections = args.sections != null || args.text != null ? sectionsOf(args, names) : null
  const flagged = sections?.find(s => s.key != null)
  if (flagged) throw new Error(`an info has no options, so no block may have a key (got "${flagged.key}"). Something to choose is a question: create_decision`)
  if (sections && args.html) throw new Error('html and sections (or text) cannot be combined: give the layout to the block it belongs to, as html on that section, or fenced as ```html inside the text')
  const body = sections ? bodyOf(sections) : cleanFences(String(args.body ?? ''), 'body')
  const html = sections ? '' : htmlBeside(args.html, body, { beside: 'body' })
  if (!String(args.title ?? '').trim()) throw new Error('an info needs a title')
  if (!body.trim() && !html) throw new Error('an info needs something to read: body, sections or text')
  return {
    multiple: false, recommended: null, options: [], urgency: urgencyArg(args.urgency, 'normal'), urgency_reason: String(args.urgency_reason ?? '').trim(),
    title: String(args.title), body, ...(html ? { html } : {}), ...(sections ? { sections } : {}),
  }
}
const namesOf = args => listArg(args.attachments, 'attachments').map(f => path.basename(String(f?.path ?? f)))

const openQuestions = agent => state.cards.filter(c => c.agent === agent && c.kind === 'decision' && c.status === 'open')
const placeOf = card => `position ${state.queue.indexOf(card.id) + 1} of ${state.queue.length} in the stack`

// From this many open questions of one session on, filing another comes with a reminder to bundle.
const CROWD = 3
const crowdHint = (others, card) => (others.length < CROWD ? '' : [
  `\nYou now have ${others.length + 1} open questions. If some of them are one subject, replace them by one with merge_cards (multiple: true, one option per former question), or fold this one into another with revise_card and withdraw it. Open:`,
  ...[...others, card].map(c => `Nr. ${c.number} (${c.id}, ${c.urgency}): ${c.title.replace(/\s+/g, ' ').slice(0, 100)}`),
].join('\n'))

// A card is read on a phone, between other things. Past these lengths the agent is told, not refused.
const BODY_MAX = 300
const DETAIL_MAX = 60
const SECTION_MAX = 400
// What there is to read in a text: a fenced layout or code block is looked at, not read.
const prose = text => String(text ?? '').replace(/```[\s\S]*?```/g, '')
function lengthHint(card) {
  const long = card.options.filter(o => o.detail.length > DETAIL_MAX)
  // A sectioned card is read block by block, so each block has its own measure and the body, which is all of them, has none.
  const wordy = (card.sections ?? []).map((s, i) => (prose(s.text).length > SECTION_MAX ? `${s.key == null ? `block ${i + 1}` : `"${s.key}"`} (${prose(s.text).length})` : '')).filter(Boolean)
  const said = [
    wordy.length ? `the section text of ${wordy.join(', ')} is longer than about ${SECTION_MAX} characters (aim for two or three sentences per block)` : '',
    !card.sections && prose(card.body).length > BODY_MAX ? `the body has ${prose(card.body).length} characters (aim for one or two short sentences)` : '',
    long.length ? `the detail of ${long.map(o => `"${o.key}"`).join(', ')} is longer than one short line (aim for about six words)` : '',
  ].filter(Boolean)
  return said.length ? `\nThis is a lot to read: ${said.join('; ')}. Shorten it with revise_card and put the longer explanation behind a link or in an attachment; the human can ask for it with "Explain".` : ''
}

// A question about looks is judged by looking. One that reads like it and shows nothing is answered with a reminder, not refused.
const VISUAL = /\b(ui|ux|design|layout|looks?|appearance|colou?rs?|buttons?|icons?|sidebar|toolbar|mock-?ups?|variants?|fonts?|typography|logos?|themes?|spacing|animation|farben?|schrift(art)?|aussehen|gestaltung|varianten?|entw[uü]rfe?|seitenleiste|symbole?)\b/i
// A link or a path in backticks may be the page to try.
const SHOWN = /https?:\/\/|`[^`]*\/[^`]*`/
const visualHint = card => (card.attachments.length || card.html || card.sections?.some(s => s.html) || /```html/i.test(card.body) || SHOWN.test(card.body) || !VISUAL.test(`${card.title} ${card.body} ${card.options.map(o => o.label).join(' ')}`) ? ''
  : '\nThis reads like a question about how something looks, and it shows nothing. Add a picture with revise_card: a screenshot, mockup or drawing per option where possible, each named <anything>-<key>.png so it shows with its option, or link a page to try (publish_asset). Words alone are hard to judge.')

// Runs on the hub, for the hub's own agent and on behalf of spokes.
function runTool(agent, name, args) {
  if (!args || typeof args !== 'object') args = {}
  strippedHint()   // what an earlier, refused call lost is not this call's news
  paired = []
  switch (name) {
    case 'reply': {
      const about = args.card_id == null ? {} : { card_id: findCard(agent, args.card_id).id }
      // The agent answered the question back, so the card is with the human again.
      if (about.card_id) delete findCard(agent, about.card_id).with_agent
      const text = cleanFences(String(args.text ?? ''), 'text')
      const html = htmlBeside(args.html, text)
      addMessage(agent, 'agent', text, listArg(args.attachments, 'attachments').map(storeAttachment), { ...(html ? { html } : {}), ...(args.details ? { details: cleanFences(String(args.details), 'details') } : {}), ...about })
      return `sent${strippedHint()}${pairedHint()}`
    }
    case 'create_decision': {
      const fields = questionFields(args, namesOf(args))
      const others = openQuestions(agent)
      const card = addCard(agent, 'decision', { ...fields, attachments: listArg(args.attachments, 'attachments').map(storeAttachment) })
      addEvent('asked', card, card.title)
      commit()
      return `card ${card.id} created as Nr. ${card.number}, ${placeOf(card)}; the choice will arrive as a channel event${crowdHint(others, card)}${lengthHint(card)}${visualHint(card)}${strippedHint()}${pairedHint()}`
    }
    case 'create_info': {
      const fields = infoFields(args, namesOf(args))
      const card = addCard(agent, 'info', { ...fields, attachments: listArg(args.attachments, 'attachments').map(storeAttachment) })
      addEvent('info', card, card.title)
      commit()
      return `info ${card.id} put on the board as Nr. ${card.number}, ${placeOf(card)}; when the human has read and closed it, info_read arrives, which needs no answer${strippedHint()}${pairedHint()}`
    }
    case 'revise_card': {
      const card = findCard(agent, args.card_id)
      if (card.kind === 'permission') throw new Error('permission cards cannot be revised')
      if (card.status === 'decided') {
        throw new Error(`card ${card.id} was already decided (choice: ${card.choice}); the human answered the question as it stood, so act on that answer, or call close_card and ask anew with create_decision`)
      }
      if (card.status !== 'open') throw new Error(`card ${card.id} is already done`)
      const given = QUESTION_FIELDS.filter(key => args[key] != null)
      if (!given.length) throw new Error(`nothing to revise: pass at least one of ${QUESTION_FIELDS.join(', ')}`)
      const options = args.options == null ? card.options : listArg(args.options, 'options')
      const multiple = args.multiple ?? card.multiple
      // Advice that was not restated holds as far as it still fits the options and the kind of card.
      const kept = [card.recommended ?? []].flat().filter(key => options.some(o => String(o?.key) === key))
      const urgency = args.urgency ?? card.urgency
      // New blocks replace body and options; a new body or new options make it a plain card again; otherwise its blocks stand.
      const resection = args.sections != null || args.text != null
      const plain = args.body != null || args.options != null
      const wording = resection ? { sections: args.sections, text: args.text, body: args.body, options: args.options }
        : card.sections && !plain ? { sections: card.sections }
        : { body: args.body ?? card.body, options }
      const info = card.kind === 'info'
      const fields = (info ? infoFields : questionFields)({
        title: args.title ?? card.title, ...wording, ...(info ? { options: args.options, multiple: args.multiple } : { multiple }), urgency,
        // A layout stands until it is replaced; '' takes it away, and new blocks carry their own.
        html: resection ? args.html : args.html ?? card.html,
        // As with set_urgency: a new level without a reason has none.
        urgency_reason: args.urgency_reason ?? (urgency === card.urgency ? card.urgency_reason : ''),
        // New blocks carry their own marks, unless the call says otherwise.
        recommended: info ? args.recommended : args.recommended != null ? (args.recommended.length ? args.recommended : NO_ADVICE)
          : resection ? undefined : multiple && Array.isArray(card.recommended) ? kept : kept[0] ?? NO_ADVICE,
      }, args.attachments == null ? card.attachments.map(a => a.name) : namesOf(args))
      const attachments = args.attachments == null ? card.attachments : listArg(args.attachments, 'attachments').map(storeAttachment)
      const stood = questionSig(card)
      const level = card.urgency
      // The version this call may replace, as the human saw it.
      const was = {
        n: card.version ?? (card.revisions ?? 0) + 1, at: card.revised ?? card.created, title: card.title, body: card.body, options: card.options,
        ...(card.sections ? { sections: card.sections } : {}), ...(card.html ? { html: card.html } : {}), recommended: card.recommended ?? null, multiple: card.multiple,
        attachments: card.attachments, urgency: level, note: card.revision_note ?? '',
      }
      const again = card.with_agent != null
      delete card.with_agent
      const unsectioned = Boolean(card.sections && !fields.sections)
      if (unsectioned) delete card.sections
      if (!fields.html) delete card.html
      Object.assign(card, fields, { attachments })
      trimDraft(card)
      // Only a change to what the human reads is a revision; a mere change of urgency is what set_urgency does.
      const reworded = questionSig(card) !== stood
      if (reworded) {
        card.revised = Date.now()
        card.revisions = (card.revisions ?? 0) + 1
        card.version = was.n + 1
        card.revision_note = String(args.note ?? '').trim()
        card.versions = [...(card.versions ?? []), was]
        // The oldest go first; a file only they showed goes with them.
        for (const gone of card.versions.splice(0, Math.max(0, card.versions.length - VERSIONS_MAX))) {
          const kept = new Set([card, ...card.versions].flatMap(v => v.attachments).flatMap(filesOfAttachment))
          for (const name of gone.attachments.flatMap(filesOfAttachment)) if (!kept.has(name)) fs.rmSync(path.join(FILES, name), { force: true })
        }
        // After a hand-back the rewording is what puts the card in front of the human again.
        addEvent('revised', card, `${again ? 'Presented again: ' : ''}${card.revision_note || card.title}`)
        Object.assign(state.messages.at(-1), { version: card.version, ...(again ? { again: true } : {}) })
      }
      if (card.urgency !== level) addEvent('urgency', card, card.urgency_reason ? `${URGENCY_LABEL[card.urgency]}: ${card.urgency_reason}` : URGENCY_LABEL[card.urgency])
      commit()
      return `card ${card.id} ${reworded ? 'revised' : 'unchanged in wording'}, still Nr. ${card.number}, ${placeOf(card)}${unsectioned ? '; it is a plain card now: body and options replaced its sections, so its paragraphs are no longer tied to its options' : ''}${info ? '' : lengthHint(card) + visualHint(card)}${strippedHint()}${pairedHint()}`
    }
    case 'merge_cards': {
      // Checked below for each card: only questions merge.
      const ids = [...new Set(listArg(args.card_ids, 'card_ids').map(String))]
      if (ids.length < 2) throw new Error('merge_cards replaces at least two cards; to change one card use revise_card')
      // Everything is checked before anything changes, so a refused merge leaves every card as it was.
      const old = ids.map(id => findCard(agent, id))
      for (const c of old) {
        if (c.kind === 'permission') throw new Error('permission cards cannot be merged')
        if (c.kind === 'info') throw new Error(`card ${c.id} is an info, not a question; infos are not merged. Rework it with revise_card or take it away with withdraw_card`)
        if (c.status === 'decided') throw new Error(`card ${c.id} was already decided (choice: ${c.choice}); the human spent an answer on it, so act on it and merge only the open ones`)
        if (c.status !== 'open') throw new Error(`card ${c.id} is already done`)
      }
      // The merged question is as pressing as the most pressing one it replaces, unless said otherwise.
      const top = old.reduce((a, b) => (URGENCIES.indexOf(b.urgency) > URGENCIES.indexOf(a.urgency) ? b : a))
      const fields = questionFields({ ...args, urgency: args.urgency ?? top.urgency, urgency_reason: args.urgency_reason ?? (args.urgency == null ? top.urgency_reason : '') }, namesOf(args))
      const card = addCard(agent, 'decision', {
        ...fields, attachments: listArg(args.attachments, 'attachments').map(storeAttachment),
        // The human has been waiting since the oldest of them, and the new card takes that place in the stack.
        created: Math.min(...old.map(c => c.created)),
        merged_from: old.map(c => ({ id: c.id, number: c.number, title: c.title })),
      })
      addEvent('asked', card, card.title)
      for (const c of old) {
        c.status = 'done'
        delete c.draft
        delete c.with_agent
        c.merged_into = card.id
        c.summary = `Merged into Nr. ${card.number}: ${card.title}`
        addEvent('done', c, c.summary)
      }
      // A status line that waited on one of the old cards now waits on the new one.
      for (const t of state.tasks) if (t.agent === agent && ids.includes(t.card_id)) t.card_id = card.id
      commit()
      return `card ${card.id} created as Nr. ${card.number}, replacing Nr. ${old.map(c => c.number).join(', ')}, ${placeOf(card)}; answers to the replaced cards will no longer arrive, the choice on this one will arrive as a channel event${lengthHint(card)}${visualHint(card)}${strippedHint()}${pairedHint()}`
    }
    case 'set_urgency': {
      const card = findCard(agent, args.card_id)
      const urgency = urgencyArg(args.urgency)
      if (card.kind === 'permission') throw new Error('permission cards are always critical')
      if (card.status !== 'open') throw new Error(`card ${card.id} is ${card.status}; urgency only applies to open cards`)
      const reason = String(args.reason ?? '').trim()
      const changed = card.urgency !== urgency
      card.urgency = urgency
      card.urgency_reason = reason
      // Only a new level is news for the timeline; a reworded reason just updates the card.
      if (changed) addEvent('urgency', card, reason ? `${URGENCY_LABEL[urgency]}: ${reason}` : URGENCY_LABEL[urgency])
      commit()
      return `urgency ${changed ? 'set to' : 'already'} ${urgency}; card is now position ${state.queue.indexOf(card.id) + 1} of ${state.queue.length} in the stack`
    }
    case 'withdraw_card': {
      const card = findCard(agent, args.card_id)
      // Claude Code is waiting on a verdict for these; only the human can give it.
      if (card.kind === 'permission') throw new Error('permission cards cannot be withdrawn')
      if (card.status === 'decided') {
        throw new Error(`card ${card.id} was already decided (choice: ${card.choice}); the human spent an answer on it, so act on it or call close_card with a summary of why it no longer applies`)
      }
      if (card.status !== 'open') throw new Error(`card ${card.id} is already done`)
      card.status = 'done'
      delete card.draft
      delete card.with_agent
      card.summary = String(args.reason ?? '').trim()
      addEvent('done', card, card.summary ? `Withdrawn: ${card.summary}` : 'Withdrawn')
      commit()
      return 'withdrawn'
    }
    case 'close_card': {
      const card = findCard(agent, args.card_id)
      // Same reason as in withdraw_card: Claude Code is waiting for the human's verdict.
      if (card.kind === 'permission' && card.status === 'open') throw new Error('an open permission card cannot be closed; only the human answers it')
      card.status = 'done'
      delete card.draft
      delete card.with_agent
      card.summary = String(args.summary ?? '')
      addEvent('done', card, card.summary || card.title)
      commit()
      return 'closed'
    }
    case 'set_status': {
      const id = String(args.id ?? '').trim()
      if (!id) throw new Error('id is required')
      if (!STATUSES.includes(args.state)) throw new Error(`state must be one of ${STATUSES.join(', ')}; got "${args.state}"`)
      let task = state.tasks.find(t => t.agent === agent && t.id === id)
      // Checked before anything changes, so a refused call leaves no half-made line behind.
      if (args.card_id) findCard(agent, args.card_id)
      if (!task) {
        if (!args.label) throw new Error(`label is required for the new status line "${id}"`)
        task = { agent, id, label: '', state: 'working', detail: '', card_id: null, updated: 0 }
        state.tasks.push(task)
      }
      if (args.label) task.label = String(args.label)
      if (args.detail != null) task.detail = String(args.detail)
      task.state = args.state
      task.card_id = args.state === 'decision' ? args.card_id ?? task.card_id : null
      task.updated = Date.now()
      commit()
      return `status "${id}" is ${args.state}`
    }
    case 'clear_status':
      state.tasks = state.tasks.filter(t => t.agent !== agent || (args.id && t.id !== args.id))
      commit()
      return 'cleared'
    case 'introduce': {
      // Checked first, so a refused symbol leaves the rest as it was.
      const symbol = setIcon(agent, args.icon)
      setProfile(agent, { model: args.model, task: args.task })
      return `noted${symbol}`
    }
    case 'create_voiceover':
      return speak(args.text, String(args.style ?? '')).then(file => `voiceover written to ${file}`)
    case 'list_cards':
      return JSON.stringify(state.cards.filter(c => c.agent === agent).map(c => ({
        id: c.id, number: c.number, kind: c.kind, status: c.status,
        urgency: c.urgency, urgency_reason: c.urgency_reason,
        queue_position: state.queue.indexOf(c.id) + 1 || null,
        title: c.title, ...(c.trusted ? { trusted: true } : {}), ...(c.status === 'shredded' ? { shredded: c.shredded } : {}), version: c.version ?? (c.revisions ?? 0) + 1, ...(c.answered_version ? { answered_version: c.answered_version } : {}), ...(c.with_agent ? { with_agent: c.with_agent } : {}),
        multiple: c.multiple, choice: c.choice, choices: c.choices, note: c.note,
        ...(c.status === 'open' && c.kind !== 'permission' ? { body: c.body, ...(c.html ? { html: c.html } : {}), options: c.options, recommended: c.recommended ?? null, ...(c.sections ? { sections: c.sections } : {}) } : {}),
        ...(c.revised ? { revised: c.revised } : {}),
        ...(c.merged_from ? { merged_from: c.merged_from.map(m => m.number) } : {}),
        ...(c.merged_into ? { merged_into: c.merged_into } : {}),
      })), null, 2)
    case 'list_assets':
      return JSON.stringify(listAssets(agent), null, 2)
    case 'revoke_asset': {
      const asset = state.assets.find(a => a.id === args.id && a.agent === agent)
      if (!asset) throw new Error(`no asset ${args.id}`)
      dropAssets([asset], 'withdrawn')
      commit()
      return 'revoked: the stored asset is deleted and its link no longer opens'
    }
    case 'publish_asset':
      throw new Error('publish_asset encrypts in the process beside the agent; this server.mjs is older than the hub, restart the session')
  }
  throw new Error(`unknown tool: ${name}`)
}

// Tool approvals show up as cards too, answered with the same buttons.
mcp.setNotificationHandler(
  z.object({
    method: z.literal('notifications/claude/channel/permission_request'),
    params: z.object({
      request_id: z.string(), tool_name: z.string(), description: z.string(), input_preview: z.string(),
    }),
  }),
  async ({ params }) => {
    // Claude Code asks only once. If the hub is changing hands right now, try
    // again rather than lose the card.
    for (let attempt = 1; ; attempt++) {
      try {
        await whenUp()
        if (role === 'hub') return addPermission(selfId, params)
        return await hubPost('/agent/permission', { params }, Math.min(HUB_TIMEOUT, 10000))
      } catch (err) {
        if (attempt === 5) return console.error(`[board] approval request not relayed: ${err.message}`)
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    }
  },
)

function addPermission(agent, params) {
  // A spoke repeats a request it got no answer for; that must not make a second card.
  if (state.cards.some(c => c.agent === agent && c.kind === 'permission' && c.status === 'open' && c.request_id === params.request_id)) return
  addCard(agent, 'permission', {
    request_id: params.request_id,
    title: `Approval: ${params.tool_name}`,
    body: `${params.description}\n\n${params.input_preview}`,
    options: [
      { key: 'allow', label: 'Allow', detail: '' },
      { key: 'deny', label: 'Deny', detail: '' },
    ],
  })
  commit()
}

// The human drags a session to a new place in the sidebar: directly before another one, or to the end.
// Sessions that share a group stay together: the whole group moves, and it lands before a group, never inside one;
// only a move before a member of the session's own group reorders within it.
function moveSession(agent, before) {
  const target = before == null ? null : state.agents.find(a => a.id === String(before))
  if (before != null && !target) throw new Error(`no session ${before}`)
  if (target === agent) return
  const within = Boolean(target && agent.group && target.group === agent.group)
  const moved = within || !agent.group ? [agent] : state.agents.filter(a => a.group === agent.group)
  const rest = state.agents.filter(a => !moved.includes(a))
  const anchor = !target ? null : within || !target.group ? target : rest.find(a => a.group === target.group)
  const at = anchor ? rest.indexOf(anchor) : rest.length
  state.agents = [...rest.slice(0, at), ...moved, ...rest.slice(at)]
}

const STALE_ANSWER = 'the agent revised this question while you were answering; nothing was sent, read it again and answer once more'
// How long after a rewrite an answer cannot have been meant for the new wording.
const REVISE_GRACE = Number(process.env.BOARD_REVISE_GRACE_MS) || 1500

// What the human wrote on single options, chosen or not: { key: text } in the order of the options.
// strict: a key the card does not have is refused (an answer); otherwise it is dropped (a draft, which may be older than a revision).
const NOTE_MAX = 2000
// How many earlier versions of a card are kept; the live card is one more.
const VERSIONS_MAX = 20
function optionNotes(card, notes, strict) {
  if (notes == null) return {}
  if (typeof notes !== 'object' || Array.isArray(notes)) throw new Error('notes must be an object: { "<option key>": "text" }')
  const stray = Object.keys(notes).find(k => !card.options.some(o => o.key === k))
  if (stray != null && strict) throw card.revised ? fail(409, STALE_ANSWER) : new Error(`notes names an unknown option: "${stray}"`)
  const out = {}
  for (const o of card.options) {
    const said = typeof notes[o.key] === 'string' ? notes[o.key].trim() : ''
    if (said.length > NOTE_MAX) throw new Error(`the note on "${o.label}" is longer than ${NOTE_MAX} characters`)
    if (said) out[o.key] = said
  }
  return out
}

// Notes and drawings the human pinned to places on a card:
// [{ id, anchor: { kind: 'card' | 'option' | 'section' | 'picture' | 'text', key?, index?, x?, y?, quote? }, text?, strokes? }].
// strict: a mark on something the card does not have is refused (an answer); otherwise it is dropped (a draft, a rewrite).
const MARKS_MAX = 200
const MARK_BYTES = 64 * 1024
const MARKS_BYTES = 1024 * 1024
const MARK_KINDS = ['card', 'option', 'section', 'picture', 'text']
function marksOf(card, marks, strict) {
  if (marks == null) return []
  if (!Array.isArray(marks)) throw new Error('marks must be a list')
  if (marks.length > MARKS_MAX) throw new Error(`at most ${MARKS_MAX} marks on one card; got ${marks.length}`)
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const out = []
  for (const [i, m] of marks.entries()) {
    const a = m?.anchor
    if (!a || !MARK_KINDS.includes(a.kind)) throw new Error(`mark ${i + 1} needs an anchor with kind ${MARK_KINDS.join(', ')}`)
    const key = a.key == null ? undefined : String(a.key)
    const index = Number.isInteger(a.index) && a.index >= 0 ? a.index : undefined
    const gone = (a.kind === 'option' && !card.options.some(o => o.key === key))
      || (a.kind === 'section' && !(index < (card.sections?.length ?? 0)))
      || (strict && a.kind === 'picture' && index != null && !(index < card.attachments.length))
    if (gone) {
      if (!strict) continue
      throw card.revised ? fail(409, STALE_ANSWER) : new Error(`mark ${i + 1} points at ${a.kind === 'option' ? `the option "${key}"` : `${a.kind} ${a.index}`}, which this card does not have`)
    }
    const text = typeof m.text === 'string' ? m.text.trim() : ''
    if (text.length > NOTE_MAX) throw new Error(`the text of mark ${i + 1} is longer than ${NOTE_MAX} characters`)
    if (m.strokes != null && !Array.isArray(m.strokes)) throw new Error(`the strokes of mark ${i + 1} must be a list`)
    const strokes = m.strokes?.length ? m.strokes : undefined
    if (!text && !strokes) continue
    const mark = {
      id: String(m.id ?? newId()).slice(0, 40),
      anchor: { kind: a.kind, ...(key === undefined ? {} : { key }), ...(index === undefined ? {} : { index }), ...(num(a.x) === undefined ? {} : { x: a.x }), ...(num(a.y) === undefined ? {} : { y: a.y }), ...(typeof a.quote === 'string' && a.quote ? { quote: a.quote.slice(0, 500) } : {}) },
      ...(text ? { text } : {}), ...(strokes ? { strokes } : {}),
    }
    if (JSON.stringify(mark).length > MARK_BYTES) throw new Error(`mark ${i + 1} is larger than ${MARK_BYTES / 1024} KB; draw less in one mark`)
    out.push(mark)
  }
  if (JSON.stringify(out).length > MARKS_BYTES) throw new Error(`the marks together are larger than ${MARKS_BYTES / 1024 / 1024} MB`)
  return out
}

// The marks as the agent reads them: one line each, saying what it is pinned to.
function markLines(card, marks) {
  return marks.map(m => {
    const a = m.anchor
    const option = a.key == null ? null : card.options.find(o => o.key === a.key)
    const section = a.kind === 'section' ? card.sections?.[a.index] : null
    const where = a.kind === 'option' ? `on option "${option?.label ?? a.key}" [${a.key}]`
      : a.kind === 'section' ? (section?.key ? `on option "${section.label}" [${section.key}]` : `on the paragraph "${brief(section?.text ?? '', 50)}"`)
      : a.kind === 'picture' ? `on the picture ${card.attachments[a.index]?.name ?? (a.index ?? 0) + 1}`
      : a.kind === 'text' ? `on the text "${brief(a.quote ?? '', 80)}"`
      : 'general'
    const drawn = m.strokes ? (m.text ? ' (also drawn; see the picture)' : '(drawn; see the picture)') : ''
    return `- ${where}: ${(m.text ?? '').replace(/\s*\n\s*/g, ' ')}${drawn}`
  })
}
const marksBlock = (card, marks) => (marks.length ? ['', 'Notes pinned to the card:', ...markLines(card, marks)] : [])
const marksCount = marks => `${marks.length} ${marks.length === 1 ? 'note' : 'notes'}`

// What the human ticked and wrote but has not sent. Kept on the open card so that every page shows it; the agent never sees it.
function setDraft(cardId, body) {
  const card = state.cards.find(c => c.id === cardId)
  if (!card) throw new Error('unknown card')
  if (card.kind !== 'decision') throw new Error('only decisions keep a draft')
  if (card.status !== 'open') throw fail(409, 'card already decided')
  if (body.keys != null && !Array.isArray(body.keys)) throw new Error('keys must be a list')
  const ticked = new Set((body.keys ?? []).map(String))
  const note = String(body.note ?? '')
  if (note.length > NOTE_MAX * 5) throw new Error(`the note is longer than ${NOTE_MAX * 5} characters`)
  const marks = marksOf(card, body.marks, false)
  const draft = { keys: card.options.filter(o => ticked.has(o.key)).map(o => o.key), note, notes: optionNotes(card, body.notes, false), ...(marks.length ? { marks } : {}) }
  const empty = !draft.keys.length && !note.trim() && !Object.keys(draft.notes).length && !marks.length
  const same = d => JSON.stringify([d?.keys ?? [], d?.note ?? '', d?.notes ?? {}, d?.marks ?? []])
  if (same(empty ? null : draft) === same(card.draft)) return
  if (empty) delete card.draft
  else card.draft = { ...draft, ts: Date.now() }
  commit(true)
}

// After a rewrite: what the draft says about options that no longer exist goes.
function trimDraft(card) {
  if (!card.draft) return
  const has = key => card.options.some(o => o.key === key)
  const keys = card.draft.keys.filter(has)
  const notes = Object.fromEntries(Object.entries(card.draft.notes).filter(([key]) => has(key)))
  // Marks on options or paragraphs that are gone go too; those on the card, its text or its pictures stay.
  const marks = marksOf(card, card.draft.marks, false)
  if (!keys.length && !card.draft.note.trim() && !Object.keys(notes).length && !marks.length) delete card.draft
  else {
    Object.assign(card.draft, { keys, notes, marks })
    if (!marks.length) delete card.draft.marks
  }
}

const brief = (said, max = 80) => { const line = said.replace(/\s+/g, ' '); return line.length > max ? `${line.slice(0, max - 1)}…` : line }

// answer is one key, or for a card that takes several a list of keys.
// seen is the card's revised stamp as the page that answers last saw it; pages that do not send it are not checked for it.
// notes: what the human wrote on single options, { key: text }.
async function decide(cardId, answer, note, seen, notes, files = [], marks) {
  const card = state.cards.find(c => c.id === cardId)
  if (!card) throw new Error('unknown card')
  if (card.status !== 'open') throw new Error('card already decided')
  // An answer holds for the question the human read. One that was given to an earlier wording, or so
  // soon after a rewrite that nobody could have read it, is not taken; the page shows the card as it is now.
  if (card.revised && ((seen !== undefined && seen !== card.revised) || Date.now() - card.revised < REVISE_GRACE)) throw fail(409, STALE_ANSWER)
  if (Array.isArray(answer) && !card.multiple) throw new Error('this card takes one answer; send key, not keys')
  const given = new Set([answer].flat().map(String))
  if (!given.size) throw new Error('keys must name at least one option')
  if ([...given].some(k => !card.options.some(o => o.key === k))) throw card.revised ? fail(409, STALE_ANSWER) : new Error('unknown option')
  // In the order of the options, whatever order they were ticked in.
  const chosen = card.options.filter(o => given.has(o.key))
  const key = chosen[0].key
  const remarks = card.kind === 'decision' ? optionNotes(card, notes, true) : {}
  const remarked = card.options.filter(o => remarks[o.key])
  const pinned = card.kind === 'decision' ? marksOf(card, marks, true) : []
  card.choices = chosen.map(o => o.key)
  // The first one, for clients and agents that know only one answer.
  card.choice = key
  card.note = note
  // What the human attached to the note: kept with the card's own attachments' rules (served from /files, cleaned up with the card).
  if (files.length) card.note_attachments = files
  else delete card.note_attachments
  // What was pinned to an option is a note on that option too, for readers that know only those.
  const onOption = key => pinned.filter(m => m.text && (m.anchor.kind === 'option' ? m.anchor.key : m.anchor.kind === 'section' ? card.sections?.[m.anchor.index]?.key : null) === key).map(m => m.text)
  if (card.kind === 'decision') card.option_notes = Object.fromEntries(card.options.map(o => [o.key, [remarks[o.key], ...onOption(o.key)].filter(Boolean).join('\n')]).filter(([, said]) => said))
  if (pinned.length) card.marks = pinned
  else delete card.marks
  // An answer holds for the version it was given to.
  card.answered_version = card.version ?? (card.revisions ?? 0) + 1
  delete card.with_agent
  delete card.draft
  card.decided = Date.now()
  // A permission verdict needs no follow-up from Claude, so it is done at once.
  card.status = card.kind === 'permission' ? 'done' : 'decided'
  if (card.kind === 'decision') addEvent('decided', card, [chosen.map(o => o.label).join(', '), ...remarked.map(o => `${o.label}: ${brief(remarks[o.key])}`), ...(pinned.length ? [marksCount(pinned)] : [])].join(' · '))
  // The human has answered, so the stream that waited on this card is moving again.
  for (const t of state.tasks) {
    if (t.agent === card.agent && t.card_id === card.id && t.state === 'decision') Object.assign(t, { state: 'working', card_id: null, updated: Date.now() })
  }
  commit()
  if (card.kind === 'permission') {
    await deliver(card.agent, 'notifications/claude/channel/permission', {
      request_id: card.request_id, behavior: key === 'allow' ? 'allow' : 'deny',
    })
  } else {
    await deliver(card.agent, 'notifications/claude/channel', {
      // Notes on single options have no place in meta, so they are lines of the text, each naming its option.
      content: [
        note || `Decision on "${card.title}": ${card.choices.join(', ')}`,
        ...(remarked.length ? ['', 'Notes on options:', ...remarked.map(o => `- ${o.label} [${o.key}], ${given.has(o.key) ? 'chosen' : 'not chosen'}: ${remarks[o.key].replace(/\s*\n\s*/g, ' ')}`)] : []),
        ...marksBlock(card, pinned),
      ].join('\n'),
      // meta values are strings, so several keys travel as one, comma-separated.
      meta: {
        kind: 'decision', card_id: card.id, choice: key, ...(card.multiple ? { choices: card.choices.join(',') } : {}),
        ...(remarked.length ? { option_notes: remarked.map(o => o.key).join(',') } : {}),
        ...(pinned.length ? { marks: String(pinned.length) } : {}),
        ...uploadMeta(files),
      },
    })
  }
}

// "Trust": the human leaves the decision to the agent. The card is decided; what the agent advised stands as the choice,
// so the list shows what will happen, and without advice the choice stays empty until the agent says what it took.
async function trust(cardId, note, seen) {
  const card = state.cards.find(c => c.id === cardId)
  if (!card) throw new Error('unknown card')
  if (card.kind === 'permission') throw new Error('an approval cannot be left to the agent: it gates what the agent may do, so answer it with Allow or Deny')
  if (card.kind !== 'decision') throw new Error('only a question can be left to the agent; an info is closed with /close')
  if (card.status !== 'open') throw new Error('card already decided')
  if (card.revised && ((seen !== undefined && seen !== card.revised) || Date.now() - card.revised < REVISE_GRACE)) throw fail(409, STALE_ANSWER)
  const advised = card.options.filter(o => [card.recommended ?? []].flat().includes(o.key))
  Object.assign(card, {
    trusted: true, choices: advised.map(o => o.key), choice: advised[0]?.key ?? null, note, option_notes: {},
    answered_version: card.version ?? (card.revisions ?? 0) + 1, decided: Date.now(), status: 'decided',
  })
  delete card.note_attachments
  delete card.with_agent
  delete card.draft
  addEvent('decided', card, `Trusted: your call${advised.length ? ` · ${advised.map(o => o.label).join(', ')}` : ''}`)
  state.messages.at(-1).trusted = true
  for (const t of state.tasks) {
    if (t.agent === card.agent && t.card_id === card.id && t.state === 'decision') Object.assign(t, { state: 'working', card_id: null, updated: Date.now() })
  }
  commit()
  await deliver(card.agent, 'notifications/claude/channel', {
    content: [
      `The human trusts you with "${card.title}": decide yourself (${advised.length ? `your advice was: ${advised.map(o => `${o.label} [${o.key}]`).join(', ')}` : 'you gave no advice'}). Say in one line what you chose with reply and this card_id, then close_card; do not ask again.`,
      ...(note ? ['', `Their note: ${note}`] : []),
    ].join('\n'),
    meta: { kind: 'decision', card_id: card.id, choice: card.choice ?? '', ...(card.multiple ? { choices: card.choices.join(',') } : {}), trust: '1' },
  })
}

// "Shred": the human throws a card away unanswered. It is neither a yes nor a no; the card is gone from the stack for good,
// kept only so that it can be taken back, and the agent is told not to ask again.
async function shred(cardId, note, marks, files = []) {
  const card = state.cards.find(c => c.id === cardId)
  if (!card) throw new Error('unknown card')
  if (card.kind === 'permission') throw new Error('an approval cannot be thrown away: the agent is waiting on it, so answer it with Allow or Deny')
  if (card.status !== 'open') throw fail(409, card.status === 'shredded' ? 'card already shredded' : 'card already decided')
  const pinned = marksOf(card, marks, true)
  Object.assign(card, { status: 'shredded', shredded: Date.now(), choice: null, choices: [], note })
  if (pinned.length) card.marks = pinned
  else delete card.marks
  if (files.length) card.note_attachments = files
  else delete card.note_attachments
  delete card.with_agent
  delete card.draft
  addEvent('shredded', card, [card.title, ...(note ? [brief(note)] : []), ...(pinned.length ? [marksCount(pinned)] : [])].join(' · '))
  for (const t of state.tasks) {
    if (t.agent === card.agent && t.card_id === card.id && t.state === 'decision') Object.assign(t, { state: 'working', card_id: null, updated: Date.now() })
  }
  commit()
  await deliver(card.agent, 'notifications/claude/channel', {
    content: [
      card.kind === 'info'
        ? `The human threw "${card.title}" away unread. Do not send it again.`
        : `The human threw the question "${card.title}" away unanswered. That is neither a yes nor a no. Do not ask it again, in these or other words; carry on without an answer, using your own judgement, or drop the matter.`,
      ...(note ? ['', `Their note: ${note}`] : []),
      ...marksBlock(card, pinned),
    ].join('\n'),
    meta: { kind: 'shredded', card_id: card.id, ...(pinned.length ? { marks: String(pinned.length) } : {}), ...uploadMeta(files) },
  })
}

// A card passed on to another session, as that session reads it: everything an agent that never saw the card needs
// to understand the question and, if there is one, the answer. The card itself is not touched.
const CARDS_MAX = 5
function passedCards(list) {
  if (list == null) return []
  if (!Array.isArray(list)) throw new Error('cards must be a list of card ids')
  if (list.length > CARDS_MAX) throw new Error(`at most ${CARDS_MAX} cards in one message; got ${list.length}`)
  // Named by id or by number; the same card twice counts once.
  return [...new Set(list.map(String).map(ref => {
    const card = state.cards.find(c => c.id === ref) ?? state.cards.find(c => String(c.number) === ref)
    if (!card) throw new Error(`no card ${ref}`)
    return card
  }))]
}
const choiceLabels = card => (card.choices ?? []).map(key => card.options.find(o => o.key === key)?.label ?? key)
const cardChip = card => ({ id: card.id, number: card.number, title: card.title, agent: card.agent, choice_label: choiceLabels(card).join(', ') || null })
function cardText(card) {
  const from = state.agents.find(a => a.id === card.agent)
  const advised = [card.recommended ?? []].flat()
  const answer = card.status === 'shredded' ? ['Answer: none. The human threw it away unanswered.']
    : card.kind === 'info' ? [card.read ? 'The human has read it.' : 'Not read yet.']
    : card.choices?.length || card.trusted ? [
      card.trusted ? `Answer: the human left it to the agent${card.choices?.length ? `, whose advice was: ${choiceLabels(card).map((l, i) => `${l} [${card.choices[i]}]`).join(', ')}` : ''}.`
        : `Answer: ${choiceLabels(card).map((l, i) => `${l} [${card.choices[i]}]`).join(', ')}`,
      ...(card.note ? [`The human's note: ${card.note}`] : []),
      ...Object.entries(card.option_notes ?? {}).map(([key, said]) => `Note on ${card.options.find(o => o.key === key)?.label ?? key} [${key}]: ${said.replace(/\s*\n\s*/g, ' ')}`),
    ] : ['Answer: none yet, the question is open.']
  const pictures = [...card.attachments, ...(card.note_attachments ?? [])].map(uploadPath)
  return [
    `--- ${card.kind === 'info' ? 'Info' : 'Question'} Nr. ${card.number} (card ${card.id}), ${card.kind === 'info' ? 'written' : 'asked'} by the session "${from?.label || from?.name || card.agent}" [${card.agent}] ---`,
    card.title,
    ...(card.body ? ['', card.body] : []),
    ...(card.options.length ? ['', `Options${card.multiple ? ' (several may be chosen)' : ''}:`, ...card.options.map(o => `- ${o.label} [${o.key}]${o.detail ? `: ${o.detail}` : ''}${advised.includes(o.key) ? ' (the agent\'s advice)' : ''}`)] : []),
    '', ...answer,
    ...(pictures.length ? [`Pictures and files: ${pictures.join(', ')}`] : []),
  ].join('\n')
}

// The human read an info and closed it. Nothing was asked, so the card is done at once; the agent is told quietly.
async function closeInfo(cardId) {
  const card = state.cards.find(c => c.id === cardId)
  if (!card) throw new Error('unknown card')
  if (card.kind !== 'info') throw new Error('only an info is closed by reading it; a question is answered with /decide')
  if (card.status !== 'open') throw fail(409, 'card already closed')
  const now = Date.now()
  Object.assign(card, { status: 'done', read: now, decided: now })
  delete card.with_agent
  addEvent('read', card, card.title)
  commit()
  await deliver(card.agent, 'notifications/claude/channel', {
    content: `The human read "${card.title}" and closed it. Nothing is expected of you.`,
    meta: { kind: 'info_read', card_id: card.id },
  })
}

// A scribble is the human's drawing: the editable document is kept so it can be
// reopened, and a rendered PNG goes to the agent, who can only read pictures.
const pngBytes = url => {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(url ?? ''))
  if (!m) throw new Error('png must be a PNG data URL')
  return Buffer.from(m[1], 'base64')
}
const canvasFile = (agent, ext) => path.join(SCRIBBLES, `canvas-${slug(agent)}.${ext}`)

// Each session has one lasting canvas. The page saves the drawing as the human
// works, so the agent can always open the latest state.
function saveCanvas(agent, doc) {
  if (!doc || typeof doc !== 'object') throw new Error('doc is required')
  fs.writeFileSync(canvasFile(agent, 'json'), JSON.stringify(doc))
}

// "Send" points the agent at the canvas: a picture of exactly what the human
// was looking at, plus a picture of everything on the canvas. A copy of the
// drawing is kept under the scribble's id so that moment can be reopened.
async function storeScribble(agent, body) {
  const whole = pngBytes(body.png)
  const seen = body.view ? pngBytes(body.view) : whole
  saveCanvas(agent, body.doc)
  const id = crypto.randomBytes(6).toString('hex')
  const image = path.join(SCRIBBLES, `${id}.png`)
  fs.writeFileSync(image, seen)
  fs.writeFileSync(path.join(SCRIBBLES, `${id}.json`), JSON.stringify(body.doc))
  fs.writeFileSync(canvasFile(agent, 'png'), whole)
  const caption = String(body.text ?? '').trim()
  addMessage(agent, 'user', caption, [{ kind: 'scribble', id, name: `Scribble ${id}`, url: `/scribbles/${id}.png`, image: true }])
  await deliver(agent, 'notifications/claude/channel', {
    content: caption || 'The human drew on the canvas and pressed send. image_path shows what they were looking at; canvas_path shows the whole canvas. They may add a chat message about it next.',
    meta: { kind: 'scribble', scribble_id: id, image_path: image, canvas_path: canvasFile(agent, 'png'), canvas_doc: canvasFile(agent, 'json') },
  })
  return id
}

// The human took an answer back. The card returns to the stack and the agent
// is told to stop acting on the old choice.
async function reopen(cardId) {
  const card = state.cards.find(c => c.id === cardId)
  if (!card) throw new Error('unknown card')
  if (card.status === 'shredded') {
    // Fished out again: the card is open as it was, and the agent may count on an answer after all.
    // What they had pinned to it is theirs again, unsent.
    if (card.kind === 'decision' && (card.marks?.length || card.note)) card.draft = { keys: [], note: card.note ?? '', notes: {}, ...(card.marks?.length ? { marks: card.marks } : {}), ts: Date.now() }
    delete card.marks
    Object.assign(card, { status: 'open', shredded: null, note: '', summary: '' })
    addEvent('reopened', card, card.title)
    commit()
    return deliver(card.agent, 'notifications/claude/channel', {
      content: `The human took "${card.title}" back out of the shredder; it is open again${card.kind === 'info' ? '' : ' and they may answer it after all'}.`,
      meta: { kind: 'decision_reopened', card_id: card.id, previous_choice: '', shredded: '1' },
    })
  }
  if (card.kind === 'info') {
    // Taken back, it lies in the stack unread again; the agent has nothing to undo and is not told.
    if (card.status === 'open') throw new Error('card is already open')
    if (!card.read) throw new Error('the agent withdrew this card')
    Object.assign(card, { status: 'open', read: null, decided: null, summary: '' })
    addEvent('reopened', card, card.title)
    return commit()
  }
  if (card.kind !== 'decision') throw new Error('only decisions can be reopened')
  if (card.status === 'open') throw new Error('card is already open')
  if (card.choice == null && !card.trusted) throw new Error('the agent withdrew this card')
  if (card.trusted) {
    // The trust is taken back, not a choice of the human's: nothing is ticked on the open card, only their note is still there.
    const was = card.choices ?? []
    const draft = card.note ? { draft: { keys: [], note: card.note, notes: {}, ts: Date.now() } } : {}
    Object.assign(card, { status: 'open', trusted: false, choice: null, choices: [], note: '', option_notes: {}, summary: '', decided: null, answered_version: null, ...draft })
    addEvent('reopened', card, card.title)
    commit()
    return deliver(card.agent, 'notifications/claude/channel', {
      content: `The human took back leaving "${card.title}" to you. Stop acting on what you chose, undo what you safely can, and wait for their answer.`,
      meta: { kind: 'decision_reopened', card_id: card.id, previous_choice: was[0] ?? '', ...(card.multiple ? { previous_choices: was.join(',') } : {}), trust: '1' },
    })
  }
  const previous = card.choice
  const all = card.choices?.length ? card.choices : [previous]
  const label = all.map(key => card.options.find(o => o.key === key)?.label ?? key).join(', ')
  // Nothing the human ticked or wrote is lost: the answer they took back is what they have not sent yet.
  const draft = { keys: card.options.filter(o => all.includes(o.key)).map(o => o.key), note: card.note ?? '', notes: card.option_notes ?? {}, ...(card.marks?.length ? { marks: card.marks } : {}), ts: Date.now() }
  delete card.marks
  Object.assign(card, { status: 'open', choice: null, choices: [], note: '', option_notes: {}, summary: '', decided: null, answered_version: null, draft })
  addEvent('reopened', card, card.title)
  commit()
  await deliver(card.agent, 'notifications/claude/channel', {
    content: `The human took back their answer "${label}" on "${card.title}". Stop acting on it, undo what you safely can, and wait for the new choice.`,
    meta: { kind: 'decision_reopened', card_id: card.id, previous_choice: previous, ...(card.multiple ? { previous_choices: all.join(',') } : {}) },
  })
}

// ---- speech --------------------------------------------------------------

async function speechFetch(route, init) {
  const key = speechKey()
  if (!key) throw new Error('Speech is not set up (TINFOIL_API_KEY or data/tinfoil.key is missing)')
  const res = await fetch(SPEECH_API + route, { ...init, headers: { ...init.headers, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(HUB_TIMEOUT) })
  if (!res.ok) {
    let reason = `${res.status}`
    try { reason = (await res.json()).error?.message ?? reason } catch {}
    throw new Error(`Speech service: ${reason}`)
  }
  return res
}

// Text to an audio file. The same sentence is only synthesised once. lang ("de", "en") picks the
// voice for that language and tells the model which one it is; without it the model guesses.
async function speak(input, instructions = '', lang = '') {
  const clean = String(input ?? '').trim().slice(0, 4000)
  if (!clean) throw new Error('nothing to say')
  const { model, voice, language } = ttsFor(lang)
  const file = path.join(SPEECH, `${crypto.createHash('sha256').update(`${model}|${voice}|${language}|${instructions}|${clean}`).digest('hex').slice(0, 24)}.mp3`)
  if (!fs.existsSync(file)) {
    const res = await speechFetch('/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: clean, response_format: 'mp3', ...(voice ? { voice } : {}), ...(language ? { language } : {}), ...(instructions ? { instructions } : {}) }),
    })
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()))
  }
  return file
}
// The service answers with MP3 or WAV, whatever was asked for; the page is told which it is.
const audioType = audio => (audio.subarray(0, 4).toString('latin1') === 'RIFF' ? 'audio/wav' : 'audio/mpeg')

async function transcribe(audio, type) {
  const form = new FormData()
  form.append('model', STT_MODEL)
  form.append('file', new Blob([audio], { type }), `audio.${type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : type.includes('wav') ? 'wav' : type.includes('mpeg') ? 'mp3' : 'webm'}`)
  const res = await speechFetch('/audio/transcriptions', { method: 'POST', body: form })
  return String((await res.json()).text ?? '').trim()
}

// ---- live dictation ---------------------------------------------------------
// True streaming, not a re-transcription loop: Tinfoil's voxtral-mini-4b-realtime takes
// PCM16 over a WebSocket (OpenAI Realtime transcription dialect) and sends the words back
// while the human is still speaking; what it sent is never revised. The key stays here, so
// the page gets the words as an event stream (POST /speech/live) and posts its audio in
// small pieces (POST /speech/live/ID), then POST /speech/live/ID/stop.
// The realtime model is the smaller one and mishears more. So when the human stops, the
// whole recording goes once more through the file model, and that text is the final one;
// if that fails, the streamed text stands.
const LIVE_MODEL = process.env.BOARD_STT_LIVE_MODEL || 'voxtral-mini-4b-realtime'
const LIVE_POLISH = !/^(0|off|no|false)$/i.test(process.env.BOARD_STT_LIVE_POLISH ?? '')
const LIVE_SECONDS = Number(process.env.BOARD_STT_LIVE_SECONDS || 180)   // longest dictation
const LIVE_IDLE = Number(process.env.BOARD_STT_LIVE_IDLE_MS || 15000)    // no audio for this long: the page is gone
const LIVE_WAIT = Number(process.env.BOARD_STT_LIVE_WAIT_MS || 10000)    // for the service to open, and to finish
const LIVE_RATE = 16000                                                  // PCM16 mono, what the page sends
const LIVE_SESSIONS = 4
const live = new Map()   // id -> a running dictation

const wavOf = pcm => {
  const head = Buffer.alloc(44)
  head.write('RIFF', 0); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVEfmt ', 8)
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22)
  head.writeUInt32LE(LIVE_RATE, 24); head.writeUInt32LE(LIVE_RATE * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34)
  head.write('data', 36); head.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([head, pcm])
}

function liveOpen(req, res) {
  const key = speechKey()
  if (!key) throw fail(503, 'Speech is not set up (TINFOIL_API_KEY or data/tinfoil.key is missing)')
  if (live.size >= LIVE_SESSIONS) throw fail(429, 'Too many dictations at once; stop one first')
  const s = { id: crypto.randomBytes(9).toString('hex'), pcm: [], bytes: 0, text: '', queue: [], open: false, stopping: null, over: false, timer: null, ws: null }
  live.set(s.id, s)
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
  s.emit = (event, data) => { if (!s.over) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
  s.wait = (ms, fn) => { clearTimeout(s.timer); s.timer = setTimeout(fn, ms) }
  s.end = () => {
    if (s.over) return
    s.over = true
    clearTimeout(s.timer)
    live.delete(s.id)
    try { s.ws.close() } catch {}
    res.end()
  }
  s.fail = message => { s.emit('error', { message }); s.end() }
  // The words are in: say them once more with the better model, then close.
  s.finish = async transcript => {
    if (s.finishing) return
    s.finishing = true
    clearTimeout(s.timer)
    try { s.ws.close() } catch {}
    let text = String(transcript ?? s.text).trim(), polished = false
    // Nothing heard live: the file model would only invent words for the silence.
    const better = text && await (s.better ??= s.polish())
    if (better) { text = better; polished = true }
    s.emit('final', { text, polished, reason: s.stopping ?? 'stop', seconds: Math.round(s.bytes / LIVE_RATE / 2 * 10) / 10 })
    s.end()
  }
  s.polish = () => (LIVE_POLISH && s.bytes ? transcribe(wavOf(Buffer.concat(s.pcm)), 'audio/wav').catch(() => '') : Promise.resolve(''))
  s.stop = reason => {
    if (s.stopping || s.over) return
    s.stopping = reason
    if (!s.bytes) return s.finish('')
    // Both at once: the live model says its last words while the file model reads the whole recording.
    s.better = s.polish()
    const commit = () => { try { s.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' })) } catch {} }
    if (s.open) commit()
    else s.queue.push(commit)
    s.wait(LIVE_WAIT, () => s.finish())
  }
  // The page went away (closed, lost its network, pressed Esc): nothing is left running.
  res.on('close', s.end)

  const ws = s.ws = new WebSocket(`${SPEECH_API.replace(/^http/, 'ws')}/realtime?intent=transcription`, { headers: { Authorization: `Bearer ${key}` } })
  ws.onmessage = e => {
    let m
    try { m = JSON.parse(e.data) } catch { return }
    if (m.type === 'session.created') {
      ws.send(JSON.stringify({ type: 'session.update', session: { type: 'transcription', audio: { input: { format: { type: 'audio/pcm', rate: LIVE_RATE }, transcription: { model: LIVE_MODEL } } } } }))
      s.open = true
      for (const queued of s.queue.splice(0)) typeof queued === 'function' ? queued() : ws.send(queued)
    } else if (m.type === 'conversation.item.input_audio_transcription.delta' && typeof m.delta === 'string') {
      s.text += m.delta
      s.emit('delta', { text: m.delta })
    } else if (m.type === 'conversation.item.input_audio_transcription.completed') {
      s.finish(m.transcript)
    } else if (m.type === 'error') {
      s.fail(`Speech service: ${String(m.error?.message ?? m.message ?? 'error').slice(0, 300)}`)
    }
  }
  ws.onerror = () => { if (!s.finishing) s.fail('Speech service: the live connection failed') }
  ws.onclose = () => { if (!s.finishing) s.fail('Speech service: the live connection closed') }
  s.wait(LIVE_WAIT, () => (s.open ? s.stop('idle') : s.fail('Speech service: the live connection did not open')))
  s.emit('ready', { id: s.id, rate: LIVE_RATE, max_seconds: LIVE_SECONDS })
}

function liveAudio(id, pcm) {
  const s = live.get(id)
  if (!s || s.stopping) throw fail(s ? 409 : 404, 'This dictation has ended')
  if (pcm.length % 2) throw fail(400, 'audio must be whole 16-bit samples')
  const room = LIVE_SECONDS * LIVE_RATE * 2 - s.bytes
  const part = pcm.length > room ? pcm.subarray(0, room) : pcm
  if (part.length) {
    s.pcm.push(part)
    s.bytes += part.length
    const frame = JSON.stringify({ type: 'input_audio_buffer.append', audio: part.toString('base64') })
    if (s.open) s.ws.send(frame)
    else s.queue.push(frame)
  }
  if (pcm.length >= room) return s.stop('limit')
  if (s.open) s.wait(LIVE_IDLE, () => s.stop('idle'))
}

// What a card sounds like when read out: markdown stripped, code skipped, options numbered.
function cardScript(card) {
  const plain = String(card.body ?? '')
    .replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '').replace(/https?:\/\/\S+/g, 'Link').replace(/\s+/g, ' ').trim()
  const options = card.kind === 'permission'
    ? 'Allow or deny?'
    : card.options.map((o, i) => `Option ${i + 1}: ${o.label}${o.detail ? `. ${o.detail}` : ''}`).join('. ')
  return [card.title, card.urgency_reason, plain, options].filter(Boolean).join('. ').replace(/([.?!])\./g, '$1')
    // The voice stumbles over German number formats: 48.210 and 02:00.
    .replace(/(\d)\.(\d{3})\b/g, '$1$2').replace(/\b0?(\d{1,2}):00\b/g, '$1 Uhr').replace(/\b0?(\d{1,2}):(\d{2})\b/g, '$1 Uhr $2')
}

const readRaw = (req, limit) => new Promise((resolve, reject) => {
  const chunks = []
  let size = 0
  req.on('data', chunk => {
    size += chunk.length
    if (size > limit) reject(new Error('body too large'))
    else chunks.push(chunk)
  })
  req.on('end', () => resolve(Buffer.concat(chunks)))
  req.on('error', reject)
})

// ---- HTTP side -----------------------------------------------------------

// The page can put text in front of Claude and approve tool use, and the
// server is reachable from the network. Every request needs the token cookie,
// which is set by opening the link from data/url.txt once per browser.
// Browsers share cookies between ports of one host, so two boards on the same
// machine would overwrite each other's login; the port is part of the name.
// Logins from before that change used the plain name and still count.
const COOKIE = `board_${PORT}`
const authed = req => {
  const cookies = (req.headers.cookie ?? '').split(/;\s*/)
  return [COOKIE, 'board'].some(name => {
    const found = cookies.find(c => c.startsWith(`${name}=`))
    return found && tokenMatches(found.slice(name.length + 1))
  })
}
// A POST must come from the page itself, not from another site.
const sameOrigin = req => {
  try {
    return new URL(req.headers.origin).host === req.headers.host
  } catch {
    return false
  }
}

const readJson = (req, limit = 1e6) => new Promise((resolve, reject) => {
  let raw = ''
  let over = false
  req.on('data', chunk => {
    if (over) return
    raw += chunk
    if (raw.length <= limit) return
    // Stop keeping what still arrives; the limit is there to bound memory.
    over = true
    raw = ''
    reject(new Error('body too large'))
  })
  req.on('end', () => {
    try { resolve(JSON.parse(raw || '{}')) } catch (err) { reject(err) }
  })
  req.on('error', reject)
})

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' })
  res.end(body)
}

// Which agent a message from the page is for. With a single agent the page
// need not say; with several it must.
function targetAgent(id) {
  if (id != null && state.agents.some(a => a.id === id)) return id
  if (id == null && state.agents.length === 1) return state.agents[0].id
  throw new Error(id == null ? 'agent is required when several agents share the board' : `no agent ${id}`)
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const sameSecret = (given, secret) => {
  const a = Buffer.from(String(given ?? '')), b = Buffer.from(secret)
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b)
}
const tokenMatches = given => sameSecret(given, TOKEN)

// Spokes talk to the hub here: same machine only, and they must know the token.
// A reverse proxy on this machine (tailscale serve) connects from loopback too,
// on behalf of someone who is not on this machine. It says so in these headers.
const proxied = req => req.headers['x-forwarded-for'] != null || req.headers['tailscale-user-login'] != null

async function agentRoute(req, res, url) {
  if (!LOOPBACK.has(req.socket.remoteAddress) || proxied(req) || !tokenMatches(req.headers['x-board-token'])) {
    return send(res, 403, '{"error":"forbidden"}')
  }
  try {
    if (req.method === 'GET' && url.pathname === '/agent/link') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
      const write = msg => res.write(`data: ${JSON.stringify(msg)}\n\n`)
      const q = url.searchParams
      const link = {
        // A spoke running an older server.mjs names no instance; it is taken at its word.
        instance: q.get('instance') || newId(), strict: Boolean(q.get('instance')),
        send: (method, params) => {
          if (res.destroyed || res.writableEnded) return false
          write({ method, params })
          return true
        },
        end: () => res.end(),
      }
      const id = register({ name: q.get('name') || 'agent', cwd: q.get('cwd') || '', host: q.get('host') || '', platform: q.get('platform') || '', id: q.get('id') }, link)
      // dedicated: this hub is nobody's session and comes back by itself, so a spoke waits for it instead of taking the port.
      write({ hello: id, ping: PING, dedicated: HUB_ONLY })
      flush(id)
      const beat = setInterval(() => res.write(': ping\n\n'), PING)
      req.on('close', () => {
        clearInterval(beat)
        unregister(id, link)
      })
      return
    }
    // An asset arrives as bytes, so who sends it stands in the address instead of the body.
    const upload = req.method === 'POST' && url.pathname === '/agent/asset'
    const body = upload ? Object.fromEntries(url.searchParams) : await readJson(req)
    const link = links.get(body?.id)
    // The id alone is not proof: after a change of hub it may belong to another session.
    if (!link || (link.strict && link.instance !== body.instance)) return send(res, 409, '{"error":"agent is not linked"}')
    if (upload) {
      const blob = await readRaw(req, ASSET_BLOB_MAX)
      const given = JSON.parse(Buffer.from(String(req.headers['x-asset'] ?? ''), 'base64url').toString() || 'null')
      return send(res, 200, JSON.stringify(storeAsset(body.id, given, blob)))
    }
    if (req.method === 'POST' && url.pathname === '/agent/tool') {
      return send(res, 200, JSON.stringify({ text: await runTool(body.id, String(body.name), body.args ?? {}) }))
    }
    if (req.method === 'POST' && url.pathname === '/agent/profile') {
      setProfile(body.id, body.fields ?? {})
      return send(res, 200, '{"ok":true}')
    }
    if (req.method === 'POST' && url.pathname === '/agent/permission') {
      addPermission(body.id, body.params)
      return send(res, 200, '{"ok":true}')
    }
    return send(res, 404, '{"error":"not found"}')
  } catch (err) {
    return send(res, 400, JSON.stringify({ error: err.message }))
  }
}

// ---- admin -----------------------------------------------------------------

// What the person who runs the hub would otherwise do in a shell. Everything
// here is behind the login cookie and the Origin check like the rest, and
// behind the admin key on top: the login link is shared with every device that
// uses the board, and a link that leaked must not be enough to delete data or
// to lock the owner out by replacing the token.
const ADMIN_COOKIE = `board_admin_${PORT}`
const ADMIN_TTL = 12 * 3600000
// The browser holds a random session id, not the key; a new hub knows none of them.
const adminSessions = new Map()
const cookieOf = (req, name) => (req.headers.cookie ?? '').split(/;\s*/).find(c => c.startsWith(`${name}=`))?.slice(name.length + 1)
const isAdmin = req => adminSessions.get(cookieOf(req, ADMIN_COOKIE)) > Date.now()
const fail = (status, message) => Object.assign(new Error(message), { status })

// Nothing the admin routes hand out or write down may carry a secret, even if
// someone pasted one into a chat. Very short secrets are left alone: replacing
// them would eat ordinary words.
function scrubber() {
  const secrets = [TOKEN, adminKey, speechKey()].filter(s => s.length >= 6).flatMap(s => [s, JSON.stringify(s).slice(1, -1)])
  return text => secrets.reduce((out, s) => out.split(s).join('[removed]'), String(text))
}
const scrub = text => scrubber()(text)

const ADMIN_LOG = path.join(DATA, 'admin-log.jsonl')
const ADMIN_LOG_MAX = 300
let adminLog = []
function readAdminLog() {
  const parse = line => { try { return JSON.parse(line) } catch { return null } }
  return readSecret(ADMIN_LOG).split('\n').map(parse).filter(e => e && typeof e === 'object').slice(-ADMIN_LOG_MAX)
}
function audit(req, action, detail = '') {
  const last = adminLog.at(-1)
  // Repeated wrong keys count up in one line, so they cannot push the rest out of the log.
  if (action === 'login-failed' && last?.action === action) Object.assign(last, { ts: Date.now(), count: (last.count ?? 1) + 1 })
  else adminLog = [...adminLog, { ts: Date.now(), action, detail: scrub(detail), from: req.socket.remoteAddress ?? '' }].slice(-ADMIN_LOG_MAX)
  const tmp = `${ADMIN_LOG}.${process.pid}.tmp`
  fs.writeFileSync(tmp, adminLog.map(e => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 })
  fs.renameSync(tmp, ADMIN_LOG)
}

// Files are only ever named by one of the data folders and a bare file name.
function dataFile(dir, name) {
  const file = path.join(dir, path.basename(String(name)))
  if (path.dirname(file) !== dir || !path.resolve(file).startsWith(path.resolve(DATA) + path.sep)) throw fail(400, `not a file in the data directory: ${name}`)
  return file
}
function listFiles(dir) {
  const stat = name => { try { return fs.statSync(dataFile(dir, name)) } catch { return null } }
  // Regular files only: a link placed in the folder is neither counted nor followed.
  return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile())
    .map(e => ({ dir, name: e.name, stat: stat(e.name) })).filter(f => f.stat).map(f => ({ dir, name: f.name, size: f.stat.size, mtime: f.stat.mtimeMs }))
}
function removeFile(dir, name) {
  const file = dataFile(dir, name)
  let size = 0
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile()) return 0
    size = stat.size
  } catch { return 0 }
  fs.rmSync(file, { force: true })
  return size
}
const tally = files => ({ count: files.length, bytes: files.reduce((sum, f) => sum + f.size, 0) })

// The stored files of a list of messages and cards, as [folder, name] pairs.
function filesOf(items) {
  // A card's earlier versions keep their pictures for as long as the card lives.
  return items.flatMap(item => [item, ...(item.versions ?? [])]).flatMap(item => [...(item.attachments ?? []), ...(item.note_attachments ?? [])]).flatMap(a => {
    if (a?.kind === 'scribble' && a.id) return [[SCRIBBLES, `${a.id}.png`], [SCRIBBLES, `${a.id}.json`]]
    return filesOfAttachment(a).map(name => [FILES, name])
  })
}
const canvasFiles = agent => ['json', 'png'].map(ext => [SCRIBBLES, path.basename(canvasFile(agent, ext))])

// Files nothing in the state points to. The canvas of every session that is
// still mentioned anywhere counts as referenced. Spoken audio is a cache that
// nothing references; a day is long enough for an agent to pick up a voiceover.
const SPEECH_KEEP = 86400000
function orphans() {
  const owners = new Set([...state.agents.map(a => a.id), ...state.messages.map(m => m.agent), ...state.cards.map(c => c.agent)].filter(Boolean))
  const used = new Set([...filesOf([...state.messages, ...state.cards]), ...[...owners].flatMap(canvasFiles)].map(([dir, name]) => path.join(dir, name)))
  const loose = dir => listFiles(dir).filter(f => !used.has(path.join(dir, f.name)))
  const known = new Set(state.assets.map(a => a.id))
  return {
    files: loose(FILES), scribbles: loose(SCRIBBLES), speech: listFiles(SPEECH).filter(f => Date.now() - f.mtime > SPEECH_KEEP),
    assets: listFiles(ASSETS).filter(f => !known.has(f.name)),
  }
}

// What purge() would take if it ran now.
function purgePreview() {
  const cutoff = Date.now() - RETENTION_DAYS * 86400000
  const old = expired(cutoff)
  const ids = new Set(old.map(c => c.id))
  const names = new Set(filesOf(old).map(([, name]) => name))
  return {
    cutoff, cards: old.length, ...tally(listFiles(FILES).filter(f => names.has(f.name))),
    markers: state.messages.filter(m => m.from === 'event' && ids.has(m.card_id)).length,
    queued: Object.values(state.pending).flat().filter(e => e.ts < cutoff).length,
    assets: staleAssets(cutoff).length,
  }
}

function forgetSession(id, withData) {
  const agent = state.agents.find(a => a.id === id)
  if (!agent) throw fail(404, `no session ${id}`)
  if (links.has(id)) throw fail(409, `session ${id} is online; only a session that is away can be forgotten`)
  const mine = x => x.agent === id
  const gone = { messages: 0, cards: 0, files: 0, bytes: 0 }
  if (withData) {
    const items = [...state.messages.filter(mine), ...state.cards.filter(mine)]
    for (const [dir, name] of [...filesOf(items), ...canvasFiles(id)]) {
      const size = removeFile(dir, name)
      if (!size) continue
      gone.files++
      gone.bytes += size
    }
    for (const asset of state.assets.filter(mine)) {
      gone.files++
      gone.bytes += asset.size
    }
    dropAssets(state.assets.filter(mine), 'withdrawn')
    gone.messages = state.messages.filter(mine).length
    gone.cards = state.cards.filter(mine).length
    state.messages = state.messages.filter(m => !mine(m))
    state.cards = state.cards.filter(c => !mine(c))
  }
  // Status lines and waiting notifications mean nothing without the session.
  state.tasks = state.tasks.filter(t => !mine(t))
  delete state.pending[id]
  state.agents = state.agents.filter(a => a.id !== id)
  commit()
  return gone
}

function loginLinks() {
  const lan = Object.values(os.networkInterfaces()).flat().find(i => i.family === 'IPv4' && !i.internal)
  const hosts = HOST === '0.0.0.0' ? [['local', 'localhost'], ['lan', lan?.address]] : [['local', HOST]]
  return [
    ...hosts.filter(([, host]) => host).map(([kind, host]) => ({ kind, url: `http://${host}:${PORT}/?t=${TOKEN}` })),
    ...PUBLIC_URLS.map(base => ({ kind: 'public', url: `${base}/?t=${TOKEN}` })),
  ]
}
const writeLinks = () => fs.writeFileSync(path.join(DATA, 'url.txt'), loginLinks().map(l => l.url).join('\n') + '\n', { mode: 0o600 })

// Every login so far ends here: old cookies no longer match and open pages are
// cut off. Spokes keep their link and pick the new token up from the file the
// next time the hub refuses the old one.
function rotateToken() {
  const tmp = `${TOKEN_FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, crypto.randomBytes(24).toString('base64url'), { mode: 0o600 })
  fs.renameSync(tmp, TOKEN_FILE)
  TOKEN = readToken()
  writeLinks()
  for (const res of clients) res.end()
}

function overview() {
  const cards = status => state.cards.filter(c => c.status === status).length
  const size = file => { try { return fs.statSync(file).size } catch { return 0 } }
  const queued = id => state.pending[id]?.length ?? 0
  return {
    version: VERSION, node: process.version, now: Date.now(), uptime: Math.round(process.uptime()),
    hub: { id: selfId, pid: process.pid, host: os.hostname(), since: hubSince },
    port: PORT, bind: HOST, speech: Boolean(speechKey()), token_fixed: Boolean(process.env.BOARD_TOKEN), retention_days: RETENTION_DAYS,
    data: { dir: path.resolve(DATA), state: size(STATE_FILE), files: tally(listFiles(FILES)), scribbles: tally(listFiles(SCRIBBLES)), speech: tally(listFiles(SPEECH)), assets: tally(listFiles(ASSETS)) },
    counts: {
      messages: state.messages.length, cards: { open: cards('open'), decided: cards('decided'), done: cards('done') },
      queued: Object.fromEntries(Object.keys(state.pending).map(id => [id, queued(id)])), sse: clients.size,
    },
    sessions: state.agents.map(a => ({
      id: a.id, name: a.name, label: a.label ?? '', online: links.has(a.id), hub: a.id === selfId,
      model: a.model, host: a.host, cwd: a.cwd, client: a.client, platform: a.platform, task: a.task,
      joined: a.joined, connected: a.connected, seen: a.seen, queued: queued(a.id),
      messages: state.messages.filter(m => m.agent === a.id).length, cards: state.cards.filter(c => c.agent === a.id).length,
    })),
  }
}

// The state as a file to keep. Left out: the queue of notifications for agents
// that are away (it repeats chat text and names paths on this machine; only
// its length per agent is kept) and, by scrub, any secret that got into a text.
function exportState() {
  const queued = Object.fromEntries(Object.entries(state.pending).map(([id, queue]) => [id, queue.length]))
  return scrub(JSON.stringify({ exported: Date.now(), version: VERSION, ...state, pending: undefined, pending_counts: queued }, null, 2))
}

// confirm names what the body must repeat in its "confirm" field before anything is removed or replaced.
const ADMIN_ROUTES = new Map(Object.entries({
  login: {
    method: 'POST', open: true,
    async run({ req, res, body }) {
      if (!sameSecret(body.key, adminKey)) {
        // A wrong key costs a second; no lockout, which a guest could turn against the owner.
        await new Promise(resolve => setTimeout(resolve, 1000))
        audit(req, 'login-failed')
        throw fail(403, 'wrong admin key')
      }
      for (const [id, until] of adminSessions) if (until < Date.now()) adminSessions.delete(id)
      const id = crypto.randomBytes(24).toString('base64url')
      adminSessions.set(id, Date.now() + ADMIN_TTL)
      res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${ADMIN_TTL / 1000}`)
      audit(req, 'login')
      return { ok: true }
    },
  },
  logout: {
    method: 'POST', open: true,
    run({ req, res }) {
      adminSessions.delete(cookieOf(req, ADMIN_COOKIE))
      res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0`)
      return { ok: true }
    },
  },
  overview: { method: 'GET', run: overview },
  cleanup: {
    method: 'GET',
    run() {
      const loose = orphans()
      return { retention_days: RETENTION_DAYS, purge: purgePreview(), orphans: Object.fromEntries(Object.entries(loose).map(([kind, files]) => [kind, tally(files)])) }
    },
  },
  log: { method: 'GET', run: () => ({ max: ADMIN_LOG_MAX, entries: adminLog }) },
  diagnose: {
    method: 'GET',
    run: (ctx, clean = scrubber()) => ({
      sse: clients.size, lines: logLines.map(l => ({ ts: l.ts, line: clean(l.line) })),
      links: state.agents.map(a => ({
        id: a.id, state: a.id === selfId ? 'hub' : links.has(a.id) ? 'linked' : 'away',
        since: a.connected, seen: a.seen, queued: state.pending[a.id]?.length ?? 0,
      })),
    }),
  },
  export: {
    method: 'GET',
    run({ req, res }) {
      audit(req, 'export')
      res.setHeader('Content-Disposition', `attachment; filename="trommi-${new Date().toISOString().slice(0, 10)}.json"`)
      send(res, 200, exportState())
    },
  },
  links: {
    method: 'POST',
    run({ req }) {
      audit(req, 'links')
      return { links: loginLinks(), token_fixed: Boolean(process.env.BOARD_TOKEN) }
    },
  },
  'sessions/forget': {
    method: 'POST', confirm: body => String(body.id),
    run({ req, body }) {
      const gone = forgetSession(String(body.id), body.data === true)
      audit(req, 'forget', `${body.id}${body.data === true ? `, with ${gone.messages} messages, ${gone.cards} cards, ${gone.files} files` : ', data kept'}`)
      return { ok: true, ...gone }
    },
  },
  'sessions/clear-queue': {
    method: 'POST', confirm: body => String(body.id),
    run({ req, body }) {
      const id = String(body.id)
      const queued = Object.hasOwn(state.pending, id) ? state.pending[id].length : 0
      if (!queued && !state.agents.some(a => a.id === id)) throw fail(404, `no session ${id}`)
      delete state.pending[id]
      save()
      audit(req, 'clear-queue', `${id}, ${queued} notifications`)
      return { ok: true, removed: queued }
    },
  },
  purge: {
    method: 'POST', confirm: () => 'purge',
    run({ req }) {
      const { cutoff, ...removed } = purgePreview()
      purge()
      audit(req, 'purge', `${removed.cards} cards, ${removed.count} files${removed.assets ? `, ${removed.assets} assets` : ''}`)
      return { ok: true, ...removed }
    },
  },
  orphans: {
    method: 'POST', confirm: () => 'orphans',
    run({ req }) {
      const loose = Object.values(orphans()).flat()
      const bytes = loose.reduce((sum, f) => sum + removeFile(f.dir, f.name), 0)
      audit(req, 'orphans', `${loose.length} files`)
      return { ok: true, removed: loose.length, bytes }
    },
  },
  'token/rotate': {
    method: 'POST', confirm: () => 'rotate',
    run({ req, res }) {
      // A restart would bring the old token back, so the rotation would be a pretence.
      if (process.env.BOARD_TOKEN) throw fail(409, 'the token is set by BOARD_TOKEN; change it there and restart')
      rotateToken()
      // Whoever rotated stays logged in; everyone else needs the new link.
      res.setHeader('Set-Cookie', `${COOKIE}=${TOKEN}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`)
      audit(req, 'rotate')
      return { ok: true, links: loginLinks() }
    },
  },
}))

async function adminRoute(req, res, url) {
  const route = ADMIN_ROUTES.get(url.pathname.slice('/admin/api/'.length))
  // A process that lost or never had the port holds no state to manage.
  if (role !== 'hub') return send(res, 503, '{"error":"only the hub answers admin requests"}')
  if (!route) return send(res, 404, '{"error":"not found"}')
  if (req.method !== route.method) {
    res.setHeader('Allow', route.method)
    return send(res, 405, '{"error":"method not allowed"}')
  }
  if (!route.open && !isAdmin(req)) return send(res, 403, '{"error":"admin key required","admin":false}')
  try {
    const body = route.method === 'POST' ? await readJson(req) : {}
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'the body must be an object')
    if (route.confirm && body.confirm !== route.confirm(body)) throw fail(400, `not confirmed: send "confirm": ${JSON.stringify(route.confirm(body))}`)
    const out = await route.run({ req, res, body })
    if (out !== undefined) send(res, 200, JSON.stringify(out))
  } catch (err) {
    send(res, err.status ?? 400, JSON.stringify({ error: scrub(err.message) }))
  }
}

// The viewer and the blobs are the only things served without a login: the link
// is the permission, and all the server hands out is ciphertext and the static
// viewer. The viewer runs under the board's address, where the human's login
// cookie lives, so it may load nothing but its own files, and it never puts
// decrypted content into its own page.
const VIEWER_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src blob:; media-src blob:; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
// An HTML asset is written into this empty page, which the viewer loads in a
// sandboxed frame. The page brings its own policy rather than inheriting the
// viewer's: the asset's own inline scripts and styles run, in an origin of
// their own that is nobody's, and nothing is fetched from anywhere. It lives
// here and not in client/web, so it is never served without that policy.
const FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts"
const ASSET_FRAME = `<!doctype html><meta charset="utf-8"><title>Asset</title><script>
addEventListener('message', function take(e) {
  if (e.source !== parent || !e.data || typeof e.data.html !== 'string') return
  removeEventListener('message', take)
  document.open()
  document.write(e.data.html)
  document.close()
})
parent.postMessage('ready', '*')
</script>`
const VIEWER_FILES = { 'asset.js': 'js/asset.js', 'asset.css': 'css/asset.css', 'tokens.css': 'css/tokens.css' }

function assetRoute(req, res, url) {
  const [id, rest, ...more] = url.pathname.split('/').slice(2)
  const out = (code, body, type = 'application/json', csp = "default-src 'none'; sandbox") => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' })
    res.end(body)
  }
  const missing = () => out(404, '{"error":"not found"}')
  if (req.method !== 'GET' || more.length) return missing()
  if (id === '-' && rest === 'frame.html') return out(200, ASSET_FRAME, MIME['.html'], FRAME_CSP)
  if (id === '-') return Object.hasOwn(VIEWER_FILES, rest) ? out(200, fs.readFileSync(path.join(PUBLIC, VIEWER_FILES[rest])), MIME[path.extname(rest)]) : missing()
  if (!ASSET_ID.test(id)) return missing()
  // The page is the same for every id, so asking for it does not tell whether an asset exists.
  if (rest == null) return out(200, fs.readFileSync(path.join(PUBLIC, 'a.html')), MIME['.html'], VIEWER_CSP)
  if (rest !== 'blob' || !state.assets.some(a => a.id === id)) return missing()
  // A revoke may delete the file between the check above and the read.
  fs.readFile(path.join(ASSETS, id), (err, blob) => (err ? missing() : out(200, blob, 'application/octet-stream')))
}

// A file of the web client, or nothing: only the kinds a page is made of, no
// dotfiles, nothing reached through a link, nothing outside client/web. A
// folder answers with its index.html.
const STATIC_EXT = new Set(['.html', '.css', '.js', '.mjs', '.json', '.png', '.svg', '.webp', '.ico', '.woff2'])
function staticFile(pathname) {
  let parts
  try { parts = decodeURIComponent(pathname).split('/').filter(Boolean) } catch { return null }
  if (parts.some(part => part.startsWith('.') || /[\\\0]/.test(part))) return null
  const file = path.join(PUBLIC, ...parts)
  const kind = name => { try { return fs.lstatSync(name) } catch { return null } }
  if (!file.startsWith(PUBLIC + path.sep)) return null
  if (kind(file)?.isDirectory()) {
    if (!kind(path.join(file, 'index.html'))?.isFile()) return null
    // Without the slash at the end the folder's relative links would point one level up.
    return pathname.endsWith('/') ? { file: path.join(file, 'index.html') } : { redirect: `/${parts.join('/')}/` }
  }
  return STATIC_EXT.has(path.extname(file).toLowerCase()) && kind(file)?.isFile() ? { file } : null
}

// The page keeps its place in the address (History API), so these paths are the page too.
const APP_PATH = /^\/($|s\/|q\/[\w-]+$|agents$|inbox$|pad$|walk$)/
// The pad: its elements, their bytes, live changes, and sending a selection to a session (pad.mjs).
// It keeps them in SQLite, in data/pad.db; the store is loaded when the pad is first used.
const padRoute = padRoutes({
  dir: () => DATA, files: FILES, ping: PING, retentionDays: RETENTION_DAYS, send, readJson, readRaw, pngBytes, deliver,
  sessionOf: id => (state.agents.some(a => a.id === id) ? id : null),
  say: (agent, words, attachments) => { addMessage(agent, 'user', words, attachments); return state.messages.at(-1).id },
})
const withoutToken = url => {
  const rest = new URLSearchParams(url.search)
  rest.delete('t')
  return rest.size ? `?${rest}` : ''
}

const httpServer = http.createServer(async (req, res) => {
  let url
  // Runs before any check, so a request line that is no URL ("//") must not throw.
  try {
    url = new URL(req.url, `http://localhost:${PORT}`)
  } catch {
    return send(res, 400, '{"error":"bad request"}')
  }
  // For a supervisor or a proxy: says that the process answers, and nothing else.
  if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, '{"ok":true}')
  if (url.pathname.startsWith('/agent/')) return agentRoute(req, res, url)
  if (req.method === 'GET' && tokenMatches(url.searchParams.get('t'))) {
    res.writeHead(302, {
      // Lax, so following a link to the board from another app still arrives logged in;
      // writes are guarded by the Origin check, which Lax does not weaken.
      'Set-Cookie': `${COOKIE}=${TOKEN}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`,
      // The page asked for is where the login ends, with whatever else the link carried, e.g. ?q=<card>.
      Location: url.pathname.replace(/^\/+/, '/') + withoutToken(url),
    })
    return res.end()
  }
  if (url.pathname.startsWith('/a/')) return assetRoute(req, res, url)
  if (!authed(req)) return send(res, 401, 'Access only through the link in data/url.txt', 'text/plain; charset=utf-8')
  if (req.method !== 'GET' && !sameOrigin(req)) return send(res, 403, '{"error":"forbidden"}')
  if (url.pathname.startsWith('/admin/api/')) return adminRoute(req, res, url)
  try {
    if (req.method === 'GET' && APP_PATH.test(url.pathname)) {
      return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'index.html')), 'text/html; charset=utf-8')
    }
    if (req.method === 'GET' && url.pathname === '/api/tools') {
      // The help page renders its reference from the same tables the agent is given.
      return send(res, 200, JSON.stringify({ version: VERSION, retention_days: RETENTION_DAYS, max_asset_mb: MAX_ASSET / 1024 / 1024, tools: toolsNow().map(t => ({ ...t, example: TOOL_EXAMPLES[t.name] })), drawings: drawings() ?? [], events: CHANNEL_EVENTS }))
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
      res.write(frameOf())
      clients.add(res)
      res.on('drain', () => {
        if (!res.behind) return
        res.behind = false
        res.write(frameOf())
      })
      req.on('close', () => clients.delete(res))
      return
    }
    if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
      const name = path.basename(url.pathname)
      const file = path.join(FILES, name)
      if (!fs.existsSync(file)) return send(res, 404, '{"error":"not found"}')
      // The page a picture was rendered from is shown as a page, but as a stranger: the sandbox gives it an origin of its own,
      // so it has neither the board's cookies nor its storage, and it may load nothing but what it carries inline.
      const page = /\.html?$/i.test(name)
      const type = page ? 'text/html; charset=utf-8' : MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream'
      const size = fs.statSync(file).size
      const headers = {
        'Content-Type': type,
        'Accept-Ranges': 'bytes',
        // Attachments come from the agent's workspace; never let one run as a page of the board.
        'Content-Security-Policy': page
          ? "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'unsafe-inline'"
          : "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'X-Content-Type-Options': 'nosniff',
      }
      // Browsers (Safari always) fetch video in ranges and need them to seek.
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
      if (range && (range[1] || range[2])) {
        const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
        const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
        if (start > end || start >= size) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` })
          return res.end()
        }
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 })
        return fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res)
      }
      res.writeHead(200, { ...headers, 'Content-Length': size })
      // The cleanup may delete the file between the check above and the read.
      return fs.createReadStream(file).on('error', () => res.destroy()).pipe(res)
    }
    if (req.method === 'POST' && url.pathname === '/message') {
      const body = await readJson(req, UPLOAD_BODY)
      const msg = String(body.text ?? '').trim()
      if (!msg && !(Array.isArray(body.attachments) && body.attachments.length) && !(Array.isArray(body.marks) && body.marks.length) && !(Array.isArray(body.cards) && body.cards.length)) return send(res, 400, '{"error":"empty message"}')
      // The body may be large for the files' sake only; the words keep their old limit.
      if (msg.length > 1e6) throw new Error('body too large')
      const agent = targetAgent(body.agent)
      // Notes and drawings pinned to the card the message is about; without such a card they have nothing to hold on to.
      const noted = state.cards.find(c => c.id === body.card_id && c.agent === agent && c.status === 'open')
      const pinned = noted ? marksOf(noted, body.marks, true) : []
      // Cards the human copies into this conversation, from this session or any other.
      const passed = passedCards(body.cards)
      if (!msg && !pinned.length && !passed.length && !(Array.isArray(body.attachments) && body.attachments.length)) return send(res, 400, '{"error":"empty message"}')
      // Files and pictures the human attached; a message may be nothing but them.
      const files = storeUploads(body.attachments)
      // A question back about a card instead of an answer to it. Only an open card of this agent counts; the card stays open.
      const asked = state.cards.find(c => c.id === body.card_id && c.agent === agent && c.status === 'open')
      const about = asked ? { card_id: body.card_id } : {}
      // The human gave the card back to be reworked, or asked for it to be explained: until the agent answers, it is with the agent.
      const turn = asked && asked.kind !== 'permission' ? { ...(body.handback === true ? { handback: true } : {}), ...(body.explain === true ? { explain: true } : {}) } : {}
      if (Object.keys(turn).length) asked.with_agent = Date.now()
      addMessage(agent, 'user', msg, files, { ...about, ...turn, ...(pinned.length ? { marks: pinned } : {}), ...(passed.length ? { cards: passed.map(cardChip) } : {}) })
      await deliver(agent, 'notifications/claude/channel', {
        content: [
          msg || (files.length ? uploadLine(files) : passed.length ? `The human passes ${passed.length === 1 ? 'a card' : `${passed.length} cards`} on to you.` : 'The human pinned notes to the card.'),
          ...(pinned.length ? marksBlock(noted, pinned) : []),
          ...passed.flatMap(card => ['', cardText(card)]),
        ].join('\n'),
        meta: {
          kind: 'chat', ...about, ...Object.fromEntries(Object.keys(turn).map(k => [k, '1'])), ...(pinned.length ? { marks: String(pinned.length) } : {}),
          // meta values are strings: the ids, and the same cards as JSON for whoever wants fields instead of prose.
          ...(passed.length ? { cards: passed.map(c => c.id).join(','), cards_json: JSON.stringify(passed.map(c => ({ ...cardChip(c), kind: c.kind, status: c.status, choices: c.choices ?? [] }))) } : {}),
          ...uploadMeta(files),
        },
      })
      return send(res, 200, '{"ok":true}')
    }
    if (req.method === 'GET' && /^\/scribbles\/[0-9a-f]+\.(json|png)$/.test(url.pathname)) {
      const file = path.join(SCRIBBLES, path.basename(url.pathname))
      if (!fs.existsSync(file)) return send(res, 404, '{"error":"not found"}')
      return send(res, 200, fs.readFileSync(file), file.endsWith('.png') ? 'image/png' : 'application/json')
    }
    if (req.method === 'GET' && url.pathname === '/canvas') {
      const file = canvasFile(targetAgent(url.searchParams.get('agent')), 'json')
      return send(res, 200, fs.existsSync(file) ? fs.readFileSync(file) : 'null')
    }
    if (req.method === 'POST' && url.pathname === '/canvas') {
      const body = await readJson(req, 96e6)
      saveCanvas(targetAgent(body.agent), body.doc)
      return send(res, 200, '{"ok":true}')
    }
    if (req.method === 'POST' && url.pathname === '/scribble') {
      // A canvas with photos on it is large; the limit is generous but finite.
      const body = await readJson(req, 96e6)
      const id = await storeScribble(targetAgent(body.agent), body)
      return send(res, 200, JSON.stringify({ ok: true, id }))
    }
    if (req.method === 'POST' && url.pathname === '/speech/transcribe') {
      const audio = await readRaw(req, 25e6)
      return send(res, 200, JSON.stringify({ text: await transcribe(audio, req.headers['content-type'] || 'audio/webm') }))
    }
    if (req.method === 'POST' && url.pathname === '/speech/live') return liveOpen(req, res)
    if (req.method === 'POST' && url.pathname.startsWith('/speech/live/')) {
      const [id, verb] = url.pathname.slice('/speech/live/'.length).split('/')
      if (verb === 'stop') live.get(id)?.stop('stop')
      else if (verb) return send(res, 404, '{"error":"not found"}')
      else liveAudio(id, await readRaw(req, 2e6))
      return send(res, 200, '{"ok":true}')
    }
    // Any text read aloud: a message, a question. The page sends it in pieces, cleaned of markup.
    if (req.method === 'POST' && url.pathname === '/speech/say') {
      const body = await readJson(req)
      if (typeof body.text !== 'string' || !body.text.trim()) throw fail(400, 'text is missing')
      if (!speechKey()) throw fail(503, 'Speech is not set up (TINFOIL_API_KEY or data/tinfoil.key is missing)')
      const audio = fs.readFileSync(await speak(body.text, '', String(body.lang ?? '')))
      return send(res, 200, audio, audioType(audio))
    }
    if (req.method === 'GET' && url.pathname.startsWith('/speech/card/')) {
      const card = state.cards.find(c => c.id === path.basename(url.pathname))
      if (!card) return send(res, 404, '{"error":"not found"}')
      return send(res, 200, fs.readFileSync(await speak(cardScript(card))), 'audio/mpeg')
    }
    if (req.method === 'POST' && url.pathname === '/session') {
      // The human's own name and mark for a session; they outlive reconnects.
      const body = await readJson(req)
      const agent = state.agents.find(a => a.id === targetAgent(body.agent))
      // Archiving is for sessions that are gone; one that is online would keep asking into the void.
      if (body.archived === true && links.has(agent.id)) return send(res, 409, '{"error":"a session that is online cannot be archived"}')
      if (body.archived != null) agent.archived = body.archived === true
      // Sessions that share a group are shown as a pair; null takes a session out of its group.
      if ('group' in body) agent.group = body.group == null ? null : String(body.group).trim().slice(0, 40) || null
      if (body.label != null) agent.label = String(body.label).trim().slice(0, 60)
      if (body.icon != null) {
        agent.icon = String(body.icon).slice(0, 80)
        // Picked by hand it is the human's and the agent leaves it alone; cleared, the agent may choose again.
        if (agent.icon) agent.icon_by = 'human'
        else delete agent.icon_by
      }
      if ('before' in body) moveSession(agent, body.before)
      commit()
      return send(res, 200, '{"ok":true}')
    }
    if (req.method === 'POST' && url.pathname === '/star') {
      const body = await readJson(req)
      const agent = state.agents.find(a => a.id === targetAgent(body.agent))
      agent.starred = Boolean(body.starred)
      commit()
      return send(res, 200, '{"ok":true}')
    }
    if (req.method === 'POST' && url.pathname === '/reopen') {
      const body = await readJson(req)
      await reopen(String(body.card_id))
      return send(res, 200, '{"ok":true}')
    }
    if (req.method === 'POST' && url.pathname === '/decide') {
      const body = await readJson(req, UPLOAD_BODY)
      if (body.keys != null && !Array.isArray(body.keys)) throw new Error('keys must be a list')
      if (JSON.stringify([body.note ?? '', body.notes ?? null]).length > 1e6) throw new Error('body too large')
      // What the human attached to the note of the answer. An answer that is not taken keeps none of it.
      const files = storeUploads(body.attachments)
      try {
        const seen = body.revised === undefined ? undefined : body.revised ?? null
        if (body.trust === true) {
          // Leaving it to the agent is no choice of options; it carries a note at most.
          if (body.key != null || body.keys != null) throw new Error('trust leaves the choice to the agent; send it without key or keys')
          await trust(String(body.card_id), String(body.note ?? '').trim(), seen)
          for (const a of files) fs.rmSync(uploadPath(a), { force: true })
        } else await decide(String(body.card_id), body.keys ?? String(body.key), String(body.note ?? '').trim(), seen, body.notes, files, body.marks)
      } catch (err) {
        for (const a of files) fs.rmSync(uploadPath(a), { force: true })
        throw err
      }
      return send(res, 200, '{"ok":true}')
    }
    if (req.method === 'POST' && url.pathname === '/shred') {
      const body = await readJson(req, UPLOAD_BODY)
      const files = storeUploads(body.attachments)
      try {
        await shred(String(body.card_id), String(body.note ?? '').trim().slice(0, NOTE_MAX), body.marks, files)
      } catch (err) {
        for (const a of files) fs.rmSync(uploadPath(a), { force: true })
        throw err
      }
      return send(res, 200, '{"ok":true}')
    }
    if (req.method === 'POST' && url.pathname === '/close') {
      const body = await readJson(req)
      await closeInfo(String(body.card_id))
      return send(res, 200, '{"ok":true}')
    }
    if (req.method === 'POST' && url.pathname === '/draft') {
      // Room for the marks, which may hold drawings.
      const body = await readJson(req, 2 * MARKS_BYTES)
      setDraft(String(body.card_id), body)
      return send(res, 200, '{"ok":true}')
    }
    if (req.method === 'POST' && url.pathname === '/handback') {
      // The human takes a card back that they had handed to the agent, before the agent reworked it.
      const body = await readJson(req)
      if (body.clear !== true) throw new Error('handback takes { card_id, clear: true }; a card is handed back with /message and handback: true')
      const card = state.cards.find(c => c.id === String(body.card_id))
      if (!card) throw new Error('unknown card')
      if (card.status !== 'open' || card.with_agent == null) throw fail(409, 'this card is not with the agent')
      delete card.with_agent
      addEvent('handback_withdrawn', card, card.title)
      commit()
      await deliver(card.agent, 'notifications/claude/channel', {
        content: `The human took "${card.title}" back; there is no need to rework or explain it. If you already have, that is fine.`,
        meta: { kind: 'handback_withdrawn', card_id: card.id },
      })
      return send(res, 200, '{"ok":true}')
    }
    if (url.pathname.startsWith('/pad/') && await padRoute(req, res, url)) return
    // Last, so no file can stand in for a route: whatever else lies in client/web, mockups and prototypes included.
    if (req.method === 'GET') {
      const found = staticFile(url.pathname)
      if (found?.redirect) {
        res.writeHead(302, { Location: found.redirect + url.search })
        return res.end()
      }
      if (found) return send(res, 200, fs.readFileSync(found.file), MIME[path.extname(found.file)])
    }
    return send(res, 404, '{"error":"not found"}')
  } catch (err) {
    return send(res, err.status ?? 400, JSON.stringify({ error: err.message }))
  }
})

// ---- hub or spoke ----------------------------------------------------------

let role = 'starting'
let selfId = null
// True while this process can act for its agent: it is the hub, or its link to the hub stands.
let up = false
const waiting = new Set()
const RETRY = 'the board is restarting and did not take this call; try again in a moment'

function setUp(value) {
  up = value
  if (!up) return
  for (const go of waiting) go()
  waiting.clear()
}

// A call made while the hub changes hands waits a moment for the new link and
// then fails in a way the agent can retry, instead of hanging.
const whenUp = () => (up ? Promise.resolve() : new Promise((resolve, reject) => {
  const go = () => { clearTimeout(timer); resolve() }
  const timer = setTimeout(() => { waiting.delete(go); reject(new Error(RETRY)) }, LINK_WAIT)
  waiting.add(go)
}))

// Nothing may be sent to Claude Code before it has finished the MCP handshake,
// or the first message after a start is lost.
let markInitialized
const initialized = new Promise(resolve => { markInitialized = resolve })
const notifySelf = (method, params) => {
  initialized.then(() => mcp.notification({ method, params })).catch(err => console.error(`[board] notify failed: ${err.message}`))
  return true
}

// Set while a link to the hub stands: drops it and links again.
let relink = () => {}
let misses = 0
// True once a hub of its own has greeted this spoke: from then on the port is the hub's to keep.
let dedicated = false

const hubPost = (route, body, ms) => hubFetch(route, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: selfId, instance: INSTANCE, ...body }) }, ms)

async function hubFetch(route, init, ms = HUB_TIMEOUT, again = true) {
  let res, out
  try {
    res = await fetch(`http://127.0.0.1:${PORT}${route}`, { method: 'POST', ...init, headers: { ...init.headers, 'x-board-token': TOKEN }, signal: AbortSignal.timeout(ms) })
    out = await res.json()
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error(`the board did not answer within ${Math.round(ms / 1000)} s; the call may or may not have gone through, so check (e.g. with list_cards) before repeating it`)
    throw new Error(RETRY)
  }
  // The hub does not know this session (any more), whatever this process believes.
  if (res.status === 409) {
    if (up) relink()
    throw new Error(RETRY)
  }
  // The token was rotated while the link stood; the file has the new one.
  if (res.status === 403 && again && adoptToken()) return hubFetch(route, init, ms, false)
  if (!res.ok) throw new Error(out?.error ?? 'the board refused the request')
  return out
}

// The program on the other end of stdio names itself when MCP initialises.
function reportClient() {
  const info = mcp.getClientVersion()
  if (!info || !selfId || !up) return
  const fields = { client: [info.name, info.version].filter(Boolean).join(' ') }
  if (role === 'hub') setProfile(selfId, fields)
  else hubPost('/agent/profile', { fields }, Math.min(HUB_TIMEOUT, 10000)).catch(() => {})
}
mcp.oninitialized = () => {
  markInitialized()
  reportClient()
}

let cleaning = false
let hubSince = 0

// Once: the board that state.json held goes into the database, and is read back to see that it arrived whole.
// state.json is not touched; it stays as the backup of the day the board moved.
function moveIn() {
  let off
  try {
    board.write(state)
    off = board.differences({ ...state })
    // The plainest sign that something went wrong: the file had cards, messages or sessions and the database has none.
    const arrived = board.read() ?? {}
    for (const [kind, n] of Object.entries(jsonCounts)) if (n > 0 && !(arrived[kind]?.length > 0)) off.push(`state.json has ${n} ${kind}, the database none`)
  } catch (err) {
    off = [err.message]
  }
  if (off.length) {
    // Rather the old way than a board that lost something: the database is emptied again and state.json stays the truth.
    console.error(`[board] the state did not arrive whole in ${board.file} (${off.join(', ')}); staying with state.json`)
    try { board.write({}) } catch {}
    try { board.clear() } catch {}
    board.close()
    board = null
    process.env.BOARD_STORE = 'json'
    return
  }
  console.error(`[board] the state moved from state.json into ${board.file}: ${state.cards.length} cards, ${state.messages.length} messages, ${state.agents.length} sessions. state.json is kept as it was and no longer written`)
}

function becomeHub() {
  role = 'hub'
  misses = 0
  hubSince = Date.now()
  adoptToken()
  adminKey = process.env.BOARD_ADMIN_TOKEN || readSecret(ADMIN_FILE) || mintSecret(ADMIN_FILE)
  adminLog = readAdminLog()
  // Only a spoke that takes over has fellow spokes on their way back.
  const takeover = selfId != null
  links.clear()
  state = load(slug(SELF.name))
  if (fromJson) moveIn()
  // A hub of its own usually starts while sessions are running that were linked to the hub before it.
  reservedUntil = takeover || HUB_ONLY ? Date.now() + 3000 : 0
  if (!HUB_ONLY) selfId = register({ ...SELF, id: selfId }, { instance: INSTANCE, strict: true, send: notifySelf })
  state.hub = selfId
  commit()
  flush(selfId)
  setUp(true)
  reportClient()
  purge()
  if (padSupport()) console.error(`[board] ${padSupport()}`)
  if (!cleaning) setInterval(purge, 6 * 3600000).unref()
  cleaning = true
  writeLinks()
  console.error(`[board] hub on ${HOST}:${PORT} ${HUB_ONLY ? 'without a session of its own' : `as "${selfId}"`}, links in ${path.join(DATA, 'url.txt')}${process.env.BOARD_ADMIN_TOKEN ? '' : `, admin key in ${ADMIN_FILE}`}`)
}

// Someone else has the port: link to them and stay linked. If the link drops,
// the hub's session ended, so try for the port again.
function joinHub() {
  role = 'spoke'
  let over = false
  let watchdog
  const retry = () => {
    if (over) return
    over = true
    clearTimeout(watchdog)
    setUp(false)
    req.destroy()
    // Quick while a takeover is likely, slower when the port is held by something that will not link.
    setTimeout(dedicated ? joinHub : start, (misses++ > 3 ? 2000 : 150) + Math.random() * 500)
  }
  // Silence means the hub is gone or stuck, even if the connection still looks open.
  const expect = ms => {
    clearTimeout(watchdog)
    watchdog = setTimeout(retry, ms)
  }
  const query = new URLSearchParams({ ...SELF, id: selfId ?? '', instance: INSTANCE })
  const req = http.get({ host: '127.0.0.1', port: PORT, path: `/agent/link?${query}`, headers: { 'x-board-token': TOKEN } }, res => {
    if (res.statusCode !== 200) {
      res.resume()
      // Refused: the hub may hold a token that was written after this process read the file.
      adoptToken()
      return retry()
    }
    let buffer = ''
    let beat = 0
    res.setEncoding('utf8')
    res.on('data', chunk => {
      if (beat) expect(beat * 3)
      buffer += chunk
      for (let at; (at = buffer.indexOf('\n\n')) >= 0;) {
        const frame = buffer.slice(0, at)
        buffer = buffer.slice(at + 2)
        if (!frame.startsWith('data: ')) continue
        let msg
        try { msg = JSON.parse(frame.slice(6)) } catch { return retry() }
        if (msg.hello) {
          selfId = msg.hello
          dedicated = msg.dedicated === true
          misses = 0
          // A hub running an older server.mjs sends no pings; then only a closed connection counts.
          beat = Number(msg.ping) || 0
          if (beat) expect(beat * 3)
          else clearTimeout(watchdog)
          console.error(`[board] linked to the hub on port ${PORT} as "${selfId}"`)
          setUp(true)
          reportClient()
        } else if (msg.method) notifySelf(msg.method, msg.params)
      }
    })
    res.on('close', retry)
  })
  req.on('error', retry)
  relink = retry
  expect(LINK_WAIT)
}

function start() {
  // listen() keeps its callback registered after a failed attempt, so both
  // listeners are taken off by hand; otherwise a takeover runs becomeHub twice.
  const failed = err => {
    httpServer.off('listening', listening)
    if (err.code !== 'EADDRINUSE') console.error(`[board] http error: ${err.message}`)
    // With no agent to speak for there is nothing to link; wait for the port instead.
    if (HUB_ONLY) return setTimeout(start, 200)
    joinHub()
  }
  const listening = () => {
    httpServer.off('error', failed)
    httpServer.on('error', err => console.error(`[board] http error: ${err.message}`))
    becomeHub()
  }
  httpServer.once('error', failed)
  httpServer.once('listening', listening)
  httpServer.listen(PORT, HOST)
}
start()

// Claude Code owns this process: when it closes the pipe, stop serving too.
// A hub of its own has no Claude Code and runs until it is stopped.
if (!HUB_ONLY) {
  process.stdin.on('end', () => process.exit(0))
  process.stdin.on('close', () => process.exit(0))
  await mcp.connect(new StdioServerTransport())
}
