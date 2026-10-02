# Trommi für Linux

Ein natives Fenster für ein Trommi-Board: der Posteingang mit den offenen Fragen der Agenten, die einzelne Frage mit ihren Antworten, und die Gespräche der Sitzungen. Gebaut mit Qt 6 und Qt Quick (QML), wie das Fenster von [brumm](https://github.com/chriopter/brumm). Warum, steht in [docs/entscheidung.md](docs/entscheidung.md).

Die Oberfläche ist englisch, wie das Board selbst. Was die Agenten schreiben, bleibt in ihrer Sprache.

![Posteingang](docs/inbox.png)

## Bauen

Braucht `qt6-base`, `qt6-declarative` und einen C++-Compiler (`base-devel`). Mit `libsecret` liegt der Link im Schlüsselbund, ohne in einer Datei.

```sh
bin/build       # baut build/app/trommi
bin/test        # Tests ohne Fenster und ohne echten Server
bin/test-live   # dieselbe Bibliothek gegen einen echten Server mit Demodaten (Port 8817)
bin/shot x.png  # Bildschirmfoto ohne Bildschirm, mit Demodaten
```

## Starten

```sh
build/app/trommi                              # fragt beim ersten Mal nach dem Link
build/app/trommi 'http://host:8790/?t=TOKEN'  # Link als Argument
build/app/trommi --demo tests/fixtures/demo-state.json   # ohne Server, zum Ausprobieren
build/app/trommi --status [--follow]          # eine Zeile JSON für waybar, ohne Fenster
build/app/trommi --forget                     # den gespeicherten Link vergessen
```

Der Link steht in `data/url.txt` des Boards. Nach der ersten Anmeldung liegt er im Schlüsselbund (Secret Service), sonst in `~/.config/trommi/board` mit den Rechten 0600. Ein zweiter Start öffnet kein zweites Fenster, sondern holt das erste nach vorn. Die Wayland-App-ID ist `trommi` (für Fensterregeln in Hyprland).

Hell oder dunkel folgt dem Desktop (Portal, sonst Qt, sonst Omarchys Theme). `TROMMI_THEME=dark|light` erzwingt eines.

## Tasten

`?` zeigt sie im Fenster.

| Wo | Taste | Was |
|---|---|---|
| Überall | `Tab` / `Umschalt+Tab` | nächster / voriger Ort (Posteingang, Sitzungen) |
| | `i` | Posteingang |
| | `u` | Antwort zurücknehmen (10 Sekunden lang) |
| | `r` | jetzt neu verbinden |
| | `Strg+Q` | beenden |
| Posteingang | `j` / `k`, `↓` / `↑` | Frage wählen |
| | `g` / `G` | erste / letzte |
| | `y` / `n` | Ja / Nein bei kurzen Fragen, an Ort und Stelle |
| | `s` | später: in die Gruppe „Later“ ganz unten, dort holt `s` sie zurück |
| | `Enter` / `m` | Frage öffnen |
| | `f` | der Reihe nach durchgehen |
| Frage | `1` bis `9` | Antwort wählen, gilt sofort, die nächste Frage kommt |
| | `y` / `n` | Ja / Nein bei kurzen Fragen |
| | `a` | Anmerkung schreiben, sie geht mit der Antwort raus |
| | `j` / `k`, `→` / `←` | nächste / vorige Frage |
| | `s` | später |
| | `↓` / `↑`, Leertaste | blättern |
| | `Esc` | zurück |
| Sitzung | `c` / `Enter` | Nachricht schreiben |
| | `Enter` | senden (`Umschalt+Enter`: neue Zeile) |
| | `j` / `k`, `g` / `G` | blättern, Anfang / Ende |
| | `o` | die dringendste Frage dieser Sitzung öffnen |
| | `Esc` | aus dem Feld, dann zum Posteingang |

## Aufbau

- `core/`: Protokoll und Regeln ohne Fenster, nur QtCore und QtNetwork. Link und Cookie (`link`), der Zustand mit vorsichtigem Dekodieren (`model`), Reihenfolge, Gruppen, Kacheln, Wortlaut (`logic`), leichtes Markdown (`markdown`), Anmeldung, Ereignisstrom mit Wiederverbinden, `/decide`, `/reopen`, `/message` (`client`).
- `app/src/`: was das Fenster braucht. `board` reicht den Zustand an QML, `theme` die Farben aus `client/web/css/tokens.css`, `secrets` den Schlüsselbund, `notifier` die Benachrichtigungen.
- `app/qml/`: die Oberfläche. `Nav.qml` hält, wo man ist und was jede Taste tut.
- `tests/`: `core` (35 Fälle) und `live` (Client gegen einen Ersatz-Server und gegen den echten).
- `packaging/`: Skizzen für Arch und Flatpak, `trommi.desktop` liegt daneben im Wurzelordner.

## Was geprüft ist

- Alles baut ohne Warnung (Qt 6.11.2, GCC 16.2.1).
- `bin/test`: 35 Fälle für Dekodieren, Reihenfolge, Gruppen, „Later“, die empfohlene Antwort, Markdown, Link, Cookie, Ereignisstrom, Wartezeiten, 0600-Datei. Dazu 6 Fälle gegen einen Ersatz-Server im Test selbst: Anmeldung ohne der Umleitung zu folgen, falsches Token, kein Server, abgerissener Strom, kaputter Rahmen, `Origin` und Cookie an jedem POST.
- `bin/test-live`: gegen `dev/serve.sh` (echter Server, Demodaten): Anmeldung, Ereignisstrom, Antworten, Zurücknehmen, Nachricht, falsches Token.
- Das Fenster wurde ohne Bildschirm gerendert (`QT_QPA_PLATFORM=offscreen`, Software-Renderer) und die Bilder angesehen: Posteingang hell und dunkel, „Later“, Frage, Antwort mit „Undo“, Sitzung mit Eingabefeld, schmales Fenster, Hilfe, Anmeldung, und einmal verbunden mit dem echten Demo-Server. Tasten wurden dabei über `TROMMI_KEYS` eingespielt.
- `--status` gegen den Demo-Server.

## Was nicht geprüft ist

- Das Fenster lief noch nie auf einem echten Bildschirm: nicht unter Hyprland, nicht mit Wayland, nicht mit der GPU. Echte Tastendrücke, Maus, Fokus, Skalierung und Kacheln sind ungesehen.
- Benachrichtigungen: der Code ruft `org.freedesktop.Notifications`, welche Karten eine auslösen ist getestet, eine echte Benachrichtigung hat aber noch niemand gesehen. Dasselbe gilt für den Klick darauf.
- Der Schlüsselbund über libsecret: baut und ist eingebunden, lief in Tests und Bildern aber immer mit der Datei.
- Der Wechsel hell/dunkel im laufenden Betrieb und das Nach-vorn-Holen über `hyprctl`.
- `packaging/PKGBUILD` und die Flatpak-Datei sind Skizzen und wurden nicht gebaut. `make install` in ein Verzeichnis wurde ausprobiert.

## Nächste Schritte

Anhänge (Bilder in Zeile und Frage, Dateien), Zeichenfläche, Sprache, die Agenten-Übersicht, Verschlüsselung. Dazu ein eigenes Icon, ein waybar-Beispiel und ein Paket.
