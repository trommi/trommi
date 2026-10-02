// The conversation: message log with stable nodes, pinned scrolling, composer,
// plus the pieces the history shares (icons, attachments, lightbox, code blocks).

import { sendMessage, decide } from './store.js'
import { el, rich, clock, kindOf, mediaNodes, URGENCY_LABEL } from './ui.js'

// ---- icons -----------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg'
const ICONS = {
  asked: ['M12 3.500a8.500 8.500 0 1 0 0 17 8.500 8.500 0 0 0 0-17z', 'M9.600 9.700a2.500 2.500 0 1 1 3.700 2.200c-.800.450-1.300 1-1.300 1.900', 'M12 16.700v.100'],
  decided: ['M5 12.500l4.500 4.500L19 7.500'],
  done: ['M2.500 12.500l4 4 8-9', 'M12 16l.500.500 9-9.500'],
  urgency: ['M13 3 5.500 13.500H11L10 21l8.500-10.500H13L13 3z'],
  reopened: ['M9 7 4.500 11.500 9 16', 'M4.500 11.500H14a5.500 5.500 0 0 1 0 11h-2'],
  check: ['M5 12.500l4.500 4.500L19 7.500'],
  copy: ['M10.500 8.500h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z', 'M15.500 5.500v-.500a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2H7'],
  close: ['M6 6l12 12M18 6 6 18'],
  prev: ['M14.500 5.500 8 12l6.500 6.500'],
  next: ['M9.500 5.500 16 12l-6.500 6.500'],
  chevron: ['M5.500 9 12 15.500 18.500 9'],
  file: ['M7 3.500h7l4.500 4.500V19a1.500 1.500 0 0 1-1.500 1.500H7A1.500 1.500 0 0 1 5.500 19V5A1.500 1.500 0 0 1 7 3.500z', 'M13.500 3.500V8.500H18.500'],
  external: ['M14 5h5v5', 'M19 5l-8 8', 'M11 6.500H6.500A1.500 1.500 0 0 0 5 8v9.500A1.500 1.500 0 0 0 6.500 19H16a1.500 1.500 0 0 0 1.500-1.500V13'],
  spark: ['M12 3.500c.700 4.500 4 7.800 8.500 8.500-4.500.700-7.800 4-8.500 8.500-.700-4.500-4-7.800-8.500-8.500 4.500-.700 7.800-4 8.500-8.500z'],
  warn: ['M12 9v4.500', 'M12 16.800v.100', 'M10.300 4.500 2.900 17.500a2 2 0 0 0 1.700 3h14.800a2 2 0 0 0 1.700-3L13.700 4.500a2 2 0 0 0-3.400 0z'],
  stack: ['M6.500 8.500h11a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z', 'M7.500 5.500h9'],
  history: ['M4 12a8 8 0 1 0 2.600-5.900', 'M4 4.500V8.500H8', 'M12 8v4.500l3 1.800'],
}

export function icon(name, cls = 'ico') {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('class', cls)
  svg.setAttribute('aria-hidden', 'true')
  for (const d of ICONS[name] ?? []) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}

function button(cls, label) {
  const node = el('button', cls)
  node.type = 'button'
  if (label) node.setAttribute('aria-label', label)
  return node
}

// ---- lightbox --------------------------------------------------------------

let box = null

function lightbox() {
  if (box) return box
  const dialog = el('dialog', 'lightbox')
  dialog.setAttribute('aria-label', 'Bildansicht')
  dialog.tabIndex = -1
  const stage = el('div', 'lightbox-stage')
  const img = el('img', 'lightbox-img')
  const prev = button('lightbox-nav lightbox-prev', 'Vorheriges Bild')
  const next = button('lightbox-nav lightbox-next', 'Nächstes Bild')
  prev.append(icon('prev'))
  next.append(icon('next'))
  stage.append(prev, img, next)

  const bar = el('div', 'lightbox-bar')
  const name = el('span', 'lightbox-name')
  const count = el('span', 'lightbox-count')
  const open = el('a', 'lightbox-open')
  open.target = '_blank'
  open.rel = 'noopener'
  open.setAttribute('aria-label', 'Original in neuem Tab öffnen')
  open.append(icon('external'))
  const close = button('lightbox-close', 'Schließen')
  close.append(icon('close'))
  bar.append(name, count, open, close)
  dialog.append(stage, bar)
  document.body.append(dialog)

  box = { dialog, items: [], index: 0 }
  const show = i => {
    const n = box.items.length
    box.index = (i + n) % n
    const item = box.items[box.index]
    img.src = item.url
    img.alt = item.name
    name.textContent = item.name
    count.textContent = n > 1 ? `${box.index + 1} / ${n}` : ''
    count.hidden = n < 2
    prev.hidden = next.hidden = n < 2
    open.href = item.url
  }
  box.show = show
  prev.addEventListener('click', () => show(box.index - 1))
  next.addEventListener('click', () => show(box.index + 1))
  close.addEventListener('click', () => dialog.close())
  // A click on the dimmed area closes; clicks on the image or controls do not.
  dialog.addEventListener('click', e => { if (e.target === dialog || e.target === stage) dialog.close() })
  dialog.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft') show(box.index - 1)
    if (e.key === 'ArrowRight') show(box.index + 1)
  })
  let downX = null
  stage.addEventListener('pointerdown', e => { downX = e.clientX })
  stage.addEventListener('pointerup', e => {
    if (downX == null || box.items.length < 2) return
    const dx = e.clientX - downX
    downX = null
    if (Math.abs(dx) > 48) show(box.index + (dx < 0 ? 1 : -1))
  })
  return box
}

/** Open the image viewer on items[index]; items are Attachments. */
export function openLightbox(items, index = 0) {
  const b = lightbox()
  b.items = items
  b.show(index)
  if (!b.dialog.open) {
    b.dialog.showModal()
    b.dialog.focus()   // keyboard starts at the dialog, not on a random control
  }
}

// ---- attachments -----------------------------------------------------------

/** Image attachments as a grid of thumbnails, other files as chips. */
export function attachmentNodes(list = []) {
  const images = list.filter(a => kindOf(a) === 'image')
  const files = list.filter(a => kindOf(a) === 'file')
  const nodes = mediaNodes(list)
  if (images.length) {
    const grid = el('div', images.length === 1 ? 'shots shots-one' : 'shots')
    images.forEach((a, i) => {
      const btn = button('shot', `${a.name} vergrößern`)
      const img = el('img')
      img.src = a.url
      img.alt = a.name
      img.loading = 'lazy'
      img.decoding = 'async'
      img.addEventListener('error', () => btn.classList.add('shot-broken'))
      btn.append(img)
      btn.addEventListener('click', () => openLightbox(images, i))
      grid.append(btn)
    })
    nodes.push(grid)
  }
  if (files.length) {
    const row = el('div', 'files')
    for (const a of files) {
      const link = el('a', 'file-chip')
      link.href = a.url
      link.target = '_blank'
      link.rel = 'noopener'
      link.append(icon('file'), el('span', null, a.name))
      row.append(link)
    }
    nodes.push(row)
  }
  return nodes
}

// ---- code blocks -----------------------------------------------------------

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Clipboard API needs a secure context; the board is often opened over plain http on the LAN.
    const area = el('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.className = 'offscreen'
    document.body.append(area)
    area.select()
    let ok = false
    try { ok = document.execCommand('copy') } catch {}
    area.remove()
    return ok
  }
}

/** rich() with code blocks dressed up: a header with the language and a copy button. */
export function richPlus(source) {
  const root = rich(source)
  const langs = [...String(source).matchAll(/```([^\n]*)\n?/g)].filter((_, i) => i % 2 === 0).map(m => m[1].trim())
  root.querySelectorAll('pre').forEach((pre, i) => {
    const wrap = el('div', 'code')
    const head = el('div', 'code-head')
    const copy = button('code-copy')
    const label = el('span', null, 'Kopieren')
    copy.append(icon('copy'), label)
    let timer
    copy.addEventListener('click', async () => {
      const ok = await copyText(pre.textContent)
      copy.replaceChildren(icon(ok ? 'check' : 'warn'), el('span', null, ok ? 'Kopiert' : 'Nicht kopiert'))
      copy.classList.toggle('is-done', ok)
      clearTimeout(timer)
      timer = setTimeout(() => {
        copy.replaceChildren(icon('copy'), el('span', null, 'Kopieren'))
        copy.classList.remove('is-done')
      }, 1800)
    })
    head.append(el('span', 'code-lang', langs[i] || 'Code'), copy)
    pre.replaceWith(wrap)
    wrap.append(head, pre)
  })
  return root
}

// ---- messages --------------------------------------------------------------

const EVENT_LABEL = { asked: 'Neue Frage', decided: 'Entschieden', done: 'Erledigt', urgency: 'Dringlichkeit', reopened: 'Zurückgenommen' }
const GROUP_GAP = 5 * 60000
const WORKING_WINDOW = 10 * 60000

const dayKey = ts => new Date(ts).toDateString()
function dayLabel(ts) {
  const today = new Date()
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (dayKey(ts) === today.toDateString()) return 'Heute'
  if (dayKey(ts) === yesterday.toDateString()) return 'Gestern'
  return new Date(ts).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' })
}
const fullTime = ts => new Date(ts).toLocaleString('de-DE', { dateStyle: 'full', timeStyle: 'short' })

function timeNode(ts, cls) {
  const t = el('time', cls, clock(ts))
  t.dateTime = new Date(ts).toISOString()
  t.title = fullTime(ts)
  return t
}

function agentMark() {
  const mark = el('span', 'agent-mark')
  mark.append(icon('spark'))
  return mark
}

// A drawing the human sent: tapping it puts the canvas back on the scribble board.
let openScribble = null
function scribbleCard(a) {
  const card = button('scribble-card', 'Scribble wieder öffnen')
  const img = el('img')
  img.src = a.url
  img.alt = 'Scribble'
  img.loading = 'lazy'
  const label = el('span', null, 'Scribble öffnen')
  label.append(el('code', null, a.id))
  card.append(img, label)
  card.addEventListener('click', () => openScribble?.(a.id))
  return card
}

// A question the agent asked stays answerable right where it was asked: while
// its card is open the marker is a small card with the options, afterwards it
// shrinks back to one line. asks holds those live nodes so render() can repaint them.
const asks = new Map()   // message id -> { node, m, onCard, sig }

function paintAsk(entry, card) {
  const sig = card ? `${card.status}|${card.choice}|${card.urgency}|${card.urgency_reason}` : 'gone'
  if (entry.sig === sig) return
  entry.sig = sig
  const { node, m, onCard } = entry
  if (card?.status !== 'open' || card.kind !== 'decision') {
    node.className = 'ask'
    return node.replaceChildren(eventLine(m, false, card, onCard))
  }
  node.className = 'ask ask-open'
  node.dataset.urgency = card.urgency
  const head = el('header', 'ask-head')
  head.append(el('span', 'ask-tab', `Nr. ${card.number} · ${URGENCY_LABEL[card.urgency] ?? ''}`))
  const more = button('ask-more')
  more.append('Ganze Karte')
  more.addEventListener('click', () => onCard?.(card.id))
  head.append(more)
  const error = el('p', 'ask-error')
  error.hidden = true
  const options = el('div', 'ask-options')
  for (const o of card.options) {
    const b = button('ask-option')
    b.append(el('strong', null, o.label))
    if (o.detail) b.append(el('span', null, o.detail))
    // One tap decides, as on the stack; undo lives in the history.
    b.addEventListener('click', async () => {
      for (const other of options.children) other.disabled = true
      try {
        await decide(card.id, o.key)
      } catch (err) {
        for (const other of options.children) other.disabled = false
        error.textContent = `Nicht übernommen: ${err.message}`
        error.hidden = false
      }
    })
    options.append(b)
  }
  node.replaceChildren(head, el('h3', 'ask-title', card.title))
  if (card.urgency_reason) node.append(el('p', 'ask-reason', card.urgency_reason))
  node.append(options, error)
}

function eventLine(m, cont, card, onCard) {
  const node = button(`event event-${m.kind}${cont ? ' cont' : ''}`)
  const ico = el('span', 'event-ico')
  ico.append(icon(ICONS[m.kind] ? m.kind : 'asked'))
  const body = el('span', 'event-body')
  body.append(el('span', 'event-kind', EVENT_LABEL[m.kind] ?? 'Board'))
  if (card?.number != null) body.append(el('span', 'event-nr', `Nr. ${card.number}`))
  body.append(el('span', 'event-text', m.text))
  node.append(ico, body, timeNode(m.ts, 'event-time'))
  node.addEventListener('click', () => onCard?.(m.card_id))
  return node
}

function messageNode(m, cont, cards, onCard) {
  if (m.from === 'event' && m.kind === 'asked') {
    const entry = { node: el('div', 'ask'), m, onCard, sig: null }
    asks.set(m.id, entry)
    paintAsk(entry, cards.find(c => c.id === m.card_id))
    return entry.node
  }
  if (m.from === 'event') return eventLine(m, cont, cards.find(c => c.id === m.card_id), onCard)
  const node = el('article', `msg msg-${m.from === 'user' ? 'user' : 'agent'}${cont ? ' cont' : ''}`)
  if (m.from === 'user') {
    for (const a of (m.attachments ?? []).filter(a => a.kind === 'scribble')) node.append(scribbleCard(a))
    if (m.text) {
      const bubble = el('div', 'bubble')
      bubble.append(el('p', null, m.text))
      node.append(bubble)
    }
    node.append(timeNode(m.ts, 'msg-time'))
    return node
  }
  if (!cont) {
    const head = el('header', 'msg-head')
    head.append(agentMark(), el('span', 'msg-name', 'Agent'), timeNode(m.ts, 'msg-time'))
    node.append(head)
  } else {
    node.title = fullTime(m.ts)
  }
  const body = richPlus(m.text ?? '')
  body.append(...attachmentNodes(m.attachments))
  node.append(body)
  // What the agent chose to show of its reasoning or evidence, closed until asked for.
  if (m.details) {
    const more = el('details', 'msg-details')
    more.append(el('summary', null, 'Details'), richPlus(m.details))
    node.append(more)
  }
  return node
}

function emptyNode(onPick) {
  const node = el('div', 'empty-chat')
  const mark = agentMark()
  mark.classList.add('agent-mark-lg')
  const picks = el('div', 'empty-picks')
  for (const text of ['Wo stehen wir gerade?', 'Was brauchst du von mir?', 'Fass zusammen, was du zuletzt getan hast.']) {
    const b = button('empty-pick')
    b.textContent = text
    b.addEventListener('click', () => onPick(text))
    picks.append(b)
  }
  node.append(
    mark,
    el('h2', null, 'Womit soll der Agent anfangen?'),
    el('p', null, 'Schreib ihm, woran er arbeiten soll. Wenn er etwas von dir wissen muss, legt er dir eine Karte auf den Stapel.'),
    picks,
  )
  return node
}

// ---- mount -----------------------------------------------------------------

/**
 * Wire up the conversation inside #chat.
 *   onCard(cardId)   the user tapped a card event
 *   onScribble()     the user tapped a scribble they sent earlier
 *   onUnread(count)  messages arrived that the user has not seen yet
 * Returns { render(state, loaded), unread() }.
 */
export function mountChat({ onCard, onScribble, onUnread, flags = new Set() } = {}) {
  openScribble = onScribble
  const $ = id => document.getElementById(id)
  const log = $('log')
  const inner = $('log-inner')
  const jump = $('jump')
  const jumpText = $('jump-text')
  const form = $('composer')
  const draft = $('draft')
  const send = $('send')
  const error = $('send-error')
  const fine = matchMedia('(pointer: fine)')

  const working = el('div', 'working')
  working.hidden = true
  const dots = el('span', 'dots')
  dots.append(el('i'), el('i'), el('i'))
  working.append(agentMark(), el('span', null, 'Agent arbeitet'), dots)

  let order = []            // message ids in the log, in order
  let lastMsg = null        // last rendered message, for grouping and day breaks
  let messages = []
  let first = true          // nothing from the server rendered yet
  let pinned = true         // the user is at the end and wants to stay there
  let unread = 0
  let empty = null
  let scope = null          // the session whose conversation is in the log

  // ---- scrolling ----

  const visible = () => log.clientHeight > 0
  const atEnd = () => log.scrollHeight - log.scrollTop - log.clientHeight < 72
  const toEnd = smooth => log.scrollTo({ top: log.scrollHeight, behavior: smooth ? 'smooth' : 'instant' })

  function setUnread(n) {
    if (n === unread) return
    unread = n
    onUnread?.(unread)
  }
  function updateJump() {
    jump.hidden = pinned
    jump.classList.toggle('has-unread', unread > 0)
    jumpText.textContent = unread === 0 ? 'Zum Ende' : unread === 1 ? '1 neue Nachricht' : `${unread} neue Nachrichten`
  }
  function settle() {
    if (!visible()) return
    if (pinned) {
      toEnd(false)
      setUnread(0)
    }
    updateJump()
  }
  log.addEventListener('scroll', () => {
    if (!visible()) return
    pinned = atEnd()
    if (pinned) setUnread(0)
    updateJump()
  }, { passive: true })
  jump.addEventListener('click', () => {
    pinned = true
    setUnread(0)
    updateJump()
    toEnd(true)
  })
  // Images loading, the keyboard opening, the pane becoming visible: stay at the end if we were there.
  const ro = new ResizeObserver(settle)
  ro.observe(log)
  ro.observe(inner)

  // ---- rendering ----

  function refreshWorking() {
    const last = messages.findLast(m => m.from !== 'event')
    working.hidden = !(last?.from === 'user' && Date.now() - last.ts < WORKING_WINDOW)
  }
  function refreshDays() {
    for (const n of inner.querySelectorAll('.day')) n.firstChild.textContent = dayLabel(Number(n.dataset.day))
  }
  setInterval(() => { refreshWorking(); refreshDays() }, 30000)

  function append(m, cards, animate) {
    if (!lastMsg || dayKey(lastMsg.ts) !== dayKey(m.ts)) {
      const day = el('div', 'day')
      day.dataset.day = m.ts
      day.append(el('span', null, dayLabel(m.ts)))
      inner.insertBefore(day, working)
      lastMsg = null
    }
    const sameSide = lastMsg && lastMsg.from === m.from
    const cont = Boolean(sameSide && (m.from === 'event' || m.ts - lastMsg.ts < GROUP_GAP))
    const node = messageNode(m, cont, cards, onCard)
    node.dataset.id = m.id
    if (animate) node.classList.add('is-new')
    inner.insertBefore(node, working)
    order.push(m.id)
    lastMsg = m
  }

  function render(state, loaded) {
    if (!loaded) return
    messages = state.messages
    const grows = order.length <= messages.length && order.every((id, i) => messages[i].id === id)
    // Another session, or a log that was rewritten: start over at its end, with nothing unread.
    const restart = first || !grows || state.scope !== scope
    scope = state.scope
    if (restart) {
      inner.replaceChildren(working)
      asks.clear()
      order = []
      lastMsg = null
      empty = null
    }
    const fresh = messages.slice(order.length)
    const animate = !first && grows
    for (const m of fresh) append(m, state.cards, animate)
    for (const entry of asks.values()) paintAsk(entry, state.cards.find(c => c.id === entry.m.card_id))

    if (!messages.length && !empty) {
      empty = emptyNode(text => { draft.value = text; fit(); draft.focus() })
      inner.insertBefore(empty, working)
    } else if (messages.length && empty) {
      empty.remove()
      empty = null
    }
    refreshWorking()

    if (restart) {
      pinned = true
      setUnread(0)
    } else if (fresh.some(m => m.from === 'user')) {
      pinned = true   // your own message always brings you back to the end
    } else if (!pinned || !visible()) {
      setUnread(unread + fresh.filter(m => m.from !== 'user').length)
    }
    first = false
    settle()
  }

  // ---- composer ----

  let sending = false
  const DRAFT_KEY = 'agent-board-draft'
  const remember = () => { try { localStorage.setItem(DRAFT_KEY, draft.value) } catch {} }

  function fit() {
    draft.style.height = 'auto'
    const max = Math.max(120, Math.min(260, window.innerHeight * 0.36))
    draft.style.height = `${Math.min(draft.scrollHeight, max)}px`
    draft.style.overflowY = draft.scrollHeight > max ? 'auto' : 'hidden'
    send.disabled = sending || !draft.value.trim()
  }
  function showError(text) {
    error.replaceChildren(icon('warn'), el('span', null, text))
    error.hidden = false
  }

  try { draft.value = localStorage.getItem(DRAFT_KEY) ?? '' } catch {}
  draft.addEventListener('input', () => {
    error.hidden = true
    remember()
    fit()
  })
  window.addEventListener('resize', fit)
  // Fonts change the line height once they arrive.
  document.fonts?.ready.then(fit)
  fit()

  form.addEventListener('submit', async e => {
    e.preventDefault()
    const text = draft.value.trim()
    if (!text || sending) return
    sending = true
    form.classList.add('is-sending')
    error.hidden = true
    fit()
    try {
      await sendMessage(text)
      // Only clear what was sent; the user may already be typing the next message.
      if (draft.value.trim() === text) draft.value = ''
      remember()
      pinned = true
      settle()
    } catch (err) {
      const reason = err instanceof TypeError ? 'keine Verbindung zum Server' : err.message
      showError(`Nicht gesendet: ${reason}. Dein Text bleibt hier stehen.`)
    }
    sending = false
    form.classList.remove('is-sending')
    fit()
  })

  // Enter sends with a real keyboard; on touch screens it stays a line break.
  // Ctrl/Cmd+Enter sends everywhere. Never while an IME is composing.
  draft.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return
    if (fine.matches || e.ctrlKey || e.metaKey) {
      e.preventDefault()
      form.requestSubmit()
    }
  })
  // Tapping send must not take focus from the textarea, or the phone keyboard closes.
  send.addEventListener('mousedown', e => e.preventDefault())
  // The whole composer box is a target for the caret.
  form.addEventListener('click', e => { if (e.target === form) draft.focus() })

  if (fine.matches && !flags.has('decisions')) draft.focus({ preventScroll: true })

  // ---- states for screenshots ----
  if (flags.has('error')) showError('Nicht gesendet: keine Verbindung zum Server. Dein Text bleibt hier stehen.')
  const once = fn => { let done = false; return () => { if (!done && order.length) { done = true; fn() } } }
  const demo = []
  if (flags.has('scrolled')) demo.push(once(() => { log.scrollTop = 0; pinned = false; setUnread(2); updateJump() }))
  if (flags.has('lightbox')) demo.push(once(() => inner.querySelector('.shot')?.click()))

  return {
    render(state, loaded) {
      render(state, loaded)
      for (const fn of demo) fn()
    },
    unread: () => unread,
    focus: () => draft.focus({ preventScroll: true }),
  }
}
