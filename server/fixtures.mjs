// Test cards for debugging the board's UI: a desk of its own ("Test") with two fake sessions, Test Alpha and Test
// Beta, and one card of every kind the question contract knows (docs/question-contract.md): pictures per option,
// long text, several answers, sections, info, urgent, a conversation under a card, a hand-back, a picture with its
// page and published assets, files, code and a table, a revised card, marks on a picture, a snoozed and an
// answered card. The cards go through the same path as an agent's (the hub's runTool), so they are real cards.
//
// The sessions are reused when they exist (the crown test sessions, with their subs), else made as the hub's own
// (like "Demo"). They stand on the test desk only, so his real desk stays as it is; while nobody listens for them, an
// answer to one of their cards closes it by itself.
//
//   makeFixtures(fx, { kinds })   files the cards of those kinds ('all' or empty: every kind; a group name: its kinds)
//   clearFixtures(fx)             takes away what the fixtures filed; desk and sessions stay
//   register(t)                   POST <base>/dev/fixtures and <base>/dev/fixtures/clear (the Dev group of the menu)
//
// fx: what the hub hands in (server.mjs, turboRoutes({ fixtures })): { state, commit, runTool, storeAsset, desk,
// session, drop, message, decide, snooze }. Run from a shell against a hub: node dev/fixtures.mjs.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareAsset } from './asset-envelope.mjs'
import { html } from './views/html.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const pic = name => path.join(ROOT, 'demo', name)
const file = name => path.join(ROOT, 'demo', 'fixtures', name)

export const DESK_NAME = 'Test'
export const SESSIONS = {
  alpha: { id: 'test-alpha', name: 'Test Alpha', icon: 'flask', task: 'UI-Testkarten: Entscheidungen' },
  beta: { id: 'test-beta', name: 'Test Beta', icon: 'bug', task: 'UI-Testkarten: Inhalte und Gespräche' },
}

const LONG_BODY = [
  'Der Export braucht bei großen Konten bis zu **45 Sekunden**, das Limit der API liegt bei 30. Bisher bricht er dann einfach ab, und der Nutzer sieht nur eine leere Datei.',
  'Ich habe drei Wege gemessen. Jeder hat einen Haken: mehr Zeit bindet Verbindungen, ein asynchroner Export braucht eine Benachrichtigung, und das Kürzen der Daten ändert, was im Export steht.',
  'Dieser Text ist absichtlich zu lang für eine Karte (mehr als 300 Zeichen und mehr als fünf Zeilen), damit man sieht, wie der Desk und die Kartenseite damit umgehen: Kürzen, Umbrechen, „mehr" anzeigen.',
].join('\n\n')

const LAYOUT_HTML = `<div class="grid cols-3">
<div class="card"><h4>A: Liste</h4><p class="muted">Eine Zeile je Karte.</p><p><span class="tag good">schnell</span></p></div>
<div class="card"><h4>B: Kacheln</h4><p class="muted">Zwei Spalten, Bild oben.</p><p><span class="tag warn">mittel</span></p></div>
<div class="card"><h4>C: Stapel</h4><p class="muted">Eine Karte, die nächste darunter.</p><p><span class="tag bad">langsam</span></p></div>
</div>`

const THREAD_HTML = `<table>
<thead><tr><th>Weg</th><th>Sperre</th><th>Umbau</th></tr></thead>
<tbody><tr><td><strong>Jetzt</strong></td><td>40 s</td><td>0 h</td></tr><tr><td>Nachts</td><td>40 s</td><td>0 h</td></tr><tr><td>In Schritten</td><td><mark>0 s</mark></td><td>2 h</td></tr></tbody>
</table>`

const CODE_BODY = [
  'So sieht der neue Start des Hubs aus. Nur zum Lesen, nichts zu entscheiden.',
  '```js\nconst turbo = turboRoutes({ state: () => state, commit, decide })\nhttpServer.listen(PORT, HOST, () => console.log(`[board] on ${PORT}`))\n```',
  '| Seite | Anfragen | kB | erstes Bild |\n|---|--:|--:|--:|\n| Desk alt | 81 | 1311 | 144 ms |\n| Desk Turbo | 32 | 1039 | 84 ms |\n| Karte Turbo | 22 | 375 | 60 ms |',
  'Und eine Liste:\n- `server/turbo.mjs`: Routen und Stream\n- `server/views/*.mjs`: Vorlagen\n- __wichtig__: kein Build-Schritt',
].join('\n\n')

const SECTIONS_TEXT = [
  'Drei Teile, jeder steht für sich. Kreuze an, was ich bauen darf.',
  '[sync*] Abgleich zwischen Hubs: Zwei Rechner zeigen dasselbe Board. Etwa zwei Tage mehr Arbeit.\npicture: design-c1.png',
  '[offline] Offline-Modus\nKarten lassen sich ohne Netz beantworten und gehen raus, sobald es wieder da ist.\npicture: design-c2.png',
  '[export] Export als PDF: Ein Klick, und die Entscheidungen der Woche liegen als Datei vor.',
].join('\n\n')

/** Every fixture: kind (its name for --kind), groups it belongs to, who files it, and how. */
export const FIXTURES = [
  { kind: 'pictures', groups: ['decision'], who: 'alpha', tool: 'create_decision', args: {
    title: 'Welcher Entwurf für die Startseite?', body: 'Drei Entwürfe, jedes Bild gehört zu seiner Antwort.', recommended: 'b',
    attachments: [pic('design-a.png'), pic('design-b.png'), pic('design-c.png')],
    options: [{ key: 'a', label: 'Entwurf A', detail: 'ruhig, viel Weiß' }, { key: 'b', label: 'Entwurf B', detail: 'Karten im Raster' }, { key: 'c', label: 'Entwurf C', detail: 'dunkler Kopf' }] } },
  { kind: 'yesno', groups: ['decision'], who: 'alpha', tool: 'create_decision', args: {
    title: 'Alte Navigation löschen?', body: 'Sie wird seit dem Umbau nirgends mehr verwendet.', recommended: 'del',
    options: [{ key: 'del', label: 'Löschen', short: 'Löschen' }, { key: 'keep', label: 'Behalten', short: 'Behalten' }] } },
  { kind: 'long', groups: ['decision'], who: 'alpha', tool: 'create_decision', args: {
    title: 'Der Export großer Konten läuft in das Zeitlimit der API: wie sollen wir damit umgehen, bevor die nächste Version rausgeht?',
    body: LONG_BODY,
    options: [
      { key: 'limit', label: 'Zeitlimit auf sechzig Sekunden anheben', short: 'Limit 60 s', detail: 'Bindet Verbindungen länger, sonst keine Änderung am Code nötig' },
      { key: 'async', label: 'Export im Hintergrund mit Benachrichtigung', short: 'Hintergrund', detail: 'Etwa zwei Tage Umbau, dafür ohne jedes Limit' },
      { key: 'trim', label: 'Nur die letzten zwölf Monate exportieren', short: 'Kürzen', detail: 'Schnell, aber ältere Daten fehlen im Export' },
      { key: 'wait', label: 'Erst nach der Version entscheiden', short: 'Später', detail: 'Bis dahin bricht der Export bei großen Konten ab' },
    ] } },
  { kind: 'multiple', groups: ['decision'], who: 'alpha', tool: 'create_decision', args: {
    title: 'Was soll in den Wochenbericht?', body: 'Mehrere dürfen angekreuzt werden.', multiple: true, recommended: ['done', 'open'],
    options: [{ key: 'done', label: 'Erledigtes' }, { key: 'open', label: 'Offene Fragen' }, { key: 'numbers', label: 'Zahlen', detail: 'aus dem Messlauf' }, { key: 'risks', label: 'Risiken' }, { key: 'next', label: 'Nächste Schritte' }] } },
  { kind: 'sections', groups: ['decision'], who: 'alpha', tool: 'create_decision', args: {
    title: 'Was baue ich als Nächstes?', multiple: true, text: SECTIONS_TEXT, attachments: [pic('design-c1.png'), pic('design-c2.png')] } },
  { kind: 'urgent', groups: ['decision'], who: 'alpha', tool: 'create_decision', args: {
    title: 'Produktion steht: jetzt zurückrollen?', body: 'Seit 12:04 antwortet die API mit 502. Der letzte Deploy war um 12:01.', urgency: 'critical', urgency_reason: 'Alle Nutzer sind betroffen', recommended: 'rollback',
    options: [{ key: 'rollback', label: 'Zurückrollen', short: 'Zurückrollen' }, { key: 'hold', label: 'Erst untersuchen', short: 'Untersuchen' }] } },
  { kind: 'high', groups: ['decision', 'urgent'], who: 'beta', tool: 'create_decision', args: {
    title: 'Zertifikat läuft in 2 Tagen ab. Jetzt erneuern?', urgency: 'high', urgency_reason: 'Danach warnt der Browser',
    options: [{ key: 'yes', label: 'Erneuern' }, { key: 'no', label: 'Später' }] } },
  { kind: 'revised', groups: ['decision'], who: 'alpha', tool: 'create_decision', args: {
    title: 'Welche Datenbank für den Prototyp?', body: 'Zwei Möglichkeiten.',
    options: [{ key: 'sqlite', label: 'SQLite', detail: 'eine Datei, kein Server' }, { key: 'pg', label: 'Postgres', detail: 'braucht einen Server' }] },
    then: async ({ tool, card }) => tool('revise_card', { card_id: card, body: 'Drei Möglichkeiten: nach deiner Frage ist „später" dazugekommen.', options: [{ key: 'sqlite', label: 'SQLite', detail: 'eine Datei, kein Server' }, { key: 'pg', label: 'Postgres', detail: 'braucht einen Server' }, { key: 'later', label: 'Später entscheiden' }], recommended: 'sqlite' }) },
  { kind: 'marks', groups: ['decision', 'artifact'], who: 'alpha', tool: 'create_decision', args: {
    title: 'Passt der Abstand oben rechts?', body: 'Der eingekreiste Bereich auf dem Bildschirmfoto ist gemeint.',
    attachments: [{ path: pic('board-desktop.png'), title: 'Desk, 1440 breit', marks: [{ x: 0.72, y: 0.02, w: 0.26, h: 0.12, label: 'zu eng?' }, { x: 0.05, y: 0.4, w: 0.2, h: 0.15, label: 'zum Vergleich' }] }],
    options: [{ key: 'ok', label: 'Passt so' }, { key: 'more', label: 'Mehr Abstand' }] } },
  { kind: 'snoozed', groups: ['decision'], who: 'beta', tool: 'create_decision', args: {
    title: 'Lade-Animation beim Start zeigen?', body: 'Liegt auf „Später" (zurückgestellt bis morgen früh).',
    options: [{ key: 'yes', label: 'Ja' }, { key: 'no', label: 'Nein' }, { key: 'short', label: 'Nur kurz', detail: 'höchstens 300 ms' }] },
    then: ({ fx, card }) => fx.snooze(card, {}) },
  { kind: 'answered', groups: ['decision'], who: 'beta', tool: 'create_decision', args: {
    title: 'Changelog ab jetzt führen?', body: 'Schon beantwortet: liegt unter „Erledigt".',
    options: [{ key: 'yes', label: 'Ja' }, { key: 'no', label: 'Nein' }] },
    then: ({ fx, card }) => fx.decide(card, 'yes', 'Ja, ab der nächsten Version.') },
  { kind: 'info', groups: ['info'], who: 'beta', tool: 'create_info', args: {
    title: 'So läuft die nächtliche Migration', body: 'Nur zum Lesen: erst das Backup, dann die Migration, danach ein Probelauf. Das Bild zeigt den Ablauf.\n\nZum Schließen auf „Gelesen".',
    attachments: [pic('design-g1.png')] } },
  { kind: 'code', groups: ['info'], who: 'beta', tool: 'create_info', args: { title: 'Neuer Start des Hubs: Code und Messwerte', body: CODE_BODY } },
  { kind: 'thread', groups: ['decision'], who: 'beta', tool: 'create_decision', args: {
    title: 'Migration auf der Produktions-Datenbank ausführen?', body: 'Fügt eine Spalte hinzu und füllt **48.210 Zeilen** nach.', recommended: 'steps',
    options: [{ key: 'now', label: 'Jetzt ausführen' }, { key: 'night', label: 'Heute Nacht' }, { key: 'steps', label: 'In Schritten' }] },
    then: async ({ tool, fx, card, who }) => {
      await tool('reply', { card_id: card, text: 'Hintergrund zur Karte: die Tabelle ist während der Migration etwa 40 Sekunden gesperrt.', details: 'Gemessen auf einer Kopie:\n\n```\nALTER TABLE cards ADD COLUMN urgency text NOT NULL DEFAULT \'normal\';\n-- 40.2 s, 48210 rows\n```' })
      await fx.message({ agent: who, card_id: card, text: 'Was heißt „in Schritten" genau? Wie lange dauert das?' })
      await tool('reply', { card_id: card, text: 'In Schritten heißt: Spalte anlegen, Zeilen in Tausendern nachfüllen, dann NOT NULL setzen. Nur der letzte Schritt sperrt, etwa zwei Sekunden.', html: THREAD_HTML })
      await fx.message({ agent: who, card_id: card, text: 'Danke, klingt gut. Ich entscheide gleich.' })
    } },
  { kind: 'handback', groups: ['decision', 'thread'], who: 'beta', tool: 'create_decision', args: {
    title: 'Schriftgröße auf dem Handy anheben?', body: 'Die Karten sind auf kleinen Geräten knapp lesbar.',
    options: [{ key: 'up', label: 'Anheben' }, { key: 'keep', label: 'Lassen' }] },
    then: ({ fx, card, who }) => fx.message({ agent: who, card_id: card, text: 'Bitte mit einem Bild vorher/nachher noch einmal vorlegen.', handback: true }) },
  { kind: 'artifact', groups: ['decision'], who: 'beta', tool: 'create_decision', args: {
    title: 'Welches Layout für die Übersicht?', body: 'Zwei Bilder mit ihrer Seite zum Ausprobieren, darunter das Layout als HTML.', html: LAYOUT_HTML,
    attachments: [{ path: pic('design-s1.png'), page: file('artifact.html'), title: 'Variante A, mit Seite' }, { path: pic('design-s2.png'), page: '/designs/advice.html', title: 'Variante B, Seite auf dem Board' }],
    options: [{ key: 'a', label: 'Variante A' }, { key: 'b', label: 'Variante B' }] },
    then: ({ fx, who }) => {
      // Two published assets in the conversation: a page and a picture (what publish_asset does, here in the hub).
      for (const [p, title, note] of [[file('artifact.html'), 'Testseite: Zähler', 'Eine Seite als Asset (verschlüsselt, mit Teilen).'], [pic('design-g2.png'), 'Bild als Asset', 'Ein Bild als Asset.']]) {
        const { blob, record } = prepareAsset({ path: p, title, note })
        fx.storeAsset(who, record, blob)
      }
    } },
  { kind: 'files', groups: ['info'], who: 'beta', tool: 'create_info', args: {
    title: 'Messwerte und Build-Log', body: 'Drei Dateien zum Herunterladen: Messwerte als CSV, das Log des Builds und die Einstellungen.',
    attachments: [file('messwerte.csv'), file('build.log'), file('settings.json')] } },
  { kind: 'chat', groups: ['thread'], who: 'alpha', tool: 'reply', args: {
    text: 'Hallo, ich bin **Test Alpha**, eine Testsitzung ohne echten Agenten. Antworten auf meine Karten schließen sie von selbst.',
    details: 'Angelegt von `node dev/fixtures.mjs` oder dem Menüpunkt Dev → Create test cards.' } },
]

export const KINDS = FIXTURES.map(f => f.kind)
export const GROUPS = [...new Set(FIXTURES.flatMap(f => f.groups))]

/** The fixtures a list of kinds names: 'all' or nothing for every one, a kind for itself, a group for its kinds. */
export function pick(kinds = []) {
  const wanted = [kinds].flat().map(k => String(k).trim().toLowerCase()).filter(Boolean)
  if (!wanted.length || wanted.includes('all')) return FIXTURES
  const unknown = wanted.filter(k => !KINDS.includes(k) && !GROUPS.includes(k))
  if (unknown.length) throw Object.assign(new Error(`unknown kind ${unknown.join(', ')}; one of: all, ${[...GROUPS, ...KINDS].join(', ')}`), { status: 400 })
  return FIXTURES.filter(f => wanted.includes(f.kind) || f.groups.some(g => wanted.includes(g)))
}

/** Files the cards. Returns { desk, cards: [numbers], sessions: [ids] }. Everything it files is marked fixture: true
 *  (cards, and the messages and events of the run), so clearFixtures takes exactly that away and nothing else. */
export async function makeFixtures(fx, { kinds } = {}) {
  const chosen = pick(kinds)
  const desk = fx.desk(DESK_NAME)
  const ids = Object.values(SESSIONS).map(s => s.id)
  const since = fx.state().message_seq ?? 0
  const cards = []
  try {
    for (const s of Object.values(SESSIONS)) {
      fx.session({ id: s.id, name: s.name, desk: desk.id })
      fx.runTool(s.id, 'introduce', { icon: s.icon, task: s.task })
      fx.runTool(s.id, 'set_status', { id: 'fixtures', label: 'Testkarten', state: 'working', detail: 'legt Karten an' })
    }
    for (const f of chosen) {
      const who = SESSIONS[f.who].id
      const tool = async (name, args) => fx.runTool(who, name, args)
      const said = await tool(f.tool, f.args)
      const card = /^(?:card|info) (\w+) /.exec(said)?.[1] ?? null
      if (card) { cards.push(card); fx.state().cards.find(c => c.id === card).fixture = true }
      await f.then?.({ fx, tool, card, who })
    }
    fx.runTool(SESSIONS.alpha.id, 'set_status', { id: 'fixtures', state: 'done', detail: `${cards.length} Karten angelegt` })
    fx.runTool(SESSIONS.beta.id, 'set_status', { id: 'fixtures', state: 'done', detail: 'fertig' })
  } finally {
    // (also what a run that failed half-way filed: "Remove test cards" takes it away)
    for (const m of fx.state().messages) if ((m.seq ?? 0) > since && ids.includes(m.agent)) m.fixture = true
    fx.commit()
  }
  const numbers = cards.map(id => fx.state().cards.find(c => c.id === id)?.number).filter(n => n != null)
  return { desk, cards: numbers, sessions: ids }
}

/** Takes away only what the fixtures filed (cards, their conversation, files and assets). The test desk and the two
 *  sessions stay where they are, out of the real desk. Returns { cards: [numbers] }. */
export function clearFixtures(fx) {
  return { cards: fx.drop() }
}

// ---- the Dev menu's two items (server/views/menu.mjs) ----
/** The two items for the Dev group of the Trommi menu: plain forms (they work without scripts too); the controller
 *  "fixtures" opens the Desk once the hub has answered. */
export const fixtureItems = base => ['', '/clear'].map(way => html`<form method="post" action="${base}/dev/fixtures${way}" class="menu-dev-form" data-controller="fixtures" data-fixtures-desk-value="${base}/" data-action="turbo:submit-end->fixtures#open"><input type="hidden" name="stay" value="1"><button role="menuitem" type="submit" id="${way ? 'dev-fixtures-clear' : 'dev-fixtures'}">${way ? 'Remove test cards' : 'Create test cards'}</button></form>`)
const COOKIE_DESK = 'trommi_desk'
const deskCookie = id => `${COOKIE_DESK}=${id}; Path=/; Max-Age=31536000; SameSite=Lax`
const wantsJson = req => String(req.headers.accept ?? '').startsWith('application/json')

/** POST <base>/dev/fixtures (kind: repeated, or none for all) and <base>/dev/fixtures/clear. Behind the login and the
 *  Origin check like every form. Answer: JSON for a script (Accept: application/json); with Turbo a toast (and the
 *  browser's desk switched to the test desk; the form's controller "fixtures" then opens the Desk); otherwise 303 to
 *  the Desk. */
export function register(t) {
  const fx = () => t.hub.fixtures
  const answer = (req, res, form, out, toast, desk) => {
    if (wantsJson(req)) { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ ok: true, ...out })) }
    if (desk) res.setHeader('Set-Cookie', deskCookie(desk))
    if (t.wantsStream(req)) return t.sendStream(req, res, form.has('quiet') ? '' : t.toast(toast))
    t.redirect(res, `${t.BASE}/`)
  }
  const failed = (req, res, err) => {
    const status = err.status ?? 400
    if (wantsJson(req)) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ error: err.message })) }
    if (t.wantsStream(req)) return t.sendStream(req, res, t.toast({ head: 'Not done', line: err.message, role: 'alert' }))
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(err.message)
  }
  t.post(/^\/dev\/fixtures$/, async ({ req, res, form }) => {
    if (!fx()) return false
    try {
      const out = await makeFixtures(fx(), { kinds: form.getAll('kind') })
      answer(req, res, form, { desk: out.desk.id, cards: out.cards, sessions: out.sessions },
        { head: 'Test cards made', line: `${out.cards.length} on the desk “${out.desk.name}”`, undo: { action: `${t.BASE}/dev/fixtures/clear`, label: 'Remove' }, ms: 8000 }, out.desk.id)
    } catch (err) { failed(req, res, err) }
  })
  t.post(/^\/dev\/fixtures\/clear$/, ({ req, res, form }) => {
    if (!fx()) return false
    try {
      const out = clearFixtures(fx())
      answer(req, res, form, out, { head: 'Test cards removed', line: `${out.cards.length} cards of Test Alpha and Test Beta` }, null)
    } catch (err) { failed(req, res, err) }
  })
}
