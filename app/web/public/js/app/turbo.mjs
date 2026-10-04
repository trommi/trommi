// A small stand-in for the part of Hotwire Turbo the board's controllers and views rely on: the <turbo-stream>
// element (actions append, prepend, before, after, replace, update, remove, refresh, with the
// turbo:before-stream-render event and its detail.render hook), renderStreamMessage, and visit(). The pages are not
// fetched: the router (public/js/app/router.mjs) renders them in the page. window.Turbo is set for code that asks it.

let visitor = null
/** The router registers how a visit is made (path, { action }). */
export function setVisitor(fn) { visitor = fn }
export function visit(location, options = {}) { return visitor?.(String(location), options) }

const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches

class TurboStream extends HTMLElement {
  get action() { return this.getAttribute('action') }
  get target() { return this.getAttribute('target') }
  get templateElement() { return this.querySelector('template') }
  get templateContent() { return this.templateElement?.content.cloneNode(true) ?? document.createDocumentFragment() }
  get targetElements() { const t = this.target ? document.getElementById(this.target) : null; return t ? [t] : [] }
  async connectedCallback() {
    if (this.started) return
    this.started = true
    const render = el => perform(el)
    const event = new CustomEvent('turbo:before-stream-render', { bubbles: true, cancelable: true, detail: { newStream: this, render } })
    if (this.dispatchEvent(event)) { try { await event.detail.render(this) } catch (err) { console.error('turbo-stream', err) } }
    this.remove()
  }
}

async function perform(stream) {
  const action = stream.action, target = stream.targetElements[0]
  if (action === 'refresh') return refresher?.()
  if (!target) return
  const content = () => stream.templateContent
  switch (action) {
    case 'remove': {
      // A Desk row that leaves goes with one calm motion; then the list closes up.
      if (target.matches('.inbox-row') && !calm()) {
        target.inert = true
        await target.animate([{ opacity: 1, translate: '0 0' }, { opacity: 0, translate: '24px 0' }], { duration: 160, easing: 'ease-in' }).finished.catch(() => {})
      }
      target.remove(); break
    }
    case 'replace': target.replaceWith(content()); break
    case 'update': target.replaceChildren(content()); break
    case 'append': { const c = content(); dedupe(target, c); target.append(c); break }
    case 'prepend': { const c = content(); dedupe(target, c); target.prepend(c); break }
    case 'before': target.before(content()); break
    case 'after': target.after(content()); break
  }
}
// As Turbo does: an appended element whose id stands in the target already replaces it.
function dedupe(target, fragment) {
  for (const el of fragment.children) if (el.id) target.querySelector(`#${CSS.escape(el.id)}`)?.remove()
}

if (!customElements.get('turbo-stream')) customElements.define('turbo-stream', TurboStream)
// <turbo-frame> is a plain element with its id; navigation inside it is the router's (frames).
if (!customElements.get('turbo-frame')) customElements.define('turbo-frame', class extends HTMLElement {})

let refresher = null
export function setRefresher(fn) { refresher = fn }

/** Applies stream actions given as markup (<turbo-stream action target><template>…</template></turbo-stream>…). */
export function renderStreamMessage(text) {
  if (!text) return
  const t = document.createElement('template')
  t.innerHTML = String(text)
  const host = document.getElementById('stream-host') ?? document.body
  for (const el of [...t.content.querySelectorAll('turbo-stream')]) host.append(document.importNode(el, true))
}

window.Turbo = { visit, renderStreamMessage, session: { drive: true } }
