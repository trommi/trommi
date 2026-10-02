// The sidebar (the inbox on top, the sessions below, sessions dropped on each other
// become one) and the overview page of all sessions.

import { el, doodle, pairDoodle, groupLoop, crown, sketch, raisedHand, loopPath, penSeed, ago, DRAWINGS, DRAWING_INFO, drawingMark, drawingOf, drawingHue, KNOCK_SKETCH, isKnock, knocksText, INBOX_WORD, INBOX_SKETCH } from './ui.js'
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

// At work: a thin ring circled by hand, and a short pen stroke that goes round it again and again, as
// if the ring were being drawn anew each turn. The stroke tapers: three dashes of the same closed path,
// each shorter and a little heavier than the one before, all ending at the same point, the pen's tip.
// Every ring runs on the same clock, so a list that is rebuilt does not send its stroke back to the
// start. Under reduced motion the ring stands still, with a small gap (CSS, app.css).
const RING = { turn: 1900 }
const RING_LOOP = loopPath(penSeed('working ring'), { rad: 13.6, drift: .5, jitter: .6, start: 1.1 })
// The way the stroke takes: closed, so that it runs on without a jump, and uneven like a hand's circle.
const RING_WAY = (() => {
  const r = penSeed('working way'), phase = [r() * 6, r() * 6], n = 28
  const pts = Array.from({ length: n }, (_, i) => {
    const t = -Math.PI / 2 + i / n * Math.PI * 2
    const rad = 13.5 + .32 * Math.sin(2 * t + phase[0]) + .22 * Math.sin(3 * t + phase[1])
    return [16 + Math.cos(t) * rad, 16 + Math.sin(t) * rad * .975]
  })
  const mid = (a, b) => `${((a[0] + b[0]) / 2).toFixed(2)} ${((a[1] + b[1]) / 2).toFixed(2)}`
  return `M${mid(pts[n - 1], pts[0])}` + pts.map((p, i) => ` Q${p[0].toFixed(2)} ${p[1].toFixed(2)} ${mid(p, pts[(i + 1) % n])}`).join('') + ' Z'
})()
const RING_STROKE = [[30, 1.15, .45], [19, 1.75, .8], [8, 2.3, 1]]   // length (of 100), width, opacity: tail to tip
function ring() {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 32 32')
  svg.setAttribute('class', 'agent-ring')
  svg.setAttribute('aria-hidden', 'true')
  svg.style.setProperty('--ring-turn', `${RING.turn}ms`)
  const loop = document.createElementNS(NS, 'path')
  loop.setAttribute('class', 'ring-loop')
  loop.setAttribute('d', RING_LOOP)
  loop.setAttribute('pathLength', '100')
  const trace = document.createElementNS(NS, 'g')
  trace.setAttribute('class', 'ring-drop')
  trace.style.animationDelay = `${-(Date.now() % RING.turn)}ms`
  for (const [len, width, opacity] of RING_STROKE) {
    const dash = document.createElementNS(NS, 'path')
    dash.setAttribute('d', RING_WAY)
    dash.setAttribute('pathLength', '100')
    dash.setAttribute('stroke-dasharray', `${len} ${100 - len}`)
    dash.setAttribute('stroke-dashoffset', String(len))   // every dash ends at the path's start: one tip
    dash.setAttribute('stroke-width', String(width))
    dash.setAttribute('opacity', String(opacity))
    trace.append(dash)
  }
  svg.append(loop, trace)
  return svg
}

/** The ring alone, small, turning: for a line that says how many sessions are at work. */
export const workingRing = ring

// The badge at the end of a session row: a ring drawn by hand. With open questions their number stands
// in it; while the session works a drop runs round it (with or without a number); when one of its
// questions knocks (urgent, blocking, a permission) it is the raised hand in a red loop. Idle with
// nothing open: no ring. Disconnected with questions: the ring and number in grey, still.
// With questions open the badge is a button of its own beside the row's entry: a click goes through
// that session's questions, one after the other (walk(), given by the page). who: the name(s) for its tooltip.
export function badge({ open, online, running, stuck }, who = '', walk = null) {
  if (!open && !(online && running)) return null
  const button = Boolean(open && walk)
  const node = el(button ? 'button' : 'span', 'agent-badge')
  if (button) {
    node.type = 'button'
    node.addEventListener('click', e => { e.stopPropagation(); walk() })
  }
  const questions = open === 1 ? '1 question' : `${open} questions`
  const hand = Boolean(open && stuck)
  node.dataset.state = hand ? 'waiting' : online && running ? 'running' : 'open'
  const busy = Boolean(online && running)
  // A knock from a session that is still at work: the hand, and the drop keeps going round its loop.
  if (hand) {
    node.append(raisedHand())
    if (busy) { const over = ring(); over.classList.add('is-over'); over.querySelector('.ring-loop').remove(); node.append(over); node.dataset.working = '' }
  }
  else {
    const svg = ring()
    if (!busy) svg.querySelector('.ring-drop').remove()
    node.append(svg)
    if (open) node.append(el('b', null, String(open)))
  }
  if (!online) node.dataset.offline = ''
  const state = hand ? (online ? `${busy ? 'Working, and waiting' : 'Waiting'} for you: ${questions}` : `Disconnected, was waiting for you: ${questions}`)
    : online ? (running ? (open ? `Working, ${questions} open` : 'Working') : `${questions} open`) : `Disconnected, ${questions} open`
  node.title = button ? `Go through ${who ? `${who}'s ` : 'the '}${questions} · ${state}` : state
  if (button) node.setAttribute('aria-label', `Go through ${who ? `${who}'s ` : 'the '}${questions} (${state.toLowerCase()})`)
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
    if (sub instanceof Node) text.append(sub)
    else if (sub) text.append(el('small', null, sub))
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
  // The Desk's badges: the knocks (the knuckles and THEIR number, on the warning colour), and beside them
  // everything that is open (the stack of cards and its number, quiet). Two marks, two numbers.
  function inboxCount(fresh, knocking) {
    if (!fresh) return null
    const box = el('span', 'agent-counts')
    if (knocking) {
      const knocks = el('span', 'agent-count is-knock')
      knocks.title = knocksText(knocking)
      knocks.append(sketch(KNOCK_SKETCH), String(knocking))
      box.append(knocks)
    }
    const total = el('span', 'agent-count is-total')
    total.title = fresh === 1 ? '1 open question' : `${fresh} open questions`
    total.append(sketch('stack'), String(fresh))
    box.append(total)
    return box
  }
  // Under the Desk's name: how many sessions are at work right now, behind a small turning ring.
  function workingLine(n) {
    if (!n) return null
    const line = el('small', 'agent-working')
    line.title = n === 1 ? '1 session is working' : `${n} sessions are working`
    line.dataset.n = n
    line.setAttribute('role', 'img')
    line.setAttribute('aria-label', line.title)
    line.append(ring(), el('b', null, String(n)), el('span', null, `${n} working`))
    return line
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
    const working = units.filter(u => u.online && u.running).length
    const next = JSON.stringify([scope, document.body.dataset.page, fresh, knocking, working, units.map(u => [u.id, u.members.map(a => [a.id, a.name, a.mark, a.task, a.online, a.starred, a.cwd, a.host]), u.open, u.running, u.stuck])])
    if (next === signature) return
    signature = next

    const apart = tellApart(all.agents)
    const unitRow = u => {
      const single = u.members.length === 1 ? u.members[0] : null
      const row = entry({
        id: u.id,
        label: single ? single.name : u.members.map(a => ({ member: a.id, text: [a.name, apart.get(a.id)].filter(Boolean).join(' · ') })),
        sub: single ? apart.get(single.id) : '',
        lead: single ? avatar(single) : pairAvatar(u.members),
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

    // The Desk is not a row here: it floats at the top (index.html #desk-go). Its state is painted there.
    paintDesk(fresh, knocking, working, scope == null && document.body.dataset.page !== 'roster')
    const here = units.filter(u => u.online), away = units.filter(u => !u.online)
    root.replaceChildren(
      ...here.map(unitRow),
      ...(away.length ? [el('h2', 'caps agent-heading agent-heading-away', 'Disconnected'), ...away.map(unitRow)] : []),
    )
  }
  // The floating Desk says what waits and who works: every open card, the knocks, the sessions at work.
  function paintDesk(fresh, knocking, working, current) {
    const go = document.getElementById('desk-go'), box = document.getElementById('desk-state')
    if (!go || !box) return
    go.toggleAttribute('aria-current', current)
    box.replaceChildren(...[inboxCount(fresh, knocking), workingLine(working)].filter(Boolean))
    const open = document.getElementById('desk-open')
    if (open) open.textContent = `${fresh} open`
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
