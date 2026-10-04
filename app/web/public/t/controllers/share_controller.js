// "Copy link" of something a session published (views/session.mjs assetCard, assetPage): copies the address of the
// app's viewer for it. It opens for the people of this room (the contents are end-to-end encrypted with the room's
// keys); there is no outside link.
import { Controller } from '/js/app/stimulus.mjs'
import { copyText } from '/t/controllers/copy_controller.js'
import { toast } from '/t/lib/toast.js'

export default class extends Controller {
  static values = { link: String, title: String }

  async copy() {
    const ok = await copyText(new URL(this.linkValue, location.href).href)
    if (!ok) return toast({ head: 'Not copied', line: 'The browser kept the clipboard closed', role: 'alert' })
    toast({ head: 'Link copied', line: `“${this.titleValue}” opens for the people of this room` })
  }
}
