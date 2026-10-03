// The page a third party gets for a released asset: /r/<id>#<key>.
//
// It is everything a recipient ever loads from the hub, and it is self-contained on purpose: one page, one
// script, one stylesheet and the empty frame for HTML assets, all under /r/-/, plus the ciphertext at
// /r/<id>/blob. Nothing of the board (no script, no stylesheet, no cookie, no storage) is used, so the same
// five paths can later be served from a separate host that holds nothing but ciphertext.
//
// The format it opens is the one in asset-envelope.mjs (ZWA1). The key is the part after the # and never
// leaves the browser. An HTML asset runs in a sandboxed frame with an origin of its own that is nobody's.

export const SHARE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src blob:; media-src blob:; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

export const SHARE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>Shared with you</title>
<link rel="stylesheet" href="/r/-/view.css">
<script type="module" src="/r/-/view.js"></script>
</head>
<body>
<header>
  <p class="what">Shared with you through Trommi. Decrypted in your browser; the server holds it only encrypted.</p>
  <h1 id="title">Opening…</h1>
  <p id="meta" class="meta"></p>
</header>
<main id="stage" aria-live="polite"></main>
<noscript><p class="problem">This page decrypts in the browser and needs JavaScript.</p></noscript>
</body>
</html>
`

export const SHARE_CSS = `:root { color-scheme: light dark; --bg: #f6f5f1; --card: #fff; --ink: #1c1b19; --soft: #6b6862; --line: #dddad2; --on: #fff }
@media (prefers-color-scheme: dark) { :root { --bg: #151514; --card: #1f1e1d; --ink: #eceae5; --soft: #a19d95; --line: #35332f; --on: #151514 } }
* { box-sizing: border-box }
html, body { height: 100% }
body { margin: 0; display: flex; flex-direction: column; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif }
header { padding: 14px 16px 12px; border-bottom: 1px solid var(--line); background: var(--card) }
.what { margin: 0 0 6px; font-size: 13px; color: var(--soft) }
h1 { margin: 0; font-size: 20px; font-weight: 650; letter-spacing: -0.01em; overflow-wrap: anywhere }
.meta { margin: 2px 0 0; font-size: 14px; color: var(--soft) }
main { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center }
main[data-type="html"] { align-items: stretch }
iframe { flex: 1; width: 100%; border: 0; background: #fff }
img, video { max-width: 100%; max-height: 100%; object-fit: contain }
audio { width: min(560px, 100% - 32px) }
.box, .problem { max-width: 440px; margin: 16px; padding: 24px; border: 1px solid var(--line); border-radius: 14px; background: var(--card) }
.box p, .problem p { margin: 0 0 12px; color: var(--soft) }
.box .name { color: var(--ink); font-weight: 600; overflow-wrap: anywhere }
a { color: inherit }
a.button { display: inline-block; min-height: 44px; padding: 10px 18px; border-radius: 10px; background: var(--ink); color: var(--on); font-weight: 600; text-decoration: none }
a:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px }
`

export const SHARE_JS = `// Opens a released asset: /r/<id>#<key> (server/share-viewer.mjs).
const $ = id => document.getElementById(id)
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n }
const KIND = { html: 'Page', image: 'Image', video: 'Video', audio: 'Audio', file: 'File' }
// Only these are shown under their own type; everything else is saved, never opened here.
const SHOWN = {
  image: new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']),
  video: new Set(['video/mp4', 'video/webm', 'video/quicktime']),
  audio: new Set(['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg', 'audio/flac']),
}
const PROBLEMS = {
  insecure: ['This link needs a secure address', 'A browser only decrypts on https. Ask for the link again.'],
  nokey: ['The link is incomplete', 'The part after the # is the key, and it is missing. Ask the sender for the whole link.'],
  wrongkey: ['The key does not fit', 'The link was cut off or changed on its way. Ask the sender for it again.'],
  gone: ['This link no longer opens anything', 'It was withdrawn or has run out. Ask the sender if you still need it.'],
  busy: ['Too many requests', 'Wait a minute and load the page again.'],
  offline: ['The server did not answer', 'Check the connection and load the page again.'],
  format: ['This cannot be read here', 'It was made in a format this page does not know.'],
}
class Problem extends Error { constructor(kind) { super(kind); this.kind = kind } }
function problem(kind) {
  const [title, text] = PROBLEMS[kind] || PROBLEMS.offline
  document.title = title
  $('title').textContent = title
  $('meta').textContent = ''
  const box = el('div', 'problem')
  box.dataset.problem = kind
  box.append(el('p', null, text))
  $('stage').replaceChildren(box)
}
const bytesOf = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))

async function open(id, keyText) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(keyText)) throw new Problem('wrongkey')
  let res
  try { res = await fetch('/r/' + id + '/blob', { cache: 'no-store', credentials: 'omit' }) } catch { throw new Problem('offline') }
  if (res.status === 404) throw new Problem('gone')
  if (res.status === 429) throw new Problem('busy')
  if (!res.ok) throw new Problem('offline')
  const blob = new Uint8Array(await res.arrayBuffer())
  if (new TextDecoder().decode(blob.subarray(0, 4)) !== 'ZWA1') throw new Problem('format')
  let plain
  try {
    const key = await crypto.subtle.importKey('raw', bytesOf(keyText), 'AES-GCM', false, ['decrypt'])
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.subarray(4, 16), additionalData: new TextEncoder().encode('ZWA1/' + id) }, key, blob.subarray(16)))
  } catch { throw new Problem('wrongkey') }
  const length = new DataView(plain.buffer).getUint32(0)
  const header = JSON.parse(new TextDecoder().decode(plain.subarray(4, 4 + length)))
  if (header.v !== 1) throw new Problem('format')
  return { header, content: plain.subarray(4 + length, 4 + length + header.size) }
}

const size = n => (n < 1000 ? n + ' B' : n < 1e6 ? Math.round(n / 1000) + ' kB' : (n / 1e6).toFixed(1) + ' MB')
const fileName = name => String(name ?? '').split(/[\\\\/]/).pop().replace(/[^\\w.\\- ()]/g, '_').slice(0, 120) || 'file'
// A download never carries its own type: the browser saves it instead of showing it under this address.
function download(header, content, cls) {
  const link = el('a', cls, 'Download')
  link.href = URL.createObjectURL(new Blob([content], { type: 'application/octet-stream' }))
  link.download = fileName(header.name)
  return link
}
// The page may be hostile to its reader. The frame has an origin of its own (no allow-same-origin): it cannot
// read this page or the key, fetch anything, open windows, or leave the frame.
function page(content) {
  const frame = el('iframe')
  frame.setAttribute('sandbox', 'allow-scripts')
  frame.referrerPolicy = 'no-referrer'
  frame.title = 'The shared page'
  const html = new TextDecoder().decode(content)
  addEventListener('message', function ready(e) {
    if (e.source !== frame.contentWindow || e.data !== 'ready') return
    removeEventListener('message', ready)
    frame.contentWindow.postMessage({ html }, '*')
  })
  frame.src = '/r/-/frame.html'
  return frame
}
function show({ header, content }) {
  const type = KIND[header.type] ? header.type : 'file'
  const title = String(header.title || header.name || 'Shared file')
  document.title = title
  $('title').textContent = title
  $('meta').replaceChildren(KIND[type] + ' · ' + size(header.size) + ' · ', download(header, content))
  const stage = $('stage')
  stage.dataset.type = type
  if (type === 'html') return stage.replaceChildren(page(content))
  if (SHOWN[type] && SHOWN[type].has(header.mime)) {
    const node = el(type === 'image' ? 'img' : type)
    node.src = URL.createObjectURL(new Blob([content], { type: header.mime }))
    if (type === 'image') node.alt = title
    else node.controls = true
    if (type === 'video') node.playsInline = true
    return stage.replaceChildren(node)
  }
  const box = el('div', 'box')
  box.append(el('p', 'name', fileName(header.name)), el('p', null, size(header.size) + '. It is saved to your device, not opened here.'), download(header, content, 'button'))
  stage.replaceChildren(box)
}
async function main() {
  const id = location.pathname.split('/')[2] || ''
  const key = location.hash.slice(1)
  if (!globalThis.crypto || !crypto.subtle) return problem('insecure')
  if (!key) return problem('nokey')
  try { show(await open(id, key)) } catch (err) { problem(err instanceof Problem ? err.kind : 'format') }
}
addEventListener('hashchange', () => location.reload())
main()
`
