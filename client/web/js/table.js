// The Table: the overview of the sessions in the Stack layout (css/table.css), at /agents.
// Every session lies on a table top as its mark, sized by how many questions it has open:
// the ones that need you first, then the working, the idle, the ones that are away.
//   - find a session (name, machine, model, task, folder) and show one state only
//   - pick a mark: the slip beside the table shows that session's questions, to answer right there,
//     with what the board knows of it (rename, drawing, VIP, model, machine, folder), and the way
//     into its conversation; a second click, or Enter, opens it
//   - push one mark onto another: the two are laid together; pull one out of its loop: it leaves
//   - push a mark between two others: it moves there, in the dock too (the order is the server's)
//   - sessions put away stand below, to fetch back
// On a phone the table is a plain list of marks with their counts; a tap opens the session.
//
// Keys, while the table is up (heard here; js/keys.js does not list them yet):
//   /            find            arrows       to the next mark that way
//   Enter        open (or: lay together with the one picked by +)
//   + or =       lay together with…, then pick the partner; on one of a group: take it out
//   Shift+arrow  move the mark one place      Esc   let go of the mark
// Answering in the slip is the list's own business (js/inbox.js: J K, Y N, L, C, 1…9).

import { getState, pair, unpair, archive, moveSession, editSession, reopen } from './store.js'
import { avatar, crownToggle, tellApart, openMarkPicker, openEditor } from './agents.js'
import { mountInbox } from './inbox.js'
import { el, sketch, groupLoop, ago } from './ui.js'
import { say, pageHost } from './back.js'
import { unitsOf, summaryOf, stateOf, stateText, stateBadge } from './stack.js'

const STATES = [['all', 'All'], ['needs', 'Needs you'], ['working', 'Working'], ['idle', 'Idle'], ['away', 'Away']]
const ZONES = STATES.slice(1)
const TIDY = [['need', 'need'], ['host', 'machine'], ['name', 'name']]
const phone = matchMedia('(max-width: 860px)')
const typingIn = node => Boolean(node?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])'))
// A mark lies a little crooked, always the same way: as if put there by hand.
const tilt = id => { let h = 7; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return ((h % 9) - 4) * .55 }
const SVG = 'http://www.w3.org/2000/svg'
function glass() {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('class', 'ico')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(SVG, 'path')
  path.setAttribute('d', 'M17 11a6 6 0 1 1-12 0 6 6 0 0 1 12 0zM15.500 15.500L20 20')
  svg.append(path)
  return svg
}
const button = (cls, text) => { const b = el('button', cls, text); b.type = 'button'; return b }

/** go(id): open a session or group. openQuestion(cardId): that question as a window. Returns { render(state), shown() }. */
export function mountTable(root, { go, openQuestion }) {
  const view = { find: '', only: 'all', tidy: 'need', cursor: '', pairFrom: '' }
  let last = null        // the state drawn last
  let units = []         // as drawn: [{ id, members, open, … }]
  let sums = new Map()   // session id -> its own summary

  // ---- the page, built once ----
  const head = el('header', 'table-head')
  const lead = el('p')
  head.append(el('h2', null, 'Table'), lead)

  const find = el('input')
  find.type = 'search'
  find.autocomplete = 'off'
  find.placeholder = 'Find a session, a machine, a model'
  find.setAttribute('aria-label', 'Find a session')
  const findBox = el('label', 't-find')
  findBox.append(glass(), find, el('kbd', null, '/'))
  const chips = el('div', 't-chips')
  chips.setAttribute('role', 'group')
  chips.setAttribute('aria-label', 'Show')
  const tidy = el('div', 't-tidy')
  tidy.setAttribute('role', 'group')
  tidy.setAttribute('aria-label', 'Tidy the table')
  const tools = el('div', 'table-tools')
  tools.append(findBox, chips, tidy)

  const top = el('div', 'table-top')
  const slip = el('aside', 'table-slip')
  slip.setAttribute('aria-label', 'The session that is picked')
  const hint = el('p', 'table-hint')
  const main = el('div', 'table-main')
  main.append(top, hint)
  const bodyNode = el('div', 'table-body')
  bodyNode.append(main, slip)
  const shelf = el('section', 'table-archive')
  const page = el('div', 'table-page')
  page.append(head, tools, bodyNode, shelf)
  root.append(page)

  const isShown = () => root.getClientRects().length > 0
  const agentOf = id => last?.all.agents.find(a => a.id === id) ?? null
  const unitOf = id => units.find(u => u.members.some(a => a.id === id)) ?? null
  const hit = a => {
    const words = view.find.trim().toLowerCase()
    return (view.only === 'all' || stateOf(sums.get(a.id)) === view.only)
      && (!words || [a.name, a.given, a.host, a.model, a.task, a.cwd, a.client].filter(Boolean).join(' ').toLowerCase().includes(words))
  }
  const filtered = () => view.only !== 'all' || Boolean(view.find.trim())

  // ---- find, show, tidy ----
  let toolsSig = ''
  function paintTools(all) {
    const count = key => (key === 'all' ? all.agents.length : all.agents.filter(a => stateOf(sums.get(a.id)) === key).length)
    const sig = JSON.stringify([view.only, view.tidy, STATES.map(([key]) => count(key))])
    if (sig === toolsSig) return
    toolsSig = sig
    chips.replaceChildren(...STATES.map(([key, label]) => {
      const b = button(null, label)
      b.append(el('b', null, String(count(key))))
      b.setAttribute('aria-pressed', String(view.only === key))
      b.addEventListener('click', () => { view.only = key; if (view.cursor && !hit(agentOf(view.cursor))) view.cursor = ''; paint() })
      return b
    }))
    tidy.replaceChildren(el('span', 'caps', 'Tidy by'), ...TIDY.map(([key, label]) => {
      const b = button(null, label)
      b.setAttribute('aria-pressed', String(view.tidy === key))
      b.addEventListener('click', () => { view.tidy = key; paint() })
      return b
    }))
  }
  find.addEventListener('input', () => {
    view.find = find.value
    if (view.cursor && !hit(agentOf(view.cursor))) view.cursor = ''
    paint()
  })

  // ---- the table top ----
  function zones() {
    if (view.tidy === 'host') {
      const hosts = [...new Set(units.map(u => u.members[0].host || ''))].sort((a, b) => (!a) - (!b) || a.localeCompare(b))
      return hosts.map(h => [h || 'Machine unknown', units.filter(u => (u.members[0].host || '') === h)])
    }
    if (view.tidy === 'name') return [['A to Z', [...units].sort((a, b) => a.members[0].name.localeCompare(b.members[0].name, 'en', { sensitivity: 'base' }))]]
    return ZONES.map(([key, label]) => [label, units.filter(u => stateOf(u) === key)])
  }
  let topSig = ''
  function paintTop(all) {
    const apart = tellApart(all.agents)
    const sig = JSON.stringify([view, phone.matches, units.map(u => [u.id, u.open, u.running, u.stuck, u.members.map(a => [a.id, a.name, a.mark, a.online, a.starred, a.host, apart.get(a.id), sums.get(a.id)?.open, sums.get(a.id)?.running, sums.get(a.id)?.stuck])])])
    if (sig === topSig) return
    topSig = sig
    const held = top.contains(document.activeElement) ? document.activeElement.dataset?.tok : null
    const token = a => {
      const s = sums.get(a.id)
      const b = button('tok')
      b.dataset.tok = a.id
      b.dataset.state = stateOf(s)
      b.style.setProperty('--sz', `${Math.min(78, 48 + s.open * 6)}px`)
      b.title = `${a.name}: ${stateText(s)}`
      b.setAttribute('aria-label', `${a.name}: ${stateText(s)}`)
      b.setAttribute('aria-pressed', String(view.cursor === a.id))
      if (view.cursor === a.id) b.classList.add('is-cursor')
      if (view.pairFrom === a.id) b.classList.add('is-pairing')
      if (!hit(a)) { b.classList.add('is-dim'); b.tabIndex = -1 }
      const face = el('span', 'tok-face')
      face.append(avatar(a))
      const mark = stateBadge(s)
      if (mark) { mark.removeAttribute('title'); face.append(mark) }
      const text = el('span', 'tok-text')
      text.append(el('strong', null, a.name))
      const line = phone.matches ? stateText(s) : apart.get(a.id)
      if (line) text.append(el('small', null, line))
      b.append(face, text)
      return b
    }
    const spot = u => {
      const node = el('div', 't-spot')
      node.dataset.unit = u.id
      node.dataset.members = u.members.map(a => a.id).join(' ')
      node.style.setProperty('--tilt', `${tilt(u.id)}deg`)
      node.append(...u.members.map(token))
      if (u.members.length > 1) {
        node.classList.add('is-pair')
        node.append(groupLoop(u.members.map(a => a.id).join('+')))
        const cut = button('t-unpair')
        cut.title = 'Pull them apart'
        cut.setAttribute('aria-label', `Pull apart ${u.members.map(a => a.name).join(' + ')}`)
        cut.append(sketch('snip'))
        cut.addEventListener('click', () => { for (const a of u.members) editSession(a.id, { group: null }).catch(() => {}) })
        node.append(cut)
      }
      if (!u.members.some(hit)) node.classList.add('is-dim')
      return node
    }
    const parts = []
    for (const [label, list] of zones()) {
      if (!list.length) continue
      const zone = el('section', 't-zone')
      const spots = el('div', 't-spots')
      spots.append(...list.map(spot))
      zone.append(el('h3', 'caps', label), spots)
      parts.push(zone)
    }
    if (!all.agents.length) parts.push(el('p', 't-none', 'No session is connected yet.'))
    else if (!all.agents.some(hit)) {
      const none = el('p', 't-none', 'No session fits. ')
      const clear = button('t-link', 'Show all')
      clear.addEventListener('click', () => { view.find = find.value = ''; view.only = 'all'; paint() })
      none.append(clear)
      parts.push(none)
    }
    top.toggleAttribute('data-pairing', Boolean(view.pairFrom))
    top.replaceChildren(...parts)
    if (held) top.querySelector(`.tok[data-tok="${CSS.escape(held)}"]`)?.focus({ preventScroll: true })
  }

  // ---- the line under the table: what the keys do, or what is going on ----
  let hintSig = ''
  function paintHint() {
    const from = agentOf(view.pairFrom)
    const sig = from ? `pair:${from.name}` : 'keys'
    if (sig === hintSig) return
    hintSig = sig
    hint.classList.toggle('is-live', Boolean(from))
    if (from) return hint.replaceChildren('Laying ', el('b', null, from.name), ' together with: pick the other one on the table (arrows and Enter, or a click). Esc lets go.')
    const part = (keys, words) => { const s = el('span'); s.append(...keys.map(k => el('kbd', null, k)), words); return s }
    hint.replaceChildren(part(['←↑↓→'], 'to a mark'), part(['↵'], 'open'), part(['Y', 'N'], 'answer in the slip'), part(['+'], 'lay together'), part(['⇧', '←→'], 'move'), el('span', null, 'or push one mark onto another'))
  }

  // ---- the slip: the session that is picked, with its questions to answer on the spot ----
  const lists = new Map()   // session id -> { node, inbox }; built once per session, so its rows keep their state
  const onDecided = (card, option) => say(pageHost(), { head: `Answered: ${option.label}`, title: card.title, back: () => reopen(card.id) })
  function listOf(id) {
    if (!lists.has(id)) {
      const node = el('div', 'session-cards slip-list')
      lists.set(id, { node, inbox: mountInbox(node, { onOpen: cardId => openQuestion(cardId), onDecided, agent: id }) })
    }
    return lists.get(id)
  }
  let slipSig = ''
  function paintSlip(state) {
    const all = state.all
    const a = agentOf(view.cursor)
    for (const id of lists.keys()) if (!all.agents.some(x => x.id === id)) lists.delete(id)
    if (!a || phone.matches) {
      if (slipSig !== 'none') {
        slipSig = 'none'
        slip.classList.add('is-empty')
        const note = el('p', 'slip-none')
        note.append(el('strong', null, 'Pick a mark.'), ' Its questions can be answered right here; a second click opens its conversation.')
        slip.replaceChildren(note)
      }
      return
    }
    const s = sums.get(a.id)
    const group = all.groups.find(g => g.id === a.group)
    const sig = JSON.stringify([a, s.open, s.running, s.stuck, s.tasks, group?.members.map(m => m.name), all.agents.length])
    const list = listOf(a.id)
    if (sig !== slipSig) {
      slipSig = sig
      slip.classList.remove('is-empty')
      const headNode = el('header', 'slip-head')
      // The picture is the way to its drawing, the name the way to rename it, the crown the switch for VIP.
      const mark = button('slip-mark')
      mark.title = 'Choose a drawing'
      mark.setAttribute('aria-label', `${a.name}: choose a drawing`)
      mark.setAttribute('aria-haspopup', 'dialog')
      mark.append(avatar(a, { vip: false }))
      mark.addEventListener('click', () => openMarkPicker(a, mark))
      const who = el('div', 'slip-who')
      const name = button('slip-name')
      name.title = 'Rename'
      name.append(el('strong', null, a.name))
      name.addEventListener('click', () => openEditor(a))
      who.append(name, el('span', null, a.online ? a.task || stateText(s) : `disconnected, last seen ${ago(a.seen ?? a.joined ?? Date.now())}`))
      const close = button('slip-close')
      close.title = 'Close (Esc)'
      close.setAttribute('aria-label', 'Close')
      close.append('×')
      close.addEventListener('click', () => drop())
      headNode.append(mark, crownToggle(a, 'slip-crown'), who, close)

      const facts = el('dl', 'slip-facts')
      const fact = (term, value) => { if (!value) return; const box = el('div'); box.append(el('dt', null, term), el('dd', null, value)); facts.append(box) }
      fact('Model', a.model)
      fact('Machine', [a.host, a.platform].filter(Boolean).join(' · '))
      fact('Folder', a.cwd)
      fact('Program', a.client)
      fact('Connected', a.online && a.connected ? ago(a.connected) : '')
      const lights = el('div', 'roster-tasks')
      for (const t of s.tasks) {
        const pill = el('span', 'roster-task', t.detail ? `${t.label}: ${t.detail}` : t.label)
        pill.dataset.state = t.state
        lights.append(pill)
      }

      const foot = el('footer', 'slip-actions')
      const open = button('t-act is-lead', 'Open the conversation')
      open.append(el('kbd', null, '↵'))
      open.addEventListener('click', () => go(a.id))
      foot.append(open)
      if (group) {
        const split = button('t-act', `Take out of ${group.members.filter(m => m.id !== a.id).map(m => m.name).join(' + ')}`)
        split.addEventListener('click', () => unpair(a.id).catch(() => {}))
        foot.append(split)
      } else if (all.agents.length > 1) {
        const together = button('t-act', 'Lay together with…')
        together.append(el('kbd', null, '+'))
        together.addEventListener('click', () => togglePair(a.id))
        foot.append(together)
      }
      if (!a.online) {
        const away = button('t-act', 'Archive')
        away.addEventListener('click', () => archive(a.id).then(() => drop(), () => {}))
        foot.append(away)
      }
      slip.replaceChildren(headNode, list.node, ...(s.tasks.length ? [lights] : []), ...(facts.children.length ? [facts] : []), foot)
    }
    list.inbox.render(state)
  }

  // ---- put away ----
  let shelfSig = ''
  function paintShelf(all) {
    const sig = JSON.stringify(all.archived.map(a => [a.id, a.name, a.mark, a.seen]))
    if (sig === shelfSig) return
    shelfSig = sig
    shelf.hidden = !all.archived.length
    if (shelf.hidden) return shelf.replaceChildren()
    const label = el('h3', 'caps', `Archive · ${all.archived.length === 1 ? '1 session' : `${all.archived.length} sessions`}`)
    shelf.replaceChildren(label, ...all.archived.map(a => {
      const row = el('div', 't-archived')
      const text = el('span', 't-archived-text')
      text.append(el('strong', null, a.name), el('span', null, `last seen ${ago(a.seen ?? a.joined ?? Date.now())}`))
      const back = button('t-link', 'Fetch back')
      back.addEventListener('click', () => archive(a.id, false).catch(() => {}))
      row.append(avatar(a), text, back)
      return row
    }))
  }

  function render(state) {
    last = state
    const all = state.all
    units = unitsOf(all)
    sums = new Map(all.agents.map(a => [a.id, summaryOf(all, [a])]))
    if (view.cursor && !agentOf(view.cursor)) view.cursor = ''
    if (view.pairFrom && !agentOf(view.pairFrom)) view.pairFrom = ''
    const online = all.agents.filter(a => a.online).length
    const waiting = all.queue.filter(id => !state.later.includes(id)).length
    lead.textContent = `${online} of ${all.agents.length} sessions are connected${waiting ? `, ${waiting === 1 ? '1 question waits' : `${waiting} questions wait`} for you` : ''}.`
    paintTools(all)
    paintTop(all)
    paintHint()
    paintSlip(state)
    paintShelf(all)
  }
  const paint = () => { if (last) render(last) }
  phone.addEventListener('change', paint)

  // ---- acting on the table ----
  function point(id, focus = false) {
    view.cursor = id
    paint()
    if (focus) top.querySelector('.tok.is-cursor')?.focus({ preventScroll: true })
    top.querySelector('.tok.is-cursor')?.scrollIntoView({ block: 'nearest' })
  }
  function drop() {
    const had = top.contains(document.activeElement) || slip.contains(document.activeElement)
    view.cursor = view.pairFrom = ''
    paint()
    if (had) document.activeElement?.blur?.()
  }
  function join(a, b) {
    view.pairFrom = ''
    view.cursor = b
    pair(a, b).catch(() => {})
    paint()
  }
  /** One of a group leaves it; one that stands alone waits for its partner to be picked. */
  function togglePair(id) {
    if (agentOf(id)?.group) return void unpair(id).catch(() => {})
    view.pairFrom = view.pairFrom === id ? '' : id
    paint()
  }
  /** The cursor goes to the nearest mark in the direction of the arrow. */
  function moveCursor(key) {
    const toks = [...top.querySelectorAll('.tok:not(.is-dim)')].map(node => { const b = node.getBoundingClientRect(); return { id: node.dataset.tok, x: b.left + b.width / 2, y: b.top + b.height / 2 } })
    if (!toks.length) return
    const from = toks.find(t => t.id === view.cursor)
    if (!from) return point(toks[0].id, true)
    const [dx, dy] = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[key]
    let best = null, score = Infinity
    for (const t of toks) {
      const along = (t.x - from.x) * dx + (t.y - from.y) * dy, across = Math.abs((t.x - from.x) * dy) + Math.abs((t.y - from.y) * dx)
      if (t.id === from.id || along < 12) continue
      const sc = along + across * 2
      if (sc < score) { score = sc; best = t }
    }
    if (best) point(best.id, true)
  }
  /** The session the server's order names as "before": the first of the unit that follows u, or null for the end. */
  const beforeAfter = u => { const next = units[units.indexOf(u) + 1]; return next ? next.members[0].id : null }
  /** Move the picked mark one place, among the marks of its own zone. */
  function stepOrder(by) {
    const u = unitOf(view.cursor)
    if (!u || view.tidy !== 'need') return false
    const zone = units.filter(x => stateOf(x) === stateOf(u))
    const to = zone[zone.indexOf(u) + by]
    if (!to) return false
    moveSession(u.members[0].id, by < 0 ? to.members[0].id : beforeAfter(to)).catch(() => {})
    return true
  }

  top.addEventListener('click', e => {
    if (e.target.closest('.t-unpair, .t-link')) return
    const tok = e.target.closest('.tok')
    if (!tok) { if (view.cursor && !view.pairFrom) drop(); return }
    const id = tok.dataset.tok
    if (view.pairFrom) return view.pairFrom === id ? togglePair(id) : join(view.pairFrom, id)
    // A phone has no slip: a tap opens. Elsewhere the first click picks, the second opens.
    if (phone.matches || view.cursor === id) return go(id)
    point(id)
  })

  // ---- carrying a mark: onto another (lay together), between two (move), out of its loop (leave) ----
  // A mouse drags at once; a finger holds still for a moment first, so the page still scrolls.
  let drag = null   // { id, tok, spot, grouped, x, y, ghost, at, timer }
  const spotsNow = () => [...top.querySelectorAll('.t-spot')]
  const zoneOfSpot = spot => spot.closest('.t-zone')
  /** What letting go at (x, y) would do: { pair: tok } | { before: spot | null, mark: spot, after } | { out: true } | null. */
  function landing(x, y) {
    const under = document.elementFromPoint(x, y)
    // Onto the picture of another mark: the two are laid together. Beside it, or on its name: a move.
    const tok = under?.closest?.('.tok-face')?.closest('.tok')
    if (tok && top.contains(tok) && tok.dataset.tok !== drag.id && !tok.classList.contains('is-dim')) {
      const mine = drag.spot.dataset.members.split(' ')
      // Onto one of its own group: nothing changes.
      return mine.includes(tok.dataset.tok) ? null : { pair: tok }
    }
    const box = top.getBoundingClientRect()
    const inside = x >= box.left && x <= box.right && y >= box.top && y <= box.bottom
    if (drag.grouped) return drag.spot.contains(under) ? null : { out: true }
    if (!inside || view.tidy !== 'need') return null
    // Between the marks of its own zone: before the first one that follows the pointer in reading order.
    const zone = zoneOfSpot(drag.spot)
    const zbox = zone.getBoundingClientRect()
    if (y < zbox.top || y > zbox.bottom) return null
    const spots = [...zone.querySelectorAll('.t-spot')]
    const own = spots.indexOf(drag.spot)
    const others = spots.filter(s => s !== drag.spot)
    const next = others.find(s => { const r = s.getBoundingClientRect(); return y < r.top || (y <= r.bottom && x < r.left + r.width / 2) }) ?? null
    const at = next ? spots.indexOf(next) : spots.length
    if (at === own || at === own + 1) return null   // where it already is
    return next ? { before: next, mark: next, after: false } : { before: null, mark: others.at(-1), after: true }
  }
  const unmark = () => { for (const n of top.querySelectorAll('.is-drop, .is-insert-before, .is-insert-after')) n.classList.remove('is-drop', 'is-insert-before', 'is-insert-after') }
  function begin() {
    const agent = agentOf(drag.id)
    if (!agent) return end()
    drag.ghost = avatar(agent)
    drag.ghost.classList.add('agent-ghost', 't-ghost')
    document.body.append(drag.ghost)
    drag.tok.classList.add('is-carried')
    document.body.classList.add('is-pairing')
    move(drag.x, drag.y)
  }
  function move(x, y) {
    drag.ghost.style.translate = `${x - 24}px ${y - 24}px`
    const at = landing(x, y)
    drag.spot.classList.toggle('is-leaving', Boolean(at?.out))
    unmark()
    drag.at = at
    if (at?.pair) at.pair.classList.add('is-drop')
    if (at?.mark) at.mark.classList.add(at.after ? 'is-insert-after' : 'is-insert-before')
  }
  function end() {
    if (!drag) return
    clearTimeout(drag.timer)
    drag.ghost?.remove()
    drag.tok.classList.remove('is-carried')
    drag.spot.classList.remove('is-leaving')
    unmark()
    document.body.classList.remove('is-pairing')
    drag = null
  }
  top.addEventListener('pointerdown', e => {
    const tok = e.target.closest('.tok')
    if (!tok || e.button || phone.matches || tok.classList.contains('is-dim')) return
    const spot = tok.closest('.t-spot')
    drag = { id: tok.dataset.tok, tok, spot, grouped: spot.classList.contains('is-pair'), x: e.clientX, y: e.clientY, ghost: null, at: null, timer: 0 }
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
      const { id, spot } = drag
      const at = landing(e.clientX, e.clientY)
      if (at?.pair) { view.cursor = at.pair.dataset.tok; pair(id, at.pair.dataset.tok).catch(() => {}) }
      else if (at?.out) unpair(id).catch(() => {})
      else if (at && 'before' in at) {
        const u = units.find(x => x.id === spot.dataset.unit)
        const target = at.before ? at.before.dataset.members.split(' ')[0] : beforeAfter(units.find(x => x.id === at.mark.dataset.unit))
        if (u && target !== u.members[0].id) moveSession(u.members[0].id, target).catch(() => {})
      }
      // The release is not a click on the mark.
      const swallow = ev => { ev.stopPropagation(); ev.preventDefault() }
      window.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
    }
    end()
  })
  window.addEventListener('pointercancel', end)
  top.addEventListener('touchmove', e => { if (drag?.ghost) e.preventDefault() }, { passive: false })
  top.addEventListener('contextmenu', e => { if (drag) e.preventDefault() })
  top.addEventListener('dragstart', e => e.preventDefault())

  // ---- keys (see the head of this file) ----
  const busy = () => {
    if (document.querySelector('dialog[open], [data-owns-keys]:not([hidden])') || document.body.hasAttribute('data-pad') || document.body.dataset.keys) return true
    const focus = document.querySelector('body > .focus')
    return Boolean(focus?.getClientRects().length)
  }
  window.addEventListener('keydown', e => {
    if (!isShown() || e.ctrlKey || e.metaKey || e.isComposing || e.defaultPrevented || busy()) return
    const t = e.target instanceof Element ? e.target : null
    const take = () => { e.preventDefault(); e.stopImmediatePropagation() }
    if (t === find) {
      if (e.key === 'Escape') { take(); view.find = find.value = ''; find.blur(); paint() }
      else if (e.key === 'ArrowDown' || e.key === 'Enter') { take(); find.blur(); view.cursor = ''; moveCursor('ArrowDown') }
      return
    }
    if (typingIn(t)) return
    if (e.altKey) return   // the browser's own (Back, Forward)
    const arrow = e.key.startsWith('Arrow')
    // Shift and an arrow move the picked mark one place (Alt and an arrow would be the browser's Back and Forward).
    if (arrow && e.shiftKey) {
      if (view.cursor && stepOrder({ ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 }[e.key])) take()
      return
    }
    if (e.key === '/') { take(); find.focus(); find.select(); return }
    // Inside the slip the arrows belong to the options of an unfolded question.
    if (arrow) { if (slip.contains(t) && t.closest('.inbox-row.is-open')) return; take(); return moveCursor(e.key) }
    if (!view.cursor) return
    if (e.key === 'Escape') {
      if (view.pairFrom) { take(); view.pairFrom = ''; return paint() }
      if (slip.querySelector('.is-current, .inbox-row.is-open')) return   // the list lets go of its own mark first
      take()
      return drop()
    }
    if (e.key === 'Enter') {
      if (t?.closest('button, a[href], summary')) return   // a focused control acts for itself (a mark: pick, then open)
      if (slip.querySelector('.is-current')) return                              // a marked question: Enter is its own
      take()
      return view.pairFrom ? (view.pairFrom === view.cursor ? togglePair(view.cursor) : join(view.pairFrom, view.cursor)) : go(view.cursor)
    }
    if (e.key === '+' || e.key === '=') { take(); return togglePair(view.cursor) }
  }, true)

  return { render, shown: () => { if (isShown()) paint() } }
}
