// Theme is the look the window wears: the colours of the web client
// (client/web/css/tokens.css), light or dark as the desktop says, and the
// desktop's text size. The watching of the portal and of Omarchy's theme
// directory follows brumm's gui/src/theme.cpp.
#pragma once

#include <QDBusVariant>
#include <QFileSystemWatcher>
#include <QObject>
#include <QVariantMap>

class Theme : public QObject {
    Q_OBJECT
    Q_PROPERTY(QVariantMap colors READ colors NOTIFY changed)
    Q_PROPERTY(bool dark READ dark NOTIFY changed)
    Q_PROPERTY(double textScale READ textScale NOTIFY textScaleChanged)
    Q_PROPERTY(QString source READ source NOTIFY changed)

public:
    explicit Theme(QObject *parent = nullptr);

    QVariantMap colors() const;
    bool dark() const { return m_dark; }
    double textScale() const { return m_textScale; }
    QString source() const { return m_source; } // who said light or dark

    static QVariantMap tokens(bool dark);
    Q_INVOKABLE void toggle(); // light or dark, whatever the desktop says

signals:
    void changed();
    void textScaleChanged();

private slots:
    void portalSettingChanged(const QString &ns, const QString &key, const QDBusVariant &value);

private:
    void decide();
    void readPortal();
    void watch();
    int omarchy() const; // 1 dark, 2 light, 0 unknown

    int m_picked = 0; // the human's own choice: 1 dark, 2 light
    int m_portal = 0; // org.freedesktop.appearance color-scheme: 1 dark, 2 light
    bool m_dark = false;
    double m_textScale = 1.0;
    QString m_source;
    QFileSystemWatcher m_watcher;
};
