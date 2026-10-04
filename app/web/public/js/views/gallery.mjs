// Everything the agents sent, across sessions: one fanned pile "Media N" at the foot of the Desk, beside Notes and
// "Off the desk" (the newest pictures and videos lying fanned like prints), and the plain media gallery it leads to
// (his word of 4 October: "eine Fächerkarte, und dann kommt man in eine ganz normale Mediengalerie").
//   GET /assets          the gallery: one grid, newest first, filtered by kind (?kind=image|video|file) and session (?from=<id>)
// What counts: the assets the sessions published and the questions' own pictures and videos (one tile each per question). Files sent in
// a plain chat message are not here: they stand in their session's Files drawer (session.mjs looseFiles), which reads
// that session's conversation; an index of them across sessions would need every conversation loaded.
import { html, raw } from './html.mjs'
import { kindOf } from './text.mjs'
import { smallMark } from './sidebar.mjs'

const GLYPH = {
  image: ['M4 5h16v14H4z', 'M4 16l5-5 4 4 3-3 4 4', 'M15.5 9.2a1.2 1.2 0 1 0 0-.1'],
  html: ['M3.5 5h17v14h-17z', 'M3.5 9h17', 'M6 7h.01M8.5 7h.01', 'M7 12.5h7M7 15.5h10'],
  file: ['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M9 12h6M9 15.5h6'],
  video: ['M4 5h16v14H4z', 'M10 9.2v5.6l4.6-2.8z'],
}
const glyph = type => raw(`<svg viewBox="0 0 24 24" class="asset-glyph" aria-hidden="true">${(GLYPH[type] ?? GLYPH.file).map(d => `<path d="${d}"/>`).join('')}</svg>`)
const KIND = { image: 'Pictures', video: 'Videos', file: 'Files' }   // Files: pages and every other file
const kindOf2 = i => (i.type === 'image' || i.type === 'video' ? i.type : 'file')
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
    const type = a.type === 'image' || a.type === 'html' || a.type === 'video' ? a.type : 'file'
    out.push({ id: a.id, type, title: a.title || 'Untitled', agent, ts: a.created ?? 0, url: a.att?.url ?? '', name: a.att?.name ?? '', href: `${base}/s/${encodeURIComponent(agent.id)}/a/${a.id}`, from: 'published' })
  }
  for (const c of state.cards) {
    const agent = model.byAgent.get(c.agent)
    if (!agent) continue
    const pics = (c.attachments ?? []).filter(a => kindOf(a) === 'image')
    if (pics.length) out.push({ id: c.id, type: 'image', title: c.title, agent, ts: c.created ?? 0, url: pics[0].url, name: pics[0].name, href: `${base}/q/${encodeURIComponent(c.number ?? c.id)}/p/1`, from: `Nr. ${c.number}`, more: pics.length })
    // Its videos stand on the card after the pictures (card.mjs cardMedia): the tile opens the card at the first one.
    const vids = (c.attachments ?? []).filter(a => kindOf(a) === 'video')
    if (vids.length) out.push({ id: `${c.id}-v`, type: 'video', title: c.title, agent, ts: c.created ?? 0, url: vids[0].url, name: vids[0].name, href: `${base}/q/${encodeURIComponent(c.number ?? c.id)}?pic=${pics.length + 1}`, from: `Nr. ${c.number}`, more: vids.length })
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
// When, short: "14:05" today, "Yesterday 14:05", else "2 Oct 14:05".
const when = ts => { if (!ts) return ''; const d = dayName(ts); return d === 'Today' ? clock(ts) : d === 'Yesterday' ? `Yesterday ${clock(ts)}` : `${new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${clock(ts)}` }

/** One preview, the app's own .asset-preview: a picture as itself, a video by its first frame with a play mark, a page by
 *  its first screen (controller "assetthumb", the drawn page until then), a file by its kind. Never an empty tile: what
 *  has no picture shows its drawn kind. */
const PLAY = raw('<span class="gal-play" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8.5 6.2v11.6L18 12z"/></svg></span>')
const preview = (i, extra = '') => i.type === 'image' && i.url
  ? html`<span class="asset-preview is-shown" data-kind="image"><img src="${i.url}" alt="" loading="lazy" decoding="async">${extra}</span>`
  : i.type === 'video' && i.url
    ? html`<span class="asset-preview is-shown gal-video" data-kind="video">${glyph('video')}<video src="${i.url}#t=0.001" muted playsinline preload="metadata" tabindex="-1" aria-hidden="true"></video>${PLAY}${extra}</span>`
    : i.type === 'html' && i.url
      ? html`<span class="asset-preview gal-page-thumb" data-kind="html" data-controller="assetthumb" data-assetthumb-src-value="${i.url}">${glyph('html')}<span class="asset-page-label">Page</span>${extra}</span>`
      : html`<span class="asset-preview gal-file" data-kind="${i.type === 'video' ? 'video' : 'file'}">${glyph(i.type === 'video' ? 'video' : i.type === 'html' ? 'html' : 'file')}<b class="gal-ext">${ext(i.name) || (i.type === 'video' ? 'VIDEO' : i.type === 'html' ? 'PAGE' : 'FILE')}</b>${extra}</span>`

const tile = i => html`<a class="gal-tile" data-nav href="${i.href}" title="${i.title}">${preview(i, i.more > 1 ? html`<span class="gal-count">${i.more} ${i.type === 'video' ? 'videos' : 'pictures'}</span>` : '')}<span class="gal-meta"><strong>${i.title}</strong><span class="gal-sub">${smallMark(i.agent)}<span class="gal-who">${i.agent.name}</span><span class="gal-dot">·</span><span>${when(i.ts)}</span></span></span></a>`

/** The filters: kind as one segmented row, the sessions as chips with their marks. Links, so the page works without script. */
function filters(items, { kind, from }, here) {
  const q = (k, f) => { const p = new URLSearchParams(); if (k) p.set('kind', k); if (f) p.set('from', f); const s = p.toString(); return `${here}${s ? `?${s}` : ''}` }
  const count = k => items.filter(i => (!k || kindOf2(i) === k) && (!from || i.agent.id === from)).length
  const senders = [...new Map(items.map(i => [i.agent.id, i.agent])).values()]
  return html`<div class="gal-filters"><nav class="gal-seg" aria-label="Kind">${[['', 'All'], ['image', 'Pictures'], ['video', 'Videos'], ['file', 'Files']].map(([k, label]) => html`<a data-nav href="${q(k, from)}"${kind === k ? raw(' aria-current="true"') : ''}>${label}<b>${count(k)}</b></a>`)}</nav>
${senders.length > 1 ? html`<nav class="gal-chips" aria-label="Session"><a class="gal-chip gal-chip-all" data-nav href="${q(kind, '')}"${from ? '' : raw(' aria-current="true"')}><span>All sessions</span></a>${senders.map(a => html`<a class="gal-chip" data-nav href="${q(kind, from === a.id ? '' : a.id)}"${from === a.id ? raw(' aria-current="true"') : ''} style="--hue:${a.hue}">${smallMark(a)}<span>${a.name}</span></a>`)}</nav>` : ''}</div>`
}

/** The page /assets: the plain media gallery. */
export function galleryMain(model, base, opts = {}) {
  const all = galleryItems(model, base)
  const kind = opts.kind === 'html' ? 'file' : KIND[opts.kind] ? opts.kind : '', from = opts.from ?? ''
  const items = all.filter(i => (!kind || kindOf2(i) === kind) && (!from || i.agent.id === from))
  const sessions = new Set(all.map(i => i.agent.id)).size
  return html`<main id="gallery" class="gal-page" aria-label="Media"><div class="gal-column">
<header class="gal-head"><h2>Media</h2><p>${all.length ? `${all.length === 1 ? '1 thing' : `${all.length} things`} your agents sent, from ${sessions === 1 ? '1 session' : `${sessions} sessions`}. Newest first.` : 'Nothing yet: pictures, videos, pages and files your agents send show up here.'}</p></header>
${all.length ? filters(all, { kind, from }, `${base}/assets`) : ''}
${items.length ? html`<div class="gal-grid">${items.map(tile)}</div>` : all.length ? html`<p class="gal-none">Nothing of this kind${from ? ' from this session' : ''}.</p>` : ''}
</div></main>`
}

/** The pile "Media N" at the foot of the Desk (in #desk-stacks, beside Notes and "Off the desk"; views/stacks.mjs): the
 *  newest pictures and videos fanned like prints, the newest on top; a click opens the gallery. Without any it is not
 *  there. (Pages and files only, no picture: their drawn kinds lie fanned instead.) */
const FAN_MAX = 4
export function mediaPile(model, base) {
  const all = galleryItems(model, base)
  if (!all.length) return ''
  const media = all.filter(i => (i.type === 'image' || i.type === 'video') && i.url)
  const fan = (media.length ? media : all).slice(0, FAN_MAX)
  const pics = all.filter(i => i.type === 'image').length, vids = all.filter(i => i.type === 'video').length
  const name = `Media, ${all.length === 1 ? '1 thing' : `${all.length} things`}${pics || vids ? ` (${[pics && `${pics} pictures`, vids && `${vids} videos`].filter(Boolean).join(', ')})` : ''}: open the gallery`
  return html`<a class="media-pile" id="desk-media" data-nav href="${base}/assets" aria-label="${name}" title="All pictures, videos and files your agents sent"><span class="off-label">Media <span class="off-count">${all.length}</span></span><span class="media-fan" style="--n:${fan.length}" aria-hidden="true">${fan.map((i, at) => html`<span class="media-sheet" style="--i:${at}">${preview(i)}</span>`)}</span></a>`
}

export function register(t) {
  t.get(/^\/assets$/, ({ req, res, url }) => {
    const m = t.model()
    t.page(req, res, { model: m, title: 'Media · Trommi', view: 'gallery', stream: null, bodyAttrs: ' data-page="gallery"', main: galleryMain(m, t.BASE, { kind: url.searchParams.get('kind') ?? '', from: url.searchParams.get('from') ?? '' }) })
  })
}
