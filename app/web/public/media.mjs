// ---- gallery ----
// Everything the agents sent, across sessions: one fanned pile "Media N" at the foot of the Desk, beside Notes and
// "Off the desk" (the newest pictures and videos lying fanned like prints), and the plain media gallery it leads to
// (his word of 4 October: "eine Fächerkarte, und dann kommt man in eine ganz normale Mediengalerie").
//   GET /assets          the gallery: one grid, newest first, filtered by kind (?kind=image|video|file) and session (?from=<id>)
// What counts: the assets the sessions published and the questions' own pictures and videos (one tile each per question). Files sent in
// a plain chat message are not here: they stand in their session's Files drawer (session.mjs looseFiles), which reads
// that session's conversation; an index of them across sessions would need every conversation loaded.
import { CLIENT, core, hubUrl } from './app.mjs'
import { Controller, agoSpan, controller, galleryItems, html, linkItems, mediaPreview, raw, shortUrl, sk, smallMark } from './ui.mjs'
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
<header class="gal-head page-head"><h2>Media</h2><p>${all.length ? 'Every picture, video and page your agents sent.' : 'Nothing yet: pictures, videos, pages and files your agents send show up here.'}</p></header>${all.length ? filters(kind, from, `${base}/assets`) : ''}
${items.length ? html`<div class="gal-grid">${items.map(tile)}</div>` : all.length ? html`<p class="gal-none">Nothing of this kind${from ? ' from this session' : ''}.</p>` : ''}
</div></main>`
}

// ---- links ----
// The page the Desk's pile "Links N" opens: every web link and page the agents gave (ui.mjs linkItems), the newest
// first, one line each: what it is, where it points, which session gave it and when, Open.
//   GET  /links          the list
//   POST /links/share    att=<attachment_id> days=1..30: a link for people outside the room; stop=<share_id>: end it
// An address outside gets Copy. A file of the room (a published page, a page behind a picture) gets Share: a switch
// that makes a share link in this browser (client.shareAttachment: the secret and the file key only after the #, the
// hub keeps the secret's hash), then the link to copy, until when it holds (7 days unless chosen, 30 at most) and
// Stop sharing. The links this device made are kept in its storage (myShares); one made elsewhere is not shown here.
const DAYS = [1, 3, 7, 14, 30]
let shares = []   // this device's open shares, newest first (loaded when the page opens and after each change)
const loadShares = async t => { try { shares = await t.hub.myShares() } catch (err) { console.warn('shares', err); shares = [] } }
const shareOf = att => (att ? shares.find(x => x.attachment_id === att && x.link && x.expires_at > Date.now()) ?? null : null)
// (an id for a line: the key made short and safe)
const rowId = key => { let h = 5381; for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) >>> 0; return `lk-${h.toString(36)}` }
const until = ts => new Date(ts).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })

function shareForm(i, base) {
  const sh = shareOf(i.att)
  if (!sh) {
    return html`<form class="lk-share" method="post" action="${base}/links/share" data-controller="lkshare"><input type="hidden" name="att" value="${i.att}">
<label class="lk-switch"><input type="checkbox" name="on" data-action="change->lkshare#flip"><span class="lk-knob" aria-hidden="true"></span><span>Share outside the room</span></label>
<label class="lk-days"><span class="offscreen">How long</span><select name="days">${DAYS.map(d => html`<option value="${d}"${d === 7 ? raw(' selected') : ''}>for ${d === 1 ? '1 day' : `${d} days`}</option>`)}</select></label>
<noscript><button type="submit" class="lk-btn">Share</button></noscript></form>`
  }
  return html`<form class="lk-share is-on" method="post" action="${base}/links/share" data-controller="lkshare"><input type="hidden" name="att" value="${i.att}"><input type="hidden" name="share" value="${sh.share_id}">
<label class="lk-switch"><input type="checkbox" name="on" checked data-action="change->lkshare#flip"><span class="lk-knob" aria-hidden="true"></span><span>Shared</span></label>
<span class="lk-until">until ${until(sh.expires_at)}</span>
<span class="lk-copy" data-controller="copy" data-copy-text-value="${sh.link}"><input class="lk-url" type="text" readonly value="${sh.link}" aria-label="The link for people outside the room" data-action="focus->lkshare#pick"><button type="button" class="lk-btn" data-action="copy#copy"><span data-copy-target="label">Copy link</span></button></span>
<button type="submit" class="lk-btn lk-stop" name="stop" value="${sh.share_id}">Stop sharing</button></form>`
}
function linkRow(i, base) {
  const own = i.kind === 'page'
  const open = own ? html`<a class="lk-btn" data-nav href="${i.href}">Open</a>` : html`<a class="lk-btn" href="${i.href}" target="_blank" rel="noopener${i.kind === 'web' ? ' noreferrer' : ''}">Open</a>`
  const title = own ? html`<a class="lk-title" data-nav href="${i.href}">${i.title}</a>` : html`<a class="lk-title" href="${i.href}" target="_blank" rel="noopener${i.kind === 'web' ? ' noreferrer' : ''}" title="${i.url}">${i.title}</a>`
  const where = i.kind !== 'web' ? i.host : i.title === shortUrl(i.url) ? i.host : shortUrl(i.url)   // (no address twice)
  return html`<li class="lk-row" id="${rowId(i.key)}" data-kind="${i.kind}"><span class="lk-glyph" aria-hidden="true">${sk(i.kind === 'web' ? 'link' : 'page')}</span>
<div class="lk-main">${title}<span class="lk-meta"><span class="lk-host">${where}</span><span class="lk-from"><span class="gal-who">${smallMark(i.agent)}</span>${i.agent.name}</span>${agoSpan(i.ts, 'ago lk-ago')}</span></div>
<div class="lk-acts">${open}${i.kind === 'web' ? html`<span data-controller="copy" data-copy-text-value="${i.url}"><button type="button" class="lk-btn" data-action="copy#copy"><span data-copy-target="label">Copy</span></button></span>` : ''}</div>
${i.att ? shareForm(i, base) : ''}</li>`
}
const linksList = (model, base) => { const all = linkItems(model, base); return html`<ol class="lk-list" id="links-list">${all.map(i => linkRow(i, base))}</ol>` }
function linksMain(model, base) {
  const n = linkItems(model, base).length
  return html`<main id="gallery" class="gal-page lk-page" aria-label="Links"><div class="gal-column lk-column">
<header class="gal-head page-head"><h2>Links</h2><p>${n ? 'Every link and page your agents gave, the newest first.' : 'Nothing yet: links and pages your agents give show up here.'}</p></header>
${linksList(model, base)}
</div></main>`
}

// The switch sends its form at once; the link's field is chosen whole when it is focused.
controller('lkshare', class extends Controller {
  flip() { this.element.classList.add('is-busy'); this.element.requestSubmit() }
  pick(event) { event.target.select() }
})

export function register(t) {
  t.get(/^\/assets$/, ({ req, res, url }) => {
    const m = t.model()
    t.page(req, res, { model: m, title: 'Media · Trommi', view: 'gallery', stream: null, bodyAttrs: ' data-page="gallery"', main: galleryMain(m, t.BASE, { kind: url.searchParams.get('kind') ?? '', from: url.searchParams.get('from') ?? '' }) })
  })
  // (the sessions' conversations are read as far as they are loaded: opening the list loads each one's newest page once)
  const asked = new Set()
  t.get(/^\/links$/, async ({ req, res }) => {
    await loadShares(t)
    for (const a of t.hub.state().agents) if (!asked.has(a.id)) { asked.add(a.id); Promise.resolve(t.hub.loadOlder?.(a.id)).catch(() => {}) }
    const m = t.model()
    t.page(req, res, { model: m, title: 'Links · Trommi', view: 'links', stream: null, bodyAttrs: ' data-page="gallery"', main: linksMain(m, t.BASE) })
  })
  t.post(/^\/links\/share$/, async ({ req, res, form }) => {
    const att = String(form.get('att') ?? ''), stop = String(form.get('stop') ?? '') || (!form.has('on') ? String(form.get('share') ?? '') : '')
    if (!/^[0-9a-f]{32}$/.test(att) || (stop && !/^[0-9a-f]{32}$/.test(stop))) { res.code = 400; return }
    let said
    try {
      if (stop) { await t.hub.stopSharing(stop, att); said = { head: 'Sharing stopped', line: 'The link opens nothing any more' } }
      else if (!shareOf(att)) { const r = await t.hub.shareFile(att, Number(form.get('days') ?? 7)); said = { head: 'Shared', line: `Anyone with the link can open it until ${until(r.expires_at)}` } }
    } catch (err) { said = { head: stop ? 'Not stopped' : 'Not shared', line: err.message, role: 'alert' } }
    await loadShares(t)
    if (!t.wantsStream(req)) return t.redirect(res, `${t.BASE}/links`)
    const m = t.model(), i = linkItems(m, t.BASE).find(x => x.att === att)
    t.sendStream(req, res, `${i ? t.stream('replace', rowId(i.key), linkRow(i, t.BASE)) : ''}${said ? t.toast(said) : ''}`)
  })
  t.live('links', {
    take: m => ({ list: linksList(m, t.BASE) }),
    diff: (was, now) => (t.differs(was.list, now.list) ? t.stream('replace', 'links-list', now.list) : ''),
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
