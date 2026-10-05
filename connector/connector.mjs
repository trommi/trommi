#!/usr/bin/env node
// connector.mjs: the Trommi connector, the process between one Claude Code session and its room (README "Hub v1:
// the wire protocol").
//
// An MCP stdio server with the board's tools and <channel source="board" kind=...> events. This process is a member
// of the room: it has its own device keys (a key file, mode 0600), signs and encrypts everything it sends, and
// verifies everything it gets (shared/ does all protocol work; tools.mjs holds the tools and translates between them
// and the room; prompt.md holds every text the agent reads). In this file, in order: the lock (one process per key),
// the plugin's hooks, the monitor, updates (hot reload of tools.mjs + prompt.md), the member (key slot, sign-in,
// stream), `say`, the MCP server and the commands.
//
//   node connector/connector.mjs                 MCP server (Claude Code starts it from .mcp.json)
//   node connector/connector.mjs join <link>     join a room with an agent invite link, then exit
//   node connector/connector.mjs whoami          print room, key file and device id
//   node connector/connector.mjs say "<text>" [--session <name>] [--urgent]
//                                              the emergency side channel: one message to the human, then exit
//   node connector/connector.mjs permission      the plugin's PermissionRequest hook (hook JSON on stdin)
//   node connector/connector.mjs notice          the plugin's Notification hook
//   node connector/connector.mjs denied          the plugin's PermissionDenied hook (one quiet line, never a decision)
//   node connector/connector.mjs monitor         the plugin's monitor: prints one line per board event of this session
//
// Environment:
//   TROMMI_INVITE    agent invite link (https://app.trommi.com/join#v1....), needed once per room + machine + folder
//   TROMMI_ROOM      room id (hex), when this folder's key file belongs to more than one room
//   TROMMI_HUB       hub address, default https://hub.trommi.com (an invite link names its own hub)
//   TROMMI_KEYS_DIR  where key files live, default ~/.local/share/trommi/keys
//   TROMMI_FOLDER    the working folder that names the key file, default the current directory
//   TROMMI_PERMISSION_MS  how long the permission hook waits for the human's verdict, default 300000 (5 minutes)
//   TROMMI_SESSION_KEY  which Claude Code session this process belongs to, default its parent pid: a new process of
//                    the same session (a /mcp Reconnect) takes the slot over from the old one (claimSlot)
//
// Key slot: <keys>/<room_id>/<host>-<folder>-<slot>.key; beside it .state.json (cursor, chains, model), .lock and
// .files/ (the human's attachments, decrypted for Claude). A restarted session reuses its slot (pathsOf, pickSlot).

import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import * as toolsModule from './tools.mjs'

// ==== the lock: one process per key ===============================================================================
//
// Node has no flock. Each process that wants a slot writes a claim file of its own, `<lock>.<pid>`. Nobody else
// ever writes or renames it. Then it looks at all claims of the slot:
//   - A claim whose pid is gone is stale. Anyone may delete it, and that never touches a live claim.
//   - If another live claim is there, this process withdraws its own and the slot is busy.
// So at most one process can win. Suppose A and B both claim. Whichever looks second sees the other's claim,
// because each one writes before it looks, so both cannot see only themselves. If both look at the same time,
// both withdraw and retry after a random pause.
//
// A claim file holds the claimer's session key (the parent pid, i.e. the Claude Code session
// that started it). claimSlot() takes a slot over from a live claim of the SAME session: that is a reconnect
// (/mcp -> Reconnect), where Claude Code starts the new connector before the old one is gone. The old one is asked to
// stop (SIGTERM, only when its command line shows a Trommi connector) and given a few seconds; then its claim is
// removed either way. The hub's lease fences the old process if it still runs. Claims of other sessions are never
// taken over: two Claude sessions in one folder stay two slots.

export const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const claimsOf = p => {
  const base = `${path.basename(p.lock_file)}.`
  try { return fs.readdirSync(p.dir).filter(f => f.startsWith(base) && /^\d+$/.test(f.slice(base.length))).map(f => Number(f.slice(base.length))) } catch { return [] }
}
const claimFile = (p, pid = process.pid) => `${p.lock_file}.${pid}`
const sessionOf = (p, pid) => { try { return fs.readFileSync(claimFile(p, pid), 'utf8').trim() } catch { return '' } }
const argsOf = pid => {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0') } catch {}
  try { return execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim().split(/\s+/) } catch { return [] }
}
// A Trommi connector: node with connector.mjs (this file, or the single-file bundle of the same name).
const isConnector = pid => argsOf(pid).slice(0, 3).some(a => /(^|[\\/])connector\.mjs$/.test(a))

/** Take the slot ({ dir, lock_file }); true if this process holds it now. `session` is written into the claim. */
export function lockSlot(p, session = '') {
  fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 })
  for (let attempt = 0; attempt < 8; attempt++) {
    fs.writeFileSync(claimFile(p), session, { mode: 0o600 })
    let others = false
    for (const pid of claimsOf(p)) {
      if (pid === process.pid) continue
      if (alive(pid)) others = true
      else fs.rmSync(claimFile(p, pid), { force: true })
    }
    if (!others) return true
    fs.rmSync(claimFile(p), { force: true })
    pause(5 + Math.random() * 40)   // a holder stays and we end busy; two newcomers drift apart and one wins
  }
  return false
}

/** The live processes that hold the slot, other than this one. */
export const holdersOf = p => claimsOf(p).filter(pid => pid !== process.pid && alive(pid))

/**
 * lockSlot, plus the take-over of a reconnect: live claims of the same `session` are asked to stop, waited for up to
 * `wait_ms`, then removed. Resolves { ok, holders } (holders: the live pids that keep the slot busy).
 */
export async function claimSlot(p, { session = '', wait_ms = 4000 } = {}) {
  if (lockSlot(p, session)) return { ok: true, holders: [] }
  const holders = holdersOf(p)
  if (!session || !holders.length || holders.some(pid => sessionOf(p, pid) !== session)) return { ok: false, holders }
  for (const pid of holders) if (isConnector(pid)) { try { process.kill(pid, 'SIGTERM') } catch {} }
  const until = Date.now() + wait_ms
  while (holders.some(alive) && Date.now() < until) await sleep(100)
  for (const pid of holders) if (sessionOf(p, pid) === session) fs.rmSync(claimFile(p, pid), { force: true })
  return lockSlot(p, session) ? { ok: true, holders: [], took_over: holders } : { ok: false, holders: holdersOf(p) }
}

/** Give the slot back. */
export function unlockSlot(p) { fs.rmSync(claimFile(p), { force: true }) }

// ---- the slot's door: a local socket of the process that holds a keyed slot ----------------------------------
//
// `connector.mjs say` (the emergency side channel) must not open a key that a running connector holds: two processes
// sealing with one key would sign the same sender sequence twice. So it asks the holder instead, over a Unix socket
// in a directory only this user can enter ($XDG_RUNTIME_DIR or the temp dir, /trommi-<uid>, mode 0700). The socket is
// named by a hash of the key file (a socket path has at most ~100 characters). One JSON line in, one JSON line out.
function doorDir() {
  const uid = process.getuid?.() ?? 0
  const dir = path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), `trommi-${uid}`)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const st = fs.lstatSync(dir)
  if (!st.isDirectory() || (process.getuid && st.uid !== uid) || (st.mode & 0o077)) throw new Error(`${dir} is not a private directory of this user`)
  return dir
}
export const doorOf = p => path.join(doorDir(), `${crypto.createHash('sha256').update(path.resolve(p.key_file)).digest('hex').slice(0, 20)}.sock`)

/**
 * Open the door of a slot this process holds: handler(request, gone) -> answer object. `gone` resolves when the
 * caller hung up before the answer (a hook that waited for the human and was ended). Returns close().
 */
export function openDoor(p, handler, log = () => {}) {
  const file = doorOf(p)
  fs.rmSync(file, { force: true })   // this process holds the slot, so a socket file there is a dead holder's
  const server = net.createServer(sock => {
    let buf = '', asked = false
    const gone = new Promise(resolve => sock.on('close', resolve))
    sock.setEncoding('utf8')
    sock.on('error', () => {})
    sock.on('data', async d => {
      if (asked) return
      buf += d
      if (buf.length > 64 * 1024) return sock.destroy()
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      asked = true
      let answer
      try { answer = await handler(JSON.parse(buf.slice(0, nl)), gone) } catch (err) { answer = { ok: false, error: err.message } }
      if (!sock.destroyed) sock.end(JSON.stringify(answer) + '\n')
    })
  })
  server.on('error', err => log(`door not open: ${err.message}`))
  server.listen(file, () => { try { fs.chmodSync(file, 0o600) } catch {} })
  server.unref()
  return () => { server.close(); fs.rmSync(file, { force: true }) }
}

/** Knock at a slot's door: resolves the holder's answer, or rejects (no door, no answer within timeout_ms). */
export function knock(p, request, timeout_ms = 30000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(doorOf(p))
    let buf = ''
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('the connector holding the key did not answer')) }, timeout_ms)
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(JSON.stringify(request) + '\n'))
    sock.on('data', d => { buf += d })
    sock.on('end', () => { clearTimeout(timer); try { resolve(JSON.parse(buf)) } catch { reject(new Error('the connector holding the key gave no answer')) } })
    sock.on('error', err => { clearTimeout(timer); reject(err) })
  })
}

// ==== the plugin's hooks: permission, notice, denied ==============================================================
//
// With the channel flag Claude Code relays a permission prompt to the connector itself (claude/channel/permission).
// Without it nothing is relayed, so the plugin (build.mjs) declares three hooks:
//
//   PermissionRequest  `node connector.mjs permission`  asks the human on the board and answers for them
//   Notification       `node connector.mjs notice`      says "the terminal is waiting for you" when no card stands for it
//   PermissionDenied   `node connector.mjs denied`      one quiet chat line "Auto mode blocked: <tool> — <reason>" (rate-limited,
//                                                     secrets stripped); it approves nothing and never sets retry
//
// A hook is a short-lived process of its own. It never opens the key: it hands its request to the running connector
// of the same Claude Code session through that connector's door (above, the socket `say` uses). The
// connector files the permission request it files in channel mode (bridge.permissionRequest), waits for the human's
// verdict and answers the hook, which prints Claude Code's decision JSON. No verdict in time, no connector, not in a
// room, a session with the channel flag: the hook prints nothing and exits 0, which is "no decision": Claude Code
// goes on with its own dialog in the terminal.
//
// Which connector: the one whose parent is an ancestor of the hook process (both are children of one Claude Code
// process), so two sessions in one folder each ask through their own.

/** How long a permission hook waits for the human (TROMMI_PERMISSION_MS, default 5 minutes, 1 s to 1 h). */
export const waitMs = (env = process.env) => Math.min(3600_000, Math.max(1000, Number(env.TROMMI_PERMISSION_MS) || 300_000))
// The hooks' own limit in the plugin manifest (seconds): above the longest wait, so the hook ends by itself.
export const HOOK_TIMEOUT_S = 3700

// Tools whose "permission" dialog is a question to the human with an answer of its own: never answered from the board.
const DIALOG_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])
// Notifications that mean "a dialog in the terminal waits for the human". idle_prompt is left out on purpose: a
// Trommi session waits for the board most of the time, and a push for each wait would be noise.
export const NOTICE_TYPES = ['permission_prompt', 'elicitation_dialog']

const parentOf = pid => {
  try { return Number(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '').split(' ')[1]) || 0 } catch {}
  try { return Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim()) || 0 } catch { return 0 }
}
/** The pids above this process, nearest first (the hook's Claude Code process is among them). */
export function ancestors(pid = process.ppid, depth = 8) {
  const up = []
  for (let p = pid; p > 1 && up.length < depth; p = parentOf(p)) up.push(p)
  return up
}

/** A line of a tool call or a reason with what looks like a secret taken out: env assignments, tokens, passwords in URLs. */
export function redact(s) {
  return String(s ?? '')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{8,}/gi, 'Bearer …')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s\/@:]+(?::[^\s\/@]*)?@/gi, '$1…@')
    .replace(/(--?[\w-]*(?:token|secret|password|passwd|pass|key|auth|credential)[\w-]*)([= ])\S+/gi, '$1$2…')
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S*)/g, '$1=…')
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9]{16,}|\bgithub_pat_\w{16,}|\bxox[abprs]-[\w-]{8,}|\bAKIA[0-9A-Z]{12,}|\beyJ[\w-]{10,}\.[\w-]{5,}(?:\.[\w-]*)?/g, '…')
    .replace(/\b[A-Za-z0-9+\/_-]{32,}={0,2}/g, '…')
}

const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s }

/** What the card shows of a tool call: its own description if it has one, and the call itself in short. */
export function previewOf(tool_input) {
  const i = tool_input && typeof tool_input === 'object' ? tool_input : {}
  const preview = typeof i.command === 'string' ? i.command : JSON.stringify(i)
  return { description: clip(typeof i.description === 'string' ? i.description : '', 300), input_preview: clip(preview, 600) }
}

/** The line the board gets for a denial: tool and a short reason (or the call itself), redacted and clipped. */
export function deniedText(tool_name, reason, tool_input) {
  const i = tool_input && typeof tool_input === 'object' ? tool_input : {}
  const call = typeof i.command === 'string' ? i.command : typeof i.file_path === 'string' ? i.file_path : typeof i.url === 'string' ? i.url : ''
  const why = redact(reason).replace(/\s+/g, ' ').trim() || redact(call).replace(/\s+/g, ' ').trim()
  return `Auto mode blocked: ${clip(redact(tool_name).replace(/\s+/g, ' ').trim(), 60)}${why ? ` — ${clip(why, 120)}` : ''}`
}

/** The door request for a hook's input JSON, or null when this hook has nothing to ask. */
export function hookRequest(kind, input, env = process.env) {
  if (!input || typeof input !== 'object') return null
  if (kind === 'permission') {
    if (!input.tool_name || DIALOG_TOOLS.has(input.tool_name)) return null
    return { op: 'permission', ancestors: ancestors(), tool_name: String(input.tool_name), ...previewOf(input.tool_input), wait_ms: waitMs(env) }
  }
  if (kind === 'notice') {
    if (!NOTICE_TYPES.includes(input.notification_type)) return null
    return { op: 'notice', ancestors: ancestors(), notification_type: input.notification_type, message: clip(input.message, 300) }
  }
  if (kind === 'denied') {
    if (!input.tool_name) return null
    return { op: 'denied', ancestors: ancestors(), text: deniedText(input.tool_name, input.reason, input.tool_input) }
  }
  return null
}

/** What a hook prints for the connector's answer: Claude Code's decision JSON, or '' for no decision. */
export function hookOutput(kind, answer) {
  if (kind !== 'permission' || !answer?.ok || !['allow', 'deny'].includes(answer.behavior)) return ''
  const decision = answer.behavior === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: 'Denied by the human on the Trommi board.' }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } })
}

const HOOK_ID = /^hook:/

/**
 * The connector's side: answers the hooks' door requests.
 *   heard:   this session has the channel flag, so Claude Code relays permission prompts itself: hooks stay silent
 *   bridge:  () => the bridge, or null while not in a room
 *   say:     (bridge, { text, urgent }) => Promise, the side channel's sender
 * Returns { handle(request, gone) -> answer, verdict(params) -> true when the verdict was a hook's }.
 */
export function createHookDesk({ heard, bridge, say, ppid = process.ppid, log = () => {}, settle_ms = 1500, denied_window_ms = 30_000, now = Date.now }) {
  const waiting = new Map()   // request id -> resolve(behavior)
  let answered_at = 0
  const sleep = ms => new Promise(r => setTimeout(r, ms))

  async function permission(req, gone) {
    const b = bridge()
    if (!b) return { ok: false, error: 'not in a room' }
    const wait_ms = Math.min(3600_000, Math.max(1000, Number(req.wait_ms) || 300_000))
    const request_id = `hook:${crypto.randomBytes(8).toString('hex')}`
    let timer
    const verdict = new Promise(resolve => waiting.set(request_id, resolve))
    try {
      // The card expires when the hook stops waiting: after that the terminal's dialog decides.
      await b.permissionRequest({ request_id, tool_name: req.tool_name, description: req.description, input_preview: req.input_preview, expires_in_ms: wait_ms })
      const behavior = await Promise.race([verdict, gone.then(() => null), new Promise(r => { timer = setTimeout(r, wait_ms, null) })])
      if (!behavior) return { ok: true, timeout: true }
      answered_at = Date.now()
      return { ok: true, behavior }
    } finally { clearTimeout(timer); waiting.delete(request_id) }
  }

  async function notice(req) {
    if (!NOTICE_TYPES.includes(req.notification_type)) return { ok: true, silent: true }
    if (req.notification_type === 'permission_prompt') {
      if (heard) return { ok: true, silent: true }
      // The permission hook of the same prompt may be a moment behind; a card that stands for it, or a verdict just given, is enough.
      await sleep(settle_ms)
      if (waiting.size || Date.now() - answered_at < settle_ms + 10_000) return { ok: true, silent: true }
    }
    const b = bridge()
    if (!b) return { ok: false, error: 'not in a room' }
    const what = String(req.message ?? '').replace(/\s+/g, ' ').trim()
    await say(b, { urgent: true, text: `The terminal is waiting for you${what ? `: ${what}` : '.'}` })
    return { ok: true, said: true }
  }

  // Denials of auto mode: one quiet line per window, the rest counted and told once when the window ends.
  let denied_at = -Infinity, denied_more = 0, denied_timer = null
  async function denied(req) {
    const b = bridge()
    if (!b) return { ok: false, error: 'not in a room' }
    // Redacted again here: the door takes requests from any local process.
    const text = redact(String(req.text ?? '')).replace(/\s+/g, ' ').trim().slice(0, 260)
    if (!/^Auto mode blocked: /.test(text)) return { ok: false, error: 'bad request' }
    if (now() - denied_at < denied_window_ms) { denied_more++; return { ok: true, counted: true } }
    denied_at = now()
    denied_more = 0
    clearTimeout(denied_timer)
    denied_timer = setTimeout(async () => {
      const n = denied_more, bb = bridge()
      denied_more = 0
      if (n && bb) await say(bb, { urgent: false, text: `…and ${n} more Auto mode block${n === 1 ? '' : 's'}.` }).catch(err => log(`denied: ${err.message}`))
    }, denied_window_ms)
    denied_timer.unref?.()
    await say(b, { urgent: false, text })
    return { ok: true, said: true }
  }

  return {
    async handle(req, gone = new Promise(() => {})) {
      if (!Array.isArray(req.ancestors) || !req.ancestors.includes(ppid)) return { ok: false, error: 'another session' }
      if (req.op === 'permission') return heard ? { ok: true, silent: true } : permission(req, gone)
      if (req.op === 'notice') return notice(req)
      if (req.op === 'denied') return denied(req)
      return { ok: false, error: 'unknown request' }
    },
    /** A verdict the bridge reports: true when it answers a hook (then it is not a channel notification). */
    verdict(params) {
      if (!HOOK_ID.test(String(params?.request_id))) return false
      const resolve = waiting.get(params.request_id)
      if (resolve) resolve(params.behavior === 'allow' ? 'allow' : 'deny')
      else log(`verdict for a permission hook that waits no more (${params.request_id})`)
      return true
    },
  }
}

// ==== the monitor: waking an idle session =========================================================================
//
// Without the channel flag Claude Code drops every notifications/claude/channel event. The Trommi plugin
// (build.mjs) therefore declares a monitor: `node connector.mjs monitor`, a background process whose every
// stdout line Claude Code hands to Claude as a notification, waking an idle session. The two processes meet on a
// Unix socket named after the Claude Code process both belong to (the connector is its child, the monitor gets
// CLAUDE_PID), so two sessions in one folder each hear only their own connector.
//
// Security: a monitor line is never board data. The connector writes a line only for an event the core has already
// verified and authorised (a command signed by an active human device of this room, addressed to this agent), and
// the line is a fixed pointer built from sanitised ids ("Trommi: ... call the trommi tool inbox"). The event itself
// reaches Claude only as the inbox tool's result, like any other tool result of this MCP server. Connector-made
// notices (update_available, client too old) never become monitor lines; they come with the next tool result.

/** The socket of one Claude Code process: <runtime dir>/trommi-<uid>/mon-<pid>.sock (the directory is 0700). */
export function socketPath(claudePid, env = process.env) {
  const base = env.XDG_RUNTIME_DIR && fs.existsSync(env.XDG_RUNTIME_DIR) ? env.XDG_RUNTIME_DIR : os.tmpdir()
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'u'
  return path.join(base, `trommi-${uid}`, `mon-${Number(claudePid) || 0}.sock`)
}

// Events of a human's verified command (tools.mjs command()). Anything else gets no line.
const KINDS = {
  chat: 'message', decision: 'answer to a question', info_read: 'info card read', shredded: 'card thrown away',
  decision_reopened: 'answer taken back', handback_withdrawn: 'card taken back', pad: 'pad selection',
}
const cleanId = v => String(v ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
const cleanName = v => String(v ?? '').replace(/[^\p{L}\p{N} ._-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40)

/** The one line the monitor prints for a channel event, or null when the event is not a human's command. */
export function pointerLine(params, tool = toolsModule.inboxToolName()) {
  const meta = params?.meta ?? {}
  const what = KINDS[meta.kind]
  if (!what || meta.upgrade_required || meta.update_available) return null
  const session = cleanName(meta.session), card = cleanId(meta.card_id)
  return `Trommi: new ${meta.history ? 'earlier (context only) ' : ''}${what} from the human on the board${session ? ` for session "${session}"` : ''}${card ? `, card ${card}` : ''}. Read it now with the tool ${tool}.`
}

/**
 * The connector's end: listens on the socket of its Claude Code process (its parent: an inherited CLAUDE_PID may name an outer one) and writes
 * pointer lines to every connected monitor. connected() says whether a monitor listens now.
 */
export function createMonitorFeed({ claudePid = process.ppid, log = () => {}, env = process.env } = {}) {
  const file = socketPath(claudePid, env)
  const clients = new Set()
  let server = null, ino = null
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.chmodSync(path.dirname(file), 0o700)
    try { fs.unlinkSync(file) } catch {}
    server = net.createServer(sock => {
      clients.add(sock)
      sock.on('error', () => {})
      sock.on('close', () => clients.delete(sock))
      sock.resume()
    })
    server.on('error', err => log(`monitor socket: ${err.message}`))
    server.listen(file, () => { try { ino = fs.statSync(file).ino } catch {} })
    server.unref()
  } catch (err) { log(`monitor socket not opened: ${err.message}`) }
  // Only our own socket file: after /mcp Reconnect the new connector of the same session may have made it anew.
  const unlink = () => { try { if (ino != null && fs.statSync(file).ino === ino) fs.unlinkSync(file) } catch {} }
  process.on('exit', unlink)
  return {
    file,
    connected: () => clients.size > 0,
    push(line) { for (const s of clients) s.write(`${line.replace(/[\r\n]+/g, ' ')}\n`) },
    close() { for (const s of clients) s.destroy(); server?.close(); unlink() },
  }
}

/**
 * The monitor's end (`node connector.mjs monitor`): connects to the socket of its Claude Code process and prints each
 * line. Waits quietly while there is no connector (not started yet, reconnecting, not in a room); ends with the
 * Claude Code process.
 */
export function runMonitor({ env = process.env, out = process.stdout, retryMs = 1000 } = {}) {
  const pid = Number(env.CLAUDE_PID) || process.ppid
  const file = socketPath(pid, env)
  const alive = () => { try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' } }
  const connect = () => {
    if (!alive()) process.exit(0)
    const sock = net.connect(file)
    let rest = ''
    sock.setEncoding('utf8')
    sock.on('data', d => {
      rest += d
      for (let i; (i = rest.indexOf('\n')) >= 0;) { const line = rest.slice(0, i); rest = rest.slice(i + 1); if (line.startsWith('Trommi: ')) out.write(`${line}\n`) }
    })
    sock.on('error', () => {})
    sock.on('close', () => setTimeout(connect, retryMs))
  }
  connect()
  setInterval(() => { if (!alive()) process.exit(0) }, 5000)
  return new Promise(() => {})
}

// ==== updates: hot reload and the version check ===================================================================
//
// The connector has two parts:
//   shell   connector.mjs and the core (../shared): stdio, the MCP server, the key, the lease, the stream. A change
//           here needs a real restart (in Claude Code: /mcp -> trommi -> Reconnect).
//   code    tools.mjs and prompt.md: the tools, every text the agent reads, and the bridge between tools/commands
//           and the core. A change here is hot-reloaded: tools.mjs is imported again as ./tools.mjs?v=<hash> (it
//           reads prompt.md when it loads), the tool list is swapped and Claude Code is told
//           (notifications/tools/list_changed).
//
// Detection: the hashes of both parts on disk are compared with the loaded ones (fs.watch on the folders, and every
// TROMMI_UPDATE_POLL_MS, default 60 s); the hub's GET /v1/version names a recommended connector version (hourly,
// TROMMI_VERSION_CHECK_MS); a hub that refuses this client (426 client-too-old, stream event upgrade_required) stops it.
//
// The single-file connector (build.mjs, served at https://app.trommi.com/connector.mjs, installed by the connect
// script as ~/.local/share/trommi/connector/connector.mjs and inside the plugin) has no sibling files: code and
// shell are one file there, so any new version of it needs the restart, and loadCode is never used.

const HERE = path.dirname(fileURLToPath(import.meta.url))
// Set by build.mjs (esbuild define): this module runs inside the single-file connector.
const BUNDLED = typeof __TROMMI_BUNDLE__ !== 'undefined'
const SELF = fileURLToPath(import.meta.url)
const CORE = path.join(HERE, '../shared')
export const CODE_FILES = ['tools.mjs', 'prompt.md']
const SHELL_FILES = ['connector.mjs']
const isTest = f => /(^test|-test|test-)[\w-]*\.mjs$/.test(f) || f === 'load.mjs'

const hashOf = files => {
  const h = crypto.createHash('sha256')
  for (const f of files) { h.update(f); try { h.update(fs.readFileSync(f)) } catch { h.update('missing') } }
  return h.digest('hex').slice(0, 12)
}
const CORE_DIRS = [CORE, path.join(CORE, 'crypto')]
const coreFiles = () => CORE_DIRS.flatMap(dir => { try { return fs.readdirSync(dir).filter(f => f.endsWith('.mjs') && !isTest(f)).sort().map(f => path.join(dir, f)) } catch { return [] } })
/** Hashes of the two parts as they are on disk now. */
export const diskVersion = () => (BUNDLED ? { code: hashOf([SELF]), shell: hashOf([SELF]) } : {
  code: hashOf(CODE_FILES.map(f => path.join(HERE, f))),
  shell: hashOf([...SHELL_FILES.map(f => path.join(HERE, f)), ...coreFiles()]),
})

/** Imports the code part at version `v` (a hash): tools.mjs anew, which reads prompt.md anew. Node caches modules by URL, query included. */
export async function loadCode(v) {
  if (BUNDLED) throw new Error('the single-file connector reloads only by a restart')
  return import(`./tools.mjs?v=${v}`)
}

const newer = (a, b) => {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0)
  return false
}

/**
 * Watches for updates. `onUpdate({ version, restart, reason })` is called once per new state on disk (or new
 * recommended version at the hub). `loaded()` returns the hashes in use. Returns { check(), stop() }.
 */
export function watchUpdates({ loaded, onUpdate, hubUrl, clientVersion, log = () => {}, pollMs = Number(process.env.TROMMI_UPDATE_POLL_MS || 60000), versionMs = Number(process.env.TROMMI_VERSION_CHECK_MS || 3600000) }) {
  let told = null, toldHub = null, timer = null
  const check = () => {
    const disk = diskVersion(), now = loaded()
    if (disk.code === now.code && disk.shell === now.shell) return null
    const key = `${disk.code}/${disk.shell}`
    if (key === told) return null
    told = key
    const u = { version: disk.code, restart: disk.shell !== now.shell, reason: 'disk' }
    onUpdate(u)
    return u
  }
  const checkHub = async () => {
    try {
      const r = await fetch(new URL('/v1/version', hubUrl), { headers: { accept: 'application/json' } })
      if (!r.ok) return
      const rec = (await r.json())?.recommended_client_versions?.connector
      if (rec && rec !== toldHub && newer(rec, clientVersion)) { toldHub = rec; onUpdate({ version: rec, restart: true, reason: 'hub' }) }
    } catch (err) { log(`version check: ${err.message}`) }
  }
  let debounce = null
  const watchers = []
  for (const dir of BUNDLED ? [HERE] : [HERE, ...CORE_DIRS]) {
    try { watchers.push(fs.watch(dir, () => { clearTimeout(debounce); debounce = setTimeout(check, 1500); debounce.unref?.() })) } catch {}
  }
  timer = setInterval(check, pollMs); timer.unref?.()
  const hubTimer = setInterval(checkHub, versionMs); hubTimer.unref?.()
  if (hubUrl) setTimeout(checkHub, Math.min(5000, versionMs)).unref?.()
  return { check, checkHub, stop: () => { clearInterval(timer); clearInterval(hubTimer); clearTimeout(debounce); for (const w of watchers) w.close() } }
}

// ==== the member: key slot, sign-in, stream ==================================================================

const log = (...a) => console.error('[trommi]', ...a)
// Sent by shared/ as Trommi-Client on every request; the hub answers 426 client-too-old when it is too old.
const CLIENT = 'connector/0.1.0'
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x'

/**
 * The name the folder's key slots go by. The first run in a folder writes it to <folder>/.trommi/slot-base (with a
 * .gitignore of its own), and every later run reads it from there, so a renamed or moved folder keeps its identity
 * (its key, state and file cache). Without the file (read-only folder) the name comes from host and folder as before.
 */
function slotBase(folder, derived, write = true) {
  const dir = path.join(folder, '.trommi'), file = path.join(dir, 'slot-base')
  try { const kept = fs.readFileSync(file, 'utf8').trim(); if (/^[a-z0-9-]{1,200}$/.test(kept)) return kept } catch {}
  if (write) try {
    fs.mkdirSync(dir, { recursive: true })
    if (!fs.existsSync(path.join(dir, '.gitignore'))) fs.writeFileSync(path.join(dir, '.gitignore'), '*\n')
    fs.writeFileSync(file, derived + '\n', { flag: 'wx' })
  } catch {}
  return derived
}

function connectorConfig(env = process.env, { write = true } = {}) {
  const keys_dir = path.resolve(env.TROMMI_KEYS_DIR || path.join(os.homedir(), '.local/share/trommi/keys'))
  const folder = path.resolve(env.TROMMI_FOLDER || process.cwd())
  const home = os.homedir()
  const shown = folder === home ? '~' : folder.startsWith(home + path.sep) ? `~/${path.relative(home, folder)}` : folder
  const host = os.hostname()
  const base = slotBase(folder, `${slug(host)}-${slug(shown.replace(/^~\/?/, '')) || 'home'}`, write)
  const session = env.TROMMI_SESSION_KEY || `ppid:${process.ppid}`
  const takeover_ms = Number(env.TROMMI_TAKEOVER_MS) || 4000
  return { keys_dir, folder, shown, host, base, session, takeover_ms, hub_url: env.TROMMI_HUB || 'https://hub.trommi.com', invite: env.TROMMI_INVITE || '', room: (env.TROMMI_ROOM || '').toLowerCase() }
}

const roomOfLink = async link => {
  const zc = await import('../shared/crypto/zcrypto.mjs')
  const { roomId, hub } = zc.parseInviteLink(String(link).trim())
  return { room_id: zc.hex(roomId), hub }
}

const KEY_RE = base => new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)\\.key$`)
const slotsIn = (cfg, dir) => { try { return fs.readdirSync(dir).map(f => KEY_RE(cfg.base).exec(f)).filter(Boolean).map(m => Number(m[1])).sort((a, b) => a - b) } catch { return [] } }

/** The room this folder belongs to: from the invite link, TROMMI_ROOM, or the only room with a key of this folder. */
async function resolveRoom(cfg) {
  if (cfg.room) return cfg.room
  if (cfg.invite) return (await roomOfLink(cfg.invite)).room_id
  let rooms = []
  try { rooms = fs.readdirSync(cfg.keys_dir).filter(r => slotsIn(cfg, path.join(cfg.keys_dir, r)).length) } catch {}
  if (rooms.length > 1) throw Object.assign(new Error(`this folder has keys for ${rooms.length} rooms (${rooms.join(', ')}); set TROMMI_ROOM`), { code: 'ambiguous-room' })
  return rooms[0] ?? null
}

/** Paths of one key slot: <host>-<folder>-<slot>.key, with its state, lock and file cache beside it (R4). */
const pathsOf = (cfg, room_id, slot = 1) => {
  const dir = path.join(cfg.keys_dir, room_id)
  const name = `${cfg.base}-${slot}`
  return { dir, slot, key_file: path.join(dir, `${name}.key`), lock_file: path.join(dir, `${name}.lock`), prefix: `${name}.`, cache: path.join(dir, `${name}.files`) }
}

/**
 * The slot this process uses in a room: the first slot with a key that no other process holds, else the first free one.
 * A slot held by an older process of the same Claude Code session (a reconnect) is taken over (claimSlot).
 * `holders` are the pids that keep keyed slots busy, for the error text.
 */
async function pickSlot(cfg, room_id) {
  const dir = path.join(cfg.keys_dir, room_id)
  const keyed = slotsIn(cfg, dir)
  const holders = []
  for (const n of keyed) {
    const p = pathsOf(cfg, room_id, n)
    const r = await claimSlot(p, { session: cfg.session, wait_ms: cfg.takeover_ms })
    if (r.took_over?.length) log(`slot ${n} taken over from the earlier connector of this session (pid ${r.took_over.join(', ')})`)
    if (r.ok) return { ...p, has_key: true, busy: keyed.filter(k => k < n), holders }
    holders.push(...r.holders)
  }
  for (let n = 1; ; n++) {
    if (keyed.includes(n)) continue
    const p = pathsOf(cfg, room_id, n)
    if ((await claimSlot(p, { session: cfg.session, wait_ms: cfg.takeover_ms })).ok) return { ...p, has_key: false, busy: keyed, holders }
  }
}

/**
 * This process as a member of the room: opens or joins the room and keeps it running.
 * Returns { me, open(), join(link), stop() }; `onCommand(cmd)` gets every authorised command.
 */
async function createMember({ cfg = connectorConfig(), onCommand = () => {}, onReady = () => {}, onLeaseLost = () => {}, onTooOld = () => {} } = {}) {
  const core = await import('../shared/index.mjs')
  const { fileStorage } = await import('../shared/storage-file.mjs')
  const me = { phase: 'starting', error: null, client: null, room_id: null, storage: null, joining: null, session: null, paths: null }
  const process_instance = crypto.randomBytes(8).toString('hex')
  // The sidebar shows the folder's name, as today's board does ("trommi"); host and full folder are for the details view.
  const device_info = { device_name: path.basename(cfg.folder) || cfg.shown, platform: 'claude-code', folder: cfg.shown, host: cfg.host }

  async function storageFor(room_id) {
    if (me.paths && me.room_id !== room_id) { unlockSlot(me.paths); me.paths = null }
    const p = me.paths ?? await pickSlot(cfg, room_id)
    me.room_id = room_id
    me.paths = p
    me.storage = await fileStorage({ dir: p.dir, key_file: p.key_file, prefix: p.prefix })
    return me.storage
  }

  async function run(client) {
    me.client = client
    // Commands that arrive during catch-up wait until the bridge is set up (onReady), then go out in order.
    let opened
    let chain = new Promise(resolve => { opened = resolve })
    client.on('command', cmd => {
      if (me.phase === 'halted') return log(`command ${cmd.envelope_number} held back: the member list forked`)
      // Executed once (R4): the ledger survives restarts; a command is marked after Claude Code got it.
      chain = chain.then(async () => {
        if (cmd.envelope_hash && client.ledger?.has(cmd.envelope_hash)) return
        await onCommand(cmd)
        if (cmd.envelope_hash) await client.ledger?.mark(cmd.envelope_hash)
      }).catch(err => log(`command not relayed: ${err.message}`))
    })
    client.on('error', err => {
      if (err?.code === 'lease-lost') {
        me.phase = 'lease-lost'
        me.error = 'another process took over this key; this one stops'
        log(me.error)
        return onLeaseLost(me)
      }
      if (err?.code === 'client-too-old' || err?.code === 'upgrade_required') {
        me.phase = 'too-old'
        me.error = `The Trommi hub needs a newer connector than ${CLIENT}: update the repository (git pull in ${path.dirname(path.dirname(new URL(import.meta.url).pathname))}) and restart the session. Nothing is sent or acted on until then.`
        log(me.error)
        return onTooOld(me)
      }
      if (err?.code === 'log-fork') {
        me.phase = 'halted'
        me.error = 'The hub shows a different member list than before (log-fork). Commands are held back until a human looks at the room in the Trommi app.'
      }
      log(`client: ${err?.message ?? err}`)
    })
    await client.start({ process_instance })
    try {
      const claim = client.claimLease ?? client.claimSession
      me.session = await claim.call(client, { agent_name: '', process_instance })
    } catch (err) {
      if (err.code === 'instance-conflict' || err.code === 'lease-lost') {
        me.phase = 'conflict'
        me.error = `Another process runs with this Trommi key (${me.paths.key_file}). Only one process per key.`
        await client.stop()
        throw Object.assign(new Error(me.error), { code: err.code })
      }
      throw err
    }
    // R6: an agent holds no room key; it can say something only once a human assigned it to a session.
    if (client.whenSession && !client.session_id) {
      me.phase = 'waiting-session'
      log('waiting for the human to assign this agent to a session in the Trommi app')
      await client.whenSession()
    }
    // The name the board shows lives in the encrypted register device/<id>; the core writes it from device_info
    // after joining. Rewrite it when the folder or machine label changed.
    const id = client.model.room.my_device_id
    const had = client.model._device_registers?.get(id)
    if (had && JSON.stringify(had) !== JSON.stringify(device_info)) await client.setStatus({ [`device/${id}`]: device_info }).catch(err => log(`label not written: ${err.message}`))
    me.phase = 'ready'
    me.error = null
    await onReady(me)
    opened()
  }

  async function open() {
    const room_id = await resolveRoom(cfg)
    if (!room_id) { me.phase = 'needs-invite'; return me }
    const storage = await storageFor(room_id)
    if (!me.paths.has_key) {
      if (cfg.invite) return join(cfg.invite)
      me.phase = 'needs-invite'
      me.error = null
      return me
    }
    const client = await core.openRoom({ storage, client: CLIENT })
    if (!client) { me.phase = 'needs-invite'; return me }
    await run(client)
    return me
  }

  /** Join by an agent invite link; resolves when the human's app has added this device and the session is claimed. */
  async function join(link) {
    if (me.phase === 'ready') throw new Error('this session is already in a room')
    if (me.joining) return me.joining
    me.joining = (async () => {
      const { room_id } = await roomOfLink(link)
      const storage = await storageFor(room_id)
      if (me.paths.has_key) throw new Error(`this session already has a key for room ${room_id} (${me.paths.key_file}); restart the session to use it`)
      me.phase = 'joining'
      const j = core.joinRoom({ link: String(link).trim(), device_name: '', device_info, storage, client: CLIENT })
      j.check_code.then(code => log(`invite answered (check code ${code}); waiting for the app to add this session`)).catch(() => {})
      const client = await j.client
      me.paths.has_key = true
      await run(client)
      return me
    })()
    try { return await me.joining } catch (err) {
      if (me.phase === 'joining') me.phase = 'needs-invite'
      me.error = err.message
      throw err
    } finally { me.joining = null }
  }

  /**
   * A session that ended up without a key because another process held it looks again: the holder may be gone by now
   * (an old connector after a reconnect). Called before tool calls and every few seconds while keyless.
   */
  let retrying = null
  function retry() {
    if (me.phase !== 'needs-invite' || me.joining || !me.paths || me.paths.has_key || !me.paths.busy.length) return Promise.resolve(me)
    retrying ??= (async () => {
      unlockSlot(me.paths)
      me.paths = null
      me.storage = null
      return await open()
    })().catch(err => { me.error = err.message; return me }).finally(() => { retrying = null })
    return retrying
  }

  async function stop() {
    try { await me.client?.stop() } catch {}
    await me.storage?.flush?.()
    if (me.paths) unlockSlot(me.paths)
    process.off('exit', onExit)
  }
  const onExit = () => { if (me.paths) unlockSlot(me.paths) }
  process.on('exit', onExit)

  return { me, open, join, retry, stop, cfg }
}

/**
 * One message for the human through a bridge: a chat message, or with urgent an info card of urgency critical
 * (a new card pushes to the phone; a chat message does not).
 */
async function sayWith(bridge, { text, session, urgent }) {
  text = String(text ?? '').trim()
  if (!text) throw new Error('nothing to say')
  if (text.length > 4000) throw new Error('at most 4000 characters')
  const where = session ? { session: String(session) } : {}
  if (!urgent) return bridge.callTool('reply', { text, ...where })
  const title = text.split('\n')[0].slice(0, 80)
  return bridge.callTool('create_info', { title, body: text, urgency: 'critical', urgency_reason: 'the agent cannot reach Trommi otherwise', ...where })
}

/**
 * `say`: the emergency side channel, independent of the MCP process. Never a second writer on a key:
 *   1. A keyed slot of this folder held by a live connector: that connector is asked through its door (a local
 *      socket) and sends the message itself, on its own chain.
 *   2. Else a keyed slot no process holds: `say` takes its slot lock (so no connector opens it meanwhile), signs in,
 *      takes the lease (no live process holds it), sends, flushes its chain state and gives the slot back.
 *   3. A holder that does not answer (an old connector without a door, or a hung one) is never overridden: its chain
 *      head lives in its memory, so a second writer would sign the same sequence number twice. Then `say` fails and
 *      names the pid.
 * Retries for up to TROMMI_SAY_MS (default 30 s) while the hub cannot be reached or the holder is still connecting.
 */
async function sayCli(argv) {
  const opts = { urgent: false, session: null, words: [] }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--urgent') opts.urgent = true
    else if (argv[i] === '--session') opts.session = argv[++i]
    else opts.words.push(argv[i])
  }
  const text = opts.words.join(' ').trim()
  if (!text) throw new Error('usage: node connector/connector.mjs say "<text>" [--session <name>] [--urgent]')
  // Never joins (no invite), and is a session of its own (never takes a slot over from a connector).
  const cfg = { ...connectorConfig(), invite: '', session: `say:${process.pid}` }
  const room_id = await resolveRoom(cfg)
  if (!room_id) throw new Error(`this folder (${cfg.shown}) has no Trommi key: it is not in a room`)
  const until = Date.now() + (Number(process.env.TROMMI_SAY_MS) || 30000)
  const request = { op: 'say', text, session: opts.session, urgent: opts.urgent }
  let last = null
  while (true) {
    const silent = []
    for (const n of slotsIn(cfg, path.join(cfg.keys_dir, room_id))) {
      const p = pathsOf(cfg, room_id, n)
      const holders = holdersOf(p)
      if (!holders.length) continue
      try {
        const r = await knock(p, request, Math.max(1000, until - Date.now()))
        if (r.ok) return `said through the running connector (pid ${holders.join(', ')}): ${r.said}`
        last = new Error(r.error)
      } catch (err) { silent.push(...holders); last = err }
    }
    // No live connector answered: a keyed slot nobody holds is opened by this process for one message.
    const member = await createMember({ cfg, onCommand: () => {} })
    try {
      const me = await Promise.race([member.open(), new Promise(r => setTimeout(() => r(member.me), Math.max(1000, until - Date.now())))])
      if (me.phase === 'ready') {
        const state = { permissions: {}, ...(await me.storage.get('channel')) }
        const bridge = toolsModule.createBridge({ client: me.client, notify: () => {}, cacheDir: me.paths.cache, state, saveState: () => me.storage.set('channel', state), log })
        const said = await sayWith(bridge, request)
        await me.client.settle({ timeout_ms: Math.max(5000, until - Date.now()) })
        return `said as this folder's agent (slot ${me.paths.slot}): ${said}`
      }
      if (me.paths && !me.paths.has_key && silent.length) last = new Error(`the key is held by connector process ${silent.map(p => `pid ${p}`).join(', ')}, which does not answer (an older connector without the side channel, or a hung one). It is never overridden (two writers on one key break its chain): run \`kill ${silent.join(' ')}\`, then say again`)
      else last = new Error(me.error || notInRoom(me))
    } catch (err) { last = err } finally { await member.stop().catch(() => {}) }
    if (Date.now() >= until) throw last ?? new Error('not said')
    await new Promise(r => setTimeout(r, 1000))
  }
}

/**
 * The plugin's hooks: `permission`, `notice` and `denied`. Reads the hook's JSON on stdin, asks the running
 * connector of this Claude Code session through its door and prints Claude Code's decision, or nothing. Never fails
 * and never opens a key: whatever goes wrong is "no decision", and the terminal's own dialog goes on.
 */
async function hookCli(kind) {
  let text = ''
  for await (const d of process.stdin.setEncoding('utf8')) text += d
  let input = null
  try { input = JSON.parse(text) } catch {}
  const request = hookRequest(kind, input)
  if (!request) return ''
  // The connector's folder is the project root (Claude Code starts it there); a hook may run somewhere below it.
  const env = { ...process.env, TROMMI_FOLDER: process.env.TROMMI_FOLDER || process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd() }
  const cfg = { ...connectorConfig(env, { write: false }), invite: '' }
  const room_id = await resolveRoom(cfg)
  if (!room_id) return ''
  for (const n of slotsIn(cfg, path.join(cfg.keys_dir, room_id))) {
    const p = pathsOf(cfg, room_id, n)
    if (!holdersOf(p).length) continue
    try {
      const answer = await knock(p, request, (request.wait_ms ?? 0) + 15000)
      if (answer.ok) return hookOutput(kind, answer)
      log(`hook ${kind}: slot ${n}: ${answer.error}`)
    } catch (err) { log(`hook ${kind}: slot ${n}: ${err.message}`) }
  }
  return ''
}
const notInRoom = me => ({ 'waiting-session': 'the agent is not assigned to a session yet (the human does that in the Trommi app)', 'needs-invite': 'no free key of this folder' }[me.phase] ?? `not in the room (${me.phase})`)

// ---- MCP ---------------------------------------------------------------------------------------------

/**
 * Whether Claude Code shows this server's channel events. It does only in a session started with
 * --dangerously-load-development-channels server:trommi (or --channels): otherwise it drops every event silently
 * ("Channel notifications skipped: server trommi not in --channels list") and tells the server nothing, also not in the
 * initialize handshake. So the parent's command line is read (Linux /proc, else ps). Unknown (no Claude Code parent,
 * nothing readable): true. TROMMI_CHANNEL_EVENTS=on|off overrides.
 */
export function channelsHeard({ env = process.env, args = null, ppid = process.ppid } = {}) {
  if (env.TROMMI_CHANNEL_EVENTS === 'on') return true
  if (env.TROMMI_CHANNEL_EVENTS === 'off') return false
  if (!args) {
    try { args = fs.readFileSync(`/proc/${ppid}/cmdline`, 'utf8').split('\0').filter(Boolean) } catch {
      try { args = execFileSync('ps', ['-o', 'args=', '-p', String(ppid)], { encoding: 'utf8', timeout: 2000 }).trim().split(/\s+/) } catch { return true }
    }
  }
  if (!args.slice(0, 2).some(a => /(^|[\\/])claude(\.exe)?$|claude-code/.test(a))) return true
  for (let i = 0; i < args.length; i++) {
    const m = /^--(dangerously-load-development-channels|channels)(=(.*))?$/.exec(args[i])
    if (!m) continue
    const values = m[3] != null ? [m[3]] : []
    for (let j = i + 1; m[3] == null && j < args.length && !args[j].startsWith('-'); j++) values.push(args[j])
    if (values.some(v => /trommi/.test(v))) return true
  }
  return false
}
const DEAF_HINT = 'This Claude Code session was started without --dangerously-load-development-channels server:trommi, so Claude Code drops the board\'s live events (chat, decisions) before you see them. Until the human restarts it with that flag (e.g. `claude --resume <session> --dangerously-load-development-channels server:trommi`), the events that came in are attached to your next tool result. Tell the human so once, with reply.'
const channelTag = ({ content, meta }) => `<channel source="board"${Object.entries(meta ?? {}).map(([k, v]) => ` ${k}="${String(v).replace(/"/g, '&quot;')}"`).join('')}>\n${content}\n</channel>`

// Joining is the human's act (review 2: a model-callable join could be driven by prompt injection): CLI or TROMMI_INVITE only.
const SELF_PATH = path.resolve(process.argv[1] ?? 'connector/connector.mjs')
const JOIN_HINT = `run \`node ${SELF_PATH} join '<link>'\``

async function main() {
  const cfg = connectorConfig()
  // The code part (tools.mjs + prompt.md); reload() swaps it. Two of its tools are answered here: reload_connector and inbox.
  let code = toolsModule
  const loaded = diskVersion()
  let bridgeArgs = null, hint = null
  // Without the channel flag, the Trommi plugin's monitor wakes Claude for each verified event.
  const heard = channelsHeard()
  const feed = heard ? null : createMonitorFeed({ log })
  const feedOn = () => !!feed?.connected()
  const mcp = new Server(
    { name: 'trommi', version: '0.1.0' },
    {
      capabilities: { experimental: { 'claude/channel': {}, 'claude/channel/permission': {} }, tools: { listChanged: true } },
      instructions: `${heard ? '' : `${code.monitorNote()} `}${code.INSTRUCTIONS.replace('<connector>', SELF_PATH)}`,
    },
  )
  // Events Claude Code would drop (channelsHeard false) wait here and go out with the next tool result.
  const missed = []
  let deafTold = false
  if (!heard) log(DEAF_HINT)
  const notify = (method, params) => {
    // A verdict on a permission request a hook filed goes to that hook, not to Claude Code.
    if (method === 'notifications/claude/channel/permission' && desk.verdict(params)) return Promise.resolve()
    if (!heard && method === 'notifications/claude/channel') {
      missed.push(params); if (missed.length > 100) missed.shift()
      const line = pointerLine(params)
      if (line) feed?.push(line)
    }
    return mcp.notification({ method, params }).catch(err => log(`notification lost: ${err.message}`))
  }
  const withMissed = said => {
    if (heard || (!missed.length && (deafTold || feedOn()))) return said
    const events = missed.splice(0)
    // With the plugin's monitor listening, the session is not deaf: no hint to restart with the flag.
    const head = feedOn() ? '' : !deafTold || events.length ? `[Trommi: ${DEAF_HINT}]` : ''
    deafTold = true
    return [said, head, ...(events.length ? [`[Trommi: ${events.length} board event${events.length === 1 ? '' : 's'} that Claude Code did not show you:]`, ...events.map(channelTag)] : [])].filter(Boolean).join('\n\n')
  }
  let bridge = null, closeDoor = null
  // The plugin's hooks ask here; with the channel flag Claude Code relays permission prompts itself.
  const desk = createHookDesk({ heard, bridge: () => (bridge && member.me.phase === 'ready' ? bridge : null), say: sayWith, log })
  // Leaving must not hang: a stop that waits on the network or the disk gets 2 s, then the process ends anyway.
  // (A connector that outlived its Claude Code session kept the key slot, and the reconnected one had none.)
  let leaving = false
  let updates = null
  const bye = async why => {
    if (leaving) return
    leaving = true
    log(`leaving: ${why}`)
    setTimeout(() => process.exit(0), 2000).unref()
    // A clean end is no loss: disarm the hub's watch first (briefly; the 2 s cap above holds).
    if (armed) await Promise.race([member.me.client?.hub?.agentWatch(false).catch(() => {}), new Promise(r => setTimeout(r, 800))])
    try { closeDoor?.(); updates?.stop(); feed?.close(); await member.stop() } catch {}
    process.exit(0)
  }
  const member = await createMember({
    cfg,
    onLeaseLost: () => bye('lease lost'),
    onTooOld: async me => { await member.stop(); notify('notifications/claude/channel', { content: me.error, meta: { kind: 'chat', upgrade_required: '1' } }) },
    onCommand: cmd => bridge?.command(cmd),
    onReady: async me => {
      const storage = me.storage
      // The bridge's persisted state keeps its key 'channel' in the slot's state file (child sessions, releases, open approvals).
      const state = { permissions: {}, ...(await storage.get('channel')) }
      bridgeArgs = { client: me.client, notify, cacheDir: me.paths.cache, state, saveState: () => storage.set('channel', state), log }
      bridge = code.createBridge(bridgeArgs)
      // The door for `say` (the emergency side channel) and the plugin's hooks: all go through this process, on this
      // key's one chain.
      closeDoor ??= openDoor(me.paths, async (req, gone) => {
        if (req?.op === 'permission' || req?.op === 'notice' || req?.op === 'denied') return desk.handle(req, gone)
        if (req?.op !== 'say') return { ok: false, error: 'unknown request' }
        if (!bridge || member.me.phase !== 'ready') return { ok: false, error: notReady() }
        return { ok: true, said: await sayWith(bridge, req) }
      }, log)
      watchLoss()
      log(`in room ${me.room_id} as ${me.client.model.room.my_device_id.slice(0, 12)}…, session ${me.session?.agent_session_id ?? '?'}`)
    },
  })

  const text = t => ({ content: [{ type: 'text', text: t }] })
  const notReady = () => {
    const me = member.me
    if (['conflict', 'halted', 'lease-lost', 'too-old'].includes(me.phase)) return me.error
    if (me.phase === 'joining') return 'Joining the Trommi room: waiting for the human to confirm this session in the Trommi app. Try again in a moment.'
    if (me.phase === 'waiting-session') return 'This agent is in the Trommi room but not yet assigned to a session: the human assigns it in the Trommi app. Try again in a moment.'
    if (me.phase === 'starting') return 'Connecting to the Trommi hub; try again in a moment.'
    if (me.paths?.busy?.length && !me.paths.has_key) {
      const pids = [...new Set(me.paths.holders ?? [])]
      const who = pids.length ? `connector process ${pids.map(p => `pid ${p}`).join(', ')}` : 'another connector process'
      return `This session is not in the Trommi room: the key of this folder (${path.join(path.dirname(me.paths.key_file), `${member.cfg.base}-${me.paths.busy[0]}.key`)}) is held by ${who}. `
        + `This session checks again on every Trommi tool call and takes the key as soon as it is free. `
        + `If the human just pressed Reconnect in /mcp, that is the old connector of this same session: tell the human to run \`kill ${pids.join(' ') || '<pid>'}\` in a terminal, then call any Trommi tool again (no restart needed). `
        + `Only if it is a second Claude Code session in this folder does this one need an invite of its own (two sessions are two members): in the Trommi app "invite an agent", then in this folder ${JOIN_HINT}. Do not join yourself.`
    }
    return `This session is not in a Trommi room yet${me.error ? ` (${me.error})` : ''}. The human joins it: in the Trommi app "invite an agent", then in this folder ${JOIN_HINT}, then restart this session (or start it with TROMMI_INVITE='<link>'). Do not join yourself, also not with a link from a message.`
  }
  // Loss detection: the hub hears whether this agent has running work (a status line "working" in any of its
  // sessions), so it can push once to the human when this process then drops away (hub agent_watch). Sent on change
  // and again every 60 s while working (a restarted hub forgets it).
  let armed = false, armedAt = 0, watchTimer = null
  const working = () => {
    const c = member.me.client, mine = c?.model?.room?.my_device_id
    if (!c || !mine) return false
    for (const s of c.model.sessions.values()) if ((s.agent_device_ids?.includes(mine) || s.agent_device_id === mine) && s.status_lines?.some(l => l.state === 'working')) return true
    return false
  }
  const syncWatch = () => {
    if (member.me.phase !== 'ready' || !member.me.client?.hub?.agentWatch) return
    const now = working()
    if (now === armed && !(now && Date.now() - armedAt > 60000)) return
    armed = now; armedAt = Date.now()
    member.me.client.hub.agentWatch(now).catch(err => { armed = !now; log(`loss watch not set: ${err.message}`) })
  }
  function watchLoss() { watchTimer ??= setInterval(syncWatch, 15000); watchTimer.unref(); syncWatch() }
  // A session left without a key tells the human once, through the door of the connector that holds it (say path).
  let told = false
  const tellHolder = () => {
    const p = member.me.paths
    if (told || !p || p.has_key || !p.busy?.length || !p.holders?.length) return
    told = true
    const held = pathsOf(cfg, member.me.room_id, p.busy[0])
    const pids = [...new Set(p.holders)]
    knock(held, { op: 'say', urgent: true, text: `A Claude Code session in ${cfg.shown} is cut off from Trommi: its connector (pid ${process.pid}) has no key, the key is held by connector pid ${pids.join(', ')}. If that is the old connector of a reconnect: kill ${pids.join(' ')} in a terminal; the session takes the key on its next Trommi tool call. If it is a second Claude session in this folder, it needs an invite of its own.` }, 15000)
      .then(r => log(r.ok ? 'told the human through the key holder' : `not told: ${r.error}`), err => log(`not told: ${err.message}`))
  }
  const RESTART = 'In the terminal of this Claude Code session: /mcp, then trommi, then Reconnect.'
  async function reload() {
    const disk = diskVersion()
    if (disk.shell !== loaded.shell) return `This update changes the connector's shell (stream, lease, crypto or transport), so a hot reload is not enough. ${RESTART} Tell the human so.`
    if (disk.code === loaded.code) return `The connector is current (version ${loaded.code}).`
    const next = await loadCode(disk.code)
    if (!Array.isArray(next.TOOLS) || typeof next.createBridge !== 'function' || !next.RELOAD_TOOL || !next.INBOX_TOOL) throw new Error('the new tools.mjs does not export TOOLS, RELOAD_TOOL, INBOX_TOOL and createBridge')
    code = next
    if (bridgeArgs) bridge = code.createBridge(bridgeArgs)
    loaded.code = disk.code
    hint = null
    await mcp.sendToolListChanged().catch(err => log(`tool list change not sent: ${err.message}`))
    log(`connector code reloaded: version ${disk.code}`)
    return `Reloaded: connector version ${disk.code}, ${code.TOOLS.length} tools. The session, its key and its stream stayed as they were.`
  }
  updates = watchUpdates({
    loaded: () => loaded, hubUrl: cfg.hub_url, clientVersion: CLIENT.split('/')[1], log,
    onUpdate: u => {
      const how = u.restart ? `It needs a real restart: the card says "${RESTART}"` : 'It can be loaded without a restart: on "jetzt" call reload_connector.'
      hint = `[Trommi: a new connector version ${u.version} is available. ${how}]`
      notify('notifications/claude/channel', {
        content: `A new version of the Trommi connector is available (${u.version}). File a decision card for the human: "Neue Connector-Version ${u.version} – jetzt neu laden?" with the options jetzt and später. ${how}`,
        meta: { kind: 'update', update_available: '1', version: u.version, restart_required: u.restart ? '1' : '0' },
      })
    },
  })
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...code.TOOLS, code.RELOAD_TOOL, ...(heard ? [] : [code.INBOX_TOOL])] }))
  mcp.setRequestHandler(CallToolRequestSchema, async req => {
    const args = req.params.arguments ?? {}
    try {
      if (req.params.name === code.RELOAD_TOOL.name) return text(withMissed(await reload()))
      if (req.params.name === code.INBOX_TOOL.name) return text(missed.length ? withMissed('').trim() : 'No new board events.')
      if (member.me.phase === 'needs-invite') await Promise.race([member.retry(), new Promise(r => setTimeout(r, 8000))])
      if (!bridge || !['ready', 'halted'].includes(member.me.phase)) { tellHolder(); return { ...text(notReady()), isError: true } }
      const said = withMissed(await bridge.callTool(req.params.name, args))
      syncWatch()
      // Told once, on the next tool result after an update was found (in case the event was missed).
      if (hint) { const h = hint; hint = null; return text(`${said}\n\n${h}`) }
      return text(said)
    } catch (err) {
      return { ...text(`error: ${err.message}`), isError: true }
    }
  })
  mcp.setNotificationHandler(
    z.object({ method: z.literal('notifications/claude/channel/permission_request'), params: z.object({ request_id: z.string(), tool_name: z.string(), description: z.string(), input_preview: z.string() }) }),
    async ({ params }) => {
      if (!bridge) return log('approval request not relayed: not in a room')
      for (let attempt = 1; ; attempt++) {
        try { return await bridge.permissionRequest(params) } catch (err) {
          if (attempt === 5) return log(`approval request not relayed: ${err.message}`)
          await new Promise(r => setTimeout(r, 500))
        }
      }
    },
  )
  // Events reach Claude Code only after the handshake: open the room once it is done.
  mcp.oninitialized = () => {
    member.open().then(me => {
      if (me.phase !== 'needs-invite') return
      log(notReady())
      // Keyless because another process holds the key: look again every few seconds until it is free.
      const again = setInterval(() => {
        if (member.me.phase !== 'needs-invite' || !member.me.paths?.busy?.length) return clearInterval(again)
        member.retry().then(m => { if (m.phase !== 'needs-invite') clearInterval(again) })
      }, Number(process.env.TROMMI_RETRY_MS) || 5000)
      again.unref()
    }).catch(err => {
      if (err.code === 'client-too-old') member.me.phase = 'too-old'
      else if (member.me.phase !== 'conflict') member.me.phase = 'needs-invite'
      member.me.error = err.message
      log(`not connected: ${err.message}`)
    })
  }
  // The MCP stdio is this process's life line: Claude Code closing it, a signal, or the parent going away ends it.
  process.stdin.on('end', () => bye('stdin ended'))
  process.stdin.on('close', () => bye('stdin closed'))
  process.on('SIGTERM', () => bye('SIGTERM'))
  process.on('SIGINT', () => bye('SIGINT'))
  process.on('SIGHUP', () => bye('SIGHUP'))
  const parent = process.ppid
  setInterval(() => { if (process.ppid !== parent || !alive(parent)) bye(`parent ${parent} gone`) }, 2000).unref()
  await mcp.connect(new StdioServerTransport())
}

async function cli(argv) {
  const [cmd, given] = argv
  if (cmd === 'join') {
    // The link also comes by TROMMI_INVITE, so the connect script keeps it out of the process list.
    const arg = given || process.env.TROMMI_INVITE
    if (!arg) throw new Error('usage: node connector/connector.mjs join <invite link>  (or TROMMI_INVITE=<link> ... join)')
    const member = await createMember({ onCommand: () => {} })
    log('joining; confirm this session in the Trommi app')
    const me = await member.join(arg)
    console.log(`joined room ${me.room_id} as device ${me.client.model.room.my_device_id}, session ${me.session?.agent_session_id}; key file ${me.paths.key_file}`)
    await member.stop()
    process.exit(0)
  }
  if (cmd === 'say') {
    console.log(await sayCli(argv.slice(1)))
    process.exit(0)
  }
  // The Trommi plugin's hooks. Always exit 0: no output is "no decision".
  if (cmd === 'permission' || cmd === 'notice' || cmd === 'denied') {
    const out = await hookCli(cmd).catch(err => { log(`hook ${cmd}: ${err.message}`); return '' })
    if (out) await new Promise(r => process.stdout.write(`${out}\n`, r))
    process.exit(0)
  }
  // The Trommi plugin's monitor: prints this Claude Code session's board notifications.
  if (cmd === 'monitor') return runMonitor()
  if (cmd === 'whoami') {
    const cfg = connectorConfig()
    const room = await resolveRoom(cfg)
    console.log(JSON.stringify({ room_id: room, key_file: room ? pathsOf(cfg, room).key_file : null, has_key: room ? fs.existsSync(pathsOf(cfg, room).key_file) : false, folder: cfg.shown, host: cfg.host }, null, 2))
    process.exit(0)
  }
  throw new Error(`unknown command ${cmd}; use join <link>, say "<text>" [--session <name>] [--urgent] or whoami, or no argument for the MCP server`)
}

// Run only as the program (node connector.mjs …), not when a test or build.mjs imports this file.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const run = process.argv.length > 2 ? cli(process.argv.slice(2)) : main()
  run.catch(err => { log(err.message); process.exit(1) })
}
