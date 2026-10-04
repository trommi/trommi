// Attachments are end-to-end encrypted: the views render them at /att/<attachment_id> and the bytes are fetched and
// decrypted only when the browser asks for them (a picture coming into view, a click on a file). The service worker
// (public/sw.js) forwards such a request here; before it controls the page (the very first load) a picture that fails
// to load is filled in from here directly.
const refs = new Map()       // attachment_id -> the README attachment reference (with file_key), from the model
const blobs = new Map()      // attachment_id -> Promise<Blob>, kept while the page lives
let client = null
export function rememberRef(ref) { if (ref?.attachment_id && !ref.url) refs.set(ref.attachment_id, ref) }
export function attachTo(c) { client = c }
/** A Blob (or File) as an encrypted attachment of the room; pictures carry their size. Returns the README reference. */
export async function uploadFile(c, blob, { file_name, media_type, object_id }) {
  const meta = { file_name, media_type, object_id }
  if (media_type.startsWith('image/')) { try { const b = await createImageBitmap(blob); meta.width = b.width; meta.height = b.height; b.close() } catch {} }
  return c.uploadAttachment(new Uint8Array(await blob.arrayBuffer()), meta)
}
const blobOf = id => {
  if (!blobs.has(id)) {
    const ref = refs.get(id)
    if (!ref || !client) return Promise.resolve(null)
    blobs.set(id, client.attachmentBlob(ref).catch(err => { blobs.delete(id); console.warn('attachment', id, err.message); return null }))
  }
  return blobs.get(id)
}
navigator.serviceWorker?.addEventListener('message', async e => {
  if (e.data?.type !== 'trommi-att') return
  const ref = refs.get(e.data.id)
  const blob = await blobOf(e.data.id)
  e.ports[0]?.postMessage(blob ? { blob, type: ref?.media_type, name: ref?.file_name } : null)
})
// Without the service worker in control: fill a picture in when it fails.
document.addEventListener('error', async e => {
  const el = e.target
  if (!(el instanceof HTMLImageElement || el instanceof HTMLMediaElement)) return
  const m = /\/att\/([0-9a-f]{32})$/.exec(el.getAttribute('src') ?? '')
  if (!m || el.dataset.attTried) return
  el.dataset.attTried = '1'
  const blob = await blobOf(m[1])
  if (blob) { el.removeAttribute('srcset'); el.src = URL.createObjectURL(blob); return }
  // Gone from the hub (after 30 days, or evicted for the room's quota): said in place of the picture.
  const gone = document.createElement('span')
  gone.className = 'att-gone'
  gone.textContent = 'Attachment no longer available'
  el.replaceWith(gone)
}, true)
document.addEventListener('click', async e => {
  const a = e.target instanceof Element ? e.target.closest('a[href^="/att/"]') : null
  if (!a || navigator.serviceWorker?.controller) return
  e.preventDefault()
  const id = a.getAttribute('href').slice(5)
  const blob = await blobOf(id)
  if (blob) window.open(URL.createObjectURL(blob), '_blank', 'noopener')
  else a.replaceWith(Object.assign(document.createElement('span'), { className: 'att-gone', textContent: 'Attachment no longer available' }))
}, true)
