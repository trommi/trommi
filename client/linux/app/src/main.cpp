// trommi is Trommi as a window: the inbox of decisions and the sessions'
// conversations of a board (server/server.mjs), drawn with Qt Quick.
//
//   trommi [LINK]            open the window; LINK is http://host:port/?t=TOKEN
//   trommi --status [--follow]   one line of JSON for a status bar, no window
//   trommi --demo FILE       show a state from a file, without a server
//   trommi --forget          drop the kept link
#include <QCommandLineParser>
#include <QDir>
#include <QFontDatabase>
#include <QFontInfo>
#include <QGuiApplication>
#include <QJsonDocument>
#include <QLocalServer>
#include <QLocalSocket>
#include <QProcess>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QQuickWindow>
#include <QStandardPaths>
#include <QTimer>

#include "board.h"
#include "secrets.h"
#include "theme.h"

#include <cstdio>

static const char *version = "0.1.0";

// One line per state for a bar: {"text":"3","tooltip":"…","class":"critical"}.
static int status(QCoreApplication &app, bool follow)
{
    auto print = [](const trommi::State &s, bool online) {
        std::puts(QJsonDocument(trommi::barStatus(s, online)).toJson(QJsonDocument::Compact).constData());
        std::fflush(stdout);
    };
    trommi::ServerLink link;
    if (!trommi::ServerLink::parse(Secrets::load(), &link)) {
        print({}, false);
        return follow ? app.exec() : 1;
    }
    trommi::BoardClient client;
    QObject::connect(&client, &trommi::BoardClient::state, &app, [&](const trommi::State &s) {
        print(s, true);
        if (!follow) app.exit(0);
    });
    QObject::connect(&client, &trommi::BoardClient::loginFailed, &app, [&] {
        print({}, false);
        if (!follow) app.exit(1);
    });
    QObject::connect(&client, &trommi::BoardClient::onlineChanged, &app, [&](bool online) {
        if (!online && follow) print({}, false);
    });
    if (!follow)
        QTimer::singleShot(5000, &app, [&] {
            print({}, false);
            app.exit(1);
        });
    client.start(link, follow);
    return app.exec();
}

static QString runtimeDir()
{
    QString dir = qEnvironmentVariable("XDG_RUNTIME_DIR");
    if (dir.isEmpty()) { // not the shared /tmp, where another user could hold it
        dir = QStandardPaths::writableLocation(QStandardPaths::GenericCacheLocation) + "/trommi";
        QDir().mkpath(dir);
    }
    return dir;
}

int main(int argc, char *argv[])
{
    // --status needs no display: decided before a GUI application exists.
    QStringList raw;
    for (int i = 1; i < argc; i++) raw.append(QString::fromLocal8Bit(argv[i]));
    if (raw.contains("--status")) {
        QCoreApplication app(argc, argv);
        return status(app, raw.contains("--follow"));
    }

    QGuiApplication app(argc, argv);
    app.setApplicationName("trommi");
    app.setOrganizationName("trommi");
    app.setApplicationVersion(version);
    // The Wayland app id, for Hyprland's rules; inside a Flatpak it is the
    // Flatpak's own (com.trommi.Trommi), or the desktop cannot tell whose
    // windows and notifications these are.
    app.setDesktopFileName(qEnvironmentVariable("FLATPAK_ID", "trommi"));

    QCommandLineParser args;
    args.setApplicationDescription("Trommi: the questions and conversations of your agents.");
    args.addHelpOption();
    args.addVersionOption();
    args.addPositionalArgument("link", "The link of the board: http://host:port/?t=TOKEN");
    args.addOption({"demo", "Show a state from a file, without a server.", "file"});
    args.addOption({"forget", "Forget the link that was kept."});
    args.addOption({"status", "One line of JSON for a status bar (waybar), no window."});
    args.addOption({"follow", "With --status: a new line on every change."});
    args.process(app);
    const QString given = args.positionalArguments().value(0);
    const QString shot = qEnvironmentVariable("TROMMI_SHOT");
    const bool apart = !shot.isEmpty() || args.isSet("demo"); // tests and demos stand alone

    if (args.isSet("forget")) {
        Secrets::clear();
        return 0;
    }

    // One window: a second start hands its link to the first and brings it
    // to the front (the lock and hyprctl follow brumm's gui/src/main.cpp;
    // the socket is there for the link).
    const QString socket = runtimeDir() + "/trommi.sock";
    QLocalServer server;
    if (!apart) {
        QLocalSocket other;
        other.connectToServer(socket);
        if (other.waitForConnected(200)) {
            other.write(given.toUtf8() + '\n');
            other.waitForBytesWritten(500);
            other.disconnectFromServer();
            // Hyprland's Lua config, else its older syntax.
            if (!QStandardPaths::findExecutable("hyprctl").isEmpty())
                if (QProcess::execute("hyprctl", {"dispatch", "hl.dsp.focus({ window = \"class:^trommi$\" })"}) != 0)
                    QProcess::execute("hyprctl", {"dispatch", "focuswindow", "class:^trommi$"});
            return 0;
        }
        QLocalServer::removeServer(socket); // left behind by a crash
        server.setSocketOptions(QLocalServer::UserAccessOption);
        server.listen(socket);
    }

    // Text in the desktop's sans-serif, code in its monospace (as brumm).
    QString sans = QFontInfo(QFont("sans-serif")).family();
    for (const char *f : {"IBM Plex Sans", "Adwaita Sans", "Inter", "Cantarell"}) // the web's own face first
        if (QFontDatabase::hasFamily(f)) {
            sans = f;
            break;
        }
    const QString mono = QFontInfo(QFont("monospace")).family();

    Theme theme;
    Board board;

    QQmlApplicationEngine engine;
    auto *ctx = engine.rootContext();
    ctx->setContextProperty("theme", &theme);
    ctx->setContextProperty("board", &board);
    ctx->setContextProperty("sansFont", sans);
    ctx->setContextProperty("monoFont", mono);
    ctx->setContextProperty("appVersion", QString(version));
    // For tests: keys to press once the window is up, separated by spaces.
    ctx->setContextProperty("testKeys", qEnvironmentVariable("TROMMI_KEYS"));
    ctx->setContextProperty("testKeysMs", qEnvironmentVariableIntValue("TROMMI_KEYS_MS") ?: 600);
    const QStringList size = qEnvironmentVariable("TROMMI_SIZE").split('x');
    ctx->setContextProperty("testSize", size.size() == 2 ? QSize(size[0].toInt(), size[1].toInt()) : QSize(0, 0));
    QObject::connect(&engine, &QQmlApplicationEngine::warnings, [](const QList<QQmlError> &ws) {
        for (const auto &w : ws) qWarning().noquote() << w.toString();
    });
    QObject::connect(&engine, &QQmlApplicationEngine::objectCreationFailed, &app, [] { QCoreApplication::exit(1); }, Qt::QueuedConnection);
    engine.load(QUrl("qrc:/qml/Main.qml"));
    auto *window = qobject_cast<QQuickWindow *>(engine.rootObjects().value(0));

    QObject::connect(&server, &QLocalServer::newConnection, &app, [&] {
        while (QLocalSocket *s = server.nextPendingConnection()) {
            QObject::connect(s, &QLocalSocket::readyRead, &app, [&board, s] {
                const QString link = QString::fromUtf8(s->readAll()).trimmed();
                if (!link.isEmpty()) board.connectTo(link);
            });
            QObject::connect(s, &QLocalSocket::disconnected, s, &QObject::deleteLater);
            if (window) {
                window->show();
                window->raise();
                window->requestActivate();
            }
        }
    });

    if (args.isSet("demo")) {
        if (!board.startDemo(args.value("demo"))) {
            std::fprintf(stderr, "trommi: %s is not a state\n", qPrintable(args.value("demo")));
            return 1;
        }
    } else if (!given.isEmpty()) {
        board.connectTo(given);
    } else {
        board.startFromKept();
    }

    // For tests and screenshots (as brumm's BRUMM_GUI_SHOT): TROMMI_SHOT=file.png
    // saves the window a moment after it opens, then quits.
    if (!shot.isEmpty()) {
        QTimer::singleShot(qEnvironmentVariableIntValue("TROMMI_SHOT_MS") ?: 1500, &app, [window, shot] {
            const bool ok = window && window->grabWindow().save(shot);
            QCoreApplication::exit(ok ? 0 : 2);
        });
    }
    return app.exec();
}
