// Shared DOM helpers. Everything builds nodes, never HTML strings, so text
// from the agent can't inject markup.

import { htmlBlock, tidyTable, spaceTables, withoutLayouts } from './richhtml.js'

export const el = (tag, cls, text) => {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text != null) node.textContent = text
  return node
}

// ---- links ---------------------------------------------------------------------

// A link to something a session published: <board>/a/<id>#<key>. The key after the # opens it,
// so it is never printed; the link stands as a small card with the asset's title and type.
const ASSET_URL = /^(https?:\/\/[^\/\s]+)?\/a\/([A-Za-z0-9_-]{16,64})#([A-Za-z0-9_-]{43})$/
export const ASSET_LABEL = { html: 'Page', image: 'Picture', video: 'Video', audio: 'Audio', file: 'File' }
export const sizeText = n => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} kB`)

// What the board knows of its assets; app.js hands in the store's state. Without it a link is still a card, only unnamed.
let boardState = () => null
export function setAssetSource(fn) { boardState = fn }

/** What a URL points at. For one of our assets: { asset: { id, key, href, type, title, note, size, gone, known } };
 *  href is the asset under the address this page was opened at. For any other link: { text }, short enough to read. */
export function linkInfo(url) {
  const m = ASSET_URL.exec(url)
  const all = boardState()
  const record = m && all?.assets?.find(a => a.id === m[2])
  const shown = m && all?.messages?.find(x => x.asset?.id === m[2])?.asset
  // Ours if it is under this page's own address, or under another name of this board (which knows the id).
  if (m && (record || shown || !m[1] || m[1] === location.origin)) {
    // A browser decrypts only on a secure address: from a plain http page the link keeps its own https address.
    const secure = globalThis.isSecureContext || !/^https:/.test(m[1] ?? '')
    return { asset: { id: m[2], key: m[3], href: secure ? `/a/${m[2]}#${m[3]}` : `${m[1]}/a/${m[2]}#${m[3]}`, type: record?.type ?? shown?.type ?? null, title: record?.title || shown?.title || '', note: shown?.note ?? '', size: record?.size ?? shown?.size ?? 0, gone: Boolean(shown?.gone), known: Boolean(record || shown) } }
  }
  let text = url.replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/$/, '')
  if (text.length > 34) text = `${text.slice(0, 33)}…`
  return { text }
}

/** Text for one line: every link in it replaced by what it is, so no key and no long address is printed. */
export function tidyLinks(text) {
  return withoutLayouts(text).replace(/`?(https?:\/\/[^\s<>)`]+)`?/g, (_, url) => {
    const info = linkInfo(url)
    return info.asset ? `[${info.asset.title || (ASSET_LABEL[info.asset.type] ?? 'published link')}]` : info.text
  })
}

// Small pictures of image assets, opened in this page: at most a few megabytes, and only where the
// browser may decrypt (https or localhost). One per asset, kept for the life of the page.
const thumbs = new Map()   // asset id -> Promise<object URL | null>
const THUMB_MAX = 4 * 1048576
const THUMB_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'])
function thumbOf({ id, key }) {
  if (!thumbs.has(id)) thumbs.set(id, (async () => {
    try {
      const res = await fetch(`/a/${id}/blob`, { credentials: 'omit' })
      if (!res.ok) return null
      const blob = new Uint8Array(await res.arrayBuffer())
      const raw = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
      const aes = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt'])
      const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.subarray(4, 16), additionalData: new TextEncoder().encode(`ZWA1/${id}`) }, aes, blob.subarray(16)))
      const length = new DataView(plain.buffer).getUint32(0)
      const header = JSON.parse(new TextDecoder().decode(plain.subarray(4, 4 + length)))
      if (!THUMB_MIME.has(header.mime)) return null
      return URL.createObjectURL(new Blob([plain.subarray(4 + length, 4 + length + header.size)], { type: header.mime }))
    } catch {
      return null
    }
  })())
  return thumbs.get(id)
}

/** A published asset as a compact card: a small picture or a drawn sign of its kind, its type and its title.
 *  A tap opens it in a new tab. One that was withdrawn is dashed and opens nothing. */
export function assetLink(asset) {
  const node = el(asset.gone ? 'span' : 'a', asset.gone ? 'asset-link is-gone' : 'asset-link')
  if (!asset.gone) {
    node.href = asset.href
    node.target = '_blank'
    node.rel = 'noopener'
  }
  const thumb = el('span', 'asset-thumb')
  thumb.append(sketch(asset.type === 'image' ? 'picture' : asset.type === 'video' || asset.type === 'audio' ? 'play' : 'page'))
  if (asset.type === 'image' && !asset.gone && asset.size <= THUMB_MAX && globalThis.crypto?.subtle) {
    thumbOf(asset).then(src => {
      if (!src) return
      const img = el('img')
      img.alt = ''
      img.src = src
      thumb.replaceChildren(img)
    })
  }
  const kind = [asset.known ? ASSET_LABEL[asset.type] ?? 'File' : 'Published link', !asset.gone && asset.size ? sizeText(asset.size) : ''].filter(Boolean).join(' · ')
  const text = el('span', 'asset-link-text')
  text.append(el('span', 'caps', kind), el('strong', null, asset.gone ? `${asset.title || 'Untitled'}: no longer available` : asset.title || 'Open it'))
  node.append(thumb, text)
  return node
}

// Asset cards that stand inside text remember the address they were made from, so that they can be
// drawn again when the board's word on the asset changes (withdrawn, renamed, known at last).
const linkedFrom = new WeakMap()   // card node -> { url, sig }
const assetSig = a => [a.gone, a.known, a.type, a.title, a.size].join('|')

function linkNode(url) {
  const info = linkInfo(url)
  if (info.asset) {
    const node = assetLink(info.asset)
    node.dataset.assetLink = info.asset.id
    linkedFrom.set(node, { url, sig: assetSig(info.asset) })
    return node
  }
  const a = el('a', null, info.text)
  a.href = url
  a.title = url
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  return a
}

/** Draw every asset card inside text again whose asset is no longer what the card says (rich() draws a
 *  text once; an asset can be withdrawn later). Cheap when nothing changed. Returns how many were redrawn. */
export function refreshAssetLinks(root = document) {
  let redrawn = 0
  for (const node of root.querySelectorAll('[data-asset-link]')) {
    const was = linkedFrom.get(node)
    if (!was) continue
    const info = linkInfo(was.url)
    if (!info.asset || assetSig(info.asset) === was.sig) continue
    node.replaceWith(linkNode(was.url))
    redrawn++
  }
  return redrawn
}

// `__words__` is the agent's way to underline what matters: the words stand with a line drawn under
// them by hand (.rich-under). It is sparing by nature: a text that underlines more than a third of
// itself is shown plainly, without any (rich() decides and sets this before it draws).
const UNDER = /(?<![\w.])__(?=\S)([^_\n]+?)(?<=\S)__(?=$|[\s,;:!?)\]]|\.(?:\s|$))/gm
let underlining = true
function inline(parent, text) {
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(https?:\/\/[^\s<>)]+)|((?<![\w.])__(?=\S)[^_\n]+?(?<=\S)__(?=$|[\s,;:!?)\]]|\.(?:\s|$)))/gm
  let last = 0
  for (const m of text.matchAll(re)) {
    parent.append(text.slice(last, m.index))
    // An address in backticks is still a link, not a box of code.
    if (m[1] && /^`https?:\/\/[^\s`]+`$/.test(m[1])) parent.append(linkNode(m[1].slice(1, -1)))
    // A path on this board in backticks (`/designs/index.html`) opens under the address the page was opened at.
    else if (m[1] && /^`\/[\w\-./#?=&%+]+\.html?([#?][^\s`]*)?`$/.test(m[1])) {
      const a = el('a', null, m[1].slice(1, -1))
      a.href = m[1].slice(1, -1)
      a.target = '_blank'
      a.rel = 'noopener'
      parent.append(a)
    }
    else if (m[1]) parent.append(el('code', null, m[1].slice(1, -1)))
    else if (m[2]) parent.append(el('strong', null, m[2].slice(2, -2)))
    else if (m[4]) {
      if (underlining) inline(parent.appendChild(el('span', 'rich-under')), m[4].slice(2, -2))
      else inline(parent, m[4].slice(2, -2))
    }
    else {
      // What ends a sentence does not belong to the address.
      const url = m[3].replace(/[.,;:!?]+$/, '')
      parent.append(linkNode(url), m[3].slice(url.length))
    }
    last = m.index + m[0].length
  }
  parent.append(text.slice(last))
}

/** Render the light markdown agents write: paragraphs, bullet lists, **bold**,
 *  `code`, fenced code blocks, bare links. Returns a div.rich. */
export function rich(text) {
  const root = el('div', 'rich')
  const prose = String(text).replace(/```[\s\S]*?```/g, '')
  const under = [...prose.matchAll(UNDER)].reduce((n, m) => n + m[1].length, 0)
  underlining = under * 3 <= prose.replace(/\s+/g, ' ').length
  const langs = [...String(text).matchAll(/```([^\n]*)\n?/g)].map(m => m[1].trim().toLowerCase())
  String(text).split(/```[^\n]*\n?/).forEach((chunk, i) => {
    if (i % 2) {
      // A block fenced as html is a layout from the agent: shown at its place, in a frame of its own (richhtml.js).
      if (langs[i - 1] === 'html') return root.append(htmlBlock(chunk))
      const pre = el('pre')
      pre.append(el('code', null, chunk.replace(/\n$/, '')))
      return root.append(pre)
    }
    for (const block of spaceTables(chunk).split(/\n{2,}/)) {
      const lines = block.split('\n').filter(l => l.trim())
      if (!lines.length) continue
      // A table as agents write it: rows of cells between pipes, a rule of dashes under the first.
      const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
      if (lines.length > 1 && lines.every(l => /^\s*\|.*\|\s*$/.test(l)) && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[1])) {
        const table = el('table', 'rich-table')
        const fill = (row, tag, values) => { for (const v of values) inline(row.appendChild(el(tag)), v) }
        fill(table.appendChild(el('thead')).appendChild(el('tr')), 'th', cells(lines[0]))
        const body = table.appendChild(el('tbody'))
        for (const l of lines.slice(2)) fill(body.appendChild(el('tr')), 'td', cells(l))
        const wrap = el('div', 'rich-table-wrap')
        wrap.append(tidyTable(table, lines[1]))
        root.append(wrap)
      } else if (lines.every(l => /^\s*[-*]\s+/.test(l))) {
        const ul = el('ul')
        for (const l of lines) inline(ul.appendChild(el('li')), l.replace(/^\s*[-*]\s+/, ''))
        root.append(ul)
      } else {
        inline(root.appendChild(el('p')), lines.join('\n'))
      }
    }
  })
  return root
}

export const clock = ts => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

export function ago(ts) {
  const min = Math.round((Date.now() - ts) / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  if (min < 1440) return `${Math.round(min / 60)} h ago`
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

/** A span whose relative time keeps itself current. */
export function agoNode(ts, cls = 'ago') {
  const node = el('span', cls, ago(ts))
  node.dataset.ts = ts
  return node
}
setInterval(() => {
  document.querySelectorAll('[data-ts]').forEach(n => { n.textContent = ago(Number(n.dataset.ts)) })
}, 30000)

export const URGENCY_LABEL = { low: 'Whenever', normal: 'Normal', high: 'Urgent', critical: 'Blocking' }

/** Older servers only say image yes/no; newer ones name the kind. */
/** What a card says about its own history, quietly: "replaces 5 questions", "revised". Empty for most cards. */
export const cardNote = card => [card.merged_from?.length ? `replaces ${card.merged_from.length} questions` : '', card.revised ? 'revised' : ''].filter(Boolean).join(' · ')

export const kindOf = a => a.kind ?? (a.image ? 'image' : 'file')

/** Players for video and audio attachments. Returns a list of figure nodes. */
export function mediaNodes(list = []) {
  return list.filter(a => kindOf(a) === 'video' || kindOf(a) === 'audio').map(a => {
    const figure = el('figure', `media media-${kindOf(a)}`)
    const player = el(kindOf(a))
    player.src = a.url
    player.controls = true
    player.preload = 'metadata'
    if (kindOf(a) === 'video') player.playsInline = true
    figure.append(player, el('figcaption', null, a.name))
    return figure
  })
}

// ---- doodles: a hand-scribbled mark per session ------------------------------

// Small seeded generator, so a session always gets the same scribble.
function seeded(text) {
  let h = 2166136261
  for (const ch of String(text)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    return ((h ^= h >>> 16) >>> 0) / 4294967296
  }
}

// A smooth line through points, the way a pen moves: quadratic curves between midpoints.
function penPath(points, closed = false) {
  const p = closed ? [...points, points[0], points[1]] : points
  let d = `M${p[0][0].toFixed(1)} ${p[0][1].toFixed(1)}`
  for (let i = 1; i < p.length - 1; i++) {
    const mx = (p[i][0] + p[i + 1][0]) / 2, my = (p[i][1] + p[i + 1][1]) / 2
    d += ` Q${p[i][0].toFixed(1)} ${p[i][1].toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`
  }
  if (!closed) d += ` L${p.at(-1)[0].toFixed(1)} ${p.at(-1)[1].toFixed(1)}`
  return d
}

const DOODLES = [
  // burst: uneven rays from the middle
  r => {
    const n = 6 + Math.floor(r() * 4), turn = r() * Math.PI
    return Array.from({ length: n }, (_, i) => {
      const a = turn + (i / n) * Math.PI * 2 + (r() - .5) * .25, len = 7 + r() * 6, from = 1.5 + r() * 2
      return `M${(16 + Math.cos(a) * from).toFixed(1)} ${(16 + Math.sin(a) * from).toFixed(1)} L${(16 + Math.cos(a) * len).toFixed(1)} ${(16 + Math.sin(a) * len).toFixed(1)}`
    })
  },
  // spiral: wound by hand, never quite round
  r => {
    const turns = 2.2 + r() * 1.2, start = r() * 6
    return [penPath(Array.from({ length: 34 }, (_, i) => {
      const t = i / 33, a = start + t * turns * Math.PI * 2, rad = 1.5 + t * 11 + (r() - .5) * 1.1
      return [16 + Math.cos(a) * rad, 16 + Math.sin(a) * rad]
    }))]
  },
  // blob: circled twice, the passes do not line up
  r => [0, 1].map(pass => penPath(Array.from({ length: 9 }, (_, i) => {
    const a = (i / 9) * Math.PI * 2 + pass * .4, rad = 9.5 + (r() - .5) * 4 - pass * 1.5
    return [16 + Math.cos(a) * rad, 16 + Math.sin(a) * rad * .9]
  }), true)),
  // flower: loops around a point
  r => {
    const n = 4 + Math.floor(r() * 3), turn = r() * Math.PI
    return Array.from({ length: n }, (_, i) => {
      const a = turn + (i / n) * Math.PI * 2, w = .42 + r() * .12, len = 10.5 + r() * 2.5
      const tip = [16 + Math.cos(a) * len, 16 + Math.sin(a) * len]
      const l = [16 + Math.cos(a - w) * len * .72, 16 + Math.sin(a - w) * len * .72]
      const rr = [16 + Math.cos(a + w) * len * .72, 16 + Math.sin(a + w) * len * .72]
      return penPath([[16, 16], l, tip, rr, [16, 16]])
    })
  },
  // waves: three lines drawn left to right
  r => [9, 16, 23].map(y => penPath(Array.from({ length: 7 }, (_, i) => [4 + i * 4, y + (i % 2 ? -2.6 : 2.6) + (r() - .5) * 1.6]))),
  // knot: a figure that crosses itself
  r => {
    const a = 2 + Math.floor(r() * 2), b = 3, phase = r() * 3
    return [penPath(Array.from({ length: 40 }, (_, i) => {
      const t = (i / 39) * Math.PI * 2
      return [16 + Math.sin(a * t + phase) * 11 + (r() - .5) * .8, 16 + Math.sin(b * t) * 10 + (r() - .5) * .8]
    }))]
  },
  // bolt: a zigzag with weight
  r => [penPath(Array.from({ length: 6 }, (_, i) => [8 + (i % 2) * 12 + (r() - .5) * 5, 4 + i * 4.8])), penPath([[6 + r() * 3, 27], [26 - r() * 3, 27.5]])],
  // hatch: a patch shaded with quick strokes
  r => Array.from({ length: 6 }, (_, i) => `M${(5 + i * 3.6 + r()).toFixed(1)} ${(25 + r() * 2).toFixed(1)} L${(11 + i * 3.6 + r()).toFixed(1)} ${(6 + r() * 2).toFixed(1)}`),
]

// Drawings a session can be given by name, next to the eight kinds above: things one can tell apart
// at a glance. Points in the 32 box; a stroke marked straight keeps its corners, any other is drawn
// in one curve. The pen wobbles a little on every point.
const straight = points => Object.assign(points, { straight: true })
const NAMED = {
  star: [straight([[16, 4.6], [22.4, 26.2], [4.8, 12.4], [27.2, 12.2], [9.4, 26.4], [16.5, 5.2]])],
  zigzag: [straight([[4.6, 9], [10.6, 22.6], [15.6, 9.4], [21, 22.8], [27.4, 9.6]])],
  eight: [[[16, 16], [10, 9.5], [13.5, 4.5], [20, 5.6], [20.6, 11], [16, 16], [11, 21.6], [12.4, 27], [19, 27.4], [21.6, 22], [16.4, 16.2]]],
  arrow: [straight([[5.4, 26.2], [25.4, 7]]), straight([[14, 6.2], [26, 6.4], [25.6, 18.4]])],
  leaf: [[[6, 26.5], [7, 14], [15, 6.5], [26, 5.5], [25, 16], [17.5, 24], [6.5, 26.2]], straight([[6.4, 26], [19.6, 12.2]])],
  eye: [[[4, 16], [10, 9.6], [16, 8], [22, 9.6], [28, 16], [22, 22.4], [16, 24], [10, 22.4], [4.3, 16.4]], [[16, 12.4], [19.6, 16], [16, 19.6], [12.4, 16], [16.3, 12.3]]],
  key: [[[9, 5.6], [13.6, 7.6], [14.2, 12.6], [10, 15.4], [5.4, 13.4], [5, 8.4], [9.4, 5.4]], straight([[13.2, 13.4], [26.6, 26.6]]), straight([[21.2, 21.6], [24.6, 18.4]]), straight([[24.4, 24.8], [27.6, 21.6]])],
  anchor: [straight([[16, 7.6], [16.1, 27.2]]), [[16, 3.4], [18.4, 5.6], [16, 7.8], [13.6, 5.6], [16.2, 3.3]], straight([[10.4, 11.6], [21.6, 11.4]]), [[4.8, 18.4], [7.6, 24.6], [16, 27.4], [24.4, 24.6], [27.2, 18.4]]],
  kite: [straight([[16, 3.6], [25, 12.6], [16, 23.6], [7, 12.6], [16.3, 4]]), straight([[16, 4.2], [16.1, 23.4]]), [[16, 23.6], [13, 25.6], [17.6, 27], [14.4, 29.2]]],
  comb: [straight([[4.8, 8], [27.2, 8.4]]), straight([[7.4, 8.6], [7.2, 24]]), straight([[12, 8.6], [12.2, 24.6]]), straight([[16.5, 8.6], [16.3, 24]]), straight([[21, 8.6], [21.2, 24.4]]), straight([[25.4, 8.6], [25.2, 24]])],
  ladder: [straight([[10, 4], [9.4, 28]]), straight([[22, 4], [22.6, 28]]), straight([[10, 9], [22, 9.2]]), straight([[9.8, 15.6], [22.2, 15.8]]), straight([[9.6, 22.4], [22.4, 22.2]])],
  heart: [[[16, 27], [6, 17.6], [5, 10.6], [9.4, 6], [14, 7.6], [16, 11.6], [18.4, 7.6], [23, 6], [27, 10.6], [26, 17.6], [16.3, 26.6]]],
  moon: [[[20, 4.4], [11.6, 6.4], [7, 14], [9.4, 23], [18, 27.6], [25.6, 23.4], [19, 21], [15.4, 14.6], [17.4, 8], [20.4, 4.8]]],
  cloud: [[[8, 23.6], [4.4, 20], [6.4, 15], [11, 14.4], [13, 9.6], [19, 8.4], [22.6, 13], [26.6, 14.6], [27.6, 19.6], [24.4, 23.6], [8.4, 23.9]]],
  drop: [[[16, 3.8], [9.6, 15], [8.4, 21.6], [12, 26.6], [16, 27.6], [20, 26.6], [23.6, 21.6], [22.4, 15], [16.2, 4.2]]],
  flag: [straight([[8, 3.8], [8.4, 28.4]]), [[8.2, 5.6], [14, 4], [19, 8], [25.6, 6.4], [25, 16.4], [19, 18.6], [14, 14.6], [8.4, 16.6]]],
  house: [straight([[4.8, 15], [16, 5], [27.2, 15.4]]), straight([[8, 13], [8.2, 27], [24, 27.2], [23.8, 13]]), straight([[14, 27], [14.2, 19.6], [18.2, 19.4], [18, 27]])],
  tree: [straight([[16, 3.8], [6.4, 20], [25.6, 20.2], [16.4, 4.2]]), straight([[16, 20.2], [16.2, 28.6]])],
  fish: [[[4, 16], [10, 9.6], [18, 9], [23, 16], [18, 23], [10, 22.4], [4.3, 16.3]], straight([[22.6, 16], [28, 10.4], [27.6, 21.8], [22.9, 16.3]]), straight([[9.2, 14.4], [9.8, 15]])],
  bird: [[[3.8, 13.4], [7.6, 8.6], [12, 9.6], [16, 17]], [[16, 17], [20, 9.2], [24.4, 8], [28.2, 12.6]]],
  cup: [straight([[7, 9], [9, 26], [21, 26.2], [23, 9.2]]), straight([[6.4, 9], [23.6, 9.2]]), [[23, 12.4], [28, 13.6], [27.4, 19.6], [22.2, 20.6]]],
  bell: [[[6, 23.4], [9, 19.6], [9.6, 11.6], [13, 6.6], [16, 5.4], [19, 6.6], [22.4, 11.6], [23, 19.6], [26, 23.4]], straight([[5.4, 23.6], [26.6, 23.8]]), [[13.6, 26], [16, 28.2], [18.4, 26]]],
  cross: [straight([[7, 7], [25, 25.4]]), straight([[25, 6.6], [7, 25]])],
  triangle: [straight([[16, 5], [27, 26], [5, 26.4], [16.4, 5.4]])],
  square: [straight([[6.4, 6.6], [25.8, 6.2], [26, 25.6], [6.2, 26], [6.7, 6]])],
  diamond: [straight([[16, 3.8], [27, 16], [16, 28.2], [5, 16], [16.4, 4.3]]), straight([[9.4, 11.4], [22.8, 11.2]])],
  grid: [straight([[12, 4.4], [11.6, 27.6]]), straight([[21, 4.4], [20.6, 27.6]]), straight([[4.4, 12], [27.6, 11.6]]), straight([[4.4, 21], [27.6, 20.6]])],
  mountain: [straight([[3.4, 26], [12, 8], [17.6, 18], [21.6, 12.4], [28.6, 26.2]]), straight([[9.4, 13.6], [12.2, 15.6], [14.6, 12.8]])],
  umbrella: [[[4, 16.6], [7, 9.6], [16, 5.4], [25, 9.6], [28, 16.6]], straight([[4, 16.6], [28, 16.8]]), straight([[16, 5.6], [16.1, 25]]), [[16, 25], [15.4, 28], [12.6, 28.2], [12, 25.6]]],
  crown: [straight([[5, 24], [4.6, 9.6], [11, 17], [16, 7], [21, 17], [27.4, 9.6], [27, 24.2], [5.3, 24.4]])],
  flame: [[[15.6, 3.6], [15.6, 3.6], [21, 10.4], [24.4, 17.4], [22.6, 24], [16.6, 28], [10.4, 25.6], [7.8, 19.6], [9.6, 13.6], [12.6, 10.4], [15.2, 4]], [[16, 26.4], [13, 22.6], [16.2, 16.6], [16.2, 16.6], [19.2, 22.4], [16.4, 26.2]]],
  boat: [straight([[4, 19], [28, 19.2], [23.6, 26.6], [8.4, 26.4], [4.4, 19.4]]), straight([[15, 19], [15.2, 4.4]]), straight([[15.4, 5], [24, 16.4], [15.5, 16.6]])],
  // ---- the kinds of work agents do: a drawing each, so a session can wear what it is busy with ----
  browser: [straight([[4, 6], [28, 5.6], [28.2, 26], [3.8, 26.4], [4.2, 5.6]]), straight([[4.2, 11.4], [28, 11]]), straight([[7.2, 8.4], [8, 8.6]]), [[8, 18], [13, 16.4], [17.6, 19], [23.6, 17]]],
  terminal: [straight([[3.8, 6], [28, 5.8], [28.2, 26], [4, 26.2], [4, 5.6]]), straight([[8.4, 12], [13.6, 16], [8.6, 20]]), straight([[15.8, 20.6], [22.6, 20.4]])],
  database: [[[6, 9], [9, 6.4], [16, 5.4], [23, 6.4], [26, 9], [23, 11.6], [16, 12.6], [9, 11.6], [6.2, 9.3]], straight([[6, 9.4], [6.2, 23]]), straight([[26, 9.4], [25.8, 23]]), [[6.2, 23], [9, 25.8], [16, 26.8], [23, 25.8], [25.8, 23]], [[6.2, 16], [9, 18.6], [16, 19.6], [23, 18.6], [25.8, 16]]],
  phone: [straight([[10, 3.8], [22, 4], [22.4, 28], [9.8, 28.2], [10.2, 3.4]]), straight([[14.2, 7], [18, 7]]), straight([[15.6, 24.6], [16.6, 24.8]])],
  brush: [straight([[26.4, 4.4], [15, 16]]), [[15, 16], [12.2, 14.8], [10.4, 17.4], [13.2, 19.8], [16, 17.6]], [[11, 17.2], [7.2, 19.2], [6, 23], [4.2, 26.8], [9.2, 26.2], [12.8, 23.6], [13.6, 20]]],
  flask: [straight([[11, 4.4], [21, 4.2]]), straight([[12.8, 4.6], [12.8, 12]]), straight([[19.2, 4.6], [19.2, 12]]), [[12.8, 12], [9, 18.4], [6, 24], [7.6, 27.4], [16, 28], [24.4, 27.4], [26, 24], [23, 18.4], [19.2, 12]], [[9.2, 20.6], [13, 19.4], [18, 21.2], [22.8, 20]]],
  lock: [[[10.4, 14], [10.2, 9], [13, 5], [16, 4.2], [19, 5], [21.8, 9], [21.6, 14]], straight([[7, 14], [25, 13.8], [25.2, 27], [6.8, 27.2], [7.2, 13.4]]), straight([[16, 18.6], [16.1, 22.8]])],
  book: [straight([[16, 8.2], [16.2, 27]]), [[16, 8], [12, 5.8], [4.2, 6.6], [4.1, 15.6], [4, 24.6], [12, 24.4], [16, 27]], [[16, 8], [20, 5.8], [27.8, 6.6], [27.9, 15.6], [28, 24.6], [20, 24.4], [16.2, 27]]],
  rocket: [[[16, 3.2], [11.6, 9], [10.8, 16.6], [12, 22], [20, 22], [21.2, 16.6], [20.4, 9], [16.2, 3.5]], [[16, 10], [18, 12], [16, 14], [14, 12], [16.2, 9.9]], straight([[10.8, 16.6], [6.4, 23.6], [11.8, 21.4]]), straight([[21.2, 16.6], [25.6, 23.6], [20.2, 21.4]]), [[14, 24.6], [16, 29], [18, 24.6]]],
  mic: [[[16, 3.8], [12.6, 5.6], [12, 10], [12.4, 15], [16, 17.4], [19.6, 15], [20, 10], [19.4, 5.6], [16.3, 3.7]], [[8, 13.4], [9, 18.4], [12.6, 21.6], [16, 22.4], [19.4, 21.6], [23, 18.4], [24, 13.4]], straight([[16, 22.6], [16.1, 27.4]]), straight([[11.4, 27.6], [20.6, 27.4]])],
  bug: [[[16, 9], [11, 12], [10, 18], [12, 24], [16, 26], [20, 24], [22, 18], [21, 12], [16.2, 8.9]], [[12.6, 8.8], [16, 5.4], [19.4, 8.8]], straight([[16, 9.6], [16.1, 25.6]]), straight([[10.2, 14], [5, 11.4]]), straight([[9.8, 18.4], [4.4, 18.6]]), straight([[11, 22.6], [6, 26.2]]), straight([[21.8, 14], [27, 11.4]]), straight([[22.2, 18.4], [27.6, 18.6]]), straight([[21, 22.6], [26, 26.2]])],
  branch: [straight([[9, 7.6], [9.2, 24.8]]), [[9, 4], [11, 5.8], [9, 7.6], [7, 5.8], [9.2, 3.9]], [[9.2, 25], [11.2, 26.8], [9.2, 28.6], [7.2, 26.8], [9.4, 24.9]], [[23, 9], [25, 10.8], [23, 12.6], [21, 10.8], [23.2, 8.9]], [[23, 12.8], [22, 17.6], [14.6, 19], [9.6, 22.4]]],
}
const KINDS = ['burst', 'spiral', 'blob', 'flower', 'waves', 'knot', 'bolt', 'hatch']   // DOODLES, in their order
/** The drawings a session can be given: forty names. A session's mark is then "draw:<name>". */
export const DRAWINGS = [...KINDS, ...Object.keys(NAMED)]
export const drawingMark = name => `draw:${name}`
/** The drawing a mark names ("draw:rocket" -> "rocket"), or null for a seeded scribble. */
export const drawingOf = mark => { const name = /^draw:(.+)$/.exec(String(mark ?? ''))?.[1]; return DRAWINGS.includes(name) ? name : null }
// Every drawing has one colour of its own, wherever it shows: a hue, turned by the golden angle from
// one drawing to the next, so neighbours in the picker never look alike. (A session with a seeded
// scribble instead of a named drawing keeps the colour that comes from its id.) The hue is used as
// hsl(hue 62% 30%) on light and hsl(hue 70% 76%) on dark, which reads for every hue.
export const drawingHue = name => { const at = DRAWINGS.indexOf(name); return at < 0 ? null : Math.round((162 + at * 137.508) % 360) }
// What each drawing stands for, in one line: for the human who picks one, and for an agent that picks
// the one that fits its task (the hub offers this list; client/web/drawings.json is written from it
// by dev/drawings-json.mjs).
const MEANING = {
  burst: 'rays from a point: something new, a spark, a first idea',
  spiral: 'a wound line: research, going deeper into one thing',
  blob: 'a circle drawn twice: general work, a bit of everything',
  flower: 'loops round a point: polish, care for details',
  waves: 'three wavy lines: streams, data flowing, sync',
  knot: 'a line that crosses itself: a tangle to sort out, refactoring',
  bolt: 'a zigzag stroke: speed, performance',
  hatch: 'a shaded patch: filling in, bulk work',
  star: 'a star: the important one, highlights',
  zigzag: 'a zigzag: charts, metrics, ups and downs',
  eight: 'a figure eight: loops, recurring jobs, schedules',
  arrow: 'an arrow: migration, moving things from here to there',
  leaf: 'a leaf: clean-up, something small and fresh',
  eye: 'an eye: review, watching, monitoring',
  key: 'a key: access, accounts, login',
  anchor: 'an anchor: stability, infrastructure',
  kite: 'a kite: experiments, prototypes',
  comb: 'a comb: tidying, formatting, linting',
  ladder: 'a ladder: step-by-step work, upgrades',
  heart: 'a heart: the core, health checks',
  moon: 'a moon: night jobs, the dark theme',
  cloud: 'a cloud: cloud services, hosting',
  drop: 'a drop: leaks, small fixes',
  flag: 'a flag: milestones, releases, feature flags',
  house: 'a house: the home page, the main app',
  tree: 'a tree: structure, the file tree',
  fish: 'a fish: search, catching things',
  bird: 'a bird: messages, notifications',
  cup: 'a cup: slow background work, a break',
  bell: 'a bell: alerts, reminders',
  cross: 'a cross: removing, deleting',
  triangle: 'a triangle: warnings, risks',
  square: 'a square: a plain block, layout',
  diamond: 'a diamond: quality, the precious part',
  grid: 'a grid: tables, layout grids',
  mountain: 'a mountain: a big task, the long climb',
  umbrella: 'an umbrella: protection, error handling',
  crown: 'a crown: the lead, coordination',
  flame: 'a flame: urgent work, hot fixes',
  boat: 'a boat: shipping, delivery',
  browser: 'a browser window: web UI, front end',
  terminal: 'a terminal prompt: server, command line, back end',
  database: 'a database cylinder: database, storage',
  phone: 'a phone: mobile apps',
  brush: 'a brush: design, visuals',
  flask: 'a flask: tests, QA, trying things out',
  lock: 'a lock: security, encryption',
  book: 'an open book: documentation, writing',
  rocket: 'a rocket: deploy, operations, release',
  mic: 'a microphone: speech, audio',
  bug: 'a bug: bug hunting, debugging',
  branch: 'a branch: version control, merging',
}
/** Every drawing a session can wear: its name (the mark is "draw:<name>"), what it stands for, its hue. */
export const DRAWING_INFO = DRAWINGS.map(name => ({ name, meaning: MEANING[name] ?? '', hue: drawingHue(name) }))
const linePath = points => `M${points.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L')}`

/** A scribbled mark that belongs to one session. Returns an SVG element sized by CSS, drawn in currentColor.
 *  id is a seed, and the same seed always gives the same scribble; "draw:<name>" gives that drawing. */
export function doodle(id) {
  const r = seeded(id)
  const name = /^draw:(.+)$/.exec(String(id))?.[1]
  const paths = KINDS.includes(name) ? DOODLES[KINDS.indexOf(name)](r)
    : NAMED[name] ? NAMED[name].map(stroke => (stroke.straight ? linePath : penPath)(stroke.map(([x, y]) => [x + (r() - .5) * 1.1, y + (r() - .5) * 1.1])))
    : DOODLES[Math.floor(r() * DOODLES.length)](r)
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 32 32')
  svg.setAttribute('class', 'doodle')
  svg.setAttribute('aria-hidden', 'true')
  svg.style.rotate = `${Math.round((r() - .5) * 16)}deg`
  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}

/** Several sessions scribbled together as one mark: their doodles drawn over each other inside one
 *  loop that was circled by hand and does not quite close. members: [{ id, mark, hue }].
 *  Each doodle carries data-member, so a pointer can tell which one it is on. */
export function pairDoodle(members) {
  const NS = 'http://www.w3.org/2000/svg'
  const r = seeded(members.map(m => m.id).join('+'))
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 46 34')
  svg.setAttribute('class', 'pair-mark')
  svg.setAttribute('aria-hidden', 'true')
  const n = members.length
  const size = n > 2 ? .56 : .68
  members.forEach((m, i) => {
    const g = document.createElementNS(NS, 'g')
    const own = doodle(m.mark ?? m.id)
    const x = 4.5 + (n > 1 ? i * ((37 - 32 * size) / (n - 1)) : 0)
    const y = (34 - 32 * size) / 2 + (i % 2 ? 2.4 : -2.2)
    const turn = (parseFloat(own.style.rotate) || 0) + (i % 2 ? 9 : -7)
    g.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${size}) rotate(${turn} 16 16)`)
    g.dataset.member = m.id
    g.style.setProperty('--hue', m.hue)
    const hit = document.createElementNS(NS, 'rect')
    hit.setAttribute('width', '32')
    hit.setAttribute('height', '32')
    g.append(hit, ...own.childNodes)
    // A session that matters most wears its crown here too (see crown()).
    if (m.vip) {
      const top = document.createElementNS(NS, 'path')
      top.setAttribute('class', 'pair-crown')
      top.setAttribute('d', CROWN)
      top.setAttribute('transform', `rotate(${-turn} 16 16) translate(-9 -9) rotate(-17 13 9.5) scale(.86)`)
      g.append(top)
    }
    svg.append(g)
  })
  // The loop: one and a bit turns round both, starting and ending apart.
  const start = r() * 6, steps = 15
  const loop = document.createElementNS(NS, 'path')
  loop.setAttribute('class', 'pair-loop')
  loop.setAttribute('d', penPath(Array.from({ length: steps }, (_, i) => {
    const a = start + (i / (steps - 2)) * Math.PI * 2, drift = i / steps * 1.6
    return [23 + Math.cos(a) * (20.5 - drift + (r() - .5) * 1.4), 17 + Math.sin(a) * (14.5 - drift + (r() - .5) * 1.4)]
  })))
  svg.append(loop)
  return svg
}

/** A count kept the way one keeps it on paper: pen strokes, five to a gate (four upright and the fifth
 *  across them). At most `cap` strokes are drawn; what is beyond stands after them as "+15". Returns a
 *  span (.tally) holding the drawing, in currentColor; the number is its aria-label. */
export function tally(n, cap = 25) {
  const NS = 'http://www.w3.org/2000/svg'
  const r = seeded('tally')
  const shown = Math.min(n, cap), gates = Math.ceil(shown / 5)
  const svg = document.createElementNS(NS, 'svg')
  const width = Math.max(1, gates) * 34 - 6
  svg.setAttribute('viewBox', `0 0 ${width} 24`)
  svg.setAttribute('class', 'tally-mark')
  svg.setAttribute('aria-hidden', 'true')
  svg.style.width = `${width}px`
  for (let i = 0; i < shown; i++) {
    const gate = Math.floor(i / 5), at = i % 5, x0 = gate * 34 + 3
    const path = document.createElementNS(NS, 'path')
    const w = () => (r() - .5) * 1.6
    if (at < 4) { const x = x0 + at * 6.4; path.setAttribute('d', penPath([[x + w(), 3.4 + w()], [x + .6 + w() * .5, 12], [x + w(), 20.6 + w()]])) }
    else path.setAttribute('d', penPath([[x0 - 3 + w(), 17.6 + w()], [x0 + 10, 12 + w()], [x0 + 23.4 + w(), 6.2 + w()]]))
    svg.append(path)
  }
  const node = el('span', 'tally')
  node.setAttribute('role', 'img')
  node.setAttribute('aria-label', String(n))
  node.append(svg)
  if (n > shown) node.append(el('span', 'tally-more', `+${n - shown}`))
  return node
}

/** A small clock drawn by hand whose hands show how long ago something was: the long hand the minutes
 *  of the age, the short one its hours (a day once round). Returns an SVG (.age-clock), in currentColor. */
export function ageClock(ts) {
  const NS = 'http://www.w3.org/2000/svg'
  const r = seeded('age clock')
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('class', 'age-clock')
  svg.setAttribute('aria-hidden', 'true')
  const add = d => { const path = document.createElementNS(NS, 'path'); path.setAttribute('d', d); svg.append(path) }
  add(penPath(Array.from({ length: 13 }, (_, i) => { const a = 3.4 + (i / 11) * Math.PI * 2, rad = 8.6 + (r() - .5) * .9; return [12 + Math.cos(a) * rad, 12 + Math.sin(a) * rad] })))
  const min = Math.max(0, (Date.now() - ts) / 60000)
  const hand = (turn, len) => { const a = turn * Math.PI * 2 - Math.PI / 2; return `M12 12 L${(12 + Math.cos(a) * len).toFixed(1)} ${(12 + Math.sin(a) * len).toFixed(1)}` }
  add(hand((min % 60) / 60, 5.6))
  add(hand(Math.min(min / 720, 1.999) % 1, 3.6))
  return svg
}

/** The bracket drawn by hand down a run of rows that one session asked: a tall "[" with small hooks.
 *  Stretched over the height it is given (CSS: .run-bracket). seed: the session's id. */
export function runBracket(seed) {
  const NS = 'http://www.w3.org/2000/svg'
  const r = seeded(`run bracket:${seed}`)
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 10 100')
  svg.setAttribute('preserveAspectRatio', 'none')
  svg.setAttribute('class', 'run-bracket')
  svg.setAttribute('aria-hidden', 'true')
  const w = () => (r() - .5) * 1.4
  const path = document.createElementNS(NS, 'path')
  path.setAttribute('d', penPath([[9, 1.4], [4 + w(), 1.8], [3.2 + w(), 5], [3.6 + w(), 30], [3 + w(), 62], [3.4 + w(), 95], [4.2 + w(), 98.2], [9, 98.6]]))
  svg.append(path)
  return svg
}

/** The loop drawn by hand round a whole group of sessions, marks and names together: squarish, one and
 *  a bit turns, it does not close. Stretched over whatever it is put into (CSS: .group-loop).
 *  seed: the members' ids, so a group always gets the same loop. */
export function groupLoop(seed) {
  const NS = 'http://www.w3.org/2000/svg'
  const r = seeded(`group loop:${seed}`)
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 100 100')
  svg.setAttribute('preserveAspectRatio', 'none')
  svg.setAttribute('class', 'group-loop')
  svg.setAttribute('aria-hidden', 'true')
  const steps = 30, bend = v => Math.sign(v) * Math.abs(v) ** .42, start = 2.7 + r() * .5
  const path = document.createElementNS(NS, 'path')
  path.setAttribute('class', 'pair-loop')
  path.setAttribute('d', penPath(Array.from({ length: steps }, (_, i) => {
    const a = start + (i / (steps - 1)) * Math.PI * 2 * 1.07, rad = 49 - (i / steps) * 3 + (r() - .5) * 1.6
    return [50 + bend(Math.cos(a)) * rad, 50 + bend(Math.sin(a)) * rad]
  })))
  svg.append(path)
  return svg
}

// ---- the crown: a session that matters most (VIP) ---------------------------------

// Scribbled in one go, three points, the base not quite closed. It sits crooked on the corner of the
// session's mark (CSS: .crown-mark); nothing stands next to the name.
const CROWN = 'M3.6 16 L2.6 5.4 L8.7 10.6 L13 2.6 L17.5 10.4 L23.6 5 L22.3 16.2 L4.4 15.7'
/** The mark of a starred session. Returns an SVG, 26 by 19, placed and coloured by CSS. */
export function crown() {
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 26 19')
  svg.setAttribute('class', 'crown-mark')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(NS, 'path')
  path.setAttribute('d', CROWN)
  svg.append(path)
  return svg
}

// ---- sketched icons: the hand, the thumbs, later, the archive box, choose --------

// Strokes as a pen would make them, in a 24 box. Each is a list of points; the pen wobbles a little
// (seeded by the name, so an icon always looks the same) and lines neither meet nor end cleanly.
const flip = strokes => strokes.map(s => s.map(([x, y]) => [24 - x, 24 - y]))
const THUMB = [
  [[4.6, 11.2], [4.2, 19.6], [7.3, 19.9], [7.7, 11], [4.3, 10.7]],
  [[8.2, 11.4], [10, 7.6], [10.8, 3.6], [13.4, 3.9], [13, 7.4], [12.4, 9.9], [17.8, 9.6], [19.8, 10.8], [19.2, 13.4], [18.4, 16.8], [17.2, 19.8], [14, 20.1], [10.2, 19.8], [8.1, 18.9]],
  [[15.2, 13.2], [18.6, 13.3]],
  [[14.8, 16.4], [17.9, 16.6]],
]
const SKETCH = {
  yes: THUMB,
  no: flip(THUMB),
  // The first hand, kept by name for the iOS port and its fixtures; the web draws raisedHand().
  hand: [
    [[7.6, 14.6], [5.8, 12.2], [3.9, 11.4], [3.7, 13.3], [5.6, 16.2], [7.4, 19.4], [10, 21.3], [13.6, 21.4], [16.4, 19.6], [17.6, 15.4], [17.8, 8.4], [16.6, 7], [15.6, 8.6], [15.5, 11.6]],
    [[7.6, 14.2], [7.5, 6.2], [8.6, 4.8], [9.8, 6.2], [10, 11.2]],
    [[10, 11], [10.1, 4.2], [11.4, 2.7], [12.6, 4.2], [12.6, 11]],
    [[12.7, 11.2], [13, 5.2], [14.2, 4], [15.3, 5.6], [15.3, 11.8]],
  ],
  // a microphone: the head a loop that does not close, its cradle, the stand and a foot
  mic: [
    [[12.3, 3.3], [9.9, 4.4], [9.3, 7.8], [9.5, 11.4], [11.9, 13.5], [14.5, 11.7], [14.8, 7.9], [14.3, 4.7], [12.9, 3.5]],
    [[6.3, 10.4], [7, 14.1], [9.3, 16.5], [12.1, 17.2], [14.9, 16.3], [17, 13.9], [17.8, 10.2]],
    [[12.1, 17.4], [12.3, 20.7]],
    [[8.9, 20.9], [12.2, 20.6], [15.5, 21]],
  ],
  later: [[[12, 3.8], [12.3, 10], [11.9, 16.4]], [[6.6, 11.6], [12.1, 17.2], [17.4, 11.3]], [[4.6, 20.8], [12, 20.3], [19.6, 20.6]]],
  // The Focus window's composer: send is an arrow up with a kick in its shaft; explain is a question mark
  // with three short rays, an "aha" about to happen.
  send: [[[12.4, 20.4], [11.6, 15.6], [12.5, 10.4], [12, 4.6]], [[6.2, 10.4], [12, 4.2], [17.8, 10]]],
  // a playing card with two arrows chasing each other: the turn goes back to the other side
  reverse: [
    [[7.2, 3.3], [17, 3.1], [18.7, 4.9], [18.9, 19.2], [17.1, 20.9], [7, 20.7], [5.3, 19], [5.1, 5], [7.4, 3.1]],
    [[8.5, 11.6], [9.1, 8.4], [12.2, 7], [15, 8.2]], [[13, 6.1], [15.4, 8.3], [13.1, 10.2]],
    [[15.5, 12.5], [14.9, 15.7], [11.8, 17.1], [9, 15.9]], [[11, 18], [8.6, 15.8], [10.9, 13.9]],
  ],
  // a pencil, held slanted, with the line it has just drawn: scribble instead of typing
  pen: [[[5.2, 18.8], [6.2, 15], [15.6, 5.2], [17.4, 4.6], [19.4, 6.6], [18.8, 8.4], [9, 17.8], [5.4, 18.9]], [[14.2, 6.8], [17.2, 9.8]], [[11.6, 20.4], [14.4, 19.2], [16.4, 20.6], [19.4, 19.6]]],
  // three z rising, each a little larger: asleep for now
  snooze: [[[4.4, 15.6], [9, 15.3], [9.2, 15.5], [4.8, 20.2], [4.6, 20.4], [9.6, 20.1]], [[10.4, 9.6], [15.4, 9.3], [15.6, 9.5], [10.8, 14.4], [10.6, 14.6], [16, 14.2]], [[15.4, 3.4], [20.8, 3.1], [21, 3.3], [15.8, 8.6], [15.6, 8.8], [21.4, 8.4]]],
  // two question marks written by hand, no two alike: the "??" of "What??"
  q1: [[[7.4, 8.6], [8, 5.2], [11.6, 3.4], [15.4, 4.8], [16.2, 8.2], [13.4, 11.4], [11.8, 13.6], [11.9, 16.2]], [[11.8, 20.2], [12.1, 20.8]]],
  q2: [[[8.2, 7.4], [10, 4.4], [13.8, 3.8], [16.6, 6.2], [15.8, 9.8], [12.6, 12], [12, 14.4], [12.4, 16.6]], [[12.3, 20.4], [12.7, 20.9]]],
  // a clock whose rim is an arrow turning back: the earlier versions of a question
  timemachine: [[[6.2, 7.8], [9.4, 4.7], [13.8, 4.2], [17.8, 6.6], [19.6, 10.8], [18.6, 15.4], [15.2, 18.6], [10.8, 19], [7, 16.6], [5.2, 12.8]], [[3.2, 8.6], [6.3, 7.6], [7.5, 10.8]], [[12.2, 8.2], [12.1, 12.2], [15, 13.8]]],
  q3: [[[7.8, 9], [8.6, 5.6], [12, 4], [15.6, 5.2], [16, 8.6], [13, 11], [12.2, 13.4], [12, 16.4]], [[12, 20.2], [12.4, 20.9]]],
  // two hands that meet: left to the agent
  trust: [[[3.2, 9.8], [7.4, 8.8], [10.6, 10.4], [13.2, 12.8], [15.6, 14.4]], [[20.8, 9.8], [16.6, 9], [13.8, 9.8], [11.4, 12.2], [9.4, 13.8]], [[9.6, 14], [11.4, 16.6], [13.6, 16.8], [15.4, 14.6]], [[3, 7.4], [3.5, 12.2]], [[21, 7.6], [20.5, 12.2]]],
  // a sheet going into the slot, strips coming out below: thrown away
  shred: [[[3.6, 10.8], [12, 10.3], [20.4, 10.9]], [[7.4, 10], [7.6, 3.6], [16.4, 3.4], [16.6, 10]], [[8, 12.6], [7.5, 16.2], [8.3, 20.2]], [[12, 12.8], [12.4, 17], [11.8, 21]], [[16, 12.6], [16.5, 15.8], [15.8, 19.6]]],
  // a wastebasket: thrown away
  bin: [[[4.8, 7.8], [12, 7.4], [19.2, 7.9]], [[6.6, 8.4], [7.7, 20], [16.3, 20.2], [17.4, 8.2]], [[10.1, 11], [10.4, 17.2]], [[13.9, 11], [13.6, 17.2]], [[9.4, 7.2], [9.9, 4.5], [14.1, 4.3], [14.6, 7.2]]],
  // a paperclip, bent in one go: attach something
  clip: [[[15.8, 7.4], [9.6, 13.8], [8.6, 16.4], [10.2, 18.2], [12.8, 17.4], [18.8, 11.2], [19.6, 7.8], [17.4, 5.2], [14, 5.6], [6.6, 13.2], [5.2, 17.2], [7.2, 20.4], [11.2, 20.6], [17.2, 15]]],
  explain: [
    [[7.6, 9.6], [7.8, 6.4], [10.4, 4.2], [13.6, 4.4], [15.6, 6.8], [15, 9.6], [12.6, 11.6], [11.6, 13.4], [11.7, 15.6]],
    [[11.6, 19.2], [11.9, 19.7]],
    [[18.2, 3.6], [19.6, 2.2]], [[19.4, 7.4], [21.4, 7.2]], [[18.6, 11], [20.2, 12.2]],
  ],
  back: [[[12.1, 20.2], [11.8, 14], [12.2, 7.6]], [[6.6, 12.6], [12, 6.8], [17.5, 12.3]], [[4.6, 3.6], [12, 3.9], [19.5, 3.4]]],
  // a box with its lid on and a grip: put away
  archive: [
    [[3.4, 5.4], [20.6, 5.1], [20.8, 9], [3.3, 9.2], [3.5, 5]],
    [[5.2, 9.6], [5.4, 19.5], [18.8, 19.8], [19, 9.4]],
    [[9.4, 13.2], [12, 13.5], [14.8, 13.1]],
  ],
  // what a session published: a sheet with a folded corner, a picture, something to play
  page: [[[6.4, 3.6], [14.2, 3.4], [18.4, 7.8], [18.2, 20.4], [6.2, 20.6], [6.5, 3.2]], [[13.8, 3.8], [14, 8.2], [18, 8]], [[9.4, 12.2], [15, 12]], [[9.3, 15.8], [13.6, 16]]],
  picture: [[[3.8, 5.2], [20.4, 4.9], [20.6, 19], [3.6, 19.3], [3.9, 4.8]], [[5.2, 17], [9.6, 11.4], [12.6, 15], [15.2, 12.6], [19.2, 17.2]], [[15.4, 8.2], [16.4, 7.6], [16.9, 8.8], [15.8, 9.2]]],
  play: [[[3.8, 5.2], [20.4, 4.9], [20.6, 19], [3.6, 19.3], [3.9, 4.8]], [[9.8, 8.6], [15.4, 12.2], [9.9, 15.6], [9.7, 8.2]]],
  // a key: the administration opens with one of its own
  key: [[[8, 5.2], [11.6, 6.8], [12, 10.8], [8.6, 13], [5, 11.4], [4.6, 7.4], [8.3, 5]], [[11.2, 11.6], [15.4, 15.8], [19.8, 20.4]], [[15.6, 16.2], [18, 13.8]], [[18.2, 18.8], [20.6, 16.6]]],
  // scissors, open: each blade runs into its grip in one stroke, the grips are loops that do not close
  scissors: [
    [[21.4, 5.2], [16.6, 9.6], [11.4, 13.6], [8.6, 16.2], [5.6, 16], [3.8, 18.4], [5, 21], [7.8, 21.2], [9.2, 18.8], [8.2, 16.6]],
    [[21.8, 19.6], [16.4, 14.8], [11.6, 10.6], [8.8, 8], [5.8, 8.4], [3.6, 6.2], [4.6, 3.4], [7.6, 3], [9.2, 5.4], [8.4, 7.8]],
  ],
  // scissors again, for the web: the blades are two straight cuts, the grips two loops of their own
  snip: [
    [[21.4, 5.2], [9.6, 15]],
    [[21.6, 19.2], [9.6, 9]],
    [[9, 15.6], [6, 15.4], [3.8, 17.8], [4.8, 20.8], [7.8, 21.2], [9.6, 18.8], [8.6, 16]],
    [[9, 8.4], [6, 8.6], [3.8, 6.2], [4.8, 3.2], [7.8, 2.8], [9.6, 5.2], [8.6, 8]],
  ],
  // a pile that unfolds: one stroke pointing down
  unfold: [[[6.2, 9.2], [12, 15.4], [17.8, 8.8]]],
  // onward: an arrow to the right
  go: [[[4.4, 12.2], [11, 11.7], [19.2, 12.1]], [[14.2, 7], [19.6, 12], [14.4, 17.2]]],
  // the theme: a moon for the dark one, a sun for the light one
  moon: [[[15.6, 3.8], [9, 5.6], [5.4, 11.6], [7.2, 18], [13.4, 20.6], [19.6, 17.6], [14.4, 15.6], [11.6, 10.6], [13, 5.8], [15.9, 4.2]]],
  sun: [
    [[12, 7.6], [15.6, 9], [16.4, 12.4], [14.6, 15.8], [11.4, 16.4], [8.2, 14.6], [7.6, 11.2], [9.6, 8.2], [12.4, 7.5]],
    [[12, 2.4], [12.1, 4.6]], [[12, 19.4], [11.9, 21.6]], [[2.4, 12], [4.6, 12.1]], [[19.4, 12], [21.6, 11.9]],
    [[5.2, 5.4], [6.6, 6.8]], [[17.4, 17.4], [18.8, 18.8]], [[5.4, 18.8], [6.8, 17.4]], [[17.4, 6.6], [18.8, 5.2]],
  ],
  // Focus: the four corners of a frame
  frame: [[[4, 9], [4.2, 4.2], [9, 4]], [[15, 4], [19.8, 4.2], [20, 9]], [[20, 15], [19.8, 19.8], [15, 20]], [[9, 20], [4.2, 19.8], [4, 15]]],
  // help: a plain question mark
  question: [[[7.8, 9.4], [8, 6.2], [10.6, 4], [13.8, 4.2], [15.8, 6.8], [15, 9.6], [12.6, 11.6], [11.8, 13.4], [11.9, 15.6]], [[11.8, 19.2], [12.1, 19.7]]],
  // the keys: one key cap with its mark
  keycap: [[[5, 6], [12, 5.6], [19, 5.8], [19.4, 12], [19.2, 18.4], [12, 18.8], [4.8, 18.6], [4.6, 12], [5, 5.5]], [[8.6, 12.6], [12, 11.8], [15.4, 12.5]]],
  // the bar's two places: a tray for the inbox, two heads for the agents
  tray: [[[4.2, 13], [5.4, 9], [7, 5.6], [12, 5.3], [17, 5.5], [18.6, 9], [19.8, 13]], [[4, 13.2], [4.1, 16.4], [4.4, 19.4], [12, 19.7], [19.6, 19.5], [19.9, 16.4], [20, 13.2]], [[4.4, 13.2], [8.8, 13], [10, 15.8], [14, 15.8], [15.2, 13], [19.6, 13.2]]],
  heads: [
    [[9, 4.8], [11.6, 6.2], [11.8, 9.2], [9.2, 10.8], [6.6, 9.4], [6.4, 6.4], [9.3, 4.7]],
    [[3.4, 19.4], [5, 15.2], [9, 13.6], [13, 15.2], [14.6, 19.6]],
    [[15.4, 6], [17.8, 7.8], [17.2, 10.4], [15.2, 11]],
    [[16.6, 14], [19.4, 15.6], [20.6, 19.4]],
  ],
  // knuckles on a door: a fist seen from the side, and the two short strokes of its knock
  knock: [
    [[6.2, 10.4], [7.6, 7], [11, 6.2], [15, 6.6], [17.4, 9], [17.8, 13.4], [16, 17.2], [11.4, 18], [7.4, 16.6], [5.8, 13.4], [6.3, 10]],
    [[10, 6.8], [10.3, 10.6]], [[13.4, 6.6], [13.5, 10.8]],
    [[19.6, 6], [21.6, 4.2]], [[20.6, 10.2], [22.8, 9.6]],
  ],
  // a sun coming up over a line: wake a snoozed question
  wake: [[[6.2, 16.2], [7.6, 11.6], [12, 9.4], [16.4, 11.4], [17.8, 16.2]], [[3, 16.6], [12, 16.2], [21, 16.5]], [[12, 3.6], [12.1, 6.2]], [[5.4, 7.2], [7.2, 9]], [[18.6, 7], [16.9, 8.8]]],
  // a tick, made in one move: read, fine
  tick: [[[4.6, 12.8], [7.4, 15.2], [9.8, 18], [13, 12.4], [19.6, 5.6]]],
  // a small stack of cards: there are questions here
  stack: [[[4.6, 11], [12, 10.6], [19.4, 11], [19.7, 15.4], [19.4, 19.8], [12, 20.1], [4.6, 19.8], [4.3, 15.4], [4.7, 10.7]], [[5.8, 10.4], [6.6, 7.4], [12, 7], [17.4, 7.4], [18.2, 10.4]], [[7.6, 6.8], [8.6, 4.2], [12, 3.9], [15.4, 4.2], [16.4, 6.8]], [[8.6, 15.4], [12, 15.2], [15.4, 15.5]]],
  // a speech bubble with its tail: write to someone
  bubble: [[[4.4, 8.6], [6, 6.4], [12, 6], [18.2, 6.4], [19.8, 8.8], [19.6, 14.6], [17.8, 16.8], [11.6, 17], [8.4, 20.6], [8.2, 17], [5.8, 16.6], [4.3, 14.4], [4.5, 8.2]]],
  // a small desk: its top, two legs, a drawer with its knob, a sheet lying on it
  desk: [[[3, 9.5], [12, 9.1], [21, 9.5]], [[5, 9.7], [5.2, 15], [5, 20.2]], [[19, 9.7], [18.8, 15], [19, 20.2]], [[12.5, 10], [12.7, 16], [18.8, 16]], [[15.3, 13], [16.1, 13]], [[6.8, 9.2], [7.4, 5.8], [12.4, 6.4], [12.1, 9.2]]],
  // a shrug: a head, shoulders pulled up, both hands turned out
  shrug: [[[12, 2.8], [14.3, 3.8], [14.6, 6.4], [12.2, 7.8], [9.6, 6.6], [9.6, 4], [11.6, 2.9]], [[2.6, 8.4], [5.2, 11], [8.8, 11.2], [12, 10.4], [15.4, 11.2], [18.8, 10.8], [21.4, 8.2]], [[.8, 7.8], [4, 7.6]], [[20, 7.4], [23.2, 7.6]], [[9.2, 11.6], [9.6, 16], [9.2, 20.8]], [[14.8, 11.6], [14.4, 16], [14.8, 20.8]]],
  // a table: a sheet ruled into cells
  grid: [[[4, 5.6], [12, 5.3], [20, 5.6], [20.2, 12], [20, 18.6], [12, 18.8], [4.2, 18.5], [3.9, 12], [4.1, 5.3]], [[4.4, 10], [19.8, 10.2]], [[10, 5.8], [10.2, 18.4]]],
  // three options, one of them ticked
  choose: [
    [[3.6, 6.6], [5.2, 8.6], [8.4, 4.4]],
    [[11.4, 6.6], [16, 6.3], [20.6, 6.8]],
    [[4.4, 12.4], [6.4, 12.3]], [[11.2, 12.4], [15, 12.7], [19, 12.2]],
    [[4.4, 18], [6.5, 18.2]], [[11.4, 18.2], [14, 17.9], [16.8, 18.3]],
  ],
  other: [[[4.6, 8.6], [11, 8.2], [18.8, 8.7]], [[14.6, 4.8], [19.2, 8.6], [14.9, 12.2]], [[19.4, 15.6], [12, 15.9], [5.2, 15.4]], [[9.4, 11.9], [4.8, 15.5], [9.2, 19.3]]],
  // an hourglass in one go, a little sand below: whenever
  whenever: [
    [[6.4, 3.8], [17.8, 3.6], [17.4, 6.4], [12.6, 11.8], [17.6, 17.6], [18, 20.4], [6.2, 20.6], [6.5, 17.8], [11.4, 12.2], [6.6, 6.6], [6.2, 3.4]],
    [[10.4, 18.4], [12.1, 16.6], [13.8, 18.5]],
  ],
}

// Putting a question off: the one word for it everywhere (button, tag, pile), and the name of its drawing for sketch().
export const LATER_WORD = 'Snooze'
export const LATER_SKETCH = 'snooze'
// Fetching a snoozed question back: its word and its drawing (a sun coming up).
export const WAKE_WORD = 'Wake up'
export const WAKE_SKETCH = 'wake'

// An info card (something to read, nothing to decide) has two answers of the board's own.
export const ACK_WORD = 'Acknowledge'   // read and closed
export const ACK_SKETCH = 'tick'
export const WHAT_WORD = 'What??'       // ask the session to explain it; it comes back explained
export const WHAT_SKETCH = 'explain'

// Leaving a decision to the agent: the one word for it (the question window's button, the row's quiet action, the Answered pile).
export const TRUST_WORD = 'Whatever'   // decided (card Nr. 136); the server's flag is still `trust`
export const TRUST_SKETCH = 'shrug'
// Handing a question back to its session to be reworked: the word on the button, and the state of such a card.
export const HANDBACK_WORD = 'Revise'
export const HANDBACK_STATE = 'In revision'
// Throwing a question away unanswered; and the name of its drawing for sketch().
export const SHRED_WORD = 'Shred'
export const SHRED_SKETCH = 'bin'

// Going through every open question, one after the other, in the question window: the word on its button.
export const WALK_WORD = 'Next, please'   // the user's choice (card Nr. 132); the word lives here alone

// The place where everything that needs the human lies: its name (decided: Desk), and its drawing.
// Only what the human reads is called so; in the code it is still the inbox (files, classes, ids, the address "/").
export const INBOX_WORD = 'Desk'
export const INBOX_SKETCH = 'desk'

// Knocks: the questions that will not wait. An urgent one knocks, a blocking one knocks and says so.
// (The agents' side still says urgency: high | critical; only the words on screen are these.)
export const KNOCK_WORD = 'Knock'                        // urgent
export const KNOCK_BLOCKING_WORD = 'Knock! Blocking'     // blocking
export const KNOCK_PERMISSION_WORD = 'Knock! Permission' // blocking: a permission the session waits for
export const KNOCK_SKETCH = 'knock'                      // knuckles on a door
/** Is this card a knock: urgent, blocking, or a permission. */
export const isKnock = card => card.kind === 'permission' || card.urgency === 'high' || card.urgency === 'critical'
/** The word a knock wears; null for a card that is none. */
export const knockWord = card => (card.kind === 'permission' ? KNOCK_PERMISSION_WORD : card.urgency === 'critical' ? KNOCK_BLOCKING_WORD : card.urgency === 'high' ? KNOCK_WORD : null)
/** "1 knock", "3 knocks". */
export const knocksText = n => (n === 1 ? '1 knock' : `${n} knocks`)

/** An icon drawn like the session marks: a few uneven pen strokes with a little tilt. Sized and coloured by CSS. */
export function sketch(name) {
  const r = seeded(`sketch:${name}`)
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('class', 'sketch')
  svg.setAttribute('aria-hidden', 'true')
  svg.style.rotate = `${((r() - .5) * 9).toFixed(1)}deg`
  for (const stroke of SKETCH[name] ?? []) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', penPath(stroke.map(([x, y]) => [x + (r() - .5) * .7, y + (r() - .5) * .7])))
    svg.append(path)
  }
  return svg
}

// ---- the raised hand: a session that is stopped, waiting for the human ---------------

// Drawn the way one would on paper, in one go and a little too fast: up the thumb, over four
// fingers of uneven length, down the side, and the pen runs past where it began: outline and
// fingers only. Round it, with air between, a loop that was circled by hand and does not close.
// In a 32 box, the same size as the working ring.
const HAND = [
  [8.9, 22.6], [8.2, 18.4], [5.4, 15.2], [4.3, 12.5], [5.9, 12.1], [8.3, 14.6],
  [8.2, 8.2], [8.9, 6.3], [10.2, 8], [10.5, 12.6],
  [10.7, 6.3], [11.8, 4.5], [12.9, 6.4], [13, 12.5],
  [13.5, 7.4], [14.7, 6], [15.6, 7.8], [15.5, 13],
  [16.3, 10], [17.6, 9.2], [18.3, 10.9], [17.7, 15.6], [16.6, 19.8], [16.9, 23.2],
]
/** The mark of the agent's advice: a swipe of a highlighter behind the words of the option it would
 *  pick. One pass of the marker per line of the label, a little uneven, its ends slanted; it lies
 *  behind the words and never on them. This is the one place that draws it; whoever shows advice
 *  appends what this returns to the option (or to its label), and the mark finds the words by itself:
 *  the option's label (.focus-opt-label, or the option's own strong / span), else all the text of
 *  what it was put into. It measures the lines once it stands in the page and again whenever its
 *  host changes size. An option without words (a bare thumb) gets a short swipe where its word would
 *  be. Ink and strength are CSS: --advice and --marker (tokens.css); the host needs position: relative
 *  (.is-advised has it). (It was a loop round the option once: hence the name.) */
export function adviceLoop() {
  const NS = 'http://www.w3.org/2000/svg'
  const r = seeded('advice marker')
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('class', 'advice-loop advice-marker')
  svg.setAttribute('aria-hidden', 'true')
  const wobble = Array.from({ length: 24 }, () => (r() - .5) * 2.4)   // the same hand on every redraw
  const draw = () => {
    const host = svg.parentElement
    if (!host) return
    const label = host.querySelector('.focus-opt-label') ?? host.querySelector(':scope > strong, :scope > span:not(.inbox-disc)') ?? host
    // The words only: every piece of text in the label, line box by line box (a drawing in it has no line).
    const rects = []
    const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT)
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (!text.nodeValue.trim() || text.parentElement.closest('svg, kbd, .focus-sr')) continue
      const range = document.createRange()
      range.selectNodeContents(text)
      rects.push(...range.getClientRects())
    }
    const frame = svg.getBoundingClientRect()
    // in the svg's own pixels, whatever its host is scaled or turned by
    const k = (svg.clientWidth || frame.width) / (frame.width || 1) || 1
    const lines = []
    for (const b of rects) {
      if (!b.width || !b.height) continue
      const box = { x: (b.left - frame.left) * k, y: (b.top - frame.top) * k, w: b.width * k, h: b.height * k }
      const last = lines.at(-1)
      if (last && Math.abs(last.y - box.y) < 4) last.w = Math.max(last.w, box.x + box.w - last.x)
      else lines.push(box)
    }
    // No words to lie behind: a short swipe in the lower part of the tile, where its word would be.
    if (!lines.length) lines.push({ x: frame.width * k * .26, y: frame.height * k * .68, w: frame.width * k * .48, h: 16 })
    // On a tile that is filled with colour a band behind white words is only a smudge: there (the host
    // says so with --advice-under: 1, tokens.css) the mark is a light line drawn under the words instead,
    // no wider than they are, with a slight tilt.
    const under = getComputedStyle(host).getPropertyValue('--advice-under').trim() === '1'
    svg.classList.toggle('is-under', under)
    svg.replaceChildren(...lines.map((l, n) => {
      const w = i => wobble[(n * 4 + i) % wobble.length]
      const path = document.createElementNS(NS, 'path')
      if (under) {
        const y = l.y + l.h + 1.5, x0 = l.x + 1, x1 = l.x + l.w - 1
        path.setAttribute('d', penPath([[x0, y + .9 + w(0) * .2], [x0 + (x1 - x0) * .4, y - .2 + w(1) * .2], [x0 + (x1 - x0) * .75, y + .5 + w(2) * .2], [x1, y - .8 + w(3) * .2]]))
        path.style.strokeWidth = '2.4px'
      } else {
        // (kept inside its own box, so it never makes what holds it scroll sideways)
        const y = l.y + l.h * .54, x0 = Math.max(0, l.x - 4), x1 = Math.min(frame.width * k, l.x + l.w + 5)
        path.setAttribute('d', penPath([[x0, y + 1.2 + w(0) * .5], [x0 + (x1 - x0) * .35, y - .6 + w(1) * .5], [x0 + (x1 - x0) * .7, y + .8 + w(2) * .5], [x1, y - 1.2 + w(3) * .5]]))
        path.style.strokeWidth = `${(l.h * .78).toFixed(1)}px`
      }
      return path
    }))
  }
  if (typeof ResizeObserver === 'function') {
    const watch = new ResizeObserver(draw)
    queueMicrotask(() => { if (svg.parentElement) watch.observe(svg.parentElement); draw() })
  }
  return svg
}
/** The same, by the name of what it is. */
export const adviceMark = adviceLoop

/** Not in use: a small pointing hand, the old printer's sign (cuff, a thumb on top, one finger out,
 *  three curled under), drawn with the pen. It was the advice mark for an afternoon and was liked;
 *  kept for whatever it may point at next. Styles: .advice-hand in tokens.css. */
const POINTING_HAND = [
  [[2.6, 7.6], [8.8, 7.4], [11.6, 4.6], [14.4, 4], [15, 6], [13.4, 8.4], [19, 8.6], [27.4, 8.8], [29.6, 10.4], [27.6, 12.2], [20.4, 12.3], [17.6, 12.5]],
  [[17.4, 12.6], [20, 13.2], [20.4, 15.2], [17.6, 15.9], [19.4, 16.6], [19.2, 18.6], [16.8, 19], [17.6, 20], [16.6, 21.6], [13.6, 21.6], [8.6, 21], [2.4, 20.6]],
  [[5.4, 6], [5.9, 13.6], [5.5, 22.4]],
]
export function pointingHand() {
  const NS = 'http://www.w3.org/2000/svg'
  const r = seeded('advice hand')
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 2 32 22')
  svg.setAttribute('class', 'advice-hand')
  svg.setAttribute('aria-hidden', 'true')
  const strokes = POINTING_HAND.map(stroke => penPath(stroke.map(([x, y]) => [x + (r() - .5) * .5, y + (r() - .5) * .5])))
  for (const cls of ['advice-hand-paper', 'advice-hand-ink']) {
    for (const d of strokes) {
      const path = document.createElementNS(NS, 'path')
      path.setAttribute('class', cls)
      path.setAttribute('d', d)
      svg.append(path)
    }
  }
  return svg
}

/** An arrow drawn with the pen: one line through the given points (px, in the box it is drawn in), its head two
 *  short strokes at the last point. Returns the d of each stroke (line, barb, barb); another seed, another wobble.
 *  This is the mark of "the current one" (the option a picture belongs to, the option or row the keyboard is on):
 *  whoever shows it draws the strokes this returns. */
export function arrowStrokes(points, seed) {
  const r = seeded(`arrow:${seed}`)
  const last = points.length - 1
  const line = points.map(([x, y], i) => (i === 0 || i === last ? [x, y] : [x + (r() - .5) * 2.4, y + (r() - .5) * 2.4]))
  const [a, b] = points.slice(-2), dir = Math.atan2(b[1] - a[1], b[0] - a[0])
  const barb = turn => [b[0] - Math.cos(dir + turn) * 9.5 + (r() - .5) * 1.4, b[1] - Math.sin(dir + turn) * 9.5 + (r() - .5) * 1.4]
  return [penPath(line), penPath([barb(.5), [b[0] + .3, b[1]], b]), penPath([barb(-.5), b, b])]
}

/** A circle drawn by hand: one and a bit turns that drift inward and do not close. r is a seeded generator.
 *  Returns the path's d, in a 32 box. The waiting hand and the working ring stand in such a loop. */
export function loopPath(r, { rad = 14.9, drift = 1.1, jitter = .9, start = 3.6 } = {}) {
  const steps = 17
  return penPath(Array.from({ length: steps }, (_, i) => {
    const a = start + (i / (steps - 2)) * Math.PI * 2, at = rad - (i / steps) * drift + (r() - .5) * jitter
    return [16 + Math.cos(a) * at, 16 + Math.sin(a) * at * .97]
  }))
}
export const penSeed = text => seeded(text)

/** The hand alone, with no loop and no ground: a waiting session's mark in the sidebar. The same hand
 *  as raisedHand() draws, to the stroke. Returns an SVG sized by CSS, drawn in currentColor. */
export function bareHand() {
  const NS = 'http://www.w3.org/2000/svg'
  const r = seeded('raised hand')
  loopPath(r)   // the loop is drawn first there; the pen's wobble on the hand follows from it
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '6 5 16.5 22')
  svg.setAttribute('class', 'bare-hand')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(NS, 'path')
  path.setAttribute('d', penPath(HAND.map(([x, y]) => [x + 2.9 + (r() - .5) * .8, y + 1.9 + (r() - .5) * .8])))
  svg.append(path)
  return svg
}

/** A session at work: a stroke swept round by hand, heavy where the pen leads, thin where it trails,
 *  and it does not close. It goes round what stands in its middle (the count); the turning is CSS
 *  (.sweep-mark). Returns an SVG in a 32 box, drawn in currentColor. */
export function sweepMark() {
  const NS = 'http://www.w3.org/2000/svg'
  const r = seeded('sweep')
  const arc = (from, to, n) => penPath(Array.from({ length: n }, (_, i) => {
    const a = from + (i / (n - 1)) * (to - from), rad = 13.2 + (r() - .5) * 1.1
    return [16 + Math.cos(a) * rad, 16 + Math.sin(a) * rad * .96]
  }))
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 32 32')
  svg.setAttribute('class', 'sweep-mark')
  svg.setAttribute('aria-hidden', 'true')
  for (const [cls, d] of [['sweep-tail', arc(-4.1, -1.2, 9)], ['sweep-lead', arc(-1.5, -.2, 5)]]) {
    const path = document.createElementNS(NS, 'path')
    path.setAttribute('class', cls)
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}

/** The mark of a waiting session. Returns an SVG sized by CSS: the loop is filled with the element's
 *  --hand-soft and drawn, like the hand, in currentColor. */
export function raisedHand() {
  const NS = 'http://www.w3.org/2000/svg'
  const r = seeded('raised hand')
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 32 32')
  svg.setAttribute('class', 'hand-mark')
  svg.setAttribute('aria-hidden', 'true')
  const stroke = (cls, d) => {
    const path = document.createElementNS(NS, 'path')
    path.setAttribute('class', cls)
    path.setAttribute('d', d)
    svg.append(path)
  }
  stroke('hand-loop', loopPath(r))
  stroke('hand-pen', penPath(HAND.map(([x, y]) => [x + 2.9 + (r() - .5) * .8, y + 1.9 + (r() - .5) * .8])))
  return svg
}

