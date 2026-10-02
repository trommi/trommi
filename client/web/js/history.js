// What lies behind a session's conversation, each as one calm list:
// the answered questions (newest first, what the agent is still working on before
// what is done; a tap unfolds what was asked, what was chosen, and the way to answer
// again), and the files: everything the session ever sent.

import { el, agoNode, kindOf, ASSET_LABEL, linkInfo } from './ui.js'
import { icon, openLightbox } from './chat.js'

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
