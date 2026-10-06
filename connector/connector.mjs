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
//   node connector/connector.mjs resolved        the plugin's PostToolUse hook: a prompt answered in the terminal leaves the board
//   node connector/connector.mjs monitor         the plugin's monitor: prints one line per board event of this session
//   node connector/connector.mjs witness <session>  started by a leaving connector: says "cut off" for it when its
//                                              Claude Code process lives on without a connector (the folder watch)
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
//   TROMMI_UNUSED_MS a holder whose session never used Trommi hands the key to a session that does after this long,
//                    default 60000 (at once when its parent is a Claude Code spare)
//   TROMMI_IDLE_MS   a holder whose session used Trommi hands it over after this long without use, default 1800000
//   TROMMI_SPARE     1|0 overrides the look at the parent's command line (`claude bg-spare`)
//   TROMMI_FOLDER_WATCH  0 switches the folder watch off (no marks, no witness, nothing said about other sessions)
//   TROMMI_CUT_GRACE_MS  how long a Claude Code session may be without a connector before it counts as cut off,
//                    default 20000 (a /mcp Reconnect takes a few seconds)
//   TROMMI_LINK_MS   the link report repeats a moved last tool call at most this often, default 30000
//   TROMMI_LINK_TICK_MS  how often the folder is looked at and the report checked, default 5000
//
// Key slot: <keys>/<room_id>/<host>-<folder>-<slot>.key; beside it .state.json (cursor, chains, model), .lock and
// .files/ (the human's attachments, decrypted for Claude). A restarted session reuses its slot (pathsOf, pickSlot).
// Which process gets the key: the one whose Claude Code session is used ("who gets the key", below the lock).

import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
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
// removed either way. The hub's lease fences the old process if it still runs. A claim of another session is never
// taken away: its holder is asked, and gives the key up itself when its session is not using it ("who gets the key").

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
export const openDoor = (p, handler, log) => openDoorAt(doorOf(p), handler, log)
/** The same on a socket file of its own (the bell). */
export function openDoorAt(file, handler, log = () => {}) {
  let ino = null
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
  const mark = () => { const st = fs.statSync(file); return `${st.ino}/${st.ctimeMs}` }   // a freed inode number is given out again
  server.listen(file, () => { try { fs.chmodSync(file, 0o600); ino = mark() } catch {} })
  server.unref()
  // Only our own socket file: a later process (the next holder, the reconnected connector) may have made it anew, and
  // closing a listening socket removes whatever file has its name. Then this one is left as it is (it is unref'd).
  return () => { let own = false; try { own = ino != null && mark() === ino } catch {} ; if (own) { server.close(); fs.rmSync(file, { force: true }) } }
}

/** Knock at a slot's door: resolves the holder's answer, or rejects (no door, no answer within timeout_ms). */
export const knock = (p, request, timeout_ms) => knockAt(doorOf(p), request, timeout_ms)
export function knockAt(file, request, timeout_ms = 30000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(file)
    let buf = ''
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('the connector holding the key did not answer')) }, timeout_ms)
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(JSON.stringify(request) + '\n'))
    sock.on('data', d => { buf += d })
    sock.on('end', () => { clearTimeout(timer); try { resolve(JSON.parse(buf)) } catch { reject(new Error('the connector holding the key gave no answer')) } })
    sock.on('error', err => { clearTimeout(timer); reject(err) })
  })
}

// ==== who gets the key: the session that is used ==================================================================
//
// Claude Code starts this server for every process that loads the project: the session a person works in, background
// sessions, and spare processes its daemon keeps warm (`claude bg-spare`, seen with 2.1.286: six connectors in one
// folder). A key taken by whoever looks first ended up with a session nobody used, and the used one was locked out.
// So the key follows use:
//
//   use        a tools/call of this server from its Claude Code process, or one of the plugin's hooks of that process
//              ringing this connector's bell (a socket named after the Claude Code process, as the monitor's).
//   claiming   A connector takes the key when its session is used. No timer ever takes it. At start-up it takes it
//              only when nobody else could want it (claimsAtStart): never under a spare; otherwise when it is the
//              reconnected connector of the session that holds it, or the only connector of this folder that is not a
//              spare's (presence files `<keys>/<room>/<base>.here.<pid>`, so a lone idle session still hears the board).
//   hand-over  A keyless connector whose session is used asks the holder through the slot's door ({ op: 'yield' }).
//              The holder gives the key up when its own session is not using it (yieldState): never used and held
//              for TROMMI_UNUSED_MS (60 s; at once under a spare), or used but quiet for TROMMI_IDLE_MS (30 min), and
//              no call running. It then stops its client (stream closed, state flushed), closes the door, removes its
//              claim and only then answers; the asker takes the slot lock and the lease. The holder stays up, keyless,
//              and asks in turn when its session is used again. A holder in use answers no, and the asker's tool
//              call fails with the text that names it. Never two writers: the lock and the hub's lease are as before.

/** A Claude Code spare (a pre-started process nobody uses yet): `claude bg-spare --bg-spare <socket>`. */
export function isSpare({ env = process.env, args = null, ppid = process.ppid } = {}) {
  if (env.TROMMI_SPARE === '1') return true
  if (env.TROMMI_SPARE === '0') return false
  return (args ?? argsOf(ppid)).slice(0, 4).some(a => a === 'bg-spare' || a === '--bg-spare')
}

/** Whether a holder gives its key to a session that is used: { free, used, quiet_ms, after_ms }. */
export function yieldState({ used_at = 0, since = 0, calls = 0, spare = false, now = Date.now(), unused_ms = 60_000, idle_ms = 1_800_000 }) {
  const used = used_at > 0
  const quiet_ms = Math.max(0, now - (used ? used_at : since))
  const need = used ? idle_ms : spare ? 0 : unused_ms
  return { free: !calls && quiet_ms >= need, used, quiet_ms, after_ms: calls ? need : Math.max(0, need - quiet_ms) }
}

/** Whether a connector takes the key when it starts, before its session is used. */
export const claimsAtStart = ({ spare, reconnect = false, others = 0, joining = false }) => !spare && (reconnect || joining || !others)

// Presence: every connector of a folder leaves `<base>.here.<pid>` ({ session, spare }) in the room's key directory.
const hereFile = (dir, base, pid = process.pid) => path.join(dir, `${base}.here.${pid}`)
export function checkIn(dir, base, who) { try { fs.writeFileSync(hereFile(dir, base), JSON.stringify(who), { mode: 0o600 }) } catch {} }
export function checkOut(dir, base) { fs.rmSync(hereFile(dir, base), { force: true }) }
/** The other live connectors of the folder: [{ pid, session, spare }]. Files of dead processes are removed (with the folder watch on, by it). */
export function othersHere(dir, base, { keep_dead = false } = {}) {
  const head = `${base}.here.`, out = []
  let names = []
  try { names = fs.readdirSync(dir) } catch {}
  for (const f of names) {
    if (!f.startsWith(head) || !/^\d+$/.test(f.slice(head.length))) continue
    const pid = Number(f.slice(head.length))
    if (pid === process.pid) continue
    if (!alive(pid)) { if (!keep_dead) fs.rmSync(path.join(dir, f), { force: true }); continue }
    try { const who = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); out.push({ pid, session: String(who.session ?? ''), spare: !!who.spare }) } catch {}
  }
  return out
}

// ==== the folder watch: a Claude Code session that lost its connector =============================================
//
// The hub sees one thing of a key: whether a stream is open. It cannot see a Claude Code session whose connector is
// gone while the session itself runs on (Claude Code dropped the MCP server, the connector crashed or was killed):
// that session's Trommi tools are dead, it hears nothing and can say nothing, and with two sessions in one folder
// the key's stream may even stay open in the other one. The connectors of a folder see it for each other:
//
//   presence   a connector's `<base>.here.<pid>` also says which Claude Code process it belongs to (pid and start
//              time), when its session last used Trommi, which key slot it holds and its last link report.
//   the mark   a connector that ends while its Claude Code process lives leaves `<base>.gone.<hash of its session>`
//              (the presence file's content, when and why). One that was killed leaves none: whoever looks at the
//              folder next writes it from the dead process's presence file. Only for a session whose loss means
//              something to the human (lossMatters): it held the key, or it used Trommi within TROMMI_IDLE_MS.
//   cut off    a mark whose Claude Code process still runs (same pid, same start time), with no live connector of
//              that session in the folder, for TROMMI_CUT_GRACE_MS (20 s). A session that is starting has no mark; a
//              reconnect brings a connector of the same session within seconds, whatever the order the old one's mark
//              and the new one's presence are written in; a Claude Code process that ended takes its mark with it.
//   said by    the connector that holds a key says it in its link report (cut_since: the oldest such mark). When the
//              cut-off session held the key and nobody holds it now, whoever sees it says it once in that key's name
//              (lastWord: slot lock, sign-in, lease, one POST agent_link with exit.claude 'alive'; no stream, nothing
//              read, the key's chain untouched): a keyless connector of the folder, or the witness the leaving
//              connector started for the case that nobody else is there.
//
// What it cannot see: a lone connector that was killed (no mark, nobody to write one) shows as gone, not cut off.

const startOf = pid => {
  try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '').split(' ')[19] ?? '' } catch {}
  try { return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim() } catch { return '' }
}
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }
const markFile = (dir, base, session) => path.join(dir, `${base}.gone.${crypto.createHash('sha256').update(String(session)).digest('hex').slice(0, 16)}`)
/** What a connector says of itself in its presence file. */
export const presenceOf = ({ session, spare = false, claude_pid = process.ppid, used_at = 0, slot = null, link = null }) => ({ session, spare, claude_pid, claude_start: startOf(claude_pid), used_at, slot, link })
/** Whether the loss of this connector means something to the human: it held the key, or its session used Trommi lately. */
export const lossMatters = (who, at = Date.now(), idle_ms = 1_800_000) => !!who?.session && Number(who.claude_pid) > 1 && (who.slot != null || (who.used_at > 0 && at - who.used_at < idle_ms))
/** The mark of a connector that is gone (`who`: its presence). */
export function leaveMark(dir, base, who, { at = Date.now(), why = 'stdin', pid = process.pid } = {}) {
  try { fs.writeFileSync(markFile(dir, base, who.session), JSON.stringify({ ...who, at, why, pid }), { mode: 0o600 }) } catch {}
}
/**
 * One look at the folder: buries dead connectors, drops marks that no longer hold, and returns
 * { cut: [mark], pending: [mark], cut_since }: the sessions that are cut off, those still within the grace, and the
 * oldest cut. A mark carries its `file`.
 */
export function folderWatch(dir, base, { now = Date.now(), grace_ms = 20_000, idle_ms = 1_800_000, isAlive = alive, started = startOf, self = process.pid } = {}) {
  const here = `${base}.here.`, gone = `${base}.gone.`
  const list = () => { try { return fs.readdirSync(dir) } catch { return [] } }
  const live = new Set()
  for (const f of list()) {
    if (!f.startsWith(here) || !/^\d+$/.test(f.slice(here.length))) continue
    const pid = Number(f.slice(here.length)), file = path.join(dir, f), who = readJson(file)
    if (pid === self || isAlive(pid)) { if (who?.session) live.add(String(who.session)); continue }
    if (lossMatters(who, now, idle_ms) && !fs.existsSync(markFile(dir, base, who.session))) leaveMark(dir, base, who, { at: now, why: 'killed', pid })
    fs.rmSync(file, { force: true })
  }
  const cut = [], pending = []
  for (const f of list()) {
    if (!f.startsWith(gone)) continue
    const file = path.join(dir, f), t = readJson(file)
    const holds = t?.session && !live.has(String(t.session)) && isAlive(t.claude_pid) && (!t.claude_start || started(t.claude_pid) === t.claude_start)
    if (!holds) { fs.rmSync(file, { force: true }); continue }
    ;(now - t.at >= grace_ms ? cut : pending).push({ ...t, file })
  }
  return { cut, pending, cut_since: cut.length ? Math.min(...cut.map(t => t.at)) : null }
}

/** Ask the holder of a slot for its key. Resolves { ok: true } when it gave it up, else its answer ({ used, quiet_ms, after_ms }) or { silent }. */
export async function askYield(p, { session = '', timeout_ms = 10000 } = {}) {
  let r
  try { r = await knockAt(doorOf(p), { op: 'yield', pid: process.pid, session }, timeout_ms) } catch (err) { return { ok: false, silent: true, error: err.message } }
  if (!r?.ok) return r?.busy ? { ok: false, used: !!r.used, quiet_ms: Number(r.quiet_ms) || 0, after_ms: Number(r.after_ms) || 0 } : { ok: false, silent: true, error: String(r?.error ?? 'no answer') }
  return { ok: true }
}

/** The bell of one Claude Code process: its hooks ring it, so the connector knows its session is used. */
export const bellPath = (claudePid, env = process.env) => path.join(path.dirname(socketPath(claudePid, env)), `bell-${Number(claudePid) || 0}.sock`)
/** A hook's ring at the connector of its own Claude Code process, if one runs: waits until it tried for the key. */
export async function ring(pids, { env = process.env, timeout_ms = 15000 } = {}) {
  for (const pid of pids) {
    const file = bellPath(pid, env)
    if (!fs.existsSync(file)) continue
    try { return await knockAt(file, { op: 'awake', ancestors: pids }, timeout_ms) } catch { return null }
  }
  return null
}

// ==== the plugin's hooks: permission, notice, denied, resolved ====================================================
//
// With the channel flag Claude Code relays a permission prompt to the connector itself (claude/channel/permission).
// Without it nothing is relayed, so the plugin (build.mjs) declares these hooks:
//
//   PermissionRequest  `node connector.mjs permission`  asks the human on the board and answers for them
//   PostToolUse(Failure) `node connector.mjs resolved`  the call went on, so its prompt (if one waits) was answered in the
//                                                     terminal: the connector withdraws the request, its card leaves the board
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
// A prompt answered in the terminal (Claude Code tells nobody, also not a channel; seen with 2.1.286): allowed there,
// the PermissionRequest hook keeps running, but the call's PostToolUse hook fires at once with the same tool_name and
// tool_input; denied there, Claude Code ends the PermissionRequest hook (SIGTERM), so its door connection closes.
// Either way the connector withdraws the request. With the channel flag the hook asks nothing itself, but it stays
// to give the same two signals for the request Claude Code relayed for that prompt (paired by tool name, in order).
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
  if (kind === 'resolved') {
    if (!input.tool_name || DIALOG_TOOLS.has(input.tool_name)) return null
    return { op: 'resolved', ancestors: ancestors(), tool_name: String(input.tool_name), ...previewOf(input.tool_input) }
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
 *   heard:   this session has the channel flag, so Claude Code relays permission prompts itself: the hooks ask nothing
 *   bridge:  () => the bridge, or null while not in a room
 *   say:     (bridge, { text, urgent }) => Promise, the side channel's sender
 * Returns { handle(request, gone) -> answer, verdict(params) -> true when the verdict was a hook's,
 *           relayed(params): a request Claude Code relayed over the channel }.
 */
export function createHookDesk({ heard, bridge, say, ppid = process.ppid, log = () => {}, settle_ms = 1500, denied_window_ms = 30_000, pair_ms = 30_000, now = Date.now }) {
  const open = []      // the prompts a permission hook waits on: { tool_name, key, request_id, end(how) }
  const unpaired = []  // channel mode: relayed requests no hook has come for yet: { request_id, tool_name, at }
  let answered_at = 0
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const keyOf = req => [req.tool_name, req.description ?? '', req.input_preview ?? ''].map(String).join('\n')

  async function permission(req, gone) {
    const b = bridge()
    if (!b) return { ok: false, error: 'not in a room' }
    const wait_ms = Math.min(3600_000, Math.max(1000, Number(req.wait_ms) || 300_000))
    const entry = { tool_name: String(req.tool_name), key: keyOf(req), request_id: null, end: null }
    const ended = new Promise(resolve => { entry.end = resolve })
    const quiet = heard ? { ok: true, silent: true } : { ok: true, timeout: true }
    let timer
    open.push(entry)
    try {
      if (heard) {
        // Claude Code relayed this prompt itself: no second card. The hook only stands for that request.
        const i = unpaired.findIndex(r => r.tool_name === entry.tool_name && now() - r.at < pair_ms)
        if (i >= 0) entry.request_id = unpaired.splice(i, 1)[0].request_id
      } else {
        entry.request_id = `hook:${crypto.randomBytes(8).toString('hex')}`
        // The card expires when the hook stops waiting: after that the terminal's dialog decides.
        await b.permissionRequest({ request_id: entry.request_id, tool_name: req.tool_name, description: req.description, input_preview: req.input_preview, expires_in_ms: wait_ms })
      }
      const how = await Promise.race([ended, gone.then(() => 'gone'), new Promise(r => { timer = setTimeout(r, wait_ms, 'timeout') })])
      if (how === 'allow' || how === 'deny') {
        answered_at = Date.now()
        return heard ? quiet : { ok: true, behavior: how }
      }
      // Answered in the terminal: allowed (the call went on: `resolved`) or denied (Claude Code ended the hook: `gone`).
      if (how !== 'timeout' && entry.request_id) {
        answered_at = Date.now()
        await Promise.resolve(bridge()?.permissionWithdraw(entry.request_id, 'answered in the terminal')).catch(err => log(`permission request not withdrawn: ${err.message}`))
      }
      return quiet
    } finally { clearTimeout(timer); open.splice(open.indexOf(entry), 1) }
  }

  /** PostToolUse of a call: the prompt that stood for exactly this call (if one waits) was answered in the terminal. */
  function resolved(req) {
    const entry = open.find(e => e.key === keyOf(req))
    entry?.end('resolved')
    return { ok: true, ...(entry ? { withdrawn: true } : { silent: true }) }
  }

  async function notice(req) {
    if (!NOTICE_TYPES.includes(req.notification_type)) return { ok: true, silent: true }
    if (req.notification_type === 'permission_prompt') {
      if (heard) return { ok: true, silent: true }
      // The permission hook of the same prompt may be a moment behind; a card that stands for it, or a verdict just given, is enough.
      await sleep(settle_ms)
      if (open.length || Date.now() - answered_at < settle_ms + 10_000) return { ok: true, silent: true }
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
      if (req.op === 'permission') return permission(req, gone)
      if (req.op === 'resolved') return resolved(req)
      if (req.op === 'notice') return notice(req)
      if (req.op === 'denied') return denied(req)
      return { ok: false, error: 'unknown request' }
    },
    /** A verdict the bridge reports: true when it answers a hook (then it is not a channel notification). */
    verdict(params) {
      const id = String(params?.request_id)
      const entry = open.find(e => e.request_id === id)
      entry?.end(params.behavior === 'allow' ? 'allow' : 'deny')
      if (!HOOK_ID.test(id)) return false
      if (!entry) log(`verdict for a permission hook that waits no more (${id})`)
      return true
    },
    /** Channel mode: Claude Code relayed a prompt. The permission hook of the same prompt (before or after) stands for it. */
    relayed(params) {
      const entry = open.find(e => !e.request_id && e.tool_name === String(params.tool_name))
      if (entry) entry.request_id = String(params.request_id)
      else { unpaired.push({ request_id: String(params.request_id), tool_name: String(params.tool_name), at: now() }); if (unpaired.length > 20) unpaired.shift() }
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
    server.listen(file, () => { try { ino = mark() } catch {} })
    server.unref()
  } catch (err) { log(`monitor socket not opened: ${err.message}`) }
  // Only our own socket file: after /mcp Reconnect the new connector of the same session may have made it anew (and
  // closing a listening socket removes whatever file has its name; a freed inode number is given out again).
  const mark = () => { const st = fs.statSync(file); return `${st.ino}/${st.ctimeMs}` }
  const own = () => { try { return ino != null && mark() === ino } catch { return false } }
  const unlink = () => { if (own()) try { fs.unlinkSync(file) } catch {} }
  process.on('exit', unlink)
  return {
    file,
    connected: () => clients.size > 0,
    push(line) { for (const s of clients) s.write(`${line.replace(/[\r\n]+/g, ' ')}\n`) },
    close() { for (const s of clients) s.destroy(); if (own()) { server?.close(); unlink() } },
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
async function pickSlot(cfg, room_id, { ask = false } = {}) {
  const dir = path.join(cfg.keys_dir, room_id)
  const keyed = slotsIn(cfg, dir)
  const holders = []
  let refused = null
  for (const n of keyed) {
    const p = pathsOf(cfg, room_id, n)
    let r = await claimSlot(p, { session: cfg.session, wait_ms: cfg.takeover_ms })
    if (r.took_over?.length) log(`slot ${n} taken over from the earlier connector of this session (pid ${r.took_over.join(', ')})`)
    // This session is used (ask): a holder whose session is not gives the key up, cleanly, before this one takes it.
    if (!r.ok && ask) {
      const was = r.holders, y = await askYield(p, { session: cfg.session })
      if (y.ok) {
        r = await claimSlot(p, { session: cfg.session, wait_ms: cfg.takeover_ms })
        if (r.ok) { log(`slot ${n} handed over by its idle holder (pid ${was.join(', ')})`); r.handed_over = true }
      } else refused ??= { slot: n, pids: was, ...y }
    }
    if (r.ok) return { ...p, has_key: true, busy: keyed.filter(k => k < n), holders, took_over: !!r.took_over?.length, handed_over: !!r.handed_over }
    holders.push(...r.holders)
  }
  for (let n = 1; ; n++) {
    if (keyed.includes(n)) continue
    const p = pathsOf(cfg, room_id, n)
    if ((await claimSlot(p, { session: cfg.session, wait_ms: cfg.takeover_ms })).ok) return { ...p, has_key: false, busy: keyed, holders, refused }
  }
}

/**
 * This process as a member of the room: opens or joins the room and keeps it running.
 * Returns { me, open(), join(link), stop() }; `onCommand(cmd)` gets every authorised command.
 */
async function createMember({ cfg = connectorConfig(), onCommand = () => {}, onReady = () => {}, onLeaseLost = () => {}, onTooOld = () => {}, onRetired = () => {} } = {}) {
  const core = await import('../shared/index.mjs')
  const { fileStorage } = await import('../shared/storage-file.mjs')
  // Phases: asleep (the key not asked for yet, or given back), starting, then as before.
  const me = { phase: 'asleep', error: null, client: null, room_id: null, storage: null, joining: null, session: null, paths: null }
  const process_instance = crypto.randomBytes(8).toString('hex')
  // The sidebar shows the folder's name, as today's board does ("trommi"); host and full folder are for the details view.
  const device_info = { device_name: path.basename(cfg.folder) || cfg.shown, platform: 'claude-code', folder: cfg.shown, host: cfg.host }

  async function storageFor(room_id, { ask = false } = {}) {
    if (me.paths && me.room_id !== room_id) { unlockSlot(me.paths); me.paths = null }
    const p = me.paths ?? await pickSlot(cfg, room_id, { ask })
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
      if (me.client !== client) return   // the key was handed over: this client is stopped
      if (me.phase === 'halted') return log(`command ${cmd.envelope_number} held back: the member list forked`)
      // Executed once (R4): the ledger survives restarts; a command is marked after Claude Code got it.
      chain = chain.then(async () => {
        if (cmd.envelope_hash && client.ledger?.has(cmd.envelope_hash)) return
        await onCommand(cmd)
        if (cmd.envelope_hash) await client.ledger?.mark(cmd.envelope_hash)
      }).catch(err => log(`command not relayed: ${err.message}`))
    })
    // Removed from the member list (checked against the signed list): this key is retired. Said plainly, once, instead
    // of tool calls that fail one by one.
    client.on('removed', ({ replaced } = {}) => {
      if (me.client !== client) return
      me.phase = 'retired'
      me.error = replaced
        ? `This connector is retired: the human let another connector continue this Trommi session (a new invite link for the same session), and this key (${me.paths.key_file}) no longer belongs to the room. Nothing sent from here reaches the board. If this Claude Code session should use Trommi again, the human invites it in the Trommi app.`
        : `This connector is retired: the human removed its key (${me.paths.key_file}) from the Trommi room. Nothing sent from here reaches the board. To use Trommi again here, the human invites this session in the Trommi app.`
      log(me.error)
      onRetired(me)
    })
    client.on('error', err => {
      if (me.client !== client) return
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

  async function open({ ask = false } = {}) {
    const room_id = await resolveRoom(cfg)
    if (!room_id) { me.phase = 'needs-invite'; return me }
    const storage = await storageFor(room_id, { ask })
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
      j.check_code.then(code => log(`invite answered: check code ${code.slice(0, 3)} ${code.slice(3)} (if the Trommi app asks which number this session shows, it is this one); waiting for the app to add this session`)).catch(() => {})
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

  /** Give up what this process holds of the slot: the client stopped (its stream closed, its state on disk), then the claim. */
  async function drop() {
    const c = me.client
    me.client = null
    me.session = null
    if (c) { await c.settle({ timeout_ms: 3000 }).catch(() => {}); await c.stop().catch(() => {}) }
    await me.storage?.flush?.()
    if (me.paths) unlockSlot(me.paths)
    me.paths = null
    me.storage = null
  }

  /**
   * Take the key, if this process has none: it sleeps (never asked, or gave the key back), or it ended up keyless
   * because another process held the key. `ask`: this session is used, so an idle holder is asked to hand over (pickSlot).
   * Never rejects: what went wrong is in me.error, and the next call tries again.
   */
  let claiming = null
  function claim({ ask = false } = {}) {
    if (claiming) return claiming
    const keyless = me.phase === 'needs-invite' && !me.joining && me.paths && !me.paths.has_key && me.paths.busy.length
    if (me.phase !== 'asleep' && !keyless) return Promise.resolve(me)
    claiming = (async () => {
      await releasing
      if (me.paths) unlockSlot(me.paths)
      me.paths = null
      me.storage = null
      me.error = null
      me.phase = 'starting'
      return await open({ ask })
    })().catch(async err => {
      if (me.phase === 'retired') return me              // said by the 'removed' handler, in its own words
      me.error = err.message
      if (err.code === 'client-too-old') me.phase = 'too-old'
      else if (me.phase === 'starting') { await drop().catch(() => {}); me.phase = 'asleep' }   // e.g. the hub out of reach: the next call tries again
      log(`not connected: ${err.message}`)
      return me
    }).finally(() => { claiming = null })
    return claiming
  }

  /** Hand the key back (a hand-over to a session that is used): afterwards this process sleeps and holds nothing. */
  let releasing = null
  function release() {
    me.phase = 'asleep'
    releasing = drop().catch(err => log(`key not given back cleanly: ${err.message}`)).finally(() => { releasing = null })
    return releasing
  }

  async function stop() {
    try { await me.client?.stop() } catch {}
    await me.storage?.flush?.()
    if (me.paths) unlockSlot(me.paths)
    process.off('exit', onExit)
  }
  const onExit = () => { if (me.paths) unlockSlot(me.paths) }
  process.on('exit', onExit)

  return { me, open, join, claim, release, stop, cfg }
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
 * The plugin's hooks: `permission`, `notice`, `denied` and `resolved`. Reads the hook's JSON on stdin, asks the running
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
  // A hook means this Claude Code session is used: its connector takes the key first, if it has none (the bell).
  await ring(request.ancestors)
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
/**
 * "Cut off", said once in the name of a key nobody holds (the folder watch): the mark's session held slot `t.slot`,
 * its connector is gone and its Claude Code process lives on. Takes the slot lock (so no connector opens the key
 * meanwhile), signs in with the key, takes the lease (no live process holds it) and posts one link report. No stream,
 * no envelope, nothing read: the key's chain and its cursor stay as they are. False when a connector holds the slot
 * (it says it itself, in its own report).
 */
async function lastWord(cfg, room_id, t) {
  const p = pathsOf(cfg, room_id, t.slot)
  if (!fs.existsSync(p.key_file) || !lockSlot(p, `witness:${process.pid}`)) return false
  try {
    const core = await import('../shared/index.mjs')
    const { fileStorage } = await import('../shared/storage-file.mjs')
    const storage = await fileStorage({ dir: p.dir, key_file: p.key_file, prefix: p.prefix })
    const room = await storage.get('room'), device = await storage.loadDevice()
    if (!room || !device) return false
    const hub = new core.Hub({ hub_url: room.hub_url, room_id, client: CLIENT, signer: challenge => core.z.signHubAuth({ device, roomId: core.z.unhex(room_id), hub: hub.hub_url, challenge }) })
    hub.lease_generation = (await hub.agentLease({ process_instance: `witness-${crypto.randomBytes(6).toString('hex')}` })).lease_generation
    await hub.agentLinkLast({ hears: 'live', ...(t.link ?? {}), cut_since: null, exit: { reason: /^[a-z0-9-]{1,40}$/.test(t.why ?? '') ? t.why : 'stdin', claude: 'alive' } }, 8000)
    const { file, ...mark } = t
    try { fs.writeFileSync(file, JSON.stringify({ ...mark, told: true }), { mode: 0o600 }) } catch {}
    log(`said for the session of Claude Code pid ${t.claude_pid}: cut off (its connector, pid ${t.pid}, is gone)`)
    return true
  } catch (err) { log(`cut off not said: ${err.message}`); return false } finally { unlockSlot(p) }
}

/**
 * `witness <session>`: started detached by a connector that ends while its Claude Code process lives. Waits out the
 * grace; if the session is then cut off and nobody holds its key, says so (lastWord). Ends when the session has a
 * connector again, when its Claude Code process ended, or after it spoke.
 */
async function witnessCli(session) {
  const cfg = { ...connectorConfig(process.env, { write: false }), invite: '' }
  const room_id = await resolveRoom(cfg)
  if (!room_id || !session) return
  const dir = path.join(cfg.keys_dir, room_id)
  const grace_ms = envMs(process.env.TROMMI_CUT_GRACE_MS, 20_000), idle_ms = envMs(process.env.TROMMI_IDLE_MS, 1_800_000)
  const until = Date.now() + grace_ms + 60_000
  for (;;) {
    const w = folderWatch(dir, cfg.base, { grace_ms, idle_ms })
    const t = [...w.cut, ...w.pending].find(m => m.session === session)
    if (!t) return
    if (w.cut.includes(t)) { if (t.slot != null && !t.told) await lastWord(cfg, room_id, t); return }
    if (Date.now() > until) return
    await sleep(Math.max(50, Math.min(1000, grace_ms / 4)))
  }
}
const envMs = (v, d) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d)
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
const OTHERS_NOTE = '(This waited in the connector for another Claude Code session of this folder, which held the key before this one.)'
/** A tool call's `session` argument (a helper's child session), or null: the main session's call. */
const sessionArg = args => (typeof args?.session === 'string' && args.session.trim() ? args.session.trim().toLowerCase() : null)

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
  // Events Claude Code would drop (channelsHeard false) wait here and go out with the next tool result. Each entry is
  // { params, about, from }: about = { session_id, envelope_number } of the human's command (null for a notice the
  // connector made itself), from = the Claude Code session whose connector queued it. The queue is kept in the key
  // slot's state ('missed'), so a restart or a hand-over of the key loses none: whoever holds the key next hands them on.
  const missed = []
  let deafTold = false
  if (!heard) log(DEAF_HINT)
  const saveMissed = () => Promise.resolve(member.me.storage?.set('missed', missed)).catch(err => log(`waiting events not stored: ${err.message}`))
  const queue = (params, about) => { missed.push({ params, about, from: cfg.session }); if (missed.length > 100) missed.shift(); saveMissed() }
  // The receipt (shared/model.mjs "the receipt"): written when events were really handed to the agent, one mark per
  // session, a burst in one write.
  const marks = new Map()
  let markTimer = null
  const receipt = abouts => {
    for (const a of abouts) if (a?.session_id && Number.isSafeInteger(a.envelope_number)) marks.set(a.session_id, Math.max(marks.get(a.session_id) ?? -1, a.envelope_number))
    if (marks.size) markTimer ??= setTimeout(flushMarks, 150)
  }
  const flushMarks = () => {
    markTimer = null
    const c = member.me.client
    if (!c?.markHeard || member.me.phase !== 'ready') return
    for (const [sid, n] of marks) { marks.delete(sid); c.markHeard(n, { session_id: sid }).catch(err => log(`receipt not written: ${err.message}`)) }
  }
  const waitsFor = about => !!about?.session_id && missed.some(e => e.about?.session_id === about.session_id)
  const notify = async (method, params, about = null) => {
    // A verdict on a permission request a hook filed goes to that hook, not to Claude Code.
    if (method === 'notifications/claude/channel/permission' && desk.verdict(params)) return
    const event = method === 'notifications/claude/channel'
    if (!heard && event) {
      // The first command that waits in a session without a mark: everything before it is with the agent, this one is not.
      if (about?.envelope_number > 0 && !waitsFor(about) && member.me.client?.model?.sessions.get(about.session_id)?.heard_up_to == null) receipt([{ ...about, envelope_number: about.envelope_number - 1 }])
      queue(params, about)
      const line = pointerLine(params)
      if (line) feed?.push(line)
    }
    const sent = await mcp.notification({ method, params }).then(() => true, err => { log(`notification lost: ${err.message}`); return false })
    if (!heard || !event) return
    // Shown by Claude Code: the agent has it. Not sent (the stdio is closing): it waits for the next connector.
    if (!sent) queue(params, about)
    else if (!waitsFor(about)) receipt([about])
  }
  /** `said` with the waiting events for this caller: a helper's call (child: its session's name) gets only its own. */
  const withMissed = (said, child = null) => {
    const events = missed.filter(e => !child || String(e.params?.meta?.session ?? '').toLowerCase() === child)
    if (heard ? !events.length : !events.length && (deafTold || feedOn())) return said
    if (events.length) {
      for (const e of events) missed.splice(missed.indexOf(e), 1)
      saveMissed()
      receipt(events.map(e => e.about))
    }
    // With the plugin's monitor listening (or the channel flag), the session is not deaf: no hint to restart with the flag.
    const head = heard || feedOn() ? '' : !deafTold || events.length ? `[Trommi: ${DEAF_HINT}]` : ''
    if (!heard) deafTold = true
    const tag = e => channelTag(e.from && e.from !== cfg.session ? { ...e.params, content: `${OTHERS_NOTE}\n${e.params.content}` } : e.params)
    return [said, head, ...(events.length ? [`[Trommi: ${events.length} board event${events.length === 1 ? '' : 's'} that Claude Code did not show you:]`, ...events.map(tag)] : [])].filter(Boolean).join('\n\n')
  }
  /** What waited in the key slot when this process took it: queued again, or shown at once with the channel flag. */
  async function takeWaiting(storage) {
    const stored = (await storage.get('missed').catch(() => null)) ?? []
    if (!Array.isArray(stored) || !stored.length) return
    missed.unshift(...stored.filter(e => e?.params && !missed.some(m => m.params === e.params)))
    if (!heard) { for (const e of stored) { const line = pointerLine(e.params); if (line) feed?.push(line) } return }
    for (const e of missed.splice(0)) {
      const params = e.from && e.from !== cfg.session ? { ...e.params, content: `${OTHERS_NOTE}\n${e.params.content}` } : e.params
      if (await mcp.notification({ method: 'notifications/claude/channel', params }).then(() => true, () => false)) receipt([e.about]); else missed.push(e)
    }
    saveMissed()
  }
  let bridge = null, closeDoor = null
  // Use of this session (tool calls, its hooks): what decides who gets the key ("who gets the key").
  const ms = envMs
  const spare = isSpare()
  const use = { at: 0, since: 0, calls: 0, unused_ms: ms(process.env.TROMMI_UNUSED_MS, 60_000), idle_ms: ms(process.env.TROMMI_IDLE_MS, 1_800_000) }
  const touch = () => { use.at = Date.now() }
  let here = null   // the room's key directory, where this process is checked in
  // The plugin's hooks ask here; with the channel flag Claude Code relays permission prompts itself.
  const desk = createHookDesk({ heard, bridge: () => (bridge && member.me.phase === 'ready' ? bridge : null), say: sayWith, log })
  // Leaving must not hang: a stop that waits on the network or the disk gets 2 s, then the process ends anyway.
  // (A connector that outlived its Claude Code session kept the key slot, and the reconnected one had none.)
  let leaving = false
  let updates = null
  const parent = process.ppid
  // The folder watch (above): on unless switched off.
  const watchOn = process.env.TROMMI_FOLDER_WATCH !== '0'
  const grace_ms = ms(process.env.TROMMI_CUT_GRACE_MS, 20_000)
  const presence = () => presenceOf({ session: cfg.session, spare, used_at: use.at, slot: member.me.phase === 'ready' ? member.me.paths?.slot ?? null : null, link: said?.report ?? null })
  /**
   * `reason` is the last word to the hub (exit.reason): stdin, signal, parent-gone, lease-lost. With the Claude Code
   * process still there, the hub hears 'checking' and the folder watch decides: a mark and a witness are left.
   */
  const bye = async (why, reason = 'stdin') => {
    if (leaving) return
    leaving = true
    log(`leaving: ${why}`)
    setTimeout(() => process.exit(0), 2000).unref()
    const claude = reason !== 'parent-gone' && process.ppid === parent && alive(parent)
    const who = presence()
    // The last word, briefly (the 2 s cap above holds). A process fenced out has none: its successor speaks.
    if (member.me.phase === 'ready' && reason !== 'lease-lost') await Promise.race([lastReport({ reason, claude: claude && watchOn ? 'checking' : 'gone' }), sleep(800)])
    try {
      if (here) {
        checkOut(here, cfg.base)
        if (watchOn && claude && lossMatters(who, Date.now(), use.idle_ms)) {
          leaveMark(here, cfg.base, who, { why: reason })
          spawn(process.execPath, [SELF_PATH, 'witness', cfg.session], { detached: true, stdio: 'ignore', cwd: cfg.folder, env: { ...process.env, TROMMI_FOLDER: cfg.folder } }).unref()
        }
      }
    } catch (err) { log(`no mark left: ${err.message}`) }
    try { closeDoor?.(); closeBell?.(); updates?.stop(); feed?.close(); clearInterval(linkTimer); await member.stop() } catch {}
    process.exit(0)
  }
  const member = await createMember({
    cfg,
    onLeaseLost: () => bye('lease lost', 'lease-lost'),
    onRetired: async me => { await member.stop().catch(() => {}); notify('notifications/claude/channel', { content: me.error, meta: { kind: 'chat', retired: '1' } }) },
    onTooOld: async me => { await member.stop(); notify('notifications/claude/channel', { content: me.error, meta: { kind: 'chat', upgrade_required: '1' } }) },
    onCommand: cmd => bridge?.command(cmd),
    onReady: async me => {
      const storage = me.storage
      // The bridge's persisted state keeps its key 'channel' in the slot's state file (child sessions, releases, open approvals).
      const state = { permissions: {}, ...(await storage.get('channel')) }
      bridgeArgs = { client: me.client, notify, cacheDir: me.paths.cache, state, saveState: () => storage.set('channel', state), log }
      bridge = code.createBridge(bridgeArgs)
      await takeWaiting(storage)
      // The door for `say` (the emergency side channel) and the plugin's hooks: all go through this process, on this
      // key's one chain.
      use.since = Date.now()
      closeDoor ??= openDoor(me.paths, async (req, gone) => {
        if (['permission', 'notice', 'denied', 'resolved'].includes(req?.op)) return desk.handle(req, gone)
        if (req?.op === 'yield') return yieldKey(req)
        if (req?.op !== 'say') return { ok: false, error: 'unknown request' }
        if (!bridge || member.me.phase !== 'ready') return { ok: false, error: notReady() }
        return { ok: true, said: await sayWith(bridge, req) }
      }, log)
      watchLink()
      log(`in room ${me.room_id} as ${me.client.model.room.my_device_id.slice(0, 12)}…, session ${me.session?.agent_session_id ?? '?'}`)
    },
  })

  // A keyless connector whose session is used asks for the key: given only when this session is not using it.
  let yielding = false
  async function yieldKey(req) {
    if (yielding || member.me.phase !== 'ready') return { ok: false, error: notReady() }
    const state = yieldState({ used_at: use.at, since: use.since, calls: use.calls, spare, unused_ms: use.unused_ms, idle_ms: use.idle_ms })
    if (!state.free) return { ok: false, busy: true, used: state.used, quiet_ms: state.quiet_ms, after_ms: state.after_ms }
    yielding = true
    try {
      log(`handing the key to connector pid ${Number(req.pid) || '?'}: this session ${state.used ? `has not used Trommi for ${Math.round(state.quiet_ms / 1000)} s` : 'never used Trommi'}`)
      await Promise.race([lastReport({ reason: 'handover', claude: 'gone' }, { working: false }), sleep(800)])
      said = null
      // What waits goes with the key (it is in the slot's state): the next holder hands it on.
      await saveMissed(); missed.length = 0; marks.clear()
      bridge = null; bridgeArgs = null
      closeDoor?.(); closeDoor = null
      await member.release()
      return { ok: true, yielded: true }
    } finally { yielding = false }
  }
  // The bell: a hook of this Claude Code process rings, so this session is used.
  const closeBell = (() => {
    try {
      return openDoorAt(bellPath(process.ppid), async req => {
        if (req?.op !== 'awake' || !Array.isArray(req.ancestors) || !req.ancestors.includes(process.ppid)) return { ok: false, error: 'another session' }
        await wake()
        return { ok: true, phase: member.me.phase }
      }, log)
    } catch (err) { log(`bell not opened: ${err.message}`); return null }
  })()
  /** This session is used: take the key if this process has none. Waits up to 15 s, also for a holder about to hand over. */
  async function wake() {
    touch()
    const end = Date.now() + 15000
    for (;;) {
      await Promise.race([member.claim({ ask: true }), sleep(Math.max(0, end - Date.now()))])
      const r = member.me.paths?.refused
      if (member.me.phase !== 'needs-invite' || !r || r.silent || r.used || r.after_ms > end - Date.now() - 3000) break
      await sleep(r.after_ms + 50)
    }
    if (member.me.phase === 'ready') touch()
  }

  const text = t => ({ content: [{ type: 'text', text: t }] })
  const secs = n => (n < 90_000 ? `${Math.max(1, Math.round(n / 1000))} s` : `${Math.round(n / 60_000)} min`)
  const notReady = () => {
    const me = member.me
    if (['conflict', 'halted', 'lease-lost', 'too-old', 'retired'].includes(me.phase)) return me.error
    if (me.phase === 'joining') return 'Joining the Trommi room: waiting for the human to confirm this session in the Trommi app. Try again in a moment.'
    if (me.phase === 'waiting-session') return 'This agent is in the Trommi room but not yet assigned to a session: the human assigns it in the Trommi app. Try again in a moment.'
    if (me.phase === 'starting') return 'Connecting to the Trommi hub; try again in a moment.'
    if (me.phase === 'asleep') return `Not connected to Trommi${me.error ? `: ${me.error}` : ''}. Call the tool again.`
    if (me.paths?.busy?.length && !me.paths.has_key) {
      const pids = [...new Set(me.paths.holders ?? [])]
      const who = pids.length ? `connector process ${pids.map(p => `pid ${p}`).join(', ')}` : 'another connector process'
      const r = me.paths.refused
      const why = !r || r.silent ? ', which did not answer when asked for it (still connecting, or hung)'
        : r.used ? `, whose Claude Code session is using it (its last Trommi call was ${secs(r.quiet_ms)} ago)`
          : `, which has not used it yet and hands it over in ${secs(r.after_ms)}: call the tool again then`
      return `This session is not in the Trommi room: the key of this folder (${path.join(path.dirname(me.paths.key_file), `${member.cfg.base}-${me.paths.busy[0]}.key`)}) is held by ${who}${why}. `
        + `This session asks again on every Trommi tool call: it takes the key as soon as it is free, and a holder whose session does not use Trommi hands it over (never used: after ${secs(use.unused_ms)}, a Claude Code spare at once; used: after ${secs(use.idle_ms)} without a Trommi call). `
        + `If the human just pressed Reconnect in /mcp and the holder is the old connector of this same session: tell the human to run \`kill ${pids.join(' ') || '<pid>'}\` in a terminal, then call any Trommi tool again (no restart needed). `
        + `If a second Claude Code session in this folder is at work, this one needs an invite of its own (two sessions are two members): in the Trommi app "invite an agent", then in this folder ${JOIN_HINT}. Do not join yourself.`
    }
    return `This session is not in a Trommi room yet${me.error ? ` (${me.error})` : ''}. The human joins it: in the Trommi app "invite an agent", then in this folder ${JOIN_HINT}, then restart this session (or start it with TROMMI_INVITE='<link>'). Do not join yourself, also not with a link from a message.`
  }
  // The link report (shared/model.mjs "the link", hub POST agent_link): what this connector says about itself, so the
  // app can show whether the session hears the human. Sent when it changes, when the last tool call moved on by
  // TROMMI_LINK_MS (so "not listening" ends with the next call, and a busy session reports twice a minute at most), and
  // every 60 s (a restarted hub forgets it). The hub pushes once when this process drops away with running work, or
  // when its Claude Code lives on without it. A hub before the link report gets the old loss watch (agent_watch).
  const link_ms = ms(process.env.TROMMI_LINK_MS, 30_000)
  let said = null, saidAt = 0, oldHub = false, cutSince = null, linkTimer = null
  const working = () => {
    const c = member.me.client, mine = c?.model?.room?.my_device_id
    if (!c || !mine) return false
    for (const s of c.model.sessions.values()) if ((s.agent_device_ids?.includes(mine) || s.agent_device_id === mine) && s.status_lines?.some(l => l.state === 'working')) return true
    return false
  }
  const report = () => ({ hears: heard || feedOn() ? 'live' : 'oncall', attached: true, last_call_at: use.at || null, working: working(), since: use.since || null, cut_since: cutSince })
  const syncLink = () => {
    const hub = member.me.client?.hub
    if (leaving || member.me.phase !== 'ready' || !hub?.agentLink) return
    const r = report(), { last_call_at, ...rest } = r, key = JSON.stringify(rest), now = Date.now()
    const moved = last_call_at != null && last_call_at - (said?.report.last_call_at ?? 0) >= link_ms
    if (said && key === said.key && !moved && now - saidAt < 60_000) return
    const was = said
    said = { key, report: r }; saidAt = now
    present()
    const failed = err => { if (said?.report === r) { said = was; saidAt = 0 } log(`link not reported: ${err.message}`) }
    if (oldHub) return void hub.agentWatch(r.working).catch(failed)
    hub.agentLink(r).catch(err => {
      if (err.status !== 404) return failed(err)
      oldHub = true
      log('this hub knows no link report: only the loss watch is set')
      hub.agentWatch(r.working).catch(failed)
    })
  }
  /** The last word of this process, or of its hold on the key: the report with why it ends. */
  const lastReport = (exit, more = {}) => {
    const hub = member.me.client?.hub
    if (!hub) return Promise.resolve()
    if (oldHub) return hub.agentWatch(false).catch(() => {})
    return hub.agentLinkLast({ ...report(), ...more, exit }, 1500).catch(err => log(`last word not said: ${err.message}`))
  }
  // The folder watch: which sessions of this folder are cut off. The holder of a key reports the oldest; a cut-off
  // session whose key nobody holds is spoken for once.
  const speaking = new Set()
  function lookAround() {
    if (!here || !watchOn || leaving) return
    const w = folderWatch(here, cfg.base, { grace_ms, idle_ms: use.idle_ms })
    cutSince = w.cut_since
    const room_id = path.basename(here)
    for (const t of w.cut) {
      if (t.slot == null || t.told || speaking.has(t.file) || (member.me.phase === 'ready' && member.me.paths?.slot === t.slot)) continue
      speaking.add(t.file)
      lastWord(cfg, room_id, t).finally(() => speaking.delete(t.file))
    }
  }
  // The presence file follows what this process is: its slot, its last use, its last report.
  let presentAs = ''
  function present() {
    if (!here || leaving) return
    const who = presence(), text = JSON.stringify(who)
    if (text !== presentAs) { presentAs = text; checkIn(here, cfg.base, who) }
  }
  const tick = () => { try { lookAround() } catch (err) { log(`folder watch: ${err.message}`) } syncLink(); present() }
  function watchLink() { tick() }
  // A session left without a key tells the human once, through the door of the connector that holds it (say path).
  let told = false
  const tellHolder = () => {
    const p = member.me.paths
    // Only when the holder's session is at work: a holder about to hand over needs no human.
    if (told || !p || p.has_key || !p.busy?.length || !p.holders?.length || !p.refused?.used) return
    told = true
    const held = pathsOf(cfg, member.me.room_id, p.busy[0])
    const pids = [...new Set(p.holders)]
    knock(held, { op: 'say', urgent: true, text: `A Claude Code session in ${cfg.shown} is cut off from Trommi: its connector (pid ${process.pid}) has no key, the key is held by connector pid ${pids.join(', ')}, whose session is using it. If that is the old connector of a reconnect: kill ${pids.join(' ')} in a terminal; the session takes the key on its next Trommi tool call. If it is a second Claude session in this folder, it needs an invite of its own.` }, 15000)
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
    use.calls++
    try {
      const child = sessionArg(args)
      if (req.params.name === code.RELOAD_TOOL.name) return text(withMissed(await reload(), child))
      // A tool call is use of this session: now it takes the key, if it has none.
      await wake()
      if (req.params.name === code.INBOX_TOOL.name && (missed.length || bridge)) return text(missed.length ? withMissed('').trim() : 'No new board events.')
      if (!bridge || !['ready', 'halted'].includes(member.me.phase)) { tellHolder(); return { ...text(notReady()), isError: true } }
      const out = withMissed(await bridge.callTool(req.params.name, args), child)
      touch()
      syncLink()
      // Told once, on the next tool result after an update was found (in case the event was missed).
      if (hint && !child) { const h = hint; hint = null; return text(`${out}\n\n${h}`) }
      return text(out)
    } catch (err) {
      return { ...text(`error: ${err.message}`), isError: true }
    } finally { use.calls-- }
  })
  mcp.setNotificationHandler(
    z.object({ method: z.literal('notifications/claude/channel/permission_request'), params: z.object({ request_id: z.string(), tool_name: z.string(), description: z.string(), input_preview: z.string() }) }),
    async ({ params }) => {
      if (!bridge) return log('approval request not relayed: not in a room')
      desk.relayed(params)
      for (let attempt = 1; ; attempt++) {
        try { return await bridge.permissionRequest(params) } catch (err) {
          if (attempt === 5) return log(`approval request not relayed: ${err.message}`)
          await new Promise(r => setTimeout(r, 500))
        }
      }
    },
  )
  // After the handshake: check in, and take the key only when nobody else could want it (claimsAtStart). Otherwise
  // this process sleeps until its session is used (wake); no timer takes a key.
  mcp.oninitialized = async () => {
    let now = true, why = ''
    try {
      const room_id = await resolveRoom(cfg)
      if (room_id && fs.existsSync(path.join(cfg.keys_dir, room_id))) {
        here = path.join(cfg.keys_dir, room_id)
        present()
        const keyed = slotsIn(cfg, here)
        const reconnect = keyed.some(n => { const p = pathsOf(cfg, room_id, n); return holdersOf(p).some(pid => sessionOf(p, pid) === cfg.session) })
        const others = othersHere(here, cfg.base, { keep_dead: watchOn }).filter(o => !o.spare && o.session !== cfg.session)
        now = claimsAtStart({ spare, reconnect, others: others.length, joining: !!cfg.invite && !keyed.length })
        why = spare ? 'its parent is a Claude Code spare' : `${others.length} other connector${others.length === 1 ? '' : 's'} in this folder (pid ${others.map(o => o.pid).join(', ')})`
      }
    } catch {}   // e.g. keys of several rooms: open() says so
    linkTimer = setInterval(tick, ms(process.env.TROMMI_LINK_TICK_MS, 5000))
    linkTimer.unref()
    if (!now) return log(`asleep (${why}): this process takes the Trommi key when its session is used (a Trommi tool call, a hook)`)
    const me = await member.claim()
    if (me.paths?.took_over) touch()   // the reconnected connector of a session goes on as that session
    if (me.phase === 'needs-invite') log(notReady())
  }
  // The MCP stdio is this process's life line: Claude Code closing it, a signal, or the parent going away ends it.
  process.stdin.on('end', () => bye('stdin ended'))
  process.stdin.on('close', () => bye('stdin closed'))
  process.on('SIGTERM', () => bye('SIGTERM', 'signal'))
  process.on('SIGINT', () => bye('SIGINT', 'signal'))
  process.on('SIGHUP', () => bye('SIGHUP', 'signal'))
  setInterval(() => { if (process.ppid !== parent || !alive(parent)) bye(`parent ${parent} gone`, 'parent-gone') }, 2000).unref()
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
    console.log(`joined room ${me.room_id} as device ${me.client.model.room.my_device_id}, session ${me.client.session_id ?? me.session?.agent_session_id}; key file ${me.paths.key_file}`)
    await member.stop()
    process.exit(0)
  }
  if (cmd === 'say') {
    console.log(await sayCli(argv.slice(1)))
    process.exit(0)
  }
  // The Trommi plugin's hooks. Always exit 0: no output is "no decision".
  if (['permission', 'notice', 'denied', 'resolved'].includes(cmd)) {
    const out = await hookCli(cmd).catch(err => { log(`hook ${cmd}: ${err.message}`); return '' })
    if (out) await new Promise(r => process.stdout.write(`${out}\n`, r))
    process.exit(0)
  }
  // The Trommi plugin's monitor: prints this Claude Code session's board notifications.
  if (cmd === 'monitor') return runMonitor()
  // The folder watch's witness (started by a leaving connector).
  if (cmd === 'witness') { await witnessCli(given).catch(err => log(`witness: ${err.message}`)); process.exit(0) }
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
