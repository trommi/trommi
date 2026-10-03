// "Push on this device" (docs/push.md): a notification from the browser's push service when a card knocks, also
// when the board is closed. This module stands alone: it imports nothing from the board's other modules, brings its
// own few styles (css/push.css) and wires itself to the element with the id "push-toggle", wherever a page has one.
//
// The switch asks for the permission on the click (a browser gives it only then), registers the service worker
// (/sw.js: push and the tap on a notification, nothing else), subscribes and hands the subscription to the hub.
// On, it shows what a notification may say: the card's title (the default, card Nr. 185) or only "Something
// knocks", and whether a new card rings too while no board has been open for five minutes (the default, card Nr. 186).

const post = async (path, body) => {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `the hub answered ${res.status}`)
  return data
}
const bytes = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0))
const apple = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const installed = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches
const able = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
/** Why push cannot be switched on here, in one line; '' when it can. */
export const pushObstacle = () => {
  if (!window.isSecureContext) return 'Push needs the board under its https address.'
  if (apple && !installed()) return 'On the iPhone the board must be on the Home Screen first: Share, then "Add to Home Screen"; open it from there and switch push on.'
  if (!able()) return 'This browser has no push.'
  if (Notification.permission === 'denied') return 'Notifications are blocked for this board; allow them in the settings of the browser or the device.'
  return ''
}

const subscriptionOf = async () => (await navigator.serviceWorker.getRegistration('/'))?.pushManager.getSubscription() ?? null

/** Wire the switch. Safe to call again for the same element. */
export function mountPush(toggle) {
  if (!toggle || toggle.dataset.push) return
  toggle.dataset.push = '1'
  if (!document.querySelector('link[data-push-css]')) {
    const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: new URL('../css/push.css', import.meta.url).href })
    css.dataset.pushCss = '1'
    document.head.append(css)
  }
  const row = (id, text, kind = 'menuitemcheckbox') => {
    const b = Object.assign(document.createElement('button'), { type: 'button', id, className: kind === 'menuitem' ? 'push-sub' : 'push-row push-sub', hidden: true })
    b.setAttribute('role', kind)
    b.append(Object.assign(document.createElement('span'), { className: 'menu-word', textContent: text }))
    return b
  }
  toggle.classList.add('push-row')
  toggle.setAttribute('role', 'menuitemcheckbox')
  if (!toggle.querySelector('.menu-word')) toggle.append(Object.assign(document.createElement('span'), { className: 'menu-word', textContent: 'Push on this device' }))
  const title = row('push-title', 'Show the card title')
  const all = row('push-away', 'New cards when I am away')
  const test = row('push-test', 'Send a test', 'menuitem')
  const note = Object.assign(document.createElement('p'), { className: 'push-note', id: 'push-note' })
  note.setAttribute('role', 'status')
  toggle.after(title, all, test, note)

  let sub = null
  let prefs = { title: true, away: true }
  const paint = () => {
    toggle.setAttribute('aria-checked', String(Boolean(sub)))
    toggle.title = `Push on this device: ${sub ? 'on' : 'off'}. A notification when a card knocks, also when the board is closed.`
    title.setAttribute('aria-checked', String(prefs.title))
    all.setAttribute('aria-checked', String(prefs.away))
    for (const b of [title, all, test]) b.hidden = !sub
  }
  const say = text => { note.textContent = text }
  const keys = () => { const j = sub.toJSON(); return { endpoint: j.endpoint, keys: j.keys, ...prefs } }
  // Every click stays in the menu, and one thing happens at a time.
  const on = (button, work) => button.addEventListener('click', async e => {
    e.stopPropagation()
    if (toggle.getAttribute('aria-busy') === 'true') return
    toggle.setAttribute('aria-busy', 'true')
    try { await work() } catch (err) { say(`Push: ${err.message}`) }
    toggle.removeAttribute('aria-busy')
    paint()
  })

  on(toggle, async () => {
    say('')
    if (sub) {
      const endpoint = sub.endpoint
      await sub.unsubscribe().catch(() => {})
      sub = null
      await post('/push/unsubscribe', { endpoint })
      return
    }
    const obstacle = pushObstacle()
    if (obstacle) return say(obstacle)
    // First thing after the click: Safari gives the permission only while the tap is still "now".
    if (await Notification.requestPermission() !== 'granted') return say(pushObstacle() || 'Without the permission there is no push.')
    await navigator.serviceWorker.register('/sw.js', { scope: '/' })
    const reg = await navigator.serviceWorker.ready
    const { key } = await fetch('/push/key').then(res => res.json()).catch(() => ({}))
    // A hub started before push was built does not know the route yet.
    if (!key) throw new Error('the hub has no push yet; it comes with its next restart.')
    // A subscription made for another key (the hub's data was replaced) cannot be reused.
    await (await reg.pushManager.getSubscription())?.unsubscribe().catch(() => {})
    const made = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(key) })
    sub = made
    try { await post('/push/subscribe', keys()) } catch (err) { sub = null; await made.unsubscribe().catch(() => {}); throw err }
    say('On. A knock always rings; a new card only when no board has been open for five minutes.')
  })
  const pref = name => async () => {
    const next = { ...prefs, [name]: !prefs[name] }
    await post('/push/subscribe', { ...keys(), ...next })
    prefs = next
  }
  on(title, pref('title'))
  on(all, pref('away'))
  on(test, async () => { await post('/push/test', { endpoint: sub.endpoint }); say('Sent. It should arrive in a moment.') })

  paint()
  // What is already so: this browser's subscription, and what the hub holds for it.
  if (able()) subscriptionOf().then(async found => {
    if (!found) return
    sub = found
    let held = await post('/push/state', { endpoint: found.endpoint })
    // The hub lost it (its data was replaced): hand it over again.
    if (!held.subscribed) held = await post('/push/subscribe', keys())
    prefs = { title: held.title, away: held.away }
    paint()
  }).catch(() => {})
}

const mount = () => mountPush(document.getElementById('push-toggle'))
mount()
// A page that swaps its body (Turbo) brings a new switch.
document.addEventListener('turbo:load', mount)
