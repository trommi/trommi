# Trommi: Ideen für später

Punkte, die besprochen, aber noch nicht gebaut sind. Reihenfolge ist keine Priorität.

- [x] **Spracherkennung:** Diktat im Eingabefeld, Vorlesen von Karten, `create_voiceover` für Agenten (Tinfoil). Offen: freihändiger Dauerbetrieb.
- [ ] **Verschlüsselung:** Entwurf in `public/krypto-konzept.html`. Entschieden: Einladungslink mit Geheimnis, **ein Raumschlüssel, kein Ratchet**, signierte Nachrichten. Status und Zeitpunkt einer Antwort bleiben für den Server lesbar, weil er nach 30 Tagen löscht.
- [ ] **Nachrichten-Log:** jede Nachricht mit fortlaufender Nummer und Client-ID speichern, Clients holen Lücken gezielt nach; heute geht bei jeder Änderung der ganze Zustand raus und Nachrichten an abwesende Agenten liegen nur im Arbeitsspeicher.
- [ ] **Fester Hub-Dienst:** statt „erste Sitzung ist der Hub“.
- [ ] **Stabile Agenten-IDs:** nicht der Ordnername; Claudes Sitzungs-ID als veränderliche Zusatzangabe (wechselt bei Resume, `/compact`, Fork).
- [ ] **Live-Zustand:** arbeitet / wartet / blockiert aus herdr lesen (`HERDR_SOCKET_PATH`), wo die Sitzung in herdr läuft.
- [ ] **TLS:** Die Seite läuft bisher über unverschlüsseltes HTTP und ist nur im privaten Netz (Tailscale) vertretbar.
- [ ] **Live-Verlauf:** Zeigen, was der Agent gerade tut (Tool-Aufrufe, Fortschritt), über Hooks oder das Agent SDK. Der Channel liefert nur, was der Agent bewusst schickt.
- [ ] **Agenten per Link einladen:** Ein Link oder QR-Code, der eine Session mit dem Board verbindet, statt `.mcp.json` von Hand.
- [ ] **Channel ohne Entwickler-Flag:** Als Plugin verpacken, sobald eigene Channels ohne `--dangerously-load-development-channels` laufen.
- [ ] **Datei-Upload vom Menschen:** Bilder und Dateien direkt im Gespräch anhängen (bisher nur über Scribble).
- [ ] **Benachrichtigungen:** Push aufs Handy, wenn eine dringende Karte auf dem Stapel landet.
- [ ] **Archiv:** Erledigte Karten nach einer Frist ausblenden, Suche über alte Entscheidungen.
