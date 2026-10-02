// Quick send: a slim field in the bar, there from every view, to fire a few words at the session that
// wears the crown ("to the king"). Enter sends them as a plain chat message to that session (no card);
// Shift+Enter makes a new line, and the field grows upward over the page while it holds more than one.
// A picture or a file that is pasted or dropped goes along. The microphone dictates into it. The key
// "/" jumps into it from anywhere (heard here; the table in keys.js does not list it yet).
//
// Who receives: the crowned session; of several, the one crowned last while this page was open, or the
// one picked with the small chevron (remembered in this browser). With no crown the field says so, and
// a click offers the sessions: picking one crowns it.

import { subscribe, getState, sendMessage, star } from './store.js'
import { el, sketch } from './ui.js'
import { avatar } from './agents.js'
import { dictationMic } from './speech.js'

const KEY = 'trommi-king'
const bar = document.querySelector('.topbar')
const remembered = () => { try { return localStorage.getItem(KEY) } catch { return null } }
const remember = id => { try { localStorage.setItem(KEY, id) } catch {} }

const form = el('form', 'quick')
form.setAttribute('aria-label', 'Quick send to the crowned session')
const to = el('button', 'quick-to')
to.type = 'button'
const field = el('textarea', 'quick-field')
field.rows = 1
field.id = 'quick-field'
field.setAttribute('aria-keyshortcuts', '/')
field.autocomplete = 'off'
const files = el('div', 'quick-files')
const mic = dictationMic(field, { key: 'quick' })
const send = el('button', 'quick-send')
send.type = 'submit'
send.setAttribute('aria-label', 'Send')
send.append(sketch('send'))
const note = el('p', 'quick-note')
note.setAttribute('role', 'status')
note.hidden = true
const box = el('div', 'quick-box')
box.append(files, field)
form.append(to, box, mic, send, note)
// On a phone the field is behind one icon in the bar and opens as a sheet under it.
const opener = el('button', 'icon-btn quick-open')
opener.type = 'button'
opener.setAttribute('aria-label', 'Quick send to the crowned session')
opener.append(sketch('send'))
opener.addEventListener('click', () => { const open = form.classList.toggle('is-sheet'); opener.setAttribute('aria-expanded', String(open)); if (open) field.focus() })
if (bar) {
  const after = bar.querySelector('.footnav')
  if (after) after.after(form, opener)
  else bar.append(form, opener)
}

// ---- who receives ----
let receiver = null, crowned = [], known = null, sessions = []
function paint(state) {
  sessions = state.all.agents
  crowned = sessions.filter(a => a.starred)
  const ids = new Set(crowned.map(a => a.id))
  // One that got its crown while the page was open is the receiver from then on.
  if (known) for (const a of crowned) if (!known.has(a.id)) remember(a.id)
  known = ids
  const next = crowned.find(a => a.id === remembered()) ?? crowned.at(-1) ?? null
  const sig = JSON.stringify([next && [next.id, next.name, next.mark, next.online], crowned.length])
  if (sig === paint.sig) return
  paint.sig = sig
  receiver = next
  form.toggleAttribute('data-none', !receiver)
  to.replaceChildren(...(receiver ? [avatar(receiver)] : [sketch('heads')]), ...(crowned.length > 1 || !receiver ? [el('span', 'quick-switch')] : []))
  to.querySelector('.quick-switch')?.append(sketch('unfold'))
  to.title = !receiver ? 'Crown a session: it receives what you send here' : crowned.length > 1 ? `To ${receiver.name}. Click to send to another crowned session` : `To ${receiver.name}`
  to.setAttribute('aria-label', to.title)
  field.placeholder = receiver ? `To ${receiver.name}…` : 'Crown a session to send here'
  field.readOnly = !receiver
}
subscribe(paint)

// ---- the small list of sessions: switch the receiver, or crown one ----
let list = null
function closeList() { list?.remove(); list = null; to.setAttribute('aria-expanded', 'false') }
function openList() {
  if (list) return closeList()
  list = el('div', 'quick-list')
  list.setAttribute('role', 'menu')
  const head = el('p', 'caps', crowned.length ? 'Send to' : 'Crown a session to send here')
  list.append(head)
  for (const a of [...crowned, ...sessions.filter(s => !s.starred)]) {
    const b = el('button')
    b.type = 'button'
    b.setAttribute('role', 'menuitem')
    b.append(avatar(a), el('span', null, a.name), ...(a.starred ? [] : [el('i', null, 'crown it')]))
    if (a.id === receiver?.id) b.setAttribute('aria-current', 'true')
    b.addEventListener('click', async () => {
      remember(a.id)
      closeList()
      if (!a.starred) await star(a.id, true).catch(err => say(`Not crowned: ${err.message}`))
      paint.sig = ''
      paint(getState())
      field.focus()
    })
    list.append(b)
  }
  form.append(list)
  to.setAttribute('aria-expanded', 'true')
  list.querySelector('button')?.focus()
}
to.addEventListener('click', openList)
field.addEventListener('pointerdown', e => { if (!receiver) { e.preventDefault(); openList() } })
document.addEventListener('pointerdown', e => { if (list && !form.contains(e.target)) closeList() })
form.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return
  if (list) { e.stopPropagation(); closeList(); to.focus() } else if (document.activeElement === field) { e.stopPropagation(); field.blur(); form.classList.remove('is-sheet') }
})

// ---- what goes along: pictures and files, pasted or dropped ----
let attached = []   // [{ name, data }], data a data: URL, as the server takes them
function paintFiles() {
  files.replaceChildren(...attached.map((a, i) => {
    const chip = el('button', 'quick-file')
    chip.type = 'button'
    chip.title = `${a.name}: click to take it off`
    chip.append(sketch(/^data:image\//.test(a.data) ? 'picture' : 'page'), el('span', null, a.name))
    chip.addEventListener('click', () => { attached.splice(i, 1); paintFiles() })
    return chip
  }))
  form.toggleAttribute('data-files', attached.length > 0)
}
const read = file => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve({ name: file.name || `pasted-${Date.now()}.png`, data: reader.result })
  reader.onerror = () => reject(reader.error)
  reader.readAsDataURL(file)
})
async function attach(list) {
  const got = [...list].filter(f => f instanceof File)
  if (!got.length) return false
  attached.push(...await Promise.all(got.map(read)))
  paintFiles()
  return true
}
field.addEventListener('paste', e => { if (e.clipboardData?.files?.length) { e.preventDefault(); attach(e.clipboardData.files) } })
form.addEventListener('dragover', e => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); form.classList.add('is-drop') } })
form.addEventListener('dragleave', () => form.classList.remove('is-drop'))
form.addEventListener('drop', e => { form.classList.remove('is-drop'); if (e.dataTransfer?.files?.length) { e.preventDefault(); attach(e.dataTransfer.files) } })

// ---- the field: one line, more while it holds more ----
function fit() {
  field.style.height = 'auto'
  const lines = field.value.includes('\n') || field.scrollHeight > 44
  form.toggleAttribute('data-tall', lines)
  field.style.height = lines ? `${Math.min(field.scrollHeight, window.innerHeight * .4)}px` : ''
  send.hidden = !field.value.trim() && !attached.length
}
field.addEventListener('input', fit)
field.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit() }
})
let noteTimer = 0
function say(text, link = null) {
  clearTimeout(noteTimer)
  note.replaceChildren(text)
  if (link) note.append(' ', link)
  note.hidden = false
  noteTimer = setTimeout(() => { note.hidden = true }, 5000)
}
form.addEventListener('submit', async e => {
  e.preventDefault()
  const text = field.value.trim()
  if (!receiver) return openList()
  if (!text && !attached.length) return field.focus()
  const target = receiver
  form.setAttribute('aria-busy', 'true')
  try {
    await sendMessage(text, target.id, null, attached)
    field.value = ''
    attached = []
    paintFiles()
    fit()
    // Say that it went, with the way to the conversation.
    const open = el('button', 'quick-go', 'Open the conversation')
    open.type = 'button'
    open.addEventListener('click', () => { note.hidden = true; form.classList.remove('is-sheet'); document.querySelector(`.agent-row[data-members~="${CSS.escape(target.id)}"] .agent-entry`)?.click() })
    say(`Sent to ${target.name}.`, open)
  } catch (err) {
    say(`Not sent: ${err.message}`)
  }
  form.removeAttribute('aria-busy')
})
fit()

// "/" from anywhere: into the field.
window.addEventListener('keydown', e => {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return
  if (e.target.closest?.('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]')) return
  e.preventDefault()
  if (opener.offsetParent) { form.classList.add('is-sheet'); opener.setAttribute('aria-expanded', 'true') }
  if (!receiver) openList()
  else field.focus()
})

/** Put the keyboard into the quick-send field (for the table of keys). */
export function focusQuickSend() { if (receiver) field.focus(); else openList() }
