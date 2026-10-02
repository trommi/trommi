// Writes a realistic state.json into the directory given as argv[2], with
// timestamps relative to now. Used by dev/serve.sh for previews and screenshots.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = process.argv[2]
const demo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'demo')
fs.mkdirSync(path.join(dir, 'files'), { recursive: true })
const attach = name => {
  fs.copyFileSync(path.join(demo, name), path.join(dir, 'files', name))
  return { name, url: `/files/${name}`, image: true }
}

const now = Date.now()
const min = 60000
const card = (id, o) => ({
  id, kind: 'decision', status: 'open', urgency: 'normal', urgency_reason: '', body: '', attachments: [],
  choice: null, note: '', summary: '', decided: null, ...o,
})

const cards = [
  card('c-theme', {
    title: 'Welches Standard-Theme?', created: now - 22 * min, urgency: 'normal',
    body: 'Beide Themes sind fertig. Ich brauche nur den Standard für neue Nutzer.',
    options: [
      { key: 'hell', label: 'Hell', detail: 'Besser lesbar bei Tageslicht' },
      { key: 'dunkel', label: 'Dunkel', detail: 'Passt zu Terminal und IDE' },
      { key: 'system', label: 'Dem System folgen', detail: 'Richtet sich nach der Geräteeinstellung' },
    ],
    attachments: [attach('thema-hell.png'), attach('thema-dunkel.png')],
  }),
  card('c-migrate', {
    title: 'Migration auf der Produktions-Datenbank ausführen?', created: now - 4 * min, urgency: 'critical',
    urgency_reason: 'Deploy wartet, alle weiteren Schritte hängen davon ab',
    body: 'Die Migration `2026_10_02_add_urgency` fügt eine Spalte hinzu und füllt **48.210 Zeilen** nach. Geschätzte Dauer: 40 Sekunden, währenddessen ist die Tabelle gesperrt.\n\n```\nALTER TABLE cards ADD COLUMN urgency text NOT NULL DEFAULT \'normal\';\n```',
    options: [
      { key: 'run-now', label: 'Jetzt ausführen', detail: 'Kurze Sperre, Deploy läuft danach durch' },
      { key: 'tonight', label: 'Heute Nacht um 02:00', detail: 'Kein Nutzer betroffen, Deploy wartet bis morgen' },
      { key: 'batch', label: 'In Schritten ohne Sperre', detail: 'Etwa zwei Stunden Umbau am Skript' },
      { key: 'cancel', label: 'Nicht ausführen', detail: 'Ich nehme die Änderung zurück' },
    ],
  }),
  card('c-phone', {
    title: 'Wie soll das Board auf dem Handy starten?', created: now - 15 * min, urgency: 'high',
    urgency_reason: 'Ich baue gerade an der mobilen Ansicht',
    body: 'Auf dem Handy passt nur eine Ansicht auf den Bildschirm.',
    options: [
      { key: 'gespraech', label: 'Mit dem Gespräch', detail: 'Wie eine Chat-App' },
      { key: 'entscheidungen', label: 'Mit den Entscheidungen', detail: 'Offene Fragen zuerst' },
      { key: 'zuletzt', label: 'Wo ich zuletzt war', detail: 'Merkt sich die letzte Ansicht' },
    ],
    attachments: [attach('phone-gespraech.png'), attach('phone-entscheidungen.png')],
  }),
  { id: 'c-perm', kind: 'permission', status: 'open', urgency: 'critical', urgency_reason: '', request_id: 'abcde',
    title: 'Freigabe: Bash', body: 'Run the test suite\n\n{"command":"npm test -- --coverage"}',
    options: [{ key: 'allow', label: 'Erlauben', detail: '' }, { key: 'deny', label: 'Ablehnen', detail: '' }],
    attachments: [], choice: null, note: '', summary: '', created: now - 1 * min, decided: null },
  card('c-next', {
    title: 'Was baue ich als Nächstes?', created: now - 30 * min, urgency: 'low',
    options: [
      { key: 'mehrere-agenten', label: 'Mehrere Agenten', detail: 'Ein Board für mehrere Sessions' },
      { key: 'verschluesselung', label: 'Verschlüsselung', detail: 'Ende-zu-Ende zwischen Browser und Agent' },
      { key: 'live-verlauf', label: 'Live-Verlauf', detail: 'Zeigt, was der Agent gerade tut' },
    ],
  }),
  card('c-db', {
    title: 'Welche Datenbank?', status: 'decided', created: now - 95 * min, decided: now - 80 * min,
    choice: 'pg', note: 'mit Docker', body: 'SQLite reicht für den Prototyp, Postgres wäre näher an Produktion.',
    options: [{ key: 'sqlite', label: 'SQLite', detail: '' }, { key: 'pg', label: 'Postgres', detail: '' }],
  }),
  card('c-name', {
    title: 'Name des Projekts?', status: 'done', created: now - 300 * min, decided: now - 290 * min,
    choice: 'agent-board', summary: 'Ordner und package.json umbenannt',
    options: [{ key: 'agent-board', label: 'Agent Board', detail: '' }, { key: 'herd', label: 'Herd', detail: '' }],
  }),
  card('c-port', {
    title: 'Auf welchem Port soll der Server laufen?', status: 'done', created: now - 400 * min, decided: now - 395 * min,
    choice: '8790', summary: 'Port 8790 als Standard gesetzt',
    options: [{ key: '8790', label: '8790', detail: '' }, { key: '3000', label: '3000', detail: '' }],
  }),
]

// Numbers follow creation order, like the server assigns them.
;[...cards].sort((a, b) => a.created - b.created).forEach((c, i) => { c.number = i + 1 })

const messages = [
  { id: 'm1', from: 'user', text: 'Bau die mobile Ansicht fertig und bereite den Deploy vor.', ts: now - 100 * min },
  { id: 'm2', from: 'agent', attachments: [], ts: now - 99 * min,
    text: 'Mache ich. Plan:\n\n- **Datenbank** festlegen\n- mobile Ansicht mit Tabs\n- Migration schreiben und Deploy vorbereiten\n\nFragen lege ich dir als Karten aufs Board.' },
  { id: 'm3', from: 'event', kind: 'asked', card_id: 'c-db', text: 'Welche Datenbank?', ts: now - 95 * min },
  { id: 'm4', from: 'event', kind: 'decided', card_id: 'c-db', text: 'Postgres', ts: now - 80 * min },
  { id: 'm5', from: 'agent', attachments: [], ts: now - 60 * min,
    text: 'Postgres läuft im Container. Verbindung getestet mit:\n\n```\ndocker compose exec db psql -U board -c "select 1"\n```' },
  { id: 'm6', from: 'event', kind: 'asked', card_id: 'c-next', text: 'Was baue ich als Nächstes?', ts: now - 30 * min },
  { id: 'm7', from: 'event', kind: 'asked', card_id: 'c-theme', text: 'Welches Standard-Theme?', ts: now - 22 * min },
  { id: 'm8', from: 'agent', attachments: [attach('board-desktop.png')], ts: now - 16 * min,
    text: 'So sieht die Desktop-Ansicht gerade aus. Die mobile Ansicht ist als Nächstes dran.' },
  { id: 'm9', from: 'event', kind: 'asked', card_id: 'c-phone', text: 'Wie soll das Board auf dem Handy starten?', ts: now - 15 * min },
  { id: 'm9b', from: 'event', kind: 'urgency', card_id: 'c-phone', text: 'Dringend: Ich baue gerade an der mobilen Ansicht', ts: now - 10 * min },
  { id: 'm10', from: 'user', text: 'Sieht gut aus. Wie weit ist der Deploy?', ts: now - 6 * min },
  { id: 'm11', from: 'agent', attachments: [], ts: now - 5 * min,
    text: 'Fast fertig. Es fehlt nur die Migration auf der Produktions-Datenbank, dafür brauche ich deine Entscheidung. Ich habe die Karte nach oben geschoben, weil der Deploy darauf wartet.' },
  { id: 'm12', from: 'event', kind: 'asked', card_id: 'c-migrate', text: 'Migration auf der Produktions-Datenbank ausführen?', ts: now - 4 * min },
  { id: 'm13', from: 'user', text: 'Okay, schaue ich mir an.', ts: now - 1 * min },
]

// Open cards, most urgent first: permission requests, then by urgency, then oldest first.
const queue = ['c-perm', 'c-migrate', 'c-phone', 'c-theme', 'c-next']

// The status strip: one line per work stream, as the agent reports them.
const tasks = [
  { id: 'deploy', label: 'Deploy', state: 'decision', detail: 'Wartet auf die Entscheidung zur Migration', card_id: 'c-migrate', updated: now - 4 * min },
  { id: 'mobile', label: 'Mobile Ansicht', state: 'working', detail: 'Tab-Leiste steht, Startansicht offen', card_id: null, updated: now - 9 * min },
  { id: 'tests', label: 'Tests', state: 'working', detail: '42 von 48 grün', card_id: null, updated: now - 2 * min },
  { id: 'db', label: 'Datenbank', state: 'done', detail: 'Postgres läuft im Container', card_id: null, updated: now - 60 * min },
]

fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ messages, cards, tasks, queue, next_number: cards.length + 1 }, null, 2))
