// The admin page: one screen for whoever runs the hub. It reads four summaries
// from /admin/api and redraws from them; every button that removes or replaces
// something first turns into a question, and only the answer sends the request.
import { el, ago, agoNode, doodle } from './ui.js'

const $ = id => document.getElementById(id)
const api = '/admin/api/'

let view = null        // { overview, cleanup, log, diagnose } as last loaded
let asking = null      // the action that is waiting for its "yes", by key
let links = null       // login links, once asked for
let busy = false

// ---- talking to the hub ------------------------------------------------------

class Refused extends Error {
  constructor(status, body) {
    super(body?.error ?? `Error ${status}`)
    this.status = status
    this.needsKey = status === 403 && body?.admin === false
  }
}

async function call(route, body) {
  const res = await fetch(api + route, body === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const out = await res.json().catch(() => null)
  if (!res.ok) throw new Refused(res.status, out)
  return out
}

async function load() {
  try {
    const [overview, cleanup, log, diagnose] = await Promise.all(['overview', 'cleanup', 'log', 'diagnose'].map(r => call(r)))
    view = { overview, cleanup, log, diagnose }
    show('admin')
    render()
  } catch (err) {
    if (err.needsKey) return show('gate')
    if (err.status === 401) return lead('Not signed in. Open the link from data/url.txt first, then this page.')
    if (!view) lead(`The hub does not answer: ${err.message}`)
  }
}

function show(which) {
  $('gate').hidden = which !== 'gate'
  $('admin').hidden = which !== 'admin'
  if (which === 'gate') $('gate-key').focus()
}
const lead = text => { $('lead').textContent = text }

let toastTimer
function toast(text) {
  $('toast').textContent = text
  $('toast').hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { $('toast').hidden = true }, 4000)
}

// One request at a time; afterwards the page shows what is true now.
async function act(route, body, done) {
  if (busy) return
  busy = true
  asking = null
  try {
    const out = await call(route, body)
    toast(done(out))
    return out
  } catch (err) {
    if (err.needsKey) show('gate')
    else toast(`Not done: ${err.message}`)
  } finally {
    busy = false
    await load()
  }
}

// ---- words and numbers -------------------------------------------------------

const count = (n, one, many) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`
function bytes(n) {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024, unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value.toLocaleString('en-GB', { maximumFractionDigits: value < 10 ? 1 : 0 })} ${units[unit]}`
}
function span(seconds) {
  const min = Math.floor(seconds / 60), hours = Math.floor(min / 60), days = Math.floor(hours / 24)
  if (days) return `${count(days, 'day', 'days')}, ${hours % 24} h`
  if (hours) return `${hours} h ${min % 60} min`
  return min ? `${min} min` : 'under a minute'
}
const stamp = ts => new Date(ts).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
const files = t => (t.count ? `${count(t.count, 'file', 'files')}, ${bytes(t.bytes)}` : 'empty')

// ---- building blocks ---------------------------------------------------------

// A section starts with its name as a divider: heavy title, a rule, and a note in small caps.
function head(section, title, note) {
  const h = el('h2', 'adm-title')
  h.id = `h-${section.id}`
  h.append(el('span', null, title))
  if (note) h.append(el('b', null, note))
  section.replaceChildren(h)
}

function facts(pairs) {
  const dl = el('dl', 'adm-facts')
  for (const [name, value, cls] of pairs) {
    const row = el('div', cls)
    row.append(el('dt', null, name))
    const dd = el('dd')
    dd.append(value)
    row.append(dd)
    dl.append(row)
  }
  return dl
}

function button(label, cls, onClick) {
  const b = el('button', `adm-btn ${cls ?? ''}`.trim(), label)
  b.type = 'button'
  b.disabled = busy
  b.addEventListener('click', onClick)
  return b
}

/** A button that asks before it acts. answers: [[label, class, run], …]; "Cancel" is always offered. */
function guarded(key, label, question, answers, cls = '') {
  if (asking !== key) return button(label, cls, () => { asking = key; render() })
  const box = el('div', 'adm-ask')
  box.setAttribute('role', 'group')
  box.append(el('p', null, question))
  const row = el('div', 'adm-ask-row')
  for (const [text, kind, run] of answers) row.append(button(text, kind, run))
  row.append(button('Cancel', '', () => { asking = null; render() }))
  box.append(row)
  return box
}

/** A row of the page: what it is and how it stands on the left, what you can do on the right. */
function row(title, text, action) {
  const node = el('div', 'adm-row')
  const words = el('div', 'adm-row-text')
  words.append(el('strong', null, title), el('p', null, text))
  node.append(words)
  if (action) node.append(action)
  return node
}

// ---- sections ------------------------------------------------------------------

function renderOverview({ overview: o }) {
  const section = $('overview')
  head(section, 'Overview', `Version ${o.version || 'unknown'}`)
  const cards = o.counts.cards
  const waiting = Object.entries(o.counts.queued)
  section.append(facts([
    ['Hub', `${o.hub.id} · process ${o.hub.pid}`],
    ['Machine', o.hub.host],
    ['Hub since', agoNode(o.hub.since)],
    ['Address', `${o.bind}:${o.port}`],
    ['Process running for', span(o.uptime)],
    ['Speech', o.speech ? 'set up' : 'not set up', o.speech ? '' : 'is-off'],
    ['Messages', o.counts.messages.toLocaleString('en-GB')],
    ['Questions', `${cards.open} open · ${cards.decided} decided · ${cards.done} done`],
    ['Waiting for absent sessions', waiting.length ? waiting.map(([id, n]) => `${id}: ${n}`).join(' · ') : 'nothing', waiting.length ? '' : 'is-off'],
  ]))
  const store = el('div', 'adm-store')
  store.append(el('code', null, o.data.dir))
  store.append(facts([
    ['State', bytes(o.data.state)],
    ['Attachments', files(o.data.files)],
    ['Scribbles', files(o.data.scribbles)],
    ['Speech cache', files(o.data.speech)],
  ]))
  section.append(store)
}

function renderSessions({ overview: o }) {
  const section = $('sessions')
  const online = o.sessions.filter(a => a.online).length
  head(section, 'Sessions', `${online} of ${o.sessions.length} connected`)
  const list = el('div', 'adm-cards')
  for (const a of o.sessions) {
    const card = el('article', 'adm-card')
    card.dataset.online = a.online
    const tab = el('div', 'adm-tab')
    tab.append(el('span', null, a.online ? 'Connected' : 'Away'))
    if (a.hub) tab.append(el('span', null, 'Hub'))
    const top = el('div', 'adm-card-top')
    top.append(tab, el('span', 'adm-when', a.online ? 'now' : `last seen ${ago(a.seen)}`))
    const name = el('div', 'adm-name')
    name.append(doodle(a.id), el('strong', null, a.label || a.name))
    if (a.task) name.append(el('span', null, a.task))
    card.append(top, name, facts([
      ['Model', a.model || 'unknown', a.model ? '' : 'is-off'],
      ['Machine', a.host || 'unknown', a.host ? '' : 'is-off'],
      ['Program', a.client || 'unknown', a.client ? '' : 'is-off'],
      ['Folder', a.cwd || 'unknown', a.cwd ? '' : 'is-off'],
      ['Holds', `${count(a.messages, 'message', 'messages')} · ${count(a.cards, 'question', 'questions')}`],
      ['Waiting', a.queued ? count(a.queued, 'notification', 'notifications') : 'nothing', a.queued ? '' : 'is-off'],
    ]))
    const actions = el('div', 'adm-actions')
    if (a.queued) {
      actions.append(guarded(`queue:${a.id}`, 'Discard what waits',
        `${count(a.queued, 'notification waits', 'notifications wait')} for "${a.name}". Discarded means: the session never hears of it.`,
        [['Discard', 'is-danger', () => act('sessions/clear-queue', { id: a.id, confirm: a.id }, out => `${count(out.removed, 'notification', 'notifications')} discarded`)]]))
    }
    if (!a.online) {
      const forget = data => act('sessions/forget', { id: a.id, confirm: a.id, data },
        out => (data ? `Forgot "${a.name}", deleted ${count(out.messages, 'message', 'messages')}, ${count(out.cards, 'question', 'questions')} and ${count(out.files, 'file', 'files')}` : `Forgot "${a.name}", kept the conversation`))
      actions.append(guarded(`forget:${a.id}`, 'Forget',
        `Take "${a.name}" off the list? What waits for the session is dropped. You can keep its conversation: if a session starts in the same folder again, it takes it over.`,
        [['Only the session', 'is-primary', () => forget(false)], ['With conversation, questions and files', 'is-danger', () => forget(true)]]))
    }
    if (actions.childElementCount) card.append(actions)
    list.append(card)
  }
  section.append(list)
}

function renderCleanup({ cleanup: c }) {
  const section = $('cleanup')
  head(section, 'Clean up', `Kept for ${count(c.retention_days, 'day', 'days')}`)
  const p = c.purge
  const due = p.cards || p.queued
  const what = [
    p.cards && count(p.cards, 'answered question', 'answered questions'),
    p.count && `${count(p.count, 'attachment', 'attachments')} (${bytes(p.bytes)})`,
    p.queued && count(p.queued, 'waiting notification', 'waiting notifications'),
  ].filter(Boolean).join(', ')
  section.append(row('Expired',
    due ? `Older than ${c.retention_days} days: ${what}. Open questions stay.` : `Nothing is older than ${c.retention_days} days. The hub checks this itself every six hours.`,
    due ? guarded('purge', 'Delete now', `Delete ${what} for good?`, [['Delete', 'is-danger', () => act('purge', { confirm: 'purge' }, out => `Deleted ${count(out.cards, 'question', 'questions')} and ${count(out.count, 'attachment', 'attachments')}`)]]) : null))
  const o = c.orphans
  const total = o.files.count + o.scribbles.count + o.speech.count
  const size = o.files.bytes + o.scribbles.bytes + o.speech.bytes
  section.append(row('Orphaned files',
    total ? `Nothing points to them any more: ${count(o.files.count, 'attachment', 'attachments')}, ${count(o.scribbles.count, 'scribble', 'scribbles')} and ${count(o.speech.count, 'spoken text', 'spoken texts')} older than a day, ${bytes(size)} in total.` : 'Every file in the data folder belongs to a message, a question or a canvas.',
    total ? guarded('orphans', 'Delete files', `Delete ${count(total, 'file', 'files')} (${bytes(size)}) for good?`, [['Delete', 'is-danger', () => act('orphans', { confirm: 'orphans' }, out => `Deleted ${count(out.removed, 'file', 'files')}, ${bytes(out.bytes)} freed`)]]) : null))
}

const LINK_KIND = { local: 'This machine', lan: 'On the network', public: 'From outside' }

async function copy(text, node) {
  try {
    await navigator.clipboard.writeText(text)
    toast('Link copied')
  } catch {
    // No clipboard without HTTPS: select the link so it can be copied by hand.
    getSelection().selectAllChildren(node)
    toast('Link selected, copy it now')
  }
}

function renderAccess({ overview: o }) {
  const section = $('access')
  head(section, 'Access', o.token_fixed ? 'Token from BOARD_TOKEN' : 'Token in data/token')
  if (!links) {
    section.append(row('Links to sign in', 'Each link contains the token and signs a browser in for good. Pass it on only to someone you trust with the board.',
      button('Show links', '', async () => { links = (await act('links', {}, () => 'Links fetched'))?.links ?? null; render() })))
  } else {
    const list = el('div', 'adm-links')
    for (const link of links) {
      const item = el('div', 'adm-link')
      const url = el('code', null, link.url)
      item.append(el('b', null, LINK_KIND[link.kind] ?? link.kind), url, button('Copy', '', () => copy(link.url, url)))
      list.append(item)
    }
    list.append(button('Hide links', 'is-quiet', () => { links = null; render() }))
    section.append(list)
  }
  section.append(row('Replace the token',
    o.token_fixed ? 'The token is fixed through BOARD_TOKEN. Change it there and restart the hub.' : 'Every signed-in browser and app has to sign in again with the new link. You stay signed in. Running agent sessions keep working.',
    o.token_fixed ? null : guarded('rotate', 'New token', 'Make the old token invalid right away? Old links and sign-ins stop working then.',
      [['Replace', 'is-danger', async () => { links = (await act('token/rotate', { confirm: 'rotate' }, () => 'The new token is in force, old sign-ins have ended'))?.links ?? null; render() }]])))
}

const ACTION = {
  login: 'Admin opened', 'login-failed': 'Wrong key', export: 'State downloaded', links: 'Links shown',
  forget: 'Session forgotten', 'clear-queue': 'Waiting discarded', purge: 'Expired deleted', orphans: 'Orphaned files deleted', rotate: 'Token replaced',
}

function renderData({ log }) {
  const section = $('data')
  head(section, 'Data', `Log: last ${log.max}`)
  const download = el('a', 'adm-btn', 'Download')
  download.href = `${api}export`
  download.addEventListener('click', () => setTimeout(load, 800))
  section.append(row('State as JSON', 'Sessions, messages, questions and status lines. Not included: token, keys and the notifications that wait for absent sessions (only how many).', download))
  const list = el('ol', 'adm-log')
  for (const e of [...log.entries].reverse().slice(0, 40)) {
    const item = el('li', e.action === 'login-failed' ? 'is-warn' : null)
    item.append(el('time', null, stamp(e.ts)), el('b', null, `${ACTION[e.action] ?? e.action}${e.count > 1 ? ` (${e.count} times)` : ''}`), el('span', null, [e.detail, e.from].filter(Boolean).join(' · ')))
    list.append(item)
  }
  if (!log.entries.length) list.append(el('li', 'is-empty', 'Nothing done yet.'))
  section.append(list)
}

const LINK_STATE = { hub: 'Hub', linked: 'Connected', away: 'Away' }

function renderDiagnose({ diagnose: d }) {
  const section = $('diagnose')
  head(section, 'Diagnosis', count(d.sse, 'open page', 'open pages'))
  const table = el('div', 'adm-links-state')
  for (const l of d.links) {
    const item = el('div', 'adm-state')
    item.dataset.state = l.state
    item.append(el('b', null, LINK_STATE[l.state]), el('strong', null, l.id),
      el('span', null, l.state === 'away' ? `last seen ${ago(l.seen)}` : `connected ${ago(l.since)}`))
    table.append(item)
  }
  const out = el('pre', 'adm-stderr')
  out.tabIndex = 0
  out.setAttribute('aria-label', 'Last lines on stderr')
  out.textContent = d.lines.map(l => `${stamp(l.ts)}  ${l.line}`).join('\n') || 'The hub has not written anything yet.'
  section.append(table, out)
  out.scrollTop = out.scrollHeight
}

function render() {
  if (!view) return
  for (const draw of [renderOverview, renderSessions, renderCleanup, renderAccess, renderData, renderDiagnose]) draw(view)
}

// ---- start ---------------------------------------------------------------------

$('gate').addEventListener('submit', async event => {
  event.preventDefault()
  const error = $('gate-error')
  error.hidden = true
  try {
    await call('login', { key: $('gate-key').value.trim() })
    $('gate-key').value = ''
    await load()
  } catch (err) {
    error.textContent = err.status === 403 ? 'That is not the key from data/admin-token.' : err.message
    error.hidden = false
  }
})

$('logout').addEventListener('click', async () => {
  await call('logout', {}).catch(() => {})
  view = links = asking = null
  show('gate')
})

// Keep the numbers current, but never redraw under a question that waits for its answer.
setInterval(() => {
  if (!document.hidden && !$('admin').hidden && !asking && !busy) load()
}, 10000)

load()
