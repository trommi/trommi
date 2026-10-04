// The room pages' small helpers (js/app/room.mjs): copy a link or command (German words), select a read-only field
// on focus, the password strength line, and the storage numbers (this device: navigator.storage; the hub: client.usage()).
import { Controller } from '/js/app/stimulus.mjs'
import { copyText } from '/t/controllers/copy_controller.js'
import { passphraseProblem } from '/js/app/room.mjs'

const size = n => (n == null ? '–' : n < 1e3 ? `${n} B` : n < 1e6 ? `${(n / 1e3).toFixed(0)} kB` : n < 1e9 ? `${(n / 1e6).toFixed(1).replace('.', ',')} MB` : `${(n / 1e9).toFixed(2).replace('.', ',')} GB`)

export default class extends Controller {
  static targets = ['field', 'label', 'pass', 'again', 'meter', 'go', 'local', 'hub']
  static values = { usage: String }

  connect() { if (this.hasLocalTarget) this.usage() }
  disconnect() { clearTimeout(this.timer) }

  select(e) { e.target.select() }
  async copy(e) {
    const ok = await copyText(e.params.text)
    const label = e.currentTarget.querySelector('[data-room-target="label"]')
    if (!label) return
    label.textContent = ok ? 'Kopiert' : 'Nicht kopiert'
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { label.textContent = 'Kopieren' }, 1800)
  }

  strength() {
    const p = this.passTarget.value, again = this.againTarget.value
    const why = p ? passphraseProblem(p) : null
    const level = !p ? 0 : why ? 1 : p.length >= 28 ? 3 : 2
    this.meterTarget.dataset.level = level
    this.meterTarget.textContent = !p ? 'Mindestens 4 Wörter und 14 Zeichen.'
      : why ? `Noch nicht: ${why}`
        : again && again !== p ? 'Stark genug. Die zweite Eingabe ist noch anders.'
          : level === 3 ? 'Sehr gut.' : 'Stark genug.'
    if (this.hasGoTarget) this.goTarget.disabled = !(p && !why && again === p)
  }

  async usage() {
    try { const e = await navigator.storage?.estimate?.(); this.localTarget.textContent = e ? size(e.usage) : 'unbekannt' } catch { this.localTarget.textContent = 'unbekannt' }
    if (!this.hasHubTarget) return
    try {
      const u = await window.trommi?.client?.usage?.()
      const used = u?.bytes ?? u?.used_bytes ?? u?.total_bytes
      const limit = u?.limit_bytes ?? u?.quota_bytes ?? u?.limit
      this.hubTarget.textContent = used == null ? 'unbekannt' : limit ? `${size(used)} von ${size(limit)}` : size(used)
      if (used != null && limit) { this.hubTarget.style.setProperty('--used', `${Math.min(100, (100 * used) / limit).toFixed(1)}%`); this.hubTarget.classList.add('has-bar') }
    } catch { this.hubTarget.textContent = 'nicht erreichbar' }
  }
}
