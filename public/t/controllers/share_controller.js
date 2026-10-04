// "Copy link" on the card of something a session published (server/views/session.mjs assetCard). One link, and it
// works for whoever gets it: copying releases the artifact for outside links (the asset feature's own JSON route,
// /asset/share, which keeps a release that is already there) and copies <address>/r/<id>#<key>. The hub knows the
// address, only this page knows the key (the part after the # of the link it holds). A fresh release can be taken
// back from the toast (Undo); while it stands, the card says "Shared · Stop". The live stream brings the card anew.
import { Controller } from '/js/app/stimulus.mjs'
import { copyText } from '/t/controllers/copy_controller.js'
import { toast } from '/t/lib/toast.js'

const whole = link => new URL(link, location.href).href

/** Copies text that is still on its way. Safari keeps the click's permission only for a write started in the click,
 *  so the text goes to the clipboard as a promise where the browser takes one; otherwise it is copied when it came. */
export async function copyLater(text) {
  if (window.ClipboardItem && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text.then(t => new Blob([t], { type: 'text/plain' })) })])
      return true
    } catch {}
  }
  return copyText(await text)
}

export default class extends Controller {
  static targets = ['copy']
  static values = { id: String, key: String, href: String, title: String, link: String }

  async copy() {
    if (this.busy) return
    // Without a key there is nothing to release: the link the card holds is all there is.
    if (!this.idValue || !this.keyValue) return this.said(await copyText(whole(this.hrefValue)), false)
    if (this.linkValue) return this.said(await copyText(whole(this.linkValue)), false)
    this.busy = true
    this.element.toggleAttribute('data-busy', true)
    const link = this.release()
    let ok = false, error = null
    try { ok = await copyLater(link); await link } catch (err) { error = err; ok = false }
    this.busy = false
    this.element.removeAttribute('data-busy')
    if (error) return toast({ head: 'Not copied', line: error.message, role: 'alert' })
    this.said(ok, true)
  }
  said(ok, fresh) {
    if (!ok) return toast({ head: 'Not copied', line: 'The browser kept the clipboard closed', role: 'alert' })
    toast({ head: 'Link copied', line: fresh ? `Anyone with it can open “${this.titleValue}”` : this.titleValue, undo: fresh ? () => this.post({ release: false }) : null, label: 'Stop sharing' })
  }
  stop() { this.post({ release: false }).catch(err => toast({ head: 'Not stopped', line: err.message, role: 'alert' })) }

  /** Releases the artifact (or keeps the release that stands) and gives the whole outside link. */
  async release() {
    const out = await this.post({})
    return `${out.urls?.[0] ?? whole(out.path)}#${this.keyValue}`
  }
  async post(body) {
    const res = await fetch('/asset/share', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: this.idValue, ...body }) })
    let out = {}
    try { out = await res.json() } catch {}
    if (!res.ok) throw new Error(res.status === 404 && out.code === 'no-asset' ? 'This artifact is gone' : out.error || res.statusText)
    return out
  }
}
