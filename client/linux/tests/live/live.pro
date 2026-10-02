QT += testlib
QT -= gui
CONFIG += testcase no_testcase_installs console warn_on
TARGET = tst_live
TEMPLATE = app
include(../../core/core.pri)
SOURCES += tst_live.cpp
