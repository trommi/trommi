// The memo: a small yellow sticky note to a session (first decided as "quick send", card Nr. 134).
// A note lives from the moment it is made until it is torn off and sent, or thrown away (js/memos.js keeps
// the notes; several can exist at once). The yellow round button (bottom right; small at the top right in a
// session) and the key "/" make one, or go to the empty one that already floats.
//
// A note floats over whatever page is shown and stays there while one goes elsewhere and after a reload. It is
// carried by the strip at its top; dropped on the Desk's bare paper it lies on the paper and scrolls with it
// (js/padlink.js gives the layer and the paper's pixels: paperLayer(), paperPoint()). It is only yellow paper:
// ruled lines that grow with the words, and at its foot the paperclip, the microphone (speech.js), the bin, and
// at the end of the dashed tear line the crown. The crown sends: a memo goes to the crowned session of the desk
// (Enter; Shift+Enter makes a new line). There is no choice of receiver. Sent, the note tears off and a quiet
// line says to whom. Esc puts a note away: the yellow button then holds it (it shows how many it holds, and a click
// on it lists them: one click takes a note out again, on every page; an empty note is simply gone). The bin throws it away; the quiet line offers the way back.
// On a phone a note is a sheet at the bottom of the page, one at a time, not carried about; a tap beside it
// puts it away.
// It is not the Scratchpad: that one stays with the human, this one goes to a session.

import { subscribe, getState, sendMessage } from './store.js'
import { el, sketch, crown } from './ui.js'
import { crowned } from './agents.js'
import { dictationMic, isDictating } from './speech.js'
import { pasteChip } from './cardclip.js'
import { link, sessionPath } from './link.js'
import { paperPoint, paperLayer } from './padlink.js'
import { memos, memo, onMemos, newMemo, saveMemo, removeMemo, restoreMemo, memosOnHub, settleMemo, sendMemo, sheetMemo, setSheet, onStack, memosAway, openMemo } from './memos.js'

const bar = document.querySelector('.topbar')
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const sheet = matchMedia('(max-width: 860px)')   // a phone: the note is a sheet at the bottom
const W = 340   // a note's width on a wide screen (css/quicksend.css)

const svg = html => { const t = document.createElement('template'); t.innerHTML = html; return t.content.firstChild }
// The button's mark: a yellow sticky note with a folded corner and two lines, in the board's pen.
const stickyNote = () => svg('<svg class="memo-sticky" viewBox="0 0 24 24" aria-hidden="true"><path class="sticky-paper" d="M4.3 4.2 Q12 3.5 19.8 3.9 Q20.3 9.4 20 14.7 L14.8 20.2 Q9.3 20.4 4.1 19.9 Q3.8 12 4.3 4.2 Z"/><path class="sticky-fold" d="M20 14.7 Q17.4 14.5 15.3 14.9 Q14.7 17.4 14.8 20.2"/><path class="sticky-line" d="M7.6 8.6 Q12 8.1 16.3 8.4"/><path class="sticky-line" d="M7.7 12.1 Q10.6 11.7 13.4 12"/></svg>')
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

// ---- who receives: the crown of the desk ----
// A memo goes to the crowned session of the desk in view (agents.js crowned(): the one the human gave the crown;
// the hub keeps it to one per desk, card Nr. 172), from wherever it is sent. Nothing else is a receiver, so the
// note has one send button, the crown. With no crown on the desk it is hollow and leads to the Agents page, where
// the crown is given with one click.
let receiver = null
function paintSessions(state) {
  const to = state.all.agents.find(a => !a.other_desk && !a.archived && crowned(a)) ?? null
  const sig = JSON.stringify(to && [to.id, to.name])
  if (sig === paintSessions.sig) return
  paintSessions.sig = sig
  receiver = to
  if (receiver) opener.dataset.to = receiver.id
  else delete opener.dataset.to
  opener.title = receiver ? `Memo to ${receiver.name} ( / )` : 'Memo: a note to the crowned session ( / )'
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

  // The head is the strip the note sticks by: nothing stands on it; the note is carried by it.
  const head = el('header', 'memo-head')
  const bin = button('memo-tool memo-bin', sketch('bin'))
  bin.title = 'Throw the note away'
  bin.setAttribute('aria-label', 'Throw the note away')

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
  // Tear off and send: the crown at the end of the dashed line the note tears along (painted by paintTo()).
  const sends = el('span', 'memo-sends')
  const tear = el('i', 'memo-tear')
  tear.setAttribute('aria-hidden', 'true')
  // A hub that keeps no notes yet: said quietly, the note lives in this browser then.
  const local = el('small', 'memo-local', 'this browser only')
  local.title = 'The hub does not keep notes yet (it has to be restarted): this note is kept in this browser.'
  const foot = el('footer', 'memo-foot')
  foot.append(clip, mic, bin, local, tear, sends)
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
    for (const b of sends.querySelectorAll('.memo-send:not(.is-none)')) b.disabled = !holds()
  }
  function paintTo() {
    const one = receiver
    const b = button(`quick-send memo-send${one ? '' : ' is-none'}`, crown())
    b.title = one ? `Send to ${one.name} (Enter)` : 'No crown on this desk yet: give a session the crown'
    b.setAttribute('aria-label', b.title)
    b.setAttribute('aria-keyshortcuts', 'Enter')
    b.addEventListener('click', () => (receiver ? sendTo(receiver) : toCrowns()))
    sends.replaceChildren(b)
    form.setAttribute('aria-label', one ? `Memo to ${one.name}` : 'Memo')
    field.setAttribute('aria-label', one ? `Your memo to ${one.name}` : 'Your memo')
    fit()
  }
  /** No crown on this desk: to the Agents page, where every line has the crown to give (agents.js crownToggle);
   *  they show for a moment (ledger.css [data-crown-hint]) and the first has the keys. The note stays as it is. */
  function toCrowns() {
    say('No crown on this desk yet. Click the crown of a session on the Agents page: the memo goes there.')
    document.getElementById('nav-roster')?.click()
    document.body.dataset.crownHint = ''
    setTimeout(() => { delete document.body.dataset.crownHint }, 8000)
    setTimeout(() => document.querySelector('.ledger-face .crown-toggle')?.focus({ preventScroll: true }), 150)
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

  /** Put the note away: the memo button holds it; an empty one is gone. */
  function putAway() {
    if (node.dataset.state === 'sending') return
    const had = node.contains(document.activeElement)
    if (!holds()) removeMemo(id)
    else {
      saveMemo(id, { place: 'stack' })
      const show = button('quick-go', 'Show')
      show.addEventListener('click', () => { hush(); openList() })
      say('Note put away: the memo button holds it.', show)
    }
    if (had) opener.focus({ preventScroll: true })
  }
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
  // Enter: to the crown of the desk.
  form.addEventListener('submit', e => {
    e.preventDefault()
    if (!receiver) return toCrowns()
    sendTo(receiver)
  })
  async function sendTo(target) {
    if (form.hasAttribute('aria-busy')) return
    if (!holds()) return field.focus()
    form.setAttribute('aria-busy', 'true')
    v.sending = true   // (the page leaves the note alone until it has flown off)
    try {
      const cards = clipped.ids()
      if (!cards && await settleMemo(id)) {
        // The hub holds the note: it sends it as it stands, to the crown (said to it now, whatever the note named before), and forgets it.
        saveMemo(id, { to: target.id }, { quiet: true })
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
  }

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
  const away = all.filter(onStack).length
  opener.toggleAttribute('data-draft', away > 0)
  // How many notes it holds: the small number on the button.
  if (away) opener.dataset.count = String(away)
  else delete opener.dataset.count
  if (away) paintList()
  else closeList()
  // A phone's sheet lies over the page behind a veil; the page knows (css/quicksend.css).
  document.body.toggleAttribute('data-memo-open', sheet.matches && [...views.values()].some(v => !v.node.hidden && !v.node.classList.contains('is-paper')))
}
function sync(why = {}) {
  const all = memos()
  for (const [id, v] of views) if (!v.sending && !all.some(n => n.id === id && n.place !== 'stack')) { v.node.remove(); views.delete(id) }
  // A phone shows one sheet, and only a note he opened on this page (never one by itself on load): the others
  // wait with the memo button (js/memos.js onStack; its list) until he taps them.
  if (why.focus && why.id) setSheet(why.id)
  const top = sheet.matches ? all.find(n => n.place === 'float' && n.id === sheetMemo()) ?? null : null
  for (const n of all) {
    if (n.place === 'stack') continue
    // Taken out again (or made elsewhere without a place): it gets one.
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
// ---- the notes that were put away: the button holds them ----
// With none put away the button makes a note at once. With some, a click opens a small list above (or below) it:
// "New note" first, then every note that was put away, the newest first; a click on one takes it out again.
const list = el('div', 'memo-list')
list.setAttribute('role', 'menu')
list.setAttribute('aria-label', 'Memos that were put away')
list.hidden = true
function paintList() {
  if (list.hidden) return
  const fresh = button('memo-list-new', sketch('pen'), el('span', null, 'New note'))
  fresh.setAttribute('role', 'menuitem')
  fresh.addEventListener('click', () => { closeList(); write() })
  list.replaceChildren(fresh, ...memosAway().map(n => {
    const words = n.text.trim().replace(/\s+/g, ' ')
    const item = button('memo-list-note', el('strong', null, words || (n.files.length ? `${n.files.length} attached` : 'Empty note')), ...(words && n.files.length ? [el('small', null, `${n.files.length} attached`)] : []))
    item.setAttribute('role', 'menuitem')
    item.dataset.memo = n.id
    item.title = 'Take the note out again'
    item.addEventListener('click', () => { closeList(); openMemo(n.id) })
    return item
  }))
}
function openList() {
  if (!memosAway().length) return
  const host = floor()
  if (list.parentNode !== host) host.append(list)
  const r = opener.getBoundingClientRect(), up = r.top > window.innerHeight / 2
  Object.assign(list.style, { right: `${Math.max(8, window.innerWidth - r.right)}px`, top: up ? '' : `${r.bottom + 8}px`, bottom: up ? `${window.innerHeight - r.top + 8}px` : '' })
  list.hidden = false
  opener.dataset.list = ''
  paintList()
  list.firstElementChild?.focus({ preventScroll: true })
}
function closeList() {
  if (list.hidden) return false
  const had = list.contains(document.activeElement)
  list.hidden = true
  delete opener.dataset.list
  if (had) opener.focus({ preventScroll: true })
  return true
}
opener.addEventListener('click', () => { if (closeList()) return; if (memosAway().length) openList(); else write() })
document.addEventListener('pointerdown', e => { if (!list.hidden && !e.target.closest?.('.memo-list, .memo-open')) closeList() })
list.addEventListener('keydown', e => {
  const items = [...list.children], at = items.indexOf(document.activeElement)
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus() }
})
window.addEventListener('keydown', e => { if (e.key === 'Escape' && closeList()) { e.preventDefault(); e.stopPropagation() } }, true)
// A phone: a tap beside the sheet puts the note away (the memo button holds it; nothing lies over the page meanwhile).
document.addEventListener('pointerdown', e => {
  if (!sheet.matches || e.target.closest?.('.memo, .memo-open, .quick-note, .memo-list')) return
  const v = views.get(sheetMemo())
  if (!v || v.node.hidden || v.node.classList.contains('is-paper')) return
  v.putAway()
  // That tap only put the note away: it does not also press what lay beside the sheet.
  const swallow = ev => { ev.stopPropagation(); ev.preventDefault() }
  window.addEventListener('click', swallow, { capture: true, once: true })
  setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 600)
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
