// Settings · Sessions (<base>/settings/sessions): every session, grouped by desk, and the forms that change a session.
// The markup is the one agents.css styles (a list as in iOS Settings).
//   - a desk is a group, folded by default: its drawing, its name, how many sessions; a tap unfolds it (which desks
//     are open is kept for the tab: controller "set-desks"). The crowned session stands first, a main's helpers under it.
//   - a line: mark (Change Icon…), crown (Make Main Session), name (Rename…), state, and "…" with the rest in Apple's
//     words: Open, Rename…, Change Icon…, Make Main Session, Move to Desk…, Move Up/Down, Archive, Delete…
//     (a menu at the "…" on a wide screen, a sheet at the lower edge on a phone)
//   - the field at the top finds as you type (controller "set-find"; without script the GET form does it)
//   - every change is a form to <base>/sessions/<id>/…, handed to the hub's own rules (t.hub.editSession,
//     t.hub.starSession); what the hub refuses is said under the line, quietly
//   - live: a line that changed is replaced; when lines come, go or change desks the page fetches itself anew
//   - hooks for the keys: a line is .ledger-line[data-id][data-state], id="ledger-<id>"; its controls carry
//     data-ledger="rename|mark|crown|more"; a.ledger-open opens the session
import { Controller, LATER, agoSpan, answerFields, avatar, badge, controller, crownSvg, html, markControl, marksFrame, marksHolder, raw, renameControl, sessionForms, settingsPage, sk, sayError } from './ui.mjs'
const STAY = { stay: true }
const lineId = id => `ledger-${id}`

// Sessions that share a name get a second line that tells them apart: the folder, else the machine, else since when.
function tellApart(agents) {
  const lines = new Map(), byName = new Map()
  for (const a of agents) byName.set(a.name, [...(byName.get(a.name) ?? []), a])
  const folder = a => (a.cwd ? a.cwd.split('/').filter(Boolean).slice(-2).join('/') : '')
  const since = a => {
    const ts = a.online ? a.connected ?? a.joined : a.seen ?? a.joined
    return ts ? `${a.online ? 'since' : 'last seen'} ${new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : ''
  }
  for (const twins of byName.values()) {
    if (twins.length < 2) continue
    const differs = fn => new Set(twins.map(fn)).size === twins.length && twins.every(a => fn(a))
    const pick = [folder, a => a.host ?? '', since].find(differs) ?? (a => a.id)
    for (const a of twins) lines.set(a.id, pick(a))
  }
  return lines
}

/** What every line needs, worked out once per render. */
function around(m, base) {
  const desks = m.state.desks ?? []
  const groups = new Map()
  for (const a of m.agents) if (a.group) groups.set(a.group, [...(groups.get(a.group) ?? []), a])
  for (const [id, members] of groups) if (members.length < 2) groups.delete(id)
  return { m, base, desks, groups, apart: tellApart(m.agents), unitOf: new Map(m.units.map(u => [u.id, u])) }
}

// hand: the session is stopped (u.blocked, app.mjs blockedOf): that comes first, also for one that is disconnected.
const stateWord = (u, hand) => (hand ? 'stopped' : !u.online ? 'away' : u.running ? 'working' : u.open ? 'asking' : 'idle')
const post = (action, fields, button) => html`<form method="post" action="${action}">${answerFields(STAY)}${fields}${button}</form>`

// What a <details> of a line holds is put in only when it opens (controller "later"): a page of many sessions
// would otherwise carry every session's name in every line's lists.
const later = inner => html`<template>${inner}</template>`

/** "…" of one line: everything that can be done with the session, in Apple's words. */
function moreMenu(u, ctx, { group }) {
  const a = u.agent, { base, m, desks } = ctx, forms = sessionForms(a, base)
  const item = (action, name, value, words, cls = '') => post(action, '', html`<button class="ledger-sheet-item${cls}" type="submit" name="${name}" value="${value}">${words}</button>`)
  const sub = (words, inner, cls = '') => html`<details class="set-sub${cls}"${LATER}><summary class="ledger-sheet-item">${words}</summary>${inner}</details>`
  return html`<details class="t-pick ledger-dots"${LATER}><summary class="ledger-ib ledger-menu" data-ledger="more" title="More: ${a.name}" aria-label="More for ${a.name}: Rename, Change Icon, Make Main Session, Move to Desk, Archive, Delete">…</summary>
${later(html`<div class="ledger-sheet t-sheet set-menu" role="group" aria-label="Actions for ${a.name}"><h3>${a.name}</h3>
<a class="ledger-sheet-item" data-nav href="${base}/s/${encodeURIComponent(a.id)}">Open</a>
${sub('Rename…', post(`${forms}/edit`, html`<input type="text" name="label" value="${a.name}" maxlength="60" autocomplete="off" enterkeyhint="done" aria-label="Name of the session">`, html`<button class="set-sub-go" type="submit">Rename</button>`))}
${sub('Change Icon…', marksHolder(a, base, { stay: true, where: 's' }), ' t-sheet-marks')}
${item(`${forms}/star`, 'starred', a.starred ? '0' : '1', a.starred ? 'Remove as Main Session' : 'Make Main Session')}
${desks.length > 1 ? sub('Move to Desk…', html`<div class="set-sub-list">${desks.filter(d => d.id !== a.desk).map(d => item(`${forms}/edit`, 'desk', d.id, d.name || 'Desk'))}</div>`) : ''}
${a.parent ? item(`${forms}/edit`, 'parent', '', `Detach from ${m.byAgent.get(a.parent)?.name ?? a.parent}`) : ''}
${group ? item(`${forms}/unpair`, 'out', '1', 'Remove from Group') : ''}
${item(`${forms}/move`, 'dir', 'up', 'Move Up')}${item(`${forms}/move`, 'dir', 'down', 'Move Down')}
${a.parent ? '' : html`<form method="post" action="/pair"><input type="hidden" name="role" value="agent"><input type="hidden" name="continue" value="${a.device_id}"><button class="ledger-sheet-item" type="submit">Copy Invite Link</button></form>`}
${!a.online ? item(`${forms}/edit`, 'archived', '1', 'Archive') : ''}
${a.own ? '' : sub('Delete…', html`<form class="session-delete-ask set-sub-ask" method="post" action="${base}/sessions/${encodeURIComponent(a.id)}/delete"><input type="hidden" name="stay" value="1"><p><b>Delete ${a.name}?</b> Its connector is removed from the room and ${u.subs ? 'the session with its helpers moves' : 'the session moves'} to the archive. Open questions are shredded.</p><button type="submit" class="session-delete-yes">${sk('bin')}<span>Delete</span></button></form>`, ' is-danger')}
<button class="ledger-sheet-item is-close" type="button" data-pop-close>Done</button></div>`)}</details>`
}

/** One session's line. error: what the hub refused, said under the line. */
function ledgerLine(u, ctx, { error = '' } = {}) {
  const a = u.agent, { m, base, groups, apart } = ctx, forms = sessionForms(a, base), to = `${base}/s/${encodeURIComponent(a.id)}`
  const hand = Boolean(u.blocked), word = stateWord(u, hand)
  const group = groups.get(a.group), others = group ? group.filter(x => x.id !== a.id).map(x => x.name).join(' + ') : ''
  const ring = badge(u, u, base)
  const card = m.fresh.find(c => c.agent === a.id), task = !card && a.online ? a.task : ''
  // the small line under the name: what tells it apart, the machine, the model, when it was seen
  const about = [apart.get(a.id), others && `with ${others}`, a.host, a.model].filter(Boolean)
  const seen = a.online ? '' : agoSpan(a.seen ?? a.joined ?? Date.now(), 'ledger-ago')
  const state = html`<span class="ledger-state"${hand ? html` title="Stopped: ${u.blocked.text}"` : ''}>${ring}<span class="ledger-word">${word === 'asking' ? 'asks' : word}</span>${hand ? html`<span class="offscreen">: ${u.blocked.text}</span>` : ''}</span>`
  // The crown: one per desk, given by his hand (the hub takes it from whoever wore it on this desk).
  const star = post(`${forms}/star`, '', html`<button class="crown-toggle ledger-crown" data-ledger="crown" type="submit" name="starred" value="${a.starred ? '0' : '1'}" aria-pressed="${String(Boolean(a.starred))}" title="${a.starred ? 'Main Session of its desk. Click: Remove as Main Session' : 'Make Main Session'}" aria-label="${a.name}: ${a.starred ? 'Main Session of its desk, remove' : 'Make Main Session; quick notes go to it, its questions come first'}">${raw(crownSvg())}</button>`)
  const cls = ['ledger-line', u.parent && 'is-sub', (a.main || u.subs) && 'is-main'].filter(Boolean).join(' ')
  const find = [a.name, a.given, a.host, a.model, a.task, a.cwd].filter(Boolean).join(' ').toLowerCase()
  return html`<div class="${cls}" id="${lineId(a.id)}" data-id="${a.id}" data-state="${word}" data-find="${find}">
<span class="ledger-face">${markControl(a, base, STAY)}${star}</span>
<span class="ledger-name">${renameControl(a, base, STAY)}<small>${about.join(' · ')}${about.length && seen ? ' · ' : ''}${seen}${task ? html`${about.length || seen ? ' · ' : ''}${task}` : ''}${card ? html`${about.length || seen ? ' · ' : ''}asks: ${card.title}` : ''}</small></span>
${state}
<span class="ledger-acts">${moreMenu(u, ctx, { group })}</span>
<a class="ledger-open" data-nav href="${to}" tabindex="-1" aria-hidden="true"></a>
${error ? html`<p class="ledger-err" role="alert">${error}</p>` : ''}
</div>`
}

/** A session that was put away. */
function archivedLine(a, ctx, { error = '' } = {}) {
  return html`<div class="ledger-line is-archived" id="${lineId(a.id)}" data-id="${a.id}" data-find="${[a.name, a.host, a.model].filter(Boolean).join(' ').toLowerCase()}">
<span class="ledger-face">${avatar(a, { crown: false })}</span><span class="ledger-name"><strong>${a.name}</strong><small>${[a.host, a.model].filter(Boolean).join(' · ')}${a.host || a.model ? ' · ' : ''}${agoSpan(a.seen ?? a.joined ?? Date.now(), 'ledger-ago')}</small></span>
<span class="ledger-state"></span>
<span class="ledger-acts">${post(`${sessionForms(a, ctx.base)}/edit`, '', html`<button class="set-pill" data-ledger="fetch" type="submit" name="archived" value="0">Fetch Back</button>`)}</span>
${error ? html`<p class="ledger-err" role="alert">${error}</p>` : ''}
</div>`
}

// The lines in the board's own order: a main, then its subs; whoever is connected (or has a sub that is) first.
function parts(m) {
  const top = m.units.filter(u => !u.parent)
  const family = u => [u, ...(u.subs ?? [])]
  const live = u => u.online || Boolean(u.subs?.some(s => s.online))
  return { on: top.filter(live).flatMap(family), off: top.filter(u => !live(u)).flatMap(family), archived: m.everyone.filter(a => a.archived) }
}
const leadWords = m => `${m.agents.filter(a => a.online).length} of ${m.agents.length} sessions are connected.`
const DESK_KEY = 'trommi-settings-desks'

/** The whole page. find: words to look for (then every desk with a match stands open); errors: session id -> what was refused. */
function sessionsMain(m, base, { find = '', errors = new Map() } = {}) {
  const ctx = around(m, base)
  let { on, off, archived } = parts(m)
  const words = find.trim().toLowerCase()
  const found = u => !words || [u.agent.name, u.agent.given, u.agent.host, u.agent.model, u.agent.task, u.agent.cwd].filter(Boolean).join(' ').toLowerCase().includes(words)
  on = on.filter(found); off = off.filter(found)
  const line = u => ledgerLine(u, ctx, { error: errors.get(u.id) })
  const shown = new Set([...on, ...off])
  const deskList = ctx.desks.length ? ctx.desks : [{ id: null, name: m.deskName || 'Desk' }]
  const deskOf = u => (ctx.desks.some(d => d.id === u.agent.desk) ? u.agent.desk : deskList[0].id)
  // (the crowned session of a desk first, then the board's own order: connected trees first)
  const tops = [...on, ...off].filter(u => !u.parent).sort((x, y) => Number(Boolean(y.agent.starred)) - Number(Boolean(x.agent.starred)))
  const treeOf = u => html`<div class="ledger-tree">${line(u)}${u.subs?.some(s => shown.has(s)) ? html`<div class="ledger-kids">${u.subs.filter(s => shown.has(s)).map(line)}</div>` : ''}</div>`
  const loose = [...on, ...off].filter(u => u.parent && !shown.has(u.parent))
  const group = (key, mark, name, count, inner) => html`<details class="set-desk" data-desk="${key}"${words ? raw(' open') : ''}><summary class="set-desk-head"><span class="set-desk-mark">${mark}</span><b>${name}</b><span class="set-desk-n">${count}</span>${sk('unfold')}</summary><div class="set-desk-body">${inner}</div></details>`
  const desks = deskList.map(d => {
    const mine = tops.filter(u => deskOf(u) === d.id), kids = loose.filter(u => deskOf(u) === d.id)
    const n = mine.reduce((k, u) => k + 1 + (u.subs?.filter(s => shown.has(s)).length ?? 0), 0) + kids.length
    return n ? group(d.id ?? 'desk', sk('desk'), d.name || 'Desk', n, html`${mine.map(treeOf)}${kids.map(line)}`) : ''
  })
  const shownArchived = archived.filter(a => !words || [a.name, a.host, a.model].filter(Boolean).join(' ').toLowerCase().includes(words))
  return settingsPage('Sessions', html`
<form class="ledger-tools" method="get" action="${base}/settings/sessions" role="search" data-controller="set-find"><label class="ledger-find">${sk('search')}<input type="search" name="find" value="${find}" autocomplete="off" placeholder="Search" aria-label="Find a session, a machine, a model" data-action="input->set-find#find"><kbd>/</kbd></label></form>
<p class="set-lead" id="ledger-lead">${leadWords(m)}</p>
<div class="ledger set-desks" id="ledger-list" data-controller="pops set-desks"${words ? raw(' data-found') : ''}>
${desks}
${shownArchived.length ? group('archive', sk('archive'), 'Archive', shownArchived.length, shownArchived.map(a => archivedLine(a, ctx, { error: errors.get(a.id) }))) : ''}
${!shown.size && !shownArchived.length && m.agents.length ? html`<p class="ledger-none">No session fits. <a class="ledger-link" data-nav href="${base}/settings/sessions">Show all</a></p>` : ''}
${!m.agents.length && !archived.length ? raw('<p class="ledger-none">No session is connected yet.</p>') : ''}
<p class="ledger-none" data-set-find-none hidden>No session fits.</p>
</div>`, { id: 'ledger', cls: 'ledger-root' })
}

// Which desks stand open: kept for the tab, so the live stream's fresh page and a way back keep them.
controller('set-desks', class extends Controller {
  connect() {
    if (!this.element.hasAttribute('data-found')) {
      let open = []
      try { open = JSON.parse(sessionStorage.getItem(DESK_KEY) || '[]') } catch {}
      for (const d of this.element.querySelectorAll(':scope > details.set-desk')) if (open.includes(d.dataset.desk)) d.open = true
    }
    this.onToggle = e => {
      if (!e.target.matches?.('details.set-desk') || this.element.hasAttribute('data-found') || this.element.hasAttribute('data-finding')) return
      try { sessionStorage.setItem(DESK_KEY, JSON.stringify([...this.element.querySelectorAll(':scope > details.set-desk[open]')].map(d => d.dataset.desk))) } catch {}
    }
    this.element.addEventListener('toggle', this.onToggle, true)
  }
  disconnect() { this.element.removeEventListener('toggle', this.onToggle, true) }
})
// Finds as you type: lines that do not fit step aside, a desk with a line that fits opens; an empty field gives the
// folded list back. (Enter sends the GET form: the same, rendered.)
controller('set-find', class extends Controller {
  find(e) {
    const words = e.target.value.trim().toLowerCase(), list = document.getElementById('ledger-list')
    if (!list) return
    let any = false
    if (words) list.dataset.finding = ''; else delete list.dataset.finding
    for (const d of list.querySelectorAll(':scope > details.set-desk')) {
      if (!d.dataset.was) d.dataset.was = d.open ? '1' : '0'
      let hits = 0
      for (const l of d.querySelectorAll('.ledger-line[data-id]')) { const fits = !words || (l.dataset.find ?? '').includes(words); l.hidden = !fits; if (fits) hits++ }
      for (const t of d.querySelectorAll('.ledger-tree')) t.hidden = Boolean(words) && ![...t.querySelectorAll('.ledger-line')].some(l => !l.hidden)
      d.hidden = Boolean(words) && !hits
      d.open = words ? hits > 0 : d.dataset.was === '1'
      if (!words) delete d.dataset.was
      any ||= hits > 0
    }
    const none = list.querySelector('[data-set-find-none]')
    if (none) none.hidden = !words || any
  }
})

export function register(t) {
  const { BASE, hub } = t
  const show = (req, res, url, errors, code = 200) => {
    const m = t.model()
    t.page(req, res, { model: m, title: 'Sessions · Settings · Trommi', view: 'agents', css: 'agents', bodyAttrs: ' data-page="roster"', main: sessionsMain(m, BASE, { find: url.searchParams.get('find') ?? '', errors }) }, code)
  }
  t.get(/^\/settings\/sessions$/, ({ req, res, url }) => show(req, res, url))
  t.get(/^\/settings\/agents$/, ({ res }) => t.redirect(res, `${BASE}/settings/sessions`))
  // The drawings of one session's picker: a frame, fetched when the picker is opened.
  t.get(/^\/sessions\/([^/]+)\/marks$/, ({ req, res, url, match }) => {
    const a = t.model().byAgent.get(decodeURIComponent(match[1]))
    if (!a) return t.notFound(req, res, 'This session is not on the board any more.')
    const q = url.searchParams
    t.page(req, res, { title: `Drawing of ${a.name} · Trommi`, view: 'marks', sidebar: false, stream: null, css: 'agents', main: html`<main class="mark-picker t-marks-page">${marksFrame(a, BASE, { stay: q.has('stay'), back: backOf(q.get('back')), where: q.get('in') === 's' ? 's' : '' })}</main>` })
  })

  // Only a path of this board is a page to go back to.
  const backOf = path => (typeof path === 'string' && (BASE ? path.startsWith(`${BASE}/`) : /^\/(?!\/)/.test(path)) && !/[\\\r\n]/.test(path) ? path : '')
  // Sessions laid together share a group (the hub stores the name of the group on each).
  const groupOf = (agents, a) => (a.group ? agents.filter(x => x.group === a.group) : [])
  const WAYS = {
    /** label, icon, desk, parent, archived: whichever the form names; the hub's own rules decide. */
    edit(id, form, m) {
      const body = { agent: id }
      // A name that is the one the session gave itself is no name of the human's.
      if (form.has('label')) { const label = form.get('label').trim(); body.label = label === m.byAgent.get(id)?.given ? '' : label }
      if (form.has('icon')) body.icon = form.get('icon')
      if (form.has('desk')) body.desk = form.get('desk')
      if (form.has('parent')) body.parent = form.get('parent') || null
      if (form.has('archived')) body.archived = form.get('archived') === '1'
      return hub.editSession(body)
    },
    /** One place up or down among its own kind: the mains and lone sessions of its part (connected or not), or the subs of its main. */
    move(id, form, m) {
      const u = m.units.find(x => x.id === id)
      if (!u) throw new Error(`no agent ${id}`)
      const live = x => x.online || Boolean(x.subs?.some(s => s.online))
      const among = u.parent ? u.parent.subs : m.units.filter(x => !x.parent && live(x) === live(u))
      const at = among.indexOf(u), down = form.get('dir') === 'down'
      if (down ? at >= among.length - 1 : at <= 0) return
      // (The hub's own order: directly before another session, or last.)
      return hub.editSession({ agent: id, before: down ? among[at + 2]?.id ?? null : among[at - 1].id })
    },
    star: (id, form) => hub.starSession({ agent: id, starred: form.get('starred') === '1' }),
    /** Lay this session together with another (or with the group the other is in). */
    async pair(id, form) {
      const agents = hub.state().agents, a = agents.find(x => x.id === id), b = agents.find(x => x.id === form.get('with'))
      if (!a || !b) throw new Error('no such session')
      if (a === b || (a.group && a.group === b.group)) return
      // Whoever the session leaves behind alone is on its own again.
      const left = groupOf(agents, a).filter(x => x !== a)
      if (left.length === 1) await hub.editSession({ agent: left[0].id, group: null })
      const group = (groupOf(agents, b).length > 1 && b.group) || `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      await hub.editSession({ agent: b.id, group })
      await hub.editSession({ agent: a.id, group })
    },
    /** Take this session out of its group; a group of two is none any more. */
    unpair(id) {
      const agents = hub.state().agents, a = agents.find(x => x.id === id)
      if (!a) throw new Error(`no agent ${id}`)
      const group = groupOf(agents, a)
      return Promise.all((group.length <= 2 ? group : [a]).map(x => hub.editSession({ agent: x.id, group: null })))
    },
  }
  const nameOf = (m, id) => m.byAgent.get(id)?.name ?? m.everyone?.find(a => a.id === id)?.name ?? id   // (an archived session is among everyone only)
  t.post(/^\/sessions\/([^/]+)\/(edit|star|pair|unpair|move)$/, async ({ req, res, url, match, form }) => {
    const id = decodeURIComponent(match[1]), stay = form.has('stay') && t.wantsStream(req)
    let error = ''
    const was = t.model().byAgent.get(id)?.desk ?? null   // (for the Undo of a move to another desk)
    try { await WAYS[match[2]](id, form, t.model()) } catch (err) { error = `Not saved: ${sayError(err, 'the board did not take it')}` }
    if (!error) {
      // The live stream brings the change to every page, this one too; the form itself adds only the toast of an archiving.
      if (stay && match[2] === 'edit' && form.has('moved') && form.has('desk')) {
        const to = (t.model().state.desks ?? []).find(d => d.id === form.get('desk'))
        // (from the session's own page: on to the Desk, the session is not on this desk any more; an Undo stays where it is)
        const on = form.has('leave') ? t.stream('visit', `${BASE}/`) : ''
        return t.sendStream(req, res, html`${on}${t.toast({ head: `Moved to ${to?.name || 'Desk'}`, line: nameOf(t.model(), id).replace(/ · [^·]*$/, ''), undo: was ? { action: `${sessionForms({ id }, BASE)}/edit`, fields: { desk: was, moved: '1' } } : null })}`)
      }
      if (stay) return t.sendStream(req, res, match[2] === 'edit' && form.get('archived') === '1' && !form.has('quiet') ? t.toast({ head: 'Archived', line: nameOf(t.model(), id), undo: { action: `${sessionForms({ id }, BASE)}/edit`, fields: { archived: '0' } } }) : '')
      return t.redirect(res, backOf(form.get('back')) || `${BASE}/settings/sessions`)
    }
    if (stay) {
      const line = lineNow(t.model(), BASE, id, error)
      return t.sendStream(req, res, line ? t.stream('replace', lineId(id), line) : t.stream('refresh'))
    }
    // Not taken: the page again, with what went wrong in the line (422: Turbo shows it in place).
    show(req, res, url, new Map([[id, error]]), 422)
  })

  // Delete a session (its More menu): what the app can already do, one after the other. Its open questions are shredded
  // (as Shred), it and its helpers go to the archive (as Archive), and the agent devices that carried only them are
  // removed from the room (as Remove under Devices). A session on a person's own device is never deleted this way.
  t.post(/^\/sessions\/([^/]+)\/delete$/, async ({ req, res, match }) => {
    const m = t.model(), id = decodeURIComponent(match[1]), a = m.byAgent.get(id)
    const fail = text => (t.wantsStream(req) ? t.sendStream(req, res, t.toast({ head: 'Not deleted', line: text, role: 'alert' })) : t.redirect(res, `${BASE}/s/${encodeURIComponent(id)}`))
    if (!a) return fail('no such session')
    if (a.own) return fail('this session runs on your own device')
    const all = [a, ...m.agents.filter(x => x.parent === a.id)], ids = new Set(all.map(x => x.id))
    const client = hub.client, members = client?.model?.members
    const me = client?.model?.room?.my_device_id
    try {
      for (const c of m.state.cards) if (ids.has(c.agent) && c.status === 'open' && c.kind !== 'permission') await hub.shred(c.id, '')
      for (const x of all) await hub.editSession({ agent: x.id, archived: true, deleting: true })
      // (a device that also carries a session that stays is left in the room)
      const devices = [...new Set(all.map(x => x.agent_device_id).filter(Boolean))].filter(d => d !== me && members?.get(d)?.device_role !== 'human' && !m.agents.some(x => !ids.has(x.id) && x.agent_device_id === d))
      if (devices.length) await client.removeDevices(devices)
    } catch (err) { return fail(sayError(err, 'the board did not take it')) }
    if (!t.wantsStream(req)) return t.redirect(res, `${BASE}/`)
    return t.sendStream(req, res, html`${t.stream('visit', `${BASE}/`)}${t.toast({ head: 'Deleted', line: a.name })}`)
  })

  t.live('agents', {
    take(m) {
      const ctx = around(m, BASE), { on, off, archived } = parts(m)
      return {
        // Which lines stand where; when that changes, the page fetches itself anew (it keeps its own sorting and finding).
        shape: JSON.stringify([on.map(u => `${u.id}:${u.agent.desk}:${Boolean(u.agent.starred)}`), off.map(u => `${u.id}:${u.agent.desk}`), archived.map(a => a.id), ctx.desks.map(d => `${d.id}:${d.name}`)]),
        lead: leadWords(m),
        rows: new Map([...m.units.map(u => [u.id, ledgerLine(u, ctx)]), ...archived.map(a => [a.id, archivedLine(a, ctx)])]),
      }
    },
    diff(was, now) {
      if (was.shape !== now.shape) return String(t.stream('refresh'))
      const out = was.lead !== now.lead ? [t.stream('update', 'ledger-lead', now.lead)] : []
      for (const [id, row] of now.rows) if (t.differs(was.rows.get(id), row)) out.push(t.stream('replace', lineId(id), row))
      return out.join('')
    },
  })
}
