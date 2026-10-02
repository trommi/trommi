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
    super(body?.error ?? `Fehler ${status}`)
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
    if (err.status === 401) return lead('Nicht angemeldet. Öffne zuerst den Link aus data/url.txt, dann diese Seite.')
    if (!view) lead(`Der Hub antwortet nicht: ${err.message}`)
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
    else toast(`Nicht ausgeführt: ${err.message}`)
  } finally {
    busy = false
    await load()
  }
}

// ---- words and numbers -------------------------------------------------------

const count = (n, one, many) => `${n.toLocaleString('de-DE')} ${n === 1 ? one : many}`
function bytes(n) {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024, unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value.toLocaleString('de-DE', { maximumFractionDigits: value < 10 ? 1 : 0 })} ${units[unit]}`
}
function span(seconds) {
  const min = Math.floor(seconds / 60), hours = Math.floor(min / 60), days = Math.floor(hours / 24)
  if (days) return `${count(days, 'Tag', 'Tage')}, ${hours % 24} Std.`
  if (hours) return `${hours} Std. ${min % 60} Min.`
  return min ? `${min} Min.` : 'unter einer Minute'
}
const stamp = ts => new Date(ts).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
const files = t => (t.count ? `${count(t.count, 'Datei', 'Dateien')}, ${bytes(t.bytes)}` : 'leer')

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

/** A button that asks before it acts. answers: [[label, class, run], …]; "Abbrechen" is always offered. */
function guarded(key, label, question, answers, cls = '') {
  if (asking !== key) return button(label, cls, () => { asking = key; render() })
  const box = el('div', 'adm-ask')
  box.setAttribute('role', 'group')
  box.append(el('p', null, question))
  const row = el('div', 'adm-ask-row')
  for (const [text, kind, run] of answers) row.append(button(text, kind, run))
  row.append(button('Abbrechen', '', () => { asking = null; render() }))
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
  head(section, 'Übersicht', `Version ${o.version || 'unbekannt'}`)
  const cards = o.counts.cards
  const waiting = Object.entries(o.counts.queued)
  section.append(facts([
    ['Hub', `${o.hub.id} · Prozess ${o.hub.pid}`],
    ['Rechner', o.hub.host],
    ['Hub seit', agoNode(o.hub.since)],
    ['Adresse', `${o.bind}:${o.port}`],
    ['Prozess läuft', span(o.uptime)],
    ['Sprache', o.speech ? 'eingerichtet' : 'nicht eingerichtet', o.speech ? '' : 'is-off'],
    ['Nachrichten', o.counts.messages.toLocaleString('de-DE')],
    ['Karten', `${cards.open} offen · ${cards.decided} entschieden · ${cards.done} erledigt`],
    ['Wartet auf Abwesende', waiting.length ? waiting.map(([id, n]) => `${id}: ${n}`).join(' · ') : 'nichts', waiting.length ? '' : 'is-off'],
  ]))
  const store = el('div', 'adm-store')
  store.append(el('code', null, o.data.dir))
  store.append(facts([
    ['Zustand', bytes(o.data.state)],
    ['Anhänge', files(o.data.files)],
    ['Scribbles', files(o.data.scribbles)],
    ['Sprach-Cache', files(o.data.speech)],
  ]))
  section.append(store)
}

function renderSessions({ overview: o }) {
  const section = $('sessions')
  const online = o.sessions.filter(a => a.online).length
  head(section, 'Sitzungen', `${online} von ${o.sessions.length} verbunden`)
  const list = el('div', 'adm-cards')
  for (const a of o.sessions) {
    const card = el('article', 'adm-card')
    card.dataset.online = a.online
    const tab = el('div', 'adm-tab')
    tab.append(el('span', null, a.online ? 'Verbunden' : 'Weg'))
    if (a.hub) tab.append(el('span', null, 'Hub'))
    const top = el('div', 'adm-card-top')
    top.append(tab, el('span', 'adm-when', a.online ? 'jetzt' : `zuletzt ${ago(a.seen)}`))
    const name = el('div', 'adm-name')
    name.append(doodle(a.id), el('strong', null, a.label || a.name))
    if (a.task) name.append(el('span', null, a.task))
    card.append(top, name, facts([
      ['Modell', a.model || 'unbekannt', a.model ? '' : 'is-off'],
      ['Rechner', a.host || 'unbekannt', a.host ? '' : 'is-off'],
      ['Programm', a.client || 'unbekannt', a.client ? '' : 'is-off'],
      ['Ordner', a.cwd || 'unbekannt', a.cwd ? '' : 'is-off'],
      ['Bestand', `${count(a.messages, 'Nachricht', 'Nachrichten')} · ${count(a.cards, 'Karte', 'Karten')}`],
      ['Wartet', a.queued ? count(a.queued, 'Benachrichtigung', 'Benachrichtigungen') : 'nichts', a.queued ? '' : 'is-off'],
    ]))
    const actions = el('div', 'adm-actions')
    if (a.queued) {
      actions.append(guarded(`queue:${a.id}`, 'Wartendes verwerfen',
        `${count(a.queued, 'Benachrichtigung wartet', 'Benachrichtigungen warten')} auf „${a.name}“. Verworfen heißt: Die Sitzung erfährt nie davon.`,
        [['Verwerfen', 'is-danger', () => act('sessions/clear-queue', { id: a.id, confirm: a.id }, out => `${count(out.removed, 'Benachrichtigung', 'Benachrichtigungen')} verworfen`)]]))
    }
    if (!a.online) {
      const forget = data => act('sessions/forget', { id: a.id, confirm: a.id, data },
        out => (data ? `„${a.name}“ vergessen, ${count(out.messages, 'Nachricht', 'Nachrichten')}, ${count(out.cards, 'Karte', 'Karten')} und ${count(out.files, 'Datei', 'Dateien')} gelöscht` : `„${a.name}“ vergessen, Gespräch behalten`))
      actions.append(guarded(`forget:${a.id}`, 'Vergessen',
        `„${a.name}“ aus der Liste nehmen? Was auf die Sitzung wartet, verfällt. Ihr Gespräch kannst du behalten: Startet im selben Ordner wieder eine Sitzung, übernimmt sie es.`,
        [['Nur die Sitzung', 'is-primary', () => forget(false)], ['Mit Gespräch, Karten und Dateien', 'is-danger', () => forget(true)]]))
    }
    if (actions.childElementCount) card.append(actions)
    list.append(card)
  }
  section.append(list)
}

function renderCleanup({ cleanup: c }) {
  const section = $('cleanup')
  head(section, 'Aufräumen', `Frist ${count(c.retention_days, 'Tag', 'Tage')}`)
  const p = c.purge
  const due = p.cards || p.queued
  const what = [
    p.cards && count(p.cards, 'beantwortete Karte', 'beantwortete Karten'),
    p.count && `${count(p.count, 'Anhang', 'Anhänge')} (${bytes(p.bytes)})`,
    p.queued && count(p.queued, 'wartende Benachrichtigung', 'wartende Benachrichtigungen'),
  ].filter(Boolean).join(', ')
  section.append(row('Abgelaufenes',
    due ? `Älter als ${c.retention_days} Tage: ${what}. Offene Karten bleiben.` : `Nichts ist älter als ${c.retention_days} Tage. Der Hub prüft das alle sechs Stunden selbst.`,
    due ? guarded('purge', 'Jetzt löschen', `${what} endgültig löschen?`, [['Löschen', 'is-danger', () => act('purge', { confirm: 'purge' }, out => `${count(out.cards, 'Karte', 'Karten')} und ${count(out.count, 'Anhang', 'Anhänge')} gelöscht`)]]) : null))
  const o = c.orphans
  const total = o.files.count + o.scribbles.count + o.speech.count
  const size = o.files.bytes + o.scribbles.bytes + o.speech.bytes
  section.append(row('Verwaiste Dateien',
    total ? `Auf sie zeigt nichts mehr: ${count(o.files.count, 'Anhang', 'Anhänge')}, ${count(o.scribbles.count, 'Scribble', 'Scribbles')} und ${count(o.speech.count, 'gesprochener Text', 'gesprochene Texte')} älter als ein Tag, zusammen ${bytes(size)}.` : 'Jede Datei im Datenordner gehört zu einer Nachricht, einer Karte oder einem Canvas.',
    total ? guarded('orphans', 'Dateien löschen', `${count(total, 'Datei', 'Dateien')} (${bytes(size)}) endgültig löschen?`, [['Löschen', 'is-danger', () => act('orphans', { confirm: 'orphans' }, out => `${count(out.removed, 'Datei', 'Dateien')} gelöscht, ${bytes(out.bytes)} frei`)]]) : null))
}

const LINK_KIND = { local: 'Dieser Rechner', lan: 'Im Netz', public: 'Von außen' }

async function copy(text, node) {
  try {
    await navigator.clipboard.writeText(text)
    toast('Link kopiert')
  } catch {
    // No clipboard without HTTPS: select the link so it can be copied by hand.
    getSelection().selectAllChildren(node)
    toast('Link markiert, jetzt kopieren')
  }
}

function renderAccess({ overview: o }) {
  const section = $('access')
  head(section, 'Zugang', o.token_fixed ? 'Token aus BOARD_TOKEN' : 'Token in data/token')
  if (!links) {
    section.append(row('Links zum Anmelden', 'Jeder Link enthält das Token und meldet einen Browser dauerhaft an. Gib ihn nur weiter, wem du das Board anvertraust.',
      button('Links zeigen', '', async () => { links = (await act('links', {}, () => 'Links geholt'))?.links ?? null; render() })))
  } else {
    const list = el('div', 'adm-links')
    for (const link of links) {
      const item = el('div', 'adm-link')
      const url = el('code', null, link.url)
      item.append(el('b', null, LINK_KIND[link.kind] ?? link.kind), url, button('Kopieren', '', () => copy(link.url, url)))
      list.append(item)
    }
    list.append(button('Links ausblenden', 'is-quiet', () => { links = null; render() }))
    section.append(list)
  }
  section.append(row('Token austauschen',
    o.token_fixed ? 'Das Token ist über BOARD_TOKEN fest eingestellt. Ändere es dort und starte den Hub neu.' : 'Alle angemeldeten Browser und Apps müssen sich mit dem neuen Link neu anmelden; du bleibst angemeldet. Laufende Sitzungen der Agenten arbeiten weiter.',
    o.token_fixed ? null : guarded('rotate', 'Neues Token', 'Altes Token sofort ungültig machen? Alte Links und Anmeldungen funktionieren dann nicht mehr.',
      [['Austauschen', 'is-danger', async () => { links = (await act('token/rotate', { confirm: 'rotate' }, () => 'Neues Token gilt, alte Anmeldungen sind beendet'))?.links ?? null; render() }]])))
}

const ACTION = {
  login: 'Verwaltung geöffnet', 'login-failed': 'Falscher Schlüssel', export: 'Zustand heruntergeladen', links: 'Links angezeigt',
  forget: 'Sitzung vergessen', 'clear-queue': 'Wartendes verworfen', purge: 'Abgelaufenes gelöscht', orphans: 'Verwaiste Dateien gelöscht', rotate: 'Token ausgetauscht',
}

function renderData({ log }) {
  const section = $('data')
  head(section, 'Daten', `Protokoll: letzte ${log.max}`)
  const download = el('a', 'adm-btn', 'Herunterladen')
  download.href = `${api}export`
  download.addEventListener('click', () => setTimeout(load, 800))
  section.append(row('Zustand als JSON', 'Sitzungen, Nachrichten, Karten und Statuszeilen. Nicht enthalten: Token, Schlüssel und die Benachrichtigungen, die auf abwesende Sitzungen warten (nur ihre Anzahl).', download))
  const list = el('ol', 'adm-log')
  for (const e of [...log.entries].reverse().slice(0, 40)) {
    const item = el('li', e.action === 'login-failed' ? 'is-warn' : null)
    item.append(el('time', null, stamp(e.ts)), el('b', null, `${ACTION[e.action] ?? e.action}${e.count > 1 ? ` (${e.count}-mal)` : ''}`), el('span', null, [e.detail, e.from].filter(Boolean).join(' · ')))
    list.append(item)
  }
  if (!log.entries.length) list.append(el('li', 'is-empty', 'Noch nichts getan.'))
  section.append(list)
}

const LINK_STATE = { hub: 'Hub', linked: 'Verbunden', away: 'Weg' }

function renderDiagnose({ diagnose: d }) {
  const section = $('diagnose')
  head(section, 'Diagnose', count(d.sse, 'offene Seite', 'offene Seiten'))
  const table = el('div', 'adm-links-state')
  for (const l of d.links) {
    const item = el('div', 'adm-state')
    item.dataset.state = l.state
    item.append(el('b', null, LINK_STATE[l.state]), el('strong', null, l.id),
      el('span', null, l.state === 'away' ? `zuletzt ${ago(l.seen)}` : `seit ${ago(l.since)}`))
    table.append(item)
  }
  const out = el('pre', 'adm-stderr')
  out.tabIndex = 0
  out.setAttribute('aria-label', 'Letzte Zeilen auf stderr')
  out.textContent = d.lines.map(l => `${stamp(l.ts)}  ${l.line}`).join('\n') || 'Der Hub hat noch nichts geschrieben.'
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
    error.textContent = err.status === 403 ? 'Das ist nicht der Schlüssel aus data/admin-token.' : err.message
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
