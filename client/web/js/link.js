// Real links: whatever one navigates with is an <a href> with the real address of the place, so the
// browser can do what it does with links (Ctrl/Cmd+click, middle click, Shift+click, "open in a new tab",
// "copy link", the address in the status bar). A plain left click stays in the page.
//
//   link(cls, href)       an anchor that looks like the button it replaces (css/links.css). Its own click
//                         listeners keep doing the step in the page: they only ever hear a PLAIN click.
//   linkTo(anchor, href)  the same for an anchor that exists; without listeners of its own, pass
//                         { go: true } and a plain click goes to the address in this tab (go(), below).
//   go(href)              go to an address of the board in this tab: one history entry, and the page
//                         follows it as it follows Back (app.js hears "popstate").
//   sessionPath, cardPath, walkPath: the addresses themselves (see the table in app.js).
//
// How: one listener at the window, before everyone else. A click with a modifier (or not with the main
// button) on such an anchor is stopped right there, so no listener of the page takes the step, and the
// browser opens its tab. A plain click loses its default (no page load) and goes on to the listeners.

const hashRoutes = location.protocol === 'file:' || location.hash.startsWith('#/')
/** A path of the board as an href (behind "#" where the page is served as plain files). */
export const hrefOf = path => (hashRoutes ? `#${path}` : path)

const enc = encodeURIComponent
/** /s/<id>, or /s/<id>+<id> for sessions laid together. */
export const sessionPath = ids => `/s/${[].concat(ids).map(enc).join('+')}`
/** A question by its number: /q/<n> on the Desk, /s/<id>/q/<n> in its session (`base` is the place it opens over). */
export const cardPath = (card, base = '') => `${base}/q/${enc(card.number ?? card.id)}`
/** The walk through the open questions: of everything (/walk) or of one place (/s/<id>/walk). */
export const walkPath = (base = '') => `${base}/walk`

const modified = e => e.button > 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey

export function go(href) {
  const url = new URL(href, location.href)
  if (url.href === location.href) return
  history.pushState({}, '', url)
  dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
}

export function linkTo(node, href, { go: goes = false } = {}) {
  node.setAttribute('href', hrefOf(href))
  node.dataset.nav = goes ? 'go' : ''
  node.draggable = false   // a link is dragged by the browser; these are pressed (and some are carried by the page)
  return node
}
export function link(cls, href, opts) {
  const a = document.createElement('a')
  if (cls) a.className = cls
  return linkTo(a, href, opts)
}

window.addEventListener('click', e => {
  const a = e.target.closest?.('a[data-nav]')
  if (!a) return
  if (modified(e)) return e.stopPropagation()   // the browser's: a new tab, a new window, a download
  e.preventDefault()
  if (a.dataset.nav === 'go') go(a.href)
}, true)
// The space bar presses a button; these were buttons, so it presses them too. (Enter is the link's own.)
window.addEventListener('keydown', e => {
  if (e.key !== ' ' || e.ctrlKey || e.metaKey || e.altKey || !e.target.matches?.('a[data-nav]')) return
  e.preventDefault()
  e.target.click()
})
