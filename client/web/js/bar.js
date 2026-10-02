// The bar: the menu that opens from the logo, and the small drawings on the bar's controls.
//
// The bar itself is calm: the logo, where to go (Inbox, Agents), the two tools (Pad, Focus), then the
// quiet end (the connection, the keys' "?", the theme). Help and Admin are behind the logo: a click on
// it (or Enter) opens a small menu; the arrows walk it, Escape or a click beside it closes it.
// House rule: the controls are plain and quiet, the drawing inside each is what is done by hand.

import { sketch } from './ui.js'

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
redraw($('focus-open'), 'frame')
redraw($('theme-toggle'), 'sun', 'moon')
redraw($('roster-open'), 'heads')
// (The key before "Admin" is put there by app.js.)
if (menu) lead(menu.querySelector('a[href="/help.html"]'), 'page')
// The sheet of keys: a question mark in the bar (keys.js owns the sheet, app.js binds the click).
lead($('keys-open'), 'question')
if (opener) {
  const fold = document.createElement('span')
  fold.className = 'brand-fold'
  fold.append(sketch('unfold'))
  opener.append(fold)
}

// ---- the menu behind the logo ----
const items = () => [...menu.querySelectorAll('[role="menuitem"]')].filter(n => n.offsetParent !== null)
const isOpen = () => !menu.hidden
function open(focusFirst = true) {
  menu.hidden = false
  opener.setAttribute('aria-expanded', 'true')
  if (focusFirst) items()[0]?.focus()
}
function close(back = true) {
  if (!isOpen()) return
  menu.hidden = true
  opener.setAttribute('aria-expanded', 'false')
  if (back) opener.focus()
}
if (opener && menu) {
  // Opened by the pointer, the keyboard stays where it is; opened by a key, it goes to the first entry.
  opener.addEventListener('click', e => (isOpen() ? close() : open(e.detail === 0)))
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
  menu.addEventListener('click', e => { if (e.target.closest('[role="menuitem"]')) close(false) })
  document.addEventListener('pointerdown', e => { if (isOpen() && !e.target.closest('.brand')) close(false) })
  menu.addEventListener('focusout', e => { if (isOpen() && e.relatedTarget && !e.relatedTarget.closest?.('.brand')) close(false) })
}
