// The board's pages, forms and live pieces, in the page: a port of trommi-hub server/turbo.mjs to the browser.
// The view modules register themselves exactly as on the hub (register(t) with t.get, t.post, t.live), so the
// markup is the same; a "request" here is a navigation or a form of this page, answered from the local model.
//
//   const board = createBoard({ hub, model })   hub: hub-facade.mjs; model(): views/model.mjs boardModel of now
//   await board.request({ method, path, form, headers })  -> { kind: 'page' | 'stream' | 'redirect' | 'html' | 'none', … }
//   board.live(clients)                          after a change: the stream actions per open page (only what changed)
import { html, raw } from '../views/html.mjs'
import { deskMain, deskRow, deskHead, deskStacks, deskList, runSection, cardPath } from '../views/desk.mjs'
import { sidebarRows, sidebarParts, deskState, slipCount } from '../views/sidebar.mjs'
import { cardPage, cardLead, cardAnswer, cardThread, picturePage, imagesOf, versionOf } from '../views/card.mjs'
import { WORDS, EXPLAIN_TEXT, isKnock } from '../views/text.mjs'
import { toast } from '../views/toast.mjs'
import { register as sessionPage } from '../views/session.mjs'
import { register as memoPage } from '../views/memo.mjs'
import { register as jumpPage } from '../views/menu.mjs'
import { register as agentsPage } from '../views/agents.mjs'
import { register as stacksPage } from '../views/stacks.mjs'

export const BASE = ''
const HAND_BACK_TEXT = 'Back to you: please revise this question and present it again.'
const STREAM = 'text/vnd.turbo-stream.html'
export const stream = (action, target, content = '') => html`<turbo-stream action="${action}"${target ? html` target="${target}"` : ''}>${action === 'remove' || action === 'refresh' ? '' : html`<template>${content}</template>`}</turbo-stream>`
const sig = text => String(text).replace(/(data-ts="\d+">)[^<]*</g, '$1<').replace(/asked [^"]*"/g, '"')

export function createBoard({ hub, model, extraPages = [] }) {
  // ---- answers: a response object the router reads ----
  const response = () => ({
    kind: 'none', code: 200, body: '', opts: null, to: null,
    writeHead(code, headers = {}) { this.code = code; if (headers.Location) { this.kind = 'redirect'; this.to = headers.Location } },
    end(body = '') { if (this.kind === 'none' && body) { this.kind = 'html'; this.body = String(body) } },
  })
  const redirect = (res, to) => { res.kind = 'redirect'; res.to = to; res.code = 303 }
  const notFoundMain = what => html`<main id="inbox" aria-label="Not found"><header class="inbox-head"><div class="inbox-title"><h2>${what}</h2><p><a href="${BASE}/" data-nav>Back to the Desk</a></p></div></header></main>`

  // ---- the toast after an action ----
  const SAID = {
    decide: { head: 'Answered', back: 'reopen' }, trust: { head: WORDS.trust, back: 'reopen' }, close: { head: 'Read', back: 'reopen' },
    shred: { head: 'Shredded', back: 'reopen' }, snooze: { head: 'Snoozed', back: 'wake' }, revise: { head: 'Handed back', back: 'takeback' }, message: { head: 'Message sent' }, what: { head: `Asked: ${WORDS.what}`, back: 'takeback' },
  }
  function says(card, what) {
    const said = SAID[what]
    if (!card || !said) return ''
    const picked = card.choices?.length ? card.options.filter(o => card.choices.includes(o.key)).map(o => o.label).join(', ') : ''
    const line = what === 'decide' && picked ? `${card.title} → ${picked}` : card.title
    return toast({ head: said.head, line, undo: said.back ? { action: `${BASE}/cards/${card.id}/${said.back}` } : null })
  }
  const saidOf = req => { const [id, what] = String(new URL(req.url, 'http://x').searchParams.get('said') ?? '').split(':'); return id && what ? says(model().byCard.get(id), what) : '' }

  // ---- the toolkit the page modules get ----
  const gets = [], posts = [], lives = new Map()
  const t = {
    BASE, hub, stream, says,
    toast: opts => stream('prepend', 'says-host', toast(opts)),
    model,
    get(pattern, handler) { gets.push({ pattern, handler }) },
    post(pattern, handler) { posts.push({ pattern, handler }) },
    live(view, { take, diff }) { lives.set(view, { take, diff, snap: null }) },
    page(req, res, opts, code = 200) { res.kind = 'page'; res.code = code; res.opts = { model: opts.model ?? model(), ...opts, says: opts.says ?? saidOf(req) } },
    sendStream: (req, res, body, code = 200) => { res.kind = 'stream'; res.code = code; res.body = String(body) },
    wantsStream: req => String(req.headers.accept ?? '').includes(STREAM),
    redirect, notFound: (req, res, what) => t.page(req, res, { title: 'Not found · Trommi', view: 'missing', stream: null, main: notFoundMain(what) }, 404),
    differs: (a, b) => sig(a) !== sig(b),
  }

  // ---- what a card's form does ----
  const noteOf = f => String(f.get('note') ?? '').trim()
  const seenOf = f => (f.has('revised') ? Number(f.get('revised')) : undefined)
  const marksIn = f => { try { const list = JSON.parse(String(f.get('marks') ?? '[]')); return Array.isArray(list) && list.length ? list : undefined } catch { return undefined } }
  const notesOf = (card, f) => Object.fromEntries(card.options.map(o => [o.key, String(f.get(`note-${o.key}`) ?? '').trim()]).filter(([, said]) => said))
  const forgetSent = card => {
    if (!card.draft || card.kind !== 'decision' || card.status !== 'open') return
    try { hub.setDraft(card.id, { keys: card.draft.keys ?? [], note: '', notes: card.draft.notes ?? {}, marks: [] }) } catch {}
  }
  const say = (card, text, turn, files = [], marks) => hub.message({ agent: card.agent, text, card_id: card.id, ...turn, ...(files.length ? { attachments: files } : {}), ...(marks ? { marks } : {}) })
  const WAYS = {
    decide(card, f, files) {
      const keys = f.getAll('keys').map(String), key = f.get('key')
      if (!keys.length && key == null) throw new Error('pick an option first')
      return hub.decide(card.id, card.multiple ? (keys.length ? keys : [String(key)]) : String(key ?? keys[0]), noteOf(f), seenOf(f), card.kind === 'decision' ? notesOf(card, f) : undefined, files, card.kind === 'decision' ? marksIn(f) : undefined)
    },
    trust: (card, f) => hub.trust(card.id, noteOf(f), seenOf(f)),
    close: card => hub.closeInfo(card.id),
    snooze: card => hub.snooze(card.id, {}),
    wake: card => hub.snooze(card.id, { clear: true }),
    shred: (card, f, files) => hub.shred(card.id, noteOf(f).slice(0, 2000), marksIn(f), files),
    reopen: card => hub.reopen(card.id),
    takeback: card => hub.takeBack(card.id),
    revise: async (card, f, files) => { await say(card, noteOf(f) || HAND_BACK_TEXT, { handback: true }, files, marksIn(f)); forgetSent(card) },
    what: card => say(card, EXPLAIN_TEXT, { explain: true }),
    message(card, f, files) {
      const marks = marksIn(f)
      if (!noteOf(f) && !files.length && !marks) throw new Error('write something first')
      return say(card, noteOf(f), {}, files, marks).then(() => forgetSent(card))
    },
  }
  const filesOf = form => (form ? [...form.values()].filter(v => v instanceof File && v.size > 0) : [])
  async function actRoute(req, res, form, id, what, cardView) {
    const before = model(), card = before.byCard.get(id)
    const after = card ? before.fresh.slice(before.fresh.indexOf(card) + 1).map(c => c.id) : []
    const wantsStream = t.wantsStream(req)
    const stay = form.has('stay') && wantsStream
    try {
      if (!card) throw Object.assign(new Error('this question is not on the board any more'), { status: 404 })
      await WAYS[what](card, form, filesOf(form))
    } catch (err) {
      const text = err.message || 'the board did not take it'
      const m = model(), now = card && m.byCard.get(card.id)
      if (stay) return t.sendStream(req, res, now && m.fresh.includes(now) ? stream('replace', `row-${now.id}`, deskRow(now, m, BASE, { error: `Not saved: ${text}` })) : t.toast({ head: 'Not saved', line: text, role: 'alert' }))
      if (!now) return t.notFound(req, res, 'This question is not on the board any more.')
      return cardView(req, res, now, m, { walk: form.has('walk'), error: `Not saved: ${text}` }, 422)
    }
    const quiet = form.has('quiet') || !SAID[what]
    if (stay) {
      const m = model()
      return t.sendStream(req, res, html`${m.fresh.some(c => c.id === id) ? '' : stream('remove', `row-${id}`)}${quiet ? '' : stream('prepend', 'says-host', says(m.byCard.get(id), what))}`)
    }
    const said = quiet ? '' : `said=${id}:${what}`
    const home = String(form.get('back') ?? '')
    const fromSession = home.startsWith(`${BASE}/s/`) && /^[\w\-/%+.]+$/.test(home)
    if (['message', 'reopen', 'takeback', 'wake'].includes(what) && !form.has('stay')) return redirect(res, `${cardPath(card, fromSession ? home : BASE)}${what === 'message' ? `?said=${id}:message` : ''}`)
    if (fromSession) return redirect(res, `${home}${said ? `?${said}` : ''}`)
    if (form.has('walk')) {
      const m = model(), next = after.map(x => m.byCard.get(x)).find(c => c && m.fresh.includes(c)) ?? m.fresh.find(c => c.id !== id)
      return redirect(res, next ? `${cardPath(next, BASE)}?walk=1${said ? `&${said}` : ''}` : `${BASE}/${said ? `?${said}` : ''}`)
    }
    return redirect(res, `${BASE}/${said ? `?${said}` : ''}`)
  }

  // ---- the Desk ----
  // The row cache: a row is rendered again only when its card (a new object after any change of it), its session or
  // the desk's frame changed. Keeps a change on a Desk of hundreds of cards to the rows it touched.
  const rowCache = new WeakMap()
  const rowOf = (c, m) => {
    const a = m.byAgent.get(c.agent), key = `${a?.name}|${a?.hue}|${a?.mark}|${a?.starred}|${a?.online}|${m.desk}`
    const hit = rowCache.get(c)
    if (hit && hit.key === key) return hit.row
    const row = deskRow(c, m, BASE)
    rowCache.set(c, { key, row })
    return row
  }
  // Windowed: the first WINDOW rows are whole; the rest stand as empty rows of the same id (and knock mark), filled in
  // when they come near the viewport (desk-window.mjs asks board.row(id)). A long Desk costs what is in view.
  const WINDOW = 16
  const later = c => raw(`<article class="inbox-row" id="row-${c.id}" data-later data-id="${c.id}"${isKnock(c) ? ' data-knock' : ''}></article>`)
  const windowed = m => { const first = new Set(m.fresh.slice(0, WINDOW).map(c => c.id)); return c => (first.has(c.id) ? rowOf(c, m) : later(c)) }
  function registerDesk() {
    t.get(/^\/$/, ({ req, res, url }) => {
      const m = model()
      const pile = ['later', 'works', 'done', 'trash'].includes(url.searchParams.get('pile')) ? url.searchParams.get('pile') : null
      const [saidId, saidWhat] = String(url.searchParams.get('said') ?? '').split(':')
      const n = m.fresh.length
      t.page(req, res, { model: m, title: n ? `(${n}) ${m.deskName} · Trommi` : `${m.deskName} · Trommi`, view: 'desk', main: deskMain(m, BASE, { pile, rowOf: windowed(m) }), says: says(m.byCard.get(saidId), saidWhat) })
    })
    t.get(/^\/walk$/, ({ res, url }) => {
      const next = model().fresh[0], said = url.searchParams.get('said')
      redirect(res, next ? `${cardPath(next, BASE)}?walk=1` : `${BASE}/${said ? `?said=${encodeURIComponent(said)}` : ''}`)
    })
    t.live('desk', {
      take: m => ({ order: m.fresh.map(c => c.id), rows: new Map(m.fresh.map(c => [c.id, rowOf(c, m)])), head: deskHead(m, BASE), stacks: deskStacks(m, BASE) }),
      diff(was, now, client, m) {
        const out = []
        if (t.differs(was.head, now.head)) out.push(stream('replace', 'desk-head', now.head))
        const kept = was.order.filter(id => now.rows.has(id)), added = now.order.filter(id => !was.rows.has(id))
        const sameOrder = kept.every((id, i) => now.order[i] === id)
        if (!sameOrder) { const w = windowed(m); out.push(stream('update', 'desk-list', deskList(m, BASE, { rowOf: c => (w(c) === now.rows.get(c.id) ? now.rows.get(c.id) : w(c)) }))) }
        else {
          for (const id of was.order) if (!now.rows.has(id)) out.push(stream('remove', `row-${id}`))
          for (const id of kept) if (was.rows.get(id) !== now.rows.get(id) && t.differs(was.rows.get(id), now.rows.get(id))) out.push(stream('replace', `row-${id}`, now.rows.get(id)))
          for (const id of added) { const card = m.byCard.get(id), sender = m.byAgent.get(card.agent); if (sender) out.push(stream('before', 'desk-stacks', runSection(sender, now.rows.get(id), 1))) }
        }
        if (t.differs(was.stacks, now.stacks)) out.push(stream('replace', 'desk-stacks', now.stacks))
        return out.join('')
      },
    })
  }

  // ---- a card's page ----
  function registerCards() {
    const cardView = (req, res, card, m, { said = '', ...opts } = {}, code = 200) => {
      const [saidId, saidWhat] = said.split(':')
      const old = versionOf(card, opts.version)
      const from = opts.from && m.byAgent.has(opts.from) ? opts.from : null
      t.page(req, res, { model: m, title: `${card.title} · Trommi`, view: 'card', css: 'card', current: from, stream: `&card=${card.id}${from ? `&from=${encodeURIComponent(from)}` : ''}${old ? `&old=${old.n}` : ''}`, main: cardPage(card, m, BASE, { ...opts, from }), says: says(m.byCard.get(saidId), saidWhat) }, code)
    }
    // The comments are a timeline loaded newest page first; ?older=1 asks for the page before (it comes in live).
    const threadOf = card => `chat:card/${card.id}`
    const moreOf = card => card.kind !== 'permission' && Boolean(hub.hasMore?.(threadOf(card)))
    t.get(/^\/(?:s\/([^/]+)\/)?[qc]\/([\w-]+)$/, ({ req, res, url, match }) => {
      const m = model(), card = m.cardByRef(match[2])
      if (!card) return t.notFound(req, res, 'This question is not on the board any more.')
      if (url.searchParams.has('older') && moreOf(card)) hub.loadOlder(threadOf(card)).catch(err => console.warn('older comments', err))
      cardView(req, res, card, m, { more: moreOf(card), said: String(url.searchParams.get('said') ?? ''), pic: Number(url.searchParams.get('pic')) || 1, walk: url.searchParams.has('walk'), version: Number(url.searchParams.get('v')) || null, from: match[1] ? decodeURIComponent(match[1]) : null })
    })
    t.get(/^\/(?:s\/([^/]+)\/)?[qc]\/([\w-]+)\/p\/(\d+)$/, ({ req, res, match: [, from, ref, at] }) => {
      const m = model(), card = m.cardByRef(ref)
      if (!card) return t.notFound(req, res, 'This question is not on the board any more.')
      if (!imagesOf(card).length) return redirect(res, cardPath(card, BASE))
      t.page(req, res, { model: m, title: `${card.title} · picture ${at}`, view: 'picture', sidebar: false, css: 'picture', stream: null, main: picturePage(card, BASE, Number(at), { from: from ? decodeURIComponent(from) : null }), bodyAttrs: ' data-focus-page="card"' })
    })
    t.post(/^\/cards\/([0-9a-f]+)\/draft$/, ({ res, match, form }) => {
      const card = model().byCard.get(match[1])
      if (!card) { res.code = 404; return }
      hub.setDraft(card.id, { keys: form.getAll('keys').map(String), note: String(form.get('note') ?? ''), notes: notesOf(card, form), marks: form.has('marks') ? marksIn(form) ?? [] : card.draft?.marks })
      res.code = 204
    })
    t.post(/^\/cards\/([0-9a-f]+)\/([a-z]+)$/, async ({ req, res, match, form }) => {
      if (!Object.hasOwn(WAYS, match[2])) return false
      return actRoute(req, res, form, match[1], match[2], cardView)
    })
    t.live('card', {
      take: (m, clients) => new Map([...new Set(clients.filter(c => c.params.get('card')).map(c => `${c.params.get('card')}|${c.params.get('from') ?? ''}`))].map(k => {
        const [id, from] = k.split('|'), card = m.byCard.get(id), self = from ? `${BASE}/s/${encodeURIComponent(from)}` : BASE
        return [k, card ? { face: cardLead(card, m, self), answer: cardAnswer(card, m, BASE), answerSig: cardAnswer({ ...card, draft: undefined }, m, BASE), thread: cardThread(card, m, self, { more: moreOf(card) }) } : null]
      })),
      diff(was, now, client) {
        const id = client.params.get('card'), k = `${id}|${client.params.get('from') ?? ''}`, a = was.get(k), b = now.get(k)
        if (!b) return a ? String(stream('refresh')) : ''
        if (!a) return ''
        const face = t.differs(a.face, b.face) ? String(stream('replace', `card-lead-${id}`, b.face)) : ''
        if (client.params.has('old')) return t.differs(a.thread, b.thread) ? String(stream('replace', `card-thread-${id}`, b.thread)) : ''
        return face + (t.differs(a.answerSig, b.answerSig) ? stream('replace', `card-answer-${id}`, b.answer) : '') + (t.differs(a.thread, b.thread) ? stream('replace', `card-thread-${id}`, b.thread) : '')
      },
    })
  }

  // ---- around every page with a sidebar ----
  lives.set('', {
    snap: null,
    take: m => ({ sidebar: sidebarRows(m, BASE), rows: sidebarParts(m, BASE), pill: deskState(m, BASE), slip: slipCount(m) }),
    diff: (was, now) => `${t.differs(was.pill, now.pill) ? stream('update', 'desk-state', now.pill) : ''}${t.differs(was.slip, now.slip) ? stream('replace', 'slip-n', now.slip) : ''}${!t.differs(was.sidebar, now.sidebar) ? ''
      : was.rows.shape !== now.rows.shape ? stream('update', 'agents', now.sidebar)
        : [...now.rows.here, ...now.rows.away].map(([id, row], i) => (t.differs([...was.rows.here, ...was.rows.away][i][1], row) ? stream('replace', `agent-${id}`, row) : '')).join('')}`,
  })

  for (const register of [...extraPages, registerDesk, registerCards, agentsPage, jumpPage, memoPage, sessionPage, stacksPage]) register(t)

  /** One request of this page: a navigation (GET) or a form (POST). */
  async function request({ method = 'GET', path, form = null, headers = {} }) {
    const url = new URL(path, location.origin)
    const req = { method, url: url.pathname + url.search, headers, form }
    const res = response()
    const p = url.pathname
    const list = method === 'GET' ? gets : posts
    for (const { pattern, handler } of list) {
      const match = pattern.exec(p)
      if (!match) continue
      if ((await handler({ req, res, url, match, form })) !== false) return res
    }
    res.kind = 'missing'
    return res
  }

  /** The open page's live pieces: call with the page's client ({ view, params }) once after it was rendered
   *  (snapshot), then after every change (returns the stream actions to apply). */
  function live(client, { reset = false } = {}) {
    const m = model()
    const views = [client.view, '*', ...(client.params.get('bar') === '1' ? [''] : [])]
    let out = ''
    for (const view of views) {
      const l = lives.get(view)
      if (!l) continue
      try {
        const now = l.take(m, [client])
        if (!reset && l.snap) out += l.diff(l.snap, now, client, m)
        l.snap = now
      } catch (err) { console.error(`live (${view})`, err) }
    }
    for (const [view, l] of lives) if (!views.includes(view)) l.snap = null
    return out
  }
  /** A Desk row's whole markup (for a row that stood empty until it came near). */
  const row = id => { const m = model(), c = m.byCard.get(id); return c && m.fresh.includes(c) ? String(rowOf(c, m)) : '' }
  return { request, live, says, t, row }
}
