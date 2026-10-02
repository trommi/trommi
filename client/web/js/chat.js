// The conversation: one pane per session (several side by side for a group), each with its
// message log with stable nodes, pinned scrolling and its own composer. The session's open
// questions stand in the log as rows where they were asked; two filters lay a list over the
// log instead: the questions only, or the files. Plus the pieces other modules share
// (icons, attachments, lightbox, code blocks).

import { sendMessage, reopen } from './store.js'
import { el, rich, clock, kindOf, mediaNodes, doodle, ASSET_LABEL, sizeText, refreshAssetLinks, linkInfo, sketch } from './ui.js'
import { questionRow, lineFit, mountInbox } from './inbox.js'
import { mountFiles } from './history.js'
import { dictationMic } from './speech.js'
import { pasteChip, cardChips } from './cardclip.js'
import { tellApart } from './agents.js'

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
  file: ['M7 3.500h7l4.500 4.500V19a1.500 1.500 0 0 1-1.500 1.500H7A1.500 1.500 0 0 1 5.500 19V5A1.500 1.500 0 0 1 7 3.500z', 'M13.500 3.500V8.500H18.500'],
  external: ['M14 5h5v5', 'M19 5l-8 8', 'M11 6.500H6.500A1.500 1.500 0 0 0 5 8v9.500A1.500 1.500 0 0 0 6.500 19H16a1.500 1.500 0 0 0 1.500-1.500V13'],
  spark: ['M12 3.500c.700 4.500 4 7.800 8.500 8.500-4.500.700-7.800 4-8.500 8.500-.700-4.500-4-7.800-8.500-8.500 4.500-.700 7.800-4 8.500-8.500z'],
  warn: ['M12 9v4.500', 'M12 16.800v.100', 'M10.300 4.500 2.900 17.500a2 2 0 0 0 1.700 3h14.800a2 2 0 0 0 1.700-3L13.700 4.500a2 2 0 0 0-3.400 0z'],
  pen: ['M4 20c2.500-1 3-3.500 4.500-5.500S12 11 13.500 12s-1 4 .500 5 3.500-2 6-2.500M15.500 4.500l4 4L11 17l-4.500.500L7 13z'],
  mic: ['M12 3.500a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0v-5a3 3 0 0 1 3-3z', 'M5.500 11.500a6.500 6.500 0 0 0 13 0M12 18v3'],
  send: ['M12 19V5M5.500 11.500 12 5l6.500 6.500'],
  down: ['M12 5v14M5.500 12.500 12 19l6.500-6.500'],
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
  dialog.setAttribute('aria-label', 'Picture')
  dialog.tabIndex = -1
  const stage = el('div', 'lightbox-stage')
  const img = el('img', 'lightbox-img')
  const prev = button('lightbox-nav lightbox-prev', 'Previous picture')
  const next = button('lightbox-nav lightbox-next', 'Next picture')
  prev.append(icon('prev'))
  next.append(icon('next'))
  stage.append(prev, img, next)

  const bar = el('div', 'lightbox-bar')
  const name = el('span', 'lightbox-name')
  const count = el('span', 'lightbox-count')
  const open = el('a', 'lightbox-open')
  open.target = '_blank'
  open.rel = 'noopener'
  open.setAttribute('aria-label', 'Open the original in a new tab')
  open.append(icon('external'))
  const close = button('lightbox-close', 'Close')
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
      const btn = button('shot', `Enlarge ${a.name}`)
      const img = el('img')
      img.src = a.url
      img.alt = a.name
      img.loading = 'lazy'
      img.decoding = 'async'
      img.addEventListener('error', () => btn.classList.add('shot-broken'))
      btn.append(img)
      btn.addEventListener('click', () => openLightbox(images, i))
      grid.append(btn)
      // A picture of a page that can be tried: the way to the page itself stands with it.
      if (a.page?.url) {
        const link = el('a', 'focus-page-link', 'Open the page')
        link.href = a.page.url
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        grid.append(link)
      }
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
  const langs = [...String(source).matchAll(/```([^\n]*)\n?/g)].filter((_, i) => i % 2 === 0).map(m => m[1].trim()).filter(lang => !/^html$/i.test(lang))   // an html block is a layout, not a code box
  root.querySelectorAll('pre').forEach((pre, i) => {
    const wrap = el('div', 'code')
    const head = el('div', 'code-head')
    const copy = button('code-copy')
    copy.append(icon('copy'), el('span', null, 'Copy'))
    let timer
    copy.addEventListener('click', async () => {
      const ok = await copyText(pre.textContent)
      copy.replaceChildren(icon(ok ? 'check' : 'warn'), el('span', null, ok ? 'Copied' : 'Not copied'))
      copy.classList.toggle('is-done', ok)
      clearTimeout(timer)
      timer = setTimeout(() => {
        copy.replaceChildren(icon('copy'), el('span', null, 'Copy'))
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

const EVENT_LABEL = { asked: 'New question', decided: 'Answered', done: 'Done', urgency: 'Urgency', reopened: 'Taken back', revised: 'Question revised', trusted: 'Trusted', snoozed: 'Snoozed', handed: 'With the agent', shredded: 'Shredded' }
const MAX_FILES = 12        // as the server takes them in one message
const MAX_BYTES = 88e6      // the server reads 96 MB of a message at most
const GROUP_GAP = 5 * 60000
const WORKING_WINDOW = 10 * 60000

const dayKey = ts => new Date(ts).toDateString()
function dayLabel(ts) {
  const today = new Date()
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (dayKey(ts) === today.toDateString()) return 'Today'
  if (dayKey(ts) === yesterday.toDateString()) return 'Yesterday'
  return new Date(ts).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
}
const fullTime = ts => new Date(ts).toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' })

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
function scribbleCard(a, onOpen) {
  const card = button('scribble-card', 'Scribble sent. Open the canvas of the session')
  const img = el('img')
  img.src = a.url
  img.alt = ''
  img.loading = 'lazy'
  // The picture can be gone (the server cleans up after a while); the card then stands without it.
  img.addEventListener('error', () => img.remove())
  card.append(img, el('span', null, 'Scribble'))
  card.addEventListener('click', onOpen)
  return card
}


// A page or file the session published under a link that opens without a login: what it is,
// and the two things to do with it. Once revoked or expired only its name is left, dashed.
function assetCard(asset, said = '') {
  const card = el('div', 'asset-card')
  const kind = el('span', 'caps', [ASSET_LABEL[asset.type] ?? 'File', !asset.gone && asset.size ? sizeText(asset.size) : ''].filter(Boolean).join(' · '))
  const text = el('div', 'asset-text')
  text.append(kind, el('strong', null, asset.title || 'Untitled'))
  card.append(text)
  if (asset.gone) {
    card.classList.add('is-gone')
    text.append(el('span', null, 'No longer available.'))
    return card
  }
  if (asset.note) text.append(el('span', null, asset.note))
  const open = el('a', 'asset-open', 'Open')
  // The message carries the link under the board's public address. On a plain http page (the board over
  // the LAN) a browser cannot decrypt, so the link goes there instead of staying on this address (linkInfo).
  const full = String(said).split(/\s+/).find(word => word.endsWith(asset.url) && word !== asset.url)
  const href = (full && linkInfo(full).asset?.href) || asset.url
  open.href = href
  open.target = '_blank'
  open.rel = 'noopener'
  const copy = button('asset-copy')
  copy.textContent = 'Copy link'
  let timer
  copy.addEventListener('click', async () => {
    // The link carries its key after the #; anyone who has it can open the page.
    const ok = await copyText(new URL(href, location.href).href)
    copy.textContent = ok ? 'Copied' : 'Not copied'
    clearTimeout(timer)
    timer = setTimeout(() => { copy.textContent = 'Copy link' }, 1800)
  })
  const actions = el('div', 'asset-actions')
  actions.append(open, copy)
  card.append(actions)
  return card
}

// One line for something that happened to a question. Unless the line's text is the question itself,
// the question is named first, briefly, and what happened to it follows: "Answered  <question> → Yes".
function eventLine(m, cont, onCard, card) {
  const node = button(`event event-${m.kind}${cont ? ' cont' : ''}`)
  const ico = el('span', 'event-ico')
  ico.append(icon(ICONS[m.kind] ? m.kind : 'asked'))
  const body = el('span', 'event-body')
  body.append(el('span', 'event-kind', EVENT_LABEL[m.kind] ?? 'Board'))
  if (card && (card.title !== m.text || !m.text)) body.append(el('span', 'event-about', card.title))
  if (m.text) body.append(el('span', 'event-text', m.text))
  node.append(ico, body, timeNode(m.ts, 'event-time'))
  node.addEventListener('click', () => onCard?.(m.card_id))
  return node
}

/** The labels of what was chosen on a card, joined by ", "; '' while there is no answer. */
function choiceLabel(card) {
  const keys = card.choices?.length ? card.choices : card.choice ? [card.choice] : []
  return keys.map(key => (card.options ?? []).find(o => o.key === key)?.label ?? key).join(', ')
}

// A question in a session's own stream that is not in front of the human right now: one quiet line where it
// was asked, saying what became of it. One that still waits (snoozed, with the agent) opens as its window;
// one that is over (answered, shredded, done) unfolds in place: what was asked, what was chosen, "Take back".
function askLine(m, card, state, { onOpen, onError }) {
  const over = card.status !== 'open'
  const [kind, text] = card.status === 'decided' ? [card.trusted ? 'trusted' : 'decided', choiceLabel(card) || (card.trusted ? 'your call' : '')]
    : card.status === 'shredded' ? ['shredded', '']
    : over ? ['done', card.summary ?? '']
    : state.handed.includes(card.id) ? ['handed', ''] : ['snoozed', '']
  // (The line is named after the question: a text that only repeats the title is left out.)
  const line = eventLine({ kind, text: text === card.title ? '' : text, ts: m.ts, card_id: card.id }, false, over ? () => unfold() : onOpen, { ...card, title: card.title || m.text })
  if (!over) return [line]
  let past = null
  line.setAttribute('aria-expanded', 'false')
  function unfold() {
    if (past) { past.remove(); past = null } else { past = pastCard(card, onError); line.after(past) }
    line.setAttribute('aria-expanded', String(Boolean(past)))
  }
  return [line]
}
// What an answered question was, read-only: its text, the options with the chosen ones marked, the note, the way back.
function pastCard(card, onError) {
  const box = el('div', 'ask-past')
  box.append(el('strong', null, card.title))
  if (card.body) box.append(richPlus(card.body))
  const chosen = card.choices?.length ? card.choices : card.choice ? [card.choice] : []
  if (card.options?.length) {
    const list = el('ul', 'ask-past-options')
    for (const o of card.options) {
      const item = el('li', chosen.includes(o.key) ? 'is-chosen' : null)
      if (chosen.includes(o.key)) item.append(icon('check'))
      item.append(el('span', null, o.label))
      list.append(item)
    }
    box.append(list)
  }
  if (card.note) box.append(el('p', 'ask-past-note', `Your note: ${card.note}`))
  const take = button('ask-past-take')
  take.textContent = card.status === 'decided' ? 'Take back' : 'Fetch back'
  take.addEventListener('click', async () => {
    take.disabled = true
    try { await reopen(card.id) } catch (err) { take.disabled = false; onError?.(`Not taken back: ${err.message}`) }
  })
  box.append(take)
  return box
}

// A message that belongs to a question (asked back about it, or the answer to that): say which one, and lead there on a tap.
function aboutNode(card, onCard) {
  const ref = button('msg-about')
  ref.append(el('span', 'caps', 'About'), el('span', null, card.title))
  ref.addEventListener('click', () => onCard?.(card.id))
  return ref
}

function emptyNode(onPick) {
  const node = el('div', 'empty-chat')
  const mark = agentMark()
  mark.classList.add('agent-mark-lg')
  const picks = el('div', 'empty-picks')
  for (const text of ['Where do we stand?', 'What do you need from me?', 'Sum up what you did last.']) {
    const b = button('empty-pick')
    b.textContent = text
    b.addEventListener('click', () => onPick(text))
    picks.append(b)
  }
  node.append(
    mark,
    el('h2', null, 'What should the agent start with?'),
    el('p', null, 'Tell it what to work on. When it needs something from you, it puts a question in front of you.'),
    picks,
  )
  return node
}

// ---- one session's pane ------------------------------------------------------

const filtered = () => Boolean(document.body.dataset.filter)

function createPane(agent, ctx) {
  const root = el('section', 'chat-pane')
  root.dataset.agent = agent
  // Who this column is, shown only when several stand side by side.
  const head = el('header', 'chat-pane-head')
  head.hidden = true
  const log = el('div', 'log')
  log.tabIndex = -1
  const inner = el('div', 'column log-inner')
  inner.setAttribute('role', 'log')
  inner.setAttribute('aria-live', 'polite')
  inner.setAttribute('aria-relevant', 'additions')
  log.append(inner)

  // The two lists a filter lays over the log.
  const listPane = (cls, ...roots) => {
    const pane = el('div', `pane-list ${cls}`)
    const column = el('div', 'column')
    column.append(...roots)
    pane.append(column)
    return pane
  }
  const cardsRoot = el('div', 'session-cards')
  const filesRoot = el('div', 'files-root')
  const questions = mountInbox(cardsRoot, { onOpen: ctx.onOpen, onDecided: ctx.onDecided, agent })
  const files = mountFiles(filesRoot, { agent })
  // The session's questions are the inbox's own list, scoped to this session: open rows, then the same piles.
  const questionsPane = listPane('pane-questions', cardsRoot)
  const filesPane = listPane('pane-files', filesRoot)
  const body = el('div', 'chat-body')
  body.append(log, questionsPane, filesPane)

  const jump = button('jump')
  const jumpText = el('span', null, 'To the end')
  jump.append(icon('down'), jumpText)
  jump.hidden = true
  // Open questions that stand in the stream but out of sight: how many, and the way to the next one.
  const openJump = button('open-jump')
  const openText = el('span')
  openJump.append(openText, icon('down'))
  openJump.hidden = true
  const error = el('p', 'send-error')
  error.setAttribute('role', 'alert')
  error.hidden = true
  const form = el('form', 'composer')
  const draft = el('textarea')
  draft.rows = 1
  draft.autocomplete = 'off'
  draft.enterKeyHint = 'enter'
  // What goes along with the words: pictures and files, by the clip, by paste, or dropped on the conversation.
  let attached = []   // [{ name, data }], data a data: URL, as the server takes them
  const chips = el('div', 'composer-files')
  const picker = el('input')
  picker.type = 'file'
  picker.multiple = true
  picker.hidden = true
  const clip = button('mic composer-clip', 'Attach a picture or a file (or paste it, or drop it on the conversation)')
  clip.title = 'Attach a picture or a file'
  clip.append(sketch('clip'))
  // speak instead of typing: the words appear in the draft while you talk (speech.js)
  const mic = dictationMic(draft, { key: `chat:${agent}`, onError: text => ctx.onError?.(text) })
  const send = el('button', 'send')
  send.type = 'submit'
  send.setAttribute('aria-label', 'Send')
  send.disabled = true
  send.append(icon('send'))
  form.append(chips, clip, draft, picker, mic, send)
  // A copied decision goes along as a chip (cardclip.js): offered above the field, or Ctrl+V.
  const clipped = pasteChip(draft, { host: form, onChange: () => fitDraft() })
  const hint = el('p', 'hint')
  hint.setAttribute('aria-hidden', 'true')
  hint.append(el('kbd', null, 'Enter'), ' sends, ', el('kbd', null, 'Shift'), ' + ', el('kbd', null, 'Enter'), ' for a new line')
  const dockColumn = el('div', 'column')
  dockColumn.append(error, form, hint)
  const dock = el('div', 'dock')
  dock.append(jump, openJump, dockColumn)
  root.append(head, body, dock)

  const fine = matchMedia('(pointer: fine)')
  const working = el('div', 'working')
  working.hidden = true
  const dots = el('span', 'dots')
  dots.append(el('i'), el('i'), el('i'))
  working.append(agentMark(), el('span', null, 'Agent is working'), dots)
  inner.append(working)

  let order = []            // message ids in the log, in order
  let lastMsg = null        // last rendered message, for grouping and day breaks
  let messages = []
  let first = true          // nothing from the server rendered yet
  let pinned = true         // the user is at the end and wants to stay there
  let unread = 0
  let empty = null
  let placeholder = 'Message to the agent'
  let headSig = ''
  let several = false       // this pane stands beside others (sessions laid together)

  // A question the agent asked stays answerable right where it was asked: while its card is
  // open the marker is the same row as in the inbox, afterwards it shrinks back to one line.
  const asks = new Map()   // message id -> { node, m, sig }
  const fit = lineFit()
  // A session on its own: ONE stream. Its question is the real, answerable row (the Desk's) right where it
  // was asked (.ask-card); answered, snoozed or with the agent it is one quiet line there. Sessions laid
  // together keep their combined list beside the conversations, and the log only points at it (.ask-open).
  function paintAsk(entry, state) {
    const card = state.all.cards.find(c => c.id === entry.m.card_id)
    const off = state.later.includes(card?.id)
    const sig = card ? JSON.stringify([card.status, card.choice, card.choices, card.trusted, card.summary, card.urgency, card.urgency_reason, card.title, card.body, card.options, card.recommended, card.multiple, card.attachments?.length, card.version, off, state.handed.includes(card.id), several]) : 'gone'
    if (entry.sig === sig) return
    entry.sig = sig
    const old = entry.node.querySelector('.inbox-question')
    if (old) fit.unobserve(old)
    if (!card) {
      entry.node.className = 'ask'
      return entry.node.replaceChildren(eventLine(entry.m, false, ctx.onCard, card))
    }
    if (!several) {
      if (card.status !== 'open' || off) {
        entry.node.className = 'ask'
        return entry.node.replaceChildren(...askLine(entry.m, card, state, ctx))
      }
      entry.node.className = 'ask ask-card'
      return entry.node.replaceChildren(questionRow(card, { onOpen: ctx.onOpen, onDecided: ctx.onDecided, fit }))
    }
    if (card.status !== 'open') {
      entry.node.className = 'ask'
      return entry.node.replaceChildren(eventLine(entry.m, false, ctx.onCard, card))
    }
    entry.node.className = 'ask ask-open'
    entry.node.replaceChildren(questionRow(card, { onOpen: ctx.onOpen, onDecided: ctx.onDecided, off, fit }))
  }

  // What a session published can be revoked or expire later: its card is repainted when the message changes.
  const published = new Map()   // message id -> { node, sig }
  function paintAsset(entry, m) {
    const sig = JSON.stringify(m.asset)
    if (entry.sig === sig) return
    entry.sig = sig
    entry.node.replaceChildren(assetCard(m.asset, m.text))
  }

  function messageNode(m, cont, state) {
    if (m.from === 'event' && m.kind === 'asked') {
      const entry = { node: el('div', 'ask'), m, sig: null }
      asks.set(m.id, entry)
      paintAsk(entry, state)
      return entry.node
    }
    const about = m.card_id && state.all.cards.find(c => c.id === m.card_id)
    if (m.from === 'event') {
      const line = eventLine(m, cont, ctx.onCard, about)
      // The answer already stands where the question was asked (a session on its own): no second line for it.
      if (m.kind === 'decided' && [...asks.values()].some(entry => entry.m.card_id === m.card_id)) line.classList.add('event-echo')
      return line
    }
    const node = el('article', `msg msg-${m.from === 'user' ? 'user' : 'agent'}${cont ? ' cont' : ''}`)
    if (m.from === 'user') {
      for (const a of (m.attachments ?? []).filter(a => a.kind === 'scribble')) node.append(scribbleCard(a, () => ctx.onScribble?.(agent)))
      // What the human sent along: pictures and files from the composer, and the picture of a selection on the pad.
      node.append(...attachmentNodes((m.attachments ?? []).filter(a => a.kind !== 'scribble')))
      if (about) node.append(aboutNode(about, ctx.onCard))
      if (m.cards?.length) node.append(cardChips(m.cards, (id, open) => (open ? ctx.onOpen : ctx.onCard)?.(id)))
      if (m.text) {
        const bubble = el('div', 'bubble')
        bubble.append(el('p', null, m.text))
        node.append(bubble)
      }
      node.append(timeNode(m.ts, 'msg-time'))
      return node
    }
    if (!cont) {
      const top = el('header', 'msg-head')
      top.append(agentMark(), el('span', 'msg-name', 'Agent'), timeNode(m.ts, 'msg-time'))
      node.append(top)
    } else {
      node.title = fullTime(m.ts)
    }
    if (about) node.append(aboutNode(about, ctx.onCard))
    // Something published under a link of its own stands as a card; the text only repeats it.
    if (m.asset) {
      const entry = { node: el('div', 'asset-slot'), sig: null }
      published.set(m.id, entry)
      paintAsset(entry, m)
      node.append(entry.node)
    } else {
      const text = richPlus(m.text ?? '')
      text.append(...attachmentNodes(m.attachments))
      node.append(text)
    }
    // What the agent chose to show of its reasoning or evidence, closed until asked for.
    if (m.details) {
      const more = el('details', 'msg-details')
      more.append(el('summary', null, 'Details'), richPlus(m.details))
      node.append(more)
    }
    return node
  }

  // ---- scrolling ----

  const visible = () => root.isConnected && log.clientHeight > 0 && !filtered()
  const atEnd = () => log.scrollHeight - log.scrollTop - log.clientHeight < 72
  const toEnd = smooth => log.scrollTo({ top: log.scrollHeight, behavior: smooth ? 'smooth' : 'instant' })

  function setUnread(n) {
    if (n === unread) return
    unread = n
    ctx.onUnread?.()
  }
  function updateJump() {
    jump.hidden = pinned
    jump.classList.toggle('has-unread', unread > 0)
    jumpText.textContent = unread === 0 ? 'To the end' : unread === 1 ? '1 new message' : `${unread} new messages`
  }
  // The open questions of the stream that are scrolled out of sight, and which of them comes next.
  let nextOpen = null
  function updateOpen() {
    const box = log.getBoundingClientRect()
    const away = several || !visible() ? [] : [...inner.querySelectorAll('.ask-card')].map(node => ({ node, r: node.getBoundingClientRect() }))
      .filter(({ r }) => r.bottom < box.top + 48 || r.top > box.bottom - 48)
    const below = away.find(({ r }) => r.top > box.top)
    nextOpen = (below ?? away.at(-1))?.node ?? null
    openJump.hidden = !nextOpen
    if (!nextOpen) return
    openJump.classList.toggle('is-up', !below)
    openText.textContent = `${away.length} open`
    openJump.setAttribute('aria-label', away.length === 1 ? 'One open question out of sight: go to it' : `${away.length} open questions out of sight: go to the next one`)
  }
  function settle() {
    if (!visible()) return
    if (pinned) {
      toEnd(false)
      setUnread(0)
    }
    updateJump()
    updateOpen()
  }
  log.addEventListener('scroll', () => {
    if (!visible()) return
    pinned = atEnd()
    if (pinned) setUnread(0)
    updateJump()
    updateOpen()
  }, { passive: true })
  const calm = matchMedia('(prefers-reduced-motion: reduce)')
  openJump.addEventListener('click', () => {
    if (!nextOpen) return
    pinned = false
    nextOpen.scrollIntoView({ block: 'center', behavior: calm.matches ? 'instant' : 'smooth' })
    nextOpen.querySelector('.inbox-row')?.focus({ preventScroll: true })
  })
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
  function tick() {
    refreshWorking()
    for (const n of inner.querySelectorAll('.day')) n.firstChild.textContent = dayLabel(Number(n.dataset.day))
  }

  function append(m, state, animate) {
    if (!lastMsg || dayKey(lastMsg.ts) !== dayKey(m.ts)) {
      const day = el('div', 'day')
      day.dataset.day = m.ts
      day.append(el('span', null, dayLabel(m.ts)))
      inner.insertBefore(day, working)
      lastMsg = null
    }
    const sameSide = lastMsg && lastMsg.from === m.from
    const cont = Boolean(sameSide && (m.from === 'event' || m.ts - lastMsg.ts < GROUP_GAP))
    const node = messageNode(m, cont, state)
    node.dataset.id = m.id
    if (animate) node.classList.add('is-new')
    inner.insertBefore(node, working)
    order.push(m.id)
    lastMsg = m
  }

  function render(state, beside) {
    several = beside
    root.classList.toggle('is-several', several)
    const me = state.all.agents.find(a => a.id === agent)
    // Columns of the same name carry what tells them apart, as in the sidebar.
    const apart = several ? tellApart(state.all.agents).get(agent) ?? '' : ''
    const sig = several && me ? JSON.stringify([me.name, me.mark, apart]) : ''
    if (sig !== headSig) {
      headSig = sig
      head.hidden = !sig
      if (sig) {
        const mark = el('span', 'chat-pane-mark')
        mark.append(doodle(me.mark ?? me.id))
        head.replaceChildren(mark, el('strong', null, me.name))
        if (apart) head.append(el('small', null, apart))
      }
      placeholder = sig ? `Message to ${me.name}` : 'Message to the agent'
      draft.placeholder = placeholder
      draft.setAttribute('aria-label', placeholder)
    }

    messages = state.all.messages.filter(m => m.agent === agent)
    const grows = order.length <= messages.length && order.every((id, i) => messages[i].id === id)
    // A log that was rewritten: start over at its end, with nothing unread.
    const restart = first || !grows
    if (restart) {
      inner.replaceChildren(working)
      asks.clear()
      published.clear()
      fit.disconnect()
      order = []
      lastMsg = null
      empty = null
    }
    const fresh = messages.slice(order.length)
    const animate = !first && grows
    for (const m of fresh) append(m, state, animate)
    for (const entry of asks.values()) paintAsk(entry, state)
    if (published.size) for (const m of messages) if (published.has(m.id) && m.asset) paintAsset(published.get(m.id), m)
    // A link to an asset inside a text is a card too; it is drawn again when the asset was withdrawn since.
    refreshAssetLinks(inner)

    if (!messages.length && !empty) {
      empty = emptyNode(text => { draft.value = text; fitDraft(); draft.focus() })
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

    questions.render(state)
    files.render(state, true)
  }

  // ---- composer ----

  let sending = false
  const DRAFT_KEY = `agent-board-draft:${agent}`
  const remember = () => { try { localStorage.setItem(DRAFT_KEY, draft.value) } catch {} }

  function fitDraft() {
    draft.style.height = 'auto'
    const max = Math.max(120, Math.min(260, window.innerHeight * 0.36))
    draft.style.height = `${Math.min(draft.scrollHeight, max)}px`
    draft.style.overflowY = draft.scrollHeight > max ? 'auto' : 'hidden'
    send.disabled = sending || (!draft.value.trim() && !attached.length && !clipped.ids())
  }
  function paintChips() {
    chips.replaceChildren(
      ...attached.map((a, i) => {
        const chip = button('composer-file', `${a.name}: take it off`)
        chip.title = `${a.name}: click to take it off`
        if (/^data:image\//.test(a.data)) {
          const thumb = el('img')
          thumb.src = a.data
          thumb.alt = ''
          chip.classList.add('has-thumb')
          chip.append(thumb)
        } else chip.append(sketch('page'))
        chip.append(el('span', null, a.name), el('em', null, '×'))
        chip.addEventListener('click', () => { attached.splice(i, 1); paintChips() })
        return chip
      }),
    )
    form.toggleAttribute('data-files', attached.length > 0)
    fitDraft()
  }
  const readFile = file => new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve({ name: file.name || `pasted-${Date.now()}.png`, data: reader.result })
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
  async function attach(list) {
    const got = [...list].filter(f => f instanceof File)
    if (!got.length) return
    error.hidden = true
    if (attached.length + got.length > MAX_FILES) return showError(`At most ${MAX_FILES} files in one message.`)
    // (A data: URL is a third longer than the file.)
    if ((attached.reduce((sum, a) => sum + a.data.length, 0) + got.reduce((sum, f) => sum + f.size * 4 / 3, 0)) > MAX_BYTES) return showError('Too large for one message: about 60 MB of files at most.')
    try { attached.push(...await Promise.all(got.map(readFile))) } catch { showError('That file could not be read.') }
    paintChips()
  }
  /** What a paste brings: files and pictures are attached; text stays text (a copied decision is cardclip.js's). True when the paste was taken. */
  function paste(e) {
    const data = e.clipboardData
    if (data?.files?.length) { e.preventDefault(); attach(data.files); return true }
    return false
  }
  function showError(text) {
    error.replaceChildren(icon('warn'), el('span', null, text))
    error.hidden = false
  }

  draft.placeholder = placeholder
  draft.setAttribute('aria-label', placeholder)
  try { draft.value = localStorage.getItem(DRAFT_KEY) ?? '' } catch {}
  draft.addEventListener('input', () => {
    error.hidden = true
    remember()
    fitDraft()
  })
  // The composer cannot measure itself while its pane is hidden; do it when it comes into view,
  // when the window changes, and when the fonts arrive (they change the line height).
  let formWidth = 0
  new ResizeObserver(() => {
    const w = form.clientWidth
    if (w && w !== formWidth) fitDraft()
    formWidth = w
  }).observe(form)
  document.fonts?.ready.then(fitDraft)
  // A hint in place of the usual placeholder, until the field is left or a message is sent.
  draft.addEventListener('blur', () => { draft.placeholder = placeholder })

  form.addEventListener('submit', async e => {
    e.preventDefault()
    const text = draft.value.trim()
    if ((!text && !attached.length && !clipped.ids()) || sending) return
    sending = true
    form.classList.add('is-sending')
    error.hidden = true
    fitDraft()
    try {
      const files = attached
      await sendMessage(text, agent, null, files, {}, clipped.ids())
      clipped.clear(true)
      // Only clear what was sent; the user may already be typing the next message.
      if (draft.value.trim() === text) draft.value = ''
      if (attached === files) { attached = []; paintChips() }
      draft.placeholder = placeholder
      remember()
      pinned = true
      settle()
    } catch (err) {
      const reason = err instanceof TypeError ? 'no connection to the server' : err.message
      showError(`Not sent: ${reason}. Your text stays here.`)
    }
    sending = false
    form.classList.remove('is-sending')
    fitDraft()
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
  clip.addEventListener('click', () => picker.click())
  picker.addEventListener('change', () => { attach(picker.files); picker.value = '' })
  draft.addEventListener('paste', paste)
  // A file dropped anywhere on the conversation goes into the message (and never replaces the page).
  const carriesFiles = e => [...(e.dataTransfer?.types ?? [])].includes('Files')
  root.addEventListener('dragover', e => { if (carriesFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; form.classList.add('is-drop') } })
  root.addEventListener('dragleave', e => { if (!root.contains(e.relatedTarget)) form.classList.remove('is-drop') })
  root.addEventListener('drop', e => {
    form.classList.remove('is-drop')
    if (!carriesFiles(e)) return
    e.preventDefault()
    attach(e.dataTransfer.files)
    draft.focus({ preventScroll: true })
  })
  paintChips()

  return {
    root, render, tick, settle, showError, paste,
    unread: () => unread,
    /** Shown again after another session was: at its end, with nothing unread. */
    attached() { pinned = true; setUnread(0); requestAnimationFrame(() => { fitDraft(); settle() }) },
    focus(text) {
      draft.focus({ preventScroll: true })
      if (text) draft.placeholder = text
    },
    /** Bring one card into view in the list of questions: its open row, or its line among the answered. */
    reveal(cardId) {
      // In the stream of a session on its own the card stands where it was asked.
      const asked = !several && !filtered() && [...asks.values()].find(entry => entry.m.card_id === cardId)?.node
      if (asked) {
        pinned = false
        asked.scrollIntoView({ block: 'center', behavior: 'smooth' })
        asked.firstElementChild?.animate([{ outline: '3px solid var(--accent)' }, { outline: '3px solid transparent' }], { duration: 1400 })
        return true
      }
      const row = cardsRoot.querySelector(`[data-id="${CSS.escape(cardId)}"]`)
      if (!row) return questions.reveal(cardId)
      row.scrollIntoView({ block: 'center', behavior: 'smooth' })
      row.animate([{ outline: '3px solid var(--accent)' }, { outline: '3px solid transparent' }], { duration: 1400 })
      return true
    },
    // states for screenshots
    stage(name) {
      if (name === 'scrolled') { log.scrollTop = 0; pinned = false; setUnread(2); updateJump() }
      if (name === 'lightbox') inner.querySelector('.shot')?.click()
    },
    count: () => order.length,
  }
}

// ---- mount -----------------------------------------------------------------

/**
 * The conversation of whatever is in scope, inside root: one pane for a session, one per member for a group.
 *   onOpen(cardId)            open a question as a window of its own
 *   onDecided(card, option)   a question was answered in a row
 *   onCard(cardId)            the user tapped the line of a card that is no longer open
 *   onScribble(agentId)       the user wants that session's canvas
 *   onUnread()                the number of unseen messages changed
 *   onError(text)             something went wrong that is worth a notice
 * Returns { render(state, loaded), unread(), focus(hint, agentId), reveal(cardId), setMember(agentId), settle() }.
 */
export function mountChat(root, ctx = {}) {
  const flags = ctx.flags ?? new Set()
  const panes = new Map()   // session id -> pane; kept, so a session's log is built once
  let shown = []
  let member = null
  setInterval(() => { for (const id of shown) panes.get(id)?.tick() }, 30000)
  window.addEventListener('resize', () => { for (const id of shown) panes.get(id)?.settle() })

  const once = (name, fn) => { let done = !flags.has(name); return () => { if (!done && panes.get(shown[0])?.count()) { done = true; fn() } } }
  const demo = [
    once('error', () => panes.get(shown[0]).showError('Not sent: no connection to the server. Your text stays here.')),
    once('scrolled', () => panes.get(shown[0]).stage('scrolled')),
    once('lightbox', () => panes.get(shown[0]).stage('lightbox')),
  ]

  function paintMember() {
    for (const [id, pane] of panes) pane.root.classList.toggle('is-member', id === member)
  }
  // Ctrl+V with the caret in no field: what the clipboard holds goes into the composer of the conversation in sight.
  window.addEventListener('paste', e => {
    if (e.defaultPrevented || e.target?.closest?.('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]')) return
    const pane = panes.get(shown.includes(member) ? member : shown[0])
    if (!pane || !pane.root.offsetParent || pane.root.closest('[inert]') || document.body.dataset.filter) return
    if (pane.paste(e)) pane.focus()
  })

  return {
    render(state, loaded) {
      if (!loaded) return
      const ids = state.members
      if (ids.length !== shown.length || ids.some((id, i) => id !== shown[i])) {
        for (const id of ids) if (!panes.has(id)) panes.set(id, createPane(id, ctx))
        root.replaceChildren(...ids.map(id => panes.get(id).root))
        root.dataset.cols = ids.length
        shown = ids
        paintMember()
        for (const id of ids) panes.get(id).attached()
        // With a real keyboard the caret waits in the composer.
        if (ids.length === 1 && matchMedia('(pointer: fine)').matches && !flags.has('decisions') && !document.body.dataset.filter) panes.get(ids[0]).focus()
      }
      // A session that is gone takes its pane along.
      for (const id of panes.keys()) if (!shown.includes(id) && !state.all.agents.some(a => a.id === id)) panes.delete(id)
      for (const id of shown) panes.get(id).render(state, shown.length > 1)
      for (const fn of demo) fn()
    },
    unread: () => shown.reduce((sum, id) => sum + panes.get(id).unread(), 0),
    /** Put the caret in a composer; hint, if given, stands in the empty field as what to write. */
    focus(hint, agentId) { panes.get(agentId ?? (shown.includes(member) ? member : shown[0]))?.focus(hint) },
    reveal(cardId, agentId) { return panes.get(agentId)?.reveal(cardId) ?? false },
    /** Which member of a group a phone shows, and the canvas belongs to. */
    setMember(agentId) { member = agentId; paintMember() },
    settle() { for (const id of shown) panes.get(id).settle() },
  }
}
