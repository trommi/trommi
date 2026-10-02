// The keyboard: the one place that listens for keys, and the one table that says what they do.
//
// LAYOUT below is the whole key layout of the app, as data. A view that can act on keys
// registers what it can do with provide(scope, { active, actions }); this module listens once,
// matches the key against the table and calls the action. The "?" sheet is drawn from the same
// table, so what it lists and what works cannot drift apart.
//
// Rules, for every key in the table:
//   - plain keys and "g then x" sequences only; nothing with Ctrl, Alt or Cmd is ever taken
//   - nothing happens while typing in a field (only Escape, which leaves it)
//   - nothing happens while a dialog owns the keyboard (a picture, the session editor)
//   - Enter and Space on a button or link stay that control's own
//   - a key held down repeats only where that is harmless (moving), never an answer

import { el } from './ui.js'

/** The layout. scope: who provides the actions. modal: while it is up, no other scope listens.
 *  keys: 'j', 'ArrowDown', 'Shift+ArrowRight', 'g i' (g, then i), '1…9' (any of them; the action gets the number).
 *  repeat: may fire while held. typing: also fires in a field. control: also fires on a focused button.
 *  native: listed here for the sheet, but handled where it lives (the browser, the composer, the canvas);
 *    while its scope is up the key is left alone, so nothing further down the table takes it.
 *  always: works under a modal scope too (the Focus window). */
export const LAYOUT = [
  { scope: 'app', title: 'Anywhere', keys: [
    { id: 'help', keys: ['?'], does: 'this list', always: true },
    { id: 'pad', keys: ['p', 'g p'], does: 'pad', verb: 'the pad, from anywhere', always: true },
    { id: 'go.inbox', keys: ['g i'], does: 'inbox', verb: 'go to the inbox' },
    { id: 'go.agents', keys: ['g a'], does: 'agents', verb: 'go to the agents' },
    { id: 'go.focus', keys: ['g f'], does: 'Focus', verb: 'Focus: every open question, one after the other' },
    { id: 'go.session', keys: ['g 1…9'], does: 'session 1 to 9', verb: 'go to that session of the sidebar' },
    { id: 'session.next', keys: ['.'], does: 'next session' },
    { id: 'session.prev', keys: [','], does: 'previous session' },
    { id: 'back', keys: ['u', 'Backspace'], does: 'back: take the last answer back' },
    { id: 'theme', keys: ['t'], does: 'light or dark' },
    { id: 'quicksend', keys: ['/'], does: 'quick send: write to a session from wherever you are', native: true },
    { id: 'sessions.move', keys: ['Alt+ArrowUp', 'Alt+ArrowDown'], does: 'move the session you are in up or down the sidebar', native: true },
    { id: 'field.leave', keys: ['Escape'], does: 'leave a field', typing: true },
  ] },
  { scope: 'ledger', title: 'The agents page', keys: [
    { id: 'ledger.find', keys: ['/'], does: 'find a session', native: true },
    { id: 'ledger.step', keys: ['ArrowDown', 'ArrowUp'], does: 'next, previous session', native: true },
    { id: 'ledger.open', keys: ['Enter'], does: 'open it', native: true },
    { id: 'ledger.walk', keys: ['q'], does: 'its questions, one after the other', native: true },
    { id: 'ledger.answer', keys: ['y', 'n'], does: 'answer its question: yes, no', native: true },
    { id: 'ledger.rename', keys: ['r'], does: 'rename', native: true },
    { id: 'ledger.mark', keys: ['d'], does: 'another drawing', native: true },
    { id: 'ledger.crown', keys: ['c'], does: 'crown: its questions come first', native: true },
    { id: 'ledger.pair', keys: ['+'], does: 'lay together with another', native: true },
    { id: 'ledger.archive', keys: ['a'], does: 'archive (a disconnected one)', native: true },
    { id: 'ledger.order', keys: ['Shift+ArrowDown', 'Shift+ArrowUp'], does: 'move it down, up', native: true },
    { id: 'ledger.leave', keys: ['Escape'], does: 'drop the mark', native: true },
  ] },
  { scope: 'list', title: 'A list of questions', keys: [
    { id: 'list.next', keys: ['j', 'ArrowDown'], does: 'next question; after the last, the piles below (Enter unfolds one)', repeat: true },
    { id: 'list.prev', keys: ['k', 'ArrowUp'], does: 'previous question', repeat: true },
    { id: 'list.first', keys: ['Home'], does: 'first question' },
    { id: 'list.last', keys: ['End'], does: 'last question' },
    { id: 'list.option.next', keys: ['ArrowRight'], does: 'next option, where choices are open', repeat: true, control: true },
    { id: 'list.option.prev', keys: ['ArrowLeft'], does: 'previous option', repeat: true, control: true, quiet: true },
    { id: 'list.yes', keys: ['y'], does: 'yes: the thumb up; on a note from the agent: acknowledge' },
    { id: 'list.no', keys: ['n'], does: 'no: the thumb down; on a note from the agent: What??' },
    { id: 'list.send', keys: ['Enter'], does: 'send, where several answers are allowed', control: true },
    { id: 'list.open', keys: ['Enter', 'c'], does: 'open the choices, or the question as a window; a note from the agent: acknowledge' },
    { id: 'list.pick', keys: ['1…9'], does: 'pick that option' },
    { id: 'list.toggle', keys: [' '], does: 'pick the option in focus', native: true },
    { id: 'list.ask', keys: ['a'], does: 'ask back instead of answering' },
    { id: 'list.read', keys: ['h'], does: 'hear it: read the marked question aloud, again to stop' },
    { id: 'list.trust', keys: ['r'], does: 'trust: the agent decides' },
    { id: 'list.shred', keys: ['x'], does: 'shred: throw it away unanswered' },
    { id: 'list.explain', keys: ['e'], does: 'What??: show all of it, then ask the session to explain' },
    { id: 'list.later', keys: ['l'], does: 'snooze, or fetch it back' },
    { id: 'list.takeback', keys: ['u', 'Backspace'], does: 'on an answered row: take that answer back' },
    { id: 'list.leave', keys: ['Escape'], does: 'close the choices, then drop the mark' },
  ] },
  { scope: 'focus', title: 'Focus: one question per page', modal: true, keys: [
    { id: 'focus.next', keys: ['ArrowRight', 'j'], does: 'next question, without answering (in the time machine: the next version)', repeat: true },
    { id: 'focus.prev', keys: ['ArrowLeft', 'k'], does: 'previous question (or version)', repeat: true },
    { id: 'focus.yes', keys: ['y'], does: 'yes: the thumb up' },
    { id: 'focus.no', keys: ['n'], does: 'no: the thumb down' },
    { id: 'focus.pick', keys: ['1…9'], does: 'pick that option' },
    { id: 'focus.send', keys: ['Enter'], does: 'send, where several answers are allowed' },
    { id: 'focus.choices', keys: ['c'], does: 'go to the options' },
    { id: 'focus.option.next', keys: ['ArrowDown'], does: 'next option, once the keyboard is on one', repeat: true, control: true },
    { id: 'focus.option.prev', keys: ['ArrowUp'], does: 'previous option', repeat: true, control: true, quiet: true },
    { id: 'focus.ask', keys: ['a'], does: 'write to the session about the question' },
    { id: 'focus.voice', keys: ['v'], does: 'dictate: tap to start and stop, or hold it while you talk' },
    { id: 'focus.explain', keys: ['e'], does: 'What??: ask the session to explain' },
    { id: 'focus.handback', keys: ['b'], does: 'revise: back to the agent, with what you wrote' },
    { id: 'focus.trust', keys: ['r'], does: 'trust: the agent decides' },
    { id: 'focus.shred', keys: ['x'], does: 'shred: throw it away unanswered' },
    { id: 'focus.draw', keys: ['d'], does: 'draw on the question' },
    { id: 'focus.note', keys: ['a'], does: 'start a note' },
    { id: 'focus.read', keys: ['h'], does: 'hear it: read the question aloud, again to stop' },
    { id: 'focus.later', keys: ['l', 's'], does: 'snooze: on to the next' },
    { id: 'focus.back', keys: ['u', 'Backspace'], does: 'back: take the last answer back' },
    { id: 'focus.leave', keys: ['Escape'], does: 'leave a field, then the time machine, then close', typing: true, control: true },
  ] },
  { scope: 'conversation', title: 'In a session', keys: [
    { id: 'chat.write', keys: ['r'], does: 'write to the session' },
    { id: 'chat.read', keys: ['h'], does: 'hear it: read the latest message aloud, again to stop' },
    { id: 'chat.voice', keys: ['v'], does: 'dictate: tap to start and stop, or hold it while you talk' },
    { id: 'chat.questions', keys: ['q'], does: 'questions only, and back' },
    { id: 'chat.files', keys: ['f'], does: 'files, and back' },
    { id: 'chat.pane', keys: ['o'], does: 'the other session of a pair' },
  ] },
  { scope: 'session', title: 'In a session', keys: [
    { id: 'session.scribble', keys: ['s'], does: 'scribble, and back to the conversation' },
  ] },
  { scope: 'writing', title: 'While writing', keys: [
    { id: 'write.send', keys: ['Enter'], does: 'send', native: true },
    { id: 'write.line', keys: ['Shift+Enter'], does: 'new line', native: true },
  ] },
  { scope: 'scribble', title: 'On the canvas', keys: [
    { id: 'scr.select', keys: ['v'], does: 'select', native: true },
    { id: 'scr.pen', keys: ['p'], does: 'pen (the pad is G then P here)', native: true },
    { id: 'scr.hl', keys: ['h'], does: 'highlighter', native: true },
    { id: 'scr.eraser', keys: ['e'], does: 'eraser', native: true },
    { id: 'scr.width', keys: ['1…4'], does: 'line width', native: true },
    { id: 'scr.image', keys: ['i'], does: 'add a picture', native: true },
    { id: 'scr.fit', keys: ['f'], does: 'fit everything in', native: true },
    { id: 'scr.zoom', keys: ['+', '-', '0'], does: 'zoom in, out, to 100 %', native: true },
    { id: 'scr.delete', keys: ['Delete'], does: 'remove what is selected', native: true },
  ] },
]

// Which scope hears a key first. A list of questions before the page around it.
const ORDER = ['focus', 'ledger', 'list', 'conversation', 'session', 'scribble', 'writing', 'app']
const SEQUENCE_MS = 1600

const providers = new Map()   // scope -> Set of { active(), actions, has?(id) }

/** Say what a view can do. active(): is it on screen and listening right now.
 *  actions: { id: fn(number | undefined, event) }; a function that returns false did not take the key.
 *    One that returns a function wants to know when the key is let go: it is called with the milliseconds held.
 *  has(id): optional; false hides an entry from the sheet (a pair key where there is no pair). */
export function provide(scope, provider) {
  if (!providers.has(scope)) providers.set(scope, new Set())
  providers.get(scope).add(provider)
  return () => providers.get(scope).delete(provider)
}

const NAMES = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc', ' ': 'Space', Delete: 'Del', Backspace: '⌫' }
const capOf = part => part.split('+').map(p => (p === 'Shift' ? '⇧' : NAMES[p] ?? (p.length === 1 ? p.toUpperCase() : p)))
const entryOf = id => { for (const group of LAYOUT) for (const entry of group.keys) if (entry.id === id) return entry }

/** The first key of an action as it is printed on a cap: cap('list.yes') is "Y". For hints on the controls themselves. */
export const cap = id => capOf(entryOf(id).keys[0].split(' ').pop()).join('')

/** Give a control its key: the cap (shown by css where a row is marked) and the word for assistive tech. */
export function hint(node, id) {
  node.dataset.cap = cap(id)
  node.setAttribute('aria-keyshortcuts', entryOf(id).keys.filter(k => !k.includes(' ') && !k.includes('…')).map(k => (k.length === 1 ? k.toUpperCase() : k)).join(' '))
  return node
}

const typingIn = node => Boolean(node?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])'))
const isControl = node => Boolean(node?.closest?.('button, a[href], summary, [role="button"]'))
const activeOf = scope => [...(providers.get(scope) ?? [])].filter(p => { try { return p.active() } catch { return false } })

const isModal = scope => LAYOUT.some(g => g.scope === scope && g.modal)
/** The scopes that listen now, first to hear first. Under a modal one, only it (and what is marked "always"). */
function scopesNow() {
  const live = ORDER.filter(scope => activeOf(scope).length)
  const modal = live.find(isModal)
  return modal ? [modal] : live
}

// What a key event is called in the table.
function nameOf(e) {
  if (e.key.length === 1) return e.key.toLowerCase()
  return e.shiftKey ? `Shift+${e.key}` : e.key
}
// Does a key of the table match what was pressed? Returns the number for a range, true, or null.
function match(spec, name) {
  // 'g 1…9': the first key as it is, then any of the range.
  const range = spec.match(/^(.+ )?(\d)…(\d)$/)
  if (!range) return spec === name ? true : null
  const lead = range[1] ?? ''
  const digit = name.startsWith(lead) ? name.slice(lead.length) : ''
  return /^\d$/.test(digit) && digit >= range[2] && digit <= range[3] ? Number(digit) : null
}

// ---- a sequence under way: "g", then where to ----

let pending = null   // { prefix, timer }
const chip = el('p', 'keys-pending')
chip.hidden = true
chip.setAttribute('role', 'status')
function setPending(prefix) {
  clearTimeout(pending?.timer)
  pending = prefix ? { prefix, timer: setTimeout(() => setPending(null), SEQUENCE_MS) } : null
  if (prefix) document.body.dataset.keys = prefix
  else delete document.body.dataset.keys
  chip.hidden = !prefix
  if (!prefix) return
  // What may follow, from the table.
  const scopes = scopesNow()
  const under = isModal(scopes[0])
  const parts = [el('kbd', null, capOf(prefix).join(''))]
  for (const group of LAYOUT) {
    for (const entry of group.keys) for (const spec of entry.keys) {
      if (!spec.startsWith(`${prefix} `) || !(scopes.includes(group.scope) || (under && entry.always))) continue
      const pair = el('span')
      pair.append(el('kbd', null, capOf(spec.slice(prefix.length + 1)).join('')), entry.does)
      parts.push(pair)
    }
  }
  chip.replaceChildren(...parts)
  if (!chip.isConnected) document.body.append(chip)
}

// ---- the listener ----

let held = null   // { key, at, up }: a key that is down, for an action that wants to know how long
function letGo(e) {
  if (!held || (e && e.key !== held.key)) return
  const { at, up } = held
  held = null
  up(e ? performance.now() - at : Infinity)
}
document.addEventListener('keyup', letGo, true)

function run(name, e, { typing, control }) {
  const scopes = scopesNow()
  const under = isModal(scopes[0])   // a modal scope is up: below it only what is marked "always"
  for (const scope of under ? [...scopes, ...ORDER.filter(s => !scopes.includes(s))] : scopes) {
    const live = activeOf(scope)
    for (const group of LAYOUT) {
      if (group.scope !== scope) continue
      for (const entry of group.keys) {
        if ((typing && !entry.typing) || (control && !entry.control) || (under && scope !== scopes[0] && !entry.always)) continue
        let arg = null
        for (const spec of entry.keys) if ((arg = match(spec, name)) != null) break
        if (arg == null) continue
        // The key belongs to whatever handles it in place: hands off, here and further down.
        if (entry.native) return false
        for (const provider of live) {
          const act = provider.actions?.[entry.id]
          if (!act) continue
          // A held key repeats a move; anything else waits for the next press.
          if (e.repeat && !entry.repeat) return true
          const did = act(arg === true ? undefined : arg, e)
          if (typeof did === 'function') held = { key: e.key, at: performance.now(), up: did }
          if (did !== false) return true
        }
      }
    }
  }
  return false
}

document.addEventListener('keydown', e => {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.keyCode === 229) return
  if (['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Tab', 'Dead'].includes(e.key)) return
  // A key that is held for an action repeats into nothing, not into the field the action may have focused.
  if (held && e.key === held.key && e.repeat) { e.preventDefault(); e.stopPropagation(); return }
  const t = e.target instanceof Element ? e.target : null
  const taken = () => { e.preventDefault(); e.stopPropagation() }
  if (sheet?.open) {
    if (e.key === '?' && !typingIn(t)) { taken(); sheet.close() }
    return
  }
  // A dialog owns the keyboard while it is open; so does a player with its own keys.
  // (The pad is a page of its own in a frame, with its own keys; while it lies over the board, the board's rest.)
  if (document.querySelector('dialog[open], [data-owns-keys]:not([hidden])') || document.body.hasAttribute('data-pad') || t?.closest('video, audio')) return
  const typing = typingIn(t)
  const name = nameOf(e)
  if (typing) {
    if (name === 'Escape' && run(name, e, { typing: true })) taken()
    return
  }
  if (pending) {
    const { prefix } = pending
    setPending(null)
    if (name === 'Escape') return taken()
    run(`${prefix} ${name}`, e, {})
    return taken()   // the second key of a sequence never means anything else
  }
  if (name === '?') { taken(); return openSheet() }
  // Enter and Space on a button are that button's, unless the table says otherwise.
  const control = isControl(t) && (name === 'Enter' || name === ' ')
  if (run(name, e, { control })) return taken()
  if (control || e.repeat) return
  // The first key of a sequence?
  const scopes = scopesNow()
  const under = isModal(scopes[0])
  if (LAYOUT.some(g => g.keys.some(k => !k.native && (scopes.includes(g.scope) || (under && k.always)) && k.keys.some(spec => spec.startsWith(`${name} `))))) {
    taken()
    setPending(name)
  }
}, true)
// A sequence does not survive the page losing the keyboard.
window.addEventListener('blur', () => { setPending(null); letGo() })

// ---- the sheet behind "?": every key that works where you are ----

let sheet = null
function capsNode(spec) {
  const node = el('span', 'keys-caps')
  ;(spec === ' ' ? [spec] : spec.split(' ')).forEach((part, i) => {
    if (i) node.append(el('i', null, 'then'))
    for (const text of capOf(part)) node.append(el('kbd', null, text))
  })
  return node
}

/** Open the list of keys for the view that is up. */
export function openSheet() {
  if (!sheet) {
    sheet = el('dialog', 'keys-sheet')
    sheet.setAttribute('aria-labelledby', 'keys-sheet-title')
    sheet.addEventListener('click', e => { if (e.target === sheet) sheet.close() })
    document.body.append(sheet)
  }
  if (sheet.open) return sheet.close()
  const scopes = scopesNow()
  // The sheet lists what is on screen: a modal view alone, else every scope with something to act on.
  // Under a modal view only what is marked "always" is listed of the rest.
  const under = isModal(scopes[0])
  const head = el('header')
  const title = el('h2', null, 'Keys')
  title.id = 'keys-sheet-title'
  const close = el('button', 'keys-close', 'Close')
  close.type = 'button'
  close.append(el('kbd', null, 'Esc'))
  close.addEventListener('click', () => sheet.close())
  head.append(title, close)
  const body = el('div', 'keys-groups')
  const sections = new Map()   // title -> dl; two scopes of one title share a section
  for (const group of LAYOUT) {
    if (!scopes.includes(group.scope) && !under) continue
    const live = activeOf(group.scope)
    const entries = group.keys.filter(entry => !entry.quiet && (scopes.includes(group.scope) || (entry.always && live.length)) && live.every(p => p.has?.(entry.id) !== false)
      // A key that waits for its action (another module is to provide it) is not listed until it is there.
      && (entry.native || entry.id === 'help' || live.some(p => p.actions?.[entry.id])))
    if (!entries.length) continue
    let list = sections.get(group.title)
    if (!list) {
      const section = el('section')
      list = el('dl')
      section.append(el('h3', null, group.title), list)
      sections.set(group.title, list)
      body.append(section)
    }
    for (const entry of entries) {
      const row = el('div')
      const keys = el('dt')
      // "← →" for a pair of moves reads better than two rows; the quiet twin lends its key.
      const pair = entry.id === 'list.option.next' ? ['ArrowLeft', 'ArrowRight'] : entry.id === 'focus.option.next' ? ['ArrowUp', 'ArrowDown'] : null
      ;(pair ?? entry.keys).forEach((spec, i) => { if (i && !pair) keys.append(el('i', null, 'or')); keys.append(capsNode(spec)) })
      row.append(keys, el('dd', null, entry.verb ?? entry.does))
      list.append(row)
    }
  }
  const foot = el('p', 'keys-foot', 'Keys rest while you type in a field. Tab walks through everything that can be pressed.')
  sheet.replaceChildren(head, body, foot)
  sheet.showModal()
  close.focus()
}
