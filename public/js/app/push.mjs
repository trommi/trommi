// "Push on this device": the menu's bell (#push-toggle). On: asks for the permission (only a click may), subscribes
// with the hub's VAPID key and hands the subscription to the hub through the core. The hub pushes only
// { room_id, envelope_number, urgency }; the service worker shows "Es klopft" or "Neue Frage" (public/sw.js).
const bytes = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0))
const apple = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const installed = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches
const obstacle = () => {
  if (!window.isSecureContext) return 'Push braucht die https-Adresse der App.'
  if (apple && !installed()) return 'Auf dem iPhone zuerst zum Home-Bildschirm hinzufügen und von dort öffnen.'
  if (!('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window)) return 'Dieser Browser kann kein Push.'
  if (Notification.permission === 'denied') return 'Mitteilungen sind für die App blockiert (Browser-Einstellungen).'
  return ''
}
const subscription = async () => (await navigator.serviceWorker?.getRegistration('/'))?.pushManager.getSubscription() ?? null

export function startPush(client) {
  const wire = async () => {
    const toggle = document.getElementById('push-toggle')
    if (!toggle || toggle.dataset.push) return
    toggle.dataset.push = '1'
    toggle.classList.add('push-row')
    if (!toggle.querySelector('.menu-word')) toggle.append(Object.assign(document.createElement('span'), { className: 'menu-word', textContent: 'Push on this device' }))
    const note = Object.assign(document.createElement('p'), { className: 'push-note', role: 'status' })
    toggle.after(note)
    const paint = sub => { toggle.setAttribute('aria-checked', String(Boolean(sub))); toggle.title = `Push on this device: ${sub ? 'on' : 'off'}` }
    paint(await subscription().catch(() => null))
    toggle.addEventListener('click', async e => {
      e.stopPropagation()
      if (toggle.getAttribute('aria-busy') === 'true') return
      toggle.setAttribute('aria-busy', 'true')
      note.textContent = ''
      try {
        const had = await subscription()
        if (had) {
          await client.pushSubscribe(had.toJSON(), true).catch(() => {})
          await had.unsubscribe()
          paint(null)
        } else {
          if (!client.hub?.pushKey) throw new Error('Im Testraum gibt es kein Push.')
          const why = obstacle()
          if (why) throw new Error(why)
          if ((await Notification.requestPermission()) !== 'granted') throw new Error('Mitteilungen wurden nicht erlaubt.')
          const reg = await navigator.serviceWorker.register('/sw.js')
          await navigator.serviceWorker.ready
          const { vapid_public_key } = await client.hub.pushKey()
          const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(vapid_public_key) })
          await client.pushSubscribe(sub.toJSON())
          paint(sub)
        }
      } catch (err) { note.textContent = err.message }
      toggle.removeAttribute('aria-busy')
    })
  }
  document.addEventListener('turbo:load', wire)
  document.addEventListener('turbo:render', wire)
  wire()
}
