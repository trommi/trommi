// ---- room ----
// The room's own screens. Inside a room (pages of the board): /settings (one list, as iOS Settings: Invite a Device with
// its code and the emoji check in place, Invite Agent…, then a row per page: Sessions (agents.mjs), Devices, Account,
// Theme, Keyboard Shortcuts), /settings/devices (who is in the room, Push, inviting an agent,
// removing), /pair/:id (an agent's clipboard; a device's code), /settings/account (email, password, Emergency Kit; storage). Before a room (a screen of its own): Create
// account (email + a passkey where the device can, else or by choice a password; this device founds the room and its
// Emergency Kit is made at once), Log in (a passkey, email + password, or scan a signed-in device's code), Forgot
// password (Emergency Kit, ending in a new password or a new passkey), and the old recovery code. A device is
// never asked for its name (deviceLabel). The UI says "account", never "room".
// Calm and sober: this is about keys; pen drawings only on the choice buttons.
// Core features that may not be there yet (usage, session handover) are shown only when the core has them.
import { BELL, Controller, PLUS, SET_CHEVRON, avatar, controller, copyText, doodleSvg, errorLine, html, keysList, raw, roomPage, roomShell, setRow, setThemeMode, settingsPage, sk, sketchSvg, themeMode, sayError } from './ui.mjs'
import { CLIENT, account, checkEmoji, core, openInWorker, qrReader, ses } from './app.mjs'
const read = (k, f = null) => { try { return localStorage.getItem(k) ?? f } catch { return f } }
const write = (k, v) => { try { localStorage.setItem(k, v) } catch {} }
const foundCode = () => ses('trommi-found-code', new URLSearchParams(location.search).get('found_code')) || undefined
const art = name => raw(['phone', 'house'].includes(name) ? doodleSvg(`draw:${name}`) : sketchSvg(name))
const has = (o, fn) => typeof o?.[fn] === 'function'

// ---- passkeys: the ceremonies ----
// WebAuthn runs here, on the page; the core worker (core/account.ts) gets what a ceremony returned, as bytes. A passkey
// opens the account through the 32 bytes of its `prf` extension over a fixed input; they go to the worker and nowhere else.
/** The bytes of what WebAuthn hands back, copied: an ArrayBuffer or a view, also one made in another realm (a password
 *  manager's extension that answers create() and get() for the browser hands those: `instanceof` is false for them),
 *  or the base64url text some of them give instead. Anything else is no passkey answer (`passkey-failed`). */
const pkBytes = v => {
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice()
  if (v instanceof ArrayBuffer || Object.prototype.toString.call(v) === '[object ArrayBuffer]') return new Uint8Array(v).slice()
  if (typeof v === 'string' && /^[A-Za-z0-9_-]*={0,2}$/.test(v)) return unb64u(v.replace(/=+$/, ''))
  throw pkError('passkey-failed', 'the passkey\'s answer holds no bytes where WebAuthn puts them')
}
const unb64u = text => Uint8Array.from(atob(String(text).replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0))
const b64u = b => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
/** The relying-party id: this page's own host. app.trommi.com for the app (fixed, for good); a development or preview
 *  build has its own, and the hub takes no other from it. */
const pkRpId = () => location.hostname
const pkError = (code, message) => Object.assign(new Error(message), { code })
/** What a ceremony throws, in the app's codes (a DOMException's own code is a number): the prompt was closed (passkey-cancelled), this page ended it (passkey-aborted), the authenticator holds one already (passkey-exists). */
const pkFail = err => (typeof err?.code === 'string' ? err : err?.name === 'AbortError' ? pkError('passkey-aborted', 'ended') : err?.name === 'InvalidStateError' ? pkError('passkey-exists', 'this passkey is here already') : err?.name === 'NotAllowedError' ? pkError('passkey-cancelled', 'no passkey was used') : pkError('passkey-failed', err?.message ?? 'the passkey did not work'))
/**
 * A ceremony's answer read field by field: from its JSON form (`toJSON()`, WebAuthn level 3: base64url text, what
 * Chrome and a passkey provider such as 1Password give whole) where it has one, else from the objects themselves
 * (whose getters a provider may leave empty). A field that is in neither: `passkey-failed`, naming the field.
 */
function pkRead(cred) {
  let json = null
  try { json = typeof cred?.toJSON === 'function' ? cred.toJSON() : null } catch { json = null }
  const raw = cred?.response ?? {}, jr = json?.response ?? {}
  const pick = (name, fromJson, fromRaw, optional = false) => {
    for (const v of [fromJson, fromRaw]) if (v != null && v !== '') try { return pkBytes(v) } catch { /* the other form */ }
    if (optional) return null
    throw pkError('passkey-failed', `the passkey answer lacks ${name}`)
  }
  let ext = null
  try { ext = cred?.getClientExtensionResults?.() ?? null } catch { ext = null }
  const prfOf = e => e?.prf?.results?.first
  return {
    field: (name, optional = false) => pick(name, jr[name], raw[name], optional),
    id: () => pick('rawId', json?.rawId ?? json?.id, cred?.rawId),
    transports: () => { try { return jr.transports ?? raw.getTransports?.() ?? [] } catch { return [] } },
    prf: () => pick('prf result', prfOf(json?.clientExtensionResults), prfOf(ext), true),
    prfEnabled: () => (json?.clientExtensionResults?.prf ?? ext?.prf)?.enabled,
  }
}
const pkList = ids => ids.map(id => ({ type: 'public-key', id }))
/** A passkey that came to nothing (no account, or it cannot unlock): tell its store to drop it, where the browser can. */
/** Did the step certainly leave no passkey registered? Not when the hub was not reached or did not answer as it should, the worker went away, or the core says the passkey was kept: it may be a way in then, and stays in its store. */
const cameToNothing = err => err?.passkey_kept !== true && err?.transient !== true && !['offline', 'bad-answer', 'worker-failed', 'worker-timeout'].includes(err?.code)
const passkeyForget = id => { try { Promise.resolve(window.PublicKeyCredential?.signalUnknownCredential?.({ rpId: pkRpId(), credentialId: b64u(id) })).catch(() => {}) } catch {} }
/**
 * What this device can do with passkeys, before anything is tried (whether its passkeys have prf is known only once one is made: passkeyMake):
 * create: offer "Create with passkey" first (a platform authenticator with user verification, and no word that prf is
 * missing); get: a passkey may be used to log in (also one on a phone or a key); conditional: offer one in the email field.
 */
/**
 * Passkeys are switched off for the launch (the owner's call, 2026-10-10): no "Create with passkey", no "Log in with
 * passkey" nor the field's passkey offer, no "Add passkey". All of it stays in the code and is switched on for a tab
 * by `?passkeys=1` (kept for the tab session, as `?hub=`), which the tests use; PASSKEYS_ON turns it on for everyone.
 */
const PASSKEYS_ON = false
const passkeysOn = () => {
  try {
    const asked = new URLSearchParams(location.search).get('passkeys')
    if (asked !== null) { if (asked === '1') sessionStorage.setItem('trommi-passkeys', '1'); else sessionStorage.removeItem('trommi-passkeys') }
    return PASSKEYS_ON || sessionStorage.getItem('trommi-passkeys') === '1'
  } catch { return PASSKEYS_ON }
}
async function passkeyOffer() {
  if (!passkeysOn()) return { create: false, get: false, conditional: false, off: true }
  if (typeof window.PublicKeyCredential !== 'function' || !navigator.credentials?.create) return { create: false, get: false, conditional: false }
  let caps = null
  try { caps = await PublicKeyCredential.getClientCapabilities?.() ?? null } catch {}
  let platform = caps?.userVerifyingPlatformAuthenticator
  try { platform ??= await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable() } catch {}
  let conditional = caps?.conditionalGet
  try { conditional ??= await PublicKeyCredential.isConditionalMediationAvailable?.() } catch {}
  return { create: platform === true && caps?.['extension:prf'] !== false, get: true, conditional: conditional === true }
}
/** get(): the assertion as bytes with its prf output (null when the passkey gave none). Without a challenge: a random one (an unlock on this page that is sent nowhere). */
async function passkeyGet({ challenge = null, allow = [], mediation, signal } = {}) {
  const input = await (await account()).passkeyPrfInput()
  let cred
  try {
    cred = await navigator.credentials.get({ ...(mediation ? { mediation } : {}), ...(signal ? { signal } : {}),
      publicKey: { challenge: challenge ? unb64u(challenge) : crypto.getRandomValues(new Uint8Array(32)), rpId: pkRpId(), userVerification: 'required', allowCredentials: pkList(allow), extensions: { prf: { eval: { first: input } } } } })
  } catch (err) { throw pkFail(err) }
  const a = pkRead(cred), handle = a.field('userHandle', true)
  return { credential_id: a.id(), authenticator_data: a.field('authenticatorData'), client_data_json: a.field('clientDataJSON'), signature: a.field('signature'), user_handle: handle?.length ? handle : null, prf: a.prf() }
}
/**
 * A new passkey with the 32 bytes that will seal the account's copy. create() (discoverable, user verification, prf
 * asked for): one prompt. Its prf output comes with the creation; a store that only says "prf is on" there gives it in
 * one get() right after (a second prompt, the only way to have the bytes). There is no proof beyond that: should a
 * passkey ever give other bytes later, the Emergency Kit opens the account. A store without prf: { code: 'no-prf' },
 * the passkey is told to go, and nothing was sent anywhere. `user_handle`: the account's id as its 16 bytes (the hub
 * names it with the challenge); `name`: what a passkey list shows for it, the email or, without one, the account's ID.
 */
async function passkeyMake({ challenge, user_handle, name, exclude = [] }) {
  const input = await (await account()).passkeyPrfInput()
  let cred
  try {
    cred = await navigator.credentials.create({ publicKey: {
      challenge: unb64u(challenge), rp: { id: pkRpId(), name: 'Trommi' }, user: { id: user_handle, name, displayName: name },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }],
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      attestation: 'none', excludeCredentials: pkList(exclude), extensions: { prf: { eval: { first: input } } },
    } })
  } catch (err) { throw pkFail(err) }
  const a = pkRead(cred), id = a.id()
  try {
    let prf = a.prf()
    // (a provider that gives the prf output only at get(): asked at once, for this credential. Nothing has reached the
    //  hub but the challenge: the account is made only with the key in hand, in one request with the room)
    if (!prf && a.prfEnabled() !== false) prf = await passkeyGet({ allow: [id] }).then(got => got.prf, err => { if (err?.code === 'passkey-aborted') throw err; return null })
    if (!prf) throw pkError('no-prf', 'the passkey answer lacks prf result')
    return { credential_id: id, attestation_object: a.field('attestationObject'), client_data_json: a.field('clientDataJSON'), transports: a.transports(), prf }
  } catch (err) { passkeyForget(id); throw err }
}
/** A signed-in device opens the account with one of its passkeys (for a new kit, a password, another passkey): { credential_id, prf }. */
async function passkeyUnlock(st) {
  const got = await passkeyGet({ allow: (st?.passkeys ?? []).map(p => unb64u(p.credential_id)) })
  if (!got.prf) throw pkError('no-prf', 'this passkey gives no key here')
  return { credential_id: got.credential_id, prf: got.prf }
}
const NO_PRF = 'The passkey was saved but cannot unlock Trommi. Delete it in your password manager and use a password.'
/** Said once, quietly, where a browser has no WebAuthn at all: the password is the way then. */
const NO_PASSKEYS = html`<p class="ob-alt ob-way ob-none" id="no-passkeys">No passkeys in this browser. A password works everywhere.</p>`
const NO_PRF_HERE = 'This passkey can\'t unlock Trommi here. Use your password.'
// The check code as six emoji with a word under each: the same on both devices (and in a connector's terminal). The human
// compares them; the function is the core's (core/check-emoji.ts), so app and connector cannot drift apart.
const emojiRow = (code, id = '') => html`<ol class="check-emoji"${id ? raw(` id="${id}"`) : ''} data-code="${code}" aria-label="Check code: ${checkEmoji(code).map(e => e.word).join(', ')}">${checkEmoji(code).map(e => html`<li><span class="check-emoji-glyph" aria-hidden="true">${e.emoji}</span><span class="check-emoji-word">${e.word}</span></li>`)}</ol>`
// The two answers to "the same six?": the only way to confirm (no typing, no picking), only on the device that made the link.
// (here: the page the answer comes back to; 'settings' is the Settings list, where the device's code stands in place)
const matchButtons = (inv, yesLabel = 'They match', here = '') => { const back = here ? html`<input type="hidden" name="in" value="${here}">` : ''; return html`<div class="check-answer"><form method="post" action="/pair/${inv.invite_id}/confirm">${back}<input type="hidden" name="match" value="yes"><button type="submit" class="room-primary check-yes">${yesLabel}</button></form><form method="post" action="/pair/${inv.invite_id}/confirm">${back}<input type="hidden" name="match" value="no"><button type="submit" class="check-no">They don't match</button></form></div>` }
// A read-only field with its value and a Copy button (controller "room").
const copyBox = (value, label, cls = '') => html`<div class="room-link${cls ? ` ${cls}` : ''}" data-controller="room"><input readonly value="${value}" aria-label="${label}" data-room-target="field" data-action="focus->room#select"><button type="button" data-action="room#copy" data-room-text-param="${value}"><span data-room-target="label">Copy</span></button></div>`
const sessionName = s => s.settings?.name || s.profile?.agent_name || s.agent_session_id || s.device_name || 'Session'

// ---- inside a room: devices, pairing, settings (pages of the board, rendered like any other) ----
export function register(t) {
  // (an Emergency Kit's address opened on a device that is logged in: nothing to recover here; the fragment goes)
  if (location.hash.startsWith('#k1.')) history.replaceState(null, '', location.pathname + location.search)
  const client = t.hub.client
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
${me && d.is_active && has(client, 'setRegisters') ? html`<form method="post" action="/devices/rename" class="room-remove room-rename"><details><summary>Rename</summary><input name="device_name" value="${d.device_name ?? ''}" maxlength="40" required autocomplete="off" aria-label="Name of this device"><button type="submit" class="room-primary">Save</button></details></form>` : ''}
${canRemove ? html`<form method="post" action="/devices/remove" class="room-remove"><input type="hidden" name="device_id" value="${d.device_id}"><details><summary>Remove</summary><p>${human
        ? html`${name} can open nothing new after this. Everyone else gets a new key; that takes a moment.`
        : html`${name} can read nothing new after this. The others get a new key; the session's history stays.`}</p><button type="submit" class="room-danger">Remove ${name}</button></details></form>` : ''}</li>`
    }
    // The earlier conversation stays closed unless the human opens it: an agent invite comes without history.
    const historyAsk = () => html`<fieldset class="room-history"><legend>May it read the earlier conversation?</legend><label><input type="radio" name="with_history" value="no" checked> No</label><label><input type="radio" name="with_history" value="yes"> Yes</label></fieldset>`
    const sessionOptions = (except = null) => [...m().sessions.values()].filter(s => s.agent_device_id !== except).map(s => html`<option value="${s.session_id ?? s.agent_session_id ?? s.agent_device_id}">${sessionName(s)}</option>`)
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
      const L = lists()
      return roomPage('Devices', html`${errorLine(error)}
<section class="room-section" aria-labelledby="people-head"><h3 id="people-head">Your devices</h3>${raw(L.people)}</section>
${isHuman() ? html`<section class="room-section push-section" aria-labelledby="push-head"><h3 id="push-head">Push</h3>
<fieldset class="push-level" id="push-level"><legend>Push on this device</legend>
<label><input type="radio" name="push-level" value="all"><span>Yes</span></label><label><input type="radio" name="push-level" value="knocking"><span>Only knocking</span></label><label><input type="radio" name="push-level" value="off" checked><span>No</span></label>
</fieldset>
<p class="room-meta">Only knocking: a card marked high or critical (the ones that knock on the Desk), and a session that lost its connection.</p>
<p class="push-level-note" id="push-level-note" role="status"></p>
<ul class="push-others" id="push-others" aria-label="Push on your other devices"></ul></section>` : ''}
<section class="room-section" aria-labelledby="agents-head"><h3 id="agents-head">Agents</h3>${raw(L.agents)}
${isHuman() ? html`<form method="post" action="/pair" class="room-agent-form"><input type="hidden" name="role" value="agent"><label>Name of the session<input name="label" maxlength="40" placeholder="e.g. Website" autocomplete="off"></label>${has(client, 'createInvite') && m().sessions.size ? html`<label>Takes over<select name="session_id"><option value="">a new session</option>${sessionOptions()}</select></label>${historyAsk()}` : ''}<button type="submit" id="agent-invite">Invite an agent</button></form>` : ''}</section>
${raw(L.gone)}
<p class="room-meta">A new device: <a href="/settings" data-nav>Invite a Device</a> in Settings, or open app.trommi.com on it and log in. A device names itself; rename this one above. Every device holds its own keys; the hub sees sealed envelopes only. The fingerprint comes from the signed member list: it must look the same on every device.</p>`, 'The people and agents with keys to this account.')
    }
    t.get(/^\/settings\/devices$/, ({ req, res }) => page(req, res, 'Devices · Settings', devicesMain(), { stream: '&room=devices' }))
    t.post(/^\/devices\/remove$/, async ({ req, res, form }) => {
      try { await client.removeDevices([String(form.get('device_id'))]) } catch (err) { return page(req, res, 'Devices', devicesMain(`Not removed: ${sayError(err)}`), {}, 422) }
      t.redirect(res, '/settings/devices')
    })
    // This device's own name (asked nowhere: deviceLabel made it): its register device/<id>, which only it may write.
    t.post(/^\/devices\/rename$/, async ({ req, res, form }) => {
      const me = m().members.get(m().room.my_device_id), device_name = String(form.get('device_name') ?? '').trim().slice(0, 40)
      try {
        if (!me || !device_name) throw new Error('a name is missing')
        await client.setRegisters({ [`device/${me.device_id}`]: { device_name, ...Object.fromEntries(['platform', 'folder', 'host'].filter(k => me[k] != null).map(k => [k, me[k]])) } }, { own_device: true })
      } catch (err) { return page(req, res, 'Devices', devicesMain(`Not renamed: ${sayError(err)}`), {}, 422) }
      t.redirect(res, '/settings/devices')
    })
    // The desk a new agent's session goes on: the desk in view; on "All desks" the desk of the session open there (the
    // page the invite was made from), else the first desk. Kept with the invite on this device (createInvite desk).
    const inviteDesk = req => {
      const bm = t.model()
      if (!bm.desks?.length) return null
      if (!bm.all) return bm.desk
      const at = new URL(String(req.headers.referer ?? '/'), location.origin).pathname, ref = /^\/chat\/([^/+]+)/.exec(at)?.[1], sid = ref ? (() => { try { return decodeURIComponent(ref) } catch { return ref } })() : null
      const a = sid ? bm.everyone?.find(x => x.id === sid || x.device_id === sid) : null
      return a ? bm.deskOf(a) : bm.desks[0].id
    }
    t.post(/^\/pair$/, async ({ req, res, form }) => {
      try {
        const agent = form.get('role') === 'agent'
        const label = String(form.get('label') ?? '').trim() || null
        // continue=<session>: "Copy invite link again" on a session's page. The link is for THAT session: the connector that
        // joins with it continues it, after the human confirmed its check code here (the core: createInvite takeover).
        // session_id: "Takes over" on the Devices page, the same kind of link (the client hands the session over when
        // the new agent has joined).
        const cont = agent ? String(form.get('continue') ?? '') || String(form.get('session_id') ?? '') : ''
        const invite = await client.createInvite({ device_role: agent ? 'agent' : 'human', app_url: `${location.origin}/join`, ...(agent && label ? { label } : {}), ...(cont ? { session_id: cont, takeover: true, ...(form.get('with_history') != null ? { with_history: form.get('with_history') === 'yes' } : {}) } : agent ? { desk: inviteDesk(req) } : {}) })
        t.redirect(res, !agent && form.get('in') === 'settings' ? `/settings?pair=${invite.invite_id}` : `/pair/${invite.invite_id}`)
      } catch (err) { if (form.get('in') === 'settings') return home(req, res, '', `No code: ${sayError(err)}`, 422); page(req, res, 'Devices', devicesMain(`No invite: ${sayError(err)}`), {}, 422) }
    })
    t.live('room', {
      take: () => lists(),
      diff: (was, now) => ['people', 'agents', 'gone'].map(k => (was[k] !== now[k] ? String(t.stream('replace', `room-${k}`, raw(now[k]))) : '')).join(''),
    })

    // ---- /pair/:id ----
    const newcomerName = inv => (inv.newcomer && m().members.get(inv.newcomer.device_id)?.device_name) || inv.newcomer?.device_name || ''
    const again = (agent, word = 'Pair again') => html`<form method="post" action="/pair" class="room-inline"><input type="hidden" name="role" value="${agent ? 'agent' : 'human'}"><button type="submit" class="room-primary">${word}</button></form>`
    const back = html`<a href="/settings/devices" data-nav class="room-back">Back to the devices</a>`
    // ---- inviting an agent: a clipboard with a short checklist ----
    // Three commands, each one big thing to press (it copies): install the connector (once per machine), set it up for
    // Claude Code or Codex (once per program), connect the folder with the link (once per folder; the link goes to the
    // connector by the human's hands only, never into the model's prompt). Then waiting: the line ticks itself when the
    // agent is in, and shows who came; last, start the program there.
    const CLAMP = raw('<svg class="clip-clamp" viewBox="0 0 120 44" aria-hidden="true"><path class="clamp-plate" d="M22 40 Q21 25 26 22 L43 21 Q46 9 60 8 Q74 9 77 21 L94 22 Q99 25 98 40 Z"/><path d="M52 21 Q53 15 60 14.6 Q67 15 68 21"/><path d="M30 31 Q60 29.4 90 31"/></svg>')
    const TICKBOX = raw('<svg class="clip-box" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.6 5.2 Q12 4.4 19.3 4.9 Q20 12 19.5 19.2 Q12 20 4.9 19.4 Q4.2 12 4.6 5.2 Z"/><path class="clip-tick" d="M7.4 12.6 Q9.6 14.6 10.9 16.6 Q14.6 10.2 20.6 5.2"/></svg>')
    const wrapAt = text => text.split(/(?<=[^/:]\/)/).map((part, i) => html`${i ? raw('<wbr>') : ''}${part}`)
    const copyLine = (text, word, line, shown = wrapAt(text)) => html`<button type="button" class="clip-copy" data-line="${line}" data-action="invite-clip#copy" data-invite-clip-text-param="${text}" title="Copy"><code>${shown}</code><span class="clip-copy-word" data-word="${word}">${word}</span></button>`
    /** The connect command as shown: every invite link of an account starts alike (app, version, hub, room), so the
     *  hub and the room are folded into an ellipsis and the part that is this invite's own (its secret and deadline)
     *  stays in view. The folded text is still there (text and Copy take the whole command). */
    const connectShown = command => {
      const at = command.indexOf('#'), parts = at < 0 ? [] : command.slice(at + 1).split('.')
      if (parts.length < 5) return wrapAt(command)
      const head = command.slice(0, at + 1) + parts[0] + '.', mid = `${parts[1]}.${parts[2]}.`, tail = parts.slice(3).join('.')
      return html`${wrapAt(head)}<span class="clip-link-same" data-same="…">${mid}</span><wbr><span class="clip-link-own">${tail}</span>`
    }
    const step = (state, inner) => html`<li class="clip-step${state ? ` is-${state}` : ''}">${TICKBOX}<div class="clip-step-body">${inner}</div></li>`
    /** What is left of a link's time, in words: never "0 more min". */
    /** The two lines of an agent invite (as the iOS agentConnectSteps): the installer once per machine (it sets up
     *  Claude Code and Codex where installed), then the slash command inside claude with the invite's link. */
    const INSTALL = 'curl -fsSL https://raw.githubusercontent.com/trommi/trommi/main/install.sh | sh'
    const connectCommand = link => `/trommi:connect '${link}'`
    const leftWords = until => { const ms = until - Date.now(); return ms > 90_000 ? `${Math.round(ms / 60000)} more min.` : ms > 0 ? 'less than a minute.' : 'no time left.' }
    const clipboard = (inv, error = '') => {
      // (an unused link whose time is up has run out; once a connector has answered it (check code, adding) the page stays
      // open until the agent is really in, or the hub says the invite ended)
      const late = inv.expires_at <= Date.now()
      const state = late && inv.invite_state === 'open' ? 'expired' : inv.invite_state, open = state === 'open', joined = state === 'joined', coming = state === 'adding' || state === 'confirm_code'
      const dead = !open && !joined && !coming
      const who = joined ? t.model().agents.find(a => a.agent_device_id === inv.newcomer?.device_id || a.id === inv.newcomer?.device_id) ?? null : null
      const name = newcomerName(inv) || who?.name || 'The agent'
      const done = open ? '' : 'done'
      // A link that continues an existing session ("Copy invite link again"): the human sees which session, and
      // confirms that the six emoji the new connector's terminal shows are the ones shown here before anything is granted.
      const cont = inv.takeover ? t.model().everyone?.find(a => a.device_id === inv.session_id || a.session_id === inv.session_id) ?? t.model().agents.find(a => a.device_id === inv.session_id) ?? null : null
      const contName = inv.takeover ? cont?.label || cont?.given || cont?.name || 'this session' : ''
      // the session it continues is gone (deleted, archived, removed): nothing to continue, only the way back
      // (only while nobody answered the link: continuing retires the old holder, which must not read as "gone")
      if (inv.takeover && !joined && (cont?.archived || (open && !cont))) return html`<main id="room" class="room room-clip" aria-label="Continue a session"><div id="invite-${inv.invite_id}" class="room-invite" data-state="gone"><section class="clip">${CLAMP}<h2>Continue ${contName}</h2><p class="clip-sub">The session this link continues is gone: it was deleted or put in the archive. The link does nothing any more.</p><a href="/" data-nav class="room-done clip-done">Back to the Desk</a></section></div></main>`
      const ask = state === 'confirm_code' && checkEmoji(inv.check_code).length > 0
      const keep = inv.takeover ? html`<input type="hidden" name="continue" value="${inv.session_id}">` : ''
      const last = ask ? html`<div class="clip-ask" role="group" aria-label="${inv.takeover ? `Confirm: continue ${contName}` : 'Confirm the agent'}"><b>${inv.takeover ? `A connector wants to continue ${contName}.` : 'An agent wants to join.'}</b>
<small>Its terminal shows six emoji, each with a word. Are they these, in this order?</small>
${emojiRow(inv.check_code)}
${inv.takeover ? html`<small>If they match, that connector continues <strong>${contName}</strong>: its questions, helper sessions and conversation. The connector that held ${contName} until now is retired.</small>` : ''}
${matchButtons(inv)}
${errorLine(error)}<small>"They don't match" burns the link: nobody is added${inv.takeover ? html`, and ${contName} stays as it is` : ''}.</small></div>`
        : joined && inv.takeover ? html`<b class="clip-in">${cont ? avatar(cont, { crown: false }) : ''}<span>${contName} goes on with the new connector</span></b><small>The connector that held it before is retired.</small>`
        : joined ? html`<b class="clip-in">${who ? avatar(who, { crown: false }) : ''}<span>${name} is in</span></b>`
        : coming ? html`<b>Adding ${newcomerName(inv) || 'the agent'}…</b>`
        : dead ? html`<b>${state === 'expired' ? 'This link has run out' : inv.error === 'code-mismatch' ? 'They did not match: nobody was added' : `That did not work${inv.error ? ` (${inv.error})` : ''}`}</b>${errorLine(error)}`
        : html`<b>Compare the six emoji Claude shows with the ones here</b><small>Nobody is added before you tap "They match".</small>`
      const foot = joined ? html`<a href="/" data-nav class="room-done clip-done">Done</a>`
        : dead ? html`<form method="post" action="/pair" class="clip-again"><input type="hidden" name="role" value="agent">${keep}<button type="submit">New link</button></form>`
        : coming ? html`<p class="clip-note">The link is in use: this page stays until the agent is in.</p>`
        : html`<p class="clip-note">The link works once · <span data-invite-clip-target="left">${leftWords(inv.expires_at)}</span></p>`
      return html`<main id="room" class="room room-clip" aria-label="${inv.takeover ? `Continue ${contName}` : 'Invite an agent'}"><div id="invite-${inv.invite_id}" class="room-invite" data-state="${state}">
<section class="clip" data-controller="invite-clip" data-invite-clip-until-value="${open ? inv.expires_at : 0}">${CLAMP}
${inv.takeover ? html`<h2>Continue ${contName}</h2><p class="clip-sub">A link for this session: the connector that joins with it goes on as ${contName}. On a Linux or macOS computer with Claude Code or Codex.</p>`
        : html`<h2>Invite an agent</h2><p class="clip-sub">On a Linux or macOS computer with Claude Code or Codex.</p>`}
<ol class="clip-list">
${step(done, html`<b>First time on this computer? Install:</b>${open ? html`${copyLine(INSTALL, 'Copy', 'install')}<small>Skip this if you have installed Trommi before (check: <code>trommi-connector --version</code>).</small>` : ''}`)}
${step(done, html`<b>In your project folder, start claude (or codex) and paste:</b>${open ? html`${copyLine(connectCommand(inv.link), 'Copy', 'connect', connectShown(connectCommand(inv.link)))}<small>Claude Code asks once whether to use the trommi MCP server: choose "Use this MCP server". In Codex: ask it to connect with this link.</small>` : ''}`)}
${step(joined ? 'done' : dead ? 'dead' : ask ? 'ask' : open ? '' : 'wait', last)}
</ol>${foot}</section></div></main>`
    }
    const inviteMain = (inv, error = '') => {
      if (!inv) return roomShell('Invite', html`<p class="room-lead">This invite is gone.</p>${back}`)
      const agent = inv.device_role === 'agent', state = inv.invite_state
      let body
      if (agent) return clipboard(inv, error)
      if (state === 'open') body = html`<div class="room-pair"><div class="room-qr" data-controller="room">${raw(qrSvg(inv.link, 'QR code to pair'))}</div>
<ol class="room-steps"><li>On the new device, open the camera and scan the code. Or open app.trommi.com there and choose "Pair a device".</li><li>Both devices then show six emoji. If they are the same, tap "They match" here.</li></ol></div>
<details class="room-more"><summary>No scanner? Send the link</summary><p class="room-meta">Send the link to yourself (a message to yourself works) and open it on the new device. The secret is after the #; it never reaches a server.</p>${copyBox(inv.link, 'Invite link')}</details>
<p class="room-wait">Waiting for the new device… The code works once, ${leftWords(inv.expires_at)}</p>`
      else if (state === 'confirm_code') body = html`<p class="room-lead">A device wants to join. Does it show these six emoji, in this order?</p>
${emojiRow(inv.check_code)}${matchButtons(inv)}
${errorLine(error)}<p class="room-meta">"They don't match" burns the invite: nobody is added.</p>${back}`
      else if (state === 'adding') body = html`<p class="room-wait">Adding ${newcomerName(inv) || (agent ? 'the agent' : 'the device')}…</p>`
      else if (state === 'joined') {
        body = html`<p class="room-lead room-ok">✓ ${newcomerName(inv) || (agent ? 'The agent' : 'The new device')} is in now.</p><a href="/settings/devices" data-nav class="room-done">Done</a>`
      } else if (inv.error === 'code-mismatch') body = html`<p class="room-error" role="alert">They did not match. Nobody was added; the invite is used up.</p>${again(agent)}${back}`
      else body = html`<p class="room-error" role="alert">${state === 'expired' ? 'The invite has expired.' : `That did not work${inv.error ? ` (${inv.error})` : ''}.`}</p>${errorLine(error)}${again(agent)}${back}`
      return roomShell(agent ? 'Invite an agent' : state === 'confirm_code' ? 'Add a new device?' : 'Pair a device', html`<div id="invite-${inv.invite_id}" class="room-invite" data-state="${state}">${body}</div>`)
    }
    t.get(/^\/pair\/([0-9a-f]+)$/, ({ req, res, match }) => {
      const inv = m().invites.get(match[1])
      page(req, res, inv?.device_role === 'agent' ? 'Invite an agent' : 'Pair a device', inviteMain(inv), { view: 'invite', stream: `&invite=${match[1]}` })
    })
    t.post(/^\/pair\/([0-9a-f]+)\/confirm$/, async ({ req, res, match, form }) => {
      const list = form.get('in') === 'settings'
      try { await client.confirmInvite(match[1], form.get('match') === 'yes') } catch (err) {
        if (list) return home(req, res, match[1], err.code === 'code-mismatch' ? '' : sayError(err), 422)
        return page(req, res, 'Pair a device', inviteMain(m().invites.get(match[1]), err.code === 'code-mismatch' ? '' : sayError(err)), { view: 'invite', stream: `&invite=${match[1]}` }, 422)
      }
      t.redirect(res, list ? `/settings?pair=${match[1]}` : `/pair/${match[1]}`)
    })
    t.live('invite', {
      take: (mm, clients) => new Map(clients.map(c => c.params.get('invite')).filter(Boolean).map(id => { const inv = m().invites.get(id); return [id, String(inviteMain(inv)).replace(/\d+ more min\.|less than a minute\.|no time left\./g, '').replace(/data-invite-clip-until-value="\d+"/, '')] })),
      diff: (was, now, c) => { const id = c.params.get('invite'); return was.get(id) !== now.get(id) ? String(t.stream('refresh')) : '' },
    })

    // ---- /settings: the list ----
    // At its top the two invites. A device's code is drawn blurred until it is asked for: only then is an invite made
    // (POST /pair in=settings), never on the page's load; the code, the six emoji and "They match" then stand in place
    // (/settings?pair=<invite>, kept current by the live piece "invite"). Under them a row per page.
    const deviceInvite = (inv, error = '') => {
      const state = inv ? (inv.expires_at <= Date.now() && inv.invite_state === 'open' ? 'expired' : inv.invite_state) : 'none'
      const head = (words, line) => html`<div class="set-text"><b>${words}</b>${line ? html`<small>${line}</small>` : ''}</div>`
      const fresh = (word = 'Show Code', line = 'A phone or another computer scans the code. It is made when you ask for it and works once.') => html`<form method="post" action="/pair" class="set-pair"><input type="hidden" name="role" value="human"><input type="hidden" name="in" value="settings"><button type="submit" class="set-qr" id="settings-pair" aria-label="${word}: the code to invite a device"><span class="set-qr-code">${FAKE_QR}</span><span class="set-qr-show">${word}</span></button>${head('Invite a Device', line)}</form>`
      let inner
      if (state === 'none') inner = fresh()
      else if (state === 'open') inner = html`<div class="set-pair"><div class="set-qr is-real">${raw(qrSvg(inv.link, 'QR code to invite a device'))}</div><div class="set-text"><b>Invite a Device</b><small>On the new device, open the camera and scan the code. Both devices then show six emoji.</small><p class="room-wait">Waiting for the new device… The code works once, ${leftWords(inv.expires_at)}</p><details class="room-more"><summary>No scanner? Send the link</summary><p class="room-meta">Send it to yourself and open it on the new device. The secret is after the #; it never reaches a server.</p>${copyBox(inv.link, 'Invite link')}</details></div></div>`
      else if (state === 'confirm_code') inner = html`${head('A device wants to join', 'Does it show these six emoji, in this order?')}${emojiRow(inv.check_code)}${matchButtons(inv, 'They match', 'settings')}${errorLine(error)}<small class="set-note">"They don't match" burns the code: nobody is added.</small>`
      else if (state === 'adding') inner = html`${head('Invite a Device')}<p class="room-wait">Adding ${newcomerName(inv) || 'the device'}…</p>`
      else if (state === 'joined') inner = html`<div class="set-pair"><span class="set-in">${sk('tick')}</span>${head(`${newcomerName(inv) || 'The new device'} is in now.`, 'It holds keys of its own; you see it under Devices.')}<a class="set-pill" href="/settings" data-nav id="settings-pair-done">Done</a></div>`
      else inner = html`${errorLine(state === 'expired' ? 'The code has run out.' : inv.error === 'code-mismatch' ? 'They did not match. Nobody was added; the code is used up.' : `That did not work${inv.error ? ` (${inv.error})` : ''}.`)}${fresh('Show a New Code', '')}`
      return html`<div class="set-device" id="set-device" data-state="${state}">${inner}</div>`
    }
    const SHOWN = { light: 'Light', dark: 'Dark', system: 'System' }
    const homeMain = (inv, error = '') => {
      const bm = t.model(), members = [...(m().members?.values() ?? [])].filter(d => d.is_active)
      const people = members.filter(d => d.device_role === 'human').length
      return settingsPage('Settings', html`${inv === undefined ? errorLine(error) : ''}
${isHuman() ? html`<section class="set-group set-invites" aria-label="Invite">${deviceInvite(inv ?? null, error)}
<form method="post" action="/pair" class="set-agent"><input type="hidden" name="role" value="agent"><button type="submit" class="set-row" id="settings-invite-agent"><span class="set-ico">${PLUS}</span><b>Invite Agent…</b><span class="set-detail">a command for Claude Code</span>${SET_CHEVRON}</button></form></section>` : ''}
<nav class="set-group" aria-label="Settings">
${setRow({ href: '/settings/sessions', icon: sk('heads'), word: 'Sessions', detail: `${bm.agents.filter(a => a.online).length} of ${bm.agents.length} connected`, id: 'settings-sessions' })}
${setRow({ href: '/settings/devices', icon: art('phone'), word: 'Devices', detail: people ? `${people} ${people === 1 ? 'device' : 'devices'}` : '', id: 'settings-devices' })}
${isHuman() ? setRow({ href: '/settings/account', icon: sk('key'), word: 'Account', detail: m().room.account ? m().room.account.email ?? 'Passkey' : '', id: 'settings-account' }) : ''}
</nav>
<nav class="set-group" aria-label="This device">
${setRow({ href: '/settings/theme', icon: sk('moon'), word: 'Theme', detail: SHOWN[themeMode()] ?? 'System', id: 'settings-theme' })}
${setRow({ href: '/settings/keys', icon: sk('keycap'), word: 'Keyboard Shortcuts', id: 'settings-keys' })}
</nav>
<nav class="set-group" aria-label="About">
${setRow({ href: '/settings/proof', icon: sk('tick'), word: 'MLS proof', detail: 'self test', id: 'settings-proof' })}
</nav>
`, { back: false })
    }
    const home = (req, res, pairId = '', error = '', code = 200) => {
      const inv = pairId ? m().invites.get(pairId) ?? null : undefined
      page(req, res, 'Settings', homeMain(inv, error), pairId ? { view: 'invite', stream: `&invite=${pairId}` } : { view: 'settings' }, code)
    }
    t.get(/^\/settings$/, ({ req, res, url }) => { if (client.hub && isHuman() && m().room.account === undefined) loadAccount(); home(req, res, url.searchParams.get('pair') ?? '') })
    t.get(/^\/settings\/theme$/, ({ req, res }) => page(req, res, 'Theme · Settings', settingsPage('Theme', html`<div class="set-group set-choice" role="radiogroup" aria-label="Theme" data-controller="set-theme">${['light', 'dark', 'system'].map(v => html`<label class="set-row"><input type="radio" name="theme" value="${v}" data-action="change->set-theme#pick"${themeMode() === v ? raw(' checked') : ''}><span class="set-ico">${sk(v === 'light' ? 'sun' : v === 'dark' ? 'moon' : 'grid')}</span><b>${SHOWN[v]}</b>${sk('tick')}</label>`)}</div>
<p class="set-note">System follows this device's own setting. The key T switches anywhere.</p>`, { lead: 'On this device.' }), { view: 'settings-theme' }))
    t.get(/^\/settings\/keys$/, ({ req, res }) => page(req, res, 'Keyboard Shortcuts · Settings', settingsPage('Keyboard Shortcuts', html`<div class="set-group set-keys-group">${keysList()}</div><p class="set-note">More keys later. Keys rest while you type in a field. <a href="/help.html#keys">On the help page</a></p>`), { view: 'settings-keys' }))

    // ---- /settings/account ----
    // The account is read from the hub once per visit (client._setRoom: a change, so the page refreshes when it is in).
    const loadAccount = () => {
      if (!client.hub || m().room.account_loading) return
      client._setRoom({ account_loading: true })
      account().then(A => A.accountStatus(client)).then(st => client._setRoom({ account: st, account_loading: false }), err => client._setRoom({ account_error: accountError(err), account_loading: false }))
    }
    const settingsMain = (error = '', said = '', kit = null, first = false) => {
      const room = m().room
      const st = room.account
      const link = client.hub && has(k, 'roomLink') && room.hub_url ? k.roomLink(room.hub_url, room.room_id) : null
      const form = (action, inner, word, id) => html`<form method="post" action="${action}" class="room-form" data-controller="room" id="${id}">${inner}<button type="submit" class="room-primary">${word}</button></form>`
      // The way in a change asks for again: the password where the account has one, else one of its passkeys.
      const unlockField = a => (a.has_password === false ? html`<p class="room-meta">You confirm with your passkey.</p>` : pwField({ label: 'Your password', gen: false, autocomplete: 'current-password' }))
      const day = ts => new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
      const accountPart = !client.hub ? html`<p class="room-meta">No account in the demo.</p>`
        : st === undefined ? html`<p class="room-wait">${room.account_error ? `Not reachable: ${room.account_error}` : 'Loading…'}</p>`
          : st === null ? html`<p class="room-lead">This account was made before email and password. Add a login, so a new device gets in with email and password. You need the recovery code shown when you started.</p>
${form('/settings/account', html`<label>Email<input type="email" name="email" required autocomplete="username" autocapitalize="off" spellcheck="false"></label>${pwField()}<label>Recovery code<input name="recovery_code" required autocomplete="off" spellcheck="false" class="room-mono" placeholder="XXXX-XXXX-…"></label>`, 'Add login', 'account-add')}`
            : html`<p class="room-lead">${st.email ? html`Logged in as <b id="account-email">${st.email}</b>` : html`Logged in with a passkey. <span id="account-email">No email.</span>`}</p>
<p class="room-meta">Account ID <span class="room-mono" id="account-id">${st.account}</span></p>
${st.email ? '' : html`<details class="room-more" id="email-add"><summary>Add an email</summary><p class="room-meta">A second name for your account. It cannot be changed later. Your Emergency Kit keeps its twelve words and opens with the email from then on: type them once more.</p>${form('/settings/email', html`<label>Email<input type="email" name="email" required autocomplete="username" autocapitalize="off" spellcheck="false"></label><label>Twelve words<textarea name="words" rows="3" required autocomplete="off" autocapitalize="off" spellcheck="false"></textarea></label>`, 'Add email', 'email-form')}</details>`}
<h4 class="room-sub">Emergency Kit</h4>
${kit ? html`<p class="room-lead">Download or print it, and keep it somewhere safe. It is shown only now.${first ? '' : ' The old kit no longer works.'}</p>${kitBox({ ...kit, account: kit.account ?? st.account }, kitLink(kit.account ?? st.account), true)}`
  : html`<p class="room-lead">${st.has_recovery ? 'Made.' : 'Not made yet.'} ${st.has_password === false ? 'It opens your account if you lose your passkey.' : 'With it you can set a new password if you forget yours.'}</p>
<details class="room-more" id="kit-new"><summary>${st.has_recovery ? 'Make a new kit' : 'Make my Emergency Kit'}</summary>${form('/settings/kit', unlockField(st), 'Make the kit', 'kit-form')}</details>`}
${passkeysOff && !(st.passkeys ?? []).length ? '' : html`<h4 class="room-sub">Passkeys</h4>
${(st.passkeys ?? []).length ? html`<ul class="room-devices room-passkeys" id="passkeys">${st.passkeys.map(p => html`<li class="room-device room-passkey" id="passkey-${p.credential_id.slice(0, 12)}">
<span class="room-device-name"><b>Passkey</b><small>added ${day(p.created_at)} · ${p.last_used_at ? `used ${day(p.last_used_at)}` : 'not used yet'}</small></span>
<form method="post" action="/settings/passkeys/remove" class="room-remove"><input type="hidden" name="id" value="${p.credential_id}"><details><summary>Remove</summary><p>Passkey no longer opens your account after this.</p><button type="submit" class="room-danger">Remove passkey</button></details></form></li>`)}</ul>`
  : html`<p class="room-lead" id="passkeys-none">None yet. A passkey logs you in without a password.</p>`}
${st.has_password !== false && (st.passkeys ?? []).length ? html`<p class="room-meta" id="password-still">Your password still opens this account.</p>` : ''}
${canPasskey ? html`<details class="room-more" id="passkey-new"><summary>Add passkey</summary>${form('/settings/passkeys', unlockField(st), 'Add passkey', 'passkey-form')}</details>` : passkeysOff ? '' : html`<p class="room-meta" id="passkey-cannot">This browser makes no passkeys.</p>`}`}
<h4 class="room-sub">Password</h4>
${st.has_password === false
  ? html`<p class="room-lead" id="password-none">None. Your passkey opens this account.</p>
${st.email ? html`<details class="room-more" id="pw-add"><summary>Add a password</summary>${form('/settings/password/add', html`${pwField({ label: 'New password' })}<p class="room-meta">You confirm with your passkey.</p>`, 'Add password', 'pw-add-form')}</details>` : html`<p class="room-meta" id="pw-needs-email">A password needs an email. Add one first.</p>`}`
  : html`<details class="room-more" id="pw-change"><summary>Change password</summary>${form('/settings/password', html`${pwField({ name: 'current', label: 'Current password', gen: false, autocomplete: 'current-password' })}${pwField({ label: 'New password' })}`, 'Change password', 'pw-form')}</details>`}
<p class="room-meta">${st.has_password === false ? NO_RECOVERY_PASSKEY : NO_RECOVERY}</p>`
      return roomPage('Account', html`${errorLine(error)}${said ? html`<p class="room-lead room-ok" role="status">${said}</p>` : ''}
${isHuman() ? html`<section class="room-section" id="account" aria-labelledby="acct-head"><h3 id="acct-head">Your login</h3>${accountPart}<p class="room-logout-line"><a href="/logout" data-nav id="settings-logout">Log Out</a></p></section>` : ''}
<section class="room-section" aria-labelledby="store-head"><h3 id="store-head">Storage</h3><dl class="room-usage" data-controller="room" data-room-usage-value="${has(client, 'usage') ? 'hub' : 'local'}"><div><dt>On this device</dt><dd data-room-target="local">…</dd></div>${has(client, 'usage') ? html`<div><dt>On the hub (encrypted)</dt><dd data-room-target="hub">…</dd></div>` : ''}</dl><p class="room-meta">The hub deletes envelopes after 30 days; your devices keep what they decrypted.</p></section>
${link ? html`<details class="room-section room-more" id="advanced"><summary>Advanced</summary><p class="room-lead">The address of this account, for the old recovery code (app.trommi.com/recover). On its own it opens nothing.</p>${copyBox(link, 'Address')}
<p class="room-meta">${room.room_id.slice(0, 16)}… · key epoch ${room.key_epoch} · hub ${room.hub_url}</p></details>` : ''}`, 'Your login, and what this device keeps.')
    }
    // The address the kit's QR code holds (hub and account ID, no words): made once the page's helpers are loaded.
    let kitLink = () => null
    account().then(A => { kitLink = id => { try { return A.kitAddress(location.origin, m().room.hub_url, id) } catch { return null } } }).catch(() => {})
    const DONE = { added: 'Login added. A new device now logs in with email and password.', changed: 'Password changed.', 'passkey-added': 'Passkey added.', 'passkey-removed': 'Passkey removed.', 'password-added': 'Password added.' }
    // (whether this browser can make a passkey: asked once, the page refreshes when it is known)
    let canPasskey = false, passkeysOff = !passkeysOn()
    passkeyOffer().then(o => { canPasskey = o.get; passkeysOff = Boolean(o.off); if (canPasskey && m().room.account) client._setRoom?.({ account: { ...m().room.account } }) })
    /** The way in for a change on this page: the form's password, or a passkey of the account (a prompt). */
    const unlockOf = async (f, st) => (st?.has_password === false ? { passkey: await passkeyUnlock(st) } : { password: String(f.get('password') ?? '') })
    // A kit just made is held here (memory only) for ten minutes, so that the page drawn again (a stream's refresh, a
    // visit back) still shows it; while it is held the page is not refreshed by the account's own change.
    let held = null
    const holding = () => (held && Date.now() - held.at < 600_000 ? held : (held = null))
    const accountSnap = () => JSON.stringify([m().room.account ?? null, m().room.account_error ?? null, canPasskey])
    t.live('settings', { take: () => holding()?.snap ?? accountSnap(), diff: (was, now) => (was !== now ? String(t.stream('refresh')) : '') })
    t.get(/^\/settings\/account$/, ({ req, res, url }) => {
      if (m().room.account === undefined) loadAccount()
      const h = holding()
      page(req, res, 'Account · Settings', h ? settingsMain('', h.said, h.kit, h.first) : settingsMain('', DONE[url.searchParams.get('done')] ?? ''), { view: 'settings' })
    })
    const accountPost = (path, fn, done) => t.post(path, async ({ req, res, form }) => {
      let out
      try { out = await fn(form, await account()) } catch (err) {
        console.error(err)
        return page(req, res, 'Settings', settingsMain(accountError(err)), { view: 'settings' }, 422)
      }
      if (out?.kit) {
        held = { at: Date.now(), snap: held?.snap ?? out.snap ?? accountSnap(), kit: out.kit, said: out.said ?? 'Your new Emergency Kit:', first: out.first }
        if (out.account) client._setRoom(out.account)
        return page(req, res, 'Settings', settingsMain('', held.said, held.kit, held.first), { view: 'settings' })
      }
      held = null
      client._setRoom({ account: undefined }); loadAccount()
      t.redirect(res, `/settings/account?done=${done}`)
    })
    // (the login comes with its Emergency Kit, in the same request: shown here once, like a new kit)
    accountPost(/^\/settings\/account$/, async (f, A) => {
      const { kit } = await A.addAccount(client, { email: String(f.get('email')), password: String(f.get('password')), recovery_code: String(f.get('recovery_code')).trim() })
      return { kit, said: 'Login added. Your Emergency Kit:', first: true, account: { account: await A.accountStatus(client), account_error: undefined } }
    }, 'added')
    accountPost(/^\/settings\/password$/, (f, A) => A.changePassword(client, { current: String(f.get('current')), next: String(f.get('password')) }), 'changed')
    // A new passkey: the way in is checked first (a wrong password leaves no stray passkey), then the passkey is made
    // here, then the core seals the code under it.
    accountPost(/^\/settings\/passkeys$/, async (f, A) => {
      const st = await A.accountStatus(client), unlock = await unlockOf(f, st)
      await A.checkUnlock(client, unlock)
      const passkey = await passkeyMake({ challenge: await A.passkeyChallengeFor(client), user_handle: unb64u(st.user_handle), name: st.email ?? st.account, exclude: (st.passkeys ?? []).map(p => unb64u(p.credential_id)) })
      try { await A.addPasskey(client, { unlock, passkey }) } catch (err) { if (cameToNothing(err)) passkeyForget(passkey.credential_id); throw err }
    }, 'passkey-added')
    accountPost(/^\/settings\/passkeys\/remove$/, async (f, A) => {
      const id = String(f.get('id'))
      await A.removePasskey(client, id)
      passkeyForget(unb64u(id))
    }, 'passkey-removed')
    accountPost(/^\/settings\/password\/add$/, async (f, A) => A.setPassword(client, { unlock: { passkey: await passkeyUnlock(await A.accountStatus(client)) }, next: String(f.get('password')) }), 'password-added')
    accountPost(/^\/settings\/kit$/, async (f, A) => {
      const kit = await A.makeEmergencyKit(client, await unlockOf(f, await A.accountStatus(client)))
      return { kit, account: { account: { ...m().room.account, has_recovery: true, kit_form: kit.form } } }
    })
    // An account without email gets one, once (a second name for it, and what a password needs). Its kit is sealed
    // anew under the email in the same request, with the same words: its sheet is shown again, to print once more.
    accountPost(/^\/settings\/email$/, async (f, A) => {
      try {
        const kit = await A.setEmail(client, { email: String(f.get('email')), words: String(f.get('words')) })
        return { kit, said: 'Email added. Your Emergency Kit opens with your email now:', first: true, account: { account: await A.accountStatus(client), account_error: undefined } }
      } catch (err) { throw err.code === 'account-exists' ? Object.assign(err, { message: EMAIL_HELD, code: 'email-held' }) : err.code === 'forbidden' || err.code === 'email-set' ? Object.assign(err, { message: 'This account has an email already.', code: 'email-set' }) : err.code === 'wrong-recovery' ? Object.assign(err, { message: 'Those are not the words of your Emergency Kit.', code: 'kit-words' }) : err }
    })

    // ---- /logout (the Trommi menu and Settings -> Account): asks once, then logOut() ----
    const logoutMain = (error = '') => {
      const me = m().room.my_device_id
      const others = [...(m().members?.values() ?? [])].filter(d => d.is_active && d.device_role === 'human' && d.device_id !== me).length
      const st = m().room.account
      // (the ways in this account has: said as they are)
      const pk = Boolean(st?.passkeys?.length), pw = st?.has_password !== false
      const again = pk && pw ? 'your passkey or your password' : pk ? 'your passkey' : 'email and password'
      const ways = pk && pw ? 'your passkey, or your email and password' : pk ? 'your passkey' : 'your email and password'
      const note = !client.hub ? 'The demo keeps nothing; this only ends it.'
        : others ? ''
          : st === null ? 'This is your only device, and this account has no email login yet: after this, only your recovery code opens it (app.trommi.com/recover).'
            : `This is your only device. After this, ${ways} (or your Emergency Kit) ${st?.has_password === false ? 'opens' : 'open'} your account.`
      return roomShell('Log out', html`${errorLine(error)}<p class="room-lead" id="logout-ask">Log out of this device? You can log in again with ${again}.</p>
${note ? html`<p class="room-lead" id="logout-last">${note}</p>` : ''}<p class="room-meta">Everything Trommi keeps on this device is deleted here; your account and your other devices stay as they are.</p>
<form method="post" action="/logout" class="room-inline room-logout" id="logout-form"><button type="submit" class="room-danger" id="logout-go">Log Out</button><a href="/" data-nav class="room-back" id="logout-cancel">Cancel</a></form>`)
    }
    t.get(/^\/logout$/, ({ req, res }) => { if (client.hub && isHuman() && m().room.account === undefined) loadAccount(); page(req, res, 'Log out', logoutMain(), { view: 'logout' }) })
    t.post(/^\/logout$/, async () => { await logOut(client) })

    // A join link opened on a device that is in a room already.
    t.get(/^\/(?:join|login)$/, ({ req, res }) => { if (location.hash.length > 1) history.replaceState(null, '', location.pathname); return page(req, res, 'Pair a device', roomShell('Already logged in', html`<p class="room-lead">This device is logged in already. Invite another device under <a href="/settings" data-nav>Settings</a>.</p><p class="room-meta">Another account? <a href="/logout" data-nav id="login-logout-first">Log out of this device first</a>, then log in.</p><p class="room-meta"><a href="/" data-nav>Open your Desk</a></p>`)) })
  }
}

// ---- Log out: what is still to send goes out, the streams close, every local trace of the app on this origin goes
// (IndexedDB, Cache Storage, localStorage, sessionStorage; the service worker stays and fills its cache again from
// the network), and the start page comes. No device takes itself out of the room: the start page says the device
// stays in "Devices" until another device removes it.
async function logOut(client) {
  // (the demo has no account: leaving it is all there is to do; nothing stored on this device is touched)
  if (client?.model?.room?.hub_url === 'mock:') { try { sessionStorage.removeItem('trommi-mock') } catch {} return location.replace('/') }
  let removed = !client?.hub   // the demo has nothing to remove
  if (typeof client?.leaveRoom === 'function') {
    // (`removed: false`: no device takes itself out of the room; it stays under Devices until another one removes it)
    try { removed = (await Promise.race([client.leaveRoom(), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 20_000))]))?.removed !== false }
    catch (err) { console.warn('log out: not removed', err?.code ?? '', err?.message ?? err) }
  }
  try { await client?.stop?.() } catch {}
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
/** Said by "Create account" for an email that has one (in Settings the same refusal is about this account's login). */
const EMAIL_TAKEN = 'This email has an account already. Log in instead.'
const EMAIL_HELD = 'This email has an account already.'
/** Said where an account ID meets a password: a password's keys are derived from the email. */
const ID_NO_PASSWORD = 'Enter your email to log in with a password.'
const NOT_A_NAME = 'That is not an email address or an account ID.'
const NO_RECOVERY = 'If you lose your password and your Emergency Kit, nobody (not even Trommi) can recover your data.'
const NO_RECOVERY_PASSKEY = 'If you lose your passkeys and your Emergency Kit, nobody (not even Trommi) can recover your data.'
/** What an Emergency Kit opens with, in words: the email it was made under, or the account's ID. */
const kitOpensWith = kit => (kit.form === 'id' || !kit.email ? 'account ID' : 'email')
/** The one plain sentence on the kit's step: the way in and the kit lost together are the account lost. */
const LOST = way => `If you lose your ${way} and this kit, your account is lost. Nobody can recover it, not even Trommi.`
/** The Emergency Kit as a text file. `link`: the address its QR code holds (hub and account ID; never the words). */
const kitText = (kit, link) => `Trommi Emergency Kit

${kit.account ? `Account ID: ${kit.account}\n` : ''}${kit.email ? `Email: ${kit.email}\n` : ''}Recovery words: ${kit.words}

Lost your way in? Open https://app.trommi.com, choose "Log in", then "Forgot?".
Enter your ${kitOpensWith(kit)} and these 12 words, then choose a new ${kit.email ? 'password or passkey' : 'passkey'}.
${link ? `Or open ${link} (it fills in the account ID; it holds no words).\n` : ''}
Keep this kit private and offline: with these words and your ${kitOpensWith(kit)}, anyone can get into your account.
${LOST(kit.has_password === false || !kit.email ? 'passkey' : 'password')}

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
/** The account's ID with the code that opens the recovery screen with it filled in: on every kit, next to the words. */
const kitIdentity = (kit, link) => (kit.account ? html`<div class="set-pair kit-id">${link ? html`<div class="set-qr is-real">${raw(qrSvg(link, 'QR code: opens the recovery screen with this account ID'))}</div>` : ''}<div class="set-text"><b>Account ID</b><small class="room-mono" id="kit-account">${kit.account}</small>${link ? html`<small>The code opens the recovery screen with this ID filled in. It holds no words.</small>` : ''}</div></div>` : '')
const kitBox = (kit, link, stim = false) => html`<div class="room-kit" id="kit"><p class="room-kit-title">${raw(BELL)} Trommi Emergency Kit</p>${kit.email ? html`<p class="room-meta">Email: <b>${kit.email}</b></p>` : ''}
<ol class="room-kit-words" id="kit-words">${kit.words.split(' ').map(w => html`<li>${w}</li>`)}</ol>
${kitIdentity(kit, link)}
<p class="room-meta">Lost your way in? app.trommi.com → Log in → "Forgot?" → your ${kitOpensWith(kit)} and these 12 words.</p></div>
<div class="room-actions room-kit-actions"${stim ? raw(' data-controller="room"') : ''}><button type="button" id="kit-download"${stim ? raw(' data-action="room#download"') : ''} data-room-text-param="${kitText(kit, link)}">Download</button><button type="button" id="kit-print"${stim ? raw(' data-action="room#print"') : ''}>Print</button></div>`
const accountError = err => ({
  'wrong-login': 'Wrong email or password.', 'wrong-recovery': 'Wrong email or words.', 'bad-recovery-words': 'Check the twelve words.',
  'bad-account': NOT_A_NAME, 'needs-email': 'This account has no email, so it has no password. Use a passkey.',
  'rate-limited': 'Too many tries. Wait a few minutes.', 'too-many': 'Too many. Try again later.', 'weak-password': 'At least 12 characters.', 'bad-email': 'That is not an email address.',
  'room-exists': 'This browser is logged in already.', 'bad-recovery-code': 'This code does not fit this account.',
  'account-exists': 'This account has a login already.', 'account-changed': 'Changed on another device. Try again.',
  'no-prf': 'This passkey can\'t unlock Trommi here.', 'passkey-cancelled': 'No passkey used.', 'passkey-aborted': 'No passkey used.', 'passkey-exists': 'This passkey is added already.',
  'passkey-failed': 'The passkey did not work. Try again.', 'bad-passkey': 'That passkey was not accepted. Try again.', 'last-way-in': 'This is your only way in. Add a password or another passkey first.',
  'no-password': 'This account has no password.',
}[err.code] ?? sayError(err))

// ---- the screens before the board, and the Emergency Kit's page: one calm column (auth.css "ob") ----
/** This device's name, made for it: "Chrome on Linux", "Safari on iPhone". Never asked for; renamed under Settings → Devices. */
function deviceLabel(nav = navigator) {
  const ua = String(nav.userAgent ?? ''), brands = (nav.userAgentData?.brands ?? []).map(b => b.brand).join(' ')
  const browser = /Brave/.test(brands) ? 'Brave' : /Edg(e|A|iOS)?\b|Microsoft Edge/.test(`${brands} ${ua}`) ? 'Edge' : /Opera|OPR\//.test(`${brands} ${ua}`) ? 'Opera' : /Vivaldi/.test(`${brands} ${ua}`) ? 'Vivaldi'
    : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Chrom(e|ium)|CriOS/.test(`${brands} ${ua}`) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'Browser'
  const os = /iPhone|iPod/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Macintosh|Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux|X11/.test(ua) ? 'Linux' : ''
  return os ? `${browser} on ${os}` : browser
}
const UNDER = raw('<svg viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true"><path d="M1.0 5.0 Q18.0 3.4 26.0 4.3 Q34.0 5.2 43.0 4.4 Q52.0 3.6 61.0 4.3 Q70.0 5.0 78.0 4.4 Q86.0 3.8 92.5 4.2 L99.0 4.6"/></svg>')
const DEMO_LINK = html`<a href="/?mock=1" id="ob-demo" data-turbo="false">Try the demo</a>`
/** One screen: the bell (the way back to the start), a short headline, at most one line under it, the demo at the foot. */
const obShell = (title, inner, { lead = '', cls = '', home = true, foot = '' } = {}) => html`<main id="room" class="ob${cls ? ` ${cls}` : ''}" aria-labelledby="ob-title">
<header class="ob-brand">${home ? html`<a href="/" id="room-home" aria-label="Trommi: back to the start">${BELL}<b>Trommi</b></a>` : html`<span>${BELL}<b>Trommi</b></span>`}</header>
<h1 id="ob-title" class="ob-title">${title}</h1>${lead ? html`<p class="ob-lead">${lead}</p>` : ''}
${inner}
<footer class="ob-foot">${foot}${DEMO_LINK}</footer></main>`
/** The one line a form says when it failed: its place is kept, so nothing jumps. */
const obError = (error = '') => html`<p class="ob-error" role="alert" id="ob-error">${error}</p>`
/** The email field of "Create account". `optional`: beside a passkey nothing rests on it, and the field says so. */
const obEmail = (value = '', optional = false) => html`<div class="ob-field"><span class="ob-label"><label for="ob-email">Email</label>${optional ? html`<span class="ob-hint" id="ob-email-optional">optional</span>` : ''}</span><input type="email" id="ob-email" name="email" value="${value}" autocomplete="username" autocapitalize="off" spellcheck="false" inputmode="email"${optional ? raw(' aria-describedby="ob-email-optional"') : ''}></div>`
/** The one field that names an account where it is logged in to or recovered: its email, or the account ID printed on its Emergency Kit. */
const obAccount = (value = '', passkeys = false) => html`<label class="ob-field"><span class="ob-label">Email or account ID</span><input type="text" name="account" value="${value}" autocomplete="${passkeys ? 'username webauthn' : 'username'}" autocapitalize="off" spellcheck="false" inputmode="email"></label>`
const PW_RULE = 'At least 12 characters'
/** A password: Show/Hide in the field; a new one with the live rule and "Generate": five words, put into the field and
 *  shown in full on a slip under it, with Copy (the slip goes when the field is typed in). */
const obPassword = ({ label = 'Password', fresh = false, side = '' } = {}) => html`<div class="ob-field ob-pw${fresh ? ' is-new' : ''}"><span class="ob-label"><label for="ob-pw">${label}</label>${side}</span>
<span class="ob-pwrow"><input type="password" id="ob-pw" name="password" autocomplete="${fresh ? 'new-password' : 'current-password'}" spellcheck="false" autocapitalize="off"${fresh ? raw(' aria-describedby="ob-pw-hint"') : ''}><button type="button" class="ob-eye" aria-pressed="false" aria-controls="ob-pw">Show</button></span>
${fresh ? html`<span class="ob-made" hidden><code></code><button type="button" class="ob-chip ob-copy">Copy</button></span>
<span class="ob-under"><span class="ob-hint" id="ob-pw-hint" aria-live="polite">${PW_RULE}</span><button type="button" class="ob-link ob-gen" title="Five random words">Generate</button></span>` : ''}</div>`
const obSubmit = word => html`<button type="submit" class="ob-go" data-word="${word}">${word}</button>`
const KIT_EMPTY = 'orbit lantern maple quiet saddle copper violin harbor ember thistle canyon pepper'
/** The kit as a sheet of paper. Hidden, it holds no word at all: twelve drawn strokes; the words are put in when shown. */
const kitSheet = (kit, words, link) => html`<div class="kit-sheet${words ? ' is-shown' : ''}" id="kit"><p class="kit-head">${BELL}<b>Trommi Emergency Kit</b></p><p class="kit-mail">${kit.email ?? ''}</p>
<ol class="kit-words" id="kit-words"${words ? '' : raw(' aria-hidden="true"')}>${(words || KIT_EMPTY).split(' ').map((w, i) => (words ? html`<li>${w}</li>` : html`<li><i style="--w:${3 + KIT_EMPTY.split(' ')[i].length}"></i></li>`))}</ol>
${kitIdentity(kit, link)}
<p class="kit-how">Lost your way in? app.trommi.com → Log in → Forgot? → your ${kitOpensWith(kit)} and these 12 words.</p></div>`

/**
 * The Emergency Kit's page, in `root`. With words: the sheet (hidden until "Show"), Download, Print, and "Open Trommi"
 * once it was downloaded, printed or shown. Without (the tab was closed before that): the password makes a new kit.
 * The words live in this closure only: never in an attribute, in storage or in a log. `kit`: whose it is (email or
 * none, the account's ID, which of the two it opens with); `linkOf(id)`: the address its QR code holds.
 */
function kitPage(root, { kit = { email: null, account: null, form: 'email' }, words = null, linkOf = () => null, error = '', demo = false, shown = false, make = null, open = null, logout = null, ways = { password: true, passkey: false } }) {
  let saved = false
  const paint = () => {
    root.innerHTML = String(obShell('Your Emergency Kit', words ? html`
<div class="kit-stage"><div class="kit-cover" id="kit-cover">${kitSheet(kit, shown ? words : null, kit.account ? linkOf(kit.account) : null)}</div>
<button type="button" class="ob-chip kit-show" id="kit-show" aria-pressed="${shown ? 'true' : 'false'}">${shown ? 'Hide' : 'Show'}</button></div>
<div class="ob-row"><button type="button" class="ob-second" id="kit-download">Download</button><button type="button" class="ob-second" id="kit-print">Print</button></div>
<p class="ob-warn" id="kit-warn">${LOST(ways.password ? 'password' : 'passkey')}</p>
${obError(error)}<button type="button" class="ob-go" id="kit-done"${saved ? '' : raw(' disabled')}>Open Trommi</button>
<p class="ob-hint ob-center" id="kit-first"${saved ? raw(' hidden') : ''}>Download, print or show it first.</p>`
      : html`<form id="kit-form" class="ob-form" novalidate>${ways.password ? html`<input type="text" name="email" value="${kit.email ?? ''}" autocomplete="username" hidden>${obPassword()}` : ''}
${obError(error)}${obSubmit(ways.password ? 'Make kit' : 'Use passkey')}</form>${ways.password && ways.passkey ? html`<p class="ob-or"><span>or</span></p><button type="button" class="ob-second ob-wide" id="kit-passkey">${art('key')}Use passkey</button>` : ''}`,
    { lead: words ? (ways.password ? 'Twelve words that set a new password if you forget yours.' : 'Twelve words that open your account if you lose your passkey.') : ways.password ? 'Enter your password to make it.' : 'Unlock with your passkey to make it.', cls: 'ob-kit', home: false, foot: logout ? html`<button type="button" class="ob-link" id="kit-logout">Log out</button>` : '' }))
  }
  const q = sel => root.querySelector(sel)
  const keep = () => { saved = true; q('#kit-done')?.removeAttribute('disabled'); q('#kit-first')?.setAttribute('hidden', '') }
  const flip = () => { shown = !shown; if (shown) saved = true; const focus = document.activeElement?.id; paint(); wire(); if (focus) q(`#${focus}`)?.focus({ preventScroll: true }) }
  const wire = () => {
    q('#kit-logout')?.addEventListener('click', e => { e.target.disabled = true; logout() })
    // The kit is made from a way in given again: the password, or a passkey of the account (a prompt).
    const making = async way => {
      if (!make) return
      const b = q('.ob-go'); b.disabled = true; b.textContent = way.passkey ? 'Waiting for passkey…' : 'Making…'; q('#ob-error').textContent = ''
      try { const made = await make(way); words = made.words; kit = { ...kit, ...made, account: made.account ?? kit.account, words: undefined }; error = ''; paint(); wire(); q('#kit-show')?.focus({ preventScroll: true }) }
      catch (err) { console.warn('kit:', err?.code ?? '', err?.message ?? err); b.disabled = false; b.textContent = b.dataset.word; q('#ob-error').textContent = err?.code === 'wrong-login' ? (way.passkey ? 'This passkey does not open your account.' : 'Wrong password.') : accountError(err); q('#ob-pw')?.focus() }
    }
    q('#kit-passkey')?.addEventListener('click', () => making({ passkey: true }))
    q('#kit-form')?.addEventListener('submit', e => {
      e.preventDefault()
      if (!ways.password) return making({ passkey: true })
      const pw = q('#ob-pw').value
      if (!pw) { q('#ob-error').textContent = 'Enter your password.'; return q('#ob-pw').focus() }
      making({ password: pw })
    })
    q('#kit-cover')?.addEventListener('click', flip)
    q('#kit-show')?.addEventListener('click', flip)
    q('#kit-download')?.addEventListener('click', () => { if (!demo) downloadKit(kitText({ ...kit, words, has_password: ways.password }, kit.account ? linkOf(kit.account) : null)); keep() })
    q('#kit-print')?.addEventListener('click', () => {
      // the printed sheet carries the words: shown for the print, hidden again after it if they were hidden
      const was = shown
      if (!was) flip()
      keep()
      if (demo) return
      if (!was) addEventListener('afterprint', () => { if (shown) flip() }, { once: true })
      window.print()
    })
    q('#kit-done')?.addEventListener('click', async e => {
      if (!open) return
      e.target.disabled = true
      try { await open(); words = null } catch (err) { console.warn('kit:', err?.message ?? err); e.target.disabled = false; q('#ob-error').textContent = 'Not saved yet. Try again.' }
    })
  }
  if (shown) saved = true
  paint(); wire()
  q(words ? '#kit-show' : ways.password ? '#ob-pw' : '.ob-go')?.focus({ preventScroll: true })
}

// ---- the kit's gate: an account whose kit was never downloaded, printed or shown opens on the kit's page ----
// "Not yet saved" is a human register of the account, `kit: { pending: true }` (sealed like every register: the hub
// learns nothing), written when the account is made and cleared by "Open Trommi"; every device of the person sees it.
// Until the register is out, a mark in this browser stands in for it (set before the account is asked for).
const KIT_MARK = 'trommi-kit-pending'
let gate = null, freshKit = null
/** Is the kit of this account still to be saved? (app.mjs asks at the start and on every change of the register) */
const kitDue = client => client?.model?.room?.my_role === 'human' && Boolean(client.hub) && (read(KIT_MARK) === '1' || (client.model.room.connection !== 'offline' && client.model.human?.raw?.get('kit')?.value?.pending === true))
/** This device processed the Commit that removed it (engine.ts `lost`: never on the hub's word alone). Its keys
 *  and everything Trommi kept on this origin are wiped, and one screen says so: the account and the person's other
 *  devices stay; logging in again makes this a new device. Once per page. */
let removedShown = false
export async function removedScreen(client) {
  if (removedShown) return
  removedShown = true
  try { await client?.stop?.() } catch {}
  await wipeLocal(client)
  const root = Object.assign(document.createElement('div'), { id: 'room-screen' })
  document.body.replaceChildren(root)
  document.title = 'Removed · Trommi'
  root.innerHTML = String(obShell('This device was removed', html`<p class="ob-said" role="status" id="removed-said">Another of your devices removed this one from your account. What Trommi kept on this device is deleted.</p>
<div class="ob-stack"><a class="ob-go" id="removed-login" href="/?way=login" data-turbo="false">Log in again</a></div>`, { lead: 'Your account and your other devices are as they were.', home: false }))
  root.querySelector('#removed-login')?.focus({ preventScroll: true })
}
export function kitGate(client, { fresh = false } = {}) {
  if (gate || !client || !(fresh || kitDue(client))) return
  const root = document.getElementById('room-screen') ?? Object.assign(document.createElement('div'), { id: 'room-screen' })
  // a modal dialog: over the board, which rests under it (no focus, no pointer), and no way around it but Log out
  const box = gate = Object.assign(document.createElement('dialog'), { id: 'kit-gate', className: 'ob-gate' })
  box.append(root); document.body.append(box); box.showModal()
  box.addEventListener('cancel', e => e.preventDefault())
  // (a page change closes every open dialog, ui.mjs, and a page drawn anew may take it out of the body: this one is put
  //  back and opened again while it is the gate, at once and on a watch, whatever the browser allowed at that moment)
  const reopen = () => {
    if (gate !== box) return
    if (!box.isConnected) document.body.append(box)
    if (!box.open) try { box.showModal() } catch { try { box.show() } catch {} }
  }
  box.addEventListener('close', () => { reopen(); requestAnimationFrame(reopen) })
  const guard = setInterval(() => { if (gate !== box) clearInterval(guard); else reopen() }, 400)
  box.addEventListener('keydown', e => e.stopPropagation())
  const registered = () => client.model.human?.raw?.get('kit')?.value?.pending === true
  const kit = freshKit; freshKit = null
  if (!registered()) Promise.resolve(client.setRegisters({ kit: { pending: true } })).then(() => { try { localStorage.removeItem(KIT_MARK) } catch {} }, err => console.warn('kit register:', err?.message ?? err))
  const close = () => { off?.(); gate = null; box.close(); box.remove() }
  // A kit made on this page just now (sign-up, recovery) closes only by "Open Trommi": no other device saw it, and a
  // device catching up meets the account's older values of the register first. A gate opened for a kit that is due
  // (a reload, another device) closes as soon as the register no longer says so: saved on another device, or by
  // this one before the reload (its write still in the outbox when the page read the older value from its cache).
  // Only the register's value saying "due", or this browser's mark, keeps it open.
  const watch = () => {
    if (kit?.words) return
    const r = client.model.human?.raw?.get('kit')
    // (due is what the register says now, this device's own unsent write included: a write that clears it is not due)
    if (r?.value?.pending === true || read(KIT_MARK) === '1') return
    close()
  }
  const off = (() => { const un = client.on?.('change', watch); return typeof un === 'function' ? un : () => client.off?.('change', watch) })()
  // (the register's newer value may have come before this gate listened: looked at once now, and again shortly)
  setTimeout(watch, 0); setTimeout(watch, 1500)
  // st: the account as the hub has it (which ways in it has); null when it could not be read: the password's form then
  const paint = (st, A = null) => { if (gate !== box) return; kitPage(root, {
    kit: { email: (kit ?? st)?.email ?? client.model.room.account?.email ?? null, account: kit?.account ?? st?.account ?? client.model.room.account?.account ?? null, form: kit?.form ?? st?.kit_form ?? 'email' }, words: kit?.words ?? null,
    linkOf: id => { try { return A?.kitAddress(location.origin, client.model.room.hub_url, id) ?? null } catch { return null } },
    ways: { password: (st ?? kit)?.has_password !== false, passkey: Boolean(st?.passkeys?.length) },
    make: async way => { const A = await account(); return A.makeEmergencyKit(client, way.passkey ? { passkey: await passkeyUnlock(st ?? await A.accountStatus(client)) } : { password: way.password }) },
    // (a core that seals no register yet, `core-missing`: nothing was written when the account was made either,
    //  and the gate rests on this browser's mark alone)
    open: async () => { await client.setRegisters({ kit: null }).catch(err => { if (err?.code !== 'core-missing') throw err }); try { localStorage.removeItem(KIT_MARK) } catch {} close() },
    logout: () => logOut(client),
  }) }
  // With the words and the account's ID in hand the page is there as soon as its helpers are; else it first asks
  // the hub for the account (which ways in it has, its ID), and does not wait long for it.
  const asked = account().then(A => (kit?.words && kit.account ? [null, A] : Promise.race([A.accountStatus(client).catch(() => null), new Promise(ok => setTimeout(ok, 4000, null))]).then(st => [st, A])))
  asked.then(([st, A]) => paint(st, A), () => paint(null))
}

// ---- before a room: a screen of its own, before the board exists ----
export async function roomScreen({ start, hub, openError = null, demo = '' }) {
  // A link in the address leaves the address bar before anything else happens, whatever screen comes next: a join
  // link's secret (/join#v1.…), and an Emergency Kit's address (#k1.…: a hub and an account ID, nothing secret).
  const joinLink = location.pathname === '/join' && location.hash.length > 1 ? location.href : ''
  const kitHash = !joinLink && location.hash.startsWith('#k1.') ? location.hash : ''
  if (joinLink) history.replaceState(null, '', '/join')
  else if (kitHash) history.replaceState(null, '', location.pathname + location.search)
  document.title = 'Trommi'
  const root = document.createElement('div')
  root.id = 'room-screen'
  document.body.replaceChildren(root)
  let stopScan = null, stopPasskey = null   // (stopPasskey: ends the login screen's standing offer of a passkey in the email field)
  let offerEnded = false                    // the browser refused that offer by itself: it is not made again on this page
  const framed = (() => { try { return window.top !== window } catch { return true } })()
  const show = (markup, focus = 'input:not([type=hidden], [hidden]), button.ob-go') => {
    stopScan?.(); stopScan = null
    stopPasskey?.(); stopPasskey = null
    root.innerHTML = String(markup)
    // (a preview, /screens: password managers stay off its fields, and nothing takes the focus inside a frame)
    if (demo) for (const f of root.querySelectorAll('input, textarea')) { f.autocomplete = 'off'; for (const a of ['data-1p-ignore', 'data-bwignore', 'data-protonpass-ignore']) f.setAttribute(a, ''); f.setAttribute('data-lpignore', 'true'); f.setAttribute('data-form-type', 'other') }
    if (focus && !(demo && framed)) root.querySelector(focus)?.focus({ preventScroll: true })
    wireBack()
  }
  // (the demo, ?mock=1&onboard=<state>, /screens: the same screens, drawn only; nothing is sent, made or wiped here)
  if (demo) {
    root.addEventListener('submit', e => { e.preventDefault(); e.stopImmediatePropagation() }, true)
    root.addEventListener('click', e => { if (e.target.closest('#broken-logout, #broken-retry, #scan-again, #join-cancel, #recovery-copy, #ob-demo, #way-passkey, #newway-passkey, #kit-passkey')) { e.preventDefault(); e.stopImmediatePropagation() } }, true)
  }
  // The password field's buttons: Show/Hide, Generate (five words, shown), Copy; and the live rule under a new password.
  const rule = input => {
    const hint = input.closest('.ob-pw')?.querySelector('.ob-hint')
    if (!hint) return
    const n = [...input.value.normalize('NFC')].length, made = input.dataset.made === input.value && n > 0
    hint.textContent = made ? 'Save it in your password manager.' : !n ? PW_RULE : n < 12 ? `${12 - n} more` : 'Long enough'
    hint.classList.toggle('is-ok', n >= 12); hint.classList.remove('is-bad'); input.removeAttribute('aria-invalid')
    const slip = input.closest('.ob-pw').querySelector('.ob-made')
    if (slip) { slip.hidden = !made; slip.querySelector('code').textContent = made ? input.value : ''; slip.querySelector('.ob-copy').textContent = 'Copy' }
  }
  const eye = (input, on) => { const b = input.closest('.ob-pw').querySelector('.ob-eye'); input.type = on ? 'text' : 'password'; b.setAttribute('aria-pressed', String(on)); b.textContent = on ? 'Hide' : 'Show' }
  root.addEventListener('input', e => { if (e.target.matches('.ob-pw.is-new input')) rule(e.target); const err = root.querySelector('#ob-error'); if (err && e.target.closest('form')) err.textContent = '' })
  root.addEventListener('click', async e => {
    const b = e.target.closest('button'), input = b?.closest('.ob-pw')?.querySelector('input')
    if (!input) return
    if (b.classList.contains('ob-eye')) eye(input, input.type === 'password')
    else if (b.classList.contains('ob-gen')) { input.value = input.dataset.made = (await account()).generatePassword(); eye(input, false); rule(input) }
    else if (b.classList.contains('ob-copy')) b.textContent = (await copyText(input.value)) ? 'Copied' : 'Not copied'
  })
  const done = async (client, { keep = false } = {}) => { if (!keep) root.remove(); history.replaceState(null, '', '/'); await start(client, { fresh: true }) }
  const on = (sel, ev, fn) => root.querySelector(sel)?.addEventListener(ev, fn)
  const wireBack = () => on('#room-home', 'click', e => { e.preventDefault(); history.replaceState(null, '', '/'); welcome() })
  const say = (error, field = null) => { const p = root.querySelector('#ob-error'); if (p) p.textContent = error; if (field) { field.setAttribute('aria-invalid', 'true'); field.focus() } }
  const busy = (form, word) => { const b = form.querySelector('button[type="submit"]'); b.disabled = true; b.classList.add('is-busy'); b.textContent = word; say('') }
  // The passkey button of the login screen while its prompt is up, and after.
  const keyBusy = word => { const b = root.querySelector('#way-passkey'); if (b) { b.disabled = true; b.classList.add('is-busy'); b.querySelector('span').textContent = word } }
  const keyIdle = () => { const b = root.querySelector('#way-passkey'); if (b) { b.disabled = false; b.classList.remove('is-busy'); b.querySelector('span').textContent = 'Log in with passkey' } }
  // A hub challenge asked for when a passkey screen shows, so the prompt follows the tap at once (a browser may want
  // the tap to be recent). One use, two minutes at the hub: taken once, and only while it is young.
  const pkChallenge = async () => (await account()).passkeyChallenge({ hub_url: hub, client: CLIENT })
  let warmed = null
  // (what comes back: { challenge, account, user_handle }; the last two name the id an account made on it will have)
  const warmChallenge = () => { const w = { at: Date.now(), got: null }; warmed = w; pkChallenge().then(c => { w.got = c; w.at = Date.now() }, err => { console.warn('passkey challenge:', err?.message ?? err); if (warmed === w) warmed = null }) }
  const takeChallenge = async () => { const w = warmed; warmed = null; return w?.got && Date.now() - w.at < 90_000 ? w.got : pkChallenge() }
  const idle = form => { const b = form?.querySelector('button[type="submit"]'); if (b) { b.disabled = false; b.classList.remove('is-busy'); b.textContent = b.dataset.word } }
  const weak = form => { const hint = form.querySelector('.ob-hint'), pw = form.elements.password; hint.textContent = PW_RULE; hint.classList.add('is-bad'); pw.setAttribute('aria-invalid', 'true'); if (!(demo && framed)) pw.focus() }
  /** The one field "Email or account ID" of a form, told apart by its form: { A, named: { kind: 'email', email } |
   *  { kind: 'id', account }, text }; null (and the word said) when it is neither. */
  const nameOf = async form => {
    const A = await account(), field = form.elements.account
    let named
    try { named = A.accountName(field.value) } catch { say(field.value.trim() ? NOT_A_NAME : 'Enter your email or account ID.', field); return null }
    lastEmail = field.value.trim()
    return { A, named, text: named.kind === 'email' ? named.email : named.account }
  }
  /** The email of "Create with passkey", which may be left empty: { A, email: string | null }; null (and the word said) for a text that is no address. */
  const optionalEmail = async form => {
    const A = await account(), email = form.elements.email
    if (!email.value.trim()) return { A, email: null }
    try { A.normaliseEmail(email.value) } catch { say('That is not an email address.', email); return null }
    lastEmail = email.value.trim()
    return { A, email: lastEmail }
  }
  /** What the email field of "Create account" starts with: what was typed before, if it is an address. */
  const typedEmail = () => (lastEmail.includes('@') ? lastEmail : '')
  /** A form's email and password, checked with a human word each; null (and the word said) when one is missing. */
  const fields = async (form, { fresh = false } = {}) => {
    const A = await account(), email = form.elements.email, pw = form.elements.password
    try { A.normaliseEmail(email.value) } catch { say(email.value.trim() ? 'That is not an email address.' : 'Enter your email.', email); return null }
    if (fresh && A.passwordProblem(pw.value)) { weak(form); return null }
    if (!pw.value) { say('Enter your password.', pw); return null }
    lastEmail = email.value.trim()
    return { A, email: lastEmail, password: pw.value }
  }
  const c = await core().catch(() => ({}))
  // (the page's own light helpers: the one field's form, the kit's address; no core, no worker)
  const pageHelpers = await account().catch(() => null)
  // (the demo's stills show what a device with passkeys shows)
  const offer = demo ? { create: !demo.endsWith('-nopasskey'), get: !demo.endsWith('-nopasskey'), conditional: false } : await passkeyOffer().catch(() => ({ create: false, get: false, conditional: false }))
  let lastEmail = ''
  const device_name = deviceLabel()

  // (an older account's address, /recover#r1…: defined before the first flow runs, recoverFlow reads them)
  const addressInBar = () => (location.hash.startsWith('#r1.') ? location.href : '')
  const parseAddress = text => { if (!c.parseRoomLink) throw new Error('this version knows no account addresses'); return c.parseRoomLink(String(text).trim()) }
  // After a log out (logOut): said once on the start page, then the address is plain again.
  const loggedOut = demo === 'logged-out' ? '1' : new URLSearchParams(location.search).get('logged_out')
  const wayLogin = new URLSearchParams(location.search).get('way') === 'login'
  if (loggedOut) history.replaceState(null, '', '/')
  // (another join link opened on this page changes only the fragment: taken as the first one was, from the start; so is a kit's address)
  if (!demo) addEventListener('hashchange', () => { if (((location.pathname === '/join' && location.hash.length > 1) || location.hash.startsWith('#k1.')) && document.getElementById('room-screen')) location.reload() })
  // This browser holds an account that did not open: never the start page (Log in would refuse: "signed in already").
  if (demo) return demoFlow(demo)
  if (openError) return brokenFlow(openError)
  if (joinLink) return joinFlow(joinLink)
  // An Emergency Kit's code was scanned: the way back with the kit, its account ID filled in, at the hub it names.
  // (A fragment that is no kit address is dropped without a word: the start page comes.)
  const kitLink = kitHash ? pageHelpers?.parseKitAddress(kitHash) ?? null : null
  if (kitLink) forgotFlow({ way: offer.get ? 'passkey' : 'password', kit: kitLink })
  else if (location.pathname === '/recover') recoverFlow()
  else if (wayLogin) loginFlow()
  else welcome()

  // The stored account does not open (or a login found one stored): say so, Retry, or Log out of this device (wipe
  // this browser's copy; the account and the other devices stay). Never a dead end.
  function brokenFlow(err, { fromLogin = false } = {}) {
    const why = err?.code === 'no-device' || err?.code === 'device-not-stored' ? 'This browser lost this device\'s keys.' : fromLogin ? 'This browser holds an account that does not open.' : 'Your account did not open here.'
    show(obShell('Not opened', html`<p class="ob-error is-shown" role="alert" id="broken-why">${why}</p>
<div class="ob-stack"><button type="button" class="ob-go" id="broken-logout">Log out</button><button type="button" class="ob-second" id="broken-retry">Retry</button></div>
<p class="ob-hint" id="broken-detail">${err?.code ? `${err.code}: ` : ''}${err?.message ?? ''}</p>`, { lead: 'Log out here, then log in again. Your account stays.', home: false }), '#broken-retry')
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
      const client = await openInWorker()
      if (client) return done(client)
    } catch (err) { return brokenFlow(err, { fromLogin: true }) }
    return brokenFlow(new Error('the stored account vanished meanwhile'), { fromLogin: true })
  }

  function welcome(error = '') {
    show(obShell(html`Your agents ring.<br>You <span class="ob-pen">decide.${UNDER}</span>`, html`${loggedOut ? html`<p class="ob-said" id="logged-out" role="status">${loggedOut === 'kept' ? 'Logged out. This device still shows under Devices.' : 'Logged out.'}</p>` : ''}${error ? html`<p class="ob-error is-shown" role="alert">${error}</p>` : ''}
<div class="ob-stack"><button type="button" class="ob-go" id="way-create">Create account</button><button type="button" class="ob-second" id="way-login">Log in</button></div>`, { lead: 'Claude Code and Codex ask as cards on your phone. One tap, and they keep working. End-to-end encrypted.', cls: 'ob-welcome', home: false }), null)
    on('#way-create', 'click', () => createFlow())
    on('#way-login', 'click', () => loginFlow())
  }

  // The board starts under this screen; the kit's page takes it over (kitGate).
  const opened = async client => {
    root.classList.add('is-over')
    await done(client, { keep: true })
    kitGate(window.trommi?.client, { fresh: true })   // (app.mjs opened it already, unless this browser keeps no mark)
    if (!gate) root.remove()
  }
  // Passkey first: where the device has its own passkeys, the one button is "Create with passkey" and the password is
  // the quiet way; where it has none (a passkey on a phone or a key may still do), the password's form comes first and
  // the passkey is the quiet way; a browser without WebAuthn: only the password's form, and one line that says so. A passkey that cannot unlock (no prf): the password's form, the email kept.
  // With a passkey the email is optional (the field says so): one tap makes the account, named by its ID alone.
  function createFlow({ way = offer.create ? 'passkey' : 'password', note = '' } = {}) {
    const passkey = way === 'passkey'
    show(obShell('Create account', html`<form id="create-form" class="ob-form" novalidate>${note ? html`<p class="ob-said" role="status" id="passkey-note">${note}</p>` : ''}${obEmail(typedEmail(), passkey)}${passkey ? '' : obPassword({ fresh: true })}
${obError()}${obSubmit(passkey ? 'Create with passkey' : 'Create account')}</form>
${offer.get ? html`<p class="ob-alt ob-way"><button type="button" class="ob-link" id="way-swap">${passkey ? 'Use a password instead' : 'Use a passkey instead'}</button></p>` : offer.off ? '' : NO_PASSKEYS}
<p class="ob-alt">Have an account? <button type="button" class="ob-link" id="alt-login">Log in</button></p>`, passkey ? { lead: 'No password to remember.' } : {}), note ? '#ob-pw' : passkey ? 'button.ob-go' : undefined)
    if (passkey && !demo) warmChallenge()
    on('#alt-login', 'click', () => loginFlow())
    on('#way-swap', 'click', () => { lastEmail = root.querySelector('#create-form').elements.email.value.trim(); createFlow({ way: passkey ? 'password' : 'passkey' }) })
    on('#create-form', 'submit', async e => {
      e.preventDefault()
      const form = e.target
      if (passkey) return createWithPasskey(form)
      const f = await fields(form, { fresh: true })
      if (!f) return
      busy(form, 'Creating…')
      try {
        // (the mark: should this tab close between the account, made with its kit, and the kit's page, the page still comes: kitGate)
        write(KIT_MARK, '1')
        const { client, kit } = await f.A.createAccount({ hub_url: hub, email: f.email, password: f.password, device_name, found_token: foundCode(), client: CLIENT })
        freshKit = { ...kit, has_password: true }
        await opened(client)
      } catch (err) {
        console.warn(err)
        if (err.code === 'room-exists') return roomExists()
        try { localStorage.removeItem(KIT_MARK) } catch {}
        idle(form); say(err.code === 'account-exists' ? EMAIL_TAKEN : accountError(err))
      }
    })
  }
  // The passkey is made on this page before anything is stored: only a passkey that gave its 32 bytes reaches the hub,
  // with the account, in one request.
  async function createWithPasskey(form) {
    const f = await optionalEmail(form)
    if (!f) return
    busy(form, 'Waiting for passkey…')
    let made = null
    try {
      // the hub names, with the challenge, the id the account will have: the passkey carries it as its user handle
      const named = await takeChallenge()
      made = await passkeyMake({ challenge: named.challenge, user_handle: unb64u(named.user_handle), name: f.email ? f.A.normaliseEmail(f.email) : named.account })
      busy(form, 'Creating…')
      write(KIT_MARK, '1')
      const { client, kit } = await f.A.createAccountWithPasskey({ hub_url: hub, email: f.email, account: named.account, passkey: made, device_name, found_token: foundCode(), client: CLIENT })
      made = null   // (it is the account's way in from here on)
      freshKit = { ...kit, has_password: false }
      await opened(client)
    } catch (err) {
      console.warn(err)
      try { localStorage.removeItem(KIT_MARK) } catch {}
      if (made && cameToNothing(err)) passkeyForget(made.credential_id)   // made, and no account came of it
      if (err.code === 'room-exists') return roomExists()
      if (err.code === 'no-prf') return createFlow({ way: 'password', note: NO_PRF })
      idle(form); say(err.code === 'passkey-cancelled' ? 'No passkey made.' : err.code === 'account-exists' ? EMAIL_TAKEN : accountError(err))
    }
  }

  // A passkey is offered three ways: in the field's own list before anything is typed (conditional UI), by the
  // button (any passkey of this site, also one on a phone or a key; nothing to fill in), and the password stays below
  // with ONE field for the account: its email, or its account ID (told apart by their form; a password logs in
  // under the email its keys are derived from, so an ID there is answered with that one sentence).
  function loginFlow(error = '', at = 'form') {
    // Passkey first: where the browser has passkeys, the one filled button is "Log in with passkey"; email and
    // password stay on the screen under "or", their button the quiet one. Without passkeys: the password's form alone.
    const pk = offer.get
    show(obShell('Log in', html`${pk ? html`<button type="button" class="ob-go ob-key" id="way-passkey">${art('key')}<span>Log in with passkey</span></button>
${error && at === 'passkey' ? html`<p class="ob-error ob-key-error" role="alert" id="passkey-error">${error}</p>` : ''}
<p class="ob-or"><span>or</span></p>` : ''}
<form id="login-form" class="ob-form" novalidate>${obAccount(lastEmail, pk)}${obPassword({ side: html`<button type="button" class="ob-link" id="way-forgot">Forgot?</button>` })}
${obError(at === 'form' ? error : '')}${pk ? html`<button type="submit" class="ob-second ob-wide" data-word="Log in with password">Log in with password</button>` : obSubmit('Log in')}</form>
${pk ? '' : html`<p class="ob-or"><span>or</span></p>`}
<div class="ob-stack ob-ways"><button type="button" class="ob-second ob-wide" id="way-pair">${art('phone')}Scan a code</button></div>
${pk || offer.off ? '' : NO_PASSKEYS}
<p class="ob-alt">New here? <button type="button" class="ob-link" id="alt-create">Create account</button></p>`), pk && !(error && at === 'form') ? '#way-passkey' : undefined)
    on('#alt-create', 'click', () => createFlow())
    on('#way-pair', 'click', () => scanFlow())
    on('#way-forgot', 'click', () => forgotFlow())
    // One challenge for this screen: the email field's offer and the button ask with the same one (the offer ends
    // before the button's prompt; whichever answers spends it, and the screen is drawn again after a miss).
    let c0 = null, issued = 0
    const challenge = async () => { if (!c0 || Date.now() - issued > 90_000) { c0 = (await pkChallenge()).challenge; issued = Date.now() } return c0 }
    /** From an assertion (still on its way) to the board. `standing`: it came from the email field's offer. */
    const withPasskey = async (pending, standing = false) => {
      try {
        let a = await pending
        if (!root.querySelector('#login-form')) return
        // (the hub's challenge lasts two minutes and the offer may have stood longer: once more, with that passkey)
        if (a.prf && Date.now() - issued > 100_000) { c0 = null; a = await passkeyGet({ challenge: await challenge(), allow: [a.credential_id] }) }
        if (!a.prf) return loginFlow(NO_PRF_HERE, 'passkey')
        keyBusy('Logging in…')
        say('')
        const { client } = await (await account()).loginWithPasskey({ hub_url: hub, assertion: a, device_name, client: CLIENT })
        await done(client)
      } catch (err) {
        if (err.code === 'passkey-aborted' || !root.querySelector('#login-form')) return
        // The email field's offer was refused by the browser itself: it ends, without a word and without drawing the
        // form again (the person may be typing in it); the button still asks on a tap.
        if (standing) { offerEnded = true; return }
        if (err.code === 'passkey-cancelled') { keyIdle(); standingOffer(); return }
        console.warn(err)
        if (err.code === 'room-exists') return roomExists()
        loginFlow(err.code === 'wrong-login' ? 'This passkey opens no account here.' : accountError(err), 'passkey')
      }
    }
    let standing = null   // the standing offer's request, while it waits (a browser runs one WebAuthn request at a time)
    const standingOffer = async () => {
      if (!offer.conditional || offerEnded) return
      try {
        const c = await challenge()
        if (!root.querySelector('#login-form')) return
        const stop = new AbortController()
        stopPasskey = () => stop.abort()
        const pending = passkeyGet({ challenge: c, mediation: 'conditional', signal: stop.signal })
        standing = pending.then(() => {}, () => {})
        withPasskey(pending, true)
      } catch (err) { console.warn('passkey offer:', err?.message ?? err) }
    }
    on('#way-passkey', 'click', async () => {
      say(''); root.querySelector('#passkey-error')?.remove()
      keyBusy('Waiting for passkey…')
      try {
        // the standing offer ends first, and is gone before the prompt is asked for
        stopPasskey?.(); stopPasskey = null
        const [c] = await Promise.all([challenge(), standing])
        withPasskey(passkeyGet({ challenge: c }))
      } catch (err) { console.warn(err); keyIdle(); say(accountError(err)) }
    })
    on('#login-form', 'submit', async e => {
      e.preventDefault()
      const form = e.target, f = await nameOf(form), pw = form.elements.password
      if (!f) return
      if (f.named.kind === 'id') return say(ID_NO_PASSWORD, form.elements.account)
      if (!pw.value) return say('Enter your password.', pw)
      busy(form, 'Logging in…')
      try {
        const { client } = await f.A.loginWithPassword({ hub_url: hub, account: f.text, password: pw.value, device_name, client: CLIENT })
        await done(client)
      } catch (err) { console.warn(err); if (err.code === 'room-exists') return roomExists(); idle(form); say(accountError(err), form.elements.password) }
    })
    if (pk && !demo) standingOffer()
  }

  // The Emergency Kit: the one field (email or account ID) + twelve words, and what opens the account from now on: a
  // new password (the old one stops working), or, the quiet way where the device can, a new passkey (made once the
  // words opened the account). `kit`: the kit's own code was scanned ({ hub_url, account }): its account ID is filled
  // in, and the account is looked for at the hub the code names; that hub is said before anything is typed when it is
  // not this app's own (whoever made the link chose it).
  function forgotFlow({ way = 'password', kit = null } = {}) {
    const passkey = way === 'passkey', at = kit?.hub_url ?? hub
    let other = ''
    try { other = at !== (demo ? 'https://hub.trommi.com' : hub) ? new URL(at).host : '' } catch {}
    show(obShell(passkey ? 'New passkey' : 'New password', html`<form id="forgot-form" class="ob-form" novalidate>${other ? html`<p class="ob-said" role="status" id="kit-hub">This code leads to an account at <b>${other}</b>. Go on only if that is where your account is.</p>` : ''}${obAccount(kit?.account ?? lastEmail)}
<label class="ob-field"><span class="ob-label">Twelve words</span><textarea name="words" rows="3" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea></label>
${passkey ? '' : obPassword({ label: 'New password', fresh: true })}
${obError()}${obSubmit(passkey ? 'Continue' : 'Set password')}</form>
${offer.get ? html`<p class="ob-alt ob-way"><button type="button" class="ob-link" id="way-swap">${passkey ? 'Set a password instead' : 'Use a passkey instead'}</button></p>` : ''}
<p class="ob-alt"><button type="button" class="ob-link" id="alt-login">Back to log in</button> · <a href="/recover" id="way-recover">Older recovery code</a></p>`, { lead: 'With the words of your Emergency Kit.' }), kit ? 'textarea' : undefined)
    on('#alt-login', 'click', () => loginFlow())
    on('#way-recover', 'click', e => { e.preventDefault(); recoverFlow() })
    on('#way-swap', 'click', () => { const f = root.querySelector('#forgot-form').elements, words = f.words.value, typed = f.account.value; forgotFlow({ way: passkey ? 'password' : 'passkey', kit }); const g = root.querySelector('#forgot-form').elements; g.words.value = words; g.account.value = typed })
    /** What a miss says: the words open the kit only under the name it was made with, which its sheet shows. */
    const missed = (err, named) => (err.code === 'wrong-recovery' && named.kind === 'id' ? 'Wrong account ID or words. A kit that shows an email opens with that email.' : accountError(err))
    on('#forgot-form', 'submit', async e => {
      e.preventDefault()
      const form = e.target, words = form.elements.words
      const f = await nameOf(form)
      if (!f) return
      try { f.A.parseRecoveryWords(words.value) } catch { return say('Check the twelve words.', words) }
      if (passkey) {
        busy(form, 'Opening…')
        try {
          const { client } = await f.A.recoverWithKit({ hub_url: at, account: f.text, words: words.value, device_name, client: CLIENT })
          newWayFlow(client, words.value)
        } catch (err) { console.warn(err); if (err.code === 'room-exists') return roomExists(); idle(form); say(missed(err, f.named)) }
        return
      }
      const pw = form.elements.password
      if (f.A.passwordProblem(pw.value)) return weak(form)
      busy(form, 'Setting…')
      try {
        // (the old kit opens nothing after this: the new one is shown next, as after "Create account")
        write(KIT_MARK, '1')
        const { client, kit: fresh } = await f.A.resetPassword({ hub_url: at, account: f.text, words: words.value, new_password: pw.value, device_name, client: CLIENT })
        freshKit = { ...fresh, has_password: true }
        await opened(client)
      } catch (err) { console.warn(err); if (err.code === 'room-exists') return roomExists(); try { localStorage.removeItem(KIT_MARK) } catch {} idle(form); say(missed(err, f.named)) }
    })
  }
  // The words opened the account and this device is in. Now the way in for next time: a new passkey, or a password.
  // With it the account gets a new Emergency Kit (the old words open nothing after it), shown next.
  // (A reload here opens the board: the device is a member already; Settings → Account offers both again.)
  function newWayFlow(client, words, { way = 'passkey', note = '' } = {}) {
    const passkey = way === 'passkey'
    show(obShell(passkey ? 'New passkey' : 'New password', html`<form id="newway-form" class="ob-form" novalidate>${note ? html`<p class="ob-said" role="status" id="passkey-note">${note}</p>` : ''}${passkey ? '' : obPassword({ label: 'New password', fresh: true })}
${obError()}${passkey ? html`<button type="submit" class="ob-go" id="newway-passkey" data-word="Create passkey">Create passkey</button>` : obSubmit('Set password')}</form>
<p class="ob-alt ob-way"><button type="button" class="ob-link" id="way-swap">${passkey ? 'Set a password instead' : 'Use a passkey instead'}</button></p>`, { lead: 'Your account is open. Choose how you log in next time.', home: false }))
    on('#way-swap', 'click', () => newWayFlow(client, words, { way: passkey ? 'password' : 'passkey' }))
    on('#newway-form', 'submit', async e => {
      e.preventDefault()
      const form = e.target, A = await account()
      let made = null
      try {
        if (passkey) {
          busy(form, 'Waiting for passkey…')
          const st = await A.accountStatus(client)
          made = await passkeyMake({ challenge: await A.passkeyChallengeFor(client), user_handle: unb64u(st.user_handle), name: st.email ?? st.account, exclude: (st.passkeys ?? []).map(p => unb64u(p.credential_id)) })
          busy(form, 'Saving…')
          write(KIT_MARK, '1')
          const { kit } = await A.addPasskey(client, { unlock: { words }, passkey: made })
          made = null   // (it is the account's way in from here on)
          freshKit = { ...kit, has_password: false }
          return await opened(client)
        }
        if (A.passwordProblem(form.elements.password.value)) return weak(form)
        busy(form, 'Setting…')
        write(KIT_MARK, '1')
        const { kit } = await A.setPassword(client, { unlock: { words }, next: form.elements.password.value })
        freshKit = { ...kit, has_password: true }
        await opened(client)
      } catch (err) {
        console.warn(err)
        try { localStorage.removeItem(KIT_MARK) } catch {}
        if (made && cameToNothing(err)) passkeyForget(made.credential_id)
        if (err.code === 'no-prf') return newWayFlow(client, words, { way: 'password', note: NO_PRF })
        idle(form); say(err.code === 'passkey-cancelled' ? 'No passkey made.' : accountError(err))
      }
    })
  }

  // Scan a code: this device's camera reads the code a signed-in device shows (Settings → Invite a Device), and the
  // link in it goes on exactly as a pasted one. The camera's frame is the screen; "Paste the link" is the quiet way
  // under it (opened by itself when there is no camera to use). `still`: a state drawn for /screens, without a camera.
  // The stream ends when the screen is left (show), a code was read, or the tab is hidden; it comes back with the tab.
  function scanFlow({ still = demo ? 'scanning' : '', paste = false } = {}) {
    const can = Boolean(navigator.mediaDevices?.getUserMedia)
    let state = still || (can ? 'asking' : 'none')
    show(obShell('Scan a code', html`<div class="scan" id="scan" data-state="${state}"><video id="scan-video" muted playsinline aria-label="Camera"></video>${still ? html`<span class="scan-still">${FAKE_QR}</span>` : ''}${SCAN_CORNERS}
<button type="button" class="ob-chip scan-start" id="scan-start">Start camera</button></div>
<p class="scan-say" id="scan-say" role="status">${SCAN_SAYS[state]}</p>
<p class="scan-where">On the other device: Settings → Invite a Device</p>
<details class="ob-paste" id="scan-paste"${paste || state === 'denied' || state === 'none' ? raw(' open') : ''}><summary>Paste the link</summary>
<form id="paste-form" class="ob-form" novalidate><input name="link" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="The link" placeholder="https://app.trommi.com/join#v1…">
${obError()}${obSubmit('Next')}</form></details>
<p class="ob-alt"><button type="button" class="ob-link" id="alt-login">Back to log in</button><span${state === 'denied' ? '' : raw(' hidden')}> · <button type="button" class="ob-link" id="scan-again">Try the camera</button></span></p>`, { cls: 'ob-scan' }), null)
    on('#alt-login', 'click', () => loginFlow())
    const box = root.querySelector('#scan'), line = root.querySelector('#scan-say'), video = root.querySelector('#scan-video'), again = root.querySelector('#scan-again').parentElement, pasteBox = root.querySelector('#scan-paste')
    const set = (next, words = SCAN_SAYS[next]) => {
      state = next; box.dataset.state = next; line.textContent = words
      again.hidden = next !== 'denied'
      if ((next === 'denied' || next === 'none') && !pasteBox.open) pasteBox.open = true
    }
    const go = text => {
      const hash = joinHash(text)
      if (!hash) return false
      history.replaceState(null, '', '/join')
      joinFlow(`${location.origin}/join${hash}`)
      return true
    }
    on('#paste-form', 'submit', e => { e.preventDefault(); if (!go(e.target.elements.link.value)) say('That is not a Trommi link.', e.target.elements.link) })
    on('#scan-paste', 'toggle', e => { if (e.target.open && !(demo && framed)) e.target.querySelector('input').focus({ preventScroll: true }) })
    if (still) { if (still === 'wrong') { box.dataset.state = 'scanning' } return }
    if (!can) return set('none')
    let stop = null, said = 0, alive = true
    const end = () => { stop?.(); stop = null }
    const begin = async () => {
      if (stop || !alive) return
      set('asking')
      try {
        stop = await scanQr(video, text => {
          if (go(text)) return true
          // (another code in view: said for a moment, the camera keeps looking)
          line.textContent = SCAN_SAYS.wrong; clearTimeout(said); said = setTimeout(() => { if (state === 'scanning') line.textContent = SCAN_SAYS.scanning }, 2500)
          return false
        })
        if (!alive || document.hidden) return end()
        set('scanning')
      } catch (err) {
        console.warn('camera:', err?.name ?? '', err?.message ?? err)
        // (iOS: a video that may not start by itself waits for a tap)
        if (err?.name === 'play') return set('tap')
        set(['NotAllowedError', 'SecurityError'].includes(err?.name) ? 'denied' : 'none')
      }
    }
    const hidden = () => { if (document.hidden) end(); else if (state === 'scanning' || state === 'asking') begin() }
    document.addEventListener('visibilitychange', hidden)
    addEventListener('pagehide', end)
    stopScan = () => { alive = false; clearTimeout(said); end(); document.removeEventListener('visibilitychange', hidden); removeEventListener('pagehide', end) }
    on('#scan-start', 'click', begin)
    on('#scan-again', 'click', begin)
    begin()
  }

  // Join with a link (from the address, scanned or pasted; its secret is never left in the address bar): this device
  // makes its keys and asks at once; then the check code (six emoji) to compare with the other device. Its name is
  // made for it (deviceLabel).
  async function joinFlow(link) {
    joinWait()
    try {
      const join = c.joinRoom({ link, device_name, client: CLIENT })
      join.check_code.then(code => {
        joinEmoji(code)
        on('#join-cancel', 'click', () => { join.cancel(); history.replaceState(null, '', '/'); scanFlow() })
      })
      await done(await join.client)
    } catch (err) {
      if (err.code === 'cancelled') return
      console.error(err)
      if (err.code === 'room-exists') return roomExists()
      joinFailed({ 'invite-used': 'This code was used already.', 'invite-expired': 'This code has run out.', 'invite-burned': 'The emoji did not match there.', 'bad-invite': 'This link is not a valid invite. Ask for a new one.' }[err.code] ?? accountError(err))
    }
  }
  function joinWait() { show(obShell('Log in', html`<p class="room-wait">Asking the other device…</p>`), null) }
  function joinEmoji(code) {
    show(obShell('Same six emoji?', html`${emojiRow(code, 'check-code')}<p class="room-wait">Waiting for the other device…</p>
<p class="ob-alt"><button type="button" class="ob-link" id="join-cancel">Cancel</button></p>`, { lead: 'If they match, tap “They match” on the other device.', cls: 'ob-emoji', home: false }), null)
  }
  function joinFailed(why) {
    show(obShell('Not logged in', html`<p class="ob-error is-shown" role="alert">${why}</p><button type="button" class="ob-go" id="scan-again">Scan again</button>`, { lead: 'Show a new code on the other device.' }), '#scan-again')
    on('#scan-again', 'click', () => scanFlow())
  }

  // ---- the demo (/screens): every state of these screens, drawn with made-up words and no account ----
  function demoFlow(state) {
    lastEmail = 'ada@example.org'
    const words = KIT_EMPTY
    const type = (sel, value) => { const f = root.querySelector(sel); if (f) { f.value = value; f.dispatchEvent(new Event('input', { bubbles: true })) } }
    const DEMO_ID = '0f8fad5b-d9cb-469f-a165-70867728950e', DEMO_HUB = 'https://hub.trommi.com'
    const linkOf = id => { try { return pageHelpers.kitAddress('https://app.trommi.com', DEMO_HUB, id) } catch { return null } }
    const kit = ({ email = lastEmail, ...o }) => kitPage(root, { kit: { email, account: DEMO_ID, form: email ? 'email' : 'id' }, linkOf, demo: true, logout: null, ...o })
    const flows = {
      welcome: () => welcome(), 'logged-out': () => welcome(),
      create: () => createFlow(), 'create-nopasskey': () => createFlow(),
      'create-passkey-waiting': () => { createFlow(); busy(root.querySelector('#create-form'), 'Waiting for passkey…') },
      'create-passkey-cancelled': () => { createFlow(); say('No passkey made.') },
      'create-passkey-fallback': () => createFlow({ way: 'password', note: NO_PRF }),
      'create-password': () => createFlow({ way: 'password' }),
      'create-typing': () => { createFlow({ way: 'password' }); type('#ob-pw', 'seven77') },
      'create-generated': () => { createFlow({ way: 'password' }); root.querySelector('.ob-gen').click() },
      'create-error': () => { createFlow({ way: 'password' }); type('#ob-pw', 'short'); weak(root.querySelector('#create-form')) },
      'create-busy': () => { createFlow({ way: 'password' }); type('#ob-pw', 'a long enough password'); busy(root.querySelector('#create-form'), 'Creating…') },
      'create-offline': () => { createFlow({ way: 'password' }); type('#ob-pw', 'a long enough password'); say(accountError({ code: 'offline' })) },
      'create-limit': () => { createFlow({ way: 'password' }); type('#ob-pw', 'a long enough password'); say(accountError({ code: 'too-many' })) },
      kit: () => kit({ words }), 'kit-shown': () => kit({ words, shown: true }), 'kit-again': () => kit({ logout: () => {} }), 'kit-wrong': () => kit({ error: 'Wrong password.', logout: () => {} }),
      'kit-passkey': () => kit({ words, ways: { password: false, passkey: true } }), 'kit-noemail': () => kit({ words, shown: true, email: null, ways: { password: false, passkey: true } }),
      'create-noemail-yet': () => { lastEmail = ''; createFlow(); say(NEEDS_EMAIL_YET) },
      'login-id': () => { lastEmail = DEMO_ID; loginFlow(ID_NO_PASSWORD) },
      'forgot-kit': () => forgotFlow({ way: 'passkey', kit: { hub_url: DEMO_HUB, account: DEMO_ID } }), 'forgot-kit-hub': () => forgotFlow({ way: 'passkey', kit: { hub_url: 'https://hub.example.org', account: DEMO_ID } }),
      'forgot-wrong-id': () => { forgotFlow({ way: 'passkey', kit: { hub_url: DEMO_HUB, account: DEMO_ID } }); type('textarea', words); say('Wrong account ID or words. A kit that shows an email opens with that email.') }, 'kit-again-passkey': () => kit({ logout: () => {}, ways: { password: false, passkey: true } }), 'kit-again-both': () => kit({ logout: () => {}, ways: { password: true, passkey: true } }),
      'login-nopasskey': () => loginFlow(), 'login-passkey-waiting': () => { loginFlow(); keyBusy('Waiting for passkey…') }, 'login-passkey-busy': () => { loginFlow(); keyBusy('Logging in…') },
      'login-passkey-error': () => loginFlow('This passkey opens no account here.', 'passkey'), 'login-passkey-noprf': () => loginFlow(NO_PRF_HERE, 'passkey'),
      'forgot-passkey': () => forgotFlow({ way: 'passkey' }), 'new-passkey': () => newWayFlow(null, ''), 'new-passkey-fallback': () => newWayFlow(null, '', { way: 'password', note: NO_PRF }),
      login: () => loginFlow(), 'login-error': () => { loginFlow(accountError({ code: 'wrong-login' })); type('#ob-pw', 'not my password') },
      'login-limit': () => loginFlow(accountError({ code: 'rate-limited' })), 'login-offline': () => loginFlow(accountError({ code: 'offline' })),
      forgot: () => forgotFlow(), scan: () => scanFlow({ still: 'scanning' }), 'scan-asking': () => scanFlow({ still: 'asking' }), 'scan-denied': () => scanFlow({ still: 'denied' }),
      'scan-none': () => scanFlow({ still: 'none' }), 'scan-tap': () => scanFlow({ still: 'tap' }), 'scan-wrong': () => { scanFlow({ still: 'wrong' }) }, 'scan-paste': () => scanFlow({ still: 'scanning', paste: true }),
      join: () => joinWait(), 'join-emoji': () => joinEmoji('03-17-08-42-25-11'),
      'join-expired': () => joinFailed('This code has run out.'), 'join-burned': () => joinFailed('The emoji did not match there.'),
      recover: () => recoverFlow(), 'recovery-code': () => recovery(null, 'TRMI-4K7Q-9XWD-2HBN-6PLZ-8RCV'),
      broken: () => brokenFlow(Object.assign(new Error('the device keys are not in this browser'), { code: 'no-device' })),
    }
    ;(flows[state] ?? welcome)()
  }

  // Accounts from before email + password: the address (/recover#r1…) and the recovery code shown back then.

  function recoverFlow(error = '') {
    history.replaceState(null, '', `/recover${location.hash.startsWith('#r1.') ? location.hash : ''}`)
    show(obShell('Recovery code', html`<form id="recover-form" class="ob-form" novalidate>
<label class="ob-field"><span class="ob-label">Address</span><input name="room_link" value="${addressInBar()}" required autocomplete="off" inputmode="url"></label>
<label class="ob-field"><span class="ob-label">Recovery code</span><input name="code" required autocomplete="off" spellcheck="false" class="ob-mono"></label>
${obError(error)}${obSubmit('Recover')}</form>`, { lead: 'For accounts from before email and password.' }))
    on('#recover-form', 'submit', async e => {
      e.preventDefault()
      const f = new FormData(e.target)
      busy(e.target, 'Recovering…')
      try {
        const { hub_url, room_id } = parseAddress(f.get('room_link'))
        // The new code comes before the recovery is posted: it is on screen from then on.
        const on_recovery_code = fresh => show(obShell('Your new code', html`<p class="room-recovery" id="recovery-code">${fresh}</p><p class="room-wait">Recovering…</p>`, { lead: 'Write it down now. It replaces the old one.', home: false }), null)
        const { client, recovery_code } = await (await account()).recoverWithCode({ hub_url, room_id, code: String(f.get('code')).trim(), device_name, client: CLIENT, on_recovery_code })
        recovery(client, recovery_code)
      } catch (err) { console.error(err); recoverFlow(err.code === 'bad-recovery-code' ? accountError(err) : `Not recovered: ${sayError(err)}`) }
    })
  }

  // The new recovery code after a recovery, shown once; the board opens only after the human confirmed keeping it.
  function recovery(client, code) {
    show(obShell('Your new code', html`<p class="room-recovery" id="recovery-code">${code}</p>
<form id="recovery-form" class="ob-form"><div class="ob-row"><button type="button" class="ob-second" id="recovery-copy">Copy</button></div><label class="ob-check"><input type="checkbox" name="kept" required> I have kept it</label>
${obSubmit('Open Trommi')}</form>`, { lead: 'Shown only now. It replaces the old one.', home: false }), '#recovery-copy')
    on('#recovery-copy', 'click', async e => { e.target.textContent = (await copyText(code)) ? 'Copied' : 'Write it down' })
    on('#recovery-form', 'submit', e => { e.preventDefault(); code = null; done(client) })
  }
}

// ---- qr ----
// QR codes for pairing, self-contained (no CDN, no dependency): qrSvg(text) draws the invite link as an SVG (byte mode,
// error correction M, versions 1-40, the mask with the lowest penalty), scanQr(video) reads one from the camera with the browser's
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

const SCAN_SAYS = { asking: 'Allow the camera to scan.', tap: '', scanning: 'Point at the code on your other device.', denied: 'Camera is off. Paste the link instead.', none: 'No camera here. Paste the link instead.', wrong: 'Not a Trommi code.' }
/** A join link of this app: this origin, /join, and after the # `v1.` with its three parts (the hub, the room's id and the secret, 32 bytes each). Anything else is no code of ours. */
const joinHash = text => {
  let u
  try { u = new URL(String(text).trim()) } catch { return null }
  return u.origin === location.origin && u.pathname === '/join' && /^#v1\.[\w-]{4,}\.[\w-]{43}\.[\w-]{43}$/.test(u.hash) ? u.hash : null
}
/** The drawn corners over the camera's picture: four pen angles, a little uneven. */
const SCAN_CORNERS = raw('<svg class="scan-corners" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="M15.2 31.5 Q14.2 21 15.6 15.8 Q22 14.4 31.8 15.3"/><path d="M68.4 14.9 Q79 14.3 84.5 15.5 Q85.9 22.5 84.8 31.9"/><path d="M85.1 68.2 Q85.8 78.6 84.4 84.6 Q77.5 85.8 68 84.9"/><path d="M31.6 85.2 Q21.4 85.9 15.5 84.3 Q14.2 77 15 68.3"/></svg>')

/** The browser's own reader where it has one for QR codes (Chrome on Android, macOS and ChromeOS; Safari where it is
 *  switched on), else the bundled one (core/qr-decode.mjs, loaded only now: Firefox, Chrome on Linux and Windows,
 *  iPhones): text of the code in `source` (a video for the browser's, the frame's pixels for ours), or null. */
async function qrReaderOf(video) {
  try {
    if ('BarcodeDetector' in window && (await BarcodeDetector.getSupportedFormats()).includes('qr_code')) {
      const detector = new BarcodeDetector({ formats: ['qr_code'] })
      return { native: true, read: async () => (await detector.detect(video))[0]?.rawValue ?? null }
    }
  } catch {}
  const { decodeQR } = await qrReader()
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true })
  return { native: false, read: async () => {
    // (the frame at no more than 960 px on its long side: enough for a code held to the camera, quick on a phone)
    const k = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight))
    const w = Math.round(video.videoWidth * k), h = Math.round(video.videoHeight * k)
    if (!w || !h) return null
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
    ctx.drawImage(video, 0, 0, w, h)
    try { return decodeQR(ctx.getImageData(0, 0, w, h)) || null } catch { return null }
  } }
}

/**
 * Read QR codes from the camera into `video` until onText returns true or stop() is called: the back camera where there
 * is one (a laptop gives its front one). Frames stay in this page: they are drawn to the video and read here, never
 * sent anywhere. Rejects with the browser's error (NotAllowedError, NotFoundError, …), or { name: 'play' } when the
 * video may not start without a tap.
 */
async function scanQr(video, onText) {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
  let on = true, timer = 0
  const stop = () => { on = false; clearTimeout(timer); for (const t of stream.getTracks()) t.stop(); video.srcObject = null }
  try {
    video.srcObject = stream
    video.muted = true; video.setAttribute('playsinline', '')
    try { await video.play() } catch (err) { throw Object.assign(new Error(err?.message ?? 'the video did not start'), { name: 'play' }) }
    const reader = await qrReaderOf(video)
    video.dataset.reader = reader.native ? 'browser' : 'bundled'
    const tick = async () => {
      if (!on) return
      const t0 = performance.now()
      let text = null
      try { if (video.readyState >= 2) text = await reader.read() } catch {}
      if (!on) return
      if (text && await onText(text)) return stop()
      // (a wrong code is said once, then the reader rests a moment; otherwise about six looks a second, never back to back)
      timer = setTimeout(tick, text ? 1500 : Math.max(160, (performance.now() - t0) * 1.5))
    }
    tick()
  } catch (err) { stop(); throw err }
  return stop
}

// ---- controller "room" ----
// The account pages' small helpers: copy a link or command, select a read-only field on focus,
// Generate a password, download or print the Emergency Kit, and the storage numbers (navigator.storage; client.usage()).

const size = n => (n == null ? '–' : n < 1e3 ? `${n} B` : n < 1e6 ? `${(n / 1e3).toFixed(0)} kB` : n < 1e9 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e9).toFixed(2)} GB`)

// The agent invite's clipboard (clipboard() above): a press on a command copies it and ticks its line; the minutes
// left count down by themselves, and when they are gone the page is rendered again (it then offers a new link).
controller('invite-clip', class extends Controller {
  static targets = ['left']
  static values = { until: Number }
  connect() { if (this.untilValue) { this.count(); this.timer = setInterval(() => this.count(), 5000) } }
  disconnect() { clearInterval(this.timer); clearTimeout(this.said) }
  count() {
    const ms = this.untilValue - Date.now()
    if (this.hasLeftTarget) this.leftTarget.textContent = ms > 90000 ? `${Math.round(ms / 60000)} more min.` : ms > 0 ? 'less than a minute.' : 'no time left.'
    if (ms <= 0) { clearInterval(this.timer); window.Turbo?.visit(location.pathname, { action: 'replace' }) }
  }
  async copy(e) {
    const line = e.currentTarget, word = line.querySelector('.clip-copy-word'), ok = await copyText(e.params.text)
    word.textContent = ok ? 'Copied' : 'Not copied'
    if (ok) line.closest('.clip-step')?.classList.add('is-done')
    clearTimeout(this.said)
    this.said = setTimeout(() => { for (const w of this.element.querySelectorAll('.clip-copy-word')) w.textContent = w.dataset.word }, 1800)
  }
})

// ---- Settings: a stand-in for the code until it is asked for (drawn blurred; it encodes nothing), the Theme's three
// choices ----
const FAKE_QR = (() => {
  const n = 25, cells = [], finder = (x, y) => (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7)
  let seed = 7
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const ring = finder(x, y) && (() => { const fx = x < 7 ? x : x - (n - 7), fy = y < 7 ? y : y - (n - 7); return fx === 0 || fx === 6 || fy === 0 || fy === 6 || (fx >= 2 && fx <= 4 && fy >= 2 && fy <= 4) })()
    if (finder(x, y) ? ring : rnd() > 0.52) cells.push(`M${x} ${y}h1v1h-1z`)
  }
  return raw(`<svg viewBox="-2 -2 ${n + 4} ${n + 4}" aria-hidden="true"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="#fff"/><path d="${cells.join('')}" fill="#14181a"/></svg>`)
})()
controller('set-theme', class extends Controller {
  connect() { for (const r of this.element.querySelectorAll('input[name="theme"]')) r.checked = r.value === themeMode() }
  pick(e) { setThemeMode(e.target.value) }
})

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
