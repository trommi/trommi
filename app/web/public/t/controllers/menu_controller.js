// The Trommi menu (server/views/menu.mjs renders it; t/application.js opens and closes it and switches the theme).
// Here: the jump field (what is typed goes to the hub, the results come into the frame #jump-results; Enter
// takes the first), the arrows through the entries, the Dev items, and "#jump" in the address, which opens it.
import { Controller } from '/js/app/stimulus.mjs'
import { toast } from '/t/lib/toast.js'   // "Desk added · Undo"

/** Go to a page the way a click on a link does (Turbo for the pages rendered here, a whole load for the others). */
function go(path) {
  const a = document.createElement('a')
  a.href = path
  a.style.display = 'none'
  document.body.append(a)
  a.click()
  a.remove()
}

export default class extends Controller {
  static targets = ['field', 'results', 'key', 'deskForm', 'deskName', 'deskError']
  static values = { desk: String }

  connect() {
    this.asked = ''
    if (/Mac|iPhone|iPad/.test(navigator.platform) && this.hasKeyTarget) this.keyTarget.textContent = '⌘K'
    // Opened (the pill, Ctrl+K, G then J): the jump field takes the keyboard, type and go.
    this.watch = new MutationObserver(() => { if (!this.element.hidden && !this.element.contains(document.activeElement)) this.fieldTarget.focus() })
    this.watch.observe(this.element, { attributes: true, attributeFilter: ['hidden'] })
    // A refresh of the page (the live stream's "refresh" morphs it) must not shut the menu, the desk line or Dev under the hand.
    this.keep = e => {
      const t = e.target, name = e.detail?.attributeName
      if ((t === this.element && name === 'hidden') || (t.id === 'brand-menu' && name === 'aria-expanded') || (t.id === 'desk-new' && name === 'hidden') || (t.id === 'menu-dev' && name === 'open')) e.preventDefault()
    }
    document.addEventListener('turbo:before-morph-attribute', this.keep)
    this.away = e => { if (!this.element.hidden && e.target instanceof Element && !e.target.closest('.brand')) this.close() }
    document.addEventListener('focusin', this.away)
    if (location.hash === '#jump') {
      history.replaceState(history.state, '', location.pathname + location.search)
      this.element.hidden = false
      this.opener?.setAttribute('aria-expanded', 'true')
    }
  }
  disconnect() {
    this.watch.disconnect()
    document.removeEventListener('focusin', this.away)
    document.removeEventListener('turbo:before-morph-attribute', this.keep)
    clearTimeout(this.timer)
  }
  get opener() { return document.getElementById('brand-menu') }
  get items() { return [...this.element.querySelectorAll('[role^="menuitem"], [role="option"]')].filter(n => n.checkVisibility()) }
  close() {
    this.element.hidden = true
    this.opener?.setAttribute('aria-expanded', 'false')
  }

  // ---- jump: type, and go ----
  typed() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.ask(), 90)
  }
  ask() {
    const q = this.fieldTarget.value.trim()
    if (q === this.asked) return
    this.asked = q
    if (!q) { this.resultsTarget.replaceChildren(); this.resultsTarget.removeAttribute('src'); return }
    this.fieldTarget.form.requestSubmit()
  }
  // What stands in the frame may be older than what was typed: then the first result is taken when it arrives.
  loaded() { if (this.enter) { this.enter = false; this.first() } }
  first() {
    const first = this.resultsTarget.querySelector('a')
    if (!first) return
    this.close()
    first.click()
  }
  fieldKey(event) {
    if (event.key === 'Enter') {
      event.preventDefault()
      clearTimeout(this.timer)
      if (this.fieldTarget.value.trim() === this.asked && !this.resultsTarget.hasAttribute('busy')) this.first()
      else { this.enter = true; this.ask() }
    }
    if (event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); (this.resultsTarget.querySelector('a') ?? this.items[0])?.focus() }
  }
  // The arrows walk the entries; up from the first is the field again.
  walk(event) {
    if (event.target === this.fieldTarget) return
    const all = this.items, at = all.indexOf(document.activeElement)
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: all.length - 1 }[event.key]
    if (to == null) return
    event.preventDefault()
    if (event.key === 'ArrowUp' && at === 0) return this.fieldTarget.focus()
    all[(to + all.length) % all.length]?.focus()
  }

  // ---- entries ----
  // A choice closes the menu; a switch (theme, push) leaves it open.
  // (Dev is a fold: its summary opens it and leaves the menu open.)
  chosen(event) { if (event.target.closest('[role="menuitem"]:not([data-menu-body-param]):not(summary), [role="menuitemradio"], [role="option"]')) this.close() }

  // ---- a new desk: "+" opens a line for its name; Enter makes it (POST /desk, the hub's desks) and goes there ----
  newDesk() {
    this.deskFormTarget.hidden = !this.deskFormTarget.hidden
    this.deskErrorTarget.textContent = ''
    if (!this.deskFormTarget.hidden) this.deskNameTarget.focus()
  }
  deskKey(event) {
    event.stopPropagation()   // the arrows and keys of the menu are not this line's
    if (event.key === 'Escape') { event.preventDefault(); this.deskNameTarget.value = ''; this.deskFormTarget.hidden = true; this.deskErrorTarget.textContent = ''; this.fieldTarget.focus() }
  }
  async makeDesk(event) {
    event.preventDefault()
    const name = this.deskNameTarget.value.trim()
    if (!name) return this.deskNameTarget.focus()
    try {
      const res = await fetch('/desk', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
      let out = {}
      try { out = await res.json() } catch {}
      if (!res.ok || !out.desk?.id) { this.deskErrorTarget.textContent = `Not made: ${out.error || res.statusText}`; return }
      this.deskNameTarget.value = ''
      this.deskFormTarget.hidden = true
      this.close()
      const made = out.desk.id, home = this.deskValue
      go(`${home}?desk=${encodeURIComponent(made)}`)
      // Undo takes the new desk away again and goes back to the default desk.
      toast({ head: 'Desk added', line: out.desk.name ?? name, undo: async () => {
        const res = await fetch('/desk', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: made, remove: true }) })
        if (!res.ok) { toast({ head: 'Not undone', line: 'the desk could not be taken away', role: 'alert' }); return }
        go(`${home}?desk=main`)
      } })
    } catch { this.deskErrorTarget.textContent = 'Not made: the board did not answer.' }
  }
  keys() { this.close(); document.dispatchEvent(new CustomEvent('trommi:keys')) }
}
