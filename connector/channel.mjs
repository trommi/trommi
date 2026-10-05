#!/usr/bin/env node
// channel.mjs: the Claude Code channel for the new E2E Trommi hub (README "Hub v1: the wire protocol").
//
// An MCP stdio server, like server/server.mjs in session mode, with the same tools and the same
// <channel source="board" kind=...> events. Unlike it, this process is a member of the room: it has its own
// device keys (a key file, mode 0600), signs and encrypts everything it sends, and verifies everything it gets
// (client/core does all protocol work; connector/channel-bridge.mjs translates tools and commands).
//
//   node connector/channel.mjs                 MCP server (Claude Code starts it from .mcp.json)
//   node connector/channel.mjs join <link>     join a room with an agent invite link, then exit
//   node connector/channel.mjs whoami          print room, key file and device id
//   node connector/channel.mjs say "<text>" [--session <name>] [--urgent]
//                                              the emergency side channel: one message to the human, then exit
//   node connector/channel.mjs permission      the plugin's PermissionRequest hook (hook JSON on stdin; connector/hook.mjs)
//   node connector/channel.mjs notice          the plugin's Notification hook
//
// Environment:
//   TROMMI_INVITE    agent invite link (https://app.trommi.com/join#v1....), needed once per room + machine + folder
//   TROMMI_ROOM      room id (hex), when this folder's key file belongs to more than one room
//   TROMMI_HUB       hub address, default https://hub.trommi.com (an invite link names its own hub)
//   TROMMI_KEYS_DIR  where key files live, default ~/.local/share/trommi/keys
//   TROMMI_FOLDER    the working folder that names the key file, default the current directory
//   TROMMI_PERMISSION_MS  how long the permission hook waits for the human's verdict, default 300000 (5 minutes)
//   TROMMI_SESSION_KEY  which Claude Code session this process belongs to, default its parent pid: a new process of
//                    the same session (a /mcp Reconnect) takes the slot over from the old one (channel-lock.mjs)
//
// Key slot: <keys>/<room_id>/<host>-<folder>-<slot>.key; beside it .state.json (cursor, chains, model), .lock and
// .files/ (the human's attachments, decrypted for Claude). A restarted session reuses its slot (pathsOf, pickSlot).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { INSTRUCTIONS, TOOLS } from './channel-tools.mjs'
import { createBridge } from './channel-bridge.mjs'
import { alive, claimSlot, unlockSlot, holdersOf, openDoor, knock } from './channel-lock.mjs'
import { diskVersion, loadCode, watchUpdates } from './reload.mjs'
import { createMonitorFeed, pointerLine, runMonitor, INBOX_TOOL, MONITOR_NOTE } from './monitor.mjs'
import { createHookDesk, hookRequest, hookOutput } from './hook.mjs'

const log = (...a) => console.error('[trommi]', ...a)
// Sent by client/core as Trommi-Client on every request; the hub answers 426 client-too-old when it is too old.
const CLIENT = 'channel/0.1.0'
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

function channelConfig(env = process.env, { write = true } = {}) {
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
  const zc = await import('../core/zcrypto.mjs')
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
 * The member side of the channel: opens or joins the room and keeps it running.
 * Returns { me, open(), join(link), stop() }; `onCommand(cmd)` gets every authorised command.
 */
async function createChannel({ cfg = channelConfig(), onCommand = () => {}, onReady = () => {}, onLeaseLost = () => {}, onTooOld = () => {} } = {}) {
  const core = await import('../core/index.mjs')
  const { fileStorage } = await import('../core/storage-file.mjs')
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
        me.error = `The Trommi hub needs a newer channel than ${CLIENT}: update the repository (git pull in ${path.dirname(path.dirname(new URL(import.meta.url).pathname))}) and restart the session. Nothing is sent or acted on until then.`
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
 *      socket, channel-lock.mjs) and sends the message itself, on its own chain.
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
  if (!text) throw new Error('usage: node connector/channel.mjs say "<text>" [--session <name>] [--urgent]')
  // Never joins (no invite), and is a session of its own (never takes a slot over from a connector).
  const cfg = { ...channelConfig(), invite: '', session: `say:${process.pid}` }
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
    const channel = await createChannel({ cfg, onCommand: () => {} })
    try {
      const me = await Promise.race([channel.open(), new Promise(r => setTimeout(() => r(channel.me), Math.max(1000, until - Date.now())))])
      if (me.phase === 'ready') {
        const state = { permissions: {}, ...(await me.storage.get('channel')) }
        const bridge = createBridge({ client: me.client, notify: () => {}, cacheDir: me.paths.cache, state, saveState: () => me.storage.set('channel', state), log })
        const said = await sayWith(bridge, request)
        await me.client.settle({ timeout_ms: Math.max(5000, until - Date.now()) })
        return `said as this folder's agent (slot ${me.paths.slot}): ${said}`
      }
      if (me.paths && !me.paths.has_key && silent.length) last = new Error(`the key is held by connector process ${silent.map(p => `pid ${p}`).join(', ')}, which does not answer (an older connector without the side channel, or a hung one). It is never overridden (two writers on one key break its chain): run \`kill ${silent.join(' ')}\`, then say again`)
      else last = new Error(me.error || notInRoom(me))
    } catch (err) { last = err } finally { await channel.stop().catch(() => {}) }
    if (Date.now() >= until) throw last ?? new Error('not said')
    await new Promise(r => setTimeout(r, 1000))
  }
}

/**
 * The plugin's hooks (connector/hook.mjs): `permission` and `notice`. Reads the hook's JSON on stdin, asks the running
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
  const cfg = { ...channelConfig(env, { write: false }), invite: '' }
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
const SELF_PATH = path.resolve(process.argv[1] ?? 'connector/channel.mjs')
const JOIN_HINT = `run \`node ${path.resolve(process.argv[1] ?? 'connector/channel.mjs')} join '<link>'\``

// The one tool of the shell: it stays when the code part is reloaded.
const RELOAD_TOOL = {
  name: 'reload_connector',
  description: 'Load a new version of the Trommi connector (tools, instructions, bridge) without a restart. Call it only after the human chose "jetzt" on the update card you filed for an update_available event. It answers whether the reload worked or a real restart is needed.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}

async function main() {
  const cfg = channelConfig()
  let code = { TOOLS, INSTRUCTIONS, createBridge }
  const loaded = diskVersion()
  let bridgeArgs = null, hint = null
  // Without the channel flag, the Trommi plugin's monitor (connector/monitor.mjs) wakes Claude for each verified event.
  const heard = channelsHeard()
  const feed = heard ? null : createMonitorFeed({ log })
  const feedOn = () => !!feed?.connected()
  const mcp = new Server(
    { name: 'trommi', version: '0.1.0' },
    {
      capabilities: { experimental: { 'claude/channel': {}, 'claude/channel/permission': {} }, tools: { listChanged: true } },
      instructions: `${heard ? '' : `${MONITOR_NOTE} `}${INSTRUCTIONS.replace('<connector>', SELF_PATH)}`,
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
  // The plugin's hooks ask here (connector/hook.mjs); with the channel flag Claude Code relays permission prompts itself.
  const desk = createHookDesk({ heard, bridge: () => (bridge && channel.me.phase === 'ready' ? bridge : null), say: sayWith, log })
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
    if (armed) await Promise.race([channel.me.client?.hub?.agentWatch(false).catch(() => {}), new Promise(r => setTimeout(r, 800))])
    try { closeDoor?.(); updates?.stop(); feed?.close(); await channel.stop() } catch {}
    process.exit(0)
  }
  const channel = await createChannel({
    cfg,
    onLeaseLost: () => bye('lease lost'),
    onTooOld: async me => { await channel.stop(); notify('notifications/claude/channel', { content: me.error, meta: { kind: 'chat', upgrade_required: '1' } }) },
    onCommand: cmd => bridge?.command(cmd),
    onReady: async me => {
      const storage = me.storage
      const state = { permissions: {}, ...(await storage.get('channel')) }
      bridgeArgs = { client: me.client, notify, cacheDir: me.paths.cache, state, saveState: () => storage.set('channel', state), log }
      bridge = code.createBridge(bridgeArgs)
      // The door for `say` (the emergency side channel) and the plugin's hooks: all go through this process, on this
      // key's one chain.
      closeDoor ??= openDoor(me.paths, async (req, gone) => {
        if (req?.op === 'permission' || req?.op === 'notice') return desk.handle(req, gone)
        if (req?.op !== 'say') return { ok: false, error: 'unknown request' }
        if (!bridge || channel.me.phase !== 'ready') return { ok: false, error: notReady() }
        return { ok: true, said: await sayWith(bridge, req) }
      }, log)
      watchLoss()
      log(`in room ${me.room_id} as ${me.client.model.room.my_device_id.slice(0, 12)}…, session ${me.session?.agent_session_id ?? '?'}`)
    },
  })

  const text = t => ({ content: [{ type: 'text', text: t }] })
  const notReady = () => {
    const me = channel.me
    if (['conflict', 'halted', 'lease-lost', 'too-old'].includes(me.phase)) return me.error
    if (me.phase === 'joining') return 'Joining the Trommi room: waiting for the human to confirm this session in the Trommi app. Try again in a moment.'
    if (me.phase === 'waiting-session') return 'This agent is in the Trommi room but not yet assigned to a session: the human assigns it in the Trommi app. Try again in a moment.'
    if (me.phase === 'starting') return 'Connecting to the Trommi hub; try again in a moment.'
    if (me.paths?.busy?.length && !me.paths.has_key) {
      const pids = [...new Set(me.paths.holders ?? [])]
      const who = pids.length ? `connector process ${pids.map(p => `pid ${p}`).join(', ')}` : 'another connector process'
      return `This session is not in the Trommi room: the key of this folder (${path.join(path.dirname(me.paths.key_file), `${channel.cfg.base}-${me.paths.busy[0]}.key`)}) is held by ${who}. `
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
    const c = channel.me.client, mine = c?.model?.room?.my_device_id
    if (!c || !mine) return false
    for (const s of c.model.sessions.values()) if ((s.agent_device_ids?.includes(mine) || s.agent_device_id === mine) && s.status_lines?.some(l => l.state === 'working')) return true
    return false
  }
  const syncWatch = () => {
    if (channel.me.phase !== 'ready' || !channel.me.client?.hub?.agentWatch) return
    const now = working()
    if (now === armed && !(now && Date.now() - armedAt > 60000)) return
    armed = now; armedAt = Date.now()
    channel.me.client.hub.agentWatch(now).catch(err => { armed = !now; log(`loss watch not set: ${err.message}`) })
  }
  function watchLoss() { watchTimer ??= setInterval(syncWatch, 15000); watchTimer.unref(); syncWatch() }
  // A session left without a key tells the human once, through the door of the connector that holds it (say path).
  let told = false
  const tellHolder = () => {
    const p = channel.me.paths
    if (told || !p || p.has_key || !p.busy?.length || !p.holders?.length) return
    told = true
    const held = pathsOf(cfg, channel.me.room_id, p.busy[0])
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
    if (!Array.isArray(next.TOOLS) || typeof next.createBridge !== 'function') throw new Error('the new code does not export TOOLS and createBridge')
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
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...code.TOOLS, RELOAD_TOOL, ...(heard ? [] : [INBOX_TOOL])] }))
  mcp.setRequestHandler(CallToolRequestSchema, async req => {
    const args = req.params.arguments ?? {}
    try {
      if (req.params.name === RELOAD_TOOL.name) return text(withMissed(await reload()))
      if (req.params.name === INBOX_TOOL.name) return text(missed.length ? withMissed('').trim() : 'No new board events.')
      if (channel.me.phase === 'needs-invite') await Promise.race([channel.retry(), new Promise(r => setTimeout(r, 8000))])
      if (!bridge || !['ready', 'halted'].includes(channel.me.phase)) { tellHolder(); return { ...text(notReady()), isError: true } }
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
    channel.open().then(me => {
      if (me.phase !== 'needs-invite') return
      log(notReady())
      // Keyless because another process holds the key: look again every few seconds until it is free.
      const again = setInterval(() => {
        if (channel.me.phase !== 'needs-invite' || !channel.me.paths?.busy?.length) return clearInterval(again)
        channel.retry().then(m => { if (m.phase !== 'needs-invite') clearInterval(again) })
      }, Number(process.env.TROMMI_RETRY_MS) || 5000)
      again.unref()
    }).catch(err => {
      if (err.code === 'client-too-old') channel.me.phase = 'too-old'
      else if (channel.me.phase !== 'conflict') channel.me.phase = 'needs-invite'
      channel.me.error = err.message
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
    if (!arg) throw new Error('usage: node connector/channel.mjs join <invite link>  (or TROMMI_INVITE=<link> ... join)')
    const channel = await createChannel({ onCommand: () => {} })
    log('joining; confirm this session in the Trommi app')
    const me = await channel.join(arg)
    console.log(`joined room ${me.room_id} as device ${me.client.model.room.my_device_id}, session ${me.session?.agent_session_id}; key file ${me.paths.key_file}`)
    await channel.stop()
    process.exit(0)
  }
  if (cmd === 'say') {
    console.log(await sayCli(argv.slice(1)))
    process.exit(0)
  }
  // The Trommi plugin's hooks (connector/hook.mjs). Always exit 0: no output is "no decision".
  if (cmd === 'permission' || cmd === 'notice') {
    const out = await hookCli(cmd).catch(err => { log(`hook ${cmd}: ${err.message}`); return '' })
    if (out) await new Promise(r => process.stdout.write(`${out}\n`, r))
    process.exit(0)
  }
  // The Trommi plugin's monitor (connector/monitor.mjs): prints this Claude Code session's board notifications.
  if (cmd === 'monitor') return runMonitor()
  if (cmd === 'whoami') {
    const cfg = channelConfig()
    const room = await resolveRoom(cfg)
    console.log(JSON.stringify({ room_id: room, key_file: room ? pathsOf(cfg, room).key_file : null, has_key: room ? fs.existsSync(pathsOf(cfg, room).key_file) : false, folder: cfg.shown, host: cfg.host }, null, 2))
    process.exit(0)
  }
  throw new Error(`unknown command ${cmd}; use join <link>, say "<text>" [--session <name>] [--urgent] or whoami, or no argument for the MCP server`)
}

if (import.meta.url === `file://${process.argv[1]}` || (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) || /\/(connector|hub)\/channel\.mjs$/.test(process.argv[1] ?? '')) {
  const run = process.argv.length > 2 ? cli(process.argv.slice(2)) : main()
  run.catch(err => { log(err.message); process.exit(1) })
}
