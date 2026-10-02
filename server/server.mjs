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
import { kindOf, MIME, MAX_ASSET, ASSET_TYPES, ASSET_LABEL, ASSET_MAGIC, ASSET_ID, ASSET_KEY, ASSET_BLOB_MAX, prepareAsset, assetUpload, assetLink } from './asset-envelope.mjs'

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
function load(owner) {
  let raw = {}
  try {
    raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object')
  } catch (err) {
    raw = {}
    // The next commit would overwrite a file that could not be read; keep it for a look.
    if (err.code !== 'ENOENT') {
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
  const agents = list('agents').filter(a => a.id).map(a => ({ ...a, online: false }))
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
    .sort((a, b) => rank(b) - rank(a) || a.created - b.created || a.number - b.number)
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
const newId = () => crypto.randomBytes(4).toString('hex')

// Written whole and then swapped in: a hub that dies in the middle of a write
// leaves the previous file behind, not half of a new one.
function save() {
  const tmp = `${STATE_FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, STATE_FILE)
}

// The page gets everything except what is still waiting to be delivered to agents.
const frameOf = () => `data: ${JSON.stringify({ ...state, pending: undefined })}\n\n`

function commit() {
  state.queue = queueOf(state.cards, state.agents)
  for (const a of state.agents) a.online = links.has(a.id)
  state.speech = Boolean(speechKey())
  save()
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
    multiple: false, choice: null, choices: [], note: '', summary: '', created: Date.now(), decided: null, ...fields,
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
const expired = cutoff => state.cards.filter(c => c.status !== 'open' && (c.decided ?? c.created) < cutoff)

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
    for (const a of card.attachments ?? []) fs.rmSync(path.join(FILES, path.basename(a.url)), { force: true })
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

function storeAttachment(file) {
  if (typeof file !== 'string' || !file) throw new Error('an attachment must be the path of a file')
  const src = path.resolve(file)
  const stat = fs.statSync(src)
  if (!stat.isFile()) throw new Error(`not a file: ${file}`)
  if (stat.size > MAX_ATTACHMENT) throw new Error(`attachment larger than ${MAX_ATTACHMENT / 1024 / 1024} MB: ${file}`)
  const ext = path.extname(src).toLowerCase()
  const stored = `${newId()}${ext}`
  fs.copyFileSync(src, path.join(FILES, stored))
  const kind = kindOf(ext)
  return { name: path.basename(src), url: `/files/${stored}`, kind, image: kind === 'image', size: stat.size }
}

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
      'Write replies as short chat messages; light markdown (bold, inline code, code fences, bullet lists) is rendered. Attach images, rendered videos, audio or other files to a reply by absolute path when showing beats telling; video and audio play inline on the board.',
      'When you need the human to choose something, do not ask in chat: call create_decision with a one-line question as title, a short body, and 2-6 options. Each option has a stable machine key, a human label, and ideally a one-line detail naming its consequence. Attach screenshots, mockups, or diffs by absolute path when they help the choice.',
      'When several options can hold at once (which of these to include, which to delete), set multiple: true: the human ticks any number of options and sends them together. The decision then arrives with choices="a,b", every chosen key comma-separated in the order of the options, next to choice, which is the first of them; recommended may then be a list of keys.',
      'Make simple decisions quick to answer: if a question is really yes or no, give exactly two options with short labels (under 18 characters), keep the body under about three lines, and attach nothing. Such cards are answered with one tap straight from the inbox; anything with more options, longer text, or attachments makes the human open the card first. Put the option you would pick first.',
      'Say which option you would pick: set recommended to its key. The board circles it by hand, the human still decides.',
      'When a question is easier to grasp with a picture, attach a small drawing, diagram or screenshot to the card (attachments), and name the option you would pick in recommended.',
      'The human sees one card at a time, the top of the stack; urgency decides the order (most urgent first, then oldest first), so set it honestly on every card.',
      'critical: you are blocked and nothing else can proceed. high: it blocks your current task, but you have other work. normal (default): needed soon, nothing waits on it yet. low: nice to know, no work depends on it.',
      'For high and critical, give an urgency_reason: one short phrase, in the human\'s language, saying what is waiting. If everything is urgent, nothing is; most cards are normal.',
      'Keep the stack true as your work moves: when an open card starts blocking you, raise it with set_urgency; lower it if the pressure is gone; and call withdraw_card as soon as a question became moot, so the human never answers something you no longer need. list_cards shows the current stack.',
      'The choice arrives later as <channel source="board" kind="decision" card_id="..." choice="KEY">; the body is the human\'s note if they wrote one. Act on it, then call close_card with a one-line summary of what you did.',
      'Do not block waiting for a decision: keep working on whatever does not depend on it.',
      'A chat message with a card_id (<channel source="board" kind="chat" card_id="...">) is a question back about that card, not an answer to it; the card stays open. Answer it with reply, passing the same card_id, and if your answer changes the question, update the card: withdraw it and ask again with the clearer wording or options.',
      'When the session starts, call introduce once with the model you are running as and a one-line description of your task, so the human can tell the sessions apart.',
      'Other agents may share this board; the human sees all stacks merged into one, ordered by urgency. You only see and change your own cards and status lines.',
      'You can speak: create_voiceover turns text into an MP3 with a natural voice and returns its path, for narration in videos you render or a spoken update attached to a reply. The human may dictate messages, so expect transcription slips in chat and read them charitably.',
      'The human has a lasting canvas for sketches and annotated screenshots. <channel source="board" kind="scribble" image_path="/abs/view.png" canvas_path="/abs/whole.png"> means they drew and pressed send: image_path is the part of the canvas they were looking at, so read it first; canvas_path is the entire canvas if you need the surroundings. A chat message explaining it often follows right after.',
      'The human answers with one tap and can take an answer back: <channel source="board" kind="decision_reopened" card_id="..." previous_choice="KEY"> means the card is open again. Stop acting on the old choice, undo what you safely can, tell them briefly via reply what you rolled back, and wait for the new choice.',
      'To hand the human, or anyone they choose, a page or a file as a link, call publish_asset: a self-contained HTML page (inline CSS and scripts, images as data: URLs; nothing is loaded from the network), an image, a video, an audio file or any other file. It is encrypted before it leaves this process and the key is part of the link, so whoever has the link can open it without a login. revoke_asset ends a link.',
      'Keep the status strip current with set_status: one line per work stream or subagent, a traffic light the human reads at a glance. decision (red) = waiting on the human, pass the card_id of the question; working (yellow) = in progress; done (green) = finished. Update a line the moment its state changes and clear the strip with clear_status when a new piece of work starts.',
    ].join(' '),
  },
)

const TOOLS = [
  {
    name: 'reply',
    description: 'Send a chat message to the human on the Trommi board.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The message to show in the chat' },
        details: { type: 'string', description: 'Optional longer material shown collapsed under the message: your reasoning, what you tried, command output, a diff. Markdown. The human opens it only if they want to.' },
        attachments: {
          type: 'array',
          description: 'Absolute paths of files to show with the message; images, videos (mp4, webm, mov) and audio play inline, anything else is a download link',
          items: { type: 'string' },
        },
        card_id: { type: 'string', description: 'When you answer a question the human asked back about a card (a chat message that carried card_id): that card. The board shows your answer with the card.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'create_decision',
    description: 'Put a decision card on the board for the human to answer. Returns the card id.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The question, one line' },
        body: { type: 'string', description: 'Context the human needs to decide' },
        options: {
          type: 'array',
          minItems: 2,
          description: 'The choices offered',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'Stable identifier returned to you, e.g. "sqlite"' },
              label: { type: 'string', description: 'What the human sees on the button' },
              detail: { type: 'string', description: 'Optional one-line consequence of this choice' },
            },
            required: ['key', 'label'],
          },
        },
        attachments: {
          type: 'array',
          description: 'Absolute paths of files to show on the card; images render inline',
          items: { type: 'string' },
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
      },
      required: ['title', 'options'],
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
    description: 'Tell the board who you are. Call it once when the session starts, and again when your task changes; the human sees it on the agents overview.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'The model you are running as, e.g. "Claude Opus 5.5"' },
        task: { type: 'string', description: 'What you are working on in this session, one line' },
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
    description: 'List all cards with number, status, urgency, chosen option, and queue_position (1 = the card the human sees now, null = not open).',
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
  reply: { text: 'The migration is written and **green locally**.', details: 'Ran `npm test`: 48 of 48 pass.\nThe slow one was the index on `orders`.', attachments: ['/home/me/project/out/before-after.png'] },
  create_decision: {
    title: 'Run the migration on production now?', body: 'It locks `orders` for about 40 seconds.', urgency: 'high', urgency_reason: 'the deploy waits on it', recommended: 'tonight',
    options: [{ key: 'tonight', label: 'Tonight at 2', detail: 'Hardly anyone is online' }, { key: 'now', label: 'Now', detail: 'Short outage for whoever is online' }],
  },
  set_urgency: { card_id: 'a1b2c3d4', urgency: 'critical', reason: 'nothing else is left to do' },
  withdraw_card: { card_id: 'a1b2c3d4', reason: 'the staging run answered it' },
  close_card: { card_id: 'a1b2c3d4', summary: 'Migration ran at 02:00, 38 seconds' },
  set_status: { id: 'migration', label: 'Migration', state: 'decision', detail: 'waiting for the go-ahead', card_id: 'a1b2c3d4' },
  clear_status: { id: 'migration' },
  introduce: { model: 'Claude Opus 5.5', task: 'Prepare migration and deploy' },
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
    content: 'the message', meta: { kind: 'chat' }, optional: { card_id: 'set when the human asks back about an open card instead of answering it; answer with reply and the same card_id' },
    example: '<channel source="board" kind="chat">Please check the logs first.</channel>',
  },
  {
    direction: 'to_agent', method: 'notifications/claude/channel', kind: 'decision', when: 'The human answered a decision card.',
    content: 'the human\'s note, or a sentence naming the card and the chosen key', meta: { kind: 'decision', card_id: 'the card', choice: 'key of the chosen option; of several, the first' },
    optional: { choices: 'only for a card made with multiple: true: every chosen key, comma-separated, in the order of the options' },
    example: '<channel source="board" kind="decision" card_id="a1b2c3d4" choice="tonight">After the backup, please.</channel>',
  },
  {
    direction: 'to_agent', method: 'notifications/claude/channel', kind: 'decision_reopened', when: 'The human took an answer back; the card is open again.',
    content: 'a sentence saying which answer was taken back', meta: { kind: 'decision_reopened', card_id: 'the card', previous_choice: 'key of the answer that no longer holds' },
    optional: { previous_choices: 'only for a card made with multiple: true: every key that was chosen, comma-separated' },
    example: '<channel source="board" kind="decision_reopened" card_id="a1b2c3d4" previous_choice="tonight">…</channel>',
  },
  {
    direction: 'to_agent', method: 'notifications/claude/channel', kind: 'scribble', when: 'The human drew on the canvas and pressed send.',
    content: 'the caption, or a sentence explaining the two pictures',
    meta: { kind: 'scribble', scribble_id: 'this moment of the canvas', image_path: 'PNG of what the human was looking at', canvas_path: 'PNG of the whole canvas', canvas_doc: 'the drawing as JSON' },
    example: '<channel source="board" kind="scribble" scribble_id="9f2c41d07a3e" image_path="/…/scribbles/9f2c41d07a3e.png" canvas_path="/…/scribbles/canvas-api.png" canvas_doc="/…/scribbles/canvas-api.json">This button, further left.</channel>',
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

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = req.params.arguments ?? {}
  // The hub copies attachments; a relative path must mean this session's folder, not the hub's.
  if (Array.isArray(args.attachments)) args.attachments = args.attachments.map(f => (typeof f === 'string' && f ? path.resolve(f) : f))
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

// Runs on the hub, for the hub's own agent and on behalf of spokes.
function runTool(agent, name, args) {
  if (!args || typeof args !== 'object') args = {}
  switch (name) {
    case 'reply': {
      const about = args.card_id == null ? {} : { card_id: findCard(agent, args.card_id).id }
      addMessage(agent, 'agent', String(args.text ?? ''), listArg(args.attachments, 'attachments').map(storeAttachment), { ...(args.details ? { details: String(args.details) } : {}), ...about })
      return 'sent'
    }
    case 'create_decision': {
      const options = listArg(args.options, 'options').map(o => ({
        key: String(o?.key), label: String(o?.label), detail: o?.detail ? String(o.detail) : '',
      }))
      const keys = new Set(options.map(o => o.key))
      if (options.length < 2 || keys.size !== options.length) {
        throw new Error('options need at least two entries with unique keys')
      }
      const urgency = urgencyArg(args.urgency, 'normal')
      const multiple = args.multiple === true
      // One key, or for a card that takes several answers a list of them; stored the way it was given.
      const advised = args.recommended == null ? [] : [args.recommended].flat().map(String)
      const stray = advised.find(key => !keys.has(key))
      if (stray != null) throw new Error(`recommended must be the key of one of the options; got "${stray}"`)
      if (Array.isArray(args.recommended) && !multiple) throw new Error('recommended as a list needs multiple: true; a card with one answer has one recommendation')
      const card = addCard(agent, 'decision', {
        multiple, recommended: Array.isArray(args.recommended) ? advised : advised[0] ?? null,
        urgency, urgency_reason: String(args.urgency_reason ?? '').trim(),
        title: String(args.title ?? ''), body: String(args.body ?? ''),
        options, attachments: listArg(args.attachments, 'attachments').map(storeAttachment),
      })
      addEvent('asked', card, card.title)
      commit()
      return `card ${card.id} created as Nr. ${card.number}, position ${state.queue.indexOf(card.id) + 1} of ${state.queue.length} in the stack; the choice will arrive as a channel event`
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
    case 'introduce':
      setProfile(agent, { model: args.model, task: args.task })
      return 'noted'
    case 'create_voiceover':
      return speak(args.text, String(args.style ?? '')).then(file => `voiceover written to ${file}`)
    case 'list_cards':
      return JSON.stringify(state.cards.filter(c => c.agent === agent).map(c => ({
        id: c.id, number: c.number, kind: c.kind, status: c.status,
        urgency: c.urgency, urgency_reason: c.urgency_reason,
        queue_position: state.queue.indexOf(c.id) + 1 || null,
        title: c.title, multiple: c.multiple, choice: c.choice, choices: c.choices, note: c.note,
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

// answer is one key, or for a card that takes several a list of keys.
async function decide(cardId, answer, note) {
  const card = state.cards.find(c => c.id === cardId)
  if (!card) throw new Error('unknown card')
  if (card.status !== 'open') throw new Error('card already decided')
  if (Array.isArray(answer) && !card.multiple) throw new Error('this card takes one answer; send key, not keys')
  const given = new Set([answer].flat().map(String))
  if (!given.size) throw new Error('keys must name at least one option')
  if ([...given].some(k => !card.options.some(o => o.key === k))) throw new Error('unknown option')
  // In the order of the options, whatever order they were ticked in.
  const chosen = card.options.filter(o => given.has(o.key))
  const key = chosen[0].key
  card.choices = chosen.map(o => o.key)
  // The first one, for clients and agents that know only one answer.
  card.choice = key
  card.note = note
  card.decided = Date.now()
  // A permission verdict needs no follow-up from Claude, so it is done at once.
  card.status = card.kind === 'permission' ? 'done' : 'decided'
  if (card.kind === 'decision') addEvent('decided', card, chosen.map(o => o.label).join(', '))
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
      content: note || `Decision on "${card.title}": ${card.choices.join(', ')}`,
      // meta values are strings, so several keys travel as one, comma-separated.
      meta: { kind: 'decision', card_id: card.id, choice: key, ...(card.multiple ? { choices: card.choices.join(',') } : {}) },
    })
  }
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
  if (card.kind !== 'decision') throw new Error('only decisions can be reopened')
  if (card.status === 'open') throw new Error('card is already open')
  if (card.choice == null) throw new Error('the agent withdrew this card')
  const previous = card.choice
  const all = card.choices?.length ? card.choices : [previous]
  const label = all.map(key => card.options.find(o => o.key === key)?.label ?? key).join(', ')
  Object.assign(card, { status: 'open', choice: null, choices: [], note: '', summary: '', decided: null })
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

// Text to an MP3 file. The same sentence is only synthesised once.
async function speak(input, instructions = '') {
  const clean = String(input ?? '').trim().slice(0, 4000)
  if (!clean) throw new Error('nothing to say')
  const file = path.join(SPEECH, `${crypto.createHash('sha256').update(`${TTS_MODEL}|${instructions}|${clean}`).digest('hex').slice(0, 24)}.mp3`)
  if (!fs.existsSync(file)) {
    const res = await speechFetch('/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: TTS_MODEL, input: clean, response_format: 'mp3', ...(instructions ? { instructions } : {}) }),
    })
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()))
  }
  return file
}

async function transcribe(audio, type) {
  const form = new FormData()
  form.append('model', STT_MODEL)
  form.append('file', new Blob([audio], { type }), `audio.${type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : type.includes('wav') ? 'wav' : type.includes('mpeg') ? 'mp3' : 'webm'}`)
  const res = await speechFetch('/audio/transcriptions', { method: 'POST', body: form })
  return String((await res.json()).text ?? '').trim()
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
  return items.flatMap(item => item.attachments ?? []).flatMap(a => {
    if (a?.kind === 'scribble' && a.id) return [[SCRIBBLES, `${a.id}.png`], [SCRIBBLES, `${a.id}.json`]]
    return typeof a?.url === 'string' && a.url.startsWith('/files/') ? [[FILES, path.basename(a.url)]] : []
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
const APP_PATH = /^\/($|s\/|agents$|inbox$)/
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
      return send(res, 200, JSON.stringify({ version: VERSION, retention_days: RETENTION_DAYS, max_asset_mb: MAX_ASSET / 1024 / 1024, tools: TOOLS.map(t => ({ ...t, example: TOOL_EXAMPLES[t.name] })), events: CHANNEL_EVENTS }))
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
      const type = MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream'
      const size = fs.statSync(file).size
      const headers = {
        'Content-Type': type,
        'Accept-Ranges': 'bytes',
        // Attachments come from the agent's workspace; never let one run as a page.
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
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
      const body = await readJson(req)
      const msg = String(body.text ?? '').trim()
      if (!msg) return send(res, 400, '{"error":"empty message"}')
      const agent = targetAgent(body.agent)
      // A question back about a card instead of an answer to it. Only an open card of this agent counts; the card stays open.
      const about = state.cards.some(c => c.id === body.card_id && c.agent === agent && c.status === 'open') ? { card_id: body.card_id } : {}
      addMessage(agent, 'user', msg, [], about)
      await deliver(agent, 'notifications/claude/channel', { content: msg, meta: { kind: 'chat', ...about } })
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
      if (body.icon != null) agent.icon = String(body.icon).slice(0, 80)
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
      const body = await readJson(req)
      if (body.keys != null && !Array.isArray(body.keys)) throw new Error('keys must be a list')
      await decide(String(body.card_id), body.keys ?? String(body.key), String(body.note ?? '').trim())
      return send(res, 200, '{"ok":true}')
    }
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
    return send(res, 400, JSON.stringify({ error: err.message }))
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
  // A hub of its own usually starts while sessions are running that were linked to the hub before it.
  reservedUntil = takeover || HUB_ONLY ? Date.now() + 3000 : 0
  if (!HUB_ONLY) selfId = register({ ...SELF, id: selfId }, { instance: INSTANCE, strict: true, send: notifySelf })
  state.hub = selfId
  commit()
  flush(selfId)
  setUp(true)
  reportClient()
  purge()
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
