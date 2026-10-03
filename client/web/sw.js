// The board's service worker (docs/push.md). It does two things and nothing else: it shows the notification a push
// brings, and a tap on it opens the card. It has no fetch handler and keeps no cache: every page and every file
// comes from the hub exactly as without it.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))

self.addEventListener('push', event => {
  let message = {}
  try { message = event.data.json() } catch {}
  // Always shown: a browser takes the subscription away from a page whose pushes show nothing.
  event.waitUntil(self.registration.showNotification(message.title || 'Trommi', {
    body: message.body || 'Something knocks',
    // One notification per card: a later one for the same card takes the place of the earlier one.
    tag: message.tag || 'trommi',
    renotify: true,
    icon: '/icons/trommi-192.png',
    data: { url: typeof message.url === 'string' && message.url.startsWith('/') ? message.url : '/' },
  }))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href
  event.waitUntil((async () => {
    const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const page = pages.find(p => p.url === url) ?? pages[0]
    if (!page) return self.clients.openWindow(url)
    await page.focus().catch(() => {})
    if (page.url !== url) await page.navigate(url).catch(() => self.clients.openWindow(url))
  })())
})
