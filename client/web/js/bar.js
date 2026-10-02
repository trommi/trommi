// The bar: the menu that opens from the logo, and the small drawings on the bar's controls.
//
// The bar itself is calm: the logo, where to go (Inbox, Agents), and at its right end the pad's control
// alone. Everything else is behind the logo: Help, Admin, Keys, the knock sound, the theme, and the
// state of the connection. A click on the logo (or Enter) opens that small menu; the arrows walk it, Escape or a click beside it closes it.
// House rule: the controls are plain and quiet, the drawing inside each is what is done by hand.

import { sketch, KNOCK_SKETCH } from './ui.js'
import { knockSound, setKnockSound } from './knock.js'

const $ = id => document.getElementById(id)
const opener = $('brand-menu')
const menu = $('brand-doors')

// ---- drawings: one small scribble per control ----
const lead = (node, name) => { if (node && !node.querySelector('.sketch')) node.prepend(sketch(name)) }
// The stock icons this page was first built with give way to drawings of the same family.
const redraw = (button, ...names) => {
  if (!button) return
  for (const old of button.querySelectorAll('svg.ico')) old.remove()
  for (const name of names) {
    const mark = sketch(name)
    if (names.length > 1) mark.classList.add(`ico-${name}`)   // moon and sun: the theme decides which is seen
    button.prepend(mark)
  }
}
lead($('nav-inbox'), 'tray')
lead($('nav-roster'), 'heads')
redraw($('theme-toggle'), 'sun', 'moon')
redraw($('roster-open'), 'heads')
// The page of all sessions, reachable from anywhere.
lead($('menu-agents'), 'heads')
$('menu-agents')?.addEventListener('click', () => $('nav-roster')?.click())
// (The key before "Admin" is put there by app.js.)
if (menu) lead(menu.querySelector('a[href="/help.html"]'), 'page')
// A soft double knock when an urgent or blocking question arrives: off unless switched on here.
const sound = $('knock-sound')
if (sound) {
  lead(sound, KNOCK_SKETCH)
  const paint = () => { const on = knockSound(); sound.setAttribute('aria-checked', String(on)); sound.title = `Knock sound: ${on ? 'on' : 'off'}` }
  sound.addEventListener('click', e => { e.stopPropagation(); setKnockSound(!knockSound()); paint() })
  paint()
}
// The sheet of keys (keys.js owns the sheet, app.js binds the click).
lead($('keys-open'), 'keycap')
if (opener) {
  const fold = document.createElement('span')
  fold.className = 'brand-fold'
  fold.append(sketch('unfold'))
  opener.append(fold)
}

// ---- the menu behind the logo ----
const items = () => [...menu.querySelectorAll('[role^="menuitem"], [role="option"]')].filter(n => n.offsetParent !== null)
const isOpen = () => !menu.hidden
function open(focusFirst = true) {
  menu.hidden = false
  opener.setAttribute('aria-expanded', 'true')
  // The jump field takes the keyboard: type and go, or arrow down into the entries.
  if (focusFirst) (jump ?? items()[0])?.focus()
}
function close(back = true) {
  if (!isOpen()) return
  menu.hidden = true
  opener.setAttribute('aria-expanded', 'false')
  if (back) opener.focus()
}
if (opener && menu) {
  // Opened by the pointer, the keyboard stays where it is; opened by a key, it goes to the first entry.
  opener.addEventListener('click', () => (isOpen() ? close() : open(true)))
  opener.addEventListener('keydown', e => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    open(false)
    items().at(e.key === 'ArrowUp' ? -1 : 0)?.focus()
  })
  menu.addEventListener('keydown', e => {
    const all = items(), at = all.indexOf(document.activeElement)
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: all.length - 1 }[e.key]
    if (to != null) { e.preventDefault(); e.stopPropagation(); all[(to + all.length) % all.length]?.focus() }
  })
  // Escape closes it, and nothing else hears that Escape; a choice closes it; so does anything beside it.
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !isOpen()) return
    e.preventDefault()
    e.stopImmediatePropagation()
    close()
  }, true)
  menu.addEventListener('click', e => { if (e.target.closest('[role="menuitem"]')) close(false) })   // a switch (menuitemcheckbox) leaves it open
  document.addEventListener('pointerdown', e => { if (isOpen() && !e.target.closest('.brand')) close(false) })
  menu.addEventListener('focusout', e => { if (isOpen() && e.relatedTarget && !e.relatedTarget.closest?.('.brand')) close(false) })
}

// ---- jump: type, and go ----
// A session by its name, a question by its number ("12", "Nr. 12"), or a place. Enter takes the first.
const jump = $('jump-field'), results = $('jump-results')
function places(query) {
  const q = query.trim().toLowerCase()
  const out = []
  const add = (label, sketchName, go) => out.push({ label, sketchName, go })
  const nr = /^(?:nr\.?\s*|#)?(\d+)$/.exec(q)
  if (nr) add(`Question Nr. ${nr[1]}`, 'stack', () => { location.href = `/?q=${nr[1]}` })
  const match = text => !q || text.toLowerCase().includes(q)
  if (match('inbox')) add('Inbox', 'tray', () => $('nav-inbox')?.click())
  if (match('agents')) add('Agents', 'heads', () => $('nav-roster')?.click())
  if (match('scratchpad pad')) add('Scratchpad', 'pen', () => $('pad-open')?.click())
  for (const row of document.querySelectorAll('#agents .agent-row[data-unit]')) {
    const name = [...row.querySelectorAll('.agent-text strong')].map(n => n.textContent).join(' + ')
    if (match(name)) add(name, 'bubble', () => row.querySelector('.agent-entry')?.click())
  }
  return out.slice(0, 8)
}
function paintJump() {
  if (!results) return
  const list = jump.value.trim() ? places(jump.value) : []
  results.replaceChildren(...list.map((p, i) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.setAttribute('role', 'option')
    if (!i) b.setAttribute('aria-selected', 'true')
    b.append(sketch(p.sketchName), p.label)
    b.addEventListener('click', () => { close(false); jump.value = ''; paintJump(); p.go() })
    return b
  }))
}
if (jump) {
  jump.addEventListener('input', paintJump)
  jump.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); results.querySelector('button')?.click() }
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); (results.querySelector('button') ?? items()[0])?.focus() }
  })
}
/** Open the menu with the keyboard in the jump field (for the table of keys: action "go.jump"). */
export function openJump() { if (!isOpen()) open(false); jump?.focus(); jump?.select() }

// While Shift is held, a row's quiet action is "Shred" (inbox.js, app.css: body[data-shift]).
const shift = e => document.body.toggleAttribute('data-shift', e.shiftKey && !e.target.closest?.('input, textarea, select, [contenteditable]'))
window.addEventListener('keydown', shift, true)
window.addEventListener('keyup', shift, true)
window.addEventListener('blur', () => document.body.removeAttribute('data-shift'))
