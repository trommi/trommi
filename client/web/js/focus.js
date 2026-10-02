// Focus: a full-page window with one question, its row in the list grown large.
// The same card: the corner tab only when it is blocking or urgent, the heavy
// title, and the same answer tiles at the right edge in the same order (thumb
// down left, thumb up right; more options as a column). What the row cannot
// hold has room here: the whole text, code, pictures, video, a note, and a
// question back to the agent with its replies. On a phone the tiles stand at
// the bottom.
//
// Opened without a card ("Go through them", "Focus") it is the walk through
// every open question. It does not wait: a tap answers, the next card stands
// in the same place at once, and the request travels behind it; "Undo" takes
// the last answer back, a failed one brings its card back with the reason.
// What was put off with "Later" comes last.
// Opened on one card (a row, or a link to a card) it is the window of that
// card alone: no back and next, and it closes on the answer, so the human is
// back at the place in the list they came from. onDecided(card, option, keys)
// then lets the list offer to take the answer back.
//
// Keys: y / n or → / ← answer a two-option card, digits pick an option (on a
// card with `multiple` they toggle, Enter sends), l puts the card off, u takes
// the last answer back, j / k or Shift+arrows go to the next / previous card
// without answering, Escape closes.
//
// Every open card keeps one DOM node for as long as it is open and the window
// is up. Cards that are not in front stay laid out but invisible, so a state
// push that does not change a card never touches its node: a typed note, the
// scroll position, and a running video survive both pushes and navigation.

import { subscribe, decide, reopen, putOff, sendMessage, isLoaded, getState } from './store.js'
import { readCard, stopReading, dictationMic, stopDictation } from './speech.js'
import { provide } from './keys.js'
import { say, pageHost, backNow, forgetBack } from './back.js'
import { EXPLAIN_TEXT } from './inbox.js'
import { richPlus, attachmentNodes } from './chat.js'
import { loopPath, penSeed } from './ui.js'
import { el, rich, ago, agoNode, kindOf, mediaNodes, sketch, doodle, adviceLoop, cardNote } from './ui.js'

const RANK = { low: 0, normal: 1, high: 2, critical: 3 }
const LOCAL_DECIDED_TTL = 20000  // hide a card answered here until the server confirms, at most this long
const INFO_MS = 6000
const OUT_MS = 320   // as long as the motion of a card that leaves (back.css)

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const wait = ms => new Promise(r => setTimeout(r, ms))

const SVG_NS = 'http://www.w3.org/2000/svg'
const ICON = {
  left: 'M19 12H5M11 6l-6 6 6 6',
  right: 'M5 12h14M13 6l6 6-6 6',
  chevLeft: 'M15 5l-7 7 7 7',
  chevRight: 'M9 5l7 7-7 7',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  up: 'M12 19V5M5.5 11.5L12 5l6.5 6.5',
  close: 'M6 6l12 12M18 6L6 18',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
  zoom: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4M11 8v6M8 11h6',
  undo: 'M4 9h10a5 5 0 0 1 0 10H9M4 9l4-4M4 9l4 4',
  shield: 'M12 3l7 3v5c0 4.500-3 8.200-7 10-4-1.800-7-5.500-7-10V6z',
}
// Which of two answers is the "no" (thumb down), and which pairs need no words at all.
// The same tests as on the row. Agents write in the human's language, so English and German count.
const NEGATIVE = /^(no\b|not\b|don't|do not|never|later|deny|decline|reject|skip|keep|leave|cancel|only |stay|nein|nicht|noch nicht|später|ablehnen|lassen|weglassen|behalten|nur |abbrechen|bei .* bleiben)/i
const BARE = /^(yes|no|ok|okay|ja|nein)$/i
function icon(name, cls = 'focus-icon') {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('class', cls)
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', ICON[name])
  svg.append(path)
  return svg
}
function button(cls, label) {
  const b = el('button', cls)
  b.type = 'button'
  if (label) b.setAttribute('aria-label', label)
  return b
}

/** Permission bodies are "description\n\n{json tool input}". */
function parsePermission(body) {
  const text = String(body ?? '')
  let desc = text.trim(), raw = ''
  const at = text.search(/(^|\n\s*\n)\s*[{[]/)
  if (at >= 0) { desc = text.slice(0, at).trim(); raw = text.slice(at).trim() }
  let rows = null
  try {
    const value = JSON.parse(raw)
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      rows = Object.entries(value).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v, null, 2)])
    }
  } catch {}
  return { desc, raw, rows }
}

// Options as tags: from this many options on, when no label is longer than this. Above TAGS_WIDE_FROM
// the answer column takes more of the window, so that forty of them stand on one screen.
const TAGS_FROM = 7
const TAG_CHARS = 18
const TAGS_WIDE_FROM = 16
const touchOnly = matchMedia('(pointer: coarse)')

/** Which picture belongs to which option: a Map of option key -> index in images, or null when that is
 *  not plain to see. It is plain when every picture names exactly one option in its file name (the key or
 *  the label as a word of it: design-a.png and the key "a", desk.png and the label "Desk"), or when there
 *  are as many pictures as options, three or more: then in their order. Nothing is guessed when the
 *  counts differ and the names do not tell. */
function pairPictures(options, images) {
  if (images.length < 2 || options.length < 2) return null
  const slug = text => String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const byName = new Map()
  const taken = new Set()
  let named = true
  images.forEach((img, i) => {
    const name = `-${slug(String(img.name ?? '').replace(/\.[a-z0-9]+$/i, ''))}-`
    const hits = options.filter(o => [slug(o.key), slug(o.label)].some(w => w && name.includes(`-${w}-`)))
    // the longest word wins where one option's word is part of another's ("s1" and "s11")
    const best = hits.sort((x, y) => slug(y.key).length - slug(x.key).length)[0]
    if (!best || (hits.length > 1 && slug(hits[1].key).length === slug(best.key).length) || taken.has(best.key)) { named = false; return }
    taken.add(best.key)
    byName.set(best.key, i)
  })
  if (named) return byName
  if (images.length === options.length && options.length >= 3) return new Map(options.map((o, i) => [o.key, i]))
  return null
}

/** Several answers at once (a card with `multiple`): the same request as decide(), with keys. */
async function decideMany(cardId, keys, note, revised = null) {
  const res = await fetch('/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ card_id: cardId, keys, note, revised }) })
  let out = {}
  try { out = await res.json() } catch {}
  if (!res.ok) throw new Error(out.error || res.statusText)
  return out
}

export function mountFocus({ onDecided } = {}) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)')
  const still = () => reduced.matches

  // ── skeleton ────────────────────────────────────────────────────────────
  const root = el('div', 'focus')
  root.hidden = true

  const backdrop = el('div', 'focus-backdrop')

  const sheet = el('section', 'focus-sheet')
  sheet.setAttribute('role', 'dialog')
  sheet.setAttribute('aria-modal', 'true')
  sheet.setAttribute('aria-label', 'Focus: open questions')
  sheet.tabIndex = -1
  sheet.dataset.state = 'loading'

  // Top bar, as the head of the row: the corner tab only when the question is blocking
  // or urgent, with who asks in it ("API · Blocking"); otherwise just the session's mark
  // and name, and a scribbled hourglass on one that can wait. Then the age, which is the
  // first to go when the bar gets tight (it wraps out of the one-line meta row).
  const top = el('header', 'focus-top')
  const meta = el('div', 'focus-meta')
  const tab = el('span', 'focus-tab')
  const from = el('span', 'focus-from')
  const agoSlot = agoNode(Date.now(), 'focus-ago')
  meta.append(tab, from, agoSlot)
  const notes = el('div', 'focus-notes')
  const hintBtn = button('focus-hint')
  hintBtn.hidden = true
  // What just happened to the question that left, and "Back" (back.js): a note at the window's top left.
  const says = el('div', 'says-host focus-says')
  const infoNode = el('p', 'focus-info')
  infoNode.hidden = true
  notes.append(hintBtn, infoNode)
  // Later: always in the same place, on every card. The question goes to the end of the line.
  const laterBtn = button('focus-later', 'Later: put this question off')
  laterBtn.title = 'Later (L)'
  laterBtn.append(sketch('later'), el('span', null, 'Later'))
  // Explain: one tap asks the session to say more about the question; beside Later, as quiet as it.
  const explainBtn = button('focus-later focus-explain', 'Explain: ask the session to explain this question')
  explainBtn.title = 'Explain (E)'
  const askMark = document.createElementNS(SVG_NS, 'svg')
  askMark.setAttribute('viewBox', '0 0 24 24')
  askMark.setAttribute('class', 'sketch')
  askMark.setAttribute('aria-hidden', 'true')
  for (const d of ['M8.200 8.600c.300-2.500 2-3.900 4.200-3.800 2.300.100 3.900 1.600 3.700 3.700-.200 2.300-2.600 2.800-3.500 4.300-.400.700-.400 1.300-.400 2.100', 'M12.150 18.700c.050.100.050.200 0 .300']) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    askMark.append(path)
  }
  explainBtn.append(askMark, el('span', null, 'Explain'))
  const closeBtn = button('focus-round focus-close', 'Close')
  closeBtn.title = 'Close (Esc)'
  closeBtn.append(icon('close'))
  // Read aloud: a switch beside the close button, shown only when the server can speak.
  // Off: a plain speaker. On: filled, with sound waves, and every question is read as it
  // comes up; the waves pulse while the audio loads and move while it plays. The choice
  // is remembered.
  const sayBtn = button('focus-round focus-say', 'Read questions aloud')
  const speaker = document.createElementNS(SVG_NS, 'svg')
  speaker.setAttribute('viewBox', '0 0 24 24')
  speaker.setAttribute('class', 'focus-icon')
  speaker.setAttribute('aria-hidden', 'true')
  for (const d of ['M4 9.500h3l4.500-3.800v12.600L7 14.500H4z', 'M15 9.200a4 4 0 0 1 0 5.600', 'M17.800 6.400a8 8 0 0 1 0 11.200']) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    speaker.append(path)
  }
  sayBtn.append(speaker)
  let autoRead = false
  try { autoRead = localStorage.getItem('trommi-focus-read') === '1' } catch {}
  let spoken = null
  const paintSay = () => {
    sayBtn.hidden = !getState().speech
    sayBtn.setAttribute('aria-pressed', String(autoRead))
    sayBtn.title = autoRead ? 'Reading aloud is on: every question is read to you' : 'Read questions aloud'
  }
  function voice() {
    paintSay()
    if (!autoRead || !isOpen || !getState().speech) return
    if (!current) return stopReading()
    if (current === spoken) return
    spoken = current
    readCard(current, sayBtn)
  }
  sayBtn.addEventListener('click', () => {
    autoRead = !autoRead
    try { localStorage.setItem('trommi-focus-read', autoRead ? '1' : '0') } catch {}
    spoken = null
    if (autoRead) voice()
    else { stopReading(); paintSay() }
  })
  // Explain and Later are not up here: they stand with the composer of the card in front (paintChrome puts them there).
  top.append(meta, notes, sayBtn, closeBtn)

  const stage = el('div', 'focus-stage')

  const done = el('div', 'focus-done')
  const doneArt = el('div', 'focus-done-art')
  doneArt.append(el('i'), el('i'), icon('check'))
  const doneText = el('p', 'focus-done-text')
  const doneBtn = button('focus-done-btn')
  doneBtn.textContent = 'Close'
  done.append(doneArt, el('h2', 'focus-done-title', 'All answered'), doneText, doneBtn)

  const loading = el('div', 'focus-loading')
  loading.append(el('span', 'focus-spinner'), el('span', null, 'Loading questions'))

  // Back and next stand beside the sheet. On a phone there is no beside: there
  // the foot is an empty row at the bottom that the two arrows stand in.
  const foot = el('footer', 'focus-foot')
  const prevBtn = button('focus-nav focus-nav-prev', 'Previous question')
  prevBtn.title = 'Previous question (K)'
  prevBtn.append(icon('left'))
  const nextBtn = button('focus-nav focus-nav-next', 'Next question')
  nextBtn.title = 'Next question, without answering (J)'
  nextBtn.append(icon('right'))

  const live = el('div', 'focus-sr')
  live.setAttribute('aria-live', 'polite')
  live.setAttribute('role', 'status')

  sheet.append(top, stage, done, loading, foot, live, says)
  root.append(backdrop, sheet, prevBtn, nextBtn)
  document.body.append(root)

  // ── model ───────────────────────────────────────────────────────────────
  const recs = new Map()          // id -> rec, for open cards
  const decidedLocal = new Map()  // id -> time we answered it here
  const inflight = new Map()      // id -> the answer's request, while it travels
  const asked = new Map()         // id -> what was asked back from here: [{ text, ts, state, error }]
  let lastState = null
  let isOpen = false
  let single = false              // opened on one card: its window only, closes on the answer
  let wanted = null               // the one card asked for before the state had arrived
  let order = []
  let current = null
  let shown = null                // the rec whose node is in front
  let started = false             // cards present at open are not news
  let hintId = null
  let pendingJump = null
  let jumpMotion = null
  let opener = null
  let inerted = []
  let zoom = null
  let drag = null
  let decidedCount = 0
  let closeTimer = 0
  let saidNote = null   // the note that says what happened, while it is shown: { node, stop(), card }
  let infoTimer = 0
  let sentId = null              // the card whose answer just went through here

  // Everything, whatever session the page behind is looking at: a link may name any card.
  const pool = () => lastState?.all ?? lastState
  const announce = text => { live.textContent = ''; requestAnimationFrame(() => { live.textContent = text }) }
  const urgencyWord = card => (card.kind === 'permission' ? 'Permission' : card.urgency === 'critical' ? 'Blocking' : card.urgency === 'high' ? 'Urgent' : '')
  const canWait = card => card.kind !== 'permission' && card.urgency === 'low'
  const describe = rec =>
    [single ? 'Question' : `Question ${order.indexOf(rec.id) + 1} of ${order.length}`, rec.card.agent_name, urgencyWord(rec.card) || (canWait(rec.card) ? 'Whenever' : '')].filter(Boolean).join(', ') + `. ${rec.card.title}`
  const busyRec = () => { for (const rec of recs.values()) if (rec.busy) return rec; return null }

  // ── card nodes ──────────────────────────────────────────────────────────
  function createRec(card) {
    const node = el('article', 'focus-card')
    node.dataset.id = card.id
    node.tabIndex = -1
    node.inert = true
    const rec = { id: card.id, card, node, sigC: '', askText: '', askOpen: false, picked: new Set(), busy: false, outTimer: 0, optButtons: [], imageAt: 0, threadSig: null }
    // One field per card: the note to an answer is what stands in the composer. rec.note stays as a name for it.
    Object.defineProperty(rec, 'note', {
      get: () => rec.askText,
      set: text => {
        rec.askText = text
        if (rec.askField && rec.askField.value !== text) rec.askField.value = text
        paintDraft(rec)
      },
    })
    return rec
  }

  function fill(rec) {
    const { card, node } = rec
    const active = document.activeElement
    const hadFocus = node.contains(active)
    const typed = hadFocus && (active === rec.noteNode || active === rec.askField) ? { ask: active === rec.askField, sel: [active.selectionStart, active.selectionEnd] } : null
    const scrollTop = rec.scroll?.scrollTop ?? 0
    const permission = card.kind === 'permission'
    const attachments = card.attachments ?? []
    node.dataset.kind = permission ? 'permission' : 'decision'
    const titleId = `focus-title-${card.id}`
    node.setAttribute('aria-labelledby', titleId)

    const scroll = el('div', 'focus-scroll')
    rec.scroll = scroll
    const title = el('h2', 'focus-title', card.title)
    title.id = titleId
    rec.reasonNode = el('p', 'focus-reason')
    rec.reasonNode.textContent = card.urgency_reason || ''
    rec.reasonNode.hidden = !card.urgency_reason
    const lead = el('div', 'focus-lead')
    lead.append(title, rec.reasonNode)

    // what the question is about: pictures and players
    const images = attachments.filter(a => kindOf(a) === 'image')
    const files = attachments.filter(a => kindOf(a) === 'file')
    const players = mediaNodes(attachments)
    const media = el('div', 'focus-media')
    rec.showImage = null
    if (images.length) {
      rec.imageAt = clamp(rec.imageAt, 0, images.length - 1)
      const figure = button('focus-figure')
      const img = el('img')
      img.alt = ''
      img.draggable = false
      const badge = el('span', 'focus-figure-zoom')
      badge.append(icon('zoom'))
      const caption = el('span', 'focus-figure-name')
      figure.append(img, badge)
      const thumbs = []
      const pick = i => {
        rec.imageAt = i
        img.src = images[i].url
        caption.textContent = images.length > 1 ? `${i + 1} / ${images.length} · ${images[i].name}` : images[i].name
        figure.setAttribute('aria-label', `Enlarge image ${i + 1} of ${images.length}: ${images[i].name}`)
        thumbs.forEach((t, k) => t.setAttribute('aria-pressed', String(k === i)))
      }
      rec.showImage = pick
      figure.addEventListener('click', () => openZoom(images, rec.imageAt, figure, pick, rec))
      media.append(figure)
      if (images.length > 1) {
        const strip = el('div', 'focus-thumbs')
        images.forEach((a, i) => {
          const t = button('focus-thumb', `Show image ${i + 1}: ${a.name}`)
          const ti = el('img')
          ti.src = a.url
          ti.alt = ''
          ti.loading = 'lazy'
          ti.draggable = false
          t.append(ti)
          t.addEventListener('click', () => pick(i))
          thumbs.push(t)
          strip.append(t)
        })
        strip.append(caption)
        media.append(strip)
      } else {
        media.append(caption)
      }
      pick(rec.imageAt)
    }
    media.append(...players)
    const hasMedia = images.length > 0 || players.length > 0

    // the explanation
    const text = el('div', 'focus-text')
    if (permission) {
      const { desc, raw, rows } = parsePermission(card.body)
      const box = el('div', 'focus-perm')
      if (desc) box.append(el('p', 'focus-perm-desc', desc))
      if (raw) {
        const tool = card.title.replace(/^[^:]{0,24}:\s*/, '')
        const cap = el('div', 'focus-perm-cap')
        cap.append(icon('shield'), el('span', null, tool || 'Tool'), el('span', null, 'Input'))
        box.append(cap)
        if (rows) {
          const dl = el('dl', 'focus-perm-rows')
          for (const [k, v] of rows) dl.append(el('dt', null, k), el('dd', null, v))
          box.append(dl)
        } else {
          box.append(el('pre', 'focus-perm-raw', raw))
        }
      }
      if (desc || raw) text.append(box)
    } else if (card.body) {
      text.append(rich(card.body))
    }
    if (files.length) {
      const list = el('div', 'focus-files')
      for (const a of files) {
        const link = el('a', 'focus-file')
        link.href = a.url
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        link.append(icon('file'), el('span', null, a.name))
        list.append(link)
      }
      text.append(list)
    }
    const hasText = text.childNodes.length > 0

    const body = el('div', 'focus-body')
    body.dataset.layout = hasMedia && hasText ? 'split' : hasMedia ? 'media' : 'text'
    if (hasMedia) body.append(media)
    if (hasText) body.append(text)
    scroll.append(lead)
    if (hasMedia || hasText) scroll.append(body)

    // The conversation about this card. The question above is the agent's opening message; what the
    // human asks back and what the agent replies follows under it, newest last (paintThread), and one
    // composer stands at the foot of the column, always. It is the card's only field: Enter asks the
    // agent, and an answer tile takes what stands in it along as the note to the answer.
    rec.threadNode = null
    rec.askNode = null
    rec.askField = null
    rec.composer = null
    if (!permission) {
      rec.threadNode = el('div', 'focus-thread')
      rec.threadNode.hidden = true
      rec.threadSig = null
      const ask = el('form', 'focus-ask')
      ask.noValidate = true
      ask.setAttribute('data-open', '')
      // Not shown any more: the composer is always open. Kept for whoever opens the line (key A): it puts the caret there.
      const askOpen = button('focus-ask-open')
      askOpen.tabIndex = -1
      const field = el('textarea', 'focus-ask-field')
      field.rows = 1
      field.placeholder = 'Ask the agent, or write a note for your answer'
      field.autocomplete = 'off'
      field.enterKeyHint = 'send'
      field.setAttribute('aria-label', 'Write to the agent about this question. Enter asks it and the question stays open; an answer takes what you wrote along as a note.')
      field.value = rec.askText
      const send = button('focus-ask-send', 'Ask the agent')
      send.type = 'submit'
      send.title = 'Ask the agent (Enter)'
      send.append(icon('up'))
      ask.append(askOpen, field, send)
      field.after(dictationMic(field, { key: `${rec.id}:ask`, primary: true, onError: text => info(text, true) }))   // speak instead of typing (speech.js)
      askOpen.addEventListener('click', () => field.focus({ preventScroll: true }))
      field.addEventListener('input', () => { rec.askText = field.value; paintDraft(rec) })
      // Enter sends with a real keyboard, Shift+Enter breaks the line; on a touch screen Enter stays a line break
      // and the button sends, as in the session's conversation. Never while an IME is composing.
      field.addEventListener('keydown', e => {
        if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return
        if (!touchOnly.matches || e.ctrlKey || e.metaKey) { e.preventDefault(); ask.requestSubmit() }
      })
      send.addEventListener('mousedown', e => e.preventDefault())   // the caret stays in the field
      ask.addEventListener('submit', e => { e.preventDefault(); askBack(rec) })
      rec.askNode = ask
      rec.askField = field
      rec.askSend = send
      // Under the field: the two ways to leave the card without answering (Explain, Later: one pair of buttons that
      // moves along with the card in front), and in a few words what the field does.
      rec.actionsNode = el('div', 'focus-actions')
      const foot = el('div', 'focus-composer-foot')
      foot.append(rec.actionsNode, el('p', 'focus-ask-hint', 'Enter sends: plain chat, the question stays. An answer takes these words along as its note.'))
      rec.composer = el('div', 'focus-composer')
      rec.composer.append(ask, foot)
      scroll.append(rec.threadNode)
    }

    // The answers: one tap answers. The tiles are the row's tiles grown large: exactly
    // two options (and every permission) are a pair of squares, the "no" on the left and
    // the option the agent leads with on the right and filled, each under its thumb, with
    // its own word only when it is not a plain yes or no. More options are a column. The
    // note comes after the tiles, so the tiles stand in the same place on every card.
    const answer = el('div', 'focus-answer')
    rec.answer = answer
    rec.errorNode = el('p', 'focus-error')
    rec.errorNode.setAttribute('role', 'alert')
    rec.errorNode.hidden = true
    rec.optButtons = []
    rec.noteNode = null
    rec.sendTile = null

    const multi = Boolean(card.multiple) && !permission
    const duo = card.options.length === 2 && !multi
    const isYes = o => (permission ? o.key === 'allow' : o === card.options[0])
    const options = duo ? [...card.options].sort((x, y) => isYes(x) - isYes(y)) : card.options
    const labelOf = o => (permission ? { allow: 'Allow', deny: 'Deny' }[o.key] ?? o.label : o.label)
    const bare = duo && !permission && card.options.every(o => BARE.test(o.label.trim()))
    const advisedKeys = new Set([].concat(card.recommended ?? []))
    rec.multi = multi
    rec.yesKey = duo ? options[1].key : null
    rec.noKey = duo ? options[0].key : null
    rec.labelOf = labelOf
    rec.picked = new Set([...rec.picked].filter(k => card.options.some(o => o.key === k)))

    const opts = el('div', 'focus-opts')
    opts.setAttribute('role', 'group')
    opts.setAttribute('aria-label', permission ? 'Allow or deny' : multi ? 'Your answers. Choose one or more, then send.' : 'Your answer. One tap answers.')
    // Many short words are tags: small, several to a line, so that nothing has to be scrolled. The window
    // decides that from what the card holds, not the agent. What an option leads to is said in one line under
    // the tags for the one the pointer or the keyboard is on.
    const tags = !duo && !permission && card.options.length >= TAGS_FROM && card.options.every(o => labelOf(o).trim().length <= TAG_CHARS)
    opts.dataset.count = duo ? 'duo' : tags ? 'tags' : 'stack'
    answer.toggleAttribute('data-tags', tags)
    node.dataset.opts = tags ? (card.options.length > TAGS_WIDE_FROM ? 'tags-wide' : 'tags') : duo ? 'duo' : 'stack'
    // Which picture belongs to which option, where that is plain to see (see pairPictures).
    rec.pictureOf = permission ? null : pairPictures(card.options, images)
    opts.toggleAttribute('data-multi', multi)
    for (const o of options) {
      const b = button('focus-opt')
      b.dataset.key = o.key
      const advised = advisedKeys.has(o.key)
      if (advised) { b.classList.add('is-advised'); b.title = 'The agent recommends this' }
      const mark = el('span', 'focus-opt-mark')
      mark.setAttribute('aria-hidden', 'true')
      if (duo) {
        const lead = isYes(o)
        if (lead) b.classList.add('is-lead')
        mark.append(sketch(lead ? 'yes' : NEGATIVE.test(o.label) || o.key === 'deny' ? 'no' : 'other'))
      }
      if (multi) {
        const box = el('span', 'focus-opt-box')
        box.append(icon('check'))
        mark.append(box)
      } else {
        mark.append(el('span', 'focus-spinner'), icon('check'))
      }
      const words = el('span', 'focus-opt-words')
      // A bare yes or no needs no word: the thumb says it.
      if (bare) b.setAttribute('aria-label', advised ? `${o.label}, recommended by the agent` : o.label)
      else {
        const label = el('span', 'focus-opt-label', labelOf(o))
        // In a stack of options the pen goes round the words of the advised one (ui.js draws the mark).
        if (advised && !duo) (tags ? b : label).append(adviceLoop())
        words.append(label)
      }
      if (o.detail) words.append(el('span', 'focus-opt-detail', o.detail))
      if (tags) b.title = [o.detail, advised ? 'The agent recommends this' : ''].filter(Boolean).join(' · ')
      if (advised && !bare) words.append(el('span', 'focus-sr', ', recommended by the agent'))
      b.append(mark)
      if (words.childNodes.length) b.append(words)
      b.addEventListener('click', () => (multi ? toggle(rec, o.key) : submit(rec, [o.key])))
      rec.optButtons.push(b)
      opts.append(b)
    }
    if (multi) {
      // Several may be right: the options are switches, and this tile sends what is switched on.
      const b = button('focus-opt focus-opt-send is-lead')
      const mark = el('span', 'focus-opt-mark')
      mark.setAttribute('aria-hidden', 'true')
      mark.append(el('span', 'focus-spinner'), icon('check'))
      const words = el('span', 'focus-opt-words')
      rec.sendCount = el('span', 'focus-opt-detail')
      words.append(el('span', 'focus-opt-label', 'Send'), rec.sendCount)
      b.append(mark, words)
      b.addEventListener('click', () => submit(rec, card.options.map(o => o.key).filter(k => rec.picked.has(k))))
      rec.sendTile = b
      opts.append(b)
    }
    answer.append(rec.errorNode, opts)
    rec.noteTag = null
    if (tags) {
      const line = el('p', 'focus-tag-line')
      const rest = multi ? '' : 'One tap answers.'
      line.textContent = rest
      const tell = e => {
        const b = e.target.closest?.('.focus-opt:not(.focus-opt-send)')
        const o = b && card.options.find(x => x.key === b.dataset.key)
        line.replaceChildren(...(o ? [el('b', null, labelOf(o)), o.detail ? `: ${o.detail}` : '', advisedKeys.has(o.key) ? ' · the agent would take it' : ''] : [rest]))
      }
      opts.addEventListener('pointerover', tell)
      opts.addEventListener('focusin', tell)
      opts.addEventListener('pointerleave', () => line.replaceChildren(rest))
      opts.addEventListener('focusout', () => line.replaceChildren(rest))
      answer.append(line)
    }
    // An option whose picture is known shows it while the pointer or the keyboard is on the option.
    if (rec.pictureOf && rec.showImage) {
      const look = e => {
        const at = rec.pictureOf.get(e.target.closest?.('.focus-opt')?.dataset.key)
        if (at != null && at !== rec.imageAt) rec.showImage(at)
      }
      opts.addEventListener('pointerover', look)
      opts.addEventListener('focusin', look)
    }
    if (!permission) {
      // No second field: the note is what stands in the composer (rec.note reads it). This line under the tiles says so
      // while there is something in it.
      rec.noteNode = rec.askField
      rec.noteTag = el('p', 'focus-note-tag')
      rec.noteTag.append(sketch('hand'), el('span', null, 'Your words go along as a note'))
      rec.noteTag.hidden = true
      answer.append(rec.noteTag)
    }

    const talk = el('div', 'focus-talk')
    talk.append(scroll)
    if (rec.composer) talk.append(rec.composer)
    node.replaceChildren(talk, answer)
    if (multi) paintPicked(rec)
    rec.toEnd = false
    paintThread(rec)
    paintDraft(rec)
    // With a conversation under the question, the newest of it is in view, as in any chat.
    scroll.scrollTop = rec.toEnd ? scroll.scrollHeight : scrollTop
    rec.toEnd = false
    const back = typed ? (typed.ask ? rec.askField : rec.noteNode) : null
    if (back) {
      back.focus({ preventScroll: true })
      try { back.setSelectionRange(typed.sel[0], typed.sel[1]) } catch {}
    } else if (hadFocus) {
      node.focus({ preventScroll: true })
    }
  }

  function setError(rec, text) {
    rec.errorNode.textContent = text
    rec.errorNode.hidden = !text
  }

  // ── several answers at once ─────────────────────────────────────────────
  function paintPicked(rec) {
    for (const b of rec.optButtons) b.setAttribute('aria-pressed', String(rec.picked.has(b.dataset.key)))
    const n = rec.picked.size
    rec.sendTile.disabled = !n
    rec.sendCount.textContent = n ? `${n} chosen` : 'Choose one or more'
  }
  function toggle(rec, key) {
    if (rec.busy || rec !== shown) return
    if (rec.picked.has(key)) rec.picked.delete(key)
    else rec.picked.add(key)
    paintPicked(rec)
  }

  // ── the conversation about a card ───────────────────────────────────────
  /** The composer after its text changed: the send button, the line under the tiles, the field's height. */
  function paintDraft(rec) {
    const field = rec.askField
    if (!field) return
    const has = Boolean(rec.askText.trim())
    rec.askSend.disabled = !has
    if (rec.noteTag) rec.noteTag.hidden = !has
    field.style.height = 'auto'
    const full = field.scrollHeight
    if (full) field.style.height = `${Math.min(full, 168)}px`
    field.style.overflowY = full > 168 ? 'auto' : 'hidden'
  }

  /** What was said about a card, under its question, in the look of the session's conversation (the classes
   *  and the rich text of chat.js): what the state holds about it (messages that name the card), and what
   *  was written from here that the state does not show yet. Newest last. */
  function paintThread(rec) {
    if (!rec.threadNode) return
    const told = (pool()?.messages ?? []).filter(m => m.card_id === rec.id && m.from !== 'event')
    const mine = (asked.get(rec.id) ?? []).filter(a => !(a.state === 'sent' && told.some(m => m.from === 'user' && m.text === a.text)))
    if (asked.has(rec.id)) asked.set(rec.id, mine)
    const items = [
      ...told.map(m => ({ from: m.from === 'user' ? 'user' : 'agent', text: m.text ?? '', ts: m.ts, state: '', attachments: m.attachments ?? [], details: m.details ?? '' })),
      ...mine.map(a => ({ from: 'user', text: a.text, ts: a.ts, state: a.state, error: a.error })),
    ].sort((a, b) => a.ts - b.ts)
    const sig = JSON.stringify(items)
    if (sig === rec.threadSig) return
    const grew = items.length > (rec.threadCount ?? 0)
    rec.threadSig = sig
    rec.threadCount = items.length
    rec.threadNode.hidden = !items.length
    const session = (pool()?.agents ?? []).find(a => a.id === rec.card.agent)
    const name = rec.card.agent_name || session?.name || 'Agent'
    let before = null
    const nodes = items.map(item => {
      const cont = before === item.from
      before = item.from
      const msg = el('article', `msg msg-${item.from}${cont ? ' cont' : ''}`)
      if (item.from === 'user') {
        const bubble = el('div', 'bubble')
        // The fixed request of "Explain" is one long sentence for the agent; here it is the two words the human tapped.
        const fixed = item.text === EXPLAIN_TEXT
        bubble.append(el('p', null, fixed ? 'Explain this, please.' : item.text))
        if (fixed) bubble.title = item.text
        msg.append(bubble)
        if (item.state === 'sending') { msg.dataset.state = 'sending'; msg.append(el('p', 'focus-msg-state', 'Sending')) }
        else if (item.state === 'failed') { msg.dataset.state = 'failed'; msg.append(el('p', 'focus-msg-state', `Not sent: ${item.error}`)) }
        else msg.append(agoNode(item.ts, 'msg-time'))
        return msg
      }
      if (!cont) {
        const head = el('header', 'msg-head')
        const mark = el('span', 'focus-msg-mark')
        mark.append(doodle(session?.mark ?? rec.card.agent))
        head.append(mark, el('span', 'msg-name', name), agoNode(item.ts, 'msg-time'))
        msg.append(head)
      }
      const text = richPlus(item.text)
      text.append(...attachmentNodes(item.attachments))
      msg.append(text)
      if (item.details) {
        const more = el('details', 'msg-details')
        more.append(el('summary', null, 'Details'), richPlus(item.details))
        msg.append(more)
      }
      return msg
    })
    const last = items[items.length - 1]
    if (last && last.from === 'user' && last.state !== 'sending' && last.state !== 'failed') {
      nodes.push(el('p', 'focus-thread-wait', 'Sent. The reply shows up here; the question stays open.'))
    }
    rec.threadNode.replaceChildren(...nodes)
    // the newest is in view, as in any chat
    if (grew) {
      rec.toEnd = true
      if (rec.scroll?.isConnected) rec.scroll.scrollTop = rec.scroll.scrollHeight
    }
  }

  /** Send what stands in the card's ask-back line; with fixed, that text instead (Explain), and the line keeps what it holds.
   *  Resolves true when the session has it. */
  async function askBack(rec, fixed = null) {
    const text = (fixed ?? rec.askText).trim()
    if (!text) return rec.askField?.focus({ preventScroll: true })
    const entry = { text, ts: Date.now(), state: 'sending', error: '' }
    asked.set(rec.id, [...(asked.get(rec.id) ?? []).filter(a => a.state !== 'failed'), entry])
    if (!fixed) {
      rec.askText = ''
      if (rec.askField) { rec.askField.value = ''; rec.askSend.disabled = true }
      paintDraft(rec)
    }
    paintThread(rec)
    rec.scroll.scrollTop = rec.scroll.scrollHeight
    try {
      await sendMessage(text, rec.card.agent, rec.id)
      entry.state = 'sent'
      // What was typed into the composer is plain chat about the card: it stays open, in its place, and in front.
      // Only "Explain" (fixed) leaves the card: it waits under "Later" until the reply, and the walk moves on.
      if (fixed) {
        announce('Asked to explain. The card waits under Later until the reply.')
        if (!single && shown === rec && order.length > 1) { pendingJump = order[order.indexOf(rec.id) + 1] ?? order.find(id => id !== rec.id); jumpMotion = 'later' }
        putOff(rec.id, true, true)
      } else announce('Sent to the agent. The question stays open.')
    } catch (err) {
      entry.state = 'failed'
      entry.error = err?.message || 'The server did not answer.'
      announce(`Your question was not sent: ${entry.error}`)
    }
    const sent = entry.state === 'sent'
    const now = recs.get(rec.id)
    if (!now) return sent
    // a failed question goes back into the field, unless the human is already typing the next one
    if (entry.state === 'failed' && !fixed && !now.askText && now.askField) { now.askText = text; now.askField.value = text; now.askSend.disabled = false; paintDraft(now) }
    paintThread(now)
    now.scroll.scrollTop = now.scroll.scrollHeight
    return sent
  }

  /** Explain: a fixed question back, in one tap. The card goes to "Later" like any card asked about and
   *  returns with the session's reply; in the walk the next question comes up, and Back fetches this one again. */
  let explaining = false
  async function explain() {
    const rec = shown
    if (!isOpen || !rec || rec.busy || !rec.askNode || explaining) return false
    explaining = true
    explainBtn.disabled = true
    const walking = !single
    const sent = await askBack(rec, EXPLAIN_TEXT).catch(() => false)
    explaining = false
    paintChrome()
    if (!isOpen) return
    if (!sent) return info('Not asked: the session did not get it.', true)
    const fetch = async () => { putOff(rec.id, false) }
    // The window of one card closes: the card is put off and comes back with the reply. The page says so.
    if (!walking) { close(); return void say(pageHost(), { head: 'Asked to explain', title: 'It comes back with the answer.', back: fetch }) }
    offerBack(rec.card, { head: 'Asked to explain', title: 'It comes back with the answer.', take: fetch })
  }

  // ── answering ───────────────────────────────────────────────────────────
  const request = (card, keys, note) => (card.multiple ? decideMany(card.id, keys, note, card.revised ?? null) : decide(card.id, keys[0], note))

  async function submit(rec, keys) {
    if (rec.busy || busyRec() || rec !== shown || !recs.has(rec.id)) return
    const card = rec.card
    const chosen = keys.map(k => card.options.find(o => o.key === k)).filter(Boolean)
    if (!chosen.length) return
    // what the list (or the undo offer) calls the answer: the one option, or all of them in one
    const option = chosen.length === 1 && !rec.multi ? chosen[0] : { key: keys.join(','), label: chosen.map(rec.labelOf).join(', '), detail: '' }
    const btn = rec.multi ? rec.sendTile : rec.optButtons.find(b => b.dataset.key === keys[0])
    const note = rec.noteNode ? rec.note.trim() : ''
    setError(rec, '')

    if (!single) {
      // The walk does not wait for the server: the tile shows the answer, the next card comes
      // in at once, and the request travels behind it. If it fails, the card comes back.
      btn.dataset.state = 'done'
      rec.note = ''
      rec.picked.clear()
      decidedLocal.set(rec.id, Date.now())
      decidedCount++
      sentId = rec.id
      if (card.kind !== 'permission') offerBack(card, { head: `Answered: ${option.label}`, take: () => reopenAnswer(card) })
      else hideUndo()
      const sending = request(card, keys, note)
      inflight.set(card.id, sending)
      sync('sent')
      try {
        await sending
      } catch (err) {
        returned(card, note, err)
      } finally {
        if (inflight.get(card.id) === sending) inflight.delete(card.id)
      }
      return
    }

    // The window of one card waits, because it closes on the answer: the human is back at
    // the row they came from, and the list offers the way back. A failure has to be seen here.
    rec.busy = true
    rec.node.dataset.busy = ''
    btn.dataset.state = 'pending'
    const controls = [...rec.optButtons, rec.sendTile].filter(Boolean)
    for (const b of controls) b.disabled = b !== btn
    btn.setAttribute('aria-disabled', 'true')
    if (rec.noteNode) rec.noteNode.disabled = true
    paintChrome()
    try {
      await request(card, keys, note)
    } catch (err) {
      rec.busy = false
      delete rec.node.dataset.busy
      delete btn.dataset.state
      btn.removeAttribute('aria-disabled')
      for (const b of controls) b.disabled = false
      if (rec.multi) paintPicked(rec)
      if (rec.noteNode) rec.noteNode.disabled = false
      refused(rec, err)
      sync()
      return
    }
    btn.dataset.state = 'done'
    rec.note = ''
    if (!still()) await wait(160)
    rec.busy = false
    decidedLocal.set(rec.id, Date.now())
    if (card.kind !== 'permission') onDecided?.(card, option, keys)
    close()
  }

  /** Say on the card why its answer was not taken. */
  function refused(rec, err) {
    const reason = err?.message || 'The server did not answer.'
    setError(rec, `Not saved: ${reason}`)
    announce(`Your answer was not saved: ${reason}`)
    if (!still()) {
      rec.answer.removeAttribute('data-shake')
      void rec.answer.offsetWidth
      rec.answer.setAttribute('data-shake', '')
    }
  }

  /** An answer given in the walk did not get through: its card comes back to the front. */
  function returned(card, note, err) {
    decidedLocal.delete(card.id)
    decidedCount = Math.max(0, decidedCount - 1)
    if (saidNote?.card === card.id) hideUndo(true)
    if (!isOpen) return
    pendingJump = card.id
    jumpMotion = 'prev'
    sync()
    const rec = recs.get(card.id)
    if (!rec) return info(`Not saved: ${err?.message || 'The server did not answer.'}`, true)
    if (rec.noteNode && note && !rec.note) { rec.note = note; rec.noteNode.value = note }
    refused(rec, err)
  }

  // ── later ───────────────────────────────────────────────────────────────
  /** Put the card in front off: it joins the "Later" group at the end, and the walk moves on. */
  function later() {
    const rec = shown
    if (!isOpen || !rec || rec.busy || rec.card.kind === 'permission') return
    const fetch = async () => { putOff(rec.id, false) }
    if (single) { putOff(rec.id); close(); return void say(pageHost(), { head: 'Moved to Later', title: rec.card.title, back: fetch }) }
    const at = order.indexOf(rec.id)
    const next = order[at + 1] ?? order.find(id => id !== rec.id)
    if (!next) return info('This is the only open question.')
    pendingJump = next
    jumpMotion = 'later'
    putOff(rec.id)   // the store tells every subscriber, this window included: sync() runs in here
    offerBack(rec.card, { head: 'Moved to Later', take: fetch })
    announce(`Put off: ${rec.card.title}`)
  }

  // ── undo, info, hint: the notes in the top bar ──────────────────────────
  /** Take the note away; with forget, the key for "back" stops working too. */
  function hideUndo(forget = false) {
    saidNote?.stop()
    saidNote = null
    if (forget) forgetBack()
  }

  /** An answer given in the walk, taken back on the server. */
  async function reopenAnswer(card) {
    // The answer may still be on its way; it has to arrive before it can be taken back.
    // If it does not arrive, there is nothing to take back: its card returns by itself.
    const sending = inflight.get(card.id)
    if (sending && !(await sending.then(() => true, () => false))) return
    await reopen(card.id)
    decidedLocal.delete(card.id)
    decidedCount = Math.max(0, decidedCount - 1)
  }

  /** Say what happened to the card that left (head, and the question under it unless title says otherwise),
   *  with the way back: take() undoes it, and the card is in front again. */
  function offerBack(card, { head, title = card.title, take }) {
    hideUndo()
    const back = async () => {
      await take()
      pendingJump = card.id
      jumpMotion = 'prev'
      setTimeout(() => { if (pendingJump === card.id) pendingJump = null }, 5000)
      sync()
      announce(`Taken back: ${card.title}`)
    }
    saidNote = say(says, { head, title, back, onFail: err => info(`Not taken back: ${err?.message || 'The server did not answer.'}`, true) })
    saidNote.card = card.id
  }

  function info(text, bad = false) {
    clearTimeout(infoTimer)
    infoNode.textContent = text
    infoNode.toggleAttribute('data-bad', bad)
    infoNode.hidden = false
    announce(text)
    infoTimer = setTimeout(() => { infoNode.hidden = true }, INFO_MS)
  }

  function paintHint() {
    const rec = hintId && recs.get(hintId)
    if (!rec || hintId === current || order.indexOf(hintId) > order.indexOf(current)) {
      hintId = null
      hintBtn.hidden = true
      return
    }
    const sig = `${rec.id}|${rec.card.urgency}|${rec.card.title}`
    if (hintBtn.dataset.sig === sig && !hintBtn.hidden) return
    const wasHidden = hintBtn.hidden
    hintBtn.dataset.sig = sig
    hintBtn.dataset.urgency = rec.card.urgency
    const mark = el('span', 'focus-hint-mark')
    mark.append(icon('up'))
    const text = el('span', 'focus-hint-text')
    text.append(el('b', null, 'More urgent: '), rec.card.title)
    hintBtn.replaceChildren(mark, text)
    hintBtn.title = `Question ${rec.card.number}: ${rec.card.title}`
    hintBtn.hidden = false
    if (wasHidden) announce(`More urgent: ${rec.card.title}. The question in front of you stays.`)
  }

  // ── the rail: how far the walk is ───────────────────────────────────────
  // A slim strip at the left edge of the window (a thin row under the top bar when the window is narrow):
  // how many questions are left, and one small scribbled mark per question in the order of the walk.
  // Answered in this walk: a tick. Open: a dot in the colour of its urgency. Put off: a hollow dot, at the
  // end. The one in front: a ring round it. A gap, and the sender's mark while there is room, where the
  // sender changes. A tap on a mark goes to that question. Not shown in the window of one card.
  const rail = el('nav', 'focus-rail')
  rail.setAttribute('aria-label', 'The questions of this walk')
  rail.hidden = true
  const railCount = el('p', 'focus-rail-count')
  const railMarks = el('div', 'focus-rail-marks')
  rail.append(railCount, railMarks)
  top.after(rail)
  const railSeen = new Map()   // id -> card: every question that stood in this walk
  const railDone = new Map()   // id -> card: the ones answered since, in the order they were answered
  let railSig = ''
  function railReset() {
    railSeen.clear()
    railDone.clear()
    railSig = ''
    rail.hidden = true
    sheet.removeAttribute('data-rail')
  }
  /** One mark, drawn with the pen: the same id always gives the same wobble. */
  function railMark(state, front, seed) {
    const r = penSeed(`rail:${seed}`)
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('viewBox', '0 0 32 32')
    svg.setAttribute('aria-hidden', 'true')
    const draw = (cls, d) => {
      const path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute('class', cls)
      path.setAttribute('d', d)
      svg.append(path)
    }
    const j = () => (r() - .5) * 1.6
    if (state === 'done') draw('focus-rail-tick', `M${(9 + j()).toFixed(1)} ${(16.5 + j()).toFixed(1)} L${(14 + j()).toFixed(1)} ${(22.5 + j()).toFixed(1)} L${(24 + j()).toFixed(1)} ${(9 + j()).toFixed(1)}`)
    else draw(state === 'later' ? 'focus-rail-hollow' : 'focus-rail-dot', loopPath(r, { rad: state === 'later' ? 6.6 : 5.8, drift: .5, jitter: 1 }))
    if (front) draw('focus-rail-ring', loopPath(r, { rad: 13.6, drift: 1.4, jitter: 1.1 }))
    return svg
  }
  function paintRail() {
    const walking = isOpen && !single && sheet.dataset.state === 'cards'
    if (walking) {
      const byId = new Map((pool()?.cards ?? []).map(c => [c.id, c]))
      for (const [id, card] of railSeen) {
        if (order.includes(id) || railDone.has(id)) continue
        // gone from the walk: answered (here, or elsewhere meanwhile), or withdrawn by its agent
        const now = byId.get(id)
        if (decidedLocal.has(id) || (now && now.status !== 'open' && now.choice != null)) railDone.set(id, card)
        else railSeen.delete(id)
      }
      for (const id of order) {
        railSeen.set(id, recs.get(id)?.card ?? railSeen.get(id))
        railDone.delete(id)   // taken back: open again
      }
    }
    const show = walking && railDone.size + order.length > 1
    rail.hidden = !show
    sheet.toggleAttribute('data-rail', show)
    if (!show) return
    const off = new Set(lastState?.later ?? [])
    const list = [
      ...[...railDone].map(([id, card]) => ({ id, card, state: 'done' })),
      ...order.map(id => ({ id, card: railSeen.get(id), state: off.has(id) ? 'later' : 'open' })),
    ].filter(x => x.card)
    const sig = JSON.stringify([current, list.map(x => [x.id, x.state, x.card.urgency, x.card.agent, x.card.title])])
    if (sig === railSig) return
    railSig = sig
    const left = order.length
    railCount.replaceChildren(el('b', null, String(left)), el('span', null, ' left'))
    railCount.title = `${left === 1 ? 'One question' : `${left} questions`} left${railDone.size ? `, ${railDone.size} answered` : ''}`
    rail.dataset.size = list.length > 24 ? 'many' : list.length > 12 ? 'some' : 'few'
    const sessions = pool()?.agents ?? []
    const open = list.filter(x => x.state === 'open')
    const senders = new Set(open.map(x => x.card.agent)).size
    const changes = open.filter((x, i) => i && open[i - 1].card.agent !== x.card.agent).length
    const bySender = senders > 1 && changes < senders * 2
    const nodes = []
    let before = null
    for (const x of list) {
      const b = button('focus-rail-mark')
      b.tabIndex = -1   // the walk has its keys (J, K); forty marks are no stops for Tab
      b.dataset.state = x.state
      b.dataset.urgency = RANK[x.card.urgency] != null ? x.card.urgency : 'normal'
      const front = x.id === current
      if (front) { b.dataset.front = ''; b.setAttribute('aria-current', 'step') }
      const who = x.card.agent_name ? ` · ${x.card.agent_name}` : ''
      b.title = `${x.state === 'done' ? 'Answered: ' : x.state === 'later' ? 'Later: ' : ''}${x.card.title}${who}`
      b.setAttribute('aria-label', b.title)
      b.append(railMark(x.state, front, x.id))
      if (x.state === 'done') b.disabled = true
      else b.addEventListener('click', () => go(x.id))
      // A wider gap where the kind of mark changes. Where the sender changes, a small gap and (while there is room)
      // the sender's mark, but only in a walk that goes sender by sender: the walk follows urgency, and when the
      // senders alternate in it, a gap at every other mark would say nothing.
      if (before && before.state !== x.state) b.dataset.gap = 'part'
      if (bySender && x.state === 'open' && (before?.state !== 'open' || before.card.agent !== x.card.agent)) {
        const session = sessions.find(a => a.id === x.card.agent)
        const mark = el('span', 'focus-rail-who')
        mark.title = x.card.agent_name || session?.name || ''
        mark.append(doodle(session?.mark ?? x.card.agent))
        if (before) { mark.dataset.gap = b.dataset.gap ?? 'sender'; b.dataset.gap ??= 'sender' }
        nodes.push(mark)
      }
      nodes.push(b)
      before = x
    }
    railMarks.replaceChildren(...nodes)
    railMarks.querySelector('[data-front]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  // ── state → cards ───────────────────────────────────────────────────────
  function sync(motion) {
    const state = lastState
    if (!isOpen || !state) return
    const byId = new Map(pool().cards.map(c => [c.id, c]))
    const isOpenCard = id => byId.get(id)?.status === 'open' && !decidedLocal.has(id)
    const now = Date.now()
    for (const [id, at] of decidedLocal) {
      if (byId.get(id)?.status !== 'open' || now - at > LOCAL_DECIDED_TTL) decidedLocal.delete(id)
    }
    // A card was asked for before the state was there: now it can be found.
    if (wanted && isLoaded()) {
      if (isOpenCard(wanted)) { single = true; current = wanted; root.setAttribute('data-single', '') }
      wanted = null
    }
    const prevOrder = order
    const prevIndex = prevOrder.indexOf(current)
    // The server's order, most urgent first; what the human put off comes after everything else.
    const put = id => (state.later ?? []).indexOf(id)
    const next = [...new Set(state.queue)].filter(isOpenCard).sort((a, b) => put(a) - put(b))
    // the one card of this window may belong to a session the page behind is not looking at
    if (single && current && !next.includes(current) && isOpenCard(current)) next.unshift(current)
    // The one card this window was opened on is gone (withdrawn, or answered elsewhere): so is the window.
    if (single && current && !next.includes(current) && busyRec()?.id !== current) return close()
    // a card whose answer is still travelling stays put until the request settles
    const busy = busyRec()
    if (busy && !next.includes(busy.id)) next.splice(clamp(prevOrder.indexOf(busy.id), 0, next.length), 0, busy.id)
    order = next

    let lost = null
    for (const [id, rec] of recs) {
      if (order.includes(id)) continue
      recs.delete(id)
      if (rec === shown) { if (id !== sentId && !decidedLocal.has(id)) lost = { rec, card: byId.get(id) } }
      else { clearTimeout(rec.outTimer); rec.node.remove() }
    }

    sentId = null

    const promoted = []
    for (const id of order) {
      let rec = recs.get(id)
      const card = byId.get(id) ?? rec.card
      // Urgency, sender and age are painted in the top bar, so they never rebuild a card.
      const sigC = JSON.stringify([card.revised, card.kind, card.title, card.body, card.options, card.recommended, card.multiple, card.attachments, card.agent_name])
      if (!rec) {
        rec = createRec(card)
        recs.set(id, rec)
        stage.append(rec.node)
        if (started) promoted.push(rec)
      } else if ((RANK[card.urgency] ?? 1) > (RANK[rec.card.urgency] ?? 1)) {
        promoted.push(rec)
      }
      rec.card = card
      rec.node.dataset.urgency = RANK[card.urgency] != null ? card.urgency : 'normal'
      if (rec.sigC !== sigC) { rec.sigC = sigC; fill(rec) }
      else {
        rec.reasonNode.textContent = card.urgency_reason || ''
        rec.reasonNode.hidden = !card.urgency_reason
        paintThread(rec)
      }
    }

    const before = current
    if (pendingJump && order.includes(pendingJump)) {
      current = pendingJump
      pendingJump = null
      motion ??= jumpMotion ?? 'prev'
      jumpMotion = null
    } else if (!order.includes(current)) {
      current = order[clamp(prevIndex, 0, order.length - 1)] ?? null
      motion ??= lost ? 'gone' : 'sent'
    }

    // something more urgent came in ahead of the card in front: offer it, never swap
    const at = order.indexOf(current)
    const ahead = promoted.filter(rec => rec.id !== current && order.indexOf(rec.id) < at)
      .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))[0]
    if (ahead) hintId = ahead.id
    if (isLoaded()) started = true

    sheet.dataset.state = !isLoaded() ? 'loading' : order.length ? 'cards' : 'done'
    present(motion ?? 'none')
    paintChrome()
    paintHint()

    if (lost) info(`${lost.card && lost.card.status !== 'open' ? 'Answered elsewhere' : 'Withdrawn by the agent'}: ${lost.rec.card.title}`)
    if (current !== before) {
      voice()
      if (current) { if (!lost) announce(describe(recs.get(current))) }
      else if (prevOrder.length) announce('All answered. No open questions.')
    }
    rescueFocus()
  }

  /** Bring the current card's node to the front; the previous one animates out. */
  function present(motion) {
    const next = current ? recs.get(current) : null
    const prev = shown
    if (prev === next) return
    const hadFocus = !!prev && prev.node.contains(document.activeElement)
    shown = next
    if (prev) retire(prev, motion)
    if (next) {
      clearTimeout(next.outTimer)
      next.node.removeAttribute('data-out')
      next.node.inert = false
      next.node.dataset.shown = ''
      next.node.removeAttribute('data-in')
      if (!still() && motion !== 'none') {
        void next.node.offsetWidth
        next.node.dataset.in = motion
      }
      if (hadFocus) next.node.focus({ preventScroll: true })
    }
  }

  function retire(rec, motion) {
    for (const m of rec.node.querySelectorAll('video, audio')) { try { m.pause() } catch {} }
    rec.node.inert = true
    rec.node.removeAttribute('data-in')
    delete rec.node.dataset.shown
    const finish = () => {
      if (shown === rec) return
      rec.node.removeAttribute('data-out')
      rec.node.style.removeProperty('--focus-dx')
      if (recs.get(rec.id) !== rec) rec.node.remove()
      // a card that only stepped back shows its tiles untouched when it returns
      else for (const b of rec.node.querySelectorAll('.focus-opt[data-state]')) delete b.dataset.state
    }
    clearTimeout(rec.outTimer)
    if (still() || motion === 'none') return finish()
    rec.node.dataset.out = motion
    rec.outTimer = setTimeout(finish, OUT_MS)
  }

  function paintChrome() {
    const n = order.length
    const idx = order.indexOf(current)
    const locked = !!busyRec()
    prevBtn.disabled = single || idx <= 0 || locked
    nextBtn.disabled = single || idx < 0 || idx >= n - 1 || locked
    doneText.textContent = `${decidedCount ? `${decidedCount === 1 ? 'One question' : `${decidedCount} questions`} answered in this round.` : 'No open questions.'} New ones show up here as soon as an agent wants to know something.`

    // the head of the card and the sheet's colour follow the card in front
    const card = shown?.card
    meta.hidden = !card
    laterBtn.hidden = !card || card.kind === 'permission'
    laterBtn.disabled = locked
    explainBtn.hidden = laterBtn.hidden
    explainBtn.disabled = locked || explaining
    const slot = shown?.actionsNode
    if (slot && laterBtn.parentNode !== slot) slot.append(explainBtn, laterBtn)
    paintRail()
    if (!card) return
    sheet.dataset.urgency = shown.node.dataset.urgency
    const word = urgencyWord(card)
    const name = card.agent_name || ''
    const sig = `${card.agent}|${name}|${word}|${canWait(card)}`
    if (meta.dataset.sig !== sig) {
      meta.dataset.sig = sig
      // the name gives way before the word does
      tab.replaceChildren(...(name ? [el('span', 'focus-tab-who', name)] : []), el('span', 'focus-tab-word', word))
      tab.hidden = !word
      const who = []
      if (!word && name) {
        const session = (pool()?.agents ?? []).find(a => a.id === card.agent)
        who.push(doodle(session?.mark ?? card.agent), el('span', null, name))
      }
      if (canWait(card)) {
        // "whenever" is not a word but a small scribbled hourglass, as on the row
        const mark = el('span', 'focus-whenever')
        mark.title = 'Whenever: nothing waits on this'
        mark.setAttribute('role', 'img')
        mark.setAttribute('aria-label', 'Whenever')
        mark.append(sketch('whenever'))
        who.push(mark)
      }
      from.replaceChildren(...who)
      from.hidden = !who.length
    }
    // the number is for looking a card up, not for reading along
    meta.title = [`Question ${card.number}`, cardNote(card)].filter(Boolean).join(' · ')
    if (Number(agoSlot.dataset.ts) !== card.created) {
      agoSlot.dataset.ts = card.created
      agoSlot.textContent = ago(card.created)
    }
  }

  function go(target) {
    if (!isOpen || busyRec()) return false
    const at = order.indexOf(current)
    const id = typeof target === 'number' ? order[at + target] : target
    if (!id || id === current || !recs.has(id)) return false
    single = false   // leaving the one card (a more urgent one was offered and taken): from here on it is the walk
    delete root.dataset.single
    current = id
    present(order.indexOf(id) > at ? 'next' : 'prev')
    paintChrome()
    paintHint()
    announce(describe(recs.get(id)))
    voice()
    rescueFocus()
    return true
  }

  // ── focus handling ──────────────────────────────────────────────────────
  const scope = () => zoom?.box ?? root
  function focusables() {
    const within = scope()
    return [...within.querySelectorAll('button, [href], input, textarea, select, video[controls], audio[controls], [tabindex]:not([tabindex="-1"])')]
      .filter(n => !n.disabled && !n.closest('[inert]') && !n.closest('[hidden]') && n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden')
  }
  function rescueFocus() {
    if (!isOpen) return
    const a = document.activeElement
    if (a && a !== document.body && scope().contains(a) && !a.closest('[inert]') && !a.disabled && a.getClientRects().length) return
    const target = zoom ? zoom.closeBtn : sheet.dataset.state === 'done' ? doneBtn : shown?.node ?? sheet
    target.focus({ preventScroll: true })
  }
  function trapTab(e) {
    const list = focusables()
    e.preventDefault()
    if (!list.length) return (zoom?.box ?? sheet).focus({ preventScroll: true })
    const at = list.indexOf(document.activeElement)
    const to = at < 0 ? (e.shiftKey ? list.length - 1 : 0) : (at + (e.shiftKey ? list.length - 1 : 1)) % list.length
    list[to].focus()
  }
  document.addEventListener('focusin', e => {
    // A dialog above the window (the sheet of keys) keeps its own focus.
    if (isOpen && e.target instanceof Node && !root.contains(e.target) && !e.target.closest?.('dialog[open]')) rescueFocus()
  })

  // ── keyboard ────────────────────────────────────────────────────────────
  // Which key does what is written in keys.js (the scope "focus"), as for the rest of the app;
  // here is what the window does with them. Only Tab and the enlarged picture are heard here.
  document.addEventListener('keydown', e => {
    if (!isOpen || document.querySelector('dialog[open]')) return
    if (e.key === 'Tab') return trapTab(e)
    if (!zoom || e.metaKey || e.ctrlKey || e.altKey) return
    const handled = () => { e.preventDefault(); e.stopPropagation() }
    if (e.key === 'Escape') { zoom.close(); handled() }
    else if (e.key === 'ArrowLeft') { zoom.step(-1); handled() }
    else if (e.key === 'ArrowRight') { zoom.step(1); handled() }
  }, true)
  // While a picture is enlarged, the window's keys rest.
  const key = act => (arg, e) => (zoom ? false : act(arg, e))
  const thumb = which => key(() => { const pick = shown?.[which]; if (pick) submit(shown, [pick]) })
  /** Open the line to ask back on the card that is up. */
  function ask() {
    const open = shown?.askNode?.querySelector('.focus-ask-open')
    if (!open) return false
    open.click()
  }
  provide('focus', {
    active: () => isOpen,
    // In the window of one card there is no next and no previous.
    has: id => !(single && (id === 'focus.next' || id === 'focus.prev')),
    actions: {
      'focus.next': key(() => { if (!single) go(1) }),
      'focus.prev': key(() => { if (!single) go(-1) }),
      // a two-option card: the thumbs. Left is no, right is yes, as the tiles stand.
      'focus.yes': thumb('yesKey'),
      'focus.no': thumb('noKey'),
      'focus.later': key(() => later()),
      // The note while it is up; a little longer, the key alone.
      'focus.back': key(() => { backNow() }),
      'focus.explain': key(() => explain()),
      'focus.send': key(() => { if (!shown?.multi) return false; shown.sendTile.click() }),
      'focus.pick': key(n => {
        const btn = shown?.optButtons[n - 1]
        if (!btn) return false
        if (shown.busy) return
        if (shown.multi) toggle(shown, btn.dataset.key)
        else submit(shown, [btn.dataset.key])
      }),
      'focus.choices': key(() => { const btn = shown?.optButtons[0]; if (!btn) return false; btn.focus() }),
      'focus.ask': key(ask),
      'focus.leave': key((_, e) => {
        const typing = e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
        if (typing) { typing.blur(); (shown?.node ?? sheet).focus({ preventScroll: true }) }
        else close()
      }),
    },
  })

  // ── touch: swipe the card sideways to move without answering ────────────
  // (in the window of one card there is nowhere to go: it only gives a little)
  let swallowClickUntil = 0
  stage.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' || e.button || drag || zoom || !shown || busyRec()) return
    if (e.target.closest?.('input, textarea, video, audio, pre, a, .focus-thumbs')) return
    drag = { pointer: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, t0: e.timeStamp, active: false, rec: shown }
  })
  stage.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.pointer) return
    const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0
    if (!drag.active) {
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        drag.active = true
        drag.x0 = e.clientX
        drag.t0 = e.timeStamp
        try { stage.setPointerCapture(e.pointerId) } catch {}
        drag.rec.node.removeAttribute('data-settle')
        drag.rec.node.dataset.drag = ''
      } else {
        if (Math.abs(dy) > 12) drag = null
        return
      }
    }
    const raw = e.clientX - drag.x0
    const idx = order.indexOf(current)
    const open = !single && (raw < 0 ? idx < order.length - 1 : idx > 0)
    drag.dx = open ? raw : raw * 0.22
    drag.rec.node.style.setProperty('--focus-dx', `${drag.dx.toFixed(1)}px`)
  })
  function endDrag(e) {
    if (!drag || e.pointerId !== drag.pointer) return
    const d = drag
    drag = null
    if (!d.active) return
    try { stage.releasePointerCapture(e.pointerId) } catch {}
    swallowClickUntil = performance.now() + 350
    const node = d.rec.node
    delete node.dataset.drag
    const speed = Math.abs(d.dx) / Math.max(1, e.timeStamp - d.t0)
    const far = Math.abs(d.dx) > 72 || (speed > 0.45 && Math.abs(d.dx) > 24)
    if (e.type !== 'pointercancel' && far && !single && go(d.dx < 0 ? 1 : -1)) return
    node.dataset.settle = ''
    node.style.setProperty('--focus-dx', '0px')
    setTimeout(() => { node.removeAttribute('data-settle'); if (!node.hasAttribute('data-drag')) node.style.removeProperty('--focus-dx') }, 300)
  }
  stage.addEventListener('pointerup', endDrag)
  stage.addEventListener('pointercancel', endDrag)
  stage.addEventListener('click', e => {
    if (performance.now() < swallowClickUntil) { swallowClickUntil = 0; e.stopPropagation(); e.preventDefault() }
  }, true)
  stage.addEventListener('animationend', e => {
    if (e.target.classList?.contains('focus-card')) e.target.removeAttribute('data-in')
  })

  // ── image zoom, inside the sheet ────────────────────────────────────────
  function openZoom(images, start, openerNode, onChange, rec = null) {
    if (zoom) return
    const box = el('div', 'focus-zoom')
    box.setAttribute('role', 'group')
    box.setAttribute('aria-label', 'Image view')
    box.tabIndex = -1
    const bar = el('div', 'focus-zoom-bar')
    const count = el('span', 'focus-zoom-count')
    const name = el('span', 'focus-zoom-name')
    const shut = button('focus-zoom-btn', 'Close image view')
    shut.append(icon('close'))
    bar.append(count, name, shut)
    const view = el('div', 'focus-zoom-view')
    const img = el('img', 'focus-zoom-img')
    img.draggable = false
    view.append(img)
    const prev = button('focus-zoom-btn focus-zoom-prev', 'Previous image')
    prev.append(icon('chevLeft'))
    const next = button('focus-zoom-btn focus-zoom-next', 'Next image')
    next.append(icon('chevRight'))
    prev.hidden = next.hidden = images.length < 2
    box.append(view, bar, prev, next)

    // The answers stay at hand while a picture is large (zoomAnswers): beside it, or under it in a narrow window.
    const side = rec && rec.card.kind !== 'permission' ? zoomAnswers(rec, to => show(to), () => closeZoom()) : null
    if (side) { box.dataset.answer = ''; box.append(side.node) }

    let i = start
    const show = to => {
      i = (to + images.length) % images.length
      img.src = images[i].url
      img.alt = images[i].name
      count.textContent = `${i + 1} / ${images.length}`
      count.hidden = images.length < 2
      name.textContent = images[i].name
      delete view.dataset.full
      onChange?.(i)
      side?.shown(i)
    }
    const closeZoom = () => {
      zoom = null
      box.remove()
      for (const n of [top, stage, foot]) n.inert = false
      delete root.dataset.zoom
      openerNode?.focus?.({ preventScroll: true })
      rescueFocus()
    }
    shut.addEventListener('click', closeZoom)
    prev.addEventListener('click', () => show(i - 1))
    next.addEventListener('click', () => show(i + 1))
    // tap the picture for its real size, tap beside it to go back
    view.addEventListener('click', e => {
      if (e.target === img) view.toggleAttribute('data-full')
      else closeZoom()
    })
    for (const n of [top, stage, foot]) n.inert = true
    root.dataset.zoom = ''
    sheet.append(box)
    zoom = { box, closeBtn: shut, close: closeZoom, step: d => { if (images.length > 1) show(i + d) } }
    show(start)
    shut.focus({ preventScroll: true })
  }

  /** The answers of a card for the enlarged picture: every option as a tag (one tap answers and closes the
   *  picture; on a card that takes several, a tap ticks and "Send" sends), the agent's advice circled as on
   *  the card, and Explain and Later under them. Where it is plain which picture belongs to which option
   *  (rec.pictureOf), the option of the picture shown is marked and offered as the first action ("Take this
   *  one: Desk"), and an option under the pointer or the keyboard shows its picture.
   *  show(index) turns to a picture, shut() closes the view. Returns { node, shown(index) }. */
  function zoomAnswers(rec, show, shut) {
    const card = rec.card
    const multi = rec.multi
    const optionAt = new Map([...(rec.pictureOf ?? [])].map(([key, at]) => [at, key]))
    const advisedKeys = new Set([].concat(card.recommended ?? []))
    const node = el('aside', 'focus-zoom-answer')
    node.setAttribute('aria-label', multi ? 'Your answers. Choose one or more, then send.' : 'Your answer. One tap answers.')
    const answer = keys => { shut(); submit(rec, keys) }
    const take = button('focus-zoom-take')
    take.hidden = true
    const list = el('div', 'focus-opts focus-zoom-opts')
    list.dataset.count = 'tags'
    list.toggleAttribute('data-multi', multi)
    const line = el('p', 'focus-tag-line')
    const buttons = card.options.map(o => {
      const b = button('focus-opt')
      b.dataset.key = o.key
      const advised = advisedKeys.has(o.key)
      if (advised) { b.classList.add('is-advised'); b.append(adviceLoop()) }
      b.title = [o.detail, advised ? 'The agent recommends this' : ''].filter(Boolean).join(' · ')
      const words = el('span', 'focus-opt-words')
      words.append(el('span', 'focus-opt-label', rec.labelOf(o)))
      if (advised) words.append(el('span', 'focus-sr', ', recommended by the agent'))
      b.append(words)
      b.addEventListener('click', () => { if (multi) { toggle(rec, o.key); paint() } else answer([o.key]) })
      const look = () => {
        line.replaceChildren(el('b', null, rec.labelOf(o)), o.detail ? `: ${o.detail}` : '', advised ? ' · the agent would take it' : '')
        const at = rec.pictureOf?.get(o.key)
        if (at != null && at !== now) show(at)
      }
      b.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') look() })
      b.addEventListener('focus', look)
      list.append(b)
      return b
    })
    let send = null
    if (multi) {
      send = button('focus-opt focus-opt-send is-lead')
      send.addEventListener('click', () => answer(card.options.map(o => o.key).filter(k => rec.picked.has(k))))
      list.append(send)
    }
    // Explain and Later, as under the composer: both leave the card.
    const ways = el('div', 'focus-zoom-ways')
    const explainTwin = button('focus-later focus-explain', 'Explain: ask the session to explain this question')
    explainTwin.append(askMark.cloneNode(true), el('span', null, 'Explain'))
    explainTwin.addEventListener('click', () => { shut(); explain() })
    const laterTwin = button('focus-later', 'Later: put this question off')
    laterTwin.append(sketch('later'), el('span', null, 'Later'))
    laterTwin.addEventListener('click', () => { shut(); later() })
    ways.append(explainTwin, laterTwin)
    node.append(take, list, line, ways)

    let now = -1
    let mine = null   // the option that belongs to the picture shown
    function paint() {
      for (const b of buttons) {
        if (multi) b.setAttribute('aria-pressed', String(rec.picked.has(b.dataset.key)))
        b.toggleAttribute('data-match', b.dataset.key === mine?.key)
      }
      if (send) {
        const n = rec.picked.size
        send.disabled = !n
        send.replaceChildren(el('span', 'focus-opt-label', n ? `Send ${n}` : 'Send'))
        paintPicked(rec)
      }
      take.hidden = !mine
      if (!mine) return
      const word = multi ? (rec.picked.has(mine.key) ? 'Untick this one' : 'Tick this one') : 'Take this one'
      take.replaceChildren(el('small', null, word), el('b', null, rec.labelOf(mine)))
      take.classList.toggle('is-advised', advisedKeys.has(mine.key))
      if (advisedKeys.has(mine.key)) take.append(adviceLoop())
    }
    take.addEventListener('click', () => {
      if (!mine) return
      if (multi) { toggle(rec, mine.key); paint() } else answer([mine.key])
    })
    return {
      node,
      shown(at) {
        now = at
        mine = card.options.find(o => o.key === optionAt.get(at)) ?? null
        paint()
      },
    }
  }

  // ── open and close ──────────────────────────────────────────────────────
  /** Without a card: the walk, from the most urgent question. With one: the window of that
   *  card alone (the walk, if that card is not open any more). While open, open(id) goes there. */
  function open(cardId) {
    if (isOpen) {
      if (cardId) go(cardId)
      return
    }
    clearTimeout(closeTimer)
    teardown()
    opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
    isOpen = true
    started = false
    decidedCount = 0
    // A card that is no longer open cannot be shown alone; then the walk starts at the front.
    // Before the first state (a link to a card, followed on page load) that cannot be told yet.
    const card = cardId ? pool()?.cards.find(c => c.id === cardId) : null
    single = Boolean(card) && card.status === 'open' && !decidedLocal.has(cardId)
    wanted = cardId && !isLoaded() ? cardId : null
    root.toggleAttribute('data-single', single)
    current = single ? cardId : null
    root.hidden = false
    root.removeAttribute('data-closing')
    document.documentElement.classList.add('focus-lock')
    inerted = [...document.body.children].filter(n => n !== root && !n.inert && !/^(SCRIPT|STYLE|LINK)$/.test(n.tagName))
    for (const n of inerted) n.inert = true
    sync('none')
    if (!isOpen) return
    ;(sheet.dataset.state === 'done' ? doneBtn : shown?.node ?? sheet).focus({ preventScroll: true })
    if (shown) announce(describe(shown))
    spoken = null
    voice()
    document.dispatchEvent(new CustomEvent('focus:open'))
  }

  /** Drop every card node and timer; the window starts fresh next time. */
  function teardown() {
    zoom?.close()
    hideUndo(true)
    clearTimeout(infoTimer)
    infoNode.hidden = true
    hintBtn.hidden = true
    hintId = null
    pendingJump = null
    jumpMotion = null
    drag = null
    for (const rec of recs.values()) clearTimeout(rec.outTimer)
    recs.clear()
    shown = null
    order = []
    current = null
    delete meta.dataset.sig
    stage.replaceChildren()
    railReset()
  }

  function close() {
    if (!isOpen) return
    isOpen = false
    wanted = null
    stopReading()
    stopDictation()
    zoom?.close()
    for (const m of stage.querySelectorAll('video, audio')) { try { m.pause() } catch {} }
    for (const n of inerted) n.inert = false
    inerted = []
    document.documentElement.classList.remove('focus-lock')
    const finish = () => { root.hidden = true; root.removeAttribute('data-closing'); teardown() }
    clearTimeout(closeTimer)
    if (still()) finish()
    else { root.dataset.closing = ''; closeTimer = setTimeout(finish, 200) }
    const back = opener
    opener = null
    if (back?.isConnected) back.focus({ preventScroll: true })
    else document.activeElement?.blur?.()
    document.dispatchEvent(new CustomEvent('focus:close'))
  }

  // ── wiring ──────────────────────────────────────────────────────────────
  closeBtn.addEventListener('click', close)
  doneBtn.addEventListener('click', close)
  backdrop.addEventListener('click', close)
  laterBtn.addEventListener('click', later)
  explainBtn.addEventListener('click', explain)
  prevBtn.addEventListener('click', () => go(-1))
  nextBtn.addEventListener('click', () => go(1))
  hintBtn.addEventListener('click', () => { const id = hintId; hintId = null; if (!go(id)) paintHint() })
  subscribe(state => { lastState = state; sync() })

  return { open, close, ask, isOpen: () => isOpen }
}
