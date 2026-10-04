// Memos as end-to-end objects (trommi-hub client/core README, "memo"): every human device may write a new version,
// concurrent versions are settled by the core's causal order (R2). What the old hub's POST /memo did (server.mjs
// memoAct) is done here with the core, behind the same { code, text } answer, so views/memo.mjs and t/lib/memo.js
// stay as they were.
//
// The memo's own fields beyond the core's (text, x, y, color, desk_id) travel through as they are:
//   place        'float' (over the page) | 'stack' (put away at the round button) | 'paper' (on the Desk's paper)
//   session      agent_device_id of the session whose page it was written on (shown only there, sent to it), or null
//   to           agent_device_id it is addressed to (else the crown of the desk)
//   attachments  README attachment references (uploaded, encrypted, before the version is written)
//   created_at, updated_at
//   held         { to, until } while a sent memo waits for the toast's Undo; the device that wrote it delivers it
//                after `until` (sendMessage, then deleteMemo), also after a reload (sweep). Every page hides it.
//
//   boardMemos(model, devToAgent)    the board state's memos (views/model.mjs shape), from the core's model
//   memoStore(client, board)         -> act(body): POST /memo of the old hub, as { code, text }
import { rememberRef } from './att.mjs'

const HOLD_MS = 3000
const PLACES = ['float', 'stack', 'paper']
const attOf = r => { rememberRef(r); return { name: r.file_name ?? 'file', type: r.media_type ?? '', url: r.url ?? `/att/${r.attachment_id}` } }

/** One memo as the views know it (agent ids for sessions; memos of older app versions named agent ids already). */
function boardMemo(id, n, devToAgent) {
  const agent = d => (d ? devToAgent.get(d) ?? d : null)
  return { id, text: n.text ?? '', to: agent(n.to), session: agent(n.session), place: PLACES.includes(n.place) ? n.place : 'float', x: n.x ?? 0, y: n.y ?? 0, desk: n.desk_id ?? null,
    attachments: (n.attachments ?? []).map(attOf), held: n.held ?? null, created: n.created_at ?? 0, updated: n.updated_at ?? 0 }
}
// (A new memo stands under its local_id until it is sealed: the page that made it gets it by its object_id.)
export const boardMemos = (m, devToAgent) => [...m.memos.values()].filter(n => n.object_state !== 'closed' && !n.removed && !(n.pending && n.object_id === n.local_id)).map(n => boardMemo(n.object_id, n, devToAgent))

/** The memos' actions for one client: made with the facade, so a send held before a reload is delivered when due. */
export function memoStore(client, board) {
  const m = () => client.model
  const dev = agentId => (agentId ? board.agentToDev.get(agentId) ?? (m().sessions.has(agentId) ? agentId : null) : null)
  // The core shows every version at once (optimistic, pending) and chains on the version this client sealed last.
  const current = id => { const n = m().memos.get(id); return n && n.object_state !== 'closed' && !n.removed ? n : null }
  const holds = new Map()   // memo id -> timer of a held send
  const went = new Map()    // memo id -> agent_device_id, delivered lately (a clear "too late" for Undo)

  /** A new version with these fields changed (the core keeps the others), or a new memo. */
  async function save(id, fields) {
    const now = Date.now()
    return client.saveMemo(id ? { object_id: id, ...fields, updated_at: now } : { text: '', x: 0, y: 0, place: 'float', desk_id: board.desk ?? 'main', created_at: now, ...fields, updated_at: now })
  }
  async function remove(id) {
    clearTimeout(holds.get(id)); holds.delete(id)
    if (!current(id)) return
    if (client.deleteMemo) await client.deleteMemo(id)
    else await client.saveMemo({ object_id: id, object_state: 'closed' })   // (the mock room)
  }
  async function deliver(id) {
    holds.delete(id)
    const n = current(id)
    if (!n?.held) return
    const text = String(n.text ?? '').trim()
    await client.sendMessage({ agent_device_id: n.held.to, text, ...(n.attachments?.length ? { attachments: n.attachments } : {}) })
    went.set(id, n.held.to)
    if (went.size > 200) went.delete(went.keys().next().value)
    await remove(id)
  }
  const hold = (id, until) => { clearTimeout(holds.get(id)); holds.set(id, setTimeout(() => deliver(id).catch(err => console.warn('memo', id, err.message)), Math.max(0, until - Date.now()))) }
  // A send held by this device whose page went away meanwhile (a reload): delivered when it is due.
  const sweep = ids => {
    const me = m().room?.my_device_id
    for (const id of ids) {
      const n = m().memos.get(id)
      if (n?.held && n.by_device_id === me && n.object_state !== 'closed' && !holds.has(id)) hold(id, n.held.until)
    }
  }
  client.on('change', ch => { if (ch.memos.size) sweep(ch.memos) })
  sweep(m().memos.keys())

  // { name, data: base64 data URL } of t/lib/memo.js -> an uploaded, encrypted attachment reference.
  async function upload({ name, data }, object_id) {
    const [, type = 'application/octet-stream', b64 = ''] = /^data:([^;,]*)(?:;[^,]*)?,(.*)$/s.exec(String(data)) ?? []
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    const meta = { file_name: String(name || 'file'), media_type: type, object_id }
    if (type.startsWith('image/')) { try { const b = await createImageBitmap(new Blob([bytes], { type })); meta.width = b.width; meta.height = b.height; b.close() } catch {} }
    return client.uploadAttachment(bytes, meta)
  }

  const answer = (code, data) => ({ code, text: JSON.stringify(code < 400 ? { ok: true, ...data } : data) })
  const shown = id => { const n = current(id); return n && boardMemo(id, n, board.devToAgent ?? new Map()) }

  return async function act(body) {
    const id = body.id ?? null
    const n = id ? current(id) : null
    if (body.unsend) {
      if (!n) return went.has(id) ? answer(409, { error: 'too late: the memo already went', code: 'delivered' }) : answer(404, { error: 'no such memo', code: 'no-memo' })
      if (!n.held) return answer(409, { error: 'this memo was not sent', code: 'not-sent' })
      clearTimeout(holds.get(id)); holds.delete(id)
      await save(id, { held: null })
      return answer(200, { memo: shown(id) })
    }
    if (id && !n) return answer(404, { error: 'no such memo', code: 'no-memo' })
    if (body.remove) { await remove(id); return answer(200, {}) }
    const fields = {}
    if (body.text != null) fields.text = String(body.text)
    for (const k of ['to', 'session']) if (k in body) fields[k] = body[k] == null || body[k] === '' ? null : dev(String(body[k]))
    if (body.place != null) { if (!PLACES.includes(body.place)) return answer(400, { error: `place must be one of ${PLACES.join(', ')}` }); fields.place = body.place }
    for (const k of ['x', 'y']) if (body[k] != null) { if (!Number.isFinite(body[k])) return answer(400, { error: `${k} must be a number` }); fields[k] = body[k] }
    if (Array.isArray(body.attachments)) {
      const had = n?.attachments ?? []
      try { fields.attachments = await Promise.all(body.attachments.map(a => (a?.data != null ? upload(a, id) : had.find(r => attOf(r).url === a?.url))).filter(Boolean)) }
      catch (err) { return answer(422, { error: `not attached: ${err.message}` }) }
    }
    if (body.send) {
      const to = fields.to ?? fields.session ?? n.session ?? n.to ?? m().human.crown?.agent_device_id ?? null
      if (!to || !m().sessions.has(to)) return answer(409, { error: 'this memo has no session to go to', code: 'no-session' })
      const text = fields.text ?? n.text ?? '', files = fields.attachments ?? n.attachments ?? []
      if (!text.trim() && !files.length) return answer(400, { error: 'empty message' })
      const until = Date.now() + HOLD_MS
      await save(id, { ...fields, held: { to, until } })
      hold(id, until)
      return answer(200, { held: { agent: board.devToAgent?.get(to) ?? to, ms: HOLD_MS }, sent: { agent: board.devToAgent?.get(to) ?? to } })
    }
    const object_id = await save(id, fields)
    return answer(200, { memo: shown(object_id) })
  }
}
