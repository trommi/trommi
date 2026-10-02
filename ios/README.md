# Trommi für iOS

Native App (SwiftUI, iOS 17+) für den Trommi-Server: Posteingang mit allen offenen Entscheidungen, Karten als ganze Seite, Sitzungen mit Gespräch, Diktat und Vorlesen. Keine fremden Abhängigkeiten.

## Projekt erzeugen und starten

Auf einem Mac mit Xcode 16 oder neuer:

```bash
cd ios
brew install xcodegen && xcodegen     # schreibt Trommi.xcodeproj aus project.yml
open Trommi.xcodeproj                  # Schema "Trommi", Simulator wählen, Cmd-R
```

Für ein echtes Gerät in Xcode unter „Signing & Capabilities“ das eigene Team eintragen. Die Projektdatei wird nicht eingecheckt; nach jeder Änderung an `project.yml` oder neuen Dateien `xcodegen` erneut ausführen.

Beim ersten Start den Link aus `data/url.txt` des Servers einfügen (die Zeile mit der Netzwerk-Adresse, nicht `localhost`) oder als QR-Code scannen, zum Beispiel aus `qrencode -t ansiutf8 "$(tail -1 data/url.txt)"`. „Demo ansehen“ zeigt die App ohne Server mit Beispieldaten.

## Testen

```bash
swift test                                   # Kernlogik, läuft auch unter Linux
xcodebuild test -project Trommi.xcodeproj -scheme Trommi \
  -destination 'platform=iOS Simulator,name=iPhone 16'   # Unit- und UI-Tests
```

Gegen einen echten Server (verändert dessen Board, also nur mit Demodaten):

```bash
dev/serve.sh 8801 &                          # im Repo-Wurzelverzeichnis
TROMMI_TEST_LINK='http://127.0.0.1:8801/?t=demo' swift test --filter LiveServerTests
```

Die UI-Tests starten die App mit `-trommiStub 1`. Dann ersetzt ein Board im Speicher (`StubBoardClient`) den Server, gefüttert mit `Trommi/Resources/demo-state.json`. Dieselbe Datei liegt als `TrommiTests/Fixtures/demo-state.json` bei den Tests; beide müssen gleich bleiben (CI prüft das). `TrommiTests/Fixtures/state.json` ist die unveränderte Ausgabe von `node dev/demo-state.mjs`.

Wie das automatisch läuft, steht in [TESTING.md](TESTING.md).

## Aufbau

- `Trommi/Core/`: Modelle, tolerantes Dekodieren, Reihenfolge des Stapels, Regel für Ja/Nein-Karten, Markdown, SSE, Link und Cookie. Nur Foundation.
- `Trommi/Net/`: `BoardClient` mit der echten Verbindung (`LiveBoardClient`) und dem Board im Speicher. Nur Foundation.
- `Trommi/App/`: `AppModel` (Zustand, sofortige Anzeige einer Antwort mit Rücknahme bei Fehler, Rückgängig), Schlüsselbund, Farben, Ton.
- `Trommi/Views/`: die Oberfläche.
- `Package.swift`: stellt `Core` und `Net` als SwiftPM-Paket `TrommiCore` bereit, damit sie ohne Xcode gebaut und getestet werden können.

## Was geprüft ist und was nicht

Geprüft, unter Linux mit Swift 6.1.2:

- `Core` und `Net` übersetzen; 78 Tests laufen durch (`swift test`).
- `LiveBoardClient` gegen einen echten `server.mjs` mit Demodaten: Anmeldung, Cookie mit Port im Namen (`board_8808`), `Origin`, Ereignisstrom, Entscheiden, Zurücknehmen, Nachricht, Anhang laden, falsches Token. Das lief mit dem URLSession von Linux, nicht mit dem von iOS.

Nicht geprüft, weil hier kein Xcode vorhanden ist:

- Alles unter `Trommi/App/` und `Trommi/Views/` sowie die UI-Tests wurden nie übersetzt, nur auf Syntax geprüft (`swiftc -parse`). Beim ersten Bauen sind Übersetzungsfehler zu erwarten.
- `project.yml` und `.github/workflows/ios.yml` wurden nie ausgeführt.
- Aussehen, Bedienung, VoiceOver, Dynamic Type, Kamera, Mikrofon, Video und Vorlesen hat niemand gesehen oder gehört.

## Bekannte Grenzen

- `Info.plist` erlaubt unverschlüsseltes HTTP zu jeder Adresse, weil der Server im lokalen Netz ohne TLS läuft. Das Token reist dann im Klartext; über das Internet nur mit HTTPS oder VPN verwenden.
- Der Server sendet auf `/events` nichts, solange sich nichts ändert. Eine still abgerissene Verbindung fällt deshalb erst auf, wenn die App wieder in den Vordergrund kommt (dann verbindet sie neu). Im Hintergrund gibt es keine Aktualisierung und keine Mitteilungen.
- Scribble, Verlauf erledigter Karten, Sitzungen starten und Sterne aus dem Web-Client fehlen.
