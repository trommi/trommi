// Past decisions, below a session's open questions: one plain list, newest first,
// what the agent is still working on before what is done. A line per card; a tap
// unfolds what was asked, what was chosen, and the way to decide again.

import { el, agoNode, URGENCY_LABEL } from './ui.js'
import { reopen } from './store.js'
import { icon, attachmentNodes, richPlus } from './chat.js'

const SHORT = 6   // so many lines stand open to view; the rest wait behind one button

const chosen = card => card.options?.find(o => o.key === card.choice)

function detailNode(card) {
  const box = el('div', 'hist-detail-in')
  if (card.body) box.append(richPlus(card.body))
  box.append(...attachmentNodes(card.attachments))

  const list = el('ul', 'hist-options')
  for (const o of card.options ?? []) {
    const picked = o.key === card.choice
    const li = el('li', picked ? 'is-chosen' : null)
    const mark = el('span', 'hist-mark')
    if (picked) mark.append(icon('check'))
    const text = el('span', 'hist-option')
    text.append(el('b', null, o.label))
    if (o.detail) text.append(el('span', null, o.detail))
    li.append(mark, text)
    list.append(li)
  }
  if (list.children.length) box.append(list)

  const quote = (label, text) => {
    const p = el('p', 'hist-quote')
    p.append(el('span', 'caps', label), el('span', null, text))
    box.append(p)
  }
  if (card.note) quote('Deine Anmerkung', card.note)
  if (card.summary) quote('Ergebnis', card.summary)

  // When it was asked and answered, and the way back: the card returns to the open
  // questions and the agent is told.
  const foot = el('p', 'hist-foot')
  const when = el('span', 'hist-times')
  when.append('Gefragt ', agoNode(card.created))
  if (card.decided) when.append(' · entschieden ', agoNode(card.decided))
  when.append(' · ', card.kind === 'permission' ? 'Freigabe' : URGENCY_LABEL[card.urgency] ?? '')
  foot.append(when)
  if (card.kind === 'decision' && card.choice != null) {
    const again = el('button', 'hist-reopen', 'Neu entscheiden')
    again.type = 'button'
    const fail = el('span', 'hist-reopen-error')
    again.addEventListener('click', async () => {
      again.disabled = true
      try {
        await reopen(card.id)
      } catch (err) {
        again.disabled = false
        fail.textContent = `Nicht zurückgenommen: ${err.message}`
      }
    })
    foot.append(fail, again)
  }
  box.append(foot)
  return box
}

function rowNode(card, expanded, onToggle) {
  const row = el('article', 'hist-row')
  row.dataset.card = card.id
  row.dataset.status = card.status

  const head = el('button', 'hist-head')
  head.type = 'button'
  const pick = el('span', 'hist-pick')
  if (card.choice != null) pick.append(icon('check'))
  pick.append(chosen(card)?.label ?? card.choice ?? 'Ohne Antwort')
  // One line under the title: the answer, then what became of it.
  const sub = el('span', 'hist-sub')
  const outcome = card.status === 'done' ? card.summary || 'erledigt' : 'in Arbeit'
  sub.append(pick, el('span', null, outcome))
  const when = el('span', 'hist-when')
  when.append(agoNode(card.decided ?? card.created), icon('chevron'))
  head.append(el('span', 'hist-nr', `Nr. ${card.number}`), el('span', 'hist-title', card.title), when, sub)

  const detail = el('div', 'hist-detail')
  const clip = el('div', 'hist-detail-clip')
  detail.append(clip)
  const set = open => {
    if (open && !clip.firstChild) clip.append(detailNode(card))   // built on first use
    row.classList.toggle('is-open', open)
    head.setAttribute('aria-expanded', String(open))
    clip.inert = !open
  }
  head.addEventListener('click', () => {
    const open = !row.classList.contains('is-open')
    set(open)
    onToggle(card.id, open)
  })
  set(expanded)
  row.append(head, detail)
  return row
}

/**
 * Render the history into root. Returns
 *   render(state, loaded)
 *   reveal(cardId): unfold that card's line and highlight it; false if the card is not in the history
 */
export function mountHistory(root, { flags = new Set() } = {}) {
  let cards = []
  let lastState = null
  let all = false                 // every line is listed, not only the first few
  const expanded = new Set()
  const rows = new Map()          // card id -> { sig, node }; unchanged cards keep their node

  // The heading is a divider, like the senders' names in the inbox.
  const heading = el('h3', 'hist-heading')
  const count = el('b')
  heading.append(el('span', null, 'Verlauf'), count)
  const list = el('div', 'hist-list')
  const more = el('button', 'hist-more')
  more.type = 'button'
  more.addEventListener('click', () => { all = true; render(lastState, true) })
  root.append(heading, list, more)
  root.hidden = true

  function render(state, loaded) {
    if (!loaded) return
    lastState = state
    cards = state.cards
    // Still in the works first, then what is done; within each the latest answer first.
    const past = cards.filter(c => c.status !== 'open')
      .sort((a, b) => (a.status === 'done') - (b.status === 'done') || (b.decided ?? b.created) - (a.decided ?? a.created))
    root.hidden = !past.length
    const busy = past.filter(c => c.status === 'decided').length
    count.textContent = [busy && `${busy} in Arbeit`, past.length - busy && `${past.length - busy} erledigt`].filter(Boolean).join(' · ')
    const shown = all ? past : past.slice(0, SHORT)
    const nodes = shown.map(card => {
      const sig = JSON.stringify(card)
      const cached = rows.get(card.id)
      if (cached?.sig === sig) return cached.node
      const node = rowNode(card, expanded.has(card.id), (id, on) => on ? expanded.add(id) : expanded.delete(id))
      rows.set(card.id, { sig, node })
      return node
    })
    const keep = new Set(shown.map(c => c.id))
    for (const id of rows.keys()) if (!keep.has(id)) rows.delete(id)
    const same = list.children.length === nodes.length && nodes.every((n, i) => list.children[i] === n)
    if (!same) list.replaceChildren(...nodes)
    more.hidden = shown.length === past.length
    more.textContent = `Alle ${past.length} zeigen`
  }

  function reveal(cardId) {
    const card = cards.find(c => c.id === cardId)
    if (!card || card.status === 'open') return false
    if (!rows.has(cardId)) { all = true; render(lastState, true) }
    const row = rows.get(cardId)?.node
    if (!row) return false
    if (!row.classList.contains('is-open')) row.querySelector('.hist-head').click()
    // Wait for the pane to be laid out before scrolling to the line.
    setTimeout(() => {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' })
      row.classList.remove('is-flash')
      void row.offsetWidth
      row.classList.add('is-flash')
    }, 280)
    return true
  }

  // ---- state for screenshots: #expand unfolds the first line ----
  let staged = false
  function stage() {
    if (staged || !list.firstChild || !flags.has('expand')) return
    staged = true
    list.querySelector('.hist-head')?.click()
  }

  return {
    render(state, loaded) { render(state, loaded); stage() },
    reveal,
  }
}
