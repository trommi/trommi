// Past decisions, as a sheet that rests under the card stack and rises over it.
// Two groups: "In Arbeit" (status decided) and "Erledigt" (status done). One
// group is open as a list, the other waits beside it as a slim vertical rail.

import { el, agoNode, URGENCY_LABEL } from './ui.js'
import { reopen } from './store.js'
import { icon, attachmentNodes, richPlus } from './chat.js'

const GROUPS = [
  { key: 'decided', name: 'In Arbeit', lead: 'Entschieden, der Agent setzt es um', none: 'Gerade ist nichts in Arbeit.' },
  { key: 'done', name: 'Erledigt', lead: 'Abgeschlossen, mit Ergebnis', none: 'Noch nichts erledigt.' },
]

function button(cls) {
  const node = el('button', cls)
  node.type = 'button'
  return node
}

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
    if (picked) li.append(el('span', 'hist-picked', 'Gewählt'))
    list.append(li)
  }
  if (list.children.length) box.append(list)

  if (card.note) {
    const note = el('p', 'hist-quote')
    note.append(el('span', 'caps', 'Deine Anmerkung'), el('span', null, card.note))
    box.append(note)
  }
  if (card.summary) {
    const sum = el('p', 'hist-quote hist-result')
    sum.append(el('span', 'caps', 'Ergebnis'), el('span', null, card.summary))
    box.append(sum)
  }

  // A mistake is fixed here: the card goes back on the stack and the agent is told.
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
    const row = el('p', 'hist-reopen-row')
    row.append(again, fail)
    box.append(row)
  }

  const meta = el('dl', 'hist-meta')
  const cell = (term, value) => {
    const c = el('div')
    const dd = el('dd')
    dd.append(value)
    c.append(el('dt', null, term), dd)
    meta.append(c)
  }
  cell('Gefragt', agoNode(card.created))
  if (card.decided) cell('Entschieden', agoNode(card.decided))
  if (card.kind === 'permission') cell('Art', 'Freigabe')
  else if (URGENCY_LABEL[card.urgency]) cell('Dringlichkeit', URGENCY_LABEL[card.urgency])
  box.append(meta)
  return box
}

function rowNode(card, expanded, onToggle) {
  const row = el('article', 'hist-row')
  row.dataset.card = card.id
  row.dataset.status = card.status

  const head = button('hist-head')
  const tab = el('span', 'hist-tab')
  const pick = el('span', 'hist-tab-pick')
  if (card.choice != null) pick.append(icon('check'))
  pick.append(el('span', null, chosen(card)?.label ?? card.choice ?? 'Ohne Antwort'))
  tab.append(el('b', null, `Nr. ${card.number}`), pick)
  const when = el('span', 'hist-when')
  when.append(agoNode(card.decided ?? card.created), icon('chevron'))
  const sub = card.status === 'done'
    ? card.summary || 'Abgeschlossen'
    : card.note ? `„${card.note}“` : 'Der Agent arbeitet daran.'
  head.append(tab, when, el('span', 'hist-title', card.title), el('span', 'hist-sub', sub))

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
 *   reveal(cardId): open the sheet on that card and highlight it; false if the card is not in the history
 */
export function mountHistory(root, { flags = new Set(), onToggle } = {}) {
  let open = false
  let active = null               // group key shown as a list; null until there is data to choose from
  let cards = []
  const expanded = new Set()
  const rows = new Map()          // card id -> { sig, node }; unchanged cards keep their node

  const scrim = el('div', 'hist-scrim')
  const sheet = el('div', 'hist-sheet')
  const bar = el('div', 'hist-bar')
  const label = el('span', 'hist-label')
  label.append(icon('history'), el('span', null, 'Verlauf'))
  const tabs = el('div', 'hist-tabs')
  tabs.setAttribute('role', 'tablist')
  const toggle = button('hist-toggle')
  toggle.append(icon('chevron'))
  const body = el('div', 'hist-body')
  body.id = 'history-body'
  toggle.setAttribute('aria-controls', body.id)
  const panes = el('div', 'hist-panes')
  body.append(panes)

  const parts = {}
  for (const g of GROUPS) {
    const tab = button('hist-group-tab')
    tab.dataset.group = g.key
    tab.setAttribute('role', 'tab')
    const count = el('b', null, '·')
    tab.append(count, el('span', null, g.name))
    tab.addEventListener('click', e => {
      e.stopPropagation()
      if (open && active === g.key) return setOpen(false)
      active = g.key
      setOpen(true)
    })
    tabs.append(tab)

    const rail = button('hist-rail')
    rail.dataset.group = g.key
    const railCount = el('b', null, '0')
    rail.append(railCount, el('span', null, g.name))
    rail.addEventListener('click', () => { active = g.key; paint() })

    const pane = el('div', 'hist-pane')
    pane.dataset.group = g.key
    pane.setAttribute('role', 'tabpanel')
    pane.setAttribute('aria-label', g.name)
    const lead = el('p', 'hist-lead', g.lead)
    const list = el('div', 'hist-list')
    pane.append(lead, list)
    parts[g.key] = { tab, count, rail, railCount, pane, list, lead }
  }
  // Left to right like a board: In Arbeit, then Erledigt. The inactive one is a rail.
  panes.append(parts.decided.rail, parts.decided.pane, parts.done.pane, parts.done.rail)
  bar.append(label, tabs, toggle)
  sheet.append(bar, body)
  root.append(scrim, sheet)

  function paint() {
    if (root.dataset.open !== String(open)) onToggle?.(open)
    root.dataset.open = String(open)
    body.inert = !open
    toggle.setAttribute('aria-expanded', String(open))
    toggle.setAttribute('aria-label', open ? 'Verlauf schließen' : 'Verlauf öffnen')
    const shown = active ?? 'decided'
    for (const g of GROUPS) {
      const p = parts[g.key]
      const on = g.key === shown
      p.tab.setAttribute('aria-selected', String(open && on))
      p.pane.hidden = !on
      p.rail.hidden = on
      p.rail.setAttribute('aria-label', `${g.name} zeigen, ${p.railCount.textContent} Einträge`)
    }
  }
  function setOpen(value) {
    open = value
    paint()
  }
  toggle.addEventListener('click', e => { e.stopPropagation(); setOpen(!open) })
  bar.addEventListener('click', () => setOpen(!open))
  scrim.addEventListener('click', () => setOpen(false))
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && open && !document.querySelector('dialog[open]')) setOpen(false)
  })

  function render(state, loaded) {
    if (!loaded) return paint()
    cards = state.cards
    const seen = new Set()
    for (const g of GROUPS) {
      const p = parts[g.key]
      const list = cards.filter(c => c.status === g.key).sort((a, b) => (b.decided ?? b.created) - (a.decided ?? a.created))
      p.count.textContent = list.length
      p.railCount.textContent = list.length
      p.tab.classList.toggle('is-zero', list.length === 0)
      p.rail.classList.toggle('is-zero', list.length === 0)
      const nodes = list.map(card => {
        seen.add(card.id)
        const sig = JSON.stringify(card)
        const cached = rows.get(card.id)
        if (cached?.sig === sig) return cached.node
        const node = rowNode(card, expanded.has(card.id), (id, on) => on ? expanded.add(id) : expanded.delete(id))
        rows.set(card.id, { sig, node })
        return node
      })
      if (!nodes.length) {
        const none = el('div', 'hist-none')
        none.append(icon(g.key === 'done' ? 'done' : 'spark'), el('p', null, g.none))
        if (!cards.some(c => c.status !== 'open')) none.append(el('p', 'hist-none-more', 'Sobald du eine Karte beantwortest, erscheint sie hier.'))
        nodes.push(none)
      }
      p.lead.hidden = list.length === 0
      const same = p.list.children.length === nodes.length && nodes.every((n, i) => p.list.children[i] === n)
      if (!same) p.list.replaceChildren(...nodes)
    }
    for (const id of rows.keys()) if (!seen.has(id)) rows.delete(id)
    // First data: show the group that has something in it, work in progress first.
    if (active == null) active = cards.some(c => c.status === 'decided') || !cards.some(c => c.status === 'done') ? 'decided' : 'done'
    paint()
  }

  function reveal(cardId) {
    const card = cards.find(c => c.id === cardId)
    const entry = rows.get(cardId)
    if (!card || !entry || card.status === 'open') return false
    active = card.status
    setOpen(true)
    const row = entry.node
    if (!row.classList.contains('is-open')) row.querySelector('.hist-head').click()
    // Wait for the sheet to be laid out at its open size before scrolling inside it.
    setTimeout(() => {
      row.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      row.classList.remove('is-flash')
      void row.offsetWidth
      row.classList.add('is-flash')
    }, 280)
    return true
  }

  // ---- states for screenshots ----
  let staged = false
  function stage() {
    if (staged || !cards.length) return
    staged = true
    if (flags.has('history-done')) active = 'done'
    if (flags.has('history') || flags.has('history-done') || flags.has('expand')) setOpen(true)
    if (flags.has('expand')) parts[active].list.querySelector('.hist-head')?.click()
  }

  paint()
  return {
    render(state, loaded) { render(state, loaded); stage() },
    reveal,
    close: () => setOpen(false),
  }
}
