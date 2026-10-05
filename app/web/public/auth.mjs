// ---- room ----
// The room's own screens. Inside a room (pages of the board): /devices (who is in the room, the two ways to add a
// device, inviting an agent, removing), /pair/:id (the QR code, then "Add a new device?" with four codes to tap),
// /settings (the account: email, password, Emergency Kit; storage). Before a room (a screen of its own): Create
// account (email + password; this device founds the room), Log in (email + password, or scan a signed-in device's
// code), Forgot password (Emergency Kit), and the old recovery code. The UI says "account", never "room".
// Calm and sober: this is about keys; pen drawings only on the choice buttons.
// Core features that may not be there yet (escrow, usage, session handover) are shown only when the core has them.
import { BELL, Controller, controller, copyText, doodleSvg, errorLine, html, raw, roomShell, roomTabs, sketchSvg } from './ui.mjs'
import { CLIENT, account, core, ses, stream } from './app.mjs'
const read = (k, f = null) => { try { return localStorage.getItem(k) ?? f } catch { return f } }
const write = (k, v) => { try { localStorage.setItem(k, v) } catch {} }
const foundCode = () => ses('trommi-found-code', new URLSearchParams(location.search).get('found_code')) || undefined
const deviceGuess = () => (/iPhone|Android.*Mobile/.test(navigator.userAgent) ? 'Phone' : /iPad|Android/.test(navigator.userAgent) ? 'Tablet' : 'Laptop')
const ago = ts => { const s = Math.round((Date.now() - ts) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago` }
const art = name => raw(['phone', 'house'].includes(name) ? doodleSvg(`draw:${name}`) : sketchSvg(name))
const has = (o, fn) => typeof o?.[fn] === 'function'
const code6 = c => `${String(c).slice(0, 3)} ${String(c).slice(3)}`
// One place for agents and devices (the menu's "Agents & devices"): the Agents page carries the same tabs (agents.mjs).
const copyBox = (value, label, cls = '') => html`<div class="room-link${cls ? ` ${cls}` : ''}" data-controller="room"><input readonly value="${value}" aria-label="${label}" data-room-target="field" data-action="focus->room#select"><button type="button" data-action="room#copy" data-room-text-param="${value}"><span data-room-target="label">Copy</span></button></div>`
const sessionName = s => s.settings?.name || s.profile?.agent_name || s.agent_session_id || s.device_name || 'Session'

// ---- inside a room: devices, pairing, settings (pages of the board, rendered like any other) ----
export function register(t) {
  const client = t.hub.client
  // What an agent invite should do once the agent joined (session handover; kept in this tab only).
  const handovers = new Map()
  let k = null   // the core's helpers (roomLink); the demo room has none
  core().then(x => { k = x }).catch(() => {})
  {
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
        ? html`${name} can open nothing new after this. Everyone else gets a new key; that takes a moment.`
        : html`${name} can read nothing new after this. The others get a new key; the session's history stays.`}</p><button type="submit" class="room-danger">Remove ${name}</button></details></form>` : ''}</li>`
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
        agents: String(agents.length ? html`<ul class="room-devices" id="room-agents">${agents.map(member)}</ul>` : html`<p class="room-meta" id="room-agents">No agent yet.</p>`),
        gone: String(gone.length ? html`<details class="room-section room-gone" id="room-gone"><summary>Removed (${gone.length})</summary><ul class="room-devices">${gone.map(member)}</ul></details>` : html`<div id="room-gone" hidden></div>`),
      }
    }
    const devicesMain = (error = '') => {
      const L = lists(), active = [...m().members.values()].filter(d => d.is_active && d.device_role !== 'human')
      return roomShell('Devices', html`${roomTabs('devices')}
${errorLine(error)}
${isHuman() ? html`<section class="room-section" aria-labelledby="add-head"><h3 id="add-head">Add a device</h3>
<div class="room-ways">
<form method="post" action="/pair" class="room-way"><input type="hidden" name="role" value="human"><button type="submit" class="room-way-go" id="pair-start">${art('phone')}<b>Pair a device</b><span>A QR code appears here. The new device scans it, you tap a number. Done.</span></button></form>
<a href="/settings#account" data-nav class="room-way room-way-go" id="password-way">${art('key')}<b>Log in with email and password</b><span>On the new device open app.trommi.com and choose "Log in".</span></a>
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
      if (!inv) return roomShell('Invite', html`<p class="room-lead">This invite is gone.</p>${back}`)
      const agent = inv.device_role === 'agent', state = inv.invite_state
      const left = Math.max(0, Math.round((inv.expires_at - Date.now()) / 60000))
      let body
      // The link goes to the connector by the human's hands only (never pasted into the model's prompt).
      if (state === 'open' && agent) body = html`<p class="room-lead">On any computer with Claude Code and Node 22+, open a terminal in the project folder and run:</p>
${copyBox(`curl -fsSL ${location.origin}/connect | sh -s '${inv.link}'`, 'Command', 'room-cmd')}<p class="room-lead">Then start Claude Code there (the Trommi plugin brings every message from here into the session, also after <code>--continue</code> or <code>--resume</code>):</p>${copyBox('claude', 'Command', 'room-cmd')}
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
        body = html`<p class="room-lead room-ok">✓ ${newcomerName(inv) || (agent ? 'The agent' : 'The new device')} is in now.</p>${h && !h.done ? html`<p class="room-wait">Handing over the session…</p>` : ''}${h?.error ? errorLine(`Session not handed over: ${h.error}`) : ''}<a href="/devices" data-nav class="room-done">Done</a>`
      } else if (inv.error === 'code-mismatch') body = html`<p class="room-error" role="alert">Wrong number. Nobody was added; the invite is used up.</p>${again(agent)}${back}`
      else body = html`<p class="room-error" role="alert">${state === 'expired' ? 'The invite has expired.' : `That did not work${inv.error ? ` (${inv.error})` : ''}.`}</p>${errorLine(error)}${again(agent)}${back}`
      return roomShell(agent ? 'Invite an agent' : state === 'confirm_code' ? 'Add a new device?' : 'Pair a device', html`<div id="invite-${inv.invite_id}" class="room-invite" data-state="${state}">${body}</div>`)
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
    // The account is read from the hub once per visit (client._setRoom: a change, so the page refreshes when it is in).
    const loadAccount = () => {
      if (!client.hub || m().room.account_loading) return
      client._setRoom({ account_loading: true })
      account().then(A => A.accountStatus(client)).then(st => client._setRoom({ account: st, account_loading: false }), err => client._setRoom({ account_error: err.message, account_loading: false }))
    }
    const settingsMain = (error = '', said = '', kit = null) => {
      const room = m().room
      const st = room.account
      const link = client.hub && has(k, 'roomLink') && room.hub_url ? k.roomLink(room.hub_url, room.room_id) : null
      const form = (action, inner, word, id) => html`<form method="post" action="${action}" class="room-form" data-controller="room" id="${id}">${inner}<button type="submit" class="room-primary">${word}</button></form>`
      const accountPart = !client.hub ? html`<p class="room-meta">No account in the demo.</p>`
        : st === undefined ? html`<p class="room-wait">${room.account_error ? `Not reachable: ${room.account_error}` : 'Loading…'}</p>`
          : st === null ? html`<p class="room-lead">This account was made before email and password. Add a login, so a new device gets in with email and password. You need the recovery code shown when you started.</p>
${form('/settings/account', html`<label>Email<input type="email" name="email" required autocomplete="username" autocapitalize="off" spellcheck="false"></label>${pwField()}<label>Recovery code<input name="recovery_code" required autocomplete="off" spellcheck="false" class="room-mono" placeholder="XXXX-XXXX-…"></label>`, 'Add login', 'account-add')}`
            : html`<p class="room-lead">Logged in as <b id="account-email">${st.email}</b>${st.email_verified_at ? html` <span class="room-ok">· confirmed</span>` : ''}</p>
${st.email_verified_at ? '' : html`<details class="room-more" id="email-confirm"><summary>Confirm your email</summary><p class="room-meta">We send a six-digit code to ${st.email}.</p>
<form method="post" action="/settings/account/code" class="room-inline"><button type="submit">Send code</button></form>
${form('/settings/account/verify', html`<label>Code<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required class="room-code-input"></label>`, 'Confirm', 'verify-form')}</details>`}
<h4 class="room-sub">Emergency Kit</h4>
${kit ? html`<p class="room-lead">Download or print it, and keep it somewhere safe. It is shown only now. The old kit no longer works.</p>${kitBox(st.email, kit, true)}`
  : html`<p class="room-lead">${st.has_recovery ? 'Made. With it you can set a new password if you forget yours.' : 'Not made yet. With it you can set a new password if you forget yours. Whenever you like.'}</p>
<details class="room-more" id="kit-new"><summary>${st.has_recovery ? 'Make a new kit' : 'Make my Emergency Kit'}</summary>${form('/settings/kit', pwField({ label: 'Your password', gen: false, autocomplete: 'current-password' }), 'Make the kit', 'kit-form')}</details>`}
<h4 class="room-sub">Password</h4>
<details class="room-more" id="pw-change"><summary>Change password</summary>${form('/settings/password', html`${pwField({ name: 'current', label: 'Current password', gen: false, autocomplete: 'current-password' })}${pwField({ label: 'New password' })}`, 'Change password', 'pw-form')}</details>
<p class="room-meta">${NO_RECOVERY}</p>`
      return roomShell('Settings', html`${roomTabs('settings')}
${errorLine(error)}${said ? html`<p class="room-lead room-ok" role="status">${said}</p>` : ''}
${isHuman() ? html`<section class="room-section" id="account" aria-labelledby="acct-head"><h3 id="acct-head">Account</h3>${accountPart}<p class="room-logout-line"><a href="/logout" data-nav id="settings-logout">Log out of this device</a></p></section>` : ''}
<section class="room-section" aria-labelledby="store-head"><h3 id="store-head">Storage</h3><dl class="room-usage" data-controller="room" data-room-usage-value="${has(client, 'usage') ? 'hub' : 'local'}"><div><dt>On this device</dt><dd data-room-target="local">…</dd></div>${has(client, 'usage') ? html`<div><dt>On the hub (encrypted)</dt><dd data-room-target="hub">…</dd></div>` : ''}</dl><p class="room-meta">The hub deletes envelopes after 30 days; your devices keep what they decrypted.</p></section>
${link ? html`<details class="room-section room-more" id="advanced"><summary>Advanced</summary><p class="room-lead">The address of this account, for the old recovery code (app.trommi.com/recover). On its own it opens nothing.</p>${copyBox(link, 'Address')}
<p class="room-meta">${room.room_id.slice(0, 16)}… · key epoch ${room.key_epoch} · hub ${room.hub_url}</p></details>` : ''}`)
    }
    const DONE = { added: 'Login added. A new device now logs in with email and password.', changed: 'Password changed.', sent: 'Code sent.', confirmed: 'Email confirmed.' }
    t.live('settings', { take: () => JSON.stringify([m().room.account ?? null, m().room.account_error ?? null]), diff: (was, now) => (was !== now ? String(t.stream('refresh')) : '') })
    t.get(/^\/settings$/, ({ req, res, url }) => { if (m().room.account === undefined) loadAccount(); page(req, res, 'Settings', settingsMain('', DONE[url.searchParams.get('done')] ?? ''), { view: 'settings' }) })
    const accountPost = (path, fn, done) => t.post(path, async ({ req, res, form }) => {
      let out
      try { out = await fn(form, await account()) } catch (err) {
        console.error(err)
        return page(req, res, 'Settings', settingsMain(accountError(err)), { view: 'settings' }, 422)
      }
      if (out?.kit) return page(req, res, 'Settings', settingsMain('', 'Your new Emergency Kit:', out.kit), { view: 'settings' })
      client._setRoom({ account: undefined }); loadAccount()
      t.redirect(res, `/settings?done=${done}`)
    })
    accountPost(/^\/settings\/account$/, (f, A) => A.addAccount(client, { email: String(f.get('email')), password: String(f.get('password')), recovery_code: String(f.get('recovery_code')).trim() }), 'added')
    accountPost(/^\/settings\/password$/, (f, A) => A.changePassword(client, { current: String(f.get('current')), next: String(f.get('password')) }), 'changed')
    accountPost(/^\/settings\/kit$/, async (f, A) => {
      const { words } = await A.makeEmergencyKit(client, { password: String(f.get('password')) })
      client._setRoom({ account: { ...m().room.account, has_recovery: true } })
      return { kit: words }
    })
    accountPost(/^\/settings\/account\/code$/, (f, A) => A.resendEmailCode(client), 'sent')
    accountPost(/^\/settings\/account\/verify$/, (f, A) => A.verifyEmail(client, String(f.get('code'))), 'confirmed')

    // ---- /logout (the Trommi menu and Settings -> Account): asks once, then logOut() ----
    const logoutMain = (error = '') => {
      const me = m().room.my_device_id
      const others = [...(m().members?.values() ?? [])].filter(d => d.is_active && d.device_role === 'human' && d.device_id !== me).length
      const st = m().room.account
      const note = !client.hub ? 'The demo keeps nothing; this only ends it.'
        : others ? ''
          : st === null ? 'This is your only device, and this account has no email login yet: after this, only your recovery code opens it (app.trommi.com/recover).'
            : 'This is your only device. After this, your email and password (or your Emergency Kit) open your account.'
      return roomShell('Log out', html`${errorLine(error)}<p class="room-lead" id="logout-ask">Log out of this device? You can log in again with email and password.</p>
${note ? html`<p class="room-lead" id="logout-last">${note}</p>` : ''}<p class="room-meta">Everything Trommi keeps on this device is deleted here; your account and your other devices stay as they are.</p>
<form method="post" action="/logout" class="room-inline room-logout" id="logout-form"><button type="submit" class="room-danger" id="logout-go">Log out</button><a href="/" data-nav class="room-back" id="logout-cancel">Cancel</a></form>`)
    }
    t.get(/^\/logout$/, ({ req, res }) => { if (client.hub && isHuman() && m().room.account === undefined) loadAccount(); page(req, res, 'Log out', logoutMain(), { view: 'logout' }) })
    t.post(/^\/logout$/, async () => { await logOut(client) })

    // A join link opened on a device that is in a room already.
    t.get(/^\/(?:join|login)$/, ({ req, res }) => page(req, res, 'Pair a device', roomShell('Already logged in', html`<p class="room-lead">This device is logged in already. Pair another device under <a href="/devices" data-nav>Devices</a>.</p><p class="room-meta">Another account? <a href="/logout" data-nav id="login-logout-first">Log out of this device first</a>, then log in.</p><p class="room-meta"><a href="/" data-nav>Open your Desk</a></p>`)))
  }
}

// ---- Log out: this device leaves the member list (a signed removal by itself), the streams close, every local trace of
// the app on this origin goes (IndexedDB, Cache Storage, localStorage, sessionStorage; the service worker stays and
// fills its cache again from the network), and the start page comes. Offline: the removal fails, the wipe still happens,
// and the start page says the device stays in "Devices" until another device removes it.
async function logOut(client) {
  let removed = !client?.hub   // the demo has nothing to remove
  if (typeof client?.leaveRoom === 'function') {
    try { await Promise.race([client.leaveRoom(), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 20_000))]); removed = true }
    catch (err) { console.warn('log out: not removed', err?.code ?? '', err?.message ?? err) }
  }
  await client?.stop?.().catch?.(() => {})
  await wipeLocal(client)
  location.replace(removed ? '/?logged_out=1' : '/?logged_out=kept')
}
async function wipeLocal(client) {
  try { await client?.storage?.close?.() } catch {}
  try { for (const name of await caches.keys()) await caches.delete(name) } catch {}
  try { localStorage.clear() } catch {}
  try { sessionStorage.clear() } catch {}
  let names = ['trommi']
  try { if (indexedDB.databases) names = [...new Set([...names, ...(await indexedDB.databases()).map(d => d.name).filter(Boolean)])] } catch {}
  // A connection still open elsewhere (another tab) blocks the delete: it finishes when that closes; this page goes on.
  await Promise.all(names.map(name => new Promise(done => {
    try { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = () => done(); r.onblocked = () => setTimeout(done, 2000) } catch { done() }
  })))
}

// ---- the account: shared pieces (screens before the board and the Settings page) ----
/** A password field with "Generate" (five words); `gen` false for the current password. */
const pwField = ({ name = 'password', label = 'Password', gen = true, autocomplete = 'new-password' } = {}) => html`<label>${label}<span class="room-pwrow"><input type="password" name="${name}" required minlength="${gen ? 12 : 1}" autocomplete="${autocomplete}" spellcheck="false" autocapitalize="off">${gen ? html`<button type="button" class="room-gen" data-action="room#generate">Generate</button>` : ''}</span>${gen ? html`<small class="room-hint">At least 12 characters. Or press Generate: five words, easy to type.</small>` : ''}</label>`
/** "Generate" fills a five-word password and shows it; pressed again it copies it. */
async function generateInto(button) {
  const input = button.closest('.room-pwrow')?.querySelector('input')
  if (!input) return
  if (button.dataset.generated === input.value && input.value) {
    let ok = false
    try { await navigator.clipboard.writeText(input.value); ok = true } catch {}
    button.textContent = ok ? 'Copied' : 'Write it down'
    return
  }
  input.value = (await account()).generatePassword()
  input.type = 'text'
  button.dataset.generated = input.value
  button.textContent = 'Copy'
  const hint = button.closest('label')?.querySelector('.room-hint')
  if (hint) hint.textContent = 'Generated for you. Put it in your password manager or write it down.'
  input.addEventListener('input', () => { button.textContent = 'Generate'; delete button.dataset.generated }, { once: true })
}
const NO_RECOVERY = 'If you lose your password and your Emergency Kit, nobody (not even Trommi) can recover your data.'
/** The Emergency Kit as a text file. */
const kitText = (email, words) => `Trommi Emergency Kit

Email: ${email}
Recovery words: ${words}

Forgot your password? Open https://app.trommi.com, choose "Log in", then "Forgot password?".
Enter your email and these 12 words, then choose a new password.

Keep this kit private and offline: with these words and your email, anyone can get into your account.
${NO_RECOVERY}

Made ${new Date().toISOString().slice(0, 10)}
`
/** Save the kit as a file (a link to a Blob, clicked). */
function downloadKit(text) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  a.download = 'Trommi-Emergency-Kit.txt'
  document.body.append(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 10000)
}
const kitBox = (email, words, stim = false) => html`<div class="room-kit" id="kit"><p class="room-kit-title">${raw(BELL)} Trommi Emergency Kit</p><p class="room-meta">Email: <b>${email}</b></p>
<ol class="room-kit-words" id="kit-words">${words.split(' ').map(w => html`<li>${w}</li>`)}</ol>
<p class="room-meta">Forgot your password? app.trommi.com → Log in → "Forgot password?" → your email and these 12 words.</p></div>
<div class="room-actions room-kit-actions"${stim ? raw(' data-controller="room"') : ''}><button type="button" id="kit-download"${stim ? raw(' data-action="room#download"') : ''} data-room-text-param="${kitText(email, words)}">Download</button><button type="button" id="kit-print"${stim ? raw(' data-action="room#print"') : ''}>Print</button></div>`
const accountError = err => ({
  'wrong-login': 'Email or password is wrong.', 'wrong-recovery': 'Email or recovery words are wrong.', 'bad-recovery-words': `Recovery words: ${err.message}.`,
  'rate-limited': 'Too many tries. Please wait a few minutes.', 'weak-password': 'The password needs at least 12 characters.', 'bad-email': 'That is not an email address.',
  offline: 'Trommi is not reachable. Check the connection.', 'room-exists': 'This browser is signed in already.', 'bad-recovery-code': 'This recovery code does not belong to this account.',
  'account-exists': 'This account has a login already.', 'account-changed': 'Changed on another device meanwhile. Please try again.', 'wrong-code': 'Wrong or expired code.',
}[err.code] ?? err.message)

// ---- before a room: a screen of its own, before the board exists ----
export async function roomScreen({ start, hub, openError = null }) {
  document.title = 'Trommi'
  const root = document.createElement('div')
  root.id = 'room-screen'
  document.body.replaceChildren(root)
  let stopScan = null
  const show = (markup, focus = 'input:not([type=hidden]), button.room-primary') => {
    stopScan?.(); stopScan = null
    root.innerHTML = String(markup)
    if (focus) root.querySelector(focus)?.focus({ preventScroll: true })
  }
  // Buttons that work without Stimulus on this screen: Generate, Download, Print.
  root.addEventListener('click', e => {
    const b = e.target.closest('button')
    if (!b) return
    if (b.classList.contains('room-gen')) { e.preventDefault(); generateInto(b) }
    else if (b.id === 'kit-download') downloadKit(b.dataset.roomTextParam)
    else if (b.id === 'kit-print') window.print()
  })
  const storage = async () => (await core()).idbStorage({ name: 'trommi', prefix: 'room/' })
  const done = async client => { root.remove(); history.replaceState(null, '', '/'); await start(client, { fresh: true }) }
  const on = (sel, ev, fn) => root.querySelector(sel)?.addEventListener(ev, fn)
  const backLink = html`<p class="room-meta"><a href="/" id="room-home">Back</a></p>`
  const wireBack = () => on('#room-home', 'click', e => { e.preventDefault(); history.replaceState(null, '', '/'); welcome() })
  const busy = (form, word) => { const b = form.querySelector('button[type="submit"]'); b.disabled = true; b.textContent = word }
  const nameField = html`<label>Name of this device<input name="device_name" value="${deviceGuess()}" maxlength="40" required></label>`
  const emailField = (value = '') => html`<label>Email<input type="email" name="email" value="${value}" required autocomplete="username" autocapitalize="off" spellcheck="false" inputmode="email"></label>`
  const c = await core().catch(() => ({}))
  let lastEmail = ''

  // After a log out (logOut): said once on the start page, then the address is plain again.
  const loggedOut = new URLSearchParams(location.search).get('logged_out')
  const wayLogin = new URLSearchParams(location.search).get('way') === 'login'
  if (loggedOut) history.replaceState(null, '', '/')
  // This browser holds an account that did not open: never the start page (Log in would refuse: "signed in already").
  if (openError) return brokenFlow(openError)
  if (location.pathname === '/join' && location.hash.length > 1) return joinFlow()
  if (location.pathname === '/recover') recoverFlow()
  else if (wayLogin) loginFlow()
  else welcome()

  // The stored account does not open (or a login found one stored): say so, Retry, or Log out of this device (wipe
  // this browser's copy; the account and the other devices stay). Never a dead end.
  function brokenFlow(err, { fromLogin = false } = {}) {
    const why = err?.code === 'no-device' || err?.code === 'device-not-stored'
      ? 'This browser kept your account but lost this device\'s keys, so it cannot open it.'
      : `It did not open: ${err?.message ?? err}`
    show(roomShell('Your account on this device', html`<p class="room-error" role="alert" id="broken-why">${fromLogin ? 'This browser holds an account already, and it does not open.' : 'This device is logged in, but your account did not open.'}</p>
<p class="room-lead">${why}</p>
<p class="room-lead">Log out of this device, then log in again with your email and password. Your account, your cards and your other devices stay as they are.</p>
<div class="room-actions"><button type="button" class="room-primary" id="broken-logout">Log out of this device</button><button type="button" id="broken-retry">Retry</button></div>
<p class="room-meta" id="broken-detail">${err?.code ? `${err.code}: ` : ''}${err?.message ?? ''}</p>`), '#broken-retry')
    on('#broken-retry', 'click', () => location.reload())
    on('#broken-logout', 'click', async e => {
      e.target.disabled = true; e.target.textContent = 'Logging out…'
      await wipeLocal(null)
      location.replace('/?logged_out=kept&way=login')
    })
  }
  // A login, kit or pairing on a browser that holds an account: open that one (it is the account, or the person logs
  // out first); if it does not open, the broken screen.
  async function roomExists() {
    try {
      const client = await c.openRoom({ storage: await storage(), client: CLIENT })
      if (client) return done(client)
    } catch (err) { return brokenFlow(err, { fromLogin: true }) }
    return brokenFlow(new Error('the stored account vanished meanwhile'), { fromLogin: true })
  }

  function welcome(error = '') {
    show(roomShell('Trommi', html`<p class="room-lead">Your agents ask, you answer, from any device. End-to-end encrypted: the hub carries sealed envelopes only.</p>
${errorLine(error)}${loggedOut ? html`<p class="room-lead" id="logged-out" role="status">${loggedOut === 'kept' ? 'Logged out. This device could not reach the hub, so it still appears under "Devices" until you remove it from another device.' : 'Logged out. Nothing of Trommi is left on this device.'}</p>` : ''}
<div class="room-ways room-ways-first">
<button type="button" class="room-way room-way-go" id="way-create">${art('house')}<b>Create account</b><span>New to Trommi? Email and a password, and this device is your first.</span></button>
<button type="button" class="room-way room-way-go" id="way-login">${art('key')}<b>Log in</b><span>You have an account? Log in with your email and password, or scan a code from a signed-in device.</span></button>
</div>`, 'room-welcome'), null)
    on('#way-create', 'click', () => createFlow())
    on('#way-login', 'click', () => loginFlow())
  }

  function createFlow(error = '') {
    show(roomShell('Create account', html`${errorLine(error)}<form id="create-form" class="room-form">${emailField(lastEmail)}${pwField()}${nameField}
<button type="submit" class="room-primary">Create account</button></form>
<p class="room-meta">Your password never leaves this device. ${NO_RECOVERY}</p>${backLink}`))
    wireBack()
    on('#create-form', 'submit', async e => {
      e.preventDefault()
      const f = new FormData(e.target)
      lastEmail = String(f.get('email') ?? '')
      const A = await account()
      const why = A.passwordProblem(String(f.get('password') ?? ''))
      if (why) return createFlow('The password needs at least 12 characters.')
      busy(e.target, 'Creating your account…')
      try {
        const hub_url = hub
        const { client, recovery_code } = await A.createAccount({ hub_url, email: lastEmail, password: String(f.get('password')), device_name: String(f.get('device_name')), storage: await storage(), found_token: foundCode(), client: CLIENT })
        kitOffer(client, recovery_code, A.normaliseEmail(lastEmail))
      } catch (err) { console.warn(err); if (err.code === 'room-exists') return roomExists(); createFlow(`Not created: ${accountError(err)}`) }
    })
  }

  // The Emergency Kit, offered once after creating the account. "Later" stores nothing; Settings reminds calmly.
  function kitOffer(client, code, email, error = '') {
    show(roomShell('Your Emergency Kit', html`<p class="room-lead">Forget your password some day? The Emergency Kit lets you set a new one: twelve words to print or keep as a file.</p>
<p class="room-lead">${NO_RECOVERY}</p>${errorLine(error)}
<div class="room-actions"><button type="button" class="room-primary" id="kit-make">Make my Emergency Kit</button><button type="button" id="kit-later">Later</button></div>`), '#kit-make')
    on('#kit-later', 'click', () => { code = null; done(client) })
    on('#kit-make', 'click', async e => {
      e.target.disabled = true; e.target.textContent = 'Making…'
      try {
        const { words } = await (await account()).makeEmergencyKit(client, { recovery_code: code })
        code = null
        show(roomShell('Your Emergency Kit', html`<p class="room-lead">Download or print it, and keep it somewhere safe. It is shown only now; you can make a new one in Settings.</p>
${kitBox(email, words)}<div class="room-actions"><button type="button" class="room-primary" id="kit-done">Done</button></div>`), '#kit-download')
        on('#kit-done', 'click', () => done(client))
      } catch (err) { console.warn(err); kitOffer(client, code, email, `Not made: ${accountError(err)}`) }
    })
  }

  function loginFlow(error = '') {
    show(roomShell('Log in', html`${errorLine(error)}<form id="login-form" class="room-form">${emailField(lastEmail)}${pwField({ gen: false, autocomplete: 'current-password' })}${nameField}
<button type="submit" class="room-primary">Log in</button></form>
<p class="room-meta"><a href="/" id="way-forgot">Forgot password?</a></p>
<div class="room-ways"><button type="button" class="room-way room-way-go" id="way-pair">${art('phone')}<b>Scan from a signed-in device</b><span>On a device that is logged in: menu → Devices → "Pair a device". Then scan its code here.</span></button></div>${backLink}`))
    wireBack()
    on('#way-pair', 'click', () => scanFlow())
    on('#way-forgot', 'click', e => { e.preventDefault(); forgotFlow() })
    on('#login-form', 'submit', async e => {
      e.preventDefault()
      const f = new FormData(e.target)
      lastEmail = String(f.get('email') ?? '')
      busy(e.target, 'Logging in…')
      try {
        const { client } = await (await account()).loginWithPassword({ hub_url: hub, email: lastEmail, password: String(f.get('password')), device_name: String(f.get('device_name')), storage: await storage(), client: CLIENT })
        await done(client)
      } catch (err) { console.warn(err); if (err.code === 'room-exists') return roomExists(); loginFlow(accountError(err)) }
    })
  }

  function forgotFlow(error = '') {
    show(roomShell('Forgot password', html`<p class="room-lead">With your Emergency Kit you set a new password. Your devices stay logged in.</p>
${errorLine(error)}<form id="forgot-form" class="room-form">${emailField(lastEmail)}
<label>The 12 words of your Emergency Kit<textarea name="words" rows="3" required autocomplete="off" autocapitalize="off" spellcheck="false" class="room-mono"></textarea></label>
${pwField({ label: 'New password' })}${nameField}
<button type="submit" class="room-primary">Set new password</button></form>
<p class="room-meta">No kit, but another device is logged in? Change the password there under Settings. <a href="/recover" id="way-recover">An older account with a recovery code?</a></p>${backLink}`))
    wireBack()
    on('#way-recover', 'click', e => { e.preventDefault(); recoverFlow() })
    on('#forgot-form', 'submit', async e => {
      e.preventDefault()
      const f = new FormData(e.target)
      lastEmail = String(f.get('email') ?? '')
      const A = await account()
      if (A.passwordProblem(String(f.get('password') ?? ''))) return forgotFlow('The new password needs at least 12 characters.')
      busy(e.target, 'Setting the new password…')
      try {
        const { client } = await A.resetPassword({ hub_url: hub, email: lastEmail, words: String(f.get('words')), new_password: String(f.get('password')), device_name: String(f.get('device_name')), storage: await storage(), client: CLIENT })
        await done(client)
      } catch (err) { console.warn(err); if (err.code === 'room-exists') return roomExists(); forgotFlow(accountError(err)) }
    })
  }

  // Pair: scan the other device's QR code (BarcodeDetector) or paste its link.
  async function scanFlow(error = '') {
    const camera = await canScan()
    show(roomShell('Scan from a signed-in device', html`<ol class="room-steps"><li>On the device that is logged in: menu → Devices → "Pair a device".</li><li>${camera ? 'Hold its QR code in front of this camera.' : 'Scan its QR code with this device\'s camera app.'}</li></ol>
${camera ? html`<div class="room-scan"><video id="scan-video" muted playsinline aria-label="Camera"></video></div>` : ''}
${errorLine(error)}
<form id="paste-form" class="room-form"><label>Or paste the link here<input name="link" inputmode="url" autocomplete="off" placeholder="https://app.trommi.com/join#v1…" required></label><button type="submit">Next</button></form>${backLink}`), '#paste-form input')
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
    show(roomShell('Log in with a signed-in device', html`<p class="room-lead">This device now makes its own keys. Then it shows a number that you tap on the other device.</p>
${errorLine(error)}
<form id="join-form" class="room-form">${nameField}<button type="submit" class="room-primary">Next</button></form>`), '#join-form button')
    on('#join-form', 'submit', async e => {
      e.preventDefault()
      const link = location.href
      const name = String(new FormData(e.target).get('device_name'))
      show(roomShell('Log in with a signed-in device', html`<p class="room-wait">Asking the other device…</p>`))
      try {
        const join = c.joinRoom({ link, device_name: name, storage: await storage(), client: CLIENT })
        history.replaceState(null, '', '/join')   // the secret leaves the address bar
        join.check_code.then(code => {
          show(roomShell('Log in with a signed-in device', html`<p class="room-lead">On the other device, tap this number:</p><p class="room-code" id="check-code">${code6(code)}</p><p class="room-wait">Waiting until it adds this device…</p>
<p class="room-meta">Tapped the wrong number there? Then the code is used up. <a href="/" id="join-cancel">Cancel and scan again</a></p>`), null)
          on('#join-cancel', 'click', ev => { ev.preventDefault(); join.cancel(); history.replaceState(null, '', '/'); scanFlow() })
        })
        await done(await join.client)
      } catch (err) {
        if (err.code === 'cancelled') return
        console.error(err)
        if (err.code === 'room-exists') return roomExists()
        const why = { 'invite-used': 'The code was used already.', 'invite-expired': 'The code has expired.', 'invite-burned': 'A wrong number was tapped; the code is used up.' }[err.code] ?? err.message
        show(roomShell('Log in with a signed-in device', html`<p class="room-error" role="alert">Not logged in: ${why}</p><p class="room-lead">Show a new code on the other device.</p><button type="button" class="room-primary" id="scan-again">Scan again</button>${backLink}`), '#scan-again')
        on('#scan-again', 'click', () => scanFlow()); wireBack()
      }
    })
  }

  // Accounts from before email + password: the address (/recover#r1…) and the recovery code shown back then.
  const addressInBar = () => (location.hash.startsWith('#r1.') ? location.href : '')
  const parseAddress = text => { if (!c.parseRoomLink) throw new Error('this version knows no account addresses'); return c.parseRoomLink(String(text).trim()) }

  function recoverFlow(error = '') {
    history.replaceState(null, '', `/recover${location.hash.startsWith('#r1.') ? location.hash : ''}`)
    show(roomShell('Recovery code', html`<p class="room-lead">For accounts made before email and password: the recovery code brings you back when no device is left. All earlier devices are removed, the agents stay, and you get a new code.</p>
${errorLine(error)}<form id="recover-form" class="room-form">
<label>Address (Settings → Advanced on an old device)<input name="room_link" value="${addressInBar()}" required autocomplete="off" inputmode="url"></label>
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
        const on_recovery_code = fresh => show(roomShell('Your new recovery code', html`<p class="room-lead">Write this down now. It replaces the old code.</p><p class="room-recovery" id="recovery-code">${fresh}</p><p class="room-wait">Recovering…</p>`), null)
        const { client, recovery_code } = await c.recoverRoom({ hub_url, room_id, code: String(f.get('code')).trim(), device_name: String(f.get('device_name')), storage: await storage(), client: CLIENT, on_recovery_code })
        recovery(client, recovery_code)
      } catch (err) { console.error(err); recoverFlow(err.code === 'bad-recovery-code' ? 'This code does not belong to this account.' : `Not recovered: ${err.message}`) }
    })
  }

  // The new recovery code after a recovery, shown once; the board opens only after the human confirmed keeping it.
  function recovery(client, code) {
    show(roomShell('Your new recovery code', html`<p class="room-lead">The old code no longer works. This is the new one. It is shown <b>only now</b>. Write it on paper or put it in your password manager.</p>
<p class="room-recovery" id="recovery-code">${code}</p>
<div class="room-actions"><button type="button" id="recovery-copy">Copy</button></div>
<form id="recovery-form" class="room-form"><label class="room-check"><input type="checkbox" name="kept" required> I have kept the code somewhere safe.</label>
<button type="submit" class="room-primary">Continue</button></form>`), '#recovery-copy')
    on('#recovery-copy', 'click', async e => { try { await navigator.clipboard.writeText(code); e.target.textContent = 'Copied' } catch { e.target.textContent = 'Please write it down' } })
    on('#recovery-form', 'submit', e => { e.preventDefault(); code = null; done(client) })
  }
}

// ---- qr ----
// QR codes for pairing, self-contained (no CDN, no dependency): qrSvg(text) draws the invite link as an SVG (byte mode,
// error correction M, versions 1-40, the mask with the lowest penalty), scanQr(video) reads one with the browser's
// BarcodeDetector where it exists. The encoder follows ISO/IEC 18004 as Project Nayuki's reference describes it.

const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28]
const BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49]
const FORMAT_M = 0

const rawModules = v => { let r = (16 * v + 128) * v + 64; if (v >= 2) { const n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36 } return r }
const dataCodewords = v => Math.floor(rawModules(v) / 8) - ECC_PER_BLOCK[v] * BLOCKS[v]
const bit = (x, i) => ((x >>> i) & 1) !== 0

function gfMul(x, y) { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x } return z }
function rsDivisor(degree) {
  const r = new Array(degree).fill(0); r[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) { r[j] = gfMul(r[j], root); if (j + 1 < r.length) r[j] ^= r[j + 1] }
    root = gfMul(root, 0x02)
  }
  return r
}
function rsRemainder(data, div) {
  const r = div.map(() => 0)
  for (const b of data) { const f = b ^ r.shift(); r.push(0); div.forEach((c, i) => { r[i] ^= gfMul(c, f) }) }
  return r
}

function alignmentPositions(v) {
  if (v === 1) return []
  const n = Math.floor(v / 7) + 2
  const step = v === 32 ? 26 : Math.ceil((v * 4 + 4) / (n * 2 - 2)) * 2
  const r = [6]
  for (let pos = v * 4 + 10; r.length < n; pos -= step) r.splice(1, 0, pos)
  return r
}

/** The modules of a QR code for `text` (UTF-8, byte mode, level M): an array of rows of booleans. */
function qrMatrix(text) {
  const bytes = [...new TextEncoder().encode(text)]
  let v = 1
  for (; v <= 40; v++) if (4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= dataCodewords(v) * 8) break
  if (v > 40) throw new Error('too long for a QR code')
  const cap = dataCodewords(v) * 8
  const bits = []
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1) }
  push(4, 4); push(bytes.length, v < 10 ? 8 : 16); for (const b of bytes) push(b, 8)
  push(0, Math.min(4, cap - bits.length)); push(0, (8 - bits.length % 8) % 8)
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) push(pad, 8)
  const data = []
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0))

  // Error correction, split into blocks and interleaved.
  const nb = BLOCKS[v], eccLen = ECC_PER_BLOCK[v], raw = Math.floor(rawModules(v) / 8)
  const short = nb - raw % nb, shortLen = Math.floor(raw / nb), div = rsDivisor(eccLen)
  const blocks = []
  for (let i = 0, k = 0; i < nb; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < short ? 0 : 1)); k += dat.length
    const ecc = rsRemainder(dat, div)
    if (i < short) dat.push(0)
    blocks.push(dat.concat(ecc))
  }
  const words = []
  for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= short) words.push(b[i]) })

  const size = v * 4 + 17
  const mod = Array.from({ length: size }, () => new Array(size).fill(false))
  const fn = Array.from({ length: size }, () => new Array(size).fill(false))
  const set = (x, y, dark) => { mod[y][x] = dark; fn[y][x] = true }
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0) }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4)
    }
  }
  const al = alignmentPositions(v), last = al.length - 1
  al.forEach((ax, i) => al.forEach((ay, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
  }))
  const format = mask => {
    const d = (FORMAT_M << 3) | mask
    let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537)
    const b = ((d << 10) | r) ^ 0x5412
    for (let i = 0; i <= 5; i++) set(8, i, bit(b, i))
    set(8, 7, bit(b, 6)); set(8, 8, bit(b, 7)); set(7, 8, bit(b, 8))
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(b, i))
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(b, i))
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(b, i))
    set(8, size - 8, true)
  }
  format(0)
  if (v >= 7) {
    let r = v; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25)
    const b = (v << 12) | r
    for (let i = 0; i < 18; i++) { const a = size - 11 + i % 3, c = Math.floor(i / 3); set(a, c, bit(b, i)); set(c, a, bit(b, i)) }
  }
  // The data, in the zigzag of two-module columns.
  for (let right = size - 1, i = 0; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert
      if (!fn[y][x] && i < words.length * 8) { mod[y][x] = bit(words[i >>> 3], 7 - (i & 7)); i++ }
    }
  }
  const MASKS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
    (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0]
  const applyMask = m => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[m](x, y)) mod[y][x] = !mod[y][x] }
  // Penalty (runs, 2x2 blocks, balance; the finder-look rule left out: any mask reads, this only picks a calmer one).
  const penalty = () => {
    let p = 0, dark = 0
    for (let y = 0; y < size; y++) {
      for (let x = 0, runX = 0, runY = 0; x < size; x++) {
        runX = x && mod[y][x] === mod[y][x - 1] ? runX + 1 : 1; if (runX === 5) p += 3; else if (runX > 5) p++
        runY = x && mod[x][y] === mod[x - 1][y] ? runY + 1 : 1; if (runY === 5) p += 3; else if (runY > 5) p++
        if (mod[y][x]) dark++
        if (x && y && mod[y][x] === mod[y][x - 1] && mod[y][x] === mod[y - 1][x] && mod[y][x] === mod[y - 1][x - 1]) p += 3
      }
    }
    return p + Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10
  }
  let best = 0, bestP = Infinity
  for (let m = 0; m < 8; m++) { applyMask(m); format(m); const p = penalty(); if (p < bestP) { best = m; bestP = p } applyMask(m) }
  applyMask(best); format(best)
  return mod
}

/** An SVG of the QR code (dark modules on white, with the quiet zone), scalable; `label` for screen readers. */
function qrSvg(text, label = 'QR-Code') {
  const m = qrMatrix(text), n = m.length + 8
  let d = ''
  m.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x + 4} ${y + 4}h1v1h-1z` }))
  return `<svg class="qr" viewBox="0 0 ${n} ${n}" role="img" aria-label="${label}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`
}

/** Can this browser read QR codes from the camera? */
async function canScan() {
  try { return 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia && (await BarcodeDetector.getSupportedFormats()).includes('qr_code') } catch { return false }
}

/** Read QR codes from the back camera into `video` until onText returns true or stop() is called. */
async function scanQr(video, onText) {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
  video.srcObject = stream
  video.setAttribute('playsinline', '')
  await video.play()
  const detector = new BarcodeDetector({ formats: ['qr_code'] })
  let on = true
  const stop = () => { on = false; for (const t of stream.getTracks()) t.stop(); video.srcObject = null }
  const tick = async () => {
    if (!on) return
    try { for (const c of await detector.detect(video)) if (await onText(c.rawValue)) return stop() } catch {}
    setTimeout(tick, 180)
  }
  tick()
  return stop
}

// ---- controller "room" ----
// The account pages' small helpers (auth.mjs): copy a link or command, select a read-only field on focus,
// Generate a password, download or print the Emergency Kit, and the storage numbers (navigator.storage; client.usage()).

const size = n => (n == null ? '–' : n < 1e3 ? `${n} B` : n < 1e6 ? `${(n / 1e3).toFixed(0)} kB` : n < 1e9 ? `${(n / 1e6).toFixed(1).replace('.', ',')} MB` : `${(n / 1e9).toFixed(2).replace('.', ',')} GB`)

controller('room', class extends Controller {
  static targets = ['field', 'label', 'local', 'hub']
  static values = { usage: String }

  connect() { if (this.hasLocalTarget) this.usage() }
  disconnect() { clearTimeout(this.timer) }

  select(e) { e.target.select() }
  async copy(e) {
    const ok = await copyText(e.params.text)
    const label = e.currentTarget.querySelector('[data-room-target="label"]')
    if (!label) return
    label.textContent = ok ? 'Copied' : 'Not copied'
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { label.textContent = 'Copy' }, 1800)
  }

  generate(e) { e.preventDefault(); generateInto(e.currentTarget) }
  download(e) { downloadKit(e.params.text) }
  print() { window.print() }

  async usage() {
    try { const e = await navigator.storage?.estimate?.(); this.localTarget.textContent = e ? size(e.usage) : 'unknown' } catch { this.localTarget.textContent = 'unknown' }
    if (!this.hasHubTarget) return
    try {
      const u = await window.trommi?.client?.usage?.()
      const used = u?.bytes ?? u?.used_bytes ?? u?.total_bytes
      const limit = u?.limit_bytes ?? u?.quota_bytes ?? u?.limit
      this.hubTarget.textContent = used == null ? 'unknown' : limit ? `${size(used)} of ${size(limit)}` : size(used)
      if (used != null && limit) { this.hubTarget.style.setProperty('--used', `${Math.min(100, (100 * used) / limit).toFixed(1)}%`); this.hubTarget.classList.add('has-bar') }
    } catch { this.hubTarget.textContent = 'not reachable' }
  }
})
