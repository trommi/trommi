// The picture on the card of something a session published (server/views/session.mjs assetCard). Assets are
// encrypted and the key is behind the # of the card's link, so the hub cannot make a thumbnail: this browser fetches
// the ciphertext once the card comes near the screen, opens it as the viewer does (js/asset.js, format above
// sealAsset in server/server.mjs) and shows a picture as an <img> from a blob, a page as its first screen in the
// viewer's own sandboxed frame (/a/-/frame.html: no origin, no network; it gets the page as one message). Until
// then, and when anything fails, the drawn kind the hub rendered stays.
import { Controller } from '/js/app/stimulus.mjs'

const PICTURES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'])
const WIDTH = 1280   // a page is laid out this wide and scaled down to the card
const opened = new Map()   // id -> Promise<{ header, content }>: a card the stream brings anew does not fetch again
const pictures = new Map() // id -> object URL

const bytesOf = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))

/** The asset's header and content, decrypted here; throws when it cannot be had. */
export function openAsset(id, keyText) {
  if (!opened.has(id)) {
    const job = (async () => {
      if (!/^[A-Za-z0-9_-]{43}$/.test(keyText) || !crypto.subtle) throw new Error('no key')
      const res = await fetch(`/a/${id}/blob`, { cache: 'no-store', credentials: 'same-origin' })
      if (!res.ok) throw new Error(String(res.status))
      const blob = new Uint8Array(await res.arrayBuffer())
      if (new TextDecoder().decode(blob.subarray(0, 4)) !== 'ZWA1') throw new Error('format')
      const key = await crypto.subtle.importKey('raw', bytesOf(keyText), 'AES-GCM', false, ['decrypt'])
      const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.subarray(4, 16), additionalData: new TextEncoder().encode(`ZWA1/${id}`) }, key, blob.subarray(16)))
      const length = new DataView(plain.buffer).getUint32(0)
      const header = JSON.parse(new TextDecoder().decode(plain.subarray(4, 4 + length)))
      return { header, content: plain.subarray(4 + length, 4 + length + header.size) }
    })()
    job.catch(() => opened.delete(id))   // a failure may be tried again by the next card
    opened.set(id, job)
  }
  return opened.get(id)
}

export default class extends Controller {
  static values = { kind: String }

  connect() {
    const [, id, key] = this.element.getAttribute('href')?.match(/\/a\/([\w-]+)#([\w-]+)/) ?? []
    if (!id) return
    this.id = id
    this.key = key
    if (!('IntersectionObserver' in window)) return this.show()
    this.seen = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) { this.seen.disconnect(); this.show() } }, { rootMargin: '400px' })
    this.seen.observe(this.element)
  }
  disconnect() {
    this.seen?.disconnect()
    this.fit?.disconnect()
    if (this.listen) removeEventListener('message', this.listen)
  }

  async show() {
    try {
      if (this.kindValue === 'image') return await this.picture()
      if (this.kindValue === 'html') return await this.page()
    } catch {}
  }
  async picture() {
    let url = pictures.get(this.id)
    if (!url) {
      const { header, content } = await openAsset(this.id, this.key)
      if (!PICTURES.has(header.mime)) return
      url = URL.createObjectURL(new Blob([content], { type: header.mime }))
      pictures.set(this.id, url)
    }
    const img = Object.assign(new Image(), { alt: '', decoding: 'async' })
    img.addEventListener('load', () => this.element.classList.add('is-shown'), { once: true })
    img.src = url
    this.element.prepend(img)
  }
  async page() {
    const { content } = await openAsset(this.id, this.key)
    if (!this.element.isConnected) return
    const html = new TextDecoder().decode(content)
    const frame = document.createElement('iframe')
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.referrerPolicy = 'no-referrer'
    frame.tabIndex = -1
    frame.title = ''
    frame.setAttribute('aria-hidden', 'true')
    this.listen = e => {
      if (e.source !== frame.contentWindow || e.data !== 'ready') return
      removeEventListener('message', this.listen)
      this.listen = null
      // The frame's origin is opaque, so there is no origin to name; the source check above is the address.
      frame.contentWindow.postMessage({ html }, '*')
      this.element.classList.add('is-shown')
    }
    addEventListener('message', this.listen)
    const scale = () => { frame.style.transform = `scale(${this.element.clientWidth / WIDTH})` }
    this.fit = new ResizeObserver(scale)
    this.fit.observe(this.element)
    scale()
    frame.src = '/a/-/frame.html'
    this.element.prepend(frame)
  }
}
