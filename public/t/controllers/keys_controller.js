// The keyboard of the server-rendered board: the one listener. What the keys do is the table in /t/lib/keys.js.
// A key does what a click would do: it follows a link or presses a button of a form the hub rendered. Nothing
// here knows the board's state. The controller hangs on the "?" sheet, which every page has (views/keys.mjs).
//
// Rules, for every key in the table:
//   - plain keys and "g then x" sequences only; nothing with Ctrl, Alt or Cmd is taken (one exception: Ctrl/Cmd+K, jump)
//   - nothing happens while typing in a field (only Escape, which leaves it)
//   - nothing happens while a dialog owns the keyboard (a sheet, a picture, a canvas with [data-owns-keys])
//   - Enter and Space on a button or link stay that control's own
//   - a key held down repeats only where that is harmless (moving), never an answer
//
// The paper on the Desk is its own module's: P and W only say so on the document ("trommi:pen", "trommi:cards").
import { Controller } from '/js/app/stimulus.mjs'
import { LAYOUT, scopesOf, capOf } from '/t/lib/keys.js'

// The mark and a sequence under way outlive a page: they are this module's, not a controller's.
let listening = null   // the AbortController of the listeners, while a sheet is connected
let sheets = 0

export default class extends Controller {
  connect() { if (sheets++ === 0) { listening = new AbortController(); start(listening.signal) } }
  disconnect() { if (--sheets === 0) { listening.abort(); listening = null } }
  /** A click beside the sheet closes it (data-action on the dialog). */
  beside(event) { if (event.target === this.element) this.element.close() }
}

function start(signal) {
  const on = (target, name, fn, capture = false) => target.addEventListener(name, fn, { signal, capture })
  const SEQUENCE_MS = 1600
  const MARK_KEY = 'trommi-mark'
  const MAC = /Mac|iPhone|iPad/.test(navigator.platform)
  const $ = (sel, root = document) => root.querySelector(sel)
  const base = () => document.body.dataset.tBase ?? ''
  const view = () => document.body.dataset.tView ?? ''
  const shown = node => Boolean(node && !node.closest('[hidden], [inert]') && node.getClientRects().length)
  const typingIn = node => Boolean(node?.closest?.('input:not([type=checkbox], [type=radio], [type=button], [type=submit]), textarea, select, [contenteditable]:not([contenteditable="false"])'))
  const isControl = node => Boolean(node?.closest?.('button, a[href], summary, [role="button"]'))
  /** Go to a page the way a click on a link does (Turbo for the pages rendered here, a whole load for the others: t/boot.js). */
  function go(path) {
    const a = document.createElement('a')
    a.href = path
    a.style.display = 'none'
    document.body.append(a)
    a.click()
    a.remove()
  }
  /** Press what the hub rendered: a button of a form, or a link. false: there is none here. */
  const press = node => { if (!node || node.disabled) return false; node.click() }

  // ---- the mark on the Desk: which row the keyboard is on ----
  // Kept by the card's id (and its place, for when that card leaves), so it holds across stream updates and page changes.
  // The Agents page has the same mark on its lines; each list keeps its own.
  const LISTS = { desk: '#desk-list .inbox-row, #desk-list .inbox-pile.is-open .inbox-done', agents: '#ledger-list .ledger-line[data-id]' }
  const HOSTS = '#desk-list .is-current, #ledger-list .is-current'
  const marks = {}   // view -> { id, pile, at }
  try { Object.assign(marks, JSON.parse(sessionStorage.getItem(MARK_KEY))) } catch {}
  const keep = () => { try { sessionStorage.setItem(MARK_KEY, JSON.stringify(marks)) } catch {} }
  const rows = () => (LISTS[view()] ? [...document.querySelectorAll(LISTS[view()])].filter(shown) : [])
  const current = () => { const row = $(HOSTS); return shown(row) ? row : null }
  const CAPS = [['.inbox-actions .inbox-answer.is-lead', 'Y'], ['.inbox-actions button.inbox-answer:not(.is-lead)', 'N'], ['.inbox-later', 'L'], ['.inbox-takeback', 'U']]
  function show(row, { focus = true } = {}) {
    for (const old of document.querySelectorAll(HOSTS)) if (old !== row) old.classList.remove('is-current')
    if (!row) return
    row.classList.add('is-current')
    // On the marked row the controls wear their keys (css/keys.css).
    for (const [sel, cap] of CAPS) for (const node of row.querySelectorAll(sel)) node.dataset.cap = cap
    if (focus) { if (!row.hasAttribute('tabindex')) row.tabIndex = -1; row.focus({ preventScroll: true }); row.scrollIntoView({ block: 'nearest' }) }
  }
  function setMark(row) {
    if (row) marks[view()] = { id: row.dataset.id, pile: row.matches('.inbox-done'), at: rows().indexOf(row) }; else delete marks[view()]
    keep()
    show(row)
  }
  /** After the page changed (a stream, a visit, a refresh): the mark is where it was; if its card left, on the row that took its place. */
  function restore() {
    const mark = marks[view()]
    if (!mark || !LISTS[view()]) return
    const all = rows()
    const same = all.find(r => r.dataset.id === mark.id && r.matches('.inbox-done') === mark.pile)
    const row = same ?? all[Math.min(mark.at, all.length - 1)] ?? null
    if (!row) return show(null)
    if (!same) { marks[view()] = { id: row.dataset.id, pile: row.matches('.inbox-done'), at: all.indexOf(row) }; keep() } else mark.at = all.indexOf(row)
    if (row.classList.contains('is-current')) return
    // The keyboard follows only when nothing else holds it (a field someone types in keeps it).
    show(row, { focus: !document.activeElement || document.activeElement === document.body })
  }
  let queued = false
  const later = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; restore() }) }
  const watch = new MutationObserver(later)
  watch.observe(document.documentElement, { childList: true, subtree: true })
  signal.addEventListener('abort', () => watch.disconnect())
  for (const name of ['turbo:load', 'turbo:render', 'turbo:morph']) on(document, name, later)   // a morph takes the class off without moving a node
  // A page kept for the Back button holds no open sheet, and no mark of a moment ago.
  on(document, 'turbo:before-cache', () => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); for (const n of document.querySelectorAll(HOSTS)) n.classList.remove('is-current') })
  function step(by) {
    const all = rows()
    if (!all.length) return false
    const at = all.indexOf(current())
    setMark(all[at < 0 ? (by > 0 ? 0 : all.length - 1) : Math.min(Math.max(at + by, 0), all.length - 1)])
  }
  const inRow = sel => { const row = current(); return row ? press(row.querySelector(sel)) : false }

  // ---- places ----
  const menuOpen = () => { const doors = $('#brand-doors'); return Boolean(doors && !doors.hidden) }
  /** The Trommi menu with the keyboard in the jump field; on a page without the menu, the Desk with it open. */
  function openJump() {
    const doors = $('#brand-doors'), field = $('#jump-field')
    if (!doors || !field) return go(`${base()}/#jump`)
    doors.hidden = false
    $('#brand-menu')?.setAttribute('aria-expanded', 'true')
    field.focus()
    field.select()
  }
  const sessions = () => [...document.querySelectorAll('#agents .agent-row[data-unit]')].filter(shown).map(r => r.querySelector('.agent-entry')).filter(Boolean)
  const desks = () => [...document.querySelectorAll('#brand-doors .menu-desk[data-desk]')]
  const HAS = {
    desks: () => desks().length > 0 && view() !== 'agents',
    sidebar: () => Boolean($('#agents')),
  }
  function sessionStep(by) {
    const all = sessions()
    if (!all.length) return false
    const at = all.findIndex(a => a.closest('.agent-row').classList.contains('is-active'))
    press(all[at < 0 ? (by > 0 ? 0 : all.length - 1) : (at + by + all.length) % all.length])
  }
  const sheet = () => $('#keys-sheet')
  function toggleSheet() {
    const s = sheet()
    if (!s) return false
    if (s.open) return s.close()
    const key = $('#keys-sheet [data-mod]')
    if (key && MAC) key.textContent = '⌘'
    s.showModal()
    $('.keys-close', s)?.focus()
  }
  const backNote = () => press($('#says-host .says:not([hidden]) .says-back'))   // the newest toast's Undo (server/views/toast.mjs)
  const options = () => [...document.querySelectorAll('.tc-answer .tc-opts .tc-opt[data-key]')]
  const cardKind = () => $('.tc-card')?.dataset.kind

  /** What the keys do, by the id in the table. A function that returns false did not take the key. */
  const ACTIONS = {
    'list.next': () => step(1),
    'list.prev': () => step(-1),
    'list.first': () => { const all = rows(); return all.length ? setMark(all[0]) : false },
    'list.last': () => { const all = rows(); return all.length ? setMark(all.at(-1)) : false },
    'list.open': () => inRow('a.inbox-text, a.inbox-revising-open'),
    'list.later': () => (current()?.matches('.inbox-done') ? inRow('[data-later] .inbox-takeback, [data-later].inbox-done .inbox-takeback') : inRow('.inbox-later')),
    'list.revise': () => inRow('.inbox-revise'),
    'list.trust': () => inRow('.inbox-trust'),
    'list.shred': () => inRow('.inbox-shred'),
    'list.takeback': () => (current()?.matches('.inbox-done') ? inRow('.inbox-takeback') : backNote()),
    'list.leave': () => { if (!current()) return false; setMark(null); document.activeElement?.blur?.() },
    'pad.cards': () => { document.dispatchEvent(new CustomEvent('trommi:cards')) },

    'card.send': () => press($('.tc-answer .tc-send-many')),
    'card.later': () => press($('.tc-more-item[formaction$="/snooze"]')),
    'card.trust': () => press($('.tc-answer .tc-whatever')),
    // Revise: the small field under the reverse card opens; Enter there hands the card back with its words.
    'card.revise': () => {
      const card = document.querySelector('[data-controller~="card"]')
      const ctl = card && window.Stimulus?.getControllerForElementAndIdentifier(card, 'card')
      return ctl ? ctl.openRevise() : false
    },
    'card.what': () => press($('.tc-answer .tc-wtf, .tc-answer .tc-tile.is-what, .tc-more-item.is-what')),
    'card.shred': () => press($('.tc-more-item.is-shred')),
    'card.write': () => { const field = $('.tc-field'); if (!field) return false; field.focus() },
    'card.back': () => { if ($('#says-host .says:not([hidden]) .says-back')) return backNote(); const b = $('.tc-answer button[formaction$="/reopen"], .tc-answer button[formaction$="/takeback"]'); return b ? press(b) : false },
    'card.next': () => press($('.tc-head a.tc-step-card.is-next')),
    'card.prev': () => press($('.tc-head a.tc-step-card.is-prev')),
    'card.pic.next': () => press($('.tc-card .tc-step.is-next')),
    'card.pic.prev': () => press($('.tc-card .tc-step.is-prev')),
    'card.leave': (n, e) => { if (typingIn(e.target)) return e.target.blur(); return press($('.tc-head .tc-back')) },

    'ledger.next': () => step(1),
    'ledger.prev': () => step(-1),
    'ledger.open': () => (current()?.matches('.is-archived') ? false : inRow('[data-ledger="open"], a.ledger-open')),
    'ledger.walk': () => inRow('[data-ledger="walk"]'),
    'ledger.rename': () => inRow('[data-ledger="rename"]'),
    'ledger.mark': () => inRow('[data-ledger="mark"]'),
    'ledger.crown': () => inRow('[data-ledger="crown"]'),
    'ledger.pair': () => inRow('[data-ledger="pair"]'),
    'ledger.archive': () => inRow('[data-ledger="archive"], [data-ledger="fetch"]'),
    'ledger.down': () => inRow('[data-ledger="down"]'),
    'ledger.up': () => inRow('[data-ledger="up"]'),
    // Escape closes what is open first (the page's own "pops" controller); only then the mark goes.
    'ledger.leave': () => { if (!current() || $('#ledger-list details[open]')) return false; setMark(null); document.activeElement?.blur?.() },

    'pic.next': () => press($('.t-picture .tc-step.is-next')),
    'pic.prev': () => press($('.t-picture .tc-step.is-prev')),
    'pic.leave': () => press($('.t-picture-back')),

    'help': () => toggleSheet(),
    'memo.new': () => press($('#memo-open')),
    'go.desk': () => go(`${base()}/`),
    'go.agents': () => go(`${base()}/agents`),
    'go.walk': () => go(`${base()}/walk`),
    'go.jump': () => openJump(),
    'desk.switch': n => { press(desks()[n - 1]) },   // a number past the last desk does nothing
    'go.session': n => { press(sessions()[n - 1]) },
    'session.next': () => sessionStep(1),
    'session.prev': () => sessionStep(-1),
    'pen': () => { document.dispatchEvent(new CustomEvent('trommi:pen')) },
    'rail': () => (matchMedia('(min-width: 861px)').matches ? press($('.rail-fold')) : false),   // the sidebar's "|<" (rail_controller.js)
    'back': () => backNote(),
    'theme': () => {
      if ($('#theme-toggle')) return press($('#theme-toggle'))
      const dark = document.documentElement.dataset.theme !== 'dark'
      if (dark) document.documentElement.dataset.theme = 'dark'; else delete document.documentElement.dataset.theme
      try { localStorage.setItem('agent-board-theme', dark ? 'dark' : 'light') } catch {}
    },
    'field.leave': (n, e) => { if (!typingIn(e.target)) return false; e.target.blur() },
  }

  // ---- matching ----
  const nameOf = e => (e.key.length === 1 ? e.key.toLowerCase() : e.shiftKey ? `Shift+${e.key}` : e.key)
  // Does a key of the table match what was pressed? The number for a range, true, or null.
  function match(spec, name) {
    const range = spec.match(/^(.+[ +])?(\d)…(\d)$/)
    if (!range) return spec === name ? true : null
    const lead = range[1] ?? ''
    const digit = name.startsWith(lead) ? name.slice(lead.length) : ''
    return /^\d$/.test(digit) && digit >= range[2] && digit <= range[3] ? Number(digit) : null
  }
  const live = () => { const scopes = scopesOf(view()); return LAYOUT.filter(g => scopes.includes(g.scope)).sort((a, b) => scopes.indexOf(a.scope) - scopes.indexOf(b.scope)) }
  const offered = entry => !entry.needs || HAS[entry.needs]()
  function run(name, e, { typing = false, control = false } = {}) {
    for (const group of live()) {
      for (const entry of group.keys) {
        if ((typing && !entry.typing) || (control && !entry.control) || !offered(entry)) continue
        let arg = null
        for (const spec of entry.keys) if ((arg = match(spec, name)) != null) break
        if (arg == null) continue
        // The key belongs to whatever handles it in place: hands off, here and further down.
        if (entry.native) return false
        // A held key repeats a move; anything else waits for the next press.
        if (e.repeat && !entry.repeat) return true
        if (ACTIONS[entry.id]?.(arg === true ? undefined : arg, e) !== false) return true
      }
    }
    return false
  }

  // ---- a sequence under way: "g", then where to ----
  let pending = null   // { prefix, timer }
  let chip = null
  function setPending(prefix) {
    clearTimeout(pending?.timer)
    pending = prefix ? { prefix, timer: setTimeout(() => setPending(null), SEQUENCE_MS) } : null
    if (prefix) document.body.dataset.keys = prefix; else delete document.body.dataset.keys
    if (!prefix) { chip?.remove(); chip = null; return }
    // What may follow, from the table.
    chip = document.createElement('p')
    chip.className = 'keys-pending'
    chip.setAttribute('role', 'status')
    const kbd = text => { const k = document.createElement('kbd'); k.textContent = text; return k }
    chip.append(kbd(capOf(prefix).join('')))
    for (const group of live()) for (const entry of group.keys) for (const spec of entry.keys) {
      if (!spec.startsWith(`${prefix} `) || !offered(entry)) continue
      const pair = document.createElement('span')
      pair.append(kbd(capOf(spec.slice(prefix.length + 1)).join('')), entry.does)
      chip.append(pair)
    }
    document.body.append(chip)
  }
  on(window, 'blur', () => setPending(null))
  on(document, 'turbo:before-visit', () => setPending(null))
  signal.addEventListener('abort', () => setPending(null))

  // ---- the listener ----
  on(document, 'keydown', e => {
    if (e.defaultPrevented || e.altKey || e.isComposing || e.keyCode === 229) return
    const taken = () => { e.preventDefault(); e.stopPropagation() }
    // With Ctrl or Cmd nothing is taken, except the one the table names: the jump field.
    if (e.ctrlKey || e.metaKey) {
      if (e.key.toLowerCase() === 'k' && !e.shiftKey && !document.querySelector('dialog[open]')) { taken(); openJump() }
      return
    }
    if (['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Tab', 'Dead'].includes(e.key)) return
    const t = e.target instanceof Element ? e.target : null
    const typing = typingIn(t)
    if (sheet()?.open) {
      if (e.key === '?' && !typing) { taken(); sheet().close() }
      return   // Escape is the dialog's own
    }
    // A dialog owns the keyboard while it is open; so does whatever says so, and a player with its own keys.
    if (document.querySelector('dialog[open], [data-owns-keys]:not([hidden])') || t?.closest('video, audio, details[open]')) return
    const name = nameOf(e)
    // The open menu's Escape closes the menu (t/boot.js), and nothing else.
    if (name === 'Escape' && menuOpen()) return
    if (typing) {
      // A field's own Escape comes first (a memo note, the jump field, a picker): the table's Escape (leave the field,
      // then the page) acts only if the event comes back up to the document untouched.
      if (name === 'Escape') document.addEventListener('keydown', ev => { if (ev === e && !e.defaultPrevented && run(name, e, { typing: true })) e.preventDefault() }, { once: true, signal })
      return
    }
    if (pending) {
      const { prefix } = pending
      setPending(null)
      if (name !== 'Escape') run(`${prefix} ${name}`, e)
      return taken()   // the second key of a sequence never means anything else
    }
    // Enter and Space on a button or a link are that control's.
    const control = isControl(t) && (name === 'Enter' || name === ' ')
    if (run(name, e, { control })) return taken()
    if (control || e.repeat) return
    // The first key of a sequence?
    if (live().some(g => g.keys.some(k => offered(k) && k.keys.some(spec => spec.startsWith(`${name} `))))) { taken(); setPending(name) }
  }, true)

  // ---- the sheet behind "?" is opened from the menu too ("Keys") ----
  on(document, 'trommi:keys', () => toggleSheet())
  // A row that was clicked is where the keyboard goes on from.
  on(document, 'click', e => {
    const row = e.target instanceof Element ? e.target.closest('#desk-list .inbox-row') : null
    const mark = marks[view()]
    if (row && mark && row.dataset.id !== mark.id) { marks[view()] = { id: row.dataset.id, pile: false, at: rows().indexOf(row) }; keep(); show(row, { focus: false }) }
  })
  later()
}
