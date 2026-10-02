# Paketieren

Beides sind Skizzen: geschrieben, nicht gebaut.

## Arch

`PKGBUILD` baut `trommi-git` aus dem Repository: `qmake6 app/app.pro PREFIX=/usr`, `make`, `make INSTALL_ROOT=$pkgdir install`. Das legt `/usr/bin/trommi` und `/usr/share/applications/trommi.desktop` ab (dieser Schritt wurde von Hand in ein leeres Verzeichnis ausprobiert). `check()` lässt die Tests ohne Server laufen.

```sh
cd packaging && makepkg -si
```

Offen: ein Icon (bisher das allgemeine `internet-chat`), eine Lizenzdatei im Paket, und sobald es Releases gibt ein Paket `trommi` mit festem Tag statt `-git`.

brumm geht einen anderen Weg (Tarball aus GitHub Actions, in einem `archlinux`-Container gebaut, signiert, per `install.sh` geholt). Für Trommi lohnt das erst, wenn es Releases gibt; der Build-Schritt wäre derselbe.

## Flatpak

`com.trommi.Trommi.yml` nutzt die KDE-Laufzeit (`org.kde.Platform`), die Qt 6 und libsecret mitbringt.

```sh
flatpak-builder --user --install --force-clean build-flatpak packaging/com.trommi.Trommi.yml
```

Offen:

- Die App-ID ist erledigt: im Flatpak meldet sich das Programm mit `FLATPAK_ID` (`setDesktopFileName` in `app/src/main.cpp`), sonst als `trommi`. Ungeprüft, weil das Flatpak noch nie gebaut wurde.
- Das Pad öffnet den Browser über `QDesktopServices`; im Flatpak geht das durch das Portal.
- Eine AppStream-Datei (`metainfo.xml`) und ein Icon, ohne die Flathub nichts annimmt.
- `hyprctl` ist in der Sandbox nicht erreichbar: das Nach-vorn-Holen bei einem zweiten Start fällt dort weg.
- Die 0600-Datei läge unter `~/.var/app/com.trommi.Trommi/config/trommi/board`.
