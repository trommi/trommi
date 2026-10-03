#!/usr/bin/env node
// channel.mjs: the Claude Code channel for the new E2E Trommi hub (README "Hub v1: the wire protocol").
//
// An MCP stdio server, like server/server.mjs in session mode, with the same tools and the same
// <channel source="board" kind=...> events. Unlike it, this process is a member of the room: it has its own
// device keys (a key file, mode 0600), signs and encrypts everything it sends, and verifies everything it gets
// (client/core does all protocol work; hub/channel-bridge.mjs translates tools and commands).
//
//   node hub/channel.mjs                 MCP server (Claude Code starts it from .mcp.json)
//   node hub/channel.mjs join <link>     join a room with an agent invite link, then exit
//   node hub/channel.mjs whoami          print room, key file and device id
//
// Environment:
//   TROMMI_INVITE    agent invite link (https://app.trommi.com/join#v1....), needed once per room + machine + folder
//   TROMMI_ROOM      room id (hex), when this folder's key file belongs to more than one room
//   TROMMI_HUB       hub address, default https://hub.trommi.com (an invite link names its own hub)
//   TROMMI_KEYS_DIR  where key files live, default ~/.local/share/trommi/keys
//   TROMMI_FOLDER    the working folder that names the key file, default the current directory
//
// Key file: <keys>/<room_id>/<host>-<folder>.key; beside it <host>-<folder>.state.json (cursor, chains, model)
// and <host>-<folder>.files/ (the human's attachments, decrypted for Claude). A restarted session reuses it.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { z } from 'zod'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { INSTRUCTIONS, TOOLS } from './channel-tools.mjs'
import { createBridge } from './channel-bridge.mjs'

const log = (...a) => console.error('[trommi]', ...a)
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x'

export function channelConfig(env = process.env) {
  const keys_dir = path.resolve(env.TROMMI_KEYS_DIR || path.join(os.homedir(), '.local/share/trommi/keys'))
  const folder = path.resolve(env.TROMMI_FOLDER || process.cwd())
  const home = os.homedir()
  const shown = folder === home ? '~' : folder.startsWith(home + path.sep) ? `~/${path.relative(home, folder)}` : folder
  const host = os.hostname()
  const base = `${slug(host)}-${slug(shown.replace(/^~\/?/, '')) || 'home'}`
  return { keys_dir, folder, shown, host, base, hub_url: env.TROMMI_HUB || 'https://hub.trommi.com', invite: env.TROMMI_INVITE || '', room: (env.TROMMI_ROOM || '').toLowerCase() }
}

const roomOfLink = async link => {
  const zc = await import('../client/core/zcrypto.mjs')
  const { roomId, hub } = zc.parseInviteLink(String(link).trim())
  return { room_id: zc.hex(roomId), hub }
}

/** The room this folder belongs to: from the invite link, TROMMI_ROOM, or the only key file of this folder. */
export async function resolveRoom(cfg) {
  if (cfg.room) return cfg.room
  if (cfg.invite) return (await roomOfLink(cfg.invite)).room_id
  let rooms = []
  try { rooms = fs.readdirSync(cfg.keys_dir).filter(r => fs.existsSync(path.join(cfg.keys_dir, r, `${cfg.base}.key`))) } catch {}
  if (rooms.length > 1) throw Object.assign(new Error(`this folder has keys for ${rooms.length} rooms (${rooms.join(', ')}); set TROMMI_ROOM`), { code: 'ambiguous-room' })
  return rooms[0] ?? null
}

export const pathsOf = (cfg, room_id) => {
  const dir = path.join(cfg.keys_dir, room_id)
  return { dir, key_file: path.join(dir, `${cfg.base}.key`), prefix: `${cfg.base}.`, cache: path.join(dir, `${cfg.base}.files`) }
}

/**
 * The member side of the channel: opens or joins the room and keeps it running.
 * Returns { status(), join(link), client, stop() }; `onCommand(cmd)` gets every authorised command.
 */
export async function createChannel({ cfg = channelConfig(), onCommand = () => {}, onReady = () => {} } = {}) {
  const core = await import('../client/core/index.mjs')
  const { fileStorage } = await import('../client/core/storage-file.mjs')
  const me = { phase: 'starting', error: null, client: null, room_id: null, storage: null, joining: null, session: null }
  const process_instance = crypto.randomBytes(8).toString('hex')

  async function storageFor(room_id) {
    const p = pathsOf(cfg, room_id)
    me.room_id = room_id
    me.paths = p
    me.storage = await fileStorage({ dir: p.dir, key_file: p.key_file, prefix: p.prefix })
    return me.storage
  }

  async function run(client) {
    me.client = client
    let chain = Promise.resolve()
    client.on('command', cmd => { chain = chain.then(() => onCommand(cmd)).catch(err => log(`command not relayed: ${err.message}`)) })
    client.on('error', err => log(`client: ${err.message ?? err}`))
    await client.start()
    try {
      me.session = await client.claimSession({ agent_name: '', process_instance })
    } catch (err) {
      if (err.code === 'instance-conflict' || err.status === 409) {
        me.phase = 'conflict'
        me.error = `Another Claude session already runs with this folder's Trommi key (${me.paths.key_file}). Only one process per key: close the other session, or start this one from another folder.`
        client.stop()
        throw Object.assign(new Error(me.error), { code: 'instance-conflict' })
      }
      throw err
    }
    // The name the board shows; the hub never sees it (README: device/<device_id>).
    const id = client.model.room.my_device_id
    const label = { device_name: `${cfg.host} · ${cfg.shown}`, platform: 'claude-code', folder: cfg.shown, host: cfg.host }
    const had = client.model.sessions?.get(id)?.registers?.get(`device/${id}`)?.value
    if (JSON.stringify(had) !== JSON.stringify(label)) await client.setStatus({ [`device/${id}`]: label })
    me.phase = 'ready'
    me.error = null
    await onReady(me)
  }

  async function open() {
    const room_id = await resolveRoom(cfg)
    if (!room_id) { me.phase = 'needs-invite'; return me }
    const storage = await storageFor(room_id)
    if (!fs.existsSync(me.paths.key_file)) {
      if (cfg.invite) return join(cfg.invite)
      me.phase = 'needs-invite'
      return me
    }
    const client = await core.openRoom({ storage })
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
      if (fs.existsSync(pathsOf(cfg, room_id).key_file)) throw new Error(`this folder already has a key for room ${room_id}; restart the session to use it`)
      const storage = await storageFor(room_id)
      me.phase = 'joining'
      const j = await core.joinRoom({ link: String(link).trim(), device_name: '', storage })
      Promise.resolve(j.check_code).then(code => log(`invite answered (check code ${code}); waiting for the app to add this session`)).catch(() => {})
      const client = await j.client
      await run(client)
      return me
    })()
    try { return await me.joining } catch (err) {
      me.phase = me.phase === 'conflict' ? 'conflict' : 'needs-invite'
      me.error = err.message
      throw err
    } finally { me.joining = null }
  }

  async function stop() {
    try { me.client?.stop() } catch {}
    await me.storage?.flush?.()
  }

  return { me, open, join, stop, cfg }
}

// ---- MCP ---------------------------------------------------------------------------------------------

const JOIN_TOOL = {
  name: 'join',
  description: 'Join a Trommi room with an agent invite link (made in the Trommi app: invite an agent). Needed once per room, machine and folder; afterwards this folder keeps its key and every new session here reconnects by itself. Returns when the human\'s app has added this session.',
  inputSchema: { type: 'object', properties: { link: { type: 'string', description: 'The invite link, https://app.trommi.com/join#v1....' } }, required: ['link'] },
}

export async function main() {
  const cfg = channelConfig()
  const mcp = new Server(
    { name: 'trommi', version: '0.1.0' },
    {
      capabilities: { experimental: { 'claude/channel': {}, 'claude/channel/permission': {} }, tools: {} },
      instructions: `${INSTRUCTIONS} This board is end-to-end encrypted: this process is a member of the room with its own key. If a tool says this session is not in a Trommi room yet, ask the human for an agent invite link from the Trommi app and call join with it.`,
    },
  )
  const notify = (method, params) => mcp.notification({ method, params }).catch(err => log(`notification lost: ${err.message}`))
  let bridge = null
  const channel = await createChannel({
    cfg,
    onCommand: cmd => bridge?.command(cmd),
    onReady: async me => {
      const storage = me.storage
      const state = { permissions: {}, ...(await storage.get('channel')) }
      bridge = createBridge({ client: me.client, notify, cacheDir: me.paths.cache, state, saveState: () => storage.set('channel', state), log })
      log(`in room ${me.room_id} as ${me.client.model.room.my_device_id.slice(0, 12)}…, session ${me.session?.agent_session_id ?? '?'}`)
    },
  })

  const text = t => ({ content: [{ type: 'text', text: t }] })
  const notReady = () => {
    const me = channel.me
    if (me.phase === 'conflict') return me.error
    if (me.phase === 'joining') return 'Joining the Trommi room: waiting for the human to confirm this session in the Trommi app. Try again in a moment.'
    if (me.phase === 'starting') return 'Connecting to the Trommi hub; try again in a moment.'
    return `This session is not in a Trommi room yet${me.error ? ` (${me.error})` : ''}. Ask the human for an agent invite link (Trommi app: invite an agent) and call join with it, or start Claude Code with TROMMI_INVITE set.`
  }
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...TOOLS, JOIN_TOOL] }))
  mcp.setRequestHandler(CallToolRequestSchema, async req => {
    const args = req.params.arguments ?? {}
    try {
      if (req.params.name === 'join') {
        await channel.join(args.link)
        return text(`joined: this session is now a member of room ${channel.me.room_id}; its key is kept in ${channel.me.paths.key_file}`)
      }
      if (!bridge || channel.me.phase !== 'ready') return { ...text(notReady()), isError: true }
      return text(await bridge.callTool(req.params.name, args))
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
    channel.open().then(me => { if (me.phase === 'needs-invite') log(notReady()) }).catch(err => {
      if (channel.me.phase !== 'conflict') channel.me.phase = 'needs-invite'
      channel.me.error = err.message
      log(`not connected: ${err.message}`)
    })
  }
  const bye = async () => { await channel.stop(); process.exit(0) }
  process.stdin.on('end', bye)
  process.on('SIGTERM', bye)
  process.on('SIGINT', bye)
  await mcp.connect(new StdioServerTransport())
}

async function cli(argv) {
  const [cmd, arg] = argv
  if (cmd === 'join') {
    if (!arg) throw new Error('usage: node hub/channel.mjs join <invite link>')
    const channel = await createChannel({ onCommand: () => {} })
    log('joining; confirm this session in the Trommi app')
    const me = await channel.join(arg)
    console.log(`joined room ${me.room_id} as device ${me.client.model.room.my_device_id}, session ${me.session?.agent_session_id}; key file ${me.paths.key_file}`)
    await channel.stop()
    process.exit(0)
  }
  if (cmd === 'whoami') {
    const cfg = channelConfig()
    const room = await resolveRoom(cfg)
    console.log(JSON.stringify({ room_id: room, key_file: room ? pathsOf(cfg, room).key_file : null, has_key: room ? fs.existsSync(pathsOf(cfg, room).key_file) : false, folder: cfg.shown, host: cfg.host }, null, 2))
    process.exit(0)
  }
  throw new Error(`unknown command ${cmd}; use join <link> or whoami, or no argument for the MCP server`)
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/hub/channel.mjs')) {
  const run = process.argv.length > 2 ? cli(process.argv.slice(2)) : main()
  run.catch(err => { log(err.message); process.exit(1) })
}
