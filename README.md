# Trommi

Prototyp: Chat und Entscheidungskarten im Browser, verbunden mit einer oder mehreren Claude-Code-Sessions über einen Channel. Die Agenten legen Fragen als Karten ab, der Mensch beantwortet sie nacheinander von einem gemeinsamen Stapel, die dringendste zuerst. Offene Ideen stehen in `TODO.md`.

## Starten

```bash
cd ~/git/trommi
claude --dangerously-load-development-channels server:board
```

Claude Code startet `server/server.mjs` selbst (eingetragen in `.mcp.json`). Der Server lauscht auf allen Netzwerkschnittstellen und verlangt ein Token. Die fertigen Links (localhost und LAN-Adresse) stehen in `data/url.txt`:

```bash
cat data/url.txt
```

Einmal pro Browser öffnen, danach merkt sich ein Cookie den Zugang.

Für ein anderes Projekt den Server mit absolutem Pfad in dessen `.mcp.json` eintragen:

```json
{ "mcpServers": { "board": { "command": "node", "args": ["/home/christopher/git/trommi/server/server.mjs"] } } }
```

## Technik

- **Server:** Node.js (ab Version 22), eine Datei `server.mjs`, ohne Framework. Einzige Abhängigkeiten: `@modelcontextprotocol/sdk` und `zod`.
- **Verbindung zu Claude Code:** ein Channel, also ein MCP-Server über stdio mit der Erweiterung `claude/channel`.
- **Browser:** handgeschriebene ES-Module und CSS, kein Framework, kein Build-Schritt. Live-Daten über Server-Sent Events, Zeichnen auf `<canvas>`, Schriften von Google Fonts.
- **Speicher:** JSON-Datei und Dateien im Ordner `data/`, keine Datenbank.
- **Sprache:** Tinfoil (OpenAI-kompatible API) für Erkennung und Stimme.
- **iOS:** SwiftUI-App im Ordner `client/ios/` (im Aufbau).
- **Zugang:** Token im Link, danach Cookie; unterwegs über Tailscale (`tailscale serve` für HTTPS).

Was wir uns bei anderen abgeschaut haben, steht in `docs/gelernt.md`.

## Mehrere Agenten

Jede Session, die den Channel lädt, startet ihr eigenes `server.mjs`. Der erste Prozess bekommt den Port und wird zum Hub: Er hält den Zustand und liefert die Oberfläche aus. Jeder weitere verbindet sich als Speiche mit dem Hub und erscheint als eigener Agent in der Seitenleiste. Endet die Session des Hubs, übernimmt eine Speiche den Port; der Zustand liegt in `data/` und geht dabei nicht verloren.

- Der Name eines Agenten ist der Ordnername seiner Session, oder `BOARD_AGENT`.
- „Alle“ zeigt eine Übersicht und einen Stapel mit den Fragen aller Agenten. Ein einzelner Agent zeigt sein Gespräch und nur seine Karten.
- Ein Agent sieht und ändert nur seine eigenen Karten und Statuszeilen.
- Die Übersicht (unten in der Seitenleiste) zeigt je Sitzung Modell, Rechner, Ordner und Programm. Mit dem Stern markierst du eine Sitzung als VIP; ihre Fragen stehen im Posteingang oben.
- Nachrichten an einen Agenten, dessen Session gerade nicht läuft, warten, bis er wieder da ist.
- Eine abwesende Sitzung lässt sich archivieren (`POST /session {agent, archived: true}`): Ihre offenen Karten bleiben erhalten, verlassen aber den Stapel, bis sie wieder hervorgeholt wird oder sich neu verbindet. Für eine Sitzung, die online ist, wird das abgelehnt. Mit `group` (freier Text, höchstens 40 Zeichen, `null` löscht) bilden Sitzungen mit demselben Wert ein Paar.

**Eigener Hub.** Mit `BOARD_HUB_ONLY=1` ist der Prozess nur Hub: Er hält den Zustand und liefert die Oberfläche, meldet sich aber nicht selbst als Sitzung an und braucht kein Claude Code an stdin. So läuft ein Hub als Dienst, ohne Phantom-Sitzung in der Seitenleiste. Ist der Port besetzt, wartet er und versucht es fünfmal pro Sekunde wieder. Ein solcher Hub behält den Port: Sitzungen, die er begrüßt hat, übernehmen ihn nicht, wenn er endet, sondern verbinden sich neu, sobald er wieder da ist. `GET /healthz` antwortet ohne Anmeldung mit `{"ok":true}`. Die Routen der Speichen (`/agent/…`) gelten nur für Prozesse auf demselben Rechner; Anfragen, die ein Proxy wie `tailscale serve` weiterreicht (`X-Forwarded-For`, `Tailscale-User-Login`), werden dort abgelehnt. Betrieb als Dienst: `docs/operations.md`.

```bash
BOARD_HUB_ONLY=1 node server/server.mjs
```

Zum Ansehen ohne echte Sessions: `dev/trio.sh 8795` startet drei Agenten nach Drehbuch auf einem eigenen Board, `dev/join.sh` hängt fünf an ein laufendes Board.

## Was der Channel liefert und was nicht

Ein Channel ist schmal. Trommi zeigt alles an, was darüber kommt:

| Kommt über den Channel | So erscheint es |
| - | - |
| `reply` mit Text | Nachricht im Gespräch, Markdown wird dargestellt |
| `reply` mit `details` | aufklappbarer Abschnitt „Details“ unter der Nachricht: Begründung, Protokolle, Diffs |
| `reply` mit `attachments` | Bilder als Galerie, Video und Audio zum Abspielen, sonst Download |
| `create_decision`, `set_urgency`, `withdraw_card`, `close_card` | Karten im Posteingang, im Stapel und im Gespräch |
| `publish_asset` | Nachricht mit einem Link auf die verschlüsselte Seite oder Datei |
| `set_status`, `clear_status` | Ampel-Zeilen der Sitzung |
| `introduce` | Modell und Auftrag in der Agenten-Übersicht |
| Freigabe-Anfragen von Claude Code | Karten mit Erlauben und Ablehnen |
| Name des Programms beim Verbinden | „Programm“ in der Agenten-Übersicht |

**Nicht über den Channel kommen:** die Denkschritte des Modells, seine Tool-Aufrufe, die Ausgabe im Terminal und der laufende Text. Der Agent sieht selbst, was er denkt, aber ein MCP-Server bekommt davon nichts. Wer das im Board sehen will, braucht einen zweiten Weg: Hooks, das Agent SDK oder den Zustand aus herdr (siehe `TODO.md`). Bis dahin gilt die Regel in den Anweisungen an den Agenten: Was der Mensch wissen soll, gehört in `reply`, die Begründung in `details`.

Das Bild dazu, alle Ereignisse mit ihren Feldern und jedes Tool mit Beispiel zeigt die Seite `/help.html` (englisch, hinter der Anmeldung). Die Liste dort kommt aus dem laufenden Server (`GET /api/tools`), dieselben Tabellen, die der Agent bekommt. Das Bild allein: `/help.html#diagram`, als Datei in `demo/channel-api.png`.

## Was der Agent bekommt

| Ereignis | Form |
| - | - |
| Chatnachricht | `<channel source="board" kind="chat">Text</channel>` |
| Rückfrage zu einer Karte | `<channel source="board" kind="chat" card_id="…">Text</channel>`; die Karte bleibt offen |
| Entscheidung | `<channel source="board" kind="decision" card_id="…" choice="KEY">Anmerkung</channel>` |
| Entscheidung mit mehreren Antworten | zusätzlich `choices="A,B"`: alle gewählten Schlüssel, durch Komma getrennt; `choice` ist der erste |
| Zurückgenommen | `<channel source="board" kind="decision_reopened" card_id="…" previous_choice="KEY">`, bei mehreren Antworten zusätzlich `previous_choices` |
| Scribble | `<channel source="board" kind="scribble" scribble_id="…" image_path="/abs/pfad.png">Bildunterschrift</channel>` |

## Was der Agent tun kann

- `reply(text, details, attachments[Pfade], card_id)`: Nachricht in den Chat; `details` erscheint eingeklappt darunter, Anhänge als Bilder, Video, Audio oder Datei. Mit `card_id` gehört die Antwort zu einer Karte, zu der der Mensch zurückgefragt hat (`POST /message {text, agent, card_id}`).
- `introduce(model, task)`: sich vorstellen, für die Agenten-Übersicht
- `create_decision(title, body, options[{key, label, detail}], attachments[Pfade], urgency, urgency_reason, recommended, multiple)`: Karte anlegen. Mit `multiple: true` darf der Mensch mehrere Optionen ankreuzen (`POST /decide {card_id, keys: [...]}`); die Karte speichert `choices` und als `choice` die erste. `recommended` ist ein Schlüssel oder, bei `multiple`, eine Liste.
- `set_urgency(card_id, urgency, reason)`: Dringlichkeit einer offenen Karte ändern; die Karte rückt im Stapel entsprechend vor oder zurück
- `withdraw_card(card_id, reason)`: offene Frage zurückziehen, die sich erledigt hat
- `set_status(id, label, state, detail, card_id)`: eine Zeile der Statusleiste anlegen oder ändern. `decision` = rot (wartet auf dich), `working` = gelb (in Arbeit), `done` = grün (umgesetzt). Mit `card_id` springt die rote Zeile zur Karte und wird nach deiner Antwort von selbst gelb.
- `clear_status(id)`: eine Zeile entfernen, ohne `id` alle
- `close_card(card_id, summary)`: entschiedene Karte nach „Erledigt“ schieben
- `create_voiceover(text, style)`: Text als MP3 sprechen lassen, gibt den Dateipfad zurück (für Videos oder als Anhang)
- `list_cards()`: Stand aller Karten mit Nummer, Dringlichkeit und Platz im Stapel
- `publish_asset(path | content, type, title, note, silent, keep)`: eine Seite oder Datei verschlüsselt ablegen und einen Link zurückbekommen, siehe „Assets und Links“
- `list_assets()`, `revoke_asset(id)`: eigene Assets auflisten, einen Link beenden

Tool-Freigaben erscheinen ebenfalls als Karten (Erlauben/Ablehnen).

## Stapel und Dringlichkeit

Der Mensch sieht immer eine Karte, die oberste. Die Reihenfolge legt der Server fest (`queue` im Zustand): Freigaben zuerst, dann nach Dringlichkeit, bei gleicher Dringlichkeit die älteste zuerst.

| Stufe | Bedeutung |
| - | - |
| `critical` | Der Agent ist blockiert, nichts geht weiter |
| `high` | Blockiert die aktuelle Aufgabe |
| `normal` | Wird bald gebraucht (Standard) |
| `low` | Gut zu wissen, nichts hängt daran |

Im Board heißen die Stufen Blocking, Urgent, Normal und Whenever; alle Texte, die der Server für Menschen erzeugt, sind englisch. Freigaben sind immer `critical`. Jede Karte bekommt beim Anlegen eine fortlaufende Nummer, die nie neu vergeben wird. Ändert der Agent die Stufe, erscheint das als Ereignis im Gespräch. Entschiedene Karten lassen sich nicht zurückziehen; der Agent schließt sie mit `close_card`.

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

```
server/        server.mjs (Channel und Hub in einer Datei) und test.mjs
client/web/    die Web-Oberfläche: statische Dateien, handgeschriebene ES-Module und CSS, kein Build-Schritt
client/ios/    die SwiftUI-App mit Tests
dev/           Demo-Agenten, Vorschau, Screenshots
docs/          Konzepte und Gelerntes
data/          Zustand, Anhänge, Token (nicht in Git)
```

Server und Clients liegen bewusst in einem Repository: Ändert sich die Schnittstelle, werden alle im selben Commit angepasst, und die Tests der Clients laufen gegen den Server aus demselben Stand. Die Web-Oberfläche liefert der Server aus dem Nachbarordner aus; `package.json` bleibt im Wurzelordner, weil Server und `dev/` dieselben Abhängigkeiten nutzen.

In `client/web/js/`: `store.js` hält den Zustand und die gewählte Sitzung, `inbox.js` Posteingang und Fragen, `chat.js` das Gespräch, `focus.js` den Fokus-Modus, `scribble.js` das Canvas, `agents.js` Seitenleiste und Agenten-Übersicht, `history.js` den Verlauf, `speech.js` Diktat und Vorlesen.

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

## Verwaltung

`/admin.html` ist eine Seite für die Person, die den Hub betreibt. Sie zeigt, was der Server tut, und erledigt, wofür sonst eine Shell nötig wäre:

- **Übersicht:** Version, Hub-Prozess, Adresse, Größe des Datenordners, Zahl der Nachrichten und Karten.
- **Sitzungen:** jede bekannte Sitzung; eine abwesende lässt sich vergessen (auf Wunsch samt Gespräch, Karten und Dateien), Wartendes lässt sich verwerfen.
- **Aufräumen:** was die Frist als Nächstes löscht, und verwaiste Dateien (auch in `data/assets/`); beides zeigt erst die Anzahl.
- **Zugang:** die Anmelde-Links zum Kopieren, und ein neues Token. Danach müssen sich alle Browser und Apps neu anmelden; laufende Sitzungen der Agenten arbeiten weiter. Ist das Token über `BOARD_TOKEN` gesetzt, wird es nicht getauscht.
- **Daten:** der Zustand als JSON (ohne Token, Schlüssel der Verwaltung und wartende Benachrichtigungen; mit den Einträgen der Assets, also auch mit dem Link jedes Assets, das im Board erscheint) und ein Protokoll der letzten 300 Handgriffe in `data/admin-log.jsonl`.
- **Diagnose:** die letzten 200 Zeilen des Hubs auf stderr, offene Seiten, Verbindung jeder Sitzung.

Die Seite verlangt neben der Anmeldung am Board einen zweiten Schlüssel, weil der Link zum Board auf vielen Geräten liegt und nicht reichen soll, um Daten zu löschen:

```bash
cat data/admin-token
```

Der Schlüssel gilt zwölf Stunden pro Browser und bis zum nächsten Wechsel des Hubs. Alle Routen liegen unter `/admin/api/`, nur der Hub beantwortet sie, und alles, was löscht oder ersetzt, ist ein POST mit dem Feld `confirm`.

## Einstellungen

- `BOARD_PORT` (Standard 8790)
- `BOARD_HOST` (Standard `0.0.0.0`; `127.0.0.1` für nur lokal)
- `BOARD_TOKEN` (Standard: zufällig erzeugt, in `data/token` gespeichert)
- `BOARD_DATA` (Standard `./data`): Zustand und Anhänge
- `BOARD_ADMIN_TOKEN` (Standard: zufällig erzeugt, in `data/admin-token` gespeichert): Schlüssel für die Verwaltung
- `BOARD_PUBLIC_URL`: weitere Adressen des Boards, durch Komma getrennt, etwa der HTTPS-Name aus `tailscale serve`; sie erscheinen in `data/url.txt` und in der Verwaltung
- `BOARD_AGENT` (Standard: Ordnername): Name des Agenten in der Seitenleiste
- `TINFOIL_API_KEY`, `BOARD_STT_MODEL` (Standard `whisper-large-v3-turbo`), `BOARD_TTS_MODEL` (Standard `qwen3-tts`): Sprachfunktionen
- `BOARD_RETENTION_DAYS` (Standard 30): so lange bleiben beantwortete Karten und ihre Anhänge
- `BOARD_MAX_ATTACHMENT_MB` (Standard 1024): größte Datei, die der Agent anhängen darf
- `BOARD_MAX_ASSET_MB` (Standard 64): größtes Asset für `publish_asset`
- `BOARD_HUB_ONLY` (`1`): nur Hub sein, keine eigene Sitzung

## Anhänge

Der Agent hängt Dateien per absolutem Pfad an `reply` oder `create_decision` an. Bilder erscheinen als Galerie, Videos (mp4, m4v, webm, mov) und Audio (mp3, m4a, wav, ogg, flac) werden direkt abgespielt, alles andere ist ein Download-Link. Videos werden in Teilstücken ausgeliefert, damit Spulen auch auf dem iPhone funktioniert.

## Assets und Links

Mit `publish_asset` legt ein Agent eine HTML-Seite, ein Bild, ein Video, eine Audiodatei oder eine beliebige Datei ab und bekommt einen Link: `<board>/a/<id>#<schlüssel>`. Der Link funktioniert ohne Anmeldung am Board. Wer den ganzen Link hat, kann das Asset öffnen, sonst niemand; so lässt es sich weitergeben.

- **Verschlüsselung:** Der Channel-Prozess neben dem Agenten (Hub oder Speiche) würfelt je Asset einen eigenen 256-Bit-Schlüssel und verschlüsselt mit AES-256-GCM, bevor etwas zum Hub geht. Der Schlüssel steht hinter dem `#`; diesen Teil schickt ein Browser nie an einen Server.
- **Umschlag, Version 1:** `"ZWA1"`, 12 Byte Nonce, Chiffretext, 16 Byte Tag. Zusätzliche Daten: `"ZWA1/" + id`, der Blob öffnet sich also nur unter seiner eigenen Adresse. Im Klartext: Länge des Kopfs (uint32, big endian), Kopf als JSON (`v, type, title, name, mime, size, created`), Inhalt, dann Nullen bis zur nächsten Stufe (Padmé, höchstens rund 12 %), damit die Länge wenig verrät. Anders als in `docs/krypto-konzept.md` für Anhänge geplant, ist es ein Stück und nicht 64-KiB-Teile: Der Betrachter entschlüsselt im Speicher, darum die eigene Größengrenze.
- **Auf dem Hub:** nur der Chiffretext in `data/assets/<id>` (id mit 128 Bit Zufall) und ein Eintrag in `state.assets` mit Größe, Zeit, Sitzung und einem leeren Feld `wrapped_key`.
- **Lebensdauer:** Assets werden wie Karten nach `BOARD_RETENTION_DAYS` gelöscht, außer mit `keep: true`. `revoke_asset` löscht sofort. In beiden Fällen behält die Nachricht im Gespräch den Titel und verliert den Link.
- **Betrachter:** `client/web/a.html` mit `js/asset.js`, ausgeliefert unter `/a/<id>`, entschlüsselt mit WebCrypto. Das geht nur über HTTPS oder auf localhost; sonst sagt die Seite das. Bilder, Video und Audio werden angezeigt, alles andere ist ein Download.

**Was der Hub sieht, ehrlich:**

| | Heute | Mit dem Raumschlüssel |
| - | - | - |
| Gespeichertes Asset | nur Chiffretext | nur Chiffretext |
| Asset, das im Board erscheint | **Schlüssel, Titel und Notiz.** Der Link steht als Nachricht im Gespräch, und Nachrichten sind noch nicht verschlüsselt. Er liegt damit auch in `state.json` und im Export der Verwaltung. | nichts: Der Asset-Schlüssel liegt in `wrapped_key`, versiegelt mit AES-256-GCM unter einem per HKDF-SHA-256 aus dem Raumschlüssel abgeleiteten Schlüssel, gebunden an Raum, Epoche und Asset-ID |
| Asset mit `silent: true` | weder Schlüssel noch Titel noch Typ. Der Agent bekommt den Link und gibt ihn selbst weiter. | dasselbe |
| Immer sichtbar | dass es ein Asset gibt, seine ungefähre Größe, wann es abgelegt und abgerufen wurde, von welcher Adresse | |

„Der Hub kann es nicht lesen“ gilt also heute nur für den gespeicherten Blob und für `silent`. Und auch dann nur gegen einen Hub, der speichert und mitliest: Der Hub liefert den Betrachter aus, also das JavaScript, das entschlüsselt. Ein bösartiger Hub könnte einen anderen Betrachter ausliefern, der den Schlüssel beim Öffnen abgreift (Abschnitt 9 im Krypto-Konzept).

**HTML-Seiten gelten als feindlich.** Eine Seite kann von einem Agenten stammen, der etwas Falsches gelesen und geglaubt hat. Der Betrachter läuft unter der Adresse des Boards, wo das Anmelde-Cookie liegt; darum kommt entschlüsselter Inhalt nie in seine eigene Seite:

- Die Seite läuft in einem `iframe` mit `sandbox="allow-scripts"`, ohne `allow-same-origin`: Sie hat keinen eigenen Ursprung, sieht weder den Schlüssel in der Adresse noch das Board noch dessen Cookie, und kann keine Fenster öffnen, keine Formulare absenden, nichts herunterladen und das äußere Fenster nicht umleiten.
- Der Rahmen lädt eine leere Seite mit eigener Content Security Policy (`default-src 'none'`, nur eigene Inline-Skripte und -Stile, Bilder nur als `data:`), in die der Betrachter das HTML schreibt. Die Seite kann nichts aus dem Netz laden und nichts dorthin schicken. Eine veröffentlichte Seite muss deshalb alles selbst mitbringen.
- Der Betrachter selbst darf nur seine drei Dateien laden (`script-src 'self'`, kein Inline-Code, nichts Fremdes, `frame-ancestors 'none'`).
- **Was bleibt:** Die Seite kann beliebiges anzeigen, auch ein nachgebautes Anmeldeformular, und ihren eigenen Rahmen auf eine fremde Adresse umleiten; darüber kann sie Eingaben und ihren eigenen Inhalt nach außen tragen. Sie kann den Tab mit Rechenlast bremsen. Der Betrachter warnt deshalb unter jeder Seite: nichts Geheimes eintippen.

## Adressen der Oberfläche

Die Oberfläche merkt sich ihren Ort in der Adresse. `/s/<irgendwas>`, `/agents` und `/inbox` liefern dieselbe Seite wie `/`, hinter der Anmeldung. Daneben liefert der Server jede Datei unter `client/web/` aus (html, css, js, mjs, json, png, svg, webp, ico, woff2), auch in Unterordnern wie `designs/` und `pad/`; ein Ordner antwortet mit seiner `index.html`. Punktdateien, Verknüpfungen und Pfade nach außen gibt es nicht, Routen gehen vor Dateien, alles andere bleibt 404. Der Anmelde-Link behält Pfad und weitere Parameter: `/s/api?q=<karte>&t=<token>` führt nach `/s/api?q=<karte>`.

## Test

```bash
node server/test.mjs
```

Der Test startet einen eigenen Server auf Port 8791 mit einem temporären Datenverzeichnis.
