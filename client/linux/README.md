# Trommi für Linux

Ein natives Fenster für ein Trommi-Board: der Posteingang mit den offenen Fragen der Agenten, die einzelne Frage mit ihren Antworten, und die Gespräche der Sitzungen. Gebaut mit Qt 6 und Qt Quick (QML), wie das Fenster von [brumm](https://github.com/chriopter/brumm). Warum, steht in [docs/entscheidung.md](docs/entscheidung.md).

Die Oberfläche ist englisch, wie das Board selbst. Was die Agenten schreiben, bleibt in ihrer Sprache.

![Posteingang](docs/inbox.png)

![Die Frage als Fenster](docs/question.png)

Der Stand folgt dem Web-Client (`client/web/`): derselbe Aufbau, dieselben Tasten, dieselben gekritzelten Zeichen. Bedienelemente und Flächen sind schlicht; von Hand gezeichnet ist nur der Akzent (die Zeichen der Sitzungen, die Krone, die Hand, der Ring, die kleinen Symbole, der Markerstrich hinter dem Rat des Agenten).

## Bauen

Braucht `qt6-base`, `qt6-declarative` und einen C++-Compiler (`base-devel`). Mit `libsecret` liegt der Link im Schlüsselbund, ohne in einer Datei.

```sh
bin/build       # baut build/app/trommi
bin/test        # Tests ohne Fenster und ohne echten Server
bin/test-live   # dieselbe Bibliothek gegen einen echten Server mit Demodaten (Port 8817)
bin/shot x.png ["TASTEN"] [BxH]   # Bildschirmfoto ohne Bildschirm, mit Demodaten
```

## Starten

```sh
build/app/trommi                              # fragt beim ersten Mal nach dem Link
build/app/trommi 'http://host:8790/?t=TOKEN'  # Link als Argument
build/app/trommi --demo tests/fixtures/board-state.json  # ohne Server, zum Ausprobieren
build/app/trommi --status [--follow]          # eine Zeile JSON für waybar, ohne Fenster
build/app/trommi --forget                     # den gespeicherten Link vergessen
```

Der Link steht in `data/url.txt` des Boards. Nach der ersten Anmeldung liegt er im Schlüsselbund (Secret Service), sonst in `~/.config/trommi/board` mit den Rechten 0600. Ein zweiter Start öffnet kein zweites Fenster, sondern holt das erste nach vorn. Die Wayland-App-ID ist `trommi` (für Fensterregeln in Hyprland), im Flatpak `com.trommi.Trommi`.

Hell oder dunkel folgt dem Desktop (Portal, sonst Qt, sonst Omarchys Theme). `TROMMI_THEME=dark|light` erzwingt eines, `T` schaltet im Fenster um.

## Was das Fenster kann

- **Posteingang**, nach Absender gruppiert. Jede Zeile ist gleich hoch, die Antwort steht rechts: zwei Daumen bei einer Frage mit zwei Antworten, sonst ein breites „Choose“, das die Zeile an Ort und Stelle aufklappt (viele kurze Antworten als kleine Marken). Unten an der Zeile hängt die Marke „Later“. Jede Karte zeigt ihre Nummer („Nr. 12“).
- **Antworten gehen sofort raus**: die Zeile verschwindet, die Anfrage reist hinterher. Ein Zettel unten links sagt, was geschah, und nimmt es einige Sekunden lang zurück („Back“, Taste `U`). Lehnt der Server ab, steht die Karte wieder da, mit dem Grund. Hat der Agent die Frage inzwischen umformuliert (HTTP 409), sagt die Zeile das.
- **Stapel am Fuß**: „Later“ (aufgeschoben, bleibt über Neustarts erhalten), „With the agent“ (zurückgegeben oder „Explain“; kommt mit der Antwort der Sitzung von selbst wieder, der Server führt das als `card.with_agent`) und „Answered“ (die letzten 40 Antworten, jede mit „Take back“).
- **Die Frage als Fenster**: links die Frage als Gespräch (Text oder Abschnitte, dazu was über die Frage geschrieben wurde), rechts die Antworten, unten ein Feld mit Send, Explain, Back to agent und Later. Ohne Karte geöffnet ist es der Gang durch alle offenen Fragen, mit der Leiste links, die zeigt, wie weit man ist.
- **Mehrere Antworten** (`multiple`): ankreuzen, dann „Send“. Was angekreuzt, aber nicht gesendet ist, liegt als Entwurf auf dem Server (`/draft`).
- **Sitzungen**: jede mit ihrem gekritzelten Zeichen (dieselben Striche wie im Web und auf iOS, geprüft gegen deren Vorlagen), die wichtige mit einer kleinen Krone. Am Ende der Zeile steht ihr Zustand: rote Hand (wartet auf dich), grüner Ring mit Zahl (arbeitet), grau (getrennt). Eine Sitzung auf eine andere ziehen legt sie zusammen, zwischen zwei ziehen ordnet sie um, die Schere trennt ein Paar; Rechtsklick setzt die Krone.
- **Gespräch** einer Sitzung, mit Tabellen, Code und den Markern des Boards; `Q` zeigt nur ihre offenen Fragen.
- **Pad** (`P`): öffnet das Pad des Web-Clients im Browser.

Noch nicht hier: Diktat (der Server kann es unter `/speech/live`), Bilder und Dateien an Karten und Nachrichten, das Zurückblättern durch frühere Fassungen einer Karte, Notizen an einzelnen Antworten, das Umbenennen und Archivieren von Sitzungen, die Zeichenfläche.

## Tasten

Wie im Web-Client (`client/web/js/keys.js`): einfache Tasten und „G, dann …“, nichts mit Strg oder Alt; beim Tippen in einem Feld ruhen sie. `?` zeigt die Tasten, die gerade gelten.

| Wo | Taste | Was |
|---|---|---|
| Überall | `?` | diese Liste |
| | `P` oder `G` `P` | das Pad, im Browser |
| | `G` `I` | Posteingang |
| | `G` `F` | Focus: alle offenen Fragen der Reihe nach |
| | `G` `1`…`9` | diese Sitzung der Seitenleiste |
| | `.` / `,` | nächste / vorige Sitzung |
| | `U` / `⌫` | Back: die letzte Antwort zurücknehmen |
| | `T` | hell oder dunkel |
| | `Strg+Q` | beenden |
| Liste | `J` / `K`, `↓` / `↑` | Frage wählen; nach der letzten die Stapel (`Enter` klappt einen auf) |
| | `Pos1` / `Ende` | erste / letzte |
| | `Y` / `N` | Daumen hoch / runter |
| | `Enter` / `C` | Antworten aufklappen, oder die Frage als Fenster |
| | `←` / `→`, `1`…`9`, `Leertaste` | durch die aufgeklappten Antworten, eine wählen |
| | `Enter` | senden, wo mehrere Antworten erlaubt sind |
| | `A` | zurückfragen statt antworten |
| | `E` | Explain: erst alles zeigen, dann die Sitzung bitten zu erklären |
| | `L` | später, oder zurückholen |
| | `U` / `⌫` | auf einer beantworteten Zeile: die Antwort zurücknehmen |
| | `Esc` | zuklappen, dann die Markierung fallen lassen |
| Fenster | `→` / `J`, `←` / `K` | nächste / vorige Frage, ohne zu antworten |
| | `Y` / `N`, `1`…`9` | antworten |
| | `Enter` | senden, wo mehrere Antworten erlaubt sind |
| | `C`, dann `↓` / `↑` | zu den Antworten, durch sie hindurch |
| | `A` | der Sitzung zur Frage schreiben |
| | `E` | Explain |
| | `B` | Back to agent: die Frage zurückgeben, mit dem, was im Feld steht |
| | `L` | später, weiter zur nächsten |
| | `U` / `⌫` | Back |
| | `Esc` | aus dem Feld, dann schließen |
| Sitzung | `R` | der Sitzung schreiben (`Enter` sendet, `Umschalt+Enter` neue Zeile) |
| | `Q` | nur ihre Fragen, und zurück |
| | `O` | die andere Sitzung eines Paars |

Nicht übernommen: `G` `A` (die Seite aller Agenten gibt es hier nicht), `V` (Diktat), `F` (Dateien), `S` (Zeichenfläche); `V` und `F` sagen das im Fenster.

## Aufbau

- `core/`: Protokoll und Regeln ohne Fenster, nur QtCore und QtNetwork. Link und Cookie (`link`), der Zustand mit vorsichtigem Dekodieren (`model`), Reihenfolge, Gruppen, Stapel, Kacheln, Paare, Wortlaut (`logic`), leichtes Markdown mit Tabellen (`markdown`), die gekritzelten Zeichen (`doodle`, eine Übertragung von `doodle()`, `sketch()`, `pairDoodle()` aus `client/web/js/ui.js`), Anmeldung, Ereignisstrom mit Wiederverbinden und alle POSTs (`client`).
- `app/src/`: was das Fenster braucht. `board` reicht den Zustand an QML und hält, was unterwegs ist (Antworten, „Later“, der Zettel mit „Back“), `theme` die Farben aus `client/web/css/tokens.css`, `secrets` den Schlüsselbund, `notifier` die Benachrichtigungen.
- `app/qml/`: die Oberfläche. `Nav.qml` hält, wo man ist und was jede Taste tut; `Scribble.qml` zeichnet alles Gekritzelte.
- `tests/`: `core` und `live` (Client gegen einen Ersatz-Server und gegen den echten), `fixtures/` (zwei Zustände, die Striche des Web-Clients).
- `tools/`: `doodle-data.mjs` schreibt die Punkte der Zeichnungen aus `ui.js` nach `core/doodle_data.inc`, `doodle-fixtures.mjs` schreibt auf, was das Web zeichnet. Beide neu laufen lassen, wenn sich `ui.js` ändert; der Test `scribblesMatchTheWeb` sagt, ob es nötig ist.
- `packaging/`: Skizzen für Arch und Flatpak, `trommi.desktop` liegt daneben im Wurzelordner.

## Was geprüft ist

- Alles baut ohne Warnung (Qt 6.11.2, GCC 16.2.1); beim Laufen kommt keine Warnung von QML.
- `bin/test`: 50 Fälle im Kern (Dekodieren aller heutigen Felder, Reihenfolge, Gruppen, Stapel, „With the agent“, Paare, Zustände der Sitzungen, Markdown mit Tabellen, Link, Cookie, Ereignisstrom), darunter der Vergleich der gekritzelten Zeichen Strich für Strich mit dem, was das Web zeichnet (76 Zeichen, 30 Symbole, Paare, Krone, Hand, Ring, der Markerstrich hinter dem Rat des Agenten), auch gegen die Vorlage des iOS-Clients. Dazu 7 Fälle gegen einen Ersatz-Server: Anmeldung, falsches Token, abgerissener Strom, und was jeder POST heute trägt (`keys`, `revised`, `card_id`, `handback`, `explain`, `/draft`, `/star`, `/session`), samt der Ablehnung mit 409.
- `bin/test-live`: 12 Fälle, drei davon gegen `dev/serve.sh` (echter Server) mit einer eigenen Sitzung, die den Agenten spielt: Anmeldung, Antworten, Zurücknehmen, Nachricht; mehrere Antworten, Entwurf, eine Karte, die der Agent umformuliert, während geantwortet wird (409, dann erneut gelesen und angenommen), Zurückgeben (`with_agent`), Paar, Krone, Umordnen.
- Das Fenster wurde ohne Bildschirm gerendert (`QT_QPA_PLATFORM=offscreen`, Software-Renderer) und die Bilder angesehen: Posteingang hell und dunkel, aufgeklappte Zeile, die drei Stapel zu und offen, das Fenster einer Frage mit Gespräch, mit mehreren Antworten, mit Marken, mit Abschnitten, der Gang mit Leiste, Sitzung mit Tabelle, „Questions only“, ein Paar, schmales Fenster, die Tasten. Tasten wurden dabei über `TROMMI_KEYS` eingespielt, auch gegen einen echten Server mit drei Agenten (`dev/trio.sh`): die Antworten kamen dort an.
- `--status` gegen den Demo-Server (Runde eins).

## Was nicht geprüft ist

- Das Fenster lief noch nie auf einem echten Bildschirm: nicht unter Hyprland, nicht mit Wayland, nicht mit der GPU. Echte Tastendrücke, Maus, Fokus, Skalierung sind ungesehen. Der drehende Tropfen im Ring ebenso.
- Ziehen mit der Maus in der Seitenleiste (Paar, Umordnen): was danach geschieht, ist geprüft (über `TROMMI_KEYS="pair:2:1 move:3:1"`), das Ziehen selbst nicht.
- Das Pad im Browser: der Aufruf ist geschrieben, geöffnet hat ihn noch niemand.
- Benachrichtigungen und der Schlüsselbund über libsecret: gebaut, nie in echt ausgelöst.
- `packaging/PKGBUILD` und die Flatpak-Datei sind Skizzen und wurden nicht gebaut.

## Nächste Schritte

Einmal auf dem echten Bildschirm ansehen. Dann: Diktat (`/speech/live`), Bilder und Dateien, frühere Fassungen einer Karte, Notizen an einzelnen Antworten, Sitzungen umbenennen und archivieren. Dazu ein eigenes Icon, ein waybar-Beispiel und ein Paket.
