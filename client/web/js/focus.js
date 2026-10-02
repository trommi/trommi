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

import { subscribe, decide, reopen, putOff, sendMessage, isLoaded, getState, closeInfo } from './store.js'
import { readCard, stopReading, dictationMic, startDictation, stopDictation, isDictating } from './speech.js'
import { provide } from './keys.js'
import { say, pageHost, backNow, forgetBack } from './back.js'
import { EXPLAIN_TEXT, cardNr } from './inbox.js'
import { cardMarks } from './focus-marks.js'
import { copyButton } from './cardclip.js'
import { richPlus, attachmentNodes } from './chat.js'
import { LATER_WORD, LATER_SKETCH, ACK_WORD, ACK_SKETCH, WHAT_WORD, WHAT_SKETCH, TRUST_WORD, TRUST_SKETCH, HANDBACK_WORD, HANDBACK_STATE, SHRED_WORD, SHRED_SKETCH, arrowStrokes } from './ui.js'
import { el, rich, ago, agoNode, kindOf, mediaNodes, sketch, doodle, adviceLoop, cardNote, linkInfo } from './ui.js'

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
  chevDown: 'M5 9l7 7 7-7',
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
// The word on the button that hands a card to its session.
const HAND_BACK_LABEL = HANDBACK_WORD
// An info card (something to read, nothing to decide) has two tiles in the place of options: this one closes it,
// the other is What??.
// The walk is the scrolling stack of all cards (false: one card at a time). A card that was answered, snoozed,
// revised or shredded leaves the stack; a note at the top left says what happened, with Back for a few seconds.
const LIST_WALK = true
const ACK_KEY = '\u0000ack', WHAT_KEY = '\u0000what'
const HAND_BACK_TEXT = 'Back to you: please revise this question and present it again.'
// The word on the button that asks the session to explain a question (the request sent to it is EXPLAIN_TEXT, as before).
const EXPLAIN_LABEL = WHAT_WORD
// Where a card's answers stand. false: a column of their own at the right, over the whole height of the card.
// true: at the top right beside the title, as tall as they need; what is asked flows at their left and takes the
// whole width under them. ("?head=1" or "?head=0" in the address tries the other.)
const ANSWERS_BESIDE_TITLE = false
// Where the row of the ways out (Revise, Snooze, the wastebasket) stands: 'options' (under the answers, in the
// decision) or 'discuss' (under the field of Discuss). One row, built in one place (fill), moved by this word.
const WAYS_PLACE = 'options'
// Writing on the card itself. false: a field at the foot of the card. true: no field; a click anywhere on what is
// asked begins a note at that place, the pen scribbles over everything (js/focus-marks.js), all of it is part of
// the card's draft, and the next action takes it along. ("?marks=1" or "?marks=0" in the address tries the other.)
const WRITE_ANYWHERE = true

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

/** An answer whose note carries files (pictures, a drawing): the same request as decide(), with attachments. */
async function decideWith(card, keys, note, attachments, notes = {}) {
  const body = { card_id: card.id, note, notes, ...(attachments.length ? { attachments } : {}), revised: card.revised ?? null, ...(card.multiple ? { keys } : { key: keys[0] }) }
  const res = await fetch('/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let out = {}
  try { out = await res.json() } catch {}
  if (!res.ok) throw new Error(out.error || res.statusText)
  return out
}
// What the human may attach in the composer: so many files, each up to this size.
const MAX_FILES = 12
const MAX_FILE_BYTES = 24 * 1024 * 1024
const readDataUrl = file => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result))
  reader.onerror = () => reject(reader.error ?? new Error('not readable'))
  reader.readAsDataURL(file)
})

export function mountFocus({ onDecided } = {}) {
  // This module is loaded when the window is first opened, its stylesheet with the page: in a page that has been
  // open for a while the two may be of different days. So the stylesheet is fetched again, to match this code.
  for (const link of document.querySelectorAll('link[rel="stylesheet"][href^="/css/focus.css"]')) {
    const fresh = link.cloneNode()
    fresh.href = `/css/focus.css?t=${Date.now()}`
    fresh.addEventListener('load', () => link.remove())
    link.after(fresh)
  }
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
  doneArt.append(sketch('tick'))
  const doneText = el('p', 'focus-done-text')
  const doneBtn = button('focus-done-btn')
  doneBtn.textContent = 'Close'
  done.append(doneArt, doneText, doneBtn)

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
  let pastId = null               // the window was opened on a card that is not open any more: it is shown to read
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
    const rec = { id: card.id, card, node, sigC: '', files: [], optNotes: new Map(), optRows: new Map(), wasKeys: [], draftTs: undefined, draftTimer: 0, askText: '', askOpen: false, picked: new Set(), busy: false, outTimer: 0, optButtons: [], imageAt: 0, threadSig: null }
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
    const { node } = rec
    // An info card is drawn like a question with two answers of the window's own: Acknowledge and What??.
    const info = rec.card.kind === 'info'
    // The time machine: an earlier version of the card is drawn in place of the live one, to read, not to answer.
    const earlier = rec.version != null ? rec.card.versions?.find(v => v.n === rec.version) ?? null : null
    if (!earlier) rec.version = null
    const base = earlier ? { ...rec.card, sections: undefined, html: undefined, ...earlier } : rec.card
    node.toggleAttribute('data-earlier', Boolean(earlier))
    const card = info ? { ...base, multiple: false, recommended: null, options: [{ key: ACK_KEY, label: ACK_WORD, detail: '' }, { key: WHAT_KEY, label: EXPLAIN_LABEL, detail: '' }] } : base
    const active = document.activeElement
    const hadFocus = node.contains(active)
    const typed = hadFocus && (active === rec.noteNode || active === rec.askField) ? { ask: active === rec.askField, sel: [active.selectionStart, active.selectionEnd] } : null
    const scrollTop = rec.scroll?.scrollTop ?? 0
    const permission = card.kind === 'permission'
    const attachments = card.attachments ?? []
    node.dataset.kind = permission ? 'permission' : info ? 'info' : 'decision'
    const titleId = `focus-title-${card.id}`
    node.setAttribute('aria-labelledby', titleId)

    const scroll = el('div', 'focus-scroll')
    rec.scroll = scroll
    rec.arrowAt = null
    scroll.addEventListener('scroll', () => { if (rec.pictureOf) linkPicture(rec) }, { passive: true })
    const title = el('h2', 'focus-title', card.title)
    title.id = titleId
    rec.reasonNode = el('p', 'focus-reason')
    rec.reasonNode.textContent = card.urgency_reason || ''
    rec.reasonNode.hidden = !card.urgency_reason
    const lead = el('div', 'focus-lead')
    rec.assetsNode = el('div', 'focus-assets')
    rec.assetsSig = null
    // (the quiet line under the title: who asks, which version, how long ago, what else is on the card; paintAssets)
    lead.append(title, rec.assetsNode, rec.reasonNode)

    // what the question is about: pictures and players
    const sections = !permission && Array.isArray(card.sections) ? card.sections : null
    const allImages = attachments.filter(a => kindOf(a) === 'image')
    // A picture that belongs to a paragraph stands with that paragraph; the gallery holds the rest.
    const pointed = new Set((sections ?? []).map(b => attachments[b.picture]).filter(Boolean))
    const images = allImages.filter(a => !pointed.has(a))
    rec.allImages = allImages
    rec.galleryImages = images
    const files = attachments.filter(a => kindOf(a) === 'file')
    const players = mediaNodes(attachments)
    const media = el('div', 'focus-media')
    rec.showImage = null
    rec.mediaNode = media
    rec.gridTiles = null
    // which picture belongs to which option, where that is plain to see (pairPictures)
    const pairs = permission || sections ? null : pairPictures(card.options, images)
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
      // The stage begins with the picture, large: above it which one it is and the quiet controls, at its sides the
      // steps to the one before and after. The card's title and text follow below it, by scrolling.
      const bar = el('div', 'focus-stage-bar')
      const where = el('span', 'focus-stage-where')
      const view = el('div', 'focus-stage-view')
      const stepBtn = (cls, label, by) => { const b = button(`focus-stage-step ${cls}`, label); b.append(icon(by < 0 ? 'left' : 'right')); b.hidden = images.length < 2; b.addEventListener('click', () => pick((rec.imageAt + by + images.length) % images.length)); return b }
      view.append(figure, stepBtn('is-prev', 'The picture before', -1), stepBtn('is-next', 'The next picture', 1))
      const thumbs = []
      const pick = i => {
        rec.imageAt = i
        img.src = images[i].url
        caption.textContent = images.length > 1 ? `${i + 1} / ${images.length} · ${images[i].name}` : images[i].name
        where.replaceChildren(...(images.length > 1 ? [el('b', null, `${i + 1} / ${images.length}`)] : []), el('span', null, images[i].name))
        figure.setAttribute('aria-label', `Enlarge image ${i + 1} of ${images.length}: ${images[i].name}`)
        thumbs.forEach((t, k) => t.setAttribute('aria-pressed', String(k === i)))
        const page = images[i].page?.url
        pageLink.hidden = !page
        if (page) { pageLink.href = page; pageLink.lastChild.textContent = images[i].title ? `Open the page: ${images[i].title}` : 'Open the page' }
        rec.gridTiles?.forEach((t, k) => t.toggleAttribute('data-lit', k === i))
        tiePicture(rec, true)
      }
      // a picture that carries the page it was rendered from: a quiet link right under it
      const pageLink = el('a', 'focus-page-link')
      pageLink.target = '_blank'
      pageLink.rel = 'noopener noreferrer'
      pageLink.append(sketch('page'), el('span'))
      pageLink.hidden = true
      rec.showImage = pick
      figure.addEventListener('click', e => e.target.closest('.focus-figure-zoom') && openZoom(allImages, allImages.indexOf(images[rec.imageAt]), figure, i => { const at = images.indexOf(allImages[i]); if (at >= 0) pick(at) }, rec))
      bar.append(where, pageLink)
      media.append(bar, view)
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
      // Four or more pictures that each belong to an option stand as a grid: all at once, each with the word of its
      // option. An option under the pointer lights its picture, a picture under the pointer marks its option;
      // "Take" (or a double click) answers, a click enlarges. The one large picture is a toggle away.
      if (pairs && pairs.size >= 4) {
        const keyAt = new Map([...pairs].map(([key, at]) => [at, key]))
        const grid = el('div', 'focus-grid')
        rec.gridTiles = images.map((a, i) => {
          const o = card.options.find(x => x.key === keyAt.get(i))
          const tile = el('div', 'focus-grid-tile')
          if (o) tile.dataset.key = o.key
          const pic = button('focus-grid-pic', `Enlarge ${a.name}`)
          const small = el('img')
          small.src = a.url
          small.alt = o?.label ?? a.name
          small.loading = 'lazy'
          small.draggable = false
          pic.append(small)
          const answer = () => { if (o) (card.multiple ? toggle(rec, o.key) : submit(rec, [o.key])) }
          pic.addEventListener('click', e => { if (e.detail > 1) return; pick(i); openZoom(allImages, allImages.indexOf(a), pic, at => { const k = images.indexOf(allImages[at]); if (k >= 0) pick(k) }, rec) })
          pic.addEventListener('dblclick', () => { zoom?.close(); answer() })
          const cap = el('div', 'focus-grid-cap')
          cap.append(el('span', null, o?.label ?? a.name))
          if (o) {
            const take = button('focus-grid-take', `${card.multiple ? 'Tick' : 'Take'} ${o.label}`)
            take.textContent = card.multiple ? 'Tick' : 'Take'
            take.addEventListener('click', answer)
            cap.append(take)
          }
          tile.append(pic, cap)
          if (a.page?.url) {
            const link = el('a', 'focus-page-link')
            link.href = a.page.url
            link.target = '_blank'
            link.rel = 'noopener noreferrer'
            link.append(sketch('page'), el('span', null, 'Open the page'))
            tile.append(link)
          }
          for (const type of ['pointerenter', 'focusin']) tile.addEventListener(type, () => { if (rec.imageAt !== i) pick(i) })
          grid.append(tile)
          return tile
        })
        const flip = button('focus-grid-flip')
        const paintView = () => {
          media.dataset.view = rec.galleryView ?? 'one'
          flip.textContent = media.dataset.view === 'grid' ? 'One large picture' : 'All in a grid'
        }
        flip.addEventListener('click', () => { rec.galleryView = media.dataset.view === 'grid' ? 'one' : 'grid'; paintView(); linkPicture(rec) })
        media.append(grid)
        pageLink.before(flip)
        paintView()
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
    } else if (sections) {
      text.append(sectionsNode(rec, sections))
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
    // (a grid of pictures takes the whole width, the text under it)
    const stageFirst = images.length > 0   // pictures open the stage; players stay with the text
    node.toggleAttribute('data-pictures', stageFirst)
    body.dataset.layout = stageFirst ? 'text' : hasMedia && hasText ? 'split' : hasMedia ? 'media' : 'text'
    if (hasMedia && !stageFirst) body.append(media)
    if (hasText) body.append(text)
    if (earlier) {
      // which version this is, the way through the others, and the way back to the live one
      const all = [...rec.card.versions.map(v => v.n), rec.card.version ?? rec.card.versions.at(-1).n + 1]
      const bar = el('div', 'focus-earlier')
      const says = el('span', 'focus-earlier-says')
      says.append(sketch('timemachine'), el('b', null, `Version ${earlier.n} of ${all.at(-1)}`), ` · as it was ${ago(earlier.at)}${earlier.note ? ` · ${earlier.note}` : ''}`)
      const step = (label, word, to) => { const b = button('focus-earlier-step', label); b.textContent = word; b.disabled = to == null; b.addEventListener('click', () => viewVersion(rec, to)); return b }
      const at = all.indexOf(earlier.n)
      bar.append(says, step('The version before', 'Older', all[at - 1]), step('The version after', 'Newer', all[at + 1]), step('Back to the question as it stands now', 'Back to now', all.at(-1)))
      scroll.append(bar)
    }
    if (stageFirst) scroll.append(media)
    scroll.append(lead)
    if ((hasMedia && !stageFirst) || hasText) scroll.append(body)

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
      field.placeholder = 'Write to the agent'
      field.autocomplete = 'off'
      field.enterKeyHint = 'send'
      field.setAttribute('aria-label', 'Write to the agent about this question. Enter asks it and the question stays open; an answer takes what you wrote along as a note.')
      field.value = rec.askText
      // Send stands in the field, at its right end beside the microphone: a plain small button with the pen's arrow.
      const send = button('focus-ask-send', 'Send to the agent')
      send.type = 'submit'
      send.title = 'Send (Enter). The question stays open.'
      send.append(sketch('send'))
      // Files and pictures: by the paperclip, by dropping them on the composer, or by pasting (a screenshot from
      // the clipboard). They stand as small chips over the field until they are sent, with the message or with an answer.
      const clip = button('focus-clip', 'Attach files or pictures')
      clip.title = 'Attach files or pictures (or drop them here, or paste a screenshot)'
      clip.append(sketch('clip'))
      const picker = el('input')
      picker.type = 'file'
      picker.multiple = true
      picker.hidden = true
      picker.tabIndex = -1
      clip.addEventListener('click', () => picker.click())
      picker.addEventListener('change', () => { addFiles(rec, picker.files); picker.value = '' })
      rec.chipsNode = el('div', 'focus-chips')
      // The pen: the same composer as a small scratchpad. What is drawn there goes along as a picture, with what is typed.
      const pen = button('focus-clip focus-pen', 'Draw instead of typing')
      pen.title = 'Draw: scribble here instead of typing, or as well'
      pen.append(sketch('pen'))
      pen.setAttribute('aria-pressed', String(pad?.rec === rec))
      pen.addEventListener('click', () => openPad(rec))
      rec.penBtn = pen
      rec.annotate = file => openPad(rec, file)
      // No Send: what is written is kept as it is written (the card's draft on the hub, the same on every device),
      // and the next thing the human does takes it along: an answer as its note, Back to agent and What?? as the
      // message, Trust as the note; Snooze leaves it on the card. The end of the field says where the words are.
      rec.saveNode = el('span', 'focus-saved')
      rec.saveNode.setAttribute('role', 'status')
      ask.append(rec.chipsNode, askOpen, clip, pen, picker, field, send, rec.saveNode)
      field.addEventListener('blur', () => flushDraft(rec))
      if (pad?.rec === rec) { rec.chipsNode.after(padHost); ask.dataset.pad = '' }   // the card was rebuilt while its scratchpad is open
      field.addEventListener('paste', e => {
        const files = [...(e.clipboardData?.files ?? [])]
        if (!files.length) return
        e.preventDefault()
        addFiles(rec, files)
      })
      const carriesFiles = e => [...(e.dataTransfer?.types ?? [])].includes('Files')
      ask.addEventListener('dragover', e => { if (carriesFiles(e)) { e.preventDefault(); ask.dataset.drop = '' } })
      ask.addEventListener('dragleave', e => { if (!ask.contains(e.relatedTarget)) delete ask.dataset.drop })
      ask.addEventListener('drop', e => {
        if (!carriesFiles(e)) return
        e.preventDefault()
        delete ask.dataset.drop
        addFiles(rec, e.dataTransfer.files)
      })
      field.after(dictationMic(field, { key: `${rec.id}:ask`, primary: true, onError: text => info(text, true) }))   // speak instead of typing (speech.js)
      askOpen.addEventListener('click', () => field.focus({ preventScroll: true }))
      field.addEventListener('input', () => { rec.askText = field.value; paintDraft(rec) })   // (paintDraft also sees to the draft on the hub)
      // Enter sends with a real keyboard, Shift+Enter breaks the line; on a touch screen Enter stays a line break
      // and the button sends, as in the session's conversation. Never while an IME is composing.
      field.addEventListener('keydown', e => {
        if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return
        // Enter: back to the agent, with these words (nothing happens on an empty field: no card leaves by a slip).
        // Ctrl/Cmd+Enter: say it and stay on the card. On a touch screen Enter is a line break; the buttons act.
        if (touchOnly.matches && !e.ctrlKey && !e.metaKey) return
        e.preventDefault()
        claim(rec)
        // Revise was pressed with nothing said: this Enter hands the card back, with or without words
        if (rec.revising) { rec.revising = false; field.placeholder = 'Write to the agent'; return void handBack(true) }
        if (!field.value.trim() && !rec.files.length) return
        if (rec.asking) { rec.asking = false; field.placeholder = 'Write to the agent'; explain() }
        else askBack(rec)
      })
      send.addEventListener('mousedown', e => e.preventDefault())   // the caret stays in the field
      ask.addEventListener('submit', e => { e.preventDefault(); askBack(rec) })
      rec.askNode = ask
      rec.askField = field
      rec.askSend = send
      // The ways out, one row: Revise (hand the card back to its session), Snooze and, apart and quiet, the wastebasket.
      rec.actionsNode = el('div', 'focus-actions')
      // their order, here as on a row of the desk: Snooze, Revise, Whatever, Shred
      rec.actionsNode.append(wayButton('snooze', () => { claim(rec); later() }), wayButton('hand', () => { claim(rec); handBack() }), wayButton('shred', () => shredIt(rec)))
      // The question is thrown back and forth, so what was said about it is part of the card: it follows under the
      // decision in the one column that scrolls, in the order of time, and the field stands at the foot of that
      // column, always in reach.
      rec.discussScroll = null
      rec.composer = el('div', 'focus-composer')
      rec.composer.append(ask)
      scroll.append(rec.threadNode)
      if (WAYS_PLACE === 'discuss') rec.composer.append(rec.actionsNode)
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
    rec.pictureOf = permission ? null
      : sections ? new Map(sections.filter(b => b.key != null && pointed.has(attachments[b.picture])).map(b => [b.key, allImages.indexOf(attachments[b.picture])]))
      : pairs
    if (rec.pictureOf && !rec.pictureOf.size) rec.pictureOf = null
    rec.optRows = new Map()
    rec.draftSent ??= JSON.stringify(draftOf(rec))
    opts.toggleAttribute('data-multi', multi)
    const groups = optionGroups(sections)
    rec.groups = groups.length > 1 ? groups : null
    opts.toggleAttribute('data-groups', Boolean(rec.groups))
    for (const o of options) {
      const group = rec.groups?.find(g => g.keys[0] === o.key)
      if (group) opts.append(el('p', 'focus-opt-group', group.title))
      const b = button('focus-opt')
      b.dataset.key = o.key
      const advised = advisedKeys.has(o.key)
      if (advised) { b.classList.add('is-advised'); b.title = 'The agent recommends this' }
      const mark = el('span', 'focus-opt-mark')
      mark.setAttribute('aria-hidden', 'true')
      if (duo) {
        const lead = isYes(o)
        if (lead) b.classList.add('is-lead')
        mark.append(sketch(o.key === WHAT_KEY ? WHAT_SKETCH : o.key === ACK_KEY ? ACK_SKETCH : lead ? 'yes' : NEGATIVE.test(o.label) || o.key === 'deny' ? 'no' : 'other'))
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
        // (On an info card "What??" is set in plain type like its neighbour: the drawn question mark above it is the
        // tile's one drawing.)
        const label = el('span', 'focus-opt-label', labelOf(o))
        // A word under a thumb breaks only at spaces and hyphens; one long word is set smaller until it fits.
        // (Both words of a pair take the size of the longer one, so the two tiles read as one pair.)
        const longest = Math.max(...(duo ? options : [o]).flatMap(x => labelOf(x).split(/[\s-]+/)).map(w => w.length))
        if (duo && longest > 10) label.style.fontSize = `${Math.max(.62, 10 / longest).toFixed(2)}em`
        // In a stack of options the pen goes round the words of the advised one (ui.js draws the mark).
        if (advised) (tags ? b : label).append(adviceLoop())
        words.append(label)
      }
      if (o.detail) words.append(el('span', 'focus-opt-detail', o.detail))
      if (tags) b.title = [o.detail, advised ? 'The agent recommends this' : ''].filter(Boolean).join(' · ')
      if (advised && !bare) words.append(el('span', 'focus-sr', ', recommended by the agent'))
      b.append(mark)
      if (words.childNodes.length) b.append(words)
      b.addEventListener('click', () => (multi ? toggle(rec, o.key) : submit(rec, [o.key])))
      rec.optButtons.push(b)
      if (!permission && !info) b.append(optionPencil(rec, o.key, labelOf(o)))
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
    }
    answer.append(rec.errorNode, opts)
    // (Send is not one of the list: it stands under it, so the list ends above it and it never covers an option)
    if (rec.sendTile) answer.append(rec.sendTile)
    // Whatever (leave the decision to the session): the shrugging figure in the row of the ways out. Under the
    // pointer or the keyboard it lights the option the session would take, and its label names it.
    rec.trustBtn = null
    if (!permission && !info && !earlier && rec.actionsNode) {
      const advice = card.options.filter(o => advisedKeys.has(o.key)).map(labelOf).join(', ')
      const trustBtn = wayButton('trust', () => trustIt(rec))
      const says = advice ? `${TRUST_WORD} (R): the agent takes what it advised: ${advice}` : `${TRUST_WORD} (R): the agent decides itself`
      trustBtn.title = says
      trustBtn.setAttribute('aria-label', says)
      const lightUp = on => () => { for (const b of rec.optButtons) if (advisedKeys.has(b.dataset.key)) b.toggleAttribute('data-lit', on); for (const [key, sec] of rec.secNodes ?? []) if (advisedKeys.has(key)) sec.toggleAttribute('data-lit', on) }
      for (const type of ['pointerenter', 'focus']) trustBtn.addEventListener(type, lightUp(true))
      for (const type of ['pointerleave', 'blur']) trustBtn.addEventListener(type, lightUp(false))
      rec.trustBtn = trustBtn
      rec.actionsNode.querySelector('.focus-shred')?.before(trustBtn)
    }
    if (rec.actionsNode && !earlier && WAYS_PLACE === 'options') answer.append(rec.actionsNode)
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
    // a paragraph and its tile light up together
    if (sections) {
      const over = on => e => { const key = e.target.closest?.('.focus-opt')?.dataset.key; if (key) light(rec, key, on) }
      opts.addEventListener('pointerover', over(true))
      opts.addEventListener('pointerout', over(false))
      opts.addEventListener('focusin', over(true))
      opts.addEventListener('focusout', over(false))
    }
    for (const key of rec.optNotes.keys()) optNoteRow(rec, key, false)
    paintOptNotes(rec)
    opts.addEventListener('scroll', () => { if (rec.pictureOf) linkPicture(rec) }, { passive: true })
    tiePicture(rec, false)
    if (rec.pictureOf && rec.showImage && !sections) {
      const look = e => {
        const at = rec.pictureOf.get(e.target.closest?.('.focus-opt')?.dataset.key)
        media.toggleAttribute('data-pointing', at != null)   // in the grid the other pictures step back
        if (at != null && at !== rec.imageAt) rec.showImage(at)
      }
      opts.addEventListener('pointerover', look)
      opts.addEventListener('focusin', look)
      opts.addEventListener('pointerleave', () => media.removeAttribute('data-pointing'))
      opts.addEventListener('focusout', () => media.removeAttribute('data-pointing'))
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

    // The conversation at the left, the answers at the right, and the composer with its buttons in a row of
    // its own under both: the field as wide as the conversation, the buttons at its right.
    // The answers float at the top right of what scrolls, beside the title, as tall as they need; text flows round
    // them, pictures and the conversation take the whole width under them. (In a narrow window they stand at
    // the foot of the text: the stylesheet reorders them.) The composer is pinned at the foot of the card.
    const talk = el('div', 'focus-talk')
    talk.append(scroll)
    const up = button('focus-up', 'Back to the top of this question (Home)')
    up.title = 'Back to the top (Home)'
    up.append(icon('up'), el('span', 'focus-up-title', card.title))
    up.hidden = true
    const toTop = () => { if (scroll.scrollTop < 8) title.scrollIntoView({ block: 'start', behavior: still() ? 'instant' : 'smooth' }); else scroll.scrollTo({ top: 0, behavior: still() ? 'instant' : 'smooth' }) }
    const paintUp = () => { const t = title.getBoundingClientRect(), f = scroll.getBoundingClientRect(); up.hidden = !f.height || !(t.bottom < f.top + 4 || t.top > f.bottom - 4) }
    up.addEventListener('click', toTop)
    scroll.addEventListener('scroll', paintUp, { passive: true })
    rec.paintUp = paintUp
    node.onkeydown = e => { if (e.key !== 'Home' || e.defaultPrevented || e.target.closest?.('input, textarea, [contenteditable]')) return; e.preventDefault(); rec.scroll.scrollTo({ top: 0, behavior: still() ? 'instant' : 'smooth' }) }
    talk.append(up)
    // In the list every card carries read-aloud and close in its own corner (the window's top bar is not shown there).
    const ends = el('div', 'focus-card-ends')
    const sayTwin = button('focus-card-say', 'Read questions aloud')
    sayTwin.append(sayBtn.firstElementChild.cloneNode(true))
    sayTwin.hidden = sayBtn.hidden
    sayTwin.setAttribute('aria-pressed', sayBtn.getAttribute('aria-pressed') ?? 'false')
    sayTwin.addEventListener('click', () => { claim(rec); sayBtn.click() })
    const closeTwin = button('focus-card-close', 'Close')
    closeTwin.title = 'Close (Esc)'
    closeTwin.append(icon('close'))
    closeTwin.addEventListener('click', close)
    rec.countNode = el('span', 'focus-card-count')
    ends.append(rec.countNode, copyButton(card), sayTwin, closeTwin)
    // Writing anywhere: the card is the surface, its tools stand in its corner.
    rec.marksUi = null
    node.toggleAttribute('data-marks', writeAnywhere && !permission && !earlier && rec.card.status === 'open')
    // a question written as one text has its options in that text: they are not shown a second time as tiles
    node.toggleAttribute('data-sections', Boolean(sections))
    if (writeAnywhere && !permission && !earlier && rec.card.status === 'open') {
      rec.marksUi = cardMarks({
        scroll,
        blocks: () => [...scroll.querySelectorAll('.focus-lead .focus-title, .focus-text > .rich > :not(.focus-mark), .focus-secs > .rich > :not(.focus-mark), .focus-sec')],
        labelOf: key => { const o = card.options.find(x => x.key === key); return o ? labelOf(o) : key },
        onChange: () => { rec.marks = rec.marksUi.get(); paintDraft(rec); queueDraft(rec) },
      })
      rec.marksUi.set(rec.marks ?? [])
      // the pen stands in the row of the Discuss field, beside the paperclip
      rec.askNode?.querySelector('.focus-clip')?.after(rec.marksUi.controls)
      if (!rec.marksUi.controls.parentNode) ends.prepend(rec.marksUi.controls)
      // files and pictures: dropped or pasted anywhere on the card (they wait as chips at its foot until the next action)
      const carries = e => [...(e.dataTransfer?.types ?? [])].includes('Files')
      node.ondragover = e => { if (carries(e)) e.preventDefault() }
      node.ondrop = e => { if (!carries(e)) return; e.preventDefault(); claim(rec); addFiles(rec, e.dataTransfer.files) }
      node.onpaste = e => { const files = [...(e.clipboardData?.files ?? [])]; if (!files.length) return; e.preventDefault(); addFiles(rec, files) }
    }
    // Two columns: what is asked at the left with its own scroll, the answers at the right; the composer under the left.
    // Or (besideTitle) the answers are the first thing in what scrolls and float at its top right.
    node.toggleAttribute('data-head', besideTitle)
    if (besideTitle) scroll.prepend(answer)
    node.replaceChildren(...[talk, besideTitle ? null : answer, rec.composer, ends].filter(Boolean))
    // Decided, read, shredded or withdrawn: shown to read, with what became of it, and "Take back" where that can be.
    const past = rec.card.status !== 'open'
    node.toggleAttribute('data-past', past)
    answer.inert = Boolean(earlier) || past   // an earlier version cannot be answered, a closed card neither
    if (past) {
      const c = rec.card
      const chosen = new Set(c.choices?.length ? c.choices : c.choice != null ? [c.choice] : [])
      if (info && c.read) chosen.add(ACK_KEY)
      for (const b of rec.optButtons) b.toggleAttribute('data-chosen', chosen.has(b.dataset.key))
      const word = c.status === 'shredded' ? 'Shredded' : c.kind === 'info' ? (c.read ? 'Read' : 'Closed') : c.status === 'decided' ? (c.trusted ? 'Left to the agent' : 'Answered') : 'Withdrawn by the agent'
      const labels = c.kind === 'info' ? [] : c.options.filter(o => chosen.has(o.key)).map(labelOf)
      const when = c.decided ?? c.shredded ?? c.read
      const bar = el('div', 'focus-past')
      const says = el('p', 'focus-past-says')
      says.append(el('b', null, word), labels.length ? `: ${labels.join(', ')}` : '', when ? ` · ${ago(when)}` : '')
      bar.append(says)
      if (c.note) bar.append(el('p', 'focus-past-note', c.note))
      if (c.status === 'decided' || c.status === 'shredded' || (c.kind === 'info' && c.read)) {
        const back = button('focus-past-back', 'Take back: the question is open again')
        back.textContent = 'Take back'
        back.addEventListener('click', async () => { back.disabled = true; try { await reopen(c.id) } catch (err) { back.disabled = false; setError(rec, `Not taken back: ${err.message}`) } })
        bar.append(back)
      }
      lead.after(bar)
    }
    requestAnimationFrame(() => { paintUp(); tiePicture(rec) })
    if (multi) paintPicked(rec)
    rec.toEnd = false
    paintThread(rec)
    paintAssets(rec)
    paintFiles(rec)
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
    for (const [key, sec] of rec.secNodes ?? []) sec.querySelector('.focus-sec-pick')?.setAttribute('aria-pressed', String(rec.picked.has(key)))
    const n = rec.picked.size
    rec.sendTile.disabled = !n
    // (groups of options: say which group has nothing picked yet; it does not hold the answer back)
    const open = (rec.groups ?? []).filter(g => !g.keys.some(k => rec.picked.has(k))).map(g => g.title)
    rec.sendCount.textContent = rec.groups ? (open.length ? `Nothing picked yet for: ${open.join(', ')}` : `${n} chosen, one or more in each group`) : n ? `${n} chosen` : 'Choose one or more'
  }
  function toggle(rec, key) {
    claim(rec)
    if (rec.busy || rec !== shown) return
    if (rec.picked.has(key)) rec.picked.delete(key)
    else rec.picked.add(key)
    paintPicked(rec)
    queueDraft(rec)
  }

  // ── a question written as one text: paragraphs that are options ─────────
  /** The options of a sectioned card in their groups: a plain block that is followed by options is the heading of
   *  that run. [{ title, keys }], empty without sections. */
  function optionGroups(sections) {
    const groups = []
    let heading = '', run = null
    for (const block of sections ?? []) {
      if (block.key == null) { if (block.text?.trim()) heading = block.text; run = null; continue }
      if (!run) { run = { title: String(heading).trim().split('\n')[0].replace(/^#+\s*/, '').replace(/[*_`]/g, '').replace(/[:.]\s*$/, '').slice(0, 60) || `Group ${groups.length + 1}`, keys: [] }; groups.push(run) }
      run.keys.push(block.key)
    }
    return groups
  }
  /** card.sections on the left: plain blocks are text; a block with a key is the paragraph of that option. Its
   *  heading is a tap target (it ticks the option, or answers where one answer is taken), the agent's advice is
   *  circled on it as on the tile, its picture stands with it, and it has the pencil for a note on that option. */
  function sectionsNode(rec, sections) {
    const card = rec.card
    const multi = Boolean(card.multiple)
    const box = el('div', 'focus-secs')
    rec.secNodes = new Map()
    for (const block of sections) {
      if (block.key == null) { if (block.text) box.append(rich(block.text)); continue }
      const sec = el('section', 'focus-sec')
      sec.dataset.key = block.key
      const pick = button('focus-sec-pick')
      pick.toggleAttribute('data-multi', multi)
      if (multi) pick.setAttribute('aria-pressed', 'false')
      pick.title = multi ? 'Tick this option' : 'Answer with this option'
      const mark = el('span', 'focus-sec-mark')
      mark.append(icon('check'))
      const label = el('span', 'focus-sec-label', block.label)
      if (block.recommended) { sec.classList.add('is-advised'); label.append(adviceLoop()); pick.append(el('span', 'focus-sr', 'Recommended by the agent: ')) }
      pick.append(mark, label)
      pick.addEventListener('click', () => (multi ? toggle(rec, block.key) : submit(rec, [block.key])))
      const head = el('div', 'focus-sec-head')
      head.append(pick, optionPencil(rec, block.key, block.label))
      sec.append(head)
      if (block.text) sec.append(rich(block.text))
      const picture = card.attachments?.[block.picture]
      if (picture && kindOf(picture) === 'image') {
        const fig = button('focus-sec-pic', `Enlarge ${picture.name}`)
        const img = el('img')
        img.src = picture.url
        img.alt = picture.name
        img.loading = 'lazy'
        img.draggable = false
        fig.append(img)
        fig.addEventListener('click', () => openZoom(rec.allImages, Math.max(0, rec.allImages.indexOf(picture)), fig, null, rec))
        sec.append(fig)
      }
      for (const [type, on] of [['pointerenter', true], ['pointerleave', false], ['focusin', true], ['focusout', false]]) sec.addEventListener(type, () => light(rec, block.key, on))
      rec.secNodes.set(block.key, sec)
      box.append(sec)
    }
    return box
  }
  /** A paragraph and the tile of its option, lit together. */
  function light(rec, key, on) {
    rec.secNodes?.get(key)?.toggleAttribute('data-lit', on)
    rec.optButtons.find(b => b.dataset.key === key)?.toggleAttribute('data-lit', on)
  }

  /** The mark of the current option: an arrow drawn with the pen (ui.js arrowStrokes), laid over host. Where the
   *  picture stands right beside the options (the enlarged view), one line leaves the picture's edge, runs down the
   *  gap beside the options and under the row of the tag, and comes into the tag's lower left corner. Anywhere
   *  else it is the short arrow from above the tag. Drawn again with another wobble on every change. */
  let arrowTurn = 0
  function pointAt(host, tag, picture = null) {
    host.querySelector(':scope > .focus-arrow')?.remove()
    if (!tag || !tag.isConnected || !tag.offsetWidth) return
    const base = host.getBoundingClientRect()
    const box = n => { const r = n.getBoundingClientRect(); return { x: r.left - base.left + host.scrollLeft, y: r.top - base.top + host.scrollTop, w: r.width, h: r.height } }
    const T = box(tag), O = box(tag.parentElement)
    const P = picture?.isConnected && picture.offsetWidth ? box(picture) : null
    let points
    if (P && O.x - (P.x + P.w) > 8 && O.x - (P.x + P.w) < 150) {
      const gx = O.x - 9
      const y0 = clamp(T.y - 22, P.y + 26, P.y + P.h - 26)
      const start = [[P.x + P.w - 30, y0], [P.x + P.w - 4, y0 + 5], [gx - 3, y0 + 16]]
      const mid = T.y + T.h / 2
      const end = T.x - O.x < 4
        ? [[gx - 4, mid + (start.at(-1)[1] > mid ? 20 : -20)], [gx - 2, mid + (start.at(-1)[1] > mid ? 5 : -5)], [T.x - 2, mid]]
        : [[gx, T.y + T.h - 10], [gx + 7, T.y + T.h + 3], [gx + 22, T.y + T.h + 4.5], [T.x - 16, T.y + T.h + 4.5], [T.x - 5, T.y + T.h + 3], [T.x + 7, T.y + T.h - 8]]
      points = [...start, ...end]
    } else {
      const x = T.x + Math.min(T.w / 2, 60)
      points = [[x + 17, T.y - 22], [x + 9, T.y - 14], [x + 3, T.y - 8], [x, T.y - 2]]
    }
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('class', 'focus-arrow')
    svg.setAttribute('aria-hidden', 'true')
    for (const d of arrowStrokes(points, `${tag.dataset.key}:${arrowTurn++}`)) {
      const path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute('d', d)
      svg.append(path)
    }
    host.append(svg)
  }

  /** The picture shown in the card's gallery marks the option it belongs to (data-match, the same mark as beside
   *  the enlarged picture), and with reveal brings that option into view in its column. */
  function tiePicture(rec, reveal) {
    const shownPicture = rec.galleryImages?.[rec.imageAt]
    const at = shownPicture ? rec.allImages.indexOf(shownPicture) : -1
    const key = at < 0 ? null : [...(rec.pictureOf ?? [])].find(([, index]) => index === at)?.[0]
    for (const b of rec.optButtons ?? []) {
      const mine = key != null && b.dataset.key === key
      const was = b.hasAttribute('data-match')
      b.toggleAttribute('data-match', mine)
      if (mine && !was && reveal && b.isConnected) b.scrollIntoView({ block: 'nearest' })
    }
    // The arrow points at it (drawn in the answers' box, which scrolls with its tags), but only while its picture is
    // in sight: an arrow that comes from nowhere says nothing.
    linkPicture(rec)
  }
  /** One line of the pen from the picture shown (the grid tile, or the one large picture) to the option it belongs
   *  to: it leaves the picture at its upper right, runs along the gap above its row to the gap between the two
   *  columns, down or up that gap, and its head comes into the option's left edge. Drawn only while both ends are
   *  wholly in sight; otherwise nothing is drawn. Drawn again when either column scrolls. */
  function linkPicture(rec) {
    const host = rec.node
    const old = host.querySelector(':scope > .focus-arrow')
    const picture = (rec.mediaNode?.dataset.view === 'grid' ? rec.gridTiles?.[rec.imageAt] : null) ?? rec.mediaNode?.querySelector('.focus-figure')
    const tile = rec.optButtons?.find(b => b.hasAttribute('data-match'))
    const gone = () => { old?.remove(); rec.arrowSig = '' }
    if (!picture || !tile || !rec.scroll || rec.answer.parentElement !== host) return gone()
    const base = host.getBoundingClientRect()
    const box = n => { const r = n.getBoundingClientRect(); return { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height } }
    const P = box(picture), T = box(tile), A = box(rec.answer), F = box(rec.scroll), L = box(tile.parentElement)
    if (A.x < P.x + P.w - 1) return gone()   // a narrow window: the answers stand under the pictures
    // the part of the picture that is in sight, and the option wholly in sight in its list
    const top = Math.max(P.y, F.y), bottom = Math.min(P.y + P.h, F.y + F.h)
    if (!P.w || bottom - top < 70 || T.y < L.y - 2 || T.y + T.h > L.y + L.h + 2) return gone()
    const sig = [P.x, top, P.w, T.x, T.y, T.h].map(Math.round).join()
    if (sig === rec.arrowSig && old) return
    rec.arrowSig = sig
    old?.remove()
    // from the picture's right edge, near its top, over the gap into the option's left edge
    const mid = T.y + T.h / 2
    const from = [P.x + P.w - 30, clamp(mid - 46, top + 22, bottom - 22)]
    const gx = P.x + P.w + (T.x - P.x - P.w) / 2
    const points = [from, [P.x + P.w - 6, from[1] + 5], [gx - 8, from[1] + 9], [gx + 4, from[1] + (mid - from[1]) * .45], [gx + 6, mid - (mid > from[1] ? 14 : -14)], [gx + 12, mid - (mid > from[1] ? 3 : -3)], [T.x - 2, mid]]
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('class', 'focus-arrow')
    svg.setAttribute('aria-hidden', 'true')
    for (const d of arrowStrokes(points, `${tile.dataset.key}:${arrowTurn++}`)) {
      const path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute('d', d)
      svg.append(path)
    }
    host.append(svg)
  }

  // ── a note on a single option ───────────────────────────────────────────
  /** The small pencil on an option (tile, tag or paragraph): it opens a line for a note on that option alone,
   *  chosen or not. (A span that acts as a button: it stands inside the tile, which is one itself.) */
  function optionPencil(rec, key, label) {
    const pen = el('span', 'focus-opt-pen')
    pen.setAttribute('role', 'button')
    pen.tabIndex = 0
    pen.dataset.key = key
    pen.setAttribute('aria-label', `Write a note on ${label}`)
    pen.title = 'A note on this option'
    pen.append(sketch('pen'))
    const open = e => { e.preventDefault(); e.stopPropagation(); if (rec.marksUi) rec.marksUi.note({ kind: 'option', key }); else optNoteRow(rec, key, true) }
    pen.addEventListener('click', open)
    pen.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') open(e) })
    return pen
  }
  /** The line for the note on one option, right at its tile; made when asked for, gone again when left empty. */
  function optNoteRow(rec, key, focus) {
    let row = rec.optRows.get(key)
    if (!row) {
      const o = rec.card.options.find(x => x.key === key)
      const tile = rec.optButtons.find(b => b.dataset.key === key)
      if (!o || !tile) return
      const node = el('label', 'focus-opt-note')
      node.dataset.key = key
      const input = el('input')
      input.type = 'text'
      input.maxLength = 2000
      input.autocomplete = 'off'
      input.placeholder = `Note on ${rec.labelOf(o)}`
      input.setAttribute('aria-label', `Note on ${rec.labelOf(o)}. It goes along with your answer, whatever you choose.`)
      input.value = rec.optNotes.get(key) ?? ''
      node.append(sketch('pen'), input)
      input.addEventListener('input', () => {
        if (input.value.trim()) rec.optNotes.set(key, input.value)
        else rec.optNotes.delete(key)
        paintOptNotes(rec)
        queueDraft(rec)
      })
      input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); rec.node.focus({ preventScroll: true }) } })
      input.addEventListener('blur', () => { if (!input.value.trim() && rec.optRows.get(key)?.node === node) { node.remove(); rec.optRows.delete(key) } })
      // under its tile; under the pair where two tiles stand side by side
      if (tile.parentNode.dataset.count === 'duo') tile.parentNode.append(node)
      else tile.after(node)
      row = { node, input }
      rec.optRows.set(key, row)
    }
    if (focus) row.input.focus({ preventScroll: true })
    return row
  }
  /** Which options carry a note: their pencils say so. */
  function paintOptNotes(rec) {
    for (const pen of rec.node.querySelectorAll('.focus-opt-pen')) pen.toggleAttribute('data-noted', Boolean(rec.optNotes.get(pen.dataset.key)?.trim()))
  }

  // ── drafts: what is ticked and written but not sent is kept on the hub ──
  function draftOf(rec) {
    const keys = rec.multi ? rec.card.options.map(o => o.key).filter(k => rec.picked.has(k)) : rec.wasKeys
    return { card_id: rec.id, keys, note: rec.askText, notes: Object.fromEntries([...rec.optNotes].filter(([, text]) => text.trim())), ...(writeAnywhere ? { marks: rec.marks ?? [] } : {}) }
  }
  /** Save the draft of a card a moment after it changed (POST /draft; an empty one clears it). */
  function queueDraft(rec) {
    if (rec.card.kind !== 'decision' || rec.draftSent === undefined) return
    if (!rec.draftTimer && JSON.stringify(draftOf(rec)) === rec.draftSent) return paintSaved(rec)
    clearTimeout(rec.draftTimer)
    rec.draftTimer = setTimeout(() => saveDraft(rec), 300)
    paintSaved(rec)
  }
  function saveDraft(rec) {
    clearTimeout(rec.draftTimer)
    rec.draftTimer = 0
    if (recs.get(rec.id) !== rec || decidedLocal.has(rec.id) || rec.busy) return paintSaved(rec)
    const body = JSON.stringify(draftOf(rec))
    if (body === rec.draftSent) return paintSaved(rec)
    rec.draftSent = body
    rec.saving = (rec.saving ?? 0) + 1
    rec.saveFailed = false
    paintSaved(rec)
    fetch('/draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
      .then(res => { if (!res.ok && res.status !== 409) throw new Error('not saved') }, () => { throw new Error('not saved') })
      .catch(() => { rec.saveFailed = true; if (rec.draftSent === body) rec.draftSent = '' })
      .finally(() => { rec.saving--; paintSaved(rec) })
  }
  /** Save what is waiting right now (the field is left, the window closes, the card is acted on). */
  function flushDraft(rec) { if (rec.draftTimer) saveDraft(rec) }
  /** The end of the field: "…" while the words are on their way, a tick and "saved" once the hub has them. */
  function paintSaved(rec) {
    const node = rec.saveNode
    if (!node) return
    const words = Boolean(rec.askText.trim())
    const state = !words ? '' : rec.saveFailed ? 'failed' : rec.draftTimer || rec.saving ? 'saving' : rec.card.kind === 'decision' ? 'saved' : ''
    if (node.dataset.state === state) return
    node.dataset.state = state
    node.hidden = !state
    node.replaceChildren(...(state === 'saving' ? [el('span', null, '…')]
      : state === 'saved' ? [icon('check'), el('span', null, 'saved'), ...(touchOnly.matches ? [] : [el('kbd', null, 'Enter'), el('span', 'focus-saved-hint', HAND_BACK_LABEL.toLowerCase())])]
      : state === 'failed' ? [el('span', null, 'not saved yet')] : []))
    node.title = state === 'saved' ? `Kept on the board as you write. Enter: ${HAND_BACK_LABEL} with these words. Ctrl+Enter: say it and stay. An answer takes them along as its note.` : ''
  }
  /** Take what the hub holds for a card (card.draft) when it is news: on first sight, from another device, after
   *  "Later", after an answer was taken back. Not while the human is changing this card right now. */
  function adoptDraft(rec) {
    if (rec.card.kind !== 'decision') return
    const draft = rec.card.draft
    const ts = draft?.ts ?? 0
    if (ts === rec.draftTs) return
    rec.draftTs = ts
    const at = document.activeElement
    if (rec.draftTimer || (rec.node.contains(at) && at.matches('input, textarea'))) return
    const known = new Set(rec.card.options.map(o => o.key))
    const keys = (draft?.keys ?? []).filter(k => known.has(k))
    rec.picked = new Set(rec.multi ? keys : [])
    rec.wasKeys = rec.multi ? [] : keys
    rec.optNotes = new Map(Object.entries(draft?.notes ?? {}).filter(([k]) => known.has(k)))
    rec.askText = draft?.note ?? ''
    rec.marks = draft?.marks ?? []
    // (a general note written on the card in the earlier way moves into the field at its foot)
    const general = rec.marks.filter(m => m.anchor?.kind === 'card' && m.text?.trim()).map(m => m.text.trim())
    if (general.length) { rec.marks = rec.marks.filter(m => !(m.anchor?.kind === 'card' && m.text != null)); rec.askText = [rec.askText.trim(), ...general].filter(Boolean).join('\n') }
    rec.marks = rec.marks.filter(m => !m.strokes || String(m.id).startsWith('pen-') || m.text != null)
    rec.marksUi?.set(rec.marks)
    rec.draftSent = JSON.stringify(draftOf(rec))
    if (rec.askField) rec.askField.value = rec.askText
    for (const [key, row] of rec.optRows) {
      if (rec.optNotes.has(key)) row.input.value = rec.optNotes.get(key)
      else { row.node.remove(); rec.optRows.delete(key) }
    }
    for (const key of rec.optNotes.keys()) optNoteRow(rec, key, false)
    for (const b of rec.optButtons) b.toggleAttribute('data-was', rec.wasKeys.includes(b.dataset.key))
    if (rec.multi) paintPicked(rec)
    paintOptNotes(rec)
    paintDraft(rec)
  }

  // ── the conversation about a card ───────────────────────────────────────
  /** The composer after its text changed: the send button, the line under the tiles, the field's height. */
  function paintDraft(rec) {
    const field = rec.askField
    if (!field) return
    const words = Boolean(rec.askText.trim()), n = rec.files.length
    rec.askSend.disabled = !words && !n
    if (rec.noteTag) {
      rec.noteTag.hidden = !words && !n
      rec.noteTag.lastChild.textContent = words && n ? `Your words and ${n === 1 ? 'the file' : `${n} files`} go along` : n ? `${n === 1 ? 'The file goes' : `${n} files go`} along with your answer` : 'Your words go along as a note'
    }
    field.style.height = 'auto'
    const full = field.scrollHeight
    if (full) field.style.height = `${Math.min(full, 168)}px`
    field.style.overflowY = full > 168 ? 'auto' : 'hidden'
    queueDraft(rec)
  }

  // ── the scratchpad: the composer as a small drawing surface ─────────────
  // The session canvas's own drawing code (scribble.js), mounted small: pen, eraser and undo only. There is one
  // of it for the window; it stands in the composer of the card it was opened on. What is drawn becomes a picture
  // among the composer's files (kept with its strokes, so a tap on its chip opens it again); a picture already
  // attached can be opened in it and drawn on.
  const padHost = el('div', 'focus-pad')
  padHost.dataset.ownsKeys = ''   // while one draws, the window's single keys rest (keys.js)
  const padStage = el('div', 'focus-pad-stage')
  const padFoot = el('div', 'focus-pad-foot')
  const padDrop = button('focus-pad-btn', 'Discard the drawing')
  padDrop.textContent = 'Discard'
  const padDone = button('focus-pad-btn focus-pad-done', 'Keep the drawing and go back to typing')
  padDone.append(icon('check'), el('span', null, 'Back to typing'))
  padFoot.append(el('span', 'focus-pad-say', 'It goes along as a picture.'), padDrop, padDone)
  padHost.append(padStage, padFoot)
  let pad = null        // { rec, file } while it is open
  let padBoard = null   // the mounted canvas
  let padTake = null    // waits for the picture of the canvas
  padDone.addEventListener('click', () => closePad(true))
  padDrop.addEventListener('click', () => closePad(false))
  padHost.addEventListener('keydown', e => { if (e.key === 'Escape' && !e.defaultPrevented) { e.stopPropagation(); closePad(true) } })
  /** The picture of what is on the canvas (and its strokes), or null when it is empty. */
  const padShot = () => new Promise(resolve => {
    if (!padBoard || padBoard.isEmpty()) return resolve(null)
    const give = shot => { clearTimeout(timer); padTake = null; resolve(shot) }
    const timer = setTimeout(() => give(null), 5000)
    padTake = give
    padStage.querySelector('.scr-send')?.click()   // the canvas renders itself for its own "send"; that is this hand-over
  })
  /** An attached picture as a canvas with that picture on it. */
  const pictureDoc = file => new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const w = Math.min(img.naturalWidth, 640), h = Math.round((w * img.naturalHeight) / img.naturalWidth)
      resolve({ v: 1, images: [{ id: 'picture', x: 0, y: 0, w, h, nw: img.naturalWidth, nh: img.naturalHeight, src: file.data }], strokes: [] })
    }
    img.onerror = () => reject(new Error('not a picture'))
    img.src = file.data
  })
  /** Open the scratchpad in a card's composer: empty, or on one of its attached pictures. A second tap on the pen closes it. */
  async function openPad(rec, file = null) {
    if (pad && pad.rec === rec && !file) return closePad(true)
    if (pad) await closePad(true)
    if (!rec.askNode || !recs.has(rec.id)) return
    try {
      if (!padBoard) {
        const { mountScribble } = await import('./scribble.js')
        padBoard = mountScribble(padStage, {
          draftKey: null,
          send: async shot => { padTake?.({ png: shot.png, doc: shot.doc }) },
          onChange: () => { padHost.dataset.used = '' },   // drawing has begun: the surface grows
        })
      }
      pad = { rec, file }
      delete padHost.dataset.used
      rec.chipsNode.after(padHost)
      rec.askNode.dataset.pad = ''
      rec.penBtn?.setAttribute('aria-pressed', 'true')
      if (file) { padHost.dataset.used = ''; padBoard.load(file.doc ?? await pictureDoc(file)) }
      else padBoard.clear()
    } catch (err) {
      pad = null
      padHost.remove()
      delete rec.askNode.dataset.pad
      info(`The scratchpad did not open: ${err?.message || 'unknown reason'}`, true)
    }
  }
  /** Close it. With keep, what was drawn becomes a picture among the composer's files (or replaces the one it was drawn on). */
  async function closePad(keep = true) {
    if (!pad || pad.closing) return
    const { rec, file } = pad
    pad.closing = true
    const shot = keep ? await padShot() : null
    if (!pad || pad.rec !== rec) return
    pad = null
    padHost.remove()
    padBoard?.clear()
    const now = recs.get(rec.id) ?? rec
    delete now.askNode?.dataset.pad
    now.penBtn?.setAttribute('aria-pressed', 'false')
    if (shot) {
      if (file && now.files.includes(file)) Object.assign(file, { data: shot.png, doc: shot.doc, image: true, drawn: true })
      else now.files.push({ name: `Scribble ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).replace(/:/g, '.')}.png`, data: shot.png, doc: shot.doc, image: true, drawn: true, size: 0 })
    }
    paintFiles(now)
    if (isOpen && shown === now) now.askField?.focus({ preventScroll: true })
  }

  /** Turn the card to one of its versions (n), read-only; the live one is the last step. The conversation goes to
   *  the place where that version was presented, so question, talk and the next version read in their order. */
  function viewVersion(rec, n) {
    const live = rec.card.version ?? (rec.card.versions?.at(-1)?.n ?? 0) + 1
    rec.version = n == null || n >= live ? null : n
    fill(rec)
    if (rec.version == null) return announce('The question as it stands now.')
    announce(`Version ${rec.version}, as it was. It cannot be answered.`)
    const turn = rec.threadNode?.querySelector(`.focus-turn[data-version="${rec.version}"]`)
    if (turn) turn.scrollIntoView({ block: 'center' })
    else rec.scroll.scrollTop = 0
    rec.node.focus({ preventScroll: true })
  }

  /** Under the title: everything the card carries, as small chips. Pictures (a tap goes to them), things to play,
   *  files, published pages and links (also those only named in the text or in the conversation about the card;
   *  one that was withdrawn or has expired is left out), tables and layouts. */
  function paintAssets(rec) {
    const slot = rec.assetsNode
    if (!slot) return
    const card = rec.card
    const list = card.attachments ?? []
    const texts = [card.body ?? '', ...(pool()?.messages ?? []).filter(m => m.card_id === rec.id && m.from !== 'event').map(m => `${m.text ?? ''}\n${m.details ?? ''}`)]
    const links = new Map()
    for (const text of texts) for (const [url] of text.matchAll(/https?:\/\/[^\s<>)`\]]+/g)) {
      const found = linkInfo(url)
      if (found.asset) { if (!found.asset.gone) links.set(found.asset.id, { href: found.asset.href, label: found.asset.title || 'Published page', drawing: found.asset.type === 'image' ? 'picture' : found.asset.type === 'video' || found.asset.type === 'audio' ? 'play' : 'page' }) }
      else links.set(url, { href: url, label: found.text, drawing: 'page' })
    }
    for (const m of pool()?.messages ?? []) if (m.card_id === rec.id && m.asset && !m.asset.gone && !links.has(m.asset.id)) links.set(m.asset.id, { href: null, label: m.asset.title || 'Published page', drawing: 'page' })
    const pictures = list.filter(a => kindOf(a) === 'image').length
    const plays = list.filter(a => kindOf(a) === 'video' || kindOf(a) === 'audio').length
    const files = list.filter(a => kindOf(a) === 'file')
    const whole = texts[0]
    const layouts = (whole.match(/```html/g) ?? []).length
    const tables = (whole.match(/^\s*\|?\s*:?-{2,}:?\s*\|/gm) ?? []).length
    const session = (pool()?.agents ?? []).find(a => a.id === card.agent)
    const name = card.agent_name || session?.name || 'Agent'
    const when = card.revised ?? card.created
    const sig = JSON.stringify([pictures, plays, files.map(a => a.url), [...links], layouts, tables, card.version, card.versions?.length, rec.threadNode?.querySelectorAll('.msg').length ?? 0, name, session?.mark, urgencyWord(card), when, cameBack.get(rec.id), card.number])
    if (sig === rec.assetsSig) return
    rec.assetsSig = sig
    // One quiet sentence, its parts set apart by a dot: "From Trommi · third version · 39 min ago · 2 messages below".
    // A part that leads somewhere is a plain link in the same type.
    const part = (label, to, cls) => {
      const node = el(typeof to === 'string' ? 'a' : to ? 'button' : 'span', `focus-by-part${cls ? ` ${cls}` : ''}`, label)
      if (typeof to === 'string') { node.href = to; node.target = '_blank'; node.rel = 'noopener noreferrer' }
      else if (to) { node.type = 'button'; node.addEventListener('click', to) }
      return node
    }
    const goTo = sel => () => rec.scroll?.querySelector(sel)?.scrollIntoView({ block: 'center', behavior: still() ? 'instant' : 'smooth' })
    const versions = card.versions?.length ? card.versions : null
    const said = rec.threadNode?.querySelectorAll('.msg').length ?? 0
    const from = part(`From ${name}`, null, 'focus-by-from')
    from.prepend(doodle(session?.mark ?? card.agent))
    const parts = [from]
    if (urgencyWord(card)) parts.push(part(urgencyWord(card), null, 'focus-by-urgent'))
    if (versions) {
      const n = card.version ?? versions.at(-1).n + 1
      const word = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth'][n]
      const v = part(word ? `${word} version` : `version ${n}`, () => viewVersion(rec, rec.version == null ? versions.at(-1).n : null))
      v.title = 'See the versions before'
      parts.push(v)
    }
    parts.push(agoNode(when, 'focus-by-part'))
    if (said) parts.push(part(said === 1 ? '1 message below' : `${said} messages below`, goTo('.focus-thread')))
    if (plays) parts.push(part(plays === 1 ? '1 to play' : `${plays} to play`, goTo('.focus-media .media')))
    for (const x of links.values()) parts.push(part(x.label, x.href))
    for (const a of files) parts.push(part(a.name, a.url))
    if (tables) parts.push(part(tables === 1 ? 'a table' : `${tables} tables`, goTo('table')))
    if (layouts) parts.push(part(layouts === 1 ? 'a layout' : `${layouts} layouts`, goTo('iframe')))
    // why it is in the pass a second time
    if (cameBack.has(rec.id)) parts.push(part(cameBack.get(rec.id), null, 'focus-came-back'))
    const nr = part(cardNr(card), null, 'focus-nr')
    parts.push(nr)
    slot.classList.add('focus-by')
    slot.hidden = false
    slot.replaceChildren(...parts)
  }

  /** Bring the field at the foot of the card into reach (Revise, What??, the key for a note). */
  function setDiscuss(rec) { rec.threadNode?.scrollIntoView({ block: 'end', behavior: still() ? 'instant' : 'smooth' }) }

  /** Take files into the composer of a card (picked, dropped or pasted): read, and shown as chips until sent. */
  async function addFiles(rec, list) {
    const room = MAX_FILES - rec.files.length
    const files = [...list]
    if (files.length > room) info(`At most ${MAX_FILES} files at once.`, true)
    for (const file of files.slice(0, Math.max(0, room))) {
      if (file.size > MAX_FILE_BYTES) { info(`Too large (over ${MAX_FILE_BYTES / 1024 / 1024} MB): ${file.name}`, true); continue }
      try {
        const data = await readDataUrl(file)
        // a screenshot from the clipboard has no name of its own
        const name = file.name && file.name !== 'image.png' ? file.name : `Screenshot ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).replace(/:/g, '.')}.png`
        rec.files.push({ name, data, image: /^image\//.test(file.type), size: file.size })
      } catch {
        info(`Not readable: ${file.name}`, true)
      }
    }
    paintFiles(rec)
  }
  /** The chips over the field: a small picture or a name, each with its way out. */
  function paintFiles(rec) {
    if (!rec.chipsNode) return
    rec.chipsNode.hidden = !rec.files.length
    rec.chipsNode.replaceChildren(...rec.files.map(file => {
      const chip = el('span', 'focus-chip')
      chip.title = file.name
      if (file.image) {
        const img = el('img')
        img.src = file.data
        img.alt = file.name
        chip.append(img)
        chip.dataset.kind = 'image'
        // a picture can be drawn on before it is sent (the scratchpad, see openPad)
        if (file.doc || !file.drawn) chip.addEventListener('click', e => { if (!e.target.closest('.focus-chip-x')) rec.annotate?.(file) })
      } else {
        chip.append(icon('file'), el('span', null, file.name))
      }
      const out = button('focus-chip-x', `Remove ${file.name}`)
      out.append(icon('close'))
      out.addEventListener('click', () => { rec.files = rec.files.filter(f => f !== file); paintFiles(rec); rec.askField?.focus({ preventScroll: true }) })
      chip.append(out)
      return chip
    }))
    paintDraft(rec)
  }

  /** What was said about a card, under its question, in the look of the session's conversation (the classes
   *  and the rich text of chat.js): what the state holds about it (messages that name the card), and what
   *  was written from here that the state does not show yet. Newest last. */
  function paintThread(rec) {
    if (!rec.threadNode) return
    const told = (pool()?.messages ?? []).filter(m => m.card_id === rec.id && m.from !== 'event')
    // where the question was presented anew: a line in the conversation that opens that version
    const turns = (pool()?.messages ?? []).filter(m => m.card_id === rec.id && m.from === 'event' && m.kind === 'revised' && m.version)
    const mine = (asked.get(rec.id) ?? []).filter(a => !(a.state === 'sent' && told.some(m => m.from === 'user' && (m.text ?? '') === a.text && m.ts >= a.ts - 60000)))
    if (asked.has(rec.id)) asked.set(rec.id, mine)
    const items = [
      ...told.map(m => ({ from: m.from === 'user' ? 'user' : 'agent', text: m.text ?? '', ts: m.ts, state: '', attachments: m.attachments ?? [], details: m.details ?? '' })),
      ...mine.map(a => ({ from: 'user', text: a.text, ts: a.ts, state: a.state, error: a.error, pending: a.files ?? [] })),
      ...turns.map(m => ({ from: 'turn', version: m.version, again: Boolean(m.again), text: m.text ?? '', ts: m.ts })),
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
      if (item.from === 'turn') {
        before = null
        const line = button('focus-turn', `Show version ${item.version}`)
        line.dataset.version = item.version
        line.append(sketch('timemachine'), el('span', null, `Version ${item.version} ${item.again ? 'presented again' : 'presented'}`), agoNode(item.ts, 'msg-time'))
        line.addEventListener('click', () => viewVersion(rec, item.version))
        return line
      }
      const cont = before === item.from
      before = item.from
      const msg = el('article', `msg msg-${item.from}${cont ? ' cont' : ''}`)
      if (item.from === 'user') {
        const bubble = el('div', 'bubble')
        // The fixed request of "Explain" is one long sentence for the agent; here it is the two words the human tapped.
        const fixed = item.text === EXPLAIN_TEXT
        bubble.append(el('p', null, fixed ? EXPLAIN_LABEL : item.text))
        if (fixed) bubble.title = item.text
        if (item.text) msg.append(bubble)
        // what went along: stored files as in the session's conversation, files still on their way by name
        msg.append(...attachmentNodes(item.attachments ?? []))
        if (item.pending?.length) msg.append(el('p', 'focus-msg-files', item.pending.join(', ')))
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
    const last = items.filter(x => x.from !== 'turn').at(-1)
    if (last && last === items.at(-1) && last.from === 'user' && last.state !== 'sending' && last.state !== 'failed') {
      nodes.push(el('p', 'focus-thread-wait', 'Sent. The reply shows up here; the question stays open.'))
    }
    rec.threadNode.replaceChildren(...nodes)
    paintAssets(rec)
    // the newest is in view, as in any chat
    if (grew) {
      rec.toEnd = true
      const box = rec.discussScroll ?? rec.scroll
      if (box?.isConnected) box.scrollTop = box.scrollHeight
    }
  }

  /** Send what stands in the card's ask-back line; with fixed, that text instead (Explain), and the line keeps what it holds.
   *  Resolves true when the session has it. */
  async function askBack(rec, fixed = null, flags = fixed ? { explain: true } : {}) {
    if (!fixed && pad?.rec === rec) await closePad(true)   // what is on the scratchpad goes along
    await carryMarks(rec)
    // (handed back with nothing written: a plain sentence says so, since a message needs words)
    const text = (fixed ?? rec.askText).trim() || (flags.handback && !rec.files.length ? HAND_BACK_TEXT : '')
    // what is attached in the composer goes with what is typed there (never with the fixed request of What??)
    const files = fixed ? [] : rec.files
    if (!text && !files.length) return rec.askField?.focus({ preventScroll: true })
    const entry = { text, ts: Date.now(), state: 'sending', error: '', files: files.map(f => f.name) }
    asked.set(rec.id, [...(asked.get(rec.id) ?? []).filter(a => a.state !== 'failed'), entry])
    if (!fixed) {
      rec.askText = ''
      if (rec.askField) { rec.askField.value = ''; rec.askSend.disabled = true }
      rec.files = []
      paintFiles(rec)
    }
    paintThread(rec)
    rec.scroll.scrollTop = rec.scroll.scrollHeight
    try {
      await sendMessage(text, rec.card.agent, rec.id, files.map(({ name, data }) => ({ name, data })), flags)
      entry.state = 'sent'
      // What was typed into the composer is plain chat about the card: it stays open, in its place, and in front.
      // Only "Explain" (fixed) leaves the card: it waits under "Later" until the reply, and the walk moves on.
      if (flags.explain) {
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
    if (entry.state === 'failed' && !fixed && !now.askText && !now.files.length && now.askField) { now.askText = text; now.askField.value = text; now.files = files; paintFiles(now) }
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
    // What?? is writing in Discuss: with nothing written yet, the key puts the caret there, and Enter then asks.
    if (rec.card.kind !== 'info' && !rec.askText.trim() && rec.askField && document.activeElement !== rec.askField) {
      rec.asking = true
      setDiscuss(rec, true)
      rec.askField.placeholder = 'What is unclear? Enter asks'
      return void rec.askField.focus({ preventScroll: true })
    }
    explaining = true
    explainBtn.disabled = true
    const walking = !single
    // What stands in the composer goes as the request; with nothing written, the fixed one.
    const sent = await askBack(rec, rec.askText.trim() ? null : EXPLAIN_TEXT, { explain: true }).catch(() => false)
    explaining = false
    paintChrome()
    if (!isOpen) return
    if (!sent) return info('Not asked: the session did not get it.', true)
    const fetch = async () => { await unhand(rec.id); putOff(rec.id, false) }
    // The window of one card closes: the card is put off and comes back with the reply. The page says so.
    if (!walking) { close(); return void say(pageHost(), { head: `Asked: ${EXPLAIN_LABEL}`, title: 'It comes back with the answer.', back: fetch }) }
    offerBack(rec.card, { head: `Asked: ${EXPLAIN_LABEL}`, title: 'It comes back with the answer.', take: fetch })
  }

  // ── answering ───────────────────────────────────────────────────────────
  const request = (card, keys, note, files = [], notes = {}) => (files.length || Object.keys(notes).length ? decideWith(card, keys, note, files, notes) : card.multiple ? decideMany(card.id, keys, note, card.revised ?? null) : decide(card.id, keys[0], note))

  async function submit(rec, keys) {
    claim(rec)
    if (rec.version != null || rec.card.status !== 'open') return   // an earlier version, or a closed card, is only read
    await carryMarks(rec)
    if (rec !== shown || !recs.has(rec.id)) return
    if (rec.card.kind === 'info') return keys[0] === WHAT_KEY ? explain() : acknowledge(rec)
    if (rec.busy || busyRec() || rec !== shown || !recs.has(rec.id)) return
    if (pad?.rec === rec) { await closePad(true); if (rec.busy || busyRec() || rec !== shown || !recs.has(rec.id)) return }   // what is on the scratchpad goes along
    const card = rec.card
    const chosen = keys.map(k => card.options.find(o => o.key === k)).filter(Boolean)
    if (!chosen.length) return
    // what the list (or the undo offer) calls the answer: the one option, or all of them in one
    const option = chosen.length === 1 && !rec.multi ? chosen[0] : { key: keys.join(','), label: chosen.map(rec.labelOf).join(', '), detail: '' }
    const btn = rec.multi ? rec.sendTile : rec.optButtons.find(b => b.dataset.key === keys[0])
    const note = rec.noteNode ? rec.note.trim() : ''
    const files = rec.files.map(({ name, data }) => ({ name, data }))   // what is attached in the composer goes with the answer
    const optNotes = Object.fromEntries([...rec.optNotes].map(([k, text]) => [k, text.trim()]).filter(([, text]) => text))   // and the notes on single options
    clearTimeout(rec.draftTimer)
    rec.draftTimer = 0
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
      const sending = request(card, keys, note, files, optNotes)
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
      await request(card, keys, note, files, optNotes)
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

  /** Acknowledge an info card: it is closed (POST /close). In the walk it becomes the strip "Read", with the way
   *  back on it; the window of one card closes. */
  async function acknowledge(rec) {
    const card = rec.card
    if (rec.busy || busyRec() || !recs.has(rec.id)) return
    if (single) {
      rec.busy = true
      try { await closeInfo(card.id) } catch (err) { rec.busy = false; return refused(rec, err) }
      rec.busy = false
      decidedLocal.set(rec.id, Date.now())
      return close()
    }
    decidedLocal.set(rec.id, Date.now())
    decidedCount++
    sentId = rec.id
    const sending = closeInfo(card.id)
    offerBack(card, { head: 'Read', take: async () => { await sending.catch(() => {}); await reopen(card.id); decidedLocal.delete(card.id) } })
    sync('sent')
    try { await sending } catch (err) { returned(card, '', err) }
  }

  /** Trust: the card is answered with "you decide" (POST /decide {trust: true}); what stands in the composer goes
   *  along as the note. It collapses like any answer, with the way back on its strip. */
  async function trustIt(rec) {
    claim(rec)
    if (rec.busy || busyRec() || rec !== shown || rec.version != null || rec.card.kind !== 'decision') return
    await carryMarks(rec)
    const card = rec.card
    const note = rec.note.trim()
    const advice = card.options.filter(o => [].concat(card.recommended ?? []).includes(o.key)).map(o => o.label).join(', ')
    const send = async () => {
      const res = await fetch('/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ card_id: card.id, trust: true, note, revised: card.revised ?? null }) })
      let out = {}
      try { out = await res.json() } catch {}
      if (!res.ok) throw new Error(out.error || res.statusText)
    }
    clearTimeout(rec.draftTimer)
    rec.draftTimer = 0
    setError(rec, '')
    if (single) {
      rec.busy = true
      try { await send() } catch (err) { rec.busy = false; return refused(rec, err) }
      rec.busy = false
      decidedLocal.set(rec.id, Date.now())
      onDecided?.(card, { key: 'trust', label: `${TRUST_WORD}: ${advice || 'your call'}`, detail: '' }, [])
      return close()
    }
    rec.note = ''
    decidedLocal.set(rec.id, Date.now())
    decidedCount++
    sentId = rec.id
    offerBack(card, { head: `Trusted: ${advice || 'your call'}`, take: () => reopenAnswer(card) })
    const sending = send()
    inflight.set(card.id, sending)
    sync('sent')
    try { await sending } catch (err) { returned(card, note, err) } finally { if (inflight.get(card.id) === sending) inflight.delete(card.id) }
  }

  /** Shred: the question (or info) is thrown away unanswered (POST /shred; what stands in the composer goes along as
   *  a note). No asking back: its strip carries the way back. The card goes through the shredder in a short motion. */
  async function shredIt(rec) {
    claim(rec)
    if (rec.busy || busyRec() || rec !== shown || rec.card.kind === 'permission') return
    await carryMarks(rec)
    const card = rec.card
    const note = rec.askText.trim()
    const send = async () => {
      const res = await fetch('/shred', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ card_id: card.id, note }) })
      let out = {}
      try { out = await res.json() } catch {}
      if (!res.ok) throw new Error(out.error || res.statusText)
    }
    clearTimeout(rec.draftTimer)
    rec.draftTimer = 0
    if (single) {
      rec.busy = true
      try { await send() } catch (err) { rec.busy = false; return refused(rec, err) }
      rec.busy = false
      decidedLocal.set(rec.id, Date.now())
      close()
      return void say(pageHost(), { head: 'Shredded', title: card.title, back: async () => { await reopen(card.id) } })
    }
    if (!still()) { rec.node.dataset.shredding = ''; await wait(320) }
    if (!recs.has(rec.id)) return
    decidedLocal.set(rec.id, Date.now())
    sentId = rec.id
    const sending = send()
    offerBack(card, { head: 'Shredded', take: async () => { await sending.catch(() => {}); await reopen(card.id); decidedLocal.delete(card.id) } })
    sync('sent')
    try { await sending } catch (err) { returned(card, note, err) }
  }

  /** A hand-back taken back: the hub no longer counts the card as being with its session. */
  const unhand = id => globalThis.fetch('/handback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ card_id: id, clear: true }) }).catch(() => {})

  /** What was written and scribbled on the card goes along with whatever is done next: the notes as words, each with
   *  what it refers to (those on options as the options' notes), and one picture of the card as the human saw it. */
  async function carryMarks(rec) {
    const ui = rec.marksUi
    if (!ui || !ui.count() || rec.carrying) return
    rec.carrying = true
    try {
      const words = ui.text()
      if (words) rec.askText = [rec.askText.trim(), words].filter(Boolean).join('\n')
      for (const [key, text] of Object.entries(ui.optionNotes())) rec.optNotes.set(key, text)
      const data = await ui.picture()
      if (data) rec.files.push({ name: 'The card with my notes.png', data, image: true, drawn: true, size: 0 })
      rec.marks = []
      ui.set([])
    } finally { rec.carrying = false }
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
    dropStrip(card.id)
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
    if (single) { putOff(rec.id); close(); return void say(pageHost(), { head: 'Snoozed', title: rec.card.title, back: fetch }) }
    const at = order.indexOf(rec.id)
    const next = order[at + 1] ?? order.find(id => id !== rec.id)
    if (!next) return info('This is the only open question.')
    pendingJump = next
    jumpMotion = 'later'
    putOff(rec.id)   // the store tells every subscriber, this window included: sync() runs in here
    offerBack(rec.card, { head: 'Snoozed', take: fetch })
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

  // ── Send, Explain, Later: three plain buttons of one rank, each with its small drawing ──
  // (The buttons Explain and Later and what they do are made above; here they only get their look: the tile of
  // an option, small, with a drawing of the pen in it. They stand beside the composer of the card in front, see paintChrome.)
  explainBtn.replaceChildren(sketch('explain'), el('span', null, EXPLAIN_LABEL))
  explainBtn.title = `${EXPLAIN_LABEL} (E): ask the session to explain this question; it returns with the reply`
  explainBtn.classList.add('focus-way')
  laterBtn.classList.add('focus-way')
  laterBtn.replaceChildren(sketch(LATER_SKETCH), el('span', null, LATER_WORD))
  laterBtn.setAttribute('aria-label', `${LATER_WORD}: put this question off; it waits for you`)
  laterBtn.title = `${LATER_WORD} (L): it waits for you, at the end of the line`
  // The fourth of the row: hand the card to its session. It leaves, and returns only with the session's reply
  // (Later, beside it, waits for the human instead). Its mark is a playing card that turns the direction round.
  const handBtn = button('focus-later focus-handback focus-way', `${HAND_BACK_LABEL}: the session works on it, the question returns with its reply`)
  handBtn.title = `${HAND_BACK_LABEL} (B): it leaves, and returns when the session has replied`
  handBtn.append(sketch('reverse'), el('span', null, HAND_BACK_LABEL))
  let handing = false
  /** Hand the card in front to its session: what stands in the composer is sent first, then the card goes to
   *  "Later" as one the session owes a reply on, and comes back with that reply. The walk moves on; the window of one card closes. */
  async function handBack(sure = false) {
    const rec = shown
    if (!isOpen || !rec || rec.busy || !rec.askNode || handing) return false
    // With nothing written, noted or attached the session would have nothing to go on: the caret goes into Discuss
    // and asks what should change. Enter there hands the card back, also when the field stays empty.
    if (!sure && !rec.askText.trim() && !rec.files.length && !rec.marksUi?.count() && pad?.rec !== rec && rec.askField) {
      rec.revising = true
      setDiscuss(rec, true)
      rec.askField.placeholder = 'What should change? Enter sends'
      return void rec.askField.focus({ preventScroll: true })
    }
    rec.revising = false
    handing = true
    handBtn.disabled = true
    const walking = !single
    // whatever still stands in the composer goes first: words, attached files, what is on the scratchpad
    const words = rec.askText
    const sent = await askBack(rec, null, { handback: true }).catch(() => false)
    handing = false
    paintChrome()
    if (!isOpen) return
    if (!sent) return info('Not handed over: the session did not get your words.', true)
    // (the hub may already have told this page that the card is with its session: it has left the pass by then)
    if (walking && shown === rec && order.length > 1) { pendingJump = order[order.indexOf(rec.id) + 1] ?? order.find(id => id !== rec.id); jumpMotion = 'later' }
    putOff(rec.id, true, true)
    announce(`${HANDBACK_STATE}: ${rec.card.title}`)
    // Taken back (a slip of Enter): the card is here again, and the words are in its field again.
    const fetch = async () => {
      await unhand(rec.id)
      putOff(rec.id, false)
      const now = recs.get(rec.id)
      if (now && words.trim() && !now.askText) now.note = words
    }
    if (!walking) { close(); return void say(pageHost(), { head: HANDBACK_STATE, title: 'It comes back with the reply.', back: fetch }) }
    offerBack(rec.card, { head: HANDBACK_STATE, title: 'It comes back with the reply.', take: fetch })
  }
  handBtn.addEventListener('click', handBack)

  // ── how many more ───────────────────────────────────────────────────────
  // No rail: at the foot of the window, where the next card looks in, one quiet line says how many questions come
  // after the one in front. A tap goes to the next.
  const more = button('focus-more')
  more.hidden = true
  more.addEventListener('click', () => go(1))
  sheet.append(more)
  function paintMore() {
    const after = inList() && sheet.dataset.state === 'cards' ? order.length - 1 - order.indexOf(current) : 0
    more.hidden = !inList() || sheet.dataset.state !== 'cards' || !order.length
    if (more.hidden) return
    more.disabled = after <= 0
    more.replaceChildren(...(after > 0 ? [el('span', null, `${after} more`), icon('chevDown')] : [el('span', null, order.length > 1 ? 'Last one' : 'The only one')]))
  }

  // ── the walk as one list ────────────────────────────────────────────────
  // "Go through them" is one scrolling column of every open question, each the whole card it is, one under the
  // other in the order of the walk. The card at the reading line is the one in front (keys, the top bar). A card
  // that was answered, snoozed or handed to its session leaves a slim strip where it stood, with the way back on it.
  // (The window of one card, opened from a row or a link, stays what it was: that card alone, closed by its answer.)
  const inList = () => root.hasAttribute('data-list')
  const marksWish = new URLSearchParams(location.search).get('marks')
  const writeAnywhere = marksWish === '1' ? true : marksWish === '0' ? false : WRITE_ANYWHERE
  const headWish = new URLSearchParams(location.search).get('head')
  const besideTitle = headWish === '1' ? true : headWish === '0' ? false : ANSWERS_BESIDE_TITLE
  const strips = []        // { id, card, kind, node, anchor, back }: anchor is the card it stands in front of
  let orderBefore = []     // the order before it last changed: where a card stood that has just left or moved
  let scrollHow = 'smooth'
  const LIST_TOP = 70      // where the card in front begins, under the top edge of the list
  let quietUntil = 0       // while the list scrolls by itself, the reading line does not pick another card
  const listEnd = el('div', 'focus-list-end')
  const endPiles = button('focus-list-piles')
  const endClose = button('focus-list-close')
  endClose.textContent = 'Close'
  endClose.addEventListener('click', () => close())
  const endRow = el('div', 'focus-list-row')
  endRow.append(endPiles, endClose)
  listEnd.append(sketch('tick'), el('p', null, 'All answered. The next question shows up here.'), endRow)

  // ── one pass through the stack ──────────────────────────────────────────
  // The order of a pass is fixed when it starts: every open question once. What arrives later is appended at the
  // end, never put in above the card in front. Snoozed cards and cards that are with their session are not part
  // of the pass (the end of the stack counts them and offers to go through them on purpose); one that comes
  // back from its session is appended and says why it is here again. A card only scrolled past stays where it is.
  let pass = null                 // ids in the order of this pass; null until the first state of the walk
  const passAway = new Map()      // id -> when it left the pass by being put off or handed over
  const passPiles = new Set()     // put-off cards taken into the pass on purpose
  const passBack = new Map()      // id -> the card it stood in front of: taken back, it returns there
  const cameBack = new Map()      // id -> why a card is in the pass a second time
  function passOrder(open, off, handed, byId) {
    const away = id => off.has(id) && !passPiles.has(id)
    if (!pass) pass = open.filter(id => !away(id))
    for (const id of open) if (away(id) && !passAway.has(id)) passAway.set(id, Date.now())
    pass = pass.filter(id => open.includes(id) && !away(id))
    for (const id of open) {
      if (pass.includes(id) || away(id)) continue
      if (passBack.has(id)) {
        const at = pass.indexOf(passBack.get(id))
        pass.splice(at < 0 ? pass.length : at, 0, id)
      } else {
        // new, or back from its session (reworded, or with a reply)
        if (passAway.has(id) && !passPiles.has(id)) cameBack.set(id, (byId.get(id)?.revised ?? 0) > passAway.get(id) ? 'Presented again' : 'Answered your question')
        pass.push(id)
      }
      passBack.delete(id)
      passAway.delete(id)
    }
    const snoozed = open.filter(id => away(id) && !handed.has(id)).length, withAgent = open.filter(id => away(id) && handed.has(id)).length
    endPiles.hidden = !snoozed && !withAgent
    endPiles.textContent = [snoozed ? `${snoozed} snoozed` : '', withAgent ? `${withAgent} ${HANDBACK_STATE.toLowerCase()}` : ''].filter(Boolean).join(' · ') + ': go through them'
    endPiles.onclick = () => { for (const id of open) if (away(id)) passPiles.add(id); sync() }
    return [...pass]
  }

  /** "What??" as it is shown: the word in type, its two question marks written by hand. */
  function whatWord() {
    const word = el('span', 'focus-what', 'What')
    word.append(sketch('q1'), sketch('q2'))
    return word
  }
  /** One of the three ways to leave a card without answering, as a button without a word: three question marks
   *  written by hand (What??), the card that turns the direction round (Back to agent), z z z (Snooze). The word
   *  is its label for a reader, shows on hover and focus, and stands beside the drawing in a narrow window. */
  function wayButton(kind, act) {
    const [cls, word, label] = {
      what: ['focus-explain', EXPLAIN_LABEL, `${EXPLAIN_LABEL} (E): ask the session to explain this; it returns with the reply`],
      hand: ['focus-handback', HAND_BACK_LABEL, `${HAND_BACK_LABEL} (B): it leaves, and returns when the session has replied`],
      snooze: ['', LATER_WORD, `${LATER_WORD} (L): it waits for you, at the end of the line`],
      shred: ['focus-shred', SHRED_WORD, `${SHRED_WORD} (X): throw this away, unanswered`],
      trust: ['focus-whatever', TRUST_WORD, `${TRUST_WORD} (R): leave this decision to the agent`],
    }[kind]
    const b = button(`focus-later ${cls} focus-way`, label)
    b.title = label
    const art = el('span', 'focus-way-art')
    art.dataset.kind = kind
    art.append(...(kind === 'what' ? [sketch('q1'), sketch('q2'), sketch('q3')] : [sketch(kind === 'hand' ? 'reverse' : kind === 'shred' ? SHRED_SKETCH : kind === 'trust' ? TRUST_SKETCH : LATER_SKETCH)]))
    b.append(art, el('span', 'focus-way-word', word))
    b.addEventListener('click', act)
    return b
  }
  function dropStrip(id) {
    const at = strips.findIndex(x => x.id === id)
    if (at < 0) return
    strips[at].node.remove()
    strips.splice(at, 1)
  }
  /** A card becomes a strip where it stood: what happened to it (head), its title, and with take() the way back. */
  function addStrip(card, head, take) {
    dropStrip(card.id)
    const kind = head === 'Shredded' ? 'shredded' : /^(Answered|Trusted):/.test(head) || head === 'Read' ? 'answered' : head === 'Snoozed' ? 'snoozed' : head === HANDBACK_STATE ? 'handed' : /^Asked/.test(head) ? 'asked' : 'gone'
    // where it stood: in front of the card that came after it (before it left or moved to the end)
    const moved = !order.includes(card.id) || (lastState?.later ?? []).includes(card.id)
    const from = moved && orderBefore.includes(card.id) ? orderBefore : order
    const anchor = from[from.indexOf(card.id) + 1] ?? null
    for (const x of strips) if (x.anchor === card.id) x.anchor = anchor
    const node = el('div', 'focus-strip')
    node.dataset.kind = kind
    const mark = el('span', 'focus-strip-mark')
    mark.append(kind === 'answered' ? icon('check') : kind === 'shredded' ? sketch(SHRED_SKETCH) : sketch(kind === 'snoozed' ? LATER_SKETCH : kind === 'handed' ? 'reverse' : kind === 'asked' ? 'explain' : 'other'))
    const text = el('span', 'focus-strip-text')
    text.append(el('b', null, head), ` · ${card.title}`)
    node.append(mark, text)
    const entry = { id: card.id, card, kind, node, anchor, back: null }
    if (take) {
      const b = button('focus-strip-back', `Back: take this back, ${card.title}`)
      b.title = 'Back (U)'
      b.append(icon('undo'), el('span', null, 'Back'))
      entry.back = async () => {
        if (b.disabled) return
        b.disabled = true
        passBack.set(card.id, entry.anchor)   // it returns to where it stood, not to the end of the pass
        try { await take() } catch (err) { b.disabled = false; passBack.delete(card.id); return info(`Not taken back: ${err?.message || 'The server did not answer.'}`, true) }
        dropStrip(card.id)
        pendingJump = card.id
        jumpMotion = 'prev'
        setTimeout(() => { if (pendingJump === card.id) pendingJump = null }, 5000)
        sync()
        announce(`Taken back: ${card.title}`)
      }
      b.addEventListener('click', entry.back)
      node.append(b)
    }
    strips.push(entry)
    announce(`${head}: ${card.title}`)
    arrange()
    paintMore()
  }
  /** Put the list in its order: the open cards as the walk has them, each strip in front of its anchor, the end last. */
  function arrange() {
    if (!inList()) return
    const off = new Set(lastState?.later ?? [])
    // a strip is over once its card is back among the open ones by itself (the session replied, or it was fetched back elsewhere)
    for (const x of [...strips]) {
      if (x.kind === 'answered' || x.kind === 'gone' || x.kind === 'shredded' ? order.includes(x.id) && !decidedLocal.has(x.id) : !off.has(x.id)) dropStrip(x.id)
    }
    const want = []
    const placed = new Set()
    for (const id of order) {
      for (const x of strips) if (x.anchor === id) { want.push(x.node); placed.add(x) }
      want.push(recs.get(id).node)
    }
    for (const x of strips) if (!placed.has(x)) want.push(x.node)
    // the one sentence at the end: all answered, or simply the end of the stack
    listEnd.querySelector('p').textContent = order.length ? 'That was the last one.' : 'All answered. The next question shows up here.'
    want.push(listEnd)
    const mine = n => n.classList.contains('focus-card') || n.classList.contains('focus-strip') || n === listEnd
    const have = [...stage.children].filter(mine)
    if (have.length === want.length && have.every((n, i) => n === want[i])) return
    // what is being read stays where it is on the screen
    const keep = shown?.node.isConnected ? shown.node : null
    const top = keep?.getBoundingClientRect().top
    for (const n of have) if (!want.includes(n)) n.remove()
    want.forEach((n, i) => { const at = [...stage.children].filter(mine)[i]; if (at !== n) stage.insertBefore(n, at ?? null) })
    if (keep?.isConnected) stage.scrollTop += keep.getBoundingClientRect().top - top
  }
  /** Bring the card in front to the reading line (or just mark it, when the scrolling itself chose it). */
  function presentList(motion) {
    const next = current ? recs.get(current) : null
    for (const rec of recs.values()) { rec.node.inert = false; rec.node.removeAttribute('data-out'); rec.node.removeAttribute('data-in') }
    const changed = shown !== next
    if (shown && changed) delete shown.node.dataset.shown
    shown = next
    if (!next) return
    next.node.dataset.shown = ''
    // The same card is still in front (the board's state changed: a session posted, a draft was saved): the
    // column stays where the human has it. Scrolled back to the card's top, an answer would move away under the pointer.
    if (motion === 'scroll' || !changed) return
    // The card in front always lands at the same place: one strip's height under the top edge, so the newest
    // strip (what was just done) is the one thing in sight above it and older ones are a scroll further up.
    const to = Math.max(0, next.node.offsetTop - LIST_TOP)
    const how = motion === 'none' || still() || Math.abs(to - stage.scrollTop) > stage.clientHeight * 2.5 ? 'instant' : scrollHow
    scrollHow = 'smooth'
    quietUntil = performance.now() + (how === 'smooth' ? 1600 : 120)
    stage.scrollTo({ top: to, behavior: how })
  }
  /** Make a card the one in front without moving anything: it was tapped, typed in, or answered. */
  function claim(rec) {
    pendingJump = null   // the human chose a card: a card on its way back does not take the front from it
    if (!inList() || rec === shown || recs.get(rec.id) !== rec) return
    current = rec.id
    present('scroll')
    paintChrome()
    paintHint()
  }
  /** The card at the reading line (a third down the window) is the one in front. */
  function readLine() {
    if (!isOpen || !inList() || performance.now() < quietUntil || busyRec()) return
    const box = stage.getBoundingClientRect()
    const line = box.top + box.height * .45
    let best = null
    for (const id of order) {
      const r = recs.get(id).node.getBoundingClientRect()
      if (r.top > line) { best ??= id; break }
      best = id
      if (r.bottom > line) break
    }
    if (!best || best === current) return
    pendingJump = null
    current = best
    present('scroll')
    paintChrome()
    paintHint()
  }
  stage.addEventListener('scrollend', () => { quietUntil = 0 })
  let lineRaf = 0
  stage.addEventListener('scroll', () => { if (!lineRaf) lineRaf = requestAnimationFrame(() => { lineRaf = 0; readLine() }) }, { passive: true })
  for (const type of ['pointerdown', 'focusin']) {
    stage.addEventListener(type, e => { const rec = recs.get(e.target.closest?.('.focus-card')?.dataset.id); if (rec) claim(rec) }, true)
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
      if (byId.has(wanted)) { single = true; current = wanted; pastId = byId.get(wanted).status === 'open' ? null : wanted; root.setAttribute('data-single', ''); root.removeAttribute('data-list') }
      wanted = null
    }
    const prevOrder = order
    const prevIndex = prevOrder.indexOf(current)
    // The server's order, most urgent first; what the human put off comes after everything else.
    const put = id => (state.later ?? []).indexOf(id)
    let next = [...new Set(state.queue)].filter(isOpenCard).sort((a, b) => put(a) - put(b))
    if (!single) next = passOrder(next, new Set(state.later ?? []), new Set(state.handed ?? []), byId)
    // the one card of this window may belong to a session the page behind is not looking at
    if (single && current && !next.includes(current) && (isOpenCard(current) || (pastId === current && byId.has(current)))) next.unshift(current)
    // The one card this window was opened on is gone (withdrawn, or answered elsewhere): so is the window.
    if (single && current && !next.includes(current) && busyRec()?.id !== current) return close()
    // a card whose answer is still travelling stays put until the request settles
    const busy = busyRec()
    if (busy && !next.includes(busy.id)) next.splice(clamp(prevOrder.indexOf(busy.id), 0, next.length), 0, busy.id)
    if (next.join() !== order.join()) orderBefore = order
    order = next
    root.toggleAttribute('data-list', LIST_WALK && !single)

    let lost = null
    for (const [id, rec] of recs) {
      if (order.includes(id)) continue
      recs.delete(id)
      if (inList()) {
        // In the list a card that leaves is a strip from then on: its answer, or why it is gone.
        clearTimeout(rec.outTimer)
        // (one that is only put off or with its session keeps no such strip: the action that did it leaves its own)
        if (byId.get(id)?.status !== 'open' && saidNote?.card !== id) say(says, { head: byId.get(id)?.choice != null ? 'Answered elsewhere' : 'Withdrawn by the agent', title: rec.card.title })
        rec.node.remove()
        if (rec === shown) shown = null
      } else if (rec === shown) { if (id !== sentId && !decidedLocal.has(id)) lost = { rec, card: byId.get(id) } }
      else { clearTimeout(rec.outTimer); rec.node.remove() }
    }

    sentId = null

    const promoted = []
    for (const id of order) {
      let rec = recs.get(id)
      const card = byId.get(id) ?? rec.card
      // Urgency, sender and age are painted in the top bar, so they never rebuild a card.
      const sigC = JSON.stringify([card.status, card.choice, card.choices, card.note, card.version, card.versions?.length, card.revised, card.kind, card.title, card.body, card.options, card.recommended, card.multiple, card.attachments, card.agent_name])
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
      if (rec.sigC !== sigC) {
        // reworded by its session while it stands here: it is presented again, not swapped in silence
        const again = Boolean(rec.sigC) && (card.version ?? 1) > (rec.seenVersion ?? 1)
        rec.seenVersion = card.version ?? 1
        rec.sigC = sigC
        rec.version = null
        fill(rec)
        if (again) {
          rec.node.removeAttribute('data-again')
          void rec.node.offsetWidth
          rec.node.dataset.again = ''
          setTimeout(() => rec.node.removeAttribute('data-again'), 1600)
          if (rec === shown) info(`Presented again: ${card.title}`)
        }
      }
      else {
        rec.reasonNode.textContent = card.urgency_reason || ''
        rec.reasonNode.hidden = !card.urgency_reason
        paintThread(rec)
      }
      adoptDraft(rec)
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

    arrange()
    sheet.dataset.state = !isLoaded() ? 'loading' : order.length || (inList() && strips.length) ? 'cards' : 'done'
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
    if (inList()) return presentList(motion)
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
    doneText.textContent = 'All answered. The next question shows up here.'

    // the head of the card and the sheet's colour follow the card in front
    const card = shown?.card
    meta.hidden = !card
    laterBtn.hidden = !card || card.kind === 'permission'
    laterBtn.disabled = locked
    explainBtn.hidden = laterBtn.hidden
    explainBtn.disabled = locked || explaining
    for (const b of stage.querySelectorAll('.focus-card-say')) { b.hidden = sayBtn.hidden; b.setAttribute('aria-pressed', sayBtn.getAttribute('aria-pressed') ?? 'false') }
    if (shown?.pictureOf) { const rec = shown; requestAnimationFrame(() => { if (recs.get(rec.id) === rec) linkPicture(rec) }) }   // its arrow, once it is laid out
    if (pad && pad.rec !== shown) closePad(true)   // the card with the open scratchpad left the front: its drawing is kept as a picture
    handBtn.hidden = laterBtn.hidden
    handBtn.disabled = locked || handing
    paintMore()
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

  function go(target, how = 'smooth') {
    scrollHow = how
    if (!isOpen || busyRec()) return false
    const at = order.indexOf(current)
    const id = typeof target === 'number' ? order[at + target] : target
    if (!id || id === current || !recs.has(id)) return false
    root.toggleAttribute('data-list', LIST_WALK)
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
  /** Is the card in front really the one in sight? A key that cannot be taken back lightly acts only then. */
  const inSight = rec => {
    if (!rec?.node.isConnected) return false
    if (!inList()) return true
    const r = rec.node.getBoundingClientRect(), f = stage.getBoundingClientRect()
    return Math.min(r.bottom, f.bottom) - Math.max(r.top, f.top) >= Math.min(r.height, f.height) * .4
  }
  // In the time machine the arrows step through the versions, and nothing answers.
  function stepVersion(by) {
    const all = [...shown.card.versions.map(v => v.n), shown.card.version ?? shown.card.versions.at(-1).n + 1]
    viewVersion(shown, all[all.indexOf(shown.version) + by] ?? shown.version)
  }
  const thumb = which => key((_, e) => {
    if (shown?.version != null) return
    const pick = shown?.[which]
    if (pick) submit(shown, [pick])
  })
  function stepOption(by) {
    const all = [...(shown?.optButtons ?? []), shown?.sendTile].filter(b => b && !b.disabled)
    const at = all.indexOf(document.activeElement)
    if (at < 0) return false   // the arrows scroll the text, as ever
    all[(at + by + all.length) % all.length].focus()
  }
  /** Open the line to ask back on the card that is up. */
  function ask() {
    if (shown?.composer) setDiscuss(shown, true)
    const open = shown?.askNode?.querySelector('.focus-ask-open')
    if (!open) return false
    open.click()
  }
  provide('focus', {
    active: () => isOpen,
    // In the window of one card there is no next and no previous.
    has: id => !(shown && shown.card.status !== 'open' && id !== 'focus.leave') && !(single && shown?.version == null && (id === 'focus.next' || id === 'focus.prev')) && !(id === 'focus.voice' && !getState().speech),
    actions: {
      // (in the time machine the same keys step through the versions of the card)
      'focus.next': key(() => { if (shown?.version != null) return stepVersion(1); if (!single) go(1) }),
      'focus.prev': key(() => { if (shown?.version != null) return stepVersion(-1); if (!single) go(-1) }),
      // a two-option card: the thumbs. Left is no, right is yes, as the tiles stand.
      'focus.yes': thumb('yesKey'),
      'focus.no': thumb('noKey'),
      'focus.later': key(() => later()),
      // The note while it is up; a little longer, the key alone.
      'focus.back': key(() => { const last = strips.findLast(x => x.back); if (inList() && last) last.back(); else backNow() }),
      'focus.explain': key(() => explain()),
      'focus.handback': key(() => handBack()),
      'focus.shred': key(() => { if (!shown?.askNode || !inSight(shown)) return false; shredIt(shown) }),
      'focus.draw': key(() => { if (!shown?.marksUi) return false; shown.marksUi.setPen(!shown.marksUi.penOn()) }),
      'focus.note': key(ask),   // a general note is written in Discuss
      'focus.trust': key(() => { if (!shown?.trustBtn || !inSight(shown)) return false; trustIt(shown) }),
      'focus.send': key(() => { if (!shown?.multi) return false; shown.sendTile.click() }),
      'focus.pick': key(n => {
        const btn = shown?.optButtons[n - 1]
        if (!btn) return false
        if (shown.busy) return
        if (shown.multi) toggle(shown, btn.dataset.key)
        else submit(shown, [btn.dataset.key])
      }),
      'focus.choices': key(() => { const btn = shown?.optButtons[0]; if (!btn) return false; btn.focus() }),
      // Once the keyboard is on an option, up and down go through all of them (more than nine have no digit).
      'focus.option.next': key(() => stepOption(1)),
      'focus.option.prev': key(() => stepOption(-1)),
      // Dictate into the composer: a tap starts, the next stops; held for longer than a moment, letting go stops.
      'focus.voice': key(() => {
        if (isDictating()) return void stopDictation()
        if (!shown?.askField) return false
        startDictation(shown.askField)
        return ms => { if (ms > 300) stopDictation() }
      }),
      'focus.ask': key(ask),
      'focus.leave': key((_, e) => {
        const typing = e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
        if (typing) { typing.blur(); (shown?.node ?? sheet).focus({ preventScroll: true }) }
        else if (shown?.marksUi?.penOn()) shown.marksUi.setPen(false)   // out of drawing first
        else if (shown?.version != null) viewVersion(shown, null)   // out of the time machine first
        else close()
      }),
    },
  })

  // ── touch: swipe the card sideways to move without answering ────────────
  // (in the window of one card there is nowhere to go: it only gives a little)
  let swallowClickUntil = 0
  stage.addEventListener('pointerdown', e => {
    if (inList() || e.pointerType === 'mouse' || e.button || drag || zoom || !shown || busyRec()) return   // in the list a finger scrolls
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

    // Where the pictures belong to options, the enlarged view can show all of them at once, each with its word.
    let gridBtn = null, bigGrid = null
    if (rec?.pictureOf && rec.pictureOf.size >= 4) {
      const keyAt = new Map([...rec.pictureOf].map(([key, at]) => [at, key]))
      bigGrid = el('div', 'focus-zoom-grid')
      bigGrid.hidden = true
      images.forEach((a, k) => {
        const o = rec.card.options.find(x => x.key === keyAt.get(k))
        const tile = button('focus-zoom-tile', `Show ${o?.label ?? a.name} large`)
        const small = el('img')
        small.src = a.url
        small.alt = ''
        small.draggable = false
        tile.append(small, el('span', null, o?.label ?? a.name))
        tile.addEventListener('pointerenter', () => { if (i !== k) show(k) })
        tile.addEventListener('click', () => { setGrid(false); show(k) })
        bigGrid.append(tile)
      })
      gridBtn = button('focus-zoom-flip')
      gridBtn.addEventListener('click', () => setGrid(bigGrid.hidden))
      bar.insertBefore(gridBtn, shut)
      box.insertBefore(bigGrid, bar)
    }
    function setGrid(on) {
      bigGrid.hidden = !on
      view.hidden = on
      prev.hidden = next.hidden = on || images.length < 2
      gridBtn.textContent = on ? 'One large picture' : 'All in a grid'
    }

    const pageBtn = el('a', 'focus-zoom-flip')
    pageBtn.target = '_blank'
    pageBtn.rel = 'noopener noreferrer'
    pageBtn.textContent = 'Open the page'
    const liveBtn = button('focus-zoom-flip')
    liveBtn.textContent = 'Live'
    liveBtn.title = 'Show the page itself here, to try it'
    let live = null
    const setLive = on => {
      live?.remove()
      live = null
      view.hidden = false
      liveBtn.setAttribute('aria-pressed', String(on))
      liveBtn.textContent = on ? 'Picture' : 'Live'
      if (!on) return
      live = el('iframe', 'focus-zoom-live')
      live.setAttribute('sandbox', 'allow-scripts')   // no origin of ours: neither cookies nor storage nor the board's page
      live.referrerPolicy = 'no-referrer'
      live.src = images[i].page.url
      live.title = images[i].title || images[i].name
      view.hidden = true
      view.after(live)
    }
    liveBtn.addEventListener('click', () => setLive(!live))
    bar.insertBefore(pageBtn, shut)
    bar.insertBefore(liveBtn, shut)

    let i = start
    const show = to => {
      i = (to + images.length) % images.length
      setLive(false)
      pageBtn.hidden = liveBtn.hidden = !images[i].page?.url
      if (images[i].page?.url) pageBtn.href = images[i].page.url
      bigGrid?.querySelectorAll('.focus-zoom-tile').forEach((t, k) => t.toggleAttribute('data-lit', k === i))
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
    if (bigGrid) setGrid(false)
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
      if (rec.marksUi) {
        const pen = optionPencil(rec, o.key, rec.labelOf(o))
        pen.addEventListener('click', () => shut(), true)   // the note is written on the card, at the option
        b.append(pen)
      }
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
    ways.append(wayButton('snooze', () => { shut(); later() }), wayButton('hand', () => { shut(); handBack() }), ...(card.kind === 'info' ? [] : [wayButton('trust', () => { shut(); trustIt(rec) })]), wayButton('shred', () => { shut(); shredIt(rec) }))
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
      requestAnimationFrame(() => { if (node.isConnected) pointAt(node.closest('.focus-zoom'), buttons.find(b => b.hasAttribute('data-match')) ?? null, node.closest('.focus-zoom').querySelector('.focus-zoom-img')) })
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
    // (a card that is not open any more opens too: to read, with its answer; see fill)
    pastId = card && card.status !== 'open' ? cardId : null
    single = Boolean(card) && (pastId != null || !decidedLocal.has(cardId))
    wanted = cardId && !isLoaded() ? cardId : null
    root.toggleAttribute('data-single', single)
    root.toggleAttribute('data-list', LIST_WALK && !single)
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
    strips.length = 0
    orderBefore = []
    pass = null
    passAway.clear()
    passPiles.clear()
    passBack.clear()
    cameBack.clear()
  }

  function close() {
    if (!isOpen) return
    for (const rec of recs.values()) flushDraft(rec)
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

  /** Revise from outside (a row of the desk): on the card that is open, Discuss opens and the caret asks what should
   *  change; Enter there hands the card back. Call it after open(cardId). */
  const revise = () => { if (!shown?.askNode) return false; handBack(); return true }
  /** The card that was just opened, at its first picture (the Desk's picture stack). False, and the window closed
   *  again, when it has no pictures. */
  function gallery() {
    const rec = shown ?? recs.get(current)
    if (!rec?.galleryImages?.length) { close(); return false }
    rec.showImage?.(0)
    rec.scroll?.scrollTo({ top: 0 })
    return true
  }
  return { open, close, ask, revise, gallery, isOpen: () => isOpen }
}
