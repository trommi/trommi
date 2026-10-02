// What lies behind a session's conversation, each as one calm list:
// the answered questions (newest first, what the agent is still working on before
// what is done; a tap unfolds what was asked, what was chosen, and the way to answer
// again), and the files: everything the session ever sent.

import { el, agoNode, URGENCY_LABEL, kindOf, ASSET_LABEL, linkInfo } from './ui.js'
import { reopen } from './store.js'
import { icon, attachmentNodes, richPlus, openLightbox } from './chat.js'

const SHORT = 6   // so many lines stand open to view; the rest wait behind one button

// A card that allowed several answers carries them all in choices; older ones only the one in choice.
const choices = card => card.choices ?? (card.choice != null ? [card.choice] : [])
const chosen = card => card.options?.filter(o => choices(card).includes(o.key)).map(o => o.label).join(', ')

function detailNode(card) {
  const box = el('div', 'hist-detail-in')
  if (card.body) box.append(richPlus(card.body))
  box.append(...attachmentNodes(card.attachments))

  const list = el('ul', 'hist-options')
  for (const o of card.options ?? []) {
    const picked = choices(card).includes(o.key)
    const li = el('li', picked ? 'is-chosen' : null)
    const mark = el('span', 'hist-mark')
    if (picked) mark.append(icon('check'))
    const text = el('span', 'hist-option')
    text.append(el('b', null, o.label))
    if (o.detail) text.append(el('span', null, o.detail))
    li.append(mark, text)
    list.append(li)
  }
  if (list.children.length) box.append(list)

  const quote = (label, text) => {
    const p = el('p', 'hist-quote')
    p.append(el('span', 'caps', label), el('span', null, text))
    box.append(p)
  }
  if (card.note) quote('Your note', card.note)
  if (card.summary) quote('Result', card.summary)

  // When it was asked and answered, and the way back: the card returns to the open
  // questions and the agent is told.
  const foot = el('p', 'hist-foot')
  const when = el('span', 'hist-times')
  when.append(`Nr. ${card.number} · asked `, agoNode(card.created))
  if (card.decided) when.append(' · answered ', agoNode(card.decided))
  when.append(' · ', card.kind === 'permission' ? 'Permission' : URGENCY_LABEL[card.urgency] ?? '')
  foot.append(when)
  if (card.kind === 'decision' && card.choice != null) {
    const again = el('button', 'hist-reopen', 'Answer again')
    again.type = 'button'
    const fail = el('span', 'hist-reopen-error')
    again.addEventListener('click', async () => {
      again.disabled = true
      try {
        await reopen(card.id)
      } catch (err) {
        again.disabled = false
        fail.textContent = `Not taken back: ${err.message}`
      }
    })
    foot.append(fail, again)
  }
  box.append(foot)
  return box
}

function rowNode(card, expanded, onToggle) {
  const row = el('article', 'hist-row')
  row.dataset.card = card.id
  row.dataset.status = card.status

  const head = el('button', 'hist-head')
  head.type = 'button'
  const pick = el('span', 'hist-pick')
  if (card.choice != null) pick.append(icon('check'))
  pick.append(chosen(card) || card.choice || 'No answer')
  // One line under the title: the answer, what became of it, and when.
  const sub = el('span', 'hist-sub')
  const outcome = card.status === 'done' ? card.summary || 'done' : 'in progress'
  sub.append(pick, el('span', 'hist-outcome', outcome), agoNode(card.decided ?? card.created, 'hist-when'))
  head.append(el('span', 'hist-title', card.title), sub)

  const detail = el('div', 'hist-detail')
  const clip = el('div', 'hist-detail-clip')
  detail.append(clip)
  const set = open => {
    if (open && !clip.firstChild) clip.append(detailNode(card))   // built on first use
    row.classList.toggle('is-open', open)
    head.setAttribute('aria-expanded', String(open))
    clip.inert = !open
  }
  head.addEventListener('click', () => {
    const open = !row.classList.contains('is-open')
    set(open)
    onToggle(card.id, open)
  })
  set(expanded)
  row.append(head, detail)
  return row
}

/**
 * Render one session's answered questions into root. Returns
 *   render(state, loaded)
 *   reveal(cardId): unfold that card's line and highlight it; false if the card is not in the history
 */
export function mountHistory(root, { agent, flags = new Set() } = {}) {
  let cards = []
  let lastState = null
  let all = false                 // every line is listed, not only the first few
  const expanded = new Set()
  const rows = new Map()          // card id -> { sig, node }; unchanged cards keep their node

  // The heading is a divider, like the senders' names in the inbox.
  const heading = el('h3', 'hist-heading')
  const count = el('b')
  heading.append(el('span', null, 'Answered'), count)
  const list = el('div', 'hist-list')
  const more = el('button', 'hist-more')
  more.type = 'button'
  more.addEventListener('click', () => { all = true; render(lastState, true) })
  root.append(heading, list, more)
  root.hidden = true

  function render(state, loaded) {
    if (!loaded) return
    lastState = state
    cards = state.all.cards.filter(c => c.agent === agent)
    // Still in the works first, then what is done; within each the latest answer first.
    const past = cards.filter(c => c.status !== 'open')
      .sort((a, b) => (a.status === 'done') - (b.status === 'done') || (b.decided ?? b.created) - (a.decided ?? a.created))
    root.hidden = !past.length
    const busy = past.filter(c => c.status === 'decided').length
    count.textContent = [busy && `${busy} in progress`, past.length - busy && `${past.length - busy} done`].filter(Boolean).join(' · ')
    const shown = all ? past : past.slice(0, SHORT)
    const nodes = shown.map(card => {
      const sig = JSON.stringify(card)
      const cached = rows.get(card.id)
      if (cached?.sig === sig) return cached.node
      const node = rowNode(card, expanded.has(card.id), (id, on) => on ? expanded.add(id) : expanded.delete(id))
      rows.set(card.id, { sig, node })
      return node
    })
    const keep = new Set(shown.map(c => c.id))
    for (const id of rows.keys()) if (!keep.has(id)) rows.delete(id)
    const same = list.children.length === nodes.length && nodes.every((n, i) => list.children[i] === n)
    if (!same) list.replaceChildren(...nodes)
    more.hidden = shown.length === past.length
    more.textContent = `Show all ${past.length}`
  }

  function reveal(cardId) {
    const card = cards.find(c => c.id === cardId)
    if (!card || card.status === 'open') return false
    if (!rows.has(cardId)) { all = true; render(lastState, true) }
    const row = rows.get(cardId)?.node
    if (!row) return false
    if (!row.classList.contains('is-open')) row.querySelector('.hist-head').click()
    // Wait for the pane to be laid out before scrolling to the line.
    setTimeout(() => {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' })
      row.classList.remove('is-flash')
      void row.offsetWidth
      row.classList.add('is-flash')
    }, 280)
    return true
  }

  // ---- state for screenshots: #expand unfolds the first line ----
  let staged = false
  function stage() {
    if (staged || !list.firstChild || !flags.has('expand')) return
    staged = true
    list.querySelector('.hist-head')?.click()
  }

  return {
    render(state, loaded) { render(state, loaded); stage() },
    reveal,
  }
}

// ---- files: everything a session ever sent, newest first -------------------------

const LINK = /https?:\/\/[^\s<>)\]]+/g
const KIND_LABEL = { image: 'Picture', video: 'Video', audio: 'Audio', file: 'File', scribble: 'Your scribble', link: 'Link' }

function gather(all, agent) {
  const items = []
  const add = (list, ts, where) => {
    for (const a of list ?? []) items.push({ ts, where, kind: a.kind === 'scribble' ? 'scribble' : kindOf(a), name: a.name || 'Scribble', url: a.url })
  }
  for (const m of all.messages) {
    if (m.agent !== agent) continue
    add(m.attachments, m.ts, null)
    // What the session published under a link of its own; revoked ones stay in the list, without a link.
    if (m.asset) {
      items.push({ ts: m.ts, where: m.asset.gone ? 'no longer available' : m.asset.note || null, kind: 'asset', label: ASSET_LABEL[m.asset.type] ?? 'File', name: m.asset.title || 'Untitled', url: m.asset.gone ? null : m.asset.url, key: m.asset.id })
      continue
    }
    // Other pages arrive as links in what the agent writes.
    if (m.from !== 'user' && m.from !== 'event') {
      for (const [found] of String(m.text ?? '').matchAll(LINK)) {
        const url = found.replace(/[.,;:!?`]+$/, '')
        const { asset, text } = linkInfo(url)
        // A link to something published is listed as what it is; its key is never printed.
        if (asset) items.push({ ts: m.ts, where: null, kind: 'asset', label: asset.known ? ASSET_LABEL[asset.type] ?? 'File' : 'link', name: asset.title || 'Untitled', url: asset.href, key: asset.id })
        else items.push({ ts: m.ts, where: null, kind: 'link', name: text, url })
      }
    }
  }
  for (const c of all.cards) if (c.agent === agent) add(c.attachments, c.created, c.title)
  const seen = new Set()
  return items.sort((a, b) => b.ts - a.ts).filter(i => !seen.has(i.key ?? i.url) && seen.add(i.key ?? i.url))
}

/** Render one session's files into root: one list, each line opens its item. Returns { render(state, loaded) }. */
export function mountFiles(root, { agent }) {
  let signature = null
  const heading = el('h3', 'hist-heading')
  const count = el('b')
  heading.append(el('span', null, 'Files'), count)
  const list = el('div', 'file-list')
  root.append(heading, list)

  function render(state, loaded) {
    if (!loaded) return
    const items = gather(state.all, agent)
    const next = JSON.stringify(items)
    if (next === signature) return
    signature = next
    count.textContent = items.length === 1 ? '1 item' : `${items.length} items`
    const pictures = items.filter(i => i.kind === 'image' || i.kind === 'scribble')
    list.replaceChildren(...items.map(item => {
      const visual = pictures.includes(item)
      const row = el(visual ? 'button' : item.url ? 'a' : 'div', item.url || visual ? 'file-row' : 'file-row is-gone')
      if (!item.url) {
        // revoked: nothing to open
      } else if (visual) {
        row.type = 'button'
        row.addEventListener('click', () => openLightbox(pictures, pictures.indexOf(item)))
      } else {
        row.href = item.url
        row.target = '_blank'
        row.rel = 'noopener noreferrer'
      }
      const thumb = el('span', 'file-thumb')
      if (visual) {
        const img = el('img')
        img.src = item.url
        img.alt = ''
        img.loading = 'lazy'
        img.addEventListener('error', () => img.replaceWith(icon('file')))
        thumb.append(img)
      } else thumb.append(icon(item.kind === 'link' || item.kind === 'asset' ? 'external' : 'file'))
      const meta = el('span', 'file-meta')
      meta.append(item.kind === 'asset' ? `Published ${item.label.toLowerCase()}` : KIND_LABEL[item.kind] ?? 'File', ' · ', agoNode(item.ts))
      if (item.where) meta.append(' · ', item.where)
      const text = el('span', 'file-text')
      text.append(el('strong', null, item.name), meta)
      row.append(thumb, text)
      return row
    }))
    if (!items.length) list.append(el('p', 'inbox-empty', 'This session has not sent any files yet.'))
  }
  return { render }
}
