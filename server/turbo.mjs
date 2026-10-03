// The server-rendered board (Hotwire Turbo): pages that come complete from the hub, forms that do the work,
// and one live stream that carries only the element that changed. Architecture and conventions: docs/turbo.md.
//
// The hub (server.mjs) hands in what this module needs and calls two things: route(req, res, url) for every
// request behind the login, and changed() after every commit.
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { html, raw, esc } from './views/html.mjs'
import { boardModel } from './views/model.mjs'
import { page as layoutPage } from './views/layout.mjs'
import { deskMain, deskRow, deskHead, deskStacks, deskList, runSection, cardPath } from './views/desk.mjs'
import { sidebarRows, sidebarParts, deskState, slipCount } from './views/sidebar.mjs'
import { cardPage, cardLead, cardAnswer, cardThread, picturePage, imagesOf, versionOf } from './views/card.mjs'
import { WORDS, EXPLAIN_TEXT, advisedLabels } from './views/text.mjs'
import { toast } from './views/toast.mjs'   // the one toast (top right, Undo) for every page

// Where the server-rendered pages live: at the main addresses ('': the Desk at /, a card at /q/<n>) since the flip of
// 3 October 2026. BOARD_TURBO_BASE=/t puts them under a prefix again and leaves the main addresses to the old client
// (the tests run that way). The old client itself is at /old/ (server.mjs).
export const BASE = (process.env.BOARD_TURBO_BASE ?? '').replace(/\/+$/, '')
// ---- the pages ------------------------------------------------------------------------------------
// A page module exports register(t) and adds its routes, forms and live pieces through t (see "the toolkit"
// below and docs/turbo.md). To add one: ONE import here and ONE entry in PAGES. The Desk and the card page
// are registered the same way, further down in this file (registerDesk, registerCards).
import { register as sessionPage, readMultipart } from './views/session.mjs'   // a session's page: conversation, composer, files (worker A)
import { register as memoPage } from './views/memo.mjs'   // memos and the Desk's paper (worker C)
import { register as jumpPage } from './views/menu.mjs'   // the menu's jump field (worker D)
import { register as agentsPage } from './views/agents.mjs'   // the Agents page and a session's forms (worker B)
import { register as stacksPage } from './views/stacks.mjs'   // the search in a stack at the Desk's foot
const PAGES = [
  agentsPage,
  jumpPage,
  memoPage,
  sessionPage,
  stacksPage,
]

const HAND_BACK_TEXT = 'Back to you: please revise this question and present it again.'
const STREAM = 'text/vnd.turbo-stream.html'

// ---- turbo streams ----
/** One stream action. content: a Safe (html``) or nothing. */
export const stream = (action, target, content = '') => html`<turbo-stream action="${action}"${target ? html` target="${target}"` : ''}>${action === 'remove' || action === 'refresh' ? '' : html`<template>${content}</template>`}</turbo-stream>`
// Times ("5 min ago") change by themselves; a piece that differs only in them has not changed.
const sig = text => String(text).replace(/(data-ts="\d+">)[^<]*</g, '$1<').replace(/asked [^"]*"/g, '"')

export function turboRoutes(hub) {
  const boot = crypto.randomBytes(4).toString('hex')
  let rev = 0
  const revNow = () => `${boot}-${rev}`
  // The desk in view is the browser's own: a cookie, set by the Desk's address with ?desk=<id> (the menu's links).
  // A request runs inside `asking`, so that every model made while it is answered is cut to that browser's desk.
  const asking = new AsyncLocalStorage()
  const DESK_COOKIE = 'trommi_desk'
  const deskOfReq = req => /(?:^|;\s*)trommi_desk=([\w-]+)/.exec(String(req?.headers.cookie ?? ''))?.[1] ?? null
  const model = (desk = asking.getStore()?.desk ?? null) => boardModel(hub.state(), hub.agents(), desk)
  const page = opts => layoutPage({ ported, ...opts })
  const clients = new Set()   // the open pages: { res, out, view, params }
  let ported = ''

  // ---- answers ----
  function sendHtml(req, res, code, body, type = 'text/html; charset=utf-8', headers = {}) {
    const accepts = String(req.headers['accept-encoding'] ?? '')
    let bytes = Buffer.from(String(body))
    const coding = bytes.length < 512 ? '' : /\bbr\b/.test(accepts) ? 'br' : /\bgzip\b/.test(accepts) ? 'gzip' : ''
    if (coding === 'br') bytes = zlib.brotliCompressSync(bytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } })
    else if (coding === 'gzip') bytes = zlib.gzipSync(bytes, { level: 5 })
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', Vary: 'Accept-Encoding', ...(coding ? { 'Content-Encoding': coding } : {}), 'Content-Length': bytes.length, ...headers })
    res.end(bytes)
  }
  const redirect = (res, to) => { res.writeHead(303, { Location: to, 'Cache-Control': 'no-store' }); res.end() }
  const notFound = (req, res, m, what) => sendHtml(req, res, 404, page({ title: 'Not found · Trommi', view: 'missing', model: m, base: BASE, rev: revNow(), stream: null, main: html`<main id="inbox" aria-label="Not found"><header class="inbox-head"><div class="inbox-title"><h2>${what}</h2><p><a href="${BASE}/">Back to the Desk</a></p></div></header></main>` }))

  // ---- the passing note at the top left: what just happened, and the way back ----
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
  // ?said=<card>:<way> on a page's address (a form that went on to another page): its toast. Every page has it.
  const saidOf = req => { const [id, what] = String(new URL(req.url, 'http://x').searchParams.get('said') ?? '').split(':'); return id && what ? says(model().byCard.get(id), what) : '' }

  // ---- the toolkit a page module gets (register(t)) ----
  const gets = [], posts = [], lives = new Map()
  const t = {
    BASE, hub, stream, says,
    /** A toast (views/toast.mjs) put on the page, newest on top: t.toast({ head, line, undo: { action, label, fields }, role, ms }). */
    toast: opts => stream('prepend', 'says-host', toast(opts)),
    /** The board as the views want it (views/model.mjs), from the hub's state as it is now. */
    model,
    /** A page: t.get(/^\/agents$/, ({ req, res, url, match }) => t.page(req, res, { title, view, main })). The pattern is matched against the path without BASE. */
    get(pattern, handler) { gets.push({ pattern, handler }) },
    /** A form's address: t.post(/^\/sessions\/([\w-]+)\/rename$/, async ({ req, res, url, match, form }) => …). form: URLSearchParams of the body. */
    post(pattern, handler) { posts.push({ pattern, handler }) },
    /** Live pieces of a view: take(model, clients) -> what the pages of this view hold now; diff(was, now, client, model) -> the
     *  stream actions (a string) for one page. clients: the open pages of this view, each { view, params } (params: the stream's query). */
    live(view, { take, diff }) { lives.set(view, { take, diff, snaps: new Map() }) },
    /** Send a whole page (views/layout.mjs page()); model, base and rev are filled in. */
    page(req, res, opts, code = 200) { sendHtml(req, res, code, page({ model: opts.model ?? model(), base: BASE, rev: revNow(), ...opts, says: opts.says ?? saidOf(req) })) },
    /** Answer a form with stream actions. */
    sendStream: (req, res, body, code = 200) => sendHtml(req, res, code, body, `${STREAM}; charset=utf-8`),
    /** Does the request take a stream for an answer (a form sent by Turbo)? */
    wantsStream: req => String(req.headers.accept ?? '').includes(STREAM),
    redirect, notFound: (req, res, what) => notFound(req, res, model(), what),
    /** Times change by themselves: a piece that differs only in them has not changed. */
    differs: (a, b) => sig(a) !== sig(b),
  }

  // ---- what a form does ----
  // f: the form's fields (URLSearchParams); files: what was attached, as the hub's upload entries ({ name, data }).
  const noteOf = f => String(f.get('note') ?? '').trim()
  const seenOf = f => (f.has('revised') ? Number(f.get('revised')) : undefined)
  // Notes on single options stand in fields named note-<key>.
  // Marks drawn and written on the card (t/controllers/card_controller.js, js/focus-marks.js): a JSON list in the field "marks".
  const marksIn = f => { try { const list = JSON.parse(String(f.get('marks') ?? '[]')); return Array.isArray(list) && list.length ? list : undefined } catch { return undefined } }
  const notesOf = (card, f) => Object.fromEntries(card.options.map(o => [o.key, String(f.get(`note-${o.key}`) ?? '').trim()]).filter(([, said]) => said))
  // Files that go along with an answer are stored first; an answer that is not taken keeps none of them.
  async function withFiles(files, act) {
    const stored = hub.storeUploads(files)
    try { return await act(stored) } catch (err) { for (const a of stored) fs.rmSync(hub.uploadPath(a), { force: true }); throw err }
  }
  // Words to the session about a card, the way the old page's /message takes them (one place for what a message is).
  // What was sent leaves the draft: the field below the card comes back empty, and no later action carries it again.
  // (Ticks and notes on single options stay: they belong to the answer, not to the message.)
  const forgetSent = card => {
    if (!card.draft || card.kind !== 'decision' || card.status !== 'open') return
    try { hub.setDraft(card.id, { keys: card.draft.keys ?? [], note: '', notes: card.draft.notes ?? {}, marks: [] }) } catch {}
  }
  const say = (card, text, turn, files = [], marks) => hub.message({ agent: card.agent, text, card_id: card.id, ...turn, ...(files.length ? { attachments: files } : {}), ...(marks ? { marks } : {}) })
  async function takeBack(card) {
    if (card.status !== 'open' || card.with_agent == null) throw Object.assign(new Error('this card is not with the agent'), { status: 409 })
    delete card.with_agent
    hub.addEvent('handback_withdrawn', card, card.title)
    hub.commit()
    await hub.deliver(card.agent, 'notifications/claude/channel', {
      content: `The human took "${card.title}" back; there is no need to rework or explain it. If you already have, that is fine.`,
      meta: { kind: 'handback_withdrawn', card_id: card.id },
    })
  }
  const WAYS = {
    decide(card, f, files) {
      const keys = f.getAll('keys'), key = f.get('key')
      if (!keys.length && key == null) throw new Error('pick an option first')
      return withFiles(files, stored => hub.decide(card.id, card.multiple ? (keys.length ? keys : [key]) : String(key ?? keys[0]), noteOf(f), seenOf(f), card.kind === 'decision' ? notesOf(card, f) : undefined, stored, card.kind === 'decision' ? marksIn(f) : undefined))
    },
    trust: (card, f) => hub.trust(card.id, noteOf(f), seenOf(f)),
    close: card => hub.closeInfo(card.id),
    snooze: card => hub.snooze(card.id, {}),
    wake: card => hub.snooze(card.id, { clear: true }),
    shred: (card, f, files) => withFiles(files, stored => hub.shred(card.id, noteOf(f).slice(0, 2000), marksIn(f), stored)),
    reopen: card => hub.reopen(card.id),
    takeback: card => takeBack(card),
    revise: async (card, f, files) => { await say(card, noteOf(f) || HAND_BACK_TEXT, { handback: true }, files, marksIn(f)); forgetSent(card) },
    what: card => say(card, EXPLAIN_TEXT, { explain: true }),
    message(card, f, files) {
      // A message about the card: it stays with him (handing it back is the reverse field, "revise").
      const marks = marksIn(f)
      if (!noteOf(f) && !files.length && !marks) throw new Error('write something first')
      return say(card, noteOf(f), {}, files, marks).then(() => forgetSent(card))
    },
  }
  async function actRoute(req, res, form, files, id, what, cardView) {
    const before = model(), card = before.byCard.get(id)
    // In the walk the next card is the one that stood after this one, not the first of the stack again.
    const after = card ? before.fresh.slice(before.fresh.indexOf(card) + 1).map(c => c.id) : []
    const wantsStream = String(req.headers.accept ?? '').includes(STREAM)
    const stay = form.has('stay') && wantsStream
    const sendStream = (code, body) => sendHtml(req, res, code, body, `${STREAM}; charset=utf-8`)
    try {
      if (!card) throw Object.assign(new Error('this question is not on the board any more'), { status: 404 })
      await WAYS[what](card, form, files)
    } catch (err) {
      const text = err.message || 'the board did not take it'
      const m = model(), now = card && m.byCard.get(card.id)
      if (stay) return sendStream(200, now && m.fresh.includes(now) ? stream('replace', `row-${now.id}`, deskRow(now, m, BASE, { error: `Not saved: ${text}` })) : t.toast({ head: 'Not saved', line: text, role: 'alert' }))
      if (!now) return notFound(req, res, m, 'This question is not on the board any more.')
      // A form whose answer was not taken gets its page again, with what went wrong (422: Turbo shows it in place).
      return cardView(req, res, now, m, { walk: form.has('walk'), error: `Not saved: ${text}` }, 422)
    }
    const quiet = form.has('quiet') || !SAID[what]
    if (stay) {
      // The live stream moves the rows for every page; this answer only adds what belongs to the one who acted.
      const m = model()
      return sendStream(200, html`${m.fresh.some(c => c.id === id) ? '' : stream('remove', `row-${id}`)}${quiet ? '' : stream('prepend', 'says-host', says(m.byCard.get(id), what))}`)
    }
    const said = quiet ? '' : `said=${id}:${what}`
    // On a card's page: a message or a take-back stays on the card; an answer goes on (the next card of the walk, or the Desk).
    // (Opened from a session's page: the form says so in "back", and the way leads there.)
    const home = String(form.get('back') ?? '')
    const fromSession = home.startsWith(`${BASE}/s/`) && /^[\w\-/%+.]+$/.test(home)
    if (['message', 'reopen', 'takeback', 'wake'].includes(what) && !form.has('stay')) return redirect(res, `${cardPath(card, fromSession ? home : BASE)}${what === 'message' ? `?said=${id}:message` : ''}`)
    if (home.startsWith(`${BASE}/s/`) && /^[\w\-/%+.]+$/.test(home)) return redirect(res, `${home}${said ? `?${said}` : ''}`)
    if (form.has('walk')) {
      const m = model(), next = after.map(x => m.byCard.get(x)).find(c => c && m.fresh.includes(c)) ?? m.fresh.find(c => c.id !== id)
      return redirect(res, next ? `${cardPath(next, BASE)}?walk=1${said ? `&${said}` : ''}` : `${BASE}/${said ? `?${said}` : ''}`)
    }
    return redirect(res, `${BASE}/${said ? `?${said}` : ''}`)
  }

  // ---- the Desk ----
  function registerDesk(t) {
    t.get(/^\/$/, ({ req, res, url }) => {
      // The menu's "Switch desk": the desk is remembered for this browser, and the address is the Desk's own again.
      const wanted = url.searchParams.get('desk')
      if (wanted != null) {
        const known = (hub.state().desks ?? []).some(d => d.id === wanted)
        res.writeHead(303, { Location: `${BASE}/`, 'Cache-Control': 'no-store', ...(known ? { 'Set-Cookie': `${DESK_COOKIE}=${wanted}; Path=/; Max-Age=31536000; SameSite=Lax` } : {}) })
        return res.end()
      }
      const m = model()
      const pile = ['later', 'works', 'done', 'trash'].includes(url.searchParams.get('pile')) ? url.searchParams.get('pile') : null
      const [saidId, saidWhat] = String(url.searchParams.get('said') ?? '').split(':')
      const n = m.fresh.length
      t.page(req, res, { model: m, title: n ? `(${n}) ${m.deskName} · Trommi` : `${m.deskName} · Trommi`, view: 'desk', main: deskMain(m, BASE, { pile }), says: says(m.byCard.get(saidId), saidWhat) })
    })
    t.get(/^\/walk$/, ({ res, url }) => {
      const next = model().fresh[0], said = url.searchParams.get('said')
      redirect(res, next ? `${cardPath(next, BASE)}?walk=1` : `${BASE}/${said ? `?said=${encodeURIComponent(said)}` : ''}`)
    })
    t.live('desk', {
      take: m => ({ order: m.fresh.map(c => c.id), rows: new Map(m.fresh.map(c => [c.id, deskRow(c, m, BASE)])), head: deskHead(m, BASE), stacks: deskStacks(m, BASE) }),
      diff(was, now, client, m) {
        const out = []
        if (t.differs(was.head, now.head)) out.push(stream('replace', 'desk-head', now.head))
        const kept = was.order.filter(id => now.rows.has(id)), added = now.order.filter(id => !was.rows.has(id))
        const sameOrder = kept.every((id, i) => now.order[i] === id)   // what stayed stands first, in the same order: only rows left, or came at the end
        if (!sameOrder) out.push(stream('update', 'desk-list', deskList(m, BASE, { rowOf: c => now.rows.get(c.id) })))
        else {
          for (const id of was.order) if (!now.rows.has(id)) out.push(stream('remove', `row-${id}`))
          for (const id of kept) if (t.differs(was.rows.get(id), now.rows.get(id))) out.push(stream('replace', `row-${id}`, now.rows.get(id)))
          // A card that arrives stands at the end of the stack: its own run, before the stacks.
          for (const id of added) { const card = m.byCard.get(id), sender = m.byAgent.get(card.agent); if (sender) out.push(stream('before', 'desk-stacks', runSection(sender, now.rows.get(id), 1))) }
        }
        if (t.differs(was.stacks, now.stacks)) out.push(stream('replace', 'desk-stacks', now.stacks))
        return out.join('')
      },
    })
  }

  // ---- a card's own page, its picture, and what its forms do ----
  function registerCards(t) {
    const cardView = (req, res, card, m, { said = '', ...opts } = {}, code = 200) => {
      const [saidId, saidWhat] = said.split(':')
      // A version before (?v=n) is read-only: its stream says so (&old=n) and gets no live face or options of the card as it stands now.
      const old = versionOf(card, opts.version)
      // In the board's frame, the sidebar beside it (card Nr. 191). from: the session it was opened from, for its links.
      const from = opts.from && m.byAgent.has(opts.from) ? opts.from : null
      t.page(req, res, { model: m, title: `${card.title} · Trommi`, view: 'card', css: 'card', current: from, stream: `&card=${card.id}${from ? `&from=${encodeURIComponent(from)}` : ''}${old ? `&old=${old.n}` : ''}`, main: cardPage(card, m, BASE, { ...opts, from }), says: says(m.byCard.get(saidId), saidWhat) }, code)
    }
    t.get(/^\/(?:s\/([^/]+)\/)?q\/([\w-]+)$/, ({ req, res, url, match }) => {
      const m = model(), card = m.cardByRef(match[2])
      if (!card) return notFound(req, res, m, 'This question is not on the board any more.')
      cardView(req, res, card, m, { said: String(url.searchParams.get('said') ?? ''), pic: Number(url.searchParams.get('pic')) || 1, walk: url.searchParams.has('walk'), version: Number(url.searchParams.get('v')) || null, from: match[1] ? decodeURIComponent(match[1]) : null })
    })
    // One picture, large, at its own address: the browser's Back closes it.
    t.get(/^\/(?:s\/([^/]+)\/)?q\/([\w-]+)\/p\/(\d+)$/, ({ req, res, match: [, from, ref, at] }) => {
      const match = [null, ref, at]
      const m = model(), card = m.cardByRef(match[1])
      if (!card) return notFound(req, res, m, 'This question is not on the board any more.')
      if (!imagesOf(card).length) return redirect(res, cardPath(card, BASE))
      t.page(req, res, { model: m, title: `${card.title} · picture ${match[2]}`, view: 'picture', sidebar: false, css: 'picture', stream: null, main: picturePage(card, BASE, Number(match[2]), { from: from ? decodeURIComponent(from) : null }), bodyAttrs: ' data-focus-page="card"' })
    })
    // The draft: what is ticked and written on an open question, kept while typing (the island "card" sends it). No page follows.
    t.post(/^\/cards\/([0-9a-f]+)\/draft$/, ({ res, match, form }) => {
      const card = model().byCard.get(match[1])
      try {
        if (!card) throw Object.assign(new Error('unknown card'), { status: 404 })
        hub.setDraft(card.id, { keys: form.getAll('keys'), note: String(form.get('note') ?? ''), notes: notesOf(card, form), marks: form.has('marks') ? marksIn(form) ?? [] : card.draft?.marks })
        res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end()
      } catch (err) { res.writeHead(err.status ?? 400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(err.message) }
    })
    // Every other form of a card. It may carry files (multipart/form-data), so it reads its body itself.
    const cardPost = async ({ req, res, match }) => {
      if (!Object.hasOwn(WAYS, match[2])) return false
      const bytes = await hub.readRaw(req, hub.uploadLimit ?? 96e6), type = String(req.headers['content-type'] ?? '')
      const { fields, files } = /^multipart\/form-data/i.test(type) ? readMultipart(bytes, type) : { fields: new URLSearchParams(bytes.toString('utf8')), files: [] }
      const uploads = files.map(f => ({ name: f.name, data: `data:${/^[\w.+-]+\/[\w.+-]+$/.test(f.type) ? f.type : 'application/octet-stream'};base64,${f.bytes.toString('base64')}` }))
      return actRoute(req, res, fields, uploads, match[1], match[2], cardView)
    }
    cardPost.raw = true
    t.post(/^\/cards\/([0-9a-f]+)\/([a-z]+)$/, cardPost)
    t.live('card', {
      // (The draft is what the human is typing: it never makes a piece count as changed, so nothing is replaced under their hands;
      //  a piece that is replaced for another reason comes with the draft as the hub has it.)
      // (Pieces are kept per card and per session it was opened from: the links in them lead back there.)
      take: (m, clients) => new Map([...new Set(clients.filter(c => c.params.get('card')).map(c => `${c.params.get('card')}|${c.params.get('from') ?? ''}`))].map(k => {
        const [id, from] = k.split('|'), card = m.byCard.get(id), self = from ? `${BASE}/s/${encodeURIComponent(from)}` : BASE
        return [k, card ? { face: cardLead(card, m, self), answer: cardAnswer(card, m, BASE), answerSig: cardAnswer({ ...card, draft: undefined }, m, BASE), thread: cardThread(card, m, self) } : null]
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

  // ---- what stands around every page with a sidebar: the sessions, and the floating Desk's counts ----
  // (Sent to every page whose stream says bar=1; the layout adds that when it renders the sidebar.)
  lives.set('', {
    snaps: new Map(),
    take: m => ({ sidebar: sidebarRows(m, BASE), rows: sidebarParts(m, BASE), pill: deskState(m, BASE), slip: slipCount(m) }),
    // The sidebar: while its rows stand as they stood, only a row that changed is replaced (so the drawing of a session
    // at work keeps drawing in the other rows); otherwise all of it.
    diff: (was, now) => `${t.differs(was.pill, now.pill) ? stream('update', 'desk-state', now.pill) : ''}${t.differs(was.slip, now.slip) ? stream('replace', 'slip-n', now.slip) : ''}${!t.differs(was.sidebar, now.sidebar) ? ''
      : was.rows.shape !== now.rows.shape ? stream('update', 'agents', now.sidebar)
        : [...now.rows.here, ...now.rows.away].map(([id, row], i) => (t.differs([...was.rows.here, ...was.rows.away][i][1], row) ? stream('replace', `agent-${id}`, row) : '')).join('')}`,
  })

  for (const register of [registerDesk, registerCards, ...PAGES]) register(t)

  // ---- the live stream ----
  // A page that does not read (asleep, on a dead link) is not written to while its buffers are full: it is marked
  // behind and, once they drain, told to fetch itself anew (refresh), instead of piling up every change in memory.
  // So what waits for it is at most the one change that filled the buffers. One that stays clogged past CLOGGED is let go.
  const CLOGGED = hub.clogMs ?? 60000
  const clogged = client => client.out.writableNeedDrain || client.res.writableNeedDrain
  const drop = client => { clients.delete(client); clearInterval(client.ping); client.res.destroy(); if (client.out !== client.res) client.out.destroy() }
  const put = (client, text) => {
    if (!clients.has(client)) return
    if (client.behind || clogged(client)) {
      client.behind ??= Date.now()
      if (Date.now() - client.behind > CLOGGED) drop(client)
      return
    }
    client.out.write(text)
  }
  const write = (client, text) => { if (text) put(client, `data: ${String(text).replace(/\n/g, '\ndata: ')}\n\n`) }
  const of = view => [...clients].filter(c => (view === '*' ? true : view === '' ? c.params.get('bar') === '1' : c.view === view))   // '*': every page with a stream (the memos)
  /** After every commit: each open page gets the elements that changed, and nothing else. */
  function changed() {
    rev++
    const models = new Map()   // one per desk that has a page open
    for (const [view, live] of lives) {
      const mine = of(view)
      const desks = new Set(mine.map(c => c.desk))
      for (const desk of [...live.snaps.keys()]) if (!desks.has(desk)) live.snaps.delete(desk)
      for (const desk of desks) {
        try {
          if (!models.has(desk)) models.set(desk, model(desk))
          const m = models.get(desk), group = mine.filter(c => c.desk === desk)
          const now = live.take(m, group), was = live.snaps.get(desk) ?? now
          live.snaps.set(desk, now)
          for (const client of group) write(client, live.diff(was, now, client, m))
        } catch (err) { console.error(`[board] turbo stream (${view}): ${err.stack ?? err}`) }
      }
    }
  }
  function streamRoute(req, res, url) {
    const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...(gzip ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}) })
    let out = res
    if (gzip) { out = zlib.createGzip({ level: 5, flush: zlib.constants.Z_SYNC_FLUSH }); out.on('error', () => res.destroy()); out.pipe(res) }
    const client = { res, out, view: url.searchParams.get('view') ?? 'desk', params: url.searchParams, desk: deskOfReq(req), behind: null }
    clients.add(client)
    // Caught up after being behind: what it missed is fetched by the page itself.
    const caughtUp = () => { if (client.behind == null || clogged(client)) return; client.behind = null; write(client, stream('refresh')) }
    res.on('drain', caughtUp)
    if (out !== res) out.on('drain', caughtUp)
    out.write('retry: 2000\n\n')
    // The page was rendered before this stream stood (or before a restart of the hub): if anything changed since, it fetches itself anew once.
    if (url.searchParams.get('rev') !== revNow()) write(client, stream('refresh'))
    // What the pages of this view hold from now on includes this page (a card page brings its card along).
    try { for (const view of [client.view, '*', ...(client.params.get('bar') === '1' ? [''] : [])]) { const live = lives.get(view); if (live) live.snaps.set(client.desk, live.take(model(client.desk), of(view).filter(c => c.desk === client.desk))) } } catch (err) { console.error(`[board] turbo stream (${client.view}): ${err.stack ?? err}`) }
    client.ping = setInterval(() => put(client, ': ping\n\n'), hub.ping ?? 15000)
    req.on('close', () => { clearInterval(client.ping); clients.delete(client); if (out !== res) out.destroy() })
  }

  // ---- the routes ----
  const inBase = pathname => (BASE ? (pathname === BASE || pathname.startsWith(`${BASE}/`) ? pathname.slice(BASE.length) || '/' : null) : pathname)
  /** Is this the address of a server-rendered page (for the sign-in page of a browser that is not logged in)? */
  const isPage = pathname => { const p = inBase(pathname); return p != null && gets.some(g => g.pattern.test(p)) }
  /** Answers the request if it is one of this module's; returns whether it did. */
  const route = (req, res, url) => asking.run({ desk: deskOfReq(req) }, () => routeIn(req, res, url))
  async function routeIn(req, res, url) {
    // Since the flip the pages stand at the main addresses. What still asks under the old prefix /t (a link he kept,
    // a page that was open, its stream and its forms) is sent to the same path without it; the files in /t/ are files.
    if (!BASE && (url.pathname === '/t' || url.pathname.startsWith('/t/'))) {
      const rest = url.pathname.slice(2) || '/'
      const known = req.method === 'GET' ? rest === '/stream' || gets.some(g => g.pattern.test(rest)) : posts.some(g => g.pattern.test(rest))
      if (!known) return false
      res.writeHead(req.method === 'GET' ? 302 : 307, { Location: rest + url.search, 'Cache-Control': 'no-store' })
      res.end()
      return true
    }
    const p = inBase(url.pathname)
    if (p == null) return false
    if (req.method === 'GET') {
      if (p === '/stream') return streamRoute(req, res, url), true
      for (const { pattern, handler } of gets) {
        const match = pattern.exec(p)
        if (match && (await handler({ req, res, url, match })) !== false) return true
      }
      // A page that is not ported yet: the old client has it, under the same path without the prefix.
      if (BASE && /^\/(s\/|agents$|inbox$|pad$)/.test(p)) { res.writeHead(302, { Location: p + url.search }); res.end(); return true }
      return false
    }
    if (req.method === 'POST') {
      for (const { pattern, handler } of posts) {
        const match = pattern.exec(p)
        if (!match) continue
        // (A handler marked raw reads the body itself: a form with files, views/session.mjs.)
        const form = handler.raw ? null : new URLSearchParams((await hub.readRaw(req, 1e6)).toString('utf8'))
        if ((await handler({ req, res, url, match, form })) !== false) return true
      }
    }
    return false
  }
  /** The paths of the pages that are rendered here, as one pattern for the page's script (t/boot.js): links to any other page load whole. */
  ported = gets.map(g => g.pattern.source).join('|')
  return { route, changed, isPage, base: BASE, clients: () => clients.size }
}
