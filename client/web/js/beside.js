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
  const card = group.querySelector(`.inbox-row[data-id="${CSS.escape(ref.dataset.id)}"]`)
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
