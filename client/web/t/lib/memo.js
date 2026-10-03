// Memos, the script side (docs/turbo.md "Controllers"): what the two controllers share. The hub renders every note
// that is out and keeps them (state.memos); a note can be made, opened, sent and thrown away without any script
// (they are forms). Here is what needs one:
//   - a sent note tears off and flies away; Escape puts a note away (an empty one is gone): it then hangs off the
//     round button, which shows how many wait there and lists them on a click;
//   - what is typed is kept a moment later (POST /memo, as the old client did), on leaving the page at once;
//   - a note is carried by its top strip; dropped on the Desk's bare paper it lies on the paper and scrolls with it;
//   - pictures and files: the paperclip, a paste, a drop on the note;
//   - a phone: a note is a sheet at the bottom, one at a time, only the one he opened on this page;
//   - a stream that brings a note which is already here changes it in place: the field with the keyboard in it,
//     a note in the hand and a note that is flying away are left alone.
// controllers/memo_controller.js is one note; controllers/memos_controller.js is the round button, its list and
// what concerns all notes of the page.
import { paperLayer, paperPoint, onPaper } from '/t/lib/paper.js'

const STREAM = 'text/vnd.turbo-stream.html'
const W = 340   // a note's width on a wide screen (css/quicksend.css)
export const sheet = matchMedia('(max-width: 860px)')
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const base = () => document.body.dataset.tBase ?? ''
export const host = () => document.getElementById('memos')
export const fieldOf = note => note.querySelector('.memo-field')
const holds = note => Boolean(fieldOf(note).value.trim() || note.querySelector('.memo-file'))
export const notes = () => [...document.querySelectorAll('.memo[data-id]')]
const opener = () => document.getElementById('memo-open')

let sheetId = null   // a phone: the note that is open as the sheet (only one he opened on this page)
export const sheetNote = () => (sheetId ? document.getElementById(`memo-${sheetId}`) : null)

// ---- the passing line ----
export function say(head, line) {
  const at = document.getElementById('says-host')
  if (!at) return
  // (a toast without Undo, server/views/toast.mjs: the controller "says" times it and keeps the stack)
  const node = Object.assign(document.createElement('div'), { className: 'says' })
  node.setAttribute('role', 'alert')
  node.dataset.controller = 'says'
  node.dataset.action = 'pointerenter->says#pause pointerleave->says#run'
  const words = Object.assign(document.createElement('span'), { className: 'says-words' })
  words.append(Object.assign(document.createElement('b'), { textContent: head }), Object.assign(document.createElement('span'), { textContent: line }))
  node.append(words)
  at.prepend(node)
}
const streams = text => window.Turbo?.renderStreamMessage(text)

// ---- keeping: POST /memo, the route the old client keeps its notes with ----
const pending = new Map()   // note id -> { fields, timer }
async function post(body, keepalive = false) {
  const res = await fetch('/memo', { method: 'POST', keepalive, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let out = {}
  try { out = await res.json() } catch {}
  if (!res.ok) throw Object.assign(new Error(out.error || res.statusText), { status: res.status, code: out.code })
  return out
}
/** Keep a change of a note: typing a moment later, everything else at once. */
function keep(id, fields, wait = 0) {
  const p = pending.get(id) ?? { fields: {}, timer: 0 }
  Object.assign(p.fields, fields)
  pending.set(id, p)
  clearTimeout(p.timer)
  if (wait) p.timer = setTimeout(() => flush(id), wait)
  else return flush(id)
}
function flush(id, leaving = false) {
  const p = pending.get(id)
  if (!p) return Promise.resolve()
  clearTimeout(p.timer)
  pending.delete(id)
  return post({ id, ...p.fields }, leaving).catch(err => {
    // Sent or thrown away elsewhere: the stream takes the note off this page too. Anything else is said.
    if (err.code !== 'no-memo' && !leaving) say('Not saved', err.message)
  })
}
/** Leaving the page: what was typed last is kept at once. */
export const flushAll = (leaving = true) => Promise.all([...pending.keys()].map(id => flush(id, leaving)))
/** A form of a note goes (the bin): what is typed goes along with it, and nothing waits behind it. */
export function settle(note) { clearTimeout(pending.get(note.dataset.id)?.timer); pending.delete(note.dataset.id) }

// ---- how a note looks and where it stands ----
export function fit(note) {
  const field = fieldOf(note)
  field.style.height = 'auto'
  field.style.height = `${Math.min(Math.max(field.scrollHeight, 84), Math.round(window.innerHeight * .4 / 28) * 28)}px`
  const button = note.querySelector('button.memo-send')
  if (button) button.disabled = !holds(note)
}
/** Put the note where its place says: on the Desk's paper (once that is laid), else over the page. */
export function stand(note) {
  if (note.classList.contains('is-carried') || note.dataset.state === 'sending') return
  const layer = note.dataset.place === 'paper' ? paperLayer() : null
  const home = layer ?? host()
  if (home && note.parentNode !== home) {
    const had = note.contains(document.activeElement) ? document.activeElement : null
    home.append(note)
    had?.focus?.({ preventScroll: true })
  }
  note.classList.toggle('is-paper', Boolean(layer))
  const x = Number(note.dataset.x) || 0, y = Number(note.dataset.y) || 0
  if (layer) { note.style.left = `${Math.max(0, x)}px`; note.style.top = `${Math.max(0, y)}px` }
  else if (note.dataset.place === 'float' && !note.hasAttribute('data-unplaced')) { note.style.left = `clamp(4px, ${x}px, calc(100vw - ${W + 4}px))`; note.style.top = `clamp(4px, ${y}px, calc(100vh - 120px))` }
  else { note.style.left = note.style.top = '' }
  note.toggleAttribute('data-sheet', note.dataset.id === sheetId)
}
function paintOpener() {
  document.body.toggleAttribute('data-memo-open', sheet.matches && notes().some(n => n.hasAttribute('data-sheet') && !n.classList.contains('is-paper')))
}
export function standAll() {
  for (const note of notes()) { stand(note); fit(note) }
  paintOpener()
}
/** The paper is taken down: what lies on it goes back into the page (unseen until the next paper is laid). */
export function offPaper() { for (const note of notes()) if (note.classList.contains('is-paper')) { note.classList.remove('is-paper'); host()?.append(note) } }
/** The note that was touched last lies on top of the others. */
export function front(note) { for (const other of notes()) other.style.zIndex = other === note && !note.classList.contains('is-paper') ? '2601' : '' }
/** Where a note appears that has no place of its own yet: above the button at the lower right; each further one a
 *  step up and to the left. On a card's page it must not lie on what one answers with. */
function spot() {
  const n = notes().filter(m => m.dataset.place === 'float' && !m.hasAttribute('data-unplaced')).length
  const at = { x: window.innerWidth - W - 16 - (n % 6) * 22, y: Math.max(64, window.innerHeight - 330 - (n % 6) * 22) }
  if (!document.body.hasAttribute('data-focus-page')) return at
  const H = 210, vw = window.innerWidth, vh = window.innerHeight
  const taken = [...document.querySelectorAll('.focus-opt, .focus-way, .focus-ask-field, .memo')].map(node => node.getBoundingClientRect()).filter(r => r.width && r.height && r.right > 0 && r.left < vw && r.bottom > 0 && r.top < vh)
  const free = (x, y) => !taken.some(r => r.left < x + W + 8 && r.right > x - 8 && r.top < y + H + 8 && r.bottom > y - 8)
  for (let y = Math.min(at.y, vh - H - 16); y >= 56; y -= 24) for (let x = vw - W - 16; x >= 8; x -= 24) if (free(x, y)) return { x, y }
  return at
}
/** A note that just came because he asked for it: it gets a place and the keyboard. */
function welcome(note) {
  note.removeAttribute('data-fresh')
  note.dataset.state = 'open'
  sheetId = note.dataset.id
  if (note.hasAttribute('data-unplaced') && !sheet.matches) {
    const at = spot()
    Object.assign(note.dataset, { x: at.x, y: at.y })
    note.removeAttribute('data-unplaced')
    keep(note.dataset.id, at)
  }
  standAll()
  fieldOf(note).focus({ preventScroll: true })
}

// ---- a stream brings a note that is already on this page: it is changed in place ----
function patch(old, fresh) {
  if (old.classList.contains('is-carried') || old.dataset.state === 'sending') return
  const typing = pending.has(old.dataset.id)
  if (!typing) for (const k of ['place', 'x', 'y']) old.dataset[k] = fresh.dataset[k]
  if (!typing) old.toggleAttribute('data-unplaced', fresh.hasAttribute('data-unplaced'))
  const field = fieldOf(old), text = fieldOf(fresh).value
  if (document.activeElement !== field && !typing && field.value !== text) field.value = text
  for (const part of ['.memo-files', '.memo-sends']) old.querySelector(part).replaceChildren(...fresh.querySelector(part).childNodes)
  const form = old.querySelector('.memo-slip'), now = fresh.querySelector('.memo-slip')
  form.setAttribute('aria-label', now.getAttribute('aria-label'))
  field.setAttribute('aria-label', fieldOf(fresh).getAttribute('aria-label'))
  if (fresh.hasAttribute('data-fresh')) welcome(old)
  else { stand(old); fit(old) }
}
/** turbo:before-stream-render, for the streams of the memos: a note that is here already is changed in place, a
 *  new one is stood up, the list at the button stays open. */
export function onStream(e) {
  const el = e.target
  const next = e.detail.render
  if (el.target === 'memo-new') {
    const was = document.getElementById('memo-away')
    if (was && !was.hidden) e.detail.render = async stream => { await next(stream); if (document.querySelectorAll('#memo-away form').length > 1) showAway(true) }
    return
  }
  if (el.target !== 'memos' && !/^memo-/.test(el.target ?? '')) return
  e.detail.render = async stream => {
    const fresh = stream.templateContent?.querySelector?.('.memo')
    const old = fresh ? document.getElementById(fresh.id) : stream.action === 'remove' ? document.getElementById(stream.target) : null
    if (stream.action === 'remove') {
      // A note that flies away is taken off by its flight.
      if (old?.dataset.state === 'sending') return
      pending.delete(old?.dataset.id)
      return next(stream)
    }
    // Undo of a send (data-back) while the letter still flies: the flight stops, the note is as it was.
    if (old && fresh?.hasAttribute('data-back') && old.dataset.state === 'sending') {
      old.querySelector('.memo-env')?.remove()
      old.querySelector('.memo-slip')?.removeAttribute('aria-busy')
      old.dataset.state = 'open'
    }
    if (old && fresh) return patch(old, fresh)
    await next(stream)
    const came = fresh && document.getElementById(fresh.id)
    if (came?.hasAttribute('data-fresh')) welcome(came)
    else standAll()
  }
}

// ---- making, sending, putting away ----
async function act(url, fields = {}) {
  const res = await fetch(url, { method: 'POST', headers: { Accept: STREAM, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) })
  const text = await res.text()
  return { ok: res.ok, text }
}
/** Make a note (or go to the empty one that floats already) and put the keyboard into it. */
export async function write() {
  const empty = notes().find(n => n.dataset.place === 'float' && !holds(n) && (!sheet.matches || n.dataset.id === sheetId))
  if (empty) { fieldOf(empty).focus({ preventScroll: true }); return }
  const at = sheet.matches ? { x: 0, y: 0 } : spot()
  // (The button lets go of the keyboard first: a stream that replaces it would otherwise give it the keyboard back.)
  opener()?.blur()
  // On a session's page the note belongs to that session (shown there only, sent to it): views/memo.mjs.
  const session = document.body.dataset.tView === 'session' ? document.body.dataset.scope ?? '' : ''
  const out = await act(`${base()}/memos`, { place: 'float', x: at.x, y: at.y, ...(session && session !== 'all' ? { session } : {}) }).catch(err => ({ ok: false, text: '', err }))
  if (out.text) streams(out.text)
  else if (!out.ok) say('Not saved', out.err?.message ?? 'the board did not take it')
}
/** The envelope of a sent note (css/quicksend.css .memo-env), laid where the send button is: it opens, the note
 *  slips into it, it closes with the crown as its seal, and flies to `to` (aim()). The slip moves by --env-x/--env-y
 *  (from its middle to the envelope's) and --env-s (how small it gets). Only for the look: it takes no clicks. */
function envelope(note, to) {
  const slip = note.querySelector('.memo-slip'), button = note.querySelector('.memo-send')
  const at = note.getBoundingClientRect(), r = slip.getBoundingClientRect(), b = (button ?? slip).getBoundingClientRect()
  const W = 70, H = 50, cx = b.left + b.width / 2, cy = b.top + b.height / 2
  const env = document.createElement('div')
  env.className = 'memo-env'
  env.setAttribute('aria-hidden', 'true')
  env.style.cssText = `left:${cx - at.left - W / 2}px;top:${cy - at.top - H / 2}px;width:${W}px;height:${H}px;--fly-x:${to.x + (r.left + r.width / 2 - cx)}px;--fly-y:${to.y + (r.top + r.height / 2 - cy)}px`
  const back = document.createElement('i'), flap = document.createElement('i'), seal = document.createElement('i')
  back.className = 'memo-env-body'; flap.className = 'memo-env-flap'; seal.className = 'memo-env-seal'
  const crown = button?.querySelector('.crown-mark, .agent-avatar')   // the crown, or on a session's note its drawing
  if (crown) seal.append(crown.cloneNode(true))
  env.append(back, flap, seal)
  slip.style.setProperty('--env-x', `${Math.round(cx - (r.left + r.width / 2))}px`)
  slip.style.setProperty('--env-y', `${Math.round(cy - (r.top + r.height / 2) + 4)}px`)
  slip.style.setProperty('--env-s', (W * .7 / r.width).toFixed(3))
  note.append(env)
  return env
}
/** Where the letter flies: on the session's own page into its drawing in the heading; else to the drawing of the
 *  receiving session in the sidebar (on a phone the strip at the top), or, when that is not in view, up and out: how far from the note's middle, and the drawing it lands on. */
function aim(note, to) {
  const inView = n => { const r = n?.getBoundingClientRect(); return r && r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth ? r : null }
  let row = to ? document.getElementById(`agent-${to}`) : null
  if (row && !inView(row) && row.dataset.parent) row = document.getElementById(`agent-${row.dataset.parent}`)
  // On the session's own page: into its drawing in the page's heading (top left), where the conversation is.
  const head = to && document.body.dataset.tView === 'session' ? document.querySelector(`#session-who-${CSS.escape(to)} .agent-avatar, #session-who-${CSS.escape(to)}`) : null
  const mark = inView(head) ? head : row?.querySelector('.agent-avatar') ?? row
  const at = inView(mark), from = note.querySelector('.memo-slip').getBoundingClientRect()
  const x = at ? at.left + at.width / 2 - (from.left + from.width / 2) : 40, y = at ? at.top + at.height / 2 - (from.top + from.height / 2) : -innerHeight * .45
  return { x: Math.round(x), y: Math.round(y), mark: at ? mark : null }
}
/** The letter arrives: the receiver's drawing gives a small bump. */
function land(mark) {
  mark.classList.remove('is-memo-landed')
  void mark.offsetWidth
  mark.classList.add('is-memo-landed')
  setTimeout(() => mark.classList.remove('is-memo-landed'), 600)
}
/** Tear the note off and send it to the crown. */
export async function send(note) {
  const form = note.querySelector('.memo-slip'), button = note.querySelector('.memo-send')
  if (form.hasAttribute('aria-busy')) return
  if (button?.matches('a')) return button.click()   // no crown on this desk: to the Agents page, where it is given
  if (!holds(note)) return fieldOf(note).focus()
  form.setAttribute('aria-busy', 'true')
  const id = note.dataset.id
  settle(note)   // the form carries the words as they stand
  const out = await act(form.action, { text: fieldOf(note).value, ...(button ? { to: button.value } : {}) }).catch(err => ({ ok: false, text: '', err }))
  if (!out.ok) {
    form.removeAttribute('aria-busy')
    if (out.text) streams(out.text); else say('Not sent', out.err?.message ?? 'no connection')
    return
  }
  // It went: the envelope opens and takes the note, closes with the crown, and swooshes to the crowned session in the sidebar;
  // then the line says to whom.
  note.dataset.state = 'sending'
  // The toast with its Undo comes at once (the hub holds the memo only a few seconds); the rest once the letter has flown.
  const toastPart = /<turbo-stream action="prepend" target="says-host">[\s\S]*?<\/turbo-stream>/.exec(out.text)?.[0] ?? ''
  if (toastPart) streams(toastPart)
  if (!calm()) await new Promise(done => {
    const to = aim(note, button?.value), layer = envelope(note, to), mark = to.mark
    const end = () => { clearTimeout(timer); if (mark) land(mark); done() }
    const timer = setTimeout(end, 1800)
    layer.addEventListener('animationend', ev => { if (ev.target === layer) end() })
  })
  if (note.dataset.state !== 'sending') return   // Undo was pressed while it flew: the note stays (onStream)
  note.remove()
  if (sheetId === id) sheetId = null
  paintOpener()
  streams(out.text.replace(toastPart, ''))
  opener()?.focus({ preventScroll: true })
}
/** Put the note away: it hangs off the round button; an empty one is gone. */
export async function putAway(note) {
  if (note.dataset.state === 'sending') return
  const id = note.dataset.id, had = note.contains(document.activeElement)
  settle(note)
  const kept = holds(note)
  if (sheetId === id) sheetId = null
  note.remove()
  paintOpener()
  if (had) opener()?.focus({ preventScroll: true })
  const out = await act(`${base()}/memos/${id}/stack`, { text: fieldOf(note).value }).catch(() => null)
  if (!out?.ok) return say('Not saved', 'The note could not be put away.')
  if (kept) say('Memo put away', 'It waits at the yellow memo button.')
}
/** The words changed. */
export function typed(note) { fit(note); keep(note.dataset.id, { text: fieldOf(note).value }, 350) }

// ---- the notes that were put away: the list at the round button ----
export function showAway(on) {
  const list = document.getElementById('memo-away')
  if (!list) return
  list.hidden = !on
  opener()?.setAttribute('aria-expanded', String(on))
  if (on) list.querySelector('.memo-away-line')?.focus({ preventScroll: true })
}
/** The lines of the notes that wait at the button, as this screen shows them. */
export const waits = () => [...document.querySelectorAll('#memo-away form:not(:first-child)')].filter(f => !f.classList.contains('memo-away-float') || (sheet.matches && f.querySelector('[data-memo]')?.dataset.memo !== sheetId))

// ---- pictures and files ----
const read = file => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve({ name: file.name || `pasted-${Date.now()}.png`, data: reader.result })
  reader.onerror = () => reject(reader.error)
  reader.readAsDataURL(file)
})
export async function attach(note, list) {
  const got = [...list].filter(f => f instanceof File)
  if (!got.length) return
  try {
    const fresh = await Promise.all(got.map(read))
    const have = [...note.querySelectorAll('.memo-file')].map(c => ({ url: c.dataset.url }))
    await post({ id: note.dataset.id, attachments: [...have, ...fresh] })   // (the stream brings the chips)
  } catch (err) { say('Not attached', err?.message ?? 'the file could not be read') }
}
/** The file chooser of a note. */
export function picker(note) {
  let input = note.querySelector('input[type=file]')
  if (!input) {
    input = Object.assign(document.createElement('input'), { type: 'file', multiple: true, hidden: true, tabIndex: -1 })
    input.addEventListener('change', async () => { await attach(note, input.files); input.value = ''; fieldOf(note).focus() })
    note.append(input)
  }
  return input
}
/** A file chip was clicked: it comes off the note. */
export function unclip(note, chip) {
  const left = [...note.querySelectorAll('.memo-file')].filter(c => c !== chip).map(c => ({ url: c.dataset.url }))
  chip.remove()
  fit(note)
  keep(note.dataset.id, { attachments: left })
}

// ---- carried by its head: anywhere over the page, or onto the Desk's paper ----
export function carry(e, note, head) {
  if (e.button) return
  const id = note.dataset.id
  const done = (move, up) => { for (const type of ['pointermove', 'pointerup', 'pointercancel']) head.removeEventListener(type, type === 'pointermove' ? move : up) }
  const listen = (move, up) => { try { head.setPointerCapture(e.pointerId) } catch {} head.addEventListener('pointermove', move); head.addEventListener('pointerup', up); head.addEventListener('pointercancel', up) }
  if (sheet.matches) {
    // A phone: the sheet is not carried; a note that lies on the paper is moved about on the paper.
    if (!note.classList.contains('is-paper')) return
    const start = paperPoint(e.clientX, e.clientY)
    if (!start) return
    const x0 = Number(note.dataset.x) || 0, y0 = Number(note.dataset.y) || 0
    let to = null
    const move = ev => {
      const p = paperPoint(ev.clientX, ev.clientY)
      if (!p) return
      to = { x: Math.max(0, x0 + p.x - start.x), y: Math.max(0, y0 + p.y - start.y) }
      note.classList.add('is-carried'); note.style.left = `${to.x}px`; note.style.top = `${to.y}px`
    }
    const up = () => {
      done(move, up)
      note.classList.remove('is-carried')
      if (to) { Object.assign(note.dataset, to); keep(id, to) }
    }
    return listen(move, up)
  }
  const r = note.getBoundingClientRect()
  const dx = e.clientX - r.left, dy = e.clientY - r.top
  let moved = false
  const at = ev => [Math.min(Math.max(ev.clientX - dx, 4), window.innerWidth - r.width - 4), Math.min(Math.max(ev.clientY - dy, 4), window.innerHeight - 40)]
  const move = ev => {
    if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return
    if (!moved) {
      moved = true
      // Lifted: it floats over everything while it is carried (off the paper, should it lie there).
      note.classList.remove('is-paper')
      note.classList.add('is-carried')
      note.removeAttribute('data-unplaced')
      if (note.parentNode !== host()) { host().append(note); try { head.setPointerCapture(e.pointerId) } catch {} }
    }
    const [x, y] = at(ev)
    note.style.left = `${x}px`
    note.style.top = `${y}px`
    note.classList.toggle('over-paper', onPaper(ev.clientX, ev.clientY, note))
  }
  const up = ev => {
    done(move, up)
    note.classList.remove('is-carried', 'over-paper')
    if (!moved) return
    const [x, y] = at(ev)
    // On the paper it lies in the paper's own pixels and scrolls with it.
    const on = ev.type === 'pointerup' && onPaper(ev.clientX, ev.clientY, note) ? paperPoint(x, y) : null
    const to = on ? { place: 'paper', x: on.x, y: on.y } : { place: 'float', x: Math.round(x), y: Math.round(y) }
    Object.assign(note.dataset, to)
    stand(note)
    keep(id, to)
  }
  listen(move, up)
}
/** A phone: a tap beside the sheet puts the note away (nothing lies over the page meanwhile). */
export function beside(e) {
  if (!sheet.matches || !sheetId || !(e.target instanceof Element) || e.target.closest('.memo, #memo-new, .says')) return
  const note = sheetNote()
  if (!note || note.classList.contains('is-paper')) return
  putAway(note)
  // That tap only put the note away: it does not also press what lay beside the sheet.
  const swallow = ev => { ev.stopPropagation(); ev.preventDefault() }
  window.addEventListener('click', swallow, { capture: true, once: true })
  setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 600)
}
