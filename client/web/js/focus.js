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
import { readCard, stopReading } from './speech.js'
import { el, rich, ago, agoNode, kindOf, mediaNodes, sketch, doodle } from './ui.js'

const RANK = { low: 0, normal: 1, high: 2, critical: 3 }
const LOCAL_DECIDED_TTL = 20000  // hide a card answered here until the server confirms, at most this long
const UNDO_MS = 10000
const INFO_MS = 6000
const OUT_MS = 220

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

/** Several answers at once (a card with `multiple`): the same request as decide(), with keys. */
async function decideMany(cardId, keys, note) {
  const res = await fetch('/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ card_id: cardId, keys, note }) })
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
  const undoBtn = button('focus-undo')
  undoBtn.hidden = true
  const infoNode = el('p', 'focus-info')
  infoNode.hidden = true
  notes.append(hintBtn, undoBtn, infoNode)
  // Later: always in the same place, on every card. The question goes to the end of the line.
  const laterBtn = button('focus-later', 'Later: put this question off')
  laterBtn.title = 'Later (L)'
  laterBtn.append(sketch('later'), el('span', null, 'Later'))
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
  top.append(meta, notes, laterBtn, sayBtn, closeBtn)

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

  sheet.append(top, stage, done, loading, foot, live)
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
  let undoTimer = 0
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
    return { id: card.id, card, node, sigC: '', note: '', askText: '', askOpen: false, picked: new Set(), busy: false, outTimer: 0, optButtons: [], imageAt: 0, threadSig: null }
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
      figure.addEventListener('click', () => openZoom(images, rec.imageAt, figure, pick))
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

    // Asking back: instead of answering, a question to the agent about this card. It is
    // sent as a chat message that names the card, the card stays open, and what was asked
    // and what the agent replies stands under the card as a short thread. Quiet until used.
    rec.threadNode = null
    rec.askNode = null
    rec.askField = null
    if (!permission) {
      rec.threadNode = el('div', 'focus-thread')
      rec.threadNode.hidden = true
      rec.threadSig = null
      const ask = el('form', 'focus-ask')
      ask.noValidate = true
      const askOpen = button('focus-ask-open')
      askOpen.append(sketch('hand'), el('span', null, 'Ask back'))
      const field = el('input', 'focus-ask-field')
      field.type = 'text'
      field.placeholder = 'Ask the agent about this question'
      field.autocomplete = 'off'
      field.enterKeyHint = 'send'
      field.setAttribute('aria-label', 'Ask back: a question to the agent about this card. The card stays open.')
      field.value = rec.askText
      const send = button('focus-ask-send', 'Send the question to the agent')
      send.type = 'submit'
      send.title = 'Ask (Enter)'
      send.append(icon('up'))
      send.disabled = !rec.askText.trim()
      ask.append(askOpen, field, send)
      ask.toggleAttribute('data-open', rec.askOpen)
      askOpen.addEventListener('click', () => { rec.askOpen = true; ask.setAttribute('data-open', ''); field.focus({ preventScroll: true }) })
      field.addEventListener('input', () => { rec.askText = field.value; send.disabled = !field.value.trim() })
      ask.addEventListener('submit', e => { e.preventDefault(); askBack(rec) })
      rec.askNode = ask
      rec.askField = field
      rec.askSend = send
      scroll.append(rec.threadNode, ask)
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
    opts.dataset.count = duo ? 'duo' : 'stack'
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
      else words.append(el('span', 'focus-opt-label', labelOf(o)))
      if (o.detail) words.append(el('span', 'focus-opt-detail', o.detail))
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
    if (!permission) {
      const note = el('input', 'focus-note')
      note.type = 'text'
      note.placeholder = 'Add a note?'
      note.autocomplete = 'off'
      note.enterKeyHint = 'done'
      note.setAttribute('aria-label', 'Note for the agent, optional. It is sent with your answer.')
      note.value = rec.note
      note.addEventListener('input', () => { rec.note = note.value })
      note.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); note.blur(); node.focus({ preventScroll: true }) } })
      rec.noteNode = note
      answer.append(note)
    }

    node.replaceChildren(scroll, answer)
    if (multi) paintPicked(rec)
    paintThread(rec)
    scroll.scrollTop = scrollTop
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

  // ── asking back ─────────────────────────────────────────────────────────
  /** The thread under a card: what the state holds about it (messages that name the card),
   *  and what was asked from here that the state does not show yet. */
  function paintThread(rec) {
    if (!rec.threadNode) return
    const told = (pool()?.messages ?? []).filter(m => m.card_id === rec.id && m.from !== 'event')
    const mine = (asked.get(rec.id) ?? []).filter(a => !(a.state === 'sent' && told.some(m => m.from === 'user' && m.text === a.text)))
    if (asked.has(rec.id)) asked.set(rec.id, mine)
    const items = [
      ...told.map(m => ({ from: m.from === 'user' ? 'user' : 'agent', text: m.text, ts: m.ts, state: '' })),
      ...mine.map(a => ({ from: 'user', text: a.text, ts: a.ts, state: a.state, error: a.error })),
    ].sort((a, b) => a.ts - b.ts)
    const sig = JSON.stringify(items)
    if (sig === rec.threadSig) return
    rec.threadSig = sig
    rec.threadNode.hidden = !items.length
    const nodes = items.map(item => {
      const msg = el('div', 'focus-msg')
      msg.dataset.from = item.from
      const head = el('div', 'focus-msg-head')
      head.append(el('b', null, item.from === 'user' ? 'You' : rec.card.agent_name || 'Agent'), agoNode(item.ts, 'focus-msg-ago'))
      const body = item.from === 'user' ? el('p', 'focus-msg-text', item.text) : rich(item.text)
      msg.append(head, body)
      if (item.state === 'sending') msg.append(el('p', 'focus-msg-state', 'Sending'))
      if (item.state === 'failed') { msg.dataset.failed = ''; msg.append(el('p', 'focus-msg-state', `Not sent: ${item.error}`)) }
      return msg
    })
    const last = items[items.length - 1]
    if (last && last.from === 'user' && last.state !== 'sending' && last.state !== 'failed') {
      nodes.push(el('p', 'focus-thread-wait', 'Sent. The reply will show up here; the question stays open.'))
    }
    rec.threadNode.replaceChildren(...nodes)
    if (items.length && !rec.askOpen) { rec.askOpen = true; rec.askNode?.setAttribute('data-open', '') }
  }

  async function askBack(rec) {
    const text = rec.askText.trim()
    if (!text) return rec.askField?.focus({ preventScroll: true })
    const entry = { text, ts: Date.now(), state: 'sending', error: '' }
    asked.set(rec.id, [...(asked.get(rec.id) ?? []).filter(a => a.state !== 'failed'), entry])
    rec.askText = ''
    if (rec.askField) { rec.askField.value = ''; rec.askSend.disabled = true }
    paintThread(rec)
    rec.scroll.scrollTop = rec.scroll.scrollHeight
    try {
      await sendMessage(text, rec.card.agent, rec.id)
      entry.state = 'sent'
      announce('Your question was sent to the agent. The card stays open.')
    } catch (err) {
      entry.state = 'failed'
      entry.error = err?.message || 'The server did not answer.'
      announce(`Your question was not sent: ${entry.error}`)
    }
    const now = recs.get(rec.id)
    if (!now) return
    // a failed question goes back into the field, unless the human is already typing the next one
    if (entry.state === 'failed' && !now.askText && now.askField) { now.askText = text; now.askField.value = text; now.askSend.disabled = false }
    paintThread(now)
    now.scroll.scrollTop = now.scroll.scrollHeight
  }

  // ── answering ───────────────────────────────────────────────────────────
  const request = (card, keys, note) => (card.multiple ? decideMany(card.id, keys, note) : decide(card.id, keys[0], note))

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
      if (card.kind !== 'permission') offerUndo(card, option)
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
    if (undoBtn.dataset.card === card.id) hideUndo()
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
    if (single) { putOff(rec.id); return close() }
    const at = order.indexOf(rec.id)
    const next = order[at + 1] ?? order.find(id => id !== rec.id)
    if (!next) return info('This is the only open question.')
    pendingJump = next
    jumpMotion = 'later'
    putOff(rec.id)   // the store tells every subscriber, this window included: sync() runs in here
    announce(`Put off: ${rec.card.title}`)
  }

  // ── undo, info, hint: the notes in the top bar ──────────────────────────
  function hideUndo() {
    clearTimeout(undoTimer)
    undoBtn.hidden = true
    undoBtn.onclick = null
    delete undoBtn.dataset.card
  }

  function offerUndo(card, option) {
    hideUndo()
    // The card number is no longer shown; it stays in the tooltip for whoever looks for it.
    const text = el('span', 'focus-undo-text')
    text.append('Answered: ', el('b', null, option?.label ?? ''))
    const cta = el('span', 'focus-undo-cta')
    cta.append(icon('undo'), 'Undo')
    undoBtn.replaceChildren(text, cta, el('i', 'focus-undo-time'))
    undoBtn.title = `Undo (U) · question ${card.number}: ${card.title}`
    undoBtn.setAttribute('aria-label', `Undo the answer "${option?.label ?? ''}" to: ${card.title}`)
    undoBtn.dataset.card = card.id
    undoBtn.disabled = false
    undoBtn.hidden = false
    undoBtn.onclick = async () => {
      clearTimeout(undoTimer)
      undoBtn.disabled = true
      try {
        // The answer may still be on its way; it has to arrive before it can be taken back.
        // If it does not arrive, there is nothing to take back: its card returns by itself.
        const sending = inflight.get(card.id)
        if (sending && !(await sending.then(() => true, () => false))) return
        await reopen(card.id)
      } catch (err) {
        hideUndo()
        info(`Not undone: ${err?.message || 'The server did not answer.'}`, true)
        return
      }
      hideUndo()
      decidedLocal.delete(card.id)
      decidedCount = Math.max(0, decidedCount - 1)
      pendingJump = card.id
      jumpMotion = 'prev'
      setTimeout(() => { if (pendingJump === card.id) pendingJump = null }, 5000)
      sync()
      announce(`Answer taken back: ${card.title}`)
    }
    undoTimer = setTimeout(hideUndo, UNDO_MS)
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
      const sigC = JSON.stringify([card.kind, card.title, card.body, card.options, card.recommended, card.multiple, card.attachments, card.agent_name])
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
    meta.title = `Question ${card.number}`
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
    if (isOpen && e.target instanceof Node && !root.contains(e.target)) rescueFocus()
  })

  // ── keyboard ────────────────────────────────────────────────────────────
  document.addEventListener('keydown', e => {
    if (!isOpen) return
    if (e.key === 'Tab') return trapTab(e)
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const handled = () => { e.preventDefault(); e.stopPropagation() }
    if (zoom) {
      if (e.key === 'Escape') { zoom.close(); handled() }
      else if (e.key === 'ArrowLeft') { zoom.step(-1); handled() }
      else if (e.key === 'ArrowRight') { zoom.step(1); handled() }
      return
    }
    const t = e.target instanceof Element ? e.target : null
    const typing = t?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
    if (e.key === 'Escape') {
      if (typing) { typing.blur(); (shown?.node ?? sheet).focus({ preventScroll: true }) }
      else close()
      return handled()
    }
    if (typing || t?.closest('video, audio')) return
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
    const arrow = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0
    // next and previous without answering
    if (key === 'j' || key === 'k' || (arrow && e.shiftKey)) { if (!single) go(key === 'j' || arrow > 0 ? 1 : -1); return handled() }
    if (e.repeat) return arrow ? handled() : undefined
    // a two-option card: the thumbs. Left is no, right is yes, as the tiles stand.
    if (arrow || key === 'y' || key === 'n') {
      const pick = shown && (key === 'y' || arrow > 0 ? shown.yesKey : shown.noKey)
      if (pick) submit(shown, [pick])
      return handled()
    }
    if (key === 'l') { later(); return handled() }
    if (key === 'u') { if (!undoBtn.hidden && !undoBtn.disabled) undoBtn.click(); return handled() }
    if (key === 'Enter' && shown?.multi && !t?.closest('button, a')) { shown.sendTile.click(); return handled() }
    if (/^[1-9]$/.test(key) && !e.shiftKey && shown) {
      const btn = shown.optButtons[Number(key) - 1]
      if (!btn) return
      handled()
      if (shown.busy) return
      if (shown.multi) toggle(shown, btn.dataset.key)
      else submit(shown, [btn.dataset.key])
    }
  }, true)

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
  function openZoom(images, start, openerNode, onChange) {
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
    hideUndo()
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
  }

  function close() {
    if (!isOpen) return
    isOpen = false
    wanted = null
    stopReading()
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
  prevBtn.addEventListener('click', () => go(-1))
  nextBtn.addEventListener('click', () => go(1))
  hintBtn.addEventListener('click', () => { const id = hintId; hintId = null; if (!go(id)) paintHint() })
  subscribe(state => { lastState = state; sync() })

  return { open, close, isOpen: () => isOpen }
}
