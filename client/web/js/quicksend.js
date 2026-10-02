// Quick send, the memo slip (decided: card Nr. 134): a note to "the boss", the session that wears the
// crown. Closed, it is a small round button at the bottom right, beside the Scratchpad's control, that
// shows the receiver's drawing with its crown, so one sees at a glance whom the note goes to. Open, it
// is a cream slip headed MEMO: "To <drawing> <name>", "From you", ruled lines to write on, a paperclip,
// the microphone (live dictation, speech.js), chips for what goes along, and "Tear off and send".
// Enter sends, Shift+Enter makes a new line. Sent, the slip tears off and a quiet line says to whom.
// The key "/" opens it from anywhere; Esc (or a click beside it) closes it and keeps what was written.
// On a phone it is a sheet at the bottom of the page.
//
// Who receives: exactly one session, shown and never chosen here. It is the crowned session (should
// the board hold several crowns, the one crowned last while this page was open). With no crown the
// slip says so and offers the Ledger (/agents), where a crown is given.
// It is not the Scratchpad: that one stays with the human, this one goes to a session.

import { subscribe, getState, sendMessage } from './store.js'
import { el, sketch } from './ui.js'
import { avatar } from './agents.js'
import { dictationMic, isDictating } from './speech.js'
import { pasteChip } from './cardclip.js'

const KEY = 'trommi-king'
const bar = document.querySelector('.topbar')
const remembered = () => { try { return localStorage.getItem(KEY) } catch { return null } }
const remember = id => { try { localStorage.setItem(KEY, id) } catch {} }
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches

// The pad button's small mark: a slip with a torn lower edge and two lines on it.
function slipMark() {
  const t = document.createElement('template')
  t.innerHTML = '<svg class="memo-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M5.2 3.6 L18.9 3.4 L19.1 20.2 L16.8 18.6 L14.4 20.6 L12 18.7 L9.6 20.5 L7.3 18.6 L5 20.3 Z"/><path d="M8.4 8 L15.8 7.8"/><path d="M8.5 11.6 L15.6 11.5"/></svg>'
  return t.content.firstChild
}
const button = (cls, ...kids) => { const b = el('button', cls); b.type = 'button'; b.append(...kids); return b }

// ---- the slip ----
const memo = el('div', 'memo')                 // the place: the pad underneath, and the slip on it
memo.dataset.state = 'closed'
const under = el('div', 'memo-under')
under.setAttribute('aria-hidden', 'true')
const form = el('form', 'memo-slip')
form.id = 'memo-slip'
form.setAttribute('aria-label', 'Memo to the crowned session')
const head = el('header', 'memo-head')
const field = el('textarea', 'memo-field')
field.rows = 3
field.id = 'quick-field'
field.placeholder = 'Re: …'
field.setAttribute('aria-label', 'Your memo')
field.setAttribute('aria-keyshortcuts', '/')
field.autocomplete = 'off'
const body = el('div', 'memo-body')
body.append(field)
const files = el('div', 'memo-files')
const picker = el('input')
picker.type = 'file'
picker.multiple = true
picker.hidden = true
picker.tabIndex = -1
const clip = button('memo-tool memo-clip', sketch('clip'))
clip.title = 'Attach a picture or a file (or paste it, or drop it on the slip)'
clip.setAttribute('aria-label', 'Attach a picture or a file')
const mic = dictationMic(field, { key: 'quick', onError: text => say(text) })
const send = el('button', 'quick-send memo-send')
send.type = 'submit'
send.append(el('span', null, 'Tear off and send'), sketch('send'))
const foot = el('footer', 'memo-foot')
foot.append(clip, mic, el('i'), send)
// No session wears the crown: the slip says so, and where a crown is given.
const none = el('div', 'memo-none')
const ledger = button('memo-ledger', 'Open the Ledger')
none.append(el('p', null, 'No session wears the crown.'), el('small', null, 'A memo goes to the crowned session. Give one the crown in the Ledger.'), ledger)
form.append(head, none, body, files, foot, picker)
memo.append(under, form)
const note = el('p', 'quick-note memo-note')
note.setAttribute('role', 'status')
note.hidden = true

// The button: the receiver's drawing with its crown, and the small slip.
const opener = button('icon-btn quick-open memo-open')
opener.setAttribute('aria-haspopup', 'dialog')
opener.setAttribute('aria-controls', form.id)
opener.setAttribute('aria-expanded', 'false')
if (bar) (bar.querySelector('.footnav') ?? bar.lastElementChild)?.after(opener)
// The slip and its line stand on the page itself, not in the bar: a phone's sheet lies over everything there.
document.body.append(memo, note)

const isOpen = () => memo.dataset.state !== 'closed'
function setOpen(open) {
  if (memo.dataset.state === 'sending') return
  if (open) hush()
  memo.dataset.state = open ? 'open' : 'closed'
  opener.setAttribute('aria-expanded', String(open))
  if (open) { paintHead(); fit(); (receiver ? field : ledger).focus({ preventScroll: true }) }
  paintDraft()
}
opener.addEventListener('click', () => setOpen(!isOpen()))
document.addEventListener('pointerdown', e => { if (isOpen() && !memo.contains(e.target) && !opener.contains(e.target)) setOpen(false) })
// Esc closes; what was written stays on the slip.
// (Heard at the window, before the table of keys takes Esc to leave the field; a running dictation keeps its Esc.)
window.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !isOpen() || isDictating() || document.querySelector('dialog[open]')) return
  if (!memo.contains(e.target) && e.target !== document.body) return
  e.preventDefault()
  e.stopPropagation()
  setOpen(false)
  opener.focus({ preventScroll: true })
}, true)
ledger.addEventListener('click', () => { setOpen(false); document.getElementById('nav-roster')?.click() })

// ---- who receives: the one crowned session ----
let receiver = null, known = null
function paintHead() {
  const now = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  const line = (word, ...kids) => { const s = el('span', 'memo-line', word); s.append(...kids); return s }
  const who = el('span', 'memo-who')
  if (receiver) who.append(avatar(receiver), el('b', null, receiver.name))
  else who.append(el('em', null, 'nobody yet'))
  head.replaceChildren(el('b', 'memo-title', 'Memo'), line('To', who), line('From', el('em', null, `you, ${now}`)))
}
function paint(state) {
  const crowned = state.all.agents.filter(a => a.starred)
  // One that got its crown while the page was open is the receiver from then on.
  if (known) for (const a of crowned) if (!known.has(a.id)) remember(a.id)
  known = new Set(crowned.map(a => a.id))
  const next = crowned.find(a => a.id === remembered()) ?? crowned.at(-1) ?? null
  const sig = JSON.stringify(next && [next.id, next.name, next.mark, next.icon, next.online])
  if (sig === paint.sig) return
  paint.sig = sig
  receiver = next
  memo.toggleAttribute('data-none', !receiver)
  opener.toggleAttribute('data-none', !receiver)
  if (receiver) opener.dataset.to = receiver.id
  else delete opener.dataset.to
  const tick = el('span', 'memo-tick')
  tick.append(slipMark())
  opener.replaceChildren(...(receiver ? [avatar(receiver), tick] : [slipMark()]))
  opener.title = receiver ? `Memo to ${receiver.name} ( / )` : 'Memo: no session wears the crown ( / )'
  opener.setAttribute('aria-label', opener.title)
  field.setAttribute('aria-label', receiver ? `Your memo to ${receiver.name}` : 'Your memo')
  paintHead()
  paintDraft()
}

// ---- what goes along: pictures and files, by the clip, pasted or dropped ----
let attached = []   // [{ name, data }], data a data: URL, as the server takes them
function paintFiles() {
  files.replaceChildren(...attached.map((a, i) => {
    const chip = button('memo-file', sketch(/^data:image\//.test(a.data) ? 'picture' : 'page'), el('span', null, a.name), el('i', null, '×'))
    chip.title = `${a.name}: click to take it off`
    chip.addEventListener('click', () => { attached.splice(i, 1); paintFiles(); field.focus() })
    return chip
  }))
  memo.toggleAttribute('data-files', attached.length > 0)
  paintDraft()
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
  try { attached.push(...await Promise.all(got.map(read))) } catch (err) { say(`Not attached: ${err?.message ?? 'the file could not be read'}`) }
  paintFiles()
  return true
}
clip.addEventListener('click', () => picker.click())
picker.addEventListener('change', async () => { await attach(picker.files); picker.value = ''; field.focus() })
field.addEventListener('paste', e => { if (e.clipboardData?.files?.length) { e.preventDefault(); attach(e.clipboardData.files) } })
form.addEventListener('dragover', e => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); form.classList.add('is-drop') } })
form.addEventListener('dragleave', () => form.classList.remove('is-drop'))
form.addEventListener('drop', e => { form.classList.remove('is-drop'); if (e.dataTransfer?.files?.length) { e.preventDefault(); attach(e.dataTransfer.files) } })

// Chips above the field: a copied decision goes along as a chip (cardclip.js), offered there, or Ctrl+V.
const clipped = pasteChip(field, { host: body, onChange: () => { fit(); paintDraft() } })

// ---- the field: three ruled lines, more while it holds more ----
const holds = () => Boolean(field.value.trim() || attached.length || clipped?.ids())
function fit() {
  field.style.height = 'auto'
  field.style.height = `${Math.min(Math.max(field.scrollHeight, 84), Math.round(window.innerHeight * .4 / 28) * 28)}px`
}
// A small dot on the closed button: a memo lies there, written and not sent.
function paintDraft() { opener.toggleAttribute('data-draft', !isOpen() && holds()) }
field.addEventListener('input', fit)
field.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit() }
})

let noteTimer = 0
function hush() { clearTimeout(noteTimer); note.hidden = true }
function say(text, link = null) {
  clearTimeout(noteTimer)
  note.replaceChildren(text)
  if (link) note.append(' ', link)
  note.hidden = false
  noteTimer = setTimeout(() => { note.hidden = true }, 5000)
}
// The slip tears off the pad and is gone. Without motion it is only gone.
const tearOff = () => new Promise(done => {
  if (calm()) return done()
  memo.dataset.state = 'sending'
  const end = () => { clearTimeout(timer); form.removeEventListener('animationend', over); done() }
  const over = e => { if (e.target === form) end() }
  const timer = setTimeout(end, 900)
  form.addEventListener('animationend', over)
})
form.addEventListener('submit', async e => {
  e.preventDefault()
  if (form.hasAttribute('aria-busy')) return
  const text = field.value.trim()
  if (!receiver) return ledger.focus()
  if (!holds()) return field.focus()
  const target = receiver
  form.setAttribute('aria-busy', 'true')
  try {
    await sendMessage(text, target.id, null, attached, {}, clipped.ids())
    await tearOff()
    clipped.clear(true)
    field.value = ''
    attached = []
    memo.dataset.state = 'closed'
    opener.setAttribute('aria-expanded', 'false')
    paintFiles()
    fit()
    if (memo.contains(document.activeElement)) opener.focus({ preventScroll: true })
    // Say that it went, with the way to the conversation. (The store has no way to take a message back: no Undo.)
    const open = button('quick-go', 'Open the conversation')
    open.addEventListener('click', () => { hush(); document.querySelector(`.agent-row[data-members~="${CSS.escape(target.id)}"] .agent-entry`)?.click() })
    say(`Sent to ${target.name}.`, open)
  } catch (err) {
    say(`Not sent: ${err.message}`)
  }
  form.removeAttribute('aria-busy')
})

subscribe(paint)
paint(getState())
fit()

// "/" from anywhere: the slip opens, the keyboard is in its field.
window.addEventListener('keydown', e => {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return
  if (e.target.closest?.('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]')) return
  e.preventDefault()
  setOpen(true)
})

/** Open the memo slip and put the keyboard into its field (for the table of keys). */
export function focusQuickSend() { setOpen(true) }
