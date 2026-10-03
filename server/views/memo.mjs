// Memos on the server-rendered board: the yellow notes the human writes to the crowned session, and the mount
// point of the Desk's paper. The notes are the hub's (state.memos, the same store POST /memo keeps for the old
// client); the markup is the one css/quicksend.css styles (the old client built it in js/quicksend.js).
//
//   memoLayer(model, base, view, scope)   for the layout: the round button with the notes that were put away hanging
//                                  off it, every note that is out, the paper's element. scope: the session whose page
//                                  this is (its notes only, sent to it), or null (the Desk's notes, sent to the crown)
//   register(t)                    the forms (create, open, stack, bin, send) and what the live stream sends
//
// What needs no script: making a note, opening one from the stack, sending it by a crown, throwing it away and
// taking that back. Carrying a note, keeping what is typed, attachments and the tear-off are script
// (controllers memo and memos, client/web/t/lib/memo.js); they save through POST /memo like the old client.
// The look of a note is CSS only: the markup has no placeholder and no drawn tear line.
// A note belongs where it was written: on a session's page to that session (shown there only, sent to it, its
// envelope sealed with the session's drawing); anywhere else to the Desk (sent to the crown, sealed with the crown).
import { html, raw } from './html.mjs'
import { avatar, markArt } from './sidebar.mjs'
import { sketchSvg, crownSvg } from '../../client/web/js/pen.js'
import { toast } from './toast.mjs'

const sk = name => raw(sketchSvg(name))
const STICKY = raw('<svg class="memo-sticky" viewBox="0 0 24 24" aria-hidden="true"><path class="sticky-paper" d="M4.3 4.2 Q12 3.5 19.8 3.9 Q20.3 9.4 20 14.7 L14.8 20.2 Q9.3 20.4 4.1 19.9 Q3.8 12 4.3 4.2 Z"/><path class="sticky-fold" d="M20 14.7 Q17.4 14.5 15.3 14.9 Q14.7 17.4 14.8 20.2"/><path class="sticky-line" d="M7.6 8.6 Q12 8.1 16.3 8.4"/><path class="sticky-line" d="M7.7 12.1 Q10.6 11.7 13.4 12"/></svg>')
const isImage = a => /^image\//.test(a?.type ?? '') || /\.(png|jpe?g|gif|webp|svg)$/i.test(a?.name ?? '')
const holds = memo => Boolean(memo.text.trim() || memo.attachments?.length)

/** Who receives a memo: the crowned session of the desk. One crown per desk: the starred session. */
export const crownOf = model => model.agents.find(a => !a.other_desk && a.starred) ?? null
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

/** One note that is out (floating over the page, or lying on the Desk's paper). */
export function memoNote(memo, model, base) {
  const one = receiverOf(memo, model)
  const x = Math.round(Number(memo.x) || 0), y = Math.round(Number(memo.y) || 0)
  const unplaced = memo.place === 'float' && !x && !y
  // A floating note stays inside the window whatever its size; a note on the paper lies in the paper's pixels.
  const at = memo.place === 'paper' ? `left:${Math.max(0, x)}px;top:${Math.max(0, y)}px` : unplaced ? '' : `left:clamp(4px, ${x}px, calc(100vw - 344px));top:clamp(4px, ${y}px, calc(100vh - 120px))`
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
export function memoOpener(model, base, scope = null) {
  const to = scope ? model.agents.find(a => a.id === scope) ?? null : crownOf(model)
  const put = away(model, scope), n = put.length
  // (on a session's page a new note belongs to it)
  const here = scope ? html`<input type="hidden" name="session" value="${scope}">` : ''
  const phoneN = n + out(model, scope).filter(m => m.place === 'float').length   // on a phone a floating note waits at the button too (css/turbo.css)
  const title = `${to ? `Memo to ${to.name}` : 'Memo: a note to the crowned session'} ( / )${n ? ` · ${n === 1 ? '1 note' : `${n} notes`} put away` : ''}`
  const words = m => m.text.trim().replace(/\s+/g, ' ').slice(0, 120) || (m.attachments?.length ? `${m.attachments.length} attached` : 'Empty note')
  // (A note left floating on a wide screen is listed on a phone too: there it is not out by itself.)
  const line = (m, float) => html`<form method="post" action="${base}/memos/${m.id}/open"${float ? raw(' class="memo-away-float"') : ''}><button class="memo-away-line" type="submit" role="menuitem" data-memo="${m.id}" title="Open the note">${sk('page')}<span>${words(m)}</span></button></form>`
  return html`<div class="memo-new" id="memo-new"><form method="post" action="${base}/memos">${here}<button class="icon-btn quick-open memo-open memo-open-free" id="memo-open" type="submit" data-action="click->memos#open" aria-haspopup="${n ? 'menu' : 'dialog'}" aria-expanded="false"${n ? html` data-draft data-count="${n}"` : ''} title="${title}" aria-label="${title}">${STICKY}${phoneN ? html`<b class="memo-count memo-count-phone">${phoneN}</b>` : ''}${n ? html`<b class="memo-count">${n}</b>` : ''}</button></form>
<div class="memo-away" id="memo-away" role="menu" aria-label="Memos that were put away" data-action="turbo:submit-start->memos#shut" hidden><form method="post" action="${base}/memos">${here}<button class="memo-away-line memo-away-new" type="submit" role="menuitem" data-action="click->memos#write">${STICKY}<span>New memo</span></button></form>${put.map(m => line(m, false))}${out(model, scope).filter(m => m.place === 'float').map(m => line(m, true))}</div></div>`
}

/** What the Desk's paper needs to know (the pad's chooser of sessions): read by the controller paper (client/web/t/lib/paper.js). */
export function paperIsland(model) {
  const sessions = model.agents.map(a => ({ id: a.id, name: a.name, online: Boolean(a.online), hue: a.hue, mark: String(markArt({ ...a, starred: false })) }))
  return html`<div id="paper-island" data-controller="paper" hidden${model.state.speech ? raw(' data-speech') : ''} data-sessions="${JSON.stringify(sessions)}"></div>`
}

/** For the layout, once per page: the button, the notes, and on the Desk the paper's element. */
export const memoLayer = (model, base, view, scope = null) => html`<div id="memo-layer" data-controller="memos">${memoOpener(model, base, scope)}
<div id="memos">${out(model, scope).map(m => memoNote(m, model, base))}</div></div>
${view === 'desk' ? paperIsland(model) : ''}`


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
      const place = ['float', 'stack', 'paper'].includes(f.get('place')) ? f.get('place') : 'float'
      const made = await call({ text: String(f.get('text') ?? ''), place, x: num(f.get('x')) ?? 0, y: num(f.get('y')) ?? 0, ...(f.get('session') ? { session: String(f.get('session')) } : {}) })
      return { fresh: made.memo.id }
    },
    async open(memo) { await call({ id: memo.id, place: 'float' }); return { fresh: memo.id } },
    async stack(memo, f) {
      if (f.has('text')) await call({ id: memo.id, text: String(f.get('text')) })
      // Put away, a note hangs off the memo button (place "stack" in the hub's store); an empty one is simply gone.
      await call(holds(memo) ? { id: memo.id, place: 'stack' } : { id: memo.id, remove: true })
      return {}
    },
    async bin(memo, f) {
      const gone = { text: f.has('text') ? String(f.get('text')) : memo.text, place: memo.place, x: memo.x, y: memo.y, session: memo.session ?? '', files: memo.attachments?.length ?? 0 }
      await call({ id: memo.id, remove: true })
      if (!gone.text.trim() && !gone.files) return {}
      return { says: toast({ head: 'Note thrown away', line: gone.text.trim().replace(/\s+/g, ' ').slice(0, 80) || `${gone.files} attached`, undo: { action: `${base}/memos`, fields: { text: gone.text, place: gone.place, x: gone.x, y: gone.y, ...(gone.session ? { session: gone.session } : {}) } } }) }
    },
    async send(memo, f, m) {
      const to = receiverOf(memo, m)
      if (!to) throw new Error('no crown on this desk yet: give a session the crown on the Agents page')
      // The note goes as it stands in the form: to its session (a note of a session's page), else to the crown.
      await call({ id: memo.id, to: to.id, ...(f.has('text') ? { text: String(f.get('text')) } : {}) })
      const sent = await call({ id: memo.id, send: true })
      // The hub holds it for a moment (sent.held.ms): until then the toast's Undo brings the note back as it was.
      return { says: toast({ head: `Memo sent to ${to.name}`, ...(sent.held ? { undo: { action: `${base}/memos/${memo.id}/unsend` }, ms: Math.max(1200, sent.held.ms) } : {}) }) }
    },
    // Undo of a send, while the hub still holds the memo: the note is out again (memo may be null: it went already).
    async unsend(memo, f, m, id) { await call({ id, unsend: true }); return { fresh: id, back: true } },
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
    const note = done.fresh && (now.state.memos ?? []).find(n => n.id === done.fresh)
    return t.sendStream(req, res, [
      note && note.place !== 'stack' ? t.stream('append', 'memos', raw(String(memoNote(note, now, base)).replace('<div class="memo"', `<div class="memo" data-fresh${done.back ? ' data-back' : ''}`))) : '',
      ['stack', 'bin', 'send'].includes(what) ? t.stream('remove', `memo-${id}`) : '',
      done.says ? t.stream('prepend', 'says-host', done.says) : '',
    ].join(''))
  })

  // Every page with a stream: the notes that came, changed and went; the button; the paper's sessions.
  t.live('*', {
    // Every note with its scope; the button once per scope that a page shows (the Desk's, a session's).
    take: (m, clients = []) => ({
      notes: new Map(out(m).map(n => [n.id, { scope: scopeOf(n), text: String(memoNote(n, m, base)) }])),
      opener: new Map([...new Set([null, ...clients.map(scopeOfClient)])].map(sc => [sc, String(memoOpener(m, base, sc))])),
      paper: String(paperIsland(m)),
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
      if (client.view === 'desk' && was.paper !== now.paper) acts.push(t.stream('replace', 'paper-island', raw(now.paper)))
      return acts.join('')
    },
  })
}
