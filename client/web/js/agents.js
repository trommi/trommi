// The sidebar: the inbox with every open decision on top, the sessions below.

import { el, doodle, ago } from './ui.js'
import { setScope, star, editSession } from './store.js'

// A stable colour per agent, from the hues that read on both themes.
const HUES = [162, 28, 262, 205, 338, 96, 48, 232]
function hueOf(id) {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return HUES[h % HUES.length]
}

// Every session has its own scribble, so it is recognised before its name is read.
export function avatar(agent) {
  const node = el('span', 'agent-avatar')
  node.append(doodle(agent.mark ?? agent.id))
  node.style.setProperty('--hue', hueOf(agent.id))
  node.dataset.online = String(Boolean(agent.online))
  node.setAttribute('aria-hidden', 'true')
  return node
}

// What one agent needs from the human right now.
function summary(all, agent) {
  const open = all.queue.filter(id => all.cards.find(c => c.id === id)?.agent === agent.id).length
  const tasks = all.tasks.filter(t => t.agent === agent.id)
  // Blocked: something of the agent's is stuck on the human. Running: it has work in progress.
  const mine = all.cards.filter(c => c.agent === agent.id && c.status === 'open')
  const running = agent.online && tasks.some(t => t.state === 'working')
  const blocked = mine.some(c => c.urgency === 'critical' || c.kind === 'permission') || (open > 0 && !running)
  return { open, tasks, running, blocked }
}

// The badge at the end of a session row: a raised hand when the session is
// stopped waiting for the human, the number of questions otherwise, with a
// turning ring while the session is at work.
function badge({ open, running, blocked }) {
  if (!open && !running) return null
  const node = el('span', 'agent-badge')
  if (blocked) {
    node.dataset.state = 'blocked'
    node.title = open === 1 ? 'Wartet auf dich: 1 Frage' : `Wartet auf dich: ${open} Fragen`
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('aria-hidden', 'true')
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    // a raised hand, drawn in one go
    path.setAttribute('d', 'M8.200 12.400V6.300c0-1.700 2.300-1.700 2.300 0v5M10.500 11V4.600c0-1.700 2.400-1.700 2.400 0V11M12.900 11V5.500c0-1.700 2.300-1.600 2.300 0v6.300M15.200 11.800V8.100c0-1.600 2.200-1.600 2.200 0v6.200c0 4-2.300 6.300-5.600 6.300-2.600 0-4-1.200-5.200-3.300l-2.100-3.700c-.8-1.500 1.100-2.600 2.100-1.300l1.600 2.200')
    svg.append(path)
    // Blocked is blocked, however many questions are waiting.
    node.append(svg)
  } else {
    node.dataset.state = running ? 'running' : 'open'
    node.title = running ? (open ? `Arbeitet, ${open} Fragen offen` : 'Arbeitet') : `${open} Fragen offen`
    if (open) node.append(el('b', null, String(open)))
  }
  return node
}

/** The sidebar. onSelect(agentId | null) is called when the user picks an entry. */
export function mountAgents(root, { onSelect }) {
  let signature = ''

  function entry({ id, label, sub, lead, active, mark = null }) {
    const btn = el('button', 'agent-entry')
    btn.type = 'button'
    // While the overview of all sessions is up, nothing in the sidebar is the current place.
    if (active && document.body.dataset.page !== 'roster') btn.setAttribute('aria-current', 'true')
    const text = el('span', 'agent-text')
    text.append(el('strong', null, label))
    if (sub) text.append(el('small', null, sub))
    btn.append(lead, text)
    if (mark) btn.append(mark)
    btn.addEventListener('click', () => {
      delete document.body.dataset.page
      setScope(id)
      onSelect?.(id)
      signature = ''
      render(lastState)
    })
    return btn
  }

  let lastState = null
  function render(state) {
    lastState = state
    const { all, scope } = state
    document.body.dataset.scope = scope ?? 'all'
    const rows = all.agents.map(a => ({ agent: a, ...summary(all, a) }))
    const next = JSON.stringify([scope, document.body.dataset.page, all.queue.length, rows.map(r => [r.agent.id, r.agent.name, r.agent.mark, r.agent.task, r.agent.online, r.open, r.running, r.blocked, r.agent.starred])])
    if (next === signature) return
    signature = next

    const tray = el('span', 'agent-avatar agent-all')
    tray.append(el('i'), el('i'), el('i'))
    const open = all.queue.length
    root.replaceChildren(
      entry({
        id: null, label: 'Posteingang', sub: open ? (open === 1 ? '1 Entscheidung offen' : `${open} Entscheidungen offen`) : 'alles entschieden',
        lead: tray, active: scope == null, mark: open ? el('b', 'agent-count', String(open)) : null,
      }),
      el('h2', 'caps agent-heading', 'Sitzungen'),
      ...rows.map(r => entry({
        id: r.agent.id, label: r.agent.starred ? `★ ${r.agent.name}` : r.agent.name,
        sub: r.agent.online ? r.agent.task || '' : 'getrennt',
        lead: avatar(r.agent), active: scope === r.agent.id, mark: badge(r),
      })),
    )
  }

  return { render }
}

/** The overview page: every session, where it runs, as what, and since when. */
export function mountRoster(root) {
  let signature = ''
  const cell = (term, value) => {
    const box = el('div')
    box.append(el('dt', null, term), el('dd', null, value || 'unbekannt'))
    if (!value) box.classList.add('is-unknown')
    return box
  }
  function render(state) {
    const { all } = state
    const next = JSON.stringify([all.agents, all.queue.length])
    if (next === signature) return
    signature = next
    const online = all.agents.filter(a => a.online).length
    const head = el('header', 'roster-head')
    head.append(el('h2', null, 'Agenten'), el('p', null, `${online} von ${all.agents.length} Sitzungen sind verbunden.`))
    const list = el('div', 'roster-list')
    for (const agent of all.agents) {
      const { open } = summary(all, agent)
      const card = el('article', 'roster-card')
      card.dataset.online = String(Boolean(agent.online))
      const top = el('header')
      const name = el('div', 'roster-name')
      name.append(el('strong', null, agent.name), el('span', null, agent.task || 'kein Auftrag genannt'))
      const state = el('span', 'roster-state', agent.online ? 'verbunden' : `getrennt, zuletzt ${ago(agent.seen ?? agent.joined ?? Date.now())}`)
      const vip = el('button', 'roster-star', agent.starred ? '★' : '☆')
      vip.type = 'button'
      vip.setAttribute('aria-pressed', String(Boolean(agent.starred)))
      vip.setAttribute('aria-label', agent.starred ? 'VIP-Markierung entfernen' : 'Als VIP markieren')
      vip.addEventListener('click', () => star(agent.id, !agent.starred).catch(() => {}))
      // Tap the mark to rename the session or pick another scribble.
      const mark = avatar(agent)
      const edit = el('button', 'roster-edit')
      edit.type = 'button'
      edit.setAttribute('aria-label', `${agent.name}: Name und Symbol ändern`)
      edit.append(mark)
      edit.addEventListener('click', () => openEditor(agent))
      const change = el('button', 'roster-change', 'Ändern')
      change.type = 'button'
      change.addEventListener('click', () => openEditor(agent))
      top.append(edit, name, state, change, vip)
      const facts = el('dl', 'roster-facts')
      facts.append(
        cell('Modell', agent.model),
        cell('Rechner', [agent.host, agent.platform].filter(Boolean).join(' · ')),
        cell('Ordner', agent.cwd),
        cell('Programm', agent.client),
        cell('Offene Fragen', String(open)),
        cell('Verbunden seit', agent.online && agent.connected ? ago(agent.connected) : ''),
      )
      const lines = summary(all, agent).tasks
      if (lines.length) {
        const lights = el('div', 'roster-tasks')
        for (const t of lines) {
          const pill = el('span', 'roster-task', t.detail ? `${t.label}: ${t.detail}` : t.label)
          pill.dataset.state = t.state
          lights.append(pill)
        }
        card.append(top, lights, facts)
      } else card.append(top, facts)
      list.append(card)
    }
    root.replaceChildren(head, list)
  }
  return { render }
}

// ---- rename a session, pick its scribble -------------------------------------

let editor = null
function openEditor(agent) {
  editor?.remove()
  const dialog = editor = el('dialog', 'session-editor')
  const form = el('form')
  form.method = 'dialog'
  const name = el('input')
  name.type = 'text'
  name.id = 'session-name'
  name.value = agent.name
  name.maxLength = 60
  name.setAttribute('aria-label', 'Name der Sitzung')
  let picked = agent.mark
  const grid = el('div', 'session-marks')
  grid.setAttribute('role', 'radiogroup')
  grid.setAttribute('aria-label', 'Symbol')
  // The current mark first, then a handful of fresh scribbles from the same family.
  const seeds = [agent.mark, ...Array.from({ length: 11 }, (_, i) => `${agent.id}:${i + 1}`)].filter((s, i, all) => all.indexOf(s) === i)
  for (const seed of seeds) {
    const b = el('button', 'session-mark')
    b.type = 'button'
    b.setAttribute('role', 'radio')
    b.setAttribute('aria-checked', String(seed === picked))
    b.append(doodle(seed))
    b.addEventListener('click', () => {
      picked = seed
      for (const other of grid.children) other.setAttribute('aria-checked', String(other === b))
    })
    grid.append(b)
  }
  const error = el('p', 'session-error')
  const row = el('div', 'session-buttons')
  const cancel = el('button', null, 'Abbrechen')
  cancel.type = 'button'
  cancel.addEventListener('click', () => dialog.close())
  const save = el('button', 'is-lead', 'Speichern')
  save.type = 'submit'
  row.append(cancel, save)
  form.append(el('h2', null, 'Sitzung anpassen'), el('label', 'caps', 'Name'), name, el('span', 'caps', 'Symbol'), grid, error, row)
  form.addEventListener('submit', async e => {
    e.preventDefault()
    save.disabled = true
    try {
      // An emptied name falls back to the one the session gave itself.
      await editSession(agent.id, { label: name.value.trim() === agent.given ? '' : name.value.trim(), icon: picked === agent.id ? '' : picked })
      dialog.close()
    } catch (err) {
      save.disabled = false
      error.textContent = `Nicht gespeichert: ${err.message}`
    }
  })
  dialog.append(form)
  dialog.addEventListener('close', () => dialog.remove())
  document.body.append(dialog)
  dialog.showModal()
  name.select()
}
