// The app's service worker. Three jobs:
//   1. The app shell offline and instant: every file of the app (SHELL, written by dev/release.sh) is kept in a cache
//      named by VERSION; a new VERSION is a new cache, the old one goes on activation. Hub data is never cached here
//      (requests to the hub are not touched at all; the room lives in IndexedDB, encrypted where the core says so).
//   2. Attachments: /att/<attachment_id> is answered by asking an open page of the app, which fetches and decrypts
//      the file with the client core (only when the browser actually needs it: a visible <img loading=lazy>, a click).
//   3. Push: a notification per push (the hub sends only { room_id, envelope_number, urgency }); a tap opens the app.
const VERSION = "8fa046906397"
const SHELL = ["/","/a/frame.html","/build.txt","/css/admin.css","/css/app.css","/css/asset.css","/css/back.css","/css/beside.css","/css/cardclip.css","/css/cardpage.css","/css/clear.css","/css/clipboard.css","/css/crowns.css","/css/deskpad.css","/css/focus.css","/css/help-page.css","/css/help.css","/css/keys.css","/css/ledger.css","/css/links.css","/css/logo.css","/css/padlink.css","/css/phone-desk.css","/css/piles.css","/css/push.css","/css/quicksend.css","/css/richhtml.css","/css/room.css","/css/scribble.css","/css/session.css","/css/slip.css","/css/speech.css","/css/stamps.css","/css/tokens.css","/css/trommi.css","/css/turbo.css","/drawings.json","/fonts/f0.woff2","/fonts/f1.woff2","/fonts/f2.woff2","/fonts/f3.woff2","/fonts/f4.woff2","/fonts/f5.woff2","/fonts/f6.woff2","/fonts/f7.woff2","/fonts/fonts.css","/help.html","/icons/trommi-180.png","/icons/trommi-192.png","/icons/trommi-512.png","/icons/trommi-maskable-512.png","/icons/trommi-maskable.svg","/icons/trommi.svg","/js/app/application.mjs","/js/app/att.mjs","/js/app/board-state.mjs","/js/app/board.mjs","/js/app/boot.mjs","/js/app/desk-window.mjs","/js/app/help-page.mjs","/js/app/hub-facade.mjs","/js/app/large.mjs","/js/app/layout.mjs","/js/app/memo-store.mjs","/js/app/mock-crazy.mjs","/js/app/mock-room.mjs","/js/app/node-stubs/blocked.mjs","/js/app/push.mjs","/js/app/pwa.mjs","/js/app/qr.mjs","/js/app/room.mjs","/js/app/router.mjs","/js/app/share-view.mjs","/js/app/sheets.mjs","/js/app/stimulus.mjs","/js/app/theme.js","/js/app/turbo.mjs","/js/app/version.mjs","/js/focus-marks.js","/js/pen.js","/js/richhtml.js","/js/ui.js","/js/views/agents.mjs","/js/views/card.mjs","/js/views/desk.mjs","/js/views/gutter-hover.mjs","/js/views/html.mjs","/js/views/keys.mjs","/js/views/memo.mjs","/js/views/menu.mjs","/js/views/model.mjs","/js/views/nextplease.mjs","/js/views/picture.mjs","/js/views/session-edit.mjs","/js/views/session.mjs","/js/views/sidebar.mjs","/js/views/stacks.mjs","/js/views/text.mjs","/js/views/toast.mjs","/large.html","/manifest.webmanifest","/pad/board.js","/pad/canvas.js","/pad/elements.js","/pad/fly.js","/pad/index.html","/pad/name.js","/pad/pad.css","/pad/pad.js","/pad/theme.js","/pad/wire.js","/t/controllers/advice_controller.js","/t/controllers/assetthumb_controller.js","/t/controllers/card_controller.js","/t/controllers/circles_controller.js","/t/controllers/clip_controller.js","/t/controllers/composer_controller.js","/t/controllers/copy_controller.js","/t/controllers/desk_controller.js","/t/controllers/files_controller.js","/t/controllers/keys_controller.js","/t/controllers/later_controller.js","/t/controllers/lean_controller.js","/t/controllers/log_controller.js","/t/controllers/memo_controller.js","/t/controllers/memos_controller.js","/t/controllers/menu_controller.js","/t/controllers/paper_controller.js","/t/controllers/pointto_controller.js","/t/controllers/pops_controller.js","/t/controllers/rail_controller.js","/t/controllers/richhtml_controller.js","/t/controllers/room_controller.js","/t/controllers/say_controller.js","/t/controllers/share_controller.js","/t/controllers/sheet_controller.js","/t/controllers/stack_search_controller.js","/t/controllers/title_controller.js","/t/lib/clear.js","/t/lib/keys.js","/t/lib/memo.js","/t/lib/paper.js","/t/lib/toast.js"]
const CACHE = `shell-${VERSION}`
// On the developer's machine the files change all the time: no shell cache there.
const CACHING = VERSION !== 'dev' && !['localhost', '127.0.0.1'].includes(self.location.hostname)

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    if (CACHING) { const cache = await caches.open(CACHE); await cache.addAll(SHELL) }
    await self.skipWaiting()
  })())
})
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const name of await caches.keys()) if (name.startsWith('shell-') && name !== CACHE) await caches.delete(name)
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
  const att = /^\/att\/([0-9a-f]{32})$/.exec(url.pathname)
  if (att) {
    event.respondWith((async () => {
      const got = await fromPage(att[1], event.clientId || event.resultingClientId)
      if (!got) return new Response('This file can only be opened inside the app, with the room open.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
      return new Response(got.blob, { headers: { 'Content-Type': got.type || 'application/octet-stream', 'Cache-Control': 'no-store', ...(got.name ? { 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(got.name)}` } : {}) } })
    })())
    return
  }
  // (The sandboxed frame keeps its own CSP: it never comes from the shell cache.)
  if (!CACHING || url.pathname.startsWith('/mock/') || url.pathname.startsWith('/a/')) return
  event.respondWith((async () => {
    const cache = await caches.open(CACHE)
    // A navigation inside the app gets the shell (the app routes in the page). Cloudflare serves index.html at "/";
    // "/index.html" answers with a redirect, which a navigation may not use.
    const key = event.request.mode === 'navigate' && !/\.\w+$/.test(url.pathname) ? '/' : url.pathname
    const hit = await cache.match(key)
    if (hit && key !== '/') return hit.redirected ? new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers: hit.headers }) : hit
    // The shell document alone is revalidated (one request per load, not one per file): when its ETag changed, a
    // release came, and the whole shell is fetched again and the pages are told ("A new version is ready"). dev/release.sh
    // writes the preload list into index.html, so every release changes it.
    const fresh = fetch(key === '/' ? '/' : event.request, { cache: 'no-cache' }).then(async res => {
      if (!res.ok || res.redirected) return res
      if (hit && hit.headers.get('etag') && res.headers.get('etag') && hit.headers.get('etag') !== res.headers.get('etag')) refreshShell()
      await cache.put(key, res.clone())
      return res
    })
    if (!hit) return fresh
    event.waitUntil(fresh.catch(() => {}))
    return hit.redirected ? new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers: hit.headers }) : hit
  })())
})
let refreshing = null
function refreshShell() {
  refreshing ??= (async () => {
    const cache = await caches.open(CACHE)
    await Promise.all(SHELL.map(async path => { try { const res = await fetch(path, { cache: 'no-cache' }); if (res.ok && !res.redirected) await cache.put(path, res) } catch {} }))
    for (const page of await self.clients.matchAll({ type: 'window' })) page.postMessage({ type: 'trommi-update' })
  })().finally(() => { refreshing = null })
}

self.addEventListener('push', event => {
  let message = {}
  try { message = event.data.json() } catch {}
  // The hub's loss watch: an agent with running work whose connection stayed gone for a minute (hub/server.mjs).
  if (message.kind === 'agent-lost') message = { ...message, title: 'Trommi: connection lost', body: 'An agent with running work lost its connection to Trommi.', tag: `lost-${String(message.device_id ?? '').slice(0, 16)}` }
  event.waitUntil(self.registration.showNotification(message.title || 'Trommi', {
    body: message.body || (message.urgency === 'critical' || message.urgency === 'high' ? 'Something knocks' : 'A new question'),
    tag: message.tag || 'trommi', renotify: true, icon: '/icons/trommi-192.png',
    data: { url: typeof message.url === 'string' && message.url.startsWith('/') ? message.url : '/' },
  }))
})
self.addEventListener('notificationclick', event => {
  event.notification.close()
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href
  event.waitUntil((async () => {
    const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const page = pages[0]
    if (!page) return self.clients.openWindow(url)
    await page.focus().catch(() => {})
    if (page.url !== url) await page.navigate(url).catch(() => self.clients.openWindow(url))
  })())
})
