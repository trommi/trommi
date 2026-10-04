
import { Controller, avatar, controller, crownSvg, el, html, mq, raw, sk, toast } from './ui.mjs'
import { addressOf, crownOf, rememberRef, renderStreamMessage, stream, uploadFile } from './app.mjs'

// ---- memo ----
// Memos: the yellow notes the human writes to the crowned session (or to the session whose page it is). The notes are end-to-end memo objects (js/app/memo-store.mjs: every human device
// writes versions, a sent note is held 3 s for Undo); the forms reach it through hub.memo, the route POST /memo of
// the old hub. The markup is the one css/quicksend.css styles.
//
//   memoLayer(model, base, view, scope)   for the layout: the round button with the notes that were put away hanging
//                                  off it, every note that is out. scope: the session whose page
//                                  this is (its notes only, sent to it), or null (the Desk's notes, sent to the crown)
//   register(t)                    the forms (create, open, stack, bin, send) and what the live stream sends
//
// What needs no script: making a note, opening one from the stack, sending it by a crown, throwing it away and
// taking that back. Carrying a note, keeping what is typed, attachments and the tear-off are script
// (controllers memo and memos, client/web/t/lib/memo.js); they save through POST /memo like the old client.
// The look of a note is CSS only: the markup has no placeholder and no drawn tear line.
// A note belongs where it was written: on a session's page to that session (shown there only, sent to it, its
// envelope sealed with the session's drawing); anywhere else to the Desk (sent to the crown, sealed with the crown).
const STICKY = raw('<svg class="memo-sticky" viewBox="0 0 24 24" aria-hidden="true"><path class="sticky-paper" d="M4.3 4.2 Q12 3.5 19.8 3.9 Q20.3 9.4 20 14.7 L14.8 20.2 Q9.3 20.4 4.1 19.9 Q3.8 12 4.3 4.2 Z"/><path class="sticky-fold" d="M20 14.7 Q17.4 14.5 15.3 14.9 Q14.7 17.4 14.8 20.2"/><path class="sticky-line" d="M7.6 8.6 Q12 8.1 16.3 8.4"/><path class="sticky-line" d="M7.7 12.1 Q10.6 11.7 13.4 12"/></svg>')
const isImage = a => /^image\//.test(a?.type ?? '') || /\.(png|jpe?g|gif|webp|svg)$/i.test(a?.name ?? '')
const holds = memo => Boolean(memo.text.trim() || memo.attachments?.length)

/** A note belongs to a session's page (memo.session: shown only there, sent to it) or to the Desk (null: to the crown). */
const scopeOf = memo => memo.session ?? null
const receiverOf = (memo, model) => (memo.session ? model.agents.find(a => a.id === memo.session) ?? null : crownOf(model))
/** The session a page is about, for the live stream: a session's page, else none (the Desk and every other page). */
const scopeOfClient = client => (client.view === 'session' ? client.params.get('session') : null)

function sendButton(memo, model, base) {
  const to = receiverOf(memo, model)
  if (!to) return html`<a class="quick-send memo-send is-none" data-nav href="${base}/agents" title="No crown on this desk yet: give a session the crown" aria-label="No crown on this desk yet: give a session the crown">${raw(crownSvg())}</a>`
  return html`<button class="quick-send memo-send" type="submit" data-action="click->memo#send" name="to" value="${to.id}" data-name="${to.name}" title="Send to ${to.name} (Enter)" aria-label="Send to ${to.name}" aria-keyshortcuts="Enter"${holds(memo) ? '' : raw(' disabled')}${memo.session ? raw(' data-seal="session"') : ''}>${memo.session ? avatar(to, { crown: false }) : raw(crownSvg())}</button>`
}

/** One note that is out (floating over the page). */
function memoNote(memo, model, base) {
  const one = receiverOf(memo, model)
  const x = Math.round(Number(memo.x) || 0), y = Math.round(Number(memo.y) || 0)
  const unplaced = memo.place === 'float' && !x && !y
  // A floating note stays inside the window whatever its size.
  const at = unplaced ? '' : `left:clamp(4px, ${x}px, calc(100vw - 344px));top:clamp(4px, ${y}px, calc(100vh - 120px))`
  const act = what => `${base}/memos/${memo.id}/${what}`
  return html`<div class="memo" id="memo-${memo.id}" data-controller="memo" data-action="pointerdown->memo#front focusin->memo#front paste->memo#paste dragover->memo#over dragleave->memo#out drop->memo#drop turbo:submit-start->memo#settle" data-id="${memo.id}" data-place="${memo.place}" data-x="${x}" data-y="${y}"${unplaced ? raw(' data-unplaced') : ''}${at ? html` style="${at}"` : ''}>
<form class="memo-slip" method="post" action="${act('send')}" role="dialog" aria-label="${one ? `Memo to ${one.name}` : 'Memo'}">
<header class="memo-head" data-action="pointerdown->memo#carry"></header>
<div class="memo-body"><textarea class="memo-field" name="text" rows="3" autocomplete="off" data-action="input->memo#typed keydown->memo#key" aria-label="${one ? `Your memo to ${one.name}` : 'Your memo'}">
${memo.text}</textarea></div>
<div class="memo-files">${(memo.attachments ?? []).map(a => html`<button class="memo-file" type="button" data-action="click->memo#unclip" data-url="${a.url}" title="${a.name}: click to take it off">${sk(isImage(a) ? 'picture' : 'page')}<span>${a.name}</span><i>×</i></button>`)}</div>
<footer class="memo-foot"><button class="memo-tool memo-clip" type="button" data-action="click->memo#pick" title="Attach a picture or a file (or paste it, or drop it on the note)" aria-label="Attach a picture or a file">${sk('clip')}</button><button class="memo-tool memo-bin" type="submit" formaction="${act('bin')}" title="Throw the note away" aria-label="Throw the note away">${sk('bin')}</button><i class="memo-gap" aria-hidden="true"></i><span class="memo-sends">${sendButton(memo, model, base)}</span></footer>
</form></div>`
}

// (A memo that was sent and is held for a moment (memo.held, server.mjs memoAct) is on no page: it is gone until Undo.)
// (scope: the session whose page it is, or null for the Desk's notes: undefined is every note.)
const mine = (m, scope) => scope === undefined || scopeOf(m) === scope
const out = (model, scope) => (model.state.memos ?? []).filter(m => m.place !== 'stack' && !m.held && mine(m, scope))
const away = (model, scope) => (model.state.memos ?? []).filter(m => m.place === 'stack' && !m.held && mine(m, scope)).sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))

/** The round yellow button that makes a note, and what hangs off it: the notes that were put away (their number
 *  on the button, the list on a click). There is no Memos stack on the Desk. Without script the button is a
 *  form that makes a note and comes back. */
function memoOpener(model, base, scope = null) {
  const to = scope ? model.agents.find(a => a.id === scope) ?? null : crownOf(model)
  const put = away(model, scope), n = put.length
  // (on a session's page a new note belongs to it)
  const here = scope ? html`<input type="hidden" name="session" value="${scope}">` : ''
  // (Put-away notes are counted by the Notes stack on the Desk (views/stacks.mjs), not here. On a phone a floating note
  //  waits at the button: that one is counted, css/turbo.css.)
  const phoneN = out(model, scope).filter(m => m.place === 'float').length
  const title = `${to ? `Memo to ${to.name}` : 'Memo: a note to the crowned session'} ( / )${n ? ` · ${n === 1 ? '1 note' : `${n} notes`} put away` : ''}`
  const words = m => m.text.trim().replace(/\s+/g, ' ').slice(0, 120) || (m.attachments?.length ? `${m.attachments.length} attached` : 'Empty note')
  // (A note left floating on a wide screen is listed on a phone too: there it is not out by itself.)
  const line = (m, float) => html`<form method="post" action="${base}/memos/${m.id}/open"${float ? raw(' class="memo-away-float"') : ''}><button class="memo-away-line" type="submit" role="menuitem" data-memo="${m.id}" title="Open the note">${sk('page')}<span>${words(m)}</span></button></form>`
  return html`<div class="memo-new" id="memo-new"><form method="post" action="${base}/memos">${here}<button class="icon-btn quick-open memo-open memo-open-free" id="memo-open" type="submit" data-action="click->memos#open" aria-haspopup="${n ? 'menu' : 'dialog'}" aria-expanded="false" title="${title}" aria-label="${title}">${STICKY}${phoneN ? html`<b class="memo-count memo-count-phone">${phoneN}</b>` : ''}</button></form>
<div class="memo-away" id="memo-away" role="menu" aria-label="Memos that were put away" data-action="turbo:submit-start->memos#shut" hidden><form method="post" action="${base}/memos">${here}<button class="memo-away-line memo-away-new" type="submit" role="menuitem" data-action="click->memos#write">${STICKY}<span>New memo</span></button></form>${put.map(m => line(m, false))}${out(model, scope).filter(m => m.place === 'float').map(m => line(m, true))}</div></div>`
}

/** For the layout, once per page: the button and the notes. */
export const memoLayer = (model, base, view, scope = null) => html`<div id="memo-layer" data-controller="memos">${memoOpener(model, base, scope)}
<div id="memos">${out(model, scope).map(m => memoNote(m, model, base))}</div></div>`


/** The memo's forms and its part of the live stream (docs/turbo.md "Registering a page"). Needs hub.memo(body):
 *  what POST /memo does, as { code, text } (server.mjs memoAct). */
export function register(t) {
  const base = t.BASE
  const call = async body => {
    const res = await t.hub.memo(body)
    let data = {}
    try { data = JSON.parse(res.text) } catch {}
    if (res.code >= 400) throw Object.assign(new Error(data.error || 'the board did not take it'), { status: res.code, code: data.code })
    return data
  }
  const num = v => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined)
  const WAYS = {
    async create(_, f) {
      const place = ['float', 'stack'].includes(f.get('place')) ? f.get('place') : 'float'
      const made = await call({ text: String(f.get('text') ?? ''), place, x: num(f.get('x')) ?? 0, y: num(f.get('y')) ?? 0, ...(f.get('session') ? { session: String(f.get('session')) } : {}) })
      return { fresh: made.memo.id, memo: made.memo }
    },
    async open(memo) { const made = await call({ id: memo.id, place: 'float' }); return { fresh: memo.id, memo: made.memo } },
    async stack(memo, f) {
      // Put away, a note hangs off the memo button (place "stack"), with the words as they stand; an empty one is simply gone.
      const text = f.has('text') ? String(f.get('text')) : memo.text
      await call(holds({ ...memo, text }) ? { id: memo.id, place: 'stack', text } : { id: memo.id, remove: true })
      return {}
    },
    async bin(memo, f) {
      const gone = { text: f.has('text') ? String(f.get('text')) : memo.text, place: memo.place, x: memo.x, y: memo.y, session: memo.session ?? '', files: memo.attachments?.length ?? 0 }
      await call({ id: memo.id, remove: true })
      if (!gone.text.trim() && !gone.files) return {}
      return { says: toast({ head: 'Note thrown away', line: gone.text.trim().replace(/\s+/g, ' ').slice(0, 80) || `${gone.files} attached`, undo: { action: `${base}/memos`, fields: { text: gone.text, place: gone.place, x: gone.x, y: gone.y, ...(gone.session ? { session: gone.session } : {}) } } }) }
    },
    async send(memo, f, m) {
      // (From the Notes stack the line names the session it goes to: to=<session>; else its own session or the crown.)
      const picked = f.get('to') ? m.agents.find(a => a.id === String(f.get('to'))) ?? null : null
      const to = picked ?? receiverOf(memo, m)
      if (!to) throw new Error('no crown on this desk yet: give a session the crown on the Agents page')
      // The note goes as it stands in the form: to its session (a note of a session's page), else to the crown.
      const sent = await call({ id: memo.id, to: to.id, send: true, ...(f.has('text') ? { text: String(f.get('text')) } : {}) })
      // The hub holds it for a moment (sent.held.ms): until then the toast's Undo brings the note back as it was.
      return { says: toast({ head: `Memo sent to ${to.name}`, ...(sent.held ? { undo: { action: `${base}/memos/${memo.id}/unsend` }, ms: Math.max(1200, sent.held.ms) } : {}) }) }
    },
    // Undo of a send, while the hub still holds the memo: the note is out again (memo may be null: it went already).
    async unsend(memo, f, m, id) { const made = await call({ id, unsend: true }); return { fresh: id, back: true, memo: made.memo } },
  }
  t.post(/^\/memos(?:\/([\w-]+)\/(open|stack|bin|send|unsend))?$/, async ({ req, res, match, form }) => {
    const id = match[1] ?? null, what = match[2] ?? 'create'
    // Back to the page the form stood on (a path of this board), else the Desk.
    let back = `${base}/`
    try { const u = new URL(String(form.get('back') ?? req.headers.referer ?? ''), 'http://x'); if (u.pathname === base || u.pathname.startsWith(`${base}/`)) back = u.pathname + u.search } catch {}
    const m = t.model()
    let done
    try {
      const memo = id == null ? null : (m.state.memos ?? []).find(n => n.id === id)
      if (id != null && !memo && what !== 'unsend') throw Object.assign(new Error('this note is gone: it was sent or thrown away elsewhere'), { status: 404 })
      done = await WAYS[what](memo, form, m, id)
    } catch (err) {
      if (!t.wantsStream(req)) return t.redirect(res, back)
      return t.sendStream(req, res, t.toast({ head: what === 'send' ? 'Not sent' : what === 'unsend' ? 'Not undone' : 'Not saved', line: err.message || 'the board did not take it', role: 'alert' }), err.status === 404 ? 404 : 422)
    }
    if (!t.wantsStream(req)) return t.redirect(res, back)
    // The live stream brings the change to every page; this answer adds what belongs to the one who acted: the
    // note at once (data-fresh: the island puts the keyboard into it), the note gone, the passing line.
    const now = t.model()
    // (the note as the model has it, else as it was just written: the hub's copy of a new version comes a moment later)
    const note = done.fresh && ((now.state.memos ?? []).find(n => n.id === done.fresh && !n.held) ?? done.memo)
    return t.sendStream(req, res, [
      note && note.place !== 'stack' ? t.stream('append', 'memos', raw(String(memoNote(note, now, base)).replace('<div class="memo"', `<div class="memo" data-fresh${done.back ? ' data-back' : ''}`))) : '',
      ['stack', 'bin', 'send'].includes(what) ? t.stream('remove', `memo-${id}`) : '',
      done.says ? t.stream('prepend', 'says-host', done.says) : '',
    ].join(''))
  })

  // Every page with a stream: the notes that came, changed and went; the button.
  t.live('*', {
    // Every note with its scope; the button once per scope that a page shows (the Desk's, a session's).
    take: (m, clients = []) => ({
      notes: new Map(out(m).map(n => [n.id, { scope: scopeOf(n), text: String(memoNote(n, m, base)) }])),
      opener: new Map([...new Set([null, ...clients.map(scopeOfClient)])].map(sc => [sc, String(memoOpener(m, base, sc))])),
    }),
    diff(was, now, client) {
      const acts = [], sc = scopeOfClient(client)
      const here = snap => new Map([...snap.notes].filter(([, n]) => n.scope === sc).map(([id, n]) => [id, n.text]))
      const a = here(was), b = here(now)
      for (const id of a.keys()) if (!b.has(id)) acts.push(t.stream('remove', `memo-${id}`))
      for (const [id, text] of b) {
        if (!a.has(id)) acts.push(t.stream('append', 'memos', raw(text)))
        else if (a.get(id) !== text) acts.push(t.stream('replace', `memo-${id}`, raw(text)))
      }
      const o = now.opener.get(sc)
      if (o != null && was.opener.get(sc) !== o) acts.push(t.stream('replace', 'memo-new', raw(o)))
      return acts.join('')
    },
  })
}

// ---- memo store ----
// Memos as end-to-end objects (trommi-hub client/core README, "memo"): every human device may write a new version,
// concurrent versions are settled by the core's causal order (R2). What the old hub's POST /memo did (server.mjs
// memoAct) is done here with the core, behind the same { code, text } answer, so views/memo.mjs and t/lib/memo.js
// stay as they were.
//
// The memo's own fields beyond the core's (text, x, y, color, desk_id) travel through as they are:
//   place        'float' (over the page) | 'stack' (put away: the Desk's NOTES stack). A note that lay on the Desk's
//                paper ('paper', before the Desk lost its paper to the Whiteboard on 4 Oct 2026) is read as 'stack':
//                it waits on the NOTES stack with its words, nothing is rewritten.
//   session      agent_device_id of the session whose page it was written on (shown only there, sent to it), or null
//   to           agent_device_id it is addressed to (else the crown of the desk)
//   attachments  README attachment references (uploaded, encrypted, before the version is written)
//   created_at, updated_at
//   held         { to, until } while a sent memo waits for the toast's Undo; the device that wrote it delivers it
//                after `until` (sendMessage, then deleteMemo), also after a reload (sweep). Every page hides it.
//
//   boardMemos(model, devToAgent)    the board state's memos (views/model.mjs shape), from the core's model
//   memoStore(client, board)         -> act(body): POST /memo of the old hub, as { code, text }

const HOLD_MS = 3000
const PLACES = ['float', 'stack']
const attOf = r => { rememberRef(r); return { name: r.file_name ?? 'file', type: r.media_type ?? '', url: r.url ?? `/att/${r.attachment_id}` } }

/** One memo as the views know it (agent ids for sessions; memos of older app versions named agent ids already). */
function boardMemo(id, n, devToAgent) {
  const agent = d => (d ? devToAgent.get(d) ?? d : null)
  return { id, text: n.text ?? '', to: agent(n.to), session: agent(n.session), place: n.place === 'paper' ? 'stack' : PLACES.includes(n.place) ? n.place : 'float', x: n.x ?? 0, y: n.y ?? 0, desk: n.desk_id ?? null,
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
    // (memo: that it was a note, so the conversation shows it taped on: README "message", core/codec.mjs memoRefValid.)
    await client.sendMessage({ ...addressOf(m(), n.held.to), text, ...(n.attachments?.length ? { attachments: n.attachments } : {}), memo: { object_id: id, written_at: Number.isSafeInteger(n.created_at) && n.created_at >= 0 ? n.created_at : null } })
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
    return uploadFile(client, new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], { type }), { file_name: String(name || 'file'), media_type: type, object_id })
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
      const to = fields.to ?? fields.session ?? n.session ?? n.to ?? m().human.crown?.session_id ?? m().human.crown?.agent_device_id ?? null
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

// ---- memo ----
// Memos, the script side (docs/turbo.md "Controllers"): what the two controllers share. The hub renders every note
// that is out and keeps them (state.memos); a note can be made, opened, sent and thrown away without any script
// (they are forms). Here is what needs one:
//   - a sent note tears off and flies away; Escape puts a note away (an empty one is gone): it then hangs off the
//     round button, which shows how many wait there and lists them on a click;
//   - what is typed is kept a moment later (POST /memo, as the old client did), on leaving the page at once;
//   - a note is carried by its top strip, anywhere over the page (the Desk has no paper under it any more: the
//     drawing is the Whiteboard's, js/views/whiteboard.mjs);
//   - pictures and files: the paperclip, a paste, a drop on the note;
//   - a phone: a note is a sheet at the bottom, one at a time, only the one he opened on this page;
//   - a stream that brings a note which is already here changes it in place: the field with the keyboard in it,
//     a note in the hand and a note that is flying away are left alone.
// controllers/memo_controller.js is one note; controllers/memos_controller.js is the round button, its list and
// what concerns all notes of the page.
const STREAM = 'text/vnd.turbo-stream.html'
const W = 340   // a note's width on a wide screen (css/quicksend.css)
const sheet = mq('(max-width: 860px)')
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const base = () => document.body.dataset.tBase ?? ''
const host = () => document.getElementById('memos')
const fieldOf = note => note.querySelector('.memo-field')
const noteHolds = note => Boolean(fieldOf(note).value.trim() || note.querySelector('.memo-file'))
const notes = () => [...document.querySelectorAll('.memo[data-id]')]
const opener = () => document.getElementById('memo-open')

let sheetId = null   // a phone: the note that is open as the sheet (only one he opened on this page)
const sheetNote = () => (sheetId ? document.getElementById(`memo-${sheetId}`) : null)

// ---- the passing line ----
function say(head, line) {
  const at = document.getElementById('says-host')
  if (!at) return
  // (a toast without Undo, server/views/toast.mjs: the controller "says" times it and keeps the stack)
  const node = Object.assign(document.createElement('div'), { className: 'says' })
  node.setAttribute('role', 'alert')
  node.dataset.controller = 'says'
  node.dataset.action = 'pointerenter->says#pause pointerleave->says#run'
  const words = Object.assign(document.createElement('span'), { className: 'says-words' })
  words.append(Object.assign(document.createElement('b'), { textContent: head }), Object.assign(document.createElement('span'), { textContent: line }))
  node.append(words)
  at.prepend(node)
}
const streams = text => renderStreamMessage(text)

// ---- keeping: POST /memo, the route the old client keeps its notes with ----
const pending = new Map()   // note id -> { fields, timer }
async function post(body, keepalive = false) {
  const res = await fetch('/memo', { method: 'POST', keepalive, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let out = {}
  try { out = await res.json() } catch {}
  if (!res.ok) throw Object.assign(new Error(out.error || res.statusText), { status: res.status, code: out.code })
  return out
}
/** Keep a change of a note: typing a moment later, everything else at once. */
function keep(id, fields, wait = 0) {
  const p = pending.get(id) ?? { fields: {}, timer: 0 }
  Object.assign(p.fields, fields)
  pending.set(id, p)
  clearTimeout(p.timer)
  if (wait) p.timer = setTimeout(() => flush(id), wait)
  else return flush(id)
}
function flush(id, leaving = false) {
  const p = pending.get(id)
  if (!p) return Promise.resolve()
  clearTimeout(p.timer)
  pending.delete(id)
  return post({ id, ...p.fields }, leaving).catch(err => {
    // Sent or thrown away elsewhere: the stream takes the note off this page too. Anything else is said.
    if (err.code !== 'no-memo' && !leaving) say('Not saved', err.message)
  })
}
/** Leaving the page: what was typed last is kept at once. */
const flushAll = (leaving = true) => Promise.all([...pending.keys()].map(id => flush(id, leaving)))
/** A form of a note goes (the bin): what is typed goes along with it, and nothing waits behind it. */
function settle(note) { clearTimeout(pending.get(note.dataset.id)?.timer); pending.delete(note.dataset.id) }

// ---- how a note looks and where it stands ----
function fit(note) {
  const field = fieldOf(note)
  field.style.height = 'auto'
  field.style.height = `${Math.min(Math.max(field.scrollHeight, 84), Math.round(window.innerHeight * .4 / 28) * 28)}px`
  const button = note.querySelector('button.memo-send')
  if (button) button.disabled = !noteHolds(note)
}
/** Put the note where its place says: over the page. */
function stand(note) {
  if (note.classList.contains('is-carried') || note.dataset.state === 'sending') return
  const home = host()
  if (home && note.parentNode !== home) {
    const had = note.contains(document.activeElement) ? document.activeElement : null
    home.append(note)
    had?.focus?.({ preventScroll: true })
  }
  const x = Number(note.dataset.x) || 0, y = Number(note.dataset.y) || 0
  if (note.dataset.place === 'float' && !note.hasAttribute('data-unplaced')) { note.style.left = `clamp(4px, ${x}px, calc(100vw - ${W + 4}px))`; note.style.top = `clamp(4px, ${y}px, calc(100vh - 120px))` }
  else { note.style.left = note.style.top = '' }
  note.toggleAttribute('data-sheet', note.dataset.id === sheetId)
}
function paintOpener() {
  document.body.toggleAttribute('data-memo-open', sheet.matches && notes().some(n => n.hasAttribute('data-sheet')))
}
function standAll() {
  for (const note of notes()) { stand(note); fit(note) }
  paintOpener()
}
/** The note that was touched last lies on top of the others. */
function front(note) { for (const other of notes()) other.style.zIndex = other === note ? '2601' : '' }
/** Where a note appears that has no place of its own yet: above the button at the lower right; each further one a
 *  step up and to the left. On a card's page it must not lie on what one answers with. */
function spot() {
  const n = notes().filter(m => m.dataset.place === 'float' && !m.hasAttribute('data-unplaced')).length
  const at = { x: window.innerWidth - W - 16 - (n % 6) * 22, y: Math.max(64, window.innerHeight - 330 - (n % 6) * 22) }
  if (!document.body.hasAttribute('data-focus-page')) return at
  const H = 210, vw = window.innerWidth, vh = window.innerHeight
  const taken = [...document.querySelectorAll('.focus-opt, .focus-way, .focus-ask-field, .memo')].map(node => node.getBoundingClientRect()).filter(r => r.width && r.height && r.right > 0 && r.left < vw && r.bottom > 0 && r.top < vh)
  const free = (x, y) => !taken.some(r => r.left < x + W + 8 && r.right > x - 8 && r.top < y + H + 8 && r.bottom > y - 8)
  for (let y = Math.min(at.y, vh - H - 16); y >= 56; y -= 24) for (let x = vw - W - 16; x >= 8; x -= 24) if (free(x, y)) return { x, y }
  return at
}
/** A note that just came because he asked for it: it gets a place and the keyboard. */
function welcome(note) {
  note.removeAttribute('data-fresh')
  note.dataset.state = 'open'
  sheetId = note.dataset.id
  if (note.hasAttribute('data-unplaced') && !sheet.matches) {
    const at = spot()
    Object.assign(note.dataset, { x: at.x, y: at.y })
    note.removeAttribute('data-unplaced')
    keep(note.dataset.id, at)
  }
  standAll()
  fieldOf(note).focus({ preventScroll: true })
  // Turbo gives the keyboard back to what held it before a stream (a marked row of the Desk) one frame after it
  // rendered; the note takes it again then, unless he went into another field meanwhile.
  const take = () => {
    const at = document.activeElement
    if (!note.isConnected || note.dataset.state !== 'open' || note.contains(at) || at?.matches?.('input, textarea, select, [contenteditable]')) return
    fieldOf(note).focus({ preventScroll: true })
  }
  requestAnimationFrame(() => requestAnimationFrame(take))
}

// ---- a stream brings a note that is already on this page: it is changed in place ----
function patch(old, fresh) {
  if (old.classList.contains('is-carried') || old.dataset.state === 'sending') return
  const typing = pending.has(old.dataset.id)
  if (!typing) for (const k of ['place', 'x', 'y']) old.dataset[k] = fresh.dataset[k]
  if (!typing) old.toggleAttribute('data-unplaced', fresh.hasAttribute('data-unplaced'))
  const field = fieldOf(old), text = fieldOf(fresh).value
  if (document.activeElement !== field && !typing && field.value !== text) field.value = text
  for (const part of ['.memo-files', '.memo-sends']) old.querySelector(part).replaceChildren(...fresh.querySelector(part).childNodes)
  const form = old.querySelector('.memo-slip'), now = fresh.querySelector('.memo-slip')
  form.setAttribute('aria-label', now.getAttribute('aria-label'))
  field.setAttribute('aria-label', fieldOf(fresh).getAttribute('aria-label'))
  if (fresh.hasAttribute('data-fresh')) welcome(old)
  else { stand(old); fit(old) }
}
/** turbo:before-stream-render, for the streams of the memos: a note that is here already is changed in place, a
 *  new one is stood up, the list at the button stays open. */
function onStream(e) {
  const el = e.target
  const next = e.detail.render
  if (el.target === 'memo-new') {
    const was = document.getElementById('memo-away')
    if (was && !was.hidden) e.detail.render = async stream => { await next(stream); if (document.querySelectorAll('#memo-away form').length > 1) showAway(true) }
    return
  }
  if (el.target !== 'memos' && !/^memo-/.test(el.target ?? '')) return
  e.detail.render = async stream => {
    const fresh = stream.templateContent?.querySelector?.('.memo')
    const old = fresh ? document.getElementById(fresh.id) : stream.action === 'remove' ? document.getElementById(stream.target) : null
    if (stream.action === 'remove') {
      // A note that flies away is taken off by its flight.
      if (old?.dataset.state === 'sending') return
      pending.delete(old?.dataset.id)
      return next(stream)
    }
    // Undo of a send (data-back) while the letter still flies: the flight stops, the note is as it was.
    if (old && fresh?.hasAttribute('data-back') && old.dataset.state === 'sending') {
      old.querySelector('.memo-env')?.remove()
      old.querySelector('.memo-slip')?.removeAttribute('aria-busy')
      old.dataset.state = 'open'
    }
    if (old && fresh) return patch(old, fresh)
    await next(stream)
    const came = fresh && document.getElementById(fresh.id)
    if (came?.hasAttribute('data-fresh')) welcome(came)
    else standAll()
  }
}

// ---- making, sending, putting away ----
async function act(url, fields = {}) {
  const res = await fetch(url, { method: 'POST', headers: { Accept: STREAM, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) })
  const text = await res.text()
  return { ok: res.ok, text }
}
/** Make a note (or go to the empty one that floats already) and put the keyboard into it. */
async function write() {
  const empty = notes().find(n => n.dataset.place === 'float' && !noteHolds(n) && (!sheet.matches || n.dataset.id === sheetId))
  if (empty) { fieldOf(empty).focus({ preventScroll: true }); return }
  const at = sheet.matches ? { x: 0, y: 0 } : spot()
  // (The button, or the row of the Desk the keyboard is on, lets go of the keyboard first: Turbo gives it back to
  // what held it when a stream came, and a stream that replaces the button would otherwise give it the keyboard back.)
  if (document.activeElement !== document.body) document.activeElement?.blur?.()
  // On a session's page the note belongs to that session (shown there only, sent to it): views/memo.mjs.
  const session = document.body.dataset.tView === 'session' ? document.body.dataset.scope ?? '' : ''
  const out = await act(`${base()}/memos`, { place: 'float', x: at.x, y: at.y, ...(session && session !== 'all' ? { session } : {}) }).catch(err => ({ ok: false, text: '', err }))
  if (out.text) streams(out.text)
  else if (!out.ok) say('Not saved', out.err?.message ?? 'the board did not take it')
}
/** The envelope of a sent note (css/quicksend.css .memo-env), laid where the send button is: it opens, the note
 *  slips into it, it closes with the crown as its seal, and flies to `to` (aim()). The slip moves by --env-x/--env-y
 *  (from its middle to the envelope's) and --env-s (how small it gets). Only for the look: it takes no clicks. */
function envelope(note, to) {
  const slip = note.querySelector('.memo-slip'), button = note.querySelector('.memo-send')
  const at = note.getBoundingClientRect(), r = slip.getBoundingClientRect(), b = (button ?? slip).getBoundingClientRect()
  const W = 70, H = 50, cx = b.left + b.width / 2, cy = b.top + b.height / 2
  const env = document.createElement('div')
  env.className = 'memo-env'
  env.setAttribute('aria-hidden', 'true')
  env.style.cssText = `left:${cx - at.left - W / 2}px;top:${cy - at.top - H / 2}px;width:${W}px;height:${H}px;--fly-x:${to.x + (r.left + r.width / 2 - cx)}px;--fly-y:${to.y + (r.top + r.height / 2 - cy)}px`
  const back = document.createElement('i'), flap = document.createElement('i'), seal = document.createElement('i')
  back.className = 'memo-env-body'; flap.className = 'memo-env-flap'; seal.className = 'memo-env-seal'
  const crown = button?.querySelector('.crown-mark, .agent-avatar')   // the crown, or on a session's note its drawing
  if (crown) seal.append(crown.cloneNode(true))
  env.append(back, flap, seal)
  slip.style.setProperty('--env-x', `${Math.round(cx - (r.left + r.width / 2))}px`)
  slip.style.setProperty('--env-y', `${Math.round(cy - (r.top + r.height / 2) + 4)}px`)
  slip.style.setProperty('--env-s', (W * .7 / r.width).toFixed(3))
  note.append(env)
  return env
}
/** Where the letter flies: on the session's own page into its drawing in the heading; else to the drawing of the
 *  receiving session in the sidebar (on a phone the strip at the top), or, when that is not in view, up and out: how far from the note's middle, and the drawing it lands on. */
function aim(note, to) {
  const inView = n => { const r = n?.getBoundingClientRect(); return r && r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth ? r : null }
  let row = to ? document.getElementById(`agent-${to}`) : null
  if (row && !inView(row) && row.dataset.parent) row = document.getElementById(`agent-${row.dataset.parent}`)
  // On the session's own page: into its drawing in the page's heading (top left), where the conversation is.
  const head = to && document.body.dataset.tView === 'session' ? document.querySelector(`#session-who-${CSS.escape(to)} .agent-avatar, #session-who-${CSS.escape(to)}`) : null
  const mark = inView(head) ? head : row?.querySelector('.agent-avatar') ?? row
  const at = inView(mark), from = note.querySelector('.memo-slip').getBoundingClientRect()
  const x = at ? at.left + at.width / 2 - (from.left + from.width / 2) : 40, y = at ? at.top + at.height / 2 - (from.top + from.height / 2) : -innerHeight * .45
  return { x: Math.round(x), y: Math.round(y), mark: at ? mark : null }
}
/** The letter arrives: the receiver's drawing gives a small bump. */
function land(mark) {
  mark.classList.remove('is-memo-landed')
  void mark.offsetWidth
  mark.classList.add('is-memo-landed')
  setTimeout(() => mark.classList.remove('is-memo-landed'), 600)
}
/** Tear the note off and send it to the crown. */
async function send(note) {
  const form = note.querySelector('.memo-slip'), button = note.querySelector('.memo-send')
  if (form.hasAttribute('aria-busy')) return
  if (button?.matches('a')) return button.click()   // no crown on this desk: to the Agents page, where it is given
  if (!noteHolds(note)) return fieldOf(note).focus()
  form.setAttribute('aria-busy', 'true')
  const id = note.dataset.id
  settle(note)   // the form carries the words as they stand
  const out = await act(form.action, { text: fieldOf(note).value, ...(button ? { to: button.value } : {}) }).catch(err => ({ ok: false, text: '', err }))
  if (!out.ok) {
    form.removeAttribute('aria-busy')
    if (out.text) streams(out.text); else say('Not sent', out.err?.message ?? 'no connection')
    return
  }
  // It went: the envelope opens and takes the note, closes with the crown, and swooshes to the crowned session in the sidebar;
  // then the line says to whom.
  note.dataset.state = 'sending'
  // The toast with its Undo comes at once (the hub holds the memo only a few seconds); the rest once the letter has flown.
  const toastPart = /<turbo-stream action="prepend" target="says-host">[\s\S]*?<\/turbo-stream>/.exec(out.text)?.[0] ?? ''
  if (toastPart) streams(toastPart)
  if (!calm()) await new Promise(done => {
    const to = aim(note, button?.value), layer = envelope(note, to), mark = to.mark
    const end = () => { clearTimeout(timer); if (mark) land(mark); done() }
    const timer = setTimeout(end, 1800)
    layer.addEventListener('animationend', ev => { if (ev.target === layer) end() })
  })
  if (note.dataset.state !== 'sending') return   // Undo was pressed while it flew: the note stays (onStream)
  note.remove()
  if (sheetId === id) sheetId = null
  paintOpener()
  streams(out.text.replace(toastPart, ''))
  opener()?.focus({ preventScroll: true })
}
/** Put the note away: it hangs off the round button; an empty one is gone. */
async function putAway(note) {
  if (note.dataset.state === 'sending') return
  const id = note.dataset.id, had = note.contains(document.activeElement)
  settle(note)
  const kept = noteHolds(note)
  if (sheetId === id) sheetId = null
  note.remove()
  paintOpener()
  if (had) opener()?.focus({ preventScroll: true })
  const out = await act(`${base()}/memos/${id}/stack`, { text: fieldOf(note).value }).catch(() => null)
  if (!out?.ok) return say('Not saved', 'The note could not be put away.')
  if (kept) say('Memo put away', 'It waits at the yellow memo button.')
}
/** The words changed. */
function typed(note) { fit(note); keep(note.dataset.id, { text: fieldOf(note).value }, 350) }

// ---- the notes that were put away: the list at the round button ----
function showAway(on) {
  const list = document.getElementById('memo-away')
  if (!list) return
  list.hidden = !on
  opener()?.setAttribute('aria-expanded', String(on))
  if (on) list.querySelector('.memo-away-line')?.focus({ preventScroll: true })
}
/** The lines of the notes that wait at the button, as this screen shows them. */
const waits = () => [...document.querySelectorAll('#memo-away form:not(:first-child)')].filter(f => !f.classList.contains('memo-away-float') || (sheet.matches && f.querySelector('[data-memo]')?.dataset.memo !== sheetId))

// ---- pictures and files ----
const read = file => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve({ name: file.name || `pasted-${Date.now()}.png`, data: reader.result })
  reader.onerror = () => reject(reader.error)
  reader.readAsDataURL(file)
})
async function attach(note, list) {
  const got = [...list].filter(f => f instanceof File)
  if (!got.length) return
  try {
    const fresh = await Promise.all(got.map(read))
    const have = [...note.querySelectorAll('.memo-file')].map(c => ({ url: c.dataset.url }))
    await post({ id: note.dataset.id, attachments: [...have, ...fresh] })   // (the stream brings the chips)
  } catch (err) { say('Not attached', err?.message ?? 'the file could not be read') }
}
/** The file chooser of a note. */
function picker(note) {
  let input = note.querySelector('input[type=file]')
  if (!input) {
    input = Object.assign(document.createElement('input'), { type: 'file', multiple: true, hidden: true, tabIndex: -1 })
    input.addEventListener('change', async () => { await attach(note, input.files); input.value = ''; fieldOf(note).focus() })
    note.append(input)
  }
  return input
}
/** A file chip was clicked: it comes off the note. */
function unclip(note, chip) {
  const left = [...note.querySelectorAll('.memo-file')].filter(c => c !== chip).map(c => ({ url: c.dataset.url }))
  chip.remove()
  fit(note)
  keep(note.dataset.id, { attachments: left })
}

// ---- carried by its head: anywhere over the page ----
function carry(e, note, head) {
  if (e.button) return
  const id = note.dataset.id
  const done = (move, up) => { for (const type of ['pointermove', 'pointerup', 'pointercancel']) head.removeEventListener(type, type === 'pointermove' ? move : up) }
  const listen = (move, up) => { try { head.setPointerCapture(e.pointerId) } catch {} head.addEventListener('pointermove', move); head.addEventListener('pointerup', up); head.addEventListener('pointercancel', up) }
  if (sheet.matches) return   // a phone: the sheet is not carried
  const r = note.getBoundingClientRect()
  const dx = e.clientX - r.left, dy = e.clientY - r.top
  let moved = false
  const at = ev => [Math.min(Math.max(ev.clientX - dx, 4), window.innerWidth - r.width - 4), Math.min(Math.max(ev.clientY - dy, 4), window.innerHeight - 40)]
  const move = ev => {
    if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return
    if (!moved) {
      moved = true
      // Lifted: it floats over everything while it is carried.
      note.classList.add('is-carried')
      note.removeAttribute('data-unplaced')
      if (note.parentNode !== host()) { host().append(note); try { head.setPointerCapture(e.pointerId) } catch {} }
    }
    const [x, y] = at(ev)
    note.style.left = `${x}px`
    note.style.top = `${y}px`
  }
  const up = ev => {
    done(move, up)
    note.classList.remove('is-carried')
    if (!moved) return
    const [x, y] = at(ev)
    const to = { place: 'float', x: Math.round(x), y: Math.round(y) }
    Object.assign(note.dataset, to)
    stand(note)
    keep(id, to)
  }
  listen(move, up)
}
/** A phone: a tap beside the sheet puts the note away (nothing lies over the page meanwhile). */
function beside(e) {
  if (!sheet.matches || !sheetId || !(e.target instanceof Element) || e.target.closest('.memo, #memo-new, .says')) return
  const note = sheetNote()
  if (!note) return
  putAway(note)
  // That tap only put the note away: it does not also press what lay beside the sheet.
  const swallow = ev => { ev.stopPropagation(); ev.preventDefault() }
  window.addEventListener('click', swallow, { capture: true, once: true })
  setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 600)
}

// ---- controller "memo" ----
// One yellow note: <div class="memo" data-controller="memo"> (server/views/memo.mjs memoNote()). It is a form that
// works by itself; this adds Enter, keeping what is typed, carrying it by its strip, pictures and files,
// and the tear-off. The work is /t/lib/memo.js, shared with the round button (memos_controller.js).

controller('memo', class extends Controller {
  connect() {
    stand(this.element); fit(this.element)
    // More than five attachments lie folded as one chip (css/quicksend.css): a click on it opens or shuts the list.
    this.element.addEventListener('click', e => {
      const files = e.target.closest?.('.memo-files')
      if (files && e.target === files && files.querySelector('.memo-file:nth-child(6)')) files.toggleAttribute('data-open')
    })
  }

  typed() { typed(this.element) }
  key(e) {
    // Enter tears it off and sends it, Shift+Enter makes a new line. (Escape puts the note away: memos_controller.js.)
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); e.stopPropagation(); send(this.element) }
  }
  send(e) { e.preventDefault(); send(this.element) }
  front() { front(this.element) }
  carry(e) { if (!e.target.closest('button, a')) carry(e, this.element, e.currentTarget) }
  pick(e) { e.preventDefault(); picker(this.element).click() }
  unclip(e) { e.preventDefault(); unclip(this.element, e.currentTarget) }
  settle() { settle(this.element) }
  paste(e) { if (e.clipboardData?.files?.length) { e.preventDefault(); attach(this.element, e.clipboardData.files) } }
  over(e) { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); this.slip.classList.add('is-drop') } }
  out() { this.slip.classList.remove('is-drop') }
  drop(e) { this.out(); if (e.dataTransfer?.files?.length) { e.preventDefault(); attach(this.element, e.dataTransfer.files) } }
  get slip() { return this.element.querySelector('.memo-slip') }
})

// ---- controller "memos" ----
// The memos of a page: <div id="memo-layer" data-controller="memos"> around the round yellow button, the list of
// the notes that were put away, and the notes that are out (server/views/memo.mjs memoLayer()). The button makes a
// note, or shows the list when notes wait there. What concerns all notes of the page is here too: streams that
// change a note in place, a phone's tap beside the sheet, keeping what was
// typed when the page is left. The work is /t/lib/memo.js. The key "/" may click #memo-open.

controller('memos', class extends Controller {
  connect() {
    const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); this.undo.push(() => target.removeEventListener(type, fn, opts)) }
    this.undo = []
    on(document, 'turbo:before-stream-render', onStream)
    on(document, 'turbo:before-visit', () => flushAll())
    on(document, 'turbo:before-cache', () => flushAll())
    on(window, 'pagehide', () => flushAll())
    on(window, 'resize', standAll)
    on(document, 'trommi:memo', () => write())   // the key that writes a new note (ui.mjs keys)
    on(sheet, 'change', standAll)
    on(document, 'pointerdown', e => { beside(e); if (this.listOpen && !(e.target instanceof Element && e.target.closest('#memo-new'))) showAway(false) })
    // Escape closes the list, or puts the note away the keyboard is in (heard at the window, before any table of keys).
    on(window, 'keydown', e => {
      if (e.key !== 'Escape') return
      const note = e.target instanceof Element ? e.target.closest('.memo') : null
      if (!this.listOpen && !note) return
      e.preventDefault(); e.stopPropagation()
      if (this.listOpen) { showAway(false); document.getElementById('memo-open')?.focus({ preventScroll: true }) }
      else putAway(note)   // Escape in a note puts it away; what was written stays on it
    }, true)
    standAll()
  }
  disconnect() { for (const undo of this.undo) undo() }

  get listOpen() { const list = document.getElementById('memo-away'); return Boolean(list && !list.hidden) }
  /** The round button: with notes put away it shows them (and "New memo"); with none it makes a note at once. */
  open(e) {
    e.preventDefault()
    if (!waits().length) return write()
    showAway(!this.listOpen)
  }
  write(e) { e.preventDefault(); showAway(false); write() }
  shut() { showAway(false) }
})
