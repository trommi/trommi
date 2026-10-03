// The bar: the menu that opens from the logo, and the small drawings on the bar's controls.
//
// The bar itself is calm: the logo, where to go (Inbox, Agents), and at its right end the pad's control
// alone. Everything else is behind the logo: Help, Admin, Keys, the knock sound, the theme, and the
// state of the connection. A click on the logo (or Enter) opens that small menu; the arrows walk it, Escape or a click beside it closes it.
// House rule: the controls are plain and quiet, the drawing inside each is what is done by hand.

import { sketch, KNOCK_SKETCH, INBOX_WORD, INBOX_SKETCH } from './ui.js'
import { knockSound, setKnockSound } from './knock.js'
import { provide } from './keys.js'
import { link, sessionPath } from './link.js'
import { subscribe, getState, setDesk, createDesk, renameDesk, removeDesk } from './store.js'
import { openPad } from './padlink.js'

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
// The two switches say what they are, in words (their state stands at the right: CSS).
const word = (button, text) => { if (button && !button.querySelector('.menu-word')) { const w = document.createElement('span'); w.className = 'menu-word'; w.textContent = text; button.append(w) } }
word(sound, 'Knock sound')
word($('theme-toggle'), 'Theme')
// The jump field's key, as this machine writes it.
if (/Mac|iPhone|iPad/.test(navigator.platform)) { const k = $('jump-key'); if (k) k.textContent = '⌘K' }
// The sheet of keys (keys.js owns the sheet, app.js binds the click).
lead($('keys-open'), 'keycap')
if (opener) {
  // On a wide screen the opener is the menu's pill at the top centre (app.css, "the menu's pill"): the bell mark
  // (the page's own, copied from the Desk button: logo.css draws it), the word "Trommi", the caret. A phone shows
  // the caret alone, in its bar.
  const mark = document.querySelector('#desk-go .brand-mark')?.cloneNode(true)
  if (mark) { mark.classList.add('pill-mark'); opener.append(mark) }
  const name = document.createElement('b')
  name.className = 'pill-word'
  name.textContent = 'Trommi'
  const fold = document.createElement('span')
  fold.className = 'brand-fold'
  fold.append(sketch('unfold'))
  opener.append(name, fold)
}

// The floating Desk: a click goes to the Desk, from anywhere. (Its counts: js/agents.js.)
lead($('desk-go'), INBOX_SKETCH)   // the desk drawing (a wide screen shows it, a phone the logo)
$('desk-go')?.addEventListener('click', () => $('nav-inbox')?.click())
// The one desk there is: choosing it goes there too.
$('project-current')?.addEventListener('click', () => { close(false); $('nav-inbox')?.click() })

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
  // Each place with its real address, so Ctrl or a middle click opens it in a new tab (link.js); a plain click
  // takes the step in the page (go).
  const add = (label, sketchName, go, href) => out.push({ label, sketchName, go, href })
  const nr = /^(?:nr\.?\s*|#)?(\d+)$/.exec(q)
  // The page follows its address (app.js listens to popstate; "?q=<number>" is one of the forms it reads): no reload.
  if (nr) add(`Question Nr. ${nr[1]}`, 'stack', () => { history.pushState({ q: nr[1] }, '', `${location.pathname}?q=${nr[1]}`); window.dispatchEvent(new PopStateEvent('popstate', { state: history.state })) }, `/q/${nr[1]}`)
  const match = text => !q || text.toLowerCase().includes(q)
  if (match(`${INBOX_WORD} inbox`)) add(INBOX_WORD, INBOX_SKETCH, () => $('nav-inbox')?.click(), '/')   // "inbox" still finds it
  if (match('agents')) add('Agents', 'heads', () => $('nav-roster')?.click(), '/agents')
  if (match('scratchpad pad')) add('Scratchpad', 'pen', () => openPad(), '/pad')
  for (const row of document.querySelectorAll('#agents .agent-row[data-unit]')) {
    const name = [...row.querySelectorAll('.agent-text strong')].map(n => n.textContent).join(' + ')
    if (match(name)) add(name, 'bubble', () => row.querySelector('.agent-entry')?.click(), sessionPath((row.dataset.members || row.dataset.unit).split(' ')))
  }
  return out.slice(0, 8)
}
function paintJump() {
  if (!results) return
  const list = jump.value.trim() ? places(jump.value) : []
  results.replaceChildren(...list.map((p, i) => {
    const b = link('', p.href)
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
    if (e.key === 'Enter') { e.preventDefault(); results.querySelector('a, button')?.click() }
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); (results.querySelector('a, button') ?? items()[0])?.focus() }
  })
}
/** Open the menu with the keyboard in the jump field (for the table of keys: action "go.jump"). */
export function openJump() { if (!isOpen()) open(false); jump?.focus(); jump?.select() }

// While Shift is held, a row's quiet action is "Shred" (inbox.js, app.css: body[data-shift]).
const shift = e => document.body.toggleAttribute('data-shift', e.shiftKey && !e.target.closest?.('input, textarea, select, [contenteditable]'))
window.addEventListener('keydown', shift, true)
window.addEventListener('keyup', shift, true)
window.addEventListener('blur', () => document.body.removeAttribute('data-shift'))

// ---- the rail: the sidebar folded to drawings and counts (card Nr. 150, "fold") ----
// Wide screens only (app.css, [data-rail="folded"]). Folded with "[" or the small button at the sidebar's foot,
// opened the same way; remembered per browser. The rail shows no names, so a row says its name beside it
// while the pointer or the keyboard is on it.
const RAIL = 'trommi-rail'
const wide = matchMedia('(min-width: 861px)')
const railFold = document.createElement('button')
railFold.type = 'button'
railFold.className = 'rail-fold'
railFold.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 6.5 9 12l5.5 5.5"/><path d="M5 4.5v15"/></svg>'
const paintRail = () => {
  const folded = document.documentElement.dataset.rail === 'folded'
  railFold.title = `${folded ? 'Open the sidebar' : 'Fold the sidebar to a rail'} ( [ )`
  railFold.setAttribute('aria-label', railFold.title)
  railFold.setAttribute('aria-pressed', String(folded))
}
export function toggleRail() {
  if (!wide.matches) return false
  const folded = document.documentElement.dataset.rail !== 'folded'
  if (folded) { document.documentElement.dataset.rail = 'folded'; close(false) }
  else delete document.documentElement.dataset.rail
  try { folded ? localStorage.setItem(RAIL, 'folded') : localStorage.removeItem(RAIL) } catch {}
  railTip?.remove()
  paintRail()
  return true
}
try { if (localStorage.getItem(RAIL) === 'folded') document.documentElement.dataset.rail = 'folded' } catch {}
railFold.addEventListener('click', toggleRail)
document.body.append(railFold)
paintRail()
let railTip = null
const sidebar = document.getElementById('agents')
const tipFor = e => {
  railTip?.remove()
  railTip = null
  const row = e.target.closest?.('.agent-row')
  if (!row || document.documentElement.dataset.rail !== 'folded' || !wide.matches) return
  const name = [...row.querySelectorAll('.agent-text strong')].map(n => n.textContent.trim()).join(' + ')
  if (!name) return
  const r = row.getBoundingClientRect()
  railTip = document.createElement('div')
  railTip.className = 'rail-tip'
  railTip.textContent = name
  railTip.style.left = `${Math.round(r.right + 10)}px`
  railTip.style.top = `${Math.round(r.top + r.height / 2 - 13)}px`
  document.body.append(railTip)
}
const tipOff = () => { railTip?.remove(); railTip = null }
sidebar?.addEventListener('pointerover', tipFor)
sidebar?.addEventListener('focusin', tipFor)
sidebar?.addEventListener('pointerleave', tipOff)
sidebar?.addEventListener('focusout', tipOff)
sidebar?.addEventListener('scroll', tipOff, { passive: true })

// ---- Dev: test cards for the Desk ----
// A quiet group at the menu's foot: "Create 5 fake decisions" throws test cards onto the Desk, "Remove fake
// decisions" takes them away again (hub: POST /dev/fake-decisions { n: 5 } | { clear: true }). After the click the
// menu closes and the page goes to the Desk. A hub that does not know the route yet (404) gets a note instead.
if (menu) {
  const group = document.createElement('div')
  group.className = 'menu-dev'
  const cap = document.createElement('p')
  cap.className = 'menu-head'
  cap.textContent = 'Dev'
  const note = document.createElement('p')
  note.className = 'menu-dev-note'
  note.setAttribute('role', 'status')
  const item = (id, text, body) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.id = id
    b.setAttribute('role', 'menuitem')
    b.textContent = text
    b.addEventListener('click', async e => {
      e.stopPropagation()   // the menu stays open until the hub has answered (a note may have to be read)
      b.disabled = true
      note.textContent = ''
      try {
        const res = await fetch('/dev/fake-decisions', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        let out = {}
        try { out = await res.json() } catch {}
        if (res.status === 404) note.textContent = 'Needs the hub restart.'
        else if (!res.ok) note.textContent = `Not done: ${out.error || res.statusText}`
        else { close(false); $('nav-inbox')?.click() }
      } catch { note.textContent = 'Not done: the board did not answer.' }
      b.disabled = false
    })
    return b
  }
  // "All screens": the debug index of every view and state the board can show (screens.html, js/screens.js).
  // A real link; it is a page of its own, so a plain click loads it instead of taking a step in this one.
  const screens = link('', '/screens.html')
  screens.id = 'dev-screens'
  screens.setAttribute('role', 'menuitem')
  screens.textContent = 'All screens'
  screens.addEventListener('click', () => location.assign(screens.href))
  group.append(cap, item('dev-fake', 'Create 5 fake decisions', { n: 5 }), item('dev-fake-clear', 'Remove fake decisions', { clear: true }), screens, note)
  menu.append(group)
}

// ---- desks (card Nr. 149, "menu") ----
// The name of the desk in view stands in the Desk box; the menu lists the desks to switch (Ctrl+1, 2, …), with
// what waits on each, "New desk…", and for the one in view another name or its removal. A dot on the caret says
// that another desk knocks. A hub without desks sends none: the menu keeps its one entry, as before.
const deskList = $('desk-list'), deskName = document.querySelector('.desk-name')
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'
const goDesk = id => { if (id !== getState().all.desk) setDesk(id); $('nav-inbox')?.click() }
let deskSig = '', deskEdit = null   // deskEdit: { id | null (a new one), error }
const deskError = document.createElement('p')
deskError.className = 'menu-desk-error'
deskError.setAttribute('role', 'alert')
function deskField(value, label, save) {
  const form = document.createElement('form')
  form.className = 'menu-desk-form'
  const field = document.createElement('input')
  field.className = 'menu-desk-field'
  field.value = value
  field.maxLength = 40
  field.placeholder = 'Name of the desk'
  field.setAttribute('aria-label', label)
  const ok = document.createElement('button')
  ok.type = 'submit'
  ok.textContent = 'Save'
  form.append(field, ok)
  const done = () => { deskEdit = null; deskSig = ''; paintDesks(getState()) }
  form.addEventListener('submit', async e => {
    e.preventDefault()
    const name = field.value.trim()
    if (!name) return done()
    try { await save(name); deskError.textContent = ''; done() } catch (err) { deskError.textContent = `Not saved: ${err.message}` }
  })
  field.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); deskError.textContent = ''; done(); opener?.focus() } })
  queueMicrotask(() => { field.focus(); field.select() })
  return form
}
function paintDesks(state) {
  const { desks, desk } = state.all
  document.documentElement.toggleAttribute('data-desks', Boolean(desks && desks.length > 1))
  if (!desks || !deskList) return
  const sig = JSON.stringify([desks, desk, deskEdit])
  if (sig === deskSig) return
  deskSig = sig
  const here = desks.find(d => d.id === desk)
  if (deskName) { deskName.textContent = here?.name ?? INBOX_WORD; deskName.title = here?.name ?? '' }
  const small = (cls, text, title, run) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `menu-desk-act ${cls}`
    b.textContent = text
    b.title = title
    b.setAttribute('aria-label', title)
    b.addEventListener('click', e => { e.stopPropagation(); run(b) })
    return b
  }
  const rows = desks.map((d, i) => {
    if (deskEdit?.id === d.id) return deskField(d.name, `Another name for the desk ${d.name}`, name => renameDesk(d.id, name))
    const row = document.createElement('div')
    row.className = 'menu-desk-row'
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'menu-desk'
    b.setAttribute('role', 'menuitemradio')
    b.setAttribute('aria-checked', String(d.id === desk))
    const name = document.createElement('b')
    name.textContent = d.name
    const open = document.createElement('i')
    open.textContent = `${d.open} open`
    if (d.knocks && d.id !== desk) { open.classList.add('is-knock'); open.title = `${d.name} knocks` }
    b.append(name, open)
    if (i < 9) { const k = document.createElement('kbd'); k.textContent = `${MOD} ${i + 1}`; b.append(k) }
    b.addEventListener('click', () => { close(false); goDesk(d.id) })
    row.append(b)
    if (d.id === desk) {
      row.append(small('is-rename', 'Rename', `Another name for the desk ${d.name}`, () => { deskEdit = { id: d.id }; paintDesks(getState()) }))
      // The first desk stays: sessions without a desk live on it. Any other goes; its sessions fall to the first.
      if (i > 0) row.append(small('is-remove', 'Remove', `Remove the desk ${d.name}: its ${d.sessions === 1 ? 'session moves' : `${d.sessions} sessions move`} to ${desks[0].name}`, async btn => {
        if (btn.dataset.sure == null) { btn.dataset.sure = ''; btn.textContent = 'Really remove?'; setTimeout(() => { delete btn.dataset.sure; btn.textContent = 'Remove' }, 4000); return }
        try { await removeDesk(d.id); deskError.textContent = '' } catch (err) { deskError.textContent = `Not removed: ${err.message}` }
      }))
    }
    return row
  })
  const add = deskEdit && deskEdit.id == null
    ? deskField('', 'Name of the new desk', async name => {
      const out = await createDesk(name)
      // The new desk is looked at: now if the state already carries it, else as soon as it does (subscribe, below).
      if (out.desk?.id) { if (getState().all.desks?.some(d => d.id === out.desk.id)) queueMicrotask(() => goDesk(out.desk.id)); else pendingDesk = out.desk.id }
    })
    : (() => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'menu-desk new-desk'
      b.setAttribute('role', 'menuitemradio')
      b.setAttribute('aria-checked', 'false')
      b.innerHTML = '<b>+ New desk…</b>'
      b.addEventListener('click', () => { deskEdit = { id: null }; paintDesks(getState()) })
      return b
    })()
  deskList.replaceChildren(...rows, add, deskError)
  // Another desk knocks: a dot on the caret.
  const calls = desks.filter(d => d.id !== desk && d.knocks)
  opener?.toggleAttribute('data-other-knock', calls.length > 0)
  if (opener) opener.title = calls.length ? `${calls.map(d => d.name).join(', ')}: knocking` : ''
}
// A desk made here is looked at as soon as the hub's state carries it.
let pendingDesk = null
subscribe(state => {
  if (pendingDesk && state.all.desks?.some(d => d.id === pendingDesk)) { const id = pendingDesk; pendingDesk = null; queueMicrotask(() => goDesk(id)); return }
  paintDesks(state)
})

// The keyboard's way to the jump field (Ctrl/Cmd+K, G then J), the rail's key, and the desks' (Ctrl+1, 2, …).
provide('app', {
  active: () => true,
  has: id => id !== 'desk.switch' || (getState().all.desks?.length ?? 0) > 1,
  actions: {
    'go.jump': () => { openJump(); return true }, 'rail': toggleRail,
    'desk.switch': n => { const d = getState().all.desks?.[n - 1]; if (!d) return false; goDesk(d.id) },
  },
})

// A phone's bar when it gets tight (card Nr. 158): the Agents button leaves first, the counts stay (Agents is an
// entry of the Desk menu anyway). CSS cannot know when the counts stop fitting: they wrap out of sight in
// #desk-state (css/app.css, "Phone polish"), which is what is measured here. The bar then carries data-tight.
{
  const bar = document.querySelector('.topbar'), counts = $('desk-state')
  const PHONE_BAR = matchMedia('(max-width: 860px)')
  const fit = () => {
    if (!bar || !counts) return
    bar.removeAttribute('data-tight')
    if (PHONE_BAR.matches && counts.scrollHeight > counts.clientHeight + 1) bar.setAttribute('data-tight', '')
  }
  if (bar && counts) {
    new MutationObserver(fit).observe(counts, { childList: true, subtree: true, characterData: true })
    new MutationObserver(fit).observe(document.querySelector('.desk-name') ?? counts, { childList: true, characterData: true, subtree: true })
    addEventListener('resize', fit)
    document.fonts?.ready.then(fit)
    fit()
  }
}
