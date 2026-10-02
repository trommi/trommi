// A scripted stand-in for a Claude Code session, to see the board with several
// agents without spending tokens. It speaks real MCP to a real server.mjs, so
// hub, spokes and routing are exercised exactly as with real sessions; only
// the "thinking" is canned.
//   node dev/fake-agent.mjs web|api|infra|ios|docs
// Environment: BOARD_PORT, BOARD_DATA, BOARD_HOST, BOARD_TOKEN as for server.mjs.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const demo = name => path.join(root, 'demo', name)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const PERSONAS = {
  web: {
    name: 'Web-Frontend', model: 'Claude Opus 5.5', task: 'Mobile Ansicht fertigstellen',
    intro: 'Ich baue die **mobile Ansicht** fertig. Zwei Fragen liegen auf dem Stapel, an der Tab-Leiste arbeite ich schon weiter.',
    status: [['mobile', 'Mobile Ansicht', 'working', 'Tab-Leiste steht'], ['theme', 'Themes', 'working', 'hell und dunkel fertig']],
    cards: [
      { title: 'Wie soll das Board auf dem Handy starten?', urgency: 'high', urgency_reason: 'Ich baue gerade an der mobilen Ansicht', status: 'mobile',
        body: 'Auf dem Handy passt nur eine Ansicht auf den Bildschirm.',
        attachments: [demo('phone-gespraech.png'), demo('phone-entscheidungen.png')],
        options: [['gespraech', 'Mit dem Gespräch', 'Wie eine Chat-App'], ['entscheidungen', 'Mit den Entscheidungen', 'Offene Fragen zuerst'], ['zuletzt', 'Wo ich zuletzt war', 'Merkt sich die letzte Ansicht']] },
      { title: 'Welches Standard-Theme?', urgency: 'normal', status: 'theme',
        body: 'Beide Themes sind fertig. Ich brauche nur den Standard für neue Nutzer.',
        attachments: [demo('thema-hell.png'), demo('thema-dunkel.png')],
        options: [['hell', 'Hell', 'Besser lesbar bei Tageslicht'], ['dunkel', 'Dunkel', 'Passt zu Terminal und IDE'], ['system', 'Dem System folgen', 'Richtet sich nach dem Gerät']] },
      { title: 'Soll ich die alte Navigation löschen?', urgency: 'normal', status: null,
        body: 'Sie wird seit dem Umbau nirgends mehr verwendet.',
        options: [['ja', 'Löschen', ''], ['nein', 'Behalten', '']] },
      { title: 'Lade-Animation beim Start zeigen?', urgency: 'low', status: null,
        options: [['ja', 'Ja', ''], ['nein', 'Nein', ''], ['kurz', 'Nur kurz', 'Höchstens 300 ms']] },
    ],
  },
  api: {
    name: 'API', model: 'Claude Sonnet 5.5', task: 'Migration und Deploy vorbereiten',
    intro: 'Die Migration ist geschrieben und lokal getestet. Für die Produktion brauche ich dein Okay, der Deploy hängt daran.',
    status: [['migration', 'Migration', 'working', 'lokal grün'], ['tests', 'Tests', 'working', '42 von 48 grün']],
    cards: [
      { title: 'Migration auf der Produktions-Datenbank ausführen?', urgency: 'critical', urgency_reason: 'Deploy wartet, alles Weitere hängt davon ab', status: 'migration',
        body: 'Die Migration `2026_10_02_add_urgency` fügt eine Spalte hinzu und füllt **48.210 Zeilen** nach. Geschätzte Dauer: 40 Sekunden, währenddessen ist die Tabelle gesperrt.\n\n```\nALTER TABLE cards ADD COLUMN urgency text NOT NULL DEFAULT \'normal\';\n```',
        options: [['run-now', 'Jetzt ausführen', 'Kurze Sperre, Deploy läuft danach durch'], ['tonight', 'Heute Nacht um 02:00', 'Kein Nutzer betroffen, Deploy wartet bis morgen'], ['batch', 'In Schritten ohne Sperre', 'Etwa zwei Stunden Umbau am Skript'], ['cancel', 'Nicht ausführen', 'Ich nehme die Änderung zurück']] },
      { title: 'Darf ich die fehlschlagenden Tests überspringen?', urgency: 'high', urgency_reason: 'Sechs Tests blockieren den Merge', status: 'tests',
        body: 'Alle sechs hängen an der Migration und werden danach wieder grün.',
        options: [['skip', 'Überspringen', ''], ['fix', 'Erst reparieren', '']] },
      { title: 'Antwortzeit-Limit der API anheben?', urgency: 'normal', status: null,
        body: 'Der Export braucht bei großen Konten bis zu 45 Sekunden, das Limit liegt bei 30.',
        options: [['60', '60 Sekunden', ''], ['30', 'Bei 30 bleiben', ''], ['async', 'Export asynchron', 'Größerer Umbau']] },
    ],
  },
  infra: {
    name: 'Infrastruktur', model: 'Claude Haiku 4.5', task: 'Backups und Monitoring einrichten',
    intro: 'Backups laufen, das Monitoring ist eingerichtet. Eine Frage zur Aufbewahrung, sie eilt nicht.',
    status: [['backup', 'Backups', 'done', 'täglich um 03:00'], ['monitoring', 'Monitoring', 'working', 'Alarme fehlen noch']],
    cards: [
      { title: 'Wie lange sollen Backups aufbewahrt werden?', urgency: 'low', status: null,
        body: 'Ein tägliches Backup ist etwa **1,2 GB** groß.',
        options: [['7', '7 Tage', 'Rund 8 GB Speicher'], ['30', '30 Tage', 'Rund 36 GB Speicher'], ['90', '90 Tage', 'Rund 108 GB Speicher']] },
      { title: 'Wohin sollen Alarme gehen?', urgency: 'normal', status: 'monitoring',
        options: [['board', 'Hierher aufs Board', 'Als dringende Karte'], ['mail', 'Per E-Mail', 'An die Betriebsadresse'], ['beides', 'Beides', '']] },
      { title: 'Zertifikat läuft in 9 Tagen ab. Jetzt erneuern?', urgency: 'high', urgency_reason: 'Danach zeigt der Browser eine Warnung', status: null,
        options: [['ja', 'Erneuern', ''], ['spaeter', 'Später', '']] },
    ],
  },
}

const yesNo = (title, body, yes, no, extra = {}) => ({ title, body, urgency: 'normal', status: null, options: [[yes.toLowerCase(), yes, ''], [no.toLowerCase(), no, '']], ...extra })
PERSONAS.web.cards.push(
  yesNo('Schriftgröße auf dem Handy um eine Stufe anheben?', 'Die Karten sind auf kleinen Geräten knapp lesbar.', 'Anheben', 'Lassen'),
  yesNo('Darf ich das alte CSS-Raster entfernen?', '', 'Entfernen', 'Behalten', { urgency: 'low' }),
)
PERSONAS.api.cards.push(
  yesNo('Rate-Limit auf 120 Anfragen pro Minute setzen?', 'Bisher gibt es keines.', 'Setzen', 'Noch nicht'),
  yesNo('Fehlerberichte an Sentry schicken?', 'Der Zugang liegt schon in den Secrets.', 'Ja', 'Nein', { urgency: 'low' }),
)
PERSONAS.infra.cards.push(
  yesNo('Staging-Server über Nacht herunterfahren?', 'Spart etwa 40 Prozent der Kosten.', 'Ja', 'Nein'),
)
Object.assign(PERSONAS, {
  ios: {
    name: 'iOS-App', model: 'Claude Opus 5.5', task: 'Native App in SwiftUI bauen',
    intro: 'Das Grundgerüst der App steht: Posteingang, Karte, Gespräch. Ein paar schnelle Fragen liegen im Posteingang.',
    status: [['core', 'Kernlogik', 'done', 'Modelle und Tests'], ['ui', 'Oberfläche', 'working', 'Posteingang fertig']],
    cards: [
      yesNo('Haptik beim Entscheiden einschalten?', 'Ein kurzer Impuls, wenn eine Karte entschieden ist.', 'Einschalten', 'Weglassen'),
      yesNo('Soll die App auch auf dem iPad laufen?', 'Kostet etwa einen Tag für das Layout.', 'Ja', 'Später', { urgency: 'high', urgency_reason: 'Bestimmt das Projekt-Setup' }),
      yesNo('Face ID vor dem Öffnen verlangen?', '', 'Ja', 'Nein'),
      yesNo('Mindestens iOS 17 voraussetzen?', 'Erlaubt das neue Observation-Framework.', 'Ja', 'Nein', { urgency: 'low' }),
    ],
  },
  docs: {
    name: 'Dokumentation', model: 'Claude Haiku 4.5', task: 'README und Handbuch aktualisieren',
    intro: 'Das README ist überarbeitet. Drei Kleinigkeiten brauche ich von dir.',
    status: [['readme', 'README', 'done', 'überarbeitet'], ['handbuch', 'Handbuch', 'working', 'Kapitel 2 von 5']],
    cards: [
      yesNo('Englische Fassung des README anlegen?', '', 'Anlegen', 'Nur Deutsch'),
      yesNo('Screenshots im README einbetten?', 'Fünf Bilder, zusammen etwa 2 MB.', 'Einbetten', 'Verlinken'),
      yesNo('Changelog ab jetzt führen?', '', 'Ja', 'Nein', { urgency: 'low' }),
    ],
  },
})

const persona = PERSONAS[process.argv[2]]
if (!persona) {
  console.error('usage: node dev/fake-agent.mjs web|api|infra|ios|docs')
  process.exit(1)
}

const client = new Client({ name: 'fake-agent', version: '0' }, { capabilities: {} })
const call = async (name, args) => (await client.callTool({ name, arguments: args })).content?.[0]?.text ?? ''
const statusOfCard = new Map()   // card id -> status line id

client.fallbackNotificationHandler = async ({ method, params }) => {
  if (method !== 'notifications/claude/channel') return
  const { kind, card_id: cardId, choice } = params.meta ?? {}
  await sleep(900)
  if (kind === 'chat') {
    await call('reply', { text: `Verstanden: „${params.content}“. Ich bin ein simulierter Agent und antworte nach Drehbuch.` })
  } else if (kind === 'decision') {
    const line = statusOfCard.get(cardId)
    await call('reply', { text: `Alles klar, ich setze **${choice}** um.` })
    await sleep(4000)
    await call('close_card', { card_id: cardId, summary: `„${choice}“ umgesetzt` })
    if (line) await call('set_status', { id: line, state: 'done', detail: `„${choice}“ umgesetzt` })
  } else if (kind === 'decision_reopened') {
    await call('reply', { text: 'Zurückgenommen. Ich warte auf deine neue Wahl.' })
  } else if (kind === 'scribble') {
    await call('reply', { text: `Scribble erhalten. Das Bild liegt unter \`${params.meta.image_path}\`.` })
  }
}

await client.connect(new StdioClientTransport({
  command: 'node', args: [path.join(root, 'server', 'server.mjs')],
  env: { ...process.env, BOARD_AGENT: persona.name },
  stderr: 'inherit',
}))

await sleep(300 + Math.random() * 400)
// Boards started before the overview existed do not know this tool.
await call('introduce', { model: persona.model, task: persona.task }).catch(() => {})
for (const [id, label, state, detail] of persona.status) await call('set_status', { id, label, state, detail })
await call('reply', { text: persona.intro })
for (const card of persona.cards) {
  const { status, options, ...rest } = card
  const out = await call('create_decision', { ...rest, options: options.map(([key, label, detail]) => ({ key, label, detail })) })
  const id = out.match(/^card (\w+) /)?.[1]
  if (id && status) {
    statusOfCard.set(id, status)
    await call('set_status', { id: status, state: 'decision', card_id: id })
  }
  await sleep(500)
}
console.error(`[fake-agent] ${persona.name} is up`)
// Stay connected until killed.
process.stdin.resume()
