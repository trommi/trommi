# Stand

Laufendes Protokoll, neueste Einträge unten. 2. Oktober 2026.

- Vorgefunden (Arbeit eines unterbrochenen Vorgängers): Qt 6 / QML mit qmake nach dem Vorbild brumm. `core/` (Protokoll, Logik), `app/` (Fenster), `tests/` (33 + 8 Fälle), `bin/`-Skripte. Ohne README, Doku, Starter, Paketnotizen.
- Wahl geprüft: brumm gelesen (Go-Dienst, Fenster in C++/Qt Quick, qmake), installierte Toolkits verglichen, im Netz nachgelesen. Qt 6 / QML bleibt. Begründung in `docs/entscheidung.md`.
- Sauber neu gebaut: keine Warnung. `bin/test` und `bin/test-live` grün.
- Lücke 1 geschlossen: `card.recommended` wurde nirgends gelesen. Jetzt im Modell, an der Kachel und an der Antwort mit einem Ring markiert.
- Lücke 2 geschlossen: „Später“ ließ die Karte in der Gruppe ihres Absenders. Jetzt eine eigene Gruppe ganz unten, die Zeile nennt den Absender, die linke Kachel holt sie zurück.
- Fehler behoben: die Karte in der Einzelansicht war zu niedrig, das Anmerkungsfeld ragte über den Rand.
- Auf Wunsch während der Arbeit: Oberfläche englisch, keine Kartennummern, Reiter „Blocking“ / „Urgent“ / „Approval“, nichts bei normal, kleines „whenever“ bei niedrig, Kacheln „Later | Choose“.
- Bilder ohne Bildschirm gemacht und angesehen (Software-Renderer; OpenGL gibt es in der Sandbox nicht), auch eines gegen den echten Demo-Server.
- Geschrieben: `README.md`, `docs/entscheidung.md`, `trommi.desktop`, `packaging/` (PKGBUILD, Flatpak, Notizen).
- Stand der Tests: 35 Fälle im Kern, 8 gegen den Ersatz-Server, 2 gegen den echten Server.

Offen, ehrlich:

- Noch nie auf einem echten Bildschirm gelaufen (Hyprland, Wayland, GPU, echte Tasten und Maus).
- Benachrichtigung und Schlüsselbund sind gebaut, aber nie in echt ausgelöst worden.
- PKGBUILD und Flatpak nicht gebaut.
- `bin/test-live` beendet nur das Startskript; der Demo-Server dahinter läuft bis zu 60 Sekunden weiter und endet dann von selbst.
- Nicht enthalten: Anhänge, Zeichenfläche, Sprache, Agenten-Übersicht, Verschlüsselung.
