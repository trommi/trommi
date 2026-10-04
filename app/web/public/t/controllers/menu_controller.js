// The Trommi menu (server/views/menu.mjs renders it; t/application.js opens and closes it and switches the theme).
// Here: the arrows through the entries, a new desk, and "#jump" in the address, which opens it (the menu has no
// search field for now; Ctrl K opens the menu with the keyboard on the desk in view).
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
  static targets = ['deskForm', 'deskName', 'deskError']
  static values = { desk: String }

  connect() {
    // Opened (the pill, Ctrl+K, G then J): the menu takes the keyboard; the first arrow goes to the desk in view.
    this.element.tabIndex = -1
    this.watch = new MutationObserver(() => { if (!this.element.hidden && !this.element.contains(document.activeElement)) this.element.focus({ preventScroll: true }) })
    this.watch.observe(this.element, { attributes: true, attributeFilter: ['hidden'] })
    // A refresh of the page (the live stream's "refresh" morphs it) must not shut the menu, the desk line or Dev under the hand.
    this.keep = e => {
      const t = e.target, name = e.detail?.attributeName
      if ((t === this.element && name === 'hidden') || (t.id === 'brand-menu' && name === 'aria-expanded') || (t.id === 'desk-new' && name === 'hidden')) e.preventDefault()
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

  /** Where the keyboard starts: the desk in view (its lamp on), else the first entry. */
  home() { return this.element.querySelector('.menu-desk[aria-checked="true"]') ?? this.items[0] }
  // The arrows walk the entries, round at both ends.
  walk(event) {
    const all = this.items, at = all.indexOf(document.activeElement)
    if (at < 0 && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); return this.home()?.focus() }
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: all.length - 1 }[event.key]
    if (to == null) return
    event.preventDefault()
    all[(to + all.length) % all.length]?.focus()
  }

  // ---- entries ----
  // A choice closes the menu; a switch (theme, push) leaves it open.
  // ("New desk" opens its line and leaves the menu open.)
  chosen(event) { if (event.target.closest('[role="menuitem"]:not([data-menu-body-param]):not(#desk-add), [role="menuitemradio"], [role="option"]')) this.close() }

  // ---- a new desk: "+" opens a line for its name; Enter makes it (POST /desk, the hub's desks) and goes there ----
  newDesk() {
    this.deskFormTarget.hidden = !this.deskFormTarget.hidden
    this.deskErrorTarget.textContent = ''
    if (!this.deskFormTarget.hidden) this.deskNameTarget.focus()
  }
  deskKey(event) {
    event.stopPropagation()   // the arrows and keys of the menu are not this line's
    if (event.key === 'Escape') { event.preventDefault(); this.deskNameTarget.value = ''; this.deskFormTarget.hidden = true; this.deskErrorTarget.textContent = ''; this.element.querySelector('#desk-add')?.focus() }
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
