// The page behind /screens.html: the debug index of every screen (the list itself is js/screens.js).
// It reads the board's state once, through the same stream the app uses (/events), and never writes: the
// first session, the first open question and so on fill the links that need something to show.

import { AREAS, SCREENS, DESIGNS, liveOf } from './screens.js'

const $ = id => document.getElementById(id)
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n }
const STATUS = ['current', 'hidden', 'dead']
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

let live = liveOf(null)
let only = null   // a status the list is narrowed to

function row(s) {
  const node = el('article', 'row')
  node.dataset.status = s.status
  const href = typeof s.to === 'function' ? s.to(live) : s.to ?? null
  const head = el('h3')
  if (href) { const a = el('a', null, s.name); a.href = href; head.append(a) } else head.textContent = s.name
  if (s.popup) head.append(el('span', 'pop', s.popup))
  if (s.at) head.append(el('span', 'pop', s.at))
  const tag = el('span', 'tag', s.status)
  tag.dataset.status = s.status
  const how = el('div', 'how')
  if (href) { const a = el('a', null, href); a.href = href; how.append(a) }
  else if (typeof s.to === 'function') how.append(el('span', null, s.needs ?? 'nothing on this board to show it with right now'))
  if (s.steps) how.append(el('span', 'steps', s.steps))
  if (s.where) how.append(el('span', null, s.where))
  node.append(head, tag, el('p', 'desc', s.desc))
  if (how.childNodes.length) node.append(how)
  node.dataset.text = [s.name, s.desc, s.steps, s.where, href, s.status, s.popup, s.at].filter(Boolean).join(' ').toLowerCase()
  return node
}

function paint() {
  const list = $('list')
  list.replaceChildren()
  $('jump').replaceChildren()
  for (const [area, blurb] of AREAS) {
    const rows = SCREENS.filter(s => s.area === area)
    if (!rows.length && area !== 'Design pages') continue
    const section = el('section')
    const h = el('h2', null, area)
    h.id = slug(area)
    section.append(h)
    if (blurb) section.append(el('p', null, blurb))
    if (rows.length) {
      const box = el('div', 'rows')
      box.append(...rows.map(row))
      section.append(box)
      h.append(el('small', null, String(rows.length)))
    }
    if (area === 'Design pages') {
      const ul = el('ul', 'designs')
      let n = 0
      for (const [group, pages] of DESIGNS) {
        ul.append(el('h4', null, group))
        for (const [file, title, mark] of pages) {
          const li = el('li')
          const a = el('a', null, title)
          a.href = `/designs/${file}`
          li.append(a, el('small', null, file))
          if (mark) { const m = el('span', 'pop', mark); m.title = 'No longer shows what it was made for: the part of the board it decorates has changed'; li.append(m) }
          li.dataset.text = `${title} ${file} ${group} ${mark ?? ''}`.toLowerCase()
          li.dataset.status = 'design'
          ul.append(li)
          n++
        }
      }
      section.append(ul)
      h.querySelector('small')?.remove()
      h.append(el('small', null, String(rows.length + n)))
    }
    list.append(section)
    const j = el('a', null, area)
    j.href = `#${h.id}`
    $('jump').append(j)
  }
  filter()
}

function filter() {
  const q = $('find').value.trim().toLowerCase()
  let shown = 0
  for (const section of $('list').children) {
    let any = 0
    for (const node of section.querySelectorAll('.row, .designs li')) {
      const ok = (!q || node.dataset.text.includes(q)) && (!only || node.dataset.status === only)
      node.hidden = !ok
      if (ok) any++
    }
    for (const h of section.querySelectorAll('.designs h4')) {
      let next = h.nextElementSibling, some = false
      while (next && next.tagName === 'LI') { if (!next.hidden) some = true; next = next.nextElementSibling }
      h.hidden = !some
    }
    const ul = section.querySelector('.designs')
    if (ul) ul.hidden = ![...ul.querySelectorAll('li')].some(li => !li.hidden)
    const box = section.querySelector('.rows')
    if (box) box.hidden = ![...box.children].some(r => !r.hidden)
    section.hidden = !any
    shown += any
  }
  $('none').hidden = shown > 0
}

// Only on its own page (screens.html): imported anywhere else, this module does nothing.
if ($('list') && $('tools') && $('find')) start()

function start() {
  // The status buttons: how many there are of each, and a press narrows the list to it.
  for (const status of STATUS) {
    const b = el('button', null, status)
    b.type = 'button'
    b.setAttribute('aria-pressed', 'false')
    b.append(el('b', null, String(SCREENS.filter(s => s.status === status).length)))
    b.addEventListener('click', () => {
      only = only === status ? null : status
      for (const other of $('tools').querySelectorAll('button')) other.setAttribute('aria-pressed', String(other === b && only === status))
      filter()
    })
    $('tools').append(b)
  }
  $('find').addEventListener('input', filter)
  paint()

  // ---- the board's state, read once ----
  // For the dev sweep (and for whoever is curious): every entry with the link it resolved to.
  window.__screens = () => SCREENS.map(s => ({ area: s.area, name: s.name, status: s.status, at: s.at ?? null, href: typeof s.to === 'function' ? s.to(live) : s.to ?? null }))
  const note = $('live')
  function say(state) {
    const open = state.cards.filter(c => c.status === 'open').length
    note.replaceChildren('Links are filled from this board: ', el('b', null, `${state.agents.length} sessions`), ', ', el('b', null, `${open} open questions`), ', ', el('b', null, `${state.assets?.length ?? 0} files`), '.')
    if (live.sessionName) note.append(` Session links go to "${live.sessionName}"`, live.cardNumber != null ? `, card links to Nr. ${live.cardNumber}.` : '.')
  }
  try {
    const events = new EventSource('/events')
    events.onmessage = e => {
      events.close()   // one frame is enough: this page only reads
      const state = JSON.parse(e.data)
      live = liveOf(state)
      say(state)
      paint()
      document.documentElement.dataset.loaded = ''
    }
    events.onerror = () => {
      if (document.documentElement.dataset.loaded != null) return
      events.close()
      note.dataset.state = 'error'
      note.textContent = 'The board did not answer (not signed in, or the hub is down): links that need a session or a question are left out.'
      document.documentElement.dataset.loaded = ''
    }
  } catch {
    note.textContent = 'This browser cannot read the board; links that need a session or a question are left out.'
  }
}
