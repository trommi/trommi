// Everything the agents sent, across sessions: the shelf at the foot of the Desk (what came in lately, small, and
// "All N →") and the page it leads to (his picks of 4 October: the shelf, but below the cards; the page as its target).
//   GET /assets          the page: a grid by day, filtered by kind (?kind=image|html|file) and session (?from=<id>)
// What counts: the assets the sessions published and the questions' own pictures (one tile per question). Files sent in
// a plain chat message are not here: they stand in their session's Files drawer (session.mjs looseFiles), which reads
// that session's conversation; an index of them across sessions would need every conversation loaded.
import { html, raw } from './html.mjs'
import { kindOf } from './text.mjs'
import { smallMark } from './sidebar.mjs'
import { sketchSvg } from '../pen.js'

const GLYPH = {
  image: ['M4 5h16v14H4z', 'M4 16l5-5 4 4 3-3 4 4', 'M15.5 9.2a1.2 1.2 0 1 0 0-.1'],
  html: ['M3.5 5h17v14h-17z', 'M3.5 9h17', 'M6 7h.01M8.5 7h.01', 'M7 12.5h7M7 15.5h10'],
  file: ['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M9 12h6M9 15.5h6'],
}
const glyph = type => raw(`<svg viewBox="0 0 24 24" class="asset-glyph" aria-hidden="true">${(GLYPH[type] ?? GLYPH.file).map(d => `<path d="${d}"/>`).join('')}</svg>`)
const KIND = { image: 'Pictures', html: 'Pages', file: 'Files' }
const ext = name => (/\.([a-z0-9]{1,5})$/i.exec(name ?? '')?.[1] ?? '').toUpperCase()
const two = n => String(n).padStart(2, '0')
const clock = ts => { const d = new Date(ts); return `${two(d.getHours())}:${two(d.getMinutes())}` }

/** Everything received, the newest first: [{ id, type, title, agent, ts, url, name, href, from, more }]. Kept per state. */
const kept = new WeakMap()
export function galleryItems(model, base = '') {
  const { state } = model
  const hit = kept.get(state)
  if (hit && hit.base === base && hit.cards === state.cards && hit.assets === state.assets) return hit.out
  const out = []
  for (const a of state.assets ?? []) {
    const agent = model.byAgent.get(a.agent)
    if (!agent) continue
    const type = a.type === 'image' || a.type === 'html' ? a.type : 'file'
    out.push({ id: a.id, type, title: a.title || 'Untitled', agent, ts: a.created ?? 0, url: a.att?.url ?? '', name: a.att?.name ?? '', href: `${base}/s/${encodeURIComponent(agent.id)}/a/${a.id}`, from: 'published' })
  }
  for (const c of state.cards) {
    const agent = model.byAgent.get(c.agent)
    if (!agent) continue
    const pics = (c.attachments ?? []).filter(a => kindOf(a) === 'image')
    if (pics.length) out.push({ id: c.id, type: 'image', title: c.title, agent, ts: c.created ?? 0, url: pics[0].url, name: pics[0].name, href: `${base}/q/${encodeURIComponent(c.number ?? c.id)}/p/1`, from: `Nr. ${c.number}`, more: pics.length })
  }
  out.sort((x, y) => y.ts - x.ts)
  kept.set(state, { base, cards: state.cards, assets: state.assets, out })
  return out
}

const dayName = (ts, now = Date.now()) => {
  const d = new Date(ts), n = new Date(now)
  const days = Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5)
  return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
}
const byDay = items => { const g = new Map(); for (const i of items) { const k = dayName(i.ts); if (!g.has(k)) g.set(k, []); g.get(k).push(i) } return [...g] }

/** One preview, the app's own .asset-preview (a picture as itself, a page's first screen, a file by its kind). */
const preview = (i, extra = '') => i.type === 'image' && i.url
  ? html`<span class="asset-preview is-shown" data-kind="image"><img src="${i.url}" alt="" loading="lazy" decoding="async">${extra}</span>`
  : i.type === 'html' && i.url
    ? html`<span class="asset-preview" data-kind="html" data-controller="assetthumb" data-assetthumb-src-value="${i.url}">${glyph('html')}<span class="asset-page-label">Page</span>${extra}</span>`
    : html`<span class="asset-preview gal-file" data-kind="file">${glyph('file')}<b class="gal-ext">${ext(i.name) || 'FILE'}</b>${extra}</span>`

const tile = i => html`<a class="gal-tile" data-nav href="${i.href}" title="${i.title}">${preview(i, i.more > 1 ? html`<span class="gal-count">${i.more} pictures</span>` : '')}<span class="gal-meta"><strong>${i.title}</strong><span class="gal-sub">${smallMark(i.agent)}<span class="gal-who">${i.agent.name}</span><span class="gal-dot">·</span><span>${i.from === 'published' ? clock(i.ts) : i.from}</span></span></span></a>`

/** The filters: kind as one segmented row, the sessions as chips with their marks. Links, so the page works without script. */
function filters(items, { kind, from }, here) {
  const q = (k, f) => { const p = new URLSearchParams(); if (k) p.set('kind', k); if (f) p.set('from', f); const s = p.toString(); return `${here}${s ? `?${s}` : ''}` }
  const count = k => items.filter(i => (!k || i.type === k) && (!from || i.agent.id === from)).length
  const senders = [...new Map(items.map(i => [i.agent.id, i.agent])).values()]
  return html`<div class="gal-filters"><nav class="gal-seg" aria-label="Kind">${[['', 'All'], ['image', 'Pictures'], ['html', 'Pages'], ['file', 'Files']].map(([k, label]) => html`<a data-nav href="${q(k, from)}"${kind === k ? raw(' aria-current="true"') : ''}>${label}<b>${count(k)}</b></a>`)}</nav>
<nav class="gal-chips" aria-label="Session">${senders.map(a => html`<a class="gal-chip" data-nav href="${q(kind, from === a.id ? '' : a.id)}"${from === a.id ? raw(' aria-current="true"') : ''} style="--hue:${a.hue}">${smallMark(a)}<span>${a.name}</span></a>`)}</nav></div>`
}

/** The page /assets. */
export function galleryMain(model, base, opts = {}) {
  const all = galleryItems(model, base)
  const kind = KIND[opts.kind] ? opts.kind : '', from = opts.from ?? ''
  const items = all.filter(i => (!kind || i.type === kind) && (!from || i.agent.id === from))
  const sessions = new Set(all.map(i => i.agent.id)).size
  return html`<main id="gallery" class="gal-page" aria-label="Assets"><div class="gal-column">
<header class="gal-head"><h2>Assets</h2><p>${all.length ? `${all.length === 1 ? '1 thing' : `${all.length} things`} your agents sent, from ${sessions === 1 ? '1 session' : `${sessions} sessions`}. Newest first.` : 'Nothing yet: pictures, pages and files your agents send show up here.'}</p></header>
${all.length ? filters(all, { kind, from }, `${base}/assets`) : ''}
${items.length ? byDay(items).map(([day, list]) => html`<section class="gal-day"><h3>${day}<b>${list.length}</b></h3><div class="gal-grid">${list.map(tile)}</div></section>`) : all.length ? html`<p class="gal-none">Nothing of this kind from this session.</p>` : ''}
</div></main>`
}

/** The shelf at the foot of the Desk, under the cards and over the stacks: what came in since yesterday (or the last
 *  few, when nothing did), small with the sender's mark, and "All N →" to the page. Empty, it stands hidden (#desk-shelf
 *  stays for the live stream). */
const SHELF_MAX = 10, LATELY_MS = 36 * 3600e3
export function galleryShelf(model, base) {
  const all = galleryItems(model, base)
  if (!all.length) return html`<div id="desk-shelf" class="gal-shelf-at" hidden></div>`
  const recent = all.filter(i => Date.now() - i.ts < LATELY_MS)
  const show = (recent.length ? recent : all).slice(0, SHELF_MAX)
  const word = recent.length ? 'New' : 'Lately'
  return html`<div id="desk-shelf" class="gal-shelf-at"><section class="gal-shelf" aria-label="Received: ${word.toLowerCase()}"><span class="gal-shelf-word">${raw(sketchSvg('picture'))}<span>${word}<b>${recent.length || show.length}</b></span></span><div class="gal-shelf-row">${show.map(i => html`<a class="gal-shelf-item" data-nav href="${i.href}" title="${i.title} · ${i.agent.name}">${preview(i)}<span class="gal-shelf-who" style="--hue:${i.agent.hue}">${smallMark(i.agent)}</span></a>`)}</div><a class="gal-shelf-all" data-nav href="${base}/assets" title="Everything your agents sent">All ${all.length}<span aria-hidden="true">→</span></a></section></div>`
}

export function register(t) {
  t.get(/^\/assets$/, ({ req, res, url }) => {
    const m = t.model()
    t.page(req, res, { model: m, title: 'Assets · Trommi', view: 'gallery', stream: null, bodyAttrs: ' data-page="gallery"', main: galleryMain(m, t.BASE, { kind: url.searchParams.get('kind') ?? '', from: url.searchParams.get('from') ?? '' }) })
  })
}
