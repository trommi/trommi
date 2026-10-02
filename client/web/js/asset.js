// The viewer for a published asset: /a/<id>#<key>. It fetches the ciphertext,
// opens it with the key from the fragment (which the browser never sends) and
// shows it by type. It runs under the board's address, where the login cookie
// lives, so decrypted content never becomes part of this page: HTML goes into
// a sandboxed frame, everything else into an element that cannot run code.
// The format is described in server/server.mjs, above sealAsset.

const $ = id => document.getElementById(id)
const el = (tag, cls, text) => {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text != null) node.textContent = text
  return node
}

try {
  if (localStorage.getItem('agent-board-theme') === 'dark') document.documentElement.dataset.theme = 'dark'
} catch {}

const LABEL = { html: 'HTML page', image: 'Image', video: 'Video', audio: 'Audio', file: 'File' }
// Only these are handed to the browser under their own type; anything else is a download.
const SHOWN = {
  image: new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml']),
  video: new Set(['video/mp4', 'video/webm', 'video/quicktime']),
  audio: new Set(['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg', 'audio/flac']),
}

const PROBLEMS = {
  insecure: ['This link needs HTTPS or localhost', 'A browser only decrypts on a secure address. Open the link over https://, or on the machine that runs the board under http://localhost.'],
  nokey: ['The link is incomplete', 'The key is the part after the # and it is missing here. Without it nothing can be opened, by anyone. Ask for the whole link.'],
  wrongkey: ['The key does not fit', 'The part after the # was cut off or changed on its way, or the stored asset was altered. Ask for the link again.'],
  gone: ['This asset is gone', 'It was withdrawn, or deleted after its time. The link no longer opens anything.'],
  format: ['This asset cannot be read here', 'It was made in a format this viewer does not know. The board may need an update.'],
  offline: ['The board did not answer', 'The asset could not be fetched. Check the connection and load the page again.'],
}

class Problem extends Error {
  constructor(kind) {
    super(kind)
    this.kind = kind
  }
}

function showProblem(kind) {
  const [title, text] = PROBLEMS[kind] ?? PROBLEMS.offline
  document.title = `Trommi: ${title}`
  $('title').textContent = title
  $('meta').textContent = ''
  $('foot').hidden = true
  const box = el('div', 'as-problem')
  box.dataset.problem = kind
  box.append(el('p', null, text))
  $('stage').replaceChildren(box)
}

const bytesOf = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))

async function fetchBlob(id) {
  let res
  try {
    // The asset is public to whoever has the link; the login cookie has no business in this request.
    res = await fetch(`/a/${id}/blob`, { cache: 'no-store', credentials: 'omit' })
  } catch {
    throw new Problem('offline')
  }
  if (res.status === 404) throw new Problem('gone')
  if (!res.ok) throw new Problem('offline')
  return new Uint8Array(await res.arrayBuffer())
}

async function openAsset(id, keyText) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(keyText)) throw new Problem('wrongkey')
  const blob = await fetchBlob(id)
  if (new TextDecoder().decode(blob.subarray(0, 4)) !== 'ZWA1') throw new Problem('format')
  let plain
  try {
    const key = await crypto.subtle.importKey('raw', bytesOf(keyText), 'AES-GCM', false, ['decrypt'])
    // The address is part of what is authenticated: a blob moved to another id does not open.
    const additionalData = new TextEncoder().encode(`ZWA1/${id}`)
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.subarray(4, 16), additionalData }, key, blob.subarray(16)))
  } catch {
    throw new Problem('wrongkey')
  }
  const length = new DataView(plain.buffer).getUint32(0)
  const header = JSON.parse(new TextDecoder().decode(plain.subarray(4, 4 + length)))
  if (header.v !== 1) throw new Problem('format')
  // What follows the content is padding.
  return { header, content: plain.subarray(4 + length, 4 + length + header.size) }
}

const size = n => (n < 1000 ? `${n} B` : n < 1e6 ? `${Math.round(n / 1000)} kB` : `${(n / 1e6).toFixed(1)} MB`)
const fileName = name => String(name ?? '').split(/[\\/]/).pop().replace(/[^\w.\- ()äöüÄÖÜß]/g, '_').slice(0, 120) || 'asset'

// A download never carries the asset's own type, so the browser saves it instead of showing it under this address.
function download(header, content, cls = 'as-btn') {
  const link = el('a', cls, 'Download')
  link.href = URL.createObjectURL(new Blob([content], { type: 'application/octet-stream' }))
  link.download = fileName(header.name)
  return link
}

// An HTML asset may be hostile: written by an agent that read something it
// should not have believed. The frame has no origin (no allow-same-origin), so
// it cannot read this page, the key in the address or the board's cookie; its
// own policy (set by the server on /a/-/frame.html) lets its inline scripts
// and styles run and nothing be fetched. It gets the page as a message once.
function showHtml(content) {
  const frame = el('iframe', 'as-frame')
  frame.setAttribute('sandbox', 'allow-scripts')
  frame.referrerPolicy = 'no-referrer'
  frame.title = 'The published page'
  const html = new TextDecoder().decode(content)
  addEventListener('message', function ready(e) {
    if (e.source !== frame.contentWindow || e.data !== 'ready') return
    removeEventListener('message', ready)
    // The frame's origin is opaque, so there is no origin to name; the source check above is the address.
    frame.contentWindow.postMessage({ html }, '*')
  })
  frame.src = '/a/-/frame.html'
  return frame
}

function show({ header, content }) {
  const type = LABEL[header.type] ? header.type : 'file'
  const title = String(header.title || header.name || 'Asset')
  document.title = `${title} · Trommi`
  $('kind').textContent = LABEL[type]
  $('title').textContent = title
  const made = Number.isFinite(header.created) ? new Date(header.created).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''
  $('meta').replaceChildren([size(header.size), made && `published ${made}`].filter(Boolean).join(' · '), ' · ', download(header, content, 'as-link'))
  const stage = $('stage')
  stage.dataset.type = type
  if (type === 'html') {
    $('foot').textContent = 'This page was made by an agent and runs in a sandbox: it cannot reach the board, the network or the key of this link. Type nothing secret into it. Decrypted in this browser; the server stores only ciphertext.'
    return stage.replaceChildren(showHtml(content))
  }
  if (SHOWN[type]?.has(header.mime)) {
    const node = el(type === 'image' ? 'img' : type, 'as-media')
    node.src = URL.createObjectURL(new Blob([content], { type: header.mime }))
    if (type === 'image') node.alt = title
    else node.controls = true
    if (type === 'video') node.playsInline = true
    return stage.replaceChildren(node)
  }
  const box = el('div', 'as-file')
  box.append(el('p', 'as-file-name', fileName(header.name)), el('p', null, `${size(header.size)}. It is saved to this device, not opened here.`), download(header, content))
  stage.replaceChildren(box)
}

async function main() {
  const id = location.pathname.split('/')[2] ?? ''
  const key = location.hash.slice(1)
  if (!globalThis.crypto?.subtle) return showProblem('insecure')
  if (!key) return showProblem('nokey')
  try {
    show(await openAsset(id, key))
  } catch (err) {
    showProblem(err instanceof Problem ? err.kind : 'format')
  }
}

// Another link to another key in the same tab is another asset.
addEventListener('hashchange', () => location.reload())
main()
