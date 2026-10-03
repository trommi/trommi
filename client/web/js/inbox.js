// Question rows, and the lists made of them: the inbox (every open question of every
// session, grouped by who is asking) and one session's own questions.
// Every row is the same height with its answer at the right edge, always in the same place:
// thumb down and thumb up for a two-way question, otherwise one wide "Choose", which unfolds
// the options below the row. Beside them a small arrow puts the question off: it leaves its
// sender's group for one group at the very end, so that working down the list comes to an end.
// The list can be worked down with the keyboard alone; answer one, the next stands in its place.

import { el, rich, agoNode, doodle, sketch, crown, kindOf, tidyLinks, linkInfo, adviceLoop, cardNote, ageClock, ago, LATER_WORD, LATER_SKETCH, WAKE_WORD, WAKE_SKETCH, ACK_WORD, ACK_SKETCH, WHAT_WORD, WHAT_SKETCH, TRUST_WORD, TRUST_SKETCH, HANDBACK_WORD, WALK_WORD, SHRED_WORD, SHRED_SKETCH, runBracket, KNOCK_SKETCH, isKnock, knockWord, knocksText, INBOX_WORD } from './ui.js'
import { hueFor, workingRing, crowned } from './agents.js'
import { loopPath, penSeed, INBOX_SKETCH, HANDBACK_STATE } from './ui.js'
import { richMark } from './richhtml.js'
import { decide, putOff, sendMessage, reopen, closeInfo, trust, shred, takeBack, isLoaded } from './store.js'
import { openLightbox } from './chat.js'
import { provide, hint } from './keys.js'
import { say, pageHost, backUsedAt } from './back.js'
import { copyButton, copyCard } from './cardclip.js'
import { stacks } from './piles.js'
import { link, cardPath, sessionPath, walkPath } from './link.js'

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

// Two long answers (card Nr. 157): labels that fit no tile are not left as two bare thumbs. Each tile then
// shows the option's `short`, two or three words the agent supplies (at most 18 characters), with the thumb
// small beside it; if either option has none, the row shows one "Choose" instead.
const SHORT_MAX = 18
const shortOf = o => { const s = String(o.short ?? '').trim(); return s.length <= SHORT_MAX ? s : '' }
// The pair of short words at the largest size that holds both whole: one line, one line a step smaller,
// two lines, two lines smaller, then the thumb above the word. Never cut, never broken inside a word.
const SHORT_STEPS = [[], ['is-tight'], ['is-two'], ['is-two', 'is-tight'], ['is-two', 'is-tight', 'is-stacked'], ['is-two', 'is-tiny', 'is-stacked']]
function fitShorts(actions) {
  const tiles = [...actions.querySelectorAll('.inbox-answer.is-short')]
  const whole = b => {
    const word = b.querySelector('.inbox-short')
    return word.scrollWidth <= word.clientWidth && word.offsetHeight <= parseFloat(getComputedStyle(word).lineHeight) * 2.5
  }
  for (const step of SHORT_STEPS) {
    for (const b of tiles) { b.classList.remove('is-tight', 'is-tiny', 'is-two', 'is-stacked'); b.classList.add(...step) }
    if (tiles.every(whole)) return
  }
}
// A font that arrives late is wider than its stand-in: fit again.
document.fonts?.addEventListener?.('loadingdone', () => { for (const a of document.querySelectorAll('.inbox-actions')) if (a.querySelector('.is-short')) fitShorts(a) })
const shortFit = new ResizeObserver(entries => {
  for (const { target, contentRect } of entries) {
    const w = Math.round(contentRect.width)
    if (!w || target.dataset.fitAt === String(w)) continue   // only a change of width; the height follows the fit
    target.dataset.fitAt = w
    fitShorts(target)
  }
})

// What the agent would pick: one option, or several where several are allowed.
const advised = (card, key) => [].concat(card.recommended ?? []).includes(key)

// What a row is: an open question, one that was put off, or one that was answered.
const kindOfRow = node => (node.classList.contains('inbox-done') ? 'done' : 'later' in node.dataset ? 'later' : 'open')


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

/** A session's mark, small, for a line that names who asked; the crowned one wears its crown (agents.js crowned). */
function smallMark(session) {
  const mark = el('span', 'inbox-from-mark')
  mark.style.setProperty('--hue', hueFor(session))
  mark.append(doodle(session.mark ?? session.id))
  if (crowned(session)) mark.append(crown())
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
// of a thumb row. What the agent advised
// is what it will take; with no advice it chooses itself.
const advisedLabels = card => card.options.filter(o => [].concat(card.recommended ?? []).includes(o.key)).map(o => o.label).join(', ')
const trustTip = card => (advisedLabels(card) ? `${TRUST_WORD}: leave it to the agent. It advised: ${advisedLabels(card)}` : `${TRUST_WORD}: leave it to the agent. It gave no advice and chooses itself`)
async function trustCard(card, onFail) {
  try {
    await trust(card.id)
    say(pageHost(), { head: TRUST_WORD, title: card.title, back: () => reopen(card.id) })
  } catch (err) { onFail(err) }
}

// Which of the row's ways out show as a tab at its edge (of inbox-later, inbox-revise, inbox-trust, inbox-shred).
const EDGE_TABS = ['inbox-later']

/** "What??": the session is asked to explain the card; the card is put off and comes back explained. */
async function askWhat(card) {
  await sendMessage(EXPLAIN_TEXT, card.agent, card.id, undefined, { explain: true })
  putOff(card.id, true, true)
  say(pageHost(), { head: `Asked: ${WHAT_WORD}`, title: 'It comes back with the answer.', back: async () => putOff(card.id, false) })
}

// ---- a phone: the row's ways out behind a long press (css/phone-desk.css) ----
// At phone width a row shows who asks, the title and the answers. Its ways out (Snooze, Revise, Whatever,
// What??, Shred, Copy) come up as a sheet after a long press on the row, or a right click. The opened card
// has the same ways out, for whoever cannot hold a finger down.
const PHONE = matchMedia('(max-width: 860px)')
const HOLD_MS = 450
const HOLD_SLOP = 10   // px a finger may wander and still be holding
let scrolled = { at: 0, node: null }   // the last scroll anywhere: a finger that scrolls, or stops a scroll, is not holding
addEventListener('scroll', e => { scrolled = { at: performance.now(), node: e.target } }, { capture: true, passive: true })
/** items(): [{ icon: Node, word, act(), cls? } | null (a rule)], asked for when the sheet opens. */
function holdMenu(node, title, items) {
  let timer = 0, x0 = 0, y0 = 0, downAt = 0, held = false
  const drop = () => { clearTimeout(timer); timer = 0; node.classList.remove('is-held') }
  const scrolledSince = t => scrolled.at >= t && (scrolled.node === document || scrolled.node?.contains?.(node))
  const open = () => {
    drop()
    if (!node.isConnected || document.querySelector('dialog.rowmenu')) return
    held = true
    const sheet = el('dialog', 'rowmenu')
    const inner = el('div', 'rowmenu-in')
    sheet.style.setProperty('--hue', node.style.getPropertyValue('--hue') || '162')
    sheet.setAttribute('aria-label', `More for: ${title}`)
    inner.append(el('h3', null, title))
    for (const it of items()) {
      if (!it) { inner.append(el('hr')); continue }
      const b = el('button', it.cls)
      b.type = 'button'
      b.append(it.icon, el('span', null, it.word))
      b.addEventListener('click', () => { if (!armed) return; held = false; sheet.close(); it.act() })
      inner.append(b)
    }
    sheet.append(inner)
    // The sheet comes up under the finger that is still down. Its lift is no tap: nothing on the sheet acts
    // before that finger is gone (a moment after it lifts, or when the next one comes down).
    let armed = false
    const lifted = e => { if (e.type === 'pointerdown') armed = true; else setTimeout(() => { armed = true }, 300) }
    const LIFT = ['pointerup', 'pointercancel', 'pointerdown']
    for (const name of LIFT) addEventListener(name, lifted, true)
    // A tap beside the sheet closes it; Escape is the dialog's own.
    sheet.addEventListener('click', e => { if (armed && e.target === sheet) sheet.close() })
    sheet.addEventListener('keydown', () => { armed = true })
    sheet.addEventListener('close', () => { held = false; sheet.remove(); for (const name of LIFT) removeEventListener(name, lifted, true) })
    document.body.append(sheet)
    sheet.showModal()
  }
  // Only in a list of questions (there the row is the calm card), and not on its answers or what unfolds under it.
  const free = e => node.closest('.inbox-groups') && !e.target.closest('.inbox-actions')
  node.addEventListener('pointerdown', e => {
    held = false
    drop()
    if (!PHONE.matches || !e.isPrimary || e.button > 0 || !free(e)) return
    downAt = performance.now()
    if (scrolledSince(downAt - 250)) return   // the list was moving: this finger stops it
    x0 = e.clientX; y0 = e.clientY
    node.classList.add('is-held')
    timer = setTimeout(() => { if (scrolledSince(downAt)) drop(); else open() }, HOLD_MS)
  })
  node.addEventListener('pointermove', e => { if (timer && Math.hypot(e.clientX - x0, e.clientY - y0) > HOLD_SLOP) drop() })
  for (const name of ['pointerup', 'pointercancel', 'pointerleave']) node.addEventListener(name, drop)
  node.addEventListener('contextmenu', e => {
    if (!PHONE.matches || !free(e)) return
    e.preventDefault()
    if (!held) open()
  })
  // The finger that held lifts: that is no tap on the title.
  node.addEventListener('click', e => { if (!held) return; held = false; e.preventDefault(); e.stopPropagation() }, true)
}

/** One question as a row.
 *  onOpen(cardId): open the card as a window of its own. onDecided(card, option): it was answered here.
 *  off: the card was put off. from: the session that asked, named on the
 *  row when nothing around it says so. fit: the list's lineFit(). */
export function questionRow(card, { onOpen, onDecided, onGallery = null, off = false, from = null, fit = null } = {}) {
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

  // A real link to the card's address (js/link.js): a plain click opens it here, the browser has the rest.
  const text = link('inbox-text', cardPath(card, from ? '' : sessionPath(card.agent)))
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
    // On the Desk of a wide screen the drawing stands alone in a narrow column left of the card (card
    // Nr. 164; CSS: .inbox-gutter). Its name shows as a small note under the pointer or the keyboard and is
    // always said to a screen reader; a click opens that session.
    const gutter = el('a', 'inbox-gutter')
    const path = `/s/${encodeURIComponent(from.id)}`
    gutter.href = location.protocol === 'file:' || location.hash.startsWith('#/') ? `#${path}` : path
    gutter.setAttribute('aria-label', `From ${from.name}: open the session`)
    gutter.dataset.name = from.name
    gutter.style.setProperty('--hue', hueFor(from))
    gutter.append(smallMark(from))
    gutter.addEventListener('click', e => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return   // a new tab is the browser's
      e.preventDefault()
      history.pushState({}, '', gutter.href)
      dispatchEvent(new PopStateEvent('popstate'))   // the page follows its address (app.js)
    })
    node.append(gutter)
  }
  text.append(title)
  // Beside the title: the card's number, which shows only under the pointer or the keyboard, and Snooze as a
  // small button with the drawn z z z (the tabs, put in here below). The card's age is this corner's tooltip and
  // a line for screen readers; its clock stands only on the opened card ("Uhrsymbol weg, nur in Detailansicht").
  const when = el('span', 'inbox-when')
  const told = () => { when.title = `${cardNr(card)} · asked ${ago(card.created)}` }
  told()
  when.addEventListener('mouseenter', told)
  const sr = agoNode(card.created, 'inbox-ago')
  when.append(copyButton(card), el('span', 'inbox-nr', cardNr(card)), sr)
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
  // A click on the text opens the card's own page (decided 3 October: no card unfolds in place any more).
  text.addEventListener('click', () => onOpen?.(card.id))
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

  // The row's ways out, small buttons on the card beside its title (in .inbox-when), in the order of the opened card: Snooze
  // (z z z; "Wake up" on a snoozed row), Revise (hand it back to its session), Whatever (leave it to the
  // agent) and Shred (throw it away unanswered). Each is tucked behind the edge with its drawing
  // showing; under the pointer or the keyboard it slides out with its word, and a click or a tap acts.
  // Look and motion: app.css, ".inbox-tabs".
  const tabs = el('div', 'inbox-tabs')
  const tab = (cls, drawing, word, label, act) => {
    const b = el('button', `inbox-tab-act ${cls}`)
    b.type = 'button'
    b.setAttribute('aria-label', label)
    const flap = el('i', 'inbox-later-flap')
    flap.append(sketch(drawing), el('b', null, word))
    b.append(flap)
    // One tap acts, with a finger too: the row leaves at once, and the note that says where it went has
    // the way back. (A first tap that only slid the tab out read as "Snooze does nothing" on the phone.)
    b.addEventListener('click', () => act(b))
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
  later.title = off ? `${WAKE_WORD}: fetch this question back` : `${LATER_WORD}: put this question off`
  hint(later, 'list.later')
  if (card.kind !== 'permission') {
    // Revise: the card goes back to its session at once (app.js openFocus, { revise }); the note that follows has
    // the way back. What should change is said on the opened card, or in the session.
    const revise = tab('inbox-revise', 'reverse', HANDBACK_WORD, `${HANDBACK_WORD}: hand it back to the session at once; it returns reworked`, () => onOpen?.(card.id, { revise: true }))
    revise.title = `${HANDBACK_WORD}: hand it back to the session, it returns reworked`
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
  // Shred is not hidden but tucked by CSS: while Shift is held it takes Snooze's place (app.css, body[data-shift]).
  for (const b of tabs.children) if (!EDGE_TABS.some(cls => b.classList.contains(cls)) && !b.classList.contains('inbox-shred')) b.hidden = true
  // A phone shows none of them on the row (phone-desk.css): a long press brings them up as a sheet, each
  // doing what its tab does, with "What??" (as on the opened card) and Copy.
  holdMenu(node, card.title, () => {
    const list = [...tabs.children].map(b => ({ icon: b.querySelector('svg').cloneNode(true), word: b.querySelector('b').textContent, act: () => b.click(), cls: b.classList.contains('inbox-shred') ? 'is-shred' : '' }))
    if (card.kind === 'decision') {   // (an info row has What?? as a tile)
      const what = { icon: sketch(WHAT_SKETCH), word: WHAT_WORD, act: () => askWhat(card).catch(err => { error.textContent = `Not asked: ${why(err)}`; error.hidden = false }) }
      list.splice(list.at(-1)?.cls ? list.length - 1 : list.length, 0, what)   // before Shred
    }
    return [...list, null, { icon: when.querySelector('.cardclip-copy svg').cloneNode(true), word: 'Copy', act: () => copyCard(card) }]
  })

  const actions = el('div', 'inbox-actions')
  // How a two-way question answers: bare thumbs (yes / no), the labels under them, or the agent's short words.
  const bare = (card.options ?? []).every(o => BARE.test(o.label.trim()))
  const size = bare ? 'none' : labelSize(card.options)
  const short = (card.options ?? []).every(shortOf)
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
  // The ways out stand on the card, beside the title: nothing sticks out of the row's edge.
  when.insertBefore(tabs, sr)
  node.append(actions, error)
  if (card.kind === 'info') {
    // Something to read, nothing to decide: two tiles of the board's own where the answers stand. Left
    // "What??": the session is asked to explain it, and the card comes back explained. Right
    // "Acknowledge": read, closed. (The text opens it as a card, as on a question.)
    node.dataset.kind = 'info'
    const fail = (what, err) => { for (const b of actions.children) b.disabled = false; error.textContent = `${what}: ${err.message}`; error.hidden = false }
    const busy = () => { for (const b of actions.children) b.disabled = true }
    const what = tile('is-thumb is-what', WHAT_SKETCH, WHAT_WORD, async () => {
      busy()
      try { await askWhat(card) } catch (err) { fail('Not asked', err) }
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
  } else if (quick(card) && (bare || size !== 'none' || short)) {
    // Thumbs are the rule: down on the left, up on the right, on every card. The option the agent
    // leads with (its first, or "allow") is the up. The option's own word stands under its thumb
    // only when the pair says more than yes and no; labels too long for a tile give way to the
    // agent's short words (and without those the row is a "Choose", below).
    const isYes = o => (card.kind === 'permission' ? o.key === 'allow' : o === card.options[0])
    const options = [...card.options].sort((a, b) => isYes(a) - isYes(b))
    const worded = !bare && size === 'none'   // the short words stand on the tiles
    if (worded) shortFit.observe(actions)
    for (const o of options) {
      const lead = isYes(o)
      const b = tile(`is-thumb${lead ? ' is-lead' : ''}${size === 'small' ? ' is-small' : ''}${worded ? ' is-short' : ''}`, lead ? 'yes' : 'no', worded ? shortOf(o) : size === 'none' ? '' : o.label, async () => {
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
      if (worded) b.lastElementChild.className = 'inbox-short'
      if (o.detail || (size === 'none' && !bare)) b.title = [size === 'none' && !bare ? o.label : '', o.detail].filter(Boolean).join(': ')
      if (advised(card, o.key)) { b.classList.add('is-advised'); b.title = 'The agent recommends this'; b.append(adviceLoop()) }
      actions.append(b)
    }
  } else {
    // More than two ways: one tile, "Choose", in the place of the right-hand thumb (its class is still
    // called is-wide). It opens the card's own page, where every option stands.
    const count = card.multiple ? `${card.options.length} options, several` : `${card.options.length} options`
    const choose = tile('is-wide is-lead', 'choose', 'Choose', () => onOpen?.(card.id))
    // Only the word stands on the tile; how many options there are is said in its tooltip and to a screen reader.
    choose.title = count
    choose.setAttribute('aria-label', `Choose: ${count}`)
    hint(choose, 'list.open')
    actions.append(choose)
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
export function mountInbox(root, { onOpen, onDecided, onGallery = null, agent = null }) {
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
    if (cached) fit.unobserve(cached.node.querySelector('.inbox-question'))
    const node = questionRow(card, { onOpen, onDecided, onGallery, fit, ...opts })
    cards.set(card.id, card)
    rows.set(card.id, { sig, node })
    return node
  }

  let fetching = null   // the id of a card that "Take back" is returning: its row is marked when it is here
  // ---- a line on one of the piles at the foot (piles.js): one sheet of a stack that is fanned out ----
  // kind: 'later' (snoozed) | 'asked' (in revision) | 'answered' (decided, or closed) | 'shredded' | 'withdrawn' (by its
  // session: nothing takes that back). The mark of its kind (in revision:
  // the turned card and the turning ring while the session works on it), the title, one grey line (said), who asked, since when,
  // and the way back: "Take back", or "Wake up" on a snoozed one. A click on the title opens the card.
  // The keys treat it as an answered row (.inbox-done): J/K reach it, U takes it back.
  let openPile = null, widePile = false   // the stack that stands fanned out, and whether it shows the whole pile
  let foot = null                         // the row of stacks as it stands now
  function pileLine(card, kind, said) {
    const sender = lastState?.all.agents.find(a => a.id === card.agent)
    const node = el('article', 'inbox-done inbox-revising-row')
    node.tabIndex = -1
    node.dataset.id = card.id
    node.dataset.kind = kind   // why it lies there: later | asked | answered | shredded | withdrawn
    if (kind === 'later') node.dataset.later = ''
    const go = link('inbox-revising-open', cardPath(card, agent ? sessionPath(agent) : ''))
    go.title = `${cardNr(card)}: open it`
    go.append(...(kind === 'asked' ? [sketch('reverse'), workingRing()] : [sketch(kind === 'later' ? LATER_SKETCH : kind === 'shredded' || kind === 'withdrawn' ? SHRED_SKETCH : 'tick')]),
      el('strong', null, card.title), ...(said ? [el('span', 'inbox-revising-sent', said)] : []))
    go.addEventListener('click', () => onOpen?.(card.id))
    const tail = el('span', 'inbox-revising-tail')
    if (sender && !agent) tail.append(smallMark(sender), el('span', 'inbox-stack-who', sender.name))
    const since = kind === 'asked' ? card.with_agent : kind === 'later' ? card.snoozed_at : kind === 'shredded' ? card.shredded : card.decided
    if (since && kind !== 'withdrawn') tail.append(agoNode(since))
    // What its session withdrew stays withdrawn (the hub takes nothing back there): the line has no way back.
    if (kind === 'withdrawn') { node.append(go, tail); return node }
    const word = kind === 'later' ? WAKE_WORD : 'Take back'
    const take = el('button', 'inbox-takeback inbox-revising-take', word)
    take.type = 'button'
    take.title = kind === 'asked' ? 'Take it back: the session need not rework it' : kind === 'later' ? `${WAKE_WORD}: fetch this question back` : 'Take back: the question is open again'
    take.setAttribute('aria-label', `${word}: ${card.title}`)
    hint(take, 'list.takeback')
    take.addEventListener('click', async () => {
      take.disabled = true
      try {
        if (kind === 'asked') await takeBack(card.id)
        else if (kind === 'later') await putOff(card.id, false)
        else { fetching = card.id; await reopen(card.id) }
      } catch (err) { if (fetching === card.id) fetching = null; take.disabled = false; error(`Not taken back: ${why(err)}`) }
    })
    node.append(go, tail, take)
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
  // "New questions may slide in from above, they must not move my window": a list that changes under him
  // keeps the row he is at where it is. That row is the one under the resting pointer, else one that stands
  // unfolded, else the one with the keyboard, else (scrolled down) the first in sight. What arrives above the
  // fold is said quietly instead: "2 new ↑", a tap goes there.
  let painted = false
  const unseen = new Set()
  const news = el('button', 'inbox-news')
  news.type = 'button'
  news.hidden = true
  const newsAt = el('div', 'inbox-news-at')
  newsAt.append(news)
  root.insertBefore(newsAt, list)
  const sight = () => { const r = scroller(list)?.getBoundingClientRect(); return { top: r?.top ?? 0, bottom: r?.bottom ?? innerHeight } }
  function tellNew() {
    const { top } = sight()
    for (const id of unseen) { const n = rows.get(id)?.node; if (!n?.isConnected || !n.getClientRects().length || n.getBoundingClientRect().bottom > top + 8) unseen.delete(id) }
    news.hidden = !unseen.size
    if (unseen.size) { news.textContent = `${unseen.size} new ↑`; news.setAttribute('aria-label', `${unseen.size} new above: go there`) }
  }
  news.addEventListener('click', () => {
    const first = nodes().find(n => unseen.has(n.dataset.id))
    if (first) reveal(first)
    else tellNew()
  })
  let newsBox = null
  // A knock that is out of sight: one quiet strip at the edge of the list it lies beyond, "↓ 1 knock" at the
  // bottom or "↑ 2 knocks" at the top, in the knock's colour with its mark. A click goes to the nearest one
  // and marks it for a moment; the strip goes when they are in sight or answered.
  let knockIds = [], edgeBox = null
  const knockEdge = dir => {
    const at = el('div', `inbox-edge is-${dir}`)
    const b = el('button', 'inbox-edge-knock')
    b.type = 'button'
    b.hidden = true
    at.append(b)
    b.addEventListener('click', async () => {
      // The cards are hidden (the Desk's eye switch, js/padlink.js): they come back first, so the strip never leads
      // to something that cannot be seen. (Hidden rows count as out of sight, so this comes before the looking.)
      if (list.closest('[data-cards-hidden]')) {
        const { toggleCards } = await import('./padlink.js')
        toggleCards(false)
      }
      const beyond = knocksBeyond()[dir]
      const node = dir === 'up' ? beyond.at(-1) : beyond[0]
      if (!node) return
      reveal(node)
      node.animate([{ outline: '3px solid var(--urg-high)', outlineOffset: '3px' }, { outline: '3px solid transparent', outlineOffset: '3px' }], { duration: 1600 })
    })
    return { at, b }
  }
  const edges = { up: knockEdge('up'), down: knockEdge('down') }
  root.append(edges.up.at, edges.down.at)
  const sightChange = new ResizeObserver(() => { tellKnocks(); tellNew() })
  sightChange.observe(list)   // a row unfolds, the window changes: other rows are in sight
  sightChange.observe(root)   // the view itself gets shorter (a phone gives the "Back" note a strip at its foot): the lower strip moves up with it
  function knocksBeyond() {
    const { top, bottom } = sight()
    const up = [], down = []
    if (shown()) for (const id of knockIds) {
      const n = rows.get(id)?.node
      if (!n?.isConnected || !n.getClientRects().length || kindOfRow(n) !== 'open') continue
      const r = n.getBoundingClientRect()
      if (r.bottom <= top + 24) up.push(n)
      else if (r.top >= bottom - 24) down.push(n)
    }
    return { up, down }
  }
  function tellKnocks() {
    const beyond = knocksBeyond()
    const frame = sight(), across = list.getBoundingClientRect()
    for (const dir of ['up', 'down']) {
      const b = edges[dir].b, n = beyond[dir].length
      // On the edge itself, as wide as the list: the rows pass under it as they pass under the edge.
      let left = across.left, width = across.width
      // The Desk's two paper switches stand at its lower left (css/deskpad.css): where the window is narrow enough
      // for the list to reach them, the lower strip begins beside them instead of lying under them.
      if (n && dir === 'down') {
        const sw = document.querySelector('.deskpad-switch')?.getBoundingClientRect()
        if (sw?.width && sw.right + 8 > left && sw.bottom > frame.bottom - 26 && sw.right + 8 < left + width / 2) { width -= sw.right + 8 - left; left = sw.right + 8 }
      }
      if (n) Object.assign(edges[dir].at.style, { left: `${left}px`, width: `${width}px`, top: dir === 'up' ? `${frame.top}px` : '', bottom: dir === 'down' ? `${innerHeight - frame.bottom}px` : '' })
      if (b.hidden === !n && b.dataset.n === String(n)) continue
      b.hidden = !n
      b.dataset.n = n
      if (n) { b.replaceChildren(dir === 'up' ? '↑' : '↓', sketch(KNOCK_SKETCH), knocksText(n)); b.setAttribute('aria-label', `${knocksText(n)} ${dir === 'up' ? 'above' : 'below'}: go there`) }
    }
  }
  function holdRow(held) {
    if (!painted || !shown()) return null
    const box = scroller(list), { top, bottom } = sight()
    const seen = n => { const r = n.getBoundingClientRect(); return r.height > 0 && r.bottom > top && r.top < bottom }
    const all = nodes()
    const node = [list.querySelector('.inbox-row:hover'), held?.closest?.('.inbox-row'),
      (box ? box.scrollTop : scrollY) > 0 ? all.find(n => n.getBoundingClientRect().top >= top) : null].find(n => n && seen(n))
    return node ? { node, kind: kindOfRow(node), top: node.getBoundingClientRect().top } : null
  }
  // Scrolls the list by what the held row has moved, and returns that.
  function keepRow(hold) {
    if (!hold?.node.isConnected || !hold.node.getClientRects().length || kindOfRow(hold.node) !== hold.kind) return 0
    const by = Math.round(hold.node.getBoundingClientRect().top - hold.top)
    if (!by) return 0
    const box = scroller(list), from = box ? box.scrollTop : scrollY
    if (box) box.scrollTop += by
    else scrollBy({ top: by, behavior: 'instant' })
    return (box ? box.scrollTop : scrollY) - from
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
      .sort((a, b) => (b.decided ?? 0) - (a.decided ?? 0))
    // What its session withdrew (or closed unanswered): closed without an answer of his. It lies in the basket.
    const withdrawn = all.cards.filter(c => (!agent || c.agent === agent) && c.status === 'done' && c.kind !== 'permission' && !answered.includes(c))
    const next = JSON.stringify([answered.map(c => [c.id, c.status, c.choice, c.choices, c.decided, c.title]), all.cards.filter(c => c.status === 'shredded').map(c => c.id), withdrawn.map(c => [c.id, c.title, c.summary]), off.map(c => c.id), state.handed, open.map(c => [c.id, c.unsnoozed, c.revised, c.urgency, c.urgency_reason, c.title, c.body, c.options, c.recommended, c.multiple, c.attachments?.length]), agents.map(a => [a.id, a.name, a.mark, a.starred])])
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
      const walk = link('inbox-walk inbox-go', walkPath(agent ? sessionPath(agent) : ''))
      walk.title = `${WALK_WORD}: every open question, one after the other (G F)`
      walk.setAttribute('aria-label', `${WALK_WORD}: ${fresh.length === 1 ? '1 open question' : `${fresh.length} open questions`}`)
      walk.setAttribute('aria-keyshortcuts', 'G F')
      count(fresh.length)
      walk.append(el('span', null, WALK_WORD), circled, sketch('go'))
      walk.addEventListener('click', () => { walk.blur(); onOpen?.(null) })
      heading = el('h2', 'inbox-heading inbox-index')
      heading.append(walk)
      // Index cards (card Nr. 166, "index"): "Next, please" is the divider in front; the next cards peek out
      // behind it as small tabs with their sender's mark and title (a press brings that row into view), then "+N".
      fresh.slice(1, 4).forEach((card, i) => {
        const tab = el('button', 'inbox-index-tab')
        tab.type = 'button'
        tab.title = card.title
        tab.style.zIndex = String(8 - i)
        const sender = agents.find(a => a.id === card.agent)
        if (sender) { tab.style.setProperty('--hue', hueFor(sender)); tab.append(smallMark(sender)) }
        tab.append(el('span', null, card.title))
        tab.addEventListener('click', () => list.querySelector(`.inbox-row[data-id="${CSS.escape(card.id)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
        heading.append(tab)
      })
      if (fresh.length > 4) { const more = el('span', 'inbox-index-tab inbox-index-more', `+${fresh.length - 4}`); more.title = `${fresh.length - 4} more behind`; heading.append(more) }
      // (The knocks are counted by the floating Desk above; the heading does not say them a second time.)
    } else if (fresh.length) line.append(...(knocking ? [knocks, ' · '] : []), ...(asking || !toRead ? [circled, needs] : []), ...(toRead ? [asking ? ' · ' : '', reading] : []))
    else line.append('Nothing needs you.')
    // A session's pane already carries its name as the title; the inbox has its own.
    // Before the first state is in, nothing is known: no "clear", no "nothing needs you" (they would be untrue).
    const known = isLoaded()
    if (!known) {}
    else if (agent) title.append(line)
    else if (heading) title.append(heading)
    else {
      // Only what is true: the desk is clear, and what still lies below it, by name.
      const handed = new Set(state.handed ?? [])
      const revising = off.filter(c => handed.has(c.id)).length, snoozed = off.length - revising
      const below = [revising ? `${revising} in revision` : '', snoozed ? `${snoozed} snoozed` : ''].filter(Boolean).join(' · ')
      title.append(el('h2', null, `${INBOX_WORD} is clear.`), ...(below ? [el('p', null, below)] : []))
    }
    lastState = state
    head.replaceChildren(...((agent && !open.length) || !known ? [] : [title]), ...(walkTools ? [walkTools] : []))
    // (The sheet of keys opens from the "?" in the bar, index.html #keys-open, and by the key "?".)

    // The desk's order is fixed: the rows stand as the hub's queue has them (the oldest question at the top,
    // a new one at the end), and nothing here sorts them: not urgency, not a star, not the sender. Cards of
    // one session that follow each other are a run under that session's tab; a session whose cards do not
    // follow each other has several runs, each with its tab. A knock stays in its place and is pointed at
    // from the list's edge (tellKnocks, above).
    const groups = []
    for (const card of fresh) {
      const sender = agents.find(a => a.id === card.agent)
      if (!sender) continue
      if (groups.at(-1)?.agent === sender) groups.at(-1).cards.push(card)
      else groups.push({ agent: sender, cards: [card] })
    }
    knockIds = fresh.filter(isKnock).map(c => c.id)

    // Remember where every row was, so that after an answer the rest slides up instead of jumping.
    const before = new Map(nodes().map(n => [n.dataset.id, n.getBoundingClientRect().top]))
    const old = nodes().filter(n => kindOfRow(n) !== 'done').map(n => ({ node: n, id: n.dataset.id, off: 'later' in n.dataset, box: n.getBoundingClientRect() }))
    // Rebuilding moves every row out of the list and back. A row or a control that holds the keyboard
    // would lose it on the way, and Chromium then lays the emptied list out and scrolls it to its top:
    // let go before the first row moves, and take the keyboard up again below.
    const held = list.contains(document.activeElement) ? document.activeElement : null
    const hold = holdRow(held)
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
        // No tab above a run (card Nr. 164): every row says who asks itself, with the session's drawing in
        // the column at its left (questionRow, .inbox-gutter), on a phone in its first line.
        section.style.setProperty('--hue', hueFor(sender))
      }
      section.append(...cards.map(c => row(c, { from: agent ? null : sender })))
      parts.push(section)
    }
    // What lies off the desk stands at its foot (piles.js), one place per state, the newest first in each:
    //   "Later"         open and put off by him (snoozed); it comes back when he wakes it or its time is up
    //   "In the works"  with the session: open and handed back ("Revise", "What??"; it returns by itself), then
    //                   answered and not closed yet (status "decided": the session is acting on the answer)
    //   "Done"          answered and closed by the session (status "done"), an info that was read
    //   the basket      shredded by him (he can fish it out), and withdrawn by its session (no way back)
    const asked = new Set(state.handed ?? [])
    const newest = (cards, at) => [...cards].sort((a, b) => at(b) - at(a))
    const waiting = newest(off.filter(c => asked.has(c.id)), c => c.with_agent ?? 0), put = newest(off.filter(c => !asked.has(c.id)), c => c.snoozed_at ?? 0)
    const shredded = all.cards.filter(c => (!agent || c.agent === agent) && c.status === 'shredded')
    const acting = newest(answered.filter(c => c.status === 'decided'), c => c.decided ?? 0), done = newest(answered.filter(c => c.status !== 'decided'), c => c.decided ?? 0)
    const trash = newest([...shredded, ...withdrawn], c => (c.status === 'shredded' ? c.shredded : c.created) ?? 0)
    const answeredLine = c => pileLine(c, 'answered', `${answerOf(c)}${c.status === 'done' ? ' · done by the agent' : ''}`)
    // In revision, the grey line is the newest word on the card from either side: what he sent, or the session's
    // acknowledgement since (the hub keeps the card in revision when the agent only replies). His own says "You:".
    const lastWord = c => { const last = [...all.messages].reverse().find(m => m.card_id === c.id && m.from !== 'event' && m.text); return last ? plain(`${last.from === 'user' ? 'You: ' : ''}${last.text}`) : '' }
    const until = c => (c.snoozed_until ? `Until ${new Date(c.snoozed_until).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : '')
    const answerOf = c => { if (c.kind === 'info') return 'Read'; if (c.trusted) return `${TRUST_WORD}${advisedLabels(c) ? `: ${advisedLabels(c)}` : ''}`; const picked = c.choices?.length ? c.choices : [c.choice]; return c.options.filter(o => picked.includes(o.key)).map(o => o.label).join(', ') || String(c.choice) }
    const piles = [
      { kind: 'later', word: 'Later', lines: put.map(c => () => pileLine(c, 'later', until(c))) },
      { kind: 'works', word: 'In the works', ring: waiting.length ? workingRing() : null, lines: [...waiting.map(c => () => pileLine(c, 'asked', lastWord(c))), ...acting.map(c => () => answeredLine(c))] },
      { kind: 'done', also: 'answered', word: 'Done', lines: done.map(c => () => answeredLine(c)) },
      { kind: 'trash', word: 'Trash', bin: true, lines: trash.map(c => () => (c.status === 'shredded' ? pileLine(c, 'shredded', 'Shredded') : pileLine(c, 'withdrawn', `Withdrawn${c.summary ? `: ${plain(c.summary)}` : ''}`))) },
    ]
    foot = piles.some(p => p.lines.length) ? stacks(piles, { open: openPile, wide: widePile, onToggle: (kind, wide) => { openPile = kind; widePile = wide }, onShut: () => folded(false) }) : null
    if (foot) parts.push(foot.node)
    if (!open.length && known) {
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

    // What he is at stays where it is; what came in above the fold is counted on the small "new" button.
    const shift = keepRow(hold)
    if (painted && shown()) {
      const was = new Set(old.filter(o => !o.off).map(o => o.id))
      for (const c of fresh) if (!was.has(c.id)) unseen.add(c.id)
      if (unseen.size && !newsBox) { newsBox = scroller(list) ?? window; newsBox.addEventListener('scroll', tellNew, { passive: true }) }
    }
    tellNew()
    tellKnocks()
    if (!edgeBox && shown()) { edgeBox = scroller(list) ?? window; edgeBox.addEventListener('scroll', tellKnocks, { passive: true }); addEventListener('resize', tellKnocks) }
    painted = true

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
      Object.assign(node.style, { left: `${box.left - frame.left}px`, top: `${box.top - shift - frame.top}px`, width: `${box.width}px`, height: `${box.height}px` })
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
  // Below the rows lie the piles (Later, In the works, Done, the basket), pushed together. The keyboard goes on
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
  provide('list', {
    active: shown,
    actions: {
      'list.next': move(at => at + 1),
      'list.prev': move(at => at - 1),
      'list.first': move(() => 0, true),
      'list.last': move((_, n) => n - 1, true),
      'list.yes': onRow(node => press(node.querySelectorAll('.inbox-answer.is-thumb')[1])),
      'list.no': onRow(node => press(node.querySelectorAll('.inbox-answer.is-thumb')[0])),
      'list.later': onRow(node => press(node.querySelector('.inbox-later'))),
      'list.shred': onRow(node => press(node.querySelector('.inbox-shred'))),
      'list.trust': onRow(node => press(node.querySelector('.inbox-trust'))),
      // The card's own page (a row never unfolds in place); on an info: Acknowledge.
      'list.open': onRow(node => {
        if (kindOfRow(node) === 'done') return true   // nothing to open; its key is "take back"
        if (node.dataset.kind === 'info') return press(node.querySelector('.inbox-answer.is-ack'))
        onOpen?.(node.dataset.id)
        return true
      }),
      // Ask back: the card's page, with the field ready.
      'list.ask': onRow(node => {
        if (kindOfRow(node) === 'done') return true
        onOpen?.(node.dataset.id, { ask: true })
        return true
      }),
      // Explain: on an info What??; else the card's page, where What?? stands with everything the card holds.
      'list.explain': onRow(node => {
        const card = cards.get(node.dataset.id)
        if (!card || card.kind === 'permission') return false
        if (card.kind === 'info') return press(node.querySelector('.inbox-answer.is-what'))
        onOpen?.(card.id)
        return true
      }),
      // Revise: the marked card goes back to its session at once (what the Revise tab does).
      'list.revise': marked(node => {
        const card = cards.get(node.dataset.id)
        if (!card || card.kind === 'permission' || kindOfRow(node) === 'done') return false
        onOpen?.(card.id, { revise: true })
        return true
      }),
      // On an answered row: its answer is taken back, and the question stands in its group again.
      'list.takeback': marked(node => (kindOfRow(node) === 'done' ? press(node.querySelector('.inbox-takeback')) : false)),
      'list.leave': () => {
        const node = here()
        if (!node) return foot?.close() ?? false   // nothing marked: Escape gathers the stack that is fanned out
        mark(null)
        if (node === document.activeElement) node.blur()
      },
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
    const card = lastState.all.cards.find(c => c.id === cardId)
    openPile = card?.status === 'decided' ? 'works' : card?.status === 'shredded' ? 'trash' : 'done'
    widePile = true   // it may lie below the newest ones
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
