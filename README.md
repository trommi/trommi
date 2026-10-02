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
- Der Posteingang zeigt die offenen Fragen aller Sitzungen, eine einzelne Sitzung ihr Gespräch mit ihren Fragen darin (siehe „The web UI“).
- Ein Agent sieht und ändert nur seine eigenen Karten und Statuszeilen.
- Die Seite „Agents“ (in der Leiste unten) zeigt je Sitzung Modell, Rechner, Ordner und Programm. Mit dem Stern markierst du eine Sitzung als VIP; ihre Fragen stehen im Posteingang oben.
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
| `create_decision`, `revise_card`, `merge_cards`, `set_urgency`, `withdraw_card`, `close_card` | Karten im Posteingang, im Stapel und im Gespräch |
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
- `revise_card(card_id, title, body, options, attachments, urgency, urgency_reason, recommended, multiple, note)`: eine eigene offene Karte an Ort und Stelle umschreiben; nur angeben, was sich ändert. Die Karte behält Kennung, Nummer und Platz, bekommt den Zeitstempel `revised`, und im Gespräch steht „Question revised“ mit `note`. Entschiedene Karten lassen sich nicht umschreiben. Eine Antwort gilt für die Fassung, die der Mensch gelesen hat: `POST /decide` kann `revised` mitschicken (der Stand, den die Seite kennt); passt er nicht, gibt es die gewählte Option nicht mehr oder liegt die Änderung weniger als 1,5 Sekunden zurück (`BOARD_REVISE_GRACE_MS`), antwortet der Hub mit 409 und einem lesbaren Grund, und nichts wird gespeichert.
- `merge_cards(card_ids[], title, body, options, attachments, urgency, urgency_reason, recommended, multiple)`: mehrere eigene offene Karten in einem Schritt durch eine neue ersetzen, typisch mit `multiple: true` und einer Option je früherer Frage. Die alten Karten sind erledigt („Merged into Nr. …“, `merged_into`), die neue nennt in `merged_from` ihre Nummern und Titel, übernimmt die höchste Dringlichkeit und das Alter der ältesten. Rückfragen zu den alten Karten bleiben im Gespräch.
- **Ein Textblock statt `body` + `options`.** `create_decision`, `revise_card` und `merge_cards` nehmen die ganze Frage auch als einen gegliederten Text: als `sections` (Liste von Blöcken) oder als `text` (ein String). Ein Block ohne `key` ist Fließtext; ein Block mit `key` ist ein markierter Absatz und wird zur Option. Der Hub leitet daraus `options` (`{key, label, detail: ''}`), `recommended` und `body` ab (Absätze als Markdown, markierte mit fettem Label voran) und speichert die Blöcke als `card.sections`; die Seite zeigt jeden Absatz mit seiner Option verbunden. Die Antwort kommt unverändert als `choice` / `choices`. `sections` oder `text` zusammen mit `options` oder `body` wird abgelehnt, ebenso ein `picture`, das die Karte nicht als Anhang hat. Der Vertrag für Clients steht in [docs/question-contract.md](docs/question-contract.md).

  ```json
  { "title": "Was soll in den Export?", "multiple": true, "attachments": ["/abs/skizze.png"],
    "sections": [
      { "text": "Der Export läuft bei großen Konten ins Limit. Kreuze an, was ich bauen darf." },
      { "key": "limit", "label": "Limit anheben", "recommended": true, "text": "60 statt 30 Sekunden. Schnell gemacht, verschiebt die Grenze nur." },
      { "key": "async", "label": "Im Hintergrund", "picture": "skizze.png", "text": "Die Datei kommt per Mail. Etwa zwei Tage." }
    ] }
  ```

  Dasselbe als `text`: Absätze sind durch eine Leerzeile getrennt; ein Absatz, der mit `[key]` beginnt, ist eine Option. `[key] Label: Erklärung`; ohne Doppelpunkt ist die erste Zeile das Label, die folgenden Zeilen erklären. `[key*]` oder `(recommended)` hinter dem Label markiert die Empfehlung, eine letzte Zeile `picture: datei.png` (Dateiname oder Position ab 0) bindet einen Anhang an die Option. Alles andere ist Fließtext. Für Absätze, die selbst Leerzeilen enthalten (Code-Blöcke), `sections` nehmen.

  ```
  Der Export läuft bei großen Konten ins Limit. Kreuze an, was ich bauen darf.

  [limit*] Limit anheben: 60 statt 30 Sekunden. Schnell gemacht, verschiebt die Grenze nur.

  [async] Im Hintergrund: Die Datei kommt per Mail. Etwa zwei Tage.
  picture: skizze.png

  [page] Export blättern
  Kleinere Dateien, aber jeder Abnehmer der API muss mitziehen.
  ```

  `revise_card` mit `sections` oder `text` ersetzt Text und Optionen; mit `body` oder `options` wird die Karte wieder eine einfache (die Blöcke entfallen, das Ergebnis sagt es); ohne beides bleiben die Blöcke stehen, und `recommended` zieht ihre Markierung nach.
- **Notiz je Option.** Der Mensch kann zu jeder Option etwas schreiben, auch zu einer nicht gewählten: `POST /decide {card_id, key | keys, note, notes: {"<key>": "Text"}}`. Die Karte speichert sie als `option_notes`, das Ereignis „decided“ nennt sie, und der Agent bekommt sie im Text des Kanal-Ereignisses (nach der allgemeinen Notiz: `Notes on options:` und je Notiz eine Zeile `- Label [key], chosen|not chosen: Text`); das Attribut `option_notes="a,b"` nennt die Schlüssel. Unbekannte Schlüssel und Notizen über 2000 Zeichen werden abgelehnt.
- **Entwürfe.** `POST /draft {card_id, keys: [...], note, notes: {...}}` merkt sich auf der offenen Karte, was angekreuzt und geschrieben, aber nicht gesendet ist (`card.draft = {keys, note, notes, ts}`); ein leerer Entwurf löscht ihn. Er ist Teil des Zustands, den jede Seite bekommt, also auf jedem Gerät derselbe. Der Agent erfährt nichts davon. Er verschwindet mit der Antwort, beim Zurückziehen, Zusammenführen und Schließen; schreibt der Agent die Karte um, fällt heraus, was nicht mehr existierende Optionen betrifft. Wird eine Antwort zurückgenommen (`POST /reopen`), wird sie zum Entwurf: Haken und Notizen sind wieder da.
- Der Hub erinnert, ohne abzulehnen: Wer eine Frage stellt, während schon drei eigene offen sind, bekommt im Ergebnis den Hinweis auf `merge_cards` und `revise_card` samt Liste seiner offenen Karten; ist der Text über 300 Zeichen oder ein `detail` über 60 Zeichen lang, steht auch das im Ergebnis. Bei Karten aus Blöcken gilt stattdessen: ein einzelner Block über etwa 400 Zeichen wird genannt. Und: Eine Frage, die nach Aussehen klingt (Design, Layout, Farbe, Button, Icon, Sidebar, Mockup, Variante, Schrift, Logo …) und weder Anhang noch Link trägt, bekommt den Hinweis, ein Bild je Option (`<irgendwas>-<key>.png`) oder eine Seite zum Ausprobieren nachzureichen. Die Anweisungen an die Agenten verlangen das von vornherein: Fragen zu Oberfläche und Gestaltung nie nur in Worten, und auch die Erklärung dazu mit Bild.
- **Eine Frage bleibt eine Karte.** Jedes `revise_card`, das Wortlaut, Optionen, Blöcke, Empfehlung oder Anhänge ändert, bewahrt die abgelöste Fassung in `card.versions` (älteste zuerst, höchstens die letzten 20; `card.version` zählt ab 1, die Dateien alter Fassungen bleiben abrufbar, solange die Karte lebt). Das Ereignis „revised“ trägt `version`. Gibt der Mensch eine Karte zurück (`POST /message {text, agent, card_id, handback: true}`, für „What??“ `explain: true`), steht das an der Nachricht, der Agent bekommt `handback="1"` bzw. `explain="1"`, und die Karte trägt `with_agent` (Zeitstempel), bis der Agent sie umschreibt oder mit dieser `card_id` antwortet. Das Umschreiben nach einer Rückgabe legt die Karte neu vor („Presented again“, `again: true`). Eine Antwort merkt sich in `answered_version`, welcher Fassung sie galt. Die Anweisungen verlangen vom Agenten: nach Rückgabe oder Rückfrage die Karte überarbeiten, keine neue Frage stellen.
- `create_info(title, body | sections | text, attachments, html, urgency, urgency_reason)`: etwas zum Lesen statt einer Frage, eine dritte Kartenart (`kind: "info"`, `options: []`): eine Erklärung, ein Bericht, ein Befund. Sie liegt im Stapel (bei gleicher Dringlichkeit hinter den Fragen), fragt aber nichts. Der Mensch liest und schließt sie mit `POST /close {card_id}`: Die Karte ist sofort erledigt (`read`), im Gespräch steht „read“, und der Agent bekommt still `<channel source="board" kind="info_read" card_id="…">`. Rückfrage, „What??“ und Rückgabe gehen wie bei einer Frage, `revise_card` überarbeitet sie (mit Fassungen), `POST /reopen` legt sie ungelesen zurück; `merge_cards`, `/decide` und `/draft` nehmen sie nicht.
- **Symbol der Sitzung.** `introduce(model, task, icon)`: Der Agent wählt die Zeichnung, die zu seiner Aufgabe passt; die Namen mit Bedeutung stehen in der Tool-Beschreibung und unter `drawings` in `/api/tools` und kommen aus `client/web/drawings.json` (`[{name, meaning, hue}]`, bei Änderung neu gelesen; fehlt die Datei, gilt jeder Name aus Kleinbuchstaben). Unbekannte Namen werden mit der Liste abgelehnt. Ein von Hand gewähltes Symbol (`POST /session {agent, icon}`, `icon_by: "human"`) überschreibt der Agent nie.
- **Bild mit Seite.** Überall, wo Agenten `attachments` übergeben, ist ein Eintrag ein Pfad oder `{path, page, title}`. `page` ist die Seite, aus der das Bild entstanden ist: der Pfad einer eigenständigen HTML-Datei (der Hub legt sie neben das Bild und liefert sie unter `/files/…​.html` aus, als Seite, aber in einer Sandbox mit eigenem Ursprung: `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; …`, also ohne Cookies und ohne Zugriff aufs Board) oder ein Pfad auf dem Board, ein Asset-Link oder eine URL (als Link gespeichert). Der Anhang trägt dann `page: {url, kind: "file" | "link"}` und optional `title`. Liegt neben `foo.png` eine `foo.html`, verknüpft der Hub beide von selbst und sagt es im Ergebnis.
- **Reihenfolge der Sitzungen.** `POST /session {agent, before: "<id>" | null}` stellt eine Sitzung direkt vor eine andere (`null`: ans Ende). `state.agents` steht in dieser Reihenfolge, jede Sitzung trägt `position`; neue kommen ans Ende, Mitglieder einer Gruppe ziehen gemeinsam um. Der Stapel und die Sortierung des Posteingangs bleiben davon unberührt.
- `set_urgency(card_id, urgency, reason)`: Dringlichkeit einer offenen Karte ändern; die Karte rückt im Stapel entsprechend vor oder zurück
- `withdraw_card(card_id, reason)`: offene Frage zurückziehen, die sich erledigt hat
- `set_status(id, label, state, detail, card_id)`: eine Zeile der Statusleiste anlegen oder ändern. `decision` = rot (wartet auf dich), `working` = gelb (in Arbeit), `done` = grün (umgesetzt). Mit `card_id` springt die rote Zeile zur Karte und wird nach deiner Antwort von selbst gelb.
- `clear_status(id)`: eine Zeile entfernen, ohne `id` alle
- `close_card(card_id, summary)`: entschiedene Karte nach „Erledigt“ schieben
- `create_voiceover(text, style)`: Text als MP3 sprechen lassen, gibt den Dateipfad zurück (für Videos oder als Anhang)
- `list_cards()`: Stand aller Karten mit Nummer, Dringlichkeit und Platz im Stapel; offene Karten mit Text, Optionen und gegebenenfalls `sections`, damit der Agent vor einer neuen Frage sieht, was er schon gefragt hat
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

## The web UI

Hand-written ES modules and CSS in `client/web/`, English, light unless the human picks dark. Three places: the **Inbox**, one **session** (or several laid together), and the **Agents** page.

**Inbox.** Every open question of every session, grouped by who asks; a starred session's group comes first, then whoever has the most urgent question. Every row is the same height (148px) with its answer at the right edge, always in the same place, so after an answer the next row stands under the pointer.

- **Thumbs or Choose.** A two-way question is answered by thumb: down on the left, up on the right. The option's own word stands under its thumb when the pair says more than yes and no, whole, in at most two lines; a label that would not fit that way sends the card to Choose instead (`fitsTile` in `inbox.js` is the one rule). Everything else gets one wide **Choose**.
- **Inline expansion.** Choose unfolds the row in place: the text, every option as a tile, and a line to ask back. Only a card with too much for that (long text, code, several pictures, files, more than six options) opens as a window of its own, the Focus window; a tap on a row's text opens that window too.
- **Multi-select.** A card made with `multiple: true` has options that toggle and a Send tile that sends them together (`POST /decide {card_id, keys}`).
- **The agent's advice.** The option named in `recommended` is circled by hand; the human still decides.
- **Ask back.** Instead of answering, write a question to the session about this card (`POST /message {text, agent, card_id}`). The card stays open and waits under Later until the session has replied; message and reply are marked "About <question>" in the conversation.
- **Later.** A small tag with an arrow hangs over the bottom edge of every row. It puts the question off: the row leaves its sender's group for one dashed group, **Later**, at the very end, so working down the list comes to an end. The same tag fetches it back. What was put off is kept in this browser; a card the agent makes more urgent returns by itself.
- **Undo.** An answer can be taken back for a few seconds from the note that says "Answered" ("Back"), and later with "Answer again" in the list of answered questions. The card returns to the stack and the agent is told to stop acting on the old choice.
- **VIP.** A starred session is marked once: its scribble on gold and a small tab at its group's heading, and the tab in the title of its own page. Its rows stay as plain as any other. The word lives in `VIP_LABEL` (`inbox.js`).
- **Urgency.** Blocking and Urgent carry a coloured tab at the row's corner, Normal carries none, Whenever a small scribbled hourglass. One colour per urgency drives tint, text and edge of the whole row.

**A session.** One conversation, with the session's questions inside it: while a question is open it stands in the log as the same row as in the inbox, right where it was asked; once answered it shrinks to one line that names the question and the answer. Two filters in the title lay a list over the log and keep its scroll position: **Questions only** (the open ones, then the answered ones, each unfolding what was asked, what was chosen, and the way to answer again) and **Files** (everything the session sent: pictures, video, audio, files, scribbles, links, published assets). The second mode of a session is **Scribble**, its canvas. On a phone the two modes are a tab bar.

- **Published assets.** A message that carries an `asset` is a card: type, size, title, note, "Open" in a new tab, "Copy link"; once revoked or expired it is dashed and opens nothing. A link to an asset inside any text (`…/a/<id>#<key>`) becomes a compact card with the asset's title, its type and, for a picture, a small preview; the key is never printed. Other long links are shortened to host and start of path.
- **The picture is the way to the drawing.** A click on a session's mark opens forty drawings right under it; one click picks and saves (`POST /session {agent, icon: "draw:<name>"}`). A click on the name renames.

**Sidebar.** The inbox on top, the sessions below, disconnected ones under a dashed heading. The badge at the end of a row tells the state: a ring circled by hand with the number of open questions while the session works (a drop travels through the ring; under reduced motion it stands still), a raised hand in a red loop when it is stopped waiting for the human, grey when it is disconnected. Sessions of the same name get a second line that tells them apart: the folder, else the machine, else since when.

- **Pairs.** Drag one session onto another and they become one entry with a joint mark and one page: their conversations side by side, each with its own composer (on a phone one column, the names switch). Grab a name or a scribble inside the entry and carry it out, and that session stands alone again; the scissors under the badge cut the whole group apart; the Agents page has "Put together with…" and "Split". The server keeps it (`group` on the session), so every browser shows the same pairs.
- **Archive.** A disconnected session can be put away (the box on its row, or "Archive" on the Agents page; `POST /session {agent, archived: true}`). Its questions leave the inbox; it is listed under Archive on the Agents page, comes back with "Fetch back", and by itself when it reconnects.

**Addresses.** Every place has a real address, so a reload and a shared link land on it: `/` the inbox, `/agents`, `/s/<id>` a session, `/s/<a>+<b>` sessions laid together, `/s/<id>/questions`, `/s/<id>/files`, `/s/<id>/scribble`, and `?q=<card id>` on any of them for that question in its own window.

**Keyboard.** The inbox can be worked down without the mouse: the arrows pick a row, letters answer it, put it off or open its choices, and one key takes the last answer back. `?` (or "Keys" in the bar) shows every key; they are defined in one place, `js/keys.js`.

Answered cards are deleted after 30 days together with their attachments and their markers in the conversation (`BOARD_RETENTION_DAYS`). Open cards stay.

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

In `client/web/js/`: `store.js` holds the state and what is in scope (the inbox, a session, a group), `app.js` the page, its addresses and the theme, `inbox.js` the question rows and the lists made of them, `chat.js` the conversation with its filters and the asset cards, `history.js` the answered questions and the files, `agents.js` the sidebar, the badges, pairs, the Agents page and the choice of drawing, `ui.js` the shared helpers and everything drawn by hand (session marks, icons, the advice loop, links to assets), `focus.js` the window of one question, `scribble.js` the canvas, `keys.js` the keys, `speech.js` dictation and reading aloud.

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
