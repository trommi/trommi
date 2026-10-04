// ---- gallery ----
// Everything the agents sent, across sessions: one fanned pile "Media N" at the foot of the Desk, beside Notes and
// "Off the desk" (the newest pictures and videos lying fanned like prints), and the plain media gallery it leads to
// (his word of 4 October: "eine Fächerkarte, und dann kommt man in eine ganz normale Mediengalerie").
//   GET /assets          the gallery: one grid, newest first, filtered by kind (?kind=image|video|file) and session (?from=<id>)
// What counts: the assets the sessions published and the questions' own pictures and videos (one tile each per question). Files sent in
// a plain chat message are not here: they stand in their session's Files drawer (session.mjs looseFiles), which reads
// that session's conversation; an index of them across sessions would need every conversation loaded.
import { CLIENT, core, hubUrl } from './app.mjs'
import { galleryItems, html, mediaPreview, raw, smallMark } from './ui.mjs'
const KIND = { image: 'Pictures', video: 'Videos', file: 'Files' }   // Files: pages and every other file
const kindOf2 = i => (i.type === 'image' || i.type === 'video' ? i.type : 'file')
const two = n => String(n).padStart(2, '0')
const clock = ts => { const d = new Date(ts); return `${two(d.getHours())}:${two(d.getMinutes())}` }

const dayName = (ts, now = Date.now()) => {
  const d = new Date(ts), n = new Date(now)
  const days = Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5)
  return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
}
// When, short: "14:05" today, "Yesterday 14:05", else "2 Oct 14:05".
const when = ts => { if (!ts) return ''; const d = dayName(ts); return d === 'Today' ? clock(ts) : d === 'Yesterday' ? `Yesterday ${clock(ts)}` : `${new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${clock(ts)}` }

const tile = i => html`<a class="gal-tile" data-nav href="${i.href}" title="${i.title}">${mediaPreview(i, i.more > 1 ? html`<span class="gal-count">${i.more} ${i.type === 'video' ? 'videos' : 'pictures'}</span>` : '')}<span class="gal-meta"><strong>${i.title}</strong><span class="gal-sub">${smallMark(i.agent)}<span class="gal-who">${i.agent.name}</span><span class="gal-dot">·</span><span>${when(i.ts)}</span></span></span></a>`

/** The filters: kind as one segmented row, the sessions as chips with their marks. Links, so the page works without script. */
function filters(items, { kind, from }, here) {
  const q = (k, f) => { const p = new URLSearchParams(); if (k) p.set('kind', k); if (f) p.set('from', f); const s = p.toString(); return `${here}${s ? `?${s}` : ''}` }
  const count = k => items.filter(i => (!k || kindOf2(i) === k) && (!from || i.agent.id === from)).length
  const senders = [...new Map(items.map(i => [i.agent.id, i.agent])).values()]
  return html`<div class="gal-filters"><nav class="gal-seg" aria-label="Kind">${[['', 'All'], ['image', 'Pictures'], ['video', 'Videos'], ['file', 'Files']].map(([k, label]) => html`<a data-nav href="${q(k, from)}"${kind === k ? raw(' aria-current="true"') : ''}>${label}<b>${count(k)}</b></a>`)}</nav>
${senders.length > 1 ? html`<nav class="gal-chips" aria-label="Session"><a class="gal-chip gal-chip-all" data-nav href="${q(kind, '')}"${from ? '' : raw(' aria-current="true"')}><span>All sessions</span></a>${senders.map(a => html`<a class="gal-chip" data-nav href="${q(kind, from === a.id ? '' : a.id)}"${from === a.id ? raw(' aria-current="true"') : ''} style="--hue:${a.hue}">${smallMark(a)}<span>${a.name}</span></a>`)}</nav>` : ''}</div>`
}

/** The page /assets: the plain media gallery. */
function galleryMain(model, base, opts = {}) {
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

export function register(t) {
  t.get(/^\/assets$/, ({ req, res, url }) => {
    const m = t.model()
    t.page(req, res, { model: m, title: 'Media · Trommi', view: 'gallery', stream: null, bodyAttrs: ' data-page="gallery"', main: galleryMain(m, t.BASE, { kind: url.searchParams.get('kind') ?? '', from: url.searchParams.get('from') ?? '' }) })
  })
}

// ---- share view ----
// The page for people outside the room: https://app.trommi.com/a/<share_id>#<share_secret>.<file_key>.<sha256>
// (trommi-hub README, "links for people outside the room"). Everything after # stays in this browser: the secret goes
// to the hub only as the x-share-secret header, the file key never leaves the page. The hub hands out the encrypted
// bytes; they are checked against the sha256 of the link, decrypted here, and shown: a page in the sandboxed frame
// /frame.html (no origin, no network), a picture as a picture, anything else as a download.

const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n }
const kindOf = bytes => {
  const b = bytes.subarray(0, 16), head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart().toLowerCase()
  if (b[0] === 0x89 && b[1] === 0x50) return ['image', 'image/png']
  if (b[0] === 0xff && b[1] === 0xd8) return ['image', 'image/jpeg']
  if (b[0] === 0x47 && b[1] === 0x49) return ['image', 'image/gif']
  if (b[8] === 0x57 && b[9] === 0x45) return ['image', 'image/webp']
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return ['image', 'image/svg+xml']
  if (head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<')) return ['html', 'text/html']
  return ['file', 'application/octet-stream']
}
function frame(html) {
  const f = el('iframe', { className: 'share-frame', src: '/frame', title: 'Shared page' })
  f.setAttribute('sandbox', 'allow-scripts')
  addEventListener('message', function ready(e) { if (e.source === f.contentWindow && e.data === 'ready') { removeEventListener('message', ready); f.contentWindow.postMessage({ html }, '*') } })
  return f
}

export async function showShare() {
  document.title = 'Shared · Trommi'
  const main = el('main', { id: 'share', className: 'room share' })
  document.body.replaceChildren(main)
  const say = (text, cls = 'room-lead') => main.replaceChildren(el('p', { className: cls, textContent: text }))
  // (The address bar may carry ?hub=… for development; the link itself is path and fragment.)
  const link = location.origin + location.pathname + location.hash
  const { Hub, openShared, parseShareLink } = await core()
  try { parseShareLink(link) } catch { return say('This link is incomplete: the part after # is missing or damaged.', 'room-error') }
  say('Opening…', 'room-wait')
  try {
    const bytes = await openShared(new Hub({ hub_url: hubUrl(), client: CLIENT }), link)
    const [kind, type] = kindOf(bytes)
    if (kind === 'html') main.replaceChildren(frame(new TextDecoder().decode(bytes)))
    else {
      const url = URL.createObjectURL(new Blob([bytes], { type }))
      main.replaceChildren(kind === 'image' ? el('img', { className: 'share-picture', src: url, alt: 'Shared picture' }) : el('p', { className: 'room-lead' }, el('a', { href: url, download: 'trommi-file', textContent: 'Download the file' })))
    }
  } catch (err) {
    // The hub answers a missing, expired, withdrawn share and a wrong secret alike (404).
    say(err?.code === 'not-found' || err?.status === 404 ? 'This link has expired or was withdrawn.' : err?.code === 'decrypt-failed' ? 'This file does not match the link.' : `The file could not be opened: ${err.message}`, 'room-error')
  }
}
