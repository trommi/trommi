# Automatisch testen

Die App lässt sich nur auf macOS bauen. Die Frage ist also, wessen Mac das tut und wie du das Ergebnis siehst.

## Empfehlung

1. **Jetzt: GitHub Actions auf `macos-latest`.** Der Workflow `.github/workflows/ios.yml` liegt bereit und braucht kein Konto außer GitHub. Du siehst im Browser, welche Tests grün sind, und lädst Screenshots aus den UI-Tests herunter.
2. **Sobald die Minuten stören: derselbe Workflow auf dem Mac mini** als eigener Runner. Eine Zeile ändern, sonst nichts.
3. **Zum Benutzen auf dem eigenen iPhone: TestFlight**, hochgeladen vom Mac mini oder von Xcode Cloud. Dafür ist die Apple-Mitgliedschaft nötig.

Appetize lohnt sich erst, wenn du die App im Browser durchklicken willst, ohne ein Gerät in der Hand zu haben. Für „laufen die Tests“ ist es nicht nötig.

## Die Möglichkeiten im Vergleich

| | Was du bekommst | Was es braucht | Kosten |
| - | - | - | - |
| GitHub Actions, `macos-latest` | Unit- und UI-Tests bei jedem Push, Ergebnis und Screenshots im Browser | nichts weiter | öffentliches Repo: frei. Privat: macOS-Minuten zählen zehnfach, 2.000 Freiminuten im Monat sind etwa 200 Minuten macOS, danach rund 0,06 $ pro Minute |
| Mac mini als Runner | dasselbe, schneller (Caches bleiben), keine Minuten; kann auch auf ein angeschlossenes iPhone installieren | Xcode und der Runner-Dienst auf dem Mac mini, der Rechner muss laufen | frei |
| Appetize.io | Simulator im Browser, per Link zum Durchklicken | Konto, API-Token als Repo-Secret, ein Upload-Schritt | frei mit 30 Minuten im Monat; Starter 59 $ im Monat mit 500 Minuten |
| Xcode Cloud | Bauen und Testen bei Apple, lädt direkt zu TestFlight hoch | Apple Developer Program, Repo mit App Store Connect verbunden, eingecheckte `.xcodeproj` oder ein Skript, das `xcodegen` ausführt | 25 Stunden im Monat in der Mitgliedschaft enthalten |
| TestFlight | die App auf deinem iPhone, Updates kommen von selbst | Apple Developer Program (99 $ im Jahr), signierter Build | in der Mitgliedschaft enthalten |

Preise Stand Oktober 2026 von den Preisseiten bzw. aus Berichten darüber; vor einer Entscheidung nachsehen.

## 1. GitHub Actions (eingerichtet)

`.github/workflows/ios.yml` läuft bei jedem Push und per Knopf („Run workflow“):

1. `swift test` für das Kernpaket, dabei auch gegen einen echten `server.mjs` mit Demodaten. Das ist der erste Lauf der Netzwerkschicht mit dem URLSession von Apple.
2. `xcodegen`, dann `xcodebuild test` auf einem iPhone-Simulator: Unit-Tests und UI-Tests.
3. Artefakte am Lauf: `ios-test-results` (das `.xcresult`, öffnet sich in Xcode, und das Build-Log), `ios-screenshots` (Bilder aus den UI-Tests als PNG), `ios-simulator-app` (die App für den Simulator als Zip).

Ein Lauf dauert geschätzt 10 bis 20 Minuten; gemessen ist das nicht. In einem privaten Repo wären die Freiminuten damit nach etwa zehn bis zwanzig Läufen im Monat verbraucht. Dann entweder nur bei Änderungen unter `client/ios/` laufen lassen (der `paths`-Filter steht als Kommentar oben im Workflow) oder auf den Mac mini wechseln.

Der Workflow ist hier nie gelaufen. Rechne beim ersten Mal mit Korrekturen, vor allem an Übersetzungsfehlern der Oberfläche.

## 2. Mac mini als Runner

Einmalig auf dem Mac mini: Xcode installieren und einmal starten, `brew install xcodegen node`. Dann im Repo unter Settings → Actions → Runners → „New self-hosted runner“ (macOS, ARM64) die angezeigten Befehle ausführen und mit `./svc.sh install && ./svc.sh start` als Dienst einrichten.

Im Workflow `runs-on: macos-latest` durch `runs-on: [self-hosted, macOS]` ersetzen. Der Schritt `brew install xcodegen` kann bleiben.

Zwei Dinge beachten:

- Ein eigener Runner führt aus, was im Repo steht. Bei einem öffentlichen Repo könnte ein fremder Pull Request Code auf dem Mac mini ausführen. Der Workflow startet deshalb nur bei `push`, nicht bei `pull_request`; so lassen oder das Repo privat halten.
- UI-Tests brauchen eine angemeldete Sitzung am Bildschirm (automatische Anmeldung einschalten), sonst startet der Simulator nicht zuverlässig. Das ist Erfahrungswissen, hier nicht nachgeprüft.

Für das iPhone am Mac mini: Gerät einmal in Xcode koppeln, Team in `project.yml` eintragen (`DEVELOPMENT_TEAM`), dann baut `xcodebuild -destination 'platform=iOS,name=<Gerätename>' -allowProvisioningUpdates` und installiert mit `xcrun devicectl device install app`. Ohne bezahlte Mitgliedschaft läuft so eine App sieben Tage.

## 3. Appetize.io

Appetize nimmt die Simulator-App als Zip, also genau das Artefakt `ios-simulator-app`, und zeigt sie als Simulator im Browser. Nötig sind ein Konto und ein API-Token, abgelegt als Repo-Secret `APPETIZE_API_TOKEN`. Der Schritt dazu, bewusst noch nicht im Workflow:

```yaml
      - name: Upload to Appetize
        if: github.ref == 'refs/heads/main'
        env:
          APPETIZE_API_TOKEN: ${{ secrets.APPETIZE_API_TOKEN }}
        run: |
          curl --fail -X POST "https://api.appetize.io/v1/apps${APPETIZE_APP:+/$APPETIZE_APP}" \
            -H "X-API-KEY: $APPETIZE_API_TOKEN" \
            -F "file=@build/Trommi-simulator.zip" -F "platform=ios"
```

Der erste Upload gibt einen `publicKey` zurück; als `APPETIZE_APP` gesetzt, ersetzt jeder weitere Upload dieselbe App, und der Link `https://appetize.io/app/<publicKey>` bleibt gleich.

Nachgeprüft: Endpunkt, Header `X-API-KEY`, Feld `platform`, Zip als Format (Appetize-Dokumentation) und die Preise. Nicht nachgeprüft: der Upload als Datei mit `-F file=@…` (die Dokumentation zeigt nur das Beispiel mit `url`) und das Aktualisieren über `/v1/apps/<publicKey>`. Ausprobiert wurde nichts davon.

Im Browser läuft die App ohne deinen Server, es sei denn, er ist aus dem Internet erreichbar. „Demo ansehen“ auf dem ersten Bildschirm reicht zum Durchklicken. Mit 30 freien Minuten im Monat ist das für gelegentliches Ansehen gedacht.

## 4. Xcode Cloud und TestFlight

Für die App auf dem eigenen iPhone, dauerhaft und mit Updates:

1. Apple Developer Program abschließen, in App Store Connect eine App mit der Bundle-ID `de.trommi.app` anlegen (oder die ID in `project.yml` ändern).
2. Einen Build hochladen. Am einfachsten vom Mac mini: in Xcode „Product → Archive → Distribute App → TestFlight“. Automatisch geht es mit `xcodebuild archive` und `xcodebuild -exportArchive` plus einem App-Store-Connect-API-Schlüssel, im selben Workflow auf dem eigenen Runner.
3. Dich selbst als internen Tester eintragen, die TestFlight-App auf dem iPhone installieren. Interne Tester brauchen keine Prüfung durch Apple; ein Build gilt 90 Tage.

Xcode Cloud kann Schritt 2 übernehmen. Es erwartet eine Projektdatei im Repo. Weil `Trommi.xcodeproj` hier erzeugt wird, braucht es `client/ios/ci_scripts/ci_post_clone.sh` mit `brew install xcodegen && cd .. && xcodegen`, oder die Projektdatei wird doch eingecheckt. Das ist nicht eingerichtet und nicht ausprobiert.

Die App erlaubt HTTP zu beliebigen Adressen (siehe README). Für TestFlight mit internen Testern ist das kein Hindernis; bei einer Veröffentlichung im App Store würde Apple danach fragen.
