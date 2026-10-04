// The account pages' small helpers (js/app/room.mjs): copy a link or command, select a read-only field on focus,
// Generate a password, download or print the Emergency Kit, and the storage numbers (navigator.storage; client.usage()).
import { Controller } from '/js/app/stimulus.mjs'
import { copyText } from '/t/controllers/copy_controller.js'
import { generateInto, downloadKit } from '/js/app/room.mjs'

const size = n => (n == null ? '–' : n < 1e3 ? `${n} B` : n < 1e6 ? `${(n / 1e3).toFixed(0)} kB` : n < 1e9 ? `${(n / 1e6).toFixed(1).replace('.', ',')} MB` : `${(n / 1e9).toFixed(2).replace('.', ',')} GB`)

export default class extends Controller {
  static targets = ['field', 'label', 'local', 'hub']
  static values = { usage: String }

  connect() { if (this.hasLocalTarget) this.usage() }
  disconnect() { clearTimeout(this.timer) }

  select(e) { e.target.select() }
  async copy(e) {
    const ok = await copyText(e.params.text)
    const label = e.currentTarget.querySelector('[data-room-target="label"]')
    if (!label) return
    label.textContent = ok ? 'Copied' : 'Not copied'
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { label.textContent = 'Copy' }, 1800)
  }

  generate(e) { e.preventDefault(); generateInto(e.currentTarget) }
  download(e) { downloadKit(e.params.text) }
  print() { window.print() }

  async usage() {
    try { const e = await navigator.storage?.estimate?.(); this.localTarget.textContent = e ? size(e.usage) : 'unknown' } catch { this.localTarget.textContent = 'unknown' }
    if (!this.hasHubTarget) return
    try {
      const u = await window.trommi?.client?.usage?.()
      const used = u?.bytes ?? u?.used_bytes ?? u?.total_bytes
      const limit = u?.limit_bytes ?? u?.quota_bytes ?? u?.limit
      this.hubTarget.textContent = used == null ? 'unknown' : limit ? `${size(used)} of ${size(limit)}` : size(used)
      if (used != null && limit) { this.hubTarget.style.setProperty('--used', `${Math.min(100, (100 * used) / limit).toFixed(1)}%`); this.hubTarget.classList.add('has-bar') }
    } catch { this.hubTarget.textContent = 'not reachable' }
  }
}
