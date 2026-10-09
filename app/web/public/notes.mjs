// ---- note ----
// The note: the one yellow note the human writes to the crowned session. Notes are end-to-end note objects (every
// human device writes versions; a sent note is held 3 s for Undo). The note itself, its markup and its controller,
// is the corner note (sidebar.mjs cornerNote); here are its forms and the store behind them.
//
//   register(t)                    the forms: POST /notes (make), /notes/<id>/keep (the words as they stand; an empty
//                                  note is gone), /bin, /send (to the crown), /unsend (Undo of a send)
//   boardNotes(model)              the board state's notes (app.mjs shape), from the core's model
//   noteStore(client, board)       -> act(body): what the forms and the attachments (POST /note, JSON) do
import { toast } from './ui.mjs'
import { addressOf, crownOf, rememberRef, uploadFile } from './app.mjs'

const holds = (text, files) => Boolean(String(text).trim() || files?.length)

/** The note's forms. Needs hub.note(body), which answers { code, text } (noteStore). */
export function register(t) {
  const base = t.BASE
  const call = async body => {
    const res = await t.hub.note(body)
    let data = {}
    try { data = JSON.parse(res.text) } catch {}
    if (res.code >= 400) throw Object.assign(new Error(data.error || 'the board did not take it'), { status: res.code, code: data.code })
    return data
  }
  const WAYS = {
    async create(_, f) { await call({ text: String(f.get('text') ?? '') }) },
    async keep(note, f) {
      const text = f.has('text') ? String(f.get('text')) : note.text
      await call(holds(text, note.attachments) ? { id: note.id, text } : { id: note.id, remove: true })
    },
    async bin(note, f) {
      const text = f.has('text') ? String(f.get('text')) : note.text, files = note.attachments?.length ?? 0
      await call({ id: note.id, remove: true })
      if (!holds(text, note.attachments)) return null
      return toast({ head: 'Note thrown away', line: text.trim().replace(/\s+/g, ' ').slice(0, 80) || `${files} attached`, undo: { action: `${base}/notes`, fields: { text } } })
    },
    async send(note, f, m) {
      // (on All desks the note names which desk's crowned session gets it)
      const asked = f.has('to') ? m.everyone.find(a => a.id === String(f.get('to')) && a.starred && !a.archived) : null
      const to = asked ?? crownOf(m)
      if (!to) throw new Error('no crown on this desk yet: give a session the crown on the Agents page')
      const sent = await call({ id: note.id, to: to.id, send: true, ...(f.has('text') ? { text: String(f.get('text')) } : {}) })
      // The store holds it for a moment (sent.held.ms): until then the toast's Undo brings the note back as it was.
      return toast({ head: `Note sent to ${to.name}`, ...(sent.held ? { undo: { action: `${base}/notes/${note.id}/unsend` }, ms: Math.max(1200, sent.held.ms) } : {}) })
    },
    // Undo of a send, while the store still holds the note (the note may be gone from the model: it is held).
    async unsend(note, f, m, id) { await call({ id, unsend: true }) },
  }
  t.post(/^\/notes(?:\/([\w-]+)\/(keep|bin|send|unsend))?$/, async ({ req, res, match, form }) => {
    const id = match[1] ?? null, what = match[2] ?? 'create'
    const m = t.model()
    let says
    try {
      const note = id == null ? null : (m.state.notes ?? []).find(n => n.id === id)
      if (id != null && !note && what !== 'unsend') throw Object.assign(new Error('this note is gone: it was sent or thrown away elsewhere'), { status: 404 })
      says = await WAYS[what](note, form, m, id)
    } catch (err) {
      if (!t.wantsStream(req)) return t.redirect(res, `${base}/`)
      return t.sendStream(req, res, t.toast({ head: what === 'send' ? 'Not sent' : what === 'unsend' ? 'Not undone' : 'Not saved', line: err.message || 'the board did not take it', role: 'alert' }), err.status === 404 ? 404 : 422)
    }
    if (!t.wantsStream(req)) return t.redirect(res, `${base}/`)
    // (the live stream brings the note itself to every page: sidebar.mjs; this answer is the passing line)
    return t.sendStream(req, res, says ? t.stream('prepend', 'says-host', says) : '')
  })
}

// ---- note store ----
// Notes as end-to-end objects (core/README.md, "note"): every human device may write a new version,
// concurrent versions are settled by the core's causal order (R2). Writing one is done here with the core,
// behind a { code, text } answer.
//
// The note's own fields beyond the core's (text) travel through as they are:
//   attachments  README attachment references (uploaded, encrypted, before the version is written)
//   created_at, updated_at
//   held         { to, until } while a sent note waits for the toast's Undo; the device that wrote it delivers it
//                after `until` (sendMessage, then deleteNote), also after a reload (sweep). Every page hides it.

const HOLD_MS = 3000
const attOf = r => { rememberRef(r); return { name: r.file_name ?? 'file', type: r.media_type ?? '', url: r.url ?? `/att/${r.attachment_id}` } }

/** One note as the views know it. */
const boardNote = (id, n) => ({ id, text: n.text ?? '', attachments: (n.attachments ?? []).map(attOf), held: n.held ?? null, created: n.created_at ?? 0, updated: n.updated_at ?? 0 })
// (A new note stands under its local_id until it is sealed: the page that made it gets it by its object_id.)
export const boardNotes = m => [...m.notes.values()].filter(n => n.object_state !== 'closed' && !n.removed && !(n.pending && n.object_id === n.local_id)).map(n => boardNote(n.object_id, n))

/** The notes' actions for one client: made with the facade, so a send held before a reload is delivered when due. */
export function noteStore(client, board) {
  const m = () => client.model
  const dev = agentId => (agentId ? board.agentToDev.get(agentId) ?? (m().sessions.has(agentId) ? agentId : null) : null)
  // The core shows every version at once (optimistic, pending) and chains on the version this client sealed last.
  const current = id => { const n = m().notes.get(id); return n && n.object_state !== 'closed' && !n.removed ? n : null }
  const holds = new Map()   // note id -> timer of a held send
  const went = new Map()    // note id -> agent_device_id, delivered lately (a clear "too late" for Undo)

  /** A new version with these fields changed (the core keeps the others), or a new note. */
  async function save(id, fields) {
    const now = Date.now()
    return client.saveNote(id ? { object_id: id, ...fields, updated_at: now } : { text: '', created_at: now, ...fields, updated_at: now })
  }
  async function remove(id) {
    clearTimeout(holds.get(id)); holds.delete(id)
    if (!current(id)) return
    if (client.deleteNote) await client.deleteNote(id)
    else await client.saveNote({ object_id: id, object_state: 'closed' })   // (the mock room)
  }
  async function deliver(id) {
    holds.delete(id)
    const n = current(id)
    if (!n?.held) return
    const text = String(n.text ?? '').trim()
    // (note: that it was a note, so the conversation shows it taped on: README "message", core/codec.ts noteRefValid.)
    await client.sendMessage({ ...addressOf(m(), n.held.to), text, ...(n.attachments?.length ? { attachments: n.attachments } : {}), note: { object_id: id, written_at: Number.isSafeInteger(n.created_at) && n.created_at >= 0 ? n.created_at : null } })
    went.set(id, n.held.to)
    if (went.size > 200) went.delete(went.keys().next().value)
    await remove(id)
  }
  const hold = (id, until) => { clearTimeout(holds.get(id)); holds.set(id, setTimeout(() => deliver(id).catch(err => console.warn('note', id, err.message)), Math.max(0, until - Date.now()))) }
  // A send held by this device whose page went away meanwhile (a reload): delivered when it is due.
  const sweep = ids => {
    const me = m().room?.my_device_id
    for (const id of ids) {
      const n = m().notes.get(id)
      if (n?.held && n.by_device_id === me && n.object_state !== 'closed' && !holds.has(id)) hold(id, n.held.until)
    }
  }
  client.on('change', ch => { if (ch.notes.size) sweep(ch.notes) })
  sweep(m().notes.keys())

  // { name, data: base64 data URL } -> an uploaded, encrypted attachment reference.
  async function upload({ name, data }, object_id) {
    const [, type = 'application/octet-stream', b64 = ''] = /^data:([^;,]*)(?:;[^,]*)?,(.*)$/s.exec(String(data)) ?? []
    return uploadFile(client, new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], { type }), { file_name: String(name || 'file'), media_type: type, object_id })
  }

  const answer = (code, data) => ({ code, text: JSON.stringify(code < 400 ? { ok: true, ...data } : data) })
  const shown = id => { const n = current(id); return n && boardNote(id, n) }

  return async function act(body) {
    const id = body.id ?? null
    const n = id ? current(id) : null
    if (body.unsend) {
      if (!n) return went.has(id) ? answer(409, { error: 'too late: the note already went', code: 'delivered' }) : answer(404, { error: 'no such note', code: 'no-note' })
      if (!n.held) return answer(409, { error: 'this note was not sent', code: 'not-sent' })
      clearTimeout(holds.get(id)); holds.delete(id)
      await save(id, { held: null })
      return answer(200, { note: shown(id) })
    }
    if (id && !n) return answer(404, { error: 'no such note', code: 'no-note' })
    if (body.remove) { await remove(id); return answer(200, {}) }
    const fields = {}
    if (body.text != null) fields.text = String(body.text)
    if (Array.isArray(body.attachments)) {
      const had = n?.attachments ?? []
      try { fields.attachments = await Promise.all(body.attachments.map(a => (a?.data != null ? upload(a, id) : had.find(r => attOf(r).url === a?.url))).filter(Boolean)) }
      catch (err) { return answer(422, { error: `not attached: ${err.message}` }) }
    }
    if (body.send) {
      const to = (body.to ? dev(String(body.to)) : null) ?? m().human.crown?.session_id ?? m().human.crown?.agent_device_id ?? null
      if (!to || !m().sessions.has(to)) return answer(409, { error: 'this note has no session to go to', code: 'no-session' })
      const text = fields.text ?? n.text ?? '', files = fields.attachments ?? n.attachments ?? []
      if (!text.trim() && !files.length) return answer(400, { error: 'empty message' })
      const until = Date.now() + HOLD_MS
      await save(id, { ...fields, held: { to, until } })
      hold(id, until)
      return answer(200, { held: { agent: board.devToAgent?.get(to) ?? to, ms: HOLD_MS }, sent: { agent: board.devToAgent?.get(to) ?? to } })
    }
    const object_id = await save(id, fields)
    return answer(200, { note: shown(object_id) })
  }
}
