// protocol.mjs: the interop driver protocol (README "Interop"). Every implementation of a Trommi client exposes one
// device as a driver process speaking JSON lines on stdin/stdout:
//
//   driver -> {"ready": true, "impl": "js" | "swift", "driver_protocol": 1}                      (first line)
//   runner -> {"id": 7, "cmd": "list_cards", "args": {...}}
//   driver -> {"id": 7, "ok": true, "result": ...} | {"id": 7, "ok": false, "error": {"code", "message"}}
//
// Logs go to stderr. A command a driver does not have answers {"code": "unsupported"}. The drivers:
//   js     node dev/interop/driver-js.mjs                     (shared/, the web app's core)
//   swift  ios/TrommiCore/.build/debug/trommi-swift driver --home <dir>   (TrommiCore/TrommiClient, the iPhone's core)
//   rust   connector-rs/target/debug/trommi-connector driver --home <dir>  (the Rust connector's core; an agent only)
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

export const DRIVER_PROTOCOL = 1

/**
 * Every command: who can run it (human | agent | any; tool: test tooling), its arguments and its result. The runner and parity.mjs read
 * this table; a driver lists what it has in version_info.commands.
 */
export const COMMANDS = {
  version_info: { who: 'any', args: '{}', result: '{ impl, driver_protocol, client, protocol_version, schema_version, commands, roles, known: { content_types, object_types, card_types, answer_actions, envelope_kinds, timeline_kinds }, hub }' },
  found_room: { who: 'human', args: '{ hub_url, name }', result: '{ room_id, device_id, recovery_code }' },
  join: { who: 'any', args: '{ link, name }', result: '{ check_code }: the join goes on in the background' },
  join_wait: { who: 'any', args: '{ name? }', result: '{ device_id, room_id }' },
  login: { who: 'human', args: '{ hub_url, email, password, name }', result: '{ device_id, room_id }' },
  forgot: { who: 'human', args: '{ hub_url, email, words, new_password, name }', result: '{ device_id }' },
  add_account: { who: 'human', args: '{ email, password, recovery_code }', result: '{}' },
  account_status: { who: 'human', args: '{}', result: '{ email, verified, has_recovery } | null' },
  make_kit: { who: 'human', args: '{ password }', result: '{ words, email }' },
  change_password: { who: 'human', args: '{ current, next }', result: '{}' },
  whoami: { who: 'any', args: '{}', result: '{ device_id, room_id, role, live, key_epoch }' },
  sync: { who: 'any', args: '{}', result: '{}' },
  set_live: { who: 'any', args: '{ on }', result: '{}' },
  members: { who: 'any', args: '{}', result: '[{ device_id, role, active, name }]' },
  sessions: { who: 'any', args: '{}', result: '[{ session_id, agent_device_ids, active, name }]' },
  list_cards: { who: 'any', args: '{ all? }', result: '[card]' },
  card: { who: 'any', args: '{ card }', result: 'card' },
  answer: { who: 'human', args: '{ card, choices, note?, option_notes?, trusted? }', result: '{ envelope_number }' },
  shred: { who: 'human', args: '{ card, note? }', result: '{ envelope_number }' },
  mark_read: { who: 'human', args: '{ card }', result: '{ envelope_number }' },
  decide_again: { who: 'human', args: '{ card }', result: '{ envelope_number }' },
  chat_send: { who: 'any', args: '{ session | card, text }', result: '{ envelope_number }' },
  chat_list: { who: 'any', args: '{ session | card }', result: '[{ from: human | agent, text, content_type, state, envelope_number }]' },
  set_register: { who: 'human', args: '{ key, value }', result: '{}' },
  registers: { who: 'human', args: '{}', result: '{ keys, desks }' },
  note_save: { who: 'human', args: '{ text }', result: '{ id }' },
  notes: { who: 'human', args: '{}', result: '[{ id, text }]' },
  invite: { who: 'human', args: '{ role: human | agent, label? }', result: '{ invite_id, link }' },
  invite_status: { who: 'human', args: '{ invite_id }', result: '{ state: open | confirm_code | done | …, check_code }' },
  invite_confirm: { who: 'human', args: '{ invite_id, matches }', result: '{ session_id? }' },
  remove_member: { who: 'human', args: '{ device_id | device_ids }', result: '{ key_epoch }' },
  leave: { who: 'human', args: '{}', result: '{}' },
  register_push: { who: 'human', args: '{ apns: { token, environment, topic, key } } | { webpush: subscription }', result: '{}' },
  check_envelope: { who: 'any', args: '{ envelope_number, envelope }', result: '{ ok, code, content_state }: verified against this device, nothing applied' },
  hub_envelopes: { who: 'tool', args: '{ after?, limit? }', result: '[{ envelope_number, envelope }]: GET envelopes as this device (test tooling, JS only)' },
  alerts: { who: 'any', args: '{}', result: '[{ code, envelope_number }]' },
  scribble_draw: { who: 'human', args: '{ entry? }: on the room board; entry as a strokes item carries it (README "Scribble strokes"); default fixtures/strokes.json strokes[0]', result: '{}' },
  scribble_shapes: { who: 'human', args: '{}: the room board', result: '[{ id, tool, points }]: points -1 when the entry does not decode' },
  agent_card: { who: 'agent', args: '{ title, options?, card_type?, urgency?, body?, sections?, html?, allows_multiple?, newer_schema? }', result: '{ id }' },
  agent_revise: { who: 'agent', args: '{ card, ...fields }', result: '{}' },
  close_card: { who: 'agent', args: '{ card, summary }', result: '{}' },
  withdraw_card: { who: 'agent', args: '{ card, reason }', result: '{}' },
  agent_inbox: { who: 'agent', args: '{}', result: '[{ command, object_id, choices, text, sender_device_id, unsupported }]' },
  agent_newer: { who: 'tool', args: '{ kind: message | answer, on }', result: '{}: what this device writes next is of a newer schema (JS only, tests)' },
}

/** The normalised card both drivers return (list_cards, card). */
export const CARD_KEYS = ['id', 'title', 'card_type', 'state', 'closed_how', 'urgency', 'session_id', 'agent_device_id', 'options', 'choices', 'multiple', 'unsupported',
  'version', 'teaser', 'sections', 'has_html', 'attachments', 'has_picture', 'recommended', 'urgency_reason', 'close_summary', 'in_stack']

const here = path.dirname(new URL(import.meta.url).pathname)
export const SWIFT_BIN = process.env.TROMMI_SWIFT_BIN ?? path.join(here, '../../ios/TrommiCore/.build/debug/trommi-swift')
export const swiftAvailable = () => fs.existsSync(SWIFT_BIN)
// The Rust connector (connector-rs/): an agent device only. `cargo build` in connector-rs makes it.
export const RUST_BIN = process.env.TROMMI_RUST_BIN ?? path.join(here, '../../connector-rs/target/debug/trommi-connector')
export const rustAvailable = () => fs.existsSync(RUST_BIN)

/** Start a driver process; returns { impl, call(cmd, args), stop(), stderr() }. call rejects with { code, message }. */
export async function startDriver(impl, { home, label = impl, env = {}, timeout_ms = 60_000 } = {}) {
  const [cmd, args] = impl === 'swift' ? [SWIFT_BIN, ['driver', '--home', home]] : impl === 'rust' ? [RUST_BIN, ['driver', '--home', home]] : [process.execPath, [path.join(here, 'driver-js.mjs')]]
  const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } })
  let buf = '', err = '', next = 1, ready
  const waiting = new Map()
  const readyP = new Promise((ok, bad) => { ready = { ok, bad } })
  p.stdout.on('data', d => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      if (!line.trim()) continue
      let m
      try { m = JSON.parse(line) } catch { err += `[stdout] ${line}\n`; continue }
      if (m.ready) { ready.ok(m); continue }
      const w = waiting.get(m.id)
      if (!w) continue
      waiting.delete(m.id); clearTimeout(w.timer)
      if (m.ok) w.ok(m.result); else w.bad(Object.assign(new Error(`${label} ${w.cmd}: ${m.error?.code}: ${m.error?.message ?? ''}`), { code: m.error?.code, status: m.error?.status }))
    }
  })
  p.stderr.on('data', d => { err += d; if (err.length > 200_000) err = err.slice(-100_000) })
  p.on('exit', code => {
    ready.bad(new Error(`${label} driver exited (${code}) before it was ready: ${err.slice(-800)}`))
    for (const w of waiting.values()) { clearTimeout(w.timer); w.bad(Object.assign(new Error(`${label} driver exited (${code}) during ${w.cmd}: ${err.slice(-800)}`), { code: 'driver-exit' })) }
    waiting.clear()
  })
  const hello = await Promise.race([readyP, new Promise((_, bad) => setTimeout(() => bad(new Error(`${label} driver not ready: ${err.slice(-800)}`)), 15_000))])
  const call = (cmd, a = {}) => new Promise((ok, bad) => {
    const id = next++
    const timer = setTimeout(() => { waiting.delete(id); bad(Object.assign(new Error(`${label} ${cmd}: timed out`), { code: 'timeout' })) }, timeout_ms)
    waiting.set(id, { ok, bad, cmd, timer })
    p.stdin.write(JSON.stringify({ id, cmd, args: a }) + '\n')
  })
  return { impl, label, hello, call, stderr: () => err, stop: () => new Promise(r => { if (p.exitCode != null) return r(); p.on('exit', r); p.stdin.end(); setTimeout(() => p.kill(), 3000).unref() }) }
}
