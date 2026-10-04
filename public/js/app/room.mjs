// The room's own screens. Inside a room (pages of the board): /devices (who is in the room, the two ways to add a
// device, inviting an agent, removing), /pair/:id (the QR code, then "Neues Gerät hinzufügen?" with four codes to tap),
// /settings (sign-in with a password, storage, recovery, the room address). Before a room (a screen of its own): found a
// room (recovery code once, confirmed), pair this device (scan or open the link, show the code), sign in with a
// password, recover with the code. Calm and sober: this is about keys; pen drawings only on the two choice buttons.
// Core features that may not be there yet (escrow, usage, session handover) are shown only when the core has them.
import { html, raw } from '../views/html.mjs'
import { sketchSvg, doodleSvg } from '../pen.js'
import { BELL } from './layout.mjs'
import { CLIENT } from './version.mjs'
import { qrSvg } from './qr.mjs'
import { passphraseProblem as corePassphraseProblem } from '/vendor/escrow.mjs'

const read = (k, f = null) => { try { return localStorage.getItem(k) ?? f } catch { return f } }
const write = (k, v) => { try { localStorage.setItem(k, v) } catch {} }
const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
/** The hub this app talks to: ?hub=… (remembered), else https://hub.trommi.com (local dev: http://127.0.0.1:8890). */
export function hubUrl() {
  const asked = new URLSearchParams(location.search).get('hub')
  if (asked) write('trommi-hub', asked.replace(/\/+$/, ''))
  return read('trommi-hub') || (local ? 'http://127.0.0.1:8890' : 'https://hub.trommi.com')
}
const deviceGuess = () => (/iPhone|Android.*Mobile/.test(navigator.userAgent) ? 'Handy' : /iPad|Android/.test(navigator.userAgent) ? 'Tablet' : 'Laptop')
const ago = ts => { const s = Math.round((Date.now() - ts) / 1000); return s < 60 ? 'gerade eben' : s < 3600 ? `vor ${Math.round(s / 60)} Min.` : `vor ${Math.round(s / 3600)} Std.` }
const sk = name => raw(['phone', 'house'].includes(name) ? doodleSvg(`draw:${name}`) : sketchSvg(name))
const has = (o, fn) => typeof o?.[fn] === 'function'
const code6 = c => `${String(c).slice(0, 3)} ${String(c).slice(3)}`
// The core's passphrase rule; its reasons said in German.
const PROBLEM = { 'at least 14 characters': 'Mindestens 14 Zeichen.', 'at least four words, or 20 characters': 'Mindestens 4 Wörter (oder 20 Zeichen).', 'too repetitive': 'Zu viele Wiederholungen.' }
/** null if the passphrase is good enough, else why not (German). */
export function passphraseProblem(p) {
  p = String(p ?? '')
  const why = corePassphraseProblem(p)
  return why ? (PROBLEM[why] ?? why) : null
}
/** Signing in with a password on a fresh browser waits for the hub and crypto side (A); ?pwlogin shows it early. */
const PASSWORD_LOGIN = new URLSearchParams(location.search).has('pwlogin')
const pwFields = html`<label>Passwort<input type="password" name="passphrase" autocomplete="new-password" required minlength="14" data-room-target="pass" placeholder="ein Satz aus vier oder mehr Wörtern"></label>
<label>Noch einmal<input type="password" name="again" autocomplete="new-password" required data-room-target="again"></label>
<p class="room-strength" data-room-target="meter" data-level="0" aria-live="polite">Mindestens 4 Wörter und 14 Zeichen.</p>`
const TRADE_OFF = 'Bequem, aber: Wer Raumadresse und Passwort kennt, kommt in den Raum. Nimm einen langen Satz, den nur du kennst.'
const shell = (title, inner, cls = '') => html`<main id="room" class="room${cls ? ` ${cls}` : ''}" aria-label="${title}"><header class="room-head"><span class="room-bell">${BELL}</span><h2>${title}</h2></header>${inner}</main>`
const tabs = on => html`<nav class="room-tabs" aria-label="Geräte und Einstellungen"><a href="/devices" data-nav${on === 'devices' ? raw(' aria-current="page"') : ''}>Geräte</a><a href="/settings" data-nav${on === 'settings' ? raw(' aria-current="page"') : ''}>Einstellungen</a></nav>`
const copyBox = (value, label, cls = '') => html`<div class="room-link${cls ? ` ${cls}` : ''}" data-controller="room"><input readonly value="${value}" aria-label="${label}" data-room-target="field" data-action="focus->room#select"><button type="button" data-action="room#copy" data-room-text-param="${value}"><span data-room-target="label">Kopieren</span></button></div>`
const errorLine = e => (e ? html`<p class="room-error" role="alert">${e}</p>` : '')
const sessionName = s => s.settings?.name || s.profile?.agent_name || s.agent_session_id || s.device_name || 'Sitzung'

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
      const me = d.is_me, human = d.device_role === 'human', name = d.device_name || (human ? 'Gerät' : 'Agent')
      const canRemove = d.is_active && !me && isHuman()
      return html`<li class="room-device${d.is_active ? '' : ' is-removed'}" id="device-${d.device_id}">
<span class="room-device-dot" data-online="${d.is_online ? 'yes' : 'no'}" title="${d.is_online ? 'online' : 'nicht verbunden'}"></span>
<span class="room-device-name"><b>${name}</b>${me ? html` <em>dieses Gerät</em>` : ''}<small>${human ? 'Person' : 'Agent'} · <span class="room-fp" title="Schlüssel-Fingerabdruck aus der signierten Mitgliederliste">${fp(d)}</span>${d.is_active ? '' : ' · entfernt'}</small></span>
${canRemove ? html`<form method="post" action="/devices/remove" class="room-remove"><input type="hidden" name="device_id" value="${d.device_id}"><details><summary>Entfernen</summary><p>${human
        ? html`${name} kann danach nichts Neues mehr öffnen. Alle anderen bekommen einen neuen Raumschlüssel (Schlüsselwechsel); das dauert einen Moment.`
        : html`${name} kann danach nichts Neues mehr lesen. Die anderen bekommen einen neuen Raumschlüssel; der Verlauf der Sitzung bleibt.`}</p><button type="submit" class="room-danger">${name} entfernen</button></details></form>` : ''}</li>`
    }
    // The earlier conversation stays closed unless the human opens it (security review: agent invites without history).
    const historyAsk = () => html`<fieldset class="room-history"><legend>May it read the earlier conversation?</legend><label><input type="radio" name="with_history" value="no" checked> No</label><label><input type="radio" name="with_history" value="yes"> Yes</label></fieldset>`
    const sessionOptions = (except = null) => [...m().sessions.values()].filter(s => s.agent_device_id !== except).map(s => html`<option value="${s.agent_session_id || s.agent_device_id}">${sessionName(s)}</option>`)
    // Hand a session to an agent that is in the room: one form under the agents (not one per row: big rooms).
    const handoverForm = agents => html`<details class="room-more room-handover"><summary>Sitzung an einen Agenten übergeben</summary><form method="post" action="/devices/handover" class="room-form">
<label>Agent<select name="agent_device_id" required>${agents.map(d => html`<option value="${d.device_id}">${d.device_name || 'Agent'} · ${fp(d)}</option>`)}</select></label>
<label>Sitzung<select name="session_id" required>${sessionOptions()}</select></label>${historyAsk()}<button type="submit" class="room-primary">Übergeben</button></form></details>`
    // The three lists, each one element with an id, so a change replaces only the list it touched.
    const lists = () => {
      const all = [...m().members.values()]
      const order = (a, b) => a.added_entry_number - b.added_entry_number
      const people = all.filter(d => d.is_active && d.device_role === 'human').sort(order)
      const agents = all.filter(d => d.is_active && d.device_role !== 'human').sort(order)
      const gone = all.filter(d => !d.is_active).sort(order)
      return {
        people: String(html`<ul class="room-devices" id="room-people">${people.map(member)}</ul>`),
        agents: String(agents.length ? html`<ul class="room-devices" id="room-agents">${agents.map(member)}</ul>` : html`<p class="room-meta" id="room-agents">Noch kein Agent im Raum.</p>`),
        gone: String(gone.length ? html`<details class="room-section room-gone" id="room-gone"><summary>Entfernt (${gone.length})</summary><ul class="room-devices">${gone.map(member)}</ul></details>` : html`<div id="room-gone" hidden></div>`),
      }
    }
    const devicesMain = (error = '') => {
      const L = lists(), active = [...m().members.values()].filter(d => d.is_active && d.device_role !== 'human')
      const escrow = has(client, 'setPassphrase') && PASSWORD_LOGIN
      const pw = m().room.has_passphrase
      return shell('Geräte', html`${tabs('devices')}
${errorLine(error)}
${isHuman() ? html`<section class="room-section" aria-labelledby="add-head"><h3 id="add-head">Neues Gerät hinzufügen</h3>
<div class="room-ways">
<form method="post" action="/pair" class="room-way"><input type="hidden" name="role" value="human"><button type="submit" class="room-way-go" id="pair-start">${sk('phone')}<b>Gerät koppeln</b><span>Hier erscheint ein QR-Code. Das neue Gerät scannt ihn, dann tippst du eine Zahl an. Fertig.</span></button></form>
${escrow ? html`<a href="/settings#passwort" data-nav class="room-way room-way-go" id="password-way">${sk('key')}<b>Mit Passwort anmelden</b><span>${pw ? 'Ist eingerichtet. Auf dem neuen Gerät app.trommi.com öffnen und „Mit Passwort anmelden“ wählen.' : 'Ein neuer Browser kommt mit Raumadresse und Passwort hinein. Erst einrichten.'}</span></a>` : ''}
</div></section>` : ''}
<section class="room-section" aria-labelledby="people-head"><h3 id="people-head">Deine Geräte</h3>${raw(L.people)}</section>
<section class="room-section" aria-labelledby="agents-head"><h3 id="agents-head">Agenten</h3>${raw(L.agents)}${isHuman() && active.length && has(client, 'assignSession') ? handoverForm(active) : ''}
${isHuman() ? html`<form method="post" action="/pair" class="room-agent-form"><input type="hidden" name="role" value="agent"><label>Name der Sitzung<input name="label" maxlength="40" placeholder="z. B. Website" autocomplete="off"></label>${has(client, 'assignSession') && m().sessions.size ? html`<label>Übernimmt<select name="session_id"><option value="">eine neue Sitzung</option>${sessionOptions()}</select></label>${historyAsk(false)}` : ''}<button type="submit" id="agent-invite">Agent einladen</button></form>` : ''}</section>
${raw(L.gone)}
<p class="room-meta">Jedes Gerät hat eigene Schlüssel; der Hub sieht nur versiegelte Umschläge. Der Fingerabdruck steht in der signierten Mitgliederliste: Er muss auf allen Geräten gleich aussehen.</p>`)
    }
    t.get(/^\/devices$/, ({ req, res }) => page(req, res, 'Geräte', devicesMain(), { stream: '&room=devices' }))
    t.post(/^\/devices\/remove$/, async ({ req, res, form }) => {
      try { await client.removeDevices([String(form.get('device_id'))]) } catch (err) { return page(req, res, 'Geräte', devicesMain(`Nicht entfernt: ${err.message}`), {}, 422) }
      t.redirect(res, '/devices')
    })
    t.post(/^\/devices\/handover$/, async ({ req, res, form }) => {
      try { await client.assignSession({ session_id: String(form.get('session_id')), agent_device_id: String(form.get('agent_device_id')), with_history: form.get('with_history') === 'yes' }) } catch (err) { return page(req, res, 'Geräte', devicesMain(`Nicht übergeben: ${err.message}`), {}, 422) }
      t.redirect(res, '/devices')
    })
    t.post(/^\/pair$/, async ({ req, res, form }) => {
      try {
        const agent = form.get('role') === 'agent'
        const label = String(form.get('label') ?? '').trim() || null
        const invite = await client.createInvite({ device_role: agent ? 'agent' : 'human', app_url: `${location.origin}/join`, ...(agent && label ? { label } : {}) })
        const session_id = String(form.get('session_id') ?? '')
        if (agent && session_id && !form.get('with_history')) return page(req, res, 'Geräte', devicesMain('Darf er den bisherigen Verlauf lesen? Bitte Ja oder Nein wählen.'), {}, 422)
        if (agent && session_id) handovers.set(invite.invite_id, { session_id, with_history: form.get('with_history') === 'yes', done: false })
        t.redirect(res, `/pair/${invite.invite_id}`)
      } catch (err) { page(req, res, 'Geräte', devicesMain(`Keine Einladung: ${err.message}`), {}, 422) }
    })
    t.live('room', {
      take: () => lists(),
      diff: (was, now) => ['people', 'agents', 'gone'].map(k => (was[k] !== now[k] ? String(t.stream('replace', `room-${k}`, raw(now[k]))) : '')).join(''),
    })

    // ---- /pair/:id ----
    const newcomerName = inv => (inv.newcomer && m().members.get(inv.newcomer.device_id)?.device_name) || inv.newcomer?.device_name || ''
    const again = (agent, word = 'Neu koppeln') => html`<form method="post" action="/pair" class="room-inline"><input type="hidden" name="role" value="${agent ? 'agent' : 'human'}"><button type="submit" class="room-primary">${word}</button></form>`
    const back = html`<a href="/devices" data-nav class="room-back">Zurück zu den Geräten</a>`
    const inviteMain = (inv, error = '') => {
      if (!inv) return shell('Einladung', html`<p class="room-lead">Diese Einladung gibt es nicht mehr.</p>${back}`)
      const agent = inv.device_role === 'agent', state = inv.invite_state
      const left = Math.max(0, Math.round((inv.expires_at - Date.now()) / 60000))
      let body
      // The link goes to the channel by the human's hands only (never pasted into the model's prompt).
      if (state === 'open' && agent) body = html`<p class="room-lead">Run this in the project folder of the Claude Code session that should join:</p>
${copyBox(`node /home/christopher/git/trommi/hub/channel.mjs join '${inv.link}'`, 'Command', 'room-cmd')}<p class="room-lead">or start Claude Code there with the link:</p>${copyBox(`TROMMI_INVITE='${inv.link}' claude --dangerously-load-development-channels server:trommi`, 'Command', 'room-cmd')}
<p class="room-wait">Waiting for the agent… The link works once, ${left} more min. An agent needs no code.</p>`
      else if (state === 'open') body = html`<div class="room-pair"><div class="room-qr" data-controller="room">${raw(qrSvg(inv.link, 'QR-Code zum Koppeln'))}</div>
<ol class="room-steps"><li>Auf dem neuen Gerät die Kamera öffnen und den Code scannen. Oder dort app.trommi.com öffnen und „Gerät koppeln“ wählen.</li><li>Das neue Gerät zeigt eine Zahl. Hier tippst du dieselbe an.</li></ol></div>
<details class="room-more"><summary>Kein Scanner? Link schicken</summary><p class="room-meta">Schick dir den Link selbst (z. B. per Nachricht an dich) und öffne ihn auf dem neuen Gerät. Das Geheimnis steht hinter dem #; es erreicht keinen Server.</p>${copyBox(inv.link, 'Einladungslink')}</details>
<p class="room-wait">Wartet auf das neue Gerät … Der Code gilt einmal, noch ${left} Min.</p>`
      else if (state === 'confirm_code' && inv.code_choices?.length) body = html`<p class="room-lead">Ein Gerät möchte in den Raum. Welche Zahl zeigt es?</p>
<div class="room-choices">${inv.code_choices.map(c => html`<form method="post" action="/pair/${inv.invite_id}/confirm"><input type="hidden" name="code" value="${c}"><button type="submit" class="room-choice">${code6(c)}</button></form>`)}</div>
${errorLine(error)}<p class="room-meta">Keine passt? Dann nichts antippen, sondern abbrechen. Eine falsche Zahl macht die Einladung ungültig.</p>${back}`
      else if (state === 'confirm_code') body = html`<p class="room-lead">Ein Gerät möchte in den Raum. Tippe die sechs Ziffern ein, die es zeigt:</p>
<form method="post" action="/pair/${inv.invite_id}/confirm" class="room-code-form"><input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required autofocus aria-label="Zahl des neuen Geräts" class="room-code-input"><button type="submit" class="room-primary">Hinzufügen</button></form>
${errorLine(error)}<p class="room-meta">Eine falsche Zahl macht die Einladung ungültig.</p>`
      else if (state === 'adding') body = html`<p class="room-wait">${newcomerName(inv) || (agent ? 'Der Agent' : 'Das Gerät')} wird hinzugefügt …</p>`
      else if (state === 'joined') {
        const h = handovers.get(inv.invite_id)
        body = html`<p class="room-lead room-ok">✓ ${newcomerName(inv) || (agent ? 'Der Agent' : 'Das neue Gerät')} ist jetzt im Raum.</p>${h && !h.done ? html`<p class="room-wait">Sitzung wird übergeben …</p>` : ''}${h?.error ? errorLine(`Sitzung nicht übergeben: ${h.error}`) : ''}<a href="/devices" data-nav class="room-done">Fertig</a>`
      } else if (inv.error === 'code-mismatch') body = html`<p class="room-error" role="alert">Falsche Zahl. Niemand wurde hinzugefügt; die Einladung ist verbraucht.</p>${again(agent)}${back}`
      else body = html`<p class="room-error" role="alert">${state === 'expired' ? 'Die Einladung ist abgelaufen.' : `Das hat nicht geklappt${inv.error ? ` (${inv.error})` : ''}.`}</p>${errorLine(error)}${again(agent)}${back}`
      return shell(agent ? 'Agent einladen' : state === 'confirm_code' ? 'Neues Gerät hinzufügen?' : 'Gerät koppeln', html`<div id="invite-${inv.invite_id}" class="room-invite" data-state="${state}">${body}</div>`)
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
      page(req, res, inv?.device_role === 'agent' ? 'Agent einladen' : 'Gerät koppeln', inviteMain(inv), { view: 'invite', stream: `&invite=${match[1]}` })
    })
    t.post(/^\/pair\/([0-9a-f]+)\/confirm$/, async ({ req, res, match, form }) => {
      try { await client.confirmInvite(match[1], String(form.get('code') ?? '').replace(/\D/g, '')) } catch (err) {
        return page(req, res, 'Gerät koppeln', inviteMain(m().invites.get(match[1]), err.code === 'code-mismatch' ? '' : err.message), { view: 'invite', stream: `&invite=${match[1]}` }, 422)
      }
      t.redirect(res, `/pair/${match[1]}`)
    })
    t.live('invite', {
      take: (mm, clients) => new Map(clients.map(c => c.params.get('invite')).filter(Boolean).map(id => { const inv = m().invites.get(id); handOver(inv); return [id, String(inviteMain(inv)).replace(/noch \d+ Min\./g, '')] })),
      diff: (was, now, c) => { const id = c.params.get('invite'); return was.get(id) !== now.get(id) ? String(t.stream('refresh')) : '' },
    })

    // ---- /settings ----
    const settingsMain = (error = '', said = '') => {
      const room = m().room
      const link = has(core, 'roomLink') && room.hub_url ? core.roomLink(room.hub_url, room.room_id) : null
      const escrow = has(client, 'setPassphrase'), pw = room.has_passphrase
      const pwForm = (word) => html`<form method="post" action="/settings/passphrase" class="room-form room-pw" data-controller="room" data-action="input->room#strength">
<label>Wiederherstellungscode<input name="recovery_code" required autocomplete="off" spellcheck="false" class="room-mono" placeholder="XXXX-XXXX-…"><small class="room-hint">Das Passwort schützt eine verschlüsselte Kopie dieses Codes. Er wird nur dafür gebraucht und nicht gespeichert.</small></label>
${pwFields}
<button type="submit" class="room-primary" data-room-target="go" disabled>${word}</button></form>`
      return shell('Einstellungen', html`${tabs('settings')}
${errorLine(error)}${said ? html`<p class="room-lead room-ok" role="status">${said}</p>` : ''}
${escrow && isHuman() ? html`<section class="room-section" id="passwort" aria-labelledby="pw-head"><h3 id="pw-head">Mit Passwort anmelden</h3>
${pw ? html`<p class="room-lead">${PASSWORD_LOGIN ? 'Eingerichtet. Ein neuer Browser kommt mit der Raumadresse und diesem Passwort hinein: app.trommi.com → „Mit Passwort anmelden“.' : 'Eingerichtet.'}</p>
<details class="room-more"><summary>Passwort ändern</summary>${pwForm('Neues Passwort sichern')}</details>
<form method="post" action="/settings/passphrase/off" class="room-remove"><details><summary>Ausschalten</summary><p>Danach geht ein neues Gerät nur noch übers Koppeln.</p><button type="submit" class="room-danger">Passwort-Anmeldung ausschalten</button></details></form>`
        : html`<p class="room-lead">${TRADE_OFF}</p>${pw == null && has(client, 'checkPassphrase') ? html`<p class="room-wait">Prüft, ob schon eines eingerichtet ist …</p>` : ''}${pwForm('Passwort einrichten')}`}
${PASSWORD_LOGIN ? '' : html`<p class="room-meta">Die Anmeldung damit auf einem neuen Browser kommt in Kürze; einrichten kannst du es schon.</p>`}</section>` : ''}
${link ? html`<section class="room-section" aria-labelledby="addr-head"><h3 id="addr-head">Raumadresse</h3><p class="room-lead">Für die Anmeldung mit Passwort oder mit dem Wiederherstellungscode. Allein öffnet sie nichts.</p>${copyBox(link, 'Raumadresse')}</section>` : ''}
<section class="room-section" aria-labelledby="store-head"><h3 id="store-head">Speicher</h3><dl class="room-usage" data-controller="room" data-room-usage-value="${has(client, 'usage') ? 'hub' : 'local'}"><div><dt>Auf diesem Gerät</dt><dd data-room-target="local">…</dd></div>${has(client, 'usage') ? html`<div><dt>Im Hub (verschlüsselt)</dt><dd data-room-target="hub">…</dd></div>` : ''}</dl><p class="room-meta">Der Hub löscht Umschläge nach 30 Tagen; deine Geräte behalten, was sie entschlüsselt haben.</p></section>
<section class="room-section" aria-labelledby="rec-head"><h3 id="rec-head">Wiederherstellungscode</h3><p class="room-lead">Er wurde einmal beim Gründen gezeigt. Sind alle Geräte weg, kommst du damit zurück: app.trommi.com → „Alle Geräte verloren?“. Alle alten Geräte fliegen dann raus, die Agenten bleiben.</p></section>
<p class="room-meta">Raum ${room.room_id.slice(0, 16)}… · Schlüsselepoche ${room.key_epoch} · Hub ${room.hub_url}</p>`)
    }
    let asked = false
    const askPassphrase = () => { if (!asked && has(client, 'checkPassphrase') && m().room.has_passphrase == null) { asked = true; client.checkPassphrase().catch(() => {}) } }
    t.live('settings', { take: () => m().room.has_passphrase, diff: (was, now) => (was !== now ? String(t.stream('refresh')) : '') })
    t.get(/^\/settings$/, ({ req, res, url }) => { askPassphrase(); page(req, res, 'Einstellungen', settingsMain('', { on: 'Passwort-Anmeldung eingerichtet.', off: 'Passwort-Anmeldung ausgeschaltet.' }[url.searchParams.get('pw')] ?? ''), { view: 'settings' }) })
    t.post(/^\/settings\/passphrase$/, async ({ req, res, form }) => {
      const p = String(form.get('passphrase') ?? '')
      const fail = e => page(req, res, 'Einstellungen', settingsMain(e), { view: 'settings' }, 422)
      if (p !== String(form.get('again') ?? '')) return fail('Die beiden Eingaben sind verschieden.')
      const why = passphraseProblem(p)
      if (why) return fail(`Zu schwach. ${why}`)
      try { await client.setPassphrase(p, { recovery_code: String(form.get('recovery_code') ?? '').trim() }) } catch (err) {
        return fail(err.code === 'weak-passphrase' ? 'Zu schwach: mindestens 4 Wörter und 14 Zeichen.' : err.code === 'bad-recovery-code' ? 'Der Wiederherstellungscode passt nicht zu diesem Raum.' : `Nicht gesichert: ${err.message}`)
      }
      t.redirect(res, '/settings?pw=on')
    })
    t.post(/^\/settings\/passphrase\/off$/, async ({ req, res }) => {
      try { await client.removePassphrase() } catch (err) { return page(req, res, 'Einstellungen', settingsMain(`Nicht ausgeschaltet: ${err.message}`), { view: 'settings' }, 422) }
      t.redirect(res, '/settings?pw=off')
    })

    // A join link opened on a device that is in a room already.
    t.get(/^\/(?:join|login)$/, ({ req, res }) => page(req, res, 'Gerät koppeln', shell('Schon in einem Raum', html`<p class="room-lead">Dieses Gerät ist schon in einem Raum. Ein weiteres Gerät koppelst du unter <a href="/devices" data-nav>Geräte</a>.</p>`)))
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
  const backLink = html`<p class="room-meta"><a href="/" id="room-home">Zurück</a></p>`
  const wireBack = () => on('#room-home', 'click', e => { e.preventDefault(); history.replaceState(null, '', '/'); welcome() })
  const busy = (form, word) => { const b = form.querySelector('button[type="submit"]'); b.disabled = true; b.textContent = word }
  const nameField = html`<label>Name dieses Geräts<input name="device_name" value="${deviceGuess()}" maxlength="40" required></label>`
  const c = await core().catch(() => ({}))

  if (location.pathname === '/join' && location.hash.length > 1) return joinFlow()
  if (location.pathname === '/login' && location.hash.length > 1 && c.loginWithPassphrase && PASSWORD_LOGIN) return passwordFlow()
  if (location.pathname === '/recover') recoverFlow()
  else welcome()

  function welcome(error = '') {
    show(shell('Trommi', html`<p class="room-lead">Fragen deiner Agenten, beantwortet von jedem Gerät. Ende-zu-Ende verschlüsselt: Der Hub trägt nur versiegelte Umschläge.</p>
${errorLine(error)}
<div class="room-ways room-ways-first">
<button type="button" class="room-way room-way-go" id="way-pair">${sk('phone')}<b>Gerät koppeln</b><span>Trommi läuft schon auf einem anderen Gerät? Dort einen QR-Code zeigen und hier scannen.</span></button>
${c.loginWithPassphrase && PASSWORD_LOGIN ? html`<button type="button" class="room-way room-way-go" id="way-password">${sk('key')}<b>Mit Passwort anmelden</b><span>Mit Raumadresse und Passwort, falls du es eingerichtet hast.</span></button>` : ''}
<button type="button" class="room-way room-way-go" id="way-found">${sk('house')}<b>Neuen Raum gründen</b><span>Zum ersten Mal hier? Dieses Gerät gründet deinen Raum.</span></button>
</div>
<p class="room-meta"><a href="/recover" id="way-recover">Alle Geräte verloren? Mit dem Wiederherstellungscode zurück</a></p>`, 'room-welcome'), null)
    on('#way-pair', 'click', () => scanFlow())
    on('#way-password', 'click', () => passwordFlow())
    on('#way-found', 'click', () => foundFlow())
    on('#way-recover', 'click', e => { e.preventDefault(); recoverFlow() })
  }

  function foundFlow(error = '') {
    show(shell('Neuen Raum gründen', html`<p class="room-lead">Dieses Gerät erzeugt die Schlüssel des Raums. Danach siehst du einmal deinen Wiederherstellungscode.</p>
${errorLine(error)}<form id="found-form" class="room-form">${nameField}
<details class="room-more"><summary>Hub und Gründungscode</summary><label>Hub<input name="hub" value="${hub}"></label><label>Gründungscode (falls der Hub einen verlangt)<input name="found_token" autocomplete="off"></label></details>
<button type="submit" class="room-primary">Raum gründen</button></form>${backLink}`), '#found-form button[type=submit]')
    wireBack()
    on('#found-form', 'submit', async e => {
      e.preventDefault()
      const f = new FormData(e.target)
      busy(e.target, 'Schlüssel werden erzeugt …')
      try {
        const hub_url = String(f.get('hub') || hub).replace(/\/+$/, '')
        write('trommi-hub', hub_url)
        const { client, recovery_code } = await c.foundRoom({ hub_url, device_name: String(f.get('device_name')), storage: await storage(), found_token: String(f.get('found_token') || '') || undefined, client: CLIENT })
        recovery(client, recovery_code)
      } catch (err) { console.error(err); foundFlow(`Der Raum wurde nicht gegründet: ${err.message}`) }
    })
  }

  // The recovery code, shown once; the room opens only after the human confirmed keeping it.
  function recovery(client, code, fresh = true) {
    show(shell('Dein Wiederherstellungscode', html`<p class="room-lead">${fresh ? 'Mit diesem Code kommst du zurück in den Raum, wenn alle Geräte weg sind.' : 'Der alte Code gilt nicht mehr. Das ist der neue.'} Er wird <b>nur jetzt</b> gezeigt. Schreib ihn auf Papier oder leg ihn in deinen Passwort-Manager.</p>
<p class="room-recovery" id="recovery-code">${code}</p>
<div class="room-actions"><button type="button" id="recovery-copy">Kopieren</button></div>
<form id="recovery-form" class="room-form"><label class="room-check"><input type="checkbox" name="kept" required> Ich habe den Code sicher aufbewahrt.</label>
${has(client, 'setPassphrase') && PASSWORD_LOGIN ? html`<details class="room-more" id="recovery-pw" data-controller="room" data-action="input->room#strength"><summary>Zusätzlich mit Passwort anmelden können (freiwillig)</summary><p class="room-meta">${TRADE_OFF}</p>${pwFields}<input type="hidden" data-room-target="go"></details>` : ''}
<button type="submit" class="room-primary">Raum öffnen</button></form>`), '#recovery-copy')
    on('#recovery-copy', 'click', async e => { try { await navigator.clipboard.writeText(code); e.target.textContent = 'Kopiert' } catch { e.target.textContent = 'Bitte abschreiben' } })
    on('#recovery-form', 'submit', async e => {
      e.preventDefault()
      const f = new FormData(e.target), p = String(f.get('passphrase') ?? '')
      if (p) {
        const why = passphraseProblem(p) ?? (p !== f.get('again') ? 'Die beiden Eingaben sind verschieden.' : null)
        const out = root.querySelector('.room-strength')
        if (why) { out.textContent = why; out.dataset.level = '1'; return }
        busy(e.target, 'Passwort wird gesichert …')
        try { await client.setPassphrase(p, { recovery_code: code }) } catch (err) { out.textContent = `Nicht gesichert: ${err.message}`; out.dataset.level = '1'; const b = e.target.querySelector('button[type="submit"]'); b.disabled = false; b.textContent = 'Raum öffnen'; return }
      }
      code = null
      done(client)
    })
  }

  // Pair: scan the other device's QR code (BarcodeDetector) or paste its link.
  async function scanFlow(error = '') {
    const { canScan, scanQr } = await import('./qr.mjs')
    const camera = await canScan()
    show(shell('Gerät koppeln', html`<ol class="room-steps"><li>Auf dem Gerät, das schon im Raum ist: Menü → Geräte → „Gerät koppeln“.</li><li>${camera ? 'Den QR-Code dort hier vor die Kamera halten.' : 'Den QR-Code dort mit der Kamera-App dieses Geräts scannen.'}</li></ol>
${camera ? html`<div class="room-scan"><video id="scan-video" muted playsinline aria-label="Kamerabild"></video></div>` : ''}
${errorLine(error)}
<form id="paste-form" class="room-form"><label>Oder den Link hier einfügen<input name="link" inputmode="url" autocomplete="off" placeholder="https://app.trommi.com/join#v1…" required></label><button type="submit">Weiter</button></form>${backLink}`), camera ? '#paste-form input' : '#paste-form input')
    wireBack()
    const go = text => {
      const at = String(text).indexOf('#v1.')
      if (at < 0) return false
      history.replaceState(null, '', `/join${String(text).slice(at)}`)
      joinFlow()
      return true
    }
    on('#paste-form', 'submit', e => { e.preventDefault(); if (!go(new FormData(e.target).get('link'))) scanFlow('Das ist kein Kopplungslink. Er enthält „#v1.“.') })
    if (camera) scanQr(root.querySelector('#scan-video'), go).then(stop => { stopScan = stop }).catch(() => root.querySelector('.room-scan')?.remove())
  }

  // Join with the link in the address: name, then show the check code to tap on the other device.
  function joinFlow(error = '') {
    show(shell('Gerät koppeln', html`<p class="room-lead">Dieses Gerät erzeugt jetzt eigene Schlüssel. Danach zeigt es eine Zahl, die du auf dem anderen Gerät antippst.</p>
${errorLine(error)}
<form id="join-form" class="room-form">${nameField}<button type="submit" class="room-primary">Weiter</button></form>`), '#join-form button')
    on('#join-form', 'submit', async e => {
      e.preventDefault()
      const link = location.href
      const name = String(new FormData(e.target).get('device_name'))
      show(shell('Gerät koppeln', html`<p class="room-wait">Fragt das andere Gerät …</p>`))
      try {
        const join = c.joinRoom({ link, device_name: name, storage: await storage(), client: CLIENT })
        history.replaceState(null, '', '/join')   // the secret leaves the address bar
        join.check_code.then(code => {
          show(shell('Gerät koppeln', html`<p class="room-lead">Tippe auf dem anderen Gerät diese Zahl an:</p><p class="room-code" id="check-code">${code6(code)}</p><p class="room-wait">Wartet, bis es dieses Gerät hinzufügt …</p>
<p class="room-meta">Dort die falsche Zahl getippt? Dann ist die Einladung verbraucht. <a href="/" id="join-cancel">Abbrechen und neu koppeln</a></p>`), null)
          on('#join-cancel', 'click', ev => { ev.preventDefault(); join.cancel(); history.replaceState(null, '', '/'); scanFlow() })
        })
        await done(await join.client)
      } catch (err) {
        if (err.code === 'cancelled') return
        console.error(err)
        const why = { 'invite-used': 'Die Einladung wurde schon benutzt.', 'invite-expired': 'Die Einladung ist abgelaufen.' }[err.code] ?? err.message
        show(shell('Gerät koppeln', html`<p class="room-error" role="alert">Nicht gekoppelt: ${why}</p><p class="room-lead">Lass dir auf dem anderen Gerät einen neuen Code zeigen.</p><button type="button" class="room-primary" id="scan-again">Neu scannen</button>${backLink}`), '#scan-again')
        on('#scan-again', 'click', () => scanFlow()); wireBack()
      }
    })
  }

  // The room address from a link in the address bar (/login#r1… or /recover#r1…), if there is one.
  const addressInBar = () => (location.hash.startsWith('#r1.') ? location.href : '')
  const parseAddress = text => { if (!c.parseRoomLink) throw new Error('diese Version kennt keine Raumadressen'); return c.parseRoomLink(String(text).trim()) }

  function passwordFlow(error = '') {
    show(shell('Mit Passwort anmelden', html`${errorLine(error)}<form id="pw-form" class="room-form">
<label>Raumadresse<input name="room_link" value="${addressInBar()}" required autocomplete="off" inputmode="url" placeholder="https://app.trommi.com/login#r1…"></label>
<label>Passwort<input type="password" name="passphrase" required autocomplete="current-password"></label>${nameField}
<button type="submit" class="room-primary">Anmelden</button></form>
<p class="room-meta">Die Raumadresse steht auf einem Gerät im Raum unter Einstellungen.</p>${backLink}`), addressInBar() ? 'input[name=passphrase]' : 'input')
    wireBack()
    on('#pw-form', 'submit', async e => {
      e.preventDefault()
      const f = new FormData(e.target)
      busy(e.target, 'Prüft … (ein paar Sekunden)')
      try {
        const { client } = await c.loginWithPassphrase({ room_link: String(f.get('room_link')).trim(), passphrase: String(f.get('passphrase')), device_name: String(f.get('device_name')), storage: await storage(), client: CLIENT })
        await done(client)
      } catch (err) { console.error(err); passwordFlow(err.code === 'bad-passphrase' || err.code === 'wrong-passphrase' ? 'Passwort oder Raumadresse stimmt nicht.' : `Nicht angemeldet: ${err.message}`) }
    })
  }

  function recoverFlow(error = '') {
    history.replaceState(null, '', `/recover${location.hash.startsWith('#r1.') ? location.hash : ''}`)
    show(shell('Wiederherstellen', html`<p class="room-lead">Mit dem Wiederherstellungscode kommst du zurück, wenn kein Gerät mehr im Raum ist. Alle bisherigen Geräte werden entfernt, die Agenten bleiben, und du bekommst einen neuen Code.</p>
${errorLine(error)}<form id="recover-form" class="room-form">
<label>Raumadresse<input name="room_link" value="${addressInBar()}" required autocomplete="off" inputmode="url"></label>
<label>Wiederherstellungscode<input name="code" required autocomplete="off" spellcheck="false" class="room-mono"></label>${nameField}
<button type="submit" class="room-primary">Wiederherstellen</button></form>${backLink}`))
    wireBack()
    on('#recover-form', 'submit', async e => {
      e.preventDefault()
      const f = new FormData(e.target)
      busy(e.target, 'Stellt wieder her …')
      try {
        const { hub_url, room_id } = parseAddress(f.get('room_link'))
        const { client, recovery_code } = await c.recoverRoom({ hub_url, room_id, code: String(f.get('code')).trim(), device_name: String(f.get('device_name')), storage: await storage(), client: CLIENT })
        recovery(client, recovery_code, false)
      } catch (err) { console.error(err); recoverFlow(err.code === 'bad-recovery-code' ? 'Der Code passt nicht zu diesem Raum.' : `Nicht wiederhergestellt: ${err.message}`) }
    })
  }
}
export { ago, raw }
