// The decision card stack.
//
// Every open card is one DOM node that lives as long as the card is open. Its
// place in the stack is a pose (x, y, scale, rotation, opacity) driven by a
// spring, so reorders, navigation, drags, and departures are all the same
// thing: a new target pose. State pushes that do not change a card never touch
// its node, which is what keeps selection, typed notes, scroll position, and
// running motion alive.
//
// The stack is a pager over the server's queue: the current card is tracked by
// id, cards before it are parked off to the left, cards after it peek out
// above it. "Später" moves a card to the back for this page load only.

import { subscribe, decide, reopen, isLoaded, scopeEpoch, getState } from './store.js'
import { readCard } from './speech.js'
import { el, rich, agoNode, URGENCY_LABEL, kindOf, mediaNodes } from './ui.js'

const RANK = { low: 0, normal: 1, high: 2, critical: 3 }
const PEEK = [0, 30, 52, 68]        // how far cards at depth 0..3 stick out above the front card
const MAX_DEPTH = 3
const SPRING = { k: 230, c: 25 }    // slightly underdamped: one small overshoot
const SPRING_SOFT = { k: 120, c: 20 }
const LOCAL_DECIDED_TTL = 20000     // hide a card we decided until the server confirms, at most this long
const FLAG_MS = 7000

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))
const lerp = (a, b, t) => a + (b - a) * t
const wait = ms => new Promise(r => setTimeout(r, ms))

const SVG_NS = 'http://www.w3.org/2000/svg'
const ICON = {
  left: 'M15 5l-7 7 7 7',
  right: 'M9 5l7 7-7 7',
  later: 'M4 7h11a5 5 0 0 1 0 10H9M4 7l4-4M4 7l4 4',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  up: 'M12 19V5M5.5 11.5L12 5l6.5 6.5',
  close: 'M6 6l12 12M18 6L6 18',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
  zoom: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4M11 8v6M8 11h6',
  shield: 'M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.800-7-5.500-7-10V6z',
}
function icon(name, cls = 'deck-icon') {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('class', cls)
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', ICON[name])
  svg.append(path)
  return svg
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

export function mountDeck(root) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)')
  const still = () => reduced.matches

  // ── skeleton ────────────────────────────────────────────────────────────
  const deck = el('div', 'deck')
  deck.dataset.empty = 'true'

  const bar = el('div', 'deck-bar')
  const nav = el('div', 'deck-nav')
  const prevBtn = el('button', 'deck-iconbtn')
  prevBtn.type = 'button'
  prevBtn.setAttribute('aria-label', 'Vorherige Karte')
  prevBtn.append(icon('left'))
  const nextBtn = el('button', 'deck-iconbtn')
  nextBtn.type = 'button'
  nextBtn.setAttribute('aria-label', 'Nächste Karte')
  nextBtn.append(icon('right'))
  const posNode = el('span', 'deck-pos')
  const posNow = el('b')
  const posAll = el('span')
  posNode.append(posNow, posAll)
  nav.append(prevBtn, posNode, nextBtn)
  const rail = el('div', 'deck-rail')
  rail.setAttribute('aria-hidden', 'true')
  const laterBtn = el('button', 'deck-later')
  laterBtn.type = 'button'
  laterBtn.title = 'Diese Karte ans Ende legen und später beantworten'
  laterBtn.append(icon('later'), el('span', null, 'Später'))
  bar.append(nav, rail, laterBtn)

  const banner = el('button', 'deck-banner')
  banner.type = 'button'
  banner.hidden = true

  const stage = el('div', 'deck-stage')
  stage.setAttribute('role', 'group')
  stage.setAttribute('aria-label', 'Offene Entscheidungen')

  const empty = el('div', 'deck-empty')
  const emptyArt = el('div', 'deck-empty-art')
  emptyArt.append(el('i'), el('i'), el('i'))
  const emptyCheck = el('span', 'deck-empty-check')
  emptyCheck.append(icon('check'))
  emptyArt.append(emptyCheck)
  empty.append(
    emptyArt,
    el('h3', 'deck-empty-title', 'Alles entschieden'),
    el('p', 'deck-empty-text', 'Keine offenen Fragen. Neue Karten vom Agenten erscheinen hier, die dringendste zuoberst.'),
  )

  const live = el('div', 'deck-sr')
  live.setAttribute('aria-live', 'polite')
  live.setAttribute('role', 'status')

  const undo = el('div', 'deck-undo')
  undo.hidden = true
  deck.append(bar, banner, stage, empty, undo, live)
  root.replaceChildren(deck)

  // ── model ───────────────────────────────────────────────────────────────
  const cards = new Map()        // id -> rec, for cards in the stack
  const leavers = new Set()      // recs animating out
  const deferred = new Map()     // id -> urgency rank when the user said "Später", in order
  const decidedLocal = new Map() // id -> time we decided it here
  let lastState = null
  let order = []
  let current = null
  let bannerId = null
  let started = false
  let lastEpoch = scopeEpoch()
  let openCount = -1
  let drag = null
  let lightbox = null
  let railSig = ''

  const engaged = rec => !!rec && (rec.busy || rec.ui.selected != null || rec.ui.note.trim() !== '')
  const announce = text => { live.textContent = ''; requestAnimationFrame(() => { live.textContent = text }) }
  const describe = (rec, i, n) =>
    `Karte ${i + 1} von ${n}: Nr. ${rec.card.number}, ${URGENCY_LABEL[rec.card.urgency] ?? ''}. ${rec.card.title}`

  // ── card nodes ──────────────────────────────────────────────────────────
  function createRec(card) {
    const node = el('article', 'deck-card')
    node.dataset.id = card.id
    node.tabIndex = -1
    node.setAttribute('aria-roledescription', 'Karte')
    const rec = {
      id: card.id, card, node, sigC: '', sigU: '',
      ui: { selected: null, note: '' },
      busy: false, lift: false, detour: false, leaving: null,
      pose: null, target: null, vel: { x: 0, y: 0, s: 0, r: 0, o: 0 }, spring: SPRING,
      z: null, dim: null, front: null, flagTimer: 0,
    }
    return rec
  }

  function fill(rec) {
    const { card, node } = rec
    const hadFocus = node.contains(document.activeElement) ? document.activeElement : null
    const noteFocus = hadFocus && hadFocus === rec.noteNode ? [rec.noteNode.selectionStart, rec.noteNode.selectionEnd] : null
    const scrollTop = rec.scroll?.scrollTop ?? 0
    const permission = card.kind === 'permission'
    node.dataset.kind = permission ? 'permission' : 'decision'
    const titleId = `deck-title-${card.id}`
    node.setAttribute('aria-labelledby', titleId)

    // head: the tab strip, flush with the top-left corner
    const head = el('header', 'deck-head')
    const tab = el('div', 'deck-tab')
    const nr = el('span', 'deck-tab-nr')
    nr.append(el('small', null, 'Nr.'), ` ${card.number}`)
    rec.urgNode = el('span', 'deck-tab-urg')
    tab.append(nr, rec.urgNode)
    const peekTitle = el('span', 'deck-peek-title', card.title)
    peekTitle.setAttribute('aria-hidden', 'true')
    rec.flagNode = el('span', 'deck-flag')
    rec.flagNode.hidden = true
    const time = agoNode(card.created, 'deck-ago')
    head.append(tab)
    // With several agents on the board, say whose question this is.
    if (card.agent_name) head.append(el('span', 'deck-agent', card.agent_name))
    head.append(peekTitle, rec.flagNode)
    if (getState().speech) {
      const say = el('button', 'deck-say')
      say.type = 'button'
      say.setAttribute('aria-label', 'Karte vorlesen')
      say.setAttribute('aria-pressed', 'false')
      say.append(el('i'), el('i'), el('i'))
      say.addEventListener('click', e => { e.stopPropagation(); readCard(card.id, say) })
      say.addEventListener('pointerdown', e => e.stopPropagation())
      head.append(say)
    }
    head.append(time)

    // scrolling content
    const scroll = el('div', 'deck-scroll')
    rec.scroll = scroll
    const title = el('h3', 'deck-title', card.title)
    title.id = titleId
    rec.reasonNode = el('p', 'deck-reason')
    scroll.append(title, rec.reasonNode)

    if (permission) {
      const { desc, raw, rows } = parsePermission(card.body)
      if (desc) scroll.append(el('p', 'deck-perm-desc', desc))
      if (raw) {
        const box = el('div', 'deck-perm')
        const cap = el('div', 'deck-cells')
        const tool = card.title.replace(/^[^:]{0,24}:\s*/, '')
        cap.append(el('span', null, tool || 'Werkzeug'), el('span', null, 'Eingabe'))
        box.append(cap)
        if (rows) {
          const dl = el('dl', 'deck-perm-rows')
          for (const [k, v] of rows) dl.append(el('dt', null, k), el('dd', null, v))
          box.append(dl)
        } else {
          box.append(el('pre', 'deck-perm-raw', raw))
        }
        scroll.append(box)
      }
    } else if (card.body) {
      scroll.append(rich(card.body))
    }

    const images = (card.attachments ?? []).filter(a => kindOf(a) === 'image')
    const files = (card.attachments ?? []).filter(a => kindOf(a) === 'file')
    scroll.append(...mediaNodes(card.attachments ?? []))
    if (images.length) {
      const gallery = el('div', 'deck-gallery')
      gallery.dataset.count = Math.min(images.length, 3)
      images.forEach((a, i) => {
        const btn = el('button', 'deck-thumb')
        btn.type = 'button'
        btn.setAttribute('aria-label', `Bild ${i + 1} von ${images.length} vergrößern: ${a.name}`)
        const img = el('img')
        img.src = a.url
        img.alt = ''
        img.loading = 'lazy'
        img.draggable = false
        const zoom = el('span', 'deck-thumb-zoom')
        zoom.append(icon('zoom'))
        btn.append(img, zoom, el('span', 'deck-thumb-name', a.name))
        btn.addEventListener('click', () => openLightbox(images, i, btn))
        gallery.append(btn)
      })
      scroll.append(gallery)
    }
    if (files.length) {
      const list = el('div', 'deck-files')
      for (const a of files) {
        const link = el('a', 'deck-file')
        link.href = a.url
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        link.append(icon('file'), el('span', null, a.name))
        list.append(link)
      }
      scroll.append(list)
    }

    const foot = el('footer', 'deck-foot')
    rec.foot = foot
    rec.errorNode = el('p', 'deck-error')
    rec.errorNode.setAttribute('role', 'alert')
    rec.errorNode.hidden = true
    rec.optButtons = []
    rec.noteNode = null
    rec.confirmBtn = null

    if (permission) {
      const allow = card.options.find(o => o.key === 'allow')
      const deny = card.options.find(o => o.key === 'deny')
      const rest = card.options.filter(o => o !== allow && o !== deny)
      const row = el('div', 'deck-verdict')
      const mk = (o, cls) => {
        const b = el('button', `deck-verdict-btn ${cls}`)
        b.type = 'button'
        b.append(el('span', 'deck-verdict-label', o.label), el('span', 'deck-key', o.key))
        b.addEventListener('click', () => submit(rec, o.key, ''))
        return b
      }
      if (deny) row.append(mk(deny, 'deck-deny'))
      for (const o of rest) row.append(mk(o, 'deck-neutral'))
      if (allow) row.append(mk(allow, 'deck-allow'))
      foot.append(rec.errorNode, row)
    } else {
      const cells = el('div', 'deck-cells deck-opts-head')
      cells.append(el('span', null, 'Deine Antwort'), el('span', null, `${card.options.length} Optionen`))
      const hint = el('span', 'deck-keys-hint', `Tasten 1–${card.options.length}`)
      cells.append(hint)
      const group = el('div', 'deck-opts')
      group.setAttribute('role', 'radiogroup')
      group.setAttribute('aria-labelledby', titleId)
      card.options.forEach((o, i) => {
        const b = el('button', 'deck-opt')
        b.type = 'button'
        b.dataset.key = o.key
        b.setAttribute('role', 'radio')
        const num = el('span', 'deck-opt-num')
        num.append(el('span', null, String(i + 1)), icon('check'))
        num.setAttribute('aria-hidden', 'true')
        b.append(num, el('span', 'deck-opt-label', o.label), el('span', 'deck-key', o.key))
        if (o.detail) b.append(el('span', 'deck-opt-detail', o.detail))
        b.addEventListener('click', () => select(rec, o.key))
        rec.optButtons.push(b)
        group.append(b)
      })
      scroll.append(cells, group)

      const note = el('textarea', 'deck-note')
      note.rows = 1
      note.placeholder = 'Anmerkung dazu?'
      note.setAttribute('aria-label', 'Anmerkung für den Agenten, optional')
      note.value = rec.ui.note
      const grow = () => { note.style.height = 'auto'; note.style.height = `${Math.min(note.scrollHeight, 132)}px` }
      note.addEventListener('input', () => { rec.ui.note = note.value; grow() })
      note.addEventListener('keydown', e => {
        if (e.key === 'Escape') { e.stopPropagation(); note.blur(); node.focus({ preventScroll: true }) }
      })
      rec.noteNode = note
      rec.growNote = grow

      foot.append(rec.errorNode, note)
    }

    // shown while the answer travels to the agent
    const stamp = el('div', 'deck-stamp')
    stamp.hidden = true
    const ring = el('span', 'deck-stamp-ring')
    ring.append(icon('check'))
    rec.stampTitle = el('strong', 'deck-stamp-title')
    rec.stampWhat = el('span', 'deck-stamp-what')
    stamp.append(ring, rec.stampTitle, rec.stampWhat)
    rec.stamp = stamp

    node.replaceChildren(head, scroll, foot, stamp)
    if (rec.ui.selected != null && !card.options.some(o => o.key === rec.ui.selected)) rec.ui.selected = null
    paintSelection(rec)
    paintUrgency(rec)
    scroll.scrollTop = scrollTop
    if (rec.noteNode && rec.ui.note) requestAnimationFrame(rec.growNote)
    if (noteFocus && rec.noteNode) {
      rec.noteNode.focus({ preventScroll: true })
      rec.noteNode.setSelectionRange(noteFocus[0], noteFocus[1])
    } else if (hadFocus) {
      node.focus({ preventScroll: true })
    }
    rec.front = null // force the inert/aria pass in layout()
  }

  function paintUrgency(rec) {
    const { card, node } = rec
    node.dataset.urgency = RANK[card.urgency] != null ? card.urgency : 'normal'
    rec.urgNode.replaceChildren(el('i', 'deck-dot'), URGENCY_LABEL[card.urgency] ?? card.urgency)
    rec.reasonNode.textContent = card.urgency_reason || ''
    rec.reasonNode.hidden = !card.urgency_reason
  }

  function paintSelection(rec) {
    const key = rec.ui.selected
    rec.optButtons.forEach((b, i) => {
      const on = b.dataset.key === key
      b.setAttribute('aria-checked', String(on))
      b.tabIndex = on || (key == null && i === 0) ? 0 : -1
    })
    rec.node.toggleAttribute('data-chosen', key != null)
    if (rec.confirmBtn) {
      const option = rec.card.options.find(o => o.key === key)
      rec.confirmBtn.setAttribute('aria-disabled', String(!option))
      rec.confirmMain.textContent = option ? 'Bestätigen' : 'Option wählen'
      rec.confirmWhat.textContent = option ? option.label : ''
    }
  }

  function setError(rec, text) {
    rec.errorNode.textContent = text
    rec.errorNode.hidden = !text
  }

  function select(rec, key) {
    if (rec.busy || rec.card.kind === 'permission') return
    rec.ui.selected = key
    setError(rec, '')
    paintSelection(rec)
    if (key == null) return reconsider()
    // One tap decides. A mistake is taken back with the undo bar or from the history.
    submit(rec, key, rec.ui.note.trim())
  }

  function confirm(rec) {
    if (rec.busy || rec.ui.selected == null) return
    submit(rec, rec.ui.selected, rec.ui.note.trim())
  }

  function setBusy(rec, busy) {
    rec.busy = busy
    rec.node.toggleAttribute('data-busy', busy)
    rec.scroll.inert = busy
    rec.foot.inert = busy
  }

  async function submit(rec, key, note) {
    if (rec.busy || rec.leaving) return
    const option = rec.card.options.find(o => o.key === key)
    const refocus = deck.contains(document.activeElement)
    setBusy(rec, true)
    setError(rec, '')
    rec.lift = true
    rec.stamp.hidden = false
    rec.stamp.dataset.state = 'pending'
    rec.stampTitle.textContent = 'Wird übermittelt'
    rec.stampWhat.textContent = option?.label ?? key
    if (refocus) rec.node.focus({ preventScroll: true })
    layout()
    try {
      await decide(rec.id, key, note)
    } catch (err) {
      rec.lift = false
      rec.stamp.hidden = true
      setBusy(rec, false)
      rec.ui.selected = null
      paintSelection(rec)
      const reason = err?.message || 'Der Server hat nicht geantwortet.'
      setError(rec, `Nicht übernommen: ${reason}`)
      announce(`Entscheidung nicht übernommen: ${reason}`)
      if (!still() && !rec.leaving) rec.vel.x = 1500 // a short, physical "no"
      layout()
      return
    }
    rec.stamp.dataset.state = 'done'
    rec.stampTitle.textContent = rec.card.kind === 'permission' ? (key === 'deny' ? 'Abgelehnt' : 'Erlaubt') : 'Entschieden'
    if (!still()) await wait(460)
    decidedLocal.set(rec.id, Date.now())
    root.dispatchEvent(new CustomEvent('deck:decided', { bubbles: true, detail: { cardId: rec.id, key } }))
    if (rec.card.kind === 'decision') offerUndo(rec.card, option)
    refresh()
  }

  // ── undo ────────────────────────────────────────────────────────────────
  let undoTimer = 0
  function offerUndo(card, option) {
    clearTimeout(undoTimer)
    const back = el('button', 'deck-undo-btn', 'Rückgängig')
    back.type = 'button'
    const text = el('span', 'deck-undo-text')
    text.append(el('span', 'deck-undo-kicker', `Nr. ${card.number} entschieden`), el('strong', null, option?.label ?? ''))
    back.addEventListener('click', async () => {
      back.disabled = true
      try {
        await reopen(card.id)
        decidedLocal.delete(card.id)
        undo.hidden = true
        announce('Entscheidung zurückgenommen')
      } catch (err) {
        back.disabled = false
        text.replaceChildren(el('span', 'deck-undo-kicker', 'Nicht zurückgenommen'), el('strong', null, err?.message || 'Der Server hat nicht geantwortet.'))
      }
    })
    undo.replaceChildren(text, back)
    undo.hidden = false
    undoTimer = setTimeout(() => { undo.hidden = true }, 12000)
  }

  // ── flags and banner ────────────────────────────────────────────────────
  function flag(rec, text) {
    rec.flagNode.replaceChildren(icon('up'), text)
    rec.flagNode.hidden = false
    rec.node.removeAttribute('data-pulse')
    void rec.node.offsetWidth
    rec.node.setAttribute('data-pulse', '')
    clearTimeout(rec.flagTimer)
    rec.flagTimer = setTimeout(() => {
      rec.flagNode.hidden = true
      rec.node.removeAttribute('data-pulse')
    }, FLAG_MS)
  }

  function paintBanner() {
    const rec = bannerId && cards.get(bannerId)
    if (!rec || bannerId === current) {
      bannerId = null
      banner.hidden = true
      return
    }
    const wasHidden = banner.hidden
    banner.dataset.urgency = rec.card.urgency
    const mark = el('span', 'deck-banner-mark')
    mark.append(icon('up'))
    const text = el('span', 'deck-banner-text')
    text.append(
      el('span', 'deck-banner-kicker', `${rec.bannerWhy} · ${URGENCY_LABEL[rec.card.urgency] ?? ''}`),
      el('span', 'deck-banner-title', `Nr. ${rec.card.number} · ${rec.card.title}`),
    )
    banner.replaceChildren(mark, text, el('span', 'deck-banner-cta', 'Ansehen'))
    banner.hidden = false
    if (wasHidden) announce(`${rec.bannerWhy}, ${URGENCY_LABEL[rec.card.urgency] ?? ''}: Nr. ${rec.card.number}, ${rec.card.title}. Deine aktuelle Karte bleibt vorn.`)
  }

  /** The user let go of the card they were answering: stop holding the stack back. */
  function reconsider() {
    if (bannerId && !engaged(cards.get(current))) {
      const id = bannerId
      bannerId = null
      go(id)
    }
  }

  // ── state → stack ───────────────────────────────────────────────────────
  function refresh() { if (lastState) onState(lastState) }

  function onState(state) {
    lastState = state
    const byId = new Map(state.cards.map(c => [c.id, c]))
    const now = Date.now()
    for (const [id, at] of decidedLocal) {
      if (byId.get(id)?.status !== 'open' || now - at > LOCAL_DECIDED_TTL) decidedLocal.delete(id)
    }
    const queue = [...new Set(state.queue)].filter(id => byId.get(id)?.status === 'open' && !decidedLocal.has(id))

    // "Später" stays in force until the agent raises the card's urgency
    for (const [id, rank] of deferred) {
      const card = byId.get(id)
      if (!queue.includes(id) || (RANK[card.urgency] ?? 1) > rank) deferred.delete(id)
    }
    const prevOrder = order
    const prevIndex = prevOrder.indexOf(current)
    order = [...queue.filter(id => !deferred.has(id)), ...[...deferred.keys()]]

    // leave
    for (const [id, rec] of cards) {
      if (order.includes(id)) continue
      cards.delete(id)
      clearTimeout(rec.flagTimer)
      rec.leaving = decidedLocal.has(id) || rec.busy ? 'sent' : 'gone'
      leavers.add(rec)
    }

    // Another agent was selected: the cards that appear now are not news.
    if (lastEpoch !== scopeEpoch()) { lastEpoch = scopeEpoch(); started = false }

    // enter and update
    const promoted = []
    for (const id of order) {
      const card = byId.get(id)
      const sigC = JSON.stringify([card.kind, card.number, card.title, card.body, card.options, card.attachments, card.created, card.agent_name])
      const sigU = `${card.urgency}|${card.urgency_reason ?? ''}`
      let rec = cards.get(id)
      if (!rec) {
        rec = createRec(card)
        cards.set(id, rec)
        stage.append(rec.node)
        if (started) { rec.fresh = true; rec.bannerWhy = 'Neu'; promoted.push(rec) }
      } else if ((RANK[card.urgency] ?? 1) > (RANK[rec.card.urgency] ?? 1)) {
        rec.bannerWhy = 'Hochgestuft'
        promoted.push(rec)
      }
      rec.card = card
      if (rec.sigC !== sigC) { rec.sigC = sigC; rec.sigU = sigU; fill(rec) }
      else if (rec.sigU !== sigU) { rec.sigU = sigU; paintUrgency(rec) }
    }

    // which card is in front
    const hadFocus = deck.contains(document.activeElement) && document.activeElement !== document.body
    let moved = false
    if (!order.includes(current)) {
      // the card that was waiting behind the banner goes first, otherwise the next one in line
      current = order.includes(bannerId) ? bannerId : order[clamp(prevIndex, 0, order.length - 1)] ?? null
      moved = true
    } else {
      const at = order.indexOf(current)
      const ahead = promoted.find(rec => order.indexOf(rec.id) < at)
      if (ahead) {
        if (engaged(cards.get(current))) bannerId = ahead.id
        else { current = ahead.id; moved = true }
      }
    }
    for (const rec of promoted) flag(rec, rec.bannerWhy)
    // Cards already waiting when the page opens are not news; only later arrivals are.
    if (isLoaded()) started = true

    deck.dataset.empty = String(order.length === 0)
    if (order.length !== openCount) {
      openCount = order.length
      // a microtask later, so a shell that listens right after mountDeck() still hears the first count
      const open = openCount
      queueMicrotask(() => root.dispatchEvent(new CustomEvent('deck:count', { bubbles: true, detail: { open } })))
    }
    layout()
    paintBanner()
    if (moved) {
      if (current) {
        announce(describe(cards.get(current), order.indexOf(current), order.length))
        if (hadFocus) cards.get(current).node.focus({ preventScroll: true })
      } else if (prevOrder.length) {
        announce('Alles entschieden. Keine offenen Karten.')
      }
    }
  }

  function go(target) {
    const id = typeof target === 'number' ? order[order.indexOf(current) + target] : target
    if (!id || id === current || !cards.has(id)) return false
    const refocus = deck.contains(document.activeElement)
    current = id
    layout()
    paintBanner()
    announce(describe(cards.get(id), order.indexOf(id), order.length))
    if (refocus) cards.get(id).node.focus({ preventScroll: true })
    return true
  }

  function later() {
    const rec = cards.get(current)
    const at = order.indexOf(current)
    if (!rec || rec.busy || at < 0 || at === order.length - 1) return
    deferred.delete(rec.id)
    deferred.set(rec.id, RANK[rec.card.urgency] ?? 1)
    if (!still()) {
      rec.detour = true
      setTimeout(() => { rec.detour = false; layout() }, 230)
    }
    current = order[at + 1]
    refresh()
    announce(`Nr. ${rec.card.number} nach hinten gelegt. ${describe(cards.get(current), order.indexOf(current), order.length)}`)
  }

  // ── poses ───────────────────────────────────────────────────────────────
  const peekAt = d => {
    const c = clamp(d, 0, MAX_DEPTH), i = Math.floor(c)
    return i >= MAX_DEPTH ? PEEK[MAX_DEPTH] : lerp(PEEK[i], PEEK[i + 1], c - i)
  }
  const stackPose = (d, base) => ({
    x: 0, y: Math.max(0, base - peekAt(d)), s: 1 - 0.045 * Math.min(d, MAX_DEPTH), r: 0,
    o: d <= MAX_DEPTH ? 1 : clamp(1 - (d - MAX_DEPTH)),
  })

  function layout() {
    const n = order.length
    const idx = order.indexOf(current)
    const W = stage.clientWidth || 400
    const off = W + 80
    const base = peekAt(Math.min(MAX_DEPTH, Math.max(0, n - 1 - idx)))
    stage.style.setProperty('--deck-base', `${base}px`)

    const dx = drag?.active ? drag.dx : 0
    const toNext = dx < 0 && idx < n - 1
    const toPrev = dx > 0 && idx > 0
    const p = clamp(Math.abs(dx) / (W * 0.8))

    order.forEach((id, pos) => {
      const rec = cards.get(id)
      const d = pos - idx
      let t
      if (d < 0) {
        t = { x: -off, y: base, s: 1, r: -7, o: 0 }
        if (toPrev && d === -1) {
          const x = -off * (1 - p)
          t = { x, y: base, s: 1, r: (x / W) * 7, o: clamp(p * 4) }
        }
      } else {
        t = stackPose(toNext && d > 0 ? d - p : toPrev ? d + p : d, base)
        if (d === 0 && dx && !toPrev) {
          t.x = toNext ? dx : dx * 0.22
          t.r = (t.x / W) * 9
        }
      }
      if (rec.detour) t = { x: W * 0.78, y: base + 14, s: 0.93, r: 8, o: 1 }
      if (rec.lift && d === 0) { t.y -= 8; t.s *= 0.985 }

      const front = d === 0
      const z = rec.detour ? 400 : d < 0 ? 300 + pos : 200 - d
      if (rec.z !== z) { rec.z = z; rec.node.style.zIndex = z }
      const dim = d <= 0 || rec.detour ? 0 : Math.min(d, MAX_DEPTH) * 0.16
      if (rec.dim !== dim) { rec.dim = dim; rec.node.style.setProperty('--deck-dim', dim.toFixed(3)) }
      if (rec.front !== front) {
        rec.front = front
        rec.node.toggleAttribute('data-front', front)
        rec.node.setAttribute('aria-hidden', String(!front))
        rec.scroll.inert = !front || rec.busy
        rec.foot.inert = !front || rec.busy
        if (front) observeFront(rec.node)
      }

      if (!rec.pose) {
        // a card that arrives after the first paint drops into its place
        rec.pose = rec.fresh && !still() ? { ...t, y: t.y - 44, s: t.s * 0.94, o: 0 } : { ...t }
        rec.fresh = false
      }
      rec.spring = SPRING
      rec.target = t
      if (drag?.active || still()) { rec.pose = { ...t }; rec.vel = { x: 0, y: 0, s: 0, r: 0, o: 0 } }
    })

    for (const rec of leavers) {
      if (rec.target?.leaving) continue
      const from = rec.pose ?? { x: 0, y: base, s: 1, r: 0, o: 1 }
      rec.pose = from
      rec.spring = SPRING_SOFT
      rec.node.style.zIndex = rec.leaving === 'sent' ? 500 : 150
      rec.node.setAttribute('aria-hidden', 'true')
      rec.node.inert = true
      rec.target = rec.leaving === 'sent'
        ? { x: W * 0.12, y: from.y - Math.max(360, stage.clientHeight * 0.8), s: 0.9, r: 5, o: 0, leaving: true }
        : { x: 0, y: from.y + 28, s: from.s * 0.94, r: 0, o: 0, leaving: true }
      if (still()) rec.pose = { ...rec.target }
    }

    // chrome
    if (n) {
      posNow.textContent = String(idx + 1)
      posAll.textContent = ` von ${n}`
      prevBtn.disabled = idx <= 0
      nextBtn.disabled = idx >= n - 1
      laterBtn.disabled = idx >= n - 1
      const sig = order.map(id => cards.get(id).card.urgency).join() + `@${idx}`
      if (sig !== railSig) {
        railSig = sig
        rail.replaceChildren(...order.map((id, i) => {
          const seg = el('i', 'deck-rail-seg')
          seg.dataset.urgency = cards.get(id).card.urgency
          seg.dataset.at = i < idx ? 'past' : i === idx ? 'now' : 'next'
          return seg
        }))
      }
    }
    run()
  }

  // The front card decides how tall the stack is; the others take its height
  // so nothing sticks out underneath.
  const sizer = new ResizeObserver(entries => {
    const box = entries[entries.length - 1].borderBoxSize?.[0]
    const h = box ? box.blockSize : entries[entries.length - 1].target.offsetHeight
    if (h) stage.style.setProperty('--deck-front-h', `${Math.round(h)}px`)
  })
  let observed = null
  function observeFront(node) {
    if (observed === node) return
    if (observed) sizer.unobserve(observed)
    observed = node
    sizer.observe(node)
  }

  // ── spring loop ─────────────────────────────────────────────────────────
  const KEYS = ['x', 'y', 's', 'r', 'o']
  const EPS = { x: 0.15, y: 0.15, s: 0.0006, r: 0.02, o: 0.004 }
  let raf = 0
  let lastTick = 0

  function paint(rec) {
    const p = rec.pose
    rec.node.style.transform = `translate3d(${p.x.toFixed(2)}px,${p.y.toFixed(2)}px,0) rotate(${p.r.toFixed(3)}deg) scale(${p.s.toFixed(4)})`
    rec.node.style.opacity = clamp(p.o).toFixed(3)
    rec.node.style.visibility = p.o < 0.01 ? 'hidden' : ''
  }

  function step(rec, dt) {
    let moving = false
    const { pose, target, vel, spring } = rec
    for (const k of KEYS) {
      const gap = pose[k] - target[k]
      if (Math.abs(gap) < EPS[k] && Math.abs(vel[k]) < EPS[k] * 8) { pose[k] = target[k]; vel[k] = 0; continue }
      vel[k] += (-spring.k * gap - spring.c * vel[k]) * dt
      pose[k] += vel[k] * dt
      moving = true
    }
    return moving
  }

  function tick(now) {
    raf = 0
    const dt = Math.min(0.034, (now - lastTick) / 1000) / 2
    lastTick = now
    let moving = false
    for (const rec of cards.values()) {
      if (!rec.pose) continue
      const m = step(rec, dt) | step(rec, dt)
      paint(rec)
      if (m) moving = true
    }
    for (const rec of leavers) {
      const m = step(rec, dt) | step(rec, dt)
      paint(rec)
      if (!m || rec.pose.o < 0.015) { leavers.delete(rec); rec.node.remove() } else moving = true
    }
    if (moving) raf = requestAnimationFrame(tick)
  }

  function run() {
    if (still() || drag?.active) {
      for (const rec of cards.values()) if (rec.pose) paint(rec)
      for (const rec of leavers) {
        if (still()) { leavers.delete(rec); rec.node.remove() } else paint(rec)
      }
      if (still() || !leavers.size) return
    }
    if (!raf) {
      lastTick = performance.now()
      for (const rec of cards.values()) if (rec.pose && !rec.node.style.transform) paint(rec)
      raf = requestAnimationFrame(tick)
    }
  }

  // ── pointer: drag the front card sideways ───────────────────────────────
  let swallowClickUntil = 0

  stage.addEventListener('pointerdown', e => {
    if (e.button || drag || lightbox) return
    const node = e.target.closest('.deck-card')
    if (!node || node.dataset.id !== current) return
    const rec = cards.get(current)
    if (rec.busy || e.target.closest('textarea, input, a')) return
    // with a mouse, dragging across prose means selecting text
    if (e.pointerType === 'mouse' && e.target.closest('.rich, .deck-perm, .deck-perm-desc')) return
    drag = { pointer: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, active: false, trail: [] }
  })

  stage.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.pointer) return
    const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0
    if (!drag.active) {
      if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.3) {
        drag.active = true
        drag.x0 = e.clientX - Math.sign(dx) // start from here, no jump
        try { stage.setPointerCapture(e.pointerId) } catch {}
        stage.dataset.dragging = ''
      } else {
        if (Math.abs(dy) > 12) drag = null
        return
      }
    }
    drag.dx = e.clientX - drag.x0
    drag.trail.push([e.timeStamp, e.clientX])
    if (drag.trail.length > 6) drag.trail.shift()
    layout()
  })

  function endDrag(e) {
    if (!drag || e.pointerId !== drag.pointer) return
    const d = drag
    drag = null
    if (!d.active) return
    delete stage.dataset.dragging
    try { stage.releasePointerCapture(e.pointerId) } catch {}
    swallowClickUntil = performance.now() + 350
    const first = d.trail[0], last = d.trail[d.trail.length - 1]
    const v = first && last && last[0] > first[0] ? (last[1] - first[1]) / (last[0] - first[0]) : 0 // px/ms
    const W = stage.clientWidth || 400
    const idx = order.indexOf(current)
    const dir = d.dx < 0 ? 1 : -1
    const far = Math.abs(d.dx) > W * 0.28 || (Math.abs(v) > 0.45 && Math.sign(v) === Math.sign(d.dx))
    const moving = cards.get(dir === 1 ? current : order[idx - 1])
    if (e.type !== 'pointercancel' && far && go(dir)) {
      if (moving && !still()) moving.vel.x = clamp(v, -3, 3) * 1000
    } else {
      layout()
    }
  }
  stage.addEventListener('pointerup', endDrag)
  stage.addEventListener('pointercancel', endDrag)
  stage.addEventListener('click', e => {
    if (performance.now() < swallowClickUntil) {
      swallowClickUntil = 0
      e.stopPropagation()
      e.preventDefault()
      return
    }
    // tapping a card that peeks out behind brings it forward
    const node = e.target.closest('.deck-card')
    if (node && node.dataset.id !== current && cards.has(node.dataset.id)) go(node.dataset.id)
  }, true)

  prevBtn.addEventListener('click', () => go(-1))
  nextBtn.addEventListener('click', () => go(1))
  laterBtn.addEventListener('click', later)
  banner.addEventListener('click', () => { const id = bannerId; bannerId = null; if (!go(id)) paintBanner() })

  // ── keyboard ────────────────────────────────────────────────────────────
  document.addEventListener('keydown', e => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || lightbox || !current) return
    const t = e.target instanceof Element ? e.target : null
    if (t?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], dialog')) return
    if (!root.getClientRects().length) return
    const rec = cards.get(current)
    const decision = rec.card.kind !== 'permission'
    const done = () => e.preventDefault()

    if (e.key === 'ArrowLeft') { go(-1); return done() }
    if (e.key === 'ArrowRight') { go(1); return done() }
    if (rec.busy) return

    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && t?.closest('.deck-opts') && rec.optButtons.length) {
      const at = rec.optButtons.indexOf(t.closest('.deck-opt'))
      const n = rec.optButtons.length
      const to = rec.optButtons[(at + (e.key === 'ArrowDown' ? 1 : n - 1)) % n]
      select(rec, to.dataset.key)
      to.focus()
      return done()
    }
    if (decision && /^[1-9]$/.test(e.key) && !e.shiftKey) {
      const option = rec.card.options[Number(e.key) - 1]
      if (!option) return
      select(rec, option.key)
      if (deck.contains(document.activeElement)) rec.optButtons[Number(e.key) - 1].focus({ preventScroll: true })
      return done()
    }
    if (e.key === 'Enter' && decision && rec.ui.selected != null) {
      // Enter on some other control keeps its own meaning
      if (t?.closest('button, a, summary') && !t.closest('.deck-opt, .deck-confirm')) return
      confirm(rec)
      return done()
    }
    if (e.key === 'Escape' && decision && rec.ui.selected != null) {
      select(rec, null)
      return done()
    }
  })

  // ── lightbox ────────────────────────────────────────────────────────────
  function openLightbox(images, start, opener) {
    if (lightbox) return
    const box = el('div', 'deck-lightbox')
    box.setAttribute('role', 'dialog')
    box.setAttribute('aria-modal', 'true')
    box.setAttribute('aria-label', 'Bildansicht')
    box.tabIndex = -1

    const top = el('div', 'deck-lb-top')
    const count = el('span', 'deck-lb-count')
    const name = el('span', 'deck-lb-name')
    const close = el('button', 'deck-lb-btn')
    close.type = 'button'
    close.setAttribute('aria-label', 'Bildansicht schließen')
    close.append(icon('close'))
    top.append(count, name, close)

    const view = el('div', 'deck-lb-view')
    const img = el('img', 'deck-lb-img')
    img.draggable = false
    view.append(img)

    const prev = el('button', 'deck-lb-btn deck-lb-prev')
    prev.type = 'button'
    prev.setAttribute('aria-label', 'Vorheriges Bild')
    prev.append(icon('left'))
    const next = el('button', 'deck-lb-btn deck-lb-next')
    next.type = 'button'
    next.setAttribute('aria-label', 'Nächstes Bild')
    next.append(icon('right'))
    const dots = el('div', 'deck-lb-dots')
    dots.setAttribute('aria-hidden', 'true')
    box.append(view, top, prev, next, dots)

    let i = start
    let scale = 1, tx = 0, ty = 0
    const pointers = new Map()
    let gesture = null
    let lastTap = 0

    const apply = animate => {
      img.classList.toggle('deck-lb-settle', !!animate && !still())
      img.style.transform = `translate3d(${tx.toFixed(1)}px,${ty.toFixed(1)}px,0) scale(${scale.toFixed(3)})`
      view.dataset.zoomed = String(scale > 1.01)
    }
    const bound = () => {
      const mx = Math.max(0, (img.offsetWidth * scale - view.clientWidth) / 2)
      const my = Math.max(0, (img.offsetHeight * scale - view.clientHeight) / 2)
      tx = clamp(tx, -mx, mx)
      ty = clamp(ty, -my, my)
    }
    const zoomTo = (s, cx, cy, animate) => {
      const rect = view.getBoundingClientRect()
      const px = (cx ?? rect.left + rect.width / 2) - (rect.left + rect.width / 2)
      const py = (cy ?? rect.top + rect.height / 2) - (rect.top + rect.height / 2)
      const to = clamp(s, 1, 5)
      tx = px - ((px - tx) / scale) * to
      ty = py - ((py - ty) / scale) * to
      scale = to
      if (scale === 1) { tx = 0; ty = 0 }
      bound()
      apply(animate)
    }
    const show = (to, dir = 0) => {
      i = (to + images.length) % images.length
      scale = 1; tx = 0; ty = 0
      img.classList.remove('deck-lb-settle')
      img.style.transform = ''
      img.src = images[i].url
      img.alt = images[i].name
      img.dataset.from = String(dir)
      img.classList.remove('deck-lb-in')
      void img.offsetWidth
      img.classList.add('deck-lb-in')
      count.textContent = `${i + 1} / ${images.length}`
      name.textContent = images[i].name
      dots.replaceChildren(...images.map((_, k) => {
        const d = el('i')
        if (k === i) d.dataset.on = ''
        return d
      }))
      view.dataset.zoomed = 'false'
    }
    const single = images.length < 2
    prev.hidden = next.hidden = dots.hidden = single

    const shut = () => {
      document.removeEventListener('keydown', onKey, true)
      lightbox = null
      box.dataset.closing = ''
      const drop = () => box.remove()
      if (still()) drop()
      else { box.addEventListener('animationend', drop, { once: true }); setTimeout(drop, 400) }
      opener?.focus?.({ preventScroll: true })
    }
    const onKey = e => {
      e.stopPropagation()
      if (e.key === 'Escape') { e.preventDefault(); shut() }
      else if (e.key === 'ArrowLeft' && !single) { e.preventDefault(); show(i - 1, -1) }
      else if (e.key === 'ArrowRight' && !single) { e.preventDefault(); show(i + 1, 1) }
      else if (e.key === '+' || e.key === '=') zoomTo(scale * 1.5, null, null, true)
      else if (e.key === '-') zoomTo(scale / 1.5, null, null, true)
      else if (e.key === '0') zoomTo(1, null, null, true)
      else if (e.key === 'Tab') {
        const stops = [close, prev, next].filter(b => !b.hidden)
        const at = stops.indexOf(document.activeElement)
        e.preventDefault()
        stops[(at + (e.shiftKey ? stops.length - 1 : 1)) % stops.length].focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    close.addEventListener('click', shut)
    prev.addEventListener('click', () => show(i - 1, -1))
    next.addEventListener('click', () => show(i + 1, 1))

    view.addEventListener('wheel', e => {
      e.preventDefault()
      zoomTo(scale * Math.exp(-e.deltaY * 0.0022), e.clientX, e.clientY, false)
    }, { passive: false })

    const spread = () => {
      const [a, b] = [...pointers.values()]
      return { dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }
    }
    view.addEventListener('pointerdown', e => {
      if (e.button) return
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      try { view.setPointerCapture(e.pointerId) } catch {}
      img.classList.remove('deck-lb-settle')
      if (pointers.size === 2) {
        const s = spread()
        gesture = { kind: 'pinch', dist: s.dist, scale }
      } else {
        gesture = { kind: scale > 1.01 ? 'pan' : 'swipe', x0: e.clientX, y0: e.clientY, tx, ty, moved: false, t0: e.timeStamp, onImg: e.target === img }
      }
    })
    view.addEventListener('pointermove', e => {
      if (!pointers.has(e.pointerId) || !gesture) return
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (gesture.kind === 'pinch' && pointers.size === 2) {
        const s = spread()
        zoomTo(gesture.scale * (s.dist / gesture.dist), s.cx, s.cy, false)
        return
      }
      const dx = e.clientX - gesture.x0, dy = e.clientY - gesture.y0
      if (Math.hypot(dx, dy) > 6) gesture.moved = true
      if (gesture.kind === 'pan') {
        tx = gesture.tx + dx; ty = gesture.ty + dy
        bound()
        apply(false)
      } else if (gesture.kind === 'swipe' && gesture.moved) {
        const sideways = Math.abs(dx) > Math.abs(dy)
        tx = sideways ? (single ? dx * 0.25 : dx) : 0
        ty = sideways ? 0 : Math.max(0, dy)
        box.style.setProperty('--deck-lb-fade', String(1 - clamp(ty / 320) * 0.7))
        apply(false)
      }
    })
    const release = e => {
      if (!pointers.has(e.pointerId)) return
      pointers.delete(e.pointerId)
      const g = gesture
      if (pointers.size) { // one finger of a pinch is still down: carry on as a pan
        const [rest] = [...pointers.values()]
        gesture = { kind: 'pan', x0: rest.x, y0: rest.y, tx, ty, moved: true }
        return
      }
      gesture = null
      if (!g) return
      box.style.removeProperty('--deck-lb-fade')
      if (g.kind === 'pinch') { if (scale < 1.05) zoomTo(1, null, null, true); return }
      if (g.kind === 'swipe' && g.moved) {
        const speed = Math.abs(tx) / Math.max(1, e.timeStamp - g.t0)
        if (ty > 110) return shut()
        if (!single && (Math.abs(tx) > 70 || (speed > 0.5 && Math.abs(tx) > 24))) return show(i + (tx < 0 ? 1 : -1), tx < 0 ? 1 : -1)
        tx = 0; ty = 0
        return apply(true)
      }
      if (g.moved) return
      if (!g.onImg) return shut() // tap on the backdrop
      if (e.timeStamp - lastTap < 320) { lastTap = 0; zoomTo(scale > 1.01 ? 1 : 2.5, e.clientX, e.clientY, true) }
      else lastTap = e.timeStamp
    }
    view.addEventListener('pointerup', release)
    view.addEventListener('pointercancel', release)

    document.body.append(box)
    lightbox = { close: shut }
    show(start)
    close.focus({ preventScroll: true })
  }

  // ── wiring ──────────────────────────────────────────────────────────────
  root.addEventListener('deck:focus', e => {
    const id = e.detail?.cardId
    if (!cards.has(id)) return
    if (id === bannerId) bannerId = null
    if (!go(id)) paintBanner()
    const rec = cards.get(id)
    if (!still()) rec.node.removeAttribute('data-pulse'), void rec.node.offsetWidth, rec.node.setAttribute('data-pulse', '')
  })

  new ResizeObserver(() => { if (order.length) layout() }).observe(stage)
  reduced.addEventListener?.('change', () => layout())
  subscribe(onState)
}
