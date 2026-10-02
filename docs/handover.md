# Übergabe: Arbeitsstand Trommi, 2. Oktober 2026

Für den Wechsel auf einen anderen Rechner. Stand: Branch `trommi-board`, gepusht nach `github.com/chriopter/trommi`.

## Auf dem neuen Rechner weitermachen

1. `git clone git@github.com:chriopter/trommi.git ~/git/trommi && cd ~/git/trommi && git switch trommi-board`
2. Node 22.13 oder neuer (hier lief 26.8). `npm install` im Repo.
3. Board-Daten aus dem Nextcloud-Ordner zurückspielen: `data/` nach `~/git/trommi/data/` kopieren. Nicht enthalten sind `tinfoil.key`, `token`, `admin-token` und `url.txt`: Der Tinfoil-Schlüssel muss neu nach `data/tinfoil.key` gelegt werden, Token und Admin-Schlüssel erzeugt der Hub beim ersten Start neu (dann gilt ein neuer Link, siehe `data/url.txt`).
4. Hub starten: `BOARD_HUB_ONLY=1 node server/server.mjs 2>>data/hub.log` (Port 8790). Der Zustand liegt in `data/pad.db` (SQLite); `state.json` ist nur noch die alte Sicherung.
5. Tailscale: nur `tailscale serve`, kein Funnel.
6. Claude-Verläufe: Der Ordner `claude-verlaeufe/` enthält die Sitzungsprotokolle (`*.jsonl`, je Sitzung ein Ordner mit den Subagenten) und `memory/`. Auf dem neuen Rechner nach `~/.claude/projects/<Projektordner>/` legen, wenn die Sitzung fortgesetzt werden soll; die Hauptsitzung von heute ist `1117b1b6-986f-4e35-b4fc-5e609403f366`.

## Arbeitsregeln (stehen auch in `memory/`)

- Christopher liest den Claude-Chat nicht: Fragen als Karten aufs Board (Session „Trommi“), Ergebnisse als Reply oder Info-Karte.
- Der Hauptthread delegiert nur; die Arbeit machen Subagenten, je einer pro Dateibereich.
- UI-Fragen immer mit Bild pro Option und anklickbarer Seite unter `client/web/designs/`.
- Auf Karten nur Optionen, hinter denen man zu etwa 80 % steht; wenige, kurze Texte.
- Bedienelemente schlicht, Handgezeichnetes nur als Akzent, nichts eins zu eins von 37signals.
- Tinfoil-Schlüssel nie in Code, Logs, Browser, Board oder Berichte.
- Open Source: Richtung notiert, nicht final (nur der Kanal-Prozess offen, Hub geschlossen); nichts veröffentlichen, siehe `docs/open-source.md`.

## Wer was besitzt (Dateibereiche der Subagenten)

- Web UI: `inbox.js`, `agents.js`, `bar.js`, `ui.js`, `store.js`, `app.js`, `app.css`
- Fokus/Karte: `focus.js`, `focus-marks.js`, `focus.css`
- Conversation: `chat.js`, `scribble.js`, Composer-CSS
- Layout: `beside.js/css`, `ledger.js/css`
- Tastatur: `keys.js`, `dev/keys-test.mjs`
- Schnellsenden (Memo): `quicksend.js/css`; Entscheidung kopieren: `cardclip.js/css`
- Server: `server/`; QA: `dev/ui-test.mjs`, `docs/qa-report.md`

Stand je Bereich: `client/web/STATUS-ui.md`, `STATUS-layout.md`, `STATUS-focus-scribble.md`.

## Was heute entschieden und gebaut wurde (kurz)

Desk (statt Inbox) oben in der Sidebar mit Menü am Pfeil; Sessions mit gezeichnetem Ring (Zahl, rote Hand, umlaufende Spur beim Arbeiten); Karten je Session unter einem Reiter, in der Farbe der Session; Überschrift „Next, please“ startet den Durchgang; Karte klappt auf dem Desk an Ort und Stelle auf; eine Kartenansicht mit Bühne links und Knopfspalte rechts, Verlauf darunter, ein Schreibfeld am Fuß; oben rechts Snooze, Shred, Kopieren, Lautsprecher, Schließen; neben den Antworten Revise (gibt sofort zurück) und Whatever; Durchgang als eigene Seite, Ein-Tipp-Karten zuerst, beantwortete Karten verschwinden mit Toast; Liste „In revision“ am Fuß des Desks, dazu Answered/Shredded/Snoozed; einzelne Session als ein Strom mit Fragen im Chat; verbundene Sessions „stacked“; Memo-Zettel als schnelle Notiz an die gekrönte Session (genau eine Krone); Entscheidung kopieren und in andere Session einfügen; Scribble als Fläche neben dem Chat; Logo: gescribbeltes Z im offenen Ring; Zustand in SQLite; Snooze auf dem Server; Stack bleibt Node + reine ES-Module.

## Offen

Die vollständige Liste: `docs/open-work.md` (Abgleich „entschieden gegen gebaut“), `docs/qa-report.md` (Runde drei, Runde vier lief beim Wechsel), `docs/qa-dark-phone.md`, `TODO.md`. Zuletzt in Arbeit:

- Scribble-Fläche: Galerie aller Assets der Session oben zum Herausziehen; Bereich markieren, als Bild **und** als Rohdaten (Strichpositionen) an den Agenten senden, danach ist der Bereich gelöscht; Radierer soll auch Bilder löschen.
- Desk-Block in der Sidebar noch etwas tiefer setzen.
- Tests: zwei veraltete Prüfungen zur Reihenfolge im Durchgang, eine zur Scribble-Ansicht, eine zum Umbenennen auf dem Handy.
- Unter-Sitzungen (Karte Nr. 123): auf dem Board freigegeben, die Freigabe im Claude-Prompt steht noch aus.
- Später (Tech): Nachrichtenprotokoll, stabile Agenten-IDs und Pairing, Kanal-Prozess aus `server.mjs` herauslösen, Backup-Skript für SQLite, iOS, neue Screenshots für die Landingpage.
- Entwürfe: `docs/marketing.md` und `/designs/landing.html` (Überschrift entschieden), `docs/open-source.md`.
