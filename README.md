# Trommi

Prototyp: Chat und Entscheidungskarten im Browser, verbunden mit einer oder mehreren Claude-Code-Sessions über einen Channel. Die Agenten legen Fragen als Karten ab, der Mensch beantwortet sie nacheinander von einem gemeinsamen Stapel, die dringendste zuerst. Offene Ideen stehen in `TODO.md`.

## Starten

```bash
cd ~/git/trommi
claude --dangerously-load-development-channels server:board
```

Claude Code startet `server.mjs` selbst. Der Server lauscht auf allen Netzwerkschnittstellen und verlangt ein Token. Die fertigen Links (localhost und LAN-Adresse) stehen in `data/url.txt`:

```bash
cat data/url.txt
```

Einmal pro Browser öffnen, danach merkt sich ein Cookie den Zugang.

Für ein anderes Projekt den Server mit absolutem Pfad in dessen `.mcp.json` eintragen:

```json
{ "mcpServers": { "board": { "command": "node", "args": ["/home/christopher/git/trommi/server.mjs"] } } }
```

## Technik

- **Server:** Node.js (ab Version 22), eine Datei `server.mjs`, ohne Framework. Einzige Abhängigkeiten: `@modelcontextprotocol/sdk` und `zod`.
- **Verbindung zu Claude Code:** ein Channel, also ein MCP-Server über stdio mit der Erweiterung `claude/channel`.
- **Browser:** handgeschriebene ES-Module und CSS, kein Framework, kein Build-Schritt. Live-Daten über Server-Sent Events, Zeichnen auf `<canvas>`, Schriften von Google Fonts.
- **Speicher:** JSON-Datei und Dateien im Ordner `data/`, keine Datenbank.
- **Sprache:** Tinfoil (OpenAI-kompatible API) für Erkennung und Stimme.
- **iOS:** SwiftUI-App im Ordner `ios/` (im Aufbau).
- **Zugang:** Token im Link, danach Cookie; unterwegs über Tailscale (`tailscale serve` für HTTPS).

Was wir uns bei anderen abgeschaut haben, steht in `docs/gelernt.md`.

## Mehrere Agenten

Jede Session, die den Channel lädt, startet ihr eigenes `server.mjs`. Der erste Prozess bekommt den Port und wird zum Hub: Er hält den Zustand und liefert die Oberfläche aus. Jeder weitere verbindet sich als Speiche mit dem Hub und erscheint als eigener Agent in der Seitenleiste. Endet die Session des Hubs, übernimmt eine Speiche den Port; der Zustand liegt in `data/` und geht dabei nicht verloren.

- Der Name eines Agenten ist der Ordnername seiner Session, oder `BOARD_AGENT`.
- „Alle“ zeigt eine Übersicht und einen Stapel mit den Fragen aller Agenten. Ein einzelner Agent zeigt sein Gespräch und nur seine Karten.
- Ein Agent sieht und ändert nur seine eigenen Karten und Statuszeilen.
- Die Übersicht (unten in der Seitenleiste) zeigt je Sitzung Modell, Rechner, Ordner und Programm. Mit dem Stern markierst du eine Sitzung als VIP; ihre Fragen stehen im Posteingang oben.
- Nachrichten an einen Agenten, dessen Session gerade nicht läuft, warten, bis er wieder da ist.

Zum Ansehen ohne echte Sessions: `dev/trio.sh 8795` startet drei Agenten nach Drehbuch auf einem eigenen Board, `dev/join.sh` hängt fünf an ein laufendes Board.

## Was der Channel liefert und was nicht

Ein Channel ist schmal. Trommi zeigt alles an, was darüber kommt:

| Kommt über den Channel | So erscheint es |
| - | - |
| `reply` mit Text | Nachricht im Gespräch, Markdown wird dargestellt |
| `reply` mit `details` | aufklappbarer Abschnitt „Details“ unter der Nachricht: Begründung, Protokolle, Diffs |
| `reply` mit `attachments` | Bilder als Galerie, Video und Audio zum Abspielen, sonst Download |
| `create_decision`, `set_urgency`, `withdraw_card`, `close_card` | Karten im Posteingang, im Stapel und im Gespräch |
| `set_status`, `clear_status` | Ampel-Zeilen der Sitzung |
| `introduce` | Modell und Auftrag in der Agenten-Übersicht |
| Freigabe-Anfragen von Claude Code | Karten mit Erlauben und Ablehnen |
| Name des Programms beim Verbinden | „Programm“ in der Agenten-Übersicht |

**Nicht über den Channel kommen:** die Denkschritte des Modells, seine Tool-Aufrufe, die Ausgabe im Terminal und der laufende Text. Der Agent sieht selbst, was er denkt, aber ein MCP-Server bekommt davon nichts. Wer das im Board sehen will, braucht einen zweiten Weg: Hooks, das Agent SDK oder den Zustand aus herdr (siehe `TODO.md`). Bis dahin gilt die Regel in den Anweisungen an den Agenten: Was der Mensch wissen soll, gehört in `reply`, die Begründung in `details`.

## Was der Agent bekommt

| Ereignis | Form |
| - | - |
| Chatnachricht | `<channel source="board" kind="chat">Text</channel>` |
| Entscheidung | `<channel source="board" kind="decision" card_id="…" choice="KEY">Anmerkung</channel>` |
| Zurückgenommen | `<channel source="board" kind="decision_reopened" card_id="…" previous_choice="KEY">` |
| Scribble | `<channel source="board" kind="scribble" scribble_id="…" image_path="/abs/pfad.png">Bildunterschrift</channel>` |

## Was der Agent tun kann

- `reply(text, details, attachments[Pfade])`: Nachricht in den Chat; `details` erscheint eingeklappt darunter, Anhänge als Bilder, Video, Audio oder Datei
- `introduce(model, task)`: sich vorstellen, für die Agenten-Übersicht
- `create_decision(title, body, options[{key, label, detail}], attachments[Pfade], urgency, urgency_reason)`: Karte anlegen
- `set_urgency(card_id, urgency, reason)`: Dringlichkeit einer offenen Karte ändern; die Karte rückt im Stapel entsprechend vor oder zurück
- `withdraw_card(card_id, reason)`: offene Frage zurückziehen, die sich erledigt hat
- `set_status(id, label, state, detail, card_id)`: eine Zeile der Statusleiste anlegen oder ändern. `decision` = rot (wartet auf dich), `working` = gelb (in Arbeit), `done` = grün (umgesetzt). Mit `card_id` springt die rote Zeile zur Karte und wird nach deiner Antwort von selbst gelb.
- `clear_status(id)`: eine Zeile entfernen, ohne `id` alle
- `close_card(card_id, summary)`: entschiedene Karte nach „Erledigt“ schieben
- `create_voiceover(text, style)`: Text als MP3 sprechen lassen, gibt den Dateipfad zurück (für Videos oder als Anhang)
- `list_cards()`: Stand aller Karten mit Nummer, Dringlichkeit und Platz im Stapel

Tool-Freigaben erscheinen ebenfalls als Karten (Erlauben/Ablehnen).

## Stapel und Dringlichkeit

Der Mensch sieht immer eine Karte, die oberste. Die Reihenfolge legt der Server fest (`queue` im Zustand): Freigaben zuerst, dann nach Dringlichkeit, bei gleicher Dringlichkeit die älteste zuerst.

| Stufe | Bedeutung |
| - | - |
| `critical` | Der Agent ist blockiert, nichts geht weiter |
| `high` | Blockiert die aktuelle Aufgabe |
| `normal` | Wird bald gebraucht (Standard) |
| `low` | Gut zu wissen, nichts hängt daran |

Freigaben sind immer `critical`. Jede Karte bekommt beim Anlegen eine fortlaufende Nummer, die nie neu vergeben wird. Ändert der Agent die Stufe, erscheint das als Ereignis im Gespräch. Entschiedene Karten lassen sich nicht zurückziehen; der Agent schließt sie mit `close_card`.

Zustandsdateien der Vorversion werden beim Start übernommen: fehlende Nummern, Dringlichkeiten und der Stapel werden ergänzt.

## Entscheiden

Ein Tipp auf eine Option entscheidet sofort. Danach bietet eine Leiste zwölf Sekunden lang „Rückgängig“ an; später geht es im Verlauf über „Neu entscheiden“. Die Karte kommt dann zurück auf den Stapel und der Agent erfährt, dass er die alte Wahl nicht weiter umsetzen soll. Der Fokus-Modus zeigt die offenen Karten nacheinander als ganze Seite.

## Posteingang und Sitzungen

Die Seitenleiste zeigt oben den Posteingang, darunter die Sitzungen. Der Posteingang listet alle offenen Fragen, gruppiert nach Absender: Kurze Fragen (bis drei knappe Optionen, kein Anhang) beantwortest du direkt in der Liste, längere öffnen sich als ganze Seite. Eine Sitzung füllt die Seite mit genau einer von drei Ansichten: **Gespräch** (jede offene Frage steht als Karte an der Stelle, an der sie gestellt wurde), **Fragen** (ihre offenen Fragen ausgeschrieben, darunter der Verlauf der entschiedenen und erledigten) und **Scribble** (ihr Canvas). Umgeschaltet wird in der Leiste unten, auf dem Handy in der Tab-Leiste.

Beantwortete Karten werden nach 30 Tagen samt Anhängen und Markern im Gespräch gelöscht (`BOARD_RETENTION_DAYS`). Offene Karten bleiben.

## Scribble

Jede Sitzung hat ein eigenes, dauerhaftes Canvas: zeichnen, Bilder ablegen, darüber malen, beliebig weit. Der Server speichert es laufend (`data/scribbles/canvas-<sitzung>.json`). „Senden“ schickt dem Agenten zwei Bilder: den Ausschnitt, den du gerade siehst, und das ganze Canvas. Der Agent kann das Canvas also jederzeit als Ganzes ansehen. Was du dazu sagen willst, schreibst du danach ins Gespräch.

## Sprache

Mit einem Tinfoil-Schlüssel (`TINFOIL_API_KEY` oder `data/tinfoil.key`) gibt es ein Mikrofon im Eingabefeld (Diktat), „Vorlesen“ auf jeder Karte und das Tool `create_voiceover`. Ohne Schlüssel fehlen diese Knöpfe. Das Mikrofon gibt der Browser nur auf HTTPS oder localhost frei.

## Aufbau

- `server.mjs`: Channel (MCP über stdio) und Webserver in einem, als Hub oder Speiche
- `public/index.html`, `public/css/`, `public/js/`: die Oberfläche als handgeschriebene ES-Module und CSS, ohne Build-Schritt; `store.js` hält den Zustand und den gewählten Agenten, `focus.js` den Fokus-Modus, `scribble.js` das Canvas, `agents.js` die Seitenleiste, `inbox.js` den Posteingang, `speech.js` Diktat und Vorlesen
- `data/`: Zustand (`state.json`), Anhänge, Token und Links der laufenden Session
- `dev/`: Vorschau ohne Claude-Code-Session

## Vorschau

```bash
dev/serve.sh 8801 600 &                            # Demodaten auf http://localhost:8801/?t=demo, 600 Sekunden lang
dev/shot.sh 8801 /tmp/board.png 1440,900 "/#dark"  # Screenshot mit Chromium
node dev/cdp.mjs "http://localhost:8801/?t=demo" 400,860 'return document.title' /tmp/b.png  # Skript in der Seite ausführen, danach Screenshot
```

```bash
dev/trio.sh 8795 600        # drei simulierte Agenten auf http://<host>:8795/?t=demo
```

`dev/demo-state.mjs` schreibt die Demodaten. Nachrichten und Entscheidungen werden angenommen, aber niemand antwortet, weil kein Agent angeschlossen ist.

## Einstellungen

- `BOARD_PORT` (Standard 8790)
- `BOARD_HOST` (Standard `0.0.0.0`; `127.0.0.1` für nur lokal)
- `BOARD_TOKEN` (Standard: zufällig erzeugt, in `data/token` gespeichert)
- `BOARD_DATA` (Standard `./data`): Zustand und Anhänge
- `BOARD_AGENT` (Standard: Ordnername): Name des Agenten in der Seitenleiste
- `TINFOIL_API_KEY`, `BOARD_STT_MODEL` (Standard `whisper-large-v3-turbo`), `BOARD_TTS_MODEL` (Standard `qwen3-tts`): Sprachfunktionen
- `BOARD_RETENTION_DAYS` (Standard 30): so lange bleiben beantwortete Karten und ihre Anhänge
- `BOARD_MAX_ATTACHMENT_MB` (Standard 1024): größte Datei, die der Agent anhängen darf

## Anhänge

Der Agent hängt Dateien per absolutem Pfad an `reply` oder `create_decision` an. Bilder erscheinen als Galerie, Videos (mp4, m4v, webm, mov) und Audio (mp3, m4a, wav, ogg, flac) werden direkt abgespielt, alles andere ist ein Download-Link. Videos werden in Teilstücken ausgeliefert, damit Spulen auch auf dem iPhone funktioniert.

## Test

```bash
node test.mjs
```

Der Test startet einen eigenen Server auf Port 8791 mit einem temporären Datenverzeichnis.
