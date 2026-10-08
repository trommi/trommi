// driver-js.mjs: the interop driver of the JS core (shared/, what the web app and the connector run). One device per
// process, JSON lines on stdin/stdout (dev/interop/protocol.mjs). A human device (found_room, join with a human
// invite, login) or an agent (join with an agent invite: agent_card, close_card, agent_inbox, …).
import fs from 'node:fs'
import readline from 'node:readline'
import * as core from '../../shared/index.mjs'
import * as A from '../../shared/account.mjs'
import * as codec from '../../shared/codec.ts'
import { COMMANDS, DRIVER_PROTOCOL } from './protocol.mjs'

const z = core.z
const out = v => process.stdout.write(JSON.stringify(v) + '\n')
const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
const until = async (what, fn, ms = 20_000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) fail('timeout', `timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 30)) } }

let client = null, joining = null, recoveryCode = null
const inbox = []
const te = new TextEncoder()
const STROKES = JSON.parse(fs.readFileSync(new URL('./fixtures/strokes.json', import.meta.url), 'utf8'))

async function adopt(c) {
  client = c
  await client.start()
  if (!client.is_human) {
    client.on('command', cmd => inbox.push(cmd))
    await client.whenSession()
  }
  return client
}
const need = () => client ?? fail('no-room', 'join or log in first')
const settle = async () => { await need().flush?.(); await client.settle?.({ timeout_ms: 15_000 }) }
const cardOf = id => {
  const m = need().model.cards
  const c = m.get(id) ?? [...m.values()].find(x => x.object_id.startsWith(id))
  return c ?? fail('not-found', `no card ${id}`)
}
const cardJSON = c => ({
  id: c.object_id, title: c.title ?? '', card_type: c.card_type ?? 'decision', state: c.object_state, closed_how: c.closed_how ?? null, urgency: c.urgency,
  session_id: c.session_id ?? null, agent_device_id: c.agent_device_id,
  options: (c.options ?? []).map(o => (typeof o === 'string' ? { key: o, label: o, final: false } : { key: o.key, label: o.label ?? o.key, final: o.final === true })),
  choices: c.answer?.choices ?? [], multiple: c.allows_multiple === true, unsupported: !!c.unsupported, version: c.object_version, teaser: c.teaser ?? null,
  sections: c.sections?.length ?? 0, has_html: c.html != null, attachments: c.attachments?.length ?? 0,
  has_picture: (c.attachments ?? []).some(a => String(a.media_type ?? '').startsWith('image/')),
  recommended: c.recommended == null ? [] : Array.isArray(c.recommended) ? c.recommended : [c.recommended],
  urgency_reason: c.urgency_reason ?? null, close_summary: c.close_summary ?? null, in_stack: client.model.stack.includes(c.object_id),
})
// A newer client (forward-compatibility tests): the next writes of a kind carry a newer schema / content type.
const newer = { message: false, answer: false, card: false }
function patchEncoder(c) {
  c.encodePayload = (kind, content) => {
    let x = { schema_version: 1, ...content }
    if (newer.message && content.content_type === 'message') x = { ...x, content_type: 'voice', duration_ms: 1200 }
    else if (newer.answer && kind === codec.KIND.answer) x = { ...x, schema_version: 2 }
    else if (newer.card && kind === codec.KIND.object_version && content.object_type === 'card') x = { ...x, schema_version: 2 }
    else return codec.encodePayload(kind, content)
    return te.encode(JSON.stringify(x))
  }
}

/** whiteboard.mjs deskCanvas (its module needs the built vendor files, so the same rule here when they are missing) */
function deskCanvas(desk) {
  const id = String(desk || 'main')
  if (/^[0-9a-f]{32}$/.test(id)) return `desk/${id}`
  const bytes = new TextEncoder().encode(id), o = new Uint8Array(16)
  bytes.forEach((v, i) => { o[i % 16] ^= v })
  o[15] ^= bytes.length & 0xff
  return `desk/${z.hex(o)}`
}

const H = {
  async version_info() {
    let hub = null
    if (client) hub = await fetch(new URL('/v1/version', client.hub.hub_url)).then(r => r.json()).catch(() => null)
    return {
      impl: 'js', driver_protocol: DRIVER_PROTOCOL, client: 'web', protocol_version: 1, schema_version: codec.SCHEMA_VERSION, commands: Object.keys(H), roles: ['human', 'agent'],
      known: { content_types: [...codec.CONTENT_TYPES].sort(), object_types: [...codec.OBJECT_TYPES].sort(), card_types: [...codec.CARD_TYPES].sort(), answer_actions: [...codec.ANSWER_ACTIONS].sort(),
        envelope_kinds: Object.values(codec.KIND).sort((a, b) => a - b), timeline_kinds: Object.keys(codec.TIMELINE_KIND_NAME).map(Number).sort((a, b) => a - b) },
      hub,
    }
  },
  async found_room({ hub_url, name = 'JS human' }) {
    const r = await core.foundRoom({ hub_url, storage: core.memoryStorage(), device_name: name })
    recoveryCode = r.recovery_code
    await adopt(r.client)
    return { room_id: client.model.room.room_id, device_id: client.my_device_id, recovery_code: r.recovery_code }
  },
  async join({ link, name = 'JS device' }) {
    const j = core.joinRoom({ link, storage: core.memoryStorage(), device_name: name, device_info: { device_name: name, platform: 'node' }, poll_ms: 50 })
    joining = j.client
    joining.catch(() => {})
    return { check_code: await j.check_code }
  },
  async join_wait() {
    if (!joining) fail('bad-argument', 'no join running')
    const c = await joining
    joining = null
    await adopt(c)
    return { device_id: c.my_device_id, room_id: c.model.room.room_id }
  },
  async login({ hub_url, email, password, name = 'JS login' }) {
    const r = await A.loginWithPassword({ hub_url, email, password, storage: core.memoryStorage(), device_name: name })
    await adopt(r.client)
    return { device_id: client.my_device_id, room_id: client.model.room.room_id }
  },
  async forgot({ hub_url, email, words, new_password, name = 'JS forgot' }) {
    const r = await A.resetPassword({ hub_url, email, words, new_password, storage: core.memoryStorage(), device_name: name })
    await adopt(r.client)
    return { device_id: client.my_device_id }
  },
  async add_account({ email, password, recovery_code }) { await A.addAccount(need(), { email, password, recovery_code: recovery_code ?? recoveryCode }); return {} },
  async account_status() { const s = await A.accountStatus(need()); return s ? { email: s.email, verified: !!s.email_verified_at, has_recovery: !!s.has_recovery } : null },
  async make_kit({ password }) { const k = await A.makeEmergencyKit(need(), { password }); return { words: k.words, email: k.email } },
  async change_password({ current, next }) { await A.changePassword(need(), { current, next }); return {} },
  async whoami() { const c = need(); return { device_id: c.my_device_id, room_id: c.model.room.room_id, role: c.is_human ? 'human' : 'agent', live: c.model.room.connection === 'live', key_epoch: c.model.room.key_epoch } },
  async sync() { await need().catchUp(); return {} },
  async set_live() { return {} },
  async members() { return [...need().model.members.values()].sort((a, b) => a.device_id.localeCompare(b.device_id)).map(m => ({ device_id: m.device_id, role: m.device_role, active: m.is_active, name: m.device_name ?? '' })) },
  async sessions() { return [...need().model.sessions.values()].sort((a, b) => a.session_id.localeCompare(b.session_id)).map(s => ({ session_id: s.session_id, agent_device_ids: s.agent_device_ids, active: s.is_active, name: s.settings?.name ?? null })) },
  async list_cards({ all = false } = {}) { return [...need().model.cards.values()].filter(c => all || c.object_state === 'open').sort((a, b) => a.object_id.localeCompare(b.object_id)).map(cardJSON) },
  async card({ card }) { return cardJSON(cardOf(card)) },
  async answer({ card, choices = [], note, option_notes, trusted }) {
    const c = cardOf(card)
    if (trusted) await need().trust({ object_id: c.object_id, note }); else await need().answer({ object_id: c.object_id, choices, note, option_notes })
    await settle(); return {}
  },
  async shred({ card, note }) { await need().shred({ object_id: cardOf(card).object_id, note }); await settle(); return {} },
  async mark_read({ card }) { await need().markRead({ object_id: cardOf(card).object_id }); await settle(); return {} },
  async decide_again({ card }) { await need().decideAgain({ object_id: cardOf(card).object_id }); await settle(); return {} },
  async chat_send({ session, card, text }) {
    const c = need()
    await c.sendMessage({ ...(card ? { object_id: cardOf(card).object_id } : {}), ...(session && c.is_human ? { session_id: session } : {}), text })
    await settle(); return {}
  },
  async chat_list({ session, card }) {
    const c = need()
    const key = card ? `chat:card/${card}` : `chat:session/${session ?? c.session_id}`
    const items = await c.timelineWindow(key, { limit: 500 })
    const role = id => c.model.members.get(id)?.device_role ?? 'unknown'
    return items.map(i => ({ from: role(i.sender_device_id), text: i.content?.text ?? null, content_type: i.content_type ?? null, state: i.item_state, envelope_number: i.envelope_number }))
  },
  async set_register({ key, value }) { await need().setRegisters({ [key]: value ?? null }); await settle(); return {} },
  async registers() { const h = need().model.human; return { keys: [...h.raw.keys()].sort(), desks: Object.fromEntries(h.desks) } },
  async note_save({ text }) { const id = await need().saveNote({ text, created_at: Date.now() }); await settle(); return { id } },
  async notes() { return [...need().model.notes.values()].filter(n => (n.object_state ?? 'open') === 'open').sort((a, b) => a.object_id.localeCompare(b.object_id)).map(n => ({ id: n.object_id, text: n.text })) },
  async invite({ role = 'human', label = null }) { const inv = await need().createInvite({ device_role: role, label, app_url: 'http://127.0.0.1/join' }); return { invite_id: inv.invite_id, link: inv.link } },
  async invite_status({ invite_id }) {
    const i = need().model.invites.get(invite_id) ?? fail('not-found', 'no such invite')
    return { state: i.invite_state, check_code: i.check_code ?? null, session_id: i.session_id ?? null }
  },
  async invite_confirm({ invite_id, matches }) {
    await need().confirmInvite(invite_id, !!matches)
    const st = await until('the invite to finish', () => { const i = client.model.invites.get(invite_id); return i && !['open', 'confirm_code', 'confirming', 'adding'].includes(i.invite_state) ? i : null }, 20_000).catch(() => client.model.invites.get(invite_id))
    if (matches && st?.error) fail(st.error, `invite ${st.invite_state}`)
    return { session_id: st?.session_id ?? null }
  },
  async remove_member({ device_id, device_ids }) { await need().removeDevices(device_ids ?? [device_id]); return { key_epoch: client.model.room.key_epoch } },
  async leave() { await need().leaveRoom(); client = null; return {} },
  async register_push({ webpush, apns, remove = false }) {
    if (apns) await need().hub.request('POST', client.hub.roomPath('/push_subscriptions'), { body: remove ? { apns, remove: true } : { apns } })
    else await need().pushSubscribe(webpush, remove)
    return {}
  },
  async check_envelope({ envelope }) {
    const c = need()
    const bytes = z.unb64u(envelope)
    const opts = { state: c.state, chains: c.chains, allowChainStart: true, allowRemovedSender: true, commit: false }
    try {
      const o = await z.openEnvelope(bytes, { ...opts, secrets: c.openKeys, self: c.device.id })
      return { ok: true, code: null, content_state: o.quarantined ? 'undecryptable' : 'ok' }
    } catch (e) {
      if (e.code !== 'no-key') return { ok: false, code: e.code ?? 'error' }
      try { await z.verifyEnvelope(bytes, opts); return { ok: true, code: null, content_state: 'undecryptable' } } catch (e2) { return { ok: false, code: e2.code ?? 'error' } }
    }
  },
  async hub_envelopes({ after = 0, limit = 1000 } = {}) { return (await need().hub.envelopes({ after_envelope_number: after, limit })).envelopes },
  async alerts() { return need().model.alerts.map(a => ({ code: a.code, envelope_number: a.envelope_number ?? null })) },
  /** A stroke on a desk's Scribble Board: `entry` as a strokes item carries it (README "Scribble strokes"), default the
   *  first sample of dev/interop/fixtures/strokes.json. */
  async scribble_draw({ desk = 'main', entry = null }) {
    const W = await import('../../app/web/public/whiteboard.mjs').catch(() => null)
    const timeline_id = W?.deskCanvas?.(desk) ?? deskCanvas(desk)
    await need().sendStrokes({ timeline_id, strokes: [entry ?? STROKES.strokes[0].entry] })
    await settle(); return {}
  },
  /** The shapes on a desk's Scribble Board as this core decodes them (scribble.mjs shapeOf). */
  async scribble_shapes({ desk = 'main' }) {
    const S = await import('../../shared/scribble.ts')
    const W = await import('../../app/web/public/whiteboard.mjs').catch(() => null)
    const timeline_id = W?.deskCanvas?.(desk) ?? deskCanvas(desk)
    const items = await need().loadTimelineAfter(`scribble:${timeline_id}`, 0)
    const out = []
    for (const i of items.items ?? items) for (const [k, e] of (i.content?.strokes ?? []).entries()) {
      const sh = S.shapeOf(e, `${i.envelope_number}:${k}`, i.sender_device_id)
      out.push(sh ? { id: sh.id, tool: sh.tool, points: (sh.pts?.length ?? 0) / 2 } : { id: `${i.envelope_number}:${k}`, tool: e?.tool ?? null, points: -1 })
    }
    return out
  },
  // ---- the agent (the connector's core) ----
  async agent_card({ newer_schema, ...fields }) {
    const c = need()
    if (newer_schema) { newer.card = true; patchEncoder(c) }
    try { const id = await c.sendCard(fields); await settle(); return { id } } finally { newer.card = false }
  },
  async agent_revise({ card, ...fields }) { await need().revise(cardOf(card).object_id, fields); await settle(); return {} },
  async close_card({ card, summary = '' }) { await need().close(cardOf(card).object_id, summary); await settle(); return {} },
  async withdraw_card({ card, reason = '' }) { await need().withdraw(cardOf(card).object_id, reason); await settle(); return {} },
  async agent_inbox() {
    return inbox.map(c => ({ command: c.command, object_id: c.object_id ?? null, choices: c.choices ?? null, text: c.content?.text ?? c.text ?? null, sender_device_id: c.sender_device_id ?? null, unsupported: c.unsupported ?? c.what ?? null }))
  },
  async agent_newer({ kind, on = true }) { newer[kind] = !!on; patchEncoder(need()); return {} },
}

out({ ready: true, impl: 'js', driver_protocol: DRIVER_PROTOCOL })
const rl = readline.createInterface({ input: process.stdin })
let queue = Promise.resolve()
rl.on('line', line => {
  queue = queue.then(async () => {
    let req
    try { req = JSON.parse(line) } catch { return out({ id: null, ok: false, error: { code: 'bad-request', message: 'not a command line' } }) }
    const h = H[req.cmd]
    if (!h) return out({ id: req.id, ok: false, error: { code: 'unsupported', message: `the JS driver has no command ${req.cmd}` } })
    try { out({ id: req.id, ok: true, result: (await h(req.args ?? {})) ?? null }) }
    catch (e) { out({ id: req.id, ok: false, error: { code: e.code ?? 'internal', message: e.message, status: e.status } }) }
  })
})
rl.on('close', () => queue.then(async () => { await client?.stop?.().catch?.(() => {}); process.exit(0) }))
