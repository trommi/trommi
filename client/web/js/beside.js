// A session on a wide window: its open questions lie beside its conversation (css/beside.css).
// The layout is CSS over what js/chat.js already builds. This file adds the little that CSS cannot:
//   - the line under a session's name: what it is at, its model and machine
//   - "Questions only" has nothing to do while the questions stand beside the conversation: asked for
//     by an old link, a key or a line in the conversation, it is taken back at once, in place
//   - an open question inside the conversation is a small reference: a click brings its card into
//     view in the column beside, it does not open anything
// Below 1200px none of it applies.

import { subscribe } from './store.js'
import { el } from './ui.js'

const body = document.body
const $ = id => document.getElementById(id)
const wide = matchMedia('(min-width: 1200px)')

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
  if (!wide.matches || body.dataset.filter !== 'questions') return
  delete body.dataset.filter
  $('filter-questions')?.setAttribute('aria-pressed', 'false')
  if (/\/questions$/.test(location.pathname)) history.replaceState(history.state, '', location.pathname.replace(/\/questions$/, '') + location.search + location.hash)
}
noFilter()
new MutationObserver(noFilter).observe(body, { attributes: true, attributeFilter: ['data-filter'] })
wide.addEventListener('change', noFilter)

// ---- a question named in the conversation: bring its card into view beside ----
$('chat')?.addEventListener('click', e => {
  if (!wide.matches) return
  const ref = e.target.closest?.('.log .ask-open .inbox-row')
  if (!ref) return
  e.preventDefault()
  e.stopPropagation()
  const card = ref.closest('.chat-pane')?.querySelector(`.pane-questions .inbox-row[data-id="${CSS.escape(ref.dataset.id)}"]`)
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
