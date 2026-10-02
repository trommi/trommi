// Shared DOM helpers. Everything builds nodes, never HTML strings, so text
// from the agent can't inject markup.

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
  return String(text ?? '').replace(/`?(https?:\/\/[^\s<>)`]+)`?/g, (_, url) => {
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

function inline(parent, text) {
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(https?:\/\/[^\s<>)]+)/g
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
  String(text).split(/```[^\n]*\n?/).forEach((chunk, i) => {
    if (i % 2) {
      const pre = el('pre')
      pre.append(el('code', null, chunk.replace(/\n$/, '')))
      return root.append(pre)
    }
    for (const block of chunk.split(/\n{2,}/)) {
      const lines = block.split('\n').filter(l => l.trim())
      if (!lines.length) continue
      if (lines.every(l => /^\s*[-*]\s+/.test(l))) {
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
}
const KINDS = ['burst', 'spiral', 'blob', 'flower', 'waves', 'knot', 'bolt', 'hatch']   // DOODLES, in their order
/** The drawings a session can be given: forty names. A session's mark is then "draw:<name>". */
export const DRAWINGS = [...KINDS, ...Object.keys(NAMED)]
export const drawingMark = name => `draw:${name}`
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
  keycap: [[[4.6, 6], [19.2, 5.6], [19.6, 18.4], [4.4, 18.8], [4.8, 5.6]], [[9, 14.4], [12, 9], [15, 14.6]]],
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
/** The mark of the agent's advice: a loop drawn by hand round the option it would pick. This is the
 *  one place that draws it; whoever shows advice appends what this returns to the option (or to its
 *  label), so another mark can be swapped in here alone. The loop is stretched over whatever it is
 *  put into (CSS: .advice-loop), and it is squarish rather than round, so that it goes round two
 *  lines of words without running through a letter. */
export function adviceLoop() {
  const NS = 'http://www.w3.org/2000/svg'
  const r = seeded('advice')
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 100 100')
  svg.setAttribute('preserveAspectRatio', 'none')
  svg.setAttribute('class', 'advice-loop')
  svg.setAttribute('aria-hidden', 'true')
  const steps = 26, bend = v => Math.sign(v) * Math.abs(v) ** .6
  const path = document.createElementNS(NS, 'path')
  path.setAttribute('d', penPath(Array.from({ length: steps }, (_, i) => {
    const a = 3.5 + (i / (steps - 1)) * Math.PI * 2 * 1.06, rad = 49 - (i / steps) * 2.5 + (r() - .5) * 2
    return [50 + bend(Math.cos(a)) * rad, 50 + bend(Math.sin(a)) * rad]
  })))
  svg.append(path)
  return svg
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

