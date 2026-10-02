#include "theme.h"

#include <QColor>
#include <QDBusConnection>
#include <QDBusMessage>
#include <QDBusReply>
#include <QDir>
#include <QFile>
#include <QGuiApplication>
#include <QStyleHints>
#include <QTextStream>
#include <QTimer>

static QString currentDir() { return QDir::homePath() + "/.local/state/omarchy/current"; }
static QString colorsPath() { return currentDir() + "/theme/colors.toml"; }

static const char *portalService = "org.freedesktop.portal.Desktop";
static const char *portalPath = "/org/freedesktop/portal/desktop";
static const char *portalSettings = "org.freedesktop.portal.Settings";

// client/web/css/tokens.css, :root and :root[data-theme="dark"].
QVariantMap Theme::tokens(bool dark)
{
    if (dark)
        return {
            {"bg", "#0e1311"}, {"surface", "#171d1a"}, {"surface2", "#1c2420"}, {"sunken", "#111715"},
            {"fg", "#e9eeea"}, {"muted", "#9aa8a0"}, {"faint", "#6c7a73"},
            {"line", "#252f2a"}, {"line_strong", "#35423b"},
            {"accent", "#6fd0b5"}, {"accent_hover", "#8adcc5"}, {"accent_soft", "#17332b"}, {"accent_fg", "#08130f"},
            {"urg_low", "#8b9891"}, {"urg_normal", "#6fd0b5"}, {"urg_high", "#f2a56c"}, {"urg_critical", "#ff8a80"},
            {"deny", "#f08a83"},
            {"st_decision", "#ff8a80"}, {"st_working", "#f2c14e"}, {"st_done", "#6cd598"},
        };
    return {
        {"bg", "#f5f6f2"}, {"surface", "#ffffff"}, {"surface2", "#fafbf8"}, {"sunken", "#eceee8"},
        {"fg", "#141c18"}, {"muted", "#5c6862"}, {"faint", "#8a958f"},
        {"line", "#e1e5df"}, {"line_strong", "#c9d0c8"},
        {"accent", "#1b6a57"}, {"accent_hover", "#155646"}, {"accent_soft", "#dcefe8"}, {"accent_fg", "#ffffff"},
        {"urg_low", "#6b7771"}, {"urg_normal", "#1b6a57"}, {"urg_high", "#b4551b"}, {"urg_critical", "#b3261e"},
        {"deny", "#a8322d"},
        {"st_decision", "#c62f25"}, {"st_working", "#b07a06"}, {"st_done", "#1f8a4c"},
    };
}

Theme::Theme(QObject *parent) : QObject(parent)
{
    readPortal();
    watch();
    // A theme switch replaces files and directories: look again once it
    // settles, and watch what is there now.
    auto again = [this] {
        QTimer::singleShot(150, this, [this] {
            decide();
            watch();
        });
    };
    connect(&m_watcher, &QFileSystemWatcher::fileChanged, this, again);
    connect(&m_watcher, &QFileSystemWatcher::directoryChanged, this, again);
    connect(QGuiApplication::styleHints(), &QStyleHints::colorSchemeChanged, this, [this] { decide(); });
    QDBusConnection::sessionBus().connect(portalService, portalPath, portalSettings, "SettingChanged", this,
                                          SLOT(portalSettingChanged(QString, QString, QDBusVariant)));
    decide();
}

QVariantMap Theme::colors() const { return tokens(m_dark); }

// Light or dark, from the first that knows: TROMMI_THEME, the desktop
// portal's colour scheme, Qt's own reading of the platform, Omarchy's
// current theme. Light if nobody does, as in the web client.
void Theme::decide()
{
    bool dark = false;
    QString source = "default";
    const QString forced = qEnvironmentVariable("TROMMI_THEME");
    const Qt::ColorScheme qt = QGuiApplication::styleHints()->colorScheme();
    if (forced == "dark" || forced == "light") {
        dark = forced == "dark";
        source = "TROMMI_THEME";
    } else if (m_portal == 1 || m_portal == 2) {
        dark = m_portal == 1;
        source = "portal";
    } else if (qt != Qt::ColorScheme::Unknown) {
        dark = qt == Qt::ColorScheme::Dark;
        source = "qt";
    } else if (const int o = omarchy()) {
        dark = o == 1;
        source = "omarchy";
    }
    if (dark != m_dark || source != m_source) {
        m_dark = dark;
        m_source = source;
        emit changed();
    }
}

// Omarchy's theme says light or dark in colors.toml: by "mode", else by
// how light its background is.
int Theme::omarchy() const
{
    QFile f(colorsPath());
    if (!f.open(QIODevice::ReadOnly | QIODevice::Text)) return 0;
    QString mode, background;
    QTextStream in(&f);
    while (!in.atEnd()) {
        const QString line = in.readLine().trimmed();
        const int eq = line.indexOf('=');
        if (line.isEmpty() || line.startsWith('#') || eq < 0) continue;
        const QString key = line.left(eq).trimmed();
        QString value = line.mid(eq + 1).trimmed();
        if (value.size() >= 2 && (value.front() == '"' || value.front() == '\'') && value.back() == value.front())
            value = value.mid(1, value.size() - 2);
        if (key == "mode") mode = value;
        else if (key == "background") background = value;
    }
    if (mode == "dark") return 1;
    if (mode == "light") return 2;
    if (QColor::isValidColorName(background)) return QColor(background).lightnessF() < 0.5 ? 1 : 2;
    return 0;
}

void Theme::watch()
{
    const QStringList was = m_watcher.files() + m_watcher.directories();
    if (!was.isEmpty()) m_watcher.removePaths(was);
    for (const QString &p : {currentDir(), currentDir() + "/theme", colorsPath()})
        if (QFile::exists(p)) m_watcher.addPath(p);
}

void Theme::readPortal()
{
    auto ask = [this](const QString &ns, const QString &key) {
        auto msg = QDBusMessage::createMethodCall(portalService, portalPath, portalSettings, "ReadOne");
        msg << ns << key;
        QDBusReply<QDBusVariant> reply = QDBusConnection::sessionBus().call(msg, QDBus::Block, 150);
        if (reply.isValid()) portalSettingChanged(ns, key, reply.value());
    };
    ask("org.freedesktop.appearance", "color-scheme");
    ask("org.gnome.desktop.interface", "text-scaling-factor");
}

void Theme::portalSettingChanged(const QString &ns, const QString &key, const QDBusVariant &value)
{
    QVariant v = value.variant();
    if (v.canConvert<QDBusVariant>()) v = v.value<QDBusVariant>().variant();
    if (ns == "org.freedesktop.appearance" && key == "color-scheme") {
        m_portal = v.toInt();
        decide();
    } else if (ns == "org.gnome.desktop.interface" && key == "text-scaling-factor") {
        bool ok = false;
        const double s = v.toDouble(&ok);
        if (ok && s >= 0.5 && s <= 3.0 && s != m_textScale) {
            m_textScale = s;
            emit textScaleChanged();
        }
    }
}
