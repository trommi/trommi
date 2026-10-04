// The room's own screens: founding a room (the first device, the recovery code shown once and confirmed), joining
// with an invite link (/join#v1.<hub>.<room>.<secret>, the six-digit check code), the devices of the room (remove),
// and inviting a device or an agent (/pair: the link, the code typed here, the agent's ready-to-paste command).
// Sober on purpose (no pen drawings): this is about keys, not the board.
import { html, raw } from '../views/html.mjs'
import { BELL } from './layout.mjs'

const read = (k, f = null) => { try { return localStorage.getItem(k) ?? f } catch { return f } }
const write = (k, v) => { try { localStorage.setItem(k, v) } catch {} }
const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
/** The hub this app talks to: ?hub=… (remembered), else https://hub.trommi.com (local dev: http://127.0.0.1:8890). */
export function hubUrl() {
  const asked = new URLSearchParams(location.search).get('hub')
  if (asked) write('trommi-hub', asked.replace(/\/+$/, ''))
  return read('trommi-hub') || (local ? 'http://127.0.0.1:8890' : 'https://hub.trommi.com')
}
const deviceGuess = () => (/iPhone|Android.*Mobile/.test(navigator.userAgent) ? 'Phone' : /iPad|Android/.test(navigator.userAgent) ? 'Tablet' : 'Laptop')
const ago = ts => { const s = Math.round((Date.now() - ts) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago` }
const shell = (title, inner, cls = '') => html`<main id="room" class="room${cls ? ` ${cls}` : ''}" aria-label="${title}"><header class="room-head"><span class="room-bell">${BELL}</span><h2>${title}</h2></header>${inner}</main>`

// ---- inside a room: devices and pairing (pages of the board, rendered like any other) ----
export function roomPages(client) {
  return t => {
    const m = () => client.model
    const page = (req, res, title, main, view = 'room') => t.page(req, res, { title: `${title} · Trommi`, view, css: 'room', main })
    const member = d => {
      const me = d.is_me, human = d.device_role === 'human'
      return html`<li class="room-device${d.is_active ? '' : ' is-removed'}" id="device-${d.device_id}">
<span class="room-device-dot" data-online="${d.is_online ? 'yes' : 'no'}" title="${d.is_online ? 'online' : 'away'}"></span>
<span class="room-device-name"><b>${d.device_name || (human ? 'Device' : 'Agent')}</b>${me ? html` <em>this device</em>` : ''}<small>${human ? 'Person' : 'Agent'} · ${d.device_id.slice(0, 8)}${d.is_active ? '' : ' · removed'}</small></span>
${d.is_active && !me && m().room.my_role === 'human' ? html`<form method="post" action="/devices/remove" class="room-remove"><input type="hidden" name="device_id" value="${d.device_id}"><details><summary>Remove</summary><p>${human ? 'This device can then open nothing new. A new key epoch starts for everyone who stays.' : 'The agent can then open nothing new.'}</p><button type="submit" class="room-danger">Remove ${d.device_name || 'device'}</button></details></form>` : ''}
</li>`
    }
    const devicesMain = (error = '') => {
      const list = [...m().members.values()].sort((a, b) => (b.is_active - a.is_active) || (a.device_role === b.device_role ? a.added_entry_number - b.added_entry_number : a.device_role === 'human' ? -1 : 1))
      return shell('Devices', html`<p class="room-lead">Everyone in this room: your devices and the agents. Each holds its own keys; the hub sees only sealed envelopes.</p>
${error ? html`<p class="room-error" role="alert">${error}</p>` : ''}
<ul class="room-devices">${list.map(member)}</ul>
<div class="room-actions"><form method="post" action="/pair"><input type="hidden" name="role" value="human"><button type="submit" class="room-primary">Add a device</button></form><form method="post" action="/pair"><input type="hidden" name="role" value="agent"><button type="submit">Invite an agent</button></form></div>
<p class="room-meta">Room ${m().room.room_id.slice(0, 16)}… · key epoch ${m().room.key_epoch} · hub ${m().room.hub_url}</p>`)
    }
    t.get(/^\/devices$/, ({ req, res }) => page(req, res, 'Devices', devicesMain()))
    t.post(/^\/devices\/remove$/, async ({ req, res, form }) => {
      try { await client.removeDevices([String(form.get('device_id'))]) } catch (err) { return page(req, res, 'Devices', devicesMain(`Not removed: ${err.message}`)) }
      t.redirect(res, '/devices')
    })
    t.post(/^\/pair$/, async ({ req, res, form }) => {
      try {
        const invite = await client.createInvite({ device_role: form.get('role') === 'agent' ? 'agent' : 'human', app_url: `${location.origin}/join` })
        t.redirect(res, `/pair/${invite.invite_id}`)
      } catch (err) { page(req, res, 'Devices', devicesMain(`No invite: ${err.message}`)) }
    })
    const inviteMain = (inv, error = '') => {
      if (!inv) return shell('Invite', html`<p class="room-lead">This invite is gone. <a href="/devices" data-nav>Back to the devices</a></p>`)
      const agent = inv.device_role === 'agent'
      const state = inv.invite_state
      const linkBox = html`<div class="room-link"><input readonly value="${inv.link}" aria-label="Invite link" id="invite-link"><button type="button" data-controller="copy" data-copy-text-value="${inv.link}" data-action="copy#copy"><span data-copy-target="label">Copy</span></button></div>`
      let body
      if (state === 'open') body = agent
        ? html`<p class="room-lead">Give this to the Claude Code session that should join. Either paste it into the session:</p><div class="room-link"><input readonly value="join this: ${inv.link}" aria-label="Text for the session"><button type="button" data-controller="copy" data-copy-text-value="join this: ${inv.link}" data-action="copy#copy"><span data-copy-target="label">Copy</span></button></div><p class="room-lead">or run it in the session's folder:</p><div class="room-link"><input readonly value="node hub/channel.mjs join '${inv.link}'" aria-label="Command"><button type="button" data-controller="copy" data-copy-text-value="node hub/channel.mjs join '${inv.link}'" data-action="copy#copy"><span data-copy-target="label">Copy</span></button></div><p class="room-wait">Waiting for the agent… The link works once, for 10 minutes. An agent needs no check code.</p>`
        : html`<p class="room-lead">Open this link on the new device (send it to yourself; it never reaches a server: the secret is after the #).</p>${linkBox}<p class="room-wait">Waiting for the new device… The link works once, for 10 minutes.</p>`
      else if (state === 'confirm_code') body = html`<p class="room-lead"><b>${inv.newcomer?.device_name ?? 'A device'}</b> wants to join. Type the six digits it shows:</p>
<form method="post" action="/pair/${inv.invite_id}/confirm" class="room-code-form"><input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus aria-label="Check code" class="room-code-input"><button type="submit" class="room-primary">Add</button></form>
${error ? html`<p class="room-error" role="alert">${error}</p>` : ''}<p class="room-meta">A wrong code burns the invite; then make a new one.</p>`
      else if (state === 'adding') body = html`<p class="room-wait">Adding ${inv.newcomer?.device_name ?? 'the device'}…</p>`
      else if (state === 'joined') body = html`<p class="room-lead room-ok">${inv.newcomer?.device_name ?? 'The device'} is in the room.</p><p><a href="/devices" data-nav>Back to the devices</a></p>`
      else body = html`<p class="room-error" role="alert">${state === 'expired' ? 'The invite expired.' : `The invite failed${inv.error ? ` (${inv.error})` : ''}.`}</p>${error ? html`<p class="room-error">${error}</p>` : ''}<p><a href="/devices" data-nav>Back to the devices</a></p>`
      return shell(agent ? 'Invite an agent' : 'Add a device', html`<div id="invite-${inv.invite_id}" data-state="${state}">${body}</div>`)
    }
    t.get(/^\/pair\/([0-9a-f]+)$/, ({ req, res, match }) => {
      const inv = m().invites.get(match[1])
      t.page(req, res, { title: 'Invite · Trommi', view: 'invite', css: 'room', stream: `&invite=${match[1]}`, main: inviteMain(inv) })
    })
    t.post(/^\/pair\/([0-9a-f]+)\/confirm$/, async ({ req, res, match, form }) => {
      const inv = m().invites.get(match[1])
      try { await client.confirmInvite(match[1], String(form.get('code') ?? '').replace(/\D/g, '')) } catch (err) { return t.page(req, res, { title: 'Invite · Trommi', view: 'invite', css: 'room', stream: `&invite=${match[1]}`, main: inviteMain(m().invites.get(match[1]) ?? inv, err.message) }, 422) }
      t.redirect(res, `/pair/${match[1]}`)
    })
    t.live('invite', {
      take: (mm, clients) => new Map(clients.map(c => c.params.get('invite')).filter(Boolean).map(id => [id, String(inviteMain(m().invites.get(id)))])),
      diff: (was, now, client) => { const id = client.params.get('invite'); return was.get(id) !== now.get(id) ? String(t.stream('refresh')) : '' },
    })
    // A join link opened on a device that is in a room already.
    t.get(/^\/join$/, ({ req, res }) => page(req, res, 'Join', shell('Join', html`<p class="room-lead">This device is in a room already. To add another device, open <a href="/devices" data-nav>Devices</a> here and choose "Add a device".</p>`)))
  }
}

// ---- before a room: found or join (a screen of its own, before the board exists) ----
export async function roomScreen({ start, hub }) {
  document.title = 'Trommi'
  for (const link of document.querySelectorAll('link[data-sheet]')) link.disabled = !['tokens', 'app', 'back', 'logo', 'links', 'keys', 'turbo', 'fonts', 'trommi'].includes(link.dataset.sheet)
  const root = document.createElement('div')
  root.id = 'room-screen'
  document.body.replaceChildren(root)
  const show = (markup) => { root.innerHTML = String(markup) }
  const core = async () => import('/vendor/index.mjs')
  const storage = async () => (await core()).idbStorage({ name: 'trommi', prefix: 'room/' })
  const done = async client => { root.remove(); history.replaceState(null, '', '/'); await start(client, { fresh: true }) }

  if (location.pathname === '/join' && location.hash.length > 1) return joinFlow()
  welcome()

  function welcome(error = '') {
    show(shell('Trommi', html`<p class="room-lead">Questions from your agents, answered from any device. Everything is end-to-end encrypted: the hub only carries sealed envelopes.</p>
${error ? html`<p class="room-error" role="alert">${error}</p>` : ''}
<form id="found-form" class="room-form"><label>Name of this device<input name="device_name" value="${deviceGuess()}" maxlength="40" required></label>
<details class="room-more"><summary>Hub and founding code</summary><label>Hub<input name="hub" value="${hub}"></label><label>Founding code (if the hub asks for one)<input name="found_token" autocomplete="off"></label></details>
<button type="submit" class="room-primary">Found a new room</button></form>
<p class="room-meta">Already have a room? On a device that is in it, open Devices → "Add a device" and open the link here.</p>`, 'room-welcome'))
    root.querySelector('#found-form').addEventListener('submit', async e => {
      e.preventDefault()
      const f = new FormData(e.target)
      const button = e.target.querySelector('button[type="submit"]')
      button.disabled = true; button.textContent = 'Making keys…'
      try {
        const hub_url = String(f.get('hub') || hub).replace(/\/+$/, '')
        write('trommi-hub', hub_url)
        const { foundRoom } = await core()
        const { client, recovery_code } = await foundRoom({ hub_url, device_name: String(f.get('device_name')), storage: await storage(), found_token: String(f.get('found_token') || '') || undefined })
        recovery(client, recovery_code)
      } catch (err) { console.error(err); welcome(`The room was not founded: ${err.message}`) }
    })
  }
  function recovery(client, code) {
    show(shell('Your recovery code', html`<p class="room-lead">This code is the only way back into the room if you lose every device. It is shown <b>once</b>. Write it on paper or put it in your password manager.</p>
<p class="room-recovery" id="recovery-code">${code}</p>
<div class="room-actions"><button type="button" id="recovery-copy">Copy</button></div>
<form id="recovery-form" class="room-form"><label class="room-check"><input type="checkbox" name="kept" required> I have kept the recovery code somewhere safe.</label><button type="submit" class="room-primary">Open the room</button></form>`))
    root.querySelector('#recovery-copy').addEventListener('click', () => navigator.clipboard?.writeText(code))
    root.querySelector('#recovery-form').addEventListener('submit', e => { e.preventDefault(); code = null; done(client) })
  }
  function joinFlow(error = '') {
    show(shell('Join a room', html`<p class="room-lead">You were invited into a Trommi room. This device makes its own keys; the device that invited you will ask for a six-digit code.</p>
${error ? html`<p class="room-error" role="alert">${error}</p>` : ''}
<form id="join-form" class="room-form"><label>Name of this device<input name="device_name" value="${deviceGuess()}" maxlength="40" required></label><button type="submit" class="room-primary">Join</button></form>`))
    root.querySelector('#join-form').addEventListener('submit', async e => {
      e.preventDefault()
      const link = location.href
      const name = String(new FormData(e.target).get('device_name'))
      show(shell('Join a room', html`<p class="room-wait">Asking the inviting device…</p>`))
      try {
        const { joinRoom } = await core()
        const join = await joinRoom({ link, device_name: name, storage: await storage() })
        history.replaceState(null, '', '/join')   // the secret leaves the address bar
        join.check_code.then(code => show(shell('Join a room', html`<p class="room-lead">Type this code on the device that invited you:</p><p class="room-code" id="check-code">${code.slice(0, 3)} ${code.slice(3)}</p><p class="room-wait">Waiting until it adds this device…</p>`)))
        const client = await join.client
        await done(client)
      } catch (err) { console.error(err); joinFlow(`Not joined: ${err.message}`) }
    })
  }
}
export { ago, raw }
