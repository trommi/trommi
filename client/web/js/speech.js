// Read aloud: have a message or a card read out. (Dictation was removed: out of scope for launch.)

import { getState, subscribe } from './store.js'
import { el, rich } from './ui.js'

// ---- read aloud ------------------------------------------------------------
//
// Every message can be read out. A small speaker stands beside each one: with an agent's
// message beside the time (a follow-up without a time: at the end of its first line), with
// the human's own to the left of the bubble, with a question at the end of its title. This
// module puts it there itself, on whatever the page shows as a message (.msg, an open
// question in the log, the question of the window), so no other module has to know.
//
// One click reads, the same control stops; another message takes over; Esc stops.
// Shift+click (or a long press) reads from here on: this message, then the ones after it.
//
// What is read is what a person would read: the text as it stands on the page, without the
// markup; a code block is only named, a link is its words, a published page its title. The
// text goes to the board in pieces (POST /speech/say), a short one first so the first sound
// comes fast, the next ones fetched while the one before plays. Each piece carries a cheap
// guess of its language (German or English), which the voice needs for mixed sentences.
//
//   readAloud(node, { following })   start (or stop, if it is the one being read); node is a
//                                    message, a question, or anything inside one
//   stopReading()                    silence
//   isReading()                      true while something is read or being fetched
//   readCard(cardId, button)         a question by its id, for the switch of the question window

const FIRST = 100, SECOND = 220, PIECE = 400   // letters per piece
const SAY_KEEP = 80                            // spoken pieces kept in the page
const SPEAKABLE = '.msg, .ask-open, .ask-card, .focus-card'

const SAY_WORDS = {
  en: { code: n => (n === 1 ? 'Code, one line.' : `Code block, ${n} lines.`), link: 'link', linkTo: 'link to', details: 'Details:', options: 'The options:', or: 'or', permission: 'Allow or deny?', gone: 'no longer available' },
  de: { code: n => (n === 1 ? 'Code, eine Zeile.' : `Codeblock, ${n} Zeilen.`), link: 'Link', linkTo: 'Link zu', details: 'Details:', options: 'Zur Auswahl:', or: 'oder', permission: 'Erlauben oder ablehnen?', gone: 'nicht mehr verfügbar' },
}

const GERMAN = /\b(der|die|das|und|ist|nicht|ich|ein|eine|einen|mit|für|auf|den|dem|des|zu|von|sich|auch|noch|oder|aber|wird|sind|wir|du|es|im|nach|bei|wie|nur|schon|kann|soll|habe|hat|dass|wenn|bitte|jetzt|kein|keine|nimm|mach|geht|fertig|wurde|über|dir|mir)\b/g
const ENGLISH = /\b(the|and|is|are|not|with|for|this|that|of|to|it|you|have|has|but|or|be|on|as|at|by|from|should|can|what|which|when|please|now|no|yes|done|we|my|your|there|been|were)\b/g

/** 'de', 'en', or '' when the text gives no sign. */
export function guessLanguage(text) {
  const t = String(text).toLowerCase()
  const de = (t.match(GERMAN)?.length ?? 0) + 2 * (t.match(/[äöüß]/g)?.length ?? 0)
  const en = t.match(ENGLISH)?.length ?? 0
  return de > en ? 'de' : en > de ? 'en' : ''
}

// Not text of the message: its head, the time, controls, pictures and players.
const UNSPOKEN = '.say, time, .msg-head, .msg-time, .msg-about, .code-head, .shots, .files, .scribble-card, .focus-msg-state, .focus-msg-files, button, img, svg, video, audio, [hidden]'
const BLOCKS = new Set(['P', 'LI', 'UL', 'OL', 'DIV', 'TABLE', 'TR', 'PRE', 'DETAILS', 'SUMMARY', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'ARTICLE', 'BR'])

// The page's own rendering of a message, as a list of sentences-to-be: strings, and
// { word, ... } for what is only named (its words depend on the language of the rest).
function partsOf(root) {
  const parts = []
  const walk = node => {
    if (node.nodeType === 3) return parts.push(node.nodeValue)
    if (node.nodeType !== 1) return
    // something published under a link of its own: what it is called
    if (node.matches('.asset-card, [data-asset-link]')) {
      return parts.push('\n', (node.querySelector('strong') ?? node).textContent, ...(node.matches('.is-gone') ? [', ', { word: 'gone' }] : []), '\n')
    }
    if (node.matches(UNSPOKEN)) return
    if (node.matches('pre')) return parts.push({ word: 'code', n: node.textContent.replace(/\n+$/, '').split('\n').length }, '\n')
    if (node.matches('a')) {
      const text = node.textContent.trim()
      // a bare address is not read letter by letter
      if (!/^(https?:\/\/|www\.)|^\S*\/\S*\/\S*$/.test(text)) return parts.push(text)
      let host = ''
      try { host = new URL(node.href).hostname.replace(/^www\./, '') } catch {}
      return parts.push({ word: 'link', host: host && host !== location.hostname ? host : '' })
    }
    if (node.matches('summary')) return parts.push('\n', { word: 'details' }, '\n')
    if (node.matches('th, td')) { for (const child of node.childNodes) walk(child); return parts.push(', ') }
    const block = BLOCKS.has(node.tagName)
    if (block) parts.push('\n')
    for (const child of node.childNodes) walk(child)
    if (block) parts.push('\n')
  }
  walk(root)
  return parts
}

// A question: its title, why it is urgent, its text, and the options as a short list.
function partsOfCard(card) {
  const labels = (card.options ?? []).map(o => String(o.label ?? '').trim()).filter(Boolean)
  const options = card.kind === 'permission' ? [{ word: 'permission' }] : labels.length ? [{ word: 'options', labels }] : []
  return [card.title ?? '', '\n', card.urgency_reason ?? '', '\n', ...partsOf(rich(card.body ?? '')), '\n', ...options]
}

// The parts as one text to speak, and the language guessed for it.
function scriptOf(parts) {
  const lang = guessLanguage(parts.filter(p => typeof p === 'string').join(' '))
  const w = SAY_WORDS[lang || 'en']
  const named = p => (p.word === 'code' ? w.code(p.n)
    : p.word === 'link' ? (p.host ? `${w.linkTo} ${p.host}` : w.link)
    : p.word === 'options' ? `${w.options} ${p.labels.length > 1 ? `${p.labels.slice(0, -1).join(', ')} ${w.or} ${p.labels.at(-1)}` : p.labels[0]}`
    : w[p.word] ?? '')
  let text = parts.map(p => (typeof p === 'string' ? p : named(p))).join('').split(/\n+/)
    .map(line => line
      // markup the page shows as written: headings, quotes, bullets, emphasis, rules
      .replace(/^\s*(#{1,6}|>+|[-*•]|\[[ x]\])\s+/i, '').replace(/^\s*([-=*_]\s*){3,}$/, '')
      .replace(/(\*\*|__|~~|`)/g, '').replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
      .replace(/\p{Extended_Pictographic}️?/gu, '').replace(/\s*(→|->|=>)\s*/g, ', ')
      .replace(/[,\s]+$/, '').trim())
    .filter(line => /[\p{L}\p{N}]/u.test(line))
    // every line ends like a sentence, so the voice pauses there
    .map(line => (/[.!?…:;]["')\]»]*$/.test(line) ? line : `${line}.`))
    .join(' ').replace(/\s+/g, ' ').trim()
  // The voice stumbles over German number formats: 48.210 and 02:00.
  if (lang === 'de') text = text.replace(/(\d)\.(\d{3})\b/g, '$1$2').replace(/\b0?(\d{1,2}):00\b/g, '$1 Uhr').replace(/\b0?(\d{1,2}):(\d{2})\b/g, '$1 Uhr $2')
  return { text, lang }
}

// In pieces at the ends of sentences: a short one first, so the first sound comes fast.
function piecesOf({ text, lang }) {
  const pieces = []
  const limit = () => (pieces.length === 0 ? FIRST : pieces.length === 1 ? SECOND : PIECE)
  let now = ''
  const push = () => { if (now.trim()) pieces.push(now.trim()); now = '' }
  for (let sentence of text.split(/(?<=[.!?…:;]["')\]»]*)\s+/)) {
    if (now && now.length + sentence.length + 1 > limit()) push()
    // one sentence longer than a piece: cut at a comma, else at a space
    while (sentence.length > limit()) {
      const max = limit()
      const cut = Math.max(sentence.lastIndexOf(', ', max) + 1, 0) || sentence.lastIndexOf(' ', max) || max
      now = sentence.slice(0, cut)
      push()
      sentence = sentence.slice(cut).trim()
    }
    now += (now ? ' ' : '') + sentence
  }
  push()
  return pieces.map(piece => ({ text: piece, lang: guessLanguage(piece) || lang }))
}

/** What would be read for a message or question node, as { text, lang }. For tests and the curious. */
export function spokenText(node) {
  const target = targetOf(node)
  return target ? scriptOf(target.parts()) : { text: '', lang: '' }
}

// ---- the sound ----

const spokenAudio = new Map()   // lang|text -> Promise of an object URL

function audioFor({ text, lang }) {
  const key = `${lang}|${text}`
  let url = spokenAudio.get(key)
  if (url) return url
  url = fetch('/speech/say', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, lang }) })
    .then(async res => {
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText)
      return URL.createObjectURL(await res.blob())
    })
  spokenAudio.set(key, url)
  url.catch(() => spokenAudio.delete(key))
  if (spokenAudio.size > SAY_KEEP) {
    const [oldest, gone] = spokenAudio.entries().next().value
    spokenAudio.delete(oldest)
    gone.then(u => URL.revokeObjectURL(u), () => {})
  }
  return url
}

let player = null     // the one Audio element; only one thing speaks at a time
let reading = null    // { key, node, button, pieces, at, said, total, following, esc, paint, resolve }

function paintSay(job, state) {
  const { button } = job
  if (!button) return
  if (job.plain) {
    // the switch of the question window: its own attribute, no progress
    if (state === 'loading' || state === 'playing') button.setAttribute('data-speaking', state)
    else button.removeAttribute('data-speaking')
    return
  }
  if (state) button.dataset.say = state
  else delete button.dataset.say
  if (state !== 'playing' && state !== 'loading') button.style.removeProperty('--said')
  const label = state === 'failed' ? `Not read: ${job.error ?? 'no sound'}` : state ? 'Stop reading (Esc)' : 'Read aloud (Shift+click: from here on)'
  button.setAttribute('aria-label', label)
  button.title = label
  button.setAttribute('aria-pressed', String(state === 'loading' || state === 'playing'))
}

function onSayKey(e) {
  if (e.key !== 'Escape' || !reading) return
  e.preventDefault()
  e.stopImmediatePropagation()
  stopReading()
}

/** Silence. */
export function stopReading() {
  const job = reading
  if (!job) return
  reading = null
  clearTimeout(job.slow)
  window.removeEventListener('keydown', onSayKey, true)
  player.onended = player.onerror = player.onplaying = player.ontimeupdate = null
  player.pause()
  paintSay(job, null)
  job.resolve()
}

export const isReading = () => Boolean(reading)

function failReading(job, err) {
  if (reading !== job) return
  stopReading()
  job.error = err?.message || 'no sound'
  paintSay(job, 'failed')
  setTimeout(() => { if (job.button?.dataset.say === 'failed') paintSay(job, null) }, 4000)
}

async function nextPiece(job) {
  if (reading !== job) return
  const piece = job.pieces[job.at]
  if (!piece) {
    // read to the end; "from here on" goes on with the message after it
    const next = job.following && job.node?.isConnected ? following(job.node) : null
    stopReading()
    if (next) { next.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); readAloud(next, { following: true }) }
    return
  }
  // a message that left the page (another question, a closed window) falls silent at the next piece
  if (job.node && !job.node.isConnected) return stopReading()
  for (const ahead of job.pieces.slice(job.at + 1, job.at + 3)) audioFor(ahead).catch(() => {})
  // between two pieces the control only shows "loading" again when the next one really is late
  job.slow = setTimeout(() => { if (reading === job) paintSay(job, 'loading') }, 400)
  let url
  try { url = await audioFor(piece) } catch (err) { return failReading(job, err) }
  if (reading !== job) return
  player.onplaying = () => { clearTimeout(job.slow); paintSay(job, 'playing') }
  player.ontimeupdate = () => {
    const part = player.duration > 0 && Number.isFinite(player.duration) ? player.currentTime / player.duration : 0
    job.button?.style.setProperty('--said', ((job.said + piece.text.length * part) / job.total).toFixed(3))
  }
  player.onended = () => { job.said += piece.text.length; job.at++; nextPiece(job) }
  player.onerror = () => failReading(job, new Error('the sound could not be played'))
  player.src = url
  player.play().catch(err => { if (reading === job && err?.name !== 'AbortError') failReading(job, new Error(err?.name === 'NotAllowedError' ? 'the browser wants a click first' : 'the sound could not be played')) })
}

function begin(job) {
  stopReading()
  job.pieces = piecesOf(job.script)
  if (!job.pieces.length) return Promise.resolve()
  player ??= new Audio()
  Object.assign(job, { at: 0, said: 0, total: job.pieces.reduce((n, p) => n + p.text.length, 0) })
  reading = job
  paintSay(job, 'loading')
  if (job.esc) window.addEventListener('keydown', onSayKey, true)
  return new Promise(resolve => { job.resolve = resolve; nextPiece(job) })
}

// ---- what a node on the page is ----

const cardOf = id => getState().all?.cards?.find(c => c.id === id)

// A message, an open question in the log, or the question of the window: its key (which survives
// a redraw), and what to read.
function targetOf(node) {
  const home = node?.closest?.(SPEAKABLE)
  if (!home) return null
  if (home.matches('.msg')) {
    const parts = () => partsOf(home)
    return { home, key: home.dataset.id ? `m:${home.dataset.id}` : `t:${scriptOf(parts()).text}`, parts }
  }
  const id = home.matches('.focus-card') ? home.dataset.id : home.querySelector('[data-id]')?.dataset.id
  const card = id && cardOf(id)
  return card ? { home, key: `card:${id}`, parts: () => partsOfCard(cardOf(id) ?? card) } : null
}

// The next thing to read after this one, in the order of the page.
function following(home) {
  const all = home.matches('.focus-card')
    ? [home, ...home.querySelectorAll('.msg')]
    : [...(home.closest('.log-inner, .focus-thread') ?? home.parentNode).querySelectorAll('.msg, .ask-open, .ask-card')]
  return all.slice(all.indexOf(home) + 1).find(n => n.querySelector('.say')) ?? null
}

/** Read a message or question aloud; if it is the one being read, stop instead. node is the message
 *  (.msg), an open question in the log, the card of the question window, or anything inside one.
 *  following: go on with the ones after it. Resolves when it has been read or was stopped. */
export function readAloud(node, { following: on = false } = {}) {
  const target = targetOf(node)
  if (!target || !getState().speech) return Promise.resolve()
  if (reading?.key === target.key) { stopReading(); return Promise.resolve() }
  return begin({ key: target.key, node: target.home, button: target.home.querySelector('.say'), script: scriptOf(target.parts()), following: on, esc: true })
}

/** Read a card aloud, or stop if it is the one being read. The button, if given,
 *  gets data-speaking="loading" | "playing" while it runs. Resolves when playback ends. */
export function readCard(cardId, button) {
  const key = `card:${cardId}`
  if (reading?.key === key) { stopReading(); return Promise.resolve() }
  const card = cardOf(cardId)
  if (!card) { stopReading(); return Promise.resolve() }
  return begin({ key, node: null, button, plain: true, script: scriptOf(partsOfCard(card)) })
}

// ---- the control beside every message ----

// A speaker in a few uneven pen strokes: the one hand-drawn thing about the control.
const SPEAKER = [
  'M4.300 9.900 L7.400 9.700 Q9.300 7.700 11.500 6.200 Q11.900 12.100 11.600 18.100 Q9.200 16.600 7.300 14.500 L4.200 14.700 Q3.900 12.200 4.300 9.900',
  'M14.700 9.500 Q16.100 12.100 14.800 14.800',
  'M17.400 7.100 Q20.200 11.900 17.500 17.100',
]

function sayButton() {
  const button = el('button', 'say')
  button.type = 'button'
  // progress: a ring that closes as the message is read
  const ring = svgEl('svg', { viewBox: '0 0 32 32', class: 'say-ring', 'aria-hidden': 'true' })
  ring.append(svgEl('circle', { cx: 16, cy: 16, r: 14, pathLength: 1 }))
  const speaker = svgEl('svg', { viewBox: '0 0 24 24', class: 'say-speaker', 'aria-hidden': 'true' })
  for (const d of SPEAKER) speaker.append(svgEl('path', { d }))
  button.append(ring, speaker, el('span', 'say-stop'))
  let held = null, long = false
  button.addEventListener('pointerdown', e => {
    long = false
    if (e.pointerType === 'mouse') return
    held = setTimeout(() => { long = true; readAloud(button, { following: true }) }, 550)
  })
  for (const name of ['pointerup', 'pointerleave', 'pointercancel']) button.addEventListener(name, () => clearTimeout(held))
  button.addEventListener('contextmenu', e => { if (long) e.preventDefault() })
  button.addEventListener('click', e => {
    // the control stands inside rows and titles that are themselves clickable
    e.preventDefault()
    e.stopPropagation()
    if (long) { long = false; return }
    readAloud(button, { following: e.shiftKey })
  })
  return button
}

// Where the control stands in each kind of message. False: nothing to read here.
function place(home, button) {
  if (home.matches('.focus-card')) {
    const title = home.querySelector('.focus-title')
    if (!title) return false
    return title.append(button), true
  }
  if (home.matches('.ask-open, .ask-card')) {
    const head = home.querySelector('.inbox-row-head')
    if (!head) return false
    return head.append(button), true
  }
  if (home.matches('.msg-user')) {
    const bubble = home.querySelector('.bubble')
    if (!bubble) return false
    return bubble.append(button), true
  }
  const head = home.querySelector(':scope > .msg-head')
  if (head) return head.append(button), true
  // a follow-up has no head: the control floats at the end of the first line of its text
  const first = home.querySelector(':scope > .rich > :first-child')
  if (first?.tagName === 'P') { button.classList.add('say-inline'); return first.prepend(button), true }
  button.classList.add('say-row')
  return home.prepend(button), true
}

function dress(home) {
  const target = targetOf(home)
  if (!target || !scriptOf(target.parts()).text) return void (home.dataset.say = 'none')
  const button = sayButton()
  if (!place(home, button)) return void (home.dataset.say = 'none')
  home.dataset.say = ''
  // the message was drawn again while it is being read: the new control carries on
  if (reading && !reading.plain && reading.key === target.key) {
    reading.node = home
    reading.button = button
    paintSay(reading, player.paused ? 'loading' : 'playing')
  } else paintSay({ button }, null)
}

let sweeping = false
function sweep() {
  sweeping = false
  if (!getState().speech) return
  for (const home of document.querySelectorAll('.msg:not([data-say]), .ask-open:not(:has(.say)), .ask-card:not(:has(.say)), .focus-card:not(:has(.focus-title .say))')) dress(home)
}
const sweepSoon = () => { if (!sweeping) { sweeping = true; queueMicrotask(sweep) } }

if (typeof document !== 'undefined') {
  const watch = () => {
    new MutationObserver(sweepSoon).observe(document.body, { childList: true, subtree: true })
    // No speech key on this board: no controls.
    subscribe(state => {
      document.documentElement.classList.toggle('can-speak', Boolean(state.speech))
      if (state.speech) sweepSoon()
      else stopReading()
    })
    document.documentElement.classList.toggle('can-speak', Boolean(getState().speech))
    sweepSoon()
  }
  if (document.body) watch()
  else document.addEventListener('DOMContentLoaded', watch)
}
