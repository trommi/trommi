// The sidebar (the inbox on top, the sessions below, sessions dropped on each other
// become one) and the overview page of all sessions.

import { el, doodle, pairDoodle, groupLoop, crown, sketch, bareHand, ago, DRAWINGS, DRAWING_INFO, drawingMark, drawingOf, drawingHue, KNOCK_SKETCH, isKnock, knocksText, INBOX_WORD, INBOX_SKETCH } from './ui.js'
import { getState, setScope, star, editSession, pair, unpair, archive, moveSession } from './store.js'

const NS = 'http://www.w3.org/2000/svg'

// A stable colour per session, from the hues that read on both themes.
const HUES = [162, 28, 262, 205, 338, 96, 48, 232]
export function hueOf(id) {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return HUES[h % HUES.length]
}

/** The colour of a session's mark: a named drawing has a colour of its own, wherever it shows; a seeded
 *  scribble takes the colour that comes from the session's id. */
export const hueFor = agent => drawingHue(drawingOf(agent.mark)) ?? hueOf(agent.id)

// Every session has its own scribble, so it is recognised before its name is read.
/** vip: draw the crown of a starred session on it. Where the crown is a switch of its own beside the
 *  mark (crownToggle), the caller passes false. */
// working: the session is at work. Its own mark then redraws itself: the whole drawing stays as a
// trace, and a darker stroke travels along it (CSS: .is-drawing). Under reduced motion the trace and
// the mark stand still.
export function avatar(agent, { vip = true, working = false } = {}) {
  const node = el('span', 'agent-avatar')
  const mark = doodle(agent.mark ?? agent.id)
  node.append(mark)
  if (working) {
    node.classList.add('is-drawing')
    for (const p of mark.querySelectorAll('path')) p.setAttribute('pathLength', 100)
    const trace = mark.cloneNode(true)
    trace.classList.add('mark-trace')
    mark.classList.add('mark-live')
    node.prepend(trace)
  }
  node.style.setProperty('--hue', hueFor(agent))
  if (!agent.online) node.classList.add('is-offline')
  // A session that matters most: a scribbled crown sits crooked on the corner of its mark.
  if (agent.starred && vip) { node.dataset.vip = ''; node.append(crown()) }
  node.setAttribute('aria-hidden', 'true')
  return node
}

/** The crown as a switch: it sits on the corner of a session's mark, as a button of its own beside
 *  the mark, so the mark keeps its own click. On a starred session it is the gold crown, and a click
 *  takes it off; on any other it is a faint outline that shows when the pointer or the keyboard is
 *  near, and a click puts it on. Placed by CSS (.crown-toggle), per place it stands in. */
export function crownToggle(agent, cls = '') {
  const b = el('button', `crown-toggle ${cls}`.trim())
  b.type = 'button'
  b.setAttribute('aria-pressed', String(Boolean(agent.starred)))
  b.title = agent.starred ? 'Remove VIP' : 'Make VIP'
  b.setAttribute('aria-label', `${agent.name}: ${agent.starred ? 'remove VIP' : 'make VIP, its questions come first'}`)
  b.append(crown())
  b.addEventListener('click', e => { e.stopPropagation(); star(agent.id, !agent.starred).catch(() => {}) })
  return b
}

/** Sessions laid together: their scribbles over each other inside one loop drawn by hand. */
export function pairAvatar(members, working = []) {
  const node = el('span', 'agent-pair')
  const mark = pairDoodle(members.map(a => ({ id: a.id, mark: a.mark, hue: hueFor(a), vip: Boolean(a.starred) })))
  node.append(mark)
  // Each member that is at work redraws its own scribble inside the joint mark.
  for (const g of [...mark.querySelectorAll('g[data-member]')]) {
    if (!working.includes(g.dataset.member)) continue
    node.classList.add('is-drawing')
    for (const p of g.querySelectorAll('path:not(.pair-crown)')) p.setAttribute('pathLength', 100)
    const trace = g.cloneNode(true)
    trace.removeAttribute('data-member')
    trace.setAttribute('class', 'mark-trace')
    g.classList.add('mark-live')
    mark.insertBefore(trace, g)
  }
  if (!members.some(a => a.online)) node.classList.add('is-offline')
  node.setAttribute('aria-hidden', 'true')
  return node
}

const pairName = members => members.map(a => a.name).join(' + ')

// What a session, or several together, need from the human right now.
// Only what waits on the human counts: an open question that is neither snoozed nor handed back to its
// session (with the agent). later: the ids put off in this browser; left out, the store's own list.
export function summary(all, members, later = null) {
  const ids = new Set(members.map(a => a.id))
  const off = new Set(later ?? getState().later ?? [])
  const mine = all.cards.filter(c => ids.has(c.agent) && c.status === 'open' && all.queue.includes(c.id) && !off.has(c.id) && !c.with_agent)
  const open = mine.length
  const tasks = all.tasks.filter(t => ids.has(t.agent))
  const online = members.some(a => a.online)
  // Running: it has work in progress. Stuck: one of its open questions knocks (urgent, blocking, a permission).
  const running = members.some(a => a.online && tasks.some(t => t.agent === a.id && t.state === 'working'))
  const stuck = mine.some(isKnock)
  return { open, tasks, online, running, stuck }
}

// What a session needs or does is told in two places, with no ground under either. At work: its own
// mark at the left redraws itself (avatar(), above); nothing turns at the right. At the right end of
// the row: the number of its open questions, always in one column; before it, when the session is
// stopped and waits for the human, a hand drawn in red, all hands on one axis. A working session's
// number is small and muted, a disconnected one's faint (its mark is grey). Idle: nothing.
// With questions open the badge is a button of its own beside the row's entry: a click goes through
// that session's questions, one after the other (walk(), given by the page). who: the name(s) for its tooltip.
export function badge({ open, online, running, stuck }, who = '', walk = null) {
  // Idle shows nothing, and so does a disconnected session (its mark is grey).
  if (!open || !online) return null
  const node = el(walk ? 'button' : 'span', 'agent-badge')
  if (walk) {
    node.type = 'button'
    node.addEventListener('click', e => { e.stopPropagation(); walk() })
  }
  const questions = open === 1 ? '1 question' : `${open} questions`
  // The hand only when a question of it knocks; else the stack of cards.
  const hand = stuck
  node.dataset.state = hand ? 'waiting' : online ? 'running' : 'open'
  // How many is beside the point here: a hand when the session waits for you, else a small stack of
  // cards, the same for one question or twelve. (The number is in the tooltip and in the inbox.)
  node.append(hand ? bareHand() : sketch('stack'))
  if (!online) node.dataset.offline = ''
  const state = hand ? (online ? `Waiting for you: ${questions}` : `Disconnected, was waiting for you: ${questions}`) : online ? `Working, ${questions} open` : `Disconnected, ${questions} open`
  node.title = walk ? `Go through ${who ? `${who}'s ` : 'the '}${questions} · ${state}` : state
  if (walk) node.setAttribute('aria-label', `Go through ${who ? `${who}'s ` : 'the '}${questions} (${state.toLowerCase()})`)
  return node
}

// Sessions that share a name get a second line that tells them apart: the folder, else the
// machine, else since when they are connected. Returns a Map of session id to that line.
export function tellApart(agents) {
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
/** onWalk(id): go through the open questions of that session or group, one after the other. */
export function mountAgents(root, { onSelect, onWalk }) {
  let signature = ''
  let lastState = null

  function entry({ id, label, sub, lead, active, mark = null, tip = '' }) {
    const btn = el('button', 'agent-entry')
    btn.type = 'button'
    // While the overview of all sessions is up, nothing in the sidebar is the current place.
    if (active && document.body.dataset.page !== 'roster') btn.setAttribute('aria-current', 'true')
    if (tip) btn.title = tip
    const text = el('span', 'agent-text')
    // Sessions laid together: every name on a line of its own, so none is cut short, and each
    // line can be grabbed to pull that session out again.
    for (const line of [].concat(label)) {
      const name = el('strong', null, line.text ?? line)
      if (line.member) name.dataset.member = line.member
      text.append(name)
    }
    if (Array.isArray(label)) text.dataset.lines = label.length
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

  // The inbox's badge: the knocks first (the drawing of knuckles and their number), then every open question.
  function inboxCount(fresh, knocking) {
    if (!fresh) return null
    // No number: the stack of cards when anything is open, the knuckles when something knocks.
    const box = el('span', knocking ? 'agent-count is-knock' : 'agent-count')
    box.title = [knocking ? knocksText(knocking) : '', fresh === 1 ? '1 open question' : `${fresh} open questions`].filter(Boolean).join(' · ')
    box.append(sketch(knocking ? KNOCK_SKETCH : 'stack'), String(fresh))   // the inbox says how many; the session rows do not
    return box
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
    for (const u of units) Object.assign(u, summary(all, u.members, state.later))
    const fresh = all.queue.filter(id => !state.later.includes(id)).length
    // Of those, the knocks (urgent and blocking): they are what the inbox's badge shows first.
    const knocking = all.cards.filter(c => c.status === 'open' && isKnock(c) && all.queue.includes(c.id) && !state.later.includes(c.id)).length
    const next = JSON.stringify([scope, document.body.dataset.page, fresh, knocking, units.map(u => [u.id, u.members.map(a => [a.id, a.name, a.mark, a.task, a.online, a.starred, a.cwd, a.host]), u.open, u.running, u.stuck])])
    if (next === signature) return
    signature = next

    const apart = tellApart(all.agents)
    const unitRow = u => {
      const single = u.members.length === 1 ? u.members[0] : null
      const row = entry({
        id: u.id,
        label: single ? single.name : u.members.map(a => ({ member: a.id, text: [a.name, apart.get(a.id)].filter(Boolean).join(' · ') })),
        sub: single ? apart.get(single.id) : '',
        lead: single ? avatar(single, { working: u.running }) : pairAvatar(u.members, u.members.filter(a => a.online && u.tasks.some(t => t.agent === a.id && t.state === 'working')).map(a => a.id)),
        active: scope === u.id,
        tip: u.members.map(a => a.task).filter(Boolean).join(' · '),
      })
      row.dataset.unit = u.id
      row.dataset.members = u.members.map(a => a.id).join(' ')
      // (A VIP session shows its crown here; the switch for it is in the session's title and on the Agents page.)
      if (!single) {
        // Without dragging: scissors cut the group apart, every session stands alone again.
        // (One session alone is taken out on the Agents page, with "Split".)
        // It stands under the badge, on the badge's axis. No tooltip (it would lie over the next row):
        // while the pointer is on it, the loop round the group opens up, which says what it does.
        row.classList.add('is-group')
        // The loop of the group goes round all of it, marks and names.
        row.querySelector('.agent-entry').append(groupLoop(u.members.map(a => a.id).join('+')))
        const cut = el('button', 'agent-cut')
        cut.type = 'button'
        cut.setAttribute('aria-label', `Pull apart ${pairName(u.members)}`)
        cut.append(sketch('snip'))
        cut.addEventListener('click', () => { for (const a of u.members) editSession(a.id, { group: null }).catch(() => {}) })
        row.append(cut)
      }
      // The state at the end of the row, a button of its own where there are questions to go through.
      const state = badge(u, pairName(u.members), onWalk && (() => onWalk(u.id)))
      if (state) { row.classList.add('has-badge'); row.append(state) }
      if (!u.online) {
        row.classList.add('is-offline')
        const away = el('button', 'agent-archive')
        away.type = 'button'
        away.title = 'Archive: put this session away'
        away.setAttribute('aria-label', `Archive ${single ? single.name : pairName(u.members)}`)
        away.append(sketch('archive'))
        away.addEventListener('click', () => { for (const a of u.members) archive(a.id).catch(() => {}) })
        row.append(away)
      }
      return row
    }

    const tray = el('span', 'agent-avatar agent-all')
    tray.append(sketch(INBOX_SKETCH))
    const here = units.filter(u => u.online), away = units.filter(u => !u.online)
    root.replaceChildren(
      entry({ id: null, label: INBOX_WORD, lead: tray, active: scope == null, mark: inboxCount(fresh, knocking) }),
      ...here.map(unitRow),
      ...(away.length ? [el('h2', 'caps agent-heading agent-heading-away', 'Disconnected'), ...away.map(unitRow)] : []),
    )
  }

  // ---- carrying a session: lay it on another, move it to another place, pull it out of its group ----
  // A mouse drags at once; a finger holds still for a moment first, so the strip still scrolls.
  // Where it is let go decides: on the middle of another row the two are laid together (the loop
  // drawn round that row opens up); on the upper or lower quarter of a row, or between rows, it is
  // moved there (a thin line shows the place), a group as one; clear of the list, one that was
  // carried out of a group leaves it.

  let drag = null   // { agent, grouped, x, y, row, ghost, at, timer }; at: where it would land now
  const dropLoop = groupLoop('drop')
  dropLoop.classList.add('drop-loop')
  const rowsNow = () => [...root.querySelectorAll('.agent-row[data-unit]')]
  /** What letting go at (x, y) would do: { pair: row } | { insert: row, after } | { out: true } | null (nothing). */
  function landing(x, y) {
    const rows = rowsNow()
    const flat = getComputedStyle(root).flexDirection === 'row'   // a phone's strip runs sideways
    const box = root.getBoundingClientRect()
    const span = r => (flat ? [r.left, r.right] : [r.top, r.bottom])
    const along = flat ? x : y, across = flat ? y : x
    const [c0, c1] = flat ? [box.top, box.bottom] : [box.left, box.right]
    const [first] = span(rows[0].getBoundingClientRect()), [, last] = span(rows.at(-1).getBoundingClientRect())
    if (across < c0 - 8 || across > c1 + 8 || along < first - 16 || along > last + 40) return { out: true }
    const own = rows.indexOf(drag.row)
    // Before or after its own row nothing would move.
    const insert = (row, after) => {
      const to = rows.indexOf(row) + (after ? 1 : 0)
      return to === own || to === own + 1 ? null : { insert: row, after }
    }
    for (const row of rows) {
      const [a, b] = span(row.getBoundingClientRect())
      if (along < a) return insert(row, false)   // in the gap before this row (or under a heading)
      if (along > b) continue
      if (row === drag.row) return null
      const quarter = (b - a) / 4
      return along < a + quarter ? insert(row, false) : along > b - quarter ? insert(row, true) : { pair: row }
    }
    return insert(rows.at(-1), true)
  }
  function begin() {
    const agent = lastState?.all.agents.find(a => a.id === drag.agent)
    if (!agent) return end()
    drag.ghost = avatar(agent)
    drag.ghost.classList.add('agent-ghost')
    document.body.append(drag.ghost)
    drag.row.classList.add('is-dragging')
    // Out of a group: the one that is carried fades where it stood.
    if (drag.grouped) for (const n of drag.row.querySelectorAll(`[data-member="${CSS.escape(drag.agent)}"]`)) n.classList.add('is-carried')
    document.body.classList.add('is-pairing')
    move(drag.x, drag.y)
  }
  const unmark = () => {
    for (const n of root.querySelectorAll('.is-drop, .is-insert-before, .is-insert-after')) n.classList.remove('is-drop', 'is-insert-before', 'is-insert-after')
    dropLoop.remove()
  }
  function move(x, y) {
    drag.ghost.style.translate = `${x - 17}px ${y - 17}px`
    const at = landing(x, y)
    // The loop round the group opens up while one of them is on its way out.
    drag.row.classList.toggle('is-leaving', Boolean(drag.grouped && at?.out))
    const same = (a, b) => a?.pair === b?.pair && a?.insert === b?.insert && a?.after === b?.after && Boolean(a?.out) === Boolean(b?.out)
    if (same(at, drag.at)) return
    drag.at = at
    unmark()
    if (at?.pair) { at.pair.classList.add('is-drop'); at.pair.append(dropLoop) }
    if (at?.insert) at.insert.classList.add(at.after ? 'is-insert-after' : 'is-insert-before')
  }
  function end() {
    if (!drag) return
    clearTimeout(drag.timer)
    drag.ghost?.remove()
    drag.row.classList.remove('is-dragging', 'is-leaving')
    for (const n of drag.row.querySelectorAll('.is-carried')) n.classList.remove('is-carried')
    unmark()
    document.body.classList.remove('is-pairing')
    drag = null
  }
  /** The session a move names as "before": the first of the row after the place, or null for the end. */
  const beforeOf = (row, after) => {
    const rows = rowsNow()
    const next = after ? rows[rows.indexOf(row) + 1] : row
    return next ? next.dataset.members.split(' ')[0] : null
  }
  /** Move the row that holds the keyboard (or, with none, the session in view) one place up or down. */
  function step(by) {
    const rows = rowsNow()
    const row = document.activeElement?.closest?.('.agent-row[data-unit]') ?? root.querySelector('.agent-entry[aria-current="true"]')?.closest('.agent-row[data-unit]')
    const at = rows.indexOf(row)
    if (at < 0 || !rows[at + by]) return false
    const held = row.contains(document.activeElement)
    const unit = row.dataset.unit
    moveSession(row.dataset.members.split(' ')[0], by < 0 ? beforeOf(rows[at - 1], false) : beforeOf(rows[at + 1], true)).catch(() => {})
      .finally(() => { if (held) setTimeout(() => root.querySelector(`.agent-row[data-unit="${CSS.escape(unit)}"] .agent-entry`)?.focus(), 60) })
    if (held) root.querySelector(`.agent-row[data-unit="${CSS.escape(unit)}"] .agent-entry`)?.focus()
    return true
  }
  // Alt and an arrow move it (up/down in the sidebar, left/right in a phone's strip). The table of keys
  // (keys.js) does not know this one yet; until it does, the sidebar hears it itself.
  window.addEventListener('keydown', e => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
    const by = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 }[e.key]
    if (!by || document.querySelector('dialog[open]') || e.target.closest?.('input, textarea, select, [contenteditable]')) return
    if (step(by)) { e.preventDefault(); e.stopImmediatePropagation() }
  }, true)
  root.addEventListener('pointerdown', e => {
    const row = e.target.closest('.agent-row[data-unit]')
    if (!row || e.button || e.target.closest('.agent-archive, .agent-cut, .crown-toggle, button.agent-badge')) return
    const ids = row.dataset.members.split(' ')
    // In a group the scribble under the pointer is the one that is taken out.
    const agent = e.target.closest('[data-member]')?.dataset.member ?? ids.at(-1)
    drag = { agent, grouped: ids.length > 1, x: e.clientX, y: e.clientY, row, ghost: null, at: null, timer: 0 }
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
      const { agent, grouped } = drag
      const at = landing(e.clientX, e.clientY)
      if (at?.pair) pair(agent, at.pair.dataset.members.split(' ')[0]).catch(() => {})
      else if (at?.insert) moveSession(agent, beforeOf(at.insert, at.after)).catch(() => {})
      else if (at?.out && grouped) unpair(agent).catch(() => {})
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

  return { render, move: step }
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
      const { open, tasks, running } = summary(all, [agent])
      const card = el('article', 'roster-card')
      card.dataset.online = String(Boolean(agent.online))
      const top = el('header')
      // The name is the way to rename it; the picture is the way to its drawing.
      const name = el('div', 'roster-name')
      const rename = el('button', 'roster-rename')
      rename.type = 'button'
      rename.title = 'Rename'
      rename.append(el('strong', null, agent.name))
      rename.addEventListener('click', () => openEditor(agent))
      name.append(rename, el('span', null, agent.task || 'no task named'))
      const status = el('span', 'roster-state', agent.online ? 'connected' : `disconnected, last seen ${ago(agent.seen ?? agent.joined ?? Date.now())}`)
      // The crown on the corner of the mark is the switch for VIP.
      const vip = crownToggle(agent, 'roster-star')
      // Tap the picture to choose another drawing, right there.
      const edit = el('button', 'roster-edit')
      edit.type = 'button'
      edit.title = 'Choose a drawing'
      edit.setAttribute('aria-label', `${agent.name}: choose a drawing`)
      edit.setAttribute('aria-haspopup', 'dialog')
      edit.append(avatar(agent, { vip: false, working: running }))
      edit.addEventListener('click', () => openMarkPicker(agent, edit))
      top.append(edit, vip, name, status)
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
      actions.append(act('Rename', () => openEditor(agent)))
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
    const admin = link('/admin.html', 'Admin')
    admin.prepend(sketch('key'))
    links.append(link('/help.html', 'Help'), admin)
    parts.push(links)
    root.replaceChildren(...parts)
  }
  return { render }
}

// ---- pick a session's drawing, rename it ---------------------------------------

/** The choice of drawing, right at the mark that was clicked: forty of them, one click picks and saves.
 *  Escape or a click beside it closes. anchor is the element the grid opens under. */
let picker = null
export function openMarkPicker(agent, anchor) {
  picker?.remove()
  const dialog = picker = el('dialog', 'mark-picker')
  dialog.setAttribute('aria-label', `Choose a drawing for ${agent.name}`)
  const grid = el('div', 'mark-grid')
  grid.setAttribute('role', 'radiogroup')
  grid.setAttribute('aria-label', 'Drawing')
  const error = el('p', 'session-error')
  for (const name of DRAWINGS) {
    const b = el('button', 'mark-tile')
    b.type = 'button'
    // Each drawing in its own colour; its meaning is the tooltip.
    b.style.setProperty('--hue', drawingHue(name))
    b.title = DRAWING_INFO.find(d => d.name === name)?.meaning || name
    b.setAttribute('role', 'radio')
    b.setAttribute('aria-label', name)
    b.setAttribute('aria-checked', String(agent.mark === drawingMark(name)))
    b.append(doodle(drawingMark(name)))
    b.addEventListener('click', async () => {
      for (const other of grid.children) other.setAttribute('aria-checked', String(other === b))
      try {
        await editSession(agent.id, { icon: drawingMark(name) })
        dialog.close()
      } catch (err) {
        error.textContent = `Not saved: ${err.message}`
      }
    })
    grid.append(b)
  }
  // The arrows walk the grid.
  grid.addEventListener('keydown', e => {
    const tiles = [...grid.children], at = tiles.indexOf(document.activeElement)
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[e.key]
    if (!step || at < 0) return
    e.preventDefault()
    tiles[Math.max(0, Math.min(tiles.length - 1, at + step))].focus()
  })
  dialog.append(grid, error)
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close() })
  dialog.addEventListener('close', () => dialog.remove())
  document.body.append(dialog)
  dialog.showModal()
  // Under the mark, or above it where there is no room below; never outside the window.
  const a = anchor.getBoundingClientRect(), w = dialog.offsetWidth, h = dialog.offsetHeight
  const top = a.bottom + 8 + h > window.innerHeight - 8 ? Math.max(8, a.top - h - 8) : a.bottom + 8
  dialog.style.left = `${Math.max(8, Math.min(a.left, window.innerWidth - w - 8))}px`
  dialog.style.top = `${top}px`
  ;(grid.querySelector('[aria-checked="true"]') ?? grid.firstChild).focus()
}

let editor = null
export function openEditor(agent) {
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
  const error = el('p', 'session-error')
  const row = el('div', 'session-buttons')
  const cancel = el('button', null, 'Cancel')
  cancel.type = 'button'
  cancel.addEventListener('click', () => dialog.close())
  const save = el('button', 'is-lead', 'Save')
  save.type = 'submit'
  row.append(cancel, save)
  const label = el('label', 'caps', 'Name')
  label.htmlFor = name.id
  form.append(el('h2', null, 'Rename the session'), label, name, error, row)
  form.addEventListener('submit', async e => {
    e.preventDefault()
    save.disabled = true
    try {
      // An emptied name falls back to the one the session gave itself.
      await editSession(agent.id, { label: name.value.trim() === agent.given ? '' : name.value.trim() })
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
