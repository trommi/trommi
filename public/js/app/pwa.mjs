// The app installed on a phone (area "Phone layout"):
//   1. The status bar has the colour of the top bar, light or dark as the board's own theme switch says
//      (<meta name="theme-color"> follows html[data-theme]; the manifest can only name one colour).
//   2. A new version arrives without breaking the page that runs. sw.js takes over at once (skipWaiting + claim);
//      an installed app stays open for days, so it asks for a new sw.js whenever it comes back to the front (at most
//      every 30 minutes). When a new worker took over, the page reloads by itself while nobody looks (the app is in
//      the background and no field holds unsent words); otherwise a quiet line offers "Neu laden".
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
  const reloadIfQuiet = () => { if (stale && document.visibilityState === 'hidden' && !unsent()) location.reload() }
  function offer() {
    if (document.querySelector('.app-update')) return
    const box = document.createElement('div')
    box.className = 'app-update'
    box.setAttribute('role', 'status')
    const go = document.createElement('button')
    go.type = 'button'
    go.textContent = 'Neu laden'
    go.addEventListener('click', () => location.reload())
    box.append('Eine neue Version ist da.', go)
    document.body.append(box)
  }
  const arrived = () => {
    stale = true
    if (document.visibilityState === 'hidden' && !unsent()) location.reload()
    else offer()
  }
  sw.addEventListener('controllerchange', () => { if (hadController) arrived() })
  // A release without a new sw.js: the worker saw changed files and fetched the shell again (public/sw.js).
  sw.addEventListener('message', e => { if (e.data?.type === 'trommi-update') arrived() })
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') return reloadIfQuiet()
    if (Date.now() - checked < CHECK_MS) return
    checked = Date.now()
    try { await (await sw.getRegistration())?.update() } catch {}
  })
}
