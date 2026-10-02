// The Ledger: the overview of the sessions at /agents (css/ledger.css). One line per session:
// its mark, its name, its state, what it asks or does (a yes/no is answered right in the line), its
// model, its machine, when it was last seen, and what can be done with it.
//   - a click on a column's head sorts by it (again: the other way round); "Back to your order" returns
//   - in your own order a line is moved by its grip: between two lines it moves there (the server's
//     order, so the sidebar follows), onto the middle of another line the two are laid together
//   - the mark opens the drawings, the name renames, the crown beside the mark is the switch for VIP
//   - disconnected sessions are a group of their own and can be put away; the archive stands below
// On a phone a line is mark, name, state and count; a tap opens the session.
//
// It takes the place of the list of cards (js/agents.js mountRoster, still built into #roster, not shown).
// Going somewhere is the page's own business (js/app.js): this file presses the sidebar's own rows.
//
// Keys, while the page is up (heard here; js/keys.js does not list them yet):
//   /          find                    ↑ ↓         to the next line
//   Enter      open the conversation   Q           its questions, one after the other
//   Y  N       answer its first question, where that is a yes or no
//   R          rename                  D           its drawing          C   crown on or off
//   +  or =    lay together with… (then pick the other line, Enter), or take it out of its group
//   A          archive (disconnected only)         Shift+↑↓  move the line     Esc   let go

import { subscribe, getState, pair, unpair, archive, moveSession, decide, reopen } from './store.js'
import { avatar, crownToggle, tellApart, openMarkPicker, openEditor } from './agents.js'
import { el, sketch, ago, bareHand } from './ui.js'
import { say, pageHost } from './back.js'

const $ = id => document.getElementById(id)
const phone = matchMedia('(max-width: 860px)')
const typingIn = node => Boolean(node?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])'))
const button = (cls, text) => { const b = el('button', cls, text); b.type = 'button'; return b }
const RANK = { critical: 3, high: 2, normal: 1, low: 0 }

// ---- what a session needs right now (the sidebar's rule, js/agents.js summary()) ----
function summaryOf(all, a) {
  const cards = all.queue.map(id => all.cards.find(c => c.id === id)).filter(c => c && c.agent === a.id && c.status === 'open')
  const tasks = all.tasks.filter(t => t.agent === a.id)
  const running = Boolean(a.online && tasks.some(t => t.state === 'working'))
  const stuck = cards.some(c => c.urgency === 'critical' || c.kind === 'permission')
  // The hand: it is stopped and waits for the human.
  const hand = cards.length > 0 && (a.online ? stuck || !running : stuck)
  const top = cards.length ? Math.max(...cards.map(c => RANK[c.urgency] ?? 1)) : -1
  return { cards, open: cards.length, tasks, online: Boolean(a.online), running, stuck, hand, top }
}
const stateWord = s => (!s.online ? 'away' : s.hand ? 'waiting' : s.running ? 'working' : s.open ? 'asking' : 'idle')
// How much it needs the human, for sorting by state: waiting first, then by urgency, away last.
const need = s => (!s.online ? 9 : s.open ? (s.hand ? 0 : 1) + (3 - s.top) / 10 : s.running ? 7 : 8)

// ---- going somewhere: through the page's own controls ----
const sideRow = id => [...document.querySelectorAll('#agents .agent-row[data-unit]')].find(r => r.dataset.unit === id || (r.dataset.members ?? '').split(' ').includes(id))
const go = id => sideRow(id)?.querySelector('.agent-entry')?.click()
/** One question as a window of its own: by its address, which the page follows. */
function openQuestion(cardId) {
  const params = new URLSearchParams(location.search)
  params.set('q', String(getState().all.cards.find(c => c.id === cardId)?.number ?? cardId))
  history.pushState({ q: cardId }, '', `${location.pathname}?${params}${location.hash}`)
  window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
}
/** A session's questions, one after the other: the walk the sidebar's badge starts; else its first one alone. */
function walk(id, s) {
  const badge = sideRow(id)?.querySelector('button.agent-badge')
  if (badge && (sideRow(id).dataset.members ?? id) === id) return badge.click()
  if (s.cards[0]) openQuestion(s.cards[0].id)
}

function mountLedger(root) {
  const view = { find: '', sort: 'order', down: false, cur: '', pairFrom: '' }
  let last = null
  let sums = new Map()

  const head = el('header', 'ledger-head')
  const lead = el('p')
  head.append(el('h2', null, 'Agents'), lead)
  const find = el('input')
  find.type = 'search'
  find.autocomplete = 'off'
  find.placeholder = 'Find a session, a machine, a model'
  find.setAttribute('aria-label', 'Find a session')
  const findBox = el('label', 'ledger-find')
  findBox.append(find, el('kbd', null, '/'))
  const order = button('ledger-link')
  order.addEventListener('click', () => { view.sort = 'order'; view.down = false; paint() })
  const tools = el('div', 'ledger-tools')
  tools.append(findBox, order)
  const note = el('p', 'ledger-note')
  note.hidden = true
  const list = el('div', 'ledger')
  list.setAttribute('role', 'table')
  const page = el('div', 'ledger-page')
  page.append(head, tools, note, list)
  root.append(page)

  const isShown = () => root.getClientRects().length > 0
  const agentOf = id => last?.all.agents.find(a => a.id === id) ?? null
  const found = a => {
    const words = view.find.trim().toLowerCase()
    return !words || [a.name, a.given, a.host, a.model, a.task, a.cwd].filter(Boolean).join(' ').toLowerCase().includes(words)
  }
  find.addEventListener('input', () => { view.find = find.value; paint() })

  const COLS = [['name', 'Session'], ['state', 'State'], ['model', 'Model'], ['host', 'Machine'], ['seen', 'Last seen']]
  const VAL = {
    name: a => a.name.toLowerCase(), state: a => need(sums.get(a.id)), model: a => (a.model ?? '').toLowerCase(), host: a => (a.host ?? '').toLowerCase(),
    seen: a => (a.online ? 0 : -(a.seen ?? a.joined ?? 0)),
  }
  function sorted(agents) {
    if (view.sort === 'order') return agents
    const val = VAL[view.sort]
    const out = [...agents].sort((a, b) => (val(a) > val(b) ? 1 : val(a) < val(b) ? -1 : agents.indexOf(a) - agents.indexOf(b)))
    return view.down ? out.reverse() : out
  }

  // ---- answering the first question in its line ----
  const quick = card => card.options?.length === 2 && !card.multiple
  const yesOf = card => (card.kind === 'permission' ? card.options.find(o => o.key === 'allow') : null) ?? card.options[0]
  async function answer(card, option, buttons = []) {
    for (const b of buttons) b.disabled = true
    try {
      await decide(card.id, option.key)
      if (card.kind === 'decision') say(pageHost(), { head: `Answered: ${option.label}`, title: card.title, back: () => reopen(card.id) })
    } catch (err) {
      for (const b of buttons) b.disabled = false
      tell(`Not saved: ${err.message}`)
    }
  }
  let noteTimer = 0
  function tell(text) {
    clearTimeout(noteTimer)
    note.textContent = text
    note.hidden = false
    noteTimer = setTimeout(() => { note.hidden = true }, 5000)
  }
  const act = promise => Promise.resolve(promise).catch(err => tell(`Not done: ${err.message}`))

  // ---- one line ----
  const icon = (name, title, run) => {
    const b = button('ledger-ib')
    b.title = title
    b.setAttribute('aria-label', title)
    b.append(sketch(name))
    b.addEventListener('click', e => { e.stopPropagation(); run() })
    return b
  }
  function line(a, all, apart) {
    const s = sums.get(a.id)
    const row = el('div', 'ledger-line')
    row.setAttribute('role', 'row')
    row.dataset.id = a.id
    row.dataset.state = stateWord(s)
    row.tabIndex = -1
    if (s.top >= 0) row.dataset.urgency = Object.keys(RANK).find(k => RANK[k] === s.top)
    if (view.cur === a.id) row.classList.add('is-cur')
    if (view.pairFrom === a.id) row.classList.add('is-pairing')

    const grip = el('span', 'ledger-grip')
    if (view.sort === 'order' && !view.find.trim()) { grip.dataset.grab = a.id; grip.title = 'Drag to move it; drop it onto another session to lay the two together'; grip.append(el('i'), el('i'), el('i')) }

    // The mark opens the drawings (while the session works it redraws itself); the crown beside it is the switch for VIP.
    const face = el('span', 'ledger-face')
    const mark = button('ledger-mark')
    mark.title = 'Choose a drawing'
    mark.setAttribute('aria-label', `${a.name}: choose a drawing`)
    mark.setAttribute('aria-haspopup', 'dialog')
    mark.append(avatar(a, { vip: false, working: s.running }))
    mark.addEventListener('click', e => { e.stopPropagation(); openMarkPicker(a, mark) })
    face.append(mark, crownToggle(a, 'ledger-crown'))

    const name = el('span', 'ledger-name')
    const rename = button('ledger-rename')
    rename.title = 'Rename'
    rename.append(el('strong', null, a.name))
    rename.addEventListener('click', e => { e.stopPropagation(); openEditor(a) })
    name.append(rename)
    if (apart.get(a.id)) name.append(el('small', null, apart.get(a.id)))
    const group = all.groups.find(g => g.id === a.group)
    if (group) {
      const others = group.members.filter(m => m.id !== a.id).map(m => m.name).join(' + ')
      const chip = el('span', 'ledger-with', `with ${others}`)
      const split = button(null)
      split.title = `Take ${a.name} out`
      split.setAttribute('aria-label', `Take ${a.name} out of its group with ${others}`)
      split.append(sketch('snip'))
      split.addEventListener('click', e => { e.stopPropagation(); act(unpair(a.id)) })
      chip.append(split)
      name.append(chip)
    }

    // State: stopped and waiting, a red hand with the count; at work, the word (and its count, quiet); else a word.
    const state = el('span', 'ledger-state')
    const word = stateWord(s)
    if (s.hand) state.append(bareHand(), el('b', null, String(s.open)))
    else state.append(el('span', null, word === 'asking' ? 'asks' : word), ...(s.open ? [el('b', null, String(s.open))] : []))
    state.title = s.open ? `${word}, ${s.open === 1 ? '1 question' : `${s.open} questions`} open` : word

    // What it asks (its first question, a yes/no answered right here) or what it does.
    const does = el('span', 'ledger-does')
    const card = s.cards[0]
    if (card) {
      const title = button('ledger-q', card.title)
      title.title = `${card.title}: open it as a window`
      title.addEventListener('click', e => { e.stopPropagation(); openQuestion(card.id) })
      does.append(title)
      if (s.open > 1) { const more = button('ledger-more', `+${s.open - 1}`); more.title = 'Go through its questions'; more.addEventListener('click', e => { e.stopPropagation(); walk(a.id, s) }); does.append(more) }
      if (quick(card)) {
        const yes = yesOf(card), no = card.options.find(o => o !== yes)
        const advised = o => [card.recommended].flat().includes(o.key)
        const tile = (o, kind, cls) => {
          const b = button(`ledger-ans ${cls}`)
          b.dataset.answer = kind
          b.title = o.label
          b.setAttribute('aria-label', o.label)
          b.append(sketch(kind))
          if (advised(o)) b.classList.add('is-advised')
          b.addEventListener('click', e => { e.stopPropagation(); answer(card, o, does.querySelectorAll('.ledger-ans')) })
          return b
        }
        does.append(tile(no, 'no', ''), tile(yes, 'yes', 'is-lead'))
      } else {
        const choose = button('ledger-ans is-lead is-choose', 'Choose')
        choose.addEventListener('click', e => { e.stopPropagation(); openQuestion(card.id) })
        does.append(choose)
      }
    } else does.append(el('span', 'ledger-task', a.task || (a.online ? 'nothing named' : '')))

    const cell = text => el('span', 'ledger-cell', text || '')
    const acts = el('span', 'ledger-acts')
    acts.append(icon('go', 'Open the conversation', () => go(a.id)))
    if (s.open) acts.append(icon('tray', 'Its questions, one after the other', () => walk(a.id, s)))
    if (!group && all.agents.length > 1) acts.append(icon('heads', 'Lay together with…', () => togglePair(a.id)))
    if (!a.online) acts.append(icon('archive', 'Archive: put this session away', () => act(archive(a.id))))

    row.append(grip, face, name, state, does, cell(a.model), cell(a.host), cell(a.online ? 'now' : ago(a.seen ?? a.joined ?? Date.now())), acts)
    return row
  }

  let signature = ''
  function render(state) {
    last = state
    const all = state.all
    sums = new Map(all.agents.map(a => [a.id, summaryOf(all, a)]))
    if (view.cur && !agentOf(view.cur)) view.cur = ''
    if (view.pairFrom && !agentOf(view.pairFrom)) view.pairFrom = ''
    const apart = tellApart(all.agents)
    const sig = JSON.stringify([view, phone.matches, all.agents.map(a => { const s = sums.get(a.id); return [a.id, a.name, a.mark, a.online, a.starred, a.task, a.model, a.host, a.group, a.online ? 0 : Math.floor((Date.now() - (a.seen ?? 0)) / 60000), apart.get(a.id), s.open, s.running, s.hand, s.top, s.cards[0] && [s.cards[0].id, s.cards[0].title, s.cards[0].options, s.cards[0].recommended]] }), all.archived.map(a => [a.id, a.name, a.mark, a.seen])])
    if (sig === signature) return
    signature = sig
    const online = all.agents.filter(a => a.online).length
    lead.textContent = `${online} of ${all.agents.length} sessions are connected.`
    order.textContent = view.sort === 'order' ? 'In your order: drag a line by its grip to move it' : 'Back to your order'
    order.disabled = view.sort === 'order'

    const held = list.contains(document.activeElement) ? document.activeElement.closest('.ledger-line')?.dataset.id : null
    const shown = all.agents.filter(found)
    const on = sorted(shown.filter(a => a.online)), off = sorted(shown.filter(a => !a.online))
    const th = ([key, label]) => {
      const b = button(`ledger-th th-${key}`, label)
      b.setAttribute('role', 'columnheader')
      b.setAttribute('aria-sort', view.sort === key ? (view.down ? 'descending' : 'ascending') : 'none')
      if (view.sort === key) b.append(el('i', null, view.down ? '↓' : '↑'))
      b.addEventListener('click', () => { if (view.sort === key) view.down = !view.down; else { view.sort = key; view.down = false } paint() })
      return b
    }
    const top = el('div', 'ledger-line is-head')
    top.setAttribute('role', 'row')
    top.append(el('span'), el('span'), th(COLS[0]), th(COLS[1]), el('span', 'ledger-th', 'Asks or does'), ...COLS.slice(2).map(th), el('span'))
    const parts = [top, ...on.map(a => line(a, all, apart))]
    if (off.length) parts.push(el('h3', 'ledger-sub', 'Disconnected'), ...off.map(a => line(a, all, apart)))
    if (!shown.length && all.agents.length) {
      const none = el('p', 'ledger-none', 'No session fits. ')
      const clear = button('ledger-link', 'Show all')
      clear.addEventListener('click', () => { view.find = find.value = ''; paint() })
      none.append(clear)
      parts.push(none)
    }
    if (!all.agents.length) parts.push(el('p', 'ledger-none', 'No session is connected yet.'))
    // Put away: they come back by themselves when they reconnect, or by "Fetch back".
    if (all.archived.length) {
      parts.push(el('h3', 'ledger-sub', 'Archive'))
      for (const a of all.archived) {
        const row = el('div', 'ledger-line is-archived')
        row.setAttribute('role', 'row')
        const face = el('span', 'ledger-face')
        face.append(avatar(a))
        const name = el('span', 'ledger-name')
        name.append(el('strong', null, a.name))
        const back = button('ledger-link', 'Fetch back')
        back.addEventListener('click', () => act(archive(a.id, false)))
        const acts = el('span', 'ledger-acts')
        acts.append(back)
        const state = el('span', 'ledger-state')
        state.append(el('span', null, 'put away'))
        row.append(el('span', 'ledger-grip'), face, name, state, el('span', 'ledger-does'), el('span', 'ledger-cell', a.model || ''), el('span', 'ledger-cell', a.host || ''), el('span', 'ledger-cell', ago(a.seen ?? a.joined ?? Date.now())), acts)
        parts.push(row)
      }
    }
    list.toggleAttribute('data-pairing', Boolean(view.pairFrom))
    list.replaceChildren(...parts)
    const from = agentOf(view.pairFrom)
    if (from) { clearTimeout(noteTimer); note.hidden = false; note.replaceChildren('Laying ', el('b', null, from.name), ' together with: pick the other line (a click, or the arrows and Enter). Esc lets go.') }
    else if (note.querySelector('b')) note.hidden = true
    if (held) list.querySelector(`.ledger-line[data-id="${CSS.escape(held)}"]`)?.focus({ preventScroll: true })
  }
  const paint = () => { if (last) { signature = ''; render(last) } }
  phone.addEventListener('change', paint)

  // ---- acting on a line ----
  const lines = () => [...list.querySelectorAll('.ledger-line[data-id]')]
  function point(id) {
    view.cur = id
    paint()
    const row = list.querySelector('.ledger-line.is-cur')
    row?.focus({ preventScroll: true })
    row?.scrollIntoView({ block: 'nearest' })
  }
  function join(a, b) { view.pairFrom = ''; view.cur = b; act(pair(a, b)); paint() }
  function togglePair(id) {
    if (agentOf(id)?.group) return void act(unpair(id))
    view.pairFrom = view.pairFrom === id ? '' : id
    view.cur = id
    paint()
  }
  /** Move a line one place up or down, among the lines of its own part (connected, or not). */
  function stepOrder(id, by) {
    if (view.sort !== 'order') return false
    const all = lines().filter(r => (r.dataset.state === 'away') === (list.querySelector(`[data-id="${CSS.escape(id)}"]`)?.dataset.state === 'away')).map(r => r.dataset.id)
    const at = all.indexOf(id), to = at + by
    if (at < 0 || to < 0 || to >= all.length) return false
    act(moveSession(id, by < 0 ? all[to] : afterOf(all[to], id)))
    return true
  }
  /** Directly after the session `after`: before whoever follows it in the server's order (the moved one aside), or at the end. */
  const afterOf = (after, moved) => { const ids = last.all.agents.map(a => a.id).filter(id => id !== moved); return ids[ids.indexOf(after) + 1] ?? null }

  list.addEventListener('click', e => {
    const row = e.target.closest('.ledger-line[data-id]')
    if (!row) return
    const id = row.dataset.id
    if (view.pairFrom) return view.pairFrom === id ? togglePair(id) : join(view.pairFrom, id)
    if (e.target.closest('button, a, input')) return
    // A phone's line is small: a tap opens. Elsewhere a click on the line picks it; a second one opens.
    if (phone.matches || view.cur === id) return go(id)
    point(id)
  })
  list.addEventListener('dblclick', e => { const row = e.target.closest('.ledger-line[data-id]'); if (row && !e.target.closest('button')) go(row.dataset.id) })

  // ---- carrying a line by its grip: between two lines (move), onto the middle of one (lay together) ----
  let drag = null   // { id, row, x, y, ghost, timer }
  function landing(x, y) {
    const rows = lines().filter(r => r !== drag.row)
    for (const row of rows) {
      const b = row.getBoundingClientRect()
      if (y < b.top || y > b.bottom || x < b.left || x > b.right) continue
      const quarter = b.height / 4
      if (y > b.top + quarter && y < b.bottom - quarter) return agentOf(row.dataset.id)?.group && agentOf(row.dataset.id).group === agentOf(drag.id)?.group ? null : { pair: row }
      const after = y >= b.bottom - quarter
      // Where it already stands, nothing would move.
      const all = lines(), own = all.indexOf(drag.row), at = all.indexOf(row) + (after ? 1 : 0)
      if (at === own || at === own + 1) return null
      if ((row.dataset.state === 'away') !== (drag.row.dataset.state === 'away')) return null
      return { row, after }
    }
    return null
  }
  const unmark = () => { for (const n of list.querySelectorAll('[data-drop]')) delete n.dataset.drop }
  function begin() {
    const agent = agentOf(drag.id)
    if (!agent) return end()
    drag.ghost = avatar(agent)
    drag.ghost.classList.add('agent-ghost')
    document.body.append(drag.ghost)
    drag.row.classList.add('is-carried')
    document.body.classList.add('is-pairing')
    move(drag.x, drag.y)
  }
  function move(x, y) {
    drag.ghost.style.translate = `${x - 17}px ${y - 17}px`
    unmark()
    const at = landing(x, y)
    if (at?.pair) at.pair.dataset.drop = 'pair'
    else if (at) at.row.dataset.drop = at.after ? 'after' : 'before'
  }
  function end() {
    if (!drag) return
    clearTimeout(drag.timer)
    drag.ghost?.remove()
    drag.row.classList.remove('is-carried')
    unmark()
    document.body.classList.remove('is-pairing')
    drag = null
  }
  list.addEventListener('pointerdown', e => {
    const grip = e.target.closest('[data-grab]')
    if (!grip || e.button || phone.matches) return
    drag = { id: grip.dataset.grab, row: grip.closest('.ledger-line'), x: e.clientX, y: e.clientY, ghost: null, timer: 0 }
    if (e.pointerType === 'touch') drag.timer = setTimeout(() => drag && begin(), 380)
    else e.preventDefault()
  })
  window.addEventListener('pointermove', e => {
    if (!drag) return
    if (drag.ghost) return move(e.clientX, e.clientY)
    const far = Math.hypot(e.clientX - drag.x, e.clientY - drag.y)
    if (e.pointerType === 'touch') { if (far > 10) end() }
    else if (far > 5) begin()
  })
  window.addEventListener('pointerup', e => {
    if (!drag) return
    if (drag.ghost) {
      const at = landing(e.clientX, e.clientY), id = drag.id
      if (at?.pair) { view.cur = at.pair.dataset.id; act(pair(id, at.pair.dataset.id)) }
      else if (at) act(moveSession(id, at.after ? afterOf(at.row.dataset.id, id) : at.row.dataset.id))
      const swallow = ev => { ev.stopPropagation(); ev.preventDefault() }
      window.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
    }
    end()
  })
  window.addEventListener('pointercancel', end)
  list.addEventListener('touchmove', e => { if (drag?.ghost) e.preventDefault() }, { passive: false })

  // ---- keys (see the head of this file) ----
  const busy = () => {
    if (document.querySelector('dialog[open], [data-owns-keys]:not([hidden])') || document.body.hasAttribute('data-pad') || document.body.dataset.keys) return true
    return Boolean(document.querySelector('body > .focus')?.getClientRects().length)
  }
  window.addEventListener('keydown', e => {
    if (!isShown() || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.defaultPrevented || busy()) return
    const t = e.target instanceof Element ? e.target : null
    const take = () => { e.preventDefault(); e.stopImmediatePropagation() }
    const step = by => {
      const all = lines(), at = all.findIndex(r => r.dataset.id === view.cur)
      const to = all[at < 0 ? (by > 0 ? 0 : all.length - 1) : Math.max(0, Math.min(all.length - 1, at + by))]
      if (to) point(to.dataset.id)
    }
    if (t === find) {
      if (e.key === 'Escape') { take(); view.find = find.value = ''; find.blur(); paint() }
      else if (e.key === 'ArrowDown' || e.key === 'Enter') { take(); find.blur(); view.cur = ''; step(1) }
      return
    }
    if (typingIn(t)) return
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
    if (k === '/') { take(); find.focus(); find.select(); return }
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      take()
      const by = k === 'ArrowDown' ? 1 : -1
      if (e.shiftKey) { if (view.cur) stepOrder(view.cur, by); return }
      return step(by)
    }
    const a = agentOf(view.cur)
    if (!a) return
    const s = sums.get(a.id)
    if (k === 'Escape') { take(); if (view.pairFrom) view.pairFrom = ''; else { view.cur = ''; document.activeElement?.blur?.() } return paint() }
    if (k === 'Enter') {
      if (t?.closest('button, a[href], summary')) return
      take()
      return view.pairFrom ? (view.pairFrom === a.id ? togglePair(a.id) : join(view.pairFrom, a.id)) : go(a.id)
    }
    const row = list.querySelector('.ledger-line.is-cur')
    const keys = {
      q: () => walk(a.id, s),
      r: () => openEditor(a),
      d: () => openMarkPicker(a, row.querySelector('.ledger-mark')),
      c: () => row.querySelector('.crown-toggle')?.click(),
      a: () => { if (!a.online) act(archive(a.id)) },
      '+': () => togglePair(a.id), '=': () => togglePair(a.id),
      y: () => row.querySelector('.ledger-ans[data-answer="yes"]')?.click(),
      n: () => row.querySelector('.ledger-ans[data-answer="no"]')?.click(),
    }
    if (keys[k]) { take(); keys[k]() }
  }, true)

  return { render, shown: () => { if (isShown()) paint() } }
}

// ---- mount: in the place of the list of cards ----
{
  const node = el('main')
  node.id = 'ledger'
  node.setAttribute('aria-label', 'Agents')
  $('roster')?.after(node)
  const ledger = mountLedger(node)
  subscribe(state => ledger.render(state))
  // "Last seen" moves on by itself.
  setInterval(() => ledger.render(getState()), 30000)
  new MutationObserver(() => ledger.shown()).observe(document.body, { attributes: true, attributeFilter: ['data-page'] })
}
