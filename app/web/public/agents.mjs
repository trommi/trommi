// The Agents page (<base>/agents): the ledger of all sessions, one line each, and the forms that change a
// session. The markup is the one agents.css styles.
//   - a line: mark (opens the drawings; the crown at its corner gives or takes the desk's one crown), name (renames), state,
//     what it asks (a link to the card's own page) or does, model, machine, last seen, and what can be done with it
//   - a main stands with its subs under it; disconnected sessions and the archive are groups of their own
//   - the head of a column sorts (a link), the field finds (a GET form); in his own order a line moves up or down (two small forms)
//   - every change is a form to <base>/sessions/<id>/…, handed to the hub's own rules (t.hub.editSession,
//     t.hub.starSession); what the hub refuses is said in the line, quietly
//   - live: a line that changed is replaced; when lines come, go or change places (also in the column the page is
//     sorted by) the page fetches itself anew
//   - hooks for the keys: a line is .ledger-line[data-id][data-state], id="ledger-<id>"; its controls carry
//     data-ledger="rename|mark|crown|main|desk|open|walk|question|pair|unpair|archive|fetch|up|down|more"
// On a phone a line is mark, name, state and "…": a tap opens the session, "…" a sheet at the lower edge.
import { BASE } from './app.mjs'
import { LATER, agoSpan, answerFields, avatar, badge, cardPath, crownSvg, html, markControl, marksFrame, marksHolder, raw, renameControl, roomTabs, sessionForms, sk } from './ui.mjs'
const RANK = { critical: 3, high: 2, normal: 1, low: 0 }
const SEP = raw('<i class="ledger-sep"> · </i>')
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
  // Whose sub a session may become: a session of its desk that is no sub itself. One level (the hub checks the rest).
  const mainsFor = u => (u.subs ? [] : m.agents.filter(x => x.id !== u.id && !x.parent && (desks.length < 2 || x.desk === u.agent.desk)))
  const doing = new Map()
  for (const t of m.state.tasks ?? []) if (t.state === 'working' && !doing.has(t.agent)) doing.set(t.agent, t)
  return { m, base, desks, groups, mainsFor, doing, apart: tellApart(m.agents), unitOf: new Map(m.units.map(u => [u.id, u])) }
}

// hand: the session is stopped (u.blocked, server/blocked.mjs): that comes first, also for one that is disconnected.
const stateWord = (u, hand) => (hand ? 'stopped' : !u.online ? 'away' : u.running ? 'working' : u.open ? 'asking' : 'idle')
const post = (action, fields, button) => html`<form method="post" action="${action}">${answerFields(STAY)}${fields}${button}</form>`

// What a <details> of a line holds is put in only when it opens (controller "later"): a page of many sessions
// would otherwise carry every session's name in every line's lists.
const later = inner => html`<template>${inner}</template>`

// A choice that drops down from a small control: its options are the buttons of one form.
function pick({ cls, hook, mark = '', title, label, action, name, options, set = false }) {
  return html`<details class="t-pick ledger-pick"${LATER}><summary class="${cls}" data-ledger="${hook}" title="${title}" aria-label="${title}"${set ? raw(' data-set') : ''}>${mark}<span>${label}</span></summary>
<form class="t-pop t-menu" method="post" action="${action}">${answerFields(STAY)}${later(options.map(o => html`<button type="submit" name="${name}" value="${o.value}"${o.current ? raw(' aria-current="true"') : ''}>${o.label}</button>`))}</form></details>`
}

// The phone's sheet for one line: everything the wide line offers beside it. No veil: it lies at the lower edge.
function sheet(u, ctx, { group, others }) {
  const a = u.agent, { base, m, desks } = ctx, forms = sessionForms(a, base)
  const item = (action, name, value, words) => post(action, '', html`<button class="ledger-sheet-item" type="submit" name="${name}" value="${value}">${words}</button>`)
  return html`<details class="t-pick ledger-dots"${LATER}><summary class="ledger-ib ledger-menu" data-ledger="more" title="More: ${a.name}" aria-label="More for ${a.name}: rename, drawing, crown, group, archive">…</summary>
${later(html`<div class="ledger-sheet t-sheet" role="group" aria-label="Actions for ${a.name}"><h3>${a.name}</h3>
<a class="ledger-sheet-item" data-nav href="${base}/s/${encodeURIComponent(a.id)}">Open the conversation</a>
${post(`${forms}/edit`, html`<input type="text" name="label" value="${a.name}" maxlength="60" autocomplete="off" enterkeyhint="done" aria-label="Name of the session">`, html`<button class="ledger-sheet-item" type="submit">Rename</button>`)}
<details class="t-sheet-marks"${LATER}><summary class="ledger-sheet-item">Choose a drawing</summary>${marksHolder(a, base, { stay: true, where: 's' })}</details>
${item(`${forms}/star`, 'starred', a.starred ? '0' : '1', a.starred ? 'Take the crown off' : 'Give the crown')}
${a.parent ? item(`${forms}/edit`, 'parent', '', `Stand alone (leave main agent ${m.byAgent.get(a.parent)?.name ?? a.parent})`) : ''}
${group ? item(`${forms}/unpair`, 'out', '1', `Take out of the group with ${others}`) : ''}
${item(`${forms}/move`, 'dir', 'up', 'Move up')}${item(`${forms}/move`, 'dir', 'down', 'Move down')}
${!a.online ? item(`${forms}/edit`, 'archived', '1', 'Archive') : ''}
${desks.length > 1 ? desks.filter(d => d.id !== a.desk).map(d => item(`${forms}/edit`, 'desk', d.id, `Move to desk ${d.name}`)) : ''}
<button class="ledger-sheet-item is-close" type="button" data-pop-close>Close</button></div>`)}</details>`
}

/** One session's line. error: what the hub refused, said under the line. */
function ledgerLine(u, ctx, { error = '' } = {}) {
  const a = u.agent, { m, base, desks, groups, apart } = ctx, forms = sessionForms(a, base), to = `${base}/s/${encodeURIComponent(a.id)}`
  const cards = m.fresh.filter(c => c.agent === a.id)
  const hand = Boolean(u.blocked), word = stateWord(u, hand)
  const top = cards.length ? Math.max(...cards.map(c => RANK[c.urgency] ?? 1)) : -1
  const group = groups.get(a.group), others = group ? group.filter(x => x.id !== a.id).map(x => x.name).join(' + ') : ''
  const mains = ctx.mainsFor(u), main = a.parent ? m.byAgent.get(a.parent) : null
  const ring = badge(u, u, base)

  // Stopped: the hand and the word; why it stopped is the cell's tooltip (the column is narrow: the words would run into the next one).
  const state = html`<span class="ledger-state"${hand ? html` title="Stopped: ${u.blocked.text}"` : ''}>${ring}${ring && !hand && u.open ? SEP : ''}<span class="ledger-word">${word === 'asking' ? 'asks' : word}</span>${hand ? html`<span class="offscreen">: ${u.blocked.text}</span>${u.open ? html`${SEP}<b>${u.open}</b>` : ''}` : ''}</span>`
  // What it asks (its first question: a link to the card's own page) or what it does (its status line, else what it named).
  const card = cards[0], task = ctx.doing.get(a.id)
  const doing = task ? [task.label, task.detail].filter(Boolean).join(': ') : a.task || (a.online ? 'nothing named' : '')
  const does = card
    ? html`<a class="ledger-q" data-ledger="question" data-nav href="${cardPath(card, base)}" title="${card.title}: open the question">${card.title}</a>${cards.length > 1 ? html`<a class="ledger-more" data-nav href="${to}" title="Its ${cards.length} questions">+${cards.length - 1}</a>` : ''}<a class="ledger-ans is-lead is-choose" data-nav href="${cardPath(card, base)}">Choose</a>`
    : html`<span class="ledger-task" title="${doing}">${doing}</span>`

  const chip = group ? html`<span class="ledger-with" title="with ${others}"><span class="ledger-with-names">with ${others}</span>${post(`${forms}/unpair`, '', html`<button type="submit" data-ledger="unpair" title="Take ${a.name} out" aria-label="Take ${a.name} out of its group with ${others}">${sk('snip')}</button>`)}</span>` : ''
  const together = !group && m.agents.length > 1
    ? html`<details class="t-pick ledger-pick"${LATER}><summary class="ledger-ib" data-ledger="pair" title="Lay together with…" aria-label="${a.name}: lay together with…">${sk('heads')}</summary>
<form class="t-pop t-menu" method="post" action="${forms}/pair">${answerFields(STAY)}${later(m.agents.filter(x => x.id !== a.id).map(x => html`<button type="submit" name="with" value="${x.id}">${x.name}</button>`))}</form></details>` : ''

  const acts = html`<span class="ledger-acts">
${mains.length ? pick({ cls: 'ledger-desk ledger-main', hook: 'main', mark: sk('under'), title: `Main agent of ${a.name}: the session this one works for`, label: main ? main.name : 'No main', action: `${forms}/edit`, name: 'parent', set: Boolean(main), options: [{ value: '', label: 'No main', current: !main }, ...mains.map(x => ({ value: x.id, label: `↳ ${x.name}`, current: x.id === a.parent }))] }) : ''}
${desks.length > 1 ? pick({ cls: 'ledger-desk', hook: 'desk', title: `Desk of ${a.name}: move to another desk`, label: desks.find(d => d.id === a.desk)?.name ?? 'Desk', action: `${forms}/edit`, name: 'desk', options: desks.map(d => ({ value: d.id, label: d.name, current: d.id === a.desk })) }) : ''}
<a class="ledger-ib" data-ledger="open" data-nav href="${to}" title="Open the conversation" aria-label="${a.name}: open the conversation">${sk('go')}</a>
${u.open ? html`<a class="ledger-ib" data-ledger="walk" data-nav href="${cardPath(card, base)}?walk=1" title="Its questions, one after the other" aria-label="${a.name}: its questions, one after the other">${sk('tray')}</a>` : ''}
${together}
${!a.online ? post(`${forms}/edit`, '', html`<button class="ledger-ib" data-ledger="archive" type="submit" name="archived" value="1" title="Archive: put this session away" aria-label="Archive ${a.name}">${sk('archive')}</button>`) : ''}
${sheet(u, ctx, { group, others })}</span>`

  // The crown: one per desk, given by his hand (the hub takes it from whoever wore it on this desk).
  const star = post(`${forms}/star`, '', html`<button class="crown-toggle ledger-crown" data-ledger="crown" type="submit" name="starred" value="${a.starred ? '0' : '1'}" aria-pressed="${String(Boolean(a.starred))}" title="${a.starred ? 'Wears the crown of its desk. Click to take it off' : 'Give the crown'}" aria-label="${a.name}: ${a.starred ? 'wears the crown of its desk, take it off' : 'give the crown; quick memos go to it, its questions come first'}">${raw(crownSvg())}</button>`)
  const cls = ['ledger-line', u.parent && 'is-sub', (a.main || u.subs) && 'is-main'].filter(Boolean).join(' ')
  return html`<div class="${cls}" role="row" id="${lineId(a.id)}" data-id="${a.id}" data-state="${word}"${top >= 0 ? html` data-urgency="${Object.keys(RANK).find(k => RANK[k] === top)}"` : ''}>
<span class="ledger-grip">${post(`${forms}/move`, '', html`<button type="submit" data-ledger="up" name="dir" value="up" title="Move up" aria-label="Move ${a.name} up">${sk('unfold')}</button><button type="submit" data-ledger="down" name="dir" value="down" title="Move down" aria-label="Move ${a.name} down">${sk('unfold')}</button>`)}</span>
<span class="ledger-face">${markControl(a, base, STAY)}${star}</span>
<span class="ledger-name">${renameControl(a, base, STAY)}${apart.get(a.id) ? html`<small>${apart.get(a.id)}</small>` : ''}${chip}</span>
${state}
<span class="ledger-does">${does}</span>
<span class="ledger-cell">${a.model ?? ''}</span><span class="ledger-cell">${a.host ?? ''}</span><span class="ledger-cell">${a.online ? 'now' : agoSpan(a.seen ?? a.joined ?? Date.now(), 'ledger-ago')}</span>
${acts}
<a class="ledger-open" data-nav href="${to}" tabindex="-1" aria-hidden="true"></a>
${error ? html`<p class="ledger-err" role="alert">${error}</p>` : ''}
</div>`
}

/** A session that was put away. */
function archivedLine(a, ctx, { error = '' } = {}) {
  return html`<div class="ledger-line is-archived" role="row" id="${lineId(a.id)}" data-id="${a.id}">
<span class="ledger-grip"></span><span class="ledger-face">${avatar(a, { crown: false })}</span><span class="ledger-name"><strong>${a.name}</strong></span>
<span class="ledger-state"><span>put away</span></span><span class="ledger-does"></span>
<span class="ledger-cell">${a.model ?? ''}</span><span class="ledger-cell">${a.host ?? ''}</span><span class="ledger-cell">${agoSpan(a.seen ?? a.joined ?? Date.now(), 'ledger-ago')}</span>
<span class="ledger-acts">${post(`${sessionForms(a, ctx.base)}/edit`, '', html`<button class="ledger-link" data-ledger="fetch" type="submit" name="archived" value="0">Fetch back</button>`)}</span>
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
const COLS = [['name', 'Session'], ['state', 'State'], ['model', 'Model'], ['host', 'Machine'], ['seen', 'Last seen']]
// How much a session needs the human, for sorting by state: stopped first, away last.
const need = u => (u.blocked ? 0 : !u.online ? 9 : u.open ? 1 : u.running ? 7 : 8)
const VAL = {
  name: u => u.agent.name.toLowerCase(), state: need, model: u => (u.agent.model ?? '').toLowerCase(), host: u => (u.agent.host ?? '').toLowerCase(),
  seen: u => (u.agent.online ? 0 : -(u.agent.seen ?? u.agent.joined ?? 0)),
}
const leadWords = m => `${m.agents.filter(a => a.online).length} of ${m.agents.length} sessions are connected.`

/** The whole page. find: words to look for; sort: a column's key, or 'order'; down: the other way round; errors: session id -> what was refused. */
function agentsMain(m, base, { find = '', sort = 'order', down = false, errors = new Map() } = {}) {
  const ctx = around(m, base)
  let { on, off, archived } = parts(m)
  const words = find.trim().toLowerCase()
  const found = u => !words || [u.agent.name, u.agent.given, u.agent.host, u.agent.model, u.agent.task, u.agent.cwd].filter(Boolean).join(' ').toLowerCase().includes(words)
  if (!VAL[sort]) sort = 'order'
  if (sort !== 'order') {
    // Sorted by a column, a line stands for itself: by whether it is connected, then by the column.
    const all = m.units, val = VAL[sort]
    const sorted = list => { const out = [...list].sort((a, b) => (val(a) > val(b) ? 1 : val(a) < val(b) ? -1 : all.indexOf(a) - all.indexOf(b))); return down ? out.reverse() : out }
    on = sorted(all.filter(u => u.online)); off = sorted(all.filter(u => !u.online))
  }
  on = on.filter(found); off = off.filter(found)
  const query = fields => { const q = new URLSearchParams(Object.entries({ find: words ? find : '', ...fields }).filter(([, v]) => v)).toString(); return `${base}/agents${q ? `?${q}` : ''}` }
  const th = ([key, label]) => html`<a class="ledger-th th-${key}" data-nav role="columnheader" aria-sort="${sort === key ? (down ? 'descending' : 'ascending') : 'none'}" href="${query({ sort: key, down: sort === key && !down ? '1' : '' })}">${label}${sort === key ? html`<i>${down ? '↓' : '↑'}</i>` : ''}</a>`
  const line = u => ledgerLine(u, ctx, { error: errors.get(u.id) })
  const anyMain = m.units.some(u => ctx.mainsFor(u).length)
  return html`<main id="ledger" aria-label="Agents"><div class="ledger-page">
${roomTabs('agents', 'ledger-tabs')}
<header class="ledger-head"><h2>Agents</h2><p id="ledger-lead">${leadWords(m)}</p></header>
<div class="ledger-tools"><form method="get" action="${base}/agents" role="search">${sort !== 'order' ? html`<input type="hidden" name="sort" value="${sort}">${down ? raw('<input type="hidden" name="down" value="1">') : ''}` : ''}<label class="ledger-find"><input type="search" name="find" value="${find}" autocomplete="off" placeholder="Find a session, a machine, a model" aria-label="Find a session"><kbd>/</kbd></label></form>${sort !== 'order' || words ? html`<a class="ledger-link" data-nav href="${base}/agents">${words ? 'Show all, in your order' : 'Back to your order'}</a>` : ''}</div>
<div class="ledger" role="table" id="ledger-list" data-controller="pops"${sort !== 'order' || words ? raw(' data-sorted') : ''}${ctx.desks.length > 1 ? raw(' data-desks') : ''}${anyMain ? raw(' data-mains') : ''}>
<div class="ledger-line is-head" role="row"><span></span><span></span>${th(COLS[0])}${th(COLS[1])}<span class="ledger-th">Asks or does</span>${COLS.slice(2).map(th)}<span></span></div>
${on.map(line)}
${off.length ? html`<h3 class="ledger-sub">Disconnected</h3>${off.map(line)}` : ''}
${!on.length && !off.length && m.agents.length ? html`<p class="ledger-none">No session fits. <a class="ledger-link" data-nav href="${base}/agents">Show all</a></p>` : ''}
${!m.agents.length ? raw('<p class="ledger-none">No session is connected yet.</p>') : ''}
${archived.length ? html`<h3 class="ledger-sub">Archive</h3>${archived.map(a => archivedLine(a, ctx, { error: errors.get(a.id) }))}` : ''}
</div></div></main>`
}

/** One line again, as it is now (for a form's answer); null when the session is gone. */
function lineNow(m, base, id, error) {
  const ctx = around(m, base), u = ctx.unitOf.get(id), a = m.byAgent.get(id)
  return u ? ledgerLine(u, ctx, { error }) : a ? archivedLine(a, ctx, { error }) : null
}

export function register(t) {
  const { BASE, hub } = t
  const show = (req, res, url, errors, code = 200) => {
    const q = url.searchParams, m = t.model()
    t.page(req, res, { model: m, title: 'Agents · Trommi', view: 'agents', css: 'agents', bodyAttrs: ' data-page="roster"', stream: VAL[q.get('sort')] ? `&sort=${q.get('sort')}` : '', main: agentsMain(m, BASE, { find: q.get('find') ?? '', sort: q.get('sort') ?? 'order', down: q.has('down'), errors }) }, code)
  }
  t.get(/^\/agents$/, ({ req, res, url }) => show(req, res, url))
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
    try { await WAYS[match[2]](id, form, t.model()) } catch (err) { error = `Not saved: ${err.message || 'the board did not take it'}` }
    if (!error) {
      // The live stream brings the change to every page, this one too; the form itself adds only the toast of an archiving.
      if (stay) return t.sendStream(req, res, match[2] === 'edit' && form.get('archived') === '1' && !form.has('quiet') ? t.toast({ head: 'Archived', line: nameOf(t.model(), id), undo: { action: `${sessionForms({ id }, BASE)}/edit`, fields: { archived: '0' } } }) : '')
      return t.redirect(res, backOf(form.get('back')) || `${BASE}/agents`)
    }
    if (stay) {
      const line = lineNow(t.model(), BASE, id, error)
      return t.sendStream(req, res, line ? t.stream('replace', lineId(id), line) : t.stream('refresh'))
    }
    // Not taken: the page again, with what went wrong in the line (422: Turbo shows it in place).
    show(req, res, url, new Map([[id, error]]), 422)
  })

  t.live('agents', {
    take(m) {
      const ctx = around(m, BASE), { on, off, archived } = parts(m)
      return {
        // Which lines stand where; when that changes, the page fetches itself anew (it keeps its own sorting and finding).
        shape: JSON.stringify([on.map(u => u.id), off.map(u => u.id), archived.map(a => a.id), ctx.desks.length > 1, m.units.some(u => ctx.mainsFor(u).length)]),
        // By each column: a page that is sorted by one fetches itself anew when that order changes.
        orders: Object.fromEntries(Object.entries(VAL).map(([key, val]) => [key, JSON.stringify([...m.units].sort((a, b) => (val(a) > val(b) ? 1 : val(a) < val(b) ? -1 : 0)).map(u => [u.id, u.online]))])),
        lead: leadWords(m),
        rows: new Map([...m.units.map(u => [u.id, ledgerLine(u, ctx)]), ...archived.map(a => [a.id, archivedLine(a, ctx)])]),
      }
    },
    diff(was, now, client) {
      const sort = client?.params?.get('sort')
      if (was.shape !== now.shape || (sort && was.orders[sort] !== now.orders[sort])) return String(t.stream('refresh'))
      const out = was.lead !== now.lead ? [t.stream('update', 'ledger-lead', now.lead)] : []
      for (const [id, row] of now.rows) if (t.differs(was.rows.get(id), row)) out.push(t.stream('replace', lineId(id), row))
      return out.join('')
    },
  })
}
