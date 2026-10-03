// The memo: a small yellow sticky note to a session (first decided as "quick send", card Nr. 134).
// A note lives from the moment it is made until it is torn off and sent, or thrown away (js/memos.js keeps
// the notes; several can exist at once). The yellow round button (bottom right; small at the top right in a
// session) and the key "/" make one, or go to the empty one that already floats.
//
// A note floats over whatever page is shown and stays there while one goes elsewhere and after a reload. It is
// carried by its head; dropped on the Desk's bare paper it lies on the paper and scrolls with it (js/padlink.js
// gives the layer and the paper's pixels: paperLayer(), paperPoint()). Its head reads
// "MEMO  TO <drawing> <name>" in one line; the receiver is a control (by default the session that receives
// quick memos: the starred one, should there be several the one starred last while this page was open). Below:
// ruled lines that grow with the words, a paperclip, the microphone (speech.js), chips for what goes along,
// and at the lower right, at the end of the dashed tear line, the paper plane: "Tear off and send"
// (Enter; Shift+Enter makes a new line). Sent, the note tears off and a quiet line says to whom. Esc or the stack button puts a note
// away: it then lies on the yellow "Memos" stack of the Desk (an empty one is simply gone). The bin throws
// it away; the quiet line offers the way back.
// On a phone a note is a sheet at the bottom of the page, one at a time, not carried about; a tap beside it
// puts it away.
// It is not the Scratchpad: that one stays with the human, this one goes to a session.

import { subscribe, getState, sendMessage } from './store.js'
import { el, sketch } from './ui.js'
import { avatar } from './agents.js'
import { dictationMic, isDictating } from './speech.js'
import { pasteChip } from './cardclip.js'
import { link, sessionPath } from './link.js'
import { paperPoint, paperLayer } from './padlink.js'
import { memos, memo, onMemos, newMemo, saveMemo, removeMemo, restoreMemo, memosOnHub, settleMemo, sendMemo, sheetMemo, setSheet, onStack } from './memos.js'

const KEY = 'trommi-king'
const bar = document.querySelector('.topbar')
const remembered = () => { try { return localStorage.getItem(KEY) } catch { return null } }
const remember = id => { try { localStorage.setItem(KEY, id) } catch {} }
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const sheet = matchMedia('(max-width: 860px)')   // a phone: the note is a sheet at the bottom
const W = 340   // a note's width on a wide screen (css/quicksend.css)

const svg = html => { const t = document.createElement('template'); t.innerHTML = html; return t.content.firstChild }
// The button's mark: a yellow sticky note with a folded corner and two lines, in the board's pen.
const stickyNote = () => svg('<svg class="memo-sticky" viewBox="0 0 24 24" aria-hidden="true"><path class="sticky-paper" d="M4.3 4.2 Q12 3.5 19.8 3.9 Q20.3 9.4 20 14.7 L14.8 20.2 Q9.3 20.4 4.1 19.9 Q3.8 12 4.3 4.2 Z"/><path class="sticky-fold" d="M20 14.7 Q17.4 14.5 15.3 14.9 Q14.7 17.4 14.8 20.2"/><path class="sticky-line" d="M7.6 8.6 Q12 8.1 16.3 8.4"/><path class="sticky-line" d="M7.7 12.1 Q10.6 11.7 13.4 12"/></svg>')
// Tear off and send: a paper plane, drawn with the pen.
const plane = () => svg('<svg class="memo-plane" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.4 11.4 Q12.2 7.2 20.6 3.6 Q17.6 12.2 14.3 20.5 Q12.6 16.9 11.2 13.2 Q7.2 12.5 3.4 11.4 Z"/><path d="M11.2 13.2 Q15.8 8.6 20.6 3.6"/></svg>')
const button = (cls, ...kids) => { const b = el('button', cls); b.type = 'button'; b.append(...kids); return b }

// ---- the button: a yellow sticky note. Whom a memo goes to is said by its tooltip and on the note ("To"). ----
const opener = button('icon-btn quick-open memo-open', stickyNote())
opener.setAttribute('aria-haspopup', 'dialog')
opener.setAttribute('aria-expanded', 'false')
if (bar) (bar.querySelector('.footnav') ?? bar.lastElementChild)?.after(opener)
// The quiet line that says what happened to a note.
const line = el('p', 'quick-note memo-note')
line.setAttribute('role', 'status')
line.hidden = true
document.body.append(line)
// On a card page (focus.js: body[data-focus-page]) the bar lies under the page: the round button moves out of the
// bar for that time, so a note can be made there too.
const home = { parent: opener.parentNode, next: opener.nextSibling }
const placeOpener = () => {
  const page = document.body.hasAttribute('data-focus-page')
  if (page && opener.parentNode !== document.body) { document.body.append(opener); opener.classList.add('memo-open-free') }
  else if (!page && opener.parentNode === document.body && home.parent) { home.parent.insertBefore(opener, home.next?.parentNode === home.parent ? home.next : null); opener.classList.remove('memo-open-free') }
}
new MutationObserver(placeOpener).observe(document.body, { attributes: true, attributeFilter: ['data-focus-page'] })
placeOpener()

let lineTimer = 0
function hush() { clearTimeout(lineTimer); line.hidden = true }
function say(text, action = null) {
  clearTimeout(lineTimer)
  line.replaceChildren(text)
  if (action) line.append(' ', action)
  line.hidden = false
  lineTimer = setTimeout(() => { line.hidden = true }, 5000)
}

// ---- who receives by default: the starred session ----
let sessions = [], usual = null, known = null
const receiverOf = note => sessions.find(a => a.id === note.to) ?? usual
function paintSessions(state) {
  const starred = state.all.agents.filter(a => a.starred)
  // One that got its star while the page was open is the receiver from then on.
  if (known) for (const a of starred) if (!known.has(a.id)) remember(a.id)
  known = new Set(starred.map(a => a.id))
  const next = starred.find(a => a.id === remembered()) ?? starred.at(-1) ?? null
  const list = state.all.agents.filter(a => !a.other_desk)
  const sig = JSON.stringify([next?.id, list.map(a => [a.id, a.name, a.mark, a.icon, a.online, a.starred, a.main])])
  if (sig === paintSessions.sig) return
  paintSessions.sig = sig
  sessions = list
  usual = next
  if (usual) opener.dataset.to = usual.id
  else delete opener.dataset.to
  opener.title = usual ? `Memo to ${usual.name} ( / )` : 'Memo: a note to a session ( / )'
  opener.setAttribute('aria-label', opener.title)
  for (const v of views.values()) v.paintTo()
}

// ---- a note on the page ----
const views = new Map()   // note id -> its view
const read = file => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve({ name: file.name || `pasted-${Date.now()}.png`, data: reader.result })
  reader.onerror = () => reject(reader.error)
  reader.readAsDataURL(file)
})
/** A file of a note as { name, data }: one the hub holds is fetched. */
const asData = async a => (a.data ? { name: a.name, data: a.data } : read(new File([await (await fetch(a.url)).blob()], a.name)))
const deskShown = () => document.body.dataset.scope === 'all' && !document.body.dataset.page && !document.body.hasAttribute('data-focus-page') && !document.documentElement.classList.contains('focus-lock')
/** Does the point lie on the Desk's bare paper (js/padlink.js), with nothing of the page over it?
 *  (`but`: the note being carried, which is not in the way of itself.) */
function onPaper(x, y, but = null) {
  if (!paperLayer?.() || !deskShown()) return false
  const was = but?.style.pointerEvents
  if (but) but.style.pointerEvents = 'none'
  const hit = document.elementFromPoint(x, y)
  if (but) but.style.pointerEvents = was
  return Boolean(hit?.closest('#deskpad, #deskpad-layer')) && !hit.closest('.memo')
}

function makeView(id) {
  const node = el('div', 'memo')
  node.dataset.id = id
  node.dataset.state = 'open'
  const form = el('form', 'memo-slip')
  form.setAttribute('role', 'dialog')
  form.setAttribute('aria-label', 'Memo')

  // The head, one line: MEMO  TO <drawing> <name>, and at its end the stack and the bin. The note is carried by it.
  const head = el('header', 'memo-head')
  const to = el('label', 'memo-to')
  const who = el('span', 'memo-who')
  const pick = el('select', 'memo-pick')
  pick.setAttribute('aria-label', 'Who receives this memo')
  to.append(el('span', 'memo-to-word', 'To'), who, pick)
  const away = button('memo-tool memo-away', sketch('stack'))
  away.title = 'Put it on the Memos stack of the Desk (Esc)'
  away.setAttribute('aria-label', 'Put the note on the Memos stack')
  const bin = button('memo-tool memo-bin', sketch('bin'))
  bin.title = 'Throw the note away'
  bin.setAttribute('aria-label', 'Throw the note away')
  head.append(el('b', 'memo-title', 'Memo'), to, el('i'), away, bin)

  const field = el('textarea', 'memo-field')
  field.rows = 3
  field.placeholder = 'Re: …'
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
  clip.title = 'Attach a picture or a file (or paste it, or drop it on the note)'
  clip.setAttribute('aria-label', 'Attach a picture or a file')
  const mic = dictationMic(field, { key: `quick:${id}`, onError: text => say(text) })
  // Tear off and send: the paper plane at the end of the dashed line the note tears along.
  const send = el('button', 'quick-send memo-send')
  send.type = 'submit'
  send.title = 'Tear off and send (Enter)'
  send.setAttribute('aria-label', 'Tear off and send')
  send.setAttribute('aria-keyshortcuts', 'Enter')
  send.append(plane())
  const tear = el('i', 'memo-tear')
  tear.setAttribute('aria-hidden', 'true')
  // A hub that keeps no notes yet: said quietly, the note lives in this browser then.
  const local = el('small', 'memo-local', 'this browser only')
  local.title = 'The hub does not keep notes yet (it has to be restarted): this note is kept in this browser.'
  const foot = el('footer', 'memo-foot')
  foot.append(clip, mic, local, tear, send)
  form.append(head, body, files, foot, picker)
  node.append(form)

  const note = () => memo(id)
  const attached = () => note()?.files ?? []
  let filesSig = null
  // Chips above the field: a copied decision goes along as a chip (cardclip.js), offered there, or Ctrl+V.
  // They are kept with the note in this browser (the hub's note does not carry them), so a reload still has them.
  const clipped = pasteChip(field, { host: body, initial: note()?.chips ?? [], onChange: () => { fit(); if (note()) saveMemo(id, { chips: clipped.cards() }, { quiet: true }) } })
  const holds = () => Boolean(field.value.trim() || attached().length || clipped?.ids())

  function fit() {
    field.style.height = 'auto'
    field.style.height = `${Math.min(Math.max(field.scrollHeight, 84), Math.round(window.innerHeight * .4 / 28) * 28)}px`
    send.disabled = !holds() || !receiverOf(note() ?? {})
  }
  function paintTo() {
    const n = note()
    if (!n) return
    const target = receiverOf(n)
    who.replaceChildren(...(target ? [avatar(target), el('b', null, target.name)] : [el('em', null, 'choose a session')]), sketch('unfold'))
    pick.replaceChildren(...(target ? [] : [new Option('Choose a session', '')]), ...sessions.map(a => new Option(a.name, a.id)))
    pick.value = target?.id ?? ''
    form.setAttribute('aria-label', target ? `Memo to ${target.name}` : 'Memo')
    field.setAttribute('aria-label', target ? `Your memo to ${target.name}` : 'Your memo')
    fit()
  }
  function paintFiles() {
    filesSig = attached().map(a => a.url ?? a.name).join('|')
    files.replaceChildren(...attached().map((a, i) => {
      const chip = button('memo-file', sketch(a.image || /^data:image\//.test(a.data ?? '') ? 'picture' : 'page'), el('span', null, a.name), el('i', null, '×'))
      chip.title = `${a.name}: click to take it off`
      chip.addEventListener('click', () => { keep({ files: attached().filter((_, at) => at !== i) }); paintFiles(); field.focus() })
      return chip
    }))
    fit()
  }
  /** What the note holds now, kept at once (the notes' other listeners, the Desk's stack, hear of it). */
  const keep = change => saveMemo(id, change, { quiet: false })
  /** Show what the kept note says (it may have been changed in another tab); what is being typed here is left alone. */
  function update() {
    const n = note()
    if (!n) return
    if (document.activeElement !== field && field.value !== n.text) field.value = n.text
    if (n.files.map(a => a.url ?? a.name).join('|') !== filesSig) paintFiles()
    local.hidden = memosOnHub()
    paintTo()
  }
  async function attach(list) {
    const got = [...list].filter(f => f instanceof File)
    if (!got.length) return false
    try { const fresh = await Promise.all(got.map(read)); keep({ files: [...attached(), ...fresh] }) } catch (err) { say(`Not attached: ${err?.message ?? 'the file could not be read'}`) }
    paintFiles()
    return true
  }
  pick.addEventListener('change', () => { keep({ to: pick.value || null }); paintTo(); field.focus({ preventScroll: true }) })
  clip.addEventListener('click', () => picker.click())
  picker.addEventListener('change', async () => { await attach(picker.files); picker.value = ''; field.focus() })
  field.addEventListener('paste', e => { if (e.clipboardData?.files?.length) { e.preventDefault(); attach(e.clipboardData.files) } })
  form.addEventListener('dragover', e => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); form.classList.add('is-drop') } })
  form.addEventListener('dragleave', () => form.classList.remove('is-drop'))
  form.addEventListener('drop', e => { form.classList.remove('is-drop'); if (e.dataTransfer?.files?.length) { e.preventDefault(); attach(e.dataTransfer.files) } })
  // Every stroke is kept at once.
  field.addEventListener('input', () => { fit(); keep({ text: field.value }) })
  field.addEventListener('focus', () => front(id))
  // Enter tears it off and sends it (decided: card Nr. 134), Shift+Enter makes a new line; Ctrl+Enter (Cmd+Enter) sends too.
  field.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit() }
  })

  /** Put the note away: on the Memos stack of the Desk; an empty one is gone. */
  function putAway() {
    if (node.dataset.state === 'sending') return
    const had = node.contains(document.activeElement)
    if (!holds()) removeMemo(id)
    else {
      saveMemo(id, { place: 'stack' })
      const desk = link('quick-go', '/')
      desk.textContent = 'Desk'
      desk.addEventListener('click', () => { hush(); document.getElementById('nav-inbox')?.click() })
      if (!deskShown()) say('The note lies on the Memos stack of the', desk)
    }
    if (had) opener.focus({ preventScroll: true })
  }
  away.addEventListener('click', putAway)
  bin.addEventListener('click', () => {
    const gone = removeMemo(id)
    if (!gone || !(gone.text.trim() || gone.files.length)) return
    const back = button('quick-go', 'Take it back')
    back.addEventListener('click', () => { hush(); restoreMemo(gone) })
    say('Note thrown away.', back)
  })

  // The note tears off and is gone. Without motion it is only gone.
  const tearOff = () => new Promise(done => {
    if (calm()) return done()
    node.dataset.state = 'sending'
    const end = () => { clearTimeout(timer); form.removeEventListener('animationend', over); done() }
    const over = e => { if (e.target === form) end() }
    const timer = setTimeout(end, 900)
    form.addEventListener('animationend', over)
  })
  form.addEventListener('submit', async e => {
    e.preventDefault()
    if (form.hasAttribute('aria-busy')) return
    const n = note(), target = n && receiverOf(n)
    if (!target) return pick.focus()
    if (!holds()) return field.focus()
    form.setAttribute('aria-busy', 'true')
    v.sending = true   // (the page leaves the note alone until it has flown off)
    try {
      const cards = clipped.ids()
      if (!cards && await settleMemo(id)) {
        // The hub holds the note: it sends it as it stands (to the session shown here) and forgets it.
        if (!n.to) saveMemo(id, { to: target.id }, { quiet: true })
        await sendMemo(id)
      } else {
        // A hub that keeps no notes, or copied questions go along (the hub's note does not carry those): as a message.
        await sendMessage(field.value.trim(), target.id, null, await Promise.all(attached().map(asData)), {}, cards)
        removeMemo(id)   // it went: the note is no more, also if the page is left while it tears off
      }
      const had = node.contains(document.activeElement)
      views.delete(id)
      await tearOff()
      clipped.clear(true)
      node.remove()
      paintOpener()
      if (had) opener.focus({ preventScroll: true })
      // Say that it went, with the way to the conversation. (The store has no way to take a message back: no Undo.)
      const open = link('quick-go', sessionPath(target.id))
      open.textContent = 'Open the conversation'
      open.addEventListener('click', () => { hush(); document.querySelector(`.agent-row[data-members~="${CSS.escape(target.id)}"] .agent-entry`)?.click() })
      say(`Sent to ${target.name}.`, open)
    } catch (err) {
      say(`Not sent: ${err.message}`)
      v.sending = false
      form.removeAttribute('aria-busy')
    }
  })

  // ---- carried by its head (a wide screen): anywhere over the page, or onto the Desk's paper ----
  // A phone: the sheet is not carried; a note that lies on the paper is moved about on the paper.
  head.addEventListener('pointerdown', e => {
    if (e.button || e.target.closest('button, select, label, a')) return
    if (sheet.matches) {
      if (!node.classList.contains('is-paper')) return
      const start = paperPoint(e.clientX, e.clientY), n0 = note()
      if (!start || !n0) return
      const x0 = n0.x, y0 = n0.y
      let to = null
      const spot = ev => { const p = paperPoint(ev.clientX, ev.clientY); return p && { x: Math.max(0, x0 + p.x - start.x), y: Math.max(0, y0 + p.y - start.y) } }
      const move = ev => { const p = spot(ev); if (!p) return; to = p; node.classList.add('is-carried'); node.style.left = `${p.x}px`; node.style.top = `${p.y}px` }
      const up = () => {
        for (const type of ['pointermove', 'pointerup', 'pointercancel']) head.removeEventListener(type, type === 'pointermove' ? move : up)
        node.classList.remove('is-carried')
        if (to) saveMemo(id, { x: to.x, y: to.y })
      }
      try { head.setPointerCapture(e.pointerId) } catch {}
      head.addEventListener('pointermove', move)
      head.addEventListener('pointerup', up)
      head.addEventListener('pointercancel', up)
      return
    }
    const r = node.getBoundingClientRect()
    const dx = e.clientX - r.left, dy = e.clientY - r.top
    let moved = false
    const at = ev => [Math.min(Math.max(ev.clientX - dx, 4), window.innerWidth - r.width - 4), Math.min(Math.max(ev.clientY - dy, 4), window.innerHeight - 40)]
    const move = ev => {
      if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return
      if (!moved) {
        moved = true
        // Lifted: it floats over everything while it is carried (off the paper, should it lie there).
        node.classList.remove('is-paper')
        node.classList.add('is-carried')
        if (node.parentNode !== floor()) { floor().append(node); try { head.setPointerCapture(e.pointerId) } catch {} }
      }
      const [x, y] = at(ev)
      node.style.left = `${x}px`
      node.style.top = `${y}px`
      node.classList.toggle('over-paper', onPaper(ev.clientX, ev.clientY, node))
    }
    const up = ev => {
      head.removeEventListener('pointermove', move)
      head.removeEventListener('pointerup', up)
      head.removeEventListener('pointercancel', up)
      node.classList.remove('is-carried', 'over-paper')
      if (!moved) return
      const [x, y] = at(ev)
      // On the paper it lies in the paper's own pixels (padlink.js paperPoint) and scrolls with it.
      const at2 = ev.type === 'pointerup' && onPaper(ev.clientX, ev.clientY, node) ? paperPoint(x, y) : null
      if (at2) saveMemo(id, { place: 'paper', x: at2.x, y: at2.y })
      else saveMemo(id, { place: 'float', x: Math.round(x), y: Math.round(y) })
    }
    front(id)   // (first: moving the note in the page lets go of the pointer)
    try { head.setPointerCapture(e.pointerId) } catch {}
    head.addEventListener('pointermove', move)
    head.addEventListener('pointerup', up)
    head.addEventListener('pointercancel', up)
  })

  const v = { id, node, form, field, update, paintTo, putAway, holds, fit }
  views.set(id, v)
  field.value = note()?.text ?? ''
  paintFiles()
  paintTo()
  return v
}

// ---- where the notes stand ----
let last = null   // the note the keyboard was in last: it holds the id the keys and the tests look for
function front(id) {
  const v = views.get(id)
  if (!v) return
  last = id
  for (const o of views.values()) o.field.removeAttribute('id')
  v.field.id = 'quick-field'
  const host = v.node.parentNode
  if (!v.node.classList.contains('is-paper') && host && v.node !== host.lastElementChild && !v.node.contains(document.activeElement)) host.append(v.node)
}
/** Where floating notes stand: the page; while a card is open as its page or window, inside that (js/focus.js keeps
 *  the keyboard within its own element and takes it back from anything outside, on every change of the board). */
function floor() {
  const card = document.querySelector('body > .focus:not([data-inline])')
  return card && (document.documentElement.classList.contains('focus-lock') || document.body.hasAttribute('data-focus-page')) ? card : document.body
}
function stand(v, n) {
  const { node } = v
  if (node.classList.contains('is-carried') || node.dataset.state === 'sending') return
  const paper = n.place === 'paper' ? paperLayer?.() ?? null : null
  const host = paper ?? floor()
  if (node.parentNode !== host) {
    const had = node.contains(document.activeElement) ? document.activeElement : null
    host.append(node)
    had?.focus?.({ preventScroll: true })
  }
  node.classList.toggle('is-paper', Boolean(paper))
  // (A phone: a note of the paper lies on the paper there too; until the paper is laid it waits unseen.)
  if (sheet.matches && !paper) { node.style.left = node.style.top = ''; if (n.place === 'paper') node.hidden = true; return }
  if (paper) {
    node.style.left = `${Math.max(0, n.x)}px`
    node.style.top = `${Math.max(0, n.y)}px`
  } else {
    node.style.left = `${Math.min(Math.max(n.x, 4), Math.max(4, window.innerWidth - W - 4))}px`
    node.style.top = `${Math.min(Math.max(n.y, 4), Math.max(4, window.innerHeight - 120))}px`
  }
}
function paintOpener() {
  const all = memos()
  opener.setAttribute('aria-expanded', String(all.some(n => !onStack(n))))
  opener.toggleAttribute('data-draft', all.some(onStack))
  // A phone's sheet lies over the page behind a veil; the page knows (css/quicksend.css).
  document.body.toggleAttribute('data-memo-open', sheet.matches && [...views.values()].some(v => !v.node.hidden && !v.node.classList.contains('is-paper')))
}
function sync(why = {}) {
  const all = memos()
  for (const [id, v] of views) if (!v.sending && !all.some(n => n.id === id && n.place !== 'stack')) { v.node.remove(); views.delete(id) }
  // A phone shows one sheet, and only a note he opened on this page (never one by itself on load): the others
  // wait on the Memos stack of the Desk (js/memos.js onStack) until he taps them.
  if (why.focus && why.id) setSheet(why.id)
  const top = sheet.matches ? all.find(n => n.place === 'float' && n.id === sheetMemo()) ?? null : null
  for (const n of all) {
    if (n.place === 'stack') continue
    // Taken off the stack (or made elsewhere without a place): it gets one.
    if (n.place === 'float' && !n.x && !n.y && !sheet.matches) saveMemo(n.id, spot(), { quiet: true })
    const v = views.get(n.id) ?? makeView(n.id)
    v.update()
    v.node.hidden = Boolean(sheet.matches && n.place === 'float' && n !== top)
    stand(v, n)
    v.fit()
  }
  if (why.focus && why.id && views.has(why.id)) { hush(); front(why.id); views.get(why.id).field.focus({ preventScroll: true }) }
  if (!views.has(last)) last = null
  paintOpener()
}
onMemos(sync)
// A card opens or closes: the floating notes move into it, or back onto the page.
new MutationObserver(() => sync()).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
new MutationObserver(() => sync()).observe(document.body, { attributes: true, attributeFilter: ['data-focus-page'] })
window.addEventListener('resize', () => sync())
sheet.addEventListener('change', () => sync())

// Where a note appears that has no place of its own yet: above the button at the lower right; each further one a
// step up and to the left. On a card page it must not lie on what one answers with (the options, the ways out,
// the field): the nearest free place to that corner is taken, which is over the question's text or beside the card.
function spot() {
  const n = memos().filter(m => m.place === 'float' && (m.x || m.y)).length
  const at = { x: window.innerWidth - W - 16 - (n % 6) * 22, y: Math.max(64, window.innerHeight - 330 - (n % 6) * 22) }
  if (!document.body.hasAttribute('data-focus-page')) return at
  const H = 210, vw = window.innerWidth, vh = window.innerHeight
  const keep = [...document.querySelectorAll('.focus-opt, .focus-way, .focus-ask-field, .memo:not([hidden])')].map(node => node.getBoundingClientRect())
    .filter(r => r.width && r.height && r.right > 0 && r.left < vw && r.bottom > 0 && r.top < vh)
  const free = (x, y) => !keep.some(r => r.left < x + W + 8 && r.right > x - 8 && r.top < y + H + 8 && r.bottom > y - 8)
  for (let y = Math.min(at.y, vh - H - 16); y >= 56; y -= 24) for (let x = vw - W - 16; x >= 8; x -= 24) if (free(x, y)) return { x, y }
  return at
}
/** Make a note (or go to the empty one that floats already) and put the keyboard into it. */
function write() {
  const empty = memos().find(n => n.place === 'float' && !n.text.trim() && !n.files.length && views.has(n.id))
  if (empty) { setSheet(empty.id); sync(); hush(); views.get(empty.id).node.hidden = false; front(empty.id); views.get(empty.id).field.focus({ preventScroll: true }); return }
  newMemo({ place: 'float', ...spot() })
}
opener.addEventListener('click', write)
// A phone: a tap beside the sheet puts the note away (on the stack; nothing lies over the page meanwhile).
document.addEventListener('pointerdown', e => {
  if (!sheet.matches || e.target.closest?.('.memo, .memo-open, .quick-note')) return
  const v = views.get(sheetMemo())
  if (v && !v.node.hidden && !v.node.classList.contains('is-paper')) v.putAway()
})
// Esc puts the note the keyboard is in away; what was written stays on it.
// (Heard at the window, before the table of keys takes Esc to leave the field; a running dictation keeps its Esc.)
window.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || isDictating() || document.querySelector('dialog[open]')) return
  const v = [...views.values()].find(o => o.node.contains(e.target))
  if (!v) return
  e.preventDefault()
  e.stopPropagation()
  v.putAway()
}, true)
// "/" from anywhere: a note, the keyboard in its field.
window.addEventListener('keydown', e => {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return
  if (e.target.closest?.('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]')) return
  e.preventDefault()
  write()
})

subscribe(paintSessions)
paintSessions(getState())
sync()
// The Desk's paper is laid a moment after the page (js/padlink.js): the notes that lie on it follow.
setTimeout(sync, 400)
setTimeout(sync, 1500)

/** A note with the keyboard in its field (for the table of keys). */
export function focusQuickSend() { write() }
