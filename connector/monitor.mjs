// monitor.mjs: board events for a plain `claude` (no --dangerously-load-development-channels), via a plugin monitor.
//
// Without the channel flag Claude Code drops every notifications/claude/channel event. The Trommi plugin
// (connector/plugin.mjs) therefore declares a monitor: `node channel.mjs monitor`, a background process whose every
// stdout line Claude Code hands to Claude as a notification, waking an idle session. The two processes meet on a
// Unix socket named after the Claude Code process both belong to (the connector is its child, the monitor gets
// CLAUDE_PID), so two sessions in one folder each hear only their own connector.
//
// Security: a monitor line is never board data. The connector writes a line only for an event the core has already
// verified and authorised (a command signed by an active human device of this room, addressed to this agent), and
// the line is a fixed pointer built from sanitised ids ("Trommi: ... call the trommi tool inbox"). The event itself
// reaches Claude only as the inbox tool's result, like any other tool result of this MCP server. Connector-made
// notices (update_available, client too old) never become monitor lines; they come with the next tool result.
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'

/** The socket of one Claude Code process: <runtime dir>/trommi-<uid>/mon-<pid>.sock (the directory is 0700). */
export function socketPath(claudePid, env = process.env) {
  const base = env.XDG_RUNTIME_DIR && fs.existsSync(env.XDG_RUNTIME_DIR) ? env.XDG_RUNTIME_DIR : os.tmpdir()
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'u'
  return path.join(base, `trommi-${uid}`, `mon-${Number(claudePid) || 0}.sock`)
}

// Events of a human's verified command (connector/channel-bridge.mjs command()). Anything else gets no line.
const KINDS = {
  chat: 'message', decision: 'answer to a question', info_read: 'info card read', shredded: 'card thrown away',
  decision_reopened: 'answer taken back', handback_withdrawn: 'card taken back', pad: 'pad selection',
}
const cleanId = v => String(v ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
const cleanName = v => String(v ?? '').replace(/[^\p{L}\p{N} ._-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40)

// The inbox tool as Claude Code names it: the plugin's server (plugin:trommi:trommi) or a .mcp.json server "trommi".
export const inboxToolName = (env = process.env) => env.CLAUDE_PLUGIN_ROOT ? 'mcp__plugin_trommi_trommi__inbox' : 'mcp__trommi__inbox'

/** The one line the monitor prints for a channel event, or null when the event is not a human's command. */
export function pointerLine(params, tool = inboxToolName()) {
  const meta = params?.meta ?? {}
  const what = KINDS[meta.kind]
  if (!what || meta.upgrade_required || meta.update_available) return null
  const session = cleanName(meta.session), card = cleanId(meta.card_id)
  return `Trommi: new ${meta.history ? 'earlier (context only) ' : ''}${what} from the human on the board${session ? ` for session "${session}"` : ''}${card ? `, card ${card}` : ''}. Read it now with the tool ${tool}.`
}

export const MONITOR_NOTE = `No <channel> events reach this session: a line "Trommi: …" from the monitor means the human's board spoke (verified by the connector). Call ${inboxToolName()} at once and handle its result like a <channel> message.`

export const INBOX_TOOL = {
  name: 'inbox',
  _meta: { 'anthropic/alwaysLoad': true },
  description: 'Read the board events that arrived since the last call (the human\'s messages, answers and card actions, as <channel> blocks). Call it whenever a monitor line starting with "Trommi:" arrives, then handle each event like a channel message from the human.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
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
 * The monitor's end (`node channel.mjs monitor`): connects to the socket of its Claude Code process and prints each
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
