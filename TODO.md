# Trommi: Ideen für später

Punkte, die besprochen, aber noch nicht gebaut sind. Reihenfolge ist keine Priorität.

- [x] **Spracherkennung:** Diktat im Eingabefeld, Vorlesen von Karten, `create_voiceover` für Agenten (Tinfoil). Offen: freihändiger Dauerbetrieb.
- [ ] **Verschlüsselung:** Entwurf in `client/web/krypto-konzept.html`. Entschieden: Einladungslink mit Geheimnis, **ein Raumschlüssel, kein Ratchet**, signierte Nachrichten. Status und Zeitpunkt einer Antwort bleiben für den Server lesbar, weil er nach 30 Tagen löscht.
- [ ] **Nachrichten-Log:** jede Nachricht mit fortlaufender Nummer und Client-ID speichern, Clients holen Lücken gezielt nach; heute geht bei jeder Änderung der ganze Zustand an jede Seite. (Erledigt davon: Nachrichten an abwesende Agenten warten in `state.pending` und überleben einen Neustart; der Zustand liegt in SQLite, `data/pad.db`.)
- [ ] **Fester Hub-Dienst:** statt „erste Sitzung ist der Hub“.
- [ ] **Stabile Agenten-IDs:** nicht der Ordnername; Claudes Sitzungs-ID als veränderliche Zusatzangabe (wechselt bei Resume, `/compact`, Fork).
- [ ] **Live-Zustand:** arbeitet / wartet / blockiert aus herdr lesen (`HERDR_SOCKET_PATH`), wo die Sitzung in herdr läuft.
- [ ] **TLS:** Die Seite läuft bisher über unverschlüsseltes HTTP und ist nur im privaten Netz (Tailscale) vertretbar.
- [ ] **Live-Verlauf:** Zeigen, was der Agent gerade tut (Tool-Aufrufe, Fortschritt), über Hooks oder das Agent SDK. Der Channel liefert nur, was der Agent bewusst schickt.
- [ ] **Agenten per Link einladen:** Ein Link oder QR-Code, der eine Session mit dem Board verbindet, statt `.mcp.json` von Hand.
- [ ] **Channel ohne Entwickler-Flag:** Als Plugin verpacken, sobald eigene Channels ohne `--dangerously-load-development-channels` laufen.
- [x] **Datei-Upload vom Menschen:** Bilder und Dateien im Gespräch, an einer Antwort und in der schnellen Notiz anhängen (`attachments` an `/message` und `/decide`).
- [ ] **Benachrichtigungen:** Push aufs Handy, wenn ein Knock auf dem Desk landet.
- [ ] **Archiv:** Erledigte Karten nach einer Frist ausblenden, Suche über alte Entscheidungen.
- [x] **Zustand in SQLite:** `data/pad.db` statt `state.json` (2.10.2026); `node server/board-store.mjs export|counts|back`.
- [x] **Echte Adressen:** `/q/<n>`, `/s/<id>`, `/walk`, `/agents` (2.10.2026).
- [x] **Wörter entschieden (2.10.2026):** Desk, Next, please, Snooze, Revise, Whatever, Shred, What??, Knock, Scratchpad, Ledger, Krone; siehe `docs/naming.md`, Abschnitt 7.

## Noch im Fluss (2.10.2026)
- [ ] **Aufbau der geöffneten Karte:** Wo Antworten, Gespräch, Notizfeld und Stift stehen, ist nicht entschieden. Hilfe und README beschreiben es deshalb nur lose.
- [ ] **Ort des App-Menüs:** hinter dem Logo, als Pille oben oder anders. Die Hilfe nennt keinen Ort.
- [ ] **Vier Wege neben der Antwort:** Bleiben Snooze, Revise, Whatever und Shred vier, oder werden es weniger? Danach Hilfe (`client/web/help.html`, Abschnitt „Four other ways“) und README nachziehen.
- [ ] **`deploy/backup.sh` kennt SQLite nicht:** Es prüft und sichert `state.json` und kopiert `pad.db` aus dem laufenden Hub. Bis dahin gilt der Hinweis in `docs/operations.md`, Abschnitt 5.
- [ ] **Antwort nach „Whatever“:** Die beantwortete Karte sagt noch „Trusted: …“.

## Erst wenn wir live gehen
- [ ] **Hub als eigener Dienst:** `deploy/install-user-service.sh --enable` statt von Claude gestartetem Hub. In der Entwicklung startet Claude den Hub; das ist so gewollt (Christopher, 2.10.2026).
- [ ] **Hub nur auf Loopback binden:** erreichbar über localhost und den Tailnet-Namen, nicht mehr als HTTP im LAN.

- [ ] **iOS: eigener Tinfoil-Schlüssel.** In der App einen eigenen Tinfoil-Schlüssel eintragen können (Schlüsselbund); dann geht Diktat direkt vom Gerät zu Tinfoil. Im Browser nie: der Schlüssel läge offen (Christopher, 2.10.2026).

- [ ] **iOS geparkt (2.10.2026):** Christopher stellt iOS hinten an. Stand und offene Punkte stehen in `client/ios/`. Erst wieder aufnehmen, wenn er es sagt.

- [ ] **Unter-Sitzungen (open_session):** Ein Agent öffnet Sitzungen für seine Helfer und schlägt beim ersten Verbinden ein Team vor. Entwurf steht im Bericht des Server-Agenten vom 2.10.2026; der Umbau wurde von der Rechteprüfung abgelehnt und braucht Christophers ausdrückliche Freigabe.
