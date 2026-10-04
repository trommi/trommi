// The room's own screens. Inside a room (pages of the board): /devices (who is in the room, the two ways to add a
// device, inviting an agent, removing), /pair/:id (the QR code, then "Add a new device?" with four codes to tap),
// /settings (sign-in with a password, storage, recovery, the room address). Before a room (a screen of its own): found a
// room (recovery code once, confirmed), pair this device (scan or open the link, show the code), sign in with a
// password, recover with the code. Calm and sober: this is about keys; pen drawings only on the two choice buttons.
// Core features that may not be there yet (escrow, usage, session handover) are shown only when the core has them.
import { html, raw } from '../views/html.mjs'
import { sketchSvg, doodleSvg } from '../pen.js'
import { BELL } from './layout.mjs'
import { CLIENT } from './version.mjs'
import { qrSvg } from './qr.mjs'
import { passphraseProblem as corePassphraseProblem, generatePassphrase } from '/vendor/escrow.mjs'

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
const sk = name => raw(['phone', 'house'].includes(name) ? doodleSvg(`draw:${name}`) : sketchSvg(name))
const has = (o, fn) => typeof o?.[fn] === 'function'
const code6 = c => `${String(c).slice(0, 3)} ${String(c).slice(3)}`
// The core's passphrase rule; its reasons in the app's words.
const PROBLEM = { 'at least six words (or take the generated passphrase)': 'At least six words, or take the generated one.', 'too repetitive': 'Too repetitive.' }
/** null if the passphrase is good enough, else why not. */
export function passphraseProblem(p) {
  p = String(p ?? '')
  const why = corePassphraseProblem(p)
  return why ? (PROBLEM[why] ?? why) : null
}
/** Signing in with a password on a fresh browser waits for the hub and crypto side (A); ?pwlogin shows it early. */
const PASSWORD_LOGIN = new URLSearchParams(location.search).has('pwlogin')
// A generated passphrase is offered (visible, to be written down like the recovery code); an own one needs six words.
const pwFields = () => { const g = generatePassphrase(); return html`<label>Password<input type="text" name="passphrase" value="${g}" autocomplete="off" spellcheck="false" required minlength="24" data-room-target="pass" class="room-mono"><small class="room-hint">Generated for you: write it down, it is shown only here. Or type six words of your own.</small></label>
<label>Once more<input type="text" name="again" value="${g}" autocomplete="off" spellcheck="false" required data-room-target="again" class="room-mono"></label>
<p class="room-strength" data-room-target="meter" data-level="2" aria-live="polite">Strong enough.</p>` }
const TRADE_OFF = 'Convenient, but whoever knows the room address and the password gets in. Take a long sentence only you know.'
const shell = (title, inner, cls = '') => html`<main id="room" class="room${cls ? ` ${cls}` : ''}" aria-label="${title}"><header class="room-head"><span class="room-bell">${BELL}</span><h2>${title}</h2></header>${inner}</main>`
const tabs = on => html`<nav class="room-tabs" aria-label="Devices and settings"><a href="/devices" data-nav${on === 'devices' ? raw(' aria-current="page"') : ''}>Devices</a><a href="/settings" data-nav${on === 'settings' ? raw(' aria-current="page"') : ''}>Settings</a></nav>`
const copyBox = (value, label, cls = '') => html`<div class="room-link${cls ? ` ${cls}` : ''}" data-controller="room"><input readonly value="${value}" aria-label="${label}" data-room-target="field" data-action="focus->room#select"><button type="button" data-action="room#copy" data-room-text-param="${value}"><span data-room-target="label">Copy</span></button></div>`
const errorLine = e => (e ? html`<p class="room-error" role="alert">${e}</p>` : '')
const sessionName = s => s.settings?.name || s.profile?.agent_name || s.agent_session_id || s.device_name || 'Session'

// ---- inside a room: devices, pairing, settings (pages of the board, rendered like any other) ----
export function roomPages(client) {
  // What an agent invite should do once the agent joined (session handover; kept in this tab only).
  const handovers = new Map()
  let core = null   // the core's helpers (roomLink); the mock room has none
  import('/vendor/index.mjs').then(x => { core = x }).catch(() => {})
  return t => {
    const m = () => client.model
    const page = (req, res, title, main, extra = {}, code = 200) => t.page(req, res, { title: `${title} · Trommi`, view: 'room', css: 'room', main, ...extra }, code)
    const isHuman = () => m().room.my_role === 'human'
    const fp = d => d.fingerprint || d.device_id.slice(0, 16).replace(/(.{4})(?!$)/g, '$1 ')

    // ---- /devices ----
    const member = d => {
      const me = d.is_me, human = d.device_role === 'human', name = d.device_name || (human ? 'Device' : 'Agent')
      const canRemove = d.is_active && !me && isHuman()
      return html`<li class="room-device${d.is_active ? '' : ' is-removed'}" id="device-${d.device_id}">
<span class="room-device-dot" data-online="${d.is_online ? 'yes' : 'no'}" title="${d.is_online ? 'online' : 'away'}"></span>
<span class="room-device-name"><b>${name}</b>${me ? html` <em>this device</em>` : ''}<small>${human ? 'Person' : 'Agent'} · <span class="room-fp" title="Key fingerprint from the signed member list">${fp(d)}</span>${d.is_active ? '' : ' · removed'}</small></span>
${canRemove ? html`<form method="post" action="/devices/remove" class="room-remove"><input type="hidden" name="device_id" value="${d.device_id}"><details><summary>Remove</summary><p>${human
        ? html`${name} can open nothing new after this. Everyone else gets a new room key; that takes a moment.`
        : html`${name} can read nothing new after this. The others get a new room key; the session's history stays.`}</p><button type="submit" class="room-danger">Remove ${name}</button></details></form>` : ''}</li>`
    }
    // The earlier conversation stays closed unless the human opens it (security review: agent invites without history).
    const historyAsk = () => html`<fieldset class="room-history"><legend>May it read the earlier conversation?</legend><label><input type="radio" name="with_history" value="no" checked> No</label><label><input type="radio" name="with_history" value="yes"> Yes</label></fieldset>`
    const sessionOptions = (except = null) => [...m().sessions.values()].filter(s => s.agent_device_id !== except).map(s => html`<option value="${s.agent_session_id || s.agent_device_id}">${sessionName(s)}</option>`)
    // Hand a session to an agent that is in the room: one form under the agents (not one per row: big rooms).
    const handoverForm = agents => html`<details class="room-more room-handover"><summary>Hand a session to an agent</summary><form method="post" action="/devices/handover" class="room-form">
<label>Agent<select name="agent_device_id" required>${agents.map(d => html`<option value="${d.device_id}">${d.device_name || 'Agent'} · ${fp(d)}</option>`)}</select></label>
<label>Session<select name="session_id" required>${sessionOptions()}</select></label>${historyAsk()}<button type="submit" class="room-primary">Hand over</button></form></details>`
    // The three lists, each one element with an id, so a change replaces only the list it touched.
    const lists = () => {
      const all = [...m().members.values()]
      const order = (a, b) => a.added_entry_number - b.added_entry_number
      const people = all.filter(d => d.is_active && d.device_role === 'human').sort(order)
      const agents = all.filter(d => d.is_active && d.device_role !== 'human').sort(order)
      const gone = all.filter(d => !d.is_active).sort(order)
      return {
        people: String(html`<ul class="room-devices" id="room-people">${people.map(member)}</ul>`),
        agents: String(agents.length ? html`<ul class="room-devices" id="room-agents">${agents.map(member)}</ul>` : html`<p class="room-meta" id="room-agents">No agent in the room yet.</p>`),
        gone: String(gone.length ? html`<details class="room-section room-gone" id="room-gone"><summary>Removed (${gone.length})</summary><ul class="room-devices">${gone.map(member)}</ul></details>` : html`<div id="room-gone" hidden></div>`),
      }
    }
    const devicesMain = (error = '') => {
      const L = lists(), active = [...m().members.values()].filter(d => d.is_active && d.device_role !== 'human')
      const escrow = has(client, 'setPassphrase') && PASSWORD_LOGIN
      const pw = m().room.has_passphrase
      return shell('Devices', html`${tabs('devices')}
${errorLine(error)}
${isHuman() ? html`<section class="room-section" aria-labelledby="add-head"><h3 id="add-head">Add a device</h3>
<div class="room-ways">
<form method="post" action="/pair" class="room-way"><input type="hidden" name="role" value="human"><button type="submit" class="room-way-go" id="pair-start">${sk('phone')}<b>Pair a device</b><span>A QR code appears here. The new device scans it, you tap a number. Done.</span></button></form>
${escrow ? html`<a href="/settings#passwort" data-nav class="room-way room-way-go" id="password-way">${sk('key')}<b>Sign in with a password</b><span>${pw ? 'Set up. On the new device open app.trommi.com and choose "Sign in with a password".' : 'A new browser gets in with the room address and a password. Set it up first.'}</span></a>` : ''}
</div></section>` : ''}
<section class="room-section" aria-labelledby="people-head"><h3 id="people-head">Your devices</h3>${raw(L.people)}</section>
<section class="room-section" aria-labelledby="agents-head"><h3 id="agents-head">Agents</h3>${raw(L.agents)}${isHuman() && active.length && has(client, 'assignSession') ? handoverForm(active) : ''}
${isHuman() ? html`<form method="post" action="/pair" class="room-agent-form"><input type="hidden" name="role" value="agent"><label>Name of the session<input name="label" maxlength="40" placeholder="e.g. Website" autocomplete="off"></label>${has(client, 'assignSession') && m().sessions.size ? html`<label>Takes over<select name="session_id"><option value="">a new session</option>${sessionOptions()}</select></label>${historyAsk()}` : ''}<button type="submit" id="agent-invite">Invite an agent</button></form>` : ''}</section>
${raw(L.gone)}
<p class="room-meta">Every device holds its own keys; the hub sees sealed envelopes only. The fingerprint comes from the signed member list: it must look the same on every device.</p>`)
    }
    t.get(/^\/devices$/, ({ req, res }) => page(req, res, 'Devices', devicesMain(), { stream: '&room=devices' }))
    t.post(/^\/devices\/remove$/, async ({ req, res, form }) => {
      try { await client.removeDevices([String(form.get('device_id'))]) } catch (err) { return page(req, res, 'Devices', devicesMain(`Not removed: ${err.message}`), {}, 422) }
      t.redirect(res, '/devices')
    })
    t.post(/^\/devices\/handover$/, async ({ req, res, form }) => {
      try { await client.assignSession({ session_id: String(form.get('session_id')), agent_device_id: String(form.get('agent_device_id')), with_history: form.get('with_history') === 'yes' }) } catch (err) { return page(req, res, 'Devices', devicesMain(`Not handed over: ${err.message}`), {}, 422) }
      t.redirect(res, '/devices')
    })
    t.post(/^\/pair$/, async ({ req, res, form }) => {
      try {
        const agent = form.get('role') === 'agent'
        const label = String(form.get('label') ?? '').trim() || null
        const invite = await client.createInvite({ device_role: agent ? 'agent' : 'human', app_url: `${location.origin}/join`, ...(agent && label ? { label } : {}) })
        const session_id = String(form.get('session_id') ?? '')
        if (agent && session_id) handovers.set(invite.invite_id, { session_id, with_history: form.get('with_history') === 'yes', done: false })
        t.redirect(res, `/pair/${invite.invite_id}`)
      } catch (err) { page(req, res, 'Devices', devicesMain(`No invite: ${err.message}`), {}, 422) }
    })
    t.live('room', {
      take: () => lists(),
      diff: (was, now) => ['people', 'agents', 'gone'].map(k => (was[k] !== now[k] ? String(t.stream('replace', `room-${k}`, raw(now[k]))) : '')).join(''),
    })

    // ---- /pair/:id ----
    const newcomerName = inv => (inv.newcomer && m().members.get(inv.newcomer.device_id)?.device_name) || inv.newcomer?.device_name || ''
    const again = (agent, word = 'Pair again') => html`<form method="post" action="/pair" class="room-inline"><input type="hidden" name="role" value="${agent ? 'agent' : 'human'}"><button type="submit" class="room-primary">${word}</button></form>`
    const back = html`<a href="/devices" data-nav class="room-back">Back to the devices</a>`
    const inviteMain = (inv, error = '') => {
      if (!inv) return shell('Invite', html`<p class="room-lead">This invite is gone.</p>${back}`)
      const agent = inv.device_role === 'agent', state = inv.invite_state
      const left = Math.max(0, Math.round((inv.expires_at - Date.now()) / 60000))
      let body
      // The link goes to the channel by the human's hands only (never pasted into the model's prompt).
      if (state === 'open' && agent) body = html`<p class="room-lead">Run this in the project folder of the Claude Code session that should join (<code>&lt;path&gt;</code>: where trommi-hub is checked out):</p>
${copyBox(`node <path>/hub/channel.mjs join '${inv.link}'`, 'Command', 'room-cmd')}<p class="room-lead">or start Claude Code there with the link:</p>${copyBox(`TROMMI_INVITE='${inv.link}' claude --dangerously-load-development-channels server:trommi`, 'Command', 'room-cmd')}
<p class="room-wait">Waiting for the agent… The link works once, ${left} more min. An agent needs no code.</p>`
      else if (state === 'open') body = html`<div class="room-pair"><div class="room-qr" data-controller="room">${raw(qrSvg(inv.link, 'QR code to pair'))}</div>
<ol class="room-steps"><li>On the new device, open the camera and scan the code. Or open app.trommi.com there and choose "Pair a device".</li><li>The new device shows a number. Tap the same one here.</li></ol></div>
<details class="room-more"><summary>No scanner? Send the link</summary><p class="room-meta">Send the link to yourself (a message to yourself works) and open it on the new device. The secret is after the #; it never reaches a server.</p>${copyBox(inv.link, 'Invite link')}</details>
<p class="room-wait">Waiting for the new device… The code works once, ${left} more min.</p>`
      else if (state === 'confirm_code' && inv.code_choices?.length) body = html`<p class="room-lead">A device wants to join. Which number does it show?</p>
<div class="room-choices">${inv.code_choices.map(c => html`<form method="post" action="/pair/${inv.invite_id}/confirm"><input type="hidden" name="code" value="${c}"><button type="submit" class="room-choice">${code6(c)}</button></form>`)}</div>
${errorLine(error)}<p class="room-meta">None matches? Tap nothing and go back. A wrong number burns the invite.</p>${back}`
      else if (state === 'confirm_code') body = html`<p class="room-lead">A device wants to join. Type the six digits it shows:</p>
<form method="post" action="/pair/${inv.invite_id}/confirm" class="room-code-form"><input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required autofocus aria-label="Number of the new device" class="room-code-input"><button type="submit" class="room-primary">Add</button></form>
${errorLine(error)}<p class="room-meta">A wrong number burns the invite.</p>`
      else if (state === 'adding') body = html`<p class="room-wait">Adding ${newcomerName(inv) || (agent ? 'the agent' : 'the device')}…</p>`
      else if (state === 'joined') {
        const h = handovers.get(inv.invite_id)
        body = html`<p class="room-lead room-ok">✓ ${newcomerName(inv) || (agent ? 'The agent' : 'The new device')} is in the room now.</p>${h && !h.done ? html`<p class="room-wait">Handing over the session…</p>` : ''}${h?.error ? errorLine(`Session not handed over: ${h.error}`) : ''}<a href="/devices" data-nav class="room-done">Done</a>`
      } else if (inv.error === 'code-mismatch') body = html`<p class="room-error" role="alert">Wrong number. Nobody was added; the invite is used up.</p>${again(agent)}${back}`
      else body = html`<p class="room-error" role="alert">${state === 'expired' ? 'The invite has expired.' : `That did not work${inv.error ? ` (${inv.error})` : ''}.`}</p>${errorLine(error)}${again(agent)}${back}`
      return shell(agent ? 'Invite an agent' : state === 'confirm_code' ? 'Add a new device?' : 'Pair a device', html`<div id="invite-${inv.invite_id}" class="room-invite" data-state="${state}">${body}</div>`)
    }
    // After an agent joined, hand the chosen session over once.
    const handOver = inv => {
      const h = inv && handovers.get(inv.invite_id)
      if (!h || h.started || inv.invite_state !== 'joined' || !inv.newcomer) return
      h.started = true
      client.assignSession({ session_id: h.session_id, agent_device_id: inv.newcomer.device_id, with_history: h.with_history })
        .catch(err => { h.error = err.message }).finally(() => { h.done = true })
    }
    t.get(/^\/pair\/([0-9a-f]+)$/, ({ req, res, match }) => {
      const inv = m().invites.get(match[1])
      handOver(inv)
      page(req, res, inv?.device_role === 'agent' ? 'Invite an agent' : 'Pair a device', inviteMain(inv), { view: 'invite', stream: `&invite=${match[1]}` })
    })
    t.post(/^\/pair\/([0-9a-f]+)\/confirm$/, async ({ req, res, match, form }) => {
      try { await client.confirmInvite(match[1], String(form.get('code') ?? '').replace(/\D/g, '')) } catch (err) {
        return page(req, res, 'Pair a device', inviteMain(m().invites.get(match[1]), err.code === 'code-mismatch' ? '' : err.message), { view: 'invite', stream: `&invite=${match[1]}` }, 422)
      }
      t.redirect(res, `/pair/${match[1]}`)
    })
    t.live('invite', {
      take: (mm, clients) => new Map(clients.map(c => c.params.get('invite')).filter(Boolean).map(id => { const inv = m().invites.get(id); handOver(inv); return [id, String(inviteMain(inv)).replace(/\d+ more min\./g, '')] })),
      diff: (was, now, c) => { const id = c.params.get('invite'); return was.get(id) !== now.get(id) ? String(t.stream('refresh')) : '' },
    })

    // ---- /settings ----
    const settingsMain = (error = '', said = '') => {
      const room = m().room
      const link = has(core, 'roomLink') && room.hub_url ? core.roomLink(room.hub_url, room.room_id) : null
      const escrow = has(client, 'setPassphrase'), pw = room.has_passphrase
      const pwForm = (word) => html`<form method="post" action="/settings/passphrase" class="room-form room-pw" data-controller="room" data-action="input->room#strength">
<label>Recovery code<input name="recovery_code" required autocomplete="off" spellcheck="false" class="room-mono" placeholder="XXXX-XXXX-…"><small class="room-hint">The password protects an encrypted copy of this code. It is needed only for that and not stored.</small></label>
${pwFields()}
<button type="submit" class="room-primary" data-room-target="go" disabled>${word}</button></form>`
      return shell('Settings', html`${tabs('settings')}
${errorLine(error)}${said ? html`<p class="room-lead room-ok" role="status">${said}</p>` : ''}
${escrow && isHuman() ? html`<section class="room-section" id="passwort" aria-labelledby="pw-head"><h3 id="pw-head">Sign in with a password</h3>
${pw ? html`<p class="room-lead">${PASSWORD_LOGIN ? 'Set up. A new browser gets in with the room address and this password: app.trommi.com → "Sign in with a password".' : 'Set up.'}</p>
<details class="room-more"><summary>Change the password</summary>${pwForm('Save the new password')}</details>
<form method="post" action="/settings/passphrase/off" class="room-remove"><details><summary>Turn off</summary><p>A new device then gets in by pairing only.</p><button type="submit" class="room-danger">Turn off password sign-in</button></details></form>`
        : html`<p class="room-lead">${TRADE_OFF}</p>${pw == null && has(client, 'checkPassphrase') ? html`<p class="room-wait">Checking whether one is set up…</p>` : ''}${pwForm('Set up the password')}`}
${PASSWORD_LOGIN ? '' : html`<p class="room-meta">Signing in with it on a new browser comes soon; you can set it up already.</p>`}</section>` : ''}
${link ? html`<section class="room-section" aria-labelledby="addr-head"><h3 id="addr-head">Room address</h3><p class="room-lead">For signing in with a password or the recovery code. On its own it opens nothing.</p>${copyBox(link, 'Room address')}</section>` : ''}
<section class="room-section" aria-labelledby="store-head"><h3 id="store-head">Storage</h3><dl class="room-usage" data-controller="room" data-room-usage-value="${has(client, 'usage') ? 'hub' : 'local'}"><div><dt>On this device</dt><dd data-room-target="local">…</dd></div>${has(client, 'usage') ? html`<div><dt>On the hub (encrypted)</dt><dd data-room-target="hub">…</dd></div>` : ''}</dl><p class="room-meta">The hub deletes envelopes after 30 days; your devices keep what they decrypted.</p></section>
<section class="room-section" aria-labelledby="rec-head"><h3 id="rec-head">Recovery code</h3><p class="room-lead">It was shown once, when the room was founded. If every device is gone, it brings you back: app.trommi.com → "Lost every device?". All old devices are then removed; the agents stay.</p></section>
<p class="room-meta">Room ${room.room_id.slice(0, 16)}… · key epoch ${room.key_epoch} · hub ${room.hub_url}</p>`)
    }
    let asked = false
    const askPassphrase = () => { if (!asked && has(client, 'checkPassphrase') && m().room.has_passphrase == null) { asked = true; client.checkPassphrase().catch(() => {}) } }
    t.live('settings', { take: () => m().room.has_passphrase, diff: (was, now) => (was !== now ? String(t.stream('refresh')) : '') })
    t.get(/^\/settings$/, ({ req, res, url }) => { askPassphrase(); page(req, res, 'Settings', settingsMain('', { on: 'Password sign-in set up.', off: 'Password sign-in turned off.' }[url.searchParams.get('pw')] ?? ''), { view: 'settings' }) })
    t.post(/^\/settings\/passphrase$/, async ({ req, res, form }) => {
      const p = String(form.get('passphrase') ?? '')
      const fail = e => page(req, res, 'Settings', settingsMain(e), { view: 'settings' }, 422)
      if (p !== String(form.get('again') ?? '')) return fail('The two entries differ.')
      const why = passphraseProblem(p)
      if (why) return fail(`Too weak. ${why}`)
      try { await client.setPassphrase(p, { recovery_code: String(form.get('recovery_code') ?? '').trim() }) } catch (err) {
        return fail(err.code === 'weak-passphrase' ? 'Too weak: at least six words.' : err.code === 'bad-recovery-code' ? 'This recovery code does not belong to this room.' : `Not saved: ${err.message}`)
      }
      t.redirect(res, '/settings?pw=on')
    })
    t.post(/^\/settings\/passphrase\/off$/, async ({ req, res }) => {
      try { await client.removePassphrase() } catch (err) { return page(req, res, 'Settings', settingsMain(`Not turned off: ${err.message}`), { view: 'settings' }, 422) }
      t.redirect(res, '/settings?pw=off')
    })

    // A join link opened on a device that is in a room already.
    t.get(/^\/(?:join|login)$/, ({ req, res }) => page(req, res, 'Pair a device', shell('Already in a room', html`<p class="room-lead">This device is in a room already. Pair another device under <a href="/devices" data-nav>Devices</a>.</p>`)))
  }
}

// ---- before a room: a screen of its own, before the board exists ----
export async function roomScreen({ start, hub }) {
  document.title = 'Trommi'
  for (const link of document.querySelectorAll('link[data-sheet]')) link.disabled = !['tokens', 'app', 'back', 'logo', 'links', 'keys', 'turbo', 'fonts', 'trommi', 'room'].includes(link.dataset.sheet)
  const root = document.createElement('div')
  root.id = 'room-screen'
  document.body.replaceChildren(root)
  let stopScan = null
  const show = (markup, focus = 'input:not([type=hidden]), button.room-primary') => {
    stopScan?.(); stopScan = null
    root.innerHTML = String(markup)
    if (focus) root.querySelector(focus)?.focus({ preventScroll: true })
  }
  const core = async () => import('/vendor/index.mjs')
  const storage = async () => (await core()).idbStorage({ name: 'trommi', prefix: 'room/' })
  const done = async client => { root.remove(); history.replaceState(null, '', '/'); await start(client, { fresh: true }) }
  const on = (sel, ev, fn) => root.querySelector(sel)?.addEventListener(ev, fn)
  const backLink = html`<p class="room-meta"><a href="/" id="room-home">Back</a></p>`
  const wireBack = () => on('#room-home', 'click', e => { e.preventDefault(); history.replaceState(null, '', '/'); welcome() })
  const busy = (form, word) => { const b = form.querySelector('button[type="submit"]'); b.disabled = true; b.textContent = word }
  const nameField = html`<label>Name of this device<input name="device_name" value="${deviceGuess()}" maxlength="40" required></label>`
  const c = await core().catch(() => ({}))

  if (location.pathname === '/join' && location.hash.length > 1) return joinFlow()
  if (location.pathname === '/login' && location.hash.length > 1 && c.loginWithPassphrase && PASSWORD_LOGIN) return passwordFlow()
  if (location.pathname === '/recover') recoverFlow()
  else welcome()

  function welcome(error = '') {
    show(shell('Trommi', html`<p class="room-lead">Your agents ask, you answer, from any device. End-to-end encrypted: the hub carries sealed envelopes only.</p>
${errorLine(error)}
<div class="room-ways room-ways-first">
<button type="button" class="room-way room-way-go" id="way-pair">${sk('phone')}<b>Pair this device</b><span>Trommi runs on another device already? Show a QR code there and scan it here.</span></button>
${c.loginWithPassphrase && PASSWORD_LOGIN ? html`<button type="button" class="room-way room-way-go" id="way-password">${sk('key')}<b>Sign in with a password</b><span>With the room address and the password, if you set one up.</span></button>` : ''}
<button type="button" class="room-way room-way-go" id="way-found">${sk('house')}<b>Found a new room</b><span>First time here? This device founds your room.</span></button>
</div>
<p class="room-meta"><a href="/recover" id="way-recover">Lost every device? Come back with the recovery code</a></p>`, 'room-welcome'), null)
    on('#way-pair', 'click', () => scanFlow())
    on('#way-password', 'click', () => passwordFlow())
    on('#way-found', 'click', () => foundFlow())
    on('#way-recover', 'click', e => { e.preventDefault(); recoverFlow() })
  }

  function foundFlow(error = '') {
    show(shell('Found a new room', html`<p class="room-lead">This device makes the room's keys. Then you see your recovery code, once.</p>
${errorLine(error)}<form id="found-form" class="room-form">${nameField}
<details class="room-more"><summary>Hub and founding code</summary><label>Hub<input name="hub" value="${hub}"></label><label>Founding code (if the hub asks for one)<input name="found_token" autocomplete="off"></label></details>
<button type="submit" class="room-primary">Found the room</button></form>${backLink}`), '#found-form button[type=submit]')
    wireBack()
    on('#found-form', 'submit', async e => {
      e.preventDefault()
      const f = new FormData(e.target)
      busy(e.target, 'Making keys…')
      try {
        const hub_url = String(f.get('hub') || hub).replace(/\/+$/, '')
        write('trommi-hub', hub_url)
        const { client, recovery_code } = await c.foundRoom({ hub_url, device_name: String(f.get('device_name')), storage: await storage(), found_token: String(f.get('found_token') || '') || undefined, client: CLIENT })
        recovery(client, recovery_code)
      } catch (err) { console.error(err); foundFlow(`The room was not founded: ${err.message}`) }
    })
  }

  // The recovery code, shown once; the room opens only after the human confirmed keeping it.
  function recovery(client, code, fresh = true) {
    show(shell('Your recovery code', html`<p class="room-lead">${fresh ? 'This code brings you back into the room if every device is gone.' : 'The old code no longer works. This is the new one.'} It is shown <b>only now</b>. Write it on paper or put it in your password manager.</p>
<p class="room-recovery" id="recovery-code">${code}</p>
<div class="room-actions"><button type="button" id="recovery-copy">Copy</button></div>
<form id="recovery-form" class="room-form"><label class="room-check"><input type="checkbox" name="kept" required> I have kept the code somewhere safe.</label>
${has(client, 'setPassphrase') && PASSWORD_LOGIN ? html`<details class="room-more" id="recovery-pw" data-controller="room" data-action="input->room#strength"><summary>Also allow signing in with a password (optional)</summary><p class="room-meta">${TRADE_OFF}</p>${pwFields()}<input type="hidden" data-room-target="go"></details>` : ''}
<button type="submit" class="room-primary">Open the room</button></form>`), '#recovery-copy')
    on('#recovery-copy', 'click', async e => { try { await navigator.clipboard.writeText(code); e.target.textContent = 'Copied' } catch { e.target.textContent = 'Please write it down' } })
    on('#recovery-form', 'submit', async e => {
      e.preventDefault()
      const f = new FormData(e.target), p = String(f.get('passphrase') ?? '')
      if (p) {
        const why = passphraseProblem(p) ?? (p !== f.get('again') ? 'The two entries differ.' : null)
        const out = root.querySelector('.room-strength')
        if (why) { out.textContent = why; out.dataset.level = '1'; return }
        busy(e.target, 'Saving the password…')
        try { await client.setPassphrase(p, { recovery_code: code }) } catch (err) { out.textContent = `Not saved: ${err.message}`; out.dataset.level = '1'; const b = e.target.querySelector('button[type="submit"]'); b.disabled = false; b.textContent = 'Open the room'; return }
      }
      code = null
      done(client)
    })
  }

  // Pair: scan the other device's QR code (BarcodeDetector) or paste its link.
  async function scanFlow(error = '') {
    const { canScan, scanQr } = await import('./qr.mjs')
    const camera = await canScan()
    show(shell('Pair this device', html`<ol class="room-steps"><li>On the device that is in the room: menu → Devices → "Pair a device".</li><li>${camera ? 'Hold its QR code in front of this camera.' : 'Scan its QR code with this device\'s camera app.'}</li></ol>
${camera ? html`<div class="room-scan"><video id="scan-video" muted playsinline aria-label="Camera"></video></div>` : ''}
${errorLine(error)}
<form id="paste-form" class="room-form"><label>Or paste the link here<input name="link" inputmode="url" autocomplete="off" placeholder="https://app.trommi.com/join#v1…" required></label><button type="submit">Next</button></form>${backLink}`), camera ? '#paste-form input' : '#paste-form input')
    wireBack()
    const go = text => {
      const at = String(text).indexOf('#v1.')
      if (at < 0) return false
      history.replaceState(null, '', `/join${String(text).slice(at)}`)
      joinFlow()
      return true
    }
    on('#paste-form', 'submit', e => { e.preventDefault(); if (!go(new FormData(e.target).get('link'))) scanFlow('That is no pairing link. It contains "#v1.".') })
    if (camera) scanQr(root.querySelector('#scan-video'), go).then(stop => { stopScan = stop }).catch(() => root.querySelector('.room-scan')?.remove())
  }

  // Join with the link in the address: name, then show the check code to tap on the other device.
  function joinFlow(error = '') {
    show(shell('Pair this device', html`<p class="room-lead">This device now makes its own keys. Then it shows a number that you tap on the other device.</p>
${errorLine(error)}
<form id="join-form" class="room-form">${nameField}<button type="submit" class="room-primary">Next</button></form>`), '#join-form button')
    on('#join-form', 'submit', async e => {
      e.preventDefault()
      const link = location.href
      const name = String(new FormData(e.target).get('device_name'))
      show(shell('Pair this device', html`<p class="room-wait">Asking the other device…</p>`))
      try {
        const join = c.joinRoom({ link, device_name: name, storage: await storage(), client: CLIENT })
        history.replaceState(null, '', '/join')   // the secret leaves the address bar
        join.check_code.then(code => {
          show(shell('Pair this device', html`<p class="room-lead">On the other device, tap this number:</p><p class="room-code" id="check-code">${code6(code)}</p><p class="room-wait">Waiting until it adds this device…</p>
<p class="room-meta">Tapped the wrong number there? Then the invite is used up. <a href="/" id="join-cancel">Cancel and pair again</a></p>`), null)
          on('#join-cancel', 'click', ev => { ev.preventDefault(); join.cancel(); history.replaceState(null, '', '/'); scanFlow() })
        })
        await done(await join.client)
      } catch (err) {
        if (err.code === 'cancelled') return
        console.error(err)
        const why = { 'invite-used': 'The invite was used already.', 'invite-expired': 'The invite has expired.', 'invite-burned': 'A wrong number was tapped; the invite is used up.' }[err.code] ?? err.message
        show(shell('Pair this device', html`<p class="room-error" role="alert">Not paired: ${why}</p><p class="room-lead">Show a new code on the other device.</p><button type="button" class="room-primary" id="scan-again">Scan again</button>${backLink}`), '#scan-again')
        on('#scan-again', 'click', () => scanFlow()); wireBack()
      }
    })
  }

  // The room address from a link in the address bar (/login#r1… or /recover#r1…), if there is one.
  const addressInBar = () => (location.hash.startsWith('#r1.') ? location.href : '')
  const parseAddress = text => { if (!c.parseRoomLink) throw new Error('this version knows no room addresses'); return c.parseRoomLink(String(text).trim()) }

  function passwordFlow(error = '') {
    show(shell('Sign in with a password', html`${errorLine(error)}<form id="pw-form" class="room-form">
<label>Room address<input name="room_link" value="${addressInBar()}" required autocomplete="off" inputmode="url" placeholder="https://app.trommi.com/login#r1…"></label>
<label>Password<input type="password" name="passphrase" required autocomplete="current-password"></label>${nameField}
<button type="submit" class="room-primary">Sign in</button></form>
<p class="room-meta">The room address is under Settings on a device in the room.</p>${backLink}`), addressInBar() ? 'input[name=passphrase]' : 'input')
    wireBack()
    on('#pw-form', 'submit', async e => {
      e.preventDefault()
      const f = new FormData(e.target)
      busy(e.target, 'Checking… (a few seconds)')
      try {
        const { client } = await c.loginWithPassphrase({ room_link: String(f.get('room_link')).trim(), passphrase: String(f.get('passphrase')), device_name: String(f.get('device_name')), storage: await storage(), client: CLIENT })
        await done(client)
      } catch (err) { console.error(err); passwordFlow(err.code === 'bad-passphrase' || err.code === 'wrong-passphrase' ? 'Password or room address is wrong.' : `Not signed in: ${err.message}`) }
    })
  }

  function recoverFlow(error = '') {
    history.replaceState(null, '', `/recover${location.hash.startsWith('#r1.') ? location.hash : ''}`)
    show(shell('Recover', html`<p class="room-lead">The recovery code brings you back when no device is left in the room. All earlier devices are removed, the agents stay, and you get a new code.</p>
${errorLine(error)}<form id="recover-form" class="room-form">
<label>Room address<input name="room_link" value="${addressInBar()}" required autocomplete="off" inputmode="url"></label>
<label>Recovery code<input name="code" required autocomplete="off" spellcheck="false" class="room-mono"></label>${nameField}
<button type="submit" class="room-primary">Recover</button></form>${backLink}`))
    wireBack()
    on('#recover-form', 'submit', async e => {
      e.preventDefault()
      const f = new FormData(e.target)
      busy(e.target, 'Recovering…')
      try {
        const { hub_url, room_id } = parseAddress(f.get('room_link'))
        // The new code comes before the recovery is posted (the core never loses it): it is on screen from then on.
        const on_recovery_code = fresh => show(shell('Your new recovery code', html`<p class="room-lead">Write this down now. It replaces the old code.</p><p class="room-recovery" id="recovery-code">${fresh}</p><p class="room-wait">Recovering the room…</p>`), null)
        const { client, recovery_code } = await c.recoverRoom({ hub_url, room_id, code: String(f.get('code')).trim(), device_name: String(f.get('device_name')), storage: await storage(), client: CLIENT, on_recovery_code })
        recovery(client, recovery_code, false)
      } catch (err) { console.error(err); recoverFlow(err.code === 'bad-recovery-code' ? 'This code does not belong to this room.' : `Not recovered: ${err.message}`) }
    })
  }
}
export { ago, raw }
