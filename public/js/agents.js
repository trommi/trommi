// The sidebar: the inbox with every open decision on top, the sessions below.

import { el, doodle, ago } from './ui.js'
import { setScope, star } from './store.js'

const STATE_RANK = { decision: 0, working: 1, done: 2 }
const STATE_WORD = { decision: 'wartet auf dich', working: 'arbeitet', done: 'fertig' }

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
  node.append(doodle(agent.id))
  node.style.setProperty('--hue', hueOf(agent.id))
  node.dataset.online = String(Boolean(agent.online))
  node.setAttribute('aria-hidden', 'true')
  return node
}

// What one agent needs from the human right now.
function summary(all, agent) {
  const open = all.queue.filter(id => all.cards.find(c => c.id === id)?.agent === agent.id).length
  const tasks = all.tasks.filter(t => t.agent === agent.id)
  const light = open ? 'decision' : tasks.map(t => t.state).sort((a, b) => STATE_RANK[a] - STATE_RANK[b])[0] ?? null
  const last = all.messages.findLast(m => m.agent === agent.id && m.from === 'agent')
  return { open, tasks, light, last }
}

/** The sidebar. onSelect(agentId | null) is called when the user picks an entry. */
export function mountAgents(root, { onSelect }) {
  let signature = ''

  function entry({ id, label, sub, open, light, lead, active, page = null }) {
    const btn = el('button', 'agent-entry')
    btn.type = 'button'
    if (active && document.body.dataset.page !== 'roster' || page && document.body.dataset.page === page) btn.setAttribute('aria-current', 'true')
    const text = el('span', 'agent-text')
    text.append(el('strong', null, label), el('small', null, sub))
    btn.append(lead, text)
    if (light) {
      const dot = el('i', 'agent-light')
      dot.dataset.state = light
      btn.append(dot)
    }
    if (open) btn.append(el('b', 'agent-count', String(open)))
    btn.addEventListener('click', () => {
      // The overview is a page of its own; everything else is the inbox or a session.
      if (page) document.body.dataset.page = page
      else { delete document.body.dataset.page; setScope(id); onSelect?.(id) }
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
    const next = JSON.stringify([scope, all.queue.length, rows.map(r => [r.agent.id, r.agent.name, r.agent.online, r.open, r.light, r.agent.starred])])
    if (next === signature) return
    signature = next

    const tray = el('span', 'agent-avatar agent-all')
    tray.append(el('i'), el('i'), el('i'))
    const open = all.queue.length
    root.replaceChildren(
      entry({
        id: null, label: 'Posteingang', sub: open ? (open === 1 ? '1 Entscheidung offen' : `${open} Entscheidungen offen`) : 'alles entschieden',
        open, light: null, lead: tray, active: scope == null,
      }),
      el('h2', 'caps agent-heading', 'Sitzungen'),
      ...rows.map(r => entry({
        id: r.agent.id, label: r.agent.starred ? `★ ${r.agent.name}` : r.agent.name,
        sub: r.agent.online ? (r.light ? STATE_WORD[r.light] : 'verbunden') : 'getrennt',
        open: r.open, light: r.open ? null : r.light, lead: avatar(r.agent), active: scope === r.agent.id,
      })),
      entry({
        id: null, page: 'roster', label: 'Übersicht', sub: `${all.agents.filter(a => a.online).length} von ${all.agents.length} verbunden`,
        open: 0, light: null, lead: el('span', 'agent-avatar agent-roster', '≡'), active: false,
      }),
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
      top.append(avatar(agent), name, state, vip)
      const facts = el('dl', 'roster-facts')
      facts.append(
        cell('Modell', agent.model),
        cell('Rechner', [agent.host, agent.platform].filter(Boolean).join(' · ')),
        cell('Ordner', agent.cwd),
        cell('Programm', agent.client),
        cell('Offene Fragen', String(open)),
        cell('Verbunden seit', agent.online && agent.connected ? ago(agent.connected) : ''),
      )
      card.append(top, facts)
      list.append(card)
    }
    root.replaceChildren(head, list)
  }
  return { render }
}
