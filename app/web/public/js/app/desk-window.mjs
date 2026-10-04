// The Desk's window: rows beyond the first ones are rendered empty (board.mjs) and filled in here when they come
// within a screen or two of the viewport, a few per frame. A row once filled stays filled.
let io = null, board = null
const queue = new Set()
let scheduled = false
function fill() {
  scheduled = false
  let n = 0
  for (const el of queue) {
    queue.delete(el)
    if (!el.isConnected || !el.hasAttribute('data-later')) continue
    const markup = board.row(el.dataset.id)
    if (markup) { const t = document.createElement('template'); t.innerHTML = markup; el.replaceWith(t.content) }
    if (++n >= 6) break
  }
  if (queue.size && !scheduled) { scheduled = true; requestAnimationFrame(fill) }
}
function watch(root = document) {
  for (const el of root.querySelectorAll('.inbox-row[data-later]')) io.observe(el)
}
export function startDeskWindow(b) {
  board = b
  io = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); queue.add(e.target) }
    if (queue.size && !scheduled) { scheduled = true; requestAnimationFrame(fill) }
  }, { rootMargin: '1000px 0px' })
  document.addEventListener('turbo:load', () => watch())
  new MutationObserver(records => { for (const r of records) for (const n of r.addedNodes) if (n instanceof Element) { if (n.matches('.inbox-row[data-later]')) io.observe(n); else if (n.querySelector?.('.inbox-row[data-later]')) watch(n) } })
    .observe(document.body, { childList: true, subtree: true })
}
