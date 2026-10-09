// The shell has no service worker. A browser that used an earlier app still has that app's service worker and its
// cached files and would go on showing them; it fetches this file when it looks for an update. This one takes over at
// once, deletes the caches, removes itself and loads the open pages again from the network. It touches nothing else
// (no storage of the app).
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys()) await caches.delete(key)
  await self.registration.unregister()
  for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate(client.url).catch(() => {})
})()))
