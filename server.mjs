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

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.BOARD_PORT || 8790)
const HOST = process.env.BOARD_HOST || '0.0.0.0'
const DATA = process.env.BOARD_DATA || path.join(ROOT, 'data')
const PUBLIC = path.join(ROOT, 'public')
const FILES = path.join(DATA, 'files')
const SCRIBBLES = path.join(DATA, 'scribbles')
const STATE_FILE = path.join(DATA, 'state.json')
// Rendered videos are the big case; the file is copied once and streamed with Range requests.
const MAX_ATTACHMENT = Number(process.env.BOARD_MAX_ATTACHMENT_MB || 1024) * 1024 * 1024
// Answered cards and their attachments are deleted after this many days.
const RETENTION_DAYS = Number(process.env.BOARD_RETENTION_DAYS || 30)
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif'])
const VIDEO_EXT = new Set(['.mp4', '.m4v', '.webm', '.mov'])
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.wav', '.ogg', '.flac'])
const kindOf = ext => (IMAGE_EXT.has(ext) ? 'image' : VIDEO_EXT.has(ext) ? 'video' : AUDIO_EXT.has(ext) ? 'audio' : 'file')
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.json': 'application/json',
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
const slug = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent'

fs.mkdirSync(FILES, { recursive: true })
fs.mkdirSync(SCRIBBLES, { recursive: true })
fs.mkdirSync(SPEECH, { recursive: true })

// The token is the only thing between the network and this session, so it is
// kept across restarts and never logged to the chat.
const TOKEN_FILE = path.join(DATA, 'token')
let TOKEN = process.env.BOARD_TOKEN
if (!TOKEN) {
  try {
    TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
  } catch {}
}
if (!TOKEN) {
  TOKEN = crypto.randomBytes(24).toString('base64url')
  fs.writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 })
}

// ---- state ---------------------------------------------------------------

const URGENCIES = ['low', 'normal', 'high', 'critical']
// Same wording as URGENCY_LABEL in public/js/ui.js, so timeline and card agree.
const URGENCY_LABEL = { low: 'Hat Zeit', normal: 'Normal', high: 'Dringend', critical: 'Blockiert' }

// State files from before urgency existed have no number, urgency or queue,
// and agent messages without attachments; fill those in instead of failing.
function load(owner) {
  let raw = {}
  try {
    raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) ?? {}
  } catch {}
  // Before several agents could share a board nothing named its agent; those
  // records belong to whoever loads them first.
  const messages = (Array.isArray(raw.messages) ? raw.messages : [])
    .map(m => ({ agent: owner, ...(m.from === 'agent' ? { attachments: [] } : {}), ...m }))
  const cards = (Array.isArray(raw.cards) ? raw.cards : []).map(c => ({
    agent: owner, urgency_reason: '', attachments: [], ...c,
    urgency: c.kind === 'permission' || !URGENCIES.includes(c.urgency) ? defaultUrgency(c.kind) : c.urgency,
  }))
  // An approval request belongs to the session that asked; after a restart
  // nobody is waiting for its answer, so it must not sit on top of the stack.
  for (const c of cards) {
    if (c.kind === 'permission' && c.status === 'open') {
      c.status = 'done'
      c.summary = 'Sitzung beendet, bevor die Freigabe beantwortet wurde'
    }
  }
  const numbered = n => Number.isInteger(n) && n > 0
  let next = Math.max(1, numbered(raw.next_number) ? raw.next_number : 1, ...cards.filter(c => numbered(c.number)).map(c => c.number + 1))
  // Cards are stored in creation order, so numbering them in place keeps that order.
  for (const c of cards) if (!numbered(c.number)) c.number = next++
  const tasks = (Array.isArray(raw.tasks) ? raw.tasks : [])
    .filter(t => t && t.id && STATUSES.includes(t.state)).map(t => ({ agent: owner, ...t }))
  const agents = (Array.isArray(raw.agents) ? raw.agents : []).map(a => ({ ...a, online: false }))
  return { agents, messages, cards, tasks, queue: queueOf(cards), next_number: next }
}

// The traffic light the human reads at a glance: red waits on them, yellow is
// being worked on, green is finished.
const STATUSES = ['decision', 'working', 'done']

const defaultUrgency = kind => (kind === 'permission' ? 'critical' : 'normal')

// The stack the human works through: approvals first because Claude Code is
// waiting on them, then by urgency, then oldest first.
function queueOf(cards) {
  const rank = c => (c.kind === 'permission' ? URGENCIES.length : URGENCIES.indexOf(c.urgency))
  return cards
    .filter(c => c.status === 'open')
    .sort((a, b) => rank(b) - rank(a) || a.created - b.created || a.number - b.number)
    .map(c => c.id)
}

let state = null   // set when this process becomes the hub

// Agents that are connected right now: id -> function that hands them a notification.
const links = new Map()
// What an agent missed while its session was away, delivered when it returns.
const pending = new Map()

const clients = new Set()
const newId = () => crypto.randomBytes(4).toString('hex')

function commit() {
  state.queue = queueOf(state.cards)
  for (const a of state.agents) a.online = links.has(a.id)
  state.speech = Boolean(speechKey())
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  const frame = `data: ${JSON.stringify(state)}\n\n`
  for (const res of clients) res.write(frame)
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
    choice: null, note: '', summary: '', created: Date.now(), decided: null, ...fields,
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

function register({ name, cwd, host = '', platform = '' }, link) {
  let id = slug(name)
  for (let n = 2; links.has(id); n++) id = `${slug(name)}-${n}`
  links.set(id, link)
  const known = state.agents.find(a => a.id === id)
  const now = Date.now()
  if (known) Object.assign(known, { name, cwd, host, platform, connected: now, seen: now })
  else state.agents.push({ id, name, cwd, host, platform, model: '', client: '', task: '', joined: now, connected: now, seen: now, online: true })
  commit()
  for (const [method, params] of pending.get(id) ?? []) link(method, params)
  pending.delete(id)
  return id
}

function unregister(id) {
  if (!links.delete(id)) return
  // Its approval requests die with the session.
  for (const c of state.cards) {
    if (c.agent === id && c.kind === 'permission' && c.status === 'open') {
      c.status = 'done'
      c.summary = 'Sitzung beendet, bevor die Freigabe beantwortet wurde'
    }
  }
  const agent = state.agents.find(a => a.id === id)
  if (agent) agent.seen = Date.now()
  commit()
}

// Old answers are not kept forever: the card, its attachment files, and its
// markers in the conversation go together. Open cards are never touched.
function purge() {
  const cutoff = Date.now() - RETENTION_DAYS * 86400000
  const old = state.cards.filter(c => c.status !== 'open' && (c.decided ?? c.created) < cutoff)
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

async function deliver(agent, method, params) {
  const link = links.get(agent)
  if (link) return link(method, params)
  const queue = pending.get(agent) ?? []
  pending.set(agent, [...queue, [method, params]].slice(-50))
}

function urgencyArg(value, fallback) {
  if (value == null && fallback) return fallback
  if (!URGENCIES.includes(value)) throw new Error(`urgency must be one of ${URGENCIES.join(', ')}; got ${JSON.stringify(value)}`)
  return value
}

function storeAttachment(file) {
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
      'Make simple decisions quick to answer: if a question is really yes or no, give exactly two options with short labels (under 18 characters), keep the body under about three lines, and attach nothing. Such cards are answered with one tap straight from the inbox; anything with more options, longer text, or attachments makes the human open the card first. Put the option you would pick first.',
      'The human sees one card at a time, the top of the stack; urgency decides the order (most urgent first, then oldest first), so set it honestly on every card.',
      'critical: you are blocked and nothing else can proceed. high: it blocks your current task, but you have other work. normal (default): needed soon, nothing waits on it yet. low: nice to know, no work depends on it.',
      'For high and critical, give an urgency_reason: one short phrase, in the human\'s language, saying what is waiting. If everything is urgent, nothing is; most cards are normal.',
      'Keep the stack true as your work moves: when an open card starts blocking you, raise it with set_urgency; lower it if the pressure is gone; and call withdraw_card as soon as a question became moot, so the human never answers something you no longer need. list_cards shows the current stack.',
      'The choice arrives later as <channel source="board" kind="decision" card_id="..." choice="KEY">; the body is the human\'s note if they wrote one. Act on it, then call close_card with a one-line summary of what you did.',
      'Do not block waiting for a decision: keep working on whatever does not depend on it.',
      'When the session starts, call introduce once with the model you are running as and a one-line description of your task, so the human can tell the sessions apart.',
      'Other agents may share this board; the human sees all stacks merged into one, ordered by urgency. You only see and change your own cards and status lines.',
      'You can speak: create_voiceover turns text into an MP3 with a natural voice and returns its path, for narration in videos you render or a spoken update attached to a reply. The human may dictate messages, so expect transcription slips in chat and read them charitably.',
      'The human has a lasting canvas for sketches and annotated screenshots. <channel source="board" kind="scribble" image_path="/abs/view.png" canvas_path="/abs/whole.png"> means they drew and pressed send: image_path is the part of the canvas they were looking at, so read it first; canvas_path is the entire canvas if you need the surroundings. A chat message explaining it often follows right after.',
      'The human answers with one tap and can take an answer back: <channel source="board" kind="decision_reopened" card_id="..." previous_choice="KEY"> means the card is open again. Stop acting on the old choice, undo what you safely can, tell them briefly via reply what you rolled back, and wait for the new choice.',
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
]

const text = t => ({ content: [{ type: 'text', text: t }] })

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = req.params.arguments ?? {}
  await ready
  if (role === 'hub') return text(await runTool(selfId, req.params.name, args))
  return text((await hubPost('/agent/tool', { id: selfId, name: req.params.name, args })).text)
})

// Runs on the hub, for the hub's own agent and on behalf of spokes.
function runTool(agent, name, args) {
  switch (name) {
    case 'reply':
      addMessage(agent, 'agent', String(args.text ?? ''), (args.attachments ?? []).map(storeAttachment), args.details ? { details: String(args.details) } : {})
      return 'sent'
    case 'create_decision': {
      const options = (args.options ?? []).map(o => ({
        key: String(o.key), label: String(o.label), detail: o.detail ? String(o.detail) : '',
      }))
      const keys = new Set(options.map(o => o.key))
      if (options.length < 2 || keys.size !== options.length) {
        throw new Error('options need at least two entries with unique keys')
      }
      const urgency = urgencyArg(args.urgency, 'normal')
      const card = addCard(agent, 'decision', {
        urgency, urgency_reason: String(args.urgency_reason ?? '').trim(),
        title: String(args.title ?? ''), body: String(args.body ?? ''),
        options, attachments: (args.attachments ?? []).map(storeAttachment),
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
      addEvent('done', card, card.summary ? `Zurückgezogen: ${card.summary}` : 'Zurückgezogen')
      commit()
      return 'withdrawn'
    }
    case 'close_card': {
      const card = findCard(agent, args.card_id)
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
      if (!task) {
        if (!args.label) throw new Error(`label is required for the new status line "${id}"`)
        task = { agent, id, label: '', state: 'working', detail: '', card_id: null, updated: 0 }
        state.tasks.push(task)
      }
      if (args.label) task.label = String(args.label)
      if (args.detail != null) task.detail = String(args.detail)
      if (args.card_id) findCard(agent, args.card_id)
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
        title: c.title, choice: c.choice, note: c.note,
      })), null, 2)
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
    await ready
    if (role === 'hub') addPermission(selfId, params)
    else await hubPost('/agent/permission', { id: selfId, params })
  },
)

function addPermission(agent, params) {
  addCard(agent, 'permission', {
    request_id: params.request_id,
    title: `Freigabe: ${params.tool_name}`,
    body: `${params.description}\n\n${params.input_preview}`,
    options: [
      { key: 'allow', label: 'Erlauben', detail: '' },
      { key: 'deny', label: 'Ablehnen', detail: '' },
    ],
  })
  commit()
}

async function decide(cardId, key, note) {
  const card = state.cards.find(c => c.id === cardId)
  if (!card) throw new Error('unknown card')
  if (card.status !== 'open') throw new Error('card already decided')
  if (!card.options.some(o => o.key === key)) throw new Error('unknown option')
  card.choice = key
  card.note = note
  card.decided = Date.now()
  // A permission verdict needs no follow-up from Claude, so it is done at once.
  card.status = card.kind === 'permission' ? 'done' : 'decided'
  if (card.kind === 'decision') addEvent('decided', card, card.options.find(o => o.key === key).label)
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
      content: note || `Decision on "${card.title}": ${key}`,
      meta: { kind: 'decision', card_id: card.id, choice: key },
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
  const label = card.options.find(o => o.key === previous)?.label ?? previous
  Object.assign(card, { status: 'open', choice: null, note: '', summary: '', decided: null })
  addEvent('reopened', card, card.title)
  commit()
  await deliver(card.agent, 'notifications/claude/channel', {
    content: `The human took back their answer "${label}" on "${card.title}". Stop acting on it, undo what you safely can, and wait for the new choice.`,
    meta: { kind: 'decision_reopened', card_id: card.id, previous_choice: previous },
  })
}

// ---- speech --------------------------------------------------------------

async function speechFetch(route, init) {
  const key = speechKey()
  if (!key) throw new Error('Sprachfunktionen sind nicht eingerichtet (TINFOIL_API_KEY oder data/tinfoil.key fehlt)')
  const res = await fetch(SPEECH_API + route, { ...init, headers: { ...init.headers, Authorization: `Bearer ${key}` } })
  if (!res.ok) {
    let reason = `${res.status}`
    try { reason = (await res.json()).error?.message ?? reason } catch {}
    throw new Error(`Sprachdienst: ${reason}`)
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
    ? 'Erlauben oder ablehnen?'
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
    if (size > limit) reject(new Error('audio too large'))
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
  req.on('data', chunk => {
    raw += chunk
    if (raw.length > limit) reject(new Error('body too large'))
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
const tokenMatches = given => {
  const a = Buffer.from(String(given ?? '')), b = Buffer.from(TOKEN)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// Spokes talk to the hub here: same machine only, and they must know the token.
async function agentRoute(req, res, url) {
  if (!LOOPBACK.has(req.socket.remoteAddress) || !tokenMatches(req.headers['x-board-token'])) {
    return send(res, 403, '{"error":"forbidden"}')
  }
  try {
    if (req.method === 'GET' && url.pathname === '/agent/link') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
      const write = msg => res.write(`data: ${JSON.stringify(msg)}\n\n`)
      const q = url.searchParams
      const id = register({ name: q.get('name') || 'agent', cwd: q.get('cwd') || '', host: q.get('host') || '', platform: q.get('platform') || '' }, async (method, params) => { write({ method, params }) })
      write({ hello: id })
      req.on('close', () => unregister(id))
      return
    }
    const body = await readJson(req)
    if (!links.has(body.id)) return send(res, 409, '{"error":"agent is not linked"}')
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

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  if (url.pathname.startsWith('/agent/')) return agentRoute(req, res, url)
  if (req.method === 'GET' && url.searchParams.get('t') === TOKEN) {
    res.writeHead(302, {
      // Lax, so following a link to the board from another app still arrives logged in;
      // writes are guarded by the Origin check, which Lax does not weaken.
      'Set-Cookie': `${COOKIE}=${TOKEN}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`,
      Location: url.pathname,
    })
    return res.end()
  }
  if (!authed(req)) return send(res, 401, 'Zugang nur über den Link aus data/url.txt', 'text/plain; charset=utf-8')
  if (req.method !== 'GET' && !sameOrigin(req)) return send(res, 403, '{"error":"forbidden"}')
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'index.html')), 'text/html; charset=utf-8')
    }
    if (req.method === 'GET' && /^\/((css|js)\/|[\w-]+\.html$)/.test(url.pathname)) {
      const file = path.join(PUBLIC, path.normalize(url.pathname))
      if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file)) return send(res, 404, '{"error":"not found"}')
      return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] ?? 'application/octet-stream')
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
      res.write(`data: ${JSON.stringify(state)}\n\n`)
      clients.add(res)
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
        return fs.createReadStream(file, { start, end }).pipe(res)
      }
      res.writeHead(200, { ...headers, 'Content-Length': size })
      return fs.createReadStream(file).pipe(res)
    }
    if (req.method === 'POST' && url.pathname === '/message') {
      const body = await readJson(req)
      const msg = String(body.text ?? '').trim()
      if (!msg) return send(res, 400, '{"error":"empty message"}')
      const agent = targetAgent(body.agent)
      addMessage(agent, 'user', msg)
      await deliver(agent, 'notifications/claude/channel', { content: msg, meta: { kind: 'chat' } })
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
      await decide(String(body.card_id), String(body.key), String(body.note ?? '').trim())
      return send(res, 200, '{"ok":true}')
    }
    return send(res, 404, '{"error":"not found"}')
  } catch (err) {
    return send(res, 400, JSON.stringify({ error: err.message }))
  }
})

// ---- hub or spoke ----------------------------------------------------------

let role = 'starting'
let selfId = null
let markReady
const ready = new Promise(resolve => { markReady = resolve })

const notifySelf = (method, params) => mcp.notification({ method, params }).catch(err => console.error(`[board] notify failed: ${err.message}`))

async function hubPost(route, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-board-token': TOKEN }, body: JSON.stringify(body),
  }).catch(() => { throw new Error('the board is restarting, try again in a moment') })
  const out = await res.json()
  if (!res.ok) throw new Error(out.error ?? 'the board refused the request')
  return out
}

// The program on the other end of stdio names itself when MCP initialises.
function reportClient() {
  const info = mcp.getClientVersion()
  if (!info || !selfId) return
  const fields = { client: [info.name, info.version].filter(Boolean).join(' ') }
  if (role === 'hub') setProfile(selfId, fields)
  else hubPost('/agent/profile', { id: selfId, fields }).catch(() => {})
}
mcp.oninitialized = reportClient

function becomeHub() {
  role = 'hub'
  links.clear()
  state = load(slug(SELF.name))
  selfId = register(SELF, notifySelf)
  reportClient()
  purge()
  setInterval(() => { if (role === 'hub') purge() }, 6 * 3600000).unref()
  const lan = Object.values(os.networkInterfaces()).flat().find(i => i.family === 'IPv4' && !i.internal)
  const hosts = HOST === '0.0.0.0' ? ['localhost', lan?.address].filter(Boolean) : [HOST]
  const urls = hosts.map(h => `http://${h}:${PORT}/?t=${TOKEN}`)
  fs.writeFileSync(path.join(DATA, 'url.txt'), urls.join('\n') + '\n', { mode: 0o600 })
  console.error(`[board] hub on ${HOST}:${PORT} as "${selfId}", links in ${path.join(DATA, 'url.txt')}`)
  markReady()
}

// Someone else has the port: link to them and stay linked. If the link drops,
// the hub's session ended, so try for the port again.
function joinHub() {
  role = 'spoke'
  let over = false
  const retry = () => {
    if (over) return
    over = true
    setTimeout(start, 150 + Math.random() * 500)
  }
  const query = new URLSearchParams(SELF)
  const req = http.get({ host: '127.0.0.1', port: PORT, path: `/agent/link?${query}`, headers: { 'x-board-token': TOKEN } }, res => {
    if (res.statusCode !== 200) { res.resume(); return retry() }
    let buffer = ''
    res.setEncoding('utf8')
    res.on('data', chunk => {
      buffer += chunk
      for (let at; (at = buffer.indexOf('\n\n')) >= 0;) {
        const frame = buffer.slice(0, at)
        buffer = buffer.slice(at + 2)
        if (!frame.startsWith('data: ')) continue
        const msg = JSON.parse(frame.slice(6))
        if (msg.hello) {
          selfId = msg.hello
          console.error(`[board] linked to the hub on port ${PORT} as "${selfId}"`)
          markReady()
          reportClient()
        } else notifySelf(msg.method, msg.params)
      }
    })
    res.on('close', retry)
  })
  req.on('error', retry)
}

function start() {
  httpServer.once('error', err => {
    if (err.code === 'EADDRINUSE') return joinHub()
    console.error(`[board] http error: ${err.message}`)
  })
  httpServer.listen(PORT, HOST, () => {
    httpServer.removeAllListeners('error')
    httpServer.on('error', err => console.error(`[board] http error: ${err.message}`))
    becomeHub()
  })
}
start()

// Claude Code owns this process: when it closes the pipe, stop serving too.
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))

await mcp.connect(new StdioServerTransport())
