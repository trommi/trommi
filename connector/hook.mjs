// hook.mjs: Claude Code's permission prompts on the board, for a plain `claude` with the Trommi plugin.
//
// With the channel flag Claude Code relays a permission prompt to the connector itself (claude/channel/permission).
// Without it nothing is relayed, so the plugin (connector/plugin.mjs) declares two hooks:
//
//   PermissionRequest  `node channel.mjs permission`  asks the human on the board and answers for them
//   Notification       `node channel.mjs notice`      says "the terminal is waiting for you" when no card stands for it
//
// A hook is a short-lived process of its own. It never opens the key: it hands its request to the running connector
// of the same Claude Code session through that connector's door (channel-lock.mjs, the socket `say` uses). The
// connector files the permission request it files in channel mode (bridge.permissionRequest), waits for the human's
// verdict and answers the hook, which prints Claude Code's decision JSON. No verdict in time, no connector, not in a
// room, a session with the channel flag: the hook prints nothing and exits 0, which is "no decision": Claude Code
// goes on with its own dialog in the terminal.
//
// Which connector: the one whose parent is an ancestor of the hook process (both are children of one Claude Code
// process), so two sessions in one folder each ask through their own.
import fs from 'node:fs'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

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

const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s }

/** What the card shows of a tool call: its own description if it has one, and the call itself in short. */
export function previewOf(tool_input) {
  const i = tool_input && typeof tool_input === 'object' ? tool_input : {}
  const preview = typeof i.command === 'string' ? i.command : JSON.stringify(i)
  return { description: clip(typeof i.description === 'string' ? i.description : '', 300), input_preview: clip(preview, 600) }
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
export function createHookDesk({ heard, bridge, say, ppid = process.ppid, log = () => {}, settle_ms = 1500 }) {
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

  return {
    async handle(req, gone = new Promise(() => {})) {
      if (!Array.isArray(req.ancestors) || !req.ancestors.includes(ppid)) return { ok: false, error: 'another session' }
      if (req.op === 'permission') return heard ? { ok: true, silent: true } : permission(req, gone)
      if (req.op === 'notice') return notice(req)
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
