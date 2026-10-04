// The app installed on a phone (area "Phone layout"):
//   1. The status bar has the colour of the top bar, light or dark as the board's own theme switch says
//      (<meta name="theme-color"> follows html[data-theme]; the manifest can only name one colour).
//   2. A new version takes over at once: sw.js skips waiting and claims the page, which reloads (a field with unsent
//      words: a quiet line offers "Reload" instead). An installed app stays open for days, so it asks for a new sw.js
//      whenever it comes back to the front (at most every 30 minutes).
const meta = document.querySelector('meta[name="theme-color"]')
function paintBar() {
  if (!meta) return
  const bar = document.querySelector('.topbar') ?? document.body
  const colour = bar && getComputedStyle(bar).backgroundColor
  if (colour && colour !== 'rgba(0, 0, 0, 0)') meta.setAttribute('content', colour)
}
new MutationObserver(() => requestAnimationFrame(paintBar)).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-ready'] })
requestAnimationFrame(paintBar)

const sw = navigator.serviceWorker
if (sw) {
  const CHECK_MS = 30 * 60e3
  let checked = Date.now(), stale = false
  const hadController = Boolean(sw.controller)   // the first install also "takes over": that is no new version
  const unsent = () => [...document.querySelectorAll('textarea, input[type="text"], input:not([type])')].some(f => f.value.trim() && !f.closest('[hidden]'))
  function offer() {
    if (document.querySelector('.app-update')) return
    const box = document.createElement('div')
    box.className = 'app-update'
    box.setAttribute('role', 'status')
    const go = document.createElement('button')
    go.type = 'button'
    go.textContent = 'Reload'
    go.addEventListener('click', () => location.reload())
    box.append('A new version is ready.', go)
    document.body.append(box)
  }
  // A new version took over: the page reloads at once, unless a field holds unsent words (then a quiet line offers
  // it, and it reloads by itself once the app is in the background with nothing unsent).
  sw.addEventListener('controllerchange', () => { if (!hadController) return; stale = true; if (unsent()) offer(); else location.reload() })
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') { if (stale && !unsent()) location.reload(); return }
    if (Date.now() - checked < CHECK_MS) return
    checked = Date.now()
    try { await (await sw.getRegistration())?.update() } catch {}
  })
}
