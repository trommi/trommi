// The sidebar (the inbox on top, the sessions below, sessions dropped on each other
// become one) and the overview page of all sessions.

import { el, doodle, pairDoodle, sketch, ago } from './ui.js'
import { setScope, star, editSession, pair, unpair, archive } from './store.js'

const NS = 'http://www.w3.org/2000/svg'

// A stable colour per session, from the hues that read on both themes.
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
  if (!agent.online) node.classList.add('is-offline')
  node.setAttribute('aria-hidden', 'true')
  return node
}

/** Sessions laid together: their scribbles over each other inside one loop drawn by hand. */
export function pairAvatar(members) {
  const node = el('span', 'agent-pair')
  node.append(pairDoodle(members.map(a => ({ id: a.id, mark: a.mark, hue: hueOf(a.id) }))))
  if (!members.some(a => a.online)) node.classList.add('is-offline')
  node.setAttribute('aria-hidden', 'true')
  return node
}

export const pairName = members => members.map(a => a.name).join(' + ')

// What a session, or several together, need from the human right now.
function summary(all, members) {
  const ids = new Set(members.map(a => a.id))
  const mine = all.cards.filter(c => ids.has(c.agent) && c.status === 'open' && all.queue.includes(c.id))
  const open = mine.length
  const tasks = all.tasks.filter(t => ids.has(t.agent))
  const online = members.some(a => a.online)
  // Running: it has work in progress. Stuck: something of it cannot go on without the human.
  const running = members.some(a => a.online && tasks.some(t => t.agent === a.id && t.state === 'working'))
  const stuck = mine.some(c => c.urgency === 'critical' || c.kind === 'permission')
  return { open, tasks, online, running, stuck }
}

// At work: one thin ring, and a swelling that travels through it like a drop through a tube.
// The swelling is a filled shape that is as thin as the ring at both ends and three times
// as thick in its middle, so it has no ends to see.
const RING_R = 11.2, RING_W = 1.5
function ring() {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 28 28')
  svg.setAttribute('class', 'agent-ring')
  svg.setAttribute('aria-hidden', 'true')
  const circle = document.createElementNS(NS, 'circle')
  circle.setAttribute('cx', '14')
  circle.setAttribute('cy', '14')
  circle.setAttribute('r', String(RING_R))
  circle.setAttribute('stroke-width', String(RING_W))
  const span = Math.PI * .62, steps = 28
  const edge = side => Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps, a = -Math.PI / 2 + (t - .5) * span
    const half = RING_W / 2 + RING_W * Math.sin(Math.PI * t) ** 2
    const rad = RING_R + side * half
    return `${(14 + Math.cos(a) * rad).toFixed(2)} ${(14 + Math.sin(a) * rad).toFixed(2)}`
  })
  const drop = document.createElementNS(NS, 'path')
  drop.setAttribute('d', `M${edge(1).join(' L')} L${edge(-1).reverse().join(' L')} Z`)
  svg.append(circle, drop)
  return svg
}

// The badge at the end of a session row carries its state: a calm ring with the number of
// questions while it works, a raised hand when it is stopped waiting for the human, and the
// same hand or number in grey when the session is disconnected.
function badge({ open, online, running, stuck }) {
  if (!open && !(online && running)) return null
  const node = el('span', 'agent-badge')
  const questions = open === 1 ? '1 question' : `${open} questions`
  const hand = online ? stuck || !running : stuck
  if (hand) {
    node.dataset.state = 'waiting'
    node.title = online ? `Waiting for you: ${questions}` : `Disconnected, was waiting for you: ${questions}`
    node.append(sketch('hand'))
  } else {
    node.dataset.state = online ? 'running' : 'open'
    node.title = online ? (open ? `Working, ${questions} open` : 'Working') : `Disconnected, ${questions} open`
    if (online) node.append(ring())
    if (open) node.append(el('b', null, String(open)))
  }
  if (!online) node.dataset.offline = ''
  return node
}

// Sessions that share a name get a second line that tells them apart: the folder, else the
// machine, else since when they are connected. Returns a Map of session id to that line.
function tellApart(agents) {
  const lines = new Map()
  const byName = new Map()
  for (const a of agents) byName.set(a.name, [...(byName.get(a.name) ?? []), a])
  const folder = a => (a.cwd ? a.cwd.split('/').filter(Boolean).slice(-2).join('/') : '')
  const since = a => {
    const ts = a.online ? a.connected ?? a.joined : a.seen ?? a.joined
    return ts ? `${a.online ? 'since' : 'last seen'} ${new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : ''
  }
  for (const twins of byName.values()) {
    if (twins.length < 2) continue
    const differs = fn => new Set(twins.map(fn)).size === twins.length && twins.every(a => fn(a))
    const pick = [folder, a => a.host ?? '', since].find(differs) ?? (a => a.id)
    for (const a of twins) lines.set(a.id, pick(a))
  }
  return lines
}

/** The sidebar. onSelect(id | null) is called when the user picks the inbox (null), a session or a group. */
export function mountAgents(root, { onSelect }) {
  let signature = ''
  let lastState = null

  function entry({ id, label, sub, lead, active, mark = null, tip = '' }) {
    const btn = el('button', 'agent-entry')
    btn.type = 'button'
    // While the overview of all sessions is up, nothing in the sidebar is the current place.
    if (active && document.body.dataset.page !== 'roster') btn.setAttribute('aria-current', 'true')
    if (tip) btn.title = tip
    const text = el('span', 'agent-text')
    text.append(el('strong', null, label))
    if (sub) text.append(el('small', null, sub))
    btn.append(lead, text)
    if (mark) btn.append(mark)
    btn.addEventListener('click', () => {
      setScope(id)
      onSelect?.(id)
      signature = ''
      render(lastState)
    })
    const row = el('div', 'agent-row')
    row.append(btn)
    return row
  }

  function render(state) {
    lastState = state
    const { all, scope } = state
    document.body.dataset.scope = scope ?? 'all'
    // One row per session, or per group of sessions laid together, in the server's order.
    const units = []
    for (const a of all.agents) {
      const group = a.group && all.groups.find(g => g.id === a.group)
      if (!group) units.push({ id: a.id, members: [a] })
      else if (!units.some(u => u.id === group.id)) units.push({ id: group.id, members: group.members })
    }
    for (const u of units) Object.assign(u, summary(all, u.members))
    const fresh = all.queue.filter(id => !state.later.includes(id)).length
    const next = JSON.stringify([scope, document.body.dataset.page, fresh, units.map(u => [u.id, u.members.map(a => [a.id, a.name, a.mark, a.task, a.online, a.starred, a.cwd, a.host]), u.open, u.running, u.stuck])])
    if (next === signature) return
    signature = next

    const apart = tellApart(all.agents)
    const unitRow = u => {
      const single = u.members.length === 1 ? u.members[0] : null
      const row = entry({
        id: u.id,
        label: single ? single.name : pairName(u.members),
        sub: single ? apart.get(single.id) : '',
        lead: single ? avatar(single) : pairAvatar(u.members),
        active: scope === u.id,
        mark: badge(u),
        tip: u.members.map(a => a.task).filter(Boolean).join(' · '),
      })
      row.dataset.unit = u.id
      row.dataset.members = u.members.map(a => a.id).join(' ')
      if (!u.online) {
        row.classList.add('is-offline')
        const away = el('button', 'agent-archive')
        away.type = 'button'
        away.title = 'Archive: put this session away'
        away.setAttribute('aria-label', `Archive ${single ? single.name : pairName(u.members)}`)
        away.append(sketch('later'))
        away.addEventListener('click', () => { for (const a of u.members) archive(a.id).catch(() => {}) })
        row.append(away)
      }
      return row
    }

    const tray = el('span', 'agent-avatar agent-all')
    tray.append(el('i'), el('i'), el('i'))
    const here = units.filter(u => u.online), away = units.filter(u => !u.online)
    root.replaceChildren(
      entry({ id: null, label: 'Inbox', lead: tray, active: scope == null, mark: fresh ? el('b', 'agent-count', String(fresh)) : null }),
      el('h2', 'caps agent-heading', 'Sessions'),
      ...here.map(unitRow),
      ...(away.length ? [el('h2', 'caps agent-heading agent-heading-away', 'Disconnected'), ...away.map(unitRow)] : []),
    )
  }

  // ---- laying sessions together: drag one onto another, pull one out of its group ----
  // A mouse drags at once; a finger holds still for a moment first, so the strip still scrolls.

  let drag = null   // { agent, grouped, x, y, row, ghost, target, timer }
  const rowAt = (x, y) => {
    const row = document.elementFromPoint(x, y)?.closest?.('.agent-row[data-unit]')
    return row && row !== drag.row && root.contains(row) ? row : null
  }
  function begin() {
    const agent = lastState?.all.agents.find(a => a.id === drag.agent)
    if (!agent) return end()
    drag.ghost = avatar(agent)
    drag.ghost.classList.add('agent-ghost')
    document.body.append(drag.ghost)
    drag.row.classList.add('is-dragging')
    document.body.classList.add('is-pairing')
    move(drag.x, drag.y)
  }
  function move(x, y) {
    drag.ghost.style.translate = `${x - 17}px ${y - 17}px`
    const target = rowAt(x, y)
    if (target === drag.target) return
    drag.target?.classList.remove('is-drop')
    drag.target = target
    target?.classList.add('is-drop')
  }
  function end() {
    if (!drag) return
    clearTimeout(drag.timer)
    drag.ghost?.remove()
    drag.row.classList.remove('is-dragging')
    drag.target?.classList.remove('is-drop')
    document.body.classList.remove('is-pairing')
    drag = null
  }
  root.addEventListener('pointerdown', e => {
    const row = e.target.closest('.agent-row[data-unit]')
    if (!row || e.button || e.target.closest('.agent-archive')) return
    const ids = row.dataset.members.split(' ')
    // In a group the scribble under the pointer is the one that is taken out.
    const agent = e.target.closest('[data-member]')?.dataset.member ?? ids.at(-1)
    drag = { agent, grouped: ids.length > 1, x: e.clientX, y: e.clientY, row, ghost: null, target: null, timer: 0 }
    if (e.pointerType === 'touch') drag.timer = setTimeout(() => drag && begin(), 380)
  })
  window.addEventListener('pointermove', e => {
    if (!drag) return
    const far = Math.hypot(e.clientX - drag.x, e.clientY - drag.y)
    if (drag.ghost) return move(e.clientX, e.clientY)
    if (e.pointerType === 'touch') { if (far > 10) end() }   // a swipe, not a hold
    else if (far > 6) begin()
  })
  window.addEventListener('pointerup', e => {
    if (!drag) return
    if (drag.ghost) {
      const { agent, grouped, target } = drag
      const far = Math.hypot(e.clientX - drag.x, e.clientY - drag.y)
      if (target) pair(agent, target.dataset.members.split(' ')[0]).catch(() => {})
      else if (grouped && far > 48) unpair(agent).catch(() => {})
      // The release is not a tap on the row.
      const swallow = ev => { ev.stopPropagation(); ev.preventDefault() }
      window.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
    }
    end()
  })
  window.addEventListener('pointercancel', end)
  // Once a finger carries a session, the page must not scroll under it.
  root.addEventListener('touchmove', e => { if (drag?.ghost) e.preventDefault() }, { passive: false })
  root.addEventListener('contextmenu', e => { if (drag) e.preventDefault() })

  return { render }
}

/** The overview page: every session, where it runs, as what, and since when. */
export function mountRoster(root) {
  let signature = ''
  const cell = (term, value) => {
    const box = el('div')
    box.append(el('dt', null, term), el('dd', null, value || 'unknown'))
    if (!value) box.classList.add('is-unknown')
    return box
  }
  const act = (label, run) => {
    const b = el('button', 'roster-act', label)
    b.type = 'button'
    b.addEventListener('click', () => Promise.resolve(run()).catch(() => {}))
    return b
  }
  function render(state) {
    const { all } = state
    const next = JSON.stringify([all.agents, all.archived, all.queue.length])
    if (next === signature) return
    signature = next
    const online = all.agents.filter(a => a.online).length
    const head = el('header', 'roster-head')
    head.append(el('h2', null, 'Agents'), el('p', null, `${online} of ${all.agents.length} sessions are connected.`))
    const list = el('div', 'roster-list')
    for (const agent of all.agents) {
      const { open, tasks } = summary(all, [agent])
      const card = el('article', 'roster-card')
      card.dataset.online = String(Boolean(agent.online))
      const top = el('header')
      const name = el('div', 'roster-name')
      name.append(el('strong', null, agent.name), el('span', null, agent.task || 'no task named'))
      const status = el('span', 'roster-state', agent.online ? 'connected' : `disconnected, last seen ${ago(agent.seen ?? agent.joined ?? Date.now())}`)
      const vip = el('button', 'roster-star', agent.starred ? '★' : '☆')
      vip.type = 'button'
      vip.setAttribute('aria-pressed', String(Boolean(agent.starred)))
      vip.setAttribute('aria-label', agent.starred ? 'Remove the VIP mark' : 'Mark as VIP')
      vip.addEventListener('click', () => star(agent.id, !agent.starred).catch(() => {}))
      // Tap the mark to rename the session or pick another scribble.
      const edit = el('button', 'roster-edit')
      edit.type = 'button'
      edit.setAttribute('aria-label', `${agent.name}: change name and mark`)
      edit.append(avatar(agent))
      edit.addEventListener('click', () => openEditor(agent))
      top.append(edit, name, status, vip)
      const facts = el('dl', 'roster-facts')
      facts.append(
        cell('Model', agent.model),
        cell('Machine', [agent.host, agent.platform].filter(Boolean).join(' · ')),
        cell('Folder', agent.cwd),
        cell('Program', agent.client),
        cell('Open questions', String(open)),
        cell('Connected since', agent.online && agent.connected ? ago(agent.connected) : ''),
      )
      card.append(top)
      if (tasks.length) {
        const lights = el('div', 'roster-tasks')
        for (const t of tasks) {
          const pill = el('span', 'roster-task', t.detail ? `${t.label}: ${t.detail}` : t.label)
          pill.dataset.state = t.state
          lights.append(pill)
        }
        card.append(lights)
      }
      // What can be done with the session, as quiet words: rename, lay together or split, put away.
      const actions = el('footer', 'roster-actions')
      actions.append(act('Change name or mark', () => openEditor(agent)))
      const group = all.groups.find(g => g.id === agent.group)
      if (group) {
        const others = group.members.filter(a => a !== agent).map(a => a.name).join(', ')
        actions.append(el('span', 'roster-paired', `Together with ${others}`), act('Split', () => unpair(agent.id)))
      } else if (all.agents.length > 1) {
        const pick = el('select', 'roster-act')
        pick.setAttribute('aria-label', `Put ${agent.name} together with another session`)
        pick.append(new Option('Put together with…', ''))
        const apart = tellApart(all.agents)
        for (const other of all.agents) if (other !== agent) pick.append(new Option([other.name, apart.get(other.id)].filter(Boolean).join(' · '), other.id))
        pick.addEventListener('change', () => { if (pick.value) pair(agent.id, pick.value).catch(() => {}) })
        actions.append(pick)
      }
      if (!agent.online) actions.append(act('Archive', () => archive(agent.id)))
      card.append(facts, actions)
      list.append(card)
    }
    const parts = [head, list]
    // Put away: disconnected sessions the human archived. They come back by themselves when they reconnect.
    if (all.archived.length) {
      const shelf = el('section', 'roster-archive')
      const label = el('h3', 'inbox-sender')
      label.append(el('span', null, 'Archive'), el('b', null, all.archived.length === 1 ? '1 session' : `${all.archived.length} sessions`))
      shelf.append(label)
      for (const agent of all.archived) {
        const row = el('div', 'roster-archived')
        const text = el('span', 'roster-name')
        text.append(el('strong', null, agent.name), el('span', null, `last seen ${ago(agent.seen ?? agent.joined ?? Date.now())}`))
        row.append(avatar(agent), text, act('Fetch back', () => archive(agent.id, false)))
        shelf.append(row)
      }
      parts.push(shelf)
    }
    // Phones have no bar with words; the two side doors stand here.
    const links = el('p', 'roster-links')
    const link = (href, text) => { const a = el('a', null, text); a.href = href; return a }
    links.append(link('/hilfe.html', 'Help'), link('/admin.html', 'Admin'))
    parts.push(links)
    root.replaceChildren(...parts)
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
  name.setAttribute('aria-label', 'Name of the session')
  let picked = agent.mark
  const grid = el('div', 'session-marks')
  grid.setAttribute('role', 'radiogroup')
  grid.setAttribute('aria-label', 'Mark')
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
  const cancel = el('button', null, 'Cancel')
  cancel.type = 'button'
  cancel.addEventListener('click', () => dialog.close())
  const save = el('button', 'is-lead', 'Save')
  save.type = 'submit'
  row.append(cancel, save)
  form.append(el('h2', null, 'Change the session'), el('label', 'caps', 'Name'), name, el('span', 'caps', 'Mark'), grid, error, row)
  form.addEventListener('submit', async e => {
    e.preventDefault()
    save.disabled = true
    try {
      // An emptied name falls back to the one the session gave itself.
      await editSession(agent.id, { label: name.value.trim() === agent.given ? '' : name.value.trim(), icon: picked === agent.id ? '' : picked })
      dialog.close()
    } catch (err) {
      save.disabled = false
      error.textContent = `Not saved: ${err.message}`
    }
  })
  dialog.append(form)
  dialog.addEventListener('close', () => dialog.remove())
  document.body.append(dialog)
  dialog.showModal()
  name.select()
}
