// The app's service worker. Three jobs:
//   1. The app shell offline: every file of the app (SHELL, written by dev/build.mjs at deploy time) is kept in a cache
//      named by VERSION and served when the network is not there; a new VERSION is a new cache, the old one goes. Hub data is never cached here
//      (requests to the hub are not touched at all; the room lives in IndexedDB, encrypted where the core says so).
//   2. Attachments: /att/<attachment_id> is answered by asking an open page of the app, which fetches and decrypts
//      the file with the client core (only when the browser actually needs it: a visible <img loading=lazy>, a click).
//   3. Push: a notification per push (the hub sends only { room_id, envelope_number, urgency }); a tap opens the app.
const VERSION = "dev"   // written by dev/build.mjs at deploy time (a hash of the shell)
const SHELL = []        // written by dev/build.mjs at deploy time: every file the app serves
const CACHE = `shell-${VERSION}`
// The dev server (dev/serve.mjs, the preview) has VERSION "dev": no service worker there. One that was installed before
// removes itself and its caches (the page does not register it again: app boot, html[data-build="dev"]).
const DEV = VERSION === 'dev'

// A new deploy takes over at once: installed, it skips waiting and claims the open pages (they reload: app.mjs).
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    if (!DEV) { const cache = await caches.open(CACHE); await cache.addAll(SHELL) }
    await self.skipWaiting()
  })())
})
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const name of await caches.keys()) if (name.startsWith('shell-') && name !== CACHE) await caches.delete(name)
  if (DEV) { await caches.delete(CACHE); await self.registration.unregister(); return }
  await self.clients.claim()
})()))

async function fromPage(id, clientId) {
  const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const first = pages.find(p => p.id === clientId)
  const order = first ? [first, ...pages.filter(p => p !== first)] : pages
  for (const page of order) {
    const answer = await new Promise(resolve => {
      const channel = new MessageChannel()
      const timer = setTimeout(() => resolve(null), 20000)
      channel.port1.onmessage = e => { clearTimeout(timer); resolve(e.data) }
      page.postMessage({ type: 'trommi-att', id }, [channel.port2])
    })
    if (answer?.blob) return answer
  }
  return null
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return
  // The hub may answer on the app's own origin (under /v2/, as a local stack does): its requests are never this
  // worker's, the live stream least of all (Firefox kept a stream the worker had passed on open after a reload: one
  // more per reload, until the six connections to the host were taken and every request waited). They go to the
  // network as the page or the core worker sent them. In production the hub is another origin: not touched above.
  if (url.pathname.startsWith('/v2/')) return
  const att = /^\/att\/([0-9a-f]{32})$/.exec(url.pathname)
  if (att) {
    event.respondWith((async () => {
      const got = await fromPage(att[1], event.clientId || event.resultingClientId)
      if (!got) return new Response('This file can only be opened inside the app, with the room open.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
      // (sandbox: an attached page opened on its own never runs as the app's origin; the app shows pages in /frame)
      const headers = { 'Content-Type': got.type || 'application/octet-stream', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes', 'Content-Security-Policy': "sandbox; default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; font-src data:", ...(got.name ? { 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(got.name)}` } : {}) }
      // A video asks for ranges (Safari plays nothing without 206 answers): cut them from the decrypted blob.
      const range = /^bytes=(\d*)-(\d*)$/.exec(event.request.headers.get('range') ?? '')
      const size = got.blob.size
      if (range && (range[1] || range[2])) {
        const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
        const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
        if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
        return new Response(got.blob.slice(start, end + 1), { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) } })
      }
      return new Response(got.blob, { headers })
    })())
    return
  }
  // (The sandboxed frame keeps its own CSP: it never comes from the shell cache.)
  if (DEV || url.pathname.startsWith('/demo/') || url.pathname.startsWith('/artifact/') || url.pathname.startsWith('/a/') || url.pathname === '/frame') return
  // Only the app's own files and its pages: anything else on this origin goes to the network untouched.
  if (event.request.mode !== 'navigate' && !SHELL.includes(url.pathname)) return
  // Network first, the cache when offline: a phone that is online never runs yesterday's code. A navigation inside the
  // app gets the shell ("/": the app routes in the page).
  const key = event.request.mode === 'navigate' && !/\.\w+$/.test(url.pathname) && !url.pathname.endsWith('/') ? '/' : url.pathname
  event.respondWith((async () => {
    try {
      const res = await fetch(key === '/' ? '/' : event.request, { cache: 'no-cache' })
      // (the copy is taken now: once the answer is handed on its body is being read, and clone() throws)
      if (res.ok && !res.redirected && SHELL.includes(key)) { const copy = res.clone(); event.waitUntil(caches.open(CACHE).then(c => c.put(key, copy)).catch(() => {})) }
      return res
    } catch (err) {
      const hit = await (await caches.open(CACHE)).match(key)
      if (!hit) throw err
      return hit.redirected ? new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers: hit.headers }) : hit
    }
  })())
})

self.addEventListener('push', event => {
  let message = {}
  try { message = event.data.json() } catch {}
  // The hub's word on a session's link: cut off (its Claude Code runs, its Trommi tools are gone), or
  // gone with running work, for a minute.
  if (message.kind === 'agent-lost') {
    message = message.state === 'cut'
      ? { ...message, title: 'Trommi: a session is cut off', body: 'It cannot hear you and cannot write to you. In its terminal: /mcp → trommi → Reconnect.' }
      : { ...message, title: 'Trommi: connection lost', body: 'An agent with running work lost its connection to Trommi.' }
    message.tag = `lost-${String(message.device_id ?? '').slice(0, 16)}`
  }
  event.waitUntil(self.registration.showNotification(message.title || 'Trommi', {
    body: message.body || (message.urgency === 'critical' || message.urgency === 'high' ? 'Something knocks' : 'A new question'),
    tag: message.tag || 'trommi', renotify: true, icon: '/icons/trommi-192.png',
    data: { url: ownUrl(message.url) },
  }))
})
/** An address of this app as a path, or '/': a notification never leads to another origin ('//host/…' and '/\\host/…' resolve to one). */
function ownUrl(given) {
  try { const u = new URL(typeof given === 'string' ? given : '/', self.location.origin); return u.origin === self.location.origin ? u.pathname + u.search + u.hash : '/' } catch { return '/' }
}
self.addEventListener('notificationclick', event => {
  event.notification.close()
  const url = new URL(ownUrl(event.notification.data?.url), self.location.origin).href
  event.waitUntil((async () => {
    const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const page = pages[0]
    if (!page) return self.clients.openWindow(url)
    await page.focus().catch(() => {})
    if (page.url !== url) await page.navigate(url).catch(() => self.clients.openWindow(url))
  })())
})
