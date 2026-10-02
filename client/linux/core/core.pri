# Protocol and logic, without a window: QtCore and QtNetwork only.
# Included by the app and by the tests.
QT += core network
CONFIG += c++20
INCLUDEPATH += $$PWD
HEADERS += $$files($$PWD/*.h)
SOURCES += $$files($$PWD/*.cpp)
# GCC 16 reports Qt's own headers under C++20 (QChar, QBitArray "defined
# after use in a SFINAE context"); nothing here can change that.
gcc:!clang: QMAKE_CXXFLAGS_WARN_ON += -Wno-sfinae-incomplete
