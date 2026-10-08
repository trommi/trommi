// ---- artifacts ----
// Everything the agents made or sent, across sessions, in ONE place (his word, 8 October: Media and Pages become
// "Artifacts"): one pile "Artifacts N" at the foot of the Desk and the page it leads to, both kinds together, the newest
// first, with a small filter All · Media · Pages.
//   GET  /artifacts                  everything (?kind=media: pictures, videos, files; ?kind=pages: the pages)
//   POST /artifacts/share            att=<attachment_id> days=1..30: a link for people outside the room; stop=<share_id>: end it
// Media (ui.mjs galleryItems without its pages): the assets the sessions published and the questions' own pictures and
// videos (one tile each per question). Files sent in a plain chat message are not here: they stand in their session's
// Files drawer (session.mjs looseFiles). Pages (ui.mjs pageItems): published pages, pages sent as files, a page behind a
// picture; no foreign websites; one per file.
import { CLIENT, core, hubUrl } from './app.mjs'
import { Controller, agoSpan, artifactItems, controller, html, mediaPreview, pageItems, raw, sk, smallMark } from './ui.mjs'
const NOUN = { image: ['picture', 'pictures'], video: ['video', 'videos'], html: ['page', 'pages'], file: ['file', 'files'] }
const countOf = i => { const n = i.more ?? 1, [one, many] = NOUN[i.type] ?? NOUN.file; return `${n} ${n === 1 ? one : many}` }
// Share (a page's link icon): a switch that makes a share link in this browser (client.shareAttachment: the secret and the
// file key only after the #, the hub keeps the secret's hash), then the link to copy, until when it holds (7 days unless
// chosen, 30 at most) and Stop sharing. The links this device made are kept in its storage (myShares); one made
// elsewhere is not shown here.
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
    return html`<form class="lk-share" method="post" action="${base}/artifacts/share" data-controller="lkshare"><input type="hidden" name="att" value="${i.att}">
<label class="lk-switch"><input type="checkbox" name="on" data-action="change->lkshare#flip"><span class="lk-knob" aria-hidden="true"></span><span>Share outside the room</span></label>
<label class="lk-days"><span class="offscreen">How long</span><select name="days">${DAYS.map(d => html`<option value="${d}"${d === 7 ? raw(' selected') : ''}>for ${d === 1 ? '1 day' : `${d} days`}</option>`)}</select></label>
<noscript><button type="submit" class="lk-btn">Share</button></noscript></form>`
  }
  return html`<form class="lk-share is-on" method="post" action="${base}/artifacts/share" data-controller="lkshare"><input type="hidden" name="att" value="${i.att}"><input type="hidden" name="share" value="${sh.share_id}">
<label class="lk-switch"><input type="checkbox" name="on" checked data-action="change->lkshare#flip"><span class="lk-knob" aria-hidden="true"></span><span>Shared</span></label>
<span class="lk-until">until ${until(sh.expires_at)}</span>
<span class="lk-copy" data-controller="copy" data-copy-text-value="${sh.link}"><input class="lk-url" type="text" readonly value="${sh.link}" aria-label="The link for people outside the room" data-action="focus->lkshare#pick"><button type="button" class="lk-btn" data-action="copy#copy"><span data-copy-target="label">Copy link</span></button></span>
<button type="submit" class="lk-btn lk-stop" name="stop" value="${sh.share_id}">Stop sharing</button></form>`
}
// ---- a tile (his word, 8 October: compact, one object): the picture in a soft rounded frame, one line under it (the
// session's small drawing, the title, when, small), the actions as small round icons on the picture: Open, and on a
// page Share (a link for people outside the room, 1 to 30 days; its icon filled while a link holds). A question's
// several pictures: the first, with their count on it. ----
const pagePreview = i => (i.pic ? mediaPreview({ type: 'image', url: i.pic }) : mediaPreview({ type: 'html', url: i.url, name: i.title }))
const tileLine = (i, title) => html`<div class="art-line"><span class="gal-who" title="${i.agent.name}">${smallMark(i.agent)}</span>${title}${agoSpan(i.ts, 'ago art-ago')}</div>`
const openIcon = (go, title) => html`<a ${go('art-act')} title="Open" aria-label="Open ${title}">${sk('go')}</a>`
function mediaTile(i) {
  const go = cls => html`data-nav href="${i.href}" class="${cls}"`
  return html`<li class="art-item art-card" data-kind="media"><a ${go('art-shot')} title="${i.title} · ${i.agent.name} · ${countOf(i)}">${mediaPreview(i)}${(i.more ?? 1) > 1 ? html`<b class="art-n" aria-label="${countOf(i)}">${i.more}</b>` : ''}</a>
${tileLine(i, html`<a ${go('art-t')}>${i.title}</a>`)}<div class="art-acts">${openIcon(go, i.title)}</div></li>`
}
function pageTile(i, base) {
  const own = i.kind === 'page'
  const go = cls => (own ? html`data-nav href="${i.href}" class="${cls}"` : html`href="${i.href}" target="_blank" rel="noopener" class="${cls}"`)
  const on = Boolean(shareOf(i.att))
  return html`<li class="art-item art-card" id="${rowId(i.key)}" data-kind="pages"><a ${go('art-shot')} aria-label="Open ${i.title}">${pagePreview(i)}</a>
${tileLine(i, html`<a ${go('art-t')}>${i.title}</a>`)}<div class="art-acts">${openIcon(go, i.title)}${i.att ? html`<details class="art-share" data-controller="pops"><summary class="art-act${on ? ' is-on' : ''}" title="${on ? 'Shared: the link' : 'Share: a link for 1 to 30 days'}" aria-label="Share ${i.title}">${sk('link')}</summary><div class="art-share-body">${shareForm(i, base)}</div></details>` : ''}</div></li>`
}
// (a tile not made yet: the same size, filled when it comes near; controller "artmore")
const placeholder = at => html`<li class="art-item art-card art-ph" data-at="${at}" aria-hidden="true"><span class="art-shot"></span><div class="art-line">&nbsp;</div></li>`

/** The filter: All · Media · Pages, links (the page works without script). */
const KINDS = [['', 'All'], ['media', 'Media'], ['pages', 'Pages']]
const kindOf2 = k => (k === 'media' || k === 'pages' ? k : '')
const filters = (kind, base) => html`<nav class="art-kinds" aria-label="Kind">${KINDS.map(([k, word]) => html`<a data-nav href="${base}/artifacts${k ? `?kind=${k}` : ''}"${kind === k ? raw(' aria-current="true"') : ''}>${word}</a>`)}</nav>`
// The grid is made 25 tiles at a time (his word, 8 October): the first ones at once, the rest as empty tiles of the same
// size that are filled as they come near (controller "artmore"), so nothing jumps. A new render keeps as many made as
// were already (shown).
const STEP = 25
let shown = STEP, tileAt = () => ''
const tileOf = (x, base) => (x.kind === 'media' ? mediaTile(x.item) : pageTile(x.item, base))
const itemsOf = (model, base, kind) => artifactItems(model, base).filter(x => !kind || x.kind === kind)
function artifactsList(model, base, kind) {
  const items = itemsOf(model, base, kind)
  if (!items.length) return html`<ol class="art-grid" id="artifacts-list"><li class="gal-none">${kind === 'pages' ? 'No pages yet.' : kind === 'media' ? 'No pictures, videos or files yet.' : ''}</li></ol>`
  return html`<ol class="art-grid" id="artifacts-list" data-controller="artmore">${items.map((x, i) => (i < shown ? tileOf(x, base) : placeholder(i)))}</ol>`
}
controller('artmore', class extends Controller {
  connect() {
    this.io = new IntersectionObserver(es => { const near = es.filter(e => e.isIntersecting).map(e => Number(e.target.dataset.at)); if (near.length) this.fill(Math.min(...near)) }, { rootMargin: '600px 0px' })
    for (const ph of this.element.querySelectorAll('.art-ph')) this.io.observe(ph)
  }
  disconnect() { this.io?.disconnect() }
  fill(from) {
    const upTo = Math.max(from, shown) + STEP
    for (const ph of [...this.element.querySelectorAll('.art-ph')].filter(p => Number(p.dataset.at) < upTo)) {
      const markup = String(tileAt(Number(ph.dataset.at)))
      this.io.unobserve(ph)
      if (markup) ph.outerHTML = markup
    }
    shown = Math.max(shown, upTo)
  }
})
function artifactsMain(model, base, kind) {
  const n = artifactItems(model, base).length
  return html`<main id="gallery" class="gal-page lk-page" aria-label="Artifacts"><div class="gal-column">
<header class="gal-head page-head"><h2>Artifacts</h2><p>${n ? 'Every picture, video, file and page your agents made, the newest first.' : 'Nothing yet: pictures, videos, pages and files your agents send show up here.'}</p></header>${n ? filters(kind, base) : ''}
${n ? artifactsList(model, base, kind) : ''}
</div></main>`
}

// The switch sends its form at once; the link's field is chosen whole when it is focused.
controller('lkshare', class extends Controller {
  flip() { this.element.classList.add('is-busy'); this.element.requestSubmit() }
  pick(event) { event.target.select() }
})

const kindHere = () => kindOf2(new URLSearchParams(globalThis.location?.search ?? '').get('kind'))
export function register(t) {
  // (the sessions' conversations are read as far as they are loaded: opening the page loads each one's newest page once)
  const asked = new Set()
  t.get(/^\/artifacts$/, async ({ req, res, url }) => {
    await loadShares(t)
    for (const a of t.hub.state().agents) if (!asked.has(a.id)) { asked.add(a.id); Promise.resolve(t.hub.loadOlder?.(a.id)).catch(() => {}) }
    const m = t.model()
    shown = STEP
    t.page(req, res, { model: m, title: 'Artifacts · Trommi', view: 'artifacts', stream: null, bodyAttrs: ' data-page="gallery"', main: artifactsMain(m, t.BASE, kindOf2(url.searchParams.get('kind'))) })
  })
  t.post(/^\/artifacts\/share$/, async ({ req, res, form }) => {
    const att = String(form.get('att') ?? ''), stop = String(form.get('stop') ?? '') || (!form.has('on') ? String(form.get('share') ?? '') : '')
    if (!/^[0-9a-f]{32}$/.test(att) || (stop && !/^[0-9a-f]{32}$/.test(stop))) { res.code = 400; return }
    let said
    try {
      if (stop) { await t.hub.stopSharing(stop, att); said = { head: 'Sharing stopped', line: 'The link opens nothing any more' } }
      else if (!shareOf(att)) { const r = await t.hub.shareFile(att, Number(form.get('days') ?? 7)); said = { head: 'Shared', line: `Anyone with the link can open it until ${until(r.expires_at)}` } }
    } catch (err) { said = { head: stop ? 'Not stopped' : 'Not shared', line: err.message, role: 'alert' } }
    await loadShares(t)
    if (!t.wantsStream(req)) return t.redirect(res, `${t.BASE}/artifacts`)
    const m = t.model(), i = pageItems(m, t.BASE).find(x => x.att === att)
    t.sendStream(req, res, `${i ? t.stream('replace', rowId(i.key), pageTile(i, t.BASE)) : ''}${said ? t.toast(said) : ''}`)
  })
  tileAt = at => { const x = itemsOf(t.model(), t.BASE, kindHere())[at]; return x ? tileOf(x, t.BASE) : '' }
  t.live('artifacts', {
    take: m => ({ list: artifactsList(m, t.BASE, kindHere()) }),
    diff: (was, now) => (t.differs(was.list, now.list) ? t.stream('replace', 'artifacts-list', now.list) : ''),
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
