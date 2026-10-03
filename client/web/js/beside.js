// The line under a session's name, and the view of sessions laid together (css/beside.css).
//   - the line under a session's name: what it is at, its model and machine
//   - sessions laid together: ONE list of the questions of all of them (each row names its session
//     with its mark), in a wide column; the conversations stand narrow beside it, one above the other
//     (below 1200px: the list above the conversations). It is the inbox's own list (mountInbox) shown
//     a state cut down to the group's sessions.
//   - there, "Questions only" has nothing to do and is taken back in place, and an open question
//     inside a conversation is a small reference: a click brings its card into view in the list.
// A single session is one stream (js/chat.js); nothing here changes it but the line under its name.

import { subscribe, getState, reopen } from './store.js'
import { el } from './ui.js'
import { mountInbox } from './inbox.js'
import { say, pageHost } from './back.js'
import { walkSession } from './app.js'

const body = document.body
const $ = id => document.getElementById(id)

// ---- the line under the name ----
const now = el('p', 'pane-now')
$('pane-who')?.after(now)
let signature = ''
subscribe(state => {
  const members = state.members.map(id => state.all.agents.find(a => a.id === id)).filter(Boolean)
  const a = members.length === 1 ? members[0] : null
  const words = a ? (a.online ? a.task || 'connected' : 'disconnected') : ''
  const facts = a ? [a.model, a.host].filter(Boolean).join(' · ') : ''
  const next = `${words}\n${facts}`
  if (next === signature) return
  signature = next
  now.replaceChildren(...(words ? [el('span', null, words)] : []), ...(facts ? [el('span', 'caps', facts)] : []))
})

// ---- no "Questions only" while the questions are in sight anyway ----
function noFilter() {
  if (!body.hasAttribute('data-pair') || body.dataset.filter !== 'questions') return
  delete body.dataset.filter
  $('filter-questions')?.setAttribute('aria-pressed', 'false')
  if (/\/questions$/.test(location.pathname)) history.replaceState(history.state, '', location.pathname.replace(/\/questions$/, '') + location.search + location.hash)
}
noFilter()
new MutationObserver(noFilter).observe(body, { attributes: true, attributeFilter: ['data-filter', 'data-pair'] })

// ---- sessions laid together: one list of all their questions ----
const group = el('section', 'group-questions')
group.setAttribute('aria-label', 'Questions of the sessions laid together')
const groupList = el('div', 'session-cards group-list')
group.append(groupList)
$('chat')?.before(group)
// On a phone the list is folded to one line above the conversation ("5 questions"); a tap opens it as
// the whole view, and the same line leads back to the conversation.
const bar = el('button', 'group-bar')
bar.type = 'button'
const barWords = el('span'), barWay = el('b')
bar.append(barWords, barWay)
group.before(bar)
const paintBar = n => {
  const open = body.hasAttribute('data-joined-list')
  bar.hidden = !n && !open
  bar.setAttribute('aria-expanded', String(open))
  barWords.textContent = n === 1 ? '1 question waits for you' : `${n} questions wait for you`
  barWay.textContent = open ? 'Conversation' : 'Show'
}
let waiting = 0
bar.addEventListener('click', () => { body.toggleAttribute('data-joined-list'); paintBar(waiting) })
/** One question as a window of its own (null: go through them): by its address, which the page follows. */
function openQuestion(cardId) {
  const params = new URLSearchParams(location.search)
  params.set('q', cardId == null ? 'next' : String(getState().all.cards.find(c => c.id === cardId)?.number ?? cardId))
  history.pushState({ q: cardId ?? 'next' }, '', `${location.pathname}?${params}${location.hash}`)
  window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
}
const together = mountInbox(groupList, {
  // One question: its window. The walk ("Go through them"): only what this group asked (app.js walkSession follows the scope).
  onOpen: cardId => (cardId == null ? walkSession(getState().scope) : openQuestion(cardId)),
  onDecided: (card, option) => say(pageHost(), { head: `Answered: ${option.label}`, title: card.title, back: () => reopen(card.id) }),
})
subscribe(state => {
  if (state.members.length < 2) { body.removeAttribute('data-joined-list'); return }
  // The inbox's list, shown only what the group's sessions asked.
  const mine = new Set(state.members)
  const cards = state.all.cards.filter(c => mine.has(c.agent))
  const ids = new Set(cards.map(c => c.id))
  const queue = state.all.queue.filter(id => ids.has(id))
  together.render({ ...state, all: { ...state.all, cards, queue } })
  waiting = queue.filter(id => !state.later.includes(id)).length
  if (!waiting) body.removeAttribute('data-joined-list')
  paintBar(waiting)
})

// ---- a question named in the conversation: bring its card into view beside ----
$('chat')?.addEventListener('click', e => {
  if (!body.hasAttribute('data-pair')) return
  const ref = e.target.closest?.('.log .ask-open .inbox-row')
  if (!ref) return
  e.preventDefault()
  e.stopPropagation()
  if (!body.hasAttribute('data-joined-list') && bar.getClientRects().length) { body.setAttribute('data-joined-list', ''); paintBar(waiting) }
  const card = group.querySelector(`:is(.inbox-row, .inbox-done)[data-id="${CSS.escape(ref.dataset.id)}"]`)   // on the desk, or a line on a pile at the foot
  if (!card) return
  // One that was snoozed lies in a pile that may be pushed together: open it first.
  const pile = card.closest('.inbox-pile:not(.is-open)')
  pile?.querySelector('.inbox-pile-head')?.click()
  requestAnimationFrame(() => {
    card.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
    card.classList.add('is-pointed')
    setTimeout(() => card.classList.remove('is-pointed'), 1400)
  })
}, true)

// ---- sessions laid together, wide window: the conversations' column can be dragged narrower and folded ----
// An edge on the column's left: drag it (a double click gives the column its own width back); dragged past
// its narrowest it folds to a strip at the right edge, and the strip opens it again. Both are kept in this
// browser (localStorage). Below 1200px the conversations stand under the list, and none of this shows.
const TALK = 'trommi-talk'
const MIN_TALK = 300, MIN_LIST = 440, FOLD_BELOW = 220
let talk = {}
try { talk = JSON.parse(localStorage.getItem(TALK) ?? '{}') ?? {} } catch {}
const keepTalk = () => { try { localStorage.setItem(TALK, JSON.stringify(talk)) } catch {} }
const applyTalk = () => {
  if (talk.w) body.style.setProperty('--talk-w', `${talk.w}px`)
  else body.style.removeProperty('--talk-w')
  body.toggleAttribute('data-talk-folded', Boolean(talk.folded))
  fold.setAttribute('aria-expanded', String(!talk.folded))
  strip.setAttribute('aria-expanded', String(!talk.folded))
}
const session = $('session')
const edge = el('div', 'talk-edge')
edge.setAttribute('role', 'separator')
edge.setAttribute('aria-orientation', 'vertical')
edge.setAttribute('aria-label', 'Drag to make the conversations wider or narrower')
edge.title = 'Drag: wider or narrower. Double click: as it was'
const fold = el('button', 'talk-fold')
fold.type = 'button'
fold.title = 'Fold the conversations away'
fold.setAttribute('aria-label', fold.title)
fold.append(el('span', null, '→'))
const strip = el('button', 'talk-strip')
strip.type = 'button'
strip.title = 'Open the conversations'
strip.setAttribute('aria-label', strip.title)
const stripWords = el('span', 'talk-strip-words', 'Conversations')
strip.append(el('b', null, '←'), stripWords)
session?.append(edge, fold, strip)
applyTalk()

edge.addEventListener('dblclick', () => { talk = {}; keepTalk(); applyTalk() })
edge.addEventListener('pointerdown', e => {
  if (e.button !== 0) return
  e.preventDefault()
  edge.setPointerCapture(e.pointerId)
  body.setAttribute('data-talk-drag', '')
  const box = session.getBoundingClientRect()
  let w = talk.w
  const move = ev => {
    const want = box.right - ev.clientX
    w = Math.round(Math.max(MIN_TALK, Math.min(want, box.width - MIN_LIST)))
    // Pulled past the narrowest: it will fold when let go (shown at its narrowest until then).
    edge.toggleAttribute('data-will-fold', want < FOLD_BELOW)
    body.style.setProperty('--talk-w', `${w}px`)
  }
  const up = ev => {
    edge.removeEventListener('pointermove', move)
    edge.removeEventListener('pointerup', up)
    edge.removeEventListener('pointercancel', up)
    body.removeAttribute('data-talk-drag')
    const folding = edge.hasAttribute('data-will-fold') && ev.type === 'pointerup'
    edge.removeAttribute('data-will-fold')
    talk = folding ? { w: talk.w, folded: true } : { w }
    keepTalk()
    applyTalk()
  }
  edge.addEventListener('pointermove', move)
  edge.addEventListener('pointerup', up)
  edge.addEventListener('pointercancel', up)
})
fold.addEventListener('click', () => { talk = { ...talk, folded: true }; keepTalk(); applyTalk(); strip.focus({ preventScroll: true }) })
strip.addEventListener('click', () => { talk = { ...talk, folded: false }; keepTalk(); applyTalk(); fold.focus({ preventScroll: true }) })
// The strip names who is folded away.
subscribe(state => {
  const names = state.members.map(id => state.all.agents.find(a => a.id === id)?.name).filter(Boolean).join(' + ')
  if (stripWords.textContent !== (names || 'Conversations')) stripWords.textContent = names || 'Conversations'
})
