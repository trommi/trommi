// The sidebar (the inbox on top, the sessions below, sessions dropped on each other
// become one) and the overview page of all sessions.

import { el, doodle, pairDoodle, groupLoop, crown, sketch, raisedHand, loopPath, penSeed, ago, DRAWINGS, DRAWING_INFO, drawingMark, drawingOf, drawingHue, KNOCK_SKETCH, isKnock, knocksText, INBOX_WORD, INBOX_SKETCH } from './ui.js'
import { link, sessionPath, walkPath } from './link.js'
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

/** Who wears the crown (card Nr. 172): the one session of a desk that the human gave it to (`starred`; the hub
 *  keeps it to one per desk). The desk's memos go there. A main (`main`: it has subs, or says so) keeps its stack
 *  and bracket in the sidebar, but wears no crown for that alone. */
export const knowsMains = agent => 'main' in agent
export const crowned = agent => Boolean(agent.starred)

// Every session has its own scribble, so it is recognised before its name is read.
/** vip: true draws the crown on the crowned session's mark; false draws none, for places where the crown stands
 *  beside the mark as a switch of its own (crownToggle, the sidebar's fold switch). */
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
  if (vip === true && crowned(agent)) { node.dataset.vip = ''; node.append(crown()) }
  node.setAttribute('aria-hidden', 'true')
  return node
}

/** Give the crown: the crown as a switch. It sits on the corner of a session's mark, as a button of its own
 *  beside the mark, so the mark keeps its own click. On the crowned session it is the gold crown, and a click
 *  takes it off; on any other it is the crown's outline (faint until the pointer or the keyboard is near), and
 *  one click gives it the crown: the hub takes it from whoever wore it on that desk. Placed by CSS
 *  (.crown-toggle), per place it stands in. */
export function crownToggle(agent, cls = '') {
  const b = el('button', `crown-toggle ${cls}`.trim())
  b.type = 'button'
  b.setAttribute('aria-pressed', String(Boolean(agent.starred)))
  b.title = agent.starred ? 'Wears the crown: memos of this desk go here. Click to take it off' : 'Give the crown: memos of this desk go here'
  b.setAttribute('aria-label', `${agent.name}: ${agent.starred ? 'wears the crown, memos of this desk go here; take it off' : 'give the crown, memos of this desk go here'}`)
  b.append(crown())
  b.addEventListener('click', e => { e.stopPropagation(); star(agent.id, !agent.starred).catch(() => {}) })
  return b
}

/** Sessions laid together: their scribbles over each other inside one loop drawn by hand. */
export function pairAvatar(members, working = []) {
  const node = el('span', 'agent-pair')
  const mark = pairDoodle(members.map(a => ({ id: a.id, mark: a.mark, hue: hueFor(a), vip: crowned(a) })))
  node.append(mark)
  // Each member that is at work redraws its own scribble inside the joint mark.
  for (const g of [...mark.querySelectorAll('g[data-member]')]) {
    if (!working.includes(g.dataset.member)) continue
    node.classList.add('is-drawing')
    for (const p of g.querySelectorAll('path:not(.pair-crown *)')) p.setAttribute('pathLength', 100)
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
export function badge({ open, online, running, stuck }, who = '', walk = null, href = null) {
  if (!open && !(online && running)) return null
  const button = Boolean(open && walk)
  // With an address (the walk through its questions, /s/<id>/walk) it is a real link: a new tab can take it.
  const node = button && href ? link('agent-badge', href) : el(button ? 'button' : 'span', 'agent-badge')
  if (button) {
    if (!href) node.type = 'button'
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
// Which groups of a main and its subs stand unfolded: kept per browser. Folded is the rule.
const FOLD_KEY = 'trommi-crowns-open'
const unfolded = new Set((() => { try { const l = JSON.parse(localStorage.getItem(FOLD_KEY) ?? '[]'); return Array.isArray(l) ? l.filter(x => typeof x === 'string') : [] } catch { return [] } })())
const keepFolds = () => { try { localStorage.setItem(FOLD_KEY, JSON.stringify([...unfolded])) } catch {} }
const EDGES = 7   // more subs than this lie in the stack without an edge of their own

// The bracket that holds the subs of an unfolded main: one pen stroke, corners rounded, never quite straight.
const wob = (i, s) => (((Math.sin(i * 127.1 + 3.7) * 43758.5453) % 1 + 1) % 1 - .5) * 2 * s
function penLine(pts) {
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i], [nx, ny] = pts[i + 1]
    d += ` Q ${x.toFixed(1)} ${y.toFixed(1)} ${((x + nx) / 2).toFixed(1)} ${((y + ny) / 2).toFixed(1)}`
  }
  const last = pts.at(-1)
  return `${d} L ${last[0].toFixed(1)} ${last[1].toFixed(1)}`
}

// A sub's card edge in the folded stack, drawn with the pen: down one side, along the foot (never quite straight), up the
// other; the top stays open under the card above. Seeded by the session, so an edge always looks the same, and kept: it is
// drawn once. Two strokes of the same edge, since the drawing is stretched to the row: .e-w for the wide sidebar, .e-n for
// the rail and a phone's strip (crowns.css shows one). tilt and dx: how crooked it lies in the stack.
const edgeQuirks = new Map()
function edgeQuirk(id) {
  let q = edgeQuirks.get(id)
  if (q) return q
  const r = penSeed(`edge:${id}`), j = s => (r() - .5) * 2 * s
  const tilt = j(.75).toFixed(2), dx = j(2.2).toFixed(1), sag = j(.55), l = j(.5), rr = j(.5), ya = 12.9 + j(.6), yb = 12.9 + j(.6), xa = 30 + j(8), xb = 68 + j(8), sl = j(1), sr = j(1)
  // c: the width of a corner, k: the pen's wobble sideways, both in hundredths of the edge's width
  const line = (c, k) => penLine([[l * k, -2], [-l * k, 6 + sl], [c * .1, 11.3 + l * .6], [c, 12.9 + sag * .4], [xa, ya], [xb, yb], [100 - c, 12.9 - sag * .4], [100 - c * .1, 11.3 + rr * .6], [100 - rr * k, 6 + sr], [100 + rr * k, -2]])
  q = { tilt, dx, svg: `<svg viewBox="0 0 100 15" preserveAspectRatio="none" aria-hidden="true"><path class="e-w" d="${line(4.5, .5)}"/><path class="e-n" d="${line(15, 1.6)}"/></svg>` }
  edgeQuirks.set(id, q)
  return q
}

export function mountAgents(root, { onSelect, onWalk }) {
  let signature = ''
  let lastState = null
  let unfolding = null   // the main whose subs were unfolded by the last click: they come in one after the other, once

  /** Fold or unfold the subs of a main; the keyboard stays on the crown that was pressed. */
  function fold(id, open = !unfolded.has(id)) {
    if (open) unfolded.add(id)
    else unfolded.delete(id)
    keepFolds()
    unfolding = open ? id : null
    const held = root.querySelector(`.agent-row[data-unit="${CSS.escape(id)}"] .crown-fold`) === document.activeElement
    signature = ''
    render(lastState)
    unfolding = null
    if (held) root.querySelector(`.agent-row[data-unit="${CSS.escape(id)}"] .crown-fold`)?.focus()
  }
  /** Draw the bracket of every unfolded main to its subs as they lie: down their left side, or under them in a phone's strip. */
  function brackets() {
    const flat = getComputedStyle(root).flexDirection === 'row'
    const rail = !flat && document.documentElement.dataset.rail === 'folded'
    for (const [gi, main] of [...root.querySelectorAll('.agent-row.is-main[data-fold="open"]')].entries()) {
      const svg = main.querySelector('.crown-bracket')
      const subs = [...root.querySelectorAll(`.agent-row.is-sub[data-parent="${CSS.escape(main.dataset.unit)}"]`)]
      if (!svg || !subs.length) continue
      const G = main.getBoundingClientRect(), first = subs[0].getBoundingClientRect(), last = subs.at(-1).getBoundingClientRect()
      const w = i => wob(gi * 17 + i, 1.1)
      let pts
      if (flat) { const y = G.height + 3, x0 = first.left - G.left + 3, x1 = last.right - G.left - 3; pts = [[x0, y - 7], [x0 + w(1), y], [(x0 + x1) / 2, y - 1 + w(2)], [x1 + w(3), y], [x1, y - 7]] }
      else { const x = rail ? 3 : 13, y0 = first.top - G.top + 5, y1 = last.bottom - G.top - 5; pts = [[x + 8, y0], [x, y0 + w(1)], [x + w(2), (y0 + y1) / 2], [x, y1 + w(3)], [x + 8, y1]] }
      for (const p of svg.querySelectorAll('path')) p.setAttribute('d', penLine(pts))
    }
  }
  window.addEventListener('resize', () => requestAnimationFrame(brackets))
  new MutationObserver(() => requestAnimationFrame(brackets)).observe(document.documentElement, { attributes: true, attributeFilter: ['data-rail'] })

  function entry({ id, label, sub, lead, active, mark = null, tip = '', href = '/' }) {
    // A real link to the place (js/link.js): a plain click goes there in the page, the browser has the rest.
    const btn = link('agent-entry', href)
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
      if (a.other_desk) continue   // a session of another desk that knocks: its card is in the stack, its row is on its own desk
      const group = a.group && all.groups.find(g => g.id === a.group)
      if (!group) units.push({ id: a.id, members: [a] })
      else if (!units.some(u => u.id === group.id)) units.push({ id: group.id, members: group.members })
    }
    for (const u of units) Object.assign(u, summary(all, u.members, state.later))
    // A main and its subs (card Nr. 160): a session that names a main which stands here is listed under it,
    // one level deep. Without `parent` in the state (a hub that does not know it) every unit stands alone.
    const unitOf = new Map(units.flatMap(u => u.members.map(a => [a.id, u])))
    const mainOf = u => { const m = unitOf.get(u.members.map(a => a.parent).find(Boolean)); return m && m !== u ? m : null }
    for (const u of units) { const m = mainOf(u); if (m && !mainOf(m)) { u.parent = m; (m.subs ??= []).push(u) } }
    for (const u of units) {
      if (!u.subs) continue
      // Unfolded by hand, or because the session in view is one of its subs.
      u.unfolded = unfolded.has(u.id) || u.subs.some(s => s.id === scope)
      u.whole = summary(all, [u, ...u.subs].flatMap(x => x.members), state.later)
    }
    const fresh = all.queue.filter(id => !state.later.includes(id)).length
    // Of those, the knocks (urgent and blocking): they are what the inbox's badge shows first.
    const knocking = all.cards.filter(c => c.status === 'open' && isKnock(c) && all.queue.includes(c.id) && !state.later.includes(c.id)).length
    const working = units.filter(u => u.online && u.running).length
    const next = JSON.stringify([scope, document.body.dataset.page, fresh, knocking, working, units.map(u => [u.id, u.members.map(a => [a.id, a.name, a.mark, a.task, a.online, a.starred, a.cwd, a.host, a.parent, a.main]), u.open, u.running, u.stuck, u.unfolded])])
    if (next === signature) return
    signature = next

    const apart = tellApart(all.agents)
    const unitRow = u => {
      const single = u.members.length === 1 ? u.members[0] : null
      // A folded main speaks for its subs: its ring sums the group, and it carries the hand of a sub that knocks.
      const shut = Boolean(u.subs && !u.unfolded)
      const shown = shut ? u.whole : u
      const row = entry({
        id: u.id,
        label: single ? single.name : u.members.map(a => ({ member: a.id, text: [a.name, apart.get(a.id)].filter(Boolean).join(' · ') })),
        sub: single ? apart.get(single.id) : '',
        // With subs the corner of the mark is a switch of its own (it folds; on the crowned one it is the crown), so the mark draws none.
        lead: single ? avatar(single, { vip: !u.subs, working: false }) : pairAvatar(u.members),
        active: scope === u.id,
        tip: u.members.map(a => a.task).filter(Boolean).join(' · '),
        href: sessionPath(u.members.map(a => a.id)),
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
      if (u.parent) {
        row.classList.add('is-sub')
        row.dataset.parent = u.parent.id
        row.style.setProperty('--i', u.parent.subs.indexOf(u))
        if (u === u.parent.subs.at(-1)) row.classList.add('is-last')
        if (unfolding === u.parent.id) row.classList.add('is-unfolding')
      }
      if (u.members.some(a => a.main === true) || u.subs) row.classList.add('is-main')
      if (u.subs) {
        const names = u.subs.map(s => pairName(s.members)), who = pairName(u.members)
        row.dataset.fold = shut ? 'shut' : 'open'
        row.style.setProperty('--ghue', hueFor(u.members[0]))
        const tip = shut ? `Unfold ${who}'s ${names.length === 1 ? 'sub' : `${names.length} subs`}: ${names.join(', ')}` : `Fold ${who}'s subs`
        const toggle = e => { e.stopPropagation(); fold(u.id, shut) }
        // The switch on the corner of the main's mark, beside the entry (which opens the main's session). On the
        // desk's crowned session it is the crown. A main without the crown has it for the keyboard only (is-plain:
        // nothing drawn, shown as a ring when the keys are on it); the pointer folds by the stack or the bracket.
        const worn = u.members.some(crowned)
        const key = el('button', worn ? 'crown-fold' : 'crown-fold is-plain')
        key.type = 'button'
        key.setAttribute('aria-expanded', String(!shut))
        key.title = worn ? `${tip} · wears the crown: memos of this desk go here` : tip
        key.setAttribute('aria-label', key.title)
        if (worn) key.append(crown())
        key.addEventListener('click', toggle)
        row.append(key)
        if (shut) {
          // The subs as card edges behind the main's row, each in its own colour; the one that knocks is red.
          // With more subs than edges, those that knock keep theirs.
          const lie = u.subs.length > EDGES ? [...u.subs].sort((a, b) => Boolean(b.open && b.stuck) - Boolean(a.open && a.stuck)).slice(0, EDGES) : u.subs
          const edges = el('span', 'crown-edges')
          edges.title = tip
          row.style.setProperty('--n', lie.length)
          for (const [i, s] of lie.entries()) {
            const edge = el('i', s.open && s.stuck ? 'is-knock' : '')
            edge.style.setProperty('--i', i)
            edge.style.setProperty('--hue', hueFor(s.members[0]))
            const quirk = edgeQuirk(s.id)
            edge.style.setProperty('--tilt', `${quirk.tilt}deg`)
            edge.style.setProperty('--dx', `${quirk.dx}px`)
            edge.innerHTML = quirk.svg
            edges.append(edge)
          }
          edges.addEventListener('click', toggle)
          row.append(edges)
        } else {
          // The bracket: drawn once the rows lie (brackets()). Its second, wide stroke is only there to be hit.
          const svg = document.createElementNS(NS, 'svg')
          svg.setAttribute('class', `crown-bracket${unfolding === u.id ? ' is-unfolding' : ''}`)
          svg.setAttribute('aria-hidden', 'true')
          const hit = document.createElementNS(NS, 'path')
          hit.setAttribute('class', 'crown-bracket-hit')
          hit.addEventListener('click', toggle)
          const title = document.createElementNS(NS, 'title')
          title.textContent = tip
          hit.append(title)
          svg.append(document.createElementNS(NS, 'path'), hit)
          row.append(svg)
        }
      }
      // The state at the end of the row, a button of its own where there are questions to go through.
      // On a folded main whose subs have the questions, the ring unfolds the group: there they stand.
      const unfolds = shut && shown.open > u.open
      const walk = unfolds ? () => fold(u.id, true) : onWalk && (() => onWalk(u.id))
      const state = badge(shown, pairName(u.members), walk, unfolds ? null : walkPath(sessionPath(u.members.map(a => a.id))))
      if (state) {
        row.classList.add('has-badge'); row.append(state)
        if (shut && shown.open > u.open) { state.title = `${state.title.split(' · ').at(-1)} · with its subs: click to unfold`; state.setAttribute('aria-label', state.title) }
      }
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
    // A main stands with its subs right under it (when unfolded); the group is here while any of it is connected.
    const top = units.filter(u => !u.parent)
    const rows = u => [unitRow(u), ...(u.subs && u.unfolded ? u.subs.map(unitRow) : [])]
    const live = u => u.online || Boolean(u.subs?.some(s => s.online))
    const here = top.filter(live), away = top.filter(u => !live(u))
    root.replaceChildren(
      ...here.flatMap(rows),
      ...(away.length ? [el('h2', 'caps agent-heading agent-heading-away', 'Disconnected'), ...away.flatMap(rows)] : []),
    )
    brackets()
    requestAnimationFrame(brackets)
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
    // A main moves past whole groups, a sub among the subs of its main.
    const peers = rows.filter(r => r.dataset.parent === row?.dataset.parent)
    const at = peers.indexOf(row)
    if (at < 0 || !peers[at + by]) return false
    const held = row.contains(document.activeElement)
    const unit = row.dataset.unit
    const first = r => r?.dataset.members.split(' ')[0] ?? null
    moveSession(first(row), by < 0 ? first(peers[at - 1]) : first(peers[at + 2])).catch(() => {})
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
    if (!row || e.button || e.target.closest('.agent-archive, .agent-cut, .crown-toggle, .crown-fold, .crown-edges, .crown-bracket, a.agent-badge, button.agent-badge')) return
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

/** Unfold the group a session lies in, so that its row stands in the sidebar (for a jump to it from elsewhere). */
export function revealSession(id) {
  const parent = getState().all.agents.find(a => a.id === id)?.parent
  if (!parent || unfolded.has(parent)) return
  document.querySelector(`#agents .agent-row[data-unit="${CSS.escape(parent)}"][data-fold="shut"] .crown-fold`)?.click()
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

// Rename: a small form right at the name that was pressed (anchor; without one, the control that has the
// keyboard). No veil over the page: Escape, Cancel or a click beside it closes; Enter saves.
let editor = null
export function openEditor(agent, anchor = null) {
  editor?.remove()
  const at = anchor ?? (document.activeElement?.getClientRects?.().length && document.activeElement !== document.body ? document.activeElement : null)
  const dialog = editor = el('dialog', 'session-editor')
  dialog.setAttribute('aria-label', `Rename the session ${agent.name}`)
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
  const label = el('label', 'caps', 'Rename the session')
  label.htmlFor = name.id
  form.append(label, name, error, row)
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
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close() })
  dialog.addEventListener('close', () => dialog.remove())
  document.body.append(dialog)
  dialog.showModal()
  // Under what was pressed, or above it where there is no room below; never outside the window.
  const a = at?.getBoundingClientRect()
  if (a?.width) {
    const w = dialog.offsetWidth, h = dialog.offsetHeight
    dialog.dataset.anchored = ''
    dialog.style.left = `${Math.max(8, Math.min(a.left, window.innerWidth - w - 8))}px`
    dialog.style.top = `${a.bottom + 8 + h > window.innerHeight - 8 ? Math.max(8, a.top - h - 8) : a.bottom + 8}px`
  }
  name.select()
}
