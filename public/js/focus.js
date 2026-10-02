// Fokus-Modus: a full-page overlay for working through every open decision
// card one after another. One big card, big answer buttons; a tap decides and
// the next card comes in.
//
// Every open card keeps one DOM node for as long as it is open and the overlay
// is up. Cards that are not in front stay laid out but invisible, so a state
// push that does not change a card never touches its node: a typed note, the
// scroll position, and a running video survive both pushes and navigation.

import { subscribe, decide, reopen, isLoaded, getState } from './store.js'
import { readCard, stopReading } from './speech.js'
import { el, rich, agoNode, URGENCY_LABEL, kindOf, mediaNodes } from './ui.js'

const RANK = { low: 0, normal: 1, high: 2, critical: 3 }
const LOCAL_DECIDED_TTL = 20000  // hide a card decided here until the server confirms, at most this long
const UNDO_MS = 10000
const INFO_MS = 6000
const MAX_DOTS = 7
const OUT_MS = 420

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const wait = ms => new Promise(r => setTimeout(r, ms))

const SVG_NS = 'http://www.w3.org/2000/svg'
const ICON = {
  left: 'M19 12H5M11 6l-6 6 6 6',
  right: 'M5 12h14M13 6l6 6-6 6',
  chevLeft: 'M15 5l-7 7 7 7',
  chevRight: 'M9 5l7 7-7 7',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  up: 'M12 19V5M5.5 11.5L12 5l6.5 6.5',
  close: 'M6 6l12 12M18 6L6 18',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
  zoom: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4M11 8v6M8 11h6',
  undo: 'M4 9h10a5 5 0 0 1 0 10H9M4 9l4-4M4 9l4 4',
  agent: 'M12 3v3M7 6h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3zM9 11v2M15 11v2',
  shield: 'M12 3l7 3v5c0 4.500-3 8.200-7 10-4-1.800-7-5.500-7-10V6z',
}
function icon(name, cls = 'focus-icon') {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('class', cls)
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', ICON[name])
  svg.append(path)
  return svg
}
function button(cls, label) {
  const b = el('button', cls)
  b.type = 'button'
  if (label) b.setAttribute('aria-label', label)
  return b
}

/** Permission bodies are "description\n\n{json tool input}". */
function parsePermission(body) {
  const text = String(body ?? '')
  let desc = text.trim(), raw = ''
  const at = text.search(/(^|\n\s*\n)\s*[{[]/)
  if (at >= 0) { desc = text.slice(0, at).trim(); raw = text.slice(at).trim() }
  let rows = null
  try {
    const value = JSON.parse(raw)
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      rows = Object.entries(value).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v, null, 2)])
    }
  } catch {}
  return { desc, raw, rows }
}

export function mountFocus() {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)')
  const still = () => reduced.matches

  // ── skeleton ────────────────────────────────────────────────────────────
  const root = el('div', 'focus')
  root.hidden = true

  const backdrop = el('div', 'focus-backdrop')

  const sheet = el('section', 'focus-sheet')
  sheet.setAttribute('role', 'dialog')
  sheet.setAttribute('aria-modal', 'true')
  sheet.setAttribute('aria-label', 'Fokus-Modus: offene Entscheidungen')
  sheet.tabIndex = -1
  sheet.dataset.state = 'loading'

  const top = el('header', 'focus-top')
  const brand = el('div', 'focus-brand')
  const brandCount = el('span', 'focus-brand-count')
  brand.append(el('span', 'focus-brand-name', 'Fokus'), brandCount)
  const notes = el('div', 'focus-notes')
  const hintBtn = button('focus-hint')
  hintBtn.hidden = true
  const undoBtn = button('focus-undo')
  undoBtn.hidden = true
  const infoNode = el('p', 'focus-info')
  infoNode.hidden = true
  notes.append(hintBtn, undoBtn, infoNode)
  const closeBtn = button('focus-close', 'Fokus-Modus schließen')
  closeBtn.append(icon('close'))
  // Read each card aloud as it comes up; the choice is remembered.
  const sayBtn = button('focus-say', 'Karten vorlesen')
  sayBtn.append(el('i'), el('i'), el('i'))
  let autoRead = false
  try { autoRead = localStorage.getItem('trommi-focus-read') === '1' } catch {}
  let spoken = null
  const paintSay = () => {
    sayBtn.hidden = !getState().speech
    sayBtn.setAttribute('aria-pressed', String(autoRead))
  }
  function voice() {
    paintSay()
    if (!autoRead || !isOpen || !getState().speech) return
    if (!current) return stopReading()
    if (current === spoken) return
    spoken = current
    readCard(current, sayBtn)
  }
  sayBtn.addEventListener('click', () => {
    autoRead = !autoRead
    try { localStorage.setItem('trommi-focus-read', autoRead ? '1' : '0') } catch {}
    spoken = null
    if (autoRead) voice()
    else { stopReading(); paintSay() }
  })
  top.append(brand, notes, sayBtn, closeBtn)

  const stage = el('div', 'focus-stage')

  const done = el('div', 'focus-done')
  const doneArt = el('div', 'focus-done-art')
  doneArt.append(el('i'), el('i'), icon('check'))
  const doneText = el('p', 'focus-done-text')
  const doneBtn = button('focus-done-btn')
  doneBtn.textContent = 'Schließen'
  done.append(doneArt, el('h2', 'focus-done-title', 'Alles entschieden'), doneText, doneBtn)

  const loading = el('div', 'focus-loading')
  loading.append(el('span', 'focus-spinner'), el('span', null, 'Entscheidungen werden geladen'))

  const foot = el('footer', 'focus-foot')
  const prevBtn = button('focus-nav focus-nav-prev')
  prevBtn.setAttribute('aria-label', 'Vorherige Karte')
  prevBtn.append(icon('left'))
  const nextBtn = button('focus-nav focus-nav-next')
  nextBtn.setAttribute('aria-label', 'Nächste Karte')
  nextBtn.append(icon('right'))
  const progress = el('div', 'focus-progress')
  const dots = el('div', 'focus-dots')
  dots.setAttribute('aria-hidden', 'true')
  const pos = el('span', 'focus-pos')
  progress.append(dots, pos)
  // Only the position stays in the foot; the arrows stand at the sides of the sheet.
  foot.append(progress)

  const live = el('div', 'focus-sr')
  live.setAttribute('aria-live', 'polite')
  live.setAttribute('role', 'status')

  sheet.append(top, stage, done, loading, foot, live, prevBtn, nextBtn)
  root.append(backdrop, sheet)
  document.body.append(root)

  // ── model ───────────────────────────────────────────────────────────────
  const recs = new Map()          // id -> rec, for open cards
  const decidedLocal = new Map()  // id -> time we decided it here
  let lastState = null
  let isOpen = false
  let order = []
  let current = null
  let shown = null                // the rec whose node is in front
  let started = false             // cards present at open are not news
  let hintId = null
  let pendingJump = null
  let opener = null
  let inerted = []
  let zoom = null
  let drag = null
  let decidedCount = 0
  let closeTimer = 0
  let undoTimer = 0
  let infoTimer = 0
  let dotSig = ''
  let sentId = null              // the card whose answer just went through here

  const announce = text => { live.textContent = ''; requestAnimationFrame(() => { live.textContent = text }) }
  const describe = rec =>
    `Karte ${order.indexOf(rec.id) + 1} von ${order.length}: Nr. ${rec.card.number}, ${URGENCY_LABEL[rec.card.urgency] ?? ''}. ${rec.card.title}`
  const busyRec = () => { for (const rec of recs.values()) if (rec.busy) return rec; return null }

  // ── card nodes ──────────────────────────────────────────────────────────
  function createRec(card) {
    const node = el('article', 'focus-card')
    node.dataset.id = card.id
    node.tabIndex = -1
    node.inert = true
    return { id: card.id, card, node, sigC: '', sigU: '', note: '', busy: false, outTimer: 0, optButtons: [], imageAt: 0 }
  }

  function fill(rec) {
    const { card, node } = rec
    const active = document.activeElement
    const hadFocus = node.contains(active)
    const noteSel = hadFocus && active === rec.noteNode ? [active.selectionStart, active.selectionEnd] : null
    const scrollTop = rec.scroll?.scrollTop ?? 0
    const permission = card.kind === 'permission'
    const attachments = card.attachments ?? []
    node.dataset.kind = permission ? 'permission' : 'decision'
    const titleId = `focus-title-${card.id}`
    node.setAttribute('aria-labelledby', titleId)

    // meta line: id chip coloured by urgency, the asking agent, kind and age
    const meta = el('header', 'focus-meta')
    const chip = el('span', 'focus-chip')
    // One tab says who is asking and how urgent it is; that it is a decision goes without saying.
    const nr = el('span', 'focus-chip-nr')
    if (card.agent_name) nr.append(card.agent_name)
    else nr.append(el('small', null, 'Nr.'), ` ${card.number}`)
    rec.urgNode = el('span', 'focus-chip-urg')
    chip.append(nr, rec.urgNode)
    meta.append(chip)
    const kind = el('span', 'focus-kind')
    if (permission) kind.append('Freigabe', el('i', null, '·'))
    kind.append(agoNode(card.created, 'focus-ago'))
    meta.append(kind)

    const scroll = el('div', 'focus-scroll')
    rec.scroll = scroll
    const title = el('h2', 'focus-title', card.title)
    title.id = titleId
    rec.reasonNode = el('p', 'focus-reason')
    const lead = el('div', 'focus-lead')
    lead.append(title, rec.reasonNode)

    // left column: what is being decided about
    const images = attachments.filter(a => kindOf(a) === 'image')
    const files = attachments.filter(a => kindOf(a) === 'file')
    const players = mediaNodes(attachments)
    const media = el('div', 'focus-media')
    if (images.length) {
      rec.imageAt = clamp(rec.imageAt, 0, images.length - 1)
      const figure = button('focus-figure')
      const img = el('img')
      img.alt = ''
      img.draggable = false
      const badge = el('span', 'focus-figure-zoom')
      badge.append(icon('zoom'))
      const caption = el('span', 'focus-figure-name')
      figure.append(img, badge)
      const thumbs = []
      const pick = i => {
        rec.imageAt = i
        img.src = images[i].url
        caption.textContent = images.length > 1 ? `${i + 1} / ${images.length} · ${images[i].name}` : images[i].name
        figure.setAttribute('aria-label', `Bild ${i + 1} von ${images.length} vergrößern: ${images[i].name}`)
        thumbs.forEach((t, k) => t.setAttribute('aria-pressed', String(k === i)))
      }
      figure.addEventListener('click', () => openZoom(images, rec.imageAt, figure, pick))
      media.append(figure)
      if (images.length > 1) {
        const strip = el('div', 'focus-thumbs')
        images.forEach((a, i) => {
          const t = button('focus-thumb', `Bild ${i + 1} zeigen: ${a.name}`)
          const ti = el('img')
          ti.src = a.url
          ti.alt = ''
          ti.loading = 'lazy'
          ti.draggable = false
          t.append(ti)
          t.addEventListener('click', () => pick(i))
          thumbs.push(t)
          strip.append(t)
        })
        strip.append(caption)
        media.append(strip)
      } else {
        media.append(caption)
      }
      pick(rec.imageAt)
    }
    media.append(...players)
    const hasMedia = images.length > 0 || players.length > 0

    // right column: the explanation
    const text = el('div', 'focus-text')
    if (permission) {
      const { desc, raw, rows } = parsePermission(card.body)
      const box = el('div', 'focus-perm')
      if (desc) box.append(el('p', 'focus-perm-desc', desc))
      if (raw) {
        const tool = card.title.replace(/^[^:]{0,24}:\s*/, '')
        const cap = el('div', 'focus-perm-cap')
        cap.append(icon('shield'), el('span', null, tool || 'Werkzeug'), el('span', null, 'Eingabe'))
        box.append(cap)
        if (rows) {
          const dl = el('dl', 'focus-perm-rows')
          for (const [k, v] of rows) dl.append(el('dt', null, k), el('dd', null, v))
          box.append(dl)
        } else {
          box.append(el('pre', 'focus-perm-raw', raw))
        }
      }
      if (desc || raw) text.append(box)
    } else if (card.body) {
      text.append(rich(card.body))
    }
    if (files.length) {
      const list = el('div', 'focus-files')
      for (const a of files) {
        const link = el('a', 'focus-file')
        link.href = a.url
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        link.append(icon('file'), el('span', null, a.name))
        list.append(link)
      }
      text.append(list)
    }
    const hasText = text.childNodes.length > 0

    const body = el('div', 'focus-body')
    body.dataset.layout = hasMedia && hasText ? 'split' : hasMedia ? 'media' : 'text'
    if (hasMedia) body.append(media)
    if (hasText) body.append(text)
    scroll.append(lead)
    if (hasMedia || hasText) scroll.append(body)

    // answer: one tap decides
    const answer = el('div', 'focus-answer')
    rec.answer = answer
    rec.errorNode = el('p', 'focus-error')
    rec.errorNode.setAttribute('role', 'alert')
    rec.errorNode.hidden = true
    rec.optButtons = []
    rec.noteNode = null

    const opts = el('div', 'focus-opts')
    opts.setAttribute('role', 'group')
    opts.setAttribute('aria-label', permission ? 'Freigabe erteilen oder ablehnen' : 'Antwort wählen, ein Tipp entscheidet')
    const tile = (o, cls, label) => {
      const b = button(`focus-opt ${cls}`)
      b.dataset.key = o.key
      const words = el('span', 'focus-opt-words')
      words.append(el('span', 'focus-opt-label', label))
      if (o.detail) words.append(el('span', 'focus-opt-detail', o.detail))
      const mark = el('span', 'focus-opt-mark')
      mark.setAttribute('aria-hidden', 'true')
      mark.append(el('kbd', null, String(rec.optButtons.length + 1)), el('span', 'focus-spinner'), icon('check'))
      b.append(words, mark)
      b.addEventListener('click', () => submit(rec, o.key))
      rec.optButtons.push(b)
      opts.append(b)
    }
    if (permission) {
      opts.classList.add('focus-verdict')
      const allow = card.options.find(o => o.key === 'allow')
      const deny = card.options.find(o => o.key === 'deny')
      if (deny) tile(deny, 'focus-deny', 'Ablehnen')
      for (const o of card.options) if (o !== allow && o !== deny) tile(o, '', o.label)
      if (allow) tile(allow, 'focus-allow', 'Erlauben')
      answer.append(rec.errorNode, opts)
    } else {
      card.options.forEach(o => tile(o, '', o.label))
      opts.dataset.count = String(clamp(card.options.length, 1, 6))
      const note = el('input', 'focus-note')
      note.type = 'text'
      note.placeholder = 'Anmerkung dazu?'
      note.autocomplete = 'off'
      note.enterKeyHint = 'done'
      note.setAttribute('aria-label', 'Anmerkung für den Agenten, optional. Wird mit dem nächsten Tipp gesendet.')
      note.value = rec.note
      note.addEventListener('input', () => { rec.note = note.value })
      note.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); note.blur(); node.focus({ preventScroll: true }) } })
      rec.noteNode = note
      answer.append(rec.errorNode, note, opts)
    }

    node.replaceChildren(meta, scroll, answer)
    paintUrgency(rec)
    scroll.scrollTop = scrollTop
    if (noteSel && rec.noteNode) {
      rec.noteNode.focus({ preventScroll: true })
      try { rec.noteNode.setSelectionRange(noteSel[0], noteSel[1]) } catch {}
    } else if (hadFocus) {
      node.focus({ preventScroll: true })
    }
  }

  function paintUrgency(rec) {
    const { card, node } = rec
    node.dataset.urgency = RANK[card.urgency] != null ? card.urgency : 'normal'
    rec.urgNode.replaceChildren(el('i', 'focus-dot'), URGENCY_LABEL[card.urgency] ?? card.urgency)
    rec.reasonNode.textContent = card.urgency_reason || ''
    rec.reasonNode.hidden = !card.urgency_reason
  }

  function setError(rec, text) {
    rec.errorNode.textContent = text
    rec.errorNode.hidden = !text
  }

  // ── deciding ────────────────────────────────────────────────────────────
  async function submit(rec, key) {
    if (rec.busy || busyRec() || rec !== shown || !recs.has(rec.id)) return
    const option = rec.card.options.find(o => o.key === key)
    const btn = rec.optButtons.find(b => b.dataset.key === key)
    if (!option || !btn) return
    const note = rec.noteNode ? rec.note.trim() : ''
    rec.busy = true
    setError(rec, '')
    rec.node.dataset.busy = ''
    btn.dataset.state = 'pending'
    for (const b of rec.optButtons) b.disabled = b !== btn
    btn.setAttribute('aria-disabled', 'true')
    if (rec.noteNode) rec.noteNode.disabled = true
    paintChrome()
    try {
      await decide(rec.id, key, note)
    } catch (err) {
      rec.busy = false
      delete rec.node.dataset.busy
      delete btn.dataset.state
      btn.removeAttribute('aria-disabled')
      for (const b of rec.optButtons) b.disabled = false
      if (rec.noteNode) rec.noteNode.disabled = false
      const reason = err?.message || 'Der Server hat nicht geantwortet.'
      setError(rec, `Nicht übernommen: ${reason}`)
      announce(`Entscheidung nicht übernommen: ${reason}`)
      if (!still()) {
        rec.answer.removeAttribute('data-shake')
        void rec.answer.offsetWidth
        rec.answer.setAttribute('data-shake', '')
      }
      sync()
      return
    }
    btn.dataset.state = 'done'
    rec.note = ''
    if (rec.noteNode) rec.noteNode.value = ''
    if (!still()) await wait(300)
    rec.busy = false
    decidedLocal.set(rec.id, Date.now())
    sentId = rec.id
    decidedCount++
    if (rec.card.kind !== 'permission') offerUndo(rec.card, option)
    else hideUndo()
    sync('sent')
  }

  // ── undo, info, hint: the notes in the top bar ──────────────────────────
  function hideUndo() {
    clearTimeout(undoTimer)
    undoBtn.hidden = true
    undoBtn.onclick = null
  }

  function offerUndo(card, option) {
    hideUndo()
    const text = el('span', 'focus-undo-text')
    text.append(`Nr. ${card.number}: `, el('b', null, option?.label ?? ''))
    const cta = el('span', 'focus-undo-cta')
    cta.append(icon('undo'), 'Rückgängig')
    undoBtn.replaceChildren(text, cta, el('i', 'focus-undo-time'))
    undoBtn.setAttribute('aria-label', `Entscheidung zu Nr. ${card.number} rückgängig machen`)
    undoBtn.disabled = false
    undoBtn.hidden = false
    undoBtn.onclick = async () => {
      clearTimeout(undoTimer)
      undoBtn.disabled = true
      try {
        await reopen(card.id)
      } catch (err) {
        hideUndo()
        info(`Nicht zurückgenommen: ${err?.message || 'Der Server hat nicht geantwortet.'}`, true)
        return
      }
      hideUndo()
      decidedLocal.delete(card.id)
      decidedCount = Math.max(0, decidedCount - 1)
      pendingJump = card.id
      setTimeout(() => { if (pendingJump === card.id) pendingJump = null }, 5000)
      sync()
      announce(`Entscheidung zu Nr. ${card.number} zurückgenommen`)
    }
    undoTimer = setTimeout(hideUndo, UNDO_MS)
  }

  function info(text, bad = false) {
    clearTimeout(infoTimer)
    infoNode.textContent = text
    infoNode.toggleAttribute('data-bad', bad)
    infoNode.hidden = false
    announce(text)
    infoTimer = setTimeout(() => { infoNode.hidden = true }, INFO_MS)
  }

  function paintHint() {
    const rec = hintId && recs.get(hintId)
    if (!rec || hintId === current || order.indexOf(hintId) > order.indexOf(current)) {
      hintId = null
      hintBtn.hidden = true
      return
    }
    const sig = `${rec.id}|${rec.card.urgency}|${rec.card.title}`
    if (hintBtn.dataset.sig === sig && !hintBtn.hidden) return
    const wasHidden = hintBtn.hidden
    hintBtn.dataset.sig = sig
    hintBtn.dataset.urgency = rec.card.urgency
    const mark = el('span', 'focus-hint-mark')
    mark.append(icon('up'))
    const text = el('span', 'focus-hint-text')
    text.append(el('b', null, 'Dringender: '), `Nr. ${rec.card.number} · ${rec.card.title}`)
    hintBtn.replaceChildren(mark, text)
    hintBtn.hidden = false
    if (wasHidden) announce(`Dringender: Nr. ${rec.card.number}, ${rec.card.title}. Deine aktuelle Karte bleibt vorn.`)
  }

  // ── state → cards ───────────────────────────────────────────────────────
  function sync(motion) {
    const state = lastState
    if (!isOpen || !state) return
    const byId = new Map(state.cards.map(c => [c.id, c]))
    const now = Date.now()
    for (const [id, at] of decidedLocal) {
      if (byId.get(id)?.status !== 'open' || now - at > LOCAL_DECIDED_TTL) decidedLocal.delete(id)
    }
    const prevOrder = order
    const prevIndex = prevOrder.indexOf(current)
    const next = [...new Set(state.queue)].filter(id => byId.get(id)?.status === 'open' && !decidedLocal.has(id))
    // a card whose answer is still travelling stays put until the request settles
    const busy = busyRec()
    if (busy && !next.includes(busy.id)) next.splice(clamp(prevOrder.indexOf(busy.id), 0, next.length), 0, busy.id)
    order = next

    let lost = null
    for (const [id, rec] of recs) {
      if (order.includes(id)) continue
      recs.delete(id)
      if (rec === shown) { if (id !== sentId && !decidedLocal.has(id)) lost = { rec, card: byId.get(id) } }
      else { clearTimeout(rec.outTimer); rec.node.remove() }
    }

    sentId = null

    const promoted = []
    for (const id of order) {
      let rec = recs.get(id)
      const card = byId.get(id) ?? rec.card
      const sigC = JSON.stringify([card.kind, card.number, card.title, card.body, card.options, card.attachments, card.created, card.agent_name ?? ''])
      const sigU = `${card.urgency}|${card.urgency_reason ?? ''}`
      if (!rec) {
        rec = createRec(card)
        recs.set(id, rec)
        stage.append(rec.node)
        if (started) promoted.push(rec)
      } else if ((RANK[card.urgency] ?? 1) > (RANK[rec.card.urgency] ?? 1)) {
        promoted.push(rec)
      }
      rec.card = card
      if (rec.sigC !== sigC) { rec.sigC = sigC; rec.sigU = sigU; fill(rec) }
      else if (rec.sigU !== sigU) { rec.sigU = sigU; paintUrgency(rec) }
    }

    const before = current
    if (pendingJump && order.includes(pendingJump)) {
      current = pendingJump
      pendingJump = null
      motion ??= 'prev'
    } else if (!order.includes(current)) {
      current = order[clamp(prevIndex, 0, order.length - 1)] ?? null
      motion ??= lost ? 'gone' : 'sent'
    }

    // something more urgent came in ahead of the card in front: offer it, never swap
    const at = order.indexOf(current)
    const ahead = promoted.filter(rec => rec.id !== current && order.indexOf(rec.id) < at)
      .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))[0]
    if (ahead) hintId = ahead.id
    if (isLoaded()) started = true

    sheet.dataset.state = !isLoaded() ? 'loading' : order.length ? 'cards' : 'done'
    present(motion ?? 'none')
    paintChrome()
    paintHint()

    if (lost) {
      const nr = lost.rec.card.number
      info(lost.card && lost.card.status !== 'open' ? `Nr. ${nr} wurde anderswo entschieden` : `Nr. ${nr} wurde zurückgezogen`)
    }
    if (current !== before) {
      voice()
      if (current) { if (!lost) announce(describe(recs.get(current))) }
      else if (prevOrder.length) announce('Alles entschieden. Keine offenen Karten.')
    }
    rescueFocus()
  }

  /** Bring the current card's node to the front; the previous one animates out. */
  function present(motion) {
    const next = current ? recs.get(current) : null
    const prev = shown
    if (prev === next) return
    const hadFocus = !!prev && prev.node.contains(document.activeElement)
    shown = next
    if (prev) retire(prev, motion)
    if (next) {
      clearTimeout(next.outTimer)
      next.node.removeAttribute('data-out')
      next.node.inert = false
      next.node.dataset.shown = ''
      next.node.removeAttribute('data-in')
      if (!still() && motion !== 'none') {
        void next.node.offsetWidth
        next.node.dataset.in = motion
      }
      sheet.dataset.urgency = next.node.dataset.urgency
      if (hadFocus) next.node.focus({ preventScroll: true })
    }
  }

  function retire(rec, motion) {
    for (const m of rec.node.querySelectorAll('video, audio')) { try { m.pause() } catch {} }
    rec.node.inert = true
    rec.node.removeAttribute('data-in')
    delete rec.node.dataset.shown
    const finish = () => {
      if (shown === rec) return
      rec.node.removeAttribute('data-out')
      rec.node.style.removeProperty('--focus-dx')
      if (recs.get(rec.id) !== rec) rec.node.remove()
    }
    clearTimeout(rec.outTimer)
    if (still() || motion === 'none') return finish()
    rec.node.dataset.out = motion
    rec.outTimer = setTimeout(finish, OUT_MS)
  }

  function paintChrome() {
    const n = order.length
    const idx = order.indexOf(current)
    const locked = !!busyRec()
    brandCount.textContent = n ? `${n} offen` : ''
    pos.textContent = n ? `${idx + 1} von ${n}` : ''
    prevBtn.disabled = idx <= 0 || locked
    nextBtn.disabled = idx < 0 || idx >= n - 1 || locked
    doneText.textContent = decidedCount
      ? `${decidedCount === 1 ? 'Eine Entscheidung' : `${decidedCount} Entscheidungen`} in dieser Runde getroffen. Neue Karten erscheinen hier, sobald ein Agent etwas wissen will.`
      : 'Keine offenen Fragen. Neue Karten erscheinen hier, sobald ein Agent etwas wissen will.'

    // at most MAX_DOTS dots: a window around the current card, smaller at an edge that hides more
    const size = Math.min(n, MAX_DOTS)
    const from = clamp(idx - Math.floor(MAX_DOTS / 2), 0, Math.max(0, n - size))
    const sig = `${n}|${idx}|${order.slice(from, from + size).map(id => recs.get(id)?.card.urgency).join()}`
    if (sig === dotSig) return
    dotSig = sig
    dots.replaceChildren(...order.slice(from, from + size).map((id, k) => {
      const i = from + k
      const d = el('i', 'focus-dot-step')
      d.dataset.at = i < idx ? 'past' : i === idx ? 'now' : 'next'
      d.dataset.urgency = recs.get(id)?.card.urgency ?? 'normal'
      if ((k === 0 && from > 0) || (k === size - 1 && from + size < n)) d.dataset.more = ''
      return d
    }))
  }

  function go(target) {
    if (!isOpen || busyRec()) return false
    const from = order.indexOf(current)
    const id = typeof target === 'number' ? order[from + target] : target
    if (!id || id === current || !recs.has(id)) return false
    current = id
    present(order.indexOf(id) > from ? 'next' : 'prev')
    paintChrome()
    paintHint()
    announce(describe(recs.get(id)))
    voice()
    rescueFocus()
    return true
  }

  // ── focus handling ──────────────────────────────────────────────────────
  const scope = () => zoom?.box ?? sheet
  function focusables() {
    const within = scope()
    return [...within.querySelectorAll('button, [href], input, textarea, select, video[controls], audio[controls], [tabindex]:not([tabindex="-1"])')]
      .filter(n => !n.disabled && !n.closest('[inert]') && !n.closest('[hidden]') && n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden')
  }
  function rescueFocus() {
    if (!isOpen) return
    const a = document.activeElement
    if (a && a !== document.body && scope().contains(a) && !a.closest('[inert]') && !a.disabled && a.getClientRects().length) return
    const target = zoom ? zoom.closeBtn : sheet.dataset.state === 'done' ? doneBtn : shown?.node ?? sheet
    target.focus({ preventScroll: true })
  }
  function trapTab(e) {
    const list = focusables()
    e.preventDefault()
    if (!list.length) return scope().focus?.({ preventScroll: true })
    const at = list.indexOf(document.activeElement)
    const to = at < 0 ? (e.shiftKey ? list.length - 1 : 0) : (at + (e.shiftKey ? list.length - 1 : 1)) % list.length
    list[to].focus()
  }
  document.addEventListener('focusin', e => {
    if (isOpen && e.target instanceof Node && !root.contains(e.target)) rescueFocus()
  })

  // ── keyboard ────────────────────────────────────────────────────────────
  document.addEventListener('keydown', e => {
    if (!isOpen) return
    if (e.key === 'Tab') return trapTab(e)
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const handled = () => { e.preventDefault(); e.stopPropagation() }
    if (zoom) {
      if (e.key === 'Escape') { zoom.close(); handled() }
      else if (e.key === 'ArrowLeft') { zoom.step(-1); handled() }
      else if (e.key === 'ArrowRight') { zoom.step(1); handled() }
      return
    }
    const t = e.target instanceof Element ? e.target : null
    const typing = t?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
    if (e.key === 'Escape') {
      if (typing) { typing.blur(); (shown?.node ?? sheet).focus({ preventScroll: true }) }
      else close()
      return handled()
    }
    if (typing || t?.closest('video, audio')) return
    if (e.key === 'ArrowLeft') { go(-1); return handled() }
    if (e.key === 'ArrowRight') { go(1); return handled() }
    if (/^[1-9]$/.test(e.key) && !e.shiftKey && shown && !e.repeat) {
      const btn = shown.optButtons[Number(e.key) - 1]
      if (!btn) return
      handled()
      if (!shown.busy) { btn.focus({ preventScroll: true }); submit(shown, btn.dataset.key) }
    }
  }, true)

  // ── touch: swipe the card sideways to move without deciding ─────────────
  let swallowClickUntil = 0
  stage.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' || e.button || drag || zoom || !shown || busyRec()) return
    if (e.target.closest?.('input, textarea, video, audio, pre, a, .focus-thumbs')) return
    drag = { pointer: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, t0: e.timeStamp, active: false, rec: shown }
  })
  stage.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.pointer) return
    const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0
    if (!drag.active) {
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        drag.active = true
        drag.x0 = e.clientX
        drag.t0 = e.timeStamp
        try { stage.setPointerCapture(e.pointerId) } catch {}
        drag.rec.node.removeAttribute('data-settle')
        drag.rec.node.dataset.drag = ''
      } else {
        if (Math.abs(dy) > 12) drag = null
        return
      }
    }
    const raw = e.clientX - drag.x0
    const idx = order.indexOf(current)
    const open = raw < 0 ? idx < order.length - 1 : idx > 0
    drag.dx = open ? raw : raw * 0.22
    drag.rec.node.style.setProperty('--focus-dx', `${drag.dx.toFixed(1)}px`)
  })
  function endDrag(e) {
    if (!drag || e.pointerId !== drag.pointer) return
    const d = drag
    drag = null
    if (!d.active) return
    try { stage.releasePointerCapture(e.pointerId) } catch {}
    swallowClickUntil = performance.now() + 350
    const node = d.rec.node
    delete node.dataset.drag
    const speed = Math.abs(d.dx) / Math.max(1, e.timeStamp - d.t0)
    const far = Math.abs(d.dx) > 72 || (speed > 0.45 && Math.abs(d.dx) > 24)
    if (e.type !== 'pointercancel' && far && go(d.dx < 0 ? 1 : -1)) return
    node.dataset.settle = ''
    node.style.setProperty('--focus-dx', '0px')
    setTimeout(() => { node.removeAttribute('data-settle'); if (!node.hasAttribute('data-drag')) node.style.removeProperty('--focus-dx') }, 300)
  }
  stage.addEventListener('pointerup', endDrag)
  stage.addEventListener('pointercancel', endDrag)
  stage.addEventListener('click', e => {
    if (performance.now() < swallowClickUntil) { swallowClickUntil = 0; e.stopPropagation(); e.preventDefault() }
  }, true)
  stage.addEventListener('animationend', e => {
    if (e.target.classList?.contains('focus-card')) e.target.removeAttribute('data-in')
  })

  // ── image zoom, inside the sheet ────────────────────────────────────────
  function openZoom(images, start, openerNode, onChange) {
    if (zoom) return
    const box = el('div', 'focus-zoom')
    box.setAttribute('role', 'group')
    box.setAttribute('aria-label', 'Bildansicht')
    box.tabIndex = -1
    const bar = el('div', 'focus-zoom-bar')
    const count = el('span', 'focus-zoom-count')
    const name = el('span', 'focus-zoom-name')
    const shut = button('focus-zoom-btn', 'Bildansicht schließen')
    shut.append(icon('close'))
    bar.append(count, name, shut)
    const view = el('div', 'focus-zoom-view')
    const img = el('img', 'focus-zoom-img')
    img.draggable = false
    view.append(img)
    const prev = button('focus-zoom-btn focus-zoom-prev', 'Vorheriges Bild')
    prev.append(icon('chevLeft'))
    const next = button('focus-zoom-btn focus-zoom-next', 'Nächstes Bild')
    next.append(icon('chevRight'))
    prev.hidden = next.hidden = images.length < 2
    box.append(view, bar, prev, next)

    let i = start
    const show = to => {
      i = (to + images.length) % images.length
      img.src = images[i].url
      img.alt = images[i].name
      count.textContent = `${i + 1} / ${images.length}`
      count.hidden = images.length < 2
      name.textContent = images[i].name
      delete view.dataset.full
      onChange?.(i)
    }
    const closeZoom = () => {
      zoom = null
      box.remove()
      for (const n of [top, stage, foot]) n.inert = false
      openerNode?.focus?.({ preventScroll: true })
      rescueFocus()
    }
    shut.addEventListener('click', closeZoom)
    prev.addEventListener('click', () => show(i - 1))
    next.addEventListener('click', () => show(i + 1))
    // tap the picture for its real size, tap beside it to go back
    view.addEventListener('click', e => {
      if (e.target === img) view.toggleAttribute('data-full')
      else closeZoom()
    })
    for (const n of [top, stage, foot]) n.inert = true
    sheet.append(box)
    zoom = { box, closeBtn: shut, close: closeZoom, step: d => { if (images.length > 1) show(i + d) } }
    show(start)
    shut.focus({ preventScroll: true })
  }

  // ── open and close ──────────────────────────────────────────────────────
  function open(cardId) {
    if (isOpen) {
      if (cardId) go(cardId)
      return
    }
    clearTimeout(closeTimer)
    teardown()
    opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
    isOpen = true
    started = false
    decidedCount = 0
    current = cardId ?? null
    root.hidden = false
    root.removeAttribute('data-closing')
    document.documentElement.classList.add('focus-lock')
    inerted = [...document.body.children].filter(n => n !== root && !n.inert && !/^(SCRIPT|STYLE|LINK)$/.test(n.tagName))
    for (const n of inerted) n.inert = true
    sync('none')
    if (cardId && current !== cardId) { current = order[0] ?? null; present('none'); paintChrome() }
    ;(sheet.dataset.state === 'done' ? doneBtn : shown?.node ?? sheet).focus({ preventScroll: true })
    if (shown) announce(describe(shown))
    spoken = null
    voice()
    document.dispatchEvent(new CustomEvent('focus:open'))
  }

  /** Drop every card node and timer; the overlay starts fresh next time. */
  function teardown() {
    zoom?.close()
    hideUndo()
    clearTimeout(infoTimer)
    infoNode.hidden = true
    hintBtn.hidden = true
    hintId = null
    pendingJump = null
    drag = null
    for (const rec of recs.values()) clearTimeout(rec.outTimer)
    recs.clear()
    shown = null
    order = []
    current = null
    dotSig = ''
    stage.replaceChildren()
  }

  function close() {
    if (!isOpen) return
    isOpen = false
    stopReading()
    zoom?.close()
    for (const m of stage.querySelectorAll('video, audio')) { try { m.pause() } catch {} }
    for (const n of inerted) n.inert = false
    inerted = []
    document.documentElement.classList.remove('focus-lock')
    const finish = () => { root.hidden = true; root.removeAttribute('data-closing'); teardown() }
    clearTimeout(closeTimer)
    if (still()) finish()
    else { root.dataset.closing = ''; closeTimer = setTimeout(finish, 200) }
    const back = opener
    opener = null
    if (back?.isConnected) back.focus({ preventScroll: true })
    else document.activeElement?.blur?.()
    document.dispatchEvent(new CustomEvent('focus:close'))
  }

  // ── wiring ──────────────────────────────────────────────────────────────
  closeBtn.addEventListener('click', close)
  doneBtn.addEventListener('click', close)
  backdrop.addEventListener('click', close)
  prevBtn.addEventListener('click', () => go(-1))
  nextBtn.addEventListener('click', () => go(1))
  hintBtn.addEventListener('click', () => { const id = hintId; hintId = null; if (!go(id)) paintHint() })
  subscribe(state => { lastState = state; sync() })

  return { open, close, isOpen: () => isOpen }
}
