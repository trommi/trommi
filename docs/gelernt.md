# Was wir von anderen gelernt haben

Stand 2. Oktober 2026. Quellen: Quellcode von Fizzy, Campfire und Writebook (37signals), öffentliche Seiten zu HEY und Basecamp, Quellcode und Doku von Happy (slopus/happy), HAPI (tiann/hapi) und herdr (herdrdev/herdr). Nur das Wesentliche; was noch nicht umgesetzt ist, steht mit Kästchen in `TODO.md`.

## Gestaltung (37signals)

- **Eine Farbe treibt die ganze Karte.** Fizzy setzt pro Karte eine Variable und leitet Hintergrund (4 %), Text (30 bis 75 %) und Rand (33 %) per `color-mix` ab. Bei uns: die Dringlichkeit. Umgesetzt im Posteingang.
- **Reiter in der Ecke.** Ein farbiger Streifen mit Nummer und Stufe, bündig mit der linken oberen Ecke. Umgesetzt auf Stapel, Posteingang und Fokus.
- **Überschriften sind Trennlinien.** Text mit einer Linie links und rechts statt Kästen. Umgesetzt für die Absender im Posteingang.
- **Gestrichelt heißt vorläufig.** Leerzustand, „Optionen ansehen“, getrennte Sitzung. Durchgezogen heißt entschieden.
- **Kleine Unvollkommenheiten.** Handgezogener Kreis um eine Zahl (zwei Halbellipsen, die sich nicht treffen), leicht gedrehter Leerzustand, gekritzelte Symbole pro Sitzung. Kein SVG-Filter nötig.
- **Starker Schriftkontrast.** Sehr fette Titel gegen kleine Versalien für Metadaten.
- **Zwei Radien.** Klein für Flächen, ganz rund für Knöpfe.
- **HEY-Screener.** Große Antwort-Kacheln an derselben Stelle in jeder Zeile, damit das Auge eine Spalte hinunterläuft. Darunter ein Satz, der sagt, wofür die Seite da ist.
- **Jason Frieds Write_On** (Beitrag vom 30. September 2026): Alternativen stehen neben der Stelle, die sie ersetzen, und werden an Ort und Stelle durch Abdunkeln vorgeführt statt in einem Diff.

## Technik (Happy, HAPI, herdr)

- **Der Aufwand steckt nicht im Chat, sondern im Drumherum:** Sitzungen, die enden, neu starten oder ihre ID wechseln; verlorene erste Nachrichten; doppelte Zustellung; Freigaben, die im Terminal und am Handy gleichzeitig offen sind; Wiederverbinden auf dem Handy.
- **Sitzungs-IDs wechseln** bei Resume, `/compact` und Fork. Happy und herdr holen die aktuelle ID über einen `SessionStart`-Hook und halten eine eigene stabile ID daneben.
- **Hooks allein reichen nicht für den Zustand.** herdr hat seine Claude-Hooks für „arbeitet / wartet“ wieder entfernt, weil Abbrüche und Subagenten sie unzuverlässig machen, und liest den Zustand vom Bildschirm. In herdr-Fenstern kann Trommi diesen Zustand über den herdr-Socket abfragen (`HERDR_SOCKET_PATH`, `HERDR_PANE_ID`).
- **Nachrichten brauchen eine fortlaufende Nummer und eine Client-ID,** damit nichts doppelt ankommt und ein Client nach einer Lücke gezielt nachholen kann. Beide Projekte speichern jede Nachricht auf dem Server.
- **Eine Antwort gesendet zu haben heißt nicht, dass sie gewonnen hat.** Bei Freigaben entscheidet Claude Code, ob Terminal oder Fernantwort zuerst kam.
- **Wiederverbinden gehört dem Client:** Herzschlag, Zeitüberschreitung, Prüfung beim Zurückkehren in den Vordergrund, Wartezeit mit Zufallsanteil. Ein Netzfehler ist keine Abmeldung.
- **Kopplung einfach halten.** HAPI kommt mit einem geteilten Geheimnis im Link aus; Happys Schlüsseltausch brachte zwei Protokollgenerationen und Sonderfälle. Einladungen von Anfang an versionieren, einmalig und kurzlebig machen, und pro Gerät ein eigenes Zugangsmerkmal ausgeben, damit sich ein Handy einzeln sperren lässt.
- **Fester Hub.** Beide Projekte betreiben einen eigenen Hub-Prozess. Unser Modell „erste Sitzung ist der Hub, eine andere übernimmt“ hat sonst niemand; es ist unser größtes Eigenrisiko.
- **Der meiste Code ist Oberfläche:** Scrollen, Eingabefeld, Plattform-Eigenheiten.
