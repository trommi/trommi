# Entscheidung: Qt 6 mit Qt Quick (QML), wie brumm

Stand 2. Oktober 2026. Rechner: Arch Linux / Omarchy 4 mit Hyprland (Wayland, kachelnd, tastaturgesteuert).

## Ergebnis

Der Linux-Client ist ein C++-Programm mit Qt 6 und Qt Quick, gebaut mit qmake, ohne weitere Abhängigkeit außer libsecret. Zwei Gründe tragen die Wahl:

1. **brumm macht es genau so, und es läuft auf diesem Rechner.** Aufbau, Build, Bildschirmfoto ohne Bildschirm, Theme-Erkennung und Fensterregeln ließen sich übernehmen statt neu erfinden. Wer brumm pflegt, findet sich hier sofort zurecht.
2. **Alles ist schon installiert, und die Oberfläche lässt sich frei zeichnen.** Qt 6.11.2 samt qt6-declarative und qt6-wayland liegt auf dem System (Omarchys Leiste läuft selbst auf Quickshell, also QML). Trommis Aussehen (eine Farbe treibt die Karte, Reiter in der Ecke, gleich hohe Zeilen mit zwei Kacheln) ist kein Standard-Widget; in QML sind das Rechtecke und Text, in libadwaita wäre es ein Kampf gegen das Toolkit.

## Was brumm ist

`/home/christopher/git/brumm` (upstream https://github.com/chriopter/brumm): Apple Music für Omarchy, 62 Commits, Stand `a171b8b` vom 1. Oktober 2026.

- **Aufbau:** ein Hintergrunddienst in Go (`internal/daemon`, systemd-Unit in `omarchy/brumm.service`) ist der Kern. Zwei Gesichter zeichnen nur: `brumm --tui` (Go, Bubble Tea) und `brumm --gui`, ein eigenes Programm `brumm-gui` in **C++ mit Qt 6 Quick** (`gui/`, rund 5.700 Zeilen: 11 Dateien in `gui/src`, 32 QML-Dateien, 33 Shader). Beide sprechen über einen Socket mit dem Dienst.
- **Build:** `gui/brumm-gui.pro` mit qmake. QML und Shader werden beim qmake-Lauf eingesammelt und ins Programm eingebettet, eine neue Datei braucht keinen Eintrag. `bin/build-gui` baut, `bin/setup` installiert aus dem Checkout.
- **Tests:** Go-Tests für den Kern (`internal/*/*_test.go`). Das Fenster hat keine Unit-Tests; es wird mit `bin/gui-shot` geprüft: ein Ersatz-Dienst (`tools/fakedaemon`), `QT_QPA_PLATFORM=offscreen`, Tasten über eine Umgebungsvariable, ein Bild nach 1,5 Sekunden.
- **Auslieferung:** kein Paket. `.github/workflows/release.yml` baut das Fenster in einem `archlinux`-Container gegen das Qt, das Omarchy fährt, packt ein Tarball, signiert es (Ed25519) und bescheinigt den Build; `bin/install` holt es per curl. `omarchy/brumm.desktop` ist der Starter.
- **Was README, AGENTS.md und die Geschichte lehren:** Die Vorläufer `brumm1` (Go, Bubble Tea, chromedp) und `brumm2` (Rust, ratatui, tokio) waren Versuche für den Kern; die Fensterfrage wurde erst mit Commit `c9a0aca` („brumm as a window too“, 30. September 2026) gestellt und sofort mit Qt Quick beantwortet, nicht mit einem Rust-Toolkit. Seitdem betreffen fast alle Commits Feinheiten der Oberfläche (schmale Fenster, Trennlinie ziehen, Knöpfe), was dafür spricht, dass der Stack trägt. Der Kern gehört nicht ins Fenster. README kurz, Tasten in einer Tabelle, Commit-Titel in ganzen Sätzen.

## Was von brumm übernommen wurde

| Hier | Vorbild in brumm | Was |
|---|---|---|
| `app/app.pro` | `gui/brumm-gui.pro` | qmake, QML wird beim qmake-Lauf eingesammelt und eingebettet |
| `bin/build` | `bin/build-gui` | Build in ein eigenes Verzeichnis, Hinweis auf fehlende Pakete |
| `bin/shot`, `TROMMI_SHOT`, `TROMMI_KEYS`, `TROMMI_SIZE` in `app/src/main.cpp` und `app/qml/Main.qml` | `bin/gui-shot`, `BRUMM_GUI_SHOT`, `BRUMM_GUI_KEYS`, `BRUMM_GUI_SIZE` | Bild ohne Bildschirm, eigenes Konfigurationsverzeichnis, Tasten vorab |
| `--demo` mit `tests/fixtures/demo-state.json` | `tools/fakedaemon` | das Fenster ohne den echten Dienst zeigen |
| `app/src/theme.cpp` | `gui/src/theme.cpp` | Portal (`org.freedesktop.appearance`), Textgröße des Desktops, Omarchys `~/.local/state/omarchy/current/theme/colors.toml` mit Dateiwächter |
| `app/src/main.cpp` | `gui/src/main.cpp` | `setDesktopFileName` als Wayland-App-ID, ein Fenster pro Nutzer, `hyprctl` holt es nach vorn (erst Lua-Syntax, dann die alte), Schriftwahl (Adwaita Sans, Inter, Cantarell; Monospace des Desktops) |
| `app/qml/Nav.qml` | `gui/qml/Store.qml` | ein Ort für Zustand und Tasten, die Teile zeichnen nur |
| `app/qml/HelpBox.qml` | `gui/qml/HelpBox.qml` | `?` zeigt die Tasten |
| `trommi.desktop` | `omarchy/brumm.desktop` | Starter mit `StartupWMClass` |
| `core/` getrennt von `app/` | Dienst getrennt vom Fenster | der Kern ohne Fenster, eigens getestet |

Anders als brumm: Der Kern ist hier C++ statt Go, weil der Server schon der Kern ist und der Client nur HTTP spricht; ein zweiter Prozess wäre Ballast. Dafür hat der Kern Unit-Tests mit QtTest, die brumms Fenster nicht hat. Shader und `quickcontrols2` werden nicht gebraucht.

## Was auf dem Rechner liegt

| | Version |
|---|---|
| qt6-base, qt6-declarative, qt6-wayland | 6.11.2 |
| qtkeychain-qt6, libsecret | 0.17.0, 0.21.7 |
| gtk4, libadwaita | 4.22.4, 1.9.3 |
| quickshell (QML) | 0.3.1 |
| gcc, qmake6, cmake | 16.2.1, vorhanden, 4.4.3 (über mise) |
| cargo, rustc | vorhanden (rustup) |
| meson, ninja | fehlen |

Nichts wurde installiert.

## Vergleich

| | GTK4 + libadwaita | **Qt 6 / QML** | Iced | Slint | egui | Web-Hülle (Tauri, Electron) |
|---|---|---|---|---|---|---|
| Nativ | ja | ja | ja | ja | ja | nein, ein Browser im Fenster |
| Wayland | ja | ja, mit qt6-wayland | ja, über winit | ja, über winit oder Qt | ja, über winit | ja, über WebKitGTK oder Chromium |
| Auf dem Rechner | ja | ja | Crates laden und bauen | Crates laden und bauen | Crates laden und bauen | Tauri: Crates und WebKitGTK |
| Bauwerkzeug hier | meson fehlt | qmake6 da | cargo | cargo | cargo | cargo, npm |
| Eigenes Aussehen (Trommis Karten) | gegen das Toolkit: libadwaita will Adwaita | frei, deklarativ | frei, in Rust-Code | frei, eigene Sprache | frei, aber jedes Bild neu gerechnet | frei, es ist die Web-Oberfläche |
| Text, Eingabe, IME, Barrierefreiheit | ausgereift | ausgereift | Barrierefreiheit in Arbeit, IME seit 0.14 besser | brauchbar, jünger | AccessKit, IME-Fenster folgt dem Cursor nicht überall | wie im Browser |
| Reife | sehr reif | sehr reif | 0.14 (Dezember 2025), vor 1.0, API bricht | 1.x, stabil | 0.x, API bricht | Tauri 2: auf Linux Ärger mit WebKitGTK (Leistung, NVIDIA, leere Fenster) |
| Passt zu Hyprland/Omarchy | Fenster bringt eigene Kopfleiste mit | Hyprlands eigene Hilfsprogramme und Omarchys Leiste sind Qt/QML | neutral | neutral | neutral | neutral |
| Lizenz | LGPL | LGPL | MIT | GPLv3 oder gebührenfrei mit Nennung | MIT / Apache | MIT |
| Gleich wie brumm | nein | **ja** | nein | nein | nein | nein |

Einordnung:

- **GTK4 + libadwaita** ist die saubere Wahl für eine GNOME-App und wäre hier tragfähig. Zwei Dinge sprechen dagegen: libadwaita gibt das Aussehen vor (Kopfleiste, Listen, Farben), Trommi hat sein eigenes; und der zweite Stack neben brumm kostet doppelte Pflege. meson müsste installiert werden.
- **Iced, Slint, egui** sind echte Kandidaten, wenn der Kern in Rust sein soll. Auf diesem Rechner heißt das aber: Hunderte Crates laden, lange erste Builds, und bei Iced und egui eine API, die sich noch bewegt. Iced 0.14 hat laut Meldungen noch Fälle, in denen das Fenster unter Wayland nicht neu zeichnet. Slint ist am ehesten vergleichbar mit QML, bringt aber eine weitere Sprache und nichts, was Qt hier nicht schon hätte.
- **Web-Hüllen** zählen nicht als nativ. Trommi hat schon einen Web-Client; ihn in ein Fenster zu packen bringt keine Tastaturführung, keinen Schlüsselbund und unter Linux die bekannten WebKitGTK-Probleme.

## Wo die Wahl schwach ist

- C++ ist mehr Handarbeit als Rust oder Swift, und der Kern wird damit ein drittes Mal geschrieben (JavaScript, Swift, C++). Die Tests in `tests/core` halten ihn an den anderen fest, aber von Hand.
- Die Daten gehen als `QVariantMap` an QML, ohne Typen. Für diese Größe reicht es; wächst der Client, gehören echte Modelle hin.
- qmake ist bei Qt selbst das alte Bauwerkzeug, CMake das empfohlene. brumm nutzt qmake, deshalb hier auch; der Wechsel wäre klein.
- Qt-Apps sehen unter GNOME fremd aus. Hier egal: das Fenster zeichnet alles selbst.

## Quellen

- brumm, lokal gelesen: `README.md`, `AGENTS.md`, `gui/brumm-gui.pro`, `gui/src/main.cpp`, `gui/src/theme.cpp`, `bin/build-gui`, `bin/gui-shot`, `bin/setup`, `omarchy/brumm.desktop`, `.github/workflows/release.yml`, `git log`; dazu `brumm1/go.mod` und `brumm2/Cargo.toml`.
- Iced 0.14: https://github.com/iced-rs/iced/releases/tag/0.14.0 und https://github.com/iced-rs/iced/issues/3496
- Slint, Lizenzen: https://github.com/slint-ui/slint/blob/master/LICENSE.md und https://slint.dev/blog/slint-1.1-released
- egui: https://github.com/emilk/egui
- Tauri unter Linux: https://v2.tauri.app/develop/debug/linux-graphics/ und https://github.com/orgs/tauri-apps/discussions/9088
- Hyprlands Qt-Programme: https://github.com/hyprwm/hyprland-qt-support und https://github.com/hyprwm/hyprland-qtutils
- Überblick Qt und GTK: https://en.wikipedia.org/wiki/Qt_(software), https://en.wikipedia.org/wiki/GTK
- Installierte Versionen: `pacman -Q`, `pkg-config --modversion`, `which` auf diesem Rechner.
