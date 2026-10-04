// ---- gallery ----
// Everything the agents sent, across sessions: one fanned pile "Media N" at the foot of the Desk, beside Notes and
// "Off the desk" (the newest pictures and videos lying fanned like prints), and the plain media gallery it leads to
// (his word of 4 October: "eine Fächerkarte, und dann kommt man in eine ganz normale Mediengalerie").
//   GET /assets          the gallery: one grid, newest first, filtered by kind (?kind=image|video|file) and session (?from=<id>)
// What counts: the assets the sessions published and the questions' own pictures and videos (one tile each per question). Files sent in
// a plain chat message are not here: they stand in their session's Files drawer (session.mjs looseFiles), which reads
// that session's conversation; an index of them across sessions would need every conversation loaded.
import { CLIENT, core, hubUrl } from './app.mjs'
import { galleryItems, html, mediaPreview, raw, sk, smallMark } from './ui.mjs'
const KIND = { image: 'Pictures', video: 'Videos', file: 'Files' }   // Files: pages and every other file
const kindOf2 = i => (i.type === 'image' || i.type === 'video' ? i.type : 'file')
// One tile per decision (his pick B, 4 October): its pictures as a small fanned stack in the paper look of the Desk's
// piles (up to three sheets, the first on top), the bold title under it and a faint "3 pictures"; no session, no time,
// no badge. A published asset is one sheet with its kind.
const NOUN = { image: ['picture', 'pictures'], video: ['video', 'videos'], html: ['page', 'pages'], file: ['file', 'files'] }
const countOf = i => { const n = i.more ?? 1, [one, many] = NOUN[i.type] ?? NOUN.file; return `${n} ${n === 1 ? one : many}` }
const tile = i => {
  const n = Math.min(3, i.more ?? 1)
  const sheet = k => html`<span class="gal-sheet" data-s="${k}">${k === 0 ? mediaPreview(i) : i.urls?.[k] ? mediaPreview({ ...i, url: i.urls[k] }) : ''}</span>`
  return html`<a class="gal-tile" data-nav href="${i.href}" title="${i.title} · ${i.agent.name} · ${countOf(i)}"><span class="gal-fan" aria-hidden="true">${[...Array(n).keys()].reverse().map(sheet)}</span><span class="gal-meta"><strong><span class="gal-who" title="${i.agent.name}">${smallMark(i.agent)}</span><span class="gal-t">${i.title}</span></strong></span></a>`
}

/** The filter (his word, 4 October): the kind as four small drawn buttons, no words, no counts; no filter by session
 *  (each tile shows its session's drawing). Links, so the page works without script. */
const KINDS = [['', 'stack', 'Everything'], ['image', 'picture', 'Pictures'], ['video', 'play', 'Videos'], ['file', 'page', 'Files and pages']]
function filters(kind, from, here) {
  const q = k => { const p = new URLSearchParams(); if (k) p.set('kind', k); if (from) p.set('from', from); const s = p.toString(); return `${here}${s ? `?${s}` : ''}` }
  return html`<nav class="gal-kinds" aria-label="Kind">${KINDS.map(([k, drawing, word]) => html`<a data-nav href="${q(k)}" title="${word}" aria-label="${word}"${kind === k ? raw(' aria-current="true"') : ''}>${sk(drawing)}</a>`)}</nav>`
}

/** The page /assets: the plain media gallery. */
function galleryMain(model, base, opts = {}) {
  const all = galleryItems(model, base)
  const kind = opts.kind === 'html' ? 'file' : KIND[opts.kind] ? opts.kind : '', from = opts.from ?? ''
  const items = all.filter(i => (!kind || kindOf2(i) === kind) && (!from || i.agent.id === from))
  return html`<main id="gallery" class="gal-page" aria-label="Media"><div class="gal-column">
<header class="gal-head"><h2>Media</h2>${all.length ? filters(kind, from, `${base}/assets`) : html`<p>Nothing yet: pictures, videos, pages and files your agents send show up here.</p>`}</header>
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
