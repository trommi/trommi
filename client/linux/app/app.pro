QT += core gui qml quick network dbus
CONFIG += c++20 release warn_on link_pkgconfig
TARGET = trommi
TEMPLATE = app

include(../core/core.pri)
HEADERS += $$files(src/*.h)
SOURCES += $$files(src/*.cpp)

# The Secret Service through libsecret where it is installed; without it
# the link is kept in a file only its owner can read.
packagesExist(libsecret-1) {
    PKGCONFIG += libsecret-1
    DEFINES += TROMMI_LIBSECRET
} else {
    message("libsecret-1 not found: the link will be kept in a 0600 file")
}

# Everything under qml/ is built in as :/qml/..., gathered when qmake runs
# (as brumm's gui/brumm-gui.pro does): a new file needs only a new qmake.
QRC = "<RCC><qresource prefix=\"/\">"
for(f, $$list($$files($$PWD/qml/*.qml, true))) {
    QRC += "<file alias=\"qml/$$relative_path($$f, $$PWD/qml)\">$$f</file>"
}
QRC += "</qresource></RCC>"
write_file($$OUT_PWD/trommi.qrc, QRC)
RESOURCES += $$OUT_PWD/trommi.qrc

isEmpty(PREFIX): PREFIX = /usr/local
target.path = $$PREFIX/bin
desktop.files = ../trommi.desktop
desktop.path = $$PREFIX/share/applications
INSTALLS += target desktop
