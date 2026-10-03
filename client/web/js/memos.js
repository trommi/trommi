// Memos: small yellow sticky notes the human writes to a session. A note exists from the moment it is made
// until it is torn off and sent, or thrown away. This file is the notes themselves (no looks): what they
// hold, where they lie, and where they are kept. The floating note is js/quicksend.js; the yellow "Memos"
// stack on the Desk is built by js/inbox.js from memoPile().
//
//   note = { id, text, to, files: [{ name, data }], place, x, y, ts }
//     chips   copied questions that go along ([{ id, number, title, choice_label }]); kept in this browser only
//     to      the session it goes to; null: the session that receives quick memos (the starred one)
//     place   'float'  over whatever page is shown, at x/y of the window
//             'stack'  put away: it lies on the Memos stack of the Desk
//             'paper'  on the Desk's paper, at x/y of the paper (it scrolls with it)
//
// Kept on the hub (state.memos, POST /memo), so every device shows the same notes: a change goes there a moment
// after it was made, and what another device changed is taken from the board's state. A hub from before that
// (no `memos` in its state) keeps nothing: the notes then live in this browser alone (localStorage; other tabs
// follow), and go to the hub once it knows them. This browser's copy is kept in both cases, so a reload has the
// notes at once. A note's files are { name, data } (a data: URL) until the hub has them, then { name, url, … }.

import { el, sketch } from './ui.js'
import { subscribe, getState } from './store.js'

const KEY = 'trommi-memos'
const OLD = 'trommi-memo-draft'   // the one draft of the slip that came before
const listeners = new Set()
let notes = []
let lean = false   // the browser's store was too small for the attachments: they live in this tab only

const clean = n => ({
  id: String(n.id), hid: n.hid ?? null, chips: Array.isArray(n.chips) ? n.chips.filter(c => c?.id) : [], seen: Number(n.seen) || 0, text: String(n.text ?? ''), to: n.to ?? null,
  files: (n.files ?? []).filter(f => f && typeof f.name === 'string' && (typeof f.data === 'string' || typeof f.url === 'string')),
  place: ['float', 'stack', 'paper'].includes(n.place) ? n.place : 'stack',
  x: Number(n.x) || 0, y: Number(n.y) || 0, ts: Number(n.ts) || Date.now(),
})
function read() {
  try { return (JSON.parse(localStorage.getItem(KEY) ?? '[]') ?? []).filter(n => n?.id).map(clean) } catch { return [] }
}
function write() {
  try {
    try { localStorage.setItem(KEY, JSON.stringify(notes)); lean = false }
    catch { localStorage.setItem(KEY, JSON.stringify(notes.map(n => ({ ...n, files: [] })))); lean = true }
  } catch {}
}
notes = read()
try {
  const old = JSON.parse(localStorage.getItem(OLD) ?? 'null')
  if (old && (old.text || old.files?.length)) { notes.push(clean({ id: `m${Date.now().toString(36)}`, text: old.text, files: old.files, place: 'stack' })); write() }
  localStorage.removeItem(OLD)
} catch {}

const tell = why => { for (const fn of listeners) fn(why ?? {}) }
// Another tab changed them: this one shows the same notes. (Attachments this tab alone holds are kept.)
window.addEventListener('storage', e => {
  if (e.key !== KEY) return
  const mine = new Map(notes.map(n => [n.id, n]))
  notes = read().map(n => (lean && !n.files.length && mine.get(n.id)?.files.length ? { ...n, files: mine.get(n.id).files } : n))
  tell({ from: 'storage' })
})

/** Every note there is, the oldest first. */
export const memos = () => notes
export const memo = id => notes.find(n => n.id === id) ?? null
/** Hear of every change: fn({ id, focus, from }). Returns the way to stop hearing. */
export function onMemos(fn) { listeners.add(fn); return () => listeners.delete(fn) }
/** A new note; it is kept at once. */
export function newMemo(props = {}) {
  const note = clean({ id: `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, place: 'float', ...props })
  notes.push(note)
  write()
  push(note, ['text', 'to', 'place', 'x', 'y', 'files'])
  tell({ id: note.id, focus: props.place !== 'stack' })
  return note
}
/** Change a note (text, receiver, attachments, where it lies) and keep it. quiet: the one who changed it needs no telling. */
export function saveMemo(id, change, { quiet = false, focus = false } = {}) {
  const note = memo(id)
  if (!note) return null
  Object.assign(note, change, { ts: Date.now() })
  write()
  push(note, Object.keys(change))
  if (!quiet) tell({ id, focus })
  return note
}
export function removeMemo(id) {
  const at = notes.findIndex(n => n.id === id)
  if (at < 0) return null
  const [gone] = notes.splice(at, 1)
  write()
  drop(gone)
  tell({ id })
  return gone
}
/** Put a note back as it was (the way back after "throw away"). */
export function restoreMemo(note) {
  if (memo(note.id)) return
  // (The hub has forgotten it: it is made anew there. Files the hub held are gone with it.)
  const back = clean({ ...note, hid: null, seen: 0, files: note.files.filter(f => f.data) })
  notes.push(back)
  write()
  push(back, ['text', 'to', 'place', 'x', 'y', 'files'])
  tell({ id: note.id, focus: true })
}
// A phone shows a floating note as a sheet at the bottom, one at a time, and only the one he opened on this page:
// a note left floating on a wide screen never opens by itself there. Until he taps it, it lies on the stack.
const phone = matchMedia('(max-width: 860px)')
let sheetId = null
/** A phone: the note that is open as the sheet (null: none). */
export const sheetMemo = () => sheetId
export function setSheet(id) { sheetId = id }
/** Does the note lie on the Memos stack of the Desk (as this screen shows it)? */
export const onStack = n => n.place === 'stack' || (phone.matches && n.place === 'float' && n.id !== sheetId)
/** Take a note off the stack: it floats over the page again, the keyboard in it. */
export function openMemo(id) { sheetId = id; return saveMemo(id, { place: 'float' }, { focus: true }) }

/** The lines of the Desk's "Memos" stack: one per note that was put away, the newest first. nameOf(id): the receiver's name. */
export function memoPile(nameOf = () => '') {
  return notes.filter(onStack).sort((a, b) => b.ts - a.ts).map(n => () => {
    const node = el('article', 'inbox-done inbox-revising-row memo-line')
    node.tabIndex = -1
    node.dataset.memo = n.id
    const go = el('button', 'inbox-revising-open memo-line-open')
    go.type = 'button'
    go.title = 'Open the note'
    const words = n.text.trim().replace(/\s+/g, ' ')
    const to = nameOf(n.to)
    go.append(sketch('page'), el('strong', null, words || (n.files.length ? `${n.files.length} attached` : 'Empty note')), ...(to ? [el('span', 'inbox-revising-sent', `To ${to}`)] : []))
    go.addEventListener('click', () => openMemo(n.id))
    node.append(go)
    return node
  })
}

// ---- the hub ----
let hub = false   // the hub keeps notes (its state has `memos`)
/** Does the hub keep the notes? Else they live in this browser alone. */
export const memosOnHub = () => hub
const waiting = new Map()   // note id -> { fields: Set, timer, busy: Promise | null }: what still has to go to the hub
async function post(body) {
  const res = await fetch('/memo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let out = {}
  try { out = await res.json() } catch {}
  if (!res.ok) throw Object.assign(new Error(out.error || res.statusText), { status: res.status, code: out.code })
  return out
}
/** A change is on its way to the hub: typing and carrying a moment later, everything else at once. */
function push(note, fields) {
  const w = waiting.get(note.id) ?? { fields: new Set(), timer: 0, busy: null }
  waiting.set(note.id, w)
  for (const f of fields) if (['text', 'to', 'place', 'x', 'y', 'files'].includes(f)) w.fields.add(f)
  if (!hub || !w.fields.size) return
  clearTimeout(w.timer)
  w.timer = setTimeout(() => flush(note.id), [...w.fields].every(f => f === 'text') ? 350 : 0)
}
/** Send what waits for a note; resolves when the hub holds the note as it stands here. */
async function flush(id) {
  const w = waiting.get(id)
  if (!w) return
  clearTimeout(w.timer)
  w.timer = 0
  if (w.busy) { await w.busy; return flush(id) }
  const note = memo(id)
  if (!hub || !note || (!w.fields.size && note.hid)) { if (!w.fields.size) waiting.delete(id); return }
  const fields = note.hid ? [...w.fields] : ['text', 'to', 'place', 'x', 'y', 'files']
  w.fields.clear()
  const body = note.hid ? { id: note.hid } : {}
  for (const f of fields) {
    if (f === 'files') body.attachments = note.files.map(a => (a.url ? { url: a.url } : { name: a.name, data: a.data }))
    else body[f] = note[f]
  }
  w.busy = post(body).then(out => {
    note.hid = out.memo.id
    note.seen = out.memo.updated
    // The hub has the files now: the note names them as the hub does (unless more were added meanwhile).
    if (fields.includes('files') && !w.fields.has('files')) note.files = out.memo.attachments
    write()
  }, err => {
    // The hub does not know the note any more (sent or thrown away elsewhere): it is gone here too. A session
    // that is gone: the note goes to whoever takes the memos. Anything else is tried again with the next change.
    if (err.code === 'no-memo') { const at = notes.indexOf(note); if (at >= 0) { notes.splice(at, 1); write(); tell({ id }) } }
    else if (err.status === 404 && fields.includes('to')) { note.to = null; w.fields.add('to') }
    else for (const f of fields) w.fields.add(f)
  }).finally(() => { w.busy = null })
  await w.busy
  if (w.fields.size && memo(id) && !w.timer) w.timer = setTimeout(() => flush(id), 4000)
  else if (!w.fields.size) waiting.delete(id)
}
function drop(note) {
  clearTimeout(waiting.get(note.id)?.timer)
  waiting.delete(note.id)
  if (hub && note.hid) post({ id: note.hid, remove: true }).catch(() => {})
}
/** Tear a note off: the hub sends it as a message from the human (to its session, else the one that takes the
 *  memos) and forgets it. Only for a note the hub holds (memosOnHub() and note.hid after `await settleMemo(id)`). */
export async function sendMemo(id) {
  await flush(id)
  const note = memo(id)
  if (!note?.hid) throw new Error('the hub does not hold this note yet')
  const out = await post({ id: note.hid, send: true })
  const at = notes.indexOf(note)
  if (at >= 0) { notes.splice(at, 1); write() }
  waiting.delete(id)
  tell({ id })
  return out.sent
}
/** Wait until the hub holds the note as it stands here; says whether it does. */
export async function settleMemo(id) { if (hub) await flush(id); return Boolean(hub && memo(id)?.hid) }

// What the board's state says: notes of other devices appear, changed ones change, those gone elsewhere go.
function take(list) {
  const first = !hub
  hub = true
  let changed = false
  const theirs = new Map(list.map(m => [m.id, m]))
  for (const note of [...notes]) {
    const w = waiting.get(note.id)
    if (!note.hid) { if (first || !w) push(note, ['text', 'to', 'place', 'x', 'y', 'files']); continue }
    const m = theirs.get(note.hid)
    theirs.delete(note.hid)
    if (!m) { if (!w?.busy) { notes.splice(notes.indexOf(note), 1); waiting.delete(note.id); changed = true } continue }
    if (w?.busy || w?.fields.size || m.updated <= note.seen) { if (first && w?.fields.size) push(note, []); continue }
    Object.assign(note, { text: m.text, to: m.to, place: m.place, x: m.x, y: m.y, files: m.attachments, seen: m.updated, ts: m.updated })
    changed = true
  }
  for (const m of theirs.values()) {
    // (One this tab is creating right now is not a stranger: its answer is still under way.)
    if ([...waiting.values()].some(w => w.busy) && !notes.some(n => n.hid === m.id)) continue
    notes.push(clean({ id: m.id, hid: m.id, seen: m.updated, text: m.text, to: m.to, place: m.place, x: m.x, y: m.y, files: m.attachments, ts: m.updated }))
    changed = true
  }
  if (changed) { write(); tell({ from: 'hub' }) }
  else if (first) tell({ from: 'hub' })
}
let lastList = null
subscribe(state => { const list = state.all?.memos; if (Array.isArray(list) && list !== lastList) { lastList = list; take(list) } })
{ const list = getState().all?.memos; if (Array.isArray(list)) { lastList = list; take(list) } }
