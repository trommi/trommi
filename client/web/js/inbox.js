// Question rows, and the lists made of them: the inbox (every open question of every
// session, grouped by who is asking) and one session's own questions.
// Every row is the same height with its answer at the right edge, always in the same place:
// thumb down and thumb up for a two-way question, otherwise one wide "Choose", which unfolds
// the options below the row. Beside them a small arrow puts the question off: it leaves its
// sender's group for one group at the very end, so that working down the list comes to an end.
// The list can be worked down with the keyboard alone; answer one, the next stands in its place.

import { el, rich, agoNode, doodle, sketch, crown, kindOf, tidyLinks, linkInfo, adviceLoop, cardNote, tally, ageClock, ago, LATER_WORD, LATER_SKETCH, WAKE_WORD, WAKE_SKETCH, ACK_WORD, ACK_SKETCH, WHAT_WORD, WHAT_SKETCH, TRUST_WORD, TRUST_SKETCH, HANDBACK_WORD, WALK_WORD, SHRED_WORD, SHRED_SKETCH, runBracket, KNOCK_SKETCH, isKnock, knockWord, knocksText, INBOX_WORD } from './ui.js'
import { hueFor } from './agents.js'
import { loopPath, penSeed, INBOX_SKETCH } from './ui.js'
import { richMark } from './richhtml.js'
import { decide, putOff, sendMessage, reopen, closeInfo, trust, shred } from './store.js'
import { openLightbox } from './chat.js'
import { provide, hint } from './keys.js'
import { say, pageHost, backUsedAt } from './back.js'
import { copyButton } from './cardclip.js'

const RANK = { critical: 3, high: 2, normal: 1, low: 0 }
// A card's number, as it is written wherever a card is named: small and quiet, for looking it up.
export const cardNr = card => `Nr. ${card.number}`
// What "Explain" asks the session, about a card, in one tap.
export const EXPLAIN_TEXT = 'Explain this question in more detail and in plain words: what it is about, what each option means for me, and what you would do.'

// The one rule for a word under a thumb. A tile has room for two short lines; a label stands there
// only if it fits them whole, broken between words or after a hyphen, never inside a word.
// A label that needs more is not shrunk and not cut: its card is answered through "Choose",
// where every option has a line of its own.
const TILE_LINE = 14
export function fitsTile(label) {
  let lines = 1, used = 0
  for (const word of String(label).trim().replace(/-(?=\S)/g, '- ').split(/\s+/)) {
    if (word.length > TILE_LINE) return false
    if (used && used + 1 + word.length > TILE_LINE) { lines++; used = word.length } else used += (used ? 1 : 0) + word.length
  }
  return lines <= 2
}

// Answerable by thumb: a two-way question. Two options whose labels fit a tile, at most about
// three lines of text, and nothing attached beyond pictures, which the row shows.
const quick = card => !card.multiple && (card.kind === 'permission' || card.options.length === 2)
// How a pair of labels stands under its thumbs: at the usual size if both fit a tile whole, smaller if
// both fit then (three shorter lines), and not at all otherwise: then the thumbs stand alone and each
// label is its tile's tooltip. A word is never broken inside.
const fitsSmall = label => {
  let lines = 1, used = 0
  for (const word of String(label).trim().replace(/-(?=\S)/g, '- ').split(/\s+/)) {
    if (word.length > 17) return false
    if (used && used + 1 + word.length > 17) { lines++; used = word.length } else used += (used ? 1 : 0) + word.length
  }
  return lines <= 3
}
const labelSize = options => (options.every(o => fitsTile(o.label)) ? 'usual' : options.every(o => fitsSmall(o.label)) ? 'small' : 'none')

// A plain yes or no needs no word under its thumb.
const BARE = /^(yes|no|ok|okay|allow|deny|ja|nein)$/i

// "Choose" unfolds a card in its row. A card with more than fits there comfortably opens as a
// window instead: a long text, code, several pictures, anything to play or download, many options.
const needsWindow = card =>
  (card.body ?? '').length > 480 || /```/.test(card.body ?? '') || card.options.length > 6 ||
  (card.attachments ?? []).filter(a => kindOf(a) === 'image').length > 1 || (card.attachments ?? []).some(a => kindOf(a) !== 'image')

// What the agent would pick: one option, or several where several are allowed.
const advised = (card, key) => [].concat(card.recommended ?? []).includes(key)

// The "Answered" group at the end of the inbox stands folded to one line until it is opened.
let answeredOpen = false
const ANSWERED_MAX = 40   // so many of the latest answers are listed
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString()
// What a row is: an open question, one that was put off, or one that was answered.
const kindOfRow = node => (node.classList.contains('inbox-done') ? 'done' : 'later' in node.dataset ? 'later' : 'open')

// Rows that stand unfolded, by card id: a list that is rebuilt keeps them open.
const unfolded = new Set()

// ---- a pile that unfolds: what lies below the open questions (snoozed, with the agent, answered) ----
// At the foot of the list the piles stand side by side, each small: its count as a tally of pen strokes
// (five to a gate), its name, and under it one line, the latest of what is in it. A click on a pile, or
// Enter on its line, opens its list in place: it takes the whole width, its line becomes a dividing line
// and every entry a full row. Again, and it is folded. One pile is open at a time.
const pilesOpen = new Set()   // piles that stand open, by "<session or empty>:<kind>"; kept while the page lives
const pileFold = new WeakMap()   // a pile's section -> the function that pushes it together
/** One pile. kind: 'later' | 'asked' | 'answered' | … (class inbox-group-<kind>, data-pile). label and
 *  count: the words on its line. icon: a sketch() name. open: how it stands at first. onToggle(open).
 *  items: [{ title, lead?, tail?, node }]: title and tail are what a folded card shows, lead a small
 *  mark before them; node is the full row, or a function that builds it when the pile is first opened.
 *  headClass: one more class for the line's button. Returns the section; piles that are siblings in
 *  one list are a row of piles (CSS: .inbox-groups > .inbox-pile). */
export function pile({ kind, label, icon, count, open = false, onToggle, items, headClass = '' }) {
  const section = el('section', `inbox-group inbox-pile inbox-group-${kind}`)
  section.dataset.pile = kind
  const title = el('h3', 'inbox-sender inbox-pile-title')
  const head = el('button', `inbox-pile-head ${headClass}`.trim())
  head.type = 'button'
  const avatar = el('span', 'inbox-avatar')
  avatar.append(sketch(icon))
  const fold = el('span', 'inbox-pile-fold')
  fold.append(sketch('unfold'))
  // Folded, the pile shows its count as a tally of pen strokes (five to a gate) above its name.
  const strokes = tally(items.length, 15)   // three gates at most; beyond that the strokes simply stop
  strokes.classList.add('inbox-pile-tally')
  head.append(strokes, avatar, el('span', null, label), el('b', null, count), fold)
  title.append(head)
  const sheets = el('div', 'inbox-pile-sheets')
  const fulls = items.map(item => {
    const sheet = el('div', 'inbox-pile-item')
    const peek = el('div', 'inbox-pile-peek')
    peek.setAttribute('aria-hidden', 'true')
    const words = el('span', 'inbox-pile-words')
    words.append(el('strong', null, item.title))
    if (item.tail) words.append(el('span', null, item.tail))
    if (item.lead) peek.append(item.lead)
    peek.append(words)
    const full = el('div', 'inbox-pile-full')
    if (typeof item.node !== 'function') full.append(item.node)
    sheet.append(peek, full)
    sheets.append(sheet)
    return full
  })
  const isOpen = () => section.classList.contains('is-open')
  const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches
  const set = (to, moving) => {
    moving = moving && section.isConnected && !calm()
    const sheetsNow = [...sheets.children]
    const others = moving ? [...section.parentElement.children].filter(n => n !== section && n.matches('.inbox-pile')) : []
    const read = () => sheetsNow.map(n => { const cs = getComputedStyle(n); return { width: `${n.offsetWidth}px`, height: `${n.offsetHeight}px`, marginTop: cs.marginTop, marginLeft: cs.marginLeft, rotate: cs.rotate, opacity: cs.opacity } })
    const from = moving ? read() : null
    const places = others.map(n => n.getBoundingClientRect())
    // Rows that are built on demand are built when the pile first opens.
    if (to) items.forEach((item, i) => { if (typeof item.node === 'function' && !fulls[i].firstChild) fulls[i].append(item.node()) })
    section.classList.toggle('is-open', to)
    head.setAttribute('aria-expanded', String(to))
    head.title = to ? 'Push them together again' : 'Unfold'
    for (const full of fulls) full.inert = !to
    if (!moving) return
    // Each sheet grows from the card or the edge it was to its row (or back), one a moment after the
    // other; a pile beside this one glides to where it now lies.
    const after = read()
    section.classList.add('is-moving')
    const runs = sheetsNow.map((n, i) => n.animate([from[i], after[i]], { duration: 360, delay: Math.min(i, 7) * 26, fill: 'backwards', easing: 'cubic-bezier(.3, .9, .3, 1)' }))
    if (to) for (const full of fulls) full.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: 'ease-out' })
    Promise.allSettled(runs.map(r => r.finished)).then(() => section.classList.remove('is-moving'))
    others.forEach((n, i) => {
      const now = n.getBoundingClientRect()
      if (now.left !== places[i].left || now.top !== places[i].top) n.animate([{ translate: `${places[i].left - now.left}px ${places[i].top - now.top}px` }, { translate: '0 0' }], { duration: 360, easing: 'cubic-bezier(.3, .9, .3, 1)' })
    })
  }
  const toggle = to => {
    // One pile is open at a time: the others are pushed together first.
    if (to) for (const other of section.parentElement?.children ?? []) if (other !== section && other.matches('.inbox-pile.is-open')) pileFold.get(other)?.()
    set(to, true)
    onToggle?.(to)
  }
  pileFold.set(section, () => { set(false, true); onToggle?.(false) })
  head.addEventListener('click', () => toggle(!isOpen()))
  // The folded pile itself is the way in: a click anywhere on it unfolds it.
  sheets.addEventListener('click', () => { if (!isOpen()) { toggle(true); head.focus({ preventScroll: true }) } })
  set(open, false)
  section.append(title, sheets)
  return section
}
/** The circle round a count, drawn with the pen (the same hand as the sidebar's ring); it stretches to its number. */
const CIRCLE = loopPath(penSeed('count circle'), { rad: 14.2, drift: 1.4, jitter: .8, start: 4.1 })
function penCircle() {
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 32 32')
  svg.setAttribute('preserveAspectRatio', 'none')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(NS, 'path')
  path.setAttribute('d', CIRCLE)
  svg.append(path)
  return svg
}

/** A session's mark, small, for a line that names who asked; a starred one wears its crown. */
function smallMark(session) {
  const mark = el('span', 'inbox-from-mark')
  mark.style.setProperty('--hue', hueFor(session))
  mark.append(doodle(session.mark ?? session.id))
  if (session.starred) mark.append(crown())
  return mark
}

// The body as one line of plain words; a link stands as what it is, never as its long address.
// Why something did not get through, as a sentence a human can read: the browser's own word for
// a lost connection is "Failed to fetch".
const why = err => (err instanceof TypeError ? 'no connection to the board' : err?.message || 'the board did not answer')

const plain = text => tidyLinks(String(text ?? '').replace(/```[\s\S]*?```/g, ' ')).replace(/(?<![\w.])__(?=\S)([^_\n]+?)__/g, '$1').replace(/[*`#]/g, '').replace(/\s+/g, ' ').trim()

/** A row in a list has a fixed height. A title that needs two lines leaves room for one
 *  line of text below it, a one-line title for two. Measured, because it depends on the
 *  width and on the font that finally loaded; whole lines only, never a cut one.
 *  Returns the observer a list hands to its rows; unobserve a row's title when the row goes. */
export const lineFit = () => new ResizeObserver(entries => {
  for (const { target } of entries) {
    if (!target.clientHeight) continue
    const two = target.clientHeight > parseFloat(getComputedStyle(target).lineHeight) * 1.5
    target.closest('.inbox-row')?.toggleAttribute('data-tall', two)
  }
})

// What a card carries besides its words, for the byline: pictures, things to play, files, links to
// published pages, a table. Each as { icon (a sketch name), text ("6 pictures") }.
const many = (n, one, more = `${one}s`) => (n === 1 ? `1 ${one}` : `${n} ${more}`)
export function carries(card) {
  const list = card.attachments ?? [], count = kind => list.filter(a => kindOf(a) === kind).length
  const body = String(card.body ?? '').replace(/```[\s\S]*?```/g, '')
  const pages = new Set((body.match(/https?:\/\/[^\s<>)`]+|(?<=`)\/a\/[^\s`]+/g) ?? []).map(u => linkInfo(u.replace(/[.,;:!?]+$/, '')).asset?.id).filter(Boolean)).size
  // A table as markdown or as HTML, or another layout the agent sent along (richhtml.js): named here, shown in the window.
  const table = richMark(card)
  return [
    count('image') && { icon: 'picture', text: many(count('image'), 'picture') },
    count('video') && { icon: 'play', text: many(count('video'), 'video') },
    count('audio') && { icon: 'play', text: many(count('audio'), 'recording') },
    count('file') && { icon: 'page', text: many(count('file'), 'file') },
    pages && { icon: 'page', text: many(pages, 'page') },
    table && { icon: 'grid', text: table === 'layout' ? 'a layout' : 'a table' },
  ].filter(Boolean)
}

// Trust: leave the decision to the agent. Quiet, and it costs a row no space: a small word in the byline
// of a thumb row, the last entry among the options of an unfolded "Choose" row. What the agent advised
// is what it will take; with no advice it chooses itself.
const advisedLabels = card => card.options.filter(o => [].concat(card.recommended ?? []).includes(o.key)).map(o => o.label).join(', ')
const trustTip = card => (advisedLabels(card) ? `${TRUST_WORD}: leave it to the agent. It advised: ${advisedLabels(card)}` : `${TRUST_WORD}: leave it to the agent. It gave no advice and chooses itself`)
async function trustCard(card, onFail) {
  try {
    await trust(card.id)
    say(pageHost(), { head: TRUST_WORD, title: card.title, back: () => reopen(card.id) })
  } catch (err) { onFail(err) }
}

// What "Choose" unfolds under a row: the text, every option as a tile, and a line to ask the
// agent back instead of answering. One tap on an option answers; where several answers are
// allowed the options are toggles and one tile sends them.
function unfoldNode(card, { onDecided, full = true }) {
  const box = el('div', 'inbox-more-in')
  // The text in full, unless the row above already shows all of it: nothing is said twice.
  if (card.body && full) box.append(rich(card.body))
  const error = el('p', 'inbox-error')
  error.hidden = true
  const options = el('div', 'inbox-options')
  const picked = new Set()
  const answer = async (keys, button) => {
    for (const other of options.children) other.disabled = true
    button.classList.add('is-picked')
    try {
      await decide(card.id, card.multiple ? keys : keys[0])
      unfolded.delete(card.id)
      const chosen = card.options.filter(o => keys.includes(o.key))
      if (card.kind === 'decision') onDecided?.(card, { key: keys[0], label: chosen.map(o => o.label).join(', ') })
    } catch (err) {
      for (const other of options.children) other.disabled = false
      button.classList.remove('is-picked')
      paintSend()
      error.textContent = `Not saved: ${why(err)}`
      error.hidden = false
    }
  }
  const send = el('button', 'inbox-option inbox-send')
  send.type = 'button'
  const paintSend = () => {
    send.disabled = !picked.size
    send.replaceChildren(el('strong', null, picked.size ? `Send ${picked.size}` : 'Send'), el('span', null, picked.size ? 'your choice' : 'pick one or more'))
  }
  card.options.forEach((o, i) => {
    const b = el('button', 'inbox-option')
    b.type = 'button'
    b.dataset.key = o.key
    b.append(el('kbd', null, String(i + 1)), el('strong', null, o.label))
    if (o.detail) b.append(el('span', null, o.detail))
    if (advised(card, o.key)) { b.classList.add('is-advised'); b.title = 'The agent recommends this'; b.append(adviceLoop()) }
    if (card.multiple) {
      b.setAttribute('aria-pressed', 'false')
      b.addEventListener('click', () => {
        if (picked.has(o.key)) picked.delete(o.key)
        else picked.add(o.key)
        b.setAttribute('aria-pressed', String(picked.has(o.key)))
        paintSend()
      })
    } else b.addEventListener('click', () => answer([o.key], b))
    options.append(b)
  })
  if (card.multiple) {
    send.addEventListener('click', () => answer(card.options.map(o => o.key).filter(k => picked.has(k)), send))
    paintSend()
    options.append(send)
  }
  if (card.kind === 'decision') {
    // The last entry: no option of the card's, but leaving it to the agent.
    const leave = el('button', 'inbox-option inbox-trust-option')
    leave.type = 'button'
    leave.title = trustTip(card)
    const word = el('strong')
    word.append(sketch(TRUST_SKETCH), TRUST_WORD)
    leave.append(word, el('span', null, advisedLabels(card) ? `the agent takes: ${advisedLabels(card)}` : 'the agent decides'))
    leave.addEventListener('click', () => {
      for (const other of options.children) other.disabled = true
      trustCard(card, err => { for (const other of options.children) other.disabled = false; paintSend(); error.textContent = `Not saved: ${err.message}`; error.hidden = false })
    })
    options.append(leave)
  }
  // Asking back: a message to the session, tied to this card. The card stays open and stays where it is;
  // only "Later" and "Explain" make it leave.
  const ask = el('form', 'inbox-askback')
  const field = el('input')
  field.type = 'text'
  field.placeholder = 'Ask back instead of answering'
  field.setAttribute('aria-label', 'Ask the agent about this question')
  field.autocomplete = 'off'
  const go = el('button', null, 'Ask back')
  go.type = 'submit'
  const said = el('span', 'inbox-asked')
  said.setAttribute('role', 'status')
  ask.append(field, go, said)
  if (card.kind !== 'permission') {
    // Throwing the question away is offered here, once the card is open (on the row itself only while Shift is held).
    const away = el('button', 'inbox-shred-open')
    away.type = 'button'
    away.title = `${SHRED_WORD}: throw this away unanswered. The session is told; it will not ask again`
    away.append(sketch(SHRED_SKETCH), el('span', null, SHRED_WORD))
    away.addEventListener('click', async () => {
      away.disabled = true
      try { await shred(card.id); unfolded.delete(card.id); say(pageHost(), { head: 'Shredded', title: card.title, back: () => reopen(card.id) }) }
      catch (err) { away.disabled = false; error.textContent = `Not shredded: ${err.message}`; error.hidden = false }
    })
    ask.insertBefore(away, said)
  }
  ask.addEventListener('submit', async e => {
    e.preventDefault()
    const text = field.value.trim()
    if (!text) return field.focus()
    go.disabled = true
    try {
      await sendMessage(text, card.agent, card.id)
      field.value = ''
      said.textContent = 'Asked. The reply comes in the conversation.'
    } catch (err) {
      said.textContent = `Not sent: ${why(err)}`
    }
    go.disabled = false
  })
  box.append(options, error, ask)
  return box
}

// Which of the row's ways out show as a tab at its edge (of inbox-later, inbox-revise, inbox-trust, inbox-shred).
const EDGE_TABS = ['inbox-later']

/** One question as a row.
 *  onOpen(cardId): open the card as a window of its own. onDecided(card, option): it was answered here.
 *  off: the card was put off. from: the session that asked, named on the
 *  row when nothing around it says so. fit: the list's lineFit(). */
export function questionRow(card, { onOpen, onDecided, onGallery = null, onUnfold = null, off = false, from = null, fit = null } = {}) {
  const node = el('article', 'inbox-row')
  node.tabIndex = -1   // the keyboard's mark puts the focus here, so Tab goes on from the marked row
  node.dataset.id = card.id
  node.dataset.urgency = card.urgency
  if (off) node.dataset.later = ''
  // What went wrong with an answer: a line of its own on the row's lower edge, outside the text that is cut to whole lines.
  const error = el('p', 'inbox-error inbox-row-error')
  error.setAttribute('role', 'alert')
  error.hidden = true

  // Head: only what stands out gets a tab flush with the corner. A blocking question a red one,
  // an urgent one its own; a normal question none; one that can wait a small scribbled hourglass.
  const head = el('header', 'inbox-row-head')
  let quiet = null   // a small mark that is no tab (can wait, to read): it stands in the byline, so the title is the first thing in the row
  const blocking = card.kind === 'permission' || card.urgency === 'critical'
  if (blocking || card.urgency === 'high') {
    // A knock: the small drawing of knuckles on a door, and the word.
    const tab = el('span', 'inbox-tab')
    tab.append(sketch(KNOCK_SKETCH), knockWord(card))
    head.append(tab)
  } else if (card.kind === 'info') {
    const mark = el('span', 'inbox-whenever inbox-toread')
    mark.title = 'To read: nothing to decide'
    mark.setAttribute('role', 'img')
    mark.setAttribute('aria-label', 'To read')
    mark.append(sketch('page'))
    quiet = mark
  } else if (card.urgency === 'low') {
    const mark = el('span', 'inbox-whenever')
    mark.title = 'Whenever: nothing waits on this'
    mark.setAttribute('role', 'img')
    mark.setAttribute('aria-label', 'Whenever')
    mark.append(sketch('whenever'))
    quiet = mark
  }

  const text = el('button', 'inbox-text')
  text.type = 'button'
  text.title = `${cardNr(card)}: open it as a window`
  // Under the title, one or two lines: what the card says of itself, why it is urgent, then its text.
  // The text is a part of its own: an unfolded row that shows the text in full below drops it here.
  const about = [cardNote(card), card.unsnoozed && !card.snoozed_until ? 'Back from snooze' : '', card.urgency_reason].filter(Boolean).join(' · ')
  const words = plain(card.body)
  const title = el('strong', 'inbox-question', card.title)
  // Who asks: the session's drawing, small, before the title (its crown on it, its name as the tooltip),
  // and the card takes that session's colour (CSS: .inbox-row[data-from]).
  if (from) {
    node.dataset.from = from.id
    node.style.setProperty('--hue', hueFor(from))
    const sender = smallMark(from)
    sender.classList.add('inbox-who')
    sender.title = from.name
    sender.setAttribute('role', 'img')
    sender.setAttribute('aria-label', `From ${from.name}`)
    text.classList.add('has-sender')
    text.append(sender)
  }
  text.append(title)
  // Beside the title: a small clock for the card's age (its hands show it; the words are its tooltip),
  // and the card's number, which shows only under the pointer or the keyboard.
  const when = el('span', 'inbox-when')
  const told = () => { when.title = `${cardNr(card)} · asked ${ago(card.created)}` }
  told()
  when.addEventListener('mouseenter', told)
  const sr = agoNode(card.created, 'inbox-ago')
  when.append(copyButton(card), el('span', 'inbox-nr', cardNr(card)), ageClock(card.created), sr)
  const body = el('span', 'inbox-body')
  if (about) body.append(el('span', 'inbox-body-about', about))
  if (words) body.append(el('span', 'inbox-body-text', about ? ` · ${words}` : words))
  if (about || words) text.append(body)
  // The byline under the text: the card's number (for looking it up) and its age. One quiet line that
  // always stands; under a title of two lines it is the text above it that gives way.
  // The note that belongs to the row: its number (for looking it up) and its age, and two quiet
  // actions that cost no room: "Trust" (leave it to the agent, on a two-way question) and "Shred" (throw
  // it away unanswered). In the inbox this note stands in the gutter at the left of the card, beside the
  // run of rows its session asked (CSS: .inbox-group[data-sender]); in a session's own list and in a
  // narrow column it is a line of the card. Who asks (.inbox-from) is part of it only where no gutter says so.
  const byline = el('p', 'inbox-byline')
  const sep = () => el('span', 'inbox-sep', ' · ')
  if (quiet) byline.append(quiet)
  if (from) {
    const who = el('span', 'inbox-from')
    who.append(smallMark(from), el('span', null, from.name))
    byline.append(who, sep())
  }
  // (The row's actions are the four tabs at its right edge, below.)
  // What the card carries: a small drawing and the count per kind; the whole list as its tooltip.
  // (Beside a picture it stands under the picture; this copy is for where there is no room for that.)
  const extra = carries(card)
  const carried = () => {
    const more = el('span', 'inbox-carries')
    more.title = `This question carries ${extra.map(x => x.text).join(', ')}`
    for (const x of extra) { const one = el('span'); one.append(sketch(x.icon), x.text); more.append(one) }
    return more
  }
  if (extra.length) byline.prepend(carried())
  // A click on the text unfolds the card in place where the page can (the Desk on a wide screen: onUnfold
  // puts the whole card into the host and says whether it did); else it opens as a window. Unfolded,
  // the row shows only the card (CSS: .inbox-row.is-unfolded) and may be wider than the column.
  text.addEventListener('click', async () => {
    if (onUnfold && !node.classList.contains('is-unfolded')) {
      const host = el('div', 'inbox-inline')
      const fold = () => { node.classList.remove('is-unfolded'); host.remove() }
      node.classList.add('is-unfolded')
      node.append(host)
      if (await onUnfold(host, card.id, fold)) return
      fold()
    }
    onOpen?.(card.id)
  })
  const content = el('div', 'inbox-content')
  content.append(head, text, when, byline)
  fit?.observe(title)
  node.append(content)

  // The pictures lie under the text as a small stack, a little fanned: up to three show, the rest are
  // counted by the note beside it. A tap opens them large, without leaving the list.
  const images = (card.attachments ?? []).filter(a => kindOf(a) === 'image')
  if (images.length) {
    const thumb = el('button', 'inbox-thumb')
    thumb.type = 'button'
    thumb.setAttribute('aria-label', images.length === 1 ? `Enlarge ${images[0].name}` : `Look at ${images.length} pictures`)
    for (const a of images.slice(0, 3)) {
      const img = el('img')
      img.src = a.url
      img.alt = ''
      img.loading = 'lazy'
      img.addEventListener('error', () => { img.remove(); if (!thumb.querySelector('img')) thumb.remove() })
      thumb.append(img)
    }
    // On the Desk the pictures open in the big window's own picture view, with the options beside them
    // (onGallery, given by the page, says whether it did); elsewhere, or until then, large over the list.
    thumb.addEventListener('click', async () => { if (!(await onGallery?.(card.id))) openLightbox(images, 0) })
    byline.prepend(thumb)
  }

  // The row's ways out, as small paper tabs down its right edge, in the order of the opened card: Snooze
  // (z z z; "Wake up" on a snoozed row), Revise (say what should change), Whatever (leave it to the
  // agent) and Shred (throw it away unanswered). Each is tucked behind the edge with its drawing
  // showing; under the pointer or the keyboard it slides out with its word, and a click acts. A finger
  // has no hover: its first tap slides the tab out, the second acts. Look and motion: app.css, ".inbox-tabs".
  const tabs = el('div', 'inbox-tabs')
  const tab = (cls, drawing, word, label, act) => {
    const b = el('button', `inbox-tab-act ${cls}`)
    b.type = 'button'
    b.setAttribute('aria-label', label)
    const flap = el('i', 'inbox-later-flap')
    flap.append(sketch(drawing), el('b', null, word))
    b.append(flap)
    let byTouch = false, folding = 0
    b.addEventListener('pointerdown', e => { byTouch = e.pointerType === 'touch' })
    b.addEventListener('click', e => {
      if (byTouch && !b.classList.contains('is-unfolded')) {
        // The first tap of a finger only slides it out; it goes back by itself.
        for (const other of tabs.children) other.classList.remove('is-unfolded')
        b.classList.add('is-unfolded')
        clearTimeout(folding)
        folding = setTimeout(() => b.classList.remove('is-unfolded'), 4000)
        return
      }
      act(b)
    })
    tabs.append(b)
    return b
  }
  const failed = (b, what) => err => { b.disabled = false; error.textContent = `${what}: ${err.message}`; error.hidden = false }
  const later = tab('inbox-later', off ? WAKE_SKETCH : LATER_SKETCH, off ? WAKE_WORD : LATER_WORD,
    off ? `${WAKE_WORD}: fetch this question back` : `${LATER_WORD}: put this question off; it waits for you below`, () => {
      putOff(card.id, !off)
      // Say where it went, with the way back.
      if (!off) say(pageHost(), { head: 'Snoozed', title: card.title, back: async () => putOff(card.id, false) })
    })
  hint(later, 'list.later')
  if (card.kind !== 'permission') {
    // Revise: the card opens with Discuss ready, to say what should change; nothing is sent before that.
    const revise = tab('inbox-revise', 'reverse', HANDBACK_WORD, `${HANDBACK_WORD}: say what should change; the session reworks the question`, () => onOpen?.(card.id, { revise: true }))
    revise.title = `${HANDBACK_WORD}: say what should change`
  }
  if (card.kind === 'decision') {
    const leave = tab('inbox-trust', TRUST_SKETCH, TRUST_WORD, trustTip(card), b => { b.disabled = true; trustCard(card, failed(b, 'Not saved')) })
    leave.title = trustTip(card)
    // While the pointer or the keyboard is on it, the tile the agent would take lights up.
    const light = on => { for (const t of node.querySelectorAll('.inbox-answer.is-advised')) t.classList.toggle('is-hinted', on) }
    for (const [name, on] of [['mouseenter', true], ['focus', true], ['mouseleave', false], ['blur', false]]) leave.addEventListener(name, () => light(on))
    hint(leave, 'list.trust')
  }
  if (card.kind !== 'permission') {
    const away = tab('inbox-shred', SHRED_SKETCH, SHRED_WORD, `${SHRED_WORD}: throw "${card.title}" away unanswered`, async b => {
      b.disabled = true
      try {
        await shred(card.id)
        say(pageHost(), { head: 'Shredded', title: card.title, back: () => reopen(card.id) })
      } catch (err) { failed(b, 'Not shredded')(err) }
    })
    away.title = `${SHRED_WORD}: throw this away unanswered. The session is told; it will not ask again`
    hint(away, 'list.shred')
  }
  // At rest the row shows Snooze alone (the user took the four stacked tabs back: "das geht gar nicht").
  // The others stay built but hidden: the list keys still press them, and the opened card shows all
  // four. To bring one back to the row's edge, name it in EDGE_TABS.
  for (const b of tabs.children) if (!EDGE_TABS.some(cls => b.classList.contains(cls))) b.hidden = true

  const actions = el('div', 'inbox-actions')
  const tile = (cls, kind, label, act) => {
    const b = el('button', `inbox-answer ${cls}`)
    b.type = 'button'
    const disc = el('span', 'inbox-disc')
    disc.append(sketch(kind))
    b.append(disc)
    if (label) b.append(el('span', null, label))
    b.addEventListener('click', act)
    return b
  }
  node.append(tabs, actions, error)
  if (card.kind === 'info') {
    // Something to read, nothing to decide: two tiles of the board's own where the answers stand. Left
    // "What??": the session is asked to explain it, and the card comes back explained. Right
    // "Acknowledge": read, closed. (The text opens it as a card, as on a question.)
    node.dataset.kind = 'info'
    const fail = (what, err) => { for (const b of actions.children) b.disabled = false; error.textContent = `${what}: ${err.message}`; error.hidden = false }
    const busy = () => { for (const b of actions.children) b.disabled = true }
    const what = tile('is-thumb is-what', WHAT_SKETCH, WHAT_WORD, async () => {
      busy()
      try {
        await sendMessage(EXPLAIN_TEXT, card.agent, card.id, undefined, { explain: true })
        putOff(card.id, true, true)
        say(pageHost(), { head: `Asked: ${WHAT_WORD}`, title: 'It comes back with the answer.', back: async () => putOff(card.id, false) })
      } catch (err) { fail('Not asked', err) }
    })
    what.title = `${WHAT_WORD}: ask the session to explain this; it comes back explained`
    hint(what, 'list.no')
    const ack = tile('is-thumb is-lead is-ack', ACK_SKETCH, ACK_WORD, async () => {
      busy()
      try {
        await closeInfo(card.id)
        say(pageHost(), { head: 'Read', title: card.title, back: () => reopen(card.id) })
      } catch (err) { fail('Not closed', err) }
    })
    ack.title = `${ACK_WORD}: read, close it`
    hint(ack, 'list.yes')
    actions.append(what, ack)
  } else if (quick(card)) {
    // Thumbs are the rule: down on the left, up on the right, on every card. The option the agent
    // leads with (its first, or "allow") is the up. The option's own word stands under its thumb
    // only when the pair says more than yes and no.
    const isYes = o => (card.kind === 'permission' ? o.key === 'allow' : o === card.options[0])
    const options = [...card.options].sort((a, b) => isYes(a) - isYes(b))
    const bare = card.options.every(o => BARE.test(o.label.trim()))
    const size = bare ? 'none' : labelSize(card.options)
    for (const o of options) {
      const lead = isYes(o)
      const b = tile(`is-thumb${lead ? ' is-lead' : ''}${size === 'small' ? ' is-small' : ''}`, lead ? 'yes' : 'no', size === 'none' ? '' : o.label, async () => {
        for (const other of actions.children) other.disabled = true
        b.classList.add('is-picked')
        try {
          await decide(card.id, o.key)
          if (card.kind === 'decision') onDecided?.(card, o)
        } catch (err) {
          for (const other of actions.children) other.disabled = false
          b.classList.remove('is-picked')
          error.textContent = `Not saved: ${why(err)}`
          error.hidden = false
        }
      })
      b.setAttribute('aria-label', o.label)
      hint(b, lead ? 'list.yes' : 'list.no')
      if (o.detail || (size === 'none' && !bare)) b.title = [size === 'none' && !bare ? o.label : '', o.detail].filter(Boolean).join(': ')
      if (advised(card, o.key)) { b.classList.add('is-advised'); b.title = 'The agent recommends this'; b.append(adviceLoop()) }
      actions.append(b)
    }
  } else {
    // More than two ways: one tile, "Choose", in the place of the right-hand thumb (its class is still
    // called is-wide). The row unfolds downward with its options, and folds again on a second tap or
    // Escape. Only a card with too much for that opens as a window.
    const inline = !needsWindow(card)
    const more = el('div', 'inbox-more')
    const clip = el('div', 'inbox-more-clip')
    more.append(clip)
    const count = card.multiple ? `${card.options.length} options, several` : `${card.options.length} options`
    const choose = tile('is-wide is-lead', 'choose', 'Choose', () => (inline ? unfold(!node.classList.contains('is-open')) : onOpen?.(card.id)))
    // Only the word stands on the tile; how many options there are is said in its tooltip and to a screen reader.
    choose.title = count
    choose.setAttribute('aria-label', `Choose: ${count}`)
    hint(choose, 'list.open')
    // Is the text more than the row shows: it is cut there, or it has a shape (a list, code, a link, lines).
    const cut = () => body.scrollHeight > body.clientHeight + 2 || /\n|```|`|\*\*|https?:\/\//.test(card.body ?? '')
    const unfold = open => {
      if (open && !clip.firstChild) {   // built on first use
        const full = Boolean(card.body) && (!body.isConnected || !body.clientHeight || cut())
        clip.append(unfoldNode(card, { onDecided, full }))
        node.toggleAttribute('data-fulltext', full)
      }
      node.classList.toggle('is-open', open)
      choose.setAttribute('aria-expanded', String(open))
      clip.inert = !open
      if (open) unfolded.add(card.id)
      else unfolded.delete(card.id)
    }
    actions.append(choose)
    if (inline) {
      node.append(more)
      unfold(unfolded.has(card.id))
      node.addEventListener('keydown', e => {
        if (e.key !== 'Escape' || !node.classList.contains('is-open')) return
        e.stopPropagation()
        unfold(false)
        choose.focus()
      })
    }
  }
  return node
}

const rowSig = (card, opts) => JSON.stringify([card.revised, card.urgency, card.urgency_reason, card.title, card.body, card.options, card.recommended, card.multiple, card.attachments?.length, opts.off, opts.from && [opts.from.name, opts.from.mark, opts.from.starred]])

/** A list of question rows in root.
 *  onOpen(cardId | null): open that card as a window, or with null walk through all of them there.
 *  onDecided(card, option): a question was answered in the list; the page offers to take it back.
 *  (Nothing is added to the list for that: the next row has to land where the answered one was.)
 *  With agent (a session id) it lists only that session's questions, without the big heading.
 *  Returns { render(state) }. */
export function mountInbox(root, { onOpen, onDecided, onGallery = null, onUnfold = null, agent = null }) {
  let signature = ''
  let lastState = null
  const head = el('header', 'inbox-head')
  const list = el('div', 'inbox-groups')
  root.append(head, list)
  const fit = lineFit()
  const rows = new Map()   // card id -> { sig, node }; an unchanged card keeps its node, so nothing flickers
  const cards = new Map()  // card id -> the card, for what the keys do with the marked row
  const row = (card, opts = {}) => {
    const sig = rowSig(card, opts)
    const cached = rows.get(card.id)
    if (cached?.sig === sig) return cached.node
    if (cached?.node.classList.contains('is-unfolded')) return cached.node   // it holds the card, unfolded: not rebuilt under it
    if (cached) fit.unobserve(cached.node.querySelector('.inbox-question'))
    const node = questionRow(card, { onOpen, onDecided, onGallery, onUnfold, fit, ...opts })
    cards.set(card.id, card)
    rows.set(card.id, { sig, node })
    return node
  }

  // ---- an answered question, as a slim row ----
  let fetching = null   // the id of a card that "Take back" is returning: its row is marked when it is here
  function doneRow(card, sender) {
    const node = el('article', 'inbox-done')
    node.tabIndex = -1
    node.dataset.id = card.id
    const picked = card.choices?.length ? card.choices : [card.choice]
    const labels = card.status === 'shredded' ? 'Shredded' : card.kind === 'info' ? 'Read' : card.trusted ? `${TRUST_WORD}${advisedLabels(card) ? `: ${advisedLabels(card)}` : ''}` : card.options.filter(o => picked.includes(o.key)).map(o => o.label).join(', ') || String(card.choice)
    // A yes or no shows its thumb; anything else the drawing of a choice.
    const duo = card.options.length === 2 && !card.multiple
    const mark = el('span', 'inbox-done-mark')
    mark.append(sketch(card.status === 'shredded' ? SHRED_SKETCH : card.kind === 'info' ? 'page' : !duo ? 'choose' : card.choice === card.options[0].key ? 'yes' : 'no'))
    const text = el('div', 'inbox-done-text')
    const sub = el('p', 'inbox-done-sub')
    sub.append(el('b', null, labels))
    if (sender) { const who = el('span', 'inbox-done-who'); who.append(doodle(sender.mark ?? sender.id), sender.name); sub.append(who) }
    if (card.decided) sub.append(agoNode(card.decided, 'inbox-done-ago'))
    if (card.status === 'done') sub.append(el('span', 'inbox-done-closed', 'done by the agent'))
    sub.append(copyButton(card))
    text.append(el('strong', null, card.title), sub)
    const take = el('button', 'inbox-takeback', 'Take back')
    take.type = 'button'
    take.setAttribute('aria-label', `Take back "${labels}" on: ${card.title}`)
    hint(take, 'list.takeback')
    take.addEventListener('click', async () => {
      take.disabled = true
      fetching = card.id
      try { await reopen(card.id) } catch (err) { fetching = null; take.disabled = false; error(`Not taken back: ${why(err)}`) }
    })
    node.append(mark, text, take)
    return node
  }

  // ---- a row that left, and one that comes back ----
  // What happened to a question that left is said by the note at the top left (back.js), which also
  // takes it back. The list does its part: the row that left goes with a motion that shows where to,
  // and a row that "Back" returned is brought into view, and marked if the keyboard is in use.
  const away = new Map()   // card id -> when its row left the open rows
  // Something went wrong with no row to say it on: one line under the page's title.
  function error(text) {
    const line = el('p', 'inbox-error', text)
    line.setAttribute('role', 'alert')
    head.append(line)
    setTimeout(() => line.remove(), 5000)
  }

  // ---- the row the keyboard is on ----
  let current = null   // { id, index, off }
  const nodes = () => [...list.querySelectorAll('.inbox-row:not(.is-leaving), .inbox-done')].filter(n => !n.closest('.inbox-pile:not(.is-open)'))   // a folded pile's rows are out of reach
  // A pile was pushed together: the mark does not stay on a row that is no longer in reach.
  const folded = open => { if (!open && current && !nodes().some(n => n.dataset.id === current.id)) mark(null) }
  // Bring a row wholly into view: with its sender's heading if it is the first of its group, with the
  // tag that hangs below its edge, and with the page's own title if it is the very first row.
  // What scrolls the list: the page of the inbox, or the pane of a session's questions.
  const scroller = from => {
    let box = from.parentElement
    while (box && box !== document.body && !/auto|scroll/.test(getComputedStyle(box).overflowY)) box = box.parentElement
    return box && box !== document.body ? box : null
  }
  // "If I do not move the pointer, I can always click": the row that follows one that left lands exactly
  // where that one stood, also across the heading of the next sender (which is taller than the gap
  // between two rows). Where the layout alone does not bring it there, the list is scrolled by what is
  // missing; at the end of the list, room for that is added below and taken away again once it is out of sight.
  let slack = 0
  function landOn(row, top) {
    const box = scroller(list)
    if (!box) return
    const by = Math.round(row.getBoundingClientRect().top - top)
    if (!by) return
    const short = by - (box.scrollHeight - box.clientHeight - box.scrollTop)
    if (short > 0) { slack += Math.ceil(short); list.style.paddingBottom = `${slack}px` }
    box.scrollTop += by
    if (slack && !box.dataset.slack) {
      box.dataset.slack = ''
      box.addEventListener('scroll', function release() {
        if (!slack) return
        // Out of sight again: the added room goes, and nothing moves.
        if (box.scrollTop + box.clientHeight <= box.scrollHeight - slack) { slack = 0; list.style.paddingBottom = '' }
      }, { passive: true })
    }
  }
  function reveal(node, smooth = true) {
    const box = scroller(node)
    if (!box) return node.scrollIntoView({ block: 'nearest' })
    const frame = box.getBoundingClientRect()
    // A step glides; a jump (Home, End, a held key) is there at once. Always to a place, never by an
    // amount: a step taken while the last one still glides would otherwise add up.
    const go = to => box.scrollTo({ top: to, behavior: smooth && Math.abs(to - box.scrollTop) < frame.height && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant' })
    if (node === nodes()[0] && box.contains(head)) return go(0)
    const lead = node.previousElementSibling?.matches('.inbox-sender, .inbox-run-tab') ? node.previousElementSibling : node
    const top = lead.getBoundingClientRect().top - 16 - frame.top
    const bottom = node.getBoundingClientRect().bottom + 24 - frame.bottom
    // Too far up: down to it. Too far down: up, but never so far that its top leaves.
    const by = top < 0 ? top : bottom > 0 ? Math.min(bottom, top) : 0
    if (by) go(box.scrollTop + by)
  }
  function mark(node, scroll = true, smooth = true) {
    for (const n of list.querySelectorAll('.is-current')) if (n !== node) { n.classList.remove('is-current'); n.removeAttribute('aria-current') }
    if (!node) { current = null; return }
    node.classList.add('is-current')
    node.setAttribute('aria-current', 'true')
    current = { id: node.dataset.id, index: nodes().indexOf(node), kind: kindOfRow(node) }
    // The keyboard's own place follows the mark, unless it is busy elsewhere (a field, the sidebar).
    const at = document.activeElement
    if (!at || at === document.body || (list.contains(at) && !node.contains(at))) node.focus({ preventScroll: true })
    if (scroll) reveal(node, smooth)
  }

  function render(state) {
    const all = state.all
    const agents = agent ? all.agents.filter(a => a.id === agent) : all.agents
    const byId = new Map(all.cards.map(c => [c.id, c]))
    const open = all.queue.map(id => byId.get(id)).filter(c => c && (!agent || c.agent === agent))
    const off = state.later.map(id => open.find(c => c.id === id)).filter(Boolean)
    const fresh = open.filter(c => !off.includes(c))
    // What was answered: the latest first. A card the agent has closed since is still listed; the server lets it be reopened.
    // (In a session's own list: that session's answers. One code path for the inbox and for a session.)
    const answered = all.cards.filter(c => (!agent || c.agent === agent) && c.status !== 'open' && ((c.kind === 'decision' && (c.choice != null || c.trusted)) || (c.kind === 'info' && c.read)))
      .sort((a, b) => (b.decided ?? 0) - (a.decided ?? 0)).slice(0, ANSWERED_MAX)
    const next = JSON.stringify([answeredOpen, answered.map(c => [c.id, c.status, c.choice, c.choices, c.decided, c.title]), all.cards.filter(c => c.status === 'shredded').map(c => c.id), off.map(c => c.id), state.handed, open.map(c => [c.id, c.unsnoozed, c.revised, c.urgency, c.urgency_reason, c.title, c.body, c.options, c.recommended, c.multiple, c.attachments?.length]), agents.map(a => [a.id, a.name, a.mark, a.starred])])
    if (next === signature) return
    signature = next

    // The number counts what is still to be worked down; what was put off is counted at its own group.
    const title = el('div', 'inbox-title')
    const line = el('p')
    // Questions need an answer; info cards are only to be read. The line tells them apart:
    // "4 questions need you · 2 to read".
    const toRead = fresh.filter(c => c.kind === 'info').length, asking = fresh.length - toRead
    let walkTools = null   // the button into the walk, put into the head below
    const circled = el('span', 'inbox-circled')
    const count = n => circled.replaceChildren(String(n), penCircle())
    count(asking)
    // On the desk it reads "12 on your desk"; in a session's own list "12 questions need you."
    const needs = !agent ? ' on your desk.' : asking === 1 ? ' question needs you.' : ' questions need you.'
    const reading = el('span', 'inbox-toread-count')
    if (toRead) reading.append(sketch('page'), `${toRead} to read`)
    // The knocks among them (urgent and blocking) are counted first: "3 knocks · 9 questions need you."
    const knocking = fresh.filter(isKnock).length
    const knocks = el('span', 'inbox-knocks')
    if (knocking) knocks.append(sketch(KNOCK_SKETCH), knocksText(knocking))
    let heading = null   // the desk's own heading; a session's list keeps its sentence
    if (fresh.length && !agent) {
      // The desk's heading is the way into the walk, and nothing else: "Next, please" with the number of
      // what waits in a circle drawn by hand (every open card, one after the other, in the big window;
      // also when there is only one). Knocks, if any, stand beside it as their small mark and number.
      const walk = el('button', 'inbox-walk inbox-go')
      walk.type = 'button'
      walk.title = `${WALK_WORD}: every open question, one after the other (G F)`
      walk.setAttribute('aria-label', `${WALK_WORD}: ${fresh.length === 1 ? '1 open question' : `${fresh.length} open questions`}`)
      walk.setAttribute('aria-keyshortcuts', 'G F')
      count(fresh.length)
      walk.append(el('span', null, WALK_WORD), circled, sketch('go'))
      walk.addEventListener('click', () => { walk.blur(); onOpen?.(null) })
      heading = el('h2', 'inbox-heading')
      heading.append(walk)
      // (The knocks are counted by the floating Desk above; the heading does not say them a second time.)
    } else if (fresh.length) line.append(...(knocking ? [knocks, ' · '] : []), ...(asking || !toRead ? [circled, needs] : []), ...(toRead ? [asking ? ' · ' : '', reading] : []))
    else line.append(off.length ? 'Nothing new. What you snoozed is below.' : agent ? 'Nothing needs you.' : `${INBOX_WORD} is clear.`)
    // A session's pane already carries its name as the title; the inbox has its own.
    if (agent) title.append(line)
    else if (heading) title.append(heading)
    else title.append(el('h2', null, `${INBOX_WORD} is clear.`), ...(off.length ? [el('p', null, 'What you snoozed is below.')] : []))
    lastState = state
    head.replaceChildren(...(agent && !open.length ? [] : [title]), ...(walkTools ? [walkTools] : []))
    // (The sheet of keys opens from the "?" in the bar, index.html #keys-open, and by the key "?".)

    // One group per sender. Starred sessions come first, then whoever has the most urgent question.
    const top = cards => Math.max(...cards.map(c => RANK[c.urgency] ?? 1))
    const groups = agents
      .map(a => ({ agent: a, cards: fresh.filter(c => c.agent === a.id) }))
      .filter(g => g.cards.length)
      .sort((a, b) => Boolean(b.agent.starred) - Boolean(a.agent.starred) || top(b.cards) - top(a.cards))

    // Remember where every row was, so that after an answer the rest slides up instead of jumping.
    const before = new Map(nodes().map(n => [n.dataset.id, n.getBoundingClientRect().top]))
    const old = nodes().filter(n => kindOfRow(n) !== 'done').map(n => ({ node: n, id: n.dataset.id, off: 'later' in n.dataset, box: n.getBoundingClientRect() }))
    // Rebuilding moves every row out of the list and back. A row or a control that holds the keyboard
    // would lose it on the way, and Chromium then lays the emptied list out and scrolls it to its top:
    // let go before the first row moves, and take the keyboard up again below.
    const held = list.contains(document.activeElement) ? document.activeElement : null
    held?.blur()
    const parts = []
    // One list, row under row at one pitch: no heading, no rule and no count between the senders. A
    // sender's rows still stand together (the section holds them and names the sender for a screen
    // reader), and every row says who asks, in its byline: the session's mark and name.
    for (const { agent: sender, cards } of groups) {
      const section = el('section', 'inbox-group')
      if (!agent) {
        section.dataset.sender = sender.id
        section.dataset.run = cards.length > 1 ? 'many' : 'single'
        section.setAttribute('aria-label', `${sender.name}: ${cards.length === 1 ? '1 question' : `${cards.length} questions`}`)
        if (sender.starred) section.dataset.vip = ''
        // A divider tab on the first card of the run: the session's drawing, its crown, its name, in the
        // session's colour. The run's cards stand close behind it and do not repeat the drawing. It belongs
        // to the run, not to a card: when the first card is answered, the tab stands on the next.
        section.style.setProperty('--hue', hueFor(sender))
        const tab = el('div', 'inbox-run-tab')
        tab.setAttribute('aria-hidden', 'true')   // the section's label says it
        tab.append(smallMark(sender), el('b', null, sender.name))
        section.append(tab)
      }
      section.append(...cards.map(c => row(c, { from: agent ? null : sender })))
      parts.push(section)
    }
    // Put off: below all senders and behind a dividing line, a pile in the order the cards were put off,
    // pushed together until it is unfolded (pile(), above). The line is dashed, because where these cards
    // stand is provisional. Each row says who asked, since it no longer stands under its sender.
    // A card that was handed back to its session ("Explain") waits for the agent, not for the human: those
    // are a pile of their own, "With the agent"; each comes back by itself when the session has answered.
    const asked = new Set(state.handed ?? [])
    const offPile = (kind, label, icon, cards, count) => {
      if (!cards.length) return
      const key = `${agent ?? ''}:${kind}`
      // Only one pile stands open; a state from before that rule is put right here.
      const open = pilesOpen.has(key) && !parts.some(p => p.matches?.('.inbox-pile.is-open'))
      parts.push(pile({
        kind, label, icon, count, open, headClass: `inbox-${kind}-toggle`,
        onToggle: to => { pilesOpen[to ? 'add' : 'delete'](key); folded(to) },
        items: cards.map(c => {
          const sender = agent ? null : all.agents.find(a => a.id === c.agent)
          return { title: c.title, lead: sender ? smallMark(sender) : null, tail: sender ? `${sender.name} · ${cardNr(c)}` : cardNr(c), node: row(c, { off: true, from: sender ?? null }) }
        }),
      }))
    }
    const waiting = off.filter(c => asked.has(c.id)), put = off.filter(c => !asked.has(c.id))
    offPile('later', 'Snoozed', LATER_SKETCH, put, String(put.length))
    offPile('asked', 'Waiting', 'explain', waiting, String(waiting.length))   // with the agent: it comes back by itself
    // Answered: one more group below everything, folded to a line. Unfolded, every answer is a slim row
    // with the way to take it back, for the wrong answer that is noticed only later.
    if (answered.length) {
      // The same pile as "Later" (pile(), above): a line with the count, the answers pushed together
      // below it, each sheet naming the question and what was said; the rows are built when it unfolds.
      const today = answered.filter(c => sameDay(c.decided ?? 0, Date.now())).length
      const answerOf = c => { if (c.kind === 'info') return 'Read'; if (c.trusted) return `${TRUST_WORD}${advisedLabels(c) ? `: ${advisedLabels(c)}` : ''}`; const picked = c.choices?.length ? c.choices : [c.choice]; return c.options.filter(o => picked.includes(o.key)).map(o => o.label).join(', ') || String(c.choice) }
      parts.push(pile({
        kind: 'answered', label: 'Answered', icon: 'yes', headClass: 'inbox-answered-toggle', open: answeredOpen && !parts.some(p => p.matches?.('.inbox-pile.is-open')),
        count: today === answered.length ? `${today} today` : today ? `${today} today · ${answered.length} in all` : `${answered.length}`,
        onToggle: open => { answeredOpen = open; folded(open) },
        items: answered.map(c => ({ title: c.title, tail: answerOf(c), node: () => doneRow(c, all.agents.find(a => a.id === c.agent)) })),
      }))
    }
    // Shredded today: a fourth quiet pile, only when there is something in it; "Take back" in its list.
    const shredded = all.cards.filter(c => (!agent || c.agent === agent) && c.status === 'shredded' && sameDay(c.shredded ?? 0, Date.now())).sort((a, b) => (b.shredded ?? 0) - (a.shredded ?? 0))
    if (shredded.length) {
      const key = `${agent ?? ''}:shredded`
      parts.push(pile({
        kind: 'shredded', label: 'Shredded', icon: SHRED_SKETCH, count: `${shredded.length} today`, headClass: 'inbox-shredded-toggle',
        open: pilesOpen.has(key) && !parts.some(p => p.matches?.('.inbox-pile.is-open')),
        onToggle: to => { pilesOpen[to ? 'add' : 'delete'](key); folded(to) },
        items: shredded.map(c => ({ title: c.title, tail: 'Shredded', node: () => doneRow(c, all.agents.find(a => a.id === c.agent)) })),
      }))
    }
    if (!open.length) {
      // Nothing open: the desk, drawn, and one sentence under it. No box.
      const empty = el('div', 'inbox-empty')
      empty.append(sketch(agent ? 'tick' : INBOX_SKETCH), el('p', null, agent ? 'This session has no question for you right now.' : 'As soon as an agent has a question, it shows up here.'))
      parts.push(empty)
    }
    list.replaceChildren(...parts)
    for (const [id, { node }] of rows) {
      if (node.isConnected) continue
      fit.unobserve(node.querySelector('.inbox-question'))
      rows.delete(id)
      cards.delete(id)
    }

    // Rows that left the open ones, and one that "Back" has just returned.
    const now = Date.now()
    const openNow = new Set(fresh.map(c => c.id))
    let returned = null
    for (const { id, off: wasOff } of old) if (!wasOff && !openNow.has(id)) away.set(id, now)
    for (const [id, at] of away) {
      if (openNow.has(id)) { if (now - backUsedAt() < 4000) returned = nodes().find(n => n.dataset.id === id && kindOfRow(n) === 'open') ?? null; away.delete(id) }
      else if (now - at > 60000) away.delete(id)
    }
    // A card that "Take back" returned from the answered ones.
    const fetched = Boolean(fetching && openNow.has(fetching))
    if (fetched) { returned = nodes().find(n => n.dataset.id === fetching && kindOfRow(n) === 'open') ?? returned; fetching = null }
    // The row that left stays a moment as a ghost in its old place and goes: an answered one off to
    // the side, one that was put off down towards "Later". Nothing can be pressed on it, and it is no row any more.
    const leavers = signature && shown() ? old.filter(o => !o.node.isConnected && !o.off && !openNow.has(o.id)) : []
    // One open row left: the row that followed it takes its place, to the pixel (landOn, above).
    if (leavers.length === 1) {
      const was = old.filter(o => !o.off), at = was.indexOf(leavers[0])
      const next = was.slice(at + 1).find(o => o.node.isConnected && openNow.has(o.id))
      if (next) landOn(next.node, leavers[0].box.top)
    }
    const frame = leavers.length ? list.getBoundingClientRect() : null
    for (const { node, id, box } of leavers) {
      node.classList.remove('is-current', 'is-open')
      node.classList.add('is-leaving')
      node.dataset.leave = off.some(c => c.id === id) ? 'later' : byId.get(id)?.status === 'shredded' ? 'shredded' : 'answered'
      node.removeAttribute('data-id')
      node.inert = true
      Object.assign(node.style, { left: `${box.left - frame.left}px`, top: `${box.top - frame.top}px`, width: `${box.width}px`, height: `${box.height}px` })
      list.append(node)
      setTimeout(() => node.remove(), 340)
    }
    // The marked row was answered or put off: the mark stays in its place, on the row that moved up.
    if (current) {
      const now = nodes()
      const same = now.find(n => n.dataset.id === current.id && kindOfRow(n) === current.kind)
      if (same && kindOfRow(same) === current.kind) mark(same, false)
      // The mark changed rows: where the list got shorter, the row it is on now may be out of sight.
      else { mark(now[Math.min(current.index, now.length - 1)] ?? null, false); if (current && shown()) reveal(now[current.index], false) }
    }
    // A field or button that was in use keeps the keyboard; a row gives it to the row that is marked now.
    if (held?.isConnected && !held.matches('.inbox-row') && !held.closest('[inert]')) held.focus({ preventScroll: true })
    if (returned && shown()) {
      if (current || fetched) mark(returned, true, false)
      else { reveal(returned, false); returned.animate([{ outline: '3px solid var(--fg)', outlineOffset: '3px' }, { outline: '3px solid transparent', outlineOffset: '3px' }], { duration: 1400 }) }
    }
    if (before.size && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (const node of nodes()) {
        const was = before.get(node.dataset.id)
        const moved = was == null ? 0 : was - node.getBoundingClientRect().top
        // Where a row is on its way out, the others wait a moment before they move up into its place.
        if (moved) node.animate([{ translate: `0 ${moved}px` }, { translate: '0 0' }], { duration: 320, delay: leavers.length ? 140 : 0, fill: 'backwards', easing: 'cubic-bezier(.25, 1.4, .5, 1)' })
      }
    }
  }

  // ---- keys: work down the list without the mouse ----
  // J/K or the arrows pick a row; from then on the letters act on it. Which keys, and that they
  // rest in a field or under a dialog, is the business of keys.js; here is what they do.
  // Of sessions side by side, the list of the one that is picked listens.
  const shown = () => !root.closest('.chat-pane:not(.is-member)') && (list.checkVisibility ? list.checkVisibility({ visibilityProperty: true }) : list.offsetParent !== null)
  const here = () => (current && nodes().find(n => n.dataset.id === current.id)) || null
  // With no row marked yet, start at the first one that is in sight.
  const firstInSight = all => all.find(n => n.getBoundingClientRect().top >= (root.closest('main, .pane-list')?.getBoundingClientRect().top ?? 0)) ?? all[0]
  // Below the rows lie the piles (Later, With the agent, Answered), pushed together. The keyboard goes on
  // from the last row to their lines, one after the other; Enter on a line unfolds the pile, and its rows
  // are then rows like the others.
  const pileHeads = () => [...list.querySelectorAll('.inbox-pile:not(.is-open) .inbox-pile-head')]
  const toHead = head => { mark(null); head.focus({ preventScroll: true }); head.scrollIntoView({ block: 'nearest' }) }
  const move = (to, edge = false) => (_, e) => {
    const all = nodes(), heads = pileHeads()
    const dir = edge ? 0 : to(0)
    const at = all.indexOf(here())
    const head = document.activeElement?.closest?.('.inbox-pile-head')
    if (head && dir && at < 0) {
      // On the line of a pile: into it if it is unfolded, else on to the next line, or back up to the rows.
      const inside = dir > 0 ? all.find(n => head.closest('.inbox-pile.is-open')?.contains(n)) : null
      if (inside) return void mark(inside, true, !e?.repeat)
      const next = heads[heads.indexOf(head) + dir]
      if (next) return void toHead(next)
      if (dir < 0 && all.length) mark(all.at(-1), true, !e?.repeat)
      return
    }
    if (!all.length) return heads.length && dir >= 0 ? void toHead(heads[0]) : false
    if (at === all.length - 1 && dir > 0 && heads.length) { if (!e?.repeat) toHead(heads[0]); return }
    mark(at < 0 && !edge ? firstInSight(all) : all[Math.max(0, Math.min(all.length - 1, to(at, all.length)))], true, !e?.repeat)
  }
  // A letter acts on the marked row. With none marked it marks one and does nothing else:
  // nothing is answered that was not pointed at first.
  const onRow = act => (arg, e) => {
    const all = nodes()
    if (!all.length) return false
    const node = here()
    if (!node) { mark(firstInSight(all)); return true }
    return act(node, arg, e)
  }
  const marked = act => (arg, e) => { const node = here(); return node ? act(node, arg, e) : false }
  const press = button => { if (!button || button.disabled) return false; button.click(); return true }
  const isOpen = node => node.classList.contains('is-open')
  const optionsOf = node => [...node.querySelectorAll('.inbox-option:not(:disabled)')]
  // Is the keyboard free for this row: nowhere in particular, or inside the row itself.
  const mine = node => { const at = document.activeElement; return !at || at === document.body || node.contains(at) }
  const toOption = node => { const all = optionsOf(node); (all.find(b => b.classList.contains('is-advised')) ?? all[0])?.focus({ preventScroll: true }) }
  const stepOption = by => marked(node => {
    const all = optionsOf(node)
    if (!isOpen(node) || !all.length || !mine(node)) return false
    const at = all.indexOf(document.activeElement)
    all[at < 0 ? (by > 0 ? 0 : all.length - 1) : (at + by + all.length) % all.length].focus()
  })
  provide('list', {
    active: shown,
    actions: {
      'list.next': move(at => at + 1),
      'list.prev': move(at => at - 1),
      'list.first': move(() => 0, true),
      'list.last': move((_, n) => n - 1, true),
      'list.option.next': stepOption(1),
      'list.option.prev': stepOption(-1),
      'list.yes': onRow(node => press(node.querySelectorAll('.inbox-answer.is-thumb')[1])),
      'list.no': onRow(node => press(node.querySelectorAll('.inbox-answer.is-thumb')[0])),
      'list.later': onRow(node => press(node.querySelector('.inbox-later'))),
      'list.shred': onRow(node => press(node.querySelector('.inbox-shred'))),
      'list.trust': onRow(node => press(node.querySelector('.inbox-trust'))),
      // Several answers allowed: Enter sends what is picked, and never toggles the option in focus.
      'list.send': marked(node => {
        const send = node.querySelector('.inbox-send')
        if (!send || !isOpen(node) || !mine(node)) return false
        if (!send.disabled) send.click()
      }),
      // The choices in the row, or the whole question as a window where there is too much for a row.
      'list.open': onRow(node => {
        if (kindOfRow(node) === 'done') return true   // nothing to open; its key is "take back"
        if (node.dataset.kind === 'info') return press(node.querySelector('.inbox-answer.is-ack'))   // on an info: Acknowledge
        const choose = node.querySelector('.inbox-answer.is-wide')
        if (!choose) { onOpen?.(node.dataset.id); return true }
        if (!press(choose)) return false
        // Unfolded, the row is taller: once it has grown, bring all of it into view.
        if (isOpen(node)) { toOption(node); setTimeout(() => { if (node.isConnected && isOpen(node)) reveal(node) }, 280) }
        else if (node.isConnected) node.focus({ preventScroll: true })
      }),
      'list.pick': marked((node, n) => (isOpen(node) ? press(node.querySelectorAll('.inbox-option[data-key]')[n - 1]) : false)),
      // Ask back: the line under the choices; a row without choices opens as a window, with that line ready.
      'list.ask': onRow(node => {
        if (kindOfRow(node) === 'done') return true
        const choose = node.querySelector('.inbox-answer.is-wide')
        if (!node.querySelector('.inbox-more')) { onOpen?.(node.dataset.id, { ask: true }); return true }
        if (!isOpen(node)) choose.click()
        node.querySelector('.inbox-askback input')?.focus({ preventScroll: true })
        reveal(node)
      }),
      // Explain: first everything the card holds (the unfolded row, or its window), then the question to the session.
      'list.explain': onRow(node => {
        const card = cards.get(node.dataset.id)
        if (!card || card.kind === 'permission') return false
        if (card.kind === 'info') return press(node.querySelector('.inbox-answer.is-what'))   // on an info: What??
        if (!node.querySelector('.inbox-more')) { onOpen?.(card.id); return true }
        if (!isOpen(node)) { node.querySelector('.inbox-answer.is-wide').click(); toOption(node); return true }
        sendMessage(EXPLAIN_TEXT, card.agent, card.id).then(() => {
          putOff(card.id, true, true)
          say(pageHost(), { head: 'Asked to explain', title: 'It comes back with the answer.', back: async () => putOff(card.id, false) })
        }, err => error(`Not asked: ${why(err)}`))
      }),
      // Revise: the card opens with Discuss ready, to say what should change (what the Revise tab did).
      'list.revise': marked(node => {
        const card = cards.get(node.dataset.id)
        if (!card || card.kind === 'permission' || kindOfRow(node) === 'done') return false
        onOpen?.(card.id, { revise: true })
        return true
      }),
      // On an answered row: its answer is taken back, and the question stands in its group again.
      'list.takeback': marked(node => (kindOfRow(node) === 'done' ? press(node.querySelector('.inbox-takeback')) : false)),
      'list.leave': marked(node => {
        if (isOpen(node)) { node.querySelector('.inbox-answer.is-wide')?.click(); node.focus({ preventScroll: true }); return true }
        mark(null)
        if (node === document.activeElement) node.blur()
      }),
    },
  })
  // A row that is touched takes the mark along, once the keyboard has set one.
  list.addEventListener('pointerdown', e => {
    const node = e.target.closest('.inbox-row, .inbox-done')
    if (current && node) mark(node, false)
  })

  /** Bring an answered card into view: its pile is opened and its row shown. Returns whether it is there. */
  function revealCard(cardId) {
    if (!lastState) return false
    answeredOpen = true
    signature = ''
    render(lastState)
    const row = list.querySelector(`.inbox-done[data-id="${CSS.escape(cardId)}"]`)
    if (!row) return false
    row.scrollIntoView({ block: 'center', behavior: 'smooth' })
    row.animate([{ outline: '3px solid var(--accent)' }, { outline: '3px solid transparent' }], { duration: 1400 })
    return true
  }
  return { render, reveal: revealCard }
}
