// Stack: the second shell of the page (css/stack.css). Off unless <html data-layout="stack">
// (js/layout-boot.js: ?layout=stack once, then remembered; ?layout=sidebar goes back).
//
// What this file adds, and nothing else of the page is rebuilt for it:
//   - the entry in the logo's menu that flips the layout (in both layouts)
//   - the dock: "All" (the questions, the home), "Table" (the overview of the sessions, js/table.js),
//     then one mark per session or per group laid together, with what it needs on the mark's corner
//   - a line under a session's name: what it is at, its model and machine
// Going somewhere is the page's own business (js/app.js: addresses, Back and Forward): the dock
// presses the controls the sidebar layout uses (#nav-inbox, #nav-roster, the sidebar's rows, which
// are still built, only not shown). So every address, key and test hook stays as it is.

import { subscribe, getState } from './store.js'
import { avatar, pairAvatar, tellApart } from './agents.js'
import { el, sketch, bareHand, sweepMark } from './ui.js'
import { mountTable } from './table.js'

const root = document.documentElement
const body = document.body
const $ = id => document.getElementById(id)
const isStack = () => root.dataset.layout === 'stack'

// ---- what a session, or several laid together, need right now (the sidebar's rule, js/agents.js) ----

/** One unit per session, or per group of sessions laid together, in the server's order. */
export function unitsOf(all) {
  const units = []
  for (const a of all.agents) {
    const group = a.group && all.groups.find(g => g.id === a.group)
    if (!group) units.push({ id: a.id, members: [a] })
    else if (!units.some(u => u.id === group.id)) units.push({ id: group.id, members: group.members })
  }
  for (const u of units) Object.assign(u, summaryOf(all, u.members))
  return units
}

/** open: its questions that wait; running: it has work in progress; stuck: it cannot go on without the human. */
export function summaryOf(all, members) {
  const ids = new Set(members.map(a => a.id))
  const mine = all.cards.filter(c => ids.has(c.agent) && c.status === 'open' && all.queue.includes(c.id))
  const tasks = all.tasks.filter(t => ids.has(t.agent))
  const online = members.some(a => a.online)
  const running = members.some(a => a.online && tasks.some(t => t.agent === a.id && t.state === 'working'))
  const stuck = mine.some(c => c.urgency === 'critical' || c.kind === 'permission')
  return { open: mine.length, tasks, online, running, stuck }
}

/** The state as one word: away (not connected), needs (a question waits), working, idle. */
export const stateOf = s => (!s.online ? 'away' : s.open ? 'needs' : s.running ? 'working' : 'idle')
export const stateText = s => {
  const questions = s.open === 1 ? '1 question' : `${s.open} questions`
  if (!s.online) return s.open ? `disconnected, ${questions} open` : 'disconnected'
  if (s.open) return s.running && !s.stuck ? `working, ${questions} open` : `waiting for you: ${questions}`
  return s.running ? 'working' : 'connected, nothing open'
}

/** The mark of a session's state, as in the sidebar: a hand with the count while it waits for the
 *  human, a stroke swept round the count while it works, grey and still when it is not connected. */
const SWEEP_TURN = 3400
export function stateBadge({ open, online, running, stuck }) {
  if (!open && !(online && running)) return null
  const node = el('span', 'agent-badge')
  const count = open ? el('b', null, String(open)) : null
  if (online ? stuck || !running : stuck) {
    node.dataset.state = 'waiting'
    node.append(bareHand())
    if (count) node.append(count)
  } else {
    node.dataset.state = online ? 'running' : 'open'
    const spot = el('span', 'agent-sweep')
    if (online) {
      const sweep = sweepMark()
      sweep.style.animationDelay = `${-(Date.now() % SWEEP_TURN)}ms`
      spot.append(sweep)
    }
    if (count) spot.append(count)
    node.append(spot)
  }
  if (!online) node.dataset.offline = ''
  node.title = stateText({ open, online, running, stuck })
  return node
}

// ---- going somewhere: through the page's own controls ----

/** null: the questions (home). 'table': the overview. Else a session's or a group's id. */
export function go(id) {
  if (id == null) return void $('nav-inbox')?.click()
  if (id === 'table') return void $('nav-roster')?.click()
  const row = [...document.querySelectorAll('#agents .agent-row[data-unit]')]
    .find(r => r.dataset.unit === id || (r.dataset.members ?? '').split(' ').includes(id))
  row?.querySelector('.agent-entry')?.click()
}

/** Open one question as a window of its own (null: walk through all of them): by its address, which the page follows. */
export function openQuestion(cardId) {
  const params = new URLSearchParams(location.search)
  params.set('q', cardId == null ? 'next' : String(getState().all.cards.find(c => c.id === cardId)?.number ?? cardId))
  history.pushState({ q: cardId ?? 'next' }, '', `${location.pathname}?${params}${location.hash}`)
  window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
}

// ---- the entry in the logo's menu: flip the layout ----

{
  const menu = $('brand-doors')
  if (menu) {
    const flip = el('a', 'layout-flip')
    flip.setAttribute('role', 'menuitem')
    flip.href = `/?layout=${isStack() ? 'sidebar' : 'stack'}`
    flip.append(sketch('reverse'), isStack() ? 'Back to the sidebar' : 'Try the new layout')
    // The place stays: only the shell changes.
    flip.addEventListener('click', e => {
      e.preventDefault()
      location.assign(`${location.pathname}?layout=${isStack() ? 'sidebar' : 'stack'}`)
    })
    menu.append(flip)
  }
}

// ---- the dock ----

function mountDock(dock) {
  let signature = ''
  const entry = (cls, lead, name) => {
    const b = el('button', `dock-entry ${cls}`.trim())
    b.type = 'button'
    b.append(lead, el('span', 'dock-name', name))
    return b
  }
  const ico = name => { const i = el('span', 'dock-ico'); i.append(sketch(name)); return i }

  function render(state) {
    const { all, scope } = state
    const page = body.dataset.page ?? ''
    const units = unitsOf(all)
    const fresh = all.queue.filter(id => !state.later.includes(id)).length
    const next = JSON.stringify([scope, page, fresh, units.map(u => [u.id, u.members.map(a => [a.id, a.name, a.mark, a.task, a.online, a.starred, a.cwd, a.host]), u.open, u.running, u.stuck])])
    if (next === signature) return
    signature = next
    const held = dock.contains(document.activeElement) ? document.activeElement.dataset.place : null

    const tray = el('span', 'agent-avatar agent-all')
    tray.append(el('i'), el('i'), el('i'))
    const home = entry('dock-all', tray, 'All')
    home.dataset.place = 'all'
    home.title = fresh ? `All questions: ${fresh} wait for you` : 'All questions'
    if (fresh) home.append(el('b', 'agent-count', fresh > 99 ? '99+' : String(fresh)))
    if (!page && scope == null) home.setAttribute('aria-current', 'true')
    home.addEventListener('click', () => go(null))

    const table = entry('dock-table', ico('heads'), 'Table')
    table.dataset.place = 'table'
    table.title = 'Table: every session, to find, answer, pair and order'
    if (page === 'roster') table.setAttribute('aria-current', 'true')
    table.addEventListener('click', () => go('table'))

    const apart = tellApart(all.agents)
    const unit = u => {
      const single = u.members.length === 1 ? u.members[0] : null
      const b = entry(single ? '' : 'is-group', single ? avatar(single) : pairAvatar(u.members), u.members.map(a => a.name).join(' + '))
      b.dataset.unit = u.id
      b.dataset.place = u.id
      if (!u.online) b.dataset.off = ''
      if (!page && scope === u.id) b.setAttribute('aria-current', 'true')
      const names = u.members.map(a => [a.name, apart.get(a.id)].filter(Boolean).join(' · ')).join(' + ')
      b.title = [names, stateText(u), u.members.map(a => a.task).filter(Boolean).join(' · ')].filter(Boolean).join('\n')
      b.setAttribute('aria-label', `${names}: ${stateText(u)}`)
      const mark = stateBadge(u)
      if (mark) { mark.removeAttribute('title'); b.append(mark) }
      b.addEventListener('click', () => go(u.id))
      return b
    }
    const here = units.filter(u => u.online), away = units.filter(u => !u.online)
    const sep = cls => el('i', `dock-sep ${cls}`.trim())
    // The first place is kept free: the switch between workspaces will stand there.
    const slot = el('span', 'dock-slot')
    slot.dataset.slot = 'workspace'
    dock.replaceChildren(slot, home, table, ...(units.length ? [sep('is-solid')] : []), ...here.map(unit), ...(away.length && here.length ? [sep('')] : []), ...away.map(unit))
    if (held) dock.querySelector(`[data-place="${CSS.escape(held)}"]`)?.focus({ preventScroll: true })
  }
  return { render, reset: () => { signature = '' } }
}

// ---- a session's title: the line under the name ----

function mountNow(node) {
  let signature = ''
  return state => {
    const members = state.members.map(id => state.all.agents.find(a => a.id === id)).filter(Boolean)
    const a = members.length === 1 ? members[0] : null
    const words = a ? (a.online ? a.task || 'connected' : 'disconnected') : ''
    const facts = a ? [a.model, a.host].filter(Boolean).join(' · ') : ''
    const next = `${words}\n${facts}`
    if (next === signature) return
    signature = next
    node.replaceChildren(...(words ? [el('span', null, words)] : []), ...(facts ? [el('span', 'caps', facts)] : []))
  }
}

// ---- mount: only where the layout is on ----

if (isStack()) {
  const dockNode = el('nav')
  dockNode.id = 'stack-dock'
  dockNode.setAttribute('aria-label', 'Questions, table and sessions')
  const bar = document.querySelector('.topbar')
  const after = bar?.querySelector('.footnav') ?? bar?.querySelector('.brand')
  if (after) after.after(dockNode)
  else body.append(dockNode)
  const dock = mountDock(dockNode)

  const nowNode = el('p', 'stack-now')
  $('pane-who')?.after(nowNode)
  const now = mountNow(nowNode)

  const tableNode = el('main')
  tableNode.id = 'table'
  tableNode.setAttribute('aria-label', 'Table')
  $('roster')?.after(tableNode)
  const table = mountTable(tableNode, { go, openQuestion })

  let lastPlace
  const inSight = () => {
    const place = `${body.dataset.page ?? ''}|${getState().scope ?? ''}`
    if (place === lastPlace) return
    lastPlace = place
    requestAnimationFrame(() => dockNode.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest', inline: 'center' }))
  }
  subscribe(state => { dock.render(state); now(state); table.render(state); inSight() })

  // The page says where it is on <body> (data-page, data-scope, data-filter); the dock follows.
  new MutationObserver(() => {
    // "Questions only" has no meaning here: a session's questions always stand beside its conversation.
    // Asked for by an old link, a key or a line in the conversation, it is taken back at once, in place.
    if (body.dataset.filter === 'questions') {
      delete body.dataset.filter
      $('filter-questions')?.setAttribute('aria-pressed', 'false')
      if (/\/questions$/.test(location.pathname)) history.replaceState(history.state, '', location.pathname.replace(/\/questions$/, '') + location.search + location.hash)
    }
    dock.render(getState())
    table.shown()
    inSight()
  }).observe(body, { attributes: true, attributeFilter: ['data-page', 'data-scope', 'data-filter'] })
}
